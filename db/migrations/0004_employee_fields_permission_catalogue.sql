-- 0004 Employee work email (DF04 activation field) and the permission catalogue for the access, organisation
-- and employee modules (Appendix C3). Further modules append their own catalogue entries.

alter table employee add column work_email text
  check (work_email is null or (work_email = lower(btrim(work_email)) and work_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'));

-- DF04: work email unique among employee records in a company (records are never deleted, so this also
-- prevents silent reuse; a rehire is a new employment and must be given a distinct address or the old
-- record's address cleared through an audited change).
create unique index employee_work_email_uq on employee (company_id, work_email) where (work_email is not null);

create index employee_search_idx on employee (company_id, employee_code);
create index employment_assignment_lookup_idx on employment_assignment (company_id, department_id, location_id);

insert into permission (resource, action, field_group) values
  -- Employee (C3): identity/operational vs personal (confidential: DOB, private contact) are separate groups.
  ('employee', 'list',       'operational'),
  ('employee', 'read',       'operational'),
  ('employee', 'read',       'personal'),
  ('employee', 'create',     'operational'),
  ('employee', 'create',     'personal'),
  ('employee', 'update',     'operational'),
  ('employee', 'update',     'personal'),
  ('employee', 'deactivate', 'operational'),
  ('employee', 'export',     'operational'),
  ('employee', 'read_history', 'operational'),
  -- Organisation masters (FR-004)
  ('org_master', 'read',   'operational'),
  ('org_master', 'create', 'operational'),
  ('org_master', 'update', 'operational'),
  -- Access administration (C3)
  ('access', 'read_users',              'operational'),
  ('access', 'assign_role',             'operational'),
  ('access', 'approve_role_grant',      'operational'),
  ('access', 'revoke_role',             'operational'),
  ('access', 'maintain_role_permissions', 'operational'),
  -- Audit (FR-057/058)
  ('audit', 'read',   'operational'),
  ('audit', 'export', 'operational');
