// Statutory filing files, batch R4 (BRD coverage CL-093 TDS quarterly summary, CL-105 PF new joiners, CL-106 EPFO ECR, CL-107 ESIC
// monthly and half-yearly; FR-036, FR-039, FR-107, FR-108; built 11 Nov 2026, decided under owner delegation, 6 Nov 2026): the
// outputs, their layouts, the row building and rendering, and the synthetic sample each format acceptance validates. Pure: nothing here
// reads the database or computes a statutory amount. Every figure is what a PROCESSED_LOCKED payroll run recorded (payroll_record_statutory
// with its pinned pack revision, the record's earnings, paid days and loss-of-pay days), only formatted for the layout. Where a value
// a layout needs was not recorded, the row says so (a row error), never a guess; a file with any row error is not produced (H2 "no
// partial final file").
//
// The layouts are transcriptions of published formats, to be checked by the owner's CA before any file is used (docs/03): the EPFO ECR
// 2.0 text file (fields separated by #~#, one member per line, no header line), the ESIC monthly contribution upload (IP number, IP
// name, days, wages, reason code, last working day) and summaries that are exports, not official forms (PF new joiners, ESIC
// half-yearly, TDS quarterly control totals, professional tax and labour welfare fund state summaries).
import { createHash } from 'node:crypto';
import { fromUnits, toUnits } from '../lifecycle/settlement-formulas.js';
import { cellText, csvCell, oneLine } from '../report/context.js';
import { PLAIN_DECIMAL, type SheetCell, sheetName, XLSX_MEDIA_TYPE, xlsxWorkbook } from '../report/xlsx.js';

export const OUTPUT_CODES = ['PF_ECR', 'PF_NEW_JOINERS', 'ESIC_MONTHLY', 'ESIC_HALF_YEARLY', 'TDS_QUARTERLY', 'PT_STATE_RETURN', 'LWF_STATE_RETURN'] as const;
export type OutputCode = (typeof OUTPUT_CODES)[number];
export const isOutputCode = (code: string): code is OutputCode => (OUTPUT_CODES as readonly string[]).includes(code);

/** RUN: one PROCESSED_LOCKED payroll run (a month); QUARTER and HALF_YEAR: every PROCESSED_LOCKED run whose month falls in it. */
export type PeriodKind = 'RUN' | 'QUARTER' | 'HALF_YEAR';
export type FileFormat = 'txt' | 'csv' | 'xlsx';
/** The statutory pack the output needs ACTIVE for its period: PF, ESIC, INCOME_TAX, or any PT_<state> / LWF_<state>. */
export type PackFamily = 'PF' | 'ESIC' | 'INCOME_TAX' | 'PT' | 'LWF';

export interface OutputDefinition {
  code: OutputCode;
  title: string;
  /** The BRD coverage line or requirement it answers. */
  clause: string;
  period: PeriodKind;
  packFamily: PackFamily;
  /** The file formats offered, the first the default. */
  formats: readonly FileFormat[];
  /** The file carries UAN or ESIC IP numbers: its download also needs employee.read.payroll_id. */
  identifiers: boolean;
  /** A portal upload layout: the file holds the layout only, so its source is in its name, never in a header comment. */
  upload: boolean;
  /** Raised whenever the rendered layout changes, with the sample hash; an acceptance of an earlier layout then no longer applies. */
  layoutVersion: number;
  notice: string;
}

export const OUTPUTS: Readonly<Record<OutputCode, OutputDefinition>> = {
  PF_ECR: {
    code: 'PF_ECR',
    title: 'EPFO ECR (electronic challan cum return)',
    clause: 'CL-106',
    period: 'RUN',
    packFamily: 'PF',
    formats: ['txt'],
    identifiers: true,
    upload: true,
    layoutVersion: 1,
    notice: 'ECR 2.0 text: one member per line, eleven fields separated by #~#, whole rupees, no header line. Upload it to the EPFO portal only after the CA has checked the format.',
  },
  PF_NEW_JOINERS: {
    code: 'PF_NEW_JOINERS',
    title: 'PF new joiners (Form 9 register)',
    clause: 'CL-105',
    period: 'RUN',
    packFamily: 'PF',
    formats: ['csv', 'xlsx'],
    identifiers: true,
    upload: false,
    layoutVersion: 1,
    notice: 'An export of the PF members who joined in the month, not the official Form 9.',
  },
  ESIC_MONTHLY: {
    code: 'ESIC_MONTHLY',
    title: 'ESIC monthly contribution file',
    clause: 'CL-107',
    period: 'RUN',
    packFamily: 'ESIC',
    formats: ['xlsx', 'csv'],
    identifiers: true,
    upload: true,
    layoutVersion: 1,
    notice: 'The ESIC portal’s monthly contribution upload: IP number, IP name, days paid, wages, reason code and last working day.',
  },
  ESIC_HALF_YEARLY: {
    code: 'ESIC_HALF_YEARLY',
    title: 'ESIC half-yearly contribution summary',
    clause: 'CL-107',
    period: 'HALF_YEAR',
    packFamily: 'ESIC',
    formats: ['csv', 'xlsx'],
    identifiers: true,
    upload: false,
    layoutVersion: 1,
    notice: 'Per insured person covered in the contribution period (April to September, October to March): wages and contributions from the processed payroll. A summary, not a return.',
  },
  TDS_QUARTERLY: {
    code: 'TDS_QUARTERLY',
    title: 'TDS quarterly summary (Form 27A control totals)',
    clause: 'CL-093',
    period: 'QUARTER',
    packFamily: 'INCOME_TAX',
    formats: ['csv', 'xlsx'],
    identifiers: false,
    upload: false,
    layoutVersion: 1,
    notice: 'Control totals beside Form 24Q: taxable salary paid and TDS deducted (the Form 24Q working data) against TDS deposited (recorded challans). Not the return.',
  },
  PT_STATE_RETURN: {
    code: 'PT_STATE_RETURN',
    title: 'Professional tax state summary',
    clause: 'FR-039',
    period: 'RUN',
    packFamily: 'PT',
    formats: ['csv', 'xlsx'],
    identifiers: false,
    upload: false,
    layoutVersion: 1,
    notice: 'Employees and tax per slab, per state, for the month. A summary to prepare the state return from, not a state filing form.',
  },
  LWF_STATE_RETURN: {
    code: 'LWF_STATE_RETURN',
    title: 'Labour welfare fund state summary',
    clause: 'FR-039',
    period: 'RUN',
    packFamily: 'LWF',
    formats: ['csv', 'xlsx'],
    identifiers: false,
    upload: false,
    layoutVersion: 1,
    notice: 'Employees and employee and employer contributions per slab, per state, for the month. A summary to prepare the state return from, not a state filing form.',
  },
};

export const MEDIA_TYPES: Readonly<Record<FileFormat, string>> = { txt: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xlsx: XLSX_MEDIA_TYPE };

// ---------------------------------------------------------------------------------------------------------------
// Recorded values
// ---------------------------------------------------------------------------------------------------------------
export type Rounding = 'HALF_UP_WHOLE' | 'UP_WHOLE';
const ROUNDINGS: readonly string[] = ['HALF_UP_WHOLE', 'UP_WHOLE'];
const UNIT = 10_000n;

/** A recorded non-negative decimal in ten-thousandths, or null when it is not one. */
function units(value: unknown): bigint | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const u = toUnits(value);
    return u < 0n ? null : u;
  } catch {
    return null;
  }
}

/** A recorded wage in whole rupees under the rounding the pack recorded (half up, or up to the next unit); null when unreadable. */
export function whole(value: unknown, rounding: Rounding): string | null {
  const u = units(value);
  if (u === null) return null;
  return (rounding === 'UP_WHOLE' ? (u + UNIT - 1n) / UNIT : (u + UNIT / 2n) / UNIT).toString();
}

/** A recorded amount that must already be whole (a contribution the pack rounded, a count of days): its whole units, or null. */
export function exactWhole(value: unknown): string | null {
  const u = units(value);
  return u === null || u % UNIT !== 0n ? null : (u / UNIT).toString();
}

/** A recorded amount with at most two decimals, written with exactly two; null otherwise (never rounded). */
export function twoDecimals(value: unknown): string | null {
  const u = units(value);
  return u === null || u % 100n !== 0n ? null : fromUnits(u).slice(0, -2);
}

/** A sum in ten-thousandths: two decimals when exact to the paisa, else four. */
const money = (u: bigint) => (u % 100n === 0n ? fromUnits(u).slice(0, -2) : fromUnits(u));
/** A count that may hold a fraction (days), without trailing zeros. */
const count = (u: bigint) => fromUnits(u).replace(/\.?0+$/, '');
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// ---------------------------------------------------------------------------------------------------------------
// Inputs, as the service reads them from a run
// ---------------------------------------------------------------------------------------------------------------
export interface StatutoryRow {
  /** The head's rule-pack code (PF_EMPLOYEE, ESIC_EMPLOYER, PROFESSIONAL_TAX, ...). */
  code: string;
  status: 'VALUED' | 'NOT_APPLICABLE';
  amount: string | null;
  /** As the calculation recorded it: packCode, packRevision, the wages, rounding, slab, reason. */
  workings: Record<string, unknown>;
}

export interface RunRecord {
  recordId: string;
  employeeId: string;
  employeeCode: string;
  name: string;
  joiningDate: string;
  /** The approved last working date the calculation took (the record's snapshot), if any. */
  leavingDate: string | null;
  /** The separation type of the exit that set it. */
  separationType: string | null;
  paidUnits: string;
  earnings: string;
  /** Unpaid leave and attendance loss-of-pay units of the record's segments. */
  lopUnits: string;
  periodCode: string;
  periodStart: string;
  periodEnd: string;
  statutory: StatutoryRow[];
}

/** The payroll identifiers on record (an empty object: none recorded; null: the sealed record could not be opened). */
export type IdentifierRead = { uan?: string; esicIpNumber?: string } | null;

export interface RowError {
  employeeCode: string;
  code: string;
  field?: string;
}

export interface Notice {
  code: string;
  count?: number;
  detail?: string;
}

export interface Column {
  key: string;
  header: string;
  numeric?: boolean;
}

export interface Table {
  title: string;
  columns: readonly Column[];
  rows: Record<string, string>[];
}

export interface Built {
  content: { kind: 'ECR'; lines: string[][] } | { kind: 'TABLE'; table: Table };
  errors: RowError[];
  warnings: Notice[];
  totals: Record<string, string | number>;
  /** The employees the file is about (C4: nobody produces a file holding their own pay). */
  employeeIds: string[];
  rowCount: number;
}

const rowsOf = (r: RunRecord, code: string) => r.statutory.filter((s) => s.code === code);

/** One error list per file; `at` binds the employee. */
function errorsFor(errors: RowError[], employeeCode: string) {
  let failed = false;
  const add = (code: string, field?: string) => {
    failed = true;
    errors.push({ employeeCode, code, ...(field ? { field } : {}) });
  };
  return { add, failed: () => failed };
}

/** The single row of a rule-pack code (two rows of one code cannot be told apart: a row error). */
function single(r: RunRecord, code: string, err: (code: string, field?: string) => void): StatutoryRow | null {
  const rows = rowsOf(r, code);
  if (rows.length > 1) err('DUPLICATE_STATUTORY_ROW', code);
  return rows.length === 1 ? rows[0]! : null;
}

/** A contribution as recorded: its amount when VALUED (it must be whole), 0 when nothing was due. */
function contribution(row: StatutoryRow, err: (code: string, field?: string) => void): string | null {
  if (row.status !== 'VALUED') return '0';
  const v = exactWhole(row.amount);
  if (v === null) err('AMOUNT_NOT_WHOLE', row.code);
  return v;
}

const UAN = /^[0-9]{12}$/;
const IP_NUMBER = /^[0-9]{10}$/;

function identifier(ids: ReadonlyMap<string, IdentifierRead>, employeeId: string, key: 'uan' | 'esicIpNumber', err: (code: string, field?: string) => void, required = true): string | null {
  // No row: nothing recorded ({}); a row that could not be opened is null, which `??` would hide.
  const read = ids.has(employeeId) ? ids.get(employeeId)! : {};
  const label = key === 'uan' ? 'UAN' : 'IP_NUMBER';
  if (read === null) {
    err('IDENTIFIERS_UNREADABLE', key);
    return null;
  }
  const value = read[key];
  if (!value) {
    if (required) err(`MISSING_${label}`, key);
    return null;
  }
  if (!(key === 'uan' ? UAN : IP_NUMBER).test(value)) {
    err(`INVALID_${label}`, key);
    return null;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// CL-106 EPFO ECR 2.0
// ---------------------------------------------------------------------------------------------------------------
export const ECR_SEPARATOR = '#~#';
/** The eleven ECR 2.0 fields, in order. */
export const ECR_FIELDS = [
  'UAN',
  'Member name',
  'Gross wages',
  'EPF wages',
  'EPS wages',
  'EDLI wages',
  'EPF contribution (employee)',
  'EPS contribution',
  'EPF-EPS difference (employer)',
  'NCP days',
  'Refund of advances',
] as const;

/**
 * One line per PF member of the run (a record with a PF_EMPLOYEE valuation, valued or nil): the UAN, the name, the month's gross
 * earnings and the PF, pension and EDLI wages in whole rupees under the rounding the PF pack recorded, the three contributions exactly as
 * recorded (whole already), the loss-of-pay days as non-contributory days, and no refund of advances (this payroll records none).
 */
export function buildEcr(records: readonly RunRecord[], ids: ReadonlyMap<string, IdentifierRead>): Built {
  const errors: RowError[] = [];
  const lines: string[][] = [];
  const employeeIds: string[] = [];
  const sum = { grossWages: 0n, epfWages: 0n, epsWages: 0n, edliWages: 0n, epfContribution: 0n, epsContribution: 0n, epfEpsDifference: 0n, ncpDays: 0n };
  for (const r of records) {
    if (rowsOf(r, 'PF_EMPLOYEE').length === 0) continue;
    employeeIds.push(r.employeeId);
    const e = errorsFor(errors, r.employeeCode);
    const employee = single(r, 'PF_EMPLOYEE', e.add);
    const pension = single(r, 'PF_EMPLOYER_EPS', e.add);
    const difference = single(r, 'PF_EMPLOYER_EPF', e.add);
    const edli = single(r, 'PF_EDLI', e.add);
    const uan = identifier(ids, r.employeeId, 'uan', e.add);
    const name = r.name.trim();
    if (name === '') e.add('MISSING_NAME', 'name');
    else if (/[#~\u0000-\u001f\u007f]/.test(name)) e.add('INVALID_NAME', 'name');
    if (!employee) continue;
    const rounding = String(employee.workings.rounding ?? '');
    if (!ROUNDINGS.includes(rounding)) {
      e.add('ROUNDING_NOT_RECORDED', 'PF_EMPLOYEE');
      continue;
    }
    const round = (value: unknown, code: string) => {
      const v = whole(value, rounding as Rounding);
      if (v === null) e.add(code);
      return v;
    };
    const gross = round(r.earnings, 'GROSS_WAGES_UNREADABLE');
    const epfWages = round(employee.workings.contributionWages, 'EPF_WAGES_NOT_RECORDED');
    // A head the company has not configured records nothing; the file cannot be written without it.
    if (rowsOf(r, 'PF_EMPLOYER_EPS').length === 0) e.add('EPS_NOT_RECORDED', 'PF_EMPLOYER_EPS');
    if (rowsOf(r, 'PF_EDLI').length === 0) e.add('EDLI_NOT_RECORDED', 'PF_EDLI');
    if (rowsOf(r, 'PF_EMPLOYER_EPF').length === 0) e.add('EPF_EPS_DIFFERENCE_NOT_RECORDED', 'PF_EMPLOYER_EPF');
    const epsWages = pension ? round(pension.workings.pensionWages, 'EPS_WAGES_NOT_RECORDED') : null;
    const edliWages = edli ? round(edli.workings.edliWages, 'EDLI_WAGES_NOT_RECORDED') : null;
    const epf = contribution(employee, e.add);
    const eps = pension ? contribution(pension, e.add) : null;
    const diff = difference ? contribution(difference, e.add) : null;
    const ncp = exactWhole(r.lopUnits);
    if (ncp === null) e.add('NCP_DAYS_NOT_WHOLE', 'ncpDays');
    if (e.failed() || !uan || gross === null || epfWages === null || epsWages === null || edliWages === null || epf === null || eps === null || diff === null || ncp === null) continue;
    lines.push([uan, name, gross, epfWages, epsWages, edliWages, epf, eps, diff, ncp, '0']);
    sum.grossWages += BigInt(gross);
    sum.epfWages += BigInt(epfWages);
    sum.epsWages += BigInt(epsWages);
    sum.edliWages += BigInt(edliWages);
    sum.epfContribution += BigInt(epf);
    sum.epsContribution += BigInt(eps);
    sum.epfEpsDifference += BigInt(diff);
    sum.ncpDays += BigInt(ncp);
  }
  return {
    content: { kind: 'ECR', lines },
    errors,
    warnings: [{ code: 'REFUND_OF_ADVANCES_NOT_RECORDED', detail: 'Refund of advances is written 0: this payroll records no refund of PF advances.' }],
    totals: { members: employeeIds.length, ...Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, v.toString()])) },
    employeeIds,
    rowCount: lines.length,
  };
}

export function renderEcr(lines: readonly string[][]): string {
  // No header line and no line ending after the last member (ECR 2.0 as the EPFO validator reads it; the CA checks this).
  return lines.map((l) => l.join(ECR_SEPARATOR)).join('\r\n');
}

// ---------------------------------------------------------------------------------------------------------------
// CL-107 ESIC monthly contribution file
// ---------------------------------------------------------------------------------------------------------------
/** ESIC reason codes for a member who left in the month (the portal's list: 2 left service, 3 retired, 5 expired). */
export const ESIC_LEAVING_REASON: Readonly<Record<string, string>> = { RETIREMENT: '3', DEATH: '5' };
const ESIC_LEFT_SERVICE = '2';

export const ESIC_MONTHLY_COLUMNS: readonly Column[] = [
  { key: 'ipNumber', header: 'IP Number (10 Digits)' },
  { key: 'ipName', header: 'IP Name (Only alphabets and space)' },
  { key: 'days', header: 'No of Days for which wages paid/payable during the month', numeric: true },
  { key: 'wages', header: 'Total Monthly Wages', numeric: true },
  { key: 'reasonCode', header: 'Reason Code for Zero workings days (numeric only; provide 0 for all other reasons)', numeric: true },
  { key: 'lastWorkingDay', header: 'Last Working Day (Format DD/MM/YYYY or DD-MM-YYYY)' },
];

/** Covered: ESIC was valued, or nothing was due at nil wages; an employee above the ceiling (NOT_COVERED) is not an insured person. */
const esicCovered = (row: StatutoryRow) => row.status === 'VALUED' || row.workings.reason !== 'NOT_COVERED';

function esicName(name: string, add: (code: string, field?: string) => void): string {
  const v = name.trim();
  if (v === '') add('MISSING_NAME', 'name');
  else if (!/^[A-Za-z ]+$/.test(v)) add('NAME_NOT_ALPHABETIC', 'name');
  return v;
}

/**
 * One row per insured person of the run: the IP number and name, the days paid, the ESIC wages exactly as recorded (two decimals), and
 * the reason code: 0, or for a member who left in the month the code of the separation (2 left service, 3 retired, 5 expired) with the
 * last working day. A covered member paid for no day who did not leave has no recorded reason: a row error.
 */
export function buildEsicMonthly(records: readonly RunRecord[], ids: ReadonlyMap<string, IdentifierRead>): Built {
  const errors: RowError[] = [];
  const rows: Record<string, string>[] = [];
  const employeeIds: string[] = [];
  let notCovered = 0;
  let wages = 0n;
  let employeeShare = 0n;
  let employerShare = 0n;
  for (const r of records) {
    const all = rowsOf(r, 'ESIC_EMPLOYEE');
    if (all.length === 0) continue;
    if (!all.some(esicCovered)) {
      notCovered += 1;
      continue;
    }
    employeeIds.push(r.employeeId);
    const e = errorsFor(errors, r.employeeCode);
    const employee = single(r, 'ESIC_EMPLOYEE', e.add);
    const employer = single(r, 'ESIC_EMPLOYER', e.add);
    const ip = identifier(ids, r.employeeId, 'esicIpNumber', e.add);
    const name = esicName(r.name, e.add);
    const days = exactWhole(r.paidUnits);
    if (days === null) e.add('DAYS_NOT_WHOLE', 'days');
    const recorded = employee?.workings.esicWages;
    const w = twoDecimals(recorded);
    if (employee && recorded === undefined) e.add('ESIC_WAGES_NOT_RECORDED', 'wages');
    else if (employee && w === null) e.add('WAGES_PRECISION', 'wages');
    const left = r.leavingDate !== null && r.leavingDate >= r.periodStart && r.leavingDate <= r.periodEnd;
    const reasonCode = left ? (ESIC_LEAVING_REASON[r.separationType ?? ''] ?? ESIC_LEFT_SERVICE) : '0';
    if (!left && days === '0') e.add('REASON_CODE_NOT_RECORDED', 'reasonCode');
    if (e.failed() || !employee || !ip || days === null || w === null) continue;
    rows.push({ ipNumber: ip, ipName: name, days, wages: w, reasonCode, lastWorkingDay: left ? dmy(r.leavingDate!) : '' });
    wages += toUnits(w);
    if (employee.status === 'VALUED' && employee.amount) employeeShare += toUnits(employee.amount);
    if (employer?.status === 'VALUED' && employer.amount) employerShare += toUnits(employer.amount);
  }
  return {
    content: { kind: 'TABLE', table: { title: 'ESIC monthly contribution', columns: ESIC_MONTHLY_COLUMNS, rows } },
    errors,
    warnings: notCovered > 0 ? [{ code: 'NOT_COVERED', count: notCovered, detail: 'Employees above the ESIC wage ceiling are not insured persons and are not in the file.' }] : [],
    totals: { insuredPersons: employeeIds.length, wages: money(wages), employeeContribution: money(employeeShare), employerContribution: money(employerShare) },
    employeeIds,
    rowCount: rows.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CL-107 ESIC half-yearly summary
// ---------------------------------------------------------------------------------------------------------------
export const ESIC_HALF_YEARLY_COLUMNS: readonly Column[] = [
  { key: 'ipNumber', header: 'IP number' },
  { key: 'ipName', header: 'IP name' },
  { key: 'employeeCode', header: 'Employee code' },
  { key: 'months', header: 'Months contributed', numeric: true },
  { key: 'days', header: 'Days paid', numeric: true },
  { key: 'wages', header: 'Wages', numeric: true },
  { key: 'employeeContribution', header: 'Employee contribution', numeric: true },
  { key: 'employerContribution', header: 'Employer contribution', numeric: true },
  { key: 'totalContribution', header: 'Total contribution', numeric: true },
];

/** Per insured person covered in any month of the contribution period, the period's wages and contributions as the runs recorded them. */
export function buildEsicHalfYear(records: readonly RunRecord[], ids: ReadonlyMap<string, IdentifierRead>): Built {
  const errors: RowError[] = [];
  const rows: Record<string, string>[] = [];
  const byEmployee = new Map<string, RunRecord[]>();
  for (const r of records) {
    if (!rowsOf(r, 'ESIC_EMPLOYEE').some(esicCovered)) continue;
    byEmployee.set(r.employeeId, [...(byEmployee.get(r.employeeId) ?? []), r]);
  }
  const total = { wages: 0n, employee: 0n, employer: 0n };
  for (const [employeeId, list] of [...byEmployee].sort(([, a], [, b]) => a[0]!.employeeCode.localeCompare(b[0]!.employeeCode))) {
    const first = list[0]!;
    const e = errorsFor(errors, first.employeeCode);
    const ip = identifier(ids, employeeId, 'esicIpNumber', e.add);
    const name = esicName(first.name, e.add);
    const months = new Set<string>();
    let days = 0n;
    let wages = 0n;
    let employeeShare = 0n;
    let employerShare = 0n;
    for (const r of list) {
      const employee = single(r, 'ESIC_EMPLOYEE', e.add);
      const employer = single(r, 'ESIC_EMPLOYER', e.add);
      months.add(r.periodCode);
      const paid = units(r.paidUnits);
      if (paid === null) e.add('DAYS_UNREADABLE', r.periodCode);
      else days += paid;
      const w = units(employee?.workings.esicWages);
      if (w === null) e.add('ESIC_WAGES_NOT_RECORDED', r.periodCode);
      else wages += w;
      if (employee?.status === 'VALUED' && employee.amount) employeeShare += toUnits(employee.amount);
      if (employer?.status === 'VALUED' && employer.amount) employerShare += toUnits(employer.amount);
    }
    if (e.failed() || !ip) continue;
    rows.push({
      ipNumber: ip,
      ipName: name,
      employeeCode: first.employeeCode,
      months: String(months.size),
      days: count(days),
      wages: money(wages),
      employeeContribution: money(employeeShare),
      employerContribution: money(employerShare),
      totalContribution: money(employeeShare + employerShare),
    });
    total.wages += wages;
    total.employee += employeeShare;
    total.employer += employerShare;
  }
  return {
    content: { kind: 'TABLE', table: { title: 'ESIC half-yearly summary', columns: ESIC_HALF_YEARLY_COLUMNS, rows } },
    errors,
    warnings: [],
    totals: { insuredPersons: byEmployee.size, wages: money(total.wages), employeeContribution: money(total.employee), employerContribution: money(total.employer) },
    employeeIds: [...byEmployee.keys()],
    rowCount: rows.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// CL-105 PF new joiners
// ---------------------------------------------------------------------------------------------------------------
/** The father's (else the spouse's) name on the employee's family section, with the relation F or S. */
export interface Relative {
  name: string;
  relation: 'F' | 'S';
}

/**
 * The PF members of the run who joined in its month: employee code, UAN (blank while none is recorded yet, as for a member still to be
 * registered), name and date of joining; the father's or spouse's name only when the caller may read the family section
 * (`relatives` not null), otherwise those columns are left out and the file says so.
 */
export function buildNewJoiners(records: readonly RunRecord[], ids: ReadonlyMap<string, IdentifierRead>, relatives: ReadonlyMap<string, Relative> | null): Built {
  const errors: RowError[] = [];
  const rows: Record<string, string>[] = [];
  const employeeIds: string[] = [];
  let withoutUan = 0;
  for (const r of records) {
    if (rowsOf(r, 'PF_EMPLOYEE').length === 0 || r.joiningDate < r.periodStart || r.joiningDate > r.periodEnd) continue;
    employeeIds.push(r.employeeId);
    const e = errorsFor(errors, r.employeeCode);
    const uan = identifier(ids, r.employeeId, 'uan', e.add, false);
    if (!uan && ids.get(r.employeeId) !== null && !ids.get(r.employeeId)?.uan) withoutUan += 1;
    const name = r.name.trim();
    if (name === '') e.add('MISSING_NAME', 'name');
    if (e.failed()) continue;
    const relative = relatives?.get(r.employeeId);
    rows.push({
      employeeCode: r.employeeCode,
      uan: uan ?? '',
      name,
      joiningDate: dmy(r.joiningDate),
      ...(relatives ? { relativeName: relative?.name ?? '', relation: relative?.relation ?? '' } : {}),
    });
  }
  const columns: Column[] = [
    { key: 'employeeCode', header: 'Employee code' },
    { key: 'uan', header: 'UAN' },
    { key: 'name', header: 'Member name' },
    { key: 'joiningDate', header: 'Date of joining' },
    ...(relatives ? [{ key: 'relativeName', header: 'Father’s or spouse’s name' }, { key: 'relation', header: 'Relation (F or S)' }] : []),
  ];
  const warnings: Notice[] = [];
  if (withoutUan > 0) warnings.push({ code: 'UAN_NOT_RECORDED', count: withoutUan, detail: 'Members without a UAN on record are listed with a blank UAN.' });
  if (!relatives) warnings.push({ code: 'RELATIVE_NAME_OMITTED', detail: 'The father’s or spouse’s name is held in the confidential family section, which this assignment does not read; the columns are left out.' });
  return { content: { kind: 'TABLE', table: { title: 'PF new joiners', columns, rows } }, errors, warnings, totals: { newJoiners: employeeIds.length }, employeeIds, rowCount: rows.length };
}

// ---------------------------------------------------------------------------------------------------------------
// CL-093 TDS quarterly summary, Form 27A control totals beside Form 24Q
// ---------------------------------------------------------------------------------------------------------------
export interface TdsRegisterItem {
  employeeId: string;
  months: { month: string; taxableSalary: string; tds: string }[];
}
export interface ChallanRow {
  month: string;
  amount: string;
  state: string;
}

export const TDS_QUARTER_COLUMNS: readonly Column[] = [
  { key: 'month', header: 'Month' },
  { key: 'employees', header: 'Employees paid', numeric: true },
  { key: 'deductees', header: 'Deductees (TDS deducted)', numeric: true },
  { key: 'taxableSalary', header: 'Taxable salary paid', numeric: true },
  { key: 'tdsDeducted', header: 'TDS deducted', numeric: true },
  { key: 'challans', header: 'Challans', numeric: true },
  { key: 'tdsDeposited', header: 'TDS deposited', numeric: true },
  { key: 'difference', header: 'Difference (deducted - deposited)', numeric: true },
];

/** Month by month and for the quarter: from the Form 24Q working data (tdsRegister) and the recorded (not cancelled) challans. */
export function buildTdsQuarter(months: readonly string[], items: readonly TdsRegisterItem[], challans: readonly ChallanRow[]): Built {
  const rows: Record<string, string>[] = [];
  const paid = new Set<string>();
  const deductees = new Set<string>();
  const sum = { taxable: 0n, tds: 0n, deposited: 0n, challans: 0 };
  for (const month of months) {
    const perEmployee = new Map<string, { taxable: bigint; tds: bigint }>();
    for (const item of items) {
      for (const m of item.months.filter((x) => x.month === month)) {
        const t = perEmployee.get(item.employeeId) ?? { taxable: 0n, tds: 0n };
        perEmployee.set(item.employeeId, { taxable: t.taxable + toUnits(m.taxableSalary), tds: t.tds + toUnits(m.tds) });
      }
    }
    const recorded = challans.filter((c) => c.month === month && c.state === 'RECORDED');
    const taxable = [...perEmployee.values()].reduce((s, v) => s + v.taxable, 0n);
    const tds = [...perEmployee.values()].reduce((s, v) => s + v.tds, 0n);
    const deposited = recorded.reduce((s, c) => s + toUnits(c.amount), 0n);
    const monthDeductees = [...perEmployee].filter(([, v]) => v.tds > 0n).map(([id]) => id);
    for (const id of perEmployee.keys()) paid.add(id);
    for (const id of monthDeductees) deductees.add(id);
    rows.push({
      month,
      employees: String(perEmployee.size),
      deductees: String(monthDeductees.length),
      taxableSalary: money(taxable),
      tdsDeducted: money(tds),
      challans: String(recorded.length),
      tdsDeposited: money(deposited),
      difference: money(tds - deposited),
    });
    sum.taxable += taxable;
    sum.tds += tds;
    sum.deposited += deposited;
    sum.challans += recorded.length;
  }
  const totals = {
    employees: paid.size,
    deductees: deductees.size,
    taxableSalary: money(sum.taxable),
    tdsDeducted: money(sum.tds),
    challans: sum.challans,
    tdsDeposited: money(sum.deposited),
    difference: money(sum.tds - sum.deposited),
  };
  rows.push({ month: 'QUARTER', ...Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, String(v)])) });
  return {
    content: { kind: 'TABLE', table: { title: 'TDS quarterly summary', columns: TDS_QUARTER_COLUMNS, rows } },
    errors: [],
    warnings: sum.tds !== sum.deposited ? [{ code: sum.tds > sum.deposited ? 'SHORT_DEPOSITED' : 'EXCESS_DEPOSITED', detail: 'TDS deducted and deposited differ for the quarter.' }] : [],
    totals,
    employeeIds: [...paid],
    rowCount: rows.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Professional tax and labour welfare fund state summaries
// ---------------------------------------------------------------------------------------------------------------
export const PT_COLUMNS: readonly Column[] = [
  { key: 'state', header: 'State' },
  { key: 'slab', header: 'Slab' },
  { key: 'upTo', header: 'Monthly gross up to' },
  { key: 'employees', header: 'Employees', numeric: true },
  { key: 'perEmployee', header: 'Tax per employee' },
  { key: 'tax', header: 'Tax', numeric: true },
];

export const LWF_COLUMNS: readonly Column[] = [
  { key: 'state', header: 'State' },
  { key: 'slab', header: 'Slab' },
  { key: 'upTo', header: 'Monthly wages up to' },
  { key: 'employees', header: 'Employees', numeric: true },
  { key: 'employee', header: 'Employee contribution', numeric: true },
  { key: 'employer', header: 'Employer contribution', numeric: true },
  { key: 'total', header: 'Total', numeric: true },
];

interface SlabGroup {
  state: string;
  slab: number;
  upTo: string;
  employees: number;
  amounts: Set<string>;
  first: bigint;
  second: bigint;
}

const slabKey = (state: string, slab: number) => `${state}:${String(slab).padStart(3, '0')}`;
const usableRow = (row: StatutoryRow, usable: ReadonlySet<string>) => usable.has(String(row.workings.packCode ?? ''));

function stateRows(groups: Map<string, SlabGroup>, kind: 'PT' | 'LWF'): Record<string, string>[] {
  const rows: Record<string, string>[] = [];
  const states = [...new Set([...groups.values()].map((g) => g.state))].sort();
  for (const state of states) {
    const mine = [...groups.entries()].filter(([, g]) => g.state === state).sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
    for (const g of mine) {
      rows.push(
        kind === 'PT'
          ? { state, slab: String(g.slab), upTo: g.upTo, employees: String(g.employees), perEmployee: g.amounts.size === 1 ? [...g.amounts][0]! : 'VARIES', tax: money(g.first) }
          : { state, slab: String(g.slab), upTo: g.upTo, employees: String(g.employees), employee: money(g.first), employer: money(g.second), total: money(g.first + g.second) },
      );
    }
    const employees = mine.reduce((s, g) => s + g.employees, 0);
    const first = mine.reduce((s, g) => s + g.first, 0n);
    const second = mine.reduce((s, g) => s + g.second, 0n);
    rows.push(
      kind === 'PT'
        ? { state, slab: 'TOTAL', upTo: '', employees: String(employees), perEmployee: '', tax: money(first) }
        : { state, slab: 'TOTAL', upTo: '', employees: String(employees), employee: money(first), employer: money(second), total: money(first + second) },
    );
  }
  return rows;
}

/** Per state (a usable PT_<state> pack) and slab: the employees and the tax, as the run recorded them; nil slabs count their employees. */
export function buildPtReturn(records: readonly RunRecord[], usable: ReadonlySet<string>): Built {
  const errors: RowError[] = [];
  const groups = new Map<string, SlabGroup>();
  const employeeIds: string[] = [];
  for (const r of records) {
    const rows = rowsOf(r, 'PROFESSIONAL_TAX').filter((s) => usableRow(s, usable));
    if (rows.length === 0) continue;
    employeeIds.push(r.employeeId);
    const e = errorsFor(errors, r.employeeCode);
    const row = single(r, 'PROFESSIONAL_TAX', e.add);
    if (!row) continue;
    const state = String(row.workings.stateCode ?? '');
    const slab = Number(row.workings.slab);
    if (!/^[A-Z]{2}$/.test(state) || !Number.isInteger(slab) || slab < 1) {
      e.add('SLAB_NOT_RECORDED', 'PROFESSIONAL_TAX');
      continue;
    }
    const amount = row.status === 'VALUED' && row.amount ? toUnits(row.amount) : 0n;
    const key = slabKey(state, slab);
    const g = groups.get(key) ?? { state, slab, upTo: row.workings.slabUpTo === null || row.workings.slabUpTo === undefined ? '' : String(row.workings.slabUpTo), employees: 0, amounts: new Set<string>(), first: 0n, second: 0n };
    g.employees += 1;
    g.amounts.add(money(amount));
    g.first += amount;
    groups.set(key, g);
  }
  const rows = stateRows(groups, 'PT');
  const tax = [...groups.values()].reduce((s, g) => s + g.first, 0n);
  return {
    content: { kind: 'TABLE', table: { title: 'Professional tax state summary', columns: PT_COLUMNS, rows } },
    errors,
    warnings: [],
    totals: { employees: employeeIds.length, states: new Set([...groups.values()].map((g) => g.state)).size, tax: money(tax) },
    employeeIds,
    rowCount: rows.length,
  };
}

/** Per state (a usable LWF_<state> pack) and slab: the employees and both contributions; a month that is not a contribution month says so. */
export function buildLwfReturn(records: readonly RunRecord[], usable: ReadonlySet<string>): Built {
  const errors: RowError[] = [];
  const groups = new Map<string, SlabGroup>();
  const employeeIds: string[] = [];
  const offMonth = new Map<string, number>();
  for (const r of records) {
    const rows = [...rowsOf(r, 'LWF_EMPLOYEE'), ...rowsOf(r, 'LWF_EMPLOYER')].filter((s) => usableRow(s, usable));
    if (rows.length === 0) continue;
    const e = errorsFor(errors, r.employeeCode);
    const employee = single(r, 'LWF_EMPLOYEE', e.add);
    const employer = single(r, 'LWF_EMPLOYER', e.add);
    const any = employee ?? employer;
    if (!any) continue;
    const state = String(any.workings.stateCode ?? '');
    if (any.workings.reason === 'NOT_A_CONTRIBUTION_MONTH') {
      offMonth.set(state, (offMonth.get(state) ?? 0) + 1);
      continue;
    }
    employeeIds.push(r.employeeId);
    const slab = Number(any.workings.slab);
    if (!/^[A-Z]{2}$/.test(state) || !Number.isInteger(slab) || slab < 1) {
      e.add('SLAB_NOT_RECORDED', any.code);
      continue;
    }
    const valued = (row: StatutoryRow | null) => (row?.status === 'VALUED' && row.amount ? toUnits(row.amount) : 0n);
    const key = slabKey(state, slab);
    const g = groups.get(key) ?? { state, slab, upTo: any.workings.slabUpTo === null || any.workings.slabUpTo === undefined ? '' : String(any.workings.slabUpTo), employees: 0, amounts: new Set<string>(), first: 0n, second: 0n };
    g.employees += 1;
    g.first += valued(employee);
    g.second += valued(employer);
    groups.set(key, g);
  }
  const rows = stateRows(groups, 'LWF');
  const employee = [...groups.values()].reduce((s, g) => s + g.first, 0n);
  const employer = [...groups.values()].reduce((s, g) => s + g.second, 0n);
  return {
    content: { kind: 'TABLE', table: { title: 'Labour welfare fund state summary', columns: LWF_COLUMNS, rows } },
    errors,
    warnings: [...offMonth].sort(([a], [b]) => a.localeCompare(b)).map(([state, n]) => ({ code: 'NOT_A_CONTRIBUTION_MONTH', count: n, detail: `${state}: this month is not a contribution month of the state's fund.` })),
    totals: { employees: employeeIds.length, states: new Set([...groups.values()].map((g) => g.state)).size, employeeContribution: money(employee), employerContribution: money(employer) },
    employeeIds,
    rowCount: rows.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------------------------------
/** Labelled lines a file states about itself (where the layout allows): its source, the pinned pack revisions, the accepted format. */
export type FileContext = readonly (readonly [label: string, value: string])[];

function tableCsv(table: Table, context: FileContext | null): string {
  const lines: string[] = [];
  if (context) lines.push(...context.map(([label, value]) => `${csvCell(label)},${csvCell(oneLine(value))}`), '');
  lines.push(table.columns.map((c) => csvCell(c.header)).join(','));
  for (const row of table.rows) lines.push(table.columns.map((c) => csvCell(row[c.key] ?? '')).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

function tableXlsx(table: Table, context: FileContext | null): Buffer {
  const cell = (column: Column, value: string): SheetCell => (column.numeric && PLAIN_DECIMAL.test(value) ? { number: value } : cellText(value));
  return xlsxWorkbook(
    sheetName(table.title),
    [table.columns.map((c) => cellText(c.header)), ...table.rows.map((row) => table.columns.map((c) => cell(c, row[c.key] ?? '')))],
    context ? { name: 'Source', rows: context.map(([label, value]) => [cellText(label), cellText(oneLine(value))]) } : undefined,
  );
}

/** The file's bytes in one of the output's formats; `context` is written only where the layout allows (never into an upload). */
export function renderFile(def: OutputDefinition, built: Built, format: FileFormat, context: FileContext | null): Buffer {
  if (!def.formats.includes(format)) throw new Error(`${def.code} is not offered as ${format}`);
  const header = def.upload ? null : context;
  if (built.content.kind === 'ECR') return Buffer.from(renderEcr(built.content.lines), 'utf8');
  return format === 'xlsx' ? tableXlsx(built.content.table, header) : Buffer.from(tableCsv(built.content.table, header), 'utf8');
}

export const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// Samples: synthetic rows through the same building and rendering as a real file
// ---------------------------------------------------------------------------------------------------------------
const pf = (code: string, amount: string | null, workings: Record<string, unknown>): StatutoryRow => ({
  code,
  status: amount ? 'VALUED' : 'NOT_APPLICABLE',
  amount,
  workings: { packCode: 'PF', packRevision: 0, rounding: 'HALF_UP_WHOLE', ...workings },
});

function sampleRecord(n: number, over: Partial<RunRecord>): RunRecord {
  return {
    recordId: `00000000-0000-0000-0000-00000000000${n}`,
    employeeId: `00000000-0000-0000-0000-0000000000a${n}`,
    employeeCode: `SAMPLE000${n}`,
    name: n === 1 ? 'SAMPLE MEMBER ONE' : 'SAMPLE MEMBER TWO',
    joiningDate: '1999-12-01',
    leavingDate: null,
    separationType: null,
    paidUnits: '31',
    earnings: '15000.00',
    lopUnits: '0',
    periodCode: '2000-01',
    periodStart: '2000-01-01',
    periodEnd: '2000-01-31',
    statutory: [],
    ...over,
  };
}

const SAMPLE_PF: RunRecord[] = [
  sampleRecord(1, {
    statutory: [
      pf('PF_EMPLOYEE', '1800.0000', { contributionWages: '15000.0000' }),
      pf('PF_EMPLOYER_EPS', '1250.0000', { pensionWages: '15000.0000' }),
      pf('PF_EMPLOYER_EPF', '550.0000', {}),
      pf('PF_EDLI', '75.0000', { edliWages: '15000.0000' }),
    ],
  }),
  sampleRecord(2, {
    joiningDate: '2000-01-10',
    paidUnits: '20',
    lopUnits: '2',
    earnings: '6451.61',
    statutory: [
      pf('PF_EMPLOYEE', '774.0000', { contributionWages: '6451.6100' }),
      pf('PF_EMPLOYER_EPS', '537.0000', { pensionWages: '6451.6100' }),
      pf('PF_EMPLOYER_EPF', '237.0000', {}),
      pf('PF_EDLI', '32.0000', { edliWages: '6451.6100' }),
    ],
  }),
];

const esic = (code: string, amount: string, wages: string): StatutoryRow => ({ code, status: 'VALUED', amount, workings: { packCode: 'ESIC', packRevision: 0, esicWages: wages, rounding: 'UP_WHOLE' } });
const SAMPLE_ESIC: RunRecord[] = [
  sampleRecord(1, { statutory: [esic('ESIC_EMPLOYEE', '113.0000', '15000.00'), esic('ESIC_EMPLOYER', '488.0000', '15000.00')] }),
  sampleRecord(2, {
    paidUnits: '10',
    leavingDate: '2000-01-10',
    separationType: 'RESIGNATION',
    statutory: [esic('ESIC_EMPLOYEE', '37.0000', '4838.71'), esic('ESIC_EMPLOYER', '158.0000', '4838.71')],
  }),
];

const SAMPLE_IDS = new Map<string, IdentifierRead>([
  // Obviously fake; an IP number never starts 6 to 9 here, so no sample looks like a mobile number (privacy scan, ZT21).
  ['00000000-0000-0000-0000-0000000000a1', { uan: '999999999901', esicIpNumber: '1999999901' }],
  ['00000000-0000-0000-0000-0000000000a2', { uan: '999999999902', esicIpNumber: '1999999902' }],
]);

const state = (code: string, pack: string, amount: string | null, workings: Record<string, unknown>): StatutoryRow => ({ code, status: amount ? 'VALUED' : 'NOT_APPLICABLE', amount, workings: { packCode: pack, packRevision: 0, ...workings } });

function sampleBuilt(code: OutputCode): Built {
  switch (code) {
    case 'PF_ECR':
      return buildEcr(SAMPLE_PF, SAMPLE_IDS);
    case 'PF_NEW_JOINERS':
      return buildNewJoiners(SAMPLE_PF, SAMPLE_IDS, new Map([['00000000-0000-0000-0000-0000000000a2', { name: 'SAMPLE FATHER TWO', relation: 'F' }]]));
    case 'ESIC_MONTHLY':
      return buildEsicMonthly(SAMPLE_ESIC, SAMPLE_IDS);
    case 'ESIC_HALF_YEARLY':
      return buildEsicHalfYear([...SAMPLE_ESIC, { ...SAMPLE_ESIC[0]!, recordId: '00000000-0000-0000-0000-000000000003', periodCode: '2000-02' }], SAMPLE_IDS);
    case 'TDS_QUARTERLY':
      return buildTdsQuarter(
        ['2000-04', '2000-05', '2000-06'],
        [
          { employeeId: 'a1', months: [{ month: '2000-04', taxableSalary: '200000.00', tds: '24375.00' }, { month: '2000-05', taxableSalary: '200000.00', tds: '24375.00' }] },
          { employeeId: 'a2', months: [{ month: '2000-04', taxableSalary: '15000.00', tds: '0.00' }] },
        ],
        [{ month: '2000-04', amount: '24375.00', state: 'RECORDED' }],
      );
    case 'PT_STATE_RETURN':
      return buildPtReturn(
        [
          sampleRecord(1, { statutory: [state('PROFESSIONAL_TAX', 'PT_ZZ', '200.0000', { stateCode: 'ZZ', slab: 3, slabUpTo: null, slabAmount: '200.00' })] }),
          sampleRecord(2, { statutory: [state('PROFESSIONAL_TAX', 'PT_ZZ', null, { stateCode: 'ZZ', slab: 1, slabUpTo: '7500.00', slabAmount: '0.00', reason: 'NIL_AMOUNT' })] }),
        ],
        new Set(['PT_ZZ']),
      );
    case 'LWF_STATE_RETURN':
      return buildLwfReturn(
        [
          sampleRecord(1, {
            statutory: [
              state('LWF_EMPLOYEE', 'LWF_ZZ', '12.0000', { stateCode: 'ZZ', slab: 2, slabUpTo: null }),
              state('LWF_EMPLOYER', 'LWF_ZZ', '36.0000', { stateCode: 'ZZ', slab: 2, slabUpTo: null }),
            ],
          }),
        ],
        new Set(['LWF_ZZ']),
      );
  }
}

export interface SampleFile {
  format: FileFormat;
  fileName: string;
  mediaType: string;
  bytes: Buffer;
}

/**
 * The output's validation sample: synthetic rows (obviously fake identifiers and names) built and rendered exactly as a file would be,
 * in every offered format. Its hash binds an acceptance to this layout: a build whose sample hashes differently no longer has that
 * acceptance (FORMAT_SAMPLE_CHANGED).
 */
export function sampleOf(code: OutputCode): { hash: string; files: SampleFile[] } {
  const cached = SAMPLES.get(code);
  if (cached) return cached;
  const def = OUTPUTS[code];
  const built = sampleBuilt(code);
  if (built.errors.length > 0) throw new Error(`The ${code} sample has row errors: ${JSON.stringify(built.errors)}`);
  const context: FileContext = [
    ['Sample', 'Synthetic rows only; not for filing'],
    ['Output', `${code} layout ${def.layoutVersion}`],
    ['Produced from pinned pack revisions', `${def.packFamily} revision 0 (sample)`],
  ];
  const files = def.formats.map((format) => ({
    format,
    fileName: `SAMPLE_${code}_layout-${def.layoutVersion}.${format}`,
    mediaType: MEDIA_TYPES[format],
    bytes: renderFile(def, built, format, context),
  }));
  const hash = sha256(JSON.stringify({ code, layoutVersion: def.layoutVersion, files: files.map((f) => [f.format, sha256(f.bytes)]) }));
  const sample = { hash, files };
  SAMPLES.set(code, sample);
  return sample;
}

/** Samples are pure functions of the build, so each is rendered once per process. */
const SAMPLES = new Map<OutputCode, { hash: string; files: SampleFile[] }>();
