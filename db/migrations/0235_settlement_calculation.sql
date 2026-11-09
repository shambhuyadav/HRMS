-- 0235 Final settlement calculation (FR-052; BR-016; DF05; F1; F4; BRD lines 995, 4939, 5085, 5120). Decided under owner delegation,
-- 6 Nov 2026 (docs/03 I-88).
--
-- 1. settlement_policy: the company's dated full-and-final settings, drafted by one person and activated by another (as the payroll
--    valuation policy, 0205): which pay components stand for Basic and DA, the components a calculated encashment, notice recovery or
--    gratuity is paid or recovered on, the daily-rate basis and divisor of encashment and of notice recovery, and which leave types are
--    encashable with their caps. Nothing here is a constant: every rate, divisor and cap is a value of a revision.
-- 2. statutory_rule_pack: the registry of statutory rule packs (DF05 "dated, versioned externally supplied rule packs"; F4). One row per
--    revision of a pack code (GRATUITY here; the tax, PF, ESIC and PT packs follow the same shape), with its parameters, statute and the
--    references of who obtained and validated it. DRAFT -> VALIDATED (by one person, recording the source and validation references)
--    -> ACTIVE (by another) -> RETIRED. Only an ACTIVE revision values anything. Every company starts with the Payment of Gratuity Act
--    pack as a DRAFT written by the system actor, inactive until two authorised people validate and activate it.
-- 3. settlement_notice_waiver: an exit's notice recovery waived, with a reason, under its own right, once per exit.
-- 4. settlement_calculation and settlement_calculation_item: the versioned snapshot a calculation takes and the items it proposes
--    (earnings due, encashment, notice recovery, loan recovery, arrears and adjustments, gratuity, statutory deductions), each with
--    its status; a blocking item stops approval. A recalculation is a new snapshot; earlier ones are kept.
-- 5. settlement: the calculation the draft carries (calculation_status CALCULATED), changed only while it is a draft.
-- 6. settlement_line: calculated lines (source CALCULATED) name their snapshot; other lines may carry the reason they were entered.
-- 7. leave_movement: ENCASHMENT, written when a paid settlement encashed a balance (BRD line 4939 "settlement consumes approved
--    balances once"), never below zero as at its date.
-- 8. Permissions: settlement.waive_notice.amount (confidential, ceiling only) and the statutory pack rights (operational).
-- Nothing stored is changed beyond widening checks, so this cannot stop an upgrade.

-- ---------------------------------------------------------------------------------------------------------------
-- 1. Settlement policy
-- ---------------------------------------------------------------------------------------------------------------
create table settlement_policy (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  revision                  integer not null check (revision > 0),
  effective_from            date not null,
  basic_component_id        uuid not null,
  da_component_id           uuid,
  encashment_component_id   uuid,
  encashment_rate_basis     text not null check (encashment_rate_basis in ('BASIC', 'BASIC_DA', 'GROSS')),
  encashment_divisor        smallint not null check (encashment_divisor between 1 and 31),
  notice_component_id       uuid,
  notice_rate_basis         text not null check (notice_rate_basis in ('BASIC', 'BASIC_DA', 'GROSS')),
  notice_divisor            smallint not null check (notice_divisor between 1 and 31),
  gratuity_component_id     uuid,
  state                     text not null check (state in ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'CANCELLED')),
  activated_by              uuid references user_account (id) on delete restrict,
  activated_at              timestamptz,
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, revision),
  foreign key (company_id, basic_component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, da_component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, encashment_component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, notice_component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, gratuity_component_id) references pay_component (company_id, id) on delete restrict,
  check (da_component_id is distinct from basic_component_id),
  check (state in ('DRAFT', 'CANCELLED') or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by)
);
create unique index settlement_policy_one_active_start on settlement_policy (company_id, effective_from) where (state = 'ACTIVE');
create index settlement_policy_basic_idx on settlement_policy (company_id, basic_component_id);
create index settlement_policy_da_idx on settlement_policy (company_id, da_component_id) where (da_component_id is not null);
create index settlement_policy_encashment_idx on settlement_policy (company_id, encashment_component_id) where (encashment_component_id is not null);
create index settlement_policy_notice_idx on settlement_policy (company_id, notice_component_id) where (notice_component_id is not null);
create index settlement_policy_gratuity_idx on settlement_policy (company_id, gratuity_component_id) where (gratuity_component_id is not null);

-- Encashable leave types of a revision, each with the most units a settlement encashes.
create table settlement_policy_encashable (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  policy_id      uuid not null,
  leave_type_id  uuid not null,
  max_units      numeric(12, 4) not null check (max_units > 0 and max_units <= 3650),
  created_at     timestamptz not null default now(),
  created_by     uuid references user_account (id) on delete restrict,
  unique (company_id, policy_id, leave_type_id),
  foreign key (company_id, policy_id) references settlement_policy (company_id, id) on delete restrict,
  foreign key (company_id, leave_type_id) references leave_type (company_id, id) on delete restrict
);
create index settlement_policy_encashable_type_idx on settlement_policy_encashable (company_id, leave_type_id);

create function hrms_settlement_policy_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a settlement policy starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from settlement_policy where company_id = new.company_id), 0) + 1 then
      raise exception 'settlement policy revisions are consecutive' using errcode = '23514';
    end if;
    -- The components follow their purpose: Basic, DA, encashment and gratuity are earnings; a notice recovery is a deduction.
    if exists (select 1 from pay_component c where c.company_id = new.company_id
                 and ((c.id in (new.basic_component_id, new.da_component_id, new.encashment_component_id, new.gratuity_component_id) and c.component_kind <> 'EARNING')
                      or (c.id = new.notice_component_id and c.component_kind <> 'DEDUCTION'))) then
      raise exception 'a settlement policy component is of the wrong kind' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.revision, new.effective_from, new.basic_component_id, new.da_component_id, new.encashment_component_id, new.encashment_rate_basis,
      new.encashment_divisor, new.notice_component_id, new.notice_rate_basis, new.notice_divisor, new.gratuity_component_id)
     is distinct from
     (old.revision, old.effective_from, old.basic_component_id, old.da_component_id, old.encashment_component_id, old.encashment_rate_basis,
      old.encashment_divisor, old.notice_component_id, old.notice_rate_basis, old.notice_divisor, old.gratuity_component_id) then
    raise exception 'a settlement policy revision is fixed once created' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.activated_by, new.activated_at) is distinct from (old.activated_by, old.activated_at) then
    raise exception 'the activation of a settlement policy is final' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state = 'SUPERSEDED')) then
    raise exception 'settlement policy state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settlement_policy_guard before insert or update on settlement_policy for each row execute function hrms_settlement_policy_guard();
create trigger settlement_policy_touch before update on settlement_policy for each row execute function hrms_touch();
create trigger settlement_policy_no_delete before delete on settlement_policy for each row execute function hrms_no_delete();

-- The encashable types belong to the draft they were written with.
create function hrms_settlement_policy_encashable_guard() returns trigger language plpgsql as $$
begin
  if (select state from settlement_policy where company_id = new.company_id and id = new.policy_id) is distinct from 'DRAFT' then
    raise exception 'the encashable leave types of a settlement policy are fixed with its draft' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settlement_policy_encashable_guard before insert on settlement_policy_encashable for each row execute function hrms_settlement_policy_encashable_guard();
create trigger settlement_policy_encashable_append_only before update or delete on settlement_policy_encashable for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- 2. Statutory rule pack registry
-- ---------------------------------------------------------------------------------------------------------------

-- The parameters a GRATUITY revision must state (Payment of Gratuity Act, 1972, s.4): the days' wages per counted year and the
-- divisor of a month's wages, the continuous service needed and the separation types that need none, the part-year (in months) beyond
-- which a final part-year counts as a year, and the ceiling. Numbers only, in range; the values themselves are the pack's.
create function hrms_gratuity_pack_parameters_ok(p jsonb) returns boolean language sql immutable as $$
  select jsonb_typeof(p) = 'object'
     and (select count(*) from jsonb_object_keys(p)) = 6
     and jsonb_typeof(p -> 'wageDays') = 'number' and (p ->> 'wageDays')::numeric > 0 and (p ->> 'wageDays')::numeric <= 31
     and jsonb_typeof(p -> 'wageDivisor') = 'number' and (p ->> 'wageDivisor')::numeric >= 1 and (p ->> 'wageDivisor')::numeric <= 31
     and jsonb_typeof(p -> 'minimumServiceYears') = 'number' and (p ->> 'minimumServiceYears')::numeric >= 0 and (p ->> 'minimumServiceYears')::numeric <= 50
     and jsonb_typeof(p -> 'partYearMonthsOver') = 'number' and (p ->> 'partYearMonthsOver')::numeric >= 0 and (p ->> 'partYearMonthsOver')::numeric <= 11
     and jsonb_typeof(p -> 'ceilingAmount') = 'string' and (p ->> 'ceilingAmount') ~ '^\d{1,15}(\.\d{1,4})?$'
     and jsonb_typeof(p -> 'exemptSeparationTypes') = 'array'
$$;

create table statutory_rule_pack (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  -- The pack code a payroll RULE_PACK head names (0043 rule_pack_code has the same form).
  code                  text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  revision              integer not null check (revision > 0),
  effective_from        date not null,
  currency_code         text not null check (currency_code ~ '^[A-Z]{3}$'),
  parameters            jsonb not null check (jsonb_typeof(parameters) = 'object'),
  -- The law and notification the values come from, as the pack states it.
  statute_reference     text not null check (btrim(statute_reference) <> '' and length(statute_reference) <= 1000),
  -- F4 "obtained and validated for actual jurisdiction/period": recorded by the validating person.
  source_reference      text check (source_reference is null or (btrim(source_reference) <> '' and length(source_reference) <= 500)),
  validation_reference  text check (validation_reference is null or (btrim(validation_reference) <> '' and length(validation_reference) <= 500)),
  state                 text not null check (state in ('DRAFT', 'VALIDATED', 'ACTIVE', 'RETIRED')),
  validated_by          uuid references user_account (id) on delete restrict,
  validated_at          timestamptz,
  activated_by          uuid references user_account (id) on delete restrict,
  activated_at          timestamptz,
  created_at            timestamptz not null default now(),
  created_by            uuid not null references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code, revision),
  check (code <> 'GRATUITY' or hrms_gratuity_pack_parameters_ok(parameters)),
  check ((state = 'DRAFT') = (validated_by is null)),
  check ((validated_by is null) = (validated_at is null) and (validated_by is null) = (source_reference is null) and (validated_by is null) = (validation_reference is null)),
  check ((state in ('ACTIVE', 'RETIRED')) = (activated_by is not null)),
  check ((activated_by is null) = (activated_at is null)),
  -- Two people: whoever validated a revision (or wrote it) never activates it.
  check (activated_by is null or (activated_by <> validated_by and activated_by <> created_by))
);
-- One active revision of a code starts on a given date; the latest active one on or before a date is in effect.
create unique index statutory_rule_pack_one_active_start on statutory_rule_pack (company_id, code, effective_from) where (state = 'ACTIVE');

create function hrms_statutory_rule_pack_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a statutory rule pack starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from statutory_rule_pack where company_id = new.company_id and code = new.code), 0) + 1 then
      raise exception 'statutory rule pack revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.code, new.revision, new.effective_from, new.currency_code, new.parameters, new.statute_reference)
     is distinct from (old.code, old.revision, old.effective_from, old.currency_code, old.parameters, old.statute_reference) then
    raise exception 'a statutory rule pack revision is fixed once created; write a new revision' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.validated_by, new.validated_at, new.source_reference, new.validation_reference)
     is distinct from (old.validated_by, old.validated_at, old.source_reference, old.validation_reference) then
    raise exception 'the validation of a statutory rule pack is final' using errcode = '23514';
  end if;
  if old.state in ('ACTIVE', 'RETIRED') and (new.activated_by, new.activated_at) is distinct from (old.activated_by, old.activated_at) then
    raise exception 'the activation of a statutory rule pack is final' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'VALIDATED') or (old.state = 'VALIDATED' and new.state = 'ACTIVE')
                                     or (old.state = 'ACTIVE' and new.state = 'RETIRED')) then
    raise exception 'statutory rule pack state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger statutory_rule_pack_guard before insert or update on statutory_rule_pack for each row execute function hrms_statutory_rule_pack_guard();
create trigger statutory_rule_pack_touch before update on statutory_rule_pack for each row execute function hrms_touch();
create trigger statutory_rule_pack_no_delete before delete on statutory_rule_pack for each row execute function hrms_no_delete();

-- Every company starts with the gratuity pack as a draft by the system actor: 15 days' wages per counted year at 26 working days a
-- month, five years of continuous service except on death or disablement, a final part-year of more than six months counted as a
-- year, and the Rs 20,00,000 ceiling. It values nothing until two authorised people validate and activate it; provisioning gives a
-- new company the same (modules/statutory/rule-packs.ts ensureStatutoryPacks).
insert into statutory_rule_pack (company_id, code, revision, effective_from, currency_code, parameters, statute_reference, state, created_by, updated_by)
select c.id, 'GRATUITY', 1, '2018-03-29', 'INR',
       '{"wageDays": 15, "wageDivisor": 26, "minimumServiceYears": 5, "partYearMonthsOver": 6, "ceilingAmount": "2000000.00", "exemptSeparationTypes": ["DEATH", "DISABLEMENT"]}'::jsonb,
       'Payment of Gratuity Act, 1972, s.4(1) to (3); ceiling under s.4(3) notified by S.O. 1420(E) of 29 March 2018. Validate against the law in force for the period (including the Code on Social Security, 2020) before activation.',
       'DRAFT', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'
  from company c
 where not exists (select 1 from statutory_rule_pack p where p.company_id = c.id and p.code = 'GRATUITY');

-- ---------------------------------------------------------------------------------------------------------------
-- 3. Notice recovery waiver
-- ---------------------------------------------------------------------------------------------------------------
create table settlement_notice_waiver (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  exit_case_id          uuid not null,
  employee_id           uuid not null,
  reason                text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  waived_by             uuid not null references user_account (id) on delete restrict,
  waived_assignment_id  uuid not null,
  waived_at             timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, exit_case_id),
  foreign key (company_id, exit_case_id, employee_id) references exit_case (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, waived_assignment_id) references role_assignment (company_id, id) on delete restrict
);
create index settlement_notice_waiver_employee_idx on settlement_notice_waiver (company_id, employee_id);
create index settlement_notice_waiver_assignment_idx on settlement_notice_waiver (company_id, waived_assignment_id);
create trigger settlement_notice_waiver_append_only before update or delete on settlement_notice_waiver for each row execute function hrms_append_only();

-- The waiver is someone else's decision: never the employee's own (C4).
create function hrms_settlement_notice_waiver_guard() returns trigger language plpgsql as $$
begin
  if hrms_is_own_employee(new.company_id, new.waived_by, new.employee_id) then
    raise exception 'nobody waives their own notice recovery' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settlement_notice_waiver_guard before insert on settlement_notice_waiver for each row execute function hrms_settlement_notice_waiver_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- 4. Calculation snapshots and items
-- ---------------------------------------------------------------------------------------------------------------
create table settlement_calculation (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  settlement_id             uuid not null,
  employee_id               uuid not null,
  sequence                  integer not null check (sequence > 0),
  calculated_at             timestamptz not null default now(),
  calculated_by             uuid not null references user_account (id) on delete restrict,
  calculated_assignment_id  uuid not null,
  last_working_date         date not null,
  period_start              date not null,
  period_end                date not null,
  currency_code             text not null check (currency_code ~ '^[A-Z]{3}$'),
  currency_minor_unit       smallint not null check (currency_minor_unit between 0 and 4),
  policy_id                 uuid,
  gratuity_pack_id          uuid,
  valuation_policy_id       uuid,
  paid_day_policy_id        uuid,
  -- The facts the items were derived from (employee dates, notice, salary components, balances, loans, cases, runs): confidential like
  -- the lines, read under the settlement amount group only.
  inputs                    jsonb not null check (jsonb_typeof(inputs) = 'object'),
  item_count                integer not null check (item_count >= 0),
  blocking_count            integer not null check (blocking_count >= 0),
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, settlement_id, id),
  unique (company_id, settlement_id, sequence),
  foreign key (company_id, settlement_id, employee_id) references settlement (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, calculated_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, policy_id) references settlement_policy (company_id, id) on delete restrict,
  foreign key (company_id, gratuity_pack_id) references statutory_rule_pack (company_id, id) on delete restrict,
  foreign key (company_id, valuation_policy_id) references payroll_valuation_policy (company_id, id) on delete restrict,
  foreign key (company_id, paid_day_policy_id) references payroll_paid_day_policy (company_id, id) on delete restrict,
  check (period_start <= last_working_date and last_working_date <= period_end),
  check (blocking_count <= item_count)
);
create index settlement_calculation_employee_idx on settlement_calculation (company_id, employee_id);
create index settlement_calculation_assignment_idx on settlement_calculation (company_id, calculated_assignment_id);
create index settlement_calculation_policy_idx on settlement_calculation (company_id, policy_id) where (policy_id is not null);
create index settlement_calculation_pack_idx on settlement_calculation (company_id, gratuity_pack_id) where (gratuity_pack_id is not null);
create index settlement_calculation_valuation_idx on settlement_calculation (company_id, valuation_policy_id) where (valuation_policy_id is not null);
create index settlement_calculation_paid_day_idx on settlement_calculation (company_id, paid_day_policy_id) where (paid_day_policy_id is not null);

create table settlement_calculation_item (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  calculation_id    uuid not null,
  employee_id       uuid not null,
  position          integer not null check (position > 0),
  item_kind         text not null check (item_kind in ('EARNINGS_DUE', 'LEAVE_ENCASHMENT', 'NOTICE_RECOVERY', 'LOAN_RECOVERY', 'ARREARS', 'ADJUSTMENT',
                                                        'GRATUITY', 'STATUTORY_DEDUCTION')),
  status            text not null check (status in (
                      -- A value.
                      'CALCULATED',
                      -- Nothing to pay or recover, and why.
                      'ALREADY_PAID', 'NOT_APPLICABLE', 'NOT_ELIGIBLE', 'WAIVED', 'NOT_INCLUDED',
                      -- Blocking: approval is refused while the frozen calculation holds one.
                      'RULE_PACK_NOT_CONFIGURED', 'POLICY_NOT_CONFIGURED', 'VALUATION_POLICY_NOT_CONFIGURED', 'RECOVERY_POLICY_NOT_CONFIGURED',
                      'NOTICE_PERIOD_NOT_RECORDED', 'NO_SALARY_ARRANGEMENT', 'ARRANGEMENT_GAP', 'CURRENCY_MISMATCH', 'HEAD_NOT_CONFIGURED',
                      'COMPONENT_BASIS_NOT_MONTHLY', 'COMPONENT_HEAD_NOT_FIXED', 'RATE_BASIS_MISSING', 'LEAVE_DECISIONS_PENDING',
                      'LOAN_SETTLEMENT_PENDING')),
  blocking          boolean not null,
  component_id      uuid,
  -- Signed as a line is: earnings zero or more, deductions zero or less; present only for a calculated value.
  amount            numeric(19, 4),
  -- How the value was reached: quantities, rates, divisors and the references read (confidential, like the amount).
  basis             jsonb not null check (jsonb_typeof(basis) = 'object'),
  leave_type_id     uuid,
  loan_id           uuid,
  arrears_case_id   uuid,
  adjustment_id     uuid,
  head_revision_id  uuid,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, calculation_id, position),
  foreign key (company_id, calculation_id) references settlement_calculation (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, leave_type_id) references leave_type (company_id, id) on delete restrict,
  foreign key (company_id, loan_id, employee_id) references payroll_loan (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, arrears_case_id, employee_id) references payroll_arrears_case (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, adjustment_id, employee_id) references payroll_adjustment (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, head_revision_id) references payroll_head_revision (company_id, id) on delete restrict,
  check (blocking = (status not in ('CALCULATED', 'ALREADY_PAID', 'NOT_APPLICABLE', 'NOT_ELIGIBLE', 'WAIVED', 'NOT_INCLUDED'))),
  check ((status = 'CALCULATED') = (amount is not null)),
  check (amount is null or component_id is not null),
  check (amount is null or amount between -999999999999999.9999 and 999999999999999.9999)
);
create index settlement_calculation_item_employee_idx on settlement_calculation_item (company_id, employee_id);
create index settlement_calculation_item_component_idx on settlement_calculation_item (company_id, component_id) where (component_id is not null);
create index settlement_calculation_item_leave_type_idx on settlement_calculation_item (company_id, leave_type_id) where (leave_type_id is not null);
create index settlement_calculation_item_loan_idx on settlement_calculation_item (company_id, loan_id) where (loan_id is not null);
-- FR-035, FR-100 (I-79): payroll looks up whether a live or paid settlement holds a case (payroll/calculate.ts).
create index settlement_calculation_item_arrears_idx on settlement_calculation_item (company_id, arrears_case_id) where (arrears_case_id is not null);
create index settlement_calculation_item_adjustment_idx on settlement_calculation_item (company_id, adjustment_id) where (adjustment_id is not null);
create index settlement_calculation_item_head_idx on settlement_calculation_item (company_id, head_revision_id) where (head_revision_id is not null);
create unique index settlement_calculation_item_one_arrears on settlement_calculation_item (company_id, calculation_id, arrears_case_id) where (arrears_case_id is not null);
create unique index settlement_calculation_item_one_adjustment on settlement_calculation_item (company_id, calculation_id, adjustment_id) where (adjustment_id is not null);

-- A snapshot is taken of a draft, in order, and never changes; its items are written with it.
create function hrms_settlement_calculation_guard() returns trigger language plpgsql as $$
declare
  s record;
begin
  select state, employee_id into s from settlement where company_id = new.company_id and id = new.settlement_id;
  if s.state is distinct from 'DRAFT' then
    raise exception 'a settlement is calculated while it is a draft' using errcode = '23514';
  end if;
  if new.sequence <> coalesce((select max(sequence) from settlement_calculation where company_id = new.company_id and settlement_id = new.settlement_id), 0) + 1 then
    raise exception 'the calculations of a settlement are consecutive' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settlement_calculation_guard before insert on settlement_calculation for each row execute function hrms_settlement_calculation_guard();
create trigger settlement_calculation_append_only before update or delete on settlement_calculation for each row execute function hrms_append_only();

create function hrms_settlement_calculation_item_guard() returns trigger language plpgsql as $$
declare
  c record;
begin
  select k.employee_id, s.state, s.calculation_id into c
    from settlement_calculation k join settlement s on s.company_id = k.company_id and s.id = k.settlement_id
   where k.company_id = new.company_id and k.id = new.calculation_id;
  if c.state is distinct from 'DRAFT' or c.employee_id is distinct from new.employee_id then
    raise exception 'calculation items are written with their snapshot, for its employee' using errcode = '23514';
  end if;
  -- A snapshot's items are written before the draft carries it; a carried snapshot is fixed.
  if c.calculation_id is not distinct from new.calculation_id then
    raise exception 'the items of the calculation a settlement carries are fixed' using errcode = '23514';
  end if;
  if new.amount is not null and exists (select 1 from pay_component pc where pc.company_id = new.company_id and pc.id = new.component_id
                                          and ((pc.component_kind = 'EARNING' and new.amount < 0) or (pc.component_kind = 'DEDUCTION' and new.amount > 0))) then
    raise exception 'the amount sign must follow the component kind' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger settlement_calculation_item_guard before insert on settlement_calculation_item for each row execute function hrms_settlement_calculation_item_guard();
create trigger settlement_calculation_item_append_only before update or delete on settlement_calculation_item for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- 5. The calculation a settlement carries
-- ---------------------------------------------------------------------------------------------------------------
alter table settlement add column calculation_id uuid;
alter table settlement drop constraint settlement_calculation_status_check;
alter table settlement add constraint settlement_calculation_status_check check (calculation_status in ('NOT_CONFIGURED', 'CALCULATED'));
alter table settlement add constraint settlement_calculation_carried check ((calculation_status = 'CALCULATED') = (calculation_id is not null));
alter table settlement add constraint settlement_calculation_fk foreign key (company_id, id, calculation_id) references settlement_calculation (company_id, settlement_id, id) on delete restrict;
create index settlement_calculation_id_idx on settlement (company_id, calculation_id) where (calculation_id is not null);

create or replace function hrms_settlement_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' or new.net_amount <> 0 or new.calculation_id is not null then
      raise exception 'a settlement revision starts as an empty draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from settlement where company_id = new.company_id and exit_case_id = new.exit_case_id), 0) + 1 then
      raise exception 'settlement revisions of an exit are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.exit_case_id, new.employee_id, new.revision, new.transaction_id, new.supersedes_settlement_id, new.prepared_by, new.currency_code)
     is distinct from (old.exit_case_id, old.employee_id, old.revision, old.transaction_id, old.supersedes_settlement_id, old.prepared_by, old.currency_code) then
    raise exception 'settlement identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and new.net_amount is distinct from old.net_amount then
    raise exception 'a submitted settlement revision is frozen' using errcode = '23514';
  end if;
  -- FR-052 (I-88): the calculation a revision carries changes only while it is a draft, and is frozen with it on submission.
  if (new.calculation_id, new.calculation_status) is distinct from (old.calculation_id, old.calculation_status) then
    if old.state <> 'DRAFT' or new.state <> 'DRAFT' then
      raise exception 'the calculation of a submitted settlement revision is frozen' using errcode = '23514';
    end if;
    if exists (select 1 from settlement_line l where l.company_id = new.company_id and l.settlement_id = new.id and l.source = 'CALCULATED'
                 and l.calculation_id is distinct from new.calculation_id) then
      raise exception 'calculated lines of another calculation remain' using errcode = '23514';
    end if;
  end if;
  -- A blocking item (a missing rule pack, policy or record) never reaches approval (BRD line 5120; the service names each one first).
  if new.state = 'APPROVED' and old.state <> 'APPROVED' and new.calculation_id is not null
     and exists (select 1 from settlement_calculation_item i where i.company_id = new.company_id and i.calculation_id = new.calculation_id and i.blocking) then
    raise exception 'a settlement whose calculation has a blocking item is not approved' using errcode = '23514';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 6. Calculated and entered lines
-- ---------------------------------------------------------------------------------------------------------------
alter table settlement_line add column calculation_id uuid;
alter table settlement_line add column reason text check (reason is null or (btrim(reason) <> '' and length(reason) <= 500));
alter table settlement_line drop constraint settlement_line_source_check;
alter table settlement_line add constraint settlement_line_source_check check (source in ('ENTERED', 'UPLOADED', 'COPIED', 'CALCULATED'));
alter table settlement_line add constraint settlement_line_calculated check ((source = 'CALCULATED') = (calculation_id is not null) and (source <> 'CALCULATED' or reason is null));
alter table settlement_line add constraint settlement_line_calculation_fk foreign key (company_id, settlement_id, calculation_id) references settlement_calculation (company_id, settlement_id, id) on delete restrict;
create index settlement_line_calculation_idx on settlement_line (company_id, calculation_id) where (calculation_id is not null);

create or replace function hrms_settlement_line_guard() returns trigger language plpgsql as $$
declare
  s_state text;
  s_exit uuid;
  s_calculation uuid;
  c_kind text;
  c_active boolean;
  notice integer;
begin
  select state, exit_case_id, calculation_id into s_state, s_exit, s_calculation from settlement
   where company_id = coalesce(new.company_id, old.company_id) and id = coalesce(new.settlement_id, old.settlement_id);
  if s_state is distinct from 'DRAFT' then
    raise exception 'lines of a submitted settlement revision are frozen' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (new.settlement_id, new.component_id, new.source, new.calculation_id) is distinct from (old.settlement_id, old.component_id, old.source, old.calculation_id) then
    raise exception 'a settlement line identity is immutable' using errcode = '23514';
  end if;
  -- FR-052 (I-88): a calculated line belongs to the calculation the draft carries.
  if new.source = 'CALCULATED' and new.calculation_id is distinct from s_calculation then
    raise exception 'a calculated line belongs to the calculation the settlement carries' using errcode = '23514';
  end if;
  select component_kind, active into c_kind, c_active from pay_component where company_id = new.company_id and id = new.component_id;
  if tg_op = 'INSERT' and c_active is not true then
    raise exception 'the pay component is not active' using errcode = '23514';
  end if;
  -- Sign convention (owner approval pending, DB080): earnings >= 0, deductions <= 0, net = sum of lines.
  if (c_kind = 'EARNING' and new.amount < 0) or (c_kind = 'DEDUCTION' and new.amount > 0) then
    raise exception 'the amount sign must follow the component kind' using errcode = '23514';
  end if;
  if new.line_kind = 'NOTICE_ADJUSTMENT' then
    select contractual_notice_days into notice from exit_case where company_id = new.company_id and id = s_exit;
    if notice is null then
      raise exception 'a notice adjustment needs the recorded contractual notice period' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------------------------
-- 7. Leave encashed by a paid settlement
-- ---------------------------------------------------------------------------------------------------------------
do $$
declare
  c record;
  dropped integer := 0;
begin
  for c in select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'leave_movement'::regclass and contype = 'c' loop
    if c.conname = 'leave_movement_movement_kind_check' or (c.def like '%EXPIRY%' and c.def like '%units%') then
      execute format('alter table leave_movement drop constraint %I', c.conname);
      dropped := dropped + 1;
    end if;
  end loop;
  if dropped <> 2 then
    raise exception 'expected the leave movement kind and sign checks, found %', dropped;
  end if;
end $$;
alter table leave_movement add constraint leave_movement_movement_kind_check check (movement_kind in
  ('OPENING', 'ACCRUAL', 'ADJUSTMENT', 'EXPIRY', 'RESERVATION', 'RESERVATION_RELEASE', 'CONSUMPTION', 'REVERSAL', 'ENCASHMENT'));
alter table leave_movement add constraint leave_movement_units_sign check (
  (movement_kind in ('OPENING', 'ACCRUAL', 'REVERSAL', 'RESERVATION_RELEASE') and units > 0)
  or (movement_kind in ('EXPIRY', 'RESERVATION', 'CONSUMPTION', 'ENCASHMENT') and units < 0)
  or movement_kind = 'ADJUSTMENT');
alter table leave_movement add constraint leave_movement_encashment_reason check (movement_kind <> 'ENCASHMENT' or (reason is not null and btrim(reason) <> ''));

-- DF05 "no negative paid balance": an encashment takes away only what the balance held as at its date (the last working date).
create function hrms_leave_encashment_not_negative() returns trigger language plpgsql as $$
begin
  if (select sum(units) from leave_movement where company_id = new.company_id and employee_id = new.employee_id and leave_type_id = new.leave_type_id
         and effective_date <= new.effective_date) < 0 then
    raise exception 'an encashment cannot take a leave balance below zero' using errcode = '23514';
  end if;
  return null;
end $$;
create trigger leave_movement_encashment_not_negative after insert on leave_movement
  for each row when (new.movement_kind = 'ENCASHMENT')
  execute function hrms_leave_encashment_not_negative();

-- ---------------------------------------------------------------------------------------------------------------
-- 8. Permissions
-- ---------------------------------------------------------------------------------------------------------------
-- Waiving an exit's notice recovery is its own confidential right (amount group), an HR Administrator ceiling that is nobody's default
-- duty. The statutory pack rights are operational configuration: reading, validating (recording the source and validation references)
-- and activating, the last two ceiling-only and held by different people for one revision. Existing companies receive the ceilings
-- and the operational classification when they are next provisioned (modules/lifecycle/registration.ts).
insert into permission (resource, action, field_group, own_ess) values
  ('settlement',     'waive_notice', 'amount',      false),
  ('statutory_pack', 'read',         'operational', false),
  ('statutory_pack', 'validate',     'operational', false),
  ('statutory_pack', 'activate',     'operational', false);
