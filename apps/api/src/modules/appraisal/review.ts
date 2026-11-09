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
//
// Decided under owner delegation, 6 Nov 2026 (owner chose process rules only; I-77):
// * BR-013 / FR-043 "Level 1 completes at manager approval": in a cycle with 0 reviewer levels the route's reviewer step does
//   not apply (condition APPRAISAL_REVIEWER_LEVEL, 0177), so the manager's approval of the rating completes the appraisal.
// * FR-042 manual rating mode: in a MANUAL cycle the rater also enters an overall rating (integer 1..5, the F1 scale), required
//   to submit the rating; it becomes the final rating. Every goal is still scored and the weighted result still kept.
// * FR-043 / DF04 reviewer scores: each reviewer level confirms with one overall score (integer 1..5), required to confirm
//   and kept apart per level; it never changes the final rating (F1: the reviewer confirms; to disagree, they return it).
// * Task due dates (I-40 item 6): the rating task is due when the manager-rating window closes (or a later exception for this
//   appraisal), a reviewer task on the cycle's review due date (0178); the task list says which are overdue.
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
  type CycleRow,
  loadCycle,
  lockAppraisal,
  lockAppraisalByTransaction,
  optionalText,
  pendingTaskOf,
  pendingTaskStep,
  presentedStep,
  priorDecisionTask,
  requireEntryWindow,
  REVIEWER_LEVEL_CONDITION,
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
import { checkCompetencyIds, checkSections, type SectionInput, unfilledSections, writeSections } from './self-entry.js';

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
  /** FR-041 / I-86: the manager's score and comment on each of the appraisal's competencies. */
  competencies?: { competencyId: string; score?: number | null | undefined; comment?: string | null | undefined }[] | undefined;
  /** FR-042: the manager's part of the sections the cycle includes. */
  sections?: SectionInput[] | undefined;
  comment?: string | null | undefined;
  /** MANUAL cycles only: the manager's overall rating (integer 1..5); null clears it. */
  overallRating?: number | null | undefined;
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
  if (input.overallRating !== undefined && cycle.rating_mode !== 'MANUAL') {
    throw new HttpError(422, 'OVERALL_RATING_NOT_USED', 'This cycle rates by the weighted formula: there is no overall rating to enter');
  }
  const goals = new Set((await activeGoals(tx, grant.companyId, a.id)).map((g) => g.id));
  const seen = new Set<string>();
  for (const e of input.entries) {
    if (!goals.has(e.goalId)) throw new HttpError(422, 'UNKNOWN_GOAL', 'Every entry must be one of this appraisal’s goals', { goalId: e.goalId });
    if (seen.has(e.goalId)) throw new HttpError(422, 'DUPLICATE_GOAL', 'Each goal is rated once', { goalId: e.goalId });
    seen.add(e.goalId);
  }
  const competencyInput = input.competencies ?? [];
  await checkCompetencyIds(tx, grant.companyId, a.id, competencyInput.map((k) => k.competencyId));
  checkSections(cycle, input.sections ?? [], 'MANAGER');
  for (const k of competencyInput) {
    await tx.query(
      `update appraisal_competency_entry set manager_score = $4, manager_comment = $5, updated_by = $6
        where company_id = $1 and revision_id = $2 and item_id = $3
          and (manager_score is distinct from $4::smallint or manager_comment is distinct from $5::text)`,
      [grant.companyId, rev.id, k.competencyId, k.score ?? null, optionalText(k.comment ?? null), grant.userId],
    );
  }
  await writeSections(tx, grant.companyId, a.id, rev.id, 'MANAGER', input.sections ?? [], grant.userId);
  if (input.overallRating !== undefined) {
    await tx.query(
      `update appraisal_revision set manager_overall_rating = $3, updated_by = $4 where company_id = $1 and id = $2 and manager_overall_rating is distinct from $3::smallint`,
      [grant.companyId, rev.id, input.overallRating, grant.userId],
    );
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
  await audit(tx, grant, 'appraisal', a.id, 'SAVE_RATING', null, {
    revision: a.revision,
    goalsRated: rated,
    goals: goals.size,
    fields: [
      'managerScore',
      'managerComment',
      ...(input.overallRating !== undefined ? ['managerOverallRating'] : []),
      ...(competencyInput.length > 0 ? ['competencyManagerScore', 'competencyManagerComment'] : []),
      ...(input.sections && input.sections.length > 0 ? ['sectionText'] : []),
    ],
    sections: (input.sections ?? []).map((s) => s.section),
  });
  return a.id;
}

export interface DecisionInput {
  decision: 'APPROVE' | 'RETURN';
  /** The decider's private remark (confidential rating group; never shown to the employee). */
  reason?: string | undefined;
  /** Required to return: what the employee should revise (shown to the employee). */
  employeeMessage?: string | undefined;
  /** A reviewer's overall score (integer 1..5), required to confirm and used nowhere else (FR-043; DF04). */
  reviewerScore?: number | undefined;
  idempotencyKey: string;
}

export interface RatingParts {
  unratedGoals: number[];
  unratedCompetencies: number[];
  /** G = sum(goal weight x manager score) / 100: exact at two decimals (whole-number weights totalling 100). */
  goal: string;
  /** C = sum(competency weight x manager score) / 100, exact at two decimals; null without competencies. */
  competency: string | null;
  /** The cycle's split, pinned on the revision when there are competencies. */
  split: { goalWeightPercent: number; competencyWeightPercent: number } | null;
  /** (goal split x G + competency split x C) / 100, rounded once half up to two decimals; G alone without competencies. */
  weighted: string;
}

/**
 * The I-86 formula in exact numeric arithmetic, from the integer sums: (gp x sum(wg x sg) + cp x sum(wc x sc)) / 10000 has at most
 * four decimals and is rounded once, half up (round() on a positive numeric), to the two decimals F1 displays. Without competencies
 * it is sum(wg x sg) / 100, the F1 result, exact. The database recomputes the parts when the rating is submitted (0231).
 */
export async function ratingParts(db: Queryable, companyId: string, appraisalId: string, revisionId: string, cycle: CycleRow): Promise<RatingParts> {
  const r = (
    await db.query<{ goals: number[]; competencies: number[]; n: number; goal: string | null; competency: string | null; weighted: string | null }>(
      `with g as (select coalesce(array_agg(i.sequence order by i.sequence) filter (where e.manager_score is null), '{}'::int[]) as unrated,
                         sum(i.weight * e.manager_score) as total
                    from appraisal_item i
                    left join appraisal_entry e on e.company_id = i.company_id and e.item_id = i.id and e.revision_id = $3
                   where i.company_id = $1 and i.appraisal_id = $2 and i.active),
            k as (select coalesce(array_agg(ci.sequence order by ci.sequence) filter (where ce.manager_score is null), '{}'::int[]) as unrated,
                         count(*)::int as n, sum(ci.weight * ce.manager_score) as total
                    from appraisal_competency_item ci
                    left join appraisal_competency_entry ce on ce.company_id = ci.company_id and ce.item_id = ci.id and ce.revision_id = $3
                   where ci.company_id = $1 and ci.appraisal_id = $2)
       select g.unrated as goals, k.unrated as competencies, k.n,
              (g.total::numeric / 100)::numeric(5, 2)::text as goal,
              case when k.n > 0 then (k.total::numeric / 100)::numeric(5, 2)::text end as competency,
              case when k.n > 0 then round(($4::int * g.total + $5::int * k.total)::numeric / 10000, 2)::numeric(5, 2)::text
                   else (g.total::numeric / 100)::numeric(5, 2)::text end as weighted
         from g, k`,
      [companyId, appraisalId, revisionId, cycle.goal_weight_percent, cycle.competency_weight_percent],
    )
  ).rows[0]!;
  return {
    unratedGoals: r.goals,
    unratedCompetencies: r.competencies,
    goal: r.goal ?? '',
    competency: r.competency,
    split: r.n > 0 ? { goalWeightPercent: cycle.goal_weight_percent, competencyWeightPercent: cycle.competency_weight_percent } : null,
    weighted: r.weighted ?? '',
  };
}

/** The final rating of a rated revision: the weighted manager result, or in a MANUAL cycle the manager's overall rating. */
const finalRatingOf = (cycle: CycleRow, weighted: string | null, overall: number | null): string | null =>
  cycle.rating_mode === 'MANUAL' ? (overall === null ? null : String(overall)) : weighted;

/** The confirmed revision's result becomes the appraisal's final rating (DB064 final_rating). */
async function complete(tx: Queryable, grant: AccessGrant, a: AppraisalRow, rev: RevisionRow, step: number, finalRating: string | null, action: 'CONFIRM' | 'RATE' = 'CONFIRM') {
  await tx.query(`update appraisal_revision set state = 'CONFIRMED', confirmed_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, rev.id, grant.userId]);
  await setAppraisalState(tx, grant.companyId, a, 'APPROVED', grant.userId, ', final_rating = $5::numeric, completed_at = now()', [finalRating]);
  await audit(tx, grant, 'appraisal', a.id, action, { state: a.state, revision: a.revision, step }, { state: 'APPROVED', revision: a.revision });
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
  // FR-041 / FR-042 (I-86): the competency self-scores and the employee's section texts are carried over too.
  await tx.query(
    `insert into appraisal_competency_entry (company_id, appraisal_id, revision_id, item_id, self_score, self_comment, created_by, updated_by)
     select e.company_id, e.appraisal_id, $3, e.item_id, e.self_score, e.self_comment, $4, $4
       from appraisal_competency_entry e where e.company_id = $1 and e.revision_id = $2`,
    [grant.companyId, rev.id, nextRevision, grant.userId],
  );
  await tx.query(
    `insert into appraisal_section_entry (company_id, appraisal_id, revision_id, section, party, body, created_by, updated_by)
     select e.company_id, e.appraisal_id, $3, e.section, e.party, e.body, $4, $4
       from appraisal_section_entry e
       join appraisal a on a.company_id = e.company_id and a.id = e.appraisal_id
       join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
      where e.company_id = $1 and e.revision_id = $2 and e.party = 'EMPLOYEE' and e.section = any (c.sections)`,
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
  // FR-043 / DF04: a reviewer confirms with an overall score; nobody else gives one, and a return is not a score.
  const confirming = action === 'confirm' && input.decision === 'APPROVE';
  if (confirming && input.reviewerScore === undefined) throw new HttpError(422, 'REVIEWER_SCORE_REQUIRED', 'Give your overall score (1 to 5) with the confirmation');
  if (!confirming && input.reviewerScore !== undefined) throw new HttpError(422, 'REVIEWER_SCORE_NOT_USED', 'Only a reviewer confirming the rating gives a reviewer score');
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
  const cycle = (await loadCycle(tx, grant.companyId, a.cycle_id))!;

  let weighted: string | null = null;
  let parts: RatingParts | null = null;
  if (action === 'rate' && input.decision === 'APPROVE') {
    await requireEntryWindow(tx, grant.companyId, a.id, cycle, 'MANAGER_RATING', grant.businessDate);
    const r = await ratingParts(tx, grant.companyId, a.id, rev.id, cycle);
    const sections = await unfilledSections(tx, grant.companyId, rev.id, cycle, 'MANAGER');
    if (r.unratedGoals.length + r.unratedCompetencies.length + sections.length > 0) {
      throw new HttpError(422, 'RATING_INCOMPLETE', 'Score every goal and competency and fill every included section before submitting the rating', {
        goals: r.unratedGoals,
        competencies: r.unratedCompetencies,
        sections,
      });
    }
    // FR-042 manual mode: the overall rating is what the rating submits as the result.
    if (cycle.rating_mode === 'MANUAL' && rev.manager_overall_rating === null) {
      throw new HttpError(422, 'OVERALL_RATING_REQUIRED', 'Enter and save the overall rating before submitting the rating');
    }
    parts = r;
    weighted = r.weighted;
  }

  const result = await decideTask(tx, {
    grant,
    taskId,
    decision: input.decision,
    // A return records a reason (DB rule): the private remark when given, otherwise the message to the employee.
    reason: remark ?? (input.decision === 'RETURN' ? (message ?? undefined) : undefined),
    idempotencyKey: input.idempotencyKey,
    permission: { resource: 'appraisal', action },
    // BR-013: the reviewer step applies when the revision pinned at least one reviewer level (0 = the manager completes it).
    stepApplies: (code) => code === REVIEWER_LEVEL_CONDITION && (rev.approval_levels ?? 1) >= 1,
    // The reviewer's score is written with the confirmation it belongs to (level 1 = step 2, level 2 = step 3).
    onDecided: confirming
      ? async (decisionId) => {
          await tx.query(
            `insert into appraisal_review_score (company_id, appraisal_id, revision_id, level, score, decision_id, created_by) values ($1, $2, $3, $4, $5, $6, $7)`,
            [grant.companyId, a.id, rev.id, step.step - 1, input.reviewerScore, decisionId, grant.userId],
          );
        }
      : undefined,
  });
  if (result.replayed) return { appraisalId: a.id, state: a.state, revision: a.revision, replayed: true };

  if (result.outcome === 'RETURNED') {
    if (secondReview) await setSecondReviewState(tx, grant.companyId, secondReview, 'RETURNED', grant.userId);
    return returnToEmployee(tx, grant, a, rev, step.step, message!, remark);
  }

  if (action === 'rate') {
    // I-86: the results and the split they combine are written once, with the rating (the database checks them against the entries).
    await tx.query(
      `update appraisal_revision set state = 'RATED', rated_by = $3, rated_at = now(), weighted_result = $4::numeric, goal_result = $5::numeric,
              competency_result = $6::numeric, goal_weight_percent = $7, competency_weight_percent = $8, updated_by = $3
        where company_id = $1 and id = $2`,
      [grant.companyId, rev.id, grant.userId, weighted, parts?.goal ?? null, parts?.competency ?? null, parts?.split?.goalWeightPercent ?? null, parts?.split?.competencyWeightPercent ?? null],
    );
  }

  if (action === 'rate' && result.outcome === 'APPROVED') {
    // BR-013 one-level manager review: no reviewer step applied, so the manager's approval completes the appraisal.
    return complete(tx, grant, a, rev, step.step, finalRatingOf(cycle, weighted, rev.manager_overall_rating), 'RATE');
  }

  if (result.outcome === 'NEXT_STEP') {
    // The rating was submitted; reviewer level 1 is next on the appraisal route.
    const next = await pendingTaskOf(tx, grant.companyId, [a.transaction_id]);
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
  return complete(tx, grant, a, rev, step.step, finalRatingOf(cycle, rev.weighted_result, rev.manager_overall_rating));
}

/**
 * The caller's open appraisal tasks with each appraisal as the caller may see it (rating content needs the grant), each with
 * its due date (company-local, inclusive) and whether it is overdue (DF17: pending with due date < company-local today);
 * `overdue` keeps only those, as the Appraisal Reviewer's "Overdue review tasks" widget counts them.
 */
export async function reviewTasks(db: Queryable, grant: AccessGrant, q: { overdue?: boolean | undefined } = {}) {
  const open = ((await myOpenTasks(db, grant)).items as { taskId: string; kind: string; transactionId: string; assignedAt: Date; step: number }[]).filter((t) => TASK_KINDS.includes(t.kind));
  const due = new Map(
    (
      await db.query<{ id: string; due_on: string | null }>(`select id, hrms_business_date(company_id, due_at) as due_on from approval_task where company_id = $1 and id = any($2::uuid[])`, [
        grant.companyId,
        open.map((t) => t.taskId),
      ])
    ).rows.map((r) => [r.id, r.due_on]),
  );
  const dueOf = (taskId: string) => {
    const dueOn = due.get(taskId) ?? null;
    return { dueOn, overdue: dueOn !== null && dueOn < grant.businessDate };
  };
  const tasks = q.overdue ? open.filter((t) => dueOf(t.taskId).overdue) : open;
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
      ...dueOf(t.taskId),
      appraisal: a && visible ? await appraisalView(db, grant, a.id, staffScope(grant, a.employee_id)) : null,
    });
  }
  return { items };
}
