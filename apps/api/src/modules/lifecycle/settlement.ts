// Full-and-final settlement records (FR-052, FR-053, FR-054; DB079; DB080; F1; BR-016; DF02; DF03; DF05; DF07; DF09).
// FR-054 outputs (CSV, XLSX, PDF, ZIP of a selection) and the bulk upload's row checks are at the end of this file.
// FR-052 calculation (I-88, decided under owner delegation, 6 Nov 2026): the preparer calculates a draft from a versioned snapshot
// (settlement-calculation.ts); its values are CALCULATED lines carrying the snapshot, and lines for other components are entered with a
// reason (a revision without a calculation keeps the entered or uploaded lines it always had, status NOT_CONFIGURED). The approval is
// refused while a blocking item, an applicable statutory rule pack, or an eligible employee's missing gratuity calculation stands
// (settlement-gates.ts). Lines are entered or uploaded by the authorised preparer (an eligible, granted HR
// Administrator assignment; amounts are a confidential group). Lines reference pay components; amounts are signed
// (earnings >= 0, deductions <= 0) and the net amount equals their sum. Submission freezes the revision; an
// independent reviewer and then an independent approver decide (neither the preparer, nor each other, nor the
// employee); a returned or rejected revision is corrected through a new revision. Release eligibility is a further
// explicit step by someone independent of all of them, after the exit clearance is complete; it never creates,
// records or implies a payment.
import { enqueueEvent } from '../../audit/audit.js';
import { type Paging, pageMeta, pageOf, type Sorting, sortedBy } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { ScanVerdict } from '../../storage/scan.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { CsvError, parseCsv } from '../employee/csv.js';
import { ledgerBalances } from '../leave/service.js';
import { requireVerifiedEvidence } from '../payroll/common.js';
import { outstandingLoans } from '../payroll-outputs/loans.js';
import { isModuleActive } from '../registry.js';
import { fileContext, type ReportContext } from '../report/context.js';
import { PDF_MEDIA_TYPE, type PdfColumn, pdfDocument } from '../report/pdf.js';
import { PLAIN_DECIMAL, type SheetCell, XLSX_MEDIA_TYPE, xlsxWorkbook, zipStored } from '../report/xlsx.js';
import { applyCasesPaidBySettlement } from '../payroll-adjustments/settled.js';
import { cancelActiveApproval, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import {
  type Actor,
  actorOf,
  advisoryLock,
  assertNotSelf,
  audit,
  decidersOf,
  decisionTrail,
  holds,
  isIsoDate,
  isSelf,
  priorDecision,
  setRootState,
  taskIsPending,
  taskTransaction,
  userIsEmployee,
} from './common.js';
import { clearanceStatus, lockClearance } from './processes.js';
import { assertApprovable, assertCalculationStillHolds, calculationView, encashOnPayment, noticeWaiverOf } from './settlement-gates.js';

export const SETTLEMENT_KIND = 'settlement';
export const SETTLEMENT_APPROVAL_KIND = 'settlement_approval';
export const UPLOAD_TEMPLATE = 'SETTLEMENT_LINES_V1';
/** The exact header an upload must carry (served as the published template, GET /settlements/lines/template). */
export const UPLOAD_HEADER = ['employee_code', 'last_working_date', 'component_code', 'amount', 'line_kind'] as const;
const MAX_UPLOAD_ROWS = 10_000;
const AMOUNT = /^-?\d{1,15}(\.\d{1,4})?$/;
const ZERO = /^-?0+(\.0+)?$/;
/** Revisions that keep an exit's settlement live (the settlement_one_live index). */
const LIVE_STATES = ['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE'];

/** FR-052 (I-88): what the calculation does; anything it needs and lacks is reported on its item and blocks approval, never guessed. */
export const CALCULATION_STATUS = {
  status: 'AVAILABLE',
  reason:
    'A draft is calculated from a versioned snapshot under the settlement policy and the statutory rule packs in force on the last working date (F1, DF05: no gratuity, encashment, notice or tax rule is assumed). An item whose policy, rule pack or record is missing is shown as such and blocks approval. Lines for other components are entered with a reason; review and approval stay independent.',
} as const;

export interface SettlementRow {
  id: string;
  exit_case_id: string;
  employee_id: string;
  transaction_id: string;
  revision: number;
  state: string;
  currency_code: string;
  net_amount: string;
  prepared_by: string;
  supersedes_settlement_id: string | null;
  calculation_id: string | null;
  version: number;
}

const COLUMNS = `s.id, s.exit_case_id, s.employee_id, s.transaction_id, s.revision, s.state, s.currency_code, s.net_amount, s.prepared_by, s.supersedes_settlement_id, s.calculation_id, s.version`;

export interface LineInput {
  componentCode: string;
  amount: string;
  lineKind?: 'STANDARD' | 'NOTICE_ADJUSTMENT' | undefined;
  /** Why the line is entered; required on a calculated revision (I-88), where entered lines are for components the calculation does not produce. */
  reason?: string | undefined;
}

async function lockSettlement(tx: Queryable, grant: AccessGrant, id: string): Promise<SettlementRow> {
  const t = (await tx.query<{ transaction_id: string; employee_id: string }>(`select transaction_id, employee_id from settlement where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!t || !(await canAccessEmployee(tx, grant, t.employee_id))) throw notFound();
  await lockTransaction(tx, t.transaction_id);
  return (await tx.query<SettlementRow>(`select ${COLUMNS} from settlement s where s.company_id = $1 and s.id = $2 for update`, [grant.companyId, id])).rows[0]!;
}

function assertPreparer(grant: AccessGrant, s: SettlementRow): void {
  if (s.prepared_by !== grant.userId) throw new HttpError(403, 'NOT_PREPARER', 'Only the preparer of this revision can change or submit it');
}

async function exitFor(tx: Queryable, companyId: string, exitCaseId: string) {
  return (
    await tx.query<{
      id: string;
      employee_id: string;
      transaction_id: string;
      state: string;
      approved_leaving_date: string | null;
      contractual_notice_days: number | null;
      employee_code: string;
    }>(
      `select x.id, x.employee_id, x.transaction_id, x.state, to_char(x.approved_leaving_date, 'YYYY-MM-DD') as approved_leaving_date, x.contractual_notice_days, e.employee_code
         from exit_case x join employee e on e.company_id = x.company_id and e.id = x.employee_id where x.company_id = $1 and x.id = $2`,
      [companyId, exitCaseId],
    )
  ).rows[0];
}

const approvedExit = (state: string | undefined) => state === 'APPROVED' || state === 'SEPARATED';

// ---------------------------------------------------------------------------------------------------------------
// Preparation
// ---------------------------------------------------------------------------------------------------------------

export async function createSettlement(tx: Queryable, grant: AccessGrant, exitCaseId: string, input: { currencyCode?: string | undefined }) {
  const target = await exitFor(tx, grant.companyId, exitCaseId);
  if (!target || !(await canAccessEmployee(tx, grant, target.employee_id))) throw notFound();
  assertNotSelf(grant, target.employee_id);
  // Serialised with the exit's own changes (an approved withdrawal checks for a live settlement under this lock).
  await lockTransaction(tx, target.transaction_id);
  await advisoryLock(tx, `settlement:${grant.companyId}:${exitCaseId}`);
  // Confidential money values: the preparation grant is checked again after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'settlement', 'prepare', ['amount']);
  const exit = (await exitFor(tx, grant.companyId, exitCaseId))!;
  if (!approvedExit(exit.state)) throw new HttpError(409, 'EXIT_NOT_APPROVED', 'A settlement is prepared for an approved exit');
  const revisions = (
    await tx.query<{ id: string; revision: number; state: string; currency_code: string }>(
      `select id, revision, state, currency_code from settlement where company_id = $1 and exit_case_id = $2 order by revision desc`,
      [grant.companyId, exitCaseId],
    )
  ).rows;
  if (revisions.some((r) => LIVE_STATES.includes(r.state))) {
    throw new HttpError(409, 'SETTLEMENT_EXISTS', 'This exit already has a live settlement revision');
  }
  if (revisions.some((r) => r.state === 'PAID')) throw new HttpError(409, 'SETTLEMENT_PAID', 'This exit’s settlement has been paid; nothing more is prepared for it');
  const predecessor = revisions[0];
  const currency = input.currencyCode ?? predecessor?.currency_code;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) throw new HttpError(422, 'CURRENCY_REQUIRED', 'Give the settlement currency (ISO 4217 code)');
  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'DRAFT', $4, $4) returning id`,
      [grant.companyId, SETTLEMENT_KIND, exit.employee_id, grant.userId],
    )
  ).rows[0]!.id;
  const revision = (predecessor?.revision ?? 0) + 1;
  const id = (
    await tx.query<{ id: string }>(
      `insert into settlement (company_id, exit_case_id, employee_id, revision, transaction_id, state, currency_code, supersedes_settlement_id, prepared_by, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'DRAFT', $6, $7, $8, $8, $8) returning id`,
      [grant.companyId, exitCaseId, exit.employee_id, revision, transactionId, currency, predecessor?.id ?? null, grant.userId],
    )
  ).rows[0]!.id;
  let copied = 0;
  if (predecessor && predecessor.currency_code === currency) {
    // DF03: the correction starts from the returned or rejected revision's entered lines (active components only), with their reasons.
    // Calculated lines are not copied: the new revision is calculated again from a new snapshot (I-88).
    copied =
      (
        await tx.query(
          `insert into settlement_line (company_id, settlement_id, component_id, amount, line_kind, source, reason, created_by, updated_by)
           select l.company_id, $3, l.component_id, l.amount, l.line_kind, 'COPIED', l.reason, $4, $4
             from settlement_line l join pay_component c on c.company_id = l.company_id and c.id = l.component_id and c.active
            where l.company_id = $1 and l.settlement_id = $2 and l.source <> 'CALCULATED'`,
          [grant.companyId, predecessor.id, id, grant.userId],
        )
      ).rowCount ?? 0;
    await refreshNet(tx, grant, id);
  }
  await audit(tx, actorOf(grant), 'settlement', id, 'CREATE', null, {
    operational: { exitCaseId, revision, currencyCode: currency, supersedes: predecessor?.id ?? null, copiedLines: copied, calculationStatus: CALCULATION_STATUS.status },
  });
  return settlementDetail(tx, grant, id);
}

export async function refreshNet(tx: Queryable, grant: AccessGrant, id: string): Promise<void> {
  await tx.query(
    `update settlement s set net_amount = coalesce((select sum(l.amount) from settlement_line l where l.company_id = s.company_id and l.settlement_id = s.id), 0), updated_by = $3
      where s.company_id = $1 and s.id = $2`,
    [grant.companyId, id, grant.userId],
  );
}

export interface CheckedLine {
  componentId: string;
  componentCode: string;
  amount: string;
  lineKind: 'STANDARD' | 'NOTICE_ADJUSTMENT';
  reason?: string | null;
}

/**
 * FR-052 "no component already paid in monthly payroll is paid again in settlement" (docs/03 I-81 item 5; decided under owner
 * delegation, 6 Nov 2026). Already paid means: an earning or reimbursement line above zero of the employee's payroll record that
 * covers the approved last working date (its eligible days run through that date), in a run that is approved for payment or
 * processed (APPROVED, PROCESSED_LOCKED). It blocks, never warns: a settlement line above zero on such a component is refused when
 * entered or uploaded, and every later step (submission, release eligibility, the recorded payment) checks again, so a final-period
 * run approved after the lines were entered stops the settlement until a corrected revision is prepared. Deductions are not
 * "paid" and are left to their own rules (a loan recovery is bounded by the outstanding balance, I-51). A run still being
 * calculated or reviewed pays nothing yet and is only shown (finalPeriodPayroll). Component ids, mapped to their codes.
 */
export async function componentsPaidInFinalPayroll(db: Queryable, companyId: string, employeeId: string, lastWorkingDate: string | null): Promise<Map<string, string>> {
  if (!lastWorkingDate || !isModuleActive('payroll')) return new Map();
  const rows = (
    await db.query<{ component_id: string; code: string }>(
      `select distinct pl.component_id, pc.code
         from payroll_record r
         join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id and ru.state in ('APPROVED', 'PROCESSED_LOCKED')
         join payroll_line pl on pl.company_id = r.company_id and pl.record_id = r.id and pl.amount > 0 and pl.head_type in ('EARNING', 'REIMBURSEMENT')
         join pay_component pc on pc.company_id = pl.company_id and pc.id = pl.component_id
        where r.company_id = $1 and r.employee_id = $2 and r.calculation_status = 'CALCULATED'
          and r.eligible_from <= $3::date and r.eligible_to >= $3::date`,
      [companyId, employeeId, lastWorkingDate],
    )
  ).rows;
  return new Map(rows.map((r) => [r.component_id, r.code]));
}

/** The settlement's own lines that FR-052 refuses now (see componentsPaidInFinalPayroll); 409 naming the components. */
async function assertNotPaidInPayroll(tx: Queryable, companyId: string, s: { id: string; employee_id: string; exit_case_id: string }) {
  const exit = await exitFor(tx, companyId, s.exit_case_id);
  const paid = await componentsPaidInFinalPayroll(tx, companyId, s.employee_id, exit?.approved_leaving_date ?? null);
  if (paid.size === 0) return;
  const lines = (await tx.query<{ component_id: string }>(`select component_id from settlement_line where company_id = $1 and settlement_id = $2 and amount > 0`, [companyId, s.id])).rows;
  const repeated = lines.filter((l) => paid.has(l.component_id)).map((l) => paid.get(l.component_id)!).sort();
  if (repeated.length > 0) {
    throw new HttpError(409, 'ALREADY_PAID_IN_PAYROLL', 'Monthly payroll for the final period already pays these components; prepare a corrected revision', { components: repeated });
  }
}

/**
 * The employee's payroll for the final period, read-only beside the settlement (FR-052 "reconcile to salary"): each run whose record
 * covers the last working date, with its state and the components it pays or deducts, and whether they count as already paid.
 * Payroll amounts stay with the payroll grants (DF02), so none is shown here.
 */
async function finalPeriodPayroll(db: Queryable, companyId: string, employeeId: string, lastWorkingDate: string | null) {
  if (!lastWorkingDate || !isModuleActive('payroll')) return [];
  const rows = (
    await db.query<{ run_id: string; period_code: string; run_state: string; revision: number; component_code: string; head_type: string }>(
      `select ru.id as run_id, p.period_code, ru.state as run_state, ru.revision, pc.code as component_code, pl.head_type
         from payroll_record r
         join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id and ru.state not in ('CANCELLED', 'RETURNED')
         join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
         join payroll_line pl on pl.company_id = r.company_id and pl.record_id = r.id and pl.amount > 0
         join pay_component pc on pc.company_id = pl.company_id and pc.id = pl.component_id
        where r.company_id = $1 and r.employee_id = $2 and r.calculation_status = 'CALCULATED'
          and r.eligible_from <= $3::date and r.eligible_to >= $3::date
        order by p.period_code, ru.revision, pc.code`,
      [companyId, employeeId, lastWorkingDate],
    )
  ).rows;
  const runs = new Map<string, { runId: string; periodCode: string; runState: string; revision: number; components: { componentCode: string; headType: string; alreadyPaid: boolean }[] }>();
  for (const r of rows) {
    const run = runs.get(r.run_id) ?? { runId: r.run_id, periodCode: r.period_code, runState: r.run_state, revision: r.revision, components: [] };
    run.components.push({
      componentCode: r.component_code,
      headType: r.head_type,
      alreadyPaid: (r.run_state === 'APPROVED' || r.run_state === 'PROCESSED_LOCKED') && (r.head_type === 'EARNING' || r.head_type === 'REIMBURSEMENT'),
    });
    runs.set(r.run_id, run);
  }
  return [...runs.values()];
}

/** Validates one line; returns an error code or the checked line. `paidInPayroll`: FR-052, see componentsPaidInFinalPayroll. */
async function checkLine(
  tx: Queryable,
  companyId: string,
  components: Map<string, { id: string; kind: string } | null>,
  noticeRecorded: boolean,
  line: { componentCode: string; amount: string; lineKind: string },
  paidInPayroll: ReadonlyMap<string, string> = new Map(),
): Promise<CheckedLine | { error: string }> {
  const code = line.componentCode.trim().toUpperCase();
  if (!components.has(code)) {
    const c = (await tx.query<{ id: string; kind: string }>(`select id, component_kind as kind from pay_component where company_id = $1 and code = $2 and active`, [companyId, code])).rows[0];
    components.set(code, c ?? null);
  }
  const component = components.get(code);
  if (!component) return { error: 'UNKNOWN_COMPONENT' };
  const amount = line.amount.trim();
  if (!AMOUNT.test(amount)) return { error: 'INVALID_AMOUNT' };
  const negative = amount.startsWith('-') && !ZERO.test(amount);
  const positive = !amount.startsWith('-') && !ZERO.test(amount);
  // Sign convention (owner approval pending): earnings are zero or positive, deductions zero or negative.
  if ((component.kind === 'EARNING' && negative) || (component.kind === 'DEDUCTION' && positive)) return { error: 'SIGN_MISMATCH' };
  if (positive && paidInPayroll.has(component.id)) return { error: 'ALREADY_PAID_IN_PAYROLL' };
  const kind = line.lineKind === '' ? 'STANDARD' : line.lineKind;
  if (kind !== 'STANDARD' && kind !== 'NOTICE_ADJUSTMENT') return { error: 'INVALID_LINE_KIND' };
  // F1: a monetary notice adjustment needs the recorded contractual notice period.
  if (kind === 'NOTICE_ADJUSTMENT' && !noticeRecorded) return { error: 'NOTICE_PERIOD_NOT_RECORDED' };
  return { componentId: component.id, componentCode: code, amount, lineKind: kind };
}

/** Replaces the draft's entered (or uploaded, or copied) lines; its calculated lines stay (I-88). */
async function writeLines(tx: Queryable, grant: AccessGrant, s: SettlementRow, lines: readonly CheckedLine[], source: 'ENTERED' | 'UPLOADED') {
  await tx.query(`delete from settlement_line where company_id = $1 and settlement_id = $2 and source <> 'CALCULATED'`, [grant.companyId, s.id]);
  for (const l of lines) {
    await tx.query(
      `insert into settlement_line (company_id, settlement_id, component_id, amount, line_kind, source, reason, created_by, updated_by) values ($1, $2, $3, $4::numeric, $5, $6, $7, $8, $8)`,
      [grant.companyId, s.id, l.componentId, l.amount, l.lineKind, source, l.reason ?? null, grant.userId],
    );
  }
  await refreshNet(tx, grant, s.id);
}

/** FR-054 uploads replace a draft's lines wholesale, so a calculated draft takes entered lines (each with its reason) instead (I-88). */
function assertNotCalculated(s: SettlementRow): void {
  if (s.calculation_id) throw new HttpError(409, 'CALCULATED_REVISION', 'This draft is calculated: enter the lines of other components one by one, each with its reason');
}

/** The components the draft's calculated lines use (entered lines may not repeat them). */
async function calculatedComponents(tx: Queryable, companyId: string, settlementId: string): Promise<Set<string>> {
  return new Set((await tx.query<{ component_id: string }>(`select component_id from settlement_line where company_id = $1 and settlement_id = $2 and source = 'CALCULATED'`, [companyId, settlementId])).rows.map((r) => r.component_id));
}

export async function draftForChange(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number) {
  const s = await lockSettlement(tx, grant, id);
  assertNotSelf(grant, s.employee_id);
  assertPreparer(grant, s);
  // Every change of a draft's amounts (lines, upload, cancel, submit) re-checks the preparation grant after the locks.
  await reassertAccess(tx, grant, 'settlement', 'prepare', ['amount']);
  if (s.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision can be changed; a submitted revision is frozen');
  if (s.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The settlement changed; reload and retry');
  const exit = (await exitFor(tx, grant.companyId, s.exit_case_id))!;
  return { s, exit };
}

/**
 * Replaces the draft's entered lines with the entered set (one line per component). On a calculated draft (I-88) its calculated lines stay,
 * an entered line may not use a component the calculation produced (COMPONENT_CALCULATED), and each entered line states its reason.
 */
export async function replaceLines(tx: Queryable, grant: AccessGrant, id: string, input: { lines: LineInput[]; expectedVersion: number }) {
  const { s, exit } = await draftForChange(tx, grant, id, input.expectedVersion);
  const components = new Map<string, { id: string; kind: string } | null>();
  const paid = await componentsPaidInFinalPayroll(tx, grant.companyId, s.employee_id, exit.approved_leaving_date);
  const calculated = await calculatedComponents(tx, grant.companyId, s.id);
  const checked: CheckedLine[] = [];
  for (const [i, line] of input.lines.entries()) {
    const r = await checkLine(tx, grant.companyId, components, exit.contractual_notice_days !== null, { componentCode: line.componentCode, amount: line.amount, lineKind: line.lineKind ?? 'STANDARD' }, paid);
    if ('error' in r) throw new HttpError(422, r.error, 'A settlement line is not valid', { line: i + 1 });
    if (checked.some((c) => c.componentId === r.componentId)) throw new HttpError(422, 'DUPLICATE_COMPONENT', 'Each component appears once', { line: i + 1 });
    if (calculated.has(r.componentId)) throw new HttpError(422, 'COMPONENT_CALCULATED', 'The calculation already produces this component; it is not entered as well', { line: i + 1 });
    const reason = line.reason?.trim() ?? '';
    if (reason.length > 500) throw new HttpError(422, 'REASON_TOO_LONG', 'A line reason is at most 500 characters', { line: i + 1 });
    if (s.calculation_id && reason === '') throw new HttpError(422, 'REASON_REQUIRED', 'On a calculated settlement each entered line states why it is entered', { line: i + 1 });
    checked.push({ ...r, reason: reason === '' ? null : reason });
  }
  await writeLines(tx, grant, s, checked, 'ENTERED');
  await audit(tx, actorOf(grant), 'settlement', s.id, 'SET_LINES', null, { operational: { revision: s.revision, lineCount: checked.length, source: 'ENTERED', calculated: s.calculation_id !== null } });
  return settlementDetail(tx, grant, s.id);
}

/**
 * FR-054 / DF09 upload of a draft's lines (published template SETTLEMENT_LINES_V1). Every row must name this
 * settlement's employee and approved last working date, an active component, a valid signed amount and line kind.
 * The upload is atomic: any row error rejects the whole file (valid rows are marked BATCH_REJECTED) and
 * accepted + rejected always equals the rows read. A dry run validates without changing anything.
 */
export async function uploadLines(
  tx: Queryable,
  grant: AccessGrant,
  verdict: ScanVerdict,
  id: string,
  input: { contentBase64: string; dryRun?: boolean | undefined; expectedVersion: number },
) {
  const { s, exit } = await draftForChange(tx, grant, id, input.expectedVersion);
  assertNotCalculated(s);
  const bytes = Buffer.from(input.contentBase64, 'base64');
  // FR-106: an upload is never read before the scanner has released it (as payroll inputs); the file is not stored. The route
  // asked the scanner (scanInMemory) before this transaction opened.
  if (verdict.verdict === 'INFECTED') throw new HttpError(422, 'UPLOAD_QUARANTINED', 'The malware scan flagged the file; it was not read');
  if (verdict.verdict !== 'CLEAN') throw new HttpError(503, 'SCAN_UNAVAILABLE', 'The file could not be scanned now; nothing was saved, try again later');
  const text = bytes.toString('utf8');
  let rows: string[][];
  try {
    rows = parseCsv(text);
  } catch (e) {
    if (e instanceof CsvError) throw new HttpError(422, 'INVALID_FILE', 'The file is not valid CSV');
    throw e;
  }
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!header || header.join(',') !== UPLOAD_HEADER.join(',')) {
    throw new HttpError(422, 'INVALID_TEMPLATE', `The file must use the ${UPLOAD_TEMPLATE} header`, { expected: UPLOAD_HEADER });
  }
  const data = rows.slice(1);
  if (data.length === 0) throw new HttpError(422, 'EMPTY_FILE', 'The file has no lines');
  if (data.length > MAX_UPLOAD_ROWS) throw new HttpError(422, 'TOO_MANY_ROWS', `At most ${MAX_UPLOAD_ROWS} rows per upload`);
  const components = new Map<string, { id: string; kind: string } | null>();
  const paid = await componentsPaidInFinalPayroll(tx, grant.companyId, s.employee_id, exit.approved_leaving_date);
  const results: ({ row: number; line: CheckedLine } | { row: number; error: string })[] = [];
  for (const [i, cells] of data.entries()) {
    const row = i + 2;
    if (cells.length !== UPLOAD_HEADER.length) {
      results.push({ row, error: 'WRONG_CELL_COUNT' });
      continue;
    }
    const [employeeCode, lastWorkingDate, componentCode, amount, lineKind] = cells.map((c) => c.trim()) as [string, string, string, string, string];
    if (employeeCode.toUpperCase() !== exit.employee_code) {
      results.push({ row, error: 'EMPLOYEE_MISMATCH' });
      continue;
    }
    if (lastWorkingDate !== exit.approved_leaving_date) {
      results.push({ row, error: 'DATE_MISMATCH' });
      continue;
    }
    const r = await checkLine(tx, grant.companyId, components, exit.contractual_notice_days !== null, { componentCode, amount, lineKind: lineKind.toUpperCase() }, paid);
    if ('error' in r) {
      results.push({ row, error: r.error });
      continue;
    }
    if (results.some((x) => 'line' in x && x.line.componentId === r.componentId)) {
      results.push({ row, error: 'DUPLICATE_COMPONENT' });
      continue;
    }
    results.push({ row, line: r });
  }
  const failed = results.filter((r) => 'error' in r).length;
  const errors = results.map((r) => ('error' in r ? { row: r.row, code: r.error } : failed > 0 ? { row: r.row, code: 'BATCH_REJECTED' } : null)).filter((e) => e !== null);
  const valid = failed === 0;
  const applied = valid && input.dryRun !== true;
  if (applied) {
    await writeLines(tx, grant, s, results.map((r) => (r as { line: CheckedLine }).line), 'UPLOADED');
  }
  await audit(tx, actorOf(grant), 'settlement', s.id, input.dryRun ? 'UPLOAD_DRY_RUN' : 'UPLOAD', null, {
    operational: { template: UPLOAD_TEMPLATE, revision: s.revision, rows: data.length, accepted: valid ? data.length : 0, rejected: valid ? 0 : data.length, applied },
  });
  return {
    template: UPLOAD_TEMPLATE,
    dryRun: input.dryRun === true,
    total: data.length,
    accepted: valid ? data.length : 0,
    rejected: valid ? 0 : data.length,
    applied,
    errors,
  };
}

export async function cancelDraft(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number; reason: string }) {
  const { s } = await draftForChange(tx, grant, id, input.expectedVersion);
  await setRootState(tx, 'settlement', grant.companyId, s, 'CANCELLED', grant.userId, ', closed_at = now(), cancel_reason = $5', [input.reason.trim()]);
  await audit(tx, actorOf(grant), 'settlement', s.id, 'CANCEL', { operational: { state: 'DRAFT' } }, { operational: { state: 'CANCELLED', revision: s.revision } }, input.reason);
  return settlementDetail(tx, grant, s.id);
}

/**
 * Ends a revision that is live and not paid (docs/03 I-81 items 5 and 6): CANCELLED with its reason, its lines, decisions and
 * history kept (DF08); the open review or approval task ends with it, and so does an approval stage still waiting. Used by an
 * approved exit withdrawal (FR-051/FR-053) and by an independent approver's void (voidSettlement). Lock order as everywhere:
 * the settlement's transaction, then its approval stage's. Returns the state it left, or null when the revision was not live.
 */
export async function cancelLiveSettlement(tx: Queryable, actor: Actor, settlementId: string, reason: string): Promise<{ settlementId: string; from: string; revision: number } | null> {
  const t = (await tx.query<{ transaction_id: string }>(`select transaction_id from settlement where company_id = $1 and id = $2`, [actor.companyId, settlementId])).rows[0];
  if (!t) return null;
  await lockTransaction(tx, t.transaction_id);
  const s = (await tx.query<SettlementRow>(`select ${COLUMNS} from settlement s where s.company_id = $1 and s.id = $2 for update`, [actor.companyId, settlementId])).rows[0]!;
  if (!LIVE_STATES.includes(s.state)) return null;
  await cancelActiveApproval(tx, actor.companyId, s.transaction_id, actor.userId);
  const stages = (
    await tx.query<{ id: string; transaction_id: string }>(`select id, transaction_id from settlement_approval where company_id = $1 and settlement_id = $2 and state = 'SUBMITTED'`, [actor.companyId, s.id])
  ).rows;
  for (const stage of stages) {
    await lockTransaction(tx, stage.transaction_id);
    await cancelActiveApproval(tx, actor.companyId, stage.transaction_id, actor.userId);
    await setRootState(tx, 'settlement_approval', actor.companyId, stage, 'CANCELLED', actor.userId, ', decided_at = now()');
  }
  await setRootState(tx, 'settlement', actor.companyId, s, 'CANCELLED', actor.userId, ', closed_at = now(), cancel_reason = $5', [reason]);
  await audit(tx, actor, 'settlement', s.id, 'VOID', { operational: { state: s.state } }, { operational: { state: 'CANCELLED', revision: s.revision } }, reason);
  await decidedEvent(tx, actor.companyId, s.id, 'CANCELLED');
  return { settlementId: s.id, from: s.state, revision: s.revision };
}

/**
 * FR-052, FR-053 (docs/03 I-81 items 5, 6): a submitted, reviewed, approved or release-eligible revision that must not be paid (a
 * final-period payroll paid one of its components, or it is wrong) is voided by someone holding the settlement approval duty who
 * did not prepare it and is not its employee, with the reason. A draft is cancelled by its preparer; a paid revision is final.
 */
export async function voidSettlement(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string; expectedVersion: number }) {
  const s = await lockSettlement(tx, grant, id);
  assertNotSelf(grant, s.employee_id);
  await reassertAccess(tx, grant, 'settlement', 'approve', ['amount']);
  if (s.state === 'DRAFT') throw new HttpError(409, 'USE_DRAFT_CANCEL', 'A draft is cancelled by its preparer');
  if (!LIVE_STATES.includes(s.state)) throw new HttpError(409, 'INVALID_STATE', 'Only a live revision that is not paid can be voided');
  if (s.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The settlement changed; reload and retry');
  if (grant.userId === s.prepared_by || (await userIsEmployee(tx, grant.companyId, grant.userId, s.employee_id))) {
    throw new HttpError(409, 'NOT_INDEPENDENT', 'A revision is voided by someone other than its preparer and its employee');
  }
  await cancelLiveSettlement(tx, actorOf(grant), s.id, input.reason.trim());
  return settlementDetail(tx, grant, s.id);
}

/** An exit withdrawal request still waiting for its decision (release eligibility and payment wait for it, as final release does). */
async function withdrawalPending(tx: Queryable, companyId: string, exitCaseId: string): Promise<boolean> {
  const r = await tx.query(`select 1 from exit_withdrawal_request where company_id = $1 and exit_case_id = $2 and state = 'SUBMITTED'`, [companyId, exitCaseId]);
  return (r.rowCount ?? 0) > 0;
}

export interface PaymentInput {
  paymentDate: string;
  evidenceKey: string;
  evidenceReference: string;
  evidenceDocumentIds: string[];
  expectedVersion: number;
}

/**
 * FR-053, FR-054, DF07 (docs/03 I-40 item 2, I-81 item 2; decided under owner delegation, 6 Nov 2026): a settlement is paid outside
 * the system, never by a final-settlement payroll run (that would need a calculation the payroll owner has not approved), and the
 * payment is recorded here from evidence: the payment date, the bank or receipt reference, an idempotent evidence key and one
 * released, verified document of the employee. Only a release-eligible revision is paid (FR-053 "keep release and actual payment
 * tracking separate"), in full: the net amount is the paid amount. Whoever records it prepared, reviewed, approved or marked none of
 * it and is not the employee (C4); a withdrawal waiting for its decision, and a component the final-period payroll already pays
 * (FR-052), stop it. The payment date is the disbursement month of the FR-054 list. The same key again is the same payment.
 */
export async function recordSettlementPayment(tx: Queryable, grant: AccessGrant, id: string, input: PaymentInput) {
  const s = await lockSettlement(tx, grant, id);
  assertNotSelf(grant, s.employee_id);
  await reassertAccess(tx, grant, 'settlement', 'record_payment', ['amount']);
  const key = input.evidenceKey.trim();
  if (!/^[A-Za-z0-9._:-]{8,100}$/.test(key)) throw new HttpError(422, 'EVIDENCE_KEY_REQUIRED', 'A payment carries its evidence key (8 to 100 letters, digits or ._:-)');
  const prior = (await tx.query<{ id: string }>(`select id from settlement where company_id = $1 and payment_evidence_key = $2`, [grant.companyId, key])).rows[0];
  if (prior) {
    if (prior.id !== s.id) throw new HttpError(409, 'EVIDENCE_KEY_REUSED', 'This evidence key already recorded another payment');
    return { ...(await settlementDetail(tx, grant, s.id)), replayed: true };
  }
  if (s.state !== 'RELEASE_ELIGIBLE') throw new HttpError(409, 'INVALID_STATE', 'Only a settlement eligible for release is recorded as paid');
  if (s.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The settlement changed; reload and retry');
  const marker = (await tx.query<{ by: string; day: string }>(`select release_eligible_by as by, to_char(hrms_business_date(company_id, release_eligible_at), 'YYYY-MM-DD') as day from settlement where company_id = $1 and id = $2`, [grant.companyId, s.id])).rows[0]!;
  const stages = (await tx.query<{ transaction_id: string }>(`select transaction_id from settlement_approval where company_id = $1 and settlement_id = $2`, [grant.companyId, s.id])).rows.map((r) => r.transaction_id);
  const deciders = await decidersOf(tx, grant.companyId, [s.transaction_id, ...stages]);
  if (grant.userId === s.prepared_by || grant.userId === marker.by || deciders.includes(grant.userId) || (await userIsEmployee(tx, grant.companyId, grant.userId, s.employee_id))) {
    throw new HttpError(409, 'NOT_INDEPENDENT', 'The payment is recorded by someone other than the preparer, reviewer, approver and release marker');
  }
  if (await withdrawalPending(tx, grant.companyId, s.exit_case_id)) throw new HttpError(409, 'WITHDRAWAL_PENDING', 'A withdrawal request is waiting for a decision');
  await assertNotPaidInPayroll(tx, grant.companyId, s);
  // Serialised with the payroll calculation's pickup of arrears and adjustments, so neither can take a case the other is paying.
  await advisoryLock(tx, `payroll_arrears_pickup:${grant.companyId}`);
  await assertCalculationStillHolds(tx, grant.companyId, s.id);
  const date = input.paymentDate;
  if (!isIsoDate(date)) throw new HttpError(422, 'INVALID_DATE', 'The payment date is not a valid date', { field: 'paymentDate' });
  if (date > grant.businessDate) throw new HttpError(422, 'PAYMENT_IN_FUTURE', 'A payment is recorded once it has happened');
  if (date < marker.day) throw new HttpError(422, 'PAYMENT_BEFORE_RELEASE', 'The payment date cannot be before the settlement became eligible for release');
  const reference = input.evidenceReference.trim();
  if (reference === '' || reference.length > 500) throw new HttpError(422, 'EVIDENCE_REQUIRED', 'Give the payment reference (at most 500 characters)');
  const docs = await requireVerifiedEvidence(tx, grant.companyId, s.employee_id, input.evidenceDocumentIds, { required: true });
  if (docs.length !== 1) throw new HttpError(422, 'ONE_EVIDENCE_DOCUMENT', 'A payment is evidenced by one released, verified document');
  await setRootState(
    tx,
    'settlement',
    grant.companyId,
    s,
    'PAID',
    grant.userId,
    ', paid_at = now(), paid_by = $4, paid_assignment_id = $5, payment_date = $6, payment_reference = $7, payment_evidence_key = $8, payment_document_id = $9',
    [grant.assignmentId, date, reference, key, docs[0]],
  );
  // BRD line 4939 (I-88): the paid settlement consumes the leave it encashed, once.
  const encashed = await encashOnPayment(tx, actorOf(grant), s.id);
  // I-88 follow-up (0214): the arrears and timesheet adjustments its calculation took are paid by it, once.
  const applied = await applyCasesPaidBySettlement(tx, grant.companyId, s.id, grant.userId);
  await audit(tx, actorOf(grant), 'settlement', s.id, 'RECORD_PAYMENT', { operational: { state: 'RELEASE_ELIGIBLE' } }, {
    operational: { state: 'PAID', revision: s.revision, paymentDate: date, evidenceDocuments: 1, leaveTypesEncashed: encashed, arrearsApplied: applied.arrears, adjustmentsApplied: applied.adjustments },
  });
  await decidedEvent(tx, grant.companyId, s.id, 'PAID');
  return { ...(await settlementDetail(tx, grant, s.id)), replayed: false };
}

export async function submitSettlement(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  const { s, exit } = await draftForChange(tx, grant, id, input.expectedVersion);
  if (!approvedExit(exit.state)) throw new HttpError(409, 'EXIT_NOT_APPROVED', 'The exit is no longer approved');
  const lines = (await tx.query<{ n: number }>(`select count(*)::int as n from settlement_line where company_id = $1 and settlement_id = $2`, [grant.companyId, s.id])).rows[0]!.n;
  if (lines === 0) throw new HttpError(422, 'NO_LINES', 'Enter or upload the settlement lines first');
  await assertNotPaidInPayroll(tx, grant.companyId, s);
  await assertCalculationStillHolds(tx, grant.companyId, s.id);
  await setRootState(tx, 'settlement', grant.companyId, s, 'SUBMITTED', grant.userId, ', submitted_at = now(), submitted_by = $4');
  // C4/DF02: the preparer never reviews or approves the settlement; the employee never decides it either.
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: SETTLEMENT_KIND,
    transactionId: s.transaction_id,
    ownerEmployeeId: s.employee_id,
    actorUserId: grant.userId,
    excludeUserIds: [s.prepared_by],
  });
  await audit(tx, actorOf(grant), 'settlement', s.id, 'SUBMIT', { operational: { state: 'DRAFT' } }, { operational: { state: 'SUBMITTED', revision: s.revision, lineCount: lines } });
  await assignedEvent(tx, grant.companyId, s.id, taskId, 'review');
  return settlementDetail(tx, grant, s.id);
}

async function assignedEvent(tx: Queryable, companyId: string, settlementId: string, taskId: string, step: 'review' | 'approval') {
  await enqueueEvent(tx, {
    companyId,
    topic: 'settlement.assigned',
    aggregateId: settlementId,
    dedupeKey: `settlement.assigned:${settlementId}:${step}`,
    payload: { settlementId, taskId, step },
  });
}

async function decidedEvent(tx: Queryable, companyId: string, settlementId: string, outcome: string) {
  await enqueueEvent(tx, { companyId, topic: 'settlement.decided', aggregateId: settlementId, dedupeKey: `settlement.decided:${settlementId}:${outcome}`, payload: { settlementId, outcome } });
}

// ---------------------------------------------------------------------------------------------------------------
// Independent review, approval and release eligibility
// ---------------------------------------------------------------------------------------------------------------

export interface SettlementDecisionInput {
  decision: 'APPROVE' | 'REJECT' | 'RETURN';
  reason?: string | undefined;
  idempotencyKey: string;
}

export async function reviewSettlement(tx: Queryable, grant: AccessGrant, taskId: string, input: SettlementDecisionInput) {
  if (input.decision !== 'APPROVE' && !input.reason?.trim()) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the settlement is returned or rejected');
  const t = await taskTransaction(tx, grant, taskId, [SETTLEMENT_KIND]);
  await lockTransaction(tx, t.transactionId);
  const s = (await tx.query<SettlementRow>(`select ${COLUMNS} from settlement s where s.company_id = $1 and s.transaction_id = $2 for update`, [grant.companyId, t.transactionId])).rows[0];
  if (!s || !(await canAccessEmployee(tx, grant, s.employee_id))) throw notFound();
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { settlementId: s.id, state: s.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (s.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This settlement is not waiting for review');
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'settlement', action: 'review' } });
  if (result.replayed) return { settlementId: s.id, state: s.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { settlementId: s.id, state: s.state, replayed: false };
  if (result.outcome === 'APPROVED') {
    await setRootState(tx, 'settlement', grant.companyId, s, 'REVIEWED', grant.userId, ', reviewed_at = now()');
    // The approval stage is its own transaction so that the approver is chosen independently of preparer and reviewer.
    const stageTx = (
      await tx.query<{ id: string }>(
        `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'SUBMITTED', $4, $4) returning id`,
        [grant.companyId, SETTLEMENT_APPROVAL_KIND, s.employee_id, grant.userId],
      )
    ).rows[0]!.id;
    await tx.query(`insert into settlement_approval (company_id, settlement_id, employee_id, transaction_id, state, created_by, updated_by) values ($1, $2, $3, $4, 'SUBMITTED', $5, $5)`, [
      grant.companyId,
      s.id,
      s.employee_id,
      stageTx,
      grant.userId,
    ]);
    const { taskId: approvalTask } = await startApproval(tx, {
      companyId: grant.companyId,
      kind: SETTLEMENT_APPROVAL_KIND,
      transactionId: stageTx,
      ownerEmployeeId: s.employee_id,
      actorUserId: grant.userId,
      excludeUserIds: [s.prepared_by, grant.userId],
    });
    await audit(tx, actorOf(grant), 'settlement', s.id, 'REVIEW', { operational: { state: 'SUBMITTED' } }, { operational: { state: 'REVIEWED', revision: s.revision } }, input.reason ?? null);
    await assignedEvent(tx, grant.companyId, s.id, approvalTask, 'approval');
    return { settlementId: s.id, state: 'REVIEWED', replayed: false };
  }
  const state = result.outcome === 'REJECTED' ? 'REJECTED' : 'RETURNED';
  await setRootState(tx, 'settlement', grant.companyId, s, state, grant.userId, ', closed_at = now()');
  await audit(tx, actorOf(grant), 'settlement', s.id, input.decision, { operational: { state: 'SUBMITTED' } }, { operational: { state, revision: s.revision } }, input.reason ?? null);
  await decidedEvent(tx, grant.companyId, s.id, state);
  return { settlementId: s.id, state, replayed: false };
}

export async function approveSettlement(tx: Queryable, grant: AccessGrant, taskId: string, input: SettlementDecisionInput) {
  if (input.decision !== 'APPROVE' && !input.reason?.trim()) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the settlement is returned or rejected');
  const t = await taskTransaction(tx, grant, taskId, [SETTLEMENT_APPROVAL_KIND]);
  const stage0 = (await tx.query<{ settlement_id: string }>(`select settlement_id from settlement_approval where company_id = $1 and transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0];
  if (!stage0) throw notFound();
  // Lock order: the settlement's transaction, then the stage's, then rows.
  const s = await lockSettlement(tx, grant, stage0.settlement_id);
  await lockTransaction(tx, t.transactionId);
  const stage = (await tx.query<{ id: string; transaction_id: string; state: string }>(`select id, transaction_id, state from settlement_approval where company_id = $1 and transaction_id = $2 for update`, [grant.companyId, t.transactionId])).rows[0]!;
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { settlementId: s.id, state: s.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (s.state !== 'REVIEWED' || stage.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This settlement is not waiting for approval');
  // FR-052 (I-88; BRD line 5120): a missing rule pack, policy or record refuses the approval; returning or rejecting stays open.
  if (input.decision === 'APPROVE') await assertApprovable(tx, grant.companyId, s);
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'settlement', action: 'approve' } });
  if (result.replayed) return { settlementId: s.id, state: s.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { settlementId: s.id, state: s.state, replayed: false };
  const state = result.outcome === 'APPROVED' ? 'APPROVED' : result.outcome === 'REJECTED' ? 'REJECTED' : 'RETURNED';
  await setRootState(tx, 'settlement_approval', grant.companyId, stage, state, grant.userId, ', decided_at = now()');
  await setRootState(tx, 'settlement', grant.companyId, s, state, grant.userId, state === 'APPROVED' ? ', approved_at = now()' : ', closed_at = now()');
  await audit(tx, actorOf(grant), 'settlement', s.id, input.decision, { operational: { state: 'REVIEWED' } }, { operational: { state, revision: s.revision } }, input.reason ?? null);
  await decidedEvent(tx, grant.companyId, s.id, state);
  return { settlementId: s.id, state, replayed: false };
}

/**
 * FR-053 "only a reviewed and approved settlement reaches release eligibility; merely viewing OK To Disburse never
 * triggers a payment". The marker is independent of the preparer, reviewer, approver and employee, and the exit's
 * clearance must be complete (F1 "no skipped required clearance at final release"). No payment record is created.
 */
export async function markReleaseEligible(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  const s = await lockSettlement(tx, grant, id);
  assertNotSelf(grant, s.employee_id);
  // The release decision re-checks its grant after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'settlement', 'release', ['amount']);
  if (s.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only an approved settlement can become eligible for release');
  if (s.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The settlement changed; reload and retry');
  const stages = (await tx.query<{ transaction_id: string }>(`select transaction_id from settlement_approval where company_id = $1 and settlement_id = $2`, [grant.companyId, s.id])).rows.map((r) => r.transaction_id);
  const deciders = await decidersOf(tx, grant.companyId, [s.transaction_id, ...stages]);
  if (grant.userId === s.prepared_by || deciders.includes(grant.userId) || (await userIsEmployee(tx, grant.companyId, grant.userId, s.employee_id))) {
    throw new HttpError(409, 'NOT_INDEPENDENT', 'Release eligibility is decided by someone other than the preparer, reviewer and approver');
  }
  const exit = (await exitFor(tx, grant.companyId, s.exit_case_id))!;
  if (!approvedExit(exit.state)) throw new HttpError(409, 'EXIT_NOT_APPROVED', 'The exit is no longer approved');
  // FR-051/FR-053 (I-81 item 6): a withdrawal waiting for its decision may still end the exit, as final release waits for it.
  if (await withdrawalPending(tx, grant.companyId, s.exit_case_id)) throw new HttpError(409, 'WITHDRAWAL_PENDING', 'A withdrawal request is waiting for a decision');
  await assertNotPaidInPayroll(tx, grant.companyId, s);
  await assertCalculationStillHolds(tx, grant.companyId, s.id);
  await lockClearance(tx, grant.companyId, s.exit_case_id);
  const clearance = await clearanceStatus(tx, grant.companyId, s.exit_case_id);
  if (!clearance.started) throw new HttpError(409, 'CLEARANCE_NOT_STARTED', 'Start the exit clearance checklist first');
  if (!clearance.complete) throw new HttpError(409, 'CLEARANCE_INCOMPLETE', 'Every required clearance task must be completed first', { tasks: clearance.incompleteRequired });
  await setRootState(tx, 'settlement', grant.companyId, s, 'RELEASE_ELIGIBLE', grant.userId, ', release_eligible_at = now(), release_eligible_by = $4, release_eligible_assignment_id = $5', [grant.assignmentId]);
  await audit(tx, actorOf(grant), 'settlement', s.id, 'RELEASE_ELIGIBLE', { operational: { state: 'APPROVED' } }, { operational: { state: 'RELEASE_ELIGIBLE', revision: s.revision, paymentRecorded: false } });
  await decidedEvent(tx, grant.companyId, s.id, 'RELEASE_ELIGIBLE');
  return settlementDetail(tx, grant, s.id);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading and export
// ---------------------------------------------------------------------------------------------------------------

interface DetailRow extends SettlementRow {
  employee_code: string;
  employee_name: string;
  calculation_status: string;
  submitted_at: Date | null;
  reviewed_at: Date | null;
  approved_at: Date | null;
  release_eligible_at: Date | null;
  created_at: Date;
  last_working_date: string | null;
  cancel_reason: string | null;
  paid_at: Date | null;
  paid_by: string | null;
  payment_date: string | null;
  payment_reference: string | null;
}

const DETAIL_SQL = `select ${COLUMNS}, e.employee_code, e.display_name as employee_name, s.calculation_status, s.submitted_at, s.reviewed_at, s.approved_at,
    s.release_eligible_at, s.created_at, to_char(sx.approved_leaving_date, 'YYYY-MM-DD') as last_working_date,
    s.cancel_reason, s.paid_at, s.paid_by, to_char(s.payment_date, 'YYYY-MM-DD') as payment_date, s.payment_reference
  from settlement s join employee e on e.company_id = s.company_id and e.id = s.employee_id
  join exit_case sx on sx.company_id = s.company_id and sx.id = s.exit_case_id`;

async function present(db: Queryable, grant: AccessGrant, s: DetailRow) {
  const showAmounts = holds(grant, 'amount');
  const stages = (await db.query<{ transaction_id: string }>(`select transaction_id from settlement_approval where company_id = $1 and settlement_id = $2`, [grant.companyId, s.id])).rows.map((r) => r.transaction_id);
  const lines = showAmounts
    ? (
        await db.query(
          `select c.code as "componentCode", c.name as "componentName", c.component_kind as "componentKind", l.amount, l.line_kind as "lineKind", l.source,
                  l.calculation_id as "calculationId", l.reason
             from settlement_line l join pay_component c on c.company_id = l.company_id and c.id = l.component_id
            where l.company_id = $1 and l.settlement_id = $2 order by c.code`,
          [grant.companyId, s.id],
        )
      ).rows
    : undefined;
  return {
    id: s.id,
    exitCaseId: s.exit_case_id,
    employeeId: s.employee_id,
    employeeCode: s.employee_code,
    employeeName: s.employee_name,
    revision: s.revision,
    state: s.state,
    currencyCode: s.currency_code,
    calculationStatus: s.calculation_status,
    supersedesSettlementId: s.supersedes_settlement_id,
    // The exit's approved (inclusive) last working date, which every upload row must carry (FR-054).
    lastWorkingDate: s.last_working_date,
    preparedBy: s.prepared_by,
    // BR-016: release eligibility is not a payment; only a payment recorded from evidence is (I-81 item 2). Its date is the
    // disbursement month; its reference and recorder are confidential like the amounts.
    paymentStatus: s.state === 'PAID' ? 'PAID' : 'NOT_PAID',
    paymentDate: s.payment_date,
    ...(showAmounts && s.paid_at ? { payment: { paidAt: s.paid_at, paidBy: s.paid_by, reference: s.payment_reference } } : {}),
    cancelReason: s.cancel_reason,
    ...(showAmounts ? { netAmount: s.net_amount, lines } : {}),
    // FR-052 (I-88): the snapshot the revision carries, its items and the exit's notice waiver, confidential like the lines.
    ...(showAmounts ? { calculation: await calculationView(db, grant.companyId, s.calculation_id), noticeWaiver: await noticeWaiverOf(db, grant.companyId, s.exit_case_id) } : {}),
    submittedAt: s.submitted_at,
    reviewedAt: s.reviewed_at,
    approvedAt: s.approved_at,
    releaseEligibleAt: s.release_eligible_at,
    createdAt: s.created_at,
    // Deciders are named so that a reader can see the review, approval and release are independent (FR-053).
    decisions: await decisionTrail(db, grant.companyId, [s.transaction_id, ...stages], { actors: true }),
    version: s.version,
  };
}

/**
 * FR-034 acceptance "settlement shows remaining balance", read-only: the employee's outstanding loan and advance
 * balances (only while the loans module, payroll-outputs, is active; net of recoveries recognised or already deducted by
 * processed payroll, as the loan views show it) and each active paid leave type's balance as at the approved last working date (the leave balance
 * read, counting movements effective on or before that date). Nothing here changes a settlement amount or computes an
 * encashment or a recovery (F1/I-29: no automatic encashment; FR-052 rules are owner decisions).
 */
async function remainingBalances(db: Queryable, grant: AccessGrant, s: DetailRow) {
  return {
    asOf: s.last_working_date,
    leave: (await ledgerBalances(db, grant.companyId, s.employee_id, { asOf: s.last_working_date, paidOnly: true })).map(({ leaveType, available, pending, taken }) => ({
      leaveType,
      available,
      pending,
      taken,
    })),
    ...(isModuleActive('payroll-outputs') ? { loans: await outstandingLoans(db, grant.companyId, s.employee_id) } : {}),
    // FR-052 (I-81 item 5): the final period's payroll, components only, and which of them count as already paid.
    finalPeriodPayroll: await finalPeriodPayroll(db, grant.companyId, s.employee_id, s.last_working_date),
  };
}

export async function settlementDetail(db: Queryable, grant: AccessGrant, id: string) {
  const s = (await db.query<DetailRow>(`${DETAIL_SQL} where s.company_id = $1 and s.id = $2`, [grant.companyId, id])).rows[0];
  if (!s || !(await canAccessEmployee(db, grant, s.employee_id))) throw notFound();
  assertNotSelf(grant, s.employee_id);
  const detail = await present(db, grant, s);
  // Loan balances are confidential money values, and both balances are settlement inputs: shown only under the
  // settlement amount group, like the lines and the net amount (DF02).
  return holds(grant, 'amount') ? { ...detail, balances: await remainingBalances(db, grant, s) } : detail;
}

export async function exitSettlements(db: Queryable, grant: AccessGrant, exitCaseId: string) {
  const exit = await exitFor(db, grant.companyId, exitCaseId);
  if (!exit || !(await canAccessEmployee(db, grant, exit.employee_id))) throw notFound();
  assertNotSelf(grant, exit.employee_id);
  const rows = (await db.query<DetailRow>(`${DETAIL_SQL} where s.company_id = $1 and s.exit_case_id = $2 order by s.revision`, [grant.companyId, exitCaseId])).rows;
  const items = [];
  for (const r of rows) items.push(await present(db, grant, r));
  return { calculation: CALCULATION_STATUS, items };
}

/**
 * FR-056: the settlement list's sort keys and their columns in DETAIL_SQL. The net amount is not one: its order would
 * tell a reader without the amount group how settlements compare (DF02).
 */
const SETTLEMENT_SORT_COLUMNS = { employeeCode: 'employee_code', employeeName: 'employee_name', revision: 'revision', state: 'state', lastWorkingDate: 'last_working_date', createdAt: 'created_at' } as const;
export const SETTLEMENT_SORTS = Object.keys(SETTLEMENT_SORT_COLUMNS);

/** Lists answered without page/pageSize (each list's first answer before it could page). */
export const SETTLEMENT_LIST_CAP = 200;
export const AWAITING_EXIT_LIST_CAP = 200;

/**
 * FR-054 list within the caller's row scope, filtered by state, employee code search and the month of the approved
 * last working date (a disbursement month needs payment scheduling, which is not built). Amounts need the amount group.
 * Newest first: one page (FR-056), or the first 200 without page/pageSize; `total` counts every match.
 */
export async function listSettlements(
  db: Queryable,
  grant: AccessGrant,
  filter: { state?: string | undefined; employeeCode?: string | undefined; lastWorkingMonth?: string | undefined; disbursementMonth?: string | undefined; employeeIds?: readonly string[] | undefined } & Paging & Sorting,
) {
  const params = new SqlParams();
  const where = [employeeScopePredicate(grant, { company: 's.company_id', employee: 's.employee_id' }, params)];
  // FR-054 disbursement month (I-81 item 2): the month of the recorded payment date, so only paid settlements have one.
  if (filter.disbursementMonth) where.push(`to_char(s.payment_date, 'YYYY-MM') = ${params.add(filter.disbursementMonth)}`);
  // FR-054 uploaded-list selection (I-81 item 7): the employees the uploaded list resolved to, already within row scope.
  if (filter.employeeIds) where.push(`s.employee_id = any(${params.add([...filter.employeeIds])}::uuid[])`);
  // Never one's own settlement (filtered in SQL, so pages and the total count only rows the caller may see).
  if (grant.linkedEmployeeId) where.push(`s.employee_id <> ${params.add(grant.linkedEmployeeId)}::uuid`);
  if (filter.state) where.push(`s.state = ${params.add(filter.state)}`);
  if (filter.employeeCode) where.push(`e.employee_code like ${params.add(`%${filter.employeeCode.trim().toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`);
  if (filter.lastWorkingMonth) {
    where.push(`to_char((select x.approved_leaving_date from exit_case x where x.company_id = s.company_id and x.id = s.exit_case_id), 'YYYY-MM') = ${params.add(filter.lastWorkingMonth)}`);
  }
  const page = await pageOf<Record<string, unknown> & DetailRow>(db, `${DETAIL_SQL} where ${where.join(' and ')}`, params.values, sortedBy(filter, SETTLEMENT_SORT_COLUMNS, 'created_at desc, id'), filter, SETTLEMENT_LIST_CAP);
  const showAmounts = holds(grant, 'amount');
  return {
    calculation: CALCULATION_STATUS,
    ...pageMeta(page),
    items: page.items.map((s) => ({
      id: s.id,
      exitCaseId: s.exit_case_id,
      employeeId: s.employee_id,
      employeeCode: s.employee_code,
      employeeName: s.employee_name,
      revision: s.revision,
      state: s.state,
      currencyCode: s.currency_code,
      calculationStatus: s.calculation_status,
      lastWorkingDate: s.last_working_date,
      paymentStatus: s.state === 'PAID' ? 'PAID' : 'NOT_PAID',
      paymentDate: s.payment_date,
      ...(showAmounts ? { netAmount: s.net_amount } : {}),
      version: s.version,
    })),
  };
}

/**
 * The active pay components a settlement line may name (the preparer's form offers exactly what checkLine accepts).
 * A catalogue only: codes, names and kinds, no amounts.
 */
export async function settlementComponents(db: Queryable, grant: AccessGrant) {
  const rows = await db.query<{ code: string; name: string; kind: string }>(
    `select code, name, component_kind as kind from pay_component where company_id = $1 and active order by code`,
    [grant.companyId],
  );
  return { items: rows.rows };
}

/**
 * Approved (or separated) exits within the caller's row scope that have no live settlement revision: never prepared,
 * or whose latest revision was returned, rejected or cancelled (a new revision is due). Never the caller's own exit.
 * Earliest last working date first: one page (FR-056), or the first 200 without page/pageSize; `total` counts all.
 */
export async function exitsAwaitingSettlement(db: Queryable, grant: AccessGrant, paging: Paging = {}) {
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'x.company_id', employee: 'x.employee_id' }, params);
  const self = grant.linkedEmployeeId ? `and x.employee_id <> ${params.add(grant.linkedEmployeeId)}::uuid` : '';
  const live = params.add(LIVE_STATES);
  return pageOf(
    db,
    `select x.id as "exitCaseId", x.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName", x.state as "exitState",
            to_char(x.approved_leaving_date, 'YYYY-MM-DD') as "lastWorkingDate", (x.released_at is not null) as released,
            ls.revision as "latestRevision", ls.state as "latestState"
       from exit_case x
       join employee e on e.company_id = x.company_id and e.id = x.employee_id
       left join lateral (select s.revision, s.state from settlement s where s.company_id = x.company_id and s.exit_case_id = x.id order by s.revision desc limit 1) ls on true
      where ${scope} and x.state in ('APPROVED', 'SEPARATED') ${self}
        and not exists (select 1 from settlement s where s.company_id = x.company_id and s.exit_case_id = x.id and (s.state = any(${live}::text[]) or s.state = 'PAID'))`,
    params.values,
    '"lastWorkingDate", "employeeCode", "exitCaseId"',
    paging,
    AWAITING_EXIT_LIST_CAP,
  );
}

export async function settlementTasks(db: Queryable, grant: AccessGrant) {
  const tasks = [
    ...((await myOpenTasks(db, grant, SETTLEMENT_KIND)).items as { taskId: string; transactionId: string; kind: string; stepAction: string }[]),
    ...((await myOpenTasks(db, grant, SETTLEMENT_APPROVAL_KIND)).items as { taskId: string; transactionId: string; kind: string; stepAction: string }[]),
  ];
  const items = [];
  for (const t of tasks) {
    const s = (
      await db.query<DetailRow>(
        `${DETAIL_SQL} where s.company_id = $1 and (s.transaction_id = $2 or s.id = (select a.settlement_id from settlement_approval a where a.company_id = $1 and a.transaction_id = $2))`,
        [grant.companyId, t.transactionId],
      )
    ).rows[0];
    if (!s || !(await canAccessEmployee(db, grant, s.employee_id))) {
      items.push({ taskId: t.taskId, kind: t.kind, step: t.stepAction, settlement: null });
      continue;
    }
    items.push({ taskId: t.taskId, kind: t.kind, step: t.stepAction, settlement: await present(db, grant, s) });
  }
  return { items };
}

// ---------------------------------------------------------------------------------------------------------------
// FR-054 outputs: CSV, Excel (XLSX), PDF and a ZIP of several settlements. Every output holds the same rows: the
// revision's context (DF09: revision and generated time), its lines and the net total, which equals the approved net
// amount. Each is built on request under the caller's current grants (the settlement amount group) and is never
// stored or sent (FR-054 "preview/export does not send mail"; sending awaits the owner, I-40 item 3).
// ---------------------------------------------------------------------------------------------------------------

export const EXPORT_FORMATS = ['CSV', 'XLSX', 'PDF'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * FR-054 ZIP output: the most settlements one archive holds. The BRD states no bound for exports (DF09's 10,000 rows
 * and 10 MB bound imports), so this is a technical bound: one full page of the settlement list at its largest page
 * size (I-43: 25, 50 or 100), which keeps the synchronous build well inside the 10 seconds after which DF10 wants a
 * report to run in the background.
 */
export const MAX_ARCHIVE_SETTLEMENTS = 100;

/** A value the CSV writes as a bare number: a plain signed decimal. */
const NUMBER_LIKE = /^-?\d+(\.\d+)?$/;

/** DF09 formula-injection guard: text a spreadsheet could read as a formula gets a leading apostrophe. */
const guardText = (text: string): string => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);

/** A CSV cell: plain signed decimals stay numbers; any other text is quoted and guarded (DF09). */
function cell(value: string): string {
  if (NUMBER_LIKE.test(value)) return value;
  return `"${guardText(value).replace(/"/g, '""')}"`;
}

/** One output cell: text, or a number (an amount or the revision) that a workbook holds as a number cell. */
type OutputCell = string | { number: string };
const textOf = (c: OutputCell): string => (typeof c === 'string' ? c : c.number);

/**
 * A number a workbook number cell holds exactly: a plain decimal of at most 15 significant digits (what an IEEE
 * double, the spreadsheet number, always keeps). A longer amount stays text, so the workbook never shows a rounded total.
 */
function exactInWorkbook(value: string): boolean {
  if (!PLAIN_DECIMAL.test(value)) return false;
  const [whole = '', fraction = ''] = value.replace(/^-/, '').split('.');
  return `${whole}${fraction.replace(/0+$/, '')}`.replace(/^0+/, '').length <= 15;
}

/** An XLSX cell: an exact number for the amounts and the revision; text exactly as the CSV writes it, guarded. */
function sheetCell(c: OutputCell): SheetCell {
  if (typeof c !== 'string' && exactInWorkbook(c.number)) return { number: c.number };
  const text = textOf(c);
  return NUMBER_LIKE.test(text) ? text : guardText(text);
}

/** The PDF columns of the line table (A4 width less the margins, 515 pt); context rows use the first two. */
const PDF_COLUMNS: PdfColumn[] = [{ width: 85 }, { width: 160 }, { width: 70 }, { width: 95 }, { width: 105, align: 'right' }];

interface ExportFile {
  fileName: string;
  mediaType: string;
  content: string | Buffer;
  lineCount: number;
}

type ExportDetail = Awaited<ReturnType<typeof present>>;

/** Revisions an output (export, archive or in-app statement) may carry: approved, release-eligible or paid. */
const EXPORTABLE_STATES = ['APPROVED', 'RELEASE_ELIGIBLE', 'PAID'];

/**
 * The approved (or release-eligible) revision an output carries: within the caller's row scope and never their own. The
 * settlement amount group (the lines and the net amount are confidential) is the export grant: the routes refuse and audit
 * without it and both callers here re-check it, so a refusal at this point could only roll back with its own audit row.
 */
async function exportable(db: Queryable, grant: AccessGrant, id: string): Promise<ExportDetail> {
  const s =(await db.query<DetailRow>(`${DETAIL_SQL} where s.company_id = $1 and s.id = $2`, [grant.companyId, id])).rows[0];
  if (!s || !(await canAccessEmployee(db, grant, s.employee_id))) throw notFound();
  assertNotSelf(grant, s.employee_id);
  if (!EXPORTABLE_STATES.includes(s.state)) throw new HttpError(409, 'NOT_APPROVED', 'Only an approved settlement is exported', { settlementId: s.id });
  return present(db, grant, s);
}

/** DF09, FR-065: what the file says about itself, as every report file does (report/context.ts). */
const settlementFileContext = (db: Queryable, grant: AccessGrant, detail: ExportDetail): Promise<ReportContext> =>
  fileContext(db, grant, { title: 'Settlement export', code: 'SETTLEMENT_EXPORT', filters: { settlement: detail.id }, revision: String(detail.revision), rowCount: (detail.lines ?? []).length });

/** The rows every format holds, in order. */
function outputRows(detail: ExportDetail, generatedAt: string, context: ReportContext): OutputCell[][] {
  const lines = (detail.lines ?? []) as { componentCode: string; componentName: string; componentKind: string; lineKind: string; amount: string }[];
  return [
    ...context.map(([label, value]): OutputCell[] => [label, value]),
    [],
    ['settlement_id', detail.id],
    ['employee_code', detail.employeeCode],
    ['revision', { number: String(detail.revision) }],
    ['state', detail.state],
    ['currency_code', detail.currencyCode],
    ['calculation_status', detail.calculationStatus],
    ['generated_at', generatedAt],
    [],
    ['component_code', 'component_name', 'component_kind', 'line_kind', 'amount'],
    ...lines.map((l): OutputCell[] => [l.componentCode, l.componentName, l.componentKind, l.lineKind, { number: l.amount }]),
    ['NET', '', '', '', { number: detail.netAmount ?? '' }],
  ];
}

function render(detail: ExportDetail, format: ExportFormat, generatedAt: string, context: ReportContext): ExportFile {
  const rows = outputRows(detail, generatedAt, context);
  const lineCount = (detail.lines ?? []).length;
  const base = `settlement-${detail.employeeCode}-r${detail.revision}`;
  if (format === 'XLSX') {
    return { fileName: `${base}.xlsx`, mediaType: XLSX_MEDIA_TYPE, content: xlsxWorkbook(`Settlement ${detail.employeeCode} r${detail.revision}`, rows.map((r) => r.map(sheetCell))), lineCount };
  }
  if (format === 'PDF') return { fileName: `${base}.pdf`, mediaType: PDF_MEDIA_TYPE, content: pdfDocument(rows.map((r) => r.map(textOf)), PDF_COLUMNS), lineCount };
  const csv = rows.map((r) => r.map((c) => cell(textOf(c))).join(',')).join('\r\n');
  return { fileName: `${base}.csv`, mediaType: 'text/csv; charset=utf-8', content: `${csv}\r\n`, lineCount };
}

/**
 * FR-054 output of one approved (or release-eligible) revision as CSV, Excel (XLSX) or PDF: its context, lines and
 * net total; the export is audited (format, revision, line count; never an amount). The export grant (FR-002) is
 * re-checked inside the caller's transaction.
 */
export async function exportSettlement(tx: Queryable, grant: AccessGrant, id: string, format: ExportFormat = 'CSV'): Promise<ExportFile> {
  await reassertAccess(tx, grant, 'settlement', 'export', ['amount']);
  const detail = await exportable(tx, grant, id);
  const file = render(detail, format, new Date().toISOString(), await settlementFileContext(tx, grant, detail));
  await audit(tx, actorOf(grant), 'settlement', detail.id, 'EXPORT', null, { operational: { revision: detail.revision, lineCount: file.lineCount, format } });
  return file;
}

/**
 * FR-054, FR-018 (I-81 item 9): the statement a settlement sends to the employee's own self-service, built exactly as its export
 * (same rows and checks) under the caller's grants. The caller (delivery.ts) re-checks the send right and stores the file.
 */
export async function renderStatement(tx: Queryable, grant: AccessGrant, id: string, format: 'PDF' | 'XLSX') {
  const detail = await exportable(tx, grant, id);
  const file = render(detail, format, new Date().toISOString(), await settlementFileContext(tx, grant, detail));
  return { detail, file };
}

/**
 * FR-054 ZIP output: the settlements the caller selected from the list (by hand, or from an uploaded list through
 * selectFromUploadedList), each as
 * the file its single export gives in the chosen format, in the order selected. All or nothing: every settlement is
 * checked as its own export is (row scope, never one's own, approved, the amount group), and one that is not available
 * refuses the archive; each one included is audited as its export is, inside the caller's transaction, so a refused
 * archive leaves no export recorded. At most MAX_ARCHIVE_SETTLEMENTS ids per request; an id given twice is one file.
 * The export grant (FR-002) is re-checked inside the transaction before anything is built.
 */
export async function exportSettlementArchive(tx: Queryable, grant: AccessGrant, settlementIds: readonly string[], format: ExportFormat = 'CSV') {
  if (settlementIds.length === 0) throw new HttpError(422, 'NO_SELECTION', 'Select at least one settlement');
  if (settlementIds.length > MAX_ARCHIVE_SETTLEMENTS) throw new HttpError(422, 'TOO_MANY_SETTLEMENTS', `At most ${MAX_ARCHIVE_SETTLEMENTS} settlements per archive`, { max: MAX_ARCHIVE_SETTLEMENTS });
  await reassertAccess(tx, grant, 'settlement', 'export', ['amount']);
  const ids = [...new Set(settlementIds.map((i) => i.toLowerCase()))];
  const generatedAt = new Date().toISOString();
  const entries: { name: string; data: Buffer }[] = [];
  for (const id of ids) {
    const detail = await exportable(tx, grant, id);
    const file = render(detail, format, generatedAt, await settlementFileContext(tx, grant, detail));
    // Two revisions of one employee and number (an earlier exit) never share a name: the later gets its id.
    const extension = file.fileName.slice(file.fileName.lastIndexOf('.'));
    const name = entries.some((e) => e.name === file.fileName) ? `${file.fileName.slice(0, -extension.length)}-${detail.id}${extension}` : file.fileName;
    entries.push({ name, data: typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content });
    await audit(tx, actorOf(grant), 'settlement', detail.id, 'EXPORT', null, {
      operational: { revision: detail.revision, lineCount: file.lineCount, format, archive: 'ZIP', archiveSize: ids.length },
    });
  }
  return { fileName: `settlements-${generatedAt.slice(0, 10)}.zip`, mediaType: 'application/zip', content: zipStored(entries), count: ids.length };
}

// ---------------------------------------------------------------------------------------------------------------
// FR-054 bulk upload: SETTLEMENT_LINES_V1 rows for many settlements in one file (settlement-import.ts runs it through
// the shared import framework). A row names its settlement by the employee code and the approved last working date —
// the live draft revision of that exit — and is checked as the one-settlement upload checks its rows.
// ---------------------------------------------------------------------------------------------------------------

export interface UploadRow {
  employeeCode: string;
  lastWorkingDate: string;
  componentCode: string;
  amount: string;
  lineKind: string;
}

export interface UploadRowCaches {
  components: Map<string, { id: string; kind: string } | null>;
  /** Employee code -> the employee and whether the caller's row scope covers them (null: no such employee). */
  employees: Map<string, { id: string; inScope: boolean } | null>;
  /** Settlement id -> the components its final-period payroll already pays (FR-052; componentsPaidInFinalPayroll). */
  paidInPayroll: Map<string, ReadonlyMap<string, string>>;
}

/**
 * One bulk upload row: the draft it names and its checked line, or the row's error code. The settlement is found and
 * checked as the one-settlement upload finds and checks it (row scope, never one's own, only its preparer, a draft),
 * then the row exactly as there: the employee and the approved last working date, an active component, a valid signed
 * amount, the line kind and the notice period a notice adjustment needs (checkLine).
 */
export async function checkUploadRow(
  tx: Queryable,
  grant: AccessGrant,
  row: UploadRow,
  caches: UploadRowCaches,
): Promise<{ settlement: SettlementRow; line: CheckedLine } | { error: string }> {
  const code = row.employeeCode.trim().toUpperCase();
  if (!caches.employees.has(code)) {
    const e = (await tx.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, code])).rows[0];
    caches.employees.set(code, e ? { id: e.id, inScope: await canAccessEmployee(tx, grant, e.id) } : null);
  }
  const employee = caches.employees.get(code);
  if (!employee) return { error: 'UNKNOWN_EMPLOYEE' };
  // As every import reports a row outside the caller's row scope (imports/batch.ts rowErrorCode).
  if (!employee.inScope) return { error: 'OUT_OF_SCOPE' };
  const employeeId = employee.id;
  if (isSelf(grant, employeeId)) return { error: 'SELF_ACTION_NOT_ALLOWED' };
  const drafts = (
    await tx.query<{ id: string; last_working_date: string | null }>(
      `select s.id, to_char(x.approved_leaving_date, 'YYYY-MM-DD') as last_working_date
         from settlement s join exit_case x on x.company_id = s.company_id and x.id = s.exit_case_id
        where s.company_id = $1 and s.employee_id = $2 and s.state = 'DRAFT'`,
      [grant.companyId, employeeId],
    )
  ).rows;
  if (drafts.length === 0) return { error: 'NO_DRAFT_SETTLEMENT' };
  const draft = drafts.find((d) => d.last_working_date === row.lastWorkingDate.trim());
  if (!draft) return { error: 'DATE_MISMATCH' };
  const s = await lockSettlement(tx, grant, draft.id);
  if (s.state !== 'DRAFT') return { error: 'INVALID_STATE' };
  if (s.prepared_by !== grant.userId) return { error: 'NOT_PREPARER' };
  // I-88: a calculated draft takes entered lines with their reasons, never a wholesale upload.
  if (s.calculation_id) return { error: 'CALCULATED_REVISION' };
  const exit = (await exitFor(tx, grant.companyId, s.exit_case_id))!;
  if (!caches.paidInPayroll.has(s.id)) caches.paidInPayroll.set(s.id, await componentsPaidInFinalPayroll(tx, grant.companyId, s.employee_id, exit.approved_leaving_date));
  const line = await checkLine(
    tx,
    grant.companyId,
    caches.components,
    exit.contractual_notice_days !== null,
    { componentCode: row.componentCode, amount: row.amount, lineKind: row.lineKind.trim().toUpperCase() },
    caches.paidInPayroll.get(s.id),
  );
  return 'error' in line ? line : { settlement: s, line };
}

/**
 * Writes one checked bulk upload line: the first line of a settlement in the batch replaces the draft's lines (as the
 * one-settlement upload replaces them, source UPLOADED) after the preparation grant is checked again under the locks;
 * the last updates the net amount and audits the upload (counts only, never an amount).
 */
export async function writeUploadLine(tx: Queryable, grant: AccessGrant, s: SettlementRow, line: CheckedLine, at: { first: boolean; last: boolean; lineCount: number }) {
  if (at.first) {
    await reassertAccess(tx, grant, 'settlement', 'prepare', ['amount']);
    await tx.query(`delete from settlement_line where company_id = $1 and settlement_id = $2 and source <> 'CALCULATED'`, [grant.companyId, s.id]);
  }
  await tx.query(
    `insert into settlement_line (company_id, settlement_id, component_id, amount, line_kind, source, created_by, updated_by) values ($1, $2, $3, $4::numeric, $5, 'UPLOADED', $6, $6)`,
    [grant.companyId, s.id, line.componentId, line.amount, line.lineKind, grant.userId],
  );
  if (at.last) {
    await refreshNet(tx, grant, s.id);
    await audit(tx, actorOf(grant), 'settlement', s.id, 'UPLOAD', null, {
      operational: { template: UPLOAD_TEMPLATE, revision: s.revision, rows: at.lineCount, accepted: at.lineCount, rejected: 0, applied: true, bulk: true },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// FR-054 "optional uploaded-list selection" (docs/03 I-48 item 16, I-81 item 7; decided under owner delegation, 6 Nov 2026)
// ---------------------------------------------------------------------------------------------------------------

export const SELECTION_TEMPLATE = 'SETTLEMENT_SELECTION_V1';
/** The exact header of an uploaded selection list (served at GET /settlements/selection/template). */
export const SELECTION_HEADER = ['employee_code'] as const;
/** DF09's initial batch bound (10,000 rows); nothing larger is read. */
const MAX_SELECTION_ROWS = 10_000;

/**
 * Selects settlements by an uploaded list of employee codes. Matching rules: one column, `employee_code`; each code is trimmed and
 * compared exactly, ignoring case (employee codes are stored in capitals), never partly or by name; a blank row is INVALID_CODE;
 * a code repeated is matched once and the later rows are DUPLICATE; a code that names no employee, an employee outside the caller's
 * row scope or the caller's own record is NOT_FOUND alike (a list never tells who exists outside one's scope); an employee with no
 * settlement passing the list's other filters is NO_SETTLEMENT; otherwise MATCHED with the number of settlements. The result is the
 * settlement list (the same rows, columns and amount rule as GET /settlements, every revision, unpaged) restricted to the matched
 * employees, which the screen offers for the ZIP output. The file is scanned in memory before reading (FR-106) and never stored;
 * a read, so nothing is audited but the selection's counts.
 */
export async function selectFromUploadedList(
  db: Queryable,
  grant: AccessGrant,
  verdict: ScanVerdict,
  input: { contentBase64: string; state?: string | undefined; lastWorkingMonth?: string | undefined; disbursementMonth?: string | undefined },
) {
  if (verdict.verdict === 'INFECTED') throw new HttpError(422, 'UPLOAD_QUARANTINED', 'The malware scan flagged the file; it was not read');
  if (verdict.verdict !== 'CLEAN') throw new HttpError(503, 'SCAN_UNAVAILABLE', 'The file could not be scanned now; try again later');
  let rows: string[][];
  try {
    rows = parseCsv(Buffer.from(input.contentBase64, 'base64').toString('utf8'));
  } catch (e) {
    if (e instanceof CsvError) throw new HttpError(422, 'INVALID_FILE', 'The file is not valid CSV');
    throw e;
  }
  const header = rows[0]?.map((h) => h.trim().toLowerCase());
  if (!header || header.join(',') !== SELECTION_HEADER.join(',')) {
    throw new HttpError(422, 'INVALID_TEMPLATE', `The file must use the ${SELECTION_TEMPLATE} header`, { expected: SELECTION_HEADER });
  }
  const data = rows.slice(1);
  if (data.length === 0) throw new HttpError(422, 'EMPTY_FILE', 'The file has no employee codes');
  if (data.length > MAX_SELECTION_ROWS) throw new HttpError(422, 'TOO_MANY_ROWS', `At most ${MAX_SELECTION_ROWS} rows per list`);
  const codes = [...new Set(data.map((cells) => (cells.length === 1 ? (cells[0] ?? '').trim().toUpperCase() : '')).filter((c) => c !== ''))];
  const params = new SqlParams([grant.companyId, codes]);
  const inScope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const self = grant.linkedEmployeeId ? `and e.id <> ${params.add(grant.linkedEmployeeId)}::uuid` : '';
  const found = new Map(
    (await db.query<{ id: string; code: string }>(`select e.id, e.employee_code as code from employee e where e.company_id = $1 and e.employee_code = any($2::text[]) and ${inScope} ${self}`, params.values)).rows.map(
      (r) => [r.code, r.id],
    ),
  );
  // Every match, read page by page (the unpaged list stops at its cap).
  const items: Awaited<ReturnType<typeof listSettlements>>['items'] = [];
  const filter = { state: input.state, lastWorkingMonth: input.lastWorkingMonth, disbursementMonth: input.disbursementMonth, employeeIds: [...found.values()] };
  for (let page = 1; ; page++) {
    const next = await listSettlements(db, grant, { ...filter, page, pageSize: 100 });
    items.push(...next.items);
    if (next.items.length < 100 || items.length >= next.total) break;
  }
  const perEmployee = new Map<string, number>();
  for (const s of items) perEmployee.set(s.employeeId, (perEmployee.get(s.employeeId) ?? 0) + 1);
  const seen = new Set<string>();
  const results = data.map((cells, i) => {
    const code = cells.length === 1 ? (cells[0] ?? '').trim().toUpperCase() : '';
    const row = i + 2;
    if (code === '') return { row, employeeCode: null, outcome: 'INVALID_CODE', settlements: 0 };
    if (seen.has(code)) return { row, employeeCode: code, outcome: 'DUPLICATE', settlements: 0 };
    seen.add(code);
    const id = found.get(code);
    if (!id) return { row, employeeCode: code, outcome: 'NOT_FOUND', settlements: 0 };
    const n = perEmployee.get(id) ?? 0;
    return { row, employeeCode: code, outcome: n > 0 ? 'MATCHED' : 'NO_SETTLEMENT', settlements: n };
  });
  return {
    template: SELECTION_TEMPLATE,
    rows: results,
    total: data.length,
    matched: results.filter((r) => r.outcome === 'MATCHED').length,
    calculation: CALCULATION_STATUS,
    items,
  };
}
