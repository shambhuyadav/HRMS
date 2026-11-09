// "My pending requests" on the Employee dashboard over HTTP (F2; FR-096, FR-097; DF03). A request is pending
// while it waits for a reviewer's decision, or for the employee after a return; a decided request (approved,
// rejected, withdrawn, cancelled), an unsubmitted draft and a process about the employee that the employee did
// not request (confirmation, increment) are not. Synthetic data; dates relative to today route to the manager.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { NOT_OWN_REQUEST_KINDS, OWN_REQUEST_PENDING_STATES } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let managerEmp: string;
let employeeEmp: string;
let approvedLeaveId: string;
let person: (status: string, managerId?: string) => Promise<string>;

const TUE = '2026-03-03';
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** The given ISO weekday (1 = Monday ... 5 = Friday) at least `weeks` weeks ahead. */
const ahead = (weeks: number, isoDow: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  // In the week starting on the first Monday at least `weeks` weeks ahead, so weekdays asked for together keep their
  // order whatever day the tests run (a Tuesday run once put "Tuesday" before "Monday").
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + isoDow - 1);
  return iso(d);
};
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return iso(d);
};

async function myPendingRequests(a: TestActor = employee) {
  const res = await h.call(a, 'GET', '/v1/dashboard');
  expect(res.statusCode).toBe(200);
  const widget = (res.json().widgets as { code: string; status: string; value?: unknown }[]).find((w) => w.code === 'MY_REQUESTS');
  expect(widget?.status).toBe('OK');
  return widget!.value;
}

const transactionOf = async (table: string, id: string) => (await h.one<{ transaction_id: string }>(`select transaction_id from ${table} where id = $1`, [id])).transaction_id;
async function managerDecides(tasksPath: string, decisionPath: (taskId: string) => string, table: string, id: string, decision: string) {
  const transactionId = await transactionOf(table, id);
  const task = ((await h.call(manager, 'GET', tasksPath)).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === transactionId);
  expect(task).toBeDefined();
  const res = await h.call(manager, 'POST', decisionPath(task!.taskId), {
    decision,
    idempotencyKey: uniq('dash-key-'),
    ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic reason' }),
  });
  expect(res.statusCode).toBe(200);
}
const decideWork = (id: string, decision: string) =>
  managerDecides('/v1/work-requests/tasks/mine', (t) => `/v1/work-requests/tasks/${t}/decision`, 'outdoor_duty_request', id, decision);
const decideLeave = (table: 'leave_request' | 'leave_cancellation', id: string, decision: string) =>
  managerDecides('/v1/leave/tasks', (t) => `/v1/leave/tasks/${t}/decision`, table, id, decision);

async function submitDuty(date: string) {
  const res = await h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { startDate: date, endDate: date, purpose: 'Client site visit (synthetic)' });
  expect(res.statusCode).toBe(201);
  return res.json().requestId as string;
}
async function submitLeave(date: string) {
  const res = await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: date, endDate: date });
  expect(res.statusCode).toBe(201);
  return res.json().requestId as string;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(
    `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active)
     values ($1, 'leave_request', $2, 1, true), ($1, 'profile_change', $2, 1, true), ($1, 'employee_confirmation', $2, 1, true)`,
    [A.id, hr.user],
  );
  const shiftId = (
    await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })
  ).json().id;
  person = async (status: string, managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, status);
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
    if (managerId) await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
    return e.id as string;
  };
  managerEmp = await person('ACTIVE_CONFIRMED');
  employeeEmp = await person('ACTIVE_CONFIRMED', managerEmp);
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });

  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
    await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
  }
  const attendancePolicy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  await h.call(hr, 'POST', `/v1/attendance/policies/${attendancePolicy.id}/activate`, { expectedVersion: attendancePolicy.version });
  await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: TUE });
  const expensePolicy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  await h.call(hr, 'POST', `/v1/expense/policies/${expensePolicy.id}/activate`, { expectedVersion: expensePolicy.version });
});

afterAll(async () => {
  await h?.stop();
});

describe('My pending requests (F2 Employee dashboard)', () => {
  it('an approved outdoor duty and an approved leave are decided, not pending', async () => {
    const duty = await submitDuty(ahead(3, 2));
    const leave = await submitLeave(ahead(3, 3));
    expect(await myPendingRequests()).toBe(2);
    await decideWork(duty, 'APPROVE');
    await decideLeave('leave_request', leave, 'APPROVE');
    approvedLeaveId = leave;
    expect(await myPendingRequests()).toBe(0);
  });

  it('counts every kind while it waits for a decision or for the employee after a return', async () => {
    // Outdoor duty returned for correction: the employee must resubmit or withdraw it.
    const duty = await submitDuty(ahead(4, 2));
    await decideWork(duty, 'RETURN');
    const leave = await submitLeave(ahead(4, 3));
    // Cancelling approved leave waits for a decision; the approved leave itself stays decided.
    const cancellation = await h.call(employee, 'POST', `/v1/leave/requests/${approvedLeaveId}/cancellation`, { reason: 'Plans changed (synthetic)' });
    expect(cancellation.statusCode).toBe(201);
    const profile = await h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: 'Synthetic Person Renamed' });
    expect(profile.statusCode).toBe(201);
    const record = (await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/attendance?from=${TUE}&to=${TUE}`)).json().items[0];
    const correction = await h.call(employee, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: record.id, status: 'PRESENT', reason: 'Badge reader fault (synthetic)' });
    expect(correction.statusCode).toBe(201);
    // An expense draft is not a request yet.
    const receipt = await h.call(employee, 'POST', '/v1/expense/receipts', {
      fileName: 'receipt.pdf',
      contentBase64: Buffer.from(`%PDF-1.4\n% synthetic receipt ${uniq('r')}\n%%EOF\n`).toString('base64'),
    });
    expect(receipt.statusCode).toBe(201);
    const claim = await h.call(employee, 'POST', '/v1/expense/claims', {
      purpose: 'Client visit (synthetic)',
      currency: 'INR',
      lines: [
        {
          category: 'OTHER',
          expenseDate: daysAgo(3),
          merchant: 'Synthetic Merchant',
          grossAmount: '100',
          claimedAmount: '100',
          description: 'Other (synthetic)',
          receipt: { receiptId: receipt.json().receiptId },
        },
      ],
    });
    expect(claim.statusCode).toBe(201);
    const claimId = claim.json().claimId as string;
    expect(await myPendingRequests()).toBe(5);

    const version = (await h.call(employee, 'GET', `/v1/expense/claims/${claimId}`)).json().version;
    expect((await h.call(employee, 'POST', `/v1/expense/claims/${claimId}/submit`, { expectedVersion: version })).statusCode).toBe(200);
    expect(await myPendingRequests()).toBe(6);

    // Settled requests leave the count; a claim returned to the employee still counts until it is withdrawn.
    expect((await h.call(employee, 'POST', `/v1/work-requests/outdoor_duty/${duty}/withdraw`)).statusCode).toBe(200);
    expect(await myPendingRequests()).toBe(5);
    await decideLeave('leave_request', leave, 'REJECT');
    expect(await myPendingRequests()).toBe(4);
    await decideLeave('leave_cancellation', cancellation.json().cancellationId, 'REJECT');
    expect(await myPendingRequests()).toBe(3);
    expect((await h.call(employee, 'POST', `/v1/profile-changes/${profile.json().requestId}/withdraw`)).statusCode).toBe(200);
    expect(await myPendingRequests()).toBe(2);
    expect((await h.call(employee, 'POST', `/v1/attendance-corrections/${correction.json().requestId}/withdraw`)).statusCode).toBe(200);
    expect(await myPendingRequests()).toBe(1);
    await managerDecides('/v1/expense/tasks', (t) => `/v1/expense/tasks/${t}/decision`, 'expense_claim', claimId, 'RETURN');
    expect(await myPendingRequests()).toBe(1);
    expect((await h.call(employee, 'POST', `/v1/expense/claims/${claimId}/withdraw`)).statusCode).toBe(200);
    expect(await myPendingRequests()).toBe(0);
  });

  it('a confirmation review about the employee is not one of the employee’s requests', async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    const probationer = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    const opened = await h.call(hr, 'POST', '/v1/confirmations', { employeeId: e.id });
    expect(opened.statusCode).toBe(201);
    const caseId = opened.json().caseId as string;
    const { version } = (await h.call(hr, 'GET', `/v1/confirmations/${caseId}`)).json();
    const recommended = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, {
      expectedVersion: version,
      recommendation: 'EXTEND',
      extensionMonths: 1,
      reason: 'Manager review (synthetic)',
    });
    expect(recommended.json().state).toBe('REVIEW_PENDING');
    expect(await myPendingRequests(probationer)).toBe(0);
  });

  describe('Leave and expense decisions waiting (F2 Reporting Manager; FR-060 "dashboard counts reconcile to the queue")', () => {
    const widget = async (a: TestActor = manager) =>
      ((await h.call(a, 'GET', '/v1/dashboard')).json().widgets as { code: string; status: string; title: string; value?: number }[]).find((w) => w.code === 'MY_TASKS')!;
    const queues = async () => {
      const leave = await h.call(manager, 'GET', '/v1/leave/tasks');
      const expense = await h.call(manager, 'GET', '/v1/expense/tasks');
      expect([leave.statusCode, expense.statusCode]).toEqual([200, 200]);
      return (leave.json().items as unknown[]).length + (expense.json().items as unknown[]).length;
    };
    const allPending = async () => (await h.one<{ n: number }>(`select count(*)::int as n from approval_task where company_id = $1 and assignee_user_id = $2 and state = 'PENDING'`, [A.id, manager.user])).n;

    it('counts the leave and expense queues exactly, and none of the manager’s other duties', async () => {
      const start = (await widget()).value!;
      expect(start).toBe(await queues());

      // Other duties of the manager are in their own queues and do not move this count.
      const pendingBefore = await allPending();
      await submitDuty(ahead(6, 2));
      const resignee = await person('ACTIVE_CONFIRMED', managerEmp);
      const resigning = await h.actor(A, 'EMPLOYEE', { employeeId: resignee });
      const resigned = await h.call(resigning, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: ahead(8, 5) });
      expect(resigned.statusCode, resigned.body).toBe(201);
      expect(await allPending()).toBe(pendingBefore + 2);
      expect((await widget()).value).toBe(start);
      expect(await queues()).toBe(start);

      // Each kind it does count moves it by one, and still equals the queues.
      const leave = await submitLeave(ahead(6, 3));
      expect((await widget()).value).toBe(start + 1);
      await decideLeave('leave_request', leave, 'APPROVE');
      expect((await widget()).value).toBe(start);
      const cancellation = await h.call(employee, 'POST', `/v1/leave/requests/${leave}/cancellation`, { reason: 'Plans changed (synthetic)' });
      expect(cancellation.statusCode, cancellation.body).toBe(201);
      expect((await widget()).value).toBe(start + 1);
      const receipt = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'receipt.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
      expect(receipt.statusCode, receipt.body).toBe(201);
      const claim = await h.call(employee, 'POST', '/v1/expense/claims', {
        purpose: 'Client visit (synthetic)',
        currency: 'INR',
        lines: [{ category: 'OTHER', expenseDate: daysAgo(3), merchant: 'Synthetic Merchant', grossAmount: '100', claimedAmount: '100', description: 'Other (synthetic)', receipt: { receiptId: receipt.json().receiptId } }],
      });
      expect(claim.statusCode, claim.body).toBe(201);
      const claimId = claim.json().claimId as string;
      const { version } = (await h.call(employee, 'GET', `/v1/expense/claims/${claimId}`)).json();
      expect((await h.call(employee, 'POST', `/v1/expense/claims/${claimId}/submit`, { expectedVersion: version })).statusCode).toBe(200);
      expect((await widget()).value).toBe(start + 2);
      expect(await queues()).toBe(start + 2);
    });

    // I-84 item 5, I-89 item 2 (0241): payment preparation runs no workflow, so the figure is the scope's claims awaiting preparation
    // and draft payments, never this person's tasks of another assignment (the manager's pending leave and expense tasks above).
    it("shows a treasury operator the payment preparation count, never the same person's other tasks", async () => {
      const shown = await widget(await h.actor(A, 'TREASURY_OPERATOR', { user: manager.user }));
      expect(shown).toMatchObject({ status: 'OK', value: 0, title: 'Claims awaiting payment preparation and draft payments not yet ready' });
    });

    it('moves the widgets of an existing company (0120); one pointed elsewhere is left alone', async () => {
      const widgetRow = (role: string) =>
        h.db.query(
          `update role_dashboard_widget w set metric_code = 'MY_OPEN_TASKS', title = 'Assigned tasks'
             from role_dashboard_definition d join role r on r.company_id = d.company_id and r.id = d.role_id
            where d.company_id = w.company_id and d.id = w.dashboard_id and d.company_id = $1 and r.code = $2 and w.widget_code = 'MY_TASKS'`,
          [A.id, role],
        );
      const metrics = async () =>
        Object.fromEntries(
          (
            await h.db.query<{ code: string; metric_code: string }>(
              `select r.code, w.metric_code from role_dashboard_widget w
                 join role_dashboard_definition d on d.company_id = w.company_id and d.id = w.dashboard_id
                 join role r on r.company_id = d.company_id and r.id = d.role_id
                where w.company_id = $1 and w.widget_code = 'MY_TASKS' and r.code in ('REPORTING_MANAGER', 'TREASURY_OPERATOR', 'HR_ADMINISTRATOR')`,
              [A.id],
            )
          ).rows.map((r) => [r.code, r.metric_code]),
        );
      await widgetRow('REPORTING_MANAGER');
      await widgetRow('TREASURY_OPERATOR');
      await h.db.query(readFileSync(new URL('../../../../../db/migrations/0120_dashboard_task_widgets.sql', import.meta.url), 'utf8'));
      expect(await metrics()).toEqual({ REPORTING_MANAGER: 'LEAVE_EXPENSE_TASKS', TREASURY_OPERATOR: 'NOT_YET_AVAILABLE', HR_ADMINISTRATOR: 'MY_OPEN_TASKS' });
    });
  });

  it('classifies every catalogued transaction kind and every waiting state', async () => {
    // Processes about an employee and company records: never one of the employee's own requests.
    const notRequests = NOT_OWN_REQUEST_KINDS;
    const kinds = (await h.db.query<{ kind: string }>(`select kind from transaction_kind order by kind`)).rows.map((r) => r.kind);
    expect(
      kinds.filter((k) => !(k in OWN_REQUEST_PENDING_STATES) && !notRequests.includes(k)),
      'a new transaction kind must be classified in OWN_REQUEST_PENDING_STATES or as not a request',
    ).toEqual([]);
    const catalogue = (await h.db.query<{ kind: string; state: string; terminal: boolean }>(`select kind, state, terminal from transaction_state`)).rows;
    for (const [kind, pending] of Object.entries(OWN_REQUEST_PENDING_STATES)) {
      const states = catalogue.filter((r) => r.kind === kind);
      expect(
        pending.filter((s) => !states.some((r) => r.state === s && !r.terminal)),
        `${kind}: every pending state is a catalogued, non-terminal state`,
      ).toEqual([]);
      // Any other open state is a draft never submitted or a decision; a new waiting state must be listed.
      expect(
        states.filter((r) => !r.terminal && !pending.includes(r.state) && r.state !== 'DRAFT' && r.state !== 'APPROVED').map((r) => r.state),
        `${kind}: unclassified non-terminal states`,
      ).toEqual([]);
    }
  });
});
