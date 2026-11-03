// Error mapping over HTTP: framework client errors keep their status instead of becoming 500; overload is a retryable
// 503; API answers are never stored by caches; request logs stay privacy-safe. Synthetic data only.
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../test/harness.js';
import { errorHandler } from './errors.js';
import { loggerOptions } from './logging.js';

let h: Harness;
let A: Company;
let hr: TestActor;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
});

afterAll(async () => {
  await h?.stop();
});

describe('request ids and readiness (G3)', () => {
  it('returns a request id: a well-formed inbound one is kept, anything else replaced', async () => {
    const kept = await h.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'trace-12345678' } });
    expect(kept.headers['x-request-id']).toBe('trace-12345678');
    const replaced = await h.app.inject({ method: 'GET', url: '/health', headers: { 'x-request-id': 'bad id <script>' } });
    expect(replaced.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('reports readiness when the database answers, without details', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ready' });
  });
});

describe('error responses', () => {
  it('answers a body over the limit with 413, not 500', async () => {
    const res = await h.call(hr, 'POST', '/v1/employees', { displayName: 'x'.repeat(1_100_000) });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toEqual({ error: 'PAYLOAD_TOO_LARGE', message: 'The request is larger than this endpoint accepts' });
  });

  it('answers malformed JSON with 400', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/employees',
      payload: '{"displayName": ',
      headers: { authorization: `Bearer ${hr.token}`, 'content-type': 'application/json', 'x-hrms-company': A.id, 'x-hrms-assignment': hr.assignment },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('INVALID_REQUEST');
  });

  it('marks every API answer no-store, success or failure, and leaves health checks alone', async () => {
    expect((await h.call(hr, 'GET', '/v1/me/context')).headers['cache-control']).toBe('no-store');
    expect((await h.call(hr, 'GET', '/v1/employees/00000000-0000-4000-8000-000000000000')).headers['cache-control']).toBe('no-store');
    expect((await h.app.inject({ method: 'GET', url: '/health' })).headers['cache-control']).toBeUndefined();
  });
});

describe('overload and a lost database (NFR-S10)', () => {
  const failingWith = (error: Error) => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    app.get('/x', async () => {
      throw error;
    });
    return app;
  };

  it.each([
    ['a statement timeout', Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })],
    ['a lock timeout', Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })],
    ['too many connections', Object.assign(new Error('sorry, too many clients already'), { code: '53300' })],
    ['the pool wait timeout', new Error('timeout exceeded when trying to connect')],
    ['a dropped connection', new Error('Connection terminated unexpectedly')],
    ['a database that refuses connections', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
    ['a connection reset by the network', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
  ])('answers %s with a retryable 503 that names no cause', async (_case, error) => {
    const app = failingWith(error);
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(503);
    expect(res.headers['retry-after']).toBe('5');
    expect(res.json()).toEqual({ error: 'UNAVAILABLE', message: 'The service is busy; retry shortly' });
    await app.close();
  });

  it('keeps any other failure a 500 without detail', async () => {
    const app = failingWith(Object.assign(new Error('synthetic failure'), { code: 'XX000', detail: 'Key (code)=(SYNTHETIC) internal' }));
    const res = await app.inject({ method: 'GET', url: '/x' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: 'INTERNAL', message: 'Unexpected error' });
    await app.close();
  });
});

describe('request logs (NFR-S11)', () => {
  it('record the route pattern, never the raw URL, search terms, tokens, row values or the client address', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = Fastify({ logger: loggerOptions(stream) });
    app.setErrorHandler(errorHandler);
    app.get('/v1/people/:id', async () => ({ ok: true }));
    app.get('/v1/broken', async () => {
      throw Object.assign(new Error('synthetic failure'), { code: 'XX000', detail: 'Key (code)=(SYNTHETIC-ROW-VALUE) internal' });
    });
    await app.inject({ method: 'GET', url: '/v1/people/person-7?search=Synthetic%20Person', headers: { authorization: 'Bearer synthetic-token' } });
    await app.inject({ method: 'GET', url: '/v1/broken?search=Synthetic%20Person' });
    // Fastify's default 404 handler names the raw URL in its log message: the message is kept without it.
    expect((await app.inject({ method: 'GET', url: '/v1/nowhere/person-7?search=Synthetic%20Person' })).statusCode).toBe(404);
    await app.close();
    const text = lines.join('');
    expect(text).toContain('"route":"/v1/people/:id"');
    expect(text).toContain('"route":"/v1/broken"');
    expect(text).toContain('unhandled error');
    expect(text).toContain('"msg":"Route not found"');
    for (const secret of ['Synthetic', 'person-7', 'synthetic-token', 'SYNTHETIC-ROW-VALUE', 'remoteAddress', '127.0.0.1']) expect(text).not.toContain(secret);
  });
});
