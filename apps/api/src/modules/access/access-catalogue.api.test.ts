// Pickers for grant administration over HTTP (FR-066; C4; DF02): the role catalogue and company users.
// Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let B: Company;
let sysAdmin: TestActor;
let hr: TestActor;
let engUser: TestActor;
let finUser: TestActor;
let auditor: TestActor;
let bAdmin: TestActor;
let bHr: TestActor;
let engCode: string;
let finCode: string;
let finEmployeeId: string;

type UserRow = { userId: string; accountKey: string; active: boolean; employee: { id: string; employeeCode: string; displayName: string } | null; assignments: { active: number; pending: number } };
type RoleRow = { code: string; name: string; accessClass: string; defaultScope: string | null; active: boolean; permissions: { key: string; confidential: boolean; defaultDuty: boolean }[] };
const users = async (a: TestActor, query = '') => {
  const res = await h.call(a, 'GET', `/v1/access/users${query}`);
  expect(res.statusCode).toBe(200);
  return res.json() as { items: UserRow[]; total: number };
};
const roles = async (a: TestActor) => {
  const res = await h.call(a, 'GET', '/v1/access/roles');
  expect(res.statusCode).toBe(200);
  return res.json().items as RoleRow[];
};
const accountKey = async (userId: string) => (await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [userId])).account_key;
/** The rows for one user, found by account key (a substring search, so other keys may also match). */
const rowsOf = async (a: TestActor, userId: string) =>
  (await users(a, `?pageSize=100&search=${encodeURIComponent(await accountKey(userId))}`)).items.filter((u) => u.userId === userId);
const permissionId = async (key: string) => {
  const [resource, action, fieldGroup] = key.split('.');
  return (await h.one<{ id: string }>(`select id from permission where resource = $1 and action = $2 and field_group = $3`, [resource, action, fieldGroup])).id;
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  sysAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const eng = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  const fin = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.financeDept }))).json();
  engCode = eng.employeeCode;
  finCode = fin.employeeCode;
  finEmployeeId = fin.id;
  engUser = await h.actor(A, 'EMPLOYEE', { employeeId: eng.id });
  finUser = await h.actor(A, 'EMPLOYEE', { employeeId: fin.id });
  auditor = await h.actor(A, 'AUDITOR'); // an account with an assignment but no employee link
  bHr = await h.actor(B, 'HR_ADMINISTRATOR'); // another company's users must never appear
  bAdmin = await h.actor(B, 'SYSTEM_ADMINISTRATOR');
  const proposed = await h.call(sysAdmin, 'POST', '/v1/access/assignments', { userId: engUser.user, roleCode: 'TRAINING_COORDINATOR', effectiveFrom: '2026-01-01T00:00:00Z' });
  expect(proposed.statusCode).toBe(201);
});

afterAll(async () => {
  await h?.stop();
});

describe('role catalogue (FR-066, DF02)', () => {
  it('lists each role with its ceiling, classification and default duties', async () => {
    const all = await roles(sysAdmin);
    expect(all.map((r) => r.code)).toEqual([...all.map((r) => r.code)].sort());
    const hrRole = all.find((r) => r.code === 'HR_ADMINISTRATOR')!;
    expect(hrRole).toMatchObject({ accessClass: 'ADMIN', defaultScope: 'COMPANY' });
    const perm = (key: string) => hrRole.permissions.find((p) => p.key === key);
    expect(perm('salary.read.salary')).toEqual({ key: 'salary.read.salary', confidential: true, ownEss: false, defaultDuty: false });
    expect(perm('employee.list.operational')).toEqual({ key: 'employee.list.operational', confidential: false, ownEss: false, defaultDuty: true });
    expect(perm('confirmation.read.reason')).toEqual({ key: 'confirmation.read.reason', confidential: true, ownEss: false, defaultDuty: false });
    // Code-point order whatever the database locale ('.' sorts before '_').
    const keys = hrRole.permissions.map((p) => p.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys.indexOf('leave.read.operational')).toBeLessThan(keys.indexOf('leave_policy.manage.operational'));
    // BRD v8.2 H1: the Employee role's only confidential permissions are the catalogued own-ESS ones.
    const employeeRole = all.find((r) => r.code === 'EMPLOYEE')!;
    const confidentialKeys = employeeRole.permissions.filter((p) => p.confidential).map((p) => p.key);
    expect(confidentialKeys.sort()).toEqual([
      // FR-042 / H3 TN18: the employee's own appraisal self-entry (own record only, H1/BR-053).
      'appraisal.read.self',
      'appraisal.self_assess.self',
      'attendance.read.reason',
      // FR-106 / DF06 (v8.2): own documents and own released receipts.
      'document.read.document',
      'document.upload.document',
      'employee.read.personal',
      'employee.read.private',
      // FR-051: the reason of the employee's own resignation (own submission, H1/BR-053).
      'exit.read.reason',
      'expense.view_receipt.receipt',
      'leave.read.reason',
      // FR-034 / H3 TN15: the employee's own loan and advance requests (own record only, H1/BR-053).
      'own_loan.read.loan',
      'own_loan.request.loan',
      // FR-107 / H3 TN06: the employee's own issued payslips (own record only, H1/BR-053).
      'payslip.read.payslip',
      // FR-104/105: the employee's own sensitive change requests.
      'sensitive_change.read.private',
      'sensitive_change.submit.private',
      // F1 / H3 TN17: the employee's own restricted training feedback comment (own record only, H1/BR-053).
      'training_feedback.read.comment',
      'training_feedback.submit.comment',
    ]);
    expect(employeeRole.permissions.filter((p) => p.confidential).every((p) => (p as { ownEss?: boolean }).ownEss === true)).toBe(true);
    // No other role is marked own-ESS.
    expect(all.filter((r) => r.code !== 'EMPLOYEE').every((r) => r.permissions.every((p) => !(p as { ownEss?: boolean }).ownEss))).toBe(true);
  });

  it('is company-specific: other companies’ roles and classification policies never leak', async () => {
    const approver = await h.makeUser();
    // Company B: a role of its own, salary reclassified as operational, the holiday operational policy ended.
    await h.db.query(`insert into role (company_id, code, name, active, access_class) values ($1, 'B_ONLY_ROLE', 'B only (synthetic)', true, 'OTHER')`, [B.id]);
    await h.db.query(
      `insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at)
       values ($1, 'salary', 'salary', 'OPERATIONAL', '2026-01-01', $2, now())`,
      [B.id, approver],
    );
    await h.db.query(
      `update confidential_field_policy set effective_to = '2026-02-01'
        where company_id = $1 and resource_code = 'holiday' and field_group = 'operational'`,
      [B.id],
    );
    // Company A: an inactive custom role with one allowed and one denied permission.
    const legacy = (
      await h.one<{ id: string }>(`insert into role (company_id, code, name, active, access_class) values ($1, 'LEGACY_CLERK', 'Legacy clerk', false, 'OTHER') returning id`, [A.id])
    ).id;
    for (const [key, effect] of [['employee.list.operational', 'ALLOW'], ['employee.read.operational', 'DENY']] as const) {
      await h.db.query(`insert into role_permission (company_id, role_id, permission_id, effect) values ($1, $2, $3, $4)`, [A.id, legacy, await permissionId(key), effect]);
    }

    const inA = await roles(sysAdmin);
    const codes = inA.map((r) => r.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes).not.toContain('B_ONLY_ROLE');
    expect(inA.find((r) => r.code === 'LEGACY_CLERK')).toEqual({
      code: 'LEGACY_CLERK',
      name: 'Legacy clerk',
      accessClass: 'OTHER',
      defaultScope: null,
      active: false,
      permissions: [{ key: 'employee.list.operational', confidential: false, ownEss: false, defaultDuty: false }],
    });
    const hrA = inA.find((r) => r.code === 'HR_ADMINISTRATOR')!;
    expect(hrA.permissions.find((p) => p.key === 'salary.read.salary')?.confidential).toBe(true);
    expect(hrA.permissions.find((p) => p.key === 'holiday.read.operational')?.confidential).toBe(false);

    const inB = await roles(bAdmin);
    expect(inB.find((r) => r.code === 'B_ONLY_ROLE')).toMatchObject({ active: true, defaultScope: null, permissions: [] });
    expect(inB.map((r) => r.code)).not.toContain('LEGACY_CLERK');
    const hrB = inB.find((r) => r.code === 'HR_ADMINISTRATOR')!;
    expect(hrB.permissions.find((p) => p.key === 'salary.read.salary')?.confidential).toBe(false);
    // A policy that has ended no longer applies: the field group is confidential again (BR-043), as a proposal would decide.
    expect(hrB.permissions.find((p) => p.key === 'holiday.read.operational')).toEqual({ key: 'holiday.read.operational', confidential: true, ownEss: false, defaultDuty: true });
  });

  it('needs the user-administration duty', async () => {
    expect((await h.call(engUser, 'GET', '/v1/access/roles')).statusCode).toBe(403);
    expect((await h.call(hr, 'GET', '/v1/access/roles')).statusCode).toBe(403);
  });
});

describe('company users (FR-066, C4)', () => {
  it('lists linked and assignment-only users of the company with their assignment counts', async () => {
    const all = await users(sysAdmin, '?pageSize=100');
    const ids = all.items.map((u) => u.userId);
    expect(ids).toEqual(expect.arrayContaining([sysAdmin.user, hr.user, engUser.user, finUser.user, auditor.user]));
    expect(all.total).toBe(all.items.length);
    expect(new Set(ids).size).toBe(ids.length);
    const eng = all.items.find((u) => u.userId === engUser.user)!;
    expect(eng).toMatchObject({ active: true, employee: { employeeCode: engCode }, assignments: { active: 1, pending: 1 } });
    expect(all.items.find((u) => u.userId === auditor.user)).toMatchObject({ employee: null, assignments: { active: 1, pending: 0 } });
    // Operational identity only.
    // `version` is the lock token deactivating an account needs (0100); still no personal or confidential field.
    expect(Object.keys(eng).sort()).toEqual(['accountKey', 'active', 'assignments', 'employee', 'userId', 'version']);
    expect(Object.keys(eng.employee!).sort()).toEqual(['displayName', 'employeeCode', 'id']);
  });

  it('never shows another company’s users', async () => {
    const otherCompanyOnly = await h.db.query<{ user_id: string }>(
      `select user_id from role_assignment where company_id = $1
       except (select user_id from role_assignment where company_id = $2 union select user_id from user_employee_link where company_id = $2)`,
      [B.id, A.id],
    );
    expect(otherCompanyOnly.rows.length).toBeGreaterThan(0);
    const ids = (await users(sysAdmin, '?pageSize=100')).items.map((u) => u.userId);
    for (const r of otherCompanyOnly.rows) expect(ids).not.toContain(r.user_id);
  });

  it('a user of two companies shows only this company’s employee link and in-force grants', async () => {
    const bEmployee = (await h.call(bHr, 'POST', '/v1/employees', h.newEmployeeBody(B))).json();
    const shared = await h.makeUser();
    await h.actor(B, 'EMPLOYEE', { user: shared, employeeId: bEmployee.id });
    await h.actor(B, 'TRAINING_COORDINATOR', { user: shared });
    await h.actor(A, 'AUDITOR', { user: shared });
    // In A also: a grant that has ended and a revoked one; neither counts.
    await h.db.query(
      `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, effective_to, state, approved_by, approved_at)
       select $1, $2, r.id, 'COMPANY', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 'ACTIVE', $3, now() from role r where r.company_id = $1 and r.code = 'AUDITOR'`,
      [A.id, shared, sysAdmin.user],
    );
    await h.db.query(
      `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, decision_reason)
       select $1, $2, r.id, 'COMPANY', '2026-01-01T00:00:00Z', 'REVOKED', 'No longer needed (synthetic)' from role r where r.company_id = $1 and r.code = 'RECRUITER'`,
      [A.id, shared],
    );

    expect(await rowsOf(sysAdmin, shared)).toEqual([
      { userId: shared, accountKey: await accountKey(shared), active: true, version: expect.any(Number), employee: null, assignments: { active: 1, pending: 0 } },
    ]);
    expect(await rowsOf(bAdmin, shared)).toMatchObject([
      { userId: shared, employee: { id: bEmployee.id, employeeCode: bEmployee.employeeCode }, assignments: { active: 2, pending: 0 } },
    ]);
    // B's employee code is not searchable from A.
    expect((await users(sysAdmin, `?search=${encodeURIComponent(bEmployee.employeeCode)}`)).total).toBe(0);
  });

  it('a link that has ended keeps the account listed without its former employee', async () => {
    const former = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    const user = await h.makeUser();
    await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2026-01-01', '2026-02-01')`, [
      A.id,
      user,
      former.id,
    ]);
    expect(await rowsOf(sysAdmin, user)).toMatchObject([{ userId: user, employee: null, assignments: { active: 0, pending: 0 } }]);
    expect((await users(sysAdmin, `?search=${encodeURIComponent(former.employeeCode)}`)).total).toBe(0);
  });

  it('searches by employee code, account key or display name (case-insensitive, wildcards literal) and pages', async () => {
    expect((await users(sysAdmin, `?search=${engCode.toLowerCase()}`)).items.map((u) => u.userId)).toEqual([engUser.user]);
    const auditorKey = await accountKey(auditor.user);
    expect((await users(sysAdmin, `?search=${encodeURIComponent(auditorKey.toUpperCase())}`)).items.map((u) => u.userId)).toEqual([auditor.user]);
    for (const literal of ['%', '_', '\\']) {
      expect(await users(sysAdmin, `?search=${encodeURIComponent(literal)}`)).toEqual({ items: [], total: 0 });
    }
    const named = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: 'Zephyrine Quill' }))).json();
    const namedUser = await h.actor(A, 'EMPLOYEE', { employeeId: named.id });
    expect((await users(sysAdmin, `?search=${encodeURIComponent(' zEPHYRINE q ')}`)).items.map((u) => u.userId)).toEqual([namedUser.user]);

    // A blank search (as the contract's `search=` sends it) lists everyone.
    const everyone = await users(sysAdmin);
    expect((await users(sysAdmin, '?search=')).total).toBe(everyone.total);
    expect((await users(sysAdmin, `?search=${encodeURIComponent('   ')}`)).total).toBe(everyone.total);

    const first = await users(sysAdmin, '?pageSize=2&page=1');
    const second = await users(sysAdmin, '?pageSize=2&page=2');
    expect(first.items).toHaveLength(2);
    expect(second.total).toBe(first.total);
    expect(second.items.map((u) => u.userId)).not.toContain(first.items[0]!.userId);
    expect((await h.call(sysAdmin, 'GET', '/v1/access/users?pageSize=101')).statusCode).toBe(400);
    expect((await h.call(sysAdmin, 'GET', `/v1/access/users?search=${'x'.repeat(101)}`)).statusCode).toBe(400);
  });

  it('pages partition the list in a stable order with unlinked accounts last; past the end keeps the total', async () => {
    const all = await users(sysAdmin, '?pageSize=100');
    expect(all.total).toBeGreaterThan(6);
    const paged: string[] = [];
    for (let page = 1; paged.length < all.total; page++) {
      const res = await users(sysAdmin, `?pageSize=3&page=${page}`);
      expect(res.total).toBe(all.total);
      expect(res.items.length).toBeGreaterThan(0);
      paged.push(...res.items.map((u) => u.userId));
    }
    expect(paged).toEqual(all.items.map((u) => u.userId));
    const firstUnlinked = all.items.findIndex((u) => u.employee === null);
    expect(firstUnlinked).toBeGreaterThan(0);
    expect(all.items.slice(firstUnlinked).every((u) => u.employee === null)).toBe(true);

    expect(await users(sysAdmin, '?pageSize=100&page=999')).toEqual({ items: [], total: all.total });
    expect(await users(sysAdmin, `?page=999&search=${encodeURIComponent(engCode)}`)).toEqual({ items: [], total: 1 });
  });

  it('an administrator restricted to a department sees only users of employees in it', async () => {
    const engAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    const scoped = await users(engAdmin, '?pageSize=100');
    const ids = scoped.items.map((u) => u.userId);
    expect(ids).toContain(engUser.user);
    expect(ids).not.toContain(finUser.user);
    expect(ids).not.toContain(auditor.user); // unlinked accounts are outside a filtered scope
    expect(scoped.total).toBe(scoped.items.length);
    // Search and total stay inside the scope.
    expect(await users(engAdmin, `?search=${encodeURIComponent(finCode)}`)).toEqual({ items: [], total: 0 });
    expect((await users(engAdmin, `?search=${encodeURIComponent(engCode)}`)).items.map((u) => u.userId)).toEqual([engUser.user]);
  });

  it('an administrator restricted to one employee sees only that employee’s user', async () => {
    const narrowAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    await h.db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, employee_id) values ($1, $2, 'EMPLOYEE', $3)`, [
      A.id,
      narrowAdmin.assignment,
      finEmployeeId,
    ]);
    const scoped = await users(narrowAdmin, '?pageSize=100');
    expect(scoped.items.map((u) => u.userId)).toEqual([finUser.user]);
    expect(scoped.total).toBe(1);
  });

  it('needs the user-administration duty in company scope', async () => {
    expect((await h.call(engUser, 'GET', '/v1/access/users')).statusCode).toBe(403);
    const manager = await h.actor(A, 'REPORTING_MANAGER');
    expect((await h.call(manager, 'GET', '/v1/access/users')).statusCode).toBe(403);
    // Holding the duty is not enough outside company scope (same boundary as proposing grants).
    // C2 fixes System Administrator at company scope, so a role C2 does not name stands in.
    const narrow = await h.customActor(A, { scope: 'TEAM', permissions: ['access.read_users.operational'] });
    expect((await h.call(narrow, 'GET', '/v1/access/users')).statusCode).toBe(403);
    // The denial is audited like any other (FR-098), without payload.
    const denial = await h.one<{ after_values: { action: string; reason: string } }>(
      `select after_values from audit_event where company_id = $1 and actor_user_id = $2 and action = 'ACCESS_DENIED' and resource_code = 'access'`,
      [A.id, narrow.user],
    );
    expect(denial.after_values).toMatchObject({ action: 'read_users', reason: 'OUT_OF_SCOPE' });
  });
});
