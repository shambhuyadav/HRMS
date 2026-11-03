-- 0102 Effective periods of organisation masters (FR-004 "effective dates", acceptance "cannot be assigned to a new joiner
-- outside its valid period"; BR-004; DF04 "controlled active reference codes with effective periods").
--
-- valid_from (inclusive) and valid_to (exclusive) on department, location, designation and grade, NULL meaning no limit on
-- that side, so an existing master keeps exactly its current behaviour and no start date is invented for it. A master is
-- usable on a date when it is active and the date is inside its period; `active` is the immediate switch and the period
-- answers for back-dated and future-dated work, so a joining before a master closed is still accepted.
--
-- The trigger makes the start of any employment assignment fall inside the period of each master it names, whatever path
-- writes it. It share-locks the master, so org/routes.ts, which changes a period or deactivates under a row lock after
-- checking what is assigned, is ordered strictly before or after the assignment. Ending an assignment is not a new use and
-- is not checked. The direct `active` flag stays with the service, as before.

alter table department
  add column valid_from date,
  add column valid_to date,
  add constraint department_valid_period_check check (valid_to > valid_from);
alter table location
  add column valid_from date,
  add column valid_to date,
  add constraint location_valid_period_check check (valid_to > valid_from);
alter table designation
  add column valid_from date,
  add column valid_to date,
  add constraint designation_valid_period_check check (valid_to > valid_from);
alter table grade
  add column valid_from date,
  add column valid_to date,
  add constraint grade_valid_period_check check (valid_to > valid_from);

-- A BEFORE trigger runs ahead of the foreign keys. A master that does not exist in this company (a missing id, or another
-- company's) is not a period question, so it passes through here and the composite foreign key refuses it (23503).
create function hrms_employment_assignment_master_period() returns trigger language plpgsql as $$
declare
  m record;
begin
  select valid_from, valid_to into m from department where company_id = new.company_id and id = new.department_id for share;
  if found and ((m.valid_from is not null and m.valid_from > new.effective_from) or (m.valid_to is not null and m.valid_to <= new.effective_from)) then
    raise exception 'the department is outside its valid period on %', new.effective_from using errcode = '23514';
  end if;
  select valid_from, valid_to into m from location where company_id = new.company_id and id = new.location_id for share;
  if found and ((m.valid_from is not null and m.valid_from > new.effective_from) or (m.valid_to is not null and m.valid_to <= new.effective_from)) then
    raise exception 'the location is outside its valid period on %', new.effective_from using errcode = '23514';
  end if;
  select valid_from, valid_to into m from designation where company_id = new.company_id and id = new.designation_id for share;
  if found and ((m.valid_from is not null and m.valid_from > new.effective_from) or (m.valid_to is not null and m.valid_to <= new.effective_from)) then
    raise exception 'the designation is outside its valid period on %', new.effective_from using errcode = '23514';
  end if;
  if new.grade_id is not null then
    select valid_from, valid_to into m from grade where company_id = new.company_id and id = new.grade_id for share;
    if found and ((m.valid_from is not null and m.valid_from > new.effective_from) or (m.valid_to is not null and m.valid_to <= new.effective_from)) then
      raise exception 'the grade is outside its valid period on %', new.effective_from using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger employment_assignment_master_period
  before insert or update of department_id, location_id, designation_id, grade_id, effective_from on employment_assignment
  for each row execute function hrms_employment_assignment_master_period();
