// FR-052 settlement formulas (decided under owner delegation, 6 Nov 2026; docs/03 I-88), as pure functions with hand-worked vectors one
// unit below, at and above each threshold. Synthetic amounts only.
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  dayRateValue,
  fromUnits,
  type GratuityParameters,
  gratuityAmount,
  gratuityEligibility,
  noticeShortfall,
  prorate,
  roundHalfUp,
  serviceYears,
  toUnits,
} from './settlement-formulas.js';

const ACT: GratuityParameters = { wageDays: 15, wageDivisor: 26, minimumServiceYears: 5, partYearMonthsOver: 6, ceilingAmount: '2000000.00', exemptSeparationTypes: ['DEATH', 'DISABLEMENT'] };

describe('exact decimals and the payroll rounding', () => {
  it('reads and writes four-decimal amounts without floating point', () => {
    expect(toUnits('12.5')).toBe(125000n);
    expect(toUnits('-0.0001')).toBe(-1n);
    expect(fromUnits(125000n)).toBe('12.5000');
    expect(fromUnits(-1n)).toBe('-0.0001');
    expect(() => toUnits('1.23456')).toThrow();
  });

  it('rounds half-up once to the minor unit, as hrms_payroll_round_half_up', () => {
    expect(roundHalfUp(15000005n, 1000n, 2)).toBe('15000.0100'); // 15,000.005 -> 15,000.01
    expect(roundHalfUp(15000004n, 1000n, 2)).toBe('15000.0000'); // 15,000.004 -> 15,000.00
    expect(roundHalfUp(5n, 10n, 0)).toBe('1.0000'); // 0.5 -> 1
    expect(() => roundHalfUp(-1n, 1n, 2)).toThrow();
  });
});

describe('DF05 proration of the final month', () => {
  it('31,000 x 15 / 31 = 15,000.00 (the payroll core value of the same month)', () => {
    expect(prorate([{ monthlyAmount: '31000', paidDays: '15' }], 31, 2)).toBe('15000.0000');
  });

  it('two arrangement segments are summed, then rounded once: 20,000 x 15 / 31 + 22,000 x 10 / 31 = 16,774.19', () => {
    expect(prorate([{ monthlyAmount: '20000', paidDays: '15' }, { monthlyAmount: '22000', paidDays: '10' }], 31, 2)).toBe('16774.1900');
    // Rounded once: 200 / 31 = 6.4516 -> 6.45, where rounding each segment first would give 3.23 + 3.23 = 6.46.
    expect(prorate([{ monthlyAmount: '100', paidDays: '1' }, { monthlyAmount: '100', paidDays: '1' }], 31, 2)).toBe('6.4500');
  });

  it('the worked leaver: 22,000 x 14 / 31 = 9,935.48; 5,000 x 14 / 31 = 2,258.06; 8,000 x 14 / 31 = 3,612.90; 300 x 14 / 31 = 135.48', () => {
    expect(prorate([{ monthlyAmount: '22000', paidDays: '14' }], 31, 2)).toBe('9935.4800');
    expect(prorate([{ monthlyAmount: '5000', paidDays: '14' }], 31, 2)).toBe('2258.0600');
    expect(prorate([{ monthlyAmount: '8000', paidDays: '14' }], 31, 2)).toBe('3612.9000');
    expect(prorate([{ monthlyAmount: '300', paidDays: '14' }], 31, 2)).toBe('135.4800');
  });
});

describe('day-rate values: encashment and notice recovery', () => {
  it('encashment of 15 units on Basic + DA 27,000 / 30 = 13,500.00; on Basic + DA / 26 = 15,576.92', () => {
    expect(dayRateValue('27000', '15', 30, 2)).toBe('13500.0000');
    expect(dayRateValue('27000', '15', 26, 2)).toBe('15576.9200'); // 405,000 / 26 = 15,576.923
  });

  it('a notice shortfall of 5 days on the gross 35,000 / 30 = 5,833.33; half-units are valued exactly', () => {
    expect(dayRateValue('35000', '5', 30, 2)).toBe('5833.3300');
    expect(dayRateValue('30000', '0.5', 30, 2)).toBe('500.0000');
  });

  it('refuses a divisor that is not a whole number of days above zero', () => {
    expect(() => dayRateValue('100', '1', 0, 2)).toThrow();
    expect(() => dayRateValue('100', '1', 26.5, 2)).toThrow();
  });
});

describe('notice served and short', () => {
  it('counts the resignation date and the last working date: 21 Sep to 15 Oct is 25 days, 5 short of 30', () => {
    expect(noticeShortfall('2026-09-21', '2026-10-15', 30)).toEqual({ required: 30, served: 25, shortfall: 5 });
  });

  it('one day below, at and above the notice: 29, 30 and 31 days served', () => {
    expect(noticeShortfall('2026-09-01', '2026-09-29', 30).shortfall).toBe(1);
    expect(noticeShortfall('2026-09-01', '2026-09-30', 30).shortfall).toBe(0);
    expect(noticeShortfall('2026-09-01', '2026-10-01', 30).shortfall).toBe(0);
  });
});

describe('gratuity (Payment of Gratuity Act, 1972, s.4)', () => {
  it('adds months as PostgreSQL does (clamped to the month end)', () => {
    expect(addMonths('2025-08-31', 6)).toBe('2026-02-28');
    expect(addMonths('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonths('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('eligibility one day below, at and above five years of continuous service', () => {
    // Joined 15 Nov 2021: five completed years end with 14 Nov 2026.
    expect(gratuityEligibility(ACT, '2021-11-15', '2026-11-13', 'RESIGNATION')).toMatchObject({ completedYears: 4, eligible: false });
    expect(gratuityEligibility(ACT, '2021-11-15', '2026-11-14', 'RESIGNATION')).toMatchObject({ completedYears: 5, eligible: true });
    expect(gratuityEligibility(ACT, '2021-11-15', '2026-11-15', 'RESIGNATION')).toMatchObject({ completedYears: 5, eligible: true });
  });

  it('death or disablement needs no minimum service; another separation does', () => {
    expect(gratuityEligibility(ACT, '2026-01-05', '2026-10-15', 'DEATH')).toMatchObject({ completedYears: 0, exempt: true, eligible: true });
    expect(gratuityEligibility(ACT, '2026-01-05', '2026-10-15', 'DISABLEMENT').eligible).toBe(true);
    expect(gratuityEligibility(ACT, '2026-01-05', '2026-10-15', 'RESIGNATION')).toMatchObject({ exempt: false, eligible: false });
  });

  it('a final part-year counts only when it is more than six months: exactly six months does not, six months and a day does', () => {
    // Joined 1 Jan 2020. Service to 30 Jun 2026 is 6 years and exactly 6 months; to 1 Jul 2026, 6 years, 6 months and a day.
    expect(serviceYears('2020-01-01', '2026-06-29', 6)).toMatchObject({ completedYears: 6, partYearCounts: false, countedYears: 6 });
    expect(serviceYears('2020-01-01', '2026-06-30', 6)).toMatchObject({ completedYears: 6, partYearCounts: false, countedYears: 6 });
    expect(serviceYears('2020-01-01', '2026-07-01', 6)).toMatchObject({ completedYears: 6, partYearCounts: true, countedYears: 7 });
  });

  it('the worked eligible employee: joined 3 Jun 2019, last day 30 Oct 2026, 7 counted years on 36,000: 15 / 26 x 36,000 x 7 = 1,45,384.62', () => {
    const e = gratuityEligibility(ACT, '2019-06-03', '2026-10-30', 'RESIGNATION');
    expect(e).toMatchObject({ completedYears: 7, partYearCounts: false, countedYears: 7, eligible: true });
    expect(gratuityAmount(ACT, '36000', e.countedYears, 2)).toEqual({ uncapped: '145384.6200', amount: '145384.6200', capped: false });
  });

  it('never above the ceiling: 15 / 26 x 4,00,000 x 10 = 23,07,692.31 is paid as 20,00,000.00', () => {
    expect(gratuityAmount(ACT, '400000', 10, 2)).toEqual({ uncapped: '2307692.3100', amount: '2000000.0000', capped: true });
  });

  it('every rate comes from the pack: 30 days a year at 30 a month doubles the 15 / 30 value', () => {
    const p = { ...ACT, wageDays: 30, wageDivisor: 30 };
    expect(gratuityAmount(p, '30000', 5, 2).amount).toBe('150000.0000');
    expect(gratuityAmount({ ...ACT, wageDivisor: 30 }, '30000', 5, 2).amount).toBe('75000.0000');
  });
});
