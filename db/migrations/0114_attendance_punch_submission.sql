-- 0114 Every imported punch traces to its submission (FR-019 "map confirmed device records to the correct employee, event
-- time and source submission; retain original evidence and identify invalid or repeated punches"; DF09; CR-005).
--
-- A punch points at the row of the import job that brought it: the job holds the stored file, its rows hold what was
-- accepted, quarantined or reported as a repeat. A new manual punch without a submission is refused at commit: the check
-- waits until then because a preview applies its rows in a transaction that is always rolled back, before the job exists.
-- Punches stored before this migration have no submission to name, and stay as they arrived (append-only).
-- The device or source of a row goes into source_identity_key, so equal device-local event keys of two devices no longer
-- collide; a row naming no source keeps the former 'manual-import' namespace, so replay protection of earlier punches holds.
alter table attendance_punch
  add column import_job_id uuid,
  add column import_row_number integer,
  -- An earlier punch with the same employee, instant and direction under another key (flagged, never paired differently:
  -- how such repeats pair stays under the approval FR-020 requires).
  add column repeat_of_punch_id uuid,
  add constraint attendance_punch_import_row_fk foreign key (company_id, import_job_id, import_row_number)
    references import_row (company_id, job_id, row_number) on delete restrict,
  add constraint attendance_punch_repeat_of_fk foreign key (company_id, repeat_of_punch_id)
    references attendance_punch (company_id, id) on delete restrict,
  add constraint attendance_punch_submission_pair check ((import_job_id is null) = (import_row_number is null));

create index attendance_punch_import_idx on attendance_punch (company_id, import_job_id, import_row_number) where (import_job_id is not null);

create function hrms_attendance_punch_needs_submission() returns trigger language plpgsql as $$
begin
  raise exception 'a manual punch is stored only through a tracked import submission' using errcode = '23514';
end $$;
create constraint trigger attendance_punch_manual_submission after insert on attendance_punch
  deferrable initially deferred
  for each row when (new.source_kind = 'MANUAL_IMPORT' and new.import_job_id is null)
  execute function hrms_attendance_punch_needs_submission();

-- The earliest stored punch this one would repeat, from any source.
create function hrms_punch_repeat_of(p_company uuid, p_employee uuid, p_at timestamptz, p_direction text) returns uuid language sql stable as $$
  select id from attendance_punch
   where company_id = p_company and employee_id = p_employee and occurred_at = p_at and direction = p_direction
   order by created_at, id limit 1
$$;
