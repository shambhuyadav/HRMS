// Upgrade behaviour of 0291: a company that existed before 0261, 0262 and 0290 (as the live company did) had no classification for their
// operational groups, so they read as confidential; after the upgrade each is OPERATIONAL, dated and approved like the company's
// employee operational classification, and a row already there is left as it is. Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { startEmptyTestDatabase, type TestDatabase } from './test-database.js';

describe('0291 on a company provisioned before the three resources', () => {
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
    await migrate(db, { before: '0261' });
    approver = (await db.query<{ id: string }>(`insert into user_account (account_key, active) values ('up.classifier', true) returning id`)).rows[0]!.id;
    const companyWith = async (code: string) => {
      const id = (await db.query<{ id: string }>(`insert into company (code, name, active) values ($1, 'Synthetic', true) returning id`, [code])).rows[0]!.id;
      await db.query(
        `insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
         values ($1, 'employee', 'operational', 'OPERATIONAL', '2026-01-01', $2, now(), $2)`,
        [id, approver],
      );
      return id;
    };
    company = await companyWith('UP_CLASS');
    other = await companyWith('UP_CLASS2');
    // Another company already classified one of them (say, by hand): that row stays as it is.
    await db.query(
      `insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
       values ($1, 'announcement', 'operational', 'CONFIDENTIAL', '2026-03-01', $2, now(), $2)`,
      [other, approver],
    );
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  const classes = async (c: string) =>
    (
      await db.query<{ resource_code: string; classification: string; effective_from: string }>(
        `select resource_code, classification, to_char(effective_from, 'YYYY-MM-DD') as effective_from from confidential_field_policy
          where company_id = $1 and field_group = 'operational' and resource_code in ('document_requirement', 'appraisal_distribution', 'announcement')
          order by resource_code`,
        [c],
      )
    ).rows;

  it('classifies the three operational groups as OPERATIONAL from the company’s own employee classification date', async () => {
    expect(await classes(company)).toEqual([
      { resource_code: 'announcement', classification: 'OPERATIONAL', effective_from: '2026-01-01' },
      { resource_code: 'appraisal_distribution', classification: 'OPERATIONAL', effective_from: '2026-01-01' },
      { resource_code: 'document_requirement', classification: 'OPERATIONAL', effective_from: '2026-01-01' },
    ]);
  });

  it('leaves a row that was already there as it was', async () => {
    expect(await classes(other)).toEqual([
      { resource_code: 'announcement', classification: 'CONFIDENTIAL', effective_from: '2026-03-01' },
      { resource_code: 'appraisal_distribution', classification: 'OPERATIONAL', effective_from: '2026-01-01' },
      { resource_code: 'document_requirement', classification: 'OPERATIONAL', effective_from: '2026-01-01' },
    ]);
  });
});
