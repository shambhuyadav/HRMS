// Delegation routes (FR-003, FR-068). `access.delegate` asks for a delegation of the selected assignment's own decision
// authority; `access.approve_role_grant` decides a request and `access.revoke_role` ends a running one (FR-067 grant duties).
// A person who is a party to a delegation can always read it, whatever they hold: the delegate needs to know what they received.
import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { forbidden } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import { resolveAccess } from './authorize.js';
import type { PermissionKey } from './baseline.js';
import {
  approveDelegation,
  delegableOptions,
  delegateCandidates,
  delegationDecisions,
  type DelegationRequest,
  endDelegation,
  listDelegations,
  myDelegatedTasks,
  myDelegations,
  rejectDelegation,
  requestDelegation,
} from './delegation.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const permissionKey = { type: 'string', maxLength: 200, pattern: '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$' } as const;
const reason = { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } as const;

const requestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['delegateUserId', 'permission', 'effectiveFrom', 'effectiveTo'],
  properties: {
    delegateUserId: uuid,
    permission: permissionKey,
    effectiveFrom: { type: 'string', format: 'date-time' },
    effectiveTo: { type: 'string', format: 'date-time' },
    purpose: { type: 'string', maxLength: 500 },
  },
} as const;

const versionSchema = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion: { type: 'integer', minimum: 1 } } } as const;
const reasonSchema = { type: 'object', additionalProperties: false, required: ['expectedVersion', 'reason'], properties: { expectedVersion: { type: 'integer', minimum: 1 }, reason } } as const;

export async function delegationRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // The caller's own records, as /me/assignments is: nothing to scope and no permission to hold.
  app.get('/me/delegations', { config: { assignmentOptional: true } }, async (request) => {
    const actor = actorOf(request);
    return myDelegations(db, actor.companyId, actor.userId);
  });

  // C4 history: a party reads their own; anyone else needs the administrative read, within its scope.
  app.get('/me/delegations/:id/decisions', { schema: { params: idParams }, config: { assignmentOptional: true } }, async (request) => {
    const actor = actorOf(request);
    return delegationDecisions(db, actor.companyId, (request.params as { id: string }).id, { userId: actor.userId });
  });

  app.get('/access/delegations/:id/decisions', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'read_users', ['operational'], { recordKey: id });
    return delegationDecisions(db, grant.companyId, id, { admin: grant });
  });

  // FR-096 "displaying the selected role and scope": tasks the selected assignment decides as a delegate.
  app.get('/me/delegated-tasks', async (request) => myDelegatedTasks(db, actorOf(request)));

  app.get('/access/delegations/options', async (request) => {
    const grant = await requireAccess(db, request, 'access', 'delegate', ['operational']);
    return delegableOptions(db, grant);
  });

  app.get(
    '/access/delegations/candidates',
    { schema: { querystring: { type: 'object', additionalProperties: false, required: ['permission'], properties: { permission: permissionKey } } } },
    async (request) => {
      const grant = await requireAccess(db, request, 'access', 'delegate', ['operational']);
      return delegateCandidates(db, grant, (request.query as { permission: PermissionKey }).permission);
    },
  );

  app.get(
    '/access/delegations',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: ['PENDING', 'ACTIVE', 'REJECTED', 'WITHDRAWN', 'ENDED'] } } } } },
    async (request) => {
      const grant = await requireAccess(db, request, 'access', 'read_users', ['operational']);
      if (grant.scopeKind !== 'COMPANY') {
        await auditDenial(db, request, { resource: 'access', action: 'read_users', reason: 'OUT_OF_SCOPE' });
        throw forbidden();
      }
      return listDelegations(db, grant, request.query as { state?: string });
    },
  );

  app.post('/access/delegations', { schema: { body: requestSchema } }, async (request, reply) => {
    const grant = await requireAccess(db, request, 'access', 'delegate', ['operational'], { requireAll: true });
    const created = await withTransaction(db, (tx) => requestDelegation(tx, grant, request.body as DelegationRequest));
    reply.status(201);
    return created;
  });

  app.post('/access/delegations/:id/approve', { schema: { params: idParams, body: versionSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'access', 'approve_role_grant', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => approveDelegation(tx, grant, id, (request.body as { expectedVersion: number }).expectedVersion));
  });

  app.post('/access/delegations/:id/reject', { schema: { params: idParams, body: reasonSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { expectedVersion: number; reason: string };
    const grant = await requireAccess(db, request, 'access', 'approve_role_grant', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => rejectDelegation(tx, grant, id, body.expectedVersion, body.reason));
  });

  // The revocation duty ends any delegation in its scope; otherwise the delegate duty ends the caller's own.
  app.post('/access/delegations/:id/end', { schema: { params: idParams, body: reasonSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = request.body as { expectedVersion: number; reason: string };
    const actor = actorOf(request);
    const revoking = actor.assignmentId
      ? await resolveAccess(db, { userId: actor.userId, companyId: actor.companyId, assignmentId: actor.assignmentId, resource: 'access', action: 'revoke_role', fieldGroups: ['operational'] })
      : null;
    if (revoking?.allowed) return withTransaction(db, (tx) => endDelegation(tx, revoking, 'ADMINISTRATOR', id, body.expectedVersion, body.reason));
    const grant = await requireAccess(db, request, 'access', 'delegate', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => endDelegation(tx, grant, 'DELEGATOR', id, body.expectedVersion, body.reason));
  });
}
