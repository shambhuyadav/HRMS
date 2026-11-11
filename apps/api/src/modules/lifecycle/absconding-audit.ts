// Absconding audit report (BRD coverage CL-052 "Absconding Audit Report", under FR-018 restricted notes and warnings and FR-056 to
// FR-058 reports; BR-026; BR-045; DF02; DF08; migration 0283; built 11 Nov 2026 from the reference system's screen: filters company and
// "warning issued from" date; the absconding warnings issued: employee, date, type, by whom; decided under owner delegation, 6 Nov 2026).
//
// Definitions (the notes register's own, lifecycle/notes.ts, so a row here is a row of the register):
// - An absconding warning is a note of type WARNING whose category is ABSCONDING (0283), chosen when it is written. Warnings without a
//   category, and every other note type, are not counted.
// - The company is the requester's (the selected company); the employees are those of the requester's row scope (BR-026), the
//   requester's own record left out as everywhere in the register.
// - "Issued from" is the warning's date (the day it is about, note_date) on or after `from`, which is required; `to` optionally ends
//   the range. Every warning in that range is listed, with its status as the register derives it: ACTIVE, SUPERSEDED (corrected by a
//   later note, which is listed in its own right) or VOIDED (withdrawn with a reason).
// - Warning number: the warning's place among the employee's absconding warnings in force (ACTIVE), counted over all time in date
//   order: 1 for the first, 2 for the second, and so on. A corrected or voided warning has none.
// - Issued by: the person who wrote it (their employee name, else their account), and when it was recorded, in company time; the
//   source says whether it was written on screen or uploaded.
// The note text is never a column: the report says who was warned when and by whom, not what was said. Its right is its own
// confidential export (employee_note.export.restricted, BR-045), ceiling only.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { ReportDefinition, ReportFilters } from '../report/catalogue.js';

export async function abscondingAuditRows(db: Queryable, grant: AccessGrant, f: ReportFilters): Promise<Record<string, unknown>[]> {
  const p = new SqlParams();
  const company = `${p.add(grant.companyId)}::uuid`;
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p);
  const where = [`w.note_date >= ${p.add(f.from)}::date`];
  if (f.to) where.push(`w.note_date <= ${p.add(f.to)}::date`);
  if (grant.linkedEmployeeId) where.push(`w.employee_id <> ${p.add(grant.linkedEmployeeId)}::uuid`);
  const day = `hrms_business_date(${company}, now())`;
  return (
    await db.query(
      `with w as (
         select n.id, n.employee_id, n.note_date, n.source, n.created_at, n.created_by,
                case when exists (select 1 from employee_note_void v where v.company_id = n.company_id and v.note_id = n.id) then 'VOIDED'
                     when exists (select 1 from employee_note s where s.company_id = n.company_id and s.supersedes_note_id = n.id) then 'SUPERSEDED'
                     else 'ACTIVE' end as status
           from employee_note n
          where n.company_id = ${company} and n.note_kind = 'WARNING' and n.warning_category = 'ABSCONDING'
       ),
       numbered as (
         select w.*, case when w.status = 'ACTIVE'
                          then row_number() over (partition by w.employee_id, w.status = 'ACTIVE' order by w.note_date, w.created_at, w.id) end as warning_number
           from w
       )
       select e.employee_code, e.display_name,
              coalesce((select d.name from employment_assignment a join department d on d.company_id = a.company_id and d.id = a.department_id
                         where a.company_id = e.company_id and a.employee_id = e.id and a.effective_from <= least(w.note_date, ${day})
                         order by a.effective_from desc limit 1), '') as department,
              to_char(w.note_date, 'YYYY-MM-DD') as warning_date,
              'Absconding warning' as warning_type,
              w.warning_number,
              case w.status when 'ACTIVE' then 'Active' when 'SUPERSEDED' then 'Corrected by a later note' else 'Voided' end as status,
              coalesce((select se.display_name from user_employee_link l join employee se on se.company_id = l.company_id and se.id = l.employee_id
                         where l.company_id = e.company_id and l.user_id = w.created_by order by l.effective_from desc limit 1),
                       (select u.account_key from user_account u where u.id = w.created_by)) as issued_by,
              to_char(w.created_at at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI') as recorded_at,
              case w.source when 'IMPORT' then 'Bulk upload' else 'Entered on screen' end as source
         from numbered w
         join employee e on e.company_id = ${company} and e.id = w.employee_id
         join company c on c.id = e.company_id
        where ${scope} and ${where.join(' and ')}
        order by w.note_date, e.employee_code, w.created_at, w.id`,
      p.values,
    )
  ).rows;
}

export const ABSCONDING_AUDIT_REPORTS: Record<string, ReportDefinition> = {
  ABSCONDING_AUDIT: {
    code: 'ABSCONDING_AUDIT',
    title: 'Absconding audit',
    module: 'absconding-audit',
    resource: 'employee_note',
    fieldGroup: 'restricted',
    requiresPeriod: false,
    xlsx: true,
    // "Warning issued from" is required; an end is optional.
    checkFilters(f: ReportFilters) {
      if (!f.from) throw new HttpError(422, 'FROM_REQUIRED', 'Give the date the warnings were issued from', { field: 'from' });
    },
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'display_name', header: 'Name' },
      { key: 'department', header: 'Department' },
      { key: 'warning_date', header: 'Warning date' },
      { key: 'warning_type', header: 'Type' },
      { key: 'warning_number', header: 'Warning number', numeric: true },
      { key: 'status', header: 'Status' },
      { key: 'issued_by', header: 'Issued by' },
      { key: 'recorded_at', header: 'Recorded (company time)' },
      { key: 'source', header: 'Source' },
    ],
    rows: abscondingAuditRows,
  },
};
