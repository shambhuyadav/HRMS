-- 0005 Role-grant proposals (FR-067, DF02): a business purpose is recorded with every proposal and is
-- mandatory when any requested permission is confidential (enforced in the access service, which knows
-- the classification); the decision reason is kept for rejections and revocations.
alter table role_assignment add column purpose text check (purpose is null or btrim(purpose) <> '');
alter table role_assignment add column decision_reason text check (decision_reason is null or btrim(decision_reason) <> '');
alter table role_assignment add constraint role_assignment_revoked_reason
  check (state <> 'REVOKED' or decision_reason is not null) not valid;
-- NOT VALID: existing synthetic rows are left untouched; every new or updated row is checked.
