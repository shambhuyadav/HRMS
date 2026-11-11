// Statutory filing files, batch R4: the period, the gates, the data and the file (see outputs.ts for the layouts and formats.ts for the
// accepted formats). Decided under owner delegation, 6 Nov 2026; statutory content stays switched off until the owner's CA authorises it.
//
// Gates, in order. A file is NOT_CONFIGURED, naming everything missing, unless
//   1. its pack has an ACTIVE revision in effect on the period's last day (PF, ESIC, INCOME_TAX; for professional tax and the labour
//      welfare fund, at least one PT_<state> / LWF_<state> pack the run pinned, and only those states are in the file), and the run
//      pinned a revision of it (it valued nothing otherwise); and
//   2. the company has an accepted format for the output in force today, whose sample the build still renders.
// Then the file is AVAILABLE for a whole-company assignment. It is produced only when no row has an error (H2 "no partial final file")
// and the caller is not linked to anyone in it (C4, as the bank manifest: someone else produces a file holding your own pay).
//
// Sources: only what PROCESSED_LOCKED runs recorded (payroll_record_statutory with the pinned pack revision, the record's earnings,
// paid days and loss-of-pay days), the Form 24Q working data (payroll-outputs tdsRegister) and the recorded TDS challans (payroll-extras);
// nothing statutory is computed again. The file's name says which pinned pack revisions it was produced from, and so does its header
// where the layout has room for one. Every download is audited (resource statutory_file).
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { openJson } from '../../security/field-crypto.js';
import { type AccessDecision, type AccessGrant, resolveAccess } from '../access/authorize.js';
import { identifierBinding } from '../employee/record-sections.js';
import { listTdsChallans } from '../payroll-extras/challans.js';
import { tdsRegister } from '../payroll-outputs/reports.js';
import { fileContext } from '../report/context.js';
import { companyWide, formatInForce, type FormatView, requireCompanyWide } from './formats.js';
import {
  type Built,
  buildEcr,
  buildEsicHalfYear,
  buildEsicMonthly,
  buildLwfReturn,
  buildNewJoiners,
  buildPtReturn,
  buildTdsQuarter,
  type FileContext,
  type FileFormat,
  type IdentifierRead,
  isOutputCode,
  MEDIA_TYPES,
  type Notice,
  OUTPUT_CODES,
  type OutputCode,
  type OutputDefinition,
  OUTPUTS,
  type Relative,
  renderFile,
  type RunRecord,
  sampleOf,
  sha256,
} from './outputs.js';

export interface PeriodQuery {
  runId?: string | undefined;
  fiscalYear?: string | undefined;
  quarter?: number | undefined;
  half?: number | undefined;
}

interface Period {
  kind: OutputDefinition['period'];
  /** In file names: the period code of a run, or 2026-27-Q3, 2026-27-H2. */
  label: string;
  from: string;
  to: string;
  run: { id: string; revision: number; periodCode: string } | null;
  fiscalYear: string | null;
  quarter: number | null;
  half: number | null;
}

interface Pin {
  packCode: string;
  packRevision: number;
}

export interface Missing {
  code: 'RULE_PACK_NOT_ACTIVE' | 'RULE_PACK_NOT_PINNED' | 'FORMAT_NOT_ACCEPTED' | 'FORMAT_SAMPLE_CHANGED';
  pack?: string;
  formatId?: string;
  message: string;
}

/** The rule-pack codes of the heads each output reads (payroll_record_statutory.rule_pack_code). */
const HEAD_CODES: Readonly<Record<OutputCode, readonly string[]>> = {
  PF_ECR: ['PF_EMPLOYEE', 'PF_EMPLOYER_EPS', 'PF_EMPLOYER_EPF', 'PF_EDLI'],
  PF_NEW_JOINERS: ['PF_EMPLOYEE'],
  ESIC_MONTHLY: ['ESIC_EMPLOYEE', 'ESIC_EMPLOYER'],
  ESIC_HALF_YEARLY: ['ESIC_EMPLOYEE', 'ESIC_EMPLOYER'],
  TDS_QUARTERLY: [],
  PT_STATE_RETURN: ['PROFESSIONAL_TAX'],
  LWF_STATE_RETURN: ['LWF_EMPLOYEE', 'LWF_EMPLOYER'],
};

const QUARTER_MONTHS: Readonly<Record<number, readonly number[]>> = { 1: [4, 5, 6], 2: [7, 8, 9], 3: [10, 11, 12], 4: [1, 2, 3] };
const HALF_MONTHS: Readonly<Record<number, readonly number[]>> = { 1: [4, 5, 6, 7, 8, 9], 2: [10, 11, 12, 1, 2, 3] };

const monthEnd = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
};

function fiscalYearStart(label: string | undefined): number {
  const m = /^(\d{4})-(\d{2})$/.exec(label ?? '');
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new HttpError(422, 'INVALID_FISCAL_YEAR', 'A financial year looks like 2026-27', { field: 'fiscalYear' });
  return Number(m[1]);
}

/** The months (YYYY-MM) of a quarter or half of a financial year. */
function monthsOf(start: number, months: readonly number[]): string[] {
  return months.map((m) => `${m >= 4 ? start : start + 1}-${String(m).padStart(2, '0')}`);
}

async function resolvePeriod(db: Queryable, grant: AccessGrant, def: OutputDefinition, q: PeriodQuery): Promise<Period & { months: string[] }> {
  if (def.period === 'RUN') {
    if (!q.runId) throw new HttpError(422, 'RUN_REQUIRED', 'Choose the processed payroll run the file is for', { field: 'runId' });
    const run = (
      await db.query<{ id: string; revision: number; state: string; period_code: string; from: string; to: string }>(
        `select r.id, r.revision, r.state, p.period_code, to_char(r.service_start, 'YYYY-MM-DD') as from, to_char(r.service_end, 'YYYY-MM-DD') as to
           from payroll_run r join payroll_period p on p.company_id = r.company_id and p.id = r.period_id where r.company_id = $1 and r.id = $2`,
        [grant.companyId, q.runId],
      )
    ).rows[0];
    if (!run) throw notFound();
    if (run.state !== 'PROCESSED_LOCKED') throw new HttpError(409, 'RUN_NOT_PROCESSED', 'Statutory files use PROCESSED_LOCKED payroll runs only', { state: run.state });
    return { kind: 'RUN', label: run.period_code, from: run.from, to: run.to, run: { id: run.id, revision: run.revision, periodCode: run.period_code }, fiscalYear: null, quarter: null, half: null, months: [run.from.slice(0, 7)] };
  }
  const start = fiscalYearStart(q.fiscalYear);
  if (def.period === 'QUARTER') {
    if (!q.quarter || !QUARTER_MONTHS[q.quarter]) throw new HttpError(422, 'QUARTER_REQUIRED', 'Choose the quarter (1 to 4)', { field: 'quarter' });
    const months = monthsOf(start, QUARTER_MONTHS[q.quarter]!);
    return { kind: 'QUARTER', label: `${q.fiscalYear}-Q${q.quarter}`, from: `${months[0]}-01`, to: monthEnd(months.at(-1)!), run: null, fiscalYear: q.fiscalYear!, quarter: q.quarter, half: null, months };
  }
  if (!q.half || !HALF_MONTHS[q.half]) throw new HttpError(422, 'HALF_REQUIRED', 'Choose the contribution period (1: April to September, 2: October to March)', { field: 'half' });
  const months = monthsOf(start, HALF_MONTHS[q.half]!);
  return { kind: 'HALF_YEAR', label: `${q.fiscalYear}-H${q.half}`, from: `${months[0]}-01`, to: monthEnd(months.at(-1)!), run: null, fiscalYear: q.fiscalYear!, quarter: null, half: q.half, months };
}

/** The ACTIVE revision of a pack in effect on a day (the latest start on or before it), or null. */
async function activeRevision(db: Queryable, companyId: string, code: string, day: string): Promise<number | null> {
  return (
    (await db.query<{ revision: number }>(`select revision from statutory_rule_pack where company_id = $1 and code = $2 and state = 'ACTIVE' and effective_from <= $3::date order by effective_from desc limit 1`, [companyId, code, day]))
      .rows[0]?.revision ?? null
  );
}

const familyCode = (def: OutputDefinition) => (def.packFamily === 'PT' || def.packFamily === 'LWF' ? null : def.packFamily);
const ofFamily = (def: OutputDefinition, packCode: string) => (familyCode(def) ? packCode === def.packFamily : new RegExp(`^${def.packFamily}_[A-Z]{2}$`).test(packCode));

/** Gate 1: the packs, the revisions the period's runs pinned, and the packs whose rows may be used. */
async function packGate(db: Queryable, companyId: string, def: OutputDefinition, period: Period) {
  const missing: Missing[] = [];
  const warnings: Notice[] = [];
  const pins = (
    period.run
      ? await db.query<{ packCode: string; packRevision: number | null }>(`select pack_code as "packCode", pack_revision as "packRevision" from payroll_run_rule_pack where company_id = $1 and run_id = $2 order by pack_code`, [
          companyId,
          period.run.id,
        ])
      : await db.query<{ packCode: string; packRevision: number | null }>(
          `select distinct p.pack_code as "packCode", p.pack_revision as "packRevision"
             from payroll_run_rule_pack p join payroll_run r on r.company_id = p.company_id and r.id = p.run_id
            where p.company_id = $1 and r.state = 'PROCESSED_LOCKED' and r.service_start between $2::date and $3::date and p.pack_revision is not null
            order by 1, 2`,
          [companyId, period.from, period.to],
        )
  ).rows.filter((p) => ofFamily(def, p.packCode));
  const pinned: Pin[] = pins.filter((p): p is Pin => p.packRevision !== null);
  const usable = new Set<string>();
  const single = familyCode(def);
  if (single) {
    const active = await activeRevision(db, companyId, single, period.to);
    if (active === null) missing.push({ code: 'RULE_PACK_NOT_ACTIVE', pack: single, message: `${single} has no ACTIVE revision in effect on ${period.to}` });
    if (period.run && pinned.length === 0) missing.push({ code: 'RULE_PACK_NOT_PINNED', pack: single, message: `The run valued nothing under ${single}: it pinned no active revision` });
    for (const p of pinned) {
      if (active !== null && p.packRevision !== active) warnings.push({ code: 'PINNED_REVISION_NOT_IN_EFFECT', detail: `The run pinned ${p.packCode} revision ${p.packRevision}; revision ${active} is in effect now.` });
    }
    if (missing.length === 0) usable.add(single);
  } else {
    for (const p of pins) {
      const active = await activeRevision(db, companyId, p.packCode, period.to);
      if (p.packRevision !== null && active !== null) usable.add(p.packCode);
      else warnings.push({ code: 'STATE_PACK_NOT_CONFIGURED', detail: `${p.packCode}: ${p.packRevision === null ? 'the run pinned no active revision' : `no ACTIVE revision in effect on ${period.to}`}; its employees are not in the file.` });
    }
    if (usable.size === 0) {
      missing.push(
        pins.length === 0
          ? { code: 'RULE_PACK_NOT_PINNED', pack: `${def.packFamily}_<state>`, message: `The run valued nothing under a ${def.packFamily}_<state> pack` }
          : { code: 'RULE_PACK_NOT_ACTIVE', pack: `${def.packFamily}_<state>`, message: `No ${def.packFamily}_<state> pack the run pinned has an ACTIVE revision in effect on ${period.to}` },
      );
    }
  }
  return { missing, warnings, pinned: pinned.filter((p) => usable.has(p.packCode)), usable };
}

/** Gate 2: the accepted format in force today, and whether the build still renders the sample it was accepted on. */
async function formatGate(db: Queryable, grant: AccessGrant, code: OutputCode): Promise<{ format: FormatView | null; missing: Missing[] }> {
  const format = await formatInForce(db, grant.companyId, code, grant.businessDate);
  if (!format) return { format: null, missing: [{ code: 'FORMAT_NOT_ACCEPTED', message: `No accepted ${code} format is in force on ${grant.businessDate}: one person sets it up and another validates its sample` }] };
  if (format.sampleHash !== sampleOf(code).hash) {
    return { format, missing: [{ code: 'FORMAT_SAMPLE_CHANGED', formatId: format.id, message: `The ${code} layout changed since format revision ${format.revision} was accepted: set up a new revision and validate its sample` }] };
  }
  return { format, missing: [] };
}

// ---------------------------------------------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------------------------------------------
async function runRecords(db: Queryable, companyId: string, period: Period, codes: readonly string[]): Promise<RunRecord[]> {
  const runFilter = period.run ? `r.run_id = $2::uuid` : `ru.state = 'PROCESSED_LOCKED' and ru.service_start between $2::date and $4::date`;
  const params: unknown[] = period.run ? [companyId, period.run.id, codes] : [companyId, period.from, codes, period.to];
  return (
    await db.query<RunRecord>(
      `select r.id as "recordId", r.employee_id as "employeeId", r.employee_code as "employeeCode", e.display_name as name,
              to_char(r.joining_date, 'YYYY-MM-DD') as "joiningDate", to_char(r.leaving_date, 'YYYY-MM-DD') as "leavingDate", x.separation_type as "separationType",
              r.paid_units::text as "paidUnits", r.earnings::text as earnings,
              coalesce((select sum(g.leave_lop_units + g.attendance_lop_units) from payroll_record_segment g where g.company_id = r.company_id and g.record_id = r.id), 0)::text as "lopUnits",
              p.period_code as "periodCode", to_char(ru.service_start, 'YYYY-MM-DD') as "periodStart", to_char(ru.service_end, 'YYYY-MM-DD') as "periodEnd",
              coalesce((select json_agg(json_build_object('code', s.rule_pack_code, 'status', s.status, 'amount', s.amount::text, 'workings', s.workings) order by s.rule_pack_code, s.id)
                          from payroll_record_statutory s where s.company_id = r.company_id and s.record_id = r.id and s.rule_pack_code = any($3::text[])), '[]'::json) as statutory
         from payroll_record r
         join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
         join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
         join employee e on e.company_id = r.company_id and e.id = r.employee_id
         left join lateral (select c.separation_type from exit_case c
                             where c.company_id = r.company_id and c.employee_id = r.employee_id and c.state in ('APPROVED', 'SEPARATED') and c.approved_leaving_date = r.leaving_date
                             order by c.approved_at desc nulls last limit 1) x on true
        where r.company_id = $1 and ${runFilter} and r.calculation_status = 'CALCULATED'
        order by r.employee_code, ru.service_start, r.id`,
      params,
    )
  ).rows;
}

/** As employee/record-sections.ts seals them (its binding is not exported; the two must stay the same). */

/** The payroll identifiers of the employees, opened in memory only; an employee without any reads as an empty object. */
async function identifiersOf(db: Queryable, companyId: string, employeeIds: readonly string[]): Promise<Map<string, IdentifierRead>> {
  const out = new Map<string, IdentifierRead>();
  if (employeeIds.length === 0) return out;
  const rows = (await db.query<{ employee_id: string; payload: string }>(`select employee_id, payload from employee_payroll_identifier where company_id = $1 and employee_id = any($2::uuid[])`, [companyId, [...new Set(employeeIds)]])).rows;
  for (const r of rows) {
    try {
      out.set(r.employee_id, openJson<{ uan?: string; esicIpNumber?: string }>(r.payload, identifierBinding(companyId, r.employee_id)));
    } catch {
      out.set(r.employee_id, null);
    }
  }
  return out;
}

/** The father's (else the spouse's) name on the family section of each employee. */
async function relativesOf(db: Queryable, companyId: string, employeeIds: readonly string[]): Promise<Map<string, Relative>> {
  if (employeeIds.length === 0) return new Map();
  const rows = (
    await db.query<{ employee_id: string; full_name: string; code: string }>(
      `select distinct on (x.employee_id) x.employee_id, x.full_name, r.code
         from employee_family_member x join reference_value r on r.company_id = x.company_id and r.id = x.relationship_id
        where x.company_id = $1 and x.employee_id = any($2::uuid[]) and x.removed_at is null and r.code in ('FATHER', 'SPOUSE')
        order by x.employee_id, (r.code = 'FATHER') desc, x.created_at, x.id`,
      [companyId, [...new Set(employeeIds)]],
    )
  ).rows;
  return new Map(rows.map((r) => [r.employee_id, { name: r.full_name, relation: r.code === 'FATHER' ? 'F' : 'S' }]));
}

/**
 * An employee read decision that opens `fieldGroup` for the whole company: allowed, and no scoped DENY of it on another assignment of
 * the user (C1, deniedScopes). A company file holds everyone and is never partial, so a DENY over part of the company counts as not
 * holding the grant at all (as formats.ts companyWide treats the report grant).
 */
export function holdsUndenied(decision: AccessDecision, fieldGroup: string): boolean {
  return decision.allowed && decision.allowedFieldGroups.includes(fieldGroup) && decision.deniedScopes.length === 0;
}

const employeeRead = (db: Queryable, grant: AccessGrant, fieldGroup: 'private' | 'payroll_id') =>
  resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource: 'employee', action: 'read', fieldGroups: [fieldGroup] });

/** Whether the caller's assignment also reads the confidential family section (employee.private), for the whole company. */
export async function readsPrivate(db: Queryable, grant: AccessGrant): Promise<boolean> {
  return holdsUndenied(await employeeRead(db, grant, 'private'), 'private');
}

/** Whether the caller's assignment reads the payroll identifiers (employee.read.payroll_id: UAN, IP number), for the whole company. */
export async function readsPayrollIds(db: Queryable, grant: AccessGrant): Promise<boolean> {
  return holdsUndenied(await employeeRead(db, grant, 'payroll_id'), 'payroll_id');
}

/** The refusal of a file carrying UAN or IP numbers to a caller who does not read them for the whole company. */
export const payrollIdsDenied = () =>
  new HttpError(403, 'PAYROLL_ID_SCOPE_DENIED', 'This file carries the UAN or IP number of everyone in it, and your reading of the payroll identifiers is refused for part of the company');

/** The row errors about the payroll identifiers (outputs.ts identifier()): they say who lacks a valid UAN or IP number. */
const IDENTIFIER_ERRORS: ReadonlySet<string> = new Set(['IDENTIFIERS_UNREADABLE', 'MISSING_UAN', 'MISSING_IP_NUMBER', 'INVALID_UAN', 'INVALID_IP_NUMBER']);

/** Whether the user is or was linked to any of the employees (C4: nobody produces a file holding their own pay). */
async function linkedToAny(db: Queryable, companyId: string, userId: string, employeeIds: readonly string[]): Promise<boolean> {
  if (employeeIds.length === 0) return false;
  return ((await db.query(`select 1 from user_employee_link where company_id = $1 and user_id = $2 and employee_id = any($3::uuid[]) limit 1`, [companyId, userId, [...new Set(employeeIds)]])).rowCount ?? 0) > 0;
}

/**
 * The Form 24Q working data leaves the caller's own record out (registerScope), so a quarter that holds it would be short: whether any
 * employee the user is or was linked to was paid in the quarter by processed payroll or a paid final settlement.
 */
async function linkedInQuarter(db: Queryable, companyId: string, userId: string, from: string, to: string): Promise<boolean> {
  return (
    (
      await db.query<{ hit: boolean }>(
        `select exists (
           select 1 from user_employee_link l
            where l.company_id = $1 and l.user_id = $2
              and (exists (select 1 from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
                            where r.company_id = $1 and r.employee_id = l.employee_id and ru.state = 'PROCESSED_LOCKED' and ru.service_start between $3::date and $4::date)
                   or exists (select 1 from settlement s join exit_case x on x.company_id = s.company_id and x.id = s.exit_case_id
                               where s.company_id = $1 and s.employee_id = l.employee_id and s.state = 'PAID' and x.approved_leaving_date between $3::date and $4::date))) as hit`,
        [companyId, userId, from, to],
      )
    ).rows[0]?.hit === true
  );
}

async function build(db: Queryable, grant: AccessGrant, def: OutputDefinition, period: Period & { months: string[] }, usable: ReadonlySet<string>, opts: { relatives: boolean }): Promise<Built & { selfIncluded: boolean }> {
  if (def.code === 'TDS_QUARTERLY') {
    const register = await tdsRegister(db, grant, { fiscalYear: period.fiscalYear!, quarter: period.quarter! });
    const challans = (await listTdsChallans(db, grant, period.fiscalYear!)).items as { month: string; amount: string; state: string }[];
    const built = buildTdsQuarter(period.months, register.items, challans);
    return { ...built, selfIncluded: await linkedInQuarter(db, grant.companyId, grant.userId, period.from, period.to) };
  }
  const records = await runRecords(db, grant.companyId, period, HEAD_CODES[def.code]);
  const ids = def.identifiers ? await identifiersOf(db, grant.companyId, records.map((r) => r.employeeId)) : new Map<string, IdentifierRead>();
  let built: Built;
  switch (def.code) {
    case 'PF_ECR':
      built = buildEcr(records, ids);
      break;
    case 'PF_NEW_JOINERS':
      built = buildNewJoiners(records, ids, opts.relatives ? await relativesOf(db, grant.companyId, records.map((r) => r.employeeId)) : null);
      break;
    case 'ESIC_MONTHLY':
      built = buildEsicMonthly(records, ids);
      break;
    case 'ESIC_HALF_YEARLY':
      built = buildEsicHalfYear(records, ids);
      break;
    case 'PT_STATE_RETURN':
      built = buildPtReturn(records, usable);
      break;
    default:
      built = buildLwfReturn(records, usable);
  }
  return { ...built, selfIncluded: await linkedToAny(db, grant.companyId, grant.userId, built.employeeIds) };
}

const pinText = (pins: readonly Pin[]) => (pins.length > 0 ? pins.map((p) => `${p.packCode} revision ${p.packRevision}`).join(', ') : 'none (no processed payroll in the period)');

/** The file's name: the output, the period, the run and the pinned pack revisions it was produced from. */
export function fileNameOf(code: OutputCode, period: Pick<Period, 'label' | 'run'>, pins: readonly Pin[], format: FileFormat): string {
  const run = period.run ? `_run-${period.run.id.slice(0, 8)}-rev${period.run.revision}` : '';
  const packs = pins.length > 0 ? pins.map((p) => `${p.packCode}-rev${p.packRevision}`).join('_') : 'no-pack-pinned';
  return `${code}_${period.label}${run}_pack-${packs}.${format}`.replace(/[^A-Za-z0-9._-]/g, '-');
}

/** Everything the status and the file share: the period, both gates and, when configured, the rows. */
async function evaluate(db: Queryable, grant: AccessGrant, code: string, q: PeriodQuery, opts: { relatives: boolean }) {
  if (!isOutputCode(code)) throw notFound();
  requireCompanyWide(grant);
  const def = OUTPUTS[code];
  const period = await resolvePeriod(db, grant, def, q);
  const packs = await packGate(db, grant.companyId, def, period);
  const formats = await formatGate(db, grant, code);
  const missing = [...packs.missing, ...formats.missing];
  const head = {
    outputCode: code,
    title: def.title,
    clause: def.clause,
    period: { kind: period.kind, label: period.label, from: period.from, to: period.to, runId: period.run?.id ?? null, runRevision: period.run?.revision ?? null, fiscalYear: period.fiscalYear, quarter: period.quarter, half: period.half },
    packs: packs.pinned,
    format: formats.format
      ? { id: formats.format.id, revision: formats.format.revision, formatReference: formats.format.formatReference, effectiveFrom: formats.format.effectiveFrom, acceptedAt: formats.format.acceptedAt, validationReference: formats.format.validationReference }
      : null,
    notice: def.notice,
  };
  if (missing.length > 0) return { def, period, pins: packs.pinned, format: formats.format, head, missing, built: null, warnings: packs.warnings };
  const built = await build(db, grant, def, period, packs.usable, opts);
  return { def, period, pins: packs.pinned, format: formats.format, head, missing, built, warnings: [...packs.warnings, ...built.warnings] };
}

/**
 * The status of one output for a period (payroll_report.read.amount, whole company): NOT_CONFIGURED with what is missing, or AVAILABLE
 * with the row count, the row errors, the totals and the file names. Nothing statutory is shown while it is not configured, and the
 * totals and errors are withheld from a caller whose own pay is in the file. The errors about the payroll identifiers (a missing,
 * invalid or unreadable UAN or IP number) say who lacks one, so they are listed only to a caller who reads the identifiers for the whole
 * company (readsPayrollIds); anyone else gets how many rows have one (identifierErrorsWithheld).
 */
export async function fileStatus(db: Queryable, grant: AccessGrant, code: string, q: PeriodQuery) {
  const e = await evaluate(db, grant, code, q, { relatives: code === 'PF_NEW_JOINERS' && (await readsPrivate(db, grant)) });
  if (!e.built) return { ...e.head, status: 'NOT_CONFIGURED' as const, ready: false, missing: e.missing, warnings: e.warnings };
  const self = e.built.selfIncluded;
  const errors = self ? [] : e.built.errors;
  const seesIdentifiers = !e.def.identifiers || (await readsPayrollIds(db, grant));
  const withheld = seesIdentifiers ? [] : errors.filter((x) => IDENTIFIER_ERRORS.has(x.code));
  return {
    ...e.head,
    status: 'AVAILABLE' as const,
    ready: !self && e.built.errors.length === 0,
    missing: [],
    selfIncluded: self,
    rowCount: self ? null : e.built.rowCount,
    rowErrors: seesIdentifiers ? errors : errors.filter((x) => !IDENTIFIER_ERRORS.has(x.code)),
    identifierErrorsWithheld: new Set(withheld.map((x) => x.employeeCode)).size,
    warnings: self ? [] : e.warnings,
    totals: self ? null : e.built.totals,
    files: e.def.formats.map((format) => ({ format, fileName: fileNameOf(e.def.code, e.period, e.pins, format) })),
  };
}

/**
 * The file (payroll_report.export.amount, and employee.read.payroll_id where it carries UAN or IP numbers; whole company): refused while
 * NOT_CONFIGURED (409), when the caller's own pay is in it (403) and while any row has an error (422); audited on every download.
 */
export async function statutoryFile(tx: Queryable, grant: AccessGrant, code: string, q: PeriodQuery, requested: string | undefined, opts: { relatives: boolean }) {
  const e = await evaluate(tx, grant, code, q, opts);
  const format = (requested ?? e.def.formats[0]) as FileFormat;
  if (!e.def.formats.includes(format)) throw new HttpError(422, 'FORMAT_NOT_OFFERED', `${e.def.code} is offered as ${e.def.formats.join(', ')}`, { field: 'format' });
  if (!e.built) throw new HttpError(409, 'NOT_CONFIGURED', 'This statutory file is not configured for the period', { outputCode: e.def.code, missing: e.missing });
  if (e.built.selfIncluded) throw new HttpError(403, 'SELF_INCLUDED', 'Your own pay is in this file; someone else produces it');
  if (e.built.errors.length > 0) throw new HttpError(422, 'STATUTORY_FILE_ROW_ERRORS', 'Some rows cannot be written; correct them and produce the file again', { errors: e.built.errors });
  const fileName = fileNameOf(e.def.code, e.period, e.pins, format);
  const f = e.format!;
  const context: FileContext = [
    ...(await fileContext(tx, grant, {
      title: e.def.title,
      code: e.def.code,
      period: { from: e.period.from, to: e.period.to },
      filters: e.period.run ? { run: e.period.run.id } : { fiscalYear: e.period.fiscalYear, quarter: e.period.quarter, half: e.period.half },
      revision: e.period.run ? `Payroll period ${e.period.run.periodCode}, run revision ${e.period.run.revision}` : null,
      rowCount: e.built.rowCount,
    })),
    ['Produced from pinned pack revisions', pinText(e.pins)],
    ['Accepted format', `${f.formatReference} (revision ${f.revision} from ${f.effectiveFrom}, validation reference ${f.validationReference ?? ''})`],
    ['Notice', e.def.notice],
  ];
  const bytes = renderFile(e.def, e.built, format, context);
  const contentHash = sha256(bytes);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'statutory_file',
    recordKey: e.period.run?.id ?? f.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'DOWNLOAD',
    after: {
      operational: {
        outputCode: e.def.code,
        period: e.period.label,
        runId: e.period.run?.id ?? null,
        format,
        fileName,
        contentHash,
        rows: e.built.rowCount,
        packs: e.pins,
        formatId: f.id,
        formatRevision: f.revision,
      },
    },
  });
  return { fileName, mediaType: MEDIA_TYPES[format], bytes };
}

/**
 * The outputs and, for today, whether each could be produced (payroll_statutory.read.operational): the pack family has an ACTIVE
 * revision in effect and an accepted format is in force. No amounts; the period's own status is fileStatus.
 */
export async function outputsOverview(db: Queryable, grant: AccessGrant) {
  const day = grant.businessDate;
  return {
    asOf: day,
    companyScope: companyWide(grant),
    items: await Promise.all(
      OUTPUT_CODES.map(async (code) => {
        const def = OUTPUTS[code];
        const single = familyCode(def);
        const packActive = single
          ? (await activeRevision(db, grant.companyId, single, day)) !== null
          : ((await db.query(`select 1 from statutory_rule_pack where company_id = $1 and code ~ $2 and state = 'ACTIVE' and effective_from <= $3::date limit 1`, [grant.companyId, `^${def.packFamily}_[A-Z]{2}$`, day])).rowCount ?? 0) > 0;
        const formats = await formatGate(db, grant, code);
        const missing: Missing[] = [...(packActive ? [] : [{ code: 'RULE_PACK_NOT_ACTIVE' as const, pack: single ?? `${def.packFamily}_<state>`, message: `${single ?? `No ${def.packFamily}_<state> pack`} has no ACTIVE revision in effect today` }]), ...formats.missing];
        return {
          code,
          title: def.title,
          clause: def.clause,
          period: def.period,
          packFamily: def.packFamily,
          formats: def.formats,
          identifiers: def.identifiers,
          upload: def.upload,
          layoutVersion: def.layoutVersion,
          notice: def.notice,
          status: missing.length === 0 ? 'AVAILABLE' : 'NOT_CONFIGURED',
          missing,
          format: formats.format ? { id: formats.format.id, revision: formats.format.revision, formatReference: formats.format.formatReference, effectiveFrom: formats.format.effectiveFrom } : null,
        };
      }),
    ),
  };
}
