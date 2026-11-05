// ZT11, ZT22: simultaneous decisions on one confirmation task and on one confirmation exception end in one result: one status change,
// one confirmed date and, for an exception, one applied due date or extension. A cancellation against a decision and an exit against
// a decision are closure.api.test.ts. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { footprintOf, raceOnRow, raceOnTransaction, statusesOf, transactionOfTask, withoutRecipients } from '../../test/race.fixtures.js';
import { statusOf } from '../lifecycle/lifecycle.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hr2: TestActor;
let hr3: TestActor;
let manager: TestActor;
let managerEmp: string;
let today: string;

const probationer = async () => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: '2026-01-31' }))).json();
  await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
  await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: e.joiningDate });
  return e.id as string;
};
const open = async (emp: string) => {
  const res = await h.call(hr, 'POST', '/v1/confirmations', { employeeId: emp });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().caseId as string;
};
const getCase = async (id: string) => (await h.call(hr, 'GET', `/v1/confirmations/${id}`)).json();
const caseRow = (id: string) =>
  h.one<{ state: string; actual: string | null; due: string; extra: number; transaction_id: string }>(
    `select state, to_char(actual_confirmation_date, 'YYYY-MM-DD') as actual, to_char(current_due_date, 'YYYY-MM-DD') as due, extra_extensions as extra, transaction_id from employee_confirmation where id = $1`,
    [id],
  );
const hrTask = async (emp: string) => ((await h.call(hr, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === emp)!;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
  hr3 = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true)`, [A.id, hr.user]);
  const m = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  managerEmp = m.id;
  await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
});

afterAll(async () => {
  await h?.stop();
});

describe('two decisions on one confirmation task', () => {
  const pendingDecision = async () => {
    const emp = await probationer();
    const caseId = await open(emp);
    const res = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: (await getCase(caseId)).version, reason: 'Manager review (synthetic)', recommendation: 'CONFIRM', effectiveDate: today });
    expect(res.statusCode, res.body).toBe(200);
    return { emp, caseId, taskId: (await hrTask(emp)).taskId };
  };
  const decide = (taskId: string, decision: string, key = uniq('conf-key-')) => h.call(hr, 'POST', `/v1/confirmations/tasks/${taskId}/decision`, { decision, reason: 'HR decision (synthetic)', idempotencyKey: key });
  const confirmations = async (emp: string) => (await h.one<{ n: number }>(`select count(*)::int as n from employee_status_history where employee_id = $1 and source_kind = 'CONFIRMATION'`, [emp])).n;
  const footprint = async (caseId: string) => withoutRecipients(await footprintOf(h, A.id, (await caseRow(caseId)).transaction_id, caseId));

  it('approval queued first: confirmed once, one status change, and the rejection finds the task closed', async () => {
    const alone = await pendingDecision();
    expect((await decide(alone.taskId, 'APPROVE')).statusCode).toBe(200);

    const d = await pendingDecision();
    const [approve, reject] = await raceOnTransaction(h, await transactionOfTask(h, d.taskId), [() => decide(d.taskId, 'APPROVE'), () => decide(d.taskId, 'REJECT')]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(reject!.statusCode).toBe(409);
    expect(await caseRow(d.caseId)).toMatchObject({ state: 'CONFIRMED', actual: today });
    expect(await statusOf(h, d.emp)).toBe('ACTIVE_CONFIRMED');
    expect(await confirmations(d.emp)).toBe(1);
    expect(await footprint(d.caseId)).toEqual(await footprint(alone.caseId));
  });

  it('rejection queued first: the employee stays on probation, with no confirmed date', async () => {
    const d = await pendingDecision();
    const [reject, approve] = await raceOnTransaction(h, await transactionOfTask(h, d.taskId), [() => decide(d.taskId, 'REJECT'), () => decide(d.taskId, 'APPROVE')]);
    expect(reject!.statusCode, reject!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect((await caseRow(d.caseId)).actual).toBeNull();
    expect(await statusOf(h, d.emp)).toBe('ACTIVE_PROBATION');
    expect(await confirmations(d.emp)).toBe(0);
  });

  it('the same approval sent twice with one key: both answer, one effect', async () => {
    const d = await pendingDecision();
    const key = uniq('conf-key-');
    const results = await raceOnTransaction(h, await transactionOfTask(h, d.taskId), [() => decide(d.taskId, 'APPROVE', key), () => decide(d.taskId, 'APPROVE', key)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.map((r) => r.json().replayed).sort()).toEqual([false, true]);
    expect(await confirmations(d.emp)).toBe(1);
  });

  it('with no lock held, however the two interleave: one result', async () => {
    for (let round = 0; round < 4; round++) {
      const d = await pendingDecision();
      const results = await Promise.all([decide(d.taskId, 'APPROVE'), decide(d.taskId, 'REJECT')]);
      expect(statusesOf(results), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
      const won = results[0]!.statusCode === 200;
      expect(await statusOf(h, d.emp)).toBe(won ? 'ACTIVE_CONFIRMED' : 'ACTIVE_PROBATION');
      expect(await confirmations(d.emp)).toBe(won ? 1 : 0);
    }
  });
});

describe('two decisions on one exception (DF11)', () => {
  const NEW_DUE = '2026-06-30';
  const dueDateProposal = async () => {
    const caseId = await open(await probationer());
    const res = await h.call(hr, 'POST', `/v1/confirmations/${caseId}/exceptions`, { reason: 'Synthetic justification', kind: 'DUE_DATE_OVERRIDE', proposedDueDate: NEW_DUE });
    expect(res.statusCode, res.body).toBe(201);
    return { caseId, id: res.json().exceptionId as string };
  };
  /** An extra extension is proposed only once the ordinary limit is used up. */
  const extensionProposal = async () => {
    const emp = await probationer();
    const caseId = await open(emp);
    for (let i = 0; i < 2; i++) {
      const rec = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: (await getCase(caseId)).version, recommendation: 'EXTEND', extensionMonths: 1, reason: 'Synthetic' });
      expect(rec.statusCode, rec.body).toBe(200);
      const done = await h.call(hr, 'POST', `/v1/confirmations/tasks/${(await hrTask(emp)).taskId}/decision`, { decision: 'APPROVE', reason: 'Synthetic', idempotencyKey: uniq('conf-x-') });
      expect(done.statusCode, done.body).toBe(200);
    }
    const res = await h.call(hr, 'POST', `/v1/confirmations/${caseId}/exceptions`, { reason: 'Synthetic justification', kind: 'EXTRA_EXTENSION' });
    expect(res.statusCode, res.body).toBe(201);
    return { caseId, id: res.json().exceptionId as string };
  };
  const decide = (a: TestActor, id: string, decision: string) => h.call(a, 'POST', `/v1/confirmation-exceptions/${id}/decision`, { decision, reason: 'Synthetic decision' });
  const withdraw = (a: TestActor, id: string) => h.call(a, 'POST', `/v1/confirmation-exceptions/${id}/withdraw`);
  const exception = (id: string) => h.one<{ state: string; decided_by: string | null }>(`select state, decided_by from confirmation_exception where id = $1`, [id]);
  const decisions = async (id: string) => (await h.db.query<{ action: string }>(`select action from audit_event where company_id = $1 and resource_code = 'confirmation_exception' and record_key = $2 and action in ('APPROVE', 'REJECT')`, [A.id, id])).rows.map((r) => r.action);

  it('two approvers of a due date: the first queued decides, the date moves once', async () => {
    const { caseId, id } = await dueDateProposal();
    const [first, second] = await raceOnRow(h, 'confirmation_exception', id, [() => decide(hr2, id, 'APPROVE'), () => decide(hr3, id, 'APPROVE')]);
    expect(first!.statusCode, first!.body).toBe(200);
    expect(second!.statusCode).toBe(409);
    expect(second!.json().error).toBe('INVALID_STATE');
    expect(await exception(id)).toEqual({ state: 'APPROVED', decided_by: hr2.user });
    expect((await caseRow(caseId)).due).toBe(NEW_DUE);
    expect(await decisions(id)).toEqual(['APPROVE']);
    // One entry for the case itself, too.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from audit_event where resource_code = 'employee_confirmation' and record_key = $1 and action = 'DUE_DATE_OVERRIDE'`, [caseId])).n).toBe(1);
  });

  it('two approvers of an extra extension: the limit rises by one, not two', async () => {
    const { caseId, id } = await extensionProposal();
    const results = await raceOnRow(h, 'confirmation_exception', id, [() => decide(hr2, id, 'APPROVE'), () => decide(hr3, id, 'APPROVE')]);
    expect(results.map((r) => r.statusCode), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
    expect((await caseRow(caseId)).extra).toBe(1);
  });

  it('an approval and a rejection: rejection queued first leaves the date alone', async () => {
    const { caseId, id } = await dueDateProposal();
    const due = (await caseRow(caseId)).due;
    const [no, yes] = await raceOnRow(h, 'confirmation_exception', id, [() => decide(hr2, id, 'REJECT'), () => decide(hr3, id, 'APPROVE')]);
    expect(no!.statusCode, no!.body).toBe(200);
    expect(yes!.statusCode).toBe(409);
    expect(await exception(id)).toEqual({ state: 'REJECTED', decided_by: hr2.user });
    expect((await caseRow(caseId)).due).toBe(due);
    expect(await decisions(id)).toEqual(['REJECT']);
  });

  it('an approval and a withdrawal: withdrawal queued first leaves nothing applied', async () => {
    const { caseId, id } = await dueDateProposal();
    const due = (await caseRow(caseId)).due;
    const [out, yes] = await raceOnRow(h, 'confirmation_exception', id, [() => withdraw(hr, id), () => decide(hr2, id, 'APPROVE')]);
    expect(out!.statusCode, out!.body).toBe(200);
    expect(yes!.statusCode).toBe(409);
    expect((await exception(id)).state).toBe('WITHDRAWN');
    expect((await caseRow(caseId)).due).toBe(due);
  });

  it('with no lock held, however the two interleave: one approver on record', async () => {
    for (let round = 0; round < 4; round++) {
      const { caseId, id } = await dueDateProposal();
      const results = await Promise.all([decide(hr2, id, 'APPROVE'), decide(hr3, id, 'APPROVE')]);
      expect(statusesOf(results), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
      expect((await caseRow(caseId)).due).toBe(NEW_DUE);
      expect(await decisions(id)).toEqual(['APPROVE']);
    }
  });
});
