// Requisitions (DB060; FR-011, FR-012; F1 hiring route and states; DF03; DF08).
//
// The requester is the caller's own employee. A draft is edited only by its requester; submission pins an immutable
// revision with its budget check and starts the F1 route: the requester's direct manager validates (the explicit
// HR fallback list when the manager is missing or ineligible), then an independent HR Administrator approves the
// budget/headcount (never the requester or the validator, C4). A requisition beyond its budget (or without one)
// needs a recorded exception reason, re-checked at the HR approval, which must approve the exception explicitly.
// Return-for-edit (either step) sends the requisition back to DRAFT with the decision and reason kept; the next
// submission is a new revision with a new approval. A rejection is final and records approver, time and reason.
// Copying assigns a new reference and inherits no approval, decision or candidate.
import { enqueueEvent } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { cancelActiveApproval, type Decision, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import { type BudgetStatus, budgetFor, budgetPosition, budgetStatus } from './budget.js';
import {
  audit,
  checkVersion,
  cleanSkills,
  decisionHistory,
  isActiveEmployee,
  isPendingTaskOf,
  lockBudget,
  lockRequisition,
  newTransaction,
  nextCode,
  pageOf,
  pendingTaskOf,
  pendingWith,
  personSql,
  priorDecisionTask,
  referenceId,
  requireActiveMaster,
  requireDate,
  requireText,
  setRootState,
  taskTransaction,
} from './common.js';
import { admitsRequisition, canAccessRequisition, couldReview, requisitionScope, reviewersOutsideScope } from './scope.js';

export const REQUISITION_KIND = 'requisition';

export interface RequisitionInput {
  title: string;
  departmentId: string;
  locationId: string;
  designationId: string;
  employmentType: string;
  vacancies: number;
  reasonType: 'NEW' | 'REPLACEMENT';
  reason: string;
  skills?: string[] | undefined;
  targetDate: string;
  hiringManagerId: string;
  budgetExceptionReason?: string | null | undefined;
}

interface Values {
  title: string;
  departmentId: string;
  locationId: string;
  designationId: string;
  employmentTypeId: string;
  vacancies: number;
  reasonType: 'NEW' | 'REPLACEMENT';
  reason: string;
  skills: string[];
  targetDate: string;
  hiringManagerId: string;
  budgetExceptionReason: string | null;
}

interface RequisitionRow {
  id: string;
  code: string;
  transaction_id: string;
  requesting_employee_id: string;
  hiring_manager_id: string;
  title: string;
  department_id: string;
  location_id: string;
  designation_id: string;
  employment_type_id: string;
  employment_type: string;
  vacancies: number;
  reason_type: 'NEW' | 'REPLACEMENT';
  reason: string;
  skills: string[];
  target_date: string;
  budget_exception_reason: string | null;
  state: string;
  current_revision: number;
  bt_revision: number;
  version: number;
}

const ROW_COLUMNS = `r.id, r.code, r.transaction_id, r.requesting_employee_id, r.hiring_manager_id, r.title, r.department_id, r.location_id, r.designation_id,
  r.employment_type_id, (select code from reference_value et where et.company_id = r.company_id and et.id = r.employment_type_id) as employment_type,
  r.vacancies, r.reason_type, r.reason, r.skills, to_char(r.target_date, 'YYYY-MM-DD') as target_date, r.budget_exception_reason, r.state,
  r.current_revision, (select revision from business_transaction bt where bt.company_id = r.company_id and bt.id = r.transaction_id) as bt_revision, r.version`;

async function requireRequester(tx: Queryable, grant: AccessGrant): Promise<string> {
  if (!grant.linkedEmployeeId) throw new HttpError(422, 'REQUESTER_NOT_LINKED', 'A requisition is raised by an employee; this account has no employee record');
  if (!(await isActiveEmployee(tx, grant.companyId, grant.linkedEmployeeId))) throw new HttpError(422, 'REQUESTER_NOT_ACTIVE', 'Only an active employee can raise a requisition');
  return grant.linkedEmployeeId;
}

async function validate(tx: Queryable, grant: AccessGrant, input: RequisitionInput): Promise<Values> {
  await requireActiveMaster(tx, 'department', grant.companyId, input.departmentId);
  await requireActiveMaster(tx, 'location', grant.companyId, input.locationId);
  await requireActiveMaster(tx, 'designation', grant.companyId, input.designationId);
  const employmentTypeId = await referenceId(tx, grant.companyId, 'EMPLOYMENT_TYPE', input.employmentType);
  if (!(await isActiveEmployee(tx, grant.companyId, input.hiringManagerId))) {
    throw new HttpError(422, 'INVALID_HIRING_MANAGER', 'The hiring manager must be an active employee of this company', { field: 'hiringManagerId' });
  }
  const skills = cleanSkills(input.skills);
  if (skills.length > 50) throw new HttpError(422, 'TOO_MANY_SKILLS', 'List at most 50 skills');
  if (skills.some((s) => s.length > 100)) throw new HttpError(422, 'INVALID_FIELD', 'A skill is at most 100 characters', { field: 'skills' });
  return {
    title: requireText(input.title, 'title'),
    departmentId: input.departmentId,
    locationId: input.locationId,
    designationId: input.designationId,
    employmentTypeId,
    vacancies: input.vacancies,
    reasonType: input.reasonType,
    reason: requireText(input.reason, 'reason'),
    skills,
    targetDate: requireDate(input.targetDate, 'targetDate'),
    hiringManagerId: input.hiringManagerId,
    budgetExceptionReason: input.budgetExceptionReason?.trim() || null,
  };
}

const operational = (v: Values, employmentType: string) => ({
  title: v.title,
  departmentId: v.departmentId,
  locationId: v.locationId,
  designationId: v.designationId,
  employmentType,
  vacancies: v.vacancies,
  reasonType: v.reasonType,
  reason: v.reason,
  skills: v.skills,
  targetDate: v.targetDate,
  hiringManagerId: v.hiringManagerId,
  budgetExceptionReason: v.budgetExceptionReason,
});

async function insertRequisition(tx: Queryable, grant: AccessGrant, requesterId: string, v: Values, employmentType: string, copiedFrom: string | null) {
  if (!admitsRequisition(grant, { requesterId, hiringManagerId: v.hiringManagerId, departmentId: v.departmentId, locationId: v.locationId })) {
    throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  }
  const code = await nextCode(tx, grant.companyId, 'REQUISITION', grant.userId);
  const transactionId = await newTransaction(tx, grant.companyId, REQUISITION_KIND, requesterId, grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into requisition (company_id, code, transaction_id, requesting_employee_id, hiring_manager_id, title, department_id, location_id, designation_id,
                                employment_type_id, vacancies, reason_type, reason, skills, target_date, budget_exception_reason, copied_from_requisition_id,
                                state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'DRAFT', $18, $18) returning id`,
      [
        grant.companyId,
        code,
        transactionId,
        requesterId,
        v.hiringManagerId,
        v.title,
        v.departmentId,
        v.locationId,
        v.designationId,
        v.employmentTypeId,
        v.vacancies,
        v.reasonType,
        v.reason,
        v.skills,
        v.targetDate,
        v.budgetExceptionReason,
        copiedFrom,
        grant.userId,
      ],
    )
  ).rows[0]!.id;
  await audit(tx, grant, 'requisition', id, copiedFrom ? 'COPY' : 'CREATE', null, { code, ...operational(v, employmentType), copiedFromRequisitionId: copiedFrom, state: 'DRAFT' });
  return id;
}

export async function createRequisition(tx: Queryable, grant: AccessGrant, input: RequisitionInput): Promise<string> {
  const requesterId = await requireRequester(tx, grant);
  const v = await validate(tx, grant, input);
  return insertRequisition(tx, grant, requesterId, v, input.employmentType, null);
}

/** FR-011: a copy keeps the permitted job details only; it gets a new reference and no approval or candidate history. */
export async function copyRequisition(tx: Queryable, grant: AccessGrant, sourceId: string): Promise<string> {
  const source = await readRow(tx, grant.companyId, sourceId);
  if (!source || !(await canAccessRequisition(tx, grant, sourceId))) throw notFound();
  const requesterId = await requireRequester(tx, grant);
  const v = await validate(tx, grant, {
    title: source.title,
    departmentId: source.department_id,
    locationId: source.location_id,
    designationId: source.designation_id,
    employmentType: source.employment_type,
    vacancies: source.vacancies,
    reasonType: source.reason_type,
    reason: source.reason,
    skills: source.skills,
    targetDate: source.target_date,
    hiringManagerId: source.hiring_manager_id,
    // The budget exception belongs to the source's approval journey; a copy states its own if it needs one.
    budgetExceptionReason: null,
  });
  return insertRequisition(tx, grant, requesterId, v, source.employment_type, source.id);
}

async function readRow(db: Queryable, companyId: string, id: string, forUpdate = false): Promise<RequisitionRow | undefined> {
  return (await db.query<RequisitionRow>(`select ${ROW_COLUMNS} from requisition r where r.company_id = $1 and r.id = $2 ${forUpdate ? 'for update' : ''}`, [companyId, id])).rows[0];
}

/** The caller's own requisition (as requester), locked behind its transaction lock. */
async function lockOwn(tx: Queryable, grant: AccessGrant, id: string): Promise<RequisitionRow> {
  const target = (await tx.query<{ transaction_id: string; requesting_employee_id: string }>(`select transaction_id, requesting_employee_id from requisition where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!target || !(await canAccessRequisition(tx, grant, id))) throw notFound();
  if (!grant.linkedEmployeeId || target.requesting_employee_id !== grant.linkedEmployeeId) {
    throw new HttpError(403, 'NOT_REQUESTER', 'Only the requester can change, submit, withdraw or discard this requisition');
  }
  await lockTransaction(tx, target.transaction_id);
  return (await readRow(tx, grant.companyId, id, true))!;
}

export async function updateRequisition(tx: Queryable, grant: AccessGrant, id: string, input: RequisitionInput & { expectedVersion: number }) {
  const r = await lockOwn(tx, grant, id);
  if (r.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft can be changed; a submitted requisition is kept as it was sent');
  checkVersion(r.version, input.expectedVersion);
  const v = await validate(tx, grant, input);
  if (!admitsRequisition(grant, { requesterId: r.requesting_employee_id, hiringManagerId: v.hiringManagerId, departmentId: v.departmentId, locationId: v.locationId })) {
    throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  }
  await tx.query(
    `update requisition set title = $3, department_id = $4, location_id = $5, designation_id = $6, employment_type_id = $7, vacancies = $8, reason_type = $9,
            reason = $10, skills = $11, target_date = $12, hiring_manager_id = $13, budget_exception_reason = $14, updated_by = $15
      where company_id = $1 and id = $2`,
    [grant.companyId, r.id, v.title, v.departmentId, v.locationId, v.designationId, v.employmentTypeId, v.vacancies, v.reasonType, v.reason, v.skills, v.targetDate, v.hiringManagerId, v.budgetExceptionReason, grant.userId],
  );
  const before = operational(
    {
      title: r.title,
      departmentId: r.department_id,
      locationId: r.location_id,
      designationId: r.designation_id,
      employmentTypeId: r.employment_type_id,
      vacancies: r.vacancies,
      reasonType: r.reason_type,
      reason: r.reason,
      skills: r.skills,
      targetDate: r.target_date,
      hiringManagerId: r.hiring_manager_id,
      budgetExceptionReason: r.budget_exception_reason,
    },
    r.employment_type,
  );
  await audit(tx, grant, 'requisition', r.id, 'UPDATE', before, operational(v, input.employmentType));
  return r.id;
}

interface BudgetCheck {
  budgetId: string | null;
  status: BudgetStatus;
  approvedHeadcount: number | null;
  committed: number;
  requested: number;
}

/**
 * The budget check of a requisition's values now (a requisition not yet created has no id); the caller holds the
 * budget lock when it acts on the result.
 */
async function checkBudget(
  tx: Queryable,
  companyId: string,
  r: Pick<RequisitionRow, 'department_id' | 'location_id' | 'designation_id' | 'target_date' | 'vacancies'> & { id: string | null },
  lock: boolean,
): Promise<BudgetCheck> {
  const budgetId = await budgetFor(tx, companyId, r.department_id, r.location_id, r.designation_id, r.target_date);
  if (budgetId && lock) await lockBudget(tx, companyId, budgetId);
  const position = await budgetPosition(tx, companyId, budgetId, r.id);
  return { budgetId, status: budgetStatus(position, r.vacancies), approvedHeadcount: position.approvedHeadcount, committed: position.committed, requested: r.vacancies };
}

const budgetDetails = (c: BudgetCheck) => ({ budgetStatus: c.status, approvedHeadcount: c.approvedHeadcount, committed: c.committed, requested: c.requested });

/** The users linked to the employee's current direct manager (the engine's DIRECT_MANAGER candidate). */
async function directManagerUsers(tx: Queryable, companyId: string, employeeId: string): Promise<string[]> {
  return (
    await tx.query<{ user_id: string }>(
      `with d as (select hrms_business_date($1, now()) as day)
       select l.user_id
         from d, manager_assignment ma
         join user_employee_link l on l.company_id = ma.company_id and l.employee_id = ma.manager_employee_id
        where ma.company_id = $1 and ma.employee_id = $2
          and ma.effective_from <= d.day and (ma.effective_to is null or ma.effective_to > d.day)
          and l.effective_from <= d.day and (l.effective_to is null or l.effective_to > d.day)`,
      [companyId, employeeId],
    )
  ).rows.map((row) => row.user_id);
}

async function requireStillValid(tx: Queryable, companyId: string, r: RequisitionRow): Promise<void> {
  await requireActiveMaster(tx, 'department', companyId, r.department_id);
  await requireActiveMaster(tx, 'location', companyId, r.location_id);
  await requireActiveMaster(tx, 'designation', companyId, r.designation_id);
  const type = await tx.query(`select 1 from reference_value where company_id = $1 and id = $2 and active`, [companyId, r.employment_type_id]);
  if (!type.rowCount) throw new HttpError(422, 'INVALID_REFERENCE', 'The employment type is no longer active');
  if (!(await isActiveEmployee(tx, companyId, r.hiring_manager_id))) throw new HttpError(422, 'INVALID_HIRING_MANAGER', 'The hiring manager is no longer an active employee');
}

export async function submitRequisition(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  const r = await lockOwn(tx, grant, id);
  if (r.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft can be submitted');
  checkVersion(r.version, input.expectedVersion);
  if (!(await isActiveEmployee(tx, grant.companyId, r.requesting_employee_id))) throw new HttpError(422, 'REQUESTER_NOT_ACTIVE', 'Only an active employee can raise a requisition');
  await requireStillValid(tx, grant.companyId, r);
  const check = await checkBudget(tx, grant.companyId, r, true);
  if (check.status !== 'WITHIN_BUDGET' && !r.budget_exception_reason) {
    throw new HttpError(422, 'BUDGET_EXCEPTION_REASON_REQUIRED', 'The requisition exceeds its approved budget; record why an exception is needed', budgetDetails(check));
  }
  const revision = r.current_revision + 1;
  await tx.query(`update business_transaction set revision = greatest(revision, $3), state = 'SUBMITTED', updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    r.transaction_id,
    revision,
    grant.userId,
  ]);
  await tx.query(
    `insert into requisition_revision (company_id, requisition_id, revision, title, department_id, location_id, designation_id, employment_type_id, vacancies,
                                       reason_type, reason, skills, target_date, hiring_manager_id, budget_id, budget_status, budget_headcount, budget_committed,
                                       budget_exception_reason, submitted_by, created_by)
     select company_id, id, $3::int, title, department_id, location_id, designation_id, employment_type_id, vacancies, reason_type, reason, skills, target_date,
            hiring_manager_id, $4::uuid, $5::text, $6::int, $7::int, budget_exception_reason, $8::uuid, $8::uuid
       from requisition where company_id = $1 and id = $2`,
    [grant.companyId, r.id, revision, check.budgetId, check.status, check.approvedHeadcount, check.committed, grant.userId],
  );
  await tx.query(`update requisition set state = 'SUBMITTED', current_revision = $3, budget_id = $4, submitted_at = now(), updated_by = $5 where company_id = $1 and id = $2`, [
    grant.companyId,
    r.id,
    revision,
    check.budgetId,
    grant.userId,
  ]);
  // F1 step 1: the requester's direct manager (HR fallback list when ineligible); the requester never decides, and
  // nobody who could not open this requisition is routed to (DF03, I-25).
  const outsideScope = await reviewersOutsideScope(tx, grant.companyId, REQUISITION_KIND, (g) => canAccessRequisition(tx, g, r.id), await directManagerUsers(tx, grant.companyId, r.requesting_employee_id));
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: REQUISITION_KIND,
    transactionId: r.transaction_id,
    ownerEmployeeId: r.requesting_employee_id,
    actorUserId: grant.userId,
    excludeUserIds: [grant.userId, ...outsideScope],
  });
  await audit(tx, grant, 'requisition', r.id, r.current_revision > 0 ? 'RESUBMIT' : 'SUBMIT', { state: 'DRAFT' }, { state: 'SUBMITTED', revision, ...budgetDetails(check) });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'hiring.requisition.submitted',
    aggregateId: r.id,
    dedupeKey: `hiring.requisition.submitted:${r.id}:${revision}:1`,
    payload: { requisitionId: r.id, taskId, revision, step: 1 },
  });
  return { requisitionId: r.id, state: 'SUBMITTED', revision, ...budgetDetails(check) };
}

/** DF03: withdrawal before a final decision cancels the approval and returns the requisition to its requester's draft. */
export async function withdrawRequisition(tx: Queryable, grant: AccessGrant, id: string) {
  const r = await lockOwn(tx, grant, id);
  if (r.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'Only a requisition waiting for a decision can be withdrawn');
  const pending = await pendingTaskOf(tx, grant.companyId, r.transaction_id);
  await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
  await setRootState(tx, 'requisition', grant.companyId, r, 'DRAFT', grant.userId);
  await audit(tx, grant, 'requisition', r.id, 'WITHDRAW', { state: 'SUBMITTED', revision: r.current_revision }, { state: 'DRAFT' });
  if (pending) {
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'hiring.requisition.withdrawn',
      aggregateId: r.id,
      dedupeKey: `hiring.requisition.withdrawn:${r.id}:${r.current_revision}`,
      payload: { requisitionId: r.id, userId: pending.assignee_user_id, revision: r.current_revision },
    });
  }
  return { requisitionId: r.id, state: 'DRAFT' };
}

/** DF08: an unsubmitted draft is cancelled and kept (CLOSED), never deleted. */
export async function discardRequisition(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string }) {
  const r = await lockOwn(tx, grant, id);
  if (r.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft can be discarded; withdraw a submitted requisition first');
  const reason = requireText(input.reason, 'reason');
  await setRootState(tx, 'requisition', grant.companyId, r, 'CLOSED', grant.userId, ', closed_by = $4, closed_at = now(), closure_reason = $5', [reason]);
  await audit(tx, grant, 'requisition', r.id, 'DISCARD', { state: 'DRAFT' }, { state: 'CLOSED' }, reason);
  return { requisitionId: r.id, state: 'CLOSED' };
}

/** HR closes an approved requisition (filled or no longer needed); live offers must be finished first. */
export async function closeRequisition(tx: Queryable, grant: AccessGrant, id: string, input: { reason: string }) {
  const target = (await tx.query<{ transaction_id: string }>(`select transaction_id from requisition where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!target || !(await canAccessRequisition(tx, grant, id))) throw notFound();
  const reason = requireText(input.reason, 'reason');
  await lockTransaction(tx, target.transaction_id);
  await lockRequisition(tx, grant.companyId, id);
  const r = (await readRow(tx, grant.companyId, id, true))!;
  if (r.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only an approved requisition can be closed');
  const live = await tx.query(
    `select 1 from hiring_offer o where o.company_id = $1 and o.requisition_id = $2
        and (o.state in ('DRAFT', 'SUBMITTED', 'APPROVED')
             or (o.state = 'ACCEPTED' and not exists (select 1 from hiring_handover h where h.company_id = o.company_id and h.offer_id = o.id)))`,
    [grant.companyId, id],
  );
  if (live.rowCount) throw new HttpError(409, 'OPEN_OFFERS', 'Finish, withdraw or hand over the open offers before closing the requisition');
  // HR's closing decision re-checks its duty after the locks (docs/09 §6.5): a narrowing since the route guard refuses.
  await reassertAccess(tx, grant, 'requisition', 'close', ['operational']);
  await setRootState(tx, 'requisition', grant.companyId, r, 'CLOSED', grant.userId, ', closed_by = $4, closed_at = now(), closure_reason = $5', [reason]);
  await audit(tx, grant, 'requisition', r.id, 'CLOSE', { state: 'APPROVED' }, { state: 'CLOSED' }, reason);
  // DF12 "cancelled": the requester is told their approved requisition was closed (never the reason).
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'hiring.requisition.closed',
    aggregateId: r.id,
    dedupeKey: `hiring.requisition.closed:${r.id}`,
    payload: { requisitionId: r.id, revision: r.current_revision },
  });
  return { requisitionId: r.id, state: 'CLOSED' };
}

// ---------------------------------------------------------------------------------------------------------
// Decisions (F1 route)
// ---------------------------------------------------------------------------------------------------------

export interface RequisitionDecisionInput {
  decision: Decision;
  reason?: string | undefined;
  /** Explicit HR approval of a recorded budget exception (FR-011), required when the requisition exceeds its budget. */
  approveBudgetException?: boolean | undefined;
  idempotencyKey: string;
}

/** The step action (validate or approve) of a pending requisition task assigned to the user, if any. */
export async function requisitionTaskAction(db: Queryable, companyId: string, userId: string, taskId: string): Promise<'validate' | 'approve' | null> {
  const row = (
    await db.query<{ action: string }>(
      `select p.action from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.transaction_kind = 'requisition'
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id join permission p on p.id = s.permission_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [companyId, taskId, userId],
    )
  ).rows[0];
  return row?.action === 'validate' || row?.action === 'approve' ? row.action : null;
}

export async function decideRequisition(tx: Queryable, grant: AccessGrant, taskId: string, action: 'validate' | 'approve', input: RequisitionDecisionInput) {
  if (input.decision !== 'APPROVE' && !input.reason?.trim()) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the requisition is rejected or returned');
  const transactionId = await taskTransaction(tx, grant.companyId, taskId, grant.userId, REQUISITION_KIND);
  if (!transactionId) throw notFound();
  await lockTransaction(tx, transactionId);
  const id = (await tx.query<{ id: string }>(`select id from requisition where company_id = $1 and transaction_id = $2`, [grant.companyId, transactionId])).rows[0]?.id;
  if (!id || !(await canAccessRequisition(tx, grant, id))) throw notFound();
  const r = (await readRow(tx, grant.companyId, id, true))!;
  const prior = await priorDecisionTask(tx, grant.companyId, input.idempotencyKey);
  if (prior) {
    if (prior !== taskId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another task');
    return { requisitionId: r.id, state: r.state, replayed: true };
  }
  if (!(await isPendingTaskOf(tx, grant.companyId, taskId, grant.userId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (r.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This requisition is not waiting for a decision');

  // F1 HR budget/headcount approval: the budget is checked again under its lock; an exceeded budget needs the
  // recorded exception and this approver's explicit approval of it.
  let check: BudgetCheck | null = null;
  let exceptionApproved = false;
  if (action === 'approve' && input.decision === 'APPROVE') {
    const revision = (
      await tx.query<{ budget_exception_reason: string | null }>(`select budget_exception_reason from requisition_revision where company_id = $1 and requisition_id = $2 and revision = $3`, [
        grant.companyId,
        r.id,
        r.current_revision,
      ])
    ).rows[0];
    check = await checkBudget(tx, grant.companyId, r, true);
    if (check.status !== 'WITHIN_BUDGET') {
      if (!revision?.budget_exception_reason) {
        throw new HttpError(409, 'BUDGET_EXCEPTION_REQUIRED', 'The requisition now exceeds its budget and records no exception; return it to the requester', budgetDetails(check));
      }
      if (input.approveBudgetException !== true) {
        throw new HttpError(422, 'BUDGET_EXCEPTION_DECISION_REQUIRED', 'The requisition exceeds its budget; approve the budget exception explicitly or return/reject it', budgetDetails(check));
      }
      exceptionApproved = true;
    }
  }

  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'requisition', action } });
  if (result.replayed) return { requisitionId: r.id, state: r.state, replayed: true };

  if (result.outcome === 'NEXT_STEP') {
    const next = await pendingTaskOf(tx, grant.companyId, r.transaction_id);
    // DF03/I-25: the engine chose the HR approver by their scope over the requester; the approver must also be able
    // to open this requisition (scoped by its own department and location). Otherwise nothing is recorded and the
    // routing is repaired first (the list is reordered or corrected), as when nobody is eligible.
    if (next && !(await couldReview(tx, grant.companyId, next.assignee_user_id, { resource: next.resource, action: next.action, fieldGroup: next.field_group }, (g) => canAccessRequisition(tx, g, r.id)))) {
      throw new HttpError(422, 'NO_ELIGIBLE_REVIEWER', 'No eligible reviewer is configured for this request; contact HR to repair routing');
    }
    await audit(tx, grant, 'requisition', r.id, 'VALIDATE', { state: 'SUBMITTED', step: 1 }, { state: 'SUBMITTED', step: 2, revision: r.current_revision });
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'hiring.requisition.submitted',
      aggregateId: r.id,
      dedupeKey: `hiring.requisition.submitted:${r.id}:${r.current_revision}:2`,
      payload: { requisitionId: r.id, taskId: next?.id ?? null, revision: r.current_revision, step: 2 },
    });
    return { requisitionId: r.id, state: 'SUBMITTED', pendingStep: 2, replayed: false };
  }

  let state: string;
  if (result.outcome === 'APPROVED') {
    state = 'APPROVED';
    await setRootState(
      tx,
      'requisition',
      grant.companyId,
      r,
      'APPROVED',
      grant.userId,
      `, decided_by = $4, decided_at = now(), budget_id = coalesce($5::uuid, budget_id)${exceptionApproved ? ', budget_exception_approved_by = $4, budget_exception_approved_at = now()' : ''}`,
      [check?.budgetId ?? null],
    );
  } else if (result.outcome === 'REJECTED') {
    state = 'REJECTED';
    await setRootState(tx, 'requisition', grant.companyId, r, 'REJECTED', grant.userId, ', decided_by = $4, decided_at = now()');
  } else {
    // Return-for-edit: back to the requester's draft; the next submission is a new revision.
    state = 'DRAFT';
    await setRootState(tx, 'requisition', grant.companyId, r, 'DRAFT', grant.userId);
  }
  await audit(
    tx,
    grant,
    'requisition',
    r.id,
    input.decision === 'APPROVE' ? 'APPROVE' : input.decision,
    { state: 'SUBMITTED', revision: r.current_revision },
    { state, ...(check ? { ...budgetDetails(check), budgetExceptionApproved: exceptionApproved } : {}) },
    input.reason ?? null,
  );
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'hiring.requisition.decided',
    aggregateId: r.id,
    dedupeKey: `hiring.requisition.decided:${r.id}:${r.current_revision}`,
    payload: { requisitionId: r.id, outcome: result.outcome, revision: r.current_revision },
  });
  return { requisitionId: r.id, state, replayed: false };
}

// ---------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------

const VIEW_SELECT = `select r.id, r.code, r.title, r.state, r.vacancies, r.reason_type as "reasonType", r.reason, r.skills, to_char(r.target_date, 'YYYY-MM-DD') as "targetDate",
       json_build_object('id', r.department_id, 'name', d.name) as department, json_build_object('id', r.location_id, 'name', l.name) as location,
       json_build_object('id', r.designation_id, 'name', g.name) as designation, et.code as "employmentType",
       json_build_object('id', re.id, 'employeeCode', re.employee_code, 'displayName', re.display_name) as requester,
       json_build_object('id', hm.id, 'employeeCode', hm.employee_code, 'displayName', hm.display_name) as "hiringManager",
       r.budget_id as "budgetId", r.budget_exception_reason as "budgetExceptionReason", r.current_revision as "currentRevision", r.copied_from_requisition_id as "copiedFromRequisitionId",
       r.budget_exception_approved_by as "budgetExceptionApprovedBy", r.budget_exception_approved_at as "budgetExceptionApprovedAt",
       ${personSql('r.company_id', 'r.budget_exception_approved_by', 'r.budget_exception_approved_at')} as "budgetExceptionApprovedByPerson",
       r.submitted_at as "submittedAt", r.decided_by as "decidedBy", r.decided_at as "decidedAt",
       ${personSql('r.company_id', 'r.decided_by', 'r.decided_at')} as "decidedByPerson", r.closed_at as "closedAt", r.closure_reason as "closureReason",
       (select count(*)::int from hiring_offer o where o.company_id = r.company_id and o.requisition_id = r.id and o.state = 'ACCEPTED') as filled,
       r.created_at as "createdAt", r.version, r.transaction_id, r.department_id, r.location_id, r.designation_id, to_char(r.target_date, 'YYYY-MM-DD') as target_date
  from requisition r
  join department d on d.company_id = r.company_id and d.id = r.department_id
  join location l on l.company_id = r.company_id and l.id = r.location_id
  join designation g on g.company_id = r.company_id and g.id = r.designation_id
  join reference_value et on et.company_id = r.company_id and et.id = r.employment_type_id
  join employee re on re.company_id = r.company_id and re.id = r.requesting_employee_id
  join employee hm on hm.company_id = r.company_id and hm.id = r.hiring_manager_id`;

type ViewRow = Record<string, unknown> & { id: string; transaction_id: string; department_id: string; location_id: string; designation_id: string; target_date: string; vacancies: number; state: string };

const strip = ({ transaction_id: _t, department_id: _d, location_id: _l, designation_id: _g, target_date: _x, ...rest }: ViewRow) => rest;

export async function getRequisition(db: Queryable, grant: AccessGrant, id: string) {
  const p = new SqlParams([id]);
  const row = (await db.query<ViewRow>(`${VIEW_SELECT} where r.id = $1 and ${requisitionScope(grant, 'r', p)}`, p.values)).rows[0];
  if (!row) return null;
  const revisions = (
    await db.query(
      `select rv.revision, rv.vacancies, to_char(rv.target_date, 'YYYY-MM-DD') as "targetDate", rv.budget_id as "budgetId", rv.budget_status as "budgetStatus",
              rv.budget_headcount as "approvedHeadcount", rv.budget_committed as committed, rv.budget_exception_reason as "budgetExceptionReason",
              rv.submitted_by as "submittedBy", ${personSql('rv.company_id', 'rv.submitted_by', 'rv.submitted_at')} as "submittedByPerson", rv.submitted_at as "submittedAt"
         from requisition_revision rv where rv.company_id = $1 and rv.requisition_id = $2 order by rv.revision`,
      [grant.companyId, id],
    )
  ).rows;
  const check =
    row.state === 'DRAFT' || row.state === 'SUBMITTED'
      ? budgetDetails(
          await checkBudget(db, grant.companyId, { id: row.id, department_id: row.department_id, location_id: row.location_id, designation_id: row.designation_id, target_date: row.target_date, vacancies: row.vacancies }, false),
        )
      : null;
  return {
    ...strip(row),
    budgetCheck: check,
    revisions,
    decisions: await decisionHistory(db, grant.companyId, row.transaction_id),
    pendingWith: await pendingWith(db, grant.companyId, row.transaction_id),
  };
}

export interface RequisitionListQuery {
  state?: string | undefined;
  departmentId?: string | undefined;
  search?: string | undefined;
  page: number;
  pageSize: number;
}

export async function listRequisitions(db: Queryable, grant: AccessGrant, q: RequisitionListQuery) {
  const p = new SqlParams();
  const where = [requisitionScope(grant, 'r', p)];
  if (q.state) where.push(`r.state = ${p.add(q.state)}`);
  if (q.departmentId) where.push(`r.department_id = ${p.add(q.departmentId)}::uuid`);
  if (q.search?.trim()) {
    const pattern = p.add(`%${q.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(r.code ilike ${pattern} or r.title ilike ${pattern})`);
  }
  const page = await pageOf(db, `${VIEW_SELECT} where ${where.join(' and ')}`, p.values, `"createdAt" desc, id`, { page: q.page, pageSize: q.pageSize }, q.pageSize);
  return { items: page.items.map((r) => strip(r as ViewRow)), total: page.total, page: q.page, pageSize: q.pageSize };
}

export interface BudgetPreviewQuery {
  departmentId: string;
  locationId: string;
  designationId: string;
  targetDate: string;
  vacancies: number;
}

/**
 * FR-011: the budget check a new requisition with these values would get now, so the form can ask for an exception
 * reason before the draft exists. Nothing is recorded or locked; the submission and the HR approval check again. The
 * values are admitted as a creation would admit them, so it shows nothing a draft would not.
 */
export async function previewBudgetCheck(db: Queryable, grant: AccessGrant, q: BudgetPreviewQuery) {
  const requesterId = await requireRequester(db, grant);
  if (!admitsRequisition(grant, { requesterId, hiringManagerId: requesterId, departmentId: q.departmentId, locationId: q.locationId })) {
    throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  }
  await requireActiveMaster(db, 'department', grant.companyId, q.departmentId);
  await requireActiveMaster(db, 'location', grant.companyId, q.locationId);
  await requireActiveMaster(db, 'designation', grant.companyId, q.designationId);
  const check = await checkBudget(
    db,
    grant.companyId,
    { id: null, department_id: q.departmentId, location_id: q.locationId, designation_id: q.designationId, target_date: requireDate(q.targetDate, 'targetDate'), vacancies: q.vacancies },
    false,
  );
  return { ...budgetDetails(check), budgetExceptionReasonRequired: check.status !== 'WITHIN_BUDGET' };
}

/** The caller's requisition tasks with what each decides (operational fields and the budget check). */
export async function requisitionTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, REQUISITION_KIND)).items as { taskId: string; transactionId: string; step: number; stepAction: string; assignedAt: Date }[];
  const items = [];
  for (const t of tasks) {
    const id = (await db.query<{ id: string }>(`select id from requisition where company_id = $1 and transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0]?.id;
    const view = id ? await getRequisition(db, grant, id) : null;
    items.push({ taskId: t.taskId, transactionId: t.transactionId, step: t.step, stepAction: t.stepAction, assignedAt: t.assignedAt, requisition: view });
  }
  return { items };
}
