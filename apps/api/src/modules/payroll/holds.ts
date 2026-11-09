// Salary holds (FR-101; DB110; H2 hold cases and hold criteria; H4 hold fields; BR-050; BR-051; CI27 hold part; ZT38).
//
// A hold withholds payment of a processed payroll record; it never changes, recalculates or erases the record (the
// liability stays as frozen). Three kinds:
//   * PAYMENT_SAFETY_BLOCK  automatic, placed by processing on a payable record without a verified approved bank
//     instruction (missing, invalid or unverified), in the same transaction that freezes the record. Earned salary
//     stays payable: an independent eligible Admin releases it against a valid approved bank revision, which the
//     release records (for a revision that did not come through the approved bank-change workflow, the release is
//     the Admin's verification of it, H2). The approver of that bank change does not also release payment against it.
//   * POLICY_HOLD           proposed by a maker under an ACTIVE, validated hold criterion (contractual or
//     legal/disciplinary; none is active by default, and it must still be active when the hold is approved) with
//     released and verified evidence documents, decided by an
//     independent eligible Admin (never the maker, never the beneficiary, never the creator, preparer, reviewer or
//     approver of the run, who also never release its holds: C4, H4). Partial holds only where the criterion
//     allows them; the amount is > 0 and within the record's unpaid, unreserved entitlement (net minus live holds;
//     the payment ledger's reservations join this once built).
//   * SALARY_STOP           an approved HOLD_DISBURSEMENT salary stop, applied by processing as an active full hold.
// States: PROPOSED -> APPROVED_ACTIVE -> RELEASED or EXPIRED_REVIEW (renewable by an independent decision); REJECTED
// and WITHDRAWN never block. Review cadence (H2): daily reminders while unresolved, first escalation after 2 business
// days, then every 5 business days; expiry alerts reviewers and pays, forgives or deletes nothing.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { cancelActiveApproval, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import { bankChecks, bankRevisionApprovers } from './bank.js';
import {
  type Actor,
  actorOf,
  addDays,
  advisoryLock,
  assertInScope,
  assertNotSelf,
  attachEvidence,
  audit,
  checkAmount,
  emit,
  emitOnce,
  evidenceOf,
  newTransaction,
  optionalKey,
  pendingTaskOf,
  priorDecision,
  requireActiveCriterion,
  requireCompanyScope,
  requireDate,
  requireText,
  requireVerifiedEvidence,
  setRootState,
  taskIsPending,
  taskTransaction,
  userIsEmployee,
} from './common.js';

export const HOLD_KIND = 'payroll_hold';
const LIVE = ['PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW'];
/** H2 selected defaults: first escalation after 2 business days, then every 5 business days while unresolved. */
export const FIRST_ESCALATION_BUSINESS_DAYS = 2;
export const ESCALATION_INTERVAL_BUSINESS_DAYS = 5;
/** Holds handled per review-job transaction (an engineering bound, not a business rule). */
const REVIEW_PAGE = 200;
const SAFETY_POLICY = 'H2_BANK_SAFETY';
const SAFETY_RELEASE = 'A valid approved bank revision of the employee is verified and an independent eligible administrator releases the payment';

function stale(): never {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
}

/**
 * docs/09 §6.5 / I-25: every hold action that does not go through decideTask (criteria, proposals, withdrawals,
 * releases, review renewals) re-resolves its permission inside its own transaction after its locks, so authority
 * narrowed since the route guard refuses the action and records nothing.
 */
const reassertHold = (tx: Queryable, grant: AccessGrant, action: 'propose' | 'decide' | 'release' | 'define_criterion' | 'activate_criterion') =>
  reassertAccess(tx, grant, 'payroll_hold', action, ['hold']);

// ---------------------------------------------------------------------------------------------------------------
// Hold criteria (H2: disabled until the company activates a validated criterion)
// ---------------------------------------------------------------------------------------------------------------

const CRITERION_VIEW = `select id, code, revision, category, applicability, scope_mode as "scopeMode", max_review_days as "maxReviewDays",
    evidence_reference as "evidenceReference", validation_reference as "validationReference", state, created_by as "createdBy",
    activated_by as "activatedBy", activated_at as "activatedAt", retired_at as "retiredAt", version
  from payroll_hold_criterion`;

export async function listCriteria(db: Queryable, grant: AccessGrant) {
  return { items: (await db.query(`${CRITERION_VIEW} where company_id = $1 order by code, revision`, [grant.companyId])).rows };
}

export interface CriterionInput {
  code: string;
  category: 'CONTRACTUAL' | 'LEGAL_DISCIPLINARY';
  applicability: string;
  scopeMode: 'FULL_ONLY' | 'FULL_OR_PARTIAL';
  maxReviewDays: number;
  evidenceReference: string;
  validationReference: string;
}

const RESERVED_CODES = ['MISSING_TIMESHEET', 'TIMESHEET', 'TIMESHEET_MISSING', 'INPUT_DISCREPANCY', 'SEPARATION', 'INACTIVITY', 'BANK_MISSING', 'BANK_INVALID', 'BANK_UNVERIFIED'];

export async function createCriterion(tx: Queryable, grant: AccessGrant, input: CriterionInput) {
  requireCompanyScope(grant);
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(code)) throw new HttpError(422, 'INVALID_CODE', 'A criterion code is upper-case letters, digits and underscores');
  // H2/BR-049: a missing timesheet, an input discrepancy or a separation is never a hold; bank problems are the
  // automatic safety block.
  if (RESERVED_CODES.includes(code)) throw new HttpError(422, 'NOT_A_HOLD_CRITERION', 'This situation is never a salary hold criterion (H2)');
  await advisoryLock(tx, `payroll_hold_criterion:${grant.companyId}:${code}`);
  await reassertHold(tx, grant, 'define_criterion');
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_hold_criterion (company_id, code, revision, category, applicability, scope_mode, max_review_days, evidence_reference,
                                           validation_reference, state, created_by, updated_by)
       select $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6, $7, $8, 'DRAFT', $9, $9 from payroll_hold_criterion where company_id = $1 and code = $2
       returning id`,
      [
        grant.companyId,
        code,
        input.category,
        requireText(input.applicability, 'applicability', 2000, 'APPLICABILITY_REQUIRED'),
        input.scopeMode,
        input.maxReviewDays,
        requireText(input.evidenceReference, 'evidence reference', 500, 'EVIDENCE_REQUIRED'),
        requireText(input.validationReference, 'validation reference', 500, 'VALIDATION_REQUIRED'),
        grant.userId,
      ],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_hold_criterion', id, 'CREATE', null, {
    operational: { code, category: input.category, scopeMode: input.scopeMode, maxReviewDays: input.maxReviewDays },
  });
  return (await tx.query(`${CRITERION_VIEW} where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
}

export async function activateCriterion(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  requireCompanyScope(grant);
  const c = (
    await tx.query<{ code: string; state: string; created_by: string | null; version: number }>(
      `select code, state, created_by, version from payroll_hold_criterion where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!c) throw notFound();
  if (c.version !== input.expectedVersion) stale();
  if (c.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft criterion can be activated');
  if (c.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A hold criterion is activated by someone other than its author');
  await advisoryLock(tx, `payroll_hold_criterion:${grant.companyId}:${c.code}`);
  await reassertHold(tx, grant, 'activate_criterion');
  // A new revision replaces the active one of the same code; holds keep the revision they were decided under.
  await tx.query(
    `update payroll_hold_criterion set state = 'RETIRED', retired_by = $3, retired_at = now(), updated_by = $3 where company_id = $1 and code = $2 and state = 'ACTIVE'`,
    [grant.companyId, c.code, grant.userId],
  );
  await tx.query(`update payroll_hold_criterion set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    grant.userId,
  ]);
  await audit(tx, actorOf(grant), 'payroll_hold_criterion', id, 'ACTIVATE', { operational: { state: 'DRAFT' } }, { operational: { state: 'ACTIVE', code: c.code } });
  return (await tx.query(`${CRITERION_VIEW} where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
}

export async function retireCriterion(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number; reason: string }) {
  requireCompanyScope(grant);
  const c = (
    await tx.query<{ state: string; version: number }>(`select state, version from payroll_hold_criterion where company_id = $1 and id = $2 for update`, [grant.companyId, id])
  ).rows[0];
  if (!c) throw notFound();
  await reassertHold(tx, grant, 'activate_criterion');
  if (c.version !== input.expectedVersion) stale();
  if (c.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'Only an active criterion can be retired');
  const reason = requireText(input.reason, 'reason', 1000);
  await tx.query(`update payroll_hold_criterion set state = 'RETIRED', retired_by = $3, retired_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    grant.userId,
  ]);
  await audit(tx, actorOf(grant), 'payroll_hold_criterion', id, 'RETIRE', { operational: { state: 'ACTIVE' } }, { operational: { state: 'RETIRED' } }, reason);
  return (await tx.query(`${CRITERION_VIEW} where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
}

// ---------------------------------------------------------------------------------------------------------------
// Holds
// ---------------------------------------------------------------------------------------------------------------

interface HoldRow {
  id: string;
  employee_id: string;
  payroll_record_id: string;
  run_id: string;
  transaction_id: string;
  hold_kind: 'PAYMENT_SAFETY_BLOCK' | 'POLICY_HOLD' | 'SALARY_STOP';
  criterion_id: string | null;
  state: string;
  proposed_by: string;
  hold_amount: string;
  currency_code: string;
  review_due_on: string;
  version: number;
}

const HOLD_COLUMNS = `h.id, h.employee_id, h.payroll_record_id, h.run_id, h.transaction_id, h.hold_kind, h.criterion_id, h.state, h.proposed_by, h.hold_amount,
  h.currency_code, h.review_due_on, h.version`;

/**
 * The record's payable amount, live holds and unreserved remainder (computed in numeric). The payment ledger of the
 * payroll-outputs stage (0045: pending reservations plus net confirmed payments, hrms_payroll_payment_committed) is
 * not unreserved either (BR-050, CI27); it is zero until a manifest is authorised.
 */
export async function holdBalance(db: Queryable, companyId: string, recordId: string) {
  return (
    await db.query<{ payable: string | null; held: string; unreserved: string | null; currency_code: string }>(
      `select rec.net as payable, coalesce(sum(h.hold_amount) filter (where h.state = any($3::text[])), 0) as held,
              rec.net - coalesce(sum(h.hold_amount) filter (where h.state = any($3::text[])), 0) - hrms_payroll_payment_committed(rec.company_id, rec.id) as unreserved,
              rec.currency_code
         from payroll_record rec left join payroll_hold h on h.company_id = rec.company_id and h.payroll_record_id = rec.id
        where rec.company_id = $1 and rec.id = $2 group by rec.id`,
      [companyId, recordId, LIVE],
    )
  ).rows[0];
}

export interface HoldInput {
  criterionId: string;
  scope: 'FULL' | 'PARTIAL';
  amount?: string | undefined;
  reason: string;
  effectiveDate: string;
  reviewDueOn: string;
  releaseCriterion: string;
  evidenceReference: string;
  evidenceDocumentIds?: string[] | undefined;
  idempotencyKey?: string | undefined;
}

export async function proposeHold(tx: Queryable, grant: AccessGrant, recordId: string, input: HoldInput) {
  const rec = (
    await tx.query<{ id: string; employee_id: string; run_id: string; calculation_status: string; net: string | null; currency_code: string; run_state: string; minor: number }>(
      `select rec.id, rec.employee_id, rec.run_id, rec.calculation_status, rec.net, rec.currency_code, ru.state as run_state, ru.currency_minor_unit as minor
         from payroll_record rec join payroll_run ru on ru.company_id = rec.company_id and ru.id = rec.run_id where rec.company_id = $1 and rec.id = $2`,
      [grant.companyId, recordId],
    )
  ).rows[0];
  if (!rec) throw notFound();
  await assertInScope(tx, grant, rec.employee_id);
  assertNotSelf(grant, rec.employee_id);
  const key = optionalKey(input.idempotencyKey);
  await advisoryLock(tx, `payroll_record:${recordId}`);
  // A proposal reserves payable capacity at once: the maker's authority is checked again after the record lock.
  await reassertHold(tx, grant, 'propose');
  if (key) {
    const prior = (await tx.query<{ id: string; payroll_record_id: string; proposed_by: string }>(`select id, payroll_record_id, proposed_by from payroll_hold where company_id = $1 and idempotency_key = $2`, [grant.companyId, key])).rows[0];
    if (prior) {
      if (prior.payroll_record_id !== recordId || prior.proposed_by !== grant.userId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another request');
      return { ...(await holdDetail(tx, grant, prior.id)), replayed: true };
    }
  }
  if (rec.run_state !== 'PROCESSED_LOCKED') throw new HttpError(409, 'RUN_NOT_PROCESSED', 'A hold applies to a processed payroll record');
  const criterion = (
    await tx.query<{ id: string; code: string; revision: number; state: string; scope_mode: string; max_review_days: number }>(
      `select id, code, revision, state, scope_mode, max_review_days from payroll_hold_criterion where company_id = $1 and id = $2`,
      [grant.companyId, input.criterionId],
    )
  ).rows[0];
  if (!criterion || criterion.state !== 'ACTIVE') {
    throw new HttpError(409, 'HOLD_CRITERION_NOT_ACTIVE', 'Contractual and legal/disciplinary holds are disabled until the company activates a validated criterion (H2)');
  }
  if (input.scope === 'PARTIAL' && criterion.scope_mode !== 'FULL_OR_PARTIAL') throw new HttpError(422, 'PARTIAL_HOLD_DISABLED', 'This criterion does not allow partial holds');
  const effectiveDate = requireDate(input.effectiveDate, 'effective date');
  const reviewDueOn = requireDate(input.reviewDueOn, 'review date');
  if (effectiveDate < grant.businessDate) throw new HttpError(422, 'EFFECTIVE_DATE_IN_PAST', 'A hold takes effect today or later');
  if (reviewDueOn < effectiveDate || reviewDueOn > addDays(effectiveDate, criterion.max_review_days)) {
    throw new HttpError(422, 'REVIEW_DATE_INVALID', `The review date is on or after the effective date and within the criterion's ${criterion.max_review_days}-day review interval`);
  }
  const reason = requireText(input.reason, 'reason', 1000);
  const releaseCriterion = requireText(input.releaseCriterion, 'release criterion', 1000, 'RELEASE_CRITERION_REQUIRED');
  const evidence = requireText(input.evidenceReference, 'evidence reference', 500, 'EVIDENCE_REQUIRED');
  const documents = await requireVerifiedEvidence(tx, grant.companyId, rec.employee_id, input.evidenceDocumentIds, { required: true });
  const balance = (await holdBalance(tx, grant.companyId, recordId))!;
  if (rec.calculation_status !== 'CALCULATED' || balance.unreserved === null) throw new HttpError(409, 'NOTHING_PAYABLE', 'The record has no payable amount');
  let amount: string;
  if (input.scope === 'FULL') {
    // H4: a full hold derives its amount from the outstanding eligible liability.
    if (input.amount !== undefined) throw new HttpError(422, 'AMOUNT_NOT_ALLOWED', 'A full hold takes the outstanding amount; give an amount only for a partial hold');
    amount = balance.unreserved;
  } else {
    amount = checkAmount(input.amount, rec.minor);
  }
  const within = (await tx.query<{ positive: boolean; within: boolean }>(`select $1::numeric > 0 as positive, $1::numeric <= $2::numeric as within`, [amount, balance.unreserved])).rows[0]!;
  if (!within.positive) throw new HttpError(409, 'NOTHING_TO_HOLD', 'Nothing of this record is unpaid and unreserved');
  if (!within.within) throw new HttpError(422, 'HOLD_EXCEEDS_UNRESERVED', 'A hold is at most the unpaid, unreserved entitlement of the record');
  const transactionId = await newTransaction(tx, grant.companyId, HOLD_KIND, rec.employee_id, 'PROPOSED', grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_hold (company_id, employee_id, payroll_record_id, run_id, transaction_id, hold_kind, criterion_id, policy_revision, reason_code, reason, scope,
                                 hold_amount, currency_code, idempotency_key, state, proposed_by, effective_date, review_due_on, release_criterion, evidence_reference,
                                 unresolved_since, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'POLICY_HOLD', $6, $7, $8, $9, $10, $11::numeric, $12, $13, 'PROPOSED', $14, $15, $16, $17, $18, $19, $14, $14) returning id`,
      [
        grant.companyId,
        rec.employee_id,
        recordId,
        rec.run_id,
        transactionId,
        criterion.id,
        `${criterion.code}@r${criterion.revision}`,
        criterion.code,
        reason,
        input.scope,
        amount,
        rec.currency_code,
        key,
        grant.userId,
        effectiveDate,
        reviewDueOn,
        releaseCriterion,
        evidence,
        grant.businessDate,
      ],
    )
  ).rows[0]!.id;
  await attachEvidence(tx, grant, transactionId, 1, rec.employee_id, documents);
  // Never the maker or the beneficiary (the engine excludes the owner employee's users), nor the run's deciders.
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: HOLD_KIND,
    transactionId,
    ownerEmployeeId: rec.employee_id,
    actorUserId: grant.userId,
    excludeUserIds: [grant.userId, ...(await runDeciders(tx, grant.companyId, rec.run_id))],
  });
  await audit(tx, actorOf(grant), 'payroll_hold', id, 'PROPOSE', null, {
    operational: { recordId, runId: rec.run_id, holdKind: 'POLICY_HOLD', criterion: criterion.code, scope: input.scope, effectiveDate, reviewDueOn, state: 'PROPOSED', evidenceDocuments: documents.length },
    hold: { amount, currencyCode: rec.currency_code },
  }, reason);
  await emit(tx, grant.companyId, 'payroll_hold.assigned', id, id, { holdId: id, taskId });
  return { ...(await holdDetail(tx, grant, id)), replayed: false };
}

/** The creator, preparer, reviewer and approver of the run a hold belongs to (C4 / H4: none of them decides or releases its holds). */
async function runDeciders(db: Queryable, companyId: string, runId: string): Promise<string[]> {
  const r = (
    await db.query<{ created_by: string | null; calculated_by: string | null; reviewed_by: string | null; approved_by: string | null }>(
      `select created_by, calculated_by, reviewed_by, approved_by from payroll_run where company_id = $1 and id = $2`,
      [companyId, runId],
    )
  ).rows[0];
  return r ? [r.created_by, r.calculated_by, r.reviewed_by, r.approved_by].filter((u): u is string => !!u) : [];
}

async function assertIndependentOfRun(db: Queryable, grant: AccessGrant, runId: string): Promise<void> {
  if ((await runDeciders(db, grant.companyId, runId)).includes(grant.userId)) {
    throw new HttpError(403, 'NOT_INDEPENDENT', 'The preparer, reviewer and approver of a payroll run do not decide or release its holds');
  }
}

async function lockHold(tx: Queryable, companyId: string, holdId: string): Promise<HoldRow> {
  const t = (await tx.query<{ transaction_id: string }>(`select transaction_id from payroll_hold where company_id = $1 and id = $2`, [companyId, holdId])).rows[0];
  if (!t) throw notFound();
  await lockTransaction(tx, t.transaction_id);
  return (await tx.query<HoldRow>(`select ${HOLD_COLUMNS} from payroll_hold h where h.company_id = $1 and h.id = $2 for update`, [companyId, holdId])).rows[0]!;
}

async function statusEvent(tx: Queryable, companyId: string, holdId: string, outcome: 'HELD' | 'SAFETY_BLOCK' | 'RELEASED') {
  await emit(tx, companyId, 'payroll_hold.status', holdId, `${holdId}:${outcome}`, { holdId, outcome });
}

export async function decideHold(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: 'APPROVE' | 'REJECT'; reason?: string | undefined; idempotencyKey: string }) {
  const t = await taskTransaction(tx, grant, taskId, [HOLD_KIND]);
  await lockTransaction(tx, t.transactionId);
  const h = (await tx.query<HoldRow>(`select ${HOLD_COLUMNS} from payroll_hold h where h.company_id = $1 and h.transaction_id = $2 for update`, [grant.companyId, t.transactionId])).rows[0];
  if (!h) throw notFound();
  await assertInScope(tx, grant, h.employee_id);
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { holdId: h.id, state: h.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (h.state !== 'PROPOSED') throw new HttpError(409, 'INVALID_STATE', 'This hold is not waiting for a decision');
  // H2: maker proposes, an independent eligible Admin decides; the beneficiary is never the decision maker.
  if (h.proposed_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The maker of a hold does not decide it');
  assertNotSelf(grant, h.employee_id);
  await assertIndependentOfRun(tx, grant, h.run_id);
  if (input.decision === 'REJECT') requireText(input.reason, 'reason', 1000);
  // BR-050: "an activated hold policy" when the hold is approved, not only when it was proposed (a rejection stays possible).
  else await requireActiveCriterion(tx, grant.companyId, h.criterion_id);
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'payroll_hold', action: 'decide' } });
  if (result.replayed) return { holdId: h.id, state: h.state, replayed: true };
  if (input.decision === 'APPROVE') {
    await setRootState(tx, 'payroll_hold', grant.companyId, h, 'APPROVED_ACTIVE', grant.userId, ', approved_at = now(), approved_by = $4, unresolved_since = null');
    await audit(tx, actorOf(grant), 'payroll_hold', h.id, 'APPROVE', { operational: { state: 'PROPOSED' } }, { operational: { state: 'APPROVED_ACTIVE' } }, input.reason ?? null);
    await statusEvent(tx, grant.companyId, h.id, 'HELD');
    return { holdId: h.id, state: 'APPROVED_ACTIVE', replayed: false };
  }
  // A rejected proposal never blocks: it frees the capacity it reserved.
  await setRootState(tx, 'payroll_hold', grant.companyId, h, 'REJECTED', grant.userId, ', closed_at = now(), unresolved_since = null');
  await audit(tx, actorOf(grant), 'payroll_hold', h.id, 'REJECT', { operational: { state: 'PROPOSED' } }, { operational: { state: 'REJECTED' } }, input.reason ?? null);
  return { holdId: h.id, state: 'REJECTED', replayed: false };
}

export async function withdrawHold(tx: Queryable, grant: AccessGrant, holdId: string, input: { reason: string }) {
  const h = await lockHold(tx, grant.companyId, holdId);
  await assertInScope(tx, grant, h.employee_id);
  await reassertHold(tx, grant, 'propose');
  if (h.proposed_by !== grant.userId) throw new HttpError(403, 'NOT_MAKER', 'Only the maker withdraws a proposal');
  if (h.state !== 'PROPOSED') throw new HttpError(409, 'INVALID_STATE', 'Only a proposal can be withdrawn');
  const reason = requireText(input.reason, 'reason', 1000);
  await cancelActiveApproval(tx, grant.companyId, h.transaction_id, grant.userId);
  await setRootState(tx, 'payroll_hold', grant.companyId, h, 'WITHDRAWN', grant.userId, ', closed_at = now(), unresolved_since = null');
  await audit(tx, actorOf(grant), 'payroll_hold', h.id, 'WITHDRAW', { operational: { state: 'PROPOSED' } }, { operational: { state: 'WITHDRAWN' } }, reason);
  return holdDetail(tx, grant, holdId);
}

/** An automatic payment safety block for an amount still held back by a bank problem (same transaction as its cause). */
async function insertSafetyBlock(tx: Queryable, actor: Actor, businessDate: string, recordId: string, amount: string, bankStatus: string): Promise<string> {
  const rec = (
    await tx.query<{ employee_id: string; run_id: string; currency_code: string }>(`select employee_id, run_id, currency_code from payroll_record where company_id = $1 and id = $2`, [
      actor.companyId,
      recordId,
    ])
  ).rows[0]!;
  const transactionId = await newTransaction(tx, actor.companyId, HOLD_KIND, rec.employee_id, 'APPROVED_ACTIVE', actor.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_hold (company_id, employee_id, payroll_record_id, run_id, transaction_id, hold_kind, policy_revision, reason_code, scope, hold_amount,
                                 currency_code, state, proposed_by, effective_date, review_due_on, release_criterion, evidence_reference, unresolved_since, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'PAYMENT_SAFETY_BLOCK', $6, $7, 'FULL', $8::numeric, $9, 'APPROVED_ACTIVE', $10, $11, $11, $12, $13, $11, $10, $10) returning id`,
      [actor.companyId, rec.employee_id, recordId, rec.run_id, transactionId, SAFETY_POLICY, `BANK_${bankStatus}`, amount, rec.currency_code, actor.userId, businessDate, SAFETY_RELEASE, `Bank check: ${bankStatus}`],
    )
  ).rows[0]!.id;
  await audit(tx, actor, 'payroll_hold', id, 'SAFETY_BLOCK', null, { operational: { recordId, holdKind: 'PAYMENT_SAFETY_BLOCK', reasonCode: `BANK_${bankStatus}`, state: 'APPROVED_ACTIVE' }, hold: { amount } });
  await statusEvent(tx, actor.companyId, id, 'SAFETY_BLOCK');
  return id;
}

/**
 * Processing (in the transaction that freezes these records): applied HOLD_DISBURSEMENT stops become active full
 * holds, then every payable record without a verified bank instruction and not already held gets an automatic
 * safety block. Set-based over the chunk's records.
 */
export async function createAutomaticHolds(tx: Queryable, actor: Actor, businessDate: string, runId: string, recordIds: readonly string[]): Promise<{ safetyBlocks: number; stopHolds: number }> {
  if (recordIds.length === 0) return { safetyBlocks: 0, stopHolds: 0 };
  const stopHolds = (
    await tx.query<{ id: string }>(
      `with src as materialized (
         select gen_random_uuid() as tx_id, rec.id as record_id, rec.employee_id, rec.run_id, rec.net, rec.currency_code, ss.id as stop_id, ss.reason, ss.release_criterion,
                ss.evidence_reference, ss.proposed_by, ss.decided_by, ss.decided_at, c.id as criterion_id, c.code, c.revision, c.max_review_days
           from payroll_record rec
           join payroll_salary_stop ss on ss.company_id = rec.company_id and ss.id = rec.salary_stop_id and ss.mode = 'HOLD_DISBURSEMENT'
           join payroll_hold_criterion c on c.company_id = ss.company_id and c.id = ss.criterion_id
          where rec.company_id = $1 and rec.run_id = $2 and rec.id = any($5::uuid[]) and rec.calculation_status = 'CALCULATED' and rec.net > 0
       ), bt as (
         insert into business_transaction (id, company_id, kind, owner_employee_id, state, created_by, updated_by)
         select tx_id, $1, 'payroll_hold', employee_id, 'APPROVED_ACTIVE', $3, $3 from src returning id
       )
       insert into payroll_hold (company_id, employee_id, payroll_record_id, run_id, transaction_id, hold_kind, criterion_id, salary_stop_id, policy_revision, reason_code,
                                 reason, scope, hold_amount, currency_code, state, proposed_by, effective_date, review_due_on, approved_at, approved_by,
                                 release_criterion, evidence_reference, created_by, updated_by)
       select $1, s.employee_id, s.record_id, s.run_id, s.tx_id, 'SALARY_STOP', s.criterion_id, s.stop_id, s.code || '@r' || s.revision, s.code, s.reason, 'FULL', s.net,
              s.currency_code, 'APPROVED_ACTIVE', s.proposed_by, $4::date, $4::date + s.max_review_days, s.decided_at, s.decided_by, s.release_criterion,
              s.evidence_reference, $3, $3
         from src s where s.tx_id in (select id from bt)
       returning id`,
      [actor.companyId, runId, actor.userId, businessDate, recordIds],
    )
  ).rows.map((r) => r.id);
  for (const id of stopHolds) await statusEvent(tx, actor.companyId, id, 'HELD');
  const safety = (
    await tx.query<{ id: string }>(
      `with src as materialized (
         select gen_random_uuid() as tx_id, rec.id as record_id, rec.employee_id, rec.run_id, rec.net, rec.currency_code, rec.bank_status
           from payroll_record rec
          where rec.company_id = $1 and rec.run_id = $2 and rec.id = any($8::uuid[]) and rec.calculation_status = 'CALCULATED' and rec.net > 0
            and rec.bank_status in ('MISSING', 'INVALID', 'UNVERIFIED')
            and not exists (select 1 from payroll_hold h where h.company_id = rec.company_id and h.payroll_record_id = rec.id and h.state = any($6::text[]))
       ), bt as (
         insert into business_transaction (id, company_id, kind, owner_employee_id, state, created_by, updated_by)
         select tx_id, $1, 'payroll_hold', employee_id, 'APPROVED_ACTIVE', $3, $3 from src returning id
       )
       insert into payroll_hold (company_id, employee_id, payroll_record_id, run_id, transaction_id, hold_kind, policy_revision, reason_code, scope, hold_amount,
                                 currency_code, state, proposed_by, effective_date, review_due_on, release_criterion, evidence_reference, unresolved_since,
                                 created_by, updated_by)
       select $1, s.employee_id, s.record_id, s.run_id, s.tx_id, 'PAYMENT_SAFETY_BLOCK', $5, 'BANK_' || s.bank_status, 'FULL', s.net, s.currency_code,
              'APPROVED_ACTIVE', $3, $4::date, $4::date, $7, 'Bank check at processing: ' || s.bank_status, $4::date, $3, $3
         from src s where s.tx_id in (select id from bt)
       returning id`,
      [actor.companyId, runId, actor.userId, businessDate, SAFETY_POLICY, LIVE, SAFETY_RELEASE, recordIds],
    )
  ).rows.map((r) => r.id);
  for (const id of safety) await statusEvent(tx, actor.companyId, id, 'SAFETY_BLOCK');
  return { safetyBlocks: safety.length, stopHolds: stopHolds.length };
}

export interface ReleaseInput {
  reason: string;
  evidenceReference: string;
  evidenceDocumentIds?: string[] | undefined;
  expectedVersion: number;
}

export async function releaseHold(tx: Queryable, grant: AccessGrant, holdId: string, input: ReleaseInput) {
  const h = await lockHold(tx, grant.companyId, holdId);
  await assertInScope(tx, grant, h.employee_id);
  // Releasing makes held money payable again: decided under the authority current after the hold's locks.
  await reassertHold(tx, grant, 'release');
  assertNotSelf(grant, h.employee_id);
  if (await userIsEmployee(tx, grant.companyId, grant.userId, h.employee_id)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
  if (h.version !== input.expectedVersion) stale();
  if (h.state !== 'APPROVED_ACTIVE' && h.state !== 'EXPIRED_REVIEW') throw new HttpError(409, 'INVALID_STATE', 'Only an active hold can be released');
  if (h.hold_kind !== 'PAYMENT_SAFETY_BLOCK' && h.proposed_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The maker of a hold does not release it');
  await assertIndependentOfRun(tx, grant, h.run_id);
  const reason = requireText(input.reason, 'reason', 1000);
  const evidence = requireText(input.evidenceReference, 'evidence reference', 500, 'EVIDENCE_REQUIRED');
  const documents = await requireVerifiedEvidence(tx, grant.companyId, h.employee_id, input.evidenceDocumentIds, { required: false });
  const bank = (await bankChecks(tx, grant.companyId, [h.employee_id])).get(h.employee_id)!;
  let releaseBank: string | null = null;
  let releaseCheck: 'WORKFLOW_VERIFIED' | 'ADMIN_VERIFIED' | null = null;
  if (h.hold_kind === 'PAYMENT_SAFETY_BLOCK') {
    // H2: the Admin verifies an approved bank revision before releasing the instruction: a valid revision is needed.
    if (!bank.revisionId || (bank.status !== 'VERIFIED' && bank.status !== 'UNVERIFIED')) {
      throw new HttpError(409, 'BANK_NOT_VERIFIED', 'A safety block is released once a valid approved bank instruction is on record', { bankStatus: bank.status });
    }
    // "Independently releases": the approver of the bank change does not also release payment against it.
    if ((await bankRevisionApprovers(tx, grant.companyId, bank.revisionId)).includes(grant.userId)) {
      throw new HttpError(403, 'NOT_INDEPENDENT', 'The approver of the bank change does not release payment against it');
    }
    releaseBank = bank.revisionId;
    releaseCheck = bank.status === 'VERIFIED' ? (bank.verification ?? 'WORKFLOW_VERIFIED') : 'ADMIN_VERIFIED';
  }
  if (documents.length > 0) {
    // Release evidence is linked to its own revision of the case (the proposal keeps revision 1's evidence).
    const revision = (
      await tx.query<{ revision: number }>(`update business_transaction set revision = revision + 1, updated_by = $3 where company_id = $1 and id = $2 returning revision`, [
        grant.companyId,
        h.transaction_id,
        grant.userId,
      ])
    ).rows[0]!.revision;
    await attachEvidence(tx, grant, h.transaction_id, revision, h.employee_id, documents);
  }
  await setRootState(
    tx,
    'payroll_hold',
    grant.companyId,
    h,
    'RELEASED',
    grant.userId,
    `, released_at = now(), released_by = $4, released_assignment_id = $5, release_reason = $6, release_evidence_reference = $7, release_bank_revision_id = $8,
       release_bank_check = $9, closed_at = now(), unresolved_since = null, expired_at = null`,
    [grant.assignmentId, reason, evidence, releaseBank, releaseCheck],
  );
  await audit(tx, actorOf(grant), 'payroll_hold', h.id, 'RELEASE', { operational: { state: h.state } }, {
    operational: { state: 'RELEASED', holdKind: h.hold_kind, releaseBankRevisionId: releaseBank, releaseBankCheck: releaseCheck, evidenceDocuments: documents.length },
    hold: { amount: h.hold_amount, currencyCode: h.currency_code },
  }, reason);
  await statusEvent(tx, grant.companyId, h.id, 'RELEASED');
  // A released policy hold or stop is still not payable without a verified bank instruction: that remains a safety block.
  let safetyBlockId: string | null = null;
  if (h.hold_kind !== 'PAYMENT_SAFETY_BLOCK' && bank.status !== 'VERIFIED') {
    const live = await tx.query(`select 1 from payroll_hold where company_id = $1 and payroll_record_id = $2 and hold_kind = 'PAYMENT_SAFETY_BLOCK' and state = any($3::text[])`, [
      grant.companyId,
      h.payroll_record_id,
      LIVE,
    ]);
    if ((live.rowCount ?? 0) === 0) safetyBlockId = await insertSafetyBlock(tx, actorOf(grant), grant.businessDate, h.payroll_record_id, h.hold_amount, bank.status);
  }
  return { ...(await holdDetail(tx, grant, holdId)), safetyBlockId };
}

/** An expired review is renewed by an independent decision with a new review date within the criterion's interval. */
export async function renewHoldReview(tx: Queryable, grant: AccessGrant, holdId: string, input: { reviewDueOn: string; reason: string; expectedVersion: number }) {
  const h = await lockHold(tx, grant.companyId, holdId);
  await assertInScope(tx, grant, h.employee_id);
  await reassertHold(tx, grant, 'decide');
  assertNotSelf(grant, h.employee_id);
  if (await userIsEmployee(tx, grant.companyId, grant.userId, h.employee_id)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
  if (h.version !== input.expectedVersion) stale();
  if (h.state !== 'EXPIRED_REVIEW' || !h.criterion_id) throw new HttpError(409, 'INVALID_STATE', 'Only a hold whose review expired can be renewed');
  if (h.proposed_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The maker of a hold does not renew it');
  await assertIndependentOfRun(tx, grant, h.run_id);
  const max = (await tx.query<{ max_review_days: number }>(`select max_review_days from payroll_hold_criterion where company_id = $1 and id = $2`, [grant.companyId, h.criterion_id])).rows[0]!
    .max_review_days;
  const due = requireDate(input.reviewDueOn, 'review date');
  if (due < grant.businessDate || due > addDays(grant.businessDate, max)) throw new HttpError(422, 'REVIEW_DATE_INVALID', `The review date is within ${max} days from today`);
  const reason = requireText(input.reason, 'reason', 1000);
  await setRootState(tx, 'payroll_hold', grant.companyId, h, 'APPROVED_ACTIVE', grant.userId, ', review_due_on = $5, expired_at = null, unresolved_since = null', [due]);
  await audit(tx, actorOf(grant), 'payroll_hold', h.id, 'RENEW_REVIEW', { operational: { state: 'EXPIRED_REVIEW' } }, { operational: { state: 'APPROVED_ACTIVE', reviewDueOn: due } }, reason);
  return holdDetail(tx, grant, holdId);
}

const HOLD_VIEW = `select h.id, h.hold_kind as "holdKind", h.state, h.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
    h.payroll_record_id as "payrollRecordId", h.run_id as "runId", ru.revision as "runRevision", p.period_code as "periodCode", c.code as "criterionCode",
    h.salary_stop_id as "salaryStopId", h.policy_revision as "policyRevision", h.reason_code as "reasonCode", h.reason, h.scope, h.hold_amount as "holdAmount",
    h.currency_code as "currencyCode", h.effective_date as "effectiveDate", h.review_due_on as "reviewDueOn", h.unresolved_since as "unresolvedSince",
    h.release_criterion as "releaseCriterion", h.evidence_reference as "evidenceReference", h.proposed_at as "proposedAt", h.proposed_by as "proposedBy",
    h.approved_at as "approvedAt", h.approved_by as "approvedBy", h.expired_at as "expiredAt", h.released_at as "releasedAt", h.released_by as "releasedBy",
    h.release_reason as "releaseReason", h.release_evidence_reference as "releaseEvidenceReference", h.release_bank_revision_id as "releaseBankRevisionId",
    h.release_bank_check as "releaseBankCheck", h.transaction_id as "transactionId", h.version
  from payroll_hold h
  join employee e on e.company_id = h.company_id and e.id = h.employee_id
  join payroll_run ru on ru.company_id = h.company_id and ru.id = h.run_id
  join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
  left join payroll_hold_criterion c on c.company_id = h.company_id and c.id = h.criterion_id`;

export async function holdDetail(db: Queryable, grant: AccessGrant, holdId: string) {
  const h = (await db.query<{ employeeId: string; payrollRecordId: string; transactionId: string }>(`${HOLD_VIEW} where h.company_id = $1 and h.id = $2`, [grant.companyId, holdId])).rows[0];
  if (!h) throw notFound();
  await assertInScope(db, grant, h.employeeId);
  assertNotSelf(grant, h.employeeId);
  const balance = await holdBalance(db, grant.companyId, h.payrollRecordId);
  const { transactionId, ...rest } = h;
  return {
    ...rest,
    evidence: await evidenceOf(db, grant.companyId, transactionId),
    record: balance ? { payable: balance.payable, held: balance.held, unreserved: balance.unreserved, currencyCode: balance.currency_code } : null,
  };
}

/** Holds answered without page/pageSize (the list's first answer before it could page). */
export const HOLD_LIST_CAP = 500;

/** The hold amounts' confidential field group (the list's amounts and its totals). */
const HOLD_GROUP = 'hold';

/**
 * Holds within row scope (never the caller's own), newest proposal first: one page (FR-056), or the first 500 without
 * page/pageSize; `total` counts every match the caller may see.
 *
 * H7 held salary report totals, per currency, over every matching hold (not only the page), under the hold amount
 * group (omitted without it): `reserved` is the pending reservation of the holds' release allocations (DB114: a bank
 * line's hold_id links the allocation paying a released hold; DB118: RESERVED, SUBMITTED and UNKNOWN stay reserved,
 * FAILED and CANCELLED free it) and `confirmed` their confirmed net paid (DB118: confirmations minus authorised
 * reversals).
 *
 * `outstanding` (H7; I-45; decided under owner delegation, 6 Nov 2026, docs/03 I-80): held salary the company still owes,
 * until its payment is confirmed. A pending reservation is money not yet paid, so it stays in outstanding (as in the
 * expense rule "approved = net confirmed paid + outstanding"); `reserved` shows how much of it is in payment. Counted once
 * per payroll record and never above what the record pays: its live holds (proposed, active or past review) at their
 * amounts, and its released holds at their amount less what their release allocations confirmed paid, unless a payment
 * safety block on the same record, raised at or after that release, took the money over (it is counted there instead).
 * Rejected and withdrawn holds never held anything.
 */
export async function listHolds(db: Queryable, grant: AccessGrant, q: { state?: string | undefined; runId?: string | undefined; employeeId?: string | undefined } & Paging) {
  const params = new SqlParams([grant.companyId, q.state ?? null, q.runId ?? null, q.employeeId ?? null, grant.linkedEmployeeId]);
  const scope = employeeScopePredicate(grant, { company: 'h.company_id', employee: 'h.employee_id' }, params);
  const where = `h.company_id = $1 and ($2::text is null or h.state = $2) and ($3::uuid is null or h.run_id = $3) and ($4::uuid is null or h.employee_id = $4)
        and ${scope} and h.employee_id is distinct from $5::uuid`;
  const page = await pageOf(db, `${HOLD_VIEW} where ${where}`, params.values, '"proposedAt" desc, id', q, HOLD_LIST_CAP);
  const items = page.items.map(({ transactionId: _t, ...r }) => r);
  if (!grant.allowedFieldGroups.includes(HOLD_GROUP)) return { ...page, items };
  const totals = (
    await db.query<{ currencyCode: string; reserved: string; confirmed: string; outstanding: string }>(
      `with paid as (
         select h.currency_code,
                coalesce(sum(l.payable_amount) filter (where l.payment_state in ('RESERVED', 'SUBMITTED', 'UNKNOWN')), 0) as reserved,
                coalesce(sum(l.confirmed_amount - l.reversed_amount), 0) as confirmed
           from payroll_hold h left join payroll_bank_line l on l.company_id = h.company_id and l.hold_id = h.id
          where ${where}
          group by h.currency_code),
       held as (select h.* from payroll_hold h where ${where} and h.state not in ('REJECTED', 'WITHDRAWN')),
       per_record as (
         select hl.currency_code, hl.payroll_record_id,
                sum(case when hl.state in ('PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW') then hl.hold_amount
                         when hl.state = 'RELEASED' and not exists (
                                select 1 from payroll_hold sb
                                 where sb.company_id = hl.company_id and sb.payroll_record_id = hl.payroll_record_id and sb.id <> hl.id and sb.hold_kind = 'PAYMENT_SAFETY_BLOCK'
                                   and sb.state not in ('REJECTED', 'WITHDRAWN') and sb.proposed_at >= hl.released_at)
                           then greatest(hl.hold_amount - coalesce((select sum(l.confirmed_amount - l.reversed_amount) from payroll_bank_line l
                                                                     where l.company_id = hl.company_id and l.hold_id = hl.id), 0), 0)
                         else 0 end) as amount
           from held hl
          group by hl.currency_code, hl.payroll_record_id),
       owed as (
         select pr.currency_code, sum(least(pr.amount, rec.net)) as amount
           from per_record pr join payroll_record rec on rec.company_id = $1 and rec.id = pr.payroll_record_id
          group by pr.currency_code)
       select p.currency_code as "currencyCode", p.reserved::numeric(19, 4)::text as reserved, p.confirmed::numeric(19, 4)::text as confirmed,
              coalesce(o.amount, 0)::numeric(19, 4)::text as outstanding
         from paid p left join owed o on o.currency_code = p.currency_code
        order by p.currency_code`,
      params.values,
    )
  ).rows;
  return { ...page, items, totals };
}

export async function recordHoldBalance(db: Queryable, grant: AccessGrant, recordId: string) {
  const rec = (await db.query<{ employee_id: string }>(`select employee_id from payroll_record where company_id = $1 and id = $2`, [grant.companyId, recordId])).rows[0];
  if (!rec) throw notFound();
  await assertInScope(db, grant, rec.employee_id);
  assertNotSelf(grant, rec.employee_id);
  const b = (await holdBalance(db, grant.companyId, recordId))!;
  return { recordId, payable: b.payable, held: b.held, unreserved: b.unreserved, currencyCode: b.currency_code };
}

export async function holdTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, HOLD_KIND)).items as { taskId: string; transactionId: string }[];
  const items = [];
  for (const t of tasks) {
    const h = (await db.query<Record<string, unknown>>(`${HOLD_VIEW} where h.company_id = $1 and h.transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0];
    if (!h) {
      items.push({ taskId: t.taskId, hold: null });
      continue;
    }
    const { transactionId: _t, ...hold } = h;
    items.push({ taskId: t.taskId, hold });
  }
  return { items };
}

// ---------------------------------------------------------------------------------------------------------------
// Daily review job (H2 cadence). Exported for the scheduler (wired by the integrator); it does not run itself.
// ---------------------------------------------------------------------------------------------------------------

/**
 * For a company-local date: active policy and stop holds whose review date has arrived move to EXPIRED_REVIEW and
 * alert the reviewers that day (nothing is paid, forgiven or deleted); every unresolved hold then raises one reminder
 * per day (a proposal waiting for its decider from the day after it was proposed; an expired review and an
 * automatic safety block, both for the fallback reviewers, from the day they became unresolved), its first
 * escalation once it has been unresolved for 2 business days and a further escalation every 5 business days after
 * that. Business days are Monday to Friday on the company calendar date (as for the approval reminders). Each
 * occurrence has its own outbox key, so reruns never duplicate; work runs in bounded pages, each its own transaction.
 */
export async function runPayrollHoldReviews(db: Database, companyId: string, localDate: string, systemUserId: string) {
  requireDate(localDate, 'date');
  const system: Actor = { companyId, userId: systemUserId, assignmentId: null };
  let expired = 0;
  for (;;) {
    const due = (
      await db.query<{ id: string }>(
        `select id from payroll_hold where company_id = $1 and state = 'APPROVED_ACTIVE' and hold_kind in ('POLICY_HOLD', 'SALARY_STOP') and review_due_on <= $2::date
          order by review_due_on, id limit $3`,
        [companyId, localDate, REVIEW_PAGE],
      )
    ).rows;
    if (due.length === 0) break;
    for (const d of due) {
      const moved = await withTransaction(db, async (tx) => {
        const h = await lockHold(tx, companyId, d.id);
        if (h.state !== 'APPROVED_ACTIVE' || h.review_due_on > localDate) return false;
        await setRootState(tx, 'payroll_hold', companyId, h, 'EXPIRED_REVIEW', systemUserId, ', expired_at = now(), unresolved_since = $5', [localDate]);
        await audit(tx, system, 'payroll_hold', h.id, 'REVIEW_EXPIRED', { operational: { state: 'APPROVED_ACTIVE' } }, {
          operational: { state: 'EXPIRED_REVIEW', reviewDueOn: h.review_due_on },
        });
        return true;
      });
      if (moved) expired++;
    }
    if (due.length < REVIEW_PAGE) break;
  }

  let reminders = 0;
  let escalations = 0;
  let after: string | null = null;
  for (;;) {
    const page: { reminders: number; escalations: number; last: string | null; size: number } = await withTransaction(db, async (tx) => {
      const open = (
        await tx.query<{ id: string; state: string; hold_kind: string; transaction_id: string; unresolved_since: string; business_days: number }>(
          `select h.id, h.state, h.hold_kind, h.transaction_id, to_char(h.unresolved_since, 'YYYY-MM-DD') as unresolved_since,
                  (select count(*)::int from generate_series(h.unresolved_since + 1, $2::date, interval '1 day') g (d) where extract(isodow from g.d) < 6) as business_days
             from payroll_hold h
            where h.company_id = $1 and h.unresolved_since is not null and h.unresolved_since <= $2::date and ($3::uuid is null or h.id > $3::uuid)
              and (h.state in ('PROPOSED', 'EXPIRED_REVIEW') or (h.state = 'APPROVED_ACTIVE' and h.hold_kind = 'PAYMENT_SAFETY_BLOCK'))
            order by h.id limit $4`,
          [companyId, localDate, after, REVIEW_PAGE],
        )
      ).rows;
      let r = 0;
      let e = 0;
      for (const h of open) {
        if (h.state === 'PROPOSED') {
          if (localDate > h.unresolved_since) {
            const taskId = await pendingTaskOf(tx, companyId, h.transaction_id);
            if (await emitOnce(tx, companyId, 'payroll_hold.reminder', h.id, `${h.id}:${localDate}`, { holdId: h.id, taskId, date: localDate })) r++;
          }
        } else if (await emitOnce(tx, companyId, 'payroll_hold.review_due', h.id, `${h.id}:${localDate}`, { holdId: h.id, date: localDate })) {
          r++;
        }
        if (h.business_days >= FIRST_ESCALATION_BUSINESS_DAYS) {
          const n = 1 + Math.floor((h.business_days - FIRST_ESCALATION_BUSINESS_DAYS) / ESCALATION_INTERVAL_BUSINESS_DAYS);
          if (await emitOnce(tx, companyId, 'payroll_hold.escalation', h.id, `${h.id}:${h.unresolved_since}:${n}`, { holdId: h.id, number: n, waitingDays: h.business_days })) e++;
        }
      }
      return { reminders: r, escalations: e, last: open[open.length - 1]?.id ?? null, size: open.length };
    });
    reminders += page.reminders;
    escalations += page.escalations;
    if (page.size < REVIEW_PAGE || !page.last) break;
    after = page.last;
  }
  return { date: localDate, expired, reminders, escalations };
}
