// Appraisal process rules decided under owner delegation, 6 Nov 2026 (owner chose process rules only; I-77): BR-013 / FR-043
// review levels, FR-043 / DF04 reviewer scores, FR-041 KRA review (with the upload's modes), FR-042 / BR-014 manual rating mode
// and the due dates behind the F2 Appraisal Reviewer "Overdue review tasks" (I-40 item 6; DF17). Each test checks the BRD
// clause's own words and the decision, over HTTP and, for the guards, directly in the database. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { resolveAccess } from '../access/authorize.js';
import { isModuleActive } from '../registry.js';
import {
  addDays,
  appraisalWorld,
  confirm,
  decide,
  enrol,
  fyStart,
  key,
  openCycle,
  openWindows,
  ownView,
  person,
  rate,
  selfAssess,
  staffView,
  taskOf,
  type View,
  type World,
} from './appraisal.fixtures.js';
import { APPRAISAL_METRICS } from './metrics.js';

type GoalReview = { required: boolean; reviewed: boolean; setBy?: { userId: string } | null; reviewedBy?: { userId: string } | null };
type RulesView = View & { goalReview: GoalReview; finalRating?: string | null };

describe.runIf(isModuleActive('appraisal'))('appraisal process rules decided under owner delegation (I-77)', () => {
  let h: Harness;
  let A: Company;
  let w: World;
  let n = 0;

  const appraisee = async (name: string, managerId?: string) => {
    const id = await person(h, A, w.hr, { managerId: managerId ?? w.managerEmp, name });
    return { id, actor: await h.actor(A, 'EMPLOYEE', { employeeId: id }) };
  };
  const cycleBody = (overrides: Record<string, unknown> = {}) => ({ code: `RULES-${++n}`, name: 'Synthetic rules cycle', startDate: fyStart(w.today), windows: openWindows(w.today), ...overrides });
  const reviewGoals = (a: TestActor, id: string, expectedVersion: number) => h.call(a, 'POST', `/v1/appraisals/${id}/goal-review`, { expectedVersion });
  const codeOf = async (id: string) => (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [id])).c;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await appraisalWorld(h, A);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('BR-013 / FR-043: a one-level cycle completes at the manager approval; by default (F1) level 2 remains pending until the reviewer decides', async () => {
    // BR-013 "one-level manager review": no reviewer level, so no review due date either.
    expect((await h.call(w.hr, 'POST', '/v1/appraisal-cycles', cycleBody({ approvalLevels: 0, reviewDueOn: addDays(w.today, 30) }))).json().error).toBe('REVIEW_DUE_NOT_USED');
    const oneLevel = await openCycle(h, w, { approvalLevels: 0 });
    expect(oneLevel).toMatchObject({ approvalLevels: 0, reviewDueOn: null });
    const e = await appraisee('Synthetic One Level');
    const id = (await enrol(h, w.hr, oneLevel.id, e.id)).id;
    await selfAssess(h, e.actor, id, [3, 3, 3]);
    // FR-043 "Level 1 completes at manager approval": the rating's approval completes the appraisal; no reviewer task opens.
    expect(await rate(h, w.manager, id, [3, 4, 5])).toMatchObject({ state: 'APPROVED' });
    for (const reviewer of [w.rev1, w.rev2]) expect(await taskOf(h, reviewer, id)).toBeUndefined();
    const done = (await staffView(h, w.hr, id)) as RulesView;
    expect(done).toMatchObject({ state: 'APPROVED', taskStatus: 'COMPLETED', finalRating: '4.10', pending: null, revisions: [{ state: 'CONFIRMED', approvalLevels: 0 }] });
    expect(done.decisions.map((d) => [d.step, d.decision])).toEqual([[1, 'APPROVE']]);
    expect((await h.one<{ state: string }>(`select bt.state from appraisal a join business_transaction bt on bt.id = a.transaction_id where a.id = $1`, [id])).state).toBe('APPROVED');
    // The route's reviewer step applies only where the revision pinned a reviewer level (0177).
    const steps = (
      await h.db.query<{ sequence: number; condition_code: string | null }>(
        `select s.sequence, s.condition_code from workflow_step s join workflow_definition d on d.company_id = s.company_id and d.id = s.workflow_id
          where d.company_id = $1 and d.kind = 'appraisal' and d.active and (d.effective_to is null or d.effective_to > now()) order by s.sequence`,
        [A.id],
      )
    ).rows;
    expect(steps).toEqual([
      { sequence: 1, condition_code: null },
      { sequence: 2, condition_code: 'APPRAISAL_REVIEWER_LEVEL' },
    ]);

    // F1 "One reviewer step is the default" (BR-013 two-level manager and reviewer): level 2 stays pending until the reviewer decides.
    const standard = await openCycle(h, w);
    expect(standard.approvalLevels).toBe(1);
    const f = await appraisee('Synthetic Reviewed Level');
    const id2 = (await enrol(h, w.hr, standard.id, f.id)).id;
    await selfAssess(h, f.actor, id2, [3, 3, 3]);
    expect(await rate(h, w.manager, id2, [3, 4, 5])).toMatchObject({ state: 'IN_REVIEW', pendingStep: 2 });
    expect(await staffView(h, w.hr, id2)).toMatchObject({ state: 'IN_REVIEW', finalRating: null, pending: { step: 2, stage: 'REVIEW', level: 1 } });
    expect(await confirm(h, w.rev1, id2)).toMatchObject({ state: 'APPROVED' });
    expect(await staffView(h, w.hr, id2)).toMatchObject({ finalRating: '4.10' });
  });

  it('FR-043 / DF04: each reviewer level confirms with its own overall score, kept apart from the self and manager ratings; the final rating stays the manager result (F1)', async () => {
    const cycle = await openCycle(h, w, { approvalLevels: 2 });
    const e = await appraisee('Synthetic Scored');
    const id = (await enrol(h, w.hr, cycle.id, e.id)).id;
    await selfAssess(h, e.actor, id, [5, 5, 5]);
    // The rater gives no reviewer score.
    const t1 = (await taskOf(h, w.manager, id))!;
    const saved = await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t1.taskId}/rating`, {
      entries: t1.appraisal!.goals.map((g, i) => ({ goalId: g.id, score: [2, 3, 4][i] })),
      expectedVersion: t1.appraisal!.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await decide(h, w.manager, t1.taskId, { decision: 'APPROVE', reviewerScore: 3 })).json().error).toBe('REVIEWER_SCORE_NOT_USED');
    expect((await decide(h, w.manager, t1.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'IN_REVIEW', pendingStep: 2 });

    // Database rule: a score is part of the scorer's own confirmation, never written against the rater's decision, even while
    // the rated revision waits for its level-1 score.
    const rateDecision = await h.one<{ id: string; revision_id: string }>(
      `select d.id, r.id as revision_id from approval_decision d join approval_task t on t.id = d.task_id join workflow_step s on s.id = t.step_id
         join approval_instance i on i.id = t.instance_id join appraisal a on a.transaction_id = i.transaction_id
         join appraisal_revision r on r.appraisal_id = a.id and r.revision = 1
        where a.id = $1 and s.sequence = 1`,
      [id],
    );
    const forge = (decisionId: string, level: number, by: string) =>
      h.db.query(`insert into appraisal_review_score (company_id, appraisal_id, revision_id, level, score, decision_id, created_by) values ($1, $2, $3, $4, 1, $5, $6)`, [
        A.id,
        id,
        rateDecision.revision_id,
        level,
        decisionId,
        by,
      ]);
    await expect(forge(rateDecision.id, 1, w.manager.user)).rejects.toMatchObject({ code: '23514' });

    // A confirmation carries the score, an integer 1..5; a return carries none.
    const t2 = (await taskOf(h, w.rev1, id))!;
    expect((await decide(h, w.rev1, t2.taskId, { decision: 'APPROVE' })).json().error).toBe('REVIEWER_SCORE_REQUIRED');
    for (const bad of [0, 6, 3.5]) expect((await decide(h, w.rev1, t2.taskId, { decision: 'APPROVE', reviewerScore: bad })).statusCode).toBe(400);
    expect((await decide(h, w.rev1, t2.taskId, { decision: 'RETURN', employeeMessage: 'Synthetic: add detail', reviewerScore: 2 })).json().error).toBe('REVIEWER_SCORE_NOT_USED');
    expect(await confirm(h, w.rev1, id, 5)).toMatchObject({ state: 'IN_REVIEW', pendingStep: 3 });

    // One score per revision and level; append-only.
    const level1 = await h.one<{ decision_id: string }>(`select decision_id from appraisal_review_score where appraisal_id = $1 and level = 1`, [id]);
    await expect(forge(level1.decision_id, 1, w.rev1.user)).rejects.toMatchObject({ code: '23505' });
    await expect(h.db.query(`update appraisal_review_score set score = 1 where appraisal_id = $1`, [id])).rejects.toMatchObject({ code: '23514' });

    expect(await confirm(h, w.rev2, id, 2)).toMatchObject({ state: 'APPROVED' });
    // (30x2 + 30x3 + 40x4) / 100 = 3.10, whatever the reviewers scored.
    const full = await staffView(h, w.hr, id);
    expect(full).toMatchObject({ finalRating: '3.10' });
    expect(full.revisions[0]).toMatchObject({
      selfEntry: { entries: [{ score: 5 }, { score: 5 }, { score: 5 }] },
      managerRating: { weightedResult: '3.10', overallRating: null, entries: [{ score: 2 }, { score: 3 }, { score: 4 }] },
      reviewerScores: [
        { level: 1, score: 5 },
        { level: 2, score: 2 },
      ],
    });
    // Confidential (DF02): absent without the rating group and on one's own appraisal, and never in the audit trail.
    expect((await staffView(h, w.hrPlain, id)).revisions[0]).not.toHaveProperty('reviewerScores');
    expect((await ownView(h, e.actor, id)).revisions[0]).not.toHaveProperty('reviewerScores');
    expect((await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and (after_values::text like '%reviewerScore%' or after_values::text like '%score%')`, [id])).n).toBe(0);
  });

  it('FR-041 / F1: where the cycle reviews KRAs (the default), goals take effect only once someone other than their setter reviews them; a changed set starts unreviewed', async () => {
    // I-77 item 3: a new cycle reviews goals unless it says otherwise.
    const created = await h.call(w.hr, 'POST', '/v1/appraisal-cycles', cycleBody({ reviewDueOn: addDays(w.today, 20) }));
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ goalReviewRequired: true, ratingMode: 'FORMULA', approvalLevels: 1 });
    const cycleId = created.json().id as string;
    const e = await appraisee('Synthetic Goal Review');
    let v = (await enrol(h, w.hr, cycleId, e.id)) as RulesView;
    expect(v).toMatchObject({ taskStatus: 'AWAITING_GOAL_REVIEW', goalReview: { required: true, reviewed: false, setBy: { userId: w.hr.user }, reviewedBy: null } });

    // Not yet in effect: the employee can neither enter nor submit against them, and sees no setter or reviewer.
    const own = (await ownView(h, e.actor, v.id)) as RulesView;
    expect(own).toMatchObject({ taskStatus: 'AWAITING_GOAL_REVIEW', goalReview: { required: true, reviewed: false } });
    expect(own.goalReview).not.toHaveProperty('setBy');
    expect((await h.call(e.actor, 'PUT', `/v1/me/appraisals/${v.id}/self-entry`, { entries: [{ goalId: own.goals[0]!.id, score: 3 }], expectedVersion: own.version })).json().error).toBe('GOALS_NOT_REVIEWED');
    expect((await h.call(e.actor, 'POST', `/v1/me/appraisals/${v.id}/submit`, { expectedVersion: own.version })).json().error).toBe('GOALS_NOT_REVIEWED');
    const waiting = (await h.call(w.manager, 'GET', `/v1/appraisals?cycleId=${cycleId}&stateGroup=AWAITING_GOAL_REVIEW`)).json().items as { id: string; taskStatus: string }[];
    expect(waiting).toEqual([expect.objectContaining({ id: v.id, taskStatus: 'AWAITING_GOAL_REVIEW' })]);

    // KRA Review: the setter never reviews their own set; the employee holds no goal-setting duty.
    expect((await reviewGoals(w.hr, v.id, v.version)).json().error).toBe('GOAL_REVIEW_NOT_INDEPENDENT');
    expect((await reviewGoals(e.actor, v.id, v.version)).statusCode).toBe(403);
    const reviewed = await reviewGoals(w.manager, v.id, v.version);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    v = reviewed.json() as RulesView;
    expect(v).toMatchObject({ taskStatus: 'AWAITING_SELF_ENTRY', goalReview: { reviewed: true, reviewedBy: { userId: w.manager.user } } });
    expect((await reviewGoals(w.hrPlain, v.id, v.version)).json().error).toBe('GOALS_ALREADY_REVIEWED');

    // A changed set is its new setter's and starts unreviewed; now HR, not the manager, reviews it.
    const changed = await h.call(w.manager, 'PUT', `/v1/appraisals/${v.id}/goals`, { goals: [{ sequence: 1, description: 'Synthetic single goal', weight: 100 }], expectedVersion: v.version });
    expect(changed.statusCode, changed.body).toBe(200);
    v = changed.json() as RulesView;
    expect(v).toMatchObject({ taskStatus: 'AWAITING_GOAL_REVIEW', goalReview: { reviewed: false, setBy: { userId: w.manager.user }, reviewedBy: null } });
    expect((await reviewGoals(w.manager, v.id, v.version)).json().error).toBe('GOAL_REVIEW_NOT_INDEPENDENT');
    v = (await reviewGoals(w.hrPlain, v.id, v.version)).json() as RulesView;
    expect(v.goalReview).toMatchObject({ reviewed: true, reviewedBy: { userId: w.hrPlain.user } });
    // In effect: the employee enters and submits as usual.
    expect(await selfAssess(h, e.actor, v.id, [4])).toMatchObject({ state: 'SUBMITTED' });

    // Only a complete set is reviewed, and only where the cycle reviews goals.
    const partial = await enrol(h, w.hr, cycleId, (await appraisee('Synthetic Partial Goals')).id, [{ sequence: 1, description: 'Synthetic part', weight: 60 }]);
    expect((await reviewGoals(w.manager, partial.id, partial.version)).json()).toMatchObject({ error: 'WEIGHT_TOTAL_NOT_100', details: { total: 60 } });
    const unreviewed = await openCycle(h, w);
    const plain = (await enrol(h, w.hr, unreviewed.id, (await appraisee('Synthetic No Goal Review')).id)) as RulesView;
    expect(plain).toMatchObject({ taskStatus: 'AWAITING_SELF_ENTRY', goalReview: { required: false, reviewed: false } });
    expect((await reviewGoals(w.manager, plain.id, plain.version)).json().error).toBe('GOAL_REVIEW_NOT_REQUIRED');
  });

  it('FR-041 KRA review holds in the database: maker and checker differ, reviewed goals are fixed, unreviewed goals are never submitted against', async () => {
    const cycle = await openCycle(h, w, { goalReviewRequired: true });
    const e = await appraisee('Synthetic Goal Review Rules');
    const v = await enrol(h, w.hr, cycle.id, e.id);
    const setReviewer = (user: string) => h.db.query(`update appraisal set goals_reviewed_by = $2, goals_reviewed_at = now() where id = $1`, [v.id, user]);
    // Neither the setter nor the appraised employee is ever recorded as the reviewer.
    await expect(setReviewer(w.hr.user)).rejects.toMatchObject({ code: '23514' });
    await expect(setReviewer(e.actor.user)).rejects.toMatchObject({ code: '23514' });
    // Nobody but the recorded setter changes the set.
    await expect(h.db.query(`update appraisal_item set description = 'Synthetic forged goal', updated_by = $2 where appraisal_id = $1 and sequence = 1`, [v.id, w.manager.user])).rejects.toMatchObject({
      code: '23514',
    });
    // The self-entry is not submitted against unreviewed goals, even directly.
    await expect(
      h.db.query(`update appraisal_revision set state = 'SUBMITTED', submitted_by = $2, submitted_at = now(), approval_levels = 1, updated_by = $2 where appraisal_id = $1`, [v.id, e.actor.user]),
    ).rejects.toMatchObject({ code: '23514' });
    // Reviewed goals are fixed; a review is undone only by a new goal set.
    expect((await reviewGoals(w.manager, v.id, v.version)).statusCode).toBe(200);
    await expect(h.db.query(`update appraisal_item set description = 'Synthetic late change', updated_by = $2 where appraisal_id = $1 and sequence = 1`, [v.id, w.hr.user])).rejects.toMatchObject({
      code: '23514',
    });
    await expect(h.db.query(`update appraisal set goals_reviewed_by = null, goals_reviewed_at = null where id = $1`, [v.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('FR-041: an upload awaits the employee submission without KRA review (mode 0), the review of someone other than the importer with it (mode 1), and is never treated as reviewed (mode 2)', async () => {
    const reviewing = await openCycle(h, w, { goalReviewRequired: true });
    const plainCycle = await openCycle(h, w);
    const zero = await appraisee('Synthetic Upload Mode Zero');
    const one = await appraisee('Synthetic Upload Mode One');
    const lines = [
      'cycleCode,employeeCode,sequence,description,target,weight',
      `${plainCycle.code},${await codeOf(zero.id)},1,Synthetic uploaded goal,,100`,
      `${reviewing.code},${await codeOf(one.id)},1,Synthetic uploaded goal,,100`,
    ];
    const job = await h.call(w.hr, 'POST', '/v1/appraisal-goal-imports', { fileName: 'goals.csv', contentBase64: Buffer.from(`${lines.join('\n')}\n`).toString('base64'), idempotencyKey: key() });
    expect(job.statusCode, job.body).toBe(201);
    expect((await h.call(w.hr, 'POST', `/v1/appraisal-goal-imports/${job.json().id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 2 });
    const uploaded = async (employeeId: string) => {
      const id = ((await h.call(w.hr, 'GET', `/v1/appraisals?employeeId=${employeeId}`)).json().items as { id: string }[])[0]!.id;
      return (await staffView(h, w.hr, id)) as RulesView;
    };
    // Mode 0: waiting for the employee.
    const a0 = await uploaded(zero.id);
    expect(a0).toMatchObject({ source: 'UPLOAD', state: 'DRAFT', taskStatus: 'AWAITING_SELF_ENTRY', goalReview: { required: false } });
    expect(await selfAssess(h, zero.actor, a0.id, [3])).toMatchObject({ state: 'SUBMITTED' });
    // Mode 1: waiting for a review the importer cannot give; the manager gives it, then the employee goes on.
    const a1 = await uploaded(one.id);
    expect(a1).toMatchObject({ source: 'UPLOAD', state: 'DRAFT', taskStatus: 'AWAITING_GOAL_REVIEW', goalReview: { reviewed: false, setBy: { userId: w.hr.user } } });
    expect((await reviewGoals(w.hr, a1.id, a1.version)).json().error).toBe('GOAL_REVIEW_NOT_INDEPENDENT');
    expect((await reviewGoals(w.manager, a1.id, a1.version)).json()).toMatchObject({ taskStatus: 'AWAITING_SELF_ENTRY' });
    expect(await selfAssess(h, one.actor, a1.id, [3])).toMatchObject({ state: 'SUBMITTED' });
  });

  it('FR-042 / BR-014: in manual mode the manager enters a permitted overall rating that becomes the final rating; formula mode produces the F1 weighted score', async () => {
    const manual = await openCycle(h, w, { ratingMode: 'MANUAL' });
    expect(manual.ratingMode).toBe('MANUAL');
    const e = await appraisee('Synthetic Manual Rating');
    const id = (await enrol(h, w.hr, manual.id, e.id)).id;
    await selfAssess(h, e.actor, id, [4, 4, 4]);
    const t1 = (await taskOf(h, w.manager, id))!;
    const entries = t1.appraisal!.goals.map((g, i) => ({ goalId: g.id, score: [2, 3, 4][i] }));
    // Permitted ratings: integers 1 to 5 (the F1 scale).
    for (const bad of [0, 6, 4.5]) {
      expect((await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t1.taskId}/rating`, { entries, overallRating: bad, expectedVersion: t1.appraisal!.version })).statusCode).toBe(400);
    }
    const saved = await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t1.taskId}/rating`, { entries, expectedVersion: t1.appraisal!.version });
    expect(saved.statusCode, saved.body).toBe(200);
    // Every goal is still scored, and the rating is not submitted without the overall rating.
    expect((await decide(h, w.manager, t1.taskId, { decision: 'APPROVE' })).json().error).toBe('OVERALL_RATING_REQUIRED');
    const overall = await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t1.taskId}/rating`, { entries: [], overallRating: 5, expectedVersion: (saved.json() as View).version });
    expect(overall.statusCode, overall.body).toBe(200);
    expect((overall.json() as View).revisions[0]).toMatchObject({ managerRating: { overallRating: 5, weightedResult: null } });
    expect((await decide(h, w.manager, t1.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'IN_REVIEW' });
    expect(await confirm(h, w.rev1, id)).toMatchObject({ state: 'APPROVED' });
    // The overall rating is the final rating; the F1 weighted result, (30x2 + 30x3 + 40x4) / 100 = 3.10, is kept beside it.
    expect(await staffView(h, w.hr, id)).toMatchObject({ finalRating: '5.00', revisions: [{ managerRating: { weightedResult: '3.10', overallRating: 5 } }] });
    expect(JSON.stringify(await ownView(h, e.actor, id))).not.toMatch(/overallRating|finalRating|\b5\.00\b/);

    // Formula mode (the default): there is no overall rating, and the weighted manager result is the final rating.
    const formula = await openCycle(h, w);
    expect(formula.ratingMode).toBe('FORMULA');
    const f = await appraisee('Synthetic Formula Rating');
    const fid = (await enrol(h, w.hr, formula.id, f.id)).id;
    await selfAssess(h, f.actor, fid, [4, 4, 4]);
    const ft = (await taskOf(h, w.manager, fid))!;
    expect((await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${ft.taskId}/rating`, { entries: [], overallRating: 4, expectedVersion: ft.appraisal!.version })).json().error).toBe('OVERALL_RATING_NOT_USED');
    await rate(h, w.manager, fid, [2, 3, 4]);
    await confirm(h, w.rev1, fid);
    expect(await staffView(h, w.hr, fid)).toMatchObject({ finalRating: '3.10', revisions: [{ managerRating: { weightedResult: '3.10', overallRating: null } }] });

    // The mode is fixed once an appraisal of the cycle has been submitted (API and database).
    const c = (await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${manual.id}`)).json();
    const update = await h.call(w.hr, 'PUT', `/v1/appraisal-cycles/${manual.id}`, { name: c.name, approvalLevels: 1, windows: openWindows(w.today), ratingMode: 'FORMULA', expectedVersion: c.version });
    expect(update.json().error).toBe('RULES_FIXED');
    await expect(h.db.query(`update appraisal_cycle set rating_mode = 'FORMULA' where id = $1`, [manual.id])).rejects.toMatchObject({ code: '23514' });
    // In the database a manual rating carries the overall rating and a formula one never does.
    const rated = async (cycleId: string, name: string) => {
      const p = await appraisee(name);
      const pid = (await enrol(h, w.hr, cycleId, p.id)).id;
      await selfAssess(h, p.actor, pid, [3, 3, 3]);
      return pid;
    };
    const toRated = (pid: string, overall: number | null) =>
      h.db.query(
        `update appraisal_revision set state = 'RATED', rated_by = $2, rated_at = now(), weighted_result = 3, manager_overall_rating = $3, updated_by = $2 where appraisal_id = $1 and revision = 1`,
        [pid, w.manager.user, overall],
      );
    await expect(toRated(await rated(manual.id, 'Synthetic Manual Without Overall'), null)).rejects.toMatchObject({ code: '23514' });
    await expect(toRated(await rated(formula.id, 'Synthetic Formula With Overall'), 3)).rejects.toMatchObject({ code: '23514' });
  });

  it('I-40 item 6 / F2 "Overdue review tasks": rating tasks fall due when the rating window closes, reviewer tasks on the review due date; overdue is a due date before today (DF17)', async () => {
    // The review due date is required with reviewer levels and cannot fall before the rating window closes.
    expect((await h.call(w.hr, 'POST', '/v1/appraisal-cycles', cycleBody())).json()).toMatchObject({ error: 'REVIEW_DUE_REQUIRED', details: { missing: ['reviewDueOn'] } });
    expect((await h.call(w.hr, 'POST', '/v1/appraisal-cycles', cycleBody({ reviewDueOn: addDays(w.today, 19) }))).json()).toMatchObject({
      error: 'REVIEW_DUE_BEFORE_RATING',
      details: { ratingClosesOn: addDays(w.today, 20) },
    });
    const cycle = await openCycle(h, w, { approvalLevels: 2, reviewDueOn: addDays(w.today, 22) });
    const e = await appraisee('Synthetic Due Dates');
    const id = (await enrol(h, w.hr, cycle.id, e.id)).id;
    await selfAssess(h, e.actor, id, [3, 3, 3]);
    // The rating task is due when the rating window closes, or on the last day of a later exception for this appraisal.
    expect(await taskOf(h, w.manager, id)).toMatchObject({ step: 1, dueOn: addDays(w.today, 20), overdue: false });
    expect((await h.call(w.hrPlain, 'POST', `/v1/appraisals/${id}/window-exceptions`, { stage: 'MANAGER_RATING', validUntil: addDays(w.today, 25), reason: 'Synthetic' })).statusCode).toBe(201);
    expect(await taskOf(h, w.manager, id)).toMatchObject({ dueOn: addDays(w.today, 25) });
    await rate(h, w.manager, id, [3, 3, 3]);
    // A reviewer task is due on the cycle's review due date.
    expect(await taskOf(h, w.rev1, id)).toMatchObject({ step: 2, level: 1, dueOn: addDays(w.today, 22), overdue: false });
    const dueAt = await h.one<{ d: string }>(
      `select to_char(hrms_business_date(t.company_id, t.due_at), 'YYYY-MM-DD') as d from approval_task t join approval_instance i on i.id = t.instance_id
         join appraisal a on a.transaction_id = i.transaction_id where a.id = $1 and t.state = 'PENDING'`,
      [id],
    );
    expect(dueAt.d).toBe(addDays(w.today, 22));

    // The schedule moves into the past: the pending task follows, and is overdue from the day after its due date.
    const past = {
      goalSetting: { opensOn: addDays(w.today, -30), closesOn: addDays(w.today, -3) },
      selfEntry: { opensOn: addDays(w.today, -30), closesOn: addDays(w.today, -2) },
      managerRating: { opensOn: addDays(w.today, -30), closesOn: addDays(w.today, -1) },
    };
    const before = (await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycle.id}`)).json();
    const moved = await h.call(w.hr, 'PUT', `/v1/appraisal-cycles/${cycle.id}`, { name: before.name, approvalLevels: 2, windows: past, reviewDueOn: addDays(w.today, -1), expectedVersion: before.version });
    expect(moved.statusCode, moved.body).toBe(200);
    const late = (await taskOf(h, w.rev1, id))!;
    expect(late).toMatchObject({ dueOn: addDays(w.today, -1), overdue: true });
    const overdueList = (await h.call(w.rev1, 'GET', '/v1/appraisal-tasks/mine?overdue=true')).json().items as { taskId: string }[];
    expect(overdueList.map((t) => t.taskId)).toContain(late.taskId);
    // The widget counts exactly that list (BR-045), and the DF17 priority task list flags the same task.
    const grant = await resolveAccess(h.db, { userId: w.rev1.user, companyId: A.id, assignmentId: w.rev1.assignment, resource: 'appraisal', action: 'read', fieldGroups: ['operational'] });
    if (!grant.allowed) throw new Error(grant.reason);
    expect(await APPRAISAL_METRICS.APPRAISAL_REVIEW_TASKS_OVERDUE!(h.db, grant)).toEqual({ status: 'OK', value: overdueList.length });
    const priority = (await h.call(w.rev1, 'GET', '/v1/dashboard/tasks')).json().items as { taskId: string; overdue: boolean }[];
    expect(priority.find((t) => t.taskId === late.taskId)).toMatchObject({ overdue: true });

    // A due date is not a window: the late reviewer still confirms; the second level, opened now, is due on the same date.
    expect(await confirm(h, w.rev1, id)).toMatchObject({ pendingStep: 3 });
    expect(await taskOf(h, w.rev2, id)).toMatchObject({ step: 3, level: 2, dueOn: addDays(w.today, -1), overdue: true });
    // HR moves the review due date on: the pending task follows and is no longer overdue.
    const again = (await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycle.id}`)).json();
    expect((await h.call(w.hr, 'PUT', `/v1/appraisal-cycles/${cycle.id}`, { name: again.name, approvalLevels: 2, windows: past, reviewDueOn: addDays(w.today, 3), expectedVersion: again.version })).statusCode).toBe(200);
    expect(await taskOf(h, w.rev2, id)).toMatchObject({ dueOn: addDays(w.today, 3), overdue: false });
    expect(((await h.call(w.rev2, 'GET', '/v1/appraisal-tasks/mine?overdue=true')).json().items as { taskId: string }[]).map((t) => t.taskId)).not.toContain((await taskOf(h, w.rev2, id))!.taskId);
  });
});
