// Training plans, participants and feedback over HTTP (FR-049, FR-050; F1 "Training"; H3 TN17). Every route calls
// requireAccess first. Plan maintenance needs an unrestricted company-scope assignment; participation and feedback
// views use the caller's row scope; the /me routes act on the caller's own record (Employee OWN context, H1/BR-055).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { forbidden, notFound } from '../../http/errors.js';
import { auditDenial, type GuardOptions, requireAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { isCompanyWide, listReference, MODE_LIST, PARTICIPATION_STATES, PLAN_VIEWS, type ParticipationState, QUESTION_LIST } from './common.js';
import { exportFeedback, FEEDBACK_STATUSES, type FeedbackInput, feedbackRegister, feedbackSummary, ownFeedback, submitFeedback } from './feedback.js';
import {
  applyTransition,
  listEmployeeParticipations,
  listOpenPlans,
  listParticipationsInScope,
  listPlanParticipants,
  nominate,
  participantDetail,
  selfNominate,
  type TransitionInput,
  withdrawNomination,
} from './participants.js';
import { cancelPlan, createPlan, exportPlans, getPlan, listPlans, type PlanInput, type PlanListQuery, type PlanUpdate, updatePlan } from './plans.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const code = { type: 'string', minLength: 1, maxLength: 60, pattern: '^[A-Z0-9][A-Z0-9_]{0,59}$' } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const paging = { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 } } as const;
// Union types (not anyOf), so a null is never coerced into an empty string or a zero.
const optionalText = (maxLength: number) => ({ type: ['string', 'null'], maxLength }) as const;
const cost = {
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['amount', 'currency'],
  properties: { amount: { type: 'string', minLength: 1, maxLength: 20 }, currency: { type: 'string', minLength: 3, maxLength: 3 } },
} as const;
const questionCodes = { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: code } as const;
const planFields = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  startDate: date,
  endDate: date,
  modeCode: code,
  venue: optionalText(300),
  trainer: optionalText(200),
  capacity: { type: 'integer', minimum: 1, maximum: 2147483647 },
  cost,
  ownerEmployeeId: uuid,
  selfNomination: { type: 'boolean' },
  feedbackQuestionCodes: questionCodes,
} as const;
const planFilters = {
  view: { type: 'string', enum: [...PLAN_VIEWS] },
  search: { type: 'string', maxLength: 100 },
  from: date,
  to: date,
} as const;
const ids = { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: uuid } as const;

export async function trainingRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  /**
   * requireAccess for a request whose operational group is mandatory and whose extra groups (cost, comment) are
   * optional unless `requireAll`: an assignment holding only an extra group is denied like any missing grant.
   */
  const guard = async (request: FastifyRequest, resource: string, action: string, groups: readonly string[], options: GuardOptions = {}): Promise<AccessGrant> => {
    const grant = await requireAccess(db, request, resource, action, groups, options);
    if (!grant.allowedFieldGroups.includes('operational')) {
      await auditDenial(db, request, { resource, action, reason: 'FIELD_GROUP_DENIED', fieldGroups: ['operational'], recordKey: options.recordKey });
      throw forbidden();
    }
    return grant;
  };

  /** Plans are company records: maintaining them needs an unrestricted company-scope assignment (recorded denial). */
  const companyWide = async (request: FastifyRequest, grant: AccessGrant, action: string, recordKey?: string): Promise<void> => {
    if (isCompanyWide(grant)) return;
    await auditDenial(db, request, { resource: 'training_plan', action, reason: 'OUT_OF_SCOPE', recordKey });
    throw forbidden();
  };

  /** Row scope over an employee: an existing employee outside it is a recorded denial; either way not found. */
  const employeeInScope = async (request: FastifyRequest, grant: AccessGrant, employeeId: string): Promise<void> => {
    if (await canAccessEmployee(db, grant, employeeId)) return;
    const existing = await db.query(`select 1 from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId]);
    if (existing.rowCount) await auditDenial(db, request, { resource: 'training_participant', action: 'read', reason: 'OUT_OF_SCOPE', recordKey: employeeId });
    throw notFound();
  };

  // ------------------------------------------------------------------------------------------------------
  // Controlled lists (DF04)
  // ------------------------------------------------------------------------------------------------------

  app.get('/training-modes', async (request) => {
    const grant = await guard(request, 'training_plan', 'read', ['operational']);
    return listReference(db, grant.companyId, MODE_LIST);
  });

  app.get('/training-feedback-questions', async (request) => {
    const grant = await guard(request, 'training_plan', 'read', ['operational']);
    return listReference(db, grant.companyId, QUESTION_LIST);
  });

  // ------------------------------------------------------------------------------------------------------
  // Plans (FR-049): register, views and filters, maintenance, cancellation, export
  // ------------------------------------------------------------------------------------------------------

  app.get('/training-plans', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { ...planFilters, ...paging } } } }, async (request) => {
    const grant = await guard(request, 'training_plan', 'read', ['operational', 'cost']);
    return listPlans(db, grant, request.query as PlanListQuery);
  });

  app.get('/training-plans/export', { schema: { querystring: { type: 'object', additionalProperties: false, properties: planFilters } } }, async (request, reply) => {
    const grant = await guard(request, 'training_plan', 'export', ['operational', 'cost']);
    const out = await exportPlans(db, grant, request.query as Omit<PlanListQuery, 'page' | 'pageSize'>);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${out.fileName}"`).header('cache-control', 'no-store');
    return out.content;
  });

  app.post(
    '/training-plans',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'title', 'startDate', 'endDate', 'modeCode', 'capacity', 'ownerEmployeeId'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 40 }, ...planFields },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as PlanInput;
      // A cost needs the cost group as well (requireAll); without one, the cost group only shapes the answer.
      const grant = await guard(request, 'training_plan', 'manage', ['operational', 'cost'], { requireAll: body.cost !== undefined && body.cost !== null });
      await companyWide(request, grant, 'manage');
      const result = await withTransaction(db, (tx) => createPlan(tx, grant, body));
      reply.status(201);
      return result;
    },
  );

  app.get('/training-plans/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await guard(request, 'training_plan', 'read', ['operational', 'cost'], { recordKey: id });
    return getPlan(db, grant, id);
  });

  app.patch(
    '/training-plans/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], minProperties: 2, properties: { expectedVersion, ...planFields } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as PlanUpdate;
      const grant = await guard(request, 'training_plan', 'manage', ['operational', 'cost'], { requireAll: body.cost !== undefined, recordKey: id });
      await companyWide(request, grant, 'manage', id);
      return withTransaction(db, (tx) => updatePlan(tx, grant, id, body));
    },
  );

  app.post(
    '/training-plans/:id/cancel',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason', 'expectedVersion'], properties: { reason, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await guard(request, 'training_plan', 'manage', ['operational', 'cost'], { recordKey: id });
      await companyWide(request, grant, 'manage', id);
      return withTransaction(db, (tx) => cancelPlan(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
    },
  );

  // ------------------------------------------------------------------------------------------------------
  // Participants (FR-050): nomination, confirmation, attendance, completion, cancellation
  // ------------------------------------------------------------------------------------------------------

  app.get(
    '/training-plans/:id/participants',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: [...PARTICIPATION_STATES] }, ...paging } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      await guard(request, 'training_plan', 'read', ['operational'], { recordKey: id });
      // The confidential reason group only shapes the answer (DF02; I-16).
      const grant = await guard(request, 'training_participant', 'read', ['operational', 'reason'], { recordKey: id });
      return listPlanParticipants(db, grant, id, request.query as { state?: ParticipationState; page: number; pageSize: number });
    },
  );

  app.post(
    '/training-plans/:id/participants',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['employeeIds'], properties: { employeeIds: ids } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await guard(request, 'training_participant', 'manage', ['operational'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => nominate(tx, grant, id, (request.body as { employeeIds: string[] }).employeeIds));
      reply.status(201);
      return result;
    },
  );

  app.post(
    '/training-plans/:id/participant-actions',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'participantIds'],
          properties: { action: { type: 'string', enum: ['CONFIRM', 'MARK_ATTENDED', 'MARK_NO_SHOW', 'COMPLETE', 'CANCEL'] }, participantIds: ids, reason },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await guard(request, 'training_participant', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => applyTransition(tx, grant, id, request.body as TransitionInput));
    },
  );

  app.get('/training-participants/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await guard(request, 'training_participant', 'read', ['operational', 'reason'], { recordKey: id });
    return participantDetail(db, grant, id);
  });

  // F2 "Confirmed participation count; Completion/no-show counts; Feedback pending count": the rows behind the coordinator's
  // widgets, across plans, within the caller's row scope (no feedback content, cost or reasons).
  app.get(
    '/training-participants',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { state: { type: 'string', enum: [...PARTICIPATION_STATES] }, feedbackPending: { type: 'boolean' }, ...paging },
        },
      },
    },
    async (request) => {
      const grant = await guard(request, 'training_participant', 'read', ['operational']);
      return listParticipationsInScope(db, grant, request.query as { state?: ParticipationState; feedbackPending?: boolean; page: number; pageSize: number });
    },
  );

  // An employee's participations (row scope: the Employee OWN context sees its own record only, H3 TN17). `due` keeps what
  // the Employee dashboard counts as "Own training/tasks due" (F2).
  app.get(
    '/employees/:id/training',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { due: { type: 'boolean' } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await guard(request, 'training_participant', 'read', ['operational', 'reason'], { recordKey: id });
      await employeeInScope(request, grant, id);
      return listEmployeeParticipations(db, grant, id, (request.query as { due?: boolean }).due === true);
    },
  );

  // ------------------------------------------------------------------------------------------------------
  // Feedback (FR-050): summary, register and export (scores and status; comments only with the confidential group)
  // ------------------------------------------------------------------------------------------------------

  app.get('/training-plans/:id/feedback-summary', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    await guard(request, 'training_plan', 'read', ['operational'], { recordKey: id });
    const grant = await guard(request, 'training_feedback', 'read', ['operational'], { recordKey: id });
    return feedbackSummary(db, grant, id);
  });

  app.get(
    '/training-plans/:id/feedback',
    {
      schema: {
        params: idParams,
        querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: [...FEEDBACK_STATUSES] } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      await guard(request, 'training_plan', 'read', ['operational'], { recordKey: id });
      const grant = await guard(request, 'training_feedback', 'read', ['operational', 'comment'], { recordKey: id });
      return feedbackRegister(db, grant, id, request.query as { status?: (typeof FEEDBACK_STATUSES)[number] });
    },
  );

  app.get('/training-plans/:id/feedback/export', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await guard(request, 'training_feedback', 'export', ['operational'], { recordKey: id });
    const out = await exportFeedback(db, grant, id);
    reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${out.fileName}"`).header('cache-control', 'no-store');
    return out.content;
  });

  // ------------------------------------------------------------------------------------------------------
  // Employee OWN context (H3 TN17): enrolment, withdrawal and feedback entry
  // ------------------------------------------------------------------------------------------------------

  app.get('/me/training-plans', async (request) => {
    const grant = await guard(request, 'training_participant', 'enrol', ['operational']);
    return listOpenPlans(db, grant);
  });

  app.post(
    '/me/training-nominations',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['planId'], properties: { planId: uuid } } } },
    async (request, reply) => {
      const { planId } = request.body as { planId: string };
      const grant = await guard(request, 'training_participant', 'enrol', ['operational'], { requireAll: true, recordKey: planId });
      const result = await withTransaction(db, (tx) => selfNominate(tx, grant, planId));
      reply.status(201);
      return result;
    },
  );

  app.post(
    '/me/training-nominations/:id/withdraw',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await guard(request, 'training_participant', 'enrol', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => withdrawNomination(tx, grant, id, request.body as { reason: string }));
    },
  );

  app.get('/me/training-feedback', async (request) => {
    const grant = await guard(request, 'training_feedback', 'read', ['operational', 'comment']);
    return ownFeedback(db, grant);
  });

  app.post(
    '/me/training-feedback',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['participantId', 'answers'],
          properties: {
            participantId: uuid,
            answers: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['questionCode'],
                properties: { questionCode: code, score: { type: ['integer', 'null'] }, comment: optionalText(2000) },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as FeedbackInput;
      const commented = body.answers.some((a) => typeof a.comment === 'string' && a.comment.trim() !== '');
      const grant = await guard(request, 'training_feedback', 'submit', ['operational', 'comment'], { requireAll: commented, recordKey: body.participantId });
      const result = await withTransaction(db, (tx) => submitFeedback(tx, grant, body));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );
}
