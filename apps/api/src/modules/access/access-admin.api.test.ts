// Role-grant administration over HTTP (FR-066/067/068; C4; CI09; DF02; ZT04, ZT05).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { approveGrant, endGrant, proposeGrant } from './admin.js';
import { type AccessGrant, resolveAccess } from './authorize.js';
import { BASELINE_ROLES, C2_RECORD_SCOPES } from './baseline.js';

let h: Harness;
let A: Company;
let sysAdmin1: TestActor;
let sysAdmin2: TestActor;

const propose = (by: TestActor, body: object) => h.call(by, 'POST', '/v1/access/assignments', body);
const version = async (id: string) => (await h.one<{ version: number }>('select version from role_assignment where id = $1', [id])).version;

/** Acts as `user` under a given assignment id (e.g. a freshly approved grant). */
const as = async (user: string, assignment: string, company: Company): Promise<TestActor> => ({
  user,
  assignment,
  company,
  token: await h.tokenFor(user),
});

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  sysAdmin1 = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  sysAdmin2 = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('proposal and independent approval', () => {
  it('a pending grant gives no access; requester cannot approve; an independent approver activates it', async () => {
    const beneficiary = await h.makeUser();
    const res = await propose(sysAdmin1, { userId: beneficiary, roleCode: 'HR_ADMINISTRATOR', effectiveFrom: '2026-01-01T00:00:00Z' });
    expect(res.statusCode).toBe(201);
    const { id } = res.json();

    const asBeneficiary = await as(beneficiary, id, A);
    expect((await h.call(asBeneficiary, 'GET', '/v1/employees')).statusCode).toBe(403);
    expect((await h.call(asBeneficiary, 'GET', '/v1/me/assignments')).json().items).toEqual([]);

    const self = await h.call(sysAdmin1, 'POST', `/v1/access/assignments/${id}/approve`, { expectedVersion: await version(id) });
    expect(self.statusCode).toBe(403);
    expect(self.json().error).toBe('SELF_APPROVAL');

    const stale = await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${id}/approve`, { expectedVersion: 99 });
    expect(stale.statusCode).toBe(409);

    const ok = await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${id}/approve`, { expectedVersion: await version(id) });
    expect(ok.statusCode).toBe(200);
    expect((await h.call(asBeneficiary, 'GET', '/v1/employees')).statusCode).toBe(200);
    expect((await h.call(asBeneficiary, 'GET', '/v1/me/assignments')).json().items).toMatchObject([{ id, roleCode: 'HR_ADMINISTRATOR' }]);

    const again = await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${id}/approve`, { expectedVersion: await version(id) });
    expect(again.statusCode).toBe(409);
  });

  it('a beneficiary cannot approve a grant for themselves', async () => {
    const res = await propose(sysAdmin1, { userId: sysAdmin2.user, roleCode: 'HR_ADMINISTRATOR', effectiveFrom: '2026-01-01T00:00:00Z' });
    const { id } = res.json();
    const self = await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${id}/approve`, { expectedVersion: await version(id) });
    expect(self.statusCode).toBe(403);
  });

  it('only administrators with access permissions can propose', async () => {
    const hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const res = await propose(hr, { userId: await h.makeUser(), roleCode: 'EMPLOYEE', effectiveFrom: '2026-01-01T00:00:00Z' });
    expect(res.statusCode).toBe(403);
  });
});

describe('confidential permissions and ceilings (DF02, BR-044)', () => {
  it('rejects permissions outside the role ceiling', async () => {
    const res = await propose(sysAdmin1, {
      userId: await h.makeUser(),
      roleCode: 'FINANCE_REVIEWER',
      effectiveFrom: '2026-01-01T00:00:00Z',
      permissions: ['employee.read.personal'],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('OUTSIDE_ROLE_CEILING');
  });

  it('requires a business purpose for a confidential grant to an eligible role', async () => {
    const base = {
      userId: await h.makeUser(),
      roleCode: 'REPORTING_MANAGER',
      effectiveFrom: '2026-01-01T00:00:00Z',
      permissions: ['employee.list.operational', 'employee.read.operational', 'employee.read.personal'],
    };
    const missing = await propose(sysAdmin1, base);
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error).toBe('PURPOSE_REQUIRED');
    expect((await propose(sysAdmin1, { ...base, purpose: 'Team welfare coordination (synthetic)' })).statusCode).toBe(201);
  });
});

describe('administrative scope containment (C4)', () => {
  it('a department-filtered administrator can only grant within its department', async () => {
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.financeDept });
    const wide = await propose(filtered, { userId: await h.makeUser(), roleCode: 'HR_ADMINISTRATOR', effectiveFrom: '2026-01-01T00:00:00Z' });
    expect(wide.statusCode).toBe(403);
    expect(wide.json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
    const narrow = await propose(filtered, {
      userId: await h.makeUser(),
      roleCode: 'HR_ADMINISTRATOR',
      effectiveFrom: '2026-01-01T00:00:00Z',
      filters: { departments: [A.financeDept] },
    });
    expect(narrow.statusCode).toBe(201);

    // The filtered administrator also cannot approve an unrestricted grant proposed by someone else.
    const unrestricted = (await propose(sysAdmin1, { userId: await h.makeUser(), roleCode: 'EMPLOYEE', effectiveFrom: '2026-01-01T00:00:00Z' })).json();
    const approve = await h.call(filtered, 'POST', `/v1/access/assignments/${unrestricted.id}/approve`, {
      expectedVersion: await version(unrestricted.id),
    });
    expect(approve.statusCode).toBe(403);
  });
});

describe('C2 record scope per role (BR-044, C7)', () => {
  const proposal = async (roleCode: string, scopeKind?: string) => ({ userId: await h.makeUser(), roleCode, effectiveFrom: '2026-01-01T00:00:00Z', ...(scopeKind ? { scopeKind } : {}) });

  it.each([
    // "no organisation-wide manager bypass": the failure in the finding, with the confidential grant that made it matter.
    ['REPORTING_MANAGER', 'COMPANY'],
    ['REPORTING_MANAGER', 'OWN'],
    ['EMPLOYEE', 'COMPANY'],
    ['EMPLOYEE', 'TEAM'],
    ['SYSTEM_ADMINISTRATOR', 'TEAM'],
    ['HR_ADMINISTRATOR', 'ASSIGNED'],
    ['PAYROLL_OPERATOR', 'ASSIGNED'],
    ['FINANCE_REVIEWER', 'OWN'],
    ['EXPENSE_FINANCE_APPROVER', 'COMPANY'],
    ['TREASURY_OPERATOR', 'TEAM'],
    ['TREASURY_APPROVER', 'COMPANY'],
    ['RECRUITER', 'ASSIGNED'],
    ['APPRAISAL_REVIEWER', 'COMPANY'],
    ['TRAINING_COORDINATOR', 'OWN'],
    ['AUDITOR', 'TEAM'],
    ['PAYROLL_APPROVER', 'TEAM'],
  ])('refuses %s in %s scope, and nothing is created', async (role, scope) => {
    const body = await proposal(role, scope);
    const res = await propose(sysAdmin1, body);
    expect(res.statusCode, res.body).toBe(422);
    expect(res.json().error).toBe('SCOPE_NOT_ALLOWED_FOR_ROLE');
    expect((await h.one<{ n: number }>(`select count(*)::int as n from role_assignment where user_id = $1`, [body.userId])).n).toBe(0);
  });

  it.each([
    ['REPORTING_MANAGER', 'TEAM'],
    ['REPORTING_MANAGER', 'ASSIGNED'],
    ['PAYROLL_APPROVER', 'ASSIGNED'],
    ['PAYROLL_APPROVER', 'COMPANY'],
    ['HR_ADMINISTRATOR', 'COMPANY'],
    ['EMPLOYEE', 'OWN'],
  ])('accepts %s in %s scope', async (role, scope) => {
    expect((await propose(sysAdmin1, await proposal(role, scope))).statusCode).toBe(201);
  });

  it('every baseline role’s default scope is inside its C2 entry', async () => {
    for (const role of BASELINE_ROLES) expect(C2_RECORD_SCOPES[role.code], role.code).toContain(role.defaultScope);
    expect(Object.keys(C2_RECORD_SCOPES).sort()).toEqual(BASELINE_ROLES.map((r) => r.code).sort());
  });

  it('a role C2 does not name stays unrestricted', async () => {
    const code = `CUSTOM_${uniq('R')}`.toUpperCase();
    await h.db.query(`insert into role (company_id, code, name, active) values ($1, $2, $2, true)`, [A.id, code]);
    for (const scope of ['OWN', 'TEAM', 'ASSIGNED', 'COMPANY']) {
      const res = await propose(sysAdmin1, { ...(await proposal(code, scope)), permissions: [] });
      expect(res.statusCode, res.body).toBe(201);
    }
  });

  it('a proposal from before the matrix cannot be approved, and is still rejected normally', async () => {
    const beneficiary = await h.makeUser();
    await h.db.query(`alter table role_assignment disable trigger role_assignment_record_scope`);
    const legacy = await h
      .one<{ id: string }>(
        `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, created_by)
         select $1, $2, r.id, 'COMPANY', '2026-01-01T00:00:00Z', 'PENDING', $3 from role r where r.company_id = $1 and r.code = 'REPORTING_MANAGER' returning id`,
        [A.id, beneficiary, sysAdmin1.user],
      )
      .finally(() => h.db.query(`alter table role_assignment enable trigger role_assignment_record_scope`));
    const refused = await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${legacy.id}/approve`, { expectedVersion: await version(legacy.id) });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('SCOPE_NOT_ALLOWED_FOR_ROLE');
    expect((await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${legacy.id}/reject`, { expectedVersion: await version(legacy.id), reason: 'Outside C2' })).statusCode).toBe(200);
  });
});

describe('the grant transactions re-check their own authority (docs/09 §6.5)', () => {
  const guardGrant = async (a: TestActor, action: string) =>
    (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'access', action, fieldGroups: ['operational'] })) as AccessGrant;

  it('proposal, approval, rejection and revocation are refused when the duty was withdrawn after the route guard, and change nothing', async () => {
    const pendingGrant = (await propose(sysAdmin1, { userId: await h.makeUser(), roleCode: 'TRAINING_COORDINATOR', effectiveFrom: '2026-01-01T00:00:00Z' })).json();
    const activeGrant = (await propose(sysAdmin1, { userId: await h.makeUser(), roleCode: 'TRAINING_COORDINATOR', effectiveFrom: '2026-01-01T00:00:00Z' })).json();
    expect((await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${activeGrant.id}/approve`, { expectedVersion: await version(activeGrant.id) })).statusCode).toBe(200);

    const narrowed = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const [assign, approve, revoke] = await Promise.all([guardGrant(narrowed, 'assign_role'), guardGrant(narrowed, 'approve_role_grant'), guardGrant(narrowed, 'revoke_role')]);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [narrowed.assignment]);

    const refused = { statusCode: 403 };
    const beneficiary = await h.makeUser();
    await expect(withTransaction(h.pool, (tx) => proposeGrant(tx, assign, { userId: beneficiary, roleCode: 'TRAINING_COORDINATOR', effectiveFrom: '2026-01-01T00:00:00Z' }))).rejects.toMatchObject(refused);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from role_assignment where user_id = $1`, [beneficiary])).n).toBe(0);
    await expect(withTransaction(h.pool, async (tx) => approveGrant(tx, approve, pendingGrant.id, await version(pendingGrant.id)))).rejects.toMatchObject(refused);
    await expect(withTransaction(h.pool, async (tx) => endGrant(tx, approve, pendingGrant.id, await version(pendingGrant.id), 'Synthetic', 'REJECT'))).rejects.toMatchObject(refused);
    await expect(withTransaction(h.pool, async (tx) => endGrant(tx, revoke, activeGrant.id, await version(activeGrant.id), 'Synthetic', 'REVOKE'))).rejects.toMatchObject(refused);
    const state = async (id: string) => (await h.one<{ state: string }>(`select state from role_assignment where id = $1`, [id])).state;
    expect(await state(pendingGrant.id)).toBe('PENDING');
    expect(await state(activeGrant.id)).toBe('ACTIVE');
  });
});

describe('the application path satisfies the database guards (CI09)', () => {
  it('a proposal becomes usable and is frozen; a direct write over the application’s connection cannot widen it', async () => {
    const beneficiary = await h.makeUser();
    const { id } = (await propose(sysAdmin1, { userId: beneficiary, roleCode: 'TRAINING_COORDINATOR', effectiveFrom: '2026-01-01T00:00:00Z', filters: { departments: [A.dept] } })).json();
    expect((await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${id}/approve`, { expectedVersion: await version(id) })).statusCode).toBe(200);
    const row = await h.one<{ state: string; approved_by: string; bootstrapped: boolean }>(`select state, approved_by, bootstrapped from role_assignment where id = $1`, [id]);
    expect(row).toEqual({ state: 'ACTIVE', approved_by: sysAdmin2.user, bootstrapped: false });
    const check = { code: '23514' };
    await expect(h.pool.query(`update role_assignment set approved_by = $2 where id = $1`, [id, sysAdmin1.user])).rejects.toMatchObject(check);
    await expect(h.pool.query(`delete from role_scope_filter where role_assignment_id = $1`, [id])).rejects.toMatchObject(check);
    await expect(h.pool.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`, [A.id, id, A.financeDept])).rejects.toMatchObject(check);
    await expect(
      h.pool.query(
        `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at)
         select $1, $2, r.id, 'COMPANY', now(), 'ACTIVE', $3, now() from role r where r.company_id = $1 and r.code = 'SYSTEM_ADMINISTRATOR'`,
        [A.id, beneficiary, sysAdmin2.user],
      ),
    ).rejects.toMatchObject(check);
  });
});

describe('rejection, revocation and role selection (FR-068, ZT05)', () => {
  it('rejecting needs a reason and gives no access; revoking ends access on the next request', async () => {
    const beneficiary = await h.makeUser();
    const pending = (await propose(sysAdmin1, { userId: beneficiary, roleCode: 'HR_ADMINISTRATOR', effectiveFrom: '2026-01-01T00:00:00Z' })).json();
    const noReason = await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${pending.id}/reject`, { expectedVersion: await version(pending.id) });
    expect(noReason.statusCode).toBe(400);
    const rejected = await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${pending.id}/reject`, {
      expectedVersion: await version(pending.id),
      reason: 'Not required',
    });
    expect(rejected.statusCode).toBe(200);
    expect((await h.call(await as(beneficiary, pending.id, A), 'GET', '/v1/employees')).statusCode).toBe(403);

    const granted = (await propose(sysAdmin1, { userId: beneficiary, roleCode: 'HR_ADMINISTRATOR', effectiveFrom: '2026-01-01T00:00:00Z' })).json();
    await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${granted.id}/approve`, { expectedVersion: await version(granted.id) });
    const session = await as(beneficiary, granted.id, A);
    expect((await h.call(session, 'GET', '/v1/employees')).statusCode).toBe(200);
    const revoke = await h.call(sysAdmin2, 'POST', `/v1/access/assignments/${granted.id}/revoke`, {
      expectedVersion: await version(granted.id),
      reason: 'Role change',
    });
    expect(revoke.statusCode).toBe(200);
    expect((await h.call(session, 'GET', '/v1/employees')).statusCode).toBe(403);

    const list = (await h.call(sysAdmin2, 'GET', `/v1/access/assignments?userId=${beneficiary}`)).json();
    expect(list.items.map((i: { state: string }) => i.state).sort()).toEqual(['REVOKED', 'REVOKED']);
  });

  it('role selection works without an assignment header, but no other route does', async () => {
    const headers = { authorization: `Bearer ${sysAdmin1.token}`, [COMPANY_HEADER]: A.id };
    const mine = await h.app.inject({ method: 'GET', url: '/v1/me/assignments', headers });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items).toMatchObject([{ id: sysAdmin1.assignment, roleCode: 'SYSTEM_ADMINISTRATOR' }]);
    expect((await h.app.inject({ method: 'GET', url: '/v1/employees', headers })).statusCode).toBe(400);
    const bogus = await h.app.inject({ method: 'GET', url: '/v1/me/assignments', headers: { ...headers, [ASSIGNMENT_HEADER]: 'nope' } });
    expect(bogus.statusCode).toBe(400);
  });
});
