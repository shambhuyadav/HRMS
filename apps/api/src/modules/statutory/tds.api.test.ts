// TDS on salary in payroll (I-90, decided under owner delegation, 6 Nov 2026): a RULE_PACK head coded TDS is valued by the statutory evaluator
// from the INCOME_TAX pack two people validated and activated, as the year's projected tax less what was deducted, over the months left.
// Worked synthetic examples (new regime, the default; FY 2026-27 draft values, themselves to be validated):
//   2,00,000 a month from April: 24,00,000 a year, taxable 23,25,000, tax 2,81,250 + cess 11,250 = 2,92,500; 24,375 in April and in May.
//   A joiner from 1 October on 2,50,000: 15,00,000 for six months, taxable 14,25,000, tax 97,500; 16,250 a month.
// Without an active pack the head blocks the employee (RULE_PACK_NOT_CONFIGURED), as every statutory head does.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { HR_SETTLEMENT } from '../lifecycle/lifecycle.fixtures.js';
import { APPROVE, approvedExit, calculate, calendar, CONFIG, createRun, grants, head, months, ok, person, PREPARE, PROCESS, processRun, record, REVIEW, reviewers, SALARY, salary, submitAndApprove } from '../payroll/payroll.fixtures.js';

describe('TDS on salary through the statutory evaluator (I-90)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let periods: Record<string, string>;
  let deducted: string;

  const staff = async (monthly: string, joiningDate = '2026-01-05') => {
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, 'Synthetic', true) returning id`, [A.id, uniq('TDS')])).id;
    const id = await person(h, A, hr, { departmentId: dept, joiningDate });
    await salary(h, preparer, id, { effectiveFrom: joiningDate, monthlyGross: monthly, components: [{ code: 'TX_BASIC', amount: monthly }] });
    return { id, dept };
  };
  const processed = async (month: string, s: { dept: string }) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [s.dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    await processRun(h, processor, run.id);
    return run.id;
  };
  const tdsOf = async (runId: string, employeeId: string) => (await record(h, processor, runId, employeeId)).lines.find((l) => l.componentCode === 'TX_TDS')?.amount;
  const workingsOf = async (runId: string, employeeId: string) =>
    (
      await h.one<{ workings: Record<string, unknown>; status: string }>(
        `select s.workings, s.status from payroll_record_statutory s join payroll_record r on r.id = s.record_id where r.run_id = $1 and r.employee_id = $2 and s.rule_pack_code = 'TDS'`,
        [runId, employeeId],
      )
    );

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'TX_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'TX_TDS', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'TDS', base: ['TX_BASIC'], sequence: 2 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
  }, 300_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('without an active INCOME_TAX pack the TDS head blocks the employee, naming the pack', async () => {
    const s = await staff('200000');
    const run = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [s.dept] });
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, s.id);
    expect(r.calculationStatus).toBe('FAILED');
    expect(r.exceptions).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'RULE_PACK_NOT_CONFIGURED' })]));
  });

  it('once two people validate and activate the pack: 24,375 in April and again in May, the year’s 2,92,500 spread over the months left', async () => {
    const pack = (await h.one<{ id: string }>(`select id from statutory_rule_pack where company_id = $1 and code = 'INCOME_TAX' and revision = 1`, [A.id])).id;
    await h.db.query(`update statutory_rule_pack set state = 'VALIDATED', validated_by = $2, validated_at = now(), source_reference = 'Synthetic source', validation_reference = 'Synthetic check' where id = $1`, [
      pack,
      configA.user,
    ]);
    await h.db.query(`update statutory_rule_pack set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [pack, configB.user]);
    const s = await staff('200000');
    const april = await processed('2026-04', s);
    expect(await tdsOf(april, s.id)).toBe('24375.0000');
    expect((await record(h, processor, april, s.id)).net).toBe('175625.0000');
    expect(await workingsOf(april, s.id)).toMatchObject({
      status: 'VALUED',
      workings: { fiscalYear: '2026-27', regime: 'NEW', regimeSource: 'DEFAULT', projectedAnnualSalary: '2400000.00', taxableIncome: '2325000.00', annualTax: '292500.00', monthsLeft: 12, tdsEarlier: '0.00' },
    });
    const may = await processed('2026-05', s);
    expect(await tdsOf(may, s.id)).toBe('24375.0000');
    expect(await workingsOf(may, s.id)).toMatchObject({ workings: { tdsEarlier: '24375.00', monthsLeft: 11, earlierTaxableSalary: '200000.00' } });
    deducted = s.id;
  });

  it('P8a gap 4: the record and its payslip show how the TDS was worked out, as the calculation recorded it', async () => {
    const run = (await h.one<{ id: string }>(`select r.run_id as id from payroll_record r join payroll_run ru on ru.id = r.run_id where r.employee_id = $1 and ru.service_start = '2026-04-01'`, [deducted])).id;
    const r = await record(h, processor, run, deducted);
    expect(r.statutory).toEqual([
      {
        componentCode: 'TX_TDS',
        rulePackCode: 'TDS',
        headType: 'DEDUCTION',
        status: 'VALUED',
        amount: '24375.0000',
        workings: expect.objectContaining({ packCode: 'INCOME_TAX', packRevision: 1, regime: 'NEW', taxableIncome: '2325000.00', annualTax: '292500.00', monthsLeft: 12 }),
      },
    ]);
    const outputs = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_output.read.amount', 'payroll_report.read.amount'] });
    const preview = await ok<{ content: { statutory: unknown[] } }>(await h.call(outputs, 'GET', `/v1/payroll-outputs/records/${r.id}/payslip-preview`));
    expect(preview.content.statutory).toEqual([
      { componentCode: 'TX_TDS', componentName: expect.any(String), status: 'VALUED', amount: '24375.0000', workings: expect.objectContaining({ annualTax: '292500.00', tdsEarlier: '0.00', monthsLeft: 12 }) },
    ]);
  });

  it('a leaver whose deducted TDS already covers the year’s tax: the settlement’s TDS is NOT_APPLICABLE (NO_TAX_DUE), never a refund', async () => {
    // April processed on 2,00,000 (TDS 24,375 on the projected year). Last day 15 May: the settlement pays 2,00,000 x 15 / 31 = 96,774.19.
    // The year as it ends, 2,96,774.19 less 75,000 = 2,21,774.19, is below the first taxed slab: no tax, so nothing more is deducted.
    const s = await staff('200000');
    await processed('2026-04', s);
    await approvedExit(h, A, s.id, '2026-04-20', '2026-05-15');
    const prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1 and state = 'APPROVED'`, [s.id])).id;
    const draft = await ok<{ id: string; version: number }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const d = await ok<{ calculation: { items: { kind: string; status: string; componentCode: string | null; amount: string | null; basis: Record<string, unknown> }[] }; lines: { componentCode: string }[] }>(
      await h.call(prep, 'POST', `/v1/settlements/${draft.id}/calculate`, { expectedVersion: draft.version }),
    );
    const tds = d.calculation.items.filter((i) => i.componentCode === 'TX_TDS');
    expect(tds.map((i) => [i.kind, i.status, i.amount, i.basis.reason])).toEqual([['STATUTORY_DEDUCTION', 'NOT_APPLICABLE', null, 'NO_TAX_DUE']]);
    expect(tds[0]!.basis).toMatchObject({ annualSalary: '296774.19', taxableIncome: '221774.19', annualTax: '0.00', tdsEarlier: '24375.00' });
    expect(d.lines.some((l) => l.componentCode === 'TX_TDS')).toBe(false);
  });

  it('a settlement whose last working day falls in a year without its own income tax pack blocks its TDS (NO_PACK_FOR_FISCAL_YEAR)', async () => {
    // The FY 2026-27 revision is still the one in effect on 15 April 2027, but a revision values only its own year.
    const s = await staff('100000');
    await approvedExit(h, A, s.id, '2027-03-20', '2027-04-15');
    const prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    const exitId = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1 and state = 'APPROVED'`, [s.id])).id;
    const draft = await ok<{ id: string; version: number }>(await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' }), 201);
    const d = await ok<{ calculation: { items: { status: string; componentCode: string | null; basis: Record<string, unknown> }[] } }>(
      await h.call(prep, 'POST', `/v1/settlements/${draft.id}/calculate`, { expectedVersion: draft.version }),
    );
    expect(d.calculation.items.filter((i) => i.componentCode === 'TX_TDS').map((i) => [i.status, i.basis.reason, i.basis.fiscalYear])).toEqual([
      ['RULE_PACK_NOT_CONFIGURED', 'NO_PACK_FOR_FISCAL_YEAR', '2027-28'],
    ]);
  });

  it('Form 16 Part B counts the TDS the head deducted in the year’s processed months (FR-107)', async () => {
    const taxReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['tax_declaration.read.tax'] });
    const res = await ok<Record<string, unknown>>(await h.call(taxReader, 'GET', `/v1/payroll/form16/part-b?employeeId=${deducted}&fiscalYear=2026-27`));
    expect(res).toMatchObject({ status: 'CALCULATED', salary: { processedMonths: 2, grossSalary: '400000.00', tdsDeducted: '48750.00' } });
  });

  it('a joiner from 1 October: six months of 2,50,000, 97,500 for the year, 16,250 a month', async () => {
    const s = await staff('250000', '2026-10-01');
    const october = await processed('2026-10', s);
    expect(await tdsOf(october, s.id)).toBe('16250.0000');
    expect(await workingsOf(october, s.id)).toMatchObject({ workings: { monthsProjected: 5, projectedAnnualSalary: '1500000.00', annualTax: '97500.00', monthsLeft: 6 } });
  });

  it('FR-039 Form 24Q working data: the quarter’s TDS per employee and month, from processed payroll only', async () => {
    const reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_report.read.amount'] });
    const q = (a: TestActor, fiscalYear: string, quarter: number) => h.call(a, 'GET', `/v1/payroll-outputs/tds-register?fiscalYear=${fiscalYear}&quarter=${quarter}`);
    expect((await q(hr, '2026-27', 1)).statusCode).toBe(403);
    expect((await q(reader, '2026-28', 1)).json().error).toBe('INVALID_FISCAL_YEAR');
    // Q1 (April to June 2026): the 2,00,000 employee's April and May (24,375 each) and the May leaver's April; the first test's April run
    // was never processed and counts for nothing, nor does the leaver's unpaid settlement.
    type Register = { from: string; to: string; totals: { employees: number; tds: string; months: { month: string; taxableSalary: string; tds: string }[] }; items: { employeeId: string; tds: string; months: unknown[] }[] };
    const q1 = await ok<Register>(await q(reader, '2026-27', 1));
    expect(q1).toMatchObject({ from: '2026-04-01', to: '2026-06-30' });
    expect(q1.totals).toEqual({
      employees: 2,
      tds: '73125.0000',
      months: [
        { month: '2026-04', taxableSalary: '400000.0000', tds: '48750.0000' },
        { month: '2026-05', taxableSalary: '200000.0000', tds: '24375.0000' },
      ],
    });
    expect(q1.items.find((i) => i.employeeId === deducted)).toMatchObject({
      tds: '48750.0000',
      months: [
        { month: '2026-04', source: 'PAYROLL', taxableSalary: '200000.0000', tds: '24375.0000' },
        { month: '2026-05', source: 'PAYROLL', taxableSalary: '200000.0000', tds: '24375.0000' },
      ],
    });
    // Q2: a July run calculated, with its TDS line, but never processed counts for nothing.
    const s = await staff('200000');
    const july = await createRun(h, preparer, periods['2026-07']!, { departmentIds: [s.dept] });
    await calculate(h, preparer, july.id);
    expect(Number(await tdsOf(july.id, s.id))).toBeGreaterThan(0);
    expect((await ok<Register>(await q(reader, '2026-27', 2))).totals).toEqual({ employees: 0, tds: '0.0000', months: [] });
    // Q3: the October joiner's 16,250. Q4 runs January to March 2027: nothing processed.
    expect((await ok<Register>(await q(reader, '2026-27', 3))).totals).toEqual({ employees: 1, tds: '16250.0000', months: [{ month: '2026-10', taxableSalary: '250000.0000', tds: '16250.0000' }] });
    expect(await ok<Register>(await q(reader, '2026-27', 4))).toMatchObject({ from: '2027-01-01', to: '2027-03-31', totals: { employees: 0, tds: '0.0000', months: [] } });
  });
});
