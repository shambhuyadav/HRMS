// Appraisal flow over HTTP (FR-040 to FR-044; F1 "Appraisal"; DF02; DF03; DF08; DF12; H3 TN18; C4; ZT07):
// enrolment with goals, own self-entry and submission, manager rating with the exact F1 weighted result, independent
// review, returns as new revisions, the explicit second reviewer level, fallback routing and what each reader sees.
// Synthetic data only: example.test addresses and made-up names and goals.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { APPRAISAL_EVENTS } from './events.js';
import {
  appraisalWorld,
  confirm,
  decide,
  enrol,
  openCycle,
  openWindows,
  ownView,
  person,
  rate,
  selfAssess,
  staffView,
  taskOf,
  trailText,
  type View,
  type World,
} from './appraisal.fixtures.js';

describe.runIf(isModuleActive('appraisal'))('appraisal: entry, rating, review and revisions', () => {
  let h: Harness;
  let A: Company;
  let w: World;
  let cycleId: string;
  let cycleCode: string;

  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];
  /** A new employee reporting to the given manager, with their Employee OWN context. */
  const appraisee = async (managerId: string, name = 'Synthetic Employee Eli') => {
    const id = await person(h, A, w.hr, { managerId, name });
    return { id, actor: await h.actor(A, 'EMPLOYEE', { employeeId: id }) };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await appraisalWorld(h, A);
    const c = await openCycle(h, w);
    cycleId = c.id;
    cycleCode = c.code;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('takes an appraisal from goals to a confirmed result; each reader sees only what DF02 allows', async () => {
    const e = await appraisee(w.managerEmp);
    const created = await enrol(h, w.hr, cycleId, e.id);
    expect(created).toMatchObject({ state: 'DRAFT', revision: 1, source: 'MANUAL', taskStatus: 'AWAITING_SELF_ENTRY', goalWeightTotal: 100 });
    expect(created.goals.map((g) => [g.sequence, g.weight])).toEqual([
      [1, 30],
      [2, 30],
      [3, 40],
    ]);
    const id = created.id;

    // TN18: the employee sees their goals, completion flags and task status; never manager progress or results.
    const mine = (await h.call(e.actor, 'GET', '/v1/me/appraisals')).json().items as Record<string, unknown>[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id, state: 'DRAFT', taskStatus: 'AWAITING_SELF_ENTRY', goalCount: 3, goalWeightTotal: 100 });
    expect(mine[0]).not.toHaveProperty('finalRating');
    let own = await ownView(h, e.actor, id);
    expect(own.goals[2]).toMatchObject({ description: 'Synthetic learning goal', target: 'Two synthetic courses', weight: 40, selfEntryComplete: false });
    expect(own.goals[0]).not.toHaveProperty('managerRatingComplete');
    expect(own.windows).toMatchObject({ selfEntry: { openToday: true, entryAllowed: true } });

    // F1: every score is an integer 1..5; only the appraisal's own goals; partial drafts are allowed.
    const bad = await h.call(e.actor, 'PUT', `/v1/me/appraisals/${id}/self-entry`, { entries: [{ goalId: own.goals[0]!.id, score: 6 }], expectedVersion: own.version });
    expect(bad.statusCode).toBe(400);
    const fraction = await h.call(e.actor, 'PUT', `/v1/me/appraisals/${id}/self-entry`, { entries: [{ goalId: own.goals[0]!.id, score: 2.5 }], expectedVersion: own.version });
    expect(fraction.statusCode).toBe(400);
    const foreign = await h.call(e.actor, 'PUT', `/v1/me/appraisals/${id}/self-entry`, { entries: [{ goalId: w.A.dept, score: 3 }], expectedVersion: own.version });
    expect(foreign.json().error).toBe('UNKNOWN_GOAL');
    const partial = await h.call(e.actor, 'PUT', `/v1/me/appraisals/${id}/self-entry`, {
      entries: [
        { goalId: own.goals[0]!.id, score: 4, comment: 'Synthetic self note 1' },
        { goalId: own.goals[1]!.id, score: 3 },
      ],
      expectedVersion: own.version,
    });
    expect(partial.statusCode, partial.body).toBe(200);
    own = partial.json() as View;
    expect(own.goals.map((g) => g.selfEntryComplete)).toEqual([true, true, false]);
    expect(own.revisions[0]).toMatchObject({ revision: 1, state: 'DRAFT', selfEntry: { entries: [{ sequence: 1, score: 4, comment: 'Synthetic self note 1' }, { sequence: 2, score: 3 }] } });
    const stale = await h.call(e.actor, 'POST', `/v1/me/appraisals/${id}/submit`, { expectedVersion: own.version - 1 });
    expect(stale.json().error).toBe('STALE_VERSION');
    const incomplete = await h.call(e.actor, 'POST', `/v1/me/appraisals/${id}/submit`, { expectedVersion: own.version });
    expect(incomplete.json()).toMatchObject({ error: 'SELF_ENTRY_INCOMPLETE', details: { goals: [3] } });

    // Submission fixes the self-entry and routes the rating to the current direct manager (DF03).
    const submitted = await selfAssess(h, e.actor, id, [4, 3, 5]);
    expect(submitted).toMatchObject({ state: 'SUBMITTED', taskStatus: 'AWAITING_MANAGER_RATING', pending: { step: 1, stage: 'MANAGER_RATING', with: { displayName: 'Synthetic Manager Mira' } } });
    expect(submitted.pending).not.toHaveProperty('taskId');
    const again = await h.call(e.actor, 'PUT', `/v1/me/appraisals/${id}/self-entry`, { entries: [{ goalId: own.goals[0]!.id, score: 1 }], expectedVersion: submitted.version });
    expect(again.json().error).toBe('INVALID_STATE');
    // Goals are fixed once submitted.
    expect((await h.call(w.hr, 'PUT', `/v1/appraisals/${id}/goals`, { goals: [{ sequence: 1, description: 'Changed', weight: 100 }], expectedVersion: submitted.version })).json().error).toBe('GOALS_FIXED');
    // DF12: the rater is told while the task is open; cycle and employee identity only.
    await dispatchOutbox(h.pool, 500);
    const employeeCode = (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [e.id])).c;
    expect((await inbox(w.manager)).find((n) => n.category === 'APPRAISAL_RATING_ASSIGNED')!.body).toBe(`The ${cycleCode} appraisal of Synthetic Employee Eli (${employeeCode}) is waiting for your rating.`);

    // The manager's task shows the self-entry (rating grant) and the goals' rating progress.
    const t1 = (await taskOf(h, w.manager, id))!;
    expect(t1).toMatchObject({ step: 1, stage: 'MANAGER_RATING', level: null });
    expect(t1.appraisal!.revisions[0]).toMatchObject({ state: 'SUBMITTED', selfEntry: { comment: 'Synthetic self comment', entries: [{ score: 4 }, { score: 3 }, { score: 5 }] } });
    expect(t1.appraisal!.goals.map((g) => g.managerRatingComplete)).toEqual([false, false, false]);
    // The reviewers have nothing yet; the employee can never rate (no duty) nor decide.
    expect(await taskOf(h, w.rev1, id)).toBeUndefined();
    expect((await h.call(e.actor, 'PUT', `/v1/appraisal-tasks/${t1.taskId}/rating`, { entries: [], expectedVersion: 1 })).statusCode).toBe(403);
    expect((await decide(h, e.actor, t1.taskId, { decision: 'APPROVE' })).statusCode).toBe(403);
    // Someone else's task reads as missing, even for an eligible reviewer.
    expect((await decide(h, w.rev1, t1.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);

    // The rating needs every goal scored.
    const half = await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t1.taskId}/rating`, {
      entries: [{ goalId: t1.appraisal!.goals[0]!.id, score: 3, comment: 'Synthetic manager note 1' }],
      expectedVersion: t1.appraisal!.version,
    });
    expect(half.statusCode, half.body).toBe(200);
    expect((half.json() as View).goals.map((g) => g.managerRatingComplete)).toEqual([true, false, false]);
    expect((await decide(h, w.manager, t1.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ error: 'RATING_INCOMPLETE', details: { goals: [2, 3] } });
    // The employee's own view shows progress as task status only, never the manager's draft.
    expect(JSON.stringify(await ownView(h, e.actor, id))).not.toContain('Synthetic manager note');
    // FR-110: the staff detail route shows one's own appraisal as the own view does, whatever the context: no
    // reviewer progress, task ids or reviewer identities (the employee holds the operational read duty).
    const ownViaStaffRoute = await staffView(h, e.actor, id);
    expect(ownViaStaffRoute).toMatchObject({ state: 'SUBMITTED', pending: { step: 1, with: { displayName: 'Synthetic Manager Mira' } } });
    expect(ownViaStaffRoute.goals[0]).not.toHaveProperty('managerRatingComplete');
    expect(ownViaStaffRoute.pending).not.toHaveProperty('taskId');
    expect(ownViaStaffRoute.pending!.with).not.toHaveProperty('userId');
    expect(ownViaStaffRoute.revisions[0]).not.toHaveProperty('selfEntry');
    expect(JSON.stringify(ownViaStaffRoute)).not.toContain('Synthetic manager note');

    // F1: weighted manager result = sum(weight x score) / 100 = (30x3 + 30x4 + 40x5) / 100 = 4.10, stored exactly.
    expect(await rate(h, w.manager, id, [3, 4, 5])).toMatchObject({ state: 'IN_REVIEW', pendingStep: 2 });
    const stored = await h.one<{ weighted_result: string; rated_by: string }>(`select weighted_result::text, rated_by from appraisal_revision where appraisal_id = $1 and revision = 1`, [id]);
    expect(stored).toEqual({ weighted_result: '4.10', rated_by: w.manager.user });
    // The rating is fixed once submitted, and an employee can never write it, even directly in the database.
    await expect(h.db.query(`update appraisal_entry set manager_score = 1, updated_by = $2 where appraisal_id = $1`, [id, w.manager.user])).rejects.toMatchObject({ code: '23514' });

    // C4: an independent reviewer from the list (never the rater) confirms.
    expect(await taskOf(h, w.manager, id)).toBeUndefined();
    const t2 = (await taskOf(h, w.rev1, id))!;
    expect(t2).toMatchObject({ step: 2, stage: 'REVIEW', level: 1 });
    // The reviewer confirms or returns; they never rewrite the manager's scores.
    const rewrite = await h.call(w.rev1, 'PUT', `/v1/appraisal-tasks/${t2.taskId}/rating`, { entries: [{ goalId: t2.appraisal!.goals[0]!.id, score: 1 }], expectedVersion: t2.appraisal!.version });
    expect(rewrite.json().error).toBe('NOT_RATING_TASK');
    expect(t2.appraisal!.revisions[0]).toMatchObject({ state: 'RATED', managerRating: { weightedResult: '4.10', comment: 'Synthetic manager comment' } });
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(w.rev1)).find((n) => n.category === 'APPRAISAL_REVIEW_ASSIGNED')!.body).toBe(`The ${cycleCode} appraisal of Synthetic Employee Eli (${employeeCode}) is waiting for your review (level 1).`);
    expect(await confirm(h, w.rev1, id)).toMatchObject({ state: 'APPROVED' });

    // HR oversight with the rating grant sees the result and the remarks; plain HR sees operational data only.
    const full = await staffView(h, w.hr, id);
    expect(full).toMatchObject({ state: 'APPROVED', taskStatus: 'COMPLETED', finalRating: '4.10' });
    expect(full.decisions).toMatchObject([
      { revision: 1, step: 1, stage: 'MANAGER_RATING', decision: 'APPROVE', remark: 'Synthetic private rater remark', decidedBy: { userId: w.manager.user } },
      { revision: 1, step: 2, stage: 'REVIEW', level: 1, decision: 'APPROVE', remark: 'Synthetic private reviewer remark', decidedBy: { userId: w.rev1.user } },
    ]);
    const plain = await staffView(h, w.hrPlain, id);
    expect(plain).toMatchObject({ state: 'APPROVED', goalWeightTotal: 100 });
    expect(plain).not.toHaveProperty('finalRating');
    expect(plain.revisions[0]).not.toHaveProperty('managerRating');
    expect(plain.revisions[0]).not.toHaveProperty('selfEntry');
    expect(plain.decisions[0]).not.toHaveProperty('remark');
    expect(JSON.stringify(plain)).not.toMatch(/Synthetic (self|manager|private)/);
    const plainList = (await h.call(w.hrPlain, 'GET', `/v1/appraisals?cycleId=${cycleId}`)).json().items as Record<string, unknown>[];
    expect(plainList.find((r) => r.id === id)).not.toHaveProperty('finalRating');
    expect(((await h.call(w.hr, 'GET', `/v1/appraisals?cycleId=${cycleId}`)).json().items as Record<string, unknown>[]).find((r) => r.id === id)).toMatchObject({ finalRating: '4.10' });

    // The employee: completed status, own self-entry, no published result (no setting authorises one).
    own = await ownView(h, e.actor, id);
    expect(own).toMatchObject({ state: 'APPROVED', taskStatus: 'COMPLETED' });
    expect(own).not.toHaveProperty('finalRating');
    expect(own.revisions[0]).toMatchObject({ selfEntry: { entries: [{ score: 4 }, { score: 3 }, { score: 5 }] } });
    expect(own.revisions[0]).not.toHaveProperty('managerRating');
    expect(own.decisions[0]).not.toHaveProperty('remark');
    expect(own.decisions[0]).not.toHaveProperty('decidedBy');
    // (\b keeps timestamps such as ...:34.105Z from matching the result.)
    const ownText = JSON.stringify(own);
    expect(ownText).not.toMatch(/Synthetic (manager|private)|\b4\.10\b/);
    const completedViaStaffRoute = await staffView(h, e.actor, id);
    expect(completedViaStaffRoute).toMatchObject({ state: 'APPROVED', taskStatus: 'COMPLETED' });
    expect(completedViaStaffRoute).not.toHaveProperty('finalRating');
    expect(completedViaStaffRoute.decisions[0]).not.toHaveProperty('decidedBy');
    expect(completedViaStaffRoute.revisions[0]).not.toHaveProperty('ratedAt');
    expect(JSON.stringify(completedViaStaffRoute)).not.toMatch(/Synthetic (self|manager|private)|\b4\.10\b/);

    // DF12: the completion notice tells the employee nothing about the result.
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(e.actor)).find((n) => n.category === 'APPRAISAL_COMPLETED')!.body).toBe(`Your ${cycleCode} appraisal has been reviewed and completed.`);
    const notices = JSON.stringify([...(await inbox(w.manager)), ...(await inbox(w.rev1)), ...(await inbox(e.actor))]);
    expect(notices).not.toMatch(/\b4\.10\b|Synthetic (self|manager|private)/);

    // Audit and outbox carry states, revisions and field names, never scores, comments or remarks.
    const trail = await trailText(h, A.id);
    expect(trail).toContain('SUBMITTED');
    expect(trail).not.toMatch(/\b4\.10\b|Synthetic (self|manager|private)/);
  });

  it('a return closes the revision and the employee resubmits a new one; earlier ratings stay as they were', async () => {
    const e = await appraisee(w.managerEmp, 'Synthetic Employee Rho');
    const id = (await enrol(h, w.hr, cycleId, e.id)).id;
    await selfAssess(h, e.actor, id, [2, 2, 2]);
    const t1 = (await taskOf(h, w.manager, id))!;
    // A return explains to the employee what to revise; the private remark stays with the decision.
    expect((await decide(h, w.manager, t1.taskId, { decision: 'RETURN', reason: 'Synthetic private return remark' })).json().error).toBe('EMPLOYEE_MESSAGE_REQUIRED');
    expect((await decide(h, w.manager, t1.taskId, { decision: 'REJECT', reason: 'x', employeeMessage: 'x' })).statusCode).toBe(400);
    const returned = await decide(h, w.manager, t1.taskId, { decision: 'RETURN', reason: 'Synthetic private return remark', employeeMessage: 'Please add evidence of the synthetic delivery goal' });
    expect(returned.json()).toMatchObject({ state: 'RETURNED', revision: 2 });

    let own = await ownView(h, e.actor, id);
    expect(own).toMatchObject({ state: 'RETURNED', revision: 2, taskStatus: 'AWAITING_SELF_ENTRY' });
    expect(own.revisions).toMatchObject([
      { revision: 1, state: 'RETURNED', employeeMessage: 'Please add evidence of the synthetic delivery goal', selfEntry: { entries: [{ score: 2 }, { score: 2 }, { score: 2 }] } },
      { revision: 2, state: 'DRAFT', employeeMessage: null, selfEntry: { entries: [{ score: 2 }, { score: 2 }, { score: 2 }] } },
    ]);
    expect(own.goals.every((g) => g.selfEntryComplete)).toBe(true);
    expect(JSON.stringify(own)).not.toContain('Synthetic private return remark');

    // The resubmission is revision 2 of the transaction with a new approval.
    own = await selfAssess(h, e.actor, id, [3, 3, 3]);
    expect(own).toMatchObject({ state: 'SUBMITTED', revision: 2 });
    expect(await h.one<{ revision: number; instances: number }>(
      `select bt.revision, (select count(*)::int from approval_instance i where i.transaction_id = bt.id) as instances
         from appraisal a join business_transaction bt on bt.id = a.transaction_id where a.id = $1`,
      [id],
    )).toEqual({ revision: 2, instances: 2 });
    // The reviewer returns the rated revision 2; its rating is kept and revision 3 starts.
    await rate(h, w.manager, id, [1, 2, 3]);
    const t2 = (await taskOf(h, w.rev1, id))!;
    expect((await decide(h, w.rev1, t2.taskId, { decision: 'RETURN', employeeMessage: 'Synthetic: reconsider the quality goal' })).json()).toMatchObject({ state: 'RETURNED', revision: 3 });
    const history = await staffView(h, w.hr, id);
    expect(history.revisions).toMatchObject([
      { revision: 1, state: 'RETURNED', managerRating: { weightedResult: null } },
      { revision: 2, state: 'RETURNED', managerRating: { weightedResult: '2.10', entries: [{ score: 1 }, { score: 2 }, { score: 3 }] }, selfEntry: { entries: [{ score: 3 }, { score: 3 }, { score: 3 }] } },
      { revision: 3, state: 'DRAFT' },
    ]);
    // A closed revision is final, even directly in the database (DF08).
    await expect(h.db.query(`update appraisal_revision set manager_comment = 'Synthetic rewrite' where appraisal_id = $1 and revision = 2`, [id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from appraisal_revision where appraisal_id = $1`, [id])).rejects.toMatchObject({ code: '23514' });

    // Revision 3 completes with its own result: (30x5 + 30x4 + 40x4) / 100 = 4.30.
    await selfAssess(h, e.actor, id, [4, 4, 4]);
    await rate(h, w.manager, id, [5, 4, 4]);
    expect(await confirm(h, w.rev1, id)).toMatchObject({ state: 'APPROVED' });
    expect(await staffView(h, w.hr, id)).toMatchObject({ revision: 3, finalRating: '4.30' });
    expect((await staffView(h, w.hr, id)).decisions.map((d) => [d.revision, d.step, d.decision])).toEqual([
      [1, 1, 'RETURN'],
      [2, 1, 'APPROVE'],
      [2, 2, 'RETURN'],
      [3, 1, 'APPROVE'],
      [3, 2, 'APPROVE'],
    ]);
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(e.actor)).filter((n) => n.category === 'APPRAISAL_RETURNED')).toHaveLength(2);
  });

  it('an ineligible manager falls back to the explicit list, and the reviewer is never the rater (C4)', async () => {
    // A manager without the confidential rating grant is not eligible to rate (DF02: off by default).
    const plainManagerEmp = await person(h, A, w.hr, { name: 'Synthetic Plain Manager' });
    const plainManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: plainManagerEmp });
    const e = await appraisee(plainManagerEmp, 'Synthetic Employee Tau');
    const id = (await enrol(h, w.hr, cycleId, e.id)).id;
    const submitted = await selfAssess(h, e.actor, id, [3, 3, 3]);
    expect(submitted.pending).toMatchObject({ step: 1 });
    expect(await taskOf(h, plainManager, id)).toBeUndefined();
    // The plain manager still sees the team member's appraisal operationally, without ratings.
    const teamView = await staffView(h, plainManager, id);
    expect(teamView).toMatchObject({ state: 'SUBMITTED' });
    expect(teamView.revisions[0]).not.toHaveProperty('selfEntry');
    // The first listed reviewer rates; the review then goes to the second one, never back to the rater.
    await rate(h, w.rev1, id, [4, 4, 4]);
    expect(await taskOf(h, w.rev1, id)).toBeUndefined();
    expect(await confirm(h, w.rev2, id)).toMatchObject({ state: 'APPROVED' });
    expect(await staffView(h, w.hr, id)).toMatchObject({ finalRating: '4.00' });
  });

  it('a second reviewer level applies only where the cycle sets it explicitly', async () => {
    const twoLevel = await openCycle(h, w, { approvalLevels: 2, offsetYears: 1 });
    expect(twoLevel.approvalLevels).toBe(2);
    const e = await appraisee(w.managerEmp, 'Synthetic Employee Iota');
    const id = (await enrol(h, w.hr, twoLevel.id, e.id)).id;
    await selfAssess(h, e.actor, id, [5, 5, 5]);
    await rate(h, w.manager, id, [2, 3, 4]);
    expect(await confirm(h, w.rev1, id)).toMatchObject({ state: 'IN_REVIEW', pendingStep: 3 });
    const t3 = (await taskOf(h, w.rev2, id))!;
    expect(t3).toMatchObject({ step: 3, stage: 'REVIEW', level: 2 });
    expect(await confirm(h, w.rev2, id)).toMatchObject({ state: 'APPROVED' });
    // (30x2 + 30x3 + 40x4) / 100 = 3.10
    expect(await staffView(h, w.hr, id)).toMatchObject({ finalRating: '3.10', revisions: [{ approvalLevels: 2 }] });
    // Level 2 can return the revision; a cancellation while level 2 is pending ends that review too.
    const f = await appraisee(w.managerEmp, 'Synthetic Employee Mu');
    const second = (await enrol(h, w.hr, twoLevel.id, f.id)).id;
    await selfAssess(h, f.actor, second, [3, 3, 3]);
    await rate(h, w.manager, second, [3, 3, 3]);
    await confirm(h, w.rev1, second);
    const level2 = (await taskOf(h, w.rev2, second))!;
    expect((await decide(h, w.rev2, level2.taskId, { decision: 'RETURN', employeeMessage: 'Synthetic: add detail' })).json()).toMatchObject({ state: 'RETURNED', revision: 2 });
    await selfAssess(h, f.actor, second, [4, 4, 4]);
    await rate(h, w.manager, second, [4, 4, 4]);
    expect(await confirm(h, w.rev1, second)).toMatchObject({ pendingStep: 3 });
    expect(await staffView(h, w.hrPlain, second)).toMatchObject({ state: 'IN_REVIEW', pending: { step: 3, stage: 'REVIEW', level: 2, with: { userId: w.rev2.user } } });
    const latest = await staffView(h, w.hr, second);
    expect((await h.call(w.hr, 'POST', `/v1/appraisals/${second}/cancel`, { reason: 'Synthetic cancellation', expectedVersion: latest.version })).json()).toMatchObject({ state: 'CANCELLED', pending: null });
    expect(await taskOf(h, w.rev2, second)).toBeUndefined();
    expect((await h.db.query(`select state from appraisal_second_review where appraisal_id = $1 order by created_at`, [second])).rows.map((r) => r.state)).toEqual(['RETURNED', 'CANCELLED']);
    expect((await staffView(h, w.hr, second)).decisions.map((d) => [d.revision, d.step, d.decision])).toEqual([
      [1, 1, 'APPROVE'],
      [1, 2, 'APPROVE'],
      [1, 3, 'RETURN'],
      [2, 1, 'APPROVE'],
      [2, 2, 'APPROVE'],
    ]);

    // Levels are fixed once an appraisal of the cycle has been submitted.
    const cycle = (await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${twoLevel.id}`)).json();
    const change = await h.call(w.hr, 'PUT', `/v1/appraisal-cycles/${twoLevel.id}`, { name: cycle.name, approvalLevels: 1, windows: openWindows(w.today), expectedVersion: cycle.version });
    expect(change.json().error).toBe('LEVELS_FIXED');
  });

  it('serves TN18 in My ESS and a repeated decision is replayed without a second effect (ZT07)', async () => {
    const e = await appraisee(w.managerEmp, 'Synthetic Employee Kappa');
    const tab = ((await h.call(e.actor, 'GET', '/v1/me/ess')).json().tabs as { id: string; status: string; links: { href: string }[] }[]).find((t) => t.id === 'TN18')!;
    expect(tab).toMatchObject({ status: 'AVAILABLE', links: [{ href: '/v1/me/appraisals' }] });

    const id = (await enrol(h, w.manager, cycleId, e.id)).id;
    await selfAssess(h, e.actor, id, [3, 4, 3]);
    const t1 = (await taskOf(h, w.manager, id))!;
    await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t1.taskId}/rating`, {
      entries: t1.appraisal!.goals.map((g) => ({ goalId: g.id, score: 3 })),
      expectedVersion: t1.appraisal!.version,
    });
    const body = { decision: 'APPROVE', idempotencyKey: 'appraisal-replay-key-1' };
    const first = await h.call(w.manager, 'POST', `/v1/appraisal-tasks/${t1.taskId}/decision`, body);
    expect(first.json()).toMatchObject({ state: 'IN_REVIEW', replayed: false });
    const replay = await h.call(w.manager, 'POST', `/v1/appraisal-tasks/${t1.taskId}/decision`, body);
    expect(replay.json()).toMatchObject({ state: 'IN_REVIEW', replayed: true });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from approval_task t join approval_instance i on i.id = t.instance_id join appraisal a on a.transaction_id = i.transaction_id where a.id = $1`, [id])).n).toBe(2);
    // The same key on another task is refused.
    const other = await appraisee(w.managerEmp, 'Synthetic Employee Lambda');
    const otherId = (await enrol(h, w.manager, cycleId, other.id)).id;
    await selfAssess(h, other.actor, otherId, [3, 3, 3]);
    const otherTask = (await taskOf(h, w.manager, otherId))!;
    expect((await h.call(w.manager, 'POST', `/v1/appraisal-tasks/${otherTask.taskId}/decision`, body)).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('describers produce nothing for malformed or mismatched payloads, never throw, and describe the raised revision (DF12)', async () => {
    const describeEvent = (topic: string, payload: unknown) =>
      APPRAISAL_EVENTS[topic]!(h.db, { companyId: A.id, topic, aggregateId: A.id, payload: payload as Record<string, unknown> });
    const e = await appraisee(w.managerEmp, 'Synthetic Employee Omega');
    const id = (await enrol(h, w.hr, cycleId, e.id)).id;
    await selfAssess(h, e.actor, id, [3, 3, 3]);
    const t1 = (await taskOf(h, w.manager, id))!;
    // Malformed, unknown or foreign ids, and payloads that are not objects at all, produce nothing.
    const junk: unknown[] = [null, 'x', 7, [], {}, { appraisalId: 'not-a-uuid', taskId: 'x', userId: 'x', level: 'x' }, { appraisalId: A.dept, taskId: A.dept, userId: A.dept, level: 1 }];
    for (const topic of Object.keys(APPRAISAL_EVENTS)) {
      for (const payload of junk) await expect(describeEvent(topic, payload), `${topic} ${JSON.stringify(payload)}`).resolves.toBeNull();
    }
    await expect(describeEvent('appraisal.review_assigned', { appraisalId: id, taskId: t1.taskId, revision: 1, level: 3 })).resolves.toBeNull();
    // A task of another appraisal never names this appraisal to its holder.
    const other = await appraisee(w.managerEmp, 'Synthetic Employee Psi');
    const otherId = (await enrol(h, w.hr, cycleId, other.id)).id;
    await selfAssess(h, other.actor, otherId, [3, 3, 3]);
    const otherTask = (await taskOf(h, w.manager, otherId))!;
    await expect(describeEvent('appraisal.submitted', { appraisalId: id, taskId: otherTask.taskId, revision: 1 })).resolves.toBeNull();
    await expect(describeEvent('appraisal.review_assigned', { appraisalId: id, taskId: otherTask.taskId, revision: 1, level: 1 })).resolves.toBeNull();
    await expect(describeEvent('appraisal.submitted', { appraisalId: id, taskId: t1.taskId, revision: 1 })).resolves.toMatchObject({
      eventType: 'APPRAISAL_RATING_ASSIGNED',
      subjectEmployeeId: e.id,
      taskId: t1.taskId,
      transactionRevision: 1,
    });
    // A cancelled-task notice goes only to someone who held a task of this appraisal.
    await expect(describeEvent('appraisal.task_cancelled', { appraisalId: id, userId: w.hrPlain.user })).resolves.toBeNull();
    await expect(describeEvent('appraisal.task_cancelled', { appraisalId: id, userId: w.manager.user })).resolves.toMatchObject({
      eventType: 'APPRAISAL_TASK_CANCELLED',
      beneficiaryUserId: w.manager.user,
      taskId: null,
    });

    // After a return and resubmission the transaction is at revision 2; the earlier return is still described as
    // raised (revision 1), and a revision the transaction never reached falls back to the current one.
    const returned = await decide(h, w.manager, t1.taskId, { decision: 'RETURN', employeeMessage: 'Synthetic: add detail' });
    expect(returned.json()).toMatchObject({ state: 'RETURNED', revision: 2 });
    await selfAssess(h, e.actor, id, [4, 4, 4]);
    await expect(describeEvent('appraisal.returned', { appraisalId: id, revision: 1 })).resolves.toMatchObject({ eventType: 'APPRAISAL_RETURNED', transactionRevision: 1, data: { cycleCode } });
    for (const revision of [0, -1, 1.5, '1', 9]) {
      await expect(describeEvent('appraisal.returned', { appraisalId: id, revision })).resolves.toMatchObject({ transactionRevision: 2 });
    }
    // Notices carry identity only: never scores, comments or reasons.
    const t2 = (await taskOf(h, w.manager, id))!;
    const described = await describeEvent('appraisal.submitted', { appraisalId: id, taskId: t2.taskId, revision: 2 });
    expect(described).toMatchObject({ transactionRevision: 2, data: { cycleCode, employeeName: 'Synthetic Employee Omega' } });
    expect(JSON.stringify(described)).not.toMatch(/Synthetic (self|manager|private)|add detail/);
  });
});
