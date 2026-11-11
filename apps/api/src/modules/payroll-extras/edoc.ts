// Export for EDOC (BRD coverage CL-100, under FR-107 issued payslips and NFR-S09 bulk work). Built 11 Nov 2026 from the reference
// system's "Export for EDOC" screen; decided under owner delegation, 6 Nov 2026.
//
// A ZIP of the issued payslips of one month, one PDF per employee, for upload to an electronic document store. A company-wide loop, so
// it runs as a bulk job (PAYSLIP_EDOC_EXPORT, bulk/kinds.ts): the request answers 202, the worker renders the PDFs in bounded chunks
// under the requester's export grant (payroll_output.export.amount, re-checked for every chunk) and row scope, never their own payslip,
// and stores them with the job (payroll_edoc_export_file); the requester downloads the ZIP once the job completes, within 24 hours.
// The download re-checks the grant and refuses the whole archive when anyone in it has left the requester's row scope (SCOPE_CHANGED),
// as a report download does. The request, the completion and every download are audited (payroll_edoc_export). One export of a month per
// requester at a time: while one is queued, running or completed within its download window, a new request answers that job; and an
// archive whose PDFs together exceed EDOC_MAX_ARCHIVE_BYTES is not built (EXPORT_TOO_LARGE), since a download builds it in memory.
//
// Which payslips: the current issue (ISSUED, not SUPERSEDED) of every payslip whose payroll period ends in the month. The payslip itself
// is stored as the issued JSON document (payroll-outputs/payslips.ts HRMS_PAYSLIP_JSON_V1) and no PDF rendering of it existed, so each PDF
// is rendered here with the report PDF writer (report/pdf.ts) from the processed payroll record the payslip was issued for, whose lines
// and totals are frozen at processing: the company, employee, period, paid days, every line and the totals, the issued version and the
// SHA-256 of the issued document it stands for. The issued document's payment position at publication is not repeated (ESS shows it).
import { createHash } from 'node:crypto';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { ChunkOutcome } from '../bulk/kinds.js';
import { type PdfColumn, pdfDocument } from '../report/pdf.js';
import { zipStored } from '../report/xlsx.js';
import { auditChange, MONTH } from './common.js';

export const EDOC_KIND = 'PAYSLIP_EDOC_EXPORT';
/** How long a completed export can be downloaded, as a report output (report/service.ts OUTPUT_LIFETIME_HOURS). */
export const OUTPUT_LIFETIME_HOURS = 24;
export const EDOC_PERMISSION = { resource: 'payroll_output', action: 'export', fieldGroups: ['amount'] } as const;

export interface EdocTotals {
  month: string;
  files: number;
}

export function checkEdocMonth(month: unknown): string {
  if (typeof month !== 'string' || !MONTH.test(month)) throw new HttpError(422, 'INVALID_MONTH', 'The month must be written YYYY-MM');
  return month;
}

/** The issued payslips of the month in the grant's row scope, never the requester's own (alias o, e, p). */
function issuedWhere(grant: AccessGrant, p: SqlParams, month: string): string {
  const scope = employeeScopePredicate(grant, { company: 'o.company_id', employee: 'o.employee_id' }, p);
  return `o.company_id = ${p.add(grant.companyId)}::uuid and o.kind = 'PAYSLIP' and o.publication_state = 'ISSUED'
      and to_char(p.service_end, 'YYYY-MM') = ${p.add(month)} and ${scope}
      and not exists (select 1 from user_employee_link u where u.company_id = o.company_id and u.user_id = ${p.add(grant.userId)}::uuid and u.employee_id = o.employee_id)`;
}

interface Facts {
  output_id: string;
  employee_id: string;
  employee_code: string;
  display_name: string;
  content_hash: string;
  output_version: number;
  issued_on: string;
  record_id: string;
  period_code: string;
  financial_year: string;
  service_start: string;
  service_end: string;
  payment_date: string;
  company_code: string;
  company_name: string;
  currency_code: string;
  minor: number;
  days_in_month: number;
  paid_units: string | null;
  earnings: string | null;
  reimbursements: string | null;
  deductions: string | null;
  net: string | null;
  employer_contributions: string | null;
}

const PDF_COLUMNS: PdfColumn[] = [{ width: 110 }, { width: 215 }, { width: 90 }, { width: 100, align: 'right' }];
const HEAD_LABEL: Record<string, string> = { EARNING: 'Earning', REIMBURSEMENT: 'Reimbursement', DEDUCTION: 'Deduction', EMPLOYER_CONTRIBUTION: 'Employer contribution' };

/** An amount as the currency writes it (the stored value is already rounded to its minor unit). */
const shown = (amount: string | null, minor: number) => {
  if (amount === null) return '';
  const [whole, fraction = ''] = amount.split('.');
  return minor === 0 ? whole! : `${whole}.${fraction.padEnd(minor, '0').slice(0, minor)}`;
};

/** One payslip's PDF, from its frozen record. */
async function renderPayslip(db: Queryable, companyId: string, f: Facts): Promise<Buffer> {
  const lines = (
    await db.query<{ code: string; name: string; head_type: string; amount: string }>(
      `select pc.code, pc.name, l.head_type, l.amount::text as amount
         from payroll_line l join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id
         left join payroll_head_revision hr on hr.company_id = l.company_id and hr.id = l.head_revision_id
        where l.company_id = $1 and l.record_id = $2
        order by case l.head_type when 'EARNING' then 1 when 'REIMBURSEMENT' then 2 when 'DEDUCTION' then 3 else 4 end, hr.display_sequence nulls last, pc.code`,
      [companyId, f.record_id],
    )
  ).rows;
  const m = f.minor;
  const rows: string[][] = [
    ['PAYSLIP', `${f.company_name} (${f.company_code})`],
    ['Employee', `${f.display_name} (${f.employee_code})`],
    ['Period', `${f.period_code}: ${f.service_start} to ${f.service_end} (financial year ${f.financial_year})`],
    ['Payment date', f.payment_date],
    ['Paid days', `${f.paid_units ?? ''} of ${f.days_in_month}`],
    ['Currency', f.currency_code],
    ['Issued version', `${f.output_version}, issued ${f.issued_on}`],
    // The hash on two lines, each within its column, so it reads (and searches) whole.
    ['Issued document', `SHA-256 ${f.content_hash.slice(0, 32)}`],
    ['', f.content_hash.slice(32)],
    [],
    ['Component', 'Name', 'Type', 'Amount'],
    ...lines.map((l) => [l.code, l.name, HEAD_LABEL[l.head_type] ?? l.head_type, shown(l.amount, m)]),
    [],
    ['Earnings', '', '', shown(f.earnings, m)],
    ['Reimbursements', '', '', shown(f.reimbursements, m)],
    ['Deductions', '', '', shown(f.deductions, m)],
    ['Net pay', '', '', shown(f.net, m)],
    ['Employer contributions', '', '', shown(f.employer_contributions, m)],
    [],
    ['Notice', 'Publication of this payslip does not imply payment or statutory filing. Paid amounts are only those confirmed from payment evidence.'],
  ];
  return pdfDocument(rows, PDF_COLUMNS);
}

const fileNameOf = (f: Facts) => `payslip-${f.period_code}-${f.employee_code}-v${f.output_version}.pdf`.replace(/[^A-Za-z0-9._-]/g, '_');

/** One bounded chunk of the job: up to `size` payslips after `cursor` (employee code, output id), each rendered and stored once. */
export async function edocChunk(tx: Queryable, grant: AccessGrant, month: string, totals: EdocTotals, cursor: string | null, size: number, jobId: string): Promise<ChunkOutcome & { totals: EdocTotals }> {
  const p = new SqlParams();
  const where = issuedWhere(grant, p, month);
  const after = cursor ? (JSON.parse(cursor) as [string, string]) : null;
  const keyset = after ? `and (e.employee_code, o.id::text) > (${p.add(after[0])}, ${p.add(after[1])})` : '';
  const batch = (
    await tx.query<Facts>(
      `select o.id as output_id, o.employee_id, e.employee_code, e.display_name, o.content_hash, o.output_version,
              to_char(hrms_business_date(o.company_id, o.issued_at), 'YYYY-MM-DD') as issued_on, r.id as record_id,
              p.period_code, p.financial_year, to_char(p.service_start, 'YYYY-MM-DD') as service_start, to_char(p.service_end, 'YYYY-MM-DD') as service_end,
              to_char(p.payment_date, 'YYYY-MM-DD') as payment_date, c.code as company_code, c.name as company_name, r.currency_code, ru.currency_minor_unit as minor,
              r.days_in_month, r.paid_units::text as paid_units, r.earnings::text as earnings, r.reimbursements::text as reimbursements, r.deductions::text as deductions,
              r.net::text as net, r.employer_contributions::text as employer_contributions
         from employee_issued_output o
         join employee e on e.company_id = o.company_id and e.id = o.employee_id
         join payroll_period p on p.company_id = o.company_id and p.id = o.period_id
         join payroll_record r on r.company_id = o.company_id and r.id = o.payroll_record_id
         join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
         join company c on c.id = o.company_id
        where ${where} ${keyset}
        order by e.employee_code, o.id::text
        limit ${p.add(size)}`,
      p.values,
    )
  ).rows;
  let files = totals.files;
  for (const f of batch) {
    const pdf = await renderPayslip(tx, grant.companyId, f);
    const inserted = await tx.query(
      `insert into payroll_edoc_export_file (company_id, job_id, output_id, employee_id, file_name, content, content_sha256, issued_content_hash)
       values ($1, $2, $3, $4, $5, $6, $7, $8) on conflict (company_id, job_id, output_id) do nothing`,
      [grant.companyId, jobId, f.output_id, f.employee_id, fileNameOf(f), pdf, createHash('sha256').update(pdf).digest('hex'), f.content_hash],
    );
    files += inserted.rowCount ?? 0;
  }
  const last = batch.at(-1);
  return {
    totals: { month, files },
    result: { month, files },
    processed: batch.length,
    cursor: last ? JSON.stringify([last.employee_code, last.output_id]) : cursor,
    done: batch.length < size,
  };
}

/** Written once, with the last chunk: the export's audit record (operational counts only). */
export async function completeEdoc(tx: Queryable, grant: AccessGrant, totals: EdocTotals, jobId: string): Promise<void> {
  await auditChange(tx, grant, { resource: 'payroll_edoc_export', recordKey: jobId, action: 'EXPORT', after: { operational: { kind: EDOC_KIND, month: totals.month, files: totals.files } } });
}

/** The request's audit record (in the enqueueing transaction). */
export async function auditEdocRequest(tx: Queryable, grant: AccessGrant, jobId: string, month: string): Promise<void> {
  await auditChange(tx, grant, { resource: 'payroll_edoc_export', recordKey: jobId, action: 'REQUEST', after: { operational: { kind: EDOC_KIND, month } } });
}

export const EDOC_SCOPE_CHANGED = 'SCOPE_CHANGED';

/**
 * NFR-S09: the requester's export of the month (the same user and assignment) that is queued, running, or completed and still within its
 * download window, if any; a new request for that month answers it instead of queueing another. Takes a transaction lock on the
 * requester and month first, so two requests at once queue one job.
 */
export async function openEdocExport(tx: Queryable, grant: AccessGrant, month: string): Promise<{ jobId: string; state: string } | null> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_edoc_export:${grant.companyId}:${grant.userId}:${grant.assignmentId}:${month}`]);
  const row = (
    await tx.query<{ id: string; state: string }>(
      `select id, state from bulk_job
        where company_id = $1 and kind = $2 and requested_by = $3 and acting_assignment_id = $4 and parameters ->> 'month' = $5
          and (state in ('QUEUED', 'RUNNING') or (state = 'COMPLETED' and finished_at >= now() - make_interval(hours => $6)))
        order by created_at desc limit 1`,
      [grant.companyId, EDOC_KIND, grant.userId, grant.assignmentId, month, OUTPUT_LIFETIME_HOURS],
    )
  ).rows[0];
  return row ? { jobId: row.id, state: row.state } : null;
}

/** The largest archive a download builds (the stored PDFs of one job, in total); a larger one is refused (422 EXPORT_TOO_LARGE). */
export const EDOC_MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

/**
 * The ZIP of a completed job, for its requester only (the same user and assignment; anyone else's job reads as missing), within 24 hours
 * of completion; refused whole when anyone in it is no longer in the requester's row scope, and when its PDFs together exceed
 * `maxBytes` (the archive is built in memory). Each download is audited.
 */
export async function edocArchive(tx: Queryable, grant: AccessGrant, jobId: string, maxBytes: number = EDOC_MAX_ARCHIVE_BYTES) {
  const job = (
    await tx.query<{ state: string; requested_by: string; acting_assignment_id: string; parameters: { month: string }; expired: boolean }>(
      `select state, requested_by, acting_assignment_id, parameters, coalesce(finished_at < now() - make_interval(hours => $3), false) as expired
         from bulk_job where company_id = $1 and id = $2 and kind = $4`,
      [grant.companyId, jobId, OUTPUT_LIFETIME_HOURS, EDOC_KIND],
    )
  ).rows[0];
  if (!job || job.requested_by !== grant.userId || job.acting_assignment_id !== grant.assignmentId) throw notFound();
  if (job.state !== 'COMPLETED') throw new HttpError(409, 'NOT_READY', 'The export has not completed', { state: job.state });
  if (job.expired) throw new HttpError(410, 'EXPIRED', `The export is downloadable for ${OUTPUT_LIFETIME_HOURS} hours after it completes; request it again`);
  // The scope and the size first, without reading the PDFs (octet_length reads a stored value's size, not its bytes).
  const p = new SqlParams([grant.companyId, jobId]);
  const scope = employeeScopePredicate(grant, { company: 'f.company_id', employee: 'f.employee_id' }, p);
  const summary = (
    await tx.query<{ outside: number; bytes: string }>(
      `select count(*) filter (where not ${scope})::int as outside, coalesce(sum(octet_length(f.content)), 0)::text as bytes
         from payroll_edoc_export_file f where f.company_id = $1 and f.job_id = $2`,
      p.values,
    )
  ).rows[0]!;
  if (summary.outside > 0) throw new HttpError(409, EDOC_SCOPE_CHANGED, 'Someone in this export is no longer in your scope; request the export again');
  if (BigInt(summary.bytes) > BigInt(maxBytes)) {
    throw new HttpError(422, 'EXPORT_TOO_LARGE', `The payslips of this export together exceed ${Math.floor(maxBytes / (1024 * 1024))} MB, more than one download builds`);
  }
  const files = (
    await tx.query<{ file_name: string; content: Buffer }>(`select f.file_name, f.content from payroll_edoc_export_file f where f.company_id = $1 and f.job_id = $2 order by f.file_name`, [
      grant.companyId,
      jobId,
    ])
  ).rows;
  const content = zipStored(files.map((f) => ({ name: f.file_name, data: f.content })));
  await auditChange(tx, grant, { resource: 'payroll_edoc_export', recordKey: jobId, action: 'DOWNLOAD', after: { operational: { month: job.parameters.month, files: files.length } } });
  return { fileName: `payslips-${job.parameters.month}-edoc.zip`, content, files: files.length };
}

/** An export that never finished keeps its files this long before the purge takes them (a worker stopped part-way, say). */
export const UNFINISHED_EXPORT_DAYS = 7;

/**
 * Daily (jobs-registry.ts EDOC_PURGE): the PDFs of exports whose download window has closed are deleted, so the database holds
 * payslip PDFs only while they can be downloaded. The window is the download's own rule (finished more than OUTPUT_LIFETIME_HOURS
 * ago); an export that never finished goes after UNFINISHED_EXPORT_DAYS. The job, its counts and every audit entry stay.
 */
export async function purgeExpiredEdocFiles(db: Queryable, companyId: string): Promise<{ deleted: number }> {
  const result = await db.query(
    `delete from payroll_edoc_export_file f
       using bulk_job j
      where f.company_id = $1 and j.company_id = f.company_id and j.id = f.job_id
        and (j.finished_at < now() - make_interval(hours => $2)
             or (j.finished_at is null and f.created_at < now() - make_interval(days => $3)))`,
    [companyId, OUTPUT_LIFETIME_HOURS, UNFINISHED_EXPORT_DAYS],
  );
  return { deleted: result.rowCount ?? 0 };
}
