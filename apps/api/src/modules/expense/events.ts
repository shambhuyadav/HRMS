// Expense notices (FR-079; BR-033; DF07; DF12). Employee identity, the submission date, the reviewer step and states only:
// amounts, purposes, merchants, reasons, receipts, payment references and evidence keys never travel in notifications.
// A describer never throws on a bad payload and returns null when the event should produce nothing.
import type { Queryable } from '../../db/queryable.js';
import type { EventDescriber } from '../events-registry.js';
import type { EventSpec } from '../notification/dispatcher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const positiveInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : null);
const label = (labels: Readonly<Record<string, string>>, v: unknown): string | null => (typeof v === 'string' && Object.hasOwn(labels, v) ? labels[v]! : null);

const STEP_LABELS: Readonly<Record<string, string>> = { manager_decide: 'manager review', finance_decide: 'financial review', high_value_decide: 'high-value approval' };
const OUTCOME_LABELS: Readonly<Record<string, string>> = { APPROVED: 'approved', REJECTED: 'rejected', RETURNED: 'returned for correction' };
const PAYMENT_EVENT_LABELS: Readonly<Record<string, string>> = { CONFIRMED: 'confirmed', FAILED: 'recorded as failed', REVERSED: 'reversed' };
const PAYMENT_STATUS_LABELS: Readonly<Record<string, string>> = { UNPAID: 'unpaid', PART_PAID: 'part-paid', PAID: 'paid' };

/**
 * The claim as the event was raised: the revision in the payload, or its latest submitted revision for an event that
 * carries none. A revision that does not exist or was never submitted describes nothing.
 */
async function claimFacts(tx: Queryable, companyId: string, claimId: string, revision: number | null) {
  return (
    await tx.query<{ employee_id: string; transaction_id: string; revision: number; code: string; name: string; submitted_date: string }>(
      `select c.employee_id, c.transaction_id, r.revision, e.employee_code as code, e.display_name as name,
              to_char(hrms_business_date(c.company_id, r.submitted_at), 'YYYY-MM-DD') as submitted_date
         from expense_claim c
         join employee e on e.company_id = c.company_id and e.id = c.employee_id
         join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.submitted_at is not null
        where c.company_id = $1 and c.id = $2 and ($3::int is null or r.revision = $3::int)
        order by r.revision desc limit 1`,
      [companyId, claimId, revision],
    )
  ).rows[0];
}

const spec = (eventType: string, facts: NonNullable<Awaited<ReturnType<typeof claimFacts>>>, taskId: string | null, data: Record<string, string>): EventSpec => ({
  eventType,
  subjectEmployeeId: facts.employee_id,
  transactionId: facts.transaction_id,
  transactionRevision: facts.revision,
  taskId,
  beneficiaryUserId: null,
  data,
});

/** A task of this claim waiting for a reviewer: the step it is at, for the reviewer's notice. */
const waitingForReviewer =
  (eventType: string): EventDescriber =>
  async (tx, ev) => {
    const claimId = id(ev.payload.claimId);
    const taskId = id(ev.payload.taskId);
    if (!claimId || !taskId) return null;
    const facts = await claimFacts(tx, ev.companyId, claimId, positiveInt(ev.payload.revision));
    if (!facts) return null;
    const action = (
      await tx.query<{ action: string }>(
        `select p.action from approval_task t
           join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
           join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
           join permission p on p.id = s.permission_id
          where t.company_id = $1 and t.id = $2 and i.transaction_id = $3 and p.resource = 'expense'`,
        [ev.companyId, taskId, facts.transaction_id],
      )
    ).rows[0]?.action;
    const step = label(STEP_LABELS, action);
    if (!step) return null;
    return spec(eventType, facts, taskId, { employeeName: facts.name, employeeCode: facts.code, submittedDate: facts.submitted_date, step });
  };

const decided: EventDescriber = async (tx, ev) => {
  const claimId = id(ev.payload.claimId);
  const outcome = label(OUTCOME_LABELS, ev.payload.outcome);
  if (!claimId || !outcome) return null;
  const facts = await claimFacts(tx, ev.companyId, claimId, positiveInt(ev.payload.revision));
  if (!facts) return null;
  // DF06: a zero entitlement is a valid approval, and "approved" alone would promise a payment.
  const shown = ev.payload.paymentState === 'NO_PAYABLE_AMOUNT' ? `${outcome} with no payable amount` : outcome;
  return spec('EXPENSE_DECIDED', facts, null, { submittedDate: facts.submitted_date, outcome: shown });
};

const withdrawn: EventDescriber = async (tx, ev) => {
  const claimId = id(ev.payload.claimId);
  const taskId = id(ev.payload.taskId);
  if (!claimId || !taskId) return null;
  const facts = await claimFacts(tx, ev.companyId, claimId, null);
  if (!facts) return null;
  return spec('EXPENSE_WITHDRAWN', facts, taskId, { employeeName: facts.name, employeeCode: facts.code, submittedDate: facts.submitted_date });
};

const paymentStatus: EventDescriber = async (tx, ev) => {
  const claimId = id(ev.payload.claimId);
  const paymentEvent = label(PAYMENT_EVENT_LABELS, ev.payload.paymentEvent);
  const status = label(PAYMENT_STATUS_LABELS, ev.payload.paymentState);
  if (!claimId || !paymentEvent || !status) return null;
  const facts = await claimFacts(tx, ev.companyId, claimId, null);
  if (!facts) return null;
  return spec('EXPENSE_PAYMENT_STATUS', facts, null, { submittedDate: facts.submitted_date, paymentEvent, paymentStatus: status });
};

export const EXPENSE_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'expense.submitted': waitingForReviewer('EXPENSE_SUBMITTED'),
  'expense.assigned': waitingForReviewer('EXPENSE_ASSIGNED'),
  'expense.decided': decided,
  'expense.withdrawn': withdrawn,
  'expense.payment_status': paymentStatus,
};
