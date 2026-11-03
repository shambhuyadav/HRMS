-- 0066 The rows of a bulk job belong to a job of their own kind, and a case's opening job never changes (NFR-S09;
-- ADR-15; 0053; 0057; 0058). The per-unit rows a chunk writes name their job by a foreign key only, which accepts a job
-- of any kind; and the opening job a cycle case names (increment_case.opened_by_job_id, the job's roster) could be
-- changed afterwards, moving the case to another opening's roster.
--   * an increment_review_exclusion row and an increment_review_run with a job name an INCREMENT_REVIEW_OPENING job;
--   * an attendance_processing_no_policy row names an ATTENDANCE_PROCESSING job;
--   * a case's opening job is fixed when the case is created: it names an INCREMENT_REVIEW_OPENING job (or none, for
--     a case opened otherwise) and is never set, changed or cleared afterwards.
-- A job's kind never changes (hrms_bulk_job_guard, 0053), so checking it on insert is enough. The rows are append-only
-- (0050, 0057, 0058). Rows written before this migration were written by their own kind's chunks.

-- A row of a bulk job names a job of the kind that writes such rows (tg_argv[0]).
create function hrms_bulk_job_row_kind() returns trigger language plpgsql as $$
begin
  if new.bulk_job_id is not null
     and not exists (select 1 from bulk_job j where j.company_id = new.company_id and j.id = new.bulk_job_id and j.kind = tg_argv[0]) then
    raise exception '% rows belong to a bulk job of kind %', tg_table_name, tg_argv[0] using errcode = '23514';
  end if;
  return new;
end $$;
create trigger increment_review_exclusion_job_kind before insert on increment_review_exclusion
  for each row execute function hrms_bulk_job_row_kind('INCREMENT_REVIEW_OPENING');
create trigger increment_review_run_job_kind before insert on increment_review_run
  for each row execute function hrms_bulk_job_row_kind('INCREMENT_REVIEW_OPENING');
create trigger attendance_processing_no_policy_job_kind before insert on attendance_processing_no_policy
  for each row execute function hrms_bulk_job_row_kind('ATTENDANCE_PROCESSING');

-- The opening job of a case: an increment review opening, named when the case is created and immutable after.
create function hrms_increment_case_opening_job() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    if new.opened_by_job_id is distinct from old.opened_by_job_id then
      raise exception 'the opening job of an increment case is immutable' using errcode = '23514';
    end if;
  elsif new.opened_by_job_id is not null
        and not exists (select 1 from bulk_job j where j.company_id = new.company_id and j.id = new.opened_by_job_id and j.kind = 'INCREMENT_REVIEW_OPENING') then
    raise exception 'an increment case is opened by a bulk job of kind INCREMENT_REVIEW_OPENING' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger increment_case_opening_job before insert or update on increment_case
  for each row execute function hrms_increment_case_opening_job();
