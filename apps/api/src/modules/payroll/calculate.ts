// Payroll calculation of one run revision (FR-031, FR-032, FR-033; DF05; BR-049; H2; CP-08).
//
// The calculation of a revision starts once (`startCalculation`: the rules are fixed: the paid-day policy in effect on
// the service period's last day, in payroll_run_head the head revision in effect on that day for every pay component,
// and the holiday and weekly-off calendar as known at that instant) and then runs in chunks of members (`calculateChunk`), each in its own transaction, set-based, so that
// no statement or transaction spans the whole company. A chunk takes each member's snapshot from the masters
// (employee facts, eligible interval, arrangement segments, loss-of-pay days, salary components classified by the
// run's heads, approved inputs, the salary stop), raises the per-employee exceptions and derives the lines and
// totals from that snapshot alone. `verifyMembers` re-derives lines and totals from the stored snapshot and compares
// them with the stored results: a rerun on the same snapshot is identical, whatever happened to the masters since
// (FR-033, ZT36).
//
// DF05 as written: a monthly FIXED component x eligible paid calendar days / calendar days in that month, joining and
// leaving dates inclusive, each paid day counted once (one loss-of-pay row per day); every component is rounded
// half-up to the currency minor unit at its output and the record totals are sums of rounded lines; net = earnings +
// reimbursements - employee deductions; employer contributions are a separate cost. Approved unpaid leave is loss of
// pay on the working days it covers (the location calendar, the leave module's own day rule, shift/calendar.ts, so the
// loss equals the approved units); attendance reduces paid days only under an activated paid-day policy
// (BR-049), and without one any absence, half day or unresolved attendance day is reported for a documented
// resolution instead of being guessed. Late flags and missing timesheets never reduce pay.
import type { Queryable } from '../../db/queryable.js';
import { lockCalendar, workingDaySql } from '../shift/calendar.js';
import { evaluateRulePackHeads, STATUTORY_EXCEPTION_CODES } from '../statutory/evaluate.js';
import { bankChecks } from './bank.js';
import { advisoryLock, loanOutstandingSql } from './common.js';

/** Members per chunk transaction (an engineering bound for the 15 s statement timeout, CP-08; not a business rule). */
export const CHUNK = 500;

export interface RunContext {
  id: string;
  company_id: string;
  period_id: string;
  service_start: string;
  service_end: string;
  days_in_month: number;
  currency_code: string;
  currency_minor_unit: number;
}

export interface PolicySnapshot {
  id: string | null;
  basis: 'APPROVED_LEAVE_ONLY' | 'REVIEWED_ATTENDANCE' | 'NOT_CONFIGURED';
  absent: string | null;
  half: string | null;
}

/**
 * Exception catalogue. BLOCKING exceptions stop approval; the non-resolvable ones prevent amounts (record FAILED) or
 * need corrected data, so the employee is excluded through a new revision; the resolvable ones need a documented
 * resolution by an independent payroll approver. Warnings inform.
 */
export const EXCEPTION_CODES = {
  LEAVING_DATE_UNKNOWN: 'Separated employee without an approved last working date',
  LEAVE_UNITS_MISMATCH: 'Approved unpaid leave units differ from its working days under the current calendar',
  NO_SALARY_ARRANGEMENT: 'No salary arrangement covers the eligible days',
  ARRANGEMENT_GAP: 'Salary arrangements do not cover every eligible day',
  CURRENCY_MISMATCH: 'A salary arrangement is not in the payroll calendar currency',
  SALARY_COMPONENTS_MISSING: 'A salary arrangement has no salary components',
  HEAD_NOT_CONFIGURED: 'A salary component has no payroll head in effect',
  RULE_PACK_NOT_CONFIGURED: 'A rule-pack head applies (as a salary component, or through its base heads) and needs an activated rule pack, and none is configured',
  COMPONENT_BASIS_NOT_MONTHLY: 'A fixed head needs a monthly salary component amount',
  COMPONENT_HEAD_NOT_FIXED: 'A salary component is classified by an input head; only approved inputs feed an input head',
  INPUT_HEAD_INVALID: 'An approved input feeds a component without an input head in effect',
  INPUT_CURRENCY_MISMATCH: 'An approved input is not in the payroll calendar currency',
  NEGATIVE_NET: 'Deductions exceed earnings; a negative net needs an activated recovery policy',
  LOAN_RECOVERY_EXCEEDS_OUTSTANDING: 'A deduction on a loan recovery head exceeds the outstanding balance, net of what payroll has already deducted (reverse the input and enter the correct one)',
  LOAN_RECOVERY_NOT_DISBURSED: 'A deduction on a loan recovery head has no disbursed loan with a balance behind it (disburse the loan, or reverse the input)',
  LOAN_RECOVERY_CURRENCY_MISMATCH: 'A deduction on a loan recovery head is not in the currency of the loan, so it could never be recognised as a recovery',
  ATTENDANCE_NOT_VALUED: 'Attendance outcomes exist but no paid-day policy values them (resolution confirms no attendance loss of pay)',
  ATTENDANCE_UNRESOLVED: 'Attendance days still need review (resolution confirms them as paid)',
  ATTENDANCE_NOT_EVALUATED: 'Days without an evaluated attendance outcome under a policy that values reviewed attendance (resolution confirms them as paid)',
  BANK_INSTRUCTION_NOT_READY: 'No verified approved bank instruction; processing will apply a payment safety block',
  SALARY_STOP_EXCLUDED: 'Excluded from calculation by an approved salary stop',
  SALARY_STOP_HOLD: 'An approved salary stop will hold the payment when processed',
  SALARY_STOP_OTHER_PERIOD:
    'An approved salary stop of the same service month belongs to another payroll calendar; it is never ignored (revoke it, or exclude the employee and pay them in the run of its period)',
  NO_SERVICE_IN_PERIOD: 'No service days in the period',
  SETTLED_IN_FINAL_SETTLEMENT: 'Paid by the final settlement (release-eligible or paid), which covers the period from the last working date; monthly payroll pays nothing more',
  INPUTS_NOT_INCLUDED: 'Approved inputs exist but the employee is not calculated (an input discrepancy: a payroll approver records the resolution)',
  INPUTS_OTHER_PERIOD: 'Approved inputs of the same service month belong to another payroll calendar (an input discrepancy: a payroll approver records the resolution)',
  NO_EARNINGS: 'The calculation produced no earnings',
  // I-85: raised by the statutory evaluator (statutory/evaluate.ts).
  ...STATUTORY_EXCEPTION_CODES,
} as const;

/**
 * A working day on the location calendar as this calculation knows it (alias r: its record): the calendar known when the
 * calculation started (`calendar_as_of`), so that a holiday or weekly-off change arriving between two chunks cannot give
 * two members of one revision different day counts. The loss-of-pay rows it produces are snapshot data, which is all a
 * rerun reads (verifyMembers).
 */
const WORKING_DAY = (day: string) =>
  workingDaySql(day, 'r.employee_id', 'r.company_id', `(select ru.calendar_as_of from payroll_run ru where ru.company_id = r.company_id and ru.id = r.run_id)`);

export const APPROVED_LEAVE_ON = (day: string) =>
  `exists (select 1 from leave_request lv where lv.company_id = r.company_id and lv.employee_id = r.employee_id and lv.state = 'APPROVED'
             and ${day} between lv.start_date and lv.end_date)`;

/**
 * FR-052 (I-80, decided under owner delegation, 6 Nov 2026): the employee `employee` has a final settlement that is release-eligible
 * or paid, and their approved last working date `lwd` falls on or before the run's service end `serviceEnd` (the period covers or
 * follows it). The settlement is their final pay from then on, so a monthly run pays them nothing more: no component is paid twice.
 * A voided settlement is CANCELLED and counts for nothing. `exists (...)`-ready predicate; settlement alias fs.
 */
export const SETTLED_FINALLY = (company: string, employee: string, lwd: string, serviceEnd: string) =>
  `exists (select 1 from settlement fs where fs.company_id = ${company} and fs.employee_id = ${employee} and fs.state in ('RELEASE_ELIGIBLE', 'PAID')
             and ${lwd} is not null and ${lwd} <= ${serviceEnd})`;

/**
 * FR-052 (I-88, decided under owner delegation, 6 Nov 2026): an approved arrears case or timesheet adjustment that the calculation carried by
 * a live or paid final settlement took (a calculated item naming it) is paid by that settlement, so no payroll run takes it as well. Once the
 * settlement is returned, rejected or cancelled the case is free again. `exists (...)`-ready predicate; item alias fsi, settlement alias fss.
 */
export const SETTLEMENT_TAKES = (company: string, column: 'arrears_case_id' | 'adjustment_id', id: string) =>
  `exists (select 1 from settlement_calculation_item fsi
             join settlement fss on fss.company_id = fsi.company_id and fss.calculation_id = fsi.calculation_id
            where fsi.company_id = ${company} and fsi.${column} = ${id} and fsi.status = 'CALCULATED'
              and fss.state in ('DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE', 'PAID'))`;

/** Records of the chunk that are calculated (eligible and not excluded by a stop). */
const COMPUTE = `r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]) and r.calculation_status = 'PENDING'
  and r.eligible_from is not null and r.salary_stop_mode is distinct from 'EXCLUDE_CALCULATION'`;

const EXCEPTION_INSERT = `insert into payroll_exception (company_id, run_id, record_id, employee_id, code, severity, resolvable, detail, created_by, updated_by)`;

export interface ValuationPolicy {
  id: string;
  arrears_component_id: string;
  adjustment_component_id: string;
  recovery_component_id: string | null;
  timesheet_unit: 'DAY' | 'HOUR';
  hours_per_day: string | null;
}

/** I-79 (decided under owner delegation, 6 Nov 2026): the active valuation policy in effect on `day`, if any (0205). */
export async function valuationPolicyOn(db: Queryable, companyId: string, day: string): Promise<ValuationPolicy | null> {
  return (
    (
      await db.query<ValuationPolicy>(
        `select id, arrears_component_id, adjustment_component_id, recovery_component_id, timesheet_unit, hours_per_day::text as hours_per_day
           from payroll_valuation_policy where company_id = $1 and state = 'ACTIVE' and effective_from <= $2::date
          order by effective_from desc limit 1`,
        [companyId, day],
      )
    ).rows[0] ?? null
  );
}

/**
 * FR-035 (I-79): the approved arrears cases record `r` takes: of its employee, in the run's currency (`currency`), raised on a period
 * earlier than the run's (`serviceStart`), with a total that is not zero, and not already held by another live run. `from ... where ...`;
 * case alias c, its total t.total.
 */
export const ARREARS_FOR = (r: string, currency: string, serviceStart: string) => `
  from payroll_arrears_case c
  join payroll_period op on op.company_id = c.company_id and op.id = c.origin_period_id and op.service_start < ${serviceStart}
  cross join lateral (select sum(l.amount) as total from payroll_arrears_line l where l.company_id = c.company_id and l.case_id = c.id) t
 where c.company_id = ${r}.company_id and c.employee_id = ${r}.employee_id and c.state = 'APPROVED' and c.currency_code = ${currency} and t.total <> 0
   and not exists (select 1 from payroll_record_input x
                     join payroll_record xr on xr.company_id = x.company_id and xr.id = x.record_id
                     join payroll_run xu on xu.company_id = xr.company_id and xu.id = xr.run_id
                    where x.company_id = c.company_id and x.arrears_case_id = c.id and xu.id <> ${r}.run_id
                      and xu.state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED'))
   and not ${SETTLEMENT_TAKES('c.company_id', 'arrears_case_id', 'c.id')}`;

/**
 * FR-100 (I-79): the approved late-timesheet adjustments record `r` takes, on the same terms as ARREARS_FOR: of its employee, in the
 * run's currency, originating in a period earlier than the run's (so never the origin run, CI25), with a difference that is not zero, and
 * not already held by another live run. `from ... where ...`; adjustment alias a.
 */
export const ADJUSTMENTS_FOR = (r: string, currency: string, serviceStart: string) => `
  from payroll_adjustment a
  join payroll_run orun on orun.company_id = a.company_id and orun.id = a.origin_run_id and orun.service_start < ${serviceStart}
 where a.company_id = ${r}.company_id and a.employee_id = ${r}.employee_id and a.state = 'APPROVED' and a.currency_code = ${currency} and a.delta_amount <> 0
   and not exists (select 1 from payroll_record_input x
                     join payroll_record xr on xr.company_id = x.company_id and xr.id = x.record_id
                     join payroll_run xu on xu.company_id = xr.company_id and xu.id = xr.run_id
                    where x.company_id = a.company_id and x.adjustment_id = a.id and xu.id <> ${r}.run_id
                      and xu.state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED'))
   and not ${SETTLEMENT_TAKES('a.company_id', 'adjustment_id', 'a.id')}`;

/** Rows of `a` not in `b` and of `b` not in `a`: two derivations of the same snapshot disagree. */
const differ = (a: string, b: string) => `exists ((${a} except ${b}) union all (${b} except ${a}))`;

/**
 * docs/10 A2 (I-28; decided under owner delegation, 6 Nov 2026): what the calculation read from the employee masters must still hold when
 * processing starts, or the run returns for a new revision rather than freezing a figure the masters no longer support. Each kind is derived
 * again exactly as steps 1, 3, 4 and 5 derive it, and compared with what the records hold: the leaving date, the arrangement segments, the
 * approved unpaid leave days and, under reviewed attendance, the attendance loss of pay. A value, not a timestamp, so an unrelated edit
 * blocks nothing. Counts records per kind; reads only.
 */
export async function mastersChanged(tx: Queryable, companyId: string, runId: string) {
  const calculated = `r.company_id = $1 and r.run_id = $2 and r.calculation_status = 'CALCULATED'`;
  const stored = (kind: string, ref: string) =>
    `select lp.day, lp.${ref}, lp.units from payroll_record_lop lp where lp.company_id = r.company_id and lp.record_id = r.id and lp.source_kind = '${kind}'`;
  return (
    await tx.query<{ leaving_date: number; arrangements: number; unpaid_leave: number; attendance: number }>(
      `select
         (select count(*)::int from payroll_record r
           where r.company_id = $1 and r.run_id = $2 and r.leaving_date is distinct from hrms_exit_last_working_date(r.company_id, r.employee_id)) as leaving_date,
         (select count(*)::int from payroll_record r where ${calculated} and ${differ(
           `select sa.id, greatest(sa.effective_from, r.eligible_from), least(coalesce(sa.effective_to - 1, r.eligible_to), r.eligible_to)
              from salary_arrangement sa
             where sa.company_id = r.company_id and sa.employee_id = r.employee_id and sa.superseded_at is null
               and sa.effective_from <= r.eligible_to and (sa.effective_to is null or sa.effective_to > r.eligible_from)`,
           `select s.salary_arrangement_id, s.segment_start, s.segment_end from payroll_record_segment s where s.company_id = r.company_id and s.record_id = r.id`,
         )}) as arrangements,
         (select count(*)::int from payroll_record r where ${calculated} and ${differ(
           `select g.d::date, lr.id, (case when lr.half_day then 0.5 else 1 end)::numeric
              from leave_request lr
              join leave_type lt on lt.company_id = lr.company_id and lt.id = lr.leave_type_id and not lt.paid
             cross join lateral generate_series(greatest(lr.start_date, r.eligible_from), least(lr.end_date, r.eligible_to), interval '1 day') g (d)
             where lr.company_id = r.company_id and lr.employee_id = r.employee_id and lr.state = 'APPROVED'
               and lr.start_date <= r.eligible_to and lr.end_date >= r.eligible_from and ${WORKING_DAY('g.d')}`,
           stored('UNPAID_LEAVE', 'leave_request_id'),
         )}) as unpaid_leave,
         (select count(*)::int from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
           where ${calculated} and ru.attendance_basis = 'REVIEWED_ATTENDANCE' and ${differ(
             `select ar.work_date, ar.id, u.units
                from attendance_record ar
                join reference_value st on st.company_id = ar.company_id and st.id = ar.status_id and st.code in ('ABSENT', 'HALF_DAY')
               cross join lateral (select case st.code when 'ABSENT' then ru.absent_unpaid_units else ru.half_day_unpaid_units end as units) u
               where ar.company_id = r.company_id and ar.employee_id = r.employee_id and ar.work_date between r.eligible_from and r.eligible_to
                 and u.units > 0 and not ${APPROVED_LEAVE_ON('ar.work_date')}`,
             stored('ATTENDANCE', 'attendance_record_id'),
           )}) as attendance`,
      [companyId, runId],
    )
  ).rows[0]!;
}

/**
 * Lines of records, derived from the snapshot tables only. `recordFilter` selects the records (SQL over alias r,
 * parameters $1 company, $2 run, $3 employee chunk).
 */
const linesSql = (recordFilter: string) => `
  with recs as (
    select r.id, r.days_in_month, ru.currency_minor_unit as mu
      from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
     where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]) and ${recordFilter}
  ), parts as (
    select c.record_id, c.component_id, c.head_revision_id, c.head_type, 'FIXED'::text as basis, c.amount * s.paid_days as numerator,
           r.days_in_month::numeric as denominator, r.mu
      from payroll_record_component c
      join payroll_record_segment s on s.company_id = c.company_id and s.id = c.segment_id
      join recs r on r.id = c.record_id
     where c.company_id = $1 and c.calculation_basis = 'FIXED' and c.amount_basis = 'MONTHLY'
    union all
    select i.record_id, i.component_id, i.head_revision_id, i.head_type, 'INPUT'::text, i.amount, 1::numeric, r.mu
      from payroll_record_input i join recs r on r.id = i.record_id
     where i.company_id = $1 and i.calculation_basis = 'INPUT'
    union all
    -- I-85: a RULE_PACK head valued by its ACTIVE pack (statutory/evaluate.ts), from the record's statutory snapshot.
    select s.record_id, s.component_id, s.head_revision_id, s.head_type, 'RULE_PACK'::text, s.amount, 1::numeric, r.mu
      from payroll_record_statutory s join recs r on r.id = s.record_id
     where s.company_id = $1 and s.status = 'VALUED'
  )
  select p.record_id, p.component_id, p.head_revision_id, p.head_type, p.basis,
         hrms_payroll_round_half_up(sum(p.numerator), min(p.denominator), min(p.mu)::smallint) as amount,
         'HEAD:' || pc.code || '@r' || hr.revision as rule_version
    from parts p
    join payroll_head_revision hr on hr.company_id = $1 and hr.id = p.head_revision_id
    join pay_component pc on pc.company_id = $1 and pc.id = p.component_id
   group by p.record_id, p.component_id, p.head_revision_id, p.head_type, p.basis, pc.code, hr.revision`;

/**
 * FR-034 "Recovery does not exceed outstanding balance": the lines of the records selected by `recordFilter` (SQL over
 * alias r) that a loan of the employee does not cover. A deduction head on which the employee has never had a decided
 * loan is an ordinary input and is untouched. Otherwise the head is that loan's recovery head and the governing loan is
 * the live one (at most one, 0046), else the latest that ended: without a disbursement, or after full recovery, nothing
 * is outstanding, so any deduction is refused. Read from live balances, not from the snapshot, so it is an exception and
 * a processing check and takes no part in the rerun-identical comparison of lines and totals (verifyMembers). The
 * dependency on the loan module's table is explained at loanOutstandingSql.
 */
export const loanRecoveryBreaches = (recordFilter: string) => `
  select r.company_id, r.run_id, r.id as record_id, r.employee_id, x.code, x.detail
    from payroll_record r
    join payroll_line pl on pl.company_id = r.company_id and pl.record_id = r.id and pl.head_type = 'DEDUCTION' and pl.amount > 0
    join pay_component pc on pc.company_id = pl.company_id and pc.id = pl.component_id
    cross join lateral (
      select l.id, l.state, l.currency_code, ${loanOutstandingSql('l')} as outstanding
        from payroll_loan l
       where l.company_id = r.company_id and l.employee_id = r.employee_id and l.recovery_component_id = pl.component_id
       order by l.state in ('APPROVED', 'DISBURSED') desc, l.decided_at desc
       limit 1
    ) g
    cross join lateral (
      select 'LOAN_RECOVERY_NOT_DISBURSED' as code, jsonb_build_object('componentCode', pc.code, 'loanId', g.id, 'loanState', g.state) as detail
       where g.state <> 'DISBURSED'
      union all
      select 'LOAN_RECOVERY_CURRENCY_MISMATCH', jsonb_build_object('componentCode', pc.code, 'loanId', g.id)
       where g.state = 'DISBURSED' and g.currency_code <> r.currency_code
      union all
      select 'LOAN_RECOVERY_EXCEEDS_OUTSTANDING', jsonb_build_object('componentCode', pc.code, 'loanId', g.id)
       where g.state = 'DISBURSED' and g.currency_code = r.currency_code and pl.amount > g.outstanding
    ) x
   where ${recordFilter}`;

/** The paid-day policy in effect on the service period's last day (configuration "as of" the period end). */
export async function policySnapshot(tx: Queryable, companyId: string, serviceEnd: string): Promise<PolicySnapshot> {
  const p = (
    await tx.query<{ id: string; attendance_basis: 'APPROVED_LEAVE_ONLY' | 'REVIEWED_ATTENDANCE'; absent_unpaid_units: string | null; half_day_unpaid_units: string | null }>(
      `select id, attendance_basis, absent_unpaid_units, half_day_unpaid_units from payroll_paid_day_policy
        where company_id = $1 and state = 'ACTIVE' and effective_from <= $2::date order by effective_from desc limit 1`,
      [companyId, serviceEnd],
    )
  ).rows[0];
  if (!p) return { id: null, basis: 'NOT_CONFIGURED', absent: null, half: null };
  return { id: p.id, basis: p.attendance_basis, absent: p.absent_unpaid_units, half: p.half_day_unpaid_units };
}

/**
 * Fixes the rules of the revision: the run row records the preparer and the policy, and payroll_run_head the head
 * revision of every pay component in effect on the service period's last day (caller holds the run lock).
 */
export async function startCalculation(tx: Queryable, run: RunContext, userId: string): Promise<{ policy: PolicySnapshot; heads: number }> {
  // Head activations take the same lock, so the rules counted and copied below are one consistent set.
  await advisoryLock(tx, `payroll_head_graph:${run.company_id}`);
  // After this lock every calendar change is either committed and stamped before the instant below, or stamped after it.
  await lockCalendar(tx, run.company_id);
  const policy = await policySnapshot(tx, run.company_id, run.service_end);
  const heads = (
    await tx.query<{ n: number }>(
      `select count(*)::int as n from (select distinct component_id from payroll_head_revision where company_id = $1 and state = 'ACTIVE' and effective_from <= $2::date) h`,
      [run.company_id, run.service_end],
    )
  ).rows[0]!.n;
  await tx.query(
    `update payroll_run set calculation_started_at = now(), calendar_as_of = clock_timestamp(), calculated_by = $3, paid_day_policy_id = $4, attendance_basis = $5,
            absent_unpaid_units = $6::numeric, half_day_unpaid_units = $7::numeric, head_count = $8, updated_by = $3
      where company_id = $1 and id = $2`,
    [run.company_id, run.id, userId, policy.id, policy.basis, policy.absent, policy.half, heads],
  );
  await tx.query(
    `insert into payroll_run_head (company_id, run_id, component_id, head_revision_id, created_by)
     select distinct on (h.component_id) $1, $2, h.component_id, h.id, $4
       from payroll_head_revision h
      where h.company_id = $1 and h.state = 'ACTIVE' and h.effective_from <= $3::date
      order by h.component_id, h.effective_from desc`,
    [run.company_id, run.id, run.service_end, userId],
  );
  return { policy, heads };
}

export interface ChunkOutcome {
  records: number;
  calculated: number;
  failed: number;
  excluded: number;
  notEligible: number;
  /** Paid units of the chunk's calculated records (exact decimal text). */
  paidUnits: string;
  totals: { componentId: string; headType: string; lineCount: number; amount: string }[];
}

/** Writes the snapshot, exceptions, lines and totals of one chunk of members (caller holds the run lock). */
export async function calculateChunk(tx: Queryable, run: RunContext, policy: PolicySnapshot, userId: string, ids: readonly string[]): Promise<ChunkOutcome> {
  const base = [run.company_id, run.id, ids];

  // 1. Records: employee facts, eligible interval (joining and leaving dates inclusive) and the approved stop.
  await tx.query(
    `insert into payroll_record (company_id, run_id, employee_id, employee_code, joining_date, leaving_date, status_code, eligible_from, eligible_to,
                                 eligible_days, salary_stop_id, salary_stop_mode, calculation_status, currency_code, days_in_month, employment_assignment_id, created_by, updated_by)
     select $1, $2, e.id, e.employee_code, e.joining_date, x.leaving_date, st.code, el.f, el.t, el.t - el.f + 1, ss.id, ss.mode, 'PENDING', $5, $6, a.id, $7, $7
       from unnest($3::uuid[]) m (employee_id)
       join employee e on e.company_id = $1 and e.id = m.employee_id
       join reference_value st on st.company_id = e.company_id and st.id = e.status_id
       cross join lateral (select hrms_exit_last_working_date($1, e.id) as leaving_date) x
       -- FR-057: the assignment this calculation used, on the date the run's scope reads it (runs.ts scopeCte).
       left join employment_assignment a on a.company_id = e.company_id and a.employee_id = e.id
             and a.effective_from <= least($9::date, coalesce(x.leaving_date, $9::date))
             and (a.effective_to is null or a.effective_to > least($9::date, coalesce(x.leaving_date, $9::date)))
       cross join lateral (
         select st.code <> 'DRAFT' and e.joining_date <= $9::date and (x.leaving_date is null or x.leaving_date >= $8::date)
                and not (st.code in ('INACTIVE_SEPARATED', 'ARCHIVED') and x.leaving_date is null)
                and not ${SETTLED_FINALLY('$1', 'e.id', 'x.leaving_date', '$9::date')} as eligible
       ) ok
       cross join lateral (
         select case when ok.eligible then greatest(e.joining_date, $8::date) end as f,
                case when ok.eligible then least(coalesce(x.leaving_date, $9::date), $9::date) end as t
       ) el
       left join payroll_salary_stop ss on ss.company_id = $1 and ss.period_id = $4 and ss.employee_id = e.id and ss.state = 'APPROVED'`,
    [...base, run.period_id, run.currency_code, run.days_in_month, userId, run.service_start, run.service_end],
  );

  // 2. Record-level exceptions and notices.
  await tx.query(
    `${EXCEPTION_INSERT}
     select r.company_id, r.run_id, r.id, r.employee_id, x.code, x.severity, false, x.detail, $4, $4
       from payroll_record r
       cross join lateral (
         select 'LEAVING_DATE_UNKNOWN' as code, 'BLOCKING' as severity, jsonb_build_object('status', r.status_code) as detail
          where r.status_code in ('INACTIVE_SEPARATED', 'ARCHIVED') and r.leaving_date is null and r.salary_stop_mode is distinct from 'EXCLUDE_CALCULATION'
         union all
         select 'SALARY_STOP_EXCLUDED', 'WARNING', jsonb_build_object('salaryStopId', r.salary_stop_id) where r.salary_stop_mode = 'EXCLUDE_CALCULATION'
         union all
         select 'SALARY_STOP_HOLD', 'WARNING', jsonb_build_object('salaryStopId', r.salary_stop_id) where r.salary_stop_mode = 'HOLD_DISBURSEMENT'
         union all
         select 'NO_SERVICE_IN_PERIOD', 'WARNING', jsonb_build_object('joiningDate', r.joining_date, 'leavingDate', r.leaving_date)
          where r.eligible_from is null and r.salary_stop_mode is distinct from 'EXCLUDE_CALCULATION'
            and not (r.status_code in ('INACTIVE_SEPARATED', 'ARCHIVED') and r.leaving_date is null)
            and not ${SETTLED_FINALLY('r.company_id', 'r.employee_id', 'r.leaving_date', '$5::date')}
         union all
         select 'SETTLED_IN_FINAL_SETTLEMENT', 'WARNING',
                jsonb_build_object('leavingDate', r.leaving_date,
                                   'settlementId', (select fs.id from settlement fs where fs.company_id = r.company_id and fs.employee_id = r.employee_id
                                                       and fs.state in ('RELEASE_ELIGIBLE', 'PAID') order by fs.revision desc limit 1))
          where r.eligible_from is null and ${SETTLED_FINALLY('r.company_id', 'r.employee_id', 'r.leaving_date', '$5::date')}
       ) x
      where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]) and r.calculation_status = 'PENDING'`,
    [...base, userId, run.service_end],
  );
  // FR-031 "salary-stop interpretation is explicit in the result": an approved stop entered under another calendar's
  // period of the same service month is never ignored. Paying the employee here would disregard an independent
  // decision, so the record fails (not resolvable by a note) until the stop is revoked or the employee is excluded and
  // paid by the run of the stop's period, where the stop applies.
  await tx.query(
    `${EXCEPTION_INSERT}
     select r.company_id, r.run_id, r.id, r.employee_id, 'SALARY_STOP_OTHER_PERIOD', 'BLOCKING', false,
            jsonb_build_object('stops', count(*), 'periodCodes', jsonb_agg(distinct p.period_code order by p.period_code)), $6, $6
       from payroll_record r
       join payroll_salary_stop ss on ss.company_id = r.company_id and ss.employee_id = r.employee_id and ss.period_id <> $4 and ss.state = 'APPROVED'
       join payroll_period p on p.company_id = ss.company_id and p.id = ss.period_id and p.service_start = $5::date
      where ${COMPUTE}
      group by r.company_id, r.run_id, r.id, r.employee_id`,
    [...base, run.period_id, run.service_start, userId],
  );

  // 3. Loss of pay: approved unpaid leave on its working days within the eligible interval (one row per day).
  await tx.query(
    `insert into payroll_record_lop (company_id, record_id, employee_id, day, source_kind, leave_request_id, units, created_by)
     select r.company_id, r.id, r.employee_id, g.d::date, 'UNPAID_LEAVE', lr.id, case when lr.half_day then 0.5 else 1 end, $4
       from payroll_record r
       join leave_request lr on lr.company_id = r.company_id and lr.employee_id = r.employee_id and lr.state = 'APPROVED'
                            and lr.start_date <= r.eligible_to and lr.end_date >= r.eligible_from
       join leave_type lt on lt.company_id = lr.company_id and lt.id = lr.leave_type_id and not lt.paid
       cross join lateral generate_series(greatest(lr.start_date, r.eligible_from), least(lr.end_date, r.eligible_to), interval '1 day') g (d)
      where ${COMPUTE} and ${WORKING_DAY('g.d')}`,
    [...base, userId],
  );
  // The approved units must still match the working days of the whole request; otherwise the paid days cannot be
  // determined without a guess.
  await tx.query(
    `${EXCEPTION_INSERT}
     select r.company_id, r.run_id, r.id, r.employee_id, 'LEAVE_UNITS_MISMATCH', 'BLOCKING', false,
            jsonb_build_object('leaveRequestId', lr.id, 'startDate', lr.start_date, 'endDate', lr.end_date), $4, $4
       from payroll_record r
       join leave_request lr on lr.company_id = r.company_id and lr.employee_id = r.employee_id and lr.state = 'APPROVED'
                            and lr.start_date <= r.eligible_to and lr.end_date >= r.eligible_from
       join leave_type lt on lt.company_id = lr.company_id and lt.id = lr.leave_type_id and not lt.paid
       cross join lateral (select count(*)::numeric as wd from generate_series(lr.start_date, lr.end_date, interval '1 day') g (d)
                            where ${WORKING_DAY('g.d')}) w
      where ${COMPUTE} and lr.requested_units <> case when lr.half_day then w.wd * 0.5 else w.wd end`,
    [...base, userId],
  );

  // 4. Attendance: loss of pay only under REVIEWED_ATTENDANCE; days with approved leave are never counted again.
  if (policy.basis === 'REVIEWED_ATTENDANCE') {
    await tx.query(
      `insert into payroll_record_lop (company_id, record_id, employee_id, day, source_kind, attendance_record_id, units, created_by)
       select r.company_id, r.id, r.employee_id, ar.work_date, 'ATTENDANCE', ar.id, u.units, $4
         from payroll_record r
         join attendance_record ar on ar.company_id = r.company_id and ar.employee_id = r.employee_id and ar.work_date between r.eligible_from and r.eligible_to
         join reference_value st on st.company_id = ar.company_id and st.id = ar.status_id and st.code in ('ABSENT', 'HALF_DAY')
         cross join lateral (select case st.code when 'ABSENT' then $5::numeric else $6::numeric end as units) u
        where ${COMPUTE} and u.units > 0 and not ${APPROVED_LEAVE_ON('ar.work_date')}`,
      [...base, userId, policy.absent, policy.half],
    );
    // Under this policy reviewed attendance decides pay: a day with no evaluated outcome (and no approved leave)
    // leaves the paid days undetermined.
    await tx.query(
      `${EXCEPTION_INSERT}
       select r.company_id, r.run_id, r.id, r.employee_id, 'ATTENDANCE_NOT_EVALUATED', 'BLOCKING', true,
              jsonb_build_object('days', count(*), 'firstDate', min(g.d::date), 'lastDate', max(g.d::date)), $4, $4
         from payroll_record r
         cross join lateral generate_series(r.eligible_from, r.eligible_to, interval '1 day') g (d)
        where ${COMPUTE}
          and not exists (select 1 from attendance_record ar where ar.company_id = r.company_id and ar.employee_id = r.employee_id and ar.work_date = g.d::date)
          and not ${APPROVED_LEAVE_ON('g.d::date')}
        group by r.company_id, r.run_id, r.id, r.employee_id`,
      [...base, userId],
    );
  }
  if (policy.basis !== 'APPROVED_LEAVE_ONLY') {
    const [code, statuses] = policy.basis === 'REVIEWED_ATTENDANCE' ? ['ATTENDANCE_UNRESOLVED', ['EXCEPTION']] : ['ATTENDANCE_NOT_VALUED', ['ABSENT', 'HALF_DAY', 'EXCEPTION']];
    await tx.query(
      `${EXCEPTION_INSERT}
       select r.company_id, r.run_id, r.id, r.employee_id, $5, 'BLOCKING', true,
              jsonb_build_object('days', count(*), 'firstDate', min(ar.work_date), 'lastDate', max(ar.work_date)), $4, $4
         from payroll_record r
         join attendance_record ar on ar.company_id = r.company_id and ar.employee_id = r.employee_id and ar.work_date between r.eligible_from and r.eligible_to
         join reference_value st on st.company_id = ar.company_id and st.id = ar.status_id and st.code = any($6::text[])
        where ${COMPUTE} and not ${APPROVED_LEAVE_ON('ar.work_date')}
        group by r.company_id, r.run_id, r.id, r.employee_id`,
      [...base, userId, code, statuses],
    );
  }

  // 5. Arrangement segments of the eligible days, each with its loss-of-pay days (counted once).
  await tx.query(
    `insert into payroll_record_segment (company_id, record_id, employee_id, salary_arrangement_id, segment_start, segment_end, calendar_days,
                                         leave_lop_units, attendance_lop_units, paid_days, currency_code, created_by)
     select r.company_id, r.id, r.employee_id, sa.id, s.seg_start, s.seg_end, s.seg_end - s.seg_start + 1,
            coalesce(l.leave, 0), coalesce(l.att, 0), (s.seg_end - s.seg_start + 1) - coalesce(l.leave, 0) - coalesce(l.att, 0), sa.currency_code, $4
       from payroll_record r
       join salary_arrangement sa on sa.company_id = r.company_id and sa.employee_id = r.employee_id and sa.superseded_at is null
            and sa.effective_from <= r.eligible_to and (sa.effective_to is null or sa.effective_to > r.eligible_from)
       cross join lateral (select greatest(sa.effective_from, r.eligible_from) as seg_start,
                                  least(coalesce(sa.effective_to - 1, r.eligible_to), r.eligible_to) as seg_end) s
       left join lateral (select sum(lp.units) filter (where lp.source_kind = 'UNPAID_LEAVE') as leave,
                                 sum(lp.units) filter (where lp.source_kind = 'ATTENDANCE') as att
                            from payroll_record_lop lp
                           where lp.company_id = r.company_id and lp.record_id = r.id and lp.day between s.seg_start and s.seg_end) l on true
      where ${COMPUTE}`,
    [...base, userId],
  );
  await tx.query(
    `${EXCEPTION_INSERT}
     select r.company_id, r.run_id, r.id, r.employee_id, x.code, 'BLOCKING', false, x.detail, $5, $5
       from payroll_record r
       cross join lateral (select count(*)::int as n, coalesce(sum(calendar_days), 0)::int as days,
                                  bool_or(currency_code <> $4) as foreign_currency,
                                  bool_or(not exists (select 1 from salary_component sc where sc.company_id = s.company_id and sc.salary_arrangement_id = s.salary_arrangement_id)) as no_components
                             from payroll_record_segment s where s.company_id = r.company_id and s.record_id = r.id) g
       cross join lateral (
         select 'NO_SALARY_ARRANGEMENT' as code, jsonb_build_object('eligibleFrom', r.eligible_from, 'eligibleTo', r.eligible_to) as detail where g.n = 0
         union all
         select 'ARRANGEMENT_GAP', jsonb_build_object('eligibleFrom', r.eligible_from, 'eligibleTo', r.eligible_to, 'coveredDays', g.days) where g.n > 0 and g.days < r.eligible_days
         union all
         select 'CURRENCY_MISMATCH', jsonb_build_object('calendarCurrency', $4::text) where g.foreign_currency
         union all
         select 'SALARY_COMPONENTS_MISSING', '{}'::jsonb where g.no_components
       ) x
      where ${COMPUTE}`,
    [...base, run.currency_code, userId],
  );

  // 6. Salary components of each segment, classified by the run's rules (payroll_run_head).
  await tx.query(
    `insert into payroll_record_component (company_id, record_id, segment_id, component_id, amount, amount_basis, head_revision_id, head_type,
                                           calculation_basis, rule_pack_code, created_by)
     select s.company_id, s.record_id, s.id, sc.component_id, sc.amount, sc.basis,
            case when h.in_use then h.id end, case when h.in_use then h.head_type end, case when h.in_use then h.calculation_basis end,
            case when h.in_use then h.rule_pack_code end, $4
       from payroll_record r
       join payroll_record_segment s on s.company_id = r.company_id and s.record_id = r.id
       join salary_component sc on sc.company_id = s.company_id and sc.salary_arrangement_id = s.salary_arrangement_id
       left join payroll_run_head rh on rh.company_id = r.company_id and rh.run_id = r.run_id and rh.component_id = sc.component_id
       left join payroll_head_revision h on h.company_id = rh.company_id and h.id = rh.head_revision_id
      where ${COMPUTE}`,
    [...base, userId],
  );
  await tx.query(
    `${EXCEPTION_INSERT}
     select distinct on (c.record_id, c.component_id, x.code) r.company_id, r.run_id, r.id, r.employee_id, x.code, 'BLOCKING', false, x.detail, $4, $4
       from payroll_record r
       join payroll_record_component c on c.company_id = r.company_id and c.record_id = r.id
       join pay_component pc on pc.company_id = c.company_id and pc.id = c.component_id
       cross join lateral (
         select 'HEAD_NOT_CONFIGURED' as code, jsonb_build_object('componentCode', pc.code) as detail where c.head_revision_id is null
         union all
         select 'COMPONENT_BASIS_NOT_MONTHLY', jsonb_build_object('componentCode', pc.code) where c.calculation_basis = 'FIXED' and c.amount_basis <> 'MONTHLY'
         union all
         select 'COMPONENT_HEAD_NOT_FIXED', jsonb_build_object('componentCode', pc.code) where c.calculation_basis = 'INPUT'
       ) x
      where ${COMPUTE}
      order by c.record_id, c.component_id, x.code`,
    [...base, userId],
  );

  // 7. Approved, not yet consumed inputs of the period (FR-031: only approved inputs feed the calculation).
  await tx.query(
    `insert into payroll_record_input (company_id, record_id, employee_id, input_id, component_id, amount, currency_code, head_revision_id, head_type,
                                       calculation_basis, created_by)
     select r.company_id, r.id, r.employee_id, i.id, i.component_id, i.amount, i.currency_code,
            case when h.in_use then h.id end, case when h.in_use then h.head_type end, case when h.in_use then h.calculation_basis end, $5
       from payroll_record r
       join payroll_input i on i.company_id = r.company_id and i.period_id = $4 and i.employee_id = r.employee_id and i.state = 'APPROVED' and i.consumed_record_id is null
       left join payroll_run_head rh on rh.company_id = r.company_id and rh.run_id = r.run_id and rh.component_id = i.component_id
       left join payroll_head_revision h on h.company_id = rh.company_id and h.id = rh.head_revision_id
      where ${COMPUTE}`,
    [...base, run.period_id, userId],
  );
  // 7b. FR-035 (I-79, decided under owner delegation): approved arrears of an earlier period, not yet paid, appear once in the first
  // later record of the employee: a positive total on the valuation policy's arrears component, a negative one as a recovery on its
  // deduction. Serialised across runs so two calculations never take the same case. Without an active policy nothing is taken.
  const valuation = await valuationPolicyOn(tx, run.company_id, run.service_end);
  if (valuation) {
    await advisoryLock(tx, `payroll_arrears_pickup:${run.company_id}`);
    await tx.query(
      `insert into payroll_record_input (company_id, record_id, employee_id, source_kind, arrears_case_id, component_id, amount, currency_code, head_revision_id,
                                         head_type, calculation_basis, created_by)
       select r.company_id, r.id, r.employee_id, 'ARREARS', c.id, k.component_id, abs(t.total), c.currency_code,
              case when h.in_use then h.id end, case when h.in_use then h.head_type end, case when h.in_use then h.calculation_basis end, $4
         from payroll_record r
         cross join lateral (select c.id, c.currency_code, t.total ${ARREARS_FOR('r', '$5::text', '$6::date')}) c
         cross join lateral (select c.total) t
         cross join lateral (select case when t.total > 0 then $7::uuid else $8::uuid end as component_id) k
         left join payroll_run_head rh on rh.company_id = r.company_id and rh.run_id = r.run_id and rh.component_id = k.component_id
         left join payroll_head_revision h on h.company_id = rh.company_id and h.id = rh.head_revision_id
        where ${COMPUTE} and k.component_id is not null`,
      [...base, userId, run.currency_code, run.service_start, valuation.arrears_component_id, valuation.recovery_component_id],
    );
    // FR-100: approved late-timesheet adjustments the same way, on the policy's adjustment component (a negative one on its deduction).
    await tx.query(
      `insert into payroll_record_input (company_id, record_id, employee_id, source_kind, adjustment_id, component_id, amount, currency_code, head_revision_id,
                                         head_type, calculation_basis, created_by)
       select r.company_id, r.id, r.employee_id, 'ADJUSTMENT', a.id, k.component_id, abs(a.delta_amount), a.currency_code,
              case when h.in_use then h.id end, case when h.in_use then h.head_type end, case when h.in_use then h.calculation_basis end, $4
         from payroll_record r
         cross join lateral (select a.id, a.currency_code, a.delta_amount ${ADJUSTMENTS_FOR('r', '$5::text', '$6::date')}) a
         cross join lateral (select case when a.delta_amount > 0 then $7::uuid else $8::uuid end as component_id) k
         left join payroll_run_head rh on rh.company_id = r.company_id and rh.run_id = r.run_id and rh.component_id = k.component_id
         left join payroll_head_revision h on h.company_id = rh.company_id and h.id = rh.head_revision_id
        where ${COMPUTE} and k.component_id is not null`,
      [...base, userId, run.currency_code, run.service_start, valuation.adjustment_component_id, valuation.recovery_component_id],
    );
    await tx.query(
      `${EXCEPTION_INSERT}
       select r.company_id, r.run_id, r.id, r.employee_id, case when i.source_kind = 'ARREARS' then 'ARREARS_HEAD_INVALID' else 'ADJUSTMENT_HEAD_INVALID' end, 'BLOCKING', false,
              jsonb_build_object('componentCode', pc.code, 'expected', case when i.component_id = $5 then 'DEDUCTION' else 'EARNING' end), $4, $4
         from payroll_record r
         join payroll_record_input i on i.company_id = r.company_id and i.record_id = r.id and i.source_kind in ('ARREARS', 'ADJUSTMENT')
         join pay_component pc on pc.company_id = i.company_id and pc.id = i.component_id
        where ${COMPUTE}
          and (i.calculation_basis is distinct from 'INPUT' or i.head_type is distinct from case when i.component_id = $5 then 'DEDUCTION' else 'EARNING' end)`,
      [...base, userId, valuation.recovery_component_id],
    );
  }
  await tx.query(
    `${EXCEPTION_INSERT}
     select r.company_id, r.run_id, r.id, r.employee_id, x.code, 'BLOCKING', false, x.detail, $5, $5
       from payroll_record r
       join payroll_record_input i on i.company_id = r.company_id and i.record_id = r.id
       join pay_component pc on pc.company_id = i.company_id and pc.id = i.component_id
       join payroll_input src on src.company_id = i.company_id and src.id = i.input_id
       cross join lateral (
         select 'INPUT_HEAD_INVALID' as code, jsonb_build_object('componentCode', pc.code, 'reference', src.reference) as detail
          where i.calculation_basis is distinct from 'INPUT'
         union all
         select 'INPUT_CURRENCY_MISMATCH', jsonb_build_object('componentCode', pc.code, 'reference', src.reference) where i.currency_code <> $4
       ) x
      where ${COMPUTE}`,
    [...base, run.currency_code, userId],
  );
  // H2 "employee payroll-input discrepancy: validation exception before processing; payroll approver records
  // resolution": approved inputs this record does not take (the employee is not calculated, or the inputs were
  // entered under another calendar's period of the same month) are never dropped silently.
  await tx.query(
    `${EXCEPTION_INSERT}
     select r.company_id, r.run_id, r.id, r.employee_id, 'INPUTS_NOT_INCLUDED', 'BLOCKING', true, jsonb_build_object('inputs', count(*)), $5, $5
       from payroll_record r
       join payroll_input i on i.company_id = r.company_id and i.period_id = $4 and i.employee_id = r.employee_id and i.state = 'APPROVED' and i.consumed_record_id is null
      where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]) and r.calculation_status = 'PENDING'
        and (r.eligible_from is null or r.salary_stop_mode = 'EXCLUDE_CALCULATION')
      group by r.company_id, r.run_id, r.id, r.employee_id`,
    [...base, run.period_id, userId],
  );
  await tx.query(
    `${EXCEPTION_INSERT}
     select r.company_id, r.run_id, r.id, r.employee_id, 'INPUTS_OTHER_PERIOD', 'BLOCKING', true,
            jsonb_build_object('inputs', count(*), 'periodCodes', jsonb_agg(distinct p.period_code order by p.period_code)), $5, $5
       from payroll_record r
       join payroll_input i on i.company_id = r.company_id and i.employee_id = r.employee_id and i.period_id <> $4 and i.state = 'APPROVED' and i.consumed_record_id is null
       join payroll_period p on p.company_id = i.company_id and p.id = i.period_id and p.service_start = $6::date
      where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]) and r.calculation_status = 'PENDING'
      group by r.company_id, r.run_id, r.id, r.employee_id`,
    [...base, run.period_id, userId, run.service_start],
  );

  // A rule-pack head applies where the arrangement lists it or where its base heads are paid (a pack calculated on BASIC
  // applies to everyone paid BASIC). I-85 (statutory/evaluate.ts, the one call): a head whose pack is ACTIVE for the period
  // is valued into the record's statutory snapshot, from which step 8 derives its line; otherwise the employee is blocked
  // with RULE_PACK_NOT_CONFIGURED instead of being paid without it (DF05 "missing applicable mandatory inputs blocks").
  await evaluateRulePackHeads(tx, run, userId, ids, linesSql);

  // 8. Lines, from the snapshot alone, for records without an exception that prevents amounts.
  await tx.query(
    `insert into payroll_line (company_id, record_id, component_id, head_revision_id, head_type, calculation_basis, amount, rule_version, created_by)
     select $1, l.record_id, l.component_id, l.head_revision_id, l.head_type, l.basis, l.amount, l.rule_version, $4
       from (${linesSql(`r.calculation_status = 'PENDING' and r.eligible_from is not null and r.salary_stop_mode is distinct from 'EXCLUDE_CALCULATION'
                         and not exists (select 1 from payroll_exception x where x.company_id = r.company_id and x.record_id = r.id
                                           and x.severity = 'BLOCKING' and not x.resolvable)`)}) l`,
    [...base, userId],
  );

  // 9. Outcome and totals (sums of rounded lines).
  await tx.query(
    `update payroll_record r
        set calculation_status = v.status,
            paid_units = v.paid_units,
            salary_arrangement_id = v.arrangement,
            earnings = case when v.status = 'CALCULATED' then v.e end,
            reimbursements = case when v.status = 'CALCULATED' then v.rb end,
            gross = case when v.status = 'CALCULATED' then v.e + v.rb end,
            deductions = case when v.status = 'CALCULATED' then v.d end,
            net = case when v.status = 'CALCULATED' then v.e + v.rb - v.d end,
            employer_contributions = case when v.status = 'CALCULATED' then v.ec end,
            updated_by = $4
       from (
         select x.id,
                case when x.salary_stop_mode = 'EXCLUDE_CALCULATION' then 'EXCLUDED'
                     when exists (select 1 from payroll_exception e where e.company_id = x.company_id and e.record_id = x.id and e.severity = 'BLOCKING' and not e.resolvable) then 'FAILED'
                     when x.eligible_from is null then 'NOT_ELIGIBLE'
                     else 'CALCULATED' end as status,
                (select sum(s.paid_days) from payroll_record_segment s where s.company_id = x.company_id and s.record_id = x.id) as paid_units,
                (select s.salary_arrangement_id from payroll_record_segment s where s.company_id = x.company_id and s.record_id = x.id
                  order by s.segment_end desc limit 1) as arrangement,
                coalesce((select sum(l.amount) from payroll_line l where l.company_id = x.company_id and l.record_id = x.id and l.head_type = 'EARNING'), 0) as e,
                coalesce((select sum(l.amount) from payroll_line l where l.company_id = x.company_id and l.record_id = x.id and l.head_type = 'REIMBURSEMENT'), 0) as rb,
                coalesce((select sum(l.amount) from payroll_line l where l.company_id = x.company_id and l.record_id = x.id and l.head_type = 'DEDUCTION'), 0) as d,
                coalesce((select sum(l.amount) from payroll_line l where l.company_id = x.company_id and l.record_id = x.id and l.head_type = 'EMPLOYER_CONTRIBUTION'), 0) as ec
           from payroll_record x
          where x.company_id = $1 and x.run_id = $2 and x.employee_id = any($3::uuid[]) and x.calculation_status = 'PENDING'
       ) v
      where r.company_id = $1 and r.id = v.id`,
    [...base, userId],
  );
  await tx.query(
    `${EXCEPTION_INSERT}
     select r.company_id, r.run_id, r.id, r.employee_id, x.code, x.severity, false, '{}'::jsonb, $4, $4
       from payroll_record r
       cross join lateral (
         select 'NEGATIVE_NET' as code, 'BLOCKING' as severity where r.net < 0
         union all
         select 'NO_EARNINGS', 'WARNING' where r.gross = 0
       ) x
      where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]) and r.calculation_status = 'CALCULATED'`,
    [...base, userId],
  );
  // FR-034: like a negative net, a deduction above the loan's balance is calculated but blocked. No resolution note can
  // clear it: the wrong input is reversed (or the loan disbursed) and a new revision calculated.
  await tx.query(
    `${EXCEPTION_INSERT}
     select v.company_id, v.run_id, v.record_id, v.employee_id, v.code, 'BLOCKING', false, v.detail, $4, $4
       from (${loanRecoveryBreaches(`r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]) and r.calculation_status = 'CALCULATED'`)}) v`,
    [...base, userId],
  );

  // 10. Bank readiness preview: processing will block payment without a verified approved bank instruction.
  const payable = (
    await tx.query<{ employee_id: string; id: string }>(
      `select employee_id, id from payroll_record where company_id = $1 and run_id = $2 and employee_id = any($3::uuid[]) and calculation_status = 'CALCULATED' and net > 0`,
      base,
    )
  ).rows;
  const checks = await bankChecks(tx, run.company_id, payable.map((p) => p.employee_id));
  const notReady = payable.filter((p) => checks.get(p.employee_id)?.status !== 'VERIFIED');
  if (notReady.length > 0) {
    await tx.query(
      `${EXCEPTION_INSERT}
       select r.company_id, r.run_id, r.id, r.employee_id, 'BANK_INSTRUCTION_NOT_READY', 'WARNING', false, jsonb_build_object('bankStatus', m.status), $4, $4
         from payroll_record r join unnest($5::uuid[], $6::text[]) m (record_id, status) on m.record_id = r.id
        where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[])`,
      [...base, userId, notReady.map((p) => p.id), notReady.map((p) => checks.get(p.employee_id)?.status ?? 'MISSING')],
    );
  }

  // 11. What the chunk produced: outcomes, paid units and component totals of its records.
  const outcomes = (
    await tx.query<{ status: string; n: number; paid: string | null }>(
      `select calculation_status as status, count(*)::int as n, sum(paid_units) as paid
         from payroll_record where company_id = $1 and run_id = $2 and employee_id = any($3::uuid[]) group by 1`,
      base,
    )
  ).rows;
  const count = (s: string) => outcomes.find((o) => o.status === s)?.n ?? 0;
  const totals = (
    await tx.query<{ componentId: string; headType: string; lineCount: number; amount: string }>(
      `select l.component_id as "componentId", l.head_type as "headType", count(*)::int as "lineCount", sum(l.amount) as amount
         from payroll_line l join payroll_record r on r.company_id = l.company_id and r.id = l.record_id
        where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[])
        group by 1, 2 order by 1, 2`,
      base,
    )
  ).rows;
  return {
    records: outcomes.reduce((a, o) => a + o.n, 0),
    calculated: count('CALCULATED'),
    failed: count('FAILED'),
    excluded: count('EXCLUDED'),
    notEligible: count('NOT_ELIGIBLE'),
    paidUnits: outcomes.find((o) => o.status === 'CALCULATED')?.paid ?? '0',
    totals,
  };
}

export interface VerifyResult {
  identical: boolean;
  records: number;
  lines: number;
  lineDifferences: number;
  totalDifferences: number;
  paidDayDifferences: number;
  /** false when the time budget ended the verification; continue from `nextAfter`. */
  complete: boolean;
  nextAfter: string | null;
}

/**
 * FR-033 / ZT36 determinism check: re-derives every line and total of the revision from its stored snapshot and
 * compares them with the stored results, chunk by chunk from the `after` employee (read-only, bounded by `budgetMs`).
 */
export async function verifyMembers(db: Queryable, companyId: string, runId: string, opts: { after: string | null; budgetMs: number; chunkSize: number }): Promise<VerifyResult> {
  const started = Date.now();
  const out: VerifyResult = { identical: true, records: 0, lines: 0, lineDifferences: 0, totalDifferences: 0, paidDayDifferences: 0, complete: false, nextAfter: null };
  let after = opts.after;
  for (;;) {
    const ids = (
      await db.query<{ employee_id: string }>(
        `select employee_id from payroll_record where company_id = $1 and run_id = $2 and ($3::uuid is null or employee_id > $3::uuid) order by employee_id limit $4`,
        [companyId, runId, after, opts.chunkSize],
      )
    ).rows.map((r) => r.employee_id);
    if (ids.length === 0) {
      out.complete = true;
      break;
    }
    const base = [companyId, runId, ids];
    const lines = (
      await db.query<{ lines: number; differences: number }>(
        `with recomputed as (${linesSql(`r.calculation_status = 'CALCULATED'`)}),
              stored as (select l.record_id, l.component_id, l.head_revision_id, l.head_type, l.calculation_basis as basis, l.amount, l.rule_version
                           from payroll_line l join payroll_record r on r.company_id = l.company_id and r.id = l.record_id
                          where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]))
         select (select count(*)::int from stored) as lines,
                (select count(*)::int from recomputed c full join stored s on s.record_id = c.record_id and s.component_id = c.component_id
                  where (c.amount, c.head_revision_id, c.head_type, c.basis, c.rule_version) is distinct from (s.amount, s.head_revision_id, s.head_type, s.basis, s.rule_version)) as differences`,
        base,
      )
    ).rows[0]!;
    const totals = (
      await db.query<{ n: number }>(
        `with recomputed as (${linesSql(`r.calculation_status = 'CALCULATED'`)}),
              sums as (select record_id,
                              coalesce(sum(amount) filter (where head_type = 'EARNING'), 0) as e,
                              coalesce(sum(amount) filter (where head_type = 'REIMBURSEMENT'), 0) as rb,
                              coalesce(sum(amount) filter (where head_type = 'DEDUCTION'), 0) as d,
                              coalesce(sum(amount) filter (where head_type = 'EMPLOYER_CONTRIBUTION'), 0) as ec
                         from recomputed group by record_id)
         select count(*)::int as n
           from payroll_record r left join sums s on s.record_id = r.id
          where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[]) and r.calculation_status = 'CALCULATED'
            and (coalesce(s.e, 0), coalesce(s.rb, 0), coalesce(s.d, 0), coalesce(s.ec, 0), coalesce(s.e, 0) + coalesce(s.rb, 0) - coalesce(s.d, 0))
                is distinct from (r.earnings, r.reimbursements, r.deductions, r.employer_contributions, r.net)`,
        base,
      )
    ).rows[0]!.n;
    const paidDays = (
      await db.query<{ n: number }>(
        `select count(*)::int as n
           from payroll_record r join payroll_record_segment s on s.company_id = r.company_id and s.record_id = r.id
           left join lateral (select coalesce(sum(lp.units) filter (where lp.source_kind = 'UNPAID_LEAVE'), 0) as leave,
                                     coalesce(sum(lp.units) filter (where lp.source_kind = 'ATTENDANCE'), 0) as att
                                from payroll_record_lop lp where lp.company_id = r.company_id and lp.record_id = r.id and lp.day between s.segment_start and s.segment_end) l on true
          where r.company_id = $1 and r.run_id = $2 and r.employee_id = any($3::uuid[])
            and (l.leave, l.att, s.calendar_days - l.leave - l.att) is distinct from (s.leave_lop_units, s.attendance_lop_units, s.paid_days)`,
        base,
      )
    ).rows[0]!.n;
    out.records += ids.length;
    out.lines += lines.lines;
    out.lineDifferences += lines.differences;
    out.totalDifferences += totals;
    out.paidDayDifferences += paidDays;
    after = ids[ids.length - 1]!;
    if (ids.length < opts.chunkSize) {
      out.complete = true;
      break;
    }
    if (Date.now() - started > opts.budgetMs) {
      out.nextAfter = after;
      break;
    }
  }
  out.identical = out.lineDifferences === 0 && out.totalDifferences === 0 && out.paidDayDifferences === 0;
  return out;
}
