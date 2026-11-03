// Employee processes (FR-015, FR-016; DB076; F1 "Exit and employee processes"). A process assigns a published
// template revision to an employee; its tasks are copied with their owner, required flag, evidence rule and due
// date (effective date + offset). Each completion records actor, assignment and business date; reassignment keeps
// the prior owner in the history; a required task can never be skipped; reopening needs a reason and its own duty;
// a process cannot close while a required task is open. Overdue = due date before the company-local business date
// and the task still open in an open process (derived on read, never stored).
import { enqueueEvent } from '../../audit/audit.js';
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { decodeUpload, type FileStore } from '../../storage/files.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { isEligibleReviewer, lockTransaction } from '../workflow/engine.js';
import { actorOf, assertInScope, assertNotSelf, audit, holds, isSelf, requireDate, setRootState, userIsEmployee } from './common.js';
import { validateOwner } from './templates.js';

export const PROCESS_KIND = 'employee_process';

interface ProcessRow {
  id: string;
  employee_id: string;
  transaction_id: string;
  state: string;
  exit_case_id: string | null;
  version: number;
}

interface TaskRow {
  id: string;
  employee_process_id: string;
  employee_id: string;
  transaction_id: string;
  process_state: string;
  exit_case_id: string | null;
  code: string;
  title: string;
  owner_role_code: string | null;
  owner_user_id: string | null;
  required: boolean;
  evidence_required: boolean;
  due_date: string;
  state: string;
  evidence_attachment_id: string | null;
  version: number;
}

export interface EvidenceInput {
  fileName: string;
  contentBase64: string;
}

/** An evidence upload stored as PENDING_SCAN; the route scans it right after the transaction commits (FR-106). */
export interface StoredEvidence {
  attachmentId: string;
  bytes: Buffer;
}

async function permissionId(db: Queryable, resource: string, action: string, fieldGroup: string): Promise<string> {
  return (await db.query<{ id: string }>(`select id from permission where resource = $1 and action = $2 and field_group = $3`, [resource, action, fieldGroup])).rows[0]!.id;
}

async function event(
  tx: Queryable,
  grant: { companyId: string; userId: string; assignmentId: string | null },
  businessDate: string,
  processId: string,
  e: {
    action: string;
    taskId?: string | null;
    fromState?: string | null;
    toState?: string | null;
    priorOwner?: { role: string | null; user: string | null };
    newOwner?: { role: string | null; user: string | null };
    evidenceAttachmentId?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await tx.query(
    `insert into employee_process_event (company_id, employee_process_id, task_id, action, from_state, to_state, prior_owner_role_code, prior_owner_user_id,
                                         new_owner_role_code, new_owner_user_id, evidence_attachment_id, note, actor_user_id, acting_assignment_id, business_date, created_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $13)`,
    [
      grant.companyId,
      processId,
      e.taskId ?? null,
      e.action,
      e.fromState ?? null,
      e.toState ?? null,
      e.priorOwner?.role ?? null,
      e.priorOwner?.user ?? null,
      e.newOwner?.role ?? null,
      e.newOwner?.user ?? null,
      e.evidenceAttachmentId ?? null,
      e.note?.trim() || null,
      grant.userId,
      grant.assignmentId,
      businessDate,
    ],
  );
}

async function taskAssigned(tx: Queryable, companyId: string, taskId: string, ownerUserId: string | null, occurrence: string): Promise<void> {
  if (!ownerUserId) return;
  await enqueueEvent(tx, {
    companyId,
    topic: 'employee_process.task_assigned',
    aggregateId: taskId,
    dedupeKey: `employee_process.task_assigned:${taskId}:${occurrence}`,
    payload: { taskId, ownerUserId },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Starting a process
// ---------------------------------------------------------------------------------------------------------------

export interface StartInput {
  processCode: string;
  effectiveDate?: string | undefined;
  exitCaseId?: string | undefined;
  ownerUserId?: string | undefined;
}

export async function startProcess(tx: Queryable, grant: AccessGrant, employeeId: string, input: StartInput) {
  await assertInScope(tx, grant, employeeId);
  assertNotSelf(grant, employeeId);
  const effectiveDate = requireDate(input.effectiveDate ?? grant.businessDate, 'INVALID_DATE', 'effective date');
  const template = (
    await tx.query<{ id: string; active: boolean; type: string; revision_id: string | null; revision: number | null; name: string }>(
      `select p.id, p.active, t.code as type, p.name, r.id as revision_id, r.revision
         from lifecycle_process p
         join reference_value t on t.company_id = p.company_id and t.id = p.process_type_id
         left join lifecycle_process_revision r on r.company_id = p.company_id and r.process_id = p.id and r.state = 'PUBLISHED'
        where p.company_id = $1 and p.code = $2`,
      [grant.companyId, input.processCode],
    )
  ).rows[0];
  if (!template) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown process template');
  if (!template.active) throw new HttpError(422, 'TEMPLATE_INACTIVE', 'The process template is inactive');
  if (!template.revision_id) throw new HttpError(422, 'TEMPLATE_NOT_PUBLISHED', 'The process template has no published revision');

  // An exit clearance checklist belongs to one approved exit of the same employee (CI14); one live per exit.
  if ((template.type === 'EXIT') !== (input.exitCaseId !== undefined)) {
    throw new HttpError(422, 'EXIT_CASE_MISMATCH', 'An exit clearance template needs the exit case, and only an exit clearance template takes one');
  }
  if (input.exitCaseId) {
    const target = (
      await tx.query<{ transaction_id: string }>(`select transaction_id from exit_case where company_id = $1 and id = $2 and employee_id = $3`, [grant.companyId, input.exitCaseId, employeeId])
    ).rows[0];
    if (!target) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown exit case for this employee');
    // Serialised with the exit's own changes: an approved withdrawal cancels the live checklist and the final release
    // reads it under this lock, so neither can miss a checklist started at the same moment.
    await lockTransaction(tx, target.transaction_id);
    const exit = (await tx.query<{ state: string; released_at: Date | null }>(`select state, released_at from exit_case where company_id = $1 and id = $2`, [grant.companyId, input.exitCaseId])).rows[0]!;
    if (!['APPROVED', 'SEPARATED'].includes(exit.state) || exit.released_at) {
      throw new HttpError(409, 'EXIT_NOT_APPROVED', 'A clearance checklist starts once the exit is approved and before its final release');
    }
    const live = await tx.query(`select 1 from employee_process where company_id = $1 and exit_case_id = $2 and state <> 'CANCELLED'`, [grant.companyId, input.exitCaseId]);
    if ((live.rowCount ?? 0) > 0) throw new HttpError(409, 'CLEARANCE_EXISTS', 'This exit already has a clearance checklist');
  }

  const owner = input.ownerUserId ?? grant.userId;
  if (input.ownerUserId && !(await isEligibleReviewer(tx, grant.companyId, owner, await permissionId(tx, 'employee_process', 'manage', 'operational'), employeeId))) {
    throw new HttpError(422, 'INVALID_OWNER', 'The process owner must be able to manage employee processes and must not be the employee');
  }
  // Named task owners never include the employee's own user (C4); the employee's own tasks are owned by the role.
  // A named owner must also be able to open and complete the task: the completion duty with row scope over this
  // employee (I-25: nothing is assigned to someone who could not open it).
  const named = (
    await tx.query<{ owner_user_id: string; codes: string[] }>(
      `select owner_user_id, array_agg(code order by sequence) as codes from lifecycle_process_task
        where company_id = $1 and revision_id = $2 and owner_user_id is not null group by owner_user_id`,
      [grant.companyId, template.revision_id],
    )
  ).rows;
  const completion = named.length > 0 ? await permissionId(tx, 'employee_process', 'complete_task', 'operational') : '';
  for (const n of named) {
    if (await userIsEmployee(tx, grant.companyId, n.owner_user_id, employeeId)) {
      throw new HttpError(422, 'INVALID_OWNER', 'A task of this template is owned by the employee’s own user; reassign it in the template', { tasks: n.codes });
    }
    if (!(await isEligibleReviewer(tx, grant.companyId, n.owner_user_id, completion, employeeId))) {
      throw new HttpError(422, 'INVALID_OWNER', 'A named owner of this template cannot act on this employee; reassign the task in the template', { tasks: n.codes });
    }
  }

  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'OPEN', $4, $4) returning id`,
      [grant.companyId, PROCESS_KIND, employeeId, grant.userId],
    )
  ).rows[0]!.id;
  const processId = (
    await tx.query<{ id: string }>(
      `insert into employee_process (company_id, employee_id, process_id, process_revision_id, transaction_id, effective_date, owner_user_id, exit_case_id, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'OPEN', $9, $9) returning id`,
      [grant.companyId, employeeId, template.id, template.revision_id, transactionId, effectiveDate, owner, input.exitCaseId ?? null, grant.userId],
    )
  ).rows[0]!.id;
  const tasks = (
    await tx.query<{ id: string; owner_user_id: string | null }>(
      `insert into employee_process_task (company_id, employee_process_id, employee_id, template_task_id, sequence, code, title, owner_role_code, owner_user_id,
                                          required, evidence_required, due_date, state, created_by, updated_by)
       select t.company_id, $3, $4, t.id, t.sequence, t.code, t.title, t.owner_role_code, t.owner_user_id, t.required, t.evidence_required,
              $5::date + t.due_offset_days, 'OPEN', $6, $6
         from lifecycle_process_task t where t.company_id = $1 and t.revision_id = $2 order by t.sequence
       returning id, owner_user_id`,
      [grant.companyId, template.revision_id, processId, employeeId, effectiveDate, grant.userId],
    )
  ).rows;
  await event(tx, grant, grant.businessDate, processId, { action: 'START', toState: 'OPEN' });
  await audit(tx, actorOf(grant), 'employee_process', processId, 'CREATE', null, {
    operational: { employeeId, processCode: input.processCode, revision: template.revision, effectiveDate, exitCaseId: input.exitCaseId ?? null, taskCount: tasks.length },
  });
  for (const t of tasks) await taskAssigned(tx, grant.companyId, t.id, t.owner_user_id, 'start');
  return processDetail(tx, grant, processId);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

const TASK_VIEW_SQL = `select t.id, t.sequence, t.code, t.title, t.owner_role_code as "ownerRoleCode", t.owner_user_id as "ownerUserId",
        oe.display_name as "ownerName", t.required, t.evidence_required as "evidenceRequired", to_char(t.due_date, 'YYYY-MM-DD') as "dueDate", t.state,
        (t.state = 'OPEN' and p.state = 'OPEN' and t.due_date < $2::date) as overdue,
        t.done_at as "doneAt", to_char(t.done_on, 'YYYY-MM-DD') as "doneOn", t.done_by as "doneBy", (t.evidence_attachment_id is not null) as "hasEvidence",
        ev.scan_state as "evidenceScanState", t.version
   from employee_process_task t
   join employee_process p on p.company_id = t.company_id and p.id = t.employee_process_id
   left join attachment ev on ev.company_id = t.company_id and ev.id = t.evidence_attachment_id
   left join user_employee_link ol on ol.company_id = t.company_id and ol.user_id = t.owner_user_id
        and ol.effective_from <= $2::date and (ol.effective_to is null or ol.effective_to > $2::date)
   left join employee oe on oe.company_id = ol.company_id and oe.id = ol.employee_id`;

export async function processDetail(db: Queryable, grant: AccessGrant, processId: string) {
  const p = (
    await db.query<{
      id: string;
      employee_id: string;
      employee_code: string;
      employee_name: string;
      process_id: string;
      process_code: string;
      process_name: string;
      process_type: string;
      revision: number;
      state: string;
      effective_date: string;
      owner_user_id: string;
      exit_case_id: string | null;
      closed_at: Date | null;
      cancelled_at: Date | null;
      reopen_count: number;
      created_at: Date;
      version: number;
    }>(
      `select ep.id, ep.employee_id, e.employee_code, e.display_name as employee_name, lp.id as process_id, lp.code as process_code, lp.name as process_name,
              pt.code as process_type, r.revision, ep.state, to_char(ep.effective_date, 'YYYY-MM-DD') as effective_date, ep.owner_user_id, ep.exit_case_id,
              ep.closed_at, ep.cancelled_at, ep.reopen_count, ep.created_at, ep.version
         from employee_process ep
         join employee e on e.company_id = ep.company_id and e.id = ep.employee_id
         join lifecycle_process lp on lp.company_id = ep.company_id and lp.id = ep.process_id
         join reference_value pt on pt.company_id = lp.company_id and pt.id = lp.process_type_id
         join lifecycle_process_revision r on r.company_id = ep.company_id and r.id = ep.process_revision_id
        where ep.company_id = $1 and ep.id = $2`,
      [grant.companyId, processId],
    )
  ).rows[0];
  if (!p || !(await canAccessEmployee(db, grant, p.employee_id))) throw notFound();
  const tasks = (await db.query(`${TASK_VIEW_SQL} where t.company_id = $1 and t.employee_process_id = $3 order by t.sequence`, [grant.companyId, grant.businessDate, processId])).rows;
  // Restricted remarks are never shown about one's own record, whatever the grant (FR-018; H1: no reviewer notes).
  const showNotes = holds(grant, 'note') && !isSelf(grant, p.employee_id);
  const history = (
    await db.query<{
      action: string;
      task_code: string | null;
      from_state: string | null;
      to_state: string | null;
      prior_owner_role_code: string | null;
      prior_owner_user_id: string | null;
      new_owner_role_code: string | null;
      new_owner_user_id: string | null;
      has_evidence: boolean;
      note: string | null;
      actor_user_id: string;
      business_date: string;
      occurred_at: Date;
    }>(
      `select ev.action, t.code as task_code, ev.from_state, ev.to_state, ev.prior_owner_role_code, ev.prior_owner_user_id, ev.new_owner_role_code, ev.new_owner_user_id,
              (ev.evidence_attachment_id is not null) as has_evidence, ev.note, ev.actor_user_id, to_char(ev.business_date, 'YYYY-MM-DD') as business_date, ev.occurred_at
         from employee_process_event ev left join employee_process_task t on t.company_id = ev.company_id and t.id = ev.task_id
        where ev.company_id = $1 and ev.employee_process_id = $2 order by ev.occurred_at, ev.id`,
      [grant.companyId, processId],
    )
  ).rows.map((h) => ({
    action: h.action,
    taskCode: h.task_code,
    fromState: h.from_state,
    toState: h.to_state,
    priorOwner: h.prior_owner_role_code || h.prior_owner_user_id ? { roleCode: h.prior_owner_role_code, userId: h.prior_owner_user_id } : null,
    newOwner: h.new_owner_role_code || h.new_owner_user_id ? { roleCode: h.new_owner_role_code, userId: h.new_owner_user_id } : null,
    hasEvidence: h.has_evidence,
    // FR-018: remarks and reasons are restricted to authorised HR roles.
    ...(showNotes ? { note: h.note } : { noteRecorded: h.note !== null }),
    actorUserId: h.actor_user_id,
    businessDate: h.business_date,
    occurredAt: h.occurred_at,
  }));
  const open = tasks.filter((t) => t.state === 'OPEN');
  return {
    id: p.id,
    employeeId: p.employee_id,
    employeeCode: p.employee_code,
    employeeName: p.employee_name,
    processId: p.process_id,
    processCode: p.process_code,
    processName: p.process_name,
    processType: p.process_type,
    revision: p.revision,
    state: p.state,
    effectiveDate: p.effective_date,
    ownerUserId: p.owner_user_id,
    exitCaseId: p.exit_case_id,
    closedAt: p.closed_at,
    cancelledAt: p.cancelled_at,
    reopenCount: p.reopen_count,
    createdAt: p.created_at,
    version: p.version,
    counts: {
      total: tasks.length,
      open: open.length,
      requiredOpen: open.filter((t) => t.required).length,
      overdue: tasks.filter((t) => t.overdue).length,
    },
    tasks,
    history,
  };
}

/** Lists that answered at most this many rows before they could page keep that first answer without page/pageSize. */
export const PROCESS_LIST_CAP = 200;
export const MY_TASKS_CAP = 500;

/** An employee's processes, newest first: one page (FR-056), or the first 200 without page/pageSize; `total` counts all. */
export async function listEmployeeProcesses(db: Queryable, grant: AccessGrant, employeeId: string, paging: Paging = {}) {
  await assertInScope(db, grant, employeeId);
  return pageOf(
    db,
    `select ep.id, lp.code as "processCode", lp.name as "processName", pt.code as "processType", r.revision, ep.state,
            to_char(ep.effective_date, 'YYYY-MM-DD') as "effectiveDate", ep.exit_case_id as "exitCaseId", ep.version,
            count(t.id)::int as "taskCount",
            count(t.id) filter (where t.state = 'OPEN')::int as "openTasks",
            count(t.id) filter (where t.state = 'OPEN' and t.required)::int as "requiredOpen",
            count(t.id) filter (where t.state = 'OPEN' and ep.state = 'OPEN' and t.due_date < $3::date)::int as "overdueTasks",
            ep.created_at as hrms_created
       from employee_process ep
       join lifecycle_process lp on lp.company_id = ep.company_id and lp.id = ep.process_id
       join reference_value pt on pt.company_id = lp.company_id and pt.id = lp.process_type_id
       join lifecycle_process_revision r on r.company_id = ep.company_id and r.id = ep.process_revision_id
       left join employee_process_task t on t.company_id = ep.company_id and t.employee_process_id = ep.id
      where ep.company_id = $1 and ep.employee_id = $2
      group by ep.id, lp.code, lp.name, pt.code, r.revision`,
    [grant.companyId, employeeId, grant.businessDate],
    'hrms_created desc, id',
    paging,
    PROCESS_LIST_CAP,
  );
}

/**
 * FR-016 tracking across employees: processes within the caller's row scope (operational fields and counts only),
 * filtered by state, process type, employee code and whether a task is overdue, newest first. One page (FR-056), or
 * the first 200 without page/pageSize; `total` counts every match and `truncated` says more rows follow this answer.
 */
export async function listProcesses(
  db: Queryable,
  grant: AccessGrant,
  filter: { state?: string | undefined; processType?: string | undefined; employeeCode?: string | undefined; overdue?: boolean | undefined } & Paging,
) {
  const params = new SqlParams([grant.companyId, grant.businessDate]);
  const where = [employeeScopePredicate(grant, { company: 'ep.company_id', employee: 'ep.employee_id' }, params)];
  if (filter.state) where.push(`ep.state = ${params.add(filter.state)}`);
  if (filter.processType) where.push(`pt.code = ${params.add(filter.processType)}`);
  if (filter.employeeCode) where.push(`e.employee_code like ${params.add(`%${filter.employeeCode.trim().toUpperCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`)}`);
  if (filter.overdue) {
    where.push(`ep.state = 'OPEN' and exists (select 1 from employee_process_task o where o.company_id = ep.company_id and o.employee_process_id = ep.id
                  and o.state = 'OPEN' and o.due_date < $2::date)`);
  }
  const page = await pageOf(
    db,
    `select ep.id, ep.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName", lp.code as "processCode",
            lp.name as "processName", pt.code as "processType", r.revision, ep.state, to_char(ep.effective_date, 'YYYY-MM-DD') as "effectiveDate",
            ep.exit_case_id as "exitCaseId", ep.version,
            count(t.id)::int as "taskCount",
            count(t.id) filter (where t.state = 'OPEN')::int as "openTasks",
            count(t.id) filter (where t.state = 'OPEN' and t.required)::int as "requiredOpen",
            count(t.id) filter (where t.state = 'OPEN' and ep.state = 'OPEN' and t.due_date < $2::date)::int as "overdueTasks",
            ep.created_at as hrms_created
       from employee_process ep
       join employee e on e.company_id = ep.company_id and e.id = ep.employee_id
       join lifecycle_process lp on lp.company_id = ep.company_id and lp.id = ep.process_id
       join reference_value pt on pt.company_id = lp.company_id and pt.id = lp.process_type_id
       join lifecycle_process_revision r on r.company_id = ep.company_id and r.id = ep.process_revision_id
       left join employee_process_task t on t.company_id = ep.company_id and t.employee_process_id = ep.id
      where ep.company_id = $1 and ${where.join(' and ')}
      group by ep.id, e.employee_code, e.display_name, lp.code, lp.name, pt.code, r.revision`,
    params.values,
    'hrms_created desc, id',
    filter,
    PROCESS_LIST_CAP,
  );
  const shownThrough = ((page.page ?? 1) - 1) * (page.pageSize ?? PROCESS_LIST_CAP) + page.items.length;
  return { ...page, truncated: page.total > shownThrough };
}

/**
 * Tasks the caller's selected assignment can act on: owned by the caller's user or role, for an employee in the
 * assignment's row scope, open in an open process. On the caller's own record only the employee's own tasks.
 * Earliest due first: one page (FR-056), or the first 500 without page/pageSize; `total` and `overdue` count every
 * matching task, not only the rows answered.
 */
export async function myTasks(db: Queryable, grant: AccessGrant, paging: Paging = {}) {
  const params = new SqlParams([grant.companyId, grant.businessDate, grant.userId, grant.roleCode]);
  const scope = employeeScopePredicate(grant, { company: 't.company_id', employee: 't.employee_id' }, params);
  const self = grant.linkedEmployeeId ? `(t.employee_id <> ${params.add(grant.linkedEmployeeId)}::uuid or (t.owner_role_code = 'EMPLOYEE' and $4 = 'EMPLOYEE'))` : 'true';
  const sql = `${TASK_VIEW_SQL.replace('select t.id,', `select t.id, t.employee_process_id as "processId", lp.code as "processCode", lp.name as "processName",
              t.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",`)}
        join lifecycle_process lp on lp.company_id = p.company_id and lp.id = p.process_id
        join employee e on e.company_id = t.company_id and e.id = t.employee_id
       where t.company_id = $1 and t.state = 'OPEN' and p.state = 'OPEN'
         and (t.owner_user_id = $3 or t.owner_role_code = $4) and ${scope} and ${self}`;
  const page = await pageOf(db, sql, params.values, '"dueDate", sequence, id', paging, MY_TASKS_CAP);
  const overdue = (await db.query<{ n: number }>(`select count(*)::int as n from (${sql}) x where x.overdue`, params.values)).rows[0]!.n;
  return { ...page, overdue };
}

// ---------------------------------------------------------------------------------------------------------------
// Task actions
// ---------------------------------------------------------------------------------------------------------------

/** The task behind its process transaction lock (taken first), with the process row; outside scope reads as missing. */
async function lockTask(tx: Queryable, grant: AccessGrant, taskId: string): Promise<TaskRow> {
  const target = (
    await tx.query<{ transaction_id: string; employee_id: string }>(
      `select p.transaction_id, t.employee_id from employee_process_task t join employee_process p on p.company_id = t.company_id and p.id = t.employee_process_id
        where t.company_id = $1 and t.id = $2`,
      [grant.companyId, taskId],
    )
  ).rows[0];
  if (!target || !(await canAccessEmployee(tx, grant, target.employee_id))) throw notFound();
  await lockTransaction(tx, target.transaction_id);
  return (
    await tx.query<TaskRow>(
      `select t.id, t.employee_process_id, t.employee_id, p.transaction_id, p.state as process_state, p.exit_case_id, t.code, t.title, t.owner_role_code, t.owner_user_id,
              t.required, t.evidence_required, to_char(t.due_date, 'YYYY-MM-DD') as due_date, t.state, t.evidence_attachment_id, t.version
         from employee_process_task t join employee_process p on p.company_id = t.company_id and p.id = t.employee_process_id
        where t.company_id = $1 and t.id = $2 for update of t`,
      [grant.companyId, taskId],
    )
  ).rows[0]!;
}

/** C4: on one's own record only the employee's own tasks; otherwise the task's user or role owner. */
function ownsTask(grant: AccessGrant, t: Pick<TaskRow, 'employee_id' | 'owner_role_code' | 'owner_user_id'>): boolean {
  if (isSelf(grant, t.employee_id)) return t.owner_role_code === 'EMPLOYEE' && grant.roleCode === 'EMPLOYEE';
  return t.owner_user_id === grant.userId || (t.owner_role_code !== null && t.owner_role_code === grant.roleCode);
}

function checkOpen(t: TaskRow, expectedVersion: number): void {
  if (t.process_state !== 'OPEN') throw new HttpError(409, 'PROCESS_NOT_OPEN', 'The process is not open');
  if (t.state !== 'OPEN') throw new HttpError(409, 'TASK_NOT_OPEN', 'The task is not open');
  if (t.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The task changed; reload and retry');
}

/** A task as its owner and HR see it (operational fields; the caller has already passed the task's scope checks). */
export async function taskView(db: Queryable, grant: AccessGrant, taskId: string) {
  return (await db.query(`${TASK_VIEW_SQL} where t.company_id = $1 and t.id = $3`, [grant.companyId, grant.businessDate, taskId])).rows[0];
}

/**
 * Completes a task the caller owns. An evidence file is stored PENDING_SCAN and returned so that the route scans it
 * right after the commit (FR-106: released only by the malware scanner; the worker retries a scanner outage).
 */
export async function completeTask(
  tx: Queryable,
  grant: AccessGrant,
  files: FileStore,
  taskId: string,
  input: { expectedVersion: number; remark?: string | undefined; evidence?: EvidenceInput | undefined },
): Promise<{ evidence: StoredEvidence | null }> {
  const t = await lockTask(tx, grant, taskId);
  // A completion counts towards closing the process and the exit's final release: its duty is checked again after
  // the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'employee_process', 'complete_task', ['operational']);
  if (!ownsTask(grant, t)) throw new HttpError(403, 'NOT_TASK_OWNER', 'This task is owned by someone else');
  checkOpen(t, input.expectedVersion);
  if (t.evidence_required && !input.evidence) throw new HttpError(422, 'EVIDENCE_REQUIRED', 'Attach the evidence this task requires');
  let attachmentId: string | null = null;
  let evidence: StoredEvidence | null = null;
  if (input.evidence) {
    const { bytes, mediaType } = decodeUpload(input.evidence.contentBase64);
    const stored = await files.put(grant.companyId, bytes);
    // FR-106: a user upload is quarantined until the malware scanner releases it.
    attachmentId = (
      await tx.query<{ id: string }>(
        `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size,
                                 scan_state, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, 'CONFIDENTIAL', $7, $8, 'PENDING_SCAN', $2, $2) returning id`,
        [grant.companyId, grant.userId, t.employee_id, stored.reference, mediaType, stored.checksum, input.evidence.fileName.trim(), stored.byteSize],
      )
    ).rows[0]!.id;
    evidence = { attachmentId, bytes };
  }
  await tx.query(
    `update employee_process_task set state = 'COMPLETED', done_at = now(), done_on = $3, done_by = $4, done_assignment_id = $5, evidence_attachment_id = $6, updated_by = $4
      where company_id = $1 and id = $2`,
    [grant.companyId, t.id, grant.businessDate, grant.userId, grant.assignmentId, attachmentId],
  );
  await event(tx, grant, grant.businessDate, t.employee_process_id, {
    action: 'COMPLETE',
    taskId: t.id,
    fromState: 'OPEN',
    toState: 'COMPLETED',
    evidenceAttachmentId: attachmentId,
    note: input.remark ?? null,
  });
  await audit(tx, actorOf(grant), 'employee_process_task', t.id, 'COMPLETE', { operational: { state: 'OPEN' } }, {
    operational: { state: 'COMPLETED', taskCode: t.code, doneOn: grant.businessDate, evidence: attachmentId !== null, remarkRecorded: Boolean(input.remark?.trim()) },
  });
  return { evidence };
}

/** Records the scan verdict of a task's evidence on the task's audit trail (the verdict only, never the content). */
export async function recordEvidenceScan(db: Queryable, grant: AccessGrant, taskId: string, scanState: 'CLEAN' | 'QUARANTINED'): Promise<void> {
  await audit(db, actorOf(grant), 'employee_process_task', taskId, scanState === 'CLEAN' ? 'SCAN_RELEASED' : 'SCAN_QUARANTINED', null, { operational: { evidenceScanState: scanState } });
}

export async function skipTask(tx: Queryable, grant: AccessGrant, taskId: string, input: { expectedVersion: number; reason: string }) {
  const t = await lockTask(tx, grant, taskId);
  await reassertAccess(tx, grant, 'employee_process', 'complete_task', ['operational']);
  if (!ownsTask(grant, t)) throw new HttpError(403, 'NOT_TASK_OWNER', 'This task is owned by someone else');
  checkOpen(t, input.expectedVersion);
  if (t.required) throw new HttpError(422, 'REQUIRED_TASK', 'A required task cannot be skipped');
  await tx.query(
    `update employee_process_task set state = 'SKIPPED', done_at = now(), done_on = $3, done_by = $4, done_assignment_id = $5, updated_by = $4 where company_id = $1 and id = $2`,
    [grant.companyId, t.id, grant.businessDate, grant.userId, grant.assignmentId],
  );
  await event(tx, grant, grant.businessDate, t.employee_process_id, { action: 'SKIP', taskId: t.id, fromState: 'OPEN', toState: 'SKIPPED', note: input.reason });
  await audit(tx, actorOf(grant), 'employee_process_task', t.id, 'SKIP', { operational: { state: 'OPEN' } }, { operational: { state: 'SKIPPED', taskCode: t.code } }, input.reason);
  return taskView(tx, grant, t.id);
}

/** FR-016: reopening a completed or skipped task needs a reason and the reopen duty; the earlier completion stays in the history. */
export async function reopenTask(tx: Queryable, grant: AccessGrant, taskId: string, input: { expectedVersion: number; reason: string }) {
  const t = await lockTask(tx, grant, taskId);
  assertNotSelf(grant, t.employee_id);
  // The reopening decision re-checks its duty after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'employee_process', 'reopen', ['operational']);
  if (t.process_state !== 'OPEN') throw new HttpError(409, 'PROCESS_NOT_OPEN', 'Reopen the process before its tasks');
  if (t.state === 'OPEN') throw new HttpError(409, 'TASK_NOT_DONE', 'The task is already open');
  if (t.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The task changed; reload and retry');
  // A finally released exit's clearance is final (F1): its completed tasks stay completed.
  if (await exitReleased(tx, grant.companyId, t.exit_case_id)) throw new HttpError(409, 'EXIT_RELEASED', 'The exit was finally released; its checklist is final');
  await tx.query(
    `update employee_process_task set state = 'OPEN', done_at = null, done_on = null, done_by = null, done_assignment_id = null, evidence_attachment_id = null, updated_by = $3
      where company_id = $1 and id = $2`,
    [grant.companyId, t.id, grant.userId],
  );
  await event(tx, grant, grant.businessDate, t.employee_process_id, { action: 'REOPEN_TASK', taskId: t.id, fromState: t.state, toState: 'OPEN', note: input.reason });
  await audit(tx, actorOf(grant), 'employee_process_task', t.id, 'REOPEN', { operational: { state: t.state } }, { operational: { state: 'OPEN', taskCode: t.code } }, input.reason);
  return taskView(tx, grant, t.id);
}

/** FR-016: reassignment keeps the prior owner in the history. */
export async function reassignTask(
  tx: Queryable,
  grant: AccessGrant,
  taskId: string,
  input: { expectedVersion: number; ownerRoleCode?: string | undefined; ownerUserId?: string | undefined; reason?: string | undefined },
) {
  const t = await lockTask(tx, grant, taskId);
  assertNotSelf(grant, t.employee_id);
  checkOpen(t, input.expectedVersion);
  await validateOwner(tx, grant.companyId, input);
  if (input.ownerUserId && (await userIsEmployee(tx, grant.companyId, input.ownerUserId, t.employee_id))) {
    throw new HttpError(422, 'INVALID_OWNER', 'The employee’s own tasks are owned by the Employee role, not by their user');
  }
  // I-25: a named owner must be able to open the task (the completion duty with row scope over this employee).
  if (input.ownerUserId && !(await isEligibleReviewer(tx, grant.companyId, input.ownerUserId, await permissionId(tx, 'employee_process', 'complete_task', 'operational'), t.employee_id))) {
    throw new HttpError(422, 'INVALID_OWNER', 'That user cannot act on this employee');
  }
  const role = input.ownerRoleCode ?? null;
  const user = input.ownerUserId ?? null;
  if (role === t.owner_role_code && user === t.owner_user_id) throw new HttpError(422, 'SAME_OWNER', 'The task already has this owner');
  await tx.query(`update employee_process_task set owner_role_code = $3, owner_user_id = $4, updated_by = $5 where company_id = $1 and id = $2`, [
    grant.companyId,
    t.id,
    role,
    user,
    grant.userId,
  ]);
  await event(tx, grant, grant.businessDate, t.employee_process_id, {
    action: 'REASSIGN',
    taskId: t.id,
    priorOwner: { role: t.owner_role_code, user: t.owner_user_id },
    newOwner: { role, user },
    note: input.reason ?? null,
  });
  await audit(
    tx,
    actorOf(grant),
    'employee_process_task',
    t.id,
    'REASSIGN',
    { operational: { ownerRoleCode: t.owner_role_code, ownerUserId: t.owner_user_id } },
    { operational: { ownerRoleCode: role, ownerUserId: user, taskCode: t.code } },
    input.reason ?? null,
  );
  await taskAssigned(tx, grant.companyId, t.id, user, `reassign:${t.version + 1}`);
  return taskView(tx, grant, t.id);
}

// ---------------------------------------------------------------------------------------------------------------
// Process actions: close, reopen, cancel
// ---------------------------------------------------------------------------------------------------------------

async function lockProcess(tx: Queryable, grant: AccessGrant, processId: string): Promise<ProcessRow> {
  const target = (await tx.query<{ transaction_id: string; employee_id: string }>(`select transaction_id, employee_id from employee_process where company_id = $1 and id = $2`, [grant.companyId, processId])).rows[0];
  if (!target || !(await canAccessEmployee(tx, grant, target.employee_id))) throw notFound();
  await lockTransaction(tx, target.transaction_id);
  return (
    await tx.query<ProcessRow>(`select id, employee_id, transaction_id, state, exit_case_id, version from employee_process where company_id = $1 and id = $2 for update`, [
      grant.companyId,
      processId,
    ])
  ).rows[0]!;
}

async function exitReleased(tx: Queryable, companyId: string, exitCaseId: string | null): Promise<boolean> {
  if (!exitCaseId) return false;
  const r = await tx.query(`select 1 from exit_case where company_id = $1 and id = $2 and released_at is not null`, [companyId, exitCaseId]);
  return (r.rowCount ?? 0) > 0;
}

/** FR-015: a process cannot close while a required task remains open. */
export async function closeProcess(tx: Queryable, grant: AccessGrant, processId: string, input: { expectedVersion: number }) {
  const p = await lockProcess(tx, grant, processId);
  assertNotSelf(grant, p.employee_id);
  // The closing decision re-checks its duty after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'employee_process', 'manage', ['operational']);
  if (p.state !== 'OPEN') throw new HttpError(409, 'PROCESS_NOT_OPEN', 'Only an open process can be closed');
  if (p.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The process changed; reload and retry');
  const incomplete = (
    await tx.query<{ code: string }>(
      `select t.code from employee_process_task t where t.company_id = $1 and t.employee_process_id = $2 and t.required and (${INCOMPLETE_REQUIRED}) order by t.sequence`,
      [grant.companyId, p.id],
    )
  ).rows.map((r) => r.code);
  if (incomplete.length > 0) throw new HttpError(409, 'REQUIRED_TASKS_INCOMPLETE', 'Every required task must be completed first', { tasks: incomplete });
  await setRootState(tx, 'employee_process', grant.companyId, p, 'CLOSED', grant.userId, ', closed_at = now(), closed_by = $4');
  await event(tx, grant, grant.businessDate, p.id, { action: 'CLOSE', fromState: 'OPEN', toState: 'CLOSED' });
  await audit(tx, actorOf(grant), 'employee_process', p.id, 'CLOSE', { operational: { state: 'OPEN' } }, { operational: { state: 'CLOSED' } });
  return processDetail(tx, grant, p.id);
}

/** FR-016: reopening needs a reason and the reopen duty; a released exit's checklist stays closed. */
export async function reopenProcess(tx: Queryable, grant: AccessGrant, processId: string, input: { expectedVersion: number; reason: string }) {
  const p = await lockProcess(tx, grant, processId);
  assertNotSelf(grant, p.employee_id);
  await reassertAccess(tx, grant, 'employee_process', 'reopen', ['operational']);
  if (p.state !== 'CLOSED') throw new HttpError(409, 'PROCESS_NOT_CLOSED', 'Only a closed process can be reopened');
  if (p.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The process changed; reload and retry');
  if (await exitReleased(tx, grant.companyId, p.exit_case_id)) throw new HttpError(409, 'EXIT_RELEASED', 'The exit was finally released; its checklist is final');
  await setRootState(tx, 'employee_process', grant.companyId, p, 'OPEN', grant.userId, ', closed_at = null, closed_by = null, reopen_count = reopen_count + 1');
  await event(tx, grant, grant.businessDate, p.id, { action: 'REOPEN', fromState: 'CLOSED', toState: 'OPEN', note: input.reason });
  await audit(tx, actorOf(grant), 'employee_process', p.id, 'REOPEN', { operational: { state: 'CLOSED' } }, { operational: { state: 'OPEN' } }, input.reason);
  return processDetail(tx, grant, p.id);
}

export async function cancelProcess(tx: Queryable, grant: AccessGrant, processId: string, input: { expectedVersion: number; reason: string }) {
  const p = await lockProcess(tx, grant, processId);
  assertNotSelf(grant, p.employee_id);
  await reassertAccess(tx, grant, 'employee_process', 'manage', ['operational']);
  if (p.state !== 'OPEN') throw new HttpError(409, 'PROCESS_NOT_OPEN', 'Only an open process can be cancelled');
  if (p.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The process changed; reload and retry');
  if (await exitReleased(tx, grant.companyId, p.exit_case_id)) throw new HttpError(409, 'EXIT_RELEASED', 'The exit was finally released; its checklist is final');
  await cancelOpenProcess(tx, actorOf(grant), grant.businessDate, p, input.reason);
  return processDetail(tx, grant, p.id);
}

/** Cancels an open process (an explicit HR action, or the effect of an approved exit withdrawal). Caller holds the lock. */
export async function cancelOpenProcess(
  tx: Queryable,
  actor: { companyId: string; userId: string; assignmentId: string | null },
  businessDate: string,
  p: { id: string; transaction_id: string },
  reason: string,
): Promise<void> {
  await setRootState(tx, 'employee_process', actor.companyId, p, 'CANCELLED', actor.userId, ', cancelled_at = now()');
  await event(tx, actor, businessDate, p.id, { action: 'CANCEL', fromState: 'OPEN', toState: 'CANCELLED', note: reason });
  await audit(tx, actor, 'employee_process', p.id, 'CANCEL', { operational: { state: 'OPEN' } }, { operational: { state: 'CANCELLED' } }, reason);
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence and clearance
// ---------------------------------------------------------------------------------------------------------------

/** The evidence of a task's current completion (confidential evidence group, row scope; released files only). */
export async function taskEvidence(db: Queryable, grant: AccessGrant, taskId: string) {
  const row = (
    await db.query<{ employee_id: string; content_reference: string | null; media_type: string | null; file_name: string | null; scan_state: string | null }>(
      `select t.employee_id, a.content_reference, a.media_type, a.file_name, a.scan_state from employee_process_task t
         left join attachment a on a.company_id = t.company_id and a.id = t.evidence_attachment_id
        where t.company_id = $1 and t.id = $2`,
      [grant.companyId, taskId],
    )
  ).rows[0];
  if (!row || !(await canAccessEmployee(db, grant, row.employee_id))) throw notFound();
  assertNotSelf(grant, row.employee_id);
  if (!row.content_reference || !row.media_type) throw notFound();
  // FR-106: only content the malware scanner released is ever served.
  if (row.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'This file has not been released by the malware scan', { scanState: row.scan_state });
  return { employeeId: row.employee_id, reference: row.content_reference, mediaType: row.media_type, fileName: row.file_name };
}

/**
 * A required task is incomplete while it is not completed, or while its required evidence is not a released file
 * (FR-106: only the malware scanner releases an upload; a file still waiting for its scan is not evidence yet, and a
 * quarantined file never is, so that task is reopened and completed again). Columns of `t` (the task).
 */
const INCOMPLETE_REQUIRED = `t.state <> 'COMPLETED' or (t.evidence_required and not exists (select 1 from attachment qa where qa.company_id = t.company_id
  and qa.id = t.evidence_attachment_id and qa.scan_state = 'CLEAN'))`;

/**
 * Takes the transaction locks of an exit's live clearance checklist (at most one), so that a gate reading the
 * clearance (final release, settlement release eligibility) is serialised with task completions and reopenings.
 */
export async function lockClearance(tx: Queryable, companyId: string, exitCaseId: string): Promise<void> {
  const rows = (
    await tx.query<{ transaction_id: string }>(
      `select transaction_id from employee_process where company_id = $1 and exit_case_id = $2 and state <> 'CANCELLED' order by transaction_id`,
      [companyId, exitCaseId],
    )
  ).rows;
  for (const r of rows) await lockTransaction(tx, r.transaction_id);
}

/**
 * F1 "no skipped required clearance at final release": the exit's live clearance checklist exists and none of its
 * required tasks is incomplete (required tasks cannot be skipped).
 */
export async function clearanceStatus(db: Queryable, companyId: string, exitCaseId: string) {
  const rows = (
    await db.query<{ process_id: string; state: string; incomplete: string[] }>(
      `select p.id as process_id, p.state,
              coalesce(array_agg(t.code order by t.sequence) filter (where t.required and (${INCOMPLETE_REQUIRED})), '{}') as incomplete
         from employee_process p left join employee_process_task t on t.company_id = p.company_id and t.employee_process_id = p.id
        where p.company_id = $1 and p.exit_case_id = $2 and p.state <> 'CANCELLED'
        group by p.id, p.state`,
      [companyId, exitCaseId],
    )
  ).rows;
  const incomplete = rows.flatMap((r) => r.incomplete);
  return { started: rows.length > 0, processIds: rows.map((r) => r.process_id), incompleteRequired: incomplete, complete: rows.length > 0 && incomplete.length === 0 };
}
