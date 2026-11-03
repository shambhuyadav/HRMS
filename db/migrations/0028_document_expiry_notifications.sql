-- 0028 Document-expiry notification recipients (DF12 "document expiry"; FR-084; DF02).
-- DOCUMENT_READERS: the users who can currently read the subject employee's documents, i.e. an active,
-- approved assignment whose role ceiling ALLOWs and whose DB109 allowlist holds document.read.document and
-- whose row scope covers the employee. The dispatcher resolves them with the C1 access decision and checks
-- them again at delivery; a notification never grants access to the documents themselves.

alter table notification_rule drop constraint notification_rule_recipient_selector_check;
alter table notification_rule add constraint notification_rule_recipient_selector_check check (recipient_selector in
  ('ASSIGNED_REVIEWER', 'SUBJECT_EMPLOYEE', 'SUBJECT_MANAGER', 'BENEFICIARY_USER', 'COMPANY_CELEBRATION_AUDIENCE', 'FALLBACK_REVIEWERS',
   'DOCUMENT_READERS'));
