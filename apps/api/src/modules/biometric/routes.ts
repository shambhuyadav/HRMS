// Biometric profile administration, mapping revisions, preview, employee links, runs and reprocessing
// (FR-086, FR-087, FR-088; DF13). Integration administration is an explicit grant bundle; configuration and
// credential references are never returned, logged or exported.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import { optionalPaging, type Paging } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import { createLink, endLink, listLinks, supersedeLink } from './links.js';
import { type FieldMapping, mapRecord, validateMappingSet } from './mapping.js';
import { type ExceptionFilters, listExceptions, listRuns, type RunFilters } from './run-list.js';
import { type BiometricProvider, correctEventTime, getRun, loadFields, reprocessEvent, runSync } from './sync.js';

export type ProviderRegistry = ReadonlyMap<string, BiometricProvider>;

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const ref = { type: 'string', minLength: 1, maxLength: 300 } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const date = { type: 'string', format: 'date' } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;

/** Any one of these reads the profile list: the mapping, link and monitor screens choose a profile from it. */
const BIOMETRIC_DUTIES = ['profile_manage', 'mapping_manage', 'employee_link_manage', 'sync_run', 'sync_exception_reprocess', 'read'] as const;

const fieldSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sourcePath', 'targetField', 'transformCode', 'required'],
  properties: {
    sourcePath: { type: 'string', maxLength: 200 },
    targetField: { type: 'string', enum: ['EMPLOYEE_KEY', 'PUNCH_INSTANT', 'DIRECTION', 'EVENT_KEY', 'DEVICE_ID'] },
    transformCode: { type: 'string', enum: ['IDENTITY', 'TRIM', 'UPPER', 'ENUM_MAP', 'PARSE_INSTANT'] },
    enumConfig: { type: 'object', additionalProperties: { type: 'string', maxLength: 20 }, maxProperties: 20 },
    required: { type: 'boolean' },
    defaultCode: { type: 'string', enum: ['IN', 'OUT'] },
  },
} as const;

function requireCompanyScope(grant: AccessGrant) {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

const profileAudit = (tx: Queryable, grant: AccessGrant, id: string, action: string, active: boolean, reasonText: string | null = null) =>
  writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'biometric_profile',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    before: { operational: { active: !active } },
    after: { operational: { active } },
    reason: reasonText,
  });

export async function biometricRoutes(app: FastifyInstance, opts: { db: Database; providers: ProviderRegistry }): Promise<void> {
  const { db, providers } = opts;

  /** The first biometric duty the selected assignment holds; with none, the usual audited refusal. */
  const anyBiometricDuty = async (request: FastifyRequest): Promise<AccessGrant> => {
    const { userId, companyId, assignmentId } = actorOf(request);
    if (assignmentId) {
      for (const action of BIOMETRIC_DUTIES) {
        const decision = await resolveAccess(db, { userId, companyId, assignmentId, resource: 'biometric', action, fieldGroups: ['operational'] });
        if (decision.allowed) return decision;
      }
    }
    return requireAccess(db, request, 'biometric', 'read', ['operational']);
  };

  app.post(
    '/biometric/profiles',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'name', 'requestConfigReference', 'authReference', 'providerTimezone', 'paginationMode', 'scheduleReference', 'lookbackMinutes'],
          properties: {
            code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            requestConfigReference: ref,
            authReference: ref,
            providerTimezone: { type: 'string', minLength: 1, maxLength: 64 },
            paginationMode: { type: 'string', enum: ['CURSOR', 'PAGE_NUMBER'] },
            scheduleReference: ref,
            lookbackMinutes: { type: 'integer', minimum: 1, maximum: 20160 },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body as Record<string, string | number>;
      const grant = await requireAccess(db, request, 'biometric', 'profile_manage', ['operational'], { requireAll: true });
      requireCompanyScope(grant);
      const id = await withTransaction(db, async (tx) => {
        const created = (
          await tx.query<{ id: string }>(
            `insert into biometric_profile (company_id, code, name, request_config_reference, auth_reference, provider_timezone, pagination_mode,
                                            schedule_reference, lookback_minutes, active, created_by, updated_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $10) returning id`,
            [grant.companyId, b.code, b.name, b.requestConfigReference, b.authReference, b.providerTimezone, b.paginationMode, b.scheduleReference, b.lookbackMinutes, grant.userId],
          )
        ).rows[0]!.id;
        // Audit records that references were set, never their values.
        await writeAudit(tx, {
          companyId: grant.companyId,
          resource: 'biometric_profile',
          recordKey: created,
          actorUserId: grant.userId,
          actingAssignmentId: grant.assignmentId,
          action: 'CREATE',
          after: { operational: { code: b.code, providerTimezone: b.providerTimezone, configured: true } },
        });
        return created;
      });
      reply.status(201);
      return { id, active: false };
    },
  );

  app.get('/biometric/profiles', async (request) => {
    const grant = await anyBiometricDuty(request);
    const rows = await db.query(
      `select id, code, name, provider_timezone as "providerTimezone", pagination_mode as "paginationMode", lookback_minutes as "lookbackMinutes",
              active, synced_until as "syncedUntil", true as "requestConfigured", true as "credentialConfigured", version
         from biometric_profile where company_id = $1 order by code`,
      [grant.companyId],
    );
    return { items: rows.rows };
  });

  app.post(
    '/biometric/profiles/:id/mappings',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['dedupeStrategy', 'timestampRule', 'effectiveFrom', 'fields'],
          properties: {
            dedupeStrategy: { type: 'string', enum: ['PROVIDER_EVENT_KEY', 'FINGERPRINT'] },
            timestampRule: { type: 'string', enum: ['ISO_WITH_OFFSET', 'LOCAL_IN_PROVIDER_ZONE'] },
            effectiveFrom: { type: 'string', format: 'date-time' },
            fields: { type: 'array', minItems: 1, maxItems: 5, items: fieldSchema },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const b = request.body as { dedupeStrategy: 'PROVIDER_EVENT_KEY' | 'FINGERPRINT'; timestampRule: string; effectiveFrom: string; fields: FieldMapping[] };
      const grant = await requireAccess(db, request, 'biometric', 'mapping_manage', ['operational'], { requireAll: true, recordKey: id });
      requireCompanyScope(grant);
      const errors = validateMappingSet(b.fields, b.dedupeStrategy);
      if (errors.length) throw new HttpError(422, 'MAPPING_INVALID', 'The mapping cannot be used', { errors });
      const revisionId = await withTransaction(db, async (tx) => {
        const exists = await tx.query(`select 1 from biometric_profile where company_id = $1 and id = $2`, [grant.companyId, id]);
        if (!exists.rowCount) throw notFound();
        const rev = (
          await tx.query<{ id: string }>(
            `insert into biometric_mapping_revision (company_id, profile_id, revision, effective_from, dedupe_strategy, timestamp_rule, created_by, updated_by)
             values ($1, $2, coalesce((select max(revision) from biometric_mapping_revision where company_id = $1 and profile_id = $2), 0) + 1, $3, $4, $5, $6, $6)
             returning id`,
            [grant.companyId, id, b.effectiveFrom, b.dedupeStrategy, b.timestampRule, grant.userId],
          )
        ).rows[0]!.id;
        for (const f of b.fields) {
          await tx.query(
            `insert into biometric_field_mapping (company_id, mapping_revision_id, source_path, target_field, transform_code, enum_config, required, default_code, created_by, updated_by)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
            [grant.companyId, rev, f.sourcePath, f.targetField, f.transformCode, f.enumConfig ?? null, f.required, f.defaultCode ?? null, grant.userId],
          );
        }
        return rev;
      });
      reply.status(201);
      return { mappingRevisionId: revisionId, approved: false };
    },
  );

  // The revisions of one profile, latest first, with their fields (FR-086 "versioned"). Whether the caller wrote each one
  // decides whether a screen offers its approval; the approval route refuses it anyway.
  app.get('/biometric/profiles/:id/mappings', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'biometric', 'mapping_manage', ['operational'], { recordKey: id });
    requireCompanyScope(grant);
    const profile = await db.query(`select 1 from biometric_profile where company_id = $1 and id = $2`, [grant.companyId, id]);
    if (!profile.rowCount) throw notFound();
    const revisions = (
      await db.query<{ id: string }>(
        `select id, revision, effective_from as "effectiveFrom", effective_to as "effectiveTo", dedupe_strategy as "dedupeStrategy", timestamp_rule as "timestampRule",
                approved_by is not null as approved, approved_at as "approvedAt", created_by = $3 as "ownRevision", version
           from biometric_mapping_revision where company_id = $1 and profile_id = $2 order by revision desc`,
        [grant.companyId, id, grant.userId],
      )
    ).rows;
    return { items: await Promise.all(revisions.map(async (r) => ({ ...r, fields: await loadFields(db, grant.companyId, r.id) }))) };
  });

  app.post('/biometric/mappings/:id/approve', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'biometric', 'mapping_manage', ['operational'], { requireAll: true, recordKey: id });
    requireCompanyScope(grant);
    await withTransaction(db, async (tx) => {
      await reassertAccess(tx, grant, 'biometric', 'mapping_manage', ['operational']);
      const m = (
        await tx.query<{ created_by: string | null; approved_by: string | null; profile_id: string; effective_from: Date; revision: number }>(
          `select created_by, approved_by, profile_id, effective_from, revision from biometric_mapping_revision where company_id = $1 and id = $2 for update`,
          [grant.companyId, id],
        )
      ).rows[0];
      if (!m) throw notFound();
      if (m.approved_by) throw new HttpError(409, 'INVALID_STATE', 'Already approved');
      if (m.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A mapping cannot be approved by its author');
      // BR-035, DF13 "changing it requires preview and revision activation": the revision in force ends where this one starts
      // (approved revisions never overlap, 0014). Runs stay pinned to the revision they used.
      const closed = await tx.query<{ revision: number }>(
        `update biometric_mapping_revision set effective_to = $4, updated_by = $5
          where company_id = $1 and profile_id = $2 and id <> $3 and approved_by is not null and effective_from < $4 and (effective_to is null or effective_to > $4) returning revision`,
        [grant.companyId, m.profile_id, id, m.effective_from, grant.userId],
      );
      await tx.query(`update biometric_mapping_revision set approved_by = $3, approved_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'biometric_mapping_revision',
        recordKey: id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'APPROVE',
        after: { operational: { revision: m.revision, effectiveFrom: m.effective_from.toISOString(), closedRevisions: closed.rows.map((r) => r.revision) } },
      });
    });
    return { mappingRevisionId: id, approved: true };
  });

  // Safe preview (DF13): maps sample records with a mapping revision and applies nothing.
  app.post(
    '/biometric/mappings/:id/preview',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['records'], properties: { records: { type: 'array', maxItems: 50 } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'biometric', 'mapping_manage', ['operational'], { recordKey: id });
      const rev = (await db.query<{ timestamp_rule: 'ISO_WITH_OFFSET' | 'LOCAL_IN_PROVIDER_ZONE' }>(`select timestamp_rule from biometric_mapping_revision where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
      if (!rev) throw notFound();
      const fields = await loadFields(db, grant.companyId, id);
      return { results: (request.body as { records: unknown[] }).records.map((r) => mapRecord(r, fields, rev.timestamp_rule)) };
    },
  );

  app.post('/biometric/profiles/:id/activate', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'biometric', 'profile_manage', ['operational'], { requireAll: true, recordKey: id });
    requireCompanyScope(grant);
    await withTransaction(db, async (tx) => {
      await reassertAccess(tx, grant, 'biometric', 'profile_manage', ['operational']);
      const ok = await tx.query(
        `select 1 from biometric_mapping_revision where company_id = $1 and profile_id = $2 and approved_by is not null
            and effective_from <= now() and (effective_to is null or effective_to > now())`,
        [grant.companyId, id],
      );
      if (!ok.rowCount) throw new HttpError(422, 'MAPPING_NOT_APPROVED', 'Activation needs an approved, effective mapping revision');
      const res = await tx.query(`update biometric_profile set active = true, updated_by = $3 where company_id = $1 and id = $2 and not active`, [grant.companyId, id, grant.userId]);
      if (res.rowCount) await profileAudit(tx, grant, id, 'ACTIVATE', true);
      else if (!(await tx.query(`select 1 from biometric_profile where company_id = $1 and id = $2`, [grant.companyId, id])).rowCount) throw notFound();
    });
    return { id, active: true };
  });

  // FR-088 "Disabling a profile stops new runs, not deletes prior punches": a run already under way finishes; nothing else changes.
  app.post(
    '/biometric/profiles/:id/disable',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason', 'expectedVersion'], properties: { reason, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const b = request.body as { reason: string; expectedVersion: number };
      const grant = await requireAccess(db, request, 'biometric', 'profile_manage', ['operational'], { requireAll: true, recordKey: id });
      requireCompanyScope(grant);
      await withTransaction(db, async (tx) => {
        await reassertAccess(tx, grant, 'biometric', 'profile_manage', ['operational']);
        const p = (await tx.query<{ active: boolean; version: number }>(`select active, version from biometric_profile where company_id = $1 and id = $2 for update`, [grant.companyId, id])).rows[0];
        if (!p) throw notFound();
        if (p.version !== b.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The profile changed; reload and retry');
        if (!p.active) throw new HttpError(409, 'INVALID_STATE', 'The profile is not active');
        await tx.query(`update biometric_profile set active = false, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
        await profileAudit(tx, grant, id, 'DISABLE', false, b.reason.trim());
      });
      return { id, active: false };
    },
  );

  app.get(
    '/biometric/profiles/:id/links',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', additionalProperties: false, properties: { current: { type: 'boolean' }, search: { type: 'string', maxLength: 100 }, ...optionalPaging } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'biometric', 'employee_link_manage', ['operational'], { recordKey: id });
      requireCompanyScope(grant);
      return listLinks(db, grant, id, request.query as { current?: boolean; search?: string } & Paging);
    },
  );

  app.post(
    '/biometric/profiles/:id/links',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['externalEmployeeKey', 'employeeId', 'effectiveFrom'],
          properties: { externalEmployeeKey: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }, employeeId: uuid, effectiveFrom: dateTime, effectiveTo: dateTime },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'biometric', 'employee_link_manage', ['operational'], { requireAll: true, recordKey: id });
      requireCompanyScope(grant);
      const created = await withTransaction(db, (tx) => createLink(tx, grant, id, request.body as { externalEmployeeKey: string; employeeId: string; effectiveFrom: string; effectiveTo?: string }));
      reply.status(201);
      return created;
    },
  );

  app.post(
    '/biometric/links/:id/end',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['effectiveTo', 'reason', 'expectedVersion'], properties: { effectiveTo: dateTime, reason, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'biometric', 'employee_link_manage', ['operational'], { requireAll: true, recordKey: id });
      requireCompanyScope(grant);
      return withTransaction(db, (tx) => endLink(tx, grant, id, request.body as { effectiveTo: string; reason: string; expectedVersion: number }));
    },
  );

  app.post(
    '/biometric/links/:id/supersede',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['employeeId', 'effectiveFrom', 'reason', 'expectedVersion'], properties: { employeeId: uuid, effectiveFrom: dateTime, reason, expectedVersion } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'biometric', 'employee_link_manage', ['operational'], { requireAll: true, recordKey: id });
      requireCompanyScope(grant);
      const created = await withTransaction(db, (tx) => supersedeLink(tx, grant, id, request.body as { employeeId: string; effectiveFrom: string; reason: string; expectedVersion: number }));
      reply.status(201);
      return created;
    },
  );

  app.post(
    '/biometric/profiles/:id/runs',
    {
      // Fetches every page of the window from the provider, one transaction each (docs/09 §8.2).
      config: { servingClass: 'batch' },
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['windowStart', 'windowEnd'],
          properties: { windowStart: { type: 'string', format: 'date-time' }, windowEnd: { type: 'string', format: 'date-time' } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const b = request.body as { windowStart: string; windowEnd: string };
      const grant = await requireAccess(db, request, 'biometric', 'sync_run', ['operational'], { requireAll: true, recordKey: id });
      requireCompanyScope(grant);
      const profile = (await db.query<{ code: string }>(`select code from biometric_profile where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
      if (!profile) throw notFound();
      const provider = providers.get(profile.code);
      // DF13: real connections need the private provider contract; without a registered adapter nothing runs.
      if (!provider) throw new HttpError(422, 'PROVIDER_NOT_CONFIGURED', 'No provider adapter is configured for this profile');
      return runSync(db, { companyId: grant.companyId, profileId: id, actorUserId: grant.userId, windowStart: new Date(b.windowStart), windowEnd: new Date(b.windowEnd) }, provider);
    },
  );

  // The Sync Monitor's run list, scheduled and manual; F2 "Failed integration runs": the list behind the System Administrator's
  // widget, with the same filters.
  app.get(
    '/biometric/runs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            failed: { type: 'boolean' },
            from: date,
            to: date,
            profileId: uuid,
            state: { type: 'string', enum: ['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'] },
            ...optionalPaging,
          },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'biometric', 'read', ['operational']);
      requireCompanyScope(grant);
      return listRuns(db, grant, request.query as RunFilters & Paging);
    },
  );

  // FR-087 "explicit rejected/quarantined records": what the Sync Monitor shows and what a reprocess or correction starts from.
  app.get(
    '/biometric/exceptions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            profileId: uuid,
            runId: uuid,
            outcome: { type: 'string', enum: ['REJECTED', 'QUARANTINED'] },
            failureCode: { type: 'string', pattern: '^[A-Z_:]{1,60}$' },
            open: { type: 'boolean' },
            ...optionalPaging,
          },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'biometric', 'read', ['operational']);
      requireCompanyScope(grant);
      return listExceptions(db, grant, request.query as ExceptionFilters & Paging);
    },
  );

  app.get('/biometric/runs/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'biometric', 'sync_run', ['operational'], { recordKey: id });
    return getRun(db, grant.companyId, id);
  });

  app.post('/biometric/events/:id/reprocess', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'biometric', 'sync_exception_reprocess', ['operational'], { requireAll: true, recordKey: id });
    requireCompanyScope(grant);
    return withTransaction(db, async (tx) => {
      await reassertAccess(tx, grant, 'biometric', 'sync_exception_reprocess', ['operational']);
      return reprocessEvent(tx, grant.companyId, id, grant.userId, grant.assignmentId);
    });
  });

  app.post(
    '/biometric/events/:id/correct',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['normalisedTime', 'reason'], properties: { normalisedTime: dateTime, reason } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'biometric', 'sync_exception_reprocess', ['operational'], { requireAll: true, recordKey: id });
      requireCompanyScope(grant);
      return withTransaction(db, async (tx) => {
        await reassertAccess(tx, grant, 'biometric', 'sync_exception_reprocess', ['operational']);
        return correctEventTime(tx, grant, id, request.body as { normalisedTime: string; reason: string });
      });
    },
  );
}
