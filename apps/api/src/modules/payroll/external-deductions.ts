// External deduction mapping (FR-028; FR-031; docs/10 A4a; migration 0213). Decided under owner delegation, 6 Nov 2026 (docs/03 I-91):
// an outside party's deduction code maps, from a date, to a pay component whose head is a DEDUCTION on the INPUT basis; one person drafts
// a mapping and another activates it, and a retired mapping ends the code. Payroll inputs may name the outside code instead of the
// component (inputs.ts checkLines, the PAYROLL_INPUTS_V2 import); resolveExternalCodes answers, per code and date, the component or the
// named reason it cannot be used. Nothing ever falls back to a default component.
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';
import { actorOf, audit, requireCompanyScope } from './common.js';

export const EXTERNAL_CODE = /^[A-Z][A-Z0-9_-]{0,39}$/;

const VIEW = `select x.id, x.external_code as "externalCode", x.name, pc.code as "componentCode", to_char(x.effective_from, 'YYYY-MM-DD') as "effectiveFrom", x.reason, x.state,
    x.created_by as "createdBy", x.activated_by as "activatedBy", x.activated_at as "activatedAt", x.retired_at as "retiredAt", x.version
  from payroll_external_deduction x join pay_component pc on pc.company_id = x.company_id and pc.id = x.component_id`;

const stale = (): never => {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
};

export type ExternalResolution = { componentCode: string } | { error: 'EXTERNAL_CODE_UNKNOWN' | 'EXTERNAL_CODE_UNMAPPED' | 'EXTERNAL_CODE_RETIRED' };

/**
 * Each (code, date) resolved through the mapping in force on that date: the active or retired mapping with the latest start on or
 * before it. Retired: the code is ended (EXTERNAL_CODE_RETIRED). No mapping of the code at all: EXTERNAL_CODE_UNKNOWN; mappings, but
 * none in force on the date: EXTERNAL_CODE_UNMAPPED. Keyed `${code}|${date}`.
 */
export async function resolveExternalCodes(db: Queryable, companyId: string, wanted: { code: string; date: string }[]): Promise<Map<string, ExternalResolution>> {
  const codes = [...new Set(wanted.map((w) => w.code))];
  const out = new Map<string, ExternalResolution>();
  if (codes.length === 0) return out;
  const rows = (
    await db.query<{ external_code: string; effective_from: string; state: string; component_code: string }>(
      `select x.external_code, to_char(x.effective_from, 'YYYY-MM-DD') as effective_from, x.state, pc.code as component_code
         from payroll_external_deduction x join pay_component pc on pc.company_id = x.company_id and pc.id = x.component_id
        where x.company_id = $1 and x.external_code = any($2::text[])
        order by x.external_code, x.effective_from desc`,
      [companyId, codes],
    )
  ).rows;
  for (const w of wanted) {
    const own = rows.filter((r) => r.external_code === w.code);
    const inForce = own.find((r) => (r.state === 'ACTIVE' || r.state === 'RETIRED') && r.effective_from <= w.date);
    out.set(
      `${w.code}|${w.date}`,
      own.length === 0 ? { error: 'EXTERNAL_CODE_UNKNOWN' } : !inForce ? { error: 'EXTERNAL_CODE_UNMAPPED' } : inForce.state === 'RETIRED' ? { error: 'EXTERNAL_CODE_RETIRED' } : { componentCode: inForce.component_code },
    );
  }
  return out;
}

export async function listExternalDeductions(db: Queryable, grant: AccessGrant) {
  return { items: (await db.query(`${VIEW} where x.company_id = $1 order by x.external_code, x.effective_from desc, x.created_at desc`, [grant.companyId])).rows };
}

/** The component of `code`, whose head in effect on `day` is a DEDUCTION on the INPUT basis (the amount is the outside party's). */
async function deductionComponent(tx: Queryable, companyId: string, code: string, day: string): Promise<string> {
  const c = (
    await tx.query<{ id: string; head_type: string | null; calculation_basis: string | null }>(
      `select pc.id, h.head_type, h.calculation_basis from pay_component pc
         left join lateral (select hr.head_type, hr.calculation_basis from payroll_head_revision hr
                             where hr.company_id = pc.company_id and hr.component_id = pc.id and hr.state = 'ACTIVE' and hr.effective_from <= $3::date and hr.in_use
                             order by hr.effective_from desc limit 1) h on true
        where pc.company_id = $1 and pc.code = $2 and pc.active`,
      [companyId, code.trim().toUpperCase(), day],
    )
  ).rows[0];
  if (!c) throw new HttpError(422, 'UNKNOWN_COMPONENT', 'The pay component does not exist or is not active', { field: 'componentCode' });
  if (c.head_type !== 'DEDUCTION' || c.calculation_basis !== 'INPUT') {
    throw new HttpError(422, 'COMPONENT_HEAD_INVALID', 'An external deduction maps to a component with a DEDUCTION head on the INPUT basis in effect from that date', { field: 'componentCode' });
  }
  return c.id;
}

export interface ExternalDeductionInput {
  externalCode: string;
  name: string;
  componentCode: string;
  effectiveFrom: string;
  reason: string;
}

export async function createExternalDeduction(tx: Queryable, grant: AccessGrant, input: ExternalDeductionInput) {
  requireCompanyScope(grant);
  await reassertAccess(tx, grant, 'payroll_config', 'manage', ['operational']);
  const code = input.externalCode.trim().toUpperCase();
  if (!EXTERNAL_CODE.test(code)) throw new HttpError(422, 'INVALID_CODE', 'An external code is letters, digits, underscores and hyphens, starting with a letter', { field: 'externalCode' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || Number.isNaN(Date.parse(`${input.effectiveFrom}T00:00:00Z`))) {
    throw new HttpError(422, 'INVALID_DATE', 'The start date is not a valid date', { field: 'effectiveFrom' });
  }
  const name = input.name.trim();
  const reason = input.reason.trim();
  if (!name || name.length > 200) throw new HttpError(422, 'NAME_REQUIRED', 'Name the outside deduction in at most 200 characters', { field: 'name' });
  if (!reason || reason.length > 500) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the code maps to this component, in at most 500 characters', { field: 'reason' });
  const componentId = await deductionComponent(tx, grant.companyId, input.componentCode, input.effectiveFrom);
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_external_deduction (company_id, external_code, name, component_id, effective_from, reason, created_by, updated_by)
       values ($1, $2, $3, $4, $5::date, $6, $7, $7) returning id`,
      [grant.companyId, code, name, componentId, input.effectiveFrom, reason, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_external_deduction', id, 'CREATE', null, { operational: { externalCode: code, componentCode: input.componentCode, effectiveFrom: input.effectiveFrom, state: 'DRAFT' } });
  return (await tx.query(`${VIEW} where x.company_id = $1 and x.id = $2`, [grant.companyId, id])).rows[0];
}

/** Activate (by someone other than its author; an active mapping of the same code and start is superseded), retire or cancel. */
export async function decideExternalDeduction(tx: Queryable, grant: AccessGrant, id: string, input: { action: 'ACTIVATE' | 'RETIRE' | 'CANCEL'; expectedVersion: number }) {
  requireCompanyScope(grant);
  await reassertAccess(tx, grant, 'payroll_config', 'activate', ['operational']);
  const x = (
    await tx.query<{ state: string; created_by: string; version: number; external_code: string; effective_from: string; component_code: string }>(
      `select x.state, x.created_by, x.version, x.external_code, to_char(x.effective_from, 'YYYY-MM-DD') as effective_from, pc.code as component_code
         from payroll_external_deduction x join pay_component pc on pc.company_id = x.company_id and pc.id = x.component_id
        where x.company_id = $1 and x.id = $2 for update of x`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!x) throw notFound();
  if (x.version !== input.expectedVersion) stale();
  let state: string;
  if (input.action === 'ACTIVATE') {
    if (x.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft mapping can be activated');
    if (x.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A mapping is activated by someone other than its author');
    // The component's head must still be right when the mapping takes effect.
    await deductionComponent(tx, grant.companyId, x.component_code, x.effective_from);
    await tx.query(
      `update payroll_external_deduction set state = 'SUPERSEDED', updated_by = $4 where company_id = $1 and external_code = $2 and effective_from = $3::date and state = 'ACTIVE'`,
      [grant.companyId, x.external_code, x.effective_from, grant.userId],
    );
    await tx.query(`update payroll_external_deduction set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
    state = 'ACTIVE';
  } else if (input.action === 'RETIRE') {
    if (x.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'Only an active mapping can be retired');
    await tx.query(`update payroll_external_deduction set state = 'RETIRED', retired_by = $3, retired_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
    state = 'RETIRED';
  } else {
    if (x.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft mapping can be cancelled');
    await tx.query(`update payroll_external_deduction set state = 'CANCELLED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
    state = 'CANCELLED';
  }
  await audit(tx, actorOf(grant), 'payroll_external_deduction', id, input.action, { operational: { state: x.state } }, { operational: { state } });
  return (await tx.query(`${VIEW} where x.company_id = $1 and x.id = $2`, [grant.companyId, id])).rows[0];
}

export async function externalDeductionRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  const config = (request: Parameters<typeof requireAccess>[1], action: 'read' | 'manage' | 'activate') =>
    requireAccess(db, request, 'payroll_config', action, ['operational'], { requireAll: true });
  app.get('/payroll/external-deductions', async (request) => listExternalDeductions(db, await config(request, 'read')));
  app.post(
    '/payroll/external-deductions',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['externalCode', 'name', 'componentCode', 'effectiveFrom', 'reason'],
          properties: {
            externalCode: { type: 'string', minLength: 1, maxLength: 40 },
            name: { type: 'string', minLength: 1, maxLength: 200 },
            componentCode: { type: 'string', minLength: 1, maxLength: 40 },
            effectiveFrom: { type: 'string', format: 'date' },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => createExternalDeduction(tx, grant, request.body as ExternalDeductionInput));
      reply.status(201);
      return result;
    },
  );
  app.post(
    '/payroll/external-deductions/:id/decision',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'expectedVersion'],
          properties: { action: { type: 'string', enum: ['ACTIVATE', 'RETIRE', 'CANCEL'] }, expectedVersion: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await config(request, 'activate');
      return withTransaction(db, (tx) => decideExternalDeduction(tx, grant, id, request.body as { action: 'ACTIVATE' | 'RETIRE' | 'CANCEL'; expectedVersion: number }));
    },
  );
}
