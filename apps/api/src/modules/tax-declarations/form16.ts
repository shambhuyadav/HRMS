// Form 16 Part B data for one employee and financial year (FR-107; FR-036; FR-108; decided under owner delegation, 6 Nov 2026, docs/03 I-90).
//
// Part B is the salary and tax computation, built here from what is on record: the processed payroll of the year and a final settlement
// paid for a leaving date in it (salary on taxable heads, allowances on non-taxable heads, TDS deducted on the deduction head coded TDS),
// the employee's accepted declaration (the regime)
// and the amounts accepted on proof (deductions, each capped at its category limit), valued under the INCOME_TAX pack active for the year
// (statutory/income-tax.ts). Without an active pack nothing is valued (NOT_CONFIGURED). Part A (the employer's TAN, the challans and the
// TRACES certificate number) comes from TRACES, an outside input, so no Form 16 is issued (FR-107 stays blocked) and this is the
// reviewer's working data, never the certificate. Figures follow the pack under review: "to be validated against the law in force".
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { assertInScope, assertNotSelf } from '../payroll/common.js';
import {
  dec,
  HRA_RENT_CATEGORIES,
  hraExemption,
  incomeTax,
  type IncomeTaxParameters,
  isNotADeduction,
  PREVIOUS_EMPLOYMENT_CATEGORIES,
  type Regime,
  REGIMES,
  taxableIncome,
  text,
  validateIncomeTax,
  withEmployerNpsLimit,
} from '../statutory/income-tax.js';
import { acceptedTaxFacts } from './service.js';

const FISCAL_YEAR = /^(\d{4})-(\d{2})$/;

/** The year's dates: 2026-27 is 1 April 2026 to 31 March 2027. */
export function fiscalYearDates(fiscalYear: string): { start: string; end: string } {
  const m = FISCAL_YEAR.exec(fiscalYear);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) throw new HttpError(422, 'INVALID_FISCAL_YEAR', 'A financial year looks like 2026-27');
  return { start: `${m[1]}-04-01`, end: `${Number(m[1]) + 1}-03-31` };
}

export async function form16PartB(db: Queryable, grant: AccessGrant, employeeId: string, fiscalYear: string) {
  const { start, end } = fiscalYearDates(fiscalYear);
  await assertInScope(db, grant, employeeId);
  assertNotSelf(grant, employeeId);
  // Processed payroll of the year, by head type and tax treatment.
  const lines = (
    await db.query<{ head_type: string; treatment: string | null; rule_pack_code: string | null; amount: string }>(
      `select h.head_type, tt.code as treatment, h.rule_pack_code, sum(l.amount)::text as amount
         from payroll_line l
         join payroll_record rec on rec.company_id = l.company_id and rec.id = l.record_id
         join payroll_run ru on ru.company_id = rec.company_id and ru.id = rec.run_id and ru.state = 'PROCESSED_LOCKED'
         join payroll_head_revision h on h.company_id = l.company_id and h.id = l.head_revision_id
         left join reference_value tt on tt.company_id = h.company_id and tt.id = h.tax_treatment_id
        where l.company_id = $1 and rec.employee_id = $2 and ru.service_start >= $3::date and ru.service_start <= $4::date and rec.calculation_status = 'CALCULATED'
        group by h.head_type, tt.code, h.rule_pack_code`,
      [grant.companyId, employeeId, start, end],
    )
  ).rows;
  const sum = (pick: (l: (typeof lines)[number]) => boolean) => lines.filter(pick).reduce((s, l) => s + dec(l.amount), 0n);
  // A final settlement PAID for a leaving date in the year (I-90 follow-up): per component, what it paid on EARNING components (taxable
  // unless the head in effect is NON_TAXABLE, as statutory/evaluate.ts settlementTds) and the TDS it deducted (negative lines).
  const settled = (
    await db.query<{ kind: string; treatment: string | null; rule_pack_code: string | null; amount: string }>(
      `select pc.component_kind as kind, tt.code as treatment, h.rule_pack_code, sum(sl.amount)::text as amount
         from settlement s
         join exit_case x on x.company_id = s.company_id and x.id = s.exit_case_id and x.approved_leaving_date between $3::date and $4::date
         join settlement_line sl on sl.company_id = s.company_id and sl.settlement_id = s.id
         join pay_component pc on pc.company_id = sl.company_id and pc.id = sl.component_id
         left join lateral (select hr.tax_treatment_id, hr.rule_pack_code from payroll_head_revision hr
                             where hr.company_id = sl.company_id and hr.component_id = sl.component_id and hr.state = 'ACTIVE' and hr.effective_from <= x.approved_leaving_date
                             order by hr.effective_from desc limit 1) h on true
         left join reference_value tt on tt.company_id = s.company_id and tt.id = h.tax_treatment_id
        where s.company_id = $1 and s.employee_id = $2 and s.state = 'PAID'
        group by sl.component_id, pc.component_kind, tt.code, h.rule_pack_code`,
      [grant.companyId, employeeId, start, end],
    )
  ).rows;
  const settledSum = (pick: (l: (typeof settled)[number]) => boolean) => settled.filter(pick).reduce((s, l) => s + dec(l.amount), 0n);
  const settlementGross = settledSum((l) => l.kind === 'EARNING' && l.treatment !== 'NON_TAXABLE' && dec(l.amount) > 0n);
  const settlementExempt = settledSum((l) => l.kind === 'EARNING' && l.treatment === 'NON_TAXABLE' && dec(l.amount) > 0n);
  const settlementTds = -settledSum((l) => l.kind === 'DEDUCTION' && l.rule_pack_code === 'TDS');
  const gross = sum((l) => l.head_type === 'EARNING' && l.treatment !== 'NON_TAXABLE') + settlementGross;
  const exempt = sum((l) => l.head_type === 'EARNING' && l.treatment === 'NON_TAXABLE') + settlementExempt;
  const tds = sum((l) => l.head_type === 'DEDUCTION' && l.rule_pack_code === 'TDS') + settlementTds;
  const months = (
    await db.query<{ n: number }>(
      `select count(distinct ru.period_id)::int as n from payroll_record rec join payroll_run ru on ru.company_id = rec.company_id and ru.id = rec.run_id and ru.state = 'PROCESSED_LOCKED'
        where rec.company_id = $1 and rec.employee_id = $2 and rec.calculation_status = 'CALCULATED' and ru.service_start >= $3::date and ru.service_start <= $4::date`,
      [grant.companyId, employeeId, start, end],
    )
  ).rows[0]!.n;
  const facts = await acceptedTaxFacts(db, grant.companyId, employeeId, fiscalYear);
  const salary = {
    processedMonths: months,
    grossSalary: text(gross),
    exemptAllowances: text(exempt),
    tdsDeducted: text(tds),
    // Included in the figures above; null without a final settlement paid this year.
    finalSettlement: settled.length > 0 ? { taxableSalary: text(settlementGross), exemptAllowances: text(settlementExempt), tdsDeducted: text(settlementTds) } : null,
  };
  const partA = { status: 'NOT_AVAILABLE', reason: 'Part A (the employer TAN, the challans and the certificate number) comes from TRACES, an outside input; no Form 16 is issued here.' };
  // The INCOME_TAX revision active on the year's first day (two people validated and activated it).
  const pack = (
    await db.query<{ revision: number; parameters: unknown; statute_reference: string }>(
      `select revision, parameters, statute_reference from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX' and state = 'ACTIVE' and effective_from <= $2::date
        order by effective_from desc limit 1`,
      [grant.companyId, start],
    )
  ).rows[0];
  const checked = pack ? validateIncomeTax(pack.parameters) : null;
  if (!pack || !checked?.ok || (checked.parameters as IncomeTaxParameters).fiscalYear !== fiscalYear) {
    return {
      fiscalYear,
      employeeId,
      status: 'NOT_CONFIGURED',
      code: 'INCOME_TAX_PACK_NOT_ACTIVE',
      message: `No INCOME_TAX rule pack for ${fiscalYear} has been validated and activated; nothing is valued.`,
      salary,
      partA,
    };
  }
  const params = checked.parameters;
  const regime: Regime = facts.regimeCode && REGIMES.includes(facts.regimeCode as Regime) ? (facts.regimeCode as Regime) : params.defaultRegime;
  // Deductions: what was accepted on proof per category, each capped at its limit (declared amounts alone are not evidence at year end).
  const byCategory = new Map<string, bigint>();
  for (const p of facts.proved) byCategory.set(p.categoryCode, (byCategory.get(p.categoryCode) ?? 0n) + dec(p.amount));
  // Only under the regime the employee declared: a regime this pack does not know falls back to the default with no deductions.
  const claimed = regime === facts.regimeCode ? [...byCategory.entries()].map(([categoryCode, amount]) => ({ categoryCode, amount: text(amount), limit: facts.limits.get(categoryCode) ?? null })) : [];
  // Rent proved is not a deduction: it gives the HRA exemption of the year (statutory/income-tax.ts hraExemption), on the allowance
  // received (HRA_RULE_2A) and the salary for HRA (SALARY_FOR_HRA) of the payroll and settlement counted above.
  const deductions = claimed.filter((d) => !isNotADeduction(d.categoryCode));
  const rentLines = claimed.filter((d) => HRA_RENT_CATEGORIES[d.categoryCode]);
  // An earlier employment this year (Form 12B), as proved: its salary joins the year's, its tax what was deducted.
  const provedOf = (code: string) => claimed.filter((d) => d.categoryCode === code).reduce((s, d) => s + dec(d.amount), 0n);
  const previous = { salary: provedOf(PREVIOUS_EMPLOYMENT_CATEGORIES.salary), tds: provedOf(PREVIOUS_EMPLOYMENT_CATEGORIES.tds) };
  const paidOn = (treatment: string) =>
    sum((l) => l.head_type === 'EARNING' && l.treatment === treatment) + settledSum((l) => l.kind === 'EARNING' && l.treatment === treatment && dec(l.amount) > 0n);
  const hra =
    rentLines.length > 0
      ? hraExemption(params.regimes[regime], {
          hraReceived: text(paidOn('HRA_RULE_2A')),
          salary: text(paidOn('SALARY_FOR_HRA')),
          rentPaid: text(rentLines.reduce((s, d) => s + dec(d.amount), 0n)),
          metro: rentLines.some((d) => HRA_RENT_CATEGORIES[d.categoryCode]!.metro && dec(d.amount) > 0n),
        })
      : null;
  // s.80CCD(2): the employer's NPS contribution up to the regime's share of the year's salary (Basic and DA).
  const nps = withEmployerNpsLimit(params.regimes[regime], deductions, paidOn('SALARY_FOR_HRA'));
  const income = taxableIncome(params, regime, text(gross + previous.salary - dec(hra?.exemption ?? '0')), nps.deductions);
  const tax = incomeTax(params, regime, income.taxable);
  return {
    fiscalYear,
    employeeId,
    status: 'CALCULATED',
    pack: { code: 'INCOME_TAX', revision: pack.revision, statuteReference: pack.statute_reference },
    regime,
    regimeSource: facts.regimeCode ? 'DECLARATION' : 'DEFAULT',
    salary,
    // Form 12B as proved; null without an earlier employment this year.
    previousEmployment: previous.salary > 0n || previous.tds > 0n ? { salary: text(previous.salary), tds: text(previous.tds) } : null,
    // s.10(13A): null where no rent was proved or the regime has no such exemption.
    hraExemption: hra,
    standardDeduction: income.standardDeduction,
    deductions: nps.deductions.map((d) => ({ ...d, allowed: text(d.limit === null ? dec(d.amount) : dec(d.amount) < dec(d.limit) ? dec(d.amount) : dec(d.limit)) })),
    deductionsAllowed: income.deductionsAllowed,
    taxableIncome: income.taxable,
    tax,
    // Positive: still due; negative: deducted beyond the year's tax (the employee claims it in the return). An earlier employer's tax counts.
    balance: text(dec(tax.total) - tds - previous.tds),
    partA,
  };
}
