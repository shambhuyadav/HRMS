// My Team list (FR-094; BR-042; DF16): the acting employee's current direct reports, in active employment through
// notice, intersected with the selected assignment's scope kind and filters. Separated, archived and draft records are
// not current members. The list, its total, its export, the member detail and the team widgets share one predicate
// (BR-045; ZT27). The member detail's tabs are in detail.ts.
import { type Sorting, sortedBy } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';

export const CURRENT_MEMBER_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'] as const;

/** DF16 list filters, as the list and its export (report MY_TEAM) apply them. */
export interface TeamFilters {
  search?: string | undefined;
  departmentId?: string | undefined;
  locationId?: string | undefined;
  status?: string | undefined;
  /** DF16 "due-review range" over the next actionable review date, inclusive. */
  reviewDueFrom?: string | undefined;
  reviewDueTo?: string | undefined;
  /** A status of today's attendance record (the dashboard's "Unresolved attendance exceptions today"). */
  todayAttendance?: string | undefined;
  /** An open confirmation due on or before this date (the dashboard's "Team confirmations due"). */
  confirmationDueTo?: string | undefined;
}

export interface TeamQuery extends TeamFilters, Sorting {
  page: number;
  pageSize: number;
}

/** FR-056: the team list's sort keys and their columns in teamSelect. */
const TEAM_SORT_COLUMNS = {
  employeeCode: 'e.employee_code',
  displayName: 'e.display_name',
  department: 'd.name',
  designation: 'g.name',
  location: 'l.name',
  status: 'st.code',
  joiningDate: 'e.joining_date',
  nextReviewDate: 'nr.next_review',
} as const;
export const TEAM_SORTS = Object.keys(TEAM_SORT_COLUMNS);

/**
 * The member predicate shared by the list, its total, the detail, the export and the dashboard team metrics (BR-045).
 * BR-042 "current effective reporting relationships, not department membership alone": whatever the assignment's scope
 * kind, a member has a current manager_assignment to the acting employee; the kind and the filters then narrow it, so a
 * company-scoped or task-reached employee who does not report to the caller is not a member. A delegated task never
 * makes one (DF16). An account with no linked employee has no team.
 */
export function teamMemberPredicate(grant: AccessGrant, params: SqlParams, alias = 'e'): string {
  if (!grant.linkedEmployeeId) return 'false';
  const scope = employeeScopePredicate(grant, { company: `${alias}.company_id`, employee: `${alias}.id` }, params, { withoutDelegatedTasks: true });
  const day = `${params.add(grant.businessDate)}::date`;
  return `${scope}
      and exists (select 1 from manager_assignment tm
                   where tm.company_id = ${alias}.company_id and tm.employee_id = ${alias}.id and tm.manager_employee_id = ${params.add(grant.linkedEmployeeId)}::uuid
                     and tm.effective_from <= ${day} and (tm.effective_to is null or tm.effective_to > ${day}))
      and exists (select 1 from reference_value tst where tst.company_id = ${alias}.company_id and tst.id = ${alias}.status_id
                     and tst.code = any(${params.add(CURRENT_MEMBER_STATUSES)}::text[]))`;
}

/** The list's columns and joins with its filters, without an order or limit (aliases as TEAM_SORT_COLUMNS). */
function teamSelect(grant: AccessGrant, f: TeamFilters, params: SqlParams): string {
  const conditions = [teamMemberPredicate(grant, params)];
  const day = `${params.add(grant.businessDate)}::date`;
  if (f.search) {
    const pattern = params.add(`%${f.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    // DF16 "Search includes permitted work email/extension" (I-89 item 5).
    conditions.push(`(e.employee_code ilike ${pattern} or e.display_name ilike ${pattern} or e.work_email ilike ${pattern} or e.work_phone_extension like ${pattern})`);
  }
  if (f.departmentId) conditions.push(`ea.department_id = ${params.add(f.departmentId)}::uuid`);
  if (f.locationId) conditions.push(`ea.location_id = ${params.add(f.locationId)}::uuid`);
  if (f.status) conditions.push(`st.code = ${params.add(f.status)}`);
  if (f.reviewDueFrom) conditions.push(`nr.next_review >= ${params.add(f.reviewDueFrom)}::date`);
  if (f.reviewDueTo) conditions.push(`nr.next_review <= ${params.add(f.reviewDueTo)}::date`);
  if (f.todayAttendance) conditions.push(`ar.status = ${params.add(f.todayAttendance)}`);
  if (f.confirmationDueTo) {
    conditions.push(
      `st.code = 'ACTIVE_PROBATION' and exists (select 1 from employee_confirmation fc where fc.company_id = e.company_id and fc.employee_id = e.id
                                                   and fc.state in ('OPEN', 'REVIEW_PENDING') and fc.current_due_date <= ${params.add(f.confirmationDueTo)}::date)`,
    );
  }
  return `select e.id, e.employee_code as "employeeCode", e.display_name as "displayName", e.work_email as "workEmail", e.work_phone_extension as "workPhoneExtension",
            d.name as department, g.name as designation, l.name as location, mgr.display_name as manager, e.joining_date as "joiningDate",
            st.code as status, ar.status as "todayAttendance", nr.next_review as "nextReviewDate"
       from employee e
       join reference_value st on st.company_id = e.company_id and st.id = e.status_id
       left join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
            and ea.effective_from <= ${day} and (ea.effective_to is null or ea.effective_to > ${day})
       left join department d on d.company_id = ea.company_id and d.id = ea.department_id
       left join designation g on g.company_id = ea.company_id and g.id = ea.designation_id
       left join location l on l.company_id = ea.company_id and l.id = ea.location_id
       left join manager_assignment ma on ma.company_id = e.company_id and ma.employee_id = e.id
            and ma.effective_from <= ${day} and (ma.effective_to is null or ma.effective_to > ${day})
       left join employee mgr on mgr.company_id = ma.company_id and mgr.id = ma.manager_employee_id
       left join lateral (select rv.code as status from attendance_record r join reference_value rv on rv.company_id = r.company_id and rv.id = r.status_id
                           where r.company_id = e.company_id and r.employee_id = e.id and r.work_date = ${day}) ar on true
       left join lateral (select min(x.d) as next_review from (
                            select c.current_due_date as d from employee_confirmation c
                             where c.company_id = e.company_id and c.employee_id = e.id and c.state in ('OPEN', 'REVIEW_PENDING') and st.code = 'ACTIVE_PROBATION'
                            union all
                            select p.next_review_date from employee_increment_plan p
                             where p.company_id = e.company_id and p.employee_id = e.id and p.active) x) nr on true
      where ${conditions.join(' and ')}`;
}

const teamOrder = (s: Sorting) => sortedBy(s, TEAM_SORT_COLUMNS, 'e.employee_code, e.id');

export interface TeamPage {
  items: Record<string, unknown>[];
  total: number;
  page: number;
  pageSize: number;
}

export async function listTeam(db: Queryable, grant: AccessGrant, q: TeamQuery): Promise<TeamPage> {
  const params = new SqlParams();
  const select = teamSelect(grant, q, params);
  // The total comes from the same statement and filters as the page (BR-045), and survives a page past the last row.
  const total = Number((await db.query<{ n: string }>(`select count(*) as n from (${select}) x`, params.values)).rows[0]?.n ?? 0);
  const limit = params.add(q.pageSize);
  const offset = params.add((q.page - 1) * q.pageSize);
  const rows = await db.query<Record<string, unknown>>(`${select} order by ${teamOrder(q)} limit ${limit} offset ${offset}`, params.values);
  return { items: rows.rows, total, page: q.page, pageSize: q.pageSize };
}

/** Every row of the list for the same filters and order (report MY_TEAM; DF16 "Counts and export reflect identical membership and filters"). */
export async function teamExportRows(db: Queryable, grant: AccessGrant, f: TeamFilters & Sorting): Promise<Record<string, unknown>[]> {
  const params = new SqlParams();
  const select = teamSelect(grant, f, params);
  return (await db.query<Record<string, unknown>>(`${select} order by ${teamOrder(f)}`, params.values)).rows;
}

/** The department and location filter choices: only those the caller's current members are in (no other team's), by name. */
export async function teamFilterOptions(db: Queryable, grant: AccessGrant) {
  const params = new SqlParams();
  const member = teamMemberPredicate(grant, params);
  const day = `${params.add(grant.businessDate)}::date`;
  const rows = (
    await db.query<{ kind: 'department' | 'location'; id: string; name: string }>(
      `with members as (select ea.department_id, ea.location_id, ea.company_id
                          from employee e join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
                               and ea.effective_from <= ${day} and (ea.effective_to is null or ea.effective_to > ${day})
                         where ${member})
       select distinct 'department' as kind, d.id, d.name from members m join department d on d.company_id = m.company_id and d.id = m.department_id
       union
       select distinct 'location', l.id, l.name from members m join location l on l.company_id = m.company_id and l.id = m.location_id
       order by 3, 2`,
      params.values,
    )
  ).rows;
  const of = (kind: string) => rows.filter((r) => r.kind === kind).map(({ id, name }) => ({ id, name }));
  return { departments: of('department'), locations: of('location') };
}
