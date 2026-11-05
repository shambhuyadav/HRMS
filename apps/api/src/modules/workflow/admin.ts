// Reviewer-routing administration (DF03): HR maintains each kind's explicit fallback reviewer list. A list
// grants no authority — every listed reviewer must already hold the kind's decision permission in an active
// assignment — and every change is audited. Kinds that route like another kind (routing_kind) are shown with
// the list they use; that list is maintained on the base kind. A list decides for the whole company, so changing one needs
// an unrestricted company-scope assignment; reading follows row scope (C1 "search suggestions"), so a filtered assignment
// sees only the people it covers, and an account linked to no employee is for an unrestricted assignment only.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { fanOut } from '../notification/dispatcher.js';
import { isEligibleReviewer, rerouteTask, unrestrictedCompanyScope } from './engine.js';

/** The person behind an assignment or list entry on the business date, as `alias`, joined on `user`. */
const linkedEmployee = (alias: string, company: string, user: string) =>
  `left join user_employee_link ${alias} on ${alias}.company_id = ${company} and ${alias}.user_id = ${user}
        and ${alias}.effective_from <= hrms_business_date(${company}, now()) and (${alias}.effective_to is null or ${alias}.effective_to > hrms_business_date(${company}, now()))`;

interface KindRow {
  kind: string;
  routing_kind: string | null;
  first_permission_id: string | null;
  steps: { sequence: number; permission: string; selectionRule: string; conditionCode: string | null }[] | null;
}

async function kinds(db: Queryable, companyId: string, kind?: string): Promise<KindRow[]> {
  return (
    await db.query<KindRow>(
      `select tk.kind, tk.routing_kind,
              (select s.permission_id from workflow_step s where s.company_id = w.company_id and s.workflow_id = w.id and s.condition_code is null
                order by s.sequence limit 1) as first_permission_id,
              (select json_agg(json_build_object('sequence', s.sequence, 'permission', p.resource || '.' || p.action || '.' || p.field_group,
                                                 'selectionRule', s.selection_rule, 'conditionCode', s.condition_code) order by s.sequence)
                 from workflow_step s join permission p on p.id = s.permission_id
                where s.company_id = w.company_id and s.workflow_id = w.id) as steps
         from transaction_kind tk
         join workflow_definition w on w.company_id = $1 and w.kind = tk.kind and w.active
              and w.effective_from <= now() and (w.effective_to is null or w.effective_to > now())
        where ($2::text is null or tk.kind = $2)
        order by tk.kind`,
      [companyId, kind ?? null],
    )
  ).rows;
}

export async function listRouting(db: Queryable, grant: AccessGrant) {
  const rows = await kinds(db, grant.companyId);
  const params = new SqlParams([grant.companyId]);
  const scope = employeeScopePredicate(grant, { company: 'f.company_id', employee: 'l.employee_id' }, params);
  const lists = (
    await db.query<{ kind: string; user_id: string; account_key: string; priority: number; active: boolean }>(
      `select f.kind, f.user_id, u.account_key, f.priority, f.active
         from workflow_fallback_reviewer f join user_account u on u.id = f.user_id
         ${linkedEmployee('l', 'f.company_id', 'f.user_id')}
        where f.company_id = $1 and f.active and ${scope} order by f.kind, f.priority, f.user_id`,
      params.values,
    )
  ).rows;
  const items = [];
  for (const r of rows) {
    const listKind = r.routing_kind ?? r.kind;
    const reviewers = [];
    for (const l of lists.filter((x) => x.kind === listKind)) {
      reviewers.push({
        userId: l.user_id,
        accountKey: l.account_key,
        priority: l.priority,
        // A listed user who lost the decision permission is shown, so HR can repair the list (DF03).
        eligible: r.first_permission_id ? await isEligibleReviewer(db, grant.companyId, l.user_id, r.first_permission_id, null) : false,
      });
    }
    items.push({ kind: r.kind, routingKind: r.routing_kind, steps: r.steps ?? [], fallbackReviewers: reviewers });
  }
  return { items };
}

/**
 * Picker for a kind's list: users who can decide its first step right now (an active, approved assignment whose
 * role ceiling and allowlist hold the step permission), within the caller's row scope. Operational identity only.
 */
export async function listCandidates(db: Queryable, grant: AccessGrant, kind: string) {
  const row = (await kinds(db, grant.companyId, kind))[0];
  if (!row) throw notFound();
  if (!row.first_permission_id) return { kind, items: [] };
  const params = new SqlParams([grant.companyId, row.first_permission_id]);
  const scope = employeeScopePredicate(grant, { company: 'ra.company_id', employee: 'l.employee_id' }, params);
  const rows = await db.query(
    `select distinct u.id as "userId", u.account_key as "accountKey", e.employee_code as "employeeCode", e.display_name as "displayName"
       from role_assignment ra
       join user_account u on u.id = ra.user_id and u.active
       join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
       join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = $2 and rp.effect = 'ALLOW'
       join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = $2 and rap.active
            and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
       ${linkedEmployee('l', 'ra.company_id', 'ra.user_id')}
       left join employee e on e.company_id = l.company_id and e.id = l.employee_id
      where ra.company_id = $1 and ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now()) and ${scope}
      order by u.account_key limit 500`,
    params.values,
  );
  return { kind, items: rows.rows };
}

/** Replaces a base kind's list: listed users become active with their priority; others are deactivated (kept). */
export async function setFallbackReviewers(tx: Queryable, grant: AccessGrant, kind: string, reviewers: { userId: string; priority: number }[]) {
  // A list routes tasks for employees across the company, so a filter or a narrower scope cannot change one.
  if (!unrestrictedCompanyScope(grant)) throw new HttpError(403, 'FORBIDDEN', 'Changing a reviewer list needs an unrestricted company-wide assignment');
  await reassertAccess(tx, grant, 'workflow', 'manage', ['operational']);
  const row = (await kinds(tx, grant.companyId, kind))[0];
  if (!row) throw notFound();
  if (row.routing_kind) throw new HttpError(422, 'SHARED_ROUTING', `This kind uses the ${row.routing_kind} list; change that list instead`);
  if (!row.first_permission_id) throw new HttpError(422, 'WORKFLOW_NOT_CONFIGURED', 'The workflow has no steps');
  const ids = reviewers.map((r) => r.userId);
  if (new Set(ids).size !== ids.length) throw new HttpError(422, 'DUPLICATE_REVIEWER', 'A reviewer is listed twice');
  for (const r of reviewers) {
    if (!(await isEligibleReviewer(tx, grant.companyId, r.userId, row.first_permission_id, null))) {
      throw new HttpError(422, 'REVIEWER_NOT_ELIGIBLE', 'Every listed reviewer must hold the decision permission in an active assignment', { userId: r.userId });
    }
  }
  // Serialise list changes per kind so concurrent edits cannot interleave.
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('fallback:' || $1 || ':' || $2, 0))`, [grant.companyId, kind]);
  const before = (
    await tx.query<{ user_id: string; priority: number }>(
      `select user_id, priority from workflow_fallback_reviewer where company_id = $1 and kind = $2 and active order by priority, user_id`,
      [grant.companyId, kind],
    )
  ).rows;
  await tx.query(`update workflow_fallback_reviewer set active = false, updated_by = $3 where company_id = $1 and kind = $2 and active and not (user_id = any($4::uuid[]))`, [
    grant.companyId,
    kind,
    grant.userId,
    ids,
  ]);
  for (const r of reviewers) {
    await tx.query(
      `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active, created_by, updated_by) values ($1, $2, $3, $4, true, $5, $5)
       on conflict (company_id, kind, user_id) do update set priority = excluded.priority, active = true, updated_by = excluded.updated_by
        where workflow_fallback_reviewer.priority is distinct from excluded.priority or not workflow_fallback_reviewer.active`,
      [grant.companyId, kind, r.userId, r.priority, grant.userId],
    );
  }
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'workflow_routing',
    recordKey: (await tx.query<{ id: string }>(`select id from workflow_definition where company_id = $1 and kind = $2 and active order by revision desc limit 1`, [grant.companyId, kind])).rows[0]!.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'SET_FALLBACK',
    before: { operational: { kind, reviewers: before.map((b) => ({ userId: b.user_id, priority: b.priority })) } },
    after: { operational: { kind, reviewers } },
  });
  return { kind, reviewers };
}

/**
 * C4 reroute with its history: the superseded task stays on record, the audit names both assignees and the reason, and
 * the new assignee is told. See rerouteTask for what it refuses.
 */
export async function rerouteOpenTask(tx: Queryable, grant: AccessGrant, taskId: string, reason: string) {
  const r = await rerouteTask(tx, grant, taskId);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'approval_task',
    recordKey: r.supersededTaskId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'REROUTE',
    before: { operational: { assigneeUserId: r.supersededAssigneeUserId, state: 'PENDING' } },
    after: { operational: { state: 'SUPERSEDED', newTaskId: r.taskId, assigneeUserId: r.assigneeUserId, transactionId: r.transactionId } },
    reason: reason.trim(),
  });
  await fanOut(tx, grant.companyId, `APPROVAL_REROUTED:${r.taskId}`, null, {
    eventType: 'APPROVAL_REROUTED',
    subjectEmployeeId: r.ownerEmployeeId,
    transactionId: r.transactionId,
    transactionRevision: null,
    taskId: r.taskId,
    beneficiaryUserId: null,
    data: { requestKind: r.kind.replace(/_/g, ' ') },
  });
  return { taskId: r.taskId, supersededTaskId: r.supersededTaskId, assigneeUserId: r.assigneeUserId };
}
