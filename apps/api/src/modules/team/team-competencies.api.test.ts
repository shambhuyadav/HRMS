// My Team "Goals and Tasks" with the appraisal's competencies (FR-095, DF16, DF02; I-62, I-86 item 6; decided under owner delegation,
// 6 Nov 2026, docs/03 I-89 item 4): beside the goals, each appraisal lists the competencies copied into it at enrolment with their
// names, weights and completion flags only (operational, like goal names). Scores, comments, indicators and descriptions never
// reach the tab, whatever confidential grant the manager holds. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { appraisalWorld, enrol, GOALS, openCycle, ownView, taskOf, type View, type World } from '../appraisal/appraisal.fixtures.js';
import { isModuleActive } from '../registry.js';

const SYSTEM = '00000000-0000-4000-8000-000000000001';
const TEAM_ONLY: PermissionKey[] = ['team.list.operational', 'team.read.operational', 'dashboard.read.operational'];

type CompetencyView = { id: string; code: string; sequence: number };
type CView = View & { competencies: CompetencyView[] };
type TabCompetency = { sequence: number; name: string; weight: number; selfEntryComplete: boolean; managerRatingComplete: boolean };
type TabItem = { cycleCode: string; taskStatus: string; goals: unknown[]; competencies: TabCompetency[] };

describe.runIf(isModuleActive('appraisal'))('My Team Goals and Tasks: the appraisal competencies (I-89 item 4)', () => {
  let h: Harness;
  let A: Company;
  let w: World;
  let grade: string;
  let bareGrade: string;

  const indicators = (name: string) => [1, 2, 3, 4, 5].map((l) => `Synthetic ${name}: level ${l} indicator text`);
  const competency = async (code: string, name: string) => {
    const res = await h.call(w.hr, 'POST', '/v1/appraisal-competencies', { code, name, description: `Synthetic description of ${name}`, indicators: indicators(name), activeFrom: '2026-01-01' });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  /** An active employee in a grade, reporting to the world's manager, with their own Employee context. */
  const member = async (name: string, gradeId: string) => {
    const res = await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: name, gradeId }));
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().id as string;
    await h.setStatus(A, id, 'ACTIVE_CONFIRMED');
    const m = await h.call(w.hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: w.managerEmp, effectiveFrom: '2026-01-05' });
    expect(m.statusCode, m.body).toBeLessThan(300);
    return { id, actor: await h.actor(A, 'EMPLOYEE', { employeeId: id }) };
  };
  const goalsTab = async (a: TestActor, employeeId: string) => {
    const res = await h.call(a, 'GET', `/v1/my-team/${employeeId}`);
    expect(res.statusCode, res.body).toBe(200);
    return { body: res.body, tab: res.json().tabs.goalsAndTasks as { sections: { goals: { available: boolean; items: TabItem[] } } } | undefined };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await appraisalWorld(h, A);
    grade = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active, created_by) values ($1, 'TC1', 'Synthetic TC1', true, $2) returning id`, [A.id, SYSTEM])).id;
    bareGrade = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active, created_by) values ($1, 'TC9', 'Synthetic TC9', true, $2) returning id`, [A.id, SYSTEM])).id;
    const focus = await competency('TC_FOCUS', 'Synthetic customer focus');
    const team = await competency('TC_TEAM', 'Synthetic teamwork');
    const mapped = await h.call(w.hr, 'POST', '/v1/appraisal-competency-sets', {
      gradeId: grade,
      effectiveFrom: w.today,
      items: [
        { competencyId: focus, weight: 60 },
        { competencyId: team, weight: 40 },
      ],
      reason: 'Synthetic grade mapping',
    });
    expect(mapped.statusCode, mapped.body).toBe(201);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('lists the copied competencies beside the goals: names, weights and completion flags, which follow the self-entry and the rating', async () => {
    const cycle = await openCycle(h, w);
    const e = await member('Synthetic Competency Member', grade);
    const v = (await enrol(h, w.hr, cycle.id, e.id)) as CView;
    expect(v.competencies.map((c) => c.code)).toEqual(['TC_FOCUS', 'TC_TEAM']);

    const before = (await goalsTab(w.manager, e.id)).tab!.sections.goals.items[0]!;
    expect(before.cycleCode).toBe(cycle.code);
    expect(before.goals).toHaveLength(GOALS.length);
    expect(before.competencies).toEqual([
      { sequence: 1, name: 'Synthetic customer focus', weight: 60, selfEntryComplete: false, managerRatingComplete: false },
      { sequence: 2, name: 'Synthetic teamwork', weight: 40, selfEntryComplete: false, managerRatingComplete: false },
    ]);

    // The employee scores the first competency only, with a private comment: its flag turns, the other stays.
    const own = (await ownView(h, e.actor, v.id)) as CView;
    const saved = await h.call(e.actor, 'PUT', `/v1/me/appraisals/${v.id}/self-entry`, {
      entries: own.goals.map((g) => ({ goalId: g.id, score: 4 })),
      competencies: own.competencies.map((c, i) => ({ competencyId: c.id, score: i === 0 ? 5 : null, ...(i === 0 ? { comment: 'Private competency self note (synthetic)' } : {}) })),
      expectedVersion: own.version,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await goalsTab(w.manager, e.id)).tab!.sections.goals.items[0]!.competencies.map((c) => c.selfEntryComplete)).toEqual([true, false]);

    // Both scored and submitted; the manager rates both with a private note: every flag is complete.
    const again = (await ownView(h, e.actor, v.id)) as CView;
    const all = await h.call(e.actor, 'PUT', `/v1/me/appraisals/${v.id}/self-entry`, {
      entries: again.goals.map((g) => ({ goalId: g.id, score: 4 })),
      competencies: again.competencies.map((c) => ({ competencyId: c.id, score: 5, comment: 'Private competency self note (synthetic)' })),
      expectedVersion: again.version,
    });
    expect(all.statusCode, all.body).toBe(200);
    const submitted = await h.call(e.actor, 'POST', `/v1/me/appraisals/${v.id}/submit`, { expectedVersion: (all.json() as View).version });
    expect(submitted.statusCode, submitted.body).toBe(200);
    const t = (await taskOf(h, w.manager, v.id))!;
    const a = t.appraisal as CView;
    const rated = await h.call(w.manager, 'PUT', `/v1/appraisal-tasks/${t.taskId}/rating`, {
      entries: a.goals.map((g) => ({ goalId: g.id, score: 3 })),
      competencies: a.competencies.map((c) => ({ competencyId: c.id, score: 2, comment: 'Private competency manager note (synthetic)' })),
      expectedVersion: a.version,
    });
    expect(rated.statusCode, rated.body).toBe(200);

    const { body, tab } = await goalsTab(w.manager, e.id);
    expect(tab!.sections.goals.items[0]!.competencies).toEqual([
      { sequence: 1, name: 'Synthetic customer focus', weight: 60, selfEntryComplete: true, managerRatingComplete: true },
      { sequence: 2, name: 'Synthetic teamwork', weight: 40, selfEntryComplete: true, managerRatingComplete: true },
    ]);
    // DF02: no score, comment, indicator, description or code, though this manager holds the rating grant.
    for (const hidden of ['Private competency', 'indicator text', 'Synthetic description of', 'TC_FOCUS', '"score"', 'selfScore', 'managerScore', 'competencyResult']) expect(body, hidden).not.toContain(hidden);
  });

  it('an appraisal with no competency set shows an empty list, and the tab stays under its own grant', async () => {
    const cycle = await openCycle(h, w);
    const e = await member('Synthetic Unmapped Member', bareGrade);
    await enrol(h, w.hr, cycle.id, e.id);
    const item = (await goalsTab(w.manager, e.id)).tab!.sections.goals.items[0]!;
    expect(item.goals).toHaveLength(GOALS.length);
    expect(item.competencies).toEqual([]);
    // Without the appraisal read duty in the same assignment, there is no Goals and Tasks tab at all.
    const teamOnly = await h.actor(A, 'REPORTING_MANAGER', { user: w.manager.user, duties: TEAM_ONLY });
    expect((await goalsTab(teamOnly, e.id)).tab).toBeUndefined();
  });
});
