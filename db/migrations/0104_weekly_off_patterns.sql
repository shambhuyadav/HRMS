-- 0104 Weekly-off patterns (FR-005 "Maintain location-specific holidays and weekly-off patterns"; FR-020; FR-024; FR-028;
-- FR-032; DF05 "Monday-Friday workdays", "Shift and holiday calendars are editable and effective-dated"; DF08).
--
-- A location calendar holds dated whole-day patterns. The one in force on a day has the latest effective date on or before
-- it, and among equal dates the highest number, so a mistaken entry is corrected by a later one on the same date and nothing
-- is rewritten. With no entry in force on a day, the DF05 default applies: Saturday and Sunday off. A half weekly-off (E05)
-- cannot be expressed: its meaning is an open owner question (I-48 item 6).
--
-- off_days holds ISO weekdays (1 Monday .. 7 Sunday), ascending and without repeats. Empty means every day is a working day;
-- all seven would leave no working day at all, so they are refused.

create function hrms_weekly_off_days_valid(p smallint[]) returns boolean language sql immutable as $$
  select cardinality(p) < 7
     and p = coalesce((select array_agg(distinct d order by d) from unnest(p) as d where d between 1 and 7), '{}'::smallint[])
$$;

create table weekly_off_pattern (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  location_id     uuid not null,
  revision        integer not null check (revision > 0),
  effective_from  date not null,
  off_days        smallint[] not null check (hrms_weekly_off_days_valid(off_days)),
  reason          text not null check (btrim(reason) <> ''),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, location_id, revision),
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict
);
create index weekly_off_pattern_in_force on weekly_off_pattern (company_id, location_id, effective_from desc, revision desc);
create trigger weekly_off_pattern_append_only before update or delete on weekly_off_pattern for each row execute function hrms_append_only();

-- FR-033: the calendar a payroll calculation counts days on, fixed when it starts like its other rules. Holidays and
-- patterns are never rewritten and carry the instant they became known or were closed (taken under the calendar lock), so
-- the calendar as known at that instant can be read back for every chunk of the calculation. Null on a calculation started
-- before this column: it reads the current calendar, as it did.
alter table payroll_run add column calendar_as_of timestamptz;
