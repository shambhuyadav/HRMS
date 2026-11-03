// F2 dashboard metrics of the payroll module, ready for the dashboard's metric catalogue:
//   Payroll Operator "Open payroll periods; Input-validation exceptions; Assigned preparation tasks; Period
//   calculation state";
//   Payroll Approver "Assigned payroll review tasks; Overdue review tasks; Approved/locked batch counts; Unresolved
//   batch exception counts".
// Counts and states only, never amounts (DF02: the payroll role dashboards stay operational and non-confidential;
// F2: no salary, bank or tax contents). Runs, periods and their exception counts are company records shown by the
// operational lists without an employee filter (GET /payroll/runs, GET /payroll/calendars), so the counts use those
// lists' predicates and reconcile with them (BR-045). Task counts use the run task list's predicate
// (GET /payroll/runs/tasks/mine). The "current period" is the period of an active calendar whose service month
// contains the company-local business date (DF17: batch reviews default to the selected payroll period).
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import type { MetricResult } from '../dashboard/service.js';
import { countOf, myPendingTasks } from '../dashboard/tasks.js';
import { APPROVAL_KIND, COVER_KIND, OPEN_PERIOD_FROM, openPeriodCondition, RUN_KIND } from './runs.js';

/** Live revisions in lifecycle order (H2); RETURNED and CANCELLED revisions are closed. */
const LIVE_STATES = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED'] as const;
/** Revisions whose blocking exceptions still need action: not closed and not yet processed. */
const UNPROCESSED_LIVE = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED'];
/** Run review, approval stage and covering approval (the run task list). */
const REVIEW_KINDS = [RUN_KIND, APPROVAL_KIND, COVER_KIND];

const NO_CURRENT_PERIOD: MetricResult = { status: 'NOT_CONFIGURED', message: 'No active payroll period covers today' };

/** Current periods (alias p) of active calendars on the business date, each joined to its runs (alias r). */
const currentPeriodRuns = (g: AccessGrant, p: SqlParams, runStates: readonly string[]) => {
  const day = p.add(g.businessDate);
  return `from payroll_period p join payroll_calendar k on k.company_id = p.company_id and k.id = p.calendar_id and k.state = 'ACTIVE'
       left join payroll_run r on r.company_id = p.company_id and r.period_id = p.id and r.state = any(${p.add(runStates)}::text[])
      where p.company_id = ${p.add(g.companyId)}::uuid and p.service_start <= ${day}::date and p.service_end >= ${day}::date`;
};

/** The run of a payroll task's transaction: the run itself, its approval stage or a covering approval (alias bt). */
const RUN_OF_TASK = `(r.transaction_id = bt.id
      or r.id = (select a.run_id from payroll_run_approval a where a.company_id = bt.company_id and a.transaction_id = bt.id)
      or r.id = (select c.run_id from payroll_record_cover c where c.company_id = bt.company_id and c.transaction_id = bt.id))`;

export const PAYROLL_METRICS: Readonly<Record<string, (db: Queryable, grant: AccessGrant) => Promise<MetricResult>>> = {
  /**
   * Open periods: periods of an active calendar whose service month has started and that have no processed (locked)
   * run yet. Reconciles with the calendar list's periods and the run list filtered by period.
   */
  PAYROLL_OPEN_PERIODS: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n ${OPEN_PERIOD_FROM} where ${openPeriodCondition(p.add(g.companyId), p.add(g.businessDate))}`, p);
  },
  /**
   * Unresolved blocking validation exceptions of the calculation inputs (attendance, leave, inputs, salary stops,
   * rule packs) on revisions not yet processed: the sum of the run list's "unresolvedExceptions" for those states.
   */
  PAYROLL_UNRESOLVED_EXCEPTIONS: (db, g) => {
    const p = new SqlParams();
    return countOf(
      db,
      `select count(*) as n from payroll_exception x join payroll_run r on r.company_id = x.company_id and r.id = x.run_id
        where x.company_id = ${p.add(g.companyId)}::uuid and x.severity = 'BLOCKING' and x.resolved_at is null and r.state = any(${p.add(UNPROCESSED_LIVE)}::text[])`,
      p,
    );
  },
  /**
   * Preparation work: revisions still with the preparer, DRAFT (to calculate, or recalculate after a return) or
   * CALCULATED (to verify and submit for review). Reconciles with the run list filtered by those states.
   */
  PAYROLL_RUNS_IN_PREPARATION: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n from payroll_run r where r.company_id = ${p.add(g.companyId)}::uuid and r.state in ('DRAFT', 'CALCULATED')`, p);
  },
  /**
   * The calculation state of the current period: the least advanced state of its live runs (several calendars or
   * scoped runs: the earliest stage still open), NOT_STARTED while it has no live run.
   */
  PAYROLL_CURRENT_PERIOD_STATE: async (db, g) => {
    const p = new SqlParams();
    const rows = (
      await db.query<{ state: string | null }>(`select r.state ${currentPeriodRuns(g, p, LIVE_STATES)}`, p.values)
    ).rows;
    if (rows.length === 0) return NO_CURRENT_PERIOD;
    const rank = (s: string | null) => (s === null ? -1 : LIVE_STATES.indexOf(s as (typeof LIVE_STATES)[number]));
    const least = rows.map((r) => r.state).reduce((a, b) => (rank(b) < rank(a) ? b : a));
    return { status: 'OK', value: least ?? 'NOT_STARTED' };
  },
  /** The caller's open run review, approval-stage and covering-approval tasks (the run task list). */
  PAYROLL_REVIEW_TASKS: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n ${myPendingTasks(g, p, REVIEW_KINDS)}`, p);
  },
  /**
   * Overdue review tasks: open run tasks of the caller whose period payment date (the run's due date) is before the
   * company-local business date (DF17 "overdue means pending with due date < company-local today").
   */
  PAYROLL_REVIEW_TASKS_OVERDUE: (db, g) => {
    const p = new SqlParams();
    const tasks = myPendingTasks(g, p, REVIEW_KINDS);
    return countOf(
      db,
      `select count(*) as n ${tasks}
          and exists (select 1 from payroll_run r where r.company_id = bt.company_id and ${RUN_OF_TASK} and r.payment_date < ${p.add(g.businessDate)}::date)`,
      p,
    );
  },
  /** Approved (awaiting processing) / processed and locked runs of the current period, as '<approved>/<locked>'. */
  PAYROLL_APPROVED_LOCKED_RUNS: async (db, g) => {
    const p = new SqlParams();
    const row = (
      await db.query<{ periods: number; approved: number; locked: number }>(
        `select count(distinct p.id)::int as periods, count(r.id) filter (where r.state = 'APPROVED')::int as approved,
                count(r.id) filter (where r.state = 'PROCESSED_LOCKED')::int as locked
           ${currentPeriodRuns(g, p, ['APPROVED', 'PROCESSED_LOCKED'])}`,
        p.values,
      )
    ).rows[0]!;
    if (row.periods === 0) return NO_CURRENT_PERIOD;
    return { status: 'OK', value: `${row.approved}/${row.locked}` };
  },
};
