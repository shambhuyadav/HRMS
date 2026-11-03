// Manager rating and independent review (F1; FR-043; DF03; C4). Step 1 of the appraisal route is the rating: its
// assignee (the current direct manager, or an eligible HR reviewer from the explicit list when the manager is
// ineligible) scores each goal 1..5 inside the manager-rating window or an authorised exception, then submits the
// rating (APPROVE) or returns the appraisal to the employee (RETURN). Submitting the rating stores the F1 weighted
// manager result sum(weight x manager score)/100 exactly. Step 2 is reviewer level 1: an eligible reviewer from the
// explicit list who did not rate this revision confirms or returns it. Where the cycle set two levels explicitly
// (pinned on the revision), level 1's confirmation opens the second-review route, whose reviewer is neither the rater
// nor the level-1 reviewer. The final confirmation completes the appraisal with the confirmed result. A return closes
// the revision and opens the next one with the employee's self-entry carried over; the employee revises and resubmits
// it (F1 "returns create revision"). Rejection is not offered: an appraisal is completed or cancelled by HR.
import { enqueueEvent } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import { appraisalView, staffScope } from './appraisals.js';
import {
  activeGoals,
  APPRAISAL_KIND,
  type AppraisalRow,
  audit,
  checkVersion,
  loadCycle,
  lockAppraisal,
  lockAppraisalByTransaction,
  optionalText,
  pendingTaskOf,
  pendingTaskStep,
  presentedStep,
  priorDecisionTask,
  requireEntryWindow,
  type RevisionRow,
  SECOND_REVIEW_KIND,
  type SecondReview,
  setAppraisalState,
  setSecondReviewState,
  TASK_KINDS,
  type TaskKind,
  taskTransaction,
  touchAppraisal,
  workingRevision,
} from './common.js';

interface TaskTarget {
  a: AppraisalRow;
  kind: TaskKind;
  secondReview: SecondReview | null;
}

/**
 * The task's appraisal behind its transaction locks (the appraisal's first, then a second review's); a task of someone
 * else, another kind or an employee out of scope reads as missing.
 */
async function lockTaskAppraisal(tx: Queryable, grant: AccessGrant, taskId: string): Promise<TaskTarget> {
  const t = await taskTransaction(tx, grant.companyId, taskId, grant.userId);
  if (!t) throw notFound();
  let a: AppraisalRow | undefined;
  let secondReview: SecondReview | null = null;
  if (t.kind === APPRAISAL_KIND) {
    a = await lockAppraisalByTransaction(tx, grant.companyId, t.transactionId);
  } else {
    const sr = (
      await tx.query<SecondReview & { appraisal_id: string }>(
        `select id, appraisal_id, transaction_id, revision_id, state from appraisal_second_review where company_id = $1 and transaction_id = $2`,
        [grant.companyId, t.transactionId],
      )
    ).rows[0];
    if (!sr) throw notFound();
    a = await lockAppraisal(tx, grant.companyId, sr.appraisal_id);
    await lockTransaction(tx, sr.transaction_id);
    secondReview = (await tx.query<SecondReview>(`select id, transaction_id, revision_id, state from appraisal_second_review where company_id = $1 and id = $2 for update`, [grant.companyId, sr.id]))
      .rows[0]!;
  }
  if (!a || !(await canAccessEmployee(tx, grant, a.employee_id))) throw notFound();
  return { a, kind: t.kind, secondReview };
}

export interface RatingInput {
  entries: { goalId: string; score?: number | null | undefined; comment?: string | null | undefined }[];
  comment?: string | null | undefined;
  expectedVersion: number;
}

/** The rater prepares the manager rating of the submitted revision (partial saves allowed; null clears a score). */
export async function saveRating(tx: Queryable, grant: AccessGrant, taskId: string, input: RatingInput): Promise<string> {
  const { a } = await lockTaskAppraisal(tx, grant, taskId);
  const step = await pendingTaskStep(tx, grant.companyId, taskId, grant.userId);
  if (!step) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (step.step !== 1) throw new HttpError(409, 'NOT_RATING_TASK', 'Only the rating step enters manager scores');
  checkVersion(a.version, input.expectedVersion);
  const rev = await workingRevision(tx, grant.companyId, a, true);
  if (a.state !== 'SUBMITTED' || rev.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'The appraisal is not waiting for a rating');
  const cycle = (await loadCycle(tx, grant.companyId, a.cycle_id))!;
  await requireEntryWindow(tx, grant.companyId, a.id, cycle, 'MANAGER_RATING', grant.businessDate);
  const goals = new Set((await activeGoals(tx, grant.companyId, a.id)).map((g) => g.id));
  const seen = new Set<string>();
  for (const e of input.entries) {
    if (!goals.has(e.goalId)) throw new HttpError(422, 'UNKNOWN_GOAL', 'Every entry must be one of this appraisal’s goals', { goalId: e.goalId });
    if (seen.has(e.goalId)) throw new HttpError(422, 'DUPLICATE_GOAL', 'Each goal is rated once', { goalId: e.goalId });
    seen.add(e.goalId);
  }
  for (const e of input.entries) {
    await tx.query(
      `update appraisal_entry set manager_score = $4, manager_comment = $5, updated_by = $6
        where company_id = $1 and revision_id = $2 and item_id = $3
          and (manager_score is distinct from $4::smallint or manager_comment is distinct from $5::text)`,
      [grant.companyId, rev.id, e.goalId, e.score ?? null, optionalText(e.comment ?? null), grant.userId],
    );
  }
  if (input.comment !== undefined) {
    await tx.query(`update appraisal_revision set manager_comment = $3, updated_by = $4 where company_id = $1 and id = $2 and manager_comment is distinct from $3::text`, [
      grant.companyId,
      rev.id,
      optionalText(input.comment),
      grant.userId,
    ]);
  }
  await touchAppraisal(tx, grant.companyId, a.id, grant.userId);
  const rated = (
    await tx.query<{ n: number }>(
      `select count(*)::int as n from appraisal_entry e join appraisal_item i on i.company_id = e.company_id and i.id = e.item_id and i.active
        where e.company_id = $1 and e.revision_id = $2 and e.manager_score is not null`,
      [grant.companyId, rev.id],
    )
  ).rows[0]!.n;
  // Field names and progress only: the scores and comments never enter the audit trail.
  await audit(tx, grant, 'appraisal', a.id, 'SAVE_RATING', null, { revision: a.revision, goalsRated: rated, goals: goals.size, fields: ['managerScore', 'managerComment'] });
  return a.id;
}

export interface DecisionInput {
  decision: 'APPROVE' | 'RETURN';
  /** The decider's private remark (confidential rating group; never shown to the employee). */
  reason?: string | undefined;
  /** Required to return: what the employee should revise (shown to the employee). */
  employeeMessage?: string | undefined;
  idempotencyKey: string;
}

/** The confirmed revision's weighted result becomes the appraisal's final rating (DB064 final_rating). */
async function complete(tx: Queryable, grant: AccessGrant, a: AppraisalRow, rev: RevisionRow, step: number) {
  await tx.query(`update appraisal_revision set state = 'CONFIRMED', confirmed_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, rev.id, grant.userId]);
  await setAppraisalState(tx, grant.companyId, a, 'APPROVED', grant.userId, ', final_rating = $5::numeric, completed_at = now()', [rev.weighted_result]);
  await audit(tx, grant, 'appraisal', a.id, 'CONFIRM', { state: 'IN_REVIEW', step }, { state: 'APPROVED', revision: a.revision });
  await enqueueEvent(tx, { companyId: grant.companyId, topic: 'appraisal.completed', aggregateId: a.id, dedupeKey: `appraisal.completed:${a.id}`, payload: { appraisalId: a.id, revision: a.revision } });
  return { appraisalId: a.id, state: 'APPROVED', revision: a.revision, replayed: false };
}

/** A return closes the revision as it was and opens the next draft with the employee's self-entry carried over. */
async function returnToEmployee(tx: Queryable, grant: AccessGrant, a: AppraisalRow, rev: RevisionRow, step: number, message: string, remark: string | null) {
  const next = a.revision + 1;
  await tx.query(
    `update appraisal_revision set state = 'RETURNED', returned_by = $3, returned_at = now(), employee_message = $4, updated_by = $3 where company_id = $1 and id = $2`,
    [grant.companyId, rev.id, grant.userId, message],
  );
  const nextRevision = (
    await tx.query<{ id: string }>(
      `insert into appraisal_revision (company_id, appraisal_id, revision, state, self_comment, created_by, updated_by) values ($1, $2, $3, 'DRAFT', $4, $5, $5) returning id`,
      [grant.companyId, a.id, next, rev.self_comment, grant.userId],
    )
  ).rows[0]!.id;
  await tx.query(
    `insert into appraisal_entry (company_id, appraisal_id, revision_id, item_id, self_score, self_comment, created_by, updated_by)
     select e.company_id, e.appraisal_id, $3, e.item_id, e.self_score, e.self_comment, $4, $4
       from appraisal_entry e join appraisal_item i on i.company_id = e.company_id and i.id = e.item_id and i.active
      where e.company_id = $1 and e.revision_id = $2`,
    [grant.companyId, rev.id, nextRevision, grant.userId],
  );
  await setAppraisalState(tx, grant.companyId, a, 'RETURNED', grant.userId, ', revision = $5', [next]);
  await audit(tx, grant, 'appraisal', a.id, 'RETURN', { state: a.state, revision: a.revision, step }, { state: 'RETURNED', revision: next }, remark);
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'appraisal.returned',
    aggregateId: a.id,
    dedupeKey: `appraisal.returned:${a.id}:${a.revision}`,
    payload: { appraisalId: a.id, revision: a.revision },
  });
  return { appraisalId: a.id, state: 'RETURNED', revision: next, replayed: false };
}

export async function decideAppraisal(tx: Queryable, grant: AccessGrant, taskId: string, action: 'rate' | 'confirm', input: DecisionInput) {
  const remark = optionalText(input.reason);
  const message = optionalText(input.employeeMessage);
  if (input.decision === 'RETURN' && !message) throw new HttpError(422, 'EMPLOYEE_MESSAGE_REQUIRED', 'Tell the employee what to revise');
  const { a, kind, secondReview } = await lockTaskAppraisal(tx, grant, taskId);
  const prior = await priorDecisionTask(tx, grant.companyId, input.idempotencyKey);
  if (prior) {
    if (prior !== taskId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another task');
    return { appraisalId: a.id, state: a.state, revision: a.revision, replayed: true };
  }
  const step = await pendingTaskStep(tx, grant.companyId, taskId, grant.userId);
  if (!step) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  const rev = await workingRevision(tx, grant.companyId, a, true);
  const waiting =
    action === 'rate'
      ? a.state === 'SUBMITTED' && rev.state === 'SUBMITTED'
      : a.state === 'IN_REVIEW' && rev.state === 'RATED' && (secondReview === null || (secondReview.revision_id === rev.id && secondReview.state === 'SUBMITTED'));
  if (!waiting) throw new HttpError(409, 'INVALID_STATE', 'The appraisal is not waiting for this decision');

  let weighted: string | null = null;
  if (action === 'rate' && input.decision === 'APPROVE') {
    const cycle = (await loadCycle(tx, grant.companyId, a.cycle_id))!;
    await requireEntryWindow(tx, grant.companyId, a.id, cycle, 'MANAGER_RATING', grant.businessDate);
    // F1: sum(weight x manager score) / 100 in exact numeric arithmetic (whole-number weights: exact at 2 decimals).
    const r = (
      await tx.query<{ unrated: number[]; result: string | null }>(
        `select coalesce(array_agg(i.sequence order by i.sequence) filter (where e.manager_score is null), '{}'::int[]) as unrated,
                (sum(i.weight * e.manager_score)::numeric / 100)::numeric(5, 2)::text as result
           from appraisal_item i
           left join appraisal_entry e on e.company_id = i.company_id and e.item_id = i.id and e.revision_id = $3
          where i.company_id = $1 and i.appraisal_id = $2 and i.active`,
        [grant.companyId, a.id, rev.id],
      )
    ).rows[0]!;
    if (r.unrated.length > 0) throw new HttpError(422, 'RATING_INCOMPLETE', 'Score every goal before submitting the rating', { goals: r.unrated });
    weighted = r.result;
  }

  const result = await decideTask(tx, {
    grant,
    taskId,
    decision: input.decision,
    // A return records a reason (DB rule): the private remark when given, otherwise the message to the employee.
    reason: remark ?? (input.decision === 'RETURN' ? (message ?? undefined) : undefined),
    idempotencyKey: input.idempotencyKey,
    permission: { resource: 'appraisal', action },
  });
  if (result.replayed) return { appraisalId: a.id, state: a.state, revision: a.revision, replayed: true };

  if (result.outcome === 'RETURNED') {
    if (secondReview) await setSecondReviewState(tx, grant.companyId, secondReview, 'RETURNED', grant.userId);
    return returnToEmployee(tx, grant, a, rev, step.step, message!, remark);
  }

  if (result.outcome === 'NEXT_STEP') {
    // The rating was submitted; reviewer level 1 is next on the appraisal route.
    const next = await pendingTaskOf(tx, grant.companyId, [a.transaction_id]);
    await tx.query(
      `update appraisal_revision set state = 'RATED', rated_by = $3, rated_at = now(), weighted_result = $4::numeric, updated_by = $3 where company_id = $1 and id = $2`,
      [grant.companyId, rev.id, grant.userId, weighted],
    );
    await setAppraisalState(tx, grant.companyId, a, 'IN_REVIEW', grant.userId);
    await audit(tx, grant, 'appraisal', a.id, 'RATE', { state: 'SUBMITTED', revision: a.revision }, { state: 'IN_REVIEW', revision: a.revision, step: step.step });
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'appraisal.review_assigned',
      aggregateId: a.id,
      dedupeKey: `appraisal.review_assigned:${a.id}:${a.revision}:1`,
      payload: { appraisalId: a.id, taskId: next?.id ?? null, revision: a.revision, level: 1 },
    });
    return { appraisalId: a.id, state: 'IN_REVIEW', revision: a.revision, pendingStep: next?.step ?? null, replayed: false };
  }

  // APPROVED: a reviewer confirmed.
  if (kind === APPRAISAL_KIND && rev.approval_levels === 2) {
    // F1: the explicitly configured second level, independent of every earlier decider of this revision (C4).
    const deciders = (
      await tx.query<{ u: string }>(
        `select distinct d.actor_user_id as u from approval_instance i
           join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
           join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
          where i.company_id = $1 and i.transaction_id = $2 and i.transaction_revision = $3`,
        [grant.companyId, a.transaction_id, a.revision],
      )
    ).rows.map((r) => r.u);
    const transactionId = (
      await tx.query<{ id: string }>(
        `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'SUBMITTED', $4, $4) returning id`,
        [grant.companyId, SECOND_REVIEW_KIND, a.employee_id, grant.userId],
      )
    ).rows[0]!.id;
    await tx.query(
      `insert into appraisal_second_review (company_id, appraisal_id, employee_id, revision_id, transaction_id, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'SUBMITTED', $6, $6)`,
      [grant.companyId, a.id, a.employee_id, rev.id, transactionId, grant.userId],
    );
    const { taskId: nextTask } = await startApproval(tx, {
      companyId: grant.companyId,
      kind: SECOND_REVIEW_KIND,
      transactionId,
      ownerEmployeeId: a.employee_id,
      actorUserId: grant.userId,
      excludeUserIds: deciders,
    });
    await touchAppraisal(tx, grant.companyId, a.id, grant.userId);
    await audit(tx, grant, 'appraisal', a.id, 'CONFIRM', { state: 'IN_REVIEW', step: step.step }, { state: 'IN_REVIEW', revision: a.revision, nextStep: 3 });
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'appraisal.review_assigned',
      aggregateId: a.id,
      dedupeKey: `appraisal.review_assigned:${a.id}:${a.revision}:2`,
      payload: { appraisalId: a.id, taskId: nextTask, revision: a.revision, level: 2 },
    });
    return { appraisalId: a.id, state: 'IN_REVIEW', revision: a.revision, pendingStep: 3, replayed: false };
  }
  if (secondReview) await setSecondReviewState(tx, grant.companyId, secondReview, 'APPROVED', grant.userId);
  return complete(tx, grant, a, rev, step.step);
}

/** The caller's open appraisal tasks with each appraisal as the caller may see it (rating content needs the grant). */
export async function reviewTasks(db: Queryable, grant: AccessGrant) {
  const tasks = ((await myOpenTasks(db, grant)).items as { taskId: string; kind: string; transactionId: string; assignedAt: Date; step: number }[]).filter((t) => TASK_KINDS.includes(t.kind));
  const items = [];
  for (const t of tasks) {
    const a = (
      await db.query<{ id: string; employee_id: string }>(
        t.kind === APPRAISAL_KIND
          ? `select id, employee_id from appraisal where company_id = $1 and transaction_id = $2`
          : `select a.id, a.employee_id from appraisal_second_review sr join appraisal a on a.company_id = sr.company_id and a.id = sr.appraisal_id where sr.company_id = $1 and sr.transaction_id = $2`,
        [grant.companyId, t.transactionId],
      )
    ).rows[0];
    const visible = a ? await canAccessEmployee(db, grant, a.employee_id) : false;
    const step = presentedStep(t.kind, t.step);
    items.push({
      taskId: t.taskId,
      step,
      stage: step === 1 ? 'MANAGER_RATING' : 'REVIEW',
      level: step === 1 ? null : step - 1,
      assignedAt: t.assignedAt,
      appraisal: a && visible ? await appraisalView(db, grant, a.id, staffScope(grant, a.employee_id)) : null,
    });
  }
  return { items };
}
