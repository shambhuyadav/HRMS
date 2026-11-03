// Increment cycle definitions, review openings, employee cycle assignment and review-date overrides (DF15; FR-091).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { resolveAccess } from '../access/authorize.js';
import { enqueueBulkJob } from '../bulk/service.js';
import { activateCycle, createCycle, createRevision, type CycleDefinitionInput, getCycle, listCycles, updateDraft } from './cycles.js';
import { decidePlanChange, employeePlan, pendingPlanChanges, type PlanChangeInput, proposePlanChange, withdrawPlanChange } from './plans.js';
import {
  checkReviewOpening,
  OPENING_PAGE_DEFAULT,
  OPENING_PAGE_MAX,
  openingCases,
  openingExclusions,
  type OpeningPageQuery,
  type ReviewInput,
  reviewJobParameters,
} from './roster.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const version = { type: 'integer', minimum: 1 } as const;
const monthDay = {
  type: 'object',
  additionalProperties: false,
  required: ['month', 'day'],
  properties: { month: { type: 'integer', minimum: 1, maximum: 12 }, day: { type: 'integer', minimum: 1, maximum: 31 } },
} as const;
// Technical input bounds only (whole days and years that date arithmetic can represent), not policy limits.
const offsetDays = { type: 'integer', minimum: 0, maximum: 3660 } as const;
const openingPage = {
  type: 'object',
  additionalProperties: false,
  properties: { after: { type: 'string', minLength: 1, maxLength: 400 }, limit: { type: 'integer', minimum: 1, maximum: OPENING_PAGE_MAX, default: OPENING_PAGE_DEFAULT } },
} as const;

const definition = {
  recurrenceBasis: { type: 'string', enum: ['COMMON_DATE', 'SERVICE_ANNIVERSARY'] },
  recurrenceUnit: { type: 'string', enum: ['YEAR'] },
  recurrenceInterval: { type: 'integer', minimum: 1, maximum: 50 },
  compensationBasis: { type: 'string', enum: ['MONTHLY_GROSS', 'ANNUAL_CTC'] },
  excludeNotice: { type: 'boolean' },
  assignmentRule: { type: 'string', enum: ['COMPANY_DEFAULT', 'ASSIGNED_ONLY'] },
  effectiveFrom: date,
  effectiveDate: monthDay,
  reviewOpens: monthDay,
  rosterFreezes: monthDay,
  decisionsDue: monthDay,
  joiningCutoff: monthDay,
  reviewOpenOffsetDays: offsetDays,
  rosterFreezeOffsetDays: offsetDays,
  decisionDueOffsetDays: offsetDays,
  requiredAppraisalCycleId: { type: ['string', 'null'], format: 'uuid' },
} as const;
const definitionRequired = ['recurrenceBasis', 'recurrenceUnit', 'recurrenceInterval', 'compensationBasis', 'excludeNotice', 'assignmentRule', 'effectiveFrom'] as const;

export async function incrementCycleRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  const manage = (request: FastifyRequest, recordKey?: string) =>
    requireAccess(db, request, 'increment_cycle', 'manage', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.get('/increment-cycles', async (request) => listCycles(db, await manage(request)));

  app.get('/increment-cycles/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return getCycle(db, await manage(request, id), id);
  });

  app.post(
    '/increment-cycles',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', ...definitionRequired],
          properties: { code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' }, ...definition },
        },
      },
    },
    async (request, reply) => {
      const grant = await manage(request);
      const result = await withTransaction(db, (tx) => createCycle(tx, grant, request.body as CycleDefinitionInput & { code: string }));
      reply.status(201);
      return result;
    },
  );

  app.put(
    '/increment-cycles/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: [...definitionRequired, 'expectedVersion'], properties: { ...definition, expectedVersion: version } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await manage(request, id);
      return withTransaction(db, (tx) => updateDraft(tx, grant, id, request.body as CycleDefinitionInput & { expectedVersion: number }));
    },
  );

  app.post(
    '/increment-cycles/:id/revisions',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: [...definitionRequired], properties: definition } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await manage(request, id);
      const result = await withTransaction(db, (tx) => createRevision(tx, grant, id, request.body as CycleDefinitionInput));
      reply.status(201);
      return result;
    },
  );

  app.post(
    '/increment-cycles/:id/activate',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion: version } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'increment_cycle', 'activate', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => activateCycle(tx, grant, id, (request.body as { expectedVersion: number }).expectedVersion));
    },
  );

  // FR-091 roster: a year for a common-date cycle, a year and month for an anniversary cycle. The opening is checked as
  // before (company scope, this company's activated revision in force for the period), then queued as a bulk job that
  // the worker runs in bounded chunks under the caller's re-checked authority (NFR-S09); the answer is 202 with the job
  // to follow (GET /v1/bulk-jobs/:id: state and counts), and the job's cases and exclusions are read below.
  app.post(
    '/increment-cycles/:id/reviews',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['year'],
          properties: { year: { type: 'integer', minimum: 2000, maximum: 2100 }, month: { type: 'integer', minimum: 1, maximum: 12 }, idempotencyKey },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await manage(request, id); // BULK_KINDS.INCREMENT_REVIEW_OPENING.permission: increment_cycle.manage.operational
      const { idempotencyKey: key, ...input } = request.body as ReviewInput & { idempotencyKey?: string };
      const job = await withTransaction(db, async (tx) => {
        await checkReviewOpening(tx, grant, id, input);
        return enqueueBulkJob(tx, grant, 'INCREMENT_REVIEW_OPENING', reviewJobParameters(id, input), key);
      });
      reply.status(202);
      return job;
    },
  );

  // The roster of an opening job: the draft cases it created and the employees it excluded with the reason and repair
  // path, a page at a time in employee-code order. Company records under the opening's own authority (cycle duty,
  // unrestricted company scope), for any opening of this company; operational fields only, never an amount.
  app.get('/increment-review-openings/:id/cases', { schema: { params: idParams, querystring: openingPage } }, async (request) => {
    const { id } = request.params as { id: string };
    return openingCases(db, await manage(request, id), id, request.query as OpeningPageQuery);
  });

  app.get('/increment-review-openings/:id/exclusions', { schema: { params: idParams, querystring: openingPage } }, async (request) => {
    const { id } = request.params as { id: string };
    return openingExclusions(db, await manage(request, id), id, request.query as OpeningPageQuery);
  });

  // DB102 plan: the cycle followed, the next review, revisions and change proposals (reasons with the reason grant).
  app.get('/employees/:id/increment-plan', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'increment', 'read', ['operational', 'reason'], { recordKey: id });
    if (!grant.allowedFieldGroups.includes('operational')) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
    return employeePlan(db, grant, id);
  });

  app.post(
    '/employees/:id/increment-plan/changes',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'reason'],
          properties: { kind: { type: 'string', enum: ['ASSIGN_CYCLE', 'REVIEW_DATE_OVERRIDE'] }, cycleId: uuid, effectiveFrom: date, overrideDate: date, reason },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'increment_plan', 'propose', ['operational'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => proposePlanChange(tx, grant, id, request.body as PlanChangeInput));
      reply.status(201);
      return result;
    },
  );

  app.get('/increment-plan-changes/pending', async (request) => {
    const grant = await requireAccess(db, request, 'increment_plan', 'approve', ['operational'], { requireAll: true });
    // A decider who also holds the increment reason grant in the same assignment sees the private reasons.
    const reasons = await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource: 'increment', action: 'read', fieldGroups: ['reason'] });
    return pendingPlanChanges(db, grant, reasons.allowed && reasons.allowedFieldGroups.includes('reason'));
  });

  app.post(
    '/increment-plan-changes/:id/decision',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['decision', 'reason'], properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT'] }, reason } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'increment_plan', 'approve', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decidePlanChange(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT'; reason: string }));
    },
  );

  app.post('/increment-plan-changes/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'increment_plan', 'propose', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawPlanChange(tx, grant, id));
  });
}
