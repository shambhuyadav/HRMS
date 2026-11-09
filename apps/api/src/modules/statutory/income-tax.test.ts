// Income tax arithmetic on the FY 2026-27 draft (I-90): worked synthetic examples for the reviewer who validates the pack, by hand from
// the parameters as seeded (which are themselves to be validated against the Income-tax Act, 2025 in force). Pure: no database.
import { describe, expect, it } from 'vitest';
import { hraExemption, incomeTax, INCOME_TAX_SEED, monthlyTds, taxableIncome, validateIncomeTax, withEmployerNpsLimit } from './income-tax.js';

const P = INCOME_TAX_SEED.parameters;
const total = (regime: 'NEW' | 'OLD', taxable: string) => incomeTax(P, regime, taxable).total;

describe('INCOME_TAX pack parameters (I-90)', () => {
  it('the FY 2026-27 seed is a valid revision, and broken parameters are named', () => {
    expect(validateIncomeTax(P)).toMatchObject({ ok: true });
    const bad = validateIncomeTax({ ...P, defaultRegime: 'X', regimes: { ...P.regimes, NEW: { ...P.regimes.NEW, slabs: [{ upTo: '5', ratePercent: '5' }, { upTo: '4', ratePercent: '5' }, { upTo: '9', ratePercent: '5' }] } } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.problems).toEqual(
      expect.arrayContaining(['defaultRegime must be NEW or OLD', 'regimes.NEW.slabs[1].upTo must be above the slab before', 'regimes.NEW.slabs[2]: the last slab has no upper bound (upTo null)']),
    );
    expect(INCOME_TAX_SEED.statuteReference).toContain('To be validated against the law in force');
    // statutory_rule_pack.statute_reference holds at most 1,000 characters.
    expect(INCOME_TAX_SEED.statuteReference.length).toBeLessThanOrEqual(1000);
  });

  it('HRA exemption (old regime only): the least of the allowance received, rent less 10% of salary, and 50% (metro) or 40% of salary', () => {
    const old = P.regimes.OLD;
    // Salary (Basic + DA) 12,00,000 and an allowance of 6,00,000 received in the year.
    const ex = (rentPaid: string, metro: boolean, hraReceived = '600000') => hraExemption(old, { hraReceived, salary: '1200000', rentPaid, metro })!.exemption;
    expect(ex('600000', true)).toBe('480000.00'); // rent 6,00,000 less 1,20,000 binds (50% is 6,00,000)
    expect(ex('900000', false)).toBe('480000.00'); // 40% of salary binds (rent less 10% is 7,80,000)
    expect(ex('900000', true)).toBe('600000.00'); // the allowance and 50% both 6,00,000
    expect(ex('900000', true, '200000')).toBe('200000.00'); // the allowance received binds
    expect(ex('100000', true)).toBe('0.00'); // rent below 10% of salary: nothing
    expect(hraExemption(old, { hraReceived: '600000', salary: '1200000', rentPaid: '600000', metro: true })).toMatchObject({ rentLessSalaryShare: '480000.00', salaryShare: '600000.00' });
    expect(hraExemption(P.regimes.NEW, { hraReceived: '600000', salary: '1200000', rentPaid: '600000', metro: true })).toBeNull();
    // A malformed exemption is named.
    const bad = validateIncomeTax({ ...P, regimes: { ...P.regimes, OLD: { ...old, hraExemption: { metroPercent: '50', otherPercent: '140', rentAboveSalaryPercent: '10' } } } });
    expect(!bad.ok && bad.problems).toEqual(['regimes.OLD.hraExemption must be { metroPercent, otherPercent, rentAboveSalaryPercent } (percents from 0 to 100 in text)']);
  });

  it('the employer NPS contribution (s.80CCD(2)) is capped at 14% (new) or 10% (old) of salary, and at the category’s own limit if lower', () => {
    const nps = (regime: 'NEW' | 'OLD', amount: string, limit: string | null = null) =>
      withEmployerNpsLimit(P.regimes[regime], [{ categoryCode: 'SEC_80CCD_2', amount, limit }, { categoryCode: 'SEC_80C', amount: '150000', limit: '150000' }], 1200000n * 10n ** 8n);
    expect(nps('NEW', '300000')).toEqual({
      employerNpsLimit: '168000.00',
      deductions: [
        { categoryCode: 'SEC_80CCD_2', amount: '300000', limit: '168000.00' },
        { categoryCode: 'SEC_80C', amount: '150000', limit: '150000' },
      ],
    });
    expect(nps('OLD', '300000').employerNpsLimit).toBe('120000.00');
    expect(nps('NEW', '300000', '100000').deductions[0]!.limit).toBe('100000.00');
    expect(taxableIncome(P, 'NEW', '1800000', nps('NEW', '300000').deductions).deductionsAllowed).toBe('318000.00'); // 1,68,000 + 1,50,000
    const { employerNpsLimitPercent: _cap, ...withoutCap } = P.regimes.NEW;
    expect(withEmployerNpsLimit(withoutCap, [{ categoryCode: 'SEC_80CCD_2', amount: '300000', limit: null }], 0n)).toEqual({
      employerNpsLimit: null,
      deductions: [{ categoryCode: 'SEC_80CCD_2', amount: '300000', limit: null }],
    });
  });

  it('a year names two consecutive years, and every rate (slab, surcharge, cess) is at most 100, as the database checks (0236)', () => {
    const problems = (raw: unknown) => {
      const r = validateIncomeTax(raw);
      return r.ok ? [] : r.problems;
    };
    expect(problems({ ...P, fiscalYear: '2026-28' })).toEqual(['fiscalYear must look like 2026-27']);
    expect(problems({ ...P, fiscalYear: '2099-00' })).toEqual([]);
    expect(problems({ ...P, regimes: { ...P.regimes, OLD: { ...P.regimes.OLD, cessPercent: '100.5' } } })).toEqual(['regimes.OLD.cessPercent must be a percent from 0 to 100 in text']);
    expect(problems({ ...P, regimes: { ...P.regimes, NEW: { ...P.regimes.NEW, surcharge: [{ incomeAbove: '5000000.00', ratePercent: '101' }] } } })).toEqual([
      'regimes.NEW.surcharge[0] must be { incomeAbove (an amount in text), ratePercent (a percent in text) }',
    ]);
  });
});

describe('new regime (the default)', () => {
  it('12,00,000 taxable: slab tax 20,000 + 40,000 = 60,000, all rebated: nil', () => {
    expect(incomeTax(P, 'NEW', '1200000')).toMatchObject({ slabTax: '60000.00', rebate: '60000.00', taxAfterRebate: '0.00', total: '0.00' });
  });
  it('12,25,000: slab tax 63,750, but marginal relief caps it at the 25,000 above 12 lakh; cess 1,000: 26,000', () => {
    expect(incomeTax(P, 'NEW', '1225000')).toMatchObject({ slabTax: '63750.00', taxAfterRebate: '25000.00', cess: '1000.00', total: '26000.00' });
  });
  it('20,00,000: 20,000 + 40,000 + 60,000 + 80,000 = 2,00,000; cess 8,000: 2,08,000', () => {
    expect(total('NEW', '2000000')).toBe('208000.00');
  });
  it('50,10,000: 10% surcharge of 1,08,300 is cut by marginal relief to 7,000 (tax and surcharge at most 10,80,000 + 10,000); cess 43,600: 11,33,600', () => {
    expect(incomeTax(P, 'NEW', '5010000')).toMatchObject({ taxAfterRebate: '1083000.00', surcharge: '7000.00', marginalReliefOnSurcharge: '101300.00', cess: '43600.00', total: '1133600.00' });
  });
  it('60,00,000: 13,80,000 tax, surcharge 1,38,000 without relief, cess 60,720: 15,78,720', () => {
    expect(incomeTax(P, 'NEW', '6000000')).toMatchObject({ surcharge: '138000.00', marginalReliefOnSurcharge: '0.00', total: '1578720.00' });
  });
});

describe('old regime', () => {
  it('5,00,000: 12,500, all rebated: nil; 5,00,010: no marginal relief in this regime, 13,002.08 rounded to 13,000', () => {
    expect(total('OLD', '500000')).toBe('0.00');
    expect(incomeTax(P, 'OLD', '500010')).toMatchObject({ taxAfterRebate: '12502.00', total: '13000.00' });
  });
  it('8,00,000: 12,500 + 60,000 = 72,500; cess 2,900: 75,400', () => {
    expect(total('OLD', '800000')).toBe('75400.00');
  });
  it('taxable income: 10,00,000 gross, less 50,000 standard, 80C capped at its 1,50,000 limit, 20,000 under 80D: 7,80,000', () => {
    expect(
      taxableIncome(P, 'OLD', '1000000', [
        { categoryCode: 'SEC_80C', amount: '180000', limit: '150000' },
        { categoryCode: 'SEC_80D_SELF', amount: '20000', limit: '25000' },
      ]),
    ).toEqual({ taxable: '780000.00', standardDeduction: '50000.00', deductionsAllowed: '170000.00' });
  });
});

describe('monthly TDS', () => {
  it('spreads the year over the months left, half up to the rupee; the last month takes what is left', () => {
    // New regime, 13,00,000 gross: taxable 12,25,000, tax 26,000: 2,166.67 a month, so 2,167; after eleven months 23,837 is deducted.
    expect(taxableIncome(P, 'NEW', '1300000', []).taxable).toBe('1225000.00');
    expect(monthlyTds('26000', '0', 12)).toBe('2167.00');
    expect(monthlyTds('26000', '23837', 1)).toBe('2163.00');
    // Over-deducted already: nothing more, never a refund through payroll.
    expect(monthlyTds('26000', '30000', 3)).toBe('0.00');
  });

  it('a mid-year joiner: six months of 2,50,000 from October, 15,00,000 gross, taxable 14,25,000; tax 97,500 over six months: 16,250', () => {
    const t = taxableIncome(P, 'NEW', '1500000', []).taxable;
    expect(t).toBe('1425000.00');
    expect(incomeTax(P, 'NEW', t)).toMatchObject({ slabTax: '93750.00', cess: '3750.00', total: '97500.00' });
    expect(monthlyTds('97500', '0', 6)).toBe('16250.00');
  });

  it('a declaration changed mid-year (old regime, 1,00,000 a month): 80C 1,50,000 gives 9,750 a month; cut to 50,000 in October, 14,950 for the rest of the year', () => {
    const before = taxableIncome(P, 'OLD', '1200000', [{ categoryCode: 'SEC_80C', amount: '150000', limit: '150000' }]).taxable;
    expect(before).toBe('1000000.00');
    expect(total('OLD', before)).toBe('117000.00'); // 12,500 + 1,00,000, cess 4,500
    expect(monthlyTds('117000', '0', 12)).toBe('9750.00');
    // April to September deducted 6 x 9,750 = 58,500; the revised declaration takes effect from October.
    const after = taxableIncome(P, 'OLD', '1200000', [{ categoryCode: 'SEC_80C', amount: '50000', limit: '150000' }]).taxable;
    expect(after).toBe('1100000.00');
    expect(total('OLD', after)).toBe('148200.00'); // 1,12,500 + 30,000, cess 5,700
    expect(monthlyTds('148200', '58500', 6)).toBe('14950.00');
  });
});
