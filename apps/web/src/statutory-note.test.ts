// How a statutory amount was worked out, in plain words (statutory-note.ts): payroll and payslip rows, and the settlement calculation's
// statutory items (lifecycle-documents.tsx howText). Only recorded figures are shown. Synthetic workings only.
import { describe, expect, it } from 'vitest';
import { type CalculationItem, howText } from './pages/lifecycle-documents';
import { statutoryWorkingsNote } from './statutory-note';

const inr = (v: string) => `INR ${Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

describe('statutory workings in plain words', () => {
  it('a final settlement’s TDS: the year as it ends, the earlier employer and the HRA exemption, and no months to spread over', () => {
    expect(
      statutoryWorkingsNote(
        true,
        {
          output: 'TDS',
          regime: 'NEW',
          annualSalary: '2400000.00',
          settlementTaxableSalary: '2200000.00',
          taxableIncome: '2325000.00',
          annualTax: '292500.00',
          tdsEarlier: '24375.00',
        },
        inr,
      ),
    ).toBe('New regime: salary for the year INR 24,00,000.00 (INR 22,00,000.00 in this settlement), taxable income INR 23,25,000.00, tax for the year INR 2,92,500.00; INR 24,375.00 deducted earlier this year');
    expect(
      statutoryWorkingsNote(
        true,
        { output: 'TDS', regime: 'NEW', projectedAnnualSalary: '1500000.00', previousEmployerSalary: '900000.00', previousEmployerTds: '50000.00', taxableIncome: '2325000.00', annualTax: '292500.00', tdsEarlier: '0.00', monthsLeft: 6 },
        inr,
      ),
    ).toBe(
      'New regime: projected salary for the year INR 15,00,000.00, with INR 9,00,000.00 from an earlier employer (INR 50,000.00 deducted there), taxable income INR 23,25,000.00, tax for the year INR 2,92,500.00; INR 0.00 deducted earlier this year, the rest spread over 6 month(s)',
    );
  });

  it('nothing due says why, with the year’s tax where TDS was worked out; an employer contribution says what it costs', () => {
    expect(statutoryWorkingsNote(false, { output: 'TDS', reason: 'NO_TAX_DUE', taxableIncome: '221774.19', annualTax: '0.00' }, inr)).toBe(
      'No tax due on the year so far: tax for the year INR 0.00 on taxable income INR 2,21,774.19',
    );
    expect(statutoryWorkingsNote(false, { output: 'EPS', employerCost: '403.0000', reason: 'EMPLOYER_COST: synthetic' }, inr)).toBe('Paid by the employer: INR 403.00, not part of the settlement');
    expect(statutoryWorkingsNote(false, { reason: 'NOT_COVERED' }, inr)).toBe('Not covered: your wages are above the ESIC ceiling');
  });

  it('a settlement’s statutory item names the pack and revision and says how it was valued (howText)', () => {
    const item = (status: string, basis: Record<string, unknown>): CalculationItem =>
      ({ position: 1, kind: 'STATUTORY_DEDUCTION', status, blocking: false, componentCode: 'PF_EE', componentKind: 'DEDUCTION', amount: '-581.0000', basis, leaveTypeCode: null }) as CalculationItem;
    expect(
      howText(item('CALCULATED', { rulePackCode: 'PF_EMPLOYEE', baseComponentCodes: ['BASIC', 'DA'], packCode: 'PF', packRevision: 1, output: 'EMPLOYEE', pfWages: '4838.7100', contributionWages: '4838.7100', option: 'STATUTORY_CEILING', ratePercent: '12' })),
    ).toBe('rule pack PF_EMPLOYEE on BASIC, DA; PF revision 1; 12% of 4,838.71');
    expect(howText(item('NOT_APPLICABLE', { rulePackCode: 'ESIC_EMPLOYER', baseComponentCodes: ['BASIC'], packCode: 'ESIC', packRevision: 1, output: 'EMPLOYER', employerCost: '221.0000', reason: 'EMPLOYER_COST' }))).toBe(
      'rule pack ESIC_EMPLOYER on BASIC; ESIC revision 1; Paid by the employer: 221.00, not part of the settlement',
    );
    // Not valued (no pack active): as before, the rule pack and the bases, and the reason the server gave.
    expect(howText(item('RULE_PACK_NOT_CONFIGURED', { rulePackCode: 'TDS', baseComponentCodes: ['BASIC'], packCode: 'INCOME_TAX' }))).toBe('rule pack TDS on BASIC');
  });
});
