-- 0181 Overtime candidates and late minutes (FR-020 "derive worked minutes, lateness, early departure, absence, half day and
-- overtime candidates ... the exact rounding, punch pairing and precedence rules require approval"; DF05 "no automatic
-- overtime ... Overtime requires a separate manager decision and configured approved rate before payroll inclusion"; E05
-- overtime settings; E07 minute comparison). Decided under owner delegation, 6 Nov 2026 (owner chose process rules only):
-- I-78 items 5 and 6.
--
-- Overtime here is a CANDIDATE only: minutes a manager may later be asked to decide on. Nothing values or pays it, and no
-- payroll reads it. An attendance policy revision whose overtime setting is on names its basis, its minimum and its rounding
-- unit; the BRD gives no value for any of them, so all three are required together and none has a default:
--   AFTER_SHIFT_END       covered minutes after the scheduled end (the end of the working half on a half weekly-off);
--   BEYOND_SCHEDULED_NET  worked minutes above the scheduled net minutes.
-- Below the minimum nothing is a candidate; at or above it the minutes are rounded down to a whole number of units, so
-- unworked time is never proposed. On a weekly off or holiday every worked minute is a candidate; on a working day only a
-- PRESENT result has candidates; leave, half-day leave, on-duty days, exceptions, absence and half days have none.
-- A revision with the setting off has no candidates (null on its results).
--
-- Late minutes (E07): minutes from the scheduled shift start to the first covered minute when the day is late (after the
-- inclusive grace), otherwise 0. Grace only decides the flag; the minutes count from the start. Null on a result evaluated
-- before this migration, until it is processed again.

alter table attendance_policy
  add column overtime_basis            text check (overtime_basis in ('AFTER_SHIFT_END', 'BEYOND_SCHEDULED_NET')),
  add column overtime_minimum_minutes  integer check (overtime_minimum_minutes between 0 and 1440),
  add column overtime_rounding_minutes integer check (overtime_rounding_minutes between 1 and 1440),
  add constraint attendance_policy_overtime_settings check (
    num_nulls(overtime_basis, overtime_minimum_minutes, overtime_rounding_minutes) in (0, 3)
    and (overtime_enabled or overtime_basis is null));

-- An activated revision is frozen, its overtime settings included (0008).
create or replace function hrms_attendance_policy_frozen() returns trigger language plpgsql as $$
begin
  if old.state <> 'DRAFT' and (new.code, new.revision, new.effective_from, new.grace_minutes, new.present_percent,
                               new.half_day_percent, new.overtime_enabled, new.overtime_basis, new.overtime_minimum_minutes,
                               new.overtime_rounding_minutes)
                              is distinct from
                              (old.code, old.revision, old.effective_from, old.grace_minutes, old.present_percent,
                               old.half_day_percent, old.overtime_enabled, old.overtime_basis, old.overtime_minimum_minutes,
                               old.overtime_rounding_minutes) then
    raise exception 'an activated attendance policy is immutable; create a new revision' using errcode = '23514';
  end if;
  return new;
end $$;

-- A revision whose overtime setting is on leaves DRAFT only with its rules. One activated before this migration keeps its
-- setting and simply has no candidates.
create function hrms_attendance_policy_overtime_ready() returns trigger language plpgsql as $$
begin
  if old.state = 'DRAFT' and new.state <> 'DRAFT' and new.overtime_enabled and new.overtime_basis is null then
    raise exception 'an attendance policy with overtime on needs its basis, minimum and rounding before activation' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger attendance_policy_overtime_ready before update of state on attendance_policy
  for each row execute function hrms_attendance_policy_overtime_ready();

alter table attendance_record
  add column late_minutes               integer check (late_minutes >= 0),
  add column overtime_candidate_minutes integer check (overtime_candidate_minutes >= 0),
  add constraint attendance_record_late_minutes_flag check (late_minutes is null or late = (late_minutes > 0));
alter table attendance_record_revision
  add column late_minutes               integer,
  add column overtime_candidate_minutes integer;

-- A change of a result's values, these included, needs its revision (0111).
create or replace function hrms_attendance_record_guard() returns trigger language plpgsql as $$
begin
  if (new.shift_id, new.policy_id, new.scheduled_net_minutes, new.worked_minutes, new.late, new.early_departure, new.status_id, new.exception_code, new.amended,
      new.late_minutes, new.overtime_candidate_minutes)
     is distinct from
     (old.shift_id, old.policy_id, old.scheduled_net_minutes, old.worked_minutes, old.late, old.early_departure, old.status_id, old.exception_code, old.amended,
      old.late_minutes, old.overtime_candidate_minutes) then
    if hrms_attendance_day_frozen(old.company_id, old.employee_id, old.work_date) then
      raise exception 'attendance of % is used by a processed payroll', old.work_date using errcode = '23514';
    end if;
    if not exists (select 1 from attendance_record_revision v where v.company_id = old.company_id and v.attendance_record_id = old.id and v.prior_version = old.version) then
      raise exception 'an attendance result changes only with its revision' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
