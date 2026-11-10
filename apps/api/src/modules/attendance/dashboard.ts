// Attendance dashboard (BRD coverage CL-053 "Attendance Dashboard", under FR-019 to FR-027; built 10 Nov 2026 from the reference
// system's screen: a date and a department multi-select, with counts and lists of present, absent, on leave, late, not punched
// and weekly off or holiday, per department). Decided under owner delegation (6 Nov 2026; recorded 10 Nov 2026):
//
// - Who: the employees a processing run covers on the date (employed that day), in the requester's row scope, optionally in
//   the chosen departments (the assignment in force that day); day-facts.ts is the one source, as for the registers.
// - Each employee is in exactly one category, so the categories add up to the total:
//     a processed day (attendance_record) is read from its result: PRESENT and HALF_DAY are Present; ABSENT is Absent; LEAVE
//     and HALF_DAY_LEAVE are On leave; ON_DUTY, and a weekly off or holiday with worked minutes, are Outdoor duty or holiday
//     work; a weekly off or holiday without work is Weekly off or holiday; EXCEPTION is Exception to review;
//     a day not processed yet shows what is known, in the order evaluation applies it (DF05): a weekly off or holiday (holiday
//     work when punched), approved leave (full or half day), approved full-day outdoor duty, then Punched (not yet processed)
//     when a punch is in the shift's capture window, approved timed outdoor duty, and otherwise Not punched yet.
//   Late is counted beside them: the processed days flagged late (only evaluation knows the grace and the shift's start).
// - The answer says whether the date is processed for everyone, some or nobody in the selection.
// - Each count opens its list (GET /attendance/dashboard/employees), read with the same predicate, so a list's total is the
//   count it was opened from (BR-026, ZT17). Operational fields only.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { dayFactsSql } from './day-facts.js';

/** The dashboard's categories, in the order shown; together they hold every employee once. */
export const DASHBOARD_CATEGORIES = ['PRESENT', 'ABSENT', 'ON_LEAVE', 'OUTDOOR_OR_HOLIDAY_WORK', 'OFF_DAY', 'NEEDS_REVIEW', 'PUNCHED', 'NOT_PUNCHED'] as const;
export type DashboardCategory = (typeof DASHBOARD_CATEGORIES)[number];
/** A list can also be opened on the late count, which overlaps the categories. */
export const DASHBOARD_LISTS = [...DASHBOARD_CATEGORIES, 'LATE'] as const;
export type DashboardList = (typeof DASHBOARD_LISTS)[number];

/** Technical bound on the department choice of one request (not a business rule). */
export const DASHBOARD_MAX_DEPARTMENTS = 50;

const CATEGORY_SQL = (d: string) => `case
    when ${d}.record_id is not null then case ${d}.record_status
      when 'PRESENT' then 'PRESENT' when 'HALF_DAY' then 'PRESENT'
      when 'ABSENT' then 'ABSENT'
      when 'LEAVE' then 'ON_LEAVE' when 'HALF_DAY_LEAVE' then 'ON_LEAVE'
      when 'ON_DUTY' then 'OUTDOOR_OR_HOLIDAY_WORK'
      when 'WEEKLY_OFF' then case when ${d}.record_worked_minutes > 0 then 'OUTDOOR_OR_HOLIDAY_WORK' else 'OFF_DAY' end
      when 'HOLIDAY' then case when ${d}.record_worked_minutes > 0 then 'OUTDOOR_OR_HOLIDAY_WORK' else 'OFF_DAY' end
      else 'NEEDS_REVIEW' end
    when ${d}.weekly_off or ${d}.holiday then case when ${d}.punch_count > 0 then 'OUTDOOR_OR_HOLIDAY_WORK' else 'OFF_DAY' end
    when ${d}.leave <> 'NONE' then 'ON_LEAVE'
    when ${d}.duty_full then 'OUTDOOR_OR_HOLIDAY_WORK'
    when ${d}.punch_count > 0 then 'PUNCHED'
    when ${d}.duty_timed then 'OUTDOOR_OR_HOLIDAY_WORK'
    else 'NOT_PUNCHED' end`;

export interface DashboardQuery {
  /** The date shown; the business date (today in company time) when not given. */
  date?: string | undefined;
  departmentId?: string[] | undefined;
}

/** The employee-days of the date with their category, as SQL over `p`. */
function categorised(grant: AccessGrant, p: SqlParams, date: string, departmentIds: readonly string[] | undefined): string {
  const facts = dayFactsSql(grant, p, { from: date, to: date, departmentIds });
  return `select d.*, ${CATEGORY_SQL('d')} as category, coalesce(d.record_late, false) as late from (${facts}) d`;
}

function checkQuery(q: DashboardQuery): void {
  if ((q.departmentId?.length ?? 0) > DASHBOARD_MAX_DEPARTMENTS) throw new HttpError(422, 'TOO_MANY_DEPARTMENTS', `Choose at most ${DASHBOARD_MAX_DEPARTMENTS} departments`);
}

type Counts = Record<DashboardCategory | 'LATE', number>;
const zero = (): Counts => Object.fromEntries([...DASHBOARD_CATEGORIES, 'LATE'].map((c) => [c, 0])) as Counts;

export interface DashboardDepartment {
  departmentId: string | null;
  departmentCode: string | null;
  departmentName: string | null;
  total: number;
  counts: Counts;
}

/** CL-053: the counts of one date per department and in total, and how far the date is processed. */
export async function attendanceDashboard(db: Queryable, grant: AccessGrant, q: DashboardQuery) {
  checkQuery(q);
  const date = q.date ?? grant.businessDate;
  const p = new SqlParams();
  const rows = (
    await db.query<{ department_id: string | null; department_code: string | null; department_name: string | null; category: DashboardCategory; n: number; late: number; processed: number }>(
      `select c.department_id, c.department_code, c.department_name, c.category, count(*)::int as n, (count(*) filter (where c.late))::int as late,
              (count(*) filter (where c.record_id is not null))::int as processed
         from (${categorised(grant, p, date, q.departmentId)}) c
        group by c.department_id, c.department_code, c.department_name, c.category`,
      p.values,
    )
  ).rows;
  const departments = new Map<string, DashboardDepartment>();
  const total: DashboardDepartment = { departmentId: null, departmentCode: null, departmentName: null, total: 0, counts: zero() };
  let processed = 0;
  for (const r of rows) {
    const key = r.department_id ?? '';
    const dep = departments.get(key) ?? { departmentId: r.department_id, departmentCode: r.department_code, departmentName: r.department_name, total: 0, counts: zero() };
    dep.counts[r.category] += r.n;
    dep.counts.LATE += r.late;
    dep.total += r.n;
    departments.set(key, dep);
    total.counts[r.category] += r.n;
    total.counts.LATE += r.late;
    total.total += r.n;
    processed += r.processed;
  }
  const state = total.total === 0 || processed === 0 ? 'NOT_PROCESSED' : processed === total.total ? 'PROCESSED' : 'PARTLY_PROCESSED';
  return {
    date,
    processing: { state, employees: total.total, processed },
    categories: DASHBOARD_CATEGORIES,
    departments: [...departments.values()].sort((a, b) => (a.departmentCode ?? '￿').localeCompare(b.departmentCode ?? '￿')),
    total,
  };
}

export interface DashboardListQuery extends DashboardQuery {
  list: DashboardList;
  /** One department of the selection (a department row's count); `departmentId` still bounds the selection. */
  inDepartment?: string | undefined;
  /** The employees without a department that day (a department row with none). */
  withoutDepartment?: boolean | undefined;
  page: number;
  pageSize: number;
}

/** CL-053: the employees behind one count of the dashboard, a page at a time, with the total (the count it was opened from). */
export async function attendanceDashboardList(db: Queryable, grant: AccessGrant, q: DashboardListQuery) {
  checkQuery(q);
  if (q.inDepartment && q.withoutDepartment) throw new HttpError(422, 'INVALID_FILTER', 'Choose one department, or the employees without one');
  const date = q.date ?? grant.businessDate;
  const p = new SqlParams();
  const base = categorised(grant, p, date, q.departmentId);
  const where = [q.list === 'LATE' ? 'c.late' : `c.category = ${p.add(q.list)}::text`];
  if (q.inDepartment) where.push(`c.department_id = ${p.add(q.inDepartment)}::uuid`);
  if (q.withoutDepartment) where.push('c.department_id is null');
  const from = `from (${base}) c where ${where.join(' and ')}`;
  const total = (await db.query<{ n: number }>(`select count(*)::int as n ${from}`, p.values)).rows[0]?.n ?? 0;
  const items = (
    await db.query(
      `select c.employee_id as "employeeId", c.employee_code as "employeeCode", c.display_name as "employeeName", c.department_code as "departmentCode",
              c.department_name as "departmentName", c.location_code as "locationCode", c.shift_code as "shiftCode", c.shift_in as "shiftIn", c.shift_out as "shiftOut",
              c.category, c.record_status as "processedStatus", c.record_id is not null as processed, c.late, c.record_late_minutes as "lateMinutes",
              c.punch_count as "punchCount", c.first_punch as "firstPunch", c.last_punch as "lastPunch", c.leave, c.source_unavailable as "punchSourceUnavailable"
         ${from}
        order by c.employee_code, c.employee_id
        limit ${p.add(q.pageSize)}::int offset ${p.add((q.page - 1) * q.pageSize)}::int`,
      p.values,
    )
  ).rows;
  return { date, list: q.list, items, total, page: q.page, pageSize: q.pageSize };
}
