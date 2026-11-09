// Appraisal competencies and configurable sections, decided under owner delegation, 6 Nov 2026 (I-86): FR-041 "grade-mapped
// competencies", FR-042 "self-appraisal against goals/competencies and configurable improvement, training, activity-performance and
// stretched-KPI sections ... formula mode produces the approved test score; sections excluded by the approved configuration do not
// block submission", BR-014, F1 "Appraisal", DF02, H1/BR-053. The worked examples (A to E) are the scores put to the owner for
// sign-off. Each guard is checked over HTTP and, where the database holds it, by a direct write. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { appraisalWorld, confirm, decide, enrol, fyStart, openCycle, openWindows, ownView, staffView, taskOf, trailText, type View, type World } from './appraisal.fixtures.js';

const SYSTEM = '00000000-0000-4000-8000-000000000001';

type CompetencyView = { id: string; competencyId: string; sequence: number; code: string; name: string; weight: number; indicators: { level: number; text: string }[]; selfEntryComplete: boolean; managerRatingComplete?: boolean };
type SectionView = { code: string; filledBy: string[]; selfEntryComplete?: boolean; managerEntryComplete?: boolean };
type CView = View & { competencies: CompetencyView[]; competencyWeightTotal: number; sections: SectionView[]; finalRating?: string | null; cycle: { scoring: { goalWeightPercent: number; competencyWeightPercent: number } } };
type Section = { section: string; text: string | null };

describe.runIf(isModuleActive('appraisal'))('appraisal competencies and configurable sections (I-86)', () => {
  let h: Harness;
  let A: Company;
  let w: World;
  let gradeG1: string;
  let gradeG2: string;
  let gradeBare: string;
  let desigD2: string;
  const k: Record<string, string> = {};

  const master = async (table: 'grade' | 'designation', code: string) =>
    (await h.one<{ id: string }>(`insert into ${table} (company_id, code, name, active, created_by) values ($1, $2, $3, true, $4) returning id`, [A.id, code, `Synthetic ${code}`, SYSTEM])).id;

  /** An active employee in a grade (and designation), reporting to the world's manager. */
  const graded = async (name: string, gradeId: string | null, designationId?: string) => {
    const res = await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: name, ...(gradeId ? { gradeId } : {}), ...(designationId ? { designationId } : {}) }));
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
    const m = await h.call(w.hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: w.managerEmp, effectiveFrom: '2026-01-05' });
    expect(m.statusCode, m.body).toBeLessThan(300);
    return { id, actor: await h.actor(A, 'EMPLOYEE', { employeeId: id }) };
  };

  const indicators = (name: string) => [1, 2, 3, 4, 5].map((l) => `Synthetic ${name}: level ${l} behaviour`);
  const competency = async (code: string, name: string) => {
    const res = await h.call(w.hr, 'POST', '/v1/appraisal-competencies', { code, name, description: `Synthetic ${name}`, indicators: indicators(name), activeFrom: '2026-01-01' });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; version: number; indicators: { level: number; text: string }[] };
  };
  const mapSet = (gradeId: string, items: [string, number][], designationId?: string, effectiveFrom = w.today) =>
    h.call(w.hr, 'POST', '/v1/appraisal-competency-sets', {
      gradeId,
      ...(designationId ? { designationId } : {}),
      effectiveFrom,
      items: items.map(([competencyId, weight]) => ({ competencyId, weight })),
      reason: 'Synthetic grade mapping',
    });

  /** The employee scores goals and competencies (in sequence order), adds section texts, and submits. */
  const selfAssessAll = async (e: TestActor, id: string, goalScores: number[], competencyScores: number[], sections: Section[] = []) => {
    const v = (await ownView(h, e, id)) as CView;
    const saved = await h.call(e, 'PUT', `/v1/me/appraisals/${id}/self-entry`, {
      entries: v.goals.map((g, i) => ({ goalId: g.id, score: goalScores[i] ?? null })),
      competencies: v.competencies.map((c, i) => ({ competencyId: c.id, score: competencyScores[i] ?? null, comment: `Synthetic self note on ${c.code}` })),
      sections,
      expectedVersion: v.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    return h.call(e, 'POST', `/v1/me/appraisals/${id}/submit`, { expectedVersion: (saved.json() as View).version });
  };

  /** The manager saves goal and competency scores, section texts and (MANUAL) the overall rating; returns the task. */
  const saveRatingAll = async (id: string, goalScores: number[], competencyScores: number[], sections: Section[] = [], overallRating?: number) => {
    const t = (await taskOf(h, w.manager, id))!;
    expect(t, 'rating task').toBeDefined();
    const a = t.appraisal as CView;
    const saved = await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t.taskId}/rating`, {
      entries: a.goals.map((g, i) => ({ goalId: g.id, score: goalScores[i] ?? null })),
      competencies: a.competencies.map((c, i) => ({ competencyId: c.id, score: competencyScores[i] ?? null, comment: `Synthetic manager note on ${c.code}` })),
      sections,
      ...(overallRating !== undefined ? { overallRating } : {}),
      expectedVersion: a.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    return t.taskId;
  };

  const managerRating = async (id: string) => ((await staffView(h, w.hr, id)).revisions.at(-1) as { managerRating: Record<string, unknown> }).managerRating;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await appraisalWorld(h, A);
    gradeG1 = await master('grade', 'G1');
    gradeG2 = await master('grade', 'G2');
    gradeBare = await master('grade', 'G9');
    desigD2 = await master('designation', 'LEAD');
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('FR-041 masters: HR maintains the competency master (five behavioural indicators) and the dated grade mapping, whose weights total exactly 100; a written set is fixed', async () => {
    const cust = await competency('CUST', 'Customer focus');
    expect(cust.indicators).toEqual(indicators('Customer focus').map((text, i) => ({ level: i + 1, text })));
    k.CUST = cust.id;
    k.TEAM = (await competency('TEAM', 'Teamwork')).id;
    k.OWN = (await competency('OWN', 'Ownership')).id;
    k.COMM = (await competency('COMM', 'Communication')).id;
    k.QUAL = (await competency('QUAL', 'Quality')).id;
    expect((await h.call(w.hr, 'POST', '/v1/appraisal-competencies', { code: 'cust', name: 'Again', indicators: indicators('x'), activeFrom: '2026-01-01' })).json().error).toBe('COMPETENCY_CODE_EXISTS');
    // One indicator per proficiency level 1 to 5, none blank.
    expect((await h.call(w.hr, 'POST', '/v1/appraisal-competencies', { code: 'FOUR', name: 'Four', indicators: indicators('x').slice(0, 4), activeFrom: '2026-01-01' })).statusCode).toBe(400);
    expect((await h.call(w.hr, 'POST', '/v1/appraisal-competencies', { code: 'BLANK', name: 'Blank', indicators: ['a', 'b', '   ', 'd', 'e'], activeFrom: '2026-01-01' })).json().error).toBe('INVALID_INDICATORS');
    await expect(
      h.db.query(`insert into appraisal_competency (company_id, code, name, indicators, active_from, created_by) values ($1, 'DBX', 'x', '{}', '2026-01-01', $2)`, [A.id, SYSTEM]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'appraisal_competency_indicators_check' });

    // Appraisal Config is HR's: a manager or an employee cannot maintain it.
    const employee = await graded('Synthetic Config Outsider', null);
    expect((await h.call(w.manager, 'POST', '/v1/appraisal-competencies', { code: 'MGR', name: 'x', indicators: indicators('x'), activeFrom: '2026-01-01' })).statusCode).toBe(403);
    expect((await h.call(employee.actor, 'GET', '/v1/appraisal-competencies')).statusCode).toBe(403);

    // The mapping: whole-number weights totalling exactly 100, each competency once, from today on.
    expect((await mapSet(gradeG1, [[k.CUST, 50], [k.TEAM, 40]])).json()).toMatchObject({ error: 'WEIGHT_TOTAL_NOT_100', details: { total: 90 } });
    expect((await mapSet(gradeG1, [[k.CUST, 50], [k.CUST, 50]])).json().error).toBe('DUPLICATE_COMPETENCY');
    expect((await mapSet(gradeG1, [[k.CUST, 100]], undefined, '2026-01-01')).json().error).toBe('EFFECTIVE_DATE_IN_PAST');
    const g1 = await mapSet(gradeG1, [[k.CUST, 50], [k.TEAM, 30], [k.OWN, 20]]);
    expect(g1.statusCode, g1.body).toBe(201);
    expect(g1.json()).toMatchObject({ grade: { id: gradeG1 }, designation: null, effectiveFrom: w.today, effectiveTo: null, inForceToday: true, weightTotal: 100 });
    expect((await mapSet(gradeG1, [[k.CUST, 100]])).json().error).toBe('SET_ALREADY_PLANNED');
    // Optionally narrowed to a designation (the narrower set applies to it).
    expect((await mapSet(gradeG1, [[k.COMM, 60], [k.QUAL, 40]], desigD2)).statusCode).toBe(201);
    expect((await mapSet(gradeG2, [[k.COMM, 50], [k.QUAL, 50]])).statusCode).toBe(201);

    // Database: a set is fixed once written; its weights total 100 at commit; items are never added later.
    const setId = g1.json().id as string;
    await expect(h.db.query(`update appraisal_competency_set set reason = 'Synthetic rewrite' where id = $1`, [setId])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from appraisal_competency_set where id = $1`, [setId])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`insert into appraisal_competency_set_item (company_id, set_id, competency_id, sequence, weight, created_by) values ($1, $2, $3, 9, 10, $4)`, [A.id, setId, k.QUAL, SYSTEM])).rejects.toMatchObject({
      code: '23514',
      message: expect.stringMatching(/written with their set/),
    });
    await h.db.query('begin');
    try {
      const s = await h.one<{ id: string }>(`insert into appraisal_competency_set (company_id, grade_id, effective_from, reason, created_by) values ($1, $2, '2030-01-01', 'Synthetic', $3) returning id`, [A.id, gradeBare, SYSTEM]);
      await h.db.query(`insert into appraisal_competency_set_item (company_id, set_id, competency_id, sequence, weight, created_by) values ($1, $2, $3, 1, 90, $4)`, [A.id, s.id, k.CUST, SYSTEM]);
      await expect(h.db.query('commit')).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/total exactly 100 \(now 90\)/) });
    } finally {
      await h.db.query('rollback');
    }

    // A competency in an open set cannot be ended (API and database); its other fields can change.
    const team = (await h.call(w.hr, 'GET', `/v1/appraisal-competencies/${k.TEAM}`)).json();
    const body = { name: team.name, description: team.description, indicators: indicators('Teamwork'), activeFrom: '2026-01-01', expectedVersion: team.version };
    expect((await h.call(w.hr, 'PUT', `/v1/appraisal-competencies/${k.TEAM}`, { ...body, activeTo: '2027-01-01' })).json()).toMatchObject({ error: 'COMPETENCY_IN_USE', details: { sets: 1 } });
    await expect(h.db.query(`update appraisal_competency set active_to = '2027-01-01' where id = $1`, [k.TEAM])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update appraisal_competency set code = 'TEAM2' where id = $1`, [k.TEAM])).rejects.toMatchObject({ code: '23514' });
  });

  it('I-86 scoring split: a dated company setting (70 / 30 by default) that HR changes from today on, never in place; each cycle takes the split in force on its start date', async () => {
    const settings = (await h.call(w.manager, 'GET', '/v1/appraisal-scoring-settings')).json();
    expect(settings).toMatchObject({ inForce: { goalWeightPercent: 70, competencyWeightPercent: 30 }, items: [{ effectiveFrom: '2000-01-01', effectiveTo: null }] });
    const revision = (body: Record<string, unknown>) => h.call(w.hr, 'POST', '/v1/appraisal-scoring-settings', { reason: 'Synthetic split change', ...body });
    const tomorrow = new Date(Date.parse(`${w.today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    expect((await revision({ effectiveFrom: tomorrow, goalWeightPercent: 60, competencyWeightPercent: 45 })).json().error).toBe('SPLIT_NOT_100');
    expect((await revision({ effectiveFrom: '2026-04-01', goalWeightPercent: 60, competencyWeightPercent: 40 })).json().error).toBe('EFFECTIVE_DATE_IN_PAST');
    expect((await h.call(w.manager, 'POST', '/v1/appraisal-scoring-settings', { effectiveFrom: tomorrow, goalWeightPercent: 60, competencyWeightPercent: 40, reason: 'x' })).statusCode).toBe(403);
    const next = await revision({ effectiveFrom: tomorrow, goalWeightPercent: 60, competencyWeightPercent: 40 });
    expect(next.statusCode, next.body).toBe(201);
    const after = (await h.call(w.hr, 'GET', '/v1/appraisal-scoring-settings')).json();
    expect(after).toMatchObject({ inForce: { goalWeightPercent: 70, competencyWeightPercent: 30 }, items: [{ effectiveFrom: tomorrow, effectiveTo: null }, { effectiveFrom: '2000-01-01', effectiveTo: tomorrow }] });
    // A revision's values never change in place.
    await expect(h.db.query(`update appraisal_scoring_setting set goal_weight_percent = 50, competency_weight_percent = 50 where company_id = $1 and effective_from = '2000-01-01'`, [A.id])).rejects.toMatchObject({ code: '23514' });

    // The current cycle (started 1 April) keeps 70 / 30; next year's takes 60 / 40; a cycle may set its own split.
    expect((await openCycle(h, w)) as unknown).toMatchObject({ scoring: { goalWeightPercent: 70, competencyWeightPercent: 30, competenciesAssessed: true } });
    expect((await openCycle(h, w, { offsetYears: 1, windows: {} as Record<string, unknown>, reviewDueOn: '2027-12-31' })) as unknown).toMatchObject({ scoring: { goalWeightPercent: 60, competencyWeightPercent: 40 } });
    expect((await openCycle(h, w, { split: { goalWeightPercent: 80, competencyWeightPercent: 20 } })) as unknown).toMatchObject({ scoring: { goalWeightPercent: 80, competencyWeightPercent: 20 } });
    const bad = await h.call(w.hr, 'POST', '/v1/appraisal-cycles', { code: 'SPLIT-BAD', name: 'x', startDate: fyStart(w.today), windows: openWindows(w.today), reviewDueOn: openWindows(w.today).managerRating.closesOn, goalWeightPercent: 70 });
    expect(bad.json()).toMatchObject({ error: 'SPLIT_NOT_100', details: { missing: ['competencyWeightPercent'] } });
  });

  it('Worked example A (formula, 70 / 30): goals 30/30/40 rated 3, 4, 5 give 4.10; competencies 50/30/20 rated 3, 4, 2 give 3.10; the final rating is (70 x 4.10 + 30 x 3.10) / 100 = 3.80', async () => {
    const cycle = await openCycle(h, w);
    const e = await graded('Synthetic Example A', gradeG1);
    const v = (await enrol(h, w.hr, cycle.id, e.id)) as CView;
    // Copied from the grade's set at enrolment: code, name, indicators and weight.
    expect(v.competencies.map((c) => [c.sequence, c.code, c.weight])).toEqual([
      [1, 'CUST', 50],
      [2, 'TEAM', 30],
      [3, 'OWN', 20],
    ]);
    expect(v).toMatchObject({ competencyWeightTotal: 100, cycle: { scoring: { goalWeightPercent: 70, competencyWeightPercent: 30 } } });
    expect(v.competencies[0]!.indicators).toHaveLength(5);
    // Fixed once copied: a later change of the master leaves the appraisal's copy as it was, and the copy is never rewritten.
    const cust = (await h.call(w.hr, 'GET', `/v1/appraisal-competencies/${k.CUST}`)).json();
    expect(
      (await h.call(w.hr, 'PUT', `/v1/appraisal-competencies/${k.CUST}`, { name: 'Customer focus (renamed)', description: null, indicators: indicators('Renamed'), activeFrom: '2026-01-01', activeTo: null, expectedVersion: cust.version }))
        .statusCode,
    ).toBe(200);
    const own = (await ownView(h, e.actor, v.id)) as CView;
    expect(own.competencies[0]).toMatchObject({ code: 'CUST', name: 'Customer focus', selfEntryComplete: false });
    expect(own.competencies[0]).not.toHaveProperty('managerRatingComplete');
    await expect(h.db.query(`update appraisal_competency_item set weight = 40 where appraisal_id = $1 and sequence = 1`, [v.id])).rejects.toMatchObject({ code: '23514' });
    await expect(
      h.db.query(
        `insert into appraisal_competency_item (company_id, appraisal_id, set_id, competency_id, sequence, code, name, indicators, weight, created_by)
         select company_id, appraisal_id, set_id, competency_id, 9, code, name, indicators, weight, created_by from appraisal_competency_item where appraisal_id = $1 and sequence = 1`,
        [v.id],
      ),
    ).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/copied when the appraisal is created/) });

    // FR-042 self-appraisal against competencies: every competency is self-scored before submission.
    const partial = await h.call(e.actor, 'PUT', `/v1/me/appraisals/${v.id}/self-entry`, { entries: own.goals.map((g) => ({ goalId: g.id, score: 4 })), expectedVersion: own.version });
    expect(partial.statusCode, partial.body).toBe(200);
    expect((await h.call(e.actor, 'POST', `/v1/me/appraisals/${v.id}/submit`, { expectedVersion: (partial.json() as View).version })).json()).toMatchObject({
      error: 'SELF_ENTRY_INCOMPLETE',
      details: { goals: [], competencies: [1, 2, 3], sections: [] },
    });
    expect((await selfAssessAll(e.actor, v.id, [4, 4, 4], [4, 4, 4])).statusCode).toBe(200);

    // The manager rates every competency too; the rating is not submitted with one missing.
    const taskId = await saveRatingAll(v.id, [3, 4, 5], [3, 4]);
    expect((await decide(h, w.manager, taskId, { decision: 'APPROVE' })).json()).toMatchObject({ error: 'RATING_INCOMPLETE', details: { goals: [], competencies: [3] } });
    await saveRatingAll(v.id, [3, 4, 5], [3, 4, 2]);
    expect((await decide(h, w.manager, taskId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'IN_REVIEW' });
    expect(await managerRating(v.id)).toMatchObject({
      goalResult: '4.10',
      competencyResult: '3.10',
      split: { goalWeightPercent: 70, competencyWeightPercent: 30 },
      weightedResult: '3.80',
      competencies: [
        { sequence: 1, score: 3 },
        { sequence: 2, score: 4 },
        { sequence: 3, score: 2 },
      ],
    });
    expect(await confirm(h, w.rev1, v.id)).toMatchObject({ state: 'APPROVED' });
    expect(await staffView(h, w.hr, v.id)).toMatchObject({ finalRating: '3.80' });

    // Confidential (DF02; H1/BR-053): the employee sees their own competency self-scores only; staff without the rating group see
    // completion flags only; no score reaches the audit trail or the outbox.
    const mine = (await ownView(h, e.actor, v.id)) as CView;
    expect(mine.revisions[0]).toMatchObject({ selfEntry: { competencies: [{ score: 4 }, { score: 4 }, { score: 4 }] } });
    expect(mine.revisions[0]).not.toHaveProperty('managerRating');
    expect(JSON.stringify(mine)).not.toMatch(/competencyResult|goalResult|finalRating|"3\.80"|Synthetic manager note/);
    const plain = (await staffView(h, w.hrPlain, v.id)) as CView;
    expect(plain.revisions[0]).not.toHaveProperty('selfEntry');
    expect(plain.competencies[0]).toMatchObject({ selfEntryComplete: true, managerRatingComplete: true });
    expect(await trailText(h, A.id)).not.toMatch(/Synthetic (self|manager) note on|competencyResult|"3\.80"/);
  });

  it('Worked example B (rounding): one rounding, half up, of the exact combination: 3.35 and 3.00 give 3.245, shown 3.25; 3.34 and 3.50 give 3.388, shown 3.39', async () => {
    const cycle = await openCycle(h, w);
    // Goals 65/35 rated 3, 4: G = (195 + 140) / 100 = 3.35. Competencies 50/50 (grade G2) rated 3, 3: C = 3.00.
    const b1 = await graded('Synthetic Example B1', gradeG2);
    const v1 = await enrol(h, w.hr, cycle.id, b1.id, [
      { sequence: 1, description: 'Synthetic delivery goal', weight: 65 },
      { sequence: 2, description: 'Synthetic quality goal', weight: 35 },
    ]);
    expect((await selfAssessAll(b1.actor, v1.id, [3, 3], [3, 3])).statusCode).toBe(200);
    const t1 = await saveRatingAll(v1.id, [3, 4], [3, 3]);
    expect((await decide(h, w.manager, t1, { decision: 'APPROVE' })).statusCode).toBe(200);
    // (70 x 335 + 30 x 300) / 10000 = 32450 / 10000 = 3.245, rounded half up: 3.25 (half-to-even would give 3.24).
    expect(await managerRating(v1.id)).toMatchObject({ goalResult: '3.35', competencyResult: '3.00', weightedResult: '3.25' });

    // Goals 33/33/34 rated 3, 3, 4: G = (99 + 99 + 136) / 100 = 3.34. Competencies 50/50 rated 3, 4: C = 3.50.
    const b2 = await graded('Synthetic Example B2', gradeG2);
    const v2 = await enrol(h, w.hr, cycle.id, b2.id, [
      { sequence: 1, description: 'Synthetic goal one', weight: 33 },
      { sequence: 2, description: 'Synthetic goal two', weight: 33 },
      { sequence: 3, description: 'Synthetic goal three', weight: 34 },
    ]);
    expect((await selfAssessAll(b2.actor, v2.id, [3, 3, 3], [3, 3])).statusCode).toBe(200);
    const t2 = await saveRatingAll(v2.id, [3, 3, 4], [3, 4]);
    expect((await decide(h, w.manager, t2, { decision: 'APPROVE' })).statusCode).toBe(200);
    // (70 x 334 + 30 x 350) / 10000 = 33880 / 10000 = 3.388, rounded: 3.39.
    expect(await managerRating(v2.id)).toMatchObject({ goalResult: '3.34', competencyResult: '3.50', weightedResult: '3.39' });
    expect(await confirm(h, w.rev1, v2.id)).toMatchObject({ state: 'APPROVED' });
    expect(await staffView(h, w.hr, v2.id)).toMatchObject({ finalRating: '3.39' });
  });

  it('Worked example C (manual mode): the inputs of A in a MANUAL cycle; the manager’s overall rating 4 is the final rating (4.00), the weighted 3.80 is kept beside it', async () => {
    const cycle = await openCycle(h, w, { ratingMode: 'MANUAL' });
    const e = await graded('Synthetic Example C', gradeG1);
    const v = await enrol(h, w.hr, cycle.id, e.id);
    expect((await selfAssessAll(e.actor, v.id, [4, 4, 4], [4, 4, 4])).statusCode).toBe(200);
    const taskId = await saveRatingAll(v.id, [3, 4, 5], [3, 4, 2], [], 4);
    expect((await decide(h, w.manager, taskId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'IN_REVIEW' });
    expect(await confirm(h, w.rev1, v.id)).toMatchObject({ state: 'APPROVED' });
    expect(await staffView(h, w.hr, v.id)).toMatchObject({
      finalRating: '4.00',
      revisions: [{ managerRating: { overallRating: 4, weightedResult: '3.80', goalResult: '4.10', competencyResult: '3.10' } }],
    });
  });

  it('Worked example D (no competencies): an unmapped grade, no grade, or a cycle that does not assess competencies gives the goal result alone (4.10); the designation-specific set wins over the grade set', async () => {
    const cycle = await openCycle(h, w);
    const unmapped = await graded('Synthetic Unmapped Grade', gradeBare);
    const v = (await enrol(h, w.hr, cycle.id, unmapped.id)) as CView;
    expect(v.competencies).toEqual([]);
    expect((await selfAssessAll(unmapped.actor, v.id, [4, 4, 4], [])).statusCode).toBe(200);
    const taskId = await saveRatingAll(v.id, [3, 4, 5], []);
    expect((await decide(h, w.manager, taskId, { decision: 'APPROVE' })).statusCode).toBe(200);
    expect(await managerRating(v.id)).toMatchObject({ goalResult: '4.10', competencyResult: null, split: null, weightedResult: '4.10' });

    const noGrade = await graded('Synthetic No Grade', null);
    expect(((await enrol(h, w.hr, cycle.id, noGrade.id)) as CView).competencies).toEqual([]);

    // A goals-only cycle (competencies 0) copies nothing even for a mapped grade.
    const goalsOnly = await openCycle(h, w, { split: { goalWeightPercent: 100, competencyWeightPercent: 0 } });
    expect((goalsOnly as unknown as { scoring: unknown }).scoring).toMatchObject({ competenciesAssessed: false });
    const mapped = await graded('Synthetic Goals Only', gradeG1);
    expect(((await enrol(h, w.hr, goalsOnly.id, mapped.id)) as CView).competencies).toEqual([]);

    // Grade G1 with designation LEAD: the narrower set applies.
    const lead = await graded('Synthetic Lead', gradeG1, desigD2);
    expect(((await enrol(h, w.hr, cycle.id, lead.id)) as CView).competencies.map((c) => [c.code, c.weight])).toEqual([
      ['COMM', 60],
      ['QUAL', 40],
    ]);
  });

  it('Worked example E (FR-042 sections): an included section blocks its party until filled, an excluded one never blocks and takes no entry; texts are confidential and a return carries the employee’s over', async () => {
    const cycle = await openCycle(h, w, { sections: ['TRAINING_NEEDS', 'IMPROVEMENT_AREAS'] });
    expect((cycle as unknown as { sections: { code: string; filledBy: string[]; scored: boolean }[] }).sections).toEqual([
      expect.objectContaining({ code: 'IMPROVEMENT_AREAS', filledBy: ['MANAGER'], scored: false }),
      expect.objectContaining({ code: 'TRAINING_NEEDS', filledBy: ['EMPLOYEE', 'MANAGER'], scored: false }),
    ]);
    const e = await graded('Synthetic Example E', gradeBare);
    const v = (await enrol(h, w.hr, cycle.id, e.id)) as CView;
    expect(v.sections.map((s) => s.code)).toEqual(['IMPROVEMENT_AREAS', 'TRAINING_NEEDS']);
    const own = (await ownView(h, e.actor, v.id)) as CView;
    const save = (sections: Section[], version: number) => h.call(e.actor, 'PUT', `/v1/me/appraisals/${v.id}/self-entry`, { entries: own.goals.map((g) => ({ goalId: g.id, score: 4 })), sections, expectedVersion: version });
    // An excluded section takes no entry; the manager's section is not the employee's.
    expect((await save([{ section: 'ACTIVITY_PERFORMANCE', text: 'Synthetic activity' }], own.version)).json()).toMatchObject({ error: 'SECTION_NOT_INCLUDED' });
    expect((await save([{ section: 'IMPROVEMENT_AREAS', text: 'Synthetic' }], own.version)).json()).toMatchObject({ error: 'SECTION_NOT_FILLED_BY_YOU' });
    const saved = await save([], own.version);
    expect(saved.statusCode, saved.body).toBe(200);
    // The included section blocks the submission until filled; the excluded ACTIVITY_PERFORMANCE and STRETCHED_KPIS never do.
    expect((await h.call(e.actor, 'POST', `/v1/me/appraisals/${v.id}/submit`, { expectedVersion: (saved.json() as View).version })).json()).toMatchObject({
      error: 'SELF_ENTRY_INCOMPLETE',
      details: { goals: [], competencies: [], sections: ['TRAINING_NEEDS'] },
    });
    const filled = await save([{ section: 'TRAINING_NEEDS', text: 'Synthetic: a spreadsheet modelling course' }], (saved.json() as View).version);
    expect(filled.statusCode, filled.body).toBe(200);
    expect((await h.call(e.actor, 'POST', `/v1/me/appraisals/${v.id}/submit`, { expectedVersion: (filled.json() as View).version })).statusCode).toBe(200);

    // The manager fills both included sections before the rating is submitted.
    const taskId = await saveRatingAll(v.id, [3, 4, 5], []);
    expect((await decide(h, w.manager, taskId, { decision: 'APPROVE' })).json()).toMatchObject({ error: 'RATING_INCOMPLETE', details: { sections: ['IMPROVEMENT_AREAS', 'TRAINING_NEEDS'] } });
    // A return carries the employee's section text into the next revision.
    expect((await decide(h, w.manager, taskId, { decision: 'RETURN', employeeMessage: 'Synthetic: add more on training' })).json()).toMatchObject({ state: 'RETURNED', revision: 2 });
    const back = (await ownView(h, e.actor, v.id)) as CView;
    expect(back.revisions[1]).toMatchObject({ selfEntry: { sections: [{ section: 'TRAINING_NEEDS', text: 'Synthetic: a spreadsheet modelling course' }] } });
    expect((await h.call(e.actor, 'POST', `/v1/me/appraisals/${v.id}/submit`, { expectedVersion: back.version })).statusCode).toBe(200);
    const sections = [
      { section: 'IMPROVEMENT_AREAS', text: 'Synthetic: plan work earlier' },
      { section: 'TRAINING_NEEDS', text: 'Synthetic: advanced spreadsheet modelling' },
    ];
    const task2 = await saveRatingAll(v.id, [3, 4, 5], [], sections);
    expect((await decide(h, w.manager, task2, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'IN_REVIEW' });
    expect(await managerRating(v.id)).toMatchObject({ sections, weightedResult: '4.10' });
    expect(await confirm(h, w.rev1, v.id)).toMatchObject({ state: 'APPROVED' });

    // Confidential: the employee sees their own text only; staff without the rating group see completion flags only.
    const mine = await ownView(h, e.actor, v.id);
    expect(JSON.stringify(mine)).not.toMatch(/plan work earlier|advanced spreadsheet|managerEntryComplete/);
    const plain = (await staffView(h, w.hrPlain, v.id)) as CView;
    expect(JSON.stringify(plain)).not.toMatch(/spreadsheet|plan work earlier/);
    expect(plain.sections).toEqual([
      expect.objectContaining({ code: 'IMPROVEMENT_AREAS', managerEntryComplete: true }),
      expect.objectContaining({ code: 'TRAINING_NEEDS', selfEntryComplete: true, managerEntryComplete: true }),
    ]);
    expect(await trailText(h, A.id)).not.toMatch(/spreadsheet|plan work earlier/);

    // Training needs reach training planning as a suggestion only: confidential (rating group), nobody is nominated.
    expect((await h.call(w.hrPlain, 'GET', `/v1/appraisal-cycles/${cycle.id}/training-needs`)).statusCode).toBe(403);
    const needs = (await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycle.id}/training-needs`)).json();
    expect(needs).toMatchObject({
      sectionIncluded: true,
      suggestionOnly: true,
      population: 1,
      items: [{ appraisalId: v.id, employeeStated: 'Synthetic: a spreadsheet modelling course', managerRecommended: 'Synthetic: advanced spreadsheet modelling' }],
    });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from training_participant where employee_id = $1`, [e.id])).n).toBe(0);
  });

  it('the database holds the sections, the competency entries and the formula: excluded sections, an employee writing manager parts, a submission or rating with parts missing, and results that are not the formula are refused', async () => {
    const cycle = await openCycle(h, w, { sections: ['ACTIVITY_PERFORMANCE'] });
    const e = await graded('Synthetic Guarded', gradeG1);
    const v = (await enrol(h, w.hr, cycle.id, e.id)) as CView;
    const rev = (n: number) => h.one<{ id: string }>(`select id from appraisal_revision where appraisal_id = $1 and revision = $2`, [v.id, n]);
    const r1 = (await rev(1)).id;
    const section = (name: string, party: string, by: string) =>
      h.db.query(`insert into appraisal_section_entry (company_id, appraisal_id, revision_id, section, party, body, created_by, updated_by) values ($1, $2, $3, $4, $5, 'Synthetic', $6, $6)`, [
        A.id,
        v.id,
        r1,
        name,
        party,
        by,
      ]);
    await expect(section('TRAINING_NEEDS', 'EMPLOYEE', e.actor.user)).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/only a section the cycle includes/) });
    await expect(section('IMPROVEMENT_AREAS', 'EMPLOYEE', e.actor.user)).rejects.toMatchObject({ code: '23514' });
    // The self-entry is not submitted without the employee's part of an included section, nor without every competency self-score.
    const submitDirect = () =>
      h.db.query(`update appraisal_revision set state = 'SUBMITTED', submitted_by = $1, submitted_at = now(), approval_levels = 1, updated_by = $1 where id = $2`, [e.actor.user, r1]);
    await h.db.query(
      `insert into appraisal_entry (company_id, appraisal_id, revision_id, item_id, self_score, created_by, updated_by) select company_id, appraisal_id, $2, id, 4, $3, $3 from appraisal_item where appraisal_id = $1`,
      [v.id, r1, e.actor.user],
    );
    await h.db.query(
      `insert into appraisal_competency_entry (company_id, appraisal_id, revision_id, item_id, self_score, created_by, updated_by) select company_id, appraisal_id, $2, id, 4, $3, $3 from appraisal_competency_item where appraisal_id = $1 and sequence < 3`,
      [v.id, r1, e.actor.user],
    );
    await expect(submitDirect()).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/every competency is self-scored/) });
    expect((await selfAssessAll(e.actor, v.id, [4, 4, 4], [4, 4, 4])).json()).toMatchObject({ error: 'SELF_ENTRY_INCOMPLETE', details: { sections: ['ACTIVITY_PERFORMANCE'] } });
    await expect(submitDirect()).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/each included section the employee fills/) });
    expect((await selfAssessAll(e.actor, v.id, [4, 4, 4], [4, 4, 4], [{ section: 'ACTIVITY_PERFORMANCE', text: 'Synthetic: ran the migration' }])).statusCode).toBe(200);

    // The manager prepares the rating; the employee can write no manager part, of a competency or a section.
    await saveRatingAll(v.id, [3, 4, 5], [3, 4, 2]);
    await expect(h.db.query(`update appraisal_competency_entry set manager_score = 5, updated_by = $2 where appraisal_id = $1`, [v.id, e.actor.user])).rejects.toMatchObject({ code: '23514' });
    await expect(section('ACTIVITY_PERFORMANCE', 'MANAGER', e.actor.user)).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/never enter or replace a manager rating/) });

    // The results are the formula's: G 4.10, C 3.10, split 70 / 30, weighted 3.80. Anything else is refused; the right values pass.
    const rate = (weighted: string, goal: string, comp: string | null, gp: number | null, cp: number | null) =>
      h.db.query(
        `update appraisal_revision set state = 'RATED', rated_by = $1, rated_at = now(), weighted_result = $2, goal_result = $3, competency_result = $4,
                goal_weight_percent = $5, competency_weight_percent = $6, updated_by = $1 where id = $7`,
        [w.manager.user, weighted, goal, comp, gp, cp, r1],
      );
    await expect(rate('3.80', '4.10', '3.10', 70, 30)).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/each included section the manager fills/) });
    await section('ACTIVITY_PERFORMANCE', 'MANAGER', w.manager.user);
    await expect(rate('3.79', '4.10', '3.10', 70, 30)).rejects.toMatchObject({ code: '23514', constraint: 'appraisal_revision_combined_result' });
    await expect(rate('4.10', '4.10', null, null, null)).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/the competency result is/) });
    await expect(rate('3.73', '4.00', '3.10', 70, 30)).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/the goal result is/) });
    await expect(rate('3.77', '4.10', '3.00', 70, 30)).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/the competency result is/) });
    await expect(rate('3.70', '4.10', '3.10', 60, 40)).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/the cycle's split/) });
    await h.db.query('begin');
    try {
      expect((await rate('3.80', '4.10', '3.10', 70, 30)).rowCount).toBe(1);
    } finally {
      await h.db.query('rollback');
    }
    // Through the API the rating stores exactly those values, written once.
    const t = (await taskOf(h, w.manager, v.id))!;
    expect((await decide(h, w.manager, t.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'IN_REVIEW' });
    expect(await managerRating(v.id)).toMatchObject({ goalResult: '4.10', competencyResult: '3.10', weightedResult: '3.80' });
    await expect(h.db.query(`update appraisal_revision set goal_result = 4.00, weighted_result = 3.73 where id = $1`, [r1])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update appraisal_revision set competency_result = 3.00 where id = $1`, [r1])).rejects.toMatchObject({ code: '23514', message: expect.stringMatching(/written once/) });
  });

  it('cycle rules: the split and the sections are fixed once an appraisal is submitted, whether competencies are assessed once one is enrolled (API and database)', async () => {
    const cycle = await openCycle(h, w);
    const body = async (extra: Record<string, unknown>) => {
      const c = (await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycle.id}`)).json();
      return h.call(w.hr, 'PUT', `/v1/appraisal-cycles/${cycle.id}`, { name: c.name, approvalLevels: 1, windows: openWindows(w.today), expectedVersion: c.version, ...extra });
    };
    expect((await body({ sections: ['STRETCHED_KPIS', 'STRETCHED_KPIS'] })).statusCode).toBe(422);
    expect((await body({ goalWeightPercent: 75, competencyWeightPercent: 25, sections: ['STRETCHED_KPIS'] })).json()).toMatchObject({
      scoring: { goalWeightPercent: 75, competencyWeightPercent: 25 },
      sections: [expect.objectContaining({ code: 'STRETCHED_KPIS' })],
    });
    const e = await graded('Synthetic Rules', gradeG1);
    const v = await enrol(h, w.hr, cycle.id, e.id);
    // Enrolled: competencies stay assessed; the split may still change.
    expect((await body({ goalWeightPercent: 100, competencyWeightPercent: 0 })).json().error).toBe('COMPETENCY_USE_FIXED');
    await expect(h.db.query(`update appraisal_cycle set goal_weight_percent = 100, competency_weight_percent = 0 where id = $1`, [cycle.id])).rejects.toMatchObject({ code: '23514' });
    expect((await body({ goalWeightPercent: 70, competencyWeightPercent: 30, sections: [] })).statusCode).toBe(200);
    expect((await selfAssessAll(e.actor, v.id, [3, 3, 3], [3, 3, 3])).statusCode).toBe(200);
    // Submitted: the split and the sections are fixed.
    expect((await body({ goalWeightPercent: 60, competencyWeightPercent: 40 })).json().error).toBe('RULES_FIXED');
    expect((await body({ sections: ['TRAINING_NEEDS'] })).json().error).toBe('RULES_FIXED');
    await expect(h.db.query(`update appraisal_cycle set sections = '{TRAINING_NEEDS}' where id = $1`, [cycle.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update appraisal_cycle set goal_weight_percent = 60, competency_weight_percent = 40 where id = $1`, [cycle.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update appraisal_cycle set sections = '{NOT_A_SECTION}' where id = $1`, [cycle.id])).rejects.toMatchObject({ code: '23514' });
  });
});
