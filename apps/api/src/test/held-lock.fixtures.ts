// Forces an overlap instead of hoping for one (ZT14, ZT15, ZT40): the test's own connection holds a lock inside its transaction while the
// work starts, every piece of it reaches that lock inside its real transaction, and only then is the lock let go. Each has therefore
// passed its route guard and opened its transaction before any of them commits, whatever the machine's load. It fails, rather than passing
// unseen, when one never reaches the lock (refused early, or the path no longer takes it). race.fixtures.ts holds the HTTP-only form with
// the arrival order fixed; this one takes any promise (a worker job too) and leaves the order open, for tests that judge whichever won.
import { expect } from 'vitest';
import type { Harness } from './harness.js';

export interface HeldLock {
  /** A locking statement over what the work takes first, for example `select 1 from t where id = $1 for update`. */
  sql: string;
  params: unknown[];
}

/** Sessions of this test's database waiting for a lock, counted on another connection (the holder's own view is cached for its transaction). */
const waiting = async (h: Harness) =>
  Number((await h.pool.query<{ n: string }>(`select count(*) as n from pg_stat_activity where wait_event_type = 'Lock' and datname = current_database()`)).rows[0]!.n);

/** Starts the work behind the lock, waits until all of it is queued there, lets go and answers the results in order. */
export async function raceBehindLock<T>(h: Harness, lock: HeldLock, work: (() => Promise<T>)[]): Promise<T[]> {
  let seen = 0;
  await h.db.query('begin');
  let pending: Promise<T>[] = [];
  try {
    await h.db.query(lock.sql, lock.params);
    pending = work.map((start) => start());
    for (let i = 0; i < 600 && seen < work.length; i++) {
      seen = await waiting(h);
      if (seen < work.length) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await h.db.query('commit');
  }
  const results = await Promise.all(pending);
  expect(seen, 'all of it must have reached the held lock, or nothing overlapped').toBeGreaterThanOrEqual(work.length);
  return results;
}
