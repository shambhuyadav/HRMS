import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging } from '../../db/paging.js';
import type { Database } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { essIndex, ownRequests } from './service.js';

export async function essRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  // FR-103: every Employee holds the operational read of their own record; the tabs themselves are re-checked.
  app.get('/me/ess', async (request) => essIndex(db, await requireAccess(db, request, 'employee', 'read', ['operational'])));

  // FR-109: own requests of every kind with state, pending reviewer and decision history (no reviewer comments);
  // FR-056 paging (page/pageSize 25, 50 or 100, with the total; without them the former capped answer and the total).
  app.get(
    '/me/requests',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,59}$' }, ...optionalPaging } },
      },
    },
    async (request) => {
      const { kind, page, pageSize } = request.query as { kind?: string } & Paging;
      return ownRequests(db, await requireAccess(db, request, 'employee', 'read', ['operational']), kind, { page, pageSize });
    },
  );
}
