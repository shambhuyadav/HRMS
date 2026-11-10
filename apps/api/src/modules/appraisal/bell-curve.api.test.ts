// Bell curve (BRD coverage CL-132 "Bell Curve" under FR-040 to FR-044; FR-044 "proposed distribution charts must report selected
// population and period", acceptance "score counts reconcile to the selected population"; BR-044 / DF02 confidential ratings; BR-026
// scope; F1 "no forced distribution": targets are a reference only; migration 0262). Ten synthetic appraisals go through the real
// flow (self-entry, then the manager's rating completes them: a cycle without reviewer levels) to a known distribution of final
// ratings. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { appraisalWorld, enrol, HR_OVERSIGHT, openCycle, rate, selfAssess, type World } from './appraisal.fixtures.js';

let h: Harness;
let A: Company;
let w: World;
let cycleId: string;
let gradeOne: string;
let hrEng: TestActor;
let hrSelf: TestActor;
let employeeRole: TestActor;
const ids: string[] = [];
/** Each appraisee's own Employee OWN actor (one user per employee link). */
const selves: TestActor[] = [];

/** Goal weights 30/30/40 (fixtures GOALS): the final rating is 0.3·s1 + 0.3·s2 + 0.4·s3. */
const PEOPLE: { name: string; scores: number[]; finance?: boolean; grade?: boolean }[] = [
  { name: 'Synthetic Bell One', scores: [1, 1, 1], grade: true }, //       1.00
  { name: 'Synthetic Bell Two', scores: [2, 2, 2], grade: true }, //       2.00
  { name: 'Synthetic Bell Three A', scores: [3, 3, 3], grade: true }, //   3.00
  { name: 'Synthetic Bell Three B', scores: [3, 3, 3] }, //                3.00
  { name: 'Synthetic Bell Three C', scores: [3, 3, 3], finance: true }, // 3.00
  { name: 'Synthetic Bell Three Four', scores: [3, 3, 4], finance: true }, // 3.40
  { name: 'Synthetic Bell Four A', scores: [4, 4, 4], finance: true }, //   4.00
  { name: 'Synthetic Bell Four B', scores: [4, 4, 4] }, //                 4.00
  { name: 'Synthetic Bell Four C', scores: [4, 4, 4] }, //                 4.00
  { name: 'Synthetic Bell Five', scores: [5, 5, 5], finance: true }, //    5.00
];

const FIVE_BANDS = [
  { code: 'LOW', label: 'Needs improvement', minRating: '1.00', maxRating: '1.99', targetPercent: '10' },
  { code: 'BELOW', label: 'Below expectations', minRating: '2.00', maxRating: '2.99', targetPercent: '20' },
  { code: 'MEETS', label: 'Meets expectations', minRating: '3.00', maxRating: '3.99', targetPercent: '40' },
  { code: 'EXCEEDS', label: 'Exceeds expectations', minRating: '4.00', maxRating: '4.99', targetPercent: '20' },
  { code: 'TOP', label: 'Outstanding', minRating: '5.00', maxRating: '5.00', targetPercent: '10' },
];

type Band = { code: string; actualCount: number; actualPercent: string | null; targetPercent: string; targetCount: string; differencePercent: string | null };
type Curve = { population: number; distribution: { rating: string; count: number; percent: string }[]; bands: Band[] | null; target: { source: string; revision: number } | null; period: { from: string; to: string }; filters: Record<string, string | null>; ownAppraisalExcluded: boolean; targetEnforced: boolean };
const curve = async (a: TestActor, query = '') => {
  const res = await h.call(a, 'GET', `/v1/appraisal-cycles/${cycleId}/bell-curve${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Curve;
};
const counts = (c: Curve) => Object.fromEntries((c.bands ?? []).map((b) => [b.code, [b.actualCount, b.actualPercent]]));
const snapshot = async () => (await h.db.query(`select id, state, final_rating::text, version from appraisal where company_id = $1 order by id`, [A.id])).rows;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  w = await appraisalWorld(h, A);
  gradeOne = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active, created_by) values ($1, $2, 'Synthetic Grade One', true, $3) returning id`, [A.id, uniq('G').toUpperCase().replace(/[^A-Z0-9_-]/g, ''), SYSTEM_ACTOR_ID])).id;
  const cycle = await openCycle(h, w, { approvalLevels: 0, split: { goalWeightPercent: 100, competencyWeightPercent: 0 } });
  cycleId = cycle.id;
  for (const p of PEOPLE) {
    const res = await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: p.name, ...(p.finance ? { departmentId: A.financeDept } : {}), ...(p.grade ? { gradeId: gradeOne } : {}) }));
    expect(res.statusCode, res.body).toBe(201);
    const employeeId = res.json().id as string;
    await h.setStatus(A, employeeId, 'ACTIVE_CONFIRMED');
    expect((await h.call(w.hr, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId: w.managerEmp, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
    const self = await h.actor(A, 'EMPLOYEE', { employeeId });
    const appraisal = await enrol(h, w.hr, cycleId, employeeId);
    await selfAssess(h, self, appraisal.id, p.scores);
    expect((await rate(h, w.manager, appraisal.id, p.scores)).state).toBe('APPROVED');
    ids.push(employeeId);
    selves.push(self);
  }
  // An appraisal still in progress is not part of the completed population.
  const pendingRes = await h.call(w.hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: 'Synthetic Bell Pending' }));
  await h.setStatus(A, pendingRes.json().id, 'ACTIVE_CONFIRMED');
  await enrol(h, w.hr, cycleId, pendingRes.json().id);
  hrEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_OVERSIGHT, departmentFilter: A.dept });
  // An HR Administrator whose own appraisal (rated 5.00) is in the cycle.
  // The same user as that employee's own account (already linked), now in an HR Administrator assignment.
  hrSelf = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_OVERSIGHT, user: selves[9]!.user });
  employeeRole = selves[0]!;
}, 600_000);

afterAll(async () => {
  await h?.stop();
});

describe('bell curve (CL-132; FR-044)', () => {
  it('FR-044: without bands it states the population and period and gives the exact distribution of final ratings, counts reconciling to the completed appraisals', async () => {
    const c = await curve(w.hr);
    expect(c.population).toBe(10);
    expect(c.distribution.map((d) => [d.rating, d.count, d.percent])).toEqual([
      ['1.00', 1, '10.00'],
      ['2.00', 1, '10.00'],
      ['3.00', 3, '30.00'],
      ['3.40', 1, '10.00'],
      ['4.00', 3, '30.00'],
      ['5.00', 1, '10.00'],
    ]);
    expect(c.distribution.reduce((s, d) => s + d.count, 0)).toBe(c.population);
    expect(c).toMatchObject({ bands: null, target: null, targetEnforced: false, filters: { departmentId: null, gradeId: null } });
    expect(c.period.from).toMatch(/^\d{4}-04-01$/);
    // It agrees with the cycle report's rating part for the same population.
    const report = (await h.call(w.hr, 'GET', `/v1/appraisal-cycles/${cycleId}/report`)).json();
    expect(report.ratings.completed).toBe(c.population);
  });

  it('FR-044: with the company bands, each band gives its actual count and share against its target share and the count it means', async () => {
    const before = await snapshot();
    const set = await h.call(w.hrPlain, 'POST', '/v1/appraisal-rating-distributions', { reason: 'Synthetic company reference curve', bands: FIVE_BANDS });
    expect(set.statusCode, set.body).toBe(201);
    expect(set.json()).toMatchObject({ cycleId: null, revision: 1 });
    const c = await curve(w.hr);
    expect(c.target).toMatchObject({ source: 'COMPANY', revision: 1 });
    expect(c.bands!.map((b) => [b.code, b.actualCount, b.actualPercent, b.targetPercent, b.targetCount, b.differencePercent])).toEqual([
      ['LOW', 1, '10.00', '10.00', '1.0', '0.00'],
      ['BELOW', 1, '10.00', '20.00', '2.0', '-10.00'],
      ['MEETS', 4, '40.00', '40.00', '4.0', '0.00'],
      ['EXCEEDS', 3, '30.00', '20.00', '2.0', '10.00'],
      ['TOP', 1, '10.00', '10.00', '1.0', '0.00'],
    ]);
    expect(c.bands!.reduce((s, b) => s + b.actualCount, 0)).toBe(c.population);
    // F1: a target is a reference only: no rating, state or version changed.
    expect(await snapshot()).toEqual(before);
  });

  it('FR-044 BR-026: narrows by department and grade (shares of the narrowed population), and a cycle\'s own bands replace the company default', async () => {
    const fin = await curve(w.hr, `?departmentId=${A.financeDept}`);
    expect(fin.population).toBe(4);
    expect(counts(fin)).toEqual({ LOW: [0, '0.00'], BELOW: [0, '0.00'], MEETS: [2, '50.00'], EXCEEDS: [1, '25.00'], TOP: [1, '25.00'] });
    const graded = await curve(w.hr, `?gradeId=${gradeOne}`);
    expect(graded.population).toBe(3);
    expect(counts(graded)).toMatchObject({ LOW: [1, '33.33'], BELOW: [1, '33.33'], MEETS: [1, '33.33'], EXCEEDS: [0, '0.00'] });
    expect((await curve(w.hr, `?departmentId=${A.financeDept}&gradeId=${gradeOne}`)).population).toBe(0);
    const empty = await curve(w.hr, `?departmentId=${A.financeDept}&gradeId=${gradeOne}`);
    expect(empty.bands!.every((b) => b.actualCount === 0 && b.actualPercent === null)).toBe(true);
    const own = await h.call(w.hr, 'POST', '/v1/appraisal-rating-distributions', {
      cycleId,
      reason: 'Synthetic two-band view for this cycle',
      bands: [
        { code: 'LOWER', label: 'Lower', minRating: '1.00', maxRating: '2.99', targetPercent: '33.33' },
        { code: 'UPPER', label: 'Upper', minRating: '3.00', maxRating: '5.00', targetPercent: '66.67' },
      ],
    });
    expect(own.statusCode, own.body).toBe(201);
    const c = await curve(w.hr);
    expect(c.target).toMatchObject({ source: 'CYCLE', revision: 1 });
    expect(counts(c)).toEqual({ LOWER: [2, '20.00'], UPPER: [8, '80.00'] });
    const listed = (await h.call(w.hrPlain, 'GET', `/v1/appraisal-rating-distributions?cycleId=${cycleId}`)).json();
    expect(listed.inForce).toMatchObject({ source: 'CYCLE', cycleId });
    expect(listed.items.map((s: { cycleId: string | null }) => s.cycleId)).toEqual([null, cycleId]);
  });

  it('BR-044 DF02 BR-026: the bell curve needs the confidential rating report right, keeps to row scope and leaves out the viewer\'s own appraisal', async () => {
    for (const a of [w.hrPlain, employeeRole, w.rev1]) expect((await h.call(a, 'GET', `/v1/appraisal-cycles/${cycleId}/bell-curve`)).statusCode).toBe(403);
    // Department-scoped HR: the six outside finance. The manager (team scope) sees the ten direct reports.
    expect((await curve(hrEng)).population).toBe(6);
    expect((await curve(w.manager)).population).toBe(10);
    const self = await curve(hrSelf);
    expect(self.ownAppraisalExcluded).toBe(true);
    expect(self.population).toBe(9);
    expect(self.distribution.some((d) => d.rating === '5.00')).toBe(false);
    // Another company's cycle reads as missing.
    const B = await h.makeCompany();
    const bHr = await h.actor(B, 'HR_ADMINISTRATOR', { extra: HR_OVERSIGHT });
    expect((await h.call(bHr, 'GET', `/v1/appraisal-cycles/${cycleId}/bell-curve`)).statusCode).toBe(404);
  });

  it('FR-044: bands and targets are HR configuration: complete, adding up to 100, append-only, kept from an unrestricted company assignment and audited', async () => {
    const post = (a: TestActor, bands: object[]) => h.call(a, 'POST', '/v1/appraisal-rating-distributions', { reason: 'Synthetic', bands });
    expect((await post(w.hrPlain, FIVE_BANDS.map((b) => (b.code === 'TOP' ? { ...b, targetPercent: '5' } : b)))).json().error).toBe('TARGET_TOTAL_NOT_100');
    expect((await post(w.hrPlain, FIVE_BANDS.filter((b) => b.code !== 'BELOW'))).json().error).toBe('BANDS_NOT_CONTIGUOUS');
    expect((await post(w.hrPlain, FIVE_BANDS.map((b) => (b.code === 'MEETS' ? { ...b, minRating: '2.50' } : b)))).json().error).toBe('BANDS_NOT_CONTIGUOUS');
    expect((await post(w.hrPlain, [...FIVE_BANDS].reverse())).json().error).toBe('BANDS_NOT_CONTIGUOUS');
    expect((await post(hrEng, FIVE_BANDS)).statusCode).toBe(403);
    expect((await post(w.manager, FIVE_BANDS)).statusCode).toBe(403);
    expect((await post(employeeRole, FIVE_BANDS)).statusCode).toBe(403);
    // A second company revision supersedes the first for cycles without their own; both stay.
    const second = await post(w.hrPlain, FIVE_BANDS.map((b) => (b.code === 'MEETS' ? { ...b, targetPercent: '30' } : b.code === 'EXCEEDS' ? { ...b, targetPercent: '30' } : b)));
    expect(second.json()).toMatchObject({ cycleId: null, revision: 2 });
    // Every recorded revision is audited, and so is each refusal of a role without the duty (FR-098).
    const actions = (await h.db.query<{ action: string }>(`select action from audit_event where company_id = $1 and resource_code = 'appraisal_distribution' order by occurred_at`, [A.id])).rows.map((r) => r.action);
    expect(actions.filter((a) => a === 'CREATE')).toHaveLength(3);
    expect(actions.filter((a) => a === 'ACCESS_DENIED')).toHaveLength(2);
    await expect(h.db.query(`update appraisal_rating_band set target_percent = 50 where setting_id = $1`, [second.json().id])).rejects.toThrow(/append-only/);
    await expect(h.db.query(`delete from appraisal_rating_band_setting where id = $1`, [second.json().id])).rejects.toThrow(/append-only/);
    // The database refuses targets that do not add up to 100 at commit, whoever writes them.
    await h.db.query('begin');
    const sid = (
      await h.one<{ id: string }>(`insert into appraisal_rating_band_setting (company_id, revision, reason, created_by, acting_assignment_id) values ($1, 99, 'x', $2, $3) returning id`, [A.id, w.hrPlain.user, w.hrPlain.assignment])
    ).id;
    await h.db.query(`insert into appraisal_rating_band (company_id, setting_id, sequence, code, label, min_rating, max_rating, target_percent) values ($1, $2, 1, 'ALL', 'All', 1, 5, 90)`, [A.id, sid]);
    await expect(h.db.query('commit')).rejects.toThrow(/must add up to 100/);
    await h.db.query('rollback').catch(() => undefined);
  });
});
