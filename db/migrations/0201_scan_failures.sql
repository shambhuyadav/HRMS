-- 0201 Files whose malware scan could not be completed (I-84 item 8; decided under owner delegation, 6 Nov 2026; I-73 item 1; FR-106;
-- H4 "failed scan quarantines"; H7 "scan"; docs/09 §7.2, §8.3).
--
-- End state: unchanged in the schema. A file whose attempts ran out stays PENDING_SCAN with scan_failed_at set (0160): unusable, never
-- served, and not a finding, so never QUARANTINED, which stays the final state of a flagged file.
--   attachment.requeue_scan   sends named failed files back to the scan worker (storage/scan-failures.ts), with a reason, audited on the
--                             attachment. A default duty of new System Administrator assignments and a ceiling of that role only. It
--                             reads ids, dates, attempts and the failure class, so the group is classified OPERATIONAL here, as
--                             provisioning does for a new company (BR-043: an unclassified group is confidential).
--   FILE_SCAN_FAILED          the uploader's in-app notice, once per failure, naming the upload date only (DF12: mandatory).
-- Existing System Administrator assignments keep their frozen allowlists (0099): one that should requeue needs a new approved grant.
insert into permission (resource, action, field_group) values ('attachment', 'requeue_scan', 'operational') on conflict do nothing;

insert into role_permission (company_id, role_id, permission_id, effect)
select r.company_id, r.id, p.id, 'ALLOW'
  from role r
  join permission p on p.resource = 'attachment' and p.action = 'requeue_scan' and p.field_group = 'operational'
 where r.code = 'SYSTEM_ADMINISTRATOR'
on conflict (company_id, role_id, permission_id) do nothing;

insert into confidential_field_policy (company_id, resource_code, field_group, classification, effective_from, approved_by, approved_at, created_by)
select cfp.company_id, 'attachment', 'operational', 'OPERATIONAL', cfp.effective_from, cfp.approved_by, now(), cfp.approved_by
  from confidential_field_policy cfp
 where cfp.resource_code = 'employee' and cfp.field_group = 'operational' and cfp.effective_to is null
   and not exists (select 1 from confidential_field_policy x where x.company_id = cfp.company_id and x.resource_code = 'attachment' and x.field_group = 'operational');

-- The notice, as modules/notification/catalogue.ts provisions it for a new company. A company that already has the code keeps it.
insert into notification_template (company_id, code, revision, language, channel, subject_template, body_template, approved_placeholders, active)
select c.id, 'FILE_SCAN_FAILED', 1, 'en', 'IN_APP', 'Uploaded file could not be checked',
       'A file you uploaded on {{uploadedDate}} could not be checked for malware yet, so it cannot be used. You may upload it again; it stays blocked until the check completes.',
       array['uploadedDate'], true
  from company c
on conflict (company_id, code, revision, language, channel) do nothing;

insert into notification_rule (company_id, code, revision, event_type, channel, recipient_selector, template_code, template_revision, template_id,
                               optional_event, effective_from, active)
select t.company_id, t.code, 1, 'FILE_SCAN_FAILED', 'IN_APP', 'BENEFICIARY_USER', t.code, 1, t.id, false, now(), true
  from notification_template t
 where t.code = 'FILE_SCAN_FAILED' and t.revision = 1 and t.language = 'en' and t.channel = 'IN_APP'
on conflict (company_id, code, revision) do nothing;
