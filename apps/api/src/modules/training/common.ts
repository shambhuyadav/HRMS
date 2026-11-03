// Shared helpers of the training module: scope checks, dates, controlled lists, locks, history and audit records.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, OWN_ESS_ROLE_CODES } from '../access/authorize.js';

/** Employment states in which an employee can be nominated or confirmed (as for other own requests). */
export const ACTIVE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'] as const;

/**
 * Rows in one register or export (a technical bound, the DF09 initial batch size). A larger population is refused,
 * never cut silently: a register or export must reconcile to the population it states (DF09; I-24).
 */
export const ROW_LIMIT = 10_000;

/**
 * The confidential `reason` group of training_participant (cancellation, withdrawal and attendance-correction reasons):
 * only an eligible assignment with the approved grant reads it, never through an own-ESS exception (I-16).
 */
export const withReasons = (grant: AccessGrant): boolean => grant.allowedFieldGroups.includes('reason') && !grant.ownEssFieldGroups.includes('reason');

export const MODE_LIST = 'TRAINING_MODE';
export const QUESTION_LIST = 'TRAINING_FEEDBACK_QUESTION';

export const PARTICIPATION_STATES = ['NOMINATED', 'CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW', 'CANCELLED'] as const;
export type ParticipationState = (typeof PARTICIPATION_STATES)[number];
/** Participations holding a seat (F1: capacity is taken when a nomination is confirmed and freed by cancellation). */
export const SEAT_STATES: readonly ParticipationState[] = ['CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW'];
/** Participations whose attendance was recorded: the session took place for them. */
export const OUTCOME_STATES: readonly ParticipationState[] = ['ATTENDED', 'COMPLETED', 'NO_SHOW'];

export const PLAN_VIEWS = ['FUTURE', 'CURRENT', 'PAST', 'CANCELLED'] as const;
export type PlanView = (typeof PLAN_VIEWS)[number];

/** F1 date view in SQL (migration 0036 hrms_training_plan_view), for a plan alias and a business-date parameter. */
export const viewSql = (alias: string, dayParam: string) => `hrms_training_plan_view(${alias}.state, ${alias}.start_date, ${alias}.end_date, ${dayParam}::date)`;

/** A real calendar date in ISO form (no silent roll-over such as 2026-02-30). */
export const isIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function requireDate(value: string, field: string): string {
  if (!isIsoDate(value)) throw new HttpError(422, 'INVALID_DATE', `The ${field} is not a valid date`, { field });
  return value;
}

export const blankToNull = (v: string | null | undefined): string | null => (v === undefined || v === null || v.trim() === '' ? null : v.trim());

/** % _ and \ match literally in an ILIKE pattern. */
export const likePattern = (search: string) => `%${search.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/**
 * Plans are company records, not employee-scoped: maintaining them needs an unrestricted company-scope assignment
 * (as for organisation masters and the asset register).
 */
export function isCompanyWide(grant: AccessGrant): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0;
}

export function assertCompanyWide(grant: AccessGrant): void {
  if (!isCompanyWide(grant)) throw new HttpError(403, 'FORBIDDEN', 'Maintaining training plans needs an unrestricted company-scope assignment');
}

/**
 * The caller's own employee. Own training records (H3 TN17) are served only in the Employee OWN context: BR-055
 * "non-Employee roles must select Employee context for own ESS data" (as for own appraisals and timesheets).
 */
export function ownEmployee(grant: AccessGrant): string {
  if (!OWN_ESS_ROLE_CODES.includes(grant.roleCode) || grant.scopeKind !== 'OWN' || !grant.linkedEmployeeId) {
    throw new HttpError(403, 'EMPLOYEE_CONTEXT_REQUIRED', 'Select your Employee role to work on your own training');
  }
  return grant.linkedEmployeeId;
}

/** C4 / DF02: whether the user is or was linked to the employee (any period). */
export async function userIsEmployee(db: Queryable, companyId: string, userId: string, employeeId: string): Promise<boolean> {
  const r = await db.query(`select 1 from user_employee_link where company_id = $1 and user_id = $2 and employee_id = $3`, [companyId, userId, employeeId]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * H3 TN17 "no falsified completion": in a coordinator or HR context nobody nominates themselves (the plan's
 * self-nomination setting would be bypassed) or confirms, records attendance, completes or cancels their own
 * participation; another coordinator does it.
 */
export async function assertNotSelf(db: Queryable, grant: AccessGrant, employeeId: string): Promise<void> {
  if (grant.linkedEmployeeId === employeeId || (await userIsEmployee(db, grant.companyId, grant.userId, employeeId))) {
    throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'Another coordinator records your own participation');
  }
}

export async function isActiveEmployee(db: Queryable, companyId: string, employeeId: string): Promise<boolean> {
  const r = await db.query(
    `select 1 from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
      where e.company_id = $1 and e.id = $2 and st.code = any($3::text[])`,
    [companyId, employeeId, ACTIVE_STATUSES],
  );
  return (r.rowCount ?? 0) > 0;
}

/** An active value of one of the module's controlled lists (DF04). */
export async function referenceId(db: Queryable, companyId: string, category: string, code: string, error: { code: string; message: string; field: string }): Promise<string> {
  const row = (await db.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = $2 and code = $3`, [companyId, category, code])).rows[0];
  if (!row) throw new HttpError(422, error.code, error.message, { field: error.field, value: code });
  return row.id;
}

export async function listReference(db: Queryable, companyId: string, category: string) {
  const rows = await db.query<{ code: string; label: string }>(
    `select code, label from reference_value_in_force where company_id = $1 and category = $2 order by label, code`,
    [companyId, category],
  );
  return { items: rows.rows };
}

export interface PlanLockRow {
  id: string;
  code: string;
  title: string;
  start_date: string;
  end_date: string;
  state: 'ACTIVE' | 'CANCELLED';
  capacity: number;
  self_nomination: boolean;
  version: number;
}

/**
 * The plan, locked for the rest of the transaction. Every participation change of a plan takes its row lock first
 * (FOR UPDATE), so confirmations, outcomes and cancellation serialise and capacity is never exceeded; feedback takes it
 * shared (its question set cannot change meanwhile). Lock order is always plan, then participation.
 */
export async function lockPlan(tx: Queryable, companyId: string, planId: string, mode: 'update' | 'share' = 'update'): Promise<PlanLockRow> {
  const row = (
    await tx.query<PlanLockRow>(
      `select id, code, title, to_char(start_date, 'YYYY-MM-DD') as start_date, to_char(end_date, 'YYYY-MM-DD') as end_date, state, capacity,
              self_nomination, version
         from training_plan where company_id = $1 and id = $2 for ${mode === 'update' ? 'update' : 'share'}`,
      [companyId, planId],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

export function planView(plan: Pick<PlanLockRow, 'state' | 'start_date' | 'end_date'>, today: string): PlanView {
  if (plan.state === 'CANCELLED') return 'CANCELLED';
  if (today < plan.start_date) return 'FUTURE';
  if (today > plan.end_date) return 'PAST';
  return 'CURRENT';
}

export async function seatsTaken(db: Queryable, companyId: string, planId: string): Promise<number> {
  return (
    await db.query<{ n: number }>(
      `select count(*)::int as n from training_participant where company_id = $1 and plan_id = $2 and participation_state = any($3::text[])`,
      [companyId, planId, SEAT_STATES],
    )
  ).rows[0]!.n;
}

export interface Actor {
  companyId: string;
  userId: string;
  assignmentId: string | null;
}

/**
 * Audit with the values grouped by field group (operational, cost); confidential values (feedback comments) never
 * enter the trail.
 */
export async function audit(
  tx: Queryable,
  actor: Actor,
  entry: {
    resource: 'training_plan' | 'training_participant' | 'training_feedback';
    recordKey: string;
    action: string;
    before?: Record<string, Record<string, unknown>> | null;
    after: Record<string, Record<string, unknown>>;
    reason?: string | null;
    priorVersion?: number | null;
    newVersion?: number | null;
  },
): Promise<void> {
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource: entry.resource,
    recordKey: entry.recordKey,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action: entry.action,
    priorVersion: entry.priorVersion ?? null,
    newVersion: entry.newVersion ?? null,
    before: entry.before ?? null,
    after: entry.after,
    reason: entry.reason ?? null,
  });
}

export type ParticipantAction = 'NOMINATE' | 'SELF_NOMINATE' | 'CONFIRM' | 'MARK_ATTENDED' | 'MARK_NO_SHOW' | 'COMPLETE' | 'CANCEL' | 'WITHDRAW' | 'PLAN_CANCELLED';

/** Outbox topic raised for a participation change (DF12), when the participant is to be told. */
const TOPICS: Partial<Record<ParticipantAction, string>> = {
  NOMINATE: 'training.nominated',
  CONFIRM: 'training.confirmed',
  CANCEL: 'training.participation_cancelled',
  PLAN_CANCELLED: 'training.plan_cancelled',
  COMPLETE: 'training.completed',
};

/**
 * Records one participation change: the history entry (DF08), the audit record and, where the participant is told,
 * the outbox event (ids only). Called after the participation row was updated in the same transaction.
 */
export async function recordChange(
  tx: Queryable,
  actor: Actor,
  change: { participantId: string; planId: string; employeeId: string; action: ParticipantAction; from: ParticipationState | null; to: ParticipationState; reason: string | null },
): Promise<void> {
  const eventId = (
    await tx.query<{ id: string }>(
      `insert into training_participant_event (company_id, participant_id, plan_id, employee_id, action, from_state, to_state, reason, actor_user_id,
                                               acting_assignment_id, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9) returning id`,
      [actor.companyId, change.participantId, change.planId, change.employeeId, change.action, change.from, change.to, change.reason, actor.userId, actor.assignmentId],
    )
  ).rows[0]!.id;
  await audit(tx, actor, {
    resource: 'training_participant',
    recordKey: change.participantId,
    action: change.action,
    before: change.from ? { operational: { state: change.from } } : null,
    after: { operational: { state: change.to, planId: change.planId, employeeId: change.employeeId } },
    reason: change.reason,
  });
  const topic = TOPICS[change.action];
  if (topic) {
    await enqueueEvent(tx, {
      companyId: actor.companyId,
      topic,
      aggregateId: change.participantId,
      dedupeKey: `${topic}:${eventId}`,
      payload: { participantId: change.participantId, planId: change.planId, state: change.to },
    });
  }
}
