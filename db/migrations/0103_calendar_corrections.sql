-- 0103 Holiday corrections and shift revisions (FR-005 "maintain shift in/out and break times"; DF05 "Shift and holiday
-- calendars are editable and effective-dated"; DF08 "Effective historical values are not overwritten. Corrections append
-- attributable superseding entries").
--
-- Holidays. A holiday row is never edited or deleted. A correction closes it as SUPERSEDED and appends the corrected entry
-- that names it; a withdrawal closes it as WITHDRAWN; both record who, when and why. Only ACTIVE rows are the calendar, and
-- one ACTIVE row at most holds a location, date and type, so a withdrawn date can be declared again.
--
-- Shifts. The shift row and its shift_break rows are the first revision, in force from the start; they no longer change.
-- A change of in, out or break times appends a revision from a date. The one in force on a day has the latest effective
-- date on or before it, and among equal dates the highest number, so a mistaken revision is corrected by a later one on the
-- same date and nothing is rewritten.
--
-- Already-evaluated days. attendance_record pins the revision its result was evaluated on (null: the shift row), so a new
-- revision or a back-dated one changes nothing until HR reprocesses the day. The earlier pin of a reprocessed day can be
-- read back from the revision times (shift_revision is append-only and dated) and 0111's history keeps the replaced values.
--
-- Migration order: on a new database this file runs before 0111, whose function the guard below names; a PL/pgSQL body is
-- resolved when it first runs, and no attendance result can exist until the migrations have finished.

-- ---------------------------------------------------------------------------
-- Holidays
-- ---------------------------------------------------------------------------
alter table holiday
  add column state         text not null default 'ACTIVE' check (state in ('ACTIVE', 'SUPERSEDED', 'WITHDRAWN')),
  add column supersedes_id uuid,
  add column closed_at     timestamptz,
  add column closed_by     uuid references user_account (id) on delete restrict,
  add column closed_reason text check (closed_reason is null or btrim(closed_reason) <> ''),
  add constraint holiday_closed_attributed check (
    (state = 'ACTIVE') = (closed_at is null) and (state = 'ACTIVE') = (closed_by is null) and (state = 'ACTIVE') = (closed_reason is null)
  ),
  add constraint holiday_supersedes_fkey foreign key (company_id, supersedes_id) references holiday (company_id, id) on delete restrict;

alter table holiday drop constraint holiday_company_id_location_id_holiday_date_holiday_type_id_key;
create unique index holiday_one_active on holiday (company_id, location_id, holiday_date, holiday_type_id) where state = 'ACTIVE';
create unique index holiday_one_successor on holiday (company_id, supersedes_id) where supersedes_id is not null;
create index holiday_location_date on holiday (company_id, location_id, holiday_date);

create function hrms_holiday_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'a holiday is withdrawn, never deleted' using errcode = '23514';
  end if;
  if (new.company_id, new.location_id, new.holiday_date, new.holiday_type_id, new.name, new.supersedes_id, new.created_at, new.created_by)
     is distinct from
     (old.company_id, old.location_id, old.holiday_date, old.holiday_type_id, old.name, old.supersedes_id, old.created_at, old.created_by) then
    raise exception 'a holiday is corrected by a superseding entry' using errcode = '23514';
  end if;
  if old.state <> 'ACTIVE' and (new.state, new.closed_at, new.closed_by, new.closed_reason) is distinct from (old.state, old.closed_at, old.closed_by, old.closed_reason) then
    raise exception 'a closed holiday stays as it was' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger holiday_guard before update or delete on holiday for each row execute function hrms_holiday_guard();

-- ---------------------------------------------------------------------------
-- Shift revisions
-- ---------------------------------------------------------------------------
create table shift_revision (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  shift_id        uuid not null,
  -- The shift row itself is revision 1.
  revision        integer not null check (revision > 1),
  effective_from  date not null,
  in_time         time not null,
  out_time        time not null,
  spans_midnight  boolean not null,
  reason          text not null check (btrim(reason) <> ''),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, shift_id, id),
  unique (company_id, shift_id, revision),
  foreign key (company_id, shift_id) references shift (company_id, id) on delete restrict,
  check (in_time <> out_time),
  check (spans_midnight = (out_time < in_time))
);
create index shift_revision_in_force on shift_revision (company_id, shift_id, effective_from desc, revision desc);
create trigger shift_revision_append_only before update or delete on shift_revision for each row execute function hrms_append_only();

create table shift_revision_break (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  shift_revision_id     uuid not null,
  sequence              integer not null check (sequence > 0),
  start_offset_minutes  integer not null check (start_offset_minutes >= 0),
  end_offset_minutes    integer not null,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, shift_revision_id, sequence),
  check (end_offset_minutes > start_offset_minutes),
  foreign key (company_id, shift_revision_id) references shift_revision (company_id, id) on delete restrict,
  exclude using gist (company_id with =, shift_revision_id with =, int4range(start_offset_minutes, end_offset_minutes, '[)') with &&)
);
create trigger shift_revision_break_append_only before update or delete on shift_revision_break for each row execute function hrms_append_only();

create function hrms_shift_revision_break_inside() returns trigger language plpgsql as $$
declare
  duration integer;
begin
  select hrms_shift_minutes(in_time, out_time, spans_midnight) into duration
    from shift_revision where company_id = new.company_id and id = new.shift_revision_id;
  if new.end_offset_minutes > duration then
    raise exception 'break ends after the shift (% > % minutes)', new.end_offset_minutes, duration using errcode = '23514';
  end if;
  return new;
end $$;
create trigger shift_revision_break_inside before insert on shift_revision_break for each row execute function hrms_shift_revision_break_inside();

-- Revision 1 no longer changes either: a day evaluated on it keeps its basis.
create function hrms_shift_times_frozen() returns trigger language plpgsql as $$
begin
  raise exception 'shift times change by a dated revision' using errcode = '23514';
end $$;
create trigger shift_times_frozen before update of in_time, out_time, spans_midnight on shift
  for each row when ((new.in_time, new.out_time, new.spans_midnight) is distinct from (old.in_time, old.out_time, old.spans_midnight))
  execute function hrms_shift_times_frozen();
create trigger shift_break_frozen before update or delete on shift_break for each row execute function hrms_shift_times_frozen();

-- The times of a shift in force on a day.
create function hrms_shift_in_force(p_company uuid, p_shift uuid, p_day date)
returns table (revision_id uuid, revision integer, effective_from date, in_time time, out_time time, spans_midnight boolean, minutes integer, break_minutes integer)
language sql stable as $$
  select r.id, coalesce(r.revision, 1), r.effective_from,
         coalesce(r.in_time, s.in_time), coalesce(r.out_time, s.out_time), coalesce(r.spans_midnight, s.spans_midnight),
         hrms_shift_minutes(coalesce(r.in_time, s.in_time), coalesce(r.out_time, s.out_time), coalesce(r.spans_midnight, s.spans_midnight)),
         coalesce(
           case when r.id is null
                then (select sum(b.end_offset_minutes - b.start_offset_minutes) from shift_break b where b.company_id = s.company_id and b.shift_id = s.id)
                else (select sum(b.end_offset_minutes - b.start_offset_minutes) from shift_revision_break b where b.company_id = r.company_id and b.shift_revision_id = r.id)
           end, 0)::integer
    from shift s
    left join lateral (
      select x.* from shift_revision x
       where x.company_id = s.company_id and x.shift_id = s.id and x.effective_from <= p_day
       order by x.effective_from desc, x.revision desc limit 1
    ) r on true
   where s.company_id = p_company and s.id = p_shift
$$;

-- The breaks of one revision (null: the shift row).
create function hrms_shift_breaks(p_company uuid, p_shift uuid, p_revision uuid)
returns table (start_offset_minutes integer, end_offset_minutes integer)
language sql stable as $$
  select b.start_offset_minutes, b.end_offset_minutes from shift_break b
   where p_revision is null and b.company_id = p_company and b.shift_id = p_shift
  union all
  select b.start_offset_minutes, b.end_offset_minutes from shift_revision_break b
   where p_revision is not null and b.company_id = p_company and b.shift_revision_id = p_revision
  order by 1
$$;

-- ---------------------------------------------------------------------------
-- The basis of an evaluated day
-- ---------------------------------------------------------------------------
alter table attendance_record
  add column shift_revision_id uuid,
  add constraint attendance_record_shift_revision_fkey foreign key (company_id, shift_id, shift_revision_id)
    references shift_revision (company_id, shift_id, id) on delete restrict;

create function hrms_attendance_basis_guard() returns trigger language plpgsql as $$
begin
  if hrms_attendance_day_frozen(old.company_id, old.employee_id, old.work_date) then
    raise exception 'attendance of % is used by a processed payroll', old.work_date using errcode = '23514';
  end if;
  return new;
end $$;
create trigger attendance_record_basis_guard before update of shift_revision_id on attendance_record
  for each row when (new.shift_revision_id is distinct from old.shift_revision_id)
  execute function hrms_attendance_basis_guard();
