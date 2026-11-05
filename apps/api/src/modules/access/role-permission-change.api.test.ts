// Role-permission maintenance through independent approval, and scoped DENY in the access decision (C1; C3 maintain_role_permissions;
// C4; C6; C7; FR-066; FR-067; BR-007; I-52; 0132). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import { revokedAfterGuard } from '../../test/after-guard.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { type AccessGrant, canAccessEmployee, resolveAccess } from './authorize.js';
import type { PermissionKey } from './baseline.js';
import { provisionCompany } from './provision.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let proposer: TestActor;
let approver: TestActor;

// A System Administrator's default duties hold both actions, so the two administrators differ by person, not by role. The role being
// changed is one neither of them holds.
const PATH = '/v1/access/role-permission-changes';

const propose = (a: TestActor, roleCode: string, permission: string, change: 'ALLOW' | 'DENY' | 'REMOVE', reason = 'Access review (synthetic)') => h.call(a, 'POST', PATH, { roleCode, permission, change, reason });
const proposed = async (roleCode: string, permission: string, change: 'ALLOW' | 'DENY' | 'REMOVE', by: TestActor = proposer) => {
  const res = await propose(by, roleCode, permission, change);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};
const approve = (a: TestActor, id: string, expectedVersion = 1) => h.call(a, 'POST', `${PATH}/${id}/approve`, { expectedVersion });
const reject = (a: TestActor, id: string, reason = 'Not needed (synthetic)', expectedVersion = 1) => h.call(a, 'POST', `${PATH}/${id}/reject`, { expectedVersion, reason });
const approved = async (roleCode: string, permission: string, change: 'ALLOW' | 'DENY' | 'REMOVE') => {
  const res = await approve(approver, await proposed(roleCode, permission, change));
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const rolePermission = (company: Company, roleCode: string, key: string) => {
  const [resource, action, fieldGroup] = key.split('.');
  return h.db
    .query<{ effect: string }>(
      `select rp.effect from role_permission rp join role r on r.company_id = rp.company_id and r.id = rp.role_id join permission p on p.id = rp.permission_id
        where rp.company_id = $1 and r.code = $2 and p.resource = $3 and p.action = $4 and p.field_group = $5`,
      [company.id, roleCode, resource, action, fieldGroup],
    )
    .then((r) => r.rows[0]?.effect ?? null);
};
const decision = (a: TestActor, company: Company, resource: string, action: string, fieldGroups: string[] = ['operational']) =>
  resolveAccess(h.pool, { userId: a.user, companyId: company.id, assignmentId: a.assignment, resource, action, fieldGroups });
const grantOf = async (a: TestActor, company: Company, resource: string, action: string) => {
  const d = await decision(a, company, resource, action);
  if (!d.allowed) throw new Error(d.reason);
  return d as AccessGrant;
};
const newEmployee = async (overrides: Record<string, unknown> = {}) => {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides));
  expect(res.statusCode, res.body).toBe(201);
  return res.json().id as string;
};

/** A company of its own, so a change to a role touches nothing the other tests rely on. */
async function freshWorld() {
  const company = await h.makeCompany();
  return {
    company,
    hr: await h.actor(company, 'HR_ADMINISTRATOR'),
    proposer: await h.actor(company, 'SYSTEM_ADMINISTRATOR'),
    approver: await h.actor(company, 'SYSTEM_ADMINISTRATOR'),
  };
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  proposer = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  approver = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('who may ask (C3; C4 "existing company scope cannot authorize an expansion beyond approved administrative scope")', () => {
  it('needs maintain_role_permissions over the whole company', async () => {
    expect((await propose(hr, 'EMPLOYEE', 'employee.read.operational', 'REMOVE')).statusCode).toBe(403);
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    const refused = await propose(filtered, 'EMPLOYEE', 'employee.read.operational', 'REMOVE');
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
    expect((await h.db.query(`select 1 from role_permission_change where company_id = $1 and requested_by = $2`, [A.id, filtered.user])).rowCount).toBe(0);
  });

  it('re-checks the duty inside the transaction: revoked after the route guard, nothing is proposed or decided', async () => {
    const leaving = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const res = await revokedAfterGuard(h, A, leaving, () => propose(leaving, 'EMPLOYEE', 'attendance.export.operational', 'DENY'));
    expect(res.statusCode).toBe(403);
    expect((await h.db.query(`select 1 from role_permission_change where company_id = $1 and requested_by = $2`, [A.id, leaving.user])).rowCount).toBe(0);

    const id = await proposed('EMPLOYEE', 'profile_change.read.operational', 'REMOVE');
    const decider = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const decided = await revokedAfterGuard(h, A, decider, () => approve(decider, id));
    expect(decided.statusCode).toBe(403);
    expect(await rolePermission(A, 'EMPLOYEE', 'profile_change.read.operational')).toBe('ALLOW');
    expect((await reject(approver, id)).statusCode).toBe(200);
  });

  it('refuses what is not a change, an unknown permission, an unknown role and a second open proposal', async () => {
    const error = async (...args: Parameters<typeof propose>) => {
      const res = await propose(...args);
      return [res.statusCode, res.json().error];
    };
    expect(await error(proposer, 'EMPLOYEE', 'employee.read.operational', 'ALLOW')).toEqual([422, 'NO_CHANGE']); // already allowed
    expect(await error(proposer, 'EMPLOYEE', 'salary.read.salary', 'REMOVE')).toEqual([422, 'NO_CHANGE']); // nothing to remove
    expect(await error(proposer, 'EMPLOYEE', 'no_such.read.operational', 'DENY')).toEqual([422, 'UNKNOWN_PERMISSION']);
    expect(await error(proposer, 'NO_SUCH_ROLE', 'employee.read.operational', 'DENY')).toEqual([422, 'INVALID_REFERENCE']);
    const id = await proposed('EMPLOYEE', 'leave.export.operational', 'DENY');
    expect(await error(proposer, 'EMPLOYEE', 'leave.export.operational', 'DENY')).toEqual([409, 'CHANGE_ALREADY_PROPOSED']);
    expect((await reject(approver, id)).statusCode).toBe(200);
    expect((await propose(proposer, 'EMPLOYEE', 'leave.export.operational', 'DENY')).statusCode).toBe(201);
  });
});

describe('ceilings and eligibility (C6 "do not silently add broad privileges"; C7)', () => {
  it('a baseline role cannot be widened past its baseline ceiling, at the proposal or at the decision', async () => {
    const res = await propose(proposer, 'EMPLOYEE', 'employee.list.operational', 'ALLOW');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('OUTSIDE_ROLE_CEILING');
    const payment = await propose(proposer, 'HR_ADMINISTRATOR', 'payroll.release.operational', 'ALLOW');
    expect(payment.statusCode).toBe(422);
    // A proposal already recorded is judged again when it is decided.
    const direct = await h.one<{ id: string }>(
      `insert into role_permission_change (company_id, role_id, permission_id, change_kind, reason, requested_by, requested_assignment_id)
       select $1, r.id, p.id, 'ALLOW', 'Written past the service (synthetic)', $2, $3 from role r, permission p
        where r.company_id = $1 and r.code = 'EMPLOYEE' and p.resource = 'employee' and p.action = 'list' and p.field_group = 'operational' returning id`,
      [A.id, proposer.user, proposer.assignment],
    );
    const decided = await approve(approver, direct.id);
    expect(decided.statusCode).toBe(422);
    expect(decided.json().error).toBe('OUTSIDE_ROLE_CEILING');
    expect(await rolePermission(A, 'EMPLOYEE', 'employee.list.operational')).toBeNull();
  });

  it('C7: a confidential permission never reaches a role that is not Admin or Manager, also on a custom role', async () => {
    const custom = await h.customActor(A, { scope: 'COMPANY', permissions: ['employee.read.operational'] });
    const role = await h.one<{ code: string }>(`select r.code from role_assignment ra join role r on r.company_id = ra.company_id and r.id = ra.role_id where ra.id = $1`, [custom.assignment]);
    const refused = await propose(proposer, role.code, 'salary.read.salary', 'ALLOW');
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('CONFIDENTIAL_NOT_ELIGIBLE');
    // An operational permission may be added to a custom role: C2 is silent on them (I-52).
    const id = await proposed(role.code, 'employee.list.operational', 'ALLOW');
    expect((await approve(approver, id)).statusCode).toBe(200);
    expect(await rolePermission(A, role.code, 'employee.list.operational')).toBe('ALLOW');
    // ... and adding it to the ceiling gave the assignment nothing: no implicit grant.
    expect((await decision(custom, A, 'employee', 'list')).allowed).toBe(false);
  });

  it('H1: an own-ESS confidential entry can come back to the Employee role, and a removed one can be restored', async () => {
    const world = await freshWorld();
    const by = { proposer: world.proposer, approver: world.approver };
    const remove = await h.call(by.proposer, 'POST', PATH, { roleCode: 'EMPLOYEE', permission: 'leave.read.reason', change: 'REMOVE', reason: 'Review (synthetic)' });
    expect((await approve(by.approver, remove.json().id)).statusCode).toBe(200);
    const back = await h.call(by.proposer, 'POST', PATH, { roleCode: 'EMPLOYEE', permission: 'leave.read.reason', change: 'ALLOW', reason: 'Review (synthetic)' });
    expect(back.statusCode, back.body).toBe(201);
    expect((await approve(by.approver, back.json().id)).statusCode).toBe(200);
    expect(await rolePermission(world.company, 'EMPLOYEE', 'leave.read.reason')).toBe('ALLOW');
  });
});

describe('independent decision (C3 "no own approval"; C4; FR-067)', () => {
  it('until it is approved nothing changes, and a rejection changes nothing', async () => {
    const world = await freshWorld();
    const before = await rolePermission(world.company, 'HR_ADMINISTRATOR', 'leave.export.operational');
    const id = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'leave.export.operational', change: 'REMOVE', reason: 'Review (synthetic)' })).json().id as string;
    expect(await rolePermission(world.company, 'HR_ADMINISTRATOR', 'leave.export.operational')).toBe(before);
    expect((await decision(world.hr, world.company, 'leave', 'export')).allowed).toBe(true);
    const res = await reject(world.approver, id, 'Still needed (synthetic)');
    expect(res.statusCode, res.body).toBe(200);
    expect(await rolePermission(world.company, 'HR_ADMINISTRATOR', 'leave.export.operational')).toBe(before);
    expect((await decision(world.hr, world.company, 'leave', 'export')).allowed).toBe(true);
    const [row] = (await h.call(world.proposer, 'GET', `${PATH}?state=REJECTED`)).json().items;
    expect(row).toMatchObject({ state: 'REJECTED', decidedBy: world.approver.user, decisionReason: 'Still needed (synthetic)', resultingAccess: null });
  });

  it('the requester cannot decide their own proposal; someone without the duty cannot either', async () => {
    const id = await proposed('EMPLOYEE', 'work_request.withdraw.operational', 'REMOVE');
    const own = await approve(proposer, id);
    expect(own.statusCode).toBe(403);
    expect(own.json().error).toBe('SELF_APPROVAL');
    expect((await reject(proposer, id)).json().error).toBe('SELF_APPROVAL');
    expect((await approve(hr, id)).statusCode).toBe(403);
    expect(await rolePermission(A, 'EMPLOYEE', 'work_request.withdraw.operational')).toBe('ALLOW');
    expect((await reject(approver, id)).statusCode).toBe(200);
  });

  it('nobody holding the role decides a change to it, even with a pending grant of it; a holder of another role can', async () => {
    const id = await proposed('EMPLOYEE', 'mobile_link.read.operational', 'REMOVE');
    const holder = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const seat = await h.actor(A, 'EMPLOYEE', { user: holder.user, duties: ['employee.read.operational'] });
    const refused = await approve(holder, id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('AFFECTED_APPROVER');
    // No longer holding it, they are independent of it.
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where company_id = $1 and id = $2`, [A.id, seat.assignment]);
    // A pending grant of the role keeps them out, as it would be their own increased access.
    const pending = await h.call(proposer, 'POST', '/v1/access/assignments', { userId: holder.user, roleCode: 'EMPLOYEE', effectiveFrom: '2026-01-01T00:00:00Z' });
    expect(pending.statusCode, pending.body).toBe(201);
    expect((await approve(holder, id)).json().error).toBe('AFFECTED_APPROVER');
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where company_id = $1 and id = $2`, [A.id, pending.json().id]);
    expect((await approve(holder, id)).statusCode).toBe(200);
  });

  it('a change to the role every approver holds cannot be approved by any of them', async () => {
    const id = await proposed('SYSTEM_ADMINISTRATOR', 'audit.export.operational', 'REMOVE');
    expect((await approve(approver, id)).json().error).toBe('AFFECTED_APPROVER');
    expect(await rolePermission(A, 'SYSTEM_ADMINISTRATOR', 'audit.export.operational')).toBe('ALLOW');
    expect((await reject(approver, id)).json().error).toBe('AFFECTED_APPROVER');
    expect((await h.db.query(`select 1 from role_permission_change where id = $1 and state = 'PROPOSED'`, [id])).rowCount).toBe(1);
  });

  it('an approver restricted by filters cannot decide a company-wide change; a stale decision is refused; a decided change stays decided', async () => {
    const id = await proposed('EMPLOYEE', 'mobile_link.request.operational', 'DENY');
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await approve(filtered, id)).json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
    expect((await approve(approver, id, 7)).json().error).toBe('STALE_VERSION');
    expect((await approve(approver, id)).statusCode).toBe(200);
    expect((await approve(approver, id, 2)).json().error).toBe('INVALID_STATE');
    expect((await reject(approver, id, 'Too late (synthetic)', 2)).json().error).toBe('INVALID_STATE');
  });

  it('a role changed past this flow since the proposal is not approved on the old picture', async () => {
    const world = await freshWorld();
    const id = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'holiday.manage.operational', change: 'DENY', reason: 'Review (synthetic)' })).json().id as string;
    await h.db.query(
      `delete from role_permission where company_id = $1 and role_id = (select id from role where company_id = $1 and code = 'HR_ADMINISTRATOR')
         and permission_id = (select id from permission where resource = 'holiday' and action = 'manage' and field_group = 'operational')`,
      [world.company.id],
    );
    const res = await approve(world.approver, id);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('CHANGE_OUTDATED');
  });

  it('FR-067: the record keeps the proposed change, requester, decider, reason, decision time and resulting access, and the audit logs both steps', async () => {
    const world = await freshWorld();
    const id = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'shift.import.operational', change: 'REMOVE', reason: 'No more bulk shifts (synthetic)' })).json().id as string;
    const res = await approve(world.approver, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().resultingAccess).toMatchObject({ effectBefore: 'ALLOW', effectAfter: null, allowlistEntriesEnded: 1, assignments: [world.hr.assignment] });
    const [row] = (await h.call(world.proposer, 'GET', `${PATH}?roleCode=HR_ADMINISTRATOR`)).json().items;
    expect(row).toMatchObject({
      id,
      roleCode: 'HR_ADMINISTRATOR',
      permission: 'shift.import.operational',
      change: 'REMOVE',
      effectBefore: 'ALLOW',
      state: 'APPROVED',
      reason: 'No more bulk shifts (synthetic)',
      requestedBy: world.proposer.user,
      decidedBy: world.approver.user,
      resultingAccess: { effectAfter: null, allowlistEntriesEnded: 1 },
    });
    expect(row.decidedAt).toBeTruthy();
    const audit = (await h.db.query<{ action: string; actor_user_id: string; reason: string | null }>(`select action, actor_user_id, reason from audit_event where company_id = $1 and resource_code = 'role_permission_change' and record_key = $2 order by occurred_at`, [world.company.id, id])).rows;
    expect(audit).toEqual([
      { action: 'PROPOSE', actor_user_id: world.proposer.user, reason: 'No more bulk shifts (synthetic)' },
      { action: 'APPROVE', actor_user_id: world.approver.user, reason: null },
    ]);
    // Prior approved assignments stay traceable: the assignment and its switched-off entry are kept.
    const entry = await h.one<{ active: boolean }>(
      `select rap.active from role_assignment_permission rap join permission p on p.id = rap.permission_id where rap.role_assignment_id = $1 and p.resource = 'shift' and p.action = 'import'`,
      [world.hr.assignment],
    );
    expect(entry.active).toBe(false);
  });

  it('the list is for administrators of the company', async () => {
    expect((await h.call(hr, 'GET', PATH)).statusCode).toBe(403);
    expect((await h.call(proposer, 'GET', PATH)).statusCode).toBe(200);
    const elsewhere = await h.makeCompany();
    const other = await h.actor(elsewhere, 'SYSTEM_ADMINISTRATOR');
    expect((await h.call(other, 'GET', PATH)).json().items).toEqual([]);
  });
});

describe('the ceiling and existing grants (I-52; "No implicit grants")', () => {
  it('REMOVE takes effect on the next request, and restoring the ceiling revives no allowlist entry', async () => {
    const world = await freshWorld();
    const remove = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'holiday.read.operational', change: 'REMOVE', reason: 'Review (synthetic)' })).json();
    expect((await decision(world.hr, world.company, 'holiday', 'read')).allowed).toBe(true);
    expect((await approve(world.approver, remove.id)).statusCode).toBe(200);
    expect(await rolePermission(world.company, 'HR_ADMINISTRATOR', 'holiday.read.operational')).toBeNull();
    expect((await decision(world.hr, world.company, 'holiday', 'read')).allowed).toBe(false);

    const back = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'holiday.read.operational', change: 'ALLOW', reason: 'Review (synthetic)' })).json();
    expect((await approve(world.approver, back.id)).statusCode).toBe(200);
    expect(await rolePermission(world.company, 'HR_ADMINISTRATOR', 'holiday.read.operational')).toBe('ALLOW');
    // The ceiling is back; the earlier assignment does not hold it until a new grant is approved.
    expect((await decision(world.hr, world.company, 'holiday', 'read')).allowed).toBe(false);
    const fresh = await h.actor(world.company, 'HR_ADMINISTRATOR');
    expect((await decision(fresh, world.company, 'holiday', 'read')).allowed).toBe(true);
  });

  it('a grant holding a removed permission can still be revoked', async () => {
    const world = await freshWorld();
    const remove = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'holiday.manage.operational', change: 'REMOVE', reason: 'Review (synthetic)' })).json();
    expect((await approve(world.approver, remove.id)).statusCode).toBe(200);
    const { version } = await h.one<{ version: number }>(`select version from role_assignment where id = $1`, [world.hr.assignment]);
    const revoke = await h.call(world.proposer, 'POST', `/v1/access/assignments/${world.hr.assignment}/revoke`, { expectedVersion: version, reason: 'Left the team (synthetic)' });
    expect(revoke.statusCode, revoke.body).toBe(200);
  });

  it('a pending grant holding a removed permission is not approved; without it, it is', async () => {
    const world = await freshWorld();
    const user = await h.makeUser();
    const pending = await h.call(world.proposer, 'POST', '/v1/access/assignments', { userId: user, roleCode: 'HR_ADMINISTRATOR', effectiveFrom: '2026-01-01T00:00:00Z', permissions: ['holiday.manage.operational', 'holiday.read.operational'] });
    expect(pending.statusCode, pending.body).toBe(201);
    const remove = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'holiday.manage.operational', change: 'REMOVE', reason: 'Review (synthetic)' })).json();
    expect((await approve(world.approver, remove.id)).statusCode).toBe(200);
    const { version } = await h.one<{ version: number }>(`select version from role_assignment where id = $1`, [pending.json().id]);
    const refused = await h.call(world.approver, 'POST', `/v1/access/assignments/${pending.json().id}/approve`, { expectedVersion: version });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('OUTSIDE_ROLE_CEILING');
    expect((await h.one<{ state: string }>(`select state from role_assignment where id = $1`, [pending.json().id])).state).toBe('PENDING');
    const rejected = await h.call(world.approver, 'POST', `/v1/access/assignments/${pending.json().id}/reject`, { expectedVersion: version, reason: 'Propose it again (synthetic)' });
    expect(rejected.statusCode, rejected.body).toBe(200);
  });

  it('re-provisioning brings a company up to the baseline without undoing an approved removal or a DENY', async () => {
    const world = await freshWorld();
    const remove = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'holiday.manage.operational', change: 'REMOVE', reason: 'Review (synthetic)' })).json();
    expect((await approve(world.approver, remove.id)).statusCode).toBe(200);
    const deny = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'holiday.read.operational', change: 'DENY', reason: 'Review (synthetic)' })).json();
    expect((await approve(world.approver, deny.id)).statusCode).toBe(200);
    // A permission simply missing from a company's ceiling, with no decision behind it, does come back.
    await h.db.query(
      `delete from role_permission where company_id = $1 and role_id = (select id from role where company_id = $1 and code = 'HR_ADMINISTRATOR')
         and permission_id = (select id from permission where resource = 'shift' and action = 'read' and field_group = 'operational')`,
      [world.company.id],
    );
    await provisionCompany(h.db, { companyId: world.company.id, approvedBy: await h.makeUser(), effectiveFrom: '2026-01-01' });
    expect(await rolePermission(world.company, 'HR_ADMINISTRATOR', 'holiday.manage.operational')).toBeNull();
    expect(await rolePermission(world.company, 'HR_ADMINISTRATOR', 'holiday.read.operational')).toBe('DENY');
    expect(await rolePermission(world.company, 'HR_ADMINISTRATOR', 'shift.read.operational')).toBe('ALLOW');
  });

  it('the role catalogue offers what could be restored', async () => {
    const world = await freshWorld();
    const remove = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'holiday.manage.operational', change: 'REMOVE', reason: 'Review (synthetic)' })).json();
    expect((await approve(world.approver, remove.id)).statusCode).toBe(200);
    const roles = (await h.call(world.proposer, 'GET', '/v1/access/roles')).json().items as { code: string; restorable: string[] }[];
    expect(roles.find((r) => r.code === 'HR_ADMINISTRATOR')!.restorable).toEqual(['holiday.manage.operational']);
    expect(roles.find((r) => r.code === 'EMPLOYEE')!.restorable).toEqual([]);
  });
});

describe('scoped DENY in the access decision (C1 "no applicable scoped DENY ... only within its matched scope")', () => {
  const READ: PermissionKey[] = ['employee.list.operational', 'employee.read.operational'];

  /** A company where one role carries a DENY; `holder` also holds an assignment of that role, with the given scope. */
  async function denyWorld() {
    const world = await freshWorld();
    const denied = await h.call(world.proposer, 'POST', PATH, { roleCode: 'AUDITOR', permission: 'employee.read.operational', change: 'DENY', reason: 'Review (synthetic)' });
    expect(denied.statusCode, denied.body).toBe(201);
    expect((await approve(world.approver, denied.json().id)).statusCode).toBe(200);
    return world;
  }
  const person = async (world: Awaited<ReturnType<typeof freshWorld>>, overrides: Record<string, unknown> = {}) => {
    const res = await h.call(world.hr, 'POST', '/v1/employees', h.newEmployeeBody(world.company, overrides));
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };

  it('over the whole company it refuses the permission in every other assignment of that user in the company', async () => {
    const world = await denyWorld();
    const user = await h.makeUser();
    const allowed = await h.actor(world.company, 'HR_ADMINISTRATOR', { user, duties: READ });
    expect((await decision(allowed, world.company, 'employee', 'read')).allowed).toBe(true);
    await h.actor(world.company, 'AUDITOR', { user, duties: ['dashboard.read.operational'] });
    const after = await decision(allowed, world.company, 'employee', 'read');
    expect(after).toMatchObject({ allowed: false, reason: 'SCOPED_DENY' });
    expect((await h.call(allowed, 'GET', `/v1/employees/${await person(world)}`)).statusCode).toBe(403);
    // Another action is untouched: a deny matches exactly its permission.
    expect((await decision(allowed, world.company, 'employee', 'list')).allowed).toBe(true);
    // Another field group of the same action is untouched too, and only the denied one is reported.
    const both = await h.actor(world.company, 'HR_ADMINISTRATOR', { user, duties: [...READ, 'employee.read.personal'] });
    const d = await decision(both, world.company, 'employee', 'read', ['operational', 'personal']);
    expect(d).toMatchObject({ allowed: true, allowedFieldGroups: ['personal'], deniedFieldGroups: [{ fieldGroup: 'operational', reason: 'SCOPED_DENY' }] });
  });

  it('it does not reach another company, another user, or an ended or revoked assignment', async () => {
    const world = await denyWorld();
    const elsewhere = await h.makeCompany();
    const user = await h.makeUser();
    const here = await h.actor(world.company, 'HR_ADMINISTRATOR', { user, duties: READ });
    const there = await h.actor(elsewhere, 'HR_ADMINISTRATOR', { user, duties: READ });
    const seat = await h.actor(world.company, 'AUDITOR', { user, duties: ['dashboard.read.operational'] });
    expect((await decision(here, world.company, 'employee', 'read')).allowed).toBe(false);
    expect((await decision(there, elsewhere, 'employee', 'read')).allowed).toBe(true);
    const stranger = await h.actor(world.company, 'HR_ADMINISTRATOR', { duties: READ });
    expect((await decision(stranger, world.company, 'employee', 'read')).allowed).toBe(true);
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where company_id = $1 and id = $2`, [world.company.id, seat.assignment]);
    expect((await decision(here, world.company, 'employee', 'read')).allowed).toBe(true);
  });

  it('with filters it applies only inside them: those rows leave the grant, by detail, list and count, and others stay', async () => {
    const world = await denyWorld();
    const inside = await person(world, { departmentId: world.company.financeDept });
    const outside = await person(world, { departmentId: world.company.dept });
    const user = await h.makeUser();
    const allowed = await h.actor(world.company, 'HR_ADMINISTRATOR', { user, duties: READ });
    const before = await grantOf(allowed, world.company, 'employee', 'read');
    expect(await canAccessEmployee(h.pool, before, inside)).toBe(true);
    await h.actor(world.company, 'AUDITOR', { user, duties: ['dashboard.read.operational'], departmentFilter: world.company.financeDept });

    const grant = await grantOf(allowed, world.company, 'employee', 'read');
    expect(grant.deniedScopes).toMatchObject([{ scopeKind: 'COMPANY', filters: { departments: [world.company.financeDept] } }]);
    expect(await canAccessEmployee(h.pool, grant, inside)).toBe(false);
    expect(await canAccessEmployee(h.pool, grant, outside)).toBe(true);
    expect((await h.call(allowed, 'GET', `/v1/employees/${inside}`)).statusCode).toBe(404);
    expect((await h.call(allowed, 'GET', `/v1/employees/${outside}`)).statusCode).toBe(200);
    // The list runs under employee.list, which is not denied: the deny matches its permission, not everything on the row.
    const listGrant = await grantOf(allowed, world.company, 'employee', 'list');
    expect(listGrant.deniedScopes).toEqual([]);
  });

  it('a list under a denied permission loses exactly the matched rows, and its count with them', async () => {
    const world = await freshWorld();
    const denied = await h.call(world.proposer, 'POST', PATH, { roleCode: 'AUDITOR', permission: 'employee.list.operational', change: 'DENY', reason: 'Review (synthetic)' });
    expect((await approve(world.approver, denied.json().id)).statusCode).toBe(200);
    const inside = await person(world, { departmentId: world.company.financeDept });
    const outside = await person(world, { departmentId: world.company.dept });
    const user = await h.makeUser();
    const allowed = await h.actor(world.company, 'HR_ADMINISTRATOR', { user, duties: READ });
    await h.actor(world.company, 'AUDITOR', { user, duties: ['dashboard.read.operational'], departmentFilter: world.company.financeDept });
    const listed = (await h.call(allowed, 'GET', '/v1/employees')).json() as { items: { id: string }[]; total: number };
    expect(listed.items.map((e) => e.id)).toEqual([outside]);
    expect(listed.total).toBe(1);
    expect(listed.items.map((e) => e.id)).not.toContain(inside);
  });

  it('a team-scoped or own-scoped deny matches that person’s team or own record, and an assigned one only a task owner', async () => {
    const world = await freshWorld();
    for (const roleCode of ['REPORTING_MANAGER', 'EMPLOYEE']) {
      const denied = await h.call(world.proposer, 'POST', PATH, { roleCode, permission: 'employee.read.operational', change: 'DENY', reason: 'Review (synthetic)' });
      expect(denied.statusCode, denied.body).toBe(201);
      expect((await approve(world.approver, denied.json().id)).statusCode).toBe(200);
    }
    const managerEmp = await person(world);
    const report = await person(world);
    const other = await person(world);
    for (const e of [managerEmp, report, other]) await h.setStatus(world.company, e, 'ACTIVE_CONFIRMED');
    const linked = await h.call(world.hr, 'POST', `/v1/employees/${report}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    expect(linked.statusCode, linked.body).toBeLessThan(300);
    const SEAT: PermissionKey[] = ['dashboard.read.operational'];

    const manager = await h.makeUser();
    const asHr = await h.actor(world.company, 'HR_ADMINISTRATOR', { user: manager, duties: READ, employeeId: managerEmp });
    await h.actor(world.company, 'REPORTING_MANAGER', { user: manager, duties: SEAT });
    const team = await grantOf(asHr, world.company, 'employee', 'read');
    expect(team.deniedScopes).toMatchObject([{ scopeKind: 'TEAM' }]);
    expect(await canAccessEmployee(h.pool, team, report)).toBe(false);
    expect(await canAccessEmployee(h.pool, team, other)).toBe(true);

    const self = await h.makeUser();
    const selfHr = await h.actor(world.company, 'HR_ADMINISTRATOR', { user: self, duties: READ, employeeId: other });
    await h.actor(world.company, 'EMPLOYEE', { user: self, duties: SEAT });
    const own = await grantOf(selfHr, world.company, 'employee', 'read');
    expect(own.deniedScopes).toMatchObject([{ scopeKind: 'OWN' }]);
    expect(await canAccessEmployee(h.pool, own, other)).toBe(false);
    expect(await canAccessEmployee(h.pool, own, report)).toBe(true);

    const reviewer = await h.makeUser();
    const reviewerHr = await h.actor(world.company, 'HR_ADMINISTRATOR', { user: reviewer, duties: READ });
    await h.actor(world.company, 'REPORTING_MANAGER', { user: reviewer, scope: 'ASSIGNED', duties: SEAT });
    const assigned = await grantOf(reviewerHr, world.company, 'employee', 'read');
    expect(assigned.deniedScopes).toMatchObject([{ scopeKind: 'ASSIGNED' }]);
    expect(await canAccessEmployee(h.pool, assigned, other)).toBe(true); // no task the assignment can decide: nothing is matched
  });

  it('a DENY on the assignment’s own role is the absence of the permission, and approving one ends its entries', async () => {
    const world = await freshWorld();
    const id = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'employee.read_history.operational', change: 'DENY', reason: 'Review (synthetic)' })).json().id as string;
    const res = await approve(world.approver, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().resultingAccess).toMatchObject({ effectBefore: 'ALLOW', effectAfter: 'DENY', allowlistEntriesEnded: 1 });
    expect(await decision(world.hr, world.company, 'employee', 'read_history')).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' });
  });
});

describe('the database holds the decision (0132)', () => {
  const write = (id: string, set: string, ...values: unknown[]) => h.db.query(`update role_permission_change set ${set} where id = $1`, [id, ...values]);

  it('refuses a proposal starting decided, a decision by the requester, by a holder of the role or without the duty, and any edit', async () => {
    const id = await proposed('EMPLOYEE', 'attendance.read.reason', 'REMOVE');
    await expectSqlError(
      h.db.query(
        `insert into role_permission_change (company_id, role_id, permission_id, change_kind, state, reason, requested_by, requested_assignment_id, decided_by, decided_assignment_id, decided_at, resulting_access)
         select company_id, role_id, permission_id, change_kind, 'APPROVED', reason, requested_by, requested_assignment_id, $2, $3, now(), '{}' from role_permission_change where id = $1`,
        [id, approver.user, approver.assignment],
      ),
      CHECK_VIOLATION,
    );
    const decide = (user: string, assignment: string) => write(id, `state = 'APPROVED', decided_by = $2, decided_assignment_id = $3, decided_at = now(), resulting_access = '{}'`, user, assignment);
    await expectSqlError(decide(proposer.user, proposer.assignment), CHECK_VIOLATION);
    await expectSqlError(decide(hr.user, hr.assignment), CHECK_VIOLATION); // no approval duty
    const holder = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    await h.actor(A, 'EMPLOYEE', { user: holder.user, duties: ['employee.read.operational'] });
    await expectSqlError(decide(holder.user, holder.assignment), CHECK_VIOLATION);
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    await expectSqlError(decide(filtered.user, filtered.assignment), CHECK_VIOLATION);
    await expectSqlError(write(id, `state = 'APPROVED', decided_by = $2, decided_assignment_id = $3, decided_at = now() - interval '1 hour', resulting_access = '{}'`, approver.user, approver.assignment), CHECK_VIOLATION);
    await expectSqlError(write(id, `state = 'APPROVED', decided_by = $2, decided_assignment_id = $3, decided_at = now()`, approver.user, approver.assignment), CHECK_VIOLATION); // no resulting access
    await expectSqlError(write(id, `state = 'REJECTED', decided_by = $2, decided_assignment_id = $3, decided_at = now()`, approver.user, approver.assignment), CHECK_VIOLATION); // no reason
    await expectSqlError(write(id, `reason = 'Rewritten (synthetic)'`), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`delete from role_permission_change where id = $1`, [id]), CHECK_VIOLATION);
    await expect(h.db.query(`truncate role_permission_change`)).rejects.toThrow(/cannot be truncated/);
    expect((await reject(approver, id)).statusCode).toBe(200);
    await expectSqlError(write(id, `decision_reason = 'Rewritten (synthetic)', decided_at = now()`), CHECK_VIOLATION);
    await expectSqlError(write(id, `state = 'APPROVED', resulting_access = '{}', decision_reason = null`), CHECK_VIOLATION);
  });
});

describe('notices (DF12 "role-grant/security change")', () => {
  const inbox = async (a: TestActor, category: string) =>
    ((await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string; body: string }[]).filter((n) => n.category === category);

  it('a proposal reaches who could decide it, never its requester or a holder of the role; the decision reaches the requester; only states, never the reason', async () => {
    const world = await freshWorld();
    const holder = await h.actor(world.company, 'SYSTEM_ADMINISTRATOR');
    await h.actor(world.company, 'HR_ADMINISTRATOR', { user: holder.user });
    const id = (await h.call(world.proposer, 'POST', PATH, { roleCode: 'HR_ADMINISTRATOR', permission: 'holiday.manage.operational', change: 'REMOVE', reason: 'SECRET-REASON (synthetic)' })).json().id as string;
    await dispatchOutbox(h.pool);
    const told = await inbox(world.approver, 'ROLE_PERMISSION_CHANGE_PROPOSED');
    expect(told.map((n) => n.body)).toEqual(['A permission change to the HR_ADMINISTRATOR role is waiting for your approval.']);
    expect(await inbox(world.proposer, 'ROLE_PERMISSION_CHANGE_PROPOSED')).toEqual([]);
    expect(await inbox(holder, 'ROLE_PERMISSION_CHANGE_PROPOSED')).toEqual([]);
    expect((await reject(world.approver, id, 'SECRET-DECISION (synthetic)')).statusCode).toBe(200);
    await dispatchOutbox(h.pool);
    const decided = await inbox(world.proposer, 'ROLE_PERMISSION_CHANGE_DECIDED');
    expect(decided.map((n) => n.body)).toEqual(['The permission change you proposed to the HR_ADMINISTRATOR role was rejected.']);
    expect(JSON.stringify(decided)).not.toContain('SECRET');
  });
});

describe('end to end on the employee record', () => {
  it('removing the read duty from a role closes the record for its holders on the next request', async () => {
    const id = await newEmployee({ employeeCode: uniq('rp') });
    const reader = await h.actor(A, 'PAYROLL_OPERATOR');
    expect((await h.call(reader, 'GET', `/v1/employees/${id}`)).statusCode).toBe(200);
    const change = await approve(approver, await proposed('PAYROLL_OPERATOR', 'employee.read.operational', 'REMOVE'));
    expect(change.statusCode, change.body).toBe(200);
    expect((await h.call(reader, 'GET', `/v1/employees/${id}`)).statusCode).toBe(403);
  });
});
