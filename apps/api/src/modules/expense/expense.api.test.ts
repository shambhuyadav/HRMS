// Expense claims and payment-outcome tracking over HTTP (FR-070-FR-079; BR-017-BR-025; C5; DF06; DF07;
// CI03-CI06; ZT04, ZT11, ZT13, ZT14, ZT15). Synthetic INR amounts; dates relative to today.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { METRIC_SOURCES } from '../dashboard/sources.js';
import { EXPENSE_METRICS } from './metrics.js';
import { prepareReady, releaseNaming } from './payment.fixtures.js';
import { releasePayment } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let fin1: TestActor;
let fin2: TestActor;
let fin3: TestActor;
let manager: TestActor;
let employee: TestActor;
let managerEmp: string;

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

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
/** Uploads a synthetic PDF receipt (unique bytes unless given) as the claimant and returns the line reference. */
const uploadReceipt = async (a: TestActor, bytes = `%PDF-1.4\n% synthetic receipt ${uniq('r')}\n%%EOF\n`) => {
  const res = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'receipt.pdf', contentBase64: Buffer.from(bytes).toString('base64') });
  expect(res.statusCode).toBe(201);
  return { receiptId: res.json().receiptId as string };
};
/** Placeholder replaced by a freshly uploaded receipt when the claim is sent. */
const FRESH = { fresh: true } as const;
const withReceipts = async (a: TestActor, lines: object[]) =>
  Promise.all(lines.map(async (l) => ((l as { receipt?: unknown }).receipt === FRESH ? { ...l, receipt: await uploadReceipt(a) } : l)));
const line = (category: string, amount: string, extra: Record<string, unknown> = {}) => ({
  category,
  expenseDate: daysAgo(3),
  merchant: 'Synthetic Merchant',
  grossAmount: amount,
  claimedAmount: amount,
  description: `${category} (synthetic)`,
  receipt: FRESH,
  ...extra,
});

const draft = async (a: TestActor, lines: object[], currency = 'INR') =>
  h.call(a, 'POST', '/v1/expense/claims', { purpose: 'Client visit (synthetic)', currency, lines: await withReceipts(a, lines) });
const claim = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const submit = async (a: TestActor, id: string) => h.call(a, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await claim(a, id)).version });
const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string; ownerEmployeeId: string }[];
const taskOf = async (a: TestActor, claimId: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
  return (await tasks(a)).find((t) => t.transactionId === tx);
};
const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('exp-key-'), ...body });
const approveAllLines = async (a: TestActor, claimId: string, taskId: string, amount?: (claimed: string) => string) => {
  const c = await claim(a, claimId);
  return decide(a, taskId, {
    decision: 'APPROVE',
    lines: c.lines.map((l: { id: string; claimedAmount: string }) => ({
      lineId: l.id,
      allowedAmount: amount ? amount(l.claimedAmount) : l.claimedAmount,
      ...(amount ? { reason: 'Policy adjustment (synthetic)' } : {}),
    })),
  });
};

/** Drafts, submits and pushes a claim through manager and finance approval with full line amounts. */
async function approvedClaim(lines: object[]): Promise<string> {
  const id = (await draft(employee, lines)).json().claimId;
  expect((await submit(employee, id)).statusCode).toBe(200);
  await decide(manager, (await taskOf(manager, id))!.taskId, { decision: 'APPROVE' });
  const res = await approveAllLines(fin1, id, (await taskOf(fin1, id))!.taskId);
  expect(res.json()).toMatchObject({ state: 'APPROVED' });
  return id;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  fin1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin3 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  await h.db.query(
    `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true), ($1, 'expense_claim', $3, 2, true), ($1, 'expense_claim', $4, 3, true)`,
    [A.id, fin1.user, fin2.user, fin3.user],
  );
  const create = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  managerEmp = await create();
  const employeeEmp = await create();
  await h.call(hr, 'POST', `/v1/employees/${employeeEmp}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('policy and submission validation (FR-071, FR-078, DF06)', () => {
  it('a DRAFT policy blocks submission; HR activates it independently', async () => {
    const id = (await draft(employee, [line('OTHER', '100')])).json().claimId;
    const blocked = await submit(employee, id);
    expect(blocked.json().error).toBe('POLICY_NOT_FOUND');
    const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
    expect(policy).toMatchObject({ currency: 'INR', submissionWindowDays: 30, highValueThreshold: '50000.0000', state: 'DRAFT' });
    expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
    expect((await submit(employee, id)).statusCode).toBe(200);
  });

  it('refuses future dates and unsupported currency; flags over-limit, late and missing receipts until explained', async () => {
    const future = (await draft(employee, [line('OTHER', '100', { expenseDate: daysAgo(-5) })])).json().claimId;
    expect((await submit(employee, future)).json()).toMatchObject({ error: 'CLAIM_INVALID', details: { errors: [{ line: 1, code: 'FUTURE_EXPENSE_DATE' }] } });

    const usd = (await draft(employee, [line('OTHER', '100')], 'USD')).json().claimId;
    expect((await submit(employee, usd)).json().error).toBe('UNSUPPORTED_CURRENCY');

    const flagged = (
      await draft(employee, [line('MEALS', '1500', { expenseDate: daysAgo(5) }), line('OTHER', '50', { expenseDate: daysAgo(40) }), line('TRAVEL', '200', { receipt: undefined })])
    ).json().claimId;
    const res = await submit(employee, flagged);
    expect(res.json()).toMatchObject({
      error: 'EXCEPTION_REASON_REQUIRED',
      details: {
        lines: [
          { line: 1, flags: ['OVER_LIMIT'] },
          { line: 2, flags: ['LATE_SUBMISSION'] },
          { line: 3, flags: ['RECEIPT_MISSING'] },
        ],
      },
    });

    const c = await claim(employee, flagged);
    await h.call(employee, 'PUT', `/v1/expense/claims/${flagged}`, {
      expectedVersion: c.version,
      purpose: 'Client visit (synthetic)',
      currency: 'INR',
      lines: await withReceipts(employee, [
        line('MEALS', '1500', { expenseDate: daysAgo(5), exceptionReason: 'Client dinner (synthetic)' }),
        line('OTHER', '50', { expenseDate: daysAgo(40), exceptionReason: 'Was travelling (synthetic)' }),
        line('TRAVEL', '200', { receipt: undefined, exceptionReason: 'Lost receipt (synthetic)' }),
      ]),
    });
    expect((await submit(employee, flagged)).statusCode).toBe(200);
    expect((await claim(employee, flagged)).lines.map((l: { exceptionFlags: string[] }) => l.exceptionFlags)).toEqual([['OVER_LIMIT'], ['LATE_SUBMISSION'], ['RECEIPT_MISSING']]);
  });

  it('flags reuse of a receipt from another live claim as a suspected duplicate (same upload or re-uploaded copy)', async () => {
    const bytes = `%PDF-1.4\n% shared synthetic receipt ${uniq('s')}\n%%EOF\n`;
    const shared = await uploadReceipt(employee, bytes);
    const first = (await draft(employee, [line('OTHER', '120', { receipt: shared })])).json().claimId;
    await submit(employee, first);
    const duplicate = { error: 'EXCEPTION_REASON_REQUIRED', details: { lines: [{ line: 1, flags: ['DUPLICATE_SUSPECTED'] }] } };
    const copy = (await draft(employee, [line('OTHER', '130', { receipt: await uploadReceipt(employee, bytes) })])).json().claimId;
    expect((await submit(employee, copy)).json()).toMatchObject(duplicate);
    const sameUpload = (await draft(employee, [line('OTHER', '140', { receipt: shared })])).json().claimId;
    expect((await submit(employee, sameUpload)).json()).toMatchObject(duplicate);
  });

  it('accepts only real PDF/JPEG/PNG receipts uploaded by the claimant', async () => {
    const fake = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from('not a receipt').toString('base64') });
    expect(fake.json().error).toBe('UNSUPPORTED_FILE');
    const colleagueEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
    const colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueEmp });
    const res = await draft(employee, [line('OTHER', '10', { receipt: await uploadReceipt(colleague) })]);
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('INVALID_RECEIPT');
  });
});

describe('review route and entitlement (FR-072, FR-073, C5, CI03, CI04, ZT13)', () => {
  it('F3: lines 600 + 400 approved at 500 + 300 give one 800 obligation; reductions need reasons; all lines needed', async () => {
    const id = (await draft(employee, [line('OFFICE_SUPPLIES', '600'), line('OTHER', '400', { exceptionReason: 'n/a' })])).json().claimId;
    await submit(employee, id);
    expect((await h.call(employee, 'PUT', `/v1/expense/claims/${id}`, { expectedVersion: (await claim(employee, id)).version, purpose: 'x', currency: 'INR', lines: await withReceipts(employee, [line('OTHER', '1')]) })).statusCode).toBe(409);

    expect((await decide(employee, (await taskOf(manager, id))!.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);
    expect((await decide(manager, (await taskOf(manager, id))!.taskId, { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');

    const financeTask = (await taskOf(fin1, id))!;
    const lines = (await claim(fin1, id)).lines as { id: string }[];
    expect((await decide(fin1, financeTask.taskId, { decision: 'APPROVE', lines: [{ lineId: lines[0]!.id, allowedAmount: '500', reason: 'Cap' }] })).json().error).toBe('ALL_LINES_REQUIRED');
    const noReason = await decide(fin1, financeTask.taskId, {
      decision: 'APPROVE',
      lines: [
        { lineId: lines[0]!.id, allowedAmount: '500' },
        { lineId: lines[1]!.id, allowedAmount: '300', reason: 'Cap' },
      ],
    });
    expect(noReason.statusCode).toBe(422);
    const tooMuch = await decide(fin1, financeTask.taskId, {
      decision: 'APPROVE',
      lines: [
        { lineId: lines[0]!.id, allowedAmount: '700', reason: 'x' },
        { lineId: lines[1]!.id, allowedAmount: '300', reason: 'x' },
      ],
    });
    expect(tooMuch.statusCode).toBe(422);

    const approved = await decide(fin1, financeTask.taskId, {
      decision: 'APPROVE',
      lines: [
        { lineId: lines[0]!.id, allowedAmount: '500', reason: 'Above usual price (synthetic)' },
        { lineId: lines[1]!.id, allowedAmount: '300', reason: 'Partly personal (synthetic)' },
      ],
    });
    expect(approved.json()).toMatchObject({ state: 'APPROVED', approvedAmount: '800.0000', paymentState: 'UNPAID' });
    const view = await claim(employee, id);
    expect(view.lines.map((l: { approvedAmount: string }) => l.approvedAmount)).toEqual(['500.0000', '300.0000']);
    expect(view.payment).toMatchObject({ approvedAmount: '800.0000', netPaid: '0.0000', outstanding: '800.0000' });
    // Receipts: presence only, never their reference or content for the claimant.
    expect(view.lines[0].receiptPresent).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/mem:|contentReference|checksum/);
  });

  it('routes above 50,000 to a distinct high-value approver; exactly 50,000 does not need one', async () => {
    // Fresh receipts per claim: reusing one claim's receipts in another is (correctly) a suspected duplicate.
    const fiveK = () => Array.from({ length: 10 }, () => line('TRAVEL', '5000'));
    const atThreshold = (await draft(employee, fiveK())).json().claimId;
    await submit(employee, atThreshold);
    await decide(manager, (await taskOf(manager, atThreshold))!.taskId, { decision: 'APPROVE' });
    expect((await approveAllLines(fin1, atThreshold, (await taskOf(fin1, atThreshold))!.taskId)).json().state).toBe('APPROVED');

    const above = (await draft(employee, [...fiveK(), line('OTHER', '0.01')])).json().claimId;
    expect((await submit(employee, above)).json()).toMatchObject({ state: 'MANAGER_PENDING' });
    await decide(manager, (await taskOf(manager, above))!.taskId, { decision: 'APPROVE' });
    expect((await approveAllLines(fin1, above, (await taskOf(fin1, above))!.taskId)).json().state).toBe('HIGH_VALUE_PENDING');
    expect(await taskOf(fin1, above)).toBeUndefined(); // the finance approver never gets the next step
    const hv = (await taskOf(fin2, above))!;
    expect((await decide(fin2, hv.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'APPROVED', approvedAmount: '50000.0100' });
  });

  it('a manager’s own claim goes to the fallback list, and finance review goes to someone else', async () => {
    const managerSelf = await h.actor(A, 'EMPLOYEE', { user: manager.user });
    const id = (await draft(managerSelf, [line('OTHER', '100')])).json().claimId;
    await submit(managerSelf, id);
    expect(await taskOf(manager, id)).toBeUndefined();
    const managerStep = (await taskOf(fin1, id))!;
    expect((await decide(fin1, managerStep.taskId, { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    expect(await taskOf(fin1, id)).toBeUndefined();
    expect(await taskOf(fin2, id)).toBeDefined();
  });

  it('zero entitlement is a valid approval with no payable amount and no obligation', async () => {
    const id = (await draft(employee, [line('OTHER', '90')])).json().claimId;
    await submit(employee, id);
    await decide(manager, (await taskOf(manager, id))!.taskId, { decision: 'APPROVE' });
    expect((await approveAllLines(fin1, id, (await taskOf(fin1, id))!.taskId, () => '0')).json()).toMatchObject({ state: 'APPROVED', paymentState: 'NO_PAYABLE_AMOUNT' });
    const pay = await prepareReady(h, fin2,{ claimId: id, amount: '1', paymentDate: daysAgo(0), idempotencyKey: uniq('pay-key-') });
    expect(pay.statusCode).toBe(404);
  });

  it('a returned claim is revised as a new revision and resubmitted; earlier facts are kept', async () => {
    const id = (await draft(employee, [line('OTHER', '80')])).json().claimId;
    await submit(employee, id);
    expect((await decide(manager, (await taskOf(manager, id))!.taskId, { decision: 'RETURN' })).statusCode).toBe(422); // reason required
    expect((await decide(manager, (await taskOf(manager, id))!.taskId, { decision: 'RETURN', reason: 'Add detail' })).json().state).toBe('RETURNED');
    const c = await claim(employee, id);
    expect((await h.call(employee, 'PUT', `/v1/expense/claims/${id}`, { expectedVersion: c.version, purpose: 'More detail (synthetic)', currency: 'INR', lines: await withReceipts(employee, [line('OTHER', '75')]) })).json().revision).toBe(2);
    expect((await submit(employee, id)).json()).toMatchObject({ state: 'MANAGER_PENDING', revision: 2 });
    const revisions = await h.one<{ n: string }>(`select count(*) as n from expense_revision where claim_id = $1 and submitted_at is not null`, [id]);
    expect(Number(revisions.n)).toBe(2);
  });
});

describe('payments (FR-076, FR-077, DF07, C4, CI05, CI06, ZT14, ZT15)', () => {
  it('DF07 example: approve 1000, pay 600, reverse 100 -> net 500, outstanding 500; pending 300 leaves 200', async () => {
    const id = await approvedClaim([line('OFFICE_SUPPLIES', '600'), line('OTHER', '400', { exceptionReason: 'Over limit approved (synthetic)' })]);
    const pay = (amount: string, a = fin2, key = uniq('pay-key-')) => prepareReady(h, a, { claimId: id, amount, paymentDate: daysAgo(0), idempotencyKey: key });

    const first = (await pay('600')).json();
    expect(first.state).toBe('PREPARED');
    expect((await pay('500')).json().error).toBe('EXCEEDS_OUTSTANDING'); // 1000 - 600 pending = 400

    // C4: neither the entitlement approver (fin1) nor the preparer (fin2) may release; fin3 may.
    expect((await releaseNaming(h, fin1, first.instructionId)).statusCode).toBe(403);
    expect((await releaseNaming(h, fin2, first.instructionId)).statusCode).toBe(403);
    expect((await releaseNaming(h, fin3, first.instructionId)).json().state).toBe('RELEASED');
    expect((await claim(employee, id)).paymentState).toBe('UNPAID'); // released is not paid

    const evidence = uniq('bank-ref-');
    expect((await h.call(fin3, 'POST', `/v1/expense/payments/${first.instructionId}/outcome`, { outcome: 'CONFIRMED', evidenceKey: evidence })).json().state).toBe('CONFIRMED');
    expect((await h.call(fin3, 'POST', `/v1/expense/payments/${first.instructionId}/outcome`, { outcome: 'CONFIRMED', evidenceKey: evidence })).json().replayed).toBe(true);
    expect((await claim(employee, id))).toMatchObject({ paymentState: 'PART_PAID', payment: { netPaid: '600.0000', outstanding: '400.0000' } });

    expect((await h.call(fin3, 'POST', `/v1/expense/payments/${first.instructionId}/reversal`, { amount: '100', evidenceKey: uniq('reversal-key-'), reason: 'Bank return (synthetic)' })).statusCode).toBe(200);
    expect((await h.call(fin3, 'POST', `/v1/expense/payments/${first.instructionId}/reversal`, { amount: '600', evidenceKey: uniq('reversal-key-'), reason: 'Too much' })).statusCode).toBe(422);
    expect((await claim(employee, id)).payment).toMatchObject({ netPaid: '500.0000', outstanding: '500.0000', pending: '0.0000' });

    const pending = (await pay('300')).json();
    expect((await claim(employee, id)).payment.pending).toBe('300.0000');
    expect((await pay('201')).json().error).toBe('EXCEEDS_OUTSTANDING');
    const two = (await pay('200')).json();
    expect(two.state).toBe('PREPARED');

    // A definitive failure releases its reservation once.
    await releaseNaming(h, fin3, pending.instructionId);
    await h.call(fin3, 'POST', `/v1/expense/payments/${pending.instructionId}/outcome`, { outcome: 'FAILED', evidenceKey: uniq('failure-key-') });
    expect((await claim(employee, id)).payment).toMatchObject({ pending: '200.0000', netPaid: '500.0000' });
  });

  it('a repeated preparation key returns the same instruction; concurrent preparations cannot over-allocate', async () => {
    const id = await approvedClaim([line('OFFICE_SUPPLIES', '1000', { exceptionReason: 'Approved bulk order (synthetic)' })]);
    const key = uniq('pay-key-');
    const body = { claimId: id, amount: '600', paymentDate: daysAgo(0), idempotencyKey: key };
    const a = (await prepareReady(h, fin2,body)).json();
    const b = await prepareReady(h, fin2,body);
    expect(b.json()).toMatchObject({ instructionId: a.instructionId, replayed: true });

    const [r1, r2] = await Promise.all([
      prepareReady(h, fin2,{ claimId: id, amount: '400', paymentDate: daysAgo(0), idempotencyKey: uniq('pay-key-') }),
      prepareReady(h, fin2,{ claimId: id, amount: '400', paymentDate: daysAgo(0), idempotencyKey: uniq('pay-key-') }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 422]);
    expect((await claim(employee, id)).payment).toMatchObject({ pending: '1000.0000', outstanding: '1000.0000' });
  });

  it('releases only under the authority current inside the transaction, not the one the route guard saw (docs/09 §6.5)', async () => {
    const id = await approvedClaim([line('OFFICE_SUPPLIES', '50')]);
    const instruction = (await prepareReady(h, fin2,{ claimId: id, amount: '50', paymentDate: daysAgo(0), idempotencyKey: uniq('pay-key-') })).json();
    const releaser = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    // What the route guard resolved just before the release transaction opened.
    const guard = (await resolveAccess(h.pool, { userId: releaser.user, companyId: A.id, assignmentId: releaser.assignment, resource: 'payment', action: 'release', fieldGroups: ['operational'] })) as AccessGrant;
    const releaseEntry = [A.id, releaser.assignment] as const;
    const setEntry = (active: boolean) =>
      h.db.query(
        `update role_assignment_permission set active = $3 where company_id = $1 and role_assignment_id = $2
            and permission_id = (select id from permission where resource = 'payment' and action = 'release' and field_group = 'operational')`,
        [...releaseEntry, active],
      );
    await setEntry(false);
    await expect(withTransaction(h.pool, (tx) => releasePayment(tx, guard, instruction.instructionId, { outcomeActorUserId: releaser.user }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.one<{ state: string }>(`select state from payment_instruction where id = $1`, [instruction.instructionId])).state).toBe('PREPARED');
    await setEntry(true);
    expect((await releaseNaming(h, releaser, instruction.instructionId)).json().state).toBe('RELEASED');
  });

  it('each expense task names its own claim, even with two pending claims from one employee', async () => {
    const first = (await draft(employee, [line('OTHER', '11')])).json().claimId;
    const second = (await draft(employee, [line('OTHER', '22')])).json().claimId;
    await submit(employee, first);
    await submit(employee, second);
    const items = (await h.call(manager, 'GET', '/v1/expense/tasks')).json().items as { claimId: string; transactionId: string; stepAction: string }[];
    for (const id of [first, second]) {
      const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [id])).transaction_id;
      expect(items.find((t) => t.transactionId === tx)).toMatchObject({ claimId: id, stepAction: 'manager_decide' });
    }
  });

  it('payables and instructions reconcile with the claim ledger; the claimant cannot see the payment queue', async () => {
    const id = await approvedClaim([line('OTHER', '300', { exceptionReason: 'Over limit approved (synthetic)' })]);
    await prepareReady(h, fin2,{ claimId: id, amount: '120', paymentDate: daysAgo(0), idempotencyKey: uniq('pay-key-') });
    const payable = ((await h.call(fin2, 'GET', '/v1/expense/payables')).json().items as { claimId: string }[]).find((p) => p.claimId === id);
    expect(payable).toMatchObject({ approvedAmount: '300.00', netPaid: '0.00', pending: '120.00', allocatable: '180.00', currency: 'INR' });
    const instructions = (await h.call(fin2, 'GET', `/v1/expense/claims/${id}/payments`)).json().items;
    expect(instructions).toMatchObject([{ amount: '120.00', state: 'PREPARED', preparedBy: fin2.user }]);
    expect((await h.call(employee, 'GET', '/v1/expense/payables')).statusCode).toBe(403);
    expect((await h.call(employee, 'GET', `/v1/expense/claims/${id}/payments`)).statusCode).toBe(403);
  });

  it('the claimant cannot prepare or release payments', async () => {
    const id = await approvedClaim([line('OTHER', '50')]);
    expect((await h.call(employee, 'POST', '/v1/expense/payments', { claimId: id, amount: '50', paymentDate: daysAgo(0), idempotencyKey: uniq('pay-key-') })).statusCode).toBe(403);
  });

  it('two confirmations of one claim at the same moment both count: the claim ends PAID, neither is refused', async () => {
    // Several rounds: without the claim lock the later writer derives its state from a snapshot missing the earlier one.
    for (let round = 0; round < 3; round++) {
      const id = await approvedClaim([line('OFFICE_SUPPLIES', '600')]);
      const ids = [] as string[];
      for (const amount of ['200', '400']) {
        const pi = (await prepareReady(h, fin2,{ claimId: id, amount, paymentDate: daysAgo(0), idempotencyKey: uniq('pay-key-') })).json().instructionId as string;
        expect((await releaseNaming(h, fin3, pi)).statusCode).toBe(200);
        ids.push(pi);
      }
      const results = await Promise.all(ids.map((pi) => h.call(fin3, 'POST', `/v1/expense/payments/${pi}/outcome`, { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })));
      expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(await claim(employee, id)).toMatchObject({ paymentState: 'PAID', payment: { netPaid: '600.0000', outstanding: '0.0000', pending: '0.0000' } });
    }
  });
});

describe('separation of duties on the payment (DF02, DF03, C4, FR-073, FR-076, BR-018)', () => {
  const prepare = (a: TestActor, id: string, amount: string, key = uniq('pay-key-')) => prepareReady(h, a, { claimId: id, amount, paymentDate: daysAgo(0), idempotencyKey: key });
  const act = (a: TestActor, pi: string, path: string, body?: object) => (path === 'release' ? releaseNaming(h, a, pi) : h.call(a, 'POST', `/v1/expense/payments/${pi}/${path}`, body));
  const SOD = { error: 'SEGREGATION_OF_DUTIES' };
  /** A claim above the threshold: fin1 sets every line amount and fin2 gives the high-value approval. */
  async function highValueClaim() {
    const id = (await draft(employee, [...Array.from({ length: 10 }, () => line('TRAVEL', '5000')), line('OTHER', '100')])).json().claimId as string;
    expect((await submit(employee, id)).statusCode).toBe(200);
    await decide(manager, (await taskOf(manager, id))!.taskId, { decision: 'APPROVE' });
    expect((await approveAllLines(fin1, id, (await taskOf(fin1, id))!.taskId)).json().state).toBe('HIGH_VALUE_PENDING');
    expect((await decide(fin2, (await taskOf(fin2, id))!.taskId, { decision: 'APPROVE' })).json().state).toBe('APPROVED');
    return id;
  }

  it('on a high-value claim neither the financial reviewer nor the final approver prepares, releases, confirms or reverses', async () => {
    const id = await highValueClaim();
    const key = uniq('pay-key-');
    // Preparation: both entitlement approvers are refused, and a key tells them nothing (no second answer path).
    expect((await prepare(fin1, id, '100', key)).json()).toMatchObject(SOD);
    expect((await prepare(fin2, id, '100', key)).json()).toMatchObject(SOD);
    const first = (await prepare(fin3, id, '100', key)).json();
    expect(first).toMatchObject({ state: 'PREPARED', replayed: false });
    expect((await prepare(fin1, id, '100', key)).json()).toMatchObject(SOD); // nor a replay of the same preparation

    // Release: refused for both of them and for the preparer; a fourth person may.
    const fin4 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    for (const a of [fin1, fin2, fin3]) expect((await act(a, first.instructionId, 'release')).json()).toMatchObject(SOD);
    expect((await act(fin4, first.instructionId, 'release')).json().state).toBe('RELEASED');

    // Outcome and reversal, and the replays of each, are refused the same way.
    const evidence = uniq('bank-ref-');
    expect((await act(fin1, first.instructionId, 'outcome', { outcome: 'CONFIRMED', evidenceKey: evidence })).json()).toMatchObject(SOD);
    expect((await act(fin4, first.instructionId, 'outcome', { outcome: 'CONFIRMED', evidenceKey: evidence })).json().state).toBe('CONFIRMED');
    expect((await act(fin1, first.instructionId, 'outcome', { outcome: 'CONFIRMED', evidenceKey: evidence })).json()).toMatchObject(SOD);
    expect((await act(fin3, first.instructionId, 'outcome', { outcome: 'CONFIRMED', evidenceKey: evidence })).json()).toMatchObject(SOD);
    const reversal = { amount: '10', evidenceKey: uniq('reversal-key-'), reason: 'Bank return (synthetic)' };
    expect((await act(fin1, first.instructionId, 'reversal', reversal)).json()).toMatchObject(SOD);
    expect((await act(fin2, first.instructionId, 'reversal', reversal)).json()).toMatchObject(SOD);
    expect((await act(fin3, first.instructionId, 'reversal', reversal)).json()).toMatchObject(SOD);
    expect((await act(fin4, first.instructionId, 'reversal', reversal)).statusCode).toBe(200);
    expect((await act(fin1, first.instructionId, 'reversal', reversal)).json()).toMatchObject(SOD);
    expect((await claim(employee, id)).payment).toMatchObject({ netPaid: '90.0000', pending: '0.0000' });
  });

  it('the finance approver of an ordinary claim cannot prepare either', async () => {
    const id = await approvedClaim([line('OTHER', '60')]);
    expect((await prepare(fin1, id, '60')).json()).toMatchObject(SOD);
    expect((await prepare(fin2, id, '60')).statusCode).toBe(201);
  });

  it('a third independent release (DF03): who decided the manager step may prepare but not release, confirm or reverse', async () => {
    // A manager's own claim goes to the fallback list, so fin1 takes the manager step and fin2 the financial step.
    const managerSelf = await h.actor(A, 'EMPLOYEE', { user: manager.user });
    const id = (await draft(managerSelf, [line('OTHER', '70')])).json().claimId as string;
    await submit(managerSelf, id);
    expect((await decide(fin1, (await taskOf(fin1, id))!.taskId, { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    expect((await approveAllLines(fin2, id, (await taskOf(fin2, id))!.taskId)).json().state).toBe('APPROVED');

    const prepared = (await prepare(fin3, id, '30')).json();
    expect((await act(fin1, prepared.instructionId, 'release')).json()).toMatchObject(SOD);
    expect((await prepare(fin1, id, '40')).statusCode).toBe(201);
    const fin4 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    expect((await act(fin4, prepared.instructionId, 'release')).statusCode).toBe(200);
    expect((await act(fin1, prepared.instructionId, 'outcome', { outcome: 'FAILED', evidenceKey: uniq('failure-key-') })).json()).toMatchObject(SOD);
  });

  it('the claimant is refused at every step, even in an Admin assignment that holds the duties', async () => {
    const id = await approvedClaim([line('OTHER', '40')]);
    const claimantAdmin = await h.actor(A, 'HR_ADMINISTRATOR', { user: employee.user, extra: FINANCE });
    expect((await prepare(claimantAdmin, id, '40')).json()).toMatchObject(SOD);
    const pi = (await prepare(fin2, id, '40')).json().instructionId as string;
    expect((await act(claimantAdmin, pi, 'release')).json()).toMatchObject(SOD);
    expect((await act(fin3, pi, 'release')).statusCode).toBe(200);
    expect((await act(claimantAdmin, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })).json()).toMatchObject(SOD);
  });

  it('the release dashboard counts follow the same rule (C4; F2)', async () => {
    const id = await highValueClaim();
    const pi = (await prepare(fin3, id, '100')).json().instructionId as string;
    const fin4 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    const releasable = async (a: TestActor) => {
      const grant = (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'payment', action: 'release', fieldGroups: ['operational'] })) as AccessGrant;
      const metric = await EXPENSE_METRICS.PAYMENTS_AWAITING_RELEASE!(h.pool, grant);
      if (metric.status !== 'OK') throw new Error(metric.status);
      return Number(metric.value);
    };
    const others = await releasable(fin4);
    expect(others).toBeGreaterThan(0);
    for (const a of [fin1, fin2, fin3]) expect(await releasable(a)).toBeLessThan(others);
    expect((await act(fin4, pi, 'release')).statusCode).toBe(200);
    expect(await releasable(fin4)).toBe(others - 1);
  });
});

describe('a key reused for different content is refused, never answered as a replay (FR-077, BR-025, DF07, ZT15)', () => {
  const act = (a: TestActor, pi: string, path: string, body?: object) => (path === 'release' ? releaseNaming(h, a, pi) : h.call(a, 'POST', `/v1/expense/payments/${pi}/${path}`, body));
  const prepare = (claimId: string, amount: string, key = uniq('pay-key-'), paymentDate = daysAgo(0)) => prepareReady(h, fin2,{ claimId, amount, paymentDate, idempotencyKey: key });
  /** A claim with a confirmed payment; returns the claim, the instruction and its bank reference. */
  async function confirmedPayment(amount: string) {
    const id = await approvedClaim([line('OFFICE_SUPPLIES', amount)]);
    const pi = (await prepare(id, amount)).json().instructionId as string;
    expect((await act(fin3, pi, 'release')).statusCode).toBe(200);
    const bankRef = uniq('bank-ref-');
    expect((await act(fin3, pi, 'outcome', { outcome: 'CONFIRMED', evidenceKey: bankRef })).statusCode).toBe(200);
    return { id, pi, bankRef };
  }
  const REUSED = { error: 'EVIDENCE_KEY_REUSED' };

  it('a reversal under the bank reference of the confirmation is refused and the books stay right', async () => {
    const { id, pi, bankRef } = await confirmedPayment('500');
    const res = await act(fin3, pi, 'reversal', { amount: '100', evidenceKey: bankRef, reason: 'Bank return (synthetic)' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject(REUSED);
    expect(await claim(employee, id)).toMatchObject({ paymentState: 'PAID', payment: { netPaid: '500.0000', outstanding: '0.0000' } });
    // The real reversal under its own reference still goes through.
    expect((await act(fin3, pi, 'reversal', { amount: '100', evidenceKey: uniq('reversal-key-'), reason: 'Bank return (synthetic)' })).json().replayed).toBe(false);
    expect(await claim(employee, id)).toMatchObject({ paymentState: 'PART_PAID', payment: { netPaid: '400.0000', outstanding: '100.0000' } });
  });

  it('a reversal under a key of another instruction, or of another amount, is refused; the same reversal again has no effect', async () => {
    const one = await confirmedPayment('300');
    const two = await confirmedPayment('300');
    const reversalKey = uniq('reversal-key-');
    const body = { amount: '50', evidenceKey: reversalKey, reason: 'Bank return (synthetic)' };
    expect((await act(fin3, one.pi, 'reversal', body)).json().replayed).toBe(false);

    expect((await act(fin3, one.pi, 'reversal', body)).json()).toMatchObject({ instructionId: one.pi, replayed: true });
    expect((await act(fin3, one.pi, 'reversal', { ...body, amount: '50.00' })).json()).toMatchObject({ replayed: true }); // the same amount, however written
    expect((await act(fin3, one.pi, 'reversal', { ...body, amount: '60' })).json()).toMatchObject(REUSED);
    expect((await act(fin3, two.pi, 'reversal', body)).json()).toMatchObject(REUSED);
    expect((await act(fin3, two.pi, 'reversal', { ...body, evidenceKey: one.bankRef })).json()).toMatchObject(REUSED);
    expect((await claim(employee, one.id)).payment.netPaid).toBe('250.0000');
    expect((await claim(employee, two.id)).payment.netPaid).toBe('300.0000');
    const events = await h.one<{ n: string }>(`select count(*) as n from payment_event where event_key = $1`, [reversalKey]);
    expect(Number(events.n)).toBe(1);
  });

  it('a duplicate reversal at the same moment is recorded once', async () => {
    const { id, pi } = await confirmedPayment('200');
    const body = { amount: '25', evidenceKey: uniq('reversal-key-'), reason: 'Bank return (synthetic)' };
    const results = await Promise.all([act(fin3, pi, 'reversal', body), act(fin3, pi, 'reversal', body)]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results.map((r) => r.json().replayed).sort()).toEqual([false, true]);
    expect((await claim(employee, id)).payment.netPaid).toBe('175.0000');
  });

  it('an outcome under a key of another event is refused: another instruction, the other outcome, or a reversal', async () => {
    const { pi: confirmed, bankRef } = await confirmedPayment('150');
    const reversalKey = uniq('reversal-key-');
    expect((await act(fin3, confirmed, 'reversal', { amount: '5', evidenceKey: reversalKey, reason: 'Bank return (synthetic)' })).statusCode).toBe(200);
    // The same outcome again is the replay.
    expect((await act(fin3, confirmed, 'outcome', { outcome: 'CONFIRMED', evidenceKey: bankRef })).json()).toMatchObject({ state: 'CONFIRMED', replayed: true });
    expect((await act(fin3, confirmed, 'outcome', { outcome: 'FAILED', evidenceKey: bankRef })).json()).toMatchObject(REUSED);
    expect((await act(fin3, confirmed, 'outcome', { outcome: 'CONFIRMED', evidenceKey: reversalKey })).json()).toMatchObject(REUSED);

    const id = await approvedClaim([line('OTHER', '45')]);
    const other = (await prepare(id, '45')).json().instructionId as string;
    expect((await act(fin3, other, 'release')).statusCode).toBe(200);
    expect((await act(fin3, other, 'outcome', { outcome: 'CONFIRMED', evidenceKey: bankRef })).json()).toMatchObject(REUSED);
    expect((await claim(employee, id)).payment).toMatchObject({ netPaid: '0.0000', pending: '45.0000' });
  });

  it('a preparation key used for another claim, amount or date is refused and prepares nothing; the same request replays', async () => {
    const x = await approvedClaim([line('OTHER', '80')]);
    const y = await approvedClaim([line('OTHER', '90')]);
    const key = uniq('pay-key-');
    const first = (await prepare(x, '40', key)).json();
    expect(first).toMatchObject({ state: 'PREPARED', replayed: false });
    expect((await prepare(x, '40.00', key)).json()).toMatchObject({ instructionId: first.instructionId, replayed: true });

    const otherClaim = await prepare(y, '40', key);
    expect(otherClaim.statusCode).toBe(409);
    expect(otherClaim.json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await prepare(x, '41', key)).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await prepare(x, '40', key, daysAgo(1))).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await claim(employee, y)).payment.pending).toBe('0.0000');
    expect((await claim(employee, x)).payment.pending).toBe('40.0000');
  });

  it('the same preparation at the same moment prepares once', async () => {
    const id = await approvedClaim([line('OTHER', '75')]);
    const key = uniq('pay-key-');
    const results = await Promise.all([prepare(id, '75', key), prepare(id, '75', key)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    expect(results[0]!.json().instructionId).toBe(results[1]!.json().instructionId);
    expect((await claim(employee, id)).payment.pending).toBe('75.0000');
  });

  it('a replay is answered only inside the caller’s row scope', async () => {
    const id = await approvedClaim([line('OTHER', '35')]);
    const key = uniq('pay-key-');
    expect((await prepare(id, '35', key)).statusCode).toBe(201);
    const outsider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE, departmentFilter: A.financeDept });
    const res = await h.call(outsider, 'POST', '/v1/expense/payments', { claimId: id, amount: '35', paymentDate: daysAgo(0), idempotencyKey: key });
    expect(res.statusCode).toBe(404);
    expect(res.json().instructionId).toBeUndefined();
  });
});

describe('clearing a flagged line (FR-073, FR-075, BR-021, BR-023, DF02, DF06)', () => {
  const CLEARED = 'Reviewed against the bill (synthetic)';
  let flaggedClaims = 0;
  /** Claim with one line of each flag kind plus one clean line, past the manager step; returns its finance task and lines. */
  async function flaggedClaim() {
    const shared = await uploadReceipt(employee);
    const reason = { exceptionReason: 'Claimant justification (synthetic)' };
    // A line without a receipt keeps its fingerprint apart by its amount: this claim's only duplicates are lines 4 and 5.
    const missing = 200 + ++flaggedClaims;
    const id = (
      await draft(employee, [
        line('MEALS', '1500', { ...reason, expenseDate: daysAgo(6) }),
        line('OTHER', '50', { ...reason, expenseDate: daysAgo(40) }),
        line('TRAVEL', String(missing), { ...reason, receipt: undefined }),
        line('OFFICE_SUPPLIES', '300', { ...reason, receipt: shared }),
        line('OFFICE_SUPPLIES', '301', { ...reason, receipt: shared }),
        line('OTHER', '75'),
      ])
    ).json().claimId as string;
    expect((await submit(employee, id)).statusCode).toBe(200);
    await decide(manager, (await taskOf(manager, id))!.taskId, { decision: 'APPROVE' });
    const lines = (await claim(fin1, id)).lines as { id: string; claimedAmount: string; exceptionFlags: string[] }[];
    expect(lines.map((l) => l.exceptionFlags)).toEqual([['OVER_LIMIT'], ['LATE_SUBMISSION'], ['RECEIPT_MISSING'], ['DUPLICATE_SUSPECTED'], ['DUPLICATE_SUSPECTED'], []]);
    return { id, lines, total: `${2226 + missing}.0000`, taskId: (await taskOf(fin1, id))!.taskId };
  }
  const allLines = (lines: { id: string; claimedAmount: string; exceptionFlags: string[] }[], reasonFor: (flagged: boolean, i: number) => string | undefined) =>
    lines.map((l, i) => {
      const reason = reasonFor(l.exceptionFlags.length > 0, i);
      return { lineId: l.id, allowedAmount: l.claimedAmount, ...(reason ? { reason } : {}) };
    });

  it('every flag kind accepted at full amount needs the reviewer’s reason, which the line decision keeps; a clean line does not', async () => {
    const { id, lines, total, taskId } = await flaggedClaim();
    const refused = await decide(fin1, taskId, { decision: 'APPROVE', lines: allLines(lines, () => undefined) });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      error: 'CLEARANCE_REASON_REQUIRED',
      details: {
        lines: [
          { line: 1, flags: ['OVER_LIMIT'] },
          { line: 2, flags: ['LATE_SUBMISSION'] },
          { line: 3, flags: ['RECEIPT_MISSING'] },
          { line: 4, flags: ['DUPLICATE_SUSPECTED'] },
          { line: 5, flags: ['DUPLICATE_SUSPECTED'] },
        ],
      },
    });
    // One line short is still refused, naming only that line; a blank reason does not count.
    const oneShort = await decide(fin1, taskId, { decision: 'APPROVE', lines: allLines(lines, (flagged, i) => (flagged && i !== 2 ? CLEARED : undefined)) });
    expect(oneShort.json()).toMatchObject({ error: 'CLEARANCE_REASON_REQUIRED', details: { lines: [{ line: 3, flags: ['RECEIPT_MISSING'] }] } });
    const blank = await decide(fin1, taskId, { decision: 'APPROVE', lines: allLines(lines, (flagged) => (flagged ? '   ' : undefined)) });
    expect(blank.json().error).toBe('CLEARANCE_REASON_REQUIRED');
    // Nothing was recorded by the refusals: the claim still waits for the same reviewer.
    expect((await claim(employee, id)).state).toBe('FINANCE_PENDING');
    expect((await taskOf(fin1, id))!.taskId).toBe(taskId);

    const approved = await decide(fin1, taskId, { decision: 'APPROVE', lines: allLines(lines, (flagged) => (flagged ? CLEARED : undefined)) });
    expect(approved.json()).toMatchObject({ state: 'APPROVED', approvedAmount: total });
    const kept = await h.db.query<{ exception_reason: string | null; flags: string[] }>(
      `select d.exception_reason, l.exception_flags as flags from expense_line_decision d join expense_line l on l.id = d.line_id where l.id = any($1::uuid[]) order by l.sequence`,
      [lines.map((l) => l.id)],
    );
    expect(kept.rows.map((r) => r.exception_reason)).toEqual([CLEARED, CLEARED, CLEARED, CLEARED, CLEARED, null]);
  });

  it('the database refuses an unexplained line decision on a flagged line whatever the service does', async () => {
    const { id, lines } = await flaggedClaim();
    const managerDecision = await h.one<{ id: string }>(
      `select d.id from approval_decision d join approval_task t on t.id = d.task_id join approval_instance i on i.id = t.instance_id
         join expense_claim c on c.transaction_id = i.transaction_id where c.id = $1`,
      [id],
    );
    const write = (lineId: string, allowed: string, reason: string | null) =>
      h.db.query(`insert into expense_line_decision (company_id, line_id, approval_decision_id, allowed_amount, exception_reason) values ($1, $2, $3, $4::numeric, $5)`, [A.id, lineId, managerDecision.id, allowed, reason]);
    await expectSqlError(write(lines[0]!.id, lines[0]!.claimedAmount, null), CHECK_VIOLATION);
    await expectSqlError(write(lines[1]!.id, lines[1]!.claimedAmount, '  '), CHECK_VIOLATION);
    expect((await write(lines[5]!.id, lines[5]!.claimedAmount, null)).rowCount).toBe(1); // a clean line at full amount needs none
  });

  it('the claimant’s reason and the clearance reason need the reason grant; the claimant reads neither', async () => {
    const { id, lines, taskId } = await flaggedClaim();
    const withGrant = await h.actor(A, 'HR_ADMINISTRATOR', { user: fin1.user, extra: [...FINANCE, 'expense.read.reason'] });
    const flaggedLine = (c: { lines: { id: string }[] }) => c.lines[0] as { exceptionReason?: string; decisionReason?: string };

    // The financial reviewer with the grant reads the justification; without it, the same reviewer sees flags only.
    expect(flaggedLine(await claim(withGrant, id)).exceptionReason).toBe('Claimant justification (synthetic)');
    expect(flaggedLine(await claim(fin1, id))).not.toHaveProperty('exceptionReason');
    expect(JSON.stringify(await claim(fin1, id))).not.toContain('Claimant justification');
    expect(JSON.stringify(await claim(employee, id))).not.toContain('Claimant justification');
    expect(flaggedLine(await claim(employee, id))).not.toHaveProperty('exceptionReason');

    await decide(fin1, taskId, { decision: 'APPROVE', lines: allLines(lines, (flagged) => (flagged ? CLEARED : undefined)) });
    expect(flaggedLine(await claim(withGrant, id)).decisionReason).toBe(CLEARED);
    expect(JSON.stringify(await claim(fin1, id))).not.toContain(CLEARED);
    expect(JSON.stringify(await claim(employee, id))).not.toContain(CLEARED);

    // The claimant, even in an Admin assignment holding the grant, does not read the reviewer's note on their own claim.
    const claimantAdmin = await h.actor(A, 'HR_ADMINISTRATOR', { user: employee.user, extra: ['expense.read.operational', 'expense.read.reason'] });
    expect(JSON.stringify(await claim(claimantAdmin, id))).not.toContain(CLEARED);
    // An operational role never holds the group (C1): the assignment entry itself is refused.
    await expect(h.actor(A, 'FINANCE_REVIEWER', { extra: ['expense.read.reason'] })).rejects.toThrow(/not allowed by the parent role/);
  });

  it('a draft line’s reason is not shown before the revision is submitted', async () => {
    const withGrant = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'expense.read.reason'] });
    const id = (await draft(employee, [line('OTHER', '20', { exceptionReason: 'Draft note (synthetic)' })])).json().claimId as string;
    // A draft is the claimant's own (DF02), so this is no longer a matter of the reason column: the claim itself is not found.
    const res = await h.call(withGrant, 'GET', `/v1/expense/claims/${id}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('Draft note');
  });
});

describe('who reads a claim beyond row scope (DF02 "claimant and assigned expense reviewers/payment operators"; FR-098; decisions-2)', () => {
  let teamMember: TestActor;
  let memberEmp: string;
  let formerManagerOfClaim: TestActor;

  const claimsOf = async (a: TestActor, employeeId: string) => ((await h.call(a, 'GET', `/v1/employees/${employeeId}/expense-claims`)).json().items as { id: string }[]).map((c) => c.id);
  const status = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).statusCode;

  beforeAll(async () => {
    const hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const newEmployee = async () => (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id as string;
    const activate = (id: string) => h.setStatus(A, id, 'ACTIVE_CONFIRMED');
    memberEmp = await newEmployee();
    await activate(memberEmp);
    const formerEmp = await newEmployee();
    await activate(formerEmp);
    teamMember = await h.actor(A, 'EMPLOYEE', { employeeId: memberEmp });
    formerManagerOfClaim = await h.actor(A, 'REPORTING_MANAGER', { employeeId: formerEmp });
    await h.call(hr, 'POST', `/v1/employees/${memberEmp}/manager`, { managerEmployeeId: formerEmp, effectiveFrom: '2026-01-05' });
  });

  it('a manager does not read a direct report’s draft; the claimant does; a task on the submitted claim opens it', async () => {
    const id = (await draft(teamMember, [line('OTHER', '20')])).json().claimId as string;
    expect(await status(formerManagerOfClaim, id)).toBe(404);
    expect(await claimsOf(formerManagerOfClaim, memberEmp)).not.toContain(id);
    expect(await status(teamMember, id)).toBe(200);
    expect(await claimsOf(teamMember, memberEmp)).toContain(id);
    const version = (await h.call(teamMember, 'GET', `/v1/expense/claims/${id}`)).json().version as number;
    expect((await h.call(teamMember, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: version })).statusCode).toBe(200);
    expect(await status(formerManagerOfClaim, id)).toBe(200);
    expect(await claimsOf(formerManagerOfClaim, memberEmp)).toContain(id);
  });

  it('a claim submitted before someone became the manager stays with the reviewer it was routed to', async () => {
    const id = (await draft(teamMember, [line('OTHER', '21')])).json().claimId as string;
    const version = (await h.call(teamMember, 'GET', `/v1/expense/claims/${id}`)).json().version as number;
    expect((await h.call(teamMember, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: version })).statusCode).toBe(200);
    const hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const newManagerEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id as string;
    await h.setStatus(A, newManagerEmp, 'ACTIVE_CONFIRMED');
    const newManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: newManagerEmp });
    const moved = await h.call(hr, 'POST', `/v1/employees/${memberEmp}/manager`, { managerEmployeeId: newManagerEmp, effectiveFrom: daysAgo(1) });
    expect(moved.statusCode, moved.body).toBeLessThan(300);
    expect(await status(newManager, id)).toBe(404);
    expect(await claimsOf(newManager, memberEmp)).not.toContain(id);
    // The former manager is out of row scope now, whatever task they held (ZT02).
    expect(await status(formerManagerOfClaim, id)).toBe(404);
  });

  it('a payment operator reads a submitted claim but not a draft, with or without a task', async () => {
    const operator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'payment.read.operational'] });
    const reviewerWithoutTask = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational'] });
    const drafted = (await draft(employee, [line('OTHER', '22')])).json().claimId as string;
    const submitted = (await draft(employee, [line('OTHER', '23')])).json().claimId as string;
    const version = (await h.call(employee, 'GET', `/v1/expense/claims/${submitted}`)).json().version as number;
    expect((await h.call(employee, 'POST', `/v1/expense/claims/${submitted}/submit`, { expectedVersion: version })).statusCode).toBe(200);
    expect(await status(operator, drafted)).toBe(404);
    expect(await status(operator, submitted)).toBe(200);
    expect(await status(reviewerWithoutTask, submitted)).toBe(404);
  });

  it('a task held through another assignment of the same user lends this one nothing (I-52)', async () => {
    const id = (await draft(employee, [line('OTHER', '24')])).json().claimId as string;
    expect((await submit(employee, id)).statusCode).toBe(200);
    expect(await status(manager, id)).toBe(200);
    // The same person, company-wide and able to read claims, but with no decision duty of this claim's step.
    const sameUserOtherDuty = await h.actor(A, 'HR_ADMINISTRATOR', { user: manager.user, extra: ['expense.read.operational'] });
    expect(await status(sameUserOtherDuty, id)).toBe(404);
    expect(await claimsOf(sameUserOtherDuty, (await claim(employee, id)).employeeId as string)).not.toContain(id);
  });

  it('a receipt opens only for someone who reads its claim: not a later manager, even with the receipt grant (DF02 attachments; I-49)', async () => {
    const bytes = `%PDF-1.4\n% synthetic receipt beyond scope ${uniq('v')}\n%%EOF\n`;
    const hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
    const person = async () => {
      const personId = (await h.call(hr2, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id as string;
      await h.setStatus(A, personId, 'ACTIVE_CONFIRMED');
      return personId;
    };
    const claimantEmp = await person();
    const claimant = await h.actor(A, 'EMPLOYEE', { employeeId: claimantEmp });
    const routedEmp = await person();
    const routed = await h.actor(A, 'REPORTING_MANAGER', { employeeId: routedEmp, extra: ['expense.view_receipt.receipt'] });
    expect((await h.call(hr2, 'POST', `/v1/employees/${claimantEmp}/manager`, { managerEmployeeId: routedEmp, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
    const id = (await draft(claimant, [line('OTHER', '25', { receipt: await uploadReceipt(claimant, bytes) })])).json().claimId as string;
    expect((await submit(claimant, id)).statusCode).toBe(200);
    const lineId = (await claim(claimant, id)).lines[0].id as string;
    const url = `/v1/expense/lines/${lineId}/receipt`;
    expect((await h.call(routed, 'GET', url)).statusCode).toBe(200);

    const laterEmp = await person();
    const later = await h.actor(A, 'REPORTING_MANAGER', { employeeId: laterEmp, extra: ['expense.view_receipt.receipt'] });
    expect((await h.call(hr2, 'POST', `/v1/employees/${claimantEmp}/manager`, { managerEmployeeId: laterEmp, effectiveFrom: daysAgo(1) })).statusCode).toBeLessThan(300);
    const refused = await h.call(later, 'GET', url);
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain('synthetic receipt');
    const denied = await h.one<{ n: string }>(`select count(*) as n from audit_event where resource_code = 'expense_receipt' and action = 'ACCESS_DENIED' and actor_user_id = $1`, [later.user]);
    expect(Number(denied.n)).toBe(1);
  });
});

describe('treasury widgets reconcile with the instructions list (F2; BR-045; FR-097)', () => {
  const PAYMENT_METRICS = ['PAYMENTS_AWAITING_OUTCOME', 'PAYMENTS_FAILED', 'PAYMENTS_AWAITING_RELEASE', 'PAYMENTS_RELEASE_OVERDUE', 'PAYMENTS_CONFIRMED_REVERSED'];

  it('each count equals GET /expense/payments under the widget’s filters, for the same actor; no amount or bank field is listed', async () => {
    const pay = async (paymentDate = daysAgo(0)) => {
      const claimId = await approvedClaim([line('OTHER', '30', { exceptionReason: 'Over limit approved (synthetic)' })]);
      const res = await prepareReady(h, fin2,{ claimId, amount: '30', paymentDate, idempotencyKey: uniq('pay-key-') });
      expect(res.statusCode, res.body).toBeLessThan(300);
      return res.json().instructionId as string;
    };
    const release = (id: string) => releaseNaming(h, fin3, id);
    const outcome = (id: string, value: string) => h.call(fin3, 'POST', `/v1/expense/payments/${id}/outcome`, { outcome: value, evidenceKey: uniq('bank-ref-') });

    await pay(daysAgo(-10)); // prepared, not yet due, whatever the hour of the company-local day
    await pay(daysAgo(2)); // prepared, past its date
    await release(await pay()); // awaiting its outcome
    const failed = await pay();
    await release(failed);
    await outcome(failed, 'FAILED');
    const reversed = await pay();
    await release(reversed);
    await outcome(reversed, 'CONFIRMED');
    expect((await h.call(fin3, 'POST', `/v1/expense/payments/${reversed}/reversal`, { amount: '10', evidenceKey: uniq('reversal-key-'), reason: 'Bank return (synthetic)' })).statusCode).toBe(200);

    const counted: Record<string, Record<string, number | string>> = {};
    for (const [name, a] of [['preparer', fin2], ['releaser', fin3]] as const) {
      const grant = await resolveAccess(h.db, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'payment', action: 'read', fieldGroups: ['operational'] });
      if (!grant.allowed) throw new Error(grant.reason);
      counted[name] = {};
      for (const code of PAYMENT_METRICS) {
        const source = METRIC_SOURCES[code]!;
        const result = await EXPENSE_METRICS[code]!(h.db, grant);
        if (result.status !== 'OK') throw new Error(code);
        const counts: number[] = [];
        for (const list of source.lists(grant)) {
          const res = await h.call(a, 'GET', list.api);
          expect(res.statusCode, `${list.api}: ${res.body}`).toBe(200);
          expect(res.body).not.toMatch(/"amount"|"accountIdentifier"/);
          counts.push(res.json().total as number);
        }
        expect(result.value, `${name} ${code}`).toEqual(source.combine === 'PARTS' ? counts.join('/') : counts.reduce((x, y) => x + y, 0));
        counted[name]![code] = result.value;
      }
    }
    // The figures carry records, and the independent releaser is the only one who may release what the preparer prepared (C4).
    expect(Number(counted.releaser!.PAYMENTS_AWAITING_RELEASE)).toBeGreaterThanOrEqual(2);
    expect(Number(counted.releaser!.PAYMENTS_RELEASE_OVERDUE)).toBeGreaterThanOrEqual(1);
    expect(Number(counted.releaser!.PAYMENTS_RELEASE_OVERDUE)).toBeLessThan(Number(counted.releaser!.PAYMENTS_AWAITING_RELEASE));
    expect(counted.preparer!.PAYMENTS_AWAITING_RELEASE).toBe(0);
    expect(Number(counted.releaser!.PAYMENTS_AWAITING_OUTCOME)).toBeGreaterThanOrEqual(1);
    expect(Number(counted.releaser!.PAYMENTS_FAILED)).toBeGreaterThanOrEqual(1);
    const [confirmed, reversals] = String(counted.releaser!.PAYMENTS_CONFIRMED_REVERSED).split('/').map(Number);
    expect(confirmed).toBeGreaterThanOrEqual(1);
    expect(reversals).toBeGreaterThanOrEqual(1);
  });
});

describe('receipt content (DF02, FR-057)', () => {
  it('a reviewer needs the confidential receipt grant to read the file; the claimant reads their own released receipt (H1); reads are audited', async () => {
    const bytes = `%PDF-1.4\n% synthetic receipt to view ${uniq('v')}\n%%EOF\n`;
    const id = (await draft(employee, [line('OTHER', '90', { receipt: await uploadReceipt(employee, bytes) })])).json().claimId;
    await submit(employee, id);
    const lineId = (await claim(employee, id)).lines[0].id as string;
    const url = `/v1/expense/lines/${lineId}/receipt`;

    // BRD v8.2 DF06/H1: the claimant (Employee OWN) may retrieve their own released receipt.
    expect((await h.call(employee, 'GET', url)).statusCode).toBe(200);
    expect((await h.call(manager, 'GET', url)).statusCode).toBe(403);
    const reviewer = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['expense.view_receipt.receipt'] });
    const res = await h.call(reviewer, 'GET', url);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.rawPayload.toString()).toBe(bytes);
    const audit = await h.one<{ n: string }>(`select count(*) as n from audit_event where resource_code = 'expense_receipt' and action = 'READ_CONTENT' and actor_user_id = $1`, [manager.user]);
    expect(Number(audit.n)).toBe(1);

    // Outside the reviewer's team scope the receipt does not exist for them.
    const otherManagerEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
    const outsider = await h.actor(A, 'REPORTING_MANAGER', { employeeId: otherManagerEmp, extra: ['expense.view_receipt.receipt'] });
    expect((await h.call(outsider, 'GET', url)).statusCode).toBe(404);
  });
});
