import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { forbidden } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import { approveGrant, endGrant, type GrantProposal, listCompanyUsers, listGrants, listRoleCatalogue, myAssignments, proposeGrant } from './admin.js';
import { canAccessEmployee } from './authorize.js';
import {
  approveRolePermissionChange,
  listRolePermissionChanges,
  proposeRolePermissionChange,
  rejectRolePermissionChange,
  type RolePermissionChangeQuery,
  type RolePermissionProposal,
} from './role-permissions.js';
import type { IdentityAdmin } from '../../auth/identity-admin.js';
import { type AccountChangeInput, createAccount, deleteAccount, getAccount, type NewAccountInput, resetPassword, updateAccount } from './accounts.js';
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

const personName = { type: 'string', minLength: 1, maxLength: 100 } as const;
const newAccountSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['email', 'firstName', 'lastName'],
  properties: { email: { type: 'string', minLength: 3, maxLength: 200 }, firstName: personName, lastName: personName },
} as const;
const accountChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  properties: { expectedVersion: { type: 'integer', minimum: 1 }, email: { type: 'string', minLength: 3, maxLength: 200 }, firstName: personName, lastName: personName },
} as const;
const resetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

export async function accessRoutes(app: FastifyInstance, opts: { db: Database; identity?: IdentityAdmin | null }): Promise<void> {
  const { db } = opts;
  // The sign-in provider's user administration (auth/identity-admin.ts); none on the development server.
  const identity = opts.identity ?? null;

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

  // FR-066, FR-067, C3 maintain_role_permissions: a change to what a role allows is proposed and decided by someone independent.
  app.get(
    '/access/role-permission-changes',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { state: { type: 'string', enum: ['PROPOSED', 'APPROVED', 'REJECTED'] }, roleCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' } },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'access', 'read_users', ['operational']);
      return listRolePermissionChanges(db, grant, request.query as RolePermissionChangeQuery);
    },
  );

  app.post(
    '/access/role-permission-changes',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['roleCode', 'permission', 'change', 'reason'],
          properties: {
            roleCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' },
            permission: { type: 'string', maxLength: 200, pattern: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' },
            change: { type: 'string', enum: ['ALLOW', 'DENY', 'REMOVE'] },
            reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'access', 'maintain_role_permissions', ['operational'], { requireAll: true });
      const id = await withTransaction(db, (tx) => proposeRolePermissionChange(tx, grant, request.body as RolePermissionProposal));
      reply.status(201);
      return { id, state: 'PROPOSED' };
    },
  );

  app.post('/access/role-permission-changes/:id/approve', { schema: { params: idParams, body: versionSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const { expectedVersion } = request.body as { expectedVersion: number };
    const grant = await requireAccess(db, request, 'access', 'approve_role_grant', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => approveRolePermissionChange(tx, grant, id, expectedVersion));
  });

  app.post('/access/role-permission-changes/:id/reject', { schema: { params: idParams, body: reasonSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const { expectedVersion, reason } = request.body as { expectedVersion: number; reason: string };
    const grant = await requireAccess(db, request, 'access', 'approve_role_grant', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => rejectRolePermissionChange(tx, grant, id, expectedVersion, reason));
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
    return withTransaction(db, (tx) => setAccountActive(tx, grant, id, false, request.body as AccountStateInput, identity));
  });

  app.post('/access/users/:id/reactivate', { schema: { params: idParams, body: reasonSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'deactivate_user', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => setAccountActive(tx, grant, id, true, request.body as AccountStateInput, identity));
  });

  // FR-001, the source system's User Master (0311; owner request of 13 Nov 2026): an account with its sign-in, created, changed,
  // given a new temporary password, or deleted when never used (accounts.ts).
  app.post('/access/accounts', { schema: { body: newAccountSchema } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'access', 'manage_accounts', ['operational'], { requireAll: true });
    const created = await withTransaction(db, (tx) => createAccount(tx, grant, identity, request.body as NewAccountInput));
    reply.status(201);
    return created;
  });

  app.get('/access/accounts/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'manage_accounts', ['operational'], { requireAll: true, recordKey: id });
    return getAccount(db, grant, identity, id);
  });

  app.patch('/access/accounts/:id', { schema: { params: idParams, body: accountChangeSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'manage_accounts', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => updateAccount(tx, grant, identity, id, request.body as AccountChangeInput));
  });

  app.post('/access/accounts/:id/reset-password', { schema: { params: idParams, body: resetSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'manage_accounts', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => resetPassword(tx, grant, identity, id, request.body as { reason: string }));
  });

  app.post('/access/accounts/:id/delete', { schema: { params: idParams, body: reasonSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'manage_accounts', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => deleteAccount(tx, grant, identity, id, request.body as { expectedVersion: number; reason: string }));
  });
}
