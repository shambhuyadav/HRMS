-- 0092 In-app notices for the events DF12 and H7 require that the outbox used to consume without effect (FR-079, FR-084,
-- FR-088; BR-033; I-60). The application's catalogue is modules/notification/catalogue.ts, which provisions new companies;
-- this migration gives companies that already exist the same templates and rules (events-mapping.api.test.ts compares them).
--
-- New recipient selectors, each resolved by the dispatcher and checked again at delivery; a notice never grants access:
--   PROPOSER_OR_MANAGER  whoever proposed the transaction and, where its describer says so, the subject employee's current
--                        direct manager, while their row scope still covers the employee (I-52);
--   BIOMETRIC_SUPPORT    holders of biometric.sync_run in an unrestricted company assignment, as FR-088's support recipients;
--   GRANT_APPROVERS      holders of access.approve_role_grant whose company scope contains the pending grant's scope, never
--                        its beneficiary or requester (C4).
--
-- The selector list is extended rather than restated, so any selector another migration has added stays allowed. Since 0060
-- the check holds an array literal ('{A,B}'::text[]), which 0060's own pattern for 'A'::text items would not find, so both
-- forms are read, and a list that lost a selector known to be there stops the migration.
do $$
declare
  allowed text[];
begin
  select array_agg(distinct v order by v) into allowed
    from (select m[1] as v
            from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([A-Z][A-Z0-9_]*)''', 'g') as m
           where c.conrelid = 'notification_rule'::regclass and c.conname = 'notification_rule_recipient_selector_check'
          union
          select unnest(string_to_array((regexp_match(pg_get_constraintdef(c.oid), '''\{([A-Z0-9_,]*)\}'''))[1], ','))
            from pg_constraint c
           where c.conrelid = 'notification_rule'::regclass and c.conname = 'notification_rule_recipient_selector_check'
          union select unnest(array['PROPOSER_OR_MANAGER', 'BIOMETRIC_SUPPORT', 'GRANT_APPROVERS'])) s;
  if not allowed @> array['ASSIGNED_REVIEWER', 'DOCUMENT_READERS', 'POLICY_MANAGERS'] then
    raise exception 'the recipient selector list could not be read: %', allowed;
  end if;
  alter table notification_rule drop constraint notification_rule_recipient_selector_check;
  execute format('alter table notification_rule add constraint notification_rule_recipient_selector_check check (recipient_selector = any (%L::text[]))', allowed);
end $$;

-- All mandatory (DF12: only celebrations and the email digest can be opted out of). Placeholders are identifiers, dates and
-- states only. A rule starts now: events already consumed stay consumed, and nothing is notified about them after the fact.
create temporary table hrms_0092_catalogue (code text, event_type text, selector text, subject text, body text, placeholders text[]) on commit drop;
insert into hrms_0092_catalogue (code, event_type, selector, subject, body, placeholders) values
  ('EXPENSE_SUBMITTED', 'EXPENSE_SUBMITTED', 'ASSIGNED_REVIEWER',
   'Expense claim waiting for you',
   'An expense claim from {{employeeName}} ({{employeeCode}}), submitted on {{submittedDate}}, is waiting for your {{step}}.',
   array['employeeName', 'employeeCode', 'submittedDate', 'step']),
  ('EXPENSE_ASSIGNED', 'EXPENSE_ASSIGNED', 'ASSIGNED_REVIEWER',
   'Expense claim waiting for you',
   'An expense claim from {{employeeName}} ({{employeeCode}}), submitted on {{submittedDate}}, is waiting for your {{step}}.',
   array['employeeName', 'employeeCode', 'submittedDate', 'step']),
  ('EXPENSE_DECIDED', 'EXPENSE_DECIDED', 'SUBJECT_EMPLOYEE',
   'Expense claim {{outcome}}',
   'Your expense claim submitted on {{submittedDate}} was {{outcome}}.',
   array['submittedDate', 'outcome']),
  ('EXPENSE_WITHDRAWN', 'EXPENSE_WITHDRAWN', 'ASSIGNED_REVIEWER',
   'Expense claim withdrawn',
   'The expense claim from {{employeeName}} ({{employeeCode}}), submitted on {{submittedDate}}, was withdrawn.',
   array['employeeName', 'employeeCode', 'submittedDate']),
  ('EXPENSE_PAYMENT_STATUS', 'EXPENSE_PAYMENT_STATUS', 'SUBJECT_EMPLOYEE',
   'Expense payment {{paymentEvent}}',
   'The payment of your expense claim submitted on {{submittedDate}} was {{paymentEvent}}. Its payment status is now {{paymentStatus}}.',
   array['submittedDate', 'paymentEvent', 'paymentStatus']),
  ('INCREMENT_PROPOSED', 'INCREMENT_PROPOSED', 'ASSIGNED_REVIEWER',
   'Increment proposal waiting for you',
   'An increment proposal for {{employeeName}} ({{employeeCode}}) is waiting for your decision.',
   array['employeeName', 'employeeCode']),
  ('INCREMENT_DECIDED', 'INCREMENT_DECIDED', 'PROPOSER_OR_MANAGER',
   'Increment review {{outcome}}',
   'The increment review for {{employeeName}} ({{employeeCode}}) was decided: {{outcome}}.',
   array['employeeName', 'employeeCode', 'outcome']),
  ('BIOMETRIC_SYNC_FAILED', 'BIOMETRIC_SYNC_FAILED', 'BIOMETRIC_SUPPORT',
   'Biometric sync {{runState}}',
   'The biometric sync of profile {{profileCode}} ended {{runState}} ({{failureCode}}); the checkpoint stays at the last committed page.',
   array['profileCode', 'runState', 'failureCode']),
  ('ACCESS_GRANT_PROPOSED', 'ACCESS_GRANT_PROPOSED', 'GRANT_APPROVERS',
   'Role assignment waiting for approval',
   'A {{roleCode}} role assignment is waiting for your approval.',
   array['roleCode']),
  ('ACCESS_GRANT_ENDED', 'ACCESS_GRANT_ENDED', 'BENEFICIARY_USER',
   'Role assignment {{outcome}}',
   'A {{roleCode}} role assignment for you was {{outcome}}.',
   array['roleCode', 'outcome']),
  ('BANK_CHANGE_CUTOFF', 'BANK_CHANGE_CUTOFF', 'SUBJECT_EMPLOYEE',
   'Bank change after payroll cutoff',
   'Your change of bank details effective {{effectiveDate}} falls after the input cutoff ({{inputCutoff}}) of payroll period {{periodCode}}.',
   array['effectiveDate', 'inputCutoff', 'periodCode']),
  ('FILE_QUARANTINED', 'FILE_QUARANTINED', 'BENEFICIARY_USER',
   'Uploaded file failed the malware scan',
   'A file you uploaded on {{uploadedDate}} failed the malware scan and cannot be used; please upload a replacement.',
   array['uploadedDate']);

insert into notification_template (company_id, code, revision, language, channel, subject_template, body_template, approved_placeholders, active)
select c.id, k.code, 1, 'en', 'IN_APP', k.subject, k.body, k.placeholders, true
  from company c cross join hrms_0092_catalogue k
on conflict (company_id, code, revision, language, channel) do nothing;

insert into notification_rule (company_id, code, revision, event_type, channel, recipient_selector, template_code, template_revision, template_id,
                               optional_event, effective_from, active)
select t.company_id, t.code, 1, k.event_type, 'IN_APP', k.selector, t.code, 1, t.id, false, now(), true
  from hrms_0092_catalogue k
  join notification_template t on t.code = k.code and t.revision = 1 and t.language = 'en' and t.channel = 'IN_APP'
on conflict (company_id, code, revision) do nothing;
