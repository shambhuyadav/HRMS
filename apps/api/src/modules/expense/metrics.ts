// F2 dashboard metrics of expense claims and their payments, ready for the dashboard's metric catalogue:
//   Treasury Operator "Pending outcome counts; Definitively failed outcome counts";
//   Treasury Approver "Assigned independent release tasks; Overdue release tasks; Confirmed/reversed operation
//   counts; Unresolved outcome tasks";
//   Finance Reviewer "Assigned expense review tasks";
//   Expense Finance Approver "Assigned final expense decisions; Late/receipt exception counts; Returned claim counts;
//   Decision due tasks".
// Payment counts use the payables and payment lists' row-scope predicate on the claimant (DF07; GET /expense/payables,
// GET /expense/claims/:id/payments), so they reconcile with them (BR-045). Task counts use the expense task list's
// predicate (GET /expense/tasks). Counts and states only: never amounts, bank identifiers, receipts or reasons (F2).
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { MetricResult } from '../dashboard/service.js';
import { countOf, monthStart, myPendingTasks, notAvailable } from '../dashboard/tasks.js';

const CLAIM_KIND = ['expense_claim'];
/** The financial steps of the expense route (DF03/DF06): finance review and the high-value step above the threshold. */
const FINAL_STEP_ACTIONS = ['finance_decide', 'high_value_decide'];
/** Line flags raised at submission that F2 groups as "late/receipt exceptions". */
const LATE_RECEIPT_FLAGS = ['LATE_SUBMISSION', 'RECEIPT_MISSING'];

/** Payment instructions (alias pi: the row-scope predicate uses i, t and bt itself) of claimants in the caller's row scope. */
export const instructionsInScope = (g: AccessGrant, p: SqlParams) => employeeScopePredicate(g, { company: 'pi.company_id', employee: 'pi.employee_id' }, p);

/** C4, DF03 (expense/service.ts assertIndependentReleaser, the same database rule): the caller may release this instruction. */
export const independentOf = (g: AccessGrant, p: SqlParams) => `not hrms_payment_release_conflict(pi.company_id, pi.id, ${p.add(g.userId)}::uuid)`;

/** Instruction `pi` has an event of this kind recorded on or after the company-local date. */
export const paidEventSince = (p: SqlParams, kind: 'CONFIRMED' | 'REVERSED', from: string) =>
  `exists (select 1 from payment_event ev where ev.company_id = pi.company_id and ev.instruction_id = pi.id and ev.event_kind = ${p.add(kind)}
             and hrms_business_date(ev.company_id, ev.occurred_at) >= ${p.add(from)}::date)`;

const RELEASABLE = `from payment_instruction pi`;

export const EXPENSE_METRICS: Readonly<Record<string, (db: Queryable, grant: AccessGrant) => Promise<MetricResult>>> = {
  /** Released instructions without a recorded outcome (an unknown outcome stays RELEASED, DF07). */
  PAYMENTS_AWAITING_OUTCOME: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n from payment_instruction pi where ${instructionsInScope(g, p)} and pi.state = 'RELEASED'`, p);
  },
  /** Instructions with a definitive FAILED outcome. */
  PAYMENTS_FAILED: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n from payment_instruction pi where ${instructionsInScope(g, p)} and pi.state = 'FAILED'`, p);
  },
  /** Prepared instructions the caller may release independently (not prepared, approved or claimed by the caller). */
  PAYMENTS_AWAITING_RELEASE: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n ${RELEASABLE} where ${instructionsInScope(g, p)} and pi.state = 'PREPARED' and ${independentOf(g, p)}`, p);
  },
  /** The same instructions whose payment date (their due date) is before the company-local business date. */
  PAYMENTS_RELEASE_OVERDUE: (db, g) => {
    const p = new SqlParams();
    return countOf(
      db,
      `select count(*) as n ${RELEASABLE} where ${instructionsInScope(g, p)} and pi.state = 'PREPARED' and ${independentOf(g, p)}
          and pi.payment_date < ${p.add(g.businessDate)}::date`,
      p,
    );
  },
  /** '<confirmed>/<reversed>': instructions with a confirmation / a reversal recorded this company-local month. */
  PAYMENTS_CONFIRMED_REVERSED: async (db, g) => {
    const p = new SqlParams();
    const since = monthStart(g.businessDate);
    const row = (
      await db.query<{ confirmed: number; reversed: number }>(
        `select (count(*) filter (where ${paidEventSince(p, 'CONFIRMED', since)}))::int as confirmed, (count(*) filter (where ${paidEventSince(p, 'REVERSED', since)}))::int as reversed
           from payment_instruction pi where ${instructionsInScope(g, p)}`,
        p.values,
      )
    ).rows[0]!;
    return { status: 'OK', value: `${row.confirmed}/${row.reversed}` };
  },

  /** The caller's open expense claim tasks, every step (the expense task list). */
  EXPENSE_REVIEW_TASKS: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n ${myPendingTasks(g, p, CLAIM_KIND)}`, p);
  },
  /** The caller's open financial-step decisions (finance review and the high-value step). */
  EXPENSE_FINAL_DECISION_TASKS: (db, g) => {
    const p = new SqlParams();
    return countOf(db, `select count(*) as n ${myPendingTasks(g, p, CLAIM_KIND)} and sp.action = any(${p.add(FINAL_STEP_ACTIONS)}::text[])`, p);
  },
  /** Claims awaiting the caller's financial decision whose current revision has a late-submission or missing-receipt line (flags only). */
  EXPENSE_LATE_RECEIPT_EXCEPTIONS: (db, g) => {
    const p = new SqlParams();
    const tasks = myPendingTasks(g, p, CLAIM_KIND);
    return countOf(
      db,
      `select count(distinct bt.id) as n ${tasks} and sp.action = any(${p.add(FINAL_STEP_ACTIONS)}::text[])
          and exists (select 1 from expense_claim c
                        join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision
                        join expense_line l on l.company_id = r.company_id and l.revision_id = r.id
                       where c.company_id = bt.company_id and c.transaction_id = bt.id and l.exception_flags && ${p.add(LATE_RECEIPT_FLAGS)}::text[])`,
      p,
    );
  },
  /** Claims the caller returned in their latest approval round that still wait for the claimant's correction. */
  EXPENSE_RETURNED_BY_ME: (db, g) => {
    const p = new SqlParams();
    return countOf(
      db,
      `select count(*) as n from expense_claim c
        where c.company_id = ${p.add(g.companyId)}::uuid and c.state = 'RETURNED'
          and exists (select 1 from approval_instance i join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
                       where i.company_id = c.company_id and i.transaction_id = c.transaction_id and i.state = 'RETURNED'
                         and t.assignee_user_id = ${p.add(g.userId)}::uuid and t.state = 'RETURNED'
                         and i.created_at = (select max(i2.created_at) from approval_instance i2 where i2.company_id = c.company_id and i2.transaction_id = c.transaction_id))`,
      p,
    );
  },
  /**
   * Expense decision tasks carry no due date (approval_task.due_at is never set; DF03 defines reminders after 2 and
   * escalation after 5 business days, not a due date), so "decision due" cannot be counted: unavailable, not zero.
   */
  EXPENSE_DECISION_DUE_TASKS: notAvailable,
};
