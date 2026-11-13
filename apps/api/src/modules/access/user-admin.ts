// User administration (FR-001; §5 System Administrator; §5.1 User to employee; DB007; DB009; BR-044; C4).
// A link ties an existing global account to an employee of this company, dated [from, to). It grants no permission by itself:
// what the account may do still comes from its assignments, which are proposed and approved separately (admin.ts). An account
// is found by its exact key, never by listing other companies' users. Deactivating an account acts on a global record, so a
// company administrator may do it only while the account has no live tie to another company (docs/03).
import { writeAudit } from '../../audit/audit.js';
import type { IdentityAdmin } from '../../auth/identity-admin.js';
import { pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { setSignInEnabled } from './accounts.js';
import { type AccessGrant, assertNotOwnRecord, canAccessEmployee, employeeScopePredicate, SqlParams } from './authorize.js';

export interface UserLinkInput {
  accountKey: string;
  employeeId: string;
  effectiveFrom: string;
  effectiveTo?: string | undefined;
  reason?: string | undefined;
}

export interface EndUserLinkInput {
  expectedVersion: number;
  /** Exclusive end; today when omitted. */
  effectiveTo?: string | undefined;
  reason: string;
}

/** Same boundary as proposing grants (C4). */
function assertCompanyScope(admin: AccessGrant): void {
  if (admin.scopeKind !== 'COMPANY') throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

const selfRefusal = () => new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot change your own account or link; another administrator must do it');

export async function linkUser(tx: Queryable, admin: AccessGrant, input: UserLinkInput): Promise<{ id: string; version: number }> {
  assertCompanyScope(admin);
  if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) throw new HttpError(422, 'INVALID_PERIOD', 'The link must end after it starts');
  if (!(await canAccessEmployee(tx, admin, input.employeeId))) throw notFound();
  // Ordered against closing a draft employee (for update there) and against deactivating the account (for update there).
  const employee = (await tx.query<{ status_id: string }>(`select status_id from employee where company_id = $1 and id = $2 for share`, [admin.companyId, input.employeeId])).rows[0];
  if (!employee) throw notFound();
  const status = (await tx.query<{ code: string }>(`select code from reference_value where company_id = $1 and id = $2`, [admin.companyId, employee.status_id])).rows[0]?.code;
  if (status === 'ARCHIVED') throw new HttpError(422, 'EMPLOYMENT_ENDED', 'This employee record is closed');
  const account = (await tx.query<{ id: string; active: boolean }>(`select id, active from user_account where account_key = $1 for share`, [input.accountKey.trim().toLowerCase()])).rows[0];
  // An unknown and an inactive account read the same.
  if (!account?.active) throw new HttpError(422, 'INVALID_REFERENCE', 'Account not found or inactive');
  await reassertAccess(tx, admin, 'access', 'link_user', ['operational']);
  if (account.id === admin.userId) throw selfRefusal();
  await assertNotOwnRecord(tx, admin, input.employeeId);

  // The two EXCLUDE constraints refuse an overlap (409 OVERLAPPING_PERIOD), concurrent requests included.
  const created = (
    await tx.query<{ id: string; version: number }>(
      `insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $6) returning id, version`,
      [admin.companyId, account.id, input.employeeId, input.effectiveFrom, input.effectiveTo ?? null, admin.userId],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: admin.companyId,
    resource: 'user_employee_link',
    recordKey: created.id,
    actorUserId: admin.userId,
    actingAssignmentId: admin.assignmentId,
    action: 'CREATE',
    newVersion: created.version,
    after: { operational: { userId: account.id, employeeId: input.employeeId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null } },
    reason: input.reason?.trim() || null,
  });
  return created;
}

/**
 * Ends a link. The end cannot be back-dated: the link was in force until now and own-record decisions rest on it, so history
 * stays as it was. A link that starts today or later may end on its start, which leaves an empty period: in force on no date.
 */
export async function endUserLink(tx: Queryable, admin: AccessGrant, id: string, input: EndUserLinkInput): Promise<{ id: string; effectiveTo: string; version: number }> {
  assertCompanyScope(admin);
  const link = (
    await tx.query<{ user_id: string; employee_id: string; effective_from: string; effective_to: string | null; version: number }>(
      `select user_id, employee_id, effective_from, effective_to, version from user_employee_link where company_id = $1 and id = $2 for update`,
      [admin.companyId, id],
    )
  ).rows[0];
  if (!link || !(await canAccessEmployee(tx, admin, link.employee_id))) throw notFound();
  await reassertAccess(tx, admin, 'access', 'link_user', ['operational']);
  if (link.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (link.user_id === admin.userId) throw selfRefusal();
  await assertNotOwnRecord(tx, admin, link.employee_id);
  const today = admin.businessDate;
  if (link.effective_to !== null && link.effective_to <= today) throw new HttpError(409, 'INVALID_STATE', 'This link has already ended');
  const end = input.effectiveTo ?? (link.effective_from > today ? link.effective_from : today);
  if (end < today || end < link.effective_from) throw new HttpError(422, 'INVALID_PERIOD', 'A link cannot end before today or before it starts');
  if (link.effective_to !== null && end > link.effective_to) throw new HttpError(422, 'INVALID_PERIOD', 'The end of a link may only come earlier');

  const updated = (
    await tx.query<{ version: number }>(`update user_employee_link set effective_to = $3, updated_by = $4 where company_id = $1 and id = $2 returning version`, [admin.companyId, id, end, admin.userId])
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: admin.companyId,
    resource: 'user_employee_link',
    recordKey: id,
    actorUserId: admin.userId,
    actingAssignmentId: admin.assignmentId,
    action: 'END',
    priorVersion: link.version,
    newVersion: updated.version,
    before: { operational: { effectiveTo: link.effective_to } },
    after: { operational: { userId: link.user_id, employeeId: link.employee_id, effectiveTo: end } },
    reason: input.reason.trim(),
  });
  return { id, effectiveTo: end, version: updated.version };
}

export interface UserLinkQuery {
  userId?: string | undefined;
  employeeId?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
}

/** The company's links, ended ones included (DB009), inside the administrator's row scope: never another company's. */
export function listUserLinks(db: Queryable, admin: AccessGrant, q: UserLinkQuery) {
  assertCompanyScope(admin);
  const params = new SqlParams();
  const conditions = [employeeScopePredicate(admin, { company: 'l.company_id', employee: 'l.employee_id' }, params)];
  if (q.userId) conditions.push(`l.user_id = ${params.add(q.userId)}::uuid`);
  if (q.employeeId) conditions.push(`l.employee_id = ${params.add(q.employeeId)}::uuid`);
  const day = `${params.add(admin.businessDate)}::date`;
  return pageOf(
    db,
    `select l.id, l.user_id as "userId", u.account_key as "accountKey", u.active as "accountActive",
            l.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
            l.effective_from as "effectiveFrom", l.effective_to as "effectiveTo",
            (l.effective_from <= ${day} and (l.effective_to is null or l.effective_to > ${day})) as "inForce", l.version
       from user_employee_link l
       join user_account u on u.id = l.user_id
       join employee e on e.company_id = l.company_id and e.id = l.employee_id
      where ${conditions.join(' and ')}`,
    params.values,
    `"effectiveFrom" desc, id`,
    { page: q.page ?? 1, pageSize: q.pageSize ?? 25 },
    100,
  );
}

export interface AccountStateInput {
  expectedVersion: number;
  reason: string;
}

/**
 * Deactivates or reactivates a global account. It needs an unrestricted company-scope assignment, as anything company-wide
 * does, and the account must belong to this company (a link or an assignment here). An account with a live link or grant in
 * another company is refused without naming that company: one tenant's administrator does not switch off another tenant's
 * user. Deactivating revokes every session of the account, so it stops on its next request. Assignments and links stay;
 * resolveAccess denies an inactive user.
 */
export async function setAccountActive(
  tx: Queryable,
  admin: AccessGrant,
  userId: string,
  active: boolean,
  input: AccountStateInput,
  identity: IdentityAdmin | null = null,
): Promise<{ userId: string; active: boolean; version: number; sessionsRevoked: number }> {
  const { departments, locations, employees } = admin.filters;
  if (admin.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  if (userId === admin.userId) throw selfRefusal();
  // Both accounts, in one order: two administrators deactivating each other are ordered, and the second is refused by the
  // re-check below. A link or grant written elsewhere meanwhile holds the account's key-share lock and is seen after it.
  const rows = (await tx.query<{ id: string; active: boolean; version: number }>(`select id, active, version from user_account where id = any($1::uuid[]) order by id for update`, [[userId, admin.userId]])).rows;
  await reassertAccess(tx, admin, 'access', 'deactivate_user', ['operational']);
  const target = rows.find((r) => r.id === userId);
  const member = (
    await tx.query<{ ok: boolean }>(
      `select exists (select 1 from user_employee_link where company_id = $1 and user_id = $2)
           or exists (select 1 from role_assignment where company_id = $1 and user_id = $2)
           or exists (select 1 from company_user_account where company_id = $1 and user_id = $2) as ok`,
      [admin.companyId, userId],
    )
  ).rows[0]?.ok;
  if (!target || !member) throw notFound();
  if (target.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (target.active === active) throw new HttpError(409, 'INVALID_STATE', active ? 'This account is already active' : 'This account is already inactive');
  const elsewhere = (
    await tx.query<{ ok: boolean }>(
      `select exists (select 1 from user_employee_link l where l.company_id <> $1 and l.user_id = $2
                         and (l.effective_to is null or l.effective_to > hrms_business_date(l.company_id, now())))
           or exists (select 1 from role_assignment ra where ra.company_id <> $1 and ra.user_id = $2 and ra.state in ('PENDING', 'ACTIVE')
                         and (ra.effective_to is null or ra.effective_to > now()))
           or exists (select 1 from company_user_account c where c.company_id <> $1 and c.user_id = $2) as ok`,
      [admin.companyId, userId],
    )
  ).rows[0]?.ok;
  if (elsewhere) throw new HttpError(409, 'ACCOUNT_SPANS_COMPANIES', 'This account also serves another company, so one company cannot change it');

  const updated = (await tx.query<{ version: number; account_key: string }>(`update user_account set active = $2, updated_by = $3 where id = $1 returning version, account_key`, [userId, active, admin.userId])).rows[0]!;
  // The sign-in follows (accounts.ts): an inactive account cannot sign in at the provider either, and is signed out there.
  await setSignInEnabled(tx, identity, userId, updated.account_key, active);
  const sessionsRevoked = active ? 0 : ((await tx.query(`update user_session set revoked_at = now() where user_id = $1 and revoked_at is null`, [userId])).rowCount ?? 0);
  await writeAudit(tx, {
    companyId: admin.companyId,
    resource: 'user_account',
    recordKey: userId,
    actorUserId: admin.userId,
    actingAssignmentId: admin.assignmentId,
    action: active ? 'REACTIVATE' : 'DEACTIVATE',
    priorVersion: target.version,
    newVersion: updated.version,
    before: { operational: { active: target.active } },
    after: { operational: { active, sessionsRevoked } },
    reason: input.reason.trim(),
  });
  return { userId, active, version: updated.version, sessionsRevoked };
}
