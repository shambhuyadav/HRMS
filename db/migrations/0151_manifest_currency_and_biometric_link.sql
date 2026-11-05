-- 0151 Two invariants held only by the service, found by writing the bad row directly (BRD line 81; db/tests/direct-write-invariants.test.ts).
--   * CI28 "Same run/template/currency". The manifest's lines were held to the manifest's currency, but the manifest's own currency
--     was held to nothing: bank.ts refuses a template of another currency (CURRENCY_MISMATCH) and copies the run's, and a direct write
--     could do neither, nor give a line a currency other than its record's.
--   * CI19 "link date covers event instant". An accepted event had to match its punch, but nothing tied the event's employee to the
--     provider identity it arrived under, at that instant. sync.ts looks the link up; this holds any other writer to the same rule.
-- A stored row that breaks a key must not stop an upgrade (the key stays NOT VALID, as in 0142 and 0150). The trigger reads only rows
-- written or changed from now on, so stored events are not re-judged.
alter table payroll_bank_template add constraint payroll_bank_template_company_id_id_currency_key unique (company_id, id, currency_code);
alter table payroll_run add constraint payroll_run_company_id_id_currency_key unique (company_id, id, currency_code);
alter table payroll_record add constraint payroll_record_company_id_id_currency_key unique (company_id, id, currency_code);

do $$
declare
  r record;
begin
  for r in
    select * from (values
      ('payroll_bank_batch', 'payroll_bank_batch_template_currency_fk', 'company_id, template_id, currency_code', 'payroll_bank_template'),
      ('payroll_bank_batch', 'payroll_bank_batch_run_currency_fk', 'company_id, run_id, currency_code', 'payroll_run'),
      ('payroll_bank_line', 'payroll_bank_line_record_currency_fk', 'company_id, payroll_record_id, currency_code', 'payroll_record')
    ) as t (child, name, child_columns, parent)
  loop
    execute format('alter table %I add constraint %I foreign key (%s) references %I (company_id, id, currency_code) on delete restrict not valid', r.child, r.name, r.child_columns, r.parent);
    begin
      execute format('alter table %I validate constraint %I', r.child, r.name);
    exception when foreign_key_violation then
      raise warning '% holds stored rows that break %; they are kept, and the key stays NOT VALID', r.child, r.name;
    end;
  end loop;
end $$;

create function hrms_biometric_event_link_covers() returns trigger language plpgsql as $$
begin
  if not exists (
    select 1 from biometric_employee_link l
     where l.company_id = new.company_id and l.profile_id = new.profile_id and l.employee_id = new.employee_id
       and l.external_employee_key = new.external_employee_key
       and l.effective_from <= new.normalised_time and (l.effective_to is null or l.effective_to > new.normalised_time)) then
    raise exception 'an accepted biometric event needs the employee''s link to its provider identity at that instant' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger biometric_event_link_covers
  before insert or update of state, employee_id, normalised_time, external_employee_key, profile_id on biometric_ingest_event
  for each row when (new.state = 'ACCEPTED')
  execute function hrms_biometric_event_link_covers();
