// Generic approval engine (DB040-DB045; DF03; C4; CI01/CI02/CI12). Modules own their typed root and its
// business effects; the engine owns instances, tasks, reviewer selection and decisions. Every call runs
// inside the caller's transaction, so a decision, its state changes and its effects commit together.
//
// Reviewer selection (DF03): DIRECT_MANAGER resolves the owner's current direct manager to their user;
// when that manager is missing, has no user, lacks the step permission, or is the owner, selection falls
// back to the company's explicit fallback list for the kind. No eligible reviewer blocks submission with a
// repairable routing error; nothing is ever auto-approved. Sequential steps; one decision per step.
//
// A changed reporting line or scope (C4 "Changed organisation or manager"): a task never moves by itself. It stays with
// its assignee, who neither sees nor decides it while the owner is outside their current row scope, until a reroute
// (rerouteTask) supersedes it with a new task. Who may reroute is an owner decision (permission in no role's ceiling).
//
// Delegation (FR-003, FR-068, DF03, DB018, C4 "Delegated task", CI10): a step selected for a reviewer who has a live
// delegation of the step's permission goes to the delegate with delegation_id, one hop only, when the delegate is
// independently eligible for the record and in no conflict; otherwise it stays with the reviewer. A task never moves when a
// delegation starts or ends (C4 "does not automatically transfer"; the BRD names no other rule): one open when a delegation
// starts stays with its reviewer, and one whose delegation ended stays open, readable and decidable by nobody, listed in
// strandedTasks until a reroute. Every decision re-checks the delegation after its locks (assertDelegationHolds).
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import {
  type AccessClass,
  type AccessGrant,
  assertNotOwnRecord,
  canAccessEmployee,
  eligibleTasksOf,
  employeeScopePredicate,
  SqlParams,
  taskDelegationLive,
  taskOwnerInScope,
} from '../access/authorize.js';

export type Decision = 'APPROVE' | 'REJECT' | 'RETURN';
export type DecisionOutcome = 'NEXT_STEP' | 'APPROVED' | 'REJECTED' | 'RETURNED';
type SelectionRule = 'DIRECT_MANAGER' | 'HR_FALLBACK_LIST' | 'PERMISSION_IN_SCOPE';

interface StepRow {
  id: string;
  workflow_id: string;
  sequence: number;
  permission_id: string;
  selection_rule: SelectionRule;
  condition_code: string | null;
}

const STEP_COLUMNS = 'id, workflow_id, sequence, permission_id, selection_rule, condition_code';

/**
 * SQL: the assignment `ra` covers employee `emp` in row scope on day `d.day` (`company` the company parameter), as
 * employeeScopePredicate does for lists: company scope within its department, location and employee filters, team scope
 * over a current direct report, or assigned scope; never own scope. `assigned` decides assigned scope: when selecting a
 * reviewer for a step whose permission the assignment holds it is true (the task about to be created confers the scope);
 * for anything else it must prove a task the assignment is already eligible for.
 */
const scopeCovers = (company: string, emp: string, assigned = 'true') => `(
  case ra.scope_kind
    when 'COMPANY' then true
    when 'ASSIGNED' then ${assigned}
    when 'TEAM' then exists (
      select 1 from manager_assignment ma
        join user_employee_link l on l.company_id = ma.company_id and l.employee_id = ma.manager_employee_id and l.user_id = ra.user_id
                                 and l.effective_from <= d.day and (l.effective_to is null or l.effective_to > d.day)
       where ma.company_id = ${company} and ma.employee_id = ${emp}
         and ma.effective_from <= d.day and (ma.effective_to is null or ma.effective_to > d.day))
    else false
  end
  and (not exists (select 1 from role_scope_filter f where f.company_id = ${company} and f.role_assignment_id = ra.id and f.dimension in ('DEPARTMENT', 'LOCATION'))
       or exists (
         select 1 from employment_assignment ea
          where ea.company_id = ${company} and ea.employee_id = ${emp}
            and ea.effective_from <= d.day and (ea.effective_to is null or ea.effective_to > d.day)
            and (not exists (select 1 from role_scope_filter f where f.company_id = ${company} and f.role_assignment_id = ra.id and f.dimension = 'DEPARTMENT')
                 or ea.department_id in (select f.department_id from role_scope_filter f where f.company_id = ${company} and f.role_assignment_id = ra.id and f.dimension = 'DEPARTMENT'))
            and (not exists (select 1 from role_scope_filter f where f.company_id = ${company} and f.role_assignment_id = ra.id and f.dimension = 'LOCATION')
                 or ea.location_id in (select f.location_id from role_scope_filter f where f.company_id = ${company} and f.role_assignment_id = ra.id and f.dimension = 'LOCATION'))))
  and (not exists (select 1 from role_scope_filter f where f.company_id = ${company} and f.role_assignment_id = ra.id and f.dimension = 'EMPLOYEE')
       or exists (select 1 from role_scope_filter f where f.company_id = ${company} and f.role_assignment_id = ra.id and f.dimension = 'EMPLOYEE' and f.employee_id = ${emp})))`;

/**
 * User may decide a step: active user, ACTIVE effective assignment whose role ALLOWs and DB109 grants the permission,
 * not the owner, and (for an owned transaction) an assignment whose row scope covers the owner, as the assignee will
 * need to open the task (DF03 "a scoped HR Administrator"; scopeCovers). `accessClasses` limits the assignment that counts
 * to those classes (a delegate's equivalent authority; classesAtLeast).
 */
export async function isEligibleReviewer(tx: Queryable, companyId: string, userId: string, permissionId: string, ownerEmployeeId: string | null, accessClasses: readonly AccessClass[] | null = null) {
  const row = (
    await tx.query<{ ok: boolean }>(
      `with d as (select hrms_business_date($1, now()) as day)
       select exists (
         select 1
           from d, role_assignment ra
           join user_account u on u.id = ra.user_id and u.active
           join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
           join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id
                                  and rp.permission_id = $3 and rp.effect = 'ALLOW'
           join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id
                                              and rap.permission_id = $3 and rap.active
                                              and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
          where ra.company_id = $1 and ra.user_id = $2 and ra.state = 'ACTIVE'
            and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
            and ($4::uuid is null or ${scopeCovers('$1', '$4')})
            and ($5::text[] is null or r.access_class = any($5::text[]))
       ) and not exists (
         select 1 from user_employee_link l where l.company_id = $1 and l.user_id = $2 and l.employee_id = $4
       ) as ok`,
      [companyId, userId, permissionId, ownerEmployeeId, accessClasses ? [...accessClasses] : null],
    )
  ).rows[0];
  return row?.ok === true;
}

/**
 * FR-068 "equivalent reviewer authority"; DF03 "Delegation cannot introduce Admin eligibility": the access classes a
 * delegate's own assignment may be of, given the class of the delegator's. Confidential eligibility needs Admin or Manager
 * (authorize.ts), so a confidential permission's delegate is at least that as well.
 */
export const classesAtLeast = (delegatorClass: AccessClass): AccessClass[] =>
  delegatorClass === 'ADMIN' ? ['ADMIN'] : delegatorClass === 'MANAGER' ? ['ADMIN', 'MANAGER'] : ['ADMIN', 'MANAGER', 'OTHER'];

/**
 * The given users who hold an active, effective assignment whose row scope covers the employee (scopeCovers), in their
 * original order: notices about an employee go only to list members who could open that employee's record.
 */
export async function usersCoveringEmployee(tx: Queryable, companyId: string, userIds: readonly string[], employeeId: string): Promise<string[]> {
  if (userIds.length === 0) return [];
  const covered = new Set(
    (
      await tx.query<{ u: string }>(
        `with d as (select hrms_business_date($1, now()) as day)
         select distinct ra.user_id as u
           from d, role_assignment ra
           join user_account u on u.id = ra.user_id and u.active
           join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
          where ra.company_id = $1 and ra.user_id = any($2::uuid[]) and ra.state = 'ACTIVE'
            and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
            and ${scopeCovers('$1', '$3', `exists (select 1 ${eligibleTasksOf({ company: '$1', assignment: 'ra.id', user: 'ra.user_id', at: 'now()' })} and asg_bt.owner_employee_id = $3)`)}`,
        [companyId, [...userIds], employeeId],
      )
    ).rows.map((r) => r.u),
  );
  return userIds.filter((u) => covered.has(u));
}

async function directManagerUser(tx: Queryable, companyId: string, ownerEmployeeId: string): Promise<string | null> {
  const row = (
    await tx.query<{ user_id: string }>(
      `with d as (select hrms_business_date($1, now()) as day)
       select l.user_id
         from d, manager_assignment ma
         join employee m on m.company_id = ma.company_id and m.id = ma.manager_employee_id
         join reference_value st on st.company_id = m.company_id and st.id = m.status_id
                                and st.code in ('ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE')
         join user_employee_link l on l.company_id = ma.company_id and l.employee_id = ma.manager_employee_id
        where ma.company_id = $1 and ma.employee_id = $2
          and ma.effective_from <= d.day and (ma.effective_to is null or ma.effective_to > d.day)
          and l.effective_from <= d.day and (l.effective_to is null or l.effective_to > d.day)`,
      [companyId, ownerEmployeeId],
    )
  ).rows[0];
  return row?.user_id ?? null;
}

async function fallbackUser(tx: Queryable, companyId: string, kind: string, permissionId: string, ownerEmployeeId: string | null, exclude: readonly string[]) {
  const candidates = (
    await tx.query<{ user_id: string }>(
      `select user_id from workflow_fallback_reviewer
        where company_id = $1 and kind = (select coalesce(routing_kind, kind) from transaction_kind where kind = $2) and active
        order by priority, user_id`,
      [companyId, kind],
    )
  ).rows;
  for (const c of candidates) {
    if (exclude.includes(c.user_id)) continue;
    if (await isEligibleReviewer(tx, companyId, c.user_id, permissionId, ownerEmployeeId)) return c.user_id;
  }
  return null;
}

async function selectReviewer(
  tx: Queryable,
  companyId: string,
  kind: string,
  step: StepRow,
  ownerEmployeeId: string | null,
  override: SelectionRule | undefined,
  exclude: readonly string[] = [],
): Promise<string> {
  const rule = override ?? step.selection_rule;
  let reviewer: string | null = null;
  if (rule === 'DIRECT_MANAGER' && ownerEmployeeId) {
    const manager = await directManagerUser(tx, companyId, ownerEmployeeId);
    if (manager && !exclude.includes(manager) && (await isEligibleReviewer(tx, companyId, manager, step.permission_id, ownerEmployeeId))) reviewer = manager;
  }
  if (!reviewer && rule !== 'PERMISSION_IN_SCOPE') {
    reviewer = await fallbackUser(tx, companyId, kind, step.permission_id, ownerEmployeeId, exclude);
  }
  if (!reviewer) {
    throw new HttpError(422, 'NO_ELIGIBLE_REVIEWER', 'No eligible reviewer is configured for this request; contact HR to repair routing');
  }
  return reviewer;
}

interface StepRoute {
  assignee: string;
  delegationId: string | null;
}

/**
 * Who receives a step selected for `reviewer`: the delegate of the reviewer's live delegation of exactly this permission
 * (CI10), when that delegation's assignment covers this owner, and the delegate is not in `notDelegate`, is not the owner
 * (never-self) and independently holds an eligible assignment of equivalent authority (DB018; DF03). Otherwise the reviewer
 * keeps the step, so a delegation never blocks routing. One hop: the delegate's own delegations are not followed (DF03 "no
 * redelegation"). The delegation row is share-locked, so an early end is ordered before or after this routing.
 */
async function routeStep(tx: Queryable, companyId: string, step: StepRow, reviewer: string, ownerEmployeeId: string | null, notDelegate: readonly string[]): Promise<StepRoute> {
  const delegation = (
    await tx.query<{ id: string; delegate_user_id: string; delegator_class: AccessClass }>(
      `select dl.id, dl.delegate_user_id, r.access_class as delegator_class
         from delegation dl
         join role_assignment ra on ra.company_id = dl.company_id and ra.id = dl.delegator_assignment_id
         join role r on r.company_id = ra.company_id and r.id = ra.role_id
        where dl.company_id = $1 and dl.delegator_user_id = $2 and dl.permission_id = $3
          and dl.state = 'ACTIVE' and dl.effective_from <= now() and dl.effective_to > now()
          and hrms_delegation_covers($1, dl.id, $4, now())
        for share of dl`,
      [companyId, reviewer, step.permission_id, ownerEmployeeId],
    )
  ).rows[0];
  if (
    delegation &&
    !notDelegate.includes(delegation.delegate_user_id) &&
    (await isEligibleReviewer(tx, companyId, delegation.delegate_user_id, step.permission_id, ownerEmployeeId, classesAtLeast(delegation.delegator_class)))
  ) {
    return { assignee: delegation.delegate_user_id, delegationId: delegation.id };
  }
  return { assignee: reviewer, delegationId: null };
}

async function createTask(tx: Queryable, companyId: string, instanceId: string, step: StepRow, route: StepRoute, actor: string) {
  return (
    await tx.query<{ id: string }>(
      `insert into approval_task (company_id, instance_id, workflow_id, step_id, assignee_user_id, delegation_id, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'PENDING', $7, $7) returning id`,
      [companyId, instanceId, step.workflow_id, step.id, route.assignee, route.delegationId, actor],
    )
  ).rows[0]!.id;
}

/**
 * Who already decided a step of this instance, with the delegator whose authority a delegated decision used: a later step
 * goes to neither (C4 independent review; DF03 "Claimant differs from all claim approvers").
 */
async function priorDecidersOf(tx: Queryable, companyId: string, instanceId: string): Promise<string[]> {
  const rows = (
    await tx.query<{ u: string; delegator: string | null }>(
      `select d.actor_user_id as u, dl.delegator_user_id as delegator
         from approval_decision d
         join approval_task t on t.company_id = d.company_id and t.id = d.task_id
         left join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id
        where t.company_id = $1 and t.instance_id = $2`,
      [companyId, instanceId],
    )
  ).rows;
  return [...new Set(rows.flatMap((r) => (r.delegator ? [r.u, r.delegator] : [r.u])))];
}

export interface StartApprovalInput {
  companyId: string;
  kind: string;
  transactionId: string;
  ownerEmployeeId: string | null;
  actorUserId: string;
  /** Module rule that changes who reviews (e.g. DF05 old back-dated leave goes to HR). */
  selectionOverride?: SelectionRule | undefined;
  /** Users who must not review this transaction (e.g. its preparer, C4). Applies to every step. */
  excludeUserIds?: readonly string[] | undefined;
}

export async function startApproval(tx: Queryable, input: StartApprovalInput): Promise<{ instanceId: string; taskId: string; assigneeUserId: string }> {
  const bt = (
    await tx.query<{ revision: number; created_by: string | null }>(`select revision, created_by from business_transaction where company_id = $1 and id = $2`, [input.companyId, input.transactionId])
  ).rows[0];
  if (!bt) throw notFound();

  const workflow = (
    await tx.query<{ id: string }>(
      `select id from workflow_definition
        where company_id = $1 and kind = $2 and active
          and effective_from <= now() and (effective_to is null or effective_to > now())`,
      [input.companyId, input.kind],
    )
  ).rows[0];
  if (!workflow) throw new HttpError(422, 'WORKFLOW_NOT_CONFIGURED', `No active approval workflow for ${input.kind}`);

  const step = (
    await tx.query<StepRow>(
      `select ${STEP_COLUMNS} from workflow_step
        where company_id = $1 and workflow_id = $2 and condition_code is null order by sequence limit 1`,
      [input.companyId, workflow.id],
    )
  ).rows[0];
  if (!step) throw new HttpError(422, 'WORKFLOW_NOT_CONFIGURED', 'Workflow has no steps');

  const excluded = [...new Set(input.excludeUserIds ?? [])];
  const reviewer = await selectReviewer(tx, input.companyId, input.kind, step, input.ownerEmployeeId, input.selectionOverride, excluded);
  const route = await routeStep(tx, input.companyId, step, reviewer, input.ownerEmployeeId, [...excluded, input.actorUserId, ...(bt.created_by ? [bt.created_by] : [])]);
  // The exclusions are kept with the instance, so every later step honours them too (C4; 0052).
  const instanceId = (
    await tx.query<{ id: string }>(
      `insert into approval_instance (company_id, transaction_kind, transaction_id, transaction_revision, workflow_id, state, excluded_user_ids, selection_override, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'ACTIVE', $7::uuid[], $8, $6, $6) returning id`,
      [input.companyId, input.kind, input.transactionId, bt.revision, workflow.id, input.actorUserId, excluded, input.selectionOverride ?? null],
    )
  ).rows[0]!.id;
  const taskId = await createTask(tx, input.companyId, instanceId, step, route, input.actorUserId);
  return { instanceId, taskId, assigneeUserId: route.assignee };
}

/**
 * Read-only routing check (FR-082 "missing reviewer is reported"): the owners for whom the first step of the kind's
 * active workflow would find no eligible reviewer now, by the same selection startApproval makes, without creating
 * anything. A kind without an active workflow or steps has no reviewer for anyone. Fallback-list steps are checked in
 * one statement (fallbackUser + isEligibleReviewer over every owner); other rules owner by owner (selectReviewer).
 */
export async function ownersWithoutEligibleReviewer(tx: Queryable, companyId: string, kind: string, ownerEmployeeIds: readonly string[]): Promise<Set<string>> {
  if (ownerEmployeeIds.length === 0) return new Set();
  const step = (
    await tx.query<StepRow>(
      `select ${STEP_COLUMNS} from workflow_step
        where company_id = $1 and condition_code is null
          and workflow_id = (select id from workflow_definition where company_id = $1 and kind = $2 and active
                                and effective_from <= now() and (effective_to is null or effective_to > now()) limit 1)
        order by sequence limit 1`,
      [companyId, kind],
    )
  ).rows[0];
  if (!step) return new Set(ownerEmployeeIds);
  if (step.selection_rule !== 'HR_FALLBACK_LIST') {
    const missing = new Set<string>();
    for (const owner of ownerEmployeeIds) {
      try {
        await selectReviewer(tx, companyId, kind, step, owner, undefined);
      } catch (err) {
        if (!(err instanceof HttpError && err.code === 'NO_ELIGIBLE_REVIEWER')) throw err;
        missing.add(owner);
      }
    }
    return missing;
  }
  const rows = (
    await tx.query<{ emp: string }>(
      `with d as (select hrms_business_date($1, now()) as day)
       select o.emp from d, unnest($3::uuid[]) as o (emp)
        where not exists (
          select 1
            from workflow_fallback_reviewer w
            join role_assignment ra on ra.company_id = w.company_id and ra.user_id = w.user_id and ra.state = 'ACTIVE'
                                   and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
            join user_account u on u.id = ra.user_id and u.active
            join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
            join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = $4 and rp.effect = 'ALLOW'
            join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = $4 and rap.active
                                               and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
           where w.company_id = $1 and w.active
             and w.kind = (select coalesce(routing_kind, kind) from transaction_kind where kind = $2)
             and ${scopeCovers('$1', 'o.emp')}
             and not exists (select 1 from user_employee_link l where l.company_id = $1 and l.user_id = w.user_id and l.employee_id = o.emp))`,
      [companyId, kind, [...ownerEmployeeIds], step.permission_id],
    )
  ).rows;
  return new Set(rows.map((r) => r.emp));
}

export interface DecideInput {
  grant: AccessGrant;
  taskId: string;
  decision: Decision;
  reason?: string | undefined;
  idempotencyKey: string;
  /** The resource/action the route authorised; must match the step's permission. */
  permission: { resource: string; action: string };
  /** Evaluates a conditional step (workflow_step.condition_code); unknown or absent conditions are skipped. */
  stepApplies?: ((conditionCode: string) => boolean) | undefined;
  /** Runs after the decision row is written and before the next step or outcome (e.g. line decisions). */
  onDecided?: ((decisionId: string, ctx: { sequence: number }) => Promise<void>) | undefined;
}

export interface DecideResult {
  outcome: DecisionOutcome;
  transactionId: string;
  instanceId: string;
  ownerEmployeeId: string | null;
  replayed: boolean;
}

interface TaskContext {
  task_state: string;
  assignee_user_id: string;
  delegation_id: string | null;
  instance_created_by: string | null;
  bt_created_by: string | null;
  instance_id: string;
  instance_state: string;
  workflow_id: string;
  step_id: string;
  sequence: number;
  resource: string;
  action: string;
  field_group: string;
  transaction_id: string;
  kind: string;
  owner_employee_id: string | null;
  bt_version: number;
  excluded_user_ids: string[];
  selection_override: SelectionRule | null;
}

async function taskContext(tx: Queryable, companyId: string, taskId: string, lock: boolean): Promise<TaskContext | undefined> {
  return (
    await tx.query<TaskContext>(
      `select t.state as task_state, t.assignee_user_id, t.delegation_id, i.created_by as instance_created_by, bt.created_by as bt_created_by,
              i.id as instance_id, i.state as instance_state, s.workflow_id, t.step_id, s.sequence,
              p.resource, p.action, p.field_group, bt.id as transaction_id, bt.kind, bt.owner_employee_id, bt.version as bt_version,
              i.excluded_user_ids, i.selection_override
         from approval_task t
         join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         join permission p on p.id = s.permission_id
         join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
        where t.company_id = $1 and t.id = $2
        ${lock ? 'for update of t, bt' : ''}`,
      [companyId, taskId],
    )
  ).rows[0];
}

/** Who may not receive this instance's task as a delegate: the given users, its requester and whoever started the approval. */
const requesterAnd = (ctx: TaskContext, users: readonly string[]): string[] => [...users, ...[ctx.instance_created_by, ctx.bt_created_by].filter((u): u is string => u !== null)];

function outcomeOf(instanceState: string): DecisionOutcome {
  if (instanceState === 'APPROVED') return 'APPROVED';
  if (instanceState === 'REJECTED') return 'REJECTED';
  if (instanceState === 'RETURNED') return 'RETURNED';
  return 'NEXT_STEP';
}

/**
 * Serialises every state change of one business transaction — decisions, withdrawals, resubmissions and
 * cancellations — whatever rows each path locks afterwards. Take it before any row lock: it removes lock-order
 * deadlocks between paths, and statements after it read the latest committed state (no stale revision).
 */
export async function lockTransaction(tx: Queryable, transactionId: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('bt:' || $1, 0))`, [transactionId]);
}

/**
 * C4 "Delegated task" at the actual decision (CI10; RBAC instruction line 95; ZT04; ZT05), inside the decision transaction
 * after its locks: the delegation is live and names this step's permission; the delegator's named assignment still holds it
 * and covers the owner; the acting assignment is of equivalent authority; the delegate is not linked to the owner in any
 * period, is not the requester or preparer, and did not already decide this instance. Share locks order this decision
 * strictly before or after an early end and a revocation of the delegator's grant. A refusal rolls everything back. The
 * caller has already re-resolved the delegate's own permission (reassertAccess) and goes on to check their row scope.
 */
async function assertDelegationHolds(tx: Queryable, grant: AccessGrant, taskId: string, delegationId: string, ctx: TaskContext): Promise<{ delegatorUserId: string }> {
  const d = (
    await tx.query<{ delegator_user_id: string; delegator_assignment_id: string | null }>(
      `select delegator_user_id, delegator_assignment_id from delegation where company_id = $1 and id = $2 for share`,
      [grant.companyId, delegationId],
    )
  ).rows[0]!;
  const delegator = (
    await tx.query<{ access_class: AccessClass }>(
      `select r.access_class from role_assignment ra join role r on r.company_id = ra.company_id and r.id = ra.role_id
        where ra.company_id = $1 and ra.id = $2 for share of ra`,
      [grant.companyId, d.delegator_assignment_id],
    )
  ).rows[0];
  const live = (await tx.query<{ live: boolean }>(`select hrms_delegated_task_live($1, $2, now()) as live`, [grant.companyId, taskId])).rows[0]?.live === true;
  if (!live || !delegator) throw new HttpError(403, 'DELEGATION_NOT_LIVE', 'This delegation has ended or no longer covers this request, so it cannot be decided under it');
  if (!classesAtLeast(delegator.access_class).includes(grant.accessClass)) {
    throw new HttpError(403, 'DELEGATE_NOT_ELIGIBLE', 'Select an assignment of equivalent authority to decide this delegated request');
  }
  if (ctx.owner_employee_id) await assertNotOwnRecord(tx, grant, ctx.owner_employee_id);
  const conflicted = [...ctx.excluded_user_ids, ctx.instance_created_by, ctx.bt_created_by, ...(await priorDecidersOf(tx, grant.companyId, ctx.instance_id))];
  if (conflicted.includes(grant.userId)) throw new HttpError(403, 'DELEGATE_CONFLICT', 'You requested or already decided this request, so you cannot decide it under a delegation');
  return { delegatorUserId: d.delegator_user_id };
}

export async function decideTask(tx: Queryable, input: DecideInput): Promise<DecideResult> {
  const { grant } = input;
  const owner = (
    await tx.query<{ transaction_id: string }>(
      `select i.transaction_id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2`,
      [grant.companyId, input.taskId],
    )
  ).rows[0];
  if (!owner) throw notFound();
  await lockTransaction(tx, owner.transaction_id);

  // Idempotent replay: the same key returns the recorded outcome without a second effect (ZT07).
  const prior = (
    await tx.query<{ task_id: string }>(`select task_id from approval_decision where company_id = $1 and idempotency_key = $2`, [
      grant.companyId,
      input.idempotencyKey,
    ])
  ).rows[0];
  if (prior) {
    if (prior.task_id !== input.taskId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another task');
    const ctx = await taskContext(tx, grant.companyId, input.taskId, false);
    if (!ctx) throw notFound();
    return { outcome: outcomeOf(ctx.instance_state), transactionId: ctx.transaction_id, instanceId: ctx.instance_id, ownerEmployeeId: ctx.owner_employee_id, replayed: true };
  }

  const ctx = await taskContext(tx, grant.companyId, input.taskId, true);
  // Someone else's task is indistinguishable from a missing one.
  if (!ctx || ctx.assignee_user_id !== grant.userId) throw notFound();
  if (ctx.resource !== input.permission.resource || ctx.action !== input.permission.action) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  if (ctx.task_state !== 'PENDING' || ctx.instance_state !== 'ACTIVE') throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');

  // The step's permission is resolved again after the locks (docs/09 §6.5): a narrowing since the route guard is never missed.
  await reassertAccess(tx, grant, ctx.resource, ctx.action, [ctx.field_group]);
  const delegated = ctx.delegation_id ? await assertDelegationHolds(tx, grant, input.taskId, ctx.delegation_id, ctx) : null;
  // ...and so is row scope (RBAC instruction "changed managers"): after a reporting-line or scope change the task stays
  // open with its assignee (C4: no automatic transfer), who can no longer decide it. It reads as missing, like an
  // out-of-scope record, and nothing is recorded. This is checked here, before the task closes, because assigned scope
  // lasts only while the task is pending: a module must not repeat it after this call returns.
  if (ctx.owner_employee_id && !(await canAccessEmployee(tx, grant, ctx.owner_employee_id))) throw notFound();

  // Database trigger re-checks: open task, current revision, actor = assignee, live acting assignment, no self decision.
  const decisionId = (
    await tx.query<{ id: string }>(
      `insert into approval_decision (company_id, task_id, actor_user_id, acting_assignment_id, decision, reason, expected_version,
                                      idempotency_key, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $3, $3) returning id`,
      [grant.companyId, input.taskId, grant.userId, grant.assignmentId, input.decision, input.reason?.trim() || null, ctx.bt_version, input.idempotencyKey],
    )
  ).rows[0]!.id;
  // C4 "Preserve delegator, delegate and actual actor in history"; line 95. The task keeps delegation_id for good as well.
  if (delegated) {
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'approval_task',
      recordKey: input.taskId,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'DELEGATED_DECISION',
      after: {
        operational: { delegationId: ctx.delegation_id, delegatorUserId: delegated.delegatorUserId, delegateUserId: ctx.assignee_user_id, actorUserId: grant.userId, decision: input.decision, transactionId: ctx.transaction_id },
      },
    });
  }
  if (input.onDecided) await input.onDecided(decisionId, { sequence: ctx.sequence });
  const taskState = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'RETURNED';
  await tx.query(`update approval_task set state = $3, decided_at = now(), updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    input.taskId,
    taskState,
    grant.userId,
  ]);

  let outcome: DecisionOutcome;
  if (input.decision === 'APPROVE') {
    const later = (
      await tx.query<StepRow>(`select ${STEP_COLUMNS} from workflow_step where company_id = $1 and workflow_id = $2 and sequence > $3 order by sequence`, [
        grant.companyId,
        ctx.workflow_id,
        ctx.sequence,
      ])
    ).rows;
    const next = later.find((s) => s.condition_code === null || input.stepApplies?.(s.condition_code) === true);
    if (next) {
      // C4: a later step never goes to anyone who already decided this instance (independent review).
      const priorDeciders = await priorDecidersOf(tx, grant.companyId, ctx.instance_id);
      // ...nor to anyone the approval excluded when it started (its preparer or requester, C4).
      const notReviewer = [...priorDeciders, ...ctx.excluded_user_ids];
      const reviewer = await selectReviewer(tx, grant.companyId, ctx.kind, next, ctx.owner_employee_id, undefined, notReviewer);
      const route = await routeStep(tx, grant.companyId, next, reviewer, ctx.owner_employee_id, requesterAnd(ctx, notReviewer));
      await createTask(tx, grant.companyId, ctx.instance_id, next, route, grant.userId);
      outcome = 'NEXT_STEP';
    } else {
      outcome = 'APPROVED';
    }
  } else {
    outcome = input.decision === 'REJECT' ? 'REJECTED' : 'RETURNED';
  }

  if (outcome !== 'NEXT_STEP') {
    await tx.query(`update approval_instance set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [
      grant.companyId,
      ctx.instance_id,
      outcome,
      grant.userId,
    ]);
    await tx.query(
      `update approval_task set state = 'CANCELLED', updated_by = $3 where company_id = $1 and instance_id = $2 and state = 'PENDING'`,
      [grant.companyId, ctx.instance_id, grant.userId],
    );
  }
  return { outcome, transactionId: ctx.transaction_id, instanceId: ctx.instance_id, ownerEmployeeId: ctx.owner_employee_id, replayed: false };
}

/** Ends the active approval of a transaction (withdrawal/cancellation); pending tasks are cancelled. */
export async function cancelActiveApproval(tx: Queryable, companyId: string, transactionId: string, actorUserId: string): Promise<void> {
  const instance = (
    await tx.query<{ id: string }>(
      `update approval_instance set state = 'CANCELLED', updated_by = $3
        where company_id = $1 and transaction_id = $2 and state = 'ACTIVE' returning id`,
      [companyId, transactionId, actorUserId],
    )
  ).rows[0];
  if (instance) {
    await tx.query(
      `update approval_task set state = 'CANCELLED', updated_by = $3 where company_id = $1 and instance_id = $2 and state = 'PENDING'`,
      [companyId, instance.id, actorUserId],
    );
  }
}

/**
 * The caller's open tasks whose owner is in the selected assignment's current row scope (FR-060 work queue base; ZT02).
 * Counts and rows share one query. After a reporting-line change the former manager's task no longer appears here.
 */
export async function myOpenTasks(db: Queryable, grant: AccessGrant, kind?: string) {
  const params = new SqlParams([grant.companyId, grant.userId, kind ?? null]);
  const rows = await db.query(
    `select t.id as "taskId", bt.kind, bt.id as "transactionId", bt.owner_employee_id as "ownerEmployeeId",
            e.employee_code as "ownerEmployeeCode", e.display_name as "ownerName", t.created_at as "assignedAt",
            s.sequence as "step", p.action as "stepAction"
       from approval_task t
       join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
       join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
       join permission p on p.id = s.permission_id
       join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
       left join employee e on e.company_id = bt.company_id and e.id = bt.owner_employee_id
      where t.company_id = $1 and t.assignee_user_id = $2 and t.state = 'PENDING' and ($3::text is null or bt.kind = $3)
        and ${taskDelegationLive('t')}
        and ${taskOwnerInScope(grant, params)}
      order by t.created_at`,
    params.values,
  );
  return { items: rows.rows, total: rows.rowCount ?? 0 };
}

const unrestrictedCompanyScope = (grant: AccessGrant) =>
  grant.scopeKind === 'COMPANY' && grant.filters.departments.length === 0 && grant.filters.locations.length === 0 && grant.filters.employees.length === 0;

/**
 * Open employee-owned tasks in the caller's row scope that their assignee can no longer decide (DF03 repairable routing;
 * C4 "Changed organisation or manager"): nobody else sees them, so routing administration must. Operational fields only.
 * The assignee no longer holds an assignment that would pass reviewer selection for the task's step and owner, or the
 * delegation the task was assigned under has ended or lost its delegator's authority. A task of a transaction with no
 * employee owner (a company-wide payroll run, CI12) has no row to scope, so it is listed only for an unrestricted company
 * scope, and only when its delegation is what stranded it.
 */
export async function strandedTasks(db: Queryable, grant: AccessGrant) {
  const params = new SqlParams([grant.companyId]);
  const ownerless = unrestrictedCompanyScope(grant) ? `(bt.owner_employee_id is null and not ${taskDelegationLive('t')})` : 'false';
  const rows = await db.query(
    `with d as (select hrms_business_date($1, now()) as day)
     select t.id as "taskId", bt.kind, bt.id as "transactionId", bt.owner_employee_id as "ownerEmployeeId",
            e.employee_code as "ownerEmployeeCode", e.display_name as "ownerName", t.created_at as "assignedAt",
            t.assignee_user_id as "assigneeUserId", au.account_key as "assigneeAccountKey", s.sequence as "step", t.delegation_id as "delegationId"
       from d, approval_task t
       join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
       join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
       join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
       left join employee e on e.company_id = bt.company_id and e.id = bt.owner_employee_id
       join user_account au on au.id = t.assignee_user_id
      where t.company_id = $1 and t.state = 'PENDING'
        and (${ownerless} or (
        bt.owner_employee_id is not null
        and ${employeeScopePredicate(grant, { company: 'bt.company_id', employee: 'bt.owner_employee_id' }, params)}
        and not (au.active and ${taskDelegationLive('t')}
                 and not exists (select 1 from user_employee_link own where own.company_id = t.company_id and own.user_id = t.assignee_user_id and own.employee_id = bt.owner_employee_id)
                 and exists (
          select 1
            from role_assignment ra
            join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
            join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = s.permission_id and rp.effect = 'ALLOW'
            join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = s.permission_id and rap.active
                                               and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
           where ra.company_id = t.company_id and ra.user_id = t.assignee_user_id and ra.state = 'ACTIVE'
             and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
             and ${scopeCovers('t.company_id', 'bt.owner_employee_id')}))))
      order by t.created_at limit 200`,
    params.values,
  );
  return { items: rows.rows };
}

export interface RerouteResult {
  taskId: string;
  supersededTaskId: string;
  supersededAssigneeUserId: string;
  assigneeUserId: string;
  transactionId: string;
  kind: string;
  ownerEmployeeId: string | null;
}

/**
 * C4 "owner-approved rerouting creates new task with history": the open task of an employee-owned transaction, or of an
 * ownerless one whose delegation stranded it (strandedTasks says who sees that), whose
 * assignee can no longer decide it is SUPERSEDED (kept) and a new task on the same step goes to whoever selection now
 * finds (DF03: the current direct manager, or the fallback list, under the same rule that routed the step). The caller
 * never chooses the reviewer, and a task whose assignee can still decide it is not rerouted. Requires the
 * workflow.reroute_task permission, which is in no role's ceiling until the owner decides who approves a reroute.
 */
export async function rerouteTask(tx: Queryable, grant: AccessGrant, taskId: string): Promise<RerouteResult> {
  const located = (
    await tx.query<{ transaction_id: string }>(
      `select i.transaction_id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2`,
      [grant.companyId, taskId],
    )
  ).rows[0];
  if (!located) throw notFound();
  await lockTransaction(tx, located.transaction_id);
  const ctx = await taskContext(tx, grant.companyId, taskId, true);
  if (!ctx) throw notFound();
  await reassertAccess(tx, grant, 'workflow', 'reroute_task', ['operational']);
  const owner = ctx.owner_employee_id;
  if (owner) {
    if (!(await canAccessEmployee(tx, grant, owner))) throw notFound();
    // Sending one's own request to another reviewer is choosing one's own approver (C4 self approval).
    await assertNotOwnRecord(tx, grant, owner);
  } else if (!ctx.delegation_id || !unrestrictedCompanyScope(grant)) {
    throw notFound();
  }
  if (ctx.task_state !== 'PENDING' || ctx.instance_state !== 'ACTIVE') throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');

  const steps = (
    await tx.query<StepRow>(`select ${STEP_COLUMNS} from workflow_step where company_id = $1 and workflow_id = $2 and condition_code is null order by sequence`, [grant.companyId, ctx.workflow_id])
  ).rows;
  const step = (await tx.query<StepRow>(`select ${STEP_COLUMNS} from workflow_step where company_id = $1 and id = $2`, [grant.companyId, ctx.step_id])).rows[0]!;
  const delegationHolds = !ctx.delegation_id || (await tx.query<{ live: boolean }>(`select hrms_delegated_task_live($1, $2, now()) as live`, [grant.companyId, taskId])).rows[0]?.live === true;
  if (delegationHolds && (await isEligibleReviewer(tx, grant.companyId, ctx.assignee_user_id, step.permission_id, owner))) {
    throw new HttpError(409, 'TASK_NOT_STRANDED', 'The current assignee can still decide this task');
  }
  const priorDeciders = await priorDecidersOf(tx, grant.companyId, ctx.instance_id);
  // A module's override applied to the step the approval started on, so it applies again only there.
  const override = steps[0]?.id === step.id ? (ctx.selection_override ?? undefined) : undefined;
  const notReviewer = [ctx.assignee_user_id, ...priorDeciders, ...ctx.excluded_user_ids];
  const reviewer = await selectReviewer(tx, grant.companyId, ctx.kind, step, owner, override, notReviewer);
  const route = await routeStep(tx, grant.companyId, step, reviewer, owner, requesterAnd(ctx, notReviewer));

  await tx.query(`update approval_task set state = 'SUPERSEDED', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, taskId, grant.userId]);
  const newTaskId = await createTask(tx, grant.companyId, ctx.instance_id, step, route, grant.userId);
  return {
    taskId: newTaskId,
    supersededTaskId: taskId,
    supersededAssigneeUserId: ctx.assignee_user_id,
    assigneeUserId: route.assignee,
    transactionId: ctx.transaction_id,
    kind: ctx.kind,
    ownerEmployeeId: owner,
  };
}
