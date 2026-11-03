// The working calendar every day count reads (FR-005, FR-020, FR-024, FR-027, FR-028, FR-032; DF05; 0103, 0104).
//
// A day is off for an employee when it is a weekly off, or an active holiday, of the location the employee is assigned to
// that day. A location without a weekly-off pattern in force keeps the DF05 default, Saturday and Sunday. These fragments
// are the only place that knows it: attendance evaluation and amendment, leave and work-request day counts, payroll unpaid
// leave and timesheet utilisation all use them, so they cannot disagree.
//
// Workflow waits (notification/reminders.ts, payroll/holds.ts) count "business days" on "the company calendar" (DF03), and
// no company calendar exists, so they keep Monday to Friday until the owner says which calendar that is.
//
// A calendar change is applied to a day only when that day is next evaluated (I-04's rule): HR reprocesses the dates
// `evaluatedDays` lists, and a day a processed payroll used stays as it is (I-54).
import type { Queryable } from '../../db/queryable.js';

/** ISO weekdays off without a pattern in force: DF05 "Monday-Friday workdays". */
export const DEFAULT_OFF_DAYS: readonly number[] = [6, 7];

/**
 * Orders calendar changes against the start of a payroll calculation, which reads the calendar known at one instant
 * (`calendar_as_of`, 0104). The holder then stamps with clock_timestamp(), so a change is either complete before that
 * instant or stamped after it.
 */
export async function lockCalendar(tx: Queryable, companyId: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`calendar:${companyId}`]);
}

/** The location assignment of `employee` on `day`, for a query over alias ea. */
const assignedOn = (day: string, employee: string, company: string) =>
  `ea.company_id = ${company} and ea.employee_id = ${employee} and ea.effective_from <= ${day}::date and (ea.effective_to is null or ea.effective_to > ${day}::date)`;

/** SQL truth of "`day` is a weekly off of the employee's location". `asOf`: read the patterns known at that instant. */
export const weeklyOffSql = (day: string, employee: string, company: string, asOf?: string) => `(extract(isodow from ${day}::date)::smallint = any(coalesce(
    (select p.off_days from employment_assignment ea
       join weekly_off_pattern p on p.company_id = ea.company_id and p.location_id = ea.location_id and p.effective_from <= ${day}::date
                                ${asOf ? `and p.created_at <= coalesce(${asOf}, 'infinity'::timestamptz)` : ''}
      where ${assignedOn(day, employee, company)}
      order by p.effective_from desc, p.revision desc limit 1),
    '{${DEFAULT_OFF_DAYS.join(',')}}'::smallint[])))`;

/** SQL truth of "`day` is a holiday of the employee's location". `asOf`: read the holidays in force at that instant. */
export const holidaySql = (day: string, employee: string, company: string, asOf?: string) => `exists (
    select 1 from holiday h join employment_assignment ea on ea.company_id = h.company_id and ea.location_id = h.location_id
     where ${assignedOn(day, employee, company)} and h.company_id = ${company} and h.holiday_date = ${day}::date
       and ${asOf ? `h.created_at <= coalesce(${asOf}, 'infinity'::timestamptz) and (h.closed_at is null or h.closed_at > coalesce(${asOf}, 'infinity'::timestamptz))` : `h.state = 'ACTIVE'`})`;

/** SQL truth of "`day` is a working day of the employee". */
export const workingDaySql = (day: string, employee: string, company: string, asOf?: string) =>
  `not ${weeklyOffSql(day, employee, company, asOf)} and not ${holidaySql(day, employee, company, asOf)}`;

export interface ReprocessDay {
  workDate: string;
  /** Evaluated results HR's processing of this date would re-evaluate. */
  toReprocess: number;
  /** Amended results: processing leaves them as they are (SKIPPED_AMENDED). */
  amended: number;
  /** Results a processed payroll used: final (SKIPPED_LOCKED, I-54). */
  locked: number;
}

export interface ReprocessList {
  days: ReprocessDay[];
  /** More dates exist than the list shows. */
  truncated: boolean;
}

/** Technical bound on one list (a year of dates), not a business rule. */
const MAX_REPROCESS_DAYS = 366;

/**
 * The evaluated days a calendar change touches, per date: nothing re-evaluates them until HR processes the date again.
 * Filters: dates from `from` to `to` (open when null), the ISO weekdays that changed, employees assigned to a location
 * that day, results pinned to a shift.
 */
export async function evaluatedDays(
  db: Queryable,
  companyId: string,
  f: { from: string; to?: string | null; weekdays?: number[]; locationId?: string; shiftId?: string },
): Promise<ReprocessList> {
  const rows = (
    await db.query<ReprocessDay>(
      `select to_char(r.work_date, 'YYYY-MM-DD') as "workDate",
              (count(*) filter (where not x.frozen and not r.amended))::int as "toReprocess",
              (count(*) filter (where not x.frozen and r.amended))::int as amended,
              (count(*) filter (where x.frozen))::int as locked
         from attendance_record r
         cross join lateral (select hrms_attendance_day_frozen(r.company_id, r.employee_id, r.work_date) as frozen) x
        where r.company_id = $1 and r.work_date >= $2::date and ($3::date is null or r.work_date <= $3::date)
          and ($4::int[] is null or extract(isodow from r.work_date)::int = any($4::int[]))
          and ($5::uuid is null or r.shift_id = $5::uuid)
          and ($6::uuid is null or exists (select 1 from employment_assignment ea
                                            where ea.company_id = r.company_id and ea.employee_id = r.employee_id and ea.location_id = $6::uuid
                                              and ea.effective_from <= r.work_date and (ea.effective_to is null or ea.effective_to > r.work_date)))
        group by r.work_date order by r.work_date limit $7::int`,
      [companyId, f.from, f.to ?? null, f.weekdays ?? null, f.shiftId ?? null, f.locationId ?? null, MAX_REPROCESS_DAYS + 1],
    )
  ).rows;
  return { days: rows.slice(0, MAX_REPROCESS_DAYS), truncated: rows.length > MAX_REPROCESS_DAYS };
}

/** Two lists as one, per date. */
export function mergeEvaluatedDays(a: ReprocessList, b: ReprocessList): ReprocessList {
  const byDate = new Map<string, ReprocessDay>(a.days.map((d) => [d.workDate, { ...d }]));
  for (const d of b.days) {
    const seen = byDate.get(d.workDate);
    if (seen) {
      seen.toReprocess += d.toReprocess;
      seen.amended += d.amended;
      seen.locked += d.locked;
    } else byDate.set(d.workDate, { ...d });
  }
  return { days: [...byDate.values()].sort((x, y) => x.workDate.localeCompare(y.workDate)), truncated: a.truncated || b.truncated };
}

/** The counts of a list, for the audit record. */
export const evaluatedDaysSummary = (l: ReprocessList) => ({
  dates: l.days.length,
  toReprocess: l.days.reduce((n, d) => n + d.toReprocess, 0),
  amended: l.days.reduce((n, d) => n + d.amended, 0),
  locked: l.days.reduce((n, d) => n + d.locked, 0),
  truncated: l.truncated,
});
