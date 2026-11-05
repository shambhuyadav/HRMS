// Helpers (not a test file) for ZT11 and the gates that repeat it: two real requests, each on its own pooled connection, made to
// overlap by a lock this test holds from a connection of its own. Each request starts only after the one before it is seen blocked in
// pg_stat_activity, so both are in flight before either can finish, and the order they queued in decides who wins, which lets a test
// prove each outcome in turn instead of whichever one the scheduler happened to pick. Nothing here sleeps to synchronise: the short
// wait in the loop re-reads a fact from the database, and the loop fails the test if that fact never becomes true.
import type { LightMyRequestResponse } from 'fastify';
import { dispatchOutbox } from '../modules/notification/dispatcher.js';
import type { Harness } from './harness.js';

/** Until at least `min` sessions other than the test's own wait on a heavyweight lock in this database. */
export async function waitForLockWaiters(h: Harness, min: number): Promise<void> {
  // A session holding a transaction open (raceOnRow) reads pg_stat_activity from a snapshot it keeps until told to discard it.
  const activity = async () => {
    await h.db.query('select pg_stat_clear_snapshot()');
    return (await h.db.query<{ wait: string | null; query: string }>(`select wait_event_type || '/' || wait_event as wait, left(query, 80) as query from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()`)).rows;
  };
  for (let i = 0; i < 800; i++) {
    if ((await activity()).filter((a) => a.wait?.startsWith('Lock/')).length >= min) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Never saw ${min} request(s) waiting on the lock: a request finished or failed before reaching it. Sessions: ${JSON.stringify(await activity())}`);
}

async function startInOrder<T>(h: Harness, requests: (() => Promise<T>)[]): Promise<Promise<T>[]> {
  const running: Promise<T>[] = [];
  for (const [i, request] of requests.entries()) {
    running.push(request());
    await waitForLockWaiters(h, i + 1);
  }
  return running;
}

/** Holds an advisory key of the application's (the text it hashes), starts the requests, and lets go once all are queued. */
export async function raceOnKey<T>(h: Harness, text: string, requests: (() => Promise<T>)[]): Promise<T[]> {
  await h.db.query(`select pg_advisory_lock(hashtextextended($1::text, 0))`, [text]);
  let running: Promise<T>[] = [];
  try {
    running = await startInOrder(h, requests);
  } finally {
    await h.db.query(`select pg_advisory_unlock(hashtextextended($1::text, 0))`, [text]);
  }
  return Promise.all(running);
}

/**
 * The key every state change of a business transaction takes first (workflow/engine.ts lockTransaction). It is granted in the order
 * the requests arrived, so the first listed wins.
 */
export const raceOnTransaction = <T>(h: Harness, transactionId: string, requests: (() => Promise<T>)[]) => raceOnKey(h, `bt:${transactionId}`, requests);

/** The same, for a path serialised by its row: holds the row from an open transaction of the test's own. */
export async function raceOnRow<T>(h: Harness, table: string, id: string, requests: (() => Promise<T>)[]): Promise<T[]> {
  await h.db.query('begin');
  let running: Promise<T>[] = [];
  try {
    await h.db.query(`select 1 from ${table} where id = $1 for update`, [id]);
    running = await startInOrder(h, requests);
  } finally {
    await h.db.query('commit');
  }
  return Promise.all(running);
}

export const statusesOf = (results: LightMyRequestResponse[]) => results.map((r) => r.statusCode).sort((a, b) => a - b);

/** The transaction a task decides. */
export const transactionOfTask = async (h: Harness, taskId: string) =>
  (await h.one<{ transaction_id: string }>(`select i.transaction_id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id where t.id = $1`, [taskId])).transaction_id;

export interface Footprint {
  decisions: number;
  tasks: string[];
  audit: string[];
  outbox: string[];
  notifications: string[];
}

/**
 * Everything one decision leaves on a transaction: decisions, tasks, audit rows, outbox events and, once dispatched, notifications.
 * A raced decision must leave what the same decision leaves alone; comparing with that spares each test from listing what a decision
 * writes, and notices a second effect in a table the test's author did not think of.
 */
export async function footprintOf(h: Harness, companyId: string, transactionId: string, recordId: string): Promise<Footprint> {
  await dispatchOutbox(h.pool, 500);
  const list = async (sql: string, params: unknown[]) => (await h.db.query<{ v: string }>(sql, params)).rows.map((r) => r.v);
  const taskIds = await list(
    `select t.id::text as v from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id where i.company_id = $1 and i.transaction_id = $2`,
    [companyId, transactionId],
  );
  return {
    decisions: (
      await h.db.query<{ n: number }>(
        `select count(*)::int as n from approval_decision d join approval_task t on t.company_id = d.company_id and t.id = d.task_id
           join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id where i.company_id = $1 and i.transaction_id = $2`,
        [companyId, transactionId],
      )
    ).rows[0]!.n,
    tasks: await list(
      `select t.state as v from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id where i.company_id = $1 and i.transaction_id = $2 order by 1`,
      [companyId, transactionId],
    ),
    audit: await list(`select resource_code || ':' || action as v from audit_event where company_id = $1 and record_key = any ($2::uuid[]) order by 1`, [companyId, [transactionId, recordId, ...taskIds]]),
    outbox: await list(`select topic as v from outbox_event where company_id = $1 and aggregate_id = any ($2::uuid[]) order by 1`, [companyId, [transactionId, recordId]]),
    notifications: await list(`select category || ':' || recipient_user_id as v from notification where company_id = $1 and transaction_id = $2 order by 1`, [companyId, transactionId]),
  };
}

/** For comparing transactions of different people: the same notices, whoever they went to. */
export const withoutRecipients = (f: Footprint): Footprint => ({ ...f, notifications: f.notifications.map((n) => n.split(':')[0] as string) });
