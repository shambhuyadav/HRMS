// Statement budgets for one unit of work (docs/09 §8.2; ADR-14). An API request runs under the budget of its route's
// serving class, with an end-to-end deadline (http/deadline.ts); a worker bulk chunk runs under the bulk budget, without
// a deadline (worker/scheduler.ts). The budget travels with the work through AsyncLocalStorage, so withTransaction
// (db/transaction.ts), and inside a request a plain `begin` on a checked-out client (db/instrument.ts), starts every
// transaction of that work with its statement_timeout and lock_timeout as `set local` values: they end with the
// transaction, never outlive it on a pooled connection, and work behind a transaction-mode pooler (docs/09 §8.1).
// Statements outside a transaction, and work outside any scope, keep the pool's connection defaults (db/pool.ts).
import { AsyncLocalStorage } from 'node:async_hooks';

export interface StatementBudget {
  /** Longest single statement inside a transaction (statement_timeout). */
  statementTimeoutMs: number;
  /** Longest wait for a row, table or advisory lock (lock_timeout); never above the statement timeout. */
  lockTimeoutMs: number;
}

export interface WorkScope {
  readonly budget: StatementBudget;
  /** Date.now() value after which the work starts nothing new: no connection, statement or commit. Absent for worker work. */
  readonly deadline?: number;
  /** Statements sent to the database for this unit of work (round trips; http/metrics.ts). */
  statements: number;
}

/** Work attempted after its deadline: answered 503 UNAVAILABLE with Retry-After (http/errors.ts), never committed. */
export class DeadlineExceeded extends Error {
  readonly code = 'DEADLINE_EXCEEDED';
  constructor() {
    super('The request deadline has passed');
    this.name = 'DeadlineExceeded';
  }
}

const storage = new AsyncLocalStorage<WorkScope>();

export const currentScope = (): WorkScope | undefined => storage.getStore();

export const newScope = (budget: StatementBudget, deadline?: number): WorkScope => (deadline === undefined ? { budget, statements: 0 } : { budget, deadline, statements: 0 });

/** Runs `work` (and everything it awaits) inside `scope`. */
export const runInScope = <T>(scope: WorkScope, work: () => T): T => storage.run(scope, work);

/**
 * Runs `work` under the scope's budget without its deadline, for the one write that must still happen after a request
 * was answered: closing a record whose open state would block later work (a biometric run, modules/biometric/sync.ts).
 * All other work stops at the deadline. The statement and lock timeouts still bound it; its statements count for the scope.
 */
export async function withoutDeadline<T>(work: () => Promise<T>): Promise<T> {
  const scope = storage.getStore();
  if (scope?.deadline === undefined) return work();
  const unbounded = newScope(scope.budget);
  try {
    return await storage.run(unbounded, work);
  } finally {
    scope.statements += unbounded.statements;
  }
}

/** Whole milliseconds left before the scope's deadline; Infinity without one. */
export const remainingMs = (scope: WorkScope, now = Date.now()): number => (scope.deadline === undefined ? Infinity : Math.floor(scope.deadline - now));

export function assertWithinDeadline(scope: WorkScope | undefined): void {
  if (scope && remainingMs(scope) <= 0) throw new DeadlineExceeded();
}

/** The longest timer Node schedules (a longer one fires at once) and the longest timeout PostgreSQL accepts, in ms. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * The statement that opens a transaction of this scope: the budget's values, the statement timeout capped by the time
 * left before the deadline so the request can still answer, and the lock timeout at most the statement timeout. Values
 * are positive integers (0 would disable a timeout) within MAX_TIMEOUT_MS, formatted here, never taken from input.
 */
export function beginStatement(scope: WorkScope | undefined): string {
  if (!scope) return 'begin';
  const left = remainingMs(scope);
  if (left <= 0) throw new DeadlineExceeded();
  const statement = Math.max(1, Math.floor(Math.min(scope.budget.statementTimeoutMs, left, MAX_TIMEOUT_MS)));
  const lock = Math.max(1, Math.floor(Math.min(scope.budget.lockTimeoutMs, statement)));
  return `begin; set local statement_timeout = ${statement}; set local lock_timeout = ${lock}`;
}

/**
 * A positive whole number of milliseconds from the environment, at most MAX_TIMEOUT_MS; undefined when unset or not
 * one, and the default applies.
 */
export function positiveIntFromEnv(name: string): number | undefined {
  const v = process.env[name];
  const n = v && /^\d+$/.test(v) ? Number(v) : 0;
  return n > 0 && n <= MAX_TIMEOUT_MS ? n : undefined;
}
