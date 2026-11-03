import pg from 'pg';

// Business dates stay plain 'YYYY-MM-DD' strings (DF05: date-only values never shift between zones) and
// exact decimals stay strings (B1 MONEY/QTY: never JavaScript floating point).
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (value) => value);

export interface PoolOptions {
  /** Connections per process (G3: bounded pools; request handling never holds a connection per user). */
  max?: number;
  /** Longest single statement (G3 timeout budget); a slower statement fails instead of piling up. */
  statementTimeoutMs?: number;
  /** A transaction left idle (e.g. a stalled client) is ended so it cannot hold locks. */
  idleInTransactionTimeoutMs?: number;
  /** Waiting for a free connection beyond this fails fast (back-pressure) instead of queueing without bound. */
  connectionTimeoutMs?: number;
}

const fromEnv = (name: string): number | undefined => {
  const v = process.env[name];
  return v && /^\d+$/.test(v) ? Number(v) : undefined;
};

/**
 * The defaults are engineering budgets for one API process (Appendix G3 asks for explicit pool, timeout and retry
 * budgets); deployments size them per serving unit through the environment after measurement.
 */
export function createPool(connectionString: string, max?: number, options: PoolOptions = {}): pg.Pool {
  return new pg.Pool({
    connectionString,
    max: max ?? options.max ?? fromEnv('DB_POOL_MAX') ?? 10,
    statement_timeout: options.statementTimeoutMs ?? fromEnv('DB_STATEMENT_TIMEOUT_MS') ?? 15_000,
    idle_in_transaction_session_timeout: options.idleInTransactionTimeoutMs ?? fromEnv('DB_IDLE_IN_TRANSACTION_TIMEOUT_MS') ?? 30_000,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? fromEnv('DB_CONNECTION_TIMEOUT_MS') ?? 10_000,
  });
}
