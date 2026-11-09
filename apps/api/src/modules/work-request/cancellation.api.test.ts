// Cancelling an approved outdoor-duty or holiday-work request (I-84 item 15, decided under owner delegation, 6 Nov 2026; I-74 item 10;
// FR-027; DF03 "approved changes need a controlled reversal/cancellation action"; DF12 "withdrawn/cancelled"; I-81 item 3). Over HTTP
// on the real routes and database. Future dates are routed to the manager; past fixed dates (more than 7 days back) to HR. Synthetic data.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { BASELINE_ROLES } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let shiftId: string;
let managerEmp: string;

const CANCEL = 'work_request.cancel.operational';
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** The given ISO weekday (1 = Monday ... 7 = Sunday) of the week starting on the first Monday at least `weeks` weeks ahead. */
const ahead = (weeks: number, isoDow: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + isoDow - 1);
  return iso(d);
};
const TABLE = { outdoor_duty: 'outdoor_duty_request', holiday_work: 'holiday_work_request' } as const;
type Kind = keyof typeof TABLE;

const person = async () => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json() as { id: string };
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
  await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  return e.id;
};
const taskOf = async (kind: Kind, requestId: string) => {
  const { transaction_id: tx } = await h.one<{ transaction_id: string }>(`select transaction_id from ${TABLE[kind]} where id = $1`, [requestId]);
  return h.one<{ id: string; assignee_user_id: string }>(
    `select t.id, t.assignee_user_id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
      where i.transaction_id = $1 and t.state = 'PENDING'`,
    [tx],
  );
};
const deciderOf = (userId: string) => (userId === manager.user ? manager : hr);
/** An approved request of `who`, through the real routes. */
async function approved(who: TestActor, kind: Kind, day: string) {
  const res = await h.call(who, 'POST', `/v1/work-requests/${kind}`, { startDate: day, endDate: day, purpose: 'Client site visit (synthetic)' });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().requestId as string;
  const task = await taskOf(kind, id);
  const decided = await h.call(deciderOf(task.assignee_user_id), 'POST', `/v1/work-requests/tasks/${task.id}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('wr-cancel-key-') });
  expect(decided.json().state, decided.body).toBe('APPROVED');
  return { id, version: await versionOf(kind, id) };
}
const versionOf = async (kind: Kind, id: string) => (await h.one<{ version: number }>(`select version from ${TABLE[kind]} where id = $1`, [id])).version;
const stateOf = async (kind: Kind, id: string) => (await h.one<{ state: string }>(`select r.state || '/' || bt.state as state from ${TABLE[kind]} r join business_transaction bt on bt.id = r.transaction_id where r.id = $1`, [id])).state;
const cancelOwn = (a: TestActor, kind: Kind, id: string, expectedVersion: number, reason = 'Plans changed (synthetic)') =>
  h.call(a, 'POST', `/v1/work-requests/${kind}/${id}/cancel`, { reason, expectedVersion });
const cancelFor = (a: TestActor, kind: Kind, id: string, expectedVersion: number, reason = 'Assignment withdrawn (synthetic)') =>
  h.call(a, 'POST', `/v1/work-requests/${kind}/${id}/cancel-for-employee`, { reason, expectedVersion });
const inbox = async (a: TestActor, category: string) => ((await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[]).filter((n) => n.category === category);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [] })).json().id;
  managerEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('the employee cancels an approved request before its first day (FR-027; I-84 item 15)', () => {
  it('FR-027: cancelled with a reason, final, its day free again, audited, and its approver told', async () => {
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: await person() });
    const day = ahead(3, 2);
    const { id, version } = await approved(employee, 'outdoor_duty', day);
    await dispatchOutbox(h.pool, 500);
    const toldBefore = (await inbox(manager, 'WORK_REQUEST_WITHDRAWN')).length;

    const res = await cancelOwn(employee, 'outdoor_duty', id, version);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ requestId: id, state: 'CANCELLED', version: version + 1 });
    expect(await stateOf('outdoor_duty', id)).toBe('CANCELLED/CANCELLED');
    // Final: neither cancelled again nor withdrawn.
    expect((await cancelOwn(employee, 'outdoor_duty', id, version + 1)).json().error).toBe('INVALID_STATE');
    expect((await h.call(employee, 'POST', `/v1/work-requests/outdoor_duty/${id}/withdraw`)).json().error).toBe('INVALID_STATE');
    // The day is free: a new request for it is accepted (a cancelled request holds no day).
    expect((await h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { startDate: day, endDate: day, purpose: 'Another visit (synthetic)' })).statusCode).toBe(201);

    const audit = await h.one<{ action: string; reason: string; after: Record<string, unknown> }>(
      `select action, reason, after_values as after from audit_event where resource_code = 'outdoor_duty_request' and record_key = $1 and action = 'CANCEL'`,
      [id],
    );
    expect(audit).toEqual({ action: 'CANCEL', reason: 'Plans changed (synthetic)', after: { operational: { state: 'CANCELLED', by: 'OWN' } } });
    await dispatchOutbox(h.pool, 500);
    const told = await inbox(manager, 'WORK_REQUEST_WITHDRAWN');
    expect(told).toHaveLength(toldBefore + 1);
    expect(told.some((n) => n.body.includes(day))).toBe(true);
    expect(JSON.stringify(told)).not.toContain('Client site visit');
  });

  it('FR-027: a holiday-work request is cancelled the same way', async () => {
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: await person() });
    const { id, version } = await approved(employee, 'holiday_work', ahead(3, 6));
    expect((await cancelOwn(employee, 'holiday_work', id, version)).json().state).toBe('CANCELLED');
  });

  it('FR-027: refused for a pending request (it is withdrawn), a started one, a stale version, someone else’s request, or no reason', async () => {
    const emp = await person();
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: emp });
    const other = await h.actor(A, 'EMPLOYEE', { employeeId: await person() });
    const pending = (await h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { startDate: ahead(4, 3), endDate: ahead(4, 3), purpose: 'Pending (synthetic)' })).json().requestId as string;
    expect((await cancelOwn(employee, 'outdoor_duty', pending, await versionOf('outdoor_duty', pending))).json().error).toBe('INVALID_STATE');

    const started = await approved(employee, 'outdoor_duty', '2026-03-03');
    const refused = await cancelOwn(employee, 'outdoor_duty', started.id, started.version);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('REQUEST_STARTED');

    const future = await approved(employee, 'outdoor_duty', ahead(4, 4));
    expect((await cancelOwn(employee, 'outdoor_duty', future.id, future.version + 5)).json().error).toBe('STALE_VERSION');
    expect((await cancelOwn(other, 'outdoor_duty', future.id, future.version)).statusCode).toBe(404);
    expect((await cancelOwn(employee, 'outdoor_duty', future.id, future.version, '   ')).json().error).toBe('REASON_REQUIRED');
    expect(await stateOf('outdoor_duty', future.id)).toBe('APPROVED/APPROVED');
  });
});

describe('HR cancels an approved request for the employee (FR-027; I-84 item 15; I-81 item 3)', () => {
  it('FR-027: a default duty of the HR Administrator and of no other role; the employee is told', async () => {
    expect(BASELINE_ROLES.filter((r) => r.ceiling.includes(CANCEL)).map((r) => r.code)).toEqual(['HR_ADMINISTRATOR']);
    expect(BASELINE_ROLES.filter((r) => r.defaultDuties.includes(CANCEL)).map((r) => r.code)).toEqual(['HR_ADMINISTRATOR']);
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: await person() });
    const { id, version } = await approved(employee, 'outdoor_duty', ahead(3, 4));
    for (const refusedActor of [manager, employee, await h.actor(A, 'HR_ADMINISTRATOR', { duties: BASELINE_ROLES.find((r) => r.code === 'HR_ADMINISTRATOR')!.defaultDuties.filter((k) => k !== CANCEL) })]) {
      expect((await cancelFor(refusedActor, 'outdoor_duty', id, version)).statusCode).toBe(403);
    }
    await dispatchOutbox(h.pool, 500);
    const res = await cancelFor(hr, 'outdoor_duty', id, version);
    expect(res.statusCode, res.body).toBe(200);
    expect(await stateOf('outdoor_duty', id)).toBe('CANCELLED/CANCELLED');
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(employee, 'WORK_REQUEST_DECIDED')).some((n) => /was cancelled/i.test(n.body))).toBe(true);
  });

  it('FR-027: within the HR row scope, never one’s own request, and not once the request has started inside employment', async () => {
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: await person() });
    const { id, version } = await approved(employee, 'outdoor_duty', ahead(3, 5));
    const financeOnly = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    expect((await cancelFor(financeOnly, 'outdoor_duty', id, version)).statusCode).toBe(404);

    const hrEmp = await person();
    const hrSelf = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: hrEmp });
    const ownSeat = await h.actor(A, 'EMPLOYEE', { user: hrSelf.user });
    const own = await approved(ownSeat, 'outdoor_duty', ahead(3, 3));
    const self = await cancelFor(hrSelf, 'outdoor_duty', own.id, own.version);
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe('SELF_ACTION_NOT_ALLOWED');

    const started = await approved(employee, 'outdoor_duty', '2026-03-10');
    expect((await cancelFor(hr, 'outdoor_duty', started.id, started.version)).json().error).toBe('REQUEST_STARTED');
  });

  it('I-81 item 3: a request whose days all fall after the approved last working date is cancelled by HR though they have passed', async () => {
    const emp = await person();
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: emp });
    const after = await approved(employee, 'outdoor_duty', '2026-03-17');
    const within = await approved(employee, 'outdoor_duty', '2026-03-12');
    // An approved exit with a last working date of 13 March (fixture row, written as a restore would).
    await h.db.query('set session_replication_role = replica');
    try {
      await h.db.query(
        `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, recommended_leaving_date, recommended_at,
                                approved_leaving_date, approved_at, prior_status_code, leaving_date, state)
         values ($1, $2, $3, 'RESIGNATION', '2026-02-10', '2026-03-13', '2026-03-13', now(), '2026-03-13', now(), 'ACTIVE_CONFIRMED', '2026-03-13', 'APPROVED')`,
        [A.id, emp, randomUUID()],
      );
    } finally {
      await h.db.query('set session_replication_role = origin');
    }
    expect((await cancelOwn(employee, 'outdoor_duty', after.id, after.version)).json().error).toBe('REQUEST_STARTED');
    expect((await cancelFor(hr, 'outdoor_duty', within.id, within.version)).json().error).toBe('REQUEST_STARTED');
    const res = await cancelFor(hr, 'outdoor_duty', after.id, after.version);
    expect(res.statusCode, res.body).toBe(200);
    const audit = await h.one<{ after: Record<string, unknown> }>(`select after_values as after from audit_event where resource_code = 'outdoor_duty_request' and record_key = $1 and action = 'CANCEL'`, [after.id]);
    expect(audit.after).toEqual({ operational: { state: 'CANCELLED', by: 'HR', afterLastWorkingDate: '2026-03-13' } });
  });
});
