-- 0105 Company maintenance of reference values (FR-004 "configurable entities"; DF04 "controlled active reference codes
-- with effective periods ... No free-text value silently creates a master"; DB006; BR-004).
--
-- reference_value.read    see the lists of the company.
-- reference_value.manage  add a value, relabel it, deactivate or end-date it. Which categories a company may change, and
--                         which codes of those the code itself uses, is in reference/maintenance.ts (default: protected).
--
-- A value is never deleted and keeps its category and code, so every record that points at it keeps its meaning.
-- valid_from (inclusive) and valid_to (exclusive): NULL means no limit on that side. The lists the code depends on by name
-- cannot be switched off or end-dated here either, whichever path writes.
--
-- reference_value_in_force is what forms read and validate against: active and in force on the company's business date.
-- A form tied to another date (a holiday's own date) applies the period itself.

insert into permission (resource, action, field_group) values
  ('reference_value', 'read', 'operational'),
  ('reference_value', 'manage', 'operational');

alter table reference_value
  add column valid_from date,
  add column valid_to date,
  add constraint reference_value_valid_period_check check (valid_to > valid_from);

create view reference_value_in_force as
  select r.*
    from reference_value r
   where r.active
     and (r.valid_from is null or r.valid_from <= hrms_business_date(r.company_id, now()))
     and (r.valid_to is null or r.valid_to > hrms_business_date(r.company_id, now()));

create function hrms_reference_value_guard() returns trigger language plpgsql as $$
begin
  if (new.category, new.code) is distinct from (old.category, old.code) then
    raise exception 'a reference value keeps its category and code' using errcode = '23514';
  end if;
  if new.category in ('EMPLOYEE_STATUS', 'EMPLOYMENT_TYPE', 'ATTENDANCE_STATUS')
     and ((old.active and not new.active) or new.valid_from is not null or new.valid_to is not null) then
    raise exception 'a value of % cannot be deactivated or end-dated', new.category using errcode = '23514';
  end if;
  return new;
end $$;

create trigger reference_value_guard before update on reference_value
  for each row execute function hrms_reference_value_guard();
create trigger reference_value_no_delete before delete on reference_value
  for each row execute function hrms_no_delete();
create trigger reference_value_no_truncate before truncate on reference_value
  for each statement execute function hrms_no_truncate();
