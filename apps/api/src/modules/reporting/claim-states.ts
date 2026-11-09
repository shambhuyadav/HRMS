// Expense claim states for the ordinary finance roles (I-83 items 2, 3 and 5; decided under owner delegation, 6 Nov 2026; F2; C7
// "Assigned expense review tasks and claim states"; DF17 "no merging across role assignments"; BR-045; FR-097; DF02).
//
// The Finance Reviewer and the Expense Finance Approver decide nothing in their ordinary context: a final expense decision needs
// the receipts and private reasons, so it runs only in an independently approved eligible Admin assignment (BRD lines 306 and
// 4656, "never this ordinary role context"; DF03). Their figures are therefore the states of the claims in their own organisation
// scope, whoever holds the task, never the tasks the same person holds through another assignment. Each figure and the list behind
// it (GET /v1/expense/claim-states) use one predicate, so they reconcile for identical filters. Identity, state and an exception
// mark only: no amount, purpose, merchant, receipt or reason ever leaves here.
//
// I-92 (decided under owner delegation, 6 Nov 2026; 0245) adds the figures F2 still lacked, from the same records:
//   Finance Reviewer "Unreconciled outcome counts": approved claims with a released payment whose outcome is not recorded (DF07
//     "unknown provider outcomes remain pending until reconciled"; C5 "ambiguous outcome stays PENDING");
//   Finance Reviewer "Reconciliation task counts": approved claims whose payment failed or was reversed and that still have an
//     amount outstanding with no replacement holding a reservation (BR-025; the ledger does not yet reconcile approved to paid);
//   Finance Reviewer "Operational expense states": '<returned>/<approved, awaiting payment>';
//   Expense Finance Approver "Decision due tasks": claims at a financial step whose decision is due today or earlier. The due date
//     is the claim's arrival at that step plus the dated reporting setting expense_decision_due_days (in force on the arrival
//     date) in business days, Monday to Friday as DF03 counts them. Worked out when read: nothing is stored on the task.
// Only states and dates leave here: the payment follow-up is read from the ledger and the payment states, never their amounts.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { MetricResult } from '../dashboard/service.js';
import { countOf } from '../dashboard/tasks.js';

/** Claims waiting for a reviewer: the manager step, finance review and the high-value step (DF03, DF06). */
export const IN_REVIEW_STATES = ['MANAGER_PENDING', 'FINANCE_PENDING', 'HIGH_VALUE_PENDING'] as const;
/** Claims waiting for a final (financial) decision. */
export const FINAL_DECISION_STATES = ['FINANCE_PENDING', 'HIGH_VALUE_PENDING'] as const;
/** The line flags F2 groups as "late/receipt exceptions" (raised at submission). */
const LATE_RECEIPT_FLAGS = ['LATE_SUBMISSION', 'RECEIPT_MISSING'];
/** The financial steps of the expense route. */
const FINANCIAL_STEP_ACTIONS = ['finance_decide', 'high_value_decide'];
const CLAIM_STATES = ['DRAFT', 'MANAGER_PENDING', 'FINANCE_PENDING', 'HIGH_VALUE_PENDING', 'RETURNED', 'APPROVED', 'REJECTED', 'WITHDRAWN'];

/**
 * The payment follow-up of an approved claim (I-92; DF07; C5; BR-025):
 *   OUTCOME_UNKNOWN     a released payment of the claim has no outcome recorded yet;
 *   FAILED_OR_REVERSED  a payment of the claim failed or was reversed, an amount is still outstanding and nothing holds a reservation;
 *   AWAITING_PAYMENT    an amount is still unpaid (payment state UNPAID or PART_PAID).
 */
export const PAYMENT_FOLLOW_UPS = ['OUTCOME_UNKNOWN', 'FAILED_OR_REVERSED', 'AWAITING_PAYMENT'] as const;
export type PaymentFollowUp = (typeof PAYMENT_FOLLOW_UPS)[number];

export interface ClaimStateQuery extends Paging {
  /** Comma-separated claim states. */
  states?: string | undefined;
  /** LATE_RECEIPT: the current revision has a late-submission or missing-receipt line. */
  exception?: 'LATE_RECEIPT' | undefined;
  /** FINANCIAL_STEP: returned to the claimant, and the latest return came from a finance or high-value step. */
  returnedAt?: 'FINANCIAL_STEP' | undefined;
  /** The claim's payment follow-up (I-92). */
  payment?: PaymentFollowUp | undefined;
  /** DUE: waiting at a financial step whose decision is due on or before today (I-92). */
  decision?: 'DUE' | undefined;
}

const LIST_CAP = 500;

const lateReceipt = (p: SqlParams) =>
  `exists (select 1 from expense_revision r join expense_line l on l.company_id = r.company_id and l.revision_id = r.id
            where r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision and l.exception_flags && ${p.add(LATE_RECEIPT_FLAGS)}::text[])`;

const returnedAtFinancialStep = (p: SqlParams) =>
  `c.state = 'RETURNED'
   and exists (select 1 from approval_instance i
                 join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'RETURNED'
                 join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
                 join permission sp on sp.id = s.permission_id and sp.action = any(${p.add(FINANCIAL_STEP_ACTIONS)}::text[])
                where i.company_id = c.company_id and i.transaction_id = c.transaction_id and i.state = 'RETURNED'
                  and i.created_at = (select max(i2.created_at) from approval_instance i2 where i2.company_id = c.company_id and i2.transaction_id = c.transaction_id))`;

/** The allocations of the claim's obligation (alias a), for a payment condition. */
const allocationsOfClaim = `from expense_obligation o join payment_allocation a on a.company_id = o.company_id and a.obligation_id = o.id
                             where o.company_id = c.company_id and o.claim_id = c.id`;

const PAYMENT_CONDITIONS: Readonly<Record<PaymentFollowUp, string>> = {
  // DF07: a released instruction keeps its reservation until an outcome is recorded from evidence.
  OUTCOME_UNKNOWN: `c.state = 'APPROVED' and exists (select 1 ${allocationsOfClaim}
                      and exists (select 1 from payment_instruction pi where pi.company_id = a.company_id and pi.id = a.instruction_id and pi.state = 'RELEASED'))`,
  // The ledger still owes the claimant, nothing is reserved to pay it, and a payment went wrong before: a failure or a reversal.
  FAILED_OR_REVERSED: `c.state = 'APPROVED'
                       and exists (select 1 from expense_obligation_ledger l where l.company_id = c.company_id and l.claim_id = c.id and l.approved_amount - l.net_paid > 0 and l.pending = 0)
                       and exists (select 1 ${allocationsOfClaim}
                                     and (exists (select 1 from payment_instruction pi where pi.company_id = a.company_id and pi.id = a.instruction_id and pi.state = 'FAILED')
                                          or exists (select 1 from payment_event ev where ev.company_id = a.company_id and ev.allocation_id = a.id and ev.event_kind = 'REVERSED')))`,
  AWAITING_PAYMENT: `c.state = 'APPROVED' and c.payment_state in ('UNPAID', 'PART_PAID')`,
};

/**
 * When the claim reached the financial step it now waits at: the first task of that step in its active instance, so a reroute or
 * a delegation that adds a task keeps the original arrival. Null when no financial-step task is pending.
 */
const financialArrival = (p: SqlParams) =>
  `(select min(t2.created_at) from approval_instance i
      join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'PENDING'
      join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
      join permission sp on sp.id = s.permission_id and sp.action = any(${p.add(FINANCIAL_STEP_ACTIONS)}::text[])
      join approval_task t2 on t2.company_id = t.company_id and t2.instance_id = t.instance_id and t2.step_id = t.step_id
     where i.company_id = c.company_id and i.transaction_id = c.transaction_id and i.state = 'ACTIVE')`;

/**
 * I-92: the date the claim's final decision falls due: its arrival at the financial step (company-local date) plus the due period of
 * the reporting setting in force on that date, in business days (0245 hrms_add_business_days, Monday to Friday as DF03 counts).
 * A later change of the setting applies to claims arriving from its start. Null when the claim waits at no financial step.
 */
const decisionDueOn = (p: SqlParams) =>
  `(select hrms_add_business_days(arrived.day, rs.expense_decision_due_days)
      from (select hrms_business_date(c.company_id, ${financialArrival(p)}) as day) arrived
      join reporting_setting rs on rs.company_id = c.company_id and rs.effective_from <= arrived.day and (rs.effective_to is null or rs.effective_to > arrived.day))`;

/** `where` condition of claims (alias c) in the grant's row scope that match the query. */
function claimCondition(g: AccessGrant, p: SqlParams, q: ClaimStateQuery): string {
  const parts = [employeeScopePredicate(g, { company: 'c.company_id', employee: 'c.employee_id' }, p)];
  const states = q.states ? q.states.split(',') : null;
  if (states) parts.push(`c.state = any(${p.add(states)}::text[])`);
  if (q.exception === 'LATE_RECEIPT') parts.push(lateReceipt(p));
  if (q.returnedAt === 'FINANCIAL_STEP') parts.push(returnedAtFinancialStep(p));
  if (q.payment) parts.push(`(${PAYMENT_CONDITIONS[q.payment]})`);
  if (q.decision === 'DUE') parts.push(`c.state = any(${p.add(FINAL_DECISION_STATES)}::text[]) and ${decisionDueOn(p)} <= ${p.add(g.businessDate)}::date`);
  return parts.join(' and ');
}

export const CLAIM_STATE_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    states: { type: 'string', pattern: `^(${CLAIM_STATES.join('|')})(,(${CLAIM_STATES.join('|')})){0,7}$` },
    exception: { type: 'string', enum: ['LATE_RECEIPT'] },
    returnedAt: { type: 'string', enum: ['FINANCIAL_STEP'] },
    payment: { type: 'string', enum: [...PAYMENT_FOLLOW_UPS] },
    decision: { type: 'string', enum: ['DUE'] },
    page: { type: 'integer', minimum: 1 },
    pageSize: { type: 'integer', enum: [25, 50, 100] },
  },
} as const;

/**
 * GET /v1/expense/claim-states: the claims behind the figures, least recently changed first. The payment state is C5's derived
 * operational state (never an amount); the decision due date is shown while the claim waits at a financial step.
 */
export async function listClaimStates(db: Queryable, g: AccessGrant, q: ClaimStateQuery) {
  const p = new SqlParams();
  const where = claimCondition(g, p, q);
  const late = lateReceipt(p);
  const due = decisionDueOn(p);
  return pageOf(
    db,
    `select c.id as "claimId", e.employee_code as "claimantEmployeeCode", e.display_name as "claimantName", c.state, c.payment_state as "paymentState",
            c.current_revision as revision, ${late} as "lateOrReceiptException", to_char(${due}, 'YYYY-MM-DD') as "decisionDueOn",
            c.updated_at as "updatedAt", c.updated_at as hrms_since
       from expense_claim c join employee e on e.company_id = c.company_id and e.id = c.employee_id
      where ${where}`,
    p.values,
    'hrms_since, "claimId"',
    q,
    LIST_CAP,
  );
}

/** Claims are not routed to these roles, so an ASSIGNED scope holds none of them: said so, never a lasting zero. */
const NEEDS_ORGANISATION: MetricResult = { status: 'NOT_CONFIGURED', message: 'Claim counts need an organisation-scope assignment: claims are not assigned to this role' };

const claimCount = (q: ClaimStateQuery) => (db: Queryable, g: AccessGrant): Promise<MetricResult> => {
  if (g.scopeKind === 'ASSIGNED') return Promise.resolve(NEEDS_ORGANISATION);
  const p = new SqlParams();
  return countOf(db, `select count(*) as n from expense_claim c where ${claimCondition(g, p, q)}`, p);
};

/** The queries of the figures, which their source lists repeat (dashboard/sources.ts). */
export const CLAIM_STATE_FILTERS = {
  EXPENSE_CLAIMS_IN_REVIEW: { states: IN_REVIEW_STATES.join(',') },
  EXPENSE_CLAIMS_AWAITING_FINAL: { states: FINAL_DECISION_STATES.join(',') },
  EXPENSE_CLAIMS_LATE_RECEIPT: { states: FINAL_DECISION_STATES.join(','), exception: 'LATE_RECEIPT' },
  EXPENSE_CLAIMS_RETURNED_AT_FINANCE: { returnedAt: 'FINANCIAL_STEP' },
  // I-92.
  EXPENSE_DECISION_DUE_TASKS: { states: FINAL_DECISION_STATES.join(','), decision: 'DUE' },
  FINANCE_RECONCILIATION_TASKS: { payment: 'FAILED_OR_REVERSED' },
  FINANCE_UNRECONCILED_OUTCOMES: { payment: 'OUTCOME_UNKNOWN' },
} as const satisfies Record<string, ClaimStateQuery>;

/** I-92: the two parts of the Finance Reviewer's "Operational expense states", '<returned>/<approved, awaiting payment>'. */
export const EXPENSE_STATE_PARTS = [
  { label: 'Returned to the claimant', query: { states: 'RETURNED' } },
  { label: 'Approved, awaiting payment', query: { payment: 'AWAITING_PAYMENT' } },
] as const satisfies readonly { label: string; query: ClaimStateQuery }[];

type Metric = (db: Queryable, grant: AccessGrant) => Promise<MetricResult>;

export const CLAIM_STATE_METRICS: Readonly<Record<keyof typeof CLAIM_STATE_FILTERS | 'FINANCE_EXPENSE_STATES', Metric>> = {
  /** Finance Reviewer "Assigned expense review tasks": claims waiting at any review step in scope. */
  EXPENSE_CLAIMS_IN_REVIEW: claimCount(CLAIM_STATE_FILTERS.EXPENSE_CLAIMS_IN_REVIEW),
  /** Expense Finance Approver "Assigned final expense decisions": claims waiting for a finance or high-value decision. */
  EXPENSE_CLAIMS_AWAITING_FINAL: claimCount(CLAIM_STATE_FILTERS.EXPENSE_CLAIMS_AWAITING_FINAL),
  /** "Late/receipt exception counts": the same claims with a late-submission or missing-receipt line (flags only). */
  EXPENSE_CLAIMS_LATE_RECEIPT: claimCount(CLAIM_STATE_FILTERS.EXPENSE_CLAIMS_LATE_RECEIPT),
  /** "Returned claim counts": claims a financial step returned, waiting for the claimant's correction. */
  EXPENSE_CLAIMS_RETURNED_AT_FINANCE: claimCount(CLAIM_STATE_FILTERS.EXPENSE_CLAIMS_RETURNED_AT_FINANCE),
  /** Expense Finance Approver "Decision due tasks" (I-92): the same claims whose decision is due today or earlier. */
  EXPENSE_DECISION_DUE_TASKS: claimCount(CLAIM_STATE_FILTERS.EXPENSE_DECISION_DUE_TASKS),
  /** Finance Reviewer "Reconciliation task counts" (I-92): a failed or reversed payment, still outstanding, nothing reserved. */
  FINANCE_RECONCILIATION_TASKS: claimCount(CLAIM_STATE_FILTERS.FINANCE_RECONCILIATION_TASKS),
  /** Finance Reviewer "Unreconciled outcome counts" (I-92): a released payment with no outcome recorded. */
  FINANCE_UNRECONCILED_OUTCOMES: claimCount(CLAIM_STATE_FILTERS.FINANCE_UNRECONCILED_OUTCOMES),
  /** Finance Reviewer "Operational expense states" (I-92): '<returned>/<approved, awaiting payment>'. */
  FINANCE_EXPENSE_STATES: async (db, g) => {
    if (g.scopeKind === 'ASSIGNED') return NEEDS_ORGANISATION;
    const p = new SqlParams();
    const [returned, awaiting] = EXPENSE_STATE_PARTS.map((part) => `(select count(*) from expense_claim c where ${claimCondition(g, p, part.query)})::int`);
    const row = (await db.query<{ returned: number; awaiting: number }>(`select ${returned} as returned, ${awaiting} as awaiting`, p.values)).rows[0]!;
    return { status: 'OK', value: `${row.returned}/${row.awaiting}` };
  },
};
