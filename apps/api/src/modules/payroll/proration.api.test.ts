// DF05 payroll proration worked examples over HTTP (FR-031, FR-032, FR-033; DF05; BR-049). Synthetic employees,
// synthetic pay components and synthetic amounts only. Expected values are computed by hand from the DF05 rule as
// written: monthly fixed component x eligible paid calendar days / calendar days in that month (joining and leaving
// dates inclusive, each day counted once), every component rounded half-up to the currency minor unit at its output,
// totals summed from rounded components, net = earnings + reimbursements - employee deductions, employer
// contributions a separate cost.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import {
  APPROVE,
  approvedExit,
  approvedLeave,
  attendance,
  attendanceMonth,
  calculate,
  calendar,
  CONFIG,
  createRun,
  head,
  INPUT_APPROVE,
  key,
  laterArrangement,
  ok,
  person,
  PREPARE,
  record,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
  taskOf,
} from './payroll.fixtures.js';

describe.runIf(isModuleActive('payroll'))('DF05 proration and calculation (FR-032, FR-033)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let inputApprover: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let periods: Record<string, string>;

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const runFor = async (periodCode: string, departmentId: string) => createRun(h, preparer, periods[periodCode]!, { departmentIds: [departmentId] });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...PREPARE, ...SALARY] });
    inputApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INPUT_APPROVE });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    await reviewers(h, hr, 'payroll_input_batch', [inputApprover]);
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'HRA', headType: 'EARNING', basis: 'FIXED', sequence: 2 });
    await head(h, configA, configB, { code: 'CANTEEN', headType: 'DEDUCTION', basis: 'FIXED', sequence: 3 });
    await head(h, configA, configB, { code: 'EMP_INS', headType: 'EMPLOYER_CONTRIBUTION', basis: 'FIXED', sequence: 4 });
    await head(h, configA, configB, { code: 'TRAVEL_REIMB', headType: 'REIMBURSEMENT', basis: 'INPUT', sequence: 5 });
    await head(h, configA, configB, { code: 'BONUS', headType: 'EARNING', basis: 'INPUT', sequence: 6 });
    periods = (
      await calendar(h, configA, configB, [
        { code: '2026-09', start: '2026-09-01', end: '2026-09-30' },
        { code: '2026-10', start: '2026-10-01', end: '2026-10-31' },
        { code: '2026-11', start: '2026-11-01', end: '2026-11-30' },
        { code: '2026-12', start: '2026-12-01', end: '2026-12-31' },
        { code: '2027-02', start: '2027-02-01', end: '2027-02-28' },
        { code: '2028-02', start: '2028-02-01', end: '2028-02-29' },
      ])
    ).periods;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('pays a full month, keeps employer contributions out of net pay and adds approved reimbursements', async () => {
    const dept = await department('FULL');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, {
      effectiveFrom: '2026-01-05',
      monthlyGross: '42000',
      components: [
        { code: 'BASIC', amount: '30000' },
        { code: 'HRA', amount: '12000' },
        { code: 'CANTEEN', amount: '500' },
        { code: 'EMP_INS', amount: '1000' },
      ],
    });
    // An approved reimbursement input; an unapproved bonus input is ignored (FR-031: only approved inputs feed it).
    const approved = await ok<{ id: string; version: number }>(
      await h.call(preparer, 'POST', `/v1/payroll/periods/${periods['2026-09']}/input-batches`, {
        lines: [{ employeeId: e, componentCode: 'TRAVEL_REIMB', inputKind: 'OTHER_INPUT', amount: '750.00', currencyCode: 'INR', effectiveDate: '2026-09-10', reference: uniq('TRV-') }],
      }),
      201,
    );
    await ok(await h.call(preparer, 'POST', `/v1/payroll/input-batches/${approved.id}/submit`, { expectedVersion: approved.version }));
    const task = ((await h.call(inputApprover, 'GET', '/v1/payroll/input-batches/tasks/mine')).json().items as { taskId: string; batch: { id: string } }[]).find((t) => t.batch.id === approved.id)!;
    await ok(await h.call(inputApprover, 'POST', `/v1/payroll/input-tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() }));
    await ok(
      await h.call(preparer, 'POST', `/v1/payroll/periods/${periods['2026-09']}/input-batches`, {
        lines: [{ employeeId: e, componentCode: 'BONUS', inputKind: 'VARIABLE_PAYMENT', amount: '9999.00', currencyCode: 'INR', effectiveDate: '2026-09-10', reference: uniq('BON-') }],
      }),
      201,
    );

    const run = await runFor('2026-09', dept);
    expect((await calculate(h, preparer, run.id)).state).toBe('CALCULATED');
    const r = await record(h, preparer, run.id, e);
    expect(r).toMatchObject({
      calculationStatus: 'CALCULATED',
      paidUnits: '30.0000',
      earnings: '42000.0000',
      reimbursements: '750.0000',
      gross: '42750.0000',
      deductions: '500.0000',
      net: '42250.0000',
      employerContributions: '1000.0000',
    });
    expect(r.lines.map((l) => [l.componentCode, l.headType, l.amount])).toEqual([
      ['BASIC', 'EARNING', '30000.0000'],
      ['HRA', 'EARNING', '12000.0000'],
      ['CANTEEN', 'DEDUCTION', '500.0000'],
      ['EMP_INS', 'EMPLOYER_CONTRIBUTION', '1000.0000'],
      ['TRAVEL_REIMB', 'REIMBURSEMENT', '750.0000'],
    ]);
    expect(r.lines[0]!.ruleVersion).toMatch(/^HEAD:BASIC@r1$/);
  });

  it('prorates a mid-month joiner (joining date inclusive) and rounds a half-cent tie up', async () => {
    const dept = await department('JOINER');
    const joiner = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-09-16' });
    await salary(h, preparer, joiner, { effectiveFrom: '2026-09-16', monthlyGross: '42000', components: [{ code: 'BASIC', amount: '30000' }, { code: 'HRA', amount: '12000' }] });
    const tie = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-09-16' });
    await salary(h, preparer, tie, { effectiveFrom: '2026-09-16', monthlyGross: '1000.01', components: [{ code: 'BASIC', amount: '1000.01' }] });
    const run = await runFor('2026-09', dept);
    await calculate(h, preparer, run.id);
    // 16..30 September = 15 of 30 calendar days.
    expect(await record(h, preparer, run.id, joiner)).toMatchObject({ paidUnits: '15.0000', earnings: '21000.0000', net: '21000.0000' });
    // 1000.01 x 15 / 30 = 500.005 -> 500.01 (half-up, not half-even).
    expect(await record(h, preparer, run.id, tie)).toMatchObject({ earnings: '500.0100', net: '500.0100' });
  });

  it('counts the days of a mid-month salary change once, in one line', async () => {
    const dept = await department('CHANGE');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'BASIC', amount: '30000' }] });
    await laterArrangement(h, A, e, '2026-09-16', '36000', [{ code: 'BASIC', amount: '36000' }]);
    const run = await runFor('2026-09', dept);
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, e);
    expect(r.segments.map((s) => [s.segmentStart, s.segmentEnd, s.calendarDays, s.paidDays])).toEqual([
      ['2026-09-01', '2026-09-15', 15, '15.0000'],
      ['2026-09-16', '2026-09-30', 15, '15.0000'],
    ]);
    // (30000 x 15 + 36000 x 15) / 30 = 33000.00
    expect(r.lines).toEqual([expect.objectContaining({ componentCode: 'BASIC', amount: '33000.0000' })]);
    expect(r.paidUnits).toBe('30.0000');
  });

  it('treats approved unpaid leave as loss of pay on its working days, half days included', async () => {
    const dept = await department('UNPAID');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'BASIC', amount: '31000' }] });
    // Fri 9 Oct to Mon 12 Oct: two working days (the weekend is not leave), and a half day on Wed 14 Oct.
    await approvedLeave(h, A, e, 'UNPAID', '2026-10-09', '2026-10-12', '2');
    await approvedLeave(h, A, e, 'UNPAID', '2026-10-14', '2026-10-14', '0.5', true);
    // Approved paid leave is not loss of pay.
    await approvedLeave(h, A, e, 'ANNUAL', '2026-10-20', '2026-10-20', '1');
    const run = await runFor('2026-10', dept);
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, e);
    expect(r.lossOfPay.map((d) => [d.day, d.sourceKind, d.units])).toEqual([
      ['2026-10-09', 'UNPAID_LEAVE', '1.0000'],
      ['2026-10-12', 'UNPAID_LEAVE', '1.0000'],
      ['2026-10-14', 'UNPAID_LEAVE', '0.5000'],
    ]);
    // 31000 x 28.5 / 31 = 28500.00
    expect(r).toMatchObject({ paidUnits: '28.5000', earnings: '28500.0000', net: '28500.0000' });
  });

  it('rounds each component half-up at its output and sums the rounded components', async () => {
    const dept = await department('ROUNDING');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-10-25' });
    await salary(h, preparer, e, { effectiveFrom: '2026-10-25', monthlyGross: '15000', components: [{ code: 'BASIC', amount: '10000' }, { code: 'HRA', amount: '5000' }] });
    const run = await runFor('2026-10', dept);
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, e);
    // 25..31 October = 7 days: 10000 x 7 / 31 = 2258.0645 -> 2258.06; 5000 x 7 / 31 = 1129.0322 -> 1129.03;
    // the sum of the rounded components (3387.09) is not the rounded sum (3387.10).
    expect(r.lines.map((l) => l.amount)).toEqual(['2258.0600', '1129.0300']);
    expect(r).toMatchObject({ paidUnits: '7.0000', earnings: '3387.0900', net: '3387.0900' });
  });

  it('prorates a leaver to the approved last working date (inclusive)', async () => {
    const dept = await department('LEAVER');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'BASIC', amount: '30000' }] });
    await approvedExit(h, A, e, '2026-10-01', '2026-11-12');
    const run = await runFor('2026-11', dept);
    await calculate(h, preparer, run.id);
    // 1..12 November = 12 of 30 days.
    expect(await record(h, preparer, run.id, e)).toMatchObject({ paidUnits: '12.0000', earnings: '12000.0000' });
  });

  it('uses the days of the month for February, in a leap year and otherwise', async () => {
    const dept = await department('FEB');
    const leap = await person(h, A, hr, { departmentId: dept, joiningDate: '2028-02-15' });
    await salary(h, preparer, leap, { effectiveFrom: '2028-02-15', monthlyGross: '29000', components: [{ code: 'BASIC', amount: '29000' }] });
    const plain = await person(h, A, hr, { departmentId: dept, joiningDate: '2027-02-15' });
    await salary(h, preparer, plain, { effectiveFrom: '2027-02-15', monthlyGross: '29000', components: [{ code: 'BASIC', amount: '29000' }] });
    const r2028 = await runFor('2028-02', dept);
    await calculate(h, preparer, r2028.id);
    // 15..29 February 2028 = 15 of 29 days: 29000 x 15 / 29 = 15000.00.
    expect(await record(h, preparer, r2028.id, leap)).toMatchObject({ paidUnits: '15.0000', earnings: '15000.0000' });
    const r2027 = await runFor('2027-02', dept);
    await calculate(h, preparer, r2027.id);
    // 15..28 February 2027 = 14 of 28 days: 29000 x 14 / 28 = 14500.00 (the 2028 joiner is not yet employed).
    expect(await record(h, preparer, r2027.id, plain)).toMatchObject({ paidUnits: '14.0000', earnings: '14500.0000' });
    expect((await h.call(preparer, 'GET', `/v1/payroll/runs/${r2027.id}/records/${leap}`)).statusCode).toBe(404);
  });

  it('never deducts for attendance without an activated paid-day policy: absences are reported for a documented resolution', async () => {
    const dept = await department('ABSENT');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'BASIC', amount: '31000' }] });
    await attendance(h, A, e, '2026-10-05', 'ABSENT');
    await attendance(h, A, e, '2026-10-06', 'HALF_DAY');
    const run = await runFor('2026-10', dept);
    const calculated = await calculate(h, preparer, run.id);
    expect(calculated).toMatchObject({ exceptions: { blocking: 1, unresolved: 1 } });
    const r = await record(h, preparer, run.id, e);
    // BR-049 / DF05: no automatic deduction; the full month is paid and the absence needs a documented resolution.
    expect(r).toMatchObject({ paidUnits: '31.0000', earnings: '31000.0000' });
    expect(r.lossOfPay).toEqual([]);
    expect(r.exceptions.filter((x) => x.severity === 'BLOCKING')).toEqual([
      expect.objectContaining({ code: 'ATTENDANCE_NOT_VALUED', severity: 'BLOCKING', resolvable: true, detail: { days: 2, firstDate: '2026-10-05', lastDate: '2026-10-06' } }),
    ]);
    // Processing will block the payment without a verified bank instruction; the calculation already says so.
    expect(r.exceptions.filter((x) => x.severity === 'WARNING').map((x) => [x.code, x.detail])).toEqual([['BANK_INSTRUCTION_NOT_READY', { bankStatus: 'MISSING' }]]);
  });

  it('under an activated REVIEWED_ATTENDANCE policy deducts the stated units, never twice for a day with approved leave', async () => {
    const draft = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/paid-day-policies', { effectiveFrom: '2026-12-01', attendanceBasis: 'REVIEWED_ATTENDANCE', absentUnpaidUnits: '1', halfDayUnpaidUnits: '0.5' }),
      201,
    );
    expect((await h.call(configA, 'POST', `/v1/payroll/paid-day-policies/${draft.id}/activate`, { expectedVersion: draft.version })).json().error).toBe('SELF_APPROVAL');
    await ok(await h.call(configB, 'POST', `/v1/payroll/paid-day-policies/${draft.id}/activate`, { expectedVersion: draft.version }));
    const dept = await department('POLICY');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'BASIC', amount: '31000' }] });
    // Every day of December evaluated; three days need a closer look.
    await attendanceMonth(h, A, e, '2026-12-01', '2026-12-31', ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10']);
    await attendance(h, A, e, '2026-12-07', 'ABSENT');
    await attendance(h, A, e, '2026-12-08', 'HALF_DAY');
    // An ABSENT record on a day that also has approved unpaid leave counts once (as leave).
    await attendance(h, A, e, '2026-12-09', 'ABSENT');
    await approvedLeave(h, A, e, 'UNPAID', '2026-12-09', '2026-12-09', '1');
    // Late arrival is a flag only (DF05): it never reduces pay.
    await h.db.query(
      `insert into attendance_record (company_id, employee_id, work_date, policy_id, scheduled_net_minutes, worked_minutes, late, early_departure, status_id)
       select $1, $2, '2026-12-10', (select id from attendance_policy where company_id = $1 order by revision limit 1), 480, 470, true, false, s.id
         from reference_value s where s.company_id = $1 and s.category = 'ATTENDANCE_STATUS' and s.code = 'PRESENT'`,
      [A.id, e],
    );
    // Under the same policy an employee whose days were never evaluated is undetermined: reported, never guessed.
    const unevaluated = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, unevaluated, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'BASIC', amount: '31000' }] });
    await attendanceMonth(h, A, unevaluated, '2026-12-01', '2026-12-31', ['2026-12-14', '2026-12-15']);
    const run = await runFor('2026-12', dept);
    await calculate(h, preparer, run.id);
    const r = await record(h, preparer, run.id, e);
    expect(r.lossOfPay.map((d) => [d.day, d.sourceKind, d.units])).toEqual([
      ['2026-12-07', 'ATTENDANCE', '1.0000'],
      ['2026-12-08', 'ATTENDANCE', '0.5000'],
      ['2026-12-09', 'UNPAID_LEAVE', '1.0000'],
    ]);
    // 31000 x 28.5 / 31 = 28500.00
    expect(r).toMatchObject({ paidUnits: '28.5000', earnings: '28500.0000' });
    expect(r.exceptions.filter((x) => x.severity === 'BLOCKING')).toEqual([]);
    const u = await record(h, preparer, run.id, unevaluated);
    expect(u).toMatchObject({ calculationStatus: 'CALCULATED', paidUnits: '31.0000', earnings: '31000.0000' });
    expect(u.lossOfPay).toEqual([]);
    expect(u.exceptions.filter((x) => x.severity === 'BLOCKING')).toEqual([
      expect.objectContaining({ code: 'ATTENDANCE_NOT_EVALUATED', resolvable: true, detail: { days: 2, firstDate: '2026-12-14', lastDate: '2026-12-15' } }),
    ]);
  });

  it('keeps the rule set of a revision fixed for its whole calculation and verifies a rerun as identical (FR-033)', async () => {
    const dept = await department('VERIFY');
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'BASIC', amount: '31000' }, { code: 'HRA', amount: '3100' }] });
    await approvedLeave(h, A, e, 'UNPAID', '2026-10-05', '2026-10-06', '2');
    const run = await runFor('2026-10', dept);
    await calculate(h, preparer, run.id);
    const heads = await h.one<{ n: number; head_count: number }>(
      `select (select count(*)::int from payroll_run_head where run_id = r.id) as n, r.head_count from payroll_run r where r.id = $1`,
      [run.id],
    );
    expect(heads.n).toBe(heads.head_count);
    const verify = await ok<{ identical: boolean; records: number; lines: number; complete: boolean }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/verify`));
    expect(verify).toMatchObject({ identical: true, records: 1, lines: 2, complete: true });
    // The snapshot tables, not the masters, are what a rerun reads: a backdated arrangement changes nothing.
    await laterArrangement(h, A, e, '2026-10-01', '99999', [{ code: 'BASIC', amount: '99999' }]);
    expect(await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/verify`))).toMatchObject({ identical: true, lineDifferences: 0, totalDifferences: 0 });
    // Mon 5 and Tue 6 October are the two unpaid working days: (31000 + 3100) x 29 / 31 = 29000.00 + 2900.00.
    expect(await record(h, preparer, run.id, e)).toMatchObject({ paidUnits: '29.0000', earnings: '31900.0000' });
    // A stored line that no longer matches its snapshot would be reported (the database itself refuses the edit).
    await expect(h.db.query(`update payroll_line set amount = amount + 1 where record_id = (select id from payroll_record where run_id = $1)`, [run.id])).rejects.toThrow(/append-only/);
  });

  it('blocks employees whose pay cannot be determined, naming each exception, and never treats them as zero', async () => {
    // A rule-pack deduction calculated on a wage head; no pack is configured (none exists until a company supplies one).
    await head(h, configA, configB, { code: 'PF_WAGE', headType: 'EARNING', basis: 'FIXED', sequence: 19 });
    await head(h, configA, configB, { code: 'PF_EMPLOYEE', headType: 'DEDUCTION', basis: 'RULE_PACK', rulePackCode: 'PF', base: ['PF_WAGE'], sequence: 20 });
    const dept = await department('BLOCKED');
    const rulePack = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, rulePack, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'BASIC', amount: '30000' }, { code: 'PF_EMPLOYEE', amount: '0' }] });
    // The pack applies through its base even when the arrangement does not list the rule-pack head itself.
    const packBase = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, packBase, { effectiveFrom: '2026-01-05', monthlyGross: '15000', components: [{ code: 'PF_WAGE', amount: '15000' }] });
    const noSalary = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    const unknownHead = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await ok(await h.call(configA, 'POST', '/v1/payroll/components', { code: 'MYSTERY', name: 'Unclassified (synthetic)', componentKind: 'EARNING' }), 201);
    await salary(h, preparer, unknownHead, { effectiveFrom: '2026-01-05', monthlyGross: '100', components: [{ code: 'MYSTERY', amount: '100' }] });
    const annual = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, annual, { effectiveFrom: '2026-01-05', monthlyGross: '0', annualCtc: '120000', components: [{ code: 'BASIC', amount: '120000', basis: 'ANNUAL' }] });
    const negative = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, negative, { effectiveFrom: '2026-01-05', monthlyGross: '100', components: [{ code: 'BASIC', amount: '100' }, { code: 'CANTEEN', amount: '500' }] });
    const gap = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, gap, { effectiveFrom: '2026-10-10', monthlyGross: '31000', components: [{ code: 'BASIC', amount: '31000' }] });
    const fine = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, fine, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'BASIC', amount: '31000' }] });

    const run = await runFor('2026-10', dept);
    const calculated = await calculate(h, preparer, run.id);
    expect(calculated.records).toEqual({ CALCULATED: 2, FAILED: 6 });
    const codes = async (e: string) => (await record(h, preparer, run.id, e)).exceptions.map((x) => x.code);
    expect(await codes(rulePack)).toEqual(['RULE_PACK_NOT_CONFIGURED']);
    expect((await record(h, preparer, run.id, rulePack)).exceptions[0]!.detail).toEqual({ componentCode: 'PF_EMPLOYEE', rulePackCode: 'PF' });
    expect(await codes(packBase)).toEqual(['RULE_PACK_NOT_CONFIGURED']);
    expect((await record(h, preparer, run.id, packBase)).exceptions[0]!.detail).toEqual({ componentCode: 'PF_EMPLOYEE', rulePackCode: 'PF' });
    expect(await codes(noSalary)).toEqual(['NO_SALARY_ARRANGEMENT']);
    expect(await codes(unknownHead)).toEqual(['HEAD_NOT_CONFIGURED']);
    expect(await codes(annual)).toEqual(['COMPONENT_BASIS_NOT_MONTHLY']);
    expect(await codes(gap)).toEqual(['ARRANGEMENT_GAP']);
    for (const e of [rulePack, packBase, noSalary, unknownHead, annual, gap]) {
      const r = await record(h, preparer, run.id, e);
      expect(r).toMatchObject({ calculationStatus: 'FAILED', net: null, earnings: null });
      expect(r.lines).toEqual([]);
    }
    // A negative net is calculated but blocked: no automatic negative salary (H2) without a recovery policy.
    expect(await record(h, preparer, run.id, negative)).toMatchObject({ calculationStatus: 'CALCULATED', net: '-400.0000', exceptions: [expect.objectContaining({ code: 'NEGATIVE_NET' })] });

    // FR-033: the failures block approval for the affected employees; a note cannot resolve them.
    await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: calculated.version }));
    await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${await taskOf(h, reviewer, run.id, 'REVIEW')}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
    const approvalTask = await taskOf(h, approver, run.id, 'APPROVAL');
    const refused = await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() });
    expect(refused.json().error).toBe('EXCEPTIONS_UNRESOLVED');
    expect((refused.json().details.exceptions as { code: string }[]).map((x) => x.code)).toEqual(
      expect.arrayContaining(['RULE_PACK_NOT_CONFIGURED', 'NEGATIVE_NET', 'NO_SALARY_ARRANGEMENT', 'HEAD_NOT_CONFIGURED', 'COMPONENT_BASIS_NOT_MONTHLY', 'ARRANGEMENT_GAP']),
    );
    const failure = (await record(h, approver, run.id, rulePack)).exceptions[0]!;
    expect((await h.call(approver, 'POST', `/v1/payroll/runs/${run.id}/exceptions/${failure.id}/resolve`, { resolution: 'Synthetic note' })).json().error).toBe('NOT_RESOLVABLE');
    // Returned without them, the unaffected employee proceeds in the next revision.
    const blocked = [rulePack, packBase, noSalary, unknownHead, annual, negative, gap];
    const returned = await ok<{ state: string; nextRunId: string }>(
      await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, {
        decision: 'RETURN',
        reason: 'Exclude the employees whose pay cannot be determined (synthetic)',
        excludeEmployeeIds: blocked,
        idempotencyKey: key(),
      }),
    );
    expect(returned.state).toBe('RETURNED');
    const next = await calculate(h, preparer, returned.nextRunId);
    expect(next).toMatchObject({ revision: 2, records: { CALCULATED: 1 }, exceptions: { blocking: 0 } });
    expect(await record(h, preparer, returned.nextRunId, fine)).toMatchObject({ net: '31000.0000' });
    expect(await submitAndApprove(h, { preparer, reviewer, approver }, returned.nextRunId)).toMatchObject({ state: 'APPROVED' });
  });
});
