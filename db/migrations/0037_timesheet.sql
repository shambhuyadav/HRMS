-- 0037 Timesheets (FR-045 to FR-048; DB066-DB071; F1 "Timesheets"; OQ-11; DF02; DF03; DF08; DF09; BR-048; BR-049;
-- H2 late-timesheet journey; H3 TN13; CI12; CI14; CI26).
--
-- Masters: a project has many jobs and a job belongs to exactly one project (fixed at creation); a reusable
-- activity catalogue is linked to jobs through approved job activities. Every master has a code, a name, an owner,
-- an inclusive validity period and an active flag. Nothing is deleted (DF08): a master is deactivated or its period
-- ended, and historical entries keep the classification they were recorded with.
-- Allocation (DB069): an employee on a job for an inclusive date interval and a percentage of the capacity their
-- shift and calendar give. A total above 100% on any day needs an exception recorded by the employee's direct
-- manager with a reason (F1); the same employee, job and overlapping interval is a duplicate.
-- Timesheet (DB070): one per employee and Monday-Sunday week, a typed transaction root reviewed by the direct
-- manager (DF03). Every submission is an immutable numbered revision and the lines (DB071) belong to a revision, so
-- a return, a rejection or an authorised reopen continues in a new revision while each approved revision stays
-- identifiable for later payroll adjustments (H2; BR-048; CI26 "source revision unique").
-- Reopening an approved timesheet is its own transaction (timesheet_reopen), decided by an independent HR reviewer.
-- A missed submission raises one pending exception and one reminder (BR-049); it never changes pay.

-- ---------------------------------------------------------------------------------------------------------------
-- DB066 project, DB067 job, DB068 activity and the approved job activities
-- ---------------------------------------------------------------------------------------------------------------
create table timesheet_project (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  code               text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name               text not null check (btrim(name) <> '' and length(name) <= 200),
  owner_employee_id  uuid not null,
  -- Inclusive validity period; an open end date means the project has no planned end.
  start_date         date not null,
  end_date           date,
  active             boolean not null,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code),
  foreign key (company_id, owner_employee_id) references employee (company_id, id) on delete restrict,
  check (end_date is null or end_date >= start_date)
);

create table timesheet_job (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  project_id         uuid not null,
  code               text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name               text not null check (btrim(name) <> '' and length(name) <= 200),
  owner_employee_id  uuid not null,
  start_date         date not null,
  end_date           date,
  active             boolean not null,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, project_id),
  unique (company_id, project_id, code),
  foreign key (company_id, project_id) references timesheet_project (company_id, id) on delete restrict,
  foreign key (company_id, owner_employee_id) references employee (company_id, id) on delete restrict,
  check (end_date is null or end_date >= start_date)
);

create table timesheet_activity (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  code               text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name               text not null check (btrim(name) <> '' and length(name) <= 200),
  owner_employee_id  uuid not null,
  -- F1 utilisation counts approved productive hours: each activity says whether its time is productive. There is
  -- no default; the company classifies every activity it creates.
  productive         boolean not null,
  start_date         date not null,
  end_date           date,
  active             boolean not null,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code),
  foreign key (company_id, owner_employee_id) references employee (company_id, id) on delete restrict,
  check (end_date is null or end_date >= start_date)
);

-- F1: the activities a job permits. A link is deactivated, never deleted.
create table timesheet_job_activity (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company (id) on delete restrict,
  job_id       uuid not null,
  activity_id  uuid not null,
  active       boolean not null,
  created_at   timestamptz not null default now(),
  created_by   uuid references user_account (id) on delete restrict,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references user_account (id) on delete restrict,
  version      integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, job_id, activity_id),
  foreign key (company_id, job_id) references timesheet_job (company_id, id) on delete restrict,
  foreign key (company_id, activity_id) references timesheet_activity (company_id, id) on delete restrict
);

create function hrms_timesheet_master_guard() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'timesheet_job_activity' then
    if (new.job_id, new.activity_id) is distinct from (old.job_id, old.activity_id) then
      raise exception 'a job activity link is fixed; deactivate it and link again' using errcode = '23514';
    end if;
    return new;
  end if;
  if (to_jsonb(new) ->> 'code') is distinct from (to_jsonb(old) ->> 'code') then
    raise exception '% codes are immutable', tg_table_name using errcode = '23514';
  end if;
  if (to_jsonb(new) ->> 'project_id') is distinct from (to_jsonb(old) ->> 'project_id') then
    raise exception 'a job belongs to exactly one project' using errcode = '23514';
  end if;
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['timesheet_project', 'timesheet_job', 'timesheet_activity', 'timesheet_job_activity'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_timesheet_master_guard()', t || '_guard', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- DB069 resource_allocation
-- ---------------------------------------------------------------------------------------------------------------
create table resource_allocation (
  id                                   uuid primary key default gen_random_uuid(),
  company_id                           uuid not null references company (id) on delete restrict,
  employee_id                          uuid not null,
  project_id                           uuid not null,
  job_id                               uuid not null,
  -- Inclusive interval (DB069: end not before start).
  start_date                           date not null,
  end_date                             date not null,
  allocation_percent                   numeric(5,2) not null check (allocation_percent > 0 and allocation_percent <= 100),
  state                                text not null check (state in ('ACTIVE', 'CANCELLED')),
  source                               text not null check (source in ('MANUAL', 'IMPORT')),
  -- F1: an exception the employee's direct manager recorded, with a reason, for a total above 100%.
  over_allocation_reason               text check (over_allocation_reason is null or (btrim(over_allocation_reason) <> '' and length(over_allocation_reason) <= 1000)),
  over_allocation_peak_percent         numeric(7,2) check (over_allocation_peak_percent is null or over_allocation_peak_percent > 100),
  over_allocation_manager_employee_id  uuid,
  over_allocation_recorded_by          uuid references user_account (id) on delete restrict,
  over_allocation_recorded_at          timestamptz,
  cancel_reason                        text check (cancel_reason is null or (btrim(cancel_reason) <> '' and length(cancel_reason) <= 1000)),
  cancelled_at                         timestamptz,
  cancelled_by                         uuid references user_account (id) on delete restrict,
  created_at                           timestamptz not null default now(),
  created_by                           uuid references user_account (id) on delete restrict,
  updated_at                           timestamptz not null default now(),
  updated_by                           uuid references user_account (id) on delete restrict,
  version                              integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, job_id, project_id) references timesheet_job (company_id, id, project_id) on delete restrict,
  foreign key (company_id, over_allocation_manager_employee_id) references employee (company_id, id) on delete restrict,
  check (end_date >= start_date),
  check (num_nonnulls(over_allocation_reason, over_allocation_peak_percent, over_allocation_manager_employee_id, over_allocation_recorded_by, over_allocation_recorded_at) in (0, 5)),
  check (over_allocation_manager_employee_id is distinct from employee_id),
  check ((state = 'CANCELLED') = (cancelled_at is not null)),
  check (num_nonnulls(cancel_reason, cancelled_at, cancelled_by) in (0, 3)),
  -- DB069: the same employee, job and (overlapping) interval twice is a duplicate.
  exclude using gist (company_id with =, employee_id with =, job_id with =, daterange(start_date, end_date, '[]') with &&) where (state = 'ACTIVE')
);
create index resource_allocation_employee_idx on resource_allocation (company_id, employee_id, start_date);
create index resource_allocation_job_idx on resource_allocation (company_id, job_id);

create function hrms_resource_allocation_guard() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.project_id, new.job_id, new.start_date, new.source) is distinct from
     (old.employee_id, old.project_id, old.job_id, old.start_date, old.source) then
    raise exception 'an allocation''s employee, job and start date are fixed; cancel it and allocate again' using errcode = '23514';
  end if;
  if old.state = 'CANCELLED' then
    raise exception 'a cancelled allocation is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger resource_allocation_guard before update on resource_allocation for each row execute function hrms_resource_allocation_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB070 timesheet (typed root of kind 'timesheet') and its revisions
-- ---------------------------------------------------------------------------------------------------------------
create table timesheet (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company (id) on delete restrict,
  employee_id         uuid not null,
  -- F1: a Monday-Sunday week, submitted by the following Monday (the due date, inclusive).
  period_start        date not null check (extract(isodow from period_start) = 1),
  period_end          date not null,
  due_date            date not null,
  transaction_kind    text not null default 'timesheet' check (transaction_kind = 'timesheet'),
  transaction_id      uuid not null,
  state               text not null check (state in ('DRAFT', 'SUBMITTED', 'RETURNED', 'REJECTED', 'APPROVED')),
  -- The revision being worked on or decided, and the approved revision in force (if any).
  current_revision    integer not null default 1 check (current_revision > 0),
  approved_revision   integer check (approved_revision > 0),
  -- The first submission of the period and whether it came after the due date (accepted, flagged, no penalty).
  first_submitted_at  timestamptz,
  first_submitted_on  date,
  late                boolean,
  created_at          timestamptz not null default now(),
  created_by          uuid references user_account (id) on delete restrict,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references user_account (id) on delete restrict,
  version             integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, id, period_start),
  -- DB070: unique employee/period.
  unique (company_id, employee_id, period_start),
  unique (company_id, transaction_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check (period_end = period_start + 6),
  check (due_date = period_start + 7),
  check (approved_revision is null or approved_revision <= current_revision),
  check (state <> 'APPROVED' or approved_revision = current_revision),
  check ((first_submitted_at is null) = (first_submitted_on is null) and (first_submitted_at is null) = (late is null)),
  check (state = 'DRAFT' or first_submitted_at is not null)
);
create index timesheet_period_idx on timesheet (company_id, period_start, state);

create function hrms_timesheet_guard() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.period_start, new.period_end, new.due_date, new.transaction_id) is distinct from
     (old.employee_id, old.period_start, old.period_end, old.due_date, old.transaction_id) then
    raise exception 'a timesheet''s employee and period are fixed' using errcode = '23514';
  end if;
  if new.current_revision < old.current_revision then
    raise exception 'timesheet revisions never go back' using errcode = '23514';
  end if;
  if old.first_submitted_at is not null and (new.first_submitted_at, new.first_submitted_on, new.late) is distinct from (old.first_submitted_at, old.first_submitted_on, old.late) then
    raise exception 'the first submission of a timesheet is recorded once' using errcode = '23514';
  end if;
  if old.approved_revision is not null and (new.approved_revision is null or new.approved_revision < old.approved_revision) then
    raise exception 'an approved timesheet revision stays on record' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger timesheet_guard before update on timesheet for each row execute function hrms_timesheet_guard();

-- One row per revision: DRAFT -> SUBMITTED -> APPROVED | RETURNED | REJECTED. A submitted revision and its lines are
-- immutable; a decision is recorded once. An approved revision later replaced by an approved correction keeps its
-- state and records which revision superseded it, so the original and the correction stay identifiable.
create table timesheet_revision (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  timesheet_id            uuid not null,
  employee_id             uuid not null,
  revision                integer not null check (revision > 0),
  -- Why the revision exists: the first one, or the continuation of a returned, rejected or reopened revision.
  origin                  text not null check (origin in ('INITIAL', 'RETURNED', 'REJECTED', 'REOPENED')),
  previous_revision       integer,
  reopen_request_id       uuid,
  state                   text not null check (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'RETURNED', 'REJECTED')),
  submitted_at            timestamptz,
  submitted_by            uuid references user_account (id) on delete restrict,
  -- Company-local business date of the submission; late when after the period's due date.
  submitted_on            date,
  late                    boolean,
  decided_at              timestamptz,
  decided_by              uuid references user_account (id) on delete restrict,
  -- The reviewer's explanation of a return or rejection, shown to the employee (FR-047 "rejected entries retain reason").
  decision_reason         text check (decision_reason is null or (btrim(decision_reason) <> '' and length(decision_reason) <= 1000)),
  superseded_at           timestamptz,
  superseded_by_revision  integer,
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, timesheet_id, revision),
  foreign key (company_id, timesheet_id, employee_id) references timesheet (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, timesheet_id, previous_revision) references timesheet_revision (company_id, timesheet_id, revision) on delete restrict,
  check ((origin = 'INITIAL') = (revision = 1)),
  check ((origin = 'INITIAL') = (previous_revision is null)),
  check (previous_revision is null or previous_revision = revision - 1),
  check ((origin = 'REOPENED') = (reopen_request_id is not null)),
  check ((state = 'DRAFT') = (submitted_at is null)),
  check (num_nonnulls(submitted_at, submitted_by, submitted_on, late) in (0, 4)),
  check ((state in ('APPROVED', 'RETURNED', 'REJECTED')) = (decided_at is not null)),
  check ((decided_at is null) = (decided_by is null)),
  check (state not in ('RETURNED', 'REJECTED') or decision_reason is not null),
  check (superseded_at is null or state = 'APPROVED'),
  check ((superseded_at is null) = (superseded_by_revision is null)),
  check (superseded_by_revision is null or superseded_by_revision > revision)
);
-- At most one revision of a timesheet is open (being entered or waiting for a decision).
create unique index timesheet_revision_one_open on timesheet_revision (company_id, timesheet_id) where (state in ('DRAFT', 'SUBMITTED'));

create function hrms_timesheet_revision_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a timesheet revision starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from timesheet_revision where company_id = new.company_id and timesheet_id = new.timesheet_id), 0) + 1 then
      raise exception 'timesheet revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.timesheet_id, new.employee_id, new.revision, new.origin, new.previous_revision, new.reopen_request_id) is distinct from
     (old.timesheet_id, old.employee_id, old.revision, old.origin, old.previous_revision, old.reopen_request_id) then
    raise exception 'a timesheet revision''s identity is immutable' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'SUBMITTED') or (old.state = 'SUBMITTED' and new.state in ('APPROVED', 'RETURNED', 'REJECTED'))) then
    raise exception 'timesheet revision transition % -> % is not allowed', old.state, new.state using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.submitted_at, new.submitted_by, new.submitted_on, new.late) is distinct from (old.submitted_at, old.submitted_by, old.submitted_on, old.late) then
    raise exception 'a submitted timesheet revision is immutable' using errcode = '23514';
  end if;
  if old.state in ('APPROVED', 'RETURNED', 'REJECTED') and (new.decided_at, new.decided_by, new.decision_reason) is distinct from (old.decided_at, old.decided_by, old.decision_reason) then
    raise exception 'a timesheet decision is recorded once' using errcode = '23514';
  end if;
  if old.superseded_at is not null and (new.superseded_at, new.superseded_by_revision) is distinct from (old.superseded_at, old.superseded_by_revision) then
    raise exception 'a superseded timesheet revision stays as it was' using errcode = '23514';
  end if;
  -- BR-048: the original names the approved correction of the same timesheet that replaced it.
  if old.superseded_at is null and new.superseded_at is not null and not exists (
       select 1 from timesheet_revision r
        where r.company_id = new.company_id and r.timesheet_id = new.timesheet_id and r.revision = new.superseded_by_revision and r.state = 'APPROVED') then
    raise exception 'a timesheet revision is superseded only by a later approved revision of the same timesheet' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger timesheet_revision_guard before insert or update on timesheet_revision for each row execute function hrms_timesheet_revision_guard();

-- BR-048 / FR-100: at most one approved revision of a timesheet is in force (approved and not superseded), so payroll
-- finds the original and its correction by (company_id, timesheet_id, revision). Checked at commit, because the
-- approval of a correction and the superseding of the original are written one after the other.
alter table timesheet_revision add constraint timesheet_revision_one_in_force
  exclude using btree (company_id with =, timesheet_id with =) where (state = 'APPROVED' and superseded_at is null) deferrable initially deferred;

-- ---------------------------------------------------------------------------------------------------------------
-- DB071 timesheet_line: belongs to one revision; CI14 company, job/activity and period integrity by keys
-- ---------------------------------------------------------------------------------------------------------------
create table timesheet_line (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  timesheet_id          uuid not null,
  employee_id           uuid not null,
  revision              integer not null,
  period_start          date not null,
  work_date             date not null,
  project_id            uuid not null,
  job_id                uuid not null,
  activity_id           uuid not null,
  -- F1: positive quarter-hour increments; a day never holds more than 24 hours (trigger below).
  minutes               integer not null check (minutes > 0 and minutes <= 1440 and minutes % 15 = 0),
  -- The activity's productive classification when the entry was recorded (FR-045: history keeps it).
  productive            boolean not null,
  note                  text check (note is null or (btrim(note) <> '' and length(note) <= 500)),
  -- MANUAL entry, IMPORT (batch import, the same rules) or CARRIED into a new revision from the previous one.
  source                text not null check (source in ('MANUAL', 'IMPORT', 'CARRIED')),
  carried_from_line_id  uuid,
  -- A draft line is removed by marking it; it stays on record.
  removed_at            timestamptz,
  removed_by            uuid references user_account (id) on delete restrict,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, timesheet_id, revision) references timesheet_revision (company_id, timesheet_id, revision) on delete restrict,
  foreign key (company_id, timesheet_id, employee_id) references timesheet (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, timesheet_id, period_start) references timesheet (company_id, id, period_start) on delete restrict,
  foreign key (company_id, job_id, project_id) references timesheet_job (company_id, id, project_id) on delete restrict,
  foreign key (company_id, activity_id) references timesheet_activity (company_id, id) on delete restrict,
  -- F1: the activity must be one the job permits.
  foreign key (company_id, job_id, activity_id) references timesheet_job_activity (company_id, job_id, activity_id) on delete restrict,
  foreign key (company_id, carried_from_line_id) references timesheet_line (company_id, id) on delete restrict,
  check (work_date between period_start and period_start + 6),
  check ((removed_at is null) = (removed_by is null)),
  check ((source = 'CARRIED') = (carried_from_line_id is not null))
);
-- FR-047: duplicate lines (same day, job and activity in one revision) are rejected.
create unique index timesheet_line_one_per_entry on timesheet_line (company_id, timesheet_id, revision, work_date, job_id, activity_id) where (removed_at is null);
create index timesheet_line_revision_idx on timesheet_line (company_id, timesheet_id, revision);
create index timesheet_line_employee_date_idx on timesheet_line (company_id, employee_id, work_date);
-- FR-048 reports over a date range for the whole company scope.
create index timesheet_line_date_idx on timesheet_line (company_id, work_date);

create function hrms_timesheet_line_guard() returns trigger language plpgsql as $$
declare
  revision_state text;
begin
  -- Locked, so a line cannot slip into a revision that a concurrent transaction is submitting or deciding.
  select state into revision_state from timesheet_revision where company_id = new.company_id and timesheet_id = new.timesheet_id and revision = new.revision for no key update;
  if revision_state is distinct from 'DRAFT' then
    raise exception 'lines of a submitted timesheet revision are immutable' using errcode = '23514';
  end if;
  if tg_op = 'INSERT' then
    if new.removed_at is not null then
      raise exception 'a new timesheet line cannot be removed already' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.timesheet_id, new.employee_id, new.revision, new.period_start, new.source, new.carried_from_line_id) is distinct from
     (old.timesheet_id, old.employee_id, old.revision, old.period_start, old.source, old.carried_from_line_id) then
    raise exception 'a timesheet line''s identity is immutable' using errcode = '23514';
  end if;
  if old.removed_at is not null then
    raise exception 'a removed timesheet line is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger timesheet_line_guard before insert or update on timesheet_line for each row execute function hrms_timesheet_line_guard();

-- F1 / FR-047: at most 24 hours on one day of a revision, whatever the source of the lines. Writers of one revision
-- are serialised on the revision row (NO KEY UPDATE does not conflict with the lines' foreign-key checks), so two
-- concurrent writers cannot each miss the other's minutes.
create function hrms_timesheet_daily_limit() returns trigger language plpgsql as $$
declare
  total integer;
begin
  if new.removed_at is not null then
    return null;
  end if;
  perform 1 from timesheet_revision where company_id = new.company_id and timesheet_id = new.timesheet_id and revision = new.revision for no key update;
  select coalesce(sum(minutes), 0) into total from timesheet_line
   where company_id = new.company_id and timesheet_id = new.timesheet_id and revision = new.revision and work_date = new.work_date and removed_at is null;
  if total > 1440 then
    raise exception 'the lines of % total % minutes, more than 24 hours', new.work_date, total using errcode = '23514';
  end if;
  return null;
end $$;
create trigger timesheet_line_daily_limit after insert or update on timesheet_line for each row execute function hrms_timesheet_daily_limit();

-- ---------------------------------------------------------------------------------------------------------------
-- Reopen of an approved timesheet (typed root of kind 'timesheet_reopen')
-- ---------------------------------------------------------------------------------------------------------------
create table timesheet_reopen_request (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  timesheet_id       uuid not null,
  employee_id        uuid not null,
  transaction_kind   text not null default 'timesheet_reopen' check (transaction_kind = 'timesheet_reopen'),
  transaction_id     uuid not null,
  -- The approved revision the request asks to correct.
  approved_revision  integer not null,
  reason             text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  requested_by       uuid not null references user_account (id) on delete restrict,
  state              text not null check (state in ('SUBMITTED', 'APPROVED', 'REJECTED')),
  decided_at         timestamptz,
  decided_by         uuid references user_account (id) on delete restrict,
  -- The correction revision an approval opened.
  new_revision       integer,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  foreign key (company_id, timesheet_id, employee_id) references timesheet (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, timesheet_id, approved_revision) references timesheet_revision (company_id, timesheet_id, revision) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((state = 'SUBMITTED') = (decided_at is null)),
  check ((decided_at is null) = (decided_by is null)),
  -- C4: the requester never decides their own reopen request.
  check (decided_by is null or decided_by <> requested_by),
  check ((state = 'APPROVED') = (new_revision is not null)),
  check (new_revision is null or new_revision = approved_revision + 1)
);
create unique index timesheet_reopen_one_open on timesheet_reopen_request (company_id, timesheet_id) where (state = 'SUBMITTED');
create index timesheet_reopen_request_timesheet_idx on timesheet_reopen_request (company_id, timesheet_id, created_at);

alter table timesheet_revision add constraint timesheet_revision_reopen_fk
  foreign key (company_id, reopen_request_id) references timesheet_reopen_request (company_id, id) on delete restrict;

create function hrms_timesheet_reopen_guard() returns trigger language plpgsql as $$
begin
  if (new.timesheet_id, new.employee_id, new.transaction_id, new.approved_revision, new.reason, new.requested_by) is distinct from
     (old.timesheet_id, old.employee_id, old.transaction_id, old.approved_revision, old.reason, old.requested_by) then
    raise exception 'a timesheet reopen request is immutable' using errcode = '23514';
  end if;
  if old.state <> 'SUBMITTED' and (new.state, new.decided_at, new.decided_by, new.new_revision) is distinct from (old.state, old.decided_at, old.decided_by, old.new_revision) then
    raise exception 'a decided timesheet reopen request is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger timesheet_reopen_request_guard before update on timesheet_reopen_request for each row execute function hrms_timesheet_reopen_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- BR-049 missed submissions: one pending exception per employee and week, resolved by the (late) submission or by
-- a documented resolution. It is a follow-up item only: no pay, attendance or leave effect.
-- ---------------------------------------------------------------------------------------------------------------
create table timesheet_missing_exception (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  employee_id        uuid not null,
  period_start       date not null check (extract(isodow from period_start) = 1),
  period_end         date not null,
  due_date           date not null,
  state              text not null check (state in ('OPEN', 'RESOLVED')),
  raised_on          date not null,
  resolution         text check (resolution in ('SUBMITTED', 'DOCUMENTED')),
  resolution_reason  text check (resolution_reason is null or (btrim(resolution_reason) <> '' and length(resolution_reason) <= 1000)),
  timesheet_id       uuid,
  resolved_at        timestamptz,
  resolved_by        uuid references user_account (id) on delete restrict,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, employee_id, period_start),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, timesheet_id, employee_id) references timesheet (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, timesheet_id, period_start) references timesheet (company_id, id, period_start) on delete restrict,
  check (period_end = period_start + 6),
  check (due_date = period_start + 7),
  check (raised_on > due_date),
  check ((state = 'RESOLVED') = (resolved_at is not null)),
  check (num_nonnulls(resolution, resolved_at, resolved_by) in (0, 3)),
  check (resolution is distinct from 'DOCUMENTED' or resolution_reason is not null),
  check (resolution is distinct from 'SUBMITTED' or timesheet_id is not null)
);
create index timesheet_missing_exception_open_idx on timesheet_missing_exception (company_id, state, period_start);

create function hrms_timesheet_missing_exception_guard() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.period_start, new.period_end, new.due_date, new.raised_on) is distinct from
     (old.employee_id, old.period_start, old.period_end, old.due_date, old.raised_on) then
    raise exception 'a missing-timesheet exception''s employee and week are fixed' using errcode = '23514';
  end if;
  if old.state = 'RESOLVED' then
    raise exception 'a resolved missing-timesheet exception is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger timesheet_missing_exception_guard before update on timesheet_missing_exception for each row execute function hrms_timesheet_missing_exception_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- CI12 mirrors, checked at commit against the rows as they are then (one decision may pass several states)
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_timesheet_mirror() returns trigger language plpgsql as $$
declare
  t timesheet%rowtype;
  bt_state text;
  bt_revision integer;
  current_state text;
  approved_state text;
begin
  select * into t from timesheet where company_id = new.company_id and id = new.id;
  select state, revision into bt_state, bt_revision from business_transaction where company_id = t.company_id and id = t.transaction_id;
  if (bt_state, bt_revision) is distinct from (t.state, t.current_revision) then
    raise exception 'timesheet state % (revision %) does not match its transaction state % (revision %)', t.state, t.current_revision, bt_state, bt_revision using errcode = '23514';
  end if;
  select state into current_state from timesheet_revision where company_id = t.company_id and timesheet_id = t.id and revision = t.current_revision;
  if current_state is distinct from t.state then
    raise exception 'timesheet state % does not match its current revision state %', t.state, current_state using errcode = '23514';
  end if;
  if t.approved_revision is not null then
    select state into approved_state from timesheet_revision
     where company_id = t.company_id and timesheet_id = t.id and revision = t.approved_revision and superseded_at is null;
    if approved_state is distinct from 'APPROVED' then
      raise exception 'the approved revision of a timesheet must be the approved revision in force' using errcode = '23514';
    end if;
  end if;
  return null;
end $$;
create constraint trigger timesheet_mirrors_transaction after insert or update on timesheet deferrable initially deferred
  for each row execute function hrms_timesheet_mirror();

create function hrms_timesheet_reopen_mirror() returns trigger language plpgsql as $$
declare
  row_state text;
  bt_state text;
begin
  select state into row_state from timesheet_reopen_request where company_id = new.company_id and id = new.id;
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from row_state then
    raise exception 'timesheet reopen state % does not match its transaction state %', row_state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger timesheet_reopen_request_mirrors_transaction after insert or update on timesheet_reopen_request deferrable initially deferred
  for each row execute function hrms_timesheet_reopen_mirror();

do $$
declare
  t text;
begin
  foreach t in array array['timesheet_project', 'timesheet_job', 'timesheet_activity', 'timesheet_job_activity', 'resource_allocation', 'timesheet',
                           'timesheet_revision', 'timesheet_line', 'timesheet_reopen_request', 'timesheet_missing_exception'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Transaction catalogue (DF03 states mapped to the timesheet journey)
-- ---------------------------------------------------------------------------------------------------------------
-- A timesheet is the one record of its employee and week, so no state is final: a returned or rejected revision is
-- followed by a new revision linked to it (DF03 "a new request links to the rejected predecessor"), and an
-- approved timesheet goes back to a draft revision only through an approved reopen request.
insert into transaction_kind (kind, root_table, routing_kind) values
  ('timesheet',        'timesheet',                null),
  ('timesheet_reopen', 'timesheet_reopen_request', null);
insert into transaction_state (kind, state, initial, terminal) values
  ('timesheet',        'DRAFT',     true,  false),
  ('timesheet',        'SUBMITTED', false, false),
  ('timesheet',        'RETURNED',  false, false),
  ('timesheet',        'REJECTED',  false, false),
  ('timesheet',        'APPROVED',  false, false),
  ('timesheet_reopen', 'SUBMITTED', true,  false),
  ('timesheet_reopen', 'APPROVED',  false, true),
  ('timesheet_reopen', 'REJECTED',  false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('timesheet',        'DRAFT',     'SUBMITTED'),
  ('timesheet',        'SUBMITTED', 'APPROVED'),
  ('timesheet',        'SUBMITTED', 'RETURNED'),
  ('timesheet',        'SUBMITTED', 'REJECTED'),
  ('timesheet',        'RETURNED',  'DRAFT'),
  ('timesheet',        'REJECTED',  'DRAFT'),
  ('timesheet',        'APPROVED',  'DRAFT'),
  ('timesheet_reopen', 'SUBMITTED', 'APPROVED'),
  ('timesheet_reopen', 'SUBMITTED', 'REJECTED');

-- Permission catalogue. Timesheet data (projects, jobs, activities, dates, hours, work notes, allocation
-- percentages, states and review notes) is operational work information (DF02 "work attendance times/status");
-- no group here is confidential and none is an own-ESS exception.
insert into permission (resource, action, field_group) values
  ('timesheet_master',     'read',              'operational'),
  ('timesheet_master',     'manage',            'operational'),
  ('timesheet_allocation', 'read',              'operational'),
  ('timesheet_allocation', 'manage',            'operational'),
  ('timesheet_allocation', 'import',            'operational'),
  ('timesheet',            'submit',            'operational'),
  ('timesheet',            'read',              'operational'),
  ('timesheet',            'approve',           'operational'),
  ('timesheet',            'request_reopen',    'operational'),
  ('timesheet',            'reopen',            'operational'),
  ('timesheet',            'import',            'operational'),
  ('timesheet',            'resolve_exception', 'operational'),
  ('timesheet',            'report',            'operational');
