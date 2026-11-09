// Employee self-service change requests and reviewer-routing administration over HTTP (FR-059; FR-021; DF02;
// DF03; DF04). Synthetic data; a fixed past Tuesday (2026-03-03) is used for attendance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hr2: TestActor;
let manager: TestActor;
let employee: TestActor;
let colleague: TestActor;
let employeeEmp: string;
let originalName: string;

const TUE = '2026-03-03';
const decide = (a: TestActor, path: string, taskId: string, decision: string) =>
  h.call(a, 'POST', `/v1/${path}/tasks/${taskId}/decision`, { decision, idempotencyKey: uniq('ss-key-'), ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic decision' }) });
const tasks = async (a: TestActor, path: string) => (await h.call(a, 'GET', `/v1/${path}/tasks/mine`)).json().items as { taskId: string; transactionId: string; request: Record<string, unknown> | null }[];
const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
  const shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
  const person = async (managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
    if (managerId) await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
    return e as { id: string; displayName: string };
  };
  const managerEmp = (await person()).id;
  const emp = await person(managerEmp);
  employeeEmp = emp.id;
  originalName = emp.displayName;
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  colleague = await h.actor(A, 'EMPLOYEE', { employeeId: (await person(managerEmp)).id });
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version });
  await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: TUE });
});

afterAll(async () => {
  await h?.stop();
});

describe('reviewer routing administration (DF03)', () => {
  it('lists each kind with its steps and the list it uses', async () => {
    const res = await h.call(hr, 'GET', '/v1/workflows');
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { kind: string; routingKind: string | null; steps: { permission: string; selectionRule: string }[] }[];
    expect(items.find((i) => i.kind === 'profile_change')).toMatchObject({ routingKind: null, steps: [{ permission: 'employee.update.operational', selectionRule: 'HR_FALLBACK_LIST' }] });
    expect(items.find((i) => i.kind === 'attendance_correction')).toMatchObject({ routingKind: 'leave_request', steps: [{ selectionRule: 'DIRECT_MANAGER' }] });
    expect((await h.call(employee, 'GET', '/v1/workflows')).statusCode).toBe(403);
  });

  it('accepts only eligible reviewers, refuses shared or duplicate lists, and audits the change', async () => {
    const put = (kind: string, reviewers: { userId: string; priority: number }[]) => h.call(hr, 'PUT', `/v1/workflows/${kind}/fallback-reviewers`, { reviewers });
    expect((await put('profile_change', [{ userId: employee.user, priority: 1 }])).json().error).toBe('REVIEWER_NOT_ELIGIBLE');
    expect((await put('profile_change', [{ userId: hr.user, priority: 1 }, { userId: hr.user, priority: 2 }])).json().error).toBe('DUPLICATE_REVIEWER');
    expect((await put('attendance_correction', [{ userId: hr.user, priority: 1 }])).json().error).toBe('SHARED_ROUTING');
    expect((await put('profile_change', [{ userId: hr.user, priority: 1 }])).statusCode).toBe(200);
    expect((await put('leave_request', [{ userId: hr2.user, priority: 1 }])).statusCode).toBe(200);
    const listed = ((await h.call(hr, 'GET', '/v1/workflows')).json().items as { kind: string; fallbackReviewers: { userId: string; eligible: boolean }[] }[]).find((i) => i.kind === 'profile_change')!;
    expect(listed.fallbackReviewers).toEqual([expect.objectContaining({ userId: hr.user, eligible: true })]);
    const audit = await h.one<{ n: string }>(`select count(*) as n from audit_event where company_id = $1 and resource_code = 'workflow_routing' and action = 'SET_FALLBACK'`, [A.id]);
    expect(Number(audit.n)).toBe(2);
    // The picker offers exactly the users who can decide the kind.
    const candidates = (await h.call(hr, 'GET', '/v1/workflows/profile_change/candidates')).json().items.map((c: { userId: string }) => c.userId);
    expect(candidates).toEqual(expect.arrayContaining([hr.user, hr2.user]));
    expect(candidates).not.toContain(employee.user);
    expect(candidates).not.toContain(manager.user);
  });
});

describe('profile change requests (FR-059, DF04)', () => {
  it('changes nothing until an HR reviewer approves; approval applies through the ordinary update path', async () => {
    const newName = `Renamed ${uniq('P')} (synthetic)`;
    // Confidential fields are not requestable: the request schema drops them, so nothing is left to change.
    expect((await h.call(employee, 'POST', '/v1/me/profile-changes', { dateOfBirth: '1990-01-01' })).json().error).toBe('NO_CHANGE');
    expect((await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/profile-changes`)).json().items).toEqual([]);
    expect((await h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: originalName })).json().error).toBe('NO_CHANGE');
    expect((await h.call(employee, 'POST', '/v1/me/profile-changes', { workEmail: 'not-an-email' })).json().error).toBe('INVALID_WORK_EMAIL');
    const res = await h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: newName });
    expect(res.statusCode).toBe(201);
    expect((await h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: 'Another (synthetic)' })).statusCode).toBe(409); // one open request
    expect((await h.call(hr, 'GET', `/v1/employees/${employeeEmp}`)).json().displayName).toBe(originalName);

    await dispatchOutbox(h.pool);
    expect((await inbox(hr)).find((n) => n.category === 'PROFILE_CHANGE_SUBMITTED')?.body).toContain('A profile change (display name) for');

    const task = (await tasks(hr, 'profile-changes'))[0]!;
    expect(task.request).toMatchObject({ requested: { displayName: newName }, currentValues: { displayName: originalName } });
    expect((await decide(employee, 'profile-changes', task.taskId, 'APPROVE')).statusCode).toBe(403);
    expect((await decide(hr2, 'profile-changes', task.taskId, 'APPROVE')).statusCode).toBe(404); // not assigned to them
    expect((await decide(hr, 'profile-changes', task.taskId, 'RETURN')).json().error).toBe('RETURN_NOT_ALLOWED');
    expect((await decide(hr, 'profile-changes', task.taskId, 'APPROVE')).json().state).toBe('APPROVED');
    expect((await h.call(hr, 'GET', `/v1/employees/${employeeEmp}`)).json().displayName).toBe(newName);
    const update = await h.one<{ actor_user_id: string }>(
      `select actor_user_id from audit_event where resource_code = 'employee' and record_key = $1 and action = 'UPDATE' order by occurred_at desc limit 1`,
      [employeeEmp],
    );
    expect(update.actor_user_id).toBe(hr.user);
    await dispatchOutbox(h.pool);
    expect((await inbox(employee)).find((n) => n.category === 'PROFILE_CHANGE_DECIDED')?.body).toBe('Your profile change (display name) was APPROVED.');
    const own = (await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/profile-changes`)).json().items;
    expect(own[0]).toMatchObject({ state: 'APPROVED', requested: { displayName: newName } });
  });

  it('a rejected request leaves the record unchanged; a pending one can be withdrawn', async () => {
    const before = (await h.call(hr, 'GET', `/v1/employees/${employeeEmp}`)).json().workEmail;
    await h.call(employee, 'POST', '/v1/me/profile-changes', { workEmail: `${uniq('new')}@example.test` });
    const task = (await tasks(hr, 'profile-changes'))[0]!;
    expect((await decide(hr, 'profile-changes', task.taskId, 'REJECT')).json().state).toBe('REJECTED');
    expect((await h.call(hr, 'GET', `/v1/employees/${employeeEmp}`)).json().workEmail).toBe(before);

    const pending = (await h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: 'Withdrawn (synthetic)' })).json();
    expect((await h.call(colleague, 'POST', `/v1/profile-changes/${pending.requestId}/withdraw`)).statusCode).toBe(404);
    expect((await h.call(employee, 'POST', `/v1/profile-changes/${pending.requestId}/withdraw`)).json().state).toBe('WITHDRAWN');
    expect(await tasks(hr, 'profile-changes')).toEqual([]);
    expect((await h.call(colleague, 'GET', `/v1/employees/${employeeEmp}/profile-changes`)).statusCode).toBe(404);
  });
});

describe('attendance correction requests (FR-059, FR-021, DF03)', () => {
  const recordOf = async () => (await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/attendance?from=${TUE}&to=${TUE}`)).json().items[0] as { id: string; status: string };

  it('the direct manager approves; the ordinary amendment applies with its trail; the reason stays private', async () => {
    const record = await recordOf();
    expect(record.status).toBe('ABSENT');
    expect((await h.call(colleague, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: record.id, status: 'PRESENT', reason: 'x' })).statusCode).toBe(404);
    expect((await h.call(employee, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: record.id, status: 'ABSENT', reason: 'x' })).json().error).toBe('NO_CHANGE');
    // Leave, holiday and outdoor duty are never set by a correction (they have their own rules and balances).
    for (const status of ['LEAVE', 'HALF_DAY_LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'ON_DUTY']) {
      expect((await h.call(employee, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: record.id, status, reason: 'x' })).json().error).toBe('STATUS_NOT_CORRECTABLE');
    }
    const res = await h.call(employee, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: record.id, status: 'PRESENT', reason: 'Badge reader fault (synthetic)' });
    expect(res.statusCode).toBe(201);

    await dispatchOutbox(h.pool);
    const note = (await inbox(manager)).find((n) => n.category === 'ATTENDANCE_CORRECTION_SUBMITTED')!;
    expect(note.body).toContain(`on ${TUE} (to PRESENT)`);
    expect(note.body).not.toContain('Badge reader');

    const [task] = await tasks(manager, 'attendance-corrections');
    expect(task!.request).toMatchObject({ workDate: TUE, currentStatus: 'ABSENT', requestedStatus: 'PRESENT' });
    expect(task!.request).not.toHaveProperty('reason'); // the manager holds no reason grant
    expect((await decide(manager, 'attendance-corrections', task!.taskId, 'RETURN')).json().error).toBe('RETURN_NOT_ALLOWED');
    expect((await decide(manager, 'attendance-corrections', task!.taskId, 'APPROVE')).json().state).toBe('APPROVED');

    expect(await recordOf()).toMatchObject({ status: 'PRESENT' });
    const log = (await h.call(hr, 'GET', `/v1/attendance/records/${record.id}/amendments`)).json().items;
    expect(log).toMatchObject([{ oldStatus: 'ABSENT', newStatus: 'PRESENT', actorUserId: manager.user }]);
    // Processing keeps the approved correction.
    await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: TUE });
    expect(await recordOf()).toMatchObject({ status: 'PRESENT' });

    const own = (await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/attendance-corrections`)).json().items;
    // BRD v8.2 H1/TN12: the employee sees the reason they submitted on their own correction.
    expect(own[0]).toMatchObject({ state: 'APPROVED', reason: 'Badge reader fault (synthetic)' });
    // The amendment trail carries the approver's note, which stays private to reason-granted reviewers.
    expect((await h.call(employee, 'GET', `/v1/attendance/records/${record.id}/amendments`)).json().items[0]).not.toHaveProperty('reason');
    const reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['attendance.read.reason'] });
    expect((await h.call(reader, 'GET', `/v1/employees/${employeeEmp}/attendance-corrections`)).json().items[0]).toMatchObject({ reason: 'Badge reader fault (synthetic)' });
  });

  it('a rejection changes nothing; a pending request can be withdrawn; employees cannot decide', async () => {
    const record = await recordOf();
    await h.call(employee, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: record.id, status: 'HALF_DAY', reason: 'Left early (synthetic)' });
    expect((await h.call(employee, 'GET', '/v1/attendance-corrections/tasks/mine')).statusCode).toBe(403);
    const [task] = await tasks(manager, 'attendance-corrections');
    expect((await decide(manager, 'attendance-corrections', task!.taskId, 'REJECT')).json().state).toBe('REJECTED');
    expect(await recordOf()).toMatchObject({ status: 'PRESENT' });

    const pending = (await h.call(employee, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: record.id, status: 'HALF_DAY', reason: 'Again (synthetic)' })).json();
    expect((await h.call(employee, 'POST', `/v1/attendance-corrections/${pending.requestId}/withdraw`)).json().state).toBe('WITHDRAWN');
    expect(await tasks(manager, 'attendance-corrections')).toEqual([]);
  });
});
