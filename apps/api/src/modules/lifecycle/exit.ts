// Employee exit (FR-051, FR-055; DB078; F1 "Exit and employee processes"; DF03; DF04; DF08).
// The employee submits a resignation (an operational request in their Employee OWN context) with a proposed last
// working date; the direct manager recommends the date (HR fallback when the manager is ineligible); an
// independent HR Administrator approves it, or not. The approved last working date is inclusive: approval moves the
// employee to NOTICE and the daily job moves them to INACTIVE_SEPARATED on the first day after it. Withdrawal is
// the employee's own action before the final decision; afterwards it is a separate request that an independent HR
// Administrator decides, restoring the prior status. Final release needs a clearance checklist with no incomplete
// required task. Nothing is deleted or overwritten: every step is in exit_case_event, decisions in the engine.
import { type Paging, pageMeta, pageOf, type Sorting, sortedBy } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { enqueueEvent } from '../../audit/audit.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { closeConfirmationForExit } from '../confirmation/service.js';
import { cancelActiveApproval, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import {
  type Actor,
  ACTIVE_STATUSES,
  actorOf,
  addDays,
  advisoryLock,
  assertInScope,
  assertNotSelf,
  audit,
  changeEmployeeStatus,
  decisionTrail,
  employeeStatus,
  holds,
  isIsoDate,
  pendingTaskOf,
  priorDecision,
  setRootState,
  taskIsPending,
  taskTransaction,
} from './common.js';
import { cancelOpenProcess, clearanceStatus, lockClearance } from './processes.js';

export const EXIT_KIND = 'exit_case';
export const WITHDRAWAL_KIND = 'exit_withdrawal';
const LIVE_SETTLEMENT_STATES = ['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE'];

interface ExitRow {
  id: string;
  employee_id: string;
  transaction_id: string;
  state: string;
  request_date: string;
  proposed_leaving_date: string;
  recommended_leaving_date: string | null;
  approved_leaving_date: string | null;
  leaving_date: string;
  contractual_notice_days: number | null;
  prior_status_code: string | null;
  released_at: Date | null;
  version: number;
}

const EXIT_COLUMNS = `x.id, x.employee_id, x.transaction_id, x.state, to_char(x.request_date, 'YYYY-MM-DD') as request_date,
  to_char(x.proposed_leaving_date, 'YYYY-MM-DD') as proposed_leaving_date, to_char(x.recommended_leaving_date, 'YYYY-MM-DD') as recommended_leaving_date,
  to_char(x.approved_leaving_date, 'YYYY-MM-DD') as approved_leaving_date, to_char(x.leaving_date, 'YYYY-MM-DD') as leaving_date,
  x.contractual_notice_days, x.prior_status_code, x.released_at, x.version`;

function ownEmployee(grant: AccessGrant): string {
  if (!grant.linkedEmployeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  return grant.linkedEmployeeId;
}

async function exitEvent(
  tx: Queryable,
  actor: Actor,
  businessDate: string,
  x: Pick<ExitRow, 'id' | 'employee_id'>,
  action: string,
  from: string,
  to: string,
  extra: { leavingDate?: string | null; statusBefore?: string | null; statusAfter?: string | null } = {},
): Promise<void> {
  await tx.query(
    `insert into exit_case_event (company_id, exit_case_id, employee_id, action, from_state, to_state, leaving_date, employee_status_before, employee_status_after,
                                  actor_user_id, acting_assignment_id, business_date, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $10)`,
    [actor.companyId, x.id, x.employee_id, action, from, to, extra.leavingDate ?? null, extra.statusBefore ?? null, extra.statusAfter ?? null, actor.userId, actor.assignmentId, businessDate],
  );
}

async function outcomeEvent(tx: Queryable, companyId: string, exitCaseId: string, outcome: string): Promise<void> {
  await enqueueEvent(tx, { companyId, topic: 'exit.outcome', aggregateId: exitCaseId, dedupeKey: `exit.outcome:${exitCaseId}:${outcome}`, payload: { exitCaseId, outcome } });
}

/** The exit row behind its transaction lock (taken first). */
async function lockExit(tx: Queryable, companyId: string, exitCaseId: string): Promise<ExitRow | undefined> {
  const t = (await tx.query<{ transaction_id: string }>(`select transaction_id from exit_case where company_id = $1 and id = $2`, [companyId, exitCaseId])).rows[0];
  if (!t) return undefined;
  await lockTransaction(tx, t.transaction_id);
  return (await tx.query<ExitRow>(`select ${EXIT_COLUMNS} from exit_case x where x.company_id = $1 and x.id = $2 for update`, [companyId, exitCaseId])).rows[0];
}

async function liveSettlement(tx: Queryable, companyId: string, exitCaseId: string): Promise<boolean> {
  const r = await tx.query(`select 1 from settlement where company_id = $1 and exit_case_id = $2 and state = any($3::text[])`, [companyId, exitCaseId, LIVE_SETTLEMENT_STATES]);
  return (r.rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Employee: resignation, withdrawal and withdrawal request
// ---------------------------------------------------------------------------------------------------------------

export interface ResignationInput {
  proposedLastWorkingDate: string;
  reasonCode?: string | undefined;
  reason?: string | undefined;
}

export async function submitResignation(tx: Queryable, grant: AccessGrant, input: ResignationInput) {
  const employeeId = ownEmployee(grant);
  // One effective open exit per employee (DB078): serialise concurrent submissions for the employee.
  await advisoryLock(tx, `exit:${grant.companyId}:${employeeId}`);
  const status = await employeeStatus(tx, grant.companyId, employeeId);
  if (!status || !(ACTIVE_STATUSES as readonly string[]).includes(status)) throw new HttpError(409, 'EMPLOYEE_NOT_ACTIVE', 'Only an active employee can resign');
  const open = await tx.query(`select 1 from exit_case where company_id = $1 and employee_id = $2 and state in ('SUBMITTED', 'RECOMMENDED', 'APPROVED')`, [grant.companyId, employeeId]);
  if ((open.rowCount ?? 0) > 0) throw new HttpError(409, 'OPEN_EXIT_EXISTS', 'You already have an open resignation');
  const date = input.proposedLastWorkingDate;
  if (!isIsoDate(date) || date < grant.businessDate) {
    throw new HttpError(422, 'INVALID_LAST_WORKING_DATE', 'The proposed last working date must be a valid date from today', { field: 'proposedLastWorkingDate' });
  }
  let reasonCodeId: string | null = null;
  if (input.reasonCode) {
    const code = (
      await tx.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = 'EXIT_REASON' and code = $2`, [grant.companyId, input.reasonCode])
    ).rows[0];
    if (!code) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown exit reason code');
    reasonCodeId = code.id;
  }
  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'SUBMITTED', $4, $4) returning id`,
      [grant.companyId, EXIT_KIND, employeeId, grant.userId],
    )
  ).rows[0]!.id;
  const x = (
    await tx.query<ExitRow>(
      `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, reason_code_id, reason, state, created_by, updated_by)
       values ($1, $2, $3, 'RESIGNATION', $4, $5, $5, $6, $7, 'SUBMITTED', $8, $8) returning ${EXIT_COLUMNS.replace(/x\./g, '')}`,
      [grant.companyId, employeeId, transactionId, grant.businessDate, date, reasonCodeId, input.reason?.trim() || null, grant.userId],
    )
  ).rows[0]!;
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: EXIT_KIND, transactionId, ownerEmployeeId: employeeId, actorUserId: grant.userId });
  await exitEvent(tx, actorOf(grant), grant.businessDate, x, 'SUBMIT', 'NONE', 'SUBMITTED', { leavingDate: date });
  await audit(tx, actorOf(grant), 'exit_case', x.id, 'SUBMIT', null, {
    operational: { state: 'SUBMITTED', requestDate: grant.businessDate, proposedLastWorkingDate: date, reasonRecorded: Boolean(input.reason?.trim() || reasonCodeId) },
  });
  await enqueueEvent(tx, { companyId: grant.companyId, topic: 'exit.submitted', aggregateId: x.id, dedupeKey: `exit.submitted:${x.id}`, payload: { exitCaseId: x.id, taskId } });
  return { exitCaseId: x.id, state: 'SUBMITTED', requestDate: grant.businessDate, proposedLastWorkingDate: date };
}

async function lockOwnExit(tx: Queryable, grant: AccessGrant, exitCaseId: string): Promise<ExitRow> {
  const employeeId = ownEmployee(grant);
  const x = await lockExit(tx, grant.companyId, exitCaseId);
  if (!x || x.employee_id !== employeeId) throw notFound();
  return x;
}

/** Before the final decision the employee withdraws their own resignation (F1); the request and trail are kept. */
export async function withdrawResignation(tx: Queryable, grant: AccessGrant, exitCaseId: string) {
  const x = await lockOwnExit(tx, grant, exitCaseId);
  // The withdrawal ends an approval in flight: the duty is checked again after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'exit', 'submit', ['operational']);
  if (x.state === 'APPROVED') throw new HttpError(409, 'USE_WITHDRAWAL_REQUEST', 'An approved resignation is withdrawn only through an HR decision; request it');
  if (x.state !== 'SUBMITTED' && x.state !== 'RECOMMENDED') throw new HttpError(409, 'INVALID_STATE', 'This resignation can no longer be withdrawn');
  await cancelActiveApproval(tx, grant.companyId, x.transaction_id, grant.userId);
  await setRootState(tx, 'exit_case', grant.companyId, x, 'WITHDRAWN', grant.userId, ', closed_at = now()');
  await exitEvent(tx, actorOf(grant), grant.businessDate, x, 'WITHDRAW', x.state, 'WITHDRAWN', { leavingDate: x.leaving_date });
  await audit(tx, actorOf(grant), 'exit_case', x.id, 'WITHDRAW', { operational: { state: x.state } }, { operational: { state: 'WITHDRAWN' } });
  await outcomeEvent(tx, grant.companyId, x.id, 'WITHDRAWN');
  return { exitCaseId: x.id, state: 'WITHDRAWN' };
}

/** F1: after approval the employee asks for withdrawal; an independent HR Administrator decides. */
export async function requestWithdrawal(tx: Queryable, grant: AccessGrant, exitCaseId: string, input: { reason: string }) {
  const x = await lockOwnExit(tx, grant, exitCaseId);
  if (x.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only an approved resignation needs a withdrawal request');
  if (x.released_at) throw new HttpError(409, 'EXIT_RELEASED', 'The exit was finally released');
  if (grant.businessDate > x.approved_leaving_date!) throw new HttpError(409, 'LAST_WORKING_DATE_PASSED', 'The last working date has passed');
  const pending = await tx.query(`select 1 from exit_withdrawal_request where company_id = $1 and exit_case_id = $2 and state = 'SUBMITTED'`, [grant.companyId, x.id]);
  if ((pending.rowCount ?? 0) > 0) throw new HttpError(409, 'WITHDRAWAL_PENDING', 'A withdrawal request is already waiting for a decision');
  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'SUBMITTED', $4, $4) returning id`,
      [grant.companyId, WITHDRAWAL_KIND, x.employee_id, grant.userId],
    )
  ).rows[0]!.id;
  const withdrawalId = (
    await tx.query<{ id: string }>(
      `insert into exit_withdrawal_request (company_id, exit_case_id, employee_id, transaction_id, reason, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'SUBMITTED', $6, $6) returning id`,
      [grant.companyId, x.id, x.employee_id, transactionId, input.reason.trim(), grant.userId],
    )
  ).rows[0]!.id;
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: WITHDRAWAL_KIND, transactionId, ownerEmployeeId: x.employee_id, actorUserId: grant.userId });
  await exitEvent(tx, actorOf(grant), grant.businessDate, x, 'WITHDRAWAL_REQUESTED', 'APPROVED', 'APPROVED', { leavingDate: x.leaving_date });
  await audit(tx, actorOf(grant), 'exit_withdrawal_request', withdrawalId, 'SUBMIT', null, { operational: { exitCaseId: x.id, state: 'SUBMITTED' } });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'exit_withdrawal.submitted',
    aggregateId: withdrawalId,
    dedupeKey: `exit_withdrawal.submitted:${withdrawalId}`,
    payload: { withdrawalId, taskId },
  });
  return { withdrawalId, exitCaseId: x.id, state: 'SUBMITTED' };
}

/** The employee may cancel their own pending withdrawal request; the approved resignation stands. */
export async function cancelWithdrawalRequest(tx: Queryable, grant: AccessGrant, withdrawalId: string) {
  const employeeId = ownEmployee(grant);
  const w0 = (
    await tx.query<{ exit_case_id: string; transaction_id: string }>(`select exit_case_id, transaction_id from exit_withdrawal_request where company_id = $1 and id = $2 and employee_id = $3`, [
      grant.companyId,
      withdrawalId,
      employeeId,
    ])
  ).rows[0];
  if (!w0) throw notFound();
  // Lock order everywhere: the exit's transaction, then the withdrawal's, then rows.
  const x = (await lockExit(tx, grant.companyId, w0.exit_case_id))!;
  await lockTransaction(tx, w0.transaction_id);
  const w = (await tx.query<{ id: string; transaction_id: string; state: string }>(`select id, transaction_id, state from exit_withdrawal_request where company_id = $1 and id = $2 for update`, [grant.companyId, withdrawalId])).rows[0]!;
  await reassertAccess(tx, grant, 'exit', 'submit', ['operational']);
  if (w.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This withdrawal request was already decided');
  await cancelActiveApproval(tx, grant.companyId, w.transaction_id, grant.userId);
  await setRootState(tx, 'exit_withdrawal_request', grant.companyId, w, 'WITHDRAWN', grant.userId);
  await exitEvent(tx, actorOf(grant), grant.businessDate, x, 'WITHDRAWAL_CANCELLED', x.state, x.state, { leavingDate: x.leaving_date });
  await audit(tx, actorOf(grant), 'exit_withdrawal_request', w.id, 'WITHDRAW', { operational: { state: 'SUBMITTED' } }, { operational: { state: 'WITHDRAWN' } });
  return { withdrawalId: w.id, state: 'WITHDRAWN' };
}

// ---------------------------------------------------------------------------------------------------------------
// Reviewers: manager recommendation and HR decision
// ---------------------------------------------------------------------------------------------------------------

async function lockTaskExit(tx: Queryable, grant: AccessGrant, taskId: string): Promise<ExitRow> {
  const t = await taskTransaction(tx, grant, taskId, [EXIT_KIND]);
  await lockTransaction(tx, t.transactionId);
  const x = (await tx.query<ExitRow>(`select ${EXIT_COLUMNS} from exit_case x where x.company_id = $1 and x.transaction_id = $2 for update`, [grant.companyId, t.transactionId])).rows[0];
  if (!x || !(await canAccessEmployee(tx, grant, x.employee_id))) throw notFound();
  return x;
}

export async function recommendExit(tx: Queryable, grant: AccessGrant, taskId: string, input: { recommendedLastWorkingDate: string; idempotencyKey: string }) {
  const x = await lockTaskExit(tx, grant, taskId);
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { exitCaseId: x.id, state: x.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (x.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This resignation is not waiting for a recommendation');
  const date = input.recommendedLastWorkingDate;
  if (!isIsoDate(date) || date < x.request_date || date < grant.businessDate) {
    throw new HttpError(422, 'INVALID_LAST_WORKING_DATE', 'The recommended last working date must be a valid date, not before the resignation or today', { field: 'recommendedLastWorkingDate' });
  }
  const result = await decideTask(tx, { grant, taskId, decision: 'APPROVE', idempotencyKey: input.idempotencyKey, permission: { resource: 'exit', action: 'recommend' } });
  if (result.replayed) return { exitCaseId: x.id, state: x.state, replayed: true };
  if (result.outcome !== 'NEXT_STEP') throw new HttpError(422, 'WORKFLOW_NOT_CONFIGURED', 'The exit route must end with an HR approval step');
  await setRootState(tx, 'exit_case', grant.companyId, x, 'RECOMMENDED', grant.userId, ', recommended_leaving_date = $5, leaving_date = $5, recommended_at = now()', [date]);
  await exitEvent(tx, actorOf(grant), grant.businessDate, x, 'RECOMMEND', 'SUBMITTED', 'RECOMMENDED', { leavingDate: date });
  await audit(tx, actorOf(grant), 'exit_case', x.id, 'RECOMMEND', { operational: { state: 'SUBMITTED', leavingDate: x.leaving_date } }, { operational: { state: 'RECOMMENDED', recommendedLastWorkingDate: date } });
  const next = await pendingTaskOf(tx, grant.companyId, x.transaction_id);
  await enqueueEvent(tx, { companyId: grant.companyId, topic: 'exit.recommended', aggregateId: x.id, dedupeKey: `exit.recommended:${x.id}`, payload: { exitCaseId: x.id, taskId: next } });
  return { exitCaseId: x.id, state: 'RECOMMENDED', recommendedLastWorkingDate: date, replayed: false };
}

export interface ExitDecisionInput {
  decision: 'APPROVE' | 'REJECT';
  approvedLastWorkingDate?: string | undefined;
  /** The HR reviewer's private note (required to reject); never shown to the employee. */
  reason?: string | undefined;
  /** Shown to the employee when the resignation is not approved. */
  employeeMessage?: string | undefined;
  idempotencyKey: string;
}

export async function decideExit(tx: Queryable, grant: AccessGrant, taskId: string, input: ExitDecisionInput) {
  if (input.decision === 'REJECT' && (!input.reason?.trim() || !input.employeeMessage?.trim())) {
    throw new HttpError(422, 'REASON_REQUIRED', 'Record the reason and the message for the employee');
  }
  const x = await lockTaskExit(tx, grant, taskId);
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { exitCaseId: x.id, state: x.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (x.state !== 'RECOMMENDED') throw new HttpError(409, 'INVALID_STATE', 'This resignation is not waiting for an HR decision');

  let approvedDate: string | null = null;
  let status: string | null = null;
  if (input.decision === 'APPROVE') {
    approvedDate = input.approvedLastWorkingDate ?? x.recommended_leaving_date!;
    if (!isIsoDate(approvedDate) || approvedDate < x.request_date || approvedDate < grant.businessDate) {
      throw new HttpError(422, 'INVALID_LAST_WORKING_DATE', 'The approved last working date must be a valid date, not before the resignation or today', { field: 'approvedLastWorkingDate' });
    }
    status = await employeeStatus(tx, grant.companyId, x.employee_id, true);
    if (!status || !(ACTIVE_STATUSES as readonly string[]).includes(status)) throw new HttpError(409, 'EMPLOYEE_NOT_ACTIVE', 'The employee is no longer active');
  }
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'exit', action: 'approve' } });
  if (result.replayed) return { exitCaseId: x.id, state: x.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { exitCaseId: x.id, state: x.state, replayed: false };

  const actor = actorOf(grant);
  if (result.outcome === 'APPROVED') {
    await setRootState(tx, 'exit_case', grant.companyId, x, 'APPROVED', grant.userId, ', approved_leaving_date = $5, leaving_date = $5, approved_at = now(), prior_status_code = $6', [
      approvedDate,
      status,
    ]);
    await changeEmployeeStatus(tx, actor, x.employee_id, status!, 'NOTICE', x.id, { kind: 'EXIT_APPROVED', effectiveDate: grant.businessDate });
    await closeConfirmationForExit(tx, actor, x.employee_id, 'EXIT_APPROVED', x.id);
    await exitEvent(tx, actor, grant.businessDate, x, 'APPROVE', 'RECOMMENDED', 'APPROVED', { leavingDate: approvedDate, statusBefore: status, statusAfter: 'NOTICE' });
    await audit(tx, actor, 'exit_case', x.id, 'APPROVE', { operational: { state: 'RECOMMENDED', leavingDate: x.leaving_date } }, { operational: { state: 'APPROVED', approvedLastWorkingDate: approvedDate } }, input.reason ?? null);
    await outcomeEvent(tx, grant.companyId, x.id, 'APPROVED');
    return { exitCaseId: x.id, state: 'APPROVED', approvedLastWorkingDate: approvedDate, replayed: false };
  }
  await setRootState(tx, 'exit_case', grant.companyId, x, 'REJECTED', grant.userId, ', closed_at = now(), employee_message = $5', [input.employeeMessage!.trim()]);
  await exitEvent(tx, actor, grant.businessDate, x, 'REJECT', 'RECOMMENDED', 'REJECTED', { leavingDate: x.leaving_date });
  await audit(tx, actor, 'exit_case', x.id, 'REJECT', { operational: { state: 'RECOMMENDED' } }, { operational: { state: 'REJECTED' } }, input.reason ?? null);
  await outcomeEvent(tx, grant.companyId, x.id, 'REJECTED');
  return { exitCaseId: x.id, state: 'REJECTED', replayed: false };
}

export async function decideWithdrawal(
  tx: Queryable,
  grant: AccessGrant,
  taskId: string,
  input: { decision: 'APPROVE' | 'REJECT'; reason: string; employeeMessage?: string | undefined; idempotencyKey: string },
) {
  if (input.decision === 'REJECT' && !input.employeeMessage?.trim()) throw new HttpError(422, 'EMPLOYEE_MESSAGE_REQUIRED', 'Explain the decision to the employee');
  const t = await taskTransaction(tx, grant, taskId, [WITHDRAWAL_KIND]);
  const w0 = (await tx.query<{ exit_case_id: string }>(`select exit_case_id from exit_withdrawal_request where company_id = $1 and transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0];
  if (!w0) throw notFound();
  // Lock order everywhere: the exit's transaction, then the withdrawal's.
  const x = (await lockExit(tx, grant.companyId, w0.exit_case_id))!;
  await lockTransaction(tx, t.transactionId);
  const w = (await tx.query<{ id: string; transaction_id: string; state: string }>(`select id, transaction_id, state from exit_withdrawal_request where company_id = $1 and transaction_id = $2 for update`, [grant.companyId, t.transactionId])).rows[0]!;
  if (!(await canAccessEmployee(tx, grant, x.employee_id))) throw notFound();
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { withdrawalId: w.id, state: w.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (w.state !== 'SUBMITTED' || x.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'This withdrawal request is not waiting for a decision');
  if (input.decision === 'APPROVE' && (await liveSettlement(tx, grant.companyId, x.id))) {
    throw new HttpError(409, 'SETTLEMENT_IN_PROGRESS', 'A settlement is being prepared for this exit; cancel or finish it first');
  }
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'exit', action: 'approve' } });
  if (result.replayed) return { withdrawalId: w.id, state: w.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { withdrawalId: w.id, state: w.state, replayed: false };
  const actor = actorOf(grant);
  if (result.outcome === 'APPROVED') {
    await setRootState(tx, 'exit_withdrawal_request', grant.companyId, w, 'APPROVED', grant.userId, ', decided_at = now()');
    const current = await employeeStatus(tx, grant.companyId, x.employee_id, true);
    // Restore the status the resignation found; a status changed meanwhile by another approved action stays.
    const restored = current === 'NOTICE' ? x.prior_status_code! : current;
    if (current === 'NOTICE') await changeEmployeeStatus(tx, actor, x.employee_id, 'NOTICE', restored!, x.id, { kind: 'EXIT_WITHDRAWN', effectiveDate: grant.businessDate });
    await setRootState(tx, 'exit_case', grant.companyId, x, 'WITHDRAWN', grant.userId, ', closed_at = now()');
    const clearance = (
      await tx.query<{ id: string; transaction_id: string }>(`select id, transaction_id from employee_process where company_id = $1 and exit_case_id = $2 and state = 'OPEN'`, [grant.companyId, x.id])
    ).rows;
    for (const p of clearance) {
      await lockTransaction(tx, p.transaction_id);
      await cancelOpenProcess(tx, actor, grant.businessDate, p, 'Exit withdrawn by an approved withdrawal request');
    }
    await exitEvent(tx, actor, grant.businessDate, x, 'WITHDRAWAL_APPROVED', 'APPROVED', 'WITHDRAWN', { leavingDate: x.leaving_date, statusBefore: current, statusAfter: restored });
    await audit(tx, actor, 'exit_withdrawal_request', w.id, 'APPROVE', { operational: { state: 'SUBMITTED' } }, { operational: { state: 'APPROVED', exitCaseId: x.id } }, input.reason);
    await audit(tx, actor, 'exit_case', x.id, 'WITHDRAW', { operational: { state: 'APPROVED' } }, { operational: { state: 'WITHDRAWN', withdrawalId: w.id } }, input.reason);
  } else {
    await setRootState(tx, 'exit_withdrawal_request', grant.companyId, w, 'REJECTED', grant.userId, ', decided_at = now(), employee_message = $5', [input.employeeMessage!.trim()]);
    await exitEvent(tx, actor, grant.businessDate, x, 'WITHDRAWAL_REJECTED', 'APPROVED', 'APPROVED', { leavingDate: x.leaving_date });
    await audit(tx, actor, 'exit_withdrawal_request', w.id, 'REJECT', { operational: { state: 'SUBMITTED' } }, { operational: { state: 'REJECTED' } }, input.reason);
  }
  const outcome = result.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'exit_withdrawal.decided',
    aggregateId: w.id,
    dedupeKey: `exit_withdrawal.decided:${w.id}`,
    payload: { withdrawalId: w.id, outcome },
  });
  return { withdrawalId: w.id, state: outcome, exitState: outcome === 'APPROVED' ? 'WITHDRAWN' : 'APPROVED', replayed: false };
}

// ---------------------------------------------------------------------------------------------------------------
// HR: notice period, final release
// ---------------------------------------------------------------------------------------------------------------

async function lockScopedExit(tx: Queryable, grant: AccessGrant, exitCaseId: string): Promise<ExitRow> {
  const x = await lockExit(tx, grant.companyId, exitCaseId);
  if (!x || !(await canAccessEmployee(tx, grant, x.employee_id))) throw notFound();
  assertNotSelf(grant, x.employee_id);
  return x;
}

/**
 * F1: the contractual notice period is a configured field recorded from the employee's contract (no default), needed
 * before any monetary notice adjustment. It is recorded, never used to compute notice pay.
 */
export async function recordNoticePeriod(tx: Queryable, grant: AccessGrant, exitCaseId: string, input: { contractualNoticeDays: number; expectedVersion: number }) {
  const x = await lockScopedExit(tx, grant, exitCaseId);
  // An input to any monetary notice adjustment: the duty is checked again after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'exit', 'manage', ['operational']);
  if (!['SUBMITTED', 'RECOMMENDED', 'APPROVED', 'SEPARATED'].includes(x.state) || x.released_at) throw new HttpError(409, 'INVALID_STATE', 'The exit is closed');
  if (x.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The exit changed; reload and retry');
  const frozen = await tx.query(`select 1 from settlement where company_id = $1 and exit_case_id = $2 and state in ('SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE')`, [grant.companyId, x.id]);
  if ((frozen.rowCount ?? 0) > 0) throw new HttpError(409, 'SETTLEMENT_IN_PROGRESS', 'A submitted settlement relies on the recorded notice period');
  await tx.query(`update exit_case set contractual_notice_days = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, x.id, input.contractualNoticeDays, grant.userId]);
  await exitEvent(tx, actorOf(grant), grant.businessDate, x, 'NOTICE_PERIOD_RECORDED', x.state, x.state, { leavingDate: x.leaving_date });
  await audit(tx, actorOf(grant), 'exit_case', x.id, 'RECORD_NOTICE_PERIOD', { operational: { contractualNoticeDays: x.contractual_notice_days } }, { operational: { contractualNoticeDays: input.contractualNoticeDays } });
  return exitDetail(tx, grant, x.id);
}

/** F1 "no skipped required clearance at final release": on or after the last working date, with clearance complete. */
export async function finalRelease(tx: Queryable, grant: AccessGrant, exitCaseId: string, input: { expectedVersion: number }) {
  const x = await lockScopedExit(tx, grant, exitCaseId);
  // The final release decision re-checks its duty after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'exit', 'manage', ['operational']);
  if (!['APPROVED', 'SEPARATED'].includes(x.state)) throw new HttpError(409, 'INVALID_STATE', 'Only an approved exit can be released');
  if (x.released_at) throw new HttpError(409, 'ALREADY_RELEASED', 'The exit was already released');
  if (x.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The exit changed; reload and retry');
  if (grant.businessDate < x.approved_leaving_date!) throw new HttpError(409, 'BEFORE_LAST_WORKING_DATE', 'The final release is on or after the last working date');
  const pending = await tx.query(`select 1 from exit_withdrawal_request where company_id = $1 and exit_case_id = $2 and state = 'SUBMITTED'`, [grant.companyId, x.id]);
  if ((pending.rowCount ?? 0) > 0) throw new HttpError(409, 'WITHDRAWAL_PENDING', 'A withdrawal request is waiting for a decision');
  // The clearance is read under its checklist's lock, so a task reopened at the same moment is never missed.
  await lockClearance(tx, grant.companyId, x.id);
  const clearance = await clearanceStatus(tx, grant.companyId, x.id);
  if (!clearance.started) throw new HttpError(409, 'CLEARANCE_NOT_STARTED', 'Start the exit clearance checklist first');
  if (!clearance.complete) throw new HttpError(409, 'CLEARANCE_INCOMPLETE', 'Every required clearance task must be completed first', { tasks: clearance.incompleteRequired });
  await tx.query(`update exit_case set released_at = now(), released_by = $3, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, x.id, grant.userId]);
  await exitEvent(tx, actorOf(grant), grant.businessDate, x, 'FINAL_RELEASE', x.state, x.state, { leavingDate: x.leaving_date });
  await audit(tx, actorOf(grant), 'exit_case', x.id, 'FINAL_RELEASE', { operational: { released: false } }, { operational: { released: true, state: x.state } });
  return exitDetail(tx, grant, x.id);
}

// ---------------------------------------------------------------------------------------------------------------
// Daily job: separation after the inclusive last working date
// ---------------------------------------------------------------------------------------------------------------

/**
 * Daily (company-local date): approved exits whose inclusive last working date is before `localDate` become
 * SEPARATED and the employee INACTIVE_SEPARATED (from the first day after the last working date; DF04 eligibility
 * stops after it). Each exit is its own transaction behind its transaction lock; an exit with a withdrawal request
 * waiting for a decision is left for the next run. Employee and payroll history is untouched (FR-055). Every due
 * exit is handled in one run: they are read in keyset pages (an exit left waiting stays APPROVED, so the key moves on).
 */
export async function separateDueExits(db: Database, companyId: string, localDate: string, systemUserId: string) {
  if (!isIsoDate(localDate)) throw new Error('localDate must be YYYY-MM-DD');
  let dueCount = 0;
  let separated = 0;
  let waiting = 0;
  let cursor: { day: string; id: string } | null = null;
  for (;;) {
    const due: { id: string; day: string }[] = (
      await db.query<{ id: string; day: string }>(
        `select id, to_char(approved_leaving_date, 'YYYY-MM-DD') as day from exit_case
          where company_id = $1 and state = 'APPROVED' and approved_leaving_date < $2::date
            and ($3::date is null or (approved_leaving_date, id) > ($3::date, $4::uuid))
          order by approved_leaving_date, id limit $5`,
        [companyId, localDate, cursor?.day ?? null, cursor?.id ?? null, SEPARATION_PAGE],
      )
    ).rows;
    dueCount += due.length;
    for (const d of due) {
      const outcome = await separateOne(db, companyId, localDate, systemUserId, d.id);
      if (outcome === 'SEPARATED') separated++;
      if (outcome === 'WAITING') waiting++;
    }
    const last = due[due.length - 1];
    if (due.length < SEPARATION_PAGE || !last) break;
    cursor = { day: last.day, id: last.id };
  }
  return { due: dueCount, separated, waitingForWithdrawalDecision: waiting };
}

/** Due exits read per page of the daily separation job (an engineering bound; every due exit is processed). */
const SEPARATION_PAGE = 1000;

async function separateOne(db: Database, companyId: string, localDate: string, systemUserId: string, exitCaseId: string): Promise<'SEPARATED' | 'WAITING' | null> {
  return withTransaction(db, async (tx) => {
    const x = await lockExit(tx, companyId, exitCaseId);
    if (!x || x.state !== 'APPROVED' || !(x.approved_leaving_date! < localDate)) return null;
    const pending = await tx.query(`select 1 from exit_withdrawal_request where company_id = $1 and exit_case_id = $2 and state = 'SUBMITTED'`, [companyId, x.id]);
    if ((pending.rowCount ?? 0) > 0) return 'WAITING' as const;
    const actor: Actor = { companyId, userId: systemUserId, assignmentId: null };
    const status = await employeeStatus(tx, companyId, x.employee_id, true);
    const after = status && ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'].includes(status) ? 'INACTIVE_SEPARATED' : status;
    // The last working date is inclusive: separated from the day after it.
    if (after !== status) await changeEmployeeStatus(tx, actor, x.employee_id, status!, after!, x.id, { kind: 'SEPARATION', effectiveDate: addDays(x.approved_leaving_date!, 1) });
    await closeConfirmationForExit(tx, actor, x.employee_id, 'SEPARATED', x.id);
    await setRootState(tx, 'exit_case', companyId, x, 'SEPARATED', systemUserId, ', separated_at = now()');
    await exitEvent(tx, actor, localDate, x, 'SEPARATE', 'APPROVED', 'SEPARATED', { leavingDate: x.approved_leaving_date, statusBefore: status, statusAfter: after });
    await audit(tx, actor, 'exit_case', x.id, 'SEPARATE', { operational: { state: 'APPROVED' } }, { operational: { state: 'SEPARATED', lastWorkingDate: x.approved_leaving_date, separatedOn: localDate } });
    await enqueueEvent(tx, { companyId, topic: 'exit.separated', aggregateId: x.id, dedupeKey: `exit.separated:${x.id}`, payload: { exitCaseId: x.id, lastWorkingDate: x.approved_leaving_date } });
    return 'SEPARATED' as const;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

interface ExitView {
  id: string;
  employee_id: string;
  employee_code: string;
  employee_name: string;
  transaction_id: string;
  state: string;
  separation_type: string;
  request_date: string;
  proposed_leaving_date: string;
  recommended_leaving_date: string | null;
  approved_leaving_date: string | null;
  leaving_date: string;
  contractual_notice_days: number | null;
  reason_code: string | null;
  reason: string | null;
  employee_message: string | null;
  released_at: Date | null;
  submitted_at: Date;
  version: number;
}

const VIEW_SQL = `select x.id, x.employee_id, e.employee_code, e.display_name as employee_name, x.transaction_id, x.state, x.separation_type,
    to_char(x.request_date, 'YYYY-MM-DD') as request_date, to_char(x.proposed_leaving_date, 'YYYY-MM-DD') as proposed_leaving_date,
    to_char(x.recommended_leaving_date, 'YYYY-MM-DD') as recommended_leaving_date, to_char(x.approved_leaving_date, 'YYYY-MM-DD') as approved_leaving_date,
    to_char(x.leaving_date, 'YYYY-MM-DD') as leaving_date, x.contractual_notice_days, rc.code as reason_code, x.reason, x.employee_message,
    x.released_at, x.submitted_at, x.version
  from exit_case x
  join employee e on e.company_id = x.company_id and e.id = x.employee_id
  left join reference_value rc on rc.company_id = x.company_id and rc.id = x.reason_code_id`;

function present(grant: AccessGrant, r: ExitView) {
  return {
    id: r.id,
    employeeId: r.employee_id,
    employeeCode: r.employee_code,
    employeeName: r.employee_name,
    state: r.state,
    separationType: r.separation_type,
    requestDate: r.request_date,
    proposedLastWorkingDate: r.proposed_leaving_date,
    recommendedLastWorkingDate: r.recommended_leaving_date,
    approvedLastWorkingDate: r.approved_leaving_date,
    lastWorkingDate: r.leaving_date,
    // F1: recorded contractual value only; NOT_RECORDED blocks a monetary notice adjustment.
    noticePeriod: r.contractual_notice_days === null ? { status: 'NOT_RECORDED' } : { status: 'RECORDED', contractualNoticeDays: r.contractual_notice_days },
    // The private reason needs the exit reason group (the employee's own under H1; eligible grants otherwise).
    ...(holds(grant, 'reason') ? { reasonCode: r.reason_code, reason: r.reason } : {}),
    employeeMessage: r.employee_message,
    released: r.released_at !== null,
    releasedAt: r.released_at,
    submittedAt: r.submitted_at,
    version: r.version,
  };
}

async function history(db: Queryable, companyId: string, exitCaseId: string) {
  return (
    await db.query(
      `select action, from_state as "fromState", to_state as "toState", to_char(leaving_date, 'YYYY-MM-DD') as "lastWorkingDate",
              employee_status_before as "employeeStatusBefore", employee_status_after as "employeeStatusAfter", actor_user_id as "actorUserId",
              to_char(business_date, 'YYYY-MM-DD') as "businessDate", occurred_at as "occurredAt"
         from exit_case_event where company_id = $1 and exit_case_id = $2 order by occurred_at, id`,
      [companyId, exitCaseId],
    )
  ).rows;
}

async function withdrawals(db: Queryable, grant: AccessGrant, exitCaseId: string) {
  const rows = (
    await db.query<{ id: string; transaction_id: string; state: string; reason: string; employee_message: string | null; created_at: Date; decided_at: Date | null }>(
      `select id, transaction_id, state, reason, employee_message, created_at, decided_at from exit_withdrawal_request where company_id = $1 and exit_case_id = $2 order by created_at`,
      [grant.companyId, exitCaseId],
    )
  ).rows;
  return rows.map((w) => ({
    id: w.id,
    state: w.state,
    ...(holds(grant, 'reason') ? { reason: w.reason } : {}),
    employeeMessage: w.employee_message,
    requestedAt: w.created_at,
    decidedAt: w.decided_at,
  }));
}

export async function exitDetail(db: Queryable, grant: AccessGrant, exitCaseId: string) {
  const r = (await db.query<ExitView>(`${VIEW_SQL} where x.company_id = $1 and x.id = $2`, [grant.companyId, exitCaseId])).rows[0];
  if (!r || !(await canAccessEmployee(db, grant, r.employee_id))) throw notFound();
  const ws = await withdrawals(db, grant, r.id);
  const wsTx = (await db.query<{ transaction_id: string }>(`select transaction_id from exit_withdrawal_request where company_id = $1 and exit_case_id = $2`, [grant.companyId, r.id])).rows.map((w) => w.transaction_id);
  const clearance = await clearanceStatus(db, grant.companyId, r.id);
  return {
    ...present(grant, r),
    clearance: { started: clearance.started, complete: clearance.complete, processIds: clearance.processIds, incompleteRequired: clearance.incompleteRequired },
    withdrawals: ws,
    decisions: await decisionTrail(db, grant.companyId, [r.transaction_id, ...wsTx]),
    history: await history(db, grant.companyId, r.id),
  };
}

/** Own exit cases answered without page/pageSize (the list's first answer before it could page). */
export const OWN_EXIT_LIST_CAP = 50;

/** The employee's own exit cases with their details, newest first: one page (FR-056), or the first 50; `total` counts all. */
export async function listOwnExits(db: Queryable, grant: AccessGrant, paging: Paging = {}) {
  const employeeId = ownEmployee(grant);
  const ids = await pageOf<{ id: string }>(
    db,
    `select id, submitted_at as hrms_submitted from exit_case where company_id = $1 and employee_id = $2`,
    [grant.companyId, employeeId],
    'hrms_submitted desc, id',
    paging,
    OWN_EXIT_LIST_CAP,
  );
  const items = [];
  for (const { id } of ids.items) items.push(await exitDetail(db, grant, id));
  return { ...pageMeta(ids), items };
}

/** Exit cases answered without page/pageSize (the list's first answer before it could page). */
export const EXIT_LIST_CAP = 200;

/** Exit cases within row scope, newest first: one page (FR-056), or the first 200 without page/pageSize; `total` counts all. */
/** FR-056: the exit list's sort keys and their columns in VIEW_SQL (dates are ISO text, so they sort as dates). No reason or message is a sort key. */
const EXIT_SORT_COLUMNS = { employeeCode: 'employee_code', employeeName: 'employee_name', state: 'state', requestDate: 'request_date', lastWorkingDate: 'leaving_date', submittedAt: 'submitted_at' } as const;
export const EXIT_SORTS = Object.keys(EXIT_SORT_COLUMNS);

export async function listExits(db: Queryable, grant: AccessGrant, filter: { state?: string | undefined; employeeId?: string | undefined } & Paging & Sorting) {
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'x.company_id', employee: 'x.employee_id' }, params);
  const where = [scope];
  if (filter.state) where.push(`x.state = ${params.add(filter.state)}`);
  if (filter.employeeId) where.push(`x.employee_id = ${params.add(filter.employeeId)}::uuid`);
  const page = await pageOf<Record<string, unknown> & ExitView>(db, `${VIEW_SQL} where ${where.join(' and ')}`, params.values, sortedBy(filter, EXIT_SORT_COLUMNS, 'submitted_at desc, id'), filter, EXIT_LIST_CAP);
  return { ...page, items: page.items.map((r) => present(grant, r)) };
}

export async function employeeExits(db: Queryable, grant: AccessGrant, employeeId: string, paging: Paging = {}) {
  await assertInScope(db, grant, employeeId);
  return listExits(db, grant, { employeeId, page: paging.page, pageSize: paging.pageSize });
}

/** The caller's exit tasks: manager recommendations, HR decisions and withdrawal decisions. */
export async function exitTasks(db: Queryable, grant: AccessGrant) {
  const tasks = [
    ...((await myOpenTasks(db, grant, EXIT_KIND)).items as { taskId: string; transactionId: string; kind: string; stepAction: string }[]),
    ...((await myOpenTasks(db, grant, WITHDRAWAL_KIND)).items as { taskId: string; transactionId: string; kind: string; stepAction: string }[]),
  ];
  const items = [];
  for (const t of tasks) {
    const id =
      t.kind === EXIT_KIND
        ? (await db.query<{ id: string }>(`select id from exit_case where company_id = $1 and transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0]?.id
        : (await db.query<{ id: string }>(`select exit_case_id as id from exit_withdrawal_request where company_id = $1 and transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0]?.id;
    const r = id ? (await db.query<ExitView>(`${VIEW_SQL} where x.company_id = $1 and x.id = $2`, [grant.companyId, id])).rows[0] : undefined;
    if (!r || !(await canAccessEmployee(db, grant, r.employee_id))) {
      items.push({ taskId: t.taskId, kind: t.kind, step: t.stepAction, exitCase: null });
      continue;
    }
    // A withdrawal decision task carries the request it decides (its reason under the exit reason group).
    const withdrawal =
      t.kind === WITHDRAWAL_KIND
        ? (
            await db.query<{ id: string; state: string; reason: string; created_at: Date }>(
              `select id, state, reason, created_at from exit_withdrawal_request where company_id = $1 and transaction_id = $2`,
              [grant.companyId, t.transactionId],
            )
          ).rows.map((w) => ({ id: w.id, state: w.state, ...(holds(grant, 'reason') ? { reason: w.reason } : {}), requestedAt: w.created_at }))[0] ?? null
        : undefined;
    items.push({ taskId: t.taskId, kind: t.kind, step: t.stepAction, exitCase: present(grant, r), ...(withdrawal !== undefined ? { withdrawal } : {}) });
  }
  return { items };
}
