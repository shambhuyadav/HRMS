// What is known about each employee on each day (BRD coverage CL-047 to CL-053 under FR-019 to FR-027; DF05; DF09; BR-026).
// One SQL source for the attendance registers (registers.ts) and the attendance dashboard (dashboard.ts), so a register, the
// dashboard's counts and the dashboard's lists cannot disagree about who was where.
//
// - The employees: those a processing run covers on the day (service.ts employedOnDay: joined on or before it, active, or
//   separated with an approved last working date on or after it), within the requester's row scope (employeeScopePredicate,
//   as every list and report applies it).
// - Department and location: the assignment in force that day; the shift: the shift assignment in force that day, with the
//   times and buffer of its revision in force (DF05: shift calendars are effective-dated).
// - The day's punch window: the shift's capture window (I-78 item 1: from the buffer before the scheduled start to the buffer
//   after the scheduled end, end excluded), the window evaluation reads; without a shift, the business day in company time.
// - The calendar: weekly off and holiday of the employee's location that day (shift/calendar.ts, the one place that knows it).
// - Approved leave (full or half day) and approved outdoor duty (a full day, or a timed window) covering the day.
// - The processed result when the day has been processed (attendance_record), with its status, late flag and worked minutes.
// - `source_unavailable`: no punch arrived and a biometric source linked to the employee failed for the window with no
//   completed run covering it since (DF09: a failed fetch is never absence), worked out only for an unprocessed day without a
//   punch, as evaluation does.
//
// Absence for the absconding report (`absence`), decided under owner delegation (6 Nov 2026; recorded 10 Nov 2026):
//   ABSENT  no punch, no approved leave and no approved outdoor duty on the day, and either the processed result is ABSENT, or
//           the day is not processed yet, is a working day of the employee's calendar with a shift assigned, and no failed
//           punch source covers it (what evaluation would make an exception to review, it never counts as absence);
//   OFF     no punch, and a weekly off or holiday (the processed result's, or the calendar's when not processed): it neither
//           counts towards nor ends a run of absence, so a weekend or holiday between two absent working days continues it;
//   NOT_ABSENT anything else (a punch, leave, outdoor duty, a processed result other than ABSENT, such as an exception to
//           review): it ends a run.
import { type AccessGrant, employeeScopePredicate, type SqlParams } from '../access/authorize.js';
import { halfWeeklyOffSql, holidaySql, weeklyOffSql } from '../shift/calendar.js';
import { EMPLOYED_ON_DAY_JOINS, employedOnDay } from './service.js';

/** Punch sources a register can be limited to: a terminal (biometric device feed) or a file import. No mobile punch exists. */
export const PUNCH_SOURCES = ['TERMINAL', 'IMPORT'] as const;
export type PunchSource = (typeof PUNCH_SOURCES)[number];
/** The stored source_kind of each punch source. */
export const SOURCE_KIND: Record<PunchSource, string> = { TERMINAL: 'BIOMETRIC_API', IMPORT: 'MANUAL_IMPORT' };
/** The source of a stored punch in words. */
export const SOURCE_LABEL_SQL = (alias: string) => `case ${alias}.source_kind when 'BIOMETRIC_API' then 'Terminal' when 'MANUAL_IMPORT' then 'Import' else ${alias}.source_kind end`;

export interface DayFactsFilters {
  from: string;
  to: string;
  /** The department of the assignment in force that day, any of these. */
  departmentIds?: readonly string[] | undefined;
  locationId?: string | undefined;
  /** The shift assigned that day. */
  shiftId?: string | undefined;
  employeeId?: string | undefined;
  /** Employee code or name, part of either (the attendance control list's search). */
  search?: string | undefined;
  /** Count only the punches of one source. */
  punchSource?: PunchSource | undefined;
  /** Leave the punches out (a register that shows none): no punch is counted and no punch source is looked at. */
  withoutPunches?: boolean | undefined;
}

/**
 * SQL selecting one row per employee in scope and day of [from, to] they are employed on, with the facts above. Its columns
 * are listed in DayFacts. `p` collects the parameters.
 */
export function dayFactsSql(grant: AccessGrant, p: SqlParams, f: DayFactsFilters): string {
  const company = `${p.add(grant.companyId)}::uuid`;
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
  const where = [`e.company_id = ${company}`, scope, employedOnDay('g.d', p)];
  if (f.departmentIds && f.departmentIds.length > 0) where.push(`ea.department_id = any(${p.add([...f.departmentIds])}::uuid[])`);
  if (f.locationId) where.push(`ea.location_id = ${p.add(f.locationId)}::uuid`);
  if (f.shiftId) where.push(`sa.shift_id = ${p.add(f.shiftId)}::uuid`);
  if (f.employeeId) where.push(`e.id = ${p.add(f.employeeId)}::uuid`);
  if (f.search?.trim()) {
    const like = p.add(`%${f.search.trim().replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(e.employee_code ilike ${like}::text or e.display_name ilike ${like}::text)`);
  }
  // A parameter is added only where the SQL uses it (an unreferenced one has no inferable type).
  const source = f.punchSource && !f.withoutPunches ? `and p.source_kind = ${p.add(SOURCE_KIND[f.punchSource])}::text` : '';
  // A punch in company time; the date is shown only when it is not the work date (an overnight shift's next morning).
  const punchTime = `to_char(p.occurred_at at time zone c.business_timezone,
                             case when (p.occurred_at at time zone c.business_timezone)::date = g.d then 'HH24:MI' else 'YYYY-MM-DD HH24:MI' end)`;
  const punchLabel = `${punchTime} || ' ' || p.direction || ' (' || ${SOURCE_LABEL_SQL('p')} || ')'`;
  const punches = f.withoutPunches
    ? `(select 0 as punch_count, null::timestamptz as first_at, null::timestamptz as last_at, null::text as punch_list, null::text as first_label,
               null::text as last_label, null::text as sources)`
    : `(select count(*)::int as punch_count, min(p.occurred_at) as first_at, max(p.occurred_at) as last_at,
               string_agg(${punchLabel}, '; ' order by p.occurred_at, p.id) as punch_list,
               (array_agg(${punchLabel} order by p.occurred_at, p.id))[1] as first_label,
               (array_agg(${punchLabel} order by p.occurred_at desc, p.id desc))[1] as last_label,
               string_agg(distinct ${SOURCE_LABEL_SQL('p')}, ', ') as sources
          from attendance_punch p
         where p.company_id = e.company_id and p.employee_id = e.id and p.occurred_at >= w.from_at and p.occurred_at < w.to_at ${source})`;
  return `
    select e.id as employee_id, e.employee_code, e.display_name, g.d as work_date, to_char(g.d, 'Dy') as weekday,
           ea.department_id, dep.code as department_code, dep.name as department_name, loc.code as location_code,
           sa.shift_id, sh.code as shift_code, sh.name as shift_name,
           to_char(f.in_time, 'HH24:MI') as shift_in, to_char(f.out_time, 'HH24:MI') as shift_out,
           ${weeklyOffSql('g.d', 'e.id', 'e.company_id')} as weekly_off,
           ${halfWeeklyOffSql('g.d', 'e.id', 'e.company_id')} as half_off,
           ${holidaySql('g.d', 'e.id', 'e.company_id')} as holiday,
           lv.leave, du.duty_full, du.duty_timed,
           pu.punch_count, pu.punch_list, pu.first_label, pu.last_label, pu.sources,
           w.from_at as punch_window_from, w.to_at as punch_window_to,
           to_char(pu.first_at at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI') as first_punch,
           to_char(pu.last_at at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI') as last_punch,
           r.id as record_id, rs.code as record_status, r.late as record_late, r.late_minutes as record_late_minutes,
           r.worked_minutes as record_worked_minutes, r.exception_code as record_exception,
           case when r.id is null and pu.punch_count = 0 and ${f.withoutPunches ? 'false' : 'true'} then exists (
             select 1 from biometric_employee_link l
               join biometric_sync_run sr on sr.company_id = l.company_id and sr.profile_id = l.profile_id and sr.state in ('FAILED', 'PARTIAL')
                    and tstzrange(sr.window_start, sr.window_end) && tstzrange(w.from_at, w.to_at)
              where l.company_id = e.company_id and l.employee_id = e.id and l.effective_from < w.to_at and (l.effective_to is null or l.effective_to > w.from_at)
                and not exists (select 1 from biometric_sync_run ok where ok.company_id = sr.company_id and ok.profile_id = sr.profile_id and ok.state = 'COMPLETED'
                                   and ok.window_start <= w.from_at and ok.window_end >= w.to_at and ok.started_at > sr.started_at)
           ) else false end as source_unavailable
      from (select gs::date as d from generate_series(${p.add(f.from)}::date, ${p.add(f.to)}::date, interval '1 day') gs) g
      cross join employee e
      ${EMPLOYED_ON_DAY_JOINS}
      join company c on c.id = e.company_id
      left join lateral (select a.department_id, a.location_id from employment_assignment a
                          where a.company_id = e.company_id and a.employee_id = e.id and a.effective_from <= g.d
                            and (a.effective_to is null or a.effective_to > g.d) limit 1) ea on true
      left join department dep on dep.company_id = e.company_id and dep.id = ea.department_id
      left join location loc on loc.company_id = e.company_id and loc.id = ea.location_id
      left join lateral (select a.shift_id from shift_assignment a
                          where a.company_id = e.company_id and a.employee_id = e.id and a.effective_from <= g.d
                            and (a.effective_to is null or a.effective_to > g.d) limit 1) sa on true
      left join shift sh on sh.company_id = e.company_id and sh.id = sa.shift_id
      left join lateral (select x.in_time, x.out_time, x.minutes, hrms_shift_buffer(e.company_id, sa.shift_id, x.revision_id) as buffer
                           from hrms_shift_in_force(e.company_id, sa.shift_id, g.d) x where sa.shift_id is not null) f on true
      cross join lateral (
        select case when f.in_time is null then g.d::timestamp at time zone c.business_timezone
                    else ((g.d + f.in_time) at time zone c.business_timezone) - make_interval(mins => f.buffer) end as from_at,
               case when f.in_time is null then (g.d + 1)::timestamp at time zone c.business_timezone
                    else ((g.d + f.in_time) at time zone c.business_timezone) + make_interval(mins => f.minutes + f.buffer) end as to_at
      ) w
      cross join lateral (
        select case when count(*) = 0 then 'NONE' when bool_or(not lr.half_day) then 'FULL' else 'HALF' end as leave
          from leave_request lr
         where lr.company_id = e.company_id and lr.employee_id = e.id and lr.state = 'APPROVED' and lr.start_date <= g.d and lr.end_date >= g.d
      ) lv
      cross join lateral (
        select coalesce(bool_or(od.start_time is null), false) as duty_full, coalesce(bool_or(od.start_time is not null), false) as duty_timed
          from outdoor_duty_request od
         where od.company_id = e.company_id and od.employee_id = e.id and od.state = 'APPROVED' and od.start_date <= g.d and od.end_date >= g.d
      ) du
      cross join lateral ${punches} pu
      left join attendance_record r on r.company_id = e.company_id and r.employee_id = e.id and r.work_date = g.d
      left join reference_value rs on rs.company_id = r.company_id and rs.id = r.status_id
     where ${where.join(' and ')}`;
}

/**
 * The absconding report's reading of one day (see the header): ABSENT, OFF (neither counts nor ends a run) or NOT_ABSENT (ends
 * a run). A processed result decides the off day and the absence; the calendar and the punch source only an unprocessed day.
 */
export const ABSENCE_SQL = (d: string) => `case
    when ${d}.punch_count = 0 and (${d}.record_status in ('WEEKLY_OFF', 'HOLIDAY') or (${d}.record_id is null and (${d}.weekly_off or ${d}.holiday))) then 'OFF'
    when ${d}.punch_count > 0 or ${d}.leave <> 'NONE' or ${d}.duty_full or ${d}.duty_timed then 'NOT_ABSENT'
    when ${d}.record_id is not null then case when ${d}.record_status = 'ABSENT' then 'ABSENT' else 'NOT_ABSENT' end
    when ${d}.shift_id is null or ${d}.source_unavailable then 'NOT_ABSENT'
    else 'ABSENT' end`;
