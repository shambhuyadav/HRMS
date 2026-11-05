// Expense outputs of section 11 (line 2287 "Claim/line register, approval ageing, category spend, payable ageing, payment
// reconciliation"; FR-079; BR-026; DF07). Each uses the row-scope predicate on the claimant, as the claim and payables lists do.
// One currency per row, never a mixed total (FR-079 "same period/currency/scope"). Registers take the submission period of
// EXPENSE_REGISTER; reconciliation takes the approval period; the ageing reports stand as at the day they are generated and,
// like GET /expense/payables, take no period. Ages are calendar days and no buckets are drawn: the BRD names none. Columns
// await the owner's samples (section 11; I-40 item 12). Reasons, receipts and payment evidence keys are never columns.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import type { ReportDefinition, ReportFilters } from '../report/catalogue.js';
import { claimReadCondition } from './service.js';

/**
 * The claims an expense output may hold (claim alias c): row scope over the claimant, and DF02 "visible only to claimant and
 * assigned expense reviewers/payment operators" as the claim screens apply it, since DF02 enforces it on exports too. An
 * export right alone therefore opens no claim: its holder also needs the payment read duty or a task on the claim.
 */
export async function claimsInScope(db: Queryable, grant: AccessGrant, p: SqlParams): Promise<string> {
  const scope = employeeScopePredicate(grant, { company: 'c.company_id', employee: 'c.employee_id' }, p);
  return `(${scope} and ${await claimReadCondition(db, grant, p)})`;
}

/** An as-at report refuses a period rather than ignoring it (BR-026: a filter that is shown is a filter that applied). */
function refusePeriod(f: ReportFilters): void {
  if (f.from !== undefined || f.to !== undefined) throw new HttpError(422, 'FILTER_NOT_SUPPORTED', 'This report stands as at the day it is generated and takes no period');
}

const MONEY = (expression: string, alias: string) => `(${expression})::numeric(19,2)::text as ${alias}`;
/** The final decision of a line (FR-073): the latest, as the obligation's sum reads it (0012 hrms_expense_obligation_sum). */
const FINAL_ALLOWED = `(select d.allowed_amount from expense_line_decision d where d.company_id = l.company_id and d.line_id = l.id order by d.created_at desc limit 1)`;

export const EXPENSE_REPORTS: Record<string, ReportDefinition> = {
  EXPENSE_LINE_REGISTER: {
    code: 'EXPENSE_LINE_REGISTER',
    title: 'Expense claim line register',
    resource: 'expense',
    fieldGroup: 'operational',
    requiresPeriod: true,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'claim_id', header: 'Claim' },
      { key: 'revision', header: 'Revision' },
      { key: 'state', header: 'State' },
      { key: 'submitted_at', header: 'Submitted at' },
      { key: 'sequence', header: 'Line' },
      { key: 'category', header: 'Category' },
      { key: 'expense_date', header: 'Expense date' },
      { key: 'nights', header: 'Nights' },
      { key: 'merchant', header: 'Merchant' },
      { key: 'invoice_reference', header: 'Invoice reference' },
      { key: 'claimed_amount', header: 'Claimed amount' },
      { key: 'approved_amount', header: 'Approved amount' },
      { key: 'exception_flags', header: 'Flags' },
      { key: 'currency', header: 'Currency' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = await claimsInScope(db, grant, p);
      return (
        await db.query(
          `select e.employee_code, c.id as claim_id, r.revision, c.state, hrms_business_date(c.company_id, r.submitted_at) as submitted_at, l.sequence, cat.code as category, l.expense_date, l.nights, l.merchant, l.invoice_reference,
                  ${MONEY('l.claimed_amount', 'claimed_amount')}, ${MONEY(FINAL_ALLOWED, 'approved_amount')}, array_to_string(l.exception_flags, ' ') as exception_flags, c.currency_code as currency
             from expense_claim c join employee e on e.company_id = c.company_id and e.id = c.employee_id
             join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision
             join expense_line l on l.company_id = r.company_id and l.revision_id = r.id
             join expense_category cat on cat.company_id = l.company_id and cat.id = l.category_id
            where ${scope} and r.submitted_at is not null
              and hrms_business_date(c.company_id, r.submitted_at) between ${p.add(f.from)}::date and ${p.add(f.to)}::date
            order by e.employee_code, r.submitted_at, c.id, l.sequence`,
          p.values,
        )
      ).rows;
    },
  },

  EXPENSE_APPROVAL_AGEING: {
    code: 'EXPENSE_APPROVAL_AGEING',
    title: 'Expense approval ageing',
    resource: 'expense',
    fieldGroup: 'operational',
    requiresPeriod: false,
    checkFilters: refusePeriod,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'claim_id', header: 'Claim' },
      { key: 'revision', header: 'Revision' },
      { key: 'state', header: 'State' },
      { key: 'step', header: 'Step' },
      { key: 'reviewer', header: 'Reviewer' },
      { key: 'submitted_on', header: 'Submitted on' },
      { key: 'waiting_since', header: 'Waiting since' },
      { key: 'age_days', header: 'Age (calendar days)' },
      { key: 'claimed_total', header: 'Claimed total' },
      { key: 'currency', header: 'Currency' },
    ],
    async rows(db, grant) {
      const p = new SqlParams();
      const scope = await claimsInScope(db, grant, p);
      const asAt = `${p.add(grant.businessDate)}::date`;
      return (
        await db.query(
          `select e.employee_code, c.id as claim_id, r.revision, c.state, perm.action as step, au.account_key as reviewer,
                  to_char(hrms_business_date(c.company_id, r.submitted_at), 'YYYY-MM-DD') as submitted_on,
                  to_char(hrms_business_date(t.company_id, t.created_at), 'YYYY-MM-DD') as waiting_since,
                  ${asAt} - hrms_business_date(t.company_id, t.created_at) as age_days,
                  ${MONEY('(select sum(l.claimed_amount) from expense_line l where l.company_id = r.company_id and l.revision_id = r.id)', 'claimed_total')}, c.currency_code as currency
             from approval_task t
             join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
             join expense_claim c on c.company_id = i.company_id and c.transaction_id = i.transaction_id
             join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = i.transaction_revision
             join employee e on e.company_id = c.company_id and e.id = c.employee_id
             join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
             join permission perm on perm.id = s.permission_id
             join user_account au on au.id = t.assignee_user_id
            where ${scope} and t.state = 'PENDING'
            order by age_days desc, e.employee_code, c.id`,
          p.values,
        )
      ).rows;
    },
  },

  EXPENSE_CATEGORY_SPEND: {
    code: 'EXPENSE_CATEGORY_SPEND',
    title: 'Expense category spend',
    resource: 'expense',
    fieldGroup: 'operational',
    requiresPeriod: true,
    columns: [
      { key: 'category', header: 'Category' },
      { key: 'category_name', header: 'Category name' },
      { key: 'currency', header: 'Currency' },
      { key: 'claims', header: 'Approved claims' },
      { key: 'lines', header: 'Lines' },
      { key: 'claimed_total', header: 'Claimed total' },
      { key: 'approved_total', header: 'Approved total' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = await claimsInScope(db, grant, p);
      // Spend is what final approval entitled: the lines of finally approved claims, by EXPENSE_REGISTER's period, so the
      // approved totals of one period add up to that register's approved amounts.
      return (
        await db.query(
          `select cat.code as category, cat.name as category_name, c.currency_code as currency, count(distinct c.id)::int as claims, count(*)::int as lines,
                  ${MONEY('sum(l.claimed_amount)', 'claimed_total')}, ${MONEY(`sum(${FINAL_ALLOWED})`, 'approved_total')}
             from expense_claim c
             join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision
             join expense_line l on l.company_id = r.company_id and l.revision_id = r.id
             join expense_category cat on cat.company_id = l.company_id and cat.id = l.category_id
            where ${scope} and c.state = 'APPROVED'
              and hrms_business_date(c.company_id, r.submitted_at) between ${p.add(f.from)}::date and ${p.add(f.to)}::date
            group by cat.code, cat.name, c.currency_code
            order by cat.code, c.currency_code`,
          p.values,
        )
      ).rows;
    },
  },

  EXPENSE_PAYABLE_AGEING: {
    code: 'EXPENSE_PAYABLE_AGEING',
    title: 'Expense payable ageing',
    // C3 Payment "export": a payment output has its own export right (0131); the claim read rule above still applies.
    resource: 'payment',
    fieldGroup: 'operational',
    requiresPeriod: false,
    checkFilters: refusePeriod,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'claim_id', header: 'Claim' },
      { key: 'approved_on', header: 'Approved on' },
      { key: 'age_days', header: 'Age (calendar days)' },
      { key: 'approved_amount', header: 'Approved amount' },
      { key: 'net_paid', header: 'Net paid' },
      { key: 'pending', header: 'Pending' },
      { key: 'outstanding', header: 'Outstanding' },
      { key: 'allocatable', header: 'Allocatable' },
      { key: 'payment_state', header: 'Payment state' },
      { key: 'currency', header: 'Currency' },
    ],
    async rows(db, grant) {
      const p = new SqlParams();
      const scope = await claimsInScope(db, grant, p);
      const asAt = `${p.add(grant.businessDate)}::date`;
      // The same claims as GET /expense/payables (expense/service.ts listPayables), DF07's ledger figures.
      return (
        await db.query(
          `select e.employee_code, c.id as claim_id, to_char(hrms_business_date(o.company_id, o.created_at), 'YYYY-MM-DD') as approved_on,
                  ${asAt} - hrms_business_date(o.company_id, o.created_at) as age_days,
                  ${MONEY('l.approved_amount', 'approved_amount')}, ${MONEY('l.net_paid', 'net_paid')}, ${MONEY('l.pending', 'pending')},
                  ${MONEY('l.approved_amount - l.net_paid', 'outstanding')}, ${MONEY('l.approved_amount - l.net_paid - l.pending', 'allocatable')},
                  c.payment_state, l.currency_code as currency
             from expense_claim c
             join employee e on e.company_id = c.company_id and e.id = c.employee_id
             join expense_obligation_ledger l on l.company_id = c.company_id and l.claim_id = c.id
             join expense_obligation o on o.company_id = c.company_id and o.id = l.obligation_id
            where ${scope} and c.state = 'APPROVED' and c.payment_state <> 'PAID'
            order by age_days desc, e.employee_code, c.id`,
          p.values,
        )
      ).rows;
    },
  },

  EXPENSE_PAYMENT_RECONCILIATION: {
    code: 'EXPENSE_PAYMENT_RECONCILIATION',
    title: 'Expense payment reconciliation',
    resource: 'payment',
    fieldGroup: 'operational',
    requiresPeriod: true,
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'claim_id', header: 'Claim' },
      { key: 'approved_on', header: 'Approved on' },
      { key: 'approved_amount', header: 'Approved amount' },
      { key: 'confirmed', header: 'Confirmed' },
      { key: 'reversed', header: 'Reversed' },
      { key: 'net_paid', header: 'Net paid' },
      { key: 'pending', header: 'Pending' },
      { key: 'outstanding', header: 'Outstanding' },
      { key: 'allocatable', header: 'Allocatable' },
      { key: 'payment_state', header: 'Payment state' },
      { key: 'currency', header: 'Currency' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const scope = await claimsInScope(db, grant, p);
      // DF07: net paid = confirmed - reversed; outstanding = approved - net paid; allocatable also leaves out pending. Every
      // figure as the ledger holds it when generated (pending is shown apart and is never paid, C5), for claims approved in
      // the period. Confirmed and reversed come from the claim's own allocations, as the ledger's net paid does (0088).
      return (
        await db.query(
          `select e.employee_code, c.id as claim_id, to_char(hrms_business_date(o.company_id, o.created_at), 'YYYY-MM-DD') as approved_on,
                  ${MONEY('l.approved_amount', 'approved_amount')},
                  ${MONEY(
                    `coalesce((select sum(a.amount) from payment_allocation a
                                where a.company_id = o.company_id and a.obligation_id = o.id
                                  and exists (select 1 from payment_event x where x.company_id = a.company_id and x.instruction_id = a.instruction_id and x.event_kind = 'CONFIRMED')), 0)`,
                    'confirmed',
                  )},
                  ${MONEY(
                    `coalesce((select sum(x.amount) from payment_allocation a
                                 join payment_event x on x.company_id = a.company_id and x.allocation_id = a.id and x.event_kind = 'REVERSED'
                                where a.company_id = o.company_id and a.obligation_id = o.id), 0)`,
                    'reversed',
                  )},
                  ${MONEY('l.net_paid', 'net_paid')}, ${MONEY('l.pending', 'pending')},
                  ${MONEY('l.approved_amount - l.net_paid', 'outstanding')}, ${MONEY('l.approved_amount - l.net_paid - l.pending', 'allocatable')},
                  c.payment_state, l.currency_code as currency
             from expense_claim c
             join employee e on e.company_id = c.company_id and e.id = c.employee_id
             join expense_obligation_ledger l on l.company_id = c.company_id and l.claim_id = c.id
             join expense_obligation o on o.company_id = c.company_id and o.id = l.obligation_id
            where ${scope}
              and hrms_business_date(o.company_id, o.created_at) between ${p.add(f.from)}::date and ${p.add(f.to)}::date
            order by e.employee_code, o.created_at, c.id`,
          p.values,
        )
      ).rows;
    },
  },
};
