-- 0058 Employees without an applicable attendance policy, as rows of the processing job (NFR-S09; FR-020; FR-022;
-- DF05; ADR-15). Attendance processing runs as a bulk job (0053), and a bulk job's result carries operational counts
-- only: the list of the employees without a policy (noPolicyEmployeeIds) was copied and rewritten by every chunk.
-- Each chunk now writes the employees it found without a policy as rows of the job, in the chunk's own transaction, at
-- most one per job and employee, so a chunk that runs again writes nothing twice; the result keeps the count
-- (NO_POLICY) and the audit record is unchanged (counts only). The job's requester reads the rows a page at a time
-- (GET /v1/attendance/processing/:id/no-policy-employees) under the processing permission and their row scope.
-- Jobs finished before this migration keep their list in their result (a finished job is final) and have no rows; a
-- job still running then writes the list it carries as rows with its next chunk and drops it from its result.
create table attendance_processing_no_policy (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  -- The processing job whose chunk evaluated the employee.
  bulk_job_id     uuid not null,
  employee_id     uuid not null,
  -- The employee's code when the chunk ran: the job's processing order (its cursor) and the order of the paged list.
  employee_code   text not null check (btrim(employee_code) <> ''),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  -- Idempotent per job and employee.
  unique (company_id, bulk_job_id, employee_id),
  foreign key (company_id, bulk_job_id) references bulk_job (company_id, id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict
);
-- A page of a job's rows is one index range: keyset on (employee code, employee id) within the job.
create index attendance_processing_no_policy_page_idx on attendance_processing_no_policy (company_id, bulk_job_id, employee_code, employee_id);
create trigger attendance_processing_no_policy_append_only before update or delete on attendance_processing_no_policy
  for each row execute function hrms_append_only();
