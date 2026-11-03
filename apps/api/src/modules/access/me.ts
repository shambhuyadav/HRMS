// Self-service context for the UI: the selected assignment's effective permissions (for display only; the
// server re-checks every request) and a development-only sign-in that creates a server-side session.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionStore } from '../../auth/sessions.js';
import { type DevTokenConfig, issueDevToken } from '../../auth/tokens.js';
import type { Queryable } from '../../db/queryable.js';
import type { Database } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { forbidden, HttpError } from '../../http/errors.js';
import { auditDenial } from '../../http/guard.js';
import { OWN_ESS_ROLE_CODES } from './authorize.js';

/**
 * The permission keys an assignment can use, by the same rules as resolveAccess: role ALLOW plus the DB109
 * allowlist; a confidential group only in an Admin/Manager assignment, or (H1/BR-053) an own-ESS group in the
 * Employee OWN context, where row scope keeps it to the employee's own record.
 */
export async function assignmentPermissionKeys(db: Queryable, actor: { companyId: string; assignmentId: string | null; userId: string }): Promise<string[]> {
  if (!actor.assignmentId) return [];
  const rows = await db.query<{ key: string }>(
    `select p.resource || '.' || p.action || '.' || p.field_group as key
       from role_assignment ra
       join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
       join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.active
            and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
       join permission p on p.id = rap.permission_id
       join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = p.id and rp.effect = 'ALLOW'
      where ra.company_id = $1 and ra.id = $2 and ra.user_id = $3 and ra.state = 'ACTIVE'
        and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
        and (r.access_class in ('ADMIN', 'MANAGER')
             or (p.own_ess and r.code = any($4::text[]) and ra.scope_kind = 'OWN')
             or coalesce((select cfp.classification from confidential_field_policy cfp
                 where cfp.company_id = ra.company_id and cfp.resource_code = p.resource and cfp.field_group = p.field_group
                   and cfp.effective_from <= hrms_business_date(ra.company_id, now())
                   and (cfp.effective_to is null or cfp.effective_to > hrms_business_date(ra.company_id, now()))), 'CONFIDENTIAL') = 'OPERATIONAL')
      order by 1`,
    [actor.companyId, actor.assignmentId, actor.userId, OWN_ESS_ROLE_CODES],
  );
  return rows.rows.map((r) => r.key);
}

export async function meRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // Same order as resolveAccess: an inactive user or company has no context at all (FR-001), so these two routes, which no
  // access guard covers, refuse them the same way and record it (FR-098).
  const refuseInactive = async (request: FastifyRequest, action: string): Promise<void> => {
    const actor = actorOf(request);
    const row = (
      await db.query<{ user_active: boolean; company_active: boolean }>(
        `select u.active as user_active, c.active as company_active from user_account u cross join company c where u.id = $1 and c.id = $2`,
        [actor.userId, actor.companyId],
      )
    ).rows[0];
    if (row?.user_active && row.company_active) return;
    await auditDenial(db, request, { resource: 'access', action, reason: !row ? 'UNKNOWN_CONTEXT' : !row.user_active ? 'USER_INACTIVE' : 'COMPANY_INACTIVE' });
    throw forbidden();
  };

  app.get('/me/permissions', async (request) => {
    await refuseInactive(request, 'read_permissions');
    return { permissions: await assignmentPermissionKeys(db, actorOf(request)) };
  });

  // Everything the UI needs to label the session (FR-096: role and scope always visible).
  app.get('/me/context', async (request) => {
    await refuseInactive(request, 'read_context');
    const actor = actorOf(request);
    const row = (
      await db.query<{ role_code: string; role_name: string; scope_kind: string; company_name: string; employee_id: string | null; display_name: string | null; account_key: string }>(
        `select r.code as role_code, r.name as role_name, ra.scope_kind, c.name as company_name, u.account_key,
                l.employee_id, e.display_name
           from role_assignment ra
           join role r on r.company_id = ra.company_id and r.id = ra.role_id
           join company c on c.id = ra.company_id
           join user_account u on u.id = ra.user_id
           left join user_employee_link l on l.company_id = ra.company_id and l.user_id = ra.user_id
                and l.effective_from <= hrms_business_date(ra.company_id, now()) and (l.effective_to is null or l.effective_to > hrms_business_date(ra.company_id, now()))
           left join employee e on e.company_id = l.company_id and e.id = l.employee_id
          where ra.company_id = $1 and ra.id = $2 and ra.user_id = $3 and ra.state = 'ACTIVE'`,
        [actor.companyId, actor.assignmentId, actor.userId],
      )
    ).rows[0];
    if (!row) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
    return {
      userId: actor.userId,
      accountKey: row.account_key,
      companyName: row.company_name,
      roleCode: row.role_code,
      roleName: row.role_name,
      scopeKind: row.scope_kind,
      employeeId: row.employee_id,
      displayName: row.display_name,
    };
  });
}

/**
 * Development-only sign-in for synthetic accounts. Mounted only when buildApp is called with devLogin; the
 * production server never enables it (real sign-in comes from the OIDC provider, ADR-06).
 */
export async function devLoginRoutes(app: FastifyInstance, opts: { db: Database; sessions: SessionStore; tokens: DevTokenConfig }): Promise<void> {
  const { db, sessions, tokens } = opts;
  app.post(
    '/dev/login',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['accountKey'], properties: { accountKey: { type: 'string', minLength: 3, maxLength: 200 } } } } },
    async (request) => {
      const { accountKey } = request.body as { accountKey: string };
      const user = (await db.query<{ id: string }>(`select id from user_account where account_key = $1 and active`, [accountKey.trim().toLowerCase()])).rows[0];
      if (!user) throw new HttpError(401, 'UNAUTHENTICATED', 'Unknown or inactive account');
      const sessionId = await sessions.create(user.id, 8 * 3600);
      const companies = await db.query(
        `select distinct c.id, c.code, c.name from role_assignment ra join company c on c.id = ra.company_id and c.active
          where ra.user_id = $1 and ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
          order by c.name`,
        [user.id],
      );
      return { token: await issueDevToken(tokens, user.id, sessionId, 8 * 3600), companies: companies.rows };
    },
  );
}
