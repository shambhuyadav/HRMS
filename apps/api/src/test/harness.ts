// Shared API test harness: disposable PostgreSQL, real pool, the real app, provisioned synthetic companies
// and actors whose assignments are created and approved directly (so tests start from a known state).
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type pg from 'pg';
import { uniq } from '../../../../db/tests/fixtures.js';
import { startTestDatabase, type TestDatabase } from '../../../../db/tests/test-database.js';
import { buildApp } from '../app.js';
import { type DevTokenConfig, devTokenVerifier, issueDevToken } from '../auth/tokens.js';
import { createPool } from '../db/pool.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../http/context.js';
import type { ScopeKind } from '../modules/access/authorize.js';
import { BASELINE_ROLES, type PermissionKey, parsePermissionKey } from '../modules/access/baseline.js';
import { provisionCompany } from '../modules/access/provision.js';
import { type BulkRunOptions, runBulkJobs } from '../modules/bulk/service.js';

export const tokenConfig: DevTokenConfig = { issuer: 'hrms-test', audience: 'hrms-api', secret: 'test-only-secret-0123456789abcdef0123' };

export interface Company {
  id: string;
  dept: string;
  financeDept: string;
  loc: string;
  desig: string;
}

export interface TestActor {
  user: string;
  assignment: string;
  token: string;
  company: Company;
}

export interface ActorOptions {
  extra?: PermissionKey[];
  employeeId?: string;
  departmentFilter?: string;
  /** LOCATION row-scope filters (values OR within the dimension; dimensions AND, BR-006). */
  locationFilter?: string | string[];
  user?: string;
  /** Another scope kind C2 allows the role; the database refuses one it does not. Defaults to the role's default. */
  scope?: ScopeKind;
  /** Replaces the role's default duties (`extra` still adds to it). */
  duties?: PermissionKey[];
}

export interface Harness {
  /**
   * The test's own connection. It is a grant bootstrap session (migration 0099), so fixtures can create and adjust grants
   * directly; the app's pool is not, and a test of the grant guards writes through `pool` or a client of its own.
   */
  db: pg.Client;
  /** Pool shared with the app, for running workers (e.g. the outbox dispatcher) in tests. */
  pool: pg.Pool;
  app: FastifyInstance;
  one<T extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<T>;
  makeUser(): Promise<string>;
  tokenFor(userId: string, lifetimeSeconds?: number): Promise<string>;
  makeCompany(): Promise<Company>;
  actor(company: Company, roleCode: string, opts?: ActorOptions): Promise<TestActor>;
  /** An actor in a company-specific role that C2 does not name (so any scope kind is allowed), holding exactly `permissions`. */
  customActor(company: Company, opts: { scope: ScopeKind; permissions: PermissionKey[] }): Promise<TestActor>;
  call(a: TestActor, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object): Promise<LightMyRequestResponse>;
  newEmployeeBody(c: Company, overrides?: Record<string, unknown>): Record<string, unknown>;
  setStatus(company: Company, employeeId: string, status: string): Promise<void>;
  /**
   * NFR-S09 bulk job: enqueues through the API (expects 202), runs the worker step until the job ends and returns the
   * job as its requester reads it (GET /v1/bulk-jobs/:id). Throws unless the job COMPLETED.
   */
  runBulkJob(a: TestActor, url: string, payload: object, options?: BulkRunOptions): Promise<BulkJobResult>;
  stop(): Promise<void>;
}

/** A finished bulk job as GET /v1/bulk-jobs/:id shows it; `result` carries what the synchronous answer had. */
export interface BulkJobResult {
  id: string;
  state: string;
  processed: number;
  /** Untyped, like LightMyRequestResponse.json(). */
  result: any;
  errorCode: string | null;
}

/**
 * Serving budgets of the harness app: the pool's 15 s statement timeout, lock waits bounded by it and a deadline past
 * the 60 s test timeout, as before request deadlines existed. Business tests run on shared, loaded machines and must
 * not fail on a slow moment; http/deadline.api.test.ts tests the budgets and their defaults themselves.
 */
const HARNESS_SERVING = { deadlineMs: 120_000, statementTimeoutMs: 15_000, lockTimeoutMs: 15_000 };

export async function startHarness(): Promise<Harness> {
  const testDb: TestDatabase = await startTestDatabase();
  const db = testDb.client;
  await db.query(`select set_config('hrms.grant_bootstrap', 'on', false)`);
  const pool = createPool(testDb.connectionString, 4);
  const app = buildApp({ db: pool, verifier: devTokenVerifier(tokenConfig), serving: { read: HARNESS_SERVING, write: HARNESS_SERVING, batch: HARNESS_SERVING } });

  const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
    const row = (await db.query<T>(sql, params)).rows[0];
    if (!row) throw new Error(`No row: ${sql}`);
    return row;
  };
  const makeUser = async () =>
    (await one<{ id: string }>(`insert into user_account (account_key, active) values ($1, true) returning id`, [uniq('user.')])).id;

  async function makeCompany(): Promise<Company> {
    const approver = await makeUser();
    const id = (await one<{ id: string }>(`insert into company (code, name, active) values ($1, $1, true) returning id`, [uniq('CO')])).id;
    await provisionCompany(db, { companyId: id, approvedBy: approver, effectiveFrom: '2026-01-01' });
    const master = async (table: string, code: string) =>
      (await one<{ id: string }>(`insert into ${table} (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [id, code])).id;
    return {
      id,
      dept: await master('department', 'ENG'),
      financeDept: await master('department', 'FIN'),
      loc: await master('location', 'HQ'),
      desig: await master('designation', 'DEV'),
    };
  }

  async function actor(company: Company, roleCode: string, opts: ActorOptions = {}): Promise<TestActor> {
    const role = BASELINE_ROLES.find((r) => r.code === roleCode);
    if (!role) throw new Error(`Unknown baseline role ${roleCode}`);
    const user = opts.user ?? (await makeUser());
    const approver = await makeUser();
    if (opts.employeeId) {
      await db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from) values ($1, $2, $3, '2026-01-01')`, [
        company.id,
        user,
        opts.employeeId,
      ]);
    }
    const assignment = (
      await one<{ id: string }>(
        `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at)
         select $1, $2, r.id, $4, '2026-01-01T00:00:00Z', 'ACTIVE', $5, now() from role r where r.company_id = $1 and r.code = $3
         returning id`,
        [company.id, user, roleCode, opts.scope ?? role.defaultScope, approver],
      )
    ).id;
    for (const key of [...(opts.duties ?? role.defaultDuties), ...(opts.extra ?? [])]) {
      const { resource, action, fieldGroup } = parsePermissionKey(key);
      await db.query(
        `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from)
         select $1, $2, p.id, true, '2026-01-01T00:00:00Z' from permission p where p.resource = $3 and p.action = $4 and p.field_group = $5`,
        [company.id, assignment, resource, action, fieldGroup],
      );
    }
    if (opts.departmentFilter) {
      await db.query(
        `insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`,
        [company.id, assignment, opts.departmentFilter],
      );
    }
    for (const location of [opts.locationFilter ?? []].flat()) {
      await db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, location_id) values ($1, $2, 'LOCATION', $3)`, [company.id, assignment, location]);
    }
    return { user, assignment, token: await tokenFor(user), company };
  }

  async function customActor(company: Company, opts: { scope: ScopeKind; permissions: PermissionKey[] }): Promise<TestActor> {
    const roleId = (await one<{ id: string }>(`insert into role (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [company.id, uniq('CUSTOM_ROLE_').toUpperCase()])).id;
    const user = await makeUser();
    const approver = await makeUser();
    const assignment = (
      await one<{ id: string }>(
        `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at)
         values ($1, $2, $3, $4, '2026-01-01T00:00:00Z', 'ACTIVE', $5, now()) returning id`,
        [company.id, user, roleId, opts.scope, approver],
      )
    ).id;
    for (const key of opts.permissions) {
      const { resource, action, fieldGroup } = parsePermissionKey(key);
      const permission = (await one<{ id: string }>(`select id from permission where resource = $1 and action = $2 and field_group = $3`, [resource, action, fieldGroup])).id;
      await db.query(`insert into role_permission (company_id, role_id, permission_id, effect) values ($1, $2, $3, 'ALLOW')`, [company.id, roleId, permission]);
      await db.query(`insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from) values ($1, $2, $3, true, '2026-01-01T00:00:00Z')`, [
        company.id,
        assignment,
        permission,
      ]);
    }
    return { user, assignment, token: await tokenFor(user), company };
  }

  /** Creates a server-side session (DF10) and a token bound to it. */
  async function tokenFor(userId: string, lifetimeSeconds = 3600): Promise<string> {
    const sid = (
      await one<{ id: string }>(`insert into user_session (user_id, expires_at) values ($1, now() + make_interval(secs => $2)) returning id`, [
        userId,
        Math.min(lifetimeSeconds, 12 * 3600),
      ])
    ).id;
    return issueDevToken(tokenConfig, userId, sid, lifetimeSeconds);
  }

  const call = (a: TestActor, method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      ...(payload ? { payload } : {}),
      headers: { authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: a.company.id, [ASSIGNMENT_HEADER]: a.assignment },
    });

  const newEmployeeBody = (c: Company, overrides: Record<string, unknown> = {}) => ({
    employeeCode: uniq('emp'),
    displayName: 'Synthetic Person',
    workEmail: `${uniq('person')}@example.test`,
    joiningDate: '2026-01-05',
    employmentType: 'PERMANENT',
    departmentId: c.dept,
    locationId: c.loc,
    designationId: c.desig,
    ...overrides,
  });

  // Lifecycle transitions are not built yet; tests set status directly to reach a known state.
  const setStatus = async (company: Company, employeeId: string, status: string) => {
    await db.query(
      `update employee set status_id = (select id from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' and code = $3)
        where company_id = $1 and id = $2`,
      [company.id, employeeId, status],
    );
  };

  async function runBulkJob(a: TestActor, url: string, payload: object, options: BulkRunOptions = {}): Promise<BulkJobResult> {
    const res = await call(a, 'POST', url, payload);
    if (res.statusCode !== 202) throw new Error(`Expected 202 from ${url}, got ${res.statusCode}: ${res.body}`);
    const { jobId } = res.json() as { jobId: string };
    const status = async () => (await call(a, 'GET', `/v1/bulk-jobs/${jobId}`)).json() as BulkJobResult;
    // Bounded: every run advances or ends a job, and a job waiting for a retry is not claimed.
    for (let i = 0; i < 1000 && (await runBulkJobs(pool, 100, options)) > 0; i++);
    const job = await status();
    if (job.state !== 'COMPLETED') throw new Error(`Bulk job ${jobId} ended ${job.state} (${job.errorCode ?? 'no error code'})`);
    return job;
  }

  return {
    db,
    pool,
    app,
    one,
    makeUser,
    tokenFor,
    makeCompany,
    actor,
    customActor,
    call,
    newEmployeeBody,
    setStatus,
    runBulkJob,
    async stop() {
      await app.close();
      await pool.end();
      await testDb.stop();
    },
  };
}
