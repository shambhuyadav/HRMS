// Withdrawing a claim still in review (FR-074 "permit withdrawal only before committed final approval or payment"; DF03 "Withdraw
// only before a final decision"; C5, which denied it "until decided", and Appendix F, which decided it; DF12). The race the BRD
// requires: "simultaneous withdrawal/final approval yields one valid result without two entitlements". Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { withdrawClaim } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let managerEmp: string;
let fin1: TestActor;
let fin2: TestActor;
let employee: TestActor;

const FINANCE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const line = async (a: TestActor, amount: string) => {
  const uploaded = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic withdrawal receipt ${uniq('w')}\n%%EOF\n`).toString('base64') });
  return {
    category: 'OTHER',
    expenseDate: daysAgo(3),
    merchant: 'Synthetic Merchant',
    grossAmount: amount,
    claimedAmount: amount,
    description: 'Withdrawal check (synthetic)',
    exceptionReason: 'Above the limit on purpose (synthetic)',
    receipt: { receiptId: uploaded.json().receiptId as string },
  };
};
const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const draft = async (a: TestActor, amount: string) => {
  const res = await h.call(a, 'POST', '/v1/expense/claims', { purpose: 'Withdrawal check (synthetic)', currency: 'INR', lines: [await line(a, amount)] });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().claimId as string;
};
const submit = async (a: TestActor, id: string) => {
  const res = await h.call(a, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(a, id)).version });
  expect(res.statusCode, res.body).toBe(200);
};
const txOf = async (id: string) => (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [id])).transaction_id;
const taskOf = async (a: TestActor, id: string) => {
  const tx = await txOf(id);
  return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
};
const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('withdraw-key-'), ...body });
const approveManager = async (id: string) => expect((await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
const financeBody = async (a: TestActor, id: string) => ({
  decision: 'APPROVE',
  lines: ((await view(a, id)).lines as { id: string; claimedAmount: string }[]).map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount, reason: 'Cleared (synthetic)' })),
});
const withdraw = (a: TestActor, id: string) => h.call(a, 'POST', `/v1/expense/claims/${id}/withdraw`);
const atStep = async (a: TestActor, amount: string, step: 'MANAGER_PENDING' | 'FINANCE_PENDING') => {
  const id = await draft(a, amount);
  await submit(a, id);
  if (step === 'FINANCE_PENDING') await approveManager(id);
  return id;
};
const approvalOf = async (id: string) => {
  const tx = await txOf(id);
  return {
    instances: (await h.db.query<{ state: string }>(`select state from approval_instance where transaction_id = $1`, [tx])).rows.map((r) => r.state),
    openTasks: (await h.db.query(`select 1 from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id where i.transaction_id = $1 and t.state = 'PENDING'`, [tx])).rowCount,
    obligations: (await h.db.query(`select 1 from expense_obligation where claim_id = $1`, [id])).rowCount,
    mirror: (await h.one<{ state: string }>(`select state from business_transaction where id = $1`, [tx])).state,
  };
};

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
  managerEmp = await person();
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

describe('before the final decision (FR-074, DF03)', () => {
  it.each([
    ['manager review', 'MANAGER_PENDING'],
    ['financial review', 'FINANCE_PENDING'],
  ] as const)('the claimant withdraws at %s: the approval closes, nothing is owed, and it is audited', async (_label, step) => {
    const id = await atStep(employee, '120', step);
    const res = await withdraw(employee, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ claimId: id, state: 'WITHDRAWN' });
    expect(await approvalOf(id)).toEqual({ instances: ['CANCELLED'], openTasks: 0, obligations: 0, mirror: 'WITHDRAWN' });
    expect((await view(employee, id)).state).toBe('WITHDRAWN');
    const audit = await h.one<{ actor_user_id: string; acting_assignment_id: string; before_values: unknown; after_values: unknown }>(
      `select actor_user_id, acting_assignment_id, before_values, after_values from audit_event where resource_code = 'expense_claim' and record_key = $1 and action = 'WITHDRAW'`,
      [id],
    );
    expect(audit).toEqual({ actor_user_id: employee.user, acting_assignment_id: employee.assignment, before_values: { operational: { state: step } }, after_values: { operational: { state: 'WITHDRAWN' } } });
  });

  it('at the high-value step as well', async () => {
    const id = await draft(employee, '50000.01');
    await submit(employee, id);
    await approveManager(id);
    const reviewed = await decide(fin1, await taskOf(fin1, id), await financeBody(fin1, id));
    expect(reviewed.json().state).toBe('HIGH_VALUE_PENDING');
    expect((await withdraw(employee, id)).json().state).toBe('WITHDRAWN');
    expect(await approvalOf(id)).toEqual({ instances: ['CANCELLED'], openTasks: 0, obligations: 0, mirror: 'WITHDRAWN' });
  });

  it('a draft and a returned claim as before', async () => {
    const d = await draft(employee, '121');
    expect((await withdraw(employee, d)).json().state).toBe('WITHDRAWN');
    const r = await atStep(employee, '122', 'MANAGER_PENDING');
    expect((await decide(manager, await taskOf(manager, r), { decision: 'RETURN', reason: 'Synthetic return' })).json().state).toBe('RETURNED');
    expect((await withdraw(employee, r)).json().state).toBe('WITHDRAWN');
    expect((await approvalOf(r)).instances).toEqual(['RETURNED']);
  });

  it('the reviewer of the closed task is told once, and the claimant is not', async () => {
    const id = await atStep(employee, '123', 'MANAGER_PENDING');
    await dispatchOutbox(h.pool, 1000);
    expect((await withdraw(employee, id)).statusCode).toBe(200);
    await dispatchOutbox(h.pool, 1000);
    const notices = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; transactionId?: string; body: string }[]).filter((n) => n.category === 'EXPENSE_WITHDRAWN');
    expect((await notices(manager)).length).toBeGreaterThanOrEqual(1);
    const queued = await h.db.query(`select 1 from outbox_event where company_id = $1 and topic = 'expense.withdrawn' and aggregate_id = $2`, [A.id, id]);
    expect(queued.rowCount).toBe(1);
    expect(await notices(employee)).toEqual([]);
  });

  it('a task it closed leaves the reviewer\'s queue and cannot be decided', async () => {
    const id = await atStep(employee, '124', 'FINANCE_PENDING');
    const taskId = await taskOf(fin1, id);
    const body = await financeBody(fin1, id);
    expect((await withdraw(employee, id)).statusCode).toBe(200);
    const queue = (await h.call(fin1, 'GET', '/v1/expense/tasks')).json().items as { taskId: string }[];
    expect(queue.map((t) => t.taskId)).not.toContain(taskId);
    const late = await decide(fin1, taskId, body);
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('TASK_CLOSED');
    expect(await approvalOf(id)).toMatchObject({ obligations: 0, mirror: 'WITHDRAWN' });
    expect((await h.db.query(`select 1 from expense_line_decision d join expense_line l on l.id = d.line_id join expense_revision r on r.id = l.revision_id where r.claim_id = $1`, [id])).rowCount).toBe(0);
  });
});

describe('once decided, or by anyone else', () => {
  it('a finally approved, rejected or withdrawn claim cannot be withdrawn', async () => {
    const approved = await atStep(employee, '130', 'FINANCE_PENDING');
    expect((await decide(fin1, await taskOf(fin1, approved), await financeBody(fin1, approved))).json().state).toBe('APPROVED');
    const refused = await withdraw(employee, approved);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('INVALID_STATE');
    expect(await approvalOf(approved)).toMatchObject({ obligations: 1, mirror: 'APPROVED' });

    const zero = await atStep(employee, '131', 'FINANCE_PENDING');
    const zeroBody = await financeBody(fin1, zero);
    expect((await decide(fin1, await taskOf(fin1, zero), { ...zeroBody, lines: zeroBody.lines.map((l) => ({ ...l, allowedAmount: '0' })) })).json()).toMatchObject({ state: 'APPROVED', paymentState: 'NO_PAYABLE_AMOUNT' });
    expect((await withdraw(employee, zero)).json().error).toBe('INVALID_STATE');

    const rejected = await atStep(employee, '132', 'MANAGER_PENDING');
    expect((await decide(manager, await taskOf(manager, rejected), { decision: 'REJECT', reason: 'Synthetic rejection' })).json().state).toBe('REJECTED');
    expect((await withdraw(employee, rejected)).json().error).toBe('INVALID_STATE');

    const twice = await atStep(employee, '133', 'MANAGER_PENDING');
    expect((await withdraw(employee, twice)).statusCode).toBe(200);
    expect((await withdraw(employee, twice)).json().error).toBe('INVALID_STATE');
  });

  it('only the claimant: a reviewer reads it as missing and a colleague is refused', async () => {
    const id = await atStep(employee, '134', 'MANAGER_PENDING');
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    const colleague = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    expect((await withdraw(colleague, id)).statusCode).toBe(404);
    expect((await withdraw(manager, id)).statusCode).toBe(403); // manager duties do not include withdrawing
    expect((await view(employee, id)).state).toBe('MANAGER_PENDING');
    expect((await approvalOf(id)).openTasks).toBe(1);
  });

  it('re-checks the withdrawal duty inside its transaction', async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    const a = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    const id = await atStep(a, '135', 'MANAGER_PENDING');
    const grant = (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'expense', action: 'withdraw', fieldGroups: ['operational'] })) as AccessGrant;
    expect(grant.allowed).toBe(true);
    await h.db.query(`update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2 and permission_id in (select id from permission where resource = 'expense' and action = 'withdraw')`, [A.id, a.assignment]);
    await expect(withTransaction(h.pool, (tx) => withdrawClaim(tx, grant, id))).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.one<{ state: string }>(`select state from expense_claim where id = $1`, [id])).state).toBe('MANAGER_PENDING');
  });
});

describe('at the same moment as a decision (FR-074 acceptance; line 102 "one valid result and one rejected/stale result")', () => {
  /** Waits until `min` requests of the app queue on an advisory lock: here, the transaction's key this test holds. */
  async function queued(min: number) {
    for (let i = 0; i < 400; i++) {
      const r = await h.db.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and wait_event = 'advisory'`);
      if (r.rows[0]!.n >= min) return;
      await new Promise((res) => setTimeout(res, 25));
    }
    throw new Error(`timeout waiting for ${min} requests on the transaction lock`);
  }
  /**
   * Holds the claim's transaction key while both requests start, so both are in flight and neither can finish first; the key
   * is then granted in the order they arrived, which gives each outcome in turn. This is the key every path must take.
   */
  async function race(id: string, first: () => Promise<{ statusCode: number; json(): any; body: string }>, second: () => Promise<{ statusCode: number; json(): any; body: string }>) {
    const tx = await txOf(id);
    const key = `hashtextextended('bt:' || $1::text, 0)`;
    await h.db.query(`select pg_advisory_lock(${key})`, [tx]);
    const a = first();
    await queued(1);
    const b = second();
    await queued(2);
    await h.db.query(`select pg_advisory_unlock(${key})`, [tx]);
    return Promise.all([a, b]);
  }

  it('withdrawal first: the claim is withdrawn, the final approval is refused, and nothing is owed', async () => {
    const id = await atStep(employee, '140', 'FINANCE_PENDING');
    const taskId = await taskOf(fin1, id);
    const body = await financeBody(fin1, id);
    const [w, d] = await race(id, () => withdraw(employee, id), () => decide(fin1, taskId, body));
    expect(w.statusCode, w.body).toBe(200);
    expect(d.statusCode).toBe(409);
    expect(d.json().error).toBe('TASK_CLOSED');
    expect(await approvalOf(id)).toEqual({ instances: ['CANCELLED'], openTasks: 0, obligations: 0, mirror: 'WITHDRAWN' });
  });

  it('final approval first: one entitlement stands and the withdrawal is refused', async () => {
    const id = await atStep(employee, '141', 'FINANCE_PENDING');
    const taskId = await taskOf(fin1, id);
    const body = await financeBody(fin1, id);
    const [d, w] = await race(id, () => decide(fin1, taskId, body), () => withdraw(employee, id));
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json().state).toBe('APPROVED');
    expect(w.statusCode).toBe(409);
    expect(w.json().error).toBe('INVALID_STATE');
    expect(await approvalOf(id)).toEqual({ instances: ['APPROVED'], openTasks: 0, obligations: 1, mirror: 'APPROVED' });
    expect((await view(employee, id)).state).toBe('APPROVED');
  });

  it('with the manager\'s approval too: one result, and the next step exists only if the claim stayed live', async () => {
    const first = await atStep(employee, '142', 'MANAGER_PENDING');
    const firstTask = await taskOf(manager, first);
    const [w1, d1] = await race(first, () => withdraw(employee, first), () => decide(manager, firstTask, { decision: 'APPROVE' }));
    expect([w1.statusCode, d1.statusCode]).toEqual([200, 409]);
    expect(await approvalOf(first)).toEqual({ instances: ['CANCELLED'], openTasks: 0, obligations: 0, mirror: 'WITHDRAWN' });

    const second = await atStep(employee, '143', 'MANAGER_PENDING');
    const secondTask = await taskOf(manager, second);
    const [d2, w2] = await race(second, () => decide(manager, secondTask, { decision: 'APPROVE' }), () => withdraw(employee, second));
    // The manager's approval is no final decision, so the withdrawal that follows it still succeeds and closes the next step.
    expect([d2.statusCode, w2.statusCode]).toEqual([200, 200]);
    expect(await approvalOf(second)).toEqual({ instances: ['CANCELLED'], openTasks: 0, obligations: 0, mirror: 'WITHDRAWN' });
  });

  it('with a return: the claim is withdrawn or returned, never both', async () => {
    const id = await atStep(employee, '144', 'FINANCE_PENDING');
    const taskId = await taskOf(fin1, id);
    const [d, w] = await race(id, () => decide(fin1, taskId, { decision: 'RETURN', reason: 'Synthetic return' }), () => withdraw(employee, id));
    // A returned claim is still the claimant's to withdraw, so the later withdrawal stands, over the return before it.
    expect([d.statusCode, w.statusCode]).toEqual([200, 200]);
    expect(await approvalOf(id)).toEqual({ instances: ['RETURNED'], openTasks: 0, obligations: 0, mirror: 'WITHDRAWN' });
  });

  it('with no lock held, however the two interleave: exactly one outcome and at most one entitlement', async () => {
    for (let round = 0; round < 6; round++) {
      const id = await atStep(employee, String(150 + round), 'FINANCE_PENDING');
      const taskId = await taskOf(fin1, id);
      const body = await financeBody(fin1, id);
      const [w, d] = await Promise.all([withdraw(employee, id), decide(fin1, taskId, body)]);
      expect([w.statusCode, d.statusCode].sort(), `${w.body} ${d.body}`).toEqual([200, 409]);
      const after = await approvalOf(id);
      if (w.statusCode === 200) expect(after).toEqual({ instances: ['CANCELLED'], openTasks: 0, obligations: 0, mirror: 'WITHDRAWN' });
      else expect(after).toEqual({ instances: ['APPROVED'], openTasks: 0, obligations: 1, mirror: 'APPROVED' });
    }
  });
});
