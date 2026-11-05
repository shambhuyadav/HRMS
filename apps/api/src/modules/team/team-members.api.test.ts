// My Team membership, member detail and export over HTTP (FR-094, FR-095, FR-098; BR-042; BR-044; DF02; DF16; ZT27; ZT29):
// membership follows the current direct reporting line whatever the assignment's scope kind; each tab is under its own grant
// and carries operational fields only; protected history is masked; the export holds what the list holds. Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { enrol, GOALS, openCycle, rate, selfAssess, type World, appraisalWorld } from '../appraisal/appraisal.fixtures.js';
import { METRICS } from '../dashboard/service.js';
import { attendance } from '../payroll/payroll.fixtures.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';
import { addDays, advance, businessDate, newPlan, nominated, act } from '../training/training.fixtures.js';
import { leaveQueue, leaveTasks } from '../workflow/leave-tasks.fixtures.js';
import { NO_SKILLS_SOURCE, PROTECTED_VALUE } from './detail.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let today: string;
let world: ReturnType<typeof leaveTasks>;

const TEAM_ONLY: PermissionKey[] = ['team.list.operational', 'team.read.operational', 'dashboard.read.operational'];

const person = (managerId?: string, overrides: Record<string, unknown> = {}) => world.employee(managerId, overrides);
const listIds = async (a: TestActor, query = '') => {
  const res = await h.call(a, 'GET', `/v1/my-team${query}`);
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json() as { items: { id: string }[]; total: number };
  return { ids: body.items.map((i) => i.id), total: body.total };
};
const detailOf = async (a: TestActor, id: string) => {
  const res = await h.call(a, 'GET', `/v1/my-team/${id}`);
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.body, tabs: res.json().tabs as Record<string, any> };
};
const linkUser = (user: string, employeeId: string) =>
  h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [A.id, user, employeeId]);
const metric = async (a: TestActor, code: string) => {
  const grant = await resolveAccess(h.db, { userId: a.user, companyId: a.company.id, assignmentId: a.assignment, resource: 'team', action: 'list', fieldGroups: ['operational'] });
  if (!grant.allowed) throw new Error(`Not allowed: ${grant.reason}`);
  return METRICS[code]!(h.db, grant);
};

/** Requests a report, runs the worker, and returns its state and, when it completed, its CSV. */
async function exported(a: TestActor, filters: Record<string, unknown> = {}) {
  const res = await h.call(a, 'POST', '/v1/reports', { reportCode: 'MY_TEAM', filters });
  expect(res.statusCode, res.body).toBe(202);
  const id = res.json().id as string;
  await processReportQueue(h.pool);
  const status = (await h.call(a, 'GET', `/v1/reports/${id}`)).json() as { state: string; rowCount: number | null; failureCode: string | null };
  const csv = status.state === 'COMPLETED' ? csvTable((await h.call(a, 'GET', `/v1/reports/${id}/download`)).body) : '';
  return { id, status, csv };
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', {
    extra: ['employee.create.personal', 'employee.update.personal', 'salary.manage.salary', 'salary.read.salary', 'increment.read.salary', 'increment.propose.salary', 'document.upload.document', 'document.read.document'],
  });
  world = leaveTasks(h, A, hr);
  await world.activatePolicies();
  today = await businessDate(h, A);
}, 120_000);

afterAll(async () => {
  await h?.stop();
});

describe('membership is the current direct reporting line, whatever the scope kind (FR-094, BR-042; additions-3)', () => {
  it('a company-scoped team role sees its direct reports only: list, total, detail, filter choices and team widgets', async () => {
    const managerEmp = await person();
    const report = await person(managerEmp);
    const stranger = await person(await person(), { departmentId: A.financeDept });
    const company = await h.customActor(A, { scope: 'COMPANY', permissions: TEAM_ONLY });
    await linkUser(company.user, managerEmp);

    expect(await listIds(company)).toEqual({ ids: [report], total: 1 });
    await detailOf(company, report);
    expect((await h.call(company, 'GET', `/v1/my-team/${stranger}`)).statusCode).toBe(404);
    // A choice of another team's department neither widens the list nor is offered.
    expect(await listIds(company, `?departmentId=${A.financeDept}`)).toEqual({ ids: [], total: 0 });
    const options = (await h.call(company, 'GET', '/v1/my-team/filter-options')).json();
    expect(options.departments.map((d: { id: string }) => d.id)).toEqual([A.dept]);

    expect(await metric(company, 'TEAM_COUNT')).toEqual({ status: 'OK', value: 1 });
    await attendance(h, A, stranger, today, 'EXCEPTION');
    expect(await metric(company, 'TEAM_ATTENDANCE_EXCEPTIONS')).toEqual({ status: 'OK', value: 0 });
    await attendance(h, A, report, today, 'EXCEPTION');
    expect(await metric(company, 'TEAM_ATTENDANCE_EXCEPTIONS')).toEqual({ status: 'OK', value: 1 });
    expect(await listIds(company, '?todayAttendance=EXCEPTION')).toEqual({ ids: [report], total: 1 });
  });

  it('an account with no linked employee has no team, in any scope', async () => {
    const unlinked = await h.customActor(A, { scope: 'COMPANY', permissions: TEAM_ONLY });
    const someone = await person();
    expect(await listIds(unlinked)).toEqual({ ids: [], total: 0 });
    expect((await h.call(unlinked, 'GET', `/v1/my-team/${someone}`)).statusCode).toBe(404);
    expect((await h.call(unlinked, 'GET', '/v1/my-team/filter-options')).json()).toEqual({ departments: [], locations: [] });
    expect(await metric(unlinked, 'TEAM_COUNT')).toEqual({ status: 'OK', value: 0 });
  });

  it('the assignment’s filters narrow the direct team on list, total, detail and dashboard', async () => {
    const managerEmp = await person();
    const inEng = await person(managerEmp);
    const inFin = await person(managerEmp, { departmentId: A.financeDept });
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const narrowed = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, departmentFilter: A.dept });
    expect((await listIds(manager)).total).toBe(2);
    expect(await listIds(narrowed)).toEqual({ ids: [inEng], total: 1 });
    expect((await h.call(narrowed, 'GET', `/v1/my-team/${inFin}`)).statusCode).toBe(404);
    const widget = ((await h.call(narrowed, 'GET', '/v1/dashboard')).json().widgets as { code: string; value: unknown }[]).find((w) => w.code === 'TEAM_COUNT');
    expect(widget?.value).toBe(1);
  });

  it('an assigned-scope manager sees a direct report with an open task, never someone else whose task they hold', async () => {
    const reviewerEmp = await person();
    const reviewer = await h.actor(A, 'REPORTING_MANAGER', { employeeId: reviewerEmp, scope: 'ASSIGNED', duties: [...TEAM_ONLY, 'leave.read.operational', 'leave.approve.operational'] });
    const listed = await h.call(hr, 'PUT', '/v1/workflows/leave_request/fallback-reviewers', { reviewers: [{ userId: reviewer.user, priority: 1 }] });
    expect(listed.statusCode, listed.body).toBe(200);
    const report = await person(reviewerEmp);
    const stranger = await person(); // no manager: routed to the fallback reviewer
    expect((await listIds(reviewer)).total).toBe(0);
    expect((await h.call(reviewer, 'GET', `/v1/my-team/${report}`)).statusCode).toBe(404);

    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: report }));
    await world.submitLeave(await h.actor(A, 'EMPLOYEE', { employeeId: stranger }));
    expect((await leaveQueue(h, reviewer)).map((t) => t.ownerEmployeeId).sort()).toEqual([report, stranger].sort());

    expect(await listIds(reviewer)).toEqual({ ids: [report], total: 1 });
    await detailOf(reviewer, report);
    expect((await h.call(reviewer, 'GET', `/v1/my-team/${stranger}`)).statusCode).toBe(404);
  });

  it('a manager change moves the member on the effective date, and the former manager reaches nothing', async () => {
    const before = await person();
    const after = await person();
    const member = await person(before);
    const first = await h.actor(A, 'REPORTING_MANAGER', { employeeId: before });
    const second = await h.actor(A, 'REPORTING_MANAGER', { employeeId: after });
    await world.setManager(member, after, addDays(today, -1));
    expect((await listIds(first)).total).toBe(0);
    expect((await h.call(first, 'GET', `/v1/my-team/${member}`)).statusCode).toBe(404);
    expect(await listIds(second)).toEqual({ ids: [member], total: 1 });
  });
});

describe('list columns and filters (DF16)', () => {
  let manager: TestActor;
  let managerEmp: string;
  let probation: string;
  let confirmed: string;

  beforeAll(async () => {
    managerEmp = await person(undefined, { displayName: 'Synthetic Team Lead' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp, extra: ['team.export.operational'] });
    probation = await person(undefined, { displayName: 'Synthetic Probationer', joiningDate: addDays(today, -70) });
    await world.setManager(probation, managerEmp, addDays(today, -70));
    await h.setStatus(A, probation, 'ACTIVE_PROBATION');
    confirmed = await person(managerEmp, { displayName: 'Synthetic Veteran', departmentId: A.financeDept });
    const opened = await h.call(hr, 'POST', '/v1/confirmations', { employeeId: probation });
    expect(opened.statusCode, opened.body).toBe(201);
    await attendance(h, A, confirmed, today, 'EXCEPTION');
  });

  it('shows the DF16 columns, manager and joining date included', async () => {
    const item = (await h.call(manager, 'GET', `/v1/my-team?search=Probationer`)).json().items[0];
    expect(item).toMatchObject({ displayName: 'Synthetic Probationer', manager: 'Synthetic Team Lead', department: 'ENG', location: 'HQ', designation: 'DEV', status: 'ACTIVE_PROBATION' });
    expect(item).toHaveProperty('joiningDate');
    expect(item).toHaveProperty('nextReviewDate');
    expect(item).toHaveProperty('todayAttendance');
  });

  it('every filter narrows the list and its export identically; pagination and totals match', async () => {
    const due = (await h.call(manager, 'GET', `/v1/my-team?search=Probationer`)).json().items[0].nextReviewDate as string;
    const dueDay = String(due).slice(0, 10);
    const cases: [Record<string, string>, string[]][] = [
      [{}, [probation, confirmed]],
      [{ search: 'Veteran' }, [confirmed]],
      [{ departmentId: A.financeDept }, [confirmed]],
      [{ locationId: A.loc }, [probation, confirmed]],
      [{ status: 'ACTIVE_PROBATION' }, [probation]],
      [{ reviewDueFrom: dueDay, reviewDueTo: dueDay }, [probation]],
      [{ reviewDueFrom: addDays(dueDay, 1) }, []],
      [{ reviewDueTo: addDays(dueDay, -1) }, []],
      [{ todayAttendance: 'EXCEPTION' }, [confirmed]],
      [{ confirmationDueTo: dueDay }, [probation]],
      [{ confirmationDueTo: addDays(dueDay, -1) }, []],
    ];
    for (const [filters, expected] of cases) {
      const listed = await listIds(manager, `?${new URLSearchParams(filters).toString()}`);
      expect(listed.ids.sort(), JSON.stringify(filters)).toEqual([...expected].sort());
      expect(listed.total, JSON.stringify(filters)).toBe(expected.length);
      const { status } = await exported(manager, filters);
      expect(status, JSON.stringify(filters)).toMatchObject({ state: 'COMPLETED', rowCount: expected.length });
    }
    const page2 = (await h.call(manager, 'GET', '/v1/my-team?page=2&pageSize=25')).json();
    expect(page2).toMatchObject({ items: [], total: 2, page: 2, pageSize: 25 });
    expect((await h.call(manager, 'GET', '/v1/my-team?pageSize=10')).statusCode).toBe(400);
  });

  it('the widget of team confirmations due reconciles with the list under its filter', async () => {
    const dashboard = (await h.call(manager, 'GET', '/v1/dashboard')).json();
    const widget = (dashboard.widgets as { code: string; value: number; source?: { lists: { api: string }[] } }[]).find((w) => w.code === 'TEAM_REVIEWS')!;
    expect(widget.value).toBe(1);
    expect((await h.call(manager, 'GET', widget.source!.lists[0]!.api)).json().total).toBe(1);
  });

  it('the export keeps the list’s order for the same sort', async () => {
    for (const direction of ['ASC', 'DESC']) {
      const shown = (await h.call(manager, 'GET', `/v1/my-team?sort=displayName&direction=${direction}`)).json().items as { employeeCode: string }[];
      const { csv } = await exported(manager, { sort: 'displayName', direction });
      const codes = csv.trim().split('\r\n').slice(1).map((row) => row.split(',')[0]!.replace(/"/g, ''));
      expect(codes, direction).toEqual(shown.map((m) => m.employeeCode));
    }
    const sortedByDue = await exported(manager, { sort: 'nextReviewDate' });
    expect(sortedByDue.status).toMatchObject({ state: 'COMPLETED', rowCount: 2 });
  });
});

describe('Skills and Training (FR-095, DF02; additions-7, core-3)', () => {
  it('fills from training participation under its own grant, operational fields only, and says no skills record exists', async () => {
    const coordinator = await h.actor(A, 'TRAINING_COORDINATOR');
    const managerEmp = await person();
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const member = await person(managerEmp);
    const empty = await person(managerEmp);
    const plan = await newPlan(h, coordinator, { startDate: addDays(today, -3), endDate: addDays(today, -1), ownerEmployeeId: managerEmp, title: 'Synthetic ladder safety', costAmount: '4321.00', costCurrency: 'INR' });
    const [done] = await nominated(h, coordinator, plan.id, [member]);
    await advance(h, coordinator, plan.id, [done!], ['CONFIRM', 'MARK_ATTENDED', 'COMPLETE']);
    const other = await newPlan(h, coordinator, { startDate: addDays(today, 3), endDate: addDays(today, 4), ownerEmployeeId: managerEmp, title: 'Synthetic other course' });
    const [cancelled] = await nominated(h, coordinator, other.id, [member]);
    const res = await act(h, coordinator, other.id, 'CANCEL', [cancelled!], 'Private participation reason (synthetic)');
    expect(res.statusCode, res.body).toBe(200);

    const { body, tabs } = await detailOf(manager, member);
    expect(tabs.skillsAndTraining.sections.skills).toEqual({ available: false, message: NO_SKILLS_SOURCE });
    const items = tabs.skillsAndTraining.sections.training.items as Record<string, unknown>[];
    expect(items.map((i) => [i.planTitle, i.state])).toEqual([
      ['Synthetic other course', 'CANCELLED'],
      ['Synthetic ladder safety', 'COMPLETED'],
    ]);
    expect(Object.keys(items[0]!).sort()).toEqual(['completedAt', 'endDate', 'planCode', 'planTitle', 'startDate', 'state']);
    expect(body).not.toContain('Private participation reason');
    expect(body).not.toContain('4321');

    // Nothing recorded is an empty list, distinct from the category with no source and from a denied tab.
    const none = await detailOf(manager, empty);
    expect(none.tabs.skillsAndTraining.sections.training).toEqual({ available: true, items: [] });

    const denied = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, duties: TEAM_ONLY });
    expect((await detailOf(denied, member)).tabs).not.toHaveProperty('skillsAndTraining');
  });
});

describe('Goals and Tasks (FR-095, DF02; additions-7, core-3)', () => {
  let w: World;
  beforeAll(async () => {
    w = await appraisalWorld(h, A);
  });

  it('fills from appraisal goals under its own grant: names, weights and completion flags, never targets, scores or comments, even with the rating grant', async () => {
    const cycle = await openCycle(h, w);
    const member = await person(w.managerEmp);
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: member });
    const view = await enrol(h, w.hr, cycle.id, member);
    await selfAssess(h, self, view.id, GOALS.map(() => 4), 'Private self comment (synthetic)');
    await rate(h, w.manager, view.id, GOALS.map(() => 3), 'Private manager comment (synthetic)');

    const { body, tabs } = await detailOf(w.manager, member);
    const item = tabs.goalsAndTasks.sections.goals.items[0];
    expect(item).toMatchObject({ cycleCode: cycle.code, taskStatus: 'AWAITING_REVIEW' });
    expect(item.goals).toHaveLength(GOALS.length);
    expect(item.goals[0]).toEqual({ sequence: 1, name: GOALS[0]!.description, weight: GOALS[0]!.weight, selfEntryComplete: true, managerRatingComplete: true });
    expect(body).not.toContain('Private self comment');
    expect(body).not.toContain('Private manager comment');
    expect(body).not.toContain('weightedResult');
    if (GOALS[0]!.target) expect(body).not.toContain(GOALS[0]!.target);

    const empty = await person(w.managerEmp);
    expect((await detailOf(w.manager, empty)).tabs.goalsAndTasks.sections.goals).toEqual({ available: true, items: [] });
    const denied = await h.actor(A, 'REPORTING_MANAGER', { user: w.manager.user, duties: TEAM_ONLY });
    expect((await detailOf(denied, member)).tabs).not.toHaveProperty('goalsAndTasks');
  });
});

describe('Employment and Reporting, and History (DF16 "history masks protected before/after data")', () => {
  it('a manager’s default duty; a name change shows both values, a birth date change neither, whatever the manager holds', async () => {
    const managerEmp = await person(undefined, { displayName: 'Synthetic History Lead' });
    const member = await person(managerEmp, { displayName: 'Synthetic Before Name', dateOfBirth: '1980-05-06' });
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const version = (await h.call(hr, 'GET', `/v1/employees/${member}`)).json().version as number;
    const patched = await h.call(hr, 'PATCH', `/v1/employees/${member}`, { expectedVersion: version, displayName: 'Synthetic After Name', dateOfBirth: '1981-07-08' });
    expect(patched.statusCode, patched.body).toBeLessThan(300);
    await h.setStatus(A, member, 'NOTICE');

    const withPersonal = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['employee.read.personal'] });
    for (const a of [manager, withPersonal]) {
      const { tabs } = await detailOf(a, member);
      const history = tabs.history.items as { action: string; changes: { field: string; before: unknown; after: unknown; masked: boolean }[] }[];
      const changes = history.flatMap((r) => r.changes);
      expect(changes).toContainEqual({ field: 'displayName', before: 'Synthetic Before Name', after: 'Synthetic After Name', masked: false });
      expect(changes).toContainEqual({ field: 'dateOfBirth', before: PROTECTED_VALUE, after: PROTECTED_VALUE, masked: true });
      expect(changes).toContainEqual({ field: 'status', before: 'ACTIVE_CONFIRMED', after: 'NOTICE', masked: false });
      expect(JSON.stringify(tabs.history)).not.toContain('1980-05-06');
      expect(JSON.stringify(tabs.history)).not.toContain('1981-07-08');
      expect(tabs.employmentAndReporting.items).toContainEqual(expect.objectContaining({ kind: 'MANAGER', detail: 'Synthetic History Lead' }));
    }
    // The birth date itself stays under its own grant and tab.
    expect((await detailOf(manager, member)).tabs).not.toHaveProperty('privateInformation');
    expect((await detailOf(withPersonal, member)).tabs.privateInformation.sections.personal.items[0].dateOfBirth).toBeTruthy();
  });

  it('a stated free-text reason in the audit values is masked, and a record reference is not listed', async () => {
    const managerEmp = await person();
    const member = await person(managerEmp);
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    await h.db.query(
      `insert into audit_event (company_id, resource_code, record_key, actor_user_id, action, before_values, after_values)
       values ($1, 'employee', $2, $3, 'ACTIVATE', $4, $5)`,
      [A.id, member, hr.user, { operational: { status: 'DRAFT' } }, { operational: { status: 'ACTIVE_PROBATION', noManagerReason: 'Private reason (synthetic)', exitCaseId: 'x' } }],
    );
    const { body, tabs } = await detailOf(manager, member);
    expect(body).not.toContain('Private reason');
    const changes = (tabs.history.items as { changes: { field: string; masked: boolean }[] }[]).flatMap((r) => r.changes);
    expect(changes).toContainEqual({ field: 'noManagerReason', before: PROTECTED_VALUE, after: PROTECTED_VALUE, masked: true });
    expect(changes.map((c) => c.field)).not.toContain('exitCaseId');
  });

  it('both tabs need the history grant, and the grant is a Reporting Manager default', async () => {
    const managerEmp = await person();
    const member = await person(managerEmp);
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    expect(Object.keys((await detailOf(manager, member)).tabs)).toEqual(expect.arrayContaining(['employmentAndReporting', 'history']));
    const denied = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, duties: TEAM_ONLY });
    const { tabs } = await detailOf(denied, member);
    expect(tabs).not.toHaveProperty('employmentAndReporting');
    expect(tabs).not.toHaveProperty('history');
    // The grant opens these tabs and no other route: the employee history route stays HR's.
    expect((await h.call(manager, 'GET', `/v1/employees/${member}/history`)).statusCode).toBe(403);
  });
});

describe('Compensation and Increment History (FR-095, BR-044, DF02, DF16)', () => {
  let managerEmp: string;
  let manager: TestActor;
  let member: string;
  let stranger: string;

  beforeAll(async () => {
    managerEmp = await person();
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    member = await person(managerEmp);
    stranger = await person();
    for (const e of [member, stranger]) {
      const res = await h.call(hr, 'POST', `/v1/employees/${e}/salary`, { effectiveFrom: '2026-01-05', monthlyGross: '98765', annualCtc: '1185180', currency: 'INR' });
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  it('a manager with team access and no grant obtains no salary, from the detail or the salary route', async () => {
    const { body, tabs } = await detailOf(manager, member);
    expect(tabs).not.toHaveProperty('compensation');
    expect(body).not.toContain('98765');
    expect((await h.call(manager, 'GET', `/v1/employees/${member}/salary`)).statusCode).toBe(403);
  });

  it('a salary grant, which the role’s ceiling allows, exposes it for that manager’s members only', async () => {
    const granted = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['salary.read.salary'] });
    const { tabs } = await detailOf(granted, member);
    expect(Object.keys(tabs.compensation.sections)).toEqual(['salaryArrangements']);
    expect(tabs.compensation.sections.salaryArrangements.items[0]).toMatchObject({ monthlyGross: expect.stringContaining('98765'), currency: 'INR' });
    expect((await h.call(granted, 'GET', `/v1/my-team/${stranger}`)).statusCode).toBe(404);
    expect((await h.call(granted, 'GET', `/v1/employees/${stranger}/salary`)).statusCode).toBe(404);
  });

  it('increment history stands under its history grant alone, and its rows are this member’s', async () => {
    // C4: the plain read grant no longer opens it.
    const plainRead = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['increment.read.salary'] });
    expect((await detailOf(plainRead, member)).tabs).not.toHaveProperty('compensation');
    const granted = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['increment.history_read.salary'] });
    const { tabs } = await detailOf(granted, member);
    expect(Object.keys(tabs.compensation.sections)).toEqual(['incrementHistory']);
    expect(tabs.compensation.sections.incrementHistory).toEqual({ available: true, items: [] });
    expect(JSON.stringify(tabs.compensation)).not.toContain('98765');

    // An applied increment appears with its amounts for this member; the approver's reason needs its own grant.
    const approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['increment.read.salary', 'increment.approve.salary', 'salary.read.salary'] });
    expect((await h.call(hr, 'PUT', '/v1/workflows/increment_case/fallback-reviewers', { reviewers: [{ userId: approver.user, priority: 1 }] })).statusCode).toBe(200);
    const proposed = await h.call(hr, 'POST', '/v1/increment-cases/off-cycle', { employeeId: member, effectiveDate: today, proposedAmount: '111111', proposedCounterpart: '1333332', reason: 'Off-cycle adjustment (synthetic)' });
    expect(proposed.statusCode, proposed.body).toBeLessThan(300);
    const task = ((await h.call(approver, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === member)!;
    const decided = await h.call(approver, 'POST', `/v1/increment-cases/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'Private approver reason (synthetic)', idempotencyKey: uniq('inc-key-') });
    expect(decided.statusCode, decided.body).toBe(200);
    const { body, tabs: after } = await detailOf(granted, member);
    expect(after.compensation.sections.incrementHistory.items).toEqual([expect.objectContaining({ afterAmount: expect.stringContaining('111111'), currency: 'INR' })]);
    expect(body).not.toContain('Private approver reason');
  });

  it('a grant in a role that is not eligible opens nothing; the ceiling of the baseline role is checked at the database', async () => {
    const ineligible = await h.customActor(A, { scope: 'COMPANY', permissions: [...TEAM_ONLY, 'salary.read.salary', 'increment.read.salary', 'document.read.document', 'employee.read.personal'] });
    const lead = await person();
    await linkUser(ineligible.user, lead);
    const report = await person(lead);
    const { tabs } = await detailOf(ineligible, report);
    expect(tabs).not.toHaveProperty('compensation');
    expect(tabs).not.toHaveProperty('privateInformation');
    await expect(h.actor(A, 'FINANCE_REVIEWER', { extra: ['salary.read.salary'] })).rejects.toThrow(/not allowed by the parent role/);
  });
});

describe('Private Information and Documents (FR-095, FR-106, DF16)', () => {
  it('released documents only, under the document grant; each section under its own grant', async () => {
    const managerEmp = await person();
    const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const member = await person(managerEmp);
    const upload = async (fileName: string, marker: string) => {
      const res = await h.call(hr, 'POST', `/v1/employees/${member}/documents`, {
        documentType: 'GENERAL',
        fileName,
        contentBase64: Buffer.from(`%PDF-1.4\n% synthetic ${uniq('doc')} ${marker}\n%%EOF\n`, 'latin1').toString('base64'),
      });
      expect(res.statusCode, res.body).toBe(201);
    };
    await upload('released.pdf', '');
    await upload('held-back.pdf', EICAR_TEST_STRING); // the scan quarantines it

    expect((await detailOf(manager, member)).tabs).not.toHaveProperty('privateInformation');

    const withDocuments = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['document.read.document'] });
    const { body, tabs } = await detailOf(withDocuments, member);
    expect(Object.keys(tabs.privateInformation.sections)).toEqual(['documents']);
    expect(tabs.privateInformation.sections.documents.items.map((d: { fileName: string }) => d.fileName)).toEqual(['released.pdf']);
    expect(body).not.toContain('held-back.pdf');
    expect(body).not.toContain('verificationNote');

    const withPersonal = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['employee.read.personal'] });
    expect(Object.keys((await detailOf(withPersonal, member)).tabs.privateInformation.sections)).toEqual(['personal']);
  });
});

describe('My Team export (DF16; ZT27; FR-098)', () => {
  let managerEmp: string;
  let manager: TestActor;
  let exporter: TestActor;
  let member: string;
  let leaver: string;

  beforeAll(async () => {
    managerEmp = await person();
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    exporter = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['team.export.operational', 'employee.read.personal', 'salary.read.salary'] });
    member = await person(managerEmp, { displayName: 'Synthetic Export Member', dateOfBirth: '1979-02-03' });
    leaver = await person(managerEmp, { displayName: 'Synthetic Export Leaver' });
    await h.call(hr, 'POST', `/v1/employees/${member}/salary`, { effectiveFrom: '2026-01-05', monthlyGross: '87654', annualCtc: '1051848', currency: 'INR' });
    await person(await person(), { displayName: 'Synthetic Export Stranger' });
  });

  it('is its own permission, off by default: a manager’s refusal is recorded without a payload', async () => {
    const res = await h.call(manager, 'POST', '/v1/reports', { reportCode: 'MY_TEAM', filters: {} });
    expect(res.statusCode).toBe(403);
    const denied = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and action = 'ACCESS_DENIED' and resource_code = 'team' and actor_user_id = $2`, [A.id, manager.user]);
    expect(denied.n).toBeGreaterThan(0);
    const hrRes = await h.call(hr, 'POST', '/v1/reports', { reportCode: 'MY_TEAM', filters: {} });
    expect(hrRes.statusCode).toBe(403);
  });

  it('holds the list’s rows in plain columns, operational only, whatever else the assignment holds; audited; labelled operational', async () => {
    const { id, status, csv } = await exported(exporter);
    expect(status).toMatchObject({ state: 'COMPLETED', rowCount: 2 });
    const [header, ...rows] = csv.trim().split('\r\n');
    expect(header).toBe('"Employee code","Name","Department","Designation","Location","Manager","Joining date","Status","Attendance today","Next review date"');
    expect(rows).toHaveLength(2);
    expect(csv).toContain('Synthetic Export Member');
    expect(csv).not.toContain('Synthetic Export Stranger');
    expect(csv).not.toContain('1979-02-03');
    expect(csv).not.toContain('87654');
    const audit = await h.one<{ action: string; after_values: { operational: { reportCode: string } } }>(`select action, after_values from audit_event where resource_code = 'report_execution' and record_key = $1`, [id]);
    expect(audit).toMatchObject({ action: 'REQUEST', after_values: { operational: { reportCode: 'MY_TEAM' } } });
    const file = await h.one<{ classification: string }>(`select a.classification from report_execution r join attachment a on a.company_id = r.company_id and a.id = r.output_attachment_id where r.id = $1`, [id]);
    expect(file.classification).toBe('OPERATIONAL');
  });

  it('a company-scoped holder still exports only direct reports', async () => {
    const lead = await person();
    const company = await h.customActor(A, { scope: 'COMPANY', permissions: [...TEAM_ONLY, 'team.export.operational'] });
    await linkUser(company.user, lead);
    const report = await person(lead, { displayName: 'Synthetic Only Report' });
    const { status, csv } = await exported(company);
    expect(status).toMatchObject({ state: 'COMPLETED', rowCount: 1 });
    expect(csv).toContain('Synthetic Only Report');
    expect(csv).not.toContain('Synthetic Export Member');
    expect(report).toBeTruthy();
  });

  it('membership is read when the file is generated, and a grant that ended stops generation and download', async () => {
    const res = await h.call(exporter, 'POST', '/v1/reports', { reportCode: 'MY_TEAM', filters: {} });
    expect(res.statusCode).toBe(202);
    await world.setManager(leaver, await person(), addDays(today, -1));
    await processReportQueue(h.pool);
    const download = await h.call(exporter, 'GET', `/v1/reports/${res.json().id}/download`);
    expect(download.statusCode).toBe(200);
    expect(download.body).not.toContain('Synthetic Export Leaver');

    const revoke = () =>
      h.db.query(
        `update role_assignment_permission set active = false
          where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'team' and action = 'export' and field_group = 'operational')`,
        [exporter.assignment],
      );
    const ready = await exported(exporter);
    const queued = await h.call(exporter, 'POST', '/v1/reports', { reportCode: 'MY_TEAM', filters: {} });
    await revoke();
    await processReportQueue(h.pool);
    expect((await h.call(exporter, 'GET', `/v1/reports/${queued.json().id}`)).statusCode).toBe(403);
    expect(await h.one(`select state, failure_code from report_execution where id = $1`, [queued.json().id])).toEqual({ state: 'FAILED', failure_code: 'ACCESS_REVOKED' });
    expect((await h.call(exporter, 'GET', `/v1/reports/${ready.id}/download`)).statusCode).toBe(403);
  });

  it('refuses a filter or sort it does not apply, and other reports refuse its filters and sorts', async () => {
    const granted = await h.actor(A, 'REPORTING_MANAGER', { user: manager.user, extra: ['team.export.operational'] });
    const ask = async (a: TestActor, reportCode: string, filters: Record<string, unknown>) => (await h.call(a, 'POST', '/v1/reports', { reportCode, filters })).json().error;
    expect(await ask(granted, 'MY_TEAM', { status: 'ARCHIVED' })).toBe('INVALID_FILTER');
    expect(await ask(granted, 'MY_TEAM', { joinedFrom: '2026-01-01' })).toBe('FILTER_NOT_SUPPORTED');
    expect(await ask(granted, 'MY_TEAM', { employeeId: member })).toBe('FILTER_NOT_SUPPORTED');
    expect(await ask(hr, 'EMPLOYEE_REGISTER', { sort: 'nextReviewDate' })).toBe('FILTER_NOT_SUPPORTED');
    expect(await ask(hr, 'EMPLOYEE_REGISTER', { todayAttendance: 'EXCEPTION' })).toBe('FILTER_NOT_SUPPORTED');
  });
});
