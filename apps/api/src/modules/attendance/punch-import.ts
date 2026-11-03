// Attendance punch imports (FR-019; DF05; DF09; I-21). Two published templates run through the shared batch framework
// (imports/jobs.ts), so each submission has its stored file, a dry-run preview, row results and the follow-up routes:
//   ATTENDANCE_PUNCH_V1    one event per row: employee, instant with offset, direction, event key and, optionally, the
//                          device or source the key belongs to, so equal device-local keys of two devices do not collide.
//   ATTENDANCE_IN_OUT_V1   a day's in and out times in company local time, turned into an IN and an OUT punch. An out
//                          time not after the in time belongs to the next calendar day (DF05: a shift belongs to its start
//                          date); a row with one time is one event, which evaluation later shows as a missing punch.
// Valid independent events are accepted and invalid ones quarantined; a single row is never partly accepted (DF09). Each
// stored punch points at its job row (0114). POST /attendance/punches keeps its JSON form: it becomes the same tracked
// submission with its rows written as the punch template, previewed and committed in one request.
//
// A row's result (FR-019 "identify invalid or repeated punches"):
//   ACCEPTED     stored; a punch repeating one from another source is stored and flagged, since how such repeats pair
//                stays under the approval FR-020 requires (repeat_of_punch_id, shown in the row and in the punch list).
//   QUARANTINED  invalid, for review: INVALID_TIMESTAMP (no offset, not a real date or time), FUTURE_TIMESTAMP (later than
//                the submission), UNKNOWN_EMPLOYEE (also out of scope), CONFLICTING_DUPLICATE_KEY (the key's stored event
//                differs), and the field codes below. Corrected events go in a new file.
//   REJECTED     settled, nothing to review: DUPLICATE_EVENT (the key's stored event is identical: a replay) and
//                REPEATED_PUNCH (the same employee, instant and direction under another key of this source, stored or earlier in
//                the batch). So reimporting an identical file doubles nothing, as event-key replay protection always did.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import type { Database } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { resolveInstant } from '../biometric/sync.js';
import { isCalendarDate, MAX_BATCH_BYTES, MAX_BATCH_ROWS, parseTemplate, type RowChanges, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, type RowContext, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { csvCell } from '../report/catalogue.js';
import type pg from 'pg';

/** The event-key namespace of a row naming no source; the same as before sources could be named, so earlier keys still replay. */
export const MANUAL_SOURCE = 'manual-import';

const PUNCH_COLUMNS = ['employeeCode', 'occurredAt', 'direction', 'externalEventKey', 'sourceIdentity'] as const;
type PunchColumn = (typeof PUNCH_COLUMNS)[number];
export const PUNCH_TEMPLATE: Template<PunchColumn> = { code: 'ATTENDANCE_PUNCH_V1', columns: PUNCH_COLUMNS };

const IN_OUT_COLUMNS = ['employeeCode', 'workDate', 'inTime', 'outTime'] as const;
type InOutColumn = (typeof IN_OUT_COLUMNS)[number];
export const IN_OUT_TEMPLATE: Template<InOutColumn> = { code: 'ATTENDANCE_IN_OUT_V1', columns: IN_OUT_COLUMNS };

const SETTLED = { settledCodes: ['DUPLICATE_EVENT', 'REPEATED_PUNCH'] } as const;

const INSTANT = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const SOURCE_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;
const MAX_EVENT_KEY = 200;

/** An instant needs an explicit offset and a real calendar date (a loose parser would roll 30 February into March). */
function parseInstant(value: string): Date | null {
  const m = INSTANT.exec(value);
  if (!m || !isCalendarDate(m[1]!)) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

async function employeeInScope(client: Queryable, grant: AccessGrant, code: string): Promise<string> {
  const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, code.toUpperCase()])).rows[0];
  // Outside the caller's row scope reads exactly like a code that does not exist.
  if (!employee || !(await canAccessEmployee(client, grant, employee.id))) throw new RowError('UNKNOWN_EMPLOYEE');
  return employee.id;
}

interface PunchEvent {
  employeeId: string;
  /** An ISO instant. */
  at: string;
  direction: 'IN' | 'OUT';
  key: string;
  source: string;
}

type Stored = { result: 'STORED'; repeatOfSource: string | null } | { result: 'DUPLICATE_EVENT' | 'REPEATED_PUNCH' };

/** Stores one event, unless its key is already taken or it repeats a punch of its own source (see the header for the codes). */
async function storeEvent(client: Queryable, grant: AccessGrant, e: PunchEvent, submission: RowContext | undefined): Promise<Stored> {
  const taken = (
    await client.query<{ same: boolean }>(
      `select (employee_id = $3 and occurred_at = $4::timestamptz and direction = $5) as same from attendance_punch
        where company_id = $1 and source_identity_key = $2 and external_event_key = $6`,
      [grant.companyId, e.source, e.employeeId, e.at, e.direction, e.key],
    )
  ).rows[0];
  if (taken) {
    if (!taken.same) throw new RowError('CONFLICTING_DUPLICATE_KEY');
    return { result: 'DUPLICATE_EVENT' };
  }
  const repeated = await client.query(
    `select 1 from attendance_punch where company_id = $1 and employee_id = $2 and occurred_at = $3::timestamptz and direction = $4 and source_identity_key = $5 limit 1`,
    [grant.companyId, e.employeeId, e.at, e.direction, e.source],
  );
  if (repeated.rowCount) return { result: 'REPEATED_PUNCH' };
  const row = (
    await client.query<{ repeat_of_source: string | null }>(
      `with stored as (
         insert into attendance_punch (company_id, employee_id, occurred_at, direction, source_kind, external_event_key, source_identity_key,
                                       import_job_id, import_row_number, repeat_of_punch_id, created_by, updated_by)
         values ($1, $2, $3::timestamptz, $4, 'MANUAL_IMPORT', $5, $6, $7, $8, hrms_punch_repeat_of($1, $2, $3::timestamptz, $4), $9, $9)
         returning company_id, repeat_of_punch_id)
       select p.source_identity_key as repeat_of_source from stored s left join attendance_punch p on p.company_id = s.company_id and p.id = s.repeat_of_punch_id`,
      [grant.companyId, e.employeeId, e.at, e.direction, e.key, e.source, submission?.jobId ?? null, submission?.rowNumber ?? null, grant.userId],
    )
  ).rows[0]!;
  return { result: 'STORED', repeatOfSource: row.repeat_of_source };
}

/** Shown beside the row: which other source already delivered this punch. */
const flagged = (source: string | null | undefined): RowChanges | void => (source ? { repeatOfSource: { from: null, to: source } } : undefined);

/** A commit re-checks the duty (docs/09 §6.5) and runs alone in the company, so that two submissions cannot both pass the repeat check. */
async function prepareCommit(client: pg.PoolClient, grant: AccessGrant): Promise<void> {
  await reassertAccess(client, grant, 'attendance', 'import', ['operational']);
  await client.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`attendance:punch-import:${grant.companyId}`]);
}

export const PUNCH_IMPORT_SPEC: BatchSpec<PunchColumn> = {
  kind: 'attendance_punch',
  template: PUNCH_TEMPLATE,
  partial: SETTLED,
  prepareCommit,
  parse: (bytes) => parseTemplate(bytes, PUNCH_TEMPLATE),
  keyOf: (row, n) => (row.employeeCode ? `${row.employeeCode.toUpperCase()} ${row.direction.toUpperCase()} @ ${row.occurredAt}` : `ROW-${n}`),
  async apply(client, grant, row, at) {
    const instant = parseInstant(row.occurredAt);
    if (!instant) throw new RowError('INVALID_TIMESTAMP');
    if (instant.getTime() > Date.now()) throw new RowError('FUTURE_TIMESTAMP');
    const direction = row.direction.toUpperCase();
    if (direction !== 'IN' && direction !== 'OUT') throw new RowError('INVALID_DIRECTION');
    if (!row.externalEventKey) throw new RowError('MISSING_EVENT_KEY');
    if (row.externalEventKey.length > MAX_EVENT_KEY) throw new RowError('INVALID_EVENT_KEY');
    if (row.sourceIdentity && !SOURCE_IDENTITY.test(row.sourceIdentity)) throw new RowError('INVALID_SOURCE');
    const employeeId = await employeeInScope(client, grant, row.employeeCode);
    const stored = await storeEvent(
      client,
      grant,
      { employeeId, at: instant.toISOString(), direction, key: row.externalEventKey, source: row.sourceIdentity ? `${MANUAL_SOURCE}:${row.sourceIdentity.toUpperCase()}` : MANUAL_SOURCE },
      at,
    );
    if (stored.result !== 'STORED') throw new RowError(stored.result);
    return flagged(stored.repeatOfSource);
  },
};

const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

export const IN_OUT_IMPORT_SPEC: BatchSpec<InOutColumn> = {
  kind: 'attendance_in_out',
  template: IN_OUT_TEMPLATE,
  partial: SETTLED,
  prepareCommit,
  parse: (bytes) => parseTemplate(bytes, IN_OUT_TEMPLATE),
  keyOf: (row, n) => (row.employeeCode ? `${row.employeeCode.toUpperCase()} @ ${row.workDate}` : `ROW-${n}`),
  async apply(client, grant, row, at) {
    if (!isCalendarDate(row.workDate)) throw new RowError('INVALID_DATE');
    if (!row.inTime && !row.outTime) throw new RowError('MISSING_TIMES');
    if ((row.inTime && !LOCAL_TIME.test(row.inTime)) || (row.outTime && !LOCAL_TIME.test(row.outTime))) throw new RowError('INVALID_TIME');
    // DF05: a zero-duration pair is rejected.
    if (row.inTime && row.inTime === row.outTime) throw new RowError('ZERO_DURATION');
    const tz = (await client.query<{ tz: string }>(`select business_timezone as tz from company where id = $1`, [grant.companyId])).rows[0]!.tz;
    const local = async (day: string, time: string) => {
      const instant = await resolveInstant(client, { kind: 'LOCAL', value: `${day}T${time}:00` }, tz);
      // DF09: a time inside a daylight-saving gap or overlap names no single instant.
      if (!instant) throw new RowError('AMBIGUOUS_LOCAL_TIME');
      if (Date.parse(instant) > Date.now()) throw new RowError('FUTURE_TIMESTAMP');
      return instant;
    };
    const events: { direction: 'IN' | 'OUT'; at: string }[] = [];
    if (row.inTime) events.push({ direction: 'IN', at: await local(row.workDate, row.inTime) });
    if (row.outTime) events.push({ direction: 'OUT', at: await local(row.inTime && row.outTime < row.inTime ? nextDay(row.workDate) : row.workDate, row.outTime) });
    const employeeId = await employeeInScope(client, grant, row.employeeCode);
    const code = row.employeeCode.toUpperCase();
    const results: Stored[] = [];
    for (const e of events) {
      // One key per employee, work date and direction: a later file with another time for that day is a conflict, never a second punch.
      results.push(await storeEvent(client, grant, { employeeId, at: e.at, direction: e.direction, key: `in-out:${code}:${row.workDate}:${e.direction}`, source: MANUAL_SOURCE }, at));
    }
    const stored = results.filter((r) => r.result === 'STORED');
    if (stored.length === 0) throw new RowError(results.some((r) => r.result === 'REPEATED_PUNCH') ? 'REPEATED_PUNCH' : 'DUPLICATE_EVENT');
    return flagged(stored.find((r) => r.repeatOfSource)?.repeatOfSource);
  },
};

// ---------------------------------------------------------------------------------------------------------------
// The JSON submission, the error report and the punch list
// ---------------------------------------------------------------------------------------------------------------

export interface PunchInput {
  employeeCode: string;
  occurredAt: string;
  direction: 'IN' | 'OUT';
  externalEventKey: string;
  sourceIdentity?: string | undefined;
}

const rawCell = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** The JSON rows written as the published template: what this submission keeps as its file. */
export function punchesAsCsv(punches: readonly PunchInput[]): Buffer {
  const lines = [PUNCH_COLUMNS.join(',')];
  for (const p of punches) lines.push(PUNCH_COLUMNS.map((c) => rawCell(p[c] ?? '')).join(','));
  return Buffer.from(`${lines.join('\r\n')}\r\n`, 'utf8');
}

interface JobRow {
  rowNumber: number;
  state: string;
  errorCode: string | null;
}

/** Counts reconcile: received = accepted + duplicates + rejected. A stored row is accepted, a replayed key a duplicate; every other row is listed. */
export function jsonImportResult(jobId: string, rows: readonly JobRow[]) {
  const rejected: { index: number; code: string }[] = [];
  let accepted = 0;
  let duplicates = 0;
  for (const r of rows) {
    if (r.state === 'ACCEPTED') accepted++;
    else if (r.errorCode === 'DUPLICATE_EVENT') duplicates++;
    else rejected.push({ index: r.rowNumber - 1, code: r.errorCode ?? r.state });
  }
  return { jobId, received: rows.length, accepted, duplicates, rejected };
}

/**
 * FR-019 "an unknown employee or invalid timestamp appears in the error report": the rows left out of a batch, with the
 * cells they were submitted with, rebuilt from the job's stored rows and stored file. Only the submitter's own job (as
 * every job view); cells are written with the export formula guard (DF09).
 */
export async function errorReport<C extends string>(db: Database, files: FileStore, grant: AccessGrant, spec: BatchSpec<C>, id: string) {
  const job = (
    await db.query<{ scan_state: string | null; content_reference: string }>(
      `select a.scan_state, a.content_reference from import_job j join attachment a on a.company_id = j.company_id and a.id = j.attachment_id
        where j.company_id = $1 and j.id = $2 and j.kind = $3 and j.submitted_by = $4`,
      [grant.companyId, id, spec.kind, grant.userId],
    )
  ).rows[0];
  if (!job) throw notFound();
  if (job.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'Only an import file the malware scan released can be read', { scanState: job.scan_state ?? 'NOT_SCANNED' });
  const rows = (
    await db.query<{ row_number: number; state: string; error_code: string }>(
      `select row_number, state, error_code from import_row where company_id = $1 and job_id = $2 and state in ('REJECTED', 'QUARANTINED') order by row_number`,
      [grant.companyId, id],
    )
  ).rows;
  const cells = new Map(spec.parse(await files.get(job.content_reference)).map((r) => [r.rowNumber, r.row]));
  const lines = [['rowNumber', 'state', 'errorCode', ...spec.template.columns].map(csvCell).join(',')];
  for (const r of rows) {
    const row = cells.get(r.row_number);
    lines.push([r.row_number, r.state, r.error_code, ...spec.template.columns.map((c) => row?.[c] ?? '')].map(csvCell).join(','));
  }
  await writeAudit(db, {
    companyId: grant.companyId,
    resource: 'import_job',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'EXPORT_ERROR_REPORT',
    after: { operational: { kind: spec.kind, rows: rows.length } },
  });
  return { fileName: `${spec.template.code}-errors.csv`, content: `${lines.join('\r\n')}\r\n` };
}

/** An employee's stored punches with the submission or source each came from (FR-019 traceability); operational fields only. */
export async function listPunches(db: Queryable, grant: AccessGrant, employeeId: string, from: string, to: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const rows = await db.query(
    `select p.id, p.occurred_at as "occurredAt", p.direction, p.source_kind as "sourceKind", p.source_identity_key as "source", p.external_event_key as "eventKey",
            p.import_job_id as "importJobId", p.import_row_number as "importRowNumber", p.repeat_of_punch_id as "repeatOfPunchId"
       from attendance_punch p
      where p.company_id = $1 and p.employee_id = $2 and hrms_business_date(p.company_id, p.occurred_at) between $3::date and $4::date
      order by p.occurred_at, p.created_at, p.id`,
    [grant.companyId, employeeId, from, to],
  );
  return { employeeId, items: rows.rows };
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const importKey = { type: 'string', minLength: 8, maxLength: 200 } as const;

const fileBody = {
  type: 'object',
  additionalProperties: false,
  required: ['fileName', 'contentBase64', 'idempotencyKey'],
  properties: {
    fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\<>:"|?*\\x00-\\x1f\\x7f]+$' },
    contentBase64: { type: 'string', minLength: 4 },
    idempotencyKey: importKey,
  },
} as const;

const jsonBody = {
  type: 'object',
  additionalProperties: false,
  required: ['punches'],
  properties: {
    idempotencyKey: importKey,
    punches: {
      type: 'array',
      minItems: 1,
      maxItems: MAX_BATCH_ROWS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['employeeCode', 'occurredAt', 'direction', 'externalEventKey'],
        properties: {
          employeeCode: { type: 'string', minLength: 1, maxLength: 40 },
          occurredAt: { type: 'string', maxLength: 40 },
          direction: { type: 'string', enum: ['IN', 'OUT'] },
          externalEventKey: { type: 'string', minLength: 1, maxLength: MAX_EVENT_KEY },
          sourceIdentity: { type: 'string', minLength: 1, maxLength: 60 },
        },
      },
    },
  },
} as const;

export async function punchImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  const grantOf = (request: FastifyRequest, id?: string) => requireAccess(db, request, 'attendance', 'import', ['operational'], { requireAll: true, ...(id ? { recordKey: id } : {}) });

  function batchRoutes<C extends string>(path: string, spec: BatchSpec<C>): void {
    app.post(path, { bodyLimit: Math.ceil(MAX_BATCH_BYTES * 1.4), schema: { body: fileBody } }, async (request, reply) => {
      const { status, view } = await submitBatch(db, files, scanner, await grantOf(request), spec, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    });
    app.get(`${path}/:id`, { schema: { params: idParams } }, async (request) => {
      const { id } = request.params as { id: string };
      const view = await jobView(db, await grantOf(request, id), spec.kind, id);
      if (!view) throw notFound();
      return view;
    });
    // The caller's own batches, the published template and resuming one held for the malware scan (imports/routes.ts).
    batchFollowUpRoutes(app, { db, files, scanner, path, spec, readGrant: (request) => grantOf(request), submitGrant: (request, id) => grantOf(request, id) });
    app.post(`${path}/:id/commit`, { schema: { params: idParams } }, async (request) => {
      const { id } = request.params as { id: string };
      return commitBatch(db, files, await grantOf(request, id), spec, id);
    });
    app.post(`${path}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
      const { id } = request.params as { id: string };
      return cancelBatch(db, await grantOf(request, id), spec.kind, id);
    });
    // Reads and parses a stored file of up to 10,000 rows, as an export does.
    app.get(`${path}/:id/error-report`, { config: { servingClass: 'batch' }, schema: { params: idParams } }, async (request, reply) => {
      const { id } = request.params as { id: string };
      const file = await errorReport(db, files, await grantOf(request, id), spec, id);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="${file.fileName}"`)
        .header('cache-control', 'no-store')
        .send(file.content);
    });
  }

  batchRoutes('/attendance/punch-imports', PUNCH_IMPORT_SPEC);
  batchRoutes('/attendance/in-out-imports', IN_OUT_IMPORT_SPEC);

  // The JSON form of a submission: previewed and committed in one request, and tracked as any other. A file the scanner
  // cannot judge yet is held (202 with the batch), to be resumed and committed under /attendance/punch-imports.
  app.post('/attendance/punches', { schema: { body: jsonBody }, bodyLimit: 10 * 1024 * 1024 }, async (request, reply) => {
    const grant = await grantOf(request);
    const body = request.body as { punches: PunchInput[]; idempotencyKey?: string };
    const submitted = await submitBatch(db, files, scanner, grant, PUNCH_IMPORT_SPEC, {
      fileName: 'punches-api.csv',
      contentBase64: punchesAsCsv(body.punches).toString('base64'),
      idempotencyKey: body.idempotencyKey ?? `punches-api-${randomUUID()}`,
    });
    const view = submitted.view as { id: string; state: string; rows: JobRow[] };
    if (view.state === 'UPLOADED') {
      reply.status(202);
      return { jobId: view.id, state: view.state, received: body.punches.length };
    }
    const committed = view.state === 'PREVIEWED' ? await commitBatch(db, files, grant, PUNCH_IMPORT_SPEC, view.id) : view;
    return jsonImportResult(view.id, (committed as unknown as { rows: JobRow[] }).rows);
  });

  app.get(
    '/employees/:id/punches',
    { schema: { params: idParams, querystring: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: date, to: date } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const { from, to } = request.query as { from: string; to: string };
      if (to < from) throw new HttpError(400, 'INVALID_REQUEST', 'to must not be before from');
      return listPunches(db, await requireAccess(db, request, 'attendance', 'read', ['operational'], { recordKey: id }), id, from, to);
    },
  );
}
