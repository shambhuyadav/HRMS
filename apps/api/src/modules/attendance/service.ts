// Attendance daily processing and amendment (FR-020, FR-021, FR-022; DF05; DF09). Punch ingestion: punch-import.ts.
//
// Decided under owner delegation, 6 Nov 2026 (owner chose process rules only; I-78): punches are read from the capture
// window of the shift revision in force, its buffer before the start and after the end (item 1, 0180); a half weekly-off
// is evaluated against half the shift (item 4, 0182); results carry late minutes and, under a policy with overtime rules,
// overtime candidates (items 5 and 6, 0181). Nothing here values or pays overtime.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, assertNotOwnRecord, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { UnitFailure } from '../bulk/retry.js';
import { halfWeeklyOffSql, holidaySql, weeklyOffSql } from '../shift/calendar.js';
import { type AttendanceStatus, carriesOvertime, carriesShiftFlags, type DayInput, evaluateDay, type OvertimeRule } from './evaluate.js';

const ACTIVE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'];
/** Statuses after the employment ended: such an employee is processed only up to an approved last working date. */
const ENDED_STATUSES = ['INACTIVE_SEPARATED', 'ARCHIVED'];

interface PolicyRow {
  id: string;
  grace_minutes: number;
  present_percent: string;
  half_day_percent: string;
  overtime_basis: OvertimeRule['basis'] | null;
  overtime_minimum_minutes: number | null;
  overtime_rounding_minutes: number | null;
  specificity: number;
}

/** The overtime rules of a policy revision, when its setting is on and its rules are set (0181). */
const overtimeRuleOf = (p: PolicyRow): OvertimeRule | null =>
  p.overtime_basis && p.overtime_minimum_minutes !== null && p.overtime_rounding_minutes !== null
    ? { basis: p.overtime_basis, minimumMinutes: p.overtime_minimum_minutes, roundingMinutes: p.overtime_rounding_minutes }
    : null;

async function selectAttendancePolicy(tx: Queryable, companyId: string, employeeId: string, day: string): Promise<PolicyRow | null> {
  const rows = (
    await tx.query<PolicyRow>(
      `select p.id, p.grace_minutes, p.present_percent::text, p.half_day_percent::text,
              case when p.overtime_enabled then p.overtime_basis end as overtime_basis, p.overtime_minimum_minutes, p.overtime_rounding_minutes,
              max(num_nonnulls(m.grade_id, m.location_id))::int as specificity
         from attendance_policy p
         join attendance_policy_mapping m on m.company_id = p.company_id and m.policy_id = p.id
         left join employment_assignment ea on ea.company_id = p.company_id and ea.employee_id = $2
               and ea.effective_from <= $3::date and (ea.effective_to is null or ea.effective_to > $3::date)
        where p.company_id = $1 and (p.state = 'ACTIVE' or (p.state = 'RETIRED' and p.effective_to is not null))
          and p.effective_from <= $3::date and (p.effective_to is null or p.effective_to > $3::date)
          and (m.grade_id is null or m.grade_id = ea.grade_id)
          and (m.location_id is null or m.location_id = ea.location_id)
        group by p.id order by specificity desc`,
      [companyId, employeeId, day],
    )
  ).rows;
  if (rows.length === 0) return null;
  if (rows[1] && rows[1].specificity === rows[0]!.specificity) throw new HttpError(422, 'POLICY_AMBIGUOUS', 'More than one attendance policy applies equally');
  return rows[0]!;
}

async function statusId(tx: Queryable, companyId: string, code: AttendanceStatus | string): Promise<string> {
  const row = (
    await tx.query<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'ATTENDANCE_STATUS' and code = $2 and active`, [companyId, code])
  ).rows[0];
  if (!row) throw new HttpError(422, 'INVALID_REFERENCE', `Unknown attendance status ${code}`);
  return row.id;
}

type Outcome = 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'SKIPPED_AMENDED' | 'SKIPPED_LOCKED' | 'NO_POLICY';

/**
 * BR-047, BR-037, ZT36: a frozen payroll record used this day (0111: a calculated record covering the day, up to the
 * business date it was frozen), so its attendance is final. The covering records are share-locked: processing that is
 * freezing one right now is waited for and then seen, and it cannot freeze the record until this transaction ends.
 */
async function dayUsedByProcessedPayroll(tx: Queryable, companyId: string, employeeId: string, day: string): Promise<boolean> {
  const rows = (
    await tx.query<{ used: boolean }>(
      `select r.frozen_at is not null and r.calculation_status = 'CALCULATED' and $3::date <= hrms_business_date(r.company_id, r.frozen_at) as used
         from payroll_record r
        where r.company_id = $1 and r.employee_id = $2 and r.eligible_from <= $3::date and r.eligible_to >= $3::date
        for share of r`,
      [companyId, employeeId, day],
    )
  ).rows;
  return rows.some((r) => r.used);
}

/** Amendments and corrections of a day a processed payroll used are refused; a later change is an adjustment, which waits for the owner (FR-035, FR-100). */
export async function refuseIfPayrollLocked(tx: Queryable, companyId: string, employeeId: string, day: string): Promise<void> {
  if (await dayUsedByProcessedPayroll(tx, companyId, employeeId, day)) {
    throw new HttpError(409, 'PAYROLL_LOCKED', 'A processed payroll used this day; its attendance can no longer change here', { workDate: day });
  }
}

/** The result's values at this moment, kept before a change (FR-021, DB027). The caller holds the record's lock. */
const REVISION_COLUMNS = `company_id, attendance_record_id, prior_version, shift_id, policy_id, scheduled_net_minutes, worked_minutes, late, early_departure,
  status_id, exception_code, amended, calculation_count, cause, bulk_job_id, amendment_id, actor_id, created_by, late_minutes, overtime_candidate_minutes, early_departure_minutes`;

async function evaluateEmployeeDay(tx: Queryable, grant: AccessGrant, jobId: string, employeeId: string, day: string): Promise<Outcome> {
  // First: a locked day is not even evaluated, so a policy problem elsewhere in the month cannot fail the run for it.
  if (await dayUsedByProcessedPayroll(tx, grant.companyId, employeeId, day)) return 'SKIPPED_LOCKED';
  const policy = await selectAttendancePolicy(tx, grant.companyId, employeeId, day);
  if (!policy) return 'NO_POLICY';

  const ctx = (
    await tx.query<{
      shift_id: string | null;
      shift_revision_id: string | null;
      start_ms: string | null;
      minutes: number | null;
      buffer_minutes: number | null;
      weekly_off: boolean;
      half_off: boolean;
      holiday: boolean;
      leave: 'NONE' | 'FULL' | 'HALF';
      duty_full: boolean;
    }>(
      // The shift's times and buffer in force on this day (DF05: effective-dated), and the location calendar of this day.
      `with c as (select business_timezone as tz from company where id = $1),
            sa as (select a.shift_id as id, f.* from shift_assignment a cross join lateral hrms_shift_in_force(a.company_id, a.shift_id, $3::date) f
                    where a.company_id = $1 and a.employee_id = $2 and a.effective_from <= $3::date
                      and (a.effective_to is null or a.effective_to > $3::date))
       select (select id from sa) as shift_id,
              (select revision_id from sa) as shift_revision_id,
              (select (extract(epoch from (($3::date + sa.in_time) at time zone c.tz)) * 1000)::bigint::text from sa, c) as start_ms,
              (select minutes from sa) as minutes,
              (select hrms_shift_buffer($1, sa.id, sa.revision_id) from sa) as buffer_minutes,
              ${weeklyOffSql('$3', '$2', '$1')} as weekly_off,
              ${halfWeeklyOffSql('$3', '$2', '$1')} as half_off,
              ${holidaySql('$3', '$2', '$1')} as holiday,
              coalesce((select case when lr.half_day then 'HALF' else 'FULL' end from leave_request lr
                         where lr.company_id = $1 and lr.employee_id = $2 and lr.state = 'APPROVED'
                           and lr.start_date <= $3::date and lr.end_date >= $3::date limit 1), 'NONE') as leave,
              exists (select 1 from outdoor_duty_request od where od.company_id = $1 and od.employee_id = $2 and od.state = 'APPROVED'
                        and od.start_time is null and od.start_date <= $3::date and od.end_date >= $3::date) as duty_full`,
      [grant.companyId, employeeId, day],
    )
  ).rows[0]!;

  let shift: DayInput['shift'] = null;
  let punches: DayInput['punches'] = [];
  // I-78 item 1: the capture window is the buffer of the shift revision in force, each side of the shift.
  const bufferMs = (ctx.buffer_minutes ?? 0) * 60_000;
  if (ctx.shift_id && ctx.start_ms && ctx.minutes) {
    const startMs = Number(ctx.start_ms);
    const breaks = (
      await tx.query<{ s: number; e: number }>(`select start_offset_minutes as s, end_offset_minutes as e from hrms_shift_breaks($1, $2, $3)`, [
        grant.companyId,
        ctx.shift_id,
        ctx.shift_revision_id,
      ])
    ).rows;
    const breakMinutes = breaks.reduce((sum, b) => sum + (b.e - b.s), 0);
    shift = {
      startMs,
      endMs: startMs + ctx.minutes * 60_000,
      breaks: breaks.map((b) => ({ startMs: startMs + b.s * 60_000, endMs: startMs + b.e * 60_000 })),
      netMinutes: ctx.minutes - breakMinutes,
    };
    punches = (
      await tx.query<{ at_ms: string; direction: 'IN' | 'OUT' }>(
        `select (extract(epoch from occurred_at) * 1000)::bigint::text as at_ms, direction from attendance_punch
          where company_id = $1 and employee_id = $2 and occurred_at >= to_timestamp($3::bigint / 1000.0) and occurred_at < to_timestamp($4::bigint / 1000.0)
          order by occurred_at`,
        [grant.companyId, employeeId, startMs - bufferMs, shift.endMs + bufferMs],
      )
    ).rows.map((r) => ({ atMs: Number(r.at_ms), direction: r.direction }));
  }

  // The shift's capture window, as instants (the same window the punches above were read from).
  const capture = shift && {
    from: new Date(shift.startMs - bufferMs).toISOString(),
    to: new Date(shift.endMs + bufferMs).toISOString(),
  };

  // DF09: if a biometric source linked to this employee failed for the capture window and no completed run
  // covers it, missing punches are a source exception, not absence.
  let sourceUnavailable = false;
  if (capture && punches.length === 0) {
    const { from, to } = capture;
    sourceUnavailable = (
      await tx.query<{ unavailable: boolean }>(
        `select exists (
           select 1 from biometric_employee_link l
             join biometric_sync_run r on r.company_id = l.company_id and r.profile_id = l.profile_id and r.state in ('FAILED', 'PARTIAL')
                  and tstzrange(r.window_start, r.window_end) && tstzrange($3::timestamptz, $4::timestamptz)
            where l.company_id = $1 and l.employee_id = $2 and l.effective_from < $4::timestamptz and (l.effective_to is null or l.effective_to > $3::timestamptz)
              and not exists (select 1 from biometric_sync_run ok where ok.company_id = r.company_id and ok.profile_id = r.profile_id and ok.state = 'COMPLETED'
                                 and ok.window_start <= $3::timestamptz and ok.window_end >= $4::timestamptz and ok.started_at > r.started_at)
         ) as unavailable`,
        [grant.companyId, employeeId, from, to],
      )
    ).rows[0]!.unavailable;
  }

  // FR-027 approved timed outdoor duty, as instants in the company timezone. A window is requested on its start
  // date and ends on the next calendar day when its end time is not after its start time (migration 0025). Like
  // punches, a window belongs to the shift whose capture window it overlaps, clipped to that window, so an
  // overnight shift keeps its after-midnight duty time (DF05: the shift belongs to its start date). Without a
  // shift there is no capture window and the day is an exception anyway.
  let dutyIntervals: DayInput['dutyIntervals'] = [];
  if (capture) {
    dutyIntervals = (
      await tx.query<{ s: string; e: string }>(
        `select (extract(epoch from greatest(w.s, $3::timestamptz)) * 1000)::bigint::text as s,
                (extract(epoch from least(w.e, $4::timestamptz)) * 1000)::bigint::text as e
           from outdoor_duty_request od
           join company c on c.id = od.company_id
           cross join lateral (
             select (od.start_date + od.start_time) at time zone c.business_timezone as s,
                    ((case when od.end_time > od.start_time then od.start_date else od.start_date + 1 end) + od.end_time) at time zone c.business_timezone as e
           ) w
          where od.company_id = $1 and od.employee_id = $2 and od.state = 'APPROVED' and od.start_time is not null
            and w.s < $4::timestamptz and w.e > $3::timestamptz`,
        [grant.companyId, employeeId, capture.from, capture.to],
      )
    ).rows.map((r) => ({ startMs: Number(r.s), endMs: Number(r.e) }));
  }

  const result = evaluateDay({
    offDay: ctx.holiday ? 'HOLIDAY' : ctx.weekly_off ? 'WEEKLY_OFF' : null,
    halfOff: ctx.half_off,
    leave: ctx.leave,
    shift,
    punches,
    sourceUnavailable,
    dutyFullDay: ctx.duty_full,
    dutyIntervals,
    policy: { graceMinutes: policy.grace_minutes, presentPercent: Number(policy.present_percent), halfDayPercent: Number(policy.half_day_percent), overtime: overtimeRuleOf(policy) },
  });

  const newStatusId = await statusId(tx, grant.companyId, result.status);
  const lockExisting = async () =>
    (await tx.query<{ id: string; amended: boolean }>(`select id, amended from attendance_record where company_id = $1 and employee_id = $2 and work_date = $3 for update`, [grant.companyId, employeeId, day]))
      .rows[0];
  let existing = await lockExisting();
  if (!existing) {
    const created = await tx.query(
      `insert into attendance_record (company_id, employee_id, work_date, shift_id, policy_id, scheduled_net_minutes, worked_minutes,
                                      late, early_departure, status_id, exception_code, created_by, updated_by, shift_revision_id, late_minutes, overtime_candidate_minutes,
                                      early_departure_minutes)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12, $13, $14, $15, $16)
       on conflict (company_id, employee_id, work_date) do nothing`,
      [
        grant.companyId,
        employeeId,
        day,
        ctx.shift_id,
        policy.id,
        result.scheduledNetMinutes,
        result.workedMinutes,
        result.late,
        result.earlyDeparture,
        newStatusId,
        result.exceptionCode,
        grant.userId,
        ctx.shift_revision_id,
        result.lateMinutes,
        result.overtimeCandidateMinutes,
        result.earlyDepartureMinutes,
      ],
    );
    if (created.rowCount) return 'CREATED';
    existing = (await lockExisting())!; // another run created it meanwhile
  }
  if (existing.amended) return 'SKIPPED_AMENDED';
  // The values being replaced, with this job as the cause (FR-021), only when the result or its basis really changes.
  const changed = await tx.query(
    `insert into attendance_record_revision (${REVISION_COLUMNS})
     select r.company_id, r.id, r.version, r.shift_id, r.policy_id, r.scheduled_net_minutes, r.worked_minutes, r.late, r.early_departure,
            r.status_id, r.exception_code, r.amended, r.calculation_count, 'PROCESSING', $10::uuid, null, $11::uuid, $11::uuid, r.late_minutes, r.overtime_candidate_minutes,
            r.early_departure_minutes
       from attendance_record r
      where r.company_id = $1 and r.id = $2
        and (r.shift_id, r.shift_revision_id, r.policy_id, r.scheduled_net_minutes, r.worked_minutes, r.late, r.early_departure, r.status_id, r.exception_code,
             r.late_minutes, r.overtime_candidate_minutes, r.early_departure_minutes)
            is distinct from ($3::uuid, $13::uuid, $4::uuid, $5::int, $6::int, $7::boolean, $8::boolean, $9::uuid, $12::text, $14::int, $15::int, $16::int)`,
    [
      grant.companyId,
      existing.id,
      ctx.shift_id,
      policy.id,
      result.scheduledNetMinutes,
      result.workedMinutes,
      result.late,
      result.earlyDeparture,
      newStatusId,
      jobId,
      grant.userId,
      result.exceptionCode,
      ctx.shift_revision_id,
      result.lateMinutes,
      result.overtimeCandidateMinutes,
      result.earlyDepartureMinutes,
    ],
  );
  if (!changed.rowCount) return 'UNCHANGED';
  await tx.query(
    `update attendance_record
        set shift_id = $3, shift_revision_id = $12, policy_id = $4, scheduled_net_minutes = $5, worked_minutes = $6, late = $7, early_departure = $8, status_id = $9, exception_code = $10,
            late_minutes = $13, overtime_candidate_minutes = $14, early_departure_minutes = $15, calculation_count = calculation_count + 1, updated_by = $11
      where company_id = $1 and id = $2`,
    [
      grant.companyId,
      existing.id,
      ctx.shift_id,
      policy.id,
      result.scheduledNetMinutes,
      result.workedMinutes,
      result.late,
      result.earlyDeparture,
      newStatusId,
      result.exceptionCode,
      grant.userId,
      ctx.shift_revision_id,
      result.lateMinutes,
      result.overtimeCandidateMinutes,
      result.earlyDepartureMinutes,
    ],
  );
  return 'UPDATED';
}

/**
 * Totals of an FR-022 processing run: the employees evaluated and each outcome. Counts only: the employees without a
 * policy are rows of the job (attendance_processing_no_policy, 0058; processingNoPolicy reads them).
 */
export interface ProcessingTotals extends Record<Outcome, number> {
  workDate: string;
  employees: number;
}

export const emptyProcessingTotals = (day: string): ProcessingTotals => ({
  workDate: day,
  employees: 0,
  CREATED: 0,
  UPDATED: 0,
  UNCHANGED: 0,
  SKIPPED_AMENDED: 0,
  SKIPPED_LOCKED: 0,
  NO_POLICY: 0,
});

/**
 * With employedOnDay: who a processing run covers on a work date (the rule on processDateChunk). The attendance registers and
 * the attendance dashboard (day-facts.ts) cover the same employees, so their counts reconcile with processing (BR-026).
 */
export const EMPLOYED_ON_DAY_JOINS = `join reference_value st on st.company_id = e.company_id and st.id = e.status_id
         cross join lateral (select hrms_exit_last_working_date(e.company_id, e.id) as last_working_date) x`;

export const employedOnDay = (day: string, params: SqlParams) =>
  `e.joining_date <= ${day}::date
          and (st.code = any(${params.add(ACTIVE_STATUSES)}::text[]) or (st.code = any(${params.add(ENDED_STATUSES)}::text[]) and x.last_working_date is not null))
          and (x.last_working_date is null or x.last_working_date >= ${day}::date)`;

/** Writes employees of job `jobId` found without a policy as its rows; one per job and employee, so a second write is a no-op. */
async function recordNoPolicy(tx: Queryable, grant: AccessGrant, jobId: string, employeeIds: string[]): Promise<void> {
  if (employeeIds.length === 0) return;
  await tx.query(
    `insert into attendance_processing_no_policy (company_id, bulk_job_id, employee_id, employee_code, created_by, updated_by)
     select e.company_id, $2, e.id, e.employee_code, $3, $3 from employee e where e.company_id = $1 and e.id = any($4::uuid[])
     on conflict (company_id, bulk_job_id, employee_id) do nothing`,
    [grant.companyId, jobId, grant.userId, employeeIds],
  );
}

/**
 * FR-022 processing run for one work date over the actor's scope, one bounded chunk at a time (NFR-S09: the bulk-job
 * worker runs it, never a request; modules/bulk). Covers the next `size` in-scope employees employed on the work date
 * in employee-code order after `afterCode`, adds their outcomes to `totals` and writes the employees without a policy
 * as rows of job `jobId`. Employed on the work date (DF04, FR-051): joined on or before it and, when an approved
 * (inclusive) last working date exists, not after that date; an active status, or a separated or archived one whose
 * approved last working date is on or after the work date (processing done after the separation still covers the days
 * served). Never a date after the approved last working date, whatever the status. Reruns with unchanged inputs change
 * nothing, so a chunk that is rolled back and run again has no double effect; a chunk run again after it committed
 * finds the employees this job already found without a policy, counts them as before (the totals it starts from are
 * those before the chunk) and neither evaluates nor writes them again. A day a processed payroll used is skipped and
 * counted (SKIPPED_LOCKED; BR-037, BR-047). An employee whose evaluation fails is named on the failure (UnitFailure), so
 * the job can list them after the chunk's rollback (FR-022).
 */
export async function processDateChunk(
  tx: Queryable,
  grant: AccessGrant,
  jobId: string,
  day: string,
  totals: ProcessingTotals,
  afterCode: string | null,
  size: number,
) {
  const params = new SqlParams([day, jobId]);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const after = afterCode === null ? '' : `and e.employee_code > ${params.add(afterCode)}::text`;
  const rows = (
    await tx.query<{ id: string; employee_code: string; own_no_policy: boolean }>(
      `select e.id, e.employee_code,
              exists (select 1 from attendance_processing_no_policy n
                       where n.company_id = e.company_id and n.bulk_job_id = $2::uuid and n.employee_id = e.id) as own_no_policy
         from employee e ${EMPLOYED_ON_DAY_JOINS}
        where ${scope} and ${employedOnDay('$1', params)} ${after}
        order by e.employee_code limit ${params.add(size + 1)}::int`,
      params.values,
    )
  ).rows;
  const employees = rows.slice(0, size);
  // Counts only; a list carried by a job queued before 0058 (noPolicyEmployeeIds, from its committed chunks) becomes
  // rows of the job here and leaves the result. A job queued before 0111 starts its locked count here.
  const { workDate, employees: evaluated, CREATED, UPDATED, UNCHANGED, SKIPPED_AMENDED, SKIPPED_LOCKED, NO_POLICY } = totals;
  const next: ProcessingTotals = { workDate, employees: evaluated, CREATED, UPDATED, UNCHANGED, SKIPPED_AMENDED, SKIPPED_LOCKED: SKIPPED_LOCKED ?? 0, NO_POLICY };
  const carried = (totals as { noPolicyEmployeeIds?: unknown }).noPolicyEmployeeIds;
  const noPolicy = Array.isArray(carried) ? carried.filter((id): id is string => typeof id === 'string') : [];
  for (const e of employees) {
    let outcome: Outcome;
    try {
      outcome = e.own_no_policy ? 'NO_POLICY' : await evaluateEmployeeDay(tx, grant, jobId, e.id, day);
    } catch (err) {
      throw new UnitFailure(err, e.id);
    }
    next[outcome]++;
    next.employees++;
    if (outcome === 'NO_POLICY' && !e.own_no_policy) noPolicy.push(e.id);
  }
  // One statement per chunk, in the chunk's transaction.
  await recordNoPolicy(tx, grant, jobId, noPolicy);
  return { totals: next, processed: employees.length, cursor: employees.at(-1)?.employee_code ?? afterCode, done: rows.length <= size };
}

/** The employee the failing chunk stopped on, replacing an earlier one (0112). Called after the chunk's rollback. */
export async function recordProcessingFailure(tx: Queryable, job: { companyId: string; jobId: string; requestedBy: string }, employeeId: string, errorCode: string): Promise<void> {
  await tx.query(`delete from attendance_processing_failure where company_id = $1 and bulk_job_id = $2`, [job.companyId, job.jobId]);
  await tx.query(
    `insert into attendance_processing_failure (company_id, bulk_job_id, employee_id, employee_code, error_code, created_by)
     select e.company_id, $2, e.id, e.employee_code, $4, $5 from employee e where e.company_id = $1 and e.id = $3`,
    [job.companyId, job.jobId, employeeId, errorCode, job.requestedBy],
  );
}

/** The audit record of a finished processing run (written once, when its last chunk commits). */
export async function auditProcessing(tx: Queryable, grant: AccessGrant, totals: ProcessingTotals) {
  const { workDate, CREATED, UPDATED, UNCHANGED, SKIPPED_AMENDED, SKIPPED_LOCKED, NO_POLICY } = totals;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_processing',
    recordKey: grant.assignmentId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'PROCESS',
    after: { operational: { workDate, CREATED, UPDATED, UNCHANGED, SKIPPED_AMENDED, SKIPPED_LOCKED: SKIPPED_LOCKED ?? 0, NO_POLICY } },
  });
}

/** Rows per page of a job's employees without a policy: the default and the most one page returns (technical bounds, not business rules). */
export const NO_POLICY_PAGE_DEFAULT = 50;
export const NO_POLICY_PAGE_MAX = 200;

export interface NoPolicyPageQuery {
  /** `nextAfter` of the previous page (the job's order: employee code, then employee id). */
  after?: string | undefined;
  limit?: number | undefined;
}

const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function noPolicyAfter(after: string | undefined): [string, string] | null {
  if (after === undefined) return null;
  try {
    const key: unknown = JSON.parse(after);
    if (Array.isArray(key) && key.length === 2 && typeof key[0] === 'string' && typeof key[1] === 'string' && UUID_TEXT.test(key[1])) return [key[0], key[1]];
  } catch {
    // not a position this list returned
  }
  throw new HttpError(400, 'INVALID_REQUEST', 'after must be the nextAfter value of a previous page');
}

/**
 * The employees processing job `jobId` found without an applicable policy, a page at a time in the job's order
 * (employee code). As for the job's status, only its requester under the acting assignment it was queued with finds the
 * job (anyone else: not found); the route resolved the processing permission, and only the employees in the caller's
 * current row scope are listed (the processing request's scope, re-applied). Operational fields only: employee id,
 * code and name. Rows of a job still running (or ended FAILED) are those its committed chunks wrote.
 */
export async function processingNoPolicy(db: Queryable, grant: AccessGrant, jobId: string, q: NoPolicyPageQuery) {
  const job = (
    await db.query<{ state: string; work_date: string | null; requested_by: string; acting_assignment_id: string }>(
      `select state, parameters->>'workDate' as work_date, requested_by, acting_assignment_id
         from bulk_job where company_id = $1 and id = $2 and kind = 'ATTENDANCE_PROCESSING'`,
      [grant.companyId, jobId],
    )
  ).rows[0];
  if (!job || job.requested_by !== grant.userId || job.acting_assignment_id !== grant.assignmentId) throw notFound();
  const after = noPolicyAfter(q.after);
  const limit = Math.min(Math.max(q.limit ?? NO_POLICY_PAGE_DEFAULT, 1), NO_POLICY_PAGE_MAX);
  const params = new SqlParams([grant.companyId, jobId]);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const from = after ? `and (n.employee_code, n.employee_id) > (${params.add(after[0])}::text, ${params.add(after[1])}::uuid)` : '';
  const rows = (
    await db.query<{ employeeId: string; employeeCode: string; employeeName: string; key: string }>(
      `select n.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName", n.employee_code as key
         from attendance_processing_no_policy n
         join employee e on e.company_id = n.company_id and e.id = n.employee_id
        where n.company_id = $1::uuid and n.bulk_job_id = $2::uuid and ${scope} ${from}
        order by n.employee_code, n.employee_id
        limit ${params.add(limit + 1)}::int`,
      params.values,
    )
  ).rows;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    jobId,
    workDate: job.work_date,
    state: job.state,
    items: items.map(({ employeeId, employeeCode, employeeName }) => ({ employeeId, employeeCode, employeeName })),
    nextAfter: rows.length > limit && last ? JSON.stringify([last.key, last.employeeId]) : null,
  };
}

/**
 * FR-022 "processing failures list affected employees": the employees a processing job has not processed, a page at a
 * time in the job's order: those after its committed cursor, in the caller's row scope, employed on the work date,
 * the one a failing chunk stopped on carrying its error class. A finished job has none. The same requester rule as
 * processingNoPolicy; operational fields and the error class only. The job's outcome is not changed by reading it.
 */
export async function processingUnprocessed(db: Queryable, grant: AccessGrant, jobId: string, q: NoPolicyPageQuery) {
  const job = (
    await db.query<{ state: string; work_date: string; requested_by: string; acting_assignment_id: string; cursor: string | null; error_code: string | null }>(
      `select state, parameters->>'workDate' as work_date, requested_by, acting_assignment_id, chunk_cursor as cursor, error_code
         from bulk_job where company_id = $1 and id = $2 and kind = 'ATTENDANCE_PROCESSING'`,
      [grant.companyId, jobId],
    )
  ).rows[0];
  if (!job || job.requested_by !== grant.userId || job.acting_assignment_id !== grant.assignmentId) throw notFound();
  const base = { jobId, workDate: job.work_date, state: job.state, errorCode: job.error_code };
  if (job.state === 'COMPLETED') return { ...base, items: [], nextAfter: null };
  const after = noPolicyAfter(q.after);
  const limit = Math.min(Math.max(q.limit ?? NO_POLICY_PAGE_DEFAULT, 1), NO_POLICY_PAGE_MAX);
  const params = new SqlParams([grant.companyId, jobId, job.work_date]);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const fromCursor = job.cursor === null ? '' : `and e.employee_code > ${params.add(job.cursor)}::text`;
  const fromPage = after ? `and (e.employee_code, e.id) > (${params.add(after[0])}::text, ${params.add(after[1])}::uuid)` : '';
  const rows = (
    await db.query<{ employeeId: string; employeeCode: string; employeeName: string; errorCode: string | null }>(
      `select e.id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName", f.error_code as "errorCode"
         from employee e ${EMPLOYED_ON_DAY_JOINS}
         left join attendance_processing_failure f on f.company_id = e.company_id and f.bulk_job_id = $2::uuid and f.employee_id = e.id
        where e.company_id = $1::uuid and ${scope} and ${employedOnDay('$3', params)} ${fromCursor} ${fromPage}
        order by e.employee_code, e.id
        limit ${params.add(limit + 1)}::int`,
      params.values,
    )
  ).rows;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { ...base, items, nextAfter: rows.length > limit && last ? JSON.stringify([last.employeeCode, last.employeeId]) : null };
}

/**
 * E07 "entity" (I-78 item 6, decided under owner delegation, 6 Nov 2026): the measured quantity the minute comparison applies
 * to. Worked, scheduled net and shortfall minutes (scheduled less worked, never below zero), late minutes (from the
 * scheduled start on a late day) and overtime candidate minutes (none under a policy without overtime rules). Early-departure
 * minutes (0265; the shift deviation register, CL-050) run from the last covered minute to the scheduled end on an
 * early-departure day; a day evaluated before 0265 has none until it is processed again.
 */
export const ATTENDANCE_MINUTE_FIELDS = ['WORKED', 'SCHEDULED', 'SHORTFALL', 'LATE', 'OVERTIME_CANDIDATE', 'EARLY_DEPARTURE'] as const;

/**
 * FR-021 / E07 attendance control filters. Every filter narrows; `minute*` compares stored minutes. I-78 item 6: the
 * organisation and the working organisation are the employing company, which the acting assignment fixes (a move to
 * another company is a new employment there, DF04), so neither is a filter to choose; the entity is `minuteField`.
 */
export interface AttendanceControlFilters {
  from: string;
  to: string;
  departmentId?: string | undefined;
  locationId?: string | undefined;
  /** An attendance status code. */
  status?: string | undefined;
  shiftId?: string | undefined;
  employeeId?: string | undefined;
  /** Employee code or name, part of either. */
  search?: string | undefined;
  /** The entity whose stored minutes are compared (ATTENDANCE_MINUTE_FIELDS). */
  minuteField?: (typeof ATTENDANCE_MINUTE_FIELDS)[number] | undefined;
  minuteOp?: 'LT' | 'LTE' | 'EQ' | 'GTE' | 'GT' | undefined;
  minuteValue?: number | undefined;
}

const MINUTE_COLUMN: Record<NonNullable<AttendanceControlFilters['minuteField']>, string> = {
  WORKED: 'r.worked_minutes',
  SCHEDULED: 'r.scheduled_net_minutes',
  SHORTFALL: 'greatest(r.scheduled_net_minutes - r.worked_minutes, 0)',
  LATE: 'r.late_minutes',
  OVERTIME_CANDIDATE: 'r.overtime_candidate_minutes',
  EARLY_DEPARTURE: 'r.early_departure_minutes',
};
const MINUTE_OP: Record<NonNullable<AttendanceControlFilters['minuteOp']>, string> = { LT: '<', LTE: '<=', EQ: '=', GTE: '>=', GT: '>' };

/** From clause of the attendance control list and its export: the same rows under the same filters (ZT17). */
export const ATTENDANCE_CONTROL_FROM = `from attendance_record r
       join employee e on e.company_id = r.company_id and e.id = r.employee_id
       join reference_value st on st.company_id = r.company_id and st.id = r.status_id
       join attendance_policy p on p.company_id = r.company_id and p.id = r.policy_id
       left join shift s on s.company_id = r.company_id and s.id = r.shift_id
       left join lateral (select ea.department_id, ea.location_id from employment_assignment ea
                           where ea.company_id = r.company_id and ea.employee_id = r.employee_id and ea.effective_from <= r.work_date
                             and (ea.effective_to is null or ea.effective_to > r.work_date) limit 1) ea on true
       left join department dep on dep.company_id = r.company_id and dep.id = ea.department_id
       left join location loc on loc.company_id = r.company_id and loc.id = ea.location_id`;

export function attendanceControlConditions(grant: AccessGrant, f: AttendanceControlFilters, params: SqlParams): string {
  const parts = [employeeScopePredicate(grant, { company: 'r.company_id', employee: 'r.employee_id' }, params), `r.work_date between ${params.add(f.from)}::date and ${params.add(f.to)}::date`];
  if (f.departmentId) parts.push(`ea.department_id = ${params.add(f.departmentId)}::uuid`);
  if (f.locationId) parts.push(`ea.location_id = ${params.add(f.locationId)}::uuid`);
  if (f.status) parts.push(`st.code = ${params.add(f.status)}::text`);
  if (f.shiftId) parts.push(`r.shift_id = ${params.add(f.shiftId)}::uuid`);
  if (f.employeeId) parts.push(`r.employee_id = ${params.add(f.employeeId)}::uuid`);
  if (f.search?.trim()) {
    const like = params.add(`%${f.search.trim().replace(/[\\%_]/g, '\\$&')}%`);
    parts.push(`(e.employee_code ilike ${like}::text or e.display_name ilike ${like}::text)`);
  }
  if (f.minuteField && f.minuteOp && f.minuteValue !== undefined) parts.push(`${MINUTE_COLUMN[f.minuteField]} ${MINUTE_OP[f.minuteOp]} ${params.add(f.minuteValue)}::int`);
  return parts.join(' and ');
}

/** The minute comparison is one filter: a field, an operator and a value together, or none of them. */
export function assertMinuteFilter(f: Pick<AttendanceControlFilters, 'minuteField' | 'minuteOp' | 'minuteValue'>): void {
  const given = [f.minuteField, f.minuteOp, f.minuteValue].filter((v) => v !== undefined).length;
  if (given !== 0 && given !== 3) throw new HttpError(422, 'MINUTE_FILTER_INCOMPLETE', 'A minute comparison needs a field, an operator and a value');
}

/** Technical cap on one query's period in calendar days (inclusive), not a business rule. */
export const ATTENDANCE_CONTROL_MAX_DAYS = 366;

/** FR-021 / E07: attendance across the caller's row scope, filtered and paged with totals. Operational fields only. */
export async function attendanceControl(db: Queryable, grant: AccessGrant, f: AttendanceControlFilters, page: { page: number; pageSize: number }) {
  assertMinuteFilter(f);
  if (f.to < f.from) throw new HttpError(422, 'INVALID_PERIOD', 'The period end is before its start');
  if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 + 1 > ATTENDANCE_CONTROL_MAX_DAYS) throw new HttpError(422, 'PERIOD_TOO_LONG', `Ask for at most ${ATTENDANCE_CONTROL_MAX_DAYS} days at a time`);
  const params = new SqlParams();
  const where = attendanceControlConditions(grant, f, params);
  const total = Number((await db.query<{ n: string }>(`select count(*) as n ${ATTENDANCE_CONTROL_FROM} where ${where}`, params.values)).rows[0]?.n ?? 0);
  const rows = await db.query(
    `select r.id, r.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName", dep.code as "departmentCode", loc.code as "locationCode",
            r.work_date as "workDate", st.code as status, r.worked_minutes as "workedMinutes", r.scheduled_net_minutes as "scheduledNetMinutes",
            r.late, r.late_minutes as "lateMinutes", r.early_departure as "earlyDeparture", r.early_departure_minutes as "earlyDepartureMinutes",
            r.overtime_candidate_minutes as "overtimeCandidateMinutes",
            r.exception_code as "exceptionCode", r.amended, r.calculation_count as "calculationCount", r.version,
            s.code as "shiftCode", p.code as "policyCode", p.revision as "policyRevision", hrms_attendance_day_frozen(r.company_id, r.employee_id, r.work_date) as "payrollLocked"
       ${ATTENDANCE_CONTROL_FROM} where ${where}
      order by r.work_date desc, e.employee_code limit ${params.add(page.pageSize)}::int offset ${params.add((page.page - 1) * page.pageSize)}::int`,
    params.values,
  );
  return { items: rows.rows, total, page: page.page, pageSize: page.pageSize };
}

/**
 * FR-021 "show raw/derived results": one day's untouched source punches beside its derived result: the punches of the
 * capture window evaluation read (the record's pinned shift revision, less and plus its buffer (I-78 item 1), so a later
 * revision changes nothing until the day is reprocessed; without a shift, the business day).
 */
export async function attendanceDay(db: Queryable, grant: AccessGrant, recordId: string) {
  const record = (
    await db.query<{ employee_id: string; from_at: string; to_at: string; derived: Record<string, unknown> }>(
      `select r.employee_id, w.from_at, w.to_at,
              json_build_object('workDate', r.work_date, 'status', st.code, 'workedMinutes', r.worked_minutes, 'scheduledNetMinutes', r.scheduled_net_minutes, 'late', r.late,
                                'lateMinutes', r.late_minutes, 'earlyDeparture', r.early_departure, 'earlyDepartureMinutes', r.early_departure_minutes,
                                'overtimeCandidateMinutes', r.overtime_candidate_minutes,
                                'exceptionCode', r.exception_code, 'amended', r.amended, 'shiftCode', sh.code, 'shiftRevision', case when sh.id is not null then coalesce(rv.revision, 1) end,
                                'bufferMinutes', t.buffer, 'policyCode', p.code, 'policyRevision', p.revision) as derived
         from attendance_record r
         join company c on c.id = r.company_id
         join reference_value st on st.company_id = r.company_id and st.id = r.status_id
         join attendance_policy p on p.company_id = r.company_id and p.id = r.policy_id
         left join shift sh on sh.company_id = r.company_id and sh.id = r.shift_id
         left join shift_revision rv on rv.company_id = r.company_id and rv.id = r.shift_revision_id
         cross join lateral (select coalesce(rv.in_time, sh.in_time) as in_time, coalesce(rv.out_time, sh.out_time) as out_time, coalesce(rv.spans_midnight, sh.spans_midnight) as spans,
                                    coalesce(rv.buffer_minutes, sh.buffer_minutes) as buffer) t
         cross join lateral (
           select case when sh.id is null then (r.work_date::timestamp at time zone c.business_timezone)
                       else ((r.work_date + t.in_time) at time zone c.business_timezone) - make_interval(mins => t.buffer) end as from_at,
                  case when sh.id is null then ((r.work_date + 1)::timestamp at time zone c.business_timezone)
                       else ((r.work_date + t.in_time) at time zone c.business_timezone) + make_interval(mins => hrms_shift_minutes(t.in_time, t.out_time, t.spans) + t.buffer) end as to_at
         ) w
        where r.company_id = $1 and r.id = $2`,
      [grant.companyId, recordId],
    )
  ).rows[0];
  if (!record || !(await canAccessEmployee(db, grant, record.employee_id))) throw notFound();
  const punches = await db.query(
    `select occurred_at as "occurredAt", direction, source_kind as "sourceKind" from attendance_punch
      where company_id = $1 and employee_id = $2 and occurred_at >= $3 and occurred_at < $4 order by occurred_at, id`,
    [grant.companyId, record.employee_id, record.from_at, record.to_at],
  );
  return { recordId, employeeId: record.employee_id, derived: record.derived, punches: punches.rows };
}

export async function listAttendance(db: Queryable, grant: AccessGrant, employeeId: string, from: string, to: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const rows = await db.query(
    `select r.id, r.work_date as "workDate", st.code as status, r.worked_minutes as "workedMinutes",
            r.scheduled_net_minutes as "scheduledNetMinutes", r.late, r.late_minutes as "lateMinutes", r.early_departure as "earlyDeparture",
            r.early_departure_minutes as "earlyDepartureMinutes", r.overtime_candidate_minutes as "overtimeCandidateMinutes",
            r.exception_code as "exceptionCode", r.amended, r.calculation_count as "calculationCount", r.version,
            s.code as "shiftCode", p.code as "policyCode", p.revision as "policyRevision"
       from attendance_record r
       join reference_value st on st.company_id = r.company_id and st.id = r.status_id
       join attendance_policy p on p.company_id = r.company_id and p.id = r.policy_id
       left join shift s on s.company_id = r.company_id and s.id = r.shift_id
      where r.company_id = $1 and r.employee_id = $2 and r.work_date between $3::date and $4::date
      order by r.work_date`,
    [grant.companyId, employeeId, from, to],
  );
  return { employeeId, items: rows.rows };
}

/**
 * FR-021: reasoned correction; original punches stay; the record keeps its amendment trail. An outcome that is not
 * measured against the shift (on duty, leave, holiday, weekly off) carries no late or early-departure flag, as in
 * evaluation, so amending to one drops the evaluated flags; the audit keeps their previous values. Nobody amends their own
 * attendance (C4; DF02), which a reviewer's correction decision also guarantees. The amend duty is re-resolved after the
 * record lock; `decidedCorrection` names the one caller that holds no such duty, an approved correction request, whose
 * decision re-resolved its own permission in this same transaction. A day a processed payroll used is final (409
 * PAYROLL_LOCKED; BR-047). An outcome with its own rules needs the same fact evaluation would use (FR-021, FR-025 to
 * FR-027): a day never becomes leave, outdoor duty or an off day by amendment alone.
 */
export async function amendRecord(
  tx: Queryable,
  grant: AccessGrant,
  recordId: string,
  input: { expectedVersion: number; status: string; reason: string },
  options: { decidedCorrection?: boolean } = {},
) {
  const record = (
    await tx.query<{
      employee_id: string;
      work_date: string;
      status_id: string;
      version: number;
      late: boolean;
      late_minutes: number | null;
      early_departure: boolean;
      early_departure_minutes: number | null;
      overtime_candidate_minutes: number | null;
      exception_code: string | null;
    }>(
      `select employee_id, to_char(work_date, 'YYYY-MM-DD') as work_date, status_id, version, late, late_minutes, early_departure, early_departure_minutes,
              overtime_candidate_minutes, exception_code
         from attendance_record where company_id = $1 and id = $2 for update`,
      [grant.companyId, recordId],
    )
  ).rows[0];
  if (!record || !(await canAccessEmployee(tx, grant, record.employee_id))) throw notFound();
  if (!options.decidedCorrection) await reassertAccess(tx, grant, 'attendance', 'amend', ['operational']);
  await assertNotOwnRecord(tx, grant, record.employee_id);
  if (record.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  await refuseIfPayrollLocked(tx, grant.companyId, record.employee_id, record.work_date);
  const newStatusId = await statusId(tx, grant.companyId, input.status);
  if (newStatusId === record.status_id) throw new HttpError(422, 'RULE_VIOLATION', 'The new status equals the current status');
  await assertAmendmentFact(tx, grant.companyId, record.employee_id, record.work_date, input.status);
  const keepFlags = carriesShiftFlags(input.status);
  const late = keepFlags && record.late;
  const earlyDeparture = keepFlags && record.early_departure;
  // Late minutes follow the flag; overtime candidates stay only on an outcome that can carry them (I-78 items 5, 6).
  const lateMinutes = late ? record.late_minutes : record.late_minutes === null ? null : 0;
  // Early-departure minutes follow their flag the same way (0265).
  const earlyMinutes = earlyDeparture ? record.early_departure_minutes : record.early_departure_minutes === null ? null : 0;
  const overtime = record.overtime_candidate_minutes === null ? null : carriesOvertime(input.status) ? record.overtime_candidate_minutes : 0;

  const amendmentId = (
    await tx.query<{ id: string }>(
      `insert into attendance_amendment (company_id, attendance_record_id, prior_version, old_status_id, new_status_id, reason, actor_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7, $7) returning id`,
      [grant.companyId, recordId, record.version, record.status_id, newStatusId, input.reason.trim(), grant.userId],
    )
  ).rows[0]!.id;
  // Everything the amendment overwrites, the exception code that made the day reviewable included (DB027).
  await tx.query(
    `insert into attendance_record_revision (${REVISION_COLUMNS})
     select r.company_id, r.id, r.version, r.shift_id, r.policy_id, r.scheduled_net_minutes, r.worked_minutes, r.late, r.early_departure,
            r.status_id, r.exception_code, r.amended, r.calculation_count, 'AMENDMENT', null, $3::uuid, $4::uuid, $4::uuid, r.late_minutes, r.overtime_candidate_minutes,
            r.early_departure_minutes
       from attendance_record r where r.company_id = $1 and r.id = $2`,
    [grant.companyId, recordId, amendmentId, grant.userId],
  );
  await tx.query(
    `update attendance_record set status_id = $3, amended = true, exception_code = null, late = $5, early_departure = $6, late_minutes = $7, overtime_candidate_minutes = $8,
            early_departure_minutes = $9, updated_by = $4
      where company_id = $1 and id = $2`,
    [grant.companyId, recordId, newStatusId, grant.userId, late, earlyDeparture, lateMinutes, overtime, earlyMinutes],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_record',
    recordKey: recordId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'AMEND',
    priorVersion: record.version,
    before: {
      operational: {
        statusId: record.status_id,
        late: record.late,
        lateMinutes: record.late_minutes,
        earlyDeparture: record.early_departure,
        earlyDepartureMinutes: record.early_departure_minutes,
        overtimeCandidateMinutes: record.overtime_candidate_minutes,
        exceptionCode: record.exception_code,
      },
    },
    after: { operational: { status: input.status, late, lateMinutes, earlyDeparture, earlyDepartureMinutes: earlyMinutes, overtimeCandidateMinutes: overtime } },
    reason: input.reason,
  });
}

/**
 * The fact an amended outcome rests on, the same facts evaluation reads (evaluateEmployeeDay): an approved full- or
 * half-day leave, an approved full-day outdoor duty (a timed window is worked time, not an ON_DUTY day), an active
 * holiday of the employee's location on that date, or a weekly off of that location. Off days outrank the others, as in
 * evaluation: leave and duty consumed nothing on them. PRESENT, HALF_DAY and ABSENT rest on review alone. The request
 * row is share-locked, so a cancellation being approved right now is waited for and seen.
 */
async function assertAmendmentFact(tx: Queryable, companyId: string, employeeId: string, day: string, status: string): Promise<void> {
  if (!['LEAVE', 'HALF_DAY_LEAVE', 'ON_DUTY', 'HOLIDAY', 'WEEKLY_OFF'].includes(status)) return;
  const off = (
    await tx.query<{ weekly_off: boolean; holiday: boolean }>(
      `select ${weeklyOffSql('$3', '$2', '$1')} as weekly_off, ${holidaySql('$3', '$2', '$1')} as holiday`,
      [companyId, employeeId, day],
    )
  ).rows[0]!;
  if (status === 'HOLIDAY') {
    if (!off.holiday) throw new HttpError(422, 'NOT_A_HOLIDAY', 'This date is not a holiday of the employee’s location');
    return;
  }
  if (status === 'WEEKLY_OFF') {
    if (!off.weekly_off) throw new HttpError(422, 'NOT_A_WEEKLY_OFF', 'This date is not a weekly off');
    return;
  }
  if (off.weekly_off || off.holiday) throw new HttpError(422, 'NOT_A_WORKING_DAY', 'Leave and outdoor duty apply to working days; this date is an off day');
  if (status === 'ON_DUTY') {
    const duty = await tx.query(
      `select 1 from outdoor_duty_request where company_id = $1 and employee_id = $2 and state = 'APPROVED' and start_time is null
          and start_date <= $3::date and end_date >= $3::date limit 1 for share`,
      [companyId, employeeId, day],
    );
    if (!duty.rowCount) throw new HttpError(422, 'NO_APPROVED_OUTDOOR_DUTY', 'No approved full-day outdoor duty covers this date');
    return;
  }
  const leave = await tx.query(
    `select 1 from leave_request where company_id = $1 and employee_id = $2 and state = 'APPROVED' and half_day = $4
        and start_date <= $3::date and end_date >= $3::date limit 1 for share`,
    [companyId, employeeId, day, status === 'HALF_DAY_LEAVE'],
  );
  if (!leave.rowCount) throw new HttpError(422, 'NO_APPROVED_LEAVE', status === 'LEAVE' ? 'No approved full-day leave covers this date' : 'No approved half-day leave covers this date');
}

export async function amendmentLog(db: Queryable, grant: AccessGrant, recordId: string) {
  const owner = (await db.query<{ employee_id: string }>(`select employee_id from attendance_record where company_id = $1 and id = $2`, [grant.companyId, recordId])).rows[0];
  if (!owner || !(await canAccessEmployee(db, grant, owner.employee_id))) throw notFound();
  // Amendment reasons are written by HR or the approving reviewer: private reviewer notes, never part of the
  // employee's own-record ESS view (H1/H3) even though the employee may read their own submitted reasons.
  const withReason = grant.allowedFieldGroups.includes('reason') && !grant.ownEssFieldGroups.includes('reason');
  const rows = await db.query(
    `select a.occurred_at as "occurredAt", o.code as "oldStatus", n.code as "newStatus", ${withReason ? 'a.reason, ' : ''}a.actor_id as "actorUserId"
       from attendance_amendment a
       join reference_value o on o.company_id = a.company_id and o.id = a.old_status_id
       join reference_value n on n.company_id = a.company_id and n.id = a.new_status_id
      where a.company_id = $1 and a.attendance_record_id = $2 order by a.occurred_at`,
    [grant.companyId, recordId],
  );
  // FR-021: the values each change replaced and what caused it (a processing job or an amendment); operational only.
  const revisions = await db.query(
    `select v.occurred_at as "occurredAt", v.cause, v.bulk_job_id as "processingJobId", v.amendment_id as "amendmentId", v.actor_id as "actorUserId", v.prior_version as "priorVersion",
            st.code as status, v.worked_minutes as "workedMinutes", v.scheduled_net_minutes as "scheduledNetMinutes", v.late, v.early_departure as "earlyDeparture",
            v.exception_code as "exceptionCode", s.code as "shiftCode", p.code as "policyCode", p.revision as "policyRevision"
       from attendance_record_revision v
       join reference_value st on st.company_id = v.company_id and st.id = v.status_id
       join attendance_policy p on p.company_id = v.company_id and p.id = v.policy_id
       left join shift s on s.company_id = v.company_id and s.id = v.shift_id
      where v.company_id = $1 and v.attendance_record_id = $2 order by v.prior_version`,
    [grant.companyId, recordId],
  );
  return { recordId, items: rows.rows, revisions: revisions.rows };
}

