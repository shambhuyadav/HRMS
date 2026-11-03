// Request deadlines and interactive transaction budgets (docs/09 §8.2, §13.2 item 3; NFR-S03, NFR-S10): every /v1
// route has a serving class; its transactions run with the class's statement and lock timeouts; a blocked lock or a
// passed deadline answers 503 UNAVAILABLE with Retry-After; work past the deadline starts nothing and commits nothing;
// logs of late handlers stay privacy-safe (NFR-S11). Synthetic data only.
import http from 'node:http';
import { Writable } from 'node:stream';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../db/tests/fixtures.js';
import { buildApp } from '../app.js';
import { devTokenVerifier } from '../auth/tokens.js';
import { instrumentDatabase } from '../db/instrument.js';
import { createPool } from '../db/pool.js';
import type { Queryable } from '../db/queryable.js';
import { withTransaction } from '../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../test/harness.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from './context.js';
import { DEFAULT_SERVING_BUDGETS, registerDeadlines, scopeOf, type ServingBudgetOverrides, servingBudgets, servingClassOf } from './deadline.js';
import { errorHandler, unavailableCause } from './errors.js';
import { loggerOptions } from './logging.js';

let h: Harness;
let A: Company;
let hr: TestActor;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Waits for a condition (a late handler's log line), so a loaded machine slows the test instead of failing it. */
const until = async (condition: () => boolean, ms = 20_000) => {
  for (const end = Date.now() + ms; !condition(); await sleep(50)) if (Date.now() > end) throw new Error('condition not reached');
};
/** How long the synthetic slow handlers keep working: well past the 300 ms deadline, so the answer clearly precedes them. */
const LATE_MS = 1_500;
const inject = (app: FastifyInstance, a: TestActor, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
  app.inject({
    method,
    url,
    ...(payload ? { payload } : {}),
    headers: { authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: a.company.id, [ASSIGNMENT_HEADER]: a.assignment },
  });
const settings = async (tx: Queryable) =>
  (await tx.query<{ statement: string; lock: string }>(`select current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`)).rows[0]!;
const users = async (key: string) => Number((await h.one<{ n: string }>(`select count(*) as n from user_account where account_key = $1`, [key])).n);
const expectUnavailable = (res: LightMyRequestResponse) => {
  expect(res.statusCode).toBe(503);
  expect(res.headers['retry-after']).toBe('5');
  expect(res.json()).toEqual({ error: 'UNAVAILABLE', message: 'The service is busy; retry shortly' });
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('serving classes and budgets', () => {
  it('every /v1 route of the API has a serving class; health checks and other paths have none', async () => {
    const app = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig) });
    const seen: { method: string; url: string; servingClass: string | undefined }[] = [];
    app.addHook('onRoute', (r) => {
      seen.push({ method: String(r.method), url: r.url, servingClass: r.config?.servingClass });
    });
    await app.ready();
    const v1 = seen.filter((r) => r.url.startsWith('/v1/'));
    expect(v1.length).toBeGreaterThan(100);
    expect(v1.filter((r) => r.servingClass === undefined)).toEqual([]);
    const classOf = (method: string, url: string) => v1.find((r) => r.method === method && r.url === url)?.servingClass;
    expect(classOf('GET', '/v1/employees/:id')).toBe('read');
    expect(classOf('PATCH', '/v1/employees/:id')).toBe('write');
    expect(classOf('POST', '/v1/employees/imports')).toBe('batch'); // a file body above the server limit
    expect(classOf('POST', '/v1/employees/imports/:id/commit')).toBe('batch'); // applies a DF09 batch
    // Work over a whole payroll run or a provider's pages, where a retry would repeat the same work, declares the class.
    const runWide = [
      ['POST', '/v1/payroll/runs/preview'],
      ['POST', '/v1/payroll/runs'],
      ['POST', '/v1/payroll/runs/:id/cancel'],
      ['GET', '/v1/payroll-outputs/runs/:id/bank-preview'],
      ['POST', '/v1/payroll-outputs/runs/:id/bank-manifests'],
      ['POST', '/v1/payroll-outputs/bank-manifests/:id/authorize'],
      ['POST', '/v1/payroll-outputs/bank-manifests/:id/issue'],
      ['POST', '/v1/payroll-outputs/bank-manifests/:id/outcomes'],
      ['POST', '/v1/payroll-outputs/runs/:id/loan-recoveries'],
      ['POST', '/v1/biometric/profiles/:id/runs'],
    ] as const;
    for (const [method, url] of runWide) expect(classOf(method, url), `${method} ${url}`).toBe('batch');
    expect(seen.filter((r) => !r.url.startsWith('/v1/') && r.servingClass !== undefined)).toEqual([]);
    await app.close();
  });

  it('a class follows the method, the body limit and the batch paths', () => {
    const limit = 1_048_576;
    expect(servingClassOf('GET', '/v1/employees', undefined, limit)).toBe('read');
    expect(servingClassOf('HEAD', '/v1/employees', undefined, limit)).toBe('read');
    expect(servingClassOf(['GET', 'HEAD'], '/v1/employees', undefined, limit)).toBe('read');
    expect(servingClassOf('POST', '/v1/employees', undefined, limit)).toBe('write');
    expect(servingClassOf(['GET', 'POST'], '/v1/x', undefined, limit)).toBe('write');
    expect(servingClassOf('POST', '/v1/expense/receipts', 14_680_064, limit)).toBe('batch');
    expect(servingClassOf('GET', '/v1/training-plans/export', undefined, limit)).toBe('batch');
    expect(servingClassOf('POST', '/v1/payroll/runs/:id/process', undefined, limit)).toBe('batch');
    expect(servingClassOf('POST', '/v1/payroll/runs/:id/processes', undefined, limit)).toBe('write');
  });

  it('budgets come from an override, else the environment, else the defaults; no timeout exceeds its deadline', () => {
    const names = ['HTTP_READ_DEADLINE_MS', 'DB_READ_STATEMENT_TIMEOUT_MS', 'DB_READ_LOCK_TIMEOUT_MS', 'HTTP_WRITE_DEADLINE_MS', 'DB_WRITE_STATEMENT_TIMEOUT_MS', 'DB_WRITE_LOCK_TIMEOUT_MS'];
    const saved = names.map((n) => [n, process.env[n]] as const);
    try {
      for (const n of names) delete process.env[n];
      expect(servingBudgets().read).toEqual(DEFAULT_SERVING_BUDGETS.read);
      process.env.HTTP_READ_DEADLINE_MS = '2500';
      process.env.DB_READ_LOCK_TIMEOUT_MS = '0'; // not a positive value: the default stays
      process.env.DB_WRITE_STATEMENT_TIMEOUT_MS = 'soon';
      const b = servingBudgets({ write: { deadlineMs: 1_000, statementTimeoutMs: 5_000, lockTimeoutMs: 9_000 } });
      expect(b.read).toEqual({ deadlineMs: 2_500, statementTimeoutMs: DEFAULT_SERVING_BUDGETS.read.statementTimeoutMs, lockTimeoutMs: DEFAULT_SERVING_BUDGETS.read.lockTimeoutMs });
      expect(b.write).toEqual({ deadlineMs: 1_000, statementTimeoutMs: 1_000, lockTimeoutMs: 1_000 });
      expect(() => servingBudgets({ read: { deadlineMs: 0 } })).toThrow(/positive whole number/);
      expect(() => servingBudgets({ batch: { lockTimeoutMs: 1.5 } })).toThrow(/positive whole number/);
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });
});

describe('the deadline mechanism (synthetic routes on the real pool)', () => {
  const budgets: ServingBudgetOverrides = {
    read: { deadlineMs: 300, statementTimeoutMs: 1_500, lockTimeoutMs: 700 },
    write: { deadlineMs: 300, statementTimeoutMs: 2_500, lockTimeoutMs: 1_100 },
    batch: { deadlineMs: 5_000, statementTimeoutMs: 2_500, lockTimeoutMs: 1_100 },
  };
  let lines: string[];
  const mechanismApp = (overrides: ServingBudgetOverrides) => {
    lines = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = Fastify({ logger: loggerOptions(stream) });
    app.setErrorHandler(errorHandler);
    registerDeadlines(app, servingBudgets(overrides));
    const db = instrumentDatabase(h.pool);
    app.get('/v1/settings', async () => withTransaction(db, settings));
    app.post('/v1/settings', async () => withTransaction(db, settings));
    app.post('/v1/declared', { config: { servingClass: 'batch' } }, async (request) => ({ budget: scopeOf(request)?.budget, ...(await withTransaction(db, settings)) }));
    app.get('/v1/slow-read', async () => {
      await db.query(`select pg_sleep(${LATE_MS / 1000})`); // outside a transaction: only the deadline bounds it
      await db.query('select 1');
      return { done: true };
    });
    app.post('/v1/slow-write', async (request) => {
      const { key } = request.body as { key: string };
      await withTransaction(db, async (tx) => {
        await tx.query(`insert into user_account (account_key, active) values ($1, true)`, [key]);
        await sleep(LATE_MS);
      });
      return { committed: true };
    });
    app.post('/v1/late', async () => {
      await sleep(LATE_MS);
      return { late: true };
    });
    app.get('/internal/unscoped', async (request) => ({ scoped: scopeOf(request) !== undefined, ...(await withTransaction(db, settings)) }));
    return app;
  };

  it('a read runs its transactions under the read budget and a write under the write budget; a declared class wins', async () => {
    const app = mechanismApp({ ...budgets, read: { deadlineMs: 5_000, statementTimeoutMs: 1_500, lockTimeoutMs: 700 }, write: { deadlineMs: 5_000, statementTimeoutMs: 2_500, lockTimeoutMs: 1_100 } });
    expect((await app.inject({ method: 'GET', url: '/v1/settings' })).json()).toEqual({ statement: '1500ms', lock: '700ms' });
    expect((await app.inject({ method: 'POST', url: '/v1/settings' })).json()).toEqual({ statement: '2500ms', lock: '1100ms' });
    expect((await app.inject({ method: 'POST', url: '/v1/declared' })).json()).toEqual({
      budget: { deadlineMs: 5_000, statementTimeoutMs: 2_500, lockTimeoutMs: 1_100 },
      statement: '2500ms',
      lock: '1100ms',
    });
    // Outside /v1 there is no unit of work: the pool's own connection settings apply.
    const unscoped = (await app.inject({ method: 'GET', url: '/internal/unscoped' })).json();
    expect(unscoped).toMatchObject({ scoped: false, lock: '0' });
    await app.close();
  });

  it('a request past its deadline is answered 503 with Retry-After, and its work stops at its next statement', async () => {
    const app = mechanismApp(budgets);
    const started = Date.now();
    const res = await app.inject({ method: 'GET', url: '/v1/slow-read?search=Synthetic%20Person' });
    const elapsed = Date.now() - started;
    expectUnavailable(res);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(LATE_MS - 100); // answered before the statement in flight finished
    // The handler resumes after pg_sleep: its next statement is refused, and Fastify logs the rejection.
    await until(() => lines.join('').includes('"type":"DeadlineExceeded"'));
    const text = lines.join('');
    for (const secret of ['Synthetic', 'search=', 'slow-read?']) expect(text).not.toContain(secret);
    await app.close();
  });

  it('a transaction still working at the deadline is rolled back, never committed', async () => {
    const app = mechanismApp(budgets);
    const key = uniq('deadline-write.');
    expectUnavailable(await app.inject({ method: 'POST', url: '/v1/slow-write', payload: { key } }));
    // Only once the handler has ended (its commit refused) does the count prove anything: an open insert is invisible.
    await until(() => lines.join('').includes('"type":"DeadlineExceeded"'));
    expect(await users(key)).toBe(0);
    await app.close();
  });

  it('a handler finishing after its deadline cannot answer twice, and the late result is logged without the URL', async () => {
    const app = mechanismApp(budgets);
    expectUnavailable(await app.inject({ method: 'POST', url: '/v1/late?search=Synthetic%20Person', payload: { a: 1 } }));
    await until(() => lines.join('').includes('FST_ERR_REP_ALREADY_SENT'));
    const text = lines.join('');
    expect(text).toContain('"msg":"FST_ERR_REP_ALREADY_SENT"');
    for (const secret of ['Synthetic', 'search=', '/v1/late?']) expect(text).not.toContain(secret);
    await app.close();
  });

  it('holds over a real socket for a request with a body (where Fastify 5.12 handlerTimeout would not fire)', async () => {
    const app = mechanismApp(budgets);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const { port } = app.server.address() as { port: number };
    const body = JSON.stringify({ a: 1 });
    const started = Date.now();
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/late', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.end(body);
    });
    expect(status).toBe(503);
    expect(Date.now() - started).toBeLessThan(LATE_MS - 100);
    await until(() => lines.join('').includes('FST_ERR_REP_ALREADY_SENT'));
    await app.close();
  });
});

describe('the API under tight budgets', () => {
  it('a statement blocked on a row lock fails fast with 503 and Retry-After; the same change succeeds once the lock is gone', async () => {
    // The lock timeout sits far below the statement timeout and the deadline, so this 503 can only be the lock wait's own.
    const app = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), serving: { write: { deadlineMs: 30_000, statementTimeoutMs: 20_000, lockTimeoutMs: 200 } } });
    const causes: (string | undefined)[] = [];
    app.addHook('onResponse', (request, _reply, done) => {
      causes.push(unavailableCause(request));
      done();
    });
    try {
      // The synthetic routes above left no connection checked out.
      expect(h.pool.totalCount - h.pool.idleCount).toBe(0);
      const created = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json() as { id: string; version: number };
      const holder = await h.pool.connect();
      try {
        // Booted, with a warm connection beside the holder's: on a loaded machine neither the app's first-request boot
        // nor a new database connection may stand in for the lock wait being measured.
        await app.ready();
        expect((await inject(app, hr, 'GET', `/v1/employees/${created.id}`)).statusCode).toBe(200);
        causes.length = 0;
        await holder.query('begin');
        await holder.query(`select 1 from employee where id = $1 for update`, [created.id]);
        const started = Date.now();
        const res = await inject(app, hr, 'PATCH', `/v1/employees/${created.id}`, { expectedVersion: created.version, displayName: 'Synthetic Renamed' });
        expectUnavailable(res);
        expect(causes).toEqual(['55P03']); // lock_timeout
        expect(Date.now() - started).toBeLessThan(10_000); // the 200 ms lock wait, not the 20 s statement timeout or the deadline
        expect(res.headers['cache-control']).toBe('no-store');
        expect(res.headers['x-request-id']).toBeTruthy();
      } finally {
        await holder.query('rollback').catch(() => undefined);
        holder.release();
      }
      const again = await inject(app, hr, 'PATCH', `/v1/employees/${created.id}`, { expectedVersion: created.version, displayName: 'Synthetic Renamed' });
      expect(again.statusCode).toBe(200);
      expect(again.json().displayName).toBe('Synthetic Renamed');
    } finally {
      await app.close();
    }
  });

  it('a request still waiting for a pool connection at its deadline answers 503 instead of waiting out the pool timeout', async () => {
    const small = createPool(h.pool.options.connectionString!, 1);
    small.on('error', () => undefined); // an idle connection the database ends is dropped by the pool, not a test failure
    const app = buildApp({ db: small, verifier: devTokenVerifier(tokenConfig), serving: { read: { deadlineMs: 600 } } });
    try {
      const held = await small.connect();
      try {
        await app.ready(); // the first request's boot is not part of the deadline being measured
        const started = Date.now();
        const res = await inject(app, hr, 'GET', '/v1/employees');
        expectUnavailable(res);
        expect(Date.now() - started).toBeGreaterThanOrEqual(500);
        expect(Date.now() - started).toBeLessThan(5_000); // the pool's own wait is 10 s
        expect(res.headers['cache-control']).toBe('no-store');
      } finally {
        held.release();
      }
    } finally {
      await app.close();
      await small.end(); // waits for the statement the answered request had queued
    }
  });
});
