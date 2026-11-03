-- 0014 Biometric attendance API ingestion (DB094-DB100; FR-086-FR-088; BR-035-BR-037; DF09; DF13; CI19).
-- Provider settings and credentials are opaque references only (never values). Mapping revisions are
-- immutable once used. Every observation of every run is kept; the canonical event per profile/event key is
-- unique; a differing payload under the same key is quarantined, never overwritten. No biometric templates.

create function hrms_valid_provider_timezone() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.provider_timezone) then
    raise exception 'unknown timezone %', new.provider_timezone using errcode = '23514';
  end if;
  return new;
end $$;

create table biometric_profile (
  id                        uuid primary key default gen_random_uuid(),
  company_id                uuid not null references company (id) on delete restrict,
  code                      text not null check (code ~ '^[A-Z][A-Z0-9_]{0,39}$'),
  name                      text not null check (btrim(name) <> ''),
  request_config_reference  text not null check (btrim(request_config_reference) <> ''),
  auth_reference            text not null check (btrim(auth_reference) <> ''),
  provider_timezone         text not null,
  pagination_mode           text not null check (pagination_mode in ('CURSOR', 'PAGE_NUMBER')),
  schedule_reference        text not null check (btrim(schedule_reference) <> ''),
  lookback_minutes          integer not null check (lookback_minutes between 1 and 20160),
  active                    boolean not null,
  synced_until              timestamptz,
  created_at                timestamptz not null default now(),
  created_by                uuid references user_account (id) on delete restrict,
  updated_at                timestamptz not null default now(),
  updated_by                uuid references user_account (id) on delete restrict,
  version                   integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code)
);
create trigger biometric_profile_valid_timezone before insert or update of provider_timezone on biometric_profile
  for each row execute function hrms_valid_provider_timezone();

create table biometric_mapping_revision (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  profile_id      uuid not null,
  revision        integer not null check (revision > 0),
  effective_from  timestamptz not null,
  effective_to    timestamptz check (effective_to > effective_from),
  dedupe_strategy text not null check (dedupe_strategy in ('PROVIDER_EVENT_KEY', 'FINGERPRINT')),
  timestamp_rule  text not null check (timestamp_rule in ('ISO_WITH_OFFSET', 'LOCAL_IN_PROVIDER_ZONE')),
  approved_by     uuid references user_account (id) on delete restrict,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, profile_id),
  unique (company_id, profile_id, revision),
  foreign key (company_id, profile_id) references biometric_profile (company_id, id) on delete restrict,
  check ((approved_by is null) = (approved_at is null)),
  check (approved_by is null or created_by is null or approved_by <> created_by),
  -- Only approved revisions take effect; approved ones never overlap per profile.
  exclude using gist (company_id with =, profile_id with =, tstzrange(effective_from, effective_to, '[)') with &&) where (approved_by is not null)
);

create table biometric_field_mapping (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  mapping_revision_id  uuid not null,
  -- Typed path only: identifiers separated by dots, optional [n] indexes. Never an expression.
  source_path          text not null check (source_path ~ '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]{1,4}\])*$'),
  target_field         text not null check (target_field in ('EMPLOYEE_KEY', 'PUNCH_INSTANT', 'DIRECTION', 'EVENT_KEY', 'DEVICE_ID')),
  transform_code       text not null check (transform_code in ('IDENTITY', 'TRIM', 'UPPER', 'ENUM_MAP', 'PARSE_INSTANT')),
  format_config        text,
  enum_config          jsonb,
  required             boolean not null,
  default_code         text check (default_code in ('IN', 'OUT')),
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, mapping_revision_id, target_field),
  foreign key (company_id, mapping_revision_id) references biometric_mapping_revision (company_id, id) on delete restrict,
  check (transform_code <> 'ENUM_MAP' or (enum_config is not null and jsonb_typeof(enum_config) = 'object')),
  check (default_code is null or target_field = 'DIRECTION'),
  check (transform_code <> 'PARSE_INSTANT' or target_field = 'PUNCH_INSTANT')
);

-- A mapping revision and its fields are immutable once approved (BR-035).
create function hrms_biometric_mapping_frozen() returns trigger language plpgsql as $$
declare
  rev uuid := case when tg_op = 'INSERT' then new.mapping_revision_id else old.mapping_revision_id end;
  cid uuid := case when tg_op = 'INSERT' then new.company_id else old.company_id end;
begin
  if exists (select 1 from biometric_mapping_revision where company_id = cid and id = rev and approved_by is not null) then
    raise exception 'an approved mapping revision is immutable; create a new revision' using errcode = '23514';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger biometric_field_mapping_frozen before insert or update or delete on biometric_field_mapping
  for each row execute function hrms_biometric_mapping_frozen();

create table biometric_employee_link (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  profile_id             uuid not null,
  external_employee_key  text not null check (btrim(external_employee_key) <> ''),
  employee_id            uuid not null,
  effective_from         timestamptz not null,
  effective_to           timestamptz check (effective_to > effective_from),
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  foreign key (company_id, profile_id) references biometric_profile (company_id, id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  -- FR-088: one employee per provider identity at a time; one identity per employee per profile at a time.
  exclude using gist (company_id with =, profile_id with =, external_employee_key with =, tstzrange(effective_from, effective_to, '[)') with &&),
  exclude using gist (company_id with =, profile_id with =, employee_id with =, tstzrange(effective_from, effective_to, '[)') with &&)
);

create table biometric_sync_run (
  id                              uuid primary key default gen_random_uuid(),
  company_id                      uuid not null references company (id) on delete restrict,
  profile_id                      uuid not null,
  mapping_revision_id             uuid not null,
  window_start                    timestamptz not null,
  window_end                      timestamptz not null,
  starting_checkpoint_reference   text,
  committed_checkpoint_reference  text,
  pages_committed                 integer not null default 0 check (pages_committed >= 0),
  source_observation_count        integer not null default 0 check (source_observation_count >= 0),
  accepted_count                  integer not null default 0 check (accepted_count >= 0),
  duplicate_count                 integer not null default 0 check (duplicate_count >= 0),
  rejected_count                  integer not null default 0 check (rejected_count >= 0),
  quarantined_count               integer not null default 0 check (quarantined_count >= 0),
  state                           text not null check (state in ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED')),
  failure_code                    text,
  started_at                      timestamptz not null default now(),
  finished_at                     timestamptz,
  created_at                      timestamptz not null default now(),
  created_by                      uuid references user_account (id) on delete restrict,
  updated_at                      timestamptz not null default now(),
  updated_by                      uuid references user_account (id) on delete restrict,
  version                         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, profile_id),
  -- CI19: the pinned mapping revision belongs to the run's profile.
  foreign key (company_id, mapping_revision_id, profile_id) references biometric_mapping_revision (company_id, id, profile_id) on delete restrict,
  check (window_end > window_start),
  check (source_observation_count = accepted_count + duplicate_count + rejected_count + quarantined_count),
  check ((state = 'RUNNING') = (finished_at is null))
);
-- FR-088: concurrent runs of one profile cannot advance the same checkpoint twice.
create unique index biometric_one_running_run on biometric_sync_run (company_id, profile_id) where (state = 'RUNNING');

create table biometric_ingest_event (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  profile_id             uuid not null,
  first_run_id           uuid not null,
  latest_run_id          uuid not null,
  mapping_revision_id    uuid not null,
  source_event_key       text not null,
  fingerprint            text not null,
  external_employee_key  text,
  employee_id            uuid,
  normalised_time        timestamptz,
  direction              text check (direction in ('IN', 'OUT')),
  punch_id               uuid,
  state                  text not null check (state in ('ACCEPTED', 'QUARANTINED', 'REJECTED')),
  failure_code           text,
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, profile_id, source_event_key),
  foreign key (company_id, first_run_id, profile_id) references biometric_sync_run (company_id, id, profile_id) on delete restrict,
  foreign key (company_id, latest_run_id, profile_id) references biometric_sync_run (company_id, id, profile_id) on delete restrict,
  foreign key (company_id, mapping_revision_id, profile_id) references biometric_mapping_revision (company_id, id, profile_id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, punch_id) references attendance_punch (company_id, id) on delete restrict,
  check ((state = 'ACCEPTED') = (punch_id is not null)),
  check (state <> 'ACCEPTED' or (employee_id is not null and normalised_time is not null and direction is not null)),
  check (state = 'ACCEPTED' or failure_code is not null)
);

-- CI19: an accepted event's punch has the same employee, instant, direction and profile.
create function hrms_biometric_event_punch_check() returns trigger language plpgsql as $$
begin
  if new.punch_id is not null and not exists (
    select 1 from attendance_punch p where p.company_id = new.company_id and p.id = new.punch_id and p.employee_id = new.employee_id
       and p.occurred_at = new.normalised_time and p.direction = new.direction and p.biometric_profile_id = new.profile_id) then
    raise exception 'accepted biometric event does not match its punch' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger biometric_event_punch_check before insert or update on biometric_ingest_event for each row execute function hrms_biometric_event_punch_check();

create table biometric_run_observation (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  run_id             uuid not null,
  observation_index  integer not null check (observation_index > 0),
  ingest_event_id    uuid,
  source_event_key   text,
  fingerprint        text not null,
  outcome            text not null check (outcome in ('ACCEPTED', 'DUPLICATE', 'REJECTED', 'QUARANTINED')),
  failure_code       text,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, run_id, observation_index),
  foreign key (company_id, run_id) references biometric_sync_run (company_id, id) on delete restrict,
  foreign key (company_id, ingest_event_id) references biometric_ingest_event (company_id, id) on delete restrict,
  check (outcome in ('ACCEPTED', 'DUPLICATE') or failure_code is not null)
);
create trigger biometric_run_observation_append_only before update or delete on biometric_run_observation for each row execute function hrms_append_only();

alter table attendance_punch
  add constraint attendance_punch_biometric_profile_fk foreign key (company_id, biometric_profile_id) references biometric_profile (company_id, id) on delete restrict;

insert into permission (resource, action, field_group) values
  ('biometric', 'profile_manage',           'operational'),
  ('biometric', 'mapping_manage',           'operational'),
  ('biometric', 'employee_link_manage',     'operational'),
  ('biometric', 'sync_run',                 'operational'),
  ('biometric', 'sync_exception_reprocess', 'operational'),
  ('biometric', 'read',                     'operational');

do $$
declare
  t text;
begin
  foreach t in array array['biometric_profile', 'biometric_mapping_revision', 'biometric_field_mapping', 'biometric_employee_link', 'biometric_sync_run', 'biometric_ingest_event'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
  foreach t in array array['biometric_profile', 'biometric_mapping_revision', 'biometric_employee_link', 'biometric_sync_run', 'biometric_ingest_event'] loop
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;
