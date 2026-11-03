// Appraisal (FR-040 to FR-044; F1 appraisal): notification events (DF12). Cycle code and employee identity only:
// scores, results, comments, remarks and reasons never travel in notifications. A describer never throws on bad data:
// a payload that is not an object, malformed ids, unknown records, or a task that is not this appraisal's produce
// nothing. An event is described as it was raised: the revision in its payload when the transaction reached it.
import type { Queryable } from '../../db/queryable.js';
import type { EventDescriber, ModuleOutboxEvent } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const level = (v: unknown): string | null => (v === 1 || v === 2 ? String(v) : null);
/** The payload as an object; anything else (JSON null, an array, a scalar) reads as empty. */
const payloadOf = (ev: ModuleOutboxEvent): Record<string, unknown> =>
  ev.payload !== null && typeof ev.payload === 'object' && !Array.isArray(ev.payload) ? ev.payload : {};

async function subject(tx: Queryable, ev: ModuleOutboxEvent) {
  const companyId = id(ev.companyId);
  const appraisalId = id(payloadOf(ev).appraisalId);
  if (!companyId || !appraisalId) return null;
  const s = (
    await tx.query<{ appraisal_id: string; employee_id: string; transaction_id: string; revision: number; cycle_code: string; code: string; name: string }>(
      `select a.id as appraisal_id, a.employee_id, a.transaction_id, bt.revision, c.code as cycle_code, e.employee_code as code, e.display_name as name
         from appraisal a
         join appraisal_cycle c on c.company_id = a.company_id and c.id = a.cycle_id
         join business_transaction bt on bt.company_id = a.company_id and bt.id = a.transaction_id
         join employee e on e.company_id = a.company_id and e.id = a.employee_id
        where a.company_id = $1 and a.id = $2`,
      [companyId, appraisalId],
    )
  ).rows[0];
  if (!s) return null;
  // The revision the event was raised for, when the transaction has reached it; otherwise the current one.
  const raised = payloadOf(ev).revision;
  const revision = typeof raised === 'number' && Number.isInteger(raised) && raised >= 1 && raised <= s.revision ? raised : s.revision;
  return { ...s, companyId, revision };
}

type Subject = NonNullable<Awaited<ReturnType<typeof subject>>>;

/**
 * Whether a task of this appraisal's route (its own approvals or its second-level reviews) matches: by task id, or
 * by holder for a task the user held. A task of anything else names nobody here.
 */
async function onRoute(tx: Queryable, s: Subject, match: { taskId: string } | { userId: string }): Promise<boolean> {
  const column = 'taskId' in match ? 't.id' : 't.assignee_user_id';
  const value = 'taskId' in match ? match.taskId : match.userId;
  const r = await tx.query(
    `select 1 from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
      where t.company_id = $1 and ${column} = $2
        and (i.transaction_id = $3
             or i.transaction_id in (select sr.transaction_id from appraisal_second_review sr where sr.company_id = $1 and sr.appraisal_id = $4))
      limit 1`,
    [s.companyId, value, s.transaction_id, s.appraisal_id],
  );
  return (r.rowCount ?? 0) > 0;
}

/** A reviewer notice for the task named in the payload: a task of this appraisal's route, delivered only while open. */
const toReviewer =
  (eventType: string, withLevel: boolean): EventDescriber =>
  async (tx, ev) => {
    const taskId = id(payloadOf(ev).taskId);
    const lvl = withLevel ? level(payloadOf(ev).level) : null;
    if (!taskId || (withLevel && !lvl)) return null;
    const s = await subject(tx, ev);
    if (!s || !(await onRoute(tx, s, { taskId }))) return null;
    return {
      eventType,
      subjectEmployeeId: s.employee_id,
      transactionId: s.transaction_id,
      transactionRevision: s.revision,
      taskId,
      beneficiaryUserId: null,
      data: { cycleCode: s.cycle_code, employeeName: s.name, employeeCode: s.code, ...(lvl ? { level: lvl } : {}) },
    };
  };

/** A notice to the appraised employee. */
const toEmployee =
  (eventType: string): EventDescriber =>
  async (tx, ev) => {
    const s = await subject(tx, ev);
    if (!s) return null;
    return {
      eventType,
      subjectEmployeeId: s.employee_id,
      transactionId: s.transaction_id,
      transactionRevision: s.revision,
      taskId: null,
      beneficiaryUserId: null,
      data: { cycleCode: s.cycle_code },
    };
  };

/**
 * The holder of the task that a cancellation closed (the task is no longer open, so the user is named directly); only
 * someone who held a task of this appraisal's route.
 */
const toFormerTaskHolder: EventDescriber = async (tx, ev) => {
  const userId = id(payloadOf(ev).userId);
  if (!userId) return null;
  const s = await subject(tx, ev);
  if (!s || !(await onRoute(tx, s, { userId }))) return null;
  return {
    eventType: 'APPRAISAL_TASK_CANCELLED',
    subjectEmployeeId: s.employee_id,
    transactionId: s.transaction_id,
    transactionRevision: s.revision,
    taskId: null,
    beneficiaryUserId: userId,
    data: { cycleCode: s.cycle_code, employeeName: s.name, employeeCode: s.code },
  };
};

export const APPRAISAL_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'appraisal.submitted': toReviewer('APPRAISAL_RATING_ASSIGNED', false),
  'appraisal.review_assigned': toReviewer('APPRAISAL_REVIEW_ASSIGNED', true),
  'appraisal.returned': toEmployee('APPRAISAL_RETURNED'),
  'appraisal.completed': toEmployee('APPRAISAL_COMPLETED'),
  'appraisal.cancelled': toEmployee('APPRAISAL_CANCELLED'),
  'appraisal.task_cancelled': toFormerTaskHolder,
};
