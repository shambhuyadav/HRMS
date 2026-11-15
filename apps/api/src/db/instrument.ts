// The API's view of the pool (docs/09 §8.2, §10.2). Every statement is counted for the unit of work it runs for
// (db/budget.ts; the per-request statement counts of http/metrics.ts), and none starts after that unit's deadline, so
// a request already answered 503 stops using the database at its next statement and its transaction rolls back. A
// plain `rollback` is always let through, so a transaction cut short still ends and frees its locks at once. A
// transaction opened with a plain `begin` on a checked-out client instead of withTransaction (the DF09 batch preview
// and commit, modules/imports) starts with the scope's budget as well. Work outside any scope passes straight through.
// A single statement outside a transaction (`query`) is admitted when it is issued: if it then waits for a free
// connection, it can still run after the deadline, bounded by the pool's connection wait and statement timeout.
import type pg from 'pg';
import { beginStatement, currentScope, DeadlineExceeded, remainingMs, type WorkScope } from './budget.js';
import type { Database } from './transaction.js';

const ROLLBACK = /^\s*rollback\s*;?\s*$/i;
const PLAIN_BEGIN = /^\s*begin\s*;?\s*$/i;

/** Counts the statement against the scope, or throws once the scope's deadline has passed. */
function admit(scope: WorkScope | undefined, text: unknown): void {
  if (!scope) return;
  if (remainingMs(scope) <= 0 && !(typeof text === 'string' && ROLLBACK.test(text))) throw new DeadlineExceeded();
  scope.statements += 1;
}

const statementText = (first: unknown): unknown => (typeof first === 'object' && first !== null ? (first as { text?: unknown }).text : first);

/**
 * Slow statements (improvement plan L5): one warning line per statement slower than SLOW_QUERY_MS (in production 500 ms unless set;
 * elsewhere only when set; 0 turns it off), with its duration and the first 300 characters of its SQL text. The values never appear:
 * they travel apart from the text, as parameters. A gradual slowdown shows in the log long before the statement timeout cuts it off.
 */
const SLOW_MS = (() => {
  const set = process.env.SLOW_QUERY_MS?.trim();
  if (set && /^\d+$/.test(set)) return Number(set);
  return process.env.NODE_ENV === 'production' ? 500 : 0;
})();

function timed<T>(result: T, text: unknown): T {
  if (SLOW_MS <= 0 || !(result instanceof Promise)) return result;
  const started = performance.now();
  void result.then(
    () => {
      const ms = Math.round(performance.now() - started);
      if (ms >= SLOW_MS) {
        const sql = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim().slice(0, 300) : '(prepared statement)';
        console.warn(JSON.stringify({ level: 'warn', msg: 'slow statement', ms, sql }));
      }
    },
    () => undefined,
  );
  return result;
}

const wrapped = new WeakMap<pg.PoolClient, pg.PoolClient>();

/**
 * The same pooled client with an admitting `query`. The scope is read on every call, not at checkout, because a
 * connection serves many requests; every other member is the client's own (`release` included).
 */
function instrumentClient(client: pg.PoolClient): pg.PoolClient {
  const known = wrapped.get(client);
  if (known) return known;
  const query = (...args: unknown[]): unknown => {
    try {
      const scope = currentScope();
      admit(scope, statementText(args[0]));
      if (scope && typeof args[0] === 'string' && PLAIN_BEGIN.test(args[0])) args[0] = beginStatement(scope);
    } catch (err) {
      const callback = args[args.length - 1];
      if (typeof callback === 'function') {
        process.nextTick(callback, err);
        return undefined;
      }
      return Promise.reject(err);
    }
    return timed((client.query as (...a: unknown[]) => unknown).apply(client, args), statementText(args[0]));
  };
  const proxy = new Proxy(client, { get: (target, property) => (property === 'query' ? query : Reflect.get(target, property, target)) });
  wrapped.set(client, proxy);
  return proxy;
}

export function instrumentDatabase(db: Database): Database {
  return {
    query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
      try {
        admit(currentScope(), text);
      } catch (err) {
        return Promise.reject(err);
      }
      return timed(db.query<R>(text, values), text);
    },
    async connect(): Promise<pg.PoolClient> {
      const scope = currentScope();
      if (scope && remainingMs(scope) <= 0) throw new DeadlineExceeded();
      return instrumentClient(await db.connect());
    },
  };
}
