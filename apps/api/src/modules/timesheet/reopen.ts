// F1 "Corrections need independent authorised reopen with history" / FR-047 "an approved entry cannot be changed
// without the owner-approved reopen route". Reopening an approved timesheet is its own transaction (kind
// timesheet_reopen): the employee, or a manager or HR user in scope, asks with a reason; an HR reviewer from the
// explicit list who is neither the requester, nor the employee, nor anyone who decided that timesheet approves or
// rejects it (C4). Approval opens the next revision as a draft with the approved lines carried over; the approved
// revision stays in force (and on record) until its correction is approved, so payroll can find both (BR-048).
import { enqueueEvent } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import { actorOf, audit } from './common.js';
import { lockSheet, openNextRevision, priorDecision, type SheetRow, taskIsPending, taskTransaction } from './sheets.js';

export const REOPEN_KIND = 'timesheet_reopen';

/** Users who decided any approval of the timesheet's transaction (independence of the reopen reviewer). */
async function decidersOf(tx: Queryable, companyId: string, transactionId: string): Promise<string[]> {
  return (
    await tx.query<{ u: string }>(
      `select distinct d.actor_user_id as u from approval_instance i
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
        where i.company_id = $1 and i.transaction_id = $2`,
      [companyId, transactionId],
    )
  ).rows.map((r) => r.u);
}

export async function requestReopen(tx: Queryable, grant: AccessGrant, timesheetId: string, input: { reason: string }) {
  const pre = (await tx.query<{ employee_id: string }>(`select employee_id from timesheet where company_id = $1 and id = $2`, [grant.companyId, timesheetId])).rows[0];
  if (!pre || !(await canAccessEmployee(tx, grant, pre.employee_id))) throw notFound();
  const s = (await lockSheet(tx, grant.companyId, 't.id = $2', [timesheetId]))!;
  if (s.state !== 'APPROVED') {
    throw new HttpError(409, 'INVALID_STATE', 'Only an approved timesheet is reopened; a draft, returned or rejected one is corrected directly', { state: s.state });
  }
  const open = await tx.query(`select 1 from timesheet_reopen_request where company_id = $1 and timesheet_id = $2 and state = 'SUBMITTED'`, [grant.companyId, s.id]);
  if ((open.rowCount ?? 0) > 0) throw new HttpError(409, 'REOPEN_PENDING', 'A reopen request for this timesheet is already waiting for a decision');
  const reason = input.reason.trim();
  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'SUBMITTED', $4, $4) returning id`,
      [grant.companyId, REOPEN_KIND, s.employee_id, grant.userId],
    )
  ).rows[0]!.id;
  const id = (
    await tx.query<{ id: string }>(
      `insert into timesheet_reopen_request (company_id, timesheet_id, employee_id, transaction_id, approved_revision, reason, requested_by, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, 'SUBMITTED', $7, $7) returning id`,
      [grant.companyId, s.id, s.employee_id, transactionId, s.approved_revision, reason, grant.userId],
    )
  ).rows[0]!.id;
  // C4: the engine never selects the employee; the requester and the timesheet's own deciders are excluded too.
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: REOPEN_KIND,
    transactionId,
    ownerEmployeeId: s.employee_id,
    actorUserId: grant.userId,
    excludeUserIds: [grant.userId, ...(await decidersOf(tx, grant.companyId, s.transaction_id))],
  });
  await audit(tx, actorOf(grant), 'timesheet_reopen_request', id, 'SUBMIT', null, { timesheetId: s.id, approvedRevision: s.approved_revision, state: 'SUBMITTED' }, { reason });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'timesheet_reopen.submitted',
    aggregateId: id,
    dedupeKey: `timesheet_reopen.submitted:${id}`,
    payload: { reopenRequestId: id, taskId },
  });
  return { reopenRequestId: id, timesheetId: s.id, approvedRevision: s.approved_revision, state: 'SUBMITTED' };
}

interface ReopenRow {
  id: string;
  timesheet_id: string;
  employee_id: string;
  transaction_id: string;
  approved_revision: number;
  requested_by: string;
  state: string;
}

export async function decideReopen(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: 'APPROVE' | 'REJECT'; reason?: string | undefined; idempotencyKey: string }) {
  const reason = input.reason?.trim() || null;
  if (input.decision === 'REJECT' && !reason) throw new HttpError(422, 'REASON_REQUIRED', 'Explain why the timesheet stays as approved');
  const transactionId = await taskTransaction(tx, grant, taskId, [REOPEN_KIND]);
  // Lock order: the reopen request's transaction, then the timesheet's.
  await lockTransaction(tx, transactionId);
  const r = (
    await tx.query<ReopenRow>(
      `select id, timesheet_id, employee_id, transaction_id, approved_revision, requested_by, state from timesheet_reopen_request where company_id = $1 and transaction_id = $2 for update`,
      [grant.companyId, transactionId],
    )
  ).rows[0];
  if (!r || !(await canAccessEmployee(tx, grant, r.employee_id))) throw notFound();
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { reopenRequestId: r.id, state: r.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (r.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This reopen request is not waiting for a decision');
  const s: SheetRow = (await lockSheet(tx, grant.companyId, 't.id = $2', [r.timesheet_id]))!;
  if (input.decision === 'APPROVE' && (s.state !== 'APPROVED' || s.approved_revision !== r.approved_revision)) {
    throw new HttpError(409, 'TIMESHEET_CHANGED', 'The timesheet is no longer the approved revision the request names');
  }

  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: reason ?? undefined, idempotencyKey: input.idempotencyKey, permission: { resource: 'timesheet', action: 'reopen' } });
  if (result.replayed) return { reopenRequestId: r.id, state: r.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { reopenRequestId: r.id, state: r.state, replayed: false };

  let newRevision: number | null = null;
  const state = result.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  if (state === 'APPROVED') {
    newRevision = await openNextRevision(tx, actorOf(grant), s, 'REOPENED', r.id);
    await audit(tx, actorOf(grant), 'timesheet', s.id, 'REOPEN', { state: 'APPROVED', revision: s.current_revision }, { state: 'DRAFT', revision: newRevision, reopenRequestId: r.id });
  }
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, r.transaction_id, state, grant.userId]);
  await tx.query(`update timesheet_reopen_request set state = $3, decided_at = now(), decided_by = $4, new_revision = $5, updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    r.id,
    state,
    grant.userId,
    newRevision,
  ]);
  await audit(tx, actorOf(grant), 'timesheet_reopen_request', r.id, input.decision, { state: 'SUBMITTED' }, { state, newRevision }, { reason });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'timesheet_reopen.decided',
    aggregateId: r.id,
    dedupeKey: `timesheet_reopen.decided:${r.id}`,
    payload: { reopenRequestId: r.id, outcome: state },
  });
  return { reopenRequestId: r.id, timesheetId: s.id, state, newRevision, replayed: false };
}

/** The reviewer's open reopen tasks with what each asks (operational only). */
export async function reopenTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, REOPEN_KIND)).items as { taskId: string; transactionId: string }[];
  if (tasks.length === 0) return { items: [] };
  const rows = (
    await db.query<{ transactionId: string; employeeId: string }>(
      `select r.transaction_id as "transactionId", r.id, r.timesheet_id as "timesheetId", r.employee_id as "employeeId", e.employee_code as "employeeCode",
              e.display_name as "employeeName", to_char(t.period_start, 'YYYY-MM-DD') as "periodStart", to_char(t.period_end, 'YYYY-MM-DD') as "periodEnd",
              r.approved_revision as "approvedRevision", r.reason, r.created_at as "requestedAt"
         from timesheet_reopen_request r
         join timesheet t on t.company_id = r.company_id and t.id = r.timesheet_id
         join employee e on e.company_id = r.company_id and e.id = r.employee_id
        where r.company_id = $1 and r.transaction_id = any($2::uuid[])`,
      [grant.companyId, tasks.map((t) => t.transactionId)],
    )
  ).rows;
  const items = [];
  for (const t of tasks) {
    const row = rows.find((x) => x.transactionId === t.transactionId);
    const visible = row !== undefined && (await canAccessEmployee(db, grant, row.employeeId));
    items.push({ ...t, request: visible ? row : null });
  }
  return { items };
}
