-- 0024 Shift-plan imports and employee-to-mobile-app links (FR-023; DF09; C4). Import jobs record the published
-- template they used (DF09 "published versioned templates").

alter table import_job add column template_code text check (template_code is null or template_code ~ '^[A-Z][A-Z0-9_]{0,59}$');

-- FR-023: an employee is associated with a mobile-app account only after an independent authorised review.
-- The app account reference is an opaque identifier issued by the mobile service (no device data is stored).
create table mobile_app_link (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  employee_id       uuid not null,
  app_account_ref   text not null check (app_account_ref ~ '^[A-Za-z0-9._:@-]{3,200}$'),
  state             text not null check (state in ('PENDING', 'ACTIVE', 'REJECTED', 'REVOKED')),
  requested_by      uuid not null references user_account (id) on delete restrict,
  decided_by        uuid references user_account (id) on delete restrict,
  decided_at        timestamptz,
  revoked_by        uuid references user_account (id) on delete restrict,
  revoked_at        timestamptz,
  revoke_reason     text check (revoke_reason is null or (btrim(revoke_reason) <> '' and length(revoke_reason) <= 1000)),
  replaces_link_id  uuid,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, replaces_link_id) references mobile_app_link (company_id, id) on delete restrict,
  check (state = 'PENDING' or (decided_by is not null and decided_at is not null)),
  check (state <> 'REVOKED' or (revoked_by is not null and revoked_at is not null and revoke_reason is not null)),
  -- C4: the requester never decides their own link request.
  check (decided_by is null or decided_by <> requested_by)
);
create unique index mobile_app_link_one_active_employee on mobile_app_link (company_id, employee_id) where (state = 'ACTIVE');
create unique index mobile_app_link_one_active_account on mobile_app_link (company_id, app_account_ref) where (state = 'ACTIVE');
create unique index mobile_app_link_one_pending on mobile_app_link (company_id, employee_id) where (state = 'PENDING');
create trigger mobile_app_link_touch before update on mobile_app_link for each row execute function hrms_touch();
create trigger mobile_app_link_no_delete before delete on mobile_app_link for each row execute function hrms_no_delete();

insert into permission (resource, action, field_group) values
  ('shift',       'import',  'operational'),
  ('mobile_link', 'request', 'operational'),
  ('mobile_link', 'read',    'operational'),
  ('mobile_link', 'approve', 'operational');
