import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import { BULK_KINDS } from '../bulk/kinds.js';
import { enqueueBulkJob } from '../bulk/service.js';
import { evidenceContent, MAX_EVIDENCE_DOCUMENTS } from '../employee/evidence.js';
import { myOpenTasks } from '../workflow/engine.js';
import {
  activatePolicy,
  addPolicyMapping,
  createLeaveType,
  createPolicyDraft,
  employeesWithoutPolicy,
  listLeaveTypes,
  listPolicies,
  type MappingInput,
  type PolicyListFilters,
  policyOptions,
  type PolicyValues,
  removePolicyMapping,
  retirePolicy,
  updateLeaveType,
  updatePolicyDraft,
} from './policies.js';
import {
  adjustBalance,
  balances,
  type BalanceAdjustment,
  decideLeave,
  leaveLedger,
  listLeaveRequests,
  requestCancellation,
  resubmitLeave,
  type SubmitLeaveInput,
  submitLeave,
  withdrawLeave,
  withLeaveTaskSummaries,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;

const submitSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['leaveType', 'startDate', 'endDate'],
  properties: {
    leaveType: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' },
    startDate: date,
    endDate: date,
    halfDay: { type: 'boolean' },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    // FR-026 attachment: the requester's own usable documents (FR-106, I-22).
    evidenceDocumentIds: { type: 'array', maxItems: MAX_EVIDENCE_DOCUMENTS, uniqueItems: true, items: uuid },
    // DF03: the rejected request this one raises again; named once, at creation.
    predecessorRequestId: uuid,
  },
} as const;

const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'idempotencyKey'],
  properties: {
    decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] },
    reason: { type: 'string', minLength: 1, maxLength: 1000 },
    idempotencyKey,
  },
} as const;

const adjustSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['employeeId', 'leaveType', 'kind', 'units', 'effectiveDate', 'reason', 'idempotencyKey'],
  properties: {
    employeeId: uuid,
    leaveType: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' },
    kind: { type: 'string', enum: ['OPENING', 'ADJUSTMENT'] },
    units: { type: 'string', pattern: '^-?\\d{1,4}(\\.\\d{1,4})?$' },
    effectiveDate: date,
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    idempotencyKey,
  },
} as const;

const leaveTypeCode = { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const quantity = { type: 'string', pattern: '^\\d{1,8}(\\.\\d{1,4})?$' } as const;
const month = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' } as const;
const pageProps = { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 } } as const;

/** The parameters of a policy revision (DF05); values come from the owner, nothing here is a default but zero carry. */
const policyValues = {
  effectiveFrom: date,
  effectiveTo: { anyOf: [date, { type: 'null' }] },
  eligibility: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' },
  accrualRule: { type: 'string', enum: ['MONTHLY_PRORATED', 'NONE'] },
  annualEntitlement: quantity,
  minServiceDays: { type: 'integer', minimum: 0, maximum: 100000 },
  carryCap: quantity,
} as const;

export async function leaveRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore }): Promise<void> {
  const { db, files } = opts;

  app.post('/leave/requests', { schema: { body: submitSchema } }, async (request, reply) => {
    const input = request.body as SubmitLeaveInput;
    const grant = await requireAccess(db, request, 'leave', 'submit', ['operational'], { requireAll: true });
    const result = await withTransaction(db, (tx) => submitLeave(tx, grant, input));
    reply.status(201);
    return { requestId: result.requestId, units: result.units, state: 'SUBMITTED' };
  });

  app.post('/leave/requests/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'leave', 'withdraw', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawLeave(tx, grant, id));
  });

  app.put(
    '/leave/requests/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['startDate', 'endDate', 'expectedVersion'],
          properties: {
            startDate: date,
            endDate: date,
            halfDay: { type: 'boolean' },
            reason: submitSchema.properties.reason,
            evidenceDocumentIds: submitSchema.properties.evidenceDocumentIds,
            expectedVersion: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'leave', 'submit', ['operational'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => resubmitLeave(tx, grant, id, request.body as Parameters<typeof resubmitLeave>[3]));
      return { requestId: result.requestId, units: result.units, revision: result.revision, state: 'SUBMITTED' };
    },
  );

  // FR-026 / FR-106: a released evidence file, for the requester or a reviewer assigned to this request.
  app.get(
    '/leave/requests/:id/evidence/:documentId/content',
    { schema: { params: { type: 'object', required: ['id', 'documentId'], properties: { id: uuid, documentId: uuid } } } },
    async (request, reply) => {
      const { id, documentId } = request.params as { id: string; documentId: string };
      const grant = await requireAccess(db, request, 'leave', 'read', ['operational'], { recordKey: documentId });
      const target = (await db.query<{ transaction_id: string }>(`select transaction_id from leave_request where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
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

  app.post(
    '/leave/requests/:id/cancellation',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: submitSchema.properties.reason } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'leave', 'cancel', ['operational'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => requestCancellation(tx, grant, id, (request.body as { reason: string }).reason));
      reply.status(201);
      return { cancellationId: result.cancellationId, state: result.state };
    },
  );

  // One decision queue for leave requests and cancellations of approved leave; each item names its kind.
  app.get('/leave/tasks', async (request) => {
    const grant = await requireAccess(db, request, 'leave', 'approve', ['operational']);
    const [requests, cancellations] = await Promise.all([myOpenTasks(db, grant, 'leave_request'), myOpenTasks(db, grant, 'leave_cancellation')]);
    const items = [...requests.items, ...cancellations.items].sort((a, b) => new Date(a.assignedAt).getTime() - new Date(b.assignedAt).getTime());
    return { items: await withLeaveTaskSummaries(db, grant, items as { transactionId: string; kind: string; assignedAt: string }[]) };
  });

  app.post('/leave/tasks/:id/decision', { schema: { params: idParams, body: decisionSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'leave', 'approve', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => decideLeave(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason?: string; idempotencyKey: string }));
  });

  app.get('/employees/:id/leave-requests', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'leave', 'read', ['operational', 'reason'], { recordKey: id });
    return listLeaveRequests(db, grant, id);
  });

  app.get('/employees/:id/leave-balances', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'leave', 'read', ['operational'], { recordKey: id });
    return balances(db, grant, id);
  });

  // FR-025 Employee Leave Master: the ledger of a period per leave type; HR notes need the reason group (service.ts).
  app.get(
    '/employees/:id/leave-ledger',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: date, to: date, leaveType: leaveTypeCode } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'leave', 'read', ['operational', 'reason'], { recordKey: id });
      return leaveLedger(db, grant, id, request.query as { from: string; to: string; leaveType?: string });
    },
  );

  // A replay with the same content records nothing and says so; the same key for anything else is 409.
  app.post('/leave/adjustments', { schema: { body: adjustSchema } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'leave', 'adjust', ['operational'], { requireAll: true });
    const { replayed } = await withTransaction(db, (tx) => adjustBalance(tx, grant, request.body as BalanceAdjustment));
    reply.status(201);
    return { status: 'RECORDED', replayed };
  });

  // DF05 monthly accrual (company scope only): queued as a bulk job and run by the worker in bounded chunks under the
  // caller's re-checked authority (NFR-S09); the answer is 202 with the job to follow.
  app.post(
    '/leave/accruals',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['month'],
          properties: { month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' }, idempotencyKey },
        },
      },
    },
    async (request, reply) => {
      const { resource, action, fieldGroups } = BULK_KINDS.LEAVE_ACCRUAL.permission; // leave.accrue.operational
      const grant = await requireAccess(db, request, resource, action, fieldGroups, { requireAll: true });
      const { month, idempotencyKey: key } = request.body as { month: string; idempotencyKey?: string };
      const job = await withTransaction(db, (tx) => enqueueBulkJob(tx, grant, 'LEAVE_ACCRUAL', { month }, key));
      reply.status(202);
      return job;
    },
  );

  // FR-024 "unmapped employees are listed before accrual": under the accrual duty, in the caller's row scope.
  app.get(
    '/leave/accruals/employees-without-policy',
    { schema: { querystring: { type: 'object', additionalProperties: false, required: ['month'], properties: { month, ...pageProps } } } },
    async (request) => {
      const { resource, action, fieldGroups } = BULK_KINDS.LEAVE_ACCRUAL.permission;
      const grant = await requireAccess(db, request, resource, action, fieldGroups, { requireAll: true });
      return employeesWithoutPolicy(db, grant, request.query as { month: string; page: number; pageSize: number });
    },
  );

  // FR-024 leave types (leave_policy.manage; an unrestricted company scope for changes, policies.ts).
  app.get('/leave/types', async (request) => listLeaveTypes(db, await requireAccess(db, request, 'leave_policy', 'manage', ['operational'])));

  app.post(
    '/leave/types',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['code', 'name', 'paid'], properties: { code: leaveTypeCode, name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }, paid: { type: 'boolean' } } } } },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'leave_policy', 'manage', ['operational'], { requireAll: true });
      const created = await withTransaction(db, (tx) => createLeaveType(tx, grant, request.body as { code: string; name: string; paid: boolean }));
      reply.status(201);
      return created;
    },
  );

  app.patch(
    '/leave/types/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          minProperties: 2,
          properties: { expectedVersion, name: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }, active: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'leave_policy', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => updateLeaveType(tx, grant, id, request.body as { expectedVersion: number; name?: string; active?: boolean }));
    },
  );

  // FR-024 / E06: every revision with its mappings and warnings in words; filters by leave type, effective-from and state.
  app.get(
    '/leave/policies',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { leaveType: leaveTypeCode, effectiveFrom: date, state: { type: 'string', enum: ['DRAFT', 'ACTIVE', 'RETIRED'] } },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'leave_policy', 'manage', ['operational']);
      return listPolicies(db, grant, request.query as PolicyListFilters);
    },
  );

  app.get('/leave/policy-options', async (request) => policyOptions(db, await requireAccess(db, request, 'leave_policy', 'manage', ['operational'])));

  app.post(
    '/leave/policies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['leaveType', 'effectiveFrom', 'eligibility', 'accrualRule', 'annualEntitlement', 'minServiceDays'],
          properties: { leaveType: leaveTypeCode, ...policyValues },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'leave_policy', 'manage', ['operational'], { requireAll: true });
      const created = await withTransaction(db, (tx) => createPolicyDraft(tx, grant, request.body as PolicyValues & { leaveType: string }));
      reply.status(201);
      return created;
    },
  );

  app.patch(
    '/leave/policies/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], minProperties: 2, properties: { expectedVersion, ...policyValues } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'leave_policy', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => updatePolicyDraft(tx, grant, id, request.body as Partial<PolicyValues> & { expectedVersion: number }));
    },
  );

  app.post(
    '/leave/policies/:id/mappings',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion, employmentTypeId: uuid, gradeId: uuid, locationId: uuid } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'leave_policy', 'manage', ['operational'], { requireAll: true, recordKey: id });
      const created = await withTransaction(db, (tx) => addPolicyMapping(tx, grant, id, request.body as MappingInput));
      reply.status(201);
      return created;
    },
  );

  app.post(
    '/leave/policies/:id/mappings/:mappingId/remove',
    {
      schema: {
        params: { type: 'object', required: ['id', 'mappingId'], properties: { id: uuid, mappingId: uuid } },
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } },
      },
    },
    async (request) => {
      const { id, mappingId } = request.params as { id: string; mappingId: string };
      const grant = await requireAccess(db, request, 'leave_policy', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => removePolicyMapping(tx, grant, id, mappingId, (request.body as { expectedVersion: number }).expectedVersion));
    },
  );

  // `closePredecessors`: an earlier overlapping revision ends when this one starts; otherwise an overlap is refused.
  app.post(
    '/leave/policies/:id/activate',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion, closePredecessors: { type: 'boolean' } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'leave_policy', 'activate', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => activatePolicy(tx, grant, id, request.body as { expectedVersion: number; closePredecessors?: boolean }));
    },
  );

  app.post(
    '/leave/policies/:id/retire',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'effectiveTo', 'reason'], properties: { expectedVersion, effectiveTo: date, reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'leave_policy', 'activate', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => retirePolicy(tx, grant, id, request.body as { expectedVersion: number; effectiveTo: string; reason: string }));
    },
  );
}
