// Employee processes, letters and exit (FR-015 to FR-018, FR-051 to FR-055; F1 exit and employee processes): notification
// events (DF12). Identity, dates, revision, step and outcome only: reasons, remarks, notes, letter content and
// settlement amounts never travel in notifications. Payload ids are validated before any query; an event whose
// record is gone, or whose recipient no longer applies, produces nothing.
import type { Queryable } from '../../db/queryable.js';
import type { EventDescriber, ModuleOutboxEvent } from '../events-registry.js';
import type { EventSpec } from '../notification/dispatcher.js';
import { ruleOf } from './separation-types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

const spec = (s: Partial<EventSpec> & Pick<EventSpec, 'eventType' | 'data'>): EventSpec => ({
  subjectEmployeeId: null,
  transactionId: null,
  transactionRevision: null,
  taskId: null,
  beneficiaryUserId: null,
  ...s,
});

interface ExitFacts {
  employee_id: string;
  transaction_id: string;
  revision: number;
  employee_code: string;
  employee_name: string;
  leaving_date: string;
  approved_leaving_date: string | null;
  separation_type: string;
}

/**
 * I-89 item 7 (0242): an HR-entered separation other than a resignation is announced in its own words (SEPARATION_*): to the reviewers
 * of its tasks, and its decision to the employee's manager only. The employee hears of it through HR's letter, and a deceased
 * employee's self-service is never notified (notification/dispatcher.ts refuses it for every event).
 */
const SEPARATION_EVENT = { EXIT_SUBMITTED: 'SEPARATION_SUBMITTED', EXIT_RECOMMENDED: 'SEPARATION_RECOMMENDED', EXIT_DECIDED: 'SEPARATION_DECIDED' } as const;
const separationWords = (x: ExitFacts) => (x.separation_type === 'RESIGNATION' ? {} : { separationType: ruleOf(x.separation_type).label });
const eventTypeOf = (x: ExitFacts, resignation: keyof typeof SEPARATION_EVENT) => (x.separation_type === 'RESIGNATION' ? resignation : SEPARATION_EVENT[resignation]);

async function exitFacts(tx: Queryable, companyId: string, exitCaseId: string): Promise<ExitFacts | undefined> {
  return (
    await tx.query<ExitFacts>(
      `select x.employee_id, x.transaction_id, bt.revision, e.employee_code, e.display_name as employee_name, to_char(x.leaving_date, 'YYYY-MM-DD') as leaving_date,
              to_char(x.approved_leaving_date, 'YYYY-MM-DD') as approved_leaving_date, x.separation_type
         from exit_case x
         join business_transaction bt on bt.company_id = x.company_id and bt.id = x.transaction_id
         join employee e on e.company_id = x.company_id and e.id = x.employee_id
        where x.company_id = $1 and x.id = $2`,
      [companyId, exitCaseId],
    )
  ).rows[0];
}

const exitReviewer =
  (eventType: 'EXIT_SUBMITTED' | 'EXIT_RECOMMENDED'): EventDescriber =>
  async (tx, ev) => {
    const exitCaseId = id(ev.payload.exitCaseId);
    const taskId = id(ev.payload.taskId);
    if (!exitCaseId || !taskId) return null;
    const x = await exitFacts(tx, ev.companyId, exitCaseId);
    if (!x) return null;
    return spec({
      eventType: eventTypeOf(x, eventType),
      subjectEmployeeId: x.employee_id,
      transactionId: x.transaction_id,
      transactionRevision: x.revision,
      taskId,
      data: { employeeName: x.employee_name, employeeCode: x.employee_code, lastWorkingDate: x.leaving_date, ...separationWords(x) },
    });
  };

const exitOutcome: EventDescriber = async (tx, ev) => {
  const exitCaseId = id(ev.payload.exitCaseId);
  if (!exitCaseId) return null;
  const x = await exitFacts(tx, ev.companyId, exitCaseId);
  if (!x) return null;
  const outcome =
    ev.payload.outcome === 'APPROVED' && x.approved_leaving_date
      ? `approved; the last working date is ${x.approved_leaving_date}`
      : ev.payload.outcome === 'REJECTED'
        ? 'not approved'
        : ev.payload.outcome === 'WITHDRAWN'
          ? 'withdrawn'
          : null;
  if (!outcome) return null;
  return spec({
    eventType: eventTypeOf(x, 'EXIT_DECIDED'),
    subjectEmployeeId: x.employee_id,
    transactionId: x.transaction_id,
    transactionRevision: x.revision,
    data: { employeeName: x.employee_name, employeeCode: x.employee_code, outcome, ...separationWords(x) },
  });
};

async function withdrawalFacts(tx: Queryable, ev: ModuleOutboxEvent) {
  const withdrawalId = id(ev.payload.withdrawalId);
  if (!withdrawalId) return undefined;
  return (
    await tx.query<{ employee_id: string; transaction_id: string; revision: number; employee_code: string; employee_name: string; leaving_date: string }>(
      `select w.employee_id, w.transaction_id, bt.revision, e.employee_code, e.display_name as employee_name, to_char(x.leaving_date, 'YYYY-MM-DD') as leaving_date
         from exit_withdrawal_request w
         join exit_case x on x.company_id = w.company_id and x.id = w.exit_case_id
         join business_transaction bt on bt.company_id = w.company_id and bt.id = w.transaction_id
         join employee e on e.company_id = w.company_id and e.id = w.employee_id
        where w.company_id = $1 and w.id = $2`,
      [ev.companyId, withdrawalId],
    )
  ).rows[0];
}

const withdrawalSubmitted: EventDescriber = async (tx, ev) => {
  const taskId = id(ev.payload.taskId);
  const w = await withdrawalFacts(tx, ev);
  if (!w || !taskId) return null;
  return spec({
    eventType: 'EXIT_WITHDRAWAL_SUBMITTED',
    subjectEmployeeId: w.employee_id,
    transactionId: w.transaction_id,
    transactionRevision: w.revision,
    taskId,
    data: { employeeName: w.employee_name, employeeCode: w.employee_code, lastWorkingDate: w.leaving_date },
  });
};

const withdrawalDecided: EventDescriber = async (tx, ev) => {
  const w = await withdrawalFacts(tx, ev);
  if (!w) return null;
  const outcome = ev.payload.outcome === 'APPROVED' ? 'approved; your resignation is withdrawn' : ev.payload.outcome === 'REJECTED' ? 'not approved; your resignation stands' : null;
  if (!outcome) return null;
  return spec({ eventType: 'EXIT_WITHDRAWAL_DECIDED', subjectEmployeeId: w.employee_id, transactionId: w.transaction_id, transactionRevision: w.revision, data: { outcome } });
};

/** A task named for a user notifies that user while they still own the open task. */
const taskAssigned: EventDescriber = async (tx, ev) => {
  const taskId = id(ev.payload.taskId);
  const owner = id(ev.payload.ownerUserId);
  if (!taskId || !owner) return null;
  const t = (
    await tx.query<{ owner_user_id: string | null; state: string; title: string; due_date: string; employee_id: string; transaction_id: string; revision: number; process_name: string; employee_code: string; employee_name: string }>(
      `select t.owner_user_id, t.state, t.title, to_char(t.due_date, 'YYYY-MM-DD') as due_date, t.employee_id, p.transaction_id, bt.revision, lp.name as process_name,
              e.employee_code, e.display_name as employee_name
         from employee_process_task t
         join employee_process p on p.company_id = t.company_id and p.id = t.employee_process_id
         join business_transaction bt on bt.company_id = p.company_id and bt.id = p.transaction_id
         join lifecycle_process lp on lp.company_id = p.company_id and lp.id = p.process_id
         join employee e on e.company_id = t.company_id and e.id = t.employee_id
        where t.company_id = $1 and t.id = $2`,
      [ev.companyId, taskId],
    )
  ).rows[0];
  if (!t || t.state !== 'OPEN' || t.owner_user_id !== owner) return null;
  return spec({
    eventType: 'PROCESS_TASK_ASSIGNED',
    subjectEmployeeId: t.employee_id,
    transactionId: t.transaction_id,
    transactionRevision: t.revision,
    beneficiaryUserId: owner,
    data: { taskTitle: t.title, processName: t.process_name, employeeName: t.employee_name, employeeCode: t.employee_code, dueDate: t.due_date },
  });
};

async function settlementFacts(tx: Queryable, ev: ModuleOutboxEvent) {
  const settlementId = id(ev.payload.settlementId);
  if (!settlementId) return undefined;
  return (
    await tx.query<{ employee_id: string; transaction_id: string; bt_revision: number; revision: number; prepared_by: string; employee_code: string; employee_name: string }>(
      `select s.employee_id, s.transaction_id, bt.revision as bt_revision, s.revision, s.prepared_by, e.employee_code, e.display_name as employee_name
         from settlement s
         join business_transaction bt on bt.company_id = s.company_id and bt.id = s.transaction_id
         join employee e on e.company_id = s.company_id and e.id = s.employee_id
        where s.company_id = $1 and s.id = $2`,
      [ev.companyId, settlementId],
    )
  ).rows[0];
}

const settlementAssigned: EventDescriber = async (tx, ev) => {
  const taskId = id(ev.payload.taskId);
  const step = ev.payload.step === 'review' || ev.payload.step === 'approval' ? ev.payload.step : null;
  const s = await settlementFacts(tx, ev);
  if (!s || !taskId || !step) return null;
  const instance = (
    await tx.query<{ transaction_id: string; revision: number }>(
      `select i.transaction_id, i.transaction_revision as revision from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2`,
      [ev.companyId, taskId],
    )
  ).rows[0];
  if (!instance) return null;
  return spec({
    eventType: 'SETTLEMENT_ASSIGNED',
    subjectEmployeeId: s.employee_id,
    transactionId: instance.transaction_id,
    transactionRevision: instance.revision,
    taskId,
    data: { step, revision: String(s.revision), employeeName: s.employee_name, employeeCode: s.employee_code },
  });
};

const SETTLEMENT_OUTCOMES: Record<string, string> = {
  APPROVED: 'approved',
  RETURNED: 'returned for correction',
  REJECTED: 'rejected',
  RELEASE_ELIGIBLE: 'marked eligible for release (this records no payment)',
  // I-81 items 2, 5, 6: a payment recorded from evidence, and a revision voided.
  PAID: 'recorded as paid',
  CANCELLED: 'voided',
};

/** I-81 item 9: an in-app delivery tells the employee what kind of document is waiting, nothing more. */
const essDelivered: EventDescriber = async (tx, ev) => {
  const deliveryId = id(ev.payload.deliveryId);
  if (!deliveryId) return null;
  const d = (
    await tx.query<{ employee_id: string; source_kind: string; recipient_user_id: string }>(
      `select employee_id, source_kind, recipient_user_id from ess_delivery where company_id = $1 and id = $2`,
      [ev.companyId, deliveryId],
    )
  ).rows[0];
  if (!d) return null;
  return spec({
    eventType: 'ESS_DOCUMENT_DELIVERED',
    subjectEmployeeId: d.employee_id,
    data: { documentKind: d.source_kind === 'LETTER' ? 'letter' : 'full and final settlement statement' },
  });
};

const settlementDecided: EventDescriber = async (tx, ev) => {
  const s = await settlementFacts(tx, ev);
  const outcome = typeof ev.payload.outcome === 'string' ? SETTLEMENT_OUTCOMES[ev.payload.outcome] : undefined;
  if (!s || !outcome) return null;
  return spec({
    eventType: 'SETTLEMENT_DECIDED',
    subjectEmployeeId: s.employee_id,
    transactionId: s.transaction_id,
    transactionRevision: s.bt_revision,
    beneficiaryUserId: s.prepared_by,
    data: { revision: String(s.revision), employeeName: s.employee_name, employeeCode: s.employee_code, outcome },
  });
};

export const LIFECYCLE_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'exit.submitted': exitReviewer('EXIT_SUBMITTED'),
  'exit.recommended': exitReviewer('EXIT_RECOMMENDED'),
  'exit.outcome': exitOutcome,
  'exit_withdrawal.submitted': withdrawalSubmitted,
  'exit_withdrawal.decided': withdrawalDecided,
  'employee_process.task_assigned': taskAssigned,
  'settlement.assigned': settlementAssigned,
  'settlement.decided': settlementDecided,
  'ess.delivered': essDelivered,
};
