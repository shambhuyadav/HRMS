// Hiring (FR-011 to FR-014; F1 hiring): HTTP routes for manpower budgets, requisitions and their approval tasks.
// The candidate pipeline, offers and handover are in pipeline-routes.ts. Every route calls requireAccess first.
import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { actorOf } from '../../http/context.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import {
  type BudgetDecisionInput,
  type BudgetInput,
  budgetTasks,
  createBudget,
  createBudgetRevision,
  decideBudgetRevision,
  getBudget,
  listBudgets,
  submitBudgetRevision,
  updateBudgetRevision,
  withdrawBudgetRevision,
} from './budget.js';
import { HIRING_REFERENCE_CATEGORIES, listReferenceValues, requisitionMasters } from './options.js';
import { pipelineRoutes } from './pipeline-routes.js';
import {
  type BudgetPreviewQuery,
  closeRequisition,
  copyRequisition,
  createRequisition,
  decideRequisition,
  discardRequisition,
  getRequisition,
  listRequisitions,
  previewBudgetCheck,
  type RequisitionDecisionInput,
  type RequisitionInput,
  type RequisitionListQuery,
  requisitionTaskAction,
  requisitionTasks,
  submitRequisition,
  updateRequisition,
  withdrawRequisition,
} from './requisition.js';
import { date, decisionBody, expectedVersion, headcount, idParams, optionalPaging, paging, reasonBody, reasonText, skills, uuid, versionBody } from './schemas.js';

const count = headcount;

const budgetBody = {
  type: 'object',
  additionalProperties: false,
  required: ['departmentId', 'locationId', 'designationId', 'periodStart', 'periodEnd', 'headcount', 'reason'],
  properties: { departmentId: uuid, locationId: uuid, designationId: uuid, periodStart: date, periodEnd: date, headcount: count, reason: reasonText },
} as const;
const revisionBody = { type: 'object', additionalProperties: false, required: ['headcount', 'reason'], properties: { headcount: count, reason: reasonText } } as const;

const requisitionProperties = {
  title: { type: 'string', minLength: 1, maxLength: 200 },
  departmentId: uuid,
  locationId: uuid,
  designationId: uuid,
  employmentType: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' },
  vacancies: { type: 'integer', minimum: 1, maximum: 2147483647 },
  reasonType: { type: 'string', enum: ['NEW', 'REPLACEMENT'] },
  reason: { type: 'string', minLength: 1, maxLength: 2000 },
  skills,
  targetDate: date,
  hiringManagerId: uuid,
  budgetExceptionReason: { anyOf: [{ type: 'string', minLength: 1, maxLength: 2000 }, { type: 'null' }] },
} as const;
const requisitionRequired = ['title', 'departmentId', 'locationId', 'designationId', 'employmentType', 'vacancies', 'reasonType', 'reason', 'targetDate', 'hiringManagerId'];
const requisitionBody = { type: 'object', additionalProperties: false, required: requisitionRequired, properties: requisitionProperties } as const;
const requisitionUpdateBody = { type: 'object', additionalProperties: false, required: [...requisitionRequired, 'expectedVersion'], properties: { ...requisitionProperties, expectedVersion } } as const;

export async function hiringRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db } = opts;

  // -------------------------------------------------------------------------------------------------------
  // Form choices (DF04 controlled lists): each under the permission of the form that offers it
  // -------------------------------------------------------------------------------------------------------
  app.get(
    '/hiring/reference-values',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, required: ['category'], properties: { category: { type: 'string', enum: Object.keys(HIRING_REFERENCE_CATEGORIES) } } },
      },
    },
    async (request) => {
      const { category } = request.query as { category: string };
      const form = HIRING_REFERENCE_CATEGORIES[category]!;
      return listReferenceValues(db, await requireAccess(db, request, form.resource, form.action, [form.fieldGroup], { requireAll: true }), category);
    },
  );

  // The masters a requisition creator may name (the assignment's filters apply, as at creation).
  app.get('/hiring/requisition-masters', async (request) => requisitionMasters(db, await requireAccess(db, request, 'requisition', 'create', ['operational'], { requireAll: true })));

  // FR-011: the budget check a new requisition would get, before its draft exists (nothing recorded).
  app.get(
    '/hiring/requisition-budget-check',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['departmentId', 'locationId', 'designationId', 'targetDate', 'vacancies'],
          properties: { departmentId: uuid, locationId: uuid, designationId: uuid, targetDate: date, vacancies: requisitionProperties.vacancies },
        },
      },
    },
    async (request) => previewBudgetCheck(db, await requireAccess(db, request, 'requisition', 'create', ['operational'], { requireAll: true }), request.query as BudgetPreviewQuery),
  );

  // -------------------------------------------------------------------------------------------------------
  // FR-011 manpower budgets
  // -------------------------------------------------------------------------------------------------------
  app.get(
    '/hiring/budgets',
    {
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { departmentId: uuid, locationId: uuid, designationId: uuid, on: date, ...optionalPaging } },
      },
    },
    async (request) => listBudgets(db, await requireAccess(db, request, 'manpower_budget', 'read', ['operational']), request.query as Parameters<typeof listBudgets>[2]),
  );

  app.post('/hiring/budgets', { schema: { body: budgetBody } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'manpower_budget', 'manage', ['operational'], { requireAll: true });
    const result = await withTransaction(db, (tx) => createBudget(tx, grant, request.body as BudgetInput));
    reply.status(201);
    return result;
  });

  app.get('/hiring/budgets/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return getBudget(db, await requireAccess(db, request, 'manpower_budget', 'read', ['operational'], { recordKey: id }), id);
  });

  app.post('/hiring/budgets/:id/revisions', { schema: { params: idParams, body: revisionBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'manpower_budget', 'manage', ['operational'], { requireAll: true, recordKey: id });
    const result = await withTransaction(db, (tx) => createBudgetRevision(tx, grant, id, request.body as { headcount: number; reason: string }));
    reply.status(201);
    return result;
  });

  app.put(
    '/hiring/budget-revisions/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['headcount', 'reason', 'expectedVersion'], properties: { headcount: count, reason: reasonText, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'manpower_budget', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => updateBudgetRevision(tx, grant, id, request.body as { headcount: number; reason: string; expectedVersion: number }));
    },
  );

  app.post('/hiring/budget-revisions/:id/submit', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'manpower_budget', 'manage', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => submitBudgetRevision(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post('/hiring/budget-revisions/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'manpower_budget', 'manage', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawBudgetRevision(tx, grant, id));
  });

  app.get('/hiring/budget-tasks', async (request) => budgetTasks(db, await requireAccess(db, request, 'manpower_budget', 'approve', ['operational'], { requireAll: true })));

  // An independent HR Administrator approves or rejects (a rejected revision is final; a new revision follows).
  app.post('/hiring/budget-tasks/:id/decision', { schema: { params: idParams, body: decisionBody(['APPROVE', 'REJECT']) } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'manpower_budget', 'approve', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => decideBudgetRevision(tx, grant, id, request.body as BudgetDecisionInput));
  });

  // -------------------------------------------------------------------------------------------------------
  // FR-011/FR-012 requisitions
  // -------------------------------------------------------------------------------------------------------
  app.get(
    '/hiring/requisitions',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { state: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CLOSED'] }, departmentId: uuid, search: { type: 'string', maxLength: 100 }, ...paging },
        },
      },
    },
    async (request) => listRequisitions(db, await requireAccess(db, request, 'requisition', 'read', ['operational']), request.query as RequisitionListQuery),
  );

  app.post('/hiring/requisitions', { schema: { body: requisitionBody } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'requisition', 'create', ['operational'], { requireAll: true });
    const id = await withTransaction(db, (tx) => createRequisition(tx, grant, request.body as RequisitionInput));
    reply.status(201);
    return getRequisition(db, grant, id);
  });

  app.get('/hiring/requisitions/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await getRequisition(db, await requireAccess(db, request, 'requisition', 'read', ['operational'], { recordKey: id }), id);
    if (!view) throw notFound();
    return view;
  });

  app.put('/hiring/requisitions/:id', { schema: { params: idParams, body: requisitionUpdateBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'requisition', 'create', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => updateRequisition(tx, grant, id, request.body as RequisitionInput & { expectedVersion: number }));
    return getRequisition(db, grant, id);
  });

  app.post('/hiring/requisitions/:id/submit', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'requisition', 'create', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => submitRequisition(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post('/hiring/requisitions/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'requisition', 'create', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawRequisition(tx, grant, id));
  });

  app.post('/hiring/requisitions/:id/discard', { schema: { params: idParams, body: reasonBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'requisition', 'create', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => discardRequisition(tx, grant, id, request.body as { reason: string }));
  });

  app.post('/hiring/requisitions/:id/copy', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'requisition', 'create', ['operational'], { requireAll: true, recordKey: id });
    const copy = await withTransaction(db, (tx) => copyRequisition(tx, grant, id));
    reply.status(201);
    return getRequisition(db, grant, copy);
  });

  app.post('/hiring/requisitions/:id/close', { schema: { params: idParams, body: reasonBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'requisition', 'close', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => closeRequisition(tx, grant, id, request.body as { reason: string }));
  });

  // F1 route tasks: manager validation (validate) and HR budget/headcount approval (approve).
  app.get('/hiring/requisition-tasks', async (request) => requisitionTasks(db, await requireAccess(db, request, 'requisition', 'read', ['operational'])));

  app.post(
    '/hiring/requisition-tasks/:id/decision',
    { schema: { params: idParams, body: decisionBody(['APPROVE', 'REJECT', 'RETURN'], { approveBudgetException: { type: 'boolean' } }) } },
    async (request) => {
      const { id } = request.params as { id: string };
      const actor = actorOf(request);
      // The step's own decision duty is required; someone else's or an unknown task is checked as a validation.
      const action = (await requisitionTaskAction(db, actor.companyId, actor.userId, id)) ?? 'validate';
      const grant = await requireAccess(db, request, 'requisition', action, ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideRequisition(tx, grant, id, action, request.body as RequisitionDecisionInput));
    },
  );

  await pipelineRoutes(app, opts);
}
