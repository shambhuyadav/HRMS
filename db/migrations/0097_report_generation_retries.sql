-- 0097 Report generation retries (FR-056 "no-data is distinguished from a failed query"; ADR-13 cadence, as bulk jobs).
-- A generation that failed for any reason other than the report's own refusal used to roll back and stay QUEUED, so
-- the worker claimed the same oldest execution on every tick and no later report of any company was generated. A
-- failure now counts an attempt and waits (1, 5, then 15 minutes), then ends the execution FAILED with an error class
-- (failure_code); other reports are claimed meanwhile. RUNNING stays unused: generation runs in one transaction.
alter table report_execution add column attempts integer not null default 0 check (attempts >= 0);
alter table report_execution add column next_attempt_at timestamptz;

-- The worker's claim: the oldest queued execution of any company.
create index report_execution_queue_idx on report_execution (created_at) where state = 'QUEUED';
