// Attendance registers (BRD coverage CL-047 "Shift Punch Register", CL-049 "Shift Plan Register", CL-050 "Shift Deviation
// Register" and CL-051 "Absconding Report", under FR-019 to FR-027 and FR-056; built 10 Nov 2026 from the reference system's
// screens, whose structure the owner's walkthrough recorded). Exports through the report framework (FR-056, DF09): each
// declares its permission (attendance.export.operational, the attendance register's), columns, period and filters, and is
// generated in the background as CSV or XLSX with its filter context. Rows are limited to the requester's row scope like
// every list (BR-026): the punch, plan and absconding registers read day-facts.ts, the attendance dashboard's source; the
// deviation register reads the attendance control list's own rows and predicate (service.ts), so the list filtered by a
// minute comparison and the register hold the same days (ZT17). Operational fields only.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import type { ReportDefinition, ReportFilters } from '../report/catalogue.js';
import { ABSENCE_SQL, type DayFactsFilters, dayFactsSql, PUNCH_SOURCES, type PunchSource } from './day-facts.js';
import { assertMinuteFilter, ATTENDANCE_CONTROL_FROM, attendanceControlConditions } from './service.js';

/**
 * The shift punch register's options (the reference screen's Punched / All / Not punched / Only first & last): every
 * employee-day, the days with a punch, the days without one, or the days with a punch showing only the first and last.
 */
export const PUNCH_VIEWS = ['ALL', 'PUNCHED', 'NOT_PUNCHED', 'FIRST_LAST'] as const;
export type PunchView = (typeof PUNCH_VIEWS)[number];

/** The absconding report's orders (the reference screen's "sort by employee code or from-date"). */
export const ABSCONDING_SORTS = ['employeeCode', 'fromDate'] as const;

/** Technical caps on one request's period, in calendar days (not business rules): a register reads every employee-day. */
const PUNCH_MAX_DAYS = 31;
const PLAN_MAX_DAYS = 92;
const DEVIATION_MAX_DAYS = 366;
const ABSCONDING_MAX_DAYS = 92;

function requireOneOf(value: string | undefined, allowed: readonly string[], field: string): void {
  if (value !== undefined && !allowed.includes(value)) throw new HttpError(422, 'INVALID_FILTER', `The ${field} is one of ${allowed.join(', ')}`, { field });
}

/** The register filters a day-facts read takes (the department of the employee list's filter is the day's department). */
const factsFilters = (f: ReportFilters, extra: Partial<DayFactsFilters> = {}): DayFactsFilters => ({
  from: f.from!,
  to: f.to!,
  departmentIds: f.departmentId ? [f.departmentId] : undefined,
  locationId: f.locationId,
  shiftId: f.shiftId,
  employeeId: f.employeeId,
  search: f.search,
  ...extra,
});

/** The day before `day` (YYYY-MM-DD). */
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

const EMPLOYEE_COLUMNS = [
  { key: 'employee_code', header: 'Employee code' },
  { key: 'display_name', header: 'Name' },
  { key: 'department', header: 'Department' },
];

export const ATTENDANCE_REGISTERS: Record<string, ReportDefinition> = {
  // CL-047: the punches of each employee and day in the shift's capture window, with the shift, the count, the first and last
  // punch and the source of each (Terminal: a biometric device feed; Import: a punch file). The reference's Mobile source does
  // not exist in this system (no mobile punch is captured), so it is not offered. One row per employee-day (the reference's
  // horizontal layout).
  SHIFT_PUNCH_REGISTER: {
    code: 'SHIFT_PUNCH_REGISTER',
    title: 'Shift punch register',
    resource: 'attendance',
    fieldGroup: 'operational',
    requiresPeriod: true,
    maxPeriodDays: PUNCH_MAX_DAYS,
    employeeFilters: ['search', 'departmentId'],
    recordFilters: ['employeeId', 'locationId', 'shiftId', 'punchView', 'punchSource'],
    xlsx: true,
    checkFilters(f) {
      requireOneOf(f.punchView, PUNCH_VIEWS, 'punchView');
      requireOneOf(f.punchSource, PUNCH_SOURCES, 'punchSource');
    },
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'work_date', header: 'Work date' },
      { key: 'weekday', header: 'Day' },
      { key: 'shift_code', header: 'Shift' },
      { key: 'shift_in', header: 'Shift in' },
      { key: 'shift_out', header: 'Shift out' },
      { key: 'punch_count', header: 'Punches', numeric: true },
      { key: 'first_punch', header: 'First punch' },
      { key: 'last_punch', header: 'Last punch' },
      { key: 'punch_times', header: 'Punch times' },
      { key: 'sources', header: 'Sources' },
    ],
    async rows(db: Queryable, grant: AccessGrant, f: ReportFilters) {
      const p = new SqlParams();
      const view = (f.punchView as PunchView | undefined) ?? 'ALL';
      const facts = dayFactsSql(grant, p, factsFilters(f, { punchSource: f.punchSource as PunchSource | undefined }));
      const only = view === 'PUNCHED' || view === 'FIRST_LAST' ? 'where d.punch_count > 0' : view === 'NOT_PUNCHED' ? 'where d.punch_count = 0' : '';
      const times = view === 'FIRST_LAST' ? `case when d.punch_count > 1 then d.first_label || '; ' || d.last_label else d.first_label end` : 'd.punch_list';
      return (
        await db.query(
          `select d.employee_code, d.display_name, coalesce(d.department_name, '') as department, to_char(d.work_date, 'YYYY-MM-DD') as work_date, d.weekday,
                  coalesce(d.shift_code, '') as shift_code, coalesce(d.shift_in, '') as shift_in, coalesce(d.shift_out, '') as shift_out, d.punch_count,
                  coalesce(d.first_punch, '') as first_punch, coalesce(d.last_punch, '') as last_punch, coalesce(${times}, '') as punch_times,
                  coalesce(d.sources, '') as sources
             from (${facts}) d ${only}
            order by d.employee_code, d.work_date`,
          p.values,
        )
      ).rows;
    },
  },

  // CL-049: the shift planned for each employee and day (the shift assignment in force that day, as a shift-plan upload or a
  // shift change set it, with the times of its revision in force), and what the calendar makes of the day.
  SHIFT_PLAN_REGISTER: {
    code: 'SHIFT_PLAN_REGISTER',
    title: 'Shift plan register',
    resource: 'attendance',
    fieldGroup: 'operational',
    requiresPeriod: true,
    maxPeriodDays: PLAN_MAX_DAYS,
    employeeFilters: ['search', 'departmentId'],
    recordFilters: ['employeeId', 'locationId', 'shiftId'],
    xlsx: true,
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'work_date', header: 'Date' },
      { key: 'weekday', header: 'Day' },
      { key: 'shift_code', header: 'Shift code' },
      { key: 'shift_name', header: 'Shift name' },
      { key: 'shift_in', header: 'Shift in' },
      { key: 'shift_out', header: 'Shift out' },
      { key: 'day_type', header: 'Day type' },
    ],
    async rows(db: Queryable, grant: AccessGrant, f: ReportFilters) {
      const p = new SqlParams();
      const facts = dayFactsSql(grant, p, factsFilters(f, { withoutPunches: true }));
      return (
        await db.query(
          `select d.employee_code, d.display_name, coalesce(d.department_name, '') as department, to_char(d.work_date, 'YYYY-MM-DD') as work_date, d.weekday,
                  coalesce(d.shift_code, '') as shift_code, coalesce(d.shift_name, 'No shift assigned') as shift_name,
                  coalesce(d.shift_in, '') as shift_in, coalesce(d.shift_out, '') as shift_out,
                  case when d.holiday then 'Holiday' when d.weekly_off then 'Weekly off' when d.half_off then 'Half weekly off' else 'Working day' end as day_type
             from (${facts}) d
            order by d.employee_code, d.work_date`,
          p.values,
        )
      ).rows;
    },
  },

  // CL-050: the processed days with a deviation from the shift (late in, early out or overtime candidates; the stored minutes,
  // I-78 items 5 and 6, 0265), with the attendance control list's filters by the same predicate, so "late by at least N minutes"
  // is minuteField LATE, minuteOp GTE, minuteValue N and "overtime only, at least N" is OVERTIME_CANDIDATE GTE N. Shift times are
  // those of the revision the day was evaluated on. A day not yet processed has no result and is not listed.
  SHIFT_DEVIATION_REGISTER: {
    code: 'SHIFT_DEVIATION_REGISTER',
    title: 'Shift deviation register',
    resource: 'attendance',
    fieldGroup: 'operational',
    requiresPeriod: true,
    maxPeriodDays: DEVIATION_MAX_DAYS,
    employeeFilters: ['search', 'departmentId'],
    statusFilter: true,
    recordFilters: ['employeeId', 'locationId', 'shiftId', 'minuteField', 'minuteOp', 'minuteValue'],
    xlsx: true,
    checkFilters: assertMinuteFilter,
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'work_date', header: 'Work date' },
      { key: 'shift_code', header: 'Shift' },
      { key: 'shift_in', header: 'Shift in' },
      { key: 'shift_out', header: 'Shift out' },
      { key: 'status', header: 'Status' },
      { key: 'late_minutes', header: 'Late-in minutes', numeric: true },
      { key: 'early_departure_minutes', header: 'Early-out minutes', numeric: true },
      { key: 'overtime_candidate_minutes', header: 'Overtime candidate minutes', numeric: true },
      { key: 'worked_minutes', header: 'Worked minutes', numeric: true },
      { key: 'scheduled_net_minutes', header: 'Scheduled net minutes', numeric: true },
      { key: 'amended', header: 'Amended' },
    ],
    async rows(db: Queryable, grant: AccessGrant, f: ReportFilters) {
      const p = new SqlParams();
      const where = attendanceControlConditions(grant, { ...f, from: f.from!, to: f.to! }, p);
      return (
        await db.query(
          `select e.employee_code, e.display_name, coalesce(dep.name, '') as department, to_char(r.work_date, 'YYYY-MM-DD') as work_date, coalesce(s.code, '') as shift_code,
                  coalesce(to_char(coalesce(rv.in_time, s.in_time), 'HH24:MI'), '') as shift_in, coalesce(to_char(coalesce(rv.out_time, s.out_time), 'HH24:MI'), '') as shift_out,
                  st.code as status, r.late_minutes, r.early_departure_minutes, r.overtime_candidate_minutes, r.worked_minutes, r.scheduled_net_minutes,
                  case when r.amended then 'yes' else 'no' end as amended
             ${ATTENDANCE_CONTROL_FROM}
             left join shift_revision rv on rv.company_id = r.company_id and rv.id = r.shift_revision_id
            where ${where} and (r.late or r.early_departure or coalesce(r.overtime_candidate_minutes, 0) > 0)
            order by e.employee_code, r.work_date`,
          p.values,
        )
      ).rows;
    },
  },

  // CL-051: each run of at least `minimumDays` consecutive absent working days in the period (day-facts.ts ABSENCE_SQL): no
  // punch, no approved leave or outdoor duty, and a processed result of ABSENT (or, for a day not processed yet, a working day
  // with a shift and no failed punch source). A weekly off or holiday between two absent days neither counts nor ends the run;
  // anything else ends it. Only days before today count (today is not over), and a run is cut at the period's edges. Absent
  // working days are counted; calendar days run from the first absent day to the last. Sorted by employee code or start date.
  ABSCONDING_REPORT: {
    code: 'ABSCONDING_REPORT',
    title: 'Absconding report',
    resource: 'attendance',
    fieldGroup: 'operational',
    requiresPeriod: true,
    maxPeriodDays: ABSCONDING_MAX_DAYS,
    employeeFilters: ['search', 'departmentId', 'sort', 'direction'],
    sorts: ABSCONDING_SORTS,
    recordFilters: ['employeeId', 'locationId', 'minimumDays'],
    xlsx: true,
    checkFilters(f) {
      if (f.minimumDays === undefined) throw new HttpError(422, 'MINIMUM_DAYS_REQUIRED', 'Give the number of consecutive absent days (minimumDays) to report from', { field: 'minimumDays' });
    },
    columns: [
      ...EMPLOYEE_COLUMNS,
      { key: 'absent_from', header: 'Absent from' },
      { key: 'absent_to', header: 'Absent to' },
      { key: 'absent_days', header: 'Absent working days', numeric: true },
      { key: 'calendar_days', header: 'Calendar days', numeric: true },
      { key: 'last_punch_before', header: 'Last punch before (company time)' },
    ],
    async rows(db: Queryable, grant: AccessGrant, f: ReportFilters) {
      const to = f.to! < grant.businessDate ? f.to! : dayBefore(grant.businessDate);
      if (to < f.from!) return [];
      const p = new SqlParams();
      const facts = dayFactsSql(grant, p, { ...factsFilters(f), to });
      const minimum = p.add(f.minimumDays);
      const direction = f.direction === 'DESC' ? 'desc' : 'asc';
      // `sort` is typed with the employee list's columns; this report's own were checked against ABSCONDING_SORTS.
      const order = (f.sort as string | undefined) === 'fromDate' ?`r.from_date ${direction}, r.employee_code` : `r.employee_code ${direction}, r.from_date`;
      return (
        await db.query(
          `with k as (select d.employee_id, d.employee_code, d.display_name, d.department_name, d.work_date, ${ABSENCE_SQL('d')} as absence from (${facts}) d),
                seq as (select k.*, row_number() over (partition by k.employee_id order by k.work_date)
                                  - row_number() over (partition by k.employee_id, k.absence order by k.work_date) as grp
                          from k where k.absence <> 'OFF'),
                r as (select seq.employee_id, min(seq.employee_code) as employee_code, min(seq.display_name) as display_name,
                             (array_agg(seq.department_name order by seq.work_date))[1] as department_name,
                             min(seq.work_date) as from_date, max(seq.work_date) as to_date, count(*)::int as absent_days
                        from seq where seq.absence = 'ABSENT' group by seq.employee_id, seq.grp)
           select r.employee_code, r.display_name, coalesce(r.department_name, '') as department,
                  to_char(r.from_date, 'YYYY-MM-DD') as absent_from, to_char(r.to_date, 'YYYY-MM-DD') as absent_to, r.absent_days,
                  (r.to_date - r.from_date + 1) as calendar_days,
                  coalesce((select to_char(max(pp.occurred_at) at time zone c.tz, 'YYYY-MM-DD HH24:MI')
                              from attendance_punch pp
                             where pp.company_id = c.id and pp.employee_id = r.employee_id
                               and pp.occurred_at < (r.from_date::timestamp at time zone c.tz)), '') as last_punch_before
             from r
             cross join (select id, business_timezone as tz from company where id = ${p.add(grant.companyId)}::uuid) c
            where r.absent_days >= ${minimum}::int
            order by ${order}`,
          p.values,
        )
      ).rows;
    },
  },
};
