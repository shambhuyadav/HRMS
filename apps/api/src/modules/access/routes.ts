import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { forbidden } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import { approveGrant, endGrant, type GrantProposal, listCompanyUsers, listGrants, listRoleCatalogue, myAssignments, proposeGrant } from './admin.js';
import { canAccessEmployee } from './authorize.js';
import { type AccountStateInput, endUserLink, type EndUserLinkInput, linkUser, listUserLinks, setAccountActive, type UserLinkInput, type UserLinkQuery } from './user-admin.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const uuidList = { type: 'array', items: uuid, maxItems: 200 } as const;

const proposeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['userId', 'roleCode', 'effectiveFrom'],
  properties: {
    userId: uuid,
    roleCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' },
    scopeKind: { type: 'string', enum: ['OWN', 'TEAM', 'ASSIGNED', 'COMPANY'] },
    effectiveFrom: { type: 'string', format: 'date-time' },
    effectiveTo: { type: 'string', format: 'date-time' },
    permissions: { type: 'array', maxItems: 200, items: { type: 'string', pattern: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' } },
    filters: {
      type: 'object',
      additionalProperties: false,
      properties: { departments: uuidList, locations: uuidList, employees: uuidList },
    },
    purpose: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const versionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  properties: { expectedVersion: { type: 'integer', minimum: 1 } },
} as const;

const reasonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'reason'],
  properties: { expectedVersion: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: { userId: uuid, state: { type: 'string', enum: ['PENDING', 'ACTIVE', 'REVOKED'] } },
} as const;

const date = { type: 'string', format: 'date' } as const;

const linkSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['accountKey', 'employeeId', 'effectiveFrom'],
  properties: {
    accountKey: { type: 'string', minLength: 3, maxLength: 200 },
    employeeId: uuid,
    effectiveFrom: date,
    effectiveTo: date,
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const endLinkSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'reason'],
  properties: { expectedVersion: { type: 'integer', minimum: 1 }, effectiveTo: date, reason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

const linkListQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    userId: uuid,
    employeeId: uuid,
    page: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
    pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 },
  },
} as const;

export async function accessRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.get('/me/assignments', { config: { assignmentOptional: true } }, async (request) => {
    const actor = actorOf(request);
    return myAssignments(db, actor.userId, actor.companyId);
  });

  // Pickers for grant administration (FR-066): who can be granted, and what each role may hold.
  app.get('/access/roles', async (request) => {
    const grant = await requireAccess(db, request, 'access', 'read_users', ['operational']);
    return listRoleCatalogue(db, grant);
  });

  app.get(
    '/access/users',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            // An empty or blank search lists everyone (as the employee and team lists do).
            search: { type: 'string', maxLength: 100 },
            // F2 "Active accounts": the dashboard widget's filter.
            holdingAccess: { type: 'boolean' },
            page: { type: 'integer', minimum: 1, maximum: 100000, default: 1 },
            pageSize: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
          },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'access', 'read_users', ['operational']);
      // Same boundary as proposing grants (C4): company scope only. Recorded like any other denial (FR-098).
      if (grant.scopeKind !== 'COMPANY') {
        await auditDenial(db, request, { resource: 'access', action: 'read_users', reason: 'OUT_OF_SCOPE' });
        throw forbidden();
      }
      return listCompanyUsers(db, grant, request.query as { search?: string; holdingAccess?: boolean; page: number; pageSize: number });
    },
  );

  app.get('/access/assignments', { schema: { querystring: listQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'access', 'read_users', ['operational']);
    if (grant.scopeKind !== 'COMPANY') {
      await auditDenial(db, request, { resource: 'access', action: 'read_users', reason: 'OUT_OF_SCOPE' });
      throw forbidden();
    }
    return listGrants(db, grant, request.query as { userId?: string; state?: string });
  });

  app.post('/access/assignments', { schema: { body: proposeSchema } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'access', 'assign_role', ['operational'], { requireAll: true });
    const id = await withTransaction(db, (tx) => proposeGrant(tx, grant, request.body as GrantProposal));
    reply.status(201);
    return { id, state: 'PENDING' };
  });

  app.post('/access/assignments/:id/approve', { schema: { params: idParams, body: versionSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const { expectedVersion } = request.body as { expectedVersion: number };
    const grant = await requireAccess(db, request, 'access', 'approve_role_grant', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => approveGrant(tx, grant, id, expectedVersion));
    return { id, state: 'ACTIVE' };
  });

  app.post('/access/assignments/:id/reject', { schema: { params: idParams, body: reasonSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const { expectedVersion, reason } = request.body as { expectedVersion: number; reason: string };
    const grant = await requireAccess(db, request, 'access', 'approve_role_grant', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => endGrant(tx, grant, id, expectedVersion, reason, 'REJECT'));
    return { id, state: 'REVOKED' };
  });

  app.post('/access/assignments/:id/revoke', { schema: { params: idParams, body: reasonSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const { expectedVersion, reason } = request.body as { expectedVersion: number; reason: string };
    const grant = await requireAccess(db, request, 'access', 'revoke_role', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => endGrant(tx, grant, id, expectedVersion, reason, 'REVOKE'));
    return { id, state: 'REVOKED' };
  });

  // User to employee links (§5.1, DB009). A link grants no permission by itself.
  app.get('/access/user-links', { schema: { querystring: linkListQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'access', 'read_users', ['operational']);
    if (grant.scopeKind !== 'COMPANY') {
      await auditDenial(db, request, { resource: 'access', action: 'read_users', reason: 'OUT_OF_SCOPE' });
      throw forbidden();
    }
    return listUserLinks(db, grant, request.query as UserLinkQuery);
  });

  app.post('/access/user-links', { schema: { body: linkSchema } }, async (request, reply) => {
    const input = request.body as UserLinkInput;
    const grant = await requireAccess(db, request, 'access', 'link_user', ['operational'], { requireAll: true, recordKey: input.employeeId });
    // Out of scope and missing read the same (BR-045); the attempt is recorded like any other denial (FR-098).
    if (grant.scopeKind === 'COMPANY' && !(await canAccessEmployee(db, grant, input.employeeId))) {
      await auditDenial(db, request, { resource: 'access', action: 'link_user', reason: 'OUT_OF_SCOPE', recordKey: input.employeeId });
    }
    const created = await withTransaction(db, (tx) => linkUser(tx, grant, input));
    reply.status(201);
    return created;
  });

  app.post('/access/user-links/:id/end', { schema: { params: idParams, body: endLinkSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'link_user', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => endUserLink(tx, grant, id, request.body as EndUserLinkInput));
  });

  // DB007, FR-001 "A disabled user cannot sign in": an account whose ties are all in this company.
  app.post('/access/users/:id/deactivate', { schema: { params: idParams, body: reasonSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'deactivate_user', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => setAccountActive(tx, grant, id, false, request.body as AccountStateInput));
  });

  app.post('/access/users/:id/reactivate', { schema: { params: idParams, body: reasonSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'deactivate_user', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => setAccountActive(tx, grant, id, true, request.body as AccountStateInput));
  });
}
