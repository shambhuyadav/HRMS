// I-85 statutory formulas (decided under owner delegation, 6 Nov 2026), as pure functions with hand-worked vectors on the seeded DRAFT
// parameters (rule-packs.ts): the formulas hold no rate, ceiling or slab, so every value below comes from the pack passed in. Synthetic
// wages only. The same examples run through payroll and settlement in statutory-packs.api.test.ts.
import { describe, expect, it } from 'vitest';
import { contributionPeriodStart, percentOf, valueEsic, valueLwf, valuePf, valuePt } from './evaluate.js';
import { ESIC, type EsicParameters, LWF_KA, LWF_MH, type LwfParameters, lwfDefinition, PF, type PfParameters, PT_KA, PT_MH, type PtParameters, ptDefinition } from './rule-packs.js';

const pf = PF.seed!.parameters as PfParameters;
const esic = ESIC.seed!.parameters as EsicParameters;
const mh = PT_MH.seed!.parameters as PtParameters;
const ka = PT_KA.seed!.parameters as PtParameters;
const lwfMh = LWF_MH.seed!.parameters as LwfParameters;
const lwfKa = LWF_KA.seed!.parameters as LwfParameters;
const amount = (v: ReturnType<typeof valuePf>) => (v.status === 'VALUED' ? v.amount : v.reason);
const pfAll = (wages: string, option: 'STATUTORY_CEILING' | 'HIGHER_WAGES' = 'STATUTORY_CEILING') =>
  (['EMPLOYEE', 'EPS', 'EPF', 'EDLI', 'ADMIN'] as const).map((o) => amount(valuePf(o, pf, { wages, option })));

describe('rounding to a whole unit, exactly', () => {
  it('half up (EPFO) and up to the next unit (ESIC), never through floating point', () => {
    expect(percentOf('4537.50', '12', 'HALF_UP_WHOLE')).toBe('545.0000'); // 544.50 -> 545
    expect(percentOf('4537.49', '12', 'HALF_UP_WHOLE')).toBe('544.0000'); // 544.4988 -> 544
    expect(percentOf('15000.00', '8.33', 'HALF_UP_WHOLE')).toBe('1250.0000'); // 1,249.50 -> 1,250
    expect(percentOf('20000.00', '0.75', 'UP_WHOLE')).toBe('150.0000'); // exactly 150: not raised
    expect(percentOf('20000.01', '0.75', 'UP_WHOLE')).toBe('151.0000'); // 150.000075 -> 151
  });
});

describe('PF (seeded: 12% / 12% with 8.33% EPS on 15,000; EDLI 0.5% on 15,000; administration 0.5%)', () => {
  it('below the wage ceiling: Basic 8,000 + DA 2,000', () => {
    // employee, EPS, employer EPF (12% - EPS), EDLI, administration charges
    expect(pfAll('10000.00')).toEqual(['1200.0000', '833.0000', '367.0000', '50.0000', '50.0000']);
  });

  it('above the wage ceiling: Basic 20,000 + DA 5,000 contributes on 15,000', () => {
    expect(pfAll('25000.00')).toEqual(['1800.0000', '1250.0000', '550.0000', '75.0000', '75.0000']);
  });

  it('at the ceiling and one rupee either side', () => {
    expect(pfAll('14999.00')[0]).toBe('1800.0000'); // 1,799.88 -> 1,800
    expect(pfAll('15000.00')[0]).toBe('1800.0000');
    expect(pfAll('15001.00')[0]).toBe('1800.0000'); // capped
  });

  it('with the higher-wage option: 12% of 25,000 each side, EPS still on 15,000, EDLI on 15,000, administration on 25,000', () => {
    expect(pfAll('25000.00', 'HIGHER_WAGES')).toEqual(['3000.0000', '1250.0000', '1750.0000', '75.0000', '125.0000']);
  });

  it('rounds each figure once: wages 12,345.67', () => {
    // 1,481.4804 -> 1,481; EPS 1,028.3943 -> 1,028; EPF 1,481 - 1,028 = 453; EDLI and administration 61.7284 -> 62
    expect(pfAll('12345.67')).toEqual(['1481.0000', '1028.0000', '453.0000', '62.0000', '62.0000']);
  });

  it('nothing on no wages', () => {
    expect(pfAll('0.0000')).toEqual(['NIL_AMOUNT', 'NIL_AMOUNT', 'NIL_AMOUNT', 'NIL_AMOUNT', 'NIL_AMOUNT']);
  });
});

describe('ESIC (seeded: 0.75% / 3.25% up to 21,000; periods from April and October; rounded up)', () => {
  const facts = (wages: string, rateAtCoverage: string | null, rateNow: string | null) => ({ wages, periodStart: '2026-10-01', coverageDate: '2026-10-01', rateAtCoverage, rateNow });

  it('contribution periods: April to September and October to March', () => {
    expect(contributionPeriodStart(esic, '2026-04-30')).toBe('2026-04-01');
    expect(contributionPeriodStart(esic, '2026-09-30')).toBe('2026-04-01');
    expect(contributionPeriodStart(esic, '2026-10-31')).toBe('2026-10-01');
    expect(contributionPeriodStart(esic, '2027-02-28')).toBe('2026-10-01');
    expect(contributionPeriodStart(esic, '2027-03-31')).toBe('2026-10-01');
  });

  it('just under 21,000: 20,999 gives 157.4925 -> 158 and 682.4675 -> 683', () => {
    expect(amount(valueEsic('EMPLOYEE', esic, facts('20999.00', '20999.00', '20999.00')))).toBe('158.0000');
    expect(amount(valueEsic('EMPLOYER', esic, facts('20999.00', '20999.00', '20999.00')))).toBe('683.0000');
  });

  it('at 21,000 covered; just over, 21,001 throughout, not covered', () => {
    expect(amount(valueEsic('EMPLOYEE', esic, facts('21000.00', '21000.00', '21000.00')))).toBe('158.0000'); // 157.50 -> 158
    const over = valueEsic('EMPLOYEE', esic, facts('21001.00', '21001.00', '21001.00'));
    expect(over).toMatchObject({ status: 'NOT_APPLICABLE', reason: 'NOT_COVERED' });
  });

  it('covered at the start of the period stays covered after a raise to 22,000; the next period starts uncovered', () => {
    const raised = valueEsic('EMPLOYEE', esic, facts('22000.00', '20000.00', '22000.00'));
    expect(raised).toMatchObject({ status: 'VALUED', amount: '165.0000', workings: { covered: 'COVERED_FOR_THE_CONTRIBUTION_PERIOD' } });
    expect(amount(valueEsic('EMPLOYER', esic, facts('22000.00', '20000.00', '22000.00')))).toBe('715.0000');
    expect(valueEsic('EMPLOYEE', esic, { ...facts('22000.00', '22000.00', '22000.00'), periodStart: '2027-04-01', coverageDate: '2027-04-01' }).status).toBe('NOT_APPLICABLE');
  });

  it('a cut to the ceiling covers from that month; prorated wages under the ceiling do not cover a rate above it', () => {
    expect(valueEsic('EMPLOYEE', esic, facts('20000.00', '25000.00', '20000.00'))).toMatchObject({ status: 'VALUED', amount: '150.0000', workings: { covered: 'RATE_AT_OR_BELOW_CEILING' } });
    expect(valueEsic('EMPLOYEE', esic, facts('12500.00', '25000.00', '25000.00')).status).toBe('NOT_APPLICABLE');
  });
});

describe('professional tax (seeded drafts: Maharashtra and Karnataka)', () => {
  const pt = (p: PtParameters, gross: string, month: number) => amount(valuePt(p, { gross, month }));

  it('Maharashtra: nil up to 7,500, 175 to 10,000, 200 above, 300 in February', () => {
    expect(pt(mh, '7500.00', 10)).toBe('NIL_AMOUNT');
    expect(pt(mh, '7500.01', 10)).toBe('175.0000');
    expect(pt(mh, '10000.00', 10)).toBe('175.0000');
    expect(pt(mh, '10000.01', 10)).toBe('200.0000');
    expect(pt(mh, '14000.00', 10)).toBe('200.0000');
    expect(pt(mh, '14000.00', 2)).toBe('300.0000');
    expect(pt(mh, '9000.00', 2)).toBe('175.0000'); // the February amount belongs to the top slab only
  });

  it('Karnataka: nil below 25,000, 200 from 25,000, no February amount in the seed', () => {
    expect(pt(ka, '24999.99', 10)).toBe('NIL_AMOUNT');
    expect(pt(ka, '25000.00', 10)).toBe('200.0000');
    expect(pt(ka, '25000.00', 2)).toBe('200.0000');
  });
});

describe('labour welfare fund (FR-039; seeded drafts: Maharashtra half-yearly, Karnataka yearly)', () => {
  const lwf = (p: LwfParameters, output: 'EMPLOYEE' | 'EMPLOYER', wages: string, month: number) => amount(valueLwf(output, p, { wages, month }));

  it('Maharashtra: June and December only; 6 and 18 up to 3,000 of wages, 12 and 36 above', () => {
    expect(lwf(lwfMh, 'EMPLOYEE', '20000.00', 6)).toBe('12.0000');
    expect(lwf(lwfMh, 'EMPLOYER', '20000.00', 12)).toBe('36.0000');
    expect(lwf(lwfMh, 'EMPLOYEE', '3000.00', 6)).toBe('6.0000'); // up to and including the limit
    expect(lwf(lwfMh, 'EMPLOYER', '3000.00', 6)).toBe('18.0000');
    expect(lwf(lwfMh, 'EMPLOYEE', '3000.01', 6)).toBe('12.0000');
    expect(lwf(lwfMh, 'EMPLOYEE', '20000.00', 7)).toBe('NOT_A_CONTRIBUTION_MONTH');
  });

  it('Karnataka: once a year with the December wages, 50 and 100', () => {
    expect(lwf(lwfKa, 'EMPLOYEE', '50000.00', 12)).toBe('50.0000');
    expect(lwf(lwfKa, 'EMPLOYER', '50000.00', 12)).toBe('100.0000');
    expect(lwf(lwfKa, 'EMPLOYEE', '50000.00', 6)).toBe('NOT_A_CONTRIBUTION_MONTH');
  });

  it('a pack is checked: its state, months in order, rising slabs ending without a limit, two amounts each', () => {
    expect(LWF_MH.validate(lwfMh).ok).toBe(true);
    expect(LWF_KA.validate(lwfKa).ok).toBe(true);
    expect(LWF_MH.validate({ ...lwfMh, stateCode: 'KA' })).toMatchObject({ ok: false });
    expect(LWF_MH.validate({ ...lwfMh, contributionMonths: [12, 6] })).toMatchObject({ ok: false });
    expect(LWF_MH.validate({ ...lwfMh, contributionMonths: [] })).toMatchObject({ ok: false });
    expect(LWF_MH.validate({ ...lwfMh, slabs: [{ upTo: '3000.00', employee: '6.00', employer: '18.00' }] })).toMatchObject({ ok: false });
    expect(LWF_MH.validate({ ...lwfMh, slabs: [{ upTo: null, employee: '6.00' }] })).toMatchObject({ ok: false });
    // A state without a fund, where the company has staff, is a pack with nil amounts.
    expect(lwfDefinition('LWF_DL').validate({ stateCode: 'DL', contributionMonths: [12], slabs: [{ upTo: null, employee: '0.00', employer: '0.00' }] }).ok).toBe(true);
    expect(LWF_MH.seed!.statuteReference).toContain('Validate against the law in force');
  });
});

describe('pack parameters are checked by their definition', () => {
  it('the seeds are valid and inactive drafts carry the statute and the validation note', () => {
    for (const d of [PF, ESIC, PT_MH, PT_KA]) {
      expect(d.validate(d.seed!.parameters).ok).toBe(true);
      expect(d.seed!.statuteReference).toContain('Code on Social Security, 2020');
    }
  });

  it('refuses unknown keys, a pension share above the employer rate, a percentage above 100 and a bad rounding', () => {
    expect(PF.validate({ ...pf, extra: 1 })).toMatchObject({ ok: false });
    expect(PF.validate({ ...pf, pensionRatePercent: '13' })).toMatchObject({ ok: false });
    expect(ESIC.validate({ ...esic, employerRatePercent: '100.01' })).toMatchObject({ ok: false });
    expect(ESIC.validate({ ...esic, rounding: 'NEAREST' })).toMatchObject({ ok: false });
    expect(ESIC.validate({ ...esic, contributionPeriodStartMonths: [10, 4] })).toMatchObject({ ok: false });
  });

  it('a slab table runs upward and ends without a limit, in the state of its code', () => {
    expect(PT_MH.validate({ ...mh, slabs: [{ upTo: '7500.00', amount: '0.00' }] })).toMatchObject({ ok: false });
    expect(PT_MH.validate({ ...mh, slabs: [{ upTo: '10000.00', amount: '0.00' }, { upTo: '7500.00', amount: '1.00' }, { upTo: null, amount: '2.00' }] })).toMatchObject({ ok: false });
    expect(PT_MH.validate({ ...mh, stateCode: 'KA' })).toMatchObject({ ok: false });
    expect(PT_MH.validate({ ...mh, slabs: [{ upTo: null, amount: '200.00', monthAmounts: { '13': '1.00' } }] })).toMatchObject({ ok: false });
    // A state without professional tax is a pack with one nil slab.
    expect(ptDefinition('PT_DL').validate({ stateCode: 'DL', slabs: [{ upTo: null, amount: '0.00' }] }).ok).toBe(true);
  });
});
