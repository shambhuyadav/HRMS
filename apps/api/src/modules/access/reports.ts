// The user access register (BRD role matrix: the System Administrator's "access reviews"; the source system's User Master and
// User Rights). One row per role assignment of the company: the account and the employee it is linked to today, the role, its
// scope and restrictions, its state and dates, and who asked for it and who approved it. It lists access, never what the
// access shows: no employee fields beyond code and name, no purpose text, no decision reasons.
import { HttpError } from '../../http/errors.js';
import { SqlParams } from './authorize.js';
import type { ReportDefinition } from '../report/catalogue.js';

const GRANT_STATES: readonly string[] = ['PENDING', 'ACTIVE', 'REVOKED'];

export const ACCESS_REPORTS: Record<string, ReportDefinition> = {
  USER_ACCESS: {
    code: 'USER_ACCESS',
    title: 'User access register',
    resource: 'access',
    fieldGroup: 'operational',
    requiresPeriod: false,
    // Accounts are not employees: like the user list, only an unrestricted company-scope assignment reads them all.
    companyScopeOnly: true,
    statusFilter: true,
    checkFilters(f) {
      if (f.status !== undefined && !GRANT_STATES.includes(f.status)) throw new HttpError(422, 'INVALID_FILTER', `The grant state is one of ${GRANT_STATES.join(', ')}`, { field: 'status' });
    },
    columns: [
      { key: 'account', header: 'Account' },
      { key: 'account_status', header: 'Account status' },
      { key: 'employee_code', header: 'Employee code' },
      { key: 'employee_name', header: 'Employee' },
      { key: 'role', header: 'Role' },
      { key: 'scope', header: 'Scope' },
      { key: 'restrictions', header: 'Restrictions' },
      { key: 'permissions', header: 'Permissions' },
      { key: 'state', header: 'Grant state' },
      { key: 'effective_from', header: 'From' },
      { key: 'effective_to', header: 'Until (not included)' },
      { key: 'requested_by', header: 'Requested by' },
      { key: 'approved_by', header: 'Approved by' },
      { key: 'approved_at', header: 'Approved at (company time)' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams([grant.companyId, grant.businessDate]);
      const state = f.status === undefined ? '' : `and ra.state = ${p.add(f.status)}`;
      return (
        await db.query(
          `select ua.account_key as account,
                  case when ua.active then 'Active' else 'Deactivated' end as account_status,
                  e.employee_code, e.display_name as employee_name,
                  r.name as role,
                  case ra.scope_kind when 'COMPANY' then 'Company-wide' when 'TEAM' then 'Own team' when 'ASSIGNED' then 'Assigned people'
                                     when 'OWN' then 'Own record' end as scope,
                  coalesce((select string_agg(n || ' ' || d || case when n = 1 then '' else 's' end, ', ' order by d)
                              from (select case f.dimension when 'DEPARTMENT' then 'department' when 'LOCATION' then 'location' else 'employee' end as d,
                                           count(*) as n
                                      from role_scope_filter f
                                     where f.company_id = ra.company_id and f.role_assignment_id = ra.id
                                     group by f.dimension) x), 'None') as restrictions,
                  (select count(*) from role_assignment_permission rap where rap.company_id = ra.company_id and rap.role_assignment_id = ra.id)::int as permissions,
                  case ra.state when 'PENDING' then 'Waiting for approval' when 'ACTIVE' then 'Approved' else 'Ended' end as state,
                  ra.effective_from::text as effective_from, ra.effective_to::text as effective_to,
                  rq.account_key as requested_by,
                  case when ra.bootstrapped then 'Set up at installation' else ap.account_key end as approved_by,
                  to_char(ra.approved_at at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI') as approved_at
             from role_assignment ra
             join company c on c.id = ra.company_id
             join role r on r.company_id = ra.company_id and r.id = ra.role_id
             join user_account ua on ua.id = ra.user_id
             left join lateral (
               select emp.employee_code, emp.display_name
                 from user_employee_link l
                 join employee emp on emp.company_id = l.company_id and emp.id = l.employee_id
                where l.company_id = ra.company_id and l.user_id = ra.user_id
                  and l.effective_from <= $2::date and (l.effective_to is null or l.effective_to > $2::date)
                order by l.effective_from desc
                limit 1) e on true
             left join user_account rq on rq.id = ra.created_by
             left join user_account ap on ap.id = ra.approved_by
            where ra.company_id = $1 ${state}
            order by ua.account_key, r.name, ra.effective_from, ra.id`,
          p.values,
        )
      ).rows;
    },
  },
};
