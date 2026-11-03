-- 0050 Increment cycle management (DF15; FR-091; FR-093; BR-040; DB101; DB102; C4).
--
-- * Cycle definitions are effective-dated revisions of a cycle code. An authorised HR user drafts a new cycle or a
--   new revision; a different user activates it (as other policies are activated); activating a revision closes the
--   previous revision of the code on the new revision's first day; an activated definition never changes in place
--   (DB101 "immutable definition while referenced by active plan/case"), so a change is always a new revision.
-- * SERVICE_ANNIVERSARY cycles take each employee's service anniversary in the year as the effective date
--   (service_anniversary_date, else the joining date; 29 February falls on 28 February in non-leap years, the DF12
--   month-end clamp). Their review window, roster freeze and decision due date are day offsets before that date
--   which the company supplies: there are no default offsets, and a cycle without them cannot be activated.
-- * FR-091 "assign employees by approved company/group rules": a COMPANY_DEFAULT cycle covers every employee who has
--   no plan on the date (the provisioned DF15 annual cycle takes this rule through the column default); an
--   ASSIGNED_ONLY cycle covers the employees assigned to it. At most one company default is in force on any date.
-- * Employee cycle assignments and employee-specific review-date overrides are proposals decided by a different
--   eligible user, never the proposer or the employee concerned. An approved change is a new plan revision; the
--   replaced revision is kept (DB102 "next due recomputed only through approved action with history").
-- * Each cycle case keeps the review window it was opened with, and every opening is recorded: on and after an
--   employee's roster freeze date a rerun adds no new case for that employee.

-- Calendar helpers. A (month, day) that does not exist in the year falls on the month's last day (DF12 clamp).
create function hrms_increment_date(p_year integer, p_month integer, p_day integer) returns date
language sql immutable strict parallel safe as $$
  select make_date(p_year, p_month,
                   least(p_day, extract(day from (make_date(p_year, p_month, 1) + interval '1 month' - interval '1 day'))::integer))
$$;

-- The latest (month, day) on or before a date.
create function hrms_increment_on_or_before(p_date date, p_month integer, p_day integer) returns date
language sql immutable strict parallel safe as $$
  select case when hrms_increment_date(extract(year from p_date)::integer, p_month, p_day) <= p_date
              then hrms_increment_date(extract(year from p_date)::integer, p_month, p_day)
              else hrms_increment_date(extract(year from p_date)::integer - 1, p_month, p_day) end
$$;

-- The latest (month, day) strictly before a date (DF15 "joining date on/before prior 30 September").
create function hrms_increment_before(p_date date, p_month integer, p_day integer) returns date
language sql immutable strict parallel safe as $$
  select case when hrms_increment_date(extract(year from p_date)::integer, p_month, p_day) < p_date
              then hrms_increment_date(extract(year from p_date)::integer, p_month, p_day)
              else hrms_increment_date(extract(year from p_date)::integer - 1, p_month, p_day) end
$$;

-- A calendar (month, day) pair, 29 February included; both absent is also accepted (optional pairs).
create function hrms_increment_month_day_valid(p_month integer, p_day integer) returns boolean
language sql immutable parallel safe as $$
  select (p_month is null and p_day is null)
      or (p_month between 1 and 12 and p_day between 1 and case when p_month = 2 then 29 when p_month in (4, 6, 9, 11) then 30 else 31 end)
$$;

-- ---------------------------------------------------------------------------------------------------------------
-- DB101 increment_cycle: revisions, independent activation, anniversary offsets, assignment rule
-- ---------------------------------------------------------------------------------------------------------------
alter table increment_cycle
  alter column review_open_month drop not null,
  alter column review_open_day drop not null,
  alter column roster_freeze_month drop not null,
  alter column roster_freeze_day drop not null,
  alter column decision_due_month drop not null,
  alter column decision_due_day drop not null,
  alter column cutoff_month drop not null,
  alter column cutoff_day drop not null,
  -- SERVICE_ANNIVERSARY milestones: days before each employee's effective date (no defaults).
  add column review_open_offset_days integer check (review_open_offset_days >= 0),
  add column roster_freeze_offset_days integer check (roster_freeze_offset_days >= 0),
  add column decision_due_offset_days integer check (decision_due_offset_days >= 0),
  -- The default applies only to rows inserted without the column (the provisioned DF15 annual cycle); the API always
  -- states the rule.
  add column assignment_rule text not null default 'COMPANY_DEFAULT' check (assignment_rule in ('COMPANY_DEFAULT', 'ASSIGNED_ONLY')),
  add column activated_by uuid references user_account (id) on delete restrict,
  add column activated_at timestamptz;

alter table increment_cycle drop constraint increment_cycle_eligibility_rule_code_check;

alter table increment_cycle
  add constraint increment_cycle_eligibility_rule_code_check
    check (eligibility_rule_code in ('CONFIRMED_JOINED_BY_CUTOFF', 'CONFIRMED_SERVICE_INTERVAL')),
  -- Common-date cycles are defined by calendar dates; anniversary cycles by day offsets from each employee's date.
  add constraint increment_cycle_basis_parameters check (
    case recurrence_basis
      when 'COMMON_DATE' then
        eligibility_rule_code = 'CONFIRMED_JOINED_BY_CUTOFF'
        and num_nulls(recurrence_anchor_month, recurrence_anchor_day, review_open_month, review_open_day, roster_freeze_month,
                      roster_freeze_day, decision_due_month, decision_due_day, cutoff_month, cutoff_day) = 0
        and num_nonnulls(review_open_offset_days, roster_freeze_offset_days, decision_due_offset_days) = 0
      else
        eligibility_rule_code = 'CONFIRMED_SERVICE_INTERVAL'
        and num_nonnulls(recurrence_anchor_month, recurrence_anchor_day, review_open_month, review_open_day, roster_freeze_month,
                         roster_freeze_day, decision_due_month, decision_due_day, cutoff_month, cutoff_day) = 0
    end),
  -- An anniversary cycle in force has all three offsets; a draft may still lack them (reported as configuration needed).
  add constraint increment_cycle_anniversary_offsets check (
    recurrence_basis <> 'SERVICE_ANNIVERSARY' or not active
    or num_nulls(review_open_offset_days, roster_freeze_offset_days, decision_due_offset_days) = 0),
  -- DB101 "positive recurrence and window; nonnegative lead": the review opens before the roster freezes, which is
  -- no later than the decision due date, and the window from opening to decisions is at least one day.
  add constraint increment_cycle_offset_order check (
    (review_open_offset_days is null or roster_freeze_offset_days is null or review_open_offset_days >= roster_freeze_offset_days)
    and (roster_freeze_offset_days is null or decision_due_offset_days is null or roster_freeze_offset_days >= decision_due_offset_days)
    and (review_open_offset_days is null or decision_due_offset_days is null or review_open_offset_days > decision_due_offset_days)),
  add constraint increment_cycle_calendar_days check (
    hrms_increment_month_day_valid(recurrence_anchor_month, recurrence_anchor_day)
    and hrms_increment_month_day_valid(review_open_month, review_open_day)
    and hrms_increment_month_day_valid(roster_freeze_month, roster_freeze_day)
    and hrms_increment_month_day_valid(decision_due_month, decision_due_day)
    and hrms_increment_month_day_valid(cutoff_month, cutoff_day)),
  -- Independent activation: a draft carries no activation; the activator is never the author.
  add constraint increment_cycle_activation check (
    (activated_by is null) = (activated_at is null)
    and (active or activated_by is null)
    and (activated_by is null or created_by is null or activated_by <> created_by)),
  -- Revisions of one code in force never overlap; at most one company default is in force on any date.
  add constraint increment_cycle_revisions_do_not_overlap
    exclude using gist (company_id with =, code with =, daterange(effective_from, effective_to, '[)') with &&) where (active),
  add constraint increment_cycle_one_company_default
    exclude using gist (company_id with =, daterange(effective_from, effective_to, '[)') with &&)
    where (active and assignment_rule = 'COMPANY_DEFAULT'),
  add constraint increment_cycle_id_code unique (company_id, id, code);

-- One draft revision per code at a time.
create unique index increment_cycle_one_draft on increment_cycle (company_id, code) where (not active);

-- An activated definition is frozen: only its closing date may be set, once, and never before a review it governs.
create function hrms_increment_cycle_guard() returns trigger language plpgsql as $$
begin
  if (new.code, new.revision) is distinct from (old.code, old.revision) then
    raise exception 'the code and revision of an increment cycle never change' using errcode = '23514';
  end if;
  if old.active then
    if not new.active then
      raise exception 'an activated increment cycle stays in force for its period; close it with a later revision' using errcode = '23514';
    end if;
    if (new.recurrence_basis, new.recurrence_unit, new.recurrence_interval, new.recurrence_anchor_month, new.recurrence_anchor_day,
        new.review_open_month, new.review_open_day, new.roster_freeze_month, new.roster_freeze_day, new.decision_due_month,
        new.decision_due_day, new.review_open_offset_days, new.roster_freeze_offset_days, new.decision_due_offset_days,
        new.eligibility_rule_code, new.cutoff_month, new.cutoff_day, new.exclude_notice, new.compensation_basis, new.assignment_rule,
        new.effective_from, new.activated_by, new.activated_at)
       is distinct from
       (old.recurrence_basis, old.recurrence_unit, old.recurrence_interval, old.recurrence_anchor_month, old.recurrence_anchor_day,
        old.review_open_month, old.review_open_day, old.roster_freeze_month, old.roster_freeze_day, old.decision_due_month,
        old.decision_due_day, old.review_open_offset_days, old.roster_freeze_offset_days, old.decision_due_offset_days,
        old.eligibility_rule_code, old.cutoff_month, old.cutoff_day, old.exclude_notice, old.compensation_basis, old.assignment_rule,
        old.effective_from, old.activated_by, old.activated_at) then
      raise exception 'an activated increment cycle is immutable; create a new revision' using errcode = '23514';
    end if;
    if old.effective_to is not null and new.effective_to is distinct from old.effective_to then
      raise exception 'a closed increment cycle revision stays closed' using errcode = '23514';
    end if;
    if old.effective_to is null and new.effective_to is not null and exists (
         select 1 from increment_case c
          where c.company_id = new.company_id and c.cycle_id = new.id and c.proposed_effective_date >= new.effective_to) then
      raise exception 'reviews of this cycle revision take effect on or after the closing date' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger increment_cycle_guard before update on increment_cycle for each row execute function hrms_increment_cycle_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Plan change proposals: cycle assignment and review-date override (DB102; FR-091; C4)
-- ---------------------------------------------------------------------------------------------------------------
create table increment_plan_change (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  employee_id      uuid not null,
  kind             text not null check (kind in ('ASSIGN_CYCLE', 'REVIEW_DATE_OVERRIDE')),
  -- The employee's current plan revision when proposed (none while the company default covers the employee).
  base_plan_id     uuid,
  -- ASSIGN_CYCLE: the target revision in force on effective_from; REVIEW_DATE_OVERRIDE: the revision of the occurrence.
  cycle_id         uuid not null,
  effective_from   date,
  occurrence_key   text check (occurrence_key ~ '^[A-Z][A-Z0-9_]{0,39}:[0-9]{4}$'),
  scheduled_date   date,
  override_date    date,
  -- Private justification (the increment `reason` group, 0032).
  reason           text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  state            text not null default 'PROPOSED' check (state in ('PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  proposed_by      uuid not null references user_account (id) on delete restrict,
  decided_by       uuid references user_account (id) on delete restrict,
  decided_at       timestamptz,
  decision_reason  text check (decision_reason is null or (btrim(decision_reason) <> '' and length(decision_reason) <= 1000)),
  -- The plan revision an approval created.
  result_plan_id   uuid,
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, cycle_id) references increment_cycle (company_id, id) on delete restrict,
  foreign key (company_id, base_plan_id, employee_id) references employee_increment_plan (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, result_plan_id, employee_id) references employee_increment_plan (company_id, id, employee_id) on delete restrict,
  check (case kind
           when 'ASSIGN_CYCLE' then effective_from is not null and num_nonnulls(occurrence_key, scheduled_date, override_date) = 0
           else effective_from is null and num_nulls(occurrence_key, scheduled_date, override_date) = 0
         end),
  -- Independent decision: never by the proposer (C4).
  check (decided_by is null or decided_by <> proposed_by),
  check ((state in ('APPROVED', 'REJECTED')) = (decided_by is not null and decided_at is not null and decision_reason is not null)),
  check ((state = 'APPROVED') = (result_plan_id is not null))
);
-- One open proposal per employee.
create unique index increment_plan_change_one_open on increment_plan_change (company_id, employee_id) where (state = 'PROPOSED');

-- Proposals are immutable; decided or withdrawn proposals are final; the employee concerned never proposes or decides.
create function hrms_increment_plan_change_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'PROPOSED' then
      raise exception 'an increment plan change starts as a proposal' using errcode = '23514';
    end if;
    if exists (select 1 from user_employee_link l where l.company_id = new.company_id and l.user_id = new.proposed_by and l.employee_id = new.employee_id) then
      raise exception 'an employee cannot propose a change to their own increment plan' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_id, new.kind, new.base_plan_id, new.cycle_id, new.effective_from, new.occurrence_key, new.scheduled_date,
      new.override_date, new.reason, new.proposed_by)
     is distinct from
     (old.employee_id, old.kind, old.base_plan_id, old.cycle_id, old.effective_from, old.occurrence_key, old.scheduled_date,
      old.override_date, old.reason, old.proposed_by) then
    raise exception 'an increment plan change proposal is immutable' using errcode = '23514';
  end if;
  if old.state <> 'PROPOSED' and (new.state, new.decided_by, new.decided_at, new.decision_reason, new.result_plan_id)
     is distinct from (old.state, old.decided_by, old.decided_at, old.decision_reason, old.result_plan_id) then
    raise exception 'increment plan change in % is final', old.state using errcode = '23514';
  end if;
  if new.decided_by is not null and exists (
       select 1 from user_employee_link l where l.company_id = new.company_id and l.user_id = new.decided_by and l.employee_id = new.employee_id) then
    raise exception 'an employee cannot decide a change to their own increment plan' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger increment_plan_change_guard before insert or update on increment_plan_change
  for each row execute function hrms_increment_plan_change_guard();
create trigger increment_plan_change_touch before update on increment_plan_change for each row execute function hrms_touch();
create trigger increment_plan_change_no_delete before delete on increment_plan_change for each row execute function hrms_no_delete();

-- ---------------------------------------------------------------------------------------------------------------
-- DB102 employee_increment_plan: revisions with history
-- ---------------------------------------------------------------------------------------------------------------
-- The period exclusion covers the plan history in force; a revision replaced for its whole period (superseded) is kept
-- outside it, so a same-period revision (e.g. an approved override) never edits the row it replaces.
do $$
declare
  c text;
begin
  select conname into c from pg_constraint where conrelid = 'employee_increment_plan'::regclass and contype = 'x';
  execute format('alter table employee_increment_plan drop constraint %I', c);
end $$;

alter table employee_increment_plan
  -- The occurrence (cycle code and year) an approved review-date override applies to.
  add column override_occurrence_key text check (override_occurrence_key ~ '^[A-Z][A-Z0-9_]{0,39}:[0-9]{4}$'),
  add column supersedes_id uuid,
  add column superseded_at timestamptz,
  add column change_id uuid,
  add constraint employee_increment_plan_one_per_date
    exclude using gist (company_id with =, employee_id with =, daterange(effective_from, effective_to, '[)') with &&)
    where (superseded_at is null),
  add constraint employee_increment_plan_supersedes_fk
    foreign key (company_id, supersedes_id, employee_id) references employee_increment_plan (company_id, id, employee_id) on delete restrict,
  add constraint employee_increment_plan_superseded_once unique (company_id, supersedes_id),
  add constraint employee_increment_plan_change_fk
    foreign key (company_id, change_id, employee_id) references increment_plan_change (company_id, id, employee_id) on delete restrict,
  add constraint employee_increment_plan_override_occurrence check ((override_review_date is null) = (override_occurrence_key is null)),
  -- `active` marks the employee's current open-ended revision.
  add constraint employee_increment_plan_current check (active = (superseded_at is null and effective_to is null));

-- A plan revision never changes: it may only be closed (end date) or superseded, once.
create function hrms_increment_plan_guard() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.cycle_id, new.effective_from, new.next_review_date, new.override_review_date, new.override_reason,
      new.override_approved_by, new.override_occurrence_key, new.supersedes_id, new.change_id)
     is distinct from
     (old.employee_id, old.cycle_id, old.effective_from, old.next_review_date, old.override_review_date, old.override_reason,
      old.override_approved_by, old.override_occurrence_key, old.supersedes_id, old.change_id) then
    raise exception 'an increment plan revision is immutable; record a new revision' using errcode = '23514';
  end if;
  if old.effective_to is not null and new.effective_to is distinct from old.effective_to then
    raise exception 'a closed increment plan revision stays closed' using errcode = '23514';
  end if;
  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'a superseded increment plan revision stays superseded' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger employee_increment_plan_guard before update on employee_increment_plan for each row execute function hrms_increment_plan_guard();

create index employee_increment_plan_override_idx on employee_increment_plan (company_id, override_review_date)
  where (superseded_at is null and override_review_date is not null);

-- ---------------------------------------------------------------------------------------------------------------
-- DB103 increment_case: the review window a cycle case was opened with (snapshot, BR-040)
-- ---------------------------------------------------------------------------------------------------------------
alter table increment_case
  add column review_opens_on date,
  add column roster_freezes_on date,
  add column decision_due_on date;

-- Cases opened before this migration were opened on common-date cycles at the scheduled date.
update increment_case c
   set review_opens_on = hrms_increment_on_or_before(c.proposed_effective_date, y.review_open_month, y.review_open_day),
       roster_freezes_on = hrms_increment_on_or_before(c.proposed_effective_date, y.roster_freeze_month, y.roster_freeze_day),
       decision_due_on = hrms_increment_on_or_before(c.proposed_effective_date, y.decision_due_month, y.decision_due_day)
  from increment_cycle y
 where y.company_id = c.company_id and y.id = c.cycle_id and not c.off_cycle;

alter table increment_case
  add constraint increment_case_review_window check (
    case when off_cycle then num_nonnulls(review_opens_on, roster_freezes_on, decision_due_on) = 0
         else num_nulls(review_opens_on, roster_freezes_on, decision_due_on) = 0
              and review_opens_on <= roster_freezes_on and roster_freezes_on <= decision_due_on
              and decision_due_on <= proposed_effective_date
    end);

create index increment_case_cycle_idx on increment_case (company_id, cycle_id);
create index increment_case_decision_due_idx on increment_case (company_id, decision_due_on)
  where (not off_cycle and state in ('DRAFT', 'SUBMITTED', 'RETURNED'));

-- ---------------------------------------------------------------------------------------------------------------
-- Review openings (append-only): the first opening of a period takes the roster snapshot
-- ---------------------------------------------------------------------------------------------------------------
create table increment_review_run (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  cycle_id        uuid not null,
  cycle_code      text not null,
  -- 'YYYY' for a common-date occurrence, 'YYYY-MM' for an anniversary month.
  period_key      text not null check (period_key ~ '^[0-9]{4}(-(0[1-9]|1[0-2]))?$'),
  run_number      integer not null check (run_number > 0),
  created_count   integer not null check (created_count >= 0),
  excluded_count  integer not null check (excluded_count >= 0),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, cycle_code, period_key, run_number),
  foreign key (company_id, cycle_id, cycle_code) references increment_cycle (company_id, id, code) on delete restrict
);
create trigger increment_review_run_append_only before update or delete on increment_review_run
  for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- DF15 "completed required appraisal where that module is enabled": which appraisal cycle is required is company
-- configuration with no default. When a revision names one and the appraisal module is active, an employee needs an
-- APPROVED appraisal in that cycle to be reviewed; otherwise the employee is excluded with a reason and repair path.
-- ---------------------------------------------------------------------------------------------------------------
alter table increment_cycle
  add column required_appraisal_cycle_id uuid,
  add constraint increment_cycle_required_appraisal_fk
    foreign key (company_id, required_appraisal_cycle_id) references appraisal_cycle (company_id, id) on delete restrict;

-- Part of the definition: frozen once the revision is activated, like the rest of it (hrms_increment_cycle_guard).
create function hrms_increment_cycle_appraisal_guard() returns trigger language plpgsql as $$
begin
  if old.active and new.required_appraisal_cycle_id is distinct from old.required_appraisal_cycle_id then
    raise exception 'an activated increment cycle is immutable; create a new revision' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger increment_cycle_appraisal_guard before update on increment_cycle
  for each row execute function hrms_increment_cycle_appraisal_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB104 increment_component: the component breakdown of a proposal (FR-092 "baseline salary and component changes").
-- Each proposal of a case (business transaction revision) has its own immutable lines, so a returned case proposed
-- again keeps the earlier breakdown on record; the key "unique case/component" holds per proposal. The basis is the
-- salary_component basis the line becomes. The before amount is the baseline arrangement's amount of the same
-- component and basis, NULL when the baseline has none (unknown, never assumed zero). Approval copies the approved
-- lines into salary_component rows of the new arrangement in the applying transaction, exactly as approved.
-- ---------------------------------------------------------------------------------------------------------------
alter table increment_component
  drop constraint increment_component_company_id_case_id_component_id_key,
  alter column before_amount drop not null,
  add column basis text not null check (basis in ('MONTHLY', 'ANNUAL')),
  add column proposal_revision integer not null check (proposal_revision > 0),
  add constraint increment_component_one_per_proposal unique (company_id, case_id, proposal_revision, component_id),
  -- The approver approves the proposal as made: no amount is changed or rounded at approval.
  add constraint increment_component_approved_as_proposed check (approved_amount is null or approved_amount = proposed_amount);

create function hrms_increment_component_guard() returns trigger language plpgsql as $$
begin
  if (new.case_id, new.component_id, new.basis, new.proposal_revision, new.before_amount, new.proposed_amount)
     is distinct from (old.case_id, old.component_id, old.basis, old.proposal_revision, old.before_amount, old.proposed_amount) then
    raise exception 'a proposed increment component is immutable; propose again' using errcode = '23514';
  end if;
  if old.approved_amount is not null and new.approved_amount is distinct from old.approved_amount then
    raise exception 'an approved increment component is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger increment_component_guard before update on increment_component
  for each row execute function hrms_increment_component_guard();

-- Activation, plan proposals and plan decisions are distinct duties (C4: never the same person for one record).
insert into permission (resource, action, field_group) values
  ('increment_cycle', 'activate', 'operational'),
  ('increment_plan', 'propose', 'operational'),
  ('increment_plan', 'approve', 'operational');
