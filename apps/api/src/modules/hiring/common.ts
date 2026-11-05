// Hiring module helpers shared by budgets, requisitions, candidates, applications, offers and handover.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACTIVE_EMPLOYEE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'];

export type Actor = Pick<AccessGrant, 'companyId' | 'userId' | 'assignmentId'>;

/** Next generated reference of a kind for the company (serialised by the counter row lock until commit). */
export async function nextCode(tx: Queryable, companyId: string, counter: 'REQUISITION' | 'CANDIDATE', userId: string): Promise<string> {
  const value = (
    await tx.query<{ v: number }>(
      `insert into hiring_counter (company_id, counter, last_value, created_by, updated_by) values ($1, $2, 1, $3, $3)
       on conflict (company_id, counter) do update set last_value = hiring_counter.last_value + 1, updated_by = excluded.updated_by
       returning last_value as v`,
      [companyId, counter, userId],
    )
  ).rows[0]!.v;
  return `${counter === 'REQUISITION' ? 'REQ' : 'CAN'}-${String(value).padStart(6, '0')}`;
}

/** Audit with operational values only: confidential values never enter the trail (field names at most). */
export async function audit(
  tx: Queryable,
  actor: Actor,
  resource: string,
  recordKey: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
  reason?: string | null,
): Promise<void> {
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource,
    recordKey,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action,
    before: before ? { operational: before } : null,
    after: { operational: after },
    reason: reason ?? null,
  });
}

export type RootTable = 'requisition' | 'manpower_budget_revision' | 'hiring_offer';

/** Moves a typed root and its business transaction together (the deferred mirror trigger checks them at commit). */
export async function setRootState(
  tx: Queryable,
  table: RootTable,
  companyId: string,
  row: { id: string; transaction_id: string },
  state: string,
  userId: string,
  extra = '',
  extraValues: unknown[] = [],
): Promise<void> {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, row.transaction_id, state, userId]);
  await tx.query(`update ${table} set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2`, [companyId, row.id, state, userId, ...extraValues]);
}

/** A new typed transaction in DRAFT (the deferred root check needs the root row before commit). */
export async function newTransaction(tx: Queryable, companyId: string, kind: string, ownerEmployeeId: string | null, userId: string, predecessorTransactionId: string | null = null): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, predecessor_transaction_id, created_by, updated_by) values ($1, $2, $3, 'DRAFT', $5, $4, $4) returning id`,
      [companyId, kind, ownerEmployeeId, userId, predecessorTransactionId],
    )
  ).rows[0]!.id;
}

export async function requireActiveMaster(tx: Queryable, table: 'department' | 'location' | 'designation', companyId: string, id: string): Promise<void> {
  const ok = await tx.query(`select 1 from ${table} where company_id = $1 and id = $2 and active`, [companyId, id]);
  if (!ok.rowCount) throw new HttpError(422, 'INVALID_REFERENCE', `The ${table} is not an active master in this company`, { field: `${table}Id` });
}

export async function referenceId(tx: Queryable, companyId: string, category: string, code: string): Promise<string> {
  const row = (await tx.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = $2 and code = $3`, [companyId, category, code])).rows[0];
  if (!row) throw new HttpError(422, 'INVALID_REFERENCE', `${code} is not an active ${category} value`, { category });
  return row.id;
}

export async function isActiveEmployee(tx: Queryable, companyId: string, employeeId: string): Promise<boolean> {
  const row = await tx.query(
    `select 1 from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
      where e.company_id = $1 and e.id = $2 and st.code = any($3::text[])`,
    [companyId, employeeId, ACTIVE_EMPLOYEE_STATUSES],
  );
  return (row.rowCount ?? 0) > 0;
}

const advisoryLock = (tx: Queryable, key: string) => tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);

/** Serialises vacancy counting and closure of one requisition. Take it after any transaction lock. */
export const lockRequisition = (tx: Queryable, companyId: string, requisitionId: string) => advisoryLock(tx, `hiring:requisition:${companyId}:${requisitionId}`);
/** Serialises budget checks and revisions of one budget line. Take it after any transaction and requisition lock. */
export const lockBudget = (tx: Queryable, companyId: string, budgetId: string) => advisoryLock(tx, `hiring:budget:${companyId}:${budgetId}`);
/** Serialises duplicate detection for one identity key. */
export const lockIdentity = (tx: Queryable, companyId: string, key: string) => advisoryLock(tx, `hiring:identity:${companyId}:${key}`);
/** Serialises acceptances and handovers of one company (0113; the guard takes the same key). Take it after any transaction and requisition lock. */
export const lockConversion = (tx: Queryable, companyId: string) => advisoryLock(tx, `hiring:conversion:${companyId}`);

const CONVERSION_BLOCKS: Readonly<Record<string, string>> = {
  CANDIDATE_NOT_ACTIVE: 'The candidate record is not active',
  CANDIDATE_ALREADY_EMPLOYED: 'This person is already an employee, through this candidate record or one confirmed as its duplicate',
  CANDIDATE_OFFER_ACCEPTED: 'This person already has another accepted offer, on this candidate record or one confirmed as its duplicate; withdraw it first',
};

/**
 * FR-014, FR-013: one person converts once at a time (0113). Under the conversion lock, refuses an acceptance or handover
 * for a candidate that is not ACTIVE, or whose person has another accepted offer or a current employment. The refusal
 * names the reason only: the other record may lie outside the caller's scope.
 */
export async function assertConvertible(tx: Queryable, companyId: string, candidateId: string, offerId: string): Promise<void> {
  await lockConversion(tx, companyId);
  const block = (await tx.query<{ block: string | null }>(`select hrms_candidate_conversion_block($1, $2, $3) as block`, [companyId, candidateId, offerId])).rows[0]?.block;
  if (block) throw new HttpError(409, block, CONVERSION_BLOCKS[block]);
}

export const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function requireDate(value: string, field: string): string {
  if (!isIsoDate(value)) throw new HttpError(422, 'INVALID_DATE', 'The date is not a valid calendar date', { field });
  return value;
}

/** Trimmed, non-empty, de-duplicated (case-insensitively, first spelling kept) skill labels. */
export function cleanSkills(skills: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of skills ?? []) {
    const s = raw.trim().replace(/\s+/g, ' ');
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function requireText(value: string | undefined | null, field: string, code = 'FIELD_REQUIRED'): string {
  const v = value?.trim();
  if (!v) throw new HttpError(422, code, `${field} is required`, { field });
  return v;
}

export function checkVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
}

/**
 * Whether the user in `user` holds a permission in an active, effective assignment of the company (role ceiling and
 * allowlist). Every argument is an SQL expression (a placeholder or a qualified column).
 */
export const holdsPermissionSql = (company: string, user: string, resource: string, action: string, fieldGroup: string) => `exists (
  select 1 from role_assignment hra
    join user_account hu on hu.id = hra.user_id and hu.active
    join role hr on hr.company_id = hra.company_id and hr.id = hra.role_id and hr.active
    join permission hp on hp.resource = ${resource} and hp.action = ${action} and hp.field_group = ${fieldGroup}
    join role_permission hrp on hrp.company_id = hra.company_id and hrp.role_id = hra.role_id and hrp.permission_id = hp.id and hrp.effect = 'ALLOW'
    join role_assignment_permission hrap on hrap.company_id = hra.company_id and hrap.role_assignment_id = hra.id and hrap.permission_id = hp.id and hrap.active
         and hrap.effective_from <= now() and (hrap.effective_to is null or hrap.effective_to > now())
   where hra.company_id = ${company} and hra.user_id = ${user} and hra.state = 'ACTIVE'
     and hra.effective_from <= now() and (hra.effective_to is null or hra.effective_to > now()))`;

/** A user who holds a permission in an active, effective assignment of the company (role ceiling and allowlist). */
export async function holdsPermission(tx: Queryable, companyId: string, userId: string, key: { resource: string; action: string; fieldGroup: string }): Promise<boolean> {
  const row = (
    await tx.query<{ ok: boolean }>(`select ${holdsPermissionSql('$1::uuid', '$2::uuid', '$3', '$4', '$5')} as ok`, [companyId, userId, key.resource, key.action, key.fieldGroup])
  ).rows[0];
  return row?.ok === true;
}

/**
 * Operational identity (employee code and name, DF02) of the user held in `user`, as linked on the company business
 * date of the instant `at`; null when `user` is null. Placed only next to user ids the caller already sees. Every
 * argument is a qualified SQL expression (an unqualified column would resolve inside this subquery).
 */
export const personSql = (company: string, user: string, at = 'now()') =>
  `(case when ${user} is null then null else (
     select json_build_object('userId', ${user}, 'employeeCode', pe.employee_code, 'displayName', pe.display_name)
       from (select hrms_business_date(${company}, coalesce(${at}, now())) as day) pd
       left join user_employee_link pl on pl.company_id = ${company} and pl.user_id = ${user}
            and pl.effective_from <= pd.day and (pl.effective_to is null or pl.effective_to > pd.day)
       left join employee pe on pe.company_id = pl.company_id and pe.id = pl.employee_id) end)`;

// List paging (page/pageSize and total) is shared by every module: db/paging.ts.
export { DEFAULT_PAGE_SIZE, type Paging, pageOf } from '../../db/paging.js';

/** The pending task of a transaction's active approval, if any, with the permission its step decides. */
export async function pendingTaskOf(
  tx: Queryable,
  companyId: string,
  transactionId: string,
): Promise<{ id: string; assignee_user_id: string; sequence: number; resource: string; action: string; field_group: string } | undefined> {
  return (
    await tx.query<{ id: string; assignee_user_id: string; sequence: number; resource: string; action: string; field_group: string }>(
      `select t.id, t.assignee_user_id, s.sequence, p.resource, p.action, p.field_group from approval_instance i
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'PENDING'
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         join permission p on p.id = s.permission_id
        where i.company_id = $1 and i.transaction_id = $2 and i.state = 'ACTIVE' order by t.created_at desc limit 1`,
      [companyId, transactionId],
    )
  ).rows[0];
}

/** Idempotent replay lookup: the task an idempotency key was used for, if it was. */
export async function priorDecisionTask(tx: Queryable, companyId: string, idempotencyKey: string): Promise<string | undefined> {
  return (await tx.query<{ task_id: string }>(`select task_id from approval_decision where company_id = $1 and idempotency_key = $2`, [companyId, idempotencyKey])).rows[0]?.task_id;
}

export async function isPendingTaskOf(tx: Queryable, companyId: string, taskId: string, userId: string): Promise<boolean> {
  const t = await tx.query(`select 1 from approval_task where company_id = $1 and id = $2 and assignee_user_id = $3 and state = 'PENDING'`, [companyId, taskId, userId]);
  return (t.rowCount ?? 0) > 0;
}

/** The transaction of a task assigned to the user, when it belongs to the given kind; anything else reads as missing. */
export async function taskTransaction(tx: Queryable, companyId: string, taskId: string, userId: string, kind: string): Promise<string | undefined> {
  const t = (
    await tx.query<{ transaction_id: string; kind: string }>(
      `select i.transaction_id, i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [companyId, taskId, userId],
    )
  ).rows[0];
  return t && t.kind === kind ? t.transaction_id : undefined;
}

/** Approval history of a transaction: step, decision, decider (operational identity), time and reason. */
export async function decisionHistory(db: Queryable, companyId: string, transactionId: string) {
  return (
    await db.query<{ revision: number; step: number; action: string; decision: string; reason: string | null; decidedAt: Date; decidedBy: { userId: string; employeeCode: string | null; displayName: string | null } }>(
      `select i.transaction_revision as revision, s.sequence as step, p.action, d.decision, d.reason, d.occurred_at as "decidedAt",
              json_build_object('userId', d.actor_user_id, 'employeeCode', e.employee_code, 'displayName', e.display_name) as "decidedBy"
         from approval_instance i
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         join permission p on p.id = s.permission_id
         left join user_employee_link l on l.company_id = d.company_id and l.user_id = d.actor_user_id
              and l.effective_from <= hrms_business_date(d.company_id, d.occurred_at)
              and (l.effective_to is null or l.effective_to > hrms_business_date(d.company_id, d.occurred_at))
         left join employee e on e.company_id = l.company_id and e.id = l.employee_id
        where i.company_id = $1 and i.transaction_id = $2
        order by d.occurred_at, d.id`,
      [companyId, transactionId],
    )
  ).rows;
}

/** Whom a pending task waits for (operational identity only). */
export async function pendingWith(db: Queryable, companyId: string, transactionId: string) {
  return (
    (
      await db.query<{ taskId: string; step: number; action: string; assignee: { userId: string; employeeCode: string | null; displayName: string | null }; assignedAt: Date }>(
        `select t.id as "taskId", s.sequence as step, p.action, t.created_at as "assignedAt",
                json_build_object('userId', t.assignee_user_id, 'employeeCode', e.employee_code, 'displayName', e.display_name) as assignee
           from approval_instance i
           join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'PENDING'
           join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
           join permission p on p.id = s.permission_id
           left join user_employee_link l on l.company_id = t.company_id and l.user_id = t.assignee_user_id
                and l.effective_from <= hrms_business_date(t.company_id, now()) and (l.effective_to is null or l.effective_to > hrms_business_date(t.company_id, now()))
           left join employee e on e.company_id = l.company_id and e.id = l.employee_id
          where i.company_id = $1 and i.transaction_id = $2 and i.state = 'ACTIVE'
          order by t.created_at desc limit 1`,
        [companyId, transactionId],
      )
    ).rows[0] ?? null
  );
}
