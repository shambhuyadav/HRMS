-- 0020 Private reasons are confidential (DF02; BR-043; BRD detail rule "Attendance and leave detail excludes
-- private reasons"; DF11 "notify employee only operational status/date").
-- Confirmation action reasons (recommendations, decisions) and attendance amendment reasons get their own
-- `reason` field group. No confidential_field_policy row marks them operational, so they are CONFIDENTIAL and
-- reach a caller only through an approved Admin/Manager assignment that grants the group (C1).
insert into permission (resource, action, field_group) values
  ('confirmation', 'read', 'reason'),
  ('attendance',   'read', 'reason');
