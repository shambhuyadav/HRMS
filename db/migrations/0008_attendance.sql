-- 0008 Attendance (DB023-DB027; FR-019-FR-022; BR-009; DF05; F6).
-- Punches are immutable source evidence; daily records are reproducible results that pin the shift and
-- policy used; amendments are append-only and never erase the source punch.
-- CR-011: DF05 thresholds are percentages of scheduled net minutes, so present_percent/half_day_percent
-- replace B3's present_minutes/half_day_minutes; a company-wide mapping (no dimensions) is allowed and has
-- the lowest specificity.

create table attendance_policy (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references company (id) on delete restrict,
  code              text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  revision          integer not null check (revision > 0),
  effective_from    date not null,
  effective_to      date check (effective_to > effective_from),
  grace_minutes     integer not null check (grace_minutes >= 0),
  present_percent   numeric(5, 2) not null check (present_percent > 0 and present_percent <= 100),
  half_day_percent  numeric(5, 2) not null check (half_day_percent > 0),
  overtime_enabled  boolean not null,
  state             text not null check (state in ('DRAFT', 'ACTIVE', 'RETIRED')),
  activated_by      uuid references user_account (id) on delete restrict,
  activated_at      timestamptz,
  created_at        timestamptz not null default now(),
  created_by        uuid references user_account (id) on delete restrict,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references user_account (id) on delete restrict,
  version           integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code, revision),
  check (half_day_percent < present_percent),
  check (state = 'DRAFT' or (activated_by is not null and activated_at is not null)),
  check (activated_by is null or created_by is null or activated_by <> created_by)
);

create function hrms_attendance_policy_frozen() returns trigger language plpgsql as $$
begin
  if old.state <> 'DRAFT' and (new.code, new.revision, new.effective_from, new.grace_minutes, new.present_percent,
                               new.half_day_percent, new.overtime_enabled)
                              is distinct from
                              (old.code, old.revision, old.effective_from, old.grace_minutes, old.present_percent,
                               old.half_day_percent, old.overtime_enabled) then
    raise exception 'an activated attendance policy is immutable; create a new revision' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger attendance_policy_frozen before update on attendance_policy for each row execute function hrms_attendance_policy_frozen();

create table attendance_policy_mapping (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references company (id) on delete restrict,
  policy_id    uuid not null,
  grade_id     uuid,
  location_id  uuid,
  created_at   timestamptz not null default now(),
  created_by   uuid references user_account (id) on delete restrict,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references user_account (id) on delete restrict,
  version      integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, policy_id) references attendance_policy (company_id, id) on delete restrict,
  foreign key (company_id, grade_id) references grade (company_id, id) on delete restrict,
  foreign key (company_id, location_id) references location (company_id, id) on delete restrict
);
create unique index attendance_policy_mapping_uq on attendance_policy_mapping
  (company_id, policy_id, coalesce(grade_id, '00000000-0000-0000-0000-000000000000'), coalesce(location_id, '00000000-0000-0000-0000-000000000000'));

-- DB025 attendance_punch. Stable event identity is namespaced by source (CR-005).
create table attendance_punch (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  employee_id           uuid not null,
  occurred_at           timestamptz not null,
  direction             text not null check (direction in ('IN', 'OUT')),
  source_kind           text not null check (source_kind in ('MANUAL_IMPORT', 'BIOMETRIC_API')),
  external_event_key    text check (external_event_key is null or btrim(external_event_key) <> ''),
  biometric_profile_id  uuid,
  source_identity_key   text not null check (btrim(source_identity_key) <> ''),
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  check (source_kind <> 'BIOMETRIC_API' or biometric_profile_id is not null)
);
create unique index attendance_punch_event_uq on attendance_punch (company_id, source_identity_key, external_event_key)
  where (external_event_key is not null);
create index attendance_punch_lookup_idx on attendance_punch (company_id, employee_id, occurred_at);
create trigger attendance_punch_append_only before update or delete on attendance_punch for each row execute function hrms_append_only();

-- DB026 attendance_record: one reproducible daily result per employee and work date.
create table attendance_record (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  employee_id            uuid not null,
  work_date              date not null,
  shift_id               uuid,
  policy_id              uuid not null,
  scheduled_net_minutes  integer not null check (scheduled_net_minutes >= 0),
  worked_minutes         integer not null check (worked_minutes >= 0),
  late                   boolean not null,
  early_departure        boolean not null,
  status_category        text not null default 'ATTENDANCE_STATUS' check (status_category = 'ATTENDANCE_STATUS'),
  status_id              uuid not null,
  exception_code         text check (exception_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  calculation_count      integer not null default 1 check (calculation_count > 0),
  amended                boolean not null default false,
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, employee_id, work_date),
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, shift_id) references shift (company_id, id) on delete restrict,
  foreign key (company_id, policy_id) references attendance_policy (company_id, id) on delete restrict,
  foreign key (company_id, status_category, status_id) references reference_value (company_id, category, id) on delete restrict
);

-- DB027 attendance_amendment: append-only; before/after statuses and the reason.
create table attendance_amendment (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  attendance_record_id  uuid not null,
  prior_version         integer not null check (prior_version > 0),
  status_category       text not null default 'ATTENDANCE_STATUS' check (status_category = 'ATTENDANCE_STATUS'),
  old_status_id         uuid not null,
  new_status_id         uuid not null,
  reason                text not null check (btrim(reason) <> ''),
  actor_id              uuid not null references user_account (id) on delete restrict,
  occurred_at           timestamptz not null default now(),
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  check (old_status_id <> new_status_id),
  foreign key (company_id, attendance_record_id) references attendance_record (company_id, id) on delete restrict,
  foreign key (company_id, status_category, old_status_id) references reference_value (company_id, category, id) on delete restrict,
  foreign key (company_id, status_category, new_status_id) references reference_value (company_id, category, id) on delete restrict
);
create trigger attendance_amendment_append_only before update or delete on attendance_amendment for each row execute function hrms_append_only();

insert into permission (resource, action, field_group) values
  ('attendance', 'read',    'operational'),
  ('attendance', 'import',  'operational'),
  ('attendance', 'process', 'operational'),
  ('attendance', 'amend',   'operational'),
  ('attendance_policy', 'manage',   'operational'),
  ('attendance_policy', 'activate', 'operational');

do $$
declare
  t text;
begin
  foreach t in array array['attendance_policy', 'attendance_policy_mapping', 'attendance_record'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
  foreach t in array array['attendance_policy', 'attendance_record'] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;
