// My Team and role dashboards over HTTP (FR-094-FR-098; BR-042; BR-044; BR-045; DF16; DF17; F2; ZT27; ZT28; ZT29).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let manager: TestActor;
let managerEmp: string;
const team: string[] = [];
let former: string;
let unrelated: string;
let separated: string;
let memberSelf: TestActor;

async function employee(c: Company, status: string, managerId?: string, actor = hr): Promise<string> {
  const e = (await h.call(actor, 'POST', '/v1/employees', h.newEmployeeBody(c))).json();
  await h.setStatus(c, e.id, status);
  if (managerId) await h.call(actor, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
  return e.id;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  managerEmp = await employee(A, 'ACTIVE_CONFIRMED');
  const otherManager = await employee(A, 'ACTIVE_CONFIRMED');
  team.push(await employee(A, 'ACTIVE_CONFIRMED', managerEmp), await employee(A, 'ACTIVE_PROBATION', managerEmp), await employee(A, 'NOTICE', managerEmp));
  separated = await employee(A, 'INACTIVE_SEPARATED', managerEmp);
  former = await employee(A, 'ACTIVE_CONFIRMED', managerEmp);
  await h.call(hr, 'POST', `/v1/employees/${former}/manager`, { managerEmployeeId: otherManager, effectiveFrom: '2026-03-01' }); // reassigned away
  unrelated = await employee(A, 'ACTIVE_CONFIRMED', otherManager);
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  memberSelf = await h.actor(A, 'EMPLOYEE', { employeeId: team[0]! }); // one user per employee link
});

afterAll(async () => {
  await h?.stop();
});

describe('My Team (FR-094, FR-095, BR-042, ZT27)', () => {
  it('lists only current direct reports in active employment; totals match', async () => {
    const res = (await h.call(manager, 'GET', '/v1/my-team')).json();
    expect(res.items.map((i: { id: string }) => i.id).sort()).toEqual([...team].sort());
    expect(res.total).toBe(3);
    const page2 = (await h.call(manager, 'GET', '/v1/my-team?page=2&pageSize=25')).json();
    expect(page2).toMatchObject({ items: [], total: 3 });
    expect((await h.call(manager, 'GET', '/v1/my-team?status=NOTICE')).json().total).toBe(1);
  });

  it('former, unrelated, separated and other-company members are not reachable by id', async () => {
    for (const id of [former, unrelated, separated]) {
      expect((await h.call(manager, 'GET', `/v1/my-team/${id}`)).statusCode).toBe(404);
    }
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const other = await employee(B, 'ACTIVE_CONFIRMED', undefined, hrB);
    expect((await h.call(manager, 'GET', `/v1/my-team/${other}`)).statusCode).toBe(404);
  });

  it('member detail shows permitted tabs, empty tabs as empty, and omits confidential tabs without a grant', async () => {
    const detail = (await h.call(manager, 'GET', `/v1/my-team/${team[0]}`)).json();
    expect(Object.keys(detail.tabs).sort()).toEqual(['attendance', 'employmentAndReporting', 'goalsAndTasks', 'history', 'leave', 'skillsAndTraining', 'workProfile']);
    expect(detail.tabs.skillsAndTraining.sections.training).toEqual({ available: true, items: [] });
    expect(detail.tabs.goalsAndTasks.sections.goals).toEqual({ available: true, items: [] });
    expect(detail.tabs).not.toHaveProperty('compensation');
    expect(detail.tabs).not.toHaveProperty('privateInformation');

    const granted = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['employee.read.personal', 'increment.history_read.salary'] });
    const withGrants = (await h.call(granted, 'GET', `/v1/my-team/${team[0]}`)).json();
    expect(withGrants.tabs).toHaveProperty('privateInformation');
    // Increment history under its own grant; salary arrangements need salary.read, which was not granted.
    expect(Object.keys(withGrants.tabs.compensation.sections)).toEqual(['incrementHistory']);
  });

  it('roles without team permission cannot use My Team', async () => {
    const self = memberSelf;
    expect((await h.call(self, 'GET', '/v1/my-team')).statusCode).toBe(403);
  });
});

describe('role dashboards (FR-096, FR-097, BR-045, ZT28)', () => {
  const widgets = async (a: TestActor) => {
    const d = (await h.call(a, 'GET', '/v1/dashboard')).json();
    return { d, byCode: Object.fromEntries((d.widgets as { code: string }[]).map((w) => [w.code, w])) as unknown as Record<string, { status: string; value?: unknown; message?: string }> };
  };

  it('labels the role and scope; manager team count reconciles with My Team', async () => {
    const { d, byCode } = await widgets(manager);
    expect(d).toMatchObject({ role: 'REPORTING_MANAGER', scope: 'TEAM', state: 'OK', title: 'My team' });
    expect(byCode.TEAM_COUNT).toMatchObject({ status: 'OK', value: 3 });
    expect((await h.call(manager, 'GET', '/v1/my-team')).json().total).toBe(3);
  });

  it('HR active-employee count reconciles with the employee list for the same status filter', async () => {
    const { byCode } = await widgets(hr);
    const active = await Promise.all(
      ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'].map(async (s) => (await h.call(hr, 'GET', `/v1/employees?status=${s}`)).json().total as number),
    );
    expect(byCode.ACTIVE_EMPLOYEES).toMatchObject({ status: 'OK', value: active.reduce((a, b) => a + b, 0) });
  });

  it('employee dashboard shows "Policy not active" instead of a zero balance; own training due comes from the training module', async () => {
    const self = memberSelf;
    const { d, byCode } = await widgets(self);
    expect(d.role).toBe('EMPLOYEE');
    expect(byCode.LEAVE_BALANCE).toEqual(expect.objectContaining({ status: 'NOT_CONFIGURED', message: 'Policy not active' }));
    expect(byCode.TODAY_ATTENDANCE).toMatchObject({ status: 'OK', value: 'NOT_PROCESSED' });
    // No session nominated, confirmed or awaiting feedback for this employee (training/metrics.ts counts them).
    expect(byCode.MY_TRAINING).toMatchObject({ status: 'OK', value: 0 });
  });

  it('a widget whose permission is not granted in the assignment is omitted, not zero', async () => {
    const narrowed = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user });
    await h.db.query(
      `update role_assignment_permission set active = false
        where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'team' and action = 'list' and field_group = 'operational')`,
      [narrowed.assignment],
    );
    const { byCode } = await widgets(narrowed);
    expect(byCode).not.toHaveProperty('TEAM_COUNT');
    expect(byCode).toHaveProperty('MY_TASKS');
  });

  it('every baseline role gets its own labelled dashboard (FR-096)', async () => {
    const roles = (await h.db.query<{ code: string }>(`select code from role where company_id = $1 order by code`, [A.id])).rows.map((r) => r.code);
    expect(roles).toHaveLength(14);
    for (const code of roles) {
      const a = await h.actor(A, code);
      const { d } = await widgets(a);
      expect(d).toMatchObject({ role: code, state: 'OK' });
      expect(d.widgets.length).toBeGreaterThan(0);
    }
  });
});
