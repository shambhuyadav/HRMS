import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import { evidenceContent } from '../employee/evidence.js';
import { CATEGORIES } from './fields.js';
import {
  createDraft,
  type DecisionInput,
  decideChange,
  type DraftInput,
  listChanges,
  listOwnChanges,
  ownPrivateProfile,
  privateProfile,
  reviewTasks,
  reviseChange,
  startReview,
  submitChange,
  updateDraft,
  withdrawChange,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
// Values are checked against the field dictionary by the service; the schema only bounds the shape.
const values = { type: 'object', minProperties: 1, maxProperties: 20, additionalProperties: { anyOf: [{ type: 'string', maxLength: 300 }, { type: 'null' }] } } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const evidence = { type: 'array', maxItems: 10, uniqueItems: true, items: uuid } as const;
const version = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion: { type: 'integer', minimum: 1 } } } as const;

export async function sensitiveChangeRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore }): Promise<void> {
  const { db, files } = opts;
  // The employee's own details and requests (H1/BR-053 Employee OWN context; BR-055).
  const own = (request: Parameters<typeof requireAccess>[1], action: 'submit' | 'read', recordKey?: string) =>
    requireAccess(db, request, 'sensitive_change', action, ['private'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.get('/me/private-profile', async (request) => {
    const grant = await requireAccess(db, request, 'employee', 'read', ['private']);
    return ownPrivateProfile(db, grant);
  });

  app.get('/me/sensitive-changes', async (request) => listOwnChanges(db, await own(request, 'read')));

  app.post(
    '/me/sensitive-changes',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['category', 'values', 'reason'],
          properties: { category: { type: 'string', enum: [...CATEGORIES] }, effectiveDate: date, values, reason, evidenceDocumentIds: evidence },
        },
      },
    },
    async (request, reply) => {
      const grant = await own(request, 'submit');
      const result = await withTransaction(db, (tx) => createDraft(tx, grant, request.body as DraftInput));
      reply.status(201);
      return result;
    },
  );

  app.put(
    '/me/sensitive-changes/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['values', 'reason', 'expectedVersion'],
          properties: { effectiveDate: date, values, reason, evidenceDocumentIds: evidence, expectedVersion: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await own(request, 'submit', id);
      return withTransaction(db, (tx) => updateDraft(tx, grant, id, request.body as Omit<DraftInput, 'category'> & { expectedVersion: number }));
    },
  );

  app.post('/me/sensitive-changes/:id/submit', { schema: { params: idParams, body: version } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await own(request, 'submit', id);
    return withTransaction(db, (tx) => submitChange(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post('/me/sensitive-changes/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await own(request, 'submit', id);
    return withTransaction(db, (tx) => withdrawChange(tx, grant, id));
  });

  app.post('/me/sensitive-changes/:id/revise', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await own(request, 'submit', id);
    const result = await withTransaction(db, (tx) => reviseChange(tx, grant, id));
    reply.status(201);
    return result;
  });

  // Independent HR review (FR-104/105).
  app.get('/sensitive-changes/tasks/mine', async (request) => {
    const grant = await requireAccess(db, request, 'sensitive_change', 'review', ['private'], { requireAll: true });
    return reviewTasks(db, grant);
  });

  app.post('/sensitive-changes/tasks/:id/start-review', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'sensitive_change', 'review', ['private'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => startReview(tx, grant, id));
  });

  app.post(
    '/sensitive-changes/tasks/:id/decision',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'idempotencyKey'],
          properties: {
            decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] },
            reason,
            employeeMessage: reason,
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'sensitive_change', 'review', ['private'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideChange(tx, grant, id, request.body as DecisionInput));
    },
  );

  // FR-106: a released evidence file, for the employee or a reviewer assigned to this request.
  app.get(
    '/sensitive-changes/:id/evidence/:documentId/content',
    { schema: { params: { type: 'object', required: ['id', 'documentId'], properties: { id: uuid, documentId: uuid } } } },
    async (request, reply) => {
      const { id, documentId } = request.params as { id: string; documentId: string };
      const grant = await requireAccess(db, request, 'sensitive_change', 'read', ['private'], { requireAll: true, recordKey: documentId });
      const target = (await db.query<{ transaction_id: string }>(`select transaction_id from employee_sensitive_change_request where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
      if (!target) throw notFound();
      const { headers, bytes } = await evidenceContent(db, files, grant, {
        transactionId: target.transaction_id,
        documentId,
        linked: async (q) =>
          ((await q.query(`select 1 from employee_sensitive_change_evidence where company_id = $1 and request_id = $2 and document_id = $3`, [grant.companyId, id, documentId])).rowCount ?? 0) > 0,
      });
      reply.headers(headers);
      return bytes;
    },
  );

  // Eligible Admin reads within row scope (bank values in full need the bank group).
  app.get('/employees/:id/private-profile', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'read', ['private', 'bank'], { recordKey: id });
    return privateProfile(db, grant, id);
  });

  // The change history; a BANK account identifier in full needs the open review, or the bank group for the account in force (listChanges).
  app.get('/employees/:id/sensitive-changes', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'sensitive_change', 'read', ['private'], { requireAll: true, recordKey: id });
    return listChanges(db, grant, id);
  });
}
