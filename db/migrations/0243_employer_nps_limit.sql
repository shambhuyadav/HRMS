-- I-90 follow-up, the employer's NPS contribution (s.80CCD(2) of the 1961 Act, to be validated against the Income-tax Act, 2025; decided
-- under owner delegation, 6 Nov 2026): the deduction is capped at a share of salary (Basic and DA, the heads treated SALARY_FOR_HRA), the
-- regime's optional `employerNpsLimitPercent` (14 in the new regime and 10 in the old in the FY 2026-27 seed of statutory/income-tax.ts).
-- The INCOME_TAX regime check (0236, extended by 0238 for `hraExemption`) accepts it as a percent from 0 to 100; a draft seeded before
-- stays without it (no cap is applied then, as before), and values change only by a new revision. The SALARY_FOR_HRA treatment's label
-- (0238) now says it measures this limit too, where the company has not relabelled it.

update reference_value
   set label = 'Taxable, and salary (Basic and DA) for the house rent allowance exemption and the employer NPS limit'
 where category = 'PAYROLL_TAX_TREATMENT' and code = 'SALARY_FOR_HRA'
   and label = 'Taxable, and salary for the house rent allowance exemption (Basic and DA)';

create or replace function hrms_income_tax_regime_ok(r jsonb) returns boolean language plpgsql immutable as $$
declare
  s jsonb;
  i bigint;
  n integer;
  prev numeric;
begin
  if jsonb_typeof(r) is distinct from 'object'
     or not hrms_statutory_keys_ok(r, array['standardDeduction', 'slabs', 'rebate', 'surcharge', 'cessPercent', 'rounding', 'hraExemption', 'employerNpsLimitPercent']) then
    return false;
  end if;
  if r ? 'hraExemption' then
    if not hrms_statutory_keys_ok(r -> 'hraExemption', array['metroPercent', 'otherPercent', 'rentAboveSalaryPercent'])
       or not hrms_statutory_percent_ok(r #> '{hraExemption,metroPercent}') or not hrms_statutory_percent_ok(r #> '{hraExemption,otherPercent}')
       or not hrms_statutory_percent_ok(r #> '{hraExemption,rentAboveSalaryPercent}') then
      return false;
    end if;
  end if;
  if r ? 'employerNpsLimitPercent' and not hrms_statutory_percent_ok(r -> 'employerNpsLimitPercent') then
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
