// Delegation of a reviewer's decision authority (FR-003, FR-068; DF03; DB018; C4 "Delegated task"; CI10; ZT04; ZT05).
//
// A reviewer asks, from the assignment that holds the authority, to pass one decision permission to one independently
// eligible colleague for at most 30 calendar days. Nothing changes until someone else approves it. A delegation grants the
// delegate nothing: they decide and read through their own assignment (DB018 "no privilege escalation"; DF03 "cannot
// introduce Admin eligibility or confidential field grants"), and only the routing of new tasks changes (workflow/engine.ts).
// The delegator or an access administrator can end it early; the record stays. Every step is audited.
//
// Locks: the actor's assignment (reassertAccess), then the delegation row. A decision takes its assignment and then the
// delegation row, so the two can never wait on each other in a cycle. A request also takes the advisory lock of the no-chain rule.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { classesAtLeast } from '../workflow/engine.js';
import { type AccessClass, type AccessGrant, canAccessEmployee, employeeScopePredicate, resolveAccess, SqlParams } from './authorize.js';
import { type PermissionKey, parsePermissionKey } from './baseline.js';

export interface DelegationRequest {
  delegateUserId: string;
  permission: PermissionKey;
  effectiveFrom: string;
  effectiveTo: string;
  purpose?: string | undefined;
}

interface DelegationRow {
  id: string;
  delegator_user_id: string;
  delegate_user_id: string;
  delegator_assignment_id: string;
  permission_id: string;
  state: 'PENDING' | 'ACTIVE' | 'REJECTED' | 'WITHDRAWN' | 'ENDED';
  created_by: string | null;
  over: boolean;
  version: number;
}

const refused = (status: number, code: string, message: string) => new HttpError(status, code, message);

/**
 * DB018 "delegate must hold applicable base permission and scope"; DF16 "A delegated reviewer can access only assigned
 * transactions unless an independent team assignment exists"; DF03 "an independently eligible delegate assignment": the delegate
 * holds this permission in one active assignment of equivalent authority whose scope can reach another reviewer's records. Company scope
 * can (its filters are checked per record); assigned scope can, because the task confers it. Team scope reaches only the
 * delegate's own direct reports, who are never another reviewer's task, so it does not count.
 */
const DELEGATE_ASSIGNMENT_JOINS = `
  from role_assignment ra
  join user_account u on u.id = ra.user_id and u.active
  join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
  join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.effect = 'ALLOW'
  join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = rp.permission_id and rap.active
                                     and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())`;
const DELEGATE_ASSIGNMENT_CONDITION = `ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now()) and ra.scope_kind in ('COMPANY', 'ASSIGNED')`;

async function assertDelegateEligible(tx: Queryable, companyId: string, delegateUserId: string, permissionId: string, delegatorClass: AccessClass): Promise<void> {
  const eligible = await tx.query(
    `select 1 ${DELEGATE_ASSIGNMENT_JOINS}
      where ${DELEGATE_ASSIGNMENT_CONDITION} and ra.company_id = $1 and ra.user_id = $2 and rp.permission_id = $3 and r.access_class = any($4::text[]) limit 1`,
    [companyId, delegateUserId, permissionId, classesAtLeast(delegatorClass)],
  );
  if ((eligible.rowCount ?? 0) === 0) {
    throw refused(422, 'DELEGATE_NOT_ELIGIBLE', 'The delegate must already hold this permission in an active Assigned or Company assignment of equivalent authority');
  }
}

/**
 * CI10 "delegates cannot delegate again", and one open delegation per delegator, permission and period, with the codes the
 * screen shows. The database holds both too (0090); the advisory lock is the one hrms_delegation_no_chain takes, so two
 * requests forming a chain are serialised here and the loser reads the winner's row.
 */
async function assertNoConflict(tx: Queryable, row: { companyId: string; delegator: string; delegate: string; permissionId: string; from: string; to: string }): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('delegation:' || $1 || ':' || $2, 0))`, [row.companyId, row.permissionId]);
  const found = (
    await tx.query<{ chain: boolean; overlap: boolean }>(
      `select coalesce(bool_or(o.delegate_user_id = $2 or o.delegator_user_id = $3), false) as chain, coalesce(bool_or(o.delegator_user_id = $2), false) as overlap
         from delegation o
        where o.company_id = $1 and o.permission_id = $4 and o.state in ('PENDING', 'ACTIVE')
          and tstzrange(o.effective_from, o.effective_to, '[)') && tstzrange($5::timestamptz, $6::timestamptz, '[)')`,
      [row.companyId, row.delegator, row.delegate, row.permissionId, row.from, row.to],
    )
  ).rows[0]!;
  if (found.chain) throw refused(409, 'REDELEGATION_NOT_ALLOWED', 'A delegate cannot delegate again, and someone who has delegated this permission for the period cannot receive it');
  if (found.overlap) throw refused(409, 'DELEGATION_OVERLAP', 'You already have a delegation of this permission for part of this period; withdraw or end it first');
}

export async function requestDelegation(tx: Queryable, grant: AccessGrant, input: DelegationRequest): Promise<{ id: string; state: string; version: number }> {
  await reassertAccess(tx, grant, 'access', 'delegate', ['operational']);
  if (input.delegateUserId === grant.userId) throw refused(422, 'SELF_DELEGATION', 'You cannot delegate to yourself');

  const period = (
    await tx.query<{ ordered: boolean; within: boolean; ahead: boolean }>(
      `select $2::timestamptz > $1::timestamptz as ordered, $2::timestamptz <= $1::timestamptz + interval '30 days' as within, $2::timestamptz > now() as ahead`,
      [input.effectiveFrom, input.effectiveTo],
    )
  ).rows[0]!;
  if (!period.ordered) throw refused(422, 'INVALID_PERIOD', 'A delegation must end after it starts');
  if (!period.within) throw refused(422, 'DELEGATION_TOO_LONG', 'A delegation can last at most 30 calendar days');
  if (!period.ahead) throw refused(422, 'INVALID_PERIOD', 'A delegation must end in the future');

  const { resource, action, fieldGroup } = parsePermissionKey(input.permission);
  const permission = (
    await tx.query<{ id: string; decides: boolean }>(
      `select p.id, exists (
                select 1 from workflow_step s join workflow_definition w on w.company_id = s.company_id and w.id = s.workflow_id
                 where s.company_id = $1 and s.permission_id = p.id and w.active and w.effective_from <= now() and (w.effective_to is null or w.effective_to > now())
              ) as decides
         from permission p where p.resource = $2 and p.action = $3 and p.field_group = $4`,
      [grant.companyId, resource, action, fieldGroup],
    )
  ).rows[0];
  // FR-003 "limited to assigned request types": only a permission that decides a step of an active route can be delegated.
  if (!permission?.decides) throw refused(422, 'NOT_DELEGABLE', 'Only a decision permission of an active approval route can be delegated');

  // DB018 "original entitlement remains required"; C1: the selected assignment itself holds what it passes on.
  const own = await resolveAccess(tx, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource, action, fieldGroups: [fieldGroup] });
  if (!own.allowed || !own.allowedFieldGroups.includes(fieldGroup) || own.scopeKind === 'OWN') {
    throw refused(403, 'OUTSIDE_OWN_AUTHORITY', 'The selected role does not hold this decision permission');
  }
  await assertDelegateEligible(tx, grant.companyId, input.delegateUserId, permission.id, own.accessClass);

  await assertNoConflict(tx, { companyId: grant.companyId, delegator: grant.userId, delegate: input.delegateUserId, permissionId: permission.id, from: input.effectiveFrom, to: input.effectiveTo });

  const row = (
    await tx.query<{ id: string; version: number }>(
      `insert into delegation (company_id, delegator_user_id, delegate_user_id, delegator_assignment_id, permission_id, effective_from, effective_to, purpose, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'PENDING', $2, $2) returning id, version`,
      [grant.companyId, grant.userId, input.delegateUserId, grant.assignmentId, permission.id, input.effectiveFrom, input.effectiveTo, input.purpose?.trim() || null],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'delegation',
    recordKey: row.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: row.version,
    after: { operational: { delegatorUserId: grant.userId, delegateUserId: input.delegateUserId, permission: input.permission, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, state: 'PENDING' } },
  });
  return { id: row.id, state: 'PENDING', version: row.version };
}

async function lockDelegation(tx: Queryable, companyId: string, id: string, expectedVersion: number): Promise<DelegationRow> {
  const row = (
    await tx.query<DelegationRow>(
      `select id, delegator_user_id, delegate_user_id, delegator_assignment_id, permission_id, state, created_by, effective_to <= now() as over, version
         from delegation where company_id = $1 and id = $2 for update`,
      [companyId, id],
    )
  ).rows[0];
  if (!row) throw notFound();
  if (row.version !== expectedVersion) throw refused(409, 'STALE_VERSION', 'The record changed; reload and retry');
  return row;
}

/**
 * C4 "existing company scope cannot authorize an expansion beyond approved administrative scope": company scope only, and
 * an administrator restricted by filters acts only for users whose current employee is inside them. Same boundary as listGrants.
 */
async function assertAdministers(db: Queryable, admin: AccessGrant, users: readonly string[]): Promise<void> {
  if (admin.scopeKind !== 'COMPANY') throw refused(403, 'FORBIDDEN', 'Not permitted');
  const { departments, locations, employees } = admin.filters;
  if (departments.length === 0 && locations.length === 0 && employees.length === 0) return;
  const params = new SqlParams([admin.companyId, [...users]]);
  const inside = (
    await db.query<{ n: number }>(
      `select count(distinct l.user_id)::int as n from user_employee_link l
        where l.company_id = $1 and l.user_id = any($2::uuid[])
          and l.effective_from <= hrms_business_date($1, now()) and (l.effective_to is null or l.effective_to > hrms_business_date($1, now()))
          and ${employeeScopePredicate(admin, { company: 'l.company_id', employee: 'l.employee_id' }, params)}`,
      params.values,
    )
  ).rows[0]!.n;
  if (inside !== new Set(users).size) throw refused(403, 'SCOPE_EXCEEDS_ADMINISTRATOR', 'This delegation is outside your administrative scope');
}

const notify = async (tx: Queryable, companyId: string, row: DelegationRow, outcome: string, users: readonly string[]) => {
  for (const userId of users) {
    await enqueueEvent(tx, {
      companyId,
      topic: 'access.delegation_changed',
      aggregateId: row.id,
      dedupeKey: `access.delegation_changed:${row.id}:${outcome}:${userId}`,
      payload: { delegationId: row.id, userId, outcome },
    });
  }
};

export async function approveDelegation(tx: Queryable, approver: AccessGrant, id: string, expectedVersion: number): Promise<{ id: string; state: string }> {
  await reassertAccess(tx, approver, 'access', 'approve_role_grant', ['operational']);
  const row = await lockDelegation(tx, approver.companyId, id, expectedVersion);
  if (row.state !== 'PENDING') throw refused(409, 'INVALID_STATE', 'Only a pending delegation can be approved');
  // C4; DF02 "Grant preparer/approver duties to different people"; DF03 "preparer differs from their approver". The database holds this too.
  if ([row.delegator_user_id, row.delegate_user_id, row.created_by].includes(approver.userId)) {
    throw refused(403, 'SELF_APPROVAL', 'A delegation cannot be approved by its delegator, delegate or requester');
  }
  await assertAdministers(tx, approver, [row.delegator_user_id, row.delegate_user_id]);
  if (row.over) throw refused(409, 'DELEGATION_EXPIRED', 'The requested period has already passed');

  const delegator = (
    await tx.query<{ access_class: AccessClass; holds: boolean }>(
      `select r.access_class,
              (ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now()) and r.active and u.active
               and exists (select 1 from role_permission rp where rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = $3 and rp.effect = 'ALLOW')
               and exists (select 1 from role_assignment_permission rap where rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = $3 and rap.active
                             and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now()))) as holds
         from role_assignment ra join role r on r.company_id = ra.company_id and r.id = ra.role_id join user_account u on u.id = ra.user_id
        where ra.company_id = $1 and ra.id = $2 for share of ra`,
      [approver.companyId, row.delegator_assignment_id, row.permission_id],
    )
  ).rows[0];
  if (!delegator?.holds) throw refused(409, 'DELEGATOR_NOT_ELIGIBLE', 'The delegator no longer holds this permission in the assignment the request came from');
  await assertDelegateEligible(tx, approver.companyId, row.delegate_user_id, row.permission_id, delegator.access_class);

  await tx.query(`update delegation set state = 'ACTIVE', approved_by = $3, approved_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [approver.companyId, id, approver.userId]);
  await writeAudit(tx, {
    companyId: approver.companyId,
    resource: 'delegation',
    recordKey: id,
    actorUserId: approver.userId,
    actingAssignmentId: approver.assignmentId,
    action: 'APPROVE',
    priorVersion: row.version,
    newVersion: row.version + 1,
    after: { operational: { state: 'ACTIVE', approvedBy: approver.userId } },
  });
  await notify(tx, approver.companyId, row, 'approved', [row.delegator_user_id, row.delegate_user_id]);
  return { id, state: 'ACTIVE' };
}

export async function rejectDelegation(tx: Queryable, approver: AccessGrant, id: string, expectedVersion: number, reason: string): Promise<{ id: string; state: string }> {
  await reassertAccess(tx, approver, 'access', 'approve_role_grant', ['operational']);
  const row = await lockDelegation(tx, approver.companyId, id, expectedVersion);
  if (row.state !== 'PENDING') throw refused(409, 'INVALID_STATE', 'Only a pending delegation can be rejected');
  await assertAdministers(tx, approver, [row.delegator_user_id, row.delegate_user_id]);
  await tx.query(`update delegation set state = 'REJECTED', decided_by = $3, decided_at = now(), decision_reason = $4, updated_by = $3 where company_id = $1 and id = $2`, [
    approver.companyId,
    id,
    approver.userId,
    reason.trim(),
  ]);
  await writeAudit(tx, {
    companyId: approver.companyId,
    resource: 'delegation',
    recordKey: id,
    actorUserId: approver.userId,
    actingAssignmentId: approver.assignmentId,
    action: 'REJECT',
    priorVersion: row.version,
    newVersion: row.version + 1,
    after: { operational: { state: 'REJECTED' } },
    reason: reason.trim(),
  });
  await notify(tx, approver.companyId, row, 'rejected', [row.delegator_user_id]);
  return { id, state: 'REJECTED' };
}

/**
 * Ends a delegation early, or withdraws a request. The delegator (with the delegate duty) ends or withdraws their own; an
 * administrator with the revocation duty ends one inside their scope and rejects, not withdraws, someone else's request.
 * Tasks do not move (see workflow/engine.ts): `openTasks` tells the caller how many now wait for a reroute.
 */
export async function endDelegation(tx: Queryable, actor: AccessGrant, mode: 'DELEGATOR' | 'ADMINISTRATOR', id: string, expectedVersion: number, reason: string): Promise<{ id: string; state: string; openTasks: number }> {
  await reassertAccess(tx, actor, 'access', mode === 'DELEGATOR' ? 'delegate' : 'revoke_role', ['operational']);
  const row = await lockDelegation(tx, actor.companyId, id, expectedVersion);
  const own = row.delegator_user_id === actor.userId;
  if (!own) {
    // Someone else's delegation reads as missing to the delegate duty (BR-045).
    if (mode === 'DELEGATOR') throw notFound();
    await assertAdministers(tx, actor, [row.delegator_user_id, row.delegate_user_id]);
    if (row.state === 'PENDING') throw refused(409, 'INVALID_STATE', 'A pending delegation is rejected, not ended');
  }
  if (row.state !== 'PENDING' && (row.state !== 'ACTIVE' || row.over)) throw refused(409, 'INVALID_STATE', 'Only a pending or running delegation can be ended');
  const state = row.state === 'PENDING' ? 'WITHDRAWN' : 'ENDED';
  await tx.query(`update delegation set state = $3, ended_by = $4, ended_at = now(), end_reason = $5, updated_by = $4 where company_id = $1 and id = $2`, [
    actor.companyId,
    id,
    state,
    actor.userId,
    reason.trim(),
  ]);
  const openTasks = (
    await tx.query<{ n: number }>(
      `select count(*)::int as n from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
        where t.company_id = $1 and t.delegation_id = $2 and t.state = 'PENDING'`,
      [actor.companyId, id],
    )
  ).rows[0]!.n;
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource: 'delegation',
    recordKey: id,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action: state === 'ENDED' ? 'END' : 'WITHDRAW',
    priorVersion: row.version,
    newVersion: row.version + 1,
    after: { operational: { state, openTasks } },
    reason: reason.trim(),
  });
  if (state === 'ENDED') await notify(tx, actor.companyId, row, 'ended', [row.delegator_user_id, row.delegate_user_id]);
  return { id, state, openTasks };
}

// ---------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------

/** Operational identity of a user in the delegation's company; the current employee, if linked. */
const person = (column: string) => `(
  select json_build_object('userId', u.id, 'accountKey', u.account_key, 'employeeCode', e.employee_code, 'displayName', e.display_name)
    from user_account u
    left join user_employee_link l on l.company_id = dl.company_id and l.user_id = u.id
         and l.effective_from <= hrms_business_date(dl.company_id, now()) and (l.effective_to is null or l.effective_to > hrms_business_date(dl.company_id, now()))
    left join employee e on e.company_id = l.company_id and e.id = l.employee_id
   where u.id = ${column})`;

/**
 * `viewer`, a parameter, is who may see `openTasks`: the parties see the number of tasks of their own delegation; an
 * administrator holds no row scope over those tasks (C1 "counts") and sees null. `status` names a window that has passed
 * or not begun, which the stored state does not change for; a request whose period passed unapproved has expired too.
 */
const delegationView = (viewer: string) => `
  select dl.id, ${person('dl.delegator_user_id')} as delegator, ${person('dl.delegate_user_id')} as delegate,
         p.resource || '.' || p.action || '.' || p.field_group as permission,
         coalesce((select cfp.classification from confidential_field_policy cfp
                    where cfp.company_id = dl.company_id and cfp.resource_code = p.resource and cfp.field_group = p.field_group
                      and cfp.effective_from <= hrms_business_date(dl.company_id, now())
                      and (cfp.effective_to is null or cfp.effective_to > hrms_business_date(dl.company_id, now()))), 'CONFIDENTIAL') = 'CONFIDENTIAL' as confidential,
         coalesce((select array_agg(distinct w.kind order by w.kind)
                     from workflow_step s join workflow_definition w on w.company_id = s.company_id and w.id = s.workflow_id
                    where s.company_id = dl.company_id and s.permission_id = dl.permission_id and w.active), '{}') as kinds,
         dl.effective_from as "effectiveFrom", dl.effective_to as "effectiveTo", dl.state,
         case when dl.state not in ('ACTIVE', 'PENDING') then dl.state when dl.effective_to <= now() then 'EXPIRED' when dl.state = 'PENDING' then 'PENDING'
              when dl.effective_from > now() then 'SCHEDULED' else 'LIVE' end as status,
         dl.purpose, ${person('dl.created_by')} as "requestedBy", ${person('dl.approved_by')} as "approvedBy", dl.approved_at as "approvedAt",
         ${person('dl.decided_by')} as "rejectedBy", dl.decided_at as "rejectedAt", dl.decision_reason as "rejectionReason",
         ${person('dl.ended_by')} as "endedBy", dl.ended_at as "endedAt", dl.end_reason as "endReason", dl.version, dl.created_at as "requestedAt",
         case when ${viewer}::uuid in (dl.delegator_user_id, dl.delegate_user_id) then
           (select count(*)::int from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
             where t.company_id = dl.company_id and t.delegation_id = dl.id and t.state = 'PENDING') end as "openTasks"
    from delegation dl join permission p on p.id = dl.permission_id`;

/** The caller's own delegations, as delegator or delegate: what they gave and what they received. */
export async function myDelegations(db: Queryable, companyId: string, userId: string) {
  const rows = await db.query(
    `${delegationView('$2')} where dl.company_id = $1 and (dl.delegator_user_id = $2 or dl.delegate_user_id = $2) order by dl.created_at desc limit 200`,
    [companyId, userId],
  );
  return { items: rows.rows };
}

/** Delegations for administration: company scope, and with filters only those whose parties are both inside them (assertAdministers). */
export async function listDelegations(db: Queryable, admin: AccessGrant, q: { state?: string | undefined }) {
  if (admin.scopeKind !== 'COMPANY') throw refused(403, 'FORBIDDEN', 'Not permitted');
  const params = new SqlParams([admin.companyId, q.state ?? null]);
  const { departments, locations, employees } = admin.filters;
  const inside =
    departments.length > 0 || locations.length > 0 || employees.length > 0
      ? `and (select count(distinct l.user_id) from user_employee_link l
               where l.company_id = dl.company_id and l.user_id in (dl.delegator_user_id, dl.delegate_user_id)
                 and l.effective_from <= hrms_business_date($1, now()) and (l.effective_to is null or l.effective_to > hrms_business_date($1, now()))
                 and ${employeeScopePredicate(admin, { company: 'l.company_id', employee: 'l.employee_id' }, params)}) = 2`
      : '';
  const rows = await db.query(
    `${delegationView('null')} where dl.company_id = $1 and ($2::text is null or dl.state = $2) ${inside} order by dl.created_at desc limit 200`,
    params.values,
  );
  return { items: rows.rows };
}

/**
 * C4 "Preserve delegator, delegate and actual actor in history"; RBAC instruction line 95: the decisions taken under one
 * delegation, for its parties and for an administrator whose scope holds both of them. Kind, step, outcome, time and the
 * actual actor only: no employee, no reason, so it lends nobody a record outside their row scope. The module histories name
 * the actor; this names whose authority was used.
 */
export async function delegationDecisions(db: Queryable, companyId: string, id: string, access: { userId: string } | { admin: AccessGrant }) {
  const parties = (await db.query<{ delegator_user_id: string; delegate_user_id: string }>(`select delegator_user_id, delegate_user_id from delegation where company_id = $1 and id = $2`, [companyId, id])).rows[0];
  if (!parties) throw notFound();
  if ('admin' in access) await assertAdministers(db, access.admin, [parties.delegator_user_id, parties.delegate_user_id]);
  else if (access.userId !== parties.delegator_user_id && access.userId !== parties.delegate_user_id) throw notFound();
  const rows = await db.query(
    `select t.id as "taskId", bt.kind, p.action as "stepAction", d.decision, d.occurred_at as "decidedAt", ${person('d.actor_user_id')} as actor
       from delegation dl
       join approval_task t on t.company_id = dl.company_id and t.delegation_id = dl.id
       join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
       join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
       join permission p on p.id = s.permission_id
       join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
       join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
      where dl.company_id = $1 and dl.id = $2
      order by d.occurred_at desc limit 200`,
    [companyId, id],
  );
  return { items: rows.rows };
}

/**
 * What the selected assignment can delegate (FR-003 "limited to assigned request types"): each decision permission it holds
 * that decides a step of an active route, with the request kinds that step belongs to, so the delegator and the approver
 * see what the permission covers. An own-scope assignment reviews nobody.
 */
export async function delegableOptions(db: Queryable, grant: AccessGrant) {
  if (grant.scopeKind === 'OWN') return { items: [] };
  const rows = await db.query(
    `select p.resource || '.' || p.action || '.' || p.field_group as permission, array_agg(distinct w.kind order by w.kind) as kinds,
            coalesce((select cfp.classification from confidential_field_policy cfp
                       where cfp.company_id = ra.company_id and cfp.resource_code = p.resource and cfp.field_group = p.field_group
                         and cfp.effective_from <= hrms_business_date(ra.company_id, now())
                         and (cfp.effective_to is null or cfp.effective_to > hrms_business_date(ra.company_id, now()))), 'CONFIDENTIAL') = 'CONFIDENTIAL' as confidential
       from role_assignment ra
       join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.effect = 'ALLOW'
       join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = rp.permission_id and rap.active
                                          and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
       join permission p on p.id = rp.permission_id
       join workflow_step s on s.company_id = ra.company_id and s.permission_id = p.id
       join workflow_definition w on w.company_id = s.company_id and w.id = s.workflow_id and w.active and w.effective_from <= now() and (w.effective_to is null or w.effective_to > now())
      where ra.company_id = $1 and ra.id = $2
      group by ra.company_id, p.id, p.resource, p.action, p.field_group
      order by 1`,
    [grant.companyId, grant.assignmentId],
  );
  return { items: rows.rows };
}

/** Who could receive the given permission from the selected assignment: operational identity of users who pass assertDelegateEligible. */
export async function delegateCandidates(db: Queryable, grant: AccessGrant, permission: PermissionKey) {
  const { resource, action, fieldGroup } = parsePermissionKey(permission);
  const own = await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource, action, fieldGroups: [fieldGroup] });
  if (!own.allowed || !own.allowedFieldGroups.includes(fieldGroup) || own.scopeKind === 'OWN') return { items: [] };
  const rows = await db.query(
    `select ra.user_id as "userId", u.account_key as "accountKey", e.employee_code as "employeeCode", e.display_name as "displayName"
       ${DELEGATE_ASSIGNMENT_JOINS}
       left join user_employee_link cl on cl.company_id = ra.company_id and cl.user_id = ra.user_id
            and cl.effective_from <= hrms_business_date(ra.company_id, now()) and (cl.effective_to is null or cl.effective_to > hrms_business_date(ra.company_id, now()))
       left join employee e on e.company_id = cl.company_id and e.id = cl.employee_id
      where ${DELEGATE_ASSIGNMENT_CONDITION}
        and ra.company_id = $1 and ra.user_id <> $2 and r.access_class = any($3::text[])
        and rp.permission_id = (select id from permission where resource = $4 and action = $5 and field_group = $6)
      group by ra.user_id, u.account_key, e.employee_code, e.display_name
      order by u.account_key limit 200`,
    [grant.companyId, grant.userId, classesAtLeast(own.accessClass), resource, action, fieldGroup],
  );
  return { items: rows.rows };
}

interface DelegatedTaskRow {
  taskId: string;
  kind: string;
  ownerEmployeeId: string | null;
  ownerEmployeeCode: string | null;
  ownerName: string | null;
  assignedAt: Date;
  delegationId: string;
  delegatedUntil: Date;
  delegator: { userId: string; accountKey: string; employeeCode: string | null; displayName: string | null };
  resource: string;
  action: string;
  field_group: string;
}

/**
 * The caller's open delegated tasks that the selected assignment could decide now, with who delegated them (FR-096: the
 * inbox shows that the caller acts as a delegate and in which role). Each step's permission and the owner's row scope are
 * resolved for that assignment as the queues do, so a task of another role is not listed under this one (BR-046).
 */
export async function myDelegatedTasks(db: Queryable, actor: { userId: string; companyId: string; assignmentId: string | null }) {
  if (!actor.assignmentId) return { items: [] };
  const assignmentId = actor.assignmentId;
  const rows = (
    await db.query<DelegatedTaskRow>(
      `select t.id as "taskId", bt.kind, bt.owner_employee_id as "ownerEmployeeId", e.employee_code as "ownerEmployeeCode", e.display_name as "ownerName",
              t.created_at as "assignedAt", dl.id as "delegationId", dl.effective_to as "delegatedUntil", ${person('dl.delegator_user_id')} as delegator,
              p.resource, p.action, p.field_group
         from approval_task t
         join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         join permission p on p.id = s.permission_id
         join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
         join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id
         left join employee e on e.company_id = bt.company_id and e.id = bt.owner_employee_id
        where t.company_id = $1 and t.assignee_user_id = $2 and t.state = 'PENDING' and hrms_delegated_task_live(t.company_id, t.id, now())
        order by t.created_at limit 200`,
      [actor.companyId, actor.userId],
    )
  ).rows;
  const grants = new Map<string, Awaited<ReturnType<typeof resolveAccess>>>();
  const items = [];
  for (const { resource, action, field_group: fieldGroup, ...task } of rows) {
    const key = `${resource}.${action}.${fieldGroup}`;
    if (!grants.has(key)) grants.set(key, await resolveAccess(db, { userId: actor.userId, companyId: actor.companyId, assignmentId, resource, action, fieldGroups: [fieldGroup] }));
    const grant = grants.get(key)!;
    if (!grant.allowed || !grant.allowedFieldGroups.includes(fieldGroup)) continue;
    if (task.ownerEmployeeId && !(await canAccessEmployee(db, grant, task.ownerEmployeeId))) continue;
    items.push(task);
  }
  return { items };
}
