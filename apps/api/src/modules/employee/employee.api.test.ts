// Employee API tests: real HTTP handling (Fastify inject), real tokens, real PostgreSQL. Synthetic data.
// Covers FR-006/007/008, BR-001/044, ZT01/02/03/05/07/12/29 at the API surface.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { issueDevToken } from '../../auth/tokens.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { type Company, type Harness, startHarness, type TestActor as Actor, tokenConfig } from '../../test/harness.js';

let h: Harness;
let db: pg.Client;
let app: FastifyInstance;

const one = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => h.one<T>(sql, params);
const actor = (...args: Parameters<Harness['actor']>) => h.actor(...args);
const call = (...args: Parameters<Harness['call']>) => h.call(...args);
const newEmployeeBody = (...args: Parameters<Harness['newEmployeeBody']>) => h.newEmployeeBody(...args);
const sessionFor = async (userId: string) =>
  (await one<{ id: string }>(`insert into user_session (user_id, expires_at) values ($1, now() + interval '1 hour') returning id`, [userId])).id;

let A: Company;
let B: Company;
let hr: Actor;
let hrWithPersonal: Actor;

beforeAll(async () => {
  h = await startHarness();
  db = h.db;
  app = h.app;
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await actor(A, 'HR_ADMINISTRATOR');
  hrWithPersonal = await actor(A, 'HR_ADMINISTRATOR', { extra: ['employee.create.personal', 'employee.read.personal', 'employee.update.personal'] });
});

afterAll(async () => {
  await h?.stop();
});
describe('authentication and context', () => {
  it('rejects a missing or forged token and missing context', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/employees' })).statusCode).toBe(401);
    const forged = await issueDevToken({ ...tokenConfig, secret: 'a-different-secret-0123456789abcdef' }, hr.user, await sessionFor(hr.user));
    const res = await app.inject({
      method: 'GET',
      url: '/v1/employees',
      headers: { authorization: `Bearer ${forged}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: hr.assignment },
    });
    expect(res.statusCode).toBe(401);
    const noContext = await app.inject({ method: 'GET', url: '/v1/employees', headers: { authorization: `Bearer ${hr.token}` } });
    expect(noContext.statusCode).toBe(400);
  });

  it('rejects tokens longer than the 12-hour absolute session', async () => {
    const long = await issueDevToken(tokenConfig, hr.user, await sessionFor(hr.user), 13 * 3600);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/employees',
      headers: { authorization: `Bearer ${long}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: hr.assignment },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('create and update (FR-006, BR-001, ZT07, ZT12)', () => {
  it('creates a DRAFT employee with assignment, audit and outbox event in one transaction', async () => {
    const body = newEmployeeBody(A, { employeeCode: ' syn-001 ' });
    const res = await call(hr, 'POST', '/v1/employees', body);
    expect(res.statusCode).toBe(201);
    const created = res.json();
    expect(created).toMatchObject({ employeeCode: 'SYN-001', status: 'DRAFT', assignment: { departmentId: A.dept } });

    const audit = await one<{ n: string }>(`select count(*) as n from audit_event where record_key = $1 and action = 'CREATE'`, [created.id]);
    const outbox = await one<{ n: string }>(`select count(*) as n from outbox_event where aggregate_id = $1 and topic = 'employee.created'`, [created.id]);
    expect(Number(audit.n)).toBe(1);
    expect(Number(outbox.n)).toBe(1);

    expect((await call(hr, 'POST', '/v1/employees', newEmployeeBody(A, { employeeCode: 'SYN-001' }))).statusCode).toBe(409);
  });

  it('refuses personal fields without a personal grant and audits the denial', async () => {
    const res = await call(hr, 'POST', '/v1/employees', newEmployeeBody(A, { dateOfBirth: '1990-04-02' }));
    expect(res.statusCode).toBe(403);
    const denial = await one<{ n: string }>(
      `select count(*) as n from audit_event where actor_user_id = $1 and action = 'ACCESS_DENIED' and resource_code = 'employee'`,
      [hr.user],
    );
    expect(Number(denial.n)).toBeGreaterThan(0);
  });

  it('rejects an inactive department and an unknown master', async () => {
    const inactive = (
      await one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, 'Old', false) returning id`, [A.id, uniq('OLD')])
    ).id;
    expect((await call(hr, 'POST', '/v1/employees', newEmployeeBody(A, { departmentId: inactive }))).statusCode).toBe(422);
    expect((await call(hr, 'POST', '/v1/employees', newEmployeeBody(A, { departmentId: B.dept }))).statusCode).toBe(422);
  });

  it('updates with optimistic concurrency and records before/after', async () => {
    const created = (await call(hr, 'POST', '/v1/employees', newEmployeeBody(A))).json();
    const stale = await call(hr, 'PATCH', `/v1/employees/${created.id}`, { expectedVersion: created.version + 5, displayName: 'Renamed' });
    expect(stale.statusCode).toBe(409);
    const ok = await call(hr, 'PATCH', `/v1/employees/${created.id}`, { expectedVersion: created.version, displayName: 'Renamed' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ displayName: 'Renamed', version: created.version + 1 });
    const audit = await one<{ before_values: object; after_values: object }>(
      `select before_values, after_values from audit_event where record_key = $1 and action = 'UPDATE'`,
      [created.id],
    );
    expect(audit.before_values).toEqual({ operational: { displayName: 'Synthetic Person' } });
    expect(audit.after_values).toEqual({ operational: { displayName: 'Renamed' } });
  });

  it('respects department filters on creation', async () => {
    const financeOnly = await actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    expect((await call(financeOnly, 'POST', '/v1/employees', newEmployeeBody(A))).statusCode).toBe(403);
    expect((await call(financeOnly, 'POST', '/v1/employees', newEmployeeBody(A, { departmentId: A.financeDept }))).statusCode).toBe(201);
  });
});

describe('scoped reads and confidentiality (ZT01, ZT02, ZT03, ZT29)', () => {
  let managerEmp: string;
  let reportEmp: string;
  let unrelatedEmp: string;
  let manager: Actor;

  beforeAll(async () => {
    const create = async (overrides = {}) => (await call(hrWithPersonal, 'POST', '/v1/employees', newEmployeeBody(A, overrides))).json();
    managerEmp = (await create()).id;
    reportEmp = (await create({ dateOfBirth: '1991-07-14' })).id;
    unrelatedEmp = (await create()).id;
    await db.query(
      `insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from) values ($1, $2, $3, '2026-01-05')`,
      [A.id, reportEmp, managerEmp],
    );
    manager = await actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  });

  it('HR with a personal grant sees personal fields; HR without one does not receive the keys', async () => {
    expect((await call(hrWithPersonal, 'GET', `/v1/employees/${reportEmp}`)).json()).toMatchObject({ dateOfBirth: '1991-07-14' });
    const plain = (await call(hr, 'GET', `/v1/employees/${reportEmp}`)).json();
    expect(plain).not.toHaveProperty('dateOfBirth');
    expect(plain).not.toHaveProperty('serviceAnniversaryDate');
  });

  it('manager lists and reads only current direct reports, without personal fields by default', async () => {
    const list = (await call(manager, 'GET', '/v1/employees')).json();
    expect(list.items.map((e: { id: string }) => e.id)).toEqual([reportEmp]);
    expect(list.total).toBe(1);
    const detail = (await call(manager, 'GET', `/v1/employees/${reportEmp}`)).json();
    expect(detail.manager).toMatchObject({ id: managerEmp });
    expect(detail).not.toHaveProperty('dateOfBirth');
    expect((await call(manager, 'GET', `/v1/employees/${unrelatedEmp}`)).statusCode).toBe(404);
  });

  it('employee reads only their own record and cannot list', async () => {
    const self = await actor(A, 'EMPLOYEE', { employeeId: reportEmp });
    const own = await call(self, 'GET', `/v1/employees/${reportEmp}`);
    expect(own.statusCode).toBe(200);
    // BRD v8.2 H1/BR-053: the Employee OWN context includes the employee's own permitted private values ...
    expect(own.json()).toHaveProperty('dateOfBirth');
    // ... while other people's private values still need an eligible Admin/Manager grant (HR default duties: none).
    expect((await call(hr, 'GET', `/v1/employees/${reportEmp}`)).json()).not.toHaveProperty('dateOfBirth');
    expect((await call(self, 'GET', `/v1/employees/${managerEmp}`)).statusCode).toBe(404);
    expect((await call(self, 'GET', '/v1/employees')).statusCode).toBe(403);
  });

  it('cross-company identifiers return 404, and an assignment cannot be replayed in another company', async () => {
    const hrB = await actor(B, 'HR_ADMINISTRATOR');
    expect((await call(hrB, 'GET', `/v1/employees/${reportEmp}`)).statusCode).toBe(404);
    const replay = await app.inject({
      method: 'GET',
      url: '/v1/employees',
      headers: { authorization: `Bearer ${hr.token}`, [COMPANY_HEADER]: B.id, [ASSIGNMENT_HEADER]: hr.assignment },
    });
    expect(replay.statusCode).toBe(403);
  });

  it('a revoked assignment is denied on the next request (ZT05)', async () => {
    const temp = await actor(A, 'HR_ADMINISTRATOR');
    expect((await call(temp, 'GET', '/v1/employees')).statusCode).toBe(200);
    await db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic revocation' where id = $1`, [temp.assignment]);
    expect((await call(temp, 'GET', '/v1/employees')).statusCode).toBe(403);
  });

  it('search filters within scope and escapes wildcards', async () => {
    const res = (await call(hr, 'GET', '/v1/employees?search=%25&pageSize=25')).json();
    expect(res.total).toBe(0);
    expect((await call(hr, 'GET', '/v1/employees?pageSize=7')).statusCode).toBe(400);
  });
});