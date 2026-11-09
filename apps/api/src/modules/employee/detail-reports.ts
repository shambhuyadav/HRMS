// FR-007 "authorised exports for employee, family, qualification, past employer ... details" (I-82 item 2): one export per list
// section of the employee record (employee/record-sections.ts). Each is confidential (employee.export.private, an eligible
// Admin's ceiling-only grant; BR-053 gives the Employee OWN context no bulk export), takes the employee list's own filters and
// row scope (FR-007 "List and export use identical filters and authorised scope") and lists active entries only, never a removed
// one or a payroll identifier. FR-007 "export column definitions are approved before release": these columns await the owner's
// approval and samples (I-40 item 12).
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { ReportDefinition, ReportFilters } from '../report/catalogue.js';
import type { Queryable } from '../../db/queryable.js';
import { SECTION_EXPORT_COLUMNS, SECTION_EXPORT_JOINS, SECTION_EXPORT_ORDER, type ListSectionKey } from './record-sections.js';
import { employeeFilterConditions, employeeOrderBy } from './service.js';

const EMPLOYEE_COLUMNS: ReportDefinition['columns'] = [
  { key: 'employee_code', header: 'Employee code' },
  { key: 'display_name', header: 'Name' },
  { key: 'status', header: 'Status' },
];

/** The section's rows for the employees the list's filters and the requester's scope select, in the list's order. */
function sectionRows(section: ListSectionKey) {
  return async (db: Queryable, grant: AccessGrant, f: ReportFilters): Promise<Record<string, unknown>[]> => {
    const p = new SqlParams();
    const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
    const day = `${p.add(grant.businessDate)}::date`;
    const filters = employeeFilterConditions(p, f)
      .map((c) => `and ${c}`)
      .join(' ');
    return (
      await db.query(
        `select e.employee_code, e.display_name, st.code as status, ${SECTION_EXPORT_COLUMNS[section]}
           from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
           left join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
                and ea.effective_from <= ${day} and (ea.effective_to is null or ea.effective_to > ${day})
           left join department d on d.company_id = ea.company_id and d.id = ea.department_id
           left join location l2 on l2.company_id = ea.company_id and l2.id = ea.location_id
           left join designation g on g.company_id = ea.company_id and g.id = ea.designation_id
           ${SECTION_EXPORT_JOINS[section]}
          where ${scope} ${filters}
          order by ${employeeOrderBy(f, { employeeCode: 'e.employee_code', displayName: 'e.display_name', joiningDate: 'e.joining_date', status: 'st.code', department: 'd.name', location: 'l2.name', designation: 'g.name', id: 'e.id' })}, ${SECTION_EXPORT_ORDER[section]}`,
        p.values,
      )
    ).rows;
  };
}

const sectionReport = (code: string, title: string, section: ListSectionKey, columns: ReportDefinition['columns']): ReportDefinition => ({
  code,
  title,
  resource: 'employee',
  fieldGroup: 'private',
  module: 'employee-record',
  requiresPeriod: false,
  employeeFilters: true,
  statusFilter: true,
  columns: [...EMPLOYEE_COLUMNS, ...columns],
  rows: sectionRows(section),
});

export const EMPLOYEE_DETAIL_REPORTS: Record<string, ReportDefinition> = {
  EMPLOYEE_FAMILY: sectionReport('EMPLOYEE_FAMILY', 'Employee family and dependants', 'family-members', [
    { key: 'relationship', header: 'Relationship' },
    { key: 'full_name', header: 'Family member' },
    { key: 'date_of_birth', header: 'Date of birth' },
    { key: 'dependant', header: 'Dependant' },
  ]),
  EMPLOYEE_QUALIFICATIONS: sectionReport('EMPLOYEE_QUALIFICATIONS', 'Employee qualifications', 'qualifications', [
    { key: 'level', header: 'Level' },
    { key: 'qualification', header: 'Qualification' },
    { key: 'specialisation', header: 'Specialisation' },
    { key: 'institution', header: 'Institution or board' },
    { key: 'completion_year', header: 'Year of completion' },
  ]),
  EMPLOYEE_PRIOR_EMPLOYMENT: sectionReport('EMPLOYEE_PRIOR_EMPLOYMENT', 'Employee prior employment', 'prior-employments', [
    { key: 'employer_name', header: 'Employer' },
    { key: 'designation', header: 'Designation' },
    { key: 'from_date', header: 'From' },
    { key: 'to_date', header: 'To (inclusive)' },
  ]),
};
