-- 0182 Saturday-working patterns and half weekly-offs (FR-005 "Maintain location-specific holidays and weekly-off
-- patterns"; E05 "half weekly-off"; DF05 "Monday-Friday workdays", "Shift and holiday calendars are editable and
-- effective-dated"; I-58). Decided under owner delegation, 6 Nov 2026 (owner chose process rules only): I-78 item 4.
--
-- A weekly-off pattern entry (0104) keeps its whole weekdays off every week (off_days) and may add, for weekdays that are
-- not off every week, the occurrences in the month that are:
--   off_occurrences  a whole day off on the nth such weekday of the month, e.g. the 2nd and 4th Saturdays;
--   half_off         a half weekly-off on the nth such weekday of the month (all five: every week).
-- Each value is a code weekday x 10 + n: ISO weekday 1 (Monday) .. 7 (Sunday), n 1 .. 5, the nth occurrence counted from
-- the 1st of the month (days 1-7 are the 1st, 8-14 the 2nd, and so on). Codes are ascending without repeats; an occurrence
-- of a weekday already off every week is refused, and a half weekly-off cannot fall on a whole one.
--
-- A whole occurrence off is an ordinary weekly off for every count (attendance, leave, outdoor duty, holiday work, payroll
-- loss of pay, timesheet utilisation), so a payroll calculation counts it as it counts any other off day. A half weekly-off
-- stays a working day for every count (so no leave or pay rule changes); only attendance evaluation measures it against the
-- first half of the shift. With no entry in force the DF05 default stays: Saturday and Sunday off every week.

create function hrms_week_occurrence_code(p_day date) returns smallint language sql immutable as $$
  select (extract(isodow from p_day)::int * 10 + (extract(day from p_day)::int - 1) / 7 + 1)::smallint
$$;

create function hrms_weekly_off_codes_valid(p_off_days smallint[], p_codes smallint[]) returns boolean language sql immutable as $$
  select p_codes = coalesce((select array_agg(distinct c order by c) from unnest(p_codes) as c), '{}'::smallint[])
     and not exists (select 1 from unnest(p_codes) as c where c / 10 not between 1 and 7 or c % 10 not between 1 and 5 or (c / 10)::smallint = any(p_off_days))
$$;

alter table weekly_off_pattern
  add column off_occurrences smallint[] not null default '{}',
  add column half_off        smallint[] not null default '{}',
  add constraint weekly_off_pattern_occurrences_valid check (hrms_weekly_off_codes_valid(off_days, off_occurrences)),
  add constraint weekly_off_pattern_half_off_valid check (hrms_weekly_off_codes_valid(off_days, half_off) and not (half_off && off_occurrences));

-- 'OFF', 'HALF' or null (a working day) for `p_day` under the entry given; with no entry (null off days), the whole weekdays
-- of the default the caller passes (shift/calendar.ts holds the DF05 default).
create function hrms_weekly_off_kind(p_day date, p_off_days smallint[], p_off_occurrences smallint[], p_half_off smallint[], p_default smallint[]) returns text
language sql immutable as $$
  select case
           when extract(isodow from p_day)::smallint = any(coalesce(p_off_days, p_default))
                or hrms_week_occurrence_code(p_day) = any(coalesce(p_off_occurrences, '{}')) then 'OFF'
           when hrms_week_occurrence_code(p_day) = any(coalesce(p_half_off, '{}')) then 'HALF'
         end
$$;
