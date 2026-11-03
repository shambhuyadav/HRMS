// Flexible confirmation (FR-080, FR-081, FR-082; BR-029, BR-030; DF11; CI17).
// Case: OPEN (planned due date) -> manager recommendation -> REVIEW_PENDING -> independent HR decision ->
// CONFIRMED (actual date set) or back to OPEN (extended / returned / recommendation rejected), or CANCELLED: by HR with a
// reason while the case is live, or when the employee's exit is approved or they separate (DF04, DF11).
// A due date passing never changes state: due/overdue are derived views (BR-030).
// Lock order, the same on every path that moves a case or the employee's status: the employee's row (lifecycle/exit.ts
// holds it while it approves an exit or separates), then the case's transaction, then the case. A decision and an exit
// that cross are therefore strictly ordered: whichever comes second sees what the first committed.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { withStatusSource } from '../employee/status.js';
import { cancelActiveApproval, type Decision, decideTask, lockTransaction, ownersWithoutEligibleReviewer, startApproval } from '../workflow/engine.js';
import { POLICY_LOCK_SQL } from './policies.js';

/** DF11 date rule in SQL: months clamp to month end (31 Jan + 1 month = 28 Feb); days add calendar days. */
const DUE_SQL = (start: string, duration: string, unit: string, inclusive: string) => `
  (case when ${unit} = 'CALENDAR_MONTHS' then (${start} + make_interval(months => ${duration}))::date
        else ${start} + ${duration} end) - case when ${inclusive} then 1 else 0 end`;

/**
 * The employee's status behind their row lock. Lock first, read after: a `for update of e` joined to the status row
 * drops the employee when a concurrent commit has just changed the status (the recheck keeps the old joined row).
 */
async function lockEmployeeStatus(tx: Queryable, companyId: string, employeeId: string): Promise<string | null> {
  await tx.query(`select 1 from employee where company_id = $1 and id = $2 for update`, [companyId, employeeId]);
  return (
    (
      await tx.query<{ status: string }>(
        `select st.code as status from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id where e.company_id = $1 and e.id = $2`,
        [companyId, employeeId],
      )
    ).rows[0]?.status ?? null
  );
}

/** Only an employee on probation has a review to move: refused for one on notice or separated (DF04, FR-081). */
function assertOnProbation(status: string | null): void {
  if (status !== 'ACTIVE_PROBATION') throw new HttpError(409, 'EMPLOYEE_NOT_ON_PROBATION', 'This employee is no longer on probation, so the confirmation review cannot proceed');
}

export async function openConfirmation(tx: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(tx, grant, employeeId))) throw notFound();
  const status = await lockEmployeeStatus(tx, grant.companyId, employeeId);
  await reassertAccess(tx, grant, 'confirmation', 'manage', ['operational']);
  if (status !== 'ACTIVE_PROBATION') throw new HttpError(422, 'RULE_VIOLATION', 'Only employees on probation have a confirmation review');
  const employee = (await tx.query<{ joining_date: string }>(`select joining_date from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId])).rows[0]!;
  // Policy writes hold this lock exclusively, so the policies below are never read while one is changing.
  await tx.query(`select pg_advisory_xact_lock_shared(${POLICY_LOCK_SQL})`, [grant.companyId]);

  // Most specific applicable policy on the start date; ties are ambiguous (BR-029).
  const policies = (
    await tx.query<{ id: string; specificity: number; due: string }>(
      `select p.id, num_nonnulls(p.employment_type_id, p.grade_id, p.location_id) as specificity,
              to_char(${DUE_SQL('e.joining_date', 'p.duration', 'p.duration_unit', 'p.start_day_inclusive')}, 'YYYY-MM-DD') as due
         from confirmation_policy p
         join employee e on e.company_id = p.company_id and e.id = $2
         left join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
               and ea.effective_from <= e.joining_date and (ea.effective_to is null or ea.effective_to > e.joining_date)
        where p.company_id = $1 and p.effective_from <= e.joining_date and (p.effective_to is null or p.effective_to > e.joining_date)
          and (p.employment_type_id is null or p.employment_type_id = e.employment_type_id)
          and (p.grade_id is null or p.grade_id = ea.grade_id)
          and (p.location_id is null or p.location_id = ea.location_id)
        order by specificity desc`,
      [grant.companyId, employeeId],
    )
  ).rows;
  const policy = policies[0];
  if (!policy) throw new HttpError(422, 'POLICY_NOT_FOUND', 'No confirmation policy applies; HR must configure one');
  if (policies[1] && policies[1].specificity === policy.specificity) throw new HttpError(422, 'POLICY_AMBIGUOUS', 'More than one confirmation policy applies equally');

  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by)
       values ($1, 'employee_confirmation', $2, 'OPEN', $3, $3) returning id`,
      [grant.companyId, employeeId, grant.userId],
    )
  ).rows[0]!.id;
  const caseId = (
    await tx.query<{ id: string }>(
      `insert into employee_confirmation (company_id, employee_id, policy_id, transaction_id, start_date, initial_due_date, current_due_date, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $6, 'OPEN', $7, $7) returning id`,
      [grant.companyId, employeeId, policy.id, transactionId, employee.joining_date, policy.due, grant.userId],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'employee_confirmation',
    recordKey: caseId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { employeeId, policyId: policy.id, startDate: employee.joining_date, dueDate: policy.due } },
  });
  return { caseId, dueDate: policy.due };
}

interface CaseRow {
  id: string;
  employee_id: string;
  transaction_id: string;
  start_date: string;
  current_due_date: string;
  extension_count: number;
  max_extensions: number;
  /** Extensions beyond the policy limit authorised by approved exceptions (DF11). */
  extra_extensions: number;
  state: string;
  pending_recommendation: 'CONFIRM' | 'EXTEND' | null;
  pending_effective_date: string | null;
  pending_extension_months: number | null;
  version: number;
}

async function lockCase(tx: Queryable, companyId: string, where: string, value: string): Promise<CaseRow> {
  const row = (
    await tx.query<CaseRow>(
      `select c.id, c.employee_id, c.transaction_id, c.start_date, c.current_due_date, c.extension_count, p.max_extensions, c.extra_extensions, c.state,
              c.pending_recommendation, c.pending_effective_date, c.pending_extension_months, c.version
         from employee_confirmation c join confirmation_policy p on p.company_id = c.company_id and p.id = c.policy_id
        where c.company_id = $1 and c.${where} = $2 for update of c`,
      [companyId, value],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

/** The lock order of a case path that starts from the case: the employee's row (with their status), the transaction, the case. */
async function lockEmployeeAndCase(tx: Queryable, companyId: string, caseId: string): Promise<{ status: string | null; c: CaseRow }> {
  const owner = (
    await tx.query<{ employee_id: string; transaction_id: string }>(`select employee_id, transaction_id from employee_confirmation where company_id = $1 and id = $2`, [companyId, caseId])
  ).rows[0];
  if (!owner) throw notFound();
  const status = await lockEmployeeStatus(tx, companyId, owner.employee_id);
  await lockTransaction(tx, owner.transaction_id);
  return { status, c: await lockCase(tx, companyId, 'id', caseId) };
}

const isLive = (state: string): boolean => state === 'OPEN' || state === 'REVIEW_PENDING';

/**
 * Ends a live case (DF11 "Confirmed/cancelled closes the active task"): its active approval and pending task are
 * cancelled, the recommendation under review is dropped from the case (the audit before-values and its own RECOMMEND
 * audit record keep it) and no reminder follows (BR-031). The reason is private (the confirmation `reason` group).
 */
async function closeCase(
  tx: Queryable,
  actor: { companyId: string; userId: string; assignmentId: string | null },
  c: CaseRow,
  reason: string,
  detail: Record<string, string> = {},
): Promise<void> {
  await cancelActiveApproval(tx, actor.companyId, c.transaction_id, actor.userId);
  await tx.query(`update business_transaction set state = 'CANCELLED', updated_by = $3 where company_id = $1 and id = $2`, [actor.companyId, c.transaction_id, actor.userId]);
  await tx.query(
    `update employee_confirmation
        set state = 'CANCELLED', cancelled_at = now(), cancelled_by = $3, cancel_reason = $4,
            pending_recommendation = null, pending_effective_date = null, pending_extension_months = null, updated_by = $3
      where company_id = $1 and id = $2`,
    [actor.companyId, c.id, actor.userId, reason],
  );
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource: 'employee_confirmation',
    recordKey: c.id,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action: 'CANCEL',
    priorVersion: c.version,
    before: { operational: { state: c.state, dueDate: c.current_due_date, recommendation: c.pending_recommendation, effectiveDate: c.pending_effective_date, extensionMonths: c.pending_extension_months } },
    after: { operational: { state: 'CANCELLED', ...detail } },
    reason,
  });
  await enqueueEvent(tx, {
    companyId: actor.companyId,
    topic: 'confirmation.decided',
    aggregateId: c.id,
    dedupeKey: `confirmation.decided:${c.id}:CANCELLED`,
    payload: { caseId: c.id, outcome: 'CANCELLED' },
  });
}

/** HR cancels a live review with a reason (FR-082, DF11); the employee status and the planned dates stay as they were. */
export async function cancelConfirmation(tx: Queryable, grant: AccessGrant, caseId: string, input: { expectedVersion: number; reason: string }) {
  const reason = input.reason.trim();
  if (!reason) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the review is cancelled');
  const { c } = await lockEmployeeAndCase(tx, grant.companyId, caseId);
  // Closing a review ends an approval in flight: the duty is checked again after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'confirmation', 'manage', ['operational']);
  if (!(await canAccessEmployee(tx, grant, c.employee_id))) throw notFound();
  if (grant.linkedEmployeeId === c.employee_id) throw new HttpError(403, 'SELF_ACTION', 'You cannot cancel your own confirmation review');
  if (c.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (!isLive(c.state)) throw new HttpError(409, 'INVALID_STATE', 'Only a review that is open or waiting for an HR decision can be cancelled');
  await closeCase(tx, grant, c, reason);
  return { caseId: c.id, state: 'CANCELLED' };
}

const EXIT_CLOSURE_REASON = {
  EXIT_APPROVED: 'Closed automatically: the employee’s exit was approved',
  SEPARATED: 'Closed automatically: the employee separated',
} as const;

/**
 * DF04/DF11: an approved exit or a separation ends the probation review: a live case closes with its active approval, in
 * the exit's transaction. The caller holds the employee's row lock, so no recommendation, decision or cancellation can
 * cross. An approved withdrawal does not reopen the case (the BRD sets no such rule): HR sees the restored probationer on
 * the attention list (CASE_NOT_OPENED) and may open a new case.
 */
export async function closeConfirmationForExit(
  tx: Queryable,
  actor: { companyId: string; userId: string; assignmentId: string | null },
  employeeId: string,
  cause: keyof typeof EXIT_CLOSURE_REASON,
  exitCaseId: string,
): Promise<void> {
  const live = (
    await tx.query<{ id: string; transaction_id: string }>(`select id, transaction_id from employee_confirmation where company_id = $1 and employee_id = $2 and state in ('OPEN', 'REVIEW_PENDING')`, [
      actor.companyId,
      employeeId,
    ])
  ).rows[0];
  if (!live) return;
  await lockTransaction(tx, live.transaction_id);
  await closeCase(tx, actor, await lockCase(tx, actor.companyId, 'id', live.id), EXIT_CLOSURE_REASON[cause], { cause, exitCaseId });
}

export interface Recommendation {
  expectedVersion: number;
  recommendation: 'CONFIRM' | 'EXTEND';
  effectiveDate?: string | undefined;
  extensionMonths?: number | undefined;
  reason: string;
}

export async function recommend(tx: Queryable, grant: AccessGrant, caseId: string, input: Recommendation) {
  const { status, c } = await lockEmployeeAndCase(tx, grant.companyId, caseId);
  await reassertAccess(tx, grant, 'confirmation', 'recommend', ['operational']);
  if (!(await canAccessEmployee(tx, grant, c.employee_id))) throw notFound();
  // DF11: the recommendation comes from the employee's current direct manager.
  const isManager = (
    await tx.query<{ ok: boolean }>(
      `select exists (select 1 from manager_assignment where company_id = $1 and employee_id = $2 and manager_employee_id = $3
                        and effective_from <= hrms_business_date($1, now()) and (effective_to is null or effective_to > hrms_business_date($1, now()))) as ok`,
      [grant.companyId, c.employee_id, grant.linkedEmployeeId],
    )
  ).rows[0]!.ok;
  if (!grant.linkedEmployeeId || !isManager) throw new HttpError(403, 'FORBIDDEN', 'Only the current direct manager can recommend');
  assertOnProbation(status);
  if (c.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (c.state !== 'OPEN') throw new HttpError(409, 'INVALID_STATE', c.state === 'REVIEW_PENDING' ? 'A recommendation is already under review' : 'This confirmation review is closed');
  if (input.recommendation === 'CONFIRM' && !input.effectiveDate) throw new HttpError(422, 'RULE_VIOLATION', 'A confirmation recommendation needs an effective date');
  if (input.recommendation === 'EXTEND' && c.extension_count >= c.max_extensions + c.extra_extensions) {
    throw new HttpError(422, 'EXTENSION_LIMIT_REACHED', 'The maximum number of extensions has been reached; an exception approval is required');
  }

  // Each recommendation is a new submitted revision with its own approval instance (CI02).
  await tx.query(`update business_transaction set revision = revision + 1, state = 'REVIEW_PENDING', updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    c.transaction_id,
    grant.userId,
  ]);
  await tx.query(
    `update employee_confirmation set state = 'REVIEW_PENDING', pending_recommendation = $3, pending_effective_date = $4,
            pending_extension_months = $5, updated_by = $6 where company_id = $1 and id = $2`,
    [grant.companyId, c.id, input.recommendation, input.recommendation === 'CONFIRM' ? input.effectiveDate : null, input.recommendation === 'EXTEND' ? (input.extensionMonths ?? 1) : null, grant.userId],
  );
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: 'employee_confirmation',
    transactionId: c.transaction_id,
    ownerEmployeeId: c.employee_id,
    actorUserId: grant.userId,
  });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'employee_confirmation',
    recordKey: c.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'RECOMMEND',
    priorVersion: c.version,
    after: { operational: { recommendation: input.recommendation, effectiveDate: input.effectiveDate ?? null, extensionMonths: input.extensionMonths ?? null } },
    reason: input.reason,
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'confirmation.recommended',
    aggregateId: c.id,
    dedupeKey: `confirmation.recommended:${c.id}:${c.version}`,
    payload: { caseId: c.id, taskId },
  });
  return { caseId: c.id, taskId, state: 'REVIEW_PENDING' };
}

export async function decideConfirmation(
  tx: Queryable,
  grant: AccessGrant,
  taskId: string,
  input: { decision: Decision; reason: string; idempotencyKey: string },
) {
  // The employee's row first (see the lock order above): the task's approval is locked inside decideTask.
  const owner = (
    await tx.query<{ employee_id: string }>(
      `select c.employee_id from approval_task t
         join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
         join employee_confirmation c on c.company_id = i.company_id and c.transaction_id = i.transaction_id
        where t.company_id = $1 and t.id = $2`,
      [grant.companyId, taskId],
    )
  ).rows[0];
  const status = owner ? await lockEmployeeStatus(tx, grant.companyId, owner.employee_id) : null;
  const result = await decideTask(tx, { grant, taskId, ...input, permission: { resource: 'confirmation', action: 'decide' } });
  const c = await lockCase(tx, grant.companyId, 'transaction_id', result.transactionId);
  if (result.replayed) return { caseId: c.id, state: c.state, dueDate: c.current_due_date, replayed: true };
  // decideTask has checked the decider's row scope; an ASSIGNED decider's task is no longer pending here.
  // Never overwrites NOTICE or a separated status with ACTIVE_CONFIRMED; the refusal rolls the decision back.
  assertOnProbation(status);
  if (result.outcome === 'NEXT_STEP') return { caseId: c.id, state: c.state, dueDate: c.current_due_date, replayed: false };

  const decisionId = (
    await tx.query<{ id: string }>(`select id from approval_decision where company_id = $1 and idempotency_key = $2`, [grant.companyId, input.idempotencyKey])
  ).rows[0]!.id;
  const businessDate = (await tx.query<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [grant.companyId])).rows[0]!.d;

  let action: 'CONFIRMED' | 'EXTENDED' | 'RETURNED' | 'REJECTED_RECOMMENDATION';
  let newDue = c.current_due_date;
  let actual: string | null = null;
  if (result.outcome === 'APPROVED' && c.pending_recommendation === 'CONFIRM') {
    actual = c.pending_effective_date!;
    // BR-030: not before joining; not later than the decision date (early confirmation is allowed with a reason).
    if (actual < c.start_date || actual > businessDate) {
      throw new HttpError(422, 'RULE_VIOLATION', 'Confirmation date must be between the joining date and the decision date');
    }
    action = 'CONFIRMED';
  } else if (result.outcome === 'APPROVED') {
    newDue = (
      await tx.query<{ d: string }>(`select to_char(($1::date + make_interval(months => $2))::date, 'YYYY-MM-DD') as d`, [c.current_due_date, c.pending_extension_months])
    ).rows[0]!.d;
    action = 'EXTENDED';
  } else {
    action = result.outcome === 'RETURNED' ? 'RETURNED' : 'REJECTED_RECOMMENDATION';
  }

  const state = action === 'CONFIRMED' ? 'CONFIRMED' : 'OPEN';
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, c.transaction_id, state, grant.userId]);
  await tx.query(
    `update employee_confirmation
        set state = $3, current_due_date = $4, actual_confirmation_date = $5, last_outcome = $6,
            extension_count = extension_count + case when $6 = 'EXTENDED' then 1 else 0 end,
            pending_recommendation = null, pending_effective_date = null, pending_extension_months = null, updated_by = $7
      where company_id = $1 and id = $2`,
    [grant.companyId, c.id, state, newDue, actual, action, grant.userId],
  );
  await tx.query(
    `insert into confirmation_action (company_id, confirmation_id, employee_id, approval_decision_id, action, prior_due_date, new_due_date,
                                      actual_confirmation_date, reason, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)`,
    [grant.companyId, c.id, c.employee_id, decisionId, action, c.current_due_date, newDue, actual, input.reason.trim(), grant.userId],
  );
  if (action === 'CONFIRMED') {
    // FR-081: the employee record changes only through this approved decision. Payroll eligibility is untouched.
    await withStatusSource(tx, { kind: 'CONFIRMATION', effectiveDate: actual!, sourceId: c.id }, () =>
      tx.query(
        `update employee set confirmation_date = $3, updated_by = $4,
                status_id = (select id from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' and code = 'ACTIVE_CONFIRMED')
          where company_id = $1 and id = $2`,
        [grant.companyId, c.employee_id, actual, grant.userId],
      ),
    );
  }
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'employee_confirmation',
    recordKey: c.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    priorVersion: c.version,
    before: { operational: { state: c.state, dueDate: c.current_due_date } },
    after: { operational: { state, dueDate: newDue, actualConfirmationDate: actual } },
    reason: input.reason,
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'confirmation.decided',
    aggregateId: c.id,
    dedupeKey: `confirmation.decided:${c.id}:${decisionId}`,
    payload: { caseId: c.id, outcome: action },
  });
  return { caseId: c.id, state, action, dueDate: newDue, actualConfirmationDate: actual, replayed: false };
}

export type ConfirmationView = 'UPCOMING' | 'DUE' | 'OVERDUE' | 'EXTENDED' | 'CONFIRMED' | 'ALL' | 'DUE_WITHIN_30';

/**
 * One row shape for the list and the detail: the case under the caller's row scope, with its FR-082 view
 * derived from the company business date (views never change a case). `extended` marks a live case whose
 * due date was extended at least once; it overlaps the date views, so EXTENDED is a filter of its own. A live case left
 * over from before exits closed them, of an employee no longer on probation, is not due: it shows under All as
 * NOT_ON_PROBATION until HR cancels it. A granted `reason` group also carries the private cancellation reason.
 * `extra` narrows the inner query.
 */
function caseQuery(grant: AccessGrant, params: SqlParams, extra = ''): string {
  const scope = employeeScopePredicate(grant, { company: 'c.company_id', employee: 'c.employee_id' }, params);
  return `with d as (select hrms_business_date(${params.add(grant.companyId)}::uuid, now()) as today)
     select * from (
       select c.id, c.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
              c.start_date as "startDate", c.initial_due_date as "initialDueDate", c.current_due_date as "dueDate",
              c.extension_count as "extensionCount", c.actual_confirmation_date as "actualConfirmationDate",
              c.state, c.last_outcome as "lastOutcome", c.version, c.cancelled_at as "cancelledAt",
              ${grant.allowedFieldGroups.includes('reason') ? 'c.cancel_reason as "cancelReason",' : ''}
              (c.state in ('OPEN', 'REVIEW_PENDING') and c.extension_count > 0 and st.code = 'ACTIVE_PROBATION') as extended,
              case when c.state = 'CONFIRMED' then 'CONFIRMED'
                   when c.state = 'CANCELLED' then 'CANCELLED'
                   when st.code <> 'ACTIVE_PROBATION' then 'NOT_ON_PROBATION'
                   when c.current_due_date < d.today then 'OVERDUE'
                   when c.current_due_date = d.today then 'DUE'
                   when c.current_due_date <= d.today + 30 then 'UPCOMING'
                   else 'LATER' end as "view"
         from d, employee_confirmation c
         join employee e on e.company_id = c.company_id and e.id = c.employee_id
         join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where ${scope} ${extra}) x`;
}

/**
 * FR-082 views over the caller's scope. DUE_WITHIN_30 is the dashboard's "Confirmation due within 30 days" (F2): every live
 * case of a probationer due within 30 days, overdue ones included.
 */
export async function listConfirmations(db: Queryable, grant: AccessGrant, view: ConfirmationView) {
  const params = new SqlParams();
  const base = caseQuery(grant, params);
  const rows = await db.query(
    `${base}
      where ${params.add(view)}::text = 'ALL' or "view" = ${params.add(view)}::text or (${params.add(view)}::text = 'EXTENDED' and extended)
         or (${params.add(view)}::text = 'DUE_WITHIN_30' and "view" in ('OVERDUE', 'DUE', 'UPCOMING'))
      order by "dueDate", "employeeCode"`,
    params.values,
  );
  return { view, items: rows.rows, total: rows.rowCount ?? 0 };
}

export type AttentionIssue = 'POLICY_NOT_FOUND' | 'POLICY_AMBIGUOUS' | 'CASE_NOT_OPENED' | 'MANAGER_MISSING' | 'REVIEWER_MISSING';

/** Technical bound on the candidates one attention list examines (not a business rule); `truncated` says when more exist. */
export const ATTENTION_SCAN_LIMIT = 10_000;

/**
 * FR-082 / DF11 "missing policy or reviewer is reported for HR review, not auto-resolved": probationers in the
 * caller's row scope without a live or confirmed case (no applicable policy, more than one equally specific
 * policy, or a policy but no case opened yet), and open cases that cannot move: no current direct manager to
 * recommend, or no eligible HR reviewer on the confirmation route (the recommendation would be refused). Read
 * only: nothing is opened, assigned or changed here.
 */
export async function attentionList(db: Queryable, grant: AccessGrant) {
  const params = new SqlParams();
  const company = params.add(grant.companyId);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const specificity = 'num_nonnulls(p.employment_type_id, p.grade_id, p.location_id)';
  const rows = (
    await db.query<{
      employeeId: string;
      employeeCode: string;
      employeeName: string;
      joiningDate: string;
      caseId: string | null;
      state: string | null;
      policies: number;
      hasManager: boolean;
    }>(
      `with d as (select hrms_business_date(${company}::uuid, now()) as day)
       select e.id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
              to_char(e.joining_date, 'YYYY-MM-DD') as "joiningDate", c.id as "caseId", c.state,
              coalesce(pol.n, 0) as policies,
              exists (select 1 from manager_assignment ma
                        join employee m on m.company_id = ma.company_id and m.id = ma.manager_employee_id
                        join reference_value ms on ms.company_id = m.company_id and ms.id = m.status_id
                                               and ms.code in ('ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE')
                        join user_employee_link l on l.company_id = ma.company_id and l.employee_id = ma.manager_employee_id
                                                 and l.effective_from <= d.day and (l.effective_to is null or l.effective_to > d.day)
                       where ma.company_id = e.company_id and ma.employee_id = e.id
                         and ma.effective_from <= d.day and (ma.effective_to is null or ma.effective_to > d.day)) as "hasManager"
         from d, employee e
         join reference_value st on st.company_id = e.company_id and st.id = e.status_id and st.code = 'ACTIVE_PROBATION'
         left join employee_confirmation c on c.company_id = e.company_id and c.employee_id = e.id and c.state in ('OPEN', 'REVIEW_PENDING')
         left join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
               and ea.effective_from <= e.joining_date and (ea.effective_to is null or ea.effective_to > e.joining_date)
         left join lateral (
           -- The same applicable-policy rule as openConfirmation: the most specific policy on the start date.
           select count(*)::int as n from (
             select ${specificity} as s, max(${specificity}) over () as top
               from confirmation_policy p
              where p.company_id = e.company_id and p.effective_from <= e.joining_date and (p.effective_to is null or p.effective_to > e.joining_date)
                and (p.employment_type_id is null or p.employment_type_id = e.employment_type_id)
                and (p.grade_id is null or p.grade_id = ea.grade_id)
                and (p.location_id is null or p.location_id = ea.location_id)) q
            where q.s = q.top) pol on true
        where ${scope} and (c.id is null or c.state = 'OPEN')
          and not exists (select 1 from employee_confirmation x where x.company_id = e.company_id and x.employee_id = e.id and x.state = 'CONFIRMED')
        order by e.employee_code
        limit ${params.add(ATTENTION_SCAN_LIMIT + 1)}`,
      params.values,
    )
  ).rows;
  const truncated = rows.length > ATTENTION_SCAN_LIMIT;
  const candidates = rows.slice(0, ATTENTION_SCAN_LIMIT);
  // A recommendation starts the HR step; where no listed reviewer could take it, the manager would be refused.
  const noReviewer = await ownersWithoutEligibleReviewer(
    db,
    grant.companyId,
    'employee_confirmation',
    candidates.filter((r) => r.caseId).map((r) => r.employeeId),
  );

  const items: (Omit<(typeof rows)[number], 'policies' | 'hasManager'> & { issues: AttentionIssue[] })[] = [];
  for (const { policies, hasManager, ...item } of candidates) {
    const issues: AttentionIssue[] = [];
    if (!item.caseId) {
      issues.push(policies === 0 ? 'POLICY_NOT_FOUND' : policies > 1 ? 'POLICY_AMBIGUOUS' : 'CASE_NOT_OPENED');
    } else {
      if (!hasManager) issues.push('MANAGER_MISSING');
      if (noReviewer.has(item.employeeId)) issues.push('REVIEWER_MISSING');
    }
    if (issues.length > 0) items.push({ ...item, issues });
  }
  return { items, total: items.length, truncated };
}

/** One case by id: a single scoped query (out of scope or another company reads as not found). */
export async function getConfirmation(db: Queryable, grant: AccessGrant, caseId: string) {
  const params = new SqlParams();
  const base = caseQuery(grant, params, `and c.id = ${params.add(caseId)}::uuid`);
  const item = (await db.query(base, params.values)).rows[0];
  if (!item) throw notFound();
  // DF02/DF11: recommendation and decision reasons are private; only a granted `reason` group sees them.
  const withReason = grant.allowedFieldGroups.includes('reason');
  const actions = await db.query(
    `select action, prior_due_date as "priorDueDate", new_due_date as "newDueDate", actual_confirmation_date as "actualConfirmationDate",
            ${withReason ? 'reason, ' : ''}occurred_at as "occurredAt"
       from confirmation_action where company_id = $1 and confirmation_id = $2 order by occurred_at`,
    [grant.companyId, caseId],
  );
  return { ...item, actions: actions.rows };
}
