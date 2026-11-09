// Income tax on salary: the INCOME_TAX rule pack and its arithmetic (FR-036, FR-107, FR-108; DF05 "dated, versioned externally supplied
// rule packs"; F4; docs/10 D1). Decided under owner delegation, 6 Nov 2026 (docs/03 I-90).
//
// The pack (a statutory_rule_pack revision, code INCOME_TAX, validated by one authorised person and activated by another) holds, per
// regime, the slabs, the standard deduction, the rebate (with the new regime's marginal relief), the surcharge bands (with marginal
// relief) and the cess, and how the year's tax is rounded. The employee's declaration categories and their limits stay in the
// declaration registry (tax_rule_pack, 0128/0225), which names the regimes an employee may choose.
//
// The seed is the FY 2026-27 draft every company starts from. The Income-tax Act, 2025 applies from 1 April 2026 and renumbers the
// sections: the figures are the Finance Act 2025 values for FY 2025-26 carried forward and every value and section reference is
// recorded as "to be validated against the law in force", never as an assertion. Nothing is valued until two people have validated and
// activated a revision.
//
// The arithmetic is exact: amounts are scaled BigInts (eight decimals inside, never JavaScript numbers), each result is rounded once,
// half up, at the end.

export type Regime = 'NEW' | 'OLD';
export const REGIMES: readonly Regime[] = ['NEW', 'OLD'];

export interface Slab {
  /** Upper bound of the slab (inclusive), as a decimal amount in text; null for the last slab. */
  upTo: string | null;
  ratePercent: string;
}
export interface SurchargeBand {
  /** Taxable income above which the band applies. */
  incomeAbove: string;
  ratePercent: string;
}
export interface RegimeParameters {
  standardDeduction: string;
  slabs: Slab[];
  rebate: { incomeUpTo: string; maxAmount: string; marginalRelief: boolean };
  surcharge: SurchargeBand[];
  cessPercent: string;
  /** How the year's tax is rounded: to the nearest ten rupees or the nearest rupee, half up. */
  rounding: 'NEAREST_TEN' | 'NEAREST_RUPEE';
  /**
   * The house rent allowance exemption of the regime (s.10(13A) and rule 2A of the 1961 Act), absent where the regime has none: the
   * least of the allowance received, the rent paid less `rentAboveSalaryPercent` of salary, and `metroPercent` (a house in Delhi,
   * Mumbai, Kolkata or Chennai) or `otherPercent` of salary. Salary is Basic and DA (heads treated SALARY_FOR_HRA).
   */
  hraExemption?: { metroPercent: string; otherPercent: string; rentAboveSalaryPercent: string };
  /**
   * The employer's NPS contribution (s.80CCD(2), the declaration category SEC_80CCD_2) is deductible up to this share of salary (Basic
   * and DA, heads treated SALARY_FOR_HRA); no cap where absent.
   */
  employerNpsLimitPercent?: string;
}
export interface IncomeTaxParameters {
  /** The financial year the revision is for, e.g. 2026-27. */
  fiscalYear: string;
  /** The regime an employee who chose none is taxed under. */
  defaultRegime: Regime;
  regimes: Record<Regime, RegimeParameters>;
}

// ---------------------------------------------------------------------------------------------------------------
// Exact decimals
// ---------------------------------------------------------------------------------------------------------------

const SCALE = 8;
const ONE = 10n ** BigInt(SCALE);
const DECIMAL = /^-?\d{1,15}(\.\d{1,8})?$/;

export function dec(text: string): bigint {
  const t = text.trim();
  if (!DECIMAL.test(t)) throw new Error(`not a decimal: ${text}`);
  const negative = t.startsWith('-');
  const [w, f = ''] = (negative ? t.slice(1) : t).split('.');
  const v = BigInt(w!) * ONE + BigInt(f.padEnd(SCALE, '0'));
  return negative ? -v : v;
}
/** v rounded half up (away from zero) to `places` decimals, as text with exactly that many. */
export function text(v: bigint, places = 2): string {
  const unit = 10n ** BigInt(SCALE - places);
  const negative = v < 0n;
  const a = negative ? -v : v;
  const q = (a + unit / 2n) / unit;
  const s = q.toString().padStart(places + 1, '0');
  const out = places === 0 ? s : `${s.slice(0, -places)}.${s.slice(-places)}`;
  return negative && q !== 0n ? `-${out}` : out;
}
const roundTo = (v: bigint, unitText: string) => {
  const unit = dec(unitText);
  return ((v + unit / 2n) / unit) * unit;
};
const percentOf = (amount: bigint, ratePercent: string) => (amount * dec(ratePercent)) / (100n * ONE);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);

// ---------------------------------------------------------------------------------------------------------------
// Parameters: checks and the FY 2026-27 draft
// ---------------------------------------------------------------------------------------------------------------

const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;
const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** A percentage from 0 to 100 in text, at most four decimals (as the database check, migration 0236). */
const percent = (v: unknown): v is string => typeof v === 'string' && PERCENT.test(v) && dec(v) <= dec('100');

function checkRegime(raw: unknown, where: string, problems: string[]): void {
  if (!isObject(raw)) {
    problems.push(`${where} must be an object`);
    return;
  }
  const allowed = ['standardDeduction', 'slabs', 'rebate', 'surcharge', 'cessPercent', 'rounding', 'hraExemption', 'employerNpsLimitPercent'];
  if (raw.employerNpsLimitPercent !== undefined && !percent(raw.employerNpsLimitPercent)) problems.push(`${where}.employerNpsLimitPercent must be a percent from 0 to 100 in text`);
  if (raw.hraExemption !== undefined) {
    const x = raw.hraExemption;
    if (!isObject(x) || Object.keys(x).some((k) => !['metroPercent', 'otherPercent', 'rentAboveSalaryPercent'].includes(k)) || !percent(x.metroPercent) || !percent(x.otherPercent) || !percent(x.rentAboveSalaryPercent)) {
      problems.push(`${where}.hraExemption must be { metroPercent, otherPercent, rentAboveSalaryPercent } (percents from 0 to 100 in text)`);
    }
  }
  for (const k of Object.keys(raw)) if (!allowed.includes(k)) problems.push(`${where}: unknown parameter ${k}`);
  if (typeof raw.standardDeduction !== 'string' || !AMOUNT.test(raw.standardDeduction)) problems.push(`${where}.standardDeduction must be an amount in text`);
  const slabs = raw.slabs;
  if (!Array.isArray(slabs) || slabs.length === 0 || slabs.length > 20) problems.push(`${where}.slabs must be a list of 1 to 20 slabs`);
  else
    slabs.forEach((s: unknown, i) => {
      const at = `${where}.slabs[${i}]`;
      if (!isObject(s)) return problems.push(`${at} must be an object`);
      const last = i === slabs.length - 1;
      if (last ? s.upTo !== null : typeof s.upTo !== 'string' || !AMOUNT.test(s.upTo)) problems.push(last ? `${at}: the last slab has no upper bound (upTo null)` : `${at}.upTo must be an amount in text`);
      else if (!last && i > 0 && typeof slabs[i - 1]?.upTo === 'string' && dec(s.upTo as string) <= dec(slabs[i - 1].upTo as string)) problems.push(`${at}.upTo must be above the slab before`);
      if (!percent(s.ratePercent)) problems.push(`${at}.ratePercent must be a percent from 0 to 100 in text`);
    });
  const r = raw.rebate;
  if (!isObject(r) || typeof r.incomeUpTo !== 'string' || !AMOUNT.test(r.incomeUpTo) || typeof r.maxAmount !== 'string' || !AMOUNT.test(r.maxAmount) || typeof r.marginalRelief !== 'boolean') {
    problems.push(`${where}.rebate must be { incomeUpTo, maxAmount (amounts in text), marginalRelief (true or false) }`);
  }
  const bands = raw.surcharge;
  if (!Array.isArray(bands) || bands.length > 10) problems.push(`${where}.surcharge must be a list of up to 10 bands`);
  else
    bands.forEach((b: unknown, i) => {
      const at = `${where}.surcharge[${i}]`;
      if (!isObject(b) || typeof b.incomeAbove !== 'string' || !AMOUNT.test(b.incomeAbove) || !percent(b.ratePercent)) {
        return problems.push(`${at} must be { incomeAbove (an amount in text), ratePercent (a percent in text) }`);
      }
      if (i > 0 && isObject(bands[i - 1]) && typeof bands[i - 1].incomeAbove === 'string' && AMOUNT.test(bands[i - 1].incomeAbove) && dec(b.incomeAbove) <= dec(bands[i - 1].incomeAbove)) {
        problems.push(`${at}.incomeAbove must be above the band before`);
      }
    });
  if (!percent(raw.cessPercent)) problems.push(`${where}.cessPercent must be a percent from 0 to 100 in text`);
  if (raw.rounding !== 'NEAREST_TEN' && raw.rounding !== 'NEAREST_RUPEE') problems.push(`${where}.rounding must be NEAREST_TEN or NEAREST_RUPEE`);
}

/** Checks an INCOME_TAX revision's parameters; returns them or a list of problems (the pack definition's `validate`). */
export function validateIncomeTax(raw: unknown): { ok: true; parameters: IncomeTaxParameters } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { ok: false, problems: ['parameters must be an object'] };
  for (const k of Object.keys(raw)) if (!['fiscalYear', 'defaultRegime', 'regimes'].includes(k)) problems.push(`unknown parameter ${k}`);
  const year = typeof raw.fiscalYear === 'string' ? /^(\d{4})-(\d{2})$/.exec(raw.fiscalYear) : null;
  if (!year || (Number(year[1]) + 1) % 100 !== Number(year[2])) problems.push('fiscalYear must look like 2026-27');
  if (!REGIMES.includes(raw.defaultRegime as Regime)) problems.push('defaultRegime must be NEW or OLD');
  if (!isObject(raw.regimes)) problems.push('regimes must be an object with NEW and OLD');
  else {
    for (const k of Object.keys(raw.regimes)) if (!REGIMES.includes(k as Regime)) problems.push(`regimes: unknown regime ${k}`);
    for (const regime of REGIMES) checkRegime(raw.regimes[regime], `regimes.${regime}`, problems);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, parameters: raw as unknown as IncomeTaxParameters };
}

const TO_VALIDATE =
  'To be validated against the law in force: the Income-tax Act, 2025 applies from 1 April 2026 and renumbers the sections, so every figure and reference here is carried from the Finance Act 2025 (FY 2025-26) for review, not asserted.';

/** The FY 2026-27 draft every company starts from (a DRAFT by the system actor; never active until two people validate and activate it). */
export const INCOME_TAX_SEED: { effectiveFrom: string; currencyCode: string; parameters: IncomeTaxParameters; statuteReference: string } = {
  effectiveFrom: '2026-04-01',
  currencyCode: 'INR',
  parameters: {
    fiscalYear: '2026-27',
    defaultRegime: 'NEW',
    regimes: {
      NEW: {
        standardDeduction: '75000.00',
        slabs: [
          { upTo: '400000.00', ratePercent: '0' },
          { upTo: '800000.00', ratePercent: '5' },
          { upTo: '1200000.00', ratePercent: '10' },
          { upTo: '1600000.00', ratePercent: '15' },
          { upTo: '2000000.00', ratePercent: '20' },
          { upTo: '2400000.00', ratePercent: '25' },
          { upTo: null, ratePercent: '30' },
        ],
        rebate: { incomeUpTo: '1200000.00', maxAmount: '60000.00', marginalRelief: true },
        surcharge: [
          { incomeAbove: '5000000.00', ratePercent: '10' },
          { incomeAbove: '10000000.00', ratePercent: '15' },
          { incomeAbove: '20000000.00', ratePercent: '25' },
        ],
        cessPercent: '4',
        rounding: 'NEAREST_TEN',
        employerNpsLimitPercent: '14',
      },
      OLD: {
        standardDeduction: '50000.00',
        slabs: [
          { upTo: '250000.00', ratePercent: '0' },
          { upTo: '500000.00', ratePercent: '5' },
          { upTo: '1000000.00', ratePercent: '20' },
          { upTo: null, ratePercent: '30' },
        ],
        rebate: { incomeUpTo: '500000.00', maxAmount: '12500.00', marginalRelief: false },
        surcharge: [
          { incomeAbove: '5000000.00', ratePercent: '10' },
          { incomeAbove: '10000000.00', ratePercent: '15' },
          { incomeAbove: '20000000.00', ratePercent: '25' },
          { incomeAbove: '50000000.00', ratePercent: '37' },
        ],
        cessPercent: '4',
        rounding: 'NEAREST_TEN',
        hraExemption: { metroPercent: '50', otherPercent: '40', rentAboveSalaryPercent: '10' },
        employerNpsLimitPercent: '10',
      },
    },
  },
  statuteReference:
    'Income tax on salary, FY 2026-27. New regime (default; s.115BAC, 1961 Act): slabs 0-4 lakh nil, 4-8 lakh 5%, 8-12 lakh 10%, 12-16 lakh 15%, 16-20 lakh 20%, 20-24 lakh 25%, above 24 lakh 30%; standard deduction Rs 75,000 (s.16(ia)); rebate up to Rs 60,000 where total income does not exceed Rs 12 lakh, with marginal relief above it (s.87A); surcharge 10% above 50 lakh, 15% above 1 crore, 25% above 2 crore, with marginal relief. Old regime: slabs 0-2.5 lakh nil, 2.5-5 lakh 5%, 5-10 lakh 20%, above 10 lakh 30%; standard deduction Rs 50,000; rebate up to Rs 12,500 where total income does not exceed Rs 5 lakh; surcharge 10/15/25/37% above 50 lakh, 1, 2 and 5 crore. Cess 4% of tax and surcharge; tax rounded to the nearest ten rupees (s.288B). ' +
    TO_VALIDATE,
};

/** The pack definition (the shape statutory/rule-packs.ts expects of every pack). */
export const INCOME_TAX = {
  code: 'INCOME_TAX',
  title: 'Income tax on salary (Income-tax Act, 2025)',
  validate: validateIncomeTax,
  seed: INCOME_TAX_SEED,
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Arithmetic
// ---------------------------------------------------------------------------------------------------------------

/** Tax by the slabs alone on `income` (scaled). */
function slabTax(p: RegimeParameters, income: bigint): bigint {
  let tax = 0n;
  let floor = 0n;
  for (const s of p.slabs) {
    const top = s.upTo === null ? income : min(income, dec(s.upTo));
    if (top > floor) tax += percentOf(top - floor, s.ratePercent);
    if (s.upTo === null || income <= dec(s.upTo)) break;
    floor = dec(s.upTo);
  }
  return tax;
}

/** Tax after the rebate (and, where the regime has it, the marginal relief just above the rebate threshold). */
function taxAfterRebate(p: RegimeParameters, income: bigint): bigint {
  const tax = slabTax(p, income);
  const threshold = dec(p.rebate.incomeUpTo);
  if (income <= threshold) return tax - min(tax, dec(p.rebate.maxAmount));
  // Marginal relief: the tax never exceeds the income above the threshold.
  return p.rebate.marginalRelief ? min(tax, income - threshold) : tax;
}

const bandRate = (bands: SurchargeBand[], income: bigint) => {
  let rate = '0';
  for (const b of bands) if (income > dec(b.incomeAbove)) rate = b.ratePercent;
  return rate;
};

export interface TaxBreakdown {
  taxableIncome: string;
  slabTax: string;
  rebate: string;
  taxAfterRebate: string;
  surcharge: string;
  marginalReliefOnSurcharge: string;
  cess: string;
  /** The year's tax, rounded as the regime says. */
  total: string;
}

/**
 * The year's tax on `taxableIncome` under one regime: slab tax, less the rebate (or capped by the marginal relief above its threshold),
 * plus the surcharge of the highest band the income is above (capped so that tax and surcharge never exceed the tax and surcharge at that
 * band's threshold by more than the income above it: marginal relief), plus the cess on both, rounded once.
 */
export function incomeTax(params: IncomeTaxParameters, regime: Regime, taxableIncome: string): TaxBreakdown {
  const p = params.regimes[regime];
  const income = max(0n, dec(taxableIncome));
  const slabs = slabTax(p, income);
  const afterRebate = taxAfterRebate(p, income);
  const rate = bandRate(p.surcharge, income);
  let surcharge = percentOf(afterRebate, rate);
  let relief = 0n;
  const band = [...p.surcharge].reverse().find((b) => income > dec(b.incomeAbove));
  if (band) {
    const threshold = dec(band.incomeAbove);
    const atThreshold = taxAfterRebate(p, threshold);
    const ceiling = atThreshold + percentOf(atThreshold, bandRate(p.surcharge, threshold)) + (income - threshold);
    if (afterRebate + surcharge > ceiling) {
      relief = afterRebate + surcharge - ceiling;
      surcharge -= relief;
    }
  }
  const cess = percentOf(afterRebate + surcharge, p.cessPercent);
  const total = roundTo(afterRebate + surcharge + cess, p.rounding === 'NEAREST_TEN' ? '10' : '1');
  return {
    taxableIncome: text(income),
    slabTax: text(slabs),
    rebate: text(slabs - afterRebate),
    taxAfterRebate: text(afterRebate),
    surcharge: text(surcharge),
    marginalReliefOnSurcharge: text(relief),
    cess: text(cess),
    total: text(total),
  };
}

/** The declaration categories that are rent paid for the HRA exemption (not deductions); HRA_METRO is a house in one of the four cities. */
export const HRA_RENT_CATEGORIES: Readonly<Record<string, { metro: boolean }>> = { HRA: { metro: false }, HRA_METRO: { metro: true } };

/**
 * The declaration categories of an earlier employment this year (Form 12B; s.192(2) of the 1961 Act, to be validated against the 2025
 * Act; migration 0239): its salary joins the year's salary and its tax the tax already deducted. Neither is a deduction.
 */
export const PREVIOUS_EMPLOYMENT_CATEGORIES = { salary: 'PREV_EMPLOYER_SALARY', tds: 'PREV_EMPLOYER_TDS' } as const;
/** Categories that are not deductions: rent for the HRA exemption, and an earlier employment. */
export const isNotADeduction = (code: string) => Boolean(HRA_RENT_CATEGORIES[code]) || code === PREVIOUS_EMPLOYMENT_CATEGORIES.salary || code === PREVIOUS_EMPLOYMENT_CATEGORIES.tds;

export interface HraFacts {
  /** The house rent allowance received in the year (heads treated HRA_RULE_2A). */
  hraReceived: string;
  /** Salary for the exemption: Basic and DA (heads treated SALARY_FOR_HRA). */
  salary: string;
  rentPaid: string;
  /** The rented house is in Delhi, Mumbai, Kolkata or Chennai. */
  metro: boolean;
}

/**
 * The HRA exemption of a year (s.10(13A), rule 2A; to be validated against the Income-tax Act, 2025): the least of the allowance
 * received, the rent paid less the regime's share of salary, and the regime's metro or other share of salary; nil without rent or
 * allowance. Null when the regime has no such exemption.
 */
export function hraExemption(p: RegimeParameters, f: HraFacts) {
  const h = p.hraExemption;
  if (!h) return null;
  const received = max(0n, dec(f.hraReceived));
  const salary = max(0n, dec(f.salary));
  const rentLessSalaryShare = max(0n, dec(f.rentPaid) - percentOf(salary, h.rentAboveSalaryPercent));
  const salaryShare = percentOf(salary, f.metro ? h.metroPercent : h.otherPercent);
  const exemption = min(received, min(rentLessSalaryShare, salaryShare));
  return {
    exemption: text(exemption),
    hraReceived: text(received),
    salaryForHra: text(salary),
    rentPaid: text(max(0n, dec(f.rentPaid))),
    metro: f.metro,
    rentLessSalaryShare: text(rentLessSalaryShare),
    salaryShare: text(salaryShare),
  };
}

/** The declaration category of the employer's NPS contribution (s.80CCD(2)), capped by `employerNpsLimitPercent` of salary. */
export const EMPLOYER_NPS_CATEGORY = 'SEC_80CCD_2';

/**
 * The deductions with the employer NPS cap of the regime applied (the lower of the category's own limit and `employerNpsLimitPercent` of
 * the year's salary, Basic and DA), and that cap; the deductions unchanged and a null cap where the regime has none.
 */
export function withEmployerNpsLimit(p: RegimeParameters, deductions: Deduction[], salary: bigint): { deductions: Deduction[]; employerNpsLimit: string | null } {
  if (!p.employerNpsLimitPercent) return { deductions, employerNpsLimit: null };
  const cap = percentOf(max(0n, salary), p.employerNpsLimitPercent);
  return {
    employerNpsLimit: text(cap),
    deductions: deductions.map((d) => (d.categoryCode === EMPLOYER_NPS_CATEGORY ? { ...d, limit: text(d.limit === null ? cap : min(dec(d.limit), cap)) } : d)),
  };
}

export interface Deduction {
  categoryCode: string;
  /** What the employee claims (declared, or accepted on proof). */
  amount: string;
  /** The category's limit in the declaration registry; null when it has none. */
  limit: string | null;
}

/**
 * Taxable income from salary for a year: gross salary less the regime's standard deduction (never below nil) and the deductions the
 * regime allows, each capped at its category limit. The caller passes only the categories of the chosen regime.
 */
export function taxableIncome(params: IncomeTaxParameters, regime: Regime, grossSalary: string, deductions: Deduction[]): { taxable: string; standardDeduction: string; deductionsAllowed: string } {
  const gross = max(0n, dec(grossSalary));
  const standard = min(gross, dec(params.regimes[regime].standardDeduction));
  const allowed = deductions.reduce((sum, d) => sum + max(0n, d.limit === null ? dec(d.amount) : min(dec(d.amount), dec(d.limit))), 0n);
  const taxable = max(0n, gross - standard - allowed);
  return { taxable: text(taxable), standardDeduction: text(standard), deductionsAllowed: text(min(allowed, gross - standard)) };
}

/**
 * This month's TDS: the year's projected tax less the TDS already deducted this year, spread evenly over the months left including this
 * one, rounded half up to the rupee; the last month takes exactly what is left. Never negative: an over-deduction is not refunded
 * through payroll (the employee claims it in the return).
 */
export function monthlyTds(annualTax: string, deductedSoFar: string, monthsLeft: number): string {
  if (!Number.isInteger(monthsLeft) || monthsLeft < 1 || monthsLeft > 12) throw new Error('monthsLeft must be 1 to 12');
  const due = max(0n, dec(annualTax) - dec(deductedSoFar));
  return text(roundTo(monthsLeft === 1 ? due : due / BigInt(monthsLeft), '1'));
}
