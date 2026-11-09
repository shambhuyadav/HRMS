// Leave (FR-024-FR-026; BR-010; DF03; DF05; CI08; ZT07/ZT11/ZT16).
// All quantity arithmetic runs in PostgreSQL numeric; JavaScript never adds leave units.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, assertNotOwnRecord, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { assertUsableEvidence, EVIDENCE_JSON, linkEvidence, revisionEvidence } from '../employee/evidence.js';
import { workingDaySql } from '../shift/calendar.js';
import { predecessorRequestSql, rejectedPredecessor } from '../workflow/predecessor.js';
import { cancelActiveApproval, type Decision, decideTask, lockTransaction, startApproval } from '../workflow/engine.js';

export const ACTIVE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'];
/** DF05: back-dated leave older than this many calendar days is reviewed by HR instead of the manager. */
export const MANAGER_BACKDATE_LIMIT_DAYS = 7;

interface PolicyMatch {
  policy_id: string;
  leave_type_id: string;
  paid: boolean;
  min_service_days: number;
  specificity: number;
}

/** A revision in force on a date (SQL): active, or retired with an end that date is before (0110); its period covers the date. */
export const POLICY_IN_FORCE = (policy: string, onDate: string) =>
  `(${policy}.state = 'ACTIVE' or (${policy}.state = 'RETIRED' and ${policy}.effective_to is not null))
   and ${policy}.effective_from <= ${onDate} and (${policy}.effective_to is null or ${policy}.effective_to > ${onDate})`;

/**
 * Exactly one policy of the leave type in force on `onDate`, whose mapping matches the employee's employment type /
 * grade / location on that date. The most specific mapping wins (the documented priority of FR-024; activation refuses
 * a tie, 0110, so a tie here means data from before that rule); a tie is ambiguous and blocks the request (BR-010,
 * ZT09). Nothing matching blocks it too: unset never means unlimited.
 */
export async function selectPolicy(tx: Queryable, companyId: string, employeeId: string, leaveTypeCode: string, onDate: string): Promise<PolicyMatch> {
  const rows = (
    await tx.query<PolicyMatch>(
      `select p.id as policy_id, t.id as leave_type_id, t.paid, p.min_service_days,
              max(num_nonnulls(m.employment_type_id, m.grade_id, m.location_id))::int as specificity
         from leave_type t
         join leave_policy p on p.company_id = t.company_id and p.leave_type_id = t.id and ${POLICY_IN_FORCE('p', '$4::date')}
         join leave_policy_mapping m on m.company_id = p.company_id and m.policy_id = p.id
         join employee e on e.company_id = t.company_id and e.id = $2
         left join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
               and ea.effective_from <= $4::date and (ea.effective_to is null or ea.effective_to > $4::date)
        where t.company_id = $1 and t.code = $3 and t.active
          and (m.employment_type_id is null or m.employment_type_id = e.employment_type_id)
          and (m.grade_id is null or m.grade_id = ea.grade_id)
          and (m.location_id is null or m.location_id = ea.location_id)
        group by p.id, t.id, t.paid, p.min_service_days
        order by specificity desc`,
      [companyId, employeeId, leaveTypeCode, onDate],
    )
  ).rows;
  const best = rows[0];
  if (!best) throw new HttpError(422, 'POLICY_NOT_FOUND', 'No active leave policy applies to this employee and date');
  if (rows[1] && rows[1].specificity === best.specificity) {
    throw new HttpError(422, 'POLICY_AMBIGUOUS', 'More than one leave policy applies equally; HR must resolve the mapping');
  }
  return best;
}

/** Working days in [start, end] on the location calendar of the employee each day: not a weekly off (default Monday-Friday, DF05), not a holiday. */
export async function workingDays(tx: Queryable, companyId: string, employeeId: string, start: string, end: string): Promise<number> {
  const row = (
    await tx.query<{ n: number }>(
      `select count(*)::int as n
         from generate_series($3::date, $4::date, interval '1 day') as g (d)
        where ${workingDaySql('g.d', '$2::uuid', '$1::uuid')}`,
      [companyId, employeeId, start, end],
    )
  ).rows[0];
  return row?.n ?? 0;
}

export async function balanceOf(tx: Queryable, companyId: string, employeeId: string, leaveTypeId: string) {
  return (
    await tx.query<{ available: string; pending: string; taken: string; entitled: string }>(
      `select coalesce(sum(units), 0)::numeric(12,4)::text as available,
              coalesce(-sum(units) filter (where movement_kind in ('RESERVATION', 'RESERVATION_RELEASE')), 0)::numeric(12,4)::text as pending,
              coalesce(-sum(units) filter (where movement_kind in ('CONSUMPTION', 'REVERSAL')), 0)::numeric(12,4)::text as taken,
              coalesce(sum(units) filter (where movement_kind in ('OPENING', 'ACCRUAL', 'ADJUSTMENT', 'EXPIRY')), 0)::numeric(12,4)::text as entitled
         from leave_movement where company_id = $1 and employee_id = $2 and leave_type_id = $3`,
      [companyId, employeeId, leaveTypeId],
    )
  ).rows[0]!;
}

async function movement(
  tx: Queryable,
  m: { companyId: string; employeeId: string; leaveTypeId: string; requestId: string | null; kind: string; units: string; date: string; key: string; reason?: string | null; actor: string },
): Promise<boolean> {
  // Replays of the same effect hit the unique idempotency key and change nothing.
  const inserted = await tx.query(
    `insert into leave_movement (company_id, employee_id, leave_type_id, request_id, movement_kind, units, effective_date, idempotency_key, reason, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $10, $10) on conflict (company_id, idempotency_key) do nothing`,
    [m.companyId, m.employeeId, m.leaveTypeId, m.requestId, m.kind, m.units, m.date, m.key, m.reason ?? null, m.actor],
  );
  return (inserted.rowCount ?? 0) > 0;
}

/**
 * Serialises day-claiming checks for one employee across leave and outdoor-duty requests, so the rule that the
 * two never overlap holds even when both are submitted at the same moment (I-05).
 */
export async function lockEmployeeDays(tx: Queryable, employeeId: string) {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('employee_days:' || $1, 0))`, [employeeId]);
}

/** Serialises balance-changing work for one employee/leave type (FR-026: no double spend). */
async function lockBalance(tx: Queryable, employeeId: string, leaveTypeId: string) {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('leave_balance:' || $1 || ':' || $2, 0))`, [employeeId, leaveTypeId]);
}

/**
 * DF04 / FR-051: leave and attendance eligibility stops after the approved (inclusive) last working date
 * (hrms_exit_last_working_date). Checked when a leave or work request is submitted and again when it is approved, since
 * the exit may have been approved in between. Leave or requests already approved for later dates are left as they are
 * (cancel or keep is an owner decision, docs/03 I-40 item 4).
 */
export function refuseAfterLastWorkingDate(lastWorkingDate: string | null, endDate: string, message: string): void {
  if (lastWorkingDate !== null && endDate > lastWorkingDate) throw new HttpError(422, 'AFTER_LAST_WORKING_DATE', message, { lastWorkingDate });
}

/** The employee's approved (inclusive) last working date, or null without an approved exit. */
export async function lastWorkingDateOf(tx: Queryable, companyId: string, employeeId: string): Promise<string | null> {
  return (await tx.query<{ d: string | null }>(`select to_char(hrms_exit_last_working_date($1, $2), 'YYYY-MM-DD') as d`, [companyId, employeeId])).rows[0]?.d ?? null;
}

export interface SubmitLeaveInput {
  leaveType: string;
  startDate: string;
  endDate: string;
  halfDay?: boolean | undefined;
  reason?: string | undefined;
  /** FR-026 attachment: the requester's own usable documents (FR-106, I-22). */
  evidenceDocumentIds?: string[] | undefined;
  /** DF03: the rejected request this one raises again (workflow/predecessor.ts). */
  predecessorRequestId?: string | undefined;
}

/**
 * Every submission rule (policy, service, working days, balance) for one revision of a request. Locks the
 * balance before checking it; the caller then reserves within the same transaction.
 */
async function checkSubmission(tx: Queryable, grant: AccessGrant, employeeId: string, input: SubmitLeaveInput) {
  if (input.endDate < input.startDate) throw new HttpError(422, 'RULE_VIOLATION', 'End date is before start date');
  if (input.halfDay && input.startDate !== input.endDate) throw new HttpError(422, 'RULE_VIOLATION', 'A half day covers a single date');

  const employee = (
    await tx.query<{ joining_date: string; status: string; business_date: string; last_working_date: string | null }>(
      `select e.joining_date, st.code as status, to_char(hrms_business_date(e.company_id, now()), 'YYYY-MM-DD') as business_date,
              to_char(hrms_exit_last_working_date(e.company_id, e.id), 'YYYY-MM-DD') as last_working_date
         from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where e.company_id = $1 and e.id = $2`,
      [grant.companyId, employeeId],
    )
  ).rows[0];
  if (!employee || !ACTIVE_STATUSES.includes(employee.status)) throw new HttpError(422, 'EMPLOYEE_NOT_ACTIVE', 'Only active employees can request leave');
  if (input.startDate < employee.joining_date) throw new HttpError(422, 'RULE_VIOLATION', 'Leave cannot start before the joining date');
  refuseAfterLastWorkingDate(employee.last_working_date, input.endDate, 'Leave cannot extend past the approved last working date');

  const policy = await selectPolicy(tx, grant.companyId, employeeId, input.leaveType, input.startDate);
  const serviceDays = (
    await tx.query<{ days: number }>(`select ($1::date - $2::date) as days`, [input.startDate, employee.joining_date])
  ).rows[0]!.days;
  if (serviceDays < policy.min_service_days) {
    throw new HttpError(422, 'MINIMUM_SERVICE_NOT_MET', `This leave type needs ${policy.min_service_days} days of service`);
  }

  const days = await workingDays(tx, grant.companyId, employeeId, input.startDate, input.endDate);
  if (days === 0) throw new HttpError(422, 'NO_WORKING_DAYS', 'The requested period contains no working days');
  const units = input.halfDay ? '0.5' : String(days);

  // I-05: leave and outdoor duty never claim the same day; the shared lock makes the check race-free.
  await lockEmployeeDays(tx, employeeId);
  const duty = await tx.query(
    `select 1 from outdoor_duty_request where company_id = $1 and employee_id = $2 and state in ('SUBMITTED', 'RETURNED', 'APPROVED')
        and start_date <= $4::date and end_date >= $3::date`,
    [grant.companyId, employeeId, input.startDate, input.endDate],
  );
  if (duty.rowCount) throw new HttpError(409, 'OVERLAPS_OUTDOOR_DUTY', 'The dates overlap an outdoor-duty request');

  await lockBalance(tx, employeeId, policy.leave_type_id);
  if (policy.paid) {
    const enough = (
      await tx.query<{ ok: boolean }>(
        `select coalesce(sum(units), 0) >= $4::numeric as ok from leave_movement where company_id = $1 and employee_id = $2 and leave_type_id = $3`,
        [grant.companyId, employeeId, policy.leave_type_id, units],
      )
    ).rows[0]!.ok;
    if (!enough) throw new HttpError(422, 'INSUFFICIENT_BALANCE', 'Not enough leave balance; request unpaid leave or ask HR');
  }
  const backdatedDays = (await tx.query<{ d: number }>(`select ($1::date - $2::date) as d`, [employee.business_date, input.startDate])).rows[0]!.d;
  return { policy, units, selectionOverride: backdatedDays > MANAGER_BACKDATE_LIMIT_DAYS ? ('HR_FALLBACK_LIST' as const) : undefined };
}

async function recordRevision(tx: Queryable, grant: AccessGrant, requestId: string, revision: number, policyId: string, input: SubmitLeaveInput, units: string) {
  await tx.query(
    `insert into leave_request_revision (company_id, request_id, revision, policy_id, start_date, end_date, half_day, requested_units, reason, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8::numeric, $9, $10, $10)`,
    [grant.companyId, requestId, revision, policyId, input.startDate, input.endDate, input.halfDay ?? false, units, input.reason?.trim() || null, grant.userId],
  );
}

export async function submitLeave(tx: Queryable, grant: AccessGrant, input: SubmitLeaveInput) {
  // Self-service: the requester is always the caller's own linked employee.
  const employeeId = grant.linkedEmployeeId;
  if (!employeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  await reassertAccess(tx, grant, 'leave', 'submit', ['operational']);
  const { policy, units, selectionOverride } = await checkSubmission(tx, grant, employeeId, input);
  const predecessor = await rejectedPredecessor(tx, grant.companyId, 'leave_request', employeeId, input.predecessorRequestId);

  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, predecessor_transaction_id, created_by, updated_by)
       values ($1, 'leave_request', $2, 'SUBMITTED', $4, $3, $3) returning id`,
      [grant.companyId, employeeId, grant.userId, predecessor],
    )
  ).rows[0]!.id;
  const requestId = (
    await tx.query<{ id: string }>(
      `insert into leave_request (company_id, employee_id, leave_type_id, policy_id, transaction_id, start_date, end_date, half_day,
                                  requested_units, reason, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10, 'SUBMITTED', $11, $11) returning id`,
      [grant.companyId, employeeId, policy.leave_type_id, policy.policy_id, transactionId, input.startDate, input.endDate, input.halfDay ?? false, units, input.reason?.trim() || null, grant.userId],
    )
  ).rows[0]!.id;
  await recordRevision(tx, grant, requestId, 1, policy.policy_id, input, units);
  const evidence = await assertUsableEvidence(tx, grant.companyId, employeeId, input.evidenceDocumentIds ?? []);
  await linkEvidence(tx, grant, transactionId, 1, employeeId, evidence);

  await movement(tx, {
    companyId: grant.companyId,
    employeeId,
    leaveTypeId: policy.leave_type_id,
    requestId,
    kind: 'RESERVATION',
    units: `-${units}`,
    date: input.startDate,
    key: `leave:reserve:${requestId}:1`,
    actor: grant.userId,
  });

  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: 'leave_request',
    transactionId,
    ownerEmployeeId: employeeId,
    actorUserId: grant.userId,
    selectionOverride,
  });

  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_request',
    recordKey: requestId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: {
      operational: {
        leaveType: input.leaveType,
        startDate: input.startDate,
        endDate: input.endDate,
        halfDay: input.halfDay ?? false,
        units,
        state: 'SUBMITTED',
        evidenceCount: evidence.length,
        ...(input.predecessorRequestId ? { predecessorRequestId: input.predecessorRequestId } : {}),
      },
      ...(input.reason ? { reason: { reason: input.reason.trim() } } : {}),
    },
  });
  // Committed-event notification (FR-084, BR-033): identifiers only; recipients resolved at delivery.
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'leave.submitted',
    aggregateId: requestId,
    dedupeKey: `leave.submitted:${requestId}:1`,
    payload: { requestId, taskId, revision: 1 },
  });
  return { requestId, taskId, units };
}

interface RequestRow {
  id: string;
  employee_id: string;
  leave_type_id: string;
  transaction_id: string;
  requested_units: string;
  start_date: string;
  end_date: string;
  state: string;
  revision: number;
  version: number;
  reason: string | null;
}

/**
 * Locks the request for a state change. The transaction lock comes first, so concurrent decide/withdraw/
 * resubmit/cancel calls run one after another and each reads the committed revision and state (no stale join).
 */
async function requestByTransaction(tx: Queryable, companyId: string, transactionId: string): Promise<RequestRow> {
  await lockTransaction(tx, transactionId);
  const row = (
    await tx.query<RequestRow>(
      `select lr.id, lr.employee_id, lr.leave_type_id, lr.transaction_id, lr.requested_units::text as requested_units,
              lr.start_date, lr.end_date, lr.state, bt.revision, lr.version, lr.reason
         from leave_request lr join business_transaction bt on bt.company_id = lr.company_id and bt.id = lr.transaction_id
        where lr.company_id = $1 and lr.transaction_id = $2 for update of lr, bt`,
      [companyId, transactionId],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

async function setState(tx: Queryable, companyId: string, r: RequestRow, state: string, actor: string) {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, r.transaction_id, state, actor]);
  await tx.query(`update leave_request set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, r.id, state, actor]);
}

export async function decideLeave(
  tx: Queryable,
  grant: AccessGrant,
  taskId: string,
  input: { decision: Decision; reason?: string | undefined; idempotencyKey: string },
) {
  // Only the caller's own task decides the route; anyone else's task falls through to the ordinary path and reads
  // as not found there, so a foreign cancellation task is never revealed by a kind-specific rule (sec-4).
  const kind = (
    await tx.query<{ kind: string }>(
      `select i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [grant.companyId, taskId, grant.userId],
    )
  ).rows[0]?.kind;
  if (kind === 'leave_cancellation') return decideCancellation(tx, grant, taskId, input);
  const result = await decideTask(tx, { grant, taskId, ...input, permission: { resource: 'leave', action: 'approve' } });
  if (result.replayed) {
    const r = (await tx.query<{ id: string; state: string }>(`select id, state from leave_request where company_id = $1 and transaction_id = $2`, [grant.companyId, result.transactionId])).rows[0]!;
    return { requestId: r.id, state: r.state, replayed: true };
  }

  const r = await requestByTransaction(tx, grant.companyId, result.transactionId);
  // DF04: an exit approved after the request was submitted stops an approval of days after its last working date (the
  // whole decision rolls back); rejecting or returning the request stays open.
  if (input.decision === 'APPROVE') {
    refuseAfterLastWorkingDate(await lastWorkingDateOf(tx, grant.companyId, r.employee_id), r.end_date, 'Leave cannot be approved past the approved last working date');
  }
  if (result.outcome === 'NEXT_STEP') return { requestId: r.id, state: r.state, replayed: false };

  await lockBalance(tx, r.employee_id, r.leave_type_id);
  const base = { companyId: grant.companyId, employeeId: r.employee_id, leaveTypeId: r.leave_type_id, requestId: r.id, date: r.start_date, actor: grant.userId };
  await movement(tx, { ...base, kind: 'RESERVATION_RELEASE', units: r.requested_units, key: `leave:release:${r.id}:${r.revision}` });
  if (result.outcome === 'APPROVED') {
    await movement(tx, { ...base, kind: 'CONSUMPTION', units: `-${r.requested_units}`, key: `leave:consume:${r.id}` });
  }
  await setState(tx, grant.companyId, r, result.outcome, grant.userId);

  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_request',
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
    topic: 'leave.decided',
    aggregateId: r.id,
    dedupeKey: `leave.decided:${r.id}:${r.revision}`,
    payload: { requestId: r.id, outcome: result.outcome, revision: r.revision },
  });
  return { requestId: r.id, state: result.outcome, replayed: false };
}

export async function withdrawLeave(tx: Queryable, grant: AccessGrant, requestId: string) {
  const own = (
    await tx.query<{ transaction_id: string }>(`select transaction_id from leave_request where company_id = $1 and id = $2 and employee_id = $3`, [
      grant.companyId,
      requestId,
      grant.linkedEmployeeId,
    ])
  ).rows[0];
  if (!own) throw notFound();
  const r = await requestByTransaction(tx, grant.companyId, own.transaction_id);
  if (r.state !== 'SUBMITTED' && r.state !== 'RETURNED') throw new HttpError(409, 'INVALID_STATE', 'Only pending or returned requests can be withdrawn');

  await lockBalance(tx, r.employee_id, r.leave_type_id);
  if (r.state === 'SUBMITTED') {
    await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
    await movement(tx, {
      companyId: grant.companyId,
      employeeId: r.employee_id,
      leaveTypeId: r.leave_type_id,
      requestId: r.id,
      kind: 'RESERVATION_RELEASE',
      units: r.requested_units,
      date: r.start_date,
      key: `leave:release:${r.id}:${r.revision}`,
      actor: grant.userId,
    });
  }
  await setState(tx, grant.companyId, r, 'WITHDRAWN', grant.userId);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_request',
    recordKey: r.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'WITHDRAW',
    before: { operational: { state: r.state } },
    after: { operational: { state: 'WITHDRAWN' } },
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'leave.withdrawn',
    aggregateId: r.id,
    dedupeKey: `leave.withdrawn:${r.id}`,
    payload: { requestId: r.id, revision: r.revision },
  });
  return { requestId: r.id, state: 'WITHDRAWN' };
}

/**
 * DF03: a returned request is corrected and resubmitted as a new immutable revision with a new approval
 * instance; earlier revisions and decisions stay on record. The leave type is fixed (a different type is a
 * new request). The returned decision already released the earlier reservation.
 */
export async function resubmitLeave(tx: Queryable, grant: AccessGrant, requestId: string, input: Omit<SubmitLeaveInput, 'leaveType'> & { expectedVersion: number }) {
  const own = (
    await tx.query<{ transaction_id: string; leave_type: string; version: number }>(
      `select lr.transaction_id, t.code as leave_type, lr.version from leave_request lr join leave_type t on t.company_id = lr.company_id and t.id = lr.leave_type_id
        where lr.company_id = $1 and lr.id = $2 and lr.employee_id = $3`,
      [grant.companyId, requestId, grant.linkedEmployeeId],
    )
  ).rows[0];
  if (!own) throw notFound();
  const r = await requestByTransaction(tx, grant.companyId, own.transaction_id);
  if (r.state !== 'RETURNED') throw new HttpError(409, 'INVALID_STATE', 'Only a returned request can be resubmitted');
  if (r.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The request changed; reload and retry');

  // The private reason carries forward unless a new one is given (the employee cannot read it back to resend it).
  const reason = input.reason?.trim() || r.reason || undefined;
  const submission = { ...input, reason, leaveType: own.leave_type };
  const { policy, units, selectionOverride } = await checkSubmission(tx, grant, r.employee_id, submission);
  const revision = r.revision + 1;
  await tx.query(`update business_transaction set revision = $3, state = 'SUBMITTED', updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    r.transaction_id,
    revision,
    grant.userId,
  ]);
  await tx.query(
    `update leave_request set policy_id = $3, start_date = $4, end_date = $5, half_day = $6, requested_units = $7::numeric, reason = $8, state = 'SUBMITTED', updated_by = $9
      where company_id = $1 and id = $2`,
    [grant.companyId, r.id, policy.policy_id, input.startDate, input.endDate, input.halfDay ?? false, units, reason ?? null, grant.userId],
  );
  await recordRevision(tx, grant, r.id, revision, policy.policy_id, submission, units);
  // The new revision has its own evidence; without new documents the earlier revision's are carried forward (I-22).
  const evidence = await assertUsableEvidence(tx, grant.companyId, r.employee_id, input.evidenceDocumentIds ?? (await revisionEvidence(tx, grant.companyId, r.transaction_id, r.revision)));
  await linkEvidence(tx, grant, r.transaction_id, revision, r.employee_id, evidence);
  await movement(tx, {
    companyId: grant.companyId,
    employeeId: r.employee_id,
    leaveTypeId: r.leave_type_id,
    requestId: r.id,
    kind: 'RESERVATION',
    units: `-${units}`,
    date: input.startDate,
    key: `leave:reserve:${r.id}:${revision}`,
    actor: grant.userId,
  });
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: 'leave_request', transactionId: r.transaction_id, ownerEmployeeId: r.employee_id, actorUserId: grant.userId, selectionOverride });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_request',
    recordKey: r.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'RESUBMIT',
    before: { operational: { state: 'RETURNED', revision: r.revision } },
    after: {
      operational: { startDate: input.startDate, endDate: input.endDate, halfDay: input.halfDay ?? false, units, state: 'SUBMITTED', revision, evidenceCount: evidence.length },
      ...(input.reason ? { reason: { reason: input.reason.trim() } } : {}),
    },
  });
  await enqueueEvent(tx, { companyId: grant.companyId, topic: 'leave.submitted', aggregateId: r.id, dedupeKey: `leave.submitted:${r.id}:${revision}`, payload: { requestId: r.id, taskId, revision } });
  return { requestId: r.id, taskId, units, revision };
}

/**
 * FR-026 / DF03: cancelling approved leave is a controlled action. The employee asks with a reason; the
 * leave stays APPROVED until the reviewer approves the cancellation. Routing follows the leave rules,
 * including DF05's HR review for leave that started more than 7 calendar days ago.
 */
export async function requestCancellation(tx: Queryable, grant: AccessGrant, requestId: string, reason: string) {
  const own = (
    await tx.query<{ transaction_id: string; old: boolean }>(
      `select lr.transaction_id, (hrms_business_date(lr.company_id, now()) - lr.start_date) > $4 as old
         from leave_request lr where lr.company_id = $1 and lr.id = $2 and lr.employee_id = $3`,
      [grant.companyId, requestId, grant.linkedEmployeeId, MANAGER_BACKDATE_LIMIT_DAYS],
    )
  ).rows[0];
  if (!own) throw notFound();
  const r = await requestByTransaction(tx, grant.companyId, own.transaction_id);
  if (r.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only approved leave can be cancelled; withdraw a pending request instead');
  const open = await tx.query(`select 1 from leave_cancellation where company_id = $1 and leave_request_id = $2 and state = 'SUBMITTED'`, [grant.companyId, r.id]);
  if (open.rowCount) throw new HttpError(409, 'CANCELLATION_PENDING', 'A cancellation of this leave is already waiting for a decision');

  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by)
       values ($1, 'leave_cancellation', $2, 'SUBMITTED', $3, $3) returning id`,
      [grant.companyId, r.employee_id, grant.userId],
    )
  ).rows[0]!.id;
  const cancellationId = (
    await tx.query<{ id: string }>(
      `insert into leave_cancellation (company_id, employee_id, leave_request_id, transaction_id, reason, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'SUBMITTED', $6, $6) returning id`,
      [grant.companyId, r.employee_id, r.id, transactionId, reason.trim(), grant.userId],
    )
  ).rows[0]!.id;
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: 'leave_cancellation',
    transactionId,
    ownerEmployeeId: r.employee_id,
    actorUserId: grant.userId,
    selectionOverride: own.old ? 'HR_FALLBACK_LIST' : undefined,
  });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_cancellation',
    recordKey: cancellationId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    after: { operational: { leaveRequestId: r.id, state: 'SUBMITTED' }, reason: { reason: reason.trim() } },
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'leave.cancellation_requested',
    aggregateId: cancellationId,
    dedupeKey: `leave.cancellation_requested:${cancellationId}`,
    payload: { requestId: r.id, cancellationId, taskId },
  });
  return { cancellationId, taskId, state: 'SUBMITTED' };
}

async function decideCancellation(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: Decision; reason?: string | undefined; idempotencyKey: string }) {
  // A cancellation is approved or rejected; there is nothing to correct and resubmit.
  if (input.decision === 'RETURN') throw new HttpError(422, 'RETURN_NOT_ALLOWED', 'A cancellation request can only be approved or rejected');
  const result = await decideTask(tx, { grant, taskId, ...input, permission: { resource: 'leave', action: 'approve' } });
  const c = (
    await tx.query<{ id: string; leave_request_id: string; state: string }>(
      `select id, leave_request_id, state from leave_cancellation where company_id = $1 and transaction_id = $2 for update`,
      [grant.companyId, result.transactionId],
    )
  ).rows[0]!;
  if (result.replayed) return { cancellationId: c.id, state: c.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { cancellationId: c.id, state: c.state, replayed: false };

  const outcome = result.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, result.transactionId, outcome, grant.userId]);
  await tx.query(`update leave_cancellation set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, c.id, outcome, grant.userId]);

  if (outcome === 'APPROVED') {
    const leaveTx = (await tx.query<{ transaction_id: string }>(`select transaction_id from leave_request where company_id = $1 and id = $2`, [grant.companyId, c.leave_request_id])).rows[0]!;
    const r = await requestByTransaction(tx, grant.companyId, leaveTx.transaction_id);
    if (r.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'The leave is no longer approved');
    await lockBalance(tx, r.employee_id, r.leave_type_id);
    // The original consumption stays; a reversal of the same units restores the balance exactly once.
    await movement(tx, {
      companyId: grant.companyId,
      employeeId: r.employee_id,
      leaveTypeId: r.leave_type_id,
      requestId: r.id,
      kind: 'REVERSAL',
      units: r.requested_units,
      date: r.start_date,
      key: `leave:cancel:${r.id}`,
      actor: grant.userId,
    });
    await setState(tx, grant.companyId, r, 'CANCELLED', grant.userId);
  }
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_cancellation',
    recordKey: c.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.decision,
    before: { operational: { state: 'SUBMITTED' } },
    after: { operational: { state: outcome } },
    reason: input.reason ?? null,
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'leave.cancellation_decided',
    aggregateId: c.id,
    dedupeKey: `leave.cancellation_decided:${c.id}`,
    payload: { requestId: c.leave_request_id, cancellationId: c.id, outcome },
  });
  return { cancellationId: c.id, state: outcome, replayed: false };
}

/**
 * What each leave-queue task decides (operational fields only): the leave's type, dates and units; for a
 * cancellation, the approved leave it would cancel; and the supporting documents of the leave's current revision as
 * metadata, with the request id their content route takes (FR-026, FR-106). Reasons never appear here.
 */
export async function withLeaveTaskSummaries<T extends { transactionId: string; kind: string }>(db: Queryable, grant: AccessGrant, items: T[]) {
  if (items.length === 0) return [];
  const rows = (
    await db.query<{ transaction_id: string; request_id: string; leave_type: string; start_date: string; end_date: string; half_day: boolean; units: string; evidence: unknown[] }>(
      `select x.transaction_id, lr.id as request_id, t.code as leave_type, to_char(lr.start_date, 'YYYY-MM-DD') as start_date, to_char(lr.end_date, 'YYYY-MM-DD') as end_date,
              lr.half_day, lr.requested_units::text as units, ${EVIDENCE_JSON('lr.company_id', 'lr.transaction_id', 'bt.revision')} as evidence
         from (select transaction_id, id as request_id from leave_request where company_id = $1 and transaction_id = any($2::uuid[])
               union all
               select transaction_id, leave_request_id from leave_cancellation where company_id = $1 and transaction_id = any($2::uuid[])) x
         join leave_request lr on lr.company_id = $1 and lr.id = x.request_id
         join business_transaction bt on bt.company_id = lr.company_id and bt.id = lr.transaction_id
         join leave_type t on t.company_id = lr.company_id and t.id = lr.leave_type_id`,
      [grant.companyId, items.map((i) => i.transactionId)],
    )
  ).rows;
  return items.map((i) => {
    const r = rows.find((x) => x.transaction_id === i.transactionId);
    return {
      ...i,
      summary: r
        ? { requestId: r.request_id, leaveType: r.leave_type, startDate: r.start_date, endDate: r.end_date, halfDay: r.half_day, units: r.units, isCancellation: i.kind === 'leave_cancellation', evidence: r.evidence }
        : null,
    };
  });
}

export async function listLeaveRequests(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const withReason = grant.allowedFieldGroups.includes('reason');
  const rows = await db.query(
    `select lr.id, t.code as "leaveType", lr.start_date as "startDate", lr.end_date as "endDate", lr.half_day as "halfDay",
            lr.requested_units::text as units, lr.state, lr.created_at as "submittedAt", lr.version,
            bt.revision,
            ${predecessorRequestSql('leave_request', 'lr')} as "predecessorRequestId",
            (select c.state from leave_cancellation c where c.company_id = lr.company_id and c.leave_request_id = lr.id
              order by c.created_at desc limit 1) as "cancellationState",
            ${EVIDENCE_JSON('lr.company_id', 'lr.transaction_id', 'bt.revision')} as evidence
            ${withReason ? ', lr.reason' : ''}
       from leave_request lr join leave_type t on t.company_id = lr.company_id and t.id = lr.leave_type_id
       join business_transaction bt on bt.company_id = lr.company_id and bt.id = lr.transaction_id
      where lr.company_id = $1 and lr.employee_id = $2 order by lr.start_date desc limit 200`,
    [grant.companyId, employeeId],
  );
  return { items: rows.rows };
}

export interface LeaveBalanceRow {
  leaveType: string;
  paid: boolean;
  available: string;
  pending: string;
  taken: string;
}

/**
 * The ledger balance of each active leave type (the leave balance read): available, pending and taken units. With
 * `asOf`, only movements effective on or before that date count; with `paidOnly`, only paid types are listed. The
 * caller has checked access to the employee.
 */
export async function ledgerBalances(db: Queryable, companyId: string, employeeId: string, opts: { asOf?: string | null; paidOnly?: boolean } = {}): Promise<LeaveBalanceRow[]> {
  const rows = await db.query<LeaveBalanceRow>(
    `select t.code as "leaveType", t.paid,
            coalesce(sum(m.units), 0)::numeric(12,4)::text as available,
            coalesce(-sum(m.units) filter (where m.movement_kind in ('RESERVATION', 'RESERVATION_RELEASE')), 0)::numeric(12,4)::text as pending,
            coalesce(-sum(m.units) filter (where m.movement_kind in ('CONSUMPTION', 'REVERSAL')), 0)::numeric(12,4)::text as taken
       from leave_type t
       left join leave_movement m on m.company_id = t.company_id and m.leave_type_id = t.id and m.employee_id = $2
                                  and ($3::date is null or m.effective_date <= $3::date)
      where t.company_id = $1 and t.active and (t.paid or not $4::boolean)
      group by t.code, t.paid order by t.code`,
    [companyId, employeeId, opts.asOf ?? null, opts.paidOnly === true],
  );
  return rows.rows;
}

export async function balances(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  return { employeeId, items: await ledgerBalances(db, grant.companyId, employeeId) };
}

export interface BalanceAdjustment {
  employeeId: string;
  leaveType: string;
  kind: 'OPENING' | 'ADJUSTMENT';
  units: string;
  effectiveDate: string;
  reason: string;
  idempotencyKey: string;
}

/**
 * HR opening balance / adjustment (FR-025): reason required; never on one's own balance (C4; DF02). A key replayed with
 * the same content by the same actor is the same movement again: nothing new is written or audited (ZT07). A key used
 * for anything else is refused without revealing what it was used for. Every check runs under the balance lock, so two
 * concurrent openings cannot both pass, whatever their keys; the partial unique index (0086) refuses any other path.
 */
export async function adjustBalance(tx: Queryable, grant: AccessGrant, input: BalanceAdjustment): Promise<{ replayed: boolean }> {
  if (!(await canAccessEmployee(tx, grant, input.employeeId))) throw notFound();
  await assertNotOwnRecord(tx, grant, input.employeeId);
  const type = (await tx.query<{ id: string }>(`select id from leave_type where company_id = $1 and code = $2`, [grant.companyId, input.leaveType])).rows[0];
  if (!type) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown leave type');
  await lockBalance(tx, input.employeeId, type.id);
  await reassertAccess(tx, grant, 'leave', 'adjust', ['operational']);
  const key = `leave:manual:${input.idempotencyKey}`;
  const isReplay = async () => {
    const prior = (
      await tx.query<{ same: boolean }>(
        `select (employee_id = $3 and leave_type_id = $4 and movement_kind = $5 and units = $6::numeric and effective_date = $7::date and reason = $8 and created_by = $9) as same
           from leave_movement where company_id = $1 and idempotency_key = $2`,
        [grant.companyId, key, input.employeeId, type.id, input.kind, input.units, input.effectiveDate, input.reason, grant.userId],
      )
    ).rows[0];
    if (prior && !prior.same) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for another movement');
    return !!prior;
  };
  if (await isReplay()) return { replayed: true };
  if (input.kind === 'OPENING') {
    const existing = await tx.query(`select 1 from leave_movement where company_id = $1 and employee_id = $2 and leave_type_id = $3 and movement_kind = 'OPENING'`, [
      grant.companyId,
      input.employeeId,
      type.id,
    ]);
    if (existing.rowCount) throw new HttpError(409, 'OPENING_EXISTS', 'An opening balance already exists; use an adjustment');
  }
  const inserted = await movement(tx, {
    companyId: grant.companyId,
    employeeId: input.employeeId,
    leaveTypeId: type.id,
    requestId: null,
    kind: input.kind,
    units: input.units,
    date: input.effectiveDate,
    key,
    reason: input.reason,
    actor: grant.userId,
  });
  // A request for another employee or type holds another lock, so the same key can arrive here second.
  if (!inserted) {
    await isReplay();
    return { replayed: true };
  }
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_balance',
    recordKey: input.employeeId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.kind,
    after: { operational: { leaveType: input.leaveType, units: input.units, effectiveDate: input.effectiveDate } },
    reason: input.reason,
  });
  return { replayed: false };
}

/**
 * FR-025 Employee Leave Master: the ledger of a period per leave type: the opening balance at its start, each movement
 * effective in it (kind, units, date, linked request, actor), total credits and debits, and the closing balance: opening
 * plus credits minus debits, computed in numeric. An HR note (the reason of an opening or adjustment) needs the leave
 * reason group, and never through the own-record ESS exception (H1/H3), as for amendment reasons. A movement's date is
 * its effective date, so a reservation counts from the request's start date.
 */
export async function leaveLedger(db: Queryable, grant: AccessGrant, employeeId: string, q: { from: string; to: string; leaveType?: string | undefined }) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  if (q.to < q.from) throw new HttpError(422, 'INVALID_PERIOD', 'The period end is before its start');
  const withReason = grant.allowedFieldGroups.includes('reason') && !grant.ownEssFieldGroups.includes('reason');
  const totals = (
    await db.query<{ id: string; leave_type: string; paid: boolean; opening: string; credits: string; debits: string; closing: string }>(
      `select t.id, t.code as leave_type, t.paid, s.opening::numeric(12,4)::text as opening, s.credits::numeric(12,4)::text as credits, s.debits::numeric(12,4)::text as debits,
              (s.opening + s.credits - s.debits)::numeric(12,4)::text as closing
         from leave_type t
         cross join lateral (
           select coalesce(sum(m.units) filter (where m.effective_date < $3::date), 0) as opening,
                  coalesce(sum(m.units) filter (where m.effective_date between $3::date and $4::date and m.units > 0), 0) as credits,
                  coalesce(-sum(m.units) filter (where m.effective_date between $3::date and $4::date and m.units < 0), 0) as debits,
                  count(*) as movements
             from leave_movement m where m.company_id = t.company_id and m.leave_type_id = t.id and m.employee_id = $2
         ) s
        where t.company_id = $1 and ($5::text is null or t.code = $5) and (t.active or s.movements > 0)
        order by t.code`,
      [grant.companyId, employeeId, q.from, q.to, q.leaveType ?? null],
    )
  ).rows;
  const movements = (
    await db.query<{ leave_type_id: string } & Record<string, unknown>>(
      `select m.leave_type_id, m.id, m.movement_kind as kind, m.units::text as units, m.effective_date as "effectiveDate", m.request_id as "requestId",
              m.created_by as "actorUserId", m.created_at as "recordedAt" ${withReason ? ', m.reason' : ''}
         from leave_movement m
        where m.company_id = $1 and m.employee_id = $2 and m.effective_date between $3::date and $4::date
        order by m.effective_date, m.created_at,
                 array_position(array['OPENING', 'ACCRUAL', 'ADJUSTMENT', 'RESERVATION', 'RESERVATION_RELEASE', 'CONSUMPTION', 'REVERSAL', 'EXPIRY'], m.movement_kind), m.id`,
      [grant.companyId, employeeId, q.from, q.to],
    )
  ).rows;
  return {
    employeeId,
    from: q.from,
    to: q.to,
    items: totals.map((t) => ({
      leaveType: t.leave_type,
      paid: t.paid,
      opening: t.opening,
      credits: t.credits,
      debits: t.debits,
      closing: t.closing,
      movements: movements.filter((m) => m.leave_type_id === t.id).map(({ leave_type_id: _omit, ...m }) => m),
    })),
  };
}

/** A company-scope assignment narrowed by no department, location or employee filter (DF02 row scope). */
export const isCompanyWide = (grant: AccessGrant) => {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0;
};

/**
 * Monthly accrual runs need an unrestricted company scope: the run credits every employee in service during the month,
 * so a company-scope assignment narrowed by department, location or employee filters, which covers only some of them,
 * may not run it (DF02 row scope). Re-checked for every chunk of the bulk job (modules/bulk/kinds.ts).
 */
export const accrualAuthorised = isCompanyWide;

/** Statuses after the employment ended: such an employee accrues only for the days served up to an approved last working date. */
export const ENDED_STATUSES = ['INACTIVE_SEPARATED', 'ARCHIVED'];

/** Totals of a monthly accrual run. */
export interface AccrualTotals {
  month: string;
  credited: number;
}

/**
 * DF05 monthly accrual for one month (YYYY-MM): annual entitlement / 12, prorated by calendar service days in
 * the month, rounded to 4 decimals. Service days run from the joining date (or the month's first day) to the approved
 * inclusive last working date (or the month's last day): DF04 stops leave eligibility after that date, so an employee
 * separated during the month accrues for the days served, even when their status is already separated, and nothing
 * accrues for a month that starts after it. The end-of-service month uses the joining month's calendar-day proration
 * (DF05 names no other rule). Idempotent per employee/type/month. Applies the policy selected for each employee on the
 * month's last service day, which is also the movement's effective date. Runs one bounded chunk at a time (NFR-S09: the
 * bulk-job worker runs it, never a request; modules/bulk): the next `size` employees in service during the month, in id
 * order after `afterEmployeeId`, each with every active paid leave type, adding to `totals`. A chunk rolled back and
 * run again credits nothing twice (the movement key is unique per employee, type and month).
 */
export async function accrueMonthChunk(tx: Queryable, grant: AccessGrant, month: string, totals: AccrualTotals, afterEmployeeId: string | null, size: number) {
  if (!accrualAuthorised(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  const rows = (
    await tx.query<{ employee_id: string; service_end: string }>(
      `with bounds as (select date_trunc('month', ($2 || '-01')::date)::date as m_start,
                              (date_trunc('month', ($2 || '-01')::date) + interval '1 month - 1 day')::date as m_end)
       select e.id as employee_id, to_char(least(b.m_end, coalesce(x.last_working_date, b.m_end)), 'YYYY-MM-DD') as service_end
         from bounds b
         join employee e on e.company_id = $1 and e.joining_date <= b.m_end
         join reference_value st on st.company_id = e.company_id and st.id = e.status_id
         cross join lateral (select hrms_exit_last_working_date(e.company_id, e.id) as last_working_date) x
        where ($3::uuid is null or e.id > $3::uuid)
          and (st.code = any($5::text[]) or (st.code = any($6::text[]) and x.last_working_date is not null))
          and (x.last_working_date is null or (x.last_working_date >= b.m_start and x.last_working_date >= e.joining_date))
        order by e.id limit $4::int`,
      [grant.companyId, month, afterEmployeeId, size + 1, ACTIVE_STATUSES, ENDED_STATUSES],
    )
  ).rows;
  const employees = rows.slice(0, size);
  const types =
    employees.length === 0
      ? []
      : (await tx.query<{ code: string }>(`select code from leave_type where company_id = $1 and active and paid order by code`, [grant.companyId])).rows;
  const candidates = employees.flatMap((e) => types.map((t) => ({ employee_id: e.employee_id, leave_type_code: t.code, service_end: e.service_end })));

  let credited = totals.credited;
  for (const c of candidates) {
    let policy: PolicyMatch;
    try {
      policy = await selectPolicy(tx, grant.companyId, c.employee_id, c.leave_type_code, c.service_end);
    } catch (err) {
      if (err instanceof HttpError && err.code === 'POLICY_NOT_FOUND') continue; // not eligible for this type
      throw err;
    }
    const units = (
      await tx.query<{ units: string | null; m_start: string }>(
        `with b as (select date_trunc('month', ($3 || '-01')::date)::date as m_start,
                           (date_trunc('month', ($3 || '-01')::date) + interval '1 month - 1 day')::date as m_end)
         select case when p.accrual_rule_code = 'MONTHLY_PRORATED' and p.annual_entitlement > 0 then
                  round(p.annual_entitlement / 12 * (($5::date - greatest(b.m_start, e.joining_date) + 1)::numeric
                        / (b.m_end - b.m_start + 1)), 4)::text end as units,
                to_char(b.m_start, 'YYYY-MM-DD') as m_start
           from b, leave_policy p, employee e
          where p.company_id = $1 and p.id = $2 and e.company_id = $1 and e.id = $4`,
        [grant.companyId, policy.policy_id, month, c.employee_id, c.service_end],
      )
    ).rows[0]!;
    if (!units.units || Number(units.units) === 0) continue;
    const inserted = await tx.query(
      `insert into leave_movement (company_id, employee_id, leave_type_id, movement_kind, units, effective_date, idempotency_key, created_by, updated_by)
       values ($1, $2, $3, 'ACCRUAL', $4::numeric, $5, $6, $7, $7) on conflict (company_id, idempotency_key) do nothing`,
      [grant.companyId, c.employee_id, policy.leave_type_id, units.units, c.service_end, `leave:accrual:${c.employee_id}:${policy.leave_type_id}:${month}`, grant.userId],
    );
    credited += inserted.rowCount ?? 0;
  }
  return { totals: { month, credited }, processed: employees.length, cursor: employees.at(-1)?.employee_id ?? afterEmployeeId, done: rows.length <= size };
}

/** The audit record of a finished accrual run (written once, when its last chunk commits). */
export async function auditAccrual(tx: Queryable, grant: AccessGrant, totals: AccrualTotals) {
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_accrual',
    recordKey: grant.companyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'ACCRUE',
    after: { operational: { month: totals.month, credited: totals.credited } },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Leave year end (FR-024, FR-025; DF05). Decided under owner delegation, 6 Nov 2026 (owner chose process rules only):
// I-78 item 3; 0183.
// ---------------------------------------------------------------------------------------------------------------

/** Counts of a year-end run: no list that grows per employee (bulk/kinds.ts). Units are never added up in JavaScript. */
export interface YearEndTotals {
  yearEnd: string;
  /** Employees in service on the year's last day that the run looked at. */
  employees: number;
  /** EXPIRY movements written (one per employee and leave type at most). */
  expired: number;
  /** Employee and leave type pairs whose leave year ends that day, at or below the carry cap: nothing expires. */
  withinCap: number;
  /** Pairs skipped while a request of the type dated in the closing year waits for a decision; a later run takes them. */
  pendingRequests: number;
  /** Pairs whose policy names no leave year (0183: never expired until it does). */
  notConfigured: number;
}

export const emptyYearEndTotals = (yearEnd: string): YearEndTotals => ({ yearEnd, employees: 0, expired: 0, withinCap: 0, pendingRequests: 0, notConfigured: 0 });

/** A leave year end is the last day of a month that has passed (business date after it): the run never looks ahead. */
export async function assertYearEndDate(db: Queryable, companyId: string, yearEnd: string): Promise<void> {
  const row = (
    await db.query<{ month_end: boolean; ended: boolean }>(
      `select extract(day from ($2::date + 1)) = 1 as month_end, hrms_business_date($1, now()) > $2::date as ended`,
      [companyId, yearEnd],
    )
  ).rows[0]!;
  if (!row.month_end) throw new HttpError(422, 'INVALID_YEAR_END', 'A leave year ends on the last day of a month');
  if (!row.ended) throw new HttpError(422, 'LEAVE_YEAR_NOT_ENDED', 'This leave year has not ended yet');
}

/**
 * One bounded chunk of a year-end run (the bulk-job worker runs it, NFR-S09): the next `size` employees in service on
 * `yearEnd` in id order after `afterEmployeeId` (joined by then, active or with an approved last working date on or after
 * it), each with every active paid leave type. For each, the policy selected on `yearEnd` decides (a tie fails the run, as
 * for accrual; no policy is not eligible): only a policy whose leave year starts the day after `yearEnd` expires anything.
 * Units held at the end of the day (every movement dated on or before it) above the carry cap expire as one EXPIRY dated
 * `yearEnd`, never more than the balance over all dates holds (units already promised to later leave stay), so an expiry
 * never takes a balance below zero. A request of the type still pending (SUBMITTED) that starts on or before `yearEnd`
 * skips the pair: its outcome changes what is held. The movement key is unique per employee, type and year end, so a
 * chunk run again, or a later run for the same year, expires nothing twice. Company scope only (accrualAuthorised).
 */
export async function yearEndChunk(tx: Queryable, grant: AccessGrant, yearEnd: string, totals: YearEndTotals, afterEmployeeId: string | null, size: number) {
  if (!accrualAuthorised(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  await assertYearEndDate(tx, grant.companyId, yearEnd);
  const rows = (
    await tx.query<{ employee_id: string }>(
      `select e.id as employee_id
         from employee e
         join reference_value st on st.company_id = e.company_id and st.id = e.status_id
         cross join lateral (select hrms_exit_last_working_date(e.company_id, e.id) as last_working_date) x
        where e.company_id = $1 and e.joining_date <= $2::date and ($3::uuid is null or e.id > $3::uuid)
          and (st.code = any($5::text[]) or (st.code = any($6::text[]) and x.last_working_date is not null))
          and (x.last_working_date is null or x.last_working_date >= $2::date)
        order by e.id limit $4::int`,
      [grant.companyId, yearEnd, afterEmployeeId, size + 1, ACTIVE_STATUSES, ENDED_STATUSES],
    )
  ).rows;
  const employees = rows.slice(0, size);
  const types = employees.length === 0 ? [] : (await tx.query<{ code: string }>(`select code from leave_type where company_id = $1 and active and paid order by code`, [grant.companyId])).rows;
  const next: YearEndTotals = { ...emptyYearEndTotals(yearEnd), ...totals, yearEnd };
  for (const e of employees) {
    next.employees++;
    for (const t of types) {
      let policy: PolicyMatch;
      try {
        policy = await selectPolicy(tx, grant.companyId, e.employee_id, t.code, yearEnd);
      } catch (err) {
        if (err instanceof HttpError && err.code === 'POLICY_NOT_FOUND') continue; // not eligible for this type
        throw err;
      }
      const p = (
        await tx.query<{ start_month: number | null; year_end: boolean; carry_cap: string }>(
          `select leave_year_start_month as start_month, carry_cap::text as carry_cap,
                  coalesce(extract(month from ($3::date + 1)) = leave_year_start_month, false) as year_end
             from leave_policy where company_id = $1 and id = $2`,
          [grant.companyId, policy.policy_id, yearEnd],
        )
      ).rows[0]!;
      if (p.start_month === null) {
        next.notConfigured++;
        continue;
      }
      if (!p.year_end) continue; // this type's leave year ends on another date
      await lockBalance(tx, e.employee_id, policy.leave_type_id);
      const pending = await tx.query(
        `select 1 from leave_request where company_id = $1 and employee_id = $2 and leave_type_id = $3 and state = 'SUBMITTED' and start_date <= $4::date limit 1`,
        [grant.companyId, e.employee_id, policy.leave_type_id, yearEnd],
      );
      if (pending.rowCount) {
        next.pendingRequests++;
        continue;
      }
      const key = `leave:expiry:${e.employee_id}:${policy.leave_type_id}:${yearEnd}`;
      const expiry = (
        await tx.query<{ units: string }>(
          `select greatest(0, least(coalesce(sum(units) filter (where effective_date <= $4::date), 0) - $5::numeric, coalesce(sum(units), 0)))::numeric(12,4)::text as units
             from leave_movement where company_id = $1 and employee_id = $2 and leave_type_id = $3`,
          [grant.companyId, e.employee_id, policy.leave_type_id, yearEnd, p.carry_cap],
        )
      ).rows[0]!.units;
      const done = await tx.query(`select 1 from leave_movement where company_id = $1 and idempotency_key = $2`, [grant.companyId, key]);
      if (done.rowCount) continue; // expired by an earlier run of this year end
      if (Number(expiry) === 0) {
        next.withinCap++;
        continue;
      }
      await movement(tx, {
        companyId: grant.companyId,
        employeeId: e.employee_id,
        leaveTypeId: policy.leave_type_id,
        requestId: null,
        kind: 'EXPIRY',
        units: `-${expiry}`,
        date: yearEnd,
        key,
        actor: grant.userId,
      });
      next.expired++;
    }
  }
  return { totals: next, processed: employees.length, cursor: employees.at(-1)?.employee_id ?? afterEmployeeId, done: rows.length <= size };
}

/** The audit record of a finished year-end run (written once, when its last chunk commits). */
export async function auditYearEnd(tx: Queryable, grant: AccessGrant, totals: YearEndTotals) {
  const { yearEnd, employees, expired, withinCap, pendingRequests, notConfigured } = totals;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_year_end',
    recordKey: grant.companyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'EXPIRE',
    after: { operational: { yearEnd, employees, expired, withinCap, pendingRequests, notConfigured } },
  });
}

/**
 * The requests a year-end run skips: pending (SUBMITTED) requests of paid types starting on or before `yearEnd`, in the
 * caller's row scope, whose policy on `yearEnd` ends its leave year that day. Operational fields only, paged.
 */
export async function yearEndPendingRequests(db: Queryable, grant: AccessGrant, q: { yearEnd: string; page: number; pageSize: number }) {
  const params = new SqlParams([grant.companyId, q.yearEnd]);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const from = `from leave_request lr
       join employee e on e.company_id = lr.company_id and e.id = lr.employee_id
       join leave_type t on t.company_id = lr.company_id and t.id = lr.leave_type_id and t.paid
      where lr.company_id = $1 and lr.state = 'SUBMITTED' and lr.start_date <= $2::date and ${scope}
        and exists (select 1 from leave_policy p where p.company_id = lr.company_id and p.leave_type_id = lr.leave_type_id and ${POLICY_IN_FORCE('p', '$2::date')}
                      and extract(month from ($2::date + 1)) = p.leave_year_start_month)`;
  const total = Number((await db.query<{ n: string }>(`select count(*) as n ${from}`, params.values)).rows[0]?.n ?? 0);
  const rows = await db.query(
    `select lr.id as "requestId", e.id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName", t.code as "leaveType",
            to_char(lr.start_date, 'YYYY-MM-DD') as "startDate", to_char(lr.end_date, 'YYYY-MM-DD') as "endDate"
       ${from}
      order by e.employee_code, lr.start_date, lr.id
      limit ${params.add(q.pageSize)}::int offset ${params.add((q.page - 1) * q.pageSize)}::int`,
    params.values,
  );
  return { yearEnd: q.yearEnd, items: rows.rows, total, page: q.page, pageSize: q.pageSize };
}

