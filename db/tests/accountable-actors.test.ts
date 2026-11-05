// Accountable creators on the tables with a self-approval check (migration 0146; B1 line 2800; 9.2; C4; DF10). Refusals match the
// guard's own message, then the same write succeeds with that one guard removed, so a test cannot pass because another check objected.
// Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { CHECK_VIOLATION, type CompanyFixture, fixtures } from './fixtures.js';
import { startEmptyTestDatabase, startTestDatabase, type TestDatabase } from './test-database.js';

const SYSTEM = '00000000-0000-4000-8000-000000000001';
const NOT_RECORDED = '00000000-0000-4000-8000-000000000002';
const TABLES = ['attendance_policy', 'biometric_mapping_revision', 'expense_policy', 'increment_cycle', 'leave_policy', 'payroll_calendar', 'payroll_head_revision', 'payroll_hold_criterion', 'payroll_paid_day_policy', 'role_assignment', 'tax_rule_pack'];

describe('non-person actors and required creators', () => {
  let testDb: TestDatabase;
  let db: pg.Client;
  let f: ReturnType<typeof fixtures>;
  let a: CompanyFixture;
  let e1: string;
  let user: string;
  let other: string;
  let role: string;

  const refusedBy = async (table: string, guard: string, message: RegExp, write: () => Promise<pg.QueryResult>) => {
    await expect(write()).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(message) });
    await db.query('begin');
    try {
      await db.query(`alter table ${table} disable trigger ${guard}`);
      expect((await write()).rowCount).toBe(1);
    } finally {
      await db.query('rollback');
    }
  };
  /** A check constraint: refused by name, and accepted with that constraint dropped. */
  const refusedByCheck = async (table: string, constraint: string, write: () => Promise<pg.QueryResult>) => {
    await expect(write()).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint });
    await db.query('begin');
    try {
      await db.query(`alter table ${table} drop constraint ${constraint}`);
      expect((await write()).rowCount).toBe(1);
    } finally {
      await db.query('rollback');
    }
  };

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
    f = fixtures(db);
    a = await f.makeCompany();
    e1 = await f.makeEmployee(a, 'AA1');
    user = await f.makeUser();
    other = await f.makeUser();
    role = await f.id(`insert into role (company_id, code, name, active) values ($1, 'AA_ROLE', 'AA_ROLE', true)`, [a.company]);
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  describe('they cannot sign in', () => {
    it('both are inactive and say what they are', async () => {
      const rows = (await db.query(`select id, account_key, active from user_account where id = any($1::uuid[]) order by id`, [[SYSTEM, NOT_RECORDED]])).rows;
      expect(rows).toEqual([
        { id: SYSTEM, account_key: 'hrms.system.actor', active: false },
        { id: NOT_RECORDED, account_key: 'hrms.creator.not.recorded', active: false },
      ]);
    });

    it.each([SYSTEM, NOT_RECORDED])('%s cannot be activated, renamed or removed', async (id) => {
      const fixed = /a non-person actor account does not change/;
      await refusedBy('user_account', 'user_account_non_person_fixed', fixed, () => db.query(`update user_account set active = true where id = $1`, [id]));
      await refusedBy('user_account', 'user_account_non_person_fixed', fixed, () => db.query(`update user_account set account_key = 'somebody.else' where id = $1`, [id]));
      await expect(db.query(`delete from user_account where id = $1`, [id])).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(fixed) });
    });

    it.each([SYSTEM, NOT_RECORDED])('%s cannot have a session, which every sign-in needs (DF10)', async (id) => {
      await refusedBy('user_session', 'user_session_person_only', /a non-person actor cannot hold one/, () => db.query(`insert into user_session (user_id, expires_at) values ($1, now() + interval '1 hour')`, [id]));
    });

    it('an ordinary account still can', async () => {
      await db.query('begin');
      try {
        expect((await db.query(`insert into user_session (user_id, expires_at) values ($1, now() + interval '1 hour')`, [user])).rowCount).toBe(1);
      } finally {
        await db.query('rollback');
      }
    });
  });

  describe('they cannot hold access', () => {
    const grant = (id: string) =>
      db.query(`insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, purpose, created_by) values ($1, $2, $3, 'COMPANY', '2026-01-01T00:00:00Z', 'PENDING', 'Synthetic', $4)`, [a.company, id, role, other]);

    it.each([SYSTEM, NOT_RECORDED])('%s cannot be given an assignment', async (id) => {
      await refusedBy('role_assignment', 'role_assignment_person_only', /a non-person actor cannot hold one/, () => grant(id));
    });

    it.each([SYSTEM, NOT_RECORDED])('%s cannot be linked to an employee', async (id) => {
      await refusedBy('user_employee_link', 'user_employee_link_person_only', /a non-person actor cannot hold one/, () => db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [a.company, id, e1]));
    });

    it('holds none, in any company', async () => {
      expect((await db.query(`select 1 from role_assignment where user_id = any($1::uuid[])`, [[SYSTEM, NOT_RECORDED]])).rowCount).toBe(0);
    });

    it('a person can still be proposed', async () => {
      await db.query('begin');
      try {
        expect((await grant(user)).rowCount).toBe(1);
      } finally {
        await db.query('rollback');
      }
    });
  });

  describe('a creator is required and the escape is gone', () => {
    it.each(TABLES)('%s requires a creator, and its self-approval check no longer lets a null through', async (t) => {
      expect((await f.one<{ is_nullable: string }>(`select is_nullable from information_schema.columns where table_schema = current_schema() and table_name = $1 and column_name = 'created_by'`, [t])).is_nullable).toBe('NO');
      const defs = (await db.query<{ def: string }>(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = to_regclass($1) and contype = 'c'`, [t])).rows.map((r) => r.def);
      expect(defs.filter((d) => d.includes('created_by IS NULL'))).toEqual([]);
      expect(defs.filter((d) => /(approved_by|activated_by) <> created_by/.test(d) && d.includes('hrms_is_non_person_actor'))).toHaveLength(1);
    });

    it.each(TABLES)('every trigger of %s is enabled again after the backfill', async (t) => {
      const off = (await db.query<{ tgname: string }>(`select tgname from pg_trigger where tgrelid = to_regclass($1) and not tgisinternal and tgenabled <> 'O'`, [t])).rows;
      expect(off).toEqual([]);
    });

    const policy = (createdBy: string, activatedBy: string) =>
      db.query(`insert into expense_policy (company_id, code, revision, currency_code, submission_window_days, high_value_threshold, effective_from, state, created_by, activated_by, activated_at) values ($1, $2, 1, 'INR', 30, 100, '2026-01-01', 'RETIRED', $3, $4, now())`, [
        a.company,
        `AA_${randomUUID().slice(0, 8).toUpperCase()}`,
        createdBy,
        activatedBy,
      ]);

    it('refuses the creator activating their own row', async () => {
      await refusedByCheck('expense_policy', 'expense_policy_independent_actor', () => policy(user, user));
    });

    it.each([SYSTEM, NOT_RECORDED])('refuses %s as the activator', async (id) => {
      await refusedByCheck('expense_policy', 'expense_policy_independent_actor', () => policy(user, id));
    });

    it('accepts a real, independent activator', async () => {
      await db.query('begin');
      try {
        expect((await policy(user, other)).rowCount).toBe(1);
      } finally {
        await db.query('rollback');
      }
    });
  });
});

// Upgrade: a stored row with no creator never stops the migration, keeps every other value, and the log says how many.
describe('0146 on a database that already holds rows with no creator', () => {
  let old: TestDatabase;
  let db: pg.Client;
  const warnings: string[] = [];
  const company = randomUUID();
  const grantId = randomUUID();
  const policyId = randomUUID();
  const withCreator = randomUUID();
  const creator = randomUUID();
  let before: { version: number; updated_at: Date; bootstrapped: boolean };

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    db.on('notice', (n) => {
      if (n.severity === 'WARNING') warnings.push(n.message ?? '');
    });
    await migrate(db, { before: '0146' });
    await db.query('set session_replication_role = replica');
    await db.query(`insert into role_assignment (id, company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, bootstrapped, version) values ($1, $2, $3, $4, 'COMPANY', '2026-01-01T00:00:00Z', 'ACTIVE', $5, now(), true, 7)`, [
      grantId,
      company,
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ]);
    for (const [id, by, code] of [
      [policyId, null, 'AA_OLD'],
      [withCreator, creator, 'AA_KEPT'],
    ] as const) {
      await db.query(`insert into expense_policy (id, company_id, code, revision, currency_code, submission_window_days, high_value_threshold, effective_from, state, created_by) values ($1, $2, $3, 1, 'INR', 30, 100, '2026-01-01', 'DRAFT', $4)`, [id, company, code, by]);
    }
    before = (await db.query(`select version, updated_at, bootstrapped from role_assignment where id = $1`, [grantId])).rows[0];
    await db.query('set session_replication_role = origin');
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  it('names the not-recorded actor, not the system, and only where none was recorded', async () => {
    expect((await db.query(`select created_by from role_assignment where id = $1`, [grantId])).rows[0].created_by).toBe(NOT_RECORDED);
    expect((await db.query(`select created_by from expense_policy where id = $1`, [policyId])).rows[0].created_by).toBe(NOT_RECORDED);
    expect((await db.query(`select created_by from expense_policy where id = $1`, [withCreator])).rows[0].created_by).toBe(creator);
  });

  it('leaves everything else of the row as it was, the grant’s bootstrapped marker included', async () => {
    expect((await db.query(`select version, updated_at, bootstrapped from role_assignment where id = $1`, [grantId])).rows[0]).toEqual(before);
  });

  it('says in the upgrade log how many rows per table', async () => {
    expect(warnings).toEqual(expect.arrayContaining([expect.stringMatching(/1 stored rows of role_assignment had no recorded creator/), expect.stringMatching(/1 stored rows of expense_policy had no recorded creator/)]));
    expect(warnings.some((w) => w.includes('stored rows of leave_policy'))).toBe(false);
  });

  it('enables every trigger again', async () => {
    for (const t of TABLES) {
      expect((await db.query(`select tgname from pg_trigger where tgrelid = to_regclass($1) and not tgisinternal and tgenabled <> 'O'`, [t])).rows).toEqual([]);
    }
  });

  it('the stored grant can still be revoked', async () => {
    await db.query('begin');
    try {
      expect((await db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [grantId])).rowCount).toBe(1);
    } finally {
      await db.query('rollback');
    }
  });
});
