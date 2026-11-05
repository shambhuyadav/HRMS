// F2 "Failed integration runs" (FR-088; FR-097; BR-045) and the Sync Monitor's lists: the biometric sync runs, scheduled and
// manual, shared by GET /biometric/runs and the System Administrator's dashboard widget, and the observations a run
// quarantined or rejected. A run belongs to no employee, so these are for an unrestricted company-scope assignment only.
// Run identity, window, state, counts and normalised source evidence; never the profile's secrets.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';

export const RUNS_FROM = `from biometric_sync_run r join company c on c.id = r.company_id`;

/** A list answered without page/pageSize: at most this many, newest first. */
const LIST_CAP = 200;

export interface RunFilters {
  /** Only runs that ended FAILED or PARTIAL. */
  failed?: boolean | undefined;
  /** Company-local dates the run started on, inclusive. */
  from?: string | undefined;
  to?: string | undefined;
  profileId?: string | undefined;
  state?: string | undefined;
}

/** The runs' condition over RUNS_FROM. */
export function runCondition(g: AccessGrant, p: SqlParams, f: RunFilters): string {
  const where = [`r.company_id = ${p.add(g.companyId)}::uuid`];
  if (f.failed) where.push(`r.state in ('FAILED', 'PARTIAL')`);
  if (f.from) where.push(`r.started_at >= (${p.add(f.from)}::date)::timestamp at time zone c.business_timezone`);
  if (f.to) where.push(`r.started_at < (${p.add(f.to)}::date + 1)::timestamp at time zone c.business_timezone`);
  if (f.profileId) where.push(`r.profile_id = ${p.add(f.profileId)}::uuid`);
  if (f.state) where.push(`r.state = ${p.add(f.state)}`);
  return where.join(' and ');
}

/** Newest first: one page (FR-056), or at most 200 without page/pageSize; `total` counts every match. */
export async function listRuns(db: Queryable, g: AccessGrant, f: RunFilters & Paging) {
  const p = new SqlParams();
  return pageOf(
    db,
    `select r.id, r.profile_id as "profileId", pr.code as "profileCode", m.revision as "mappingRevision", r.state, r.failure_code as "failureCode", r.window_start as "windowStart", r.window_end as "windowEnd",
            r.started_at as "startedAt", r.finished_at as "finishedAt", r.updated_at as "lastCommitAt", r.pages_committed as "pagesCommitted", r.committed_checkpoint_reference as "committedCheckpoint",
            r.source_observation_count as observations, r.accepted_count as accepted, r.duplicate_count as duplicates, r.rejected_count as rejected, r.quarantined_count as quarantined
       ${RUNS_FROM}
       join biometric_profile pr on pr.company_id = r.company_id and pr.id = r.profile_id
       join biometric_mapping_revision m on m.company_id = r.company_id and m.id = r.mapping_revision_id
      where ${runCondition(g, p, f)}`,
    p.values,
    '"startedAt" desc, id',
    f,
    LIST_CAP,
  );
}

export interface ExceptionFilters {
  profileId?: string | undefined;
  runId?: string | undefined;
  outcome?: 'REJECTED' | 'QUARANTINED' | undefined;
  failureCode?: string | undefined;
  /** Leaves out what a reprocess or correction has since accepted. */
  open?: boolean | undefined;
}

/** What can still be done about an observation, for a screen to offer; the route decides again. */
const NEXT_STEP = `case when e.state = 'QUARANTINED' and e.failure_code = 'UNKNOWN_EMPLOYEE' then 'REPROCESS'
                         when e.state = 'QUARANTINED' and e.failure_code = 'AMBIGUOUS_LOCAL_TIME' then 'CORRECT_TIME'
                         when e.state = 'ACCEPTED' and o.failure_code in ('UNKNOWN_EMPLOYEE', 'AMBIGUOUS_LOCAL_TIME') then 'RESOLVED'
                         else 'NONE' end`;

/**
 * FR-087 "explicit rejected/quarantined records", newest first: one page, or at most 200 without page/pageSize. An observation
 * stays as received; a CONFLICTING_PAYLOAD row also shows what the canonical event kept (BR-036 "never overwritten"), and a
 * rejected record failed mapping, so it has no event and no evidence.
 */
export async function listExceptions(db: Queryable, g: AccessGrant, f: ExceptionFilters & Paging) {
  const p = new SqlParams();
  const where = [`o.company_id = ${p.add(g.companyId)}::uuid`, `o.outcome in ('REJECTED', 'QUARANTINED')`];
  if (f.profileId) where.push(`r.profile_id = ${p.add(f.profileId)}::uuid`);
  if (f.runId) where.push(`o.run_id = ${p.add(f.runId)}::uuid`);
  if (f.outcome) where.push(`o.outcome = ${p.add(f.outcome)}`);
  if (f.failureCode) where.push(`o.failure_code = ${p.add(f.failureCode)}`);
  if (f.open) where.push(`(${NEXT_STEP}) <> 'RESOLVED'`);
  return pageOf(
    db,
    `select o.id, o.run_id as "runId", pr.code as "profileCode", o.observation_index as "observationIndex", o.outcome, o.failure_code as "failureCode",
            o.source_event_key as "sourceEventKey", o.source_evidence as evidence, o.created_at as "observedAt", o.ingest_event_id as "eventId", ${NEXT_STEP} as "nextStep",
            case when e.state = 'ACCEPTED' and o.failure_code = 'CONFLICTING_PAYLOAD'
                 then json_build_object('employeeKey', e.external_employee_key, 'instant', e.normalised_time, 'direction', e.direction) end as kept
       from biometric_run_observation o
       join biometric_sync_run r on r.company_id = o.company_id and r.id = o.run_id
       join biometric_profile pr on pr.company_id = r.company_id and pr.id = r.profile_id
       left join biometric_ingest_event e on e.company_id = o.company_id and e.id = o.ingest_event_id
      where ${where.join(' and ')}`,
    p.values,
    '"observedAt" desc, id',
    f,
    LIST_CAP,
  );
}
