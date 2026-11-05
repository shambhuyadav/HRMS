// Import job lifecycle shared by every batch import (DF09; DB083/DB084; C4). A job belongs to its submitter:
// only the submitting user can see, commit or cancel it, and idempotency keys are looked up per submitter, so a
// colliding key never reveals another user's batch. Jobs are all-or-nothing (see batch.ts), except an import whose spec
// declares `partial` (DF09 attendance): its failing rows stay out on their own and the rest are applied.
// An import file is a user upload (FR-106, I-21): it is stored as PENDING_SCAN and scanned before any row is read. A
// finding refuses the import; while the scanner is unavailable the job is held (UPLOADED) with nothing read; only a
// file the scanner released as CLEAN is ever previewed or committed.
import { createHash } from 'node:crypto';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import type { FileStore } from '../../storage/files.js';
import { type ScanProvider, scanAttachment } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';
import { applyBatch, MAX_BATCH_BYTES, previewBatch, type RowChanges, rowErrorCode, type RowOutcome, storedRowCode, type Template, type TemplateRow } from './batch.js';
import type pg from 'pg';

/** The job row a partial commit is applying (a preview has no job yet, so it passes none). */
export interface RowContext {
  jobId: string;
  rowNumber: number;
}

export interface BatchSpec<C extends string> {
  kind: string;
  template: Template<C>;
  parse(bytes: Buffer): TemplateRow<C>[];
  /** Applies one row; an update import returns what the row changes (shown in the preview). */
  apply(client: pg.PoolClient, grant: AccessGrant, row: Record<C, string>, at?: RowContext): Promise<RowChanges | void>;
  keyOf(row: Record<C, string>, rowNumber: number): string;
  /**
   * DF09 "attendance imports may accept valid independent events while quarantining invalid events": a failing row no
   * longer rejects the batch. It is QUARANTINED on its own, in the preview and at commit, and commit applies the rows the
   * preview found valid, each whole or not at all. `settledCodes` are failures that are not invalid data (a repeat of
   * something already stored): nothing needs review, so they are recorded REJECTED with their code.
   */
  partial?: { settledCodes: readonly string[] };
  /** Runs first in the commit's transaction, after the job lock: re-checks authority and takes the import's own locks. */
  prepareCommit?(client: pg.PoolClient, grant: AccessGrant): Promise<void>;
}

type JobView = NonNullable<Awaited<ReturnType<typeof jobView>>>;
/** `status` is the HTTP status for the upload: 201 new job, 200 the same job again, 202 held for the malware scan. */
export interface Submitted {
  created: boolean;
  status: 200 | 201 | 202;
  view: JobView;
}

export async function jobView(db: Queryable, grant: AccessGrant, kind: string, id: string) {
  const job = (
    await db.query<Record<string, unknown>>(
      `select j.id, j.state, j.template_code as "template", j.file_name as "fileName", j.row_count as "rowCount", j.accepted_count as "acceptedCount",
              j.rejected_count as "rejectedCount", a.scan_state as "scanState", j.created_at as "createdAt"
         from import_job j join attachment a on a.company_id = j.company_id and a.id = j.attachment_id
        where j.company_id = $1 and j.id = $2 and j.kind = $3 and j.submitted_by = $4`,
      [grant.companyId, id, kind, grant.userId],
    )
  ).rows[0];
  if (!job) return null;
  const rows = await db.query(
    `select row_number as "rowNumber", business_key as "businessKey", state, error_code as "errorCode", proposed_changes as "proposedChanges"
       from import_row where company_id = $1 and job_id = $2 order by row_number`,
    [grant.companyId, id],
  );
  return { ...job, rows: rows.rows };
}

/** The states a job of this framework takes (VALIDATED and COMMITTING exist in the schema but are never used). */
export const IMPORT_JOB_STATES = ['UPLOADED', 'PREVIEWED', 'COMMITTED', 'REJECTED', 'CANCELLED'] as const;

export interface JobListQuery {
  state?: (typeof IMPORT_JOB_STATES)[number] | undefined;
  page: number;
  pageSize: number;
}

/**
 * The submitter's own jobs of one kind, newest first, one page at a time; anyone else's are never listed. Operational
 * fields only: the job facts and its file's scan state, never its rows (see jobView for one job with its rows).
 */
export async function listJobs(db: Queryable, grant: AccessGrant, kind: string, q: JobListQuery) {
  const filter = `j.company_id = $1 and j.kind = $2 and j.submitted_by = $3 and ($4::text is null or j.state = $4)`;
  const params = [grant.companyId, kind, grant.userId, q.state ?? null];
  const total = Number((await db.query<{ n: string }>(`select count(*) as n from import_job j where ${filter}`, params)).rows[0]?.n ?? 0);
  const rows = await db.query(
    `select j.id, j.state, j.template_code as "template", j.file_name as "fileName", j.row_count as "rowCount", j.accepted_count as "acceptedCount",
            j.rejected_count as "rejectedCount", a.scan_state as "scanState", j.created_at as "createdAt", j.updated_at as "updatedAt"
       from import_job j join attachment a on a.company_id = j.company_id and a.id = j.attachment_id
      where ${filter} order by j.created_at desc, j.id desc limit $5 offset $6`,
    [...params, q.pageSize, (q.page - 1) * q.pageSize],
  );
  return { items: rows.rows, total, page: q.page, pageSize: q.pageSize };
}

const quarantined = () => new HttpError(422, 'FILE_QUARANTINED', 'The malware scan flagged the file; nothing was read or imported');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * Upload: store the file; no row is read before a verdict. In every deployment the verdict is the scan worker's (NFR-S09,
 * storage/scan.ts), so the job is held as UPLOADED (202) without reading the file; the same upload repeated with the same
 * idempotency key resumes it once the file is released, and a quarantined file ends it (422 FILE_QUARANTINED). A verdict
 * already known (a test harness's scan in the request) is applied at once: a finding refuses the import with no job, and a
 * clean file is validated row by row and the job recorded as PREVIEWED (or REJECTED if any row failed).
 */
export async function submitBatch<C extends string>(
  db: Database,
  files: FileStore,
  scanner: ScanProvider,
  grant: AccessGrant,
  spec: BatchSpec<C>,
  body: { fileName: string; contentBase64: string; idempotencyKey: string },
): Promise<Submitted> {
  const existing = (
    await db.query<{ id: string; kind: string; submitted_by: string; state: string }>(`select id, kind, submitted_by, state from import_job where company_id = $1 and idempotency_key = $2`, [
      grant.companyId,
      body.idempotencyKey,
    ])
  ).rows[0];
  if (existing) {
    // Same submitter and import: the same job again (idempotent). Anyone else, or the key of another import (keys are
    // unique per company, not per import): refused without revealing the job, and never read with this import's rules.
    if (existing.submitted_by !== grant.userId || existing.kind !== spec.kind) throw new HttpError(409, 'IDEMPOTENCY_KEY_IN_USE', 'Use a new idempotency key for this upload');
    if (existing.state === 'UPLOADED') return resumeHeld(db, files, scanner, grant, spec, existing.id);
    return { created: false, status: 200, view: (await jobView(db, grant, spec.kind, existing.id))! };
  }
  const bytes = Buffer.from(body.contentBase64, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_BATCH_BYTES) throw new HttpError(422, 'FILE_SIZE', 'Import files must be between 1 byte and 10 MB');
  const fileName = body.fileName.trim();
  const stored = await files.put(grant.companyId, bytes);
  const attachmentId = (
    await db.query<{ id: string }>(
      // The raw file may hold cells nobody should import (e.g. stray personal data), so it is kept CONFIDENTIAL.
      `insert into attachment (company_id, owner_user_id, content_reference, media_type, checksum, classification, file_name, byte_size, scan_state, created_by, updated_by)
       values ($1, $2, $3, 'text/csv', $4, 'CONFIDENTIAL', $5, $6, 'PENDING_SCAN', $2, $2) returning id`,
      [grant.companyId, grant.userId, stored.reference, stored.checksum, fileName, stored.byteSize],
    )
  ).rows[0]!.id;
  const scanState = await scanAttachment(db, scanner, { companyId: grant.companyId, id: attachmentId, bytes });
  if (scanState === 'QUARANTINED') {
    // The file stays quarantined for good (never served); the audit names it, never its content.
    await writeAudit(db, {
      companyId: grant.companyId,
      resource: 'attachment',
      recordKey: attachmentId,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'SCAN_QUARANTINED',
      after: { operational: { purpose: 'IMPORT', kind: spec.kind, template: spec.template.code, fileName, byteSize: stored.byteSize, scanState } },
    });
    throw quarantined();
  }
  const job = { attachmentId, idempotencyKey: body.idempotencyKey, fileName };
  if (scanState === 'PENDING_SCAN') {
    const id = await withTransaction(db, async (tx) => {
      const jobId = await insertJob(tx, grant, spec, job, 'UPLOADED', null);
      await auditJob(tx, grant, jobId, 'CREATE', null, { kind: spec.kind, template: spec.template.code, fileName, rowCount: null, state: 'UPLOADED', scanState });
      return jobId;
    });
    return { created: true, status: 202, view: (await jobView(db, grant, spec.kind, id))! };
  }
  let checked: Checked;
  try {
    checked = await check(db, grant, spec, bytes);
  } catch (err) {
    // A file that is not a valid batch is not kept on record: nothing refers to it.
    await db.query(`delete from attachment where company_id = $1 and id = $2`, [grant.companyId, attachmentId]).catch(() => undefined);
    throw err;
  }
  const id = await withTransaction(db, async (tx) => {
    const jobId = await insertJob(tx, grant, spec, job, 'PREVIEWED', checked.rowCount);
    const state = await recordPreview(tx, grant, jobId, checked);
    await auditJob(tx, grant, jobId, 'CREATE', null, {
      kind: spec.kind,
      template: spec.template.code,
      fileName,
      rowCount: checked.rowCount,
      rejectedRows: checked.outcomes.filter((o) => o.errorCode).length,
      state,
      scanState,
    });
    return jobId;
  });
  return { created: true, status: 201, view: (await jobView(db, grant, spec.kind, id))! };
}

/**
 * The submitter's own job held for the scanner, resumed from its stored file without uploading it again (exactly what
 * the same upload under the same idempotency key does): 202 while still held, 200 with the preview once released,
 * 422 FILE_QUARANTINED if flagged. A job in any other state is returned as it stands; another user's reads as missing.
 */
export async function resumeBatch<C extends string>(db: Database, files: FileStore, scanner: ScanProvider, grant: AccessGrant, spec: BatchSpec<C>, id: string): Promise<Submitted> {
  const view = await jobView(db, grant, spec.kind, id);
  if (!view) throw notFound();
  if ('state' in view && view.state === 'UPLOADED') return resumeHeld(db, files, scanner, grant, spec, id);
  return { created: false, status: 200, view };
}

/** Resumes a job held for the scanner: a file still pending keeps it held (a deployment never scans in the request); once CLEAN it is validated like a new upload. */
async function resumeHeld<C extends string>(db: Database, files: FileStore, scanner: ScanProvider, grant: AccessGrant, spec: BatchSpec<C>, id: string): Promise<Submitted> {
  const held = (
    await db.query<{ attachment_id: string; scan_state: string | null; content_reference: string; checksum: string }>(
      `select a.id as attachment_id, a.scan_state, a.content_reference, a.checksum from import_job j join attachment a on a.company_id = j.company_id and a.id = j.attachment_id
        where j.company_id = $1 and j.id = $2`,
      [grant.companyId, id],
    )
  ).rows[0]!;
  let scanState = held.scan_state;
  // Still with the scan worker: the same answer without fetching a file of up to 10 MB, since an open import screen asks every few seconds.
  if (scanState === 'PENDING_SCAN' && scanner.deferUploads) return { created: false, status: 202, view: (await jobView(db, grant, spec.kind, id))! };
  let bytes: Buffer | null = null;
  if (scanState !== 'QUARANTINED') {
    // A quarantined file is never read again.
    bytes = await files.get(held.content_reference);
    if (sha256(bytes) !== held.checksum) throw new HttpError(409, 'FILE_INTEGRITY', 'The stored import file does not match its checksum');
    if (scanState === 'PENDING_SCAN') scanState = await scanAttachment(db, scanner, { companyId: grant.companyId, id: held.attachment_id, bytes });
  }
  if (scanState === 'QUARANTINED') {
    await closeHeld(db, grant, id, 'SCAN_QUARANTINED', { scanState });
    throw quarantined();
  }
  if (scanState !== 'CLEAN' || !bytes) return { created: false, status: 202, view: (await jobView(db, grant, spec.kind, id))! };
  let checked: Checked;
  try {
    checked = await check(db, grant, spec, bytes);
  } catch (err) {
    if (err instanceof HttpError) await closeHeld(db, grant, id, 'REJECT', { errorCode: err.code });
    throw err;
  }
  await withTransaction(db, async (tx) => {
    if ((await lockedState(tx, grant, id)) !== 'UPLOADED') return; // a concurrent repeat already validated it
    await tx.query(`update import_job set state = 'PREVIEWED', row_count = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, id, checked.rowCount, grant.userId]);
    const state = await recordPreview(tx, grant, id, checked);
    await auditJob(tx, grant, id, 'PREVIEW', { state: 'UPLOADED' }, { rowCount: checked.rowCount, rejectedRows: checked.outcomes.filter((o) => o.errorCode).length, state, scanState });
  });
  return { created: false, status: 200, view: (await jobView(db, grant, spec.kind, id))! };
}

/** Ends a held job without importing anything (its file was quarantined, or is not a valid batch). */
async function closeHeld(db: Database, grant: AccessGrant, id: string, action: 'SCAN_QUARANTINED' | 'REJECT', detail: Record<string, unknown>) {
  await withTransaction(db, async (tx) => {
    if ((await lockedState(tx, grant, id)) !== 'UPLOADED') return;
    await finish(tx, grant, id, 'REJECTED');
    await auditJob(tx, grant, id, action, { state: 'UPLOADED' }, { state: 'REJECTED', ...detail });
  });
}

type Checked = { rowCount: number; outcomes: RowOutcome[]; failed: boolean; partial?: { settledCodes: readonly string[] } | undefined };

/** Reads and validates every row of a released file; nothing is applied (see previewBatch). A partial import never fails as a batch. */
async function check<C extends string>(db: Database, grant: AccessGrant, spec: BatchSpec<C>, bytes: Buffer): Promise<Checked> {
  const rows = spec.parse(bytes);
  const outcomes = await previewBatch(db, rows, (client, row) => spec.apply(client, grant, row), spec.keyOf);
  return { rowCount: rows.length, outcomes, failed: !spec.partial && outcomes.some((o) => o.errorCode), partial: spec.partial };
}

/** Where a failing row of a partial import stands: invalid data waits for review; a settled repeat needs none. */
const partialRowState = (partial: { settledCodes: readonly string[] }, code: string) => (partial.settledCodes.includes(code) ? 'REJECTED' : 'QUARANTINED');

async function insertJob<C extends string>(
  tx: Queryable,
  grant: AccessGrant,
  spec: BatchSpec<C>,
  job: { attachmentId: string; idempotencyKey: string; fileName: string },
  state: 'UPLOADED' | 'PREVIEWED',
  rowCount: number | null,
) {
  return (
    await tx.query<{ id: string }>(
      `insert into import_job (company_id, kind, state, attachment_id, submitted_by, idempotency_key, file_name, row_count, template_code, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $5, $5) returning id`,
      [grant.companyId, spec.kind, state, job.attachmentId, grant.userId, job.idempotencyKey, job.fileName, rowCount, spec.template.code],
    )
  ).rows[0]!.id;
}

/** Records the validated rows; any failed row rejects the batch. Returns the job's resulting state. */
async function recordPreview(tx: Queryable, grant: AccessGrant, jobId: string, checked: Checked): Promise<'PREVIEWED' | 'REJECTED'> {
  await insertRows(tx, grant, jobId, checked);
  if (!checked.failed) return 'PREVIEWED';
  await finish(tx, grant, jobId, 'REJECTED');
  return 'REJECTED';
}

async function lockedState(tx: Queryable, grant: AccessGrant, id: string) {
  return (await tx.query<{ state: string }>(`select state from import_job where company_id = $1 and id = $2 for update`, [grant.companyId, id])).rows[0]?.state;
}

async function auditJob(tx: Queryable, grant: AccessGrant, jobId: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown>) {
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'import_job',
    recordKey: jobId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    before: before ? { operational: before } : null,
    after: { operational: after },
  });
}

/** Row states: a failed row keeps its own code; in a rejected batch every other row is BATCH_REJECTED; a partial import sets each failed row's state. */
async function insertRows(tx: Queryable, grant: AccessGrant, jobId: string, { outcomes, failed, partial }: Checked) {
  await tx.query(
    `insert into import_row (company_id, job_id, row_number, state, error_code, business_key, proposed_changes, created_by, updated_by)
     select $1, $2, o.row_number, coalesce(o.state, case when o.error_code is null and not $7 then 'VALID' else 'REJECTED' end),
            case when o.error_code is null and $7 then 'BATCH_REJECTED' else o.error_code end, o.business_key, o.changes::jsonb, $3, $3
       from unnest($4::int[], $5::text[], $6::text[], $8::text[], $9::text[]) as o(row_number, business_key, error_code, changes, state)`,
    [
      grant.companyId,
      jobId,
      grant.userId,
      outcomes.map((o) => o.rowNumber),
      outcomes.map((o) => o.businessKey),
      outcomes.map((o) => o.errorCode),
      failed,
      outcomes.map((o) => (o.changes ? JSON.stringify(o.changes) : null)),
      outcomes.map((o) => (partial && o.errorCode ? partialRowState(partial, o.errorCode) : null)),
    ],
  );
}

/**
 * A partial commit: the rows the preview found valid, each in its own savepoint, so a row is applied whole or not at all
 * and one that became invalid since the preview stays out by itself. Rows the preview refused stay as they were shown,
 * even if they would pass now: nobody reviewed them as accepted.
 */
async function applyPartially<C extends string>(client: pg.PoolClient, grant: AccessGrant, spec: BatchSpec<C>, partial: { settledCodes: readonly string[] }, jobId: string, rows: TemplateRow<C>[]) {
  const open = new Set((await client.query<{ row_number: number }>(`select row_number from import_row where company_id = $1 and job_id = $2 and state = 'VALID'`, [grant.companyId, jobId])).rows.map((r) => r.row_number));
  const results: { rowNumber: number; state: string; errorCode: string | null; changes: string | null }[] = [];
  for (const r of rows) {
    if (!open.has(r.rowNumber)) continue;
    await client.query('savepoint batch_row');
    try {
      const changes = await spec.apply(client, grant, r.row, { jobId, rowNumber: r.rowNumber });
      await client.query('release savepoint batch_row');
      results.push({ rowNumber: r.rowNumber, state: 'ACCEPTED', errorCode: null, changes: changes && Object.keys(changes).length > 0 ? JSON.stringify(changes) : null });
    } catch (err) {
      await client.query('rollback to savepoint batch_row');
      const code = rowErrorCode(err);
      if (!code) throw err;
      const errorCode = storedRowCode(code);
      results.push({ rowNumber: r.rowNumber, state: partialRowState(partial, errorCode), errorCode, changes: null });
    }
  }
  await client.query(
    `update import_row i set state = o.state, error_code = o.error_code, proposed_changes = coalesce(o.changes::jsonb, i.proposed_changes), updated_by = $3
       from unnest($4::int[], $5::text[], $6::text[], $7::text[]) as o(row_number, state, error_code, changes)
      where i.company_id = $1 and i.job_id = $2 and i.row_number = o.row_number`,
    [grant.companyId, jobId, grant.userId, results.map((o) => o.rowNumber), results.map((o) => o.state), results.map((o) => o.errorCode), results.map((o) => o.changes)],
  );
}

async function finish(tx: Queryable, grant: AccessGrant, jobId: string, state: 'COMMITTED' | 'REJECTED') {
  await tx.query(
    `update import_job set state = $3, updated_by = $4,
            accepted_count = (select count(*) from import_row where company_id = $1 and job_id = $2 and state = 'ACCEPTED'),
            rejected_count = (select count(*) from import_row where company_id = $1 and job_id = $2 and state in ('REJECTED', 'QUARANTINED'))
      where company_id = $1 and id = $2`,
    [grant.companyId, jobId, state, grant.userId],
  );
}

/**
 * Commit: every row in one transaction, or none; a row that became invalid since preview rejects the batch (a partial
 * import quarantines that row and applies the rest). Only a previewed job whose file the malware scan released (CLEAN)
 * is applied (FR-106).
 */
export async function commitBatch<C extends string>(db: Database, files: FileStore, grant: AccessGrant, spec: BatchSpec<C>, id: string) {
  const client = await db.connect();
  let failure: { failedRow: number; errorCode: string } | null = null;
  try {
    await client.query('begin');
    const job = (
      await client.query<{ state: string; scan_state: string | null; content_reference: string; checksum: string }>(
        `select j.state, a.scan_state, a.content_reference, a.checksum from import_job j join attachment a on a.company_id = j.company_id and a.id = j.attachment_id
          where j.company_id = $1 and j.id = $2 and j.kind = $3 and j.submitted_by = $4 for update of j`,
        [grant.companyId, id, spec.kind, grant.userId],
      )
    ).rows[0];
    if (!job) throw notFound();
    if (job.state === 'COMMITTED') {
      await client.query('rollback');
      return jobView(db, grant, spec.kind, id); // idempotent repeat
    }
    if (job.state !== 'PREVIEWED' && job.state !== 'UPLOADED') throw new HttpError(409, 'INVALID_STATE', 'Only a previewed batch without errors can be committed');
    // A held, quarantined or never-scanned file (a job from before import files were scanned) is never applied.
    if (job.scan_state !== 'CLEAN') {
      throw new HttpError(409, 'FILE_NOT_RELEASED', 'Only an import file the malware scan released can be committed', { scanState: job.scan_state ?? 'NOT_SCANNED' });
    }
    if (job.state !== 'PREVIEWED') throw new HttpError(409, 'INVALID_STATE', 'Upload the file again with the same idempotency key to preview it before committing');
    await spec.prepareCommit?.(client, grant);
    const bytes = await files.get(job.content_reference);
    if (sha256(bytes) !== job.checksum) throw new HttpError(409, 'FILE_INTEGRITY', 'The stored import file does not match its checksum');
    if (spec.partial) {
      await applyPartially(client, grant, spec, spec.partial, id, spec.parse(bytes));
      await finish(client, grant, id, 'COMMITTED');
      await auditJob(client, grant, id, 'COMMIT', { state: 'PREVIEWED' }, await partialCounts(client, grant, spec.kind, id));
      await client.query('commit');
      return jobView(db, grant, spec.kind, id);
    }
    failure = await applyBatch(client, spec.parse(bytes), (c, row) => spec.apply(c, grant, row));
    if (failure) {
      await client.query('rollback');
    } else {
      await client.query(`update import_row set state = 'ACCEPTED', updated_by = $3 where company_id = $1 and job_id = $2`, [grant.companyId, id, grant.userId]);
      await finish(client, grant, id, 'COMMITTED');
      await writeAudit(client, {
        companyId: grant.companyId,
        resource: 'import_job',
        recordKey: id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'COMMIT',
        after: { operational: { kind: spec.kind, accepted: true } },
      });
      await client.query('commit');
    }
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
  if (failure) {
    // Nothing was applied; record why the batch is rejected (the job is locked again and must still be PREVIEWED).
    const f = failure;
    await withTransaction(db, async (tx) => {
      const state = await lockedState(tx, grant, id);
      if (state !== 'PREVIEWED') return;
      await tx.query(
        `update import_row set state = 'REJECTED', error_code = case when row_number = $3 then $4 else 'BATCH_REJECTED' end, updated_by = $5
          where company_id = $1 and job_id = $2`,
        [grant.companyId, id, f.failedRow, f.errorCode, grant.userId],
      );
      await finish(tx, grant, id, 'REJECTED');
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'import_job',
        recordKey: id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'REJECT',
        before: { operational: { state: 'PREVIEWED' } },
        after: { operational: { state: 'REJECTED', failedRow: f.failedRow, errorCode: f.errorCode } },
      });
    });
  }
  return jobView(db, grant, spec.kind, id);
}

/** A partial commit's audit: counts only, so they reconcile without naming a row. */
async function partialCounts(tx: Queryable, grant: AccessGrant, kind: string, id: string) {
  const counts = (await tx.query<{ accepted_count: number; rejected_count: number; row_count: number | null }>(`select accepted_count, rejected_count, row_count from import_job where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0]!;
  return { kind, state: 'COMMITTED', rowCount: counts.row_count, acceptedCount: counts.accepted_count, rejectedCount: counts.rejected_count };
}

/** Cancels a previewed job, or one still held for the malware scan. */
export async function cancelBatch(db: Database, grant: AccessGrant, kind: string, id: string) {
  const updated = await db.query(
    `update import_job set state = 'CANCELLED', updated_by = $4
      where company_id = $1 and id = $2 and kind = $3 and submitted_by = $4 and state in ('PREVIEWED', 'UPLOADED')`,
    [grant.companyId, id, kind, grant.userId],
  );
  if (updated.rowCount === 0) {
    if (!(await jobView(db, grant, kind, id))) throw notFound();
    throw new HttpError(409, 'INVALID_STATE', 'Only a previewed batch can be cancelled');
  }
  return jobView(db, grant, kind, id);
}
