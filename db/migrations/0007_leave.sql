-- 0007 Leave (DB028-DB032; FR-024-FR-027; BR-010; DF03; DF05; CI08) and the workflow fallback reviewer list.
-- Balances are never stored as an editable total: they are the signed sum of leave_movement rows.
--   OPENING / ACCRUAL / ADJUSTMENT (+/-) / EXPIRY (-)        entitlement movements
--   RESERVATION (-) on submission, RESERVATION_RELEASE (+)  pending hold and its release
--   CONSUMPTION (-) on approval (paired with a release)     taken leave
--   REVERSAL (+) on approved cancellation                    returns consumed units

-- DF03: explicit fallback list per transaction kind when the direct manager is missing or ineligible.
create table workflow_fallback_reviewer (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  kind        text not null references transaction_kind (kind) on delete restrict,
  user_id     uuid not null references user_account (id) on delete restrict,
  priority    integer not null check (priority > 0),
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, kind, user_id)
);

-- DB028 leave_type (DF05: full/half days; paid flag decides balance enforcement)
create table leave_type (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  code        text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name        text not null check (btrim(name) <> ''),
  unit        text not null check (unit in ('DAY')),
  paid        boolean not null,
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id)
);

-- DB029 leave_policy. DF05 parameters are explicit columns; policies start DRAFT and need an
-- independent activation (activated_by differs from creator).
create table leave_policy (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company (id) on delete restrict,
  leave_type_id       uuid not null,
  revision            integer not null check (revision > 0),
  effective_from      date not null,
  effective_to        date check (effective_to > effective_from),
  eligibility_code    text not null check (eligibility_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  accrual_rule_code   text not null check (accrual_rule_code in ('MONTHLY_PRORATED', 'NONE')),
  annual_entitlement  numeric(12, 4) not null check (annual_entitlement >= 0),
  min_service_days    integer not null default 0 check (min_service_days >= 0),
  carry_cap           numeric(12, 4) not null default 0 check (carry_cap >= 0),
  state               text not null check (state in ('DRAFT', 'ACTIVE', 'RETIRED')),
  activated_by        uuid references user_account (id) on delete restrict,
  activated_at        timestamptz,
  created_at          timestamptz not null default now(),
  created_by          uuid references user_account (id) on delete restrict,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references user_account (id) on delete restrict,
  version             integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, leave_type_id),
  unique (company_id, leave_type_id, revision),
  foreign key (company_id, leave_type_id) references leave_type (company_id, id) on delete restrict,
  check (state = 'DRAFT' or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by),
  check (accrual_rule_code <> 'NONE' or annual_entitlement = 0)
);

-- Policy parameters are frozen once ACTIVE (a change is a new revision).
create function hrms_leave_policy_frozen() returns trigger language plpgsql as $$
begin
  if old.state <> 'DRAFT' and (new.leave_type_id, new.revision, new.effective_from, new.eligibility_code, new.accrual_rule_code,
                               new.annual_entitlement, new.min_service_days, new.carry_cap)
                              is distinct from
                              (old.leave_type_id, old.revision, old.effective_from, old.eligibility_code, old.accrual_rule_code,
                               old.annual_entitlement, old.min_service_days, old.carry_cap) then
    raise exception 'an activated leave policy is immutable; create a new revision' using errcode = '23514';
  end if;
  if old.state = 'RETIRED' and new.state <> 'RETIRED' then
    raise exception 'a retired leave policy cannot be reactivated' using errcode = '23514';
  end if;
  return new;
end $$;

create trigger leave_policy_frozen before update on leave_policy for each row execute function hrms_leave_policy_frozen();

-- DB030 leave_policy_mapping: grade/location per B3, plus employment type (DF05 eligibility groups).
create table leave_policy_mapping (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  policy_id                 uuid not null,
  employment_type_category  text not null default 'EMPLOYMENT_TYPE' check (employment_type_category = 'EMPLOYMENT_TYPE'),
  employment_type_id        uuid,
  grade_id                  uuid,
  location_id               uuid,
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, policy_id) references leave_policy (company_id, id) on delete restrict,
  foreign key (company_id, employment_type_category, employment_type_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, grade_id) references grade (company_id, id) on delete restrict,
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict,
  check (num_nonnulls(employment_type_id, grade_id, location_id) >= 1)
);
create unique index leave_policy_mapping_uq on leave_policy_mapping
  (company_id, policy_id, coalesce(employment_type_id, '00000000-0000-0000-0000-000000000000'),
   coalesce(grade_id, '00000000-0000-0000-0000-000000000000'), coalesce(location_id, '00000000-0000-0000-0000-000000000000'));

-- DB031 leave_request (typed root of kind leave_request)
create table leave_request (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  employee_id       uuid not null,
  leave_type_id     uuid not null,
  policy_id         uuid not null,
  transaction_kind  text not null default 'leave_request' check (transaction_kind = 'leave_request'),
  transaction_id    uuid not null,
  start_date        date not null,
  end_date          date not null,
  half_day          boolean not null default false,
  requested_units   numeric(12, 4) not null check (requested_units > 0 and requested_units * 2 = trunc(requested_units * 2)),
  reason            text,
  state             text not null check (state in ('SUBMITTED', 'RETURNED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED')),
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id, leave_type_id),
  unique (company_id, transaction_id),
  check (end_date >= start_date),
  check (not half_day or (start_date = end_date and requested_units = 0.5)),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, leave_type_id) references leave_type (company_id, id) on delete restrict,
  -- CI08: the policy must belong to the same leave type.
  foreign key (company_id, policy_id, leave_type_id) references leave_policy (company_id, id, leave_type_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  -- FR-026: no two live requests of an employee may overlap.
  exclude using gist (company_id with =, employee_id with =, daterange(start_date, end_date, '[]') with &&)
    where (state in ('SUBMITTED', 'RETURNED', 'APPROVED'))
);

-- DB032 leave_movement: append-only signed ledger; idempotency key makes every effect replay-safe.
create table leave_movement (
  id               uuid primary key default gen_random_uuid(),
  company_id       uuid not null references company (id) on delete restrict,
  employee_id      uuid not null,
  leave_type_id    uuid not null,
  request_id       uuid,
  movement_kind    text not null check (movement_kind in
                     ('OPENING', 'ACCRUAL', 'ADJUSTMENT', 'EXPIRY', 'RESERVATION', 'RESERVATION_RELEASE', 'CONSUMPTION', 'REVERSAL')),
  units            numeric(12, 4) not null check (units <> 0),
  effective_date   date not null,
  idempotency_key  text not null check (length(idempotency_key) between 8 and 200),
  reason           text,
  created_at       timestamptz not null default now(),
  created_by       uuid references user_account (id) on delete restrict,
  updated_at       timestamptz not null default now(),
  updated_by       uuid references user_account (id) on delete restrict,
  version          integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, leave_type_id) references leave_type (company_id, id) on delete restrict,
  -- CI08: a movement for a request has the request's employee and leave type.
  foreign key (company_id, request_id, employee_id, leave_type_id)
    references leave_request (company_id, id, employee_id, leave_type_id) on delete restrict,
  check (
    (movement_kind in ('OPENING', 'ACCRUAL', 'REVERSAL', 'RESERVATION_RELEASE') and units > 0)
    or (movement_kind in ('EXPIRY', 'RESERVATION', 'CONSUMPTION') and units < 0)
    or movement_kind = 'ADJUSTMENT'
  ),
  check (movement_kind not in ('RESERVATION', 'RESERVATION_RELEASE', 'CONSUMPTION', 'REVERSAL') or request_id is not null),
  check (movement_kind not in ('OPENING', 'ADJUSTMENT') or (reason is not null and btrim(reason) <> ''))
);
create index leave_movement_balance_idx on leave_movement (company_id, employee_id, leave_type_id, effective_date);

create trigger leave_movement_append_only before update or delete on leave_movement
  for each row execute function hrms_append_only();

-- Typed root registration and DF03 state catalogue for leave requests.
insert into transaction_kind (kind, root_table) values ('leave_request', 'leave_request');
insert into transaction_state (kind, state, initial, terminal) values
  ('leave_request', 'SUBMITTED', true,  false),
  ('leave_request', 'RETURNED',  false, false),
  ('leave_request', 'APPROVED',  false, false),
  ('leave_request', 'REJECTED',  false, true),
  ('leave_request', 'WITHDRAWN', false, true),
  ('leave_request', 'CANCELLED', false, true);
insert into transaction_transition (kind, from_state, to_state) values
  ('leave_request', 'SUBMITTED', 'APPROVED'),
  ('leave_request', 'SUBMITTED', 'REJECTED'),
  ('leave_request', 'SUBMITTED', 'RETURNED'),
  ('leave_request', 'SUBMITTED', 'WITHDRAWN'),
  ('leave_request', 'RETURNED',  'SUBMITTED'),
  ('leave_request', 'RETURNED',  'WITHDRAWN'),
  ('leave_request', 'APPROVED',  'CANCELLED');

-- The typed root mirrors the transaction state in the same transaction (B5).
create function hrms_leave_request_mirror() returns trigger language plpgsql as $$
declare
  bt_state text;
begin
  select state into bt_state from business_transaction where company_id = new.company_id and id = new.transaction_id;
  if bt_state is distinct from new.state then
    raise exception 'leave request state % does not match its transaction state %', new.state, bt_state using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger leave_request_mirrors_transaction
  after insert or update on leave_request deferrable initially deferred
  for each row execute function hrms_leave_request_mirror();

insert into permission (resource, action, field_group) values
  ('leave', 'submit',   'operational'),
  ('leave', 'read',     'operational'),
  ('leave', 'read',     'reason'),
  ('leave', 'approve',  'operational'),
  ('leave', 'withdraw', 'operational'),
  ('leave', 'adjust',   'operational'),
  ('leave', 'accrue',   'operational'),
  ('leave_policy', 'manage',   'operational'),
  ('leave_policy', 'activate', 'operational'),
  ('workflow', 'manage', 'operational');

do $$
declare
  t text;
begin
  foreach t in array array['workflow_fallback_reviewer', 'leave_type', 'leave_policy', 'leave_policy_mapping', 'leave_request'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
  foreach t in array array['leave_type', 'leave_policy', 'leave_request'] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;
