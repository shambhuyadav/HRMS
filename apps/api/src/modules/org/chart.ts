// Organisation chart (BRD coverage CL-023 "Org Structure", under FR-001/FR-010; built 10 Nov 2026 from the owner's reference system):
// the current reporting lines as a tree. Read-only. Everyone employed today (active, probation or notice) whom the requester may list
// (the employee list's own permission and scope, BR-026: a manager sees their team, HR the company), each with their manager on that
// day (manager assignments, FR-003) and their current department, location and designation. The tree is assembled by the client:
// people whose manager is not in the list (or who have none) are its roots. Operational fields only.
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';

/** A technical bound for one response; a company above it gets `truncated` (and a later paging), never a silent cut. */
export const ORG_CHART_LIMIT = 5000;

export interface OrgChartNode {
  id: string;
  code: string;
  name: string;
  designation: string | null;
  department: string | null;
  location: string | null;
  managerId: string | null;
}

export async function orgChart(db: Queryable, grant: AccessGrant): Promise<{ asOf: string; items: OrgChartNode[]; truncated: boolean }> {
  const p = new SqlParams();
  const day = `${p.add(grant.businessDate)}::date`;
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
  const rows = (
    await db.query<OrgChartNode>(
      `select e.id, e.employee_code as code, e.display_name as name, g.name as designation, d.name as department, l.name as location,
              ma.manager_employee_id as "managerId"
         from employee e
         join reference_value st on st.company_id = e.company_id and st.id = e.status_id
              and st.code in ('ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE')
         left join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
              and ea.effective_from <= ${day} and (ea.effective_to is null or ea.effective_to > ${day})
         left join department d on d.company_id = ea.company_id and d.id = ea.department_id
         left join location l on l.company_id = ea.company_id and l.id = ea.location_id
         left join designation g on g.company_id = ea.company_id and g.id = ea.designation_id
         left join manager_assignment ma on ma.company_id = e.company_id and ma.employee_id = e.id
              and ma.effective_from <= ${day} and (ma.effective_to is null or ma.effective_to > ${day})
        where e.company_id = ${p.add(grant.companyId)}::uuid and ${scope}
        order by e.display_name, e.employee_code
        limit ${ORG_CHART_LIMIT + 1}`,
      p.values,
    )
  ).rows;
  return { asOf: grant.businessDate, items: rows.slice(0, ORG_CHART_LIMIT), truncated: rows.length > ORG_CHART_LIMIT };
}
