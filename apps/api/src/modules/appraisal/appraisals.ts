// Appraisals (DB064/DB065; FR-040 to FR-044; F1 "Appraisal"; DF02; DF08): enrolment of an employee in a cycle, goal
// setting, window exceptions, cancellation and the visibility-aware read model.
//
// KRA review (FR-041; decided under owner delegation, 6 Nov 2026, owner chose process rules only; I-77 item 3): where the
// cycle requires it, the person who set the goal set (enrolment with goals, a goal change or the KRA upload) is recorded,
// and someone else with the goal-setting duty reviews the complete set before the employee can enter the self-entry. A
// changed goal set starts unreviewed. The rating group also carries the manager's manual overall rating (FR-042) and the
// reviewer scores per revision and level (FR-043).
//
// Visibility (DF02, FR-044, H3 TN18). Operational to every reader in row scope: cycle, employee identity, state, task
// status, goals (name, target, weight) and their completion flags, windows, decision history (decision, step, time).
// In the Employee OWN context the employee also sees their own self-entry and the messages addressed to them when the
// appraisal was returned, never manager or reviewer scores, comments, remarks or results: no setting authorises an
// employee-visible result, so it is absent from the response. Elsewhere, self and manager scores, comments, results
// and reviewer remarks need the confidential rating group, exception and cancellation reasons the reason group; a
// caller's own appraisal reached through a staff route reads as the own view (without the self-entry, which is served
// in the Employee context only).
import { randomUUID } from 'node:crypto';
import { enqueueEvent } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { cancelActiveApproval, lockTransaction } from '../workflow/engine.js';
import {
  ACTIVE_EMPLOYEE_STATUSES,
  activeGoals,
  APPRAISAL_KIND,
  appraisalCompetencies,
  type AppraisalRow,
  audit,
  checkVersion,
  exceptionsUntil,
  type GoalRow,
  loadCycle,
  lockAppraisal,
  optionalText,
  ownEmployee,
  pendingTaskOf,
  readAppraisal,
  refuseOwnRecord,
  relatedTransactions,
  requireDate,
  requireEntryWindow,
  requireText,
  SECOND_REVIEW_KIND,
  setAppraisalState,
  setSecondReviewState,
  STAGES,
  type Stage,
  touchAppraisal,
  windowStatus,
  workingRevision,
} from './common.js';
import { copyCompetencies } from './competencies.js';
import { WINDOW_KEYS } from './cycles.js';
import { orderedSections, partyFills } from './sections.js';

// ---------------------------------------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------------------------------------

export interface GoalInput {
  sequence: number;
  description: string;
  target?: string | null | undefined;
  weight: number;
}

/** Trimmed goals with distinct sequences and whole-number weights 1..100 (the total is checked at submission). */
export function cleanGoals(goals: readonly GoalInput[]): { sequence: number; description: string; target: string | null; weight: number }[] {
  const seen = new Set<number>();
  return goals.map((g) => {
    if (!Number.isInteger(g.sequence) || g.sequence < 1 || g.sequence > 100) throw new HttpError(422, 'INVALID_SEQUENCE', 'Goal sequences are whole numbers 1 to 100', { sequence: g.sequence });
    if (seen.has(g.sequence)) throw new HttpError(422, 'DUPLICATE_SEQUENCE', 'Each goal has its own sequence number', { sequence: g.sequence });
    seen.add(g.sequence);
    if (!Number.isInteger(g.weight) || g.weight < 1 || g.weight > 100) throw new HttpError(422, 'INVALID_WEIGHT', 'Goal weights are whole numbers 1 to 100', { sequence: g.sequence });
    const description = optionalText(g.description);
    if (!description) throw new HttpError(422, 'FIELD_REQUIRED', 'Each goal needs a description', { sequence: g.sequence });
    return { sequence: g.sequence, description, target: optionalText(g.target ?? null), weight: g.weight };
  });
}

const goalSummary = (goals: readonly Pick<GoalRow, 'sequence' | 'description' | 'weight'>[]) => goals.map((g) => ({ sequence: g.sequence, description: g.description, weight: g.weight }));

async function insertGoals(tx: Queryable, companyId: string, appraisalId: string, goals: ReturnType<typeof cleanGoals>, userId: string): Promise<void> {
  for (const g of goals) {
    await tx.query(
      `insert into appraisal_item (company_id, appraisal_id, sequence, description, target, weight, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [companyId, appraisalId, g.sequence, g.description, g.target, g.weight, userId],
    );
  }
}

// ---------------------------------------------------------------------------------------------------------
// Enrolment, goals, exceptions and cancellation
// ---------------------------------------------------------------------------------------------------------

export interface CreateInput {
  cycleId: string;
  employeeId: string;
  goals?: GoalInput[] | undefined;
}

/**
 * Enrols an employee in an open cycle as a DRAFT appraisal (DB064), optionally with goals (inside the goal-setting
 * window; an exception can only be recorded once the appraisal exists). One employee is never in two overlapping
 * cycles (FR-040). Nobody enrols themselves.
 */
export async function createAppraisal(tx: Queryable, grant: AccessGrant, input: CreateInput, source: 'MANUAL' | 'UPLOAD' = 'MANUAL'): Promise<string> {
  // Share lock: closing the cycle (row lock for update) cannot interleave with an enrolment.
  const cycle = await loadCycle(tx, grant.companyId, input.cycleId, 'for share');
  if (!cycle) throw notFound();
  if (cycle.state !== 'OPEN') throw new HttpError(409, 'CYCLE_CLOSED', 'The appraisal cycle is closed');
  if (!(await canAccessEmployee(tx, grant, input.employeeId))) throw notFound();
  refuseOwnRecord(grant, input.employeeId);
  const employee = (
    await tx.query<{ status: string; joining_date: string }>(
      `select st.code as status, e.joining_date from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where e.company_id = $1 and e.id = $2`,
      [grant.companyId, input.employeeId],
    )
  ).rows[0];
  if (!employee || !ACTIVE_EMPLOYEE_STATUSES.includes(employee.status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only an active employee can be appraised');
  if (employee.joining_date > cycle.end_date) throw new HttpError(422, 'JOINED_AFTER_CYCLE', 'The employee joined after the cycle ends');
  const goals = cleanGoals(input.goals ?? []);
  if (goals.length > 0) await requireEntryWindow(tx, grant.companyId, null, cycle, 'GOAL_SETTING', grant.businessDate);

  // Serialise enrolments of one employee so the overlap check and the insert see the same state.
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('appraisal:employee:' || $1 || ':' || $2, 0))`, [grant.companyId, input.employeeId]);
  const overlapping = (
    await tx.query<{ cycle_id: string }>(
      `select cycle_id from appraisal where company_id = $1 and employee_id = $2 and state <> 'CANCELLED'
          and daterange(period_start, period_end, '[]') && daterange($3::date, $4::date, '[]') limit 1`,
      [grant.companyId, input.employeeId, cycle.start_date, cycle.end_date],
    )
  ).rows[0];
  if (overlapping) {
    if (overlapping.cycle_id === cycle.id) throw new HttpError(409, 'APPRAISAL_EXISTS', 'The employee already has an appraisal in this cycle');
    throw new HttpError(409, 'CYCLE_OVERLAP', 'The employee already has an appraisal in an overlapping cycle');
  }

  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'DRAFT', $4, $4) returning id`,
      [grant.companyId, APPRAISAL_KIND, input.employeeId, grant.userId],
    )
  ).rows[0]!.id;
  const id = randomUUID();
  // The enroller who gives goals sets the goal set (FR-041 KRA review: someone else reviews it where the cycle requires).
  await tx.query(
    `insert into appraisal (id, company_id, cycle_id, period_start, period_end, employee_id, transaction_id, state, revision, source, goals_set_by, goals_set_at, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', 1, $8, $10, case when $10::uuid is null then null else now() end, $9, $9)`,
    [id, grant.companyId, cycle.id, cycle.start_date, cycle.end_date, input.employeeId, transactionId, source, grant.userId, goals.length > 0 ? grant.userId : null],
  );
  await tx.query(`insert into appraisal_revision (company_id, appraisal_id, revision, state, created_by, updated_by) values ($1, $2, 1, 'DRAFT', $3, $3)`, [
    grant.companyId,
    id,
    grant.userId,
  ]);
  await insertGoals(tx, grant.companyId, id, goals, grant.userId);
  // FR-041 / I-86: where the cycle assesses competencies, the set mapped to the employee's grade (and designation) today is copied,
  // then fixed. Without a mapped set the appraisal has none and its result is the goal result alone.
  const competencies = cycle.competency_weight_percent > 0 ? await copyCompetencies(tx, grant.companyId, id, input.employeeId, grant.businessDate, grant.userId) : { setId: null, count: 0 };
  await audit(tx, grant, 'appraisal', id, 'CREATE', null, {
    cycleId: cycle.id,
    employeeId: input.employeeId,
    source,
    state: 'DRAFT',
    goals: goalSummary(goals),
    goalWeightTotal: goals.reduce((s, g) => s + g.weight, 0),
    competencySetId: competencies.setId,
    competencies: competencies.count,
  });
  return id;
}

/** Goals of a draft appraisal that was never submitted (FR-041), replaced as a set inside the goal-setting window. */
export async function replaceGoals(tx: Queryable, grant: AccessGrant, id: string, input: { goals: GoalInput[]; expectedVersion: number }): Promise<void> {
  const a = await lockAppraisal(tx, grant.companyId, id);
  if (!a || !(await canAccessEmployee(tx, grant, a.employee_id))) throw notFound();
  refuseOwnRecord(grant, a.employee_id);
  checkVersion(a.version, input.expectedVersion);
  const rev = await workingRevision(tx, grant.companyId, a);
  if (a.state !== 'DRAFT' || a.revision !== 1 || rev.state !== 'DRAFT') throw new HttpError(409, 'GOALS_FIXED', 'Goals are fixed once the appraisal has been submitted');
  const cycle = (await loadCycle(tx, grant.companyId, a.cycle_id))!;
  await requireEntryWindow(tx, grant.companyId, a.id, cycle, 'GOAL_SETTING', grant.businessDate);
  const goals = cleanGoals(input.goals);
  const before = await activeGoals(tx, grant.companyId, a.id);
  const bySequence = new Map(before.map((g) => [g.sequence, g]));
  const removed = before.filter((old) => !goals.some((g) => g.sequence === old.sequence));
  const added = goals.filter((g) => !bySequence.has(g.sequence));
  const edited = goals.filter((g) => {
    const old = bySequence.get(g.sequence);
    return old !== undefined && (old.description !== g.description || old.target !== g.target || old.weight !== g.weight);
  });
  const setter = (await tx.query<{ goals_set_by: string | null }>(`select goals_set_by from appraisal where company_id = $1 and id = $2`, [grant.companyId, a.id])).rows[0]!.goals_set_by;
  if (removed.length + added.length + edited.length > 0 || (setter === null && goals.length > 0)) {
    // FR-041 KRA review: a changed goal set is the caller's and starts unreviewed (any earlier review no longer applies); goals
    // entered before 0176 name their setter when they are next saved.
    await tx.query(
      `update appraisal set goals_set_by = $3, goals_set_at = now(), goals_reviewed_by = null, goals_reviewed_at = null, updated_by = $3 where company_id = $1 and id = $2`,
      [grant.companyId, a.id, grant.userId],
    );
  }
  for (const old of removed) {
    await tx.query(`update appraisal_item set active = false, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, old.id, grant.userId]);
  }
  await insertGoals(tx, grant.companyId, a.id, added, grant.userId);
  for (const g of edited) {
    await tx.query(`update appraisal_item set description = $3, target = $4, weight = $5, updated_by = $6 where company_id = $1 and id = $2`, [
      grant.companyId,
      bySequence.get(g.sequence)!.id,
      g.description,
      g.target,
      g.weight,
      grant.userId,
    ]);
  }
  await touchAppraisal(tx, grant.companyId, a.id, grant.userId);
  await audit(
    tx,
    grant,
    'appraisal',
    a.id,
    'SET_GOALS',
    { goals: goalSummary(before), goalWeightTotal: before.reduce((s, g) => s + g.weight, 0) },
    { goals: goalSummary(goals), goalWeightTotal: goals.reduce((s, g) => s + g.weight, 0) },
  );
}

/**
 * FR-041 KRA review (I-77 item 3): where the cycle requires it, an eligible person who did not set the goals reviews the
 * complete goal set (weights totalling exactly 100) before the first submission; the goals then take effect and the employee
 * can enter the self-entry. Goal setting and review are the same duty (HR, or the direct manager within row scope), held
 * apart by person: the setter never reviews their own goal set, nor does the appraised employee (database rule too). A
 * review is a decision, not a windowed entry, so the goal-setting window does not bound it.
 */
export async function reviewGoals(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }): Promise<void> {
  const a = await lockAppraisal(tx, grant.companyId, id);
  if (!a || !(await canAccessEmployee(tx, grant, a.employee_id))) throw notFound();
  refuseOwnRecord(grant, a.employee_id);
  checkVersion(a.version, input.expectedVersion);
  const cycle = (await loadCycle(tx, grant.companyId, a.cycle_id))!;
  if (!cycle.goal_review_required) throw new HttpError(409, 'GOAL_REVIEW_NOT_REQUIRED', 'This cycle does not review goals: they take effect when set');
  const rev = await workingRevision(tx, grant.companyId, a);
  if (a.state !== 'DRAFT' || a.revision !== 1 || rev.state !== 'DRAFT') throw new HttpError(409, 'GOALS_FIXED', 'Goals are fixed once the appraisal has been submitted');
  const set = (
    await tx.query<{ goals_set_by: string | null; goals_reviewed_at: Date | null }>(`select goals_set_by, goals_reviewed_at from appraisal where company_id = $1 and id = $2`, [grant.companyId, a.id])
  ).rows[0]!;
  if (set.goals_reviewed_at) throw new HttpError(409, 'GOALS_ALREADY_REVIEWED', 'These goals have already been reviewed');
  const goals = await activeGoals(tx, grant.companyId, a.id);
  if (goals.length === 0) throw new HttpError(422, 'GOALS_REQUIRED', 'The appraisal has no goals yet');
  const total = goals.reduce((s, g) => s + g.weight, 0);
  if (total !== 100) throw new HttpError(422, 'WEIGHT_TOTAL_NOT_100', 'Goal weights must total exactly 100', { total });
  // Goals entered before 0176 name no setter: they are set again first, so the review can be told apart from the setting.
  if (!set.goals_set_by) throw new HttpError(409, 'GOALS_SETTER_UNKNOWN', 'Set these goals again before they are reviewed');
  if (set.goals_set_by === grant.userId) throw new HttpError(403, 'GOAL_REVIEW_NOT_INDEPENDENT', 'Someone other than the person who set the goals reviews them');
  await tx.query(`update appraisal set goals_reviewed_by = $3, goals_reviewed_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, a.id, grant.userId]);
  await audit(tx, grant, 'appraisal', a.id, 'REVIEW_GOALS', { goalsReviewed: false }, { goalsReviewed: true, goals: goalSummary(goals), goalWeightTotal: total });
}

/**
 * FR-040: an authorised HR user records an exception that admits entries at one stage of one appraisal through the
 * given date (inclusive) outside the stage's window. The reason is confidential; the employee concerned can never
 * record one for themselves.
 */
export async function recordException(tx: Queryable, grant: AccessGrant, id: string, input: { stage: Stage; validUntil: string; reason: string }): Promise<void> {
  const a = await lockAppraisal(tx, grant.companyId, id);
  if (!a || !(await canAccessEmployee(tx, grant, a.employee_id))) throw notFound();
  refuseOwnRecord(grant, a.employee_id);
  if (a.state === 'APPROVED' || a.state === 'CANCELLED') throw new HttpError(409, 'INVALID_STATE', 'The appraisal is finished');
  const cycle = (await loadCycle(tx, grant.companyId, a.cycle_id))!;
  if (cycle.state !== 'OPEN') throw new HttpError(409, 'CYCLE_CLOSED', 'The appraisal cycle is closed');
  const until = requireDate(input.validUntil, 'validUntil');
  if (until < grant.businessDate) throw new HttpError(422, 'INVALID_DATE', 'An exception is valid through today or a later date', { field: 'validUntil' });
  const reason = requireText(input.reason, 'reason');
  await tx.query(
    `insert into appraisal_window_exception (company_id, appraisal_id, stage, valid_until, reason, recorded_by, created_by) values ($1, $2, $3, $4, $5, $6, $6)`,
    [grant.companyId, a.id, input.stage, until, reason, grant.userId],
  );
  await touchAppraisal(tx, grant.companyId, a.id, grant.userId);
  await audit(tx, grant, 'appraisal', a.id, 'WINDOW_EXCEPTION', null, { stage: input.stage, validUntil: until }, reason);
}

/** HR cancels an unfinished appraisal with a confidential reason; the record and its history are kept (DF08). */
export async function cancelAppraisal(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string; expectedVersion: number }): Promise<void> {
  const a = await lockAppraisal(tx, grant.companyId, id);
  if (!a || !(await canAccessEmployee(tx, grant, a.employee_id))) throw notFound();
  refuseOwnRecord(grant, a.employee_id);
  checkVersion(a.version, input.expectedVersion);
  if (a.state === 'APPROVED' || a.state === 'CANCELLED') throw new HttpError(409, 'INVALID_STATE', 'A completed or cancelled appraisal cannot be cancelled');
  const reason = requireText(input.reason, 'reason');
  const pending = await pendingTaskOf(tx, grant.companyId, await relatedTransactions(tx, grant.companyId, a));
  await cancelActiveApproval(tx, grant.companyId, a.transaction_id, grant.userId);
  // An open second-level review ends with the appraisal (its lock after the appraisal's, as everywhere).
  const reviews = (await tx.query<{ id: string; transaction_id: string }>(`select id, transaction_id from appraisal_second_review where company_id = $1 and appraisal_id = $2 and state = 'SUBMITTED'`, [
    grant.companyId,
    a.id,
  ])).rows;
  for (const sr of reviews) {
    await lockTransaction(tx, sr.transaction_id);
    await cancelActiveApproval(tx, grant.companyId, sr.transaction_id, grant.userId);
    await setSecondReviewState(tx, grant.companyId, sr, 'CANCELLED', grant.userId);
  }
  await tx.query(`update appraisal_revision set state = 'CANCELLED', updated_by = $3 where company_id = $1 and appraisal_id = $2 and state in ('DRAFT', 'SUBMITTED', 'RATED')`, [
    grant.companyId,
    a.id,
    grant.userId,
  ]);
  await setAppraisalState(tx, grant.companyId, a, 'CANCELLED', grant.userId, ', cancelled_by = $4, cancelled_at = now(), cancel_reason = $5', [reason]);
  await audit(tx, grant, 'appraisal', a.id, 'CANCEL', { state: a.state, revision: a.revision }, { state: 'CANCELLED' }, reason);
  await enqueueEvent(tx, { companyId: grant.companyId, topic: 'appraisal.cancelled', aggregateId: a.id, dedupeKey: `appraisal.cancelled:${a.id}`, payload: { appraisalId: a.id } });
  if (pending) {
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'appraisal.task_cancelled',
      aggregateId: a.id,
      dedupeKey: `appraisal.task_cancelled:${a.id}:${pending.id}`,
      payload: { appraisalId: a.id, userId: pending.assignee_user_id },
    });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------------------------------------

export interface ViewScope {
  /** The Employee OWN context of the appraised employee. */
  own: boolean;
  /** Own self-entry (own view only). */
  showSelf: boolean;
  /** Self and manager scores, comments, results and reviewer remarks (staff views, never the caller's own record). */
  showRating: boolean;
  /** Exception and cancellation reasons (staff views, never the caller's own record). */
  showReason: boolean;
}

export const ownScope = (grant: AccessGrant): ViewScope => ({ own: true, showSelf: grant.allowedFieldGroups.includes('self'), showRating: false, showReason: false });

/**
 * Staff views. One's own appraisal reads as the own view shows it, whatever the context: no confidential content and
 * no reviewer-only information such as task ids, reviewer identities or the manager's rating progress (FR-110,
 * BR-053); its self-entry is served only in the Employee OWN context (BR-055).
 */
export function staffScope(grant: AccessGrant, employeeId: string): ViewScope {
  if (grant.linkedEmployeeId === employeeId) return { own: true, showSelf: false, showRating: false, showReason: false };
  return { own: false, showSelf: false, showRating: grant.allowedFieldGroups.includes('rating'), showReason: grant.allowedFieldGroups.includes('reason') };
}

export type TaskStatus = 'AWAITING_GOALS' | 'AWAITING_GOAL_REVIEW' | 'AWAITING_SELF_ENTRY' | 'AWAITING_MANAGER_RATING' | 'AWAITING_REVIEW' | 'COMPLETED' | 'CANCELLED';

/** `goalReviewPending`: the cycle requires a goal review (FR-041 KRA review) and the goal set has not had one. */
export function taskStatusOf(state: AppraisalRow['state'], goalsReady: boolean, goalReviewPending = false): TaskStatus {
  switch (state) {
    case 'DRAFT':
      return !goalsReady ? 'AWAITING_GOALS' : goalReviewPending ? 'AWAITING_GOAL_REVIEW' : 'AWAITING_SELF_ENTRY';
    case 'RETURNED':
      return 'AWAITING_SELF_ENTRY';
    case 'SUBMITTED':
      return 'AWAITING_MANAGER_RATING';
    case 'IN_REVIEW':
      return 'AWAITING_REVIEW';
    case 'APPROVED':
      return 'COMPLETED';
    default:
      return 'CANCELLED';
  }
}

/** Step 1 is the manager's rating; steps 2 and 3 are reviewer levels 1 and 2. */
export const stepStage = (step: number) => (step === 1 ? { stage: 'MANAGER_RATING' as const, level: null } : { stage: 'REVIEW' as const, level: step - 1 });

const identity = (alias: string, userColumn: string, companyColumn: string) =>
  `left join user_employee_link ${alias}l on ${alias}l.company_id = ${companyColumn} and ${alias}l.user_id = ${userColumn}
        and ${alias}l.effective_from <= hrms_business_date(${companyColumn}, now()) and (${alias}l.effective_to is null or ${alias}l.effective_to > hrms_business_date(${companyColumn}, now()))
   left join employee ${alias}e on ${alias}e.company_id = ${alias}l.company_id and ${alias}e.id = ${alias}l.employee_id`;

interface Person {
  userId: string;
  employeeCode: string | null;
  displayName: string | null;
}

interface BaseRow {
  id: string;
  cycle_id: string;
  employee_id: string;
  transaction_id: string;
  state: AppraisalRow['state'];
  revision: number;
  source: string;
  final_rating: string | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  created_at: Date;
  version: number;
  employee_code: string;
  display_name: string;
  department_id: string | null;
  department_name: string | null;
  goals_set_at: Date | null;
  goals_set_by: Person | null;
  goals_reviewed_at: Date | null;
  goals_reviewed_by: Person | null;
}

const CURRENT_DEPARTMENT = (day: string) => `left join lateral (
    select ea.department_id, d.name as department_name from employment_assignment ea
      join department d on d.company_id = ea.company_id and d.id = ea.department_id
     where ea.company_id = a.company_id and ea.employee_id = a.employee_id
       and ea.effective_from <= ${day} and (ea.effective_to is null or ea.effective_to > ${day})
     limit 1) dep on true`;

interface RevisionDetail {
  id: string;
  revision: number;
  state: string;
  self_comment: string | null;
  submitted_at: Date | null;
  approval_levels: number | null;
  manager_comment: string | null;
  rated_at: Date | null;
  weighted_result: string | null;
  manager_overall_rating: number | null;
  goal_result: string | null;
  competency_result: string | null;
  goal_weight_percent: number | null;
  competency_weight_percent: number | null;
  returned_at: Date | null;
  employee_message: string | null;
  confirmed_at: Date | null;
}

interface SectionEntryRow {
  revision_id: string;
  section: string;
  party: 'EMPLOYEE' | 'MANAGER';
  /** Completion flag (operational). */
  done: boolean;
  body: string | null;
}

interface EntryRow {
  revision_id: string;
  item_id: string;
  /** Completion flags (operational). */
  self_done: boolean;
  manager_done: boolean;
  self_score: number | null;
  self_comment: string | null;
  manager_score: number | null;
  manager_comment: string | null;
}

/**
 * The appraisal as this caller may see it (see the header). The caller has already been checked for row scope.
 * F1 outputs: a confidential column is not even read unless this caller may see it (never masked after retrieval).
 */
export async function appraisalView(db: Queryable, grant: AccessGrant, id: string, scope: ViewScope) {
  const today = grant.businessDate;
  const selfCols = scope.showSelf || scope.showRating;
  const col = (allowed: boolean, column: string, alias: string) => `${allowed ? column : 'null'} as ${alias}`;
  const a = (
    await db.query<BaseRow>(
      `select a.id, a.cycle_id, a.employee_id, a.transaction_id, a.state, a.revision, a.source, ${col(scope.showRating, 'a.final_rating', 'final_rating')},
              a.completed_at, a.cancelled_at, ${col(scope.showReason, 'a.cancel_reason', 'cancel_reason')},
              a.created_at, a.version, e.employee_code, e.display_name, dep.department_id, dep.department_name,
              a.goals_set_at, a.goals_reviewed_at,
              case when a.goals_set_by is null then null
                   else json_build_object('userId', a.goals_set_by, 'employeeCode', se.employee_code, 'displayName', se.display_name) end as goals_set_by,
              case when a.goals_reviewed_by is null then null
                   else json_build_object('userId', a.goals_reviewed_by, 'employeeCode', ge.employee_code, 'displayName', ge.display_name) end as goals_reviewed_by
         from appraisal a join employee e on e.company_id = a.company_id and e.id = a.employee_id
         ${CURRENT_DEPARTMENT('$3::date')}
         ${identity('s', 'a.goals_set_by', 'a.company_id')}
         ${identity('g', 'a.goals_reviewed_by', 'a.company_id')}
        where a.company_id = $1 and a.id = $2`,
      [grant.companyId, id, today],
    )
  ).rows[0];
  if (!a) throw notFound();
  const cycle = (await loadCycle(db, grant.companyId, a.cycle_id))!;
  const goals = await activeGoals(db, grant.companyId, a.id);
  const revisions = (
    await db.query<RevisionDetail>(
      `select id, revision, state, ${col(selfCols, 'self_comment', 'self_comment')}, submitted_at, approval_levels,
              ${col(scope.showRating, 'manager_comment', 'manager_comment')}, rated_at, ${col(scope.showRating, 'weighted_result', 'weighted_result')},
              ${col(scope.showRating, 'manager_overall_rating', 'manager_overall_rating')}, returned_at,
              ${col(scope.showRating, 'goal_result', 'goal_result')}, ${col(scope.showRating, 'competency_result', 'competency_result')},
              ${col(scope.showRating, 'goal_weight_percent', 'goal_weight_percent')}, ${col(scope.showRating, 'competency_weight_percent', 'competency_weight_percent')},
              ${col(scope.own || scope.showRating, 'employee_message', 'employee_message')}, confirmed_at
         from appraisal_revision where company_id = $1 and appraisal_id = $2 order by revision`,
      [grant.companyId, a.id],
    )
  ).rows;
  // FR-041 competencies (operational: code, name, indicators, weight) and their entries (scores and comments confidential, as goals).
  const competencies = await appraisalCompetencies(db, grant.companyId, a.id);
  const competencyEntries = (
    await db.query<EntryRow>(
      `select revision_id, item_id, self_score is not null as self_done, manager_score is not null as manager_done,
              ${col(selfCols, 'self_score', 'self_score')}, ${col(selfCols, 'self_comment', 'self_comment')},
              ${col(scope.showRating, 'manager_score', 'manager_score')}, ${col(scope.showRating, 'manager_comment', 'manager_comment')}
         from appraisal_competency_entry where company_id = $1 and appraisal_id = $2`,
      [grant.companyId, a.id],
    )
  ).rows;
  // FR-042 section texts: the employee's is the own self-entry (self group), the manager's the confidential rating group.
  const sectionEntries = (
    await db.query<SectionEntryRow>(
      `select revision_id, section, party, body is not null as done,
              case when party = 'EMPLOYEE' then ${selfCols ? 'body' : 'null'} else ${scope.showRating ? 'body' : 'null'} end as body
         from appraisal_section_entry where company_id = $1 and appraisal_id = $2`,
      [grant.companyId, a.id],
    )
  ).rows;
  // FR-043 reviewer scores (rating group only): one overall score per revision and reviewer level, never read otherwise.
  const reviewerScores = scope.showRating
    ? (
        await db.query<{ revision_id: string; level: number; score: number; scored_at: Date }>(
          `select revision_id, level, score, created_at as scored_at from appraisal_review_score where company_id = $1 and appraisal_id = $2 order by level`,
          [grant.companyId, a.id],
        )
      ).rows
    : [];
  const entries = (
    await db.query<EntryRow>(
      `select revision_id, item_id, self_score is not null as self_done, manager_score is not null as manager_done,
              ${col(selfCols, 'self_score', 'self_score')}, ${col(selfCols, 'self_comment', 'self_comment')},
              ${col(scope.showRating, 'manager_score', 'manager_score')}, ${col(scope.showRating, 'manager_comment', 'manager_comment')}
         from appraisal_entry where company_id = $1 and appraisal_id = $2`,
      [grant.companyId, a.id],
    )
  ).rows;
  // The appraisal route and any second-level review route: steps 1-2 are the appraisal's, step 3 the second review's,
  // whose decisions belong to the revision the review was opened for.
  const routes = `(select $2::uuid as transaction_id, null::int as revision
                   union all
                   select sr.transaction_id, ar.revision from appraisal_second_review sr
                     join appraisal_revision ar on ar.company_id = sr.company_id and ar.id = sr.revision_id
                    where sr.company_id = $1 and sr.appraisal_id = $3)`;
  const decisions = (
    await db.query<{ revision: number; step: number; decision: string; reason: string | null; decided_at: Date; decided_by: Person }>(
      `select coalesce(rt.revision, i.transaction_revision) as revision,
              case when i.transaction_kind = '${SECOND_REVIEW_KIND}' then 3 else s.sequence end as step,
              d.decision, ${col(scope.showRating, 'd.reason', 'reason')}, d.occurred_at as decided_at,
              json_build_object('userId', d.actor_user_id, 'employeeCode', de.employee_code, 'displayName', de.display_name) as decided_by
         from ${routes} rt
         join approval_instance i on i.company_id = $1 and i.transaction_id = rt.transaction_id
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         ${identity('d', 'd.actor_user_id', 'd.company_id')}
        order by d.occurred_at, d.id`,
      [grant.companyId, a.transaction_id, a.id],
    )
  ).rows;
  const pending = (
    await db.query<{ task_id: string; step: number; assigned_at: Date; assignee: Person }>(
      `select t.id as task_id, case when i.transaction_kind = '${SECOND_REVIEW_KIND}' then 3 else s.sequence end as step, t.created_at as assigned_at,
              json_build_object('userId', t.assignee_user_id, 'employeeCode', pe.employee_code, 'displayName', pe.display_name) as assignee
         from ${routes} rt
         join approval_instance i on i.company_id = $1 and i.transaction_id = rt.transaction_id and i.state = 'ACTIVE'
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'PENDING'
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         ${identity('p', 't.assignee_user_id', 't.company_id')}
        order by t.created_at desc limit 1`,
      [grant.companyId, a.transaction_id, a.id],
    )
  ).rows[0];
  const exceptions = (
    await db.query<{ stage: Stage; valid_until: string; reason: string; recorded_at: Date; recorded_by: Person }>(
      `select x.stage, x.valid_until, ${col(scope.showReason, 'x.reason', 'reason')}, x.created_at as recorded_at,
              json_build_object('userId', x.recorded_by, 'employeeCode', xe.employee_code, 'displayName', xe.display_name) as recorded_by
         from appraisal_window_exception x
         ${identity('x', 'x.recorded_by', 'x.company_id')}
        where x.company_id = $1 and x.appraisal_id = $2 order by x.created_at`,
      [grant.companyId, a.id],
    )
  ).rows;

  const valid = await exceptionsUntil(db, grant.companyId, a.id, today);
  const working = revisions.find((r) => r.revision === a.revision);
  const entriesOf = (revisionId: string) => entries.filter((e) => e.revision_id === revisionId);
  const workingEntries = working ? entriesOf(working.id) : [];
  const goalWeightTotal = goals.reduce((s, g) => s + g.weight, 0);
  const goalsReady = goals.length > 0 && goalWeightTotal === 100;
  const goalReviewPending = cycle.goal_review_required && a.goals_reviewed_at === null;
  const sequenceOf = new Map(goals.map((g) => [g.id, g.sequence]));
  const goalEntries = (list: EntryRow[], part: 'self' | 'manager') =>
    list
      .filter((e) => sequenceOf.has(e.item_id))
      .sort((x, y) => sequenceOf.get(x.item_id)! - sequenceOf.get(y.item_id)!)
      .map((e) => ({
        goalId: e.item_id,
        sequence: sequenceOf.get(e.item_id)!,
        score: part === 'self' ? e.self_score : e.manager_score,
        comment: part === 'self' ? e.self_comment : e.manager_comment,
      }));
  const competencySequence = new Map(competencies.map((k) => [k.id, k.sequence]));
  const competencyEntriesOf = (revisionId: string, part: 'self' | 'manager') =>
    competencyEntries
      .filter((e) => e.revision_id === revisionId && competencySequence.has(e.item_id))
      .sort((x, y) => competencySequence.get(x.item_id)! - competencySequence.get(y.item_id)!)
      .map((e) => ({
        competencyId: e.item_id,
        sequence: competencySequence.get(e.item_id)!,
        score: part === 'self' ? e.self_score : e.manager_score,
        comment: part === 'self' ? e.self_comment : e.manager_comment,
      }));
  const includedSections = orderedSections(cycle.sections);
  const sectionTexts = (revisionId: string, party: 'EMPLOYEE' | 'MANAGER') =>
    includedSections
      .filter((s) => partyFills(s.code, party))
      .map((s) => ({ section: s.code, text: sectionEntries.find((x) => x.revision_id === revisionId && x.section === s.code && x.party === party)?.body ?? null }));
  const sectionDone = (section: string, party: 'EMPLOYEE' | 'MANAGER') =>
    working ? sectionEntries.some((x) => x.revision_id === working.id && x.section === section && x.party === party && x.done) : false;

  return {
    id: a.id,
    cycle: {
      id: cycle.id,
      code: cycle.code,
      name: cycle.name,
      startDate: cycle.start_date,
      endDate: cycle.end_date,
      approvalLevels: cycle.approval_levels,
      goalReviewRequired: cycle.goal_review_required,
      ratingMode: cycle.rating_mode,
      reviewDueOn: cycle.review_due_on,
      // I-86: how the weighted result combines goals and competencies (operational configuration).
      scoring: { goalWeightPercent: cycle.goal_weight_percent, competencyWeightPercent: cycle.competency_weight_percent, competenciesAssessed: cycle.competency_weight_percent > 0 },
      state: cycle.state,
    },
    employee: { id: a.employee_id, employeeCode: a.employee_code, displayName: a.display_name, department: a.department_id ? { id: a.department_id, name: a.department_name } : null },
    state: a.state,
    revision: a.revision,
    source: a.source,
    taskStatus: taskStatusOf(a.state, goalsReady, goalReviewPending),
    // FR-041 KRA review: whether the goals took effect; who set and reviewed them is not shown on one's own appraisal.
    goalReview: {
      required: cycle.goal_review_required,
      reviewed: a.goals_reviewed_at !== null,
      reviewedAt: a.goals_reviewed_at,
      ...(scope.own ? {} : { setBy: a.goals_set_by, setAt: a.goals_set_at, reviewedBy: a.goals_reviewed_by }),
    },
    pending: pending
      ? {
          ...(scope.own ? {} : { taskId: pending.task_id }),
          step: pending.step,
          ...stepStage(pending.step),
          assignedAt: pending.assigned_at,
          // H3: the pending owner is shown; the employee sees a name only.
          with: scope.own ? { displayName: pending.assignee.displayName ?? 'Reviewer' } : pending.assignee,
        }
      : null,
    goals: goals.map((g) => {
      const e = workingEntries.find((x) => x.item_id === g.id);
      return {
        id: g.id,
        sequence: g.sequence,
        description: g.description,
        target: g.target,
        weight: g.weight,
        // DF02 completion flags (operational): whether each stage has been entered for the goal, never the values.
        selfEntryComplete: e?.self_done === true,
        ...(scope.own ? {} : { managerRatingComplete: e?.manager_done === true }),
      };
    }),
    goalWeightTotal,
    // FR-041 grade-mapped competencies, copied at enrolment and fixed (I-86). Operational like goals; the values are not.
    competencies: competencies.map((k) => {
      const e = competencyEntries.find((x) => working && x.revision_id === working.id && x.item_id === k.id);
      return {
        id: k.id,
        competencyId: k.competency_id,
        sequence: k.sequence,
        code: k.code,
        name: k.name,
        description: k.description,
        indicators: k.indicators.map((text, i) => ({ level: i + 1, text })),
        weight: k.weight,
        selfEntryComplete: e?.self_done === true,
        ...(scope.own ? {} : { managerRatingComplete: e?.manager_done === true }),
      };
    }),
    competencyWeightTotal: competencies.reduce((s, k) => s + k.weight, 0),
    // FR-042 sections the cycle includes, with their meaning and completion flags (never the texts).
    sections: includedSections.map((s) => ({
      ...s,
      ...(partyFills(s.code, 'EMPLOYEE') ? { selfEntryComplete: sectionDone(s.code, 'EMPLOYEE') } : {}),
      ...(!scope.own && partyFills(s.code, 'MANAGER') ? { managerEntryComplete: sectionDone(s.code, 'MANAGER') } : {}),
    })),
    windows: Object.fromEntries(
      STAGES.map((s) => {
        const st = windowStatus(cycle, s, today, valid);
        return [WINDOW_KEYS[s], { opensOn: st.opensOn, closesOn: st.closesOn, openToday: st.openToday, exceptionUntil: st.exceptionUntil, entryAllowed: st.entryAllowed }];
      }),
    ),
    revisions: revisions.map((r) => {
      const base = {
        revision: r.revision,
        state: r.state,
        submittedAt: r.submitted_at,
        returnedAt: r.returned_at,
        confirmedAt: r.confirmed_at,
        ...(scope.own ? {} : { ratedAt: r.rated_at, approvalLevels: r.approval_levels }),
      };
      const list = entriesOf(r.id);
      const selfEntry = () => ({ comment: r.self_comment, entries: goalEntries(list, 'self'), competencies: competencyEntriesOf(r.id, 'self'), sections: sectionTexts(r.id, 'EMPLOYEE') });
      if (scope.own) {
        return {
          ...base,
          // The explanation of a return is addressed to the employee; reviewer remarks are not.
          employeeMessage: r.employee_message,
          ...(scope.showSelf ? { selfEntry: selfEntry() } : {}),
        };
      }
      if (!scope.showRating) return base;
      return {
        ...base,
        employeeMessage: r.employee_message,
        selfEntry: selfEntry(),
        managerRating: {
          comment: r.manager_comment,
          entries: goalEntries(list, 'manager'),
          competencies: competencyEntriesOf(r.id, 'manager'),
          sections: sectionTexts(r.id, 'MANAGER'),
          // I-86: the weighted result (FORMULA: the final rating) and the parts it combines; split null = the goal result alone.
          weightedResult: r.weighted_result,
          goalResult: r.goal_result,
          competencyResult: r.competency_result,
          split: r.competency_weight_percent === null ? null : { goalWeightPercent: r.goal_weight_percent, competencyWeightPercent: r.competency_weight_percent },
          overallRating: r.manager_overall_rating,
        },
        reviewerScores: reviewerScores.filter((s) => s.revision_id === r.id).map((s) => ({ level: s.level, score: s.score, scoredAt: s.scored_at })),
      };
    }),
    decisions: decisions.map((d) => ({
      revision: d.revision,
      step: d.step,
      ...stepStage(d.step),
      decision: d.decision,
      decidedAt: d.decided_at,
      ...(scope.own ? {} : { decidedBy: d.decided_by }),
      ...(scope.showRating ? { remark: d.reason } : {}),
    })),
    ...(scope.showRating ? { finalRating: a.final_rating } : {}),
    exceptions: exceptions.map((x) => ({
      stage: x.stage,
      validUntil: x.valid_until,
      recordedAt: x.recorded_at,
      ...(scope.own ? {} : { recordedBy: x.recorded_by }),
      ...(scope.showReason ? { reason: x.reason } : {}),
    })),
    completedAt: a.completed_at,
    cancelledAt: a.cancelled_at,
    ...(scope.showReason ? { cancelReason: a.cancel_reason } : {}),
    createdAt: a.created_at,
    version: a.version,
  };
}

/** Staff detail within row scope; anything outside it reads as not found. */
export async function getAppraisal(db: Queryable, grant: AccessGrant, id: string) {
  const a = await readAppraisal(db, grant.companyId, id);
  if (!a || !(await canAccessEmployee(db, grant, a.employee_id))) throw notFound();
  return appraisalView(db, grant, id, staffScope(grant, a.employee_id));
}

/** The caller's own appraisal in the Employee OWN context; anyone else's reads as not found. */
export async function getOwnAppraisal(db: Queryable, grant: AccessGrant, id: string) {
  const employeeId = ownEmployee(grant);
  const a = await readAppraisal(db, grant.companyId, id);
  if (!a || a.employee_id !== employeeId) throw notFound();
  return appraisalView(db, grant, id, ownScope(grant));
}

interface ListRow {
  id: string;
  state: AppraisalRow['state'];
  revision: number;
  source: string;
  final_rating: string | null;
  weighted_result: string | null;
  completed_at: Date | null;
  created_at: Date;
  cycle_id: string;
  cycle_code: string;
  cycle_name: string;
  employee_id: string;
  employee_code: string;
  display_name: string;
  department_id: string | null;
  department_name: string | null;
  goal_count: number;
  goal_weight_total: number;
  goal_review_pending: boolean;
  total: number;
}

/**
 * List columns. The results are read only with the rating group, and never for the caller's own appraisal
 * (`ownEmployee` is the parameter placeholder of the caller's linked employee, or null).
 */
const listColumns = (withRating: boolean, ownEmployee: string | null) => {
  const unlessOwn = (expr: string) => (ownEmployee ? `case when a.employee_id = ${ownEmployee}::uuid then null else ${expr} end` : expr);
  return `a.id, a.state, a.revision, a.source, a.completed_at, a.created_at,
       c.id as cycle_id, c.code as cycle_code, c.name as cycle_name, e.id as employee_id, e.employee_code, e.display_name, dep.department_id, dep.department_name,
       (c.goal_review_required and a.goals_reviewed_at is null) as goal_review_pending,
       ${withRating ? unlessOwn('a.final_rating') : 'null'} as final_rating,
       ${withRating ? unlessOwn('(select r.weighted_result from appraisal_revision r where r.company_id = a.company_id and r.appraisal_id = a.id and r.revision = a.revision)') : 'null'} as weighted_result,
       (select count(*)::int from appraisal_item i where i.company_id = a.company_id and i.appraisal_id = a.id and i.active) as goal_count,
       (select coalesce(sum(i.weight), 0)::int from appraisal_item i where i.company_id = a.company_id and i.appraisal_id = a.id and i.active) as goal_weight_total`;
};

function listItem(grant: AccessGrant, r: ListRow, own: boolean) {
  const showRating = !own && grant.linkedEmployeeId !== r.employee_id && grant.allowedFieldGroups.includes('rating');
  return {
    id: r.id,
    cycle: { id: r.cycle_id, code: r.cycle_code, name: r.cycle_name },
    employee: { id: r.employee_id, employeeCode: r.employee_code, displayName: r.display_name, department: r.department_id ? { id: r.department_id, name: r.department_name } : null },
    state: r.state,
    revision: r.revision,
    source: r.source,
    taskStatus: taskStatusOf(r.state, r.goal_count > 0 && r.goal_weight_total === 100, r.goal_review_pending),
    goalCount: r.goal_count,
    goalWeightTotal: r.goal_weight_total,
    completedAt: r.completed_at,
    createdAt: r.created_at,
    ...(showRating ? { weightedResult: r.weighted_result, finalRating: r.final_rating } : {}),
  };
}

/** Waiting for a decision: the manager's rating (SUBMITTED) or the reviewer (IN_REVIEW); the Appraisal Reviewer's "Submitted" count. */
export const AWAITING_DECISION_STATES = ['SUBMITTED', 'IN_REVIEW'];

export interface ListQuery {
  cycleId?: string | undefined;
  state?: AppraisalRow['state'] | undefined;
  stateGroup?: 'AWAITING_DECISION' | 'AWAITING_GOAL_REVIEW' | undefined;
  employeeId?: string | undefined;
  departmentId?: string | undefined;
  page: number;
  pageSize: number;
}

/** HR oversight and team lists (FR-044) within the selected assignment's row scope. */
export async function listAppraisals(db: Queryable, grant: AccessGrant, q: ListQuery) {
  const p = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'a.company_id', employee: 'a.employee_id' }, p);
  const day = p.add(grant.businessDate);
  const where = [scope];
  if (q.cycleId) where.push(`a.cycle_id = ${p.add(q.cycleId)}::uuid`);
  if (q.state) where.push(`a.state = ${p.add(q.state)}`);
  if (q.stateGroup === 'AWAITING_DECISION') where.push(`a.state = any(${p.add(AWAITING_DECISION_STATES)}::text[])`);
  // FR-041 KRA review: complete goal sets waiting for their review (the register's "Waiting for the goal review").
  if (q.stateGroup === 'AWAITING_GOAL_REVIEW') {
    where.push(`a.state = 'DRAFT' and c.goal_review_required and a.goals_reviewed_at is null
      and (select count(*) > 0 and sum(i.weight) = 100 from appraisal_item i where i.company_id = a.company_id and i.appraisal_id = a.id and i.active)`);
  }
  if (q.employeeId) where.push(`a.employee_id = ${p.add(q.employeeId)}::uuid`);
  if (q.departmentId) where.push(`dep.department_id = ${p.add(q.departmentId)}::uuid`);
  // Added only when the rating columns use it: an unreferenced parameter has no inferable type.
  const withRating = grant.allowedFieldGroups.includes('rating');
  const columns = listColumns(withRating, withRating && grant.linkedEmployeeId ? p.add(grant.linkedEmployeeId) : null);
  const rows = (
    await db.query<ListRow>(
      `select ${columns}, count(*) over ()::int as total
         from appraisal a
         join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
         join employee e on e.company_id = a.company_id and e.id = a.employee_id
         ${CURRENT_DEPARTMENT(`${day}::date`)}
        where ${where.join(' and ')}
        order by c.start_date desc, c.code, e.employee_code, a.created_at
        limit ${p.add(q.pageSize)} offset ${p.add((q.page - 1) * q.pageSize)}`,
      p.values,
    )
  ).rows;
  return { items: rows.map((r) => listItem(grant, r, false)), total: rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize };
}

/** The caller's own appraisals (H3 TN18), newest cycle first. */
export async function listOwnAppraisals(db: Queryable, grant: AccessGrant) {
  const employeeId = ownEmployee(grant);
  const rows = (
    await db.query<ListRow>(
      `select ${listColumns(false, null)}, 0 as total
         from appraisal a
         join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
         join employee e on e.company_id = a.company_id and e.id = a.employee_id
         ${CURRENT_DEPARTMENT('$3::date')}
        where a.company_id = $1 and a.employee_id = $2
        order by c.start_date desc, a.created_at desc limit 100`,
      [grant.companyId, employeeId, grant.businessDate],
    )
  ).rows;
  return { items: rows.map((r) => listItem(grant, r, true)) };
}
