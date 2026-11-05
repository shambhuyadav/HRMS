// Effective-dated employment changes (FR-003, FR-006, FR-089 base; BR-002, BR-005; CI13).
// A change closes the current period at `effectiveFrom` and opens a new one; prior rows are kept.
// A date behind the latest change, or stacked on a future-dated one, is refused: a value in force is never overwritten (DF08).
// No correction of these histories exists. DF08 and FR-089 fix its form (a new, linked, attributable superseding event) but not
// who may make one or what happens to days and payroll already worked out on the old values: an owner question (docs/03).
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, assertNotOwnRecord, canAccessEmployee } from '../access/authorize.js';
import { lastWorkingDateOf, refuseAfterLastWorkingDate } from '../leave/service.js';
import { requireUsableMaster } from '../org/masters.js';
import { assertStatusTransition, withStatusSource } from './status.js';

const ACTIVE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'];
const ENDED_STATUSES = ['INACTIVE_SEPARATED', 'ARCHIVED'];

async function lockEmployee(tx: Queryable, grant: AccessGrant, employeeId: string): Promise<{ joiningDate: string; status: string }> {
  if (!(await canAccessEmployee(tx, grant, employeeId))) throw notFound();
  // Row lock serialises concurrent changes to the same employee's dated history.
  const row = (
    await tx.query<{ joining_date: string; status: string }>(
      `select e.joining_date, st.code as status
         from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where e.company_id = $1 and e.id = $2 for update of e`,
      [grant.companyId, employeeId],
    )
  ).rows[0];
  if (!row) throw notFound();
  return { joiningDate: row.joining_date, status: row.status };
}

/**
 * Closes the period open at `effectiveFrom`; refuses when a period already starts on or after it, or ends after it. A manager
 * removal ends a period with no successor, so that end is the latest change: a date before it would rewrite a closed period.
 */
async function closeCurrentPeriod(
  tx: Queryable,
  table: 'employment_assignment' | 'manager_assignment' | 'shift_assignment',
  companyId: string,
  employeeId: string,
  effectiveFrom: string,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const later = await tx.query(
    `select 1 from ${table} where company_id = $1 and employee_id = $2 and (effective_from >= $3::date or effective_to > $3::date)`,
    [companyId, employeeId, effectiveFrom],
  );
  if (later.rowCount) {
    throw new HttpError(409, 'CHANGE_NOT_LATEST', 'A change on or after this date already exists; a new change must start after the latest one');
  }
  const closed = await tx.query<Record<string, unknown>>(
    `update ${table} set effective_to = $3::date, updated_by = $4
      where company_id = $1 and employee_id = $2
        and effective_from < $3::date and (effective_to is null or effective_to > $3::date)
      returning *`,
    [companyId, employeeId, effectiveFrom, userId],
  );
  return closed.rows[0] ?? null;
}

function assertNotBeforeJoining(effectiveFrom: string, joiningDate: string): void {
  if (effectiveFrom < joiningDate) throw new HttpError(422, 'RULE_VIOLATION', 'Change cannot take effect before the joining date');
}

export interface ManagerChange {
  managerEmployeeId: string | null;
  effectiveFrom: string;
  /** Required when removing the manager (DF04: explicit top-level/no-manager reason). */
  reason?: string | undefined;
}

/**
 * C4 "A task assignment does not automatically transfer to new manager": open approval tasks are left alone here. The
 * actor's own reporting line and any line naming the actor as manager are refused: the first picks their own approver, the
 * second widens their own TEAM scope (C4; DF02).
 */
export async function changeManager(tx: Queryable, grant: AccessGrant, employeeId: string, change: ManagerChange): Promise<void> {
  const employee = await lockEmployee(tx, grant, employeeId);
  await reassertAccess(tx, grant, 'employee', 'update', ['operational']);
  await assertNotOwnRecord(tx, grant, employeeId);
  assertNotBeforeJoining(change.effectiveFrom, employee.joiningDate);
  if (change.managerEmployeeId === null && !change.reason?.trim()) {
    throw new HttpError(422, 'REASON_REQUIRED', 'Removing a manager requires a recorded reason');
  }
  if (change.managerEmployeeId !== null) {
    if (change.managerEmployeeId === employeeId) throw new HttpError(422, 'RULE_VIOLATION', 'An employee cannot manage themselves');
    await assertNotOwnRecord(tx, grant, change.managerEmployeeId);
    // The new manager must be visible in the actor's own scope and be an active employment (CI13).
    if (!(await canAccessEmployee(tx, grant, change.managerEmployeeId))) throw new HttpError(422, 'INVALID_REFERENCE', 'Manager not found');
    const status = (
      await tx.query<{ code: string }>(
        `select st.code from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
          where e.company_id = $1 and e.id = $2`,
        [grant.companyId, change.managerEmployeeId],
      )
    ).rows[0]?.code;
    if (!status || !ACTIVE_STATUSES.includes(status)) {
      throw new HttpError(422, 'RULE_VIOLATION', 'The manager must be an active employee');
    }
  }

  const closed = await closeCurrentPeriod(tx, 'manager_assignment', grant.companyId, employeeId, change.effectiveFrom, grant.userId);
  if (change.managerEmployeeId !== null) {
    await tx.query(
      `insert into manager_assignment (company_id, employee_id, manager_employee_id, effective_from, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $5)`,
      [grant.companyId, employeeId, change.managerEmployeeId, change.effectiveFrom, grant.userId],
    );
  } else {
    // DF04: the explicitly recorded reason, the same field activation writes. The audit below keeps each one given.
    await tx.query(`update employee set no_manager_reason = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, employeeId, change.reason!.trim(), grant.userId]);
  }
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'manager_assignment',
    recordKey: employeeId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    before: { operational: { managerEmployeeId: closed?.manager_employee_id ?? null } },
    after: { operational: { managerEmployeeId: change.managerEmployeeId, effectiveFrom: change.effectiveFrom } },
    reason: change.reason ?? null,
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'employee.manager_changed',
    aggregateId: employeeId,
    dedupeKey: `employee.manager_changed:${employeeId}:${change.effectiveFrom}`,
    payload: { employeeId, effectiveFrom: change.effectiveFrom },
  });
}

export interface AssignmentChange {
  departmentId: string;
  locationId: string;
  designationId: string;
  gradeId?: string | undefined;
  effectiveFrom: string;
  reason?: string | undefined;
}

export async function changeAssignment(tx: Queryable, grant: AccessGrant, employeeId: string, change: AssignmentChange): Promise<void> {
  const employee = await lockEmployee(tx, grant, employeeId);
  await reassertAccess(tx, grant, 'employee', 'update', ['operational']);
  assertNotBeforeJoining(change.effectiveFrom, employee.joiningDate);

  // A filtered actor cannot move an employee outside its own scope (BR-006).
  const { departments, locations } = grant.filters;
  if ((departments.length > 0 && !departments.includes(change.departmentId)) || (locations.length > 0 && !locations.includes(change.locationId))) {
    throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  }
  for (const [table, id] of [
    ['department', change.departmentId],
    ['location', change.locationId],
    ['designation', change.designationId],
    ['grade', change.gradeId],
  ] as const) {
    if (id) await requireUsableMaster(tx, table, grant.companyId, id, change.effectiveFrom);
  }

  const closed = await closeCurrentPeriod(tx, 'employment_assignment', grant.companyId, employeeId, change.effectiveFrom, grant.userId);
  await tx.query(
    `insert into employment_assignment (company_id, employee_id, department_id, location_id, designation_id, grade_id,
                                        effective_from, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $8)`,
    [grant.companyId, employeeId, change.departmentId, change.locationId, change.designationId, change.gradeId ?? null, change.effectiveFrom, grant.userId],
  );
  const pick = (r: Record<string, unknown> | null) =>
    r ? { departmentId: r.department_id, locationId: r.location_id, designationId: r.designation_id, gradeId: r.grade_id } : null;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'employment_assignment',
    recordKey: employeeId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    before: { operational: { assignment: pick(closed) } },
    after: {
      operational: {
        assignment: { departmentId: change.departmentId, locationId: change.locationId, designationId: change.designationId, gradeId: change.gradeId ?? null },
        effectiveFrom: change.effectiveFrom,
      },
    },
    reason: change.reason ?? null,
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'employee.assignment_changed',
    aggregateId: employeeId,
    dedupeKey: `employee.assignment_changed:${employeeId}:${change.effectiveFrom}`,
    payload: { employeeId, effectiveFrom: change.effectiveFrom },
  });
}

export interface ShiftChange {
  shiftId: string;
  effectiveFrom: string;
}

/**
 * FR-023 "an assignment outside employee employment dates is rejected": not before joining, not for an employment that
 * has ended, and not after the approved (inclusive) last working date of an employee still on notice (DF04, I-41). The
 * route and the import share this; the import's row code is the refusal's code.
 */
export async function changeShift(tx: Queryable, grant: AccessGrant, employeeId: string, change: ShiftChange): Promise<void> {
  const employee = await lockEmployee(tx, grant, employeeId);
  await reassertAccess(tx, grant, 'shift', 'assign', ['operational']);
  assertNotBeforeJoining(change.effectiveFrom, employee.joiningDate);
  if (ENDED_STATUSES.includes(employee.status)) throw new HttpError(422, 'EMPLOYMENT_ENDED', 'The employment has ended, so no shift can be assigned');
  refuseAfterLastWorkingDate(await lastWorkingDateOf(tx, grant.companyId, employeeId), change.effectiveFrom, 'A shift cannot start after the approved last working date');
  const shift = await tx.query(`select 1 from shift where company_id = $1 and id = $2 and active`, [grant.companyId, change.shiftId]);
  if (!shift.rowCount) throw new HttpError(422, 'INVALID_REFERENCE', 'Shift is not active in this company');
  const closed = await closeCurrentPeriod(tx, 'shift_assignment', grant.companyId, employeeId, change.effectiveFrom, grant.userId);
  await tx.query(
    `insert into shift_assignment (company_id, employee_id, shift_id, effective_from, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $5)`,
    [grant.companyId, employeeId, change.shiftId, change.effectiveFrom, grant.userId],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'shift_assignment',
    recordKey: employeeId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    before: { operational: { shiftId: closed?.shift_id ?? null } },
    after: { operational: { shiftId: change.shiftId, effectiveFrom: change.effectiveFrom } },
  });
}

/**
 * DF04 activation: DRAFT -> ACTIVE_PROBATION when the employee has a work email, and on the check date
 * (joining date, or today if joining is in the past) a job assignment, a shift and either a manager or an
 * explicit no-manager reason. Confirmation, notice and separation are separate workflows (FR-081, FR-051).
 */
export async function activateEmployee(
  tx: Queryable,
  grant: AccessGrant,
  employeeId: string,
  input: { expectedVersion: number; noManagerReason?: string | undefined },
): Promise<void> {
  const employee = await lockEmployee(tx, grant, employeeId);
  await reassertAccess(tx, grant, 'employee', 'activate', ['operational']);
  const row = (
    await tx.query<{
      status: string;
      version: number;
      work_email: string | null;
      check_date: string;
      has_assignment: boolean;
      has_shift: boolean;
      has_manager: boolean;
    }>(
      `with e as (
         select e.*, st.code as status,
                greatest(e.joining_date, hrms_business_date(e.company_id, now())) as check_date
           from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
          where e.company_id = $1 and e.id = $2)
       select e.status, e.version, e.work_email, to_char(e.check_date, 'YYYY-MM-DD') as check_date,
              exists (select 1 from employment_assignment a where a.company_id = e.company_id and a.employee_id = e.id
                         and a.effective_from <= e.check_date and (a.effective_to is null or a.effective_to > e.check_date)) as has_assignment,
              exists (select 1 from shift_assignment s join shift sh on sh.company_id = s.company_id and sh.id = s.shift_id and sh.active
                       where s.company_id = e.company_id and s.employee_id = e.id
                         and s.effective_from <= e.check_date and (s.effective_to is null or s.effective_to > e.check_date)) as has_shift,
              exists (select 1 from manager_assignment m where m.company_id = e.company_id and m.employee_id = e.id
                         and m.effective_from <= e.check_date and (m.effective_to is null or m.effective_to > e.check_date)) as has_manager
         from e`,
      [grant.companyId, employeeId],
    )
  ).rows[0];
  if (!row) throw notFound();
  if (row.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (row.status !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only draft employees can be activated');

  const missing: string[] = [];
  if (!row.work_email) missing.push('WORK_EMAIL');
  if (!row.has_assignment) missing.push('JOB_ASSIGNMENT');
  if (!row.has_shift) missing.push('SHIFT_ASSIGNMENT');
  if (!row.has_manager && !input.noManagerReason?.trim()) missing.push('MANAGER_OR_NO_MANAGER_REASON');
  if (missing.length > 0) {
    throw new HttpError(422, 'ACTIVATION_REQUIREMENTS_MISSING', 'The employee cannot be activated yet', { missing, checkDate: row.check_date });
  }

  const noManagerReason = row.has_manager ? null : input.noManagerReason!.trim();
  assertStatusTransition(row.status, 'ACTIVE_PROBATION');
  // Employment, and with it probation, starts on the joining date whether activation comes before or after it.
  const updated = await withStatusSource(tx, { kind: 'ACTIVATION', effectiveDate: employee.joiningDate }, async () => (
    await tx.query<{ version: number }>(
      `update employee set status_id = (select id from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' and code = 'ACTIVE_PROBATION'),
              no_manager_reason = $3, updated_by = $4
        where company_id = $1 and id = $2 returning version`,
      [grant.companyId, employeeId, noManagerReason, grant.userId],
    )
  ).rows[0]!);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'employee',
    recordKey: employeeId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'ACTIVATE',
    priorVersion: row.version,
    newVersion: updated.version,
    before: { operational: { status: 'DRAFT' } },
    after: { operational: { status: 'ACTIVE_PROBATION', noManagerReason } },
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'employee.activated',
    aggregateId: employeeId,
    dedupeKey: `employee.activated:${employeeId}`,
    payload: { employeeId, version: updated.version },
  });
}

export interface JoiningDateCorrection {
  expectedVersion: number;
  joiningDate: string;
  reason: string;
}

/**
 * BR-002: corrects the joining date of a draft employee, before anything has happened under it (nothing has been processed
 * for a draft). The joining assignment moves with it, inside each master's valid period. A date that would put the joining
 * after a later assignment, manager or shift period, or not after the birth date, is refused. The prior date is kept.
 */
export async function correctJoiningDate(tx: Queryable, grant: AccessGrant, employeeId: string, input: JoiningDateCorrection): Promise<void> {
  const employee = await lockEmployee(tx, grant, employeeId);
  await reassertAccess(tx, grant, 'employee', 'update', ['operational']);
  await assertNotOwnRecord(tx, grant, employeeId);
  const current = (
    await tx.query<{ version: number; date_of_birth: string | null }>(`select version, date_of_birth from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId])
  ).rows[0]!;
  if (current.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (employee.status !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only the joining date of a draft employee can be corrected');
  if (input.joiningDate === employee.joiningDate) throw new HttpError(422, 'NO_CHANGE', 'That is already the joining date');
  if (current.date_of_birth !== null && input.joiningDate <= current.date_of_birth) {
    throw new HttpError(422, 'CHRONOLOGY_CONFLICT', 'The joining date must be after the birth date', { conflict: 'BIRTH_DATE' });
  }
  const assignments = (
    await tx.query<{ id: string; department_id: string; location_id: string; designation_id: string; grade_id: string | null; effective_from: string }>(
      `select id, department_id, location_id, designation_id, grade_id, effective_from from employment_assignment where company_id = $1 and employee_id = $2 order by effective_from`,
      [grant.companyId, employeeId],
    )
  ).rows;
  if (assignments[1] && input.joiningDate >= assignments[1].effective_from) {
    throw new HttpError(422, 'CHRONOLOGY_CONFLICT', 'A later assignment starts on or before this date', { conflict: 'ASSIGNMENT', effectiveFrom: assignments[1].effective_from });
  }
  for (const table of ['manager_assignment', 'shift_assignment'] as const) {
    const earlier = (await tx.query<{ effective_from: string }>(`select min(effective_from) as effective_from from ${table} where company_id = $1 and employee_id = $2`, [grant.companyId, employeeId])).rows[0]?.effective_from;
    if (earlier && earlier < input.joiningDate) {
      throw new HttpError(422, 'CHRONOLOGY_CONFLICT', 'A manager or shift period starts before this date', { conflict: table === 'manager_assignment' ? 'MANAGER' : 'SHIFT', effectiveFrom: earlier });
    }
  }
  const first = assignments[0];
  if (first) {
    await requireUsableMaster(tx, 'department', grant.companyId, first.department_id, input.joiningDate);
    await requireUsableMaster(tx, 'location', grant.companyId, first.location_id, input.joiningDate);
    await requireUsableMaster(tx, 'designation', grant.companyId, first.designation_id, input.joiningDate);
    if (first.grade_id) await requireUsableMaster(tx, 'grade', grant.companyId, first.grade_id, input.joiningDate);
    await tx.query(`update employment_assignment set effective_from = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, first.id, input.joiningDate, grant.userId]);
  }
  const updated = (
    await tx.query<{ version: number }>(`update employee set joining_date = $3, updated_by = $4 where company_id = $1 and id = $2 returning version`, [grant.companyId, employeeId, input.joiningDate, grant.userId])
  ).rows[0]!;
  await tx.query(`insert into employee_joining_date_change (company_id, employee_id, prior_date, new_date, actor_user_id) values ($1, $2, $3, $4, $5)`, [
    grant.companyId,
    employeeId,
    employee.joiningDate,
    input.joiningDate,
    grant.userId,
  ]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'employee',
    recordKey: employeeId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CORRECT_JOINING_DATE',
    priorVersion: current.version,
    newVersion: updated.version,
    before: { operational: { joiningDate: employee.joiningDate } },
    after: { operational: { joiningDate: input.joiningDate } },
    reason: input.reason.trim(),
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'employee.updated',
    aggregateId: employeeId,
    dedupeKey: `employee.updated:${employeeId}:${updated.version}`,
    payload: { employeeId, version: updated.version },
  });
}

/**
 * DF08 "Unsubmitted drafts may be cancelled and retained": closes a draft who never joined (employee.deactivate), keeping the
 * record, its code and its work email. An account still linked to the record must be unlinked first, because a link would
 * keep own-record access to a record that is closed.
 */
export async function closeDraftEmployee(tx: Queryable, grant: AccessGrant, employeeId: string, input: { expectedVersion: number; reason: string }): Promise<void> {
  const employee = await lockEmployee(tx, grant, employeeId);
  await reassertAccess(tx, grant, 'employee', 'deactivate', ['operational']);
  await assertNotOwnRecord(tx, grant, employeeId);
  const version = (await tx.query<{ version: number }>(`select version from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId])).rows[0]!.version;
  if (version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (employee.status !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft employee can be closed');
  assertStatusTransition(employee.status, 'ARCHIVED');
  const linked = await tx.query(`select 1 from user_employee_link where company_id = $1 and employee_id = $2 and (effective_to is null or effective_to > $3::date)`, [grant.companyId, employeeId, grant.businessDate]);
  if (linked.rowCount) throw new HttpError(409, 'USER_LINK_OPEN', 'End the user link of this employee first');
  const updated = await withStatusSource(tx, { kind: 'DRAFT_CLOSED', effectiveDate: grant.businessDate }, async () => (
    await tx.query<{ version: number }>(
      `update employee set status_id = (select id from reference_value where company_id = $1 and category = 'EMPLOYEE_STATUS' and code = 'ARCHIVED'), updated_by = $3
        where company_id = $1 and id = $2 returning version`,
      [grant.companyId, employeeId, grant.userId],
    )
  ).rows[0]!);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'employee',
    recordKey: employeeId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CLOSE_DRAFT',
    priorVersion: version,
    newVersion: updated.version,
    before: { operational: { status: 'DRAFT' } },
    after: { operational: { status: 'ARCHIVED' } },
    reason: input.reason.trim(),
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'employee.status_changed',
    aggregateId: employeeId,
    dedupeKey: `employee.status_changed:${employeeId}:${updated.version}`,
    payload: { employeeId, status: 'ARCHIVED', version: updated.version },
  });
}

export async function employmentHistory(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) return null;
  const dates = (
    await db.query<{ joining_date: string; confirmation_date: string | null; leaving_date: string | null; prior_employee_id: string | null; prior_code: string | null; next_employee_id: string | null; next_code: string | null }>(
      `select e.joining_date, e.confirmation_date,
              (select x.leaving_date from exit_case x where x.company_id = e.company_id and x.employee_id = e.id and x.state in ('APPROVED', 'SEPARATED')
                order by x.approved_at desc nulls last limit 1) as leaving_date,
              e.prior_employee_id, p.employee_code as prior_code, n.id as next_employee_id, n.employee_code as next_code
         from employee e
         left join employee p on p.company_id = e.company_id and p.id = e.prior_employee_id
         left join employee n on n.company_id = e.company_id and n.prior_employee_id = e.id
        where e.company_id = $1 and e.id = $2`,
      [grant.companyId, employeeId],
    )
  ).rows[0];
  if (!dates) return null;
  const statuses = await db.query(
    `select st.code as status, ps.code as "priorStatus", h.effective_date as "effectiveDate", h.source_kind as "sourceKind", h.source_id as "sourceId",
            h.actor_user_id as "actorUserId", u.account_key as "actorAccountKey", h.recorded_at as "recordedAt"
       from employee_status_history h
       join reference_value st on st.company_id = h.company_id and st.id = h.status_id
       left join reference_value ps on ps.company_id = h.company_id and ps.id = h.prior_status_id
       left join user_account u on u.id = h.actor_user_id
      where h.company_id = $1 and h.employee_id = $2 order by h.recorded_at, h.id`,
    [grant.companyId, employeeId],
  );
  const joiningDateChanges = await db.query(
    `select c.prior_date as "priorDate", c.new_date as "newDate", c.actor_user_id as "actorUserId", u.account_key as "actorAccountKey", c.recorded_at as "recordedAt"
       from employee_joining_date_change c join user_account u on u.id = c.actor_user_id
      where c.company_id = $1 and c.employee_id = $2 order by c.recorded_at, c.id`,
    [grant.companyId, employeeId],
  );
  const assignments = await db.query(
    `select ea.effective_from as "effectiveFrom", ea.effective_to as "effectiveTo",
            d.code as "departmentCode", d.name as "departmentName", l.code as "locationCode", l.name as "locationName",
            g.code as "designationCode", g.name as "designationName", gr.code as "gradeCode"
       from employment_assignment ea
       join department d on d.company_id = ea.company_id and d.id = ea.department_id
       join location l on l.company_id = ea.company_id and l.id = ea.location_id
       join designation g on g.company_id = ea.company_id and g.id = ea.designation_id
       left join grade gr on gr.company_id = ea.company_id and gr.id = ea.grade_id
      where ea.company_id = $1 and ea.employee_id = $2 order by ea.effective_from`,
    [grant.companyId, employeeId],
  );
  const managers = await db.query(
    `select ma.effective_from as "effectiveFrom", ma.effective_to as "effectiveTo",
            m.id as "managerId", m.employee_code as "managerCode", m.display_name as "managerName"
       from manager_assignment ma
       join employee m on m.company_id = ma.company_id and m.id = ma.manager_employee_id
      where ma.company_id = $1 and ma.employee_id = $2 order by ma.effective_from`,
    [grant.companyId, employeeId],
  );
  const shifts = await db.query(
    `select sa.effective_from as "effectiveFrom", sa.effective_to as "effectiveTo", s.code as "shiftCode", s.name as "shiftName"
       from shift_assignment sa join shift s on s.company_id = sa.company_id and s.id = sa.shift_id
      where sa.company_id = $1 and sa.employee_id = $2 order by sa.effective_from`,
    [grant.companyId, employeeId],
  );
  return {
    employeeId,
    joiningDate: dates.joining_date,
    confirmationDate: dates.confirmation_date,
    // The approved last working date of a live or completed exit (inclusive); a withdrawn exit has none.
    leavingDate: dates.leaving_date,
    priorEmployment: dates.prior_employee_id ? { employeeId: dates.prior_employee_id, employeeCode: dates.prior_code } : null,
    nextEmployment: dates.next_employee_id ? { employeeId: dates.next_employee_id, employeeCode: dates.next_code } : null,
    statuses: statuses.rows,
    joiningDateChanges: joiningDateChanges.rows,
    assignments: assignments.rows,
    managers: managers.rows,
    shifts: shifts.rows,
  };
}
