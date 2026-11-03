// Direct-write constraint tests for migration 0001 (ZT06–ZT09 database layer; CI09, CI13, CI15, CI24).
// Runs against a disposable PostgreSQL (see test-database.ts). Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CHECK_VIOLATION,
  type CompanyFixture,
  EXCLUSION_VIOLATION,
  expectSqlError,
  FK_VIOLATION,
  fixtures,
  UNIQUE_VIOLATION,
  uniq,
} from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase;
let db: pg.Client;
let f: ReturnType<typeof fixtures>;

const one = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => f.one<T>(sql, params);
const id = (sql: string, params: unknown[] = []) => f.id(sql, params);
const makeCompany = (code: string) => f.makeCompany(code);
const makeEmployee = (c: CompanyFixture, code: string) => f.makeEmployee(c, code);
const makeUser = (key: string) => f.makeUser(key);

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = testDb.client;
  f = fixtures(db);
});

afterAll(async () => {
  await testDb?.stop();
});

describe('tenancy and organisation (ZT06, ZT08)', () => {
  let a: CompanyFixture;
  let b: CompanyFixture;
  beforeEach(async () => {
    a = await makeCompany(uniq('A'));
    b = await makeCompany(uniq('B'));
  });

  it('rejects an assignment in company A pointing at a department of company B', async () => {
    const emp = await makeEmployee(a, 'E1');
    await expectSqlError(
      db.query(
        `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, effective_from)
         values ($1, $2, $3, $4, $5, '2026-01-05')`,
        [a.company, emp, b.dept, a.loc, a.desig],
      ),
      FK_VIOLATION,
    );
  });

  it('rejects a reference value of the wrong category (CI15)', async () => {
    await expectSqlError(
      db.query(
        `insert into employee (company_id, employee_code, display_name, joining_date, employment_type_id, status_id)
         values ($1, 'E2', 'E2', '2026-01-05', $2, $2)`,
        [a.company, a.empType],
      ),
      FK_VIOLATION,
    );
  });

  it('rejects deleting a referenced master', async () => {
    const emp = await makeEmployee(a, 'E3');
    await db.query(
      `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, effective_from)
       values ($1, $2, $3, $4, $5, '2026-01-05')`,
      [a.company, emp, a.dept, a.loc, a.desig],
    );
    await expectSqlError(db.query('delete from department where id = $1', [a.dept]), FK_VIOLATION);
  });
});

describe('employee identity and history (ZT07, ZT09, BR-001/002)', () => {
  let a: CompanyFixture;
  let b: CompanyFixture;
  beforeEach(async () => {
    a = await makeCompany(uniq('A'));
    b = await makeCompany(uniq('B'));
  });

  it('enforces a unique employee code per company but allows it in another company', async () => {
    await makeEmployee(a, 'EMP001');
    await expectSqlError(makeEmployee(a, 'EMP001'), UNIQUE_VIOLATION);
    await expect(makeEmployee(b, 'EMP001')).resolves.toBeTypeOf('string');
  });

  it('rejects non-normalised employee codes', async () => {
    await expectSqlError(makeEmployee(a, ' emp002'), CHECK_VIOLATION);
  });

  it('rejects confirmation before joining', async () => {
    await expectSqlError(
      db.query(
        `insert into employee (company_id, employee_code, display_name, joining_date, confirmation_date, employment_type_id, status_id)
         values ($1, 'E9', 'E9', '2026-03-01', '2026-02-01', $2, $3)`,
        [a.company, a.empType, a.statusActive],
      ),
      CHECK_VIOLATION,
    );
  });

  it('rejects overlapping employment assignments and accepts adjacent ones', async () => {
    const emp = await makeEmployee(a, 'E4');
    const insert = (from: string, to: string | null) =>
      db.query(
        `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, effective_from, effective_to)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [a.company, emp, a.dept, a.loc, a.desig, from, to],
      );
    await insert('2026-01-05', '2026-06-01');
    await expect(insert('2026-06-01', null)).resolves.toBeDefined(); // half-open: adjacent is not overlap
    await expectSqlError(insert('2026-05-01', '2026-07-01'), EXCLUSION_VIOLATION);
  });

  it('refuses physical deletion of an employee (DF08)', async () => {
    const emp = await makeEmployee(a, 'E5');
    await expectSqlError(db.query('delete from employee where id = $1', [emp]), CHECK_VIOLATION);
  });

  it('manages version and protects company ownership', async () => {
    const emp = await makeEmployee(a, 'E6');
    const updated = await one<{ version: number }>(
      `update employee set display_name = 'E6 renamed' where id = $1 and version = 1 returning version`,
      [emp],
    );
    expect(updated.version).toBe(2);
    await expectSqlError(db.query('update employee set version = 99 where id = $1', [emp]), CHECK_VIOLATION);
    await expectSqlError(db.query('update employee set company_id = $2 where id = $1', [emp, b.company]), CHECK_VIOLATION);
  });
});

describe('reporting lines (CI13, BR-005)', () => {
  let a: CompanyFixture;
  beforeEach(async () => {
    a = await makeCompany(uniq('A'));
  });

  const assign = (c: CompanyFixture, emp: string, mgr: string, from: string, to: string | null) =>
    db.query(
      `insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from, effective_to)
       values ($1, $2, $3, $4, $5)`,
      [c.company, emp, mgr, from, to],
    );

  it('rejects self-management', async () => {
    const e = await makeEmployee(a, 'M1');
    await expectSqlError(assign(a, e, e, '2026-01-05', null), CHECK_VIOLATION);
  });

  it('rejects a cycle over an overlapping period', async () => {
    const x = await makeEmployee(a, 'X');
    const y = await makeEmployee(a, 'Y');
    const z = await makeEmployee(a, 'Z');
    await assign(a, x, y, '2026-01-05', null);
    await assign(a, y, z, '2026-01-05', null);
    await expectSqlError(assign(a, z, x, '2026-03-01', null), CHECK_VIOLATION);
  });

  it('allows reversal of a reporting line when the periods do not overlap', async () => {
    const x = await makeEmployee(a, 'P');
    const y = await makeEmployee(a, 'Q');
    await assign(a, x, y, '2026-01-05', '2026-04-01');
    await expect(assign(a, y, x, '2026-04-01', null)).resolves.toBeDefined();
  });

  it('allows only one primary manager at a time', async () => {
    const e = await makeEmployee(a, 'R');
    const m1 = await makeEmployee(a, 'S');
    const m2 = await makeEmployee(a, 'T');
    await assign(a, e, m1, '2026-01-05', null);
    await expectSqlError(assign(a, e, m2, '2026-02-01', null), EXCLUSION_VIOLATION);
  });
});

describe('roles, assignments and DB109 (CI09, CI24, BR-044, C4)', () => {
  let a: CompanyFixture;
  let hrAdminRole: string;
  let readSalary: string;
  let editEmployee: string;
  let beneficiary: string;
  let requester: string;
  let approver: string;

  beforeEach(async () => {
    a = await makeCompany(uniq('A'));
    hrAdminRole = await id(
      `insert into role (company_id, code, name, active, access_class) values ($1, 'HR_ADMINISTRATOR', 'HR Administrator', true, 'ADMIN')`,
      [a.company],
    );
    readSalary = await id(
      `insert into permission (resource, action, field_group) values ($1, 'read', 'salary')`,
      [uniq('employee_')],
    );
    editEmployee = await id(
      `insert into permission (resource, action, field_group) values ($1, 'update', 'operational')`,
      [uniq('employee_')],
    );
    await db.query(`insert into role_permission (company_id, role_id, permission_id, effect) values ($1, $2, $3, 'ALLOW')`, [
      a.company,
      hrAdminRole,
      readSalary,
    ]);
    beneficiary = await makeUser(uniq('user.ben'));
    requester = await makeUser(uniq('user.req'));
    approver = await makeUser(uniq('user.app'));
  });

  const newAssignment = (state: string, approvedBy: string | null, createdBy: string, to: string | null = '2027-01-01T00:00:00Z') =>
    id(
      `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, effective_to, state, approved_by, approved_at, created_by)
       values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', $4, $5, $6::uuid, case when $6::uuid is null then null else now() end, $7)`,
      [a.company, beneficiary, hrAdminRole, to, state, approvedBy, createdBy],
    );

  it('restricts ADMIN/MANAGER classes to the eligible baseline roles', async () => {
    await expectSqlError(
      db.query(`insert into role (company_id, code, name, active, access_class) values ($1, 'PAYROLL_APPROVER', 'Payroll Approver', true, 'ADMIN')`, [
        a.company,
      ]),
      CHECK_VIOLATION,
    );
    await expectSqlError(
      db.query(`insert into role (company_id, code, name, active, access_class) values ($1, 'AUDITOR', 'Auditor', true, 'MANAGER')`, [a.company]),
      CHECK_VIOLATION,
    );
  });

  // A directly inserted ACTIVE grant is refused outright (0099; db/tests/grant-guards.test.ts). These tests hold the
  // constraints beneath that guard, so they write through the bootstrap path, which the constraints still bind.
  it('rejects an ACTIVE assignment without an approver, self-approval and requester approval, even in a bootstrap session', async () => {
    await f.asGrantBootstrap(async () => {
      await expectSqlError(newAssignment('ACTIVE', null, requester), CHECK_VIOLATION);
      await expectSqlError(newAssignment('ACTIVE', beneficiary, requester), CHECK_VIOLATION);
      await expectSqlError(newAssignment('ACTIVE', requester, requester), CHECK_VIOLATION);
      await expect(newAssignment('ACTIVE', approver, requester)).resolves.toBeTypeOf('string');
    });
  });

  const grant = (assignment: string, permission: string, active: boolean, to: string | null = '2027-01-01T00:00:00Z') =>
    db.query(
      `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from, effective_to)
       values ($1, $2, $3, $4, '2026-01-01T00:00:00Z', $5)`,
      [a.company, assignment, permission, active, to],
    );

  it('DB109: rejects a permission the parent role does not allow', async () => {
    await f.asGrantBootstrap(async () => {
      const asg = await newAssignment('ACTIVE', approver, requester);
      await expectSqlError(grant(asg, editEmployee, true), CHECK_VIOLATION);
    });
  });

  it('DB109: rejects activation before the parent assignment is approved', async () => {
    const asg = await newAssignment('PENDING', null, requester);
    await expectSqlError(grant(asg, readSalary, true), CHECK_VIOLATION);
    await expect(grant(asg, readSalary, false)).resolves.toBeDefined();
  });

  it('DB109: rejects a grant outliving a finite parent assignment', async () => {
    await f.asGrantBootstrap(async () => {
      const asg = await newAssignment('ACTIVE', approver, requester);
      await expectSqlError(grant(asg, readSalary, true, null), CHECK_VIOLATION);
      await expectSqlError(grant(asg, readSalary, true, '2027-06-01T00:00:00Z'), CHECK_VIOLATION);
    });
  });

  it('DB109: a contained, role-allowed grant is accepted only through the bootstrap path once the parent is ACTIVE', async () => {
    await f.asGrantBootstrap(async () => {
      const asg = await newAssignment('ACTIVE', approver, requester);
      await expect(grant(asg, readSalary, true)).resolves.toBeDefined();
    });
  });

  it('scope filters need exactly one matching typed reference and no duplicates', async () => {
    const asg = await newAssignment('PENDING', null, requester);
    const filter = (dimension: string, dept: string | null, loc: string | null) =>
      db.query(
        `insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id, location_id) values ($1, $2, $3, $4, $5)`,
        [a.company, asg, dimension, dept, loc],
      );
    await expectSqlError(filter('DEPARTMENT', null, a.loc), CHECK_VIOLATION);
    await expectSqlError(filter('DEPARTMENT', a.dept, a.loc), CHECK_VIOLATION);
    await filter('DEPARTMENT', a.dept, null);
    await expectSqlError(filter('DEPARTMENT', a.dept, null), UNIQUE_VIOLATION);
  });

  it('delegations: no self delegation, at most 30 days, delegate cannot approve', async () => {
    const delegate = await makeUser(uniq('user.del'));
    const delegation = (to: string, approvedBy: string, delegateUser = delegate) =>
      db.query(
        `insert into delegation (company_id, delegator_user_id, delegate_user_id, permission_id, effective_from, effective_to, approved_by)
         values ($1, $2, $3, $4, '2026-01-01T00:00:00Z', $5, $6)`,
        [a.company, beneficiary, delegateUser, readSalary, to, approvedBy],
      );
    // A directly inserted usable delegation is refused outright (0090; db/tests/delegation-guards.test.ts). This holds the
    // constraints beneath that guard, through the bootstrap path, which they still bind.
    await f.asGrantBootstrap(async () => {
      await expectSqlError(delegation('2026-01-10T00:00:00Z', approver, beneficiary), CHECK_VIOLATION);
      await expectSqlError(delegation('2026-02-15T00:00:00Z', approver), CHECK_VIOLATION);
      await expectSqlError(delegation('2026-01-10T00:00:00Z', delegate), CHECK_VIOLATION);
      await expect(delegation('2026-01-31T00:00:00Z', approver)).resolves.toBeDefined();
    });
  });
});
