-- 0043 Payroll calculation, freeze and holds (FR-028 to FR-033; FR-037 as overridden by FR-099 and H2; FR-101;
-- DB033 to DB039 reconciled with 0011; DB110; DF05; H2; H4; BR-011; BR-012; BR-047; BR-049; BR-050; BR-051; CI25;
-- CI27 hold part; ZT36; ZT38 hold part).
--
-- Masters. pay_component, salary_arrangement and salary_component (0011) stay the one salary master; they are
-- extended here, never duplicated: payroll_head_revision classifies a pay component for payroll (type, calculation
-- basis, rounding, recorded tax treatment) in effective-dated revisions that never change once created, and salary
-- components become immutable like their arrangement. There is no formula language. A head is FIXED (the employee's
-- monthly salary component, prorated per DF05), INPUT (approved monthly inputs only) or RULE_PACK (a statutory, tax
-- or contribution rule pack that the company must supply and activate; none exists, so such a head is reported
-- RULE_PACK_NOT_CONFIGURED and blocks the employees it applies to).
--
-- Calendar. Each company supplies its own payroll calendar and periods (service period, input cutoff, payment date,
-- financial year); nothing is defaulted. DF05 divides by the calendar days of "that month", so a service period is
-- one whole calendar month.
--
-- Runs (H2). DRAFT -> CALCULATED -> IN_REVIEW -> APPROVED -> PROCESSED_LOCKED. A revision is calculated exactly once
-- from a snapshot: the rules (payroll_run_head: the head revision of every component, and the paid-day policy) are
-- fixed when the calculation starts, and each employee's facts (eligible interval, arrangement segments, loss-of-pay
-- days, salary components, approved inputs, salary stop) are copied into the record's snapshot rows; lines and totals
-- are a pure function of that snapshot. CP-08: calculation and processing run in bounded chunks of employees, each
-- chunk its own transaction recorded in payroll_run_chunk, so that no transaction spans a whole company; the run's
-- state changes (CALCULATED, PROCESSED_LOCKED) commit only after every chunk has, together with their audit. A return
-- (validation, review, approval) closes the revision as RETURNED and opens the next revision as a new draft;
-- CANCELLED needs authority and a reason and is possible only before processing starts. Processing freezes the bank
-- reference of every record; once it has started the revision can only be completed, and nothing of a processed run
-- can change afterwards (no unlock): a later correction is a linked adjustment in a later run (payroll-outputs stage,
-- DB111, which references payroll_record and payroll_line through the keys declared below).
--
-- Holds (DB110, H2). PROPOSED -> APPROVED_ACTIVE -> RELEASED or EXPIRED_REVIEW; REJECTED never blocks. Bank
-- instruction problems are automatic payment safety blocks; contractual and legal/disciplinary holds need an
-- activated, validated criterion (none exists by default). A hold never changes the payroll record it holds.

-- ---------------------------------------------------------------------------------------------------------------
-- DB033 extension: payroll head revisions
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_head_revision (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  component_id            uuid not null,
  revision                integer not null check (revision > 0),
  effective_from          date not null,
  -- false: the head is discontinued from effective_from (no definition applies from that date on).
  in_use                  boolean not null,
  head_type               text check (head_type in ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT')),
  calculation_basis       text check (calculation_basis in ('FIXED', 'INPUT', 'RULE_PACK')),
  -- DF05: currency minor unit, half-up, at component output; the only rounding there is.
  rounding_rule           text check (rounding_rule in ('HALF_UP_MINOR_UNIT')),
  -- Recorded as the company declares it; never computed here.
  tax_treatment_category  text not null default 'PAYROLL_TAX_TREATMENT' check (tax_treatment_category = 'PAYROLL_TAX_TREATMENT'),
  tax_treatment_id        uuid,
  rule_pack_code          text check (rule_pack_code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  display_sequence        integer check (display_sequence between 1 and 9999),
  state                   text not null check (state in ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'CANCELLED')),
  activated_by            uuid references user_account (id) on delete restrict,
  activated_at            timestamptz,
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, component_id),
  unique (company_id, component_id, revision),
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, tax_treatment_category, tax_treatment_id) references reference_value (company_id, category, id) on delete restrict,
  check (not in_use or (head_type is not null and calculation_basis is not null and rounding_rule is not null
                        and tax_treatment_id is not null and display_sequence is not null)),
  check (in_use or (head_type is null and calculation_basis is null and rounding_rule is null and tax_treatment_id is null
                    and rule_pack_code is null and display_sequence is null)),
  check (not in_use or ((calculation_basis = 'RULE_PACK') = (rule_pack_code is not null))),
  check (state in ('DRAFT', 'CANCELLED') or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by)
);
-- One active revision starts on a given date; the latest active revision on or before a date is the one in effect.
create unique index payroll_head_one_active_start on payroll_head_revision (company_id, component_id, effective_from) where (state = 'ACTIVE');

-- A RULE_PACK head names the heads its pack is applied to (the base); fixed with the draft (no cycle, checked on activation).
create table payroll_head_base (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  head_revision_id   uuid not null,
  base_component_id  uuid not null,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  unique (company_id, head_revision_id, base_component_id),
  foreign key (company_id, head_revision_id) references payroll_head_revision (company_id, id) on delete restrict,
  foreign key (company_id, base_component_id) references pay_component (company_id, id) on delete restrict
);

create function hrms_payroll_head_guard() returns trigger language plpgsql as $$
declare
  c_kind text;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a payroll head revision starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from payroll_head_revision where company_id = new.company_id and component_id = new.component_id), 0) + 1 then
      raise exception 'payroll head revisions are consecutive' using errcode = '23514';
    end if;
    -- pay_component keeps its two DB033 kinds; the payroll type refines them (an employer contribution is a cost).
    select component_kind into c_kind from pay_component where company_id = new.company_id and id = new.component_id;
    if new.in_use and ((new.head_type in ('EARNING', 'REIMBURSEMENT', 'EMPLOYER_CONTRIBUTION') and c_kind <> 'EARNING')
                       or (new.head_type = 'DEDUCTION' and c_kind <> 'DEDUCTION')) then
      raise exception 'the payroll head type does not match the pay component kind' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.component_id, new.revision, new.effective_from, new.in_use, new.head_type, new.calculation_basis, new.rounding_rule,
      new.tax_treatment_id, new.rule_pack_code, new.display_sequence)
     is distinct from
     (old.component_id, old.revision, old.effective_from, old.in_use, old.head_type, old.calculation_basis, old.rounding_rule,
      old.tax_treatment_id, old.rule_pack_code, old.display_sequence) then
    raise exception 'a payroll head revision is fixed once created; cancel the draft or create a new revision' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.activated_by, new.activated_at) is distinct from (old.activated_by, old.activated_at) then
    raise exception 'the activation of a payroll head revision is final' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state = 'SUPERSEDED')) then
    raise exception 'payroll head revision state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_head_revision_guard before insert or update on payroll_head_revision for each row execute function hrms_payroll_head_guard();

create function hrms_payroll_head_base_guard() returns trigger language plpgsql as $$
declare
  h payroll_head_revision%rowtype;
begin
  select * into h from payroll_head_revision where company_id = new.company_id and id = new.head_revision_id;
  if h.state is distinct from 'DRAFT' then
    raise exception 'the base of a payroll head is fixed with its draft' using errcode = '23514';
  end if;
  if h.calculation_basis is distinct from 'RULE_PACK' then
    raise exception 'only a rule-pack head has a base' using errcode = '23514';
  end if;
  if new.base_component_id = h.component_id then
    raise exception 'a payroll head cannot be its own base' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_head_base_guard before insert on payroll_head_base for each row execute function hrms_payroll_head_base_guard();
create trigger payroll_head_base_append_only before update or delete on payroll_head_base for each row execute function hrms_append_only();

-- DF05 rounding: half-up to the currency minor unit of an exact non-negative ratio (exact integer division; no
-- floating point and no intermediate rounding).
create function hrms_payroll_round_half_up(p_numerator numeric, p_denominator numeric, p_minor smallint) returns numeric
language plpgsql immutable strict as $$
declare
  scale numeric := round(power(10::numeric, p_minor::numeric));
begin
  if p_numerator < 0 or p_denominator <= 0 or p_minor < 0 or p_minor > 4 then
    raise exception 'payroll rounding needs a non-negative amount and a positive divisor' using errcode = '22003';
  end if;
  return (div(2 * p_numerator * scale + p_denominator, 2 * p_denominator) / scale)::numeric(19, 4);
end $$;

-- Salary components (0011) are immutable like their arrangement: a change is a new arrangement (DF08, BR-047).
create function hrms_salary_component_frozen() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'salary components are never deleted; create a new arrangement' using errcode = '23514';
  end if;
  if (new.salary_arrangement_id, new.component_id, new.amount, new.basis) is distinct from
     (old.salary_arrangement_id, old.component_id, old.amount, old.basis) then
    raise exception 'salary component values are immutable; create a new arrangement' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger salary_component_frozen before update or delete on salary_component for each row execute function hrms_salary_component_frozen();

-- ---------------------------------------------------------------------------------------------------------------
-- FR-030 payroll calendar and periods (company configuration; no default calendar, no hard-coded dates)
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_calendar (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  code                 text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name                 text not null check (btrim(name) <> '' and length(name) <= 200),
  currency_code        text not null check (currency_code ~ '^[A-Z]{3}$'),
  -- The currency's minor unit as the company states it (DF05 rounds to it); no currency table is assumed.
  currency_minor_unit  smallint not null check (currency_minor_unit between 0 and 4),
  state                text not null check (state in ('DRAFT', 'ACTIVE', 'RETIRED')),
  activated_by         uuid references user_account (id) on delete restrict,
  activated_at         timestamptz,
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code),
  check (state = 'DRAFT' or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by)
);

create function hrms_payroll_calendar_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a payroll calendar starts as a draft' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.code, new.currency_code, new.currency_minor_unit) is distinct from (old.code, old.currency_code, old.currency_minor_unit) then
    raise exception 'the code and currency of a payroll calendar are fixed' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.activated_by, new.activated_at) is distinct from (old.activated_by, old.activated_at) then
    raise exception 'the activation of a payroll calendar is final' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state = 'ACTIVE') or (old.state = 'ACTIVE' and new.state = 'RETIRED')) then
    raise exception 'payroll calendar state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_calendar_guard before insert or update on payroll_calendar for each row execute function hrms_payroll_calendar_guard();

create table payroll_period (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  calendar_id     uuid not null,
  period_code     text not null check (period_code ~ '^[A-Z0-9][A-Z0-9_-]{0,19}$'),
  financial_year  text not null check (financial_year ~ '^[A-Z0-9][A-Z0-9_/-]{0,19}$'),
  service_start   date not null,
  service_end     date not null,
  -- Company-local dates: the last day inputs for the period are accepted, and the payment date.
  input_cutoff    date not null,
  payment_date    date not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, calendar_id),
  unique (company_id, calendar_id, period_code),
  foreign key (company_id, calendar_id) references payroll_calendar (company_id, id) on delete restrict,
  -- DF05 divides a monthly component by the calendar days "in that month": a service period is a whole month.
  check (service_start = date_trunc('month', service_start)::date),
  check (service_end = (date_trunc('month', service_start) + interval '1 month' - interval '1 day')::date),
  check (input_cutoff <= payment_date),
  exclude using gist (company_id with =, calendar_id with =, daterange(service_start, service_end, '[]') with &&)
);

-- ---------------------------------------------------------------------------------------------------------------
-- FR-032 paid-day valuation policy (BR-049: attendance outcomes reduce pay only under an activated policy)
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_paid_day_policy (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  revision               integer not null check (revision > 0),
  effective_from         date not null,
  -- APPROVED_LEAVE_ONLY: only approved unpaid leave is loss of pay. REVIEWED_ATTENDANCE: reviewed ABSENT and
  -- HALF_DAY days not covered by approved leave also lose the part of a day the company states.
  attendance_basis       text not null check (attendance_basis in ('APPROVED_LEAVE_ONLY', 'REVIEWED_ATTENDANCE')),
  absent_unpaid_units    numeric(3, 2) check (absent_unpaid_units > 0 and absent_unpaid_units <= 1),
  half_day_unpaid_units  numeric(3, 2) check (half_day_unpaid_units >= 0 and half_day_unpaid_units <= 1),
  state                  text not null check (state in ('DRAFT', 'ACTIVE', 'SUPERSEDED', 'CANCELLED')),
  activated_by           uuid references user_account (id) on delete restrict,
  activated_at           timestamptz,
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, revision),
  check ((attendance_basis = 'REVIEWED_ATTENDANCE') = (absent_unpaid_units is not null and half_day_unpaid_units is not null)),
  check (attendance_basis = 'REVIEWED_ATTENDANCE' or (absent_unpaid_units is null and half_day_unpaid_units is null)),
  check (state in ('DRAFT', 'CANCELLED') or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by)
);
create unique index payroll_paid_day_one_active_start on payroll_paid_day_policy (company_id, effective_from) where (state = 'ACTIVE');

create function hrms_payroll_paid_day_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a paid-day policy starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from payroll_paid_day_policy where company_id = new.company_id), 0) + 1 then
      raise exception 'paid-day policy revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.revision, new.effective_from, new.attendance_basis, new.absent_unpaid_units, new.half_day_unpaid_units)
     is distinct from (old.revision, old.effective_from, old.attendance_basis, old.absent_unpaid_units, old.half_day_unpaid_units) then
    raise exception 'a paid-day policy revision is fixed once created' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.activated_by, new.activated_at) is distinct from (old.activated_by, old.activated_at) then
    raise exception 'the activation of a paid-day policy is final' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state = 'SUPERSEDED')) then
    raise exception 'paid-day policy state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_paid_day_policy_guard before insert or update on payroll_paid_day_policy for each row execute function hrms_payroll_paid_day_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- H2 hold criteria: contractual and legal/disciplinary holds are disabled until the company activates a validated
-- criterion (applicability, full/partial scope, evidence and maximum review interval). None exists by default.
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_hold_criterion (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  -- Codes that H2 says are never holds (missing timesheet, input discrepancy, separation) or that name the
  -- automatic bank safety block are reserved.
  code                  text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'
                                             and code not in ('MISSING_TIMESHEET', 'TIMESHEET', 'TIMESHEET_MISSING', 'INPUT_DISCREPANCY',
                                                              'SEPARATION', 'INACTIVITY', 'BANK_MISSING', 'BANK_INVALID', 'BANK_UNVERIFIED')),
  revision              integer not null check (revision > 0),
  category              text not null check (category in ('CONTRACTUAL', 'LEGAL_DISCIPLINARY')),
  applicability         text not null check (btrim(applicability) <> '' and length(applicability) <= 2000),
  scope_mode            text not null check (scope_mode in ('FULL_ONLY', 'FULL_OR_PARTIAL')),
  max_review_days       integer not null check (max_review_days between 1 and 366),
  evidence_reference    text not null check (btrim(evidence_reference) <> '' and length(evidence_reference) <= 500),
  validation_reference  text not null check (btrim(validation_reference) <> '' and length(validation_reference) <= 500),
  state                 text not null check (state in ('DRAFT', 'ACTIVE', 'RETIRED', 'CANCELLED')),
  activated_by          uuid references user_account (id) on delete restrict,
  activated_at          timestamptz,
  retired_by            uuid references user_account (id) on delete restrict,
  retired_at            timestamptz,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code, revision),
  check (state in ('DRAFT', 'CANCELLED') or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by),
  check ((state = 'RETIRED') = (retired_at is not null and retired_by is not null))
);
create unique index payroll_hold_criterion_one_active on payroll_hold_criterion (company_id, code) where (state = 'ACTIVE');

create function hrms_payroll_hold_criterion_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' then
      raise exception 'a hold criterion starts as a draft' using errcode = '23514';
    end if;
    if new.revision <> coalesce((select max(revision) from payroll_hold_criterion where company_id = new.company_id and code = new.code), 0) + 1 then
      raise exception 'hold criterion revisions are consecutive' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.code, new.revision, new.category, new.applicability, new.scope_mode, new.max_review_days, new.evidence_reference, new.validation_reference)
     is distinct from
     (old.code, old.revision, old.category, old.applicability, old.scope_mode, old.max_review_days, old.evidence_reference, old.validation_reference) then
    raise exception 'a hold criterion revision is fixed once created' using errcode = '23514';
  end if;
  if old.state <> 'DRAFT' and (new.activated_by, new.activated_at) is distinct from (old.activated_by, old.activated_at) then
    raise exception 'the activation of a hold criterion is final' using errcode = '23514';
  end if;
  if new.state <> old.state and not ((old.state = 'DRAFT' and new.state in ('ACTIVE', 'CANCELLED')) or (old.state = 'ACTIVE' and new.state = 'RETIRED')) then
    raise exception 'hold criterion state % cannot become %', old.state, new.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_hold_criterion_guard before insert or update on payroll_hold_criterion for each row execute function hrms_payroll_hold_criterion_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- FR-031 salary-stop instructions (typed root payroll_salary_stop). DF05: HOLD_DISBURSEMENT (the default reading of
-- a stop: calculation continues, payment excluded; under H2/BR-050 it needs an activated hold criterion) or
-- EXCLUDE_CALCULATION (an explicitly approved exceptional mode: the approver confirms the mode, recorded in
-- approved_mode). An approved stop is applied by processing (a HOLD_DISBURSEMENT stop becomes a hold). Evidence
-- documents are linked to the stop's transaction (transaction_evidence, released and verified documents only).
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_salary_stop (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company (id) on delete restrict,
  calendar_id         uuid not null,
  period_id           uuid not null,
  employee_id         uuid not null,
  transaction_kind    text not null default 'payroll_salary_stop' check (transaction_kind = 'payroll_salary_stop'),
  transaction_id      uuid not null,
  mode                text not null check (mode in ('HOLD_DISBURSEMENT', 'EXCLUDE_CALCULATION')),
  criterion_id        uuid,
  -- Private (confidential hold group); the employee is never shown it.
  reason              text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  release_criterion   text check (release_criterion is null or (btrim(release_criterion) <> '' and length(release_criterion) <= 1000)),
  evidence_reference  text not null check (btrim(evidence_reference) <> '' and length(evidence_reference) <= 500),
  -- A replayed proposal returns the stop it created (no second instruction).
  idempotency_key     text check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  state               text not null check (state in ('SUBMITTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'REVOKED', 'APPLIED')),
  proposed_by         uuid not null references user_account (id) on delete restrict,
  decided_at          timestamptz,
  decided_by          uuid references user_account (id) on delete restrict,
  approved_mode       text check (approved_mode in ('HOLD_DISBURSEMENT', 'EXCLUDE_CALCULATION')),
  revoked_by          uuid references user_account (id) on delete restrict,
  revoke_reason       text check (revoke_reason is null or (btrim(revoke_reason) <> '' and length(revoke_reason) <= 1000)),
  applied_record_id   uuid,
  closed_at           timestamptz,
  created_at          timestamptz not null default now(),
  created_by          uuid references user_account (id) on delete restrict,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references user_account (id) on delete restrict,
  version             integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  unique (company_id, idempotency_key),
  foreign key (company_id, period_id, calendar_id) references payroll_period (company_id, id, calendar_id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, criterion_id) references payroll_hold_criterion (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((mode = 'HOLD_DISBURSEMENT') = (criterion_id is not null)),
  check ((mode = 'HOLD_DISBURSEMENT') = (release_criterion is not null)),
  check ((state in ('APPROVED', 'REJECTED', 'REVOKED', 'APPLIED')) = (decided_at is not null and decided_by is not null)),
  check (decided_by is null or decided_by <> proposed_by),
  check ((approved_mode is not null) = (state in ('APPROVED', 'REVOKED', 'APPLIED'))),
  check (approved_mode is null or approved_mode = mode),
  check ((state = 'REVOKED') = (revoked_by is not null and revoke_reason is not null)),
  check (revoked_by is null or revoked_by <> proposed_by),
  check ((state = 'APPLIED') = (applied_record_id is not null)),
  check ((state in ('REJECTED', 'WITHDRAWN', 'REVOKED', 'APPLIED')) = (closed_at is not null))
);
-- One live stop per employee and period.
create unique index payroll_salary_stop_one_live on payroll_salary_stop (company_id, period_id, employee_id) where (state in ('SUBMITTED', 'APPROVED', 'APPLIED'));

create function hrms_payroll_salary_stop_guard() returns trigger language plpgsql as $$
begin
  if (new.calendar_id, new.period_id, new.employee_id, new.transaction_id, new.mode, new.criterion_id, new.reason, new.release_criterion,
      new.evidence_reference, new.idempotency_key, new.proposed_by)
     is distinct from
     (old.calendar_id, old.period_id, old.employee_id, old.transaction_id, old.mode, old.criterion_id, old.reason, old.release_criterion,
      old.evidence_reference, old.idempotency_key, old.proposed_by) then
    raise exception 'a submitted salary stop is immutable' using errcode = '23514';
  end if;
  if old.decided_at is not null and (new.decided_at, new.decided_by, new.approved_mode) is distinct from (old.decided_at, old.decided_by, old.approved_mode) then
    raise exception 'the decision on a salary stop is final' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_salary_stop_guard before update on payroll_salary_stop for each row execute function hrms_payroll_salary_stop_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB039 employee_financial_input: payroll inputs in batches (typed root payroll_input_batch). Each line carries its
-- period, employee, source and approval state; only approved lines feed a calculation; a source reference is unique
-- per company and period among live lines, a live file is accepted once per period, and a replayed request (same
-- idempotency key) returns its batch, so a repeated entry or upload never duplicates a payment.
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_input_batch (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  calendar_id       uuid not null,
  period_id         uuid not null,
  transaction_kind  text not null default 'payroll_input_batch' check (transaction_kind = 'payroll_input_batch'),
  transaction_id    uuid not null,
  source            text not null check (source in ('ENTRY', 'UPLOAD')),
  file_hash         text check (file_hash ~ '^[0-9a-f]{64}$'),
  -- SHA-256 of the canonical request (the lines entered, or the file bytes): a reused key with other content is refused.
  request_hash      text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key   text check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  line_count        integer not null check (line_count > 0),
  state             text not null check (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  prepared_by       uuid not null references user_account (id) on delete restrict,
  submitted_at      timestamptz,
  decided_at        timestamptz,
  decided_by        uuid references user_account (id) on delete restrict,
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, period_id),
  unique (company_id, transaction_id),
  unique (company_id, idempotency_key),
  foreign key (company_id, period_id, calendar_id) references payroll_period (company_id, id, calendar_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((source = 'UPLOAD') = (file_hash is not null)),
  check (file_hash is null or file_hash = request_hash),
  check (state in ('DRAFT', 'CANCELLED') or submitted_at is not null),
  check ((state in ('APPROVED', 'REJECTED')) = (decided_at is not null and decided_by is not null)),
  check (decided_by is null or decided_by <> prepared_by),
  check ((state in ('APPROVED', 'REJECTED', 'CANCELLED')) = (closed_at is not null))
);
create unique index payroll_input_batch_one_live_file on payroll_input_batch (company_id, period_id, file_hash)
  where (file_hash is not null and state in ('DRAFT', 'SUBMITTED', 'APPROVED'));

create function hrms_payroll_input_batch_guard() returns trigger language plpgsql as $$
begin
  if (new.calendar_id, new.period_id, new.transaction_id, new.source, new.file_hash, new.request_hash, new.idempotency_key, new.line_count, new.prepared_by)
     is distinct from
     (old.calendar_id, old.period_id, old.transaction_id, old.source, old.file_hash, old.request_hash, old.idempotency_key, old.line_count, old.prepared_by) then
    raise exception 'a payroll input batch is fixed once created' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_input_batch_guard before update on payroll_input_batch for each row execute function hrms_payroll_input_batch_guard();

create table payroll_input (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  batch_id             uuid not null,
  period_id            uuid not null,
  employee_id          uuid not null,
  component_id         uuid not null,
  input_kind_category  text not null default 'PAYROLL_INPUT_KIND' check (input_kind_category = 'PAYROLL_INPUT_KIND'),
  input_kind_id        uuid not null,
  amount               numeric(19, 4) not null check (amount > 0),
  currency_code        text not null check (currency_code ~ '^[A-Z]{3}$'),
  effective_date       date not null,
  source               text not null check (source in ('ENTRY', 'UPLOAD')),
  reference            text not null check (reference ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$'),
  state                text not null check (state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELLED')),
  -- The processed payroll record that consumed the input (set once, by processing).
  consumed_record_id   uuid,
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  foreign key (company_id, batch_id, period_id) references payroll_input_batch (company_id, id, period_id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, input_kind_category, input_kind_id) references reference_value (company_id, category, id) on delete restrict,
  check (consumed_record_id is null or state = 'APPROVED')
);
create unique index payroll_input_one_live_reference on payroll_input (company_id, period_id, reference) where (state in ('DRAFT', 'SUBMITTED', 'APPROVED'));
create index payroll_input_employee_idx on payroll_input (company_id, period_id, employee_id) where (state = 'APPROVED');
create index payroll_input_batch_idx on payroll_input (company_id, batch_id);

create function hrms_payroll_input_guard() returns trigger language plpgsql as $$
declare
  b_state text;
  p payroll_period%rowtype;
begin
  select state into b_state from payroll_input_batch where company_id = new.company_id and id = new.batch_id;
  if tg_op = 'INSERT' then
    if b_state is distinct from 'DRAFT' or new.state <> 'DRAFT' then
      raise exception 'payroll inputs are added to a draft batch only' using errcode = '23514';
    end if;
    select * into p from payroll_period where company_id = new.company_id and id = new.period_id;
    if new.effective_date not between p.service_start and p.service_end then
      raise exception 'a payroll input belongs to a date of its service period' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.batch_id, new.period_id, new.employee_id, new.component_id, new.input_kind_id, new.amount, new.currency_code, new.effective_date,
      new.source, new.reference)
     is distinct from
     (old.batch_id, old.period_id, old.employee_id, old.component_id, old.input_kind_id, old.amount, old.currency_code, old.effective_date,
      old.source, old.reference) then
    raise exception 'a payroll input is immutable; cancel its batch and enter a new one' using errcode = '23514';
  end if;
  if new.state <> old.state and new.state <> b_state then
    raise exception 'a payroll input follows the state of its batch' using errcode = '23514';
  end if;
  if old.consumed_record_id is not null and new.consumed_record_id is distinct from old.consumed_record_id then
    raise exception 'a consumed payroll input stays consumed' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_input_guard before insert or update on payroll_input for each row execute function hrms_payroll_input_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB036 payroll_run (typed root payroll_run): one row per revision; a lineage groups the revisions of one run.
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_run (
  id                       uuid primary key,
  company_id               uuid not null references company (id) on delete restrict,
  calendar_id              uuid not null,
  period_id                uuid not null,
  lineage_id               uuid not null,
  revision                 integer not null check (revision > 0),
  supersedes_run_id        uuid,
  transaction_kind         text not null default 'payroll_run' check (transaction_kind = 'payroll_run'),
  transaction_id           uuid not null,
  state                    text not null check (state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED', 'RETURNED', 'CANCELLED')),
  -- FR-030 scope filters fixed when the run was created (empty: no filter on that dimension) and its confirmation.
  scope_department_ids     uuid[] not null default '{}',
  scope_grade_ids          uuid[] not null default '{}',
  scope_location_ids       uuid[] not null default '{}',
  scope_token              text not null check (scope_token ~ '^[0-9a-f]{64}$'),
  -- The period's facts (cutoff included), copied when the lineage was created.
  service_start            date not null,
  service_end              date not null,
  input_cutoff             date not null,
  payment_date             date not null,
  days_in_month            integer not null check (days_in_month between 28 and 31),
  currency_code            text not null check (currency_code ~ '^[A-Z]{3}$'),
  currency_minor_unit      smallint not null check (currency_minor_unit between 0 and 4),
  -- Included members of this revision (checked against the lineage's members when the calculation completes).
  member_count             integer not null check (member_count >= 0),
  -- DB036 snapshot identifiers, written once when the calculation of this revision starts: the preparer, the
  -- paid-day policy and the number of head revisions fixed in payroll_run_head.
  calculation_started_at   timestamptz,
  calculated_by            uuid references user_account (id) on delete restrict,
  paid_day_policy_id       uuid,
  attendance_basis         text check (attendance_basis in ('APPROVED_LEAVE_ONLY', 'REVIEWED_ATTENDANCE', 'NOT_CONFIGURED')),
  absent_unpaid_units      numeric(3, 2),
  half_day_unpaid_units    numeric(3, 2),
  head_count               integer check (head_count >= 0),
  -- Every member's record has its outcome (the revision becomes CALCULATED).
  calculated_at            timestamptz,
  submitted_at             timestamptz,
  reviewed_at              timestamptz,
  reviewed_by              uuid references user_account (id) on delete restrict,
  approved_at              timestamptz,
  approved_by              uuid references user_account (id) on delete restrict,
  -- Processing: started once (the processor), completed once (the lock).
  processing_started_at    timestamptz,
  processed_by             uuid references user_account (id) on delete restrict,
  processed_assignment_id  uuid,
  processed_at             timestamptz,
  lock_version             integer check (lock_version > 0),
  closed_at                timestamptz,
  close_reason             text check (close_reason is null or (btrim(close_reason) <> '' and length(close_reason) <= 1000)),
  created_at               timestamptz not null default now(),
  created_by               uuid references user_account (id) on delete restrict,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references user_account (id) on delete restrict,
  version                  integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, transaction_id),
  unique (company_id, lineage_id, revision),
  foreign key (company_id, period_id, calendar_id) references payroll_period (company_id, id, calendar_id) on delete restrict,
  foreign key (company_id, supersedes_run_id) references payroll_run (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, paid_day_policy_id) references payroll_paid_day_policy (company_id, id) on delete restrict,
  foreign key (company_id, processed_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check ((revision = 1) = (supersedes_run_id is null)),
  check ((revision = 1) = (lineage_id = id)),
  check (service_end >= service_start and days_in_month = service_end - service_start + 1),
  check ((calculation_started_at is null) = (calculated_by is null)),
  check ((calculation_started_at is null) = (attendance_basis is null)),
  check ((calculation_started_at is null) = (head_count is null)),
  check (calculated_at is null or calculation_started_at is not null),
  check (state in ('DRAFT', 'CANCELLED') or calculated_at is not null),
  check (state <> 'DRAFT' or calculated_at is null),
  check ((paid_day_policy_id is null) = (attendance_basis is null or attendance_basis = 'NOT_CONFIGURED')),
  check ((attendance_basis = 'REVIEWED_ATTENDANCE') = (absent_unpaid_units is not null and half_day_unpaid_units is not null)),
  check (attendance_basis = 'REVIEWED_ATTENDANCE' or (absent_unpaid_units is null and half_day_unpaid_units is null)),
  check (state not in ('IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED') or submitted_at is not null),
  check (state not in ('APPROVED', 'PROCESSED_LOCKED') or (reviewed_at is not null and approved_at is not null)),
  check ((reviewed_at is null) = (reviewed_by is null) and (approved_at is null) = (approved_by is null)),
  -- C4: the creator and preparer never review or approve, and the reviewer never approves.
  check (reviewed_by is null or (reviewed_by <> calculated_by and reviewed_by <> created_by)),
  check (approved_by is null or (approved_by <> calculated_by and approved_by <> created_by and approved_by <> reviewed_by)),
  -- BRD role table (Payroll Operator "cannot approve or release own prepared payroll"): the creator and preparer
  -- never process (lock) the run.
  check (processed_by is null or (processed_by <> calculated_by and processed_by <> created_by)),
  check ((processing_started_at is null) = (processed_by is null)),
  check (processing_started_at is null or state in ('APPROVED', 'PROCESSED_LOCKED')),
  check ((state = 'PROCESSED_LOCKED') = (processed_at is not null)),
  check (processed_at is null or processing_started_at is not null),
  check ((processed_at is null) = (lock_version is null)),
  check ((state in ('RETURNED', 'CANCELLED')) = (closed_at is not null)),
  check (state <> 'CANCELLED' or close_reason is not null)
);
create unique index payroll_run_one_successor on payroll_run (company_id, supersedes_run_id) where (supersedes_run_id is not null);
create unique index payroll_run_one_live_revision on payroll_run (company_id, lineage_id)
  where (state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED'));
create index payroll_run_period_idx on payroll_run (company_id, period_id, state);

create function hrms_payroll_run_guard() returns trigger language plpgsql as $$
declare
  members integer;
  records integer;
begin
  if tg_op = 'INSERT' then
    if new.state <> 'DRAFT' or new.calculation_started_at is not null or new.processing_started_at is not null then
      raise exception 'a payroll run revision starts as an uncalculated draft' using errcode = '23514';
    end if;
    return new;
  end if;
  -- BR-047 / CI25: nothing of a processed run changes, ever (no unlock in place).
  if old.state = 'PROCESSED_LOCKED' then
    raise exception 'a processed payroll run is locked; corrections are linked adjustments in a later run' using errcode = '23514';
  end if;
  if (new.calendar_id, new.period_id, new.lineage_id, new.revision, new.supersedes_run_id, new.transaction_id, new.scope_department_ids,
      new.scope_grade_ids, new.scope_location_ids, new.scope_token, new.service_start, new.service_end, new.input_cutoff, new.payment_date,
      new.days_in_month, new.currency_code, new.currency_minor_unit, new.created_by)
     is distinct from
     (old.calendar_id, old.period_id, old.lineage_id, old.revision, old.supersedes_run_id, old.transaction_id, old.scope_department_ids,
      old.scope_grade_ids, old.scope_location_ids, old.scope_token, old.service_start, old.service_end, old.input_cutoff, old.payment_date,
      old.days_in_month, old.currency_code, old.currency_minor_unit, old.created_by) then
    raise exception 'the identity and confirmed scope of a payroll run revision are immutable' using errcode = '23514';
  end if;
  -- One calculation per revision: its snapshot identifiers are written once, when it starts.
  if old.calculation_started_at is not null
     and (new.calculation_started_at, new.calculated_by, new.paid_day_policy_id, new.attendance_basis, new.absent_unpaid_units, new.half_day_unpaid_units, new.head_count)
         is distinct from
         (old.calculation_started_at, old.calculated_by, old.paid_day_policy_id, old.attendance_basis, old.absent_unpaid_units, old.half_day_unpaid_units, old.head_count) then
    raise exception 'a payroll run revision is calculated once; return it to calculate a new revision' using errcode = '23514';
  end if;
  if old.calculated_at is not null and new.calculated_at is distinct from old.calculated_at then
    raise exception 'the completion of a calculation is final' using errcode = '23514';
  end if;
  if new.member_count <> old.member_count and (old.state <> 'DRAFT' or old.calculation_started_at is not null) then
    raise exception 'the members of a revision are fixed once its calculation starts' using errcode = '23514';
  end if;
  if (old.submitted_at is not null and new.submitted_at is distinct from old.submitted_at)
     or (old.reviewed_at is not null and (new.reviewed_at, new.reviewed_by) is distinct from (old.reviewed_at, old.reviewed_by))
     or (old.approved_at is not null and (new.approved_at, new.approved_by) is distinct from (old.approved_at, old.approved_by)) then
    raise exception 'recorded payroll run decisions are final' using errcode = '23514';
  end if;
  if old.processing_started_at is not null then
    if (new.processing_started_at, new.processed_by, new.processed_assignment_id) is distinct from (old.processing_started_at, old.processed_by, old.processed_assignment_id) then
      raise exception 'the start of processing is final' using errcode = '23514';
    end if;
    if new.state in ('RETURNED', 'CANCELLED') then
      raise exception 'processing has started; the revision can only be completed' using errcode = '23514';
    end if;
  end if;
  if old.state = 'DRAFT' and new.state = 'CALCULATED' then
    if exists (select 1 from payroll_record where company_id = new.company_id and run_id = new.id and calculation_status = 'PENDING') then
      raise exception 'every payroll record of a calculated run has a calculation outcome' using errcode = '23514';
    end if;
    select count(*) into members from payroll_run_member
     where company_id = new.company_id and lineage_id = new.lineage_id and (excluded_from_revision is null or excluded_from_revision > new.revision);
    select count(*) into records from payroll_record where company_id = new.company_id and run_id = new.id;
    if members <> records or members <> new.member_count then
      raise exception 'every included member of a calculated run has a payroll record' using errcode = '23514';
    end if;
  end if;
  if new.state = 'PROCESSED_LOCKED'
     and exists (select 1 from payroll_record where company_id = new.company_id and run_id = new.id and frozen_at is null) then
    raise exception 'processing freezes every payroll record of the run' using errcode = '23514';
  end if;
  if new.state = 'PROCESSED_LOCKED' and new.updated_by in (old.created_by, old.calculated_by) then
    raise exception 'the creator and preparer of a payroll run do not process it' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_run_guard before insert or update on payroll_run for each row execute function hrms_payroll_run_guard();

-- The rules of a revision (H2 "freezes ... rule ... revisions"): the head revision in effect on the service period's
-- last day for every pay component, fixed when the calculation starts, so every chunk uses the same rules.
create table payroll_run_head (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  run_id            uuid not null,
  component_id      uuid not null,
  head_revision_id  uuid not null,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, run_id, component_id),
  foreign key (company_id, run_id) references payroll_run (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, head_revision_id, component_id) references payroll_head_revision (company_id, id, component_id) on delete restrict
);

create function hrms_payroll_run_head_guard() returns trigger language plpgsql as $$
declare
  r payroll_run%rowtype;
begin
  select * into r from payroll_run where company_id = new.company_id and id = new.run_id;
  if r.state is distinct from 'DRAFT' or r.calculation_started_at is null
     or exists (select 1 from payroll_record where company_id = new.company_id and run_id = new.run_id) then
    raise exception 'the rules of a run revision are fixed when its calculation starts' using errcode = '23514';
  end if;
  if not exists (select 1 from payroll_head_revision where company_id = new.company_id and id = new.head_revision_id and state = 'ACTIVE') then
    raise exception 'a run uses active head revisions only' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_run_head_guard before insert on payroll_run_head for each row execute function hrms_payroll_run_head_guard();
create trigger payroll_run_head_append_only before update or delete on payroll_run_head for each row execute function hrms_append_only();

-- The approval stage of a reviewed revision: its own transaction, so that the approver is chosen independently of the
-- preparer and the reviewer (DF02/DF03; C4).
create table payroll_run_approval (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  run_id            uuid not null,
  transaction_kind  text not null default 'payroll_run_approval' check (transaction_kind = 'payroll_run_approval'),
  transaction_id    uuid not null,
  state             text not null check (state in ('SUBMITTED', 'APPROVED', 'RETURNED', 'CANCELLED')),
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, run_id),
  unique (company_id, transaction_id),
  foreign key (company_id, run_id) references payroll_run (company_id, id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((state = 'SUBMITTED') = (closed_at is null))
);

-- FR-030 confirmed scope: the members of a run are fixed when it is created and belong to its lineage, so a return
-- opens the next revision without copying them. A member can only be excluded, from a given revision onward (a
-- member is in revision N unless excluded_from_revision <= N), never added. An employee is a live, not excluded
-- member of at most one run per service month, whatever the calendar (no double payment); a cancelled run releases
-- its members (live = false).
create table payroll_run_member (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  lineage_id              uuid not null,
  employee_id             uuid not null,
  service_month           date not null,
  excluded_from_revision  integer check (excluded_from_revision > 0),
  exclusion_reason        text check (exclusion_reason is null or (btrim(exclusion_reason) <> '' and length(exclusion_reason) <= 1000)),
  excluded_at             timestamptz,
  excluded_by             uuid references user_account (id) on delete restrict,
  live                    boolean not null default true,
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, lineage_id, employee_id),
  foreign key (company_id, lineage_id) references payroll_run (company_id, id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  check ((excluded_from_revision is null) = (exclusion_reason is null)),
  check ((excluded_from_revision is null) = (excluded_at is null) and (excluded_at is null) = (excluded_by is null))
);
create unique index payroll_member_one_live_run on payroll_run_member (company_id, service_month, employee_id) where (live and excluded_from_revision is null);
create index payroll_member_employee_idx on payroll_run_member (company_id, employee_id, service_month);
create index payroll_member_excluded_idx on payroll_run_member (company_id, lineage_id) where (excluded_from_revision is not null);
create index payroll_member_live_idx on payroll_run_member (company_id, lineage_id) where (live);

create function hrms_payroll_member_guard() returns trigger language plpgsql as $$
declare
  root payroll_run%rowtype;
  cur payroll_run%rowtype;
begin
  if tg_op = 'INSERT' then
    select * into root from payroll_run where company_id = new.company_id and id = new.lineage_id;
    if root.revision is distinct from 1 or root.state <> 'DRAFT' or root.calculation_started_at is not null or new.service_month <> root.service_start
       or not new.live or new.excluded_from_revision is not null
       or exists (select 1 from payroll_run n where n.company_id = new.company_id and n.lineage_id = new.lineage_id and n.revision > 1) then
      raise exception 'members are confirmed when a run is created' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.lineage_id, new.employee_id, new.service_month) is distinct from (old.lineage_id, old.employee_id, old.service_month) then
    raise exception 'a payroll run member is immutable' using errcode = '23514';
  end if;
  -- BR-047 / CI25: the confirmed scope of a processed run never changes.
  if exists (select 1 from payroll_run where company_id = new.company_id and lineage_id = new.lineage_id and state = 'PROCESSED_LOCKED') then
    raise exception 'a processed payroll run is locked; its members are fixed' using errcode = '23514';
  end if;
  if (new.excluded_from_revision, new.exclusion_reason, new.excluded_at, new.excluded_by) is distinct from
     (old.excluded_from_revision, old.exclusion_reason, old.excluded_at, old.excluded_by) then
    if old.excluded_from_revision is not null then
      raise exception 'an exclusion from a run is final' using errcode = '23514';
    end if;
    select * into cur from payroll_run
     where company_id = new.company_id and lineage_id = new.lineage_id and state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED');
    if cur.id is null or cur.state <> 'DRAFT' or cur.calculation_started_at is not null or new.excluded_from_revision is distinct from cur.revision then
      raise exception 'a member is excluded from the current draft revision, before its calculation starts' using errcode = '23514';
    end if;
  end if;
  if new.live and not old.live then
    raise exception 'a closed run does not come back to life' using errcode = '23514';
  end if;
  if not new.live and old.live
     and exists (select 1 from payroll_run where company_id = new.company_id and lineage_id = new.lineage_id
                   and state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED')) then
    raise exception 'members leave the live scope only when their run is cancelled' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_run_member_guard before insert or update on payroll_run_member for each row execute function hrms_payroll_member_guard();

-- CP-08: the bounded chunks a revision was calculated and processed in (append-only; consecutive per phase). The
-- counts of a chunk are those of its own records, so run counts and totals are sums over a few chunk rows.
create table payroll_run_chunk (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  run_id             uuid not null,
  phase              text not null check (phase in ('CALCULATE', 'PROCESS')),
  sequence           integer not null check (sequence > 0),
  first_employee_id  uuid not null,
  last_employee_id   uuid not null,
  records            integer not null check (records > 0),
  -- CALCULATE: the outcomes of the chunk's records, and the paid units of its calculated ones.
  calculated         integer not null default 0 check (calculated >= 0),
  failed             integer not null default 0 check (failed >= 0),
  excluded           integer not null default 0 check (excluded >= 0),
  not_eligible       integer not null default 0 check (not_eligible >= 0),
  paid_units         numeric(19, 4) not null default 0 check (paid_units >= 0),
  -- PROCESS: the frozen bank reference found for each record, and what processing applied.
  bank_verified      integer not null default 0 check (bank_verified >= 0),
  bank_missing       integer not null default 0 check (bank_missing >= 0),
  bank_invalid       integer not null default 0 check (bank_invalid >= 0),
  bank_unverified    integer not null default 0 check (bank_unverified >= 0),
  bank_not_required  integer not null default 0 check (bank_not_required >= 0),
  safety_blocks      integer not null default 0 check (safety_blocks >= 0),
  stop_holds         integer not null default 0 check (stop_holds >= 0),
  applied_stops      integer not null default 0 check (applied_stops >= 0),
  consumed_inputs    integer not null default 0 check (consumed_inputs >= 0),
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, id, run_id),
  unique (company_id, run_id, phase, sequence),
  foreign key (company_id, run_id) references payroll_run (company_id, id) on delete restrict,
  check (first_employee_id <= last_employee_id),
  check (phase <> 'CALCULATE' or calculated + failed + excluded + not_eligible = records),
  check (phase <> 'PROCESS' or bank_verified + bank_missing + bank_invalid + bank_unverified + bank_not_required = records)
);

create function hrms_payroll_run_chunk_guard() returns trigger language plpgsql as $$
declare
  r payroll_run%rowtype;
begin
  select * into r from payroll_run where company_id = new.company_id and id = new.run_id;
  if new.phase = 'CALCULATE' and (r.state is distinct from 'DRAFT' or r.calculation_started_at is null) then
    raise exception 'calculation chunks belong to a draft revision whose calculation has started' using errcode = '23514';
  end if;
  if new.phase = 'PROCESS' and (r.state is distinct from 'APPROVED' or r.processing_started_at is null) then
    raise exception 'processing chunks belong to an approved revision whose processing has started' using errcode = '23514';
  end if;
  if new.phase = 'PROCESS' and new.created_by in (r.created_by, r.calculated_by) then
    raise exception 'the creator and preparer of a payroll run do not process it' using errcode = '23514';
  end if;
  if new.sequence <> coalesce((select max(sequence) from payroll_run_chunk where company_id = new.company_id and run_id = new.run_id and phase = new.phase), 0) + 1 then
    raise exception 'run chunks are consecutive' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_run_chunk_guard before insert on payroll_run_chunk for each row execute function hrms_payroll_run_chunk_guard();
create trigger payroll_run_chunk_append_only before update or delete on payroll_run_chunk for each row execute function hrms_append_only();

-- Component totals of a calculation chunk (sums of its rounded lines).
create table payroll_run_chunk_total (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  chunk_id      uuid not null,
  run_id        uuid not null,
  component_id  uuid not null,
  head_type     text not null check (head_type in ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT')),
  line_count    integer not null check (line_count > 0),
  amount        numeric(19, 4) not null check (amount >= 0),
  created_at    timestamptz not null default now(),
  created_by    uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, chunk_id, component_id, head_type),
  foreign key (company_id, chunk_id, run_id) references payroll_run_chunk (company_id, id, run_id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict
);
create index payroll_run_chunk_total_run_idx on payroll_run_chunk_total (company_id, run_id);

create function hrms_payroll_chunk_total_guard() returns trigger language plpgsql as $$
begin
  if (select phase from payroll_run_chunk where company_id = new.company_id and id = new.chunk_id) is distinct from 'CALCULATE'
     or (select state from payroll_run where company_id = new.company_id and id = new.run_id) is distinct from 'DRAFT' then
    raise exception 'component totals are written with their calculation chunk' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_run_chunk_total_guard before insert on payroll_run_chunk_total for each row execute function hrms_payroll_chunk_total_guard();
create trigger payroll_run_chunk_total_append_only before update or delete on payroll_run_chunk_total for each row execute function hrms_append_only();

-- ---------------------------------------------------------------------------------------------------------------
-- DB037 payroll_record, its frozen input snapshot and DB038 payroll_line
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_record (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  run_id                  uuid not null,
  employee_id             uuid not null,
  -- Snapshot of the employee facts the calculation used.
  employee_code           text not null,
  joining_date            date not null,
  leaving_date            date,
  status_code             text not null,
  eligible_from           date,
  eligible_to             date,
  eligible_days           integer check (eligible_days >= 0),
  salary_stop_id          uuid,
  salary_stop_mode        text check (salary_stop_mode in ('HOLD_DISBURSEMENT', 'EXCLUDE_CALCULATION')),
  -- PENDING exists only inside the calculation chunk that writes the record.
  calculation_status      text not null check (calculation_status in ('PENDING', 'CALCULATED', 'FAILED', 'EXCLUDED', 'NOT_ELIGIBLE')),
  salary_arrangement_id   uuid,
  currency_code           text not null check (currency_code ~ '^[A-Z]{3}$'),
  days_in_month           integer not null check (days_in_month between 28 and 31),
  paid_units              numeric(9, 4) check (paid_units >= 0),
  -- DF05: net = earnings + reimbursements - employee deductions; employer contributions are a separate cost.
  earnings                numeric(19, 4) check (earnings >= 0),
  reimbursements          numeric(19, 4) check (reimbursements >= 0),
  gross                   numeric(19, 4),
  deductions              numeric(19, 4) check (deductions >= 0),
  net                     numeric(19, 4),
  employer_contributions  numeric(19, 4) check (employer_contributions >= 0),
  -- Frozen by processing: the employee's approved BANK revision (DB037 extension); a payment without it is blocked.
  bank_status             text check (bank_status in ('VERIFIED', 'MISSING', 'INVALID', 'UNVERIFIED', 'NOT_REQUIRED')),
  bank_revision_id        uuid,
  frozen_at               timestamptz,
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, id, run_id),
  unique (company_id, run_id, employee_id),
  foreign key (company_id, run_id) references payroll_run (company_id, id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, salary_arrangement_id, employee_id) references salary_arrangement (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, salary_stop_id, employee_id) references payroll_salary_stop (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, bank_revision_id) references employee_private_profile_revision (company_id, id) on delete restrict,
  check ((salary_stop_id is null) = (salary_stop_mode is null)),
  check (calculation_status <> 'EXCLUDED' or salary_stop_mode = 'EXCLUDE_CALCULATION'),
  check ((eligible_from is null) = (eligible_to is null) and (eligible_from is null) = (eligible_days is null)),
  check (eligible_to is null or (eligible_to >= eligible_from and eligible_days = eligible_to - eligible_from + 1)),
  check ((calculation_status = 'CALCULATED') = (net is not null)),
  check (calculation_status <> 'CALCULATED' or (earnings is not null and reimbursements is not null and gross is not null and deductions is not null
                                                 and employer_contributions is not null and paid_units is not null and salary_arrangement_id is not null)),
  check (net is not null or (earnings is null and reimbursements is null and gross is null and deductions is null and employer_contributions is null)),
  check (net is null or (gross = earnings + reimbursements and net = gross - deductions)),
  check ((frozen_at is null) = (bank_status is null)),
  check ((bank_status = 'VERIFIED') = (bank_revision_id is not null))
);
-- Chunk cursors: records still pending (inside a chunk) and records not yet frozen (processing).
create index payroll_record_pending_idx on payroll_record (company_id, run_id) where (calculation_status = 'PENDING');
create index payroll_record_unfrozen_idx on payroll_record (company_id, run_id, employee_id) where (frozen_at is null);
create index payroll_record_employee_idx on payroll_record (company_id, employee_id);

create function hrms_payroll_record_guard() returns trigger language plpgsql as $$
declare
  ru payroll_run%rowtype;
  bank_owner uuid;
  bank_category text;
begin
  select * into ru from payroll_run where company_id = new.company_id and id = new.run_id;
  if tg_op = 'INSERT' then
    if ru.state is distinct from 'DRAFT' or ru.calculation_started_at is null or new.calculation_status <> 'PENDING' or new.frozen_at is not null then
      raise exception 'payroll records are written by the calculation of a draft revision' using errcode = '23514';
    end if;
    return new;
  end if;
  -- BR-047 / CI25: a frozen record never changes again, not even its metadata.
  if old.frozen_at is not null then
    raise exception 'a frozen payroll record is immutable; corrections are linked adjustments in a later run' using errcode = '23514';
  end if;
  if (new.run_id, new.employee_id, new.employee_code, new.joining_date, new.leaving_date, new.status_code, new.eligible_from, new.eligible_to,
      new.eligible_days, new.salary_stop_id, new.salary_stop_mode, new.currency_code, new.days_in_month)
     is distinct from
     (old.run_id, old.employee_id, old.employee_code, old.joining_date, old.leaving_date, old.status_code, old.eligible_from, old.eligible_to,
      old.eligible_days, old.salary_stop_id, old.salary_stop_mode, old.currency_code, old.days_in_month) then
    raise exception 'the snapshot of a payroll record is immutable' using errcode = '23514';
  end if;
  if ru.state = 'DRAFT' then
    -- The calculation chunk completes the record (outcome and totals); nothing is frozen yet.
    if old.calculation_status <> 'PENDING' or new.frozen_at is not null then
      raise exception 'a payroll record outcome is written once' using errcode = '23514';
    end if;
    return new;
  end if;
  -- After the calculation: only processing writes, once, the frozen bank reference (CI25).
  if (new.calculation_status, new.salary_arrangement_id, new.paid_units, new.earnings, new.reimbursements, new.gross, new.deductions, new.net,
      new.employer_contributions)
     is distinct from
     (old.calculation_status, old.salary_arrangement_id, old.paid_units, old.earnings, old.reimbursements, old.gross, old.deductions, old.net,
      old.employer_contributions) then
    raise exception 'calculated payroll results are immutable; return the run to calculate a new revision' using errcode = '23514';
  end if;
  if (new.bank_status, new.bank_revision_id, new.frozen_at) is distinct from (old.bank_status, old.bank_revision_id, old.frozen_at)
     and (ru.state <> 'APPROVED' or ru.processing_started_at is null or old.frozen_at is not null) then
    raise exception 'a payroll record is frozen once, while its approved run is processed' using errcode = '23514';
  end if;
  if new.bank_revision_id is not null then
    select employee_id, category into bank_owner, bank_category from employee_private_profile_revision
     where company_id = new.company_id and id = new.bank_revision_id;
    if bank_owner is distinct from new.employee_id or bank_category is distinct from 'BANK' then
      raise exception 'the frozen bank reference must be an approved bank revision of the same employee' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger payroll_record_guard before insert or update on payroll_record for each row execute function hrms_payroll_record_guard();

-- Arrangement segments of the eligible days (DF05: paid-day segments count once).
create table payroll_record_segment (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  record_id              uuid not null,
  employee_id            uuid not null,
  salary_arrangement_id  uuid not null,
  segment_start          date not null,
  segment_end            date not null,
  calendar_days          integer not null check (calendar_days > 0),
  leave_lop_units        numeric(9, 4) not null check (leave_lop_units >= 0),
  attendance_lop_units   numeric(9, 4) not null check (attendance_lop_units >= 0),
  paid_days              numeric(9, 4) not null check (paid_days >= 0),
  currency_code          text not null check (currency_code ~ '^[A-Z]{3}$'),
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, id, record_id),
  unique (company_id, record_id, segment_start),
  foreign key (company_id, record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, salary_arrangement_id, employee_id) references salary_arrangement (company_id, id, employee_id) on delete restrict,
  check (segment_end >= segment_start and calendar_days = segment_end - segment_start + 1),
  check (paid_days = calendar_days - leave_lop_units - attendance_lop_units)
);

-- Loss-of-pay days of a record, one row per day (a day is never counted twice: FR-032 "deductions are not applied twice").
create table payroll_record_lop (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  record_id             uuid not null,
  employee_id           uuid not null,
  day                   date not null,
  source_kind           text not null check (source_kind in ('UNPAID_LEAVE', 'ATTENDANCE')),
  leave_request_id      uuid,
  attendance_record_id  uuid,
  units                 numeric(5, 4) not null check (units > 0 and units <= 1),
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, record_id, day),
  foreign key (company_id, record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, leave_request_id) references leave_request (company_id, id) on delete restrict,
  foreign key (company_id, attendance_record_id) references attendance_record (company_id, id) on delete restrict,
  check ((source_kind = 'UNPAID_LEAVE') = (leave_request_id is not null)),
  check ((source_kind = 'ATTENDANCE') = (attendance_record_id is not null))
);

-- The salary components of each segment and the head revision (from the run's rules) that classified them.
create table payroll_record_component (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  record_id          uuid not null,
  segment_id         uuid not null,
  component_id       uuid not null,
  amount             numeric(19, 4) not null check (amount >= 0),
  amount_basis       text not null check (amount_basis in ('MONTHLY', 'ANNUAL')),
  head_revision_id   uuid,
  head_type          text check (head_type in ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT')),
  calculation_basis  text check (calculation_basis in ('FIXED', 'INPUT', 'RULE_PACK')),
  rule_pack_code     text,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, segment_id, component_id),
  foreign key (company_id, segment_id, record_id) references payroll_record_segment (company_id, id, record_id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, head_revision_id) references payroll_head_revision (company_id, id) on delete restrict,
  check ((head_revision_id is null) = (head_type is null) and (head_type is null) = (calculation_basis is null))
);

-- The approved inputs included in the record. Hook for the outputs stage: an approved later-period adjustment (DB111)
-- becomes a further source kind here, with its own reference, so a correction is a linked line of a later run and
-- never a rewrite of the processed original.
create table payroll_record_input (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  record_id          uuid not null,
  employee_id        uuid not null,
  source_kind        text not null default 'INPUT' check (source_kind in ('INPUT')),
  input_id           uuid not null,
  component_id       uuid not null,
  amount             numeric(19, 4) not null check (amount > 0),
  currency_code      text not null check (currency_code ~ '^[A-Z]{3}$'),
  head_revision_id   uuid,
  head_type          text check (head_type in ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT')),
  calculation_basis  text check (calculation_basis in ('FIXED', 'INPUT', 'RULE_PACK')),
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, record_id, input_id),
  foreign key (company_id, record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, input_id, employee_id) references payroll_input (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, head_revision_id) references payroll_head_revision (company_id, id) on delete restrict,
  check ((head_revision_id is null) = (head_type is null) and (head_type is null) = (calculation_basis is null))
);
create index payroll_record_input_input_idx on payroll_record_input (company_id, input_id);

-- DB038 payroll_line: one rounded line per record and component (grouped model); rule_version names the head revision.
create table payroll_line (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  record_id          uuid not null,
  component_id       uuid not null,
  head_revision_id   uuid not null,
  head_type          text not null check (head_type in ('EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT')),
  calculation_basis  text not null check (calculation_basis in ('FIXED', 'INPUT')),
  amount             numeric(19, 4) not null check (amount >= 0),
  rule_version       text not null check (btrim(rule_version) <> '' and length(rule_version) <= 100),
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  unique (company_id, id),
  unique (company_id, record_id, component_id),
  foreign key (company_id, record_id) references payroll_record (company_id, id) on delete restrict,
  foreign key (company_id, component_id) references pay_component (company_id, id) on delete restrict,
  foreign key (company_id, head_revision_id) references payroll_head_revision (company_id, id) on delete restrict
);

-- Snapshot rows and lines are written by the calculation of a draft revision only, and never change.
create function hrms_payroll_snapshot_guard() returns trigger language plpgsql as $$
declare
  run_state text;
  started timestamptz;
begin
  select ru.state, ru.calculation_started_at into run_state, started
    from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
   where r.company_id = new.company_id and r.id = new.record_id;
  if run_state is distinct from 'DRAFT' or started is null then
    raise exception 'payroll calculation snapshots are written once, by the calculation' using errcode = '23514';
  end if;
  return new;
end $$;

do $$
declare
  t text;
begin
  foreach t in array array['payroll_record_segment', 'payroll_record_lop', 'payroll_record_component', 'payroll_record_input', 'payroll_line'] loop
    execute format('create trigger %I before insert on %I for each row execute function hrms_payroll_snapshot_guard()', t || '_guard', t);
    execute format('create trigger %I before update or delete on %I for each row execute function hrms_append_only()', t || '_append_only', t);
  end loop;
end $$;

-- CI25 reconciliation: a calculated record's totals equal the sum of its lines by head type (checked at commit; the
-- message carries no amounts).
create function hrms_payroll_record_totals_check() returns trigger language plpgsql as $$
declare
  rid uuid;
  cid uuid;
  r payroll_record%rowtype;
  e numeric;
  rb numeric;
  d numeric;
  ec numeric;
  n integer;
begin
  cid := new.company_id;
  -- The trigger serves two tables; the row is read generically so each table's own columns are not compiled in.
  rid := (to_jsonb(new) ->> case when tg_table_name = 'payroll_record' then 'id' else 'record_id' end)::uuid;
  select * into r from payroll_record where company_id = cid and id = rid;
  select coalesce(sum(amount) filter (where head_type = 'EARNING'), 0), coalesce(sum(amount) filter (where head_type = 'REIMBURSEMENT'), 0),
         coalesce(sum(amount) filter (where head_type = 'DEDUCTION'), 0), coalesce(sum(amount) filter (where head_type = 'EMPLOYER_CONTRIBUTION'), 0),
         count(*)
    into e, rb, d, ec, n
    from payroll_line where company_id = cid and record_id = rid;
  if r.calculation_status = 'CALCULATED' then
    if (e, rb, d, ec) is distinct from (r.earnings, r.reimbursements, r.deductions, r.employer_contributions) then
      raise exception 'payroll record totals must equal the sum of its lines' using errcode = '23514';
    end if;
  elsif n > 0 then
    raise exception 'only a calculated payroll record has lines' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger payroll_record_totals_match after insert or update on payroll_record deferrable initially deferred
  for each row execute function hrms_payroll_record_totals_check();
create constraint trigger payroll_line_totals_match after insert on payroll_line deferrable initially deferred
  for each row execute function hrms_payroll_record_totals_check();

-- FR-033 per-employee exceptions. Blocking exceptions stop approval for the run until resolved (only the resolvable
-- kinds) or until the employee is excluded through a new revision; warnings inform. Details are operational facts
-- (component codes, dates, counts), never amounts.
create table payroll_exception (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references company (id) on delete restrict,
  run_id                  uuid not null,
  record_id               uuid not null,
  employee_id             uuid not null,
  code                    text not null check (code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  severity                text not null check (severity in ('BLOCKING', 'WARNING')),
  resolvable              boolean not null,
  detail                  jsonb not null default '{}'::jsonb,
  resolution              text check (resolution is null or (btrim(resolution) <> '' and length(resolution) <= 1000)),
  resolved_by             uuid references user_account (id) on delete restrict,
  resolved_assignment_id  uuid,
  resolved_at             timestamptz,
  created_at              timestamptz not null default now(),
  created_by              uuid references user_account (id) on delete restrict,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references user_account (id) on delete restrict,
  version                 integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, record_id, run_id) references payroll_record (company_id, id, run_id) on delete restrict,
  foreign key (company_id, record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, resolved_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (not resolvable or severity = 'BLOCKING'),
  check ((resolved_at is null) = (resolved_by is null) and (resolved_at is null) = (resolution is null)
         and (resolved_at is null) = (resolved_assignment_id is null)),
  check (resolved_at is null or resolvable)
);
create index payroll_exception_run_idx on payroll_exception (company_id, run_id, severity);
create index payroll_exception_record_idx on payroll_exception (company_id, record_id);

create function hrms_payroll_exception_guard() returns trigger language plpgsql as $$
declare
  ru payroll_run%rowtype;
begin
  select * into ru from payroll_run where company_id = new.company_id and id = new.run_id;
  if tg_op = 'INSERT' then
    if ru.state <> 'DRAFT' or ru.calculation_started_at is null or new.resolved_at is not null then
      raise exception 'payroll exceptions are raised by the calculation' using errcode = '23514';
    end if;
    return new;
  end if;
  if ru.state = 'PROCESSED_LOCKED' then
    raise exception 'a processed payroll run is locked; its exceptions are final' using errcode = '23514';
  end if;
  if (new.run_id, new.record_id, new.employee_id, new.code, new.severity, new.resolvable, new.detail)
     is distinct from (old.run_id, old.record_id, old.employee_id, old.code, old.severity, old.resolvable, old.detail) then
    raise exception 'a payroll exception is immutable' using errcode = '23514';
  end if;
  if (new.resolution, new.resolved_by, new.resolved_at, new.resolved_assignment_id) is distinct from
     (old.resolution, old.resolved_by, old.resolved_at, old.resolved_assignment_id) then
    if old.resolved_at is not null then
      raise exception 'a recorded resolution is final' using errcode = '23514';
    end if;
    if ru.state not in ('CALCULATED', 'IN_REVIEW') then
      raise exception 'exceptions are resolved before the run is approved' using errcode = '23514';
    end if;
    -- H2: a payroll approver records the resolution; never the preparer or the employee concerned.
    if new.resolved_by = ru.calculated_by or new.resolved_by = ru.created_by
       or exists (select 1 from user_employee_link l where l.company_id = new.company_id and l.user_id = new.resolved_by and l.employee_id = new.employee_id) then
      raise exception 'an exception is resolved by an independent approver' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger payroll_exception_guard before insert or update on payroll_exception for each row execute function hrms_payroll_exception_guard();

-- A covering approval of one record whose employee is the run's reviewer or approver ("nobody approves a run that
-- contains their own payroll record without another approver covering that record"). The transaction is owned by
-- the covered employee, so the approval engine's database guard also refuses that employee's own decision.
create table payroll_record_cover (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  run_id            uuid not null,
  employee_id       uuid not null,
  covered_role      text not null check (covered_role in ('REVIEWER', 'APPROVER')),
  transaction_kind  text not null default 'payroll_record_cover' check (transaction_kind = 'payroll_record_cover'),
  transaction_id    uuid not null,
  state             text not null check (state in ('SUBMITTED', 'APPROVED', 'RETURNED', 'CANCELLED')),
  closed_at         timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, run_id, employee_id),
  unique (company_id, transaction_id),
  foreign key (company_id, run_id, employee_id) references payroll_record (company_id, run_id, employee_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  check ((state = 'SUBMITTED') = (closed_at is null))
);

create function hrms_payroll_stage_guard() returns trigger language plpgsql as $$
begin
  if (to_jsonb(new) ->> 'run_id', to_jsonb(new) ->> 'transaction_id', to_jsonb(new) ->> 'employee_id')
     is distinct from (to_jsonb(old) ->> 'run_id', to_jsonb(old) ->> 'transaction_id', to_jsonb(old) ->> 'employee_id') then
    raise exception 'a payroll approval stage identity is immutable' using errcode = '23514';
  end if;
  if old.state <> 'SUBMITTED' and new.state <> old.state then
    raise exception 'a payroll approval stage in % is final', old.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_run_approval_guard before update on payroll_run_approval for each row execute function hrms_payroll_stage_guard();
create trigger payroll_record_cover_guard before update on payroll_record_cover for each row execute function hrms_payroll_stage_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- DB110 payroll_hold (typed root payroll_hold)
-- ---------------------------------------------------------------------------------------------------------------
create table payroll_hold (
  id                          uuid primary key default gen_random_uuid(),
  company_id                  uuid not null references company (id) on delete restrict,
  employee_id                 uuid not null,
  payroll_record_id           uuid not null,
  run_id                      uuid not null,
  transaction_kind            text not null default 'payroll_hold' check (transaction_kind = 'payroll_hold'),
  transaction_id              uuid not null,
  -- PAYMENT_SAFETY_BLOCK: automatic, for a missing, invalid or unverified approved bank instruction (H2).
  -- POLICY_HOLD: proposed under an activated criterion. SALARY_STOP: an approved HOLD_DISBURSEMENT stop (FR-031).
  hold_kind                   text not null check (hold_kind in ('PAYMENT_SAFETY_BLOCK', 'POLICY_HOLD', 'SALARY_STOP')),
  criterion_id                uuid,
  salary_stop_id              uuid,
  policy_revision             text not null check (btrim(policy_revision) <> '' and length(policy_revision) <= 100),
  reason_code                 text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  reason                      text check (reason is null or (btrim(reason) <> '' and length(reason) <= 1000)),
  scope                       text not null check (scope in ('FULL', 'PARTIAL')),
  hold_amount                 numeric(19, 4) not null check (hold_amount > 0),
  currency_code               text not null check (currency_code ~ '^[A-Z]{3}$'),
  -- A replayed proposal returns the hold it created (no second hold).
  idempotency_key             text check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  state                       text not null check (state in ('PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW', 'RELEASED', 'REJECTED', 'WITHDRAWN')),
  proposed_at                 timestamptz not null default now(),
  proposed_by                 uuid not null references user_account (id) on delete restrict,
  effective_date              date not null,
  review_due_on               date not null,
  approved_at                 timestamptz,
  approved_by                 uuid references user_account (id) on delete restrict,
  release_criterion           text not null check (btrim(release_criterion) <> '' and length(release_criterion) <= 1000),
  evidence_reference          text not null check (btrim(evidence_reference) <> '' and length(evidence_reference) <= 500),
  -- Company-local date since which the case is unresolved (reminder cadence); null while resolved.
  unresolved_since            date,
  expired_at                  timestamptz,
  released_at                 timestamptz,
  released_by                 uuid references user_account (id) on delete restrict,
  released_assignment_id      uuid,
  release_reason              text check (release_reason is null or (btrim(release_reason) <> '' and length(release_reason) <= 1000)),
  release_evidence_reference  text check (release_evidence_reference is null or (btrim(release_evidence_reference) <> '' and length(release_evidence_reference) <= 500)),
  -- A safety block is released against the approved bank revision the releasing Admin verified (H2): approved
  -- through the bank-change workflow with verified evidence, or verified by the releasing Admin.
  release_bank_revision_id    uuid,
  release_bank_check          text check (release_bank_check in ('WORKFLOW_VERIFIED', 'ADMIN_VERIFIED')),
  closed_at                   timestamptz,
  created_at                  timestamptz not null default now(),
  created_by                  uuid references user_account (id) on delete restrict,
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references user_account (id) on delete restrict,
  version                     integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, employee_id),
  unique (company_id, transaction_id),
  unique (company_id, idempotency_key),
  foreign key (company_id, payroll_record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, payroll_record_id, run_id) references payroll_record (company_id, id, run_id) on delete restrict,
  foreign key (company_id, transaction_kind, transaction_id) references business_transaction (company_id, kind, id)
    on delete restrict deferrable initially deferred,
  foreign key (company_id, criterion_id) references payroll_hold_criterion (company_id, id) on delete restrict,
  foreign key (company_id, salary_stop_id, employee_id) references payroll_salary_stop (company_id, id, employee_id) on delete restrict,
  foreign key (company_id, release_bank_revision_id) references employee_private_profile_revision (company_id, id) on delete restrict,
  foreign key (company_id, released_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check (hold_kind <> 'POLICY_HOLD' or (criterion_id is not null and salary_stop_id is null and reason is not null)),
  check (hold_kind <> 'SALARY_STOP' or (criterion_id is not null and salary_stop_id is not null and reason is not null and scope = 'FULL')),
  check (hold_kind <> 'PAYMENT_SAFETY_BLOCK' or (criterion_id is null and salary_stop_id is null and scope = 'FULL')),
  check (idempotency_key is null or hold_kind = 'POLICY_HOLD'),
  check (review_due_on >= effective_date),
  check (hold_kind = 'PAYMENT_SAFETY_BLOCK' or state in ('PROPOSED', 'REJECTED', 'WITHDRAWN') or (approved_at is not null and approved_by is not null)),
  check ((approved_at is null) = (approved_by is null)),
  check (approved_by is null or approved_by <> proposed_by),
  check ((state = 'EXPIRED_REVIEW') = (expired_at is not null)),
  check ((state = 'RELEASED') = (released_at is not null)),
  check ((released_at is null) = (released_by is null) and (released_at is null) = (release_reason is null)
         and (released_at is null) = (release_evidence_reference is null) and (released_at is null) = (released_assignment_id is null)),
  check (release_bank_revision_id is null or hold_kind = 'PAYMENT_SAFETY_BLOCK'),
  check (hold_kind <> 'PAYMENT_SAFETY_BLOCK' or state <> 'RELEASED' or release_bank_revision_id is not null),
  check ((release_bank_revision_id is null) = (release_bank_check is null)),
  check ((state in ('RELEASED', 'REJECTED', 'WITHDRAWN')) = (closed_at is not null)),
  check (state not in ('RELEASED', 'REJECTED', 'WITHDRAWN') or unresolved_since is null)
);
create index payroll_hold_record_idx on payroll_hold (company_id, payroll_record_id, state);
create index payroll_hold_open_idx on payroll_hold (company_id, state, review_due_on) where (state in ('PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW'));
create index payroll_hold_unresolved_idx on payroll_hold (company_id, id) where (unresolved_since is not null);
create index payroll_hold_release_bank_idx on payroll_hold (company_id, release_bank_revision_id) where (release_bank_revision_id is not null);

create function hrms_payroll_hold_guard() returns trigger language plpgsql as $$
declare
  rec payroll_record%rowtype;
  ru payroll_run%rowtype;
  bank_owner uuid;
  bank_category text;
begin
  if tg_op = 'INSERT' then
    select * into rec from payroll_record where company_id = new.company_id and id = new.payroll_record_id;
    select * into ru from payroll_run where company_id = new.company_id and id = rec.run_id;
    if rec.calculation_status is distinct from 'CALCULATED' then
      raise exception 'a hold applies to a calculated payroll record' using errcode = '23514';
    end if;
    -- A policy hold is proposed for a processed record; the automatic holds are placed by processing on each record
    -- it freezes (or by a release that leaves a bank problem), in the same transaction.
    if new.hold_kind = 'POLICY_HOLD' and ru.state is distinct from 'PROCESSED_LOCKED' then
      raise exception 'a hold applies to a processed payroll record' using errcode = '23514';
    end if;
    if new.hold_kind <> 'POLICY_HOLD'
       and (rec.frozen_at is null or not (ru.state = 'PROCESSED_LOCKED' or (ru.state = 'APPROVED' and ru.processing_started_at is not null))) then
      raise exception 'an automatic hold applies to a frozen payroll record' using errcode = '23514';
    end if;
    if new.currency_code <> rec.currency_code then
      raise exception 'a hold is in the currency of its payroll record' using errcode = '23514';
    end if;
    if (new.hold_kind = 'POLICY_HOLD' and new.state <> 'PROPOSED') or (new.hold_kind <> 'POLICY_HOLD' and new.state <> 'APPROVED_ACTIVE') then
      raise exception 'a policy hold starts as a proposal; automatic blocks and applied salary stops start active' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.employee_id, new.payroll_record_id, new.run_id, new.transaction_id, new.hold_kind, new.criterion_id, new.salary_stop_id,
      new.policy_revision, new.reason_code, new.reason, new.scope, new.hold_amount, new.currency_code, new.idempotency_key, new.proposed_at,
      new.proposed_by, new.effective_date, new.release_criterion, new.evidence_reference)
     is distinct from
     (old.employee_id, old.payroll_record_id, old.run_id, old.transaction_id, old.hold_kind, old.criterion_id, old.salary_stop_id,
      old.policy_revision, old.reason_code, old.reason, old.scope, old.hold_amount, old.currency_code, old.idempotency_key, old.proposed_at,
      old.proposed_by, old.effective_date, old.release_criterion, old.evidence_reference) then
    raise exception 'a hold case is immutable apart from its decisions' using errcode = '23514';
  end if;
  if old.approved_at is not null and (new.approved_at, new.approved_by) is distinct from (old.approved_at, old.approved_by) then
    raise exception 'the approval of a hold is final' using errcode = '23514';
  end if;
  -- H2: the beneficiary is never the decision maker (whatever the path, not only through the approval engine).
  if new.approved_by is not null and old.approved_by is null
     and exists (select 1 from user_employee_link l where l.company_id = new.company_id and l.user_id = new.approved_by and l.employee_id = new.employee_id) then
    raise exception 'the beneficiary of a hold never decides it' using errcode = '23514';
  end if;
  -- C4 / H4: the run's creator, preparer, reviewer and approver never decide or release a hold of its records.
  if ((new.approved_by is not null and old.approved_by is null) or (new.released_by is not null and old.released_by is null))
     and exists (select 1 from payroll_run pr where pr.company_id = new.company_id and pr.id = new.run_id
                   and coalesce(new.released_by, new.approved_by) in (pr.created_by, pr.calculated_by, pr.reviewed_by, pr.approved_by)) then
    raise exception 'a hold is decided and released independently of the payroll run it holds' using errcode = '23514';
  end if;
  if old.released_at is not null
     and (new.released_at, new.released_by, new.released_assignment_id, new.release_reason, new.release_evidence_reference, new.release_bank_revision_id, new.release_bank_check)
         is distinct from
         (old.released_at, old.released_by, old.released_assignment_id, old.release_reason, old.release_evidence_reference, old.release_bank_revision_id, old.release_bank_check) then
    raise exception 'the release of a hold is final' using errcode = '23514';
  end if;
  if new.review_due_on <> old.review_due_on and not (old.state = 'EXPIRED_REVIEW' and new.state = 'APPROVED_ACTIVE') then
    raise exception 'a review date changes only when an expired review is renewed' using errcode = '23514';
  end if;
  if new.released_by is not null and old.released_by is null then
    -- BR-050 / H4: the beneficiary never releases; a policy hold or applied stop is released by someone other than its maker.
    if exists (select 1 from user_employee_link l where l.company_id = new.company_id and l.user_id = new.released_by and l.employee_id = new.employee_id)
       or (new.hold_kind <> 'PAYMENT_SAFETY_BLOCK' and new.released_by = new.proposed_by) then
      raise exception 'a hold is released by an independent eligible administrator' using errcode = '23514';
    end if;
    if new.release_bank_revision_id is not null then
      select employee_id, category into bank_owner, bank_category from employee_private_profile_revision
       where company_id = new.company_id and id = new.release_bank_revision_id;
      if bank_owner is distinct from new.employee_id or bank_category is distinct from 'BANK' then
        raise exception 'a safety block is released against an approved bank revision of the same employee' using errcode = '23514';
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger payroll_hold_guard before insert or update on payroll_hold for each row execute function hrms_payroll_hold_guard();

-- H2 state machines, whatever the path: only the listed transitions exist and a closed state is final (a returned or
-- cancelled revision never becomes live again; a rejected, withdrawn or released hold never blocks again). The
-- maker of a policy hold never approves it (H2 "maker proposes; independent ... Admin decides").
create function hrms_payroll_state_transition() returns trigger language plpgsql as $$
begin
  if new.state is distinct from old.state and not (
       (tg_table_name = 'payroll_run' and (
            (old.state = 'DRAFT' and new.state in ('CALCULATED', 'CANCELLED'))
         or (old.state = 'CALCULATED' and new.state in ('IN_REVIEW', 'RETURNED', 'CANCELLED'))
         or (old.state = 'IN_REVIEW' and new.state in ('APPROVED', 'RETURNED', 'CANCELLED'))
         or (old.state = 'APPROVED' and new.state in ('PROCESSED_LOCKED', 'RETURNED', 'CANCELLED'))))
    or (tg_table_name = 'payroll_hold' and (
            (old.state = 'PROPOSED' and new.state in ('APPROVED_ACTIVE', 'REJECTED', 'WITHDRAWN'))
         or (old.state = 'APPROVED_ACTIVE' and new.state in ('EXPIRED_REVIEW', 'RELEASED'))
         or (old.state = 'EXPIRED_REVIEW' and new.state in ('APPROVED_ACTIVE', 'RELEASED'))))) then
    raise exception '% cannot move from % to %', tg_table_name, old.state, new.state using errcode = '23514';
  end if;
  if tg_table_name = 'payroll_hold' then
    if new.approved_by is not null and old.approved_by is null and new.approved_by = new.proposed_by then
      raise exception 'the maker of a hold never decides it' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
create trigger payroll_run_state_transition before update on payroll_run for each row execute function hrms_payroll_state_transition();
create trigger payroll_hold_state_transition before update on payroll_hold for each row execute function hrms_payroll_state_transition();

-- CI27 (hold part) / BR-050: live holds (proposed, active or awaiting review) never exceed the record's payable net
-- amount. Hook: once the payroll payment ledger exists (DB113/DB114/DB118, payroll-outputs stage), its pending
-- reservations and net confirmed payments also count against the same payable amount.
create function hrms_payroll_hold_capacity() returns trigger language plpgsql as $$
declare
  payable numeric;
  held numeric;
begin
  select net into payable from payroll_record where company_id = new.company_id and id = new.payroll_record_id;
  select coalesce(sum(hold_amount), 0) into held from payroll_hold
   where company_id = new.company_id and payroll_record_id = new.payroll_record_id and state in ('PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW');
  if payable is null or held > payable then
    raise exception 'held amounts exceed the payable amount of the payroll record' using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger payroll_hold_within_payable after insert or update on payroll_hold deferrable initially deferred
  for each row execute function hrms_payroll_hold_capacity();

-- Circular references: a consumed input and an applied stop point at the processed record.
alter table payroll_input add constraint payroll_input_consumed_record_fk
  foreign key (company_id, consumed_record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict;
alter table payroll_salary_stop add constraint payroll_salary_stop_applied_record_fk
  foreign key (company_id, applied_record_id, employee_id) references payroll_record (company_id, id, employee_id) on delete restrict;

-- ---------------------------------------------------------------------------------------------------------------
-- Typed roots: mirrors (checked at commit against the row as it is then), touch and no-delete triggers
-- ---------------------------------------------------------------------------------------------------------------
create function hrms_payroll_mirror() returns trigger language plpgsql as $$
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

do $$
declare
  t text;
begin
  foreach t in array array['payroll_run', 'payroll_run_approval', 'payroll_record_cover', 'payroll_input_batch', 'payroll_salary_stop', 'payroll_hold'] loop
    execute format('create constraint trigger %I after insert or update on %I deferrable initially deferred for each row execute function hrms_payroll_mirror()',
                   t || '_mirrors_transaction', t);
  end loop;
  foreach t in array array['payroll_head_revision', 'payroll_calendar', 'payroll_period', 'payroll_paid_day_policy', 'payroll_hold_criterion',
                           'payroll_salary_stop', 'payroll_input_batch', 'payroll_input', 'payroll_run', 'payroll_run_approval', 'payroll_run_member',
                           'payroll_record', 'payroll_exception', 'payroll_record_cover', 'payroll_hold'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- A period is fixed once a run or an input uses it.
create function hrms_payroll_period_guard() returns trigger language plpgsql as $$
begin
  if (new.calendar_id, new.period_code) is distinct from (old.calendar_id, old.period_code) then
    raise exception 'the calendar and code of a payroll period are fixed' using errcode = '23514';
  end if;
  if exists (select 1 from payroll_run where company_id = old.company_id and period_id = old.id)
     or exists (select 1 from payroll_input_batch where company_id = old.company_id and period_id = old.id)
     or exists (select 1 from payroll_salary_stop where company_id = old.company_id and period_id = old.id) then
    raise exception 'a payroll period is fixed once runs, inputs or salary stops use it' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger payroll_period_guard before update on payroll_period for each row execute function hrms_payroll_period_guard();

-- ---------------------------------------------------------------------------------------------------------------
-- Transaction kinds and state catalogues (DF03; CI12)
-- ---------------------------------------------------------------------------------------------------------------
insert into transaction_kind (kind, root_table, routing_kind) values
  ('payroll_run',          'payroll_run',          null),
  ('payroll_run_approval', 'payroll_run_approval', null),
  ('payroll_input_batch',  'payroll_input_batch',  null),
  ('payroll_salary_stop',  'payroll_salary_stop',  null),
  ('payroll_hold',         'payroll_hold',         null);
-- Covering approvals use the run approvers' list.
insert into transaction_kind (kind, root_table, routing_kind) values ('payroll_record_cover', 'payroll_record_cover', 'payroll_run_approval');

insert into transaction_state (kind, state, initial, terminal) values
  ('payroll_run', 'DRAFT',            true,  false),
  ('payroll_run', 'CALCULATED',       false, false),
  ('payroll_run', 'IN_REVIEW',        false, false),
  ('payroll_run', 'APPROVED',         false, false),
  ('payroll_run', 'PROCESSED_LOCKED', false, true),
  ('payroll_run', 'RETURNED',         false, true),
  ('payroll_run', 'CANCELLED',        false, true),
  ('payroll_run_approval', 'SUBMITTED', true,  false),
  ('payroll_run_approval', 'APPROVED',  false, true),
  ('payroll_run_approval', 'RETURNED',  false, true),
  ('payroll_run_approval', 'CANCELLED', false, true),
  ('payroll_record_cover', 'SUBMITTED', true,  false),
  ('payroll_record_cover', 'APPROVED',  false, true),
  ('payroll_record_cover', 'RETURNED',  false, true),
  ('payroll_record_cover', 'CANCELLED', false, true),
  ('payroll_input_batch', 'DRAFT',     true,  false),
  ('payroll_input_batch', 'SUBMITTED', false, false),
  ('payroll_input_batch', 'APPROVED',  false, true),
  ('payroll_input_batch', 'REJECTED',  false, true),
  ('payroll_input_batch', 'CANCELLED', false, true),
  ('payroll_salary_stop', 'SUBMITTED', true,  false),
  ('payroll_salary_stop', 'APPROVED',  false, false),
  ('payroll_salary_stop', 'REJECTED',  false, true),
  ('payroll_salary_stop', 'WITHDRAWN', false, true),
  ('payroll_salary_stop', 'REVOKED',   false, true),
  ('payroll_salary_stop', 'APPLIED',   false, true),
  ('payroll_hold', 'PROPOSED',        true,  false),
  -- Automatic payment safety blocks and applied salary stops start active (no proposal).
  ('payroll_hold', 'APPROVED_ACTIVE', true,  false),
  ('payroll_hold', 'EXPIRED_REVIEW',  false, false),
  ('payroll_hold', 'RELEASED',        false, true),
  ('payroll_hold', 'REJECTED',        false, true),
  ('payroll_hold', 'WITHDRAWN',       false, true);

insert into transaction_transition (kind, from_state, to_state) values
  ('payroll_run', 'DRAFT',      'CALCULATED'),
  ('payroll_run', 'DRAFT',      'CANCELLED'),
  ('payroll_run', 'CALCULATED', 'IN_REVIEW'),
  ('payroll_run', 'CALCULATED', 'RETURNED'),
  ('payroll_run', 'CALCULATED', 'CANCELLED'),
  ('payroll_run', 'IN_REVIEW',  'APPROVED'),
  ('payroll_run', 'IN_REVIEW',  'RETURNED'),
  ('payroll_run', 'IN_REVIEW',  'CANCELLED'),
  ('payroll_run', 'APPROVED',   'PROCESSED_LOCKED'),
  ('payroll_run', 'APPROVED',   'RETURNED'),
  ('payroll_run', 'APPROVED',   'CANCELLED'),
  ('payroll_run_approval', 'SUBMITTED', 'APPROVED'),
  ('payroll_run_approval', 'SUBMITTED', 'RETURNED'),
  ('payroll_run_approval', 'SUBMITTED', 'CANCELLED'),
  ('payroll_record_cover', 'SUBMITTED', 'APPROVED'),
  ('payroll_record_cover', 'SUBMITTED', 'RETURNED'),
  ('payroll_record_cover', 'SUBMITTED', 'CANCELLED'),
  ('payroll_input_batch', 'DRAFT',     'SUBMITTED'),
  ('payroll_input_batch', 'DRAFT',     'CANCELLED'),
  ('payroll_input_batch', 'SUBMITTED', 'APPROVED'),
  ('payroll_input_batch', 'SUBMITTED', 'REJECTED'),
  ('payroll_input_batch', 'SUBMITTED', 'CANCELLED'),
  ('payroll_salary_stop', 'SUBMITTED', 'APPROVED'),
  ('payroll_salary_stop', 'SUBMITTED', 'REJECTED'),
  ('payroll_salary_stop', 'SUBMITTED', 'WITHDRAWN'),
  ('payroll_salary_stop', 'APPROVED',  'REVOKED'),
  ('payroll_salary_stop', 'APPROVED',  'APPLIED'),
  ('payroll_hold', 'PROPOSED',        'APPROVED_ACTIVE'),
  ('payroll_hold', 'PROPOSED',        'REJECTED'),
  ('payroll_hold', 'PROPOSED',        'WITHDRAWN'),
  ('payroll_hold', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW'),
  ('payroll_hold', 'APPROVED_ACTIVE', 'RELEASED'),
  ('payroll_hold', 'EXPIRED_REVIEW',  'RELEASED'),
  ('payroll_hold', 'EXPIRED_REVIEW',  'APPROVED_ACTIVE');

-- ---------------------------------------------------------------------------------------------------------------
-- Permission catalogue. Configuration, run state and counts are operational; amounts, exceptions about named
-- employees, inputs, stops, holds and criteria are confidential (DF02: payroll totals inherit salary classification).
-- Confidential duties run only in an independently approved eligible Admin assignment (DF02; OQ27).
-- ---------------------------------------------------------------------------------------------------------------
insert into permission (resource, action, field_group, own_ess) values
  ('payroll_config', 'read',     'operational', false),
  ('payroll_config', 'manage',   'operational', false),
  ('payroll_config', 'activate', 'operational', false),
  ('payroll_run',    'read',     'operational', false),
  ('payroll_run',    'read',     'amount',      false),
  ('payroll_run',    'prepare',  'amount',      false),
  ('payroll_run',    'review',   'amount',      false),
  ('payroll_run',    'approve',  'amount',      false),
  ('payroll_run',    'process',  'amount',      false),
  ('payroll_run',    'cancel',   'amount',      false),
  ('payroll_input',  'read',     'amount',      false),
  ('payroll_input',  'prepare',  'amount',      false),
  ('payroll_input',  'approve',  'amount',      false),
  ('payroll_stop',   'read',     'hold',        false),
  ('payroll_stop',   'propose',  'hold',        false),
  ('payroll_stop',   'decide',   'hold',        false),
  ('payroll_hold',   'read',     'hold',        false),
  ('payroll_hold',   'propose',  'hold',        false),
  ('payroll_hold',   'decide',   'hold',        false),
  ('payroll_hold',   'release',  'hold',        false),
  ('payroll_hold',   'define_criterion',   'hold', false),
  ('payroll_hold',   'activate_criterion', 'hold', false);
