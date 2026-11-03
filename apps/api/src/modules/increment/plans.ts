// Employee cycle assignment and review-date overrides (DF15; FR-091; DB102; C4). An employee follows the cycle of their
// plan on a date; an employee without a plan follows the company-default cycle in force (FR-091 company rule). An
// authorised HR user proposes, with a private reason, either an assignment to another cycle from a date or an override
// of the employee's next review date; a different eligible user decides with a reason; neither the proposer nor the
// employee concerned can decide, and nobody proposes for their own plan. An approved change is a new plan revision:
// the revision it replaces is closed on the new start date, or superseded when the new revision covers its whole
// period, and is kept, so approved rows are never edited (DB102 "next due recomputed only through approved action with
// history"). The approved override decides the employee's effective date for that occurrence when its review opens.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { isDate } from './cycles.js';
import { companyDefaultOn, currentPlan, lockEmployeePlan, nextReview, occurrencesOf, type PlanRow } from './schedule.js';

export type PlanChangeKind = 'ASSIGN_CYCLE' | 'REVIEW_DATE_OVERRIDE';

export interface PlanChangeInput {
  kind: PlanChangeKind;
  /** ASSIGN_CYCLE: any revision of the target cycle and the date the assignment starts. */
  cycleId?: string | undefined;
  effectiveFrom?: string | undefined;
  /** REVIEW_DATE_OVERRIDE: the new effective date of the employee's next review. */
  overrideDate?: string | undefined;
  reason: string;
}

interface Assignment {
  cycleId: string;
  code: string;
  nextReviewDate: string;
}

interface Override {
  cycleId: string;
  code: string;
  occurrenceKey: string;
  scheduledDate: string;
  currentDate: string;
}

const ruleViolation = (message: string) => new HttpError(422, 'RULE_VIOLATION', message);

/** Reviews under the current plan start with it: today, or the later day an approved assignment starts. */
const planStart = (plan: PlanRow | undefined, today: string) => (plan && plan.effective_from > today ? plan.effective_from : today);

/**
 * An assignment starts today or later, on a date the target cycle is in force, not before the current plan revision
 * and not before a review of the current cycle that takes effect on or after it; the cycle must have an upcoming review.
 */
async function validateAssignment(tx: Queryable, companyId: string, employeeId: string, plan: PlanRow | undefined, cycleId: string | undefined, effectiveFrom: string | undefined, today: string): Promise<Assignment> {
  if (!cycleId || !effectiveFrom) throw ruleViolation('An assignment needs the cycle and the date it starts');
  if (!isDate(effectiveFrom)) throw new HttpError(400, 'INVALID_VALUE', 'A date or time value is invalid');
  if (effectiveFrom < today) throw ruleViolation('An assignment cannot start in the past');
  const code = (await tx.query<{ code: string }>(`select code from increment_cycle where company_id = $1 and id = $2`, [companyId, cycleId])).rows[0]?.code;
  if (!code) throw notFound();
  const revision = (
    await tx.query<{ id: string }>(
      `select id from increment_cycle where company_id = $1 and code = $2 and active and effective_from <= $3::date and (effective_to is null or effective_to > $3::date)`,
      [companyId, code, effectiveFrom],
    )
  ).rows[0];
  if (!revision) throw new HttpError(422, 'CYCLE_NOT_EFFECTIVE', 'No activated revision of this cycle is in force on that date');
  if (plan) {
    if (effectiveFrom < plan.effective_from) throw new HttpError(409, 'PLAN_CHANGE_CONFLICT', `The current plan starts on ${plan.effective_from}; a new assignment cannot start before it`);
    if (plan.cycle_code === code) throw new HttpError(422, 'NO_CHANGE', 'The employee is already on this cycle');
    const review = (
      await tx.query<{ d: string | null }>(
        `select to_char(max(k.proposed_effective_date), 'YYYY-MM-DD') as d
           from increment_case k join increment_cycle c on c.company_id = k.company_id and c.id = k.cycle_id
          where k.company_id = $1 and k.employee_id = $2 and c.code = $3 and k.proposed_effective_date >= $4::date`,
        [companyId, employeeId, plan.cycle_code, effectiveFrom],
      )
    ).rows[0]!.d;
    if (review) throw new HttpError(409, 'PLAN_CHANGE_CONFLICT', `A review under the current cycle takes effect on ${review}; the new assignment must start after it`);
  } else if ((await companyDefaultOn(tx, companyId, effectiveFrom))?.code === code) {
    throw new HttpError(422, 'NO_CHANGE', 'The employee already follows this cycle as the company default');
  }
  const next = nextReview(await occurrencesOf(tx, companyId, employeeId, code, effectiveFrom), undefined, effectiveFrom);
  if (!next) throw new HttpError(422, 'NO_UPCOMING_OCCURRENCE', 'The cycle has no upcoming review for this employee');
  return { cycleId: revision.id, code, nextReviewDate: next.next.scheduledDate };
}

/**
 * An override replaces the date of the employee's next review (the first occurrence without a case that is still
 * ahead): today or later, different from the current date, and before the review scheduled after it. Setting it back
 * to the scheduled date removes an earlier override.
 */
async function validateOverride(tx: Queryable, companyId: string, employeeId: string, plan: PlanRow | undefined, overrideDate: string | undefined, today: string): Promise<Override> {
  if (!overrideDate) throw ruleViolation('An override needs the new review date');
  if (!isDate(overrideDate)) throw new HttpError(400, 'INVALID_VALUE', 'A date or time value is invalid');
  const code = plan?.cycle_code ?? (await companyDefaultOn(tx, companyId, today))?.code;
  if (!code) throw new HttpError(422, 'NO_CYCLE', 'The employee is not on any increment cycle');
  const from = planStart(plan, today);
  const next = nextReview(await occurrencesOf(tx, companyId, employeeId, code, from), plan, from);
  if (!next) throw new HttpError(422, 'NO_UPCOMING_OCCURRENCE', 'The cycle has no upcoming review for this employee');
  if (overrideDate < from) throw ruleViolation('The review date cannot be in the past or before the current plan starts');
  if (overrideDate === next.next.effectiveDate) throw new HttpError(422, 'NO_CHANGE', 'This is already the date of the next review');
  if (next.following && overrideDate >= next.following.scheduledDate) {
    throw ruleViolation(`The next review must stay before the review scheduled on ${next.following.scheduledDate}`);
  }
  return { cycleId: next.next.cycleId, code, occurrenceKey: next.next.key, scheduledDate: next.next.scheduledDate, currentDate: next.next.effectiveDate };
}

export async function proposePlanChange(tx: Queryable, grant: AccessGrant, employeeId: string, input: PlanChangeInput) {
  if (!(await canAccessEmployee(tx, grant, employeeId))) throw notFound();
  if (grant.linkedEmployeeId === employeeId) throw new HttpError(403, 'SELF_ACTION', 'You cannot propose a change to your own increment plan');
  await lockEmployeePlan(tx, employeeId);
  const open = await tx.query(`select 1 from increment_plan_change where company_id = $1 and employee_id = $2 and state = 'PROPOSED'`, [grant.companyId, employeeId]);
  if ((open.rowCount ?? 0) > 0) throw new HttpError(409, 'OPEN_PROPOSAL_EXISTS', "A change to this employee's plan is already waiting for a decision");
  const plan = await currentPlan(tx, grant.companyId, employeeId);
  const today = grant.businessDate;
  let details: Record<string, string | null>;
  let cycleId: string;
  if (input.kind === 'ASSIGN_CYCLE') {
    const a = await validateAssignment(tx, grant.companyId, employeeId, plan, input.cycleId, input.effectiveFrom, today);
    cycleId = a.cycleId;
    details = { fromCycle: plan?.cycle_code ?? null, toCycle: a.code, effectiveFrom: input.effectiveFrom!, nextReviewDate: a.nextReviewDate };
  } else {
    const o = await validateOverride(tx, grant.companyId, employeeId, plan, input.overrideDate, today);
    cycleId = o.cycleId;
    details = { cycle: o.code, occurrence: o.occurrenceKey, scheduledDate: o.scheduledDate, currentDate: o.currentDate, overrideDate: input.overrideDate! };
  }
  const id = (
    await tx.query<{ id: string }>(
      `insert into increment_plan_change (company_id, employee_id, kind, base_plan_id, cycle_id, effective_from, occurrence_key, scheduled_date,
                                          override_date, reason, proposed_by, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $11) returning id`,
      [
        grant.companyId,
        employeeId,
        input.kind,
        plan?.id ?? null,
        cycleId,
        input.kind === 'ASSIGN_CYCLE' ? input.effectiveFrom : null,
        details.occurrence ?? null,
        details.scheduledDate ?? null,
        input.kind === 'REVIEW_DATE_OVERRIDE' ? input.overrideDate : null,
        input.reason.trim(),
        grant.userId,
      ],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'increment_plan_change',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { employeeId, kind: input.kind, state: 'PROPOSED', ...details } },
    reason: input.reason.trim(),
  });
  return { changeId: id, kind: input.kind, state: 'PROPOSED', ...details };
}

interface ChangeRow {
  id: string;
  employee_id: string;
  kind: PlanChangeKind;
  base_plan_id: string | null;
  cycle_id: string;
  effective_from: string | null;
  occurrence_key: string | null;
  scheduled_date: string | null;
  override_date: string | null;
  reason: string;
  state: string;
  proposed_by: string;
}

async function lockChange(tx: Queryable, grant: AccessGrant, id: string): Promise<ChangeRow> {
  const head = (await tx.query<{ employee_id: string }>(`select employee_id from increment_plan_change where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!head || !(await canAccessEmployee(tx, grant, head.employee_id))) throw notFound();
  await lockEmployeePlan(tx, head.employee_id);
  return (
    await tx.query<ChangeRow>(
      `select id, employee_id, kind, base_plan_id, cycle_id, to_char(effective_from, 'YYYY-MM-DD') as effective_from, occurrence_key,
              to_char(scheduled_date, 'YYYY-MM-DD') as scheduled_date, to_char(override_date, 'YYYY-MM-DD') as override_date, reason, state, proposed_by
         from increment_plan_change where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0]!;
}

/** The new plan revision for an approved assignment: the current revision closes on the start date (or is superseded). */
async function applyAssignment(tx: Queryable, grant: AccessGrant, x: ChangeRow, plan: PlanRow | undefined, a: Assignment): Promise<string> {
  const from = x.effective_from!;
  let supersedes: string | null = null;
  if (plan && plan.effective_from < from) {
    await tx.query(`update employee_increment_plan set effective_to = $3::date, active = false, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, plan.id, from, grant.userId]);
  } else if (plan) {
    await tx.query(`update employee_increment_plan set superseded_at = now(), active = false, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, plan.id, grant.userId]);
    supersedes = plan.id;
  }
  return (
    await tx.query<{ id: string }>(
      `insert into employee_increment_plan (company_id, employee_id, cycle_id, effective_from, next_review_date, supersedes_id, change_id, active, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, true, $8, $8) returning id`,
      [grant.companyId, x.employee_id, a.cycleId, from, a.nextReviewDate, supersedes, x.id, grant.userId],
    )
  ).rows[0]!.id;
}

/**
 * The new plan revision for an approved override: same cycle and period as the revision it supersedes, carrying the
 * override for that occurrence. An employee on the company default gets a plan from the joining date.
 */
async function applyOverride(tx: Queryable, grant: AccessGrant, x: ChangeRow, plan: PlanRow | undefined): Promise<string> {
  const clear = x.override_date === x.scheduled_date;
  if (plan) {
    await tx.query(`update employee_increment_plan set superseded_at = now(), active = false, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, plan.id, grant.userId]);
  }
  return (
    await tx.query<{ id: string }>(
      `insert into employee_increment_plan (company_id, employee_id, cycle_id, effective_from, next_review_date, override_review_date, override_reason,
                                            override_approved_by, override_occurrence_key, supersedes_id, change_id, active, created_by, updated_by)
       select $1, e.id, $3, coalesce($4::date, e.joining_date), $5, $6, $7, $8, $9, $10, $11, true, $12, $12
         from employee e where e.company_id = $1 and e.id = $2
       returning id`,
      [
        grant.companyId,
        x.employee_id,
        plan?.cycle_id ?? x.cycle_id,
        plan?.effective_from ?? null,
        x.scheduled_date,
        clear ? null : x.override_date,
        clear ? null : x.reason,
        clear ? null : grant.userId,
        clear ? null : x.occurrence_key,
        plan?.id ?? null,
        x.id,
        grant.userId,
      ],
    )
  ).rows[0]!.id;
}

/**
 * Independent decision (C4). Approval re-validates the proposal against the plan it was made for: a plan that changed
 * meanwhile, a next review that moved on, or a date that has passed refuses the approval, and nothing is applied.
 */
export async function decidePlanChange(tx: Queryable, grant: AccessGrant, id: string, input: { decision: 'APPROVE' | 'REJECT'; reason: string }) {
  const x = await lockChange(tx, grant, id);
  // A decision outside decideTask re-checks the deciding duty after its locks (I-25).
  await reassertAccess(tx, grant, 'increment_plan', 'approve', ['operational']);
  if (x.state !== 'PROPOSED') throw new HttpError(409, 'INVALID_STATE', 'This proposal has already been decided or withdrawn');
  if (x.proposed_by === grant.userId) throw new HttpError(403, 'INDEPENDENT_APPROVER_REQUIRED', 'Another eligible user must decide your proposal');
  if (grant.linkedEmployeeId === x.employee_id) throw new HttpError(403, 'SELF_ACTION', 'You cannot decide a change to your own increment plan');
  let planId: string | null = null;
  let applied: Record<string, string | null> | null = null;
  if (input.decision === 'APPROVE') {
    const plan = await currentPlan(tx, grant.companyId, x.employee_id);
    if ((plan?.id ?? null) !== x.base_plan_id) {
      throw new HttpError(409, 'STALE_PLAN', "The employee's plan changed after this proposal; withdraw it and propose again");
    }
    if (x.kind === 'ASSIGN_CYCLE') {
      const a = await validateAssignment(tx, grant.companyId, x.employee_id, plan, x.cycle_id, x.effective_from!, grant.businessDate);
      planId = await applyAssignment(tx, grant, x, plan, a);
      applied = { fromCycle: plan?.cycle_code ?? null, toCycle: a.code, effectiveFrom: x.effective_from, nextReviewDate: a.nextReviewDate };
    } else {
      const o = await validateOverride(tx, grant.companyId, x.employee_id, plan, x.override_date!, grant.businessDate);
      if (o.occurrenceKey !== x.occurrence_key) {
        throw new HttpError(409, 'OCCURRENCE_CHANGED', "The employee's next review is no longer the one this override was proposed for; propose again");
      }
      planId = await applyOverride(tx, grant, x, plan);
      applied = { occurrence: x.occurrence_key, scheduledDate: x.scheduled_date, from: o.currentDate, to: x.override_date };
    }
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'employee_increment_plan',
      recordKey: planId,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: x.kind,
      newVersion: 1,
      before: plan ? { operational: { planId: plan.id, cycle: plan.cycle_code, effectiveFrom: plan.effective_from } } : null,
      after: { operational: { employeeId: x.employee_id, changeId: x.id, ...applied } },
    });
  }
  const state = input.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  await tx.query(
    `update increment_plan_change set state = $3, decided_by = $4, decided_at = now(), decision_reason = $5, result_plan_id = $6, updated_by = $4
      where company_id = $1 and id = $2`,
    [grant.companyId, x.id, state, grant.userId, input.reason.trim(), planId],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'increment_plan_change',
    recordKey: x.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.decision,
    before: { operational: { state: 'PROPOSED' } },
    after: { operational: { state, planId } },
    reason: input.reason.trim(),
  });
  return { changeId: x.id, state, planId, applied };
}

export async function withdrawPlanChange(tx: Queryable, grant: AccessGrant, id: string) {
  const x = await lockChange(tx, grant, id);
  if (x.proposed_by !== grant.userId) throw notFound();
  if (x.state !== 'PROPOSED') throw new HttpError(409, 'INVALID_STATE', 'Only a waiting proposal can be withdrawn');
  await tx.query(`update increment_plan_change set state = 'WITHDRAWN', updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, x.id, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'increment_plan_change',
    recordKey: x.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'WITHDRAW',
    before: { operational: { state: 'PROPOSED' } },
    after: { operational: { state: 'WITHDRAWN' } },
  });
  return { changeId: x.id, state: 'WITHDRAWN' };
}

const changeColumns = (withReason: boolean) => `x.id, x.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
  x.kind, x.state, c.code as "cycleCode", x.effective_from as "effectiveFrom", x.occurrence_key as "occurrence",
  x.scheduled_date as "scheduledDate", x.override_date as "overrideDate", x.proposed_by as "proposedBy", x.created_at as "proposedAt",
  x.decided_by as "decidedBy", x.decided_at as "decidedAt", x.result_plan_id as "planId"${withReason ? ', x.reason, x.decision_reason as "decisionReason"' : ''}`;

/**
 * The employee's plan: the cycle followed, the next review (with any approved override), every plan revision kept
 * (closed and superseded ones included) and every change proposal. Reasons need the increment reason grant (DF02).
 */
export async function employeePlan(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const withReason = grant.allowedFieldGroups.includes('reason');
  const today = grant.businessDate;
  const plan = await currentPlan(db, grant.companyId, employeeId);
  const code = plan?.cycle_code ?? (await companyDefaultOn(db, grant.companyId, today))?.code ?? null;
  const from = planStart(plan, today);
  const next = code ? nextReview(await occurrencesOf(db, grant.companyId, employeeId, code, from), plan, from) : null;
  const revisions = await db.query(
    `select p.id, p.cycle_id as "cycleId", c.code as "cycleCode", c.revision as "cycleRevision", p.effective_from as "effectiveFrom",
            p.effective_to as "effectiveTo", p.next_review_date as "nextReviewDate", p.override_review_date as "overrideReviewDate",
            p.override_occurrence_key as "overrideOccurrence", p.override_approved_by as "overrideApprovedBy", p.supersedes_id as "supersedesId",
            p.superseded_at as "supersededAt", p.change_id as "changeId", p.active, p.created_at as "createdAt"
            ${withReason ? ', p.override_reason as "overrideReason"' : ''}
       from employee_increment_plan p join increment_cycle c on c.company_id = p.company_id and c.id = p.cycle_id
      where p.company_id = $1 and p.employee_id = $2 order by p.created_at, p.effective_from`,
    [grant.companyId, employeeId],
  );
  const changes = await db.query(
    `select ${changeColumns(withReason)}
       from increment_plan_change x
       join employee e on e.company_id = x.company_id and e.id = x.employee_id
       join increment_cycle c on c.company_id = x.company_id and c.id = x.cycle_id
      where x.company_id = $1 and x.employee_id = $2 order by x.created_at`,
    [grant.companyId, employeeId],
  );
  return {
    employeeId,
    cycleCode: code,
    assignment: plan ? 'PLAN' : code ? 'COMPANY_DEFAULT' : null,
    nextReview: next
      ? { occurrence: next.next.key, scheduledDate: next.next.scheduledDate, effectiveDate: next.next.effectiveDate, overridden: next.next.overridden }
      : null,
    revisions: revisions.rows,
    changes: changes.rows,
  };
}

/** Proposals waiting for a decision within the caller's row scope; the caller's own proposals are marked. */
export async function pendingPlanChanges(db: Queryable, grant: AccessGrant, withReason: boolean) {
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'x.company_id', employee: 'x.employee_id' }, params);
  const me = params.add(grant.userId);
  const rows = await db.query(
    `select ${changeColumns(withReason)}, x.proposed_by = ${me}::uuid as "ownProposal"
       from increment_plan_change x
       join employee e on e.company_id = x.company_id and e.id = x.employee_id
       join increment_cycle c on c.company_id = x.company_id and c.id = x.cycle_id
      where ${scope} and x.state = 'PROPOSED' order by x.created_at limit 200`,
    params.values,
  );
  return { items: rows.rows };
}
