// Hiring notification events (DF12): requisition submitted/assigned, decided, withdrawn and closed; budget revision
// submitted, decided and withdrawn; offer submitted, decided and withdrawn. Operational values only (codes, titles,
// counts, masters, dates and outcomes): never compensation, candidate private contacts, documents or decision
// reasons. A malformed payload reads as absent and describes nothing (never an error that would hold the outbox).
import type { Queryable } from '../../db/queryable.js';
import type { EventDescriber, ModuleOutboxEvent } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const revisionOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2_147_483_647 ? v : null);
/** The event's payload when it is a JSON object; anything else reads as an empty payload. */
const payloadOf = (ev: ModuleOutboxEvent): Record<string, unknown> =>
  typeof ev.payload === 'object' && ev.payload !== null && !Array.isArray(ev.payload) ? ev.payload : {};

const OUTCOMES: Record<string, string> = { APPROVED: 'approved', REJECTED: 'rejected', RETURNED: 'returned for changes' };
const STEP_LABELS: Record<number, string> = { 1: 'validation', 2: 'budget and headcount approval' };
const outcomeOf = (v: unknown): string | undefined => (typeof v === 'string' && Object.hasOwn(OUTCOMES, v) ? OUTCOMES[v] : undefined);

async function requisition(tx: Queryable, ev: ModuleOutboxEvent) {
  const requisitionId = id(payloadOf(ev).requisitionId);
  if (!requisitionId) return null;
  return (
    (
      await tx.query<{ code: string; title: string; vacancies: number; requester: string; transaction_id: string }>(
        `select code, title, vacancies, requesting_employee_id as requester, transaction_id from requisition where company_id = $1 and id = $2`,
        [ev.companyId, requisitionId],
      )
    ).rows[0] ?? null
  );
}

const requisitionSubmitted: EventDescriber = async (tx, ev) => {
  const p = payloadOf(ev);
  const r = await requisition(tx, ev);
  const taskId = id(p.taskId);
  if (!r || !taskId) return null;
  return {
    eventType: 'REQUISITION_SUBMITTED',
    subjectEmployeeId: r.requester,
    transactionId: r.transaction_id,
    transactionRevision: revisionOf(p.revision),
    taskId,
    beneficiaryUserId: null,
    data: { requisitionCode: r.code, title: r.title, vacancies: String(r.vacancies), stepLabel: STEP_LABELS[p.step === 2 ? 2 : 1]! },
  };
};

const requisitionDecided: EventDescriber = async (tx, ev) => {
  const p = payloadOf(ev);
  const r = await requisition(tx, ev);
  const outcome = outcomeOf(p.outcome);
  if (!r || !outcome) return null;
  return {
    eventType: 'REQUISITION_DECIDED',
    subjectEmployeeId: r.requester,
    transactionId: r.transaction_id,
    transactionRevision: revisionOf(p.revision),
    taskId: null,
    beneficiaryUserId: null,
    data: { requisitionCode: r.code, title: r.title, outcome },
  };
};

const requisitionWithdrawn: EventDescriber = async (tx, ev) => {
  const p = payloadOf(ev);
  const r = await requisition(tx, ev);
  const userId = id(p.userId);
  if (!r || !userId) return null;
  return {
    eventType: 'REQUISITION_WITHDRAWN',
    subjectEmployeeId: r.requester,
    transactionId: r.transaction_id,
    transactionRevision: revisionOf(p.revision),
    taskId: null,
    beneficiaryUserId: userId,
    data: { requisitionCode: r.code, title: r.title },
  };
};

// HR closed an approved requisition: its requester is told (DF12 "cancelled"); the closure reason never travels.
const requisitionClosed: EventDescriber = async (tx, ev) => {
  const r = await requisition(tx, ev);
  if (!r) return null;
  return {
    eventType: 'REQUISITION_CLOSED',
    subjectEmployeeId: r.requester,
    transactionId: r.transaction_id,
    transactionRevision: revisionOf(payloadOf(ev).revision),
    taskId: null,
    beneficiaryUserId: null,
    data: { requisitionCode: r.code, title: r.title },
  };
};

async function budgetRevision(tx: Queryable, ev: ModuleOutboxEvent) {
  const revisionId = id(payloadOf(ev).revisionId);
  if (!revisionId) return null;
  return (
    (
      await tx.query<{ transaction_id: string; revision: number; department: string; location: string; designation: string; period_start: string; period_end: string }>(
        `select br.transaction_id, br.revision, d.name as department, l.name as location, g.name as designation,
                to_char(b.period_start, 'YYYY-MM-DD') as period_start, to_char(b.period_end, 'YYYY-MM-DD') as period_end
           from manpower_budget_revision br
           join manpower_budget b on b.company_id = br.company_id and b.id = br.budget_id
           join department d on d.company_id = b.company_id and d.id = b.department_id
           join location l on l.company_id = b.company_id and l.id = b.location_id
           join designation g on g.company_id = b.company_id and g.id = b.designation_id
          where br.company_id = $1 and br.id = $2`,
        [ev.companyId, revisionId],
      )
    ).rows[0] ?? null
  );
}

const budgetData = (b: NonNullable<Awaited<ReturnType<typeof budgetRevision>>>) => ({
  departmentName: b.department,
  locationName: b.location,
  designationName: b.designation,
  periodStart: b.period_start,
  periodEnd: b.period_end,
});

// A budget revision's transaction is never resubmitted: it stays at transaction revision 1.
const budgetSubmitted: EventDescriber = async (tx, ev) => {
  const b = await budgetRevision(tx, ev);
  const taskId = id(payloadOf(ev).taskId);
  if (!b || !taskId) return null;
  return { eventType: 'BUDGET_REVISION_SUBMITTED', subjectEmployeeId: null, transactionId: b.transaction_id, transactionRevision: 1, taskId, beneficiaryUserId: null, data: budgetData(b) };
};

const budgetDecided: EventDescriber = async (tx, ev) => {
  const p = payloadOf(ev);
  const b = await budgetRevision(tx, ev);
  const userId = id(p.userId);
  const outcome = outcomeOf(p.outcome);
  if (!b || !userId || !outcome) return null;
  return {
    eventType: 'BUDGET_REVISION_DECIDED',
    subjectEmployeeId: null,
    transactionId: b.transaction_id,
    transactionRevision: 1,
    taskId: null,
    beneficiaryUserId: userId,
    data: { ...budgetData(b), outcome },
  };
};

const budgetWithdrawn: EventDescriber = async (tx, ev) => {
  const b = await budgetRevision(tx, ev);
  const userId = id(payloadOf(ev).userId);
  if (!b || !userId) return null;
  return { eventType: 'BUDGET_REVISION_WITHDRAWN', subjectEmployeeId: null, transactionId: b.transaction_id, transactionRevision: 1, taskId: null, beneficiaryUserId: userId, data: budgetData(b) };
};

async function offer(tx: Queryable, ev: ModuleOutboxEvent) {
  const offerId = id(payloadOf(ev).offerId);
  if (!offerId) return null;
  return (
    (
      await tx.query<{ transaction_id: string; requisition_code: string; candidate_code: string }>(
        `select o.transaction_id, r.code as requisition_code, c.candidate_code
           from hiring_offer o join requisition r on r.company_id = o.company_id and r.id = o.requisition_id
           join candidate c on c.company_id = o.company_id and c.id = o.candidate_id
          where o.company_id = $1 and o.id = $2`,
        [ev.companyId, offerId],
      )
    ).rows[0] ?? null
  );
}

const offerSubmitted: EventDescriber = async (tx, ev) => {
  const p = payloadOf(ev);
  const o = await offer(tx, ev);
  const taskId = id(p.taskId);
  if (!o || !taskId) return null;
  return {
    eventType: 'OFFER_SUBMITTED',
    subjectEmployeeId: null,
    transactionId: o.transaction_id,
    transactionRevision: revisionOf(p.revision),
    taskId,
    beneficiaryUserId: null,
    data: { candidateCode: o.candidate_code, requisitionCode: o.requisition_code },
  };
};

const offerDecided: EventDescriber = async (tx, ev) => {
  const p = payloadOf(ev);
  const o = await offer(tx, ev);
  const userId = id(p.userId);
  const outcome = outcomeOf(p.outcome);
  if (!o || !userId || !outcome) return null;
  return {
    eventType: 'OFFER_DECIDED',
    subjectEmployeeId: null,
    transactionId: o.transaction_id,
    transactionRevision: revisionOf(p.revision),
    taskId: null,
    beneficiaryUserId: userId,
    data: { candidateCode: o.candidate_code, requisitionCode: o.requisition_code, outcome },
  };
};

const offerWithdrawn: EventDescriber = async (tx, ev) => {
  const p = payloadOf(ev);
  const o = await offer(tx, ev);
  const userId = id(p.userId);
  if (!o || !userId) return null;
  return {
    eventType: 'OFFER_WITHDRAWN',
    subjectEmployeeId: null,
    transactionId: o.transaction_id,
    transactionRevision: revisionOf(p.revision),
    taskId: null,
    beneficiaryUserId: userId,
    data: { candidateCode: o.candidate_code, requisitionCode: o.requisition_code },
  };
};

export const HIRING_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'hiring.requisition.submitted': requisitionSubmitted,
  'hiring.requisition.decided': requisitionDecided,
  'hiring.requisition.withdrawn': requisitionWithdrawn,
  'hiring.requisition.closed': requisitionClosed,
  'hiring.budget_revision.submitted': budgetSubmitted,
  'hiring.budget_revision.decided': budgetDecided,
  'hiring.budget_revision.withdrawn': budgetWithdrawn,
  'hiring.offer.submitted': offerSubmitted,
  'hiring.offer.decided': offerDecided,
  'hiring.offer.withdrawn': offerWithdrawn,
};
