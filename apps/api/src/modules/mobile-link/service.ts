// Employee-to-mobile-app links (FR-023; C4). FR-023 acceptance: the link operation cannot associate one employee
// with another account without authorised review. Every link — first link or re-link — is requested and then
// decided by an independent approver who is neither the requester nor the employee concerned. At most one active
// link exists per employee and per app account; approving a re-link revokes the employee's previous link in the
// same transaction. The app account reference is an opaque identifier; no device data is stored.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';

const columns = `l.id, l.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
  l.app_account_ref as "appAccountRef", l.state, l.requested_by as "requestedBy", l.decided_by as "decidedBy", l.decided_at as "decidedAt",
  l.revoked_at as "revokedAt", l.replaces_link_id as "replacesLinkId", l.created_at as "requestedAt", l.version`;

async function activeElsewhere(tx: Queryable, companyId: string, ref: string, employeeId: string) {
  const row = await tx.query(`select 1 from mobile_app_link where company_id = $1 and app_account_ref = $2 and state = 'ACTIVE' and employee_id <> $3`, [companyId, ref, employeeId]);
  return (row.rowCount ?? 0) > 0;
}

export async function requestLink(tx: Queryable, grant: AccessGrant, input: { employeeId?: string | undefined; appAccountRef: string }) {
  const employeeId = input.employeeId ?? grant.linkedEmployeeId;
  if (!employeeId) throw new HttpError(422, 'EMPLOYEE_REQUIRED', 'Name the employee, or use an account linked to an employee');
  if (!(await canAccessEmployee(tx, grant, employeeId))) throw notFound();
  // Serialise link work per employee so concurrent requests and decisions cannot interleave.
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('mobile_link:' || $1, 0))`, [employeeId]);
  const ref = input.appAccountRef.trim();
  if (await activeElsewhere(tx, grant.companyId, ref, employeeId)) {
    throw new HttpError(409, 'ACCOUNT_LINKED_ELSEWHERE', 'This app account is linked to another employee; that link must be revoked first');
  }
  const current = (await tx.query<{ id: string; app_account_ref: string }>(`select id, app_account_ref from mobile_app_link where company_id = $1 and employee_id = $2 and state = 'ACTIVE'`, [grant.companyId, employeeId])).rows[0];
  if (current?.app_account_ref === ref) throw new HttpError(409, 'ALREADY_LINKED', 'The employee is already linked to this app account');
  const id = (
    await tx.query<{ id: string }>(
      `insert into mobile_app_link (company_id, employee_id, app_account_ref, state, requested_by, replaces_link_id, created_by, updated_by)
       values ($1, $2, $3, 'PENDING', $4, $5, $4, $4) returning id`,
      [grant.companyId, employeeId, ref, grant.userId, current?.id ?? null],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'mobile_app_link',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { employeeId, appAccountRef: ref, replacesLinkId: current?.id ?? null, state: 'PENDING' } },
  });
  return { id, state: 'PENDING', replacesLinkId: current?.id ?? null };
}

export async function listEmployeeLinks(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const rows = await db.query(
    `select ${columns} from mobile_app_link l join employee e on e.company_id = l.company_id and e.id = l.employee_id
      where l.company_id = $1 and l.employee_id = $2 order by l.created_at desc limit 100`,
    [grant.companyId, employeeId],
  );
  return { items: rows.rows };
}

/** Review queue / register within the approver's row scope. */
export async function listLinks(db: Queryable, grant: AccessGrant, state?: string) {
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'l.company_id', employee: 'l.employee_id' }, params);
  const rows = await db.query(
    `select ${columns} from mobile_app_link l join employee e on e.company_id = l.company_id and e.id = l.employee_id
      where ${scope} ${state ? `and l.state = ${params.add(state)}` : ''} order by l.created_at limit 500`,
    params.values,
  );
  return { items: rows.rows };
}

async function lockLink(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number) {
  const link = (
    await tx.query<{ employee_id: string }>(`select employee_id from mobile_app_link where company_id = $1 and id = $2`, [grant.companyId, id])
  ).rows[0];
  if (!link || !(await canAccessEmployee(tx, grant, link.employee_id))) throw notFound();
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('mobile_link:' || $1, 0))`, [link.employee_id]);
  const row = (
    await tx.query<{ employee_id: string; app_account_ref: string; state: string; requested_by: string; replaces_link_id: string | null; version: number }>(
      `select employee_id, app_account_ref, state, requested_by, replaces_link_id, version from mobile_app_link where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0]!;
  if (row.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  return row;
}

export async function decideLink(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number; decision: 'APPROVE' | 'REJECT' }) {
  const link = await lockLink(tx, grant, id, input.expectedVersion);
  if (link.state !== 'PENDING') throw new HttpError(409, 'INVALID_STATE', 'Only a pending link can be decided');
  // C4: independent review — never the requester, never the employee being linked.
  if (link.requested_by === grant.userId || link.employee_id === grant.linkedEmployeeId) {
    throw new HttpError(403, 'SELF_APPROVAL', 'The requester or the employee concerned cannot decide this link');
  }
  if (input.decision === 'APPROVE') {
    if (await activeElsewhere(tx, grant.companyId, link.app_account_ref, link.employee_id)) {
      throw new HttpError(409, 'ACCOUNT_LINKED_ELSEWHERE', 'This app account is linked to another employee; that link must be revoked first');
    }
    await tx.query(
      `update mobile_app_link set state = 'REVOKED', revoked_by = $3, revoked_at = now(), revoke_reason = $4, updated_by = $3
        where company_id = $1 and employee_id = $2 and state = 'ACTIVE'`,
      [grant.companyId, link.employee_id, grant.userId, `Replaced by approved link ${id}`],
    );
  }
  const state = input.decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED';
  await tx.query(`update mobile_app_link set state = $3, decided_by = $4, decided_at = now(), updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, id, state, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'mobile_app_link',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.decision,
    priorVersion: link.version,
    newVersion: link.version + 1,
    before: { operational: { state: 'PENDING' } },
    after: { operational: { state } },
  });
  return { id, state };
}

export async function revokeLink(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number; reason: string }) {
  const link = await lockLink(tx, grant, id, input.expectedVersion);
  if (link.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'Only an active link can be revoked');
  await tx.query(
    `update mobile_app_link set state = 'REVOKED', revoked_by = $3, revoked_at = now(), revoke_reason = $4, updated_by = $3 where company_id = $1 and id = $2`,
    [grant.companyId, id, grant.userId, input.reason.trim()],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'mobile_app_link',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'REVOKE',
    priorVersion: link.version,
    newVersion: link.version + 1,
    before: { operational: { state: 'ACTIVE' } },
    after: { operational: { state: 'REVOKED' } },
    reason: input.reason.trim(),
  });
  return { id, state: 'REVOKED' };
}
