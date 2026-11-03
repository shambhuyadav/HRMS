-- 0112 The employee a failing attendance processing chunk stopped on (FR-022 "processing failures list affected
-- employees and cannot silently mark the batch complete"; NFR-S09; ADR-15; 0053; 0058).
-- A failing chunk rolls back whole and the job carries an error class only. The failure is written next to the job's own
-- failure record, in the claiming transaction after the chunk's rollback, naming the employee whose evaluation failed.
-- With the employees after the job's committed cursor (read together, GET /v1/attendance/processing/:id/unprocessed-employees)
-- this lists who the job did not process. The outcome of the job does not change (FAILED after the retries, I-34). A job
-- has one failing employee at a time: a retry that stops on another replaces the row; one that passes leaves it behind the
-- cursor, where it no longer lists.
create table attendance_processing_failure (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references company (id) on delete restrict,
  bulk_job_id    uuid not null,
  employee_id    uuid not null,
  employee_code  text not null,
  error_code     text not null check (btrim(error_code) <> ''),
  created_at     timestamptz not null default now(),
  created_by     uuid references user_account (id) on delete restrict,
  unique (company_id, bulk_job_id),
  foreign key (company_id, bulk_job_id) references bulk_job (company_id, id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict
);
create trigger attendance_processing_failure_job_kind before insert on attendance_processing_failure
  for each row execute function hrms_bulk_job_row_kind('ATTENDANCE_PROCESSING');
