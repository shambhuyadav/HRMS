// The approved currency codes (migration 0145; CI15; DF06; DF07; BR-022; OQ-17). Each foreign key is a backstop behind a refusal the
// service already names, so it is exercised here by direct writes only; expense.api.test and policies.api.test prove the named refusals
// still answer. A refusal must come from this table's own constraint, and the same write then succeeds with that constraint
// removed, so a test cannot pass because another check objected. XTS is the ISO 4217 code reserved for testing. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { CHECK_VIOLATION, type CompanyFixture, FK_VIOLATION, fixtures, uniq } from './fixtures.js';
import { startEmptyTestDatabase, startTestDatabase, type TestDatabase } from './test-database.js';

const GUARDED = ['expense_obligation', 'expense_policy', 'payment_allocation', 'payment_batch', 'payment_instruction'];

describe('the approved currency codes', () => {
  let testDb: TestDatabase;
  let db: pg.Client;
  let f: ReturnType<typeof fixtures>;
  let a: CompanyFixture;
  let e1: string;
  let user: string;
  let approver: string;

  const bare = async <T>(write: () => Promise<T>) => {
    await db.query('set session_replication_role = replica');
    try {
      return await write();
    } finally {
      await db.query('set session_replication_role = origin');
    }
  };
  const row = (sql: string, params: unknown[]) => bare(() => f.id(sql, params));

  /** Parents already holding the test currency, as a stored row could: only the write under test goes through the guards. */
  const parents = async () => {
    const claim = await row(`insert into expense_claim (company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, 'Synthetic', 'XTS', 1, 'APPROVED', 'UNPAID')`, [a.company, e1, randomUUID()]);
    const revision = await row(`insert into expense_revision (company_id, claim_id, revision, policy_id, currency_code, purpose, submitted_at, submitted_by) values ($1, $2, 1, $3, 'XTS', 'Synthetic', now(), $4)`, [a.company, claim, randomUUID(), user]);
    const batch = await row(`insert into payment_batch (company_id, transaction_id, state, prepared_by, currency_code) values ($1, $2, 'DRAFT', $3, 'XTS')`, [a.company, randomUUID(), user]);
    const instruction = await row(`insert into payment_instruction (company_id, batch_id, employee_id, amount, currency_code, state, idempotency_key, payment_date) values ($1, $2, $3, 1, 'XTS', 'PREPARED', $4, '2026-01-01')`, [a.company, batch, e1, uniq('payment-key-')]);
    const obligation = await row(`insert into expense_obligation (company_id, claim_id, revision_id, employee_id, approved_amount, currency_code, approved_by) values ($1, $2, $3, $4, 1, 'XTS', $5)`, [a.company, claim, revision, e1, approver]);
    return { claim, revision, batch, instruction, obligation };
  };

  const WRITES: Record<string, () => Promise<pg.QueryResult>> = {
    expense_policy: () =>
      db.query(`insert into expense_policy (company_id, code, revision, currency_code, submission_window_days, high_value_threshold, effective_from, state, created_by) values ($1, $2, 1, 'XTS', 30, 100, '2026-01-01', 'DRAFT', $3)`, [
        a.company,
        `CR_${randomUUID().slice(0, 8).toUpperCase()}`,
        user,
      ]),
    payment_batch: () => db.query(`insert into payment_batch (company_id, transaction_id, state, prepared_by, currency_code) values ($1, $2, 'DRAFT', $3, 'XTS')`, [a.company, randomUUID(), user]),
    expense_obligation: async () => {
      // A claim of its own, since a claim has one obligation.
      const claim = await row(`insert into expense_claim (company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, 'Synthetic', 'XTS', 1, 'APPROVED', 'UNPAID')`, [a.company, e1, randomUUID()]);
      const revision = await row(`insert into expense_revision (company_id, claim_id, revision, policy_id, currency_code, purpose, submitted_at, submitted_by) values ($1, $2, 1, $3, 'XTS', 'Synthetic', now(), $4)`, [a.company, claim, randomUUID(), user]);
      return db.query(`insert into expense_obligation (company_id, claim_id, revision_id, employee_id, approved_amount, currency_code, approved_by) values ($1, $2, $3, $4, 1, 'XTS', $5)`, [a.company, claim, revision, e1, approver]);
    },
    payment_instruction: async () => {
      const p = await parents();
      return db.query(`insert into payment_instruction (company_id, batch_id, employee_id, amount, currency_code, state, idempotency_key, payment_date) values ($1, $2, $3, 1, 'XTS', 'PREPARED', $4, '2026-01-01')`, [a.company, p.batch, e1, uniq('payment-key-')]);
    },
    payment_allocation: async () => {
      const p = await parents();
      return db.query(`insert into payment_allocation (company_id, instruction_id, obligation_id, employee_id, currency_code, amount) values ($1, $2, $3, $4, 'XTS', 1)`, [a.company, p.instruction, p.obligation, e1]);
    },
  };

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
    f = fixtures(db);
    a = await f.makeCompany();
    e1 = await f.makeEmployee(a, 'CR1');
    user = await f.makeUser();
    approver = await f.makeUser();
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  // 0208 (I-80, A6; decided under owner delegation, 6 Nov 2026): the ISO codes Finance would use join INR at their ISO minor unit. Being
  // in the reference makes a code nameable, not usable: a claim needs it enabled by a second person, a payroll a calendar activated in it.
  it('holds INR and the approved ISO codes, each at two decimals (DF06; OQ-17)', async () => {
    expect((await db.query(`select code, minor_unit from currency order by code`)).rows).toEqual(
      ['AED', 'EUR', 'GBP', 'INR', 'SGD', 'USD'].map((code) => ({ code, minor_unit: 2 })),
    );
  });

  it('keeps a code’s minor unit and never loses a code', async () => {
    await expect(db.query(`update currency set minor_unit = 3 where code = 'INR'`)).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(/currency\.minor_unit is fixed once written/) });
    await expect(db.query(`delete from currency where code = 'INR'`)).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(/cannot be deleted/) });
    await db.query('begin');
    try {
      await db.query(`alter table currency disable trigger currency_fixed`);
      expect((await db.query(`update currency set minor_unit = 3 where code = 'INR'`)).rowCount).toBe(1);
    } finally {
      await db.query('rollback');
    }
  });

  it.each(GUARDED)('%s refuses a code outside the approved set', async (table) => {
    const write = WRITES[table]!;
    await db.query('begin');
    try {
      // An obligation's amount must equal its line decisions (CI03), which has nothing to do with currency and fires first.
      if (table === 'expense_obligation') await db.query(`alter table expense_obligation disable trigger expense_obligation_sum`);
      await db.query('savepoint before_write');
      await expect(write()).rejects.toMatchObject({ code: FK_VIOLATION, constraint: `${table}_currency_fk` });
      await db.query('rollback to savepoint before_write');
      await db.query(`alter table ${table} drop constraint ${table}_currency_fk`);
      expect((await write()).rowCount).toBe(1);
    } finally {
      await db.query('rollback');
    }
  });

  // 0208 (I-80, A6): the payroll calendar's currency and minor unit (payroll currencies are those of active calendars) and the
  // currencies Finance enables for claims join the five; 0212 (I-87): exchange rates and a claim line's own currency too. Every other
  // money column follows its calendar or its claim.
  it('is on these five tables, the payroll calendar, enabled currencies, exchange rates and claim lines, each validated', async () => {
    const rows = (
      await db.query<{ t: string; convalidated: boolean }>(`select conrelid::regclass::text as t, convalidated from pg_constraint where contype = 'f' and confrelid = 'currency'::regclass order by 1`)
    ).rows;
    expect(rows).toEqual([...GUARDED, 'company_currency', 'expense_exchange_rate', 'expense_line', 'payroll_calendar'].sort().map((t) => ({ t, convalidated: true })));
  });

  it('leaves a claim’s currency to the submit gate: a draft in another currency is still accepted here', async () => {
    const txn = await row(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'expense_claim', $2, 'DRAFT')`, [a.company, e1]);
    await db.query('begin');
    try {
      const id = await f.id(`insert into expense_claim (company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, 'Synthetic', 'XTS', 1, 'DRAFT', 'NOT_APPLICABLE')`, [a.company, e1, txn]);
      await db.query(`insert into expense_revision (company_id, claim_id, revision, currency_code, purpose) values ($1, $2, 1, 'XTS', 'Synthetic')`, [a.company, id]);
      await db.query('set constraints all immediate');
    } finally {
      await db.query('rollback');
    }
  });
});

// Upgrade: a stored row in another currency never stops the migration, is never changed, and a clean table still validates.
describe('0145 on a database that already holds payments', () => {
  let old: TestDatabase;
  let db: pg.Client;
  const company = randomUUID();
  const batch = randomUUID();

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0145' });
    await db.query('set session_replication_role = replica');
    await db.query(`insert into payment_batch (id, company_id, transaction_id, state, prepared_by, currency_code) values ($1, $2, $3, 'DRAFT', $4, 'USD')`, [batch, company, randomUUID(), randomUUID()]);
    await db.query('set session_replication_role = origin');
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  const validated = async (name: string) => (await db.query<{ convalidated: boolean }>(`select convalidated from pg_constraint where conname = $1`, [name])).rows[0]!.convalidated;

  it('applies, keeps the stored row as it was and leaves only that table’s constraint unvalidated', async () => {
    expect((await db.query(`select 1 from schema_migration where filename like '0145%'`)).rowCount).toBe(1);
    expect((await db.query<{ currency_code: string }>(`select currency_code from payment_batch where id = $1`, [batch])).rows[0]!.currency_code).toBe('USD');
    expect(await validated('payment_batch_currency_fk')).toBe(false);
    expect(await validated('expense_policy_currency_fk')).toBe(true);
  });
});
