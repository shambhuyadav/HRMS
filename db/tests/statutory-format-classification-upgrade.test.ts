// Upgrade behaviour of 0300 (batch R4 statutory files): a company that existed before it gets its new operational group
// payroll_statutory_format classified OPERATIONAL, dated and approved like the company's employee operational classification (an
// unclassified group reads as CONFIDENTIAL, the bug 0291 had to fix for three earlier resources); a row already there is left as it is,
// the role ceilings are added, and nothing statutory is activated. Synthetic data only.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { startEmptyTestDatabase, type TestDatabase } from './test-database.js';

// While 0300 is still a draft it is applied only in runs that list it (db/migrate.ts).
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const applies =
  existsSync(join(MIGRATIONS, '0300_statutory_file_formats.sql')) ||
  (process.env.HRMS_DRAFT_MIGRATIONS ?? '').split(',').map((s) => s.trim()).includes('0300_statutory_file_formats.draft.sql');

describe.runIf(applies)('0300 on a company provisioned before the statutory file formats', () => {
  let old: TestDatabase;
  let db: pg.Client;
  let company: string;
  let other: string;
  let approver: string;

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0300' });
    approver = (await db.query<{ id: string }>(`insert into user_account (account_key, active) values ('up.r4.classifier', true) returning id`)).rows[0]!.id;
    const companyWith = async (code: string) => {
      const id = (await db.query<{ id: string }>(`insert into company (code, name, active) values ($1, 'Synthetic', true) returning id`, [code])).rows[0]!.id;
      await db.query(
        `insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
         values ($1, 'employee', 'operational', 'OPERATIONAL', '2026-01-01', $2, now(), $2)`,
        [id, approver],
      );
      for (const role of ['HR_ADMINISTRATOR', 'PAYROLL_OPERATOR', 'PAYROLL_APPROVER']) {
        await db.query(`insert into role (company_id, code, name, active) values ($1, $2, $2, true)`, [id, role]);
      }
      return id;
    };
    company = await companyWith('UP_R4');
    other = await companyWith('UP_R4B');
    // Another company already classified it (say, by hand): that row stays as it is.
    await db.query(
      `insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
       values ($1, 'payroll_statutory_format', 'operational', 'CONFIDENTIAL', '2026-03-01', $2, now(), $2)`,
      [other, approver],
    );
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  const classes = async (c: string) =>
    (
      await db.query<{ classification: string; effective_from: string }>(
        `select classification, to_char(effective_from, 'YYYY-MM-DD') as effective_from from confidential_field_policy
          where company_id = $1 and resource_code = 'payroll_statutory_format' and field_group = 'operational'`,
        [c],
      )
    ).rows;

  it('classifies the operational group as OPERATIONAL from the company’s own employee classification date, and leaves an existing row', async () => {
    expect(await classes(company)).toEqual([{ classification: 'OPERATIONAL', effective_from: '2026-01-01' }]);
    expect(await classes(other)).toEqual([{ classification: 'CONFIDENTIAL', effective_from: '2026-03-01' }]);
  });

  it('adds the maker-checker ceilings (define: HR Administrator and Payroll Operator; accept: HR Administrator and Payroll Approver)', async () => {
    const rows = await db.query<{ role: string; key: string }>(
      `select r.code as role, p.action as key from role_permission rp join role r on r.id = rp.role_id join permission p on p.id = rp.permission_id
        where rp.company_id = $1 and p.resource = 'payroll_statutory_format' order by 1, 2`,
      [company],
    );
    expect(rows.rows.map((r) => `${r.role} ${r.key}`)).toEqual(['HR_ADMINISTRATOR accept', 'HR_ADMINISTRATOR define', 'PAYROLL_APPROVER accept', 'PAYROLL_OPERATOR define']);
  });

  it('accepts no format and activates no statutory pack', async () => {
    expect((await db.query(`select 1 from statutory_file_format`)).rowCount).toBe(0);
    expect((await db.query(`select 1 from statutory_file_format_decision`)).rowCount).toBe(0);
    expect((await db.query(`select 1 from statutory_rule_pack where state = 'ACTIVE'`)).rowCount).toBe(0);
  });
});
