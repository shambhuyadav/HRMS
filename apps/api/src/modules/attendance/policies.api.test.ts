// Attendance policy maintenance over HTTP (FR-020; BR-009; DF05; C4; 0115): draft revisions with thresholds, effective
// period and mappings, independent activation that closes the revision it replaces, ties refused, retirement, and
// evaluation by the revision in force on the day. Synthetic data only: thresholds here are test values, not policy.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { activateAttendancePolicy, createAttendancePolicy, retireAttendancePolicy } from './policies.js';

let h: Harness;
let A: Company;
let B: Company;
let author: TestActor;
let activator: TestActor;
let shiftId: string;
let defaultPolicyId: string;

const POLICIES = '/v1/attendance/policies';
const values = (overrides: Record<string, unknown> = {}) => ({
  effectiveFrom: '2026-03-16',
  graceMinutes: 5,
  presentPercent: '60',
  halfDayPercent: '40',
  overtimeEnabled: false,
  ...overrides,
});
type Policy = {
  id: string;
  code: string;
  revision: number;
  version: number;
  state: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  graceMinutes: number;
  presentPercent: string;
  halfDayPercent: string;
  overtimeEnabled: boolean;
  mappings: { id: string; gradeId: string | null; grade: string | null; locationId: string | null; location: string | null; priority: number }[];
  warnings: { code: string; text: string }[];
};
const list = async (a: TestActor = author) => (await h.call(a, 'GET', POLICIES)).json().items as Policy[];
const policy = async (id: string, a: TestActor = author) => (await list(a)).find((p) => p.id === id)!;
const newCode = () => `P_${uniq('c').replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`.slice(0, 40);

/** A grade and location of their own, so the mappings of one test tie with no other test's (policies apply company-wide). */
async function covering(): Promise<{ gradeId: string; locationId: string }> {
  const code = uniq('S').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const gradeId = (await h.one<{ id: string }>(`insert into grade (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const locationId = (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  return { gradeId, locationId };
}

async function draft(code: string, overrides: Record<string, unknown>, map: Record<string, unknown> | null) {
  const created = await h.call(author, 'POST', POLICIES, { code, ...values(overrides) });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id as string;
  if (map) {
    const mapped = await h.call(author, 'POST', `${POLICIES}/${id}/mappings`, { expectedVersion: created.json().version, ...map });
    expect(mapped.statusCode, mapped.body).toBe(201);
  }
  return policy(id);
}
const activate = (a: TestActor, id: string, expectedVersion: number) => h.call(a, 'POST', `${POLICIES}/${id}/activate`, { expectedVersion });
const retire = (a: TestActor, id: string, expectedVersion: number, effectiveTo: string, reason = 'Synthetic: replaced') => h.call(a, 'POST', `${POLICIES}/${id}/retire`, { expectedVersion, effectiveTo, reason });
const businessDate = async () => (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;

async function employeeWorking(day: string, from: string, to: string, placed?: { gradeId: string; locationId: string }) {
  const e = (await h.call(author, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  await h.call(author, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
  if (placed) await h.db.query(`update employment_assignment set grade_id = $2, location_id = $3 where employee_id = $1`, [e.id, placed.gradeId, placed.locationId]);
  const employee = { id: e.id as string, code: e.employeeCode as string };
  await worked(employee.code, day, from, to);
  return employee;
}
async function worked(employeeCode: string, day: string, from: string, to: string) {
  const res = await h.call(author, 'POST', '/v1/attendance/punches', {
    punches: [
      { employeeCode, occurredAt: `${day}T${from}:00+05:30`, direction: 'IN', externalEventKey: uniq('evt-') },
      { employeeCode, occurredAt: `${day}T${to}:00+05:30`, direction: 'OUT', externalEventKey: uniq('evt-') },
    ],
  });
  expect(res.json().accepted).toBe(2);
}
const recordOn = async (employee: string, d: string) => (await h.call(author, 'GET', `/v1/employees/${employee}/attendance?from=${d}&to=${d}`)).json().items[0];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  author = await h.actor(A, 'HR_ADMINISTRATOR');
  activator = await h.actor(A, 'HR_ADMINISTRATOR');
  shiftId = (await h.call(author, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
  const seeded = (await list()).find((p) => p.code === 'DEFAULT')!;
  defaultPolicyId = seeded.id;
  expect(seeded).toMatchObject({ state: 'DRAFT', graceMinutes: 10, presentPercent: '75.00', halfDayPercent: '50.00', overtimeEnabled: false, mappings: [{ gradeId: null, locationId: null, priority: 0 }] });
  expect((await activate(activator, seeded.id, seeded.version)).json()).toMatchObject({ id: seeded.id, state: 'ACTIVE', closed: [] });
});

afterAll(async () => {
  await h?.stop();
});

describe('drafts (FR-020, DF05)', () => {
  it('shows thresholds, mappings and period, and takes every value from the person maintaining it', async () => {
    // I-78 item 5: overtime on states its rules (synthetic values).
    const overtime = { overtimeEnabled: true, overtimeBasis: 'AFTER_SHIFT_END', overtimeMinimumMinutes: 30, overtimeRoundingMinutes: 15 };
    const created = await h.call(author, 'POST', POLICIES, { code: newCode(), ...values({ effectiveTo: '2026-12-01', ...overtime }) });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ revision: 1, state: 'DRAFT' });
    const shown = await policy(created.json().id);
    expect(shown).toMatchObject({ effectiveFrom: '2026-03-16', effectiveTo: '2026-12-01', graceMinutes: 5, presentPercent: '60.00', halfDayPercent: '40.00', ...overtime, mappings: [] });
    expect(shown.warnings.map((w) => w.code)).toEqual(['UNMAPPED']);

    expect((await h.call(author, 'POST', POLICIES, values())).statusCode).toBe(400);
    const { graceMinutes: _g, ...withoutGrace } = values();
    expect((await h.call(author, 'POST', POLICIES, { code: newCode(), ...withoutGrace })).statusCode).toBe(400);
  });

  it('refuses thresholds and periods that cannot work', async () => {
    const post = (overrides: Record<string, unknown>) => h.call(author, 'POST', POLICIES, { code: newCode(), ...values(overrides) });
    expect((await post({ presentPercent: '100.01', halfDayPercent: '50' })).json().error).toBe('INVALID_THRESHOLDS');
    expect((await post({ presentPercent: '50', halfDayPercent: '50' })).json().error).toBe('INVALID_THRESHOLDS');
    expect((await post({ presentPercent: '40', halfDayPercent: '50' })).json().error).toBe('INVALID_THRESHOLDS');
    expect((await post({ halfDayPercent: '0' })).json().error).toBe('INVALID_THRESHOLDS');
    expect((await post({ presentPercent: '60.123' })).statusCode).toBe(400);
    expect((await post({ graceMinutes: -1 })).statusCode).toBe(400);
    expect((await post({ effectiveTo: '2026-03-16' })).json().error).toBe('INVALID_PERIOD');
    expect((await h.call(author, 'POST', POLICIES, { code: 'lower-case', ...values() })).statusCode).toBe(400);
  });

  it('edits a draft under its version, numbers revisions per code, and maintains its mappings', async () => {
    const code = newCode();
    const p = await draft(code, {}, null);
    const edited = await h.call(author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version, graceMinutes: 7 });
    expect(edited.json()).toEqual({ id: p.id, version: p.version + 1 });
    expect((await h.call(author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version, graceMinutes: 8 })).json().error).toBe('STALE_VERSION');
    expect((await h.call(author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version + 1 })).statusCode).toBe(400);
    expect((await h.call(author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version + 1, presentPercent: '30' })).json().error).toBe('INVALID_THRESHOLDS');
    expect((await policy(p.id)).graceMinutes).toBe(7);
    expect((await h.call(author, 'POST', POLICIES, { code, ...values() })).json().revision).toBe(2);

    const covers = await covering();
    let version = p.version + 1;
    const mapped = await h.call(author, 'POST', `${POLICIES}/${p.id}/mappings`, { expectedVersion: version, ...covers });
    expect(mapped.statusCode, mapped.body).toBe(201);
    version = mapped.json().policyVersion;
    expect((await policy(p.id)).mappings).toEqual([expect.objectContaining({ id: mapped.json().id, ...covers, priority: 2 })]);
    expect((await h.call(author, 'POST', `${POLICIES}/${p.id}/mappings`, { expectedVersion: version, ...covers })).json().error).toBe('MAPPING_EXISTS');
    expect((await h.call(author, 'POST', `${POLICIES}/${p.id}/mappings`, { expectedVersion: version, gradeId: '00000000-0000-4000-8000-000000000000' })).json().error).toBe('INVALID_REFERENCE');
    const removed = await h.call(author, 'POST', `${POLICIES}/${p.id}/mappings/${mapped.json().id}/remove`, { expectedVersion: version });
    expect(removed.json()).toEqual({ policyVersion: version + 1 });
    expect((await policy(p.id)).mappings).toEqual([]);
    expect((await h.call(author, 'POST', `${POLICIES}/${p.id}/mappings/${mapped.json().id}/remove`, { expectedVersion: version + 1 })).statusCode).toBe(404);

    const options = (await h.call(author, 'GET', '/v1/attendance/policy-options')).json();
    expect(options.grades.map((g: { id: string }) => g.id)).toContain(covers.gradeId);
    expect(options.locations.map((l: { id: string }) => l.id)).toContain(covers.locationId);
  });

  it('an activated revision is frozen: a change needs a new revision (0008, 0115)', async () => {
    const covers = await covering();
    const p = await draft(newCode(), { effectiveFrom: '2030-01-01' }, covers);
    expect((await activate(activator, p.id, p.version)).statusCode).toBe(200);
    const live = await policy(p.id);
    expect((await h.call(author, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: live.version, graceMinutes: 1 })).json().error).toBe('POLICY_NOT_DRAFT');
    expect((await h.call(author, 'POST', `${POLICIES}/${p.id}/mappings`, { expectedVersion: live.version, locationId: covers.locationId })).json().error).toBe('POLICY_NOT_DRAFT');
    await expect(h.db.query(`update attendance_policy set grace_minutes = 1 where id = $1`, [p.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from attendance_policy_mapping where policy_id = $1`, [p.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`insert into attendance_policy_mapping (company_id, policy_id, location_id) values ($1, $2, $3)`, [A.id, p.id, covers.locationId])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update attendance_policy set state = 'DRAFT' where id = $1`, [p.id])).rejects.toMatchObject({ code: '23514' });
    expect((await retire(activator, p.id, live.version, '2031-01-01')).statusCode).toBe(200);
    await expect(h.db.query(`update attendance_policy set state = 'ACTIVE' where id = $1`, [p.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update attendance_policy set effective_to = '2032-01-01' where id = $1`, [p.id])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('independent activation (C4, DF05)', () => {
  it('refuses whoever wrote or last edited the draft, here and in the database', async () => {
    const p = await draft(newCode(), { effectiveFrom: '2031-01-01' }, await covering());
    expect((await activate(author, p.id, p.version)).json().error).toBe('SELF_APPROVAL');
    const edited = (await h.call(activator, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version, graceMinutes: 6 })).json();
    expect((await activate(activator, p.id, edited.version)).json().error).toBe('SELF_APPROVAL');
    await expect(h.db.query(`update attendance_policy set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [p.id, activator.user])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update attendance_policy set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [p.id, author.user])).rejects.toMatchObject({ code: '23514' });
    const third = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await activate(third, p.id, edited.version)).json().state).toBe('ACTIVE');
    expect((await activate(third, p.id, edited.version + 1)).json().error).toBe('INVALID_STATE');
    expect((await activate(third, p.id, edited.version)).json().error).toBe('STALE_VERSION');
    const trail = (await h.db.query<{ action: string }>(`select action from audit_event where resource_code = 'attendance_policy' and record_key = $1 order by created_at, id`, [p.id])).rows.map((r) => r.action);
    expect(trail).toEqual(['CREATE', 'MAP', 'UPDATE', 'ACTIVATE']);
  });

  it('a new revision closes the one it replaces; each day is evaluated by the revision in force on it', async () => {
    const code = newCode();
    const covers = await covering();
    const first = await draft(code, { effectiveFrom: '2026-04-06', presentPercent: '95', halfDayPercent: '90' }, covers);
    expect((await activate(activator, first.id, first.version)).json().closed).toEqual([]);
    const second = await draft(code, { effectiveFrom: '2026-04-13', presentPercent: '60', halfDayPercent: '40' }, covers);
    expect(second.revision).toBe(2);
    expect(second.warnings).toEqual([]);
    expect((await activate(activator, second.id, second.version)).json()).toEqual({ id: second.id, state: 'ACTIVE', closed: [first.id] });
    expect(await policy(first.id)).toMatchObject({ state: 'ACTIVE', effectiveTo: '2026-04-13' });
    expect(await policy(second.id)).toMatchObject({ state: 'ACTIVE', effectiveTo: null });

    const [mon, nextMon] = ['2026-04-06', '2026-04-13'];
    const employee = await employeeWorking(mon, '09:00', '15:00', covers);
    await worked(employee.code, nextMon, '09:00', '15:00');
    // 300 worked minutes of 480: 62.5%. Under the first revision that is below 90% and 95%; under the second it is above 60%.
    await h.runBulkJob(author, '/v1/attendance/processing', { workDate: mon });
    await h.runBulkJob(author, '/v1/attendance/processing', { workDate: nextMon });
    expect(await recordOn(employee.id, mon)).toMatchObject({ status: 'ABSENT', policyCode: code, policyRevision: 1 });
    expect(await recordOn(employee.id, nextMon)).toMatchObject({ status: 'PRESENT', policyCode: code, policyRevision: 2 });
    // The default company-wide policy keeps the lower priority and stays in force for everyone else.
    expect((await policy(defaultPolicyId)).state).toBe('ACTIVE');
    const other = await employeeWorking('2026-04-14', '09:00', '15:00');
    await h.runBulkJob(author, '/v1/attendance/processing', { workDate: '2026-04-14' });
    expect(await recordOn(other.id, '2026-04-14')).toMatchObject({ status: 'HALF_DAY', policyCode: 'DEFAULT' });
  });

  it('refuses a tie it cannot resolve: another code, or a revision of the same code that starts as late or later', async () => {
    const covers = await covering();
    const one = await draft(newCode(), { effectiveFrom: '2032-01-01' }, covers);
    expect((await activate(activator, one.id, one.version)).statusCode).toBe(200);
    // Another code with the same mapping and an overlapping period.
    const tie = await draft(newCode(), { effectiveFrom: '2032-06-01' }, covers);
    expect(tie.warnings.map((w) => w.code)).toEqual(['OVERLAPPING_MAPPING']);
    const refused = await activate(activator, tie.id, tie.version);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'POLICY_OVERLAP', details: { revisions: [{ policyId: one.id, code: one.code, revision: 1, effectiveFrom: '2032-01-01', effectiveTo: null }] } });
    expect((await policy(tie.id)).state).toBe('DRAFT');
    // The database refuses it on any path.
    await expect(h.db.query(`update attendance_policy set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [tie.id, activator.user])).rejects.toMatchObject({ code: '23514' });
    // A different number of dimensions is resolved by priority, and a period that ends before is no overlap.
    const moreGeneral = await draft(newCode(), { effectiveFrom: '2032-06-01' }, { gradeId: covers.gradeId });
    expect((await activate(activator, moreGeneral.id, moreGeneral.version)).statusCode).toBe(200);
    const earlier = await draft(newCode(), { effectiveFrom: '2031-01-01', effectiveTo: '2032-01-01' }, covers);
    expect((await activate(activator, earlier.id, earlier.version)).statusCode).toBe(200);

    // Same code, starting no later than the revision in force: closing it would erase it, so it is refused too.
    const code = newCode();
    const elsewhere = await covering();
    const current = await draft(code, { effectiveFrom: '2033-02-01' }, elsewhere);
    expect((await activate(activator, current.id, current.version)).statusCode).toBe(200);
    const backwards = await draft(code, { effectiveFrom: '2033-01-01' }, elsewhere);
    expect((await activate(activator, backwards.id, backwards.version)).json().error).toBe('POLICY_OVERLAP');
    expect((await policy(current.id)).effectiveTo).toBeNull();
  });

  it('two activations that would tie, at the same moment: exactly one goes through', async () => {
    const covers = await covering();
    const [x, y] = [await draft(newCode(), { effectiveFrom: '2034-01-01' }, covers), await draft(newCode(), { effectiveFrom: '2034-01-01' }, covers)];
    // This connection holds the policy lock, so both activations stand at it together and the race is not left to timing.
    const lockKey = [`attendance:policy:${A.id}`];
    await h.db.query(`select pg_advisory_lock(hashtextextended($1, 0))`, lockKey);
    const answers = Promise.all([activate(activator, x.id, x.version), activate(activator, y.id, y.version)]);
    const early = await Promise.race([answers.then(() => 'ANSWERED'), new Promise((resolve) => setTimeout(() => resolve('WAITING'), 500))]);
    await h.db.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, lockKey);
    const results = await answers;
    expect(early).toBe('WAITING');
    expect(results.map((r) => r.statusCode).sort(), results.map((r) => r.body).join(' ')).toEqual([200, 409]);
    expect(results.find((r) => r.statusCode === 409)!.json().error).toBe('POLICY_OVERLAP');
  });

  it('activation re-checks the duty inside the transaction and needs an unrestricted company scope', async () => {
    const p = await draft(newCode(), { effectiveFrom: '2035-01-01' }, await covering());
    const narrowed = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await activate(narrowed, p.id, p.version)).statusCode).toBe(403);
    expect((await h.call(narrowed, 'POST', POLICIES, { code: newCode(), ...values() })).statusCode).toBe(403);

    const later = await h.actor(A, 'HR_ADMINISTRATOR');
    const grant = (await resolveAccess(h.pool, { userId: later.user, companyId: A.id, assignmentId: later.assignment, resource: 'attendance_policy', action: 'activate', fieldGroups: ['operational'] })) as AccessGrant;
    const managing = (await resolveAccess(h.pool, { userId: later.user, companyId: A.id, assignmentId: later.assignment, resource: 'attendance_policy', action: 'manage', fieldGroups: ['operational'] })) as AccessGrant;
    expect(grant.allowed && managing.allowed).toBe(true);
    await h.db.query(
      `update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2
          and permission_id in (select id from permission where resource = 'attendance_policy')`,
      [A.id, later.assignment],
    );
    await expect(withTransaction(h.pool, (tx) => activateAttendancePolicy(tx, grant, p.id, p.version))).rejects.toMatchObject({ statusCode: 403 });
    expect((await policy(p.id)).state).toBe('DRAFT');
    await expect(withTransaction(h.pool, (tx) => createAttendancePolicy(tx, managing, { code: newCode(), ...values() }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(withTransaction(h.pool, (tx) => retireAttendancePolicy(tx, grant, defaultPolicyId, { expectedVersion: 1, effectiveTo: '2040-01-01', reason: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
  });

  it('other roles and other companies get nothing', async () => {
    const employee = await h.actor(A, 'EMPLOYEE');
    expect((await h.call(employee, 'GET', POLICIES)).statusCode).toBe(403);
    expect((await h.call(employee, 'POST', POLICIES, { code: newCode(), ...values() })).statusCode).toBe(403);
    const manager = await h.actor(A, 'REPORTING_MANAGER');
    expect((await h.call(manager, 'GET', '/v1/attendance/policy-options')).statusCode).toBe(403);
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const covers = await covering();
    const p = await draft(newCode(), { effectiveFrom: '2036-01-01' }, covers);
    expect((await activate(hrB, p.id, p.version)).statusCode).toBe(404);
    expect((await h.call(hrB, 'PATCH', `${POLICIES}/${p.id}`, { expectedVersion: p.version, graceMinutes: 1 })).statusCode).toBe(404);
    expect((await list(hrB)).map((x) => x.id)).not.toContain(p.id);
    // A company's mapping cannot name another company's grade.
    const own = (await h.call(hrB, 'POST', POLICIES, { code: newCode(), ...values() })).json();
    expect((await h.call(hrB, 'POST', `${POLICIES}/${own.id}/mappings`, { expectedVersion: own.version, gradeId: covers.gradeId })).json().error).toBe('INVALID_REFERENCE');
  });
});

describe('retirement (FR-020)', () => {
  it('ends a revision from today or later, with a reason; earlier days keep it, and a backdated end is refused', async () => {
    const code = newCode();
    const covers = await covering();
    const p = await draft(code, { effectiveFrom: '2026-05-04', presentPercent: '95', halfDayPercent: '90' }, covers);
    expect((await activate(activator, p.id, p.version)).statusCode).toBe(200);
    const live = await policy(p.id);
    const today = await businessDate();
    expect((await retire(activator, p.id, live.version, '2026-05-05')).json().error).toBe('BACKDATED_RETIREMENT');
    expect((await h.call(activator, 'POST', `${POLICIES}/${p.id}/retire`, { expectedVersion: live.version, effectiveTo: today, reason: '   ' })).statusCode).toBe(400);
    expect((await retire(activator, p.id, 99, today)).json().error).toBe('STALE_VERSION');
    const done = await retire(activator, p.id, live.version, today);
    expect(done.json()).toEqual({ id: p.id, state: 'RETIRED', effectiveTo: today });
    expect((await retire(activator, p.id, live.version + 1, today)).json().error).toBe('INVALID_STATE');
    const after = (await h.db.query<{ reason: string }>(`select reason from audit_event where resource_code = 'attendance_policy' and record_key = $1 and action = 'RETIRE'`, [p.id])).rows[0]!;
    expect(after.reason).toBe('Synthetic: replaced');

    // A day before the end still evaluates under it.
    const employee = await employeeWorking('2026-05-04', '09:00', '15:00', covers);
    await h.runBulkJob(author, '/v1/attendance/processing', { workDate: '2026-05-04' });
    expect(await recordOn(employee.id, '2026-05-04')).toMatchObject({ status: 'ABSENT', policyCode: code });
  });

  it('a revision retired before it started never applies, and no longer ties', async () => {
    const covers = await covering();
    const p = await draft(newCode(), { effectiveFrom: '2037-01-01' }, covers);
    expect((await activate(activator, p.id, p.version)).statusCode).toBe(200);
    const live = await policy(p.id);
    expect((await retire(activator, p.id, live.version, await businessDate())).json()).toEqual({ id: p.id, state: 'RETIRED', effectiveTo: null });
    const next = await draft(newCode(), { effectiveFrom: '2037-01-01' }, covers);
    expect((await activate(activator, next.id, next.version)).statusCode).toBe(200);
  });
});
