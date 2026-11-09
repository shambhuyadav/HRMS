// FR-038 salary progression chart (I-48 item 11, I-83 item 6; decided under owner delegation, 6 Nov 2026; DF14; BR-039; BR-044).
//
//   Measure   monthly gross fixed pay by default (DF14's primary comparable basis); annual CTC on request. Both are the stored
//             values of the employee's approved salary arrangements (E08), shown exactly as stored: never recomputed, converted
//             or estimated.
//   Grouping  one employee at a time, by Indian financial year (1 April to 31 March, as DF14's annual growth). A year's value is
//             the arrangement in force on its last day, or on today for the current year; its change is against the previous
//             year's value, in the same currency only (BR-039: per-change percentages are never summed). Group charts (department,
//             grade) are not built: they would be confidential derived totals (BR-045) needing their own decision.
//   Span      the last N financial years up to today, N from the dated reporting setting (default 5), or 1 to 20 on request.
//   Access    confidential: the selected assignment must hold salary.read and salary.history_read (the financial past, C4/C6)
//             with the employee in its row scope (C7: only an eligible Admin or Manager assignment can hold them). The Employee
//             OWN context holds neither, so H1 adds nothing here.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { settingInForce } from './settings.js';

export type ProgressionBasis = 'MONTHLY_GROSS' | 'ANNUAL_CTC';
export const MAX_SPAN_YEARS = 20;

const COLUMN: Record<ProgressionBasis, string> = { MONTHLY_GROSS: 'monthly_gross', ANNUAL_CTC: 'annual_ctc' };

/** The Indian financial year (its starting calendar year) of a YYYY-MM-DD date. */
export const financialYearOf = (day: string): number => (Number(day.slice(5, 7)) >= 4 ? Number(day.slice(0, 4)) : Number(day.slice(0, 4)) - 1);

type NaReason = 'NO_SALARY' | 'NO_PREVIOUS_SALARY' | 'CURRENCY_CHANGED' | 'ZERO_BASELINE';

export async function salaryProgression(db: Queryable, grant: AccessGrant, employeeId: string, q: { basis: ProgressionBasis; years?: number | undefined }) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  let years = q.years;
  if (years === undefined) {
    const setting = await settingInForce(db, grant.companyId, grant.businessDate);
    if (!setting) throw new HttpError(409, 'REPORTING_SETTING_MISSING', 'No reporting setting is in force, so the chart has no default span; ask for a number of years');
    years = setting.salaryProgressionYears;
  }
  const col = COLUMN[q.basis];
  const lastYear = financialYearOf(grant.businessDate);
  const firstYear = lastYear - years + 1;

  const employee = (await db.query<{ code: string; name: string }>(`select employee_code as code, display_name as name from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId])).rows[0]!;
  // One extra year before the span gives the first year its change.
  const yearRows = (
    await db.query<{ financial_year: number; period_start: string; value_date: string; amount: string | null; currency: string | null; prev_amount: string | null; prev_currency: string | null; change_percent: string | null }>(
      `with fy as (
         select y as financial_year, make_date(y, 4, 1) as period_start, least(make_date(y + 1, 3, 31), $3::date) as value_date
           from generate_series($4::int - 1, $5::int) as y
       ), v as (
         select fy.*, a.amount, a.currency
           from fy left join lateral (
             select s.${col} as amount, s.currency_code as currency from salary_arrangement s
              where s.company_id = $1 and s.employee_id = $2 and s.superseded_at is null
                and s.effective_from <= fy.value_date and (s.effective_to is null or s.effective_to > fy.value_date)
           ) a on true
       ), w as (
         select v.*, lag(v.amount) over (order by v.financial_year) as prev_amount, lag(v.currency) over (order by v.financial_year) as prev_currency from v
       )
       select financial_year, to_char(period_start, 'YYYY-MM-DD') as period_start, to_char(value_date, 'YYYY-MM-DD') as value_date,
              amount::text as amount, currency, prev_amount::text as prev_amount, prev_currency,
              case when amount is not null and prev_amount > 0 and currency = prev_currency
                   then to_char(round((amount - prev_amount) / prev_amount * 100, 2), 'FM999999990.00') end as change_percent
         from w where financial_year >= $4::int order by financial_year`,
      [grant.companyId, employeeId, grant.businessDate, firstYear, lastYear],
    )
  ).rows;
  const naReason = (r: (typeof yearRows)[number]): NaReason | null => {
    if (r.amount === null) return 'NO_SALARY';
    if (r.prev_amount === null) return 'NO_PREVIOUS_SALARY';
    if (r.currency !== r.prev_currency) return 'CURRENCY_CHANGED';
    if (r.change_percent === null) return 'ZERO_BASELINE';
    return null;
  };

  // The step line: every arrangement in force at some point of the span, as stored.
  const spanStart = `${firstYear}-04-01`;
  const steps = (
    await db.query(
      `select to_char(effective_from, 'YYYY-MM-DD') as "effectiveFrom", to_char(effective_to, 'YYYY-MM-DD') as "effectiveTo", ${col}::text as amount, currency_code as currency
         from salary_arrangement
        where company_id = $1 and employee_id = $2 and superseded_at is null and effective_from <= $3::date and (effective_to is null or effective_to > $4::date)
        order by effective_from`,
      [grant.companyId, employeeId, grant.businessDate, spanStart],
    )
  ).rows;

  return {
    employeeId,
    employeeCode: employee.code,
    employeeName: employee.name,
    basis: q.basis,
    span: { years, firstFinancialYear: firstYear, lastFinancialYear: lastYear, from: spanStart, to: grant.businessDate },
    years: yearRows.map((r) => ({
      financialYear: r.financial_year,
      label: `${r.financial_year}-${String((r.financial_year + 1) % 100).padStart(2, '0')}`,
      periodStart: r.period_start,
      valueDate: r.value_date,
      amount: r.amount,
      currency: r.currency,
      changePercent: r.change_percent,
      percentNaReason: naReason(r),
    })),
    steps,
  };
}
