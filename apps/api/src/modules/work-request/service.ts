// Outdoor duty and work-on-holiday requests (FR-027; DF03; DF05). Each kind is its own typed transaction with
// its own states, reviewed on the leave route (direct manager, HR fallback). Neither is leave: no leave
// balance moves. Approved outdoor duty changes the day's attendance outcome when the day is evaluated;
// approved holiday work is recorded only, because no compensatory policy is configured (FR-027 acceptance).
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { assertUsableEvidence, EVIDENCE_JSON, linkEvidence, revisionEvidence } from '../employee/evidence.js';
import { lastWorkingDateOf, lockEmployeeDays, MANAGER_BACKDATE_LIMIT_DAYS, refuseAfterLastWorkingDate, workingDays } from '../leave/service.js';
import { cancelActiveApproval, type Decision, decideTask, lockTransaction, startApproval } from '../workflow/engine.js';
import { predecessorRequestSql, rejectedPredecessor } from '../workflow/predecessor.js';

export const WORK_REQUEST_KINDS = {
  outdoor_duty: { table: 'outdoor_duty_request', label: 'outdoor duty' },
  holiday_work: { table: 'holiday_work_request', label: 'holiday work' },
} as const;
export type WorkRequestKind = keyof typeof WORK_REQUEST_KINDS;
export const isWorkRequestKind = (k: string): k is WorkRequestKind => k in WORK_REQUEST_KINDS;

const ACTIVE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'];

export interface WorkRequestInput {
  startDate: string;
  endDate: string;
  startTime?: string | undefined;
  endTime?: string | undefined;
  purpose: string;
  /** FR-027 supporting evidence: the requester's own usable documents (FR-106). */
  evidenceDocumentIds?: string[] | undefined;
  /** DF03: the rejected request this one raises again (workflow/predecessor.ts); named once, at creation. */
  predecessorRequestId?: string | undefined;
}

interface Row {
  id: string;
  employee_id: string;
  transaction_id: string;
  state: string;
  version: number;
  revision: number;
  start_date: string;
  end_date: string;
}

/** Transaction lock first (see lockTransaction), then the row locks, so concurrent paths cannot deadlock. */
async function lockRow(tx: Queryable, kind: WorkRequestKind, companyId: string, where: string, params: unknown[]): Promise<Row | undefined> {
  const target = (await tx.query<{ transaction_id: string }>(`select r.transaction_id from ${WORK_REQUEST_KINDS[kind].table} r where r.company_id = $1 and ${where}`, [companyId, ...params])).rows[0];
  if (!target) return undefined;
  await lockTransaction(tx, target.transaction_id);
  return (
    await tx.query<Row>(
      `select r.id, r.employee_id, r.transaction_id, r.state, r.version, bt.revision, to_char(r.start_date, 'YYYY-MM-DD') as start_date,
              to_char(r.end_date, 'YYYY-MM-DD') as end_date
         from ${WORK_REQUEST_KINDS[kind].table} r join business_transaction bt on bt.company_id = r.company_id and bt.id = r.transaction_id
        where r.company_id = $1 and ${where} for update of r, bt`,
      [companyId, ...params],
    )
  ).rows[0];
}

/** Validates one submission and returns the reviewer routing (DF05 back-dating rule applies as for leave). */
async function check(tx: Queryable, grant: AccessGrant, kind: WorkRequestKind, employeeId: string, input: WorkRequestInput) {
  if (input.endDate < input.startDate) throw new HttpError(422, 'RULE_VIOLATION', 'End date is before start date');
  if (!!input.startTime !== !!input.endTime) throw new HttpError(422, 'RULE_VIOLATION', 'Give both a start and an end time, or neither');
  // A timed window is requested on its start date. An outdoor-duty window may cross midnight (an end before the
  // start ends on the next day, for night shifts; DF05); holiday work stays within its off day.
  if (input.startTime && (input.startDate !== input.endDate || input.endTime === input.startTime || (kind === 'holiday_work' && input.endTime! < input.startTime))) {
    throw new HttpError(422, 'RULE_VIOLATION', 'A timed request covers one start date and must not be empty');
  }
  if (kind === 'holiday_work' && input.startDate !== input.endDate) throw new HttpError(422, 'RULE_VIOLATION', 'Holiday work is requested one day at a time');
  // Serialises this check with leave submissions for the same employee (I-05 holds on both sides).
  await lockEmployeeDays(tx, employeeId);

  const employee = (
    await tx.query<{ joining_date: string; status: string; age: number; last_working_date: string | null }>(
      `select to_char(e.joining_date, 'YYYY-MM-DD') as joining_date, st.code as status, (hrms_business_date(e.company_id, now()) - $3::date) as age,
              to_char(hrms_exit_last_working_date(e.company_id, e.id), 'YYYY-MM-DD') as last_working_date
         from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id where e.company_id = $1 and e.id = $2`,
      [grant.companyId, employeeId, input.startDate],
    )
  ).rows[0];
  if (!employee || !ACTIVE_STATUSES.includes(employee.status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only active employees can make work requests');
  if (input.startDate < employee.joining_date) throw new HttpError(422, 'RULE_VIOLATION', 'The request cannot start before the joining date');
  // DF04 / FR-051: attendance eligibility stops after the approved (inclusive) last working date, as for leave.
  refuseAfterLastWorkingDate(employee.last_working_date, input.endDate, 'The request cannot extend past the approved last working date');

  const days = await workingDays(tx, grant.companyId, employeeId, input.startDate, input.endDate);
  if (kind === 'outdoor_duty' && days === 0) throw new HttpError(422, 'NO_WORKING_DAYS', 'Outdoor duty covers working days; use holiday work for an off day');
  if (kind === 'holiday_work' && days > 0) throw new HttpError(422, 'NOT_AN_OFF_DAY', 'The date is a working day for this employee');
  if (kind === 'outdoor_duty') {
    // Approved leave would override the duty, so the two cannot be live on the same day.
    const leave = await tx.query(
      `select 1 from leave_request where company_id = $1 and employee_id = $2 and state in ('SUBMITTED', 'RETURNED', 'APPROVED')
          and start_date <= $4::date and end_date >= $3::date`,
      [grant.companyId, employeeId, input.startDate, input.endDate],
    );
    if (leave.rowCount) throw new HttpError(409, 'OVERLAPS_LEAVE', 'The dates overlap a leave request');
  }
  return { selectionOverride: employee.age > MANAGER_BACKDATE_LIMIT_DAYS ? ('HR_FALLBACK_LIST' as const) : undefined };
}

const operational = (input: WorkRequestInput) => ({
  startDate: input.startDate,
  endDate: input.endDate,
  startTime: input.startTime ?? null,
  endTime: input.endTime ?? null,
  purpose: input.purpose.trim(),
});

export async function submitWorkRequest(tx: Queryable, grant: AccessGrant, kind: WorkRequestKind, input: WorkRequestInput) {
  const employeeId = grant.linkedEmployeeId;
  if (!employeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  await reassertAccess(tx, grant, 'work_request', 'submit', ['operational']);
  const { selectionOverride } = await check(tx, grant, kind, employeeId, input);
  const predecessor = await rejectedPredecessor(tx, grant.companyId, WORK_REQUEST_KINDS[kind].table, employeeId, input.predecessorRequestId);
  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, predecessor_transaction_id, created_by, updated_by) values ($1, $2, $3, 'SUBMITTED', $5, $4, $4) returning id`,
      [grant.companyId, kind, employeeId, grant.userId, predecessor],
    )
  ).rows[0]!.id;
  const requestId = (
    await tx.query<{ id: string }>(
      `insert into ${WORK_REQUEST_KINDS[kind].table} (company_id, employee_id, transaction_id, start_date, end_date, start_time, end_time, purpose, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'SUBMITTED', $9, $9) returning id`,
      [grant.companyId, employeeId, transactionId, input.startDate, input.endDate, input.startTime ?? null, input.endTime ?? null, input.purpose.trim(), grant.userId],
    )
  ).rows[0]!.id;
  const evidence = await assertUsableEvidence(tx, grant.companyId, employeeId, input.evidenceDocumentIds ?? []);
  await linkEvidence(tx, grant, transactionId, 1, employeeId, evidence);
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind, transactionId, ownerEmployeeId: employeeId, actorUserId: grant.userId, selectionOverride });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: WORK_REQUEST_KINDS[kind].table,
    recordKey: requestId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { ...operational(input), state: 'SUBMITTED', evidenceCount: evidence.length, ...(input.predecessorRequestId ? { predecessorRequestId: input.predecessorRequestId } : {}) } },
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'work_request.submitted',
    aggregateId: requestId,
    dedupeKey: `work_request.submitted:${requestId}:1`,
    payload: { kind, requestId, taskId, revision: 1, startDate: input.startDate, endDate: input.endDate },
  });
  return { requestId, taskId, state: 'SUBMITTED' };
}

/** DF03: a returned request is corrected and resubmitted as a new transaction revision with a new approval. */
export async function resubmitWorkRequest(tx: Queryable, grant: AccessGrant, kind: WorkRequestKind, requestId: string, input: WorkRequestInput & { expectedVersion: number }) {
  const r = await lockRow(tx, kind, grant.companyId, 'r.id = $2 and r.employee_id = $3', [requestId, grant.linkedEmployeeId]);
  if (!r) throw notFound();
  if (r.state !== 'RETURNED') throw new HttpError(409, 'INVALID_STATE', 'Only a returned request can be resubmitted');
  if (r.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The request changed; reload and retry');
  const before = (await tx.query(`select start_date, end_date, start_time, end_time, purpose from ${WORK_REQUEST_KINDS[kind].table} where company_id = $1 and id = $2`, [grant.companyId, r.id])).rows[0];
  const { selectionOverride } = await check(tx, grant, kind, r.employee_id, input);
  const revision = r.revision + 1;
  await tx.query(`update business_transaction set revision = $3, state = 'SUBMITTED', updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, r.transaction_id, revision, grant.userId]);
  await tx.query(
    `update ${WORK_REQUEST_KINDS[kind].table} set start_date = $3, end_date = $4, start_time = $5, end_time = $6, purpose = $7, state = 'SUBMITTED', updated_by = $8
      where company_id = $1 and id = $2`,
    [grant.companyId, r.id, input.startDate, input.endDate, input.startTime ?? null, input.endTime ?? null, input.purpose.trim(), grant.userId],
  );
  // The new revision has its own evidence; without new documents the earlier revision's are carried forward.
  const evidence = await assertUsableEvidence(tx, grant.companyId, r.employee_id, input.evidenceDocumentIds ?? (await revisionEvidence(tx, grant.companyId, r.transaction_id, r.revision)));
  await linkEvidence(tx, grant, r.transaction_id, revision, r.employee_id, evidence);
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind, transactionId: r.transaction_id, ownerEmployeeId: r.employee_id, actorUserId: grant.userId, selectionOverride });
  // The audit trail keeps each revision's values (before/after), so earlier revisions stay reconstructable.
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: WORK_REQUEST_KINDS[kind].table,
    recordKey: r.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'RESUBMIT',
    before: { operational: { ...before, state: 'RETURNED', revision: r.revision } },
    after: { operational: { ...operational(input), state: 'SUBMITTED', revision, evidenceCount: evidence.length } },
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'work_request.submitted',
    aggregateId: r.id,
    dedupeKey: `work_request.submitted:${r.id}:${revision}`,
    payload: { kind, requestId: r.id, taskId, revision, startDate: input.startDate, endDate: input.endDate },
  });
  return { requestId: r.id, taskId, revision, state: 'SUBMITTED' };
}

export async function withdrawWorkRequest(tx: Queryable, grant: AccessGrant, kind: WorkRequestKind, requestId: string) {
  const r = await lockRow(tx, kind, grant.companyId, 'r.id = $2 and r.employee_id = $3', [requestId, grant.linkedEmployeeId]);
  if (!r) throw notFound();
  if (r.state !== 'SUBMITTED' && r.state !== 'RETURNED') throw new HttpError(409, 'INVALID_STATE', 'Only pending or returned requests can be withdrawn');
  // The reviewer of the latest task is told the request was withdrawn (DF12 "withdrawn/cancelled").
  const lastTask = (
    await tx.query<{ id: string }>(
      `select t.id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where i.company_id = $1 and i.transaction_id = $2 order by t.created_at desc limit 1`,
      [grant.companyId, r.transaction_id],
    )
  ).rows[0];
  if (r.state === 'SUBMITTED') await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
  await setState(tx, kind, grant.companyId, r, 'WITHDRAWN', grant.userId);
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'work_request.withdrawn',
    aggregateId: r.id,
    dedupeKey: `work_request.withdrawn:${r.id}`,
    payload: { kind, requestId: r.id, taskId: lastTask?.id ?? null, revision: r.revision, startDate: r.start_date, endDate: r.end_date },
  });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: WORK_REQUEST_KINDS[kind].table,
    recordKey: r.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'WITHDRAW',
    before: { operational: { state: r.state } },
    after: { operational: { state: 'WITHDRAWN' } },
  });
  return { requestId: r.id, state: 'WITHDRAWN' };
}

async function setState(tx: Queryable, kind: WorkRequestKind, companyId: string, r: Row, state: string, actor: string) {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, r.transaction_id, state, actor]);
  await tx.query(`update ${WORK_REQUEST_KINDS[kind].table} set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, r.id, state, actor]);
}

export async function decideWorkRequest(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: Decision; reason?: string | undefined; idempotencyKey: string }) {
  const kind = (
    await tx.query<{ kind: string }>(
      `select i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id where t.company_id = $1 and t.id = $2`,
      [grant.companyId, taskId],
    )
  ).rows[0]?.kind;
  if (!kind || !isWorkRequestKind(kind)) throw notFound();
  const result = await decideTask(tx, { grant, taskId, ...input, permission: { resource: 'leave', action: 'approve' } });
  const r = (await lockRow(tx, kind, grant.companyId, 'r.transaction_id = $2', [result.transactionId]))!;
  if (result.replayed) return { requestId: r.id, kind, state: r.state, replayed: true };
  // DF04: an exit approved after the request was submitted stops an approval of days after its last working date (the
  // whole decision rolls back); rejecting or returning the request stays open.
  if (input.decision === 'APPROVE') {
    refuseAfterLastWorkingDate(await lastWorkingDateOf(tx, grant.companyId, r.employee_id), r.end_date, 'The request cannot be approved past the approved last working date');
  }
  if (result.outcome === 'NEXT_STEP') return { requestId: r.id, kind, state: r.state, replayed: false };

  await setState(tx, kind, grant.companyId, r, result.outcome, grant.userId);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: WORK_REQUEST_KINDS[kind].table,
    recordKey: r.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.decision,
    before: { operational: { state: r.state } },
    after: { operational: { state: result.outcome } },
    reason: input.reason ?? null,
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'work_request.decided',
    aggregateId: r.id,
    dedupeKey: `work_request.decided:${r.id}:${r.revision}`,
    payload: { kind, requestId: r.id, outcome: result.outcome, revision: r.revision, startDate: r.start_date, endDate: r.end_date },
  });
  return { requestId: r.id, kind, state: result.outcome, replayed: false };
}

/** What each queue task decides: kind, dates, times and purpose (operational). */
export async function withWorkTaskSummaries<T extends { transactionId: string; kind: string }>(db: Queryable, grant: AccessGrant, items: T[]) {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.transactionId);
  const rows = (
    await db.query<{ id: string; transaction_id: string; kind: string; start_date: string; end_date: string; start_time: string | null; end_time: string | null; purpose: string; evidence: unknown[] }>(
      (Object.keys(WORK_REQUEST_KINDS) as WorkRequestKind[])
        .map(
          (k) => `select r.id, r.transaction_id, '${k}' as kind, to_char(r.start_date, 'YYYY-MM-DD') as start_date, to_char(r.end_date, 'YYYY-MM-DD') as end_date,
                         to_char(r.start_time, 'HH24:MI') as start_time, to_char(r.end_time, 'HH24:MI') as end_time, r.purpose,
                         ${EVIDENCE_JSON('r.company_id', 'r.transaction_id', 'bt.revision')} as evidence
                    from ${WORK_REQUEST_KINDS[k].table} r join business_transaction bt on bt.company_id = r.company_id and bt.id = r.transaction_id
                   where r.company_id = $1 and r.transaction_id = any($2::uuid[])`,
        )
        .join(' union all '),
      [grant.companyId, ids],
    )
  ).rows;
  return items.map((i) => {
    const r = rows.find((x) => x.transaction_id === i.transactionId);
    return {
      ...i,
      // requestId lets the assigned reviewer open the evidence route (/work-requests/{kind}/{requestId}/evidence/...).
      summary: r ? { requestId: r.id, kind: r.kind, startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time, purpose: r.purpose, evidence: r.evidence } : null,
    };
  });
}

const listColumns = (kind: WorkRequestKind) => `'${kind}' as kind, r.id, r.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
  r.start_date as "startDate", r.end_date as "endDate", to_char(r.start_time, 'HH24:MI') as "startTime", to_char(r.end_time, 'HH24:MI') as "endTime",
  r.purpose, r.state, r.version, r.created_at as "submittedAt",
  ${predecessorRequestSql(WORK_REQUEST_KINDS[kind].table, 'r')} as "predecessorRequestId",
  ${EVIDENCE_JSON('r.company_id', 'r.transaction_id', '(select bt.revision from business_transaction bt where bt.company_id = r.company_id and bt.id = r.transaction_id)')} as evidence`;

/** One employee's requests of both kinds (own view, team view, HR view per scope). */
export async function listEmployeeWorkRequests(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const rows = await db.query(
    (Object.keys(WORK_REQUEST_KINDS) as WorkRequestKind[])
      .map((k) => `select ${listColumns(k)} from ${WORK_REQUEST_KINDS[k].table} r join employee e on e.company_id = r.company_id and e.id = r.employee_id where r.company_id = $1 and r.employee_id = $2`)
      .join(' union all ') + ' order by "startDate" desc limit 200',
    [grant.companyId, employeeId],
  );
  return { items: rows.rows };
}

/** HR views (FR-027): requests of one kind in a date range, limited by the assignment's row scope. */
export async function listWorkRequests(db: Queryable, grant: AccessGrant, q: { kind: WorkRequestKind; from: string; to: string; state?: string | undefined }) {
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'r.company_id', employee: 'r.employee_id' }, params);
  const rows = await db.query(
    `select ${listColumns(q.kind)} from ${WORK_REQUEST_KINDS[q.kind].table} r join employee e on e.company_id = r.company_id and e.id = r.employee_id
      where ${scope} and r.start_date <= ${params.add(q.to)}::date and r.end_date >= ${params.add(q.from)}::date
        ${q.state ? `and r.state = ${params.add(q.state)}` : ''}
      order by r.start_date, e.employee_code limit 500`,
    params.values,
  );
  return { items: rows.rows };
}
