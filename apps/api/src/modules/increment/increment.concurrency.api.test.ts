// ZT11, ZT25, CI20: simultaneous decisions on one increment case, and on two cases of one baseline, end in one salary arrangement and
// one history row. The plan-change race is in increment-cycles line 719; a stale baseline decided one after the other is in increment
// line 206. Synthetic INR amounts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { footprintOf, raceOnKey, raceOnTransaction, statusesOf, transactionOfTask, withoutRecipients } from '../../test/race.fixtures.js';
import type { PermissionKey } from '../access/baseline.js';

let h: Harness;
let A: Company;
let preparer: TestActor;
let approver: TestActor;
let hrPlain: TestActor;
let managerEmp: string;

const FINANCE: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary', 'salary.history_read.salary', 'increment.read.salary', 'increment.history_read.salary', 'increment.propose.salary', 'increment.approve.salary'];

const employee = async () => {
  const e = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  await h.call(hrPlain, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: e.joiningDate });
  const salary = await h.call(preparer, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: e.joiningDate, monthlyGross: '100000', annualCtc: '1200000', currency: 'INR' });
  expect(salary.statusCode, salary.body).toBe(201);
  return e.id as string;
};
const offCycle = async (e: string, amount: string, counterpart: string) => {
  const res = await h.call(preparer, 'POST', '/v1/increment-cases/off-cycle', { employeeId: e, effectiveDate: '2027-06-01', proposedAmount: amount, proposedCounterpart: counterpart, reason: 'Off-cycle adjustment (synthetic)' });
  expect(res.statusCode, res.body).toBeLessThan(300);
};
const tasksOf = async (e: string) => ((await h.call(approver, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).filter((t) => t.ownerEmployeeId === e);
const decide = (taskId: string, decision: string, key = uniq('inc-key-')) => h.call(approver, 'POST', `/v1/increment-cases/tasks/${taskId}/decision`, { decision, reason: 'Independent review (synthetic)', idempotencyKey: key });
const arrangements = async (e: string) =>
  (await h.db.query<{ amount: string; to: string | null }>(`select monthly_gross::text as amount, to_char(effective_to, 'YYYY-MM-DD') as to from salary_arrangement where employee_id = $1 and superseded_at is null order by effective_from`, [e])).rows;
const histories = async (e: string) => (await h.one<{ n: number }>(`select count(*)::int as n from increment_history where employee_id = $1`, [e])).n;
const caseOfTask = async (taskId: string) => {
  const tx = await transactionOfTask(h, taskId);
  return h.one<{ id: string; state: string; applied_salary_id: string | null; transaction_id: string }>(`select id, state, applied_salary_id, transaction_id from increment_case where transaction_id = $1`, [tx]);
};
const footprint = async (taskId: string) => {
  const c = await caseOfTask(taskId);
  return withoutRecipients(await footprintOf(h, A.id, c.transaction_id, c.id));
};
const pendingOf = async (e: string) => {
  await offCycle(e, '110000', '1320000');
  return (await tasksOf(e))[0]!.taskId;
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
  // The preparer is skipped as a reviewer (C4), so every task goes to the one approver these tests act as.
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true), ($1, 'increment_case', $3, 2, true)`, [A.id, preparer.user, approver.user]);
  const m = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  managerEmp = m.id;
  await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
});

afterAll(async () => {
  await h?.stop();
});

describe('two decisions on one case', () => {
  it('approval queued first: one new arrangement, one history row, and the rejection finds the task closed', async () => {
    const aloneEmp = await employee();
    const aloneTask = await pendingOf(aloneEmp);
    expect((await decide(aloneTask, 'APPROVE')).json().state).toBe('APPLIED');

    const e = await employee();
    const taskId = await pendingOf(e);
    const [approve, reject] = await raceOnTransaction(h, await transactionOfTask(h, taskId), [() => decide(taskId, 'APPROVE'), () => decide(taskId, 'REJECT')]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(approve!.json()).toMatchObject({ state: 'APPLIED', changePercent: '10.00', replayed: false });
    expect(reject!.statusCode).toBe(409);
    expect(reject!.json().error).toBe('TASK_CLOSED');
    expect(await arrangements(e)).toEqual([
      { amount: '100000.0000', to: '2027-06-01' },
      { amount: '110000.0000', to: null },
    ]);
    expect(await histories(e)).toBe(1);
    expect(await footprint(taskId)).toEqual(await footprint(aloneTask));
  });

  it('rejection queued first: the salary stays as it was and no history is written', async () => {
    const e = await employee();
    const taskId = await pendingOf(e);
    const [reject, approve] = await raceOnTransaction(h, await transactionOfTask(h, taskId), [() => decide(taskId, 'REJECT'), () => decide(taskId, 'APPROVE')]);
    expect(reject!.statusCode, reject!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect(await arrangements(e)).toEqual([{ amount: '100000.0000', to: null }]);
    expect(await histories(e)).toBe(0);
    expect((await caseOfTask(taskId)).applied_salary_id).toBeNull();
  });

  it('the same approval sent twice with one key: both answer, the second as a replay, one arrangement', async () => {
    const e = await employee();
    const taskId = await pendingOf(e);
    const key = uniq('inc-key-');
    const results = await raceOnTransaction(h, await transactionOfTask(h, taskId), [() => decide(taskId, 'APPROVE', key), () => decide(taskId, 'APPROVE', key)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.map((r) => r.json().replayed).sort()).toEqual([false, true]);
    expect(await arrangements(e)).toHaveLength(2);
    expect(await histories(e)).toBe(1);
  });

  it('with no lock held, however the two interleave: one result and at most one arrangement', async () => {
    for (let round = 0; round < 4; round++) {
      const e = await employee();
      const taskId = await pendingOf(e);
      const results = await Promise.all([decide(taskId, 'APPROVE'), decide(taskId, 'REJECT')]);
      expect(statusesOf(results), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
      const won = results[0]!.statusCode === 200;
      expect(await arrangements(e)).toHaveLength(won ? 2 : 1);
      expect(await histories(e)).toBe(won ? 1 : 0);
    }
  });
});

describe('two cases on one baseline (ZT25 "baseline changed/stale application denied"; CI20 "same-date concurrent changes reject")', () => {
  const twoCases = async () => {
    const e = await employee();
    await offCycle(e, '110000', '1320000');
    await offCycle(e, '120000', '1440000');
    const tasks = await tasksOf(e);
    expect(tasks).toHaveLength(2);
    return { e, first: tasks[0]!.taskId, second: tasks[1]!.taskId };
  };
  const expectOneApplied = async (e: string, winner: string, loser: string, results: { statusCode: number; json(): any; body: string }[]) => {
    expect(results[0]!.statusCode, results[0]!.body).toBe(200);
    expect(results[1]!.statusCode, results[1]!.body).toBe(409);
    expect(results[1]!.json().error).toBe('STALE_BASELINE');
    expect(await arrangements(e)).toHaveLength(2);
    expect(await histories(e)).toBe(1);
    expect((await caseOfTask(winner)).state).toBe('APPLIED');
    // The refused decision is rolled back whole: the loser's case and task stay open, to be reassessed by a person.
    const lost = await caseOfTask(loser);
    expect(lost.state).toBe('SUBMITTED');
    expect(lost.applied_salary_id).toBeNull();
    expect((await footprintOf(h, A.id, lost.transaction_id, lost.id)).decisions).toBe(0);
  };

  it('both queued on the employee’s salary key: the first applies, the second is refused as stale', async () => {
    const { e, first, second } = await twoCases();
    const results = await raceOnKey(h, `salary:${e}`, [() => decide(first, 'APPROVE'), () => decide(second, 'APPROVE')]);
    await expectOneApplied(e, first, second, results);
  });

  it('the other way round', async () => {
    const { e, first, second } = await twoCases();
    const results = await raceOnKey(h, `salary:${e}`, [() => decide(second, 'APPROVE'), () => decide(first, 'APPROVE')]);
    await expectOneApplied(e, second, first, results);
  });

  it('with no lock held: one arrangement and one history row, whichever wins', async () => {
    for (let round = 0; round < 4; round++) {
      const { e, first, second } = await twoCases();
      const results = await Promise.all([decide(first, 'APPROVE'), decide(second, 'APPROVE')]);
      expect(statusesOf(results), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
      expect(await arrangements(e)).toHaveLength(2);
      expect(await histories(e)).toBe(1);
    }
  });
});
