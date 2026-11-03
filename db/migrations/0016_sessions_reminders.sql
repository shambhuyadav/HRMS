-- 0016 Server-side sessions (DF10: idle 30 min, absolute 12 h, revocation on next request) and reminder
-- recipient selectors (DF03 approval reminders/escalation, DF11 confirmation reminders).
-- Note (scale): last_seen updates are throttled; at NFR-S01 volumes this store moves to the session cache (ADR-05).

create table user_session (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references user_account (id) on delete restrict,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  expires_at    timestamptz not null,
  revoked_at    timestamptz,
  check (expires_at > created_at),
  check (expires_at <= created_at + interval '12 hours')
);
create index user_session_user_idx on user_session (user_id) where (revoked_at is null);

-- Scheduler ledger: a scheduled job run (e.g. celebrations for a company and date) happens at most once,
-- whichever worker gets there first.
create table scheduled_job_run (
  run_key      text primary key check (length(run_key) between 4 and 300),
  job_code     text not null check (job_code ~ '^[A-Z][A-Z0-9_]{0,59}$'),
  company_id   uuid references company (id) on delete restrict,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  outcome      text check (outcome in ('OK', 'FAILED')),
  detail       jsonb
);

alter table notification_rule drop constraint notification_rule_recipient_selector_check;
alter table notification_rule add constraint notification_rule_recipient_selector_check check (recipient_selector in
  ('ASSIGNED_REVIEWER', 'SUBJECT_EMPLOYEE', 'SUBJECT_MANAGER', 'BENEFICIARY_USER', 'COMPANY_CELEBRATION_AUDIENCE', 'FALLBACK_REVIEWERS'));
