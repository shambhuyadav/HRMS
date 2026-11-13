// Role-grant administration (FR-066, FR-067, FR-068; C4; CI09; DF02).
// Proposal -> independent approval -> active. Rejection and revocation keep the record with a reason.
// Neither the requester nor the approver can hand out a scope wider than their own administrative scope,
// and the beneficiary or requester can never approve.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, OWN_ESS_ROLE_CODES, type ScopeFilters, type ScopeKind, SqlParams } from './authorize.js';
import { BASELINE_ROLES, C2_RECORD_SCOPES, type PermissionKey, parsePermissionKey } from './baseline.js';

export interface GrantProposal {
  userId: string;
  roleCode: string;
  scopeKind?: ScopeKind | undefined;
  effectiveFrom: string;
  effectiveTo?: string | undefined;
  permissions?: PermissionKey[] | undefined;
  filters?: Partial<ScopeFilters> | undefined;
  purpose?: string | undefined;
}

const normaliseFilters = (f: Partial<ScopeFilters> | undefined): ScopeFilters => ({
  departments: [...new Set(f?.departments ?? [])],
  locations: [...new Set(f?.locations ?? [])],
  employees: [...new Set(f?.employees ?? [])],
});

/**
 * An administrator can only administer inside its own scope: it must hold COMPANY scope, and every
 * dimension it is restricted on must also restrict the target to a subset (an unrestricted target
 * dimension would be wider than the administrator).
 */
function assertWithinAdministrativeScope(admin: AccessGrant, target: ScopeFilters): void {
  if (admin.scopeKind !== 'COMPANY') throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  if (!withinAdministrativeScope(admin, target)) throw new HttpError(403, 'SCOPE_EXCEEDS_ADMINISTRATOR', 'The grant would exceed your administrative scope');
}

/** The filter rule of assertWithinAdministrativeScope, for a company-scope administrator (also tells who may approve). */
export function withinAdministrativeScope(admin: Pick<AccessGrant, 'filters'>, target: ScopeFilters): boolean {
  const dims: (keyof ScopeFilters)[] = ['departments', 'locations', 'employees'];
  return dims.every((dim) => {
    const outer = admin.filters[dim];
    if (outer.length === 0) return true;
    const inner = target[dim];
    return inner.length > 0 && inner.every((v) => outer.includes(v));
  });
}

/** C2 record scope of the role: an organisation-wide Reporting Manager or a company-scope Employee is refused (BR-044). */
function assertRecordScope(roleCode: string, scopeKind: ScopeKind): void {
  const allowed = C2_RECORD_SCOPES[roleCode];
  if (allowed && !allowed.includes(scopeKind)) {
    throw new HttpError(422, 'SCOPE_NOT_ALLOWED_FOR_ROLE', `Role ${roleCode} cannot hold ${scopeKind} scope`, { allowed });
  }
}

export async function loadFilters(db: Queryable, companyId: string, assignmentId: string): Promise<ScopeFilters> {
  const rows = (
    await db.query<{ dimension: string; value: string }>(
      `select dimension, coalesce(department_id, location_id, employee_id) as value
         from role_scope_filter where company_id = $1 and role_assignment_id = $2`,
      [companyId, assignmentId],
    )
  ).rows;
  return {
    departments: rows.filter((r) => r.dimension === 'DEPARTMENT').map((r) => r.value),
    locations: rows.filter((r) => r.dimension === 'LOCATION').map((r) => r.value),
    employees: rows.filter((r) => r.dimension === 'EMPLOYEE').map((r) => r.value),
  };
}

export async function proposeGrant(tx: Queryable, admin: AccessGrant, p: GrantProposal): Promise<string> {
  await reassertAccess(tx, admin, 'access', 'assign_role', ['operational']);
  const filters = normaliseFilters(p.filters);
  assertWithinAdministrativeScope(admin, filters);
  if (p.effectiveTo && Date.parse(p.effectiveTo) <= Date.parse(p.effectiveFrom)) {
    throw new HttpError(422, 'INVALID_PERIOD', 'The grant must end after it starts');
  }

  const user = (await tx.query<{ active: boolean }>('select active from user_account where id = $1', [p.userId])).rows[0];
  if (!user?.active) throw new HttpError(422, 'INVALID_REFERENCE', 'User not found or inactive');

  const role = (
    await tx.query<{ id: string; access_class: string }>(
      `select id, access_class from role where company_id = $1 and code = $2 and active`,
      [admin.companyId, p.roleCode],
    )
  ).rows[0];
  if (!role) throw new HttpError(422, 'INVALID_REFERENCE', 'Role not found or inactive');

  const baseline = BASELINE_ROLES.find((r) => r.code === p.roleCode);
  const scopeKind = p.scopeKind ?? baseline?.defaultScope;
  if (!scopeKind) throw new HttpError(422, 'SCOPE_REQUIRED', 'Scope kind is required for this role');
  assertRecordScope(p.roleCode, scopeKind);
  // New assignments start empty and are seeded only with the role's default duties (DF02).
  const keys = [...new Set(p.permissions ?? baseline?.defaultDuties ?? [])];

  // Each permission must be inside the role ceiling; resolve classification for the confidential checks.
  const perms: { id: string; key: PermissionKey; confidential: boolean }[] = [];
  // H1/BR-053: an Employee assignment in OWN scope may hold the catalogued own-ESS groups (own record only).
  const ownEssContext = OWN_ESS_ROLE_CODES.includes(p.roleCode) && scopeKind === 'OWN';
  for (const key of keys) {
    const { resource, action, fieldGroup } = parsePermissionKey(key);
    const row = (
      await tx.query<{ id: string; allowed: boolean; classification: string; own_ess: boolean }>(
        `select p.id, p.own_ess,
                exists (select 1 from role_permission rp where rp.company_id = $1 and rp.role_id = $2
                           and rp.permission_id = p.id and rp.effect = 'ALLOW') as allowed,
                coalesce((select cfp.classification from confidential_field_policy cfp
                           where cfp.company_id = $1 and cfp.resource_code = p.resource and cfp.field_group = p.field_group
                             and cfp.effective_from <= hrms_business_date($1, now())
                             and (cfp.effective_to is null or cfp.effective_to > hrms_business_date($1, now()))), 'CONFIDENTIAL') as classification
           from permission p where p.resource = $3 and p.action = $4 and p.field_group = $5`,
        [admin.companyId, role.id, resource, action, fieldGroup],
      )
    ).rows[0];
    if (!row) throw new HttpError(422, 'UNKNOWN_PERMISSION', `Permission ${key} is not in the catalogue`);
    if (!row.allowed) throw new HttpError(422, 'OUTSIDE_ROLE_CEILING', `Role ${p.roleCode} cannot hold ${key}`);
    // An own-ESS permission in the Employee OWN context discloses only the beneficiary's own record, so it is
    // not an other-person confidential grant (no Admin/Manager eligibility or purpose needed).
    perms.push({ id: row.id, key, confidential: row.classification === 'CONFIDENTIAL' && !(ownEssContext && row.own_ess) });
  }

  const confidential = perms.filter((x) => x.confidential).map((x) => x.key);
  if (confidential.length > 0) {
    if (role.access_class === 'OTHER') {
      throw new HttpError(422, 'CONFIDENTIAL_NOT_ELIGIBLE', 'Only Admin or Manager roles can hold confidential permissions');
    }
    if (!p.purpose?.trim()) throw new HttpError(422, 'PURPOSE_REQUIRED', 'A business purpose is required for confidential permissions');
  }

  const assignmentId = (
    await tx.query<{ id: string }>(
      `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, effective_to, state, purpose, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $8, $8) returning id`,
      [admin.companyId, p.userId, role.id, scopeKind, p.effectiveFrom, p.effectiveTo ?? null, p.purpose?.trim() ?? null, admin.userId],
    )
  ).rows[0]!.id;

  const filterRows: [string, string, string][] = [
    ...filters.departments.map((v) => ['DEPARTMENT', 'department_id', v] as [string, string, string]),
    ...filters.locations.map((v) => ['LOCATION', 'location_id', v] as [string, string, string]),
    ...filters.employees.map((v) => ['EMPLOYEE', 'employee_id', v] as [string, string, string]),
  ];
  for (const [dimension, column, value] of filterRows) {
    await tx.query(
      `insert into role_scope_filter (company_id, role_assignment_id, dimension, ${column}, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $5)`,
      [admin.companyId, assignmentId, dimension, value, admin.userId],
    );
  }
  for (const perm of perms) {
    await tx.query(
      `insert into role_assignment_permission (company_id, role_assignment_id, permission_id, active, effective_from, effective_to, created_by, updated_by)
       values ($1, $2, $3, false, $4, $5, $6, $6)`,
      [admin.companyId, assignmentId, perm.id, p.effectiveFrom, p.effectiveTo ?? null, admin.userId],
    );
  }

  await writeAudit(tx, {
    companyId: admin.companyId,
    resource: 'access_grant',
    recordKey: assignmentId,
    actorUserId: admin.userId,
    actingAssignmentId: admin.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: {
      operational: { userId: p.userId, roleCode: p.roleCode, scopeKind, filters, permissions: keys, confidential, purpose: p.purpose ?? null },
    },
  });
  await enqueueEvent(tx, {
    companyId: admin.companyId,
    topic: 'access.grant_proposed',
    aggregateId: assignmentId,
    dedupeKey: `access.grant_proposed:${assignmentId}`,
    payload: { assignmentId },
  });
  return assignmentId;
}

interface AssignmentRow {
  id: string;
  user_id: string;
  state: 'PENDING' | 'ACTIVE' | 'REVOKED';
  scope_kind: ScopeKind;
  role_code: string;
  created_by: string | null;
  version: number;
}

async function lockAssignment(tx: Queryable, companyId: string, id: string, expectedVersion: number): Promise<AssignmentRow> {
  const row = (
    await tx.query<AssignmentRow>(
      `select ra.id, ra.user_id, ra.state, ra.scope_kind, r.code as role_code, ra.created_by, ra.version
         from role_assignment ra join role r on r.company_id = ra.company_id and r.id = ra.role_id
        where ra.company_id = $1 and ra.id = $2 for update of ra`,
      [companyId, id],
    )
  ).rows[0];
  if (!row) throw notFound();
  if (row.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  return row;
}

export async function approveGrant(tx: Queryable, approver: AccessGrant, id: string, expectedVersion: number): Promise<void> {
  const row = await lockAssignment(tx, approver.companyId, id, expectedVersion);
  if (row.state !== 'PENDING') throw new HttpError(409, 'INVALID_STATE', 'Only pending grants can be approved');
  // C4: no approval of one's own grant or of a grant one requested. The database enforces this as well.
  if (row.user_id === approver.userId || row.created_by === approver.userId) {
    throw new HttpError(403, 'SELF_APPROVAL', 'A grant cannot be approved by its beneficiary or requester');
  }
  await reassertAccess(tx, approver, 'access', 'approve_role_grant', ['operational']);
  // A proposal made before the C2 matrix was enforced is not approved outside it.
  assertRecordScope(row.role_code, row.scope_kind);
  assertWithinAdministrativeScope(approver, await loadFilters(tx, approver.companyId, id));
  // The role's ceiling can change while a proposal waits (role-permissions.ts): an entry outside it would revive if the ceiling came back.
  const outside = (
    await tx.query<{ key: string }>(
      `select p.resource || '.' || p.action || '.' || p.field_group as key
         from role_assignment_permission rap
         join role_assignment ra on ra.company_id = rap.company_id and ra.id = rap.role_assignment_id
         join permission p on p.id = rap.permission_id
        where rap.company_id = $1 and rap.role_assignment_id = $2
          and not exists (select 1 from role_permission rp where rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = rap.permission_id and rp.effect = 'ALLOW')
        order by 1`,
      [approver.companyId, id],
    )
  ).rows[0];
  if (outside) throw new HttpError(422, 'OUTSIDE_ROLE_CEILING', `Role ${row.role_code} can no longer hold ${outside.key}; reject this proposal and propose it again without it`);

  await tx.query(
    `update role_assignment set state = 'ACTIVE', approved_by = $3, approved_at = now(), updated_by = $3
      where company_id = $1 and id = $2`,
    [approver.companyId, id, approver.userId],
  );
  await tx.query(
    `update role_assignment_permission set active = true, updated_by = $3 where company_id = $1 and role_assignment_id = $2`,
    [approver.companyId, id, approver.userId],
  );
  await writeAudit(tx, {
    companyId: approver.companyId,
    resource: 'access_grant',
    recordKey: id,
    actorUserId: approver.userId,
    actingAssignmentId: approver.assignmentId,
    action: 'APPROVE',
    priorVersion: row.version,
    after: { operational: { state: 'ACTIVE' } },
  });
  await enqueueEvent(tx, {
    companyId: approver.companyId,
    topic: 'access.grant_approved',
    aggregateId: id,
    dedupeKey: `access.grant_approved:${id}`,
    payload: { assignmentId: id },
  });
}

/** Rejects a pending proposal or revokes an active grant; the record and its history are kept. */
export async function endGrant(
  tx: Queryable,
  actor: AccessGrant,
  id: string,
  expectedVersion: number,
  reason: string,
  mode: 'REJECT' | 'REVOKE',
): Promise<void> {
  const row = await lockAssignment(tx, actor.companyId, id, expectedVersion);
  const expected = mode === 'REJECT' ? 'PENDING' : 'ACTIVE';
  if (row.state !== expected) throw new HttpError(409, 'INVALID_STATE', `Only ${expected.toLowerCase()} grants can be ${mode === 'REJECT' ? 'rejected' : 'revoked'}`);
  await reassertAccess(tx, actor, 'access', mode === 'REJECT' ? 'approve_role_grant' : 'revoke_role', ['operational']);
  assertWithinAdministrativeScope(actor, await loadFilters(tx, actor.companyId, id));
  await tx.query(
    `update role_assignment set state = 'REVOKED', decision_reason = $3, updated_by = $4 where company_id = $1 and id = $2`,
    [actor.companyId, id, reason.trim(), actor.userId],
  );
  await tx.query(
    `update role_assignment_permission set active = false, updated_by = $3 where company_id = $1 and role_assignment_id = $2`,
    [actor.companyId, id, actor.userId],
  );
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource: 'access_grant',
    recordKey: id,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action: mode,
    priorVersion: row.version,
    after: { operational: { state: 'REVOKED' } },
    reason,
  });
  // DF12 "role-grant/security change": the beneficiary is told the outcome, never the reason. A grant ends once.
  await enqueueEvent(tx, {
    companyId: actor.companyId,
    topic: 'access.grant_ended',
    aggregateId: id,
    dedupeKey: `access.grant_ended:${id}`,
    payload: { assignmentId: id, outcome: mode === 'REJECT' ? 'REJECTED' : 'REVOKED' },
  });
}

export interface GrantFilters {
  userId?: string | undefined;
  state?: string | undefined;
}

/** The grants an administrator may see (alias ra), with the list's filters. */
function grantConditions(admin: AccessGrant, q: GrantFilters, params: SqlParams): string[] {
  const conditions = [`ra.company_id = ${params.add(admin.companyId)}::uuid`];
  if (q.userId) conditions.push(`ra.user_id = ${params.add(q.userId)}::uuid`);
  if (q.state) conditions.push(`ra.state = ${params.add(q.state)}`);
  const { departments, locations, employees } = admin.filters;
  if (departments.length > 0 || locations.length > 0 || employees.length > 0) {
    const day = `${params.add(admin.businessDate)}::date`;
    conditions.push(
      `exists (select 1 from user_employee_link l
                where l.company_id = ra.company_id and l.user_id = ra.user_id
                  and l.effective_from <= ${day} and (l.effective_to is null or l.effective_to > ${day})
                  and ${employeeScopePredicate(admin, { company: 'l.company_id', employee: 'l.employee_id' }, params)})`,
    );
  }
  return conditions;
}

/**
 * Grants of the company for administration. Same boundary as the user list (C4): company-scope administrators
 * only, and an administrator restricted by scope filters sees only grants of users whose current employee is
 * inside those filters. Each grant shows its own scope filters, so an approver sees the restrictions it approves.
 */
export async function listGrants(db: Queryable, admin: AccessGrant, q: GrantFilters) {
  if (admin.scopeKind !== 'COMPANY') throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  const params = new SqlParams();
  const conditions = grantConditions(admin, q, params);
  const rows = await db.query<Record<string, unknown> & { total: string }>(
    `select ra.id, ra.user_id as "userId", ua.account_key as "userAccountKey", r.code as "roleCode", ra.scope_kind as "scopeKind", ra.state,
            ra.effective_from as "effectiveFrom", ra.effective_to as "effectiveTo", ra.purpose,
            ra.created_by as "requestedBy", rq.account_key as "requestedByAccountKey",
            ra.approved_by as "approvedBy", ap.account_key as "approvedByAccountKey", ra.version,
            coalesce((select array_agg(p.resource || '.' || p.action || '.' || p.field_group order by 1)
                        from role_assignment_permission rap join permission p on p.id = rap.permission_id
                       where rap.company_id = ra.company_id and rap.role_assignment_id = ra.id), '{}') as permissions,
            (select json_build_object(
                      'departments', coalesce(array_agg(f.department_id) filter (where f.dimension = 'DEPARTMENT'), '{}'),
                      'locations', coalesce(array_agg(f.location_id) filter (where f.dimension = 'LOCATION'), '{}'),
                      'employees', coalesce(array_agg(f.employee_id) filter (where f.dimension = 'EMPLOYEE'), '{}'))
               from role_scope_filter f where f.company_id = ra.company_id and f.role_assignment_id = ra.id) as filters,
            count(*) over () as total
       from role_assignment ra
       join role r on r.company_id = ra.company_id and r.id = ra.role_id
       join user_account ua on ua.id = ra.user_id
       left join user_account rq on rq.id = ra.created_by
       left join user_account ap on ap.id = ra.approved_by
      where ${conditions.join(' and ')}
      order by ra.created_at desc limit 200`,
    params.values,
  );
  // `total` counts every match, so the 200-row cap says so (FR-056) and the dashboard's count reconciles past it.
  return { items: rows.rows.map(({ total: _t, ...r }) => r), total: Number(rows.rows[0]?.total ?? 0) };
}

/** listGrants' count (F2 "Pending independent access grants"), under its own boundary and filters (BR-045). */
export async function countAccessGrants(db: Queryable, admin: AccessGrant, q: GrantFilters): Promise<number> {
  if (admin.scopeKind !== 'COMPANY') throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  const params = new SqlParams();
  const conditions = grantConditions(admin, q, params);
  return Number((await db.query<{ n: string }>(`select count(*) as n from role_assignment ra where ${conditions.join(' and ')}`, params.values)).rows[0]?.n ?? 0);
}

/**
 * Role catalogue for grant administration (FR-066): every role of the company with its ceiling, each
 * permission's current classification (missing policy = CONFIDENTIAL, as proposeGrant decides) and whether it is
 * one of the baseline default duties. One query; no per-role round trips. Codes and keys sort by code point
 * (collate "C") so the order does not depend on the database's locale.
 */
export async function listRoleCatalogue(db: Queryable, admin: AccessGrant) {
  const rows = (
    await db.query<{ code: string; name: string; access_class: 'ADMIN' | 'MANAGER' | 'OTHER'; active: boolean; permissions: { key: string; confidential: boolean; own_ess: boolean }[] | null }>(
      `select r.code, r.name, r.access_class, r.active,
              (select json_agg(json_build_object('key', k.key, 'confidential', k.confidential, 'own_ess', k.own_ess) order by k.key collate "C")
                 from (select p.resource || '.' || p.action || '.' || p.field_group as key, p.own_ess,
                              coalesce((select cfp.classification from confidential_field_policy cfp
                                         where cfp.company_id = rp.company_id and cfp.resource_code = p.resource and cfp.field_group = p.field_group
                                           and cfp.effective_from <= $2::date and (cfp.effective_to is null or cfp.effective_to > $2::date)),
                                       'CONFIDENTIAL') = 'CONFIDENTIAL' as confidential
                         from role_permission rp join permission p on p.id = rp.permission_id
                        where rp.company_id = r.company_id and rp.role_id = r.id and rp.effect = 'ALLOW') k) as permissions
         from role r where r.company_id = $1 order by r.code collate "C"`,
      [admin.companyId, admin.businessDate],
    )
  ).rows;
  return {
    items: rows.map((r) => {
      const baseline = BASELINE_ROLES.find((b) => b.code === r.code);
      const duties = new Set<string>(baseline?.defaultDuties ?? []);
      const allowed = new Set((r.permissions ?? []).map((p) => p.key));
      return {
        code: r.code,
        name: r.name,
        accessClass: r.access_class,
        defaultScope: baseline?.defaultScope ?? null,
        active: r.active,
        // What role-permission maintenance could bring back into this baseline role's ceiling (role-permissions.ts).
        restorable: (baseline?.ceiling ?? []).filter((k) => !allowed.has(k)).sort(),
        // ownEss: confidential, but held only for the beneficiary's own record in the Employee OWN context (H1).
        permissions: (r.permissions ?? []).map((p) => ({
          key: p.key,
          confidential: p.confidential,
          ownEss: p.confidential && p.own_ess && OWN_ESS_ROLE_CODES.includes(r.code),
          defaultDuty: duties.has(p.key),
        })),
      };
    }),
  };
}

interface CompanyUserRow {
  userId: string;
  accountKey: string;
  active: boolean;
  version: number;
  employee: { id: string; employeeCode: string; displayName: string } | null;
  assignments: { active: number; pending: number };
  total: string;
}

/**
 * Users of the company for grant administration: accounts linked to an employee of the company or holding any
 * assignment in it. Same boundary as proposing grants: company-scope administrators only; an administrator
 * restricted by scope filters sees only users whose current employee is inside those filters (unlinked
 * accounts are hidden from them). Operational identity fields only. `assignments.active` counts approved
 * grants that have not ended; `pending` counts proposals awaiting a decision.
 *
 * Query shape (scale): candidates come from this company's own link and assignment rows, never from a scan of
 * every account in the cell; plain equi-joins (no per-user lateral lookups) let the planner hash-join a large
 * company; the total comes from the same statement and snapshot as the page (BR-026); assignment counts are
 * computed for the page rows only, not for rows skipped by the offset. `holdingAccess` keeps active accounts with an
 * approved assignment in force (F2 "Active accounts").
 */
export async function listCompanyUsers(db: Queryable, admin: AccessGrant, q: { search?: string | undefined; holdingAccess?: boolean | undefined; page: number; pageSize: number }) {
  if (admin.scopeKind !== 'COMPANY') throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  const params = new SqlParams();
  const company = `${params.add(admin.companyId)}::uuid`;
  const day = `${params.add(admin.businessDate)}::date`;
  const currentLink = (alias: string) =>
    `${alias}.company_id = ${company} and ${alias}.effective_from <= ${day} and (${alias}.effective_to is null or ${alias}.effective_to > ${day})`;
  const { departments, locations, employees } = admin.filters;
  // One (user, current employee) row per user: user_employee_link allows one link per user and company at any date.
  const members =
    departments.length > 0 || locations.length > 0 || employees.length > 0
      ? // Only a current link to an employee inside the filters can place a user in a filtered administrator's scope.
        `select l.user_id, l.employee_id from user_employee_link l
          where ${currentLink('l')} and ${employeeScopePredicate(admin, { company: 'l.company_id', employee: 'l.employee_id' }, params)}`
      : `select m.user_id, l.employee_id
           from (select x.user_id from user_employee_link x where x.company_id = ${company}
                 union
                 select ra.user_id from role_assignment ra where ra.company_id = ${company}
                 union
                 -- An account this company created (0311), before it is linked or granted anything.
                 select c.user_id from company_user_account c where c.company_id = ${company}) m
           left join user_employee_link l on l.user_id = m.user_id and ${currentLink('l')}`;
  // A blank search lists everyone; % _ and \ match literally. ILIKE folds both sides with the database's rules.
  const search = q.search?.trim();
  const pattern = search ? params.add(`%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`) : null;
  const shown = [];
  if (pattern) shown.push(`(u.account_key ilike ${pattern} or e.employee_code ilike ${pattern} or e.display_name ilike ${pattern})`);
  if (q.holdingAccess) {
    shown.push(`u.active and exists (select 1 from role_assignment held where held.company_id = ${company} and held.user_id = u.id and held.state = 'ACTIVE'
                                        and held.effective_from <= now() and (held.effective_to is null or held.effective_to > now()))`);
  }
  const from = `
      from (${members}) s
      join user_account u on u.id = s.user_id
      left join employee e on e.company_id = ${company} and e.id = s.employee_id
     ${shown.length > 0 ? `where ${shown.join(' and ')}` : ''}`;
  // Paging parameters come last: the fallback count must not carry them (an unreferenced parameter has no type).
  const filterValues = [...params.values];
  const limit = params.add(q.pageSize);
  const offset = params.add((q.page - 1) * q.pageSize);
  const rows = (
    await db.query<CompanyUserRow>(
      `select p.user_id as "userId", p.account_key as "accountKey", p.active, p.version,
              case when p.employee_id is null then null
                   else json_build_object('id', p.employee_id, 'employeeCode', p.employee_code, 'displayName', p.display_name) end as employee,
              json_build_object('active', a.active, 'pending', a.pending) as assignments,
              p.total
         from (select u.id as user_id, u.account_key, u.active, u.version, e.id as employee_id, e.employee_code, e.display_name,
                      count(*) over () as total
                 ${from}
                order by e.employee_code nulls last, u.account_key
                limit ${limit}::int offset ${offset}::int) p
        cross join lateral (
              select (count(*) filter (where ra.state = 'ACTIVE' and (ra.effective_to is null or ra.effective_to > now())))::int as active,
                     (count(*) filter (where ra.state = 'PENDING'))::int as pending
                from role_assignment ra
               where ra.company_id = ${company} and ra.user_id = p.user_id and ra.state in ('ACTIVE', 'PENDING')) a
        order by p.employee_code nulls last, p.account_key`,
      params.values,
    )
  ).rows;
  // Past the last page there is no row to carry the window count; count the same filtered set instead.
  const total = rows[0]
    ? Number(rows[0].total)
    : q.page === 1
      ? 0
      : Number((await db.query<{ n: string }>(`select count(*) as n ${from}`, filterValues)).rows[0]!.n);
  return {
    items: rows.map(({ userId, accountKey, active, version, employee, assignments }) => ({ userId, accountKey, active, version, employee, assignments })),
    total,
  };
}

/** The caller's own selectable assignments in a company (for role selection; no permission needed). */
export async function myAssignments(db: Queryable, userId: string, companyId: string) {
  const rows = await db.query(
    `select ra.id, r.code as "roleCode", r.name as "roleName", r.access_class as "accessClass", ra.scope_kind as "scopeKind",
            ra.effective_from as "effectiveFrom", ra.effective_to as "effectiveTo"
       from role_assignment ra
       join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
       join user_account u on u.id = ra.user_id and u.active
       join company c on c.id = ra.company_id and c.active
      where ra.company_id = $1 and ra.user_id = $2 and ra.state = 'ACTIVE'
        and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
      order by r.code`,
    [companyId, userId],
  );
  return { items: rows.rows };
}
