// Changing several people's manager at once (coverage CL-020 "Upload reporting managers", under FR-003 and FR-009; manager-bulk.ts):
// all or nothing through the ordinary manager change; people already reporting to that manager are left alone; open approvals move
// only when asked (C4: never by themselves), only for the routing administrator (workflow.reroute_task), only once the change is in
// effect, and only those the old assignee can no longer decide. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { BASELINE_ROLES, type PermissionKey } from '../access/baseline.js';
import { leaveQueue, leaveTasks } from '../workflow/leave-tasks.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hrNoReroute: TestActor;
let world: ReturnType<typeof leaveTasks>;
let m1Emp: string;
let m2Emp: string;
let m1: TestActor;
let m2: TestActor;
let today: string;

const REROUTE: PermissionKey = 'workflow.reroute_task.operational';

const bulk = (a: TestActor, body: Record<string, unknown>) => h.call(a, 'POST', '/v1/employees/manager-changes', body);
const managerOn = async (employeeId: string, day: string) =>
  (
    await h.db.query<{ m: string }>(
      `select manager_employee_id as m from manager_assignment where company_id = $1 and employee_id = $2 and effective_from <= $3::date and (effective_to is null or effective_to > $3::date)`,
      [A.id, employeeId, day],
    )
  ).rows[0]?.m ?? null;
const taskState = async (taskId: string) => (await h.one<{ state: string }>(`select state from approval_task where company_id = $1 and id = $2`, [A.id, taskId])).state;

/** An employee reporting to `manager`, with an open leave request in that manager's queue. */
async function withOpenRequest(manager: string, managerActor: TestActor) {
  const x = await world.employee(manager);
  const self = await h.actor(A, 'EMPLOYEE', { employeeId: x });
  await world.submitLeave(self);
  const task = (await leaveQueue(h, managerActor)).find((t) => t.ownerEmployeeId === x)!;
  expect(task).toBeDefined();
  return { x, taskId: task.taskId };
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hrNoReroute = await h.actor(A, 'HR_ADMINISTRATOR', { duties: BASELINE_ROLES.find((r) => r.code === 'HR_ADMINISTRATOR')!.defaultDuties.filter((k) => k !== REROUTE) });
  world = leaveTasks(h, A, hr);
  await world.activatePolicies();
  m1Emp = await world.employee();
  m2Emp = await world.employee();
  m1 = await h.actor(A, 'REPORTING_MANAGER', { employeeId: m1Emp });
  m2 = await h.actor(A, 'REPORTING_MANAGER', { employeeId: m2Emp });
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  const res = await h.call(hr, 'PUT', '/v1/workflows/leave_request/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] });
  expect(res.statusCode, res.body).toBe(200);
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('several people to one new manager (CL-020; FR-003, FR-009)', () => {
  it('FR-003 changes everyone listed, leaves those already reporting to that manager, and moves open approvals only when asked', async () => {
    const a = await withOpenRequest(m1Emp, m1);
    const b = await world.employee(m1Emp);
    const already = await world.employee(m2Emp);
    const res = await bulk(hr, { employeeIds: [a.x, b, already], managerEmployeeId: m2Emp, effectiveFrom: today, reason: 'Team restructure (synthetic)', moveOpenApprovals: true });
    expect(res.statusCode, res.body).toBe(200);
    const out = res.json() as { changed: string[]; unchanged: string[]; moved: { taskId: string; supersededTaskId: string; ownerEmployeeId: string }[]; left: number };
    expect(out.changed.sort()).toEqual([a.x, b].sort());
    expect(out.unchanged).toEqual([already]);
    expect(await managerOn(a.x, today)).toBe(m2Emp);
    expect(await managerOn(b, today)).toBe(m2Emp);
    // The old task is kept as history; the new one is in the new manager's queue (C4 reroute with history).
    expect(out.moved).toHaveLength(1);
    expect(out.moved[0]!.supersededTaskId).toBe(a.taskId);
    expect(await taskState(a.taskId)).toBe('SUPERSEDED');
    expect((await leaveQueue(h, m2)).some((t) => t.taskId === out.moved[0]!.taskId)).toBe(true);
    // Each change is audited with the reason, and the move as a reroute.
    const audits = await h.db.query<{ resource: string; reason: string }>(
      `select resource_code as resource, reason from audit_event
        where company_id = $1 and record_key = any($2::uuid[]) and resource_code in ('manager_assignment', 'approval_task')`,
      [A.id, [a.x, b, a.taskId]],
    );
    expect(audits.rows.filter((r) => r.resource === 'manager_assignment' && r.reason === 'Team restructure (synthetic)')).toHaveLength(2);
    expect(audits.rows.filter((r) => r.resource === 'approval_task')).toHaveLength(1);
  });

  it('C4 without being asked, open approvals stay where they are', async () => {
    const a = await withOpenRequest(m1Emp, m1);
    const res = await bulk(hr, { employeeIds: [a.x], managerEmployeeId: m2Emp, effectiveFrom: today, reason: 'Synthetic move' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().moved).toEqual([]);
    expect(await managerOn(a.x, today)).toBe(m2Emp);
    expect(await taskState(a.taskId)).toBe('PENDING');
  });

  it('an approval its assignee can still decide stays, and the rest of the change is kept', async () => {
    // No manager: the request goes to the fallback reviewer (HR), who can still decide it after the change.
    const x = await world.employee();
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: x });
    await world.submitLeave(self);
    const task = (await h.one<{ id: string }>(
      `select t.id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
         join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
        where t.company_id = $1 and bt.owner_employee_id = $2 and t.state = 'PENDING'`,
      [A.id, x],
    )).id;
    const res = await bulk(hr, { employeeIds: [x], managerEmployeeId: m2Emp, effectiveFrom: today, reason: 'Synthetic first manager', moveOpenApprovals: true });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ changed: [x], moved: [], left: 1 });
    expect(await taskState(task)).toBe('PENDING');
    expect(await managerOn(x, today)).toBe(m2Emp);
  });

  it('moving approvals needs the routing duty and a change already in effect; refused, nothing changes', async () => {
    const a = await withOpenRequest(m1Emp, m1);
    const denied = await bulk(hrNoReroute, { employeeIds: [a.x], managerEmployeeId: m2Emp, effectiveFrom: today, reason: 'Synthetic', moveOpenApprovals: true });
    expect(denied.statusCode).toBe(403);
    const future = await bulk(hr, { employeeIds: [a.x], managerEmployeeId: m2Emp, effectiveFrom: '2099-01-01', reason: 'Synthetic', moveOpenApprovals: true });
    expect(future.statusCode).toBe(422);
    expect(await managerOn(a.x, today)).toBe(m1Emp);
    expect(await managerOn(a.x, '2099-01-01')).toBe(m1Emp);
    expect(await taskState(a.taskId)).toBe('PENDING');
    // The same HR without the duty may still change the manager itself.
    const plain = await bulk(hrNoReroute, { employeeIds: [a.x], managerEmployeeId: m2Emp, effectiveFrom: '2099-01-01', reason: 'Synthetic later move' });
    expect(plain.statusCode, plain.body).toBe(200);
    expect(await managerOn(a.x, today)).toBe(m1Emp);
    expect(await managerOn(a.x, '2099-01-01')).toBe(m2Emp);
  });

  it('FR-009 is all or nothing: one refused person leaves everyone as they were', async () => {
    const x = await world.employee(m1Emp);
    const res = await bulk(hr, { employeeIds: [x, m2Emp], managerEmployeeId: m2Emp, effectiveFrom: today, reason: 'Synthetic' });
    expect(res.statusCode).toBe(422);
    expect(await managerOn(x, today)).toBe(m1Emp);
    const twice = await bulk(hr, { employeeIds: [x, x], managerEmployeeId: m2Emp, effectiveFrom: today, reason: 'Synthetic' });
    expect(twice.statusCode).toBe(422);
    const blank = await bulk(hr, { employeeIds: [x], managerEmployeeId: m2Emp, effectiveFrom: today, reason: '   ' });
    expect(blank.statusCode).toBe(422);
    expect(await managerOn(x, today)).toBe(m1Emp);
  });

  it('BR-026 a caller with a narrower scope learns nothing about people outside it: out of scope reads as not found, before any check', async () => {
    const x = await world.employee(m2Emp); // already reports to m2: the answer would have been "unchanged"
    const otherDept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'MB_ELSEWHERE', 'Elsewhere', true) returning id`, [A.id])).id;
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: otherDept });
    const res = await bulk(narrow, { employeeIds: [x], managerEmployeeId: m2Emp, effectiveFrom: today, reason: 'Synthetic probe' });
    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('unchanged');
  });

  it('BR-026 a manager cannot move people between managers', async () => {
    const x = await world.employee(m1Emp);
    const res = await bulk(m1, { employeeIds: [x], managerEmployeeId: m2Emp, effectiveFrom: today, reason: 'Synthetic' });
    expect(res.statusCode).toBe(403);
    expect(await managerOn(x, today)).toBe(m1Emp);
  });
});
