// Shared task predicate of the F2 task widgets ("Assigned ... tasks"). A task counts while it is the caller's current
// actionable task in an active instance (DF17 "pending means current actionable task in an active instance"), exactly
// as the workflow engine's task lists select them (workflow/engine.ts myOpenTasks), so a widget reconciles with the
// module's "tasks/mine" list of the same kinds (BR-045). Counts only: no amounts, reasons or attachments.
//
// FR-041 KRA review (I-77 item 3; docs/03 perf-4): a goal set waiting for its review is a state on the appraisal, not a routed
// task, yet it blocks the employee's self-entry (GOALS_NOT_REVIEWED). The task list and the assignment's task count therefore
// add every goal set the selected assignment may review now, by exactly the checks of POST /appraisals/:id/goal-review
// (appraisals.ts reviewGoals): the assignment holds appraisal.manage (operational) and covers the employee in that grant's row
// scope; the appraisal is a first-revision DRAFT of a cycle that requires the review, not yet reviewed, with a complete goal
// set (weights totalling 100) whose setter is known and is someone else; and the caller is not, and never was, linked to the
// employee. Anyone else with the duty may review it, so it shows for each of them (the direct manager in team scope, HR).
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, eligibleTasksOfGrant, employeeScopePredicate, resolveAccess, SqlParams, taskDelegationLive, taskOwnerInScope } from '../access/authorize.js';
import type { MetricResult } from './service.js';

/** The selected assignment's goal-review authority (appraisal.manage with the operational group), or null without it. */
export async function goalReviewGrant(db: Queryable, g: AccessGrant): Promise<AccessGrant | null> {
  const d = await resolveAccess(db, { userId: g.userId, companyId: g.companyId, assignmentId: g.assignmentId, resource: 'appraisal', action: 'manage', fieldGroups: ['operational'], at: g.at });
  return d.allowed && d.allowedFieldGroups.includes('operational') ? d : null;
}

/** `from ... where ...` of the goal sets `manage` may review now (aliases: a appraisal, c cycle, e employee); see the header. */
export function pendingGoalReviews(manage: AccessGrant, p: SqlParams): string {
  const scope = employeeScopePredicate(manage, { company: 'a.company_id', employee: 'a.employee_id' }, p);
  const user = `${p.add(manage.userId)}::uuid`;
  return `from appraisal a
       join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
       join employee e on e.company_id = a.company_id and e.id = a.employee_id
      where ${scope}
        and a.state = 'DRAFT' and a.revision = 1 and c.goal_review_required and a.goals_reviewed_at is null
        and a.goals_set_by is not null and a.goals_set_by <> ${user}
        and not exists (select 1 from user_employee_link l where l.company_id = a.company_id and l.user_id = ${user} and l.employee_id = a.employee_id)
        and (select count(*) > 0 and sum(i.weight) = 100 from appraisal_item i where i.company_id = a.company_id and i.appraisal_id = a.id and i.active)`;
}

/** How many goal sets the selected assignment may review now (0 without the duty). */
export async function goalReviewCount(db: Queryable, g: AccessGrant): Promise<number> {
  const manage = await goalReviewGrant(db, g);
  if (!manage) return 0;
  const p = new SqlParams();
  return Number((await db.query<{ n: string }>(`select count(*) as n ${pendingGoalReviews(manage, p)}`, p.values)).rows[0]?.n ?? 0);
}

/**
 * The F2 "Assigned ... tasks" count of the selected assignment: its pending workflow tasks (assignmentPendingTasks) and the goal
 * sets it may review now, so it reconciles with pendingTaskList (BR-045).
 */
export async function assignmentTaskCount(db: Queryable, g: AccessGrant): Promise<MetricResult> {
  const p = new SqlParams();
  const tasks = Number((await db.query<{ n: string }>(`select count(*) as n ${assignmentPendingTasks(g, p)}`, p.values)).rows[0]?.n ?? 0);
  return { status: 'OK', value: tasks + (await goalReviewCount(db, g)) };
}

/**
 * `from ... where ...` of the caller's pending tasks of the given transaction kinds (all kinds without any) whose owner is
 * in the grant's current row scope (aliases: t task, i instance, s step, sp step permission, bt business transaction).
 * Callers append further `and` conditions.
 */
export function myPendingTasks(g: AccessGrant, p: SqlParams, kinds?: readonly string[]): string {
  return `from approval_task t
       join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
       join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
       join permission sp on sp.id = s.permission_id
       join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id
      where t.company_id = ${p.add(g.companyId)}::uuid and t.assignee_user_id = ${p.add(g.userId)}::uuid and t.state = 'PENDING'
        ${kinds ? `and bt.kind = any(${p.add(kinds)}::text[])` : ''} and ${taskDelegationLive('t')} and ${taskOwnerInScope(g, p)}`;
}

/**
 * myPendingTasks narrowed to what the selected assignment itself may decide (eligibleTasksOf: its role and DB109 entry hold
 * the step's permission): the pending-task list and its count. A task routed through another assignment of the same user
 * shows under that one (DF17 "no merging across role assignments"; FR-097).
 */
export function assignmentPendingTasks(g: AccessGrant, p: SqlParams): string {
  const tasks = myPendingTasks(g, p);
  return `${tasks} and t.id in (select asg_t.id ${eligibleTasksOfGrant(g, 't.company_id', p)})`;
}

/** A count query's single `n` as an OK metric (zero means no eligible records, DF17). */
export async function countOf(db: Queryable, sql: string, p: SqlParams): Promise<MetricResult> {
  return { status: 'OK', value: Number((await db.query<{ n: string }>(sql, p.values)).rows[0]?.n ?? 0) };
}

/** First day of the company-local business month (DF17: operational counts default to the current month). */
export const monthStart = (businessDate: string): string => `${businessDate.slice(0, 8)}01`;

/** A metric whose source does not exist in this build: shown as unavailable, never as a misleading zero. */
export const notAvailable = async (): Promise<MetricResult> => ({ status: 'NOT_AVAILABLE' });

/**
 * DF17 priority task list: the selected assignment's pending tasks, oldest first and those with a due date earliest (a due
 * date passed is overdue, "pending with due date < company-local today"). Operational identity and dates only; what a task
 * decides stays on its queue. Every row can be decided in this assignment, so its action leads to the decision queues.
 *
 * Goal sets waiting for this assignment's KRA review (pendingGoalReviews) are rows too, of kind `appraisal_goal_review`: no task
 * id, the appraisal's id instead (its review is on the appraisal), assigned when the goal set was last changed, with no due date
 * (a review is a decision, not a windowed entry, I-77 item 3), never delegated. They sort among the other rows by the same keys.
 */
export async function pendingTaskList(db: Queryable, g: AccessGrant) {
  const p = new SqlParams();
  const tasks = assignmentPendingTasks(g, p);
  const owner = (column: string) => `(select e.${column} from employee e where e.company_id = bt.company_id and e.id = bt.owner_employee_id)`;
  type Row = { taskId: string | null; appraisalId?: string; kind: string; step: number | null; assignedAt: Date; dueAt: Date | null } & Record<string, unknown>;
  const rows = (
    await db.query<Row>(
      `select t.id as "taskId", bt.kind, s.sequence as step, ${owner('employee_code')} as "ownerEmployeeCode", ${owner('display_name')} as "ownerName",
              t.created_at as "assignedAt", t.due_at as "dueAt", coalesce(hrms_business_date(t.company_id, t.due_at) < ${p.add(g.businessDate)}::date, false) as overdue,
              t.delegation_id is not null as delegated
         ${tasks}
        order by t.due_at nulls last, t.created_at, t.id`,
      p.values,
    )
  ).rows;
  const manage = await goalReviewGrant(db, g);
  if (manage) {
    const q = new SqlParams();
    const reviews = (
      await db.query<Row>(
        `select null::uuid as "taskId", a.id as "appraisalId", 'appraisal_goal_review' as kind, null::int as step, e.employee_code as "ownerEmployeeCode",
                e.display_name as "ownerName", a.goals_set_at as "assignedAt", null::timestamptz as "dueAt", false as overdue, false as delegated
           ${pendingGoalReviews(manage, q)}
          order by a.goals_set_at, a.id`,
        q.values,
      )
    ).rows;
    if (reviews.length > 0) {
      // The SQL order of the workflow rows (due date, nulls last; then assigned; then id), applied to both; Array.sort is stable.
      const time = (d: Date | null) => (d ? new Date(d).getTime() : Number.POSITIVE_INFINITY);
      const id = (r: Row) => r.taskId ?? r.appraisalId ?? '';
      rows.push(...reviews);
      rows.sort((x, y) => time(x.dueAt) - time(y.dueAt) || time(x.assignedAt) - time(y.assignedAt) || (id(x) < id(y) ? -1 : id(x) > id(y) ? 1 : 0));
    }
  }
  return { items: rows, total: rows.length, businessDate: g.businessDate };
}

/**
 * F2 Employee "Own pending requests": the rows behind the metric, by the same kind and state pairs (`pairs`, from
 * OWN_REQUEST_PENDING_STATES). Kind, state and date only. An account with no linked employee has none.
 */
export async function ownPendingRequests(db: Queryable, g: AccessGrant, pairs: readonly (readonly [string, string])[]) {
  if (!g.linkedEmployeeId) return { items: [], total: 0 };
  const rows = (
    await db.query(
      `select bt.id, bt.kind, bt.state, bt.created_at as "createdAt" from business_transaction bt
         join unnest($3::text[], $4::text[]) as p (kind, state) on p.kind = bt.kind and p.state = bt.state
        where bt.company_id = $1 and bt.owner_employee_id = $2 order by bt.created_at desc`,
      [g.companyId, g.linkedEmployeeId, pairs.map(([kind]) => kind), pairs.map(([, state]) => state)],
    )
  ).rows;
  return { items: rows, total: rows.length };
}
