// BR-049 missed timesheets (H2 late-timesheet journey; DF12; FR-101 acceptance). A week is due by the following
// Monday; once that day has passed without a submission, an employee who was allocated to a job that week (and
// employed then) gets one pending exception and one reminder. That is all: a missing timesheet is never evidence of
// absence and never withholds, deducts or zeroes pay, attendance or leave. The exception is resolved by the (late)
// submission, or by an authorised documented resolution (e.g. the whole week was approved leave).
import { enqueueEvent } from '../../audit/audit.js';
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { type Actor, actorOf, audit, lockEmployeeTimesheets, ownEmployee } from './common.js';

/** Technical bound per company and run; a later run continues where this one stopped. */
const MAX_PER_RUN = 10_000;

/**
 * Daily (company-local `localDate`): raises the missed-submission exceptions that are due and queues one reminder
 * each. Weeks are those of the company's active allocations whose due date has passed and fell on or after the day
 * the allocation was recorded (a backdated allocation does not make earlier weeks overdue). Idempotent: an
 * employee and week has at most one exception, and each is raised in its own transaction under the employee's lock
 * (shared with submission), so a timesheet submitted meanwhile is never flagged.
 */
export async function runMissingTimesheetReminders(db: Database, companyId: string, localDate: string, systemUserId: string) {
  const candidates = (
    await db.query<{ employee_id: string; period_start: string }>(
      `with weeks as (
         select distinct a.employee_id, w.monday::date as period_start
           from resource_allocation a
           join company c on c.id = a.company_id
           cross join lateral generate_series(date_trunc('week', a.start_date::timestamp), least(a.end_date, $2::date - 8)::timestamp, interval '7 days') as w (monday)
          where a.company_id = $1 and a.state = 'ACTIVE' and a.start_date <= $2::date - 2
            and w.monday::date + 7 >= (a.created_at at time zone c.business_timezone)::date
       )
       select w.employee_id, to_char(w.period_start, 'YYYY-MM-DD') as period_start
         from weeks w
         join employee e on e.company_id = $1 and e.id = w.employee_id
        where e.joining_date <= w.period_start + 6
          and (hrms_exit_last_working_date(e.company_id, e.id) is null or hrms_exit_last_working_date(e.company_id, e.id) >= w.period_start)
          and not exists (select 1 from timesheet t where t.company_id = $1 and t.employee_id = w.employee_id and t.period_start = w.period_start and t.first_submitted_at is not null)
          and not exists (select 1 from timesheet_missing_exception x where x.company_id = $1 and x.employee_id = w.employee_id and x.period_start = w.period_start)
        order by w.period_start, w.employee_id
        limit ${MAX_PER_RUN}`,
      [companyId, localDate],
    )
  ).rows;
  const actor: Actor = { companyId, userId: systemUserId, assignmentId: null };
  let raised = 0;
  for (const c of candidates) {
    const done = await withTransaction(db, async (tx) => {
      await lockEmployeeTimesheets(tx, companyId, c.employee_id);
      const submitted = await tx.query(`select 1 from timesheet where company_id = $1 and employee_id = $2 and period_start = $3 and first_submitted_at is not null`, [
        companyId,
        c.employee_id,
        c.period_start,
      ]);
      if ((submitted.rowCount ?? 0) > 0) return false;
      const id = (
        await tx.query<{ id: string }>(
          `insert into timesheet_missing_exception (company_id, employee_id, period_start, period_end, due_date, state, raised_on, created_by, updated_by)
           values ($1, $2, $3, $3::date + 6, $3::date + 7, 'OPEN', $4, $5, $5)
           on conflict (company_id, employee_id, period_start) do nothing returning id`,
          [companyId, c.employee_id, c.period_start, localDate, systemUserId],
        )
      ).rows[0]?.id;
      if (!id) return false;
      await audit(tx, actor, 'timesheet_missing_exception', id, 'RAISE', null, { employeeId: c.employee_id, periodStart: c.period_start, state: 'OPEN', raisedOn: localDate });
      await enqueueEvent(tx, { companyId, topic: 'timesheet.missing', aggregateId: id, dedupeKey: `timesheet.missing:${id}`, payload: { exceptionId: id } });
      return true;
    });
    if (done) raised++;
  }
  return { localDate, candidates: candidates.length, raised };
}

/** The submission of the week resolves its open exception (caller holds the employee's lock). */
export async function resolveOnSubmission(tx: Queryable, actor: Actor, employeeId: string, periodStart: string, timesheetId: string): Promise<void> {
  const resolved = (
    await tx.query<{ id: string }>(
      `update timesheet_missing_exception set state = 'RESOLVED', resolution = 'SUBMITTED', timesheet_id = $4, resolved_at = now(), resolved_by = $5, updated_by = $5
        where company_id = $1 and employee_id = $2 and period_start = $3 and state = 'OPEN' returning id`,
      [actor.companyId, employeeId, periodStart, timesheetId, actor.userId],
    )
  ).rows[0];
  if (resolved) await audit(tx, actor, 'timesheet_missing_exception', resolved.id, 'RESOLVE', { state: 'OPEN' }, { state: 'RESOLVED', resolution: 'SUBMITTED', timesheetId });
}

/** BR-049 "documented resolution": an authorised reviewer closes an exception with a reason (never their own). */
export async function resolveException(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string }) {
  const pre = (await tx.query<{ employee_id: string }>(`select employee_id from timesheet_missing_exception where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!pre || !(await canAccessEmployee(tx, grant, pre.employee_id))) throw notFound();
  if (grant.linkedEmployeeId === pre.employee_id) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot resolve your own missed-timesheet exception');
  await lockEmployeeTimesheets(tx, grant.companyId, pre.employee_id);
  const x = (await tx.query<{ state: string; version: number }>(`select state, version from timesheet_missing_exception where company_id = $1 and id = $2 for update`, [grant.companyId, id])).rows[0]!;
  if (x.state !== 'OPEN') throw new HttpError(409, 'INVALID_STATE', 'The exception is already resolved');
  // I-25: a decision outside decideTask re-checks the acting assignment's permission after its locks.
  await reassertAccess(tx, grant, 'timesheet', 'resolve_exception', ['operational']);
  const reason = input.reason.trim();
  await tx.query(
    `update timesheet_missing_exception set state = 'RESOLVED', resolution = 'DOCUMENTED', resolution_reason = $3, resolved_at = now(), resolved_by = $4, updated_by = $4
      where company_id = $1 and id = $2`,
    [grant.companyId, id, reason, grant.userId],
  );
  await audit(tx, actorOf(grant), 'timesheet_missing_exception', id, 'RESOLVE', { state: 'OPEN' }, { state: 'RESOLVED', resolution: 'DOCUMENTED' }, { reason, priorVersion: x.version, newVersion: x.version + 1 });
  return exceptionView(tx, grant, id);
}

const COLUMNS = `x.id, x.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
  to_char(x.period_start, 'YYYY-MM-DD') as "periodStart", to_char(x.period_end, 'YYYY-MM-DD') as "periodEnd", to_char(x.due_date, 'YYYY-MM-DD') as "dueDate",
  to_char(x.raised_on, 'YYYY-MM-DD') as "raisedOn", x.state, x.resolution, x.resolution_reason as "resolutionReason", x.timesheet_id as "timesheetId",
  x.resolved_at as "resolvedAt", x.version`;

async function exceptionView(db: Queryable, grant: AccessGrant, id: string) {
  const row = (
    await db.query(`select ${COLUMNS} from timesheet_missing_exception x join employee e on e.company_id = x.company_id and e.id = x.employee_id where x.company_id = $1 and x.id = $2`, [
      grant.companyId,
      id,
    ])
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

/** H3 TN13 "missed reminders": the employee's own exceptions. */
/** Lists answered without page/pageSize (each list's first answer before it could page). */
export const OWN_EXCEPTION_LIST_CAP = 200;
export const EXCEPTION_LIST_CAP = 500;

/** One page (FR-056), or the first 200 without page/pageSize, newest week first; `total` counts all. */
export async function listOwnExceptions(db: Queryable, grant: AccessGrant, paging: Paging = {}) {
  const employeeId = ownEmployee(grant);
  return pageOf(
    db,
    `select ${COLUMNS} from timesheet_missing_exception x join employee e on e.company_id = x.company_id and e.id = x.employee_id
      where x.company_id = $1 and x.employee_id = $2`,
    [grant.companyId, employeeId],
    '"periodStart" desc, id',
    paging,
    OWN_EXCEPTION_LIST_CAP,
  );
}

/** Pending follow-ups for managers and HR, within row scope. */
export async function listExceptions(db: Queryable, grant: AccessGrant, q: { state?: string | undefined; from?: string | undefined; to?: string | undefined } & Paging) {
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'x.company_id', employee: 'x.employee_id' }, params);
  const where = [scope];
  if (q.state) where.push(`x.state = ${params.add(q.state)}`);
  if (q.from) where.push(`x.period_end >= ${params.add(q.from)}::date`);
  if (q.to) where.push(`x.period_start <= ${params.add(q.to)}::date`);
  // One page (FR-056), or the first 500 without page/pageSize, newest week first; `total` counts every match.
  return pageOf(
    db,
    `select ${COLUMNS} from timesheet_missing_exception x join employee e on e.company_id = x.company_id and e.id = x.employee_id
      where ${where.join(' and ')}`,
    params.values,
    '"periodStart" desc, "employeeCode", id',
    q,
    EXCEPTION_LIST_CAP,
  );
}
