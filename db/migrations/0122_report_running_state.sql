-- 0122 A report shows that it is being generated (FR-056 "large exports run with visible progress and recoverable
-- download links"; FR-058). 0097 left RUNNING unused because generation ran in the one transaction that claimed the
-- execution, so nobody could ever see it. The worker now commits the claim first (RUNNING, running_since) and generates
-- in a second transaction that holds the row lock. A worker that dies leaves an unlocked RUNNING row: after a short
-- lease another tick takes it again, counting an attempt (modules/report/service.ts).
alter table report_execution add column running_since timestamptz;
alter table report_execution add constraint report_execution_running_since_check check ((state = 'RUNNING') = (running_since is not null));

create index report_execution_running_idx on report_execution (running_since) where state = 'RUNNING';
-- FR-056: the requester's own executions, newest first (GET /v1/reports).
create index report_execution_requester_idx on report_execution (company_id, requested_by, acting_assignment_id, created_at desc);
