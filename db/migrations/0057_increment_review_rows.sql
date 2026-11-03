-- 0057 Per-employee rows of an increment review opening (NFR-S09; FR-091; DF15; ADR-15). The opening runs as a bulk
-- job (0055), and a bulk job's result carries operational counts only: a per-employee list in the result would be
-- copied and rewritten by every chunk. Each chunk therefore writes the outcome of the employees it evaluated as rows,
-- in the chunk's own transaction:
--   * a created case names the opening job that created it (increment_case.opened_by_job_id): the job's roster;
--   * an excluded employee is one increment_review_exclusion row with the reason code (the repair path is the
--     application's text for that code, not stored), at most one per job, employee and occurrence, so a chunk that
--     runs again writes nothing twice;
--   * the run record names its job (increment_review_run.bulk_job_id), written once with the last chunk, which links
--     the job's cases and exclusions to the run without rewriting them.
-- Openings recorded before this migration have no such rows (the synchronous openings answered their lists, and the
-- jobs of 0055 kept them in their result).

alter table increment_case
  add column opened_by_job_id uuid,
  add constraint increment_case_opened_by_job_fk foreign key (company_id, opened_by_job_id) references bulk_job (company_id, id) on delete restrict;
create index increment_case_opened_by_job_idx on increment_case (company_id, opened_by_job_id, employee_id) where (opened_by_job_id is not null);

alter table increment_review_run
  add column bulk_job_id uuid,
  add constraint increment_review_run_job_fk foreign key (company_id, bulk_job_id) references bulk_job (company_id, id) on delete restrict,
  add constraint increment_review_run_one_per_job unique (company_id, bulk_job_id);

create table increment_review_exclusion (
  id              uuid primary key default gen_random_uuid(),
  company_id      uuid not null references company (id) on delete restrict,
  -- The opening job whose chunk evaluated the employee.
  bulk_job_id     uuid not null,
  -- The activated cycle revision the opening ran on.
  cycle_id        uuid not null,
  employee_id     uuid not null,
  occurrence_key  text not null check (btrim(occurrence_key) <> ''),
  -- modules/increment/roster.ts EXCLUSION_REPAIR: each code has its repair path there.
  reason_code     text not null check (reason_code in ('ALREADY_IN_REVIEW', 'REVIEW_RESCHEDULED', 'ON_NOTICE', 'SEPARATION_BEFORE_EFFECTIVE_DATE',
                                                       'NOT_CONFIRMED', 'JOINED_AFTER_CUTOFF', 'JOINED_AFTER_EFFECTIVE_DATE',
                                                       'SERVICE_INTERVAL_NOT_COMPLETED', 'APPRAISAL_NOT_COMPLETED', 'NO_SALARY_BASELINE',
                                                       'ROSTER_FROZEN')),
  created_at      timestamptz not null default now(),
  created_by      uuid references user_account (id) on delete restrict,
  updated_at      timestamptz not null default now(),
  updated_by      uuid references user_account (id) on delete restrict,
  version         integer not null default 1 check (version > 0),
  unique (company_id, id),
  -- Idempotent per job, employee and occurrence; also the job's rows in one index.
  unique (company_id, bulk_job_id, employee_id, occurrence_key),
  foreign key (company_id, bulk_job_id) references bulk_job (company_id, id) on delete restrict,
  foreign key (company_id, cycle_id) references increment_cycle (company_id, id) on delete restrict,
  foreign key (company_id, employee_id) references employee (company_id, id) on delete restrict
);
create trigger increment_review_exclusion_append_only before update or delete on increment_review_exclusion
  for each row execute function hrms_append_only();
