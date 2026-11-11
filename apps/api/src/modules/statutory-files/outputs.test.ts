// The statutory file layouts and row checks (batch R4: CL-093, CL-105, CL-106, CL-107), on synthetic records only: the ECR 2.0 line and
// its row errors, whole rupees under the rounding the PF pack recorded, the ESIC monthly reason codes, the new joiners' optional
// columns, the TDS control totals, the state summaries, and the samples a format acceptance validates. Nothing statutory is computed.
import { describe, expect, it } from 'vitest';
import {
  buildEcr,
  buildEsicHalfYear,
  buildEsicMonthly,
  buildLwfReturn,
  buildNewJoiners,
  buildPtReturn,
  buildTdsQuarter,
  exactWhole,
  type IdentifierRead,
  OUTPUT_CODES,
  OUTPUTS,
  renderEcr,
  renderFile,
  type RunRecord,
  sampleOf,
  type StatutoryRow,
  twoDecimals,
  whole,
} from './outputs.js';

const row = (code: string, amount: string | null, workings: Record<string, unknown>): StatutoryRow => ({ code, status: amount ? 'VALUED' : 'NOT_APPLICABLE', amount, workings });
const pfRows = (o: { ee?: string | null; eps?: string | null; epf?: string | null; edli?: string | null; wages?: string; rounding?: unknown } = {}) => {
  const w = o.wages ?? '15000.0000';
  const base = { packCode: 'PF', packRevision: 1, rounding: 'rounding' in o ? o.rounding : 'HALF_UP_WHOLE' };
  return [
    row('PF_EMPLOYEE', o.ee === undefined ? '1800.0000' : o.ee, { ...base, contributionWages: w }),
    row('PF_EMPLOYER_EPS', o.eps === undefined ? '1250.0000' : o.eps, { ...base, pensionWages: w }),
    row('PF_EMPLOYER_EPF', o.epf === undefined ? '550.0000' : o.epf, base),
    row('PF_EDLI', o.edli === undefined ? '75.0000' : o.edli, { ...base, edliWages: w }),
  ];
};
let n = 0;
const rec = (over: Partial<RunRecord> = {}): RunRecord => {
  n += 1;
  return {
    recordId: `r${n}`,
    employeeId: `e${n}`,
    employeeCode: `SYN${String(n).padStart(3, '0')}`,
    name: 'Synthetic Person',
    joiningDate: '2025-01-05',
    leavingDate: null,
    separationType: null,
    paidUnits: '31.0000',
    earnings: '15000.0000',
    lopUnits: '0',
    periodCode: '2026-10',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    statutory: pfRows(),
    ...over,
  };
};
const ids = (entries: [string, IdentifierRead][]) => new Map(entries);

describe('recorded values', () => {
  it('wages become whole rupees under the recorded rounding; contributions and days must already be whole; ESIC wages keep two decimals', () => {
    expect(whole('6451.6100', 'HALF_UP_WHOLE')).toBe('6452');
    expect(whole('6451.4999', 'HALF_UP_WHOLE')).toBe('6451');
    expect(whole('6451.5', 'HALF_UP_WHOLE')).toBe('6452');
    expect(whole('6451.0001', 'UP_WHOLE')).toBe('6452');
    expect(whole('6451', 'UP_WHOLE')).toBe('6451');
    expect(whole('-1', 'HALF_UP_WHOLE')).toBeNull();
    expect(whole('not a number', 'HALF_UP_WHOLE')).toBeNull();
    expect(exactWhole('1800.0000')).toBe('1800');
    expect(exactWhole('1800.5000')).toBeNull();
    expect(twoDecimals('4838.7100')).toBe('4838.71');
    expect(twoDecimals('4838.7123')).toBeNull();
  });
});

describe('CL-106 EPFO ECR 2.0', () => {
  it('writes the eleven fields in order, #~# separated, whole rupees, no header and no trailing line ending', () => {
    const a = rec({ name: 'Synthetic Member A', earnings: '16500.5000' });
    const b = rec({ name: 'Synthetic Member B', earnings: '6451.6100', lopUnits: '2.0000', statutory: pfRows({ ee: '774.0000', eps: '537.0000', epf: '237.0000', edli: '32.0000', wages: '6451.6100' }) });
    const built = buildEcr([a, b], ids([[a.employeeId, { uan: '100000000001' }], [b.employeeId, { uan: '100000000002' }]]));
    expect(built.errors).toEqual([]);
    expect(built.content.kind === 'ECR' && renderEcr(built.content.lines)).toBe(
      ['100000000001#~#Synthetic Member A#~#16501#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0', '100000000002#~#Synthetic Member B#~#6452#~#6452#~#6452#~#6452#~#774#~#537#~#237#~#2#~#0'].join('\r\n'),
    );
    expect(built.totals).toMatchObject({ members: 2, grossWages: '22953', epfContribution: '2574', epsContribution: '1787', epfEpsDifference: '787', ncpDays: '2' });
    // Nothing records a refund of PF advances: the file says 0 and the status says why.
    expect(built.warnings.map((w) => w.code)).toEqual(['REFUND_OF_ADVANCES_NOT_RECORDED']);
  });

  it('a nil contribution is 0, an employee without a PF valuation is not a member', () => {
    const nil = rec({ earnings: '0', statutory: pfRows({ ee: null, eps: null, epf: null, edli: null, wages: '0.0000' }) });
    const none = rec({ statutory: [] });
    const built = buildEcr([nil, none], ids([[nil.employeeId, { uan: '100000000003' }]]));
    expect(built.errors).toEqual([]);
    expect(built.content.kind === 'ECR' && built.content.lines).toEqual([['100000000003', 'Synthetic Person', '0', '0', '0', '0', '0', '0', '0', '0', '0']]);
    expect(built.employeeIds).toEqual([nil.employeeId]);
  });

  it('lists every row error instead of guessing, and writes no line for such a member', () => {
    const noUan = rec();
    const badUan = rec();
    const noName = rec({ name: '  ' });
    const hashName = rec({ name: 'Synth#~#Injected' });
    const halfDay = rec({ lopUnits: '1.5000' });
    const noRounding = rec({ statutory: pfRows({ rounding: undefined }) });
    const noEps = rec({ statutory: pfRows().filter((s) => s.code !== 'PF_EMPLOYER_EPS') });
    const fraction = rec({ statutory: pfRows({ ee: '1800.5000' }) });
    const sealed = rec();
    const twice = rec({ statutory: [...pfRows(), row('PF_EDLI', '75.0000', { edliWages: '15000.0000' })] });
    const all = [noUan, badUan, noName, hashName, halfDay, noRounding, noEps, fraction, sealed, twice];
    const map = ids(all.map((r, i) => [r.employeeId, r === noUan ? {} : r === badUan ? { uan: '12345678901' } : r === sealed ? null : { uan: `2000000000${String(i).padStart(2, '0')}` }]));
    const built = buildEcr(all, map);
    expect(built.errors.map((e) => [e.employeeCode, e.code])).toEqual([
      [noUan.employeeCode, 'MISSING_UAN'],
      [badUan.employeeCode, 'INVALID_UAN'],
      [noName.employeeCode, 'MISSING_NAME'],
      [hashName.employeeCode, 'INVALID_NAME'],
      [halfDay.employeeCode, 'NCP_DAYS_NOT_WHOLE'],
      [noRounding.employeeCode, 'ROUNDING_NOT_RECORDED'],
      [noEps.employeeCode, 'EPS_NOT_RECORDED'],
      [fraction.employeeCode, 'AMOUNT_NOT_WHOLE'],
      [sealed.employeeCode, 'IDENTIFIERS_UNREADABLE'],
      [twice.employeeCode, 'DUPLICATE_STATUTORY_ROW'],
    ]);
    expect(built.content.kind === 'ECR' && built.content.lines).toEqual([]);
  });
});

describe('CL-107 ESIC monthly contribution file', () => {
  const esicRows = (wages: string, ee: string | null = '113.0000', reason?: string) => [
    row('ESIC_EMPLOYEE', ee, { packCode: 'ESIC', esicWages: wages, ...(reason ? { reason } : {}) }),
    row('ESIC_EMPLOYER', ee ? '488.0000' : null, { packCode: 'ESIC', esicWages: wages, ...(reason ? { reason } : {}) }),
  ];

  it('one row per insured person; leavers carry the separation’s reason code and last working day; above the ceiling is left out', () => {
    const stays = rec({ name: 'Synthetic Stays', statutory: esicRows('15000.0000') });
    const resigned = rec({ name: 'Synthetic Resigned', paidUnits: '10.0000', leavingDate: '2026-10-10', separationType: 'RESIGNATION', statutory: esicRows('4838.7100', '37.0000') });
    const retired = rec({ name: 'Synthetic Retired', paidUnits: '15.0000', leavingDate: '2026-10-15', separationType: 'RETIREMENT', statutory: esicRows('7258.0600', '55.0000') });
    const died = rec({ name: 'Synthetic Expired', paidUnits: '5.0000', leavingDate: '2026-10-05', separationType: 'DEATH', statutory: esicRows('2419.3500', '19.0000') });
    const above = rec({ statutory: esicRows('35000.0000', null, 'NOT_COVERED') });
    const records = [stays, resigned, retired, died, above];
    const built = buildEsicMonthly(records, ids(records.map((r, i) => [r.employeeId, { esicIpNumber: `30000000${String(i).padStart(2, '0')}` }])));
    expect(built.errors).toEqual([]);
    expect(built.content.kind === 'TABLE' && built.content.table.rows).toEqual([
      { ipNumber: '3000000000', ipName: 'Synthetic Stays', days: '31', wages: '15000.00', reasonCode: '0', lastWorkingDay: '' },
      { ipNumber: '3000000001', ipName: 'Synthetic Resigned', days: '10', wages: '4838.71', reasonCode: '2', lastWorkingDay: '10/10/2026' },
      { ipNumber: '3000000002', ipName: 'Synthetic Retired', days: '15', wages: '7258.06', reasonCode: '3', lastWorkingDay: '15/10/2026' },
      { ipNumber: '3000000003', ipName: 'Synthetic Expired', days: '5', wages: '2419.35', reasonCode: '5', lastWorkingDay: '05/10/2026' },
    ]);
    expect(built.warnings).toEqual([expect.objectContaining({ code: 'NOT_COVERED', count: 1 })]);
    expect(built.totals).toMatchObject({ insuredPersons: 4, wages: '29516.12', employeeContribution: '224.00' });
  });

  it('a covered person paid for no day who did not leave has no recorded reason: a row error, as are names and precision the portal refuses', () => {
    const idle = rec({ paidUnits: '0.0000', statutory: esicRows('0.0000', null, 'NIL_AMOUNT') });
    const dotted = rec({ name: 'Synth. Person', statutory: esicRows('15000.0000') });
    const precise = rec({ statutory: esicRows('15000.1234') });
    const half = rec({ paidUnits: '30.5000', statutory: esicRows('15000.0000') });
    const noIp = rec({ statutory: esicRows('15000.0000') });
    const records = [idle, dotted, precise, half, noIp];
    const built = buildEsicMonthly(records, ids(records.map((r) => [r.employeeId, r === noIp ? { uan: '100000000001' } : { esicIpNumber: '3000000099' }])));
    expect(built.errors.map((e) => [e.employeeCode, e.code])).toEqual([
      [idle.employeeCode, 'REASON_CODE_NOT_RECORDED'],
      [dotted.employeeCode, 'NAME_NOT_ALPHABETIC'],
      [precise.employeeCode, 'WAGES_PRECISION'],
      [half.employeeCode, 'DAYS_NOT_WHOLE'],
      [noIp.employeeCode, 'MISSING_IP_NUMBER'],
    ]);
  });

  it('the half-yearly summary adds each insured person’s months of the contribution period', () => {
    const october = rec({ statutory: esicRows('15000.0000') });
    const december = { ...october, recordId: 'r-dec', periodCode: '2026-12', statutory: esicRows('15500.0000', '117.0000') };
    const built = buildEsicHalfYear([october, december], ids([[october.employeeId, { esicIpNumber: '3000000001' }]]));
    expect(built.content.kind === 'TABLE' && built.content.table.rows).toEqual([
      { ipNumber: '3000000001', ipName: 'Synthetic Person', employeeCode: october.employeeCode, months: '2', days: '62', wages: '30500.00', employeeContribution: '230.00', employerContribution: '976.00', totalContribution: '1206.00' },
    ]);
  });
});

describe('CL-105 PF new joiners', () => {
  it('lists the members who joined in the month; the father’s or spouse’s name only when readable, else the columns are left out', () => {
    const joiner = rec({ joiningDate: '2026-10-12', name: 'Synthetic Joiner' });
    const noUan = rec({ joiningDate: '2026-10-20', name: 'Synthetic Pending' });
    const earlier = rec({ joiningDate: '2026-09-30' });
    const map = ids([[joiner.employeeId, { uan: '100000000009' }]]);
    const withFamily = buildNewJoiners([joiner, noUan, earlier], map, new Map([[joiner.employeeId, { name: 'Synthetic Father', relation: 'F' as const }]]));
    expect(withFamily.content.kind === 'TABLE' && withFamily.content.table.rows).toEqual([
      { employeeCode: joiner.employeeCode, uan: '100000000009', name: 'Synthetic Joiner', joiningDate: '12/10/2026', relativeName: 'Synthetic Father', relation: 'F' },
      { employeeCode: noUan.employeeCode, uan: '', name: 'Synthetic Pending', joiningDate: '20/10/2026', relativeName: '', relation: '' },
    ]);
    expect(withFamily.warnings.map((w) => w.code)).toEqual(['UAN_NOT_RECORDED']);
    const without = buildNewJoiners([joiner], map, null);
    expect(without.content.kind === 'TABLE' && without.content.table.columns.map((c) => c.key)).toEqual(['employeeCode', 'uan', 'name', 'joiningDate']);
    expect(without.warnings.map((w) => w.code)).toEqual(['RELATIVE_NAME_OMITTED']);
  });
});

describe('CL-093 TDS quarterly summary', () => {
  it('month by month and for the quarter: deducted from the working data, deposited from recorded challans, and the difference', () => {
    const built = buildTdsQuarter(
      ['2026-10', '2026-11', '2026-12'],
      [
        { employeeId: 'a', months: [{ month: '2026-10', taxableSalary: '300000.0000', tds: '25133.0000' }, { month: '2026-12', taxableSalary: '300000.0000', tds: '25133.0000' }] },
        { employeeId: 'b', months: [{ month: '2026-10', taxableSalary: '14000.0000', tds: '0.0000' }] },
      ],
      [
        { month: '2026-10', amount: '25133.00', state: 'RECORDED' },
        { month: '2026-10', amount: '99.00', state: 'CANCELLED' },
      ],
    );
    expect(built.content.kind === 'TABLE' && built.content.table.rows).toEqual([
      { month: '2026-10', employees: '2', deductees: '1', taxableSalary: '314000.00', tdsDeducted: '25133.00', challans: '1', tdsDeposited: '25133.00', difference: '0.00' },
      { month: '2026-11', employees: '0', deductees: '0', taxableSalary: '0.00', tdsDeducted: '0.00', challans: '0', tdsDeposited: '0.00', difference: '0.00' },
      { month: '2026-12', employees: '1', deductees: '1', taxableSalary: '300000.00', tdsDeducted: '25133.00', challans: '0', tdsDeposited: '0.00', difference: '25133.00' },
      { month: 'QUARTER', employees: '2', deductees: '1', taxableSalary: '614000.00', tdsDeducted: '50266.00', challans: '1', tdsDeposited: '25133.00', difference: '25133.00' },
    ]);
    expect(built.warnings.map((w) => w.code)).toEqual(['SHORT_DEPOSITED']);
  });
});

describe('professional tax and labour welfare fund state summaries', () => {
  it('PT: employees and tax per slab and state, nil slabs counted, packs not usable left out', () => {
    const pt = (pack: string, amount: string | null, slab: number, upTo: string | null) => [row('PROFESSIONAL_TAX', amount, { packCode: pack, stateCode: pack.slice(3), slab, slabUpTo: upTo })];
    const built = buildPtReturn(
      [rec({ statutory: pt('PT_MH', '200.0000', 3, null) }), rec({ statutory: pt('PT_MH', '200.0000', 3, null) }), rec({ statutory: pt('PT_MH', null, 1, '7500.00') }), rec({ statutory: pt('PT_KA', '200.0000', 2, null) })],
      new Set(['PT_MH']),
    );
    expect(built.content.kind === 'TABLE' && built.content.table.rows).toEqual([
      { state: 'MH', slab: '1', upTo: '7500.00', employees: '1', perEmployee: '0.00', tax: '0.00' },
      { state: 'MH', slab: '3', upTo: '', employees: '2', perEmployee: '200.00', tax: '400.00' },
      { state: 'MH', slab: 'TOTAL', upTo: '', employees: '3', perEmployee: '', tax: '400.00' },
    ]);
    expect(built.totals).toEqual({ employees: 3, states: 1, tax: '400.00' });
  });

  it('LWF: both contributions per slab; a month that is not a contribution month says so', () => {
    const lwf = (amounts: [string, string] | null, slab?: number) => [
      row('LWF_EMPLOYEE', amounts?.[0] ?? null, { packCode: 'LWF_MH', stateCode: 'MH', ...(slab ? { slab, slabUpTo: null } : { reason: 'NOT_A_CONTRIBUTION_MONTH' }) }),
      row('LWF_EMPLOYER', amounts?.[1] ?? null, { packCode: 'LWF_MH', stateCode: 'MH', ...(slab ? { slab, slabUpTo: null } : { reason: 'NOT_A_CONTRIBUTION_MONTH' }) }),
    ];
    const december = buildLwfReturn([rec({ statutory: lwf(['12.0000', '36.0000'], 2) }), rec({ statutory: lwf(['12.0000', '36.0000'], 2) })], new Set(['LWF_MH']));
    expect(december.content.kind === 'TABLE' && december.content.table.rows).toEqual([
      { state: 'MH', slab: '2', upTo: '', employees: '2', employee: '24.00', employer: '72.00', total: '96.00' },
      { state: 'MH', slab: 'TOTAL', upTo: '', employees: '2', employee: '24.00', employer: '72.00', total: '96.00' },
    ]);
    const october = buildLwfReturn([rec({ statutory: lwf(null) })], new Set(['LWF_MH']));
    expect(october.rowCount).toBe(0);
    expect(october.warnings).toEqual([expect.objectContaining({ code: 'NOT_A_CONTRIBUTION_MONTH', count: 1 })]);
  });
});

describe('samples and rendering', () => {
  it('every output has a sample without row errors, rendered in each offered format, with a stable hash', () => {
    for (const code of OUTPUT_CODES) {
      const a = sampleOf(code);
      expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(a.files.map((f) => f.format)).toEqual([...OUTPUTS[code].formats]);
      expect(sampleOf(code).hash).toBe(a.hash);
    }
    expect(new Set(OUTPUT_CODES.map((c) => sampleOf(c).hash)).size).toBe(OUTPUT_CODES.length);
    const ecr = sampleOf('PF_ECR').files[0]!.bytes.toString('utf8');
    expect(ecr.split('\r\n')).toEqual(['999999999901#~#SAMPLE MEMBER ONE#~#15000#~#15000#~#15000#~#15000#~#1800#~#1250#~#550#~#0#~#0', '999999999902#~#SAMPLE MEMBER TWO#~#6452#~#6452#~#6452#~#6452#~#774#~#537#~#237#~#2#~#0']);
  });

  it('an upload layout never carries a header comment; a summary states its source first', () => {
    const esic = sampleOf('ESIC_MONTHLY').files.find((f) => f.format === 'csv')!.bytes.toString('utf8');
    expect(esic.split('\r\n')[0]).toBe('"IP Number (10 Digits)","IP Name (Only alphabets and space)","No of Days for which wages paid/payable during the month","Total Monthly Wages","Reason Code for Zero workings days (numeric only; provide 0 for all other reasons)","Last Working Day (Format DD/MM/YYYY or DD-MM-YYYY)"');
    expect(esic).not.toContain('Sample');
    const pt = sampleOf('PT_STATE_RETURN').files.find((f) => f.format === 'csv')!.bytes.toString('utf8');
    expect(pt.split('\r\n').slice(0, 4)).toEqual(['"Sample","Synthetic rows only; not for filing"', '"Output","PT_STATE_RETURN layout 1"', '"Produced from pinned pack revisions","PT revision 0 (sample)"', '']);
    // An XLSX is a ZIP (PK), its source on a second worksheet.
    const xlsx = sampleOf('PT_STATE_RETURN').files.find((f) => f.format === 'xlsx')!.bytes;
    expect(xlsx.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(xlsx.toString('latin1')).toContain('Produced from pinned pack revisions');
    expect(() => renderFile(OUTPUTS.PF_ECR, buildEcr([], new Map()), 'csv', null)).toThrow();
  });
});
