import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging, type Sorting, sortQuery } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import {
  activateRetentionRule,
  AUDIT_SORTS,
  type AuditQuery,
  decideHold,
  employeePayrollTrace,
  listAuditEvents,
  listHolds,
  listRetentionRules,
  proposeRetentionRule,
  releaseHold,
  requestHold,
  RETENTION_RESOURCES,
  type RetentionResource,
  retentionEligibility,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const code = { type: 'string', pattern: '^[a-z][a-z0-9_]{0,59}$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;

export async function auditTrailRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // FR-058: employees (and anyone without the audit duty) cannot retrieve audit records.
  app.get(
    '/audit/events',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            resource: code,
            resourceGroup: { type: 'string', enum: ['CONFIGURATION'] },
            recordKey: uuid,
            actorUserId: uuid,
            action: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' },
            from: date,
            to: date,
            page: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
            ...sortQuery(AUDIT_SORTS),
          },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'audit', 'read', ['operational']);
      return listAuditEvents(db, grant, request.query as AuditQuery & Sorting & { page: number; pageSize: number });
    },
  );

  // FR-057: from an employee's assignment revisions to the payroll runs that used them; identifiers and dates, no amounts.
  app.get(
    '/audit/employees/:id/payroll-trace',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { ...optionalPaging } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'audit', 'read', ['operational'], { recordKey: id });
      return employeePayrollTrace(db, grant, id, request.query as Paging);
    },
  );

  app.get('/retention/rules', async (request) => {
    const grant = await requireAccess(db, request, 'retention', 'manage', ['operational']);
    return listRetentionRules(db, grant);
  });

  app.post(
    '/retention/rules',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['resource', 'retainDays', 'basisNote'],
          properties: { resource: { type: 'string', enum: [...RETENTION_RESOURCES] }, retainDays: { type: 'integer', minimum: 1, maximum: 36500 }, basisNote: reason },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'retention', 'manage', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => proposeRetentionRule(tx, grant, request.body as { resource: RetentionResource; retainDays: number; basisNote: string }));
      reply.status(201);
      return result;
    },
  );

  app.post(
    '/retention/rules/:id/activate',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'retention', 'approve', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => activateRetentionRule(tx, grant, id, (request.body as { expectedVersion: number }).expectedVersion));
    },
  );

  app.get(
    '/retention/holds',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: ['PENDING', 'ACTIVE', 'REJECTED', 'RELEASED'] } } } } },
    async (request) => {
      const grant = await requireAccess(db, request, 'retention', 'manage', ['operational']);
      return listHolds(db, grant, (request.query as { state?: string }).state);
    },
  );

  app.post(
    '/retention/holds',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['resource', 'reason'], properties: { resource: code, recordKey: uuid, reason } } } },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'retention', 'manage', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => requestHold(tx, grant, request.body as { resource: string; recordKey?: string; reason: string }));
      reply.status(201);
      return result;
    },
  );

  app.post(
    '/retention/holds/:id/decision',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'decision'], properties: { expectedVersion, decision: { type: 'string', enum: ['APPROVE', 'REJECT'] } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'retention', 'approve', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideHold(tx, grant, id, request.body as { expectedVersion: number; decision: 'APPROVE' | 'REJECT' }));
    },
  );

  app.post(
    '/retention/holds/:id/release',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'reason'], properties: { expectedVersion, reason } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'retention', 'approve', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => releaseHold(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
    },
  );

  app.get(
    '/retention/eligibility',
    { schema: { querystring: { type: 'object', additionalProperties: false, required: ['resource'], properties: { resource: { type: 'string', enum: [...RETENTION_RESOURCES] } } } } },
    async (request) => {
      const grant = await requireAccess(db, request, 'retention', 'manage', ['operational']);
      return retentionEligibility(db, grant, (request.query as { resource: RetentionResource }).resource);
    },
  );
}
