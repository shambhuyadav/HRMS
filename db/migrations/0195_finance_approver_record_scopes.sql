-- 0195 C2 record scope of the Treasury Approver and the Expense Finance Approver (I-83 items 1 and 2; decided under owner
-- delegation, 6 Nov 2026; BR-044; C7; F2; FR-096).
--
-- BRD section 5 gives both roles "Assigned/Organisation" (lines 306 and 308); C2 (lines 4656 and 4658) gives "ASSIGNED plus
-- filters". 0098 kept the narrower C2 reading, so neither role could hold an organisation scope. A payment batch runs no
-- approval task and both roles' ordinary duties are operational counts and states, so in ASSIGNED scope their dashboards could
-- only ever be 0 (I-74 items 1 and 2). Like the Payroll Approver's combined entry, an assignment of either role may now hold
-- ASSIGNED or COMPANY scope (COMPANY with the usual department, location and employee filters). Nothing confidential moves:
-- both roles are OTHER access class, so no confidential field group can be granted to them in any scope (C1, C7).
--
-- No assignment changes here. The application holds the same matrix (access/baseline.ts C2_RECORD_SCOPES); the grant-guard
-- tests prove the two agree. To reverse: restore 0098's two entries; assignments already approved in COMPANY scope then stay
-- usable until revoked (the trigger checks inserts and changes, never rewrites rows), so revoke them first.
create or replace function hrms_role_record_scopes(p_role_code text) returns text[] language sql immutable as $$
  select case p_role_code
    when 'SYSTEM_ADMINISTRATOR'     then array['COMPANY']
    when 'HR_ADMINISTRATOR'         then array['COMPANY']
    when 'EMPLOYEE'                 then array['OWN']
    when 'REPORTING_MANAGER'        then array['TEAM', 'ASSIGNED']
    when 'PAYROLL_OPERATOR'         then array['COMPANY']
    when 'PAYROLL_APPROVER'         then array['ASSIGNED', 'COMPANY']
    when 'FINANCE_REVIEWER'         then array['COMPANY']
    when 'EXPENSE_FINANCE_APPROVER' then array['ASSIGNED', 'COMPANY']
    when 'TREASURY_OPERATOR'        then array['COMPANY']
    when 'TREASURY_APPROVER'        then array['ASSIGNED', 'COMPANY']
    when 'RECRUITER'                then array['COMPANY']
    when 'APPRAISAL_REVIEWER'       then array['ASSIGNED']
    when 'TRAINING_COORDINATOR'     then array['COMPANY']
    when 'AUDITOR'                  then array['COMPANY']
  end
$$;
