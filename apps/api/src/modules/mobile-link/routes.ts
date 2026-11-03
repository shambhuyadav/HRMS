import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { decideLink, listEmployeeLinks, listLinks, requestLink, revokeLink } from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;

export async function mobileLinkRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // An employee asks for their own link; HR may ask for an employee in scope. Either way it waits for review.
  app.post(
    '/mobile-links',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['appAccountRef'],
          properties: { employeeId: uuid, appAccountRef: { type: 'string', pattern: '^[A-Za-z0-9._:@-]{3,200}$' } },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'mobile_link', 'request', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => requestLink(tx, grant, request.body as { employeeId?: string; appAccountRef: string }));
      reply.status(201);
      return result;
    },
  );

  app.get('/employees/:id/mobile-links', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'mobile_link', 'read', ['operational'], { recordKey: id });
    return listEmployeeLinks(db, grant, id);
  });

  app.get(
    '/mobile-links',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: ['PENDING', 'ACTIVE', 'REJECTED', 'REVOKED'] } } } } },
    async (request) => {
      const grant = await requireAccess(db, request, 'mobile_link', 'approve', ['operational']);
      return listLinks(db, grant, (request.query as { state?: string }).state);
    },
  );

  app.post(
    '/mobile-links/:id/decision',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'decision'], properties: { expectedVersion, decision: { type: 'string', enum: ['APPROVE', 'REJECT'] } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'mobile_link', 'approve', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideLink(tx, grant, id, request.body as { expectedVersion: number; decision: 'APPROVE' | 'REJECT' }));
    },
  );

  app.post(
    '/mobile-links/:id/revoke',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'reason'], properties: { expectedVersion, reason: { type: 'string', minLength: 1, maxLength: 1000 } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'mobile_link', 'approve', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => revokeLink(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
    },
  );
}
