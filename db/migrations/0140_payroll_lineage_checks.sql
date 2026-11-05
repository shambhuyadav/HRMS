-- 0140 Payroll run lineage and head revision binding (CI07; DB036; DB038; BRD line 4542 "payroll_run supersedes link uses
-- same company/period and no cycle"). The service already copies these values; this makes direct writes obey them too.

-- 1. A later revision supersedes the revision immediately before it, in its own lineage, period and calendar. Revisions only
--    ever count up from the superseded row, so no cycle can form, and by induction every lineage_id names the revision 1 run
--    of the same period (the existing checks tie revision 1 to lineage_id = id). Identity never changes after insert
--    (hrms_payroll_run_guard), so insert is the only write to check. Rows already stored are not touched.
create function hrms_payroll_run_lineage_guard() returns trigger language plpgsql as $$
declare
  superseded payroll_run%rowtype;
begin
  if new.supersedes_run_id is null then
    return new;
  end if;
  select * into superseded from payroll_run where company_id = new.company_id and id = new.supersedes_run_id;
  if not found
     or (superseded.lineage_id, superseded.period_id, superseded.calendar_id, superseded.revision + 1)
        is distinct from (new.lineage_id, new.period_id, new.calendar_id, new.revision) then
    raise exception 'a payroll run revision supersedes the previous revision of its own lineage, period and calendar' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_run_lineage_guard before insert on payroll_run for each row execute function hrms_payroll_run_lineage_guard();

-- 2. A calculation snapshot names a head revision of its own component, with that revision's type (as payroll_run_head already
--    does for the component). A revision's component and type never change (hrms_payroll_head_guard). Every new row is held to
--    this. A stored row that disagrees must not stop an upgrade and cannot be corrected (snapshots are append-only), so a table
--    holding one keeps its constraint NOT VALID and says so; that table's constraint still applies to all new rows.
alter table payroll_head_revision add constraint payroll_head_revision_component_type_key unique (company_id, id, component_id, head_type);

alter table payroll_record_component add constraint payroll_record_component_head_binding
  foreign key (company_id, head_revision_id, component_id, head_type)
  references payroll_head_revision (company_id, id, component_id, head_type) on delete restrict not valid;
alter table payroll_record_input add constraint payroll_record_input_head_binding
  foreign key (company_id, head_revision_id, component_id, head_type)
  references payroll_head_revision (company_id, id, component_id, head_type) on delete restrict not valid;
alter table payroll_line add constraint payroll_line_head_binding
  foreign key (company_id, head_revision_id, component_id, head_type)
  references payroll_head_revision (company_id, id, component_id, head_type) on delete restrict not valid;

do $$
declare
  t text;
begin
  foreach t in array array['payroll_record_component', 'payroll_record_input', 'payroll_line'] loop
    begin
      execute format('alter table %I validate constraint %I', t, t || '_head_binding');
    exception when foreign_key_violation then
      raise warning '% holds stored rows whose head revision disagrees with their component or type; they are kept, and % stays NOT VALID', t, t || '_head_binding';
    end;
  end loop;
end $$;
