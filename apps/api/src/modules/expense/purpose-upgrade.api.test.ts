// Applying 0117 to a database that already holds claims (line 103; BR-017): the current revision takes the claim's purpose, an
// earlier revision's overwritten text stays unknown rather than guessed, and frozen rows are otherwise untouched. An upgrade
// test builds the schema 0117 starts from and fills it with synthetic rows, triggers off, as the earlier service left them.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../../../../db/migrate.js';
import { startEmptyTestDatabase, type TestDatabase } from '../../../../../db/tests/test-database.js';

let old: TestDatabase;
let db: pg.Client;

const company = randomUUID();
const claim = randomUUID();
const single = randomUUID();
const submittedAt = '2026-06-01T10:00:00Z';

const revision = async (claimId: string, n: number, submitted: boolean) => {
  await db.query(
    `insert into expense_revision (company_id, claim_id, revision, policy_id, currency_code, submitted_at, submitted_by, version, updated_at)
     values ($1, $2, $3, $4, 'INR', $5, $6, 3, '2026-06-02T00:00:00Z')`,
    [company, claimId, n, randomUUID(), submitted ? submittedAt : null, submitted ? randomUUID() : null],
  );
};

beforeAll(async () => {
  const empty = await startEmptyTestDatabase();
  if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
  old = empty;
  db = old.client;
  await migrate(db, { before: '0117' });
  await db.query(`set session_replication_role = replica`);
  for (const [id, purpose, current] of [
    [claim, 'The corrected purpose (synthetic)', 2],
    [single, 'The only purpose (synthetic)', 1],
  ] as const) {
    await db.query(`insert into expense_claim (id, company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, $4, $5, 'INR', $6, 'MANAGER_PENDING', 'NOT_APPLICABLE')`, [
      id,
      company,
      randomUUID(),
      randomUUID(),
      purpose,
      current,
    ]);
  }
  await revision(claim, 1, true);
  await revision(claim, 2, true);
  await revision(single, 1, true);
  await db.query(`set session_replication_role = origin`);
  await migrate(db);
}, 180_000);

afterAll(async () => {
  await old?.stop();
});

const purposeOf = async (claimId: string, n: number) => (await db.query<{ purpose: string | null; version: number; updated_at: Date }>(`select purpose, version, updated_at from expense_revision where claim_id = $1 and revision = $2`, [claimId, n])).rows[0]!;

describe('0117 on existing claims', () => {
  it('gives the current revision the claim\'s purpose', async () => {
    expect((await purposeOf(claim, 2)).purpose).toBe('The corrected purpose (synthetic)');
    expect((await purposeOf(single, 1)).purpose).toBe('The only purpose (synthetic)');
  });

  it('leaves an earlier revision\'s purpose unknown: its text was overwritten, and the corrected one is not what was reviewed', async () => {
    expect((await purposeOf(claim, 1)).purpose).toBeNull();
  });

  it('leaves the frozen rows otherwise as they were', async () => {
    const row = await purposeOf(claim, 2);
    expect(row.version).toBe(3);
    expect(row.updated_at.toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  it('turned the freeze and the touch triggers back on', async () => {
    const triggers = (await db.query<{ tgname: string; tgenabled: string }>(`select tgname, tgenabled from pg_trigger where tgrelid = 'expense_revision'::regclass and tgname in ('expense_revision_frozen', 'expense_revision_touch')`)).rows;
    expect(triggers).toHaveLength(2);
    expect(triggers.every((t) => t.tgenabled === 'O')).toBe(true);
    await expect(db.query(`update expense_revision set purpose = 'Rewritten' where claim_id = $1 and revision = 2`, [claim])).rejects.toThrow('a submitted expense revision is immutable');
  });
});
