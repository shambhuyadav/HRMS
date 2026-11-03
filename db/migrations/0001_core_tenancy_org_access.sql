-- 0001 Core: tenancy, actors, organisation masters, employee, access model.
-- BRD v8.1 Appendix B: B1 conventions; DB001-DB018, DB106, DB109, role.access_class.
-- Proposed target schema for a new HRMS. It is not an extracted source schema.
--
-- Conventions (B1):
--   * uuid surrogate ids; tenant-owned tables carry company_id and UNIQUE (company_id, id)
--     so that every intra-tenant reference is a composite FK (company_id, x_id).
--   * Effective intervals are [from, to) with NULL to = open-ended; overlaps rejected by EXCLUDE.
--   * FK deletion is RESTRICT (the default NO ACTION is replaced explicitly where it matters).
--   * version is system-managed by hrms_touch(); applications update with WHERE version = expected.

create extension if not exists btree_gist;

-- ---------------------------------------------------------------------------
-- Generic triggers
-- ---------------------------------------------------------------------------

-- Bumps version/updated_at and protects creation metadata and tenant ownership.
create function hrms_touch() returns trigger language plpgsql as $$
begin
  if new.version is distinct from old.version then
    raise exception 'version is system-managed' using errcode = '23514';
  end if;
  if new.created_at is distinct from old.created_at or new.created_by is distinct from old.created_by then
    raise exception 'creation metadata is immutable' using errcode = '23514';
  end if;
  if (to_jsonb(new) ->> 'company_id') is distinct from (to_jsonb(old) ->> 'company_id') then
    raise exception 'company_id is immutable' using errcode = '23514';
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;

-- DF08: retained business records are never physically deleted.
create function hrms_no_delete() returns trigger language plpgsql as $$
begin
  raise exception '% rows cannot be deleted; deactivate or end-date instead', tg_table_name
    using errcode = '23514';
end $$;

-- ---------------------------------------------------------------------------
-- DB007 user_account (global root)
-- ---------------------------------------------------------------------------
create table user_account (
  id          uuid primary key default gen_random_uuid(),
  account_key text not null unique
              check (account_key = lower(btrim(account_key)) and length(account_key) between 3 and 200),
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0)
);

-- ---------------------------------------------------------------------------
-- DB001 company (tenant root)
-- ---------------------------------------------------------------------------
create table company (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name        text not null check (btrim(name) <> ''),
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0)
);

-- ---------------------------------------------------------------------------
-- DB002-DB005 organisation masters (identical shape)
-- ---------------------------------------------------------------------------
create table department (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name        text not null check (btrim(name) <> ''),
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id)
);

create table location (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name        text not null check (btrim(name) <> ''),
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id)
);

create table designation (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name        text not null check (btrim(name) <> ''),
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id)
);

create table grade (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name        text not null check (btrim(name) <> ''),
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id)
);

-- ---------------------------------------------------------------------------
-- DB006 reference_value
-- UNIQUE (company_id, category, id) lets referencing tables pin the category in the FK
-- itself (CI15): a status column cannot point at an employment-type value.
-- ---------------------------------------------------------------------------
create table reference_value (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references company (id) on delete restrict,
  category    text not null check (category ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  code        text not null check (code ~ '^[A-Z0-9][A-Z0-9_]{0,59}$'),
  label       text not null check (btrim(label) <> ''),
  active      boolean not null,
  created_at  timestamptz not null default now(),
  created_by  uuid references user_account (id) on delete restrict,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references user_account (id) on delete restrict,
  version     integer not null default 1 check (version > 0),
  unique (company_id, category, code),
  unique (company_id, category, id),
  unique (company_id, id)
);

-- ---------------------------------------------------------------------------
-- DB008 employee
-- Employee code is normalised (trimmed, upper case) and permanent per company (DF04);
-- because employees are never deleted, a retired code can never be reused.
-- ---------------------------------------------------------------------------
create table employee (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  employee_code             text not null
                            check (employee_code = upper(btrim(employee_code)) and employee_code <> ''),
  display_name              text not null check (btrim(display_name) <> ''),
  joining_date              date not null,
  confirmation_date         date check (confirmation_date >= joining_date),
  employment_type_category  text not null default 'EMPLOYMENT_TYPE' check (employment_type_category = 'EMPLOYMENT_TYPE'),
  employment_type_id        uuid not null,
  status_category           text not null default 'EMPLOYEE_STATUS' check (status_category = 'EMPLOYEE_STATUS'),
  status_id                 uuid not null,
  date_of_birth             date check (date_of_birth < joining_date),
  service_anniversary_date  date,
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, employee_code),
  unique (company_id, id),
  foreign key (company_id, employment_type_category, employment_type_id)
    references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, status_category, status_id)
    references reference_value (company_id, category, id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- DB009 user_employee_link: one employee per user and one user per employee at any date.
-- ---------------------------------------------------------------------------
create table user_employee_link (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  user_id         uuid not null references user_account (id) on delete restrict,
  employee_id     uuid not null,
  effective_from  date not null,
  effective_to    date check (effective_to > effective_from),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  exclude using gist (company_id with =, user_id with =, daterange(effective_from, effective_to, '[)') with &&),
  exclude using gist (company_id with =, employee_id with =, daterange(effective_from, effective_to, '[)') with &&)
);

-- ---------------------------------------------------------------------------
-- DB010 employment_assignment: one assignment per employee at any instant.
-- ---------------------------------------------------------------------------
create table employment_assignment (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  employee_id     uuid not null,
  department_id   uuid not null,
  location_id     uuid not null,
  designation_id  uuid not null,
  grade_id        uuid,
  effective_from  date not null,
  effective_to    date check (effective_to > effective_from),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, employee_id)    references employee (company_id, id)    on delete restrict,
  foreign key (company_id, department_id)  references department (company_id, id)  on delete restrict,
  foreign key (company_id, location_id)    references location (company_id, id)    on delete restrict,
  foreign key (company_id, designation_id) references designation (company_id, id) on delete restrict,
  foreign key (company_id, grade_id)       references grade (company_id, id)       on delete restrict,
  exclude using gist (company_id with =, employee_id with =, daterange(effective_from, effective_to, '[)') with &&)
);

-- ---------------------------------------------------------------------------
-- DB011 manager_assignment: one primary manager at any instant, no self, no cycle (CI13).
-- ---------------------------------------------------------------------------
create table manager_assignment (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  employee_id          uuid not null,
  manager_employee_id  uuid not null,
  effective_from       date not null,
  effective_to         date check (effective_to > effective_from),
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  check (employee_id <> manager_employee_id),
  foreign key (company_id, employee_id)         references employee (company_id, id) on delete restrict,
  foreign key (company_id, manager_employee_id) references employee (company_id, id) on delete restrict,
  exclude using gist (company_id with =, employee_id with =, daterange(effective_from, effective_to, '[)') with &&)
);
create index manager_assignment_manager_idx on manager_assignment (company_id, manager_employee_id);

-- Walks up the reporting chain from the new manager over periods that overlap the new row.
-- If the chain returns to the employee within a non-empty shared period, it is a cycle.
-- A per-company advisory lock serialises concurrent checks so two transactions cannot each
-- add half of a cycle unseen (READ COMMITTED re-snapshots after the lock is granted).
create function hrms_manager_cycle_check() returns trigger language plpgsql as $$
declare
  has_cycle boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended('manager_assignment:' || new.company_id::text, 0));
  with recursive chain (manager_id, period, depth) as (
    select new.manager_employee_id, daterange(new.effective_from, new.effective_to, '[)'), 1
    union all
    select m.manager_employee_id,
           c.period * daterange(m.effective_from, m.effective_to, '[)'),
           c.depth + 1
      from chain c
      join manager_assignment m
        on m.company_id = new.company_id
       and m.employee_id = c.manager_id
       and daterange(m.effective_from, m.effective_to, '[)') && c.period
     where c.manager_id <> new.employee_id
       and c.depth < 10000
  )
  select exists (select 1 from chain where manager_id = new.employee_id and not isempty(period))
    into has_cycle;
  if has_cycle then
    raise exception 'manager assignment creates a reporting cycle' using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger manager_assignment_no_cycle
  after insert or update on manager_assignment
  deferrable initially deferred
  for each row execute function hrms_manager_cycle_check();

-- ---------------------------------------------------------------------------
-- DB013 role with access_class (B10). BR-044: ADMIN only for System/HR Administrator,
-- MANAGER only for Reporting Manager. Widening eligibility needs a new migration,
-- which is the recorded owner decision.
-- ---------------------------------------------------------------------------
create table role (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references company (id) on delete restrict,
  code          text not null check (code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  name          text not null check (btrim(name) <> ''),
  active        boolean not null,
  access_class  text not null default 'OTHER' check (access_class in ('ADMIN', 'MANAGER', 'OTHER')),
  created_at    timestamptz not null default now(),
  created_by    uuid references user_account (id) on delete restrict,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references user_account (id) on delete restrict,
  version       integer not null default 1 check (version > 0),
  unique (company_id, code),
  unique (company_id, id),
  check (access_class <> 'ADMIN'   or code in ('SYSTEM_ADMINISTRATOR', 'HR_ADMINISTRATOR')),
  check (access_class <> 'MANAGER' or code = 'REPORTING_MANAGER')
);

-- ---------------------------------------------------------------------------
-- DB014 permission (global catalogue; no wildcard grants)
-- ---------------------------------------------------------------------------
create table permission (
  id           uuid primary key default gen_random_uuid(),
  resource     text not null check (resource ~ '^[a-z][a-z0-9_]{0,59}$'),
  action       text not null check (action ~ '^[a-z][a-z0-9_]{0,59}$'),
  field_group  text not null check (field_group ~ '^[a-z][a-z0-9_]{0,59}$'),
  created_at   timestamptz not null default now(),
  created_by   uuid references user_account (id) on delete restrict,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references user_account (id) on delete restrict,
  version      integer not null default 1 check (version > 0),
  unique (resource, action, field_group)
);

-- ---------------------------------------------------------------------------
-- DB015 role_permission
-- ---------------------------------------------------------------------------
create table role_permission (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  role_id        uuid not null,
  permission_id  uuid not null references permission (id) on delete restrict,
  effect         text not null check (effect in ('ALLOW', 'DENY')),
  created_at     timestamptz not null default now(),
  created_by     uuid references user_account (id) on delete restrict,
  updated_at     timestamptz not null default now(),
  updated_by     uuid references user_account (id) on delete restrict,
  version        integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, role_id, permission_id),
  foreign key (company_id, role_id) references role (company_id, id) on delete restrict
);

-- ---------------------------------------------------------------------------
-- DB016 role_assignment
-- CR-008: approved_by is nullable while PENDING so that a proposal (FR-067) can exist
-- before its independent decision; ACTIVE requires approver. Approver is never the
-- beneficiary nor the requester (C4 own privilege grant).
-- ---------------------------------------------------------------------------
create table role_assignment (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  user_id         uuid not null references user_account (id) on delete restrict,
  role_id         uuid not null,
  scope_kind      text not null check (scope_kind in ('OWN', 'TEAM', 'ASSIGNED', 'COMPANY')),
  effective_from  timestamptz not null,
  effective_to    timestamptz check (effective_to > effective_from),
  state           text not null check (state in ('PENDING', 'ACTIVE', 'REVOKED')),
  approved_by     uuid references user_account (id) on delete restrict,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, role_id) references role (company_id, id) on delete restrict,
  check ((approved_by is null) = (approved_at is null)),
  check (state <> 'ACTIVE' or approved_by is not null),
  check (approved_by is null or approved_by <> user_id),
  check (approved_by is null or created_by is null or approved_by <> created_by)
);
create index role_assignment_user_idx on role_assignment (company_id, user_id, state);

-- ---------------------------------------------------------------------------
-- DB017 role_scope_filter: exactly one typed reference matching the dimension.
-- ---------------------------------------------------------------------------
create table role_scope_filter (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company (id) on delete restrict,
  role_assignment_id  uuid not null,
  dimension           text not null check (dimension in ('DEPARTMENT', 'LOCATION', 'EMPLOYEE')),
  department_id       uuid,
  location_id         uuid,
  employee_id         uuid,
  created_at          timestamptz not null default now(),
  created_by          uuid references user_account (id) on delete restrict,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references user_account (id) on delete restrict,
  version             integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, role_assignment_id) references role_assignment (company_id, id) on delete restrict,
  foreign key (company_id, department_id)      references department (company_id, id)      on delete restrict,
  foreign key (company_id, location_id)        references location (company_id, id)        on delete restrict,
  foreign key (company_id, employee_id)        references employee (company_id, id)        on delete restrict,
  check (
       (dimension = 'DEPARTMENT' and department_id is not null and location_id is null and employee_id is null)
    or (dimension = 'LOCATION'   and location_id is not null and department_id is null and employee_id is null)
    or (dimension = 'EMPLOYEE'   and employee_id is not null and department_id is null and location_id is null)
  )
);
create unique index role_scope_filter_value_uq
  on role_scope_filter (company_id, role_assignment_id, dimension, coalesce(department_id, location_id, employee_id));

-- ---------------------------------------------------------------------------
-- DB018 delegation (DF03: max 30 days, no self delegation, beneficiary cannot approve)
-- ---------------------------------------------------------------------------
create table delegation (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  delegator_user_id  uuid not null references user_account (id) on delete restrict,
  delegate_user_id   uuid not null references user_account (id) on delete restrict,
  permission_id      uuid not null references permission (id) on delete restrict,
  effective_from     timestamptz not null,
  effective_to       timestamptz not null,
  approved_by        uuid not null references user_account (id) on delete restrict,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  check (delegator_user_id <> delegate_user_id),
  check (effective_to > effective_from),
  check (effective_to <= effective_from + interval '30 days'),
  check (approved_by <> delegate_user_id)
);

-- ---------------------------------------------------------------------------
-- DB106 confidential_field_policy (BR-043: unknown classification = confidential;
-- the application treats a missing policy row as CONFIDENTIAL).
-- ---------------------------------------------------------------------------
create table confidential_field_policy (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  resource_code   text not null check (resource_code ~ '^[a-z][a-z0-9_]{0,59}$'),
  field_group     text not null check (field_group ~ '^[a-z][a-z0-9_]{0,59}$'),
  classification  text not null default 'CONFIDENTIAL' check (classification in ('CONFIDENTIAL', 'OPERATIONAL')),
  effective_from  date not null,
  effective_to    date check (effective_to > effective_from),
  approved_by     uuid not null references user_account (id) on delete restrict,
  approved_at     timestamptz not null,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  exclude using gist (company_id with =, resource_code with =, field_group with =,
                      daterange(effective_from, effective_to, '[)') with &&)
);

-- ---------------------------------------------------------------------------
-- DB109 role_assignment_permission (DF02 / CI24). Empty allowlist denies everything.
-- ---------------------------------------------------------------------------
create table role_assignment_permission (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company (id) on delete restrict,
  role_assignment_id  uuid not null,
  permission_id       uuid not null references permission (id) on delete restrict,
  active              boolean not null default false,
  effective_from      timestamptz not null,
  effective_to        timestamptz check (effective_to > effective_from),
  created_at          timestamptz not null default now(),
  created_by          uuid references user_account (id) on delete restrict,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references user_account (id) on delete restrict,
  version             integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, role_assignment_id, permission_id),
  foreign key (company_id, role_assignment_id) references role_assignment (company_id, id) on delete restrict
);

-- Containment at write time: the permission must be ALLOWed by the parent role, the period must
-- lie inside the parent period, and the grant can only be active once the parent is ACTIVE.
-- Later parent revocation/shortening is handled by the request-time C1 check, which always
-- intersects the grant with the live parent assignment.
create function hrms_assignment_permission_check() returns trigger language plpgsql as $$
declare
  parent role_assignment%rowtype;
  role_effect text;
begin
  select * into parent from role_assignment
   where company_id = new.company_id and id = new.role_assignment_id;

  select rp.effect into role_effect from role_permission rp
   where rp.company_id = new.company_id and rp.role_id = parent.role_id and rp.permission_id = new.permission_id;

  if role_effect is distinct from 'ALLOW' then
    raise exception 'assignment permission is not allowed by the parent role' using errcode = '23514';
  end if;
  if new.effective_from < parent.effective_from then
    raise exception 'assignment permission starts before its parent assignment' using errcode = '23514';
  end if;
  if parent.effective_to is not null and (new.effective_to is null or new.effective_to > parent.effective_to) then
    raise exception 'assignment permission ends after its parent assignment' using errcode = '23514';
  end if;
  if new.active and parent.state <> 'ACTIVE' then
    raise exception 'assignment permission cannot be active before its parent assignment is approved'
      using errcode = '23514';
  end if;
  return null;
end $$;

create constraint trigger role_assignment_permission_containment
  after insert or update on role_assignment_permission
  deferrable initially deferred
  for each row execute function hrms_assignment_permission_check();

-- ---------------------------------------------------------------------------
-- Generic trigger wiring
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
begin
  foreach t in array array[
    'user_account', 'company', 'department', 'location', 'designation', 'grade', 'reference_value',
    'employee', 'user_employee_link', 'employment_assignment', 'manager_assignment', 'role', 'permission',
    'role_permission', 'role_assignment', 'role_scope_filter', 'delegation', 'confidential_field_policy',
    'role_assignment_permission'
  ] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()',
                   t || '_touch', t);
  end loop;

  foreach t in array array[
    'employee', 'user_employee_link', 'employment_assignment', 'manager_assignment', 'role_assignment',
    'role_assignment_permission', 'delegation', 'confidential_field_policy'
  ] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()',
                   t || '_no_delete', t);
  end loop;
end $$;
