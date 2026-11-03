// Organisation masters (FR-004, BR-004): department, location, designation, grade.
// Masters are deactivated, never deleted; referenced history keeps its original classification.
// Each master has a valid period (0102); a period or deactivation that would strand a live assignment is refused (DB001, BR-004).
// The company itself is maintained here too: name, business timezone and a controlled deactivation (FR-004, DF05, DB001).
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';

const MASTER_TABLES = { departments: 'department', locations: 'location', designations: 'designation', grades: 'grade' } as const;
type MasterKind = keyof typeof MASTER_TABLES;

const kindParams = {
  type: 'object',
  required: ['kind'],
  properties: { kind: { type: 'string', enum: Object.keys(MASTER_TABLES) }, id: { type: 'string', format: 'uuid' } },
} as const;

const date = { type: 'string', format: 'date' } as const;
const nullableDate = { type: ['string', 'null'], format: 'date' } as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'name'],
  properties: {
    code: { type: 'string', pattern: '^\\s*[A-Za-z0-9][A-Za-z0-9_-]{0,39}\\s*$' },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    validFrom: date,
    validTo: date,
  },
} as const;

const updateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  minProperties: 2,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    active: { type: 'boolean' },
    validFrom: nullableDate,
    validTo: nullableDate,
  },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    includeInactive: { type: 'boolean', default: false },
    // Only masters usable on this date: what a joining or transfer form offers for its date.
    validOn: date,
  },
} as const;

const companyBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  minProperties: 2,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    name: { type: 'string', minLength: 1, maxLength: 200 },
    businessTimezone: { type: 'string', minLength: 1, maxLength: 100 },
    active: { type: 'boolean' },
  },
} as const;

interface MasterRow {
  id: string;
  code: string;
  name: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  version: number;
}

const MASTER_COLUMNS = `id, code, name, active, valid_from as "validFrom", valid_to as "validTo", version`;

// Masters are company-wide reference data; changing them needs unrestricted company scope.
function assertCompanyWide(grant: AccessGrant): void {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) {
    throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  }
}

function assertPeriod(validFrom: string | null, validTo: string | null): void {
  if (validFrom !== null && validTo !== null && validTo <= validFrom) throw new HttpError(422, 'INVALID_PERIOD', 'A master must end after it starts');
}

/** Employees still employed (not separated or closed) on an assignment of this master that runs past `onDate`. */
const liveAssignments = (table: string) => `
  select count(*)::int as n
    from employment_assignment a
    join employee e on e.company_id = a.company_id and e.id = a.employee_id
    join reference_value st on st.company_id = e.company_id and st.id = e.status_id
   where a.company_id = $1 and a.${table}_id = $2
     and st.code not in ('INACTIVE_SEPARATED', 'ARCHIVED')
     and (a.effective_to is null or a.effective_to > $3::date)`;

/**
 * BR-004 "preserving referenced historical classifications": a master can be closed from the day nobody is left on it. Closing
 * it under someone (deactivating, or a period ending before their assignment does) is refused, and so is a start after an
 * assignment has already begun, whichever employee it belongs to, because history would then sit outside the period.
 */
async function assertNotStranded(tx: Queryable, table: string, grant: AccessGrant, id: string, before: MasterRow, after: { active: boolean; validFrom: string | null; validTo: string | null }): Promise<void> {
  const inUse = async (onDate: string) => (await tx.query<{ n: number }>(liveAssignments(table), [grant.companyId, id, onDate])).rows[0]!.n;
  let assignments = 0;
  if (before.active && !after.active) assignments = await inUse(grant.businessDate);
  if (!assignments && after.validTo !== null && after.validTo !== before.validTo) assignments = await inUse(after.validTo);
  if (!assignments && after.validFrom !== null && after.validFrom !== before.validFrom) {
    assignments = (await tx.query<{ n: number }>(`select count(*)::int as n from employment_assignment where company_id = $1 and ${table}_id = $2 and effective_from < $3::date`, [grant.companyId, id, after.validFrom])).rows[0]!.n;
  }
  if (assignments > 0) throw new HttpError(409, 'MASTER_IN_USE', `Move the ${assignments} assignment(s) on this ${table} first`, { assignments });
}

interface CompanyRow {
  id: string;
  code: string;
  name: string;
  businessTimezone: string;
  active: boolean;
  version: number;
}

const COMPANY_COLUMNS = `id, code, name, business_timezone as "businessTimezone", active, version`;

/**
 * DB001 "root deactivation cannot orphan active assignments": refused while anyone is still employed or anyone else holds a
 * role in the company. Nobody can act in an inactive company, so reactivating needs the operator (docs/03).
 */
async function assertCompanyEmpty(tx: Queryable, grant: AccessGrant): Promise<void> {
  const row = (
    await tx.query<{ employees: number; roles: number }>(
      `select (select count(*)::int
                 from employment_assignment a
                 join employee e on e.company_id = a.company_id and e.id = a.employee_id
                 join reference_value st on st.company_id = e.company_id and st.id = e.status_id
                where a.company_id = $1 and st.code not in ('INACTIVE_SEPARATED', 'ARCHIVED')
                  and (a.effective_to is null or a.effective_to > $2::date)) as employees,
              (select count(*)::int from role_assignment ra
                where ra.company_id = $1 and ra.id <> $3 and ra.state in ('PENDING', 'ACTIVE') and (ra.effective_to is null or ra.effective_to > now())) as roles`,
      [grant.companyId, grant.businessDate, grant.assignmentId],
    )
  ).rows[0]!;
  if (row.employees > 0 || row.roles > 0) {
    throw new HttpError(409, 'COMPANY_IN_USE', 'End every employment and every other role assignment first', { employees: row.employees, roleAssignments: row.roles });
  }
}

export async function orgRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.get('/org/company', async (request) => {
    const grant = await requireAccess(db, request, 'org_master', 'read', ['operational']);
    const row = (await db.query<CompanyRow>(`select ${COMPANY_COLUMNS} from company where id = $1`, [grant.companyId])).rows[0];
    if (!row) throw notFound();
    return row;
  });

  app.patch('/org/company', { schema: { body: companyBody } }, async (request) => {
    const body = request.body as { expectedVersion: number; name?: string; businessTimezone?: string; active?: boolean };
    const grant = await requireAccess(db, request, 'org_master', 'update', ['operational'], { requireAll: true });
    assertCompanyWide(grant);
    if (body.active === true) throw new HttpError(422, 'RULE_VIOLATION', 'A company in use is already active');
    return withTransaction(db, async (tx) => {
      const current = (await tx.query<CompanyRow>(`select ${COMPANY_COLUMNS} from company where id = $1 for no key update`, [grant.companyId])).rows[0];
      if (!current) throw notFound();
      await reassertAccess(tx, grant, 'org_master', 'update', ['operational']);
      if (current.version !== body.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
      const name = body.name?.trim() ?? current.name;
      const businessTimezone = body.businessTimezone?.trim() ?? current.businessTimezone;
      if (name === '') throw new HttpError(422, 'INVALID_NAME', 'A company needs a name');
      const zone = await tx.query(`select 1 from pg_timezone_names where name = $1`, [businessTimezone]);
      if (!zone.rowCount) throw new HttpError(422, 'INVALID_TIMEZONE', 'Unknown timezone');
      const active = body.active ?? current.active;
      // Nothing to change writes nothing: no new version and no audit record of a change that did not happen.
      if (name === current.name && businessTimezone === current.businessTimezone && active === current.active) return current;
      if (current.active && !active) await assertCompanyEmpty(tx, grant);
      const updated = (
        await tx.query<CompanyRow>(`update company set name = $2, business_timezone = $3, active = $4, updated_by = $5 where id = $1 returning ${COMPANY_COLUMNS}`, [grant.companyId, name, businessTimezone, active, grant.userId])
      ).rows[0]!;
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'company',
        recordKey: grant.companyId,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: active ? 'UPDATE' : 'DEACTIVATE',
        priorVersion: current.version,
        newVersion: updated.version,
        before: { operational: { name: current.name, businessTimezone: current.businessTimezone, active: current.active } },
        after: { operational: { name, businessTimezone, active } },
      });
      return updated;
    });
  });

  app.get('/org/:kind', { schema: { params: kindParams, querystring: listQuery } }, async (request) => {
    const { kind } = request.params as { kind: MasterKind };
    const { includeInactive, validOn } = request.query as { includeInactive: boolean; validOn?: string };
    const grant = await requireAccess(db, request, 'org_master', 'read', ['operational']);
    const rows = await db.query<MasterRow>(
      `select ${MASTER_COLUMNS} from ${MASTER_TABLES[kind]}
        where company_id = $1 and ($2 or active)
          and ($3::date is null or ((valid_from is null or valid_from <= $3::date) and (valid_to is null or valid_to > $3::date)))
        order by code`,
      [grant.companyId, includeInactive, validOn ?? null],
    );
    return { items: rows.rows };
  });

  app.post('/org/:kind', { schema: { params: kindParams, body: createBody } }, async (request, reply) => {
    const { kind } = request.params as { kind: MasterKind };
    const body = request.body as { code: string; name: string; validFrom?: string; validTo?: string };
    const grant = await requireAccess(db, request, 'org_master', 'create', ['operational'], { requireAll: true });
    assertCompanyWide(grant);
    const validFrom = body.validFrom ?? null;
    const validTo = body.validTo ?? null;
    assertPeriod(validFrom, validTo);
    const row = await withTransaction(db, async (tx) => {
      await reassertAccess(tx, grant, 'org_master', 'create', ['operational']);
      const created = (
        await tx.query<MasterRow>(
          `insert into ${MASTER_TABLES[kind]} (company_id, code, name, active, valid_from, valid_to, created_by, updated_by)
           values ($1, $2, $3, true, $4, $5, $6, $6) returning ${MASTER_COLUMNS}`,
          [grant.companyId, body.code.trim().toUpperCase(), body.name.trim(), validFrom, validTo, grant.userId],
        )
      ).rows[0]!;
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'org_master',
        recordKey: created.id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'CREATE',
        newVersion: created.version,
        after: { operational: { kind, code: created.code, name: created.name, active: true, validFrom, validTo } },
      });
      return created;
    });
    reply.status(201);
    return row;
  });

  app.patch('/org/:kind/:id', { schema: { params: kindParams, body: updateBody } }, async (request) => {
    const { kind, id } = request.params as { kind: MasterKind; id: string };
    const body = request.body as { expectedVersion: number; name?: string; active?: boolean; validFrom?: string | null; validTo?: string | null };
    const grant = await requireAccess(db, request, 'org_master', 'update', ['operational'], { requireAll: true, recordKey: id });
    assertCompanyWide(grant);
    const table = MASTER_TABLES[kind];
    return withTransaction(db, async (tx) => {
      // Ordered against new assignments, which share-lock the master they name (org/masters.ts, 0102).
      const current = (await tx.query<MasterRow>(`select ${MASTER_COLUMNS} from ${table} where company_id = $1 and id = $2 for no key update`, [grant.companyId, id])).rows[0];
      if (!current) throw notFound();
      await reassertAccess(tx, grant, 'org_master', 'update', ['operational']);
      if (current.version !== body.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
      const name = body.name?.trim() ?? current.name;
      const active = body.active ?? current.active;
      const validFrom = body.validFrom === undefined ? current.validFrom : body.validFrom;
      const validTo = body.validTo === undefined ? current.validTo : body.validTo;
      assertPeriod(validFrom, validTo);
      if (name === current.name && active === current.active && validFrom === current.validFrom && validTo === current.validTo) return current;
      await assertNotStranded(tx, table, grant, id, current, { active, validFrom, validTo });
      const updated = (
        await tx.query<MasterRow>(
          `update ${table} set name = $3, active = $4, valid_from = $5, valid_to = $6, updated_by = $7 where company_id = $1 and id = $2
           returning ${MASTER_COLUMNS}`,
          [grant.companyId, id, name, active, validFrom, validTo, grant.userId],
        )
      ).rows[0]!;
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'org_master',
        recordKey: id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: active === current.active ? 'UPDATE' : active ? 'REACTIVATE' : 'DEACTIVATE',
        priorVersion: current.version,
        newVersion: updated.version,
        before: { operational: { name: current.name, active: current.active, validFrom: current.validFrom, validTo: current.validTo } },
        after: { operational: { name, active, validFrom, validTo } },
      });
      return updated;
    });
  });
}
