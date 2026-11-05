// Role-permission maintenance (C3 Access administration "maintain_role_permissions ... No implicit grants; privileged change
// approved and logged, no own approval"; FR-066; FR-067; BR-007; C1; C4; C6; C7; DB015; 0132).
//
// A change to what a role allows is proposed and then decided by someone else; until then nothing changes, and a rejection changes
// nothing. The BRD requires an independent decision and names no approver: `approve_role_grant`, C3's approval action, decides.
//
//   ALLOW   puts a permission in the role's ceiling. A ceiling grants nothing by itself: no assignment gains it until a grant is
//           approved (DF02). A baseline role's ceiling can only come back to its C2/C3 baseline (baseline.ts): C6 "The original
//           14-role baseline remains ... do not silently add broad privileges to existing roles". C7: a confidential permission is
//           never put in a role that is not Admin or Manager, but for an H1 own-ESS entry of the Employee role.
//   REMOVE  takes the permission out of the ceiling.
//   DENY    does that and also refuses it to the same user's other assignments, within the matched scope of an assignment of this
//           role (C1; authorize.ts).
//
// REMOVE and DENY switch off the allowlist entries of the role's assignments in the same transaction, so restoring the ceiling
// later revives nothing: an entry comes back only through a newly approved grant (0099). A pending grant holding a removed
// permission cannot be approved (admin.ts). Re-provisioning does not undo a REMOVE (provision.ts).
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, OWN_ESS_ROLE_CODES, SqlParams } from './authorize.js';
import { BASELINE_ROLES, type PermissionKey, parsePermissionKey } from './baseline.js';

export type RolePermissionChangeKind = 'ALLOW' | 'DENY' | 'REMOVE';

export interface RolePermissionProposal {
  roleCode: string;
  permission: PermissionKey;
  change: RolePermissionChangeKind;
  reason: string;
}

/** The change reaches the whole company, so only an administrator of the whole company may ask for or decide it (C4). */
function assertWholeCompany(admin: AccessGrant): void {
  const { departments, locations, employees } = admin.filters;
  if (admin.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) {
    throw new HttpError(403, 'SCOPE_EXCEEDS_ADMINISTRATOR', 'A role permission applies to the whole company, which is wider than your administrative scope');
  }
}

interface RoleRow {
  id: string;
  code: string;
  access_class: 'ADMIN' | 'MANAGER' | 'OTHER';
}

interface PermissionRow {
  id: string;
  own_ess: boolean;
  classification: 'CONFIDENTIAL' | 'OPERATIONAL';
}

/** The role, locked: one role's proposals and decisions are ordered, so each sees the entry the one before it left. */
async function lockRole(tx: Queryable, companyId: string, where: { code: string } | { id: string }): Promise<RoleRow | undefined> {
  const [column, value] = 'code' in where ? ['code', where.code] : ['id', where.id];
  return (await tx.query<RoleRow>(`select id, code, access_class from role where company_id = $1 and ${column} = $2 and active for update`, [companyId, value])).rows[0];
}

async function permissionRow(tx: Queryable, grant: AccessGrant, where: { key: PermissionKey } | { id: string }): Promise<PermissionRow | undefined> {
  const classification = `coalesce((select cfp.classification from confidential_field_policy cfp
                                     where cfp.company_id = $1 and cfp.resource_code = p.resource and cfp.field_group = p.field_group
                                       and cfp.effective_from <= $2::date and (cfp.effective_to is null or cfp.effective_to > $2::date)), 'CONFIDENTIAL') as classification`;
  if ('id' in where) {
    return (await tx.query<PermissionRow>(`select p.id, p.own_ess, ${classification} from permission p where p.id = $3`, [grant.companyId, grant.businessDate, where.id])).rows[0];
  }
  const { resource, action, fieldGroup } = parsePermissionKey(where.key);
  return (
    await tx.query<PermissionRow>(`select p.id, p.own_ess, ${classification} from permission p where p.resource = $3 and p.action = $4 and p.field_group = $5`, [
      grant.companyId,
      grant.businessDate,
      resource,
      action,
      fieldGroup,
    ])
  ).rows[0];
}

const currentEffect = async (tx: Queryable, companyId: string, roleId: string, permissionId: string): Promise<'ALLOW' | 'DENY' | null> =>
  (await tx.query<{ effect: 'ALLOW' | 'DENY' }>(`select effect from role_permission where company_id = $1 and role_id = $2 and permission_id = $3`, [companyId, roleId, permissionId])).rows[0]?.effect ?? null;

/** C6, C7, DF02: what a role may ever hold. Asked at the proposal and again at the decision, under what is true then. */
function assertWithinCeiling(role: RoleRow, key: string, permission: PermissionRow): void {
  const baseline = BASELINE_ROLES.find((r) => r.code === role.code);
  if (baseline && !(baseline.ceiling as readonly string[]).includes(key)) {
    throw new HttpError(422, 'OUTSIDE_ROLE_CEILING', `Role ${role.code} cannot hold ${key}`);
  }
  const ownEss = OWN_ESS_ROLE_CODES.includes(role.code) && permission.own_ess;
  if (permission.classification === 'CONFIDENTIAL' && role.access_class === 'OTHER' && !ownEss) {
    throw new HttpError(422, 'CONFIDENTIAL_NOT_ELIGIBLE', 'Only Admin or Manager roles can hold confidential permissions');
  }
}

function assertChanges(kind: RolePermissionChangeKind, current: 'ALLOW' | 'DENY' | null): void {
  if ((kind === 'REMOVE' && current === null) || kind === current) throw new HttpError(422, 'NO_CHANGE', 'The role already stands this way');
}

export async function proposeRolePermissionChange(tx: Queryable, admin: AccessGrant, p: RolePermissionProposal): Promise<string> {
  await reassertAccess(tx, admin, 'access', 'maintain_role_permissions', ['operational']);
  assertWholeCompany(admin);
  const role = await lockRole(tx, admin.companyId, { code: p.roleCode });
  if (!role) throw new HttpError(422, 'INVALID_REFERENCE', 'Role not found or inactive');
  const permission = await permissionRow(tx, admin, { key: p.permission });
  if (!permission) throw new HttpError(422, 'UNKNOWN_PERMISSION', `Permission ${p.permission} is not in the catalogue`);
  const current = await currentEffect(tx, admin.companyId, role.id, permission.id);
  assertChanges(p.change, current);
  if (p.change === 'ALLOW') assertWithinCeiling(role, p.permission, permission);
  const open = await tx.query(`select 1 from role_permission_change where company_id = $1 and role_id = $2 and permission_id = $3 and state = 'PROPOSED'`, [admin.companyId, role.id, permission.id]);
  if (open.rowCount) throw new HttpError(409, 'CHANGE_ALREADY_PROPOSED', 'A change to this permission of this role is already waiting for a decision');

  const id = (
    await tx.query<{ id: string }>(
      `insert into role_permission_change (company_id, role_id, permission_id, change_kind, effect_before, reason, requested_by, requested_assignment_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $7, $7) returning id`,
      [admin.companyId, role.id, permission.id, p.change, current, p.reason.trim(), admin.userId, admin.assignmentId],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: admin.companyId,
    resource: 'role_permission_change',
    recordKey: id,
    actorUserId: admin.userId,
    actingAssignmentId: admin.assignmentId,
    action: 'PROPOSE',
    newVersion: 1,
    after: { operational: { roleCode: role.code, permission: p.permission, change: p.change, effectBefore: current } },
    reason: p.reason,
  });
  await enqueueEvent(tx, {
    companyId: admin.companyId,
    topic: 'access.role_permission_proposed',
    aggregateId: id,
    dedupeKey: `access.role_permission_proposed:${id}`,
    payload: { changeId: id },
  });
  return id;
}

interface ChangeRow {
  id: string;
  role_id: string;
  permission_id: string;
  permission_key: string;
  change_kind: RolePermissionChangeKind;
  effect_before: 'ALLOW' | 'DENY' | null;
  state: string;
  requested_by: string;
  version: number;
}

/** Locks a change open for a decision and checks who decides it: neither the requester nor anyone holding the role (FR-067, C4). */
async function lockForDecision(tx: Queryable, decider: AccessGrant, id: string, expectedVersion: number): Promise<{ change: ChangeRow; role: RoleRow }> {
  const change = (
    await tx.query<ChangeRow>(
      `select c.id, c.role_id, c.permission_id, p.resource || '.' || p.action || '.' || p.field_group as permission_key, c.change_kind, c.effect_before, c.state, c.requested_by, c.version
         from role_permission_change c join permission p on p.id = c.permission_id
        where c.company_id = $1 and c.id = $2 for update of c`,
      [decider.companyId, id],
    )
  ).rows[0];
  if (!change) throw notFound();
  if (change.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (change.state !== 'PROPOSED') throw new HttpError(409, 'INVALID_STATE', 'Only a proposed change can be decided');
  if (change.requested_by === decider.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A change cannot be decided by the person who asked for it');
  await reassertAccess(tx, decider, 'access', 'approve_role_grant', ['operational']);
  assertWholeCompany(decider);
  const role = await lockRole(tx, decider.companyId, { id: change.role_id });
  if (!role) throw new HttpError(409, 'INVALID_STATE', 'The role is no longer active');
  const holds = await tx.query(
    `select 1 from role_assignment where company_id = $1 and role_id = $2 and user_id = $3 and state in ('PENDING', 'ACTIVE') and (effective_to is null or effective_to > now())`,
    [decider.companyId, change.role_id, decider.userId],
  );
  if (holds.rowCount) throw new HttpError(403, 'AFFECTED_APPROVER', 'Someone who holds this role, or has a grant of it pending, cannot decide a change to it');
  return { change, role };
}

export async function approveRolePermissionChange(tx: Queryable, approver: AccessGrant, id: string, expectedVersion: number) {
  const { change, role } = await lockForDecision(tx, approver, id, expectedVersion);
  const current = await currentEffect(tx, approver.companyId, change.role_id, change.permission_id);
  // What was asked was judged against the entry as it stood then; anything written past this flow since is a different question.
  if (current !== change.effect_before) throw new HttpError(409, 'CHANGE_OUTDATED', 'The role changed since this was proposed; reject it and propose again');
  if (change.change_kind === 'ALLOW') {
    const permission = await permissionRow(tx, approver, { id: change.permission_id });
    assertWithinCeiling(role, change.permission_key, permission!);
  }

  let deactivated: string[] = [];
  if (change.change_kind !== 'ALLOW') {
    deactivated = (
      await tx.query<{ role_assignment_id: string }>(
        `update role_assignment_permission rap set active = false, updated_by = $3
           from role_assignment ra
          where rap.company_id = $1 and rap.permission_id = $2 and rap.active
            and ra.company_id = rap.company_id and ra.id = rap.role_assignment_id and ra.role_id = $4
          returning rap.role_assignment_id`,
        [approver.companyId, change.permission_id, approver.userId, change.role_id],
      )
    ).rows.map((r) => r.role_assignment_id);
  }
  const effectAfter = change.change_kind === 'REMOVE' ? null : change.change_kind;
  if (effectAfter === null) {
    await tx.query(`delete from role_permission where company_id = $1 and role_id = $2 and permission_id = $3`, [approver.companyId, change.role_id, change.permission_id]);
  } else {
    await tx.query(
      `insert into role_permission (company_id, role_id, permission_id, effect, created_by, updated_by) values ($1, $2, $3, $4, $5, $5)
       on conflict (company_id, role_id, permission_id) do update set effect = excluded.effect, updated_by = excluded.updated_by`,
      [approver.companyId, change.role_id, change.permission_id, effectAfter, approver.userId],
    );
  }
  const resultingAccess = { effectBefore: current, effectAfter, allowlistEntriesEnded: deactivated.length, assignments: deactivated };
  await tx.query(
    `update role_permission_change set state = 'APPROVED', decided_by = $3, decided_assignment_id = $4, decided_at = now(), resulting_access = $5, updated_by = $3 where company_id = $1 and id = $2`,
    [approver.companyId, change.id, approver.userId, approver.assignmentId, JSON.stringify(resultingAccess)],
  );
  await writeAudit(tx, {
    companyId: approver.companyId,
    resource: 'role_permission_change',
    recordKey: change.id,
    actorUserId: approver.userId,
    actingAssignmentId: approver.assignmentId,
    action: 'APPROVE',
    priorVersion: change.version,
    before: { operational: { state: 'PROPOSED', effect: current } },
    after: { operational: { state: 'APPROVED', roleCode: role.code, permission: change.permission_key, ...resultingAccess } },
  });
  await enqueueEvent(tx, {
    companyId: approver.companyId,
    topic: 'access.role_permission_decided',
    aggregateId: change.id,
    dedupeKey: `access.role_permission_decided:${change.id}`,
    payload: { changeId: change.id },
  });
  return { id: change.id, state: 'APPROVED' as const, resultingAccess };
}

export async function rejectRolePermissionChange(tx: Queryable, decider: AccessGrant, id: string, expectedVersion: number, reason: string) {
  const { change, role } = await lockForDecision(tx, decider, id, expectedVersion);
  await tx.query(
    `update role_permission_change set state = 'REJECTED', decided_by = $3, decided_assignment_id = $4, decided_at = now(), decision_reason = $5, updated_by = $3 where company_id = $1 and id = $2`,
    [decider.companyId, change.id, decider.userId, decider.assignmentId, reason.trim()],
  );
  await writeAudit(tx, {
    companyId: decider.companyId,
    resource: 'role_permission_change',
    recordKey: change.id,
    actorUserId: decider.userId,
    actingAssignmentId: decider.assignmentId,
    action: 'REJECT',
    priorVersion: change.version,
    before: { operational: { state: 'PROPOSED' } },
    after: { operational: { state: 'REJECTED', roleCode: role.code, permission: change.permission_key } },
    reason,
  });
  await enqueueEvent(tx, {
    companyId: decider.companyId,
    topic: 'access.role_permission_decided',
    aggregateId: change.id,
    dedupeKey: `access.role_permission_decided:${change.id}`,
    payload: { changeId: change.id },
  });
  return { id: change.id, state: 'REJECTED' as const };
}

export interface RolePermissionChangeQuery {
  state?: string | undefined;
  roleCode?: string | undefined;
}

/** FR-067: what was asked, by whom, who decided, why, when and with what result; the newest first. */
export async function listRolePermissionChanges(db: Queryable, admin: AccessGrant, q: RolePermissionChangeQuery) {
  if (admin.scopeKind !== 'COMPANY') throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  const params = new SqlParams([admin.companyId]);
  const where = ['c.company_id = $1'];
  if (q.state) where.push(`c.state = ${params.add(q.state)}`);
  if (q.roleCode) where.push(`r.code = ${params.add(q.roleCode)}`);
  const rows = await db.query<Record<string, unknown> & { total: string }>(
    `select c.id, r.code as "roleCode", p.resource || '.' || p.action || '.' || p.field_group as permission, c.change_kind as change, c.effect_before as "effectBefore",
            c.state, c.reason, c.requested_by as "requestedBy", rq.account_key as "requestedByAccountKey", c.requested_at as "requestedAt",
            c.decided_by as "decidedBy", dc.account_key as "decidedByAccountKey", c.decided_at as "decidedAt", c.decision_reason as "decisionReason",
            c.resulting_access as "resultingAccess", c.version, count(*) over () as total
       from role_permission_change c
       join role r on r.company_id = c.company_id and r.id = c.role_id
       join permission p on p.id = c.permission_id
       join user_account rq on rq.id = c.requested_by
       left join user_account dc on dc.id = c.decided_by
      where ${where.join(' and ')}
      order by c.requested_at desc limit 200`,
    params.values,
  );
  return { items: rows.rows.map(({ total: _t, ...r }) => r), total: Number(rows.rows[0]?.total ?? 0) };
}
