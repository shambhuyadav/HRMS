// Issued payslips (FR-107; DB117; H3 TN06; H7 ESS output register; CI30; BR-047; BR-053).
//
// A payslip is published from a PROCESSED_LOCKED payroll record by an authorised publisher (payroll_output.publish
// in an eligible Admin assignment; never about their own record). Publication stores the exact file as a
// confidential system-generated attachment, records its SHA-256, the version and the publisher, and never implies
// payment or statutory filing: the document states the earned (frozen) amounts and the held, reserved and paid
// position at publication, and the ESS view adds the live position from the payment ledger. A replacement is a new
// version; the earlier issue is kept, labelled SUPERSEDED. Calculation and draft previews are never served to the
// Employee: the own routes return ISSUED and SUPERSEDED outputs only, re-checking company, employee, kind and hash on
// every read (CI30). Form 16 needs the actual applicable statutory template (H8), which is not configured: it is
// reported NOT_CONFIGURED and can never be stored (database guard).
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import { type AccessGrant, OWN_ESS_ROLE_CODES } from '../access/authorize.js';
import { actorOf, assertInScope, assertNotSelf, audit, emit, requireRunScope, requireText, userIsEmployee } from '../payroll/common.js';
import { sha256 } from './bankformat.js';
import { paymentPosition } from './bank.js';

export const PAYSLIP_FORMAT = 'HRMS_PAYSLIP_JSON_V1';
/** Records published per call (CP-08 bounded work; an engineering bound). */
export const PUBLISH_CHUNK = 200;

/** The caller's own employee; own issued outputs are served only in the Employee OWN context (BR-055, H1). */
export function ownEmployee(grant: AccessGrant): string {
  if (!OWN_ESS_ROLE_CODES.includes(grant.roleCode) || grant.scopeKind !== 'OWN' || !grant.linkedEmployeeId) {
    throw new HttpError(403, 'EMPLOYEE_CONTEXT_REQUIRED', 'Select your Employee role to see your own payroll documents');
  }
  return grant.linkedEmployeeId;
}

interface RecordFacts {
  id: string;
  employee_id: string;
  employee_code: string;
  display_name: string;
  run_id: string;
  run_state: string;
  run_revision: number;
  lock_version: number | null;
  period_id: string;
  period_code: string;
  financial_year: string;
  service_start: string;
  service_end: string;
  payment_date: string;
  company_code: string;
  company_name: string;
  calculation_status: string;
  frozen: boolean;
  currency_code: string;
  days_in_month: number;
  paid_units: string | null;
  earnings: string | null;
  reimbursements: string | null;
  gross: string | null;
  deductions: string | null;
  net: string | null;
  employer_contributions: string | null;
}

const FACTS = `select r.id, r.employee_id, r.employee_code, e.display_name, r.run_id, ru.state as run_state, ru.revision as run_revision, ru.lock_version,
    ru.period_id, p.period_code, p.financial_year, to_char(p.service_start, 'YYYY-MM-DD') as service_start, to_char(p.service_end, 'YYYY-MM-DD') as service_end,
    to_char(p.payment_date, 'YYYY-MM-DD') as payment_date, c.code as company_code, c.name as company_name, r.calculation_status, r.frozen_at is not null as frozen,
    r.currency_code, r.days_in_month, r.paid_units::text as paid_units, r.earnings::text as earnings, r.reimbursements::text as reimbursements, r.gross::text as gross,
    r.deductions::text as deductions, r.net::text as net, r.employer_contributions::text as employer_contributions
  from payroll_record r
  join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
  join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
  join employee e on e.company_id = r.company_id and e.id = r.employee_id
  join company c on c.id = r.company_id`;

async function payslipContent(db: Queryable, companyId: string, f: RecordFacts, version: number) {
  const lines = (
    await db.query<{ componentCode: string; componentName: string; headType: string; amount: string }>(
      `select pc.code as "componentCode", pc.name as "componentName", l.head_type as "headType", l.amount::text as amount
         from payroll_line l join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id
         left join payroll_head_revision hr on hr.company_id = l.company_id and hr.id = l.head_revision_id
        where l.company_id = $1 and l.record_id = $2
        order by case l.head_type when 'EARNING' then 1 when 'REIMBURSEMENT' then 2 when 'DEDUCTION' then 3 else 4 end, hr.display_sequence nulls last, pc.code`,
      [companyId, f.id],
    )
  ).rows;
  // P8a gap 4 (I-85, I-90): how each statutory deduction and employer contribution was worked out (the pack revision, wages, rates,
  // ceilings, coverage, state, or the TDS projection), exactly as the calculation recorded it; NOT_APPLICABLE ones say why.
  const statutory = (
    await db.query<{ componentCode: string; componentName: string; status: string; amount: string | null; workings: Record<string, unknown> }>(
      `select pc.code as "componentCode", pc.name as "componentName", s.status, s.amount::text as amount, s.workings
         from payroll_record_statutory s join pay_component pc on pc.company_id = s.company_id and pc.id = s.component_id
        where s.company_id = $1 and s.record_id = $2 order by pc.code`,
      [companyId, f.id],
    )
  ).rows;
  const position = await paymentPosition(db, companyId, f.id);
  const doc = {
    document: 'PAYSLIP',
    format: PAYSLIP_FORMAT,
    company: { code: f.company_code, name: f.company_name },
    employee: { code: f.employee_code, name: f.display_name },
    period: { code: f.period_code, financialYear: f.financial_year, serviceStart: f.service_start, serviceEnd: f.service_end, paymentDate: f.payment_date },
    payrollRun: { id: f.run_id, revision: f.run_revision, lockVersion: f.lock_version },
    version,
    currencyCode: f.currency_code,
    paidDays: f.paid_units,
    daysInMonth: f.days_in_month,
    lines,
    statutory,
    totals: { earnings: f.earnings, reimbursements: f.reimbursements, gross: f.gross, deductions: f.deductions, net: f.net, employerContributions: f.employer_contributions },
    // FR-107 / TN06: earned is the frozen liability; held, reserved and paid come from the hold and payment ledgers.
    paymentAtPublication: { earned: position.earned, held: position.held, reserved: position.reserved, paid: position.paid },
    notices: ['Publication of this payslip does not imply payment or statutory filing.', 'Paid amounts are only those confirmed from payment evidence.'],
  };
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/** HR preview of a payslip (labelled not issued; never available to the Employee). */
export async function previewPayslip(db: Queryable, grant: AccessGrant, recordId: string) {
  const f = (await db.query<RecordFacts>(`${FACTS} where r.company_id = $1 and r.id = $2`, [grant.companyId, recordId])).rows[0];
  if (!f) throw notFound();
  await assertInScope(db, grant, f.employee_id);
  assertNotSelf(grant, f.employee_id);
  if (f.calculation_status !== 'CALCULATED') throw new HttpError(409, 'NOT_CALCULATED', 'Only a calculated record has a payslip');
  return { label: 'PREVIEW_NOT_ISSUED', issued: false, content: JSON.parse((await payslipContent(db, grant.companyId, f, 0)).toString('utf8')) as unknown };
}

async function storeOutput(tx: Queryable, files: FileStore, grant: AccessGrant, f: RecordFacts, version: number, supersedes: { id: string; reason: string } | null) {
  const bytes = await payslipContent(tx, grant.companyId, f, version);
  const contentHash = sha256(bytes);
  const stored = await files.put(grant.companyId, bytes);
  const fileName = `payslip-${f.period_code}-${f.employee_code}-v${version}.json`;
  const attachmentId = (
    await tx.query<{ id: string }>(
      `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size, created_by, updated_by)
       values ($1, $2, $3, $4, 'application/json', $5, 'CONFIDENTIAL', $6, $7, $2, $2) returning id`,
      [grant.companyId, grant.userId, f.employee_id, stored.reference, stored.checksum, fileName, stored.byteSize],
    )
  ).rows[0]!.id;
  if (supersedes) {
    await tx.query(`update employee_issued_output set publication_state = 'SUPERSEDED', superseded_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
      grant.companyId,
      supersedes.id,
      grant.userId,
    ]);
  }
  const id = (
    await tx.query<{ id: string }>(
      `insert into employee_issued_output (company_id, employee_id, kind, period_id, period_code, output_version, payroll_record_id, run_id, publication_state,
                                           attachment_id, content_hash, file_name, issued_at, issued_by, issued_assignment_id, supersedes_output_id, supersession_reason,
                                           created_by, updated_by)
       values ($1, $2, 'PAYSLIP', $3, $4, $5, $6, $7, 'ISSUED', $8, $9, $10, now(), $11, $12, $13, $14, $11, $11) returning id`,
      [grant.companyId, f.employee_id, f.period_id, f.period_code, version, f.id, f.run_id, attachmentId, contentHash, fileName, grant.userId, grant.assignmentId, supersedes?.id ?? null, supersedes?.reason ?? null],
    )
  ).rows[0]!.id;
  await audit(
    tx,
    actorOf(grant),
    'employee_issued_output',
    id,
    supersedes ? 'REISSUE' : 'PUBLISH',
    null,
    { operational: { kind: 'PAYSLIP', periodCode: f.period_code, employeeCode: f.employee_code, version, contentHash, supersedesOutputId: supersedes?.id ?? null } },
    supersedes?.reason ?? null,
  );
  await emit(tx, grant.companyId, 'payroll_output.published', id, id, { outputId: id });
  return id;
}

/**
 * Publishes the payslips of a processed run that have none yet, a bounded chunk per call (CP-08): `remaining` > 0
 * means call again. The publisher's own record is never published by them (left for another publisher).
 */
export async function publishRunPayslips(tx: Queryable, files: FileStore, grant: AccessGrant, runId: string) {
  const run = (await tx.query<{ state: string }>(`select state from payroll_run where company_id = $1 and id = $2`, [grant.companyId, runId])).rows[0];
  if (!run) throw notFound();
  await requireRunScope(tx, grant, runId);
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_payslips:${grant.companyId}:${runId}`]);
  await reassertAccess(tx, grant, 'payroll_output', 'publish', ['amount']);
  if (run.state !== 'PROCESSED_LOCKED') throw new HttpError(409, 'RUN_NOT_PROCESSED', 'Payslips are published from PROCESSED_LOCKED payroll only');
  const pendingWhere = `r.company_id = $1 and r.run_id = $2 and r.calculation_status = 'CALCULATED' and r.frozen_at is not null
      and not exists (select 1 from employee_issued_output o where o.company_id = r.company_id and o.payroll_record_id = r.id and o.kind = 'PAYSLIP')
      and not exists (select 1 from user_employee_link u where u.company_id = r.company_id and u.user_id = $3 and u.employee_id = r.employee_id)`;
  const batch = (await tx.query<RecordFacts>(`${FACTS} where ${pendingWhere} order by r.employee_code, r.id limit ${PUBLISH_CHUNK}`, [grant.companyId, runId, grant.userId])).rows;
  const ids: string[] = [];
  for (const f of batch) ids.push(await storeOutput(tx, files, grant, f, 1, null));
  const remaining = (await tx.query<{ n: number }>(`select count(*)::int as n from payroll_record r where ${pendingWhere}`, [grant.companyId, runId, grant.userId])).rows[0]!.n;
  const ownSkipped = (
    await tx.query<{ n: number }>(
      `select count(*)::int as n from payroll_record r
        where r.company_id = $1 and r.run_id = $2 and r.calculation_status = 'CALCULATED'
          and not exists (select 1 from employee_issued_output o where o.company_id = r.company_id and o.payroll_record_id = r.id and o.kind = 'PAYSLIP')
          and exists (select 1 from user_employee_link u where u.company_id = r.company_id and u.user_id = $3 and u.employee_id = r.employee_id)`,
      [grant.companyId, runId, grant.userId],
    )
  ).rows[0]!.n;
  return { runId, published: ids.length, remaining, ownRecordLeftForAnotherPublisher: ownSkipped, done: remaining === 0 };
}

/** An authorised replacement version: the earlier issue stays retrievable, labelled SUPERSEDED. */
export async function reissuePayslip(tx: Queryable, files: FileStore, grant: AccessGrant, outputId: string, input: { reason: string; expectedVersion: number }) {
  const o = (
    await tx.query<{ id: string; employee_id: string; payroll_record_id: string; output_version: number; publication_state: string; version: number }>(
      `select id, employee_id, payroll_record_id, output_version, publication_state, version from employee_issued_output where company_id = $1 and id = $2 and kind = 'PAYSLIP' for update`,
      [grant.companyId, outputId],
    )
  ).rows[0];
  if (!o) throw notFound();
  await assertInScope(tx, grant, o.employee_id);
  await reassertAccess(tx, grant, 'payroll_output', 'publish', ['amount']);
  assertNotSelf(grant, o.employee_id);
  if (await userIsEmployee(tx, grant.companyId, grant.userId, o.employee_id)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot publish your own payslip');
  if (o.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (o.publication_state !== 'ISSUED') throw new HttpError(409, 'INVALID_STATE', 'Only the current issued version is replaced');
  const reason = requireText(input.reason, 'reason', 1000);
  const f = (await tx.query<RecordFacts>(`${FACTS} where r.company_id = $1 and r.id = $2`, [grant.companyId, o.payroll_record_id])).rows[0]!;
  const id = await storeOutput(tx, files, grant, f, o.output_version + 1, { id: o.id, reason });
  return outputDetail(tx, grant.companyId, id);
}

const OUTPUT_VIEW = `select o.id, o.employee_id as "employeeId", e.employee_code as "employeeCode", o.kind, o.period_id as "periodId", o.period_code as "periodCode",
    o.output_version as "version", o.publication_state as "publicationState", o.payroll_record_id as "recordId", o.run_id as "runId", o.content_hash as "contentHash",
    o.file_name as "fileName", o.issued_at as "issuedAt", o.supersedes_output_id as "supersedesOutputId", o.superseded_at as "supersededAt", o.version as "rowVersion"
  from employee_issued_output o join employee e on e.company_id = o.company_id and e.id = o.employee_id`;

async function outputDetail(db: Queryable, companyId: string, id: string) {
  return (await db.query(`${OUTPUT_VIEW} where o.company_id = $1 and o.id = $2`, [companyId, id])).rows[0]!;
}

/** Issued outputs of a run within the caller's row scope. */
export async function listRunOutputs(db: Queryable, grant: AccessGrant, runId: string) {
  await requireRunScope(db, grant, runId);
  return { items: (await db.query(`${OUTPUT_VIEW} where o.company_id = $1 and o.run_id = $2 order by e.employee_code, o.output_version`, [grant.companyId, runId])).rows };
}

async function readFile(db: Queryable, files: FileStore, companyId: string, o: { attachment_id: string; content_hash: string; employee_id: string }) {
  const a = (await db.query<{ content_reference: string; employee_id: string }>(`select content_reference, employee_id from attachment where company_id = $1 and id = $2`, [companyId, o.attachment_id])).rows[0];
  // CI30: the stored file is bound to the output's employee and hash; anything else is refused.
  if (!a || a.employee_id !== o.employee_id) throw notFound();
  const bytes = await files.get(a.content_reference);
  if (sha256(bytes) !== o.content_hash) throw new HttpError(409, 'FILE_INTEGRITY_FAILED', 'The stored file does not match its recorded hash');
  return bytes;
}

interface OutputRow {
  id: string;
  employee_id: string;
  attachment_id: string;
  content_hash: string;
  file_name: string;
  publication_state: string;
  kind: string;
  period_code: string;
}

/** HR download of an issued payslip (row scope; never one's own record in an admin context). */
export async function outputFile(db: Queryable, files: FileStore, grant: AccessGrant, outputId: string) {
  const o = (
    await db.query<OutputRow>(`select id, employee_id, attachment_id, content_hash, file_name, publication_state, kind, period_code from employee_issued_output where company_id = $1 and id = $2`, [
      grant.companyId,
      outputId,
    ])
  ).rows[0];
  if (!o) throw notFound();
  await assertInScope(db, grant, o.employee_id);
  assertNotSelf(grant, o.employee_id);
  const bytes = await readFile(db, files, grant.companyId, o);
  await audit(db, actorOf(grant), 'employee_issued_output', o.id, 'DOWNLOAD', null, { operational: { contentHash: o.content_hash } });
  return { fileName: o.file_name, mediaType: 'application/json', bytes };
}

// ---------------------------------------------------------------------------------------------------------------
// Employee OWN (H3 TN06)
// ---------------------------------------------------------------------------------------------------------------

export async function ownPayslips(db: Queryable, grant: AccessGrant) {
  const employeeId = ownEmployee(grant);
  const rows = (
    await db.query<{ id: string; periodCode: string; version: number; publicationState: string; issuedAt: Date; recordId: string; supersededAt: Date | null }>(
      `select o.id, o.period_code as "periodCode", o.output_version as version, o.publication_state as "publicationState", o.issued_at as "issuedAt",
              o.payroll_record_id as "recordId", o.superseded_at as "supersededAt"
         from employee_issued_output o
        where o.company_id = $1 and o.employee_id = $2 and o.kind = 'PAYSLIP' and o.publication_state in ('ISSUED', 'SUPERSEDED')
        order by o.period_code desc, o.output_version desc`,
      [grant.companyId, employeeId],
    )
  ).rows;
  const items = [];
  for (const r of rows) {
    // TN06: earned, held and paid are distinct; paid is only what confirmed payment evidence shows.
    const p = r.publicationState === 'ISSUED' ? await paymentPosition(db, grant.companyId, r.recordId) : null;
    items.push({
      id: r.id,
      periodCode: r.periodCode,
      version: r.version,
      publicationState: r.publicationState,
      label: r.publicationState === 'SUPERSEDED' ? 'REPLACED' : 'CURRENT',
      issuedAt: r.issuedAt,
      supersededAt: r.supersededAt,
      payment: p ? { earned: p.earned, held: p.held, reserved: p.reserved, paid: p.paid } : null,
    });
  }
  return { items, form16: { status: 'NOT_CONFIGURED', code: 'FORM16_TEMPLATE_NOT_CONFIGURED' } };
}

/**
 * H7 "employee sees own permitted reason/status" (TN06): the payment status of the employee's own held salary — the
 * period, ON_HOLD or RELEASED and the dates — exactly the holds the employee is told about (PAYROLL_HOLD_STATUS: on hold
 * once approved or placed by processing, released). A proposal not yet decided, a rejected or withdrawn proposal never
 * held anything and is not shown; a hold whose review date passed is still ON_HOLD (expiry pays nothing). No kind,
 * reason, criterion, release criterion, evidence, actor or amount: which reason text an employee may see is an owner
 * decision (docs/03 I-40 item 8), and the held amount is already on the payslip.
 */
const OWN_HOLD_VIEW = `select h.id, p.period_code as "periodCode", to_char(p.service_start, 'YYYY-MM-DD') as "serviceStart", to_char(p.service_end, 'YYYY-MM-DD') as "serviceEnd",
    case when h.state = 'RELEASED' then 'RELEASED' else 'ON_HOLD' end as state, to_char(h.effective_date, 'YYYY-MM-DD') as "heldFrom", h.released_at as "releasedAt",
    p.service_start as hrms_service_start
  from payroll_hold h
  join payroll_run ru on ru.company_id = h.company_id and ru.id = h.run_id
  join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
 where h.company_id = $1 and h.employee_id = $2 and h.state in ('APPROVED_ACTIVE', 'EXPIRED_REVIEW', 'RELEASED')`;

/** Own holds answered without page/pageSize. */
export const OWN_HOLD_LIST_CAP = 200;

export async function ownHoldStatus(db: Queryable, grant: AccessGrant, paging: Paging = {}) {
  const employeeId = ownEmployee(grant);
  return pageOf(db, OWN_HOLD_VIEW, [grant.companyId, employeeId], 'hrms_service_start desc, "heldFrom" desc, id', paging, OWN_HOLD_LIST_CAP);
}

export async function ownHoldStatusDetail(db: Queryable, grant: AccessGrant, holdId: string) {
  const employeeId = ownEmployee(grant);
  const row = (await db.query<Record<string, unknown>>(`${OWN_HOLD_VIEW} and h.id = $3`, [grant.companyId, employeeId, holdId])).rows[0];
  // Another employee's hold, a proposal or a crafted id reads as missing.
  if (!row) throw notFound();
  const { hrms_service_start: _sort, ...hold } = row;
  return hold;
}

export async function ownPayslipFile(db: Queryable, files: FileStore, grant: AccessGrant, outputId: string) {
  const employeeId = ownEmployee(grant);
  const o = (
    await db.query<OutputRow>(
      `select id, employee_id, attachment_id, content_hash, file_name, publication_state, kind, period_code from employee_issued_output
        where company_id = $1 and id = $2 and employee_id = $3 and kind = 'PAYSLIP' and publication_state in ('ISSUED', 'SUPERSEDED')`,
      [grant.companyId, outputId, employeeId],
    )
  ).rows[0];
  // Another employee's output, a crafted id or anything not issued reads as missing.
  if (!o) throw notFound();
  const bytes = await readFile(db, files, grant.companyId, o);
  await audit(db, actorOf(grant), 'employee_issued_output', o.id, 'OWN_DOWNLOAD', null, { operational: { contentHash: o.content_hash } });
  return { fileName: o.file_name, mediaType: 'application/json', bytes };
}
