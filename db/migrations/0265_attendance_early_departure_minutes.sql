-- 0265 Early-departure minutes (FR-020 "derive worked minutes, lateness, early departure ..."; FR-021 / E07 minute comparison;
-- BRD coverage CL-050 "Shift Deviation Register", whose reference screen lists late-in, early-out and overtime minutes against the
-- shift). Decided under owner delegation (6 Nov 2026; recorded 10 Nov 2026), alongside I-78 items 5 and 6 (0181) for late and
-- overtime-candidate minutes.
--
-- Early-departure minutes: on a day flagged as an early departure, the minutes from the last covered minute (punch or approved
-- duty) to the scheduled end (the end of the working half on a half weekly-off), rounded up to whole minutes, so a flagged day
-- always shows at least one minute; 0 on every other day. The flag decides nothing new: the minutes only measure it. Stored with
-- the result like late minutes, so the deviation register reads what evaluation decided, a reprocessing keeps the replaced value
-- in the result's revision and an amendment that drops the flag drops the minutes. Nothing values or deducts them (DF05).
-- Null on a result evaluated before this migration, until it is processed again (one extra revision then, as after 0181).

alter table attendance_record
  add column early_departure_minutes integer check (early_departure_minutes >= 0),
  add constraint attendance_record_early_minutes_flag check (early_departure_minutes is null or early_departure = (early_departure_minutes > 0));
alter table attendance_record_revision
  add column early_departure_minutes integer;

-- A change of a result's values, this one included, needs its revision (0111, 0181).
create or replace function hrms_attendance_record_guard() returns trigger language plpgsql as $$
begin
  if (new.shift_id, new.policy_id, new.scheduled_net_minutes, new.worked_minutes, new.late, new.early_departure, new.status_id, new.exception_code, new.amended,
      new.late_minutes, new.overtime_candidate_minutes, new.early_departure_minutes)
     is distinct from
     (old.shift_id, old.policy_id, old.scheduled_net_minutes, old.worked_minutes, old.late, old.early_departure, old.status_id, old.exception_code, old.amended,
      old.late_minutes, old.overtime_candidate_minutes, old.early_departure_minutes) then
    if hrms_attendance_day_frozen(old.company_id, old.employee_id, old.work_date) then
      raise exception 'attendance of % is used by a processed payroll', old.work_date using errcode = '23514';
    end if;
    if not exists (select 1 from attendance_record_revision v where v.company_id = old.company_id and v.attendance_record_id = old.id and v.prior_version = old.version) then
      raise exception 'an attendance result changes only with its revision' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
