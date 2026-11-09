// Upgrade behaviour of 0155: a database already holding a tie from before the no-overlap guards migrates without stopping and without any
// stored policy row changing; afterwards one side can be ended earlier, and nothing else about its period can move. Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { CHECK_VIOLATION, expectSqlError } from './fixtures.js';
import { startEmptyTestDatabase, type TestDatabase } from './test-database.js';

describe('0155 on a database that already holds a tie', () => {
  let old: TestDatabase;
  let db: pg.Client;
  let first: string;
  let second: string;
  let before: unknown[];
  const rows = async () => (await db.query(`select * from leave_policy order by id`)).rows;
  /** The stored values of the columns that existed before the upgrade: a later migration's new column (0183) is not a change. */
  const asBefore = (now: Record<string, unknown>[]) => now.map((r, i) => Object.fromEntries(Object.keys((before[i] as Record<string, unknown> | undefined) ?? {}).map((k) => [k, r[k]])));

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0155' });
    await db.query('set session_replication_role = replica');
    const company = (await db.query<{ id: string }>(`insert into company (code, name, active) values ('UP_TIE', 'Synthetic', true) returning id`)).rows[0]!.id;
    const [author, activator] = (await db.query<{ id: string }>(`insert into user_account (account_key, active) values ('up.author', true), ('up.activator', true) returning id`)).rows.map((r) => r.id);
    const type = (await db.query<{ id: string }>(`insert into leave_type (company_id, code, name, unit, paid, active) values ($1, 'UP_TIE', 'Synthetic', 'DAY', false, true) returning id`, [company])).rows[0]!.id;
    const location = (await db.query<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, 'UP_TIE', 'Synthetic', true) returning id`, [company])).rows[0]!.id;
    const policy = async (revision: number) => {
      const id = (
        await db.query<{ id: string }>(
          `insert into leave_policy (company_id, leave_type_id, revision, effective_from, eligibility_code, accrual_rule_code, annual_entitlement, state, created_by, activated_by, activated_at)
           values ($1, $2, $3, '2026-01-01', 'ALL', 'NONE', 0, 'ACTIVE', $4, $5, now()) returning id`,
          [company, type, revision, author, activator],
        )
      ).rows[0]!.id;
      await db.query(`insert into leave_policy_mapping (company_id, policy_id, location_id) values ($1, $2, $3)`, [company, id, location]);
      return id;
    };
    first = await policy(1);
    second = await policy(2);
    await db.query('set session_replication_role = origin');
    before = await rows();
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  it('migrates, and every stored policy row is as it was', async () => {
    expect((await db.query(`select 1 from schema_migration where filename like '0155%'`)).rowCount).toBe(1);
    expect(asBefore(await rows())).toEqual(before);
    expect((await db.query(`select policy_id from hrms_leave_policy_conflicts((select company_id from leave_policy where id = $1), $1)`, [first])).rows).toEqual([expect.objectContaining({ policy_id: second })]);
  });

  it('one side can now end earlier; it cannot then be extended, reopened or moved', async () => {
    await db.query(`update leave_policy set state = 'RETIRED', effective_to = '2026-06-01' where id = $1`, [first]);
    await db.query(`update leave_policy set effective_to = '2026-05-01' where id = $1`, [first]);
    for (const set of [`effective_to = '2026-06-01'`, `state = 'ACTIVE', effective_to = null`, `effective_from = '2025-12-01'`, `effective_from = '2026-02-01'`]) {
      await expectSqlError(db.query(`update leave_policy set ${set} where id = $1`, [first]), CHECK_VIOLATION);
    }
    expect((await db.query<{ to: string }>(`select to_char(effective_to, 'YYYY-MM-DD') as to from leave_policy where id = $1`, [first])).rows[0]!.to).toBe('2026-05-01');
  });
});
