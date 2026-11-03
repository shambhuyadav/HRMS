// Confirmation policy maintenance over HTTP (FR-080 "dated confirmation policies ... Missing/zero/negative duration,
// end-before-start, equally applicable policies ... are rejected. Joining-date or policy changes do not silently alter
// the assigned historical policy or due date"; BR-029 "select exactly one applicable policy"; DF11 "Equal-priority
// overlapping policies are rejected"). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { provisionCompany } from '../access/provision.js';
import { narrowedGrant } from '../lifecycle/lifecycle.fixtures.js';
import { createPolicy, createPolicyRevision, type PolicyView, retirePolicy } from './policies.js';
import { openConfirmation } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;

const PATH = '/v1/confirmation-policies';
const terms = (patch: Record<string, unknown> = {}) => ({ duration: 2, durationUnit: 'CALENDAR_MONTHS', startBasis: 'JOINING_DATE', effectiveFrom: '2000-01-01', ...patch });
const create = (a: TestActor, patch: Record<string, unknown>) => h.call(a, 'POST', PATH, { code: uniq('P').toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40), ...terms(patch) });
const list = async (a: TestActor) => {
  const res = await h.call(a, 'GET', PATH);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { items: PolicyView[]; applicability: { employmentTypes: { code: string; label: string }[]; grades: { id: string; code: string }[]; locations: { id: string; code: string }[] } };
};
const defaultOf = async (a: TestActor) => (await list(a)).items.find((p) => p.code === 'DEFAULT')!;
const hrOf = async (c: Company) => h.actor(c, 'HR_ADMINISTRATOR');
/** A company whose only policy is the provisioned default, with an HR Administrator. */
const fresh = async () => {
  const company = await h.makeCompany();
  return { company, admin: await hrOf(company) };
};
const probationer = async (c: Company, a: TestActor, overrides: Record<string, unknown> = {}) => {
  const res = await h.call(a, 'POST', '/v1/employees', h.newEmployeeBody(c, overrides));
  expect(res.statusCode, res.body).toBe(201);
  await h.setStatus(c, res.json().id, 'ACTIVE_PROBATION');
  return res.json().id as string;
};
const open = (a: TestActor, employeeId: string) => h.call(a, 'POST', '/v1/confirmations', { employeeId });
const dueDateOf = async (a: TestActor, caseId: string) => (await h.call(a, 'GET', `/v1/confirmations/${caseId}`)).json().dueDate as string;
const policyCount = async (c: Company) => (await h.one<{ n: number }>(`select count(*)::int as n from confirmation_policy where company_id = $1`, [c.id])).n;
const auditActions = async (c: Company, id: string) =>
  (await h.db.query<{ action: string }>(`select action from audit_event where company_id = $1 and resource_code = 'confirmation_policy' and record_key = $2 order by occurred_at, id`, [c.id, id])).rows.map((r) => r.action);
const untilWaiting = async (lockType: string, n = 1) => {
  for (let i = 0; i < 200; i++) {
    const waiting = (await h.pool.query<{ n: number }>(`select count(*)::int as n from pg_locks where not granted and locktype = $1`, [lockType])).rows[0]!.n;
    if (waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`No session waited on a ${lockType} lock`);
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await hrOf(A);
});

afterAll(async () => {
  await h?.stop();
});

describe('reading (FR-080)', () => {
  it('lists every policy with where it stands and what it can apply to, only for the policy duty and only in the company', async () => {
    const { items, applicability } = await list(hr);
    expect(items.find((p) => p.code === 'DEFAULT')).toMatchObject({
      revision: 1,
      duration: 3,
      durationUnit: 'CALENDAR_MONTHS',
      startBasis: 'JOINING_DATE',
      monthEndRule: 'CLAMP_TO_MONTH_END',
      startDayInclusive: false,
      maxExtensions: 2,
      effectiveFrom: '2000-01-01',
      effectiveTo: null,
      status: 'IN_FORCE',
      latest: true,
      inUse: false,
      latestCaseStart: null,
    });
    expect(applicability.employmentTypes.map((t) => t.code)).toContain('INTERN');
    expect(applicability.locations.map((l) => l.id)).toContain(A.loc);

    const employee = await h.actor(A, 'EMPLOYEE');
    const manager = await h.actor(A, 'REPORTING_MANAGER');
    for (const a of [employee, manager]) {
      expect((await h.call(a, 'GET', PATH)).statusCode).toBe(403);
      expect((await create(a, { employmentType: 'INTERN' })).statusCode).toBe(403);
    }
    const { admin: otherHr } = await fresh();
    const mine = (await create(hr, { employmentType: 'FIXED_TERM', effectiveFrom: '2090-01-01' })).json() as PolicyView;
    expect((await list(otherHr)).items.map((p) => p.id)).not.toContain(mine.id);
    expect((await h.call(otherHr, 'POST', `${PATH}/${mine.id}/retire`, { effectiveTo: '2091-01-01', expectedVersion: mine.version })).statusCode).toBe(404);
  });
});

describe('creating (FR-080, BR-029)', () => {
  it('gives two employees different planned due dates from different approved durations, and audits the policy', async () => {
    const { company, admin } = await fresh();
    const intern = await create(admin, { code: 'INTERN_ONE_MONTH', duration: 1, employmentType: 'INTERN' });
    expect(intern.statusCode, intern.body).toBe(201);
    expect(intern.json()).toMatchObject({ code: 'INTERN_ONE_MONTH', revision: 1, duration: 1, employmentType: 'INTERN', monthEndRule: 'CLAMP_TO_MONTH_END', startDayInclusive: false, maxExtensions: 2, status: 'IN_FORCE' });
    const days = await create(admin, { code: 'FIXED_45_DAYS', duration: 45, durationUnit: 'CALENDAR_DAYS', employmentType: 'FIXED_TERM' });
    expect(days.statusCode, days.body).toBe(201);

    const permanent = await probationer(company, admin, { joiningDate: '2026-01-31' });
    const internEmp = await probationer(company, admin, { joiningDate: '2026-01-31', employmentType: 'INTERN' });
    const fixedEmp = await probationer(company, admin, { joiningDate: '2026-01-31', employmentType: 'FIXED_TERM' });
    expect((await open(admin, permanent)).json().dueDate).toBe('2026-04-30');
    expect((await open(admin, internEmp)).json().dueDate).toBe('2026-02-28');
    expect((await open(admin, fixedEmp)).json().dueDate).toBe('2026-03-17');

    expect(await auditActions(company, intern.json().id)).toEqual(['CREATE']);
    const audited = await h.one<{ after_values: { operational: { duration: number; employmentType: string } }; actor_user_id: string }>(
      `select after_values, actor_user_id from audit_event where company_id = $1 and resource_code = 'confirmation_policy' and record_key = $2`,
      [company.id, intern.json().id],
    );
    expect(audited.actor_user_id).toBe(admin.user);
    expect(audited.after_values.operational).toMatchObject({ duration: 1, employmentType: 'INTERN' });
  });

  it('refuses a missing, zero, negative or fractional duration and an impossible period in plain words, recording nothing', async () => {
    const { company, admin } = await fresh();
    const before = await policyCount(company);
    const refused = async (patch: Record<string, unknown>, status: number, error: string) => {
      const res = await create(admin, { employmentType: 'INTERN', ...patch });
      expect(res.statusCode, res.body).toBe(status);
      expect(res.json().error).toBe(error);
    };
    await refused({ duration: 0 }, 422, 'INVALID_DURATION');
    await refused({ duration: -1 }, 422, 'INVALID_DURATION');
    await refused({ duration: 1.5 }, 422, 'INVALID_DURATION');
    await refused({ duration: 1201 }, 422, 'INVALID_DURATION');
    await refused({ duration: 36_601, durationUnit: 'CALENDAR_DAYS' }, 422, 'INVALID_DURATION');
    await refused({ effectiveFrom: '2026-06-01', effectiveTo: '2026-05-31' }, 422, 'INVALID_PERIOD');
    await refused({ effectiveFrom: '2026-06-01', effectiveTo: '2026-06-01' }, 422, 'INVALID_PERIOD');
    await refused({ effectiveFrom: '2026-02-30' }, 422, 'INVALID_DATE');
    await refused({ effectiveFrom: '2026-13-45' }, 422, 'INVALID_DATE');
    await refused({ effectiveFrom: '0000-01-01' }, 422, 'INVALID_DATE');
    await refused({ effectiveTo: 'not-a-date' }, 422, 'INVALID_DATE');
    await refused({ code: 'lower-case' }, 422, 'INVALID_CODE');
    await refused({ code: '' }, 422, 'INVALID_CODE');
    await refused({ employmentType: 'NOT_A_TYPE' }, 422, 'INVALID_REFERENCE');
    await refused({ duration: 'x' }, 400, 'INVALID_REQUEST');
    await refused({ durationUnit: 'WEEKS' }, 400, 'INVALID_REQUEST');
    await refused({ startBasis: 'CONFIRMATION_DATE' }, 400, 'INVALID_REQUEST');
    const missing = await h.call(admin, 'POST', PATH, { code: 'NO_DURATION', durationUnit: 'CALENDAR_DAYS', startBasis: 'JOINING_DATE', effectiveFrom: '2026-01-01' });
    expect(missing.statusCode).toBe(400);
    const { company: other } = await fresh();
    const foreignLocation = (await h.one<{ id: string }>(`select id from location where company_id = $1`, [other.id])).id;
    await refused({ locationId: foreignLocation }, 422, 'INVALID_REFERENCE');
    await h.db.query(`update location set active = false where company_id = $1 and id = $2`, [company.id, company.loc]);
    await refused({ locationId: company.loc }, 422, 'INVALID_REFERENCE');
    await h.db.query(`update location set active = true where company_id = $1 and id = $2`, [company.id, company.loc]);

    expect((await create(admin, { code: 'ONE_CODE', employmentType: 'INTERN' })).statusCode).toBe(201);
    const again = await create(admin, { code: 'ONE_CODE', employmentType: 'FIXED_TERM' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('POLICY_EXISTS');
    expect(await policyCount(company)).toBe(before + 1);
  });

  it('refuses an equally specific policy that could apply to the same employee on an overlapping date, not a more specific one', async () => {
    const { company, admin } = await fresh();
    // The company default is open-ended: another default-level policy would tie with it for every employee.
    const tie = await create(admin, {});
    expect(tie.statusCode, tie.body).toBe(409);
    expect(tie.json()).toMatchObject({ error: 'POLICY_OVERLAP', details: { code: 'DEFAULT', revision: 1 } });

    const first = await create(admin, { code: 'INTERN_2026', employmentType: 'INTERN', effectiveFrom: '2026-01-01', effectiveTo: '2026-07-01' });
    expect(first.statusCode, first.body).toBe(201);
    // Overlapping periods, including one that starts the day before the first ends.
    expect((await create(admin, { employmentType: 'INTERN', effectiveFrom: '2026-06-30' })).json().error).toBe('POLICY_OVERLAP');
    expect((await create(admin, { employmentType: 'INTERN', effectiveFrom: '2025-01-01', effectiveTo: '2026-01-02' })).json().error).toBe('POLICY_OVERLAP');
    // The end date is exclusive, so the next period starts on it.
    expect((await create(admin, { code: 'INTERN_LATER', employmentType: 'INTERN', effectiveFrom: '2026-07-01' })).statusCode).toBe(201);
    expect((await create(admin, { code: 'INTERN_EARLIER', employmentType: 'INTERN', effectiveFrom: '2025-01-01', effectiveTo: '2026-01-01' })).statusCode).toBe(201);
    // Another value of the dimension never meets it.
    expect((await create(admin, { code: 'CONTRACTOR', employmentType: 'CONTRACTOR' })).statusCode).toBe(201);
    // A location policy ties with an intern policy for an intern at that location: both have one dimension.
    const crossing = await create(admin, { code: 'HQ', locationId: company.loc });
    expect(crossing.statusCode).toBe(409);
    expect(crossing.json().error).toBe('POLICY_OVERLAP');
    // Two dimensions outrank one (the most specific wins), so it is not an overlap.
    expect((await create(admin, { code: 'INTERN_HQ', employmentType: 'INTERN', locationId: company.loc, duration: 5 })).statusCode).toBe(201);
    const internHq = await probationer(company, admin, { joiningDate: '2026-03-01', employmentType: 'INTERN' });
    expect((await open(admin, internHq)).json().dueDate).toBe('2026-08-01');
  });

  it('the database guards the same rule whatever writes the row, and leaves narrowing, 0009 checks and provisioning alone', async () => {
    const { company, admin } = await fresh();
    const insert = (code: string, revision = 1, from = '2010-01-01', to: string | null = null) =>
      h.db.query(
        `insert into confirmation_policy (company_id, code, revision, duration, duration_unit, start_basis, month_end_rule, start_day_inclusive, effective_from, effective_to)
         values ($1, $2, $3, 1, 'CALENDAR_MONTHS', 'JOINING_DATE', 'CLAMP_TO_MONTH_END', false, $4, $5)`,
        [company.id, code, revision, from, to],
      );
    await expect(insert('RAW_TIE')).rejects.toMatchObject({ code: '23P01' });
    // The 0009 period check keeps its own answer, also when the end comes before the start.
    await expect(insert('RAW_PERIOD', 1, '2010-01-02', '2010-01-01')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('RAW_PERIOD', 1, '2010-01-01', '2010-01-01')).rejects.toMatchObject({ code: '23514' });
    // Ending the default frees the dates; widening the other over them is refused again, by the same guard.
    await h.db.query(`update confirmation_policy set effective_to = '2020-01-01' where company_id = $1 and code = 'DEFAULT'`, [company.id]);
    await insert('LATER', 1, '2020-01-01');
    await expect(h.db.query(`update confirmation_policy set effective_from = '2019-12-31' where company_id = $1 and code = 'LATER'`, [company.id])).rejects.toMatchObject({ code: '23P01' });

    // Provisioning an existing company again (seed.ts does) still does nothing, though DEFAULT 1 now overlaps nothing new.
    await provisionCompany(h.db, { companyId: company.id, approvedBy: admin.user, effectiveFrom: '2026-01-01' });
    expect((await list(admin)).items.filter((p) => p.code === 'DEFAULT')).toHaveLength(1);

    // An ambiguity recorded before the guard is still reported and can be resolved by retiring one of the policies.
    const { company: legacy, admin: legacyHr } = await fresh();
    await h.db.query(`alter table confirmation_policy disable trigger confirmation_policy_overlap_guard`);
    try {
      await h.db.query(
        `insert into confirmation_policy (company_id, code, revision, duration, duration_unit, start_basis, month_end_rule, start_day_inclusive, effective_from)
         values ($1, 'LEGACY_TIE', 1, 1, 'CALENDAR_MONTHS', 'JOINING_DATE', 'CLAMP_TO_MONTH_END', false, '2000-01-01')`,
        [legacy.id],
      );
    } finally {
      await h.db.query(`alter table confirmation_policy enable trigger confirmation_policy_overlap_guard`);
    }
    const stuck = await probationer(legacy, legacyHr, { joiningDate: '2026-03-02' });
    expect((await open(legacyHr, stuck)).json().error).toBe('POLICY_AMBIGUOUS');
    const tie = (await list(legacyHr)).items.find((p) => p.code === 'LEGACY_TIE')!;
    expect((await h.call(legacyHr, 'POST', `${PATH}/${tie.id}/retire`, { effectiveTo: '2026-01-01', expectedVersion: tie.version })).statusCode).toBe(200);
    expect((await open(legacyHr, stuck)).statusCode).toBe(201);
  });
});

describe('revisions (BR-029 "Policy versions are dated")', () => {
  it('closes the previous revision on the new date; a case keeps its policy and due date, later joiners take the new terms', async () => {
    const { company, admin } = await fresh();
    const rev1 = (await create(admin, { code: 'INTERN_TERMS', duration: 1, employmentType: 'INTERN' })).json() as PolicyView;
    const before = await probationer(company, admin, { joiningDate: '2026-01-31', employmentType: 'INTERN' });
    const opened = (await open(admin, before)).json();
    expect(opened.dueDate).toBe('2026-02-28');
    const inUse = (await list(admin)).items.find((p) => p.id === rev1.id)!;
    expect(inUse).toMatchObject({ inUse: true, latestCaseStart: '2026-01-31' });

    const res = await h.call(admin, 'POST', `${PATH}/${rev1.id}/revisions`, { ...terms({ duration: 2, effectiveFrom: '2026-03-01' }), expectedVersion: inUse.version });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ code: 'INTERN_TERMS', revision: 2, duration: 2, employmentType: 'INTERN', effectiveFrom: '2026-03-01', effectiveTo: null, closedRevisionId: rev1.id, latest: true });

    const after = (await list(admin)).items.filter((p) => p.code === 'INTERN_TERMS');
    expect(after.map((p) => [p.revision, p.effectiveFrom, p.effectiveTo, p.latest])).toEqual([
      [1, '2000-01-01', '2026-03-01', false],
      [2, '2026-03-01', null, true],
    ]);
    // The case opened earlier is untouched (FR-080).
    expect(await dueDateOf(admin, opened.caseId)).toBe('2026-02-28');
    const cases = await h.one<{ policy_id: string }>(`select policy_id from employee_confirmation where id = $1`, [opened.caseId]);
    expect(cases.policy_id).toBe(rev1.id);
    // Whoever joined before the date takes revision 1; on or after it, revision 2.
    const lastDay = await probationer(company, admin, { joiningDate: '2026-02-28', employmentType: 'INTERN' });
    const firstDay = await probationer(company, admin, { joiningDate: '2026-03-01', employmentType: 'INTERN' });
    expect((await open(admin, lastDay)).json().dueDate).toBe('2026-03-28');
    expect((await open(admin, firstDay)).json().dueDate).toBe('2026-05-01');

    expect(await auditActions(company, rev1.id)).toEqual(['CREATE', 'CLOSE']);
    expect(await auditActions(company, res.json().id)).toEqual(['CREATE_REVISION']);
  });

  it('keeps what the previous revision recorded beyond the new terms, not the defaults', async () => {
    const { company, admin } = await fresh();
    const rev1 = (await create(admin, { code: 'FIVE_EXTENSIONS', employmentType: 'INTERN' })).json() as PolicyView;
    await h.db.query(`update confirmation_policy set max_extensions = 5 where company_id = $1 and id = $2`, [company.id, rev1.id]);
    const version = (await list(admin)).items.find((p) => p.id === rev1.id)!.version;
    const rev2 = await h.call(admin, 'POST', `${PATH}/${rev1.id}/revisions`, { ...terms({ effectiveFrom: '2026-03-01' }), expectedVersion: version });
    expect(rev2.json()).toMatchObject({ revision: 2, maxExtensions: 5, employmentType: 'INTERN' });
  });

  it('refuses a start that does not follow the base, one that would cut off a case, a stale or superseded base, and bad terms', async () => {
    const { company, admin } = await fresh();
    const rev1 = (await create(admin, { code: 'REV_RULES', effectiveFrom: '2026-01-01', employmentType: 'INTERN' })).json() as PolicyView;
    const emp = await probationer(company, admin, { joiningDate: '2026-02-10', employmentType: 'INTERN' });
    expect((await open(admin, emp)).statusCode).toBe(201);
    const base = (await list(admin)).items.find((p) => p.id === rev1.id)!;
    const revise = (id: string, patch: Record<string, unknown>, expectedVersion = base.version) => h.call(admin, 'POST', `${PATH}/${id}/revisions`, { ...terms(patch), expectedVersion });

    const notAfter = await revise(rev1.id, { effectiveFrom: '2026-01-01' });
    expect(notAfter.statusCode).toBe(422);
    expect(notAfter.json().error).toBe('RULE_VIOLATION');
    const cutOff = await revise(rev1.id, { effectiveFrom: '2026-02-10' });
    expect(cutOff.statusCode).toBe(422);
    expect(cutOff.json()).toMatchObject({ error: 'POLICY_IN_USE', details: { latestCaseStart: '2026-02-10' } });
    expect((await revise(rev1.id, { effectiveFrom: '2026-03-01', duration: 0 })).json().error).toBe('INVALID_DURATION');
    expect((await revise(rev1.id, { effectiveFrom: '2026-03-01', effectiveTo: '2026-03-01' })).json().error).toBe('INVALID_PERIOD');
    const stale = await revise(rev1.id, { effectiveFrom: '2026-03-01' }, base.version + 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('STALE_VERSION');
    expect((await revise('00000000-0000-4000-8000-000000000000', { effectiveFrom: '2026-03-01' })).statusCode).toBe(404);
    // Nothing recorded by any of them.
    expect((await list(admin)).items.filter((p) => p.code === 'REV_RULES')).toHaveLength(1);

    expect((await revise(rev1.id, { effectiveFrom: '2026-03-01' })).statusCode).toBe(201);
    const superseded = await revise(rev1.id, { effectiveFrom: '2026-04-01' });
    expect(superseded.statusCode).toBe(409);
    expect(superseded.json().error).toBe('NOT_LATEST_REVISION');
    // A revision overlapping another policy of the same weight is refused, and the closing rolls back with it.
    const blocker = (await create(admin, { code: 'BLOCKER', employmentType: 'FIXED_TERM', effectiveFrom: '2030-01-01' })).json() as PolicyView;
    const early = (await create(admin, { code: 'EARLY', employmentType: 'FIXED_TERM', effectiveFrom: '2020-01-01', effectiveTo: '2025-01-01' })).json() as PolicyView;
    const overlap = await h.call(admin, 'POST', `${PATH}/${early.id}/revisions`, { ...terms({ effectiveFrom: '2029-01-01', effectiveTo: '2031-01-01' }), expectedVersion: early.version });
    expect(overlap.json()).toMatchObject({ error: 'POLICY_OVERLAP', details: { code: 'BLOCKER' } });
    expect(blocker.status).toBe('SCHEDULED');
    expect((await list(admin)).items.filter((p) => p.code === 'EARLY')).toHaveLength(1);
  });
});

describe('retiring (FR-080)', () => {
  it('ends a policy for later joiners only, keeps its cases and terms, and audits the change', async () => {
    const { company, admin } = await fresh();
    const p = (await create(admin, { code: 'TO_RETIRE', duration: 1, employmentType: 'INTERN' })).json() as PolicyView;
    const emp = await probationer(company, admin, { joiningDate: '2026-02-10', employmentType: 'INTERN' });
    const opened = (await open(admin, emp)).json();
    expect(opened.dueDate).toBe('2026-03-10');
    const inUse = (await list(admin)).items.find((x) => x.id === p.id)!;

    const retired = await h.call(admin, 'POST', `${PATH}/${p.id}/retire`, { effectiveTo: '2026-03-01', expectedVersion: inUse.version });
    expect(retired.statusCode, retired.body).toBe(200);
    expect(retired.json()).toMatchObject({ effectiveTo: '2026-03-01', status: 'ENDED', inUse: true });
    expect(await dueDateOf(admin, opened.caseId)).toBe('2026-03-10');
    // A later joiner falls back to the company default; an earlier one still has the policy.
    const later = await probationer(company, admin, { joiningDate: '2026-03-01', employmentType: 'INTERN' });
    const earlier = await probationer(company, admin, { joiningDate: '2026-02-28', employmentType: 'INTERN' });
    expect((await open(admin, later)).json().dueDate).toBe('2026-06-01');
    expect((await open(admin, earlier)).json().dueDate).toBe('2026-03-28');

    expect(await auditActions(company, p.id)).toEqual(['CREATE', 'RETIRE']);
    const trail = await h.one<{ before_values: { operational: { effectiveTo: string | null } }; after_values: { operational: { effectiveTo: string } } }>(
      `select before_values, after_values from audit_event where company_id = $1 and record_key = $2 and action = 'RETIRE'`,
      [company.id, p.id],
    );
    expect(trail.before_values.operational.effectiveTo).toBeNull();
    expect(trail.after_values.operational.effectiveTo).toBe('2026-03-01');

    // Migration 0009: the terms of a policy in use stay frozen whatever writes them.
    await expect(h.db.query(`update confirmation_policy set duration = 9 where id = $1`, [p.id])).rejects.toMatchObject({ code: '23514' });
  });

  it('with no policy left, a new joiner has no case and HR is told (FR-082)', async () => {
    const { company, admin } = await fresh();
    const d = await defaultOf(admin);
    expect((await h.call(admin, 'POST', `${PATH}/${d.id}/retire`, { effectiveTo: '2026-01-01', expectedVersion: d.version })).statusCode).toBe(200);
    const emp = await probationer(company, admin, { joiningDate: '2026-03-02' });
    expect((await open(admin, emp)).json().error).toBe('POLICY_NOT_FOUND');
    const attention = (await h.call(admin, 'GET', '/v1/confirmations/attention')).json().items as { employeeId: string; issues: string[] }[];
    expect(attention.find((i) => i.employeeId === emp)?.issues).toEqual(['POLICY_NOT_FOUND']);
  });

  it('refuses an end at or before the start, one not earlier than the current end, one cutting off a case, a stale version and a bad date', async () => {
    const { company, admin } = await fresh();
    const p = (await create(admin, { code: 'RETIRE_RULES', employmentType: 'INTERN', effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' })).json() as PolicyView;
    const emp = await probationer(company, admin, { joiningDate: '2026-02-10', employmentType: 'INTERN' });
    expect((await open(admin, emp)).statusCode).toBe(201);
    const base = (await list(admin)).items.find((x) => x.id === p.id)!;
    const retire = (effectiveTo: string, expectedVersion = base.version) => h.call(admin, 'POST', `${PATH}/${p.id}/retire`, { effectiveTo, expectedVersion });
    const refused = async (effectiveTo: string, status: number, error: string, version?: number) => {
      const res = await retire(effectiveTo, version);
      expect(res.statusCode, res.body).toBe(status);
      expect(res.json().error).toBe(error);
    };
    await refused('2026-01-01', 422, 'INVALID_PERIOD');
    await refused('2025-12-31', 422, 'INVALID_PERIOD');
    await refused('2027-01-01', 422, 'RULE_VIOLATION');
    await refused('2027-06-01', 422, 'RULE_VIOLATION');
    await refused('2026-02-10', 422, 'POLICY_IN_USE');
    await refused('2026-13-45', 422, 'INVALID_DATE');
    await refused('2026-06-01', 409, 'STALE_VERSION', base.version + 1);
    expect((await h.call(admin, 'POST', `${PATH}/00000000-0000-4000-8000-000000000000/retire`, { effectiveTo: '2026-06-01', expectedVersion: 1 })).statusCode).toBe(404);
    expect((await list(admin)).items.find((x) => x.id === p.id)).toMatchObject({ effectiveTo: '2027-01-01', version: base.version });
    expect(await auditActions(company, p.id)).toEqual(['CREATE']);
    expect((await retire('2026-02-11')).statusCode).toBe(200);
  });
});

describe('authority (C1, docs/09 §6.5)', () => {
  it('needs an unrestricted company-scope assignment to change a policy', async () => {
    const { company, admin } = await fresh();
    const filtered = await h.actor(company, 'HR_ADMINISTRATOR', { departmentFilter: company.financeDept });
    expect((await list(filtered)).items.length).toBeGreaterThan(0);
    const d = await defaultOf(admin);
    expect((await create(filtered, { employmentType: 'INTERN' })).statusCode).toBe(403);
    expect((await h.call(filtered, 'POST', `${PATH}/${d.id}/retire`, { effectiveTo: '2026-01-01', expectedVersion: d.version })).statusCode).toBe(403);
    expect((await h.call(filtered, 'POST', `${PATH}/${d.id}/revisions`, { ...terms({ effectiveFrom: '2026-01-01' }), expectedVersion: d.version })).statusCode).toBe(403);
  });

  it('every write re-checks the duty inside its transaction: a narrowing after the route guard records nothing', async () => {
    const { company, admin } = await fresh();
    const d = await defaultOf(admin);
    const narrowed = await h.actor(company, 'HR_ADMINISTRATOR');
    const grant = await narrowedGrant(h, company, narrowed, 'confirmation_policy.manage.operational');
    const input = { duration: 1, durationUnit: 'CALENDAR_MONTHS', startBasis: 'JOINING_DATE', effectiveFrom: '2030-01-01' } as const;
    await expect(withTransaction(h.pool, (tx) => createPolicy(tx, grant, { ...input, code: 'NARROWED', employmentType: 'INTERN' }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(withTransaction(h.pool, (tx) => createPolicyRevision(tx, grant, d.id, { ...input, expectedVersion: d.version }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(withTransaction(h.pool, (tx) => retirePolicy(tx, grant, d.id, { effectiveTo: '2030-01-01', expectedVersion: d.version }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await list(admin)).items.map((p) => [p.code, p.effectiveTo])).toEqual([['DEFAULT', null]]);
  });
});

describe('races (DF11, FR-080)', () => {
  it('of two overlapping policies written at the same moment, one stands', async () => {
    const { company, admin } = await fresh();
    const [a, b] = await Promise.all([create(admin, { code: 'RACE_A', employmentType: 'INTERN' }), create(admin, { code: 'RACE_B', employmentType: 'INTERN' })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((a.statusCode === 409 ? a : b).json().error).toBe('POLICY_OVERLAP');
    expect(await policyCount(company)).toBe(2);
  });

  it('a case opened while a retirement commits reads the retired policy, not the one before it', async () => {
    const { company, admin } = await fresh();
    const d = await defaultOf(admin);
    const emp = await probationer(company, admin, { joiningDate: '2026-03-02' });
    await h.db.query('begin');
    try {
      await h.db.query(`select pg_advisory_xact_lock(hashtextextended('confirmation-policy:' || $1::text, 0))`, [company.id]);
      await h.db.query(`update confirmation_policy set effective_to = '2026-01-01' where id = $1`, [d.id]);
      const opening = open(admin, emp);
      await untilWaiting('advisory');
      await h.db.query('commit');
      expect((await opening).json().error).toBe('POLICY_NOT_FOUND');
    } catch (err) {
      await h.db.query('rollback');
      throw err;
    }
  });

  it('a retirement that crosses a case being opened sees that case and is refused', async () => {
    const { company, admin } = await fresh();
    const d = await defaultOf(admin);
    const emp = await probationer(company, admin, { joiningDate: '2026-03-02' });
    const grant = (await resolveAccess(h.pool, { userId: admin.user, companyId: company.id, assignmentId: admin.assignment, resource: 'confirmation', action: 'manage', fieldGroups: ['operational'] })) as AccessGrant;
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let opened = () => {};
    const isOpen = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const opening = withTransaction(h.pool, async (tx) => {
      const result = await openConfirmation(tx, grant, emp);
      opened();
      await gate; // the case is written, not yet committed
      return result;
    });
    await isOpen;
    const retiring = h.call(admin, 'POST', `${PATH}/${d.id}/retire`, { effectiveTo: '2026-03-02', expectedVersion: d.version });
    await untilWaiting('advisory');
    release();
    await opening;
    const refused = await retiring;
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'POLICY_IN_USE', details: { latestCaseStart: '2026-03-02' } });
  });
});
