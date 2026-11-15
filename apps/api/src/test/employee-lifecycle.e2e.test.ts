// Cross-module end-to-end walk (improvement plan M1): ONE synthetic employee through the main HR flow, over HTTP against
// the real app and PostgreSQL. Each step asserts the status codes and the key database state it leaves behind:
//   1. employee: HR creates the record; the employee starts on probation under a reporting manager;
//   2. leave: policies activated, an opening balance, a request, the manager's approval, the ledger;
//   3. expense: a receipt, a claim, the manager's and finance's decisions, the payment obligation;
//   4. confirmation: HR opens the review, the manager recommends, HR confirms; the employee becomes ACTIVE_CONFIRMED;
//   5. payroll: salary, a February run prepared, reviewed, approved and processed by distinct people;
//   6. exit: resignation, the manager's recommendation, HR approval (NOTICE), and separation after the last working day.
// The steps share state and run in order. Request bodies and setup follow the module tests (leave.api, expense.api,
// confirmation.api, lifecycle/exit.api, payroll/runs.api). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../audit/actors.js';
import type { PermissionKey } from '../modules/access/baseline.js';
import { separateDueExits } from '../modules/lifecycle/exit.js';
import { addDays, today as businessDate, statusOf } from '../modules/lifecycle/lifecycle.fixtures.js';
import {
  APPROVE,
  calculate,
  calendar,
  CONFIG,
  createRun,
  grants,
  head,
  months,
  PREPARE,
  PROCESS,
  processRun,
  record,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
} from '../modules/payroll/payroll.fixtures.js';
import { isModuleActive } from '../modules/registry.js';
import { type Company, type Harness, startHarness, type TestActor } from './harness.js';

const FINANCE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];

const iso = (d: Date) => d.toISOString().slice(0, 10);
/** Monday on or after today + `days` (UTC calendar), as the leave tests pick future working days. */
const mondayAfter = (days: number) => {
  const d = new Date(`${addDays(iso(new Date()), days)}T00:00:00Z`);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
};
const daysAgo = (n: number) => addDays(iso(new Date()), -n);

describe.runIf(isModuleActive('lifecycle') && isModuleActive('payroll'))('employee lifecycle end to end (M1)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let finance: TestActor;
  let manager: TestActor;
  let managerEmp: string;
  let employee: TestActor;
  let employeeId: string;
  let today: string;

  /** Audit actions of one record, oldest first. */
  const auditActions = async (resource: string, recordKey: string) =>
    (
      await h.db.query<{ action: string }>(`select action from audit_event where company_id = $1 and resource_code = $2 and record_key = $3 order by occurred_at, action`, [
        A.id,
        resource,
        recordKey,
      ])
    ).rows.map((r) => r.action);
  const outboxCount = async (topic: string, aggregateId: string) =>
    (await h.one<{ n: number }>(`select count(*)::int as n from outbox_event where company_id = $1 and topic = $2 and aggregate_id = $3`, [A.id, topic, aggregateId])).n;
  const taskState = async (taskId: string) => (await h.one<{ state: string }>(`select state from approval_task where id = $1`, [taskId])).state;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    finance = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    // DF03 fallback reviewers of the kinds this walk routes to HR or finance.
    await h.db.query(
      `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active)
       values ($1, 'leave_request', $2, 1, true), ($1, 'employee_confirmation', $2, 1, true), ($1, 'expense_claim', $3, 1, true)`,
      [A.id, hr.user, finance.user],
    );
    expect((await h.call(hr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
    // The manager works in another department, so the payroll run below (filtered to the employee's department) holds one person.
    const m = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: 'Morgan Manager (synthetic)', departmentId: A.financeDept }));
    expect(m.statusCode, m.body).toBe(201);
    managerEmp = m.json().id;
    await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    today = await businessDate(h, A);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('1. HR creates the employee, who starts on probation under a reporting manager', async () => {
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: 'Erin Example (synthetic)' }));
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({ status: 'DRAFT', joiningDate: '2026-01-05', assignment: { departmentId: A.dept } });
    employeeId = created.id;
    expect(await auditActions('employee', employeeId)).toEqual(['CREATE']);
    expect(await outboxCount('employee.created', employeeId)).toBe(1);

    // Activation is not an API transition yet: the harness sets the status, as every API test does.
    await h.setStatus(A, employeeId, 'ACTIVE_PROBATION');
    const assigned = await h.call(hr, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    expect(assigned.statusCode, assigned.body).toBe(200);
    employee = await h.actor(A, 'EMPLOYEE', { employeeId });

    const own = await h.call(employee, 'GET', `/v1/employees/${employeeId}`);
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ id: employeeId, status: 'ACTIVE_PROBATION', manager: { id: managerEmp } });
    const team = await h.call(manager, 'GET', '/v1/employees');
    expect(team.statusCode).toBe(200);
    expect(team.json().items.map((e: { id: string }) => e.id)).toEqual([employeeId]);
  });

  it('2. leave: an opening balance, a request reserved on submission, the manager approves, the ledger consumes it once', async () => {
    const policies = (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number; state: string }[];
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) expect((await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);

    const opening = await h.call(hr, 'POST', '/v1/leave/adjustments', {
      employeeId,
      leaveType: 'ANNUAL',
      kind: 'OPENING',
      units: '10',
      effectiveDate: '2026-01-05',
      reason: 'Opening balance (synthetic)',
      idempotencyKey: uniq('opening-key-'),
    });
    expect(opening.statusCode, opening.body).toBe(201);
    const balance = async () =>
      ((await h.call(employee, 'GET', `/v1/employees/${employeeId}/leave-balances`)).json().items as { leaveType: string; available: string; pending: string; taken: string }[]).find(
        (b) => b.leaveType === 'ANNUAL',
      );
    expect(await balance()).toMatchObject({ available: '10.0000', pending: '0.0000', taken: '0.0000' });

    const start = mondayAfter(14);
    const submitted = await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: start, endDate: addDays(start, 2), reason: 'Family event (synthetic)' });
    expect(submitted.statusCode, submitted.body).toBe(201);
    expect(submitted.json().units).toBe('3');
    const requestId = submitted.json().requestId as string;
    expect(await balance()).toMatchObject({ available: '7.0000', pending: '3.0000', taken: '0.0000' });

    // Routed to the direct manager, not the HR fallback list.
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from leave_request where id = $1`, [requestId])).transaction_id;
    const tasksOf = async (a: TestActor) => (await h.call(a, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; transactionId: string }[];
    expect((await tasksOf(hr)).find((t) => t.transactionId === tx)).toBeUndefined();
    const task = (await tasksOf(manager)).find((t) => t.transactionId === tx)!;
    expect(task).toBeDefined();
    const decided = await h.call(manager, 'POST', `/v1/leave/tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('decision-key-') });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json()).toMatchObject({ state: 'APPROVED', replayed: false });

    expect(await balance()).toMatchObject({ available: '7.0000', pending: '0.0000', taken: '3.0000' });
    expect(await h.one<{ state: string }>(`select state from leave_request where id = $1`, [requestId])).toEqual({ state: 'APPROVED' });
    expect(await taskState(task.taskId)).toBe('APPROVED');
    const ledger = (
      await h.db.query<{ kind: string; units: string }>(
        `select movement_kind as kind, units::text as units from leave_movement where employee_id = $1
          order by array_position(array['OPENING', 'RESERVATION', 'RESERVATION_RELEASE', 'CONSUMPTION'], movement_kind::text)`,
        [employeeId],
      )
    ).rows;
    expect(ledger).toEqual([
      { kind: 'OPENING', units: '10.0000' },
      { kind: 'RESERVATION', units: '-3.0000' },
      { kind: 'RESERVATION_RELEASE', units: '3.0000' },
      { kind: 'CONSUMPTION', units: '-3.0000' },
    ]);
    expect(await auditActions('leave_balance', employeeId)).toEqual(['OPENING']);
    expect(await auditActions('leave_request', requestId)).toEqual(['CREATE', 'APPROVE']);
    expect(await outboxCount('leave.decided', requestId)).toBe(1);
  });

  it('3. expense: a claim with a receipt, approved by the manager and then by finance, leaves one payment obligation', async () => {
    const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
    expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);

    const receipt = await h.call(employee, 'POST', '/v1/expense/receipts', {
      fileName: 'receipt.pdf',
      contentBase64: Buffer.from(`%PDF-1.4\n% synthetic receipt ${uniq('r')}\n%%EOF\n`).toString('base64'),
    });
    expect(receipt.statusCode, receipt.body).toBe(201);
    const draft = await h.call(employee, 'POST', '/v1/expense/claims', {
      purpose: 'Client visit (synthetic)',
      currency: 'INR',
      lines: [
        {
          category: 'OFFICE_SUPPLIES',
          expenseDate: daysAgo(3),
          merchant: 'Synthetic Merchant',
          grossAmount: '450',
          claimedAmount: '450',
          description: 'Office supplies (synthetic)',
          receipt: { receiptId: receipt.json().receiptId },
        },
      ],
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const claimId = draft.json().claimId as string;
    const claim = async (a: TestActor = employee) => (await h.call(a, 'GET', `/v1/expense/claims/${claimId}`)).json();

    const submitted = await h.call(employee, 'POST', `/v1/expense/claims/${claimId}/submit`, { expectedVersion: (await claim()).version });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(submitted.json()).toMatchObject({ state: 'MANAGER_PENDING' });

    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
    const taskOf = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx);
    const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('exp-key-'), ...body });

    const managerTask = (await taskOf(manager))!;
    const byManager = await decide(manager, managerTask.taskId, { decision: 'APPROVE' });
    expect(byManager.statusCode, byManager.body).toBe(200);
    expect(byManager.json().state).toBe('FINANCE_PENDING');

    const financeTask = (await taskOf(finance))!;
    const lines = (await claim(finance)).lines as { id: string; claimedAmount: string }[];
    const byFinance = await decide(finance, financeTask.taskId, { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
    expect(byFinance.statusCode, byFinance.body).toBe(200);
    expect(byFinance.json()).toMatchObject({ state: 'APPROVED', approvedAmount: '450.0000', paymentState: 'UNPAID' });

    expect(await claim()).toMatchObject({ state: 'APPROVED', paymentState: 'UNPAID', payment: { approvedAmount: '450.0000', netPaid: '0.0000', outstanding: '450.0000' } });
    expect(await taskState(managerTask.taskId)).toBe('APPROVED');
    expect(await taskState(financeTask.taskId)).toBe('APPROVED');
    expect(await h.one<{ state: string; payment_state: string }>(`select state, payment_state from expense_claim where id = $1`, [claimId])).toEqual({
      state: 'APPROVED',
      payment_state: 'UNPAID',
    });
    expect(
      await h.one<{ employee_id: string; approved_amount: string }>(`select employee_id, approved_amount::text from expense_obligation where claim_id = $1`, [claimId]),
    ).toEqual({ employee_id: employeeId, approved_amount: '450.0000' });
    expect(await auditActions('expense_claim', claimId)).toEqual(expect.arrayContaining(['SUBMIT', 'MANAGER_DECIDE_APPROVE', 'FINANCE_DECIDE_APPROVE']));
  });

  it('4. confirmation: HR opens the review, the manager recommends, HR confirms and the employee is ACTIVE_CONFIRMED', async () => {
    const opened = await h.call(hr, 'POST', '/v1/confirmations', { employeeId });
    expect(opened.statusCode, opened.body).toBe(201);
    const { caseId, dueDate } = opened.json() as { caseId: string; dueDate: string };
    expect(dueDate).toBe('2026-04-05'); // three calendar months from joining on 5 January

    const version = (await h.call(hr, 'GET', `/v1/confirmations/${caseId}`)).json().version;
    const recommended = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, {
      expectedVersion: version,
      recommendation: 'CONFIRM',
      effectiveDate: dueDate,
      reason: 'Manager review (synthetic)',
    });
    expect(recommended.statusCode, recommended.body).toBe(200);
    expect(recommended.json().state).toBe('REVIEW_PENDING');

    const task = ((await h.call(hr, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === employeeId)!;
    expect(task).toBeDefined();
    const decided = await h.call(hr, 'POST', `/v1/confirmations/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'HR decision (synthetic)', idempotencyKey: uniq('conf-key-') });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json()).toMatchObject({ state: 'CONFIRMED', action: 'CONFIRMED', actualConfirmationDate: dueDate });

    expect((await h.call(hr, 'GET', `/v1/employees/${employeeId}`)).json()).toMatchObject({ status: 'ACTIVE_CONFIRMED', confirmationDate: dueDate });
    expect(await statusOf(h, employeeId)).toBe('ACTIVE_CONFIRMED');
    expect(await h.one<{ state: string; actual: string }>(`select state, to_char(actual_confirmation_date, 'YYYY-MM-DD') as actual from employee_confirmation where id = $1`, [caseId])).toEqual({
      state: 'CONFIRMED',
      actual: dueDate,
    });
    expect((await h.db.query<{ action: string }>(`select action from confirmation_action where confirmation_id = $1`, [caseId])).rows).toEqual([{ action: 'CONFIRMED' }]);
    expect(await taskState(task.taskId)).toBe('APPROVED');
    expect(await auditActions('employee_confirmation', caseId)).toEqual(expect.arrayContaining(['CONFIRMED']));
    expect(await outboxCount('confirmation.decided', caseId)).toBe(1);
  });

  it('5. payroll: a February run for the employee is prepared, reviewed, approved and processed by distinct people', async () => {
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    const reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    const approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    const processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    const { periods } = await calendar(h, configA, configB, months(2026));
    await salary(h, preparer, employeeId, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'BASIC', amount: '30000' }] });

    const run = await createRun(h, preparer, periods['2026-02']!, { departmentIds: [A.dept] });
    expect(run).toMatchObject({ state: 'DRAFT', members: { included: 1, excluded: 0 } });
    expect((await h.db.query<{ employee_id: string }>(`select employee_id from payroll_run_member where lineage_id = $1`, [run.id])).rows).toEqual([{ employee_id: employeeId }]);
    expect(await calculate(h, preparer, run.id)).toMatchObject({ state: 'CALCULATED', records: { CALCULATED: 1 } });
    expect(await submitAndApprove(h, { preparer, reviewer, approver }, run.id)).toMatchObject({ state: 'APPROVED' });
    const processed = await processRun(h, processor, run.id);
    expect(processed).toMatchObject({ state: 'PROCESSED_LOCKED', processedBy: processor.user });

    const r = await record(h, processor, run.id, employeeId);
    expect(r).toMatchObject({ net: '30000.0000', gross: '30000.0000', bankStatus: 'MISSING' });
    expect(r.lines).toEqual([expect.objectContaining({ componentCode: 'BASIC', amount: '30000.0000' })]);
    // No approved bank instruction: the payment is blocked automatically while the earned salary stays payable.
    expect((await h.db.query(`select hold_kind, reason_code, hold_amount::text from payroll_hold where run_id = $1 and employee_id = $2`, [run.id, employeeId])).rows).toEqual([
      { hold_kind: 'PAYMENT_SAFETY_BLOCK', reason_code: 'BANK_MISSING', hold_amount: '30000.0000' },
    ]);
    expect(await auditActions('payroll_run', run.id)).toEqual(expect.arrayContaining(['PROCESS']));
  });

  it('6. exit: the employee resigns, the manager recommends, HR approves (NOTICE), and the employee is separated after the last working day', async () => {
    const proposed = addDays(today, 30);
    const resigned = await h.call(employee, 'POST', '/v1/me/resignation', { reason: 'Synthetic personal reason', proposedLastWorkingDate: proposed });
    expect(resigned.statusCode, resigned.body).toBe(201);
    expect(resigned.json()).toMatchObject({ state: 'SUBMITTED', requestDate: today, proposedLastWorkingDate: proposed });
    const exitCaseId = resigned.json().exitCaseId as string;

    const taskFor = async (a: TestActor) =>
      ((await h.call(a, 'GET', '/v1/exit-cases/tasks/mine')).json().items as { taskId: string; kind: string; step: string; exitCase: { id: string } | null }[]).find(
        (t) => t.kind === 'exit_case' && t.exitCase?.id === exitCaseId,
      );
    const recommendTask = (await taskFor(manager))!;
    expect(recommendTask.step).toBe('recommend');
    const recommended = await h.call(manager, 'POST', `/v1/exit-cases/tasks/${recommendTask.taskId}/recommend`, { recommendedLastWorkingDate: proposed, idempotencyKey: uniq('lc-key-') });
    expect(recommended.statusCode, recommended.body).toBe(200);
    expect(recommended.json().state).toBe('RECOMMENDED');

    const approveTask = (await taskFor(hr))!;
    expect(approveTask.step).toBe('approve');
    const approved = await h.call(hr, 'POST', `/v1/exit-cases/tasks/${approveTask.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('lc-key-') });
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ state: 'APPROVED', approvedLastWorkingDate: proposed });
    expect(await statusOf(h, employeeId)).toBe('NOTICE');
    expect(await h.one<{ d: string }>(`select to_char(hrms_exit_last_working_date($1, $2), 'YYYY-MM-DD') as d`, [A.id, employeeId])).toEqual({ d: proposed });

    // The approved leave (step 2) ends before the last working date; a new request past it is refused (DF04).
    const pastExit = await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: mondayAfter(40), endDate: mondayAfter(40) });
    expect(pastExit.statusCode).toBe(422);
    expect(pastExit.json().error).toBe('AFTER_LAST_WORKING_DATE');

    // The daily separation job: nothing on the last working day itself (inclusive), separation the day after, once.
    expect(await separateDueExits(h.pool, A.id, proposed, SYSTEM_ACTOR_ID)).toEqual({ due: 0, separated: 0, waitingForWithdrawalDecision: 0 });
    expect(await separateDueExits(h.pool, A.id, addDays(proposed, 1), SYSTEM_ACTOR_ID)).toEqual({ due: 1, separated: 1, waitingForWithdrawalDecision: 0 });
    expect(await statusOf(h, employeeId)).toBe('INACTIVE_SEPARATED');

    const own = (await h.call(employee, 'GET', '/v1/me/exit-cases')).json().items[0];
    expect(own).toMatchObject({ id: exitCaseId, state: 'SEPARATED', lastWorkingDate: proposed });
    expect(own.history.map((e: { action: string }) => e.action)).toEqual(['SUBMIT', 'RECOMMEND', 'APPROVE', 'SEPARATE']);
    expect(await h.one<{ state: string }>(`select state from exit_case where id = $1`, [exitCaseId])).toEqual({ state: 'SEPARATED' });
    expect(await h.one<{ state: string }>(`select state from business_transaction where id = (select transaction_id from exit_case where id = $1)`, [exitCaseId])).toEqual({ state: 'SEPARATED' });
    // The exit's status changes are audited on the employee, whose record and links stay (FR-055).
    const statusTrail = (
      await h.db.query<{ s: string }>(`select after_values->'operational'->>'status' as s from audit_event where record_key = $1 and action = 'STATUS_CHANGE' order by occurred_at`, [employeeId])
    ).rows.map((r) => r.s);
    expect(statusTrail.slice(-2)).toEqual(['NOTICE', 'INACTIVE_SEPARATED']);
    expect(await h.one<{ n: number }>(`select count(*)::int as n from user_employee_link where employee_id = $1`, [employeeId])).toEqual({ n: 1 });
    // A separated employee cannot resign again.
    expect((await h.call(employee, 'POST', '/v1/me/resignation', { reason: 'again', proposedLastWorkingDate: addDays(today, 60) })).json().error).toBe('EMPLOYEE_NOT_ACTIVE');
  });
});
