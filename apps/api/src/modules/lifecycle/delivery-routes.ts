// HTTP routes of in-app delivery (FR-018, FR-054; DF09; BR-053; docs/03 I-81 item 9): HR sends a letter or a settlement statement
// to the employee's own self-service; the employee reads their own deliveries in the Employee OWN context. Nothing is e-mailed.
import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { downloadHeaders, type FileStore } from '../../storage/files.js';
import { deliveriesOf, ownDeliveries, ownDeliveryFile, sendLetter, sendSettlementStatement, type StatementFormat } from './delivery.js';
import { assertInScope, assertNotSelf } from './common.js';
import { idempotencyKey, idParams, uuid } from './process-routes.js';

export async function deliveryRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore }): Promise<void> {
  const { db, files } = opts;

  // FR-018: the reviewed recipient is the letter's own employee; the key makes a retried send return the delivery it made.
  app.post(
    '/letter-outputs/:id/send',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['recipientEmployeeId'], properties: { recipientEmployeeId: uuid, idempotencyKey } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'letter', 'send', ['letter'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => sendLetter(tx, grant, id, request.body as { recipientEmployeeId: string; idempotencyKey?: string }));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  app.get('/letter-outputs/:id/deliveries', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'letter', 'read', ['letter'], { requireAll: true, recordKey: id });
    const owner = (await db.query<{ employee_id: string }>(`select employee_id from letter_output where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
    if (!owner) return { items: [] };
    await assertInScope(db, grant, owner.employee_id);
    assertNotSelf(grant, owner.employee_id);
    return { items: await deliveriesOf(db, grant.companyId, { letterOutputId: id }) };
  });

  // FR-054 "Send PDF" / "Send Excel": the approved statement to the employee's own self-service.
  app.post(
    '/settlements/:id/send',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['format', 'recipientEmployeeId'],
          properties: { format: { type: 'string', enum: ['PDF', 'XLSX'] }, recipientEmployeeId: uuid, idempotencyKey },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'settlement', 'send', ['amount'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => sendSettlementStatement(tx, grant, files, id, request.body as { format: StatementFormat; recipientEmployeeId: string; idempotencyKey?: string }));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  app.get('/settlements/:id/deliveries', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'settlement', 'read', ['amount'], { requireAll: true, recordKey: id });
    const owner = (await db.query<{ employee_id: string }>(`select employee_id from settlement where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
    if (!owner) return { items: [] };
    await assertInScope(db, grant, owner.employee_id);
    assertNotSelf(grant, owner.employee_id);
    return { items: await deliveriesOf(db, grant.companyId, { settlementId: id }) };
  });

  // BR-053 own outputs: the employee's delivered letters and statements, also after leaving (I-81 item 4).
  app.get('/me/deliveries', async (request) => ownDeliveries(db, await requireAccess(db, request, 'own_delivery', 'read', ['delivery'], { requireAll: true })));

  app.get('/me/deliveries/:id/file', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'own_delivery', 'read', ['delivery'], { requireAll: true, recordKey: id });
    const file = await withTransaction(db, (tx) => ownDeliveryFile(tx, grant, files, id));
    reply.headers(downloadHeaders({ mediaType: file.mediaType, fileName: file.fileName }, 'document'));
    return file.bytes;
  });
}
