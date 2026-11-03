-- 0053 Bulk jobs (NFR-S09; docs/09 §7.2; ADR-15). A company-wide loop is never run on an interactive request: the
-- request records a QUEUED job and answers 202; the worker (modules/bulk/service.ts runBulkJobs) runs it in bounded
-- chunks, one transaction each, under the requester's authority re-resolved for every chunk. The cursor is stored with
-- each chunk's effects, so a crash or a retry resumes after the last committed chunk without double effects. A failing
-- chunk is retried after 1, 5 and 15 minutes and then the job is FAILED (ADR-13 cadence); the recorded error is a code
-- or class, never a value. The result holds operational counts only.
create table bulk_job (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references company (id) on delete restrict,
  -- Later kinds (e.g. the increment review opening) extend this list.
  kind                     text not null check (kind in ('ATTENDANCE_PROCESSING', 'LEAVE_ACCRUAL')),
  parameters               jsonb not null check (jsonb_typeof(parameters) = 'object'),
  -- The requester and the authority the job was enqueued under; every chunk re-resolves exactly this.
  requested_by             uuid not null references user_account (id) on delete restrict,
  acting_assignment_id     uuid not null,
  permission_resource      text not null check (permission_resource ~ '^[a-z][a-z0-9_]{0,59}$'),
  permission_action        text not null check (permission_action ~ '^[a-z][a-z0-9_]{0,59}$'),
  permission_field_groups  text[] not null check (cardinality(permission_field_groups) > 0),
  -- Optional client key: the same requester retrying with the same parameters gets the same job.
  idempotency_key          text check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  state                    text not null default 'QUEUED' check (state in ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED')),
  -- Last unit (in the kind's stable order) covered by a committed chunk; null before the first chunk.
  chunk_cursor             text check (length(chunk_cursor) <= 200),
  processed_count          integer not null default 0 check (processed_count >= 0),
  result                   jsonb not null default '{}' check (jsonb_typeof(result) = 'object'),
  error_code               text check (error_code ~ '^[A-Za-z0-9_.:-]{1,100}$'),
  -- Failed attempts of the current chunk (reset when a chunk commits).
  attempts                 integer not null default 0 check (attempts >= 0),
  next_attempt_at          timestamptz,
  started_at               timestamptz,
  finished_at              timestamptz,
  created_at               timestamptz not null default now(),
  created_by               uuid references user_account (id) on delete restrict,
  updated_at               timestamptz not null default now(),
  updated_by               uuid references user_account (id) on delete restrict,
  version                  integer not null default 1 check (version > 0),
  unique (company_id, id),
  unique (company_id, idempotency_key),
  foreign key (company_id, acting_assignment_id) references role_assignment (company_id, id) on delete restrict,
  check ((state = 'QUEUED') = (started_at is null)),
  check ((state in ('COMPLETED', 'FAILED')) = (finished_at is not null)),
  check (state <> 'FAILED' or error_code is not null),
  check (state <> 'COMPLETED' or (error_code is null and attempts = 0)),
  check (next_attempt_at is null or state = 'RUNNING')
);
-- Ready jobs, least recently advanced first (round robin between jobs; delayed retries are filtered on top).
create index bulk_job_ready_idx on bulk_job (updated_at, id) where (state in ('QUEUED', 'RUNNING'));
-- A requester's own jobs, newest first.
create index bulk_job_requester_idx on bulk_job (company_id, requested_by, created_at desc);

-- A job's request is immutable; a finished job is final.
create function hrms_bulk_job_guard() returns trigger language plpgsql as $$
begin
  if (new.kind, new.parameters, new.requested_by, new.acting_assignment_id, new.permission_resource, new.permission_action,
      new.permission_field_groups, new.idempotency_key)
     is distinct from
     (old.kind, old.parameters, old.requested_by, old.acting_assignment_id, old.permission_resource, old.permission_action,
      old.permission_field_groups, old.idempotency_key) then
    raise exception 'a bulk job request is immutable' using errcode = '23514';
  end if;
  if old.state in ('COMPLETED', 'FAILED') then
    raise exception 'bulk job in % is final', old.state using errcode = '23514';
  end if;
  return new;
end $$;
create trigger bulk_job_guard before update on bulk_job for each row execute function hrms_bulk_job_guard();
create trigger bulk_job_touch before update on bulk_job for each row execute function hrms_touch();
create trigger bulk_job_no_delete before delete on bulk_job for each row execute function hrms_no_delete();
