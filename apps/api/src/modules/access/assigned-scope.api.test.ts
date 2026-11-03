// ASSIGNED row scope is bound to the assignment (C1 "ASSIGNED via eligible current approval_task"; RBAC instruction "Do not
// combine an action granted by one role assignment with a broader scope from another unrelated assignment"; CI22; CI24;
// BR-046; ZT02; ZT30). A pending task lends row scope only to an assignment whose own role and DB109 allowlist hold the
// task's step permission. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { canAccessRequisition } from '../hiring/scope.js';
import { usersCoveringEmployee } from '../workflow/engine.js';
import { leaveQueue, leaveTasks } from '../workflow/leave-tasks.fixtures.js';
import { type AccessGrant, resolveAccess } from './authorize.js';
import type { PermissionKey } from './baseline.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let world: ReturnType<typeof leaveTasks>;

const READ_PERSONAL: PermissionKey[] = ['employee.list.operational', 'employee.read.operational', 'employee.read.personal'];

const detail = (a: TestActor, employeeId: string) => h.call(a, 'GET', `/v1/employees/${employeeId}`);
const list = async (a: TestActor) => (await h.call(a, 'GET', '/v1/employees')).json() as { items: { id: string }[]; total: number };

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.create.personal', 'employee.read.personal'] });
  world = leaveTasks(h, A, hr);
  await world.activatePolicies();
});

afterAll(async () => {
  await h?.stop();
});

describe('a task routed through one assignment lends nothing to another', () => {
  it('stitching: the private record stays closed in a second assignment that holds the field grant but not the step permission', async () => {
    const managerEmp = await world.employee();
    const x = await world.employee(managerEmp, { dateOfBirth: '1991-07-14' });
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    // The second assignment of the same user: assigned scope, with the private field grant, and no leave decision duty.
    const stitch = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, scope: 'ASSIGNED', duties: READ_PERSONAL });
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: x }));
    expect((await leaveQueue(h, manager)).map((t) => t.ownerEmployeeId)).toEqual([x]);

    // By identifier, in the list and in its count, the employee reads exactly like one that does not exist.
    const refused = await detail(stitch, x);
    expect(refused.statusCode).toBe(404);
    expect(refused.body).not.toContain('1991-07-14');
    const listed = await list(stitch);
    expect(listed.items).toEqual([]);
    expect(listed.total).toBe(0);
  });
});

describe('a task the assignment itself is eligible for confers row scope, for as long as it is pending', () => {
  async function assignedReviewer(extra: { departmentFilter?: string } = {}) {
    const reviewer = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', duties: [...READ_PERSONAL, 'leave.read.operational', 'leave.approve.operational'], ...extra });
    const res = await h.call(hr, 'PUT', '/v1/workflows/leave_request/fallback-reviewers', { reviewers: [{ userId: reviewer.user, priority: 1 }] });
    expect(res.statusCode, res.body).toBe(200);
    return reviewer;
  }

  it('opens the task owner only, with the same assignment’s field grant; not other employees; not after the decision', async () => {
    const reviewer = await assignedReviewer();
    const x = await world.employee(undefined, { dateOfBirth: '1990-03-02' });
    const other = await world.employee(undefined, { dateOfBirth: '1990-03-03' });
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: x });
    // No task yet: nothing is in scope.
    expect((await detail(reviewer, x)).statusCode).toBe(404);

    await world.submitLeave(self);
    const open = await detail(reviewer, x);
    expect(open.statusCode, open.body).toBe(200);
    expect(open.json().dateOfBirth).toBe('1990-03-02');
    expect((await detail(reviewer, other)).statusCode).toBe(404);
    expect((await list(reviewer)).items.map((e) => e.id)).toEqual([x]);
    const [task] = await leaveQueue(h, reviewer);
    expect(task?.ownerEmployeeId).toBe(x);

    // The finished task confers nothing.
    const decided = await h.call(reviewer, 'POST', `/v1/leave/tasks/${task!.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('assigned-') });
    expect(decided.statusCode, decided.body).toBe(200);
    expect((await detail(reviewer, x)).statusCode).toBe(404);
    expect((await list(reviewer)).items).toEqual([]);
  });

  it('an expired or switched-off allowlist entry for the step permission ends the scope at once', async () => {
    const reviewer = await assignedReviewer();
    const x = await world.employee();
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: x }));
    expect((await detail(reviewer, x)).statusCode).toBe(200);
    const entry = `permission_id = (select id from permission where resource = 'leave' and action = 'approve' and field_group = 'operational')`;
    await h.db.query(`update role_assignment_permission set effective_to = now() + interval '1 hour' where role_assignment_id = $1 and ${entry}`, [reviewer.assignment]);
    expect((await detail(reviewer, x)).statusCode).toBe(200);
    await h.db.query(`update role_assignment_permission set effective_to = now() where role_assignment_id = $1 and ${entry}`, [reviewer.assignment]);
    expect((await detail(reviewer, x)).statusCode).toBe(404);
    await h.db.query(`update role_assignment_permission set effective_to = null, active = false where role_assignment_id = $1 and ${entry}`, [reviewer.assignment]);
    expect((await detail(reviewer, x)).statusCode).toBe(404);
  });

  it('the assignment’s filters still apply: a task owner who moves out of the department drops out of scope', async () => {
    const reviewer = await assignedReviewer({ departmentFilter: A.dept });
    const x = await world.employee();
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: x }));
    expect((await detail(reviewer, x)).statusCode).toBe(200);
    const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    const moved = await h.call(hr, 'POST', `/v1/employees/${x}/assignment`, { departmentId: A.financeDept, locationId: A.loc, designationId: A.desig, effectiveFrom: today });
    expect(moved.statusCode, moved.body).toBe(200);
    expect((await detail(reviewer, x)).statusCode).toBe(404);
  });
});

describe('every consumer of the assigned predicate is bound the same way', () => {
  it('a fallback-list notice reaches an ASSIGNED member only through a task that assignment is eligible for', async () => {
    const eligible = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', duties: ['employee.read.operational', 'leave.approve.operational'] });
    const bystander = await h.actor(A, 'REPORTING_MANAGER', { scope: 'ASSIGNED', duties: ['employee.read.operational'] });
    expect((await h.call(hr, 'PUT', '/v1/workflows/leave_request/fallback-reviewers', { reviewers: [{ userId: eligible.user, priority: 1 }] })).statusCode).toBe(200);
    const x = await world.employee();
    const users = [eligible.user, bystander.user];
    expect(await usersCoveringEmployee(h.pool, A.id, users, x)).toEqual([]);
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: x }));
    expect(await usersCoveringEmployee(h.pool, A.id, users, x)).toEqual([eligible.user]);
  });

  it('a requisition: only the assignment holding the step permission reaches the record', async () => {
    const reviewerEmp = await world.employee();
    const requesterEmp = await world.employee(reviewerEmp);
    const reviewer = await h.actor(A, 'REPORTING_MANAGER', { employeeId: reviewerEmp });
    const requester = await h.actor(A, 'REPORTING_MANAGER', { employeeId: requesterEmp });
    const stitch = await h.actor(A, 'REPORTING_MANAGER', { user: reviewer.user, scope: 'ASSIGNED', duties: ['requisition.read.operational'] });
    const assigned = await h.actor(A, 'REPORTING_MANAGER', { user: reviewer.user, scope: 'ASSIGNED', duties: ['requisition.read.operational', 'requisition.validate.operational'] });

    const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    const created = await h.call(requester, 'POST', '/v1/hiring/requisitions', {
      title: 'Synthetic platform engineer',
      departmentId: A.dept,
      locationId: A.loc,
      designationId: A.desig,
      employmentType: 'PERMANENT',
      vacancies: 1,
      reasonType: 'NEW',
      reason: 'Synthetic team growth',
      skills: ['TypeScript'],
      targetDate: new Date(Date.parse(`${today}T00:00:00Z`) + 30 * 86_400_000).toISOString().slice(0, 10),
      hiringManagerId: requesterEmp,
      budgetExceptionReason: 'Synthetic: no budget line yet',
    });
    expect(created.statusCode, created.body).toBe(201);
    const requisition = created.json() as { id: string; version: number };
    const submitted = await h.call(requester, 'POST', `/v1/hiring/requisitions/${requisition.id}/submit`, { expectedVersion: requisition.version });
    expect(submitted.statusCode, submitted.body).toBe(200);

    const grantOf = async (a: TestActor) =>
      (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'requisition', action: 'read', fieldGroups: ['operational'] })) as AccessGrant;
    expect(await canAccessRequisition(h.pool, await grantOf(assigned), requisition.id)).toBe(true);
    expect(await canAccessRequisition(h.pool, await grantOf(stitch), requisition.id)).toBe(false);
  });
});
