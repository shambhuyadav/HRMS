// HTTP routes of the employee exit (FR-051, FR-055; F1). The employee's own resignation runs in the Employee OWN
// context; recommendations, approvals and withdrawal decisions are engine tasks of the assigned reviewer.
import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging, type Sorting, sortQuery } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import {
  cancelWithdrawalRequest,
  decideExit,
  decideWithdrawal,
  EXIT_SORTS,
  type ExitDecisionInput,
  employeeExits,
  exitDetail,
  exitTasks,
  finalRelease,
  listExits,
  listOwnExits,
  recommendExit,
  recordNoticePeriod,
  requestWithdrawal,
  type ResignationInput,
  submitResignation,
  withdrawResignation,
} from './exit.js';
import { date, expectedVersion, idempotencyKey, idParams, pagingQuery, reason } from './process-routes.js';

const taskParams = { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string', format: 'uuid' } } } as const;
const exitStates = ['SUBMITTED', 'RECOMMENDED', 'APPROVED', 'SEPARATED', 'REJECTED', 'WITHDRAWN'];

export async function exitRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  const read = (request: Parameters<typeof requireAccess>[1], recordKey?: string) =>
    requireAccess(db, request, 'exit', 'read', ['operational', 'reason'], { requireGroups: ['operational'], ...(recordKey ? { recordKey } : {}) });

  // ---- Employee OWN context ----
  app.post(
    '/me/resignation',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['proposedLastWorkingDate'],
          properties: { proposedLastWorkingDate: date, reasonCode: { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_]{0,59}$' }, reason },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'exit', 'submit', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => submitResignation(tx, grant, request.body as ResignationInput));
      reply.status(201);
      return result;
    },
  );

  app.get('/me/exit-cases', { schema: { querystring: pagingQuery } }, async (request) => listOwnExits(db, await read(request), request.query as Paging));

  app.post('/me/exit-cases/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'exit', 'submit', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawResignation(tx, grant, id));
  });

  app.post(
    '/me/exit-cases/:id/withdrawal-request',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'exit', 'submit', ['operational'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => requestWithdrawal(tx, grant, id, request.body as { reason: string }));
      reply.status(201);
      return result;
    },
  );

  app.post('/me/exit-withdrawals/:id/cancel', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'exit', 'submit', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => cancelWithdrawalRequest(tx, grant, id));
  });

  // ---- Lists within row scope ----
  // FR-056: page/pageSize ask for a page; without them the 200 most recent, with `total` counting every match.
  app.get(
    '/exit-cases',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: exitStates }, ...optionalPaging, ...sortQuery(EXIT_SORTS) } } } },
    async (request) => listExits(db, await read(request), request.query as { state?: string } & Paging & Sorting),
  );

  app.get('/exit-cases/tasks/mine', async (request) => exitTasks(db, await read(request)));

  app.get('/exit-cases/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return exitDetail(db, await read(request, id), id);
  });

  app.get('/employees/:id/exit-cases', { schema: { params: idParams, querystring: pagingQuery } }, async (request) => {
    const { id } = request.params as { id: string };
    return employeeExits(db, await read(request, id), id, request.query as Paging);
  });

  // ---- Reviewers ----
  app.post(
    '/exit-cases/tasks/:taskId/recommend',
    {
      schema: {
        params: taskParams,
        body: { type: 'object', additionalProperties: false, required: ['recommendedLastWorkingDate', 'idempotencyKey'], properties: { recommendedLastWorkingDate: date, idempotencyKey } },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      const grant = await requireAccess(db, request, 'exit', 'recommend', ['operational'], { requireAll: true, recordKey: taskId });
      return withTransaction(db, (tx) => recommendExit(tx, grant, taskId, request.body as { recommendedLastWorkingDate: string; idempotencyKey: string }));
    },
  );

  app.post(
    '/exit-cases/tasks/:taskId/decision',
    {
      schema: {
        params: taskParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'idempotencyKey'],
          properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT'] }, approvedLastWorkingDate: date, reason, employeeMessage: reason, idempotencyKey },
        },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      const grant = await requireAccess(db, request, 'exit', 'approve', ['operational'], { requireAll: true, recordKey: taskId });
      return withTransaction(db, (tx) => decideExit(tx, grant, taskId, request.body as ExitDecisionInput));
    },
  );

  app.post(
    '/exit-withdrawals/tasks/:taskId/decision',
    {
      schema: {
        params: taskParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'reason', 'idempotencyKey'],
          properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT'] }, reason, employeeMessage: reason, idempotencyKey },
        },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      const grant = await requireAccess(db, request, 'exit', 'approve', ['operational'], { requireAll: true, recordKey: taskId });
      return withTransaction(db, (tx) => decideWithdrawal(tx, grant, taskId, request.body as { decision: 'APPROVE' | 'REJECT'; reason: string; employeeMessage?: string; idempotencyKey: string }));
    },
  );

  // ---- HR administration ----
  app.put(
    '/exit-cases/:id/notice-period',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contractualNoticeDays', 'expectedVersion'],
          properties: { contractualNoticeDays: { type: 'integer', minimum: 0, maximum: 3650 }, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'exit', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => recordNoticePeriod(tx, grant, id, request.body as { contractualNoticeDays: number; expectedVersion: number }));
    },
  );

  app.post(
    '/exit-cases/:id/final-release',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'exit', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => finalRelease(tx, grant, id, request.body as { expectedVersion: number }));
    },
  );
}
