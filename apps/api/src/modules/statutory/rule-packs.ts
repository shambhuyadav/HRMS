// Statutory rule pack registry (DF05 "dated, versioned externally supplied rule packs"; F4 "obtained and validated for actual
// jurisdiction/period"; BRD lines 4939, 5120; migration 0235). Decided under owner delegation, 6 Nov 2026 (docs/03 I-88).
//
// A pack is a code (the code a payroll RULE_PACK head names), revisions with an effective date, a currency, its parameters and the
// statute they come from. A revision is DRAFT until one authorised person validates it (recording where the values were obtained and
// how they were validated), then VALIDATED until another activates it; only an ACTIVE revision values anything, and activating a
// revision retires an active one of the same code and start. Values never change in place: a change is a new revision. Every company
// starts with the Payment of Gratuity Act pack as a DRAFT written by the system actor (0235 for existing companies;
// ensureStatutoryPacks for a new one), so nothing statutory is valued until two people have checked it.
//
// To add a pack, add its definition below (parameter validation and, if it ships a seed, the seed); the routes, states and two-person
// rule are shared. I-85 (decided under owner delegation, 6 Nov 2026) adds PF, ESIC and the state professional tax packs (PT_MH and
// PT_KA seeded; any PT_<state> may be written), valued in payroll and settlements by evaluate.ts once ACTIVE. Their parameters have no
// database check (0220 runs before 0235 on a new database), so the evaluator checks them again when it reads them. An ACTIVE revision
// may be retired (retirePack). I-90 adds INCOME_TAX (statutory/income-tax.ts), valued by the TDS head output in payroll. FR-039 adds the
// state labour welfare fund packs (LWF_MH and LWF_KA seeded; any LWF_<state> may be written). 0236 and 0237 check every family's
// parameters in the database as well.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import type { AccessGrant } from '../access/authorize.js';
import { actorOf, advisoryLock, audit, isIsoDate } from '../lifecycle/common.js';
import type { GratuityParameters } from '../lifecycle/settlement-formulas.js';
import { INCOME_TAX } from './income-tax.js';

export interface PackDefinition<P> {
  code: string;
  title: string;
  /** Checks a revision's parameters; returns them normalised or a list of problems. */
  validate(parameters: unknown): { ok: true; parameters: P } | { ok: false; problems: string[] };
  /** The revision every company starts with, as a DRAFT by the system actor (never active). */
  seed?: { effectiveFrom: string; currencyCode: string; parameters: P; statuteReference: string };
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const decimalText = (v: unknown): v is string => typeof v === 'string' && /^\d{1,15}(\.\d{1,4})?$/.test(v);

export const GRATUITY: PackDefinition<GratuityParameters> = {
  code: 'GRATUITY',
  title: 'Gratuity (Payment of Gratuity Act, 1972)',
  validate(raw) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    const keys = ['wageDays', 'wageDivisor', 'minimumServiceYears', 'partYearMonthsOver', 'ceilingAmount', 'exemptSeparationTypes'];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problems: ['parameters must be an object'] };
    for (const k of Object.keys(p)) if (!keys.includes(k)) problems.push(`unknown parameter ${k}`);
    const ranged = (k: string, lo: number, hi: number, integer = false) => {
      const v = p[k];
      if (!isNumber(v) || v < lo || v > hi || (integer && !Number.isInteger(v)) || !/^\d+(\.\d{1,4})?$/.test(String(v))) problems.push(`${k} must be a number from ${lo} to ${hi}`);
    };
    ranged('wageDays', 0.0001, 31);
    ranged('wageDivisor', 1, 31);
    ranged('minimumServiceYears', 0, 50, true);
    ranged('partYearMonthsOver', 0, 11, true);
    if (!decimalText(p.ceilingAmount)) problems.push('ceilingAmount must be a decimal amount in text, at most four decimals');
    if (!Array.isArray(p.exemptSeparationTypes) || p.exemptSeparationTypes.some((s) => typeof s !== 'string' || !/^[A-Z][A-Z0-9_]{0,39}$/.test(s))) {
      problems.push('exemptSeparationTypes must be a list of separation type codes');
    }
    if (problems.length > 0) return { ok: false, problems };
    return { ok: true, parameters: p as unknown as GratuityParameters };
  },
  seed: {
    effectiveFrom: '2018-03-29',
    currencyCode: 'INR',
    parameters: { wageDays: 15, wageDivisor: 26, minimumServiceYears: 5, partYearMonthsOver: 6, ceilingAmount: '2000000.00', exemptSeparationTypes: ['DEATH', 'DISABLEMENT'] },
    statuteReference:
      'Payment of Gratuity Act, 1972, s.4(1) to (3); ceiling under s.4(3) notified by S.O. 1420(E) of 29 March 2018. Validate against the law in force for the period (including the Code on Social Security, 2020) before activation.',
  },
};

// ---------------------------------------------------------------------------------------------------------------
// PF, ESIC and professional tax (I-85, decided under owner delegation, 6 Nov 2026). Every rate, ceiling and slab is a parameter of a
// revision; modules/statutory/evaluate.ts holds only the formulas. Amounts and ceilings are decimal text in the pack currency, rates are
// percentages as decimal text ("8.33"), and rounding is to a whole unit of the currency: half up (EPFO) or up to the next unit (ESIC).
// ---------------------------------------------------------------------------------------------------------------
export type StatutoryRounding = 'HALF_UP_WHOLE' | 'UP_WHOLE';
const ROUNDINGS: readonly StatutoryRounding[] = ['HALF_UP_WHOLE', 'UP_WHOLE'];

export interface PfParameters {
  /** PF wages above this are not contributed on, unless the employee has opted to contribute on higher wages (para 26(6)). */
  wageCeiling: string;
  employeeRatePercent: string;
  /** The employer's whole contribution; the pension share is part of it, the EPF share the rest. */
  employerRatePercent: string;
  pensionRatePercent: string;
  /** The pension share is on wages up to this, whatever the option. */
  pensionWageCeiling: string;
  edliRatePercent: string;
  edliWageCeiling: string;
  /** EPF administrative charges, an employer cost, on the wages contributed on. */
  adminChargesRatePercent: string;
  rounding: StatutoryRounding;
}

export interface EsicParameters {
  /** An employee is covered while the monthly rate of ESIC wages is at or below this (or was at the start of the contribution period). */
  wageCeiling: string;
  employeeRatePercent: string;
  employerRatePercent: string;
  /** The months contribution periods start in (April and October): coverage at a period's start lasts the whole period. */
  contributionPeriodStartMonths: number[];
  rounding: StatutoryRounding;
}

export interface PtSlab {
  /** The slab holds monthly gross up to and including this; null for the last slab (no upper limit). */
  upTo: string | null;
  amount: string;
  /** A different amount in a given month ("2" for February), as Maharashtra's 300 in February. */
  monthAmounts?: Record<string, string>;
}
export interface PtParameters {
  stateCode: string;
  slabs: PtSlab[];
}

const PERCENT = /^\d{1,3}(\.\d{1,4})?$/;
const isObject = (raw: unknown): raw is Record<string, unknown> => typeof raw === 'object' && raw !== null && !Array.isArray(raw);
const units = (text: string) => {
  const [whole, fraction = ''] = text.split('.');
  return BigInt(whole!) * 10_000n + BigInt(fraction.padEnd(4, '0'));
};

function checker(raw: unknown, keys: readonly string[]) {
  const problems: string[] = [];
  const p = isObject(raw) ? raw : {};
  if (!isObject(raw)) problems.push('parameters must be an object');
  for (const k of Object.keys(p)) if (!keys.includes(k)) problems.push(`unknown parameter ${k}`);
  return {
    p,
    problems,
    amount(k: string) {
      if (!decimalText(p[k])) problems.push(`${k} must be a decimal amount in text, at most four decimals`);
    },
    percent(k: string) {
      const v = p[k];
      if (typeof v !== 'string' || !PERCENT.test(v) || units(v) > 100n * 10_000n) problems.push(`${k} must be a percentage from 0 to 100 in text, at most four decimals`);
    },
    rounding(k: string) {
      if (!ROUNDINGS.includes(p[k] as StatutoryRounding)) problems.push(`${k} must be one of ${ROUNDINGS.join(', ')}`);
    },
  };
}

const VALIDATE_NOTE = 'Validate against the law in force for the period, including the Code on Social Security, 2020, before activation.';

export const PF: PackDefinition<PfParameters> = {
  code: 'PF',
  title: "Provident fund (Employees' Provident Funds and Miscellaneous Provisions Act, 1952)",
  validate(raw) {
    const c = checker(raw, ['wageCeiling', 'employeeRatePercent', 'employerRatePercent', 'pensionRatePercent', 'pensionWageCeiling', 'edliRatePercent', 'edliWageCeiling', 'adminChargesRatePercent', 'rounding']);
    for (const k of ['wageCeiling', 'pensionWageCeiling', 'edliWageCeiling']) c.amount(k);
    for (const k of ['employeeRatePercent', 'employerRatePercent', 'pensionRatePercent', 'edliRatePercent', 'adminChargesRatePercent']) c.percent(k);
    c.rounding('rounding');
    if (c.problems.length === 0 && units(c.p.pensionRatePercent as string) > units(c.p.employerRatePercent as string)) {
      c.problems.push('pensionRatePercent is part of employerRatePercent, so it cannot be larger');
    }
    return c.problems.length > 0 ? { ok: false, problems: c.problems } : { ok: true, parameters: c.p as unknown as PfParameters };
  },
  seed: {
    effectiveFrom: '2018-06-01',
    currencyCode: 'INR',
    parameters: {
      wageCeiling: '15000.00',
      employeeRatePercent: '12',
      employerRatePercent: '12',
      pensionRatePercent: '8.33',
      pensionWageCeiling: '15000.00',
      edliRatePercent: '0.5',
      edliWageCeiling: '15000.00',
      adminChargesRatePercent: '0.5',
      rounding: 'HALF_UP_WHOLE',
    },
    statuteReference:
      "Employees' Provident Funds and Miscellaneous Provisions Act, 1952, s.6 (employee and employer 12% of basic wages and dearness allowance) and s.6C (EDLI 0.5%); Employees' Pension Scheme, 1995, para 3 (8.33% of pay up to the wage ceiling); wage ceiling Rs 15,000 from 1 September 2014; EPF Scheme, 1952, para 26(6) (contribution on higher wages by joint option); administrative charges 0.5% from 1 June 2018; each figure rounded to the nearest rupee, half up, as EPFO computes. " +
      VALIDATE_NOTE,
  },
};

export const ESIC: PackDefinition<EsicParameters> = {
  code: 'ESIC',
  title: "Employees' state insurance (Employees' State Insurance Act, 1948)",
  validate(raw) {
    const c = checker(raw, ['wageCeiling', 'employeeRatePercent', 'employerRatePercent', 'contributionPeriodStartMonths', 'rounding']);
    c.amount('wageCeiling');
    c.percent('employeeRatePercent');
    c.percent('employerRatePercent');
    c.rounding('rounding');
    const m = c.p.contributionPeriodStartMonths;
    if (!Array.isArray(m) || m.length === 0 || m.some((x, i) => !Number.isInteger(x) || x < 1 || x > 12 || (i > 0 && x <= (m[i - 1] as number)))) {
      c.problems.push('contributionPeriodStartMonths must be a list of months (1 to 12) in ascending order');
    }
    return c.problems.length > 0 ? { ok: false, problems: c.problems } : { ok: true, parameters: c.p as unknown as EsicParameters };
  },
  seed: {
    effectiveFrom: '2019-07-01',
    currencyCode: 'INR',
    parameters: { wageCeiling: '21000.00', employeeRatePercent: '0.75', employerRatePercent: '3.25', contributionPeriodStartMonths: [4, 10], rounding: 'UP_WHOLE' },
    statuteReference:
      "Employees' State Insurance Act, 1948, s.2(9) and s.39; ESI (Central) Rules, 1950: employee 0.75% and employer 3.25% of wages from 1 July 2019, coverage up to wages of Rs 21,000 a month from 1 January 2017, contribution periods 1 April to 30 September and 1 October to 31 March (an employee covered at the start of a period stays covered to its end), contributions rounded up to the next higher rupee. " +
      VALIDATE_NOTE,
  },
};

/** The professional tax pack of one state: code PT_<state>, e.g. PT_MH. */
export function ptDefinition(code: string, title = `Professional tax (${code.slice(3)})`, seed?: PackDefinition<PtParameters>['seed']): PackDefinition<PtParameters> {
  const state = code.slice(3);
  return {
    code,
    title,
    validate(raw) {
      const c = checker(raw, ['stateCode', 'slabs']);
      if (c.p.stateCode !== state) c.problems.push(`stateCode must be ${state}, the state of pack ${code}`);
      const slabs = c.p.slabs;
      if (!Array.isArray(slabs) || slabs.length === 0 || slabs.length > 50) {
        c.problems.push('slabs must be a list of 1 to 50 slabs');
      } else {
        slabs.forEach((s: unknown, i) => {
          const where = `slab ${i + 1}`;
          if (!isObject(s)) return c.problems.push(`${where} must be an object`);
          for (const k of Object.keys(s)) if (!['upTo', 'amount', 'monthAmounts'].includes(k)) c.problems.push(`${where}: unknown field ${k}`);
          const last = i === slabs.length - 1;
          if (last ? s.upTo !== null : !decimalText(s.upTo)) c.problems.push(last ? `${where}: the last slab has no upper limit (upTo null)` : `${where}: upTo must be a decimal amount in text`);
          else if (!last && i > 0 && decimalText(slabs[i - 1]?.upTo) && units(s.upTo as string) <= units(slabs[i - 1].upTo as string)) c.problems.push(`${where}: upTo must be above the slab before`);
          if (!decimalText(s.amount)) c.problems.push(`${where}: amount must be a decimal amount in text`);
          if (s.monthAmounts !== undefined) {
            if (!isObject(s.monthAmounts) || Object.entries(s.monthAmounts).some(([month, v]) => !/^(?:[1-9]|1[0-2])$/.test(month) || !decimalText(v))) {
              c.problems.push(`${where}: monthAmounts maps months "1" to "12" to decimal amounts in text`);
            }
          }
        });
      }
      return c.problems.length > 0 ? { ok: false, problems: c.problems } : { ok: true, parameters: c.p as unknown as PtParameters };
    },
    ...(seed ? { seed } : {}),
  };
}

const PT_NOTE =
  'Professional tax is a state levy, an outside input (docs/10 D3): the slabs, any month-specific amount and the effective date are seeded for validation, not as advice. ' + VALIDATE_NOTE;

export const PT_MH = ptDefinition('PT_MH', 'Professional tax, Maharashtra', {
  effectiveFrom: '2023-04-01',
  currencyCode: 'INR',
  parameters: {
    stateCode: 'MH',
    slabs: [
      { upTo: '7500.00', amount: '0.00' },
      { upTo: '10000.00', amount: '175.00' },
      { upTo: null, amount: '200.00', monthAmounts: { '2': '300.00' } },
    ],
  },
  statuteReference:
    'Maharashtra State Tax on Professions, Trades, Callings and Employments Act, 1975, Schedule I entry 1 (salary and wage earners): up to Rs 7,500 a month nil, Rs 7,501 to 10,000 Rs 175, above Rs 10,000 Rs 200 (Rs 300 in February). The separate threshold for women (nil up to Rs 25,000) cannot be expressed by this pack: the HRMS holds no gender, so check whether that makes the pack unusable for the company. ' +
    PT_NOTE,
});

export const PT_KA = ptDefinition('PT_KA', 'Professional tax, Karnataka', {
  effectiveFrom: '2023-04-01',
  currencyCode: 'INR',
  parameters: { stateCode: 'KA', slabs: [{ upTo: '24999.99', amount: '0.00' }, { upTo: null, amount: '200.00' }] },
  statuteReference:
    'Karnataka Tax on Professions, Trades, Callings and Employments Act, 1976, Schedule entry 1 (salary and wage earners): below Rs 25,000 a month nil, Rs 25,000 and above Rs 200. Check whether a later amendment sets a different February amount (an annual Rs 2,500) for the period. ' +
    PT_NOTE,
});

// ---------------------------------------------------------------------------------------------------------------
// Labour welfare fund (FR-039 "LWF registers"; decided under owner delegation, 6 Nov 2026). A state levy like professional tax: the pack
// of a state, LWF_<state>, names the months its contributions fall due in (a half-yearly fund in June and December, an annual one in
// December) and slabs of the month's wages, each with the employee's and the employer's amount. The state is that of the work location
// (location_pt_state, as for professional tax). A state without a fund, where the company has staff, is a revision with nil amounts.
// ---------------------------------------------------------------------------------------------------------------
export interface LwfSlab {
  /** The slab holds monthly wages up to and including this; null for the last slab (no upper limit). */
  upTo: string | null;
  employee: string;
  employer: string;
}
export interface LwfParameters {
  stateCode: string;
  /** The months whose payroll deducts the contribution (1 to 12, ascending). */
  contributionMonths: number[];
  slabs: LwfSlab[];
}

/** The labour welfare fund pack of one state: code LWF_<state>, e.g. LWF_MH. */
export function lwfDefinition(code: string, title = `Labour welfare fund (${code.slice(4)})`, seed?: PackDefinition<LwfParameters>['seed']): PackDefinition<LwfParameters> {
  const state = code.slice(4);
  return {
    code,
    title,
    validate(raw) {
      const c = checker(raw, ['stateCode', 'contributionMonths', 'slabs']);
      if (c.p.stateCode !== state) c.problems.push(`stateCode must be ${state}, the state of pack ${code}`);
      const m = c.p.contributionMonths;
      if (!Array.isArray(m) || m.length === 0 || m.some((x, i) => !Number.isInteger(x) || x < 1 || x > 12 || (i > 0 && x <= (m[i - 1] as number)))) {
        c.problems.push('contributionMonths must be a list of months (1 to 12) in ascending order');
      }
      const slabs = c.p.slabs;
      if (!Array.isArray(slabs) || slabs.length === 0 || slabs.length > 50) {
        c.problems.push('slabs must be a list of 1 to 50 slabs');
      } else {
        slabs.forEach((s: unknown, i) => {
          const where = `slab ${i + 1}`;
          if (!isObject(s)) return c.problems.push(`${where} must be an object`);
          for (const k of Object.keys(s)) if (!['upTo', 'employee', 'employer'].includes(k)) c.problems.push(`${where}: unknown field ${k}`);
          const last = i === slabs.length - 1;
          if (last ? s.upTo !== null : !decimalText(s.upTo)) c.problems.push(last ? `${where}: the last slab has no upper limit (upTo null)` : `${where}: upTo must be a decimal amount in text`);
          else if (!last && i > 0 && decimalText(slabs[i - 1]?.upTo) && units(s.upTo as string) <= units(slabs[i - 1].upTo as string)) c.problems.push(`${where}: upTo must be above the slab before`);
          for (const k of ['employee', 'employer']) if (!decimalText(s[k])) c.problems.push(`${where}: ${k} must be a decimal amount in text`);
        });
      }
      return c.problems.length > 0 ? { ok: false, problems: c.problems } : { ok: true, parameters: c.p as unknown as LwfParameters };
    },
    ...(seed ? { seed } : {}),
  };
}

const LWF_NOTE =
  'Labour welfare fund is a state levy, an outside input (docs/10 D3): the months, slabs, amounts and effective date are seeded for validation, not as advice. Validate against the law in force for the period before activation.';

export const LWF_MH = lwfDefinition('LWF_MH', 'Labour welfare fund, Maharashtra', {
  effectiveFrom: '2023-04-01',
  currencyCode: 'INR',
  parameters: {
    stateCode: 'MH',
    contributionMonths: [6, 12],
    slabs: [
      { upTo: '3000.00', employee: '6.00', employer: '18.00' },
      { upTo: null, employee: '12.00', employer: '36.00' },
    ],
  },
  statuteReference:
    'Maharashtra Labour Welfare Fund Act, 1953, s.6BB: half-yearly contributions with the June and December wages; Rs 6 by the employee and Rs 18 by the employer where monthly wages are up to Rs 3,000, Rs 12 and Rs 36 above. Employees in a managerial or supervisory capacity above the Act’s wage limit are outside it, which this pack cannot express: check whether the company’s employees are within the Act. ' +
    LWF_NOTE,
});

export const LWF_KA = lwfDefinition('LWF_KA', 'Labour welfare fund, Karnataka', {
  effectiveFrom: '2024-01-01',
  currencyCode: 'INR',
  parameters: { stateCode: 'KA', contributionMonths: [12], slabs: [{ upTo: null, employee: '50.00', employer: '100.00' }] },
  statuteReference:
    'Karnataka Labour Welfare Fund Act, 1965, s.7A: an annual contribution with the December wages, paid by 15 January; Rs 50 by the employee and Rs 100 by the employer as amended (Rs 20 and Rs 40 before the amendment): check which amounts and which effective date apply to the period. ' +
    LWF_NOTE,
});

/**
 * Every pack this build knows and seeds. A professional tax or labour welfare fund pack of another state (PT_<state>, LWF_<state>) is
 * written as a new revision. INCOME_TAX (I-90, statutory/income-tax.ts) is valued by the TDS head output of evaluate.ts.
 */
export const STATUTORY_PACKS: readonly PackDefinition<unknown>[] = [GRATUITY, PF, ESIC, PT_MH, PT_KA, LWF_MH, LWF_KA, INCOME_TAX] as PackDefinition<unknown>[];
/** The definition of a pack code: a listed pack, or the professional tax or labour welfare fund pack of any state. */
export const definitionOf = (code: string): PackDefinition<unknown> | undefined =>
  STATUTORY_PACKS.find((d) => d.code === code) ??
  (/^PT_[A-Z]{2}$/.test(code) ? (ptDefinition(code) as PackDefinition<unknown>) : /^LWF_[A-Z]{2}$/.test(code) ? (lwfDefinition(code) as PackDefinition<unknown>) : undefined);

/**
 * Provisioning: the seeded revision of every known pack, as a DRAFT by the system actor, for a company that has none of that code (0235
 * gives existing companies the same). Re-running changes nothing. Also called before a pack is read or used, so a company provisioned
 * before this call was wired into provisioning still starts from the seed.
 */
export async function ensureStatutoryPacks(db: Queryable, companyId: string): Promise<void> {
  for (const d of STATUTORY_PACKS) {
    if (!d.seed) continue;
    await db.query(
      `insert into statutory_rule_pack (company_id, code, revision, effective_from, currency_code, parameters, statute_reference, state, created_by, updated_by)
       select $1, $2, 1, $3::date, $4, $5::jsonb, $6, 'DRAFT', $7, $7
        where not exists (select 1 from statutory_rule_pack where company_id = $1 and code = $2)`,
      [companyId, d.code, d.seed.effectiveFrom, d.seed.currencyCode, JSON.stringify(d.seed.parameters), d.seed.statuteReference, SYSTEM_ACTOR_ID],
    );
  }
}

export interface PackRevision {
  id: string;
  code: string;
  revision: number;
  effectiveFrom: string;
  currencyCode: string;
  parameters: Record<string, unknown>;
  statuteReference: string;
  sourceReference: string | null;
  validationReference: string | null;
  state: 'DRAFT' | 'VALIDATED' | 'ACTIVE' | 'RETIRED';
  createdBy: string;
  validatedBy: string | null;
  validatedAt: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
  version: number;
}

const VIEW = `select p.id, p.code, p.revision, to_char(p.effective_from, 'YYYY-MM-DD') as "effectiveFrom", p.currency_code as "currencyCode", p.parameters,
    p.statute_reference as "statuteReference", p.source_reference as "sourceReference", p.validation_reference as "validationReference", p.state,
    p.created_by as "createdBy", p.validated_by as "validatedBy", p.validated_at as "validatedAt", p.activated_by as "activatedBy", p.activated_at as "activatedAt", p.version
  from statutory_rule_pack p`;

/**
 * The revision of `code` in effect on `day`: the ACTIVE revision with the latest start on or before it (`active: true`); without one,
 * the latest revision not retired that starts on or before it, which is inactive (`active: false`) and is read only to tell whether the
 * pack applies (eligibility), never to value anything; null when there is no revision at all.
 */
export async function packInEffect(db: Queryable, companyId: string, code: string, day: string): Promise<{ pack: PackRevision; active: boolean } | null> {
  const active = (await db.query<PackRevision>(`${VIEW} where p.company_id = $1 and p.code = $2 and p.state = 'ACTIVE' and p.effective_from <= $3::date order by p.effective_from desc limit 1`, [companyId, code, day])).rows[0];
  if (active) return { pack: active, active: true };
  const inactive = (
    await db.query<PackRevision>(`${VIEW} where p.company_id = $1 and p.code = $2 and p.state in ('DRAFT', 'VALIDATED') and p.effective_from <= $3::date order by p.revision desc limit 1`, [
      companyId,
      code,
      day,
    ])
  ).rows[0];
  return inactive ? { pack: inactive, active: false } : null;
}

export async function listPacks(db: Queryable, grant: AccessGrant) {
  const items = (await db.query<PackRevision>(`${VIEW} where p.company_id = $1 order by p.code, p.revision`, [grant.companyId])).rows;
  return {
    definitions: STATUTORY_PACKS.map((d) => ({ code: d.code, title: d.title })),
    items,
  };
}

const stale = (): never => {
  throw new HttpError(409, 'STALE_VERSION', 'The pack changed; reload and retry');
};

async function lockedPack(tx: Queryable, grant: AccessGrant, id: string) {
  const p = (await tx.query<PackRevision>(`${VIEW} where p.company_id = $1 and p.id = $2 for update of p`, [grant.companyId, id])).rows[0];
  if (!p) throw notFound();
  return p;
}

export interface NewPackRevision {
  code: string;
  effectiveFrom: string;
  currencyCode: string;
  parameters: unknown;
  statuteReference: string;
}

/** A new DRAFT revision of a known pack (a change of a statutory value is a new revision, never an edit). */
export async function createPackRevision(tx: Queryable, grant: AccessGrant, input: NewPackRevision) {
  const code = input.code.trim().toUpperCase();
  const d = definitionOf(code);
  if (!d) throw new HttpError(422, 'UNKNOWN_RULE_PACK', 'This build knows no statutory rule pack of that code', { code, known: STATUTORY_PACKS.map((x) => x.code) });
  if (!isIsoDate(input.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'The effective date is not a valid date', { field: 'effectiveFrom' });
  if (!/^[A-Z]{3}$/.test(input.currencyCode)) throw new HttpError(422, 'CURRENCY_REQUIRED', 'Give the pack currency (ISO 4217 code)', { field: 'currencyCode' });
  const statute = input.statuteReference.trim();
  if (statute === '' || statute.length > 1000) throw new HttpError(422, 'STATUTE_REQUIRED', 'Name the statute and notification the values come from (at most 1,000 characters)');
  const checked = d.validate(input.parameters);
  if (!checked.ok) throw new HttpError(422, 'INVALID_PARAMETERS', 'The pack parameters are not valid', { problems: checked.problems });
  await advisoryLock(tx, `statutory_rule_pack:${grant.companyId}:${code}`);
  await reassertAccess(tx, grant, 'statutory_pack', 'validate', ['operational']);
  await ensureStatutoryPacks(tx, grant.companyId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into statutory_rule_pack (company_id, code, revision, effective_from, currency_code, parameters, statute_reference, state, created_by, updated_by)
       select $1, $2, coalesce(max(revision), 0) + 1, $3::date, $4, $5::jsonb, $6, 'DRAFT', $7, $7 from statutory_rule_pack where company_id = $1 and code = $2
       returning id`,
      [grant.companyId, code, input.effectiveFrom, input.currencyCode, JSON.stringify(checked.parameters), statute, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'statutory_rule_pack', id, 'CREATE', null, { operational: { code, effectiveFrom: input.effectiveFrom, currencyCode: input.currencyCode, parameters: checked.parameters, state: 'DRAFT' } });
  return (await tx.query<PackRevision>(`${VIEW} where p.company_id = $1 and p.id = $2`, [grant.companyId, id])).rows[0]!;
}

/**
 * F4: the first person checks the values against the law for the period and records where they were obtained and how they were
 * validated. The revision stays inactive.
 */
export async function validatePack(tx: Queryable, grant: AccessGrant, id: string, input: { sourceReference: string; validationReference: string; expectedVersion: number }) {
  const p = await lockedPack(tx, grant, id);
  await reassertAccess(tx, grant, 'statutory_pack', 'validate', ['operational']);
  if (p.version !== input.expectedVersion) stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision is validated');
  const source = input.sourceReference.trim();
  const validation = input.validationReference.trim();
  if (source === '' || source.length > 500) throw new HttpError(422, 'SOURCE_REQUIRED', 'Record where the values were obtained (at most 500 characters)', { field: 'sourceReference' });
  if (validation === '' || validation.length > 500) throw new HttpError(422, 'VALIDATION_REQUIRED', 'Record how the values were validated for the jurisdiction and period (at most 500 characters)', { field: 'validationReference' });
  await tx.query(
    `update statutory_rule_pack set state = 'VALIDATED', validated_by = $3, validated_at = now(), source_reference = $4, validation_reference = $5, updated_by = $3
      where company_id = $1 and id = $2`,
    [grant.companyId, id, grant.userId, source, validation],
  );
  await audit(tx, actorOf(grant), 'statutory_rule_pack', id, 'VALIDATE', { operational: { state: 'DRAFT' } }, { operational: { state: 'VALIDATED', code: p.code, revision: p.revision } });
  return (await tx.query<PackRevision>(`${VIEW} where p.company_id = $1 and p.id = $2`, [grant.companyId, id])).rows[0]!;
}

/** The second person activates a validated revision: never its validator or author. An active revision of the same code and start retires. */
export async function activatePack(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  const p = await lockedPack(tx, grant, id);
  await advisoryLock(tx, `statutory_rule_pack:${grant.companyId}:${p.code}`);
  await reassertAccess(tx, grant, 'statutory_pack', 'activate', ['operational']);
  if (p.version !== input.expectedVersion) stale();
  if (p.state !== 'VALIDATED') throw new HttpError(409, 'INVALID_STATE', 'Only a validated revision is activated', { state: p.state });
  if (p.validatedBy === grant.userId || p.createdBy === grant.userId) {
    throw new HttpError(403, 'SELF_APPROVAL', 'A statutory rule pack is activated by someone other than the person who wrote or validated it');
  }
  await tx.query(`update statutory_rule_pack set state = 'RETIRED', updated_by = $4 where company_id = $1 and code = $2 and effective_from = $3::date and state = 'ACTIVE'`, [
    grant.companyId,
    p.code,
    p.effectiveFrom,
    grant.userId,
  ]);
  await tx.query(`update statutory_rule_pack set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await audit(tx, actorOf(grant), 'statutory_rule_pack', id, 'ACTIVATE', { operational: { state: 'VALIDATED' } }, { operational: { state: 'ACTIVE', code: p.code, revision: p.revision } });
  return (await tx.query<PackRevision>(`${VIEW} where p.company_id = $1 and p.id = $2`, [grant.companyId, id])).rows[0]!;
}

/**
 * I-85: an ACTIVE revision is retired by someone holding the activation right, with a reason. From then on nothing is valued under it:
 * the revision of the same code in effect before it (if active) applies again, and without one an employee the pack applies to is
 * blocked with RULE_PACK_NOT_CONFIGURED. A payroll run revision whose calculation already fixed it keeps it (payroll_run_rule_pack).
 */
export async function retirePack(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number; reason: string }) {
  const p = await lockedPack(tx, grant, id);
  await advisoryLock(tx, `statutory_rule_pack:${grant.companyId}:${p.code}`);
  await reassertAccess(tx, grant, 'statutory_pack', 'activate', ['operational']);
  if (p.version !== input.expectedVersion) stale();
  if (p.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'Only an active revision is retired', { state: p.state });
  const reason = input.reason.trim();
  if (reason === '' || reason.length > 500) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the revision is retired (at most 500 characters)', { field: 'reason' });
  await tx.query(`update statutory_rule_pack set state = 'RETIRED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await audit(tx, actorOf(grant), 'statutory_rule_pack', id, 'RETIRE', { operational: { state: 'ACTIVE' } }, { operational: { state: 'RETIRED', code: p.code, revision: p.revision } }, reason);
  return (await tx.query<PackRevision>(`${VIEW} where p.company_id = $1 and p.id = $2`, [grant.companyId, id])).rows[0]!;
}

/** A revision's parameters checked again by its definition when read (no database check covers PF, ESIC or PT; see 0220). */
export function packParameters<P>(code: string, parameters: unknown): { ok: true; parameters: P } | { ok: false; problems: string[] } {
  const d = definitionOf(code);
  if (!d) return { ok: false, problems: [`no definition of pack ${code}`] };
  return d.validate(parameters) as { ok: true; parameters: P } | { ok: false; problems: string[] };
}

/** The parameters of a GRATUITY revision, checked again when read (the database checks their shape). */
export function gratuityParameters(pack: PackRevision): GratuityParameters {
  const checked = GRATUITY.validate(pack.parameters);
  if (!checked.ok) throw new Error(`gratuity pack ${pack.id} has invalid parameters: ${checked.problems.join('; ')}`);
  return checked.parameters;
}
