// Payroll input cutoff of an employee's current open period (FR-105 "apply approved changes according to their
// effective date and payroll cutoff"; H3 TN03 "evidence, approval and cutoff warning"; H4 "Bank revisions after cutoff
// warn employee and cannot silently replace frozen instruction details"; I-18). A warning only: it never blocks.
//
// The employee's calendar, as payroll itself associates employees with calendars (a run is a calendar's period with
// department/grade/location filters matched against the employee's assignment; runs.ts):
//   1. the calendar of the run that last included the employee as a live member;
//   2. otherwise the one active calendar whose runs' department/grade/location scope covers the employee's assignment
//      on the business date;
//   3. otherwise the company's only active calendar.
// Anything else (no active calendar, or several that could apply) means no calendar applies, and nothing is returned.
// The current open period is the calendar's earliest period whose payment date is today or later (not yet paid).
import type { Queryable } from '../../db/queryable.js';

export interface PayrollCutoffWarning {
  code: 'AFTER_PAYROLL_CUTOFF';
  calendarCode: string;
  periodCode: string;
  inputCutoff: string;
  paymentDate: string;
  effectiveDate: string;
  message: string;
}

const single = (rows: { calendar_id: string }[]) => (rows.length === 1 ? rows[0]!.calendar_id : null);

/** The employee's payroll calendar (active), or null when none can be said to apply. */
export async function employeePayrollCalendar(db: Queryable, companyId: string, employeeId: string, businessDate: string): Promise<string | null> {
  const member = (
    await db.query<{ calendar_id: string }>(
      `select r.calendar_id from payroll_run_member m
         join payroll_run r on r.company_id = m.company_id and r.id = m.lineage_id
         join payroll_calendar k on k.company_id = r.company_id and k.id = r.calendar_id and k.state = 'ACTIVE'
        where m.company_id = $1 and m.employee_id = $2 and m.live and m.excluded_from_revision is null
        order by m.service_month desc limit 1`,
      [companyId, employeeId],
    )
  ).rows[0];
  if (member) return member.calendar_id;
  const scoped = await db.query<{ calendar_id: string }>(
    `select distinct r.calendar_id from payroll_run r
       join payroll_calendar k on k.company_id = r.company_id and k.id = r.calendar_id and k.state = 'ACTIVE'
       join employment_assignment ea on ea.company_id = r.company_id and ea.employee_id = $2
            and ea.effective_from <= $3::date and (ea.effective_to is null or ea.effective_to > $3::date)
      where r.company_id = $1 and r.state <> 'CANCELLED'
        and (cardinality(r.scope_department_ids) = 0 or ea.department_id = any(r.scope_department_ids))
        and (cardinality(r.scope_grade_ids) = 0 or ea.grade_id = any(r.scope_grade_ids))
        and (cardinality(r.scope_location_ids) = 0 or ea.location_id = any(r.scope_location_ids))
      limit 2`,
    [companyId, employeeId, businessDate],
  );
  if (scoped.rows.length > 0) return single(scoped.rows);
  return single((await db.query<{ calendar_id: string }>(`select id as calendar_id from payroll_calendar where company_id = $1 and state = 'ACTIVE' limit 2`, [companyId])).rows);
}

/**
 * A warning when a change effective on `effectiveDate` falls after the input cutoff of the employee's current open
 * payroll period; null when it does not, or when no calendar or open period applies.
 */
export async function payrollCutoffWarning(db: Queryable, companyId: string, employeeId: string, effectiveDate: string, businessDate: string): Promise<PayrollCutoffWarning | null> {
  const calendarId = await employeePayrollCalendar(db, companyId, employeeId, businessDate);
  if (!calendarId) return null;
  const p = (
    await db.query<{ calendar_code: string; period_code: string; input_cutoff: string; payment_date: string }>(
      `select k.code as calendar_code, p.period_code, to_char(p.input_cutoff, 'YYYY-MM-DD') as input_cutoff, to_char(p.payment_date, 'YYYY-MM-DD') as payment_date
         from payroll_period p join payroll_calendar k on k.company_id = p.company_id and k.id = p.calendar_id
        where p.company_id = $1 and p.calendar_id = $2 and p.payment_date >= $3::date
        order by p.service_start limit 1`,
      [companyId, calendarId, businessDate],
    )
  ).rows[0];
  if (!p || effectiveDate <= p.input_cutoff) return null;
  return {
    code: 'AFTER_PAYROLL_CUTOFF',
    calendarCode: p.calendar_code,
    periodCode: p.period_code,
    inputCutoff: p.input_cutoff,
    paymentDate: p.payment_date,
    effectiveDate,
    message:
      `This bank change takes effect on ${effectiveDate}, after the input cutoff (${p.input_cutoff}) of payroll period ${p.period_code}; ` +
      `the ${p.period_code} payment due on ${p.payment_date} may still be made to the current bank account.`,
  };
}
