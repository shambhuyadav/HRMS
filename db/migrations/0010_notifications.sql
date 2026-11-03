-- 0010 Notifications (DB083, DB089-DB093; FR-061, FR-083-FR-085; BR-032-BR-034; DF12; CI18).
-- Committed outbox events become notification_event rows; each event produces at most one logical
-- notification per recipient/channel/rule revision (idempotency key); every delivery attempt is kept.
-- DF12: in-app is the only enabled channel initially; other channels are rejected by the schema until enabled.

create table notification_template (
  id                     uuid primary key default gen_random_uuid(),
  company_id             uuid not null references company (id) on delete restrict,
  code                   text not null check (code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  revision               integer not null check (revision > 0),
  language               text not null check (language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  channel                text not null check (channel in ('IN_APP')),
  subject_template       text,
  body_template          text not null check (btrim(body_template) <> ''),
  approved_placeholders  text[] not null,
  active                 boolean not null,
  created_at             timestamptz not null default now(),
  created_by             uuid references user_account (id) on delete restrict,
  updated_at             timestamptz not null default now(),
  updated_by             uuid references user_account (id) on delete restrict,
  version                integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, id, code, revision, channel),
  unique (company_id, code, revision, language, channel)
);

create table notification_rule (
  id                  uuid primary key default gen_random_uuid(),
  company_id          uuid not null references company (id) on delete restrict,
  code                text not null check (code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  revision            integer not null check (revision > 0),
  event_type          text not null check (event_type ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  channel             text not null check (channel in ('IN_APP')),
  recipient_selector  text not null check (recipient_selector in ('ASSIGNED_REVIEWER', 'SUBJECT_EMPLOYEE', 'SUBJECT_MANAGER', 'BENEFICIARY_USER', 'COMPANY_CELEBRATION_AUDIENCE')),
  template_code       text not null,
  template_revision   integer not null,
  template_id         uuid not null,
  lead_minutes        integer not null default 0 check (lead_minutes >= 0),
  retry_ceiling       integer not null default 3 check (retry_ceiling between 0 and 10),
  optional_event      boolean not null,
  effective_from      timestamptz not null,
  effective_to        timestamptz check (effective_to > effective_from),
  active              boolean not null,
  created_at          timestamptz not null default now(),
  created_by          uuid references user_account (id) on delete restrict,
  updated_at          timestamptz not null default now(),
  updated_by          uuid references user_account (id) on delete restrict,
  version             integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, code, revision),
  -- CI18: the pinned template id must agree with the template code/revision/channel.
  foreign key (company_id, template_id, template_code, template_revision, channel)
    references notification_template (company_id, id, code, revision, channel) on delete restrict
);

create table notification_preference (
  id                   uuid primary key default gen_random_uuid(),
  company_id           uuid not null references company (id) on delete restrict,
  user_id              uuid not null references user_account (id) on delete restrict,
  event_type           text not null check (event_type ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  channel              text not null check (channel in ('IN_APP')),
  -- DF12: celebration publication is opt-in (default off); no consent is assumed.
  publish_celebration  boolean not null default false,
  receive_optional     boolean not null default true,
  created_at           timestamptz not null default now(),
  created_by           uuid references user_account (id) on delete restrict,
  updated_at           timestamptz not null default now(),
  updated_by           uuid references user_account (id) on delete restrict,
  version              integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, user_id, event_type, channel)
);

create table notification_event (
  id                    uuid primary key default gen_random_uuid(),
  company_id            uuid not null references company (id) on delete restrict,
  event_key             text not null,
  event_type            text not null check (event_type ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  subject_employee_id   uuid,
  transaction_id        uuid,
  transaction_revision  integer,
  occurrence_date       date not null,
  business_timezone     text not null,
  occurred_at           timestamptz not null default now(),
  -- Minimal non-confidential placeholder data; never salary, reasons, full birth date, year or age.
  data                  jsonb not null default '{}'::jsonb,
  created_at            timestamptz not null default now(),
  created_by            uuid references user_account (id) on delete restrict,
  updated_at            timestamptz not null default now(),
  updated_by            uuid references user_account (id) on delete restrict,
  version               integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, event_key),
  foreign key (company_id, subject_employee_id) references employee (company_id, id) on delete restrict,
  foreign key (company_id, transaction_id) references business_transaction (company_id, id) on delete restrict
);
create trigger notification_event_append_only before update or delete on notification_event for each row execute function hrms_append_only();

-- DB083 notification (one logical notification per event/recipient/channel/rule revision).
create table notification (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references company (id) on delete restrict,
  recipient_user_id  uuid not null references user_account (id) on delete restrict,
  transaction_id     uuid,
  category           text not null check (category ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  state              text not null check (state in ('QUEUED', 'DELIVERED', 'RETRY_PENDING', 'FAILED', 'SUPPRESSED')),
  occurred_at        timestamptz not null default now(),
  event_id           uuid,
  rule_id            uuid,
  channel            text not null check (channel in ('IN_APP')),
  idempotency_key    text not null,
  title              text,
  body               text,
  read_at            timestamptz,
  created_at         timestamptz not null default now(),
  created_by         uuid references user_account (id) on delete restrict,
  updated_at         timestamptz not null default now(),
  updated_by         uuid references user_account (id) on delete restrict,
  version            integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, transaction_id) references business_transaction (company_id, id) on delete restrict,
  foreign key (company_id, event_id) references notification_event (company_id, id) on delete restrict,
  foreign key (company_id, rule_id) references notification_rule (company_id, id) on delete restrict,
  check (read_at is null or state = 'DELIVERED'),
  check (state <> 'DELIVERED' or body is not null)
);
create index notification_inbox_idx on notification (company_id, recipient_user_id, state, occurred_at desc);

create table notification_delivery_attempt (
  id                         uuid primary key default gen_random_uuid(),
  company_id                 uuid not null references company (id) on delete restrict,
  notification_id            uuid not null,
  attempt_number             integer not null check (attempt_number > 0),
  attempted_at               timestamptz not null default now(),
  outcome                    text not null check (outcome in ('DELIVERED', 'FAILED', 'SUPPRESSED')),
  outcome_at                 timestamptz,
  failure_code               text check (failure_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  provider_result_reference  text,
  created_at                 timestamptz not null default now(),
  created_by                 uuid references user_account (id) on delete restrict,
  updated_at                 timestamptz not null default now(),
  updated_by                 uuid references user_account (id) on delete restrict,
  version                    integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, notification_id, attempt_number),
  foreign key (company_id, notification_id) references notification (company_id, id) on delete restrict,
  check (outcome = 'DELIVERED' or failure_code is not null)
);
create trigger notification_delivery_attempt_append_only before update or delete on notification_delivery_attempt
  for each row execute function hrms_append_only();

insert into permission (resource, action, field_group) values
  ('notification', 'read_delivery', 'operational'),
  ('notification', 'manage_rules',  'operational');

do $$
declare
  t text;
begin
  foreach t in array array['notification_template', 'notification_rule', 'notification_preference', 'notification'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
  end loop;
end $$;
