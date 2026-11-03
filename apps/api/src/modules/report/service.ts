// Report request -> worker generation -> authorised download (FR-046, FR-056, FR-065; DB081; DF09; ZT05; ZT17).
// The output is CSV, or an XLSX workbook (xlsx.ts) for a report that declares it; the format is kept on the execution.
import { createHash } from 'node:crypto';
import { writeAudit } from '../../audit/audit.js';
import { type Paging, pageMeta, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { assertCompanyWide, isCompanyWide } from '../audit-trail/service.js';
import { failureCode, RETRY_MINUTES } from '../bulk/retry.js';
import { assertEmployeeFilters, EMPLOYEE_SORTS } from '../employee/service.js';
import { acceptedEmployeeFilters, EMPLOYEE_LIST_FILTERS, RECORD_FILTERS, REPORTS, type ReportFilters, type ReportFormat, toCsv, toXlsx } from './catalogue.js';
import { XLSX_MEDIA_TYPE } from './xlsx.js';

/** Download links expire (FR-065); a fresh request is needed afterwards. */
export const OUTPUT_LIFETIME_HOURS = 24;

/** Each output format's media type and file extension. */
export const OUTPUT_TYPES: Record<ReportFormat, { mediaType: string; extension: string }> = {
  CSV: { mediaType: 'text/csv', extension: 'csv' },
  XLSX: { mediaType: XLSX_MEDIA_TYPE, extension: 'xlsx' },
};

export async function requestReport(tx: Queryable, grant: AccessGrant, code: string, filters: ReportFilters, format: ReportFormat = 'CSV') {
  const def = REPORTS[code];
  if (!def) throw new HttpError(422, 'UNKNOWN_REPORT', 'Unknown report');
  // FR-046: XLSX only where the report declares it; CSV is every report's format.
  if (format !== 'CSV' && !def.xlsx) throw new HttpError(422, 'FORMAT_NOT_SUPPORTED', 'This report is generated as CSV only');
  if (def.requiresPeriod && (!filters.from || !filters.to)) throw new HttpError(422, 'PERIOD_REQUIRED', 'This report needs a from/to period');
  if (filters.from && filters.to && filters.to < filters.from) throw new HttpError(422, 'INVALID_PERIOD', 'The period end is before its start');
  if (def.maxPeriodDays && filters.from && filters.to && (Date.parse(filters.to) - Date.parse(filters.from)) / 86_400_000 + 1 > def.maxPeriodDays) {
    throw new HttpError(422, 'PERIOD_TOO_LONG', `This report covers at most ${def.maxPeriodDays} days per request`);
  }
  // FR-007: list filters are refused where a report does not apply them, rather than silently ignored.
  const accepted = acceptedEmployeeFilters(def);
  if (EMPLOYEE_LIST_FILTERS.some((k) => filters[k] !== undefined && !accepted.includes(k))) {
    throw new HttpError(422, 'FILTER_NOT_SUPPORTED', accepted.length > 0 ? `This report takes only these employee list filters: ${accepted.join(', ')}` : 'This report does not take employee list filters');
  }
  if (accepted.length > 0) assertEmployeeFilters(filters);
  if (filters.sort !== undefined && !(def.sorts ?? EMPLOYEE_SORTS).includes(filters.sort)) throw new HttpError(422, 'FILTER_NOT_SUPPORTED', 'This report does not sort by that column');
  if (!def.basisFilter && filters.basis !== undefined) throw new HttpError(422, 'FILTER_NOT_SUPPORTED', 'This report does not take a compensation basis');
  if (!def.statusFilter && filters.status !== undefined) throw new HttpError(422, 'FILTER_NOT_SUPPORTED', 'This report does not take a status filter');
  const records = def.recordFilters ?? [];
  if (RECORD_FILTERS.some((k) => filters[k] !== undefined && !records.includes(k))) {
    throw new HttpError(422, 'FILTER_NOT_SUPPORTED', records.length > 0 ? `This report takes only these record filters: ${records.join(', ')}` : 'This report does not take record filters');
  }
  def.checkFilters?.(filters);
  if (def.companyScopeOnly) assertCompanyWide(grant);
  await def.checkRequest?.(tx, grant, filters);
  const id = (
    await tx.query<{ id: string }>(
      `insert into report_execution (company_id, report_code, requested_by, acting_assignment_id, filter_snapshot, scope_snapshot, state, format, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'QUEUED', $7, $3, $3) returning id`,
      [grant.companyId, code, grant.userId, grant.assignmentId, filters, { scopeKind: grant.scopeKind, filters: grant.filters, businessDate: grant.businessDate }, format],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'report_execution',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'REQUEST',
    after: { operational: { reportCode: code, filters, format } },
  });
  return { id, state: 'QUEUED', format };
}

interface QueuedReport {
  id: string;
  company_id: string;
  report_code: string;
  requested_by: string;
  acting_assignment_id: string;
  filter_snapshot: ReportFilters;
  format: ReportFormat;
  attempts: number;
}

/** One claimed report, inside the transaction that holds its row: re-checks access, then writes the output and completes it. */
async function generateReport(tx: Queryable, job: QueuedReport): Promise<void> {
  const def = REPORTS[job.report_code];
  if (!def) {
    // The report's module is no longer active: nothing is generated.
    await tx.query(`update report_execution set state = 'FAILED', failure_code = 'REPORT_UNAVAILABLE', next_attempt_at = null, running_since = null where id = $1`, [job.id]);
    return;
  }
  const decision = await resolveAccess(tx, {
    userId: job.requested_by,
    companyId: job.company_id,
    assignmentId: job.acting_assignment_id,
    resource: def.resource,
    action: 'export',
    fieldGroups: [def.fieldGroup],
  });
  if (!decision.allowed || (def.companyScopeOnly && !isCompanyWide(decision))) {
    // Access changed after the request: nothing is generated (ZT05).
    await tx.query(`update report_execution set state = 'FAILED', failure_code = 'ACCESS_REVOKED', next_attempt_at = null, running_since = null where id = $1`, [job.id]);
    return;
  }
  let rows: Record<string, unknown>[];
  try {
    rows = await def.rows(tx, decision, job.filter_snapshot);
  } catch (e) {
    // The report's own refusal under the access current at generation (e.g. a payroll run no longer wholly in the
    // requester's scope, SCOPE_INCOMPLETE): nothing is generated and the reason is kept, with no retry. Any other
    // error goes to the caller's retry path.
    if (!(e instanceof HttpError)) throw e;
    await tx.query(`update report_execution set state = 'FAILED', failure_code = $2, next_attempt_at = null, running_since = null where id = $1`, [job.id, e.code]);
    return;
  }
  // CSV is text (report_output.content); an XLSX workbook is binary (report_output.content_bytes, 0067).
  const xlsx = job.format === 'XLSX';
  const content = xlsx ? toXlsx(def, rows) : toCsv(def, rows);
  const checksum = createHash('sha256').update(content).digest('hex');
  const attachmentId = (
    await tx.query<{ id: string }>(
      `insert into attachment (company_id, owner_user_id, content_reference, media_type, checksum, classification, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $2, $2) returning id`,
      [job.company_id, job.requested_by, `report_output:${job.id}`, OUTPUT_TYPES[job.format].mediaType, checksum, def.fieldGroup === 'operational' ? 'OPERATIONAL' : 'CONFIDENTIAL'],
    )
  ).rows[0]!.id;
  await tx.query(`insert into report_output (company_id, execution_id, content, content_bytes) values ($1, $2, $3, $4)`, [
    job.company_id,
    job.id,
    xlsx ? null : content,
    xlsx ? content : null,
  ]);
  await tx.query(
    `update report_execution set state = 'COMPLETED', generated_at = now(), expires_at = now() + make_interval(hours => $2),
            output_attachment_id = $3, row_count = $4, failure_code = null, next_attempt_at = null, running_since = null where id = $1`,
    [job.id, OUTPUT_LIFETIME_HOURS, attachmentId, rows.length],
  );
}

/**
 * How long an unlocked RUNNING execution waits before another tick takes it. A live generation holds its row lock (the
 * claim skips locked rows), so only a worker that died between its two transactions, or during the second, is taken
 * again. A technical bound, not a business rule.
 */
export const RUNNING_LEASE_MINUTES = 5;

const CLAIM_COLUMNS = `id, company_id, report_code, requested_by, acting_assignment_id, filter_snapshot, format, attempts`;

/**
 * Claims the oldest due execution and commits RUNNING, so the requester can see that it is being generated (FR-056).
 * An execution left RUNNING by a dead worker counts an attempt, so one that keeps killing the worker still ends FAILED.
 * Answers the claimed job and its running_since, 'SKIPPED' when the one it looked at had used its attempts, or null.
 */
async function claimReport(db: Database): Promise<{ job: QueuedReport; since: string } | 'SKIPPED' | null> {
  return withTransaction(db, async (tx) => {
    const job = (
      await tx.query<QueuedReport & { state: string }>(
        `select ${CLAIM_COLUMNS}, state from report_execution
          where (state = 'QUEUED' and (next_attempt_at is null or next_attempt_at <= now()))
             or (state = 'RUNNING' and running_since <= now() - make_interval(mins => $1))
          order by created_at limit 1 for update skip locked`,
        [RUNNING_LEASE_MINUTES],
      )
    ).rows[0];
    if (!job) return null;
    const interrupted = job.state === 'RUNNING';
    const attempts = interrupted ? job.attempts + 1 : job.attempts;
    if (interrupted && RETRY_MINUTES[attempts - 1] === undefined) {
      await tx.query(`update report_execution set state = 'FAILED', attempts = $2, failure_code = 'WORKER_INTERRUPTED', next_attempt_at = null, running_since = null where id = $1`, [job.id, attempts]);
      return 'SKIPPED';
    }
    // As text: the column keeps microseconds, which a JavaScript Date would round away, and the claim is compared exactly.
    const since = (
      await tx.query<{ since: string }>(`update report_execution set state = 'RUNNING', attempts = $2, next_attempt_at = null, running_since = clock_timestamp() where id = $1 returning running_since::text as since`, [job.id, attempts])
    ).rows[0]!.since;
    return { job: { ...job, attempts }, since };
  });
}

/**
 * Worker: generate up to `limit` due reports: each is claimed in one transaction (visible as RUNNING) and generated in
 * another, re-checking access first. A failed generation rolls back only itself and is retried after 1, 5 and 15
 * minutes, then ends FAILED with an error class (FR-056: a failure is never shown as no data); the queue moves on to
 * the next report meanwhile.
 */
export async function processReportQueue(db: Database, limit = 20): Promise<number> {
  let processed = 0;
  for (let i = 0; i < limit; i++) {
    const claim = await claimReport(db);
    if (!claim) break;
    processed++;
    if (claim === 'SKIPPED') continue;
    const { job, since } = claim;
    await withTransaction(db, async (tx) => {
      // The row lock keeps other workers off it for the whole generation; a claim taken over since then is theirs.
      const held = await tx.query(`select 1 from report_execution where id = $1 and state = 'RUNNING' and running_since = $2::timestamptz for update skip locked`, [job.id, since]);
      if (!held.rowCount) return;
      await tx.query('savepoint report_generation');
      try {
        await generateReport(tx, job);
        await tx.query('release savepoint report_generation');
      } catch (err) {
        await tx.query('rollback to savepoint report_generation');
        const attempt = job.attempts + 1;
        const delay = RETRY_MINUTES[attempt - 1] ?? null;
        await tx.query(
          `update report_execution set state = case when $3::int is null then 'FAILED' else 'QUEUED' end, attempts = $2, failure_code = $4, running_since = null,
                  next_attempt_at = case when $3::int is null then null else now() + make_interval(mins => $3::int) end
            where id = $1`,
          [job.id, attempt, delay, failureCode(err)],
        );
      }
    });
  }
  return processed;
}

/** Executions answered without page/pageSize. */
export const REPORT_LIST_CAP = 100;

/**
 * FR-056 "recoverable download links": the requester's own executions under this assignment, newest first, so a download
 * survives a page reload. Nothing here opens a file: the download re-checks access (ZT05). A report whose module is no
 * longer active keeps its code as its title.
 */
export async function listOwnReports(db: Queryable, actor: { userId: string; companyId: string; assignmentId: string | null }, paging: Paging = {}) {
  const page = await pageOf<{ reportCode: string } & Record<string, unknown>>(
    db,
    `select id, report_code as "reportCode", case when state = 'COMPLETED' and coalesce(expires_at <= now(), false) then 'EXPIRED' else state end as state,
            row_count as "rowCount", failure_code as "failureCode", created_at as "requestedAt", generated_at as "generatedAt", expires_at as "expiresAt",
            filter_snapshot as filters, format
       from report_execution where company_id = $1 and requested_by = $2 and acting_assignment_id = $3`,
    [actor.companyId, actor.userId, actor.assignmentId],
    '"requestedAt" desc, id',
    paging,
    REPORT_LIST_CAP,
  );
  return { items: page.items.map((r) => ({ ...r, title: REPORTS[r.reportCode]?.title ?? r.reportCode })), ...pageMeta(page) };
}

interface ExecutionRow {
  id: string;
  report_code: string;
  requested_by: string;
  acting_assignment_id: string;
  state: string;
  row_count: number | null;
  failure_code: string | null;
  generated_at: string | null;
  expires_at: string | null;
  expired: boolean;
  filter_snapshot: ReportFilters;
  format: ReportFormat;
}

async function loadOwnExecution(db: Queryable, companyId: string, userId: string, id: string): Promise<ExecutionRow> {
  const row = (
    await db.query<ExecutionRow>(
      `select id, report_code, requested_by, acting_assignment_id, state, row_count, failure_code, generated_at, expires_at,
              coalesce(expires_at <= now(), false) as expired, filter_snapshot, format
         from report_execution where company_id = $1 and id = $2`,
      [companyId, id],
    )
  ).rows[0];
  // Outputs belong to their requester; anyone else sees nothing (no shared cached output across scopes).
  if (!row || row.requested_by !== userId) throw notFound();
  return row;
}

export async function reportStatus(db: Queryable, companyId: string, userId: string, id: string) {
  const r = await loadOwnExecution(db, companyId, userId, id);
  return {
    id: r.id,
    reportCode: r.report_code,
    state: r.expired && r.state === 'COMPLETED' ? 'EXPIRED' : r.state,
    rowCount: r.row_count,
    failureCode: r.failure_code,
    generatedAt: r.generated_at,
    expiresAt: r.expires_at,
    filters: r.filter_snapshot,
    format: r.format,
  };
}

/** Download re-checks access under the same assignment the report was generated for (ZT05, BR-046). */
export async function downloadReport(db: Queryable, actor: { userId: string; companyId: string; assignmentId: string | null }, id: string) {
  const r = await loadOwnExecution(db, actor.companyId, actor.userId, id);
  if (r.state !== 'COMPLETED') throw new HttpError(409, 'NOT_READY', 'The report is not available');
  if (r.expired) throw new HttpError(410, 'EXPIRED', 'The download has expired; request the report again');
  if (actor.assignmentId !== r.acting_assignment_id) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  // A report whose module is no longer active is not served.
  const def = REPORTS[r.report_code];
  if (!def) throw notFound();
  const decision = await resolveAccess(db, { ...actor, assignmentId: actor.assignmentId, resource: def.resource, action: 'export', fieldGroups: [def.fieldGroup] });
  if (!decision.allowed || (def.companyScopeOnly && !isCompanyWide(decision))) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  const output = (
    await db.query<{ content: string | null; content_bytes: Buffer | null }>(`select content, content_bytes from report_output where company_id = $1 and execution_id = $2`, [actor.companyId, id])
  ).rows[0];
  if (!output) throw notFound();
  const type = OUTPUT_TYPES[r.format];
  return {
    filename: `${r.report_code.toLowerCase()}-${r.id.slice(0, 8)}.${type.extension}`,
    mediaType: type.mediaType,
    content: (output.content_bytes ?? output.content)!,
  };
}
