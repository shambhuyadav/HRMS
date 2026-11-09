-- 0183 Leave year and the year-end expiry above the carry cap (FR-024 "Target rules include accrual, eligibility,
-- carry-forward, expiry ... values need approval"; FR-025 "Proposed leave ledger records opening, accrual, approved usage,
-- reversals, expiry, adjustments and closing balance"; DF05 "Leave policy contains ... carry cap/expiry", "Carry is zero
-- unless explicitly configured; no negative paid balance"). Decided under owner delegation, 6 Nov 2026 (owner chose process
-- rules only): I-78 item 3.
--
-- Leave year. A policy revision names the month its leave year starts (1 January .. 12 December); the year ends on the last
-- day of the month before. Companies differ (calendar year, April-March), and the BRD gives no month, so there is no
-- default: a revision without it is never expired, and the year-end run counts it as not configured. Like every other
-- parameter it is set on the draft and frozen once active, under the independent activation.
--
-- Year-end expiry (leave/service.ts yearEndChunk). For each employee in service on the leave year's last day and each paid
-- leave type whose policy in force on that day has that year end, the units held at the end of the day above the policy's
-- carry cap expire as one EXPIRY movement dated that day, at most once (its key names the employee, type and year end). Units
-- already committed to later dates (approved or pending leave after the year end) are not expired from under it, so an
-- expiry never takes the balance below zero; this is also refused here. An employee with a leave request of that type still
-- pending on a date in the closing year is skipped and counted until it is decided, and a later run picks them up.
alter table leave_policy add column leave_year_start_month smallint check (leave_year_start_month between 1 and 12);

create or replace function hrms_leave_policy_frozen() returns trigger language plpgsql as $$
begin
  if old.state <> 'DRAFT' and (new.leave_type_id, new.revision, new.effective_from, new.eligibility_code, new.accrual_rule_code,
                               new.annual_entitlement, new.min_service_days, new.carry_cap, new.leave_year_start_month)
                              is distinct from
                              (old.leave_type_id, old.revision, old.effective_from, old.eligibility_code, old.accrual_rule_code,
                               old.annual_entitlement, old.min_service_days, old.carry_cap, old.leave_year_start_month) then
    raise exception 'an activated leave policy is immutable; create a new revision' using errcode = '23514';
  end if;
  if old.state = 'RETIRED' and new.state <> 'RETIRED' then
    raise exception 'a retired leave policy cannot be reactivated' using errcode = '23514';
  end if;
  return new;
end $$;

-- DF05 "no negative paid balance": an expiry takes away only what is there. Checked after the row, under the balance lock
-- the service holds.
create function hrms_leave_expiry_not_negative() returns trigger language plpgsql as $$
begin
  if (select sum(units) from leave_movement where company_id = new.company_id and employee_id = new.employee_id and leave_type_id = new.leave_type_id) < 0 then
    raise exception 'an expiry cannot take a leave balance below zero' using errcode = '23514';
  end if;
  return null;
end $$;
create trigger leave_movement_expiry_not_negative after insert on leave_movement
  for each row when (new.movement_kind = 'EXPIRY')
  execute function hrms_leave_expiry_not_negative();

-- The year-end run is a bulk job (NFR-S09), beside the monthly accrual.
alter table bulk_job drop constraint bulk_job_kind_check;
alter table bulk_job add constraint bulk_job_kind_check check (kind in ('ATTENDANCE_PROCESSING', 'LEAVE_ACCRUAL', 'INCREMENT_REVIEW_OPENING', 'LEAVE_YEAR_END'));
