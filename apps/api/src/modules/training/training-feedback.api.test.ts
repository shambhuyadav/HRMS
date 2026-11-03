// Training feedback over HTTP (FR-050 acceptance "feedback reports reconcile to participants and show missing responses
// distinctly"; F1 "Feedback score 1..5 after completion, comments restricted. Coordinator sees plans and operational
// completion, no protected feedback narratives"; DB074; CI14; H1/BR-053; H3 TN17 "feedback entry"; DF02; DF09; F2).
// Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError } from '../../../../../db/tests/fixtures.js';
import type { Queryable } from '../../db/queryable.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { BASELINE_ROLES } from '../access/baseline.js';
import { isModuleActive } from '../registry.js';
import { ROW_LIMIT } from './common.js';
import { exportFeedback } from './feedback.js';
import { TRAINING_METRICS } from './metrics.js';
import { act, addDays, advance, businessDate, newPlan, nominated, person, type Plan } from './training.fixtures.js';

type Answer = { questionCode: string; score: number | null; comment?: string | null };
type RegisterItem = { participantId: string; employeeId: string; state: string; feedbackStatus: string; answers: Answer[] };

describe.runIf(isModuleActive('training'))('training feedback (FR-050, F1, H3 TN17)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let hrComments: TestActor; // HR Administrator with the approved confidential comment grant
  let coordinator: TestActor;
  let filteredHr: TestActor;
  let manager: TestActor;
  let owner: string;
  let today: string;
  const people: { emp: string; actor: TestActor }[] = [];

  /** An active employee with an Employee OWN assignment (optionally in the finance department). */
  const member = async (opts: { departmentId?: string } = {}) => {
    const emp = await person(h, A, hr, { name: 'Fen Feedback (synthetic)', ...opts });
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: emp });
    people.push({ emp, actor });
    return { emp, actor };
  };
  /** A past session with the given questions; returns the plan. */
  const pastPlan = (body: Record<string, unknown> = {}) =>
    newPlan(h, coordinator, { startDate: addDays(today, -4), endDate: addDays(today, -2), ownerEmployeeId: owner, feedbackQuestionCodes: ['OVERALL', 'TRAINER'], ...body });
  const completed = async (p: Plan, emps: string[]) => {
    const ids = await nominated(h, coordinator, p.id, emps);
    await advance(h, coordinator, p.id, ids, ['CONFIRM', 'MARK_ATTENDED', 'COMPLETE']);
    return ids;
  };
  const give = (a: TestActor, participantId: string, answers: Answer[]) => h.call(a, 'POST', '/v1/me/training-feedback', { participantId, answers });
  const register = async (a: TestActor, planId: string, query = '') => {
    const res = await h.call(a, 'GET', `/v1/training-plans/${planId}/feedback${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: RegisterItem[]; commentsIncluded: boolean; questions: { code: string }[] };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    hrComments = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['training_feedback.read.comment'] });
    coordinator = await h.actor(A, 'TRAINING_COORDINATOR');
    filteredHr = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    owner = await person(h, A, hr, { name: 'Olu Owner (synthetic)' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await person(h, A, hr, { name: 'Mo Manager (synthetic)' }) });
    // A second controlled question (DF04: companies add their own definitions).
    await h.db.query(`insert into reference_value (company_id, category, code, label, active) values ($1, 'TRAINING_FEEDBACK_QUESTION', 'TRAINER', 'Trainer knowledge (synthetic)', true)`, [
      A.id,
    ]);
    today = await businessDate(h, A);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('opens feedback after completion, to the participant only (F1; H3 TN17)', async () => {
    const p = await pastPlan();
    const [done, attended] = [await member(), await member()];
    const [doneId] = await completed(p, [done.emp]);
    const [attendedId] = await nominated(h, coordinator, p.id, [attended.emp]);
    await advance(h, coordinator, p.id, [attendedId!], ['CONFIRM', 'MARK_ATTENDED']);
    const answers: Answer[] = [
      { questionCode: 'OVERALL', score: 4 },
      { questionCode: 'TRAINER', score: 5 },
    ];
    expect((await give(attended.actor, attendedId!, answers)).json().error).toBe('FEEDBACK_NOT_OPEN');
    // Someone else's participation reads as missing; other contexts cannot give feedback at all.
    expect((await give(attended.actor, doneId!, answers)).statusCode).toBe(404);
    for (const who of [coordinator, hr, manager]) expect((await give(who, doneId!, answers)).statusCode).toBe(403);

    const mine = (await h.call(done.actor, 'GET', '/v1/me/training-feedback')).json().items as Record<string, unknown>[];
    expect(mine).toEqual([
      expect.objectContaining({
        participantId: doneId,
        status: 'MISSING',
        submittedAt: null,
        plan: expect.objectContaining({ id: p.id, code: p.code, view: 'PAST' }),
        questions: [
          { code: 'OVERALL', label: 'Overall rating of the training', position: 1 },
          { code: 'TRAINER', label: 'Trainer knowledge (synthetic)', position: 2 },
        ],
        answers: [],
      }),
    ]);
    // A participation that is not completed is not offered for feedback.
    expect((await h.call(attended.actor, 'GET', '/v1/me/training-feedback')).json().items).toEqual([]);
  });

  it('takes a score 1..5 and an optional comment per question, once; a replay returns it and a change is refused (F1, DF04, DB074)', async () => {
    const p = await pastPlan();
    const m = await member();
    const [id] = await completed(p, [m.emp]);
    const bad = async (answers: Answer[]) => (await give(m.actor, id!, answers)).json();
    expect(await bad([{ questionCode: 'OVERALL', score: 0 }, { questionCode: 'TRAINER', score: 3 }])).toMatchObject({ error: 'INVALID_SCORE', details: { questionCode: 'OVERALL' } });
    expect((await bad([{ questionCode: 'OVERALL', score: 6 }, { questionCode: 'TRAINER', score: 3 }])).error).toBe('INVALID_SCORE');
    expect(await bad([{ questionCode: 'OVERALL', score: 4 }])).toMatchObject({ error: 'ANSWERS_MISMATCH', details: { expected: ['OVERALL', 'TRAINER'] } });
    expect((await bad([{ questionCode: 'OVERALL', score: 4 }, { questionCode: 'OVERALL', score: 3 }])).error).toBe('ANSWERS_MISMATCH');
    expect((await bad([{ questionCode: 'OVERALL', score: 4 }, { questionCode: 'NOT_ASKED', score: 3 }])).error).toBe('ANSWERS_MISMATCH');
    // F1 "feedback score 1..5"; DF04 "feedback score 1..5 and optional restricted comment": a comment never replaces the score.
    expect(await bad([{ questionCode: 'OVERALL', score: 4 }, { questionCode: 'TRAINER', score: null, comment: 'Only a comment (synthetic)' }])).toMatchObject({
      error: 'SCORE_REQUIRED',
      details: { questionCode: 'TRAINER' },
    });
    expect((await give(m.actor, id!, [{ questionCode: 'OVERALL', score: 4 }, { questionCode: 'TRAINER' } as Answer])).json().error).toBe('SCORE_REQUIRED');

    const answers: Answer[] = [
      { questionCode: 'OVERALL', score: 4, comment: 'Very practical, synthetic narrative A' },
      { questionCode: 'TRAINER', score: 3, comment: 'Could slow down, synthetic narrative B' },
    ];
    const given = await give(m.actor, id!, answers);
    expect(given.statusCode, given.body).toBe(201);
    expect(given.json()).toMatchObject({
      participantId: id,
      status: 'RESPONDED',
      replayed: false,
      answers: [
        { questionCode: 'OVERALL', score: 4, comment: 'Very practical, synthetic narrative A' },
        { questionCode: 'TRAINER', score: 3, comment: 'Could slow down, synthetic narrative B' },
      ],
    });
    // The same submission again is a replay; a different one is refused (feedback is immutable).
    const replay = await give(m.actor, id!, answers);
    expect(replay.statusCode).toBe(200);
    expect(replay.json().replayed).toBe(true);
    expect((await give(m.actor, id!, [{ questionCode: 'OVERALL', score: 1 }, { questionCode: 'TRAINER', score: 1 }])).json().error).toBe('FEEDBACK_ALREADY_SUBMITTED');
    expect((await h.call(m.actor, 'GET', '/v1/me/training-feedback')).json().items[0]).toMatchObject({ status: 'RESPONDED', answers: given.json().answers });

    // The trail records the scores and which answers carry a comment, never the comment.
    const trail = await h.one<{ after_values: Record<string, unknown> }>(
      `select after_values from audit_event where company_id = $1 and resource_code = 'training_feedback' and action = 'SUBMIT' and record_key = $2`,
      [A.id, id],
    );
    expect(trail.after_values).toEqual({ operational: { planId: p.id, scores: { OVERALL: 4, TRAINER: 3 }, commented: ['OVERALL', 'TRAINER'] } });
    const anywhere = await h.one<{ n: number }>(
      `select count(*)::int as n from (select after_values::text as t from audit_event where company_id = $1 union all select payload::text from outbox_event where company_id = $1) x
        where x.t like '%synthetic narrative%'`,
      [A.id],
    );
    expect(anywhere.n).toBe(0);
    // Once feedback exists the plan's questions are fixed.
    expect((await h.call(coordinator, 'PATCH', `/v1/training-plans/${p.id}`, { expectedVersion: 1, feedbackQuestionCodes: ['OVERALL'] })).json().error).toBe('QUESTIONS_FIXED');

    // The database: immutable feedback, completion first, the participant only, every question once (at commit).
    await expectSqlError(h.db.query(`update training_feedback set score = 5 where participant_id = $1`, [id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`delete from training_feedback where participant_id = $1`, [id]), CHECK_VIOLATION);
    const other = await member();
    const [notDone] = await nominated(h, coordinator, p.id, [other.emp]);
    const [otherDone] = await completed(p, [(await member()).emp]);
    const question = (await h.one<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'TRAINING_FEEDBACK_QUESTION' and code = 'OVERALL'`, [A.id])).id;
    const insert = (participantId: string, employeeId: string, by: string) =>
      h.db.query(
        `insert into training_feedback (company_id, participant_id, plan_id, employee_id, question_id, score, submitted_by) values ($1, $2, $3, $4, $5, 3, $6)`,
        [A.id, participantId, p.id, employeeId, question, by],
      );
    await expectSqlError(insert(notDone!, other.emp, other.actor.user), CHECK_VIOLATION);
    const otherDoneEmp = people.at(-1)!;
    await expectSqlError(insert(otherDone!, otherDoneEmp.emp, other.actor.user), CHECK_VIOLATION);
    // Only one of the two questions: refused when the statement commits.
    await expectSqlError(insert(otherDone!, otherDoneEmp.emp, otherDoneEmp.actor.user), CHECK_VIOLATION);
    // An answer without a score (F1, DF04).
    await expectSqlError(
      h.db.query(
        `insert into training_feedback (company_id, participant_id, plan_id, employee_id, question_id, score, response, submitted_by) values ($1, $2, $3, $4, $5, null, 'Synthetic', $6)`,
        [A.id, otherDone, p.id, otherDoneEmp.emp, question, otherDoneEmp.actor.user],
      ),
      '23502',
    );
    // CI14: the participation must belong to the feedback's plan.
    const elsewhere = await pastPlan();
    await expectSqlError(
      h.db.query(
        `insert into training_feedback (company_id, participant_id, plan_id, employee_id, question_id, score, submitted_by) values ($1, $2, $3, $4, $5, 3, $6)`,
        [A.id, otherDone, elsewhere.id, otherDoneEmp.emp, question, otherDoneEmp.actor.user],
      ),
      '23503',
    );
  });

  it('records one feedback when the same participant submits twice at once', async () => {
    const p = await pastPlan();
    const [a, b] = [await member(), await member()];
    const [aId, bId] = await completed(p, [a.emp, b.emp]);
    const same: Answer[] = [
      { questionCode: 'OVERALL', score: 5 },
      { questionCode: 'TRAINER', score: 4 },
    ];
    const twice = await Promise.all([give(a.actor, aId!, same), give(a.actor, aId!, same)]);
    expect(twice.map((r) => r.statusCode).sort()).toEqual([200, 201]);
    const differing = await Promise.all([give(b.actor, bId!, same), give(b.actor, bId!, [{ questionCode: 'OVERALL', score: 1 }, { questionCode: 'TRAINER', score: 1 }])]);
    expect(differing.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const rows = await h.one<{ n: number }>(`select count(*)::int as n from training_feedback where participant_id = any($1::uuid[])`, [[aId, bId]]);
    expect(rows.n).toBe(4);
  });

  it('keeps comments restricted: the coordinator and HR without the approved grant see scores and status only (F1, DF02)', async () => {
    const p = await pastPlan();
    const m = await member();
    const [id] = await completed(p, [m.emp]);
    expect((await give(m.actor, id!, [{ questionCode: 'OVERALL', score: 2, comment: 'Room too cold, synthetic narrative C' }, { questionCode: 'TRAINER', score: 3 }])).statusCode).toBe(201);

    for (const who of [coordinator, hr]) {
      const seen = await register(who, p.id);
      expect(seen.commentsIncluded).toBe(false);
      expect(seen.items.find((i) => i.participantId === id)).toMatchObject({ feedbackStatus: 'RESPONDED', answers: [{ questionCode: 'OVERALL', score: 2 }, { questionCode: 'TRAINER', score: 3 }] });
      expect(JSON.stringify(seen)).not.toContain('narrative C');
      expect(seen.items.find((i) => i.participantId === id)!.answers[0]).not.toHaveProperty('comment');
      expect(JSON.stringify((await h.call(who, 'GET', `/v1/training-plans/${p.id}/feedback-summary`)).json())).not.toContain('narrative C');
    }
    // An eligible HR Administrator assignment with the approved comment grant reads it.
    const granted = await register(hrComments, p.id);
    expect(granted.commentsIncluded).toBe(true);
    expect(granted.items.find((i) => i.participantId === id)!.answers[0]).toEqual({ questionCode: 'OVERALL', score: 2, comment: 'Room too cold, synthetic narrative C' });
    // The coordinator role is not eligible for a confidential group even if its role and allowlist held it (C1).
    expect(BASELINE_ROLES.find((r) => r.code === 'TRAINING_COORDINATOR')!.ceiling).not.toContain('training_feedback.read.comment');
    const forced = await h.actor(A, 'TRAINING_COORDINATOR');
    const permissionId = (await h.one<{ id: string }>(`select id from permission where resource = 'training_feedback' and action = 'read' and field_group = 'comment'`)).id;
    await h.db.query(
      `insert into role_permission (company_id, role_id, permission_id, effect) select $1, r.id, $2, 'ALLOW' from role r where r.company_id = $1 and r.code = 'TRAINING_COORDINATOR'
       on conflict do nothing`,
      [A.id, permissionId],
    );
    await h.db.query(
      `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from) values ($1, $2, $3, true, '2026-01-01T00:00:00Z')`,
      [A.id, forced.assignment, permissionId],
    );
    const forcedView = await register(forced, p.id);
    expect(forcedView.commentsIncluded).toBe(false);
    expect(JSON.stringify(forcedView)).not.toContain('narrative C');

    // Managers and employees do not read a plan's feedback; the employee reads their own, comment included.
    expect((await h.call(manager, 'GET', `/v1/training-plans/${p.id}/feedback`)).statusCode).toBe(403);
    expect((await h.call(m.actor, 'GET', `/v1/training-plans/${p.id}/feedback`)).statusCode).toBe(403);
    expect((await h.call(m.actor, 'GET', `/v1/training-plans/${p.id}/feedback-summary`)).statusCode).toBe(403);
    expect(JSON.stringify((await h.call(m.actor, 'GET', '/v1/me/training-feedback')).json())).toContain('narrative C');
    const someoneElse = await member();
    expect(JSON.stringify((await h.call(someoneElse.actor, 'GET', '/v1/me/training-feedback')).json())).not.toContain('narrative C');

    // The export carries scores and status, never comments (no restricted column exists in the file).
    const exported = await h.call(hrComments, 'GET', `/v1/training-plans/${p.id}/feedback/export`);
    expect(exported.statusCode, exported.body).toBe(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.body).toContain('"Score: Overall rating of the training","Score: Trainer knowledge (synthetic)"');
    expect(exported.body).not.toContain('narrative C');
    expect((await h.call(m.actor, 'GET', `/v1/training-plans/${p.id}/feedback/export`)).statusCode).toBe(403);
  });

  it('the summary reconciles to the participants and shows missing responses distinctly (FR-050)', async () => {
    const p = await pastPlan({ capacity: 20 });
    const [a, b, c] = [await member(), await member(), await member({ departmentId: A.financeDept })];
    const [noShow, cancelled, confirmedOnly, attendedOnly] = [await member(), await member(), await member(), await member({ departmentId: A.financeDept })];
    const [aId, bId, cId] = await completed(p, [a.emp, b.emp, c.emp]);
    const [nId, xId, kId, tId] = await nominated(h, coordinator, p.id, [noShow.emp, cancelled.emp, confirmedOnly.emp, attendedOnly.emp]);
    await advance(h, coordinator, p.id, [nId!, kId!, tId!], ['CONFIRM']);
    await advance(h, coordinator, p.id, [nId!], ['MARK_NO_SHOW']);
    await advance(h, coordinator, p.id, [tId!], ['MARK_ATTENDED']);
    expect((await act(h, coordinator, p.id, 'CANCEL', [xId!], 'Synthetic')).statusCode).toBe(200);
    expect((await give(a.actor, aId!, [{ questionCode: 'OVERALL', score: 5 }, { questionCode: 'TRAINER', score: 4 }])).statusCode).toBe(201);
    expect((await give(b.actor, bId!, [{ questionCode: 'OVERALL', score: 3 }, { questionCode: 'TRAINER', score: 4, comment: 'Synthetic narrative D' }])).statusCode).toBe(201);

    const summary = (await h.call(coordinator, 'GET', `/v1/training-plans/${p.id}/feedback-summary`)).json();
    expect(summary).toMatchObject({
      plan: { id: p.id, code: p.code, view: 'PAST' },
      scope: { kind: 'COMPANY', companyWide: true },
      participants: { total: 7, byState: { NOMINATED: 0, CONFIRMED: 1, ATTENDED: 1, COMPLETED: 3, NO_SHOW: 1, CANCELLED: 1 } },
      feedback: { eligible: 3, responded: 2, missing: 1, notApplicable: 4 },
      questions: [
        { code: 'OVERALL', position: 1, answered: 2, scores: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 1 }, missing: 1 },
        { code: 'TRAINER', position: 2, answered: 2, scores: { '1': 0, '2': 0, '3': 0, '4': 2, '5': 0 }, missing: 1 },
      ],
      reconciles: { participants: true, responses: true, questions: true },
    });
    expect(summary).not.toHaveProperty('average');
    for (const q of summary.questions as Record<string, unknown>[]) expect(q).not.toHaveProperty('average');
    expect(JSON.stringify(summary)).not.toContain('narrative D');

    // The register shows each participation's status: the missing response distinctly.
    const ids = async (status: string) => (await register(coordinator, p.id, `?status=${status}`)).items.map((i) => i.participantId).sort();
    expect(await ids('MISSING')).toEqual([cId]);
    expect(await ids('RESPONDED')).toEqual([aId, bId].sort());
    expect(await ids('NOT_APPLICABLE')).toEqual([nId, xId, kId, tId].sort());

    // A department-filtered assignment summarises its own population, which still reconciles.
    const scoped = (await h.call(filteredHr, 'GET', `/v1/training-plans/${p.id}/feedback-summary`)).json();
    expect(scoped).toMatchObject({
      scope: { kind: 'COMPANY', companyWide: false },
      participants: { total: 5, byState: { COMPLETED: 2, CONFIRMED: 1, ATTENDED: 0, NO_SHOW: 1, CANCELLED: 1 } },
      feedback: { eligible: 2, responded: 2, missing: 0, notApplicable: 3 },
      reconciles: { participants: true, responses: true, questions: true },
    });
    expect((await register(filteredHr, p.id)).items.map((i) => i.employeeId)).not.toContain(c.emp);
  });

  it('refuses a feedback register or export above its row bound instead of truncating it (FR-050 reconciliation, DF09)', async () => {
    // A stand-in database: the plan, then one participation more than the bound; nothing else may be asked (no audit row).
    const asked: string[] = [];
    const planId = '00000000-0000-4000-8000-000000000001';
    const fake: Queryable = {
      query: async (text: string) => {
        asked.push(text);
        if (text.includes('from training_plan p')) return { rows: [{ id: planId, code: 'SYN-BOUND', title: 'Synthetic', startDate: '2026-01-05', endDate: '2026-01-06', view: 'PAST' }] } as never;
        if (text.includes('from training_participant t join employee e')) return { rows: Array.from({ length: ROW_LIMIT + 1 }, (_, i) => ({ participantId: `SYN-${i}` })) } as never;
        throw new Error('unexpected query');
      },
    };
    const grant: AccessGrant = {
      allowed: true,
      userId: coordinator.user,
      companyId: A.id,
      assignmentId: coordinator.assignment,
      roleCode: 'TRAINING_COORDINATOR',
      accessClass: 'OTHER',
      scopeKind: 'COMPANY',
      filters: { departments: [], locations: [], employees: [] },
      allowedFieldGroups: ['operational'],
      ownEssFieldGroups: [],
      deniedFieldGroups: [],
      linkedEmployeeId: null,
      at: new Date(),
      businessDate: today,
    };
    await expect(exportFeedback(fake, grant, planId)).rejects.toMatchObject({ statusCode: 422, code: 'TOO_MANY_ROWS', details: { limit: ROW_LIMIT } });
    expect(asked).toHaveLength(2);
    expect(asked[1]).toContain(`limit ${ROW_LIMIT + 1}`);
  });

  it('TN17 is available in My ESS with own-record links; the Employee role holds only own-ESS comment groups (H1, H3)', async () => {
    const m = await member();
    const ess = (await h.call(m.actor, 'GET', '/v1/me/ess')).json() as { tabs: { id: string; status: string; links: { rel: string; method: string; href: string }[] }[] };
    const tab = ess.tabs.find((t) => t.id === 'TN17')!;
    expect(tab.status).toBe('AVAILABLE');
    expect(tab.links).toEqual([
      { rel: 'participations', method: 'GET', href: `/v1/employees/${m.emp}/training` },
      { rel: 'openPlans', method: 'GET', href: '/v1/me/training-plans' },
      { rel: 'enrol', method: 'POST', href: '/v1/me/training-nominations' },
      { rel: 'feedback', method: 'GET', href: '/v1/me/training-feedback' },
      { rel: 'submitFeedback', method: 'POST', href: '/v1/me/training-feedback' },
    ]);
    for (const l of tab.links.filter((x) => x.method === 'GET')) expect((await h.call(m.actor, 'GET', l.href)).statusCode, l.href).toBe(200);
    const own = (await h.call(m.actor, 'GET', '/v1/me/permissions')).json().permissions as string[];
    expect(own).toEqual(expect.arrayContaining(['training_feedback.read.comment', 'training_feedback.submit.comment', 'training_participant.enrol.operational']));
    expect(own).not.toContain('training_participant.manage.operational');
    const employeeRole = BASELINE_ROLES.find((r) => r.code === 'EMPLOYEE')!;
    expect(employeeRole.defaultDuties.filter((k) => k.startsWith('training'))).toEqual([
      'training_participant.read.operational',
      'training_participant.enrol.operational',
      'training_feedback.read.operational',
      'training_feedback.submit.operational',
      'training_feedback.read.comment',
      'training_feedback.submit.comment',
    ]);
    const flags = (
      await h.db.query<{ key: string; own_ess: boolean }>(
        `select resource || '.' || action || '.' || field_group as key, own_ess from permission where resource like 'training%' order by 1`,
      )
    ).rows;
    expect(flags.filter((f) => f.own_ess).map((f) => f.key)).toEqual(['training_feedback.read.comment', 'training_feedback.submit.comment']);
  });

  it('F2 metrics: own training due, current/future sessions, confirmed, completion/no-show and feedback pending counts', async () => {
    // A company of its own, so every count is known.
    const C = await h.makeCompany();
    const cHr = await h.actor(C, 'HR_ADMINISTRATOR');
    const cCoordinator = await h.actor(C, 'TRAINING_COORDINATOR');
    const cOwner = await person(h, C, cHr);
    const mk = async (start: number, end: number) =>
      newPlan(h, cCoordinator, { startDate: addDays(today, start), endDate: addDays(today, end), ownerEmployeeId: cOwner });
    const empA = await person(h, C, cHr);
    const empB = await person(h, C, cHr);
    const actorA = await h.actor(C, 'EMPLOYEE', { employeeId: empA });
    const upcoming = await mk(3, 4);
    const running = await mk(-1, 1);
    const past = await mk(-5, -4);
    const cancelled = await mk(6, 7);
    await h.call(cCoordinator, 'POST', `/v1/training-plans/${cancelled.id}/cancel`, { reason: 'Synthetic', expectedVersion: 1 });
    const [u] = await nominated(h, cCoordinator, upcoming.id, [empA]);
    await advance(h, cCoordinator, upcoming.id, [u!], ['CONFIRM']);
    await nominated(h, cCoordinator, running.id, [empA]);
    const [pa, pb] = await nominated(h, cCoordinator, past.id, [empA, empB]);
    await advance(h, cCoordinator, past.id, [pa!, pb!], ['CONFIRM']);
    await advance(h, cCoordinator, past.id, [pa!], ['MARK_ATTENDED', 'COMPLETE']);
    await advance(h, cCoordinator, past.id, [pb!], ['MARK_NO_SHOW']);

    const grantOf = async (a: TestActor, resource: string, action: string): Promise<AccessGrant> => {
      const g = await resolveAccess(h.pool, { userId: a.user, companyId: a.company.id, assignmentId: a.assignment, resource, action, fieldGroups: ['operational'] });
      if (!g.allowed) throw new Error(`denied ${resource}.${action}`);
      return g;
    };
    const own = await grantOf(actorA, 'dashboard', 'read');
    // Upcoming (confirmed) + running (nominated) + past completed without feedback.
    expect(await TRAINING_METRICS.OWN_TRAINING_DUE!(h.pool, own)).toEqual({ status: 'OK', value: 3 });
    expect((await h.call(actorA, 'POST', '/v1/me/training-feedback', { participantId: pa, answers: [{ questionCode: 'OVERALL', score: 4 }] })).statusCode).toBe(201);
    expect(await TRAINING_METRICS.OWN_TRAINING_DUE!(h.pool, own)).toEqual({ status: 'OK', value: 2 });
    const unlinked = await grantOf(cCoordinator, 'dashboard', 'read');
    expect((await TRAINING_METRICS.OWN_TRAINING_DUE!(h.pool, unlinked)).status).toBe('NOT_CONFIGURED');

    const coord = await grantOf(cCoordinator, 'training_participant', 'read');
    expect(await TRAINING_METRICS.TRAINING_SESSIONS_CURRENT_FUTURE!(h.pool, coord)).toEqual({ status: 'OK', value: 2 });
    expect(await TRAINING_METRICS.TRAINING_CONFIRMED_PARTICIPATIONS!(h.pool, coord)).toEqual({ status: 'OK', value: 1 });
    expect(await TRAINING_METRICS.TRAINING_COMPLETION_NO_SHOW!(h.pool, coord)).toEqual({ status: 'OK', value: '1/1' });
    expect(await TRAINING_METRICS.TRAINING_FEEDBACK_PENDING!(h.pool, coord)).toEqual({ status: 'OK', value: 0 });
    // The counts reconcile with the drill-down lists (BR-045).
    const pending = (await h.call(cCoordinator, 'GET', `/v1/training-plans/${past.id}/feedback?status=MISSING`)).json().items;
    expect(pending).toEqual([]);
    const current = (await h.call(cCoordinator, 'GET', '/v1/training-plans?view=CURRENT')).json().total + (await h.call(cCoordinator, 'GET', '/v1/training-plans?view=FUTURE')).json().total;
    expect(current).toBe(2);
  });
});
