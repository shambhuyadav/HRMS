// Synthetic fixture builders for database tests. No real personal data.
import type pg from 'pg';
import { expect } from 'vitest';

export const FK_VIOLATION = '23503';
export const UNIQUE_VIOLATION = '23505';
export const CHECK_VIOLATION = '23514';
export const EXCLUSION_VIOLATION = '23P01';
export const SERIALIZATION_FAILURE = '40001';

export interface CompanyFixture {
  company: string;
  dept: string;
  loc: string;
  desig: string;
  empType: string;
  statusActive: string;
}

let seq = 0;
export const uniq = (prefix: string) => `${prefix}${++seq}`;

export async function expectSqlError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

export function fixtures(db: pg.Client) {
  async function one<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T> {
    const row = (await db.query<T>(sql, params)).rows[0];
    if (!row) throw new Error(`No row returned: ${sql}`);
    return row;
  }

  async function id(sql: string, params: unknown[] = []): Promise<string> {
    return (await one<{ id: string }>(`${sql} returning id`, params)).id;
  }

  async function makeCompany(code = uniq('C')): Promise<CompanyFixture> {
    const company = await id('insert into company (code, name, active) values ($1, $1, true)', [code]);
    const dept = await id(`insert into department (company_id, code, name, active) values ($1, 'ENG', 'Engineering', true)`, [company]);
    const loc = await id(`insert into location (company_id, code, name, active) values ($1, 'HQ', 'Head Office', true)`, [company]);
    const desig = await id(`insert into designation (company_id, code, name, active) values ($1, 'DEV', 'Developer', true)`, [company]);
    const empType = await id(
      `insert into reference_value (company_id, category, code, label, active) values ($1, 'EMPLOYMENT_TYPE', 'PERMANENT', 'Permanent', true)`,
      [company],
    );
    const statusActive = await id(
      `insert into reference_value (company_id, category, code, label, active) values ($1, 'EMPLOYEE_STATUS', 'ACTIVE_CONFIRMED', 'Active confirmed', true)`,
      [company],
    );
    return { company, dept, loc, desig, empType, statusActive };
  }

  async function makeEmployee(c: CompanyFixture, code: string): Promise<string> {
    return id(
      `insert into employee (company_id, employee_code, display_name, joining_date, employment_type_id, status_id)
       values ($1, $2, $2, '2026-01-05', $3, $4)`,
      [c.company, code, c.empType, c.statusActive],
    );
  }

  async function makeUser(key = uniq('user.')): Promise<string> {
    return id('insert into user_account (account_key, active) values ($1, true)', [key]);
  }

  async function linkUser(c: CompanyFixture, user: string, employee: string): Promise<void> {
    await db.query(
      `insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`,
      [c.company, user, employee],
    );
  }

  async function makePermission(action = 'approve', fieldGroup = 'operational'): Promise<string> {
    return id(`insert into permission (resource, action, field_group) values ($1, $2, $3)`, [uniq('res_'), action, fieldGroup]);
  }

  /** Runs fixture writes as a grant bootstrap session (migration 0099), then leaves it. */
  async function asGrantBootstrap<T>(write: () => Promise<T>): Promise<T> {
    await db.query(`select set_config('hrms.grant_bootstrap', 'on', false)`);
    try {
      return await write();
    } finally {
      await db.query(`select set_config('hrms.grant_bootstrap', 'off', false)`);
    }
  }

  /** Role + approved ACTIVE company-scope assignment for `user`, approved by a fresh independent user. */
  async function makeActiveAssignment(c: CompanyFixture, user: string, roleCode = uniq('ROLE_')): Promise<string> {
    const role = await id(`insert into role (company_id, code, name, active) values ($1, $2, $2, true)`, [c.company, roleCode]);
    const approver = await makeUser();
    return asGrantBootstrap(() =>
      id(
        `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at)
         values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'ACTIVE', $4, now())`,
        [c.company, user, role, approver],
      ),
    );
  }

  return { one, id, makeCompany, makeEmployee, makeUser, linkUser, makePermission, makeActiveAssignment, asGrantBootstrap };
}
