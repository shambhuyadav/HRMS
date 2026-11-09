-- I-90 follow-up, the house rent allowance exemption (decided under owner delegation, 6 Nov 2026). Rent paid is not a deduction: the
-- exemption under s.10(13A) and rule 2A of the 1961 Act (to be validated against the Income-tax Act, 2025) is the least of the allowance
-- received, the rent paid less 10% of salary, and 50% of salary (a house in Delhi, Mumbai, Kolkata or Chennai) or 40% elsewhere; salary
-- is Basic and DA. statutory/evaluate.ts and tax-declarations/form16.ts compute it; this migration gives them what they read:
--
-- 1. An INCOME_TAX regime may carry `hraExemption` {metroPercent, otherPercent, rentAboveSalaryPercent} (percents): the check of 0236
--    accepts it. The FY 2026-27 seed carries it for the old regime (statutory/income-tax.ts); a draft seeded before stays without it, and
--    values change only by a new revision, as every pack's do.
-- 2. Two payroll tax treatments, for every company (new companies get them at provisioning): HRA_RULE_2A, the allowance (taxable, less
--    the exemption), and SALARY_FOR_HRA, Basic and DA (taxable, and the salary the exemption is measured on).
-- 3. A declaration category for rent in one of the four cities, HRA_METRO, beside HRA (rent elsewhere), in the FY 2026-27 declaration
--    pack: for a company provisioned from now on (the seed function), and added to every pack still a DRAFT (categories are fixed once
--    a pack leaves DRAFT, 0128).

-- 1. The INCOME_TAX regime check, as 0236 with the optional exemption.
create or replace function hrms_income_tax_regime_ok(r jsonb) returns boolean language plpgsql immutable as $$
declare
  s jsonb;
  i bigint;
  n integer;
  prev numeric;
begin
  if jsonb_typeof(r) is distinct from 'object' or not hrms_statutory_keys_ok(r, array['standardDeduction', 'slabs', 'rebate', 'surcharge', 'cessPercent', 'rounding', 'hraExemption']) then
    return false;
  end if;
  if r ? 'hraExemption' then
    if not hrms_statutory_keys_ok(r -> 'hraExemption', array['metroPercent', 'otherPercent', 'rentAboveSalaryPercent'])
       or not hrms_statutory_percent_ok(r #> '{hraExemption,metroPercent}') or not hrms_statutory_percent_ok(r #> '{hraExemption,otherPercent}')
       or not hrms_statutory_percent_ok(r #> '{hraExemption,rentAboveSalaryPercent}') then
      return false;
    end if;
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

-- 2. The two tax treatments, for every company (provisioning adds them for a new one; payroll/registration.ts).
insert into reference_value (company_id, category, code, label, active, created_by)
select c.id, 'PAYROLL_TAX_TREATMENT', v.code, v.label, true, '00000000-0000-4000-8000-000000000001'
  from company c
 cross join (values
   ('HRA_RULE_2A', 'House rent allowance: taxable, less the exemption the income tax pack computes (s.10(13A))'),
   ('SALARY_FOR_HRA', 'Taxable, and salary for the house rent allowance exemption (Basic and DA)')) v (code, label)
on conflict (company_id, category, code) do nothing;

-- 3. Rent in one of the four cities.
create or replace function hrms_seed_tax_declaration_pack(p_company uuid) returns void language plpgsql as $$
declare
  pack uuid;
  actor uuid := '00000000-0000-4000-8000-000000000001';
begin
  if exists (select 1 from tax_rule_pack where company_id = p_company and code = 'INCOME_TAX_2026_27') then
    return;
  end if;
  insert into tax_rule_pack (company_id, code, revision, fiscal_period_code, period_start, period_end, cutoff_date, currency_code, currency_minor_unit,
                             source_reference, validation_reference, state, created_by, updated_by)
  values (p_company, 'INCOME_TAX_2026_27', 1, '2026-27', '2026-04-01', '2027-03-31', '2027-01-31', 'INR', 2,
          'Seeded by the system from the Income-tax Act, 1961 as amended by the Finance Act 2025 (FY 2025-26), carried to FY 2026-27. To be validated against the Income-tax Act, 2025 in force.',
          'Not yet validated: an authorised person validates the INCOME_TAX pack for this year before this pack is activated (docs/10 D1).',
          'DRAFT', actor, actor)
  returning id into pack;
  insert into tax_rule_pack_regime (company_id, pack_id, code, name, created_by) values
    (p_company, pack, 'NEW', 'New regime (the default)', actor),
    (p_company, pack, 'OLD', 'Old regime', actor);
  insert into tax_rule_pack_category (company_id, pack_id, regime_code, code, name, limit_amount, section_reference, created_by) values
    (p_company, pack, 'OLD', 'SEC_80C', 'Investments and payments (provident fund, life insurance, ELSS, tuition fees, housing loan principal)', 150000, 's.80C of the 1961 Act; to be validated against the 2025 Act', actor),
    (p_company, pack, 'OLD', 'SEC_80CCD_1B', 'Additional own contribution to the National Pension System', 50000, 's.80CCD(1B) of the 1961 Act; to be validated against the 2025 Act', actor),
    (p_company, pack, 'OLD', 'SEC_80D_SELF', 'Health insurance: self, spouse and children', 25000, 's.80D of the 1961 Act (50,000 where the insured is a senior citizen); to be validated against the 2025 Act', actor),
    (p_company, pack, 'OLD', 'SEC_80D_PARENTS', 'Health insurance: parents', 50000, 's.80D of the 1961 Act (25,000 where the parents are not senior citizens); to be validated against the 2025 Act', actor),
    (p_company, pack, 'OLD', 'SEC_24B', 'Interest on a housing loan for a self-occupied house', 200000, 's.24(b) of the 1961 Act; to be validated against the 2025 Act', actor),
    (p_company, pack, 'OLD', 'HRA', 'House rent allowance exemption (rent paid)', null, 's.10(13A) of the 1961 Act and rule 2A: the exemption is computed from salary, rent and city, not a fixed limit; to be validated against the 2025 Act', actor),
    (p_company, pack, 'OLD', 'HRA_METRO', 'House rent allowance exemption (rent paid for a house in Delhi, Mumbai, Kolkata or Chennai)', null, 's.10(13A) of the 1961 Act and rule 2A: 50% of salary in these four cities, 40% elsewhere; the exemption is computed, not a fixed limit; to be validated against the 2025 Act', actor),
    (p_company, pack, 'OLD', 'SEC_80E', 'Interest on an education loan', null, 's.80E of the 1961 Act (no limit on the interest); to be validated against the 2025 Act', actor),
    (p_company, pack, 'NEW', 'SEC_80CCD_2', 'Employer contribution to the National Pension System', null, 's.80CCD(2) of the 1961 Act (up to 14% of salary in the new regime): to be validated against the 2025 Act', actor);
end $$;

insert into tax_rule_pack_category (company_id, pack_id, regime_code, code, name, limit_amount, section_reference, created_by)
select p.company_id, p.id, 'OLD', 'HRA_METRO', 'House rent allowance exemption (rent paid for a house in Delhi, Mumbai, Kolkata or Chennai)', null,
       's.10(13A) of the 1961 Act and rule 2A: 50% of salary in these four cities, 40% elsewhere; the exemption is computed, not a fixed limit; to be validated against the 2025 Act',
       '00000000-0000-4000-8000-000000000001'
  from tax_rule_pack p
 where p.code = 'INCOME_TAX_2026_27' and p.state = 'DRAFT'
   and exists (select 1 from tax_rule_pack_regime g where g.company_id = p.company_id and g.pack_id = p.id and g.code = 'OLD')
   and not exists (select 1 from tax_rule_pack_category c where c.company_id = p.company_id and c.pack_id = p.id and c.code = 'HRA_METRO');
