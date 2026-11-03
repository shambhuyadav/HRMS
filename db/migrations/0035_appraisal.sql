-- 0035 Appraisal (FR-040 to FR-044; Appendix F1 "Appraisal"; BR-013/BR-014; DB063-DB065; DF02; DF03; DF04 wave 2
-- "appraisal" form contract; DF08; H3 TN18; B5 typed transactions). Synthetic data only.
--
-- * Company appraisal setting (E11 "Appraisal Config", cycle month): the first month of the financial-year cycle,
--   one of the explained quarter-start months 1, 4, 7 or 10. There is no default: no cycle can be created until an
--   HR administrator sets it.
-- * Cycle (DB063, FR-040): a financial-year period (twelve months from the first day of the configured month) with
--   inclusive goal-setting, self-entry and manager-rating windows, and the number of independent reviewer
--   confirmation levels after the manager's rating (F1: one by default; a second level only when set explicitly).
-- * Appraisal (DB064): one employee in one cycle (typed transaction 'appraisal'). One employee is never in two
--   overlapping cycles. Goals (DB065 appraisal_item) carry whole-number weights 1..100 that must total exactly 100 at
--   submission, so the F1 weighted result sum(weight x score)/100 is exact at two decimals.
-- * Each revision keeps the employee's self-entry, the manager's rating and the outcome separately; each part is fixed
--   once its stage is submitted, and a return ends the revision and opens the next one (F1 "returns create revision").
--   An employee can never write a manager rating (checked here as well as in the application).
-- * Routes (DF03): the appraisal route is the manager's rating (direct manager, HR fallback list) then reviewer level 1
--   (explicit list). The explicit second level is its own typed transaction 'appraisal_second_review' on the same list,
--   opened by level 1's confirmation when the revision's pinned levels are 2 (workflow_step condition codes belong to
--   the platform and are not extended here).
-- * Window exceptions (FR-040): an authorised HR user records an exception for one appraisal and stage, with a
--   confidential reason; the employee concerned can never record one for themselves.
-- Ratings, comments, results and reasons are confidential field groups (DF02): only the operational group is declared
-- operational by the module registration.

-- ---------------------------------------------------------------------------------------------------------------
-- Company appraisal setting
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_setting (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  cycle_start_month  smallint not null check (cycle_start_month in (1, 4, 7, 10)),
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id),
  unique (company_id, id)
);

-- ---------------------------------------------------------------------------------------------------------------
-- DB063 appraisal_cycle
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_cycle (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  code              text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name              text not null check (btrim(name) <> '' and length(name) <= 200),
  start_date        date not null,
  end_date          date not null,
  -- F1: independent reviewer confirmation levels after the manager's rating (one by default, two only explicitly).
  approval_levels   smallint not null default 1 check (approval_levels in (1, 2)),
  goal_opens_on     date,
  goal_closes_on    date,
  self_opens_on     date,
  self_closes_on    date,
  rating_opens_on   date,
  rating_closes_on  date,
  state             text not null default 'OPEN' check (state in ('OPEN', 'CLOSED')),
  closed_by         uuid references user_account (id) on delete restrict,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code),
  unique (company_id, id, start_date, end_date),
  -- F1 financial-year cycle: twelve months from the first day of a month.
  check (extract(day from start_date) = 1),
  check (end_date = (start_date + interval '1 year' - interval '1 day')::date),
  -- Each window is both dates (inclusive) or neither (not scheduled: entries at that stage are refused).
  check ((goal_opens_on is null) = (goal_closes_on is null) and goal_closes_on >= goal_opens_on),
  check ((self_opens_on is null) = (self_closes_on is null) and self_closes_on >= self_opens_on),
  check ((rating_opens_on is null) = (rating_closes_on is null) and rating_closes_on >= rating_opens_on),
  -- FR-040 "align KRA and appraisal windows": the windows follow the process order (goals, self-entry, rating).
  check (self_opens_on >= goal_opens_on and self_closes_on >= goal_closes_on),
  check (rating_opens_on >= self_opens_on and rating_closes_on >= self_closes_on),
  check (rating_opens_on >= goal_opens_on and rating_closes_on >= goal_closes_on),
  check ((state = 'CLOSED') = (closed_at is not null and closed_by is not null))
);

-- ---------------------------------------------------------------------------------------------------------------
-- DB064 appraisal
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  cycle_id          uuid not null,
  -- The cycle period, carried so that overlapping cycles of one employee are excluded by a constraint.
  period_start      date not null,
  period_end        date not null,
  employee_id       uuid not null,
  transaction_kind  text not null default 'appraisal' check (transaction_kind = 'appraisal'),
  transaction_id    uuid not null,
  state             text not null check (state in ('DRAFT', 'SUBMITTED', 'IN_REVIEW', 'RETURNED', 'APPROVED', 'CANCELLED')),
  -- The working revision: the draft being prepared, or the revision under review.
  revision          integer not null default 1 check (revision > 0),
  source            text not null check (source in ('MANUAL', 'UPLOAD')),
  -- DB064 final_rating: the F1 weighted manager result of the confirmed revision (NULL until confirmed).
  final_rating      numeric(5, 2) check (final_rating between 1 and 5),
  completed_at      timestamptz,
  cancelled_by      uuid references user_account (id) on delete restrict,
  cancelled_at      timestamptz,
  cancel_reason     text check (cancel_reason is null or (btrim(cancel_reason) <> '' and length(cancel_reason) <= 1000)),
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  foreign key (company_id, cycle_id, period_start, period_end)
    references appraisal_cycle (company_id, id, start_date, end_date) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((state = 'APPROVED') = (final_rating is not null and completed_at is not null)),
  check ((state = 'CANCELLED') = (cancelled_at is not null and cancelled_by is not null and cancel_reason is not null)),
  -- FR-040: cycles of one employee never overlap (a cancelled appraisal no longer counts).
  exclude using gist (company_id with =, employee_id with =, daterange(period_start, period_end, '[]') with &&)
    where (state <> 'CANCELLED')
);
create index appraisal_cycle_state_idx on appraisal (company_id, cycle_id, state);
create index appraisal_employee_idx on appraisal (company_id, employee_id);

create function hrms_appraisal_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from appraisal_cycle c where c.company_id = new.company_id and c.id = new.cycle_id and c.state = 'OPEN') then
      raise exception 'appraisals are added only to an open cycle' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.cycle_id, new.employee_id, new.transaction_id, new.period_start, new.period_end, new.source)
     is distinct from (old.cycle_id, old.employee_id, old.transaction_id, old.period_start, old.period_end, old.source) then
    raise exception 'appraisal identity is immutable' using errcode = '23514';
  end if;
  if new.revision < old.revision then
    raise exception 'appraisal revision cannot decrease' using errcode = '23514';
  end if;
  if old.final_rating is not null and new.final_rating is distinct from old.final_rating then
    raise exception 'a confirmed appraisal result is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_guard before insert or update on appraisal for each row execute function hrms_appraisal_guard();

-- A cycle's code and period never change; its reviewer levels are fixed once an appraisal of it has been submitted;
-- it closes only when every appraisal in it is finished, and a closed cycle is final.
create function hrms_appraisal_cycle_guard() returns trigger language plpgsql as $$
begin
  if (new.code, new.start_date, new.end_date) is distinct from (old.code, old.start_date, old.end_date) then
    raise exception 'appraisal cycle code and period are immutable' using errcode = '23514';
  end if;
  if old.state = 'CLOSED' then
    raise exception 'a closed appraisal cycle is final' using errcode = '23514';
  end if;
  if new.approval_levels <> old.approval_levels and exists (
    select 1 from appraisal_revision r join appraisal a on a.company_id = r.company_id and a.id = r.appraisal_id
     where a.company_id = new.company_id and a.cycle_id = new.id and r.submitted_at is not null) then
    raise exception 'reviewer levels are fixed once an appraisal of the cycle has been submitted' using errcode = '23514';
  end if;
  if new.state = 'CLOSED' and exists (select 1 from appraisal a where a.company_id = new.company_id and a.cycle_id = new.id
                                         and a.state not in ('APPROVED', 'CANCELLED')) then
    raise exception 'an appraisal cycle with unfinished appraisals cannot be closed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_cycle_guard before update on appraisal_cycle for each row execute function hrms_appraisal_cycle_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB065 appraisal_item: the goals (KRA). Set while the appraisal is a draft that was never submitted, then fixed.
-- Goals are removed by deactivation (DF08: never deleted).
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_item (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  appraisal_id  uuid not null,
  -- Competencies need approved grade-competency masters (BRD 4512/4528); only goals exist so far.
  item_kind     text not null default 'GOAL' check (item_kind = 'GOAL'),
  sequence      integer not null check (sequence between 1 and 100),
  description   text not null check (btrim(description) <> '' and length(description) <= 500),
  target        text check (target is null or (btrim(target) <> '' and length(target) <= 1000)),
  weight        integer not null check (weight between 1 and 100),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  created_by    uuid references user_account (id) on delete restrict,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references user_account (id) on delete restrict,
  version       integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, appraisal_id, id),
  foreign key (company_id, appraisal_id) references appraisal (company_id, id) on delete restrict
);
create unique index appraisal_item_active_sequence on appraisal_item (company_id, appraisal_id, item_kind, sequence) where (active);

create function hrms_appraisal_item_guard() returns trigger language plpgsql as $$
declare
  appraisal_state text;
begin
  select state into appraisal_state from appraisal where company_id = new.company_id and id = new.appraisal_id;
  if appraisal_state is distinct from 'DRAFT' or exists (
    select 1 from appraisal_revision r where r.company_id = new.company_id and r.appraisal_id = new.appraisal_id and r.submitted_at is not null) then
    raise exception 'goals are fixed once the appraisal has been submitted' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' then
    if (new.appraisal_id, new.item_kind) is distinct from (old.appraisal_id, old.item_kind) then
      raise exception 'goal identity is immutable' using errcode = '23514';
    end if;
    if not old.active then
      raise exception 'a removed goal stays removed' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger appraisal_item_guard before insert or update on appraisal_item for each row execute function hrms_appraisal_item_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Revisions: self-entry (prepared while DRAFT, fixed on submission), manager rating (prepared while SUBMITTED,
-- fixed when RATED) and outcome (CONFIRMED, RETURNED or CANCELLED, all final). One working revision at a time.
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_revision (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  appraisal_id      uuid not null,
  revision          integer not null check (revision > 0),
  state             text not null check (state in ('DRAFT', 'SUBMITTED', 'RATED', 'CONFIRMED', 'RETURNED', 'CANCELLED')),
  self_comment      text check (self_comment is null or (btrim(self_comment) <> '' and length(self_comment) <= 4000)),
  submitted_by      uuid references user_account (id) on delete restrict,
  submitted_at      timestamptz,
  -- DF03: the cycle's reviewer levels, pinned when the revision is submitted.
  approval_levels   smallint check (approval_levels in (1, 2)),
  manager_comment   text check (manager_comment is null or (btrim(manager_comment) <> '' and length(manager_comment) <= 4000)),
  rated_by          uuid references user_account (id) on delete restrict,
  rated_at          timestamptz,
  -- F1 weighted manager result sum(weight x manager score)/100, exact (whole-number weights).
  weighted_result   numeric(5, 2) check (weighted_result between 1 and 5),
  returned_by       uuid references user_account (id) on delete restrict,
  returned_at       timestamptz,
  -- The explanation of a return addressed to the employee (the reviewer's private remark stays with the decision).
  employee_message  text check (employee_message is null or (btrim(employee_message) <> '' and length(employee_message) <= 2000)),
  confirmed_at      timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, appraisal_id, id),
  unique (company_id, appraisal_id, revision),
  foreign key (company_id, appraisal_id) references appraisal (company_id, id) on delete restrict,
  check (state in ('DRAFT', 'CANCELLED') or submitted_at is not null),
  check (state <> 'DRAFT' or submitted_at is null),
  check ((submitted_at is null) = (submitted_by is null) and (submitted_at is null) = (approval_levels is null)),
  check ((rated_at is null) = (rated_by is null) and (rated_at is null) = (weighted_result is null)),
  check (state not in ('RATED', 'CONFIRMED') or rated_at is not null),
  check (state not in ('DRAFT', 'SUBMITTED') or rated_at is null),
  check (((state = 'RETURNED') = (returned_at is not null)) and ((returned_at is null) = (returned_by is null)) and ((returned_at is null) = (employee_message is null))),
  check ((state = 'CONFIRMED') = (confirmed_at is not null))
);
create unique index appraisal_revision_one_open on appraisal_revision (company_id, appraisal_id) where (state in ('DRAFT', 'SUBMITTED', 'RATED'));

create function hrms_appraisal_revision_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'an appraisal revision starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from appraisal_revision where company_id = new.company_id and appraisal_id = new.appraisal_id), 0) + 1 then
      raise exception 'appraisal revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.appraisal_id, new.revision) is distinct from (old.appraisal_id, old.revision) then
    raise exception 'appraisal revision identity is immutable' using errcode = '23514';
  end if;
  if old.state in ('CONFIRMED', 'RETURNED', 'CANCELLED') then
    raise exception 'a closed appraisal revision is final' using errcode = '23514';
  end if;
  if new.state <> old.state and (old.state, new.state) not in (
       ('DRAFT', 'SUBMITTED'), ('DRAFT', 'CANCELLED'), ('SUBMITTED', 'RATED'), ('SUBMITTED', 'RETURNED'), ('SUBMITTED', 'CANCELLED'),
       ('RATED', 'CONFIRMED'), ('RATED', 'RETURNED'), ('RATED', 'CANCELLED')) then
    raise exception 'appraisal revision transition % -> % is not allowed', old.state, new.state using errcode = '23514';
  end if;
  -- The self-entry is fixed once submitted.
  if old.state <> 'DRAFT' and (new.self_comment, new.submitted_by, new.submitted_at, new.approval_levels)
       is distinct from (old.self_comment, old.submitted_by, old.submitted_at, old.approval_levels) then
    raise exception 'a submitted self-entry is immutable' using errcode = '23514';
  end if;
  -- The manager's rating is prepared while the revision is submitted, fixed once rated, and never written by the
  -- appraised employee (FR-043: an employee cannot replace a manager rating).
  if (new.manager_comment, new.rated_by, new.rated_at, new.weighted_result) is distinct from (old.manager_comment, old.rated_by, old.rated_at, old.weighted_result) then
    if old.state <> 'SUBMITTED' then
      raise exception 'the manager rating can change only while it is being prepared' using errcode = '23514';
    end if;
    if exists (select 1 from appraisal a join user_employee_link l on l.company_id = a.company_id and l.employee_id = a.employee_id
                where a.company_id = new.company_id and a.id = new.appraisal_id and l.user_id in (new.updated_by, new.rated_by)) then
      raise exception 'an employee can never enter or replace a manager rating' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger appraisal_revision_guard before insert or update on appraisal_revision for each row execute function hrms_appraisal_revision_guard();

-- Per revision and goal: the self score and comment, and the manager score and comment (F1 integer scores 1..5).
create table appraisal_entry (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  appraisal_id     uuid not null,
  revision_id      uuid not null,
  item_id          uuid not null,
  self_score       smallint check (self_score between 1 and 5),
  self_comment     text check (self_comment is null or (btrim(self_comment) <> '' and length(self_comment) <= 2000)),
  manager_score    smallint check (manager_score between 1 and 5),
  manager_comment  text check (manager_comment is null or (btrim(manager_comment) <> '' and length(manager_comment) <= 2000)),
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, revision_id, item_id),
  foreign key (company_id, appraisal_id, revision_id) references appraisal_revision (company_id, appraisal_id, id) on delete restrict,
  foreign key (company_id, appraisal_id, item_id) references appraisal_item (company_id, appraisal_id, id) on delete restrict
);

create function hrms_appraisal_entry_guard() returns trigger language plpgsql as $$
declare
  revision_state text;
begin
  select state into revision_state from appraisal_revision where company_id = new.company_id and id = new.revision_id;
  if tg_op = 'INSERT' then
    if revision_state is distinct from 'DRAFT' then
      raise exception 'entries are added only to a draft revision' using errcode = '23514';
    end if;
    if new.manager_score is not null or new.manager_comment is not null then
      raise exception 'a manager rating is entered only on a submitted revision' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.appraisal_id, new.revision_id, new.item_id) is distinct from (old.appraisal_id, old.revision_id, old.item_id) then
    raise exception 'appraisal entry identity is immutable' using errcode = '23514';
  end if;
  if (new.self_score, new.self_comment) is distinct from (old.self_score, old.self_comment) and revision_state is distinct from 'DRAFT' then
    raise exception 'a submitted self-entry is immutable' using errcode = '23514';
  end if;
  if (new.manager_score, new.manager_comment) is distinct from (old.manager_score, old.manager_comment) then
    if revision_state is distinct from 'SUBMITTED' then
      raise exception 'the manager rating can change only while it is being prepared' using errcode = '23514';
    end if;
    if exists (select 1 from appraisal a join user_employee_link l on l.company_id = a.company_id and l.employee_id = a.employee_id
                where a.company_id = new.company_id and a.id = new.appraisal_id and l.user_id = new.updated_by) then
      raise exception 'an employee can never enter or replace a manager rating' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger appraisal_entry_guard before insert or update on appraisal_entry for each row execute function hrms_appraisal_entry_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- FR-040 window exceptions: append-only; the reason is confidential (HR reason group).
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_window_exception (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  appraisal_id  uuid not null,
  stage         text not null check (stage in ('GOAL_SETTING', 'SELF_ENTRY', 'MANAGER_RATING')),
  valid_until   date not null,
  reason        text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  recorded_by   uuid not null references user_account (id) on delete restrict,
  created_at    timestamptz not null default now(),
  created_by    uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  foreign key (company_id, appraisal_id) references appraisal (company_id, id) on delete restrict
);
create index appraisal_window_exception_idx on appraisal_window_exception (company_id, appraisal_id, stage, valid_until);

create function hrms_appraisal_exception_guard() returns trigger language plpgsql as $$
begin
  if exists (select 1 from appraisal a join user_employee_link l on l.company_id = a.company_id and l.employee_id = a.employee_id
              where a.company_id = new.company_id and a.id = new.appraisal_id and l.user_id = new.recorded_by) then
    raise exception 'an exception for one''s own appraisal cannot be recorded' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_window_exception_guard before insert on appraisal_window_exception
  for each row execute function hrms_appraisal_exception_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- The explicit second reviewer level (F1 "configured second step must be explicit"). It is its own typed transaction
-- (B5: an additional workflow has an explicit typed root), opened when the first reviewer confirms a revision whose
-- pinned levels are 2. It routes like the appraisal (the same explicit list) and excludes the revision's earlier
-- deciders, so the second reviewer is independent of the rater and of the first reviewer (C4).
-- ---------------------------------------------------------------------------------------------------------------
create table appraisal_second_review (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  appraisal_id      uuid not null,
  employee_id       uuid not null,
  revision_id       uuid not null,
  transaction_kind  text not null default 'appraisal_second_review' check (transaction_kind = 'appraisal_second_review'),
  transaction_id    uuid not null,
  state             text not null check (state in ('SUBMITTED', 'APPROVED', 'RETURNED', 'CANCELLED')),
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  -- One second-level review per revision.
  unique (company_id, revision_id),
  foreign key (company_id, appraisal_id, employee_id) references appraisal (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, appraisal_id, revision_id) references appraisal_revision (company_id, appraisal_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred
);

create function hrms_appraisal_second_review_guard() returns trigger language plpgsql as $$
begin
  if (new.appraisal_id, new.employee_id, new.revision_id, new.transaction_id) is distinct from (old.appraisal_id, old.employee_id, old.revision_id, old.transaction_id) then
    raise exception 'appraisal second review identity is immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger appraisal_second_review_guard before update on appraisal_second_review for each row execute function hrms_appraisal_second_review_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- CI12 mirrors: each typed root's state equals its business_transaction's state at commit (compared as they are then).
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_appraisal_mirror() returns trigger language plpgsql as $$
declare
  row_state text;
  bt_state text;
begin
  execute format('select state from %I where company_id = $1 and id = $2', tg_table_name) into row_state using new.company_id, new.id;
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from row_state then
    raise exception '% state % does not match its transaction state %', tg_table_name, row_state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger appraisal_mirrors_transaction after insert or update on appraisal
  deferrable initially deferred for each row execute function hrms_appraisal_mirror();
create constraint trigger appraisal_second_review_mirrors_transaction after insert or update on appraisal_second_review
  deferrable initially deferred for each row execute function hrms_appraisal_mirror();

do $$
declare
  t text;
begin
  foreach t in array array['appraisal_setting', 'appraisal_cycle', 'appraisal', 'appraisal_item', 'appraisal_revision', 'appraisal_entry', 'appraisal_second_review'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
  execute 'create trigger appraisal_window_exception_append_only before update or delete on appraisal_window_exception
             for each row execute function hrms_append_only()';
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- Typed transaction (B5): states and transitions. A return goes back to the employee, whose resubmission is the next
-- revision with a new approval; a confirmed or cancelled appraisal is final.
-- ---------------------------------------------------------------------------------------------------------------
insert into transaction_kind (kind, root_table, routing_kind) values ('appraisal', 'appraisal', null);
insert into transaction_state (kind, state, initial, terminal) values
  ('appraisal', 'DRAFT',     true,  false),
  ('appraisal', 'SUBMITTED', false, false),
  ('appraisal', 'IN_REVIEW', false, false),
  ('appraisal', 'RETURNED',  false, false),
  ('appraisal', 'APPROVED',  false, true),
  ('appraisal', 'CANCELLED', false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('appraisal', 'DRAFT',     'SUBMITTED'),
  ('appraisal', 'DRAFT',     'CANCELLED'),
  ('appraisal', 'SUBMITTED', 'IN_REVIEW'),
  ('appraisal', 'SUBMITTED', 'RETURNED'),
  ('appraisal', 'SUBMITTED', 'CANCELLED'),
  ('appraisal', 'IN_REVIEW', 'APPROVED'),
  ('appraisal', 'IN_REVIEW', 'RETURNED'),
  ('appraisal', 'IN_REVIEW', 'CANCELLED'),
  ('appraisal', 'RETURNED',  'SUBMITTED'),
  ('appraisal', 'RETURNED',  'CANCELLED');

-- The second reviewer level opens already submitted (the first reviewer's confirmation submits it) and ends confirmed,
-- returned (the appraisal goes back to the employee) or cancelled with the appraisal.
insert into transaction_kind (kind, root_table, routing_kind) values ('appraisal_second_review', 'appraisal_second_review', 'appraisal');
insert into transaction_state (kind, state, initial, terminal) values
  ('appraisal_second_review', 'SUBMITTED', true,  false),
  ('appraisal_second_review', 'APPROVED',  false, true),
  ('appraisal_second_review', 'RETURNED',  false, true),
  ('appraisal_second_review', 'CANCELLED', false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('appraisal_second_review', 'SUBMITTED', 'APPROVED'),
  ('appraisal_second_review', 'SUBMITTED', 'RETURNED'),
  ('appraisal_second_review', 'SUBMITTED', 'CANCELLED');

-- ---------------------------------------------------------------------------------------------------------------
-- Permission catalogue (C3 "Appraisal training hiring"). The operational groups are declared by the module
-- registration; appraisal.rating, appraisal.reason and appraisal.self stay confidential. The employee's own self-entry
-- is the H1/BR-053 own-ESS group (own record only); manager/reviewer ratings and notes are never own-ESS.
-- ---------------------------------------------------------------------------------------------------------------
insert into permission (resource, action, field_group, own_ess) values
  ('appraisal_cycle', 'read',            'operational', false),
  ('appraisal_cycle', 'manage',          'operational', false),
  ('appraisal',       'read',            'operational', false),
  ('appraisal',       'manage',          'operational', false),
  ('appraisal',       'cancel',          'operational', false),
  ('appraisal',       'grant_exception', 'operational', false),
  ('appraisal',       'import',          'operational', false),
  ('appraisal',       'report',          'operational', false),
  ('appraisal',       'export',          'operational', false),
  ('appraisal',       'read',            'reason',      false),
  ('appraisal',       'read',            'rating',      false),
  ('appraisal',       'rate',            'rating',      false),
  ('appraisal',       'confirm',         'rating',      false),
  ('appraisal',       'report',          'rating',      false),
  ('appraisal',       'export',          'rating',      false),
  ('appraisal',       'read',            'self',        true),
  ('appraisal',       'self_assess',     'self',        true);
