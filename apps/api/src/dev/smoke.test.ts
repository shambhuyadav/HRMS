// End-to-end smoke over the development seed: dev sign-in, role selection, context, permissions and the main
// screens' endpoints for each seeded account, exactly as the web client calls them.
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { devTokenVerifier } from '../auth/tokens.js';
import { type Harness, startHarness, tokenConfig } from '../test/harness.js';
import { DEV_ACCOUNTS, seedDevCompany } from './seed.js';

let h: Harness;
let app: FastifyInstance;

beforeAll(async () => {
  h = await startHarness();
  await seedDevCompany(h.db);
  app = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), devLogin: tokenConfig });
});

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

async function signIn(accountKey: string, roleCode: string) {
  const login = await app.inject({ method: 'POST', url: '/dev/login', payload: { accountKey } });
  expect(login.statusCode).toBe(200);
  const { token, companies } = login.json();
  expect(companies).toHaveLength(1);
  const company = companies[0].id as string;
  const base = { authorization: `Bearer ${token}`, 'x-hrms-company': company };
  const assignments = (await app.inject({ method: 'GET', url: '/v1/me/assignments', headers: base })).json().items as { id: string; roleCode: string }[];
  const assignment = assignments.find((a) => a.roleCode === roleCode)!;
  const headers = { ...base, 'x-hrms-assignment': assignment.id };
  const get = async (url: string) => app.inject({ method: 'GET', url, headers });
  return { get, headers, company };
}

describe('development seed and UI endpoints', () => {
  it('rejects an unknown account', async () => {
    expect((await app.inject({ method: 'POST', url: '/dev/login', payload: { accountKey: 'nobody@demo.test' } })).statusCode).toBe(401);
  });

  it('employee: context, permissions, dashboard, leave balances and own claims', async () => {
    const s = await signIn(DEV_ACCOUNTS.employee, 'EMPLOYEE');
    const me = (await s.get('/v1/me/context')).json();
    expect(me).toMatchObject({ roleCode: 'EMPLOYEE', scopeKind: 'OWN', displayName: 'Eli Employee (synthetic)' });
    const perms = (await s.get('/v1/me/permissions')).json().permissions as string[];
    expect(perms).toContain('leave.submit.operational');
    // BRD v8.2 H1/BR-053: the Employee OWN context lists its own-ESS groups (own record only), nothing else confidential.
    expect(perms).toContain('employee.read.personal');
    expect(perms).not.toContain('employee.read.bank');
    expect((await s.get('/v1/dashboard')).json()).toMatchObject({ role: 'EMPLOYEE', state: 'OK' });
    expect((await s.get(`/v1/employees/${me.employeeId}/leave-balances`)).json().items.find((b: { leaveType: string }) => b.leaveType === 'ANNUAL').available).toBe('12.0000');
    expect((await s.get(`/v1/employees/${me.employeeId}/expense-claims`)).statusCode).toBe(200);
  });

  it('manager: My Team shows the two direct reports and the team dashboard reconciles', async () => {
    const s = await signIn(DEV_ACCOUNTS.manager, 'REPORTING_MANAGER');
    expect((await s.get('/v1/my-team')).json().total).toBe(2);
    const widgets = (await s.get('/v1/dashboard')).json().widgets as { code: string; value?: number }[];
    expect(widgets.find((w) => w.code === 'TEAM_COUNT')?.value).toBe(2);
  });

  it('HR: employees list, report catalogue; finance: expense tasks queue', async () => {
    const hr = await signIn(DEV_ACCOUNTS.hr, 'HR_ADMINISTRATOR');
    expect((await hr.get('/v1/employees')).json().total).toBe(3);
    expect((await hr.get('/v1/reports/catalogue')).json().items.length).toBeGreaterThan(3);
    const finance = await signIn(DEV_ACCOUNTS.finance, 'HR_ADMINISTRATOR');
    expect((await finance.get('/v1/expense/tasks')).statusCode).toBe(200);
  });

  it('seeding twice is a no-op', async () => {
    const before = Number((await h.one<{ n: string }>(`select count(*) as n from employee`)).n);
    await seedDevCompany(h.db);
    expect(Number((await h.one<{ n: string }>(`select count(*) as n from employee`)).n)).toBe(before);
  });
});
