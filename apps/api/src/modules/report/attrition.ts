// Attrition reports (BRD coverage CL-147 "Attrition Register" and CL-148 "Attrition Summary", under FR-056/FR-058; built 10 Nov 2026
// from the reference system's screens, recorded in the owner's walkthrough: a register of separations in a period, and a summary per
// position or per month with Opening, Addition, Separation, Closing, Average and Attrition rate = Separation / Average).
//
// Definitions (one rule for all three reports, so they reconcile):
// - An employee's separation is the first day they are no longer employed: the earliest status change to INACTIVE_SEPARATED in the
//   employee status history (which the database writes for every status change); their last working date is the day before.
// - "Employed at the start of day D": joined before D, and not separated by D (no separation, or it takes effect after D). Draft
//   employees were never employed.
// - Over a period [from, to]: Opening = employed at the start of `from`; Additions = joined within the period; Separations = last
//   working date within the period; Closing = employed at the start of the day after `to`. So Opening + Additions − Separations =
//   Closing, always. Average = (Opening + Closing) / 2; Attrition rate (%) = Separations / Average × 100, empty when Average is 0.
// - The position, department and location are the employee's assignment on their last day in the period (the period end, or their
//   last working date if earlier).
// Operational fields only: no reason, no pay. Rows are limited to the requester's scope like every report (BR-026).
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { employeeFilterConditions } from '../employee/service.js';
import type { ReportDefinition, ReportFilters } from './catalogue.js';

/** Up to three years per request (a technical bound for a summary scan, not a business rule). */
const MAX_DAYS = 3 * 366;

/** The employees in scope with their joining date, separation day, and the assignment of their last day in the period. */
function baseRows(grant: AccessGrant, p: SqlParams, f: ReportFilters): string {
  const company = `${p.add(grant.companyId)}::uuid`;
  const to = `${p.add(f.to)}::date`;
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
  const filters = employeeFilterConditions(p, f)
    .map((c) => `and ${c}`)
    .join(' ');
  return `
    with sep as (
      select h.employee_id, min(h.effective_date) as separated_on
        from employee_status_history h
        join reference_value s on s.company_id = h.company_id and s.id = h.status_id and s.code = 'INACTIVE_SEPARATED'
       where h.company_id = ${company}
       group by h.employee_id
    )
    select e.id, e.employee_code, e.display_name, e.joining_date, sep.separated_on,
           d.name as department, l.name as location, g.name as position
      from employee e
      join reference_value st on st.company_id = e.company_id and st.id = e.status_id
      left join sep on sep.employee_id = e.id
      left join lateral (
        select a.department_id, a.location_id, a.designation_id
          from employment_assignment a
         where a.company_id = e.company_id and a.employee_id = e.id
           and a.effective_from <= least(${to}, coalesce(sep.separated_on - 1, ${to}))
         order by a.effective_from desc
         limit 1
      ) ea on true
      left join department d on d.company_id = e.company_id and d.id = ea.department_id
      left join location l on l.company_id = e.company_id and l.id = ea.location_id
      left join designation g on g.company_id = e.company_id and g.id = ea.designation_id
     where e.company_id = ${company} and ${scope} and st.code <> 'DRAFT' and e.joining_date <= ${to} ${filters}`;
}

/** The four counts and the derived average and rate, for a period whose bounds are the SQL expressions given. */
function countColumns(from: string, to: string): string {
  const opening = `count(*) filter (where b.joining_date < ${from} and (b.separated_on is null or b.separated_on > ${from}))`;
  const additions = `count(*) filter (where b.joining_date between ${from} and ${to})`;
  const separations = `count(*) filter (where b.separated_on - 1 between ${from} and ${to})`;
  const closing = `count(*) filter (where b.joining_date <= ${to} and (b.separated_on is null or b.separated_on > ${to} + 1))`;
  return `${opening} as opening, ${additions} as additions, ${separations} as separations, ${closing} as closing`;
}

const DERIVED = `opening, additions, separations, closing,
  round((opening + closing) / 2.0, 1) as average,
  case when opening + closing = 0 then null else round(separations * 200.0 / (opening + closing), 2) end as attrition_rate`;

const SUMMARY_COLUMNS = [
  { key: 'opening', header: 'Opening', numeric: true },
  { key: 'additions', header: 'Additions', numeric: true },
  { key: 'separations', header: 'Separations', numeric: true },
  { key: 'closing', header: 'Closing', numeric: true },
  { key: 'average', header: 'Average', numeric: true },
  { key: 'attrition_rate', header: 'Attrition rate (%)', numeric: true },
];

export const ATTRITION_REPORTS: Record<string, ReportDefinition> = {
  ATTRITION_REGISTER: {
    code: 'ATTRITION_REGISTER',
    title: 'Attrition register',
    resource: 'employee',
    fieldGroup: 'operational',
    requiresPeriod: true,
    maxPeriodDays: MAX_DAYS,
    employeeFilters: ['search', 'departmentId'],
    xlsx: true,    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'display_name', header: 'Name' },
      { key: 'department', header: 'Department' },
      { key: 'location', header: 'Location' },
      { key: 'position', header: 'Position' },
      { key: 'joining_date', header: 'Joining date' },
      { key: 'last_working_date', header: 'Last working date' },
      { key: 'separation_type', header: 'Separation type' },
      { key: 'tenure_years', header: 'Tenure (years)', numeric: true },
    ],
    async rows(db: Queryable, grant: AccessGrant, f: ReportFilters) {
      const p = new SqlParams();
      const base = baseRows(grant, p, f);
      const from = `${p.add(f.from)}::date`;
      const to = `${p.add(f.to)}::date`;
      return (
        await db.query(
          `select b.employee_code, b.display_name, b.department, b.location, b.position, b.joining_date,
                  b.separated_on - 1 as last_working_date,
                  coalesce(x.separation_type, '') as separation_type,
                  round(((b.separated_on - b.joining_date) / 365.25)::numeric, 1) as tenure_years
             from (${base}) b
             left join lateral (
               select c.separation_type from exit_case c
                where c.company_id = ${p.add(grant.companyId)}::uuid and c.employee_id = b.id and c.approved_leaving_date = b.separated_on - 1
                order by c.approved_at desc nulls last
                limit 1
             ) x on true
            where b.separated_on - 1 between ${from} and ${to}
            order by last_working_date, b.employee_code`,
          p.values,
        )
      ).rows;
    },
  },

  ATTRITION_SUMMARY: {
    code: 'ATTRITION_SUMMARY',
    title: 'Attrition summary by position',
    resource: 'employee',
    fieldGroup: 'operational',
    requiresPeriod: true,
    maxPeriodDays: MAX_DAYS,
    employeeFilters: ['departmentId'],
    xlsx: true,    columns: [{ key: 'position', header: 'Position' }, ...SUMMARY_COLUMNS],
    async rows(db: Queryable, grant: AccessGrant, f: ReportFilters) {
      const p = new SqlParams();
      const base = baseRows(grant, p, f);
      const from = `${p.add(f.from)}::date`;
      const to = `${p.add(f.to)}::date`;
      return (
        await db.query(
          `select position, ${DERIVED} from (
             select case when grouping(b.position) = 1 then 'All positions' else coalesce(b.position, 'Not assigned') end as position,
                    grouping(b.position) as is_total,
                    ${countColumns(from, to)}
               from (${base}) b
              group by rollup (b.position)
           ) t
           order by is_total, position`,
          p.values,
        )
      ).rows;
    },
  },

  ATTRITION_MONTHLY: {
    code: 'ATTRITION_MONTHLY',
    title: 'Attrition summary by month',
    resource: 'employee',
    fieldGroup: 'operational',
    requiresPeriod: true,
    maxPeriodDays: MAX_DAYS,
    employeeFilters: ['departmentId'],
    xlsx: true,    columns: [{ key: 'month', header: 'Month' }, ...SUMMARY_COLUMNS],
    async rows(db: Queryable, grant: AccessGrant, f: ReportFilters) {
      const p = new SqlParams();
      const base = baseRows(grant, p, f);
      const from = `${p.add(f.from)}::date`;
      const to = `${p.add(f.to)}::date`;
      // Each month of the period, cut to the period where it starts or ends inside a month.
      return (
        await db.query(
          `select month, ${DERIVED} from (
             select to_char(m.month_start, 'YYYY-MM') as month,
                    ${countColumns('m.start_day', 'm.end_day')}
               from (
                 select gs::date as month_start,
                        greatest(gs::date, ${from}) as start_day,
                        least((gs + interval '1 month - 1 day')::date, ${to}) as end_day
                   from generate_series(date_trunc('month', ${from}), date_trunc('month', ${to}), interval '1 month') gs
               ) m
               cross join (${base}) b
              group by m.month_start, m.start_day, m.end_day
           ) t
           order by month`,
          p.values,
        )
      ).rows;
    },
  },
};
