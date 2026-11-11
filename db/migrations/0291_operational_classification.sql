-- 0291 Classification of three new resources in companies provisioned before them (found on 11 Nov 2026 by the duty refresh's dry run on
-- the live database). A resource and field group with no confidential_field_policy row reads as CONFIDENTIAL (the safe default), so
-- the operational groups of 0261 (document_requirement: the mandatory document types), 0262 (appraisal_distribution: the bell curve
-- bands) and 0290 (announcement: events and ticker messages) became confidential in every company that existed before them; a
-- company provisioned since gets them operational from its module registrations (documents, appraisal, announcements), as declared.
-- This writes the same OPERATIONAL classification for the existing companies, as 0270 does for its own resources: dated and approved
-- like each company's employee operational classification, and nothing where a row already exists. None of the three holds anything
-- about an employee.
--
-- To reverse: end these rows (the classification is dated; it is never deleted).

insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
select cfp.company_id, g.resource, 'operational', 'OPERATIONAL', cfp.effective_from, cfp.approved_by, now(), cfp.approved_by
  from confidential_field_policy cfp
 cross join (values ('document_requirement'), ('appraisal_distribution'), ('announcement')) g (resource)
 where cfp.resource_code = 'employee' and cfp.field_group = 'operational' and cfp.effective_to is null
   and not exists (select 1 from confidential_field_policy x where x.company_id = cfp.company_id and x.resource_code = g.resource and x.field_group = 'operational');
