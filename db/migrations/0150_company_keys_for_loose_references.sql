-- 0150 References not held to the row's own company or period (BRD line 2800 "A cross-company FK must not be silently accepted"; ZT06;
-- B1; CI30). The catalogue test db/tests/fk-catalogue.test.ts pointed at them, and writing each bad row directly against the schema
-- before this migration, every guard in force, showed which could really be written.
-- Defects, each write accepted before this migration:
--   * leave_request_revision.policy_id had no key at all, so a revision could name another company's policy, or one that does not exist.
--   * attendance_record.shift_revision_id sits in a composite key with shift_id. Under MATCH SIMPLE a NULL shift_id switches that key
--     off, so with no shift the revision could name anything, on insert and on update.
--   * employee_issued_output.period_id was bound to nothing (CI30 "Issued owner/company/period/hash binding"): a payslip could name
--     one period and be drawn from another's run.
-- Not a defect, kept as hardening: employee_issued_output.run_id also sits in a composite key with a nullable column, but a NULL record
-- with a run was never reachable. A FORM16 is refused outright, a payslip needs both columns and a processed run, and an issued output
-- never changes. All three attempts were refused. The key below exists for the period; that it also covers run_id costs nothing.
-- A stored row that breaks one of these must not stop an upgrade, and what it should have named is not for a migration to guess:
-- the row is kept, that one key stays NOT VALID (it still applies to every new or changed row) and the migration says so.
alter table payroll_run add constraint payroll_run_company_id_id_period_key unique (company_id, id, period_id);

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('leave_request_revision', 'leave_request_revision_policy_company_fk', 'company_id, policy_id', 'leave_policy', 'company_id, id'),
      ('attendance_record', 'attendance_record_shift_revision_company_fk', 'company_id, shift_revision_id', 'shift_revision', 'company_id, id'),
      ('employee_issued_output', 'employee_issued_output_run_period_fk', 'company_id, run_id, period_id', 'payroll_run', 'company_id, id, period_id')
    ) as t (child, name, child_columns, parent, parent_columns)
  loop
    execute format('alter table %I add constraint %I foreign key (%s) references %I (%s) on delete restrict not valid', r.child, r.name, r.child_columns, r.parent, r.parent_columns);
    begin
      execute format('alter table %I validate constraint %I', r.child, r.name);
    exception when foreign_key_violation then
      raise warning '% holds stored rows that break %; they are kept, and the key stays NOT VALID', r.child, r.name;
    end;
  end loop;
end $$;
