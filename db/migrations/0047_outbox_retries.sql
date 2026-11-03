-- 0047 Outbox retry and failure isolation (DF12: "retries 1/5/15 minutes then FAILED. Retry attempts are
-- auditable"). An event whose processing fails is retried later instead of blocking every event behind it; after the
-- third retry it is FAILED and stays visible for repair. The recorded error is a code or class, never payload values.
alter table outbox_event add column next_attempt_at timestamptz;
alter table outbox_event add column failed_at timestamptz;
alter table outbox_event add column last_error text check (last_error is null or last_error ~ '^[A-Za-z0-9_.:-]{1,100}$');
alter table outbox_event add constraint outbox_event_failed_unpublished check (failed_at is null or published_at is null);

drop index outbox_event_unpublished_idx;
create index outbox_event_ready_idx on outbox_event (id) where (published_at is null and failed_at is null);

-- Each failed attempt, for the retry audit trail.
create table outbox_event_attempt (
  id          bigint generated always as identity primary key,
  event_id    bigint not null references outbox_event (id) on delete restrict,
  company_id  uuid not null references company (id) on delete restrict,
  attempt     integer not null check (attempt > 0),
  error_code  text not null check (error_code ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  occurred_at timestamptz not null default now(),
  unique (event_id, attempt)
);
create trigger outbox_event_attempt_append_only before update or delete on outbox_event_attempt for each row execute function hrms_append_only();
