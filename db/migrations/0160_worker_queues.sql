-- 0160 Worker queues (docs/09 §7.2, §7.4, §8.3; NFR-S09; G3 "Apply per-company fairness"; DF12; FR-106). Everything here is a
-- change of shape for the worker: no business rule moves, and nothing here claims a speed. No stored row is rewritten or
-- refused: every new column has a value that means "as before". The indexes hold writes to their table while they build, so
-- on a large database apply this in a quiet window (as 0144).

-- ---------------------------------------------------------------------------
-- 1. Outbox: claims take one company at a time, and a delayed retry is out of the way of every claim.
-- 0071's ready index held every unpublished event, so the waiting retries at its head were read and thrown away by every
-- claim. Adding next_attempt_at to the index would not have changed that: a time comparison with now() cannot be part of an
-- index predicate, and the claim's "null or due" test is only applied to the row itself. So a waiting event leaves the ready
-- index altogether, and goes back into it when it falls due (dispatcher.ts).
-- ---------------------------------------------------------------------------
drop index outbox_event_ready_idx;
create index outbox_event_ready_idx on outbox_event (company_id, created_at, seq)
  where (published_at is null and failed_at is null and next_attempt_at is null);
create index outbox_event_retry_idx on outbox_event (next_attempt_at)
  where (published_at is null and failed_at is null and next_attempt_at is not null);

-- ---------------------------------------------------------------------------
-- 2. Report queue: the claim walks one company at a time, over queued and running executions (report/service.ts).
-- ---------------------------------------------------------------------------
drop index report_execution_queue_idx;
drop index report_execution_running_idx;
create index report_execution_queue_idx on report_execution (company_id, created_at) where (state in ('QUEUED', 'RUNNING'));

-- ---------------------------------------------------------------------------
-- 3. Scans (FR-106; §8.3 "backoff, an attempt cap"): each file keeps its attempts and when it may be tried again. A file whose
-- attempts ran out stays PENDING_SCAN (never served, never released) and says so in scan_failed_at, so a scanner outage can
-- never look like a verdict. What happens to such a file next is an owner question (docs/09 §7.2).
-- ---------------------------------------------------------------------------
alter table attachment add column scan_attempts integer not null default 0 check (scan_attempts >= 0);
alter table attachment add column scan_next_attempt_at timestamptz;
alter table attachment add column scan_last_error text check (scan_last_error is null or scan_last_error ~ '^[A-Za-z0-9_.:-]{1,100}$');
alter table attachment add column scan_failed_at timestamptz;
alter table attachment add constraint attachment_scan_failed_pending check (scan_failed_at is null or scan_state = 'PENDING_SCAN');

drop index attachment_pending_scan_idx;
create index attachment_scan_ready_idx on attachment (company_id, created_at)
  where (scan_state = 'PENDING_SCAN' and scan_failed_at is null and scan_next_attempt_at is null);
create index attachment_scan_retry_idx on attachment (scan_next_attempt_at)
  where (scan_state = 'PENDING_SCAN' and scan_failed_at is null and scan_next_attempt_at is not null);

-- ---------------------------------------------------------------------------
-- 4. Scheduled runs that work in several transactions can be taken over: lease_until is how long the run's holder is presumed
-- alive, attempts how many times it was claimed. A run without a lease (every other job, and any row older than this
-- migration) keeps its once-only claim exactly as it was.
-- ---------------------------------------------------------------------------
alter table scheduled_job_run add column lease_until timestamptz;
alter table scheduled_job_run add column attempts integer not null default 0 check (attempts >= 0);

-- ---------------------------------------------------------------------------
-- 5. A celebration's notices are written in batches (DF12 "one logical event/recipient/channel/occurrence key"), so an event
-- can be part way through its recipients when a worker dies. notification_event is append-only, so the position lives here:
-- one row per event and rule (the rules live when the event was recorded), moved in the transaction that wrote the batch.
-- An event with no row here was written whole, in one transaction.
-- ---------------------------------------------------------------------------
create table notification_fan_out (
  company_id     uuid not null references company (id) on delete restrict,
  event_id       uuid not null,
  rule_id        uuid not null,
  after_user_id  uuid references user_account (id) on delete restrict,
  finished_at    timestamptz,
  created_at     timestamptz not null default now(),
  created_by     uuid not null references user_account (id) on delete restrict,
  updated_at     timestamptz not null default now(),
  updated_by     uuid not null references user_account (id) on delete restrict,
  version        integer not null default 1 check (version > 0),
  primary key (company_id, event_id, rule_id),
  foreign key (company_id, event_id) references notification_event (company_id, id) on delete restrict,
  foreign key (company_id, rule_id) references notification_rule (company_id, id) on delete restrict
);
create index notification_fan_out_rule_idx on notification_fan_out (company_id, rule_id);
create trigger notification_fan_out_touch before update on notification_fan_out for each row execute function hrms_touch();
create trigger notification_fan_out_set_once before update on notification_fan_out for each row execute function hrms_columns_set_once('finished_at');
