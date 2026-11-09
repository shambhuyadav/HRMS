// Increment cycles, independent approval, atomic application, history and annual growth
// (FR-089-FR-093; BR-038-BR-041; DF14; DF15; CI20; CI21; ZT25; ZT26). Synthetic INR amounts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import type { PermissionKey } from '../access/baseline.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { CONFIG, head } from '../payroll/payroll.fixtures.js';

let h: Harness;
let A: Company;
let hr1: TestActor;
let hr2: TestActor;
let hrPlain: TestActor;
let manager: TestActor;
let managerEmp: string;
let cycleId: string;
const emp: Record<string, string> = {};

const FINANCE_GRANTS: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary', 'salary.history_read.salary', 'increment.read.salary', 'increment.history_read.salary', 'increment.propose.salary', 'increment.approve.salary'];

async function employee(status: string, opts: { joiningDate?: string; salary?: [string, string] } = {}): Promise<string> {
  const e = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A, opts.joiningDate ? { joiningDate: opts.joiningDate } : {}))).json();
  await h.setStatus(A, e.id, status);
  await h.call(hrPlain, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: e.joiningDate });
  if (opts.salary) {
    const res = await h.call(hr1, 'POST', `/v1/employees/${e.id}/salary`, {
      effectiveFrom: e.joiningDate,
      monthlyGross: opts.salary[0],
      annualCtc: opts.salary[1],
      currency: 'INR',
    });
    expect(res.statusCode).toBe(201);
  }
  return e.id;
}

const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[];
const taskFor = async (a: TestActor, employeeId: string) => (await tasks(a)).find((t) => t.ownerEmployeeId === employeeId);
const decide = (a: TestActor, taskId: string, decision: string, key = uniq('inc-key-')) =>
  h.call(a, 'POST', `/v1/increment-cases/tasks/${taskId}/decision`, { decision, reason: 'Independent review (synthetic)', idempotencyKey: key });
const caseOf = async (employeeId: string, occurrence: string) =>
  ((await h.call(hr1, 'GET', '/v1/increment-cases')).json().items as { id: string; employeeId: string; occurrence: string; state: string; version: number }[]).find(
    (c) => c.employeeId === employeeId && c.occurrence === occurrence,
  )!;
const offCycle = (a: TestActor, employeeId: string, effectiveDate: string, amount: string, counterpart: string) =>
  h.call(a, 'POST', '/v1/increment-cases/off-cycle', { employeeId, effectiveDate, proposedAmount: amount, proposedCounterpart: counterpart, reason: 'Off-cycle adjustment (synthetic)' });
const arrangements = async (employeeId: string) => (await h.call(hr1, 'GET', `/v1/employees/${employeeId}/salary`)).json().items as { effectiveFrom: string; effectiveTo: string | null; monthlyGross: string }[];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE_GRANTS });
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE_GRANTS });
  hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(
    `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true), ($1, 'increment_case', $3, 2, true)`,
    [A.id, hr1.user, hr2.user],
  );
  const m = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  managerEmp = m.id;
  await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp, extra: ['increment.propose.salary', 'increment.read.salary'] });
  cycleId = (await h.call(hr1, 'GET', '/v1/increment-cycles')).json().items[0].id;

  emp.E1 = await employee('ACTIVE_CONFIRMED', { salary: ['100000', '1200000'] });
  emp.lateJoiner = await employee('ACTIVE_CONFIRMED', { joiningDate: '2026-10-15', salary: ['80000', '960000'] });
  emp.probation = await employee('ACTIVE_PROBATION', { salary: ['70000', '840000'] });
  emp.notice = await employee('NOTICE', { salary: ['70000', '840000'] });
  emp.noSalary = await employee('ACTIVE_CONFIRMED');
});

afterAll(async () => {
  await h?.stop();
});

describe('cycle roster (FR-091, DF15, BR-040)', () => {
  it('opens cases for eligible employees only and explains every exclusion; reruns add nothing', async () => {
    // NFR-S09: the opening is a queued bulk job; the helper enqueues it (202), runs the worker and returns the job. Its
    // result holds counts; the employees it excluded are read from the opening's exclusions.
    const job = await h.runBulkJob(hr1, `/v1/increment-cycles/${cycleId}/reviews`, { year: 2027 });
    expect(job.result).toMatchObject({ occurrence: 'ANNUAL:2027', effectiveDate: '2027-04-01', cutoffDate: '2026-09-30', created: 1 });
    const exclusions = (await h.call(hr1, 'GET', `/v1/increment-review-openings/${job.id}/exclusions`)).json().items as { employeeId: string; reason: string }[];
    expect(exclusions).toHaveLength(job.result.excluded);
    const reasons = Object.fromEntries(exclusions.map((x) => [x.employeeId, x.reason]));
    expect(reasons[emp.lateJoiner!]).toBe('JOINED_AFTER_CUTOFF');
    expect(reasons[emp.probation!]).toBe('NOT_CONFIRMED');
    expect(reasons[emp.notice!]).toBe('ON_NOTICE');
    expect(reasons[emp.noSalary!]).toBe('NO_SALARY_BASELINE');

    const again = await h.runBulkJob(hr1, `/v1/increment-cycles/${cycleId}/reviews`, { year: 2027 });
    expect(again.result.created).toBe(0);
    expect((await h.call(hr1, 'GET', `/v1/increment-review-openings/${again.id}/cases`)).json().items).toEqual([]);
    const repeated = (await h.call(hr1, 'GET', `/v1/increment-review-openings/${again.id}/exclusions`)).json().items;
    expect(repeated).toContainEqual(expect.objectContaining({ employeeId: emp.E1, reason: 'ALREADY_IN_REVIEW' }));
  });

  it('a due review is not a raise: no salary changes until an approved decision', async () => {
    expect((await caseOf(emp.E1!, 'ANNUAL:2027')).state).toBe('DRAFT');
    expect(await arrangements(emp.E1!)).toHaveLength(1);
  });

  it('amounts are visible only with the salary field grant (BR-044)', async () => {
    const plain = (await h.call(hrPlain, 'GET', '/v1/increment-cases')).json().items[0];
    expect(plain).toHaveProperty('state');
    expect(plain).not.toHaveProperty('baselineAmount');
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: emp.E1! });
    expect((await h.call(self, 'GET', `/v1/employees/${emp.E1}/increment-history`)).statusCode).toBe(403);
    expect((await h.call(hrPlain, 'GET', `/v1/employees/${emp.E1}/salary`)).statusCode).toBe(403);
  });
});

describe('proposal, independent approval and application (BR-041, CI20, ZT25)', () => {
  it('manager proposes, the preparer is skipped, an independent HR approves and the change applies once', async () => {
    const c = await caseOf(emp.E1!, 'ANNUAL:2027');
    const res = await h.call(manager, 'POST', `/v1/increment-cases/${c.id}/proposal`, {
      expectedVersion: c.version,
      outcome: 'INCREASE',
      proposedAmount: '110000',
      proposedCounterpart: '1320000',
      reason: 'Strong year (synthetic)',
    });
    expect(res.statusCode).toBe(200);
    expect(await taskFor(hr1, emp.E1!)).toBeUndefined(); // hr1 opened the roster (preparer)
    const task = await taskFor(hr2, emp.E1!);
    expect(task).toBeDefined();

    const key = uniq('inc-key-');
    const applied = (await decide(hr2, task!.taskId, 'APPROVE', key)).json();
    expect(applied).toMatchObject({ state: 'APPLIED', changePercent: '10.00', replayed: false });
    expect((await decide(hr2, task!.taskId, 'APPROVE', key)).json()).toMatchObject({ replayed: true });

    const salary = await arrangements(emp.E1!);
    expect(salary).toMatchObject([
      { monthlyGross: '100000.0000', effectiveTo: '2027-04-01' },
      { monthlyGross: '110000.0000', effectiveFrom: '2027-04-01', effectiveTo: null },
    ]);
  });

  it('off-cycle change by one HR is approved by the other (DF15)', async () => {
    const res = await offCycle(hr2, emp.E1!, '2027-10-01', '121000', '1452000');
    expect(res.statusCode).toBe(201);
    expect(await taskFor(hr2, emp.E1!)).toBeUndefined();
    const task = await taskFor(hr1, emp.E1!);
    expect((await decide(hr1, task!.taskId, 'APPROVE')).json()).toMatchObject({ state: 'APPLIED', changePercent: '10.00' });
  });

  it('ZT26: 100000 -> 110000 -> 121000 is two 10% increments and 21% annual growth, not 20%', async () => {
    const annual = (await h.call(hr1, 'GET', `/v1/employees/${emp.E1}/annual-increment?financialYear=2027`)).json();
    expect(annual).toMatchObject({
      periodStart: '2027-04-01',
      periodEnd: '2028-03-31',
      opening: '100000.0000',
      closing: '121000.0000',
      currency: 'INR',
      annualGrowthPercent: '21.00',
      percentNaReason: null,
    });
    expect(annual.changes.map((c: { changePercent: string }) => c.changePercent)).toEqual(['10.00', '10.00']);
    const history = (await h.call(hr1, 'GET', `/v1/employees/${emp.E1}/increment-history`)).json().items;
    expect(history.map((x: { changeAmount: string }) => x.changeAmount)).toEqual(['10000.0000', '11000.0000']);
    // The approver's free-text reason is its own confidential group: hidden with the salary grant alone ...
    expect(history.every((x: object) => !('reason' in x))).toBe(true);
    // ... and shown only with an approved increment reason grant (DF02).
    const reasonReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['increment.history_read.salary', 'increment.read.reason'] });
    const withReasons = (await h.call(reasonReader, 'GET', `/v1/employees/${emp.E1}/increment-history`)).json().items;
    expect(withReasons.every((x: { reason?: string }) => typeof x.reason === 'string' && x.reason.length > 0)).toBe(true);
  });

  it('an exit approved while a case is pending stops its application before the last working date; rejecting stays open (DF15)', async () => {
    const approvedExit = async (employeeId: string, lastDay: string) => {
      await h.db.query('begin');
      try {
        const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [A.id, employeeId]);
        const x = await h.one<{ id: string }>(
          `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
           values ($1, $2, $3, 'RESIGNATION', '2027-01-04', $4, $4, 'SUBMITTED') returning id`,
          [A.id, employeeId, bt.id, lastDay],
        );
        await h.db.query(`update business_transaction set state = 'RECOMMENDED' where id = $1`, [bt.id]);
        await h.db.query(`update exit_case set state = 'RECOMMENDED', recommended_leaving_date = $2, recommended_at = now() where id = $1`, [x.id, lastDay]);
        await h.db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [bt.id]);
        await h.db.query(`update exit_case set state = 'APPROVED', approved_leaving_date = $2, approved_at = now(), prior_status_code = 'ACTIVE_CONFIRMED' where id = $1`, [x.id, lastDay]);
        await h.db.query('commit');
      } catch (err) {
        await h.db.query('rollback');
        throw err;
      }
    };
    const leaver = await employee('ACTIVE_CONFIRMED', { salary: ['50000', '600000'] });
    await offCycle(hr2, leaver, '2027-06-01', '55000', '660000');
    await approvedExit(leaver, '2027-05-31');
    const task = (await tasks(hr1)).find((t) => t.ownerEmployeeId === leaver)!;
    const refused = await decide(hr1, task.taskId, 'APPROVE');
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('SEPARATION_BEFORE_EFFECTIVE_DATE');
    expect(await arrangements(leaver)).toHaveLength(1);
    expect((await decide(hr1, task.taskId, 'REJECT')).json().state).toBe('REJECTED');

    // Effective on the inclusive last working date itself: still in service.
    const lastDay = await employee('ACTIVE_CONFIRMED', { salary: ['50000', '600000'] });
    await offCycle(hr2, lastDay, '2027-06-01', '55000', '660000');
    await approvedExit(lastDay, '2027-06-01');
    const same = (await tasks(hr1)).find((t) => t.ownerEmployeeId === lastDay)!;
    expect((await decide(hr1, same.taskId, 'APPROVE')).json().state).toBe('APPLIED');
  });

  it('a baseline that changed while a case was pending blocks stale application', async () => {
    const e = await employee('ACTIVE_CONFIRMED', { salary: ['50000', '600000'] });
    await offCycle(hr2, e, '2027-06-01', '55000', '660000');
    await offCycle(hr2, e, '2027-06-01', '60000', '720000');
    const [first, second] = (await tasks(hr1)).filter((t) => t.ownerEmployeeId === e);
    expect((await decide(hr1, first!.taskId, 'APPROVE')).json().state).toBe('APPLIED');
    const stale = await decide(hr1, second!.taskId, 'APPROVE');
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('STALE_BASELINE');
    expect(await arrangements(e)).toHaveLength(2);
  });

  it('no-change and rejected outcomes create no salary revision', async () => {
    await h.runBulkJob(hr1, `/v1/increment-cycles/${cycleId}/reviews`, { year: 2028 });
    const c = await caseOf(emp.E1!, 'ANNUAL:2028');
    await h.call(manager, 'POST', `/v1/increment-cases/${c.id}/proposal`, { expectedVersion: c.version, outcome: 'NO_CHANGE', reason: 'Recently revised (synthetic)' });
    expect((await decide(hr2, (await taskFor(hr2, emp.E1!))!.taskId, 'APPROVE')).json().state).toBe('NO_CHANGE');

    await offCycle(hr2, emp.E1!, '2028-01-01', '200000', '2400000');
    expect((await decide(hr1, (await taskFor(hr1, emp.E1!))!.taskId, 'REJECT')).json().state).toBe('REJECTED');
    expect(await arrangements(emp.E1!)).toHaveLength(3);
  });

  it('zero baseline gives N/A with a reason instead of a division error (DF14)', async () => {
    const e = await employee('ACTIVE_CONFIRMED', { salary: ['0', '0'] });
    await offCycle(hr2, e, '2027-05-01', '50000', '600000');
    expect((await decide(hr1, (await taskFor(hr1, e))!.taskId, 'APPROVE')).json()).toMatchObject({ state: 'APPLIED', changePercent: null, percentNaReason: 'ZERO_BASELINE' });
    const annual = (await h.call(hr1, 'GET', `/v1/employees/${e}/annual-increment?financialYear=2027`)).json();
    expect(annual).toMatchObject({ annualGrowthPercent: null, percentNaReason: 'ZERO_BASELINE' });
  });

  it('only the direct manager proposes; the database refuses a preparer-applied history row', async () => {
    const other = await h.actor(A, 'REPORTING_MANAGER', { employeeId: emp.noSalary!, extra: ['increment.propose.salary'] });
    const c = await caseOf(emp.E1!, 'ANNUAL:2028');
    const res = await h.call(other, 'POST', `/v1/increment-cases/${c.id}/proposal`, { expectedVersion: c.version, outcome: 'DEFER', reason: 'x' });
    expect([403, 404]).toContain(res.statusCode);

    const row = await h.one<{ case_id: string; prepared_by: string }>(
      `select h.case_id, c.prepared_by from increment_history h join increment_case c on c.id = h.case_id where h.employee_id = $1 limit 1`,
      [emp.E1],
    );
    await expect(
      h.db.query(
        `insert into increment_history (company_id, employee_id, case_id, approval_decision_id, old_salary_id, new_salary_id, effective_date,
                                        compensation_basis, currency_code, before_amount, after_amount, change_amount, change_percent, reason, applied_by)
         select company_id, employee_id, $1, approval_decision_id, old_salary_id, new_salary_id, effective_date, compensation_basis, currency_code,
                before_amount, after_amount, change_amount, change_percent, 'x', $2 from increment_history where case_id = $1`,
        [row.case_id, row.prepared_by],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});

describe('approved component breakdown becomes the components of the new arrangement (FR-092, DB104)', () => {
  type Line = { componentCode: string; amount: string; basis: 'MONTHLY' | 'ANNUAL' };
  const comp: Record<string, string> = {};
  const line = (componentCode: string, amount: string, basis: 'MONTHLY' | 'ANNUAL' = 'MONTHLY'): Line => ({ componentCode, amount, basis });
  const offCycleWith = (a: TestActor, employeeId: string, effectiveDate: string, amount: string, counterpart: string, components: Line[]) =>
    h.call(a, 'POST', '/v1/increment-cases/off-cycle', { employeeId, effectiveDate, proposedAmount: amount, proposedCounterpart: counterpart, reason: 'Off-cycle adjustment (synthetic)', components });
  /** Components of the employee's open-ended arrangement, as payroll reads them. */
  const componentsOf = async (employeeId: string) =>
    (
      await h.db.query<{ code: string; amount: string; basis: string }>(
        `select pc.code, sc.amount::text as amount, sc.basis
           from salary_arrangement sa
           join salary_component sc on sc.company_id = sa.company_id and sc.salary_arrangement_id = sa.id
           join pay_component pc on pc.company_id = sc.company_id and pc.id = sc.component_id
          where sa.employee_id = $1 and sa.effective_to is null order by pc.code`,
        [employeeId],
      )
    ).rows;
  type Listed = { id: string; components?: unknown };
  const listed = async (a: TestActor, caseId: string) => ((await h.call(a, 'GET', '/v1/increment-cases')).json().items as Listed[]).find((c) => c.id === caseId)!;

  beforeAll(async () => {
    for (const [code, active] of [['BASIC', true], ['HRA', true], ['RETIRED', false]] as const) {
      comp[code] = (
        await h.one<{ id: string }>(`insert into pay_component (company_id, code, name, component_kind, active) values ($1, $2, $3, 'EARNING', $4) returning id`, [
          A.id,
          code,
          `${code} (synthetic)`,
          active,
        ])
      ).id;
    }
  });

  it('an increase with a breakdown applies exactly the approved components with the arrangement, once', async () => {
    const e = await employee('ACTIVE_CONFIRMED', { salary: ['50000', '600000'] });
    const base = (await h.one<{ id: string }>(`select id from salary_arrangement where employee_id = $1`, [e])).id;
    await h.db.query(`insert into salary_component (company_id, salary_arrangement_id, component_id, amount, basis) values ($1, $2, $3, 30000, 'MONTHLY'), ($1, $2, $4, 20000, 'MONTHLY')`, [
      A.id,
      base,
      comp.BASIC,
      comp.HRA,
    ]);
    for (const [components, error] of [
      [[line('NOPE', '1')], 'UNKNOWN_COMPONENT'],
      [[line('RETIRED', '1')], 'UNKNOWN_COMPONENT'],
      [[line('BASIC', '1'), line('BASIC', '2')], 'DUPLICATE_COMPONENT'],
    ] as const) {
      const bad = await offCycleWith(hr2, e, '2027-07-01', '55000', '660000', [...components]);
      expect(bad.statusCode).toBe(422);
      expect(bad.json().error).toBe(error);
    }
    expect(await taskFor(hr1, e)).toBeUndefined(); // refused proposals leave nothing behind

    const res = await offCycleWith(hr2, e, '2027-07-01', '55000', '660000', [line('BASIC', '33000.5'), line('HRA', '21999.5000')]);
    expect(res.statusCode).toBe(201);
    const caseId = res.json().caseId as string;
    // The approver sees the breakdown with the salary grant; an operational reader does not.
    expect((await listed(hr1, caseId)).components).toEqual([
      { componentCode: 'BASIC', basis: 'MONTHLY', beforeAmount: '30000.0000', proposedAmount: '33000.5000', approvedAmount: null },
      { componentCode: 'HRA', basis: 'MONTHLY', beforeAmount: '20000.0000', proposedAmount: '21999.5000', approvedAmount: null },
    ]);
    expect(await listed(hrPlain, caseId)).not.toHaveProperty('components');

    const task = await taskFor(hr1, e);
    const key = uniq('inc-key-');
    expect((await decide(hr1, task!.taskId, 'APPROVE', key)).json()).toMatchObject({ state: 'APPLIED', componentsApplied: 2 });
    expect((await decide(hr1, task!.taskId, 'APPROVE', key)).json()).toMatchObject({ replayed: true });
    expect(await componentsOf(e)).toEqual([
      { code: 'BASIC', amount: '33000.5000', basis: 'MONTHLY' },
      { code: 'HRA', amount: '21999.5000', basis: 'MONTHLY' },
    ]);
    expect((await listed(hr1, caseId)).components).toMatchObject([{ approvedAmount: '33000.5000' }, { approvedAmount: '21999.5000' }]);
    // The baseline keeps its own components; the proposal record is final.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from salary_component where salary_arrangement_id = $1`, [base])).n).toBe(2);
    await expect(h.db.query(`update increment_component set proposed_amount = 1 where case_id = $1`, [caseId])).rejects.toMatchObject({ code: '23514' });
  });

  // I-80 (decided under owner delegation, 6 Nov 2026): for an employee whose grade has a salary structure in force, the approved
  // breakdown is the structure's derivation of the new annual CTC, or approval is refused (STRUCTURE_MISMATCH) and nothing applies.
  it('FR-028/029: a graded employee’s approved breakdown must be the grade structure’s derivation of the new CTC', async () => {
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    await head(h, configA, configB, { code: 'BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'HRA', headType: 'EARNING', basis: 'FIXED', sequence: 2 });
    const grade = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active) values ($1, 'INC_GS', 'Structured (synthetic)', true) returning id`, [A.id])).id;
    // BASIC 50% of the monthly CTC, HRA the balance: 6,60,000 a year is 55,000 a month, 27,500 each.
    const structure = (
      await h.one<{ id: string }>(
        `insert into grade_salary_structure (company_id, grade_id, revision, effective_from, currency_code, created_by, updated_by) values ($1, $2, 1, '2020-01-01', 'INR', $3, $3) returning id`,
        [A.id, grade, hr1.user],
      )
    ).id;
    await h.db.query(
      `insert into grade_salary_structure_line (company_id, structure_id, sequence, component_id, method, percent, created_by)
       values ($1, $2, 1, $3, 'PERCENT_OF_CTC', 50, $5), ($1, $2, 2, $4, 'BALANCE', null, $5)`,
      [A.id, structure, comp.BASIC, comp.HRA, hr1.user],
    );
    await h.db.query(`update grade_salary_structure set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [structure, hr2.user]);
    const graded = async () => {
      const e = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A, { gradeId: grade }))).json();
      await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
      await h.call(hrPlain, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: e.joiningDate });
      expect((await h.call(hr1, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: e.joiningDate, monthlyGross: '50000', annualCtc: '600000', currency: 'INR' })).statusCode).toBe(201);
      return e.id as string;
    };
    const off = await graded();
    expect((await offCycleWith(hr2, off, '2027-07-01', '55000', '660000', [line('BASIC', '30000'), line('HRA', '25000')])).statusCode).toBe(201);
    const refused = await decide(hr1, (await taskFor(hr1, off))!.taskId, 'APPROVE');
    expect([refused.statusCode, refused.json().error, refused.json().details?.components]).toEqual([
      422,
      'STRUCTURE_MISMATCH',
      [
        { componentCode: 'BASIC', amount: '27500.0000', basis: 'MONTHLY' },
        { componentCode: 'HRA', amount: '27500.0000', basis: 'MONTHLY' },
      ],
    ]);
    // Nothing applied: the case still waits, and no new arrangement exists.
    expect(await taskFor(hr1, off)).toBeDefined();
    expect((await h.one<{ n: number }>(`select count(*)::int as n from salary_arrangement where employee_id = $1`, [off])).n).toBe(1);
    const on = await graded();
    expect((await offCycleWith(hr2, on, '2027-07-01', '55000', '660000', [line('BASIC', '27500'), line('HRA', '27500')])).statusCode).toBe(201);
    expect((await decide(hr1, (await taskFor(hr1, on))!.taskId, 'APPROVE')).json()).toMatchObject({ state: 'APPLIED', componentsApplied: 2 });
    expect(await componentsOf(on)).toEqual([
      { code: 'BASIC', amount: '27500.0000', basis: 'MONTHLY' },
      { code: 'HRA', amount: '27500.0000', basis: 'MONTHLY' },
    ]);
  });

  it('a returned proposal is proposed again with its own breakdown: only the approved proposal applies', async () => {
    const e = await employee('ACTIVE_CONFIRMED', { joiningDate: '2025-01-15', salary: ['40000', '480000'] });
    expect((await h.runBulkJob(hr1, `/v1/increment-cycles/${cycleId}/reviews`, { year: 2027 })).state).toBe('COMPLETED');
    let c = await caseOf(e, 'ANNUAL:2027');
    const proposal = (body: Record<string, unknown>) =>
      h.call(manager, 'POST', `/v1/increment-cases/${c.id}/proposal`, { expectedVersion: c.version, reason: 'Annual review (synthetic)', ...body });
    const increase = { outcome: 'INCREASE', proposedAmount: '44000', proposedCounterpart: '528000' };

    const noChange = await proposal({ outcome: 'NO_CHANGE', components: [line('BASIC', '40000')] });
    expect(noChange.statusCode).toBe(422);
    expect(noChange.json().error).toBe('RULE_VIOLATION');
    expect((await proposal({ ...increase, components: [line('BASIC', '30000'), line('HRA', '14000')] })).statusCode).toBe(200);
    expect((await decide(hr2, (await taskFor(hr2, e))!.taskId, 'RETURN')).json().state).toBe('RETURNED');

    c = await caseOf(e, 'ANNUAL:2027');
    expect((await proposal({ ...increase, components: [line('BASIC', '528000', 'ANNUAL')] })).statusCode).toBe(200);
    // The baseline has no components: the before amount is unknown, never assumed to be zero.
    expect((await listed(hr2, c.id)).components).toEqual([{ componentCode: 'BASIC', basis: 'ANNUAL', beforeAmount: null, proposedAmount: '528000.0000', approvedAmount: null }]);
    expect((await decide(hr2, (await taskFor(hr2, e))!.taskId, 'APPROVE')).json()).toMatchObject({ state: 'APPLIED', componentsApplied: 1 });
    expect(await componentsOf(e)).toEqual([{ code: 'BASIC', amount: '528000.0000', basis: 'ANNUAL' }]);
  });

  it('a case without a breakdown leaves the new arrangement without components, as before', async () => {
    const e = await employee('ACTIVE_CONFIRMED', { salary: ['45000', '540000'] });
    expect((await offCycle(hr2, e, '2027-08-01', '47000', '564000')).statusCode).toBe(201);
    expect((await decide(hr1, (await taskFor(hr1, e))!.taskId, 'APPROVE')).json()).toMatchObject({ state: 'APPLIED', componentsApplied: 0 });
    expect(await componentsOf(e)).toEqual([]);
  });
});
