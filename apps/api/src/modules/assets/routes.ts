// Asset register, custody and custody requests over HTTP (FR-110; H3 TN16). Every route calls requireAccess first;
// the register needs an unrestricted company-scope assignment, employee views use the caller's row scope, and the
// /me routes act on the caller's own record in the Employee OWN context.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { assertCompanyWide, listCategories } from './common.js';
import { type DecisionInput, decideRequest, listEmployeeRequests, listRequests, type RequestInput, requestTasks, submitRequest, withdrawRequest } from './requests.js';
import {
  acknowledgeCustody,
  type AssetInput,
  type AssetUpdate,
  createAsset,
  getAsset,
  type IssueInput,
  issueAsset,
  listAssets,
  listEmployeeAssets,
  type RetireInput,
  type ReturnInput,
  retireAsset,
  returnAsset,
  updateAsset,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const note = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const code = { type: 'string', minLength: 1, maxLength: 60, pattern: '^[A-Z0-9][A-Z0-9_]{0,59}$' } as const;
const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const paging = { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 } } as const;
const ASSET_STATES = ['IN_STOCK', 'ISSUED', 'RETURNED_TO_STOCK', 'RETIRED'] as const;
const REQUEST_STATES = ['SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'] as const;

export async function assetsRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  /** The register is company-wide; a narrower assignment is a recorded denial (FR-098). */
  const register = async (request: FastifyRequest, action: 'read' | 'manage' | 'custody', recordKey?: string): Promise<AccessGrant> => {
    const grant = await requireAccess(db, request, 'asset', action, ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
    try {
      assertCompanyWide(grant);
    } catch (err) {
      await auditDenial(db, request, { resource: 'asset', action, reason: 'OUT_OF_SCOPE', ...(recordKey ? { recordKey } : {}) });
      throw err;
    }
    return grant;
  };

  /** Row scope over an employee: an existing employee outside it is a recorded denial; either way not found. */
  const employeeInScope = async (request: FastifyRequest, grant: AccessGrant, resource: string, employeeId: string) => {
    if (await canAccessEmployee(db, grant, employeeId)) return;
    const existing = await db.query(`select 1 from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId]);
    if (existing.rowCount) await auditDenial(db, request, { resource, action: 'read', reason: 'OUT_OF_SCOPE', recordKey: employeeId });
    throw notFound();
  };

  // ------------------------------------------------------------------------------------------------------
  // Register (Admin)
  // ------------------------------------------------------------------------------------------------------

  app.get('/asset-categories', async (request) => {
    const grant = await requireAccess(db, request, 'asset', 'read', ['operational']);
    return listCategories(db, grant.companyId);
  });

  app.get(
    '/assets',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { state: { type: 'string', enum: [...ASSET_STATES] }, categoryCode: code, search: { type: 'string', maxLength: 100 }, ...paging },
        },
      },
    },
    async (request) => {
      const grant = await register(request, 'read');
      return listAssets(db, grant, request.query as { state?: string; categoryCode?: string; search?: string; page: number; pageSize: number });
    },
  );

  app.post(
    '/assets',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['assetCode', 'categoryCode', 'description'],
          properties: {
            assetCode: { type: 'string', minLength: 1, maxLength: 40 },
            categoryCode: code,
            description: { type: 'string', minLength: 1, maxLength: 500 },
            identifier: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await register(request, 'manage');
      const result = await withTransaction(db, (tx) => createAsset(tx, grant, request.body as AssetInput));
      reply.status(201);
      return result;
    },
  );

  app.get('/assets/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await register(request, 'read', id);
    return getAsset(db, grant, id);
  });

  app.patch(
    '/assets/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          minProperties: 2,
          properties: {
            expectedVersion,
            categoryCode: code,
            description: { type: 'string', minLength: 1, maxLength: 500 },
            identifier: { anyOf: [{ type: 'string', maxLength: 200 }, { type: 'null' }] },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await register(request, 'manage', id);
      return withTransaction(db, (tx) => updateAsset(tx, grant, id, request.body as AssetUpdate));
    },
  );

  app.post(
    '/assets/:id/retire',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['note', 'expectedVersion'], properties: { retiredOn: date, note, expectedVersion } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await register(request, 'manage', id);
      return withTransaction(db, (tx) => retireAsset(tx, grant, id, request.body as RetireInput));
    },
  );

  // ------------------------------------------------------------------------------------------------------
  // Custody (Admin): issue and return
  // ------------------------------------------------------------------------------------------------------

  app.post(
    '/assets/:id/issue',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['employeeId', 'condition', 'idempotencyKey'],
          properties: { employeeId: uuid, issuedOn: date, condition: note, requestId: uuid, idempotencyKey },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await register(request, 'custody', id);
      const result = await withTransaction(db, (tx) => issueAsset(tx, grant, id, request.body as IssueInput));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  app.post(
    '/assets/:id/return',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['condition', 'idempotencyKey'], properties: { returnedOn: date, condition: note, idempotencyKey } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await register(request, 'custody', id);
      return withTransaction(db, (tx) => returnAsset(tx, grant, id, request.body as ReturnInput));
    },
  );

  // ------------------------------------------------------------------------------------------------------
  // An employee's items and requests (row scope: the Employee OWN context sees its own record only)
  // ------------------------------------------------------------------------------------------------------

  app.get(
    '/employees/:id/assets',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['HELD', 'RETURNED'] } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'asset', 'read', ['operational'], { recordKey: id });
      await employeeInScope(request, grant, 'asset_custody', id);
      return listEmployeeAssets(db, grant, id, (request.query as { status?: 'HELD' | 'RETURNED' }).status);
    },
  );

  app.get('/employees/:id/asset-requests', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'asset_request', 'read', ['operational'], { recordKey: id });
    await employeeInScope(request, grant, 'asset_request', id);
    return listEmployeeRequests(db, grant, id);
  });

  // ------------------------------------------------------------------------------------------------------
  // Employee OWN context (H3 TN16): acknowledgment and custody requests
  // ------------------------------------------------------------------------------------------------------

  app.post(
    '/me/asset-acknowledgments',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['custodyId'], properties: { custodyId: uuid } } } },
    async (request, reply) => {
      const { custodyId } = request.body as { custodyId: string };
      const grant = await requireAccess(db, request, 'asset', 'acknowledge', ['operational'], { requireAll: true, recordKey: custodyId });
      const result = await withTransaction(db, (tx) => acknowledgeCustody(tx, grant, custodyId));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  app.get('/me/asset-categories', async (request) => {
    const grant = await requireAccess(db, request, 'asset_request', 'submit', ['operational']);
    return listCategories(db, grant.companyId);
  });

  app.post(
    '/me/asset-requests',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['categoryCode', 'reason', 'idempotencyKey'],
          properties: { categoryCode: code, itemDescription: { type: 'string', maxLength: 300 }, reason: note, idempotencyKey },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'asset_request', 'submit', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => submitRequest(tx, grant, request.body as RequestInput));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  app.post('/me/asset-requests/:id/withdraw', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'asset_request', 'submit', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => withdrawRequest(tx, grant, id));
  });

  // ------------------------------------------------------------------------------------------------------
  // Review (an independent eligible Admin from the explicit list) and fulfilment lists
  // ------------------------------------------------------------------------------------------------------

  app.get(
    '/asset-requests',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { state: { type: 'string', enum: [...REQUEST_STATES] }, unfulfilled: { type: 'boolean' }, ...paging },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'asset_request', 'read', ['operational']);
      return listRequests(db, grant, request.query as { state?: string; unfulfilled?: boolean; page: number; pageSize: number });
    },
  );

  app.get('/asset-requests/tasks/mine', async (request) => {
    const grant = await requireAccess(db, request, 'asset_request', 'decide', ['operational']);
    return requestTasks(db, grant);
  });

  app.post(
    '/asset-requests/tasks/:id/decision',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'idempotencyKey'],
          properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] }, reason: note, idempotencyKey },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'asset_request', 'decide', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideRequest(tx, grant, id, request.body as DecisionInput));
    },
  );
}
