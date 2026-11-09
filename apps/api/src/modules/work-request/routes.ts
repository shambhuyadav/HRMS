import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import { evidenceContent, MAX_EVIDENCE_DOCUMENTS } from '../employee/evidence.js';
import { myOpenTasks } from '../workflow/engine.js';
import {
  cancelWorkRequest,
  decideWorkRequest,
  isWorkRequestKind,
  listEmployeeWorkRequests,
  listWorkRequests,
  resubmitWorkRequest,
  submitWorkRequest,
  WORK_REQUEST_KINDS,
  type WorkRequestInput,
  withdrawWorkRequest,
  withWorkTaskSummaries,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const time = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' } as const;
const kind = { type: 'string', enum: Object.keys(WORK_REQUEST_KINDS) } as const;
const kindParams = { type: 'object', required: ['kind'], properties: { kind } } as const;
const kindIdParams = { type: 'object', required: ['kind', 'id'], properties: { kind, id: uuid } } as const;
const fields = {
  startDate: date,
  endDate: date,
  startTime: time,
  endTime: time,
  purpose: { type: 'string', minLength: 1, maxLength: 1000 },
  evidenceDocumentIds: { type: 'array', maxItems: MAX_EVIDENCE_DOCUMENTS, uniqueItems: true, items: uuid },
} as const;
const body = { type: 'object', additionalProperties: false, required: ['startDate', 'endDate', 'purpose'], properties: fields } as const;

export async function workRequestRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore }): Promise<void> {
  const { db, files } = opts;
  const kindOf = (request: { params: unknown }) => {
    const k = (request.params as { kind: string }).kind;
    if (!isWorkRequestKind(k)) throw notFound();
    return k;
  };

  // DF03: only a new request names the rejected one it raises again; a correction of a returned request (PUT) cannot.
  app.post('/work-requests/:kind', { schema: { params: kindParams, body: { ...body, properties: { ...fields, predecessorRequestId: uuid } } } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'work_request', 'submit', ['operational'], { requireAll: true });
    const result = await withTransaction(db, (tx) => submitWorkRequest(tx, grant, kindOf(request), request.body as WorkRequestInput));
    reply.status(201);
    return { requestId: result.requestId, state: result.state };
  });

  app.put(
    '/work-requests/:kind/:id',
    { schema: { params: kindIdParams, body: { ...body, required: [...body.required, 'expectedVersion'], properties: { ...fields, expectedVersion: { type: 'integer', minimum: 1 } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'work_request', 'submit', ['operational'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => resubmitWorkRequest(tx, grant, kindOf(request), id, request.body as WorkRequestInput & { expectedVersion: number }));
      return { requestId: result.requestId, revision: result.revision, state: result.state };
    },
  );

  // FR-027 / FR-106: a released evidence file, for the requester or a reviewer assigned to this request.
  app.get(
    '/work-requests/:kind/:id/evidence/:documentId/content',
    { schema: { params: { type: 'object', required: ['kind', 'id', 'documentId'], properties: { kind, id: uuid, documentId: uuid } } } },
    async (request, reply) => {
      const { id, documentId } = request.params as { id: string; documentId: string };
      const k = kindOf(request);
      const grant = await requireAccess(db, request, 'work_request', 'read', ['operational'], { recordKey: documentId });
      const target = (
        await db.query<{ transaction_id: string }>(`select transaction_id from ${WORK_REQUEST_KINDS[k].table} where company_id = $1 and id = $2`, [grant.companyId, id])
      ).rows[0];
      if (!target) throw notFound();
      const { headers, bytes } = await evidenceContent(db, files, grant, {
        transactionId: target.transaction_id,
        documentId,
        linked: async (q) =>
          ((await q.query(`select 1 from transaction_evidence where company_id = $1 and transaction_id = $2 and document_id = $3`, [grant.companyId, target.transaction_id, documentId])).rowCount ?? 0) > 0,
      });
      reply.headers(headers);
      return bytes;
    },
  );

  app.post('/work-requests/:kind/:id/withdraw', { schema: { params: kindIdParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'work_request', 'withdraw', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawWorkRequest(tx, grant, kindOf(request), id));
  });

  // I-84 item 15: an approved request is cancelled with a reason, by its employee before its first day, or by HR (service.ts).
  const cancelBody = {
    type: 'object',
    additionalProperties: false,
    required: ['reason', 'expectedVersion'],
    properties: { reason: { type: 'string', minLength: 1, maxLength: 1000 }, expectedVersion: { type: 'integer', minimum: 1 } },
  } as const;
  app.post('/work-requests/:kind/:id/cancel', { schema: { params: kindIdParams, body: cancelBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'work_request', 'withdraw', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => cancelWorkRequest(tx, grant, kindOf(request), id, request.body as { reason: string; expectedVersion: number }, 'OWN'));
  });
  app.post('/work-requests/:kind/:id/cancel-for-employee', { schema: { params: kindIdParams, body: cancelBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'work_request', 'cancel', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => cancelWorkRequest(tx, grant, kindOf(request), id, request.body as { reason: string; expectedVersion: number }, 'HR'));
  });

  // Reviewers decide on the leave route with the leave decision duty (DF03).
  app.get('/work-requests/tasks/mine', async (request) => {
    const grant = await requireAccess(db, request, 'leave', 'approve', ['operational']);
    const lists = await Promise.all(Object.keys(WORK_REQUEST_KINDS).map((k) => myOpenTasks(db, grant, k)));
    const items = lists.flatMap((l) => l.items).sort((a, b) => new Date(a.assignedAt).getTime() - new Date(b.assignedAt).getTime());
    return { items: await withWorkTaskSummaries(db, grant, items as { transactionId: string; kind: string }[]) };
  });

  app.post(
    '/work-requests/tasks/:id/decision',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'idempotencyKey'],
          properties: {
            decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] },
            reason: { type: 'string', minLength: 1, maxLength: 1000 },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'leave', 'approve', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideWorkRequest(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason?: string; idempotencyKey: string }));
    },
  );

  app.get('/employees/:id/work-requests', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'work_request', 'read', ['operational'], { recordKey: id });
    return listEmployeeWorkRequests(db, grant, id);
  });

  // FR-027 HR views ("Leaves & Outdoor", "Work On Holiday"), within the selected assignment's scope.
  app.get(
    '/work-requests/:kind',
    {
      schema: {
        params: kindParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to'],
          properties: { from: date, to: date, state: { type: 'string', enum: ['SUBMITTED', 'RETURNED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] } },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'work_request', 'read', ['operational']);
      const q = request.query as { from: string; to: string; state?: string };
      return listWorkRequests(db, grant, { kind: kindOf(request), ...q });
    },
  );
}
