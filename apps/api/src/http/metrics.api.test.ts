// The internal metrics endpoint (docs/09 §10.2, §13.2 item 2; NFR-S05, NFR-S11): not registered without a configured
// token, refused without that token, and when served its counters move with requests while every label is a route
// pattern, method, status class or cause: never an id, a search term or a token. Synthetic data only.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { devTokenVerifier } from '../auth/tokens.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../test/harness.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from './context.js';
import { METRICS_PATH, ServingMetrics } from './metrics.js';

let h: Harness;
let A: Company;
let hr: TestActor;
/** Generated for this run only; never a stored credential. */
const token = randomBytes(32).toString('base64url');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const verifier = () => devTokenVerifier(tokenConfig);

const headersOf = (a: TestActor) => ({ authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: a.company.id, [ASSIGNMENT_HEADER]: a.assignment });
const withoutEnvToken = <T>(build: () => T): T => {
  const saved = process.env.HRMS_METRICS_TOKEN;
  delete process.env.HRMS_METRICS_TOKEN;
  try {
    return build();
  } finally {
    if (saved !== undefined) process.env.HRMS_METRICS_TOKEN = saved;
  }
};
/** The value of the sample with exactly these labels, or undefined. */
const sample = (text: string, name: string, labels: string) => {
  const line = text.split('\n').find((l) => l.startsWith(`${name}{${labels}} `));
  return line === undefined ? undefined : Number(line.slice(line.lastIndexOf(' ') + 1));
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('exposure', () => {
  it('is not registered unless a metrics token is configured', async () => {
    const app = withoutEnvToken(() => buildApp({ db: h.pool, verifier: verifier() }));
    expect((await app.inject({ method: 'GET', url: METRICS_PATH })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: METRICS_PATH, headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(404);
    await app.close();
  });

  it('refuses to start with a token shorter than 32 characters', () => {
    expect(() => buildApp({ db: h.pool, verifier: verifier(), metricsToken: 'synthetic-short-token' })).toThrow(/at least 32 characters/);
  });

  it('answers only the configured bearer token, and no cache may store the answer', async () => {
    const app = buildApp({ db: h.pool, verifier: verifier(), metricsToken: token });
    const refused: Record<string, string>[] = [
      {},
      { authorization: 'Bearer ' },
      { authorization: `Bearer ${token}x` },
      { authorization: `Bearer ${token.slice(1)}` },
      { authorization: token },
      { authorization: `Basic ${token}` },
      headersOf(hr), // a user's API token is not the metrics token
    ];
    for (const headers of refused) {
      const res = await app.inject({ method: 'GET', url: METRICS_PATH, headers });
      expect(res.statusCode).toBe(401);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).not.toContain('hrms_');
    }
    const ok = await app.inject({ method: 'GET', url: METRICS_PATH, headers: { authorization: `Bearer ${token}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toMatch(/^text\/plain; version=0\.0\.4/);
    expect(ok.headers['cache-control']).toBe('no-store');
    await app.close();
  });
});

describe('causes of retryable answers', () => {
  it('names an unreachable database as a connection failure, whether a SQLSTATE or a socket error says so', () => {
    const metrics = new ServingMetrics();
    const refused = (unavailable: string) => metrics.observe({ method: 'GET', route: '/v1/x', statusCode: 503, seconds: 0.01, statements: 0, unavailable });
    refused('08006');
    refused('ECONNREFUSED');
    expect(sample(metrics.render(undefined), 'hrms_http_unavailable_total', 'route="/v1/x",cause="connection"')).toBe(2);
  });
});

describe('content', () => {
  let app: FastifyInstance;
  const scrape = async () => (await app.inject({ method: 'GET', url: METRICS_PATH, headers: { authorization: `Bearer ${token}` } })).body;

  it('counters move by route pattern and status class, with statement and pool counts; labels carry no ids', async () => {
    // Generous deadlines (a loaded test machine must not turn a counted 2xx into a 503) and a short lock wait for the refusal below.
    const serving = { read: { deadlineMs: 60_000, statementTimeoutMs: 15_000 }, write: { deadlineMs: 60_000, statementTimeoutMs: 15_000, lockTimeoutMs: 200 } };
    app = buildApp({ db: h.pool, verifier: verifier(), metricsToken: token, serving });
    const created = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json() as { id: string; version: number };
    const read = (id: string) => app.inject({ method: 'GET', url: `/v1/employees/${id}?search=Synthetic%20Person`, headers: headersOf(hr) });
    expect((await read(created.id)).statusCode).toBe(200);
    expect((await read(created.id)).statusCode).toBe(200);
    expect((await read('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/no-such-route/${created.id}`, headers: headersOf(hr) })).statusCode).toBe(404);

    const ok = 'method="GET",route="/v1/employees/:id",status_class="2xx"';
    const first = await scrape();
    expect(sample(first, 'hrms_http_requests_total', ok)).toBe(2);
    expect(sample(first, 'hrms_http_requests_total', 'method="GET",route="/v1/employees/:id",status_class="4xx"')).toBe(1);
    expect(sample(first, 'hrms_http_requests_total', 'method="GET",route="UNMATCHED",status_class="4xx"')).toBe(1);
    expect(sample(first, 'hrms_http_request_duration_seconds_count', ok)).toBe(2);
    expect(sample(first, 'hrms_http_request_duration_seconds_bucket', `${ok},le="+Inf"`)).toBe(2);
    expect(sample(first, 'hrms_http_request_duration_seconds_sum', ok)).toBeGreaterThan(0);
    // Statements per request: the session check, the access check and the read, transaction control included.
    expect(sample(first, 'hrms_http_request_statements_count', ok)).toBe(2);
    expect(sample(first, 'hrms_http_request_statements_sum', ok)).toBeGreaterThanOrEqual(4);
    expect(sample(first, 'hrms_db_pool_connections', 'state="total"')).toBeGreaterThanOrEqual(1);
    expect(sample(first, 'hrms_db_pool_connections', 'state="idle"')).toBeGreaterThanOrEqual(0);
    expect(sample(first, 'hrms_db_pool_connections', 'state="waiting"')).toBe(0);

    await read(created.id);
    expect(sample(await scrape(), 'hrms_http_requests_total', ok)).toBe(3);

    // A retryable refusal is counted with its cause.
    const holder = await h.pool.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from employee where id = $1 for update`, [created.id]);
      const res = await app.inject({ method: 'PATCH', url: `/v1/employees/${created.id}`, payload: { expectedVersion: created.version, displayName: 'Synthetic Renamed' }, headers: headersOf(hr) });
      expect(res.statusCode).toBe(503);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    const last = await scrape();
    expect(sample(last, 'hrms_http_unavailable_total', 'route="/v1/employees/:id",cause="lock_timeout"')).toBe(1);
    expect(sample(last, 'hrms_http_requests_total', 'method="PATCH",route="/v1/employees/:id",status_class="5xx"')).toBe(1);

    // Labels are route patterns, methods, status classes, causes and pool states only.
    for (const secret of [created.id, A.id, hr.user, hr.assignment, hr.token, token, 'Synthetic', 'search']) expect(last).not.toContain(secret);
    expect(last).not.toMatch(UUID);
    const routes = [...last.matchAll(/route="([^"]*)"/g)].map((m) => m[1]!);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.filter((r) => r !== 'UNMATCHED' && !r.startsWith('/v1/'))).toEqual([]);
    const labelNames = new Set([...last.matchAll(/[{,]([a-z_]+)="/g)].map((m) => m[1]!));
    expect([...labelNames].sort()).toEqual(['cause', 'le', 'method', 'route', 'state', 'status_class']);
    // The scrape itself is not counted as a request.
    expect(last).not.toContain(`route="${METRICS_PATH}"`);
    await app.close();
  });
});
