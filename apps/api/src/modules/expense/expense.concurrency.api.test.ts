// ZT11 for expense decisions: two simultaneous decisions on one pending task end in one valid result and one non-success, and in one
// decision, one obligation, one audit trail and one set of notices. A raced claim must leave exactly what a claim decided once
// leaves. Withdrawal against a decision is withdrawal.api.test.ts; replay of the payment path is payment-ledger and its own gate.
// Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Footprint, footprintOf, raceOnTransaction, statusesOf } from '../../test/race.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let fin1: TestActor;
let fin2: TestActor;
let employee: TestActor;
let amount = 100;

const FINANCE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const newAmount = () => String(++amount);
const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const submitted = async (grossAmount: string) => {
  const uploaded = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic race receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const line = { category: 'OTHER', expenseDate: daysAgo(3), merchant: 'Synthetic Merchant', grossAmount, claimedAmount: grossAmount, description: 'Race (synthetic)', exceptionReason: 'Above the limit on purpose (synthetic)', receipt: { receiptId: uploaded.json().receiptId as string } };
  const created = await h.call(employee, 'POST', '/v1/expense/claims', { purpose: 'Race (synthetic)', currency: 'INR', lines: [line] });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().claimId as string;
  const sent = await h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(employee, id)).version });
  expect(sent.statusCode, sent.body).toBe(200);
  return id;
};
const txOf = async (id: string) => (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [id])).transaction_id;
const taskOn = async (id: string) => {
  const r = await h.one<{ id: string; assignee_user_id: string }>(
    `select t.id, t.assignee_user_id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id join expense_claim c on c.company_id = i.company_id and c.transaction_id = i.transaction_id
      where c.id = $1 and t.state = 'PENDING'`,
    [id],
  );
  const actor = [manager, fin1, fin2].find((a) => a.user === r.assignee_user_id);
  if (!actor) throw new Error('The pending task is assigned to nobody this test acts as');
  return { taskId: r.id, actor };
};
const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('race-key-'), ...body });
const toFinance = async (id: string) => {
  const t = await taskOn(id);
  const res = await decide(t.actor, t.taskId, { decision: 'APPROVE' });
  expect(res.json().state, res.body).toBe('FINANCE_PENDING');
};
const finalBody = async (a: TestActor, id: string) => ({
  decision: 'APPROVE',
  lines: ((await view(a, id)).lines as { id: string; claimedAmount: string }[]).map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount, reason: 'Cleared (synthetic)' })),
});
const stateOf = async (id: string) => (await h.one<{ c: string; bt: string; payment: string }>(`select c.state as c, bt.state as bt, c.payment_state as payment from expense_claim c join business_transaction bt on bt.id = c.transaction_id where c.id = $1`, [id]));
const obligations = async (id: string) => (await h.db.query<{ amount: string }>(`select approved_amount::text as amount from expense_obligation where claim_id = $1`, [id])).rows.map((r) => r.amount);
const footprint = async (id: string): Promise<Footprint> => footprintOf(h, A.id, await txOf(id), id);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  fin1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true), ($1, 'expense_claim', $3, 2, true)`, [A.id, fin1.user, fin2.user]);
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await person();
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  const employeeEmp = await person();
  await h.call(hr, 'POST', `/v1/employees/${employeeEmp}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  const activator = await h.actor(A, 'HR_ADMINISTRATOR');
  expect((await h.call(activator, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('two decisions on one pending task', () => {
  it('manager step, approve queued first: the claim moves on once, and the rejection finds the task closed', async () => {
    const alone = await submitted(newAmount());
    const aloneTask = await taskOn(alone);
    expect((await decide(aloneTask.actor, aloneTask.taskId, { decision: 'APPROVE' })).statusCode).toBe(200);

    const id = await submitted(newAmount());
    const t = await taskOn(id);
    const [approve, reject] = await raceOnTransaction(h, await txOf(id), [() => decide(t.actor, t.taskId, { decision: 'APPROVE' }), () => decide(t.actor, t.taskId, { decision: 'REJECT', reason: 'Synthetic rejection' })]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(reject!.statusCode).toBe(409);
    expect(reject!.json().error).toBe('TASK_CLOSED');
    expect((await stateOf(id)).c).toBe('FINANCE_PENDING');
    expect(await footprint(id)).toEqual(await footprint(alone));
  });

  it('manager step, reject queued first: the claim ends once, nothing moves on', async () => {
    const alone = await submitted(newAmount());
    const aloneTask = await taskOn(alone);
    expect((await decide(aloneTask.actor, aloneTask.taskId, { decision: 'REJECT', reason: 'Synthetic rejection' })).statusCode).toBe(200);

    const id = await submitted(newAmount());
    const t = await taskOn(id);
    const [reject, approve] = await raceOnTransaction(h, await txOf(id), [() => decide(t.actor, t.taskId, { decision: 'REJECT', reason: 'Synthetic rejection' }), () => decide(t.actor, t.taskId, { decision: 'APPROVE' })]);
    expect(reject!.statusCode, reject!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect((await stateOf(id)).c).toBe('REJECTED');
    expect(await footprint(id)).toEqual(await footprint(alone));
  });

  it('final step, approve queued first: one obligation for the approved amount', async () => {
    const grossAmount = newAmount();
    const alone = await submitted(grossAmount);
    await toFinance(alone);
    const aloneTask = await taskOn(alone);
    expect((await decide(aloneTask.actor, aloneTask.taskId, await finalBody(aloneTask.actor, alone))).json().state).toBe('APPROVED');

    const id = await submitted(grossAmount);
    await toFinance(id);
    const t = await taskOn(id);
    const body = await finalBody(t.actor, id);
    const [approve, send] = await raceOnTransaction(h, await txOf(id), [() => decide(t.actor, t.taskId, body), () => decide(t.actor, t.taskId, { decision: 'RETURN', reason: 'Synthetic return' })]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(send!.statusCode).toBe(409);
    expect((await stateOf(id)).c).toBe('APPROVED');
    expect(await obligations(id)).toEqual([`${grossAmount}.0000`]);
    expect(await footprint(id)).toEqual(await footprint(alone));
  });

  it('final step, return queued first: no obligation at all', async () => {
    const grossAmount = newAmount();
    const alone = await submitted(grossAmount);
    await toFinance(alone);
    const aloneTask = await taskOn(alone);
    expect((await decide(aloneTask.actor, aloneTask.taskId, { decision: 'RETURN', reason: 'Synthetic return' })).statusCode).toBe(200);

    const id = await submitted(grossAmount);
    await toFinance(id);
    const t = await taskOn(id);
    const body = await finalBody(t.actor, id);
    const [send, approve] = await raceOnTransaction(h, await txOf(id), [() => decide(t.actor, t.taskId, { decision: 'RETURN', reason: 'Synthetic return' }), () => decide(t.actor, t.taskId, body)]);
    expect(send!.statusCode, send!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect((await stateOf(id)).c).toBe('RETURNED');
    expect(await obligations(id)).toEqual([]);
    expect(await footprint(id)).toEqual(await footprint(alone));
  });

  it('the same decision sent twice with different keys: one obligation, one decision', async () => {
    const id = await submitted(newAmount());
    await toFinance(id);
    const t = await taskOn(id);
    const body = await finalBody(t.actor, id);
    const results = await raceOnTransaction(h, await txOf(id), [() => decide(t.actor, t.taskId, body), () => decide(t.actor, t.taskId, body)]);
    expect(statusesOf(results)).toEqual([200, 409]);
    expect((await obligations(id)).length).toBe(1);
    expect((await footprint(id)).decisions).toBe(2); // the manager's and one finance decision
  });

  it('the same decision sent twice with the same key: both answer, the second as a replay, one effect', async () => {
    const id = await submitted(newAmount());
    await toFinance(id);
    const t = await taskOn(id);
    const body = { ...(await finalBody(t.actor, id)), idempotencyKey: uniq('race-key-') };
    const results = await raceOnTransaction(h, await txOf(id), [() => h.call(t.actor, 'POST', `/v1/expense/tasks/${t.taskId}/decision`, body), () => h.call(t.actor, 'POST', `/v1/expense/tasks/${t.taskId}/decision`, body)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect(results.map((r) => r.json().replayed).sort()).toEqual([false, true]);
    expect((await obligations(id)).length).toBe(1);
    expect((await footprint(id)).decisions).toBe(2);
  });

  it('the high-value step behaves the same way', async () => {
    const id = await submitted('50000.01');
    await toFinance(id);
    const financeTask = await taskOn(id);
    const financeDecision = await decide(financeTask.actor, financeTask.taskId, await finalBody(financeTask.actor, id));
    expect(financeDecision.json().state, financeDecision.body).toBe('HIGH_VALUE_PENDING');
    const t = await taskOn(id);
    const body = await finalBody(t.actor, id);
    const results = await raceOnTransaction(h, await txOf(id), [() => decide(t.actor, t.taskId, body), () => decide(t.actor, t.taskId, { decision: 'REJECT', reason: 'Synthetic rejection' })]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 409]);
    expect((await stateOf(id)).c).toBe('APPROVED');
    expect((await obligations(id)).length).toBe(1);
  });

  it('with no lock held, however the two interleave: one result, and the obligation only if the approval won', async () => {
    for (let round = 0; round < 5; round++) {
      const id = await submitted(newAmount());
      await toFinance(id);
      const t = await taskOn(id);
      const body = await finalBody(t.actor, id);
      const results = await Promise.all([decide(t.actor, t.taskId, body), decide(t.actor, t.taskId, { decision: 'REJECT', reason: 'Synthetic rejection' })]);
      expect(statusesOf(results), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
      const won = results[0]!.statusCode === 200;
      expect((await stateOf(id)).c).toBe(won ? 'APPROVED' : 'REJECTED');
      expect((await obligations(id)).length).toBe(won ? 1 : 0);
      expect((await footprint(id)).decisions).toBe(2);
    }
  });
});
