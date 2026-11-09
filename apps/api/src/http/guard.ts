// Route-level access guard. Every protected handler calls requireAccess before touching data.
// Denied attempts are audited with redacted metadata only (FR-098: no confidential payload).
import type { FastifyRequest } from 'fastify';
import { writeAudit } from '../audit/audit.js';
import type { Queryable } from '../db/queryable.js';
import { type AccessGrant, resolveAccess } from '../modules/access/authorize.js';
import { actorOf } from './context.js';
import { forbidden } from './errors.js';

export interface GuardOptions {
  /** Every requested field group must be allowed (writes). Reads default to "at least one". */
  requireAll?: boolean;
  /** Groups a read must hold whatever else it asks for: another group of the same read does not open it. */
  requireGroups?: readonly string[];
  /** Target record for the denial audit trail, when known. */
  recordKey?: string;
}

export async function requireAccess(
  db: Queryable,
  request: FastifyRequest,
  resource: string,
  action: string,
  fieldGroups: readonly string[],
  options: GuardOptions = {},
): Promise<AccessGrant> {
  const actor = actorOf(request);
  const decision = actor.assignmentId
    ? await resolveAccess(db, { userId: actor.userId, companyId: actor.companyId, assignmentId: actor.assignmentId, resource, action, fieldGroups })
    : ({ allowed: false, reason: 'ASSIGNMENT_NOT_ACTIVE', deniedFieldGroups: [] } as const);

  const deniedGroups = decision.deniedFieldGroups;
  const denied = !decision.allowed || (options.requireAll === true && deniedGroups.length > 0) || (options.requireGroups ?? []).some((g) => !decision.allowedFieldGroups.includes(g));
  if (!denied) return decision as AccessGrant;

  await auditDenial(db, request, {
    resource,
    action,
    reason: decision.allowed ? 'FIELD_GROUP_DENIED' : decision.reason,
    fieldGroups: deniedGroups.map((d) => d.fieldGroup),
    recordKey: options.recordKey,
  });
  throw forbidden();
}

/**
 * Resolves the permission again inside the caller's transaction, after its own locks (docs/09 §6.5): decision and
 * money-moving transactions call it so a narrowing committed since the route guard (assignment state or dates, role
 * permission, DB109 entry, user or company deactivation, classification) refuses the action and records nothing. The
 * acting assignment row is share-locked, so grant approval and revocation (access/admin.ts locks it for update) are
 * ordered strictly before or after the caller.
 */
export async function reassertAccess(tx: Queryable, grant: AccessGrant, resource: string, action: string, fieldGroups: readonly string[]): Promise<void> {
  await tx.query(`select 1 from role_assignment where company_id = $1 and id = $2 for share`, [grant.companyId, grant.assignmentId]);
  const current = await resolveAccess(tx, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource, action, fieldGroups });
  if (!current.allowed || fieldGroups.some((g) => !current.allowedFieldGroups.includes(g))) throw forbidden();
}

/**
 * Records a refusal in the audit trail of the company the request named (FR-098: no confidential payload), but only when the signed-in
 * user has a tie to that company: a role assignment in any state, or an employee link, at any time. I-84 item 16 (I-74 item 11; decided
 * under owner delegation, 6 Nov 2026): a request naming a company the user never belonged to, such as a replayed header, writes nothing
 * there, so nobody can add rows to a company's trail by knowing its id; it goes to the application's security log instead, with the
 * request id, the user, the named company, the action and the reason. The answer is the same 403 either way.
 */
export async function auditDenial(
  db: Queryable,
  request: FastifyRequest,
  info: { resource: string; action: string; reason: string; fieldGroups?: string[]; recordKey?: string | undefined },
): Promise<void> {
  const actor = actorOf(request);
  const tied = (
    await db.query<{ tied: boolean }>(
      `select exists (select 1 from role_assignment where company_id = $1 and user_id = $2)
           or exists (select 1 from user_employee_link where company_id = $1 and user_id = $2) as tied`,
      [actor.companyId, actor.userId],
    )
  ).rows[0]?.tied;
  if (!tied) {
    request.log.warn(
      { event: 'ACCESS_DENIED_OUTSIDE_COMPANY', userId: actor.userId, namedCompanyId: actor.companyId, resource: info.resource, action: info.action, reason: info.reason },
      'Refused a request naming a company the user has no tie to',
    );
    return;
  }
  // Only record against a company that exists; the acting assignment is omitted because a denied
  // assignment id may not belong to the actor.
  await writeAudit(db, {
    companyId: actor.companyId,
    resource: info.resource,
    recordKey: info.recordKey ?? actor.userId,
    actorUserId: actor.userId,
    actingAssignmentId: null,
    action: 'ACCESS_DENIED',
    after: { action: info.action, reason: info.reason, fieldGroups: info.fieldGroups ?? [], requestId: request.id },
  }).catch((err: { code?: string }) => {
    if (err.code !== '23503') throw err; // unknown company or user: nothing to attach the record to
  });
}
