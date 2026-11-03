// Worker statement budgets (docs/09 §8.2 "Worker statements": longer for bulk chunks; §13.2 item 3): every bulk-job
// chunk transaction of a scheduler tick runs with the bulk budget's own `set local` statement and lock timeouts, never
// the API's interactive ones, while the rest of the tick (company loop, outbox, reports) keeps the pool's connection
// defaults. The values are read back from the server inside each transaction. Synthetic data only.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '../db/queryable.js';
import { type Database, withTransaction } from '../db/transaction.js';
import { DEFAULT_SERVING_BUDGETS } from '../http/deadline.js';
import { type Company, type Harness, startHarness, type TestActor } from '../test/harness.js';
import { bulkChunkBudget, runScheduledJobs } from './scheduler.js';

let h: Harness;
let A: Company;
let hr: TestActor;

interface Timeouts {
  /** Milliseconds, as pg_settings holds them ('0' = none). */
  statement: string;
  lock: string;
}
interface Observed extends Timeouts {
  statements: string[];
}

const timeouts = async (q: Queryable) =>
  (
    await q.query<Timeouts>(
      `select (select setting from pg_settings where name = 'statement_timeout') as statement, (select setting from pg_settings where name = 'lock_timeout') as lock`,
    )
  ).rows[0]!;

/** The pool, recording every transaction it serves: the timeouts in force right after its begin, and its statements. */
function observing(pool: pg.Pool): { db: Database; transactions: Observed[] } {
  const transactions: Observed[] = [];
  const db: Database = {
    query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]) {
      return pool.query<R>(text, values);
    },
    async connect() {
      const client = await pool.connect();
      let current: Observed | undefined;
      const query = async (text: string, values?: unknown[]) => {
        const result = await client.query(text, values);
        if (/^\s*begin\b/i.test(text)) {
          current = { ...(await timeouts(client)), statements: [] };
          transactions.push(current);
        } else {
          current?.statements.push(text);
        }
        return result;
      };
      return new Proxy(client, { get: (target, property) => (property === 'query' ? query : Reflect.get(target, property, target)) });
    },
  };
  return { db, transactions };
}

const isChunk = (t: Observed) => t.statements.some((s) => s.includes('from bulk_job'));
const isOutbox = (t: Observed) => t.statements.some((s) => s.includes('from outbox_event'));
/** 11:00 in the company's business timezone (Asia/Kolkata) today, as the scheduler ledger tests use. */
const elevenLocal = () => {
  const day = new Date();
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 11, 0) - 330 * 60_000);
};
const queueProcessing = async (workDate: string) => {
  const res = await h.call(hr, 'POST', '/v1/attendance/processing', { workDate });
  expect(res.statusCode).toBe(202);
  return res.json().jobId as string;
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  expect((await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).statusCode).toBe(201);
});

afterAll(async () => {
  await h?.stop();
});

describe('worker statement budgets (docs/09 §8.2)', () => {
  it('defaults to 60 s statements and 15 s lock waits for bulk chunks, longer than any interactive class; configurable, lock never above statement', () => {
    const names = ['DB_BULK_STATEMENT_TIMEOUT_MS', 'DB_BULK_LOCK_TIMEOUT_MS'];
    const saved = names.map((n) => [n, process.env[n]] as const);
    try {
      for (const n of names) delete process.env[n];
      expect(bulkChunkBudget()).toEqual({ statementTimeoutMs: 60_000, lockTimeoutMs: 15_000 });
      for (const b of Object.values(DEFAULT_SERVING_BUDGETS)) {
        expect(b.statementTimeoutMs).toBeLessThan(60_000);
        expect(b.lockTimeoutMs).toBeLessThan(15_000);
      }
      process.env.DB_BULK_STATEMENT_TIMEOUT_MS = '90000';
      process.env.DB_BULK_LOCK_TIMEOUT_MS = '20000';
      expect(bulkChunkBudget()).toEqual({ statementTimeoutMs: 90_000, lockTimeoutMs: 20_000 });
      process.env.DB_BULK_STATEMENT_TIMEOUT_MS = '10000';
      expect(bulkChunkBudget()).toEqual({ statementTimeoutMs: 10_000, lockTimeoutMs: 10_000 });
      process.env.DB_BULK_STATEMENT_TIMEOUT_MS = '0'; // not a positive value: the default stays
      process.env.DB_BULK_LOCK_TIMEOUT_MS = 'later';
      expect(bulkChunkBudget()).toEqual({ statementTimeoutMs: 60_000, lockTimeoutMs: 15_000 });
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });

  it('runs every bulk chunk of a tick under the bulk budget, while the rest of the tick keeps the pool defaults', async () => {
    const defaults = await withTransaction(h.pool, timeouts); // outside any unit of work: the pool's connection settings
    expect(defaults.lock).toBe('0');
    const jobId = await queueProcessing('2026-03-02');
    const probe = observing(h.pool);
    const tick = await runScheduledJobs({ db: probe.db, providers: new Map(), systemUserId: hr.user }, elevenLocal());
    expect(tick.bulkChunks).toBeGreaterThanOrEqual(1);
    expect((await h.call(hr, 'GET', `/v1/bulk-jobs/${jobId}`)).json()).toMatchObject({ state: 'COMPLETED', errorCode: null });

    const budget = bulkChunkBudget();
    const chunks = probe.transactions.filter(isChunk);
    // The chunk that ran, and the claim that then found nothing more to do.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const t of chunks) expect({ statement: t.statement, lock: t.lock }).toEqual({ statement: String(budget.statementTimeoutMs), lock: String(budget.lockTimeoutMs) });
    const rest = probe.transactions.filter((t) => !isChunk(t));
    expect(rest.filter(isOutbox).length).toBeGreaterThanOrEqual(1);
    for (const t of rest) expect({ statement: t.statement, lock: t.lock }).toEqual(defaults);
  });

  it('takes a configured bulk budget', async () => {
    const jobId = await queueProcessing('2026-03-03');
    const probe = observing(h.pool);
    const bulkBudget = { statementTimeoutMs: 45_678, lockTimeoutMs: 12_345 };
    expect((await runScheduledJobs({ db: probe.db, providers: new Map(), systemUserId: hr.user, bulkBudget }, elevenLocal())).bulkChunks).toBeGreaterThanOrEqual(1);
    expect((await h.call(hr, 'GET', `/v1/bulk-jobs/${jobId}`)).json()).toMatchObject({ state: 'COMPLETED' });
    const chunks = probe.transactions.filter(isChunk);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const t of chunks) expect({ statement: t.statement, lock: t.lock }).toEqual({ statement: '45678', lock: '12345' });
  });
});
