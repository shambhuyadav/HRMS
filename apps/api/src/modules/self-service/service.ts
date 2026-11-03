// Employee self-service change requests (FR-059; DF02; DF03; DF04).
// Profile changes: an employee asks to change permitted operational fields of their own record; an HR reviewer
// from the explicit list approves and the change is applied through the ordinary update path (history, audit,
// outbox). Confidential fields are never requestable (DF04: their maintenance belongs to eligible Admins).
// Attendance corrections: an employee asks for a different status on one of their own attendance records with a
// reason (confidential reason group); the direct manager (HR fallback) decides, and approval writes the ordinary
// amendment with its trail.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { amendRecord, refuseIfPayrollLocked } from '../attendance/service.js';
import { updateEmployee } from '../employee/service.js';
import { cancelActiveApproval, type Decision, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';

/** DF04 permitted operational fields for self-service requests (initial set; extending it is a configuration change). */
export const PROFILE_FIELDS = ['displayName', 'workEmail'] as const;
export type ProfileChanges = Partial<Record<(typeof PROFILE_FIELDS)[number], string>>;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function ownEmployee(grant: AccessGrant): string {
  if (!grant.linkedEmployeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  return grant.linkedEmployeeId;
}

async function setState(tx: Queryable, table: string, companyId: string, id: string, transactionId: string, state: string, actor: string, extra = '') {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, transactionId, state, actor]);
  await tx.query(`update ${table} set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2`, [companyId, id, state, actor]);
}

/** The task's kind, so one decision route per module can refuse foreign tasks before any rule (404). */
async function taskKind(tx: Queryable, grant: AccessGrant, taskId: string): Promise<string | undefined> {
  return (
    await tx.query<{ kind: string }>(
      `select i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3 and t.state = 'PENDING'`,
      [grant.companyId, taskId, grant.userId],
    )
  ).rows[0]?.kind;
}

// ---------------------------------------------------------------------------------------------------------
// Profile change requests
// ---------------------------------------------------------------------------------------------------------

export async function requestProfileChange(tx: Queryable, grant: AccessGrant, changes: ProfileChanges) {
  const employeeId = ownEmployee(grant);
  const requested: ProfileChanges = {};
  if (changes.displayName !== undefined) {
    const name = changes.displayName.trim();
    if (name === '' || name.length > 200) throw new HttpError(422, 'INVALID_DISPLAY_NAME', 'The name must be 1 to 200 characters');
    requested.displayName = name;
  }
  if (changes.workEmail !== undefined) {
    const email = changes.workEmail.trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) throw new HttpError(422, 'INVALID_WORK_EMAIL', 'The work email is not valid');
    requested.workEmail = email;
  }
  const current = (
    await tx.query<{ display_name: string; work_email: string | null }>(`select display_name, work_email from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId])
  ).rows[0];
  if (!current) throw notFound();
  if (requested.displayName === current.display_name) delete requested.displayName;
  if (requested.workEmail === (current.work_email ?? undefined)) delete requested.workEmail;
  if (Object.keys(requested).length === 0) throw new HttpError(422, 'NO_CHANGE', 'Nothing differs from the current record');

  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, 'profile_change', $2, 'SUBMITTED', $3, $3) returning id`,
      [grant.companyId, employeeId, grant.userId],
    )
  ).rows[0]!.id;
  const requestId = (
    await tx.query<{ id: string }>(
      `insert into profile_change_request (company_id, employee_id, transaction_id, requested, current_values, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'SUBMITTED', $6, $6) returning id`,
      [grant.companyId, employeeId, transactionId, requested, { displayName: current.display_name, workEmail: current.work_email }, grant.userId],
    )
  ).rows[0]!.id;
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: 'profile_change', transactionId, ownerEmployeeId: employeeId, actorUserId: grant.userId });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'profile_change_request',
    recordKey: requestId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { fields: Object.keys(requested), requested, state: 'SUBMITTED' } },
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'profile_change.submitted',
    aggregateId: requestId,
    dedupeKey: `profile_change.submitted:${requestId}`,
    payload: { requestId, taskId },
  });
  return { requestId, state: 'SUBMITTED', requested };
}

const profileColumns = `p.id, p.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
  p.requested, p.current_values as "currentValues", p.state, p.applied_at as "appliedAt", p.created_at as "submittedAt", p.version`;

export async function listProfileChanges(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const rows = await db.query(
    `select ${profileColumns} from profile_change_request p join employee e on e.company_id = p.company_id and e.id = p.employee_id
      where p.company_id = $1 and p.employee_id = $2 order by p.created_at desc limit 100`,
    [grant.companyId, employeeId],
  );
  return { items: rows.rows };
}

/** The caller's own request, locked behind its transaction lock (no deadlock with a concurrent decision). */
async function lockOwn(tx: Queryable, table: 'profile_change_request' | 'attendance_correction_request', grant: AccessGrant, requestId: string) {
  const target = (
    await tx.query<{ transaction_id: string }>(`select transaction_id from ${table} where company_id = $1 and id = $2 and employee_id = $3`, [grant.companyId, requestId, grant.linkedEmployeeId])
  ).rows[0];
  if (!target) throw notFound();
  await lockTransaction(tx, target.transaction_id);
  return (await tx.query<{ transaction_id: string; state: string }>(`select transaction_id, state from ${table} where company_id = $1 and id = $2 for update`, [grant.companyId, requestId])).rows[0]!;
}

export async function withdrawProfileChange(tx: Queryable, grant: AccessGrant, requestId: string) {
  const r = await lockOwn(tx, 'profile_change_request', grant, requestId);
  if (r.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'Only a pending request can be withdrawn');
  await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
  await setState(tx, 'profile_change_request', grant.companyId, requestId, r.transaction_id, 'WITHDRAWN', grant.userId);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'profile_change_request',
    recordKey: requestId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'WITHDRAW',
    before: { operational: { state: 'SUBMITTED' } },
    after: { operational: { state: 'WITHDRAWN' } },
  });
  return { requestId, state: 'WITHDRAWN' };
}

/** Reviewer queue with what was asked and what the record held, so the decision is informed. */
export async function profileChangeTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, 'profile_change')).items as { taskId: string; transactionId: string }[];
  if (tasks.length === 0) return { items: [] };
  const rows = (
    await db.query<{ transactionId: string } & Record<string, unknown>>(
      `select p.transaction_id as "transactionId", ${profileColumns},
              json_build_object('displayName', e.display_name, 'workEmail', e.work_email) as "recordNow"
         from profile_change_request p join employee e on e.company_id = p.company_id and e.id = p.employee_id
        where p.company_id = $1 and p.transaction_id = any($2::uuid[])`,
      [grant.companyId, tasks.map((t) => t.transactionId)],
    )
  ).rows;
  return { items: tasks.map((t) => ({ ...t, request: rows.find((r) => r.transactionId === t.transactionId) ?? null })) };
}

export async function decideProfileChange(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: Decision; reason?: string | undefined; idempotencyKey: string }) {
  const kind = await taskKind(tx, grant, taskId);
  if (kind !== undefined && kind !== 'profile_change') throw notFound();
  if (input.decision === 'RETURN') throw new HttpError(422, 'RETURN_NOT_ALLOWED', 'A profile change is approved or rejected; the employee can submit a new one');
  const result = await decideTask(tx, { grant, taskId, ...input, permission: { resource: 'employee', action: 'update' } });
  const r = (
    await tx.query<{ id: string; employee_id: string; requested: ProfileChanges; state: string }>(
      `select id, employee_id, requested, state from profile_change_request where company_id = $1 and transaction_id = $2 for update`,
      [grant.companyId, result.transactionId],
    )
  ).rows[0]!;
  if (result.replayed) return { requestId: r.id, state: r.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { requestId: r.id, state: r.state, replayed: false };

  const outcome = result.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  if (outcome === 'APPROVED') {
    // The ordinary update path applies the change with its own history, audit and event.
    const version = (await tx.query<{ version: number }>(`select version from employee where company_id = $1 and id = $2`, [grant.companyId, r.employee_id])).rows[0]!.version;
    await updateEmployee(tx, grant, r.employee_id, { expectedVersion: version, ...r.requested });
  }
  await setState(tx, 'profile_change_request', grant.companyId, r.id, result.transactionId, outcome, grant.userId, outcome === 'APPROVED' ? ', applied_at = now()' : '');
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'profile_change_request',
    recordKey: r.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.decision,
    before: { operational: { state: 'SUBMITTED' } },
    after: { operational: { state: outcome } },
    reason: input.reason ?? null,
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'profile_change.decided',
    aggregateId: r.id,
    dedupeKey: `profile_change.decided:${r.id}`,
    payload: { requestId: r.id, outcome },
  });
  return { requestId: r.id, state: outcome, replayed: false };
}

// ---------------------------------------------------------------------------------------------------------
// Attendance correction requests
// ---------------------------------------------------------------------------------------------------------

/**
 * A correction changes a presence outcome only. Leave, holidays and outdoor duty have their own requests and
 * rules (balance, calendar, review); a correction must never become a way around them.
 */
export const CORRECTABLE_STATUSES = ['PRESENT', 'HALF_DAY', 'ABSENT'] as const;

export async function requestCorrection(tx: Queryable, grant: AccessGrant, input: { attendanceRecordId: string; status: string; reason: string }) {
  const employeeId = ownEmployee(grant);
  if (!(CORRECTABLE_STATUSES as readonly string[]).includes(input.status)) {
    throw new HttpError(422, 'STATUS_NOT_CORRECTABLE', 'Use a leave or outdoor-duty request for this; a correction can set present, half day or absent');
  }
  const record = (
    await tx.query<{ status_code: string; work_date: string }>(
      `select st.code as status_code, to_char(r.work_date, 'YYYY-MM-DD') as work_date from attendance_record r
         join reference_value st on st.company_id = r.company_id and st.id = r.status_id
        where r.company_id = $1 and r.id = $2 and r.employee_id = $3`,
      [grant.companyId, input.attendanceRecordId, employeeId],
    )
  ).rows[0];
  if (!record) throw notFound();
  const status = (
    await tx.query<{ id: string }>(`select id from reference_value where company_id = $1 and category = 'ATTENDANCE_STATUS' and code = $2 and active`, [grant.companyId, input.status])
  ).rows[0];
  if (!status) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown attendance status');
  if (input.status === record.status_code) throw new HttpError(422, 'NO_CHANGE', 'The record already has this status');
  // BR-047: refused early when a processed payroll used the day; the amendment checks again at approval, when the
  // decision rolls back and the reviewer can still reject.
  await refuseIfPayrollLocked(tx, grant.companyId, employeeId, record.work_date);

  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, 'attendance_correction', $2, 'SUBMITTED', $3, $3) returning id`,
      [grant.companyId, employeeId, grant.userId],
    )
  ).rows[0]!.id;
  const requestId = (
    await tx.query<{ id: string }>(
      `insert into attendance_correction_request (company_id, employee_id, attendance_record_id, transaction_id, requested_status_id, reason, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'SUBMITTED', $7, $7) returning id`,
      [grant.companyId, employeeId, input.attendanceRecordId, transactionId, status.id, input.reason.trim(), grant.userId],
    )
  ).rows[0]!.id;
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: 'attendance_correction', transactionId, ownerEmployeeId: employeeId, actorUserId: grant.userId });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_correction_request',
    recordKey: requestId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { attendanceRecordId: input.attendanceRecordId, workDate: record.work_date, from: record.status_code, to: input.status, state: 'SUBMITTED' }, reason: { reason: input.reason.trim() } },
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'attendance_correction.submitted',
    aggregateId: requestId,
    dedupeKey: `attendance_correction.submitted:${requestId}`,
    payload: { requestId, taskId },
  });
  return { requestId, state: 'SUBMITTED' };
}

function correctionColumns(withReason: boolean) {
  return `c.id, c.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
    c.attendance_record_id as "attendanceRecordId", to_char(r.work_date, 'YYYY-MM-DD') as "workDate", cur.code as "currentStatus",
    req.code as "requestedStatus", ${withReason ? 'c.reason, ' : ''}c.state, c.created_at as "submittedAt", c.version`;
}
const correctionFrom = `from attendance_correction_request c
  join employee e on e.company_id = c.company_id and e.id = c.employee_id
  join attendance_record r on r.company_id = c.company_id and r.id = c.attendance_record_id
  join reference_value cur on cur.company_id = r.company_id and cur.id = r.status_id
  join reference_value req on req.company_id = c.company_id and req.id = c.requested_status_id`;

export async function listCorrections(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const rows = await db.query(
    `select ${correctionColumns(grant.allowedFieldGroups.includes('reason'))} ${correctionFrom}
      where c.company_id = $1 and c.employee_id = $2 order by c.created_at desc limit 100`,
    [grant.companyId, employeeId],
  );
  return { items: rows.rows };
}

export async function withdrawCorrection(tx: Queryable, grant: AccessGrant, requestId: string) {
  const r = await lockOwn(tx, 'attendance_correction_request', grant, requestId);
  if (r.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'Only a pending request can be withdrawn');
  await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
  await setState(tx, 'attendance_correction_request', grant.companyId, requestId, r.transaction_id, 'WITHDRAWN', grant.userId);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_correction_request',
    recordKey: requestId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'WITHDRAW',
    before: { operational: { state: 'SUBMITTED' } },
    after: { operational: { state: 'WITHDRAWN' } },
  });
  return { requestId, state: 'WITHDRAWN' };
}

/** Reviewer queue; the employee's reason appears only for a reviewer granted the attendance reason group. */
export async function correctionTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, 'attendance_correction')).items as { taskId: string; transactionId: string }[];
  if (tasks.length === 0) return { items: [] };
  const rows = (
    await db.query<{ transactionId: string } & Record<string, unknown>>(
      `select c.transaction_id as "transactionId", ${correctionColumns(grant.allowedFieldGroups.includes('reason'))} ${correctionFrom}
        where c.company_id = $1 and c.transaction_id = any($2::uuid[])`,
      [grant.companyId, tasks.map((t) => t.transactionId)],
    )
  ).rows;
  return { items: tasks.map((t) => ({ ...t, request: rows.find((r) => r.transactionId === t.transactionId) ?? null })) };
}

export async function decideCorrection(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: Decision; reason?: string | undefined; idempotencyKey: string }) {
  const kind = await taskKind(tx, grant, taskId);
  if (kind !== undefined && kind !== 'attendance_correction') throw notFound();
  if (input.decision === 'RETURN') throw new HttpError(422, 'RETURN_NOT_ALLOWED', 'A correction is approved or rejected; the employee can submit a new one');
  const result = await decideTask(tx, { grant, taskId, ...input, permission: { resource: 'attendance', action: 'approve_correction' } });
  const c = (
    await tx.query<{ id: string; employee_id: string; attendance_record_id: string; requested_code: string; reason: string; state: string }>(
      `select c.id, c.employee_id, c.attendance_record_id, req.code as requested_code, c.reason, c.state
         from attendance_correction_request c join reference_value req on req.company_id = c.company_id and req.id = c.requested_status_id
        where c.company_id = $1 and c.transaction_id = $2 for update of c`,
      [grant.companyId, result.transactionId],
    )
  ).rows[0]!;
  if (result.replayed) return { requestId: c.id, state: c.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { requestId: c.id, state: c.state, replayed: false };

  const outcome = result.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  if (outcome === 'APPROVED') {
    // The ordinary amendment, attributed to the approver; later processing keeps it (amended records are skipped).
    const version = (await tx.query<{ version: number }>(`select version from attendance_record where company_id = $1 and id = $2`, [grant.companyId, c.attendance_record_id])).rows[0]!.version;
    await amendRecord(tx, grant, c.attendance_record_id, { expectedVersion: version, status: c.requested_code, reason: c.reason }, { decidedCorrection: true });
  }
  await setState(tx, 'attendance_correction_request', grant.companyId, c.id, result.transactionId, outcome, grant.userId);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_correction_request',
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
    topic: 'attendance_correction.decided',
    aggregateId: c.id,
    dedupeKey: `attendance_correction.decided:${c.id}`,
    payload: { requestId: c.id, outcome },
  });
  return { requestId: c.id, state: outcome, replayed: false };
}
