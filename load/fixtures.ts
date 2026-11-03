// Synthetic G2 workload fixture generator (BRD v8.2 Appendix G2/G4). Writes straight into a target PostgreSQL
// database with the real schema: every company is created with the application's own provisioning
// (provisionCompany), people and history are bulk-inserted in batches, and the workflow states a run acts on
// (pending decisions, returned and withdrawable requests, approved history, report jobs) are created through the
// application's own service functions, so they are valid states, decided by distinct actors.
//
// Synthetic data only. Never point it at the development database: it refuses port 54329 / hrms_dev and the
// DATABASE_URL the development API uses. Usage: see load/README.md.
//   LOAD_DATABASE_URL=... LOAD_TOKEN_SECRET=... npx tsx load/fixtures.ts generate --out load/out/tiny
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { type DevTokenConfig, issueDevToken } from '../apps/api/src/auth/tokens.js';
import { createPool } from '../apps/api/src/db/pool.js';
import type { Queryable } from '../apps/api/src/db/queryable.js';
import { withTransaction } from '../apps/api/src/db/transaction.js';
import { HttpError } from '../apps/api/src/http/errors.js';
import { type AccessGrant, resolveAccess } from '../apps/api/src/modules/access/authorize.js';
import { BASELINE_ROLES } from '../apps/api/src/modules/access/baseline.js';
import { provisionCompany, withGrantBootstrap } from '../apps/api/src/modules/access/provision.js';
import { decideLeave, submitLeave } from '../apps/api/src/modules/leave/service.js';
import { requestReport } from '../apps/api/src/modules/report/service.js';
import { migrate } from '../db/migrate.js';
import {
  type CorrectionItem,
  type FixtureIdentity,
  type FixtureManifest,
  type FixtureParameters,
  IDENTITIES_FILE,
  MANIFEST_SCHEMA,
  type ManifestCompany,
  readManifest,
  type ScopeKind,
  writeManifest,
} from './lib/manifest.js';
import { type CompanyPlan, planFixture, ROLE_CODES } from './lib/plan.js';
import { createRng, type Rng } from './lib/rng.js';

export interface FixtureOptions {
  /** A pool (tests) or a connection string (CLI). A connection string is checked against the development database. */
  db: pg.Pool | string;
  /** Token issuer/audience/secret of the API under test (the secret is never written to the manifest). */
  token: DevTokenConfig;
  /** Write manifest.json and identities.ndjson here. */
  outDir?: string;
  /** Apply db/migrations first (connection-string mode only). */
  migrate?: boolean;
  companies?: number;
  identities?: number;
  seed?: number;
  coverAllRoles?: boolean;
  /** Working days of attendance history per identity (most recent first, today excluded). */
  attendanceDays?: number;
  /** Two punches (IN/OUT) per worked day as source evidence. */
  punches?: boolean;
  absentShare?: number;
  halfDayShare?: number;
  /** Future leave requests per identity left SUBMITTED: the decision inventory of their reviewer. */
  pendingLeavePerIdentity?: number;
  /** Mean RETURNED requests per identity that the owner can amend and resubmit (fractions are drawn per identity). */
  returnedPerIdentity?: number;
  /** Mean SUBMITTED requests per identity reserved for the owner's own withdrawal (fractions are drawn per identity). */
  withdrawPerIdentity?: number;
  /** Past leave requests per identity, approved by the reviewer the rules select (history). */
  approvedHistoryPerIdentity?: number;
  /** Queued report jobs per HR Administrator (report-status reads). */
  reportsPerHr?: number;
  /** Share of identities that also get a revoked and a server-expired session (negative probes). */
  deadSessionShare?: number;
  /** Session and token lifetime; at most 12 hours (DF10). */
  sessionHours?: number;
  openingBalances?: Record<string, string>;
  batchSize?: number;
  /** Parallel companies / service transactions. */
  concurrency?: number;
  log?: (line: string) => void;
}

export interface FixtureResult {
  manifest: FixtureManifest;
  identities: FixtureIdentity[];
}

const DEV_DB_PORT = '54329';
const DEV_DB_NAME = 'hrms_dev';
/** Provisioning (policies, routes, field classification) is effective from here; all fixture dates are later. */
const PROVISION_FROM = '2023-01-01';
const ASSIGNMENT_FROM = '2023-01-01T00:00:00Z';
const FIRST_JOINING = '2023-01-02';
const FALLBACK_KINDS = ['leave_request', 'profile_change', 'employee_confirmation', 'increment_case', 'sensitive_change'];
const MAX_FALLBACK_REVIEWERS = 5;
const SCHEDULED_NET_MINUTES = 480;

const DEFAULTS: FixtureParameters = {
  companies: 2,
  identities: 50,
  seed: 1,
  coverAllRoles: true,
  attendanceDays: 20,
  punches: true,
  absentShare: 0.05,
  halfDayShare: 0.05,
  pendingLeavePerIdentity: 1,
  returnedPerIdentity: 0.2,
  withdrawPerIdentity: 0.2,
  approvedHistoryPerIdentity: 1,
  reportsPerHr: 1,
  deadSessionShare: 0.1,
  sessionHours: 8,
  openingBalances: { ANNUAL: '12', SICK: '6', CASUAL: '6' },
  batchSize: 1000,
  concurrency: 3,
};

// ---------------------------------------------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------------------------------------------

function dbIdentity(url: string): { host: string | null; port: string | null; database: string | null } {
  try {
    const u = new URL(url);
    return { host: u.hostname || null, port: u.port || null, database: decodeURIComponent(u.pathname.replace(/^\//, '')) || null };
  } catch {
    throw new Error('The database URL is not a valid URL');
  }
}

/** Refuses the development database: its fixed port/name, and the DATABASE_URL the development API uses. */
export function assertNotDevelopmentDatabase(url: string): void {
  const target = dbIdentity(url);
  if (target.port === DEV_DB_PORT || target.database === DEV_DB_NAME) {
    throw new Error(`Refusing the development database (port ${DEV_DB_PORT} / ${DEV_DB_NAME}); create a separate load-test database`);
  }
  const dev = process.env.DATABASE_URL;
  if (dev) {
    const d = dbIdentity(dev);
    if (d.host === target.host && (d.port ?? '5432') === (target.port ?? '5432') && d.database === target.database) {
      throw new Error('Refusing DATABASE_URL (the development API database); use a separate load-test database');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------------------

const pad = (n: number, width: number) => String(n).padStart(width, '0');
const addDays = (day: string, n: number) => {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
const isWeekday = (day: string) => {
  const w = new Date(`${day}T00:00:00Z`).getUTCDay();
  return w !== 0 && w !== 6;
};
const nextWeekday = (day: string) => {
  let d = day;
  while (!isWeekday(d)) d = addDays(d, 1);
  return d;
};
/** `count` weekdays strictly before `day`, most recent first. */
function weekdaysBefore(day: string, count: number): string[] {
  const out: string[] = [];
  let d = addDays(day, -1);
  while (out.length < count) {
    if (isWeekday(d)) out.push(d);
    d = addDays(d, -1);
  }
  return out;
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

async function inBatches<T>(rows: readonly T[], size: number, work: (batch: T[]) => Promise<unknown>): Promise<void> {
  for (let start = 0; start < rows.length; start += size) await work(rows.slice(start, start + size));
}

const col = <T, K>(rows: readonly T[], pick: (row: T) => K): K[] => rows.map(pick);

// ---------------------------------------------------------------------------------------------------------------
// Companies
// ---------------------------------------------------------------------------------------------------------------

interface CompanyContext {
  plan: CompanyPlan;
  id: string;
  code: string;
  departments: string[];
  locationId: string;
  designations: { MGR: string; STAFF: string };
  shiftId: string;
  employmentTypeId: string;
  statusActiveId: string;
  attendanceStatus: Record<string, string>;
  roleIds: Record<string, string>;
  leaveTypeIds: Record<string, string>;
  attendancePolicyId: string;
}

async function createCompany(db: pg.Pool, fid: string, plan: CompanyPlan, approver: string): Promise<CompanyContext> {
  return withTransaction(db, async (tx) => {
    const code = `LT${fid}-${pad(plan.index + 1, 5)}`;
    const one = async (sql: string, params: unknown[]) => (await tx.query<{ id: string }>(sql, params)).rows[0]!.id;
    const id = await one(`insert into company (code, name, active, created_by) values ($1, $2, true, $3) returning id`, [
      code,
      `Load fixture company ${plan.index + 1} (synthetic)`,
      approver,
    ]);
    await provisionCompany(tx, { companyId: id, approvedBy: approver, effectiveFrom: PROVISION_FROM });
    const master = (table: string, c: string, name: string) =>
      one(`insert into ${table} (company_id, code, name, active, created_by) values ($1, $2, $3, true, $4) returning id`, [id, c, name, approver]);
    const departments: string[] = [];
    const deptCount = Math.min(10, Math.max(1, Math.ceil(plan.identities / 50)));
    for (let d = 1; d <= deptCount; d++) departments.push(await master('department', `D${pad(d, 2)}`, `Department ${d} (synthetic)`));
    const locationId = await master('location', 'HQ', 'Head office (synthetic)');
    const designations = { MGR: await master('designation', 'MGR', 'Manager'), STAFF: await master('designation', 'STAFF', 'Staff') };
    const shiftId = await one(
      `insert into shift (company_id, code, name, in_time, out_time, spans_midnight, active, created_by) values ($1, 'DAY', 'Day shift', '09:00', '18:00', false, true, $2) returning id`,
      [id, approver],
    );
    await tx.query(`insert into shift_break (company_id, shift_id, sequence, start_offset_minutes, end_offset_minutes) values ($1, $2, 1, 240, 300)`, [id, shiftId]);

    const refs = (await tx.query<{ category: string; code: string; id: string }>(`select category, code, id from reference_value where company_id = $1`, [id])).rows;
    const ref = (category: string, c: string) => {
      const row = refs.find((r) => r.category === category && r.code === c);
      if (!row) throw new Error(`Provisioning did not create reference value ${category}.${c}`);
      return row.id;
    };
    const roleIds = Object.fromEntries((await tx.query<{ code: string; id: string }>(`select code, id from role where company_id = $1`, [id])).rows.map((r) => [r.code, r.id]));
    const leaveTypeIds = Object.fromEntries(
      (await tx.query<{ code: string; id: string }>(`select code, id from leave_type where company_id = $1`, [id])).rows.map((r) => [r.code, r.id]),
    );
    const attendancePolicyId = await one(`select id from attendance_policy where company_id = $1 and code = 'DEFAULT' and revision = 1`, [id]);
    return {
      plan,
      id,
      code,
      departments,
      locationId,
      designations,
      shiftId,
      employmentTypeId: ref('EMPLOYMENT_TYPE', 'PERMANENT'),
      statusActiveId: ref('EMPLOYEE_STATUS', 'ACTIVE_CONFIRMED'),
      attendanceStatus: { PRESENT: ref('ATTENDANCE_STATUS', 'PRESENT'), HALF_DAY: ref('ATTENDANCE_STATUS', 'HALF_DAY'), ABSENT: ref('ATTENDANCE_STATUS', 'ABSENT') },
      roleIds,
      leaveTypeIds,
      attendancePolicyId,
    };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// People: accounts, employees, assignments, managers, links, grants, policies, balances, attendance
// ---------------------------------------------------------------------------------------------------------------

/** Managers first (the first is the top of the hierarchy), then HR, then the other roles, Employees last. */
const ROLE_ORDER = ['REPORTING_MANAGER', 'HR_ADMINISTRATOR', ...ROLE_CODES.filter((c) => c !== 'REPORTING_MANAGER' && c !== 'HR_ADMINISTRATOR' && c !== 'EMPLOYEE'), 'EMPLOYEE'];

interface Person {
  identity: FixtureIdentity;
  joiningDate: string;
}

async function createPeople(
  db: pg.Pool,
  c: CompanyContext,
  fid: string,
  firstIndex: number,
  approver: string,
  p: FixtureParameters,
  rng: Rng,
  businessDate: string,
): Promise<{ people: Person[]; hrUserIds: string[] }> {
  const roles: string[] = [];
  for (const code of ROLE_ORDER) for (let k = 0; k < (c.plan.roles[code] ?? 0); k++) roles.push(code);
  const fidLower = fid.toLowerCase();
  const people: Person[] = roles.map((role, i) => {
    const employeeCode = `E${pad(i + 1, 6)}`;
    const primary = randomUUID();
    const def = BASELINE_ROLES.find((r) => r.code === role)!;
    const identity: FixtureIdentity = {
      index: firstIndex + i,
      accountKey: `${employeeCode.toLowerCase()}.c${c.plan.index + 1}.${fidLower}@load.test`,
      userId: randomUUID(),
      companyId: c.id,
      companyIndex: c.plan.index,
      companyTier: c.plan.tier,
      role,
      employeeId: randomUUID(),
      employeeCode,
      managerEmployeeId: null,
      departmentId: c.departments[0]!,
      contexts: {
        primary: { assignmentId: primary, role, scope: def.defaultScope as ScopeKind },
        own: role === 'EMPLOYEE' ? { assignmentId: primary, role, scope: 'OWN' } : { assignmentId: randomUUID(), role: 'EMPLOYEE', scope: 'OWN' },
      },
      headers: { 'x-hrms-company': c.id, 'x-hrms-assignment': primary },
      session: { id: '', expiresAt: '', token: '' },
      workflow: { decide: [], resubmit: [], withdraw: [], correct: [], reports: [] },
      team: [],
      leave: { available: {}, nextFreeDate: '' },
      attendance: { from: null, to: null, days: 0 },
    };
    // Joining dates spread over 2023-2025: long enough service for every leave policy (ANNUAL needs 90 days).
    return { identity, joiningDate: addDays(FIRST_JOINING, (i * 7) % 900) };
  });

  // DF16 hierarchy: managers report to the top manager; everyone else is spread round-robin over the managers,
  // in the manager's department. The top manager has no manager (an explicit, recorded reason).
  const managers = people.filter((x) => x.identity.role === 'REPORTING_MANAGER');
  const top = managers[0]!;
  managers.forEach((m, j) => {
    m.identity.departmentId = c.departments[j % c.departments.length]!;
    if (m !== top) m.identity.managerEmployeeId = top.identity.employeeId;
  });
  let k = 0;
  for (const person of people) {
    if (person.identity.role === 'REPORTING_MANAGER') continue;
    const manager = managers[k++ % managers.length]!;
    person.identity.managerEmployeeId = manager.identity.employeeId;
    person.identity.departmentId = manager.identity.departmentId;
  }
  const byEmployee = new Map(people.map((x) => [x.identity.employeeId, x]));
  for (const person of people) {
    const m = person.identity.managerEmployeeId ? byEmployee.get(person.identity.managerEmployeeId) : undefined;
    m?.identity.team.push(person.identity.employeeId);
  }

  const hrUserIds = people.filter((x) => x.identity.role === 'HR_ADMINISTRATOR').map((x) => x.identity.userId);
  const ids = people.map((x) => x.identity);
  const B = p.batchSize;

  await withTransaction(db, async (tx) => {
    await inBatches(ids, B, (b) =>
      tx.query(`insert into user_account (id, account_key, active, created_by) select a.id, a.k, true, $3 from unnest($1::uuid[], $2::text[]) as a (id, k)`, [
        col(b, (x) => x.userId),
        col(b, (x) => x.accountKey),
        approver,
      ]),
    );
    await inBatches(people, B, (b) =>
      tx.query(
        `insert into employee (id, company_id, employee_code, display_name, work_email, joining_date, employment_type_id, status_id, no_manager_reason, created_by)
         select a.id, $1, a.code, a.name, a.email, a.joining, $2, $3, a.reason, $4
           from unnest($5::uuid[], $6::text[], $7::text[], $8::text[], $9::date[], $10::text[]) as a (id, code, name, email, joining, reason)`,
        [
          c.id,
          c.employmentTypeId,
          c.statusActiveId,
          approver,
          col(b, (x) => x.identity.employeeId),
          col(b, (x) => x.identity.employeeCode),
          col(b, (x) => `Load person ${x.identity.employeeCode} C${c.plan.index + 1} (synthetic)`),
          col(b, (x) => `${x.identity.employeeCode.toLowerCase()}@c${c.plan.index + 1}.${fidLower}.load.test`),
          col(b, (x) => x.joiningDate),
          col(b, (x) => (x === top ? 'Top of the synthetic load-fixture hierarchy' : null)),
        ],
      ),
    );
    await inBatches(people, B, (b) =>
      tx.query(
        `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, effective_from, created_by)
         select $1, a.e, a.d, $2, a.g, a.f, $3 from unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::date[]) as a (e, d, g, f)`,
        [
          c.id,
          c.locationId,
          approver,
          col(b, (x) => x.identity.employeeId),
          col(b, (x) => x.identity.departmentId),
          col(b, (x) => (x.identity.role === 'REPORTING_MANAGER' ? c.designations.MGR : c.designations.STAFF)),
          col(b, (x) => x.joiningDate),
        ],
      ),
    );
    await inBatches(people, B, (b) =>
      tx.query(
        `insert into shift_assignment (company_id, employee_id, shift_id, effective_from, created_by) select $1, a.e, $2, a.f, $3 from unnest($4::uuid[], $5::date[]) as a (e, f)`,
        [c.id, c.shiftId, approver, col(b, (x) => x.identity.employeeId), col(b, (x) => x.joiningDate)],
      ),
    );
    await inBatches(people, B, (b) =>
      tx.query(
        `insert into user_employee_link (company_id, user_id, employee_id, effective_from, created_by) select $1, a.u, a.e, a.f, $2 from unnest($3::uuid[], $4::uuid[], $5::date[]) as a (u, e, f)`,
        [c.id, approver, col(b, (x) => x.identity.userId), col(b, (x) => x.identity.employeeId), col(b, (x) => x.joiningDate)],
      ),
    );
    const reporting = people.filter((x) => x.identity.managerEmployeeId);
    await inBatches(reporting, B, (b) =>
      tx.query(
        `insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from, created_by) select $1, a.e, a.m, a.f, $2 from unnest($3::uuid[], $4::uuid[], $5::date[]) as a (e, m, f)`,
        [c.id, approver, col(b, (x) => x.identity.employeeId), col(b, (x) => x.identity.managerEmployeeId), col(b, (x) => x.joiningDate)],
      ),
    );

    // Role assignments: the primary role context, plus an Employee OWN context for own ESS work (DF02 v8.2).
    // Each is approved by the fixture approver, never by the beneficiary (C4).
    const contexts = ids.flatMap((x) => {
      const primary = { user: x.userId, ...x.contexts.primary };
      return x.contexts.own.assignmentId === x.contexts.primary.assignmentId ? [primary] : [primary, { user: x.userId, ...x.contexts.own }];
    });
    // Fixture grants go in through the database's bootstrap path (0099), as the development seed's do.
    await withGrantBootstrap(tx, async () => {
      await inBatches(contexts, B, (b) =>
        tx.query(
          `insert into role_assignment (id, company_id, user_id, role_id, scope_kind, effective_from, state, approved_by, approved_at, purpose)
           select a.id, $1, a.u, a.r, a.s, $2, 'ACTIVE', $3, now(), 'Load fixture (synthetic)'
             from unnest($4::uuid[], $5::uuid[], $6::uuid[], $7::text[]) as a (id, u, r, s)`,
          [c.id, ASSIGNMENT_FROM, approver, col(b, (x) => x.assignmentId), col(b, (x) => x.user), col(b, (x) => c.roleIds[x.role]), col(b, (x) => x.scope)],
        ),
      );
      // DB109 allowlists: each assignment gets its role's default duties (DF02), like the development seed.
      for (const role of BASELINE_ROLES) {
        const assignments = contexts.filter((x) => x.role === role.code).map((x) => x.assignmentId);
        await inBatches(assignments, B, (b) =>
          tx.query(
            `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from)
             select $1, a.id, p.id, true, $2 from unnest($3::uuid[]) as a (id)
               join permission p on p.resource || '.' || p.action || '.' || p.field_group = any($4::text[])`,
            [c.id, ASSIGNMENT_FROM, b, role.defaultDuties],
          ),
        );
      }
    });

    // Policies were authored by the approver; an HR Administrator of the company activates them (author != activator).
    for (const table of ['leave_policy', 'attendance_policy', 'expense_policy']) {
      await tx.query(`update ${table} set state = 'ACTIVE', activated_by = $2, activated_at = now() where company_id = $1 and state = 'DRAFT'`, [c.id, hrUserIds[0]]);
    }
    // DF03 explicit fallback lists, in priority order (eligibility is still checked at routing time).
    await tx.query(
      `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active)
       select $1, k.kind, u.id, u.priority, true
         from unnest($2::uuid[]) with ordinality as u (id, priority)
        cross join (select kind from transaction_kind where kind = any($3::text[])) k
       on conflict do nothing`,
      [c.id, hrUserIds.slice(0, MAX_FALLBACK_REVIEWERS), FALLBACK_KINDS],
    );

    // Opening leave balances.
    const openings = people.flatMap((x) =>
      Object.entries(p.openingBalances)
        .filter(([type]) => c.leaveTypeIds[type])
        .map(([type, units]) => ({ e: x.identity.employeeId, t: c.leaveTypeIds[type]!, units, date: x.joiningDate, key: `lt:${fid}:open:${x.identity.employeeCode}:${type}` })),
    );
    await inBatches(openings, B, (b) =>
      tx.query(
        `insert into leave_movement (company_id, employee_id, leave_type_id, movement_kind, units, effective_date, idempotency_key, reason, created_by)
         select $1, a.e, a.t, 'OPENING', a.u, a.d, a.k, 'Load fixture opening balance (synthetic)', $2
           from unnest($3::uuid[], $4::uuid[], $5::numeric[], $6::date[], $7::text[]) as a (e, t, u, d, k)`,
        [c.id, approver, col(b, (x) => x.e), col(b, (x) => x.t), col(b, (x) => x.units), col(b, (x) => x.date), col(b, (x) => x.key)],
      ),
    );

    // Attendance history: daily results (and their punches) for the last N working days, generated and inserted a
    // slice of people at a time so memory stays bounded however large the company or the history is.
    const days = weekdaysBefore(businessDate, p.attendanceDays);
    const byEmployeeId = new Map(ids.map((x) => [x.employeeId, x]));
    const codeOf = new Map(people.map((x) => [x.identity.employeeId, x.identity.employeeCode]));
    const peoplePerSlice = Math.max(1, Math.floor((B * 5) / Math.max(1, days.length)));
    for (let first = 0; first < people.length; first += peoplePerSlice) {
      const records: { id: string; e: string; day: string; status: string; worked: number; late: boolean; early: boolean }[] = [];
      for (const person of people.slice(first, first + peoplePerSlice)) {
        for (const day of days) {
          const r = rng.next();
          const status = r < p.absentShare ? 'ABSENT' : r < p.absentShare + p.halfDayShare ? 'HALF_DAY' : 'PRESENT';
          const worked = status === 'ABSENT' ? 0 : status === 'HALF_DAY' ? 240 + rng.int(60) : 450 + rng.int(75);
          const late = status === 'PRESENT' && rng.next() < 0.1;
          records.push({ id: randomUUID(), e: person.identity.employeeId, day, status, worked, late, early: status === 'HALF_DAY' });
        }
        person.identity.attendance = { from: days[days.length - 1] ?? null, to: days[0] ?? null, days: days.length };
      }
      await inBatches(records, B * 5, (b) =>
        tx.query(
          `insert into attendance_record (id, company_id, employee_id, work_date, shift_id, policy_id, scheduled_net_minutes, worked_minutes, late, early_departure, status_id, created_by)
           select a.id, $1, a.e, a.d, $2, $3, $4, a.w, a.l, a.x, a.s, $5
             from unnest($6::uuid[], $7::uuid[], $8::date[], $9::integer[], $10::boolean[], $11::boolean[], $12::uuid[]) as a (id, e, d, w, l, x, s)`,
          [
            c.id,
            c.shiftId,
            c.attendancePolicyId,
            SCHEDULED_NET_MINUTES,
            approver,
            col(b, (x) => x.id),
            col(b, (x) => x.e),
            col(b, (x) => x.day),
            col(b, (x) => x.worked),
            col(b, (x) => x.late),
            col(b, (x) => x.early),
            col(b, (x) => c.attendanceStatus[x.status]),
          ],
        ),
      );
      if (p.punches) {
        const punches = records
          .filter((r) => r.status !== 'ABSENT')
          .flatMap((r) => {
            const inMinute = r.late ? 15 + (r.worked % 20) : r.worked % 10;
            const outMinutes = 9 * 60 + inMinute + r.worked + 60;
            const at = (minutes: number) => `${r.day}T${pad(Math.floor(minutes / 60), 2)}:${pad(minutes % 60, 2)}:00+05:30`;
            const key = `${fid}:${codeOf.get(r.e)}:${r.day}`;
            return [
              { e: r.e, at: at(9 * 60 + inMinute), dir: 'IN', key: `${key}:IN` },
              { e: r.e, at: at(Math.min(outMinutes, 23 * 60 + 59)), dir: 'OUT', key: `${key}:OUT` },
            ];
          });
        // A manual punch names its tracked submission (0114), so each batch is the committed import a real upload leaves.
        await inBatches(punches, B * 5, async (b) => {
          const reference = `load-fixture:${fid}:${randomUUID()}`;
          const attachment = await tx.query<{ id: string }>(
            `insert into attachment (company_id, owner_user_id, content_reference, media_type, checksum, classification, created_by, updated_by)
             values ($1, $2, $3, 'text/csv', $4, 'OPERATIONAL', $2, $2) returning id`,
            [c.id, approver, reference, createHash('sha256').update(reference).digest('hex')],
          );
          const job = await tx.query<{ id: string }>(
            `insert into import_job (company_id, kind, state, attachment_id, submitted_by, idempotency_key, file_name, row_count, template_code, accepted_count, created_by, updated_by)
             values ($1, 'attendance_punch', 'COMMITTED', $2, $3, $4, 'load-fixture.csv', $5, 'ATTENDANCE_PUNCH_V1', $5, $3, $3) returning id`,
            [c.id, attachment.rows[0]!.id, approver, reference, b.length],
          );
          const jobId = job.rows[0]!.id;
          const rows = b.map((_, i) => i + 1);
          await tx.query(
            `insert into import_row (company_id, job_id, row_number, state, business_key, created_by, updated_by)
             select $1, $2, a.n, 'ACCEPTED', a.k, $3, $3 from unnest($4::int[], $5::text[]) as a (n, k)`,
            [c.id, jobId, approver, rows, col(b, (x) => x.key)],
          );
          await tx.query(
            `insert into attendance_punch (company_id, employee_id, occurred_at, direction, source_kind, external_event_key, source_identity_key, import_job_id, import_row_number, created_by)
             select $1, a.e, a.t, a.d, 'MANUAL_IMPORT', a.k, $2, $3, a.n, $4 from unnest($5::uuid[], $6::timestamptz[], $7::text[], $8::text[], $9::int[]) as a (e, t, d, k, n)`,
            [c.id, `load-fixture:${fid}`, jobId, approver, col(b, (x) => x.e), col(b, (x) => x.at), col(b, (x) => x.dir), col(b, (x) => x.key), rows],
          );
        });
      }
      // Correction inventory: days not recorded as present, which the owner may ask to correct to PRESENT.
      for (const r of records) {
        if (r.status === 'PRESENT') continue;
        const item: CorrectionItem = { attendanceRecordId: r.id, workDate: r.day, currentStatus: r.status };
        byEmployeeId.get(r.e)!.workflow.correct.push(item);
      }
    }
  });
  return { people, hrUserIds };
}

// ---------------------------------------------------------------------------------------------------------------
// Workflow states through the application's own services (valid states, distinct actors)
// ---------------------------------------------------------------------------------------------------------------

interface WorkflowStats {
  pending: number;
  returned: number;
  withdrawable: number;
  approvedHistory: number;
  reports: number;
  skipped: Record<string, number>;
}

async function grantFor(db: pg.Pool, identity: FixtureIdentity, context: 'primary' | 'own', resource: string, action: string): Promise<AccessGrant> {
  const decision = await resolveAccess(db, {
    userId: identity.userId,
    companyId: identity.companyId,
    assignmentId: identity.contexts[context].assignmentId,
    resource,
    action,
    fieldGroups: ['operational'],
  });
  if (!decision.allowed) throw new Error(`Fixture identity ${identity.accountKey} cannot ${resource}.${action}: ${decision.reason}`);
  return decision;
}

async function createWorkflowStates(db: pg.Pool, fid: string, people: Person[], p: FixtureParameters, rng: Rng, businessDate: string): Promise<WorkflowStats> {
  const byUser = new Map(people.map((x) => [x.identity.userId, x.identity]));
  const hrCount = new Map<string, number>();
  for (const x of people) if (x.identity.role === 'HR_ADMINISTRATOR') hrCount.set(x.identity.companyId, (hrCount.get(x.identity.companyId) ?? 0) + 1);
  const stats: WorkflowStats = { pending: 0, returned: 0, withdrawable: 0, approvedHistory: 0, reports: 0, skipped: {} };
  const skip = (code: string) => (stats.skipped[code] = (stats.skipped[code] ?? 0) + 1);
  let keySeq = 0;
  const key = (what: string) => `lt-${fid}-${what}-${++keySeq}`;

  // Decide plans up front (deterministic for a seed), then run them with bounded parallelism.
  const futureStart = nextWeekday(addDays(businessDate, 14));
  const pastStart = weekdaysBefore(businessDate, p.attendanceDays + 15)[p.attendanceDays + 14]!;
  // A mean per identity: the whole part for everyone, the fraction drawn per identity.
  const countOf = (mean: number) => Math.floor(mean) + (rng.next() < mean - Math.floor(mean) ? 1 : 0);
  const plans = people.map((person) => ({
    person,
    pending: p.pendingLeavePerIdentity,
    returned: countOf(p.returnedPerIdentity),
    withdraw: countOf(p.withdrawPerIdentity),
    // The only HR Administrator of a company cannot have back-dated leave reviewed (the HR list would hold only them).
    history: person.identity.role === 'HR_ADMINISTRATOR' && (hrCount.get(person.identity.companyId) ?? 0) < 2 ? 0 : p.approvedHistoryPerIdentity,
  }));

  const assigneeOf = async (companyId: string, taskId: string) => {
    const row = (await db.query<{ u: string }>(`select assignee_user_id as u from approval_task where company_id = $1 and id = $2`, [companyId, taskId])).rows[0];
    const assignee = row ? byUser.get(row.u) : undefined;
    if (!assignee) throw new Error(`Task ${taskId} is assigned to a user outside the fixture`);
    return assignee;
  };

  await mapLimit(plans, p.concurrency, async (plan) => {
    const owner = plan.person.identity;
    let future = futureStart;
    const nextFuture = () => {
      const d = future;
      future = nextWeekday(addDays(future, 1));
      return d;
    };
    let past = pastStart;
    const nextPast = () => {
      const d = past;
      past = weekdaysBefore(past, 1)[0]!;
      return d;
    };
    const submit = async (leaveType: string, day: string) => {
      const grant = await grantFor(db, owner, 'own', 'leave', 'submit');
      return withTransaction(db, (tx) => submitLeave(tx, grant, { leaveType, startDate: day, endDate: day, reason: 'Load fixture request (synthetic)' }));
    };
    const decide = async (taskId: string, decision: 'APPROVE' | 'RETURN') => {
      const assignee = await assigneeOf(owner.companyId, taskId);
      const grant = await grantFor(db, assignee, 'primary', 'leave', 'approve');
      await withTransaction(db, (tx) =>
        decideLeave(tx, grant, taskId, { decision, idempotencyKey: key('decide'), ...(decision === 'RETURN' ? { reason: 'Please adjust the dates (synthetic)' } : {}) }),
      );
    };
    // A business rule refusal (e.g. no eligible reviewer) skips that item; anything else is a fixture bug.
    const attempt = async (work: () => Promise<void>) => {
      try {
        await work();
      } catch (err) {
        if (err instanceof HttpError) skip(err.code);
        else throw err;
      }
    };

    for (let i = 0; i < plan.pending; i++) {
      await attempt(async () => {
        const r = await submit('ANNUAL', nextFuture());
        const assignee = await assigneeOf(owner.companyId, r.taskId);
        assignee.workflow.decide.push({ taskId: r.taskId, kind: 'leave_request', requestId: r.requestId, ownerIndex: owner.index });
        stats.pending++;
      });
    }
    for (let i = 0; i < plan.returned; i++) {
      await attempt(async () => {
        const r = await submit('CASUAL', nextFuture());
        await decide(r.taskId, 'RETURN');
        const version = (await db.query<{ version: number }>(`select version from leave_request where company_id = $1 and id = $2`, [owner.companyId, r.requestId])).rows[0]!.version;
        owner.workflow.resubmit.push({ requestId: r.requestId, expectedVersion: version });
        stats.returned++;
      });
    }
    for (let i = 0; i < plan.withdraw; i++) {
      await attempt(async () => {
        const r = await submit('SICK', nextFuture());
        owner.workflow.withdraw.push({ requestId: r.requestId });
        stats.withdrawable++;
      });
    }
    for (let i = 0; i < plan.history; i++) {
      await attempt(async () => {
        const r = await submit('ANNUAL', nextPast());
        await decide(r.taskId, 'APPROVE');
        stats.approvedHistory++;
      });
    }
    if (owner.role === 'HR_ADMINISTRATOR') {
      for (let i = 0; i < p.reportsPerHr; i++) {
        await attempt(async () => {
          const grant = await grantFor(db, owner, 'primary', 'employee', 'export');
          const r = await withTransaction(db, (tx) => requestReport(tx, grant, 'EMPLOYEE_REGISTER', {}));
          owner.workflow.reports.push(r.id);
          stats.reports++;
        });
      }
    }
    owner.leave.nextFreeDate = future;
  });
  return stats;
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions and tokens (DF10 server-side sessions; development tokens bound to them)
// ---------------------------------------------------------------------------------------------------------------

async function createSessions(
  db: pg.Pool,
  identities: FixtureIdentity[],
  token: DevTokenConfig,
  hours: number,
  batchSize: number,
  dead: Set<number>,
): Promise<{ expiresAt: string }> {
  const lifetime = Math.round(hours * 3600);
  const now = (await db.query<{ now: Date }>(`select now() as now`)).rows[0]!.now;
  const expiresAt = new Date(now.getTime() + lifetime * 1000).toISOString();
  const live = identities.map((x) => ({ x, sid: randomUUID() }));
  await inBatches(live, batchSize, (b) =>
    db.query(`insert into user_session (id, user_id, expires_at) select * from unnest($1::uuid[], $2::uuid[], $3::timestamptz[])`, [
      col(b, (r) => r.sid),
      col(b, (r) => r.x.userId),
      col(b, () => expiresAt),
    ]),
  );
  for (const r of live) r.x.session = { id: r.sid, expiresAt, token: await issueDevToken(token, r.x.userId, r.sid, lifetime) };

  const deadRows = identities.filter((x) => dead.has(x.index)).map((x) => ({ x, revoked: randomUUID(), expired: randomUUID() }));
  await inBatches(deadRows, batchSize, async (b) => {
    await db.query(
      `insert into user_session (id, user_id, expires_at, revoked_at) select a.id, a.u, $3::timestamptz, now() from unnest($1::uuid[], $2::uuid[]) as a (id, u)`,
      [col(b, (r) => r.revoked), col(b, (r) => r.x.userId), expiresAt],
    );
    await db.query(
      `insert into user_session (id, user_id, created_at, last_seen_at, expires_at)
       select a.id, a.u, now() - interval '3 hours', now() - interval '3 hours', now() - interval '1 hour' from unnest($1::uuid[], $2::uuid[]) as a (id, u)`,
      [col(b, (r) => r.expired), col(b, (r) => r.x.userId)],
    );
  });
  for (const r of deadRows) {
    r.x.deadSessions = {
      revokedToken: await issueDevToken(token, r.x.userId, r.revoked, lifetime),
      expiredToken: await issueDevToken(token, r.x.userId, r.expired, lifetime),
    };
  }
  return { expiresAt };
}

// ---------------------------------------------------------------------------------------------------------------
// Counts (G2: document the actual counts)
// ---------------------------------------------------------------------------------------------------------------

async function countRows(db: Queryable, companyIds: string[], fid: string): Promise<Record<string, number>> {
  const userPattern = `%.${fid.toLowerCase()}@load.test`;
  const perCompany: Record<string, string> = {
    employees: 'employee',
    employmentAssignments: 'employment_assignment',
    shiftAssignments: 'shift_assignment',
    managerAssignments: 'manager_assignment',
    userEmployeeLinks: 'user_employee_link',
    roleAssignments: 'role_assignment',
    roleAssignmentPermissions: 'role_assignment_permission',
    fallbackReviewers: 'workflow_fallback_reviewer',
    leaveMovements: 'leave_movement',
    leaveRequests: 'leave_request',
    attendanceRecords: 'attendance_record',
    attendancePunches: 'attendance_punch',
    approvalTasks: 'approval_task',
    approvalDecisions: 'approval_decision',
    reportExecutions: 'report_execution',
    auditEvents: 'audit_event',
    outboxEvents: 'outbox_event',
  };
  const selects = Object.entries(perCompany).map(([k, table]) => `(select count(*) from ${table} where company_id = any($1::uuid[]))::bigint as "${k}"`);
  const row = (
    await db.query<Record<string, string>>(
      `select (select count(*) from company where id = any($1::uuid[]))::bigint as companies,
              (select count(*) from user_account where account_key like $2)::bigint as "userAccounts",
              (select count(*) from user_session s join user_account u on u.id = s.user_id where u.account_key like $2)::bigint as sessions,
              (select count(*) from user_session s join user_account u on u.id = s.user_id
                where u.account_key like $2 and s.revoked_at is null and s.expires_at > now())::bigint as "sessionsLive",
              (select count(*) from leave_request where company_id = any($1::uuid[]) and state = 'SUBMITTED')::bigint as "leaveRequestsSubmitted",
              (select count(*) from leave_request where company_id = any($1::uuid[]) and state = 'RETURNED')::bigint as "leaveRequestsReturned",
              (select count(*) from leave_request where company_id = any($1::uuid[]) and state = 'APPROVED')::bigint as "leaveRequestsApproved",
              (select count(*) from approval_task where company_id = any($1::uuid[]) and state = 'PENDING')::bigint as "approvalTasksPending",
              ${selects.join(',\n              ')}`,
      [companyIds, userPattern],
    )
  ).rows[0]!;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}

// ---------------------------------------------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------------------------------------------

function resolveParameters(o: FixtureOptions): FixtureParameters {
  const p: FixtureParameters = {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(o).filter(([k, v]) => v !== undefined && k in DEFAULTS)),
  } as FixtureParameters;
  const share = (name: keyof FixtureParameters) => {
    const v = p[name] as number;
    if (!(v >= 0 && v <= 1)) throw new Error(`${name} must be between 0 and 1`);
  };
  for (const n of ['absentShare', 'halfDayShare', 'deadSessionShare'] as const) share(n);
  if (p.absentShare + p.halfDayShare > 1) throw new Error('absentShare + halfDayShare must not exceed 1');
  for (const n of ['returnedPerIdentity', 'withdrawPerIdentity'] as const) {
    if (!(Number.isFinite(p[n]) && p[n] >= 0 && p[n] <= 1000)) throw new Error(`${n} must be a mean between 0 and 1000`);
  }
  if (!(p.sessionHours > 0 && p.sessionHours <= 12)) throw new Error('sessionHours must be in (0, 12] (DF10 absolute session limit)');
  for (const n of ['attendanceDays', 'pendingLeavePerIdentity', 'approvedHistoryPerIdentity', 'reportsPerHr'] as const) {
    if (!Number.isInteger(p[n]) || p[n] < 0) throw new Error(`${n} must be a non-negative integer`);
  }
  if (!Number.isInteger(p.batchSize) || p.batchSize < 1) throw new Error('batchSize must be a positive integer');
  if (!Number.isInteger(p.concurrency) || p.concurrency < 1) throw new Error('concurrency must be a positive integer');
  return p;
}

export async function generateFixture(options: FixtureOptions): Promise<FixtureResult> {
  if (process.env.NODE_ENV === 'production') throw new Error('The load fixture never runs in production');
  const p = resolveParameters(options);
  const log = options.log ?? (() => undefined);
  const started = Date.now();
  let pool: pg.Pool;
  let database: FixtureManifest['database'] = { host: null, port: null, database: null };
  if (typeof options.db === 'string') {
    assertNotDevelopmentDatabase(options.db);
    database = dbIdentity(options.db);
    if (options.migrate) {
      const client = new pg.Client({ connectionString: options.db });
      await client.connect();
      try {
        const applied = await migrate(client);
        log(applied.length ? `migrations applied: ${applied.join(', ')}` : 'schema is up to date');
      } finally {
        await client.end();
      }
    }
    pool = createPool(options.db, p.concurrency + 1);
  } else {
    pool = options.db;
  }

  try {
    const applied = (
      await pool
        .query<{ filename: string; checksum: string }>(`select filename, checksum from schema_migration order by filename`)
        .catch(() => ({ rows: [] as { filename: string; checksum: string }[] }))
    ).rows;
    const migrations = applied.map((r) => r.filename);
    if (migrations.length === 0) throw new Error('The target database has no schema; run with --migrate (connection-string mode) first');
    const schemaFingerprint = createHash('sha256')
      .update(applied.map((r) => `${r.filename}:${r.checksum}`).join('\n'))
      .digest('hex');
    if ((await pool.query(`select 1 from company where code = 'DEMO'`)).rowCount) {
      throw new Error('The target database holds the development seed (company DEMO); use a separate load-test database');
    }

    const fid = randomBytes(3).toString('hex').toUpperCase();
    const rng = createRng(p.seed);
    const plan = planFixture(p.identities, p.companies, { coverAllRoles: p.coverAllRoles });
    log(`fixture ${fid}: ${p.identities} identities in ${p.companies} companies (largest ${plan.companies[0]!.identities})`);

    const approver = (
      await pool.query<{ id: string }>(`insert into user_account (account_key, active) values ($1, true) returning id`, [`approver.${fid.toLowerCase()}@load.test`])
    ).rows[0]!.id;
    const companies = await mapLimit(plan.companies, p.concurrency, async (cp) => {
      const c = await createCompany(pool, fid, cp, approver);
      log(`company ${cp.index + 1}/${plan.companies.length} provisioned (${c.code}, ${cp.tier}, ${cp.identities} identities)`);
      return c;
    });
    const businessDate = (await pool.query<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [companies[0]!.id])).rows[0]!.d;

    const firstIndex: number[] = [];
    companies.reduce((n, c) => (firstIndex.push(n), n + c.plan.identities), 0);
    const created = await mapLimit(companies, p.concurrency, async (c, i) => {
      const result = await createPeople(pool, c, fid, firstIndex[i]!, approver, p, createRng(p.seed + 7919 * (i + 1)), businessDate);
      log(`company ${i + 1}: ${result.people.length} people, grants, policies, balances and ${p.attendanceDays} attendance days`);
      return result;
    });
    const people = created.flatMap((r) => r.people);
    const identities = people.map((x) => x.identity);

    const wf = await createWorkflowStates(pool, fid, people, p, rng, businessDate);
    log(`workflow states: ${wf.pending} pending, ${wf.returned} returned, ${wf.withdrawable} withdrawable, ${wf.approvedHistory} approved history, ${wf.reports} report jobs`);

    // Balances as they stand after the history (the generator spends paid balance first, then unpaid leave).
    for (const c of companies) {
      const rows = (
        await pool.query<{ e: string; t: string; v: string }>(
          `select m.employee_id as e, t.code as t, sum(m.units)::numeric(12,4)::text as v
             from leave_movement m join leave_type t on t.company_id = m.company_id and t.id = m.leave_type_id
            where m.company_id = $1 group by 1, 2`,
          [c.id],
        )
      ).rows;
      const byEmployee = new Map(identities.filter((x) => x.companyId === c.id).map((x) => [x.employeeId, x]));
      for (const r of rows) {
        const x = byEmployee.get(r.e);
        if (x) x.leave.available[r.t] = r.v;
      }
    }

    // Sessions last, so their idle clock (30 minutes, DF10) starts when the manifest is handed over.
    const dead = new Set<number>();
    if (p.deadSessionShare > 0) {
      for (const x of identities) if (rng.next() < p.deadSessionShare) dead.add(x.index);
      if (dead.size === 0 && identities[0]) dead.add(identities[0].index);
    }
    const { expiresAt } = await createSessions(pool, identities, options.token, p.sessionHours, p.batchSize, dead);

    const counts = await countRows(pool, companies.map((c) => c.id), fid);
    const manifestCompanies: ManifestCompany[] = companies.map((c) => ({
      index: c.plan.index,
      id: c.id,
      code: c.code,
      tier: c.plan.tier,
      targetShare: c.plan.targetShare,
      identities: c.plan.identities,
      roles: c.plan.roles,
    }));
    const warnings = [...plan.warnings, ...Object.entries(wf.skipped).map(([code, n]) => `${n} workflow fixture item(s) skipped: ${code}`)];
    const manifest: FixtureManifest = {
      schema: MANIFEST_SCHEMA,
      fixtureId: fid,
      createdAt: new Date().toISOString(),
      rotatedAt: null,
      database,
      token: { issuer: options.token.issuer, audience: options.token.audience, sessionHours: p.sessionHours, expiresAt },
      businessDate,
      parameters: p,
      companies: manifestCompanies,
      roleTotals: plan.roleTotals,
      roleTargetShares: plan.roleTargetShares,
      counts,
      inventory: {
        decide: identities.reduce((n, x) => n + x.workflow.decide.length, 0),
        resubmit: identities.reduce((n, x) => n + x.workflow.resubmit.length, 0),
        withdraw: identities.reduce((n, x) => n + x.workflow.withdraw.length, 0),
        correct: identities.reduce((n, x) => n + x.workflow.correct.length, 0),
        reports: identities.reduce((n, x) => n + x.workflow.reports.length, 0),
        deadSessions: dead.size,
      },
      schemaMigrations: migrations,
      schemaFingerprint,
      warnings,
      identitiesFile: IDENTITIES_FILE,
      identityCount: identities.length,
    };
    if (options.outDir) await writeManifest(options.outDir, manifest, identities);
    log(`fixture ${fid} written in ${((Date.now() - started) / 1000).toFixed(1)} s${options.outDir ? ` to ${options.outDir}` : ''}`);
    return { manifest, identities };
  } finally {
    if (typeof options.db === 'string') await pool.end();
  }
}

/**
 * G2 session rotation: new sessions and tokens for every identity of a manifest (e.g. before a soak run longer
 * than the 12-hour absolute session, or when the 30-minute idle timeout has passed since the fixture was written).
 */
export async function rotateSessions(options: {
  db: pg.Pool | string;
  token: DevTokenConfig;
  manifestDir: string;
  outDir: string;
  sessionHours?: number;
  revokeOld?: boolean;
  batchSize?: number;
}): Promise<FixtureManifest> {
  if (process.env.NODE_ENV === 'production') throw new Error('The load fixture never runs in production');
  if (typeof options.db === 'string') assertNotDevelopmentDatabase(options.db);
  const pool = typeof options.db === 'string' ? createPool(options.db, 2) : options.db;
  try {
    const { manifest, identities } = await readManifest(options.manifestDir);
    const hours = options.sessionHours ?? manifest.token.sessionHours;
    if (!(hours > 0 && hours <= 12)) throw new Error('sessionHours must be in (0, 12]');
    const batch = options.batchSize ?? 1000;
    const old = identities.map((x) => x.session.id);
    const keepDead = new Set<number>(); // dead sessions stay dead; only live sessions rotate
    const { expiresAt } = await createSessions(pool, identities, options.token, hours, batch, keepDead);
    if (options.revokeOld) {
      await inBatches(old, batch, (b) => pool.query(`update user_session set revoked_at = coalesce(revoked_at, now()) where id = any($1::uuid[])`, [b]));
    }
    const rotated: FixtureManifest = { ...manifest, rotatedAt: new Date().toISOString(), token: { ...manifest.token, sessionHours: hours, expiresAt } };
    await writeManifest(options.outDir, rotated, identities);
    return rotated;
  } finally {
    if (typeof options.db === 'string') await pool.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

function tokenFromEnv(issuer: string | undefined, audience: string | undefined): DevTokenConfig {
  const secret = process.env.LOAD_TOKEN_SECRET ?? process.env.DEV_TOKEN_SECRET;
  if (!secret) throw new Error('Set LOAD_TOKEN_SECRET to the token secret of the API under test (never pass it on the command line)');
  return { issuer: issuer ?? 'hrms-dev', audience: audience ?? 'hrms-api', secret };
}

const num = (v: string | undefined, name: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`--${name} must be a number`);
  return n;
};

function parseBalances(v: string | undefined): Record<string, string> | undefined {
  if (!v) return undefined;
  return Object.fromEntries(
    v.split(',').map((pair) => {
      const [type, units] = pair.split('=');
      if (!type || !units || !/^\d{1,4}(\.\d{1,4})?$/.test(units)) throw new Error(`Invalid --opening entry ${pair} (use ANNUAL=12,SICK=6)`);
      return [type.trim().toUpperCase(), units];
    }),
  );
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'database-url': { type: 'string' },
      out: { type: 'string' },
      manifest: { type: 'string' },
      migrate: { type: 'boolean' },
      companies: { type: 'string' },
      identities: { type: 'string' },
      seed: { type: 'string' },
      'no-cover-all-roles': { type: 'boolean' },
      'attendance-days': { type: 'string' },
      'no-punches': { type: 'boolean' },
      'absent-share': { type: 'string' },
      'half-day-share': { type: 'string' },
      'pending-leave': { type: 'string' },
      'returned-per-identity': { type: 'string' },
      'withdraw-per-identity': { type: 'string' },
      'approved-history': { type: 'string' },
      'reports-per-hr': { type: 'string' },
      'dead-session-share': { type: 'string' },
      'session-hours': { type: 'string' },
      opening: { type: 'string' },
      'batch-size': { type: 'string' },
      concurrency: { type: 'string' },
      'token-issuer': { type: 'string' },
      'token-audience': { type: 'string' },
      'revoke-old': { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  const command = positionals[0] ?? 'generate';
  if (values.help || !['generate', 'rotate-sessions'].includes(command)) {
    console.log('Usage: npx tsx load/fixtures.ts generate --out DIR [--companies 2] [--identities 50] [--migrate] [...]');
    console.log('       npx tsx load/fixtures.ts rotate-sessions --manifest DIR --out DIR [--session-hours 8] [--revoke-old]');
    console.log('Environment: LOAD_DATABASE_URL (target load-test database), LOAD_TOKEN_SECRET (API token secret). See load/README.md.');
    return;
  }
  const url = values['database-url'] ?? process.env.LOAD_DATABASE_URL;
  if (!url) throw new Error('Pass --database-url or set LOAD_DATABASE_URL to a dedicated load-test database (DATABASE_URL is never used)');
  if (!values.out) throw new Error('Pass --out DIR for the manifest');
  const token = tokenFromEnv(values['token-issuer'], values['token-audience']);
  const log = (line: string) => console.error(`[fixture] ${line}`);

  if (command === 'rotate-sessions') {
    if (!values.manifest) throw new Error('Pass --manifest DIR');
    const m = await rotateSessions({
      db: url,
      token,
      manifestDir: values.manifest,
      outDir: values.out,
      ...(values['session-hours'] ? { sessionHours: num(values['session-hours'], 'session-hours')! } : {}),
      revokeOld: values['revoke-old'] === true,
    });
    log(`rotated ${m.identityCount} sessions; tokens expire ${m.token.expiresAt}`);
    return;
  }

  const options: FixtureOptions = { db: url, token, outDir: values.out, migrate: values.migrate === true, log };
  const set = <K extends keyof FixtureOptions>(k: K, v: FixtureOptions[K] | undefined) => {
    if (v !== undefined) options[k] = v;
  };
  set('companies', num(values.companies, 'companies'));
  set('identities', num(values.identities, 'identities'));
  set('seed', num(values.seed, 'seed'));
  if (values['no-cover-all-roles']) options.coverAllRoles = false;
  set('attendanceDays', num(values['attendance-days'], 'attendance-days'));
  if (values['no-punches']) options.punches = false;
  set('absentShare', num(values['absent-share'], 'absent-share'));
  set('halfDayShare', num(values['half-day-share'], 'half-day-share'));
  set('pendingLeavePerIdentity', num(values['pending-leave'], 'pending-leave'));
  set('returnedPerIdentity', num(values['returned-per-identity'], 'returned-per-identity'));
  set('withdrawPerIdentity', num(values['withdraw-per-identity'], 'withdraw-per-identity'));
  set('approvedHistoryPerIdentity', num(values['approved-history'], 'approved-history'));
  set('reportsPerHr', num(values['reports-per-hr'], 'reports-per-hr'));
  set('deadSessionShare', num(values['dead-session-share'], 'dead-session-share'));
  set('sessionHours', num(values['session-hours'], 'session-hours'));
  set('openingBalances', parseBalances(values.opening));
  set('batchSize', num(values['batch-size'], 'batch-size'));
  set('concurrency', num(values.concurrency, 'concurrency'));

  const { manifest } = await generateFixture(options);
  console.log(`Fixture ${manifest.fixtureId} (${manifest.identityCount} identities, ${manifest.companies.length} companies) written to ${values.out}`);
  console.log('Actual counts:');
  for (const [k, v] of Object.entries(manifest.counts)) console.log(`  ${k.padEnd(28)} ${v}`);
  console.log('Roles (actual / G2 target share):');
  for (const [role, n] of Object.entries(manifest.roleTotals)) {
    console.log(`  ${role.padEnd(28)} ${String(n).padStart(8)}  ${((n / manifest.identityCount) * 100).toFixed(2)}% / ${((manifest.roleTargetShares[role] ?? 0) * 100).toFixed(2)}%`);
  }
  console.log('Workflow inventory:', JSON.stringify(manifest.inventory));
  for (const w of manifest.warnings) console.log(`Warning: ${w}`);
  console.log(`Sessions expire ${manifest.token.expiresAt}; they go idle after 30 minutes without requests (rotate-sessions renews them).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: Error) => {
    console.error(`[fixture] ${err.message}`);
    process.exitCode = 1;
  });
}
