// Internal serving metrics (docs/09 §10.2; NFR-S05, NFR-S11) in the Prometheus text exposition format 0.0.4:
//   hrms_http_requests_total              counter    method, route, status_class
//   hrms_http_request_duration_seconds    histogram  method, route, status_class (first hook to answer)
//   hrms_http_request_statements          histogram  method, route, status_class (database statements per /v1 request)
//   hrms_http_unavailable_total           counter    route, cause (retryable 503s: deadline, lock_timeout, pool_wait, ...)
//   hrms_db_pool_connections              gauge      state (total, idle, waiting; node-postgres pool counters)
// Labels are bounded: the route pattern as registered (never the URL, so never an id, code or search term), the
// method, the status class and a cause name. No user, company, assignment, session or request id is ever a label, and
// nothing of a request or answer body is recorded.
// GET /internal/metrics exists only when a metrics token of at least 32 characters is configured, and answers only a
// caller presenting it as a bearer token, compared in constant time; without a token the route is not registered.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { scopeOf } from './deadline.js';
import { unavailableCause } from './errors.js';

export const METRICS_PATH = '/internal/metrics';
export const MIN_METRICS_TOKEN_LENGTH = 32;

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120];
const STATEMENT_BUCKETS = [1, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 5000];
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const CAUSES: Record<string, string> = {
  '57014': 'statement_timeout',
  '55P03': 'lock_timeout',
  '25P03': 'idle_in_transaction_timeout',
  '53300': 'too_many_connections',
  '57P01': 'shutdown',
  '57P02': 'shutdown',
  '57P03': 'shutdown',
  DEADLINE_EXCEEDED: 'deadline',
  POOL_TIMEOUT: 'pool_wait',
};
/** SQLSTATE class 08, or a socket error of an unreachable database (E...). */
const causeName = (code: string) => CAUSES[code] ?? (code.startsWith('08') || code.startsWith('E') ? 'connection' : 'other');

export interface PoolCounters {
  readonly totalCount: number;
  readonly idleCount: number;
  readonly waitingCount: number;
}

const isPoolCounters = (value: unknown): value is PoolCounters =>
  typeof value === 'object' && value !== null && ['totalCount', 'idleCount', 'waitingCount'].every((k) => typeof (value as Record<string, unknown>)[k] === 'number');

class Histogram {
  /** Cumulative: counts[i] is the number of observations at or below bounds[i]. */
  readonly counts: number[];
  sum = 0;
  count = 0;
  constructor(readonly bounds: readonly number[]) {
    this.counts = bounds.map(() => 0);
  }
  observe(value: number) {
    this.sum += value;
    this.count += 1;
    this.bounds.forEach((bound, i) => {
      if (value <= bound) this.counts[i] = (this.counts[i] ?? 0) + 1;
    });
  }
}

interface Series {
  labels: string;
  requests: number;
  duration: Histogram;
  statements: Histogram;
}

const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const labelText = (pairs: [string, string][]) => pairs.map(([k, v]) => `${k}="${escape(v)}"`).join(',');

export interface RequestSample {
  method: string;
  /** The route pattern, or undefined when no route matched. */
  route: string | undefined;
  statusCode: number;
  seconds: number;
  /** Statements sent for the request, when it ran in a unit of work (/v1). */
  statements: number | undefined;
  /** The 503 cause recorded by the error handler, if any. */
  unavailable: string | undefined;
}

export class ServingMetrics {
  private readonly series = new Map<string, Series>();
  private readonly refusals = new Map<string, { labels: string; count: number }>();

  observe(sample: RequestSample): void {
    const method = METHODS.has(sample.method) ? sample.method : 'OTHER';
    const route = sample.route ?? 'UNMATCHED';
    const statusClass = `${Math.trunc(sample.statusCode / 100)}xx`;
    const key = `${method} ${route} ${statusClass}`;
    let s = this.series.get(key);
    if (!s) {
      s = { labels: labelText([['method', method], ['route', route], ['status_class', statusClass]]), requests: 0, duration: new Histogram(LATENCY_BUCKETS), statements: new Histogram(STATEMENT_BUCKETS) };
      this.series.set(key, s);
    }
    s.requests += 1;
    s.duration.observe(Math.max(0, sample.seconds));
    if (sample.statements !== undefined) s.statements.observe(sample.statements);
    if (sample.unavailable !== undefined) {
      const cause = causeName(sample.unavailable);
      const refusalKey = `${route} ${cause}`;
      const r = this.refusals.get(refusalKey) ?? { labels: labelText([['route', route], ['cause', cause]]), count: 0 };
      r.count += 1;
      this.refusals.set(refusalKey, r);
    }
  }

  render(pool: unknown): string {
    const lines: string[] = [];
    const all = [...this.series.values()];
    const histogram = (name: string, help: string, pick: (s: Series) => Histogram) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} histogram`);
      for (const s of all) {
        const h = pick(s);
        if (h.count === 0) continue;
        h.bounds.forEach((bound, i) => lines.push(`${name}_bucket{${s.labels},le="${bound}"} ${h.counts[i] ?? 0}`));
        lines.push(`${name}_bucket{${s.labels},le="+Inf"} ${h.count}`, `${name}_sum{${s.labels}} ${h.sum}`, `${name}_count{${s.labels}} ${h.count}`);
      }
    };
    lines.push('# HELP hrms_http_requests_total Requests answered, by method, route pattern and status class.', '# TYPE hrms_http_requests_total counter');
    for (const s of all) lines.push(`hrms_http_requests_total{${s.labels}} ${s.requests}`);
    histogram('hrms_http_request_duration_seconds', 'Time from the first request hook to the answer, by method, route pattern and status class.', (s) => s.duration);
    histogram('hrms_http_request_statements', 'Database statements sent for one /v1 request, by method, route pattern and status class.', (s) => s.statements);
    lines.push('# HELP hrms_http_unavailable_total Retryable 503 answers, by route pattern and cause.', '# TYPE hrms_http_unavailable_total counter');
    for (const r of this.refusals.values()) lines.push(`hrms_http_unavailable_total{${r.labels}} ${r.count}`);
    if (isPoolCounters(pool)) {
      lines.push('# HELP hrms_db_pool_connections Connections of this process pool: open (total), idle, and callers waiting for one.', '# TYPE hrms_db_pool_connections gauge');
      lines.push(`hrms_db_pool_connections{state="total"} ${pool.totalCount}`, `hrms_db_pool_connections{state="idle"} ${pool.idleCount}`, `hrms_db_pool_connections{state="waiting"} ${pool.waitingCount}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();

function presentedToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
}

/**
 * Records every answered request and serves the metrics to holders of the token. `pool` is read for its counters at
 * each scrape when it has them (a node-postgres pool).
 */
export function registerMetrics(app: FastifyInstance, options: { token: string; pool?: unknown }): ServingMetrics {
  if (options.token.length < MIN_METRICS_TOKEN_LENGTH) throw new Error(`The metrics token must be at least ${MIN_METRICS_TOKEN_LENGTH} characters`);
  const expected = digest(options.token);
  const metrics = new ServingMetrics();
  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions.url;
    if (route !== METRICS_PATH) {
      metrics.observe({
        method: request.method,
        route,
        statusCode: reply.statusCode,
        seconds: reply.elapsedTime / 1000,
        statements: scopeOf(request)?.statements,
        unavailable: unavailableCause(request),
      });
    }
    done();
  });
  app.get(METRICS_PATH, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    // Equal-length digests: the comparison takes the same time whatever was presented.
    if (!timingSafeEqual(digest(presentedToken(request)), expected)) {
      reply.status(401).header('www-authenticate', 'Bearer');
      return { error: 'UNAUTHENTICATED', message: 'A valid metrics token is required' };
    }
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return metrics.render(options.pool);
  });
  return metrics;
}
