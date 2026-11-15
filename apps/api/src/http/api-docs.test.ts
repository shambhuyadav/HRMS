// The OpenAPI description (improvement plan H1): generated from the routes' own schemas, served at /docs/json and /docs when asked
// for, and absent by default in tests and production. No database is needed to describe the routes.
import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { devTokenVerifier } from '../auth/tokens.js';
import type { Database } from '../db/transaction.js';
import { tokenConfig } from '../test/harness.js';
import { apiDocsEnabled } from './api-docs.js';

const noDatabase = {
  query: async () => {
    throw new Error('no database in this test');
  },
  connect: async () => {
    throw new Error('no database in this test');
  },
} as unknown as Database;

const apps: ReturnType<typeof buildApp>[] = [];
afterAll(async () => {
  await Promise.all(apps.map((a) => a.close()));
});

describe('API description (H1)', () => {
  it('describes every /v1 route from its schema, with the session scheme', async () => {
    const app = buildApp({ db: noDatabase, verifier: devTokenVerifier(tokenConfig), apiDocs: true });
    apps.push(app);
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
    const spec = res.json() as { openapi: string; paths: Record<string, Record<string, unknown>>; components: { securitySchemes: Record<string, unknown> } };
    expect(spec.openapi).toBe('3.0.3');
    const paths = Object.keys(spec.paths);
    expect(paths.filter((p) => p.startsWith('/v1/')).length).toBeGreaterThan(300);
    expect(paths).toContain('/v1/access/accounts');
    expect(spec.components.securitySchemes.session).toEqual({ type: 'http', scheme: 'bearer' });
    expect((await app.inject({ method: 'GET', url: '/docs' })).statusCode).toBeLessThan(400);
  });

  it('is not served unless asked for, and is off by default in production and tests', async () => {
    const app = buildApp({ db: noDatabase, verifier: devTokenVerifier(tokenConfig), apiDocs: false });
    apps.push(app);
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
    expect(apiDocsEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(apiDocsEnabled({ NODE_ENV: 'production', HRMS_API_DOCS: 'on' })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'development' })).toBe(true);
    expect(apiDocsEnabled({ NODE_ENV: 'development', HRMS_API_DOCS: 'off' })).toBe(false);
    expect(apiDocsEnabled({ VITEST: 'true' })).toBe(false);
  });
});
