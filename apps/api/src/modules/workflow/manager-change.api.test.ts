// An open task across a reporting-line change (ZT02 "expired manager link and reassigned task"; C4 "Changed organisation or
// manager"; RBAC instruction "Check authority at action time, including ... changed managers"; DF03). The task queue and
// its counts follow current row scope; the task does not transfer by itself; a reroute creates a new task and keeps the
// old one as history. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { runReminders } from '../notification/reminders.js';
import { rerouteOpenTask } from './admin.js';
import { decideTask } from './engine.js';
import { leaveQueue, leaveTasks } from './leave-tasks.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let rerouter: TestActor;
let world: ReturnType<typeof leaveTasks>;
let m1Emp: string;
let m2Emp: string;
let m1: TestActor;
let m2: TestActor;
let today: string;

const REROUTE: PermissionKey = 'workflow.reroute_task.operational';

const fallback = async (...reviewers: TestActor[]) => {
  const res = await h.call(hr, 'PUT', '/v1/workflows/leave_request/fallback-reviewers', { reviewers: reviewers.map((r, i) => ({ userId: r.user, priority: i + 1 })) });
  expect(res.statusCode, res.body).toBe(200);
};
/** The value of the MY_OPEN_TASKS widget on the actor's dashboard. */
const openTaskCount = async (a: TestActor) => {
  const res = await h.call(a, 'GET', '/v1/dashboard');
  expect(res.statusCode, res.body).toBe(200);
  return (res.json().widgets as { code: string; value?: number }[]).find((w) => w.code === 'MY_TASKS')!.value!;
};
const decide = (a: TestActor, taskId: string) => h.call(a, 'POST', `/v1/leave/tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('mgr-change-') });
const decisions = async (taskId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from approval_decision where company_id = $1 and task_id = $2`, [A.id, taskId])).n;
const taskState = async (taskId: string) => (await h.one<{ state: string }>(`select state from approval_task where company_id = $1 and id = $2`, [A.id, taskId])).state;
const reroute = (a: TestActor, taskId: string, reason = 'Reporting line changed (synthetic)') => h.call(a, 'POST', `/v1/workflows/tasks/${taskId}/reroute`, { reason });
const stranded = async (a: TestActor) => (await h.call(a, 'GET', '/v1/workflows/stranded-tasks')).json().items as { taskId: string; ownerEmployeeId: string; assigneeUserId: string }[];
const grantFor = async (a: TestActor, resource: string, action: string) =>
  (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource, action, fieldGroups: ['operational'] })) as AccessGrant;

/** An employee reporting to m1 with a pending leave task in m1's queue. */
async function pendingWithFirstManager() {
  const x = await world.employee(m1Emp);
  const self = await h.actor(A, 'EMPLOYEE', { employeeId: x });
  await world.submitLeave(self);
  const task = (await leaveQueue(h, m1)).find((t) => t.ownerEmployeeId === x)!;
  expect(task).toBeDefined();
  return { x, self, taskId: task.taskId };
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  // The owner has not named who approves a reroute, so no baseline ceiling holds the permission. This test company's role
  // is widened directly to exercise the mechanism.
  await h.db.query(
    `insert into role_permission (company_id, role_id, permission_id, effect)
     select $1, r.id, p.id, 'ALLOW' from role r, permission p
      where r.company_id = $1 and r.code = 'HR_ADMINISTRATOR' and p.resource = 'workflow' and p.action = 'reroute_task' and p.field_group = 'operational'`,
    [A.id],
  );
  rerouter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [REROUTE] });
  world = leaveTasks(h, A, hr);
  await world.activatePolicies();
  m1Emp = await world.employee();
  m2Emp = await world.employee();
  m1 = await h.actor(A, 'REPORTING_MANAGER', { employeeId: m1Emp });
  m2 = await h.actor(A, 'REPORTING_MANAGER', { employeeId: m2Emp });
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  await fallback(hr);
});

afterAll(async () => {
  await h?.stop();
});

describe('after a manager change (ZT02, C4)', () => {
  it('the former manager’s queue, counts and identifiers show nothing; the task stays open and untransferred', async () => {
    const { x, taskId } = await pendingWithFirstManager();
    const before = await openTaskCount(m1);
    expect(before).toBeGreaterThanOrEqual(1);
    expect((await h.call(m1, 'GET', `/v1/employees/${x}`)).statusCode).toBe(200);

    await world.setManager(x, m2Emp, today);

    // Former manager: nothing in the queue, one fewer in the count, and the employee reads as missing.
    const queue = await h.call(m1, 'GET', '/v1/leave/tasks');
    expect(queue.statusCode).toBe(200);
    expect(queue.body).not.toContain(x);
    expect(await openTaskCount(m1)).toBe(before - 1);
    expect((await h.call(m1, 'GET', `/v1/employees/${x}`)).statusCode).toBe(404);

    // C4: no automatic transfer. The old task is still PENDING, and the new manager has no task for it.
    expect(await taskState(taskId)).toBe('PENDING');
    expect((await leaveQueue(h, m2)).some((t) => t.ownerEmployeeId === x)).toBe(false);
    expect((await h.call(m2, 'GET', `/v1/employees/${x}`)).statusCode).toBe(200);
  });

  it('the former manager’s decision is refused at action time and records nothing', async () => {
    const { x, taskId } = await pendingWithFirstManager();
    await world.setManager(x, m2Emp, today);
    const res = await decide(m1, taskId);
    expect(res.statusCode).toBe(404);
    expect(await decisions(taskId)).toBe(0);
    expect(await taskState(taskId)).toBe('PENDING');
  });

  it('the engine itself refuses, so a kind whose module does not re-check row scope is covered too', async () => {
    const { x, taskId } = await pendingWithFirstManager();
    await world.setManager(x, m2Emp, today);
    const grant = await grantFor(m1, 'leave', 'approve');
    await expect(
      withTransaction(h.pool, (tx) => decideTask(tx, { grant, taskId, decision: 'APPROVE', idempotencyKey: uniq('engine-'), permission: { resource: 'leave', action: 'approve' } })),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(await decisions(taskId)).toBe(0);
  });

  it('a filtered reviewer whose employee moved out of the filter loses the task the same way', async () => {
    const reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    await fallback(reviewer);
    const x = await world.employee();
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: x }));
    expect((await leaveQueue(h, reviewer)).some((t) => t.ownerEmployeeId === x)).toBe(true);
    const moved = await h.call(hr, 'POST', `/v1/employees/${x}/assignment`, { departmentId: A.financeDept, locationId: A.loc, designationId: A.desig, effectiveFrom: today });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await leaveQueue(h, reviewer)).some((t) => t.ownerEmployeeId === x)).toBe(false);
    await fallback(hr);
  });

  it('a queued notice naming the request is not delivered to a reviewer who no longer covers the employee', async () => {
    const x = await world.employee(m1Emp);
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: x }));
    await world.setManager(x, m2Emp, today);
    await dispatchOutbox(h.pool, 500);
    const delivered = await h.db.query(
      `select 1 from notification n join business_transaction bt on bt.company_id = n.company_id and bt.id = n.transaction_id
        where n.company_id = $1 and n.recipient_user_id = $2 and n.category = 'LEAVE_SUBMITTED' and n.state = 'DELIVERED' and bt.owner_employee_id = $3`,
      [A.id, m1.user, x],
    );
    expect(delivered.rowCount).toBe(0);
  });

  it('reminders stop for the assignee who cannot act; the escalation still reaches the fallback list', async () => {
    const { x, taskId } = await pendingWithFirstManager();
    await world.setManager(x, m2Emp, today);
    await withTransaction(h.pool, async (tx) => {
      await tx.query(`set local session_replication_role = replica`);
      await tx.query(`update approval_task set created_at = now() - interval '20 days' where company_id = $1 and id = $2`, [A.id, taskId]);
    });
    await runReminders(h.pool, A.id);
    const sent = async (category: string) =>
      (
        await h.db.query<{ u: string }>(
          `select n.recipient_user_id as u from notification n join notification_event ev on ev.company_id = n.company_id and ev.id = n.event_id
            where n.company_id = $1 and n.category = $2 and ev.event_key = $3`,
          [A.id, category, `${category}:${taskId}`],
        )
      ).rows.map((r) => r.u);
    expect(await sent('APPROVAL_REMINDER')).toEqual([]);
    expect(await sent('APPROVAL_ESCALATION')).toContain(hr.user);
  });
});

describe('reroute (C4 "owner-approved rerouting creates new task with history")', () => {
  it('no baseline role can hold the permission until the owner decides: a default HR Administrator is refused and nothing changes', async () => {
    const { x, taskId } = await pendingWithFirstManager();
    await world.setManager(x, m2Emp, today);
    const res = await reroute(hr, taskId);
    expect(res.statusCode).toBe(403);
    expect(await taskState(taskId)).toBe('PENDING');
    // A fresh company's ceilings do not hold it, so it cannot even be proposed.
    const B = await h.makeCompany();
    const bAdmin = await h.actor(B, 'SYSTEM_ADMINISTRATOR');
    const bUser = await h.actor(B, 'EMPLOYEE');
    const proposed = await h.call(bAdmin, 'POST', '/v1/access/assignments', { userId: bUser.user, roleCode: 'HR_ADMINISTRATOR', effectiveFrom: '2026-01-01T00:00:00Z', permissions: [REROUTE] });
    expect(proposed.statusCode).toBe(422);
    expect(proposed.json().error).toBe('OUTSIDE_ROLE_CEILING');
  });

  it('routing administration sees the stranded task, within its row scope', async () => {
    const { x, taskId } = await pendingWithFirstManager();
    expect((await stranded(hr)).some((t) => t.taskId === taskId)).toBe(false);
    await world.setManager(x, m2Emp, today);
    expect((await stranded(hr)).find((t) => t.taskId === taskId)).toMatchObject({ ownerEmployeeId: x, assigneeUserId: m1.user });
    const financeOnly = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    expect((await stranded(financeOnly)).some((t) => t.taskId === taskId)).toBe(false);
    expect((await h.call(m1, 'GET', '/v1/workflows/stranded-tasks')).statusCode).toBe(403);
  });

  it('supersedes the old task, creates a new one for the current manager, keeps the history, and the new manager decides', async () => {
    const { x, taskId } = await pendingWithFirstManager();
    await world.setManager(x, m2Emp, today);

    const res = await reroute(rerouter, taskId);
    expect(res.statusCode, res.body).toBe(200);
    const { taskId: newTaskId, assigneeUserId } = res.json() as { taskId: string; assigneeUserId: string };
    expect(assigneeUserId).toBe(m2.user);
    expect(await taskState(taskId)).toBe('SUPERSEDED');

    const audit = await h.one<{ actor_user_id: string; reason: string; before_values: { operational: { assigneeUserId: string } }; after_values: { operational: { newTaskId: string; assigneeUserId: string } } }>(
      `select actor_user_id, reason, before_values, after_values from audit_event where company_id = $1 and resource_code = 'approval_task' and action = 'REROUTE' and record_key = $2`,
      [A.id, taskId],
    );
    expect(audit).toMatchObject({ actor_user_id: rerouter.user, reason: 'Reporting line changed (synthetic)' });
    expect(audit.before_values.operational.assigneeUserId).toBe(m1.user);
    expect(audit.after_values.operational).toMatchObject({ newTaskId, assigneeUserId: m2.user });

    // The new assignee sees it and is told; the former one cannot act on the old task.
    expect((await leaveQueue(h, m2)).map((t) => t.taskId)).toContain(newTaskId);
    const told = (await h.call(m2, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
    expect(told.find((n) => n.category === 'APPROVAL_REROUTED')?.body).toBe('A leave request request has been routed to you for your decision.');
    expect((await decide(m1, taskId)).statusCode).toBe(409);
    const decided = await decide(m2, newTaskId);
    expect(decided.statusCode, decided.body).toBe(200);
    expect(decided.json().state).toBe('APPROVED');
    expect(await decisions(taskId)).toBe(0);
  });

  it('refuses a task its assignee can still decide, a finished task, one’s own request, and a task outside the actor’s scope', async () => {
    const { x, taskId } = await pendingWithFirstManager();
    const notStranded = await reroute(rerouter, taskId);
    expect(notStranded.statusCode).toBe(409);
    expect(notStranded.json().error).toBe('TASK_NOT_STRANDED');
    expect(await taskState(taskId)).toBe('PENDING');

    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [REROUTE], departmentFilter: A.financeDept });
    await world.setManager(x, m2Emp, today);
    expect((await reroute(narrow, taskId)).statusCode).toBe(404);

    const ownEmp = await world.employee(m1Emp);
    const ownRerouter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [REROUTE], employeeId: ownEmp });
    const ownSelf = await h.actor(A, 'EMPLOYEE', { user: ownRerouter.user });
    await world.submitLeave(ownSelf);
    const own = (await leaveQueue(h, m1)).find((t) => t.ownerEmployeeId === ownEmp)!;
    await world.setManager(ownEmp, m2Emp, today);
    const refused = await reroute(ownRerouter, own.taskId);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('SELF_ACTION_NOT_ALLOWED');

    expect((await reroute(rerouter, taskId)).statusCode).toBe(200);
    expect((await reroute(rerouter, taskId)).statusCode).toBe(409);
    expect((await reroute(rerouter, '00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('re-checks authority inside the transaction: a duty withdrawn after the route guard refuses and changes nothing', async () => {
    const { x, taskId } = await pendingWithFirstManager();
    await world.setManager(x, m2Emp, today);
    const temp = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [REROUTE] });
    const grant = await grantFor(temp, 'workflow', 'reroute_task');
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where company_id = $1 and id = $2`, [A.id, temp.assignment]);
    await expect(withTransaction(h.pool, (tx) => rerouteOpenTask(tx, grant, taskId, 'Synthetic'))).rejects.toMatchObject({ statusCode: 403 });
    expect(await taskState(taskId)).toBe('PENDING');
  });

  it('a back-dated request keeps its override: the reroute of a step HR received goes to the list, not the manager (DF05)', async () => {
    const hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
    const hrA = await h.actor(A, 'HR_ADMINISTRATOR');
    await fallback(hrA, hr2);
    const x = await world.employee(m1Emp);
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: x });
    const longAgo = new Date(Date.now() - 60 * 86_400_000);
    while (longAgo.getUTCDay() !== 1) longAgo.setUTCDate(longAgo.getUTCDate() - 1);
    const day = longAgo.toISOString().slice(0, 10);
    const submitted = await h.call(self, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: day, endDate: day });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const task = (await leaveQueue(h, hrA)).find((t) => t.ownerEmployeeId === x)!;
    expect(task).toBeDefined();
    await h.db.query(`update role_assignment_permission set active = false where role_assignment_id = $1`, [hrA.assignment]);
    const res = await reroute(rerouter, task.taskId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().assigneeUserId).toBe(hr2.user);
    await fallback(hr);
  });

  it('the step can come back to someone who held it before; when nobody is eligible nothing changes', async () => {
    const r1 = await h.actor(A, 'HR_ADMINISTRATOR');
    const r2 = await h.actor(A, 'HR_ADMINISTRATOR');
    await fallback(r1, r2);
    const leaveApprove = `permission_id = (select id from permission where resource = 'leave' and action = 'approve' and field_group = 'operational')`;
    const setDuty = (a: TestActor, active: boolean) => h.db.query(`update role_assignment_permission set active = $2 where role_assignment_id = $1 and ${leaveApprove}`, [a.assignment, active]);
    const x = await world.employee();
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: x }));
    const firstTask = (await leaveQueue(h, r1)).find((t) => t.ownerEmployeeId === x)!;

    await setDuty(r1, false);
    const toR2 = await reroute(rerouter, firstTask.taskId);
    expect(toR2.json().assigneeUserId).toBe(r2.user);
    await setDuty(r1, true);
    await setDuty(r2, false);
    const backToR1 = await reroute(rerouter, toR2.json().taskId);
    expect(backToR1.statusCode, backToR1.body).toBe(200);
    expect(backToR1.json().assigneeUserId).toBe(r1.user);

    // Nobody eligible: a repairable routing error, and the open task stays where it is.
    await setDuty(r1, false);
    const none = await reroute(rerouter, backToR1.json().taskId);
    expect(none.statusCode).toBe(422);
    expect(none.json().error).toBe('NO_ELIGIBLE_REVIEWER');
    expect(await taskState(backToR1.json().taskId)).toBe('PENDING');
    await fallback(hr);
  });

  it('the database allows one open task per step', async () => {
    const { taskId } = await pendingWithFirstManager();
    const t = await h.one<{ instance_id: string; workflow_id: string; step_id: string }>(`select instance_id, workflow_id, step_id from approval_task where id = $1`, [taskId]);
    await expect(
      h.db.query(`insert into approval_task (company_id, instance_id, workflow_id, step_id, assignee_user_id, state) values ($1, $2, $3, $4, $5, 'PENDING')`, [A.id, t.instance_id, t.workflow_id, t.step_id, m2.user]),
    ).rejects.toMatchObject({ code: '23505' });
  });
});
