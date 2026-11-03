// Biometric fetch runs, normalisation, replay control, quarantine and reprocessing
// (FR-087, FR-088; BR-036, BR-037; DF09; DF13; CI19; ZT24).
//
// One RUNNING run per profile (unique index). Pages are processed one transaction each: every observation is
// recorded, the canonical event is created or matched, counters and the committed checkpoint advance together.
// A fetch failure leaves the run PARTIAL/FAILED with the checkpoint at the last fully committed page; a retry
// re-fetches and duplicates collapse onto existing canonical events, so no punch is ever created twice.
// A run started by a request lives under that request's deadline (http/deadline.ts): past it no page commits and no
// retry is waited for, and the run still ends (withoutDeadline) instead of staying RUNNING. Worker runs have no deadline.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import { currentScope, remainingMs, withoutDeadline } from '../../db/budget.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { contentFingerprint, type DedupeStrategy, type FieldMapping, mapRecord, rawFingerprint, type TimestampRule } from './mapping.js';

export interface BiometricProvider {
  fetchPage(request: { profileCode: string; windowStart: Date; windowEnd: Date; cursor: string | null }): Promise<{ records: unknown[]; nextCursor: string | null }>;
}

/** DF09: retry at 1, 5 and 15 minutes, then show failure and retain the checkpoint. */
export const DEFAULT_RETRY_DELAYS_MS = [60_000, 300_000, 900_000];

interface ProfileContext {
  id: string;
  code: string;
  timezone: string;
  mappingRevisionId: string;
  dedupe: DedupeStrategy;
  rule: TimestampRule;
  fields: FieldMapping[];
}

async function loadProfile(db: Queryable, companyId: string, profileId: string): Promise<ProfileContext> {
  const p = (
    await db.query<{ id: string; code: string; provider_timezone: string; active: boolean; mapping_id: string | null; dedupe_strategy: DedupeStrategy; timestamp_rule: TimestampRule }>(
      `select p.id, p.code, p.provider_timezone, p.active, m.id as mapping_id, m.dedupe_strategy, m.timestamp_rule
         from biometric_profile p
         left join biometric_mapping_revision m on m.company_id = p.company_id and m.profile_id = p.id and m.approved_by is not null
              and m.effective_from <= now() and (m.effective_to is null or m.effective_to > now())
        where p.company_id = $1 and p.id = $2`,
      [companyId, profileId],
    )
  ).rows[0];
  if (!p) throw notFound();
  if (!p.active) throw new HttpError(409, 'PROFILE_INACTIVE', 'The profile is not active; disabled profiles start no new runs');
  if (!p.mapping_id) throw new HttpError(422, 'MAPPING_NOT_APPROVED', 'No approved mapping revision is effective');
  return { id: p.id, code: p.code, timezone: p.provider_timezone, mappingRevisionId: p.mapping_id, dedupe: p.dedupe_strategy, rule: p.timestamp_rule, fields: await loadFields(db, companyId, p.mapping_id) };
}

export async function loadFields(db: Queryable, companyId: string, revisionId: string): Promise<FieldMapping[]> {
  return (
    await db.query<FieldMapping>(
      `select source_path as "sourcePath", target_field as "targetField", transform_code as "transformCode", enum_config as "enumConfig",
              required, default_code as "defaultCode"
         from biometric_field_mapping where company_id = $1 and mapping_revision_id = $2`,
      [companyId, revisionId],
    )
  ).rows;
}

/** Local provider time -> one instant; DST gaps and overlaps are ambiguous and quarantined (BR-036). */
export async function resolveInstant(tx: Queryable, instant: { kind: 'ISO' | 'LOCAL'; value: string }, timezone: string): Promise<string | null> {
  if (instant.kind === 'ISO') return instant.value;
  const row = (
    await tx.query<{ at: string | null }>(
      `with t as (select $1::timestamp as local, ($1::timestamp at time zone $2) as at)
       select case when (t.at at time zone $2) <> t.local then null                                  -- inside a DST gap
                   when ((t.at - interval '1 hour') at time zone $2) = t.local then null              -- inside a DST overlap
                   when ((t.at + interval '1 hour') at time zone $2) = t.local then null
                   else to_char(t.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') end as at
         from t`,
      [instant.value, timezone],
    )
  ).rows[0];
  return row?.at ?? null;
}

type Outcome = 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'QUARANTINED';

async function processRecord(tx: Queryable, companyId: string, runId: string, profile: ProfileContext, index: number, record: unknown, actor: string): Promise<Outcome> {
  const observe = async (outcome: Outcome, fingerprint: string, eventId: string | null, key: string | null, failure: string | null) => {
    await tx.query(
      `insert into biometric_run_observation (company_id, run_id, observation_index, ingest_event_id, source_event_key, fingerprint, outcome, failure_code, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
      [companyId, runId, index, eventId, key, fingerprint, outcome, failure, actor],
    );
    return outcome;
  };

  const mapped = mapRecord(record, profile.fields, profile.rule);
  if (!mapped.ok) return observe('REJECTED', rawFingerprint(record), null, null, mapped.code);
  const m = mapped.value;
  const instant = await resolveInstant(tx, m.instant, profile.timezone);
  const fingerprint = contentFingerprint(profile.code, m, instant);
  const key = profile.dedupe === 'PROVIDER_EVENT_KEY' ? m.eventKey : fingerprint;
  if (!key) return observe('QUARANTINED', fingerprint, null, null, 'MISSING_EVENT_KEY');

  const existing = (
    await tx.query<{ id: string; fingerprint: string }>(
      `select id, fingerprint from biometric_ingest_event where company_id = $1 and profile_id = $2 and source_event_key = $3 for update`,
      [companyId, profile.id, key],
    )
  ).rows[0];
  if (existing) {
    if (existing.fingerprint === fingerprint) {
      await tx.query(`update biometric_ingest_event set latest_run_id = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, existing.id, runId, actor]);
      return observe('DUPLICATE', fingerprint, existing.id, key, null);
    }
    // Same key, different content: never overwrite the canonical event (BR-036).
    return observe('QUARANTINED', fingerprint, existing.id, key, 'CONFLICTING_PAYLOAD');
  }

  const insertEvent = async (state: 'ACCEPTED' | 'QUARANTINED', employeeId: string | null, punchId: string | null, failure: string | null) =>
    (
      await tx.query<{ id: string }>(
        `insert into biometric_ingest_event (company_id, profile_id, first_run_id, latest_run_id, mapping_revision_id, source_event_key, fingerprint,
                                             external_employee_key, employee_id, normalised_time, direction, punch_id, state, failure_code, created_by, updated_by)
         values ($1, $2, $3, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) returning id`,
        [companyId, profile.id, runId, profile.mappingRevisionId, key, fingerprint, m.employeeKey, employeeId, instant, m.direction, punchId, state, failure, actor],
      )
    ).rows[0]!.id;

  if (!instant) return observe('QUARANTINED', fingerprint, await insertEvent('QUARANTINED', null, null, 'AMBIGUOUS_LOCAL_TIME'), key, 'AMBIGUOUS_LOCAL_TIME');
  const employeeId = await linkedEmployee(tx, companyId, profile.id, m.employeeKey, instant);
  if (!employeeId) return observe('QUARANTINED', fingerprint, await insertEvent('QUARANTINED', null, null, 'UNKNOWN_EMPLOYEE'), key, 'UNKNOWN_EMPLOYEE');

  const punchId = await createPunch(tx, companyId, profile, employeeId, instant, m.direction, key, actor);
  return observe('ACCEPTED', fingerprint, await insertEvent('ACCEPTED', employeeId, punchId, null), key, null);
}

async function linkedEmployee(tx: Queryable, companyId: string, profileId: string, externalKey: string, instant: string): Promise<string | null> {
  const row = (
    await tx.query<{ employee_id: string }>(
      `select employee_id from biometric_employee_link where company_id = $1 and profile_id = $2 and external_employee_key = $3
          and effective_from <= $4::timestamptz and (effective_to is null or effective_to > $4::timestamptz)`,
      [companyId, profileId, externalKey, instant],
    )
  ).rows[0];
  return row?.employee_id ?? null;
}

async function createPunch(tx: Queryable, companyId: string, profile: ProfileContext, employeeId: string, instant: string, direction: string, key: string, actor: string) {
  return (
    await tx.query<{ id: string }>(
      // FR-019: a punch already stored under another key is flagged as repeated (0114); how it pairs needs FR-020's approval.
      `insert into attendance_punch (company_id, employee_id, occurred_at, direction, source_kind, external_event_key, biometric_profile_id, source_identity_key, repeat_of_punch_id, created_by, updated_by)
       values ($1, $2, $3::timestamptz, $4, 'BIOMETRIC_API', $5, $6, $7, hrms_punch_repeat_of($1, $2, $3::timestamptz, $4), $8, $8) returning id`,
      [companyId, employeeId, instant, direction, key, profile.id, `biometric:${profile.code}`, actor],
    )
  ).rows[0]!.id;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSync(
  db: Database,
  input: { companyId: string; profileId: string; actorUserId: string; windowStart: Date; windowEnd: Date },
  provider: BiometricProvider,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
) {
  const profile = await loadProfile(db, input.companyId, input.profileId);
  const runId = await withTransaction(db, async (tx) => {
    try {
      return (
        await tx.query<{ id: string }>(
          `insert into biometric_sync_run (company_id, profile_id, mapping_revision_id, window_start, window_end, state, created_by, updated_by)
           values ($1, $2, $3, $4, $5, 'RUNNING', $6, $6) returning id`,
          [input.companyId, profile.id, profile.mappingRevisionId, input.windowStart, input.windowEnd, input.actorUserId],
        )
      ).rows[0]!.id;
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new HttpError(409, 'RUN_IN_PROGRESS', 'A run for this profile is already in progress');
      throw err;
    }
  });

  let cursor: string | null = null;
  let observations = 0;
  for (;;) {
    let page: { records: unknown[]; nextCursor: string | null } | null = null;
    for (let attempt = 0; attempt <= retryDelaysMs.length && !page; attempt++) {
      try {
        page = await provider.fetchPage({ profileCode: profile.code, windowStart: input.windowStart, windowEnd: input.windowEnd, cursor });
      } catch {
        const delay = retryDelaysMs[attempt];
        if (delay === undefined) continue;
        // A retry that could only start past the request's deadline could not commit anything: fail the fetch now.
        const scope = currentScope();
        if (scope && remainingMs(scope) <= delay) break;
        await sleep(delay);
      }
    }
    if (!page) return finishRun(db, input, runId, 'FETCH_FAILED');
    const fetched = page;

    const pageStart = observations;
    try {
      await withTransaction(db, async (tx) => {
      const counts: Record<Outcome, number> = { ACCEPTED: 0, DUPLICATE: 0, REJECTED: 0, QUARANTINED: 0 };
      for (const record of fetched.records) {
        counts[await processRecord(tx, input.companyId, runId, profile, ++observations, record, input.actorUserId)]++;
      }
      // Counters and checkpoint advance in the same transaction as the page's effects (BR-037).
      await tx.query(
        `update biometric_sync_run set source_observation_count = source_observation_count + $3, accepted_count = accepted_count + $4,
                duplicate_count = duplicate_count + $5, rejected_count = rejected_count + $6, quarantined_count = quarantined_count + $7,
                committed_checkpoint_reference = $8, pages_committed = pages_committed + 1, updated_by = $9
          where company_id = $1 and id = $2 and state = 'RUNNING'`,
        [input.companyId, runId, fetched.records.length, counts.ACCEPTED, counts.DUPLICATE, counts.REJECTED, counts.QUARANTINED, fetched.nextCursor, input.actorUserId],
      );
      });
    } catch {
      // The page rolled back as a whole; the run ends with the checkpoint at the last committed page and
      // never stays RUNNING (which would block every later run of the profile).
      observations = pageStart;
      return finishRun(db, input, runId, 'PROCESSING_FAILED');
    }
    if (!fetched.nextCursor) break;
    cursor = fetched.nextCursor;
  }
  return finishRun(db, input, runId, null);
}

async function finishRun(db: Database, input: { companyId: string; profileId: string; actorUserId: string; windowEnd: Date }, runId: string, failure: string | null) {
  // Past the request's deadline too: a run left RUNNING would block every later run of the profile.
  return withoutDeadline(() => withTransaction(db, async (tx) => {
    const run = (
      await tx.query<{ pages_committed: number }>(`select pages_committed from biometric_sync_run where company_id = $1 and id = $2 for update`, [input.companyId, runId])
    ).rows[0]!;
    const state = failure ? (run.pages_committed > 0 ? 'PARTIAL' : 'FAILED') : 'COMPLETED';
    await tx.query(`update biometric_sync_run set state = $3, failure_code = $4, finished_at = now(), updated_by = $5 where company_id = $1 and id = $2`, [
      input.companyId,
      runId,
      state,
      failure,
      input.actorUserId,
    ]);
    if (state === 'COMPLETED') {
      await tx.query(`update biometric_profile set synced_until = greatest(coalesce(synced_until, $3), $3), updated_by = $4 where company_id = $1 and id = $2`, [
        input.companyId,
        input.profileId,
        input.windowEnd,
        input.actorUserId,
      ]);
    } else {
      // DF09: show failure to configured support recipients (outbox; no provider details in the payload).
      await enqueueEvent(tx, { companyId: input.companyId, topic: 'biometric.sync_failed', aggregateId: runId, dedupeKey: `biometric.sync_failed:${runId}`, payload: { runId, state } });
    }
    return getRun(tx, input.companyId, runId);
  }));
}

export async function getRun(db: Queryable, companyId: string, runId: string) {
  const row = (
    await db.query(
      `select id, state, failure_code as "failureCode", window_start as "windowStart", window_end as "windowEnd", pages_committed as "pagesCommitted",
              committed_checkpoint_reference as "committedCheckpoint", source_observation_count as observations, accepted_count as accepted,
              duplicate_count as duplicates, rejected_count as rejected, quarantined_count as quarantined
         from biometric_sync_run where company_id = $1 and id = $2`,
      [companyId, runId],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

/** FR-087 correction and reprocessing: an UNKNOWN_EMPLOYEE event is accepted once a valid link exists; history kept. */
export async function reprocessEvent(tx: Queryable, companyId: string, eventId: string, actorUserId: string, actingAssignmentId: string) {
  const e = (
    await tx.query<{ id: string; profile_id: string; code: string; external_employee_key: string; normalised_time: string | null; direction: string; source_event_key: string; state: string; failure_code: string | null }>(
      `select e.id, e.profile_id, p.code, e.external_employee_key, to_char(e.normalised_time at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as normalised_time,
              e.direction, e.source_event_key, e.state, e.failure_code
         from biometric_ingest_event e join biometric_profile p on p.company_id = e.company_id and p.id = e.profile_id
        where e.company_id = $1 and e.id = $2 for update of e`,
      [companyId, eventId],
    )
  ).rows[0];
  if (!e) throw notFound();
  if (e.state !== 'QUARANTINED' || e.failure_code !== 'UNKNOWN_EMPLOYEE' || !e.normalised_time) {
    throw new HttpError(409, 'NOT_REPROCESSABLE', 'Only unknown-employee quarantined events can be reprocessed automatically');
  }
  const employeeId = await linkedEmployee(tx, companyId, e.profile_id, e.external_employee_key, e.normalised_time);
  if (!employeeId) throw new HttpError(422, 'STILL_UNMATCHED', 'No effective employee link exists for this identity at the punch time');
  const punchId = await createPunch(tx, companyId, { id: e.profile_id, code: e.code } as ProfileContext, employeeId, e.normalised_time, e.direction, e.source_event_key, actorUserId);
  await tx.query(`update biometric_ingest_event set state = 'ACCEPTED', employee_id = $3, punch_id = $4, failure_code = null, updated_by = $5 where company_id = $1 and id = $2`, [
    companyId,
    e.id,
    employeeId,
    punchId,
    actorUserId,
  ]);
  await writeAudit(tx, {
    companyId,
    resource: 'biometric_ingest_event',
    recordKey: e.id,
    actorUserId,
    actingAssignmentId,
    action: 'REPROCESS',
    before: { operational: { state: 'QUARANTINED', failureCode: e.failure_code } },
    after: { operational: { state: 'ACCEPTED', punchId } },
  });
  return { eventId: e.id, state: 'ACCEPTED', punchId };
}
