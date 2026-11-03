-- 0121 The employment assignment a payroll run used (FR-057 "Auditors can trace who changed an employee grade and which
-- payroll run used it"; BR-007; BR-026).
-- A run selects its members by the assignment in force at the service end or the last working date (runs.ts scopeCte),
-- and neither the member nor the record said which assignment that was, so a later grade change hid the answer. Each now
-- records it: the member when the scope is confirmed, the record when it is calculated (a later revision of a run may
-- see a newer assignment than its members were selected with). The composite key keeps the assignment the employee's
-- own. Rows written before this migration stay null: nothing recorded it, and rebuilding it now would be a guess.
alter table employment_assignment add constraint employment_assignment_company_id_employee_key unique (company_id, id, employee_id);

alter table payroll_run_member add column employment_assignment_id uuid;
alter table payroll_run_member add constraint payroll_run_member_assignment_fk
  foreign key (company_id, employment_assignment_id, employee_id) references employment_assignment (company_id, id, employee_id) on delete restrict;

alter table payroll_record add column employment_assignment_id uuid;
alter table payroll_record add constraint payroll_record_assignment_fk
  foreign key (company_id, employment_assignment_id, employee_id) references employment_assignment (company_id, id, employee_id) on delete restrict;

create index payroll_run_member_assignment_idx on payroll_run_member (company_id, employment_assignment_id) where (employment_assignment_id is not null);
create index payroll_record_assignment_idx on payroll_record (company_id, employment_assignment_id) where (employment_assignment_id is not null);

-- What a run used is history: written once, with the row, and never changed.
create function hrms_payroll_used_assignment_immutable() returns trigger language plpgsql as $$
begin
  if new.employment_assignment_id is distinct from old.employment_assignment_id then
    raise exception 'the employment assignment a payroll run used is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_run_member_used_assignment before update on payroll_run_member for each row execute function hrms_payroll_used_assignment_immutable();
create trigger payroll_record_used_assignment before update on payroll_record for each row execute function hrms_payroll_used_assignment_immutable();
