// Increment notices (FR-084; BR-033; DF12; DF15; CR-007). The employee's identity and the outcome state only: amounts,
// percentages, components and reasons never travel in notifications. A describer never throws on a bad payload and
// returns null when the event should produce nothing.
import type { Queryable } from '../../db/queryable.js';
import type { EventDescriber } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);

const OUTCOME_LABELS: Readonly<Record<string, string>> = {
  APPLIED: 'applied',
  NO_CHANGE: 'no change',
  DEFERRED: 'deferred',
  RETURNED: 'returned for correction',
  REJECTED: 'rejected',
};

async function caseFacts(tx: Queryable, companyId: string, caseId: string) {
  return (
    await tx.query<{ employee_id: string; transaction_id: string; revision: number; code: string; name: string; proposed_by: string | null; off_cycle: boolean }>(
      `select c.employee_id, c.transaction_id, bt.revision, e.employee_code as code, e.display_name as name, c.proposed_by, c.off_cycle
         from increment_case c
         join business_transaction bt on bt.company_id = c.company_id and bt.id = c.transaction_id
         join employee e on e.company_id = c.company_id and e.id = c.employee_id
        where c.company_id = $1 and c.id = $2`,
      [companyId, caseId],
    )
  ).rows[0];
}

const proposed: EventDescriber = async (tx, ev) => {
  const caseId = id(ev.payload.caseId);
  const taskId = id(ev.payload.taskId);
  if (!caseId || !taskId) return null;
  const c = await caseFacts(tx, ev.companyId, caseId);
  if (!c) return null;
  return {
    eventType: 'INCREMENT_PROPOSED',
    subjectEmployeeId: c.employee_id,
    transactionId: c.transaction_id,
    transactionRevision: c.revision,
    taskId,
    beneficiaryUserId: null,
    data: { employeeName: c.name, employeeCode: c.code },
  };
};

const decided: EventDescriber = async (tx, ev) => {
  const caseId = id(ev.payload.caseId);
  const outcome = typeof ev.payload.outcome === 'string' && Object.hasOwn(OUTCOME_LABELS, ev.payload.outcome) ? OUTCOME_LABELS[ev.payload.outcome] : undefined;
  if (!caseId || !outcome) return null;
  const c = await caseFacts(tx, ev.companyId, caseId);
  if (!c) return null;
  return {
    eventType: 'INCREMENT_DECIDED',
    subjectEmployeeId: c.employee_id,
    transactionId: c.transaction_id,
    transactionRevision: c.revision,
    taskId: null,
    beneficiaryUserId: null,
    proposerUserId: c.proposed_by ?? undefined,
    // DF15: a cycle case belongs to the current direct manager, who proposes again if it is returned; an off-cycle case
    // is an HR proposal the manager has no part in, so BR-033 gives no ground to tell them.
    managerAlso: !c.off_cycle,
    data: { employeeName: c.name, employeeCode: c.code, outcome },
  };
};

export const INCREMENT_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'increment.proposed': proposed,
  'increment.decided': decided,
};
