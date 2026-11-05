// Payment failure, reversal and duplicate callbacks over HTTP (gates-9: ZT14, ZT15, FR-077, BR-025, DF07, CI06). What is new here against
// expense.api.test.ts and payment-ledger.api.test.ts: an unknown outcome blocking a replacement through the route, a second failure
// releasing nothing, and duplicate callbacks made to overlap for real (test/held-lock.fixtures.ts), each judged on its end state: one event,
// one ledger movement, one audit row, one notice. Synthetic INR amounts and dates relative to today.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { raceBehindLock } from '../../test/held-lock.fixtures.js';
import type { PermissionKey } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { prepareReady, releaseNaming } from './payment.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let approver: TestActor;
let preparer: TestActor;
let settler: TestActor;
let manager: TestActor;
let employee: TestActor;

const DECIDE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];
const PREPARE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.prepare.operational'];
const SETTLE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.release.operational', 'payment.confirm_outcome.operational', 'payment.reverse.operational'];

const today = () => new Date().toISOString().slice(0, 10);
const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const act = (pi: string, path: string, body: object) => h.call(settler, 'POST', `/v1/expense/payments/${pi}/${path}`, body);
const outcome = (pi: string, kind: 'CONFIRMED' | 'FAILED', evidenceKey: string = uniq('bank-ref-')) => act(pi, 'outcome', { outcome: kind, evidenceKey });
const reversal = (pi: string, amount: string, evidenceKey: string = uniq('reversal-key-')) => act(pi, 'reversal', { amount, evidenceKey, reason: 'Bank return (synthetic)' });
const errorOf = (res: { statusCode: number; json(): { error?: string } }) => [res.statusCode, res.json().error];

const taskOf = async (a: TestActor, claimId: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
  return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
};
const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('fail-key-'), ...body });

/** A claim approved in full through the real route, ready to be paid. */
async function approvedClaim(amount: string): Promise<string> {
  const uploaded = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic receipt ${uniq('f')}\n%%EOF\n`).toString('base64') });
  expect(uploaded.statusCode, uploaded.body).toBe(201);
  const created = await h.call(employee, 'POST', '/v1/expense/claims', {
    purpose: 'Payment failure (synthetic)',
    currency: 'INR',
    lines: [{ category: 'OFFICE_SUPPLIES', expenseDate: today(), merchant: 'Synthetic Merchant', grossAmount: amount, claimedAmount: amount, description: 'Failure check (synthetic)', receipt: { receiptId: uploaded.json().receiptId } }],
  });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().claimId as string;
  expect((await h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(employee, id)).version })).statusCode).toBe(200);
  expect((await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
  const lines = (await view(approver, id)).lines as { id: string; claimedAmount: string }[];
  const res = await decide(approver, await taskOf(approver, id), { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
  expect(res.json().state, res.body).toBe('APPROVED');
  return id;
}

const prepare = (claimId: string, amount: string) => prepareReady(h, preparer, { claimId, amount, paymentDate: today(), idempotencyKey: uniq('pay-key-') });

/** An instruction of a READY batch released to the settler, whose outcome is now awaited. */
async function released(claimId: string, amount: string): Promise<string> {
  const prepared = await prepare(claimId, amount);
  expect(prepared.statusCode, prepared.body).toBe(201);
  const pi = prepared.json().instructionId as string;
  const res = await releaseNaming(h, settler, pi);
  expect(res.json().state, res.body).toBe('RELEASED');
  return pi;
}

const ledger = async (id: string) => {
  const c = await view(employee, id);
  return { paymentState: c.paymentState, ...c.payment };
};
const events = async (pi: string) =>
  (
    await h.db.query<{ id: string; kind: string; key: string; amount: string; reverses: string | null }>(
      `select id, event_kind as kind, event_key as key, amount::numeric(19,2)::text as amount, reverses_event_id as reverses from payment_event where company_id = $1 and instruction_id = $2 order by occurred_at, id`,
      [A.id, pi],
    )
  ).rows;
const instructionState = async (pi: string) => (await h.one<{ state: string }>(`select state from payment_instruction where id = $1`, [pi])).state;
const auditCount = async (pi: string, action: string) =>
  (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and resource_code = 'payment_instruction' and record_key = $2 and action = $3`, [A.id, pi, action])).n;
const instructionsOf = async (claimId: string) =>
  (
    await h.db.query<{ id: string; retry_of_id: string | null; state: string }>(
      `select i.id, i.retry_of_id, i.state from payment_instruction i join payment_allocation a on a.company_id = i.company_id and a.instruction_id = i.id
         join expense_obligation o on o.company_id = a.company_id and o.id = a.obligation_id where o.claim_id = $1 order by i.created_at`,
      [claimId],
    )
  ).rows;
/** The notices queued for this claim's payment, in order. */
const notices = async (claimId: string) =>
  (await h.db.query<{ event: string }>(`select payload->>'paymentEvent' as event from outbox_event where company_id = $1 and topic = 'expense.payment_status' and aggregate_id = $2 order by seq`, [A.id, claimId])).rows.map((r) => r.event);
/** What has reached the claimant so far, once the dispatcher has run. */
const inboxPaymentNotices = async () => {
  await dispatchOutbox(h.pool, 500);
  return ((await h.call(employee, 'GET', '/v1/me/notifications')).json().items as { category: string }[]).filter((n) => n.category === 'EXPENSE_PAYMENT_STATUS').length;
};
const instructionLock = (pi: string) => ({ sql: `select 1 from payment_instruction where id = $1 for update`, params: [pi] });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE });
  preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE });
  settler = await h.actor(A, 'HR_ADMINISTRATOR', { extra: SETTLE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, approver.user]);
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await person();
  const employeeId = await person();
  await h.call(hr, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('an unknown outcome stays pending and blocks a replacement (ZT15, BR-025, DF07)', () => {
  it('a released instruction with no outcome keeps its whole reservation: no further preparation of any size, nothing paid, nothing changed', async () => {
    const id = await approvedClaim('300');
    const pi = await released(id, '300');
    expect(await ledger(id)).toMatchObject({ paymentState: 'UNPAID', approvedAmount: '300.0000', netPaid: '0.0000', pending: '300.0000', outstanding: '300.0000' });

    const before = await companyState(h, A.id);
    for (const amount of ['300', '0.01']) {
      expect(errorOf(await prepare(id, amount)), amount).toEqual([422, 'EXCEEDS_OUTSTANDING']);
    }
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect(await instructionState(pi)).toBe('RELEASED');
    expect(await events(pi)).toEqual([]);
    expect((await instructionsOf(id)).map((i) => i.id)).toEqual([pi]);
    const payable = ((await h.call(preparer, 'GET', '/v1/expense/payables')).json().items as { claimId: string; allocatable: string }[]).find((p) => p.claimId === id);
    expect(payable).toMatchObject({ allocatable: '0.00', pending: '300.00', netPaid: '0.00' });
  });

  it('an unknown outcome on part of a claim holds that part: paid plus pending never passes the approved amount', async () => {
    const id = await approvedClaim('300');
    await released(id, '100');
    expect(errorOf(await prepare(id, '200.01'))).toEqual([422, 'EXCEEDS_OUTSTANDING']);
    expect((await prepare(id, '200')).statusCode).toBe(201);
    expect(await ledger(id)).toMatchObject({ netPaid: '0.0000', pending: '300.0000', outstanding: '300.0000' });
    expect(errorOf(await prepare(id, '0.01'))).toEqual([422, 'EXCEEDS_OUTSTANDING']);
  });
});

describe('a definitive failure releases once (ZT15, DF07)', () => {
  it('a replayed or repeated FAILED frees nothing more, even with a replacement now holding the same amount', async () => {
    const id = await approvedClaim('300');
    const pi = await released(id, '300');
    const key = uniq('failure-key-');
    const failed = await outcome(pi, 'FAILED', key);
    expect(failed.json()).toEqual({ instructionId: pi, state: 'FAILED', replayed: false });
    expect(await ledger(id)).toMatchObject({ paymentState: 'UNPAID', netPaid: '0.0000', pending: '0.0000', outstanding: '300.0000' });

    const replacement = await prepare(id, '300');
    expect(replacement.statusCode, replacement.body).toBe(201);
    expect(await ledger(id)).toMatchObject({ pending: '300.0000' });

    // The replay is answered as the first one, and frees nothing: the replacement's reservation stands.
    expect((await outcome(pi, 'FAILED', key)).json()).toEqual({ instructionId: pi, state: 'FAILED', replayed: true });
    expect(await ledger(id)).toMatchObject({ pending: '300.0000', netPaid: '0.0000' });
    // A second failure under another key is refused, and frees nothing either.
    expect(errorOf(await outcome(pi, 'FAILED'))).toEqual([409, 'INVALID_STATE']);
    expect(await ledger(id)).toMatchObject({ pending: '300.0000', netPaid: '0.0000' });
    // Over-allocating on the strength of a second release is refused too.
    expect(errorOf(await prepare(id, '0.01'))).toEqual([422, 'EXCEEDS_OUTSTANDING']);

    expect((await events(pi)).map((e) => [e.kind, e.key, e.amount])).toEqual([['FAILED', key, '300.00']]);
    expect(await auditCount(pi, 'FAILED')).toBe(1);
    expect(await notices(id)).toEqual(['FAILED']);
  });

  it('a settled instruction takes no other outcome: failed is not then confirmed, confirmed is not then failed, and a key keeps its meaning', async () => {
    const lost = await approvedClaim('120');
    const failedPi = await released(lost, '120');
    const failureKey = uniq('failure-key-');
    expect((await outcome(failedPi, 'FAILED', failureKey)).statusCode).toBe(200);
    expect(errorOf(await outcome(failedPi, 'CONFIRMED'))).toEqual([409, 'INVALID_STATE']);
    expect(errorOf(await outcome(failedPi, 'CONFIRMED', failureKey))).toEqual([409, 'EVIDENCE_KEY_REUSED']);
    expect(errorOf(await reversal(failedPi, '1'))).toEqual([409, 'INVALID_STATE']);
    expect(await instructionState(failedPi)).toBe('FAILED');
    expect(await ledger(lost)).toMatchObject({ paymentState: 'UNPAID', netPaid: '0.0000', pending: '0.0000' });

    const paid = await approvedClaim('130');
    const paidPi = await released(paid, '130');
    const bankRef = uniq('bank-ref-');
    expect((await outcome(paidPi, 'CONFIRMED', bankRef)).statusCode).toBe(200);
    expect(errorOf(await outcome(paidPi, 'FAILED'))).toEqual([409, 'INVALID_STATE']);
    expect(errorOf(await outcome(paidPi, 'FAILED', bankRef))).toEqual([409, 'EVIDENCE_KEY_REUSED']);
    expect(await instructionState(paidPi)).toBe('CONFIRMED');
    expect(await ledger(paid)).toMatchObject({ paymentState: 'PAID', netPaid: '130.0000', outstanding: '0.0000', pending: '0.0000' });
    expect((await events(paidPi)).map((e) => e.kind)).toEqual(['CONFIRMED']);
  });

  it('a reversal needs a confirmed payment: a released one with its outcome unknown is refused and stays pending', async () => {
    const id = await approvedClaim('140');
    const pi = await released(id, '140');
    expect(errorOf(await reversal(pi, '1'))).toEqual([409, 'INVALID_STATE']);
    expect(await events(pi)).toEqual([]);
    expect(await ledger(id)).toMatchObject({ netPaid: '0.0000', pending: '140.0000' });
  });
});

describe('duplicate callbacks at the same moment do no more than one (ZT14, ZT15)', () => {
  it('the same confirmation twice: one event, one movement, one audit, one notice; the other is the replay', async () => {
    const id = await approvedClaim('210');
    const pi = await released(id, '210');
    const notifiedBefore = await inboxPaymentNotices();
    const key = uniq('bank-ref-');
    const [one, two] = await raceBehindLock(h, instructionLock(pi), [() => outcome(pi, 'CONFIRMED', key), () => outcome(pi, 'CONFIRMED', key)]);
    expect([one!.statusCode, two!.statusCode]).toEqual([200, 200]);
    expect([one!.json().replayed, two!.json().replayed].sort()).toEqual([false, true]);
    expect((await events(pi)).map((e) => [e.kind, e.key, e.amount])).toEqual([['CONFIRMED', key, '210.00']]);
    expect(await ledger(id)).toMatchObject({ paymentState: 'PAID', netPaid: '210.0000', pending: '0.0000', outstanding: '0.0000' });
    expect(await auditCount(pi, 'CONFIRMED')).toBe(1);
    expect(await notices(id)).toEqual(['CONFIRMED']);
    expect((await inboxPaymentNotices()) - notifiedBefore).toBe(1);
  });

  it('the same failure twice: the reservation is freed once, with one event, one audit and one notice', async () => {
    const id = await approvedClaim('220');
    const pi = await released(id, '220');
    const key = uniq('failure-key-');
    const [one, two] = await raceBehindLock(h, instructionLock(pi), [() => outcome(pi, 'FAILED', key), () => outcome(pi, 'FAILED', key)]);
    expect([one!.statusCode, two!.statusCode]).toEqual([200, 200]);
    expect([one!.json().replayed, two!.json().replayed].sort()).toEqual([false, true]);
    expect((await events(pi)).map((e) => e.kind)).toEqual(['FAILED']);
    expect(await ledger(id)).toMatchObject({ paymentState: 'UNPAID', netPaid: '0.0000', pending: '0.0000', outstanding: '220.0000' });
    expect(await auditCount(pi, 'FAILED')).toBe(1);
    expect(await notices(id)).toEqual(['FAILED']);
  });

  it('two confirmations under different evidence keys: one records, the other is refused, and paid does not double', async () => {
    const id = await approvedClaim('230');
    const pi = await released(id, '230');
    const results = await raceBehindLock(h, instructionLock(pi), [() => outcome(pi, 'CONFIRMED'), () => outcome(pi, 'CONFIRMED')]);
    expect(results.map(errorOf).sort()).toEqual([[200, undefined], [409, 'INVALID_STATE']]);
    expect((await events(pi)).map((e) => e.kind)).toEqual(['CONFIRMED']);
    expect(await ledger(id)).toMatchObject({ paymentState: 'PAID', netPaid: '230.0000', pending: '0.0000' });
    expect(await auditCount(pi, 'CONFIRMED')).toBe(1);
    expect(await notices(id)).toEqual(['CONFIRMED']);
  });

  it('a confirmation and a failure: exactly one settles it, and the ledger, audit and notice follow that one', async () => {
    const id = await approvedClaim('240');
    const pi = await released(id, '240');
    const kinds = ['CONFIRMED', 'FAILED'] as const;
    const results = await raceBehindLock(h, instructionLock(pi), kinds.map((k) => () => outcome(pi, k)));
    const winner = kinds[results.findIndex((r) => r.statusCode === 200)]!;
    expect(results.map(errorOf).sort()).toEqual([[200, undefined], [409, 'INVALID_STATE']]);
    expect(await instructionState(pi)).toBe(winner);
    expect((await events(pi)).map((e) => e.kind)).toEqual([winner]);
    expect(await ledger(id)).toMatchObject(
      winner === 'CONFIRMED' ? { paymentState: 'PAID', netPaid: '240.0000', pending: '0.0000', outstanding: '0.0000' } : { paymentState: 'UNPAID', netPaid: '0.0000', pending: '0.0000', outstanding: '240.0000' },
    );
    expect([await auditCount(pi, 'CONFIRMED'), await auditCount(pi, 'FAILED')]).toEqual(winner === 'CONFIRMED' ? [1, 0] : [0, 1]);
    expect(await notices(id)).toEqual([winner]);
  });

  it('the same reversal twice: net paid moves once, with one event, one audit and one notice', async () => {
    const id = await approvedClaim('250');
    const pi = await released(id, '250');
    expect((await outcome(pi, 'CONFIRMED')).statusCode).toBe(200);
    const key = uniq('reversal-key-');
    const [one, two] = await raceBehindLock(h, instructionLock(pi), [() => reversal(pi, '50', key), () => reversal(pi, '50', key)]);
    expect([one!.statusCode, two!.statusCode]).toEqual([200, 200]);
    expect([one!.json().replayed, two!.json().replayed].sort()).toEqual([false, true]);
    expect((await events(pi)).filter((e) => e.kind === 'REVERSED').map((e) => [e.key, e.amount])).toEqual([[key, '50.00']]);
    expect(await ledger(id)).toMatchObject({ paymentState: 'PART_PAID', netPaid: '200.0000', outstanding: '50.0000' });
    expect(await auditCount(pi, 'REVERSE')).toBe(1);
    expect(await notices(id)).toEqual(['CONFIRMED', 'REVERSED']);
  });

  it('two reversals under different keys that together pass the payment: one records, the other is refused', async () => {
    const id = await approvedClaim('260');
    const pi = await released(id, '260');
    expect((await outcome(pi, 'CONFIRMED')).statusCode).toBe(200);
    const results = await raceBehindLock(h, instructionLock(pi), [() => reversal(pi, '200'), () => reversal(pi, '200')]);
    expect(results.map(errorOf).sort()).toEqual([[200, undefined], [422, 'RULE_VIOLATION']]);
    expect((await events(pi)).filter((e) => e.kind === 'REVERSED').map((e) => e.amount)).toEqual(['200.00']);
    expect(await ledger(id)).toMatchObject({ paymentState: 'PART_PAID', netPaid: '60.0000', outstanding: '200.0000' });
    expect(await auditCount(pi, 'REVERSE')).toBe(1);
    expect(await notices(id)).toEqual(['CONFIRMED', 'REVERSED']);
  });

  it('two preparations under different keys for the whole amount: one reserves, the other is refused', async () => {
    const id = await approvedClaim('270');
    const obligation = (await h.one<{ id: string }>(`select id from expense_obligation where claim_id = $1`, [id])).id;
    const body = () => ({ claimId: id, amount: '270', paymentDate: today(), idempotencyKey: uniq('pay-key-') });
    const results = await raceBehindLock(h, { sql: `select 1 from expense_obligation where id = $1 for update`, params: [obligation] }, [
      () => h.call(preparer, 'POST', '/v1/expense/payments', body()),
      () => h.call(preparer, 'POST', '/v1/expense/payments', body()),
    ]);
    expect(results.map(errorOf).sort()).toEqual([[201, undefined], [422, 'EXCEEDS_OUTSTANDING']]);
    expect(await instructionsOf(id)).toHaveLength(1);
    expect(await ledger(id)).toMatchObject({ netPaid: '0.0000', pending: '270.0000' });
  });
});

describe('reversals reconcile to the payment they return (FR-077, BR-025, DF07)', () => {
  it('add up to the confirmed amount and no further; the original evidence stands; outstanding is right at every step', async () => {
    const id = await approvedClaim('500');
    const pi = await released(id, '500');
    const bankRef = uniq('bank-ref-');
    expect((await outcome(pi, 'CONFIRMED', bankRef)).statusCode).toBe(200);
    const [confirmation] = await events(pi);
    expect(await ledger(id)).toMatchObject({ paymentState: 'PAID', netPaid: '500.0000', outstanding: '0.0000' });

    expect((await reversal(pi, '100')).json().replayed).toBe(false);
    expect(await ledger(id)).toMatchObject({ paymentState: 'PART_PAID', netPaid: '400.0000', outstanding: '100.0000' });

    // The cap counts what was already returned: 100 + 401 is more than 500, though 401 alone is not.
    expect(errorOf(await reversal(pi, '401'))).toEqual([422, 'RULE_VIOLATION']);
    expect(await ledger(id)).toMatchObject({ paymentState: 'PART_PAID', netPaid: '400.0000', outstanding: '100.0000' });

    expect((await reversal(pi, '400')).json().replayed).toBe(false);
    expect(await ledger(id)).toMatchObject({ paymentState: 'UNPAID', netPaid: '0.0000', outstanding: '500.0000', pending: '0.0000' });
    expect(errorOf(await reversal(pi, '0.01'))).toEqual([422, 'RULE_VIOLATION']);

    // BR-025: the confirmation is kept as it was recorded, and every reversal names it; the instruction stays CONFIRMED.
    const all = await events(pi);
    expect(all.map((e) => [e.kind, e.amount])).toEqual([['CONFIRMED', '500.00'], ['REVERSED', '100.00'], ['REVERSED', '400.00']]);
    expect(all[0]).toMatchObject({ id: confirmation!.id, key: bankRef, reverses: null });
    expect(all.slice(1).map((e) => e.reverses)).toEqual([confirmation!.id, confirmation!.id]);
    expect(await instructionState(pi)).toBe('CONFIRMED');
    expect(await notices(id)).toEqual(['CONFIRMED', 'REVERSED', 'REVERSED']);

    // What came back can be paid again, and no more than that.
    expect(errorOf(await prepare(id, '500.01'))).toEqual([422, 'EXCEEDS_OUTSTANDING']);
    expect((await prepare(id, '500')).statusCode).toBe(201);
    expect(await ledger(id)).toMatchObject({ netPaid: '0.0000', pending: '500.0000' });
  });
});

describe('a replacement names the instruction it replaces (CI06, BR-025)', () => {
  const retry = (claimId: string, amount: string, retryOfInstructionId: string, idempotencyKey?: string) =>
    h.call(preparer, 'POST', '/v1/expense/payments', { claimId, amount, paymentDate: today(), idempotencyKey: idempotencyKey ?? uniq('pay-key-'), retryOfInstructionId });

  it('only once its outcome is definitively a failure: prepared and unknown instructions are refused through the route', async () => {
    const id = await approvedClaim('310');
    const first = await prepare(id, '110');
    const pi = first.json().instructionId as string;
    expect(errorOf(await retry(id, '110', pi))).toEqual([409, 'RETRY_PRIOR_NOT_SETTLED']);
    expect((await releaseNaming(h, settler, pi)).statusCode).toBe(200);
    expect(errorOf(await retry(id, '110', pi))).toEqual([409, 'RETRY_PRIOR_NOT_SETTLED']);
    const paid = await approvedClaim('60');
    const paidPi = await released(paid, '60');
    expect((await outcome(paidPi, 'CONFIRMED')).statusCode).toBe(200);
    expect(errorOf(await retry(paid, '60', paidPi))).toEqual([409, 'RETRY_PRIOR_NOT_SETTLED']);
    expect(await instructionsOf(id)).toHaveLength(1);
    expect(await ledger(id)).toMatchObject({ pending: '110.0000' });
  });

  it('after a failure it is linked to what it replaces, for that liability, once; the audit says so; the same request replays', async () => {
    const id = await approvedClaim('320');
    const pi = await released(id, '320');
    expect((await outcome(pi, 'FAILED')).statusCode).toBe(200);

    const other = await approvedClaim('70');
    expect(errorOf(await retry(other, '70', pi))).toEqual([422, 'RETRY_NOT_SAME_LIABILITY']);
    expect(await ledger(other)).toMatchObject({ pending: '0.0000' });
    expect(errorOf(await retry(id, '70', other))).toEqual([422, 'RETRY_NOT_SAME_LIABILITY']);
    expect(await instructionsOf(id)).toHaveLength(1);

    const key = uniq('pay-key-');
    const linked = await retry(id, '320', pi, key);
    expect(linked.statusCode, linked.body).toBe(201);
    const replacementId = linked.json().instructionId as string;
    expect((await instructionsOf(id)).map((i) => [i.id, i.retry_of_id])).toEqual([
      [pi, null],
      [replacementId, pi],
    ]);
    expect(await ledger(id)).toMatchObject({ netPaid: '0.0000', pending: '320.0000' });
    const audited = await h.one<{ after_values: { operational: { retryOfInstructionId: string } } }>(`select after_values from audit_event where company_id = $1 and record_key = $2 and action = 'PREPARE'`, [A.id, replacementId]);
    expect(audited.after_values.operational.retryOfInstructionId).toBe(pi);

    // The same request replays; the key under another link is another request, refused.
    expect((await retry(id, '320', pi, key)).json()).toMatchObject({ instructionId: replacementId, replayed: true });
    const unlinked = await h.call(preparer, 'POST', '/v1/expense/payments', { claimId: id, amount: '320', paymentDate: today(), idempotencyKey: key });
    expect(errorOf(unlinked)).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    // It replaces once.
    expect(errorOf(await retry(id, '1', pi))).toEqual([409, 'ALREADY_RETRIED']);
    expect(await instructionsOf(id)).toHaveLength(2);
  });

  it('two replacements of one failure at the same moment: one links, the other is refused, one reservation', async () => {
    const id = await approvedClaim('330');
    const pi = await released(id, '330');
    expect((await outcome(pi, 'FAILED')).statusCode).toBe(200);
    const obligation = (await h.one<{ id: string }>(`select id from expense_obligation where claim_id = $1`, [id])).id;
    const results = await raceBehindLock(h, { sql: `select 1 from expense_obligation where id = $1 for update`, params: [obligation] }, [() => retry(id, '330', pi), () => retry(id, '330', pi)]);
    expect(results.map(errorOf).sort()).toEqual([[201, undefined], [409, 'ALREADY_RETRIED']]);
    const all = await instructionsOf(id);
    expect(all.filter((i) => i.retry_of_id === pi)).toHaveLength(1);
    expect(all).toHaveLength(2);
    expect(await ledger(id)).toMatchObject({ pending: '330.0000', netPaid: '0.0000' });
  });
});

describe('mixed payroll and direct payout (ZT14)', () => {
  // DF07 wave 1 does not reimburse through payroll, and nothing links a payroll REIMBURSEMENT input to an expense obligation, so there is no route to race.
  it.skip('a claim paid part through payroll and part directly does not exceed one obligation', () => undefined);
});
