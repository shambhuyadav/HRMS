// FR-047 timesheet entry, approval and locking (DB070/DB071; F1 "Timesheets"; DF03; DF08; CI14).
// One timesheet per employee and Monday-Sunday week, entered and submitted in the Employee OWN context and reviewed
// by the direct manager (HR fallback list when the manager is ineligible). Every line lies in the week, within the
// employment and an active allocation of the job, on an active, in-period project/job/activity the job permits, in
// positive quarter hours; a day holds at most 24 hours across all lines, manual and imported alike; duplicate lines
// are rejected; time is recorded for days already worked. Submission is due by the following Monday: a later one is
// accepted and flagged late, with no other effect. Approval locks the revision. A return or a rejection keeps the
// revision and its reason; the employee continues in a new revision linked to it (lines carried over). An approved
// timesheet changes only through an independent authorised reopen (reopen.ts), which opens the next revision; every
// approved revision stays identifiable (original and correction) for later payroll adjustments (H2; BR-048).
import { enqueueEvent } from '../../audit/audit.js';
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { type Decision, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import {
  type Actor,
  actorOf,
  addDays,
  audit,
  type Employment,
  employedOn,
  employmentOf,
  hoursOf,
  isActiveStatus,
  isIsoDate,
  isoWeekday,
  lockEmployeeTimesheets,
  ownEmployee,
} from './common.js';
import { resolveOnSubmission } from './exceptions.js';

export const TIMESHEET_KIND = 'timesheet';
/** F1: at most 24 hours on one day. */
export const DAILY_LIMIT_MINUTES = 24 * 60;

export interface SheetRow {
  id: string;
  employee_id: string;
  transaction_id: string;
  period_start: string;
  period_end: string;
  due_date: string;
  state: string;
  current_revision: number;
  approved_revision: number | null;
  first_submitted_at: Date | null;
  late: boolean | null;
  version: number;
}

export const SHEET_COLUMNS = `t.id, t.employee_id, t.transaction_id, to_char(t.period_start, 'YYYY-MM-DD') as period_start, to_char(t.period_end, 'YYYY-MM-DD') as period_end,
  to_char(t.due_date, 'YYYY-MM-DD') as due_date, t.state, t.current_revision, t.approved_revision, t.first_submitted_at, t.late, t.version`;

/** The timesheet behind its transaction lock (taken first, before any row lock). */
export async function lockSheet(tx: Queryable, companyId: string, where: string, params: unknown[]): Promise<SheetRow | undefined> {
  const target = (await tx.query<{ transaction_id: string }>(`select t.transaction_id from timesheet t where t.company_id = $1 and ${where}`, [companyId, ...params])).rows[0];
  if (!target) return undefined;
  await lockTransaction(tx, target.transaction_id);
  return (await tx.query<SheetRow>(`select ${SHEET_COLUMNS} from timesheet t where t.company_id = $1 and ${where} for update`, [companyId, ...params])).rows[0];
}

async function lockOwnSheet(tx: Queryable, grant: AccessGrant, id: string): Promise<SheetRow> {
  const s = await lockSheet(tx, grant.companyId, 't.id = $2 and t.employee_id = $3', [id, ownEmployee(grant)]);
  if (!s) throw notFound();
  return s;
}

function assertEditable(s: SheetRow): void {
  if (s.state !== 'DRAFT') {
    throw new HttpError(409, 'TIMESHEET_NOT_EDITABLE', 'Only a draft revision can be changed; an approved timesheet is corrected through a reopen request', { state: s.state });
  }
}

/** Every line change bumps the timesheet's version, so a submission names the exact set of lines it sends. */
async function touchSheet(tx: Queryable, companyId: string, id: string, actorUserId: string): Promise<void> {
  await tx.query(`update timesheet set updated_by = $3 where company_id = $1 and id = $2`, [companyId, id, actorUserId]);
}

async function setSheetState(tx: Queryable, companyId: string, s: Pick<SheetRow, 'id' | 'transaction_id'>, state: string, actorUserId: string, extra = '', extraValues: unknown[] = []) {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, s.transaction_id, state, actorUserId]);
  await tx.query(`update timesheet set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2`, [companyId, s.id, state, actorUserId, ...extraValues]);
}

// ---------------------------------------------------------------------------------------------------------------
// Opening a week
// ---------------------------------------------------------------------------------------------------------------

/**
 * The employee's timesheet for the week starting `periodStart` (a Monday), created as a DRAFT revision 1 when it
 * does not exist yet. Serialised per employee (lock order: employee, then transaction).
 */
export async function openSheet(tx: Queryable, actor: Actor, businessDate: string, employeeId: string, periodStart: string): Promise<{ id: string; created: boolean }> {
  if (!isIsoDate(periodStart) || isoWeekday(periodStart) !== 1) {
    throw new HttpError(422, 'INVALID_PERIOD', 'A timesheet covers a Monday-Sunday week; give the Monday it starts on', { field: 'periodStart' });
  }
  if (periodStart > businessDate) throw new HttpError(422, 'PERIOD_IN_FUTURE', 'Time is recorded for a week that has started');
  const employment = await employmentOf(tx, actor.companyId, employeeId);
  if (!employment) throw notFound();
  if (!isActiveStatus(employment.status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only an active employee records time');
  const periodEnd = addDays(periodStart, 6);
  if (periodEnd < employment.joiningDate || (employment.lastWorkingDate !== null && periodStart > employment.lastWorkingDate)) {
    throw new HttpError(422, 'OUTSIDE_EMPLOYMENT', 'The week is outside the employment');
  }
  await lockEmployeeTimesheets(tx, actor.companyId, employeeId);
  const existing = (await tx.query<{ id: string }>(`select id from timesheet where company_id = $1 and employee_id = $2 and period_start = $3`, [actor.companyId, employeeId, periodStart])).rows[0];
  if (existing) return { id: existing.id, created: false };
  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'DRAFT', $4, $4) returning id`,
      [actor.companyId, TIMESHEET_KIND, employeeId, actor.userId],
    )
  ).rows[0]!.id;
  const id = (
    await tx.query<{ id: string }>(
      `insert into timesheet (company_id, employee_id, period_start, period_end, due_date, transaction_id, state, current_revision, created_by, updated_by)
       values ($1, $2, $3, $3::date + 6, $3::date + 7, $4, 'DRAFT', 1, $5, $5) returning id`,
      [actor.companyId, employeeId, periodStart, transactionId, actor.userId],
    )
  ).rows[0]!.id;
  await tx.query(
    `insert into timesheet_revision (company_id, timesheet_id, employee_id, revision, origin, state, created_by, updated_by) values ($1, $2, $3, 1, 'INITIAL', 'DRAFT', $4, $4)`,
    [actor.companyId, id, employeeId, actor.userId],
  );
  await audit(tx, actor, 'timesheet', id, 'CREATE', null, { employeeId, periodStart, periodEnd, dueDate: addDays(periodStart, 7), revision: 1, state: 'DRAFT' }, { newVersion: 1 });
  return { id, created: true };
}

export async function createOwnTimesheet(tx: Queryable, grant: AccessGrant, input: { periodStart: string }) {
  const opened = await openSheet(tx, actorOf(grant), grant.businessDate, ownEmployee(grant), input.periodStart);
  if (!opened.created) throw new HttpError(409, 'TIMESHEET_EXISTS', 'You already have a timesheet for this week', { timesheetId: opened.id });
  return timesheetDetail(tx, grant, opened.id, {});
}

// ---------------------------------------------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------------------------------------------

export interface LineInput {
  workDate: string;
  jobId: string;
  activityId: string;
  minutes: number;
  note?: string | null | undefined;
}

interface EntryFacts {
  project_id: string;
  masters_active: boolean;
  job_in_period: boolean;
  activity_known: boolean;
  activity_active: boolean | null;
  activity_in_period: boolean | null;
  productive: boolean | null;
  linked: boolean;
  allocated: boolean;
}

/** Every rule an entry must meet when it is recorded or posted (F1; FR-045; FR-047; CI14). */
export async function checkEntry(tx: Queryable, companyId: string, employment: Employment, employeeId: string, s: Pick<SheetRow, 'period_start' | 'period_end'>, e: LineInput, today: string) {
  if (!isIsoDate(e.workDate)) throw new HttpError(422, 'INVALID_DATE', 'The work date is not a valid date', { field: 'workDate' });
  if (e.workDate < s.period_start || e.workDate > s.period_end) throw new HttpError(422, 'OUTSIDE_PERIOD', 'The work date is outside the timesheet week', { field: 'workDate' });
  if (e.workDate > today) throw new HttpError(422, 'WORK_DATE_IN_FUTURE', 'Time is recorded for days already worked', { field: 'workDate' });
  if (!Number.isInteger(e.minutes) || e.minutes <= 0 || e.minutes % 15 !== 0 || e.minutes > DAILY_LIMIT_MINUTES) {
    throw new HttpError(422, 'INVALID_MINUTES', 'Time is recorded in positive quarter hours (multiples of 15 minutes), at most 24 hours', { field: 'minutes' });
  }
  if (!employedOn(employment, e.workDate)) throw new HttpError(422, 'OUTSIDE_EMPLOYMENT', 'The work date is outside the employment', { field: 'workDate' });
  const f = (
    await tx.query<EntryFacts>(
      `select j.project_id, j.active and p.active as masters_active,
              (j.start_date <= $4::date and (j.end_date is null or j.end_date >= $4::date) and p.start_date <= $4::date and (p.end_date is null or p.end_date >= $4::date)) as job_in_period,
              a.id is not null as activity_known, a.active as activity_active,
              (a.start_date <= $4::date and (a.end_date is null or a.end_date >= $4::date)) as activity_in_period, a.productive,
              coalesce(ja.active, false) as linked,
              exists (select 1 from resource_allocation r where r.company_id = $1 and r.employee_id = $5 and r.job_id = j.id and r.state = 'ACTIVE'
                         and r.start_date <= $4::date and r.end_date >= $4::date) as allocated
         from timesheet_job j
         join timesheet_project p on p.company_id = j.company_id and p.id = j.project_id
         left join timesheet_activity a on a.company_id = j.company_id and a.id = $3
         left join timesheet_job_activity ja on ja.company_id = j.company_id and ja.job_id = j.id and ja.activity_id = $3
        where j.company_id = $1 and j.id = $2`,
      [companyId, e.jobId, e.activityId, e.workDate, employeeId],
    )
  ).rows[0];
  if (!f) throw new HttpError(422, 'UNKNOWN_JOB', 'The job does not exist in this company', { field: 'jobId' });
  if (!f.activity_known) throw new HttpError(422, 'UNKNOWN_ACTIVITY', 'The activity does not exist in this company', { field: 'activityId' });
  if (!f.masters_active || !f.activity_active) throw new HttpError(422, 'INACTIVE_MASTER', 'The project, job or activity is not active');
  if (!f.job_in_period || !f.activity_in_period) throw new HttpError(422, 'MASTER_OUT_OF_PERIOD', 'The project, job or activity is not valid on the work date');
  if (!f.linked) throw new HttpError(422, 'ACTIVITY_NOT_PERMITTED', 'The job does not permit this activity');
  if (!f.allocated) throw new HttpError(422, 'NO_ACTIVE_ALLOCATION', 'You are not allocated to this job on the work date');
  return { projectId: f.project_id, productive: f.productive === true };
}

/** Duplicate and daily-total checks within the revision (the database re-checks both). */
async function checkRevisionTotals(tx: Queryable, companyId: string, s: SheetRow, e: LineInput, excludeLineId: string | null): Promise<void> {
  const r = (
    await tx.query<{ total: number; duplicate: boolean }>(
      `select coalesce(sum(minutes), 0)::int as total, coalesce(bool_or(job_id = $5 and activity_id = $6), false) as duplicate
         from timesheet_line where company_id = $1 and timesheet_id = $2 and revision = $3 and work_date = $4 and removed_at is null and ($7::uuid is null or id <> $7::uuid)`,
      [companyId, s.id, s.current_revision, e.workDate, e.jobId, e.activityId, excludeLineId],
    )
  ).rows[0]!;
  if (r.duplicate) throw new HttpError(409, 'DUPLICATE_LINE', 'There is already a line for this day, job and activity; change its time instead');
  if (r.total + e.minutes > DAILY_LIMIT_MINUTES) {
    throw new HttpError(422, 'DAILY_LIMIT_EXCEEDED', `The lines of ${e.workDate} would total more than 24 hours`, { workDate: e.workDate, totalMinutes: r.total + e.minutes });
  }
}

const noteOf = (note: string | null | undefined) => (note?.trim() ? note.trim() : null);

/** Records one line in the draft revision; the caller holds the timesheet lock and has checked access. */
export async function insertLine(tx: Queryable, actor: Actor, today: string, s: SheetRow, input: LineInput, source: 'MANUAL' | 'IMPORT'): Promise<string> {
  assertEditable(s);
  const employment = await employmentOf(tx, actor.companyId, s.employee_id);
  if (!employment || !isActiveStatus(employment.status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only an active employee records time');
  const { projectId, productive } = await checkEntry(tx, actor.companyId, employment, s.employee_id, s, input, today);
  await checkRevisionTotals(tx, actor.companyId, s, input, null);
  const note = noteOf(input.note);
  const id = (
    await tx.query<{ id: string }>(
      `insert into timesheet_line (company_id, timesheet_id, employee_id, revision, period_start, work_date, project_id, job_id, activity_id, minutes, productive, note, source, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14) returning id`,
      [actor.companyId, s.id, s.employee_id, s.current_revision, s.period_start, input.workDate, projectId, input.jobId, input.activityId, input.minutes, productive, note, source, actor.userId],
    )
  ).rows[0]!.id;
  await touchSheet(tx, actor.companyId, s.id, actor.userId);
  await audit(tx, actor, 'timesheet_line', id, 'CREATE', null, {
    timesheetId: s.id,
    revision: s.current_revision,
    workDate: input.workDate,
    projectId,
    jobId: input.jobId,
    activityId: input.activityId,
    minutes: input.minutes,
    productive,
    note,
    source,
  });
  return id;
}

export async function addOwnLine(tx: Queryable, grant: AccessGrant, timesheetId: string, input: LineInput) {
  const s = await lockOwnSheet(tx, grant, timesheetId);
  const lineId = await insertLine(tx, actorOf(grant), grant.businessDate, s, input, 'MANUAL');
  return { lineId, ...(await timesheetDetail(tx, grant, timesheetId, {})) };
}

interface LineRow {
  id: string;
  work_date: string;
  job_id: string;
  activity_id: string;
  project_id: string;
  minutes: number;
  productive: boolean;
  note: string | null;
  source: string;
  version: number;
}

async function lockLine(tx: Queryable, companyId: string, s: SheetRow, lineId: string): Promise<LineRow> {
  const l = (
    await tx.query<LineRow>(
      `select id, to_char(work_date, 'YYYY-MM-DD') as work_date, job_id, activity_id, project_id, minutes, productive, note, source, version
         from timesheet_line where company_id = $1 and timesheet_id = $2 and revision = $3 and id = $4 and removed_at is null for update`,
      [companyId, s.id, s.current_revision, lineId],
    )
  ).rows[0];
  if (!l) throw notFound();
  return l;
}

export async function updateOwnLine(tx: Queryable, grant: AccessGrant, timesheetId: string, lineId: string, patch: Partial<LineInput> & { expectedVersion: number }) {
  const s = await lockOwnSheet(tx, grant, timesheetId);
  assertEditable(s);
  const l = await lockLine(tx, grant.companyId, s, lineId);
  if (l.version !== patch.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The line changed; reload and retry');
  const next: LineInput = {
    workDate: patch.workDate ?? l.work_date,
    jobId: patch.jobId ?? l.job_id,
    activityId: patch.activityId ?? l.activity_id,
    minutes: patch.minutes ?? l.minutes,
    note: patch.note === undefined ? l.note : noteOf(patch.note),
  };
  const employment = await employmentOf(tx, grant.companyId, s.employee_id);
  if (!employment || !isActiveStatus(employment.status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only an active employee records time');
  // An edited line is recorded anew: it must meet today's rules and takes the activity's current classification.
  const { projectId, productive } = await checkEntry(tx, grant.companyId, employment, s.employee_id, s, next, grant.businessDate);
  await checkRevisionTotals(tx, grant.companyId, s, next, l.id);
  await tx.query(
    `update timesheet_line set work_date = $3, project_id = $4, job_id = $5, activity_id = $6, minutes = $7, productive = $8, note = $9, updated_by = $10
      where company_id = $1 and id = $2`,
    [grant.companyId, l.id, next.workDate, projectId, next.jobId, next.activityId, next.minutes, productive, next.note ?? null, grant.userId],
  );
  await touchSheet(tx, grant.companyId, s.id, grant.userId);
  await audit(
    tx,
    actorOf(grant),
    'timesheet_line',
    l.id,
    'UPDATE',
    { workDate: l.work_date, projectId: l.project_id, jobId: l.job_id, activityId: l.activity_id, minutes: l.minutes, productive: l.productive, note: l.note },
    { workDate: next.workDate, projectId, jobId: next.jobId, activityId: next.activityId, minutes: next.minutes, productive, note: next.note ?? null },
    { priorVersion: l.version, newVersion: l.version + 1 },
  );
  return timesheetDetail(tx, grant, timesheetId, {});
}

/** A draft line is removed by marking it (kept on record, DF08). */
export async function removeOwnLine(tx: Queryable, grant: AccessGrant, timesheetId: string, lineId: string) {
  const s = await lockOwnSheet(tx, grant, timesheetId);
  assertEditable(s);
  const l = await lockLine(tx, grant.companyId, s, lineId);
  await tx.query(`update timesheet_line set removed_at = now(), removed_by = $3, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, l.id, grant.userId]);
  await touchSheet(tx, grant.companyId, s.id, grant.userId);
  await audit(tx, actorOf(grant), 'timesheet_line', l.id, 'REMOVE', { workDate: l.work_date, jobId: l.job_id, activityId: l.activity_id, minutes: l.minutes }, { removed: true });
  return timesheetDetail(tx, grant, timesheetId, {});
}

// ---------------------------------------------------------------------------------------------------------------
// Submission, revision and decisions
// ---------------------------------------------------------------------------------------------------------------

export async function submitTimesheet(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  const employeeId = ownEmployee(grant);
  const pre = await tx.query(`select 1 from timesheet where company_id = $1 and id = $2 and employee_id = $3`, [grant.companyId, id, employeeId]);
  if ((pre.rowCount ?? 0) === 0) throw notFound();
  // Lock order: the employee (shared with the missed-submission job), then the transaction, then rows.
  await lockEmployeeTimesheets(tx, grant.companyId, employeeId);
  const s = await lockOwnSheet(tx, grant, id);
  if (s.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision can be submitted', { state: s.state });
  if (s.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The timesheet changed; reload and retry');
  const employment = await employmentOf(tx, grant.companyId, employeeId);
  if (!employment || !isActiveStatus(employment.status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only an active employee submits time');

  // CI14: posting re-checks every line, except one carried unchanged that the approved revision in force already holds
  // (a correction after a reopen; FR-045 acceptance). A line carried from a returned or rejected revision was never
  // approved, so it is checked again; passing changes nothing, and it keeps the classification it was entered with.
  const lines = (
    await tx.query<{ id: string; work_date: string; job_id: string; activity_id: string; minutes: number; approved: boolean }>(
      `select l.id, to_char(l.work_date, 'YYYY-MM-DD') as work_date, l.job_id, l.activity_id, l.minutes,
              (l.source = 'CARRIED' and l.version = 1 and exists (
                 select 1 from timesheet_line a
                  where a.company_id = l.company_id and a.timesheet_id = l.timesheet_id and a.revision = $4 and a.removed_at is null
                    and a.work_date = l.work_date and a.job_id = l.job_id and a.activity_id = l.activity_id and a.minutes = l.minutes)) as approved
         from timesheet_line l where l.company_id = $1 and l.timesheet_id = $2 and l.revision = $3 and l.removed_at is null order by l.work_date, l.id`,
      [grant.companyId, s.id, s.current_revision, s.approved_revision],
    )
  ).rows;
  const problems: { lineId: string; workDate: string; code: string }[] = [];
  for (const l of lines) {
    if (l.approved) continue;
    try {
      await checkEntry(tx, grant.companyId, employment, employeeId, s, { workDate: l.work_date, jobId: l.job_id, activityId: l.activity_id, minutes: l.minutes }, grant.businessDate);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      problems.push({ lineId: l.id, workDate: l.work_date, code: err.code });
    }
  }
  if (problems.length > 0) throw new HttpError(422, 'LINES_INVALID', 'Some lines no longer meet the entry rules; correct or remove them', { lines: problems });

  // F1: due by the following Monday; a later submission is accepted and flagged late (no penalty).
  const late = grant.businessDate > s.due_date;
  await tx.query(
    `update timesheet_revision set state = 'SUBMITTED', submitted_at = now(), submitted_by = $4, submitted_on = $5, late = $6, updated_by = $4
      where company_id = $1 and timesheet_id = $2 and revision = $3`,
    [grant.companyId, s.id, s.current_revision, grant.userId, grant.businessDate, late],
  );
  const first = s.first_submitted_at === null;
  await setSheetState(
    tx,
    grant.companyId,
    s,
    'SUBMITTED',
    grant.userId,
    first ? ', first_submitted_at = now(), first_submitted_on = $5, late = $6' : '',
    first ? [grant.businessDate, late] : [],
  );
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: TIMESHEET_KIND, transactionId: s.transaction_id, ownerEmployeeId: employeeId, actorUserId: grant.userId });
  await resolveOnSubmission(tx, actorOf(grant), employeeId, s.period_start, s.id);
  const totalMinutes = lines.reduce((sum, l) => sum + l.minutes, 0);
  await audit(tx, actorOf(grant), 'timesheet', s.id, 'SUBMIT', { state: 'DRAFT' }, { state: 'SUBMITTED', revision: s.current_revision, late, lineCount: lines.length, totalMinutes });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'timesheet.submitted',
    aggregateId: s.id,
    dedupeKey: `timesheet.submitted:${s.id}:${s.current_revision}`,
    payload: { timesheetId: s.id, revision: s.current_revision, taskId },
  });
  return { timesheetId: s.id, revision: s.current_revision, state: 'SUBMITTED', late };
}

/**
 * Opens the next revision as a DRAFT with the previous revision's lines carried over, and moves the timesheet and its
 * transaction to it (the previous revision stays as it was). The caller holds the transaction lock.
 */
export async function openNextRevision(tx: Queryable, actor: Actor, s: SheetRow, origin: 'RETURNED' | 'REJECTED' | 'REOPENED', reopenRequestId: string | null): Promise<number> {
  const next = s.current_revision + 1;
  await tx.query(
    `insert into timesheet_revision (company_id, timesheet_id, employee_id, revision, origin, previous_revision, reopen_request_id, state, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, 'DRAFT', $8, $8)`,
    [actor.companyId, s.id, s.employee_id, next, origin, s.current_revision, reopenRequestId, actor.userId],
  );
  await tx.query(
    `insert into timesheet_line (company_id, timesheet_id, employee_id, revision, period_start, work_date, project_id, job_id, activity_id, minutes, productive, note, source,
                                 carried_from_line_id, created_by, updated_by)
     select company_id, timesheet_id, employee_id, $4, period_start, work_date, project_id, job_id, activity_id, minutes, productive, note, 'CARRIED', id, $5, $5
       from timesheet_line where company_id = $1 and timesheet_id = $2 and revision = $3 and removed_at is null`,
    [actor.companyId, s.id, s.current_revision, next, actor.userId],
  );
  await tx.query(`update business_transaction set revision = $3, state = 'DRAFT', updated_by = $4 where company_id = $1 and id = $2`, [actor.companyId, s.transaction_id, next, actor.userId]);
  await tx.query(`update timesheet set current_revision = $3, state = 'DRAFT', updated_by = $4 where company_id = $1 and id = $2`, [actor.companyId, s.id, next, actor.userId]);
  return next;
}

/** DF03: after a return or a rejection the employee continues in a new revision linked to the decided one. */
export async function reviseTimesheet(tx: Queryable, grant: AccessGrant, id: string) {
  const s = await lockOwnSheet(tx, grant, id);
  if (s.state !== 'RETURNED' && s.state !== 'REJECTED') {
    throw new HttpError(409, 'INVALID_STATE', 'Only a returned or rejected timesheet is revised; an approved one needs a reopen request', { state: s.state });
  }
  const revision = await openNextRevision(tx, actorOf(grant), s, s.state, null);
  await audit(tx, actorOf(grant), 'timesheet', s.id, 'REVISE', { state: s.state, revision: s.current_revision }, { state: 'DRAFT', revision });
  return timesheetDetail(tx, grant, s.id, {});
}

/** The caller's pending task of one of `kinds` and its transaction; anyone else's task reads as missing. */
export async function taskTransaction(tx: Queryable, grant: AccessGrant, taskId: string, kinds: readonly string[]): Promise<string> {
  const t = (
    await tx.query<{ transaction_id: string; kind: string }>(
      `select i.transaction_id, i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [grant.companyId, taskId, grant.userId],
    )
  ).rows[0];
  if (!t || !kinds.includes(t.kind)) throw notFound();
  return t.transaction_id;
}

/** ZT07: a recorded decision with the same key replays; the key on another task is a conflict. */
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

export interface DecisionInput {
  decision: Decision;
  /** Shown to the employee; required to return or reject (FR-047 "rejected entries retain reason"). */
  reason?: string | undefined;
  idempotencyKey: string;
}

export async function decideTimesheet(tx: Queryable, grant: AccessGrant, taskId: string, input: DecisionInput) {
  const reason = input.reason?.trim() || null;
  if (input.decision !== 'APPROVE' && !reason) throw new HttpError(422, 'REASON_REQUIRED', 'Explain to the employee why the timesheet is returned or rejected');
  const transactionId = await taskTransaction(tx, grant, taskId, [TIMESHEET_KIND]);
  await lockTransaction(tx, transactionId);
  const s = (await tx.query<SheetRow>(`select ${SHEET_COLUMNS} from timesheet t where t.company_id = $1 and t.transaction_id = $2 for update`, [grant.companyId, transactionId])).rows[0];
  // C4: the reviewer must still see the employee in the selected assignment's scope.
  if (!s || !(await canAccessEmployee(tx, grant, s.employee_id))) throw notFound();
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { timesheetId: s.id, revision: s.current_revision, state: s.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (s.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This timesheet is not waiting for a decision');

  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: reason ?? undefined, idempotencyKey: input.idempotencyKey, permission: { resource: 'timesheet', action: 'approve' } });
  if (result.replayed) return { timesheetId: s.id, revision: s.current_revision, state: s.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { timesheetId: s.id, revision: s.current_revision, state: s.state, replayed: false };
  const state = result.outcome;
  await tx.query(
    `update timesheet_revision set state = $4, decided_at = now(), decided_by = $5, decision_reason = $6, updated_by = $5
      where company_id = $1 and timesheet_id = $2 and revision = $3`,
    [grant.companyId, s.id, s.current_revision, state, grant.userId, reason],
  );
  if (state === 'APPROVED') {
    // A correction replaces the approved revision in force; the original stays approved and points to its successor.
    if (s.approved_revision !== null) {
      await tx.query(
        `update timesheet_revision set superseded_at = now(), superseded_by_revision = $4, updated_by = $5 where company_id = $1 and timesheet_id = $2 and revision = $3`,
        [grant.companyId, s.id, s.approved_revision, s.current_revision, grant.userId],
      );
    }
    await setSheetState(tx, grant.companyId, s, 'APPROVED', grant.userId, ', approved_revision = current_revision');
  } else {
    await setSheetState(tx, grant.companyId, s, state, grant.userId);
  }
  await audit(
    tx,
    actorOf(grant),
    'timesheet',
    s.id,
    input.decision,
    { state: 'SUBMITTED', revision: s.current_revision },
    { state, revision: s.current_revision, ...(state === 'APPROVED' ? { approvedRevision: s.current_revision, supersededRevision: s.approved_revision } : {}) },
    { reason },
  );
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'timesheet.decided',
    aggregateId: s.id,
    dedupeKey: `timesheet.decided:${s.id}:${s.current_revision}`,
    payload: { timesheetId: s.id, revision: s.current_revision, outcome: state },
  });
  return { timesheetId: s.id, revision: s.current_revision, state, replayed: false };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

/** One timesheet with its revisions, the lines of one revision (default: the current one) and its history. */
export async function timesheetDetail(db: Queryable, grant: AccessGrant, id: string, q: { revision?: number | undefined }) {
  const s = (
    await db.query<SheetRow & { employee_code: string; employee_name: string }>(
      `select ${SHEET_COLUMNS}, e.employee_code, e.display_name as employee_name from timesheet t join employee e on e.company_id = t.company_id and e.id = t.employee_id
        where t.company_id = $1 and t.id = $2`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!s || !(await canAccessEmployee(db, grant, s.employee_id))) throw notFound();
  const shown = q.revision ?? s.current_revision;
  const revisions = (
    await db.query<{ revision: number }>(
      `select r.revision, r.origin, r.previous_revision as "previousRevision", r.reopen_request_id as "reopenRequestId", r.state,
              r.submitted_at as "submittedAt", to_char(r.submitted_on, 'YYYY-MM-DD') as "submittedOn", r.late, r.decided_at as "decidedAt", r.decision_reason as "decisionReason",
              r.superseded_at as "supersededAt", r.superseded_by_revision as "supersededByRevision",
              (select count(*)::int from timesheet_line l where l.company_id = r.company_id and l.timesheet_id = r.timesheet_id and l.revision = r.revision and l.removed_at is null) as "lineCount",
              (select coalesce(sum(l.minutes), 0)::int from timesheet_line l where l.company_id = r.company_id and l.timesheet_id = r.timesheet_id and l.revision = r.revision and l.removed_at is null) as "totalMinutes"
         from timesheet_revision r where r.company_id = $1 and r.timesheet_id = $2 order by r.revision`,
      [grant.companyId, id],
    )
  ).rows;
  if (!revisions.some((r) => r.revision === shown)) throw notFound();
  const lines = (
    await db.query<{ workDate: string; minutes: number }>(
      `select l.id, to_char(l.work_date, 'YYYY-MM-DD') as "workDate", l.project_id as "projectId", p.code as "projectCode", p.name as "projectName",
              l.job_id as "jobId", j.code as "jobCode", j.name as "jobName", l.activity_id as "activityId", a.code as "activityCode", a.name as "activityName",
              l.minutes, l.productive, l.note, l.source, l.carried_from_line_id as "carriedFromLineId", l.version
         from timesheet_line l
         join timesheet_project p on p.company_id = l.company_id and p.id = l.project_id
         join timesheet_job j on j.company_id = l.company_id and j.id = l.job_id
         join timesheet_activity a on a.company_id = l.company_id and a.id = l.activity_id
        where l.company_id = $1 and l.timesheet_id = $2 and l.revision = $3 and l.removed_at is null
        order by l.work_date, p.code, j.code, a.code`,
      [grant.companyId, id, shown],
    )
  ).rows;
  const daily = new Map<string, number>();
  for (const l of lines) daily.set(l.workDate, (daily.get(l.workDate) ?? 0) + l.minutes);
  const pendingWith = (
    await db.query<{ name: string }>(
      `select coalesce(pe.display_name, 'Reviewer') as name
         from approval_instance i join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'PENDING'
         left join user_employee_link l on l.company_id = t.company_id and l.user_id = t.assignee_user_id
              and l.effective_from <= $3::date and (l.effective_to is null or l.effective_to > $3::date)
         left join employee pe on pe.company_id = l.company_id and pe.id = l.employee_id
        where i.company_id = $1 and i.transaction_id = $2 and i.state = 'ACTIVE' limit 1`,
      [grant.companyId, s.transaction_id, grant.businessDate],
    )
  ).rows[0];
  const decisions = (
    await db.query(
      `select i.transaction_revision as revision, d.decision, d.occurred_at as "decidedAt"
         from approval_instance i join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
        where i.company_id = $1 and i.transaction_id = $2 order by d.occurred_at`,
      [grant.companyId, s.transaction_id],
    )
  ).rows;
  const reopenRequests = (
    await db.query(
      `select r.id, r.approved_revision as "approvedRevision", r.reason, r.state, r.new_revision as "newRevision", r.created_at as "requestedAt", r.decided_at as "decidedAt"
         from timesheet_reopen_request r where r.company_id = $1 and r.timesheet_id = $2 order by r.created_at`,
      [grant.companyId, id],
    )
  ).rows;
  return {
    id: s.id,
    employeeId: s.employee_id,
    employeeCode: s.employee_code,
    employeeName: s.employee_name,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    dueDate: s.due_date,
    state: s.state,
    currentRevision: s.current_revision,
    approvedRevision: s.approved_revision,
    firstSubmittedAt: s.first_submitted_at,
    late: s.late,
    version: s.version,
    shownRevision: shown,
    revisions,
    lines,
    dailyTotals: [...daily.entries()].map(([workDate, minutes]) => ({ workDate, minutes, hours: hoursOf(minutes) })),
    totalMinutes: lines.reduce((sum, l) => sum + l.minutes, 0),
    pendingWith: pendingWith?.name ?? null,
    decisions,
    reopenRequests,
  };
}

const LIST_COLUMNS = `t.id, t.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
  to_char(t.period_start, 'YYYY-MM-DD') as "periodStart", to_char(t.period_end, 'YYYY-MM-DD') as "periodEnd", to_char(t.due_date, 'YYYY-MM-DD') as "dueDate",
  t.state, t.current_revision as "currentRevision", t.approved_revision as "approvedRevision", t.first_submitted_at as "firstSubmittedAt", t.late, t.version,
  (select coalesce(sum(l.minutes), 0)::int from timesheet_line l where l.company_id = t.company_id and l.timesheet_id = t.id and l.revision = t.current_revision and l.removed_at is null) as "totalMinutes",
  (select coalesce(sum(l.minutes), 0)::int from timesheet_line l where l.company_id = t.company_id and l.timesheet_id = t.id and l.revision = t.approved_revision and l.removed_at is null) as "approvedMinutes"`;

export interface SheetQuery extends Paging {
  from?: string | undefined;
  to?: string | undefined;
  state?: string | undefined;
  employeeId?: string | undefined;
}

/** Lists answered without page/pageSize (each list's first answer before it could page). */
export const SHEET_LIST_CAP = 500;
export const OWN_SHEET_LIST_CAP = 200;

/**
 * CL-138 HR view and the manager's team view: timesheets whose week overlaps [from, to], within row scope, newest
 * week first: one page (FR-056), or the first 500 without page/pageSize; `total` counts every match.
 */
export async function listTimesheets(db: Queryable, grant: AccessGrant, q: SheetQuery) {
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 't.company_id', employee: 't.employee_id' }, params);
  const where = [scope];
  if (q.from) where.push(`t.period_end >= ${params.add(q.from)}::date`);
  if (q.to) where.push(`t.period_start <= ${params.add(q.to)}::date`);
  if (q.state) where.push(`t.state = ${params.add(q.state)}`);
  if (q.employeeId) where.push(`t.employee_id = ${params.add(q.employeeId)}::uuid`);
  return pageOf(
    db,
    `select ${LIST_COLUMNS} from timesheet t join employee e on e.company_id = t.company_id and e.id = t.employee_id where ${where.join(' and ')}`,
    params.values,
    '"periodStart" desc, "employeeCode", id',
    q,
    SHEET_LIST_CAP,
  );
}

/** The employee's own weeks, newest first: one page (FR-056), or the first 200 without page/pageSize; `total` counts all. */
export async function listOwnTimesheets(db: Queryable, grant: AccessGrant, q: { from?: string | undefined; to?: string | undefined } & Paging) {
  const employeeId = ownEmployee(grant);
  return pageOf(
    db,
    `select ${LIST_COLUMNS} from timesheet t join employee e on e.company_id = t.company_id and e.id = t.employee_id
      where t.company_id = $1 and t.employee_id = $2 and ($3::date is null or t.period_end >= $3::date) and ($4::date is null or t.period_start <= $4::date)`,
    [grant.companyId, employeeId, q.from ?? null, q.to ?? null],
    '"periodStart" desc, id',
    q,
    OWN_SHEET_LIST_CAP,
  );
}

/** The reviewer's open timesheet tasks, each with what it decides (operational only). */
export async function timesheetTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, TIMESHEET_KIND)).items as { taskId: string; transactionId: string }[];
  if (tasks.length === 0) return { items: [] };
  const rows = (
    await db.query<{ transactionId: string; employeeId: string }>(
      `select t.transaction_id as "transactionId", ${LIST_COLUMNS},
              (select r.late from timesheet_revision r where r.company_id = t.company_id and r.timesheet_id = t.id and r.revision = t.current_revision) as "revisionLate"
         from timesheet t join employee e on e.company_id = t.company_id and e.id = t.employee_id
        where t.company_id = $1 and t.transaction_id = any($2::uuid[])`,
      [grant.companyId, tasks.map((t) => t.transactionId)],
    )
  ).rows;
  const items = [];
  for (const t of tasks) {
    const row = rows.find((r) => r.transactionId === t.transactionId);
    const visible = row !== undefined && (await canAccessEmployee(db, grant, row.employeeId));
    items.push({ ...t, timesheet: visible ? row : null });
  }
  return { items };
}
