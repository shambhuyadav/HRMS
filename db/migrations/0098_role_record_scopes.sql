-- 0098 C2 per-role record scope (BRD Appendix C2 "Role and record scope"; BR-044; C7): which scope kinds an assignment of
-- each baseline role may hold, so an organisation-wide Reporting Manager or a company-scope Employee cannot exist.
--
-- An assignment has one scope kind, so C2's combined entries allow either kind: Reporting Manager "TEAM and ASSIGNED",
-- Payroll Approver "ASSIGNED and COMPANY filters". "Plus filters" narrows and is not restricted here. C2 is silent on any
-- other role (a custom role), which stays unrestricted. The application holds the same matrix (access/baseline.ts
-- C2_RECORD_SCOPES); db/tests/grant-guards.test.ts proves the two agree.
--
-- The check has no bootstrap exception. Rows written before this migration are not changed (real records are never
-- rewritten without authorisation): a row outside the matrix can still be revoked, but can no longer be approved or
-- moved to another out-of-matrix scope.
create function hrms_role_record_scopes(p_role_code text) returns text[] language sql immutable as $$
  select case p_role_code
    when 'SYSTEM_ADMINISTRATOR'     then array['COMPANY']
    when 'HR_ADMINISTRATOR'         then array['COMPANY']
    when 'EMPLOYEE'                 then array['OWN']
    when 'REPORTING_MANAGER'        then array['TEAM', 'ASSIGNED']
    when 'PAYROLL_OPERATOR'         then array['COMPANY']
    when 'PAYROLL_APPROVER'         then array['ASSIGNED', 'COMPANY']
    when 'FINANCE_REVIEWER'         then array['COMPANY']
    when 'EXPENSE_FINANCE_APPROVER' then array['ASSIGNED']
    when 'TREASURY_OPERATOR'        then array['COMPANY']
    when 'TREASURY_APPROVER'        then array['ASSIGNED']
    when 'RECRUITER'                then array['COMPANY']
    when 'APPRAISAL_REVIEWER'       then array['ASSIGNED']
    when 'TRAINING_COORDINATOR'     then array['COMPANY']
    when 'AUDITOR'                  then array['COMPANY']
  end
$$;

create function hrms_role_assignment_record_scope() returns trigger language plpgsql as $$
declare
  role_code text;
  allowed text[];
begin
  if new.state = 'REVOKED' then
    return new;
  end if;
  select r.code into role_code from role r where r.company_id = new.company_id and r.id = new.role_id;
  allowed := hrms_role_record_scopes(role_code);
  if allowed is not null and not new.scope_kind = any(allowed) then
    raise exception 'role % cannot hold % scope', role_code, new.scope_kind using errcode = '23514';
  end if;
  return new;
end $$;

create trigger role_assignment_record_scope before insert or update of role_id, scope_kind, state on role_assignment
  for each row execute function hrms_role_assignment_record_scope();
