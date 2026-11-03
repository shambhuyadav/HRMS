-- 0009 Flexible employee confirmation (DB086-DB088; FR-080-FR-082; BR-029-BR-031; DF11; CI17).
-- Planned due dates and the actual confirmation date are separate; reaching a due date never confirms.
-- CR-014: DF11 outcome labels EXTENDED / RETURNED / REJECTED_RECOMMENDATION are recorded as confirmation
-- actions; the case itself returns to OPEN with its (possibly new) due date, so the typed-root state
-- catalogue stays OPEN -> REVIEW_PENDING -> CONFIRMED | OPEN, plus CANCELLED.
-- CR-015: DF11 precedence includes employee type, so employment_type_id is a policy dimension.

create table confirmation_policy (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  code                      text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  revision                  integer not null check (revision > 0),
  duration                  integer not null check (duration > 0),
  duration_unit             text not null check (duration_unit in ('CALENDAR_DAYS', 'CALENDAR_MONTHS')),
  start_basis               text not null check (start_basis in ('JOINING_DATE')),
  month_end_rule            text not null check (month_end_rule in ('CLAMP_TO_MONTH_END')),
  start_day_inclusive       boolean not null,
  employment_type_category  text not null default 'EMPLOYMENT_TYPE' check (employment_type_category = 'EMPLOYMENT_TYPE'),
  employment_type_id        uuid,
  grade_id                  uuid,
  location_id               uuid,
  max_extensions            integer not null default 2 check (max_extensions >= 0),
  effective_from            date not null,
  effective_to              date check (effective_to > effective_from),
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code, revision),
  foreign key (company_id, employment_type_category, employment_type_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, grade_id) references grade (company_id, id) on delete restrict,
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict
);

-- A policy is immutable once a case uses it (a change is a new revision; BR-029).
create function hrms_confirmation_policy_frozen() returns trigger language plpgsql as $$
begin
  if exists (select 1 from employee_confirmation c where c.company_id = old.company_id and c.policy_id = old.id)
     and (new.duration, new.duration_unit, new.start_basis, new.month_end_rule, new.start_day_inclusive, new.max_extensions,
          new.employment_type_id, new.grade_id, new.location_id, new.effective_from)
         is distinct from
         (old.duration, old.duration_unit, old.start_basis, old.month_end_rule, old.start_day_inclusive, old.max_extensions,
          old.employment_type_id, old.grade_id, old.location_id, old.effective_from) then
    raise exception 'a confirmation policy in use is immutable; create a new revision' using errcode = '23514';
  end if;
  return new;
end $$;

-- DB087 employee_confirmation (typed root of kind employee_confirmation)
create table employee_confirmation (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  employee_id               uuid not null,
  policy_id                 uuid not null,
  transaction_kind          text not null default 'employee_confirmation' check (transaction_kind = 'employee_confirmation'),
  transaction_id            uuid not null,
  start_date                date not null,
  initial_due_date          date not null,
  current_due_date          date not null,
  extension_count           integer not null default 0 check (extension_count >= 0),
  override_duration         integer check (override_duration > 0),
  override_due_date         date,
  override_reason           text,
  actual_confirmation_date  date,
  pending_recommendation    text check (pending_recommendation in ('CONFIRM', 'EXTEND')),
  pending_effective_date    date,
  pending_extension_months  integer check (pending_extension_months between 1 and 12),
  last_outcome              text check (last_outcome in ('EXTENDED', 'RETURNED', 'REJECTED_RECOMMENDATION', 'CONFIRMED')),
  state                     text not null check (state in ('OPEN', 'REVIEW_PENDING', 'CONFIRMED', 'CANCELLED')),
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, policy_id) references confirmation_policy (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check (initial_due_date >= start_date and current_due_date >= start_date),
  check (num_nonnulls(override_duration, override_due_date) <= 1),
  check ((override_duration is null and override_due_date is null) or (override_reason is not null and btrim(override_reason) <> '')),
  check ((state = 'CONFIRMED') = (actual_confirmation_date is not null)),
  check (actual_confirmation_date is null or actual_confirmation_date >= start_date),
  check ((state = 'REVIEW_PENDING') = (pending_recommendation is not null)),
  check (pending_recommendation <> 'CONFIRM' or pending_effective_date is not null),
  check (pending_recommendation <> 'EXTEND' or pending_extension_months is not null)
);
-- One live case per employee.
create unique index employee_confirmation_live_uq on employee_confirmation (company_id, employee_id) where (state in ('OPEN', 'REVIEW_PENDING'));

create trigger confirmation_policy_frozen before update on confirmation_policy for each row execute function hrms_confirmation_policy_frozen();

create function hrms_employee_confirmation_mirror() returns trigger language plpgsql as $$
declare
  bt_state text;
begin
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from new.state then
    raise exception 'confirmation state % does not match its transaction state %', new.state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger employee_confirmation_mirrors_transaction
  after insert or update on employee_confirmation deferrable initially deferred
  for each row execute function hrms_employee_confirmation_mirror();

-- DB088 confirmation_action: append-only decision history (CI17).
create table confirmation_action (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  confirmation_id           uuid not null,
  employee_id               uuid not null,
  approval_decision_id      uuid not null,
  action                    text not null check (action in ('CONFIRMED', 'EXTENDED', 'RETURNED', 'REJECTED_RECOMMENDATION')),
  prior_due_date            date not null,
  new_due_date              date not null,
  actual_confirmation_date  date,
  reason                    text not null check (btrim(reason) <> ''),
  occurred_at               timestamptz not null default now(),
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, approval_decision_id),
  -- CI17: the action belongs to the same employee as its case.
  foreign key (company_id, confirmation_id, employee_id) references employee_confirmation (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, approval_decision_id) references approval_decision (company_id, id) on delete restrict,
  check ((action = 'CONFIRMED') = (actual_confirmation_date is not null)),
  check (action <> 'EXTENDED' or new_due_date > prior_due_date),
  check (action = 'EXTENDED' or new_due_date = prior_due_date)
);
create trigger confirmation_action_append_only before update or delete on confirmation_action for each row execute function hrms_append_only();

insert into transaction_kind (kind, root_table) values ('employee_confirmation', 'employee_confirmation');
insert into transaction_state (kind, state, initial, terminal) values
  ('employee_confirmation', 'OPEN',           true,  false),
  ('employee_confirmation', 'REVIEW_PENDING', false, false),
  ('employee_confirmation', 'CONFIRMED',      false, true),
  ('employee_confirmation', 'CANCELLED',      false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('employee_confirmation', 'OPEN',           'REVIEW_PENDING'),
  ('employee_confirmation', 'REVIEW_PENDING', 'CONFIRMED'),
  ('employee_confirmation', 'REVIEW_PENDING', 'OPEN'),
  ('employee_confirmation', 'OPEN',           'CANCELLED');

insert into permission (resource, action, field_group) values
  ('confirmation', 'read',      'operational'),
  ('confirmation', 'manage',    'operational'),
  ('confirmation', 'recommend', 'operational'),
  ('confirmation', 'decide',    'operational'),
  ('confirmation_policy', 'manage', 'operational');

do $$
declare
  t text;
begin
  foreach t in array array['confirmation_policy', 'employee_confirmation'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;
