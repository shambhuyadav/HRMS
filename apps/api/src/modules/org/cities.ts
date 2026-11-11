// City master (BRD coverage CL-006 "City Master", under FR-004; DF04; DF09; BR-004; migration 0280; built 11 Nov 2026 from the
// reference system's screen: a city with its state, active or not, and a bulk upload; decided under owner delegation, 6 Nov 2026).
//
// A city belongs to one state of one country's state list (STATE_<ISO alpha-2>, reference values kept on the Reference values screen;
// India, STATE_IN, is the only country so far) and has a code unique within that state, a name, an active flag and a validity period
// [from, until), as the organisation masters have (0102). It is deactivated or its period closed, never deleted; it keeps its state
// and code (the database refuses a change). A new city needs its state active and in force today; a state deactivated later leaves
// its cities on record. Nothing refers to a city yet, so closing one strands nothing.
//
// Permissions are the organisation masters' own (org_master.read / create / update, operational): reading under any scope, changes
// only with unrestricted company scope (masters are company-wide), the grant re-checked inside the transaction, every change
// audited under org_master with kind "cities".
//
// Bulk upload, template CITY_MASTER_V1: stateCode,cityCode,cityName, one new city per row of India's states, through the shared import
// lifecycle (stage, preview, commit or cancel; all or nothing, DF09; the malware-scan hold; the published template). Each row is
// created exactly as POST /org/cities creates one. A row repeating a state and city code of an earlier row, or naming a city already on
// record, is refused, so the same file uploaded again under a new idempotency key adds nothing.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';
import { markRepeats, MAX_BATCH_BYTES, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { STATE_COUNTRIES } from './masters-registration.js';

const COUNTRY_CODES = STATE_COUNTRIES.map((c) => c.code);
const stateCategory = (country: string) => `STATE_${country}`;

const CITY_CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;
const STATE_CODE = /^[A-Z0-9][A-Z0-9_]{0,59}$/;
const MAX_NAME = 200;

export interface CityRow {
  id: string;
  country: string;
  stateCode: string;
  stateName: string;
  stateActive: boolean;
  code: string;
  name: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  version: number;
}

const CITY_SELECT = `select c.id, substr(c.state_category, 7) as country, s.code as "stateCode", s.label as "stateName", s.active as "stateActive",
                            c.code, c.name, c.active, to_char(c.valid_from, 'YYYY-MM-DD') as "validFrom", to_char(c.valid_to, 'YYYY-MM-DD') as "validTo", c.version
                       from city c join reference_value s on s.company_id = c.company_id and s.id = c.state_id`;

// Masters are company-wide reference data; changing them needs unrestricted company scope (as org/routes.ts).
function assertCompanyWide(grant: AccessGrant): void {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

function assertPeriod(validFrom: string | null, validTo: string | null): void {
  if (validFrom !== null && validTo !== null && validTo <= validFrom) throw new HttpError(422, 'INVALID_PERIOD', 'A city must end after it starts');
}

async function cityById(db: Queryable, companyId: string, id: string, lock = false): Promise<CityRow | undefined> {
  return (await db.query<CityRow>(`${CITY_SELECT} where c.company_id = $1 and c.id = $2${lock ? ' for no key update of c' : ''}`, [companyId, id])).rows[0];
}

export interface NewCity {
  country?: string | undefined;
  stateCode: string;
  code: string;
  name: string;
  validFrom?: string | undefined;
  validTo?: string | undefined;
}

/**
 * Creates one city inside the caller's transaction, under a grant resolved for org_master.create: company-wide scope, a valid
 * period, the grant re-checked, a state active and in force today, a code new within that state, and the audit. POST /org/cities and
 * the bulk upload both come through here.
 */
export async function createCity(tx: Queryable, grant: AccessGrant, input: NewCity): Promise<CityRow> {
  assertCompanyWide(grant);
  const country = (input.country ?? 'IN').trim().toUpperCase();
  if (!COUNTRY_CODES.includes(country)) throw new HttpError(422, 'UNKNOWN_COUNTRY', 'There is no state list for this country', { field: 'country' });
  const stateCode = input.stateCode.trim().toUpperCase();
  const code = input.code.trim().toUpperCase();
  const name = input.name.trim();
  if (!CITY_CODE.test(code)) throw new HttpError(422, 'INVALID_CITY_CODE', 'A city code starts with a letter or digit and uses letters, digits, hyphens and underscores, up to 40', { field: 'code' });
  if (!name || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(422, 'INVALID_CITY_NAME', `A city needs a name of at most ${MAX_NAME} characters`, { field: 'name' });
  const validFrom = input.validFrom ?? null;
  const validTo = input.validTo ?? null;
  assertPeriod(validFrom, validTo);
  await reassertAccess(tx, grant, 'org_master', 'create', ['operational']);
  // Share-locked, so a concurrent deactivation of the state is ordered before or after this city.
  const state = STATE_CODE.test(stateCode)
    ? (
        await tx.query<{ id: string; label: string; in_force: boolean }>(
          `select s.id, s.label,
                  (s.active and (s.valid_from is null or s.valid_from <= $4::date) and (s.valid_to is null or s.valid_to > $4::date)) as in_force
             from reference_value s where s.company_id = $1 and s.category = $2 and s.code = $3 for share`,
          [grant.companyId, stateCategory(country), stateCode, grant.businessDate],
        )
      ).rows[0]
    : undefined;
  if (!state) throw new HttpError(422, 'UNKNOWN_STATE', 'There is no such state in the state master', { field: 'stateCode' });
  if (!state.in_force) throw new HttpError(422, 'STATE_NOT_IN_FORCE', 'This state is inactive or outside its period, so no city can be added under it', { field: 'stateCode' });
  const taken = await tx.query(`select 1 from city where company_id = $1 and state_id = $2 and code = $3`, [grant.companyId, state.id, code]);
  if ((taken.rowCount ?? 0) > 0) throw new HttpError(409, 'DUPLICATE', 'Another city of this state, active or inactive, already has this code', { field: 'code' });
  const id = (
    await tx.query<{ id: string }>(
      `insert into city (company_id, state_category, state_id, code, name, active, valid_from, valid_to, created_by, updated_by)
       values ($1, $2, $3, $4, $5, true, $6, $7, $8, $8) returning id`,
      [grant.companyId, stateCategory(country), state.id, code, name, validFrom, validTo, grant.userId],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'org_master',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { kind: 'cities', country, state: stateCode, code, name, active: true, validFrom, validTo } },
  });
  return (await cityById(tx, grant.companyId, id))!;
}

export interface CityPatch {
  expectedVersion: number;
  name?: string | undefined;
  active?: boolean | undefined;
  validFrom?: string | null | undefined;
  validTo?: string | null | undefined;
}

/** Renames, deactivates or reactivates a city, or changes its period; nothing to change writes nothing. */
export async function updateCity(tx: Queryable, grant: AccessGrant, id: string, patch: CityPatch): Promise<CityRow> {
  assertCompanyWide(grant);
  const current = await cityById(tx, grant.companyId, id, true);
  if (!current) throw notFound();
  await reassertAccess(tx, grant, 'org_master', 'update', ['operational']);
  if (current.version !== patch.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  const name = patch.name?.trim() ?? current.name;
  if (!name || name.length > MAX_NAME || /[\u0000-\u001f\u007f]/.test(name)) throw new HttpError(422, 'INVALID_CITY_NAME', `A city needs a name of at most ${MAX_NAME} characters`, { field: 'name' });
  const active = patch.active ?? current.active;
  const validFrom = patch.validFrom === undefined ? current.validFrom : patch.validFrom;
  const validTo = patch.validTo === undefined ? current.validTo : patch.validTo;
  assertPeriod(validFrom, validTo);
  if (name === current.name && active === current.active && validFrom === current.validFrom && validTo === current.validTo) return current;
  await tx.query(`update city set name = $3, active = $4, valid_from = $5, valid_to = $6, updated_by = $7 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    name,
    active,
    validFrom,
    validTo,
    grant.userId,
  ]);
  const updated = (await cityById(tx, grant.companyId, id))!;
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
    after: { operational: { kind: 'cities', country: current.country, state: current.stateCode, code: current.code, name, active, validFrom, validTo } },
  });
  return updated;
}

export interface CityQuery {
  country: string;
  state?: string | undefined;
  includeInactive: boolean;
  validOn?: string | undefined;
}

/** The company's cities of one country, by state name and city name; one state, inactive ones or only those usable on a day on request. */
export async function listCities(db: Queryable, grant: AccessGrant, q: CityQuery) {
  const rows = await db.query<CityRow>(
    `${CITY_SELECT}
      where c.company_id = $1 and c.state_category = $2 and ($3::text is null or s.code = $3) and ($4 or c.active)
        and ($5::date is null or ((c.valid_from is null or c.valid_from <= $5::date) and (c.valid_to is null or c.valid_to > $5::date)))
      order by s.label, c.name, c.code`,
    [grant.companyId, stateCategory(q.country), q.state?.trim().toUpperCase() || null, q.includeInactive, q.validOn ?? null],
  );
  return { country: q.country, items: rows.rows };
}

// ---- Bulk upload (CITY_MASTER_V1; DF09) ----
const COLUMNS = ['stateCode', 'cityCode', 'cityName'] as const;
type Column = (typeof COLUMNS)[number];
export const CITY_TEMPLATE: Template<Column> = { code: 'CITY_MASTER_V1', columns: COLUMNS };

const cityKey = (row: Record<Column, string>) => (row.stateCode && row.cityCode ? `${row.stateCode.toUpperCase()}/${row.cityCode.toUpperCase()}` : '');

/** The single route's refusals as the row codes a preview shows. */
const ROW_CODES: Readonly<Record<string, string>> = { DUPLICATE: 'DUPLICATE_CITY' };

export const CITY_IMPORT_SPEC: BatchSpec<Column> = {
  kind: 'city_master',
  template: CITY_TEMPLATE,
  // One row per state and city code: a repeat would make the outcome depend on row order.
  parse: (bytes) => markRepeats(parseTemplate(bytes, CITY_TEMPLATE), cityKey, 'DUPLICATE_IN_BATCH'),
  keyOf: (row, n) => cityKey(row) || `ROW-${n}`,
  async apply(client, grant, row) {
    if (!row.stateCode) throw new RowError('UNKNOWN_STATE');
    try {
      await createCity(client, grant, { country: 'IN', stateCode: row.stateCode, code: row.cityCode, name: row.cityName });
    } catch (err) {
      if (err instanceof HttpError && err.statusCode !== 403) throw new RowError(ROW_CODES[err.code] ?? err.code);
      throw err;
    }
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', format: 'date' } as const;
const nullableDate = { type: ['string', 'null'], format: 'date' } as const;
const country = { type: 'string', enum: COUNTRY_CODES } as const;
export const CITY_IMPORTS = '/org/city-imports';

export async function cityRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  const create = (request: FastifyRequest, recordKey?: string) => requireAccess(db, request, 'org_master', 'create', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.get(
    '/org/cities',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { country: { ...country, default: 'IN' }, state: { type: 'string', pattern: '^[A-Za-z0-9_]{1,60}$' }, includeInactive: { type: 'boolean', default: false }, validOn: date },
        },
      },
    },
    async (request) => listCities(db, await requireAccess(db, request, 'org_master', 'read', ['operational']), request.query as CityQuery),
  );

  app.post(
    '/org/cities',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['stateCode', 'code', 'name'],
          properties: {
            country,
            stateCode: { type: 'string', minLength: 1, maxLength: 60 },
            code: { type: 'string', minLength: 1, maxLength: 60 },
            name: { type: 'string', minLength: 1, maxLength: MAX_NAME + 20 },
            validFrom: date,
            validTo: date,
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await create(request);
      // Scope is refused before a connection is taken; createCity checks it again in the transaction.
      assertCompanyWide(grant);
      const row = await withTransaction(db, (tx) => createCity(tx, grant, request.body as NewCity));
      reply.status(201);
      return row;
    },
  );

  app.patch(
    '/org/cities/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          minProperties: 2,
          properties: { expectedVersion: { type: 'integer', minimum: 1 }, name: { type: 'string', minLength: 1, maxLength: MAX_NAME + 20 }, active: { type: 'boolean' }, validFrom: nullableDate, validTo: nullableDate },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'org_master', 'update', ['operational'], { requireAll: true, recordKey: id });
      assertCompanyWide(grant);
      return withTransaction(db, (tx) => updateCity(tx, grant, id, request.body as CityPatch));
    },
  );

  // ---- Bulk upload: the create right, under which each row is created (company-wide scope, as one city) ----
  app.post(
    CITY_IMPORTS,
    {
      bodyLimit: Math.ceil(MAX_BATCH_BYTES * 1.4),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['fileName', 'contentBase64', 'idempotencyKey'],
          properties: {
            fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\<>:"|?*\\x00-\\x1f\\x7f]+$' },
            contentBase64: { type: 'string', minLength: 4 },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await create(request);
      assertCompanyWide(grant);
      const { status, view } = await submitBatch(db, files, scanner, grant, CITY_IMPORT_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get(`${CITY_IMPORTS}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await jobView(db, await create(request, id), CITY_IMPORT_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  batchFollowUpRoutes(app, { db, files, scanner, path: CITY_IMPORTS, spec: CITY_IMPORT_SPEC, readGrant: (request) => create(request), submitGrant: (request, id) => create(request, id) });

  app.post(`${CITY_IMPORTS}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await create(request, id);
    assertCompanyWide(grant);
    return commitBatch(db, files, grant, CITY_IMPORT_SPEC, id);
  });

  app.post(`${CITY_IMPORTS}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return cancelBatch(db, await create(request, id), CITY_IMPORT_SPEC.kind, id);
  });
}
