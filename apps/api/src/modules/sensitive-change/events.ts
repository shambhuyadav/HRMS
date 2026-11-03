// Notification events of sensitive changes (DF12). Category, employee identity, effective date and outcome only:
// proposed or approved values, field contents, reasons and reviewer notes never travel in notifications.
import type { EventDescriber } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CATEGORY_LABELS: Record<string, string> = { PERSONAL: 'personal details', ADDRESS: 'address', BANK: 'bank details' };
const OUTCOME_LABELS: Record<string, string> = {
  APPLIED: 'applied',
  SCHEDULED: 'approved and scheduled',
  RETURNED: 'returned for correction',
  REJECTED: 'rejected',
  CONFLICT: 'not applied because your details changed meanwhile; please review and submit it again',
  CONFLICT_RECHECK: 'not applied because its approval or supporting document could not be confirmed on that date; please review and submit it again',
};

const describe =
  (eventType: string): EventDescriber =>
  async (tx, ev) => {
    const requestId = typeof ev.payload.requestId === 'string' && UUID.test(ev.payload.requestId) ? ev.payload.requestId : null;
    if (!requestId) return null;
    const r = (
      await tx.query<{ employee_id: string; transaction_id: string; revision: number; category: string; effective_date: string; code: string; name: string }>(
        `select r.employee_id, r.transaction_id, bt.revision, r.category, to_char(r.proposed_effective_date, 'YYYY-MM-DD') as effective_date,
                e.employee_code as code, e.display_name as name
           from employee_sensitive_change_request r
           join business_transaction bt on bt.company_id = r.company_id and bt.id = r.transaction_id
           join employee e on e.company_id = r.company_id and e.id = r.employee_id
          where r.company_id = $1 and r.id = $2`,
        [ev.companyId, requestId],
      )
    ).rows[0];
    if (!r) return null;
    const taskId = typeof ev.payload.taskId === 'string' && UUID.test(ev.payload.taskId) ? ev.payload.taskId : null;
    const outcome = typeof ev.payload.outcome === 'string' ? OUTCOME_LABELS[ev.payload.outcome] : undefined;
    return {
      eventType,
      subjectEmployeeId: r.employee_id,
      transactionId: r.transaction_id,
      transactionRevision: r.revision,
      taskId,
      beneficiaryUserId: null,
      data: {
        category: CATEGORY_LABELS[r.category] ?? 'details',
        employeeName: r.name,
        employeeCode: r.code,
        effectiveDate: r.effective_date,
        outcome: outcome ?? '',
      },
    };
  };

/** H7 "bank change cutoff": the period and dates only; the rule itself is in notification/catalogue.ts. */
const bankCutoff: EventDescriber = async (tx, ev) => {
  const { requestId, periodCode, inputCutoff } = ev.payload;
  if (typeof requestId !== 'string' || !UUID.test(requestId) || typeof periodCode !== 'string' || periodCode === '' || typeof inputCutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(inputCutoff)) return null;
  const r = (
    await tx.query<{ employee_id: string; transaction_id: string; revision: number; effective_date: string }>(
      `select r.employee_id, r.transaction_id, bt.revision, to_char(r.proposed_effective_date, 'YYYY-MM-DD') as effective_date
         from employee_sensitive_change_request r join business_transaction bt on bt.company_id = r.company_id and bt.id = r.transaction_id
        where r.company_id = $1 and r.id = $2 and r.category = 'BANK'`,
      [ev.companyId, requestId],
    )
  ).rows[0];
  if (!r) return null;
  return {
    eventType: 'BANK_CHANGE_CUTOFF',
    subjectEmployeeId: r.employee_id,
    transactionId: r.transaction_id,
    transactionRevision: r.revision,
    taskId: null,
    beneficiaryUserId: null,
    data: { effectiveDate: r.effective_date, inputCutoff, periodCode },
  };
};

export const SENSITIVE_CHANGE_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'sensitive_change.submitted': describe('SENSITIVE_CHANGE_SUBMITTED'),
  'sensitive_change.outcome': describe('SENSITIVE_CHANGE_OUTCOME'),
  'sensitive_change.bank_cutoff': bankCutoff,
};
