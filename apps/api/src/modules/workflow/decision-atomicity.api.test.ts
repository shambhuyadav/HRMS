// ZT18, BR-033, DF12: a failure after a decision has passed validation and before it commits leaves nothing behind: no state,
// ledger or payment effect, no audit row, no outbox row and so no notification. A retry with the same key then applies once and
// tells only the people the decision concerns. The fault is a trigger created in this test's own database for one request, and
// dropped afterwards; it never exists in a migration. It also records, in a sequence (which a rollback does not undo), that it
// fired and what the transaction had already written, so a passing test cannot mean the request was refused earlier for
// another reason. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { prepareReady, releaseNaming } from '../expense/payment.fixtures.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { mondayAfter } from './leave-tasks.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let bystander: TestActor;
let fin1: TestActor;
let fin2: TestActor;
let fin3: TestActor;
let reviewer: TestActor;
let employeeEmp: string;
let weeksOut = 8;
let faults = 0;

const FINANCE: PermissionKey[] = [
  'expense.read.operational',
  'expense.manager_decide.operational',
  'expense.finance_decide.operational',
  'expense.high_value_decide.operational',
  'payment.read.operational',
  'payment.prepare.operational',
  'payment.release.operational',
  'payment.confirm_outcome.operational',
  'payment.reverse.operational',
];
const SENSITIVE: PermissionKey[] = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank'];

interface Fault {
  table: string;
  /** The trigger's WHEN condition, over `new`. */
  when: string;
}

/**
 * Runs one request while an insert matching the fault aborts its transaction. `written` counts rows the transaction has already
 * written when the fault hits; it is read inside that transaction, and a sequence keeps the answer past the rollback.
 */
async function underFault<T>(fault: Fault, written: string, request: () => Promise<T>): Promise<{ result: T; fired: number; seen: number }> {
  const name = `zz_zt18_fault_${++faults}`;
  await h.db.query(`create sequence ${name}_fired minvalue 0 start 1`);
  await h.db.query(`create sequence ${name}_seen minvalue 0 start 0`);
  await h.db.query(
    `create function ${name}() returns trigger language plpgsql as $fault$
     begin
       perform nextval('${name}_fired');
       perform setval('${name}_seen', (${written}), true);
       raise exception 'zt18 synthetic fault';
     end $fault$`,
  );
  await h.db.query(`create trigger ${name} before insert on ${fault.table} for each row when (${fault.when}) execute function ${name}()`);
  try {
    const result = await request();
    const fired = await h.one<{ n: string; called: boolean }>(`select last_value::text as n, is_called as called from ${name}_fired`);
    const seen = await h.one<{ n: string }>(`select last_value::text as n from ${name}_seen`);
    return { result, fired: fired.called ? Number(fired.n) : 0, seen: Number(seen.n) };
  } finally {
    await h.db.query(`drop trigger ${name} on ${fault.table}`);
    await h.db.query(`drop function ${name}()`);
    await h.db.query(`drop sequence ${name}_fired`);
    await h.db.query(`drop sequence ${name}_seen`);
  }
}

const count = async (sql: string, params: unknown[]) => (await h.one<{ n: number }>(`select count(*)::int as n ${sql}`, params)).n;
const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
/** Who holds a notification of this category about this transaction, in the company's stored rows. */
const recipients = async (transactionId: string, category: string) =>
  (await h.db.query<{ user: string }>(`select recipient_user_id as "user" from notification where company_id = $1 and transaction_id = $2 and category = $3 order by 1`, [A.id, transactionId, category])).rows.map((r) => r.user);
const taskState = async (taskId: string) => (await h.one<{ state: string }>(`select state from approval_task where company_id = $1 and id = $2`, [A.id, taskId])).state;
const decisionsOf = (taskId: string) => count(`from approval_decision where company_id = $1 and task_id = $2`, [A.id, taskId]);
const auditOf = (resource: string, recordKey: string, action: string) => count(`from audit_event where company_id = $1 and resource_code = $2 and record_key = $3 and action = $4`, [A.id, resource, recordKey, action]);
const outboxOf = (topic: string, aggregate: string) => count(`from outbox_event where company_id = $1 and topic = $2 and aggregate_id = $3`, [A.id, topic, aggregate]);

/** The refusal a fault after validation produces: an internal error that says nothing of the cause, not a business refusal. */
function expectFaulted(run: { result: { statusCode: number; body: string }; fired: number; seen: number }, seen: number) {
  expect(run.result.statusCode, run.result.body).toBe(500);
  expect(JSON.parse(run.result.body)).toMatchObject({ error: 'INTERNAL' });
  expect(run.result.body).not.toContain('synthetic');
  expect(run.fired, 'the fault fired, so validation had passed').toBe(1);
  expect(run.seen, 'what the transaction had written when it hit').toBe(seen);
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  fin1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin3 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: SENSITIVE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, fin1.user]);
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'sensitive_change', $2, 1, true)`, [A.id, reviewer.user]);
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items) {
    expect((await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);
  }
  const expensePolicy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${expensePolicy.id}/activate`, { expectedVersion: expensePolicy.version })).statusCode).toBe(200);
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const boss = await person();
  employeeEmp = await person();
  const other = await person();
  for (const e of [employeeEmp, other]) expect((await h.call(hr, 'POST', `/v1/employees/${e}/manager`, { managerEmployeeId: boss, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: boss });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  bystander = await h.actor(A, 'EMPLOYEE', { employeeId: other });
  const opening = await h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId: employeeEmp, leaveType: 'CASUAL', kind: 'OPENING', units: '200', effectiveDate: '2026-01-05', reason: 'Opening (synthetic)', idempotencyKey: uniq('open-key-') });
  expect(opening.statusCode, opening.body).toBe(201);
});

afterAll(async () => {
  await h?.stop();
});

describe('leave decision (ZT18; BR-033)', () => {
  /** A one-day request waiting for the manager, with its reservation made. */
  async function pendingLeave() {
    const day = mondayAfter(7 * ++weeksOut);
    const res = await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: day, endDate: day });
    expect(res.statusCode, res.body).toBe(201);
    const requestId = res.json().requestId as string;
    const { transaction_id: transactionId } = await h.one<{ transaction_id: string }>(`select transaction_id from leave_request where id = $1`, [requestId]);
    const task = ((await h.call(manager, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === transactionId)!;
    return { day, requestId, transactionId, taskId: task.taskId };
  }
  const movements = async (requestId: string) =>
    (await h.db.query<{ kind: string }>(`select movement_kind as kind from leave_movement where company_id = $1 and request_id = $2 order by created_at, id`, [A.id, requestId])).rows.map((m) => m.kind).sort();
  const requestState = async (requestId: string) => (await h.one<{ state: string }>(`select state from leave_request where id = $1`, [requestId])).state;

  it.each<[string, Fault]>([
    ['the consumption movement', { table: 'leave_movement', when: `new.movement_kind = 'CONSUMPTION'` }],
    ['the audit event', { table: 'audit_event', when: `new.resource_code = 'leave_request' and new.action = 'APPROVE'` }],
    ['the outbox event', { table: 'outbox_event', when: `new.topic = 'leave.decided'` }],
  ])('an approval that fails at %s leaves nothing behind, and its retry applies once', async (_at, fault) => {
    const { day, requestId, transactionId, taskId } = await pendingLeave();
    await dispatchOutbox(h.pool); // the submission's own notice is not what this test is about
    const body = { decision: 'APPROVE', idempotencyKey: uniq('zt18-leave-') };
    const url = `/v1/leave/tasks/${taskId}/decision`;
    const before = await companyState(h, A.id);

    const run = await underFault(fault, `select count(*) from approval_decision where company_id = '${A.id}' and task_id = '${taskId}'`, () => h.call(manager, 'POST', url, body));
    expectFaulted(run, 1);

    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect(await taskState(taskId)).toBe('PENDING');
    expect(await decisionsOf(taskId)).toBe(0);
    expect(await requestState(requestId)).toBe('SUBMITTED');
    expect(await movements(requestId)).toEqual(['RESERVATION']);
    expect(await auditOf('leave_request', requestId, 'APPROVE')).toBe(0);
    expect(await outboxOf('leave.decided', requestId)).toBe(0);
    await dispatchOutbox(h.pool);
    expect(await recipients(transactionId, 'LEAVE_DECIDED')).toEqual([]);

    const retried = await h.call(manager, 'POST', url, body);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ requestId, state: 'APPROVED', replayed: false });
    const replayed = await h.call(manager, 'POST', url, body);
    expect(replayed.json()).toMatchObject({ requestId, state: 'APPROVED', replayed: true });

    expect(await taskState(taskId)).toBe('APPROVED');
    expect(await decisionsOf(taskId)).toBe(1);
    expect(await movements(requestId)).toEqual(['CONSUMPTION', 'RESERVATION', 'RESERVATION_RELEASE']);
    expect(await auditOf('leave_request', requestId, 'APPROVE')).toBe(1);
    expect(await outboxOf('leave.decided', requestId)).toBe(1);
    await dispatchOutbox(h.pool);
    expect(await recipients(transactionId, 'LEAVE_DECIDED')).toEqual([employee.user]);
    expect((await inbox(employee)).filter((n) => n.category === 'LEAVE_DECIDED' && n.body.includes(day))).toHaveLength(1);
    for (const a of [bystander, manager, hr]) expect((await inbox(a)).filter((n) => n.category === 'LEAVE_DECIDED' && n.body.includes(day))).toEqual([]);
  });

  it('a rejection that fails keeps the reservation and tells nobody; its retry releases it once', async () => {
    const { requestId, transactionId, taskId } = await pendingLeave();
    const body = { decision: 'REJECT', reason: 'Not this week (synthetic)', idempotencyKey: uniq('zt18-leave-') };
    const url = `/v1/leave/tasks/${taskId}/decision`;
    const before = await companyState(h, A.id);
    const run = await underFault({ table: 'outbox_event', when: `new.topic = 'leave.decided'` }, `select count(*) from leave_movement where company_id = '${A.id}' and request_id = '${requestId}' and movement_kind = 'RESERVATION_RELEASE'`, () =>
      h.call(manager, 'POST', url, body),
    );
    expectFaulted(run, 1);
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect(await requestState(requestId)).toBe('SUBMITTED');
    expect(await movements(requestId)).toEqual(['RESERVATION']);

    const retried = await h.call(manager, 'POST', url, body);
    expect(retried.json()).toMatchObject({ requestId, state: 'REJECTED', replayed: false });
    expect(await movements(requestId)).toEqual(['RESERVATION', 'RESERVATION_RELEASE']);
    await dispatchOutbox(h.pool);
    expect(await recipients(transactionId, 'LEAVE_DECIDED')).toEqual([employee.user]);
  });

  it('an approved cancellation that fails restores no balance and leaves the leave approved; its retry reverses it once', async () => {
    const { requestId, taskId } = await pendingLeave();
    expect((await h.call(manager, 'POST', `/v1/leave/tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('zt18-leave-') })).statusCode).toBe(200);
    const asked = await h.call(employee, 'POST', `/v1/leave/requests/${requestId}/cancellation`, { reason: 'Plans changed (synthetic)' });
    expect(asked.statusCode, asked.body).toBeLessThan(300);
    const { id: cancellationId, transaction_id: cancellationTx } = await h.one<{ id: string; transaction_id: string }>(`select id, transaction_id from leave_cancellation where company_id = $1 and leave_request_id = $2`, [A.id, requestId]);
    const task = ((await h.call(manager, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === cancellationTx)!;
    const body = { decision: 'APPROVE', idempotencyKey: uniq('zt18-cancel-') };
    const url = `/v1/leave/tasks/${task.taskId}/decision`;
    const before = await companyState(h, A.id);
    const run = await underFault({ table: 'outbox_event', when: `new.topic = 'leave.cancellation_decided'` }, `select count(*) from leave_movement where company_id = '${A.id}' and request_id = '${requestId}' and movement_kind = 'REVERSAL'`, () =>
      h.call(manager, 'POST', url, body),
    );
    expectFaulted(run, 1);
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect(await requestState(requestId)).toBe('APPROVED');
    expect(await taskState(task.taskId)).toBe('PENDING');
    expect(await movements(requestId)).toEqual(['CONSUMPTION', 'RESERVATION', 'RESERVATION_RELEASE']);

    expect((await h.call(manager, 'POST', url, body)).json()).toMatchObject({ cancellationId, state: 'APPROVED', replayed: false });
    expect((await h.call(manager, 'POST', url, body)).json()).toMatchObject({ cancellationId, state: 'APPROVED', replayed: true });
    expect(await requestState(requestId)).toBe('CANCELLED');
    expect(await movements(requestId)).toEqual(['CONSUMPTION', 'RESERVATION', 'RESERVATION_RELEASE', 'REVERSAL']);
  });
});

describe('expense finance decision (ZT18; CI03)', () => {
  const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
  const claimFacts = (id: string) => h.one<{ state: string; payment_state: string; transaction_id: string }>(`select state, payment_state, transaction_id from expense_claim where id = $1`, [id]);
  const taskOf = async (a: TestActor, claimId: string) => {
    const { transaction_id } = await claimFacts(claimId);
    return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === transaction_id)!.taskId;
  };

  /** A claim of one 100 line, past its manager and waiting for finance. */
  async function atFinance() {
    const receipt = (await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic ${uniq('r')}\n%%EOF\n`).toString('base64') })).json().receiptId as string;
    const drafted = await h.call(employee, 'POST', '/v1/expense/claims', {
      purpose: 'Atomicity check (synthetic)',
      currency: 'INR',
      lines: [{ category: 'OTHER', expenseDate: daysAgo(2), merchant: 'Synthetic Merchant', grossAmount: '100', claimedAmount: '100', description: 'Synthetic line', receipt: { receiptId: receipt } }],
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    const claimId = drafted.json().claimId as string;
    const view = (await h.call(employee, 'GET', `/v1/expense/claims/${claimId}`)).json();
    expect((await h.call(employee, 'POST', `/v1/expense/claims/${claimId}/submit`, { expectedVersion: view.version })).statusCode).toBe(200);
    const decided = await h.call(manager, 'POST', `/v1/expense/tasks/${await taskOf(manager, claimId)}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('zt18-exp-') });
    expect(decided.json()).toMatchObject({ state: 'FINANCE_PENDING' });
    const lines = (await h.call(fin1, 'GET', `/v1/expense/claims/${claimId}`)).json().lines as { id: string }[];
    return { claimId, lines, taskId: await taskOf(fin1, claimId) };
  }

  it.each<[string, Fault]>([
    ['the line decision', { table: 'expense_line_decision', when: 'true' }],
    ['the obligation', { table: 'expense_obligation', when: 'true' }],
    ['the audit event', { table: 'audit_event', when: `new.resource_code = 'expense_claim' and new.action = 'FINANCE_DECIDE_APPROVE'` }],
    ['the outbox event', { table: 'outbox_event', when: `new.topic = 'expense.decided'` }],
  ])('a final approval that fails at %s creates no entitlement, and its retry creates one', async (_at, fault) => {
    const { claimId, lines, taskId } = await atFinance();
    await dispatchOutbox(h.pool);
    const { transaction_id: transactionId } = await claimFacts(claimId);
    const body = { decision: 'APPROVE', idempotencyKey: uniq('zt18-exp-'), lines: lines.map((l) => ({ lineId: l.id, allowedAmount: '75', reason: 'Decided (synthetic)' })) };
    const url = `/v1/expense/tasks/${taskId}/decision`;
    const before = await companyState(h, A.id);

    const run = await underFault(fault, `select count(*) from approval_decision where company_id = '${A.id}' and task_id = '${taskId}'`, () => h.call(fin1, 'POST', url, body));
    expectFaulted(run, 1);

    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect(await taskState(taskId)).toBe('PENDING');
    expect(await decisionsOf(taskId)).toBe(0);
    expect(await claimFacts(claimId)).toMatchObject({ state: 'FINANCE_PENDING', payment_state: 'NOT_APPLICABLE' });
    expect(await count(`from expense_obligation where company_id = $1 and claim_id = $2`, [A.id, claimId])).toBe(0);
    expect(await count(`from expense_line_decision where company_id = $1 and line_id = $2`, [A.id, lines[0]!.id])).toBe(0);
    expect(await auditOf('expense_claim', claimId, 'FINANCE_DECIDE_APPROVE')).toBe(0);
    expect(await outboxOf('expense.decided', claimId)).toBe(0);
    await dispatchOutbox(h.pool);
    expect(await recipients(transactionId, 'EXPENSE_DECIDED')).toEqual([]);
    expect(((await h.call(fin2, 'GET', '/v1/expense/payables')).json().items as { claimId: string }[]).map((p) => p.claimId)).not.toContain(claimId);

    const retried = await h.call(fin1, 'POST', url, body);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ claimId, state: 'APPROVED', approvedAmount: '75.0000', paymentState: 'UNPAID', replayed: false });
    expect((await h.call(fin1, 'POST', url, body)).json()).toMatchObject({ claimId, state: 'APPROVED', replayed: true });

    expect(await count(`from expense_obligation where company_id = $1 and claim_id = $2`, [A.id, claimId])).toBe(1);
    expect(await count(`from expense_line_decision where company_id = $1 and line_id = $2`, [A.id, lines[0]!.id])).toBe(1);
    expect(await auditOf('expense_claim', claimId, 'FINANCE_DECIDE_APPROVE')).toBe(1);
    expect(await outboxOf('expense.decided', claimId)).toBe(1);
    expect(((await h.call(fin2, 'GET', '/v1/expense/payables')).json().items as { claimId: string; approvedAmount: string }[]).filter((p) => p.claimId === claimId)).toEqual([expect.objectContaining({ approvedAmount: '75.00' })]);
    await dispatchOutbox(h.pool);
    expect(await recipients(transactionId, 'EXPENSE_DECIDED')).toEqual([employee.user]);
    expect((await inbox(bystander)).filter((n) => n.category === 'EXPENSE_DECIDED')).toEqual([]);
  });

  describe('payment outcome and reversal (ZT15; ZT18)', () => {
    const ledger = (claimId: string) =>
      h.one<{ net_paid: string; pending: string; payment_state: string }>(
        `select l.net_paid::numeric(19,2)::text as net_paid, l.pending::numeric(19,2)::text as pending, c.payment_state
           from expense_obligation_ledger l join expense_claim c on c.company_id = l.company_id and c.id = l.claim_id where l.company_id = $1 and l.claim_id = $2`,
        [A.id, claimId],
      );
    const instruction = (id: string) => h.one<{ state: string }>(`select state from payment_instruction where company_id = $1 and id = $2`, [A.id, id]);

    /** An approved claim of 75 with a released instruction for the whole of it. */
    async function released() {
      const { claimId, lines, taskId } = await atFinance();
      const decided = await h.call(fin1, 'POST', `/v1/expense/tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('zt18-exp-'), lines: lines.map((l) => ({ lineId: l.id, allowedAmount: '75', reason: 'Decided (synthetic)' })) });
      expect(decided.json()).toMatchObject({ state: 'APPROVED' });
      const prepared = await prepareReady(h, fin2, { claimId, amount: '75', paymentDate: daysAgo(0), idempotencyKey: uniq('zt18-pay-') });
      expect(prepared.statusCode, prepared.body).toBe(201);
      const instructionId = prepared.json().instructionId as string;
      const res = await releaseNaming(h, fin3, instructionId);
      expect(res.statusCode, res.body).toBe(200);
      return { claimId, instructionId };
    }

    it.each<[string, Fault, number]>([
      ['the payment event', { table: 'payment_event', when: `new.event_kind = 'CONFIRMED'` }, 0],
      ['the audit event', { table: 'audit_event', when: `new.resource_code = 'payment_instruction' and new.action = 'CONFIRMED'` }, 1],
      ['the outbox event', { table: 'outbox_event', when: `new.topic = 'expense.payment_status'` }, 1],
    ])('a confirmation that fails at %s counts nothing as paid, and its retry pays once', async (_at, fault, written) => {
      const { claimId, instructionId } = await released();
      await dispatchOutbox(h.pool);
      const { transaction_id: transactionId } = await claimFacts(claimId);
      const pendingLedger = await ledger(claimId);
      expect(pendingLedger).toMatchObject({ net_paid: '0.00', pending: '75.00' });
      const evidenceKey = uniq('zt18-evidence-');
      const body = { outcome: 'CONFIRMED', evidenceKey };
      const url = `/v1/expense/payments/${instructionId}/outcome`;
      const before = await companyState(h, A.id);

      const run = await underFault(fault, `select count(*) from payment_event where company_id = '${A.id}' and event_key = '${evidenceKey}'`, () => h.call(fin3, 'POST', url, body));
      expectFaulted(run, written);

      expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
      expect(await instruction(instructionId)).toMatchObject({ state: 'RELEASED' });
      expect(await ledger(claimId)).toEqual(pendingLedger);
      expect(await count(`from payment_event where company_id = $1 and instruction_id = $2`, [A.id, instructionId])).toBe(0);
      expect(await auditOf('payment_instruction', instructionId, 'CONFIRMED')).toBe(0);
      expect(await outboxOf('expense.payment_status', claimId)).toBe(0);
      await dispatchOutbox(h.pool);
      expect(await recipients(transactionId, 'EXPENSE_PAYMENT_STATUS')).toEqual([]);

      const retried = await h.call(fin3, 'POST', url, body);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json()).toMatchObject({ instructionId, state: 'CONFIRMED', replayed: false });
      expect((await h.call(fin3, 'POST', url, body)).json()).toMatchObject({ instructionId, state: 'CONFIRMED', replayed: true });

      expect(await ledger(claimId)).toMatchObject({ net_paid: '75.00', pending: '0.00', payment_state: 'PAID' });
      expect(await count(`from payment_event where company_id = $1 and instruction_id = $2`, [A.id, instructionId])).toBe(1);
      expect(await auditOf('payment_instruction', instructionId, 'CONFIRMED')).toBe(1);
      expect(await outboxOf('expense.payment_status', claimId)).toBe(1);
      await dispatchOutbox(h.pool);
      expect(await recipients(transactionId, 'EXPENSE_PAYMENT_STATUS')).toEqual([employee.user]);
    });

    it('a definitive failure that fails to commit keeps the reservation; its retry releases it once', async () => {
      const { claimId, instructionId } = await released();
      const evidenceKey = uniq('zt18-evidence-');
      const body = { outcome: 'FAILED', evidenceKey };
      const url = `/v1/expense/payments/${instructionId}/outcome`;
      const pendingLedger = await ledger(claimId);
      const before = await companyState(h, A.id);
      const run = await underFault({ table: 'outbox_event', when: `new.topic = 'expense.payment_status'` }, `select count(*) from payment_event where company_id = '${A.id}' and event_key = '${evidenceKey}'`, () => h.call(fin3, 'POST', url, body));
      expectFaulted(run, 1);
      expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
      expect(await ledger(claimId)).toEqual(pendingLedger);
      expect(await instruction(instructionId)).toMatchObject({ state: 'RELEASED' });

      expect((await h.call(fin3, 'POST', url, body)).json()).toMatchObject({ state: 'FAILED', replayed: false });
      expect(await ledger(claimId)).toMatchObject({ net_paid: '0.00', pending: '0.00', payment_state: 'UNPAID' });
    });

    it('a reversal that fails restores nothing; its retry reverses once', async () => {
      const { claimId, instructionId } = await released();
      expect((await h.call(fin3, 'POST', `/v1/expense/payments/${instructionId}/outcome`, { outcome: 'CONFIRMED', evidenceKey: uniq('zt18-evidence-') })).statusCode).toBe(200);
      const paidLedger = await ledger(claimId);
      expect(paidLedger).toMatchObject({ net_paid: '75.00', payment_state: 'PAID' });
      const evidenceKey = uniq('zt18-reversal-');
      const body = { amount: '25', evidenceKey, reason: 'Bank return (synthetic)' };
      const url = `/v1/expense/payments/${instructionId}/reversal`;
      const before = await companyState(h, A.id);
      const run = await underFault({ table: 'audit_event', when: `new.resource_code = 'payment_instruction' and new.action = 'REVERSE'` }, `select count(*) from payment_event where company_id = '${A.id}' and event_key = '${evidenceKey}'`, () => h.call(fin3, 'POST', url, body));
      expectFaulted(run, 1);
      expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
      expect(await ledger(claimId)).toEqual(paidLedger);

      expect((await h.call(fin3, 'POST', url, body)).json()).toMatchObject({ instructionId, replayed: false });
      expect((await h.call(fin3, 'POST', url, body)).json()).toMatchObject({ instructionId, replayed: true });
      expect(await ledger(claimId)).toMatchObject({ net_paid: '50.00', pending: '0.00', payment_state: 'PART_PAID' });
      expect(await count(`from payment_event where company_id = $1 and instruction_id = $2 and event_kind = 'REVERSED'`, [A.id, instructionId])).toBe(1);
    });
  });
});

describe('sensitive-change approval (ZT18; ZT40)', () => {
  const profile = async () => (await h.call(employee, 'GET', '/v1/me/private-profile')).json() as { address: { revision: number; values: Record<string, unknown> } };
  const requestFacts = (id: string) => h.one<{ state: string; transaction_id: string }>(`select state, transaction_id from employee_sensitive_change_request where company_id = $1 and id = $2`, [A.id, id]);

  /** An address change submitted by the employee, its review started; the reviewer's task. */
  async function inReview(city: string) {
    const created = await h.call(employee, 'POST', '/v1/me/sensitive-changes', { category: 'ADDRESS', reason: 'Synthetic update', values: { line1: '12 Synthetic Street', city, postalCode: '560001', countryCode: 'IN' } });
    expect(created.statusCode, created.body).toBe(201);
    const requestId = created.json().requestId as string;
    expect((await h.call(employee, 'POST', `/v1/me/sensitive-changes/${requestId}/submit`, { expectedVersion: 1 })).statusCode).toBe(200);
    const task = ((await h.call(reviewer, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; request: { id: string } }[]).find((t) => t.request?.id === requestId)!;
    expect((await h.call(reviewer, 'POST', `/v1/sensitive-changes/tasks/${task.taskId}/start-review`)).json().state).toBe('IN_REVIEW');
    return { requestId, taskId: task.taskId };
  }

  it.each<[string, Fault, string]>([
    ['the profile revision', { table: 'employee_private_profile_revision', when: 'true' }, 'FaultCity One'],
    ['the audit event', { table: 'audit_event', when: `new.resource_code = 'employee_sensitive_change_request' and new.action = 'APPROVE'` }, 'FaultCity Two'],
    ['the outbox event', { table: 'outbox_event', when: `new.topic = 'sensitive_change.outcome'` }, 'FaultCity Three'],
  ])('an approval that fails at %s leaves the master untouched, and its retry applies one revision', async (_at, fault, city) => {
    const { requestId, taskId } = await inReview(city);
    await dispatchOutbox(h.pool);
    const { transaction_id: transactionId } = await requestFacts(requestId);
    const shown = await profile();
    const revisions = () => count(`from employee_private_profile_revision where company_id = $1 and source_request_id = $2`, [A.id, requestId]);
    const body = { decision: 'APPROVE', reason: 'Verified against synthetic evidence', idempotencyKey: uniq('zt18-sc-') };
    const url = `/v1/sensitive-changes/tasks/${taskId}/decision`;
    const before = await companyState(h, A.id);

    const run = await underFault(fault, `select count(*) from approval_decision where company_id = '${A.id}' and task_id = '${taskId}'`, () => h.call(reviewer, 'POST', url, body));
    expectFaulted(run, 1);

    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect(await taskState(taskId)).toBe('PENDING');
    expect(await requestFacts(requestId)).toMatchObject({ state: 'IN_REVIEW' });
    expect(await revisions()).toBe(0);
    expect(await profile()).toEqual(shown);
    expect(await auditOf('employee_sensitive_change_request', requestId, 'APPROVE')).toBe(0);
    expect(await outboxOf('sensitive_change.outcome', requestId)).toBe(0);
    await dispatchOutbox(h.pool);
    expect(await recipients(transactionId, 'SENSITIVE_CHANGE_OUTCOME')).toEqual([]);

    const retried = await h.call(reviewer, 'POST', url, body);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ requestId, state: 'APPLIED', replayed: false });
    expect((await h.call(reviewer, 'POST', url, body)).json()).toMatchObject({ requestId, state: 'APPLIED', replayed: true });
    expect(await revisions()).toBe(1);
    expect((await profile()).address).toMatchObject({ revision: shown.address.revision + 1, values: { city } });
    expect(await auditOf('employee_sensitive_change_request', requestId, 'APPROVE')).toBe(1);
    expect(await outboxOf('sensitive_change.outcome', requestId)).toBe(1);
    await dispatchOutbox(h.pool);
    expect(await recipients(transactionId, 'SENSITIVE_CHANGE_OUTCOME')).toEqual([employee.user]);
    expect((await inbox(bystander)).filter((n) => n.category === 'SENSITIVE_CHANGE_OUTCOME')).toEqual([]);
  });
});
