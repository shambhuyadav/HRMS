import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { myOpenTasks } from '../workflow/engine.js';
import { attentionList, cancelConfirmation, type ConfirmationView, decideConfirmation, getConfirmation, listConfirmations, openConfirmation, type Recommendation, recommend } from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

const recommendSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'recommendation', 'reason'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    recommendation: { type: 'string', enum: ['CONFIRM', 'EXTEND'] },
    effectiveDate: { type: 'string', format: 'date' },
    extensionMonths: { type: 'integer', minimum: 1, maximum: 12 },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
  },
} as const;

const cancelSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'reason'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
  },
} as const;

const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'reason', 'idempotencyKey'],
  properties: {
    decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
  },
} as const;

export async function confirmationRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.post(
    '/confirmations',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['employeeId'], properties: { employeeId: uuid } } } },
    async (request, reply) => {
      const { employeeId } = request.body as { employeeId: string };
      const grant = await requireAccess(db, request, 'confirmation', 'manage', ['operational'], { requireAll: true, recordKey: employeeId });
      const result = await withTransaction(db, (tx) => openConfirmation(tx, grant, employeeId));
      reply.status(201);
      return result;
    },
  );

  app.get(
    '/confirmations',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { view: { type: 'string', enum: ['UPCOMING', 'DUE', 'OVERDUE', 'EXTENDED', 'CONFIRMED', 'ALL', 'DUE_WITHIN_30'], default: 'ALL' } },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'confirmation', 'read', ['operational']);
      return listConfirmations(db, grant, (request.query as { view: ConfirmationView }).view);
    },
  );

  // FR-082: missing policy or reviewer, reported for HR review (the HR duty that opens cases), never auto-resolved.
  app.get('/confirmations/attention', async (request) => {
    const grant = await requireAccess(db, request, 'confirmation', 'manage', ['operational']);
    return attentionList(db, grant);
  });

  app.get('/confirmations/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    // Action reasons are a separate confidential group; the case itself is operational (DF02, DF11).
    const grant = await requireAccess(db, request, 'confirmation', 'read', ['operational', 'reason'], { recordKey: id });
    return getConfirmation(db, grant, id);
  });

  app.post('/confirmations/:id/recommendation', { schema: { params: idParams, body: recommendSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'confirmation', 'recommend', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => recommend(tx, grant, id, request.body as Recommendation));
  });

  // FR-082, DF11: HR cancels a live review with a reason; its pending decision task closes with it.
  app.post('/confirmations/:id/cancel', { schema: { params: idParams, body: cancelSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'confirmation', 'manage', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => cancelConfirmation(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
  });

  app.get('/confirmations/tasks/mine', async (request) => {
    const grant = await requireAccess(db, request, 'confirmation', 'decide', ['operational']);
    return myOpenTasks(db, grant, 'employee_confirmation');
  });

  app.post('/confirmations/tasks/:id/decision', { schema: { params: idParams, body: decisionSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'confirmation', 'decide', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => decideConfirmation(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason: string; idempotencyKey: string }));
  });
}
