// Mandatory employee document types (BRD coverage CL-150 "Employee Document Compliance", under FR-056 to FR-058; FR-010; DF04;
// migration 0261; decided under owner delegation, 6 Nov 2026). HR records which DOCUMENT_TYPE every employee must hold, for the
// whole company or for one EMPLOYMENT_TYPE, as dated configuration: a requirement starts today or later and is ended (never edited
// or deleted) from today or later with a reason, so the compliance report for an earlier day still reads that day's rules. The
// same type is not required twice over overlapping periods for the same employment type (or for all; the database refuses it).
// Company configuration, so it is kept from an unrestricted company-scope assignment, like company policies (policies.ts).
// Operational: codes, labels, dates and reasons; nothing about any employee.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';

const RESOURCE = 'document_requirement';
const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', format: 'date' } as const;
const code = { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_]{0,59}$' } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;

interface RequirementRow {
  id: string;
  documentType: { code: string; label: string };
  employmentType: { code: string; label: string } | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  inForceToday: boolean;
  reason: string;
  endReason: string | null;
  createdAt: string;
  createdBy: string;
  endedAt: string | null;
  endedBy: string | null;
  version: number;
}

const COLUMNS = `r.id, json_build_object('code', t.code, 'label', t.label) as "documentType",
       case when et.id is null then null else json_build_object('code', et.code, 'label', et.label) end as "employmentType",
       to_char(r.effective_from, 'YYYY-MM-DD') as "effectiveFrom", to_char(r.effective_to, 'YYYY-MM-DD') as "effectiveTo",
       (r.effective_from <= $2::date and (r.effective_to is null or r.effective_to > $2::date)) as "inForceToday",
       r.reason, r.end_reason as "endReason", r.created_at as "createdAt", r.created_by as "createdBy", r.ended_at as "endedAt", r.ended_by as "endedBy", r.version`;
const FROM = `document_requirement r
  join reference_value t on t.company_id = r.company_id and t.id = r.document_type_id
  left join reference_value et on et.company_id = r.company_id and et.id = r.employment_type_id`;

function isCompanyWide(grant: AccessGrant): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0;
}

/** Every requirement of the company (in force first, then future, then ended), with the choices the form offers. */
export async function listRequirements(db: Queryable, grant: AccessGrant) {
  const rows = (
    await db.query<RequirementRow>(
      `select ${COLUMNS} from ${FROM} where r.company_id = $1
        order by (r.effective_to is not null and r.effective_to <= $2::date), r.effective_from desc, t.label, et.label nulls first, r.id`,
      [grant.companyId, grant.businessDate],
    )
  ).rows;
  const options = async (category: string) =>
    (await db.query<{ code: string; label: string }>(`select code, label from reference_value_in_force where company_id = $1 and category = $2 order by label, code`, [grant.companyId, category])).rows;
  return { businessDate: grant.businessDate, items: rows, options: { documentTypes: await options('DOCUMENT_TYPE'), employmentTypes: await options('EMPLOYMENT_TYPE') } };
}

async function one(db: Queryable, grant: AccessGrant, id: string): Promise<RequirementRow> {
  const row = (await db.query<RequirementRow>(`select ${COLUMNS} from ${FROM} where r.company_id = $1 and r.id = $3`, [grant.companyId, grant.businessDate, id])).rows[0];
  if (!row) throw notFound();
  return row;
}

const overlapping = (err: unknown) => (err as { code?: string }).code === '23P01';

export async function addRequirement(tx: Queryable, grant: AccessGrant, input: { documentType: string; employmentType?: string; effectiveFrom: string; reason: string }) {
  if (input.effectiveFrom < grant.businessDate) throw new HttpError(422, 'EFFECTIVE_DATE_IN_PAST', 'A requirement starts today or later; earlier days keep the rules they had', { businessDate: grant.businessDate });
  const text = input.reason.trim();
  if (!text) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the document type becomes mandatory');
  const ref = async (category: string, value: string) =>
    (await tx.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = $2 and code = $3`, [grant.companyId, category, value.toUpperCase()])).rows[0]?.id;
  const typeId = await ref('DOCUMENT_TYPE', input.documentType);
  if (!typeId) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown or inactive document type', { field: 'documentType' });
  let employmentTypeId: string | null = null;
  if (input.employmentType) {
    employmentTypeId = (await ref('EMPLOYMENT_TYPE', input.employmentType)) ?? null;
    if (!employmentTypeId) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown or inactive employment type', { field: 'employmentType' });
  }
  let id: string;
  try {
    id = (
      await tx.query<{ id: string }>(
        `insert into document_requirement (company_id, document_type_id, employment_type_id, effective_from, reason, created_by, acting_assignment_id)
         values ($1, $2, $3, $4, $5, $6, $7) returning id`,
        [grant.companyId, typeId, employmentTypeId, input.effectiveFrom, text, grant.userId, grant.assignmentId],
      )
    ).rows[0]!.id;
  } catch (err) {
    if (overlapping(err)) throw new HttpError(409, 'OVERLAPPING_REQUIREMENT', 'This document type is already required for these employees over an overlapping period');
    throw err;
  }
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: RESOURCE,
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    after: { operational: { documentType: input.documentType.toUpperCase(), employmentType: input.employmentType?.toUpperCase() ?? null, effectiveFrom: input.effectiveFrom } },
    reason: text,
  });
  return one(tx, grant, id);
}

export async function endRequirement(tx: Queryable, grant: AccessGrant, id: string, input: { effectiveTo: string; reason: string; expectedVersion: number }) {
  const row = (
    await tx.query<{ effective_from: string; effective_to: string | null; version: number }>(
      `select to_char(effective_from, 'YYYY-MM-DD') as effective_from, to_char(effective_to, 'YYYY-MM-DD') as effective_to, version from document_requirement where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!row) throw notFound();
  if (row.version !== input.expectedVersion) throw new HttpError(409, 'VERSION_CONFLICT', 'The requirement changed meanwhile; reload it', { version: row.version });
  if (row.effective_to !== null) throw new HttpError(409, 'ALREADY_ENDED', 'This requirement has already ended');
  if (input.effectiveTo < grant.businessDate) throw new HttpError(422, 'EFFECTIVE_DATE_IN_PAST', 'A requirement ends today or later; earlier days keep the rules they had', { businessDate: grant.businessDate });
  // Ending on its own start day withdraws a requirement that has not begun.
  const effectiveTo = input.effectiveTo < row.effective_from ? row.effective_from : input.effectiveTo;
  const text = input.reason.trim();
  if (!text) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the requirement ends');
  await tx.query(
    `update document_requirement set effective_to = $3, end_reason = $4, ended_at = now(), ended_by = $5, version = version + 1 where company_id = $1 and id = $2`,
    [grant.companyId, id, effectiveTo, text, grant.userId],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: RESOURCE,
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'END',
    priorVersion: row.version,
    newVersion: row.version + 1,
    before: { operational: { effectiveTo: null } },
    after: { operational: { effectiveTo } },
    reason: text,
  });
  return one(tx, grant, id);
}

export async function documentRequirementRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  /** Company configuration is kept from an unrestricted company-scope assignment; a narrower one is a recorded denial (FR-098). */
  const manageGrant = async (request: FastifyRequest, recordKey?: string) => {
    const grant = await requireAccess(db, request, RESOURCE, 'manage', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
    if (!isCompanyWide(grant)) {
      await auditDenial(db, request, { resource: RESOURCE, action: 'manage', reason: 'OUT_OF_SCOPE', ...(recordKey ? { recordKey } : {}) });
      throw new HttpError(403, 'FORBIDDEN', 'Mandatory document types are kept from an unrestricted company-scope assignment');
    }
    return grant;
  };

  app.get('/document-requirements', async (request) => listRequirements(db, await requireAccess(db, request, RESOURCE, 'read', ['operational'], { requireAll: true })));

  app.post(
    '/document-requirements',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['documentType', 'effectiveFrom', 'reason'],
          properties: { documentType: code, employmentType: code, effectiveFrom: date, reason },
        },
      },
    },
    async (request, reply) => {
      const grant = await manageGrant(request);
      const created = await withTransaction(db, (tx) => addRequirement(tx, grant, request.body as { documentType: string; employmentType?: string; effectiveFrom: string; reason: string }));
      reply.status(201);
      return created;
    },
  );

  app.post(
    '/document-requirements/:id/end',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveTo', 'reason', 'expectedVersion'],
          properties: { effectiveTo: date, reason, expectedVersion: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await manageGrant(request, id);
      return withTransaction(db, (tx) => endRequirement(tx, grant, id, request.body as { effectiveTo: string; reason: string; expectedVersion: number }));
    },
  );
}
