-- 0011 Salary arrangements, increment cycles, cases and history
-- (DB033-DB035, DB101-DB105; FR-029 base, FR-089-FR-093; BR-038-BR-041; DF14; DF15; CI20; CI21).
-- Salary values are confidential (BR-044). Increment history is append-only and is the source of annual
-- growth reporting together with salary_arrangement; nothing else holds a second salary truth.
-- CR-016: DF14's primary comparable basis is monthly gross fixed pay, so salary_arrangement carries
-- monthly_gross alongside B3's annual_ctc (both are observed E08 values).

create table pay_component (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  code            text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name            text not null check (btrim(name) <> ''),
  component_kind  text not null check (component_kind in ('EARNING', 'DEDUCTION')),
  active          boolean not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id)
);

create table salary_arrangement (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  employee_id     uuid not null,
  effective_from  date not null,
  effective_to    date check (effective_to > effective_from),
  annual_ctc      numeric(19, 4) not null check (annual_ctc >= 0),
  monthly_gross   numeric(19, 4) not null check (monthly_gross >= 0),
  currency_code   text not null check (currency_code ~ '^[A-Z]{3}$'),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  exclude using gist (company_id with =, employee_id with =, daterange(effective_from, effective_to, '[)') with &&)
);

-- Amounts of an arrangement never change in place; only its end date may be set (closing the period).
create function hrms_salary_arrangement_frozen() returns trigger language plpgsql as $$
begin
  if (new.employee_id, new.effective_from, new.annual_ctc, new.monthly_gross, new.currency_code)
     is distinct from (old.employee_id, old.effective_from, old.annual_ctc, old.monthly_gross, old.currency_code) then
    raise exception 'salary arrangement values are immutable; create a new arrangement' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger salary_arrangement_frozen before update on salary_arrangement for each row execute function hrms_salary_arrangement_frozen();

create table salary_component (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  salary_arrangement_id  uuid not null,
  component_id           uuid not null,
  amount                 numeric(19, 4) not null check (amount >= 0),
  basis                  text not null check (basis in ('MONTHLY', 'ANNUAL')),
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, salary_arrangement_id, component_id),
  foreign key (company_id, salary_arrangement_id) references salary_arrangement (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict
);

-- DB101 increment_cycle (DF15 parameters are explicit configuration, never hard-coded)
create table increment_cycle (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  code                      text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  revision                  integer not null check (revision > 0),
  recurrence_basis          text not null check (recurrence_basis in ('COMMON_DATE', 'SERVICE_ANNIVERSARY')),
  recurrence_unit           text not null check (recurrence_unit in ('YEAR')),
  recurrence_interval       integer not null check (recurrence_interval > 0),
  recurrence_anchor_month   integer check (recurrence_anchor_month between 1 and 12),
  recurrence_anchor_day     integer check (recurrence_anchor_day between 1 and 31),
  review_open_month         integer not null check (review_open_month between 1 and 12),
  review_open_day           integer not null check (review_open_day between 1 and 31),
  roster_freeze_month       integer not null check (roster_freeze_month between 1 and 12),
  roster_freeze_day         integer not null check (roster_freeze_day between 1 and 31),
  decision_due_month        integer not null check (decision_due_month between 1 and 12),
  decision_due_day          integer not null check (decision_due_day between 1 and 31),
  eligibility_rule_code     text not null check (eligibility_rule_code in ('CONFIRMED_JOINED_BY_CUTOFF')),
  cutoff_month              integer not null check (cutoff_month between 1 and 12),
  cutoff_day                integer not null check (cutoff_day between 1 and 31),
  exclude_notice            boolean not null,
  compensation_basis        text not null check (compensation_basis in ('MONTHLY_GROSS', 'ANNUAL_CTC')),
  effective_from            date not null,
  effective_to              date check (effective_to > effective_from),
  active                    boolean not null,
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code, revision),
  check (recurrence_basis <> 'COMMON_DATE' or (recurrence_anchor_month is not null and recurrence_anchor_day is not null))
);

-- DB102 employee_increment_plan: one primary plan per employee at any date.
create table employee_increment_plan (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  employee_id           uuid not null,
  cycle_id              uuid not null,
  effective_from        date not null,
  effective_to          date check (effective_to > effective_from),
  next_review_date      date not null,
  override_review_date  date,
  override_reason       text,
  override_approved_by  uuid references user_account (id) on delete restrict,
  active                boolean not null,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, cycle_id) references increment_cycle (company_id, id) on delete restrict,
  check (override_review_date is null or (override_reason is not null and override_approved_by is not null)),
  exclude using gist (company_id with =, employee_id with =, daterange(effective_from, effective_to, '[)') with &&)
);

-- DB103 increment_case (typed root of kind increment_case)
create table increment_case (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references company (id) on delete restrict,
  employee_id              uuid not null,
  plan_id                  uuid,
  cycle_id                 uuid,
  transaction_kind         text not null default 'increment_case' check (transaction_kind = 'increment_case'),
  transaction_id           uuid not null,
  cycle_occurrence_key     text not null check (btrim(cycle_occurrence_key) <> ''),
  off_cycle                boolean not null,
  prepared_by              uuid not null references user_account (id) on delete restrict,
  proposed_by              uuid references user_account (id) on delete restrict,
  baseline_salary_id       uuid not null,
  compensation_basis       text not null check (compensation_basis in ('MONTHLY_GROSS', 'ANNUAL_CTC')),
  currency_code            text not null check (currency_code ~ '^[A-Z]{3}$'),
  baseline_amount          numeric(19, 4) not null check (baseline_amount >= 0),
  proposed_outcome         text check (proposed_outcome in ('INCREASE', 'NO_CHANGE', 'DEFER')),
  proposed_amount          numeric(19, 4) check (proposed_amount >= 0),
  -- CR-016: the other arrangement figure (annual CTC when the basis is monthly gross, and vice versa) is
  -- stated explicitly; DF05 forbids deriving CTC as gross x 12.
  proposed_counterpart     numeric(19, 4) check (proposed_counterpart >= 0),
  approved_amount          numeric(19, 4) check (approved_amount >= 0),
  proposed_effective_date  date not null,
  approved_effective_date  date,
  applied_salary_id        uuid,
  state                    text not null check (state in ('DRAFT', 'SUBMITTED', 'RETURNED', 'APPLIED', 'NO_CHANGE', 'DEFERRED', 'REJECTED')),
  reason                   text not null check (btrim(reason) <> ''),
  created_at               timestamptz not null default now(),
  created_by               uuid references user_account (id) on delete restrict,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references user_account (id) on delete restrict,
  version                  integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  unique (company_id, employee_id, cycle_occurrence_key),
  unique (company_id, applied_salary_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, plan_id, employee_id) references employee_increment_plan (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, cycle_id) references increment_cycle (company_id, id) on delete restrict,
  -- CI20: baseline and applied salary belong to the case employee.
  foreign key (company_id, baseline_salary_id, employee_id) references salary_arrangement (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, applied_salary_id, employee_id) references salary_arrangement (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check (off_cycle or (plan_id is not null and cycle_id is not null)),
  check (proposed_outcome <> 'INCREASE' or (proposed_amount is not null and proposed_counterpart is not null)),
  check ((state = 'APPLIED') = (applied_salary_id is not null)),
  check (state <> 'APPLIED' or (approved_amount is not null and approved_effective_date is not null)),
  check (proposed_by is null or proposed_by <> prepared_by or off_cycle)
);

create function hrms_increment_case_mirror() returns trigger language plpgsql as $$
declare
  bt_state text;
begin
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from new.state then
    raise exception 'increment case state % does not match its transaction state %', new.state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger increment_case_mirrors_transaction after insert or update on increment_case deferrable initially deferred
  for each row execute function hrms_increment_case_mirror();

-- DB104 increment_component (component-level proposals; reconciled to the declared basis when used)
create table increment_component (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  case_id          uuid not null,
  component_id     uuid not null,
  before_amount    numeric(19, 4) not null check (before_amount >= 0),
  proposed_amount  numeric(19, 4) not null check (proposed_amount >= 0),
  approved_amount  numeric(19, 4) check (approved_amount >= 0),
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, case_id, component_id),
  foreign key (company_id, case_id) references increment_case (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict
);

-- DB105 increment_history: append-only, one per applied case (CI20/CI21).
create table increment_history (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  employee_id           uuid not null,
  case_id               uuid not null,
  approval_decision_id  uuid not null,
  old_salary_id         uuid not null,
  new_salary_id         uuid not null,
  effective_date        date not null,
  compensation_basis    text not null check (compensation_basis in ('MONTHLY_GROSS', 'ANNUAL_CTC')),
  currency_code         text not null check (currency_code ~ '^[A-Z]{3}$'),
  before_amount         numeric(19, 4) not null check (before_amount >= 0),
  after_amount          numeric(19, 4) not null check (after_amount >= 0),
  change_amount         numeric(19, 4) not null,
  change_percent        numeric(12, 4),
  percent_na_reason     text check (percent_na_reason in ('ZERO_BASELINE', 'BASIS_CHANGED', 'CURRENCY_CHANGED')),
  reason                text not null check (btrim(reason) <> ''),
  applied_at            timestamptz not null default now(),
  applied_by            uuid not null references user_account (id) on delete restrict,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, case_id),
  unique (company_id, new_salary_id),
  foreign key (company_id, case_id, employee_id) references increment_case (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, approval_decision_id) references approval_decision (company_id, id) on delete restrict,
  foreign key (company_id, old_salary_id, employee_id) references salary_arrangement (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, new_salary_id, employee_id) references salary_arrangement (company_id, id, employee_id) on delete restrict,
  check (change_amount = after_amount - before_amount),
  check ((change_percent is null) = (percent_na_reason is not null)),
  check (percent_na_reason is not null or before_amount > 0)
);
create trigger increment_history_append_only before update or delete on increment_history for each row execute function hrms_append_only();

-- CI20: the person who applies (final approver) is never the preparer of the case.
create function hrms_increment_history_actor() returns trigger language plpgsql as $$
declare
  preparer uuid;
begin
  select prepared_by into preparer from increment_case where company_id = new.company_id and id = new.case_id;
  if preparer = new.applied_by then
    raise exception 'the preparer of an increment cannot approve or apply it' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger increment_history_actor before insert on increment_history for each row execute function hrms_increment_history_actor();

insert into transaction_kind (kind, root_table) values ('increment_case', 'increment_case');
insert into transaction_state (kind, state, initial, terminal) values
  ('increment_case', 'DRAFT',     true,  false),
  ('increment_case', 'SUBMITTED', true,  false),
  ('increment_case', 'RETURNED',  false, false),
  ('increment_case', 'APPLIED',   false, true),
  ('increment_case', 'NO_CHANGE', false, true),
  ('increment_case', 'DEFERRED',  false, true),
  ('increment_case', 'REJECTED',  false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('increment_case', 'DRAFT',     'SUBMITTED'),
  ('increment_case', 'RETURNED',  'SUBMITTED'),
  ('increment_case', 'SUBMITTED', 'RETURNED'),
  ('increment_case', 'SUBMITTED', 'APPLIED'),
  ('increment_case', 'SUBMITTED', 'NO_CHANGE'),
  ('increment_case', 'SUBMITTED', 'DEFERRED'),
  ('increment_case', 'SUBMITTED', 'REJECTED');

insert into permission (resource, action, field_group) values
  ('salary', 'read',   'salary'),
  ('salary', 'manage', 'salary'),
  ('increment', 'read',    'operational'),
  ('increment', 'read',    'salary'),
  ('increment', 'propose', 'salary'),
  ('increment', 'approve', 'salary'),
  ('increment_cycle', 'manage', 'operational');

do $$
declare
  t text;
begin
  foreach t in array array['pay_component', 'salary_arrangement', 'salary_component', 'increment_cycle', 'employee_increment_plan', 'increment_case', 'increment_component'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
  foreach t in array array['salary_arrangement', 'increment_cycle', 'employee_increment_plan', 'increment_case'] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;
