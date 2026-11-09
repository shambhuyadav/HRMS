-- 0180 Shift buffer (FR-005 "maintain shift in/out and break times, buffer, calculated hours, 24-hour-cycle indicator";
-- BR-008; E04 "buffer ... 24 Hrs Cycle"; DF05 "Overnight shifts belong to the date of scheduled shift start"). Decided under
-- owner delegation, 6 Nov 2026 (owner chose process rules only): I-78 item 1.
--
-- The buffer is the punch capture window of a shift: the punches from `buffer_minutes` before the scheduled start until
-- `buffer_minutes` after the scheduled end (that instant excluded) belong to the shift's day, the date of its start.
-- Its range keeps the windows of one shift on consecutive days apart, so a punch belongs to at most one day of it:
-- 0 <= buffer and scheduled minutes + 2 x buffer <= 1440. The BRD gives no value, so a new shift states it (the API
-- requires it); a revision keeps the buffer in force unless it names one. A shift or revision recorded before this
-- migration keeps the window it has been evaluated with (four hours each side), narrowed only where that broke the rule
-- (a shift longer than 16 hours) to the widest buffer that keeps the windows apart.
--
-- The 24-hour-cycle indicator is the overnight flag, spans_midnight, derived from the clock times (0006, 0103 check it):
-- it means nothing more, and a shift of exactly 24 hours (equal in and out times) stays refused.
--
-- Like the times, the buffer of revision 1 (the shift row) never changes, and a revision is append-only: a change is a
-- dated revision, and an evaluated day keeps the revision it pinned until HR reprocesses it (0103).

create function hrms_shift_buffer_fits(p_in time, p_out time, p_spans boolean, p_buffer integer) returns boolean
language sql immutable as $$
  select p_buffer >= 0 and hrms_shift_minutes(p_in, p_out, p_spans) + 2 * p_buffer <= 1440
$$;

alter table shift add column buffer_minutes integer;
update shift set buffer_minutes = least(240, (1440 - hrms_shift_minutes(in_time, out_time, spans_midnight)) / 2);
alter table shift
  alter column buffer_minutes set not null,
  add constraint shift_buffer_fits check (hrms_shift_buffer_fits(in_time, out_time, spans_midnight, buffer_minutes));

alter table shift_revision add column buffer_minutes integer;
alter table shift_revision disable trigger shift_revision_append_only;
update shift_revision set buffer_minutes = least(240, (1440 - hrms_shift_minutes(in_time, out_time, spans_midnight)) / 2);
alter table shift_revision enable trigger shift_revision_append_only;
alter table shift_revision
  alter column buffer_minutes set not null,
  add constraint shift_revision_buffer_fits check (hrms_shift_buffer_fits(in_time, out_time, spans_midnight, buffer_minutes));

-- Revision 1's buffer is as fixed as its times.
create trigger shift_buffer_frozen before update of buffer_minutes on shift
  for each row when (new.buffer_minutes is distinct from old.buffer_minutes)
  execute function hrms_shift_times_frozen();

-- The buffer of one revision (null: the shift row), as evaluation pins it.
create function hrms_shift_buffer(p_company uuid, p_shift uuid, p_revision uuid) returns integer language sql stable as $$
  select coalesce((select r.buffer_minutes from shift_revision r where p_revision is not null and r.company_id = p_company and r.shift_id = p_shift and r.id = p_revision),
                  (select s.buffer_minutes from shift s where p_revision is null and s.company_id = p_company and s.id = p_shift))
$$;
