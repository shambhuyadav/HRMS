import type pg from 'pg';
import { assertWithinDeadline, beginStatement, currentScope } from './budget.js';
import type { Queryable } from './queryable.js';

export interface Database extends Queryable {
  connect(): Promise<pg.PoolClient>;
}

/**
 * Runs `work` in one database transaction; rolls back on any error. Inside a unit of work with a statement budget (an
 * API request, a worker bulk chunk; db/budget.ts) the transaction starts with that budget's statement and lock timeouts
 * as `set local` values; past the request's deadline it takes no connection, starts nothing and never commits (the
 * caller was already answered 503, so the change must not happen behind its back). A commit already sent when the
 * deadline passes may still complete: as with any lost answer, the client retries with its idempotency key or expected
 * version.
 */
export async function withTransaction<T>(db: Database, work: (tx: Queryable) => Promise<T>): Promise<T> {
  const scope = currentScope();
  assertWithinDeadline(scope);
  const client = await db.connect();
  let begin: string;
  try {
    begin = beginStatement(scope); // the deadline may have passed while waiting for the connection: nothing is sent
  } catch (err) {
    client.release();
    throw err;
  }
  try {
    await client.query(begin);
    const result = await work(client);
    assertWithinDeadline(scope);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
