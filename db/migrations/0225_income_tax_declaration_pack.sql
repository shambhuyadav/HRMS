-- 0225 Income tax: the FY 2026-27 declaration registry (FR-036, FR-108; DF05; F4; docs/10 D1). Decided under owner delegation, 6 Nov 2026
-- (docs/03 I-90).
--
-- Two registries, linked: the declaration registry (tax_rule_pack, 0128) names the regimes an employee chooses from and the categories
-- they declare under, now with each category's limit and its section reference; the computation (slabs, standard deduction, rebate,
-- surcharge, cess) is the INCOME_TAX statutory_rule_pack (0235; statutory/income-tax.ts), validated by one authorised person and
-- activated by another. Declarations and proofs run on an active declaration pack as before (FR-036, FR-108); tax counts a declaration
-- only while both the declaration pack and an INCOME_TAX revision for its year are active, so nothing reaches tax until two people have
-- validated the law behind it.
--
-- Every company gets the FY 2026-27 declaration pack as a DRAFT written by the system actor (hrms_seed_tax_declaration_pack, also called
-- by the service for a company provisioned later). The Income-tax Act, 2025 applies from 1 April 2026 and renumbers the sections:
-- the limits and references are carried from the 1961 Act for review and recorded as "to be validated", never asserted.
alter table tax_rule_pack_category add column limit_amount numeric(19, 4) check (limit_amount is null or limit_amount > 0);
alter table tax_rule_pack_category add column section_reference text check (section_reference is null or (btrim(section_reference) <> '' and length(section_reference) <= 300));

create function hrms_seed_tax_declaration_pack(p_company uuid) returns void language plpgsql as $$
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
    (p_company, pack, 'OLD', 'SEC_80E', 'Interest on an education loan', null, 's.80E of the 1961 Act (no limit on the interest); to be validated against the 2025 Act', actor),
    (p_company, pack, 'NEW', 'SEC_80CCD_2', 'Employer contribution to the National Pension System', null, 's.80CCD(2) of the 1961 Act (up to 14% of salary in the new regime): to be validated against the 2025 Act', actor);
end $$;

do $$
declare
  c record;
begin
  for c in select id from company loop
    perform hrms_seed_tax_declaration_pack(c.id);
  end loop;
end $$;
