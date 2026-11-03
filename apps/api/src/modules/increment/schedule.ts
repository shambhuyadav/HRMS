// Review occurrences of one employee under a cycle code (DF15; FR-091; DB102). An occurrence is one review of the
// employee under the code in a year, keyed CODE:YYYY (one case per employee and key). A common-date occurrence falls on
// the cycle date; an anniversary occurrence on the employee's service anniversary (service_anniversary_date, else the
// joining date; 29 February falls on 28 February in non-leap years, the DF12 month-end clamp) in the years that
// complete a whole number of recurrence intervals of service. Each occurrence belongs to the revision of the code in
// force on its scheduled date. An approved override on the employee's plan replaces that occurrence's date.
import type { Queryable } from '../../db/queryable.js';

export interface Occurrence {
  key: string;
  year: number;
  cycleId: string;
  scheduledDate: string;
  hasCase: boolean;
}

export interface NextReview {
  next: Occurrence & { effectiveDate: string; overridden: boolean };
  following: Occurrence | null;
}

export interface PlanRow {
  id: string;
  cycle_id: string;
  cycle_code: string;
  effective_from: string;
  effective_to: string | null;
  next_review_date: string;
  override_review_date: string | null;
  override_occurrence_key: string | null;
}

/** Serialises plan changes of one employee; taken before any plan or proposal row lock. */
export async function lockEmployeePlan(tx: Queryable, employeeId: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('increment-plan:' || $1, 0))`, [employeeId]);
}

/** The employee's current revision: the open-ended plan row that nothing has replaced. */
export async function currentPlan(db: Queryable, companyId: string, employeeId: string): Promise<PlanRow | undefined> {
  return (
    await db.query<PlanRow>(
      `select p.id, p.cycle_id, c.code as cycle_code, to_char(p.effective_from, 'YYYY-MM-DD') as effective_from,
              to_char(p.effective_to, 'YYYY-MM-DD') as effective_to, to_char(p.next_review_date, 'YYYY-MM-DD') as next_review_date,
              to_char(p.override_review_date, 'YYYY-MM-DD') as override_review_date, p.override_occurrence_key
         from employee_increment_plan p join increment_cycle c on c.company_id = p.company_id and c.id = p.cycle_id
        where p.company_id = $1 and p.employee_id = $2 and p.active`,
      [companyId, employeeId],
    )
  ).rows[0];
}

/** FR-091 company rule: the company-default cycle revision in force on a date, if any. */
export async function companyDefaultOn(db: Queryable, companyId: string, day: string): Promise<{ id: string; code: string } | undefined> {
  return (
    await db.query<{ id: string; code: string }>(
      `select id, code from increment_cycle
        where company_id = $1 and active and assignment_rule = 'COMPANY_DEFAULT'
          and effective_from <= $2::date and (effective_to is null or effective_to > $2::date)`,
      [companyId, day],
    )
  ).rows[0];
}

/**
 * The employee's occurrences under a code from the year before `fromDate`, in date order, one per key, over a
 * horizon of two recurrence intervals: enough to find the next review and the one after it.
 */
export async function occurrencesOf(db: Queryable, companyId: string, employeeId: string, code: string, fromDate: string): Promise<Occurrence[]> {
  const rows = (
    await db.query<{ y: number; cycle_id: string; s: string; has_case: boolean }>(
      `with rev as (
         select id, recurrence_basis as basis, recurrence_interval as n, recurrence_anchor_month as am, recurrence_anchor_day as ad,
                effective_from as rf, effective_to as rt
           from increment_cycle where company_id = $1 and code = $2 and active),
       emp as (select coalesce(service_anniversary_date, joining_date) as base from employee where company_id = $1 and id = $3)
       select g.y, r.id as cycle_id, to_char(o.s, 'YYYY-MM-DD') as s,
              exists (select 1 from increment_case k
                       where k.company_id = $1 and k.employee_id = $3 and k.cycle_occurrence_key = $2 || ':' || g.y) as has_case
         from emp
        cross join rev r
        cross join lateral generate_series(extract(year from $4::date)::int - 1, extract(year from $4::date)::int + 2 * r.n + 1) as g (y)
        cross join lateral (select case when r.basis = 'COMMON_DATE' then hrms_increment_date(g.y, r.am, r.ad)
                                        else hrms_increment_date(g.y, extract(month from emp.base)::int, extract(day from emp.base)::int) end as s) o
        where o.s >= r.rf and (r.rt is null or o.s < r.rt)
          and (r.basis = 'COMMON_DATE'
               or (g.y - extract(year from emp.base)::int >= r.n and (g.y - extract(year from emp.base)::int) % r.n = 0))
        order by o.s, g.y`,
      [companyId, code, employeeId, fromDate],
    )
  ).rows;
  const seen = new Set<string>();
  const out: Occurrence[] = [];
  for (const r of rows) {
    const key = `${code}:${r.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, year: r.y, cycleId: r.cycle_id, scheduledDate: r.s, hasCase: r.has_case });
  }
  return out;
}

/**
 * The next review: the first occurrence without a case whose effective date (the plan's approved override of it,
 * else its scheduled date) is `today` or later; and the occurrence scheduled after it.
 */
export function nextReview(occurrences: Occurrence[], plan: Pick<PlanRow, 'override_occurrence_key' | 'override_review_date'> | undefined, today: string): NextReview | null {
  for (let i = 0; i < occurrences.length; i++) {
    const o = occurrences[i]!;
    const overridden = plan?.override_occurrence_key === o.key && plan.override_review_date !== null;
    const effectiveDate = overridden ? plan.override_review_date! : o.scheduledDate;
    if (o.hasCase || effectiveDate < today) continue;
    return { next: { ...o, effectiveDate, overridden }, following: occurrences[i + 1] ?? null };
  }
  return null;
}
