-- 0022 Audit trail read/export and retention holds (FR-058; DF08; BR-007; BR-026).
-- DF08: no automatic hard-delete/purge is enabled initially; a separately documented retention schedule is
-- required before any purge can run. This migration therefore adds only the controls a purge would need
-- (approved rules and approved holds) and an eligibility dry run; nothing here deletes data.

-- Period queries over the audit trail (company + time).
create index audit_event_company_time_idx on audit_event (company_id, occurred_at);

-- Retention rule: how long a record kind is kept. Values are owner inputs; none are seeded (DF08 asserts no
-- local legal retention period). Activation is independent of the author.
create table retention_rule (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  resource_code   text not null check (resource_code in ('audit_event')),
  revision        integer not null check (revision > 0),
  retain_days     integer not null check (retain_days between 1 and 36500),
  basis_note      text not null check (btrim(basis_note) <> '' and length(basis_note) <= 1000),
  state           text not null check (state in ('DRAFT', 'ACTIVE', 'RETIRED')),
  approved_by     uuid references user_account (id) on delete restrict,
  approved_at     timestamptz,
  created_at      timestamptz not null default now(),
  created_by      uuid not null references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, resource_code, revision),
  check (state = 'DRAFT' or (approved_by is not null and approved_at is not null)),
  -- C4: the author never activates their own rule.
  check (approved_by is null or approved_by <> created_by)
);
create unique index retention_rule_one_active on retention_rule (company_id, resource_code) where (state = 'ACTIVE');

-- Retention hold: preserves records (one record, or every record of a kind) from any future purge.
create table retention_hold (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  resource_code   text not null check (resource_code ~ '^[a-z][a-z0-9_]{0,59}$'),
  record_key      uuid,
  reason          text not null check (btrim(reason) <> '' and length(reason) <= 1000),
  state           text not null check (state in ('PENDING', 'ACTIVE', 'REJECTED', 'RELEASED')),
  requested_by    uuid not null references user_account (id) on delete restrict,
  decided_by      uuid references user_account (id) on delete restrict,
  decided_at      timestamptz,
  released_by     uuid references user_account (id) on delete restrict,
  released_at     timestamptz,
  release_reason  text check (release_reason is null or (btrim(release_reason) <> '' and length(release_reason) <= 1000)),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  check (state = 'PENDING' or (decided_by is not null and decided_at is not null)),
  check (state <> 'RELEASED' or (released_by is not null and released_at is not null and release_reason is not null)),
  -- C4: an independent decision, never by the requester.
  check (decided_by is null or decided_by <> requested_by)
);
create index retention_hold_lookup_idx on retention_hold (company_id, resource_code, record_key) where (state = 'ACTIVE');

do $$
declare
  t text;
begin
  foreach t in array array['retention_rule', 'retention_hold'] loop
    execute format('create trigger %I before update on %I for each row execute function hrms_touch()', t || '_touch', t);
    execute format('create trigger %I before delete on %I for each row execute function hrms_no_delete()', t || '_no_delete', t);
  end loop;
end $$;

-- audit.export.operational already exists in the catalogue (0004); it now has a report behind it.
insert into permission (resource, action, field_group) values
  ('retention', 'manage',  'operational'),
  ('retention', 'approve', 'operational');
