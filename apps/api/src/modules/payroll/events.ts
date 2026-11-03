// Payroll calculation, freeze and holds (FR-028 to FR-033, FR-037, FR-099, FR-101; DF05; H2): notification events.
// Operational facts only (period code, revision, step, employee identity, outcome): amounts, reasons, criteria, bank
// details and exception details never travel in notifications (DF12; H7 "email contains no bank values/salary").
// A describer never throws on a bad payload and returns null when the event should produce nothing (for example a
// reminder about a hold that has been decided meanwhile).
import type { Queryable } from '../../db/queryable.js';
import type { EventDescriber } from '../events-registry.js';
import type { EventSpec } from '../notification/dispatcher.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const positiveInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : null);

const STEP_LABELS: Record<string, string> = { review: 'review', approval: 'approval', cover: 'covering approval' };
const INPUT_OUTCOMES: Record<string, string> = { APPROVED: 'approved', REJECTED: 'rejected' };
const HOLD_OUTCOMES: Record<string, string> = {
  HELD: 'is on hold',
  SAFETY_BLOCK: 'is on hold until approved bank details are on record',
  RELEASED: 'was released for payment',
};

const base = (eventType: string, over: Partial<EventSpec> & { data: Record<string, string> }): EventSpec => ({
  eventType,
  subjectEmployeeId: null,
  transactionId: null,
  transactionRevision: null,
  taskId: null,
  beneficiaryUserId: null,
  ...over,
});

async function runFacts(tx: Queryable, companyId: string, runId: string) {
  return (
    await tx.query<{ transaction_id: string; revision: number; period_code: string; calculated_by: string | null; successor_revision: number | null }>(
      `select r.transaction_id, r.revision, p.period_code, r.calculated_by,
              (select n.revision from payroll_run n where n.company_id = r.company_id and n.supersedes_run_id = r.id) as successor_revision
         from payroll_run r join payroll_period p on p.company_id = r.company_id and p.id = r.period_id
        where r.company_id = $1 and r.id = $2`,
      [companyId, runId],
    )
  ).rows[0];
}

const runAssigned: EventDescriber = async (tx, ev) => {
  const runId = id(ev.payload.runId);
  const taskId = id(ev.payload.taskId);
  const step = typeof ev.payload.step === 'string' ? STEP_LABELS[ev.payload.step] : undefined;
  if (!runId || !taskId || !step) return null;
  const r = await runFacts(tx, ev.companyId, runId);
  if (!r) return null;
  return base('PAYROLL_RUN_ASSIGNED', { transactionId: r.transaction_id, transactionRevision: 1, taskId, data: { step, revision: String(r.revision), periodCode: r.period_code } });
};

const runReturned: EventDescriber = async (tx, ev) => {
  const runId = id(ev.payload.runId);
  if (!runId) return null;
  const r = await runFacts(tx, ev.companyId, runId);
  if (!r || !r.calculated_by || r.successor_revision === null) return null;
  return base('PAYROLL_RUN_RETURNED', {
    transactionId: r.transaction_id,
    transactionRevision: 1,
    beneficiaryUserId: r.calculated_by,
    data: { revision: String(r.revision), newRevision: String(r.successor_revision), periodCode: r.period_code },
  });
};

const runProcessed: EventDescriber = async (tx, ev) => {
  const runId = id(ev.payload.runId);
  if (!runId) return null;
  const r = await runFacts(tx, ev.companyId, runId);
  if (!r || !r.calculated_by) return null;
  return base('PAYROLL_RUN_PROCESSED', { transactionId: r.transaction_id, transactionRevision: 1, beneficiaryUserId: r.calculated_by, data: { revision: String(r.revision), periodCode: r.period_code } });
};

async function batchFacts(tx: Queryable, companyId: string, batchId: string) {
  return (
    await tx.query<{ transaction_id: string; line_count: number; period_code: string; prepared_by: string }>(
      `select b.transaction_id, b.line_count, p.period_code, b.prepared_by from payroll_input_batch b join payroll_period p on p.company_id = b.company_id and p.id = b.period_id
        where b.company_id = $1 and b.id = $2`,
      [companyId, batchId],
    )
  ).rows[0];
}

const inputsAssigned: EventDescriber = async (tx, ev) => {
  const batchId = id(ev.payload.batchId);
  const taskId = id(ev.payload.taskId);
  if (!batchId || !taskId) return null;
  const b = await batchFacts(tx, ev.companyId, batchId);
  if (!b) return null;
  return base('PAYROLL_INPUTS_ASSIGNED', { transactionId: b.transaction_id, transactionRevision: 1, taskId, data: { lineCount: String(b.line_count), periodCode: b.period_code } });
};

const inputsDecided: EventDescriber = async (tx, ev) => {
  const batchId = id(ev.payload.batchId);
  const outcome = typeof ev.payload.outcome === 'string' ? INPUT_OUTCOMES[ev.payload.outcome] : undefined;
  if (!batchId || !outcome) return null;
  const b = await batchFacts(tx, ev.companyId, batchId);
  if (!b) return null;
  return base('PAYROLL_INPUTS_DECIDED', {
    transactionId: b.transaction_id,
    transactionRevision: 1,
    beneficiaryUserId: b.prepared_by,
    data: { lineCount: String(b.line_count), periodCode: b.period_code, outcome },
  });
};

/** A reversal of approved lines tells the batch's preparer, through the batch decision's template: counts only. */
const inputsReversed: EventDescriber = async (tx, ev) => {
  const batchId = id(ev.payload.batchId);
  const lines = positiveInt(ev.payload.lines);
  if (!batchId || lines === null) return null;
  const b = await batchFacts(tx, ev.companyId, batchId);
  if (!b) return null;
  return base('PAYROLL_INPUTS_DECIDED', {
    transactionId: b.transaction_id,
    transactionRevision: 1,
    beneficiaryUserId: b.prepared_by,
    data: { lineCount: String(b.line_count), periodCode: b.period_code, outcome: `changed: ${lines} approved ${lines === 1 ? 'line was' : 'lines were'} reversed` },
  });
};

const stopAssigned: EventDescriber = async (tx, ev) => {
  const stopId = id(ev.payload.stopId);
  const taskId = id(ev.payload.taskId);
  if (!stopId || !taskId) return null;
  const s = (
    await tx.query<{ transaction_id: string; employee_id: string; code: string; name: string; period_code: string }>(
      `select s.transaction_id, s.employee_id, e.employee_code as code, e.display_name as name, p.period_code
         from payroll_salary_stop s join employee e on e.company_id = s.company_id and e.id = s.employee_id
         join payroll_period p on p.company_id = s.company_id and p.id = s.period_id
        where s.company_id = $1 and s.id = $2`,
      [ev.companyId, stopId],
    )
  ).rows[0];
  if (!s) return null;
  return base('PAYROLL_SALARY_STOP_ASSIGNED', {
    subjectEmployeeId: s.employee_id,
    transactionId: s.transaction_id,
    transactionRevision: 1,
    taskId,
    data: { employeeName: s.name, employeeCode: s.code, periodCode: s.period_code },
  });
};

async function holdFacts(tx: Queryable, companyId: string, holdId: string) {
  return (
    await tx.query<{ transaction_id: string; employee_id: string; code: string; name: string; period_code: string; state: string; hold_kind: string; unresolved_since: string | null }>(
      `select h.transaction_id, h.employee_id, e.employee_code as code, e.display_name as name, p.period_code, h.state, h.hold_kind, h.unresolved_since
         from payroll_hold h join employee e on e.company_id = h.company_id and e.id = h.employee_id
         join payroll_run r on r.company_id = h.company_id and r.id = h.run_id
         join payroll_period p on p.company_id = r.company_id and p.id = r.period_id
        where h.company_id = $1 and h.id = $2`,
      [companyId, holdId],
    )
  ).rows[0];
}

const holdAssigned: EventDescriber = async (tx, ev) => {
  const holdId = id(ev.payload.holdId);
  const taskId = id(ev.payload.taskId);
  if (!holdId || !taskId) return null;
  const h = await holdFacts(tx, ev.companyId, holdId);
  if (!h) return null;
  return base('PAYROLL_HOLD_ASSIGNED', {
    subjectEmployeeId: h.employee_id,
    transactionId: h.transaction_id,
    transactionRevision: 1,
    taskId,
    data: { employeeName: h.name, employeeCode: h.code, periodCode: h.period_code },
  });
};

/** H7 "employee-visible hold/release": the status only, never the reason, criterion or amount. */
const holdStatus: EventDescriber = async (tx, ev) => {
  const holdId = id(ev.payload.holdId);
  const outcome = typeof ev.payload.outcome === 'string' ? HOLD_OUTCOMES[ev.payload.outcome] : undefined;
  if (!holdId || !outcome) return null;
  const h = await holdFacts(tx, ev.companyId, holdId);
  if (!h) return null;
  return base('PAYROLL_HOLD_STATUS', { subjectEmployeeId: h.employee_id, transactionId: h.transaction_id, transactionRevision: 1, data: { periodCode: h.period_code, outcome } });
};

const holdReminder: EventDescriber = async (tx, ev) => {
  const holdId = id(ev.payload.holdId);
  const taskId = id(ev.payload.taskId);
  if (!holdId || !taskId) return null;
  const h = await holdFacts(tx, ev.companyId, holdId);
  if (!h || h.state !== 'PROPOSED') return null;
  return base('PAYROLL_HOLD_REMINDER', { subjectEmployeeId: h.employee_id, transactionId: h.transaction_id, transactionRevision: 1, taskId, data: { employeeCode: h.code, periodCode: h.period_code } });
};

const unresolved = (h: { state: string; hold_kind: string }) => h.state === 'PROPOSED' || h.state === 'EXPIRED_REVIEW' || (h.state === 'APPROVED_ACTIVE' && h.hold_kind === 'PAYMENT_SAFETY_BLOCK');

const holdReviewDue: EventDescriber = async (tx, ev) => {
  const holdId = id(ev.payload.holdId);
  if (!holdId) return null;
  const h = await holdFacts(tx, ev.companyId, holdId);
  if (!h || !unresolved(h)) return null;
  return base('PAYROLL_HOLD_REVIEW_DUE', {
    fallbackKind: 'payroll_hold',
    subjectEmployeeId: h.employee_id,
    transactionId: h.transaction_id,
    transactionRevision: 1,
    data: { employeeCode: h.code, periodCode: h.period_code },
  });
};

const holdEscalation: EventDescriber = async (tx, ev) => {
  const holdId = id(ev.payload.holdId);
  const waitingDays = positiveInt(ev.payload.waitingDays);
  if (!holdId || waitingDays === null) return null;
  const h = await holdFacts(tx, ev.companyId, holdId);
  if (!h || !unresolved(h)) return null;
  return base('PAYROLL_HOLD_ESCALATION', {
    fallbackKind: 'payroll_hold',
    subjectEmployeeId: h.employee_id,
    transactionId: h.transaction_id,
    transactionRevision: 1,
    data: { employeeCode: h.code, periodCode: h.period_code, waitingDays: String(waitingDays) },
  });
};

// Payloads are validated before any lookup (identifiers by pattern), so a malformed payload produces nothing and
// never raises; a database failure is left to the dispatcher, which retries the event.
export const PAYROLL_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'payroll_run.assigned': runAssigned,
  'payroll_run.returned': runReturned,
  'payroll_run.processed': runProcessed,
  'payroll_inputs.assigned': inputsAssigned,
  'payroll_inputs.decided': inputsDecided,
  'payroll_inputs.reversed': inputsReversed,
  'payroll_salary_stop.assigned': stopAssigned,
  'payroll_hold.assigned': holdAssigned,
  'payroll_hold.status': holdStatus,
  'payroll_hold.reminder': holdReminder,
  'payroll_hold.review_due': holdReviewDue,
  'payroll_hold.escalation': holdEscalation,
};
