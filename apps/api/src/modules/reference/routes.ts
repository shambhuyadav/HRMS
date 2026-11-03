// DF04 controlled lists of registered modules as form choices (GET /v1/reference-values?category=...). A module names
// in its registration which of its lists are served and under which permission (the permission of the form that
// offers the list, as the hiring and lifecycle form-choice routes do). Only the lists of modules active in this run are
// served (registry.ts): a list of an inactive module is not found here even where its values were seeded earlier, nor
// is a core list or a list no module names. The answer is the caller's company's active values.
import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { type PermissionKey, parsePermissionKey } from '../access/baseline.js';
import { MODULE_REGISTRATIONS } from '../registry.js';
import type { ModuleRegistration } from '../registry-types.js';
import { createReferenceValue, listReferenceCategories, listReferenceValues, type NewReferenceValue, type ReferenceValuePatch, updateReferenceValue } from './maintenance.js';

/** The lists the given registrations serve (category -> permission); a reader for a list a module does not seed is a programming error. */
export function servedReferenceLists(registrations: readonly ModuleRegistration[]): ReadonlyMap<string, PermissionKey> {
  const served = new Map<string, PermissionKey>();
  for (const m of registrations) {
    for (const [category, permission] of Object.entries(m.referenceReaders ?? {})) {
      if (!m.referenceValues?.[category]) throw new Error(`Module ${m.key} serves ${category}, which it does not seed`);
      if (served.has(category)) throw new Error(`Reference list ${category} is served by more than one module`);
      served.set(category, permission);
    }
  }
  return served;
}

const SERVED = servedReferenceLists(MODULE_REGISTRATIONS);

const categoryField = { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' } as const;
const labelField = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } as const;
const date = { type: 'string', format: 'date' } as const;
const nullableDate = { type: ['string', 'null'], format: 'date' } as const;

const adminListQuery = {
  type: 'object',
  additionalProperties: false,
  required: ['category'],
  properties: { category: categoryField, includeInactive: { type: 'boolean', default: false }, validOn: date },
} as const;

const createBody = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'code', 'label'],
  properties: { category: categoryField, code: { type: 'string', pattern: '^\\s*[A-Za-z0-9][A-Za-z0-9_]{0,59}\\s*$' }, label: labelField, validFrom: date, validTo: date },
} as const;

const updateBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  minProperties: 2,
  properties: { expectedVersion: { type: 'integer', minimum: 1 }, label: labelField, active: { type: 'boolean' }, validFrom: nullableDate, validTo: nullableDate },
} as const;

export async function referenceValueRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.get(
    '/reference-values',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['category'],
          properties: { category: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' } },
        },
      },
    },
    async (request) => {
      const { category } = request.query as { category: string };
      const permission = SERVED.get(category);
      if (!permission) throw notFound();
      const { resource, action, fieldGroup } = parsePermissionKey(permission);
      const grant = await requireAccess(db, request, resource, action, [fieldGroup], { requireAll: true });
      const rows = await db.query<{ code: string; label: string }>(
        `select code, label from reference_value_in_force where company_id = $1 and category = $2 order by label, code`,
        [grant.companyId, category],
      );
      return { category, items: rows.rows };
    },
  );

  // FR-004, DF04: the company's own lists. Writes re-check the permission inside their transaction (maintenance.ts).
  app.get('/reference-admin/categories', async (request) => {
    const grant = await requireAccess(db, request, 'reference_value', 'read', ['operational']);
    return listReferenceCategories(db, grant);
  });

  app.get('/reference-admin/values', { schema: { querystring: adminListQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'reference_value', 'read', ['operational']);
    return listReferenceValues(db, grant, request.query as { category: string; includeInactive: boolean; validOn?: string });
  });

  app.post('/reference-admin/values', { schema: { body: createBody } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'reference_value', 'manage', ['operational'], { requireAll: true });
    const created = await withTransaction(db, (tx) => createReferenceValue(tx, grant, request.body as NewReferenceValue));
    reply.status(201);
    return created;
  });

  app.patch('/reference-admin/values/:id', { schema: { params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } }, body: updateBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'reference_value', 'manage', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => updateReferenceValue(tx, grant, id, request.body as ReferenceValuePatch));
  });
}
