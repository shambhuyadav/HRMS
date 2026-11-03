// Statement budgets and deadlines at the database layer (docs/09 §8.2; db/budget.ts, db/transaction.ts,
// db/instrument.ts): a transaction of a unit of work runs with its budget as `set local` values that end with it, the
// statement timeout is capped by the time left, nothing starts or commits after the deadline, a rollback always runs,
// and statements are counted per unit of work. Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../db/tests/fixtures.js';
import { startTestDatabase, type TestDatabase } from '../../../../db/tests/test-database.js';
import { beginStatement, DeadlineExceeded, newScope, runInScope, withoutDeadline } from './budget.js';
import { instrumentDatabase } from './instrument.js';
import { createPool } from './pool.js';
import type { Queryable } from './queryable.js';
import { withTransaction } from './transaction.js';

let testDb: TestDatabase;
let pool: pg.Pool;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settings = async (tx: Queryable) =>
  (await tx.query<{ statement: string; lock: string }>(`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`)).rows[0]!;
const users = async (key: string) => Number((await testDb.client.query<{ n: string }>(`select count(*) as n from user_account where account_key = $1`, [key])).rows[0]!.n);
const insertUser = (tx: Queryable, key: string) => tx.query(`insert into user_account (account_key, active) values ($1, true)`, [key]);

beforeAll(async () => {
  testDb = await startTestDatabase();
  // One connection, so every transaction below reuses the same session: nothing may leak from one to the next.
  pool = createPool(testDb.connectionString, 1);
});

afterAll(async () => {
  await pool?.end();
  await testDb?.stop();
});

describe('transaction budgets (set local)', () => {
  it('apply inside a unit of work and end with its transaction; work outside keeps the pool defaults', async () => {
    const outside = await withTransaction(pool, settings); // the pool's connection settings (db/pool.ts)
    expect(outside.lock).toBe('0');
    const scope = newScope({ statementTimeoutMs: 1234, lockTimeoutMs: 567 });
    expect(await runInScope(scope, () => withTransaction(pool, settings))).toEqual({ statement: '1234ms', lock: '567ms' });
    // The same connection afterwards: back to its defaults, inside and outside a transaction.
    expect(await withTransaction(pool, settings)).toEqual(outside);
    expect(await settings(pool)).toEqual(outside);
  });

  it('cap the statement timeout by the time left before the deadline, and the lock timeout by the statement timeout', async () => {
    const scope = newScope({ statementTimeoutMs: 60_000, lockTimeoutMs: 60_000 }, Date.now() + 900);
    const s = await runInScope(scope, () => withTransaction(pool, settings));
    const statementMs = Number(s.statement.replace(/ms$/, ''));
    expect(statementMs).toBeGreaterThan(0);
    expect(statementMs).toBeLessThanOrEqual(900);
    expect(s.lock).toBe(s.statement);
    // Never a zero (which would disable a timeout), never a value taken from anywhere but the budget.
    expect(beginStatement(newScope({ statementTimeoutMs: 5, lockTimeoutMs: 1 }, Date.now() + 10_000))).toBe('begin; set local statement_timeout = 5; set local lock_timeout = 1');
    expect(beginStatement(undefined)).toBe('begin');
  });

  it('turn a blocked lock into lock_timeout (55P03) at the budget, not at the statement timeout', async () => {
    const key = uniq('budget-lock.');
    await insertUser(testDb.client, key);
    await testDb.client.query('begin');
    try {
      await testDb.client.query(`select 1 from user_account where account_key = $1 for update`, [key]);
      const scope = newScope({ statementTimeoutMs: 10_000, lockTimeoutMs: 150 });
      const started = Date.now();
      const blocked = runInScope(scope, () => withTransaction(pool, (tx) => tx.query(`update user_account set active = false where account_key = $1`, [key])));
      await expect(blocked).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await testDb.client.query('rollback');
    }
  });
});

describe('deadlines', () => {
  it('past the deadline no transaction starts and no connection is taken', async () => {
    const scope = newScope({ statementTimeoutMs: 1_000, lockTimeoutMs: 500 }, Date.now() - 1);
    let ran = false;
    await expect(
      runInScope(scope, () =>
        withTransaction(pool, async () => {
          ran = true;
        }),
      ),
    ).rejects.toBeInstanceOf(DeadlineExceeded);
    expect(ran).toBe(false);
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });

  it('a transaction whose work outlives the deadline is rolled back, never committed', async () => {
    const key = uniq('budget-commit.');
    const scope = newScope({ statementTimeoutMs: 1_000, lockTimeoutMs: 500 }, Date.now() + 300);
    await expect(
      runInScope(scope, () =>
        withTransaction(pool, async (tx) => {
          await insertUser(tx, key);
          await sleep(450);
        }),
      ),
    ).rejects.toBeInstanceOf(DeadlineExceeded);
    expect(await users(key)).toBe(0);
  });
});

describe('the instrumented database', () => {
  const db = () => instrumentDatabase(pool);

  it('counts every statement of a unit of work, transaction control included, and nothing outside one', async () => {
    const scope = newScope({ statementTimeoutMs: 1_000, lockTimeoutMs: 500 });
    await runInScope(scope, async () => {
      await db().query('select 1');
      await withTransaction(db(), async (tx) => {
        await tx.query('select 1');
        await tx.query('select 2');
      });
    });
    // select 1; begin (with its two set local in the same round trip); select 1; select 2; commit
    expect(scope.statements).toBe(5);
    await db().query('select 1');
    expect(scope.statements).toBe(5);
  });

  it('refuses statements after the deadline but lets the rollback through, so the connection comes back clean', async () => {
    const key = uniq('budget-cut.');
    const scope = newScope({ statementTimeoutMs: 1_000, lockTimeoutMs: 500 }, Date.now() + 300);
    await expect(
      runInScope(scope, () =>
        withTransaction(db(), async (tx) => {
          await insertUser(tx, key);
          await sleep(450);
          await tx.query('select 1'); // refused: the request was already answered
        }),
      ),
    ).rejects.toBeInstanceOf(DeadlineExceeded);
    // The one pooled session saw a rollback: the insert is gone from it as well as from every other session.
    expect(Number((await pool.query<{ n: string }>(`select count(*) as n from user_account where account_key = $1`, [key])).rows[0]!.n)).toBe(0);
    expect(await users(key)).toBe(0);
    await expect(runInScope(scope, () => db().query('select 1'))).rejects.toBeInstanceOf(DeadlineExceeded);
    await expect(runInScope(scope, () => db().connect())).rejects.toBeInstanceOf(DeadlineExceeded);
  });

  it('gives a transaction opened with a plain begin on a checked-out client the same budget; outside a scope it stays plain', async () => {
    // The DF09 batch preview and commit (modules/imports) open their transactions this way instead of withTransaction.
    const raw = async () => {
      const client = await db().connect();
      try {
        await client.query('begin');
        const s = await settings(client);
        await client.query('rollback');
        return s;
      } finally {
        client.release();
      }
    };
    const scope = newScope({ statementTimeoutMs: 2345, lockTimeoutMs: 678 });
    expect(await runInScope(scope, raw)).toEqual({ statement: '2345ms', lock: '678ms' });
    expect(scope.statements).toBe(3);
    const outside = await raw();
    expect(outside.lock).toBe('0');
    expect(await settings(pool)).toEqual(outside);
  });

  it('withoutDeadline runs its own work past the deadline under the same budget and counts it; everything else stays refused', async () => {
    const scope = newScope({ statementTimeoutMs: 1234, lockTimeoutMs: 567 }, Date.now() - 1);
    await runInScope(scope, async () => {
      await expect(db().query('select 1')).rejects.toBeInstanceOf(DeadlineExceeded);
      expect(await withoutDeadline(() => withTransaction(db(), settings))).toEqual({ statement: '1234ms', lock: '567ms' });
      await expect(withTransaction(db(), settings)).rejects.toBeInstanceOf(DeadlineExceeded);
    });
    expect(scope.statements).toBe(3); // begin, the read, commit
    // Outside a scope, or in one without a deadline, it adds nothing.
    expect(await withoutDeadline(() => settings(pool))).toMatchObject({ lock: '0' });
  });

  it('a transaction whose connection came free only after the deadline sends nothing on it and frees it at once', async () => {
    const held = await pool.connect(); // the pool's only connection
    const scope = newScope({ statementTimeoutMs: 1_000, lockTimeoutMs: 500 }, Date.now() + 200);
    let ran = false;
    const waiting = runInScope(scope, () =>
      withTransaction(db(), async () => {
        ran = true;
      }),
    );
    await sleep(400);
    held.release();
    await expect(waiting).rejects.toBeInstanceOf(DeadlineExceeded);
    expect(ran).toBe(false);
    expect(scope.statements).toBe(0); // no begin, and no rollback for a transaction that never started
    expect(pool.totalCount - pool.idleCount).toBe(0);
  });
});
