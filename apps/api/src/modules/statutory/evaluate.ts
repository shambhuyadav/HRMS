// Statutory rule-pack evaluator: PF, ESIC and professional tax (I-85, decided under owner delegation, 6 Nov 2026; migration 0220).
//
// A payroll head of basis RULE_PACK names, by its rule-pack code, which output of which statutory pack it carries:
//   PF_EMPLOYEE (deduction), PF_EMPLOYER_EPS, PF_EMPLOYER_EPF, PF_EDLI, PF_ADMIN (employer contributions)   -> pack PF
//   ESIC_EMPLOYEE (deduction), ESIC_EMPLOYER (employer contribution)                                         -> pack ESIC
//   PROFESSIONAL_TAX (deduction)                                                         -> pack PT_<state of the work location>
// Its base heads (payroll_head_base, fixed with the head revision) say which earnings are the pack's wages: Basic and DA for PF, the
// ESIC wages for ESIC, the gross for professional tax. TDS (I-90) is valued from the INCOME_TAX pack from the year, not the month:
// in payroll by tdsValuations (projected to the year's end), in a final settlement by settlementTds (the year as it ends: no projection).
// A code this build does not know is not evaluated.
//
// The head is valued only from the ACTIVE pack revision in effect on the period's last day (payroll) or the last working date
// (settlement). Where there is none, the head blocks the employee with RULE_PACK_NOT_CONFIGURED exactly as before this evaluator
// existed (I-28; I-88 item 10). Every rate, ceiling and slab is a value of the pack; this file holds only the formulas, in exact
// decimal arithmetic (BigInt ten-thousandths, as settlement-formulas.ts), each figure rounded once to a whole currency unit as the
// pack's rounding says (EPFO: nearest unit, half up; ESIC: up to the next unit). Employer contributions are a cost of the employer
// (payroll_record.employer_contributions), never part of the net; the employee's PF and ESIC and professional tax are deductions.
//
// Formulas (wages = the sum of the head's base earnings in the month, after proration):
//   PF   contribution wages = wages, or min(wages, wageCeiling) unless the employee's option in force is HIGHER_WAGES;
//        employee = contribution wages x employeeRate; employer total = contribution wages x employerRate;
//        EPS = min(wages, pensionWageCeiling) x pensionRate; employer EPF = employer total - EPS (never below 0);
//        EDLI = min(wages, edliWageCeiling) x edliRate; administration charges = contribution wages x adminChargesRate.
//   ESIC covered when the monthly rate of ESIC wages (the employee's FIXED monthly base components in the salary arrangement) is at or
//        below wageCeiling on the record's last day, or was on the coverage date: the start of the contribution period the month
//        falls in, or the joining date if later (covered at the start, covered to the period's end). Contribution = wages x rate,
//        rounded up. Not covered: NOT_APPLICABLE, no line.
//   PT   the slab holding the month's gross (upTo inclusive; the last slab has none); its amount for the month (monthAmounts),
//        else its amount. A nil amount is NOT_APPLICABLE, no line.
import type { Queryable } from '../../db/queryable.js';
import type { RunContext } from '../payroll/calculate.js';
import { fromUnits, negate, toUnits } from '../lifecycle/settlement-formulas.js';
import { acceptedTaxFacts } from '../tax-declarations/service.js';
import {
  dec,
  type Deduction,
  EMPLOYER_NPS_CATEGORY,
  HRA_RENT_CATEGORIES,
  hraExemption,
  incomeTax,
  type IncomeTaxParameters,
  isNotADeduction,
  monthlyTds,
  PREVIOUS_EMPLOYMENT_CATEGORIES,
  type Regime,
  REGIMES,
  taxableIncome,
  text as taxText,
  withEmployerNpsLimit,
} from './income-tax.js';
import { type EsicParameters, type LwfParameters, packInEffect, packParameters, type PfParameters, type PtParameters, type StatutoryRounding } from './rule-packs.js';

export interface HeadOutput {
  family: 'PF' | 'ESIC' | 'PT' | 'LWF' | 'INCOME_TAX';
  output: 'EMPLOYEE' | 'EPS' | 'EPF' | 'EDLI' | 'ADMIN' | 'EMPLOYER' | 'TAX' | 'TDS';
  headType: 'DEDUCTION' | 'EMPLOYER_CONTRIBUTION';
}

/** The rule-pack codes of payroll heads this evaluator values, and the head type each must have. */
export const HEAD_OUTPUTS: Readonly<Record<string, HeadOutput>> = {
  PF_EMPLOYEE: { family: 'PF', output: 'EMPLOYEE', headType: 'DEDUCTION' },
  PF_EMPLOYER_EPS: { family: 'PF', output: 'EPS', headType: 'EMPLOYER_CONTRIBUTION' },
  PF_EMPLOYER_EPF: { family: 'PF', output: 'EPF', headType: 'EMPLOYER_CONTRIBUTION' },
  PF_EDLI: { family: 'PF', output: 'EDLI', headType: 'EMPLOYER_CONTRIBUTION' },
  PF_ADMIN: { family: 'PF', output: 'ADMIN', headType: 'EMPLOYER_CONTRIBUTION' },
  ESIC_EMPLOYEE: { family: 'ESIC', output: 'EMPLOYEE', headType: 'DEDUCTION' },
  ESIC_EMPLOYER: { family: 'ESIC', output: 'EMPLOYER', headType: 'EMPLOYER_CONTRIBUTION' },
  PROFESSIONAL_TAX: { family: 'PT', output: 'TAX', headType: 'DEDUCTION' },
  // FR-039: the state labour welfare fund (pack LWF_<state of the work location>), in its contribution months only.
  LWF_EMPLOYEE: { family: 'LWF', output: 'EMPLOYEE', headType: 'DEDUCTION' },
  LWF_EMPLOYER: { family: 'LWF', output: 'EMPLOYER', headType: 'EMPLOYER_CONTRIBUTION' },
  // I-90: tax deducted at source on salary, from the INCOME_TAX pack (statutory/income-tax.ts), valued per record by tdsValuations.
  TDS: { family: 'INCOME_TAX', output: 'TDS', headType: 'DEDUCTION' },
};

/** Payroll exceptions this evaluator raises besides RULE_PACK_NOT_CONFIGURED (all blocking, none resolvable by a note). */
export const STATUTORY_EXCEPTION_CODES = {
  RULE_PACK_HEAD_MISMATCH: 'A statutory head has the wrong head type for the pack output it names (the employee share is a deduction, the employer share an employer contribution)',
  RULE_PACK_CURRENCY_MISMATCH: 'The active statutory pack is in another currency than the payroll calendar',
  RULE_PACK_INVALID: 'The active statutory pack revision has parameters this build cannot read; retire it and activate a corrected revision',
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Formulas (pure)
// ---------------------------------------------------------------------------------------------------------------
const UNIT = 10_000n;
const lesser = (a: string, b: string) => (toUnits(a) <= toUnits(b) ? a : b);
const atMost = (a: string, b: string) => toUnits(a) <= toUnits(b);

/** amount x percent / 100, rounded once to a whole currency unit (half up, or up to the next unit), as a four-decimal string. */
export function percentOf(amount: string, percent: string, rounding: StatutoryRounding): string {
  const n = toUnits(amount) * toUnits(percent);
  if (n < 0n) throw new Error('a statutory contribution is a percentage of a non-negative amount');
  const d = UNIT * UNIT * 100n;
  const whole = rounding === 'UP_WHOLE' ? (n + d - 1n) / d : (2n * n + d) / (2n * d);
  return fromUnits(whole * UNIT);
}

export type Valuation = { status: 'VALUED'; amount: string; workings: Record<string, unknown> } | { status: 'NOT_APPLICABLE'; reason: string; workings: Record<string, unknown> };
const valued = (amount: string, workings: Record<string, unknown>): Valuation =>
  toUnits(amount) > 0n ? { status: 'VALUED', amount, workings } : { status: 'NOT_APPLICABLE', reason: 'NIL_AMOUNT', workings: { ...workings, amount } };

export type PfBasis = 'STATUTORY_CEILING' | 'HIGHER_WAGES';

export function valuePf(output: HeadOutput['output'], p: PfParameters, f: { wages: string; option: PfBasis }): Valuation {
  const contributionWages = f.option === 'HIGHER_WAGES' ? f.wages : lesser(f.wages, p.wageCeiling);
  const pensionWages = lesser(f.wages, p.pensionWageCeiling);
  const edliWages = lesser(f.wages, p.edliWageCeiling);
  const common = { pfWages: f.wages, option: f.option, wageCeiling: p.wageCeiling, contributionWages, rounding: p.rounding };
  switch (output) {
    case 'EMPLOYEE':
      return valued(percentOf(contributionWages, p.employeeRatePercent, p.rounding), { ...common, ratePercent: p.employeeRatePercent });
    case 'EPS':
      return valued(percentOf(pensionWages, p.pensionRatePercent, p.rounding), { ...common, pensionWages, pensionWageCeiling: p.pensionWageCeiling, ratePercent: p.pensionRatePercent });
    case 'EPF': {
      const employer = percentOf(contributionWages, p.employerRatePercent, p.rounding);
      const eps = percentOf(pensionWages, p.pensionRatePercent, p.rounding);
      const rest = toUnits(employer) - toUnits(eps);
      return valued(fromUnits(rest > 0n ? rest : 0n), { ...common, employerRatePercent: p.employerRatePercent, employerTotal: employer, pensionWages, pensionRatePercent: p.pensionRatePercent, pension: eps });
    }
    case 'EDLI':
      return valued(percentOf(edliWages, p.edliRatePercent, p.rounding), { ...common, edliWages, edliWageCeiling: p.edliWageCeiling, ratePercent: p.edliRatePercent });
    case 'ADMIN':
      return valued(percentOf(contributionWages, p.adminChargesRatePercent, p.rounding), { ...common, ratePercent: p.adminChargesRatePercent });
    default:
      throw new Error(`PF has no output ${output}`);
  }
}

/** The first day of the ESIC contribution period `day` falls in (the latest start month on or before its month, else last year's last). */
export function contributionPeriodStart(p: EsicParameters, day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const starts = [...p.contributionPeriodStartMonths].sort((a, b) => a - b);
  const same = starts.filter((s) => s <= month).pop();
  const [y, m] = same !== undefined ? [year, same] : [year - 1, starts[starts.length - 1]!];
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
}

export interface EsicFacts {
  wages: string;
  periodStart: string;
  coverageDate: string;
  /** The monthly rate of ESIC wages on the coverage date; null when no salary arrangement was in force then. */
  rateAtCoverage: string | null;
  /** The monthly rate of ESIC wages on the record's last day (payroll) or the last working date (settlement). */
  rateNow: string | null;
}

export function valueEsic(output: HeadOutput['output'], p: EsicParameters, f: EsicFacts): Valuation {
  const coveredNow = f.rateNow !== null && atMost(f.rateNow, p.wageCeiling);
  const coveredAtStart = f.rateAtCoverage !== null && atMost(f.rateAtCoverage, p.wageCeiling);
  const workings = { esicWages: f.wages, wageCeiling: p.wageCeiling, periodStart: f.periodStart, coverageDate: f.coverageDate, rateAtCoverage: f.rateAtCoverage, rateNow: f.rateNow, rounding: p.rounding };
  if (!coveredNow && !coveredAtStart) return { status: 'NOT_APPLICABLE', reason: 'NOT_COVERED', workings };
  const rate = output === 'EMPLOYEE' ? p.employeeRatePercent : output === 'EMPLOYER' ? p.employerRatePercent : null;
  if (rate === null) throw new Error(`ESIC has no output ${output}`);
  return valued(percentOf(f.wages, rate, p.rounding), { ...workings, covered: coveredNow ? 'RATE_AT_OR_BELOW_CEILING' : 'COVERED_FOR_THE_CONTRIBUTION_PERIOD', ratePercent: rate });
}

export function valuePt(p: PtParameters, f: { gross: string; month: number }): Valuation {
  const index = p.slabs.findIndex((s) => s.upTo === null || atMost(f.gross, s.upTo));
  const slab = p.slabs[index]!;
  const amount = slab.monthAmounts?.[String(f.month)] ?? slab.amount;
  return valued(fromUnits(toUnits(amount)), { gross: f.gross, stateCode: p.stateCode, month: f.month, slab: index + 1, slabUpTo: slab.upTo, slabAmount: slab.amount, ...(slab.monthAmounts?.[String(f.month)] ? { monthAmount: amount } : {}) });
}

/**
 * Labour welfare fund: nothing outside the pack's contribution months (NOT_A_CONTRIBUTION_MONTH); in one, the slab holding the month's
 * wages (upTo inclusive; the last slab has none) gives the employee's or the employer's amount. A nil amount is NOT_APPLICABLE.
 */
export function valueLwf(output: HeadOutput['output'], p: LwfParameters, f: { wages: string; month: number }): Valuation {
  const workings = { wages: f.wages, stateCode: p.stateCode, month: f.month, contributionMonths: p.contributionMonths };
  if (!p.contributionMonths.includes(f.month)) return { status: 'NOT_APPLICABLE', reason: 'NOT_A_CONTRIBUTION_MONTH', workings };
  const index = p.slabs.findIndex((s) => s.upTo === null || atMost(f.wages, s.upTo));
  const slab = p.slabs[index]!;
  if (output !== 'EMPLOYEE' && output !== 'EMPLOYER') throw new Error(`LWF has no output ${output}`);
  const amount = output === 'EMPLOYEE' ? slab.employee : slab.employer;
  return valued(fromUnits(toUnits(amount)), { ...workings, slab: index + 1, slabUpTo: slab.upTo });
}

/** One head's valuation from its pack parameters and the employee's facts (PF, ESIC, PT, LWF; TDS is valued by tdsValuations). */
export function valueHead(def: HeadOutput, parameters: unknown, f: { wages: string; month: number; option: PfBasis; esic: Omit<EsicFacts, 'wages'> | null }): Valuation {
  if (def.family === 'PF') return valuePf(def.output, parameters as PfParameters, { wages: f.wages, option: f.option });
  if (def.family === 'ESIC') return valueEsic(def.output, parameters as EsicParameters, { wages: f.wages, ...f.esic! });
  if (def.family === 'INCOME_TAX') throw new Error('TDS is valued from the year, not one month: tdsValuations');
  if (def.family === 'LWF') return valueLwf(def.output, parameters as LwfParameters, { wages: f.wages, month: f.month });
  return valuePt(parameters as PtParameters, { gross: f.wages, month: f.month });
}

/** A family valued under the pack of the work location's state (PT_<state>, LWF_<state>). */
const byState = (family: HeadOutput['family']) => family === 'PT' || family === 'LWF';

/** The Indian financial year a day falls in: 2026-04-01 to 2027-03-31 is 2026-27. */
export function fiscalYearOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Facts read from the masters (shared by payroll and settlement)
// ---------------------------------------------------------------------------------------------------------------
interface Subject {
  key: string;
  employeeId: string;
  day: string;
}

/** The PF contribution basis in force on each subject's day (employee_pf_option); STATUTORY_CEILING without one. */
async function pfOptions(db: Queryable, companyId: string, subjects: readonly Subject[]): Promise<Map<string, PfBasis>> {
  if (subjects.length === 0) return new Map();
  const rows = (
    await db.query<{ k: string; basis: PfBasis | null }>(
      `select m.k, (select o.contribution_basis from employee_pf_option o where o.company_id = $1 and o.employee_id = m.employee_id and o.effective_from <= m.day
                     order by o.effective_from desc, o.sequence desc limit 1) as basis
         from unnest($2::text[], $3::uuid[], $4::date[]) m (k, employee_id, day)`,
      [companyId, subjects.map((s) => s.key), subjects.map((s) => s.employeeId), subjects.map((s) => s.day)],
    )
  ).rows;
  return new Map(rows.map((r) => [r.k, r.basis ?? 'STATUTORY_CEILING']));
}

/** The professional tax state of each subject on its day: of the location of the employment assignment in force (location_pt_state). */
async function ptStates(db: Queryable, companyId: string, subjects: readonly Subject[]): Promise<Map<string, string | null>> {
  if (subjects.length === 0) return new Map();
  const rows = (
    await db.query<{ k: string; state: string | null }>(
      `select m.k, (select s.state_code from employment_assignment a
                      join location_pt_state s on s.company_id = a.company_id and s.location_id = a.location_id and s.effective_from <= m.day
                     where a.company_id = $1 and a.employee_id = m.employee_id and a.effective_from <= m.day and (a.effective_to is null or a.effective_to > m.day)
                     order by s.effective_from desc, s.sequence desc limit 1) as state
         from unnest($2::text[], $3::uuid[], $4::date[]) m (k, employee_id, day)`,
      [companyId, subjects.map((s) => s.key), subjects.map((s) => s.employeeId), subjects.map((s) => s.day)],
    )
  ).rows;
  return new Map(rows.map((r) => [r.k, r.state]));
}

/**
 * The monthly rate of a head's wages for each subject on its day: the FIXED monthly salary components among the head's base heads in
 * the salary arrangement in force (0 when the arrangement has none of them); null when no arrangement is in force.
 */
async function wageRates(db: Queryable, companyId: string, subjects: readonly (Subject & { headRevisionId: string })[]): Promise<Map<string, string | null>> {
  if (subjects.length === 0) return new Map();
  const rows = (
    await db.query<{ k: string; rate: string | null }>(
      `select m.k, (select case when count(sa.id) = 0 then null
                                else coalesce(sum(sc.amount) filter (where sc.basis = 'MONTHLY'
                                                                     and sc.component_id in (select b.base_component_id from payroll_head_base b
                                                                                              where b.company_id = $1 and b.head_revision_id = m.head_id)), 0) end::text
                      from salary_arrangement sa
                      left join salary_component sc on sc.company_id = sa.company_id and sc.salary_arrangement_id = sa.id
                     where sa.company_id = $1 and sa.employee_id = m.employee_id and sa.superseded_at is null
                       and sa.effective_from <= m.day and (sa.effective_to is null or sa.effective_to > m.day)) as rate
         from unnest($2::text[], $3::uuid[], $4::date[], $5::uuid[]) m (k, employee_id, day, head_id)`,
      [companyId, subjects.map((s) => s.key), subjects.map((s) => s.employeeId), subjects.map((s) => s.day), subjects.map((s) => s.headRevisionId)],
    )
  ).rows;
  return new Map(rows.map((r) => [r.k, r.rate === null ? null : fromUnits(toUnits(r.rate))]));
}

/** ESIC coverage facts of each subject: the contribution period of `day`, its coverage date and the two monthly rates. */
async function esicFacts(
  db: Queryable,
  companyId: string,
  subjects: readonly { key: string; employeeId: string; day: string; joiningDate: string; headRevisionId: string; parameters: EsicParameters }[],
): Promise<Map<string, Omit<EsicFacts, 'wages'>>> {
  const dated = subjects.map((s) => {
    const periodStart = contributionPeriodStart(s.parameters, s.day);
    return { ...s, periodStart, coverageDate: s.joiningDate > periodStart ? s.joiningDate : periodStart };
  });
  const atCoverage = await wageRates(db, companyId, dated.map((s) => ({ key: s.key, employeeId: s.employeeId, day: s.coverageDate, headRevisionId: s.headRevisionId })));
  const now = await wageRates(db, companyId, dated);
  return new Map(dated.map((s) => [s.key, { periodStart: s.periodStart, coverageDate: s.coverageDate, rateAtCoverage: atCoverage.get(s.key) ?? null, rateNow: now.get(s.key) ?? null }]));
}

/** Where a head stands before valuing: the pack code it needs, or the reason it cannot be valued. */
type Standing =
  | { ok: true; def: HeadOutput; packCode: string }
  | { ok: false; code: 'RULE_PACK_NOT_CONFIGURED'; extra: Record<string, unknown> };

function standingOf(rulePackCode: string, state: string | null | undefined): Standing {
  const def = HEAD_OUTPUTS[rulePackCode];
  if (!def) return { ok: false, code: 'RULE_PACK_NOT_CONFIGURED', extra: {} };
  if (!byState(def.family)) return { ok: true, def, packCode: def.family };
  // (INCOME_TAX: the family is the pack code.) PT and LWF: the pack of the work location's state.
  if (!state) return { ok: false, code: 'RULE_PACK_NOT_CONFIGURED', extra: { reason: `${def.family}_STATE_NOT_RECORDED` } };
  return { ok: true, def, packCode: `${def.family}_${state}` };
}

const sumOf = (amounts: readonly string[]) => fromUnits(amounts.reduce((a, x) => a + toUnits(x), 0n));

// ---------------------------------------------------------------------------------------------------------------
// Payroll (called once, from payroll/calculate.ts calculateChunk, before the lines are written)
// ---------------------------------------------------------------------------------------------------------------
/** Records of the chunk that are calculated (as payroll/calculate.ts COMPUTE). */
const COMPUTE = `r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]) and r.calculation_status = 'PENDING'
  and r.eligible_from is not null and r.salary_stop_mode is distinct from 'EXCLUDE_CALCULATION'`;

interface Pin {
  id: string;
  pack_code: string;
  pack_revision: number | null;
  currency_code: string | null;
  parameters: unknown;
}

/**
 * The pack revision the run revision uses for each code: fixed (with its currency and parameters copied) the first time a chunk needs
 * it, or fixed as none active, so every member of the revision is valued alike whatever is activated or retired between chunks.
 */
async function pinPacks(tx: Queryable, run: RunContext, userId: string, codes: readonly string[]): Promise<Map<string, Pin>> {
  for (const code of [...codes].sort()) {
    await tx.query(
      `insert into payroll_run_rule_pack (company_id, run_id, pack_code, pack_revision, currency_code, parameters, created_by)
       select $1, $2, $3, p.revision, p.currency_code, p.parameters, $5
         from (select 1) one
         left join lateral (select revision, currency_code, parameters from statutory_rule_pack
                             where company_id = $1 and code = $3 and state = 'ACTIVE' and effective_from <= $4::date
                             order by effective_from desc limit 1) p on true
       on conflict (company_id, run_id, pack_code) do nothing`,
      [run.company_id, run.id, code, run.service_end, userId],
    );
  }
  const rows = (
    await tx.query<Pin>(`select id, pack_code, pack_revision, currency_code, parameters from payroll_run_rule_pack where company_id = $1 and run_id = $2 and pack_code = any($3::text[])`, [
      run.company_id,
      run.id,
      [...codes],
    ])
  ).rows;
  return new Map(rows.map((p) => [p.pack_code, p]));
}

/**
 * The regime and deductions TDS is valued under, from the employee's accepted declaration of the year: its regime (the pack's default
 * without one, or for a regime the pack does not know) and, under the declared regime only, each declared category with the amount
 * accepted on proof replacing the declared amount, and its limit.
 */
function regimeAndDeductions(declared: Awaited<ReturnType<typeof acceptedTaxFacts>>, parameters: IncomeTaxParameters) {
  const regime: Regime = declared.regimeCode && REGIMES.includes(declared.regimeCode as Regime) ? (declared.regimeCode as Regime) : parameters.defaultRegime;
  const proved = new Map<string, bigint>();
  for (const p of declared.proved) proved.set(p.categoryCode, (proved.get(p.categoryCode) ?? 0n) + dec(p.amount));
  const lines =
    regime === declared.regimeCode
      ? declared.declared.map((d) => ({ categoryCode: d.categoryCode, amount: proved.has(d.categoryCode) ? taxText(proved.get(d.categoryCode)!) : d.amount, limit: declared.limits.get(d.categoryCode) ?? null }))
      : [];
  // Rent paid is not a deduction: it feeds the HRA exemption (hraFor), in a metro city if any rent was declared as one.
  const rentLines = lines.filter((d) => HRA_RENT_CATEGORIES[d.categoryCode]);
  const rent =
    rentLines.length > 0
      ? { amount: taxText(rentLines.reduce((s, d) => s + dec(d.amount), 0n)), metro: rentLines.some((d) => HRA_RENT_CATEGORIES[d.categoryCode]!.metro && dec(d.amount) > 0n) }
      : null;
  // An earlier employment this year (Form 12B) is not a deduction either: its salary and its tax join the year's.
  const sumOfCategory = (code: string) => lines.filter((d) => d.categoryCode === code).reduce((s, d) => s + dec(d.amount), 0n);
  const previous = { salary: sumOfCategory(PREVIOUS_EMPLOYMENT_CATEGORIES.salary), tds: sumOfCategory(PREVIOUS_EMPLOYMENT_CATEGORIES.tds) };
  return { regime, regimeSource: declared.regimeCode ? 'DECLARATION' : 'DEFAULT', deductions: lines.filter((d) => !isNotADeduction(d.categoryCode)), rent, previous };
}

/**
 * The deductions with the regime's employer NPS cap (s.80CCD(2): a share of the year's salary for HRA, Basic and DA), and the cap in the
 * workings where an employer contribution is claimed.
 */
function npsCapped(parameters: IncomeTaxParameters, regime: Regime, deductions: Deduction[], salaryForHra: bigint) {
  const capped = withEmployerNpsLimit(parameters.regimes[regime], deductions, salaryForHra);
  const claimed = deductions.some((d) => d.categoryCode === EMPLOYER_NPS_CATEGORY);
  return { deductions: capped.deductions, workings: claimed && capped.employerNpsLimit !== null ? { employerNpsLimit: capped.employerNpsLimit } : {} };
}

/** The workings of an earlier employment (only when one was declared). */
const previousWorkings = (previous: { salary: bigint; tds: bigint }) =>
  previous.salary > 0n || previous.tds > 0n ? { previousEmployerSalary: taxText(previous.salary), previousEmployerTds: taxText(previous.tds) } : {};

/**
 * The HRA exemption of the year under the regime (income-tax.ts hraExemption), from the allowance received and the salary for HRA of the
 * year and the rent of the accepted declaration; null without rent declared or where the regime has no such exemption.
 */
function hraFor(parameters: IncomeTaxParameters, regime: Regime, rent: { amount: string; metro: boolean } | null, hraReceived: bigint, salary: bigint) {
  if (!rent) return null;
  return hraExemption(parameters.regimes[regime], { hraReceived: taxText(hraReceived), salary: taxText(salary), rentPaid: rent.amount, metro: rent.metro });
}

/**
 * The employee's processed (PROCESSED_LOCKED) payroll with a period starting from `from` and before `before`: taxable earnings (EARNING
 * heads not NON_TAXABLE), the house rent allowance received (heads treated HRA_RULE_2A), salary for HRA (SALARY_FOR_HRA) and the TDS
 * deducted on TDS heads.
 */
async function processedYear(db: Queryable, companyId: string, employeeId: string, from: string, before: string) {
  return (
    await db.query<{ taxable: string; hra: string; salary: string; tds: string }>(
      `select coalesce(sum(l.amount) filter (where h.head_type = 'EARNING' and tt.code is distinct from 'NON_TAXABLE'), 0)::text as taxable,
              coalesce(sum(l.amount) filter (where h.head_type = 'EARNING' and tt.code = 'HRA_RULE_2A'), 0)::text as hra,
              coalesce(sum(l.amount) filter (where h.head_type = 'EARNING' and tt.code = 'SALARY_FOR_HRA'), 0)::text as salary,
              coalesce(sum(l.amount) filter (where h.head_type = 'DEDUCTION' and h.rule_pack_code = 'TDS'), 0)::text as tds
         from payroll_line l
         join payroll_record rec on rec.company_id = l.company_id and rec.id = l.record_id and rec.calculation_status = 'CALCULATED'
         join payroll_run ru on ru.company_id = rec.company_id and ru.id = rec.run_id and ru.state = 'PROCESSED_LOCKED'
         join payroll_head_revision h on h.company_id = l.company_id and h.id = l.head_revision_id
         left join reference_value tt on tt.company_id = h.company_id and tt.id = h.tax_treatment_id
        where l.company_id = $1 and rec.employee_id = $2 and ru.service_start >= $3::date and ru.service_start < $4::date`,
      [companyId, employeeId, from, before],
    )
  ).rows[0]!;
}

/** The HRA workings recorded with a TDS valuation (the year's figures, and the exemption's limits where one was computed). */
const hraWorkings = (hraReceived: bigint, salary: bigint, hra: ReturnType<typeof hraFor>) => ({
  hraReceivedYear: taxText(hraReceived),
  salaryForHraYear: taxText(salary),
  hraExemption: hra?.exemption ?? '0.00',
  ...(hra ? { hraRentPaid: hra.rentPaid, hraMetro: hra.metro, hraRentLessSalaryShare: hra.rentLessSalaryShare, hraSalaryShare: hra.salaryShare } : {}),
});

/**
 * I-90 TDS on salary for each record of the chunk with a TDS head (decided under owner delegation, 6 Nov 2026). The year is the financial
 * year of the period's last day. Projected annual taxable salary = taxable earnings of the employee's processed payroll earlier in the year
 * + this record's taxable earnings + the monthly taxable FIXED earnings of the salary arrangement in force for each month left after this
 * one (to March, or to the month of an approved last working date). Taxable earnings are EARNING heads whose tax treatment is not
 * NON_TAXABLE. The regime and deductions are the employee's ACCEPTED declaration of the year (regimeAndDeductions); without one, the
 * pack's default regime and no deductions. The month's TDS is the year's tax less the TDS already deducted on TDS heads this year, spread
 * over the months left including this one (income-tax.ts).
 */
async function tdsValuations(
  tx: Queryable,
  run: RunContext,
  entries: readonly { key: string; recordId: string; employeeId: string; parameters: IncomeTaxParameters }[],
  lines: readonly { record_id: string; component_id: string; head_type: string; amount: string }[],
): Promise<Map<string, Valuation>> {
  const out = new Map<string, Valuation>();
  if (entries.length === 0) return out;
  const fiscalYear = fiscalYearOf(run.service_end);
  const yearStart = `${fiscalYear.slice(0, 4)}-04-01`;
  const yearEnd = `${Number(fiscalYear.slice(0, 4)) + 1}-03-31`;
  // The run's earning heads by tax treatment: taxable (not NON_TAXABLE), house rent allowance (HRA_RULE_2A), salary for HRA.
  const heads = (
    await tx.query<{ component_id: string; code: string | null }>(
      `select rh.component_id, tt.code from payroll_run_head rh
         join payroll_head_revision h on h.company_id = rh.company_id and h.id = rh.head_revision_id and h.in_use and h.head_type = 'EARNING'
         left join reference_value tt on tt.company_id = h.company_id and tt.id = h.tax_treatment_id
        where rh.company_id = $1 and rh.run_id = $2`,
      [run.company_id, run.id],
    )
  ).rows;
  const taxable = new Set(heads.filter((r) => r.code !== 'NON_TAXABLE').map((r) => r.component_id));
  const hraHeads = new Set(heads.filter((r) => r.code === 'HRA_RULE_2A').map((r) => r.component_id));
  const salaryHeads = new Set(heads.filter((r) => r.code === 'SALARY_FOR_HRA').map((r) => r.component_id));
  for (const e of entries) {
    const earlier = await processedYear(tx, run.company_id, e.employeeId, yearStart, run.service_start);
    const leavingDate = (await tx.query<{ d: string | null }>(`select to_char(hrms_exit_last_working_date($1, $2), 'YYYY-MM-DD') as d`, [run.company_id, e.employeeId])).rows[0]!.d;
    // The monthly FIXED components of the salary arrangement in force on the period's last day.
    const monthly = (
      await tx.query<{ component_id: string; amount: string }>(
        `select sc.component_id, sum(sc.amount)::text as amount from salary_arrangement sa
           join salary_component sc on sc.company_id = sa.company_id and sc.salary_arrangement_id = sa.id and sc.basis = 'MONTHLY'
          where sa.company_id = $1 and sa.employee_id = $2 and sa.superseded_at is null and sa.effective_from <= $3::date
            and (sa.effective_to is null or sa.effective_to > $3::date)
          group by sc.component_id`,
        [run.company_id, e.employeeId, run.service_end],
      )
    ).rows;
    const rateOf = (set: ReadonlySet<string>) => monthly.filter((m) => set.has(m.component_id)).reduce((s, m) => s + dec(m.amount), 0n);
    const thisMonthOf = (set: ReadonlySet<string>) => dec(sumOf(lines.filter((l) => l.record_id === e.recordId && l.head_type === 'EARNING' && set.has(l.component_id)).map((l) => l.amount)));
    const thisMonth = thisMonthOf(taxable);
    // Months left after this one, to March, or to the month of an approved last working date within the year.
    const monthIndex = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7));
    const lastDay = leavingDate && leavingDate <= yearEnd ? leavingDate : yearEnd;
    const monthsAfter = Math.max(0, monthIndex(lastDay) - monthIndex(run.service_end));
    const year = (done: string, set: ReadonlySet<string>) => dec(done) + thisMonthOf(set) + rateOf(set) * BigInt(monthsAfter);
    const annualGross = year(earlier.taxable, taxable);
    const { regime, regimeSource, deductions, rent, previous } = regimeAndDeductions(await acceptedTaxFacts(tx, run.company_id, e.employeeId, fiscalYear), e.parameters);
    const hraReceived = year(earlier.hra, hraHeads);
    const salaryForHra = year(earlier.salary, salaryHeads);
    const hra = hraFor(e.parameters, regime, rent, hraReceived, salaryForHra);
    const nps = npsCapped(e.parameters, regime, deductions, salaryForHra);
    const income = taxableIncome(e.parameters, regime, taxText(annualGross + previous.salary - dec(hra?.exemption ?? '0')), nps.deductions);
    const tax = incomeTax(e.parameters, regime, income.taxable);
    const amount = monthlyTds(tax.total, taxText(dec(earlier.tds) + previous.tds), monthsAfter + 1);
    const workings = {
      fiscalYear,
      regime,
      regimeSource,
      earlierTaxableSalary: taxText(dec(earlier.taxable)),
      thisMonthTaxableSalary: taxText(thisMonth),
      monthlyTaxableRate: taxText(rateOf(taxable)),
      monthsProjected: monthsAfter,
      projectedAnnualSalary: taxText(annualGross),
      ...previousWorkings(previous),
      ...hraWorkings(hraReceived, salaryForHra, hra),
      ...nps.workings,
      standardDeduction: income.standardDeduction,
      deductionsAllowed: income.deductionsAllowed,
      taxableIncome: income.taxable,
      annualTax: tax.total,
      tdsEarlier: taxText(dec(earlier.tds)),
      monthsLeft: monthsAfter + 1,
    };
    out.set(e.key, dec(amount) > 0n ? { status: 'VALUED', amount, workings } : { status: 'NOT_APPLICABLE', reason: 'NO_TAX_DUE', workings });
  }
  return out;
}

interface PayrollPair {
  record_id: string;
  employee_id: string;
  joining_date: string;
  eligible_to: string;
  component_id: string;
  component_code: string;
  head_revision_id: string;
  head_type: string;
  rule_pack_code: string;
}

/**
 * Every RULE_PACK head that applies to a calculated record of the chunk (its own component is among the record's salary components, or
 * one of its base heads is paid as a salary component or an approved input: a pack calculated on BASIC applies to everyone paid BASIC).
 * A head that cannot be valued raises its blocking exception, RULE_PACK_NOT_CONFIGURED {componentCode, rulePackCode} unchanged where no
 * pack is active (I-28). The others are valued, for records without any exception that prevents amounts, from the record's own lines
 * (`linesSql`, the calculation's derivation from its snapshot) and written to payroll_record_statutory, from which the calculation
 * derives their lines.
 */
export async function evaluateRulePackHeads(tx: Queryable, run: RunContext, userId: string, ids: readonly string[], linesSql: (recordFilter: string) => string): Promise<void> {
  const base = [run.company_id, run.id, ids];
  const pairs = (
    await tx.query<PayrollPair>(
      `select r.id as record_id, r.employee_id, to_char(r.joining_date, 'YYYY-MM-DD') as joining_date, to_char(r.eligible_to, 'YYYY-MM-DD') as eligible_to,
              h.component_id, pc.code as component_code, h.id as head_revision_id, h.head_type, h.rule_pack_code
         from payroll_record r
         join payroll_run_head rh on rh.company_id = r.company_id and rh.run_id = r.run_id
         join payroll_head_revision h on h.company_id = rh.company_id and h.id = rh.head_revision_id and h.in_use and h.calculation_basis = 'RULE_PACK'
         join pay_component pc on pc.company_id = h.company_id and pc.id = h.component_id
        where ${COMPUTE}
          and (exists (select 1 from payroll_record_component c where c.company_id = r.company_id and c.record_id = r.id and c.component_id = h.component_id)
               or exists (select 1 from payroll_head_base b
                           where b.company_id = h.company_id and b.head_revision_id = h.id
                             and (exists (select 1 from payroll_record_component c where c.company_id = r.company_id and c.record_id = r.id and c.component_id = b.base_component_id)
                                  or exists (select 1 from payroll_record_input i where i.company_id = r.company_id and i.record_id = r.id and i.component_id = b.base_component_id))))
        order by r.id, h.component_id`,
      base,
    )
  ).rows;
  if (pairs.length === 0) return;

  const states = await ptStates(
    tx,
    run.company_id,
    pairs.filter((p) => byState(HEAD_OUTPUTS[p.rule_pack_code]?.family ?? 'PF')).map((p) => ({ key: p.record_id, employeeId: p.employee_id, day: p.eligible_to })),
  );
  const standings = pairs.map((p) => ({ pair: p, standing: standingOf(p.rule_pack_code, states.get(p.record_id)) }));
  const pins = await pinPacks(tx, run, userId, [...new Set(standings.flatMap((s) => (s.standing.ok ? [s.standing.packCode] : [])))]);

  const exceptions: { record: string; employee: string; code: string; detail: Record<string, unknown> }[] = [];
  const evaluable: { pair: PayrollPair; def: HeadOutput; packCode: string; pin: Pin; parameters: unknown }[] = [];
  for (const { pair: p, standing } of standings) {
    const named = { componentCode: p.component_code, rulePackCode: p.rule_pack_code };
    const raise = (code: string, extra: Record<string, unknown> = {}) => exceptions.push({ record: p.record_id, employee: p.employee_id, code, detail: { ...named, ...extra } });
    if (!standing.ok) {
      raise(standing.code, standing.extra);
      continue;
    }
    const pt = byState(standing.def.family) ? { packCode: standing.packCode } : {};
    const pin = pins.get(standing.packCode);
    if (!pin || pin.pack_revision === null) raise('RULE_PACK_NOT_CONFIGURED', pt);
    else if (p.head_type !== standing.def.headType) raise('RULE_PACK_HEAD_MISMATCH', { expectedHeadType: standing.def.headType });
    else if (pin.currency_code !== run.currency_code) raise('RULE_PACK_CURRENCY_MISMATCH', { packCode: standing.packCode, packCurrency: pin.currency_code });
    else {
      const checked = packParameters(standing.packCode, pin.parameters);
      if (!checked.ok) raise('RULE_PACK_INVALID', { packCode: standing.packCode, packRevision: pin.pack_revision });
      // I-90: an income tax revision values only its own financial year; another year's is not this one's law.
      else if (standing.def.family === 'INCOME_TAX' && (checked.parameters as IncomeTaxParameters).fiscalYear !== fiscalYearOf(run.service_end)) {
        raise('RULE_PACK_NOT_CONFIGURED', { packCode: standing.packCode, reason: 'NO_PACK_FOR_FISCAL_YEAR', fiscalYear: fiscalYearOf(run.service_end) });
      } else evaluable.push({ pair: p, def: standing.def, packCode: standing.packCode, pin, parameters: checked.parameters });
    }
  }
  if (exceptions.length > 0) {
    await tx.query(
      `insert into payroll_exception (company_id, run_id, record_id, employee_id, code, severity, resolvable, detail, created_by, updated_by)
       select $1, $2, m.record_id, m.employee_id, m.code, 'BLOCKING', false, m.detail, $3, $3
         from unnest($4::uuid[], $5::uuid[], $6::text[], $7::jsonb[]) m (record_id, employee_id, code, detail)`,
      [run.company_id, run.id, userId, exceptions.map((x) => x.record), exceptions.map((x) => x.employee), exceptions.map((x) => x.code), exceptions.map((x) => JSON.stringify(x.detail))],
    );
  }
  if (evaluable.length === 0) return;

  // Only records the calculation will value (no exception that prevents amounts) are valued here.
  const open = new Set(
    (
      await tx.query<{ id: string }>(
        `select r.id from payroll_record r
          where r.company_id = $1 and r.id = any($2::uuid[])
            and not exists (select 1 from payroll_exception x where x.company_id = r.company_id and x.record_id = r.id and x.severity = 'BLOCKING' and not x.resolvable)`,
        [run.company_id, [...new Set(evaluable.map((e) => e.pair.record_id))]],
      )
    ).rows.map((r) => r.id),
  );
  const toValue = evaluable.filter((e) => open.has(e.pair.record_id));
  if (toValue.length === 0) return;

  const lines = (
    await tx.query<{ record_id: string; component_id: string; head_type: string; amount: string }>(
      `select l.record_id, l.component_id, l.head_type, l.amount::text as amount from (${linesSql(`r.calculation_status = 'PENDING' and r.id = any($4::uuid[])`)}) l`,
      [...base, [...open]],
    )
  ).rows;
  const bases = (
    await tx.query<{ head_revision_id: string; base_component_id: string }>(`select head_revision_id, base_component_id from payroll_head_base where company_id = $1 and head_revision_id = any($2::uuid[])`, [
      run.company_id,
      [...new Set(toValue.map((e) => e.pair.head_revision_id))],
    ])
  ).rows;
  const wagesOf = (recordId: string, headRevisionId: string) => {
    const of = new Set(bases.filter((b) => b.head_revision_id === headRevisionId).map((b) => b.base_component_id));
    return sumOf(lines.filter((l) => l.record_id === recordId && l.head_type === 'EARNING' && of.has(l.component_id)).map((l) => l.amount));
  };
  const keyOf = (e: { pair: PayrollPair }) => `${e.pair.record_id}:${e.pair.component_id}`;
  const options = await pfOptions(
    tx,
    run.company_id,
    toValue.filter((e) => e.def.family === 'PF').map((e) => ({ key: keyOf(e), employeeId: e.pair.employee_id, day: e.pair.eligible_to })),
  );
  const esic = await esicFacts(
    tx,
    run.company_id,
    toValue
      .filter((e) => e.def.family === 'ESIC')
      .map((e) => ({ key: keyOf(e), employeeId: e.pair.employee_id, day: e.pair.eligible_to, joiningDate: e.pair.joining_date, headRevisionId: e.pair.head_revision_id, parameters: e.parameters as EsicParameters })),
  );
  const month = Number(run.service_start.slice(5, 7));
  const tds = await tdsValuations(
    tx,
    run,
    toValue.filter((e) => e.def.family === 'INCOME_TAX').map((e) => ({ key: keyOf(e), recordId: e.pair.record_id, employeeId: e.pair.employee_id, parameters: e.parameters as IncomeTaxParameters })),
    lines,
  );
  const rows = toValue.map((e) => {
    const wages = wagesOf(e.pair.record_id, e.pair.head_revision_id);
    const v =
      e.def.family === 'INCOME_TAX'
        ? tds.get(keyOf(e))!
        : valueHead(e.def, e.parameters, { wages, month, option: options.get(keyOf(e)) ?? 'STATUTORY_CEILING', esic: esic.get(keyOf(e)) ?? null });
    const workings = { packCode: e.packCode, packRevision: e.pin.pack_revision, output: e.def.output, ...v.workings, ...(v.status === 'NOT_APPLICABLE' ? { reason: v.reason } : {}) };
    return { e, status: v.status, amount: v.status === 'VALUED' ? v.amount : null, workings };
  });
  await tx.query(
    `insert into payroll_record_statutory (company_id, run_id, record_id, employee_id, component_id, head_revision_id, head_type, rule_pack_code, pin_id, status, amount, workings, created_by)
     select $1, $2, m.record_id, m.employee_id, m.component_id, m.head_revision_id, m.head_type, m.rule_pack_code, m.pin_id, m.status, m.amount, m.workings, $3
       from unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[], $8::text[], $9::text[], $10::uuid[], $11::text[], $12::numeric[], $13::jsonb[])
            m (record_id, employee_id, component_id, head_revision_id, head_type, rule_pack_code, pin_id, status, amount, workings)`,
    [
      run.company_id,
      run.id,
      userId,
      rows.map((r) => r.e.pair.record_id),
      rows.map((r) => r.e.pair.employee_id),
      rows.map((r) => r.e.pair.component_id),
      rows.map((r) => r.e.pair.head_revision_id),
      rows.map((r) => r.e.pair.head_type),
      rows.map((r) => r.e.pair.rule_pack_code),
      rows.map((r) => r.e.pin.id),
      rows.map((r) => r.status),
      rows.map((r) => r.amount),
      rows.map((r) => JSON.stringify(r.workings)),
    ],
  );
}

const codesOf = (family: HeadOutput['family']) =>
  Object.entries(HEAD_OUTPUTS)
    .filter(([, d]) => d.family === family)
    .map(([code]) => code);

/**
 * P8a gap 2 (decided under owner delegation, 6 Nov 2026; as payroll/calculate.ts mastersChanged, docs/10 A2): what the statutory
 * evaluation read must still hold when processing starts, or the run returns for a new revision rather than freezing a deduction the facts
 * no longer support. Counts the run's calculated records whose statutory rows disagree with the facts now:
 *  packs           the revision of a pinned pack in effect for the period (one activated or retired since the calculation);
 *  pfOptions       the PF option in force on the record's last day (employee_pf_option);
 *  ptStates        the professional tax state of the record's work location on its last day (location_pt_state), as the pack it names;
 *  lwfStates       likewise for the labour welfare fund pack (LWF_<state>);
 *  taxDeclarations for TDS, the regime and the deductions allowed from the accepted declaration and proofs (an acceptance since).
 * Values, not timestamps, so an unrelated change blocks nothing. Reads only.
 */
export async function statutoryChanged(tx: Queryable, companyId: string, runId: string) {
  // The calculated records' statutory rows (s, record r, pin p, run ru).
  const rows = `from payroll_record_statutory s
                join payroll_record r on r.company_id = s.company_id and r.id = s.record_id and r.calculation_status = 'CALCULATED'
                join payroll_run_rule_pack p on p.company_id = s.company_id and p.id = s.pin_id
                join payroll_run ru on ru.company_id = s.company_id and ru.id = s.run_id
               where s.company_id = $1 and s.run_id = $2`;
  // The state of the record's work location on its last day, as ptStates reads it.
  const stateNow = `(select st.state_code from employment_assignment a
                       join location_pt_state st on st.company_id = a.company_id and st.location_id = a.location_id and st.effective_from <= r.eligible_to
                      where a.company_id = r.company_id and a.employee_id = r.employee_id and a.effective_from <= r.eligible_to
                        and (a.effective_to is null or a.effective_to > r.eligible_to)
                      order by st.effective_from desc, st.sequence desc limit 1)`;
  const counts = (
    await tx.query<{ packs: number; pf_options: number; pt_states: number; lwf_states: number }>(
      `select
         (select count(distinct s.record_id)::int ${rows}
             and p.pack_revision is distinct from (select x.revision from statutory_rule_pack x
                                                    where x.company_id = p.company_id and x.code = p.pack_code and x.state = 'ACTIVE' and x.effective_from <= ru.service_end
                                                    order by x.effective_from desc limit 1)) as packs,
         (select count(distinct s.record_id)::int ${rows} and s.rule_pack_code = any($3::text[])
             and (s.workings ->> 'option') is distinct from coalesce((select o.contribution_basis from employee_pf_option o
                                                                       where o.company_id = r.company_id and o.employee_id = r.employee_id and o.effective_from <= r.eligible_to
                                                                       order by o.effective_from desc, o.sequence desc limit 1), 'STATUTORY_CEILING')) as pf_options,
         (select count(distinct s.record_id)::int ${rows} and s.rule_pack_code = any($4::text[])
             and (s.workings ->> 'packCode') is distinct from 'PT_' || ${stateNow}) as pt_states,
         (select count(distinct s.record_id)::int ${rows} and s.rule_pack_code = any($5::text[])
             and (s.workings ->> 'packCode') is distinct from 'LWF_' || ${stateNow}) as lwf_states`,
      [companyId, runId, codesOf('PF'), codesOf('PT'), codesOf('LWF')],
    )
  ).rows[0]!;
  const tds = (
    await tx.query<{ record_id: string; employee_id: string; workings: Record<string, unknown>; pack_code: string; parameters: unknown }>(
      `select s.record_id, r.employee_id, s.workings, p.pack_code, p.parameters ${rows} and s.rule_pack_code = any($3::text[])`,
      [companyId, runId, codesOf('INCOME_TAX')],
    )
  ).rows;
  const declarations = new Set<string>();
  for (const t of tds) {
    const checked = packParameters(t.pack_code, t.parameters);
    if (!checked.ok) continue; // never valued (RULE_PACK_INVALID)
    const parameters = checked.parameters as IncomeTaxParameters;
    const now = regimeAndDeductions(await acceptedTaxFacts(tx, companyId, t.employee_id, String(t.workings.fiscalYear)), parameters);
    // The HRA exemption from the rent accepted now, on the year's allowance and salary the valuation projected.
    const hra = hraFor(parameters, now.regime, now.rent, dec(String(t.workings.hraReceivedYear ?? '0')), dec(String(t.workings.salaryForHraYear ?? '0')));
    const exemption = hra?.exemption ?? '0.00';
    const capped = npsCapped(parameters, now.regime, now.deductions, dec(String(t.workings.salaryForHraYear ?? '0'))).deductions;
    const allowed = taxableIncome(parameters, now.regime, taxText(dec(String(t.workings.projectedAnnualSalary)) + now.previous.salary - dec(exemption)), capped).deductionsAllowed;
    // An earlier employment (Form 12B) declared, proved or changed since: its salary or its tax differs from what the valuation used.
    const previousNow = previousWorkings(now.previous);
    const previousChanged =
      (previousNow.previousEmployerSalary ?? null) !== (t.workings.previousEmployerSalary ?? null) || (previousNow.previousEmployerTds ?? null) !== (t.workings.previousEmployerTds ?? null);
    if (
      now.regime !== t.workings.regime ||
      now.regimeSource !== t.workings.regimeSource ||
      allowed !== t.workings.deductionsAllowed ||
      exemption !== (t.workings.hraExemption ?? '0.00') ||
      previousChanged
    ) {
      declarations.add(t.record_id);
    }
  }
  return { packs: counts.packs, pfOptions: counts.pf_options, ptStates: counts.pt_states, lwfStates: counts.lwf_states, taxDeclarations: declarations.size };
}

// ---------------------------------------------------------------------------------------------------------------
// Settlement (FR-052; I-88 item 10): the calculation's STATUTORY_DEDUCTION items, and the approval gate's re-evaluation
// ---------------------------------------------------------------------------------------------------------------
/**
 * I-90 follow-up (decided under owner delegation, 6 Nov 2026): TDS in a final settlement. Employment ends with it, so nothing is
 * projected: the year's taxable salary is the taxable earnings of the employee's processed payroll this financial year plus the taxable
 * earnings the settlement pays (positive amounts on EARNING components whose head in effect is not NON_TAXABLE; a component without a
 * head is taxable). Recoveries (notice, loans) do not reduce it. Regime and deductions as payroll (regimeAndDeductions). The TDS is the
 * year's tax less the TDS already deducted on TDS heads this year, rounded to the unit; never negative (an over-deduction is claimed in
 * the employee's return, not refunded by the settlement).
 */
async function settlementTds(
  db: Queryable,
  input: { companyId: string; employeeId: string; headsDay: string; factsDay: string },
  totals: ReadonlyMap<string, bigint>,
  parameters: IncomeTaxParameters,
): Promise<Valuation> {
  const fiscalYear = fiscalYearOf(input.factsDay);
  const yearStart = `${fiscalYear.slice(0, 4)}-04-01`;
  const nextYearStart = `${Number(fiscalYear.slice(0, 4)) + 1}-04-01`;
  // The EARNING components the settlement pays, by the tax treatment of their head in effect (none: taxable).
  const kinds = (
    await db.query<{ id: string; code: string | null }>(
      `select pc.id, tt.code from pay_component pc
         left join lateral (select h.tax_treatment_id from payroll_head_revision h
                             where h.company_id = pc.company_id and h.component_id = pc.id and h.state = 'ACTIVE' and h.effective_from <= $3::date
                             order by h.effective_from desc limit 1) h on true
         left join reference_value tt on tt.company_id = pc.company_id and tt.id = h.tax_treatment_id
        where pc.company_id = $1 and pc.id = any($2::uuid[]) and pc.component_kind = 'EARNING'`,
      [input.companyId, [...totals.keys()], input.headsDay],
    )
  ).rows;
  const paid = (pick: (code: string | null) => boolean) => {
    const of = new Set(kinds.filter((k) => pick(k.code)).map((k) => k.id));
    return dec(fromUnits([...totals].filter(([k, v]) => of.has(k) && v > 0n).reduce((a, [, v]) => a + v, 0n)));
  };
  const settlementTaxable = paid((c) => c !== 'NON_TAXABLE');
  const earlier = await processedYear(db, input.companyId, input.employeeId, yearStart, nextYearStart);
  const annual = dec(earlier.taxable) + settlementTaxable;
  const { regime, regimeSource, deductions, rent, previous } = regimeAndDeductions(await acceptedTaxFacts(db, input.companyId, input.employeeId, fiscalYear), parameters);
  const hraReceived = dec(earlier.hra) + paid((c) => c === 'HRA_RULE_2A');
  const salaryForHra = dec(earlier.salary) + paid((c) => c === 'SALARY_FOR_HRA');
  const hra = hraFor(parameters, regime, rent, hraReceived, salaryForHra);
  const nps = npsCapped(parameters, regime, deductions, salaryForHra);
  const income = taxableIncome(parameters, regime, taxText(annual + previous.salary - dec(hra?.exemption ?? '0')), nps.deductions);
  const tax = incomeTax(parameters, regime, income.taxable);
  const amount = fromUnits(toUnits(monthlyTds(tax.total, taxText(dec(earlier.tds) + previous.tds), 1)));
  const workings = {
    fiscalYear,
    regime,
    regimeSource,
    earlierTaxableSalary: taxText(dec(earlier.taxable)),
    settlementTaxableSalary: taxText(settlementTaxable),
    annualSalary: taxText(annual),
    ...previousWorkings(previous),
    ...hraWorkings(hraReceived, salaryForHra, hra),
    ...nps.workings,
    standardDeduction: income.standardDeduction,
    deductionsAllowed: income.deductionsAllowed,
    taxableIncome: income.taxable,
    annualTax: tax.total,
    tdsEarlier: taxText(dec(earlier.tds)),
  };
  return toUnits(amount) > 0n ? { status: 'VALUED', amount, workings } : { status: 'NOT_APPLICABLE', reason: 'NO_TAX_DUE', workings };
}

export interface StatutoryItem {
  kind: 'STATUTORY_DEDUCTION';
  status: string;
  componentId: string | null;
  amount: string | null;
  basis: Record<string, unknown>;
  headRevisionId?: string;
  /** Not stored with the item; for the approval gate's blockers. */
  componentCode?: string;
  rulePackCode?: string;
}

interface SettlementHead {
  headRevisionId: string;
  componentId: string;
  componentCode: string;
  headType: string;
  rulePackCode: string;
  baseIds: string[];
  baseCodes: string[];
}

/**
 * The RULE_PACK heads in effect on `day` that apply to the components given: one of its base heads is paid (`paid`, above zero) or its
 * own component appears (`present`), as the payroll core applies them. `baseCodes` names the paid bases.
 */
export async function rulePackHeadsFor(db: Queryable, companyId: string, day: string, paid: readonly string[], present: readonly string[]): Promise<SettlementHead[]> {
  if (paid.length === 0 && present.length === 0) return [];
  return (
    await db.query<SettlementHead>(
      `with heads as (
         select distinct on (h.component_id) h.id, h.component_id, h.in_use, h.calculation_basis, h.rule_pack_code, h.head_type
           from payroll_head_revision h where h.company_id = $1 and h.state = 'ACTIVE' and h.effective_from <= $2::date
          order by h.component_id, h.effective_from desc)
       select h.id as "headRevisionId", h.component_id as "componentId", pc.code as "componentCode", h.head_type as "headType", h.rule_pack_code as "rulePackCode",
              coalesce(array_agg(b.base_component_id order by b.base_component_id) filter (where b.id is not null), '{}') as "baseIds",
              coalesce(array_agg(bc.code order by bc.code) filter (where b.base_component_id = any($3::uuid[])), '{}') as "baseCodes"
         from heads h
         join pay_component pc on pc.company_id = $1 and pc.id = h.component_id
         left join payroll_head_base b on b.company_id = $1 and b.head_revision_id = h.id
         left join pay_component bc on bc.company_id = $1 and bc.id = b.base_component_id
        where h.in_use and h.calculation_basis = 'RULE_PACK'
        group by h.id, h.component_id, pc.code, h.rule_pack_code, h.head_type
       having count(b.id) filter (where b.base_component_id = any($3::uuid[])) > 0 or h.component_id = any($4::uuid[])
        order by pc.code`,
      [companyId, day, [...paid], [...present]],
    )
  ).rows;
}

/**
 * The STATUTORY_DEDUCTION items of a settlement: every RULE_PACK head that applies to `amounts` (signed settlement amounts per component:
 * the calculated items and the entered lines), valued from the pack ACTIVE on `factsDay` (the last working date) where there is one.
 * The employee's PF, ESIC and professional tax are CALCULATED deductions (negative, as a deduction line is); an employer contribution
 * is NOT_APPLICABLE with its `employerCost` in the basis, because it is never a settlement line or part of the net; a head that cannot be
 * valued is RULE_PACK_NOT_CONFIGURED (blocking), as before. With no head at all, one NOT_APPLICABLE item says tax is not calculated.
 */
export async function settlementStatutoryItems(
  db: Queryable,
  input: { companyId: string; employeeId: string; headsDay: string; factsDay: string; currency: string; amounts: readonly { componentId: string; amount: string }[]; present?: readonly string[] },
): Promise<StatutoryItem[]> {
  const totals = new Map<string, bigint>();
  for (const a of input.amounts) totals.set(a.componentId, (totals.get(a.componentId) ?? 0n) + toUnits(a.amount));
  const paid = [...totals].filter(([, v]) => v > 0n).map(([k]) => k);
  const heads = await rulePackHeadsFor(db, input.companyId, input.headsDay, paid, input.present ?? []);
  if (heads.length === 0) {
    return [
      {
        kind: 'STATUTORY_DEDUCTION',
        status: 'NOT_APPLICABLE',
        componentId: null,
        amount: null,
        basis: { tax: 'NOT_CONFIGURED', reason: 'No statutory rule-pack head (tax, PF, ESIC, PT) applies to the components this settlement pays, so none is calculated' },
      },
    ];
  }
  const joiningDate = (await db.query<{ d: string }>(`select to_char(joining_date, 'YYYY-MM-DD') as d from employee where company_id = $1 and id = $2`, [input.companyId, input.employeeId])).rows[0]!.d;
  const subject = (key: string) => ({ key, employeeId: input.employeeId, day: input.factsDay });
  const state = (await ptStates(db, input.companyId, [subject('pt')])).get('pt');
  const option = (await pfOptions(db, input.companyId, [subject('pf')])).get('pf') ?? 'STATUTORY_CEILING';
  const month = Number(input.factsDay.slice(5, 7));
  const items: StatutoryItem[] = [];
  for (const h of heads) {
    const named = { rulePackCode: h.rulePackCode, baseComponentCodes: h.baseCodes };
    const item = (status: string, basis: Record<string, unknown>, amount: string | null = null) =>
      items.push({ kind: 'STATUTORY_DEDUCTION', status, componentId: h.componentId, amount, basis, headRevisionId: h.headRevisionId, componentCode: h.componentCode, rulePackCode: h.rulePackCode });
    const standing = standingOf(h.rulePackCode, state);
    if (!standing.ok) {
      item(standing.code, { ...named, ...standing.extra });
      continue;
    }
    const pt = byState(standing.def.family) || standing.def.family === 'INCOME_TAX' ? { packCode: standing.packCode } : {};
    const pack = await packInEffect(db, input.companyId, standing.packCode, input.factsDay);
    if (!pack?.active) {
      item('RULE_PACK_NOT_CONFIGURED', { ...named, ...pt });
      continue;
    }
    const packRef = { ...named, packCode: standing.packCode, packId: pack.pack.id, packRevision: pack.pack.revision };
    if (h.headType !== standing.def.headType) {
      item('HEAD_NOT_CONFIGURED', { ...packRef, expectedHeadType: standing.def.headType, reason: 'The head type does not match the pack output its rule-pack code names' });
      continue;
    }
    if (pack.pack.currencyCode !== input.currency) {
      item('CURRENCY_MISMATCH', { ...packRef, packCurrency: pack.pack.currencyCode, settlementCurrency: input.currency });
      continue;
    }
    const checked = packParameters(standing.packCode, pack.pack.parameters);
    if (!checked.ok) {
      item('RULE_PACK_NOT_CONFIGURED', { ...packRef, reason: 'The active pack revision has parameters this build cannot read' });
      continue;
    }
    if (standing.def.family === 'INCOME_TAX') {
      // I-90 follow-up: TDS on what the settlement pays, for the year as it ends (settlementTds).
      const fiscalYear = fiscalYearOf(input.factsDay);
      if ((checked.parameters as IncomeTaxParameters).fiscalYear !== fiscalYear) {
        item('RULE_PACK_NOT_CONFIGURED', { ...packRef, reason: 'NO_PACK_FOR_FISCAL_YEAR', fiscalYear });
        continue;
      }
      const v = await settlementTds(db, input, totals, checked.parameters as IncomeTaxParameters);
      const basis = { ...packRef, output: standing.def.output, ...v.workings };
      if (v.status === 'NOT_APPLICABLE') item('NOT_APPLICABLE', { ...basis, reason: v.reason });
      else item('CALCULATED', basis, negate(v.amount));
      continue;
    }
    const of = new Set(h.baseIds);
    const wages = fromUnits([...totals].filter(([k, v]) => of.has(k) && v > 0n).reduce((a, [, v]) => a + v, 0n));
    const esic =
      standing.def.family === 'ESIC'
        ? ((await esicFacts(db, input.companyId, [{ ...subject('esic'), joiningDate, headRevisionId: h.headRevisionId, parameters: checked.parameters as EsicParameters }])).get('esic') ?? null)
        : null;
    const v = valueHead(standing.def, checked.parameters, { wages, month, option, esic });
    const basis = { ...packRef, output: standing.def.output, ...v.workings };
    if (v.status === 'NOT_APPLICABLE') item('NOT_APPLICABLE', { ...basis, reason: v.reason });
    else if (standing.def.headType === 'EMPLOYER_CONTRIBUTION') {
      item('NOT_APPLICABLE', { ...basis, employerCost: v.amount, reason: 'EMPLOYER_COST: an employer contribution is the employer’s cost, never a settlement line or part of the net' });
    } else item('CALCULATED', basis, negate(v.amount));
  }
  return items;
}

/**
 * The approval gate (settlement-gates.ts): every statutory head that applies to the revision's frozen lines (calculated or entered) is
 * evaluated again from them. A head that cannot be valued blocks with its status (RULE_PACK_NOT_CONFIGURED where no pack is active,
 * as before); a valued deduction whose frozen line differs from the value now (an entered line changed the wages, or the pack changed
 * since the calculation) blocks with STATUTORY_DEDUCTION_MISMATCH, until a recalculation.
 */
export async function statutoryLineBlockers(db: Queryable, companyId: string, settlementId: string, lastWorkingDate: string) {
  const s = (await db.query<{ employee_id: string; currency_code: string }>(`select employee_id, currency_code from settlement where company_id = $1 and id = $2`, [companyId, settlementId])).rows[0]!;
  const lines = (await db.query<{ componentId: string; amount: string }>(`select component_id as "componentId", amount::text as amount from settlement_line where company_id = $1 and settlement_id = $2`, [companyId, settlementId])).rows;
  const items = await settlementStatutoryItems(db, {
    companyId,
    employeeId: s.employee_id,
    headsDay: lastWorkingDate,
    factsDay: lastWorkingDate,
    currency: s.currency_code,
    amounts: lines,
    present: lines.map((l) => l.componentId),
  });
  const frozen = new Map<string, bigint>();
  for (const l of lines) frozen.set(l.componentId, (frozen.get(l.componentId) ?? 0n) + toUnits(l.amount));
  const blockers: { source: 'STATUTORY'; kind: string; code: string; componentCode: string | null; rulePackCode: string | null }[] = [];
  for (const i of items) {
    if (!i.componentId) continue;
    const blocker = (code: string) => blockers.push({ source: 'STATUTORY', kind: 'STATUTORY_DEDUCTION', code, componentCode: i.componentCode ?? null, rulePackCode: i.rulePackCode ?? null });
    if (i.status !== 'CALCULATED' && i.status !== 'NOT_APPLICABLE') blocker(i.status);
    else if ((frozen.get(i.componentId) ?? 0n) !== (i.amount ? toUnits(i.amount) : 0n)) blocker('STATUTORY_DEDUCTION_MISMATCH');
  }
  return blockers;
}
