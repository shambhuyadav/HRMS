// Appraisal (FR-040 to FR-044; F1 appraisal): HTTP routes. Every route calls requireAccess first; anything outside the
// selected assignment's row scope reads as not found. Own-record routes (/me/...) serve the Employee OWN context only.
import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import {
  appraisalView,
  cancelAppraisal,
  createAppraisal,
  type CreateInput,
  getAppraisal,
  getOwnAppraisal,
  type GoalInput,
  type ListQuery,
  listAppraisals,
  listOwnAppraisals,
  recordException,
  replaceGoals,
  staffScope,
} from './appraisals.js';
import { readAppraisal, type Stage, STAGES, taskAction } from './common.js';
import { closeCycle, createCycle, type CycleInput, CYCLE_START_MONTHS, getCycle, getSetting, listCycles, putSetting, updateCycle, type WindowsInput } from './cycles.js';
import { goalImportRoutes } from './goal-import.js';
import { cycleExport, cycleReport } from './reports.js';
import { type DecisionInput, decideAppraisal, type RatingInput, reviewTasks, saveRating } from './review.js';
import { type SelfEntryInput, saveSelfEntry, submitSelfEntry } from './self-entry.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', format: 'date' } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const versionBody = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const nullableText = (maxLength: number) => ({ anyOf: [{ type: 'string', maxLength }, { type: 'null' }] }) as const;
const window = { anyOf: [{ type: 'object', additionalProperties: false, required: ['opensOn', 'closesOn'], properties: { opensOn: date, closesOn: date } }, { type: 'null' }] } as const;
const windows = { type: 'object', additionalProperties: false, properties: { goalSetting: window, selfEntry: window, managerRating: window } } as const;
const approvalLevels = { type: 'integer', enum: [1, 2] } as const;
const goals = {
  type: 'array',
  maxItems: 100,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['sequence', 'description', 'weight'],
    properties: {
      sequence: { type: 'integer', minimum: 1, maximum: 100 },
      description: { type: 'string', minLength: 1, maxLength: 500 },
      target: nullableText(1000),
      weight: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
} as const;
// F1: every score is an integer 1..5; null clears a draft score.
const entries = {
  type: 'array',
  maxItems: 100,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['goalId'],
    properties: { goalId: uuid, score: { anyOf: [{ type: 'integer', minimum: 1, maximum: 5 }, { type: 'null' }] }, comment: nullableText(2000) },
  },
} as const;
const entryBody = { type: 'object', additionalProperties: false, required: ['entries', 'expectedVersion'], properties: { entries, comment: nullableText(4000), expectedVersion } } as const;
const departmentQuery = { type: 'object', additionalProperties: false, properties: { departmentId: uuid } } as const;

export async function appraisalRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db } = opts;

  // -------------------------------------------------------------------------------------------------------
  // Company setting and cycles (FR-040)
  // -------------------------------------------------------------------------------------------------------
  app.get('/appraisal-settings', async (request) => getSetting(db, await requireAccess(db, request, 'appraisal_cycle', 'read', ['operational'])));

  app.put(
    '/appraisal-settings',
    {
      schema: {
        body: { type: 'object', additionalProperties: false, required: ['cycleStartMonth'], properties: { cycleStartMonth: { type: 'integer', enum: [...CYCLE_START_MONTHS] }, expectedVersion } },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'appraisal_cycle', 'manage', ['operational'], { requireAll: true });
      return withTransaction(db, (tx) => putSetting(tx, grant, request.body as { cycleStartMonth: number; expectedVersion?: number }));
    },
  );

  app.get(
    '/appraisal-cycles',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: ['OPEN', 'CLOSED'] } } } } },
    async (request) => listCycles(db, await requireAccess(db, request, 'appraisal_cycle', 'read', ['operational']), request.query as { state?: 'OPEN' | 'CLOSED' }),
  );

  app.post(
    '/appraisal-cycles',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'name', 'startDate'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 40 }, name: { type: 'string', minLength: 1, maxLength: 200 }, startDate: date, approvalLevels, windows },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'appraisal_cycle', 'manage', ['operational'], { requireAll: true });
      const id = await withTransaction(db, (tx) => createCycle(tx, grant, request.body as CycleInput));
      reply.status(201);
      return getCycle(db, grant, id);
    },
  );

  app.get('/appraisal-cycles/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return getCycle(db, await requireAccess(db, request, 'appraisal_cycle', 'read', ['operational'], { recordKey: id }), id);
  });

  app.put(
    '/appraisal-cycles/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'approvalLevels', 'windows', 'expectedVersion'],
          properties: { name: { type: 'string', minLength: 1, maxLength: 200 }, approvalLevels, windows, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'appraisal_cycle', 'manage', ['operational'], { requireAll: true, recordKey: id });
      await withTransaction(db, (tx) => updateCycle(tx, grant, id, request.body as { name: string; approvalLevels: 1 | 2; windows: WindowsInput; expectedVersion: number }));
      return getCycle(db, grant, id);
    },
  );

  app.post('/appraisal-cycles/:id/close', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'appraisal_cycle', 'manage', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => closeCycle(tx, grant, id, request.body as { expectedVersion: number }));
    return getCycle(db, grant, id);
  });

  // FR-044 report and export within row scope; rating content only with the confidential rating group.
  app.get('/appraisal-cycles/:id/report', { schema: { params: idParams, querystring: departmentQuery } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'appraisal', 'report', ['operational', 'rating'], { recordKey: id });
    return cycleReport(db, grant, id, request.query as { departmentId?: string });
  });

  app.get('/appraisal-cycles/:id/export', { schema: { params: idParams, querystring: departmentQuery } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'appraisal', 'export', ['operational', 'rating'], { recordKey: id });
    const out = await cycleExport(db, grant, id, request.query as { departmentId?: string });
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${out.fileName}"`).header('cache-control', 'no-store');
    return out.content;
  });

  // -------------------------------------------------------------------------------------------------------
  // Appraisals: enrolment, goals, exceptions, cancellation and HR/manager views (FR-041, FR-044)
  // -------------------------------------------------------------------------------------------------------
  app.get(
    '/appraisals',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cycleId: uuid,
            employeeId: uuid,
            departmentId: uuid,
            state: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'CANCELLED'] },
            stateGroup: { type: 'string', enum: ['AWAITING_DECISION'] },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 },
          },
        },
      },
    },
    async (request) => listAppraisals(db, await requireAccess(db, request, 'appraisal', 'read', ['operational', 'rating']), request.query as ListQuery),
  );

  app.post(
    '/appraisals',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['cycleId', 'employeeId'], properties: { cycleId: uuid, employeeId: uuid, goals } } } },
    async (request, reply) => {
      const body = request.body as CreateInput;
      const grant = await requireAccess(db, request, 'appraisal', 'manage', ['operational'], { requireAll: true, recordKey: body.employeeId });
      const id = await withTransaction(db, (tx) => createAppraisal(tx, grant, body));
      reply.status(201);
      return appraisalView(db, grant, id, staffScope(grant, body.employeeId));
    },
  );

  app.get('/appraisals/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return getAppraisal(db, await requireAccess(db, request, 'appraisal', 'read', ['operational', 'rating', 'reason'], { recordKey: id }), id);
  });

  app.put(
    '/appraisals/:id/goals',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['goals', 'expectedVersion'], properties: { goals, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'appraisal', 'manage', ['operational'], { requireAll: true, recordKey: id });
      await withTransaction(db, (tx) => replaceGoals(tx, grant, id, request.body as { goals: GoalInput[]; expectedVersion: number }));
      return getAppraisal(db, grant, id);
    },
  );

  app.post(
    '/appraisals/:id/window-exceptions',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['stage', 'validUntil', 'reason'], properties: { stage: { type: 'string', enum: [...STAGES] }, validUntil: date, reason } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'appraisal', 'grant_exception', ['operational'], { requireAll: true, recordKey: id });
      await withTransaction(db, (tx) => recordException(tx, grant, id, request.body as { stage: Stage; validUntil: string; reason: string }));
      reply.status(201);
      return getAppraisal(db, grant, id);
    },
  );

  app.post(
    '/appraisals/:id/cancel',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason', 'expectedVersion'], properties: { reason, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'appraisal', 'cancel', ['operational'], { requireAll: true, recordKey: id });
      await withTransaction(db, (tx) => cancelAppraisal(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
      return getAppraisal(db, grant, id);
    },
  );

  // -------------------------------------------------------------------------------------------------------
  // Rating and review tasks (FR-043)
  // -------------------------------------------------------------------------------------------------------
  app.get('/appraisal-tasks/mine', async (request) => reviewTasks(db, await requireAccess(db, request, 'appraisal', 'read', ['operational', 'rating'])));

  app.put('/appraisal-tasks/:id/rating', { schema: { params: idParams, body: entryBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'appraisal', 'rate', ['rating'], { requireAll: true, recordKey: id });
    const appraisalId = await withTransaction(db, (tx) => saveRating(tx, grant, id, request.body as RatingInput));
    const a = (await readAppraisal(db, grant.companyId, appraisalId))!;
    return appraisalView(db, grant, appraisalId, staffScope(grant, a.employee_id));
  });

  app.post(
    '/appraisal-tasks/:id/decision',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'idempotencyKey'],
          properties: {
            // Rejection is not offered: an appraisal is completed, returned for revision or cancelled by HR.
            decision: { type: 'string', enum: ['APPROVE', 'RETURN'] },
            reason,
            employeeMessage: { type: 'string', minLength: 1, maxLength: 2000 },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = actorOf(request);
      // The step's own decision duty is required; an unknown or someone else's task is checked as a rating.
      const action = (await taskAction(db, actor.companyId, actor.userId, id)) ?? 'rate';
      const grant = await requireAccess(db, request, 'appraisal', action, ['rating'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideAppraisal(tx, grant, id, action, request.body as DecisionInput));
    },
  );

  // -------------------------------------------------------------------------------------------------------
  // The employee's own appraisals (H3 TN18, Employee OWN context)
  // -------------------------------------------------------------------------------------------------------
  app.get('/me/appraisals', async (request) => listOwnAppraisals(db, await requireAccess(db, request, 'appraisal', 'read', ['operational', 'self'])));

  app.get('/me/appraisals/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return getOwnAppraisal(db, await requireAccess(db, request, 'appraisal', 'read', ['operational', 'self'], { recordKey: id }), id);
  });

  app.put('/me/appraisals/:id/self-entry', { schema: { params: idParams, body: entryBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'appraisal', 'self_assess', ['self'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => saveSelfEntry(tx, grant, id, request.body as SelfEntryInput));
    return getOwnAppraisal(db, grant, id);
  });

  app.post('/me/appraisals/:id/submit', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'appraisal', 'self_assess', ['self'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => submitSelfEntry(tx, grant, id, request.body as { expectedVersion: number }));
    return getOwnAppraisal(db, grant, id);
  });

  // FR-041 KRA/goal upload (shared batch framework).
  await goalImportRoutes(app, opts);
}
