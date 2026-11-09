-- I-90 follow-up, a previous employment in the year (Form 12B; decided under owner delegation, 6 Nov 2026). An employee who joins
-- during a financial year declares the salary and the tax deducted by an earlier employer that year (s.192(2) of the 1961 Act and
-- Form 12B, to be validated against the Income-tax Act, 2025). Neither is a deduction: statutory/evaluate.ts adds the salary to the
-- year's salary and the tax to the TDS already deducted, in payroll and in a final settlement; tax-declarations/form16.ts counts what
-- was proved. Two declaration categories in both regimes of the FY 2026-27 declaration pack: for a company provisioned from now on (the
-- seed function, as 0238 left it plus these), and added to every pack still a DRAFT (categories are fixed once a pack leaves DRAFT).

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
  insert into tax_rule_pack_category (company_id, pack_id, regime_code, code, name, limit_amount, section_reference, created_by)
  select p_company, pack, g.code, c.code, c.name, null, c.reference, actor
    from (values ('NEW'), ('OLD')) g (code)
   cross join (values
     ('PREV_EMPLOYER_SALARY', 'Taxable salary from an earlier employer this year (Form 12B)', 's.192(2) of the 1961 Act and Form 12B: added to the year''s salary, not a deduction; to be validated against the 2025 Act'),
     ('PREV_EMPLOYER_TDS', 'Tax deducted by an earlier employer this year (Form 12B)', 's.192(2) of the 1961 Act and Form 12B: counted as tax already deducted, not a deduction; to be validated against the 2025 Act')) c (code, name, reference);
end $$;

insert into tax_rule_pack_category (company_id, pack_id, regime_code, code, name, limit_amount, section_reference, created_by)
select p.company_id, p.id, g.code, c.code, c.name, null, c.reference, '00000000-0000-4000-8000-000000000001'
  from tax_rule_pack p
  join tax_rule_pack_regime g on g.company_id = p.company_id and g.pack_id = p.id and g.code in ('NEW', 'OLD')
 cross join (values
   ('PREV_EMPLOYER_SALARY', 'Taxable salary from an earlier employer this year (Form 12B)', 's.192(2) of the 1961 Act and Form 12B: added to the year''s salary, not a deduction; to be validated against the 2025 Act'),
   ('PREV_EMPLOYER_TDS', 'Tax deducted by an earlier employer this year (Form 12B)', 's.192(2) of the 1961 Act and Form 12B: counted as tax already deducted, not a deduction; to be validated against the 2025 Act')) c (code, name, reference)
 where p.code = 'INCOME_TAX_2026_27' and p.state = 'DRAFT'
   and not exists (select 1 from tax_rule_pack_category x where x.company_id = p.company_id and x.pack_id = p.id and x.regime_code = g.code and x.code = c.code);
