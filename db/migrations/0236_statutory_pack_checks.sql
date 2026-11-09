-- I-85 / I-90 follow-up (P8a gap 1, decided under owner delegation, 6 Nov 2026): the database checks a statutory pack revision's
-- parameters as the build reads them, and ties every pin of a payroll run to the revision it copied.
--
-- 1. statutory_rule_pack gains a check per pack family, mirroring the pack definitions' `validate` (statutory/rule-packs.ts,
--    statutory/income-tax.ts): PF, ESIC, professional tax (PT_<state>) and INCOME_TAX, as GRATUITY already has (0235). The API
--    refuses such values first with its own problems list; these checks are the backstop for anything written past it.
-- 2. payroll_run_rule_pack (code, revision) references statutory_rule_pack (code, revision), and its insert guard also refuses a pin
--    whose currency or parameters differ from that revision's, or of a revision never activated or not yet in effect on the service
--    period's last day. A pin of "none active" (no revision) stays as it was.
-- Upgrade safety: each constraint is added NOT VALID and validated only when every stored row satisfies it, so a database holding an
-- older, unreadable revision still upgrades. Such a revision keeps blocking with RULE_PACK_INVALID, and the database refuses to move it
-- to another state. Nothing stored is changed.

-- Shared value checks: a decimal amount in text with at most `places` decimals; a percentage from 0 to 100 in text (four decimals).
create function hrms_statutory_amount_ok(v jsonb, places integer) returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(v) = 'string' and (v #>> '{}') ~ ('^\d{1,15}(\.\d{1,' || places || '})?$'), false)
$$;

create function hrms_statutory_percent_ok(v jsonb) returns boolean language plpgsql immutable as $$
begin
  if v is null or jsonb_typeof(v) <> 'string' or (v #>> '{}') !~ '^\d{1,3}(\.\d{1,4})?$' then
    return false;
  end if;
  return (v #>> '{}')::numeric <= 100;
end $$;

-- An object whose keys are all among `allowed` (false for anything but an object).
create function hrms_statutory_keys_ok(p jsonb, allowed text[]) returns boolean language plpgsql immutable as $$
begin
  if jsonb_typeof(p) is distinct from 'object' then
    return false;
  end if;
  return not exists (select 1 from jsonb_object_keys(p) k where k <> all (allowed));
end $$;

create function hrms_statutory_rounding_ok(v jsonb) returns boolean language sql immutable as $$
  select coalesce(jsonb_typeof(v) = 'string' and (v #>> '{}') in ('HALF_UP_WHOLE', 'UP_WHOLE'), false)
$$;

-- PF (rule-packs.ts PF.validate)
create function hrms_pf_pack_parameters_ok(p jsonb) returns boolean language plpgsql immutable as $$
begin
  if jsonb_typeof(p) is distinct from 'object'
     or not hrms_statutory_keys_ok(p, array['wageCeiling', 'employeeRatePercent', 'employerRatePercent', 'pensionRatePercent', 'pensionWageCeiling', 'edliRatePercent', 'edliWageCeiling', 'adminChargesRatePercent', 'rounding']) then
    return false;
  end if;
  if not (hrms_statutory_amount_ok(p -> 'wageCeiling', 4) and hrms_statutory_amount_ok(p -> 'pensionWageCeiling', 4) and hrms_statutory_amount_ok(p -> 'edliWageCeiling', 4)
          and hrms_statutory_percent_ok(p -> 'employeeRatePercent') and hrms_statutory_percent_ok(p -> 'employerRatePercent') and hrms_statutory_percent_ok(p -> 'pensionRatePercent')
          and hrms_statutory_percent_ok(p -> 'edliRatePercent') and hrms_statutory_percent_ok(p -> 'adminChargesRatePercent') and hrms_statutory_rounding_ok(p -> 'rounding')) then
    return false;
  end if;
  -- The pension share is part of the employer's contribution.
  return (p ->> 'pensionRatePercent')::numeric <= (p ->> 'employerRatePercent')::numeric;
end $$;

-- ESIC (rule-packs.ts ESIC.validate)
create function hrms_esic_pack_parameters_ok(p jsonb) returns boolean language plpgsql immutable as $$
declare
  m jsonb;
  n numeric;
  prev numeric := 0;
begin
  if jsonb_typeof(p) is distinct from 'object' or not hrms_statutory_keys_ok(p, array['wageCeiling', 'employeeRatePercent', 'employerRatePercent', 'contributionPeriodStartMonths', 'rounding']) then
    return false;
  end if;
  if not (hrms_statutory_amount_ok(p -> 'wageCeiling', 4) and hrms_statutory_percent_ok(p -> 'employeeRatePercent') and hrms_statutory_percent_ok(p -> 'employerRatePercent')
          and hrms_statutory_rounding_ok(p -> 'rounding')) then
    return false;
  end if;
  if jsonb_typeof(p -> 'contributionPeriodStartMonths') is distinct from 'array' or jsonb_array_length(p -> 'contributionPeriodStartMonths') = 0 then
    return false;
  end if;
  -- Months 1 to 12, whole, in ascending order.
  for m in select e.value from jsonb_array_elements(p -> 'contributionPeriodStartMonths') with ordinality e(value, i) order by e.i loop
    if jsonb_typeof(m) <> 'number' then
      return false;
    end if;
    n := (m #>> '{}')::numeric;
    if n <> trunc(n) or n < 1 or n > 12 or n <= prev then
      return false;
    end if;
    prev := n;
  end loop;
  return true;
end $$;

-- Professional tax of one state, PT_<state> (rule-packs.ts ptDefinition.validate)
create function hrms_pt_pack_parameters_ok(code text, p jsonb) returns boolean language plpgsql immutable as $$
declare
  s jsonb;
  i bigint;
  n integer;
  prev numeric;
  mk text;
  mv jsonb;
begin
  if jsonb_typeof(p) is distinct from 'object' or not hrms_statutory_keys_ok(p, array['stateCode', 'slabs']) then
    return false;
  end if;
  if jsonb_typeof(p -> 'stateCode') is distinct from 'string' or (p ->> 'stateCode') <> substr(code, 4) then
    return false;
  end if;
  if jsonb_typeof(p -> 'slabs') is distinct from 'array' then
    return false;
  end if;
  n := jsonb_array_length(p -> 'slabs');
  if n < 1 or n > 50 then
    return false;
  end if;
  for s, i in select e.value, e.i from jsonb_array_elements(p -> 'slabs') with ordinality e(value, i) order by e.i loop
    if jsonb_typeof(s) <> 'object' or not hrms_statutory_keys_ok(s, array['upTo', 'amount', 'monthAmounts']) then
      return false;
    end if;
    if i = n then
      -- The last slab has no upper limit, stated as null.
      if jsonb_typeof(s -> 'upTo') is distinct from 'null' then
        return false;
      end if;
    else
      if not hrms_statutory_amount_ok(s -> 'upTo', 4) then
        return false;
      end if;
      if prev is not null and (s ->> 'upTo')::numeric <= prev then
        return false;
      end if;
      prev := (s ->> 'upTo')::numeric;
    end if;
    if not hrms_statutory_amount_ok(s -> 'amount', 4) then
      return false;
    end if;
    if s ? 'monthAmounts' then
      if jsonb_typeof(s -> 'monthAmounts') <> 'object' then
        return false;
      end if;
      for mk, mv in select k.key, k.value from jsonb_each(s -> 'monthAmounts') k loop
        if mk !~ '^([1-9]|1[0-2])$' or not hrms_statutory_amount_ok(mv, 4) then
          return false;
        end if;
      end loop;
    end if;
  end loop;
  return true;
end $$;

-- INCOME_TAX, one regime (income-tax.ts checkRegime): amounts have at most two decimals.
create function hrms_income_tax_regime_ok(r jsonb) returns boolean language plpgsql immutable as $$
declare
  s jsonb;
  i bigint;
  n integer;
  prev numeric;
begin
  if jsonb_typeof(r) is distinct from 'object' or not hrms_statutory_keys_ok(r, array['standardDeduction', 'slabs', 'rebate', 'surcharge', 'cessPercent', 'rounding']) then
    return false;
  end if;
  if not hrms_statutory_amount_ok(r -> 'standardDeduction', 2) or not hrms_statutory_percent_ok(r -> 'cessPercent') then
    return false;
  end if;
  if coalesce(jsonb_typeof(r -> 'rounding') = 'string' and (r ->> 'rounding') in ('NEAREST_TEN', 'NEAREST_RUPEE'), false) is false then
    return false;
  end if;
  if jsonb_typeof(r -> 'slabs') is distinct from 'array' then
    return false;
  end if;
  n := jsonb_array_length(r -> 'slabs');
  if n < 1 or n > 20 then
    return false;
  end if;
  for s, i in select e.value, e.i from jsonb_array_elements(r -> 'slabs') with ordinality e(value, i) order by e.i loop
    if jsonb_typeof(s) <> 'object' then
      return false;
    end if;
    if i = n then
      if jsonb_typeof(s -> 'upTo') is distinct from 'null' then
        return false;
      end if;
    else
      if not hrms_statutory_amount_ok(s -> 'upTo', 2) then
        return false;
      end if;
      if prev is not null and (s ->> 'upTo')::numeric <= prev then
        return false;
      end if;
      prev := (s ->> 'upTo')::numeric;
    end if;
    if not hrms_statutory_percent_ok(s -> 'ratePercent') then
      return false;
    end if;
  end loop;
  if jsonb_typeof(r -> 'rebate') is distinct from 'object'
     or not hrms_statutory_amount_ok(r #> '{rebate,incomeUpTo}', 2) or not hrms_statutory_amount_ok(r #> '{rebate,maxAmount}', 2)
     or jsonb_typeof(r #> '{rebate,marginalRelief}') is distinct from 'boolean' then
    return false;
  end if;
  if jsonb_typeof(r -> 'surcharge') is distinct from 'array' or jsonb_array_length(r -> 'surcharge') > 10 then
    return false;
  end if;
  prev := null;
  for s in select e.value from jsonb_array_elements(r -> 'surcharge') with ordinality e(value, i) order by e.i loop
    if jsonb_typeof(s) <> 'object' or not hrms_statutory_amount_ok(s -> 'incomeAbove', 2) or not hrms_statutory_percent_ok(s -> 'ratePercent') then
      return false;
    end if;
    if prev is not null and (s ->> 'incomeAbove')::numeric <= prev then
      return false;
    end if;
    prev := (s ->> 'incomeAbove')::numeric;
  end loop;
  return true;
end $$;

-- INCOME_TAX (income-tax.ts validateIncomeTax): a year like 2026-27, a default regime, and both regimes.
create function hrms_income_tax_pack_parameters_ok(p jsonb) returns boolean language plpgsql immutable as $$
begin
  if jsonb_typeof(p) is distinct from 'object' or not hrms_statutory_keys_ok(p, array['fiscalYear', 'defaultRegime', 'regimes']) then
    return false;
  end if;
  if jsonb_typeof(p -> 'fiscalYear') is distinct from 'string' or (p ->> 'fiscalYear') !~ '^\d{4}-\d{2}$' then
    return false;
  end if;
  if (substr(p ->> 'fiscalYear', 1, 4)::integer + 1) % 100 <> substr(p ->> 'fiscalYear', 6, 2)::integer then
    return false;
  end if;
  if coalesce(jsonb_typeof(p -> 'defaultRegime') = 'string' and (p ->> 'defaultRegime') in ('NEW', 'OLD'), false) is false then
    return false;
  end if;
  if jsonb_typeof(p -> 'regimes') is distinct from 'object' or not hrms_statutory_keys_ok(p -> 'regimes', array['NEW', 'OLD']) then
    return false;
  end if;
  return hrms_income_tax_regime_ok(p #> '{regimes,NEW}') and hrms_income_tax_regime_ok(p #> '{regimes,OLD}');
end $$;

-- 1. The checks
alter table statutory_rule_pack add constraint statutory_rule_pack_pf_parameters_check check (code <> 'PF' or hrms_pf_pack_parameters_ok(parameters)) not valid;
alter table statutory_rule_pack add constraint statutory_rule_pack_esic_parameters_check check (code <> 'ESIC' or hrms_esic_pack_parameters_ok(parameters)) not valid;
alter table statutory_rule_pack add constraint statutory_rule_pack_pt_parameters_check check (code !~ '^PT_[A-Z]{2}$' or hrms_pt_pack_parameters_ok(code, parameters)) not valid;
alter table statutory_rule_pack add constraint statutory_rule_pack_income_tax_parameters_check check (code <> 'INCOME_TAX' or hrms_income_tax_pack_parameters_ok(parameters)) not valid;

-- 2. The pins
alter table payroll_run_rule_pack add constraint payroll_run_rule_pack_pack_fk
  foreign key (company_id, pack_code, pack_revision) references statutory_rule_pack (company_id, code, revision) on delete restrict not valid;

create or replace function hrms_payroll_run_rule_pack_guard() returns trigger language plpgsql as $$
declare
  v_end date;
begin
  select ru.service_end into v_end from payroll_run ru where ru.company_id = new.company_id and ru.id = new.run_id and ru.state = 'DRAFT' and ru.calculation_started_at is not null;
  if not found then
    raise exception 'the rule packs of a payroll run are fixed by its calculation' using errcode = '23514';
  end if;
  -- A pinned revision is one that was activated (it may have been retired since), in effect by the service period's last day, copied as
  -- it is. (Which active revision was the latest is fixed by the calculation's own read; a retirement racing it cannot make this refuse.)
  if new.pack_revision is not null and not exists (
       select 1 from statutory_rule_pack p
        where p.company_id = new.company_id and p.code = new.pack_code and p.revision = new.pack_revision
          and p.state in ('ACTIVE', 'RETIRED') and p.effective_from <= v_end
          and p.currency_code = new.currency_code and p.parameters = new.parameters) then
    raise exception 'a payroll run pins an activated pack revision in effect for its period, with that revision''s currency and parameters' using errcode = '23514';
  end if;
  return new;
end $$;

-- Validate whatever every stored row already satisfies; leave the rest NOT VALID (still enforced on every new or changed row).
do $$
declare
  c record;
begin
  for c in select conrelid::regclass::text as tbl, conname from pg_constraint
            where conname in ('statutory_rule_pack_pf_parameters_check', 'statutory_rule_pack_esic_parameters_check', 'statutory_rule_pack_pt_parameters_check',
                              'statutory_rule_pack_income_tax_parameters_check', 'payroll_run_rule_pack_pack_fk')
              and not convalidated loop
    begin
      execute format('alter table %s validate constraint %I', c.tbl, c.conname);
    exception when check_violation or foreign_key_violation then
      raise notice '% on % is left NOT VALID: a stored row predates it', c.conname, c.tbl;
    end;
  end loop;
end $$;
