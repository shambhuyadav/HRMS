// Later-period payroll cases over HTTP (FR-035; FR-100; DB111; H2; H3 TN13; H7). Every handler calls requireAccess first; row
// scope, own-record refusal and independence are checked by the services, which re-resolve authority inside their transaction.
import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import {
  adjustmentCandidates,
  adjustmentDetail,
  adjustmentTasks,
  decideAdjustment,
  type Figures,
  listAdjustments,
  openAdjustment,
  ownAdjustments,
  submitAdjustment,
  updateAdjustment,
} from './adjustments.js';
import { arrearsCandidates, arrearsDetail, type ArrearsInput, arrearsTasks, decideArrears, listArrears, proposeArrears } from './arrears.js';
import { activateValuationPolicy, createValuationPolicy, listValuationPolicies, type ValuationPolicyInput } from './policy.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const decisionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'idempotencyKey'],
  properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] }, reason: { type: 'string', minLength: 1, maxLength: 1000 }, idempotencyKey },
} as const;
const figures = {
  previousRecognizedUnits: { type: ['string', 'null'], maxLength: 20 },
  correctedUnits: { type: ['string', 'null'], maxLength: 20 },
  deltaAmount: { type: ['string', 'null'], maxLength: 25 },
  explanation: { type: ['string', 'null'], maxLength: 2000 },
} as const;
const filter = (states: readonly string[]) =>
  ({ type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: [...states] }, employeeId: uuid, ...optionalPaging } }) as const;
const employeeFilter = { type: 'object', additionalProperties: false, properties: { employeeId: uuid, ...optionalPaging } } as const;

export async function payrollAdjustmentRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  type Req = Parameters<typeof requireAccess>[1];
  const adjustment = (request: Req, action: 'read' | 'propose' | 'decide', recordKey?: string) =>
    requireAccess(db, request, 'payroll_adjustment', action, ['amount'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const arrears = (request: Req, action: 'read' | 'propose' | 'decide', recordKey?: string) =>
    requireAccess(db, request, 'payroll_arrears', action, ['amount'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  // FR-100 cases and H7 later-period adjustment list.
  app.get('/payroll/adjustments', { schema: { querystring: filter(['DRAFT', 'SUBMITTED', 'APPROVED', 'APPLIED', 'RETURNED', 'REJECTED', 'VOID']) } }, async (request) =>
    listAdjustments(db, await adjustment(request, 'read'), request.query as { state?: string; employeeId?: string } & Paging),
  );
  app.get('/payroll/adjustments/candidates', { schema: { querystring: employeeFilter } }, async (request) =>
    adjustmentCandidates(db, await adjustment(request, 'read'), request.query as { employeeId?: string } & Paging),
  );
  app.get('/payroll/adjustments/tasks/mine', async (request) => adjustmentTasks(db, await adjustment(request, 'decide')));
  app.get('/payroll/adjustments/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return adjustmentDetail(db, await adjustment(request, 'read', id), id);
  });
  app.post(
    '/payroll/adjustments',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['timesheetId', 'revision', 'originRecordId'],
          properties: { timesheetId: uuid, revision: { type: 'integer', minimum: 1 }, originRecordId: uuid, ...figures },
        },
      },
    },
    async (request, reply) => {
      const grant = await adjustment(request, 'propose');
      const result = await withTransaction(db, (tx) => openAdjustment(tx, grant, request.body as { timesheetId: string; revision: number; originRecordId: string } & Figures));
      reply.status(201);
      return result;
    },
  );
  app.put(
    '/payroll/adjustments/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion, ...figures } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await adjustment(request, 'propose', id);
      return withTransaction(db, (tx) => updateAdjustment(tx, grant, id, request.body as { expectedVersion: number } & Figures));
    },
  );
  app.post(
    '/payroll/adjustments/:id/submit',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await adjustment(request, 'propose', id);
      return withTransaction(db, (tx) => submitAdjustment(tx, grant, id, request.body as { expectedVersion: number }));
    },
  );
  app.post('/payroll/adjustment-tasks/:id/decision', { schema: { params: idParams, body: decisionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await adjustment(request, 'decide', id);
    return withTransaction(db, (tx) => decideAdjustment(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason?: string; idempotencyKey: string }));
  });

  // H3 TN13: the employee's own linked later-payroll adjustments, in the Employee OWN context.
  app.get('/me/payroll-adjustments', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { ...optionalPaging } } } }, async (request) =>
    ownAdjustments(db, await requireAccess(db, request, 'timesheet', 'read', ['operational']), request.query as Paging),
  );

  // I-79 valuation policy: payroll configuration duties (read, manage, activate), like the paid-day policy.
  const config = (request: Req, action: 'read' | 'manage' | 'activate') => requireAccess(db, request, 'payroll_config', action, ['operational'], { requireAll: true });
  app.get('/payroll/valuation-policies', async (request) => listValuationPolicies(db, await config(request, 'read')));
  app.post(
    '/payroll/valuation-policies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveFrom', 'arrearsComponentCode', 'adjustmentComponentCode', 'timesheetUnit'],
          properties: {
            effectiveFrom: { type: 'string', format: 'date' },
            arrearsComponentCode: { type: 'string', minLength: 1, maxLength: 40 },
            adjustmentComponentCode: { type: 'string', minLength: 1, maxLength: 40 },
            recoveryComponentCode: { type: ['string', 'null'], minLength: 1, maxLength: 40 },
            timesheetUnit: { type: 'string', enum: ['DAY', 'HOUR'] },
            hoursPerDay: { type: ['string', 'null'], maxLength: 6 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => createValuationPolicy(tx, grant, request.body as ValuationPolicyInput));
      reply.status(201);
      return result;
    },
  );
  app.post(
    '/payroll/valuation-policies/:id/activate',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await config(request, 'activate');
      return withTransaction(db, (tx) => activateValuationPolicy(tx, grant, id, request.body as { expectedVersion: number }));
    },
  );

  // FR-035 arrear register and cases.
  app.get('/payroll/arrears-cases', { schema: { querystring: filter(['SUBMITTED', 'APPROVED', 'APPLIED', 'RETURNED', 'REJECTED']) } }, async (request) =>
    listArrears(db, await arrears(request, 'read'), request.query as { state?: string; employeeId?: string } & Paging),
  );
  app.get('/payroll/arrears-cases/candidates', { schema: { querystring: employeeFilter } }, async (request) =>
    arrearsCandidates(db, await arrears(request, 'read'), request.query as { employeeId?: string } & Paging),
  );
  app.get('/payroll/arrears-cases/tasks/mine', async (request) => arrearsTasks(db, await arrears(request, 'decide')));
  app.get('/payroll/arrears-cases/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return arrearsDetail(db, await arrears(request, 'read', id), id);
  });
  app.post(
    '/payroll/arrears-cases',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          // `lines` is optional (I-79): the amounts are calculated; sent, they must equal the calculation.
          required: ['sourceRevisionId', 'originRecordId', 'reason', 'idempotencyKey'],
          properties: {
            sourceRevisionId: uuid,
            originRecordId: uuid,
            reason: { type: 'string', minLength: 1, maxLength: 2000 },
            idempotencyKey,
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['componentCode', 'amount'],
                properties: { componentCode: { type: 'string', minLength: 1, maxLength: 40 }, amount: { type: 'string', minLength: 1, maxLength: 25 } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await arrears(request, 'propose');
      const result = await withTransaction(db, (tx) => proposeArrears(tx, grant, request.body as ArrearsInput));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );
  app.post('/payroll/arrears-tasks/:id/decision', { schema: { params: idParams, body: decisionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await arrears(request, 'decide', id);
    return withTransaction(db, (tx) => decideArrears(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason?: string; idempotencyKey: string }));
  });
}
