// A transaction and its typed root agree (migration 0142; CI12; B5 line 4547; C4; line 81 "test direct data writes"). Every refusal
// names this guard's own constraint or message, and the same write then succeeds with that one guard removed, so a test cannot
// pass because another check objected. All 34 kinds share one mechanism; a catalogue test proves each carries it. Synthetic data only.
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../migrate.js';
import { CHECK_VIOLATION, type CompanyFixture, FK_VIOLATION, fixtures } from './fixtures.js';
import { startEmptyTestDatabase, startTestDatabase, type TestDatabase } from './test-database.js';

describe('a transaction and its typed root agree', () => {
  let testDb: TestDatabase;
  let db: pg.Client;
  let f: ReturnType<typeof fixtures>;
  let a: CompanyFixture;
  let e1: string;
  let e2: string;

  const transaction = (kind: string, owner: string | null, state: string) => f.id(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, $2, $3, $4)`, [a.company, kind, owner, state]);
  /** A draft claim with its first revision, as the service writes them. */
  const insertClaim = async (txn: string, employee: string) => {
    const id = await f.id(`insert into expense_claim (company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, 'Synthetic', 'INR', 1, 'DRAFT', 'NOT_APPLICABLE')`, [a.company, employee, txn]);
    await db.query(`insert into expense_revision (company_id, claim_id, revision, currency_code, purpose) values ($1, $2, 1, 'INR', 'Synthetic')`, [a.company, id]);
    return id;
  };

  /** A draft claim and its transaction, committed: both written in one transaction because each deferred check needs the other. */
  const claim = async () => {
    await db.query('begin');
    try {
      const txn = await transaction('expense_claim', e1, 'DRAFT');
      const id = await insertClaim(txn, e1);
      await db.query('commit');
      return { id, txn };
    } catch (e) {
      await db.query('rollback');
      throw e;
    }
  };

  const confirmation = async (employee = e1) => {
    await db.query('set session_replication_role = replica');
    try {
      const txn = await transaction('employee_confirmation', employee, 'OPEN');
      const id = (
        await db.query(`insert into employee_confirmation (company_id, employee_id, policy_id, transaction_id, start_date, initial_due_date, current_due_date, state) values ($1, $2, $3, $4, '2026-01-01', '2026-07-01', '2026-07-01', 'OPEN') returning id`, [
          a.company,
          employee,
          randomUUID(),
          txn,
        ])
      ).rows[0].id as string;
      return { id, txn };
    } finally {
      await db.query('set session_replication_role = origin');
    }
  };

  /** Runs the writes as one database transaction and commits, so the deferred checks decide. */
  const committed = async (write: () => Promise<unknown>) => {
    await db.query('begin');
    try {
      await write();
      await db.query('commit');
    } catch (e) {
      await db.query('rollback');
      throw e;
    }
  };

  /** The same writes pass every remaining check, deferred ones included, once `remove` has taken away the one guard. Everything is undone. */
  const passWithout = async (remove: string, write: () => Promise<unknown>) => {
    await db.query('begin');
    try {
      await db.query(remove);
      await write();
      await db.query('set constraints all immediate');
    } finally {
      await db.query('rollback');
    }
  };

  beforeAll(async () => {
    testDb = await startTestDatabase();
    db = testDb.client;
    f = fixtures(db);
    a = await f.makeCompany();
    e1 = await f.makeEmployee(a, 'RA1');
    e2 = await f.makeEmployee(a, 'RA2');
  });

  afterAll(async () => {
    await testDb?.stop();
  });

  describe('the root’s employee is the transaction’s owner', () => {
    const DROP = (table: string) => `alter table ${table} drop constraint ${table}_owner_agrees`;
    const byGuard = (table: string) => ({ code: FK_VIOLATION, constraint: `${table}_owner_agrees` });

    it('accepts a root of the owner', async () => {
      await expect(claim()).resolves.toMatchObject({ id: expect.any(String) });
    });

    it('refuses a root naming someone other than the owner', async () => {
      const write = async () => insertClaim(await transaction('expense_claim', e1, 'DRAFT'), e2);
      await expect(committed(write)).rejects.toMatchObject(byGuard('expense_claim'));
      await passWithout(DROP('expense_claim'), write);
    });

    it('refuses a root naming an employee on a transaction with no owner', async () => {
      const write = async () => insertClaim(await transaction('expense_claim', null, 'DRAFT'), e1);
      await expect(committed(write)).rejects.toMatchObject(byGuard('expense_claim'));
      await passWithout(DROP('expense_claim'), write);
    });

    it('fixes the employee of an expense claim', async () => {
      const { id } = await claim();
      const write = () => db.query(`update expense_claim set employee_id = $2 where id = $1`, [id, e2]);
      await expect(committed(write)).rejects.toMatchObject(byGuard('expense_claim'));
      await passWithout(DROP('expense_claim'), write);
    });

    it('fixes the employee of a confirmation case', async () => {
      const { id } = await confirmation();
      const write = () => db.query(`update employee_confirmation set employee_id = $2 where id = $1`, [id, e2]);
      await expect(committed(write)).rejects.toMatchObject(byGuard('employee_confirmation'));
      await passWithout(DROP('employee_confirmation'), write);
    });

    it('every root naming an employee carries the check, validated and deferred to commit', async () => {
      const rows = (
        await db.query<{ root_table: string; column_name: string; def: string | null; convalidated: boolean | null }>(
          `select tk.root_table, c.column_name, pg_get_constraintdef(con.oid) as def, con.convalidated
             from transaction_kind tk
             join information_schema.columns c on c.table_schema = current_schema() and c.table_name = tk.root_table and c.column_name in ('employee_id', 'requesting_employee_id')
             left join pg_constraint con on con.conrelid = to_regclass(tk.root_table) and con.conname = tk.root_table || '_owner_agrees'
            order by tk.root_table`,
        )
      ).rows;
      // 34 kinds, of which hiring_offer, manpower_budget_revision, payment_batch, payroll_input_batch, payroll_run and payroll_run_approval name no employee.
      expect(rows).toHaveLength(28);
      for (const r of rows) {
        expect(r.def, r.root_table).toContain(`FOREIGN KEY (company_id, transaction_id, ${r.column_name}) REFERENCES business_transaction(company_id, id, owner_employee_id)`);
        expect(r.def, r.root_table).toContain('DEFERRABLE INITIALLY DEFERRED');
        expect(r.convalidated, r.root_table).toBe(true);
      }
    });
  });

  describe('state written on one side only', () => {
    const DISABLE = `alter table business_transaction disable trigger business_transaction_state_agrees`;
    const APART = /is in state WITHDRAWN but its expense_claim root is in state DRAFT/;

    it('refuses a transaction state moved without its root', async () => {
      const { txn } = await claim();
      const write = () => db.query(`update business_transaction set state = 'WITHDRAWN' where id = $1`, [txn]);
      await expect(committed(write)).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(APART) });
      await passWithout(DISABLE, write);
    });

    it('accepts both moved together, in either order', async () => {
      const one = await claim();
      await committed(async () => {
        await db.query(`update business_transaction set state = 'WITHDRAWN' where id = $1`, [one.txn]);
        await db.query(`update expense_claim set state = 'WITHDRAWN' where id = $1`, [one.id]);
      });
      const two = await claim();
      await committed(async () => {
        await db.query(`update expense_claim set state = 'WITHDRAWN' where id = $1`, [two.id]);
        await db.query(`update business_transaction set state = 'WITHDRAWN' where id = $1`, [two.txn]);
      });
    });

    it('compares the rows as they stand at commit, not an intermediate state', async () => {
      const { id, txn } = await claim();
      await committed(async () => {
        await db.query(`update business_transaction set state = 'MANAGER_PENDING' where id = $1`, [txn]);
        await db.query(`update business_transaction set state = 'WITHDRAWN' where id = $1`, [txn]);
        await db.query(`update expense_claim set state = 'WITHDRAWN' where id = $1`, [id]);
      });
    });

    it('leaves a write that moves no state alone', async () => {
      const { txn } = await claim();
      await committed(() => db.query(`update business_transaction set updated_by = null where id = $1`, [txn]));
    });

    it('is attached to the transaction table', async () => {
      const t = await f.one<{ tgdeferrable: boolean; tginitdeferred: boolean }>(`select tgdeferrable, tginitdeferred from pg_trigger where tgname = 'business_transaction_state_agrees'`);
      expect(t).toEqual({ tgdeferrable: true, tginitdeferred: true });
    });
  });

  describe('a root keeps its transaction', () => {
    it('refuses moving a root to another transaction', async () => {
      const { id } = await claim();
      await db.query('begin');
      try {
        // The new transaction needs a root of its own to commit, so the attempt stays inside this one.
        const free = await transaction('expense_claim', e1, 'DRAFT');
        const write = () => db.query(`update expense_claim set transaction_id = $2 where id = $1`, [id, free]);
        await db.query('savepoint before_write');
        await expect(write()).rejects.toMatchObject({ code: CHECK_VIOLATION, message: expect.stringMatching(/expense_claim\.transaction_id is fixed once written/) });
        await db.query('rollback to savepoint before_write');
        await db.query(`alter table expense_claim disable trigger expense_claim_transaction_fixed`);
        expect((await write()).rowCount).toBe(1);
      } finally {
        await db.query('rollback');
      }
    });

    it('every registered root carries the guard', async () => {
      const missing = (
        await db.query<{ root_table: string }>(
          `select tk.root_table from transaction_kind tk
            where not exists (select 1 from pg_trigger t where t.tgrelid = to_regclass(tk.root_table) and t.tgname = tk.root_table || '_transaction_fixed' and t.tgenabled = 'O')`,
        )
      ).rows.map((r) => r.root_table);
      expect(missing).toEqual([]);
      expect((await f.one<{ n: number }>(`select count(*)::int as n from transaction_kind`)).n).toBe(34);
    });
  });
});

// Upgrade: a stored disagreement never stops the migration, is never changed, and a clean table still validates.
describe('0142 on a database that already holds transactions', () => {
  let old: TestDatabase;
  let db: pg.Client;
  const company = randomUUID();
  const [owner, other] = [randomUUID(), randomUUID()];
  const [txn, claimId] = [randomUUID(), randomUUID()];

  beforeAll(async () => {
    const empty = await startEmptyTestDatabase();
    if (!empty) throw new Error('An upgrade test needs TEST_PG_ADMIN_URL');
    old = empty;
    db = old.client;
    await migrate(db, { before: '0142' });
    await db.query('set session_replication_role = replica');
    await db.query(`insert into business_transaction (id, company_id, kind, owner_employee_id, state) values ($1, $2, 'expense_claim', $3, 'DRAFT')`, [txn, company, owner]);
    await db.query(`insert into expense_claim (id, company_id, employee_id, transaction_id, purpose, currency_code, current_revision, state, payment_state) values ($1, $2, $3, $4, 'Stored before 0142 (synthetic)', 'INR', 1, 'DRAFT', 'NOT_APPLICABLE')`, [
      claimId,
      company,
      other,
      txn,
    ]);
    await db.query('set session_replication_role = origin');
    await migrate(db);
  }, 180_000);

  afterAll(async () => {
    await old?.stop();
  });

  const validated = async (name: string) => (await db.query<{ convalidated: boolean }>(`select convalidated from pg_constraint where conname = $1`, [name])).rows[0]!.convalidated;

  it('applies, keeps the stored row as it was and leaves only that table’s check unvalidated', async () => {
    expect((await db.query(`select 1 from schema_migration where filename like '0142%'`)).rowCount).toBe(1);
    expect((await db.query<{ employee_id: string }>(`select employee_id from expense_claim where id = $1`, [claimId])).rows[0]!.employee_id).toBe(other);
    expect(await validated('expense_claim_owner_agrees')).toBe(false);
    expect(await validated('leave_request_owner_agrees')).toBe(true);
  });
});
