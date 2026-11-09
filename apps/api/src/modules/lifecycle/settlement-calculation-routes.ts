// HTTP routes of the FR-052 settlement calculation (decided under owner delegation, 6 Nov 2026; docs/03 I-88): the calculate step and
// its snapshots (settlement amount group), the notice recovery waiver (its own confidential right), the dated settlement policy (payroll
// configuration rights, written by one person and activated by another) and the statutory rule pack registry (validated by one
// authorised person and activated by another).
import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { activatePack, createPackRevision, ensureStatutoryPacks, listPacks, type NewPackRevision, validatePack } from '../statutory/rule-packs.js';
import { expectedVersion, idParams, reason } from './process-routes.js';
import { calculateSettlement, settlementCalculations, waiveNoticeRecovery } from './settlement-calculation.js';
import { activateSettlementPolicy, createSettlementPolicy, listSettlementPolicies, RATE_BASES, type SettlementPolicyInput } from './settlement-policy.js';

const version = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } as const;
const componentCode = { type: ['string', 'null'], maxLength: 40 } as const;
const divisor = { type: 'integer', minimum: 1, maximum: 31 } as const;

export async function settlementCalculationRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  type Req = Parameters<typeof requireAccess>[1];

  // FR-052: the draft's preparer calculates it from a snapshot taken now; a recalculation is a new snapshot.
  app.post('/settlements/:id/calculate', { schema: { params: idParams, body: version } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'settlement', 'prepare', ['amount'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => calculateSettlement(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.get('/settlements/:id/calculations', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return settlementCalculations(db, await requireAccess(db, request, 'settlement', 'read', ['operational', 'amount'], { requireAll: true, recordKey: id }), id);
  });

  // F1 notice: waived with a reason by someone holding the waiver right (never a default duty), not the employee or the preparer.
  app.post(
    '/exit-cases/:id/notice-waiver',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'settlement', 'waive_notice', ['amount'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => waiveNoticeRecovery(tx, grant, id, request.body as { reason: string }));
      reply.status(201);
      return result;
    },
  );

  // The dated settlement policy (payroll configuration).
  const config = (request: Req, action: 'read' | 'manage' | 'activate') => requireAccess(db, request, 'payroll_config', action, ['operational'], { requireAll: true });
  app.get('/settlements/policies', async (request) => listSettlementPolicies(db, await config(request, 'read')));
  app.post(
    '/settlements/policies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveFrom', 'basicComponentCode'],
          properties: {
            effectiveFrom: { type: 'string', format: 'date' },
            basicComponentCode: { type: 'string', minLength: 1, maxLength: 40 },
            daComponentCode: componentCode,
            encashmentComponentCode: componentCode,
            encashmentRateBasis: { type: 'string', enum: [...RATE_BASES] },
            encashmentDivisor: divisor,
            encashable: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['leaveType'],
                properties: { leaveType: { type: 'string', minLength: 1, maxLength: 40 }, maxUnits: { type: 'string', pattern: '^\\d{1,4}(\\.\\d{1,4})?$' } },
              },
            },
            noticeComponentCode: componentCode,
            noticeRateBasis: { type: 'string', enum: [...RATE_BASES] },
            noticeDivisor: divisor,
            gratuityComponentCode: componentCode,
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => createSettlementPolicy(tx, grant, request.body as SettlementPolicyInput));
      reply.status(201);
      return result;
    },
  );
  app.post('/settlements/policies/:id/activate', { schema: { params: idParams, body: version } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await config(request, 'activate');
    return withTransaction(db, (tx) => activateSettlementPolicy(tx, grant, id, request.body as { expectedVersion: number }));
  });

  // The statutory rule pack registry. Reading starts a company from the seeded drafts (idempotent), so the list is never empty.
  app.get('/statutory-rule-packs', async (request) => {
    const grant = await requireAccess(db, request, 'statutory_pack', 'read', ['operational'], { requireAll: true });
    await withTransaction(db, (tx) => ensureStatutoryPacks(tx, grant.companyId));
    return listPacks(db, grant);
  });
  app.post(
    '/statutory-rule-packs',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'effectiveFrom', 'currencyCode', 'parameters', 'statuteReference'],
          properties: {
            code: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,39}$' },
            effectiveFrom: { type: 'string', format: 'date' },
            currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' },
            parameters: { type: 'object' },
            statuteReference: { type: 'string', minLength: 1, maxLength: 1000 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'statutory_pack', 'validate', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => createPackRevision(tx, grant, request.body as NewPackRevision));
      reply.status(201);
      return result;
    },
  );
  app.post(
    '/statutory-rule-packs/:id/validate',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sourceReference', 'validationReference', 'expectedVersion'],
          properties: { sourceReference: { type: 'string', minLength: 1, maxLength: 500 }, validationReference: { type: 'string', minLength: 1, maxLength: 500 }, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'statutory_pack', 'validate', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => validatePack(tx, grant, id, request.body as { sourceReference: string; validationReference: string; expectedVersion: number }));
    },
  );
  app.post('/statutory-rule-packs/:id/activate', { schema: { params: idParams, body: version } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'statutory_pack', 'activate', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => activatePack(tx, grant, id, request.body as { expectedVersion: number }));
  });
}
