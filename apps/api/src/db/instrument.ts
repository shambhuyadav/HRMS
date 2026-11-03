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
    return (client.query as (...a: unknown[]) => unknown).apply(client, args);
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
      return db.query<R>(text, values);
    },
    async connect(): Promise<pg.PoolClient> {
      const scope = currentScope();
      if (scope && remainingMs(scope) <= 0) throw new DeadlineExceeded();
      return instrumentClient(await db.connect());
    },
  };
}
