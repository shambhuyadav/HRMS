// Shared helpers of the lifecycle module: scope and independence checks, state changes of typed roots, audit and
// employee status changes. Everything runs inside the caller's transaction.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { assertStatusTransition, type StatusSourceKind, withStatusSource } from '../employee/status.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACTIVE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED'] as const;

export interface Actor {
  companyId: string;
  userId: string;
  assignmentId: string | null;
}

export const actorOf = (grant: AccessGrant): Actor => ({ companyId: grant.companyId, userId: grant.userId, assignmentId: grant.assignmentId });

/** A real calendar date in ISO form (no silent roll-over such as 2026-02-30). */
export const isIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function requireDate(value: string, code = 'INVALID_DATE', field = 'date'): string {
  if (!isIsoDate(value)) throw new HttpError(422, code, `The ${field} is not a valid date`, { field });
  return value;
}

/** Date arithmetic on calendar dates (UTC, so no zone shift). */
export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const holds = (grant: AccessGrant, group: string): boolean => grant.allowedFieldGroups.includes(group);

/** Row scope: an employee outside the caller's scope reads as missing (never reveals existence). */
export async function assertInScope(db: Queryable, grant: AccessGrant, employeeId: string): Promise<void> {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
}

export const isSelf = (grant: AccessGrant, employeeId: string): boolean => grant.linkedEmployeeId === employeeId;

/** DF02/C4: an administrator never handles their own exit, process, letters, notes or settlement. */
export function assertNotSelf(grant: AccessGrant, employeeId: string): void {
  if (isSelf(grant, employeeId)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
}

/** Moves a typed root and its business transaction to a new state (the deferred mirror checks they agree). */
export async function setRootState(
  tx: Queryable,
  table: 'exit_case' | 'exit_withdrawal_request' | 'employee_process' | 'settlement' | 'settlement_approval',
  companyId: string,
  row: { id: string; transaction_id: string },
  state: string,
  actorUserId: string,
  extra = '',
  extraValues: unknown[] = [],
): Promise<void> {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, row.transaction_id, state, actorUserId]);
  await tx.query(`update ${table} set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2`, [companyId, row.id, state, actorUserId, ...extraValues]);
}

export async function audit(
  tx: Queryable,
  actor: Actor,
  resource: string,
  recordKey: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason?: string | null,
): Promise<void> {
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource,
    recordKey,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action,
    before,
    after,
    reason: reason ?? null,
  });
}

/** Whether a user is linked to an employee in any period (C4 self check, as the decision guard applies it). */
export async function userIsEmployee(db: Queryable, companyId: string, userId: string, employeeId: string): Promise<boolean> {
  const r = await db.query(`select 1 from user_employee_link where company_id = $1 and user_id = $2 and employee_id = $3`, [companyId, userId, employeeId]);
  return (r.rowCount ?? 0) > 0;
}

export async function employeeStatus(tx: Queryable, companyId: string, employeeId: string, lock = false): Promise<string | null> {
  // Lock first, read after: a `for update of e` joined to the status row drops the employee when a concurrent commit
  // has just changed the status (the recheck keeps the old joined row), and this read must see that new status.
  if (lock) await tx.query(`select 1 from employee where company_id = $1 and id = $2 for update`, [companyId, employeeId]);
  const row = (
    await tx.query<{ status: string }>(
      `select st.code as status from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where e.company_id = $1 and e.id = $2`,
      [companyId, employeeId],
    )
  ).rows[0];
  return row?.status ?? null;
}

/**
 * Changes the employee's lifecycle status as the effect of an exit decision or the separation job, with the
 * employee's own audit record and an operational event (FR-055: nothing else about the employee changes). `source`
 * says what the status history records (0101): the kind of change and the business date it applies from.
 */
export async function changeEmployeeStatus(
  tx: Queryable,
  actor: Actor,
  employeeId: string,
  from: string,
  to: string,
  exitCaseId: string,
  source: { kind: StatusSourceKind; effectiveDate: string },
): Promise<void> {
  assertStatusTransition(from, to);
  const updated = await withStatusSource(tx, { ...source, sourceId: exitCaseId }, async () =>
    (
      await tx.query<{ prior: number; version: number }>(
        `update employee set status_id = (select id from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' and code = $3), updated_by = $4
          where company_id = $1 and id = $2 returning version - 1 as prior, version`,
        [actor.companyId, employeeId, to, actor.userId],
      )
    ).rows[0],
  );
  if (!updated) throw notFound();
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource: 'employee',
    recordKey: employeeId,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action: 'STATUS_CHANGE',
    priorVersion: updated.prior,
    newVersion: updated.version,
    before: { operational: { status: from } },
    after: { operational: { status: to, exitCaseId } },
  });
  await enqueueEvent(tx, {
    companyId: actor.companyId,
    topic: 'employee.status_changed',
    aggregateId: employeeId,
    dedupeKey: `employee.status_changed:${employeeId}:${updated.version}`,
    payload: { employeeId, status: to, exitCaseId, version: updated.version },
  });
}

/** Serialises work on one key (e.g. an employee's exit) for the rest of the transaction. */
export async function advisoryLock(tx: Queryable, key: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

/** The recorded idempotent decision for a key: same task replays, another task is a conflict (ZT07). */
export async function priorDecision(tx: Queryable, companyId: string, idempotencyKey: string, taskId: string): Promise<boolean> {
  const replay = (await tx.query<{ task_id: string }>(`select task_id from approval_decision where company_id = $1 and idempotency_key = $2`, [companyId, idempotencyKey])).rows[0];
  if (!replay) return false;
  if (replay.task_id !== taskId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another task');
  return true;
}

export async function taskIsPending(tx: Queryable, grant: AccessGrant, taskId: string): Promise<boolean> {
  const t = await tx.query(`select 1 from approval_task where company_id = $1 and id = $2 and assignee_user_id = $3 and state = 'PENDING'`, [grant.companyId, taskId, grant.userId]);
  return (t.rowCount ?? 0) > 0;
}

/** The caller's task of one of the given kinds: its transaction (someone else's task reads as missing). */
export async function taskTransaction(tx: Queryable, grant: AccessGrant, taskId: string, kinds: readonly string[]): Promise<{ transactionId: string; kind: string }> {
  const t = (
    await tx.query<{ transaction_id: string; kind: string }>(
      `select i.transaction_id, i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [grant.companyId, taskId, grant.userId],
    )
  ).rows[0];
  if (!t || !kinds.includes(t.kind)) throw notFound();
  return { transactionId: t.transaction_id, kind: t.kind };
}

/** The pending task of a transaction's active approval (the next step after a decision). */
export async function pendingTaskOf(tx: Queryable, companyId: string, transactionId: string): Promise<string | null> {
  const r = (
    await tx.query<{ id: string }>(
      `select t.id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
        where i.company_id = $1 and i.transaction_id = $2 and t.state = 'PENDING' order by t.created_at desc limit 1`,
      [companyId, transactionId],
    )
  ).rows[0];
  return r?.id ?? null;
}

/**
 * Decision history of a transaction: kind, step, decision and time (the reviewer's private reason stays out). `kind`
 * tells which transaction an entry belongs to (e.g. the resignation or a withdrawal request). With `actors`, each
 * entry also names the deciding user, for screens whose readers check independence (settlements).
 */
export async function decisionTrail(db: Queryable, companyId: string, transactionIds: readonly string[], options: { actors?: boolean } = {}) {
  if (transactionIds.length === 0) return [];
  return (
    await db.query<{ transactionId: string; kind: string; step: number; action: string; decision: string; decidedAt: Date; actorUserId?: string }>(
      `select i.transaction_id as "transactionId", i.transaction_kind as kind, s.sequence as step, p.action, d.decision, d.occurred_at as "decidedAt"
              ${options.actors ? `, d.actor_user_id as "actorUserId"` : ''}
         from approval_instance i
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         join permission p on p.id = s.permission_id
        where i.company_id = $1 and i.transaction_id = any($2::uuid[])
        order by d.occurred_at`,
      [companyId, transactionIds],
    )
  ).rows;
}

/** Users who decided any approval of the given transactions (independence checks). */
export async function decidersOf(db: Queryable, companyId: string, transactionIds: readonly string[]): Promise<string[]> {
  if (transactionIds.length === 0) return [];
  return (
    await db.query<{ u: string }>(
      `select distinct d.actor_user_id as u from approval_instance i
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
        where i.company_id = $1 and i.transaction_id = any($2::uuid[])`,
      [companyId, transactionIds],
    )
  ).rows.map((r) => r.u);
}
