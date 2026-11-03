-- 0013 My Team and role dashboards (DB107, DB108; FR-094-FR-097; BR-042; BR-045; DF16; DF17; F2; CI23).
-- Widgets carry a required permission and a controlled metric code; metric SQL lives in reviewed code, never
-- in user-entered configuration. Widget scope is always the acting assignment's scope (it cannot widen it).

create table role_dashboard_definition (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  role_id         uuid not null,
  dashboard_code  text not null check (dashboard_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  revision        integer not null check (revision > 0),
  title           text not null check (btrim(title) <> ''),
  state           text not null default 'DRAFT' check (state in ('DRAFT', 'ACTIVE', 'RETIRED')),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, role_id, dashboard_code, revision),
  foreign key (company_id, role_id) references role (company_id, id) on delete restrict
);
-- CI23: one active definition per role and code.
create unique index role_dashboard_one_active on role_dashboard_definition (company_id, role_id, dashboard_code) where (state = 'ACTIVE');

create table role_dashboard_widget (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  dashboard_id   uuid not null,
  permission_id  uuid not null references permission (id) on delete restrict,
  widget_code    text not null check (widget_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  position       integer not null check (position >= 0),
  title          text not null check (btrim(title) <> ''),
  metric_code    text not null check (metric_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  field_group    text not null check (field_group ~ '^[a-z][a-z0-9_]{0,59}$'),
  scope_rule     text not null check (scope_rule in ('ASSIGNMENT_SCOPE')),
  display_kind   text not null check (display_kind in ('COUNT', 'STATUS', 'BALANCE', 'LIST')),
  created_at     timestamptz not null default now(),
  created_by     uuid references user_account (id) on delete restrict,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references user_account (id) on delete restrict,
  version        integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, dashboard_id, widget_code),
  unique (company_id, dashboard_id, position),
  foreign key (company_id, dashboard_id) references role_dashboard_definition (company_id, id) on delete restrict
);

insert into permission (resource, action, field_group) values
  ('team', 'list', 'operational'),
  ('team', 'read', 'operational'),
  ('dashboard', 'read', 'operational');

do $$
declare
  t text;
begin
  foreach t in array array['role_dashboard_definition', 'role_dashboard_widget'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
end $$;
