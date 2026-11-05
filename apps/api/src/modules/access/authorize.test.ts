// C1 access engine tests against real PostgreSQL. Synthetic fixtures (BRD F3 rows 1, 2 and 9 style).
// Gates exercised at engine level: ZT01, ZT02, ZT03, ZT05, ZT29, ZT30; CI22, CI24.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CompanyFixture, fixtures, uniq } from '../../../../../db/tests/fixtures.js';
import { startTestDatabase, type TestDatabase } from '../../../../../db/tests/test-database.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, resolveAccess, SqlParams } from './authorize.js';

let testDb: TestDatabase;
let db: pg.Client;
let f: ReturnType<typeof fixtures>;

// Company A: manager M1 with current report E1, former report E2 (expired link), unrelated E3 in another
// department. Company B: employee BX.
let A: CompanyFixture;
let B: CompanyFixture;
let otherDept: string;
const emp: Record<string, string> = {};
const usr: Record<string, string> = {};
const roles: Record<string, string> = {};
const perm: Record<string, string> = {};
const resource = uniq('employee_t');
const expenseResource = uniq('expense_t');

async function assignment(opts: {
  user: string;
  role: string;
  scope: 'OWN' | 'TEAM' | 'ASSIGNED' | 'COMPANY';
  allow: string[];
  state?: 'ACTIVE' | 'REVOKED';
  to?: string | null;
  company?: CompanyFixture;
}): Promise<string> {
  const c = opts.company ?? A;
  const approver = await f.makeUser();
  const id = await f.id(
    `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, effective_to, state, approved_by, approved_at, created_by)
     values ($1, $2, $3, $4, '2026-01-01T00:00:00Z', $5, 'ACTIVE', $6, now(), $7)`,
    [c.company, opts.user, opts.role, opts.scope, opts.to ?? null, approver, SYSTEM_ACTOR_ID],
  );
  for (const p of opts.allow) {
    await db.query(
      `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from, effective_to)
       values ($1, $2, $3, true, '2026-01-01T00:00:00Z', $4)`,
      [c.company, id, p, opts.to ?? null],
    );
  }
  if (opts.state === 'REVOKED') {
    await db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [id]);
  }
  return id;
}

async function role(c: CompanyFixture, code: string, accessClass: 'ADMIN' | 'MANAGER' | 'OTHER', allows: string[]): Promise<string> {
  const id = await f.id(`insert into role (company_id, code, name, active, access_class) values ($1, $2, $2, true, $3)`, [
    c.company,
    code,
    accessClass,
  ]);
  for (const p of allows) {
    await db.query(`insert into role_permission (company_id, role_id, permission_id, effect) values ($1, $2, $3, 'ALLOW')`, [c.company, id, p]);
  }
  return id;
}

const read = (user: string, assignmentId: string, fieldGroups = ['operational', 'salary'], company = A) =>
  resolveAccess(db, { userId: user, companyId: company.company, assignmentId, resource, action: 'read', fieldGroups });

function granted(decision: Awaited<ReturnType<typeof resolveAccess>>): AccessGrant {
  if (!decision.allowed) throw new Error(`expected grant, got ${decision.reason}`);
  return decision;
}

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = testDb.client;
  // These tests build grants directly to exercise the access engine; db/tests/grant-guards.test.ts tests the guards.
  await db.query(`select set_config('hrms.grant_bootstrap', 'on', false)`);
  f = fixtures(db);

  A = await f.makeCompany();
  B = await f.makeCompany();
  otherDept = await f.id(`insert into department (company_id, code, name, active) values ($1, 'FIN', 'Finance', true)`, [A.company]);

  for (const code of ['M1', 'E1', 'E2', 'E3']) emp[code] = await f.makeEmployee(A, code);
  emp.BX = await f.makeEmployee(B, 'BX');

  const placeAt = (e: string, dept: string, c = A) =>
    db.query(
      `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, effective_from)
       values ($1, $2, $3, $4, $5, '2026-01-05')`,
      [c.company, e, dept, c.loc, c.desig],
    );
  await placeAt(emp.M1!, A.dept);
  await placeAt(emp.E1!, A.dept);
  await placeAt(emp.E2!, A.dept);
  await placeAt(emp.E3!, otherDept);

  await db.query(
    `insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from, effective_to) values
       ($1, $2, $4, '2026-01-05', null),
       ($1, $3, $4, '2026-01-05', '2026-02-01')`,
    [A.company, emp.E1, emp.E2, emp.M1],
  );

  for (const u of ['manager', 'employee', 'finance', 'hr', 'mixed', 'inactive']) usr[u] = await f.makeUser();
  await f.linkUser(A, usr.manager!, emp.M1!);
  await f.linkUser(A, usr.employee!, emp.E1!);
  await db.query('update user_account set active = false where id = $1', [usr.inactive]);

  const p = (action: string, fieldGroup: string, res = resource) =>
    f.id(`insert into permission (resource, action, field_group) values ($1, $2, $3)`, [res, action, fieldGroup]);
  perm.readOperational = await p('read', 'operational');
  perm.readSalary = await p('read', 'salary');
  perm.updateOperational = await p('update', 'operational');
  perm.expenseDecide = await p('finance_decide', 'operational', expenseResource);

  // Operational group is classified OPERATIONAL; salary has no policy row, so it defaults to CONFIDENTIAL.
  for (const res of [resource, expenseResource]) {
    await db.query(
      `insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at)
       values ($1, $2, 'operational', 'OPERATIONAL', '2026-01-01', $3, now())`,
      [A.company, res, await f.makeUser()],
    );
  }

  const all = [perm.readOperational, perm.readSalary, perm.updateOperational, perm.expenseDecide];
  roles.manager = await role(A, 'REPORTING_MANAGER', 'MANAGER', all);
  roles.employee = await role(A, 'EMPLOYEE', 'OTHER', all);
  roles.finance = await role(A, 'FINANCE_REVIEWER', 'OTHER', all);
  roles.hr = await role(A, 'HR_ADMINISTRATOR', 'ADMIN', all);
});

afterAll(async () => {
  await testDb?.stop();
});

describe('row scope (ZT01, ZT02)', () => {
  it('TEAM shows only current direct reports in the same company', async () => {
    const asg = await assignment({ user: usr.manager!, role: roles.manager!, scope: 'TEAM', allow: [perm.readOperational!] });
    const grant = granted(await read(usr.manager!, asg, ['operational']));
    expect(await canAccessEmployee(db, grant, emp.E1!)).toBe(true);
    expect(await canAccessEmployee(db, grant, emp.E2!)).toBe(false); // expired reporting line
    expect(await canAccessEmployee(db, grant, emp.E3!)).toBe(false); // unrelated
    expect(await canAccessEmployee(db, grant, emp.BX!)).toBe(false); // other company, direct id
  });

  it('OWN shows only the linked employee', async () => {
    const asg = await assignment({ user: usr.employee!, role: roles.employee!, scope: 'OWN', allow: [perm.readOperational!] });
    const grant = granted(await read(usr.employee!, asg, ['operational']));
    expect(await canAccessEmployee(db, grant, emp.E1!)).toBe(true);
    expect(await canAccessEmployee(db, grant, emp.M1!)).toBe(false);
  });

  it('COMPANY scope is narrowed by department filters and never crosses companies', async () => {
    const asg = await assignment({ user: usr.hr!, role: roles.hr!, scope: 'COMPANY', allow: [perm.readOperational!] });
    await db.query(
      `insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`,
      [A.company, asg, otherDept],
    );
    const grant = granted(await read(usr.hr!, asg, ['operational']));
    expect(await canAccessEmployee(db, grant, emp.E3!)).toBe(true);
    expect(await canAccessEmployee(db, grant, emp.E1!)).toBe(false);
    expect(await canAccessEmployee(db, grant, emp.BX!)).toBe(false);
  });

  it('list predicate and single-record check agree (BR-026/045)', async () => {
    const asg = await assignment({ user: usr.manager!, role: roles.manager!, scope: 'TEAM', allow: [perm.readOperational!] });
    const grant = granted(await read(usr.manager!, asg, ['operational']));
    const params = new SqlParams();
    const predicate = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
    const listed = (await db.query<{ id: string }>(`select e.id from employee e where ${predicate}`, params.values)).rows.map((r) => r.id);
    expect(listed).toEqual([emp.E1]);
  });

  it('an assignment of company A cannot be used to act in company B', async () => {
    const asg = await assignment({ user: usr.hr!, role: roles.hr!, scope: 'COMPANY', allow: [perm.readOperational!] });
    const decision = await read(usr.hr!, asg, ['operational'], B);
    expect(decision).toMatchObject({ allowed: false, reason: 'ASSIGNMENT_NOT_ACTIVE' });
  });
});

describe('confidential fields (ZT03, ZT29, BR-044)', () => {
  it('eligible MANAGER with a salary grant reads salary', async () => {
    const asg = await assignment({
      user: usr.manager!,
      role: roles.manager!,
      scope: 'TEAM',
      allow: [perm.readOperational!, perm.readSalary!],
    });
    expect(granted(await read(usr.manager!, asg)).allowedFieldGroups.sort()).toEqual(['operational', 'salary']);
  });

  it('eligible MANAGER without an assignment-level salary grant does not (DB109 narrowing)', async () => {
    const asg = await assignment({ user: usr.manager!, role: roles.manager!, scope: 'TEAM', allow: [perm.readOperational!] });
    const grant = granted(await read(usr.manager!, asg));
    expect(grant.allowedFieldGroups).toEqual(['operational']);
    expect(grant.deniedFieldGroups).toEqual([{ fieldGroup: 'salary', reason: 'NO_PERMISSION' }]);
  });

  it('ineligible roles never read confidential fields, even with a grant', async () => {
    const finance = await assignment({ user: usr.finance!, role: roles.finance!, scope: 'COMPANY', allow: [perm.readSalary!] });
    expect(await read(usr.finance!, finance, ['salary'])).toMatchObject({ allowed: false, reason: 'CONFIDENTIAL_NOT_ELIGIBLE' });

    const own = await assignment({ user: usr.employee!, role: roles.employee!, scope: 'OWN', allow: [perm.readOperational!, perm.readSalary!] });
    const grant = granted(await read(usr.employee!, own)); // own salary is still denied (no own-record exception)
    expect(grant.allowedFieldGroups).toEqual(['operational']);
    expect(grant.deniedFieldGroups).toEqual([{ fieldGroup: 'salary', reason: 'CONFIDENTIAL_NOT_ELIGIBLE' }]);
  });
});

describe('assignment isolation, expiry and revocation (ZT05, ZT30, CI22, CI24)', () => {
  it('cannot stitch a salary grant from one assignment onto another assignment scope', async () => {
    // Finance assignment has a salary grant but is ineligible; manager assignment is eligible but has no salary grant.
    const financeAsg = await assignment({ user: usr.mixed!, role: roles.finance!, scope: 'COMPANY', allow: [perm.readSalary!] });
    const managerAsg = await assignment({ user: usr.mixed!, role: roles.manager!, scope: 'TEAM', allow: [perm.readOperational!] });
    expect(await read(usr.mixed!, financeAsg, ['salary'])).toMatchObject({ allowed: false });
    expect(await read(usr.mixed!, managerAsg, ['salary'])).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' });
  });

  it('F3: finance-duty Admin assignment can decide expenses but cannot edit employees or read salary', async () => {
    const asg = await assignment({ user: usr.hr!, role: roles.hr!, scope: 'COMPANY', allow: [perm.expenseDecide!] });
    const ask = (res: string, action: string, fieldGroups: string[]) =>
      resolveAccess(db, { userId: usr.hr!, companyId: A.company, assignmentId: asg, resource: res, action, fieldGroups });
    expect((await ask(expenseResource, 'finance_decide', ['operational'])).allowed).toBe(true);
    expect(await ask(resource, 'update', ['operational'])).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' });
    expect(await ask(resource, 'read', ['salary'])).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' });
  });

  it('an empty allowlist denies every action', async () => {
    const asg = await assignment({ user: usr.hr!, role: roles.hr!, scope: 'COMPANY', allow: [] });
    expect(await read(usr.hr!, asg, ['operational'])).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' });
  });

  it('denies revoked, expired and other users’ assignments, and inactive users', async () => {
    const revoked = await assignment({ user: usr.hr!, role: roles.hr!, scope: 'COMPANY', allow: [perm.readOperational!], state: 'REVOKED' });
    expect(await read(usr.hr!, revoked, ['operational'])).toMatchObject({ allowed: false, reason: 'ASSIGNMENT_NOT_ACTIVE' });

    const expired = await assignment({
      user: usr.hr!,
      role: roles.hr!,
      scope: 'COMPANY',
      allow: [perm.readOperational!],
      to: '2026-02-01T00:00:00Z',
    });
    expect(await read(usr.hr!, expired, ['operational'])).toMatchObject({ allowed: false, reason: 'ASSIGNMENT_NOT_ACTIVE' });

    const someoneElse = await assignment({ user: usr.manager!, role: roles.manager!, scope: 'TEAM', allow: [perm.readOperational!] });
    expect(await read(usr.hr!, someoneElse, ['operational'])).toMatchObject({ allowed: false, reason: 'ASSIGNMENT_NOT_ACTIVE' });

    const inactive = await assignment({ user: usr.inactive!, role: roles.hr!, scope: 'COMPANY', allow: [perm.readOperational!] });
    expect(await read(usr.inactive!, inactive, ['operational'])).toMatchObject({ allowed: false, reason: 'USER_INACTIVE' });
  });

  it('a grant revoked mid-session denies the next request', async () => {
    const asg = await assignment({ user: usr.hr!, role: roles.hr!, scope: 'COMPANY', allow: [perm.readOperational!] });
    expect((await read(usr.hr!, asg, ['operational'])).allowed).toBe(true);
    await db.query(`update role_assignment_permission set active = false where role_assignment_id = $1`, [asg]);
    expect(await read(usr.hr!, asg, ['operational'])).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' });
  });

  it('a role-level DENY overrides an allowlist entry', async () => {
    const asg = await assignment({ user: usr.hr!, role: roles.hr!, scope: 'COMPANY', allow: [perm.readOperational!] });
    await db.query(`update role_permission set effect = 'DENY' where role_id = $1 and permission_id = $2`, [roles.hr, perm.readOperational]);
    try {
      expect(await read(usr.hr!, asg, ['operational'])).toMatchObject({ allowed: false, reason: 'NO_PERMISSION' });
    } finally {
      await db.query(`update role_permission set effect = 'ALLOW' where role_id = $1 and permission_id = $2`, [roles.hr, perm.readOperational]);
    }
  });
});
