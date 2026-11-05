import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import {
  correctionTasks,
  decideCorrection,
  decideProfileChange,
  listCorrections,
  listProfileChanges,
  type ProfileChanges,
  profileChangeTasks,
  requestCorrection,
  requestProfileChange,
  withdrawCorrection,
  withdrawProfileChange,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const decisionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'idempotencyKey'],
  properties: {
    decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
  },
} as const;
type DecisionBody = { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason?: string; idempotencyKey: string };

export async function selfServiceRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // Profile change requests (FR-059, DF04).
  app.post(
    '/me/profile-changes',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            displayName: { type: 'string', minLength: 1, maxLength: 200 },
            workEmail: { type: 'string', minLength: 3, maxLength: 254 },
            // DF03: the rejected request this one raises again.
            predecessorRequestId: uuid,
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'profile_change', 'submit', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => requestProfileChange(tx, grant, request.body as ProfileChanges & { predecessorRequestId?: string }));
      reply.status(201);
      return result;
    },
  );

  app.get('/employees/:id/profile-changes', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'profile_change', 'read', ['operational'], { recordKey: id });
    return listProfileChanges(db, grant, id);
  });

  app.post('/profile-changes/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'profile_change', 'submit', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawProfileChange(tx, grant, id));
  });

  app.get('/profile-changes/tasks/mine', async (request) => {
    const grant = await requireAccess(db, request, 'employee', 'update', ['operational']);
    return profileChangeTasks(db, grant);
  });

  app.post('/profile-changes/tasks/:id/decision', { schema: { params: idParams, body: decisionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'update', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => decideProfileChange(tx, grant, id, request.body as DecisionBody));
  });

  // Attendance correction requests (FR-059, FR-021; DF03).
  app.post(
    '/me/attendance-corrections',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['attendanceRecordId', 'status', 'reason'],
          properties: { attendanceRecordId: uuid, status: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' }, reason: { type: 'string', minLength: 1, maxLength: 1000 }, predecessorRequestId: uuid },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'attendance', 'request_correction', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => requestCorrection(tx, grant, request.body as { attendanceRecordId: string; status: string; reason: string; predecessorRequestId?: string }));
      reply.status(201);
      return result;
    },
  );

  app.get('/employees/:id/attendance-corrections', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    // The employee's reason is a confidential group: shown only with an approved attendance reason grant.
    const grant = await requireAccess(db, request, 'attendance', 'read', ['operational', 'reason'], { recordKey: id });
    return listCorrections(db, grant, id);
  });

  app.post('/attendance-corrections/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'attendance', 'request_correction', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawCorrection(tx, grant, id));
  });

  app.get('/attendance-corrections/tasks/mine', async (request) => {
    const grant = await requireAccess(db, request, 'attendance', 'approve_correction', ['operational']);
    // A reviewer granted the attendance reason group also sees the employee's reason.
    const reasonGrant = await requireAccess(db, request, 'attendance', 'read', ['operational', 'reason']).catch(() => null);
    return correctionTasks(db, reasonGrant?.allowedFieldGroups.includes('reason') ? { ...grant, allowedFieldGroups: [...grant.allowedFieldGroups, 'reason'] } : grant);
  });

  app.post('/attendance-corrections/tasks/:id/decision', { schema: { params: idParams, body: decisionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'attendance', 'approve_correction', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => decideCorrection(tx, grant, id, request.body as DecisionBody));
  });
}
