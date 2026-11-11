// Challan master (CL-074) and monthly TDS challans (CL-081), under FR-039 (statutory outputs) and FR-038. Built 11 Nov 2026 from the
// reference system's "Challan Master" and "TDS Challan Entry" screens; decided under owner delegation, 6 Nov 2026.
//
// Challan master: per statute (TDS, PF, ESIC) the company's deposit particulars: the TAN (TDS), the establishment code (PF, ESIC), the
// bank, its branch and BSR code. Dated revisions, never overwritten (0270): the revision in force on a day is the latest effective on or
// before it, the highest revision among those of one date. Company configuration: an unrestricted company-scope assignment holding
// payroll_challan.manage records one, with a reason; every revision is audited.
//
// TDS challans: one per deposit, as the bank's challan states it: the BSR code, the date of deposit and the challan serial number
// (together the challan identification number), the month whose deductions it deposits, the section and the amount. Entered on screen
// or uploaded (TDS_CHALLAN_V1 through the import framework). A challan is never edited: a wrong one is cancelled with a reason and
// entered again, and a BSR code, date and serial is recorded once. Neither a future month nor a future deposit date is accepted. The
// amounts deposited are company payroll figures: the challan read duty (operational) lists the challans, and their amounts and monthly
// totals only to an assignment that also holds payroll_report.read.amount company-wide; anyone else reads them null (amountsHidden).
//
// Link to Form 24Q: FORM_24Q stays NOT_CONFIGURED (payroll-outputs/reports.ts: the return needs the TAN, deductee PANs, challan details
// and the owner's template). The challans are reconciled, month by month, against the Form 24Q working data (tdsRegister: TDS deducted
// from processed payroll and paid final settlements), read-only and without changing it: the reconciliation needs the payroll report
// grant as well, and company scope, since it compares company totals.
import type pg from 'pg';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { markRepeats, parseTemplate, RowError, type Template } from '../imports/batch.js';
import type { BatchSpec } from '../imports/jobs.js';
import { tdsRegister } from '../payroll-outputs/reports.js';
import { fromUnits, toUnits } from '../lifecycle/settlement-formulas.js';
import { AMOUNT, auditChange, isIsoDate, linkedAndPaidBetween, MONTH, optionalText, requireCompanyWide, requireFiscalYear, requireText } from './common.js';

export const CHALLAN_STATUTES = ['TDS', 'PF', 'ESIC'] as const;
export type ChallanStatute = (typeof CHALLAN_STATUTES)[number];

const TAN = /^[A-Z]{4}[0-9]{5}[A-Z]$/;
const ESTABLISHMENT = /^[A-Z0-9/-]{5,30}$/;
const BSR = /^[0-9]{7}$/;
const SERIAL = /^[0-9]{1,5}$/;
const SECTION = /^[0-9A-Z]{1,10}$/;

// ---------------------------------------------------------------------------------------------------------------
// Challan master
// ---------------------------------------------------------------------------------------------------------------
const SETTING_VIEW = `select s.id, s.statute, s.revision, to_char(s.effective_from, 'YYYY-MM-DD') as "effectiveFrom", s.tan, s.establishment_code as "establishmentCode",
    s.bank_name as "bankName", s.bank_branch as "bankBranch", s.bsr_code as "bsrCode", s.reason, s.created_at as "createdAt", s.created_by as "createdBy"
  from payroll_challan_setting s`;

/** Every revision, newest first per statute, and the revision of each statute in force on `day` (null where none is). */
export async function listChallanSettings(db: Queryable, grant: AccessGrant, day: string) {
  const items = (await db.query(`${SETTING_VIEW} where s.company_id = $1 order by s.statute, s.effective_from desc, s.revision desc`, [grant.companyId])).rows as {
    statute: ChallanStatute;
    effectiveFrom: string;
  }[];
  const inForce = Object.fromEntries(CHALLAN_STATUTES.map((st) => [st, items.find((i) => i.statute === st && i.effectiveFrom <= day) ?? null]));
  return { asOf: day, inForce, items };
}

export interface ChallanSettingInput {
  statute: ChallanStatute;
  effectiveFrom: string;
  tan?: string | null | undefined;
  establishmentCode?: string | null | undefined;
  bankName: string;
  bankBranch?: string | null | undefined;
  bsrCode?: string | null | undefined;
  reason: string;
}

export async function createChallanSetting(tx: Queryable, grant: AccessGrant, input: ChallanSettingInput) {
  requireCompanyWide(grant);
  if (!isIsoDate(input.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'effectiveFrom must be a date (YYYY-MM-DD)', { field: 'effectiveFrom' });
  const tan = optionalText(input.tan, 'tan', 10)?.toUpperCase() ?? null;
  const establishment = optionalText(input.establishmentCode, 'establishmentCode', 30)?.toUpperCase() ?? null;
  const bsr = optionalText(input.bsrCode, 'bsrCode', 7);
  if (input.statute === 'TDS') {
    if (!tan || !TAN.test(tan)) throw new HttpError(422, 'INVALID_TAN', 'A TDS challan setting needs the TAN: four letters, five digits and a letter (for example ABCD12345E)', { field: 'tan' });
    if (establishment) throw new HttpError(422, 'INVALID_VALUE', 'An establishment code belongs to PF or ESIC, not TDS', { field: 'establishmentCode' });
  } else {
    if (!establishment || !ESTABLISHMENT.test(establishment)) {
      throw new HttpError(422, 'INVALID_ESTABLISHMENT_CODE', `A ${input.statute} challan setting needs the establishment code (5 to 30 letters, digits, / or -)`, { field: 'establishmentCode' });
    }
    if (tan) throw new HttpError(422, 'INVALID_VALUE', 'The TAN belongs to TDS', { field: 'tan' });
  }
  if (bsr !== null && !BSR.test(bsr)) throw new HttpError(422, 'INVALID_BSR_CODE', 'A BSR code is 7 digits', { field: 'bsrCode' });
  const bankName = requireText(input.bankName, 'bankName', 120);
  const bankBranch = optionalText(input.bankBranch, 'bankBranch', 120);
  const reason = requireText(input.reason, 'reason', 500);
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_challan_setting:${grant.companyId}:${input.statute}`]);
  const row = (
    await tx.query<{ id: string; revision: number }>(
      `insert into payroll_challan_setting (company_id, statute, revision, effective_from, tan, establishment_code, bank_name, bank_branch, bsr_code, reason, created_by, acting_assignment_id)
       select $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6, $7, $8, $9, $10, $11 from payroll_challan_setting where company_id = $1 and statute = $2
       returning id, revision`,
      [grant.companyId, input.statute, input.effectiveFrom, tan, establishment, bankName, bankBranch, bsr, reason, grant.userId, grant.assignmentId],
    )
  ).rows[0]!;
  await auditChange(tx, grant, {
    resource: 'payroll_challan_setting',
    recordKey: row.id,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { statute: input.statute, revision: row.revision, effectiveFrom: input.effectiveFrom, tan, establishmentCode: establishment, bankName, bankBranch, bsrCode: bsr } },
    reason,
  });
  return (await tx.query(`${SETTING_VIEW} where s.company_id = $1 and s.id = $2`, [grant.companyId, row.id])).rows[0]!;
}

// ---------------------------------------------------------------------------------------------------------------
// TDS challans
// ---------------------------------------------------------------------------------------------------------------
const CHALLAN_VIEW = `select c.id, to_char(c.month, 'YYYY-MM') as month, c.section, c.bsr_code as "bsrCode", c.challan_serial as "challanSerial",
    to_char(c.deposit_date, 'YYYY-MM-DD') as "depositDate", c.amount::text as amount, c.source, c.import_job_id as "importJobId", c.state,
    c.cancel_reason as "cancelReason", c.cancelled_at as "cancelledAt", c.created_at as "createdAt", c.version
  from payroll_tds_challan c`;

export interface TdsChallanInput {
  month: string;
  section: string;
  bsrCode: string;
  challanSerial: string;
  depositDate: string;
  amount: string;
}

/** The problem with a challan's values, as a code (the import's row error and the screen's 422 alike), or the normalised values. */
function checkedChallan(grant: AccessGrant, input: TdsChallanInput): { ok: false; code: string; message: string } | { ok: true; value: TdsChallanInput } {
  const fail = (code: string, message: string) => ({ ok: false as const, code, message });
  const month = (input.month ?? '').trim();
  if (!MONTH.test(month)) return fail('INVALID_MONTH', 'The month must be written YYYY-MM');
  if (month > grant.businessDate.slice(0, 7)) return fail('FUTURE_MONTH', 'This month has not started yet');
  const section = (input.section ?? '').trim().toUpperCase();
  if (!SECTION.test(section)) return fail('INVALID_SECTION', 'The section is 1 to 10 letters or digits, for example 192');
  const bsr = (input.bsrCode ?? '').trim();
  if (!BSR.test(bsr)) return fail('INVALID_BSR_CODE', 'A BSR code is 7 digits');
  const serial = (input.challanSerial ?? '').trim();
  if (!SERIAL.test(serial)) return fail('INVALID_CHALLAN_SERIAL', 'The challan serial number is up to 5 digits');
  const deposit = (input.depositDate ?? '').trim();
  if (!isIsoDate(deposit)) return fail('INVALID_DEPOSIT_DATE', 'The deposit date must be a date (YYYY-MM-DD)');
  if (deposit > grant.businessDate) return fail('FUTURE_DEPOSIT_DATE', 'The deposit date is after today');
  if (deposit < `${month}-01`) return fail('DEPOSIT_BEFORE_MONTH', 'Tax of a month is deposited on or after the first day of that month');
  const amount = (input.amount ?? '').trim();
  if (!AMOUNT.test(amount) || toUnits(amount) <= 0n) return fail('INVALID_AMOUNT', 'The amount is a number above zero with at most 2 decimals');
  return { ok: true, value: { month, section, bsrCode: bsr, challanSerial: serial.padStart(5, '0'), depositDate: deposit, amount } };
}

/** Records one challan (screen or upload row); a challan already recorded under the BSR code, date and serial is refused. */
async function insertChallan(tx: Queryable, grant: AccessGrant, v: TdsChallanInput, source: 'SCREEN' | 'IMPORT', importJobId: string | null) {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`payroll_tds_challan:${grant.companyId}:${v.bsrCode}:${v.depositDate}:${v.challanSerial}`]);
  const exists = await tx.query(`select 1 from payroll_tds_challan where company_id = $1 and bsr_code = $2 and deposit_date = $3 and challan_serial = $4 and state = 'RECORDED'`, [
    grant.companyId,
    v.bsrCode,
    v.depositDate,
    v.challanSerial,
  ]);
  if (exists.rowCount) return null;
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_tds_challan (company_id, month, section, bsr_code, challan_serial, deposit_date, amount, source, import_job_id, created_by, acting_assignment_id)
       values ($1, ($2 || '-01')::date, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [grant.companyId, v.month, v.section, v.bsrCode, v.challanSerial, v.depositDate, v.amount, source, importJobId, grant.userId, grant.assignmentId],
    )
  ).rows[0]!.id;
  await auditChange(tx, grant, { resource: 'payroll_tds_challan', recordKey: id, action: 'CREATE', newVersion: 1, after: { operational: { ...v, source, importJobId } } });
  return id;
}

export async function recordTdsChallan(tx: Queryable, grant: AccessGrant, input: TdsChallanInput) {
  requireCompanyWide(grant);
  const checked = checkedChallan(grant, input);
  if (!checked.ok) throw new HttpError(422, checked.code, checked.message);
  const id = await insertChallan(tx, grant, checked.value, 'SCREEN', null);
  if (!id) throw new HttpError(409, 'CHALLAN_EXISTS', 'A challan with this BSR code, deposit date and serial number is already recorded');
  return (await tx.query(`${CHALLAN_VIEW} where c.company_id = $1 and c.id = $2`, [grant.companyId, id])).rows[0]!;
}

export async function cancelTdsChallan(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string; expectedVersion: number }) {
  requireCompanyWide(grant);
  const c = (await tx.query<{ state: string; version: number }>(`select state, version from payroll_tds_challan where company_id = $1 and id = $2 for update`, [grant.companyId, id])).rows[0];
  if (!c) throw notFound();
  if (c.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The challan changed; reload and retry');
  if (c.state !== 'RECORDED') throw new HttpError(409, 'INVALID_STATE', 'Only a recorded challan can be cancelled');
  const reason = requireText(input.reason, 'reason', 500);
  await tx.query(
    `update payroll_tds_challan set state = 'CANCELLED', cancel_reason = $3, cancelled_at = now(), cancelled_by = $4, version = version + 1 where company_id = $1 and id = $2`,
    [grant.companyId, id, reason, grant.userId],
  );
  await auditChange(tx, grant, { resource: 'payroll_tds_challan', recordKey: id, action: 'CANCEL', priorVersion: c.version, newVersion: c.version + 1, before: { operational: { state: 'RECORDED' } }, after: { operational: { state: 'CANCELLED' } }, reason });
  return (await tx.query(`${CHALLAN_VIEW} where c.company_id = $1 and c.id = $2`, [grant.companyId, id])).rows[0]!;
}

const add = (a: string, b: string) => fromUnits(toUnits(a) + toUnits(b));
const money = (units: bigint) => fromUnits(units);

/**
 * A challan as its reader may see it: the TDS deposited is a company payroll figure, so without the amount right (`amounts`, decided by
 * the route: payroll_report.read.amount, company-wide) its amount reads null and the answer says the amounts are hidden.
 */
export function challanAsSeen<T extends { amount?: unknown }>(row: T, amounts: boolean): T & { amountsHidden: boolean } {
  return amounts ? { ...row, amountsHidden: false } : { ...row, amount: null, amountsHidden: true };
}

/**
 * The challans of a financial year (every state), and the deposited total of each month (recorded challans only). Without `amounts`
 * (the route's decision, as challanAsSeen) every amount and total reads null, with amountsHidden.
 */
export async function listTdsChallans(db: Queryable, grant: AccessGrant, fiscalYear: string, opts: { amounts: boolean } = { amounts: true }) {
  const fy = requireFiscalYear(fiscalYear);
  const items = (
    await db.query<{ month: string; amount: string; state: string }>(`${CHALLAN_VIEW} where c.company_id = $1 and c.month between $2::date and $3::date order by c.month, c.deposit_date, c.bsr_code, c.challan_serial`, [
      grant.companyId,
      fy.from,
      fy.to,
    ])
  ).rows;
  const months = new Map<string, string>();
  for (const c of items) if (c.state === 'RECORDED') months.set(c.month, add(months.get(c.month) ?? '0', c.amount));
  const byMonth = [...months].sort(([a], [b]) => a.localeCompare(b));
  if (!opts.amounts) {
    return {
      fiscalYear,
      amountsHidden: true,
      items: items.map((c) => ({ ...c, amount: null })),
      months: byMonth.map(([month]) => ({ month, deposited: null })),
      deposited: null,
    };
  }
  return {
    fiscalYear,
    amountsHidden: false,
    items,
    months: byMonth.map(([month, deposited]) => ({ month, deposited })),
    deposited: [...months.values()].reduce(add, '0.0000'),
  };
}

/**
 * Month by month for a financial year: the TDS deducted (Form 24Q working data: processed payroll and paid final settlements) against
 * the TDS deposited (recorded challans), and the difference. Company figures: an unrestricted company scope, which tdsRegister then
 * reads company-wide.
 */
export async function tdsReconciliation(db: Queryable, grant: AccessGrant, fiscalYear: string) {
  requireCompanyWide(grant);
  const fy = requireFiscalYear(fiscalYear);
  // The register under it never reads one's own pay (C4), so a reconciler paid in the year would get company totals that silently
  // leave their own TDS out. Refused instead, as the statutory files refuse it (SELF_INCLUDED): someone else reconciles that year. Any
  // employee the user is or was linked to counts, paid by processed payroll or by a final settlement in the year (as the TDS quarterly
  // file's linkedInQuarter).
  if (await linkedAndPaidBetween(db, grant.companyId, grant.userId, fy.from, fy.to)) {
    throw new HttpError(403, 'SELF_INCLUDED', 'Your own pay is in this year’s TDS; someone else reconciles it');
  }
  const challans = await listTdsChallans(db, grant, fiscalYear);
  const deducted = new Map<string, string>();
  for (const quarter of [1, 2, 3, 4]) {
    const register = await tdsRegister(db, grant, { fiscalYear, quarter });
    for (const m of register.totals.months) deducted.set(m.month, add(deducted.get(m.month) ?? '0', m.tds));
  }
  const deposited = new Map(challans.months.map((m) => [m.month, m.deposited]));
  const months = [...new Set([...deducted.keys(), ...deposited.keys()])].sort();
  const rows = months.map((month) => {
    const d = toUnits(deducted.get(month) ?? '0');
    const p = toUnits(deposited.get(month) ?? '0');
    return { month, deducted: money(d), deposited: money(p), difference: money(d - p), status: d === p ? 'MATCHED' : d > p ? 'SHORT_DEPOSITED' : 'EXCESS_DEPOSITED' };
  });
  return {
    fiscalYear,
    form24Q: { status: 'NOT_CONFIGURED', reason: 'The Form 24Q return needs the TAN, deductee PANs and the owner’s template; this compares the challans with the working data it would be prepared from.' },
    months: rows,
    totals: {
      deducted: money(rows.reduce((s, r) => s + toUnits(r.deducted), 0n)),
      deposited: money(rows.reduce((s, r) => s + toUnits(r.deposited), 0n)),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// TDS_CHALLAN_V1 upload
// ---------------------------------------------------------------------------------------------------------------
const CHALLAN_COLUMNS = ['month', 'section', 'bsrCode', 'challanSerial', 'depositDate', 'amount'] as const;
type ChallanColumn = (typeof CHALLAN_COLUMNS)[number];
export const TDS_CHALLAN_TEMPLATE: Template<ChallanColumn> = { code: 'TDS_CHALLAN_V1', columns: CHALLAN_COLUMNS };
const challanKey = (row: Record<ChallanColumn, string>) => `${row.bsrCode}@${row.depositDate}@${row.challanSerial.padStart(5, '0')}`;

/** The upload's batch spec; `jobId` is the committing batch (null in a preview, which runs before the batch exists). */
export function tdsChallanSpec(jobId: string | null): BatchSpec<ChallanColumn> {
  return {
    kind: 'payroll_tds_challan',
    template: TDS_CHALLAN_TEMPLATE,
    parse: (bytes) => markRepeats(parseTemplate(bytes, TDS_CHALLAN_TEMPLATE), challanKey, 'DUPLICATE_IN_BATCH'),
    keyOf: (row, n) => (row.bsrCode ? challanKey(row) : `ROW-${n}`),
    async apply(client: pg.PoolClient, grant: AccessGrant, row) {
      const checked = checkedChallan(grant, row);
      if (!checked.ok) throw new RowError(checked.code);
      const id = await insertChallan(client, grant, checked.value, 'IMPORT', jobId);
      if (!id) throw new RowError('CHALLAN_EXISTS');
      return { amount: { from: null, to: checked.value.amount } };
    },
  };
}
