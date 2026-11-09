// F2 dashboard metrics of expense claims and their payments, ready for the dashboard's metric catalogue:
//   Treasury Operator "Assigned payment preparation tasks; Pending outcome counts; Definitively failed outcome counts;
//   Reservations needing reconciliation";
//   Treasury Approver "Assigned independent release tasks; Overdue release tasks; Confirmed/reversed operation
//   counts; Unresolved outcome tasks".
// Payment counts use the payables and payment lists' row-scope predicate on the claimant (DF07; GET /expense/payables,
// GET /expense/claims/:id/payments), so they reconcile with them (BR-045). Counts and states only: never amounts, bank
// identifiers, receipts or reasons (F2). The claim figures are in reporting/claim-states.ts (I-83).
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { MetricResult } from '../dashboard/service.js';
import { countOf, monthStart } from '../dashboard/tasks.js';
import { AWAITING_PREPARATION } from './service.js';

/** Payment instructions (alias pi: the row-scope predicate uses i, t and bt itself) of claimants in the caller's row scope. */
export const instructionsInScope = (g: AccessGrant, p: SqlParams) => employeeScopePredicate(g, { company: 'pi.company_id', employee: 'pi.employee_id' }, p);

/**
 * C4, DF03 (expense/service.ts assertIndependentReleaser, the same database rule): the caller may release this instruction, once
 * its batch is READY (C5 "READY release"; a draft is not waiting for anyone's release).
 */
export const independentOf = (g: AccessGrant, p: SqlParams) =>
  `not hrms_payment_release_conflict(pi.company_id, pi.id, ${p.add(g.userId)}::uuid)
     and exists (select 1 from payment_batch pb where pb.company_id = pi.company_id and pb.id = pi.batch_id and pb.state = 'READY')`;

/** Instruction `pi` belongs to a batch in this state (C5: DRAFT until its preparer marks it READY). */
export const batchIn = (p: SqlParams, state: string) =>
  `exists (select 1 from payment_batch pb where pb.company_id = pi.company_id and pb.id = pi.batch_id and pb.state = ${p.add(state)})`;

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

  /**
   * F2 Treasury Operator "Assigned payment preparation tasks" (I-84 item 5; decided under owner delegation, 6 Nov 2026, I-89 item 2):
   * a count, not a workflow task. (a) approved claims awaiting preparation (GET /expense/payables?awaitingPreparation=true: an
   * outstanding amount and no live reservation) plus (b) draft payments not yet marked ready (GET /expense/payments?state=PREPARED
   * &batchState=DRAFT), both in the assignment's row scope over the claimant. Only an eligible Admin assignment prepares a payment
   * (DF03, DF07), so a draft is never this ordinary assignment's own work: it is counted as a state of the scope, whoever prepared
   * it, and never as the same person's tasks in another assignment (DF17 "no merging"; I-83 item 3).
   */
  PAYMENT_PREPARATION_TASKS: async (db, g) => {
    const p = new SqlParams();
    const claims = employeeScopePredicate(g, { company: 'c.company_id', employee: 'c.employee_id' }, p);
    const drafts = instructionsInScope(g, p);
    const row = (
      await db.query<{ n: number }>(
        `select (select count(*) from expense_claim c join expense_obligation_ledger l on l.company_id = c.company_id and l.claim_id = c.id
                  where ${claims} and c.state = 'APPROVED' and c.payment_state <> 'PAID' and ${AWAITING_PREPARATION})::int
              + (select count(*) from payment_instruction pi where ${drafts} and pi.state = 'PREPARED' and ${batchIn(p, 'DRAFT')})::int as n`,
        p.values,
      )
    ).rows[0]!;
    return { status: 'OK', value: row.n };
  },

  /**
   * F2 Treasury Operator "Reservations needing reconciliation" (decided under owner delegation, 6 Nov 2026, docs/03 I-92; 0245):
   * instructions still holding a reservation (C5: reserved at preparation, held until a definitive outcome; DF07 "unknown provider
   * outcomes remain pending until reconciled") after their payment date: prepared but not released, or released with no outcome
   * recorded. Both lists are the payment list's (GET /expense/payments?state=PREPARED|RELEASED&paymentDateBefore=<today>), in the
   * assignment's row scope over the claimant. A count of the scope, whoever prepared or released them (DF17 "no merging").
   */
  PAYMENT_RESERVATIONS_TO_RECONCILE: (db, g) => {
    const p = new SqlParams();
    return countOf(
      db,
      `select count(*) as n from payment_instruction pi where ${instructionsInScope(g, p)} and pi.state in ('PREPARED', 'RELEASED') and pi.payment_date < ${p.add(g.businessDate)}::date`,
      p,
    );
  },

  // The Finance Reviewer's and Expense Finance Approver's claim figures (decision due included, I-92) count claim states in their
  // organisation scope, never the tasks the same person holds through an Admin assignment (I-83 items 2 and 3; DF17 "no merging"):
  // reporting/claim-states.ts.
};
