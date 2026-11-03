// Request deadlines (docs/09 §8.2; NFR-S03, NFR-S10). Every /v1 route has a serving class, and each class an
// end-to-end deadline plus the statement budget its transactions run under (db/budget.ts):
//   read   GET and HEAD.
//   write  every other method.
//   batch  routes that carry a file or batch body (a body limit above the server's), that apply, resume or export a
//          DF09 batch (up to 10,000 rows) synchronously, or that run a bounded share of a chunked payroll operation
//          (REQUEST_BUDGET_MS in payroll/runs.ts) or a run-wide publication. A route may declare its class
//          (`config: { servingClass }`), which wins over these rules; work over a whole payroll run or a provider's
//          pages declares it (run creation and cancellation, bank manifests, loan recoveries, biometric runs), because
//          a retry repeats the same work and would fail the same way under the interactive budget.
// The deadline runs from the first hook, before the session check, until the answer is sent. When it passes, the
// request is answered 503 UNAVAILABLE with Retry-After (http/errors.ts), and its work stops at its next database
// statement: nothing new starts and nothing commits (db/instrument.ts, db/transaction.ts). Inside the request every
// transaction runs with the class's statement timeout, capped by the time left, and a lock timeout at or below it, so a
// blocked lock answers 503 quickly instead of holding the request until the deadline.
//
// Fastify's own `handlerTimeout` is not used: in Fastify 5.12 it clears its timer when the request stream closes, and
// for a request with a body over a real socket that happens as soon as the body has been read, so it would never bound
// a mutation. The values are starting budgets to be measured (G4), not capacity claims.
import type { FastifyInstance, FastifyRequest, HTTPMethods } from 'fastify';
import { DeadlineExceeded, newScope, positiveIntFromEnv, runInScope, type StatementBudget, type WorkScope } from '../db/budget.js';

export const SERVING_CLASSES = ['read', 'write', 'batch'] as const;
export type ServingClass = (typeof SERVING_CLASSES)[number];

declare module 'fastify' {
  interface FastifyContextConfig {
    /** The route's serving class (http/deadline.ts); assigned from its method, body limit and path unless declared. */
    servingClass?: ServingClass;
  }
}

export interface ClassBudget extends StatementBudget {
  /** End-to-end request deadline. */
  deadlineMs: number;
}
export type ServingBudgets = Readonly<Record<ServingClass, Readonly<ClassBudget>>>;
export type ServingBudgetOverrides = Partial<Record<ServingClass, Partial<ClassBudget>>>;

/**
 * Starting budgets: read and write are the docs/09 §8.2 proposal for Stage 0 (deadline 3 s and 5 s, statements 2 s and
 * 4 s, lock waits below them); batch keeps the pool's 15 s statement timeout and allows two minutes end to end for a
 * 10,000-row batch or a 14 MB upload. Deployments set measured values through the environment.
 */
export const DEFAULT_SERVING_BUDGETS: ServingBudgets = {
  read: { deadlineMs: 3_000, statementTimeoutMs: 2_000, lockTimeoutMs: 1_000 },
  write: { deadlineMs: 5_000, statementTimeoutMs: 4_000, lockTimeoutMs: 2_000 },
  batch: { deadlineMs: 120_000, statementTimeoutMs: 15_000, lockTimeoutMs: 5_000 },
};

const ENV_KEY: Record<ServingClass, string> = { read: 'READ', write: 'WRITE', batch: 'BATCH' };

const checked = (value: number | undefined, name: string): number | undefined => {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive whole number of milliseconds`);
  return value;
};

/**
 * The budgets in force: an explicit override, else HTTP_<CLASS>_DEADLINE_MS, DB_<CLASS>_STATEMENT_TIMEOUT_MS and
 * DB_<CLASS>_LOCK_TIMEOUT_MS (CLASS = READ, WRITE, BATCH), else the default. A statement timeout above the deadline,
 * or a lock timeout above the statement timeout, is lowered to it.
 */
export function servingBudgets(overrides: ServingBudgetOverrides = {}): ServingBudgets {
  const out = {} as Record<ServingClass, ClassBudget>;
  for (const cls of SERVING_CLASSES) {
    const given = overrides[cls] ?? {};
    const key = ENV_KEY[cls];
    const deadlineMs = checked(given.deadlineMs, `${cls}.deadlineMs`) ?? positiveIntFromEnv(`HTTP_${key}_DEADLINE_MS`) ?? DEFAULT_SERVING_BUDGETS[cls].deadlineMs;
    const statement = checked(given.statementTimeoutMs, `${cls}.statementTimeoutMs`) ?? positiveIntFromEnv(`DB_${key}_STATEMENT_TIMEOUT_MS`) ?? DEFAULT_SERVING_BUDGETS[cls].statementTimeoutMs;
    const lock = checked(given.lockTimeoutMs, `${cls}.lockTimeoutMs`) ?? positiveIntFromEnv(`DB_${key}_LOCK_TIMEOUT_MS`) ?? DEFAULT_SERVING_BUDGETS[cls].lockTimeoutMs;
    const statementTimeoutMs = Math.min(statement, deadlineMs);
    out[cls] = { deadlineMs, statementTimeoutMs, lockTimeoutMs: Math.min(lock, statementTimeoutMs) };
  }
  return out;
}

/** Paths that apply, resume or export a batch, run a share of a chunked payroll operation or publish run-wide. */
const BATCH_PATH = /\/(commit|resume|export|export-archive|calculate|verify|process|publish)$/;

export function servingClassOf(method: HTTPMethods | HTTPMethods[] | string | string[], url: string, bodyLimit: number | undefined, serverBodyLimit: number): ServingClass {
  if ((bodyLimit ?? serverBodyLimit) > serverBodyLimit || BATCH_PATH.test(url)) return 'batch';
  const methods: string[] = Array.isArray(method) ? method : [method];
  return methods.every((m) => m === 'GET' || m === 'HEAD') ? 'read' : 'write';
}

interface Pending {
  scope: WorkScope;
  timer: NodeJS.Timeout;
}

const pending = new WeakMap<FastifyRequest, Pending>();

/** The request's unit of work (budget, deadline, statement count); undefined outside /v1. */
export const scopeOf = (request: FastifyRequest): WorkScope | undefined => pending.get(request)?.scope;

/** Registers the classes, the deadline and the request scope. Call before any route and before the actor context. */
export function registerDeadlines(app: FastifyInstance, budgets: ServingBudgets): void {
  const serverBodyLimit = app.initialConfig.bodyLimit ?? 1_048_576;
  app.addHook('onRoute', (route) => {
    if (!route.url.startsWith('/v1/')) return;
    const servingClass = route.config?.servingClass ?? servingClassOf(route.method, route.url, route.bodyLimit, serverBodyLimit);
    route.config = { ...route.config, servingClass };
  });
  app.addHook('onRequest', (request, reply, done) => {
    const servingClass = request.routeOptions.config?.servingClass;
    if (!servingClass) return done();
    const budget = budgets[servingClass];
    const scope = newScope(budget, Date.now() + budget.deadlineMs);
    const timer = setTimeout(() => {
      // One answer per request: a reply already sent (or with headers out) is left alone.
      if (!reply.sent && !reply.raw.headersSent) reply.send(new DeadlineExceeded());
    }, budget.deadlineMs);
    timer.unref();
    reply.raw.once('close', () => clearTimeout(timer));
    pending.set(request, { scope, timer });
    runInScope(scope, done);
  });
  // The body is read from the request stream, outside the request's async context: enter the scope again for the handler.
  app.addHook('preValidation', (request, _reply, done) => {
    const p = pending.get(request);
    if (!p) return done();
    runInScope(p.scope, done);
  });
  app.addHook('onResponse', (request, _reply, done) => {
    const p = pending.get(request);
    if (p) clearTimeout(p.timer);
    done();
  });
}
