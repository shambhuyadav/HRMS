// Direct writes cannot create or widen an approved grant (migrations 0098, 0099; CI09; CI24; DB016; DB017; DB109; C2; C4).
// This client is not a bootstrap session unless a test says so, so every statement here goes through the guards the way
// plain SQL over the application's connection would. Refusals are matched on the guard's own message, so a test cannot
// pass because some other constraint happened to object. Synthetic data only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { C2_RECORD_SCOPES } from '../../apps/api/src/modules/access/baseline.js';
import { CHECK_VIOLATION, type CompanyFixture, expectSqlError, fixtures, uniq } from './fixtures.js';
import { startTestDatabase, type TestDatabase } from './test-database.js';

let testDb: TestDatabase;
let db: pg.Client;
let f: ReturnType<typeof fixtures>;
let a: CompanyFixture;
let hrRole: string;
let readSalary: string;
let readOther: string;
let approveGrant: string;
let beneficiary: string;
let requester: string;
let approver: string;

const FROZEN = /keeps its user, role, scope, start and purpose/;
const FIXED_APPROVAL = /approved_by and approved_at are fixed once set/;
const FILTER_FIXED = /scope filters are fixed once the grant leaves PENDING/;
const ALLOWLIST_FIXED = /the allowlist is fixed once the grant leaves PENDING/;
const ACTIVATION = /activated only by the approval of its grant/;
const OUT_OF_MATRIX = /cannot hold \w+ scope/;
const NOT_DELETED = /rows cannot be deleted/;
const NOT_TRUNCATED = /cannot be truncated/;

const pending = (overrides: { to?: string | null; role?: string; scope?: string } = {}) =>
  f.id(
    `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, effective_to, state, purpose, created_by)
     values ($1, $2, $3, $4, '2026-01-01T00:00:00Z', $5, 'PENDING', 'Synthetic purpose', $6)`,
    [a.company, beneficiary, overrides.role ?? hrRole, overrides.scope ?? 'COMPANY', overrides.to === undefined ? '2027-01-01T00:00:00Z' : overrides.to, requester],
  );
const directActive = () =>
  f.id(
    `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, created_by)
     values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'ACTIVE', $4, now(), $5)`,
    [a.company, beneficiary, hrRole, approver, requester],
  );
const allowlist = (assignment: string, permission: string, active = false, to: string | null = '2027-01-01T00:00:00Z') =>
  db.query(`insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from, effective_to) values ($1, $2, $3, $4, '2026-01-01T00:00:00Z', $5)`, [
    a.company,
    assignment,
    permission,
    active,
    to,
  ]);
const filter = (assignment: string) =>
  db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`, [a.company, assignment, a.dept]);
/** The approving transaction, as access/admin.ts writes it: the parent first, then its allowlist. */
async function approve(assignment: string, by = approver) {
  await db.query('begin');
  try {
    await db.query(`update role_assignment set state = 'ACTIVE', approved_by = $2, approved_at = now(), updated_by = $2 where id = $1`, [assignment, by]);
    await db.query(`update role_assignment_permission set active = true where role_assignment_id = $1`, [assignment]);
    await db.query('commit');
  } catch (err) {
    await db.query('rollback');
    throw err;
  }
}
const approved = async () => {
  const id = await pending();
  await allowlist(id, readSalary);
  await approve(id);
  return id;
};

beforeAll(async () => {
  testDb = await startTestDatabase();
  db = testDb.client;
  f = fixtures(db);
});

afterAll(async () => {
  await testDb?.stop();
});

beforeEach(async () => {
  a = await f.makeCompany();
  hrRole = await f.id(`insert into role (company_id, code, name, active, access_class) values ($1, 'HR_ADMINISTRATOR', 'HR Administrator', true, 'ADMIN')`, [a.company]);
  readSalary = await f.id(`insert into permission (resource, action, field_group) values ($1, 'read', 'salary')`, [uniq('res_')]);
  readOther = await f.id(`insert into permission (resource, action, field_group) values ($1, 'read', 'salary')`, [uniq('res_')]);
  approveGrant = (await f.one<{ id: string }>(`select id from permission where resource = 'access' and action = 'approve_role_grant' and field_group = 'operational'`)).id;
  for (const p of [readSalary, readOther, approveGrant]) {
    await db.query(`insert into role_permission (company_id, role_id, permission_id, effect) values ($1, $2, $3, 'ALLOW')`, [a.company, hrRole, p]);
  }
  beneficiary = await f.makeUser();
  requester = await f.makeUser();
  approver = await f.makeUser();
  // The approver actually holds the approval duty, in company scope.
  await f.asGrantBootstrap(async () => {
    const seat = await f.id(
      `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, created_by) values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'ACTIVE', $4, now(), $5)`,
      [a.company, approver, hrRole, await f.makeUser(), requester],
    );
    await db.query(`insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from) values ($1, $2, $3, true, '2026-01-01T00:00:00Z')`, [a.company, seat, approveGrant]);
  });
});

describe('role_assignment: creation (CI09)', () => {
  it('a direct insert as ACTIVE or REVOKED is refused, even naming a real approver', async () => {
    await expect(directActive()).rejects.toThrow(/starts PENDING/);
    await expect(
      db.query(`insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, decision_reason, created_by) values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'REVOKED', 'Synthetic', $4)`, [
        a.company,
        beneficiary,
        hrRole,
        requester,
      ]),
    ).rejects.toThrow(/starts PENDING/);
  });

  it('a proposal names its requester and no approver', async () => {
    await expect(pending()).resolves.toBeTypeOf('string');
    await expect(
      db.query(`insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state) values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'PENDING')`, [a.company, beneficiary, hrRole]),
    ).rejects.toThrow(/names its requester/);
    await expect(
      db.query(
        `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, created_by) values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'PENDING', $4, now(), $5)`,
        [a.company, beneficiary, hrRole, approver, requester],
      ),
    ).rejects.toThrow(/has no approver/);
  });

  it('the bootstrap path works only when a session opts in, and marks the row for good', async () => {
    const id = await f.asGrantBootstrap(directActive);
    expect((await f.one<{ bootstrapped: boolean }>(`select bootstrapped from role_assignment where id = $1`, [id])).bootstrapped).toBe(true);
    await expect(directActive()).rejects.toThrow(/starts PENDING/);
    await expect(db.query(`update role_assignment set bootstrapped = false where id = $1`, [id])).rejects.toThrow(/bootstrap marker/);
    // A proposal that went the ordinary way is not marked, and its approval does not mark it.
    const ordinary = await approved();
    expect((await f.one<{ bootstrapped: boolean }>(`select bootstrapped from role_assignment where id = $1`, [ordinary])).bootstrapped).toBe(false);
  });

  it('a transaction-local opt-in ends with the transaction', async () => {
    await db.query('begin');
    await db.query(`select set_config('hrms.grant_bootstrap', 'on', true)`);
    await db.query('commit');
    await expect(directActive()).rejects.toThrow(/starts PENDING/);
  });
});

describe('role_assignment: transitions and approval (C4 own privilege grant)', () => {
  it('moves only PENDING -> ACTIVE, PENDING -> REVOKED and ACTIVE -> REVOKED', async () => {
    const active = await approved();
    const illegal = /is not allowed/;
    await expect(db.query(`update role_assignment set state = 'PENDING' where id = $1`, [active])).rejects.toThrow(illegal);
    await db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [active]);
    await expect(db.query(`update role_assignment set state = 'ACTIVE' where id = $1`, [active])).rejects.toThrow(illegal);
    await expect(db.query(`update role_assignment set state = 'PENDING' where id = $1`, [active])).rejects.toThrow(illegal);
    await expect(db.query(`update role_assignment set decision_reason = 'Rewritten' where id = $1`, [active])).rejects.toThrow(/reason of an ended role assignment/);

    const rejected = await pending();
    await db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [rejected]);
    await expect(db.query(`update role_assignment set state = 'ACTIVE', approved_by = $2, approved_at = now() where id = $1`, [rejected, approver])).rejects.toThrow(illegal);
  });

  it('approval needs an approver who holds the duty, stamped with the transaction time', async () => {
    const id = await pending();
    const noDuty = /does not hold the role-grant approval duty/;
    // Beneficiary and requester stay refused too (they hold no duty here; the CHECKs of 0001 back that up).
    await expect(approve(id, beneficiary)).rejects.toThrow(noDuty);
    await expect(approve(id, requester)).rejects.toThrow(noDuty);
    // Any other user is not "the actual independent authorised actor".
    await expect(approve(id, await f.makeUser())).rejects.toThrow(noDuty);
    // Back-dating the approval.
    await expect(db.query(`update role_assignment set state = 'ACTIVE', approved_by = $2, approved_at = now() - interval '1 day' where id = $1`, [id, approver])).rejects.toThrow(/stamped with the time/);
    await approve(id);
    expect(await f.one<{ state: string; approved_by: string }>(`select state, approved_by from role_assignment where id = $1`, [id])).toEqual({ state: 'ACTIVE', approved_by: approver });
  });

  it('an approver whose own duty was switched off cannot approve', async () => {
    const id = await pending();
    await db.query(`update role_assignment_permission set active = false where permission_id = $1 and role_assignment_id in (select id from role_assignment where user_id = $2)`, [approveGrant, approver]);
    await expect(approve(id)).rejects.toThrow(/does not hold the role-grant approval duty/);
  });

  it('approved_by, approved_at, user, role, scope, start and purpose are fixed once the row leaves PENDING', async () => {
    const active = await approved();
    const otherRole = await f.id(`insert into role (company_id, code, name, active) values ($1, $2, $2, true)`, [a.company, uniq('ROLE_')]);
    await expect(db.query(`update role_assignment set approved_by = $2 where id = $1`, [active, await f.makeUser()])).rejects.toThrow(FIXED_APPROVAL);
    await expect(db.query(`update role_assignment set approved_at = now() - interval '1 day' where id = $1`, [active])).rejects.toThrow(FIXED_APPROVAL);
    await expect(db.query(`update role_assignment set user_id = $2 where id = $1`, [active, requester])).rejects.toThrow(FROZEN);
    await expect(db.query(`update role_assignment set role_id = $2 where id = $1`, [active, otherRole])).rejects.toThrow(FROZEN);
    await expect(db.query(`update role_assignment set effective_from = '2025-01-01T00:00:00Z' where id = $1`, [active])).rejects.toThrow(FROZEN);
    await expect(db.query(`update role_assignment set purpose = 'Rewritten' where id = $1`, [active])).rejects.toThrow(FROZEN);
    // A scope change on a role C2 does not name is refused by the freeze alone.
    const custom = await f.asGrantBootstrap(() =>
      f.id(`insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, created_by) values ($1, $2, $3, 'TEAM', '2026-01-01T00:00:00Z', 'ACTIVE', $4, now(), $5)`, [
        a.company,
        beneficiary,
        otherRole,
        approver,
        requester,
      ]),
    );
    await expect(db.query(`update role_assignment set scope_kind = 'COMPANY' where id = $1`, [custom])).rejects.toThrow(FROZEN);
  });

  it('effective_to may only come earlier, never later or open', async () => {
    const active = await approved();
    const later = /may only come earlier/;
    await expect(db.query(`update role_assignment set effective_to = '2028-01-01T00:00:00Z' where id = $1`, [active])).rejects.toThrow(later);
    await expect(db.query(`update role_assignment set effective_to = null where id = $1`, [active])).rejects.toThrow(later);
    await expect(db.query(`update role_assignment set effective_to = '2026-06-01T00:00:00Z' where id = $1`, [active])).resolves.toBeDefined();
  });

  it('a pending row cannot quietly gain an approver', async () => {
    const id = await pending();
    await expect(db.query(`update role_assignment set approved_by = $2, approved_at = now() where id = $1`, [id, approver])).rejects.toThrow(/has no approver/);
  });
});

describe('role_scope_filter (DB017)', () => {
  it('fixed once the parent leaves PENDING; a delete would widen the scope, so never', async () => {
    const id = await pending();
    await filter(id);
    await allowlist(id, readSalary);
    await approve(id);
    await expect(filter(id)).rejects.toThrow(FILTER_FIXED);
    await expect(db.query(`update role_scope_filter set updated_by = created_by where role_assignment_id = $1`, [id])).rejects.toThrow(FILTER_FIXED);
    await expect(db.query(`delete from role_scope_filter where role_assignment_id = $1`, [id])).rejects.toThrow(NOT_DELETED);
    await expect(db.query(`truncate role_scope_filter`)).rejects.toThrow(NOT_TRUNCATED);
    expect((await f.one<{ n: number }>(`select count(*)::int as n from role_scope_filter where role_assignment_id = $1`, [id])).n).toBe(1);
  });

  it('cannot change under a rejected proposal, nor be deleted from a pending one', async () => {
    const id = await pending();
    await filter(id);
    await expect(db.query(`delete from role_scope_filter where role_assignment_id = $1`, [id])).rejects.toThrow(NOT_DELETED);
    await db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic' where id = $1`, [id]);
    await expect(db.query(`update role_scope_filter set updated_by = created_by where role_assignment_id = $1`, [id])).rejects.toThrow(FILTER_FIXED);
  });
});

describe('role_assignment_permission (DB109)', () => {
  it('no new entry once the parent leaves PENDING, active or not', async () => {
    const active = await approved();
    await expect(allowlist(active, readOther, true)).rejects.toThrow(ALLOWLIST_FIXED);
    await expect(allowlist(active, readOther, false)).rejects.toThrow(ALLOWLIST_FIXED);
  });

  it('activates only in the approving transaction; a later transaction cannot switch an entry back on', async () => {
    const active = await approved();
    await db.query(`update role_assignment_permission set active = false where role_assignment_id = $1`, [active]);
    await expect(db.query(`update role_assignment_permission set active = true where role_assignment_id = $1`, [active])).rejects.toThrow(ACTIVATION);
    expect((await f.one<{ active: boolean }>(`select active from role_assignment_permission where role_assignment_id = $1`, [active])).active).toBe(false);
  });

  it('after approval only deactivation or an earlier end', async () => {
    const active = await approved();
    await expect(db.query(`update role_assignment_permission set effective_to = '2028-01-01T00:00:00Z' where role_assignment_id = $1`, [active])).rejects.toThrow(/entry may only come earlier/);
    await expect(db.query(`update role_assignment_permission set effective_to = null where role_assignment_id = $1`, [active])).rejects.toThrow(/entry may only come earlier/);
    await expect(db.query(`update role_assignment_permission set effective_from = '2026-02-01T00:00:00Z' where role_assignment_id = $1`, [active])).rejects.toThrow(/keeps its assignment, permission and start/);
    await expect(db.query(`update role_assignment_permission set permission_id = $2 where role_assignment_id = $1`, [active, readOther])).rejects.toThrow(/keeps its assignment, permission and start/);
    await expect(db.query(`update role_assignment_permission set effective_to = '2026-06-01T00:00:00Z' where role_assignment_id = $1`, [active])).resolves.toBeDefined();
    await expect(db.query(`update role_assignment_permission set active = false where role_assignment_id = $1`, [active])).resolves.toBeDefined();
  });

  it('the allowlist cannot be truncated', async () => {
    await expect(db.query(`truncate role_assignment_permission`)).rejects.toThrow(NOT_TRUNCATED);
  });
});

describe('C2 record scope (0098)', () => {
  const roleWith = async (code: string) => f.id(`insert into role (company_id, code, name, active) values ($1, $2, $2, true)`, [a.company, code]);

  it('the database and the application hold the same matrix, for every role and scope kind', async () => {
    for (const [role, allowed] of Object.entries(C2_RECORD_SCOPES)) {
      const row = await f.one<{ scopes: string[] | null }>(`select hrms_role_record_scopes($1) as scopes`, [role]);
      expect([...(row.scopes ?? [])].sort(), role).toEqual([...allowed].sort());
    }
    expect((await f.one<{ scopes: string[] | null }>(`select hrms_role_record_scopes('CUSTOM_ROLE') as scopes`)).scopes).toBeNull();
  });

  it('refuses a scope outside the role’s entry, on insert and on update, with or without bootstrap', async () => {
    const manager = await roleWith('REPORTING_MANAGER');
    await expect(pending({ role: manager, scope: 'COMPANY' })).rejects.toThrow(OUT_OF_MATRIX);
    await expect(pending({ role: hrRole, scope: 'ASSIGNED' })).rejects.toThrow(OUT_OF_MATRIX);
    const team = await pending({ role: manager, scope: 'TEAM' });
    await expect(db.query(`update role_assignment set scope_kind = 'COMPANY' where id = $1`, [team])).rejects.toThrow(OUT_OF_MATRIX);
    await expect(pending({ role: manager, scope: 'ASSIGNED' })).resolves.toBeTypeOf('string');
    await f.asGrantBootstrap(async () => {
      await expect(pending({ role: manager, scope: 'COMPANY' })).rejects.toThrow(OUT_OF_MATRIX);
      await expect(db.query(`update role_assignment set scope_kind = 'OWN' where id = $1`, [team])).rejects.toThrow(OUT_OF_MATRIX);
    });
  });

  it('a role C2 does not name stays unrestricted', async () => {
    const custom = await roleWith(uniq('CUSTOM_'));
    for (const scope of ['OWN', 'TEAM', 'ASSIGNED', 'COMPANY']) await expect(pending({ role: custom, scope })).resolves.toBeTypeOf('string');
  });

  it('a row written before the matrix can be revoked but not approved', async () => {
    const manager = await roleWith('REPORTING_MANAGER');
    await db.query(`alter table role_assignment disable trigger role_assignment_record_scope`);
    let legacyPending: string;
    let legacyActive: string;
    try {
      legacyPending = await pending({ role: manager, scope: 'COMPANY' });
      legacyActive = await pending({ role: manager, scope: 'COMPANY' });
      await approve(legacyActive);
    } finally {
      await db.query(`alter table role_assignment enable trigger role_assignment_record_scope`);
    }
    await expect(approve(legacyPending)).rejects.toThrow(OUT_OF_MATRIX);
    await expect(db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Outside C2' where id = $1`, [legacyActive])).resolves.toBeDefined();
  });
});

describe('what the migrations leave alone', () => {
  it('own-record guards do not touch a write that names no actor (provisioning, seed, fixtures)', async () => {
    const e = await f.makeEmployee(a, uniq('E'));
    const u = await f.makeUser();
    await f.linkUser(a, u, e);
    await expectSqlError(
      db.query(`insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code, created_by) values ($1, $2, '2026-01-05', 1, 1, 'INR', $3)`, [a.company, e, u]),
      CHECK_VIOLATION,
    );
    await expect(db.query(`insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code) values ($1, $2, '2026-01-05', 1, 1, 'INR')`, [a.company, e])).resolves.toBeDefined();
  });
});

describe('the bootstrap setting stays out of serving code', () => {
  it('only the helper, the development seed, the production first-run bootstrap and test support mention it', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../../apps/api/src');
    const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : [join(dir, name)]));
    const sources = walk(root).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));
    const offenders = sources
      .filter((file) => /hrms\.grant_bootstrap|withGrantBootstrap/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).replace(/\\/g, '/'))
      .sort();
    expect(offenders).toEqual(['admin/bootstrap.ts', 'dev/seed.ts', 'modules/access/provision.ts', 'test/harness.ts']);
    // The first-run bootstrap is a command-line step (db/bootstrap-production.ts): nothing the server runs imports it.
    const importers = sources.filter((file) => /from '\.{1,2}\/(\.\.\/)*admin\/bootstrap\.js'/.test(readFileSync(file, 'utf8')));
    expect(importers.map((file) => relative(root, file))).toEqual([]);
  });
});
