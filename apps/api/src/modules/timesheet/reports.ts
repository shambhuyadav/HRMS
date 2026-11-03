// FR-048 TMS reports (module-local, within the assignment's row scope; no billing or payroll effect).
//
// Hours: approved time grouped by any of employee, project, job, activity and week, counted from the lines of each
// timesheet's approved revision in force. Group totals, the grand total and the line count all come from the same
// lines, so they reconcile (FR-048 acceptance); a superseded approved revision is not counted twice.
//
// Utilisation (F1): approved productive hours / scheduled eligible work hours x 100; a zero denominator gives N/A.
// Scheduled hours follow the shift and calendar data already kept: on each day of the range within the employment
// (joining date to the approved last working date, DF04 eligibility) that is a working day of the employee's location
// calendar (shift/calendar.ts, as attendance and leave count them), the net minutes of the shift assigned that day, on
// its revision in force that day (elapsed time minus scheduled unpaid breaks). Approved leave is not deducted: the
// formula's denominator is scheduled hours, as written. When a working day has no shift assigned the schedule is
// unknown, so the employee's utilisation is NOT_CONFIGURED rather than guessed.
import { DEFAULT_PAGE_SIZE, type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { workingDaySql } from '../shift/calendar.js';
import { daysBetween, requireDate } from './common.js';

/** Technical bound on one report request (days); split longer ranges. */
export const MAX_REPORT_DAYS = 366;

export const DIMENSIONS = ['employee', 'project', 'job', 'activity', 'period'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** `order` names output columns (the groups are paged over them, with the ids as tie-breakers). */
const DIMENSION_SQL: Record<Dimension, { select: string[]; group: string[]; order: string }> = {
  employee: {
    select: ['l.employee_id as "employeeId"', 'e.employee_code as "employeeCode"', 'e.display_name as "employeeName"'],
    group: ['l.employee_id', 'e.employee_code', 'e.display_name'],
    order: '"employeeCode", "employeeId"',
  },
  project: {
    select: ['l.project_id as "projectId"', 'p.code as "projectCode"', 'p.name as "projectName"'],
    group: ['l.project_id', 'p.code', 'p.name'],
    order: '"projectCode", "projectId"',
  },
  job: {
    select: ['l.job_id as "jobId"', 'p.code as "jobProjectCode"', 'j.code as "jobCode"', 'j.name as "jobName"'],
    group: ['l.job_id', 'p.code', 'j.code', 'j.name'],
    order: '"jobProjectCode", "jobCode", "jobId"',
  },
  activity: {
    select: ['l.activity_id as "activityId"', 'a.code as "activityCode"', 'a.name as "activityName"'],
    group: ['l.activity_id', 'a.code', 'a.name'],
    order: '"activityCode", "activityId"',
  },
  period: { select: [`to_char(l.period_start, 'YYYY-MM-DD') as "periodStart"`], group: ['l.period_start'], order: '"periodStart"' },
};

/** Rows answered without page/pageSize (each report's first answer before it could page); totals always cover all. */
export const HOURS_GROUP_CAP = 5000;
export const HOURS_LINE_CAP = 10000;
export const UTILISATION_EMPLOYEE_CAP = 1000;

function checkRange(from: string, to: string): void {
  requireDate(from, 'from');
  requireDate(to, 'to');
  if (to < from) throw new HttpError(422, 'INVALID_PERIOD', 'The range ends before it starts');
  if (daysBetween(from, to) + 1 > MAX_REPORT_DAYS) throw new HttpError(422, 'RANGE_TOO_LONG', `A report covers at most ${MAX_REPORT_DAYS} days; split the range`);
}

export interface HoursQuery extends Paging {
  from: string;
  to: string;
  groupBy: Dimension[];
  employeeId?: string | undefined;
  projectId?: string | undefined;
  jobId?: string | undefined;
  activityId?: string | undefined;
}

/** Approved lines in force within scope and the filters (shared by the groups and the totals). */
function approvedLines(grant: AccessGrant, q: HoursQuery, params: SqlParams): string {
  const scope = employeeScopePredicate(grant, { company: 'l.company_id', employee: 'l.employee_id' }, params);
  const where = [scope, 'l.removed_at is null', `l.work_date >= ${params.add(q.from)}::date`, `l.work_date <= ${params.add(q.to)}::date`];
  if (q.employeeId) where.push(`l.employee_id = ${params.add(q.employeeId)}::uuid`);
  if (q.projectId) where.push(`l.project_id = ${params.add(q.projectId)}::uuid`);
  if (q.jobId) where.push(`l.job_id = ${params.add(q.jobId)}::uuid`);
  if (q.activityId) where.push(`l.activity_id = ${params.add(q.activityId)}::uuid`);
  return `timesheet_line l
    join timesheet t on t.company_id = l.company_id and t.id = l.timesheet_id and t.approved_revision = l.revision
    join employee e on e.company_id = l.company_id and e.id = l.employee_id
    join timesheet_project p on p.company_id = l.company_id and p.id = l.project_id
    join timesheet_job j on j.company_id = l.company_id and j.id = l.job_id
    join timesheet_activity a on a.company_id = l.company_id and a.id = l.activity_id
   where ${where.join(' and ')}`;
}

// Hours are exact: minutes are whole quarter hours, so two decimals carry the value exactly (numeric, no floats).
const GROUP_MEASURES = `sum(l.minutes)::int as minutes, (sum(l.minutes)::numeric / 60)::numeric(12,2)::text as hours,
  coalesce(sum(l.minutes) filter (where l.productive), 0)::int as "productiveMinutes", count(*)::int as "lineCount"`;

/** The hours of the approved lines `from` grouped by the dimensions (no order or limit), and the order of the groups. */
function hoursGroups(from: string, dims: readonly Dimension[]): { sql: string; order: string } {
  const select = dims.flatMap((d) => DIMENSION_SQL[d].select);
  const group = dims.flatMap((d) => DIMENSION_SQL[d].group);
  return { sql: `select ${select.join(', ')}, ${GROUP_MEASURES} from ${from} group by ${group.join(', ')}`, order: dims.map((d) => DIMENSION_SQL[d].order).join(', ') };
}

export async function hoursReport(db: Queryable, grant: AccessGrant, q: HoursQuery) {
  checkRange(q.from, q.to);
  const dims = DIMENSIONS.filter((d) => q.groupBy.includes(d));
  if (dims.length === 0) throw new HttpError(422, 'GROUP_BY_REQUIRED', `Group by at least one of ${DIMENSIONS.join(', ')}`);
  const params = new SqlParams();
  const from = approvedLines(grant, q, params);
  const grouped = hoursGroups(from, dims);
  // FR-056: the groups are paged (or the first 5,000 without page/pageSize); `totalGroups` counts every group and the
  // totals always cover every line, whatever page is shown.
  const groups = await pageOf(db, grouped.sql, params.values, grouped.order, q, HOURS_GROUP_CAP);
  const totals = (await db.query(`select coalesce(sum(l.minutes), 0)::int as minutes, (coalesce(sum(l.minutes), 0)::numeric / 60)::numeric(12,2)::text as hours,
                                         coalesce(sum(l.minutes) filter (where l.productive), 0)::int as "productiveMinutes", count(*)::int as "lineCount"
                                    from ${from}`, params.values)).rows[0];
  return {
    from: q.from,
    to: q.to,
    basis: 'APPROVED',
    groupBy: dims,
    groups: groups.items,
    totalGroups: groups.total,
    ...(groups.page === undefined ? {} : { page: groups.page, pageSize: groups.pageSize }),
    totals,
  };
}

/**
 * The approved lines behind a report (FR-048: totals reconcile from the detailed lines): one page (FR-056), or the
 * first 10,000 without page/pageSize; `total` counts every line.
 */
export async function hoursLines(db: Queryable, grant: AccessGrant, q: Omit<HoursQuery, 'groupBy'>) {
  checkRange(q.from, q.to);
  const params = new SqlParams();
  const page = await pageOf(
    db,
    `select l.id, l.timesheet_id as "timesheetId", l.revision, l.employee_id as "employeeId", e.employee_code as "employeeCode", to_char(l.work_date, 'YYYY-MM-DD') as "workDate",
            to_char(l.period_start, 'YYYY-MM-DD') as "periodStart", p.code as "projectCode", j.code as "jobCode", a.code as "activityCode", l.minutes, l.productive
       from ${approvedLines(grant, { ...q, groupBy: [] }, params)}`,
    params.values,
    '"workDate", "employeeCode", "projectCode", "jobCode", "activityCode", id',
    q,
    HOURS_LINE_CAP,
  );
  return { from: q.from, to: q.to, basis: 'APPROVED', ...page };
}

/**
 * FR-048 TMS hours export (report catalogue TMS_HOURS): the hours report grouped by every dimension (employee, project,
 * job, activity and period) over the same approved lines, scope and filters, in the same order, every group (the report
 * pages them). Each approved line falls in exactly one group, so the rows add up to the report's totals.
 */
export async function hoursExportRows(db: Queryable, grant: AccessGrant, q: Omit<HoursQuery, 'groupBy' | keyof Paging>): Promise<Record<string, unknown>[]> {
  checkRange(q.from, q.to);
  const params = new SqlParams();
  const grouped = hoursGroups(approvedLines(grant, { ...q, groupBy: [] }, params), DIMENSIONS);
  return (await db.query(`select x.* from (${grouped.sql}) x order by ${grouped.order}`, params.values)).rows;
}

interface UtilisationRow {
  employee_id: string;
  employee_code: string;
  employee_name: string;
  scheduled_minutes: number;
  unscheduled_days: number;
  approved_minutes: number;
  productive_minutes: number;
  utilisation: string | null;
}

interface UtilisationTotalsRow {
  employees: number;
  not_configured: number;
  not_applicable: number;
  approved_minutes: string;
  productive_minutes: string;
  scheduled_minutes: string;
}

/**
 * F1 utilisation per employee in scope who had an allocation in the range or approved time in it (or the one
 * employee asked for). Utilisation is a percentage rounded half up to two decimals from exact numeric minutes.
 *
 * FR-056: the employees are paged by employee code (page/pageSize), or the first 1,000 without them; `total` and
 * `totals` are computed in SQL over every employee in scope, whatever page is shown, so they are never partial.
 * `totals` adds the measures up and counts the employees by status; the scheduled minutes of the population are not
 * known (null) while any employee's schedule is NOT_CONFIGURED, as for that employee.
 */
export async function utilisationReport(db: Queryable, grant: AccessGrant, q: { from: string; to: string; employeeId?: string | undefined } & Paging) {
  checkRange(q.from, q.to);
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const from = params.add(q.from);
  const to = params.add(q.to);
  const population = q.employeeId
    ? `e.id = ${params.add(q.employeeId)}::uuid`
    : `(exists (select 1 from resource_allocation ra where ra.company_id = e.company_id and ra.employee_id = e.id and ra.state = 'ACTIVE'
                  and ra.start_date <= ${to}::date and ra.end_date >= ${from}::date)
        or exists (select 1 from timesheet_line l join timesheet t on t.company_id = l.company_id and t.id = l.timesheet_id and t.approved_revision = l.revision
                    where l.company_id = e.company_id and l.employee_id = e.id and l.removed_at is null and l.work_date between ${from}::date and ${to}::date))`;
  const paged = q.page !== undefined || q.pageSize !== undefined;
  const pageSize = paged ? (q.pageSize ?? DEFAULT_PAGE_SIZE) : UTILISATION_EMPLOYEE_CAP;
  const page = paged ? (q.page ?? 1) : 1;
  const n = params.values.length;
  /** The per-employee measures (CTE `result`) for the population, or for one page of it by employee code. */
  const measures = (slice: string) => `with emp as (
         select e.id, e.company_id, e.employee_code, e.display_name, e.joining_date, hrms_exit_last_working_date(e.company_id, e.id) as last_working_date
           from employee e where ${scope} and ${population}
          ${slice}
       ), days as (
         select emp.id as employee_id, d::date as day
           from emp cross join lateral generate_series(greatest(${from}::date, emp.joining_date), least(${to}::date, coalesce(emp.last_working_date, ${to}::date)), interval '1 day') as d
          where ${workingDaySql('d', 'emp.id', 'emp.company_id')}
       ), scheduled as (
         select days.employee_id,
                coalesce(sum(sh.net), 0)::int as scheduled_minutes,
                count(*) filter (where sh.net is null)::int as unscheduled_days
           from days
           left join lateral (
             select f.minutes - f.break_minutes as net
               from shift_assignment sa cross join lateral hrms_shift_in_force(sa.company_id, sa.shift_id, days.day) f
              where sa.company_id = $1::uuid and sa.employee_id = days.employee_id
                and sa.effective_from <= days.day and (sa.effective_to is null or sa.effective_to > days.day)
           ) sh on true
          group by days.employee_id
       ), approved as (
         select l.employee_id, sum(l.minutes)::int as approved_minutes, coalesce(sum(l.minutes) filter (where l.productive), 0)::int as productive_minutes
           from timesheet_line l join timesheet t on t.company_id = l.company_id and t.id = l.timesheet_id and t.approved_revision = l.revision
          where l.company_id = $1::uuid and l.employee_id in (select id from emp) and l.removed_at is null and l.work_date between ${from}::date and ${to}::date
          group by l.employee_id
       ), result as (
         select emp.id as employee_id, emp.employee_code, emp.display_name as employee_name,
                coalesce(sc.scheduled_minutes, 0) as scheduled_minutes, coalesce(sc.unscheduled_days, 0) as unscheduled_days,
                coalesce(ap.approved_minutes, 0) as approved_minutes, coalesce(ap.productive_minutes, 0) as productive_minutes,
                case when coalesce(sc.scheduled_minutes, 0) > 0
                     then round(coalesce(ap.productive_minutes, 0)::numeric * 100 / sc.scheduled_minutes, 2)::text end as utilisation
           from emp left join scheduled sc on sc.employee_id = emp.id left join approved ap on ap.employee_id = emp.id
       )`;
  const rows = (
    await db.query<UtilisationRow>(`${measures(`order by e.employee_code, e.id limit $${n + 1} offset $${n + 2}`)} select * from result order by employee_code, employee_id`, [
      ...params.values,
      pageSize,
      (page - 1) * pageSize,
    ])
  ).rows;
  const t = (
    await db.query<UtilisationTotalsRow>(
      `${measures('')}
       select count(*)::int as employees,
              count(*) filter (where unscheduled_days > 0)::int as not_configured,
              count(*) filter (where unscheduled_days = 0 and scheduled_minutes = 0)::int as not_applicable,
              coalesce(sum(approved_minutes), 0)::bigint::text as approved_minutes,
              coalesce(sum(productive_minutes), 0)::bigint::text as productive_minutes,
              coalesce(sum(scheduled_minutes) filter (where unscheduled_days = 0), 0)::bigint::text as scheduled_minutes
         from result`,
      params.values,
    )
  ).rows[0]!;
  const totals = {
    employees: t.employees,
    byStatus: { OK: t.employees - t.not_configured - t.not_applicable, NOT_APPLICABLE: t.not_applicable, NOT_CONFIGURED: t.not_configured },
    approvedMinutes: Number(t.approved_minutes),
    productiveMinutes: Number(t.productive_minutes),
    scheduledMinutes: t.not_configured > 0 ? null : Number(t.scheduled_minutes),
  };
  const items = rows.map((r) => {
    const base = {
      employeeId: r.employee_id,
      employeeCode: r.employee_code,
      employeeName: r.employee_name,
      approvedMinutes: r.approved_minutes,
      productiveMinutes: r.productive_minutes,
    };
    if (r.unscheduled_days > 0) {
      return {
        ...base,
        status: 'NOT_CONFIGURED' as const,
        reason: 'NO_SHIFT_ASSIGNED',
        message: 'Some working days in the range have no shift assigned, so the scheduled hours are not known',
        unscheduledDays: r.unscheduled_days,
        scheduledMinutes: null,
        utilisationPercent: null,
      };
    }
    if (r.scheduled_minutes === 0) return { ...base, status: 'NOT_APPLICABLE' as const, display: 'N/A', scheduledMinutes: 0, utilisationPercent: null };
    return { ...base, status: 'OK' as const, scheduledMinutes: r.scheduled_minutes, utilisationPercent: r.utilisation };
  });
  return {
    from: q.from,
    to: q.to,
    formula: 'approved productive hours / scheduled eligible work hours x 100 (F1)',
    scheduleBasis: 'Assigned shift net minutes on Monday-Friday working days within employment, excluding location holidays; approved leave is not deducted',
    items,
    total: t.employees,
    ...(paged ? { page, pageSize } : {}),
    totals,
  };
}
