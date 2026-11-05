// An ASSIGNED decider's row scope comes from the pending task (C1 "ASSIGNED via eligible current approval_task"), and deciding closes that
// task. The decision must still answer: a scope check after the decision would refuse the very decision that ended the scope, with a 404
// and nothing recorded. Reading the record afterwards is what ends. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let managerEmp: string;
let employee: TestActor;
let employeeEmp: string;

const today = () => new Date().toISOString().slice(0, 10);
const person = async (status = 'ACTIVE_CONFIRMED', overrides: Record<string, unknown> = {}) => {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides));
  expect(res.statusCode, res.body).toBe(201);
  await h.setStatus(A, res.json().id, status);
  return res.json().id as string;
};
const reportsTo = async (employeeId: string, managerEmployeeId: string) => {
  const res = await h.call(hr, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId, effectiveFrom: '2026-01-05' });
  expect(res.statusCode, res.body).toBeLessThan(300);
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  managerEmp = await person();
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employeeEmp = await person();
  await reportsTo(employeeEmp, managerEmp);
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('an expense claim', () => {
  const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
  const taskOf = async (a: TestActor, claimId: string) => {
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
    return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)?.taskId;
  };
  const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('assigned-key-'), ...body });
  const submitted = async () => {
    const receipt = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic assigned receipt ${uniq('a')}\n%%EOF\n`).toString('base64') });
    expect(receipt.statusCode, receipt.body).toBe(201);
    const created = await h.call(employee, 'POST', '/v1/expense/claims', {
      purpose: 'Assigned decider (synthetic)',
      currency: 'INR',
      lines: [{ category: 'OFFICE_SUPPLIES', expenseDate: today(), merchant: 'Synthetic Merchant', grossAmount: '100', claimedAmount: '100', description: 'Assigned check (synthetic)', receipt: { receiptId: receipt.json().receiptId } }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().claimId as string;
    expect((await h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(employee, id)).version })).statusCode).toBe(200);
    return id;
  };

  it('the financial decider in ASSIGNED scope approves with no 404, and only then loses the record', async () => {
    const reviewer = await h.customActor(A, { scope: 'ASSIGNED', permissions: ['expense.read.operational', 'expense.finance_decide.operational'] });
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, reviewer.user]);
    const id = await submitted();
    expect((await decide(manager, (await taskOf(manager, id))!, { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');

    const task = await taskOf(reviewer, id);
    expect(task).toBeTruthy();
    const open = await h.call(reviewer, 'GET', `/v1/expense/claims/${id}`);
    expect(open.statusCode, open.body).toBe(200);
    const lines = open.json().lines as { id: string; claimedAmount: string }[];

    const decided = await decide(reviewer, task!, { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().state).toBe('APPROVED');
    expect((await view(employee, id)).state).toBe('APPROVED');
    // The task was the scope: the record is out of it now, so a check after the decision would have refused the decision itself.
    expect((await h.call(reviewer, 'GET', `/v1/expense/claims/${id}`)).statusCode).toBe(404);
  });

  it('a return in ASSIGNED scope answers too', async () => {
    const reviewer = await h.customActor(A, { scope: 'ASSIGNED', permissions: ['expense.read.operational', 'expense.finance_decide.operational'] });
    await h.db.query(`update workflow_fallback_reviewer set active = false where company_id = $1 and kind = 'expense_claim'`, [A.id]);
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, reviewer.user]);
    const id = await submitted();
    await decide(manager, (await taskOf(manager, id))!, { decision: 'APPROVE' });
    const returned = await decide(reviewer, (await taskOf(reviewer, id))!, { decision: 'RETURN', reason: 'Add the invoice number (synthetic)' });
    expect(returned.statusCode, returned.body).toBe(200);
    expect(returned.json().state).toBe('RETURNED');
    expect((await h.call(reviewer, 'GET', `/v1/expense/claims/${id}`)).statusCode).toBe(404);
  });

  it('a manager in ASSIGNED scope decides the manager step with no 404', async () => {
    const managerAssigned = await person();
    const claimantEmp = await person();
    await reportsTo(claimantEmp, managerAssigned);
    const assignedManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerAssigned, scope: 'ASSIGNED', duties: ['expense.read.operational', 'expense.manager_decide.operational'] });
    const claimant = await h.actor(A, 'EMPLOYEE', { employeeId: claimantEmp });
    const receipt = await h.call(claimant, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic assigned receipt ${uniq('m')}\n%%EOF\n`).toString('base64') });
    const created = await h.call(claimant, 'POST', '/v1/expense/claims', {
      purpose: 'Assigned manager (synthetic)',
      currency: 'INR',
      lines: [{ category: 'OFFICE_SUPPLIES', expenseDate: today(), merchant: 'Synthetic Merchant', grossAmount: '50', claimedAmount: '50', description: 'Assigned check (synthetic)', receipt: { receiptId: receipt.json().receiptId } }],
    });
    const id = created.json().claimId as string;
    expect((await h.call(claimant, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(claimant, id)).version })).statusCode).toBe(200);
    const decided = await decide(assignedManager, (await taskOf(assignedManager, id))!, { decision: 'APPROVE' });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().state).toBe('FINANCE_PENDING');
    expect((await h.call(assignedManager, 'GET', `/v1/expense/claims/${id}`)).statusCode).toBe(404);
  });
});

describe('a confirmation', () => {
  const taskFor = async (a: TestActor, employeeId: string) =>
    ((await h.call(a, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === employeeId)?.taskId;
  const getCase = (a: TestActor, id: string) => h.call(a, 'GET', `/v1/confirmations/${id}`);

  /** A probationer whose case waits for the decision of the ASSIGNED reviewer on the explicit list. */
  async function atDecision(reviewer: TestActor) {
    await h.db.query(`update workflow_fallback_reviewer set active = false where company_id = $1 and kind = 'employee_confirmation'`, [A.id]);
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true)`, [A.id, reviewer.user]);
    const e = await person('ACTIVE_PROBATION');
    await reportsTo(e, managerEmp);
    const opened = await h.call(hr, 'POST', '/v1/confirmations', { employeeId: e });
    expect(opened.statusCode, opened.body).toBe(201);
    const { caseId } = opened.json() as { caseId: string };
    const recommended = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, {
      expectedVersion: (await getCase(hr, caseId)).json().version,
      reason: 'Manager review (synthetic)',
      recommendation: 'CONFIRM',
      effectiveDate: today(),
    });
    expect(recommended.statusCode, recommended.body).toBe(200);
    return { e, caseId };
  }
  const REVIEWER = ['employee.read.operational', 'confirmation.read.operational', 'confirmation.decide.operational'] as const;

  it('the reviewer in ASSIGNED scope confirms with no 404, and only then loses the record', async () => {
    const reviewer = await h.customActor(A, { scope: 'ASSIGNED', permissions: [...REVIEWER] });
    const { e, caseId } = await atDecision(reviewer);
    const task = await taskFor(reviewer, e);
    expect(task).toBeTruthy();
    expect((await getCase(reviewer, caseId)).statusCode).toBe(200);
    const decided = await h.call(reviewer, 'POST', `/v1/confirmations/tasks/${task}/decision`, { decision: 'APPROVE', reason: 'Independent decision (synthetic)', idempotencyKey: uniq('assigned-conf-') });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json()).toMatchObject({ state: 'CONFIRMED' });
    expect((await getCase(hr, caseId)).json().state).toBe('CONFIRMED');
    expect((await getCase(reviewer, caseId)).statusCode).toBe(404);
  });

  it('a return in ASSIGNED scope answers too', async () => {
    const reviewer = await h.customActor(A, { scope: 'ASSIGNED', permissions: [...REVIEWER] });
    const { e, caseId } = await atDecision(reviewer);
    const decided = await h.call(reviewer, 'POST', `/v1/confirmations/tasks/${await taskFor(reviewer, e)}/decision`, { decision: 'RETURN', reason: 'More evidence needed (synthetic)', idempotencyKey: uniq('assigned-conf-') });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json()).toMatchObject({ state: 'OPEN', action: 'RETURNED' });
    expect((await getCase(reviewer, caseId)).statusCode).toBe(404);
  });
});
