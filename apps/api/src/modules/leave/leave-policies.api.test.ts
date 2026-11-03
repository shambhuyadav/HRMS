// Leave type and policy maintenance over HTTP (FR-024; BR-010; DF05; E06; ZT09): draft revisions with an effective
// period and mappings, independent activation, overlap rejected or resolved by the documented priority, retirement, the
// mapped-policy export and the employees listed before accrual. All values are synthetic test values, not policy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { resolveAccess } from '../access/authorize.js';
import { processReportQueue } from '../report/service.js';
import { activatePolicy, createPolicyDraft, retirePolicy } from './policies.js';

let h: Harness;
let A: Company;
let author: TestActor;
let activator: TestActor;
let options: { employmentTypes: { id: string; code: string }[]; grades: { id: string; code: string }[]; locations: { id: string; code: string }[] };
let grade: string;

const typeCode = () => uniq('T').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 30);
const newType = async (paid = false, actor = author) => {
  const code = typeCode();
  const res = await h.call(actor, 'POST', '/v1/leave/types', { code, name: `Synthetic ${code}`, paid });
  expect(res.statusCode, res.body).toBe(201);
  return { code, id: res.json().id as string, version: res.json().version as number };
};
const VALUES = { eligibility: 'SYNTHETIC_GROUP', accrualRule: 'NONE', annualEntitlement: '0', minServiceDays: 0 };
const draft = async (leaveType: string, over: Record<string, unknown> = {}) => {
  const res = await h.call(author, 'POST', '/v1/leave/policies', { leaveType, effectiveFrom: '2026-01-01', ...VALUES, ...over });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; revision: number; version: number; state: string };
};
const policies = async (query = '', actor = author) => (await h.call(actor, 'GET', `/v1/leave/policies${query}`)).json().items as PolicyView[];
interface PolicyView {
  id: string;
  leaveType: string;
  revision: number;
  version: number;
  state: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  unmapped: boolean;
  warnings: { code: string; text: string }[];
  overlaps: { policyId: string; revision: number }[];
  mappings: { id: string; employmentType: string | null; grade: string | null; location: string | null; priority: number }[];
}
const view = async (id: string, leaveType: string) => (await policies(`?leaveType=${leaveType}`)).find((p) => p.id === id)!;
const map = async (policyId: string, leaveType: string, body: Record<string, unknown>) => {
  const res = await h.call(author, 'POST', `/v1/leave/policies/${policyId}/mappings`, { expectedVersion: (await view(policyId, leaveType)).version, ...body });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; policyVersion: number };
};
const employmentType = (code: string) => options.employmentTypes.find((t) => t.code === code)!.id;
const activate = async (policyId: string, leaveType: string, extra: Record<string, unknown> = {}, actor = activator) =>
  h.call(actor, 'POST', `/v1/leave/policies/${policyId}/activate`, { expectedVersion: (await view(policyId, leaveType)).version, ...extra });
/** A mapped draft, activated by someone else. */
const inForce = async (leaveType: string, over: Record<string, unknown> = {}, mapping: Record<string, unknown> = { employmentTypeId: employmentType('PERMANENT') }) => {
  const p = await draft(leaveType, over);
  await map(p.id, leaveType, mapping);
  const res = await activate(p.id, leaveType);
  expect(res.statusCode, res.body).toBe(200);
  return p;
};

let reviewer: TestActor;
async function employee(over: Record<string, unknown> = {}): Promise<{ id: string; code: string; actor: TestActor }> {
  const e = (await h.call(author, 'POST', '/v1/employees', h.newEmployeeBody(A, over))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  return { id: e.id, code: e.employeeCode, actor: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) };
}
const mondayIn = (days: number) => {
  const d = new Date(Date.now() + days * 86_400_000);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const request = (a: TestActor, leaveType: string, day: string) => h.call(a, 'POST', '/v1/leave/requests', { leaveType, startDate: day, endDate: day });
const policyOfRequest = async (requestId: string) => (await h.one<{ policy_id: string }>(`select policy_id from leave_request where id = $1`, [requestId])).policy_id;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  author = await h.actor(A, 'HR_ADMINISTRATOR');
  activator = await h.actor(A, 'HR_ADMINISTRATOR');
  reviewer = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, reviewer.user]);
  grade = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active) values ($1, 'G1', 'Grade 1', true) returning id`, [A.id])).id;
  options = (await h.call(author, 'GET', '/v1/leave/policy-options')).json();
  expect(options.grades.map((g) => g.code)).toEqual(['G1']);
  expect(options.locations.map((l) => l.code)).toEqual(['HQ']);
  expect(options.employmentTypes.map((t) => t.code)).toContain('PERMANENT');
});

afterAll(async () => {
  await h?.stop();
});

describe('leave types (FR-024)', () => {
  it('HR creates and renames a type; the code, unit and paid flag stay fixed; duplicates and stale versions are refused', async () => {
    const t = await newType();
    expect((await h.call(author, 'POST', '/v1/leave/types', { code: t.code, name: 'Again', paid: true })).json().error).toBe('LEAVE_TYPE_EXISTS');
    expect((await h.call(author, 'POST', '/v1/leave/types', { code: 'lower', name: 'Bad', paid: true })).statusCode).toBe(400);
    expect((await h.call(author, 'POST', '/v1/leave/types', { code: 'NONAME', name: '   ', paid: true })).statusCode).toBe(400);
    const renamed = await h.call(author, 'PATCH', `/v1/leave/types/${t.id}`, { expectedVersion: t.version, name: 'Study leave (synthetic)' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect((await h.call(author, 'PATCH', `/v1/leave/types/${t.id}`, { expectedVersion: t.version, name: 'Stale' })).json().error).toBe('STALE_VERSION');
    const listed = ((await h.call(author, 'GET', '/v1/leave/types')).json().items as { id: string; name: string; paid: boolean }[]).find((x) => x.id === t.id);
    expect(listed).toMatchObject({ name: 'Study leave (synthetic)', paid: false });
    await expect(h.db.query(`update leave_type set paid = true where id = $1`, [t.id])).rejects.toThrow(/fixed/);
  });

  it('a type with a revision in force cannot be deactivated; after retirement it can', async () => {
    const t = await newType();
    const p = await inForce(t.code);
    const version = async () => ((await h.call(author, 'GET', '/v1/leave/types')).json().items as { id: string; version: number }[]).find((x) => x.id === t.id)!.version;
    const off = async () => h.call(author, 'PATCH', `/v1/leave/types/${t.id}`, { expectedVersion: await version(), active: false });
    expect((await off()).json().error).toBe('ACTIVE_POLICY_EXISTS');
    const { today } = await h.one<{ today: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as today`, [A.id]);
    const retired = await h.call(activator, 'POST', `/v1/leave/policies/${p.id}/retire`, { expectedVersion: (await view(p.id, t.code)).version, effectiveTo: today, reason: 'Synthetic retirement' });
    expect(retired.statusCode, retired.body).toBe(200);
    expect((await off()).statusCode).toBe(200);
  });

  it('an employee cannot read or change these; a filtered company scope cannot change them', async () => {
    const e = await employee();
    expect((await h.call(e.actor, 'GET', '/v1/leave/types')).statusCode).toBe(403);
    expect((await h.call(e.actor, 'POST', '/v1/leave/types', { code: 'NOPE', name: 'Nope', paid: false })).statusCode).toBe(403);
    expect((await h.call(e.actor, 'POST', '/v1/leave/policies', { leaveType: 'UNPAID', effectiveFrom: '2026-01-01', ...VALUES })).statusCode).toBe(403);
    const dept = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await h.call(dept, 'POST', '/v1/leave/types', { code: 'NARROW', name: 'Narrow', paid: false })).statusCode).toBe(403);
    expect((await h.call(dept, 'POST', '/v1/leave/policies', { leaveType: 'UNPAID', effectiveFrom: '2026-01-01', ...VALUES })).statusCode).toBe(403);
    expect((await h.call(dept, 'GET', '/v1/leave/policies')).statusCode).toBe(200);
  });
});

describe('draft revisions and mappings (FR-024, BR-010)', () => {
  it('numbers revisions per type, takes every value from the request, and changes a draft only', async () => {
    const t = await newType(true);
    const first = await draft(t.code, { accrualRule: 'MONTHLY_PRORATED', annualEntitlement: '7.5', minServiceDays: 30, carryCap: '2', effectiveTo: '2027-01-01' });
    const second = await draft(t.code, { effectiveFrom: '2027-01-01' });
    expect([first.revision, second.revision]).toEqual([1, 2]);
    expect(await view(first.id, t.code)).toMatchObject({ annualEntitlement: '7.5000', minServiceDays: 30, carryCap: '2.0000', state: 'DRAFT', effectiveTo: '2027-01-01' });
    expect(await view(second.id, t.code)).toMatchObject({ carryCap: '0.0000' }); // DF05: carry is zero unless configured

    const bad = async (over: Record<string, unknown>) => (await h.call(author, 'POST', '/v1/leave/policies', { leaveType: t.code, effectiveFrom: '2026-01-01', ...VALUES, ...over })).json().error;
    expect(await bad({ effectiveTo: '2026-01-01' })).toBe('INVALID_PERIOD');
    expect(await bad({ annualEntitlement: '5' })).toBe('RULE_VIOLATION');
    expect(await bad({ leaveType: 'NOSUCHTYPE' })).toBe('INVALID_REFERENCE');
    expect((await h.call(author, 'POST', '/v1/leave/policies', { leaveType: t.code, effectiveFrom: '2026-01-01' })).statusCode).toBe(400); // nothing is defaulted

    const patched = await h.call(author, 'PATCH', `/v1/leave/policies/${first.id}`, { expectedVersion: first.version, minServiceDays: 45, effectiveTo: null });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(await view(first.id, t.code)).toMatchObject({ minServiceDays: 45, effectiveTo: null, annualEntitlement: '7.5000' });
    expect((await h.call(author, 'PATCH', `/v1/leave/policies/${first.id}`, { expectedVersion: first.version, minServiceDays: 50 })).json().error).toBe('STALE_VERSION');
  });

  it('adds and removes grade, location and employment-type mappings on a draft; refuses empty, duplicate and foreign ones', async () => {
    const t = await newType();
    const p = await draft(t.code);
    expect(await view(p.id, t.code)).toMatchObject({ unmapped: true, mappings: [], warnings: [{ code: 'UNMAPPED' }] });
    expect((await view(p.id, t.code)).warnings[0]!.text).toMatch(/applies to nobody/);

    const add = async (body: Record<string, unknown>) => h.call(author, 'POST', `/v1/leave/policies/${p.id}/mappings`, { expectedVersion: (await view(p.id, t.code)).version, ...body });
    expect((await add({})).json().error).toBe('MAPPING_EMPTY');
    expect((await add({ gradeId: A.id })).json().error).toBe('INVALID_REFERENCE');
    const created = await add({ gradeId: grade, locationId: A.loc });
    expect(created.statusCode, created.body).toBe(201);
    expect(await view(p.id, t.code)).toMatchObject({ unmapped: false, warnings: [], mappings: [{ grade: 'G1', location: 'HQ', employmentType: null, priority: 2 }] });
    expect((await add({ gradeId: grade, locationId: A.loc })).json().error).toBe('MAPPING_EXISTS');

    // A mapping change moves the draft's version, so an activator who reviewed the earlier mappings gets a stale refusal.
    const reviewed = (await view(p.id, t.code)).version;
    await add({ employmentTypeId: employmentType('PERMANENT') });
    expect((await h.call(activator, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: reviewed })).json().error).toBe('STALE_VERSION');

    const removed = await h.call(author, 'POST', `/v1/leave/policies/${p.id}/mappings/${created.json().id}/remove`, { expectedVersion: (await view(p.id, t.code)).version });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await view(p.id, t.code)).mappings.map((m) => m.employmentType)).toEqual(['PERMANENT']);
  });

  it('nothing of an activated revision changes, through the API or the database', async () => {
    const t = await newType();
    const p = await inForce(t.code);
    const v = await view(p.id, t.code);
    expect((await h.call(author, 'PATCH', `/v1/leave/policies/${p.id}`, { expectedVersion: v.version, minServiceDays: 9 })).json().error).toBe('POLICY_NOT_DRAFT');
    expect((await h.call(author, 'POST', `/v1/leave/policies/${p.id}/mappings`, { expectedVersion: v.version, gradeId: grade })).json().error).toBe('POLICY_NOT_DRAFT');
    expect((await h.call(author, 'POST', `/v1/leave/policies/${p.id}/mappings/${v.mappings[0]!.id}/remove`, { expectedVersion: v.version })).json().error).toBe('POLICY_NOT_DRAFT');
    await expect(h.db.query(`insert into leave_policy_mapping (company_id, policy_id, grade_id) values ($1, $2, $3)`, [A.id, p.id, grade])).rejects.toThrow(/immutable/);
    await expect(h.db.query(`delete from leave_policy_mapping where policy_id = $1`, [p.id])).rejects.toThrow(/immutable/);
    await expect(h.db.query(`update leave_policy set effective_to = null, min_service_days = 9 where id = $1`, [p.id])).rejects.toThrow(/immutable/);
  });
});

describe('activation: independent, and overlaps rejected or resolved (FR-024 acceptance, ZT09)', () => {
  it('whoever wrote the draft, its author or a later editor, cannot activate it', async () => {
    const t = await newType();
    const p = await draft(t.code);
    expect((await activate(p.id, t.code, {}, author)).json().error).toBe('SELF_APPROVAL');
    const editor = await h.actor(A, 'HR_ADMINISTRATOR');
    const edited = await h.call(editor, 'PATCH', `/v1/leave/policies/${p.id}`, { expectedVersion: p.version, minServiceDays: 1 });
    expect(edited.statusCode).toBe(200);
    expect((await activate(p.id, t.code, {}, editor)).json().error).toBe('SELF_APPROVAL');
    expect((await activate(p.id, t.code)).statusCode).toBe(200);
    // The database's own guard on a later editor.
    const q = await draft(t.code, { effectiveFrom: '2030-01-01' });
    await h.db.query(`update leave_policy set updated_by = $2 where id = $1`, [q.id, editor.user]);
    await expect(h.db.query(`update leave_policy set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [q.id, editor.user])).rejects.toThrow(/last editor/);
  });

  it('refuses an overlap at equal priority and says with what; a different dimension value or period is no overlap', async () => {
    const t = await newType();
    const first = await inForce(t.code, { effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' });

    const same = await draft(t.code, { effectiveFrom: '2026-06-01' });
    await map(same.id, t.code, { employmentTypeId: employmentType('PERMANENT') });
    expect((await view(same.id, t.code)).warnings.map((w) => w.code)).toEqual(['OVERLAPPING_MAPPING']);
    expect((await view(same.id, t.code)).overlaps).toEqual([{ policyId: first.id, revision: first.revision }]);
    const refused = await activate(same.id, t.code);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'POLICY_OVERLAP', details: { revisions: [{ policyId: first.id, revision: 1, effectiveFrom: '2026-01-01', effectiveTo: '2027-01-01' }] } });
    expect((await view(same.id, t.code)).state).toBe('DRAFT');

    // Different dimensions of equal priority: one employee could match both, so this ties as well.
    const crossing = await draft(t.code, { effectiveFrom: '2026-06-01' });
    await map(crossing.id, t.code, { gradeId: grade });
    expect((await activate(crossing.id, t.code)).json().error).toBe('POLICY_OVERLAP');

    // No tie: another employment type, or a later period.
    expect((await inForce(t.code, { effectiveFrom: '2026-06-01' }, { employmentTypeId: employmentType('INTERN') })).state).toBe('DRAFT');
    expect((await inForce(t.code, { effectiveFrom: '2027-01-01' })).revision).toBe(5);
  });

  it('the database refuses the overlap whatever path activates it', async () => {
    const t = await newType();
    await inForce(t.code);
    const other = await draft(t.code, { effectiveFrom: '2026-02-01' });
    await map(other.id, t.code, { employmentTypeId: employmentType('PERMANENT') });
    await expect(h.db.query(`update leave_policy set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [other.id, activator.user])).rejects.toThrow(/overlaps another revision/);
  });

  it('two activations racing for the same employees: one wins, the other is refused', async () => {
    const t = await newType();
    const [one, two] = [await draft(t.code), await draft(t.code)];
    await map(one.id, t.code, { employmentTypeId: employmentType('PERMANENT') });
    await map(two.id, t.code, { employmentTypeId: employmentType('PERMANENT') });
    const [v1, v2] = [await view(one.id, t.code), await view(two.id, t.code)];
    // A staged race: the audit table is held, so an activation that got past its checks cannot commit yet. Without
    // serialisation both pass, neither seeing the other's uncommitted activation, and both would commit.
    await h.db.query('begin');
    let results: Awaited<ReturnType<typeof h.call>>[];
    try {
      await h.db.query('lock table audit_event in share row exclusive mode');
      const running = Promise.all([
        h.call(activator, 'POST', `/v1/leave/policies/${one.id}/activate`, { expectedVersion: v1.version }),
        h.call(activator, 'POST', `/v1/leave/policies/${two.id}/activate`, { expectedVersion: v2.version }),
      ]);
      let waiting = 0;
      for (let i = 0; i < 400 && waiting < 2; i++) {
        waiting = ((await h.pool.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).rows[0] as { n: number }).n;
        if (waiting < 2) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(2);
      await h.db.query('commit');
      results = await running;
    } catch (err) {
      await h.db.query('rollback').catch(() => undefined);
      throw err;
    }
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await policies(`?leaveType=${t.code}&state=ACTIVE`)).length).toBe(1);
  });

  it('closePredecessors ends an earlier revision when the new one starts; earlier dates keep their policy (ZT09); nothing later is ever closed', async () => {
    const t = await newType();
    const e = await employee({ employmentType: 'PERMANENT' });
    const later = mondayIn(70);
    const old = await inForce(t.code);
    const next = await draft(t.code, { effectiveFrom: later });
    await map(next.id, t.code, { employmentTypeId: employmentType('PERMANENT') });
    const closed = await activate(next.id, t.code, { closePredecessors: true });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json()).toMatchObject({ state: 'ACTIVE', closed: [old.id] });
    expect(await view(old.id, t.code)).toMatchObject({ state: 'ACTIVE', effectiveTo: later });

    const before = await request(e.actor, t.code, mondayIn(14));
    const after = await request(e.actor, t.code, later);
    expect(before.statusCode, before.body).toBe(201);
    expect(after.statusCode, after.body).toBe(201);
    expect(await policyOfRequest(before.json().requestId)).toBe(old.id);
    expect(await policyOfRequest(after.json().requestId)).toBe(next.id);
    const audit = await h.one<{ after_values: { operational: Record<string, unknown> } }>(`select after_values from audit_event where resource_code = 'leave_policy' and record_key = $1 and action = 'CLOSE'`, [old.id]);
    expect(audit.after_values.operational).toMatchObject({ effectiveTo: later, supersededBy: next.id });

    // A revision starting no later than the one being activated is not its predecessor: refused, nothing closed.
    const earlier = await draft(t.code, { effectiveFrom: mondayIn(35) });
    await map(earlier.id, t.code, { employmentTypeId: employmentType('PERMANENT') });
    expect((await activate(earlier.id, t.code, { closePredecessors: true })).json().error).toBe('POLICY_OVERLAP');
    expect((await view(next.id, t.code)).effectiveTo).toBeNull();
  });

  it('the documented priority: the mapping with more dimensions wins, so an employee has one policy', async () => {
    const t = await newType();
    const broad = await inForce(t.code);
    const narrow = await inForce(t.code, {}, { employmentTypeId: employmentType('PERMANENT'), gradeId: grade });
    const graded = await employee({ employmentType: 'PERMANENT', gradeId: grade });
    const plain = await employee({ employmentType: 'PERMANENT' });
    const day = mondayIn(21);
    expect(await policyOfRequest((await request(graded.actor, t.code, day)).json().requestId)).toBe(narrow.id);
    expect(await policyOfRequest((await request(plain.actor, t.code, day)).json().requestId)).toBe(broad.id);
  });

  it('the authority is checked again inside the transaction: a duty withdrawn after the guard refuses and changes nothing', async () => {
    const t = await newType();
    const p = await draft(t.code);
    const late = await h.actor(A, 'HR_ADMINISTRATOR');
    const grantFor = async (action: string) => {
      const d = await resolveAccess(h.pool, { userId: late.user, companyId: A.id, assignmentId: late.assignment, resource: 'leave_policy', action, fieldGroups: ['operational'] });
      if (!d.allowed) throw new Error('no grant');
      return d;
    };
    const [manage, activateGrant] = [await grantFor('manage'), await grantFor('activate')];
    await h.db.query(
      `update role_assignment_permission rap set active = false from permission p where p.id = rap.permission_id and rap.role_assignment_id = $1 and p.resource = 'leave_policy'`,
      [late.assignment],
    );
    const refused = { statusCode: 403 };
    await expect(withTransaction(h.pool, (tx) => createPolicyDraft(tx, manage, { leaveType: t.code, effectiveFrom: '2026-01-01', eligibility: 'X', accrualRule: 'NONE', annualEntitlement: '0', minServiceDays: 0 }))).rejects.toMatchObject(refused);
    await expect(withTransaction(h.pool, (tx) => activatePolicy(tx, activateGrant, p.id, { expectedVersion: p.version }))).rejects.toMatchObject(refused);
    await expect(withTransaction(h.pool, (tx) => retirePolicy(tx, activateGrant, p.id, { expectedVersion: p.version, effectiveTo: '2099-01-01', reason: 'x' }))).rejects.toMatchObject(refused);
    expect((await policies(`?leaveType=${t.code}`)).map((x) => x.state)).toEqual(['DRAFT']);
  });
});

describe('retirement (FR-024)', () => {
  const retire = async (id: string, leaveType: string, effectiveTo: string, actor = activator) =>
    h.call(actor, 'POST', `/v1/leave/policies/${id}/retire`, { expectedVersion: (await view(id, leaveType)).version, effectiveTo, reason: 'Synthetic retirement' });

  it('applies to dates before its end only; the end is today or later; only an active revision retires; the audit keeps the reason', async () => {
    const t = await newType();
    const e = await employee({ employmentType: 'PERMANENT' });
    const p = await inForce(t.code);
    const end = mondayIn(28);
    expect((await retire(p.id, t.code, '2026-01-02')).json().error).toBe('BACKDATED_RETIREMENT');
    const done = await retire(p.id, t.code, end);
    expect(done.statusCode, done.body).toBe(200);
    expect(await view(p.id, t.code)).toMatchObject({ state: 'RETIRED', effectiveTo: end });
    expect((await retire(p.id, t.code, end)).json().error).toBe('INVALID_STATE');
    const audit = await h.one<{ reason: string }>(`select reason from audit_event where resource_code = 'leave_policy' and record_key = $1 and action = 'RETIRE'`, [p.id]);
    expect(audit.reason).toBe('Synthetic retirement');

    expect((await request(e.actor, t.code, mondayIn(7))).statusCode).toBe(201);
    const after = await request(e.actor, t.code, end);
    expect([after.statusCode, after.json().error]).toEqual([422, 'POLICY_NOT_FOUND']);
    await expect(h.db.query(`update leave_policy set effective_to = '2099-01-01' where id = $1`, [p.id])).rejects.toThrow(/end earlier/);
  });

  it('a revision that has not started leaves force entirely and never applies again', async () => {
    const t = await newType();
    const e = await employee({ employmentType: 'PERMANENT' });
    const start = mondayIn(49);
    const p = await inForce(t.code, { effectiveFrom: start });
    expect((await retire(p.id, t.code, mondayIn(14))).statusCode).toBe(200);
    expect(await view(p.id, t.code)).toMatchObject({ state: 'RETIRED', effectiveTo: null });
    expect((await request(e.actor, t.code, start)).json().error).toBe('POLICY_NOT_FOUND');
    await expect(h.db.query(`update leave_policy set effective_to = '2099-01-01' where id = $1`, [p.id])).rejects.toThrow(/out of force/);
  });

  it('needs the activation duty and an unrestricted company scope', async () => {
    const t = await newType();
    const p = await inForce(t.code);
    const manageOnly = await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['leave_policy.manage.operational'] });
    expect((await retire(p.id, t.code, '2099-01-01', manageOnly)).statusCode).toBe(403);
    const dept = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await retire(p.id, t.code, '2099-01-01', dept)).statusCode).toBe(403);
    expect((await view(p.id, t.code)).state).toBe('ACTIVE');
  });
});

describe('filters and the mapped-policy export (E06)', () => {
  it('filters by leave type, effective-from and state; the export shows mappings and says UNMAPPED in words', async () => {
    const t = await newType();
    const mapped = await inForce(t.code, { effectiveFrom: '2026-03-01' });
    const bare = await draft(t.code, { effectiveFrom: '2026-09-01' });
    expect((await policies(`?leaveType=${t.code}`)).map((p) => p.id)).toEqual([mapped.id, bare.id]);
    expect((await policies(`?leaveType=${t.code}&effectiveFrom=2026-06-01`)).map((p) => p.id)).toEqual([bare.id]);
    expect((await policies(`?leaveType=${t.code}&state=ACTIVE`)).map((p) => p.id)).toEqual([mapped.id]);

    const generated = async (actor: TestActor, filters: Record<string, unknown>) => {
      const res = await h.call(actor, 'POST', '/v1/reports', { reportCode: 'LEAVE_POLICY_MAPPING', filters });
      if (res.statusCode >= 300) return res;
      await processReportQueue(h.pool, 5);
      return h.call(actor, 'GET', `/v1/reports/${res.json().id}/download`);
    };
    const file = (await generated(author, { leaveType: t.code })).body.split(/\r?\n/).filter((l) => l !== '');
    expect(file).toHaveLength(3);
    expect(file[0]).toContain('"Leave type","Revision","State"');
    expect(file[1]).toContain('ACTIVE');
    expect(file[1]).toContain('PERMANENT');
    expect(file[1]!.endsWith('"MAPPED"')).toBe(true);
    expect(file[2]).toContain('DRAFT');
    expect(file[2]!.endsWith('"UNMAPPED"')).toBe(true);
    const onlyDraft = (await generated(author, { leaveType: t.code, status: 'DRAFT' })).body.split(/\r?\n/).filter((l) => l !== '');
    expect(onlyDraft).toHaveLength(2);
    const dated = (await generated(author, { leaveType: t.code, from: '2026-06-01' })).body.split(/\r?\n/).filter((l) => l !== '');
    expect(dated).toHaveLength(2);

    // Company configuration: not from a filtered scope, and not without the export duty.
    const dept = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await generated(dept, { leaveType: t.code })).statusCode).toBe(403);
    const noExport = await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['leave_policy.manage.operational'] });
    expect((await generated(noExport, { leaveType: t.code })).statusCode).toBe(403);
  });
});

describe('employees listed before accrual (FR-024 acceptance)', () => {
  // A company of its own: its paid types and employees are this test's alone.
  let B: Company;
  let hrB: TestActor;
  let activatorB: TestActor;
  const month = '2026-02';
  const url = (a: string = month, extra = '') => `/v1/leave/accruals/employees-without-policy?month=${a}${extra}`;
  type Row = { employeeId: string; employeeCode: string; employmentType: string; unresolved: { leaveType: string; reason: string }[]; mappedLeaveTypes: string[] };
  const listed = async (a: TestActor, extra = '') => {
    const res = await h.call(a, 'GET', url(month, extra));
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { items: Row[]; total: number; page: number; pageSize: number };
  };
  const person = async (over: Record<string, unknown> = {}) => {
    const e = (await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B, over))).json();
    await h.setStatus(B, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };

  beforeAll(async () => {
    B = await h.makeCompany();
    hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    activatorB = await h.actor(B, 'HR_ADMINISTRATOR');
    for (const p of (await h.call(hrB, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
      expect((await h.call(hrB, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);
    }
  });

  it('lists who resolves to no policy, with the reason per type; those who resolve are not listed; the accrual run agrees', async () => {
    const permanent = await person({ employmentType: 'PERMANENT' });
    const contractor = await person({ employmentType: 'CONTRACTOR' });
    const page = await listed(hrB);
    expect(page.items.map((r) => r.employeeId)).toEqual([contractor]);
    expect(page.total).toBe(1);
    expect(page.items[0]).toMatchObject({
      employmentType: 'CONTRACTOR',
      unresolved: [
        { leaveType: 'ANNUAL', reason: 'POLICY_NOT_FOUND' },
        { leaveType: 'CASUAL', reason: 'POLICY_NOT_FOUND' },
        { leaveType: 'SICK', reason: 'POLICY_NOT_FOUND' },
      ],
      mappedLeaveTypes: ['UNPAID'],
    });
    expect(permanent).toBeDefined();
    // What the run then does: the listed employee gets no credit, the other one does.
    await h.runBulkJob(hrB, '/v1/leave/accruals', { month });
    const credited = async (id: string) => (await h.one<{ n: number }>(`select count(*)::int as n from leave_movement where employee_id = $1 and movement_kind = 'ACCRUAL'`, [id])).n;
    expect(await credited(contractor)).toBe(0);
    expect(await credited(permanent)).toBeGreaterThan(0);
  });

  it('names a tie, which would stop the run; keeps to the row scope; pages with totals; refuses those without the duty', async () => {
    const before = (await listed(hrB)).total;
    // A tie from before the activation guard (0110), staged with the guard off.
    const tieType = 'TIE' + uniq('').replace(/[^A-Za-z0-9]/g, '').slice(0, 10).toUpperCase();
    expect((await h.call(hrB, 'POST', '/v1/leave/types', { code: tieType, name: 'Tie', paid: true })).statusCode).toBe(201);
    const fin = await person({ employmentType: 'PERMANENT', departmentId: B.financeDept });
    const types = (await h.call(hrB, 'GET', '/v1/leave/policy-options')).json().employmentTypes as { id: string; code: string }[];
    const perm = types.find((x) => x.code === 'PERMANENT')!.id;
    await h.db.query(`alter table leave_policy disable trigger leave_policy_no_overlap`);
    try {
      for (let i = 0; i < 2; i++) {
        const p = (await h.call(hrB, 'POST', '/v1/leave/policies', { leaveType: tieType, effectiveFrom: '2026-01-01', ...VALUES })).json();
        await h.call(hrB, 'POST', `/v1/leave/policies/${p.id}/mappings`, { expectedVersion: p.version, employmentTypeId: perm });
        const v = (await h.call(hrB, 'GET', `/v1/leave/policies?leaveType=${tieType}`)).json().items.find((x: { id: string }) => x.id === p.id);
        await h.db.query(`update leave_policy set state = 'ACTIVE', activated_by = $2, activated_at = now(), updated_by = $2 where id = $1 and version = $3`, [p.id, activatorB.user, v.version]);
      }
    } finally {
      await h.db.query(`alter table leave_policy enable trigger leave_policy_no_overlap`);
    }
    const page = await listed(hrB);
    expect(page.total).toBeGreaterThan(before);
    const row = page.items.find((r) => r.employeeId === fin)!;
    expect(row.unresolved).toEqual([{ leaveType: tieType, reason: 'POLICY_AMBIGUOUS' }]);
    expect(row.mappedLeaveTypes).toContain(tieType);

    // Row scope: a finance-filtered HR sees the finance employee and nobody from elsewhere.
    const finHr = await h.actor(B, 'HR_ADMINISTRATOR', { departmentFilter: B.financeDept });
    const scoped = await listed(finHr);
    expect(scoped.items.map((r) => r.employeeId)).toEqual([fin]);
    expect(scoped.total).toBe(1);
    const engHr = await h.actor(B, 'HR_ADMINISTRATOR', { departmentFilter: B.dept });
    expect((await listed(engHr)).items.map((r) => r.employeeId)).not.toContain(fin);

    expect((await listed(hrB, '&pageSize=25&page=99')).items).toEqual([]);
    expect((await listed(hrB, '&pageSize=25&page=99')).total).toBe(page.total);
    const self = await h.actor(B, 'EMPLOYEE', { employeeId: fin });
    expect((await h.call(self, 'GET', url())).statusCode).toBe(403);
    expect((await h.call(hrB, 'GET', url('2026-13'))).statusCode).toBe(400);
  });
});
