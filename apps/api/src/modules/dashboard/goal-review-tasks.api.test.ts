// FR-041 KRA review in the task list and task counts (I-77 item 3; FR-096 "pending tasks"; DF17 priority task list; F2 "Assigned
// HR tasks"; BR-045; docs/03 perf-4). A goal set waiting for its review is a state on the appraisal, not a routed task, yet it blocks the
// employee's self-entry: GET /v1/dashboard/tasks lists it, and the assignment's task count includes it, for exactly the people who may
// review it (the goal-setting duty in row scope, never the setter, never the employee). Synthetic people and goals only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { appraisalWorld, enrol, GOALS, openCycle, person, type View, type World } from '../appraisal/appraisal.fixtures.js';
import { isModuleActive } from '../registry.js';

type Item = { taskId: string | null; appraisalId?: string; kind: string; step: number | null; ownerEmployeeCode: string | null; ownerName: string | null; dueAt: string | null; overdue: boolean; delegated: boolean };
type Widget = { code: string; status: string; value?: number };

describe.runIf(isModuleActive('appraisal'))('goal (KRA) reviews in the pending-task list and counts (FR-041, FR-096, I-77 item 3)', () => {
  let h: Harness;
  let A: Company;
  let w: World;
  let cycle: { id: string };

  const tasksOf = async (a: TestActor) => {
    const res = await h.call(a, 'GET', '/v1/dashboard/tasks');
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: Item[]; total: number };
  };
  const reviewsOf = async (a: TestActor) => (await tasksOf(a)).items.filter((i) => i.kind === 'appraisal_goal_review');
  const widget = async (a: TestActor, code: string) => ((await h.call(a, 'GET', '/v1/dashboard')).json().widgets as Widget[]).find((x) => x.code === code);
  const codeOf = async (id: string) => (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [id])).c;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await appraisalWorld(h, A);
    // A new cycle reviews goals by default (I-77 item 3).
    cycle = await openCycle(h, w, { goalReviewRequired: true });
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('FR-041, FR-096: a complete goal set waiting for review is listed for the manager and other HR, never for its setter or the employee', async () => {
    const e = await person(h, A, w.hr, { managerId: w.managerEmp, name: 'Synthetic Goal Reviewee' });
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    // HR (default duties) sets the goals: the setter.
    const a = await enrol(h, w.hrPlain, cycle.id, e);
    expect(a.taskStatus).toBe('AWAITING_GOAL_REVIEW');
    const expected = { taskId: null, appraisalId: a.id, kind: 'appraisal_goal_review', step: null, ownerEmployeeCode: await codeOf(e), ownerName: 'Synthetic Goal Reviewee', dueAt: null, overdue: false, delegated: false };
    // The direct manager (team scope, goal-setting duty) and another HR Administrator may review it.
    expect(await reviewsOf(w.manager)).toEqual([expect.objectContaining(expected)]);
    expect(await reviewsOf(w.hr)).toEqual([expect.objectContaining(expected)]);
    // Never the person who set the goals, nor the employee.
    expect(await reviewsOf(w.hrPlain)).toEqual([]);
    expect(await reviewsOf(employee)).toEqual([]);
    // Nor the employee's own user in an HR assignment, nor an HR assignment whose row scope leaves the employee out.
    expect(await reviewsOf(await h.actor(A, 'HR_ADMINISTRATOR', { user: employee.user }))).toEqual([]);
    expect(await reviewsOf(await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept }))).toEqual([]);
    // Nor an assignment without the goal-setting duty.
    expect(await reviewsOf(await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['dashboard.read.operational', 'appraisal.read.operational'] }))).toEqual([]);

    // Every listed row can be acted on: the manager reviews the goals, and the row leaves every list.
    const review = await h.call(w.manager, 'POST', `/v1/appraisals/${a.id}/goal-review`, { expectedVersion: a.version });
    expect(review.statusCode, review.body).toBe(200);
    expect(await reviewsOf(w.manager)).toEqual([]);
    expect(await reviewsOf(w.hr)).toEqual([]);
  });

  it('FR-041: only a complete goal set with a known setter, in a cycle that requires the review, before submission, is listed', async () => {
    const before = (await reviewsOf(w.hr)).length;
    // Weights not yet totalling 100: still being set, nothing to review.
    const partial = await person(h, A, w.hr, { managerId: w.managerEmp, name: 'Synthetic Partial Goals' });
    const p = await enrol(h, w.hrPlain, cycle.id, partial, [{ sequence: 1, description: 'Synthetic half goal', weight: 50 }]);
    expect(p.taskStatus).toBe('AWAITING_GOALS');
    // A cycle without the review: the goals take effect when set.
    const plainCycle = await openCycle(h, w, { goalReviewRequired: false, offsetYears: 1 });
    const free = await person(h, A, w.hr, { managerId: w.managerEmp, name: 'Synthetic Unreviewed Cycle' });
    await enrol(h, w.hrPlain, plainCycle.id, free);
    // Goals entered before 0176 name no setter: they are set again first (GOALS_SETTER_UNKNOWN), so they are not a review yet.
    const legacy = await person(h, A, w.hr, { managerId: w.managerEmp, name: 'Synthetic Legacy Goals' });
    const l = await enrol(h, w.hrPlain, cycle.id, legacy);
    await h.db.query(`update appraisal set goals_set_by = null, goals_set_at = null where id = $1`, [l.id]);
    expect((await h.call(w.hr, 'POST', `/v1/appraisals/${l.id}/goal-review`, { expectedVersion: (await h.call(w.hr, 'GET', `/v1/appraisals/${l.id}`)).json().version })).json().error).toBe(
      'GOALS_SETTER_UNKNOWN',
    );
    expect((await reviewsOf(w.hr)).length).toBe(before);

    // A changed goal set is set by whoever changed it: it then waits for someone else, and its former setter may review it.
    const changed = await person(h, A, w.hr, { managerId: w.managerEmp, name: 'Synthetic Changed Goals' });
    const c = await enrol(h, w.hrPlain, cycle.id, changed);
    expect((await reviewsOf(w.manager)).map((r) => r.appraisalId)).toContain(c.id);
    expect((await reviewsOf(w.hrPlain)).map((r) => r.appraisalId)).not.toContain(c.id);
    const current = (await h.call(w.manager, 'GET', `/v1/appraisals/${c.id}`)).json() as View;
    const edited = await h.call(w.manager, 'PUT', `/v1/appraisals/${c.id}/goals`, {
      goals: GOALS.map((g) => (g.sequence === 1 ? { ...g, description: 'Synthetic delivery goal, revised' } : g)),
      expectedVersion: current.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await reviewsOf(w.manager)).map((r) => r.appraisalId)).not.toContain(c.id);
    expect((await reviewsOf(w.hrPlain)).map((r) => r.appraisalId)).toContain(c.id);
    expect((await reviewsOf(w.hr)).map((r) => r.appraisalId)).toContain(c.id);
  });

  it('F2, BR-045: the HR "Assigned HR tasks" count includes the goal reviews and equals the task list; the manager’s pending tasks show them', async () => {
    const e = await person(h, A, w.hr, { managerId: w.managerEmp, name: 'Synthetic Counted Reviewee' });
    const hrCounter = await h.actor(A, 'HR_ADMINISTRATOR');
    const beforeList = await tasksOf(hrCounter);
    const beforeWidget = await widget(hrCounter, 'MY_TASKS');
    expect(beforeWidget).toMatchObject({ status: 'OK', value: beforeList.total });
    const managerBefore = (await tasksOf(w.manager)).total;
    const a = await enrol(h, w.hrPlain, cycle.id, e);
    const afterList = await tasksOf(hrCounter);
    expect(afterList.total).toBe(beforeList.total + 1);
    expect(afterList.items.map((i) => i.appraisalId)).toContain(a.id);
    expect(await widget(hrCounter, 'MY_TASKS')).toMatchObject({ status: 'OK', value: afterList.total });
    // The manager's priority task list and its total (the home "Pending tasks" count).
    expect((await tasksOf(w.manager)).total).toBe(managerBefore + 1);
    // The setter's count leaves it out.
    expect((await tasksOf(w.hrPlain)).items.map((i) => i.appraisalId)).not.toContain(a.id);
    // Reviewed: gone from the list and the count.
    expect((await h.call(hrCounter, 'POST', `/v1/appraisals/${a.id}/goal-review`, { expectedVersion: a.version })).statusCode).toBe(200);
    expect(await widget(hrCounter, 'MY_TASKS')).toMatchObject({ status: 'OK', value: beforeList.total });
    expect((await tasksOf(w.manager)).total).toBe(managerBefore);
  });
});
