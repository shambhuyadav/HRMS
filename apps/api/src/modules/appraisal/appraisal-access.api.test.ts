// Appraisal access, windows, exceptions, cancellation and races over HTTP (FR-040, FR-043, FR-044; DF02; DF03; DF08;
// C1/C4; BR-055; ZT01/02/04/07/10/11/12). Synthetic data only: example.test addresses and made-up names and goals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import {
  addDays,
  appraisalWorld,
  decide,
  enrol,
  GOALS,
  HR_OVERSIGHT,
  openCycle,
  ownView,
  person,
  RATER,
  rate,
  REVIEWER,
  selfAssess,
  staffView,
  taskOf,
  type View,
  type World,
} from './appraisal.fixtures.js';

describe.runIf(isModuleActive('appraisal'))('appraisal: access, windows, cancellation and races', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let w: World;
  let cycleId: string;
  let otherManager: TestActor;
  let hrFin: TestActor;
  let bHr: TestActor;

  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
  const appraisee = async (managerId: string, name = 'Synthetic Employee Nu') => {
    const id = await person(h, A, w.hr, { managerId, name });
    return { id, actor: await h.actor(A, 'EMPLOYEE', { employeeId: id }) };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    w = await appraisalWorld(h, A);
    cycleId = (await openCycle(h, w)).id;
    otherManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await person(h, A, w.hr, { name: 'Synthetic Other Manager' }), extra: RATER });
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept, extra: HR_OVERSIGHT });
    bHr = await h.actor(B, 'HR_ADMINISTRATOR', { extra: HR_OVERSIGHT });
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('keeps every reader inside the selected assignment’s row scope; outside it reads as not found', async () => {
    const e = await appraisee(w.managerEmp);
    const id = (await enrol(h, w.hr, cycleId, e.id)).id;
    // The direct manager (team scope) sees it; another manager, a department-filtered HR and another company do not.
    expect((await h.call(w.manager, 'GET', `/v1/appraisals/${id}`)).statusCode).toBe(200);
    for (const outsider of [otherManager, hrFin, bHr]) {
      expect((await h.call(outsider, 'GET', `/v1/appraisals/${id}`)).statusCode).toBe(404);
      const list = await h.call(outsider, 'GET', `/v1/appraisals?cycleId=${cycleId}`);
      expect(((list.json().items ?? []) as { id: string }[]).map((r) => r.id)).not.toContain(id);
    }
    expect((await h.call(otherManager, 'POST', '/v1/appraisals', { cycleId, employeeId: (await appraisee(w.managerEmp)).id, goals: GOALS })).statusCode).toBe(404);
    // Another employee: only their own record, and only in the Employee OWN context.
    const peer = await appraisee(w.managerEmp, 'Synthetic Employee Xi');
    expect((await h.call(peer.actor, 'GET', `/v1/me/appraisals/${id}`)).statusCode).toBe(404);
    expect((await h.call(peer.actor, 'GET', `/v1/appraisals/${id}`)).statusCode).toBe(404);
    expect((await h.call(peer.actor, 'PUT', `/v1/me/appraisals/${id}/self-entry`, { entries: [], expectedVersion: 1 })).statusCode).toBe(404);
    expect((await h.call(w.hr, 'GET', '/v1/me/appraisals')).json().error).toBe('EMPLOYEE_CONTEXT_REQUIRED');
    // No goal-setting duty for the employee; the denial is audited without payload (FR-098).
    expect((await h.call(e.actor, 'POST', '/v1/appraisals', { cycleId, employeeId: e.id })).statusCode).toBe(403);
    const denial = await h.one<{ after_values: { action: string; reason: string } }>(
      `select after_values from audit_event where company_id = $1 and actor_user_id = $2 and action = 'ACCESS_DENIED' and resource_code = 'appraisal' order by occurred_at desc limit 1`,
      [A.id, e.actor.user],
    );
    expect(denial.after_values).toMatchObject({ action: 'manage', reason: 'NO_PERMISSION' });
    // The Appraisal Reviewer role sees only assigned work (none) and never ratings (BRD 4753).
    const reviewerRole = await h.actor(A, 'APPRAISAL_REVIEWER');
    expect((await h.call(reviewerRole, 'GET', `/v1/appraisals?cycleId=${cycleId}`)).json()).toMatchObject({ items: [], total: 0 });
    expect((await h.call(reviewerRole, 'GET', `/v1/appraisals/${id}`)).statusCode).toBe(404);
    expect((await h.call(reviewerRole, 'GET', '/v1/appraisal-tasks/mine')).json()).toEqual({ items: [] });
    // An unknown or altered task id reads as missing.
    expect((await decide(h, w.manager, A.dept, { decision: 'APPROVE' })).statusCode).toBe(404);
  });

  it('nobody manages their own appraisal, and an administrator never sees their own rating', async () => {
    const hrSelfEmp = await person(h, A, w.hr, { managerId: w.managerEmp, name: 'Synthetic HR Person' });
    const hrSelf = await h.actor(A, 'HR_ADMINISTRATOR', { employeeId: hrSelfEmp, extra: [...new Set([...REVIEWER, ...HR_OVERSIGHT])] });
    expect((await h.call(hrSelf, 'POST', '/v1/appraisals', { cycleId, employeeId: hrSelfEmp, goals: GOALS })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    const id = (await enrol(h, w.hr, cycleId, hrSelfEmp)).id;
    const v = await staffView(h, hrSelf, id);
    expect((await h.call(hrSelf, 'PUT', `/v1/appraisals/${id}/goals`, { goals: GOALS, expectedVersion: v.version })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    expect((await h.call(hrSelf, 'POST', `/v1/appraisals/${id}/cancel`, { reason: 'Synthetic', expectedVersion: v.version })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    expect((await h.call(hrSelf, 'POST', `/v1/appraisals/${id}/window-exceptions`, { stage: 'SELF_ENTRY', validUntil: w.today, reason: 'Synthetic' })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    // Complete it through the ordinary route (the same person's Employee context self-assesses, BR-055), then look at
    // it from the HR context: operational data only.
    const employeeContext = await h.actor(A, 'EMPLOYEE', { user: hrSelf.user });
    expect((await h.call(hrSelf, 'GET', `/v1/me/appraisals/${id}`)).json().error).toBe('EMPLOYEE_CONTEXT_REQUIRED');
    await selfAssess(h, employeeContext, id, [5, 5, 5]);
    await rate(h, w.manager, id, [3, 3, 3]);
    // The owner is never a reviewer of their own appraisal, even when eligible and listed.
    expect(await taskOf(h, hrSelf, id)).toBeUndefined();
    const t2 = (await taskOf(h, w.rev1, id))!;
    expect((await decide(h, w.rev1, t2.taskId, { decision: 'APPROVE', reviewerScore: 4 })).json().state).toBe('APPROVED');
    const fromHrContext = await staffView(h, hrSelf, id);
    expect(fromHrContext).toMatchObject({ state: 'APPROVED' });
    expect(fromHrContext).not.toHaveProperty('finalRating');
    expect(fromHrContext.revisions[0]).not.toHaveProperty('managerRating');
    // One's own appraisal reads as the own view shows it in every context (no reviewer identities or task ids).
    expect(fromHrContext.decisions[0]).not.toHaveProperty('decidedBy');
    expect(JSON.stringify(fromHrContext)).not.toMatch(/Synthetic (self|manager|private)/);
    expect(((await h.call(hrSelf, 'GET', `/v1/appraisals?cycleId=${cycleId}`)).json().items as Record<string, unknown>[]).find((r) => r.id === id)).not.toHaveProperty('finalRating');
    expect(await staffView(h, w.hr, id)).toMatchObject({ finalRating: '3.00' });
    // Reports and exports leave the caller's own appraisal out.
    const code = (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [hrSelfEmp])).c;
    expect((await h.call(hrSelf, 'GET', `/v1/appraisal-cycles/${cycleId}/report`)).json()).toMatchObject({ ownAppraisalExcluded: true });
    expect((await h.call(hrSelf, 'GET', `/v1/appraisal-cycles/${cycleId}/export`)).body).not.toContain(code);
    expect((await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycleId}/export`)).body).toContain(code);
  });

  it('refuses entries outside open windows unless an authorised exception is recorded (FR-040)', async () => {
    const closed = await openCycle(h, w, {
      offsetYears: 1,
      windows: {
        goalSetting: { opensOn: addDays(w.today, -30), closesOn: addDays(w.today, -20) },
        selfEntry: { opensOn: addDays(w.today, -20), closesOn: addDays(w.today, -10) },
        managerRating: { opensOn: addDays(w.today, -10), closesOn: addDays(w.today, -1) },
      },
    });
    const e = await appraisee(w.managerEmp, 'Synthetic Employee Omicron');
    expect((await h.call(w.hr, 'POST', '/v1/appraisals', { cycleId: closed.id, employeeId: e.id, goals: GOALS })).json()).toMatchObject({ error: 'WINDOW_CLOSED', details: { stage: 'GOAL_SETTING' } });
    // Enrolment itself is not an entry: the appraisal waits for its goals.
    let v = await enrol(h, w.hr, closed.id, e.id, []);
    expect(v).toMatchObject({ state: 'DRAFT', taskStatus: 'AWAITING_GOALS', goalWeightTotal: 0 });
    expect((await h.call(w.hr, 'PUT', `/v1/appraisals/${v.id}/goals`, { goals: GOALS, expectedVersion: v.version })).json().error).toBe('WINDOW_CLOSED');
    // Only an authorised HR user records an exception, valid through a date not in the past, with a reason.
    expect((await h.call(e.actor, 'POST', `/v1/appraisals/${v.id}/window-exceptions`, { stage: 'GOAL_SETTING', validUntil: w.today, reason: 'x' })).statusCode).toBe(403);
    expect((await h.call(w.manager, 'POST', `/v1/appraisals/${v.id}/window-exceptions`, { stage: 'GOAL_SETTING', validUntil: w.today, reason: 'x' })).statusCode).toBe(403);
    expect((await h.call(w.hrPlain, 'POST', `/v1/appraisals/${v.id}/window-exceptions`, { stage: 'GOAL_SETTING', validUntil: addDays(w.today, -1), reason: 'x' })).json().error).toBe('INVALID_DATE');
    const recorded = await h.call(w.hrPlain, 'POST', `/v1/appraisals/${v.id}/window-exceptions`, { stage: 'GOAL_SETTING', validUntil: w.today, reason: 'Synthetic late goal setting reason' });
    expect(recorded.statusCode, recorded.body).toBe(201);
    v = recorded.json() as View;
    // The reason is confidential: plain HR sees that an exception exists, HR with the reason grant sees why.
    expect((v as unknown as { exceptions: Record<string, unknown>[] }).exceptions).toMatchObject([{ stage: 'GOAL_SETTING', validUntil: w.today, recordedBy: { userId: w.hrPlain.user } }]);
    expect(JSON.stringify(v)).not.toContain('Synthetic late goal setting reason');
    expect(((await staffView(h, w.hr, v.id)) as unknown as { exceptions: Record<string, unknown>[] }).exceptions).toMatchObject([{ reason: 'Synthetic late goal setting reason' }]);
    expect(JSON.stringify(await ownView(h, e.actor, v.id))).not.toContain('Synthetic late goal setting reason');
    const goalsSet = await h.call(w.hr, 'PUT', `/v1/appraisals/${v.id}/goals`, { goals: GOALS, expectedVersion: v.version });
    expect(goalsSet.statusCode, goalsSet.body).toBe(200);

    // Self-entry: closed window refused, then admitted by an exception for this appraisal only.
    let own = await ownView(h, e.actor, v.id);
    expect(own.windows).toMatchObject({ selfEntry: { openToday: false, entryAllowed: false, exceptionUntil: null } });
    const refused = await h.call(e.actor, 'PUT', `/v1/me/appraisals/${v.id}/self-entry`, { entries: [{ goalId: own.goals[0]!.id, score: 3 }], expectedVersion: own.version });
    expect(refused.json()).toMatchObject({ error: 'WINDOW_CLOSED', details: { stage: 'SELF_ENTRY' } });
    expect((await h.call(w.hrPlain, 'POST', `/v1/appraisals/${v.id}/window-exceptions`, { stage: 'SELF_ENTRY', validUntil: addDays(w.today, 2), reason: 'Synthetic' })).statusCode).toBe(201);
    own = await ownView(h, e.actor, v.id);
    expect(own.windows).toMatchObject({ selfEntry: { openToday: false, entryAllowed: true, exceptionUntil: addDays(w.today, 2) } });
    await selfAssess(h, e.actor, v.id, [4, 4, 4]);

    // Manager rating: refused for saving and for submitting, until an exception admits it.
    const t1 = (await taskOf(h, w.manager, v.id))!;
    const entries = t1.appraisal!.goals.map((g) => ({ goalId: g.id, score: 4 }));
    expect((await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t1.taskId}/rating`, { entries, expectedVersion: t1.appraisal!.version })).json().error).toBe('WINDOW_CLOSED');
    expect((await decide(h, w.manager, t1.taskId, { decision: 'APPROVE' })).json().error).toBe('WINDOW_CLOSED');
    expect((await h.call(w.hrPlain, 'POST', `/v1/appraisals/${v.id}/window-exceptions`, { stage: 'MANAGER_RATING', validUntil: w.today, reason: 'Synthetic' })).statusCode).toBe(201);
    expect(await rate(h, w.manager, v.id, [4, 4, 4])).toMatchObject({ state: 'IN_REVIEW' });

    // Exceptions are append-only, and never recorded by the appraised employee (database rules too).
    await expect(h.db.query(`update appraisal_window_exception set valid_until = valid_until + 30 where appraisal_id = $1`, [v.id])).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.db.query(`insert into appraisal_window_exception (company_id, appraisal_id, stage, valid_until, reason, recorded_by) values ($1, $2, 'SELF_ENTRY', $3, 'x', $4)`, [A.id, v.id, w.today, e.actor.user]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('HR cancels an unfinished appraisal with a confidential reason; the record stays and the employee may be enrolled again', async () => {
    const e = await appraisee(w.managerEmp, 'Synthetic Employee Pi');
    const id = (await enrol(h, w.hr, cycleId, e.id)).id;
    const submitted = await selfAssess(h, e.actor, id, [3, 3, 3]);
    expect(await taskOf(h, w.manager, id)).toBeDefined();
    expect((await h.call(w.manager, 'POST', `/v1/appraisals/${id}/cancel`, { reason: 'x', expectedVersion: submitted.version })).statusCode).toBe(403);
    expect((await h.call(w.hrPlain, 'POST', `/v1/appraisals/${id}/cancel`, { reason: 'Synthetic', expectedVersion: submitted.version - 1 })).json().error).toBe('STALE_VERSION');
    const cancelled = await h.call(w.hrPlain, 'POST', `/v1/appraisals/${id}/cancel`, { reason: 'Synthetic cancellation reason', expectedVersion: submitted.version });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(cancelled.json()).toMatchObject({ state: 'CANCELLED', taskStatus: 'CANCELLED', pending: null });
    expect(cancelled.json()).not.toHaveProperty('cancelReason');
    expect(await staffView(h, w.hr, id)).toMatchObject({ cancelReason: 'Synthetic cancellation reason', revisions: [{ state: 'CANCELLED' }] });
    expect(await taskOf(h, w.manager, id)).toBeUndefined();
    expect((await h.call(w.hrPlain, 'POST', `/v1/appraisals/${id}/cancel`, { reason: 'Again', expectedVersion: (cancelled.json() as View).version })).json().error).toBe('INVALID_STATE');
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(e.actor)).map((n) => n.category)).toContain('APPRAISAL_CANCELLED');
    expect((await inbox(w.manager)).find((n) => n.category === 'APPRAISAL_TASK_CANCELLED')!.body).toContain('was cancelled; no action is needed');
    expect(JSON.stringify(await inbox(e.actor))).not.toContain('Synthetic cancellation reason');
    // DF08: nothing is deleted; a cancelled appraisal no longer blocks a new enrolment in the cycle.
    await expect(h.db.query(`delete from appraisal where id = $1`, [id])).rejects.toMatchObject({ code: '23514' });
    expect((await enrol(h, w.hr, cycleId, e.id)).state).toBe('DRAFT');
  });

  it('an employee can never write a manager rating, even directly in the database (FR-043)', async () => {
    const e = await appraisee(w.managerEmp, 'Synthetic Employee Sigma');
    const id = (await enrol(h, w.hr, cycleId, e.id)).id;
    await selfAssess(h, e.actor, id, [5, 5, 5]);
    await expect(h.db.query(`update appraisal_entry set manager_score = 5, updated_by = $2 where appraisal_id = $1`, [id, e.actor.user])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update appraisal_revision set manager_comment = 'Synthetic self-praise', updated_by = $2 where appraisal_id = $1`, [id, e.actor.user])).rejects.toMatchObject({ code: '23514' });
    // The self-entry is fixed once submitted, whoever writes.
    await expect(h.db.query(`update appraisal_entry set self_score = 1, updated_by = $2 where appraisal_id = $1`, [id, w.hr.user])).rejects.toMatchObject({ code: '23514' });
    // The rater can still rate.
    expect(await rate(h, w.manager, id, [2, 2, 2])).toMatchObject({ state: 'IN_REVIEW' });
  });

  it('parallel submissions, decisions and enrolments apply once', async () => {
    const e = await appraisee(w.managerEmp, 'Synthetic Employee Tau');
    const id = (await enrol(h, w.hr, cycleId, e.id)).id;
    const own = await ownView(h, e.actor, id);
    const saved = (
      await h.call(e.actor, 'PUT', `/v1/me/appraisals/${id}/self-entry`, { entries: own.goals.map((g) => ({ goalId: g.id, score: 3 })), expectedVersion: own.version })
    ).json() as View;
    const submits = await Promise.all([0, 1].map(() => h.call(e.actor, 'POST', `/v1/me/appraisals/${id}/submit`, { expectedVersion: saved.version })));
    expect(submits.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from approval_instance i join appraisal a on a.transaction_id = i.transaction_id where a.id = $1`, [id])).n).toBe(1);

    const t1 = (await taskOf(h, w.manager, id))!;
    await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t1.taskId}/rating`, { entries: t1.appraisal!.goals.map((g) => ({ goalId: g.id, score: 4 })), expectedVersion: t1.appraisal!.version });
    const decisions = await Promise.all([0, 1].map(() => decide(h, w.manager, t1.taskId, { decision: 'APPROVE' })));
    expect(decisions.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from approval_decision where task_id = $1`, [t1.taskId])).n).toBe(1);
    expect((await taskOf(h, w.rev1, id))!.step).toBe(2);

    const other = await appraisee(w.managerEmp, 'Synthetic Employee Upsilon');
    const enrolments = await Promise.all([0, 1].map(() => h.call(w.hr, 'POST', '/v1/appraisals', { cycleId, employeeId: other.id, goals: GOALS })));
    expect(enrolments.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from appraisal where employee_id = $1`, [other.id])).n).toBe(1);
  });

  it('enrolment checks the employee, the cycle and overlaps; submission needs goals totalling exactly 100', async () => {
    const e = await appraisee(w.managerEmp, 'Synthetic Employee Phi');
    expect((await h.call(w.hr, 'POST', '/v1/appraisals', { cycleId, employeeId: e.id, goals: [...GOALS, { sequence: 1, description: 'Duplicate', weight: 5 }] })).json().error).toBe('DUPLICATE_SEQUENCE');
    expect((await h.call(w.hr, 'POST', '/v1/appraisals', { cycleId, employeeId: e.id, goals: [{ sequence: 1, description: 'Synthetic', weight: 0 }] })).statusCode).toBe(400);
    expect((await h.call(w.hr, 'POST', '/v1/appraisals', { cycleId, employeeId: e.id, goals: [{ sequence: 1, description: 'Synthetic', weight: 12.5 }] })).statusCode).toBe(400);
    const v = await enrol(h, w.hr, cycleId, e.id, [{ sequence: 1, description: 'Synthetic only goal', weight: 60 }]);
    expect(v).toMatchObject({ taskStatus: 'AWAITING_GOALS', goalWeightTotal: 60 });
    expect((await h.call(w.hr, 'POST', '/v1/appraisals', { cycleId, employeeId: e.id })).json().error).toBe('APPRAISAL_EXISTS');
    // Another cycle over the same period (e.g. for another population) cannot hold the same employee (FR-040).
    const twin = await openCycle(h, w);
    expect((await h.call(w.hr, 'POST', '/v1/appraisals', { cycleId: twin.id, employeeId: e.id })).json().error).toBe('CYCLE_OVERLAP');
    const own = await ownView(h, e.actor, v.id);
    await h.call(e.actor, 'PUT', `/v1/me/appraisals/${v.id}/self-entry`, { entries: [{ goalId: own.goals[0]!.id, score: 4 }], expectedVersion: own.version });
    expect((await h.call(e.actor, 'POST', `/v1/me/appraisals/${v.id}/submit`, { expectedVersion: own.version + 1 })).json()).toMatchObject({ error: 'WEIGHT_TOTAL_NOT_100', details: { total: 60 } });
    // Goals are replaced as a set while the draft was never submitted; removed goals are deactivated, not deleted.
    const set = await h.call(w.hr, 'PUT', `/v1/appraisals/${v.id}/goals`, {
      goals: [
        { sequence: 1, description: 'Synthetic only goal', weight: 50 },
        { sequence: 2, description: 'Synthetic second goal', weight: 50 },
      ],
      expectedVersion: own.version + 1,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toMatchObject({ goalWeightTotal: 100, taskStatus: 'AWAITING_SELF_ENTRY' });
    // An inactive employee or one who joined after the cycle cannot be enrolled.
    const leaver = await person(h, A, w.hr, { managerId: w.managerEmp });
    await h.setStatus(A, leaver, 'INACTIVE_SEPARATED');
    expect((await h.call(w.hr, 'POST', '/v1/appraisals', { cycleId, employeeId: leaver })).json().error).toBe('EMPLOYEE_NOT_ACTIVE');
    const late = await person(h, A, w.hr, { managerId: w.managerEmp });
    await h.db.query(`update employee set joining_date = '2099-01-05' where id = $1`, [late]);
    expect((await h.call(w.hr, 'POST', '/v1/appraisals', { cycleId, employeeId: late })).json().error).toBe('JOINED_AFTER_CYCLE');
  });

  it('no eligible rater blocks the submission with a repairable routing error; nothing is auto-approved (DF03)', async () => {
    const plainManagerEmp = await person(h, A, w.hr, { name: 'Synthetic Plain Manager' });
    await h.actor(A, 'REPORTING_MANAGER', { employeeId: plainManagerEmp });
    const e = await appraisee(plainManagerEmp, 'Synthetic Employee Chi');
    const id = (await enrol(h, w.hr, cycleId, e.id)).id;
    // Empty the explicit list: the ineligible manager has no fallback.
    expect((await h.call(w.hr, 'PUT', '/v1/workflows/appraisal/fallback-reviewers', { reviewers: [] })).statusCode).toBe(200);
    const own = await ownView(h, e.actor, id);
    const saved = (await h.call(e.actor, 'PUT', `/v1/me/appraisals/${id}/self-entry`, { entries: own.goals.map((g) => ({ goalId: g.id, score: 3 })), expectedVersion: own.version })).json() as View;
    expect((await h.call(e.actor, 'POST', `/v1/me/appraisals/${id}/submit`, { expectedVersion: saved.version })).json().error).toBe('NO_ELIGIBLE_REVIEWER');
    expect(await ownView(h, e.actor, id)).toMatchObject({ state: 'DRAFT', revisions: [{ state: 'DRAFT' }] });
    // Repaired: the submission goes through to the listed reviewer.
    expect((await h.call(w.hr, 'PUT', '/v1/workflows/appraisal/fallback-reviewers', { reviewers: [{ userId: w.rev1.user, priority: 1 }, { userId: w.rev2.user, priority: 2 }] })).statusCode).toBe(200);
    expect((await h.call(e.actor, 'POST', `/v1/me/appraisals/${id}/submit`, { expectedVersion: saved.version })).json().state).toBe('SUBMITTED');
    expect((await taskOf(h, w.rev1, id))!.step).toBe(1);
  });
});
