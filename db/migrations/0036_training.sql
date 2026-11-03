-- 0036 Training plans, participants and feedback (FR-049, FR-050; F1 "Training"; BR-015; DB072-DB074; CI14; CI15; DF02;
-- DF04; DF08; H3 TN17).
--
-- A training plan (DB072) is one session: a permanent code, title, start and end dates (end not before start), a
-- controlled delivery mode, venue, trainer, capacity, an optional cost and an owner. Its FUTURE / CURRENT / PAST view is
-- derived from the company-local date and its dates (F1); CANCELLED is a stored state with actor and reason that
-- overrides the date view (DB072: "cancellation is state, not record deletion").
-- Participants (DB073): one row per employee per plan ("unique plan/employee"; FR-050 "cannot be duplicated in a
-- training session"), in the F1 states NOMINATED / CONFIRMED / ATTENDED / COMPLETED / NO_SHOW / CANCELLED. Capacity is
-- enforced when a nomination is confirmed, under the plan's row lock, so concurrent confirmations cannot overfill it.
-- Nobody confirms, records attendance for or completes their own participation (H3 TN17 "no falsified completion").
-- Every change of a participation is kept in an append-only history.
-- Feedback (DB074): one response per participant and question of the plan's question set, only after completion and
-- only by the participant; a score 1..5 on every answer (operational) and an optional restricted comment (a
-- confidential field group: the coordinator never reads it, F1). Nothing here is ever deleted.

-- ---------------------------------------------------------------------------
-- F1 date view: FUTURE if the company-local date is before the start, CURRENT from start to end inclusive, PAST after
-- the end; CANCELLED overrides the date grouping. The one definition used by lists, filters, exports and metrics.
-- ---------------------------------------------------------------------------
create function hrms_training_plan_view(p_state text, p_start date, p_end date, p_today date) returns text
language sql immutable as $$
  select case when p_state = 'CANCELLED' then 'CANCELLED'
              when p_today < p_start then 'FUTURE'
              when p_today > p_end then 'PAST'
              else 'CURRENT' end
$$;

-- ---------------------------------------------------------------------------
-- DB072 training_plan
-- ---------------------------------------------------------------------------
create table training_plan (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  code                 text not null check (code = upper(btrim(code)) and code ~ '^[A-Z0-9][A-Z0-9._/-]{0,39}$'),
  title                text not null check (btrim(title) <> '' and length(title) <= 200),
  start_date           date not null,
  end_date             date not null,
  -- DF04: a controlled reference list (no free-text value creates a master).
  mode_category        text not null default 'TRAINING_MODE' check (mode_category = 'TRAINING_MODE'),
  mode_id              uuid not null,
  venue                text check (venue is null or (btrim(venue) <> '' and length(venue) <= 300)),
  trainer              text check (trainer is null or (btrim(trainer) <> '' and length(trainer) <= 200)),
  -- DF04 wave 2 contract: capacity > 0.
  capacity             integer not null check (capacity > 0),
  -- The planned cost of the session (company spend, not compensation): two-decimal amount with its currency.
  cost_amount          numeric(19, 4) check (cost_amount is null or (cost_amount >= 0 and cost_amount = round(cost_amount, 2))),
  cost_currency        text check (cost_currency is null or cost_currency ~ '^[A-Z]{3}$'),
  owner_employee_id    uuid not null,
  -- H3 TN17 "own enrollment ... as permitted": employees may nominate themselves only where the plan allows it.
  self_nomination      boolean not null default false,
  state                text not null check (state in ('ACTIVE', 'CANCELLED')),
  cancelled_at         timestamptz,
  cancelled_by         uuid references user_account (id) on delete restrict,
  cancellation_reason  text check (cancellation_reason is null or (btrim(cancellation_reason) <> '' and length(cancellation_reason) <= 1000)),
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code),
  foreign key (company_id, mode_category, mode_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, owner_employee_id) references employee (company_id, id) on delete restrict,
  -- FR-049 acceptance: a plan with end before start is rejected.
  check (end_date >= start_date),
  check ((cost_amount is null) = (cost_currency is null)),
  -- FR-049 acceptance: cancelling a plan records actor and reason.
  check ((state = 'CANCELLED') = (cancelled_at is not null)),
  check ((state = 'CANCELLED') = (cancelled_by is not null)),
  check ((state = 'CANCELLED') = (cancellation_reason is not null))
);
create index training_plan_dates_idx on training_plan (company_id, start_date, end_date);
create index training_plan_state_idx on training_plan (company_id, state, end_date);

-- ---------------------------------------------------------------------------
-- The plan's feedback questions (DB074 question_code; B-section: "feedback question definitions and scoring require
-- controlled approved reference definitions"): codes of the company's controlled TRAINING_FEEDBACK_QUESTION list,
-- chosen with the plan and fixed once any feedback is recorded. Rows are deactivated, never deleted.
-- ---------------------------------------------------------------------------
create table training_plan_question (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  plan_id            uuid not null,
  question_category  text not null default 'TRAINING_FEEDBACK_QUESTION' check (question_category = 'TRAINING_FEEDBACK_QUESTION'),
  question_id        uuid not null,
  position           integer not null check (position between 1 and 20),
  active             boolean not null,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, plan_id, question_id),
  foreign key (company_id, plan_id) references training_plan (company_id, id) on delete restrict,
  foreign key (company_id, question_category, question_id) references reference_value (company_id, category, id) on delete restrict
);
create unique index training_plan_question_position on training_plan_question (company_id, plan_id, position) where (active);

-- ---------------------------------------------------------------------------
-- DB073 training_participant
-- ---------------------------------------------------------------------------
create table training_participant (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  plan_id              uuid not null,
  employee_id          uuid not null,
  participation_state  text not null check (participation_state in ('NOMINATED', 'CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW', 'CANCELLED')),
  -- The current nomination: by the employee themselves (H3 TN17 own enrolment) or by a coordinator/HR.
  self_nominated       boolean not null,
  nominated_at         timestamptz not null default now(),
  nominated_by         uuid not null references user_account (id) on delete restrict,
  confirmed_at         timestamptz,
  confirmed_by         uuid references user_account (id) on delete restrict,
  -- When attendance (ATTENDED or NO_SHOW) was last recorded, and by whom.
  attendance_at        timestamptz,
  attendance_by        uuid references user_account (id) on delete restrict,
  completed_at         timestamptz,
  completed_by         uuid references user_account (id) on delete restrict,
  cancelled_at         timestamptz,
  cancelled_by         uuid references user_account (id) on delete restrict,
  -- A confidential `reason` group (DF02 private reasons; I-16 reviewer notes), never an operational value.
  cancellation_reason  text check (cancellation_reason is null or (btrim(cancellation_reason) <> '' and length(cancellation_reason) <= 1000)),
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, plan_id, employee_id),
  -- DB073 "unique plan/employee"; F1 "one employee participation per session".
  unique (company_id, plan_id, employee_id),
  foreign key (company_id, plan_id) references training_plan (company_id, id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  check ((confirmed_at is null) = (confirmed_by is null)),
  check ((attendance_at is null) = (attendance_by is null)),
  check ((completed_at is null) = (completed_by is null)),
  check ((cancelled_at is null) = (cancelled_by is null)),
  check ((participation_state = 'CANCELLED') = (cancelled_at is not null)),
  check ((participation_state = 'CANCELLED') = (cancellation_reason is not null)),
  check (participation_state not in ('CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW') or confirmed_at is not null),
  check (participation_state <> 'NOMINATED' or confirmed_at is null),
  check ((participation_state in ('ATTENDED', 'COMPLETED', 'NO_SHOW')) = (attendance_at is not null)),
  check ((participation_state = 'COMPLETED') = (completed_at is not null))
);
create index training_participant_employee_idx on training_participant (company_id, employee_id, nominated_at desc);
create index training_participant_state_idx on training_participant (company_id, plan_id, participation_state);

-- ---------------------------------------------------------------------------
-- History of every participation change (DF08: actor, acting assignment, reason, time), append-only. The reason is
-- the confidential `reason` group of training_participant.
-- ---------------------------------------------------------------------------
create table training_participant_event (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  participant_id        uuid not null,
  plan_id               uuid not null,
  employee_id           uuid not null,
  action                text not null check (action in ('NOMINATE', 'SELF_NOMINATE', 'CONFIRM', 'MARK_ATTENDED', 'MARK_NO_SHOW', 'COMPLETE', 'CANCEL', 'WITHDRAW', 'PLAN_CANCELLED')),
  from_state            text check (from_state is null or from_state in ('NOMINATED', 'CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW', 'CANCELLED')),
  to_state              text not null check (to_state in ('NOMINATED', 'CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW', 'CANCELLED')),
  reason                text check (reason is null or (btrim(reason) <> '' and length(reason) <= 1000)),
  actor_user_id         uuid not null references user_account (id) on delete restrict,
  acting_assignment_id  uuid,
  occurred_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  foreign key (company_id, participant_id, plan_id, employee_id) references training_participant (company_id, id, plan_id, employee_id) on delete restrict,
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (from_state is distinct from to_state)
);
create index training_participant_event_idx on training_participant_event (company_id, participant_id, occurred_at);

-- ---------------------------------------------------------------------------
-- DB074 training_feedback
-- ---------------------------------------------------------------------------
create table training_feedback (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  participant_id  uuid not null,
  plan_id         uuid not null,
  employee_id     uuid not null,
  question_id     uuid not null,
  -- F1 "feedback score 1..5"; DF04 contract "feedback score 1..5 and optional restricted comment" (requiredness follows
  -- the DF04 contracts): every answer carries a score, only the comment is optional.
  score           smallint not null check (score between 1 and 5),
  -- F1 "comments restricted": the participant's optional comment, a confidential field group.
  response        text check (response is null or (btrim(response) <> '' and length(response) <= 2000)),
  submitted_at    timestamptz not null default now(),
  submitted_by    uuid not null references user_account (id) on delete restrict,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  -- DB074 "unique participant/question".
  unique (company_id, participant_id, question_id),
  -- CI14: the feedback's participant belongs to its training plan (and to its employee).
  foreign key (company_id, participant_id, plan_id, employee_id) references training_participant (company_id, id, plan_id, employee_id) on delete restrict,
  foreign key (company_id, plan_id, question_id) references training_plan_question (company_id, plan_id, question_id) on delete restrict
);
create index training_feedback_plan_idx on training_feedback (company_id, plan_id);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- A plan starts ACTIVE. Its code is permanent; a cancelled plan is final. Capacity never drops below the seats taken,
-- the dates stay fixed once attendance was recorded, and cancellation needs every live participation closed first and
-- no recorded attendance (a session that took place is not cancelled).
create function hrms_training_plan_guard() returns trigger language plpgsql as $$
declare
  seats integer;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'ACTIVE' then
      raise exception 'a new training plan starts ACTIVE' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.code is distinct from old.code then
    raise exception 'a training plan code is permanent' using errcode = '23514';
  end if;
  if old.state = 'CANCELLED' then
    raise exception 'a cancelled training plan is final' using errcode = '23514';
  end if;
  if new.capacity < old.capacity then
    select count(*) into seats from training_participant
     where company_id = new.company_id and plan_id = new.id and participation_state in ('CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW');
    if seats > new.capacity then
      raise exception 'capacity % is below the % confirmed participations', new.capacity, seats using errcode = '23514';
    end if;
  end if;
  if (new.start_date, new.end_date) is distinct from (old.start_date, old.end_date) and exists (
    select 1 from training_participant
     where company_id = new.company_id and plan_id = new.id and participation_state in ('ATTENDED', 'COMPLETED', 'NO_SHOW')) then
    raise exception 'the dates of a training plan with recorded attendance are fixed' using errcode = '23514';
  end if;
  if new.state = 'CANCELLED' and exists (
    select 1 from training_participant
     where company_id = new.company_id and plan_id = new.id and participation_state <> 'CANCELLED') then
    raise exception 'a training plan is cancelled only when no participation is live or attended' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger training_plan_guard before insert or update on training_plan for each row execute function hrms_training_plan_guard();

-- Question set changes serialise on the plan, need an ACTIVE plan and stop once feedback exists.
create function hrms_training_plan_question_guard() returns trigger language plpgsql as $$
declare
  plan_state text;
begin
  if tg_op = 'UPDATE' and (new.plan_id, new.question_id) is distinct from (old.plan_id, old.question_id) then
    raise exception 'a plan question row keeps its plan and question' using errcode = '23514';
  end if;
  select state into plan_state from training_plan where company_id = new.company_id and id = new.plan_id for update;
  if not found then
    raise exception 'the training plan does not exist in this company' using errcode = '23503';
  end if;
  if plan_state <> 'ACTIVE' then
    raise exception 'the questions of a cancelled training plan are final' using errcode = '23514';
  end if;
  if exists (select 1 from training_feedback f where f.company_id = new.company_id and f.plan_id = new.plan_id) then
    raise exception 'the feedback questions of a plan are fixed once feedback is recorded' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger training_plan_question_guard before insert or update on training_plan_question
  for each row execute function hrms_training_plan_question_guard();

-- At commit an active plan has at least one active feedback question (feedback is otherwise impossible).
create function hrms_training_plan_has_questions(p_company_id uuid, p_plan_id uuid) returns void language plpgsql as $$
begin
  if exists (select 1 from training_plan where company_id = p_company_id and id = p_plan_id and state = 'ACTIVE')
     and not exists (select 1 from training_plan_question where company_id = p_company_id and plan_id = p_plan_id and active) then
    raise exception 'a training plan has at least one feedback question' using errcode = '23514';
  end if;
end $$;

create function hrms_training_plan_questions_check() returns trigger language plpgsql as $$
begin
  perform hrms_training_plan_has_questions(new.company_id, new.id);
  return null;
end $$;

create function hrms_training_question_rows_check() returns trigger language plpgsql as $$
begin
  perform hrms_training_plan_has_questions(new.company_id, new.plan_id);
  return null;
end $$;

create constraint trigger training_plan_has_questions after insert on training_plan deferrable initially deferred
  for each row execute function hrms_training_plan_questions_check();
create constraint trigger training_plan_question_rows_present after update on training_plan_question deferrable initially deferred
  for each row execute function hrms_training_question_rows_check();

-- Participation (DB073, F1). Every change serialises on its plan's row lock and needs an ACTIVE plan. A participation
-- starts NOMINATED; allowed moves:
--   NOMINATED -> CONFIRMED (capacity checked here) | CANCELLED
--   CONFIRMED -> ATTENDED | NO_SHOW (from the start date) | CANCELLED
--   ATTENDED  -> COMPLETED (from the end date) | NO_SHOW (correction)
--   NO_SHOW   -> ATTENDED (correction)
--   CANCELLED -> NOMINATED (nominated again: still one row per employee and plan)
-- COMPLETED is final. Confirmation, attendance and completion are never recorded by a user linked to the participant
-- (H3 TN17 "no falsified completion"; C4).
create function hrms_training_participant_guard() returns trigger language plpgsql as $$
declare
  p record;
  today date;
  seats integer;
  entering boolean;
  recorder uuid;
begin
  select state, start_date, end_date, capacity into p from training_plan where company_id = new.company_id and id = new.plan_id for update;
  if not found then
    raise exception 'the training plan does not exist in this company' using errcode = '23503';
  end if;
  if p.state <> 'ACTIVE' then
    raise exception 'the participations of a cancelled training plan are final' using errcode = '23514';
  end if;
  today := hrms_business_date(new.company_id, now());
  if tg_op = 'INSERT' then
    if new.participation_state <> 'NOMINATED' then
      raise exception 'a participation starts NOMINATED' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.plan_id, new.employee_id, new.created_by) is distinct from (old.plan_id, old.employee_id, old.created_by) then
    raise exception 'a participation keeps its plan and employee' using errcode = '23514';
  end if;
  if old.participation_state = 'COMPLETED' then
    raise exception 'a completed participation is final' using errcode = '23514';
  end if;
  entering := new.participation_state is distinct from old.participation_state;
  if entering and not (
       (old.participation_state = 'NOMINATED' and new.participation_state in ('CONFIRMED', 'CANCELLED'))
    or (old.participation_state = 'CONFIRMED' and new.participation_state in ('ATTENDED', 'NO_SHOW', 'CANCELLED'))
    or (old.participation_state = 'ATTENDED' and new.participation_state in ('COMPLETED', 'NO_SHOW'))
    or (old.participation_state = 'NO_SHOW' and new.participation_state = 'ATTENDED')
    or (old.participation_state = 'CANCELLED' and new.participation_state = 'NOMINATED')) then
    raise exception 'participation state % -> % is not allowed', old.participation_state, new.participation_state using errcode = '23514';
  end if;
  if entering and new.participation_state in ('CONFIRMED', 'ATTENDED', 'NO_SHOW', 'COMPLETED') then
    recorder := case new.participation_state when 'CONFIRMED' then new.confirmed_by when 'COMPLETED' then new.completed_by else new.attendance_by end;
    if exists (select 1 from user_employee_link l where l.company_id = new.company_id and l.user_id = recorder and l.employee_id = new.employee_id) then
      raise exception 'nobody records their own participation' using errcode = '23514';
    end if;
  end if;
  if entering and new.participation_state in ('ATTENDED', 'NO_SHOW') and today < p.start_date then
    raise exception 'attendance is recorded from the start date' using errcode = '23514';
  end if;
  if entering and new.participation_state = 'COMPLETED' and today < p.end_date then
    raise exception 'completion is recorded from the end date' using errcode = '23514';
  end if;
  if entering and new.participation_state = 'CONFIRMED' then
    select count(*) into seats from training_participant
     where company_id = new.company_id and plan_id = new.plan_id and id <> new.id
       and participation_state in ('CONFIRMED', 'ATTENDED', 'COMPLETED', 'NO_SHOW');
    if seats >= p.capacity then
      raise exception 'the training plan is full (capacity %)', p.capacity using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

create trigger training_participant_guard before insert or update on training_participant
  for each row execute function hrms_training_participant_guard();

-- History rows describe the participation as it now is, and are never changed.
create function hrms_training_participant_event_guard() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from training_participant t
                  where t.company_id = new.company_id and t.id = new.participant_id and t.participation_state = new.to_state) then
    raise exception 'a participation history entry records the participation''s current state' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger training_participant_event_guard before insert on training_participant_event
  for each row execute function hrms_training_participant_event_guard();
create trigger training_participant_event_append_only before update or delete on training_participant_event
  for each row execute function hrms_append_only();

-- Feedback: after completion, by the participant, for an active question of the plan; immutable once given.
create function hrms_training_feedback_guard() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from training_participant t
                  where t.company_id = new.company_id and t.id = new.participant_id and t.participation_state = 'COMPLETED') then
    raise exception 'feedback is given after completion' using errcode = '23514';
  end if;
  if not exists (select 1 from training_plan_question q
                  where q.company_id = new.company_id and q.plan_id = new.plan_id and q.question_id = new.question_id and q.active) then
    raise exception 'the question is not part of the plan''s feedback' using errcode = '23514';
  end if;
  if not exists (select 1 from user_employee_link l
                  where l.company_id = new.company_id and l.user_id = new.submitted_by and l.employee_id = new.employee_id) then
    raise exception 'only the participant gives their feedback' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger training_feedback_guard before insert on training_feedback for each row execute function hrms_training_feedback_guard();
create trigger training_feedback_append_only before update or delete on training_feedback for each row execute function hrms_append_only();

-- One submission answers every question of the plan exactly once (checked at commit).
create function hrms_training_feedback_complete() returns trigger language plpgsql as $$
declare
  answered integer;
  expected integer;
begin
  select count(*) into answered from training_feedback where company_id = new.company_id and participant_id = new.participant_id;
  select count(*) into expected from training_plan_question where company_id = new.company_id and plan_id = new.plan_id and active;
  if answered <> expected then
    raise exception 'feedback answers each of the plan''s % questions once (% given)', expected, answered using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger training_feedback_complete after insert on training_feedback deferrable initially deferred
  for each row execute function hrms_training_feedback_complete();

do $$
declare
  t text;
begin
  foreach t in array array['training_plan', 'training_plan_question', 'training_participant'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Catalogue. Plans, cost, participation and feedback scores are operational (the module registration classifies the
-- groups); the cost has its own group so the Employee role never receives it. Two groups are confidential: the
-- feedback comment (F1 "comments restricted"; the employee's own comment is an own-ESS group, H1/BR-053: own record
-- only) and the reasons recorded on a participation (cancellation, withdrawal and attendance-correction reasons: DF02
-- private reasons, I-16 reviewer notes; not own-ESS). Anyone else needs an eligible Admin/Manager assignment with an
-- approved grant (F1: the coordinator sees no protected feedback narratives).
-- ---------------------------------------------------------------------------
insert into permission (resource, action, field_group, own_ess) values
  ('training_plan',        'read',   'operational', false),
  ('training_plan',        'manage', 'operational', false),
  ('training_plan',        'export', 'operational', false),
  ('training_plan',        'read',   'cost',        false),
  ('training_plan',        'manage', 'cost',        false),
  ('training_plan',        'export', 'cost',        false),
  ('training_participant', 'read',   'operational', false),
  ('training_participant', 'manage', 'operational', false),
  ('training_participant', 'enrol',  'operational', false),
  ('training_participant', 'read',   'reason',      false),
  ('training_feedback',    'read',   'operational', false),
  ('training_feedback',    'submit', 'operational', false),
  ('training_feedback',    'export', 'operational', false),
  ('training_feedback',    'read',   'comment',     true),
  ('training_feedback',    'submit', 'comment',     true);
