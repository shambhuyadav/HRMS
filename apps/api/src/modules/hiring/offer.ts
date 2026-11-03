// Offers (F1 hiring: "an offer requires approved requisition and independent eligible Admin approval for confidential
// compensation"; FR-014 accepted offer).
//
// A recruiter or HR prepares the offer's operational terms on an application at the OFFER stage of an APPROVED
// requisition. The compensation is a confidential group (offer.compensation): only an eligible Admin assignment
// holding the grant records or reads it. Submission pins an immutable revision (terms and compensation) and routes
// it to an eligible Admin from the explicit list who is neither the preparer, the compensation preparer nor the
// submitter (C4). Approve, reject (final) or return (back to DRAFT; the next submission is a new revision). The
// candidate's response is recorded on an approved offer; acceptance needs the requisition still approved and an
// open vacancy. Audit records and events carry states and identifiers only, never compensation values.
import { enqueueEvent } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { cancelActiveApproval, type Decision, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import { lockApplication } from './application.js';
import {
  assertConvertible,
  audit,
  checkVersion,
  decisionHistory,
  isPendingTaskOf,
  lockRequisition,
  newTransaction,
  type Paging,
  pageOf,
  pendingTaskOf,
  pendingWith,
  personSql,
  priorDecisionTask,
  requireDate,
  requireText,
  setRootState,
  taskTransaction,
} from './common.js';
import { canAccessRequisition, requisitionScope, reviewersOutsideScope } from './scope.js';

export const OFFER_KIND = 'hiring_offer';

const AMOUNT = /^\d{1,15}(\.\d{1,4})?$/;

interface OfferRow {
  id: string;
  application_id: string;
  requisition_id: string;
  candidate_id: string;
  transaction_id: string;
  proposed_joining_date: string;
  state: string;
  current_revision: number;
  prepared_by: string;
  submitted_by: string | null;
  version: number;
  requisition_state: string;
  vacancies: number;
  application_stage: string;
  candidate_state: string;
}

const OFFER_COLUMNS = `o.id, o.application_id, o.requisition_id, o.candidate_id, o.transaction_id, to_char(o.proposed_joining_date, 'YYYY-MM-DD') as proposed_joining_date,
  o.state, o.current_revision, o.prepared_by, o.submitted_by, o.version, r.state as requisition_state, r.vacancies, a.stage as application_stage, c.state as candidate_state`;
const OFFER_FROM = `hiring_offer o join requisition r on r.company_id = o.company_id and r.id = o.requisition_id
  join application a on a.company_id = o.company_id and a.id = o.application_id join candidate c on c.company_id = o.company_id and c.id = o.candidate_id`;

/** An offer in scope (through its requisition), locked behind its transaction lock; outside scope it reads as missing. */
export async function lockOffer(tx: Queryable, grant: AccessGrant, offerId: string, alsoLockRequisition = false): Promise<OfferRow> {
  const target = (await tx.query<{ transaction_id: string; requisition_id: string }>(`select transaction_id, requisition_id from hiring_offer where company_id = $1 and id = $2`, [grant.companyId, offerId])).rows[0];
  if (!target || !(await canAccessRequisition(tx, grant, target.requisition_id))) throw notFound();
  await lockTransaction(tx, target.transaction_id);
  if (alsoLockRequisition) await lockRequisition(tx, grant.companyId, target.requisition_id);
  return (await tx.query<OfferRow>(`select ${OFFER_COLUMNS} from ${OFFER_FROM} where o.company_id = $1 and o.id = $2 for update of o`, [grant.companyId, offerId])).rows[0]!;
}

export async function createOffer(tx: Queryable, grant: AccessGrant, applicationId: string, input: { proposedJoiningDate: string }): Promise<string> {
  const a = await lockApplication(tx, grant, applicationId);
  if (a.stage !== 'OFFER') throw new HttpError(409, 'INVALID_STATE', 'Move the application to the OFFER stage first');
  // Share-locked, as a new application does: a concurrent closure either sees this offer or closes first.
  const requisition = (await tx.query<{ state: string }>(`select state from requisition where company_id = $1 and id = $2 for share`, [grant.companyId, a.requisition_id])).rows[0]!;
  if (requisition.state !== 'APPROVED') throw new HttpError(409, 'REQUISITION_NOT_APPROVED', 'An offer needs an approved requisition');
  if (a.candidate_state !== 'ACTIVE') throw new HttpError(409, 'CANDIDATE_NOT_ACTIVE', 'The candidate record is not active');
  const live = await tx.query(`select 1 from hiring_offer where company_id = $1 and application_id = $2 and state in ('DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED')`, [grant.companyId, a.id]);
  if (live.rowCount) throw new HttpError(409, 'OFFER_EXISTS', 'This application already has an open offer');
  const joining = requireDate(input.proposedJoiningDate, 'proposedJoiningDate');
  const transactionId = await newTransaction(tx, grant.companyId, OFFER_KIND, null, grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into hiring_offer (company_id, application_id, requisition_id, candidate_id, transaction_id, proposed_joining_date, state, prepared_by, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'DRAFT', $7, $7, $7) returning id`,
      [grant.companyId, a.id, a.requisition_id, a.candidate_id, transactionId, joining, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, grant, 'hiring_offer', id, 'CREATE', null, { applicationId: a.id, requisitionId: a.requisition_id, proposedJoiningDate: joining, state: 'DRAFT' });
  return id;
}

export async function updateOffer(tx: Queryable, grant: AccessGrant, offerId: string, input: { proposedJoiningDate: string; expectedVersion: number }) {
  const o = await lockOffer(tx, grant, offerId);
  if (o.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft offer can be changed');
  checkVersion(o.version, input.expectedVersion);
  const joining = requireDate(input.proposedJoiningDate, 'proposedJoiningDate');
  const version = (
    await tx.query<{ version: number }>(`update hiring_offer set proposed_joining_date = $3, updated_by = $4 where company_id = $1 and id = $2 returning version`, [grant.companyId, o.id, joining, grant.userId])
  ).rows[0]!.version;
  await audit(tx, grant, 'hiring_offer', o.id, 'UPDATE', { proposedJoiningDate: o.proposed_joining_date }, { proposedJoiningDate: joining });
  return { offerId: o.id, version };
}

export interface CompensationInput {
  currencyCode: string;
  annualCtc?: string | undefined;
  monthlyGross?: string | undefined;
  expectedVersion: number;
}

/** Records the confidential compensation of a draft offer. Audit carries the field names only. */
export async function setCompensation(tx: Queryable, grant: AccessGrant, offerId: string, input: CompensationInput) {
  const o = await lockOffer(tx, grant, offerId);
  if (o.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Compensation changes only while the offer is a draft');
  checkVersion(o.version, input.expectedVersion);
  const amounts = { annualCtc: input.annualCtc ?? null, monthlyGross: input.monthlyGross ?? null };
  if (amounts.annualCtc === null && amounts.monthlyGross === null) throw new HttpError(422, 'COMPENSATION_REQUIRED', 'Give the annual CTC, the monthly gross or both');
  for (const [field, value] of Object.entries(amounts)) {
    if (value !== null && !AMOUNT.test(value)) throw new HttpError(422, 'INVALID_AMOUNT', 'Amounts are non-negative decimals with up to 4 decimal places', { field });
  }
  // Confidential money values: the compensation grant is checked again after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'offer', 'manage', ['compensation']);
  await tx.query(
    `insert into hiring_offer_compensation (company_id, offer_id, currency_code, annual_ctc, monthly_gross, set_by, created_by, updated_by)
     values ($1, $2, $3, $4::numeric, $5::numeric, $6, $6, $6)
     on conflict (company_id, offer_id) do update set currency_code = excluded.currency_code, annual_ctc = excluded.annual_ctc, monthly_gross = excluded.monthly_gross,
        set_by = excluded.set_by, updated_by = excluded.updated_by`,
    [grant.companyId, o.id, input.currencyCode, amounts.annualCtc, amounts.monthlyGross, grant.userId],
  );
  // The offer's version moves with its compensation, so a submission always sees what its submitter saw.
  const version = (await tx.query<{ version: number }>(`update hiring_offer set updated_by = $3 where company_id = $1 and id = $2 returning version`, [grant.companyId, o.id, grant.userId])).rows[0]!.version;
  await audit(tx, grant, 'hiring_offer', o.id, 'SET_COMPENSATION', null, { compensationFields: ['currencyCode', ...Object.entries(amounts).filter(([, v]) => v !== null).map(([k]) => k)] });
  return { offerId: o.id, version };
}

export async function submitOffer(tx: Queryable, grant: AccessGrant, offerId: string, input: { expectedVersion: number }) {
  const o = await lockOffer(tx, grant, offerId);
  if (o.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft offer can be submitted');
  checkVersion(o.version, input.expectedVersion);
  if (o.requisition_state !== 'APPROVED') throw new HttpError(409, 'REQUISITION_NOT_APPROVED', 'An offer needs an approved requisition');
  if (o.application_stage !== 'OFFER') throw new HttpError(409, 'INVALID_STATE', 'The application is no longer at the OFFER stage');
  if (o.candidate_state !== 'ACTIVE') throw new HttpError(409, 'CANDIDATE_NOT_ACTIVE', 'The candidate record is not active');
  const comp = (await tx.query<{ set_by: string }>(`select set_by from hiring_offer_compensation where company_id = $1 and offer_id = $2`, [grant.companyId, o.id])).rows[0];
  if (!comp) throw new HttpError(422, 'COMPENSATION_REQUIRED', 'An eligible Admin must record the compensation before the offer is submitted');
  const revision = o.current_revision + 1;
  await tx.query(`update business_transaction set revision = greatest(revision, $3), state = 'SUBMITTED', updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    o.transaction_id,
    revision,
    grant.userId,
  ]);
  await tx.query(
    `insert into hiring_offer_revision (company_id, offer_id, revision, proposed_joining_date, currency_code, annual_ctc, monthly_gross, compensation_set_by, submitted_by, created_by)
     select o.company_id, o.id, $3::int, o.proposed_joining_date, k.currency_code, k.annual_ctc, k.monthly_gross, k.set_by, $4::uuid, $4::uuid
       from hiring_offer o join hiring_offer_compensation k on k.company_id = o.company_id and k.offer_id = o.id
      where o.company_id = $1 and o.id = $2`,
    [grant.companyId, o.id, revision, grant.userId],
  );
  await tx.query(
    `update hiring_offer set state = 'SUBMITTED', current_revision = $3, submitted_by = $4, submitted_at = now(), compensation_set_by = $5, updated_by = $4
      where company_id = $1 and id = $2`,
    [grant.companyId, o.id, revision, grant.userId, comp.set_by],
  );
  // F1/C4: an independent eligible Admin approves; preparer, compensation preparer and submitter are excluded, and so
  // is anyone whose scope does not reach this requisition (an offer has no employee for the engine to check, I-25).
  const outsideScope = await reviewersOutsideScope(tx, grant.companyId, OFFER_KIND, (g) => canAccessRequisition(tx, g, o.requisition_id));
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: OFFER_KIND,
    transactionId: o.transaction_id,
    ownerEmployeeId: null,
    actorUserId: grant.userId,
    excludeUserIds: [...new Set([o.prepared_by, comp.set_by, grant.userId, ...outsideScope])],
  });
  await audit(tx, grant, 'hiring_offer', o.id, o.current_revision > 0 ? 'RESUBMIT' : 'SUBMIT', { state: 'DRAFT' }, { state: 'SUBMITTED', revision, proposedJoiningDate: o.proposed_joining_date });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'hiring.offer.submitted',
    aggregateId: o.id,
    dedupeKey: `hiring.offer.submitted:${o.id}:${revision}`,
    payload: { offerId: o.id, taskId, revision },
  });
  return { offerId: o.id, state: 'SUBMITTED', revision };
}

export interface OfferDecisionInput {
  decision: Decision;
  reason?: string | undefined;
  idempotencyKey: string;
}

export async function decideOffer(tx: Queryable, grant: AccessGrant, taskId: string, input: OfferDecisionInput) {
  if (input.decision !== 'APPROVE' && !input.reason?.trim()) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the offer is rejected or returned');
  const transactionId = await taskTransaction(tx, grant.companyId, taskId, grant.userId, OFFER_KIND);
  if (!transactionId) throw notFound();
  await lockTransaction(tx, transactionId);
  const target = (await tx.query<{ id: string; requisition_id: string }>(`select id, requisition_id from hiring_offer where company_id = $1 and transaction_id = $2`, [grant.companyId, transactionId])).rows[0];
  if (!target || !(await canAccessRequisition(tx, grant, target.requisition_id))) throw notFound();
  const o = (await tx.query<OfferRow>(`select ${OFFER_COLUMNS} from ${OFFER_FROM} where o.company_id = $1 and o.id = $2 for update of o`, [grant.companyId, target.id])).rows[0]!;
  const prior = await priorDecisionTask(tx, grant.companyId, input.idempotencyKey);
  if (prior) {
    if (prior !== taskId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another task');
    return { offerId: o.id, state: o.state, replayed: true };
  }
  if (!(await isPendingTaskOf(tx, grant.companyId, taskId, grant.userId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (o.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This offer is not waiting for a decision');
  if (input.decision === 'APPROVE' && o.requisition_state !== 'APPROVED') throw new HttpError(409, 'REQUISITION_NOT_APPROVED', 'The requisition is no longer approved; reject or return the offer');

  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'offer', action: 'approve' } });
  if (result.replayed) return { offerId: o.id, state: o.state, replayed: true };
  const state = result.outcome === 'APPROVED' ? 'APPROVED' : result.outcome === 'REJECTED' ? 'REJECTED' : 'DRAFT';
  if (state === 'DRAFT') await setRootState(tx, 'hiring_offer', grant.companyId, o, 'DRAFT', grant.userId);
  else await setRootState(tx, 'hiring_offer', grant.companyId, o, state, grant.userId, ', decided_by = $4, decided_at = now()');
  await audit(tx, grant, 'hiring_offer', o.id, input.decision, { state: 'SUBMITTED', revision: o.current_revision }, { state }, input.reason ?? null);
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'hiring.offer.decided',
    aggregateId: o.id,
    dedupeKey: `hiring.offer.decided:${o.id}:${o.current_revision}`,
    payload: { offerId: o.id, outcome: result.outcome, revision: o.current_revision, userId: o.submitted_by },
  });
  return { offerId: o.id, state, replayed: false };
}

export async function recordResponse(tx: Queryable, grant: AccessGrant, offerId: string, input: { response: 'ACCEPTED' | 'DECLINED'; respondedOn: string; expectedVersion: number }) {
  // Acceptance counts vacancies: serialise with other acceptances and with closure of the requisition.
  const o = await lockOffer(tx, grant, offerId, true);
  if (o.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only an approved offer can be accepted or declined');
  checkVersion(o.version, input.expectedVersion);
  const respondedOn = requireDate(input.respondedOn, 'respondedOn');
  if (respondedOn > grant.businessDate) throw new HttpError(422, 'INVALID_DATE', 'The response date cannot be in the future', { field: 'respondedOn' });
  if (input.response === 'ACCEPTED') {
    // FR-012: only an approved requisition accepts final placement, and never beyond its vacancies.
    if (o.requisition_state !== 'APPROVED') throw new HttpError(409, 'REQUISITION_NOT_APPROVED', 'The requisition is no longer approved');
    if (o.application_stage !== 'OFFER') throw new HttpError(409, 'INVALID_STATE', 'The application is no longer at the OFFER stage');
    // FR-014, FR-013: one person converts once at a time, whichever requisition or duplicate record the offer is on.
    await assertConvertible(tx, grant.companyId, o.candidate_id, o.id);
    const accepted = (
      await tx.query<{ n: number }>(`select count(*)::int as n from hiring_offer where company_id = $1 and requisition_id = $2 and state = 'ACCEPTED' and id <> $3`, [grant.companyId, o.requisition_id, o.id])
    ).rows[0]!.n;
    if (accepted >= o.vacancies) throw new HttpError(409, 'NO_OPEN_VACANCY', 'Every vacancy of this requisition already has an accepted offer', { vacancies: o.vacancies, accepted });
  }
  // The recorded response settles the offer (an acceptance takes a vacancy): the duty is checked again after the locks.
  await reassertAccess(tx, grant, 'offer', 'manage', ['operational']);
  await setRootState(tx, 'hiring_offer', grant.companyId, o, input.response, grant.userId, ', candidate_response_on = $5, response_recorded_by = $4', [respondedOn]);
  await audit(tx, grant, 'hiring_offer', o.id, input.response === 'ACCEPTED' ? 'ACCEPT' : 'DECLINE', { state: 'APPROVED' }, { state: input.response, respondedOn });
  return { offerId: o.id, state: input.response };
}

export async function withdrawOffer(tx: Queryable, grant: AccessGrant, offerId: string, input: { reason: string }) {
  const o = await lockOffer(tx, grant, offerId);
  if (!['DRAFT', 'SUBMITTED', 'APPROVED', 'ACCEPTED'].includes(o.state)) throw new HttpError(409, 'INVALID_STATE', `The offer is already ${o.state}`);
  const handedOver = await tx.query(`select 1 from hiring_handover where company_id = $1 and offer_id = $2`, [grant.companyId, o.id]);
  if (handedOver.rowCount) throw new HttpError(409, 'ALREADY_HANDED_OVER', 'The offer has been handed over to onboarding');
  const reason = requireText(input.reason, 'reason');
  // Withdrawal cancels an approval in flight or an approved offer: the duty is checked again after the locks.
  await reassertAccess(tx, grant, 'offer', 'manage', ['operational']);
  const pending = o.state === 'SUBMITTED' ? await pendingTaskOf(tx, grant.companyId, o.transaction_id) : undefined;
  if (o.state === 'SUBMITTED') await cancelActiveApproval(tx, grant.companyId, o.transaction_id, grant.userId);
  await setRootState(tx, 'hiring_offer', grant.companyId, o, 'WITHDRAWN', grant.userId, ', withdrawn_reason = $5, withdrawn_by = $4, withdrawn_at = now()', [reason]);
  await audit(tx, grant, 'hiring_offer', o.id, 'WITHDRAW', { state: o.state }, { state: 'WITHDRAWN' }, reason);
  // DF12: the approver whose task was cancelled is told that no decision is needed (never the reason).
  if (pending) {
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'hiring.offer.withdrawn',
      aggregateId: o.id,
      dedupeKey: `hiring.offer.withdrawn:${o.id}:${o.current_revision}`,
      payload: { offerId: o.id, userId: pending.assignee_user_id, revision: o.current_revision },
    });
  }
  return { offerId: o.id, state: 'WITHDRAWN' };
}

// ---------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------

const VIEW_SELECT = `select o.id, o.state, to_char(o.proposed_joining_date, 'YYYY-MM-DD') as "proposedJoiningDate", o.current_revision as "currentRevision",
       json_build_object('id', a.id, 'stage', a.stage) as application,
       json_build_object('id', r.id, 'code', r.code, 'title', r.title, 'state', r.state) as requisition,
       json_build_object('id', c.id, 'candidateCode', c.candidate_code, 'fullName', c.full_name) as candidate,
       o.prepared_by as "preparedBy", ${personSql('o.company_id', 'o.prepared_by', 'o.created_at')} as "preparedByPerson",
       o.submitted_by as "submittedBy", ${personSql('o.company_id', 'o.submitted_by', 'o.submitted_at')} as "submittedByPerson", o.submitted_at as "submittedAt",
       o.decided_by as "decidedBy", ${personSql('o.company_id', 'o.decided_by', 'o.decided_at')} as "decidedByPerson", o.decided_at as "decidedAt",
       to_char(o.candidate_response_on, 'YYYY-MM-DD') as "candidateResponseOn", o.withdrawn_reason as "withdrawnReason", o.withdrawn_at as "withdrawnAt",
       (select h.employee_id from hiring_handover h where h.company_id = o.company_id and h.offer_id = o.id) as "handedOverEmployeeId",
       o.created_at as "createdAt", o.version, o.transaction_id
  from hiring_offer o
  join application a on a.company_id = o.company_id and a.id = o.application_id
  join requisition r on r.company_id = o.company_id and r.id = o.requisition_id
  join candidate c on c.company_id = o.company_id and c.id = o.candidate_id`;

async function compensationOf(db: Queryable, companyId: string, offerId: string) {
  const current = (
    await db.query(
      `select k.currency_code as "currencyCode", k.annual_ctc as "annualCtc", k.monthly_gross as "monthlyGross", k.set_by as "setBy",
              ${personSql('k.company_id', 'k.set_by', 'k.updated_at')} as "setByPerson", k.updated_at as "updatedAt"
         from hiring_offer_compensation k where k.company_id = $1 and k.offer_id = $2`,
      [companyId, offerId],
    )
  ).rows[0];
  const revisions = (
    await db.query(
      `select v.revision, to_char(v.proposed_joining_date, 'YYYY-MM-DD') as "proposedJoiningDate", v.currency_code as "currencyCode", v.annual_ctc as "annualCtc",
              v.monthly_gross as "monthlyGross", v.compensation_set_by as "compensationSetBy",
              ${personSql('v.company_id', 'v.compensation_set_by', 'v.submitted_at')} as "compensationSetByPerson",
              v.submitted_by as "submittedBy", ${personSql('v.company_id', 'v.submitted_by', 'v.submitted_at')} as "submittedByPerson", v.submitted_at as "submittedAt"
         from hiring_offer_revision v where v.company_id = $1 and v.offer_id = $2 order by v.revision`,
      [companyId, offerId],
    )
  ).rows;
  return { current: current ?? null, revisions };
}

/** Operational view; the compensation appears only for a caller holding the confidential group (absent, not masked). */
export async function getOffer(db: Queryable, grant: AccessGrant, offerId: string) {
  const p = new SqlParams([offerId]);
  const row = (await db.query<{ transaction_id: string }>(`${VIEW_SELECT} where o.id = $1 and ${requisitionScope(grant, 'r', p)}`, p.values)).rows[0];
  if (!row) return null;
  const { transaction_id: transactionId, ...view } = row;
  const out: Record<string, unknown> = {
    ...view,
    decisions: (await decisionHistory(db, grant.companyId, transactionId)).map((d) => ({ ...d, reason: grant.allowedFieldGroups.includes('compensation') ? d.reason : undefined })),
    pendingWith: await pendingWith(db, grant.companyId, transactionId),
  };
  if (grant.allowedFieldGroups.includes('compensation')) out.compensation = await compensationOf(db, grant.companyId, offerId);
  return out;
}

/** Without page or pageSize the list answers its latest 500 offers, as before paging; `total` counts them all. */
export const OFFER_LIST_CAP = 500;

export async function listOffers(db: Queryable, grant: AccessGrant, q: { requisitionId?: string | undefined; state?: string | undefined } & Paging) {
  const p = new SqlParams();
  const where = [requisitionScope(grant, 'r', p)];
  if (q.requisitionId) where.push(`o.requisition_id = ${p.add(q.requisitionId)}::uuid`);
  if (q.state) where.push(`o.state = ${p.add(q.state)}`);
  const page = await pageOf(db, `${VIEW_SELECT} where ${where.join(' and ')}`, p.values, `"createdAt" desc, id`, q, OFFER_LIST_CAP);
  return { ...page, items: page.items.map(({ transaction_id: _t, ...r }) => r) };
}

/** The approver's queue: each offer with the terms and compensation of the revision under review. */
export async function offerTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, OFFER_KIND)).items as { taskId: string; transactionId: string; assignedAt: Date }[];
  const items = [];
  for (const t of tasks) {
    const p = new SqlParams([t.transactionId]);
    const row = (await db.query<{ id: string; currentRevision: number; transaction_id: string }>(`${VIEW_SELECT} where o.transaction_id = $1 and ${requisitionScope(grant, 'r', p)}`, p.values)).rows[0];
    if (!row) {
      items.push({ taskId: t.taskId, transactionId: t.transactionId, assignedAt: t.assignedAt, offer: null });
      continue;
    }
    const { transaction_id: _t, ...view } = row;
    const revision = (
      await db.query(
        `select revision, to_char(proposed_joining_date, 'YYYY-MM-DD') as "proposedJoiningDate", currency_code as "currencyCode", annual_ctc as "annualCtc",
                monthly_gross as "monthlyGross", submitted_at as "submittedAt"
           from hiring_offer_revision where company_id = $1 and offer_id = $2 and revision = $3`,
        [grant.companyId, row.id, row.currentRevision],
      )
    ).rows[0];
    items.push({ taskId: t.taskId, transactionId: t.transactionId, assignedAt: t.assignedAt, offer: { ...view, underReview: revision ?? null } });
  }
  return { items };
}
