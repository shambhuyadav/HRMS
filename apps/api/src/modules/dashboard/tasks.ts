// Shared task predicate of the F2 task widgets ("Assigned ... tasks"). A task counts while it is the caller's current
// actionable task in an active instance (DF17 "pending means current actionable task in an active instance"), exactly
// as the workflow engine's task lists select them (workflow/engine.ts myOpenTasks), so a widget reconciles with the
// module's "tasks/mine" list of the same kinds (BR-045). Counts only: no amounts, reasons or attachments.
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, eligibleTasksOfGrant, SqlParams, taskDelegationLive, taskOwnerInScope } from '../access/authorize.js';
import type { MetricResult } from './service.js';

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
 */
export async function pendingTaskList(db: Queryable, g: AccessGrant) {
  const p = new SqlParams();
  const tasks = assignmentPendingTasks(g, p);
  const owner = (column: string) => `(select e.${column} from employee e where e.company_id = bt.company_id and e.id = bt.owner_employee_id)`;
  const rows = (
    await db.query(
      `select t.id as "taskId", bt.kind, s.sequence as step, ${owner('employee_code')} as "ownerEmployeeCode", ${owner('display_name')} as "ownerName",
              t.created_at as "assignedAt", t.due_at as "dueAt", coalesce(hrms_business_date(t.company_id, t.due_at) < ${p.add(g.businessDate)}::date, false) as overdue,
              t.delegation_id is not null as delegated
         ${tasks}
        order by t.due_at nulls last, t.created_at, t.id`,
      p.values,
    )
  ).rows;
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
