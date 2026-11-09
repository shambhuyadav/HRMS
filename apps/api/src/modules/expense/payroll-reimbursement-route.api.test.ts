// BR-024 expense payment uniqueness against the payroll route (docs/03 I-48 item 17, I-81 item 8; decided under owner delegation,
// 6 Nov 2026): an approved claim has one obligation and one route, the direct payment; payroll does not pay expense claims (DF07
// Wave 1). A payroll REIMBURSEMENT input entered for the employee since the claim was submitted could be the same money, so a direct
// payment waits for the preparer's recorded review. Synthetic INR amounts and data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { calendar, CONFIG, head, months, ok, PREPARE as PAYROLL_PREPARE } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';

const DECIDE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];
const PAY: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.prepare.operational'];

describe.runIf(isModuleActive('payroll'))('BR-024 one route for an approved claim (I-81 item 8)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let approver: TestActor;
  let preparer: TestActor;
  let payrollPreparer: TestActor;
  let manager: TestActor;
  let employee: TestActor;
  let employeeId: string;
  let periods: Record<string, string>;

  const today = () => new Date().toISOString().slice(0, 10);
  const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
  const taskOf = async (a: TestActor, claimId: string) => {
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
    return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
  };
  const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('br024-key-'), ...body });
  const approvedClaim = async (amount: string) => {
    const uploaded = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic BR-024 receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const created = await h.call(employee, 'POST', '/v1/expense/claims', {
      purpose: 'Route check (synthetic)',
      currency: 'INR',
      lines: [{ category: 'OFFICE_SUPPLIES', expenseDate: today(), merchant: 'Synthetic Merchant', grossAmount: amount, claimedAmount: amount, description: 'Synthetic', receipt: { receiptId: uploaded.json().receiptId } }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().claimId as string;
    expect((await h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(employee, id)).version })).statusCode).toBe(200);
    expect((await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    const lines = (await view(approver, id)).lines as { id: string; claimedAmount: string }[];
    expect((await decide(approver, await taskOf(approver, id), { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) })).json().state).toBe('APPROVED');
    return id;
  };
  /** A payroll input of the employee in the current month, on the given head (draft batch; nothing is approved). */
  const payrollInput = async (componentCode: string, amount: string) => {
    const month = today().slice(0, 7);
    const batch = await ok<{ id: string; lines: { id: string }[] }>(
      await h.call(payrollPreparer, 'POST', `/v1/payroll/periods/${periods[month]}/input-batches`, {
        lines: [{ employeeId, componentCode, inputKind: 'OTHER_INPUT', amount, currencyCode: 'INR', effectiveDate: today(), reference: uniq('REIMB-') }],
      }),
      201,
    );
    return { batchId: batch.id, inputId: batch.lines[0]!.id };
  };
  const pay = (claimId: string, amount: string, extra: Record<string, unknown> = {}) =>
    h.call(preparer, 'POST', '/v1/expense/payments', { claimId, amount, paymentDate: today(), idempotencyKey: uniq('br024-pay-'), ...extra });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DECIDE });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PAY });
    payrollPreparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PAYROLL_PREPARE });
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, approver.user]);
    const newPerson = async () => {
      const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
      await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
      return e.id as string;
    };
    const managerEmp = await newPerson();
    employeeId = await newPerson();
    await h.call(hr, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    employee = await h.actor(A, 'EMPLOYEE', { employeeId });
    const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
    expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
    await head(h, configA, configB, { code: 'BR_TRAVEL_REIMB', headType: 'REIMBURSEMENT', basis: 'INPUT', sequence: 5 });
    await head(h, configA, configB, { code: 'BR_BONUS', headType: 'EARNING', basis: 'INPUT', sequence: 6 });
    periods = (await calendar(h, configA, configB, [...months(2026), ...months(2027)])).periods;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('BR-024 a claim with no payroll reimbursement since its submission is paid directly, as before', async () => {
    const claim = await approvedClaim('120');
    // A payroll earning that is not a reimbursement says nothing about expense claims.
    await payrollInput('BR_BONUS', '120.00');
    const res = await pay(claim, '120');
    expect(res.statusCode, res.body).toBe(201);
  });

  it('BR-024 a payroll reimbursement entered since the claim was submitted stops a second direct payment until the preparer records why it is not this claim', async () => {
    const claim = await approvedClaim('250');
    const input = await payrollInput('BR_TRAVEL_REIMB', '250.00');
    const refused = await pay(claim, '250');
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json().error).toBe('PAYROLL_REIMBURSEMENT_REVIEW_REQUIRED');
    // The preparer sees which input and whether the amount is the same; never the payroll amount itself (DF02).
    expect(refused.json().details.payrollInputs).toEqual([expect.objectContaining({ inputId: input.inputId, state: 'DRAFT', matchesAmount: true })]);
    expect(JSON.stringify(refused.json().details)).not.toContain('250.00');
    expect(await h.one<{ n: number }>(`select count(*)::int as n from payment_allocation a join expense_obligation o on o.id = a.obligation_id where o.claim_id = $1`, [claim])).toEqual({ n: 0 });
    // The claim still shows UNPAID with its full entitlement: nothing about payroll changes the obligation (one route, DF07).
    expect((await view(preparer, claim)).paymentState).toBe('UNPAID');

    const reviewed = await pay(claim, '250', { payrollReimbursementReview: 'Payroll input is the October fuel allowance, not this claim (synthetic)' });
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    const trail = await h.one<{ reason: string; after: string }>(
      `select reason, after_values::text as after from audit_event where company_id = $1 and resource_code = 'payment_instruction' and record_key = $2 and action = 'PREPARE'`,
      [A.id, reviewed.json().instructionId],
    );
    expect(trail.reason).toContain('fuel allowance');
    expect(trail.after).toContain(input.inputId);
  });

  it('BR-024 a reversed or cancelled payroll input no longer counts, and the check runs before any reservation (guard proof)', async () => {
    const claim = await approvedClaim('80');
    const input = await payrollInput('BR_TRAVEL_REIMB', '80.00');
    expect((await pay(claim, '80')).json().error).toBe('PAYROLL_REIMBURSEMENT_REVIEW_REQUIRED');
    const b = await ok<{ version: number }>(await h.call(payrollPreparer, 'GET', `/v1/payroll/input-batches/${input.batchId}`));
    await ok(await h.call(payrollPreparer, 'POST', `/v1/payroll/input-batches/${input.batchId}/cancel`, { reason: 'Entered in error (synthetic)', expectedVersion: b.version }));
    const res = await pay(claim, '80');
    expect(res.statusCode, res.body).toBe(201);
  });
});
