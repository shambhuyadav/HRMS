// Bulk jobs (NFR-S09; ADR-15; docs/09 §7.2). A company-wide loop never runs on an interactive request: the request
// validates and authorises as before, records a QUEUED job and answers 202; the worker runs the job in bounded chunks,
// one transaction each. Every chunk re-resolves the requester's authority (the stored user, company, assignment and
// permission); a requester who lost it ends the job FAILED with ACCESS_REVOKED and nothing more runs. The cursor, the
// running counts and the chunk's effects commit together, so a crash or a retry resumes after the last committed chunk
// without double effects. A failing chunk rolls back only itself and is retried after 1, 5 and 15 minutes, then the
// job is FAILED with an error class (ADR-13 cadence). Jobs and their status belong to their requester.
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessDecision, type AccessGrant, resolveAccess } from '../access/authorize.js';
import { BULK_KINDS, type BulkJobKind, type BulkKind } from './kinds.js';
import { failureCode, RETRY_MINUTES, UnitFailure } from './retry.js';

/**
 * Units (employees) per chunk transaction: a technical bound on transaction length and lock time, not a business rule.
 * A starting value, to be measured per G4 (docs/09 §7.4); tests lower it through `runBulkJobs` options.
 */
export const BULK_CHUNK_SIZE = 100;

type JobState = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';

interface JobRow {
  id: string;
  company_id: string;
  kind: BulkJobKind;
  parameters: Record<string, unknown>;
  requested_by: string;
  acting_assignment_id: string;
  permission_resource: string;
  permission_action: string;
  permission_field_groups: string[];
  state: JobState;
  chunk_cursor: string | null;
  processed_count: number;
  result: Record<string, unknown>;
  error_code: string | null;
  attempts: number;
  next_attempt_at: Date | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

const JOB_COLUMNS = `id, company_id, kind, parameters, requested_by, acting_assignment_id, permission_resource, permission_action,
  permission_field_groups, state, chunk_cursor, processed_count, result, error_code, attempts, next_attempt_at, created_at,
  started_at, finished_at`;

/** The grant still covers the job: the permission with every field group, and the kind's own rule. */
function holds(decision: AccessDecision, fieldGroups: readonly string[], kind: BulkKind): decision is AccessGrant {
  return decision.allowed && fieldGroups.every((g) => decision.allowedFieldGroups.includes(g)) && (!kind.authorised || kind.authorised(decision));
}

/** The kind's extra authority rule at enqueue (e.g. company scope), with the same answer as the synchronous route. */
export function assertKindAuthorised(kind: BulkJobKind, grant: AccessGrant): void {
  const rule = BULK_KINDS[kind].authorised;
  if (rule && !rule(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

/**
 * Records a QUEUED job under the caller's grant, which the route resolved for the kind's permission. With an
 * idempotency key, the same requester (user and acting assignment) asking again with the same parameters gets the same
 * job; the key used by anyone else or for anything else is refused without revealing that job.
 */
export async function enqueueBulkJob(
  tx: Queryable,
  grant: AccessGrant,
  kind: BulkJobKind,
  parameters: Record<string, unknown>,
  idempotencyKey?: string,
): Promise<{ jobId: string; state: JobState }> {
  assertKindAuthorised(kind, grant);
  const def = BULK_KINDS[kind];
  const { resource, action, fieldGroups } = def.permission;
  const inserted = (
    await tx.query<{ id: string; state: JobState }>(
      `insert into bulk_job (company_id, kind, parameters, requested_by, acting_assignment_id, permission_resource, permission_action,
                             permission_field_groups, idempotency_key, result, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $4, $4)
       on conflict (company_id, idempotency_key) do nothing returning id, state`,
      [grant.companyId, kind, parameters, grant.userId, grant.assignmentId, resource, action, fieldGroups, idempotencyKey ?? null, def.initialResult(parameters)],
    )
  ).rows[0];
  if (inserted) return { jobId: inserted.id, state: inserted.state };
  const prior = (
    await tx.query<{ id: string; state: JobState; same: boolean }>(
      `select id, state, (kind = $3 and parameters = $4::jsonb and requested_by = $5 and acting_assignment_id = $6) as same
         from bulk_job where company_id = $1 and idempotency_key = $2`,
      [grant.companyId, idempotencyKey, kind, parameters, grant.userId, grant.assignmentId],
    )
  ).rows[0];
  if (!prior?.same) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for another job');
  return { jobId: prior.id, state: prior.state };
}

/** One chunk of one claimed job, inside the claiming transaction. */
async function runChunk(tx: Queryable, job: JobRow, size: number): Promise<void> {
  const def = BULK_KINDS[job.kind];
  // The chunk's effects are undone alone on failure; the failure itself is recorded in the same transaction.
  await tx.query('savepoint bulk_chunk');
  try {
    // Ordered against grant changes: access/admin.ts locks the assignment for update when it approves or revokes.
    await tx.query(`select 1 from role_assignment where company_id = $1 and id = $2 for share`, [job.company_id, job.acting_assignment_id]);
    const decision = await resolveAccess(tx, {
      userId: job.requested_by,
      companyId: job.company_id,
      assignmentId: job.acting_assignment_id,
      resource: job.permission_resource,
      action: job.permission_action,
      fieldGroups: job.permission_field_groups,
    });
    if (!holds(decision, job.permission_field_groups, def)) {
      // Nothing of this chunk runs, and no later chunk: the job ends here.
      await tx.query(
        `update bulk_job set state = 'FAILED', error_code = 'ACCESS_REVOKED', next_attempt_at = null,
                started_at = coalesce(started_at, now()), finished_at = now()
          where id = $1`,
        [job.id],
      );
    } else {
      const out = await def.runChunk(tx, decision, job.parameters, job.result, job.chunk_cursor, size, job.id);
      if (out.done) await def.complete(tx, decision, job.parameters, out.result, job.id);
      // The cursor and running counts commit with the chunk's effects (resume without double effects).
      await tx.query(
        `update bulk_job set state = $2::text, chunk_cursor = $3, processed_count = processed_count + $4, result = $5,
                attempts = 0, error_code = null, next_attempt_at = null,
                started_at = coalesce(started_at, now()), finished_at = case when $2::text = 'COMPLETED' then now() end
          where id = $1`,
        [job.id, out.done ? 'COMPLETED' : 'RUNNING', out.cursor, out.processed, out.result],
      );
    }
    await tx.query('release savepoint bulk_chunk');
  } catch (err) {
    await tx.query('rollback to savepoint bulk_chunk');
    const attempt = job.attempts + 1;
    const delay = RETRY_MINUTES[attempt - 1] ?? null;
    const errorCode = failureCode(err);
    await tx.query(
      `update bulk_job set state = case when $3::int is null then 'FAILED' else 'RUNNING' end, attempts = $2, error_code = $4,
              next_attempt_at = case when $3::int is null then null else now() + make_interval(mins => $3::int) end,
              started_at = coalesce(started_at, now()), finished_at = case when $3::int is null then now() end
        where id = $1`,
      [job.id, attempt, delay, errorCode],
    );
    if (err instanceof UnitFailure && def.recordFailure) {
      // Naming the unit never costs the job its failure record above.
      await tx.query('savepoint bulk_failure');
      try {
        await def.recordFailure(tx, { companyId: job.company_id, jobId: job.id, requestedBy: job.requested_by }, err.unit, errorCode);
        await tx.query('release savepoint bulk_failure');
      } catch {
        await tx.query('rollback to savepoint bulk_failure');
      }
    }
  }
}

export interface BulkRunOptions {
  /** Units per chunk (default BULK_CHUNK_SIZE). */
  chunkSize?: number;
}

/**
 * Worker: runs up to `limit` chunks of ready jobs, one transaction each. A job is claimed with `for update skip locked`
 * (one worker per job at a time), least recently advanced first, so concurrent jobs take turns. Returns the number of
 * chunks run (including failed and refused ones).
 */
export async function runBulkJobs(db: Database, limit = 20, options: BulkRunOptions = {}): Promise<number> {
  const size = options.chunkSize ?? BULK_CHUNK_SIZE;
  if (!Number.isInteger(size) || size < 1) throw new Error('The chunk size must be a positive integer');
  let chunks = 0;
  for (let i = 0; i < limit; i++) {
    const ran = await withTransaction(db, async (tx) => {
      const job = (
        await tx.query<JobRow>(
          `select ${JOB_COLUMNS} from bulk_job
            where state in ('QUEUED', 'RUNNING') and (next_attempt_at is null or next_attempt_at <= now())
            order by updated_at, id limit 1 for update skip locked`,
        )
      ).rows[0];
      if (!job) return false;
      await runChunk(tx, job, size);
      return true;
    });
    if (!ran) break;
    chunks++;
  }
  return chunks;
}

export interface BulkActor {
  userId: string;
  companyId: string;
  assignmentId: string | null;
}

/** What the requester sees: state, progress, operational result, error class and timestamps. */
export function jobView(r: JobRow) {
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    parameters: r.parameters,
    processed: r.processed_count,
    result: r.result,
    errorCode: r.error_code,
    attempts: r.attempts,
    nextAttemptAt: r.next_attempt_at,
    createdAt: r.created_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}

/** The caller's own job, enqueued under the caller's current assignment; anyone else sees nothing. */
export async function loadOwnJob(db: Queryable, actor: BulkActor, id: string): Promise<JobRow> {
  const row = (await db.query<JobRow>(`select ${JOB_COLUMNS} from bulk_job where company_id = $1 and id = $2`, [actor.companyId, id])).rows[0];
  if (!row || row.requested_by !== actor.userId || row.acting_assignment_id !== actor.assignmentId) throw notFound();
  return row;
}

/** The kind's extra rule on a status read under the re-resolved grant. */
export const kindStillAuthorised = (kind: BulkJobKind, grant: AccessGrant) => BULK_KINDS[kind].authorised?.(grant) ?? true;

/**
 * The caller's own jobs under the current assignment, newest first, each shown only while the caller still holds the
 * permission it was enqueued under (resolved once per distinct permission).
 */
export async function listOwnJobs(db: Queryable, actor: BulkActor, kind: BulkJobKind | undefined, limit: number) {
  if (!actor.assignmentId) return { items: [] };
  const rows = (
    await db.query<JobRow>(
      `select ${JOB_COLUMNS} from bulk_job
        where company_id = $1 and requested_by = $2 and acting_assignment_id = $3 and ($4::text is null or kind = $4)
        order by created_at desc, id desc limit $5::int`,
      [actor.companyId, actor.userId, actor.assignmentId, kind ?? null, limit],
    )
  ).rows;
  const verdicts = new Map<string, boolean>();
  const items = [];
  for (const r of rows) {
    const key = JSON.stringify([r.kind, r.permission_resource, r.permission_action, r.permission_field_groups]);
    let ok = verdicts.get(key);
    if (ok === undefined) {
      const decision = await resolveAccess(db, {
        userId: actor.userId,
        companyId: actor.companyId,
        assignmentId: actor.assignmentId,
        resource: r.permission_resource,
        action: r.permission_action,
        fieldGroups: r.permission_field_groups,
      });
      ok = holds(decision, r.permission_field_groups, BULK_KINDS[r.kind]);
      verdicts.set(key, ok);
    }
    if (ok) items.push(jobView(r));
  }
  return { items };
}
