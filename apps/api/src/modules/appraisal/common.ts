// Appraisal module helpers shared by settings, cycles, appraisals, self-entry, review, reports and the goal upload.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, OWN_ESS_ROLE_CODES, taskDelegationLive } from '../access/authorize.js';
import { lockTransaction } from '../workflow/engine.js';

export const APPRAISAL_KIND = 'appraisal';
/** F1 explicit second reviewer level: its own typed transaction, routed with the appraisal list. */
export const SECOND_REVIEW_KIND = 'appraisal_second_review';
export type TaskKind = typeof APPRAISAL_KIND | typeof SECOND_REVIEW_KIND;
export const TASK_KINDS: readonly string[] = [APPRAISAL_KIND, SECOND_REVIEW_KIND];

/**
 * Presented step numbers: 1 = the manager's rating, 2 = reviewer level 1 (both on the appraisal route), 3 = reviewer
 * level 2 (the second-review route's only step).
 */
export const presentedStep = (kind: string, sequence: number) => (kind === SECOND_REVIEW_KIND ? 3 : sequence);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ACTIVE_EMPLOYEE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'];

/** FR-040 windows: goal setting (KRA), the employee's self-entry and the manager's rating. */
export const STAGES = ['GOAL_SETTING', 'SELF_ENTRY', 'MANAGER_RATING'] as const;
export type Stage = (typeof STAGES)[number];

export type Actor = Pick<AccessGrant, 'companyId' | 'userId' | 'assignmentId'>;

export interface CycleRow {
  id: string;
  code: string;
  name: string;
  start_date: string;
  end_date: string;
  approval_levels: number;
  goal_opens_on: string | null;
  goal_closes_on: string | null;
  self_opens_on: string | null;
  self_closes_on: string | null;
  rating_opens_on: string | null;
  rating_closes_on: string | null;
  state: 'OPEN' | 'CLOSED';
  version: number;
}

export const CYCLE_COLUMNS = `c.id, c.code, c.name, c.start_date, c.end_date, c.approval_levels, c.goal_opens_on, c.goal_closes_on,
  c.self_opens_on, c.self_closes_on, c.rating_opens_on, c.rating_closes_on, c.state, c.version`;

export async function loadCycle(db: Queryable, companyId: string, cycleId: string, lock: '' | 'for share' | 'for update' = ''): Promise<CycleRow | undefined> {
  return (await db.query<CycleRow>(`select ${CYCLE_COLUMNS} from appraisal_cycle c where c.company_id = $1 and c.id = $2 ${lock}`, [companyId, cycleId])).rows[0];
}

export interface AppraisalRow {
  id: string;
  cycle_id: string;
  employee_id: string;
  transaction_id: string;
  state: 'DRAFT' | 'SUBMITTED' | 'IN_REVIEW' | 'RETURNED' | 'APPROVED' | 'CANCELLED';
  revision: number;
  source: 'MANUAL' | 'UPLOAD';
  version: number;
}

const APPRAISAL_COLUMNS = 'a.id, a.cycle_id, a.employee_id, a.transaction_id, a.state, a.revision, a.source, a.version';

export async function readAppraisal(db: Queryable, companyId: string, id: string, lock = false): Promise<AppraisalRow | undefined> {
  return (await db.query<AppraisalRow>(`select ${APPRAISAL_COLUMNS} from appraisal a where a.company_id = $1 and a.id = $2 ${lock ? 'for update' : ''}`, [companyId, id])).rows[0];
}

/** The appraisal behind its transaction lock (taken first, before any row lock), then row-locked. */
export async function lockAppraisal(tx: Queryable, companyId: string, id: string): Promise<AppraisalRow | undefined> {
  const target = (await tx.query<{ transaction_id: string }>(`select transaction_id from appraisal where company_id = $1 and id = $2`, [companyId, id])).rows[0];
  if (!target) return undefined;
  await lockTransaction(tx, target.transaction_id);
  return readAppraisal(tx, companyId, id, true);
}

export async function lockAppraisalByTransaction(tx: Queryable, companyId: string, transactionId: string): Promise<AppraisalRow | undefined> {
  await lockTransaction(tx, transactionId);
  return (await tx.query<AppraisalRow>(`select ${APPRAISAL_COLUMNS} from appraisal a where a.company_id = $1 and a.transaction_id = $2 for update`, [companyId, transactionId])).rows[0];
}

export interface RevisionRow {
  id: string;
  revision: number;
  state: 'DRAFT' | 'SUBMITTED' | 'RATED' | 'CONFIRMED' | 'RETURNED' | 'CANCELLED';
  self_comment: string | null;
  approval_levels: number | null;
  weighted_result: string | null;
}

/** The appraisal's working revision (the one its `revision` points at), row-locked when asked. */
export async function workingRevision(db: Queryable, companyId: string, a: Pick<AppraisalRow, 'id' | 'revision'>, lock = false): Promise<RevisionRow> {
  const row = (
    await db.query<RevisionRow>(
      `select id, revision, state, self_comment, approval_levels, weighted_result from appraisal_revision
        where company_id = $1 and appraisal_id = $2 and revision = $3 ${lock ? 'for update' : ''}`,
      [companyId, a.id, a.revision],
    )
  ).rows[0];
  if (!row) throw new Error(`appraisal ${a.id} has no revision ${a.revision}`);
  return row;
}

export interface GoalRow {
  id: string;
  sequence: number;
  description: string;
  target: string | null;
  weight: number;
}

export async function activeGoals(db: Queryable, companyId: string, appraisalId: string): Promise<GoalRow[]> {
  return (
    await db.query<GoalRow>(
      `select id, sequence, description, target, weight from appraisal_item where company_id = $1 and appraisal_id = $2 and active order by sequence`,
      [companyId, appraisalId],
    )
  ).rows;
}

export function windowOf(c: CycleRow, stage: Stage): { opensOn: string | null; closesOn: string | null } {
  if (stage === 'GOAL_SETTING') return { opensOn: c.goal_opens_on, closesOn: c.goal_closes_on };
  if (stage === 'SELF_ENTRY') return { opensOn: c.self_opens_on, closesOn: c.self_closes_on };
  return { opensOn: c.rating_opens_on, closesOn: c.rating_closes_on };
}

export interface WindowStatus {
  stage: Stage;
  opensOn: string | null;
  closesOn: string | null;
  /** The scheduled window includes the business date (inclusive dates). */
  openToday: boolean;
  /** Latest still-valid authorised exception for this appraisal and stage (inclusive), if any. */
  exceptionUntil: string | null;
  /** Entries at this stage are accepted today: open cycle and an open window or a valid exception. */
  entryAllowed: boolean;
}

/** Latest valid exception date per stage for one appraisal (valid through the date, inclusive). */
export async function exceptionsUntil(db: Queryable, companyId: string, appraisalId: string, today: string): Promise<Partial<Record<Stage, string>>> {
  const rows = (
    await db.query<{ stage: Stage; until: string }>(
      `select stage, max(valid_until) as until from appraisal_window_exception
        where company_id = $1 and appraisal_id = $2 and valid_until >= $3::date group by stage`,
      [companyId, appraisalId, today],
    )
  ).rows;
  return Object.fromEntries(rows.map((r) => [r.stage, r.until]));
}

export function windowStatus(c: CycleRow, stage: Stage, today: string, exceptions: Partial<Record<Stage, string>>): WindowStatus {
  const { opensOn, closesOn } = windowOf(c, stage);
  const openToday = opensOn !== null && closesOn !== null && opensOn <= today && today <= closesOn;
  const exceptionUntil = exceptions[stage] ?? null;
  return { stage, opensOn, closesOn, openToday, exceptionUntil, entryAllowed: c.state === 'OPEN' && (openToday || exceptionUntil !== null) };
}

/**
 * FR-040: entries outside an open window are refused unless an authorised exception for this appraisal and stage is
 * still valid. A closed cycle accepts nothing.
 */
export async function requireEntryWindow(db: Queryable, companyId: string, appraisalId: string | null, c: CycleRow, stage: Stage, today: string): Promise<void> {
  if (c.state !== 'OPEN') throw new HttpError(409, 'CYCLE_CLOSED', 'The appraisal cycle is closed');
  const exceptions = appraisalId ? await exceptionsUntil(db, companyId, appraisalId, today) : {};
  const status = windowStatus(c, stage, today, exceptions);
  if (!status.entryAllowed) {
    throw new HttpError(422, 'WINDOW_CLOSED', `The ${stage.toLowerCase().replace('_', ' ')} window is not open today and no exception is recorded`, {
      stage,
      opensOn: status.opensOn,
      closesOn: status.closesOn,
    });
  }
}

/** Audit with operational values only: scores, comments, results and reasons never enter the before/after values. */
export async function audit(
  tx: Queryable,
  actor: Actor,
  resource: 'appraisal' | 'appraisal_cycle' | 'appraisal_setting',
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

/** Moves the appraisal and its business transaction together (the deferred mirror trigger checks them at commit). */
export async function setAppraisalState(
  tx: Queryable,
  companyId: string,
  a: Pick<AppraisalRow, 'id' | 'transaction_id'>,
  state: AppraisalRow['state'],
  userId: string,
  extra = '',
  extraValues: unknown[] = [],
): Promise<void> {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, a.transaction_id, state, userId]);
  await tx.query(`update appraisal set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2`, [companyId, a.id, state, userId, ...extraValues]);
}

export interface SecondReview {
  id: string;
  transaction_id: string;
  revision_id: string;
  state: string;
}

/** Moves a second-level review and its business transaction together. */
export async function setSecondReviewState(tx: Queryable, companyId: string, sr: Pick<SecondReview, 'id' | 'transaction_id'>, state: 'APPROVED' | 'RETURNED' | 'CANCELLED', userId: string): Promise<void> {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, sr.transaction_id, state, userId]);
  await tx.query(`update appraisal_second_review set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, sr.id, state, userId]);
}

/** Bumps the appraisal's version for a change held in its child rows (goals, entries, comments). */
export async function touchAppraisal(tx: Queryable, companyId: string, id: string, userId: string): Promise<number> {
  return (await tx.query<{ version: number }>(`update appraisal set updated_by = $3 where company_id = $1 and id = $2 returning version`, [companyId, id, userId])).rows[0]!.version;
}

export function checkVersion(actual: number, expected: number): void {
  if (actual !== expected) throw new HttpError(409, 'STALE_VERSION', 'The appraisal changed; reload and retry');
}

/** Trimmed text, or null when absent or blank. */
export function optionalText(value: string | null | undefined): string | null {
  const v = value?.trim();
  return v ? v : null;
}

export function requireText(value: string | null | undefined, field: string): string {
  const v = optionalText(value);
  if (!v) throw new HttpError(422, 'FIELD_REQUIRED', `${field} is required`, { field });
  return v;
}

export const isIsoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function requireDate(value: string, field: string): string {
  if (!isIsoDate(value)) throw new HttpError(422, 'INVALID_DATE', 'The date is not a valid calendar date', { field });
  return value;
}

/** Company-wide configuration needs an unrestricted company-scope assignment (as organisation masters do). */
export function requireUnrestricted(grant: AccessGrant): void {
  const f = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || f.departments.length + f.locations.length + f.employees.length > 0) {
    throw new HttpError(403, 'FORBIDDEN', 'Appraisal configuration needs an unrestricted company-scope assignment');
  }
}

/** C4 spirit: nobody manages, cancels or grants exceptions on their own appraisal. */
export function refuseOwnRecord(grant: AccessGrant, employeeId: string): void {
  if (grant.linkedEmployeeId === employeeId) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot manage your own appraisal');
}

/** BR-055: own appraisal data is served only in the Employee OWN context; other roles switch to it. */
export function ownEmployee(grant: AccessGrant): string {
  if (!OWN_ESS_ROLE_CODES.includes(grant.roleCode) || grant.scopeKind !== 'OWN' || !grant.linkedEmployeeId) {
    throw new HttpError(403, 'EMPLOYEE_CONTEXT_REQUIRED', 'Select your Employee role to work on your own appraisal');
  }
  return grant.linkedEmployeeId;
}

/** The appraisal's own transaction and those of its second-level reviews. */
export async function relatedTransactions(db: Queryable, companyId: string, a: Pick<AppraisalRow, 'id' | 'transaction_id'>): Promise<string[]> {
  const reviews = (await db.query<{ transaction_id: string }>(`select transaction_id from appraisal_second_review where company_id = $1 and appraisal_id = $2`, [companyId, a.id])).rows;
  return [a.transaction_id, ...reviews.map((r) => r.transaction_id)];
}

/** The pending task of the transactions' active approvals with its presented step, if any. */
export async function pendingTaskOf(db: Queryable, companyId: string, transactionIds: readonly string[]) {
  const row = (
    await db.query<{ id: string; assignee_user_id: string; sequence: number; kind: string; action: string }>(
      `select t.id, t.assignee_user_id, s.sequence, i.transaction_kind as kind, p.action from approval_instance i
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'PENDING'
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         join permission p on p.id = s.permission_id
        where i.company_id = $1 and i.transaction_id = any($2::uuid[]) and i.state = 'ACTIVE' order by t.created_at desc limit 1`,
      [companyId, transactionIds],
    )
  ).rows[0];
  return row ? { ...row, step: presentedStep(row.kind, row.sequence) } : undefined;
}

/** The transaction and kind of a task assigned to the user when it is an appraisal task; anything else reads as missing. */
export async function taskTransaction(db: Queryable, companyId: string, taskId: string, userId: string): Promise<{ transactionId: string; kind: TaskKind } | undefined> {
  const t = (
    await db.query<{ transaction_id: string; kind: string }>(
      `select i.transaction_id, i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [companyId, taskId, userId],
    )
  ).rows[0];
  return t && TASK_KINDS.includes(t.kind) ? { transactionId: t.transaction_id, kind: t.kind as TaskKind } : undefined;
}

/** Idempotent replay lookup: the task an idempotency key was used for, if it was. */
export async function priorDecisionTask(db: Queryable, companyId: string, idempotencyKey: string): Promise<string | undefined> {
  return (await db.query<{ task_id: string }>(`select task_id from approval_decision where company_id = $1 and idempotency_key = $2`, [companyId, idempotencyKey])).rows[0]?.task_id;
}

/** The pending appraisal task assigned to the user, with its presented step (1 = rating, 2/3 = reviewer levels). */
export async function pendingTaskStep(db: Queryable, companyId: string, taskId: string, userId: string): Promise<{ step: number; action: string } | undefined> {
  const row = (
    await db.query<{ sequence: number; kind: string; action: string }>(
      `select s.sequence, i.transaction_kind as kind, p.action from approval_task t
         join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE' and i.transaction_kind = any($4::text[])
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         join permission p on p.id = s.permission_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3 and t.state = 'PENDING' and ${taskDelegationLive('t')}`,
      [companyId, taskId, userId, TASK_KINDS],
    )
  ).rows[0];
  return row ? { step: presentedStep(row.kind, row.sequence), action: row.action } : undefined;
}

/** The step action (rate or confirm) of an appraisal task assigned to the user, if any (pending or not). */
export async function taskAction(db: Queryable, companyId: string, userId: string, taskId: string): Promise<'rate' | 'confirm' | null> {
  if (!UUID.test(taskId)) return null;
  const row = (
    await db.query<{ action: string }>(
      `select p.action from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.transaction_kind = any($4::text[])
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id join permission p on p.id = s.permission_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [companyId, taskId, userId, TASK_KINDS],
    )
  ).rows[0];
  return row?.action === 'rate' || row?.action === 'confirm' ? row.action : null;
}
