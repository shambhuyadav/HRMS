-- 0006 Shifts, breaks, shift assignments, holidays (DB019-DB022; FR-005; BR-008; DF05) and the DF04
-- activation record (explicit no-manager reason).
-- Overnight shifts are explicit: spans_midnight must agree with the clock times, so elapsed duration is
-- never negative. Breaks are offsets in minutes from shift start and must lie inside the shift.

create table shift (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name            text not null check (btrim(name) <> ''),
  in_time         time not null,
  out_time        time not null,
  spans_midnight  boolean not null,
  active          boolean not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id),
  check (in_time <> out_time),
  check (spans_midnight = (out_time < in_time))
);

-- Scheduled elapsed minutes from in_time to out_time, crossing midnight when flagged.
create function hrms_shift_minutes(p_in time, p_out time, p_spans boolean) returns integer
language sql immutable as $$
  select (extract(epoch from (p_out - p_in))::integer / 60) + case when p_spans then 1440 else 0 end
$$;

create table shift_break (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  shift_id              uuid not null,
  sequence              integer not null check (sequence > 0),
  start_offset_minutes  integer not null check (start_offset_minutes >= 0),
  end_offset_minutes    integer not null,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, shift_id, sequence),
  check (end_offset_minutes > start_offset_minutes),
  foreign key (company_id, shift_id) references shift (company_id, id) on delete restrict,
  exclude using gist (company_id with =, shift_id with =, int4range(start_offset_minutes, end_offset_minutes, '[)') with &&)
);

create function hrms_shift_break_inside() returns trigger language plpgsql as $$
declare
  duration integer;
begin
  select hrms_shift_minutes(in_time, out_time, spans_midnight) into duration
    from shift where company_id = new.company_id and id = new.shift_id;
  if new.end_offset_minutes > duration then
    raise exception 'break ends after the shift (% > % minutes)', new.end_offset_minutes, duration using errcode = '23514';
  end if;
  return new;
end $$;

create trigger shift_break_inside
  before insert or update on shift_break
  for each row execute function hrms_shift_break_inside();

-- Shift times cannot change under existing breaks so that they fall outside.
create function hrms_shift_times_keep_breaks() returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from shift_break b
     where b.company_id = new.company_id and b.shift_id = new.id
       and b.end_offset_minutes > hrms_shift_minutes(new.in_time, new.out_time, new.spans_midnight)
  ) then
    raise exception 'shift times would leave a break outside the shift' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger shift_times_keep_breaks
  before update of in_time, out_time, spans_midnight on shift
  for each row execute function hrms_shift_times_keep_breaks();

create table shift_assignment (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  employee_id     uuid not null,
  shift_id        uuid not null,
  effective_from  date not null,
  effective_to    date check (effective_to > effective_from),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, shift_id) references shift (company_id, id) on delete restrict,
  exclude using gist (company_id with =, employee_id with =, daterange(effective_from, effective_to, '[)') with &&)
);

create table holiday (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  location_id        uuid not null,
  holiday_date       date not null,
  holiday_type_category text not null default 'HOLIDAY_TYPE' check (holiday_type_category = 'HOLIDAY_TYPE'),
  holiday_type_id    uuid not null,
  name               text not null check (btrim(name) <> ''),
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, location_id, holiday_date, holiday_type_id),
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict,
  foreign key (company_id, holiday_type_category, holiday_type_id) references reference_value (company_id, category, id) on delete restrict
);

-- DF04: activation needs a current manager or an explicitly recorded top-level/no-manager reason.
alter table employee add column no_manager_reason text check (no_manager_reason is null or btrim(no_manager_reason) <> '');

insert into permission (resource, action, field_group) values
  ('shift',   'read',   'operational'),
  ('shift',   'create', 'operational'),
  ('shift',   'update', 'operational'),
  ('shift',   'assign', 'operational'),
  ('holiday', 'read',   'operational'),
  ('holiday', 'manage', 'operational'),
  ('employee', 'activate', 'operational');

do $$
declare
  t text;
begin
  foreach t in array array['shift', 'shift_break', 'shift_assignment', 'holiday'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
  foreach t in array array['shift', 'shift_assignment'] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;
