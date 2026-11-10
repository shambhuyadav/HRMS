// Employee document compliance report (BRD coverage CL-150 "Analytics / Office Reports -> Employee Document Compliance", under
// FR-056 to FR-058; FR-010; BR-026; BR-045; DF02; migration 0261; built 10 Nov 2026 from the reference screen's structure: company,
// department, location, employee status and date filters; decided under owner delegation, 6 Nov 2026).
//
// Definitions (one rule, so the rows reconcile with the requirement list and each employee's documents):
// - As on: the `to` date when given, else the requester's business date. The requirements are those in force that day
//   (documents/requirements.ts): the company-wide ones and those of the employee's employment type.
// - Population: the employees in the requester's row scope (BR-026), by default the active ones (ACTIVE_PROBATION, ACTIVE_CONFIRMED,
//   NOTICE; the employee list's ACTIVE group), or the status or status group asked for; narrowed by department and location (their
//   assignment on the as-on day) and the employee search.
// - A mandatory type is held when the employee has a document of that type that is not rejected by the verifier, whose file the
//   malware scan has not quarantined, and that has not expired before the as-on day. A document still waiting for its scan or its
//   verification counts as held (it was supplied); a rejected, quarantined or expired one does not.
// - A row per employee missing at least one mandatory type: the missing types (labels, alphabetical), their count, and how many
//   types are mandatory for them. Compliant employees are not listed.
// Which employee lacks which document is derived from their confidential documents (DF02), so the report needs the same eligibility
// as reading them (BR-045): its own confidential export right, document_compliance.export.document, ceiling only.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { EMPLOYEE_STATUS_GROUPS, employeeFilterConditions } from '../employee/service.js';
import type { ReportDefinition, ReportFilters } from '../report/catalogue.js';

/** The as-on day of a request: its `to` date, or the requester's business date. */
export const asOnDay = (grant: AccessGrant, f: ReportFilters) => f.to ?? grant.businessDate;

/** The compliance rows: one per employee in the population missing at least one mandatory type, by employee code. */
export async function complianceRows(db: Queryable, grant: AccessGrant, f: ReportFilters): Promise<Record<string, unknown>[]> {
  const p = new SqlParams();
  const company = `${p.add(grant.companyId)}::uuid`;
  const day = `${p.add(asOnDay(grant, f))}::date`;
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
  const filters = employeeFilterConditions(p, f);
  // "Active employees" unless a status or status group is asked for.
  if (!f.status && !f.statusGroup) filters.push(`st.code = any(${p.add(EMPLOYEE_STATUS_GROUPS.ACTIVE)}::text[])`);
  if (f.locationId) filters.push(`ea.location_id = ${p.add(f.locationId)}::uuid`);
  return (
    await db.query(
      `with req as (
         select distinct r.document_type_id, r.employment_type_id
           from document_requirement r
          where r.company_id = ${company} and r.effective_from <= ${day} and (r.effective_to is null or r.effective_to > ${day})
       ),
       emp as (
         select e.id, e.employee_code, e.display_name, e.employment_type_id, st.label as status, d.name as department, l.name as location
           from employee e
           join reference_value st on st.company_id = e.company_id and st.id = e.status_id
           left join lateral (
             select a.department_id, a.location_id from employment_assignment a
              where a.company_id = e.company_id and a.employee_id = e.id and a.effective_from <= ${day} and (a.effective_to is null or a.effective_to > ${day})
              order by a.effective_from desc limit 1
           ) ea on true
           left join department d on d.company_id = e.company_id and d.id = ea.department_id
           left join location l on l.company_id = e.company_id and l.id = ea.location_id
          where e.company_id = ${company} and ${scope} ${filters.map((c) => `and ${c}`).join(' ')}
       ),
       due as (
         select distinct emp.id as employee_id, req.document_type_id
           from emp join req on req.employment_type_id is null or req.employment_type_id = emp.employment_type_id
       ),
       missing as (
         select due.employee_id, due.document_type_id
           from due
          where not exists (
            select 1 from employee_document doc
              join attachment a on a.company_id = doc.company_id and a.id = doc.attachment_id
             where doc.company_id = ${company} and doc.employee_id = due.employee_id and doc.document_type_id = due.document_type_id
               and doc.verification_state <> 'REJECTED'
               and a.scan_state is distinct from 'QUARANTINED'
               and (doc.expires_on is null or doc.expires_on >= ${day}))
       )
       select emp.employee_code, emp.display_name, coalesce(emp.department, '') as department, coalesce(emp.location, '') as location, emp.status,
              string_agg(t.label, '; ' order by t.label) as missing_types,
              count(*)::int as missing_count,
              (select count(*)::int from due d2 where d2.employee_id = emp.id) as required_count
         from missing m
         join emp on emp.id = m.employee_id
         join reference_value t on t.company_id = ${company} and t.id = m.document_type_id
        group by emp.id, emp.employee_code, emp.display_name, emp.department, emp.location, emp.status
        order by emp.employee_code`,
      p.values,
    )
  ).rows;
}

export const DOCUMENT_COMPLIANCE_REPORTS: Record<string, ReportDefinition> = {
  EMPLOYEE_DOCUMENT_COMPLIANCE: {
    code: 'EMPLOYEE_DOCUMENT_COMPLIANCE',
    title: 'Employee document compliance',
    module: 'documents',
    resource: 'document_compliance',
    fieldGroup: 'document',
    requiresPeriod: false,
    employeeFilters: ['search', 'statusGroup', 'departmentId'],
    statusFilter: true,
    recordFilters: ['locationId'],
    xlsx: true,
    // The report is as on one day: `to` names it; a period start means nothing here and is refused, not ignored.
    checkFilters(f: ReportFilters) {
      if (f.from !== undefined) throw new HttpError(422, 'FILTER_NOT_SUPPORTED', 'This report is as on one day: give it as the to date only');
    },
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'display_name', header: 'Name' },
      { key: 'department', header: 'Department' },
      { key: 'location', header: 'Location' },
      { key: 'status', header: 'Employee status' },
      { key: 'missing_types', header: 'Missing document types' },
      { key: 'missing_count', header: 'Missing count', numeric: true },
      { key: 'required_count', header: 'Mandatory types', numeric: true },
    ],
    rows: complianceRows,
  },
};
