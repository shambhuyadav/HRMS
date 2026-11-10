// Outbox dispatcher and in-app delivery (FR-061, FR-083-FR-085; BR-032-BR-034; DF12; CI18).
//
// Each outbox row is processed in its own transaction: lock (SKIP LOCKED, so workers can run in parallel),
// record a notification_event, resolve recipients per active rule, create one notification per
// recipient/channel/rule revision (idempotency key), then deliver. Delivery re-checks recipient authority at
// delivery time (not only at queue time), renders only approved placeholders, and records an attempt.
// Application idempotency does not imply exactly-once delivery by any external provider (BR-034).
// An EMAIL rule (0247) goes through the same checks; its notice is rendered for email and left QUEUED for the worker (email-delivery.ts).
// An event is described as it was raised (the revision and dates in its payload), not from a later state.
// Everything written here is written by the dispatcher itself, whoever's request raised the event, so it names the system actor.
// Claims take one event per company in turn (db/company-turns.ts), so a burst from one company never starves another.
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { positiveIntFromEnv } from '../../db/budget.js';
import { companyTurns } from '../../db/company-turns.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { loadFilters, withinAdministrativeScope } from '../access/admin.js';
import { type AccessGrant, canAccessEmployee, resolveAccess, taskDelegationLive } from '../access/authorize.js';
import { MODULE_EVENT_DESCRIBERS } from '../events-registry.js';
import { usersCoveringEmployee } from '../workflow/engine.js';
import { DEFAULT_EMAIL_SUBJECT, emailContentRefusal, emailData, emailSubjectLine } from './email-content.js';

interface OutboxRow {
  id: string;
  company_id: string;
  topic: string;
  aggregate_id: string;
  dedupe_key: string;
  /** JSON written by the emitting module: identifiers, plus revision/dates/outcome where the event has them. */
  payload: Record<string, unknown>;
}

// Payload readers: a missing or malformed value reads as absent (never as an error that would block the outbox).
// Identifiers are compared with uuid columns, where a malformed value would raise an error on every dispatch run
// and hold back every later event; an event without a well-formed identifier is consumed without effect.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const positiveInt = (v: unknown): number | null => {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= 2_147_483_647 ? n : null;
};
const isoDate = (v: unknown): string | null => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export interface EventSpec {
  /** Transaction kind whose fallback reviewer list FALLBACK_REVIEWERS rules notify (defaults to the transaction's kind). */
  fallbackKind?: string | undefined;
  eventType: string;
  subjectEmployeeId: string | null;
  transactionId: string | null;
  transactionRevision: number | null;
  /** Task whose assignee is the reviewer for ASSIGNED_REVIEWER rules. */
  taskId: string | null;
  beneficiaryUserId: string | null;
  /** Company policy version whose current managers POLICY_MANAGERS rules notify (documents/expiry.ts). */
  policyVersionId?: string | undefined;
  /** The transaction's proposer, for PROPOSER_OR_MANAGER rules. */
  proposerUserId?: string | undefined;
  /** PROPOSER_OR_MANAGER rules also tell the subject employee's current direct manager. */
  managerAlso?: boolean | undefined;
  /** Pending role assignment whose eligible approvers GRANT_APPROVERS rules notify (access/admin.ts). */
  grantAssignmentId?: string | undefined;
  /** Open role permission change whose eligible deciders GRANT_APPROVERS rules notify (access/role-permissions.ts). */
  rolePermissionChangeId?: string | undefined;
  data: Record<string, string>;
}

const LEAVE_EVENT_TYPES: Record<string, string> = {
  'leave.submitted': 'LEAVE_SUBMITTED',
  'leave.decided': 'LEAVE_DECIDED',
  'leave.withdrawn': 'LEAVE_WITHDRAWN',
  'leave.cancellation_requested': 'LEAVE_CANCELLATION_REQUESTED',
  'leave.cancellation_decided': 'LEAVE_CANCELLATION_DECIDED',
};

const WORK_REQUEST_EVENT_TYPES: Record<string, string> = {
  'work_request.submitted': 'WORK_REQUEST_SUBMITTED',
  'work_request.decided': 'WORK_REQUEST_DECIDED',
  'work_request.withdrawn': 'WORK_REQUEST_WITHDRAWN',
};

/** Reviewer notices sent after the reviewer's task has closed: the request was withdrawn. */
const AFTER_TASK_CLOSED = new Set(['LEAVE_WITHDRAWN', 'WORK_REQUEST_WITHDRAWN', 'EXPENSE_WITHDRAWN']);

/** Builds the event from a topic using operational fields only (never reasons, amounts or private data). */
async function describe(tx: Queryable, o: OutboxRow): Promise<EventSpec | null> {
  const p = o.payload;
  switch (o.topic) {
    case 'leave.submitted':
    case 'leave.decided':
    case 'leave.withdrawn':
    case 'leave.cancellation_requested':
    case 'leave.cancellation_decided': {
      const cancellationTopic = o.topic.startsWith('leave.cancellation');
      const requestId = id(p.requestId);
      const cancellationId = id(p.cancellationId);
      if (!requestId || (cancellationTopic && !cancellationId)) return null;
      // A request's own events carry the revision they were raised for, and are described with that revision's
      // dates and units even when a resubmission came first (an unknown revision is not described at all).
      // Events without one (queued before payloads carried it) and cancellations, which only ever concern the
      // approved and therefore final revision, use the request's current state.
      const revision = cancellationTopic ? null : positiveInt(p.revision);
      const r = (
        await tx.query<{ employee_id: string; transaction_id: string; revision: number; leave_type: string; start_date: string; end_date: string; units: string; last_task: string | null }>(
          `select lr.employee_id, lr.transaction_id, coalesce($3::int, bt.revision) as revision, t.code as leave_type,
                  to_char(s.start_date, 'YYYY-MM-DD') as start_date, to_char(s.end_date, 'YYYY-MM-DD') as end_date,
                  round(s.units, 2)::text as units,
                  (select tk.id from approval_task tk join approval_instance i on i.company_id = tk.company_id and i.id = tk.instance_id
                    where i.company_id = lr.company_id and i.transaction_id = lr.transaction_id and i.transaction_revision = coalesce($3::int, bt.revision)
                    order by tk.created_at desc limit 1) as last_task
             from leave_request lr
             join business_transaction bt on bt.company_id = lr.company_id and bt.id = lr.transaction_id
             join leave_type t on t.company_id = lr.company_id and t.id = lr.leave_type_id
             cross join lateral (
               select rv.start_date, rv.end_date, rv.requested_units as units from leave_request_revision rv
                where $3::int is not null and rv.company_id = lr.company_id and rv.request_id = lr.id and rv.revision = $3::int
               union all
               select lr.start_date, lr.end_date, lr.requested_units where $3::int is null
             ) s
            where lr.company_id = $1 and lr.id = $2`,
          [o.company_id, requestId, revision],
        )
      ).rows[0];
      if (!r) return null;
      const eventType = LEAVE_EVENT_TYPES[o.topic]!;
      // A cancellation is its own transaction: its task and transaction identify the event, not the leave's.
      const cancellation = cancellationTopic
        ? (
            await tx.query<{ transaction_id: string; revision: number }>(
              `select c.transaction_id, bt.revision from leave_cancellation c join business_transaction bt on bt.company_id = c.company_id and bt.id = c.transaction_id
                where c.company_id = $1 and c.id = $2`,
              [o.company_id, cancellationId],
            )
          ).rows[0]
        : undefined;
      if (cancellationTopic && !cancellation) return null;
      return {
        eventType,
        subjectEmployeeId: r.employee_id,
        transactionId: cancellation?.transaction_id ?? r.transaction_id,
        transactionRevision: cancellation?.revision ?? r.revision,
        taskId: cancellation ? id(p.taskId) : (id(p.taskId) ?? r.last_task),
        beneficiaryUserId: null,
        // DF05: day counts are kept with 4 decimals and displayed with 2.
        data: { leaveType: r.leave_type, startDate: r.start_date, endDate: r.end_date, units: r.units, outcome: text(p.outcome) ?? '' },
      };
    }
    case 'work_request.submitted':
    case 'work_request.decided':
    case 'work_request.withdrawn': {
      const table = p.kind === 'outdoor_duty' ? 'outdoor_duty_request' : p.kind === 'holiday_work' ? 'holiday_work_request' : null;
      const requestId = id(p.requestId);
      if (!table || !requestId) return null;
      const w = (
        await tx.query<{ employee_id: string; transaction_id: string; revision: number; start_date: string; end_date: string }>(
          `select w.employee_id, w.transaction_id, bt.revision, to_char(w.start_date, 'YYYY-MM-DD') as start_date, to_char(w.end_date, 'YYYY-MM-DD') as end_date
             from ${table} w join business_transaction bt on bt.company_id = w.company_id and bt.id = w.transaction_id
            where w.company_id = $1 and w.id = $2`,
          [o.company_id, requestId],
        )
      ).rows[0];
      if (!w) return null;
      // The payload carries the revision and dates the event was raised for (a resubmission may already have
      // changed the row); events queued before payloads carried them use the current state as a whole.
      const revision = positiveInt(p.revision);
      const startDate = isoDate(p.startDate);
      const endDate = isoDate(p.endDate);
      const raised =
        revision !== null && startDate !== null && endDate !== null ? { revision, startDate, endDate } : { revision: w.revision, startDate: w.start_date, endDate: w.end_date };
      return {
        eventType: WORK_REQUEST_EVENT_TYPES[o.topic]!,
        subjectEmployeeId: w.employee_id,
        transactionId: w.transaction_id,
        transactionRevision: raised.revision,
        // For a withdrawal, the latest task (possibly closed or null): its reviewer is told (DF12).
        taskId: id(p.taskId),
        beneficiaryUserId: null,
        // Kind and dates only: the purpose never travels in a notification.
        data: {
          requestKind: p.kind === 'outdoor_duty' ? 'outdoor duty' : 'holiday work',
          startDate: raised.startDate,
          endDate: raised.endDate,
          outcome: text(p.outcome) ?? '',
        },
      };
    }
    case 'profile_change.submitted':
    case 'profile_change.decided': {
      if (!id(p.requestId)) return null;
      const pc = (
        await tx.query<{ employee_id: string; transaction_id: string; revision: number; code: string; name: string; fields: string[] }>(
          `select p.employee_id, p.transaction_id, bt.revision, e.employee_code as code, e.display_name as name,
                  array(select jsonb_object_keys(p.requested) order by 1) as fields
             from profile_change_request p
             join business_transaction bt on bt.company_id = p.company_id and bt.id = p.transaction_id
             join employee e on e.company_id = p.company_id and e.id = p.employee_id
            where p.company_id = $1 and p.id = $2`,
          [o.company_id, p.requestId],
        )
      ).rows[0];
      if (!pc) return null;
      const labels: Record<string, string> = { displayName: 'display name', workEmail: 'work email' };
      return {
        eventType: o.topic === 'profile_change.submitted' ? 'PROFILE_CHANGE_SUBMITTED' : 'PROFILE_CHANGE_DECIDED',
        subjectEmployeeId: pc.employee_id,
        transactionId: pc.transaction_id,
        transactionRevision: pc.revision,
        taskId: id(p.taskId),
        beneficiaryUserId: null,
        // Field names only; requested values never travel in notifications.
        data: { fields: pc.fields.map((f) => labels[f] ?? f).join(', '), employeeName: pc.name, employeeCode: pc.code, outcome: text(p.outcome) ?? '' },
      };
    }
    case 'attendance_correction.submitted':
    case 'attendance_correction.decided': {
      if (!id(p.requestId)) return null;
      const ac = (
        await tx.query<{ employee_id: string; transaction_id: string; revision: number; name: string; work_date: string; requested: string }>(
          `select c.employee_id, c.transaction_id, bt.revision, e.display_name as name, to_char(r.work_date, 'YYYY-MM-DD') as work_date, req.code as requested
             from attendance_correction_request c
             join business_transaction bt on bt.company_id = c.company_id and bt.id = c.transaction_id
             join employee e on e.company_id = c.company_id and e.id = c.employee_id
             join attendance_record r on r.company_id = c.company_id and r.id = c.attendance_record_id
             join reference_value req on req.company_id = c.company_id and req.id = c.requested_status_id
            where c.company_id = $1 and c.id = $2`,
          [o.company_id, p.requestId],
        )
      ).rows[0];
      if (!ac) return null;
      return {
        eventType: o.topic === 'attendance_correction.submitted' ? 'ATTENDANCE_CORRECTION_SUBMITTED' : 'ATTENDANCE_CORRECTION_DECIDED',
        subjectEmployeeId: ac.employee_id,
        transactionId: ac.transaction_id,
        transactionRevision: ac.revision,
        taskId: id(p.taskId),
        beneficiaryUserId: null,
        // The employee's reason is private and never part of a notification.
        data: { employeeName: ac.name, workDate: ac.work_date, requestedStatus: ac.requested, outcome: text(p.outcome) ?? '' },
      };
    }
    case 'confirmation.recommended':
    case 'confirmation.decided': {
      if (!id(p.caseId)) return null;
      const c = (
        await tx.query<{ employee_id: string; transaction_id: string; revision: number; code: string; name: string; due: string }>(
          `select c.employee_id, c.transaction_id, bt.revision, e.employee_code as code, e.display_name as name,
                  to_char(c.current_due_date, 'YYYY-MM-DD') as due
             from employee_confirmation c
             join business_transaction bt on bt.company_id = c.company_id and bt.id = c.transaction_id
             join employee e on e.company_id = c.company_id and e.id = c.employee_id
            where c.company_id = $1 and c.id = $2`,
          [o.company_id, p.caseId],
        )
      ).rows[0];
      if (!c) return null;
      return {
        eventType: o.topic === 'confirmation.recommended' ? 'CONFIRMATION_REVIEW_ASSIGNED' : 'CONFIRMATION_DECIDED',
        subjectEmployeeId: c.employee_id,
        transactionId: c.transaction_id,
        transactionRevision: c.revision,
        taskId: id(p.taskId),
        beneficiaryUserId: null,
        data: { employeeCode: c.code, employeeName: c.name, dueDate: c.due, outcome: text(p.outcome) ?? '' },
      };
    }
    case 'access.delegation_changed': {
      // DF12 "role-grant/security change": each party of a delegation is told its outcome; request kinds only, no record.
      const userId = id(p.userId);
      const outcome = text(p.outcome);
      if (!userId || !outcome || !id(p.delegationId)) return null;
      const d = (
        await tx.query<{ kinds: string[] | null }>(
          `select (select array_agg(distinct w.kind order by w.kind) from workflow_step s join workflow_definition w on w.company_id = s.company_id and w.id = s.workflow_id
                    where s.company_id = dl.company_id and s.permission_id = dl.permission_id and w.active) as kinds
             from delegation dl where dl.company_id = $1 and dl.id = $2`,
          [o.company_id, p.delegationId],
        )
      ).rows[0];
      if (!d) return null;
      const requestKinds = (d.kinds ?? []).map((k) => k.replace(/_/g, ' ')).join(', ') || 'approval';
      return { eventType: 'DELEGATION_CHANGED', subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: userId, data: { requestKinds, outcome } };
    }
    case 'access.grant_approved': {
      if (!id(p.assignmentId)) return null;
      const g = (
        await tx.query<{ user_id: string; role_code: string }>(
          `select ra.user_id, r.code as role_code from role_assignment ra join role r on r.company_id = ra.company_id and r.id = ra.role_id
            where ra.company_id = $1 and ra.id = $2`,
          [o.company_id, p.assignmentId],
        )
      ).rows[0];
      if (!g) return null;
      return { eventType: 'ACCESS_GRANT_APPROVED', subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: g.user_id, data: { roleCode: g.role_code } };
    }
    case 'access.grant_proposed':
    case 'access.grant_ended': {
      // DF12 "role-grant/security change": the role's code and the outcome only, never the purpose or the reason.
      const assignmentId = id(p.assignmentId);
      const outcome = p.outcome === 'REJECTED' ? 'rejected' : p.outcome === 'REVOKED' ? 'revoked' : null;
      if (!assignmentId || (o.topic === 'access.grant_ended' && !outcome)) return null;
      const g = (
        await tx.query<{ user_id: string; role_code: string }>(
          `select ra.user_id, r.code as role_code from role_assignment ra join role r on r.company_id = ra.company_id and r.id = ra.role_id
            where ra.company_id = $1 and ra.id = $2`,
          [o.company_id, assignmentId],
        )
      ).rows[0];
      if (!g) return null;
      const none = { subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null };
      return outcome
        ? { eventType: 'ACCESS_GRANT_ENDED', ...none, beneficiaryUserId: g.user_id, data: { roleCode: g.role_code, outcome } }
        : { eventType: 'ACCESS_GRANT_PROPOSED', ...none, beneficiaryUserId: null, grantAssignmentId: assignmentId, data: { roleCode: g.role_code } };
    }
    case 'access.role_permission_proposed':
    case 'access.role_permission_decided': {
      // DF12 "role-grant/security change": the role's code and the outcome only, never the permission or the reason.
      const changeId = id(p.changeId);
      if (!changeId) return null;
      const c = (
        await tx.query<{ requested_by: string; role_code: string; state: string }>(
          `select c.requested_by, r.code as role_code, c.state from role_permission_change c join role r on r.company_id = c.company_id and r.id = c.role_id
            where c.company_id = $1 and c.id = $2`,
          [o.company_id, changeId],
        )
      ).rows[0];
      if (!c) return null;
      const none = { subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null };
      return o.topic === 'access.role_permission_decided'
        ? { eventType: 'ROLE_PERMISSION_CHANGE_DECIDED', ...none, beneficiaryUserId: c.requested_by, data: { roleCode: c.role_code, outcome: c.state === 'APPROVED' ? 'approved' : 'rejected' } }
        : { eventType: 'ROLE_PERMISSION_CHANGE_PROPOSED', ...none, beneficiaryUserId: null, rolePermissionChangeId: changeId, data: { roleCode: c.role_code } };
    }
    case 'storage.scan_quarantined': {
      // H7 "scan" notice to the uploader: when it was uploaded, never its name, type or the scanner's finding.
      if (!id(p.attachmentId)) return null;
      const a = (
        await tx.query<{ owner_user_id: string; uploaded: string }>(
          `select owner_user_id, to_char(hrms_business_date(company_id, created_at), 'YYYY-MM-DD') as uploaded from attachment where company_id = $1 and id = $2`,
          [o.company_id, p.attachmentId],
        )
      ).rows[0];
      if (!a) return null;
      return { eventType: 'FILE_QUARANTINED', subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: a.owner_user_id, data: { uploadedDate: a.uploaded } };
    }
    case 'storage.scan_failed': {
      // I-84 item 8, H7 "scan": the scanner could not check the file. The upload date only; nothing once the file is requeued or has a verdict.
      if (!id(p.attachmentId)) return null;
      const a = (
        await tx.query<{ owner_user_id: string; uploaded: string }>(
          `select owner_user_id, to_char(hrms_business_date(company_id, created_at), 'YYYY-MM-DD') as uploaded from attachment
            where company_id = $1 and id = $2 and scan_state = 'PENDING_SCAN' and scan_failed_at is not null`,
          [o.company_id, p.attachmentId],
        )
      ).rows[0];
      if (!a) return null;
      return { eventType: 'FILE_SCAN_FAILED', subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: a.owner_user_id, data: { uploadedDate: a.uploaded } };
    }
    default: {
      // Registered business modules describe their own topics (modules/events-registry.ts).
      const describer = MODULE_EVENT_DESCRIBERS[o.topic];
      return describer ? describer(tx, { companyId: o.company_id, topic: o.topic, aggregateId: o.aggregate_id, payload: o.payload }) : null; // otherwise consumed without effect
    }
  }
}

/**
 * Users who can currently read an employee's documents (DF02): an active, approved assignment whose role ceiling
 * ALLOWs and whose DB109 allowlist holds document.read.document, and whose row scope covers the employee. The
 * candidates are narrowed in SQL; each is then decided by the same C1 check as the document routes
 * (resolveAccess + canAccessEmployee), one assignment at a time, so grants are never combined across assignments.
 */
async function documentReaders(tx: Queryable, companyId: string, employeeId: string, onlyUserId: string | null = null): Promise<string[]> {
  const candidates = (
    await tx.query<{ assignment_id: string; user_id: string }>(
      `select ra.id as assignment_id, ra.user_id
         from role_assignment ra
         join permission p on p.resource = 'document' and p.action = 'read' and p.field_group = 'document'
         join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = p.id and rp.effect = 'ALLOW'
         join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = p.id
              and rap.active and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
        where ra.company_id = $1 and ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
          and ($2::uuid is null or ra.user_id = $2::uuid)
          -- An OWN assignment can only ever cover its holder's own record, so other people's are not candidates.
          and (ra.scope_kind <> 'OWN' or exists (select 1 from user_employee_link l
                                                  where l.company_id = ra.company_id and l.user_id = ra.user_id and l.employee_id = $3::uuid))
        order by ra.user_id, ra.id`,
      [companyId, onlyUserId, employeeId],
    )
  ).rows;
  const readers: string[] = [];
  for (const c of candidates) {
    if (readers.includes(c.user_id)) continue; // one qualifying assignment is enough
    const decision = await resolveAccess(tx, { userId: c.user_id, companyId, assignmentId: c.assignment_id, resource: 'document', action: 'read', fieldGroups: ['document'] });
    if (decision.allowed && decision.allowedFieldGroups.includes('document') && (await canAccessEmployee(tx, decision, employeeId))) readers.push(c.user_id);
  }
  return readers;
}

/**
 * Users holding a company-wide duty as its routes decide it: an active, approved company-scope assignment whose role
 * ceiling ALLOWs and whose DB109 allowlist holds the permission for every given field group, and which `qualifies`. The
 * candidates are narrowed in SQL; each is then decided by the C1 check, one assignment at a time, so grants are never
 * combined across assignments.
 */
async function companyScopeHolders(
  tx: Queryable,
  companyId: string,
  permission: { resource: string; action: string; groups: string[] },
  onlyUserId: string | null,
  qualifies: (grant: AccessGrant) => boolean,
): Promise<string[]> {
  const { resource, action, groups } = permission;
  const candidates = (
    await tx.query<{ assignment_id: string; user_id: string }>(
      `select ra.id as assignment_id, ra.user_id
         from role_assignment ra
        where ra.company_id = $1 and ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
          and ra.scope_kind = 'COMPANY' and ($2::uuid is null or ra.user_id = $2::uuid)
          and not exists (
                select 1 from unnest($3::text[]) as g (field_group)
                 where not exists (
                         select 1 from permission p
                           join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = p.id and rp.effect = 'ALLOW'
                           join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = p.id
                                and rap.active and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
                          where p.resource = $4 and p.action = $5 and p.field_group = g.field_group))
        order by ra.user_id, ra.id`,
      [companyId, onlyUserId, groups, resource, action],
    )
  ).rows;
  const holders: string[] = [];
  for (const c of candidates) {
    if (holders.includes(c.user_id)) continue; // one qualifying assignment is enough
    const d = await resolveAccess(tx, { userId: c.user_id, companyId, assignmentId: c.assignment_id, resource, action, fieldGroups: groups });
    if (d.allowed && d.scopeKind === 'COMPANY' && groups.every((g) => d.allowedFieldGroups.includes(g)) && qualifies(d)) holders.push(c.user_id);
  }
  return holders;
}

const unrestricted = (grant: AccessGrant): boolean => grant.filters.departments.length + grant.filters.locations.length + grant.filters.employees.length === 0;

/**
 * Users who can currently manage a company policy (FR-010, DF02; migration 0060): company_policy.manage for every field
 * group of the policy's current classification (operational, and confidential as well for a CONFIDENTIAL policy), from an
 * unrestricted company scope (policies are published only from one), so a confidential policy never reaches anyone
 * without the confidential group.
 */
async function policyManagers(tx: Queryable, companyId: string, policyVersionId: string, onlyUserId: string | null = null): Promise<string[]> {
  const policy = (
    await tx.query<{ classification: string }>(
      `select p.classification from company_policy_version v join company_policy p on p.company_id = v.company_id and p.id = v.policy_id
        where v.company_id = $1 and v.id = $2`,
      [companyId, policyVersionId],
    )
  ).rows[0];
  if (!policy) return [];
  const groups = policy.classification === 'OPERATIONAL' ? ['operational'] : ['operational', 'confidential'];
  return companyScopeHolders(tx, companyId, { resource: 'company_policy', action: 'manage', groups }, onlyUserId, unrestricted);
}

/**
 * FR-088 "configured support recipients" (I-60; the BRD names no list): whoever can run the sync again, i.e. biometric
 * sync_run in the unrestricted company scope the biometric routes require.
 */
const biometricSupport = (tx: Queryable, companyId: string, onlyUserId: string | null = null): Promise<string[]> =>
  companyScopeHolders(tx, companyId, { resource: 'biometric', action: 'sync_run', groups: ['operational'] }, onlyUserId, unrestricted);

/**
 * FR-067 eligible approvers of a pending role assignment, as approveGrant decides them: approve_role_grant in a company
 * scope that contains the grant's scope, never its beneficiary or requester (C4). Nobody once the grant left PENDING.
 */
async function grantApprovers(tx: Queryable, companyId: string, assignmentId: string, onlyUserId: string | null = null): Promise<string[]> {
  const grant = (await tx.query<{ user_id: string; created_by: string | null; state: string }>(`select user_id, created_by, state from role_assignment where company_id = $1 and id = $2`, [companyId, assignmentId])).rows[0];
  if (!grant || grant.state !== 'PENDING') return [];
  const target = await loadFilters(tx, companyId, assignmentId);
  const holders = await companyScopeHolders(tx, companyId, { resource: 'access', action: 'approve_role_grant', groups: ['operational'] }, onlyUserId, (d) => withinAdministrativeScope(d, target));
  return holders.filter((u) => u !== grant.user_id && u !== grant.created_by);
}

/** Who could decide an open role permission change (access/role-permissions.ts): the whole-company approval duty, not its requester, and not holding the role. */
async function rolePermissionDeciders(tx: Queryable, companyId: string, changeId: string, onlyUserId: string | null = null): Promise<string[]> {
  const change = (await tx.query<{ role_id: string; requested_by: string; state: string }>(`select role_id, requested_by, state from role_permission_change where company_id = $1 and id = $2`, [companyId, changeId])).rows[0];
  if (!change || change.state !== 'PROPOSED') return [];
  const holders = await companyScopeHolders(tx, companyId, { resource: 'access', action: 'approve_role_grant', groups: ['operational'] }, onlyUserId, unrestricted);
  if (holders.length === 0) return [];
  const affected = new Set(
    (
      await tx.query<{ user_id: string }>(
        `select user_id from role_assignment where company_id = $1 and role_id = $2 and user_id = any($3::uuid[]) and state in ('PENDING', 'ACTIVE') and (effective_to is null or effective_to > now())`,
        [companyId, change.role_id, holders],
      )
    ).rows.map((r) => r.user_id),
  );
  return holders.filter((u) => u !== change.requested_by && !affected.has(u));
}

/** The subject employee's current direct managers (their linked users), by effective dates. */
async function managerUsers(tx: Queryable, companyId: string, employeeId: string): Promise<string[]> {
  return (
    await tx.query<{ u: string }>(
      `select l.user_id as u from manager_assignment m
         join user_employee_link l on l.company_id = m.company_id and l.employee_id = m.manager_employee_id
              and l.effective_from <= hrms_business_date($1, now()) and (l.effective_to is null or l.effective_to > hrms_business_date($1, now()))
        where m.company_id = $1 and m.employee_id = $2
          and m.effective_from <= hrms_business_date($1, now()) and (m.effective_to is null or m.effective_to > hrms_business_date($1, now()))`,
      [companyId, employeeId],
    )
  ).rows.map((x) => x.u);
}

/** DF12's "active company employees": the employee statuses that receive and appear in celebrations (BR-032; FR-083). */
export const ACTIVE_EMPLOYEE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'] as const;

/**
 * DF12 "active company employees who have celebration access"; section 11.2 "owner-approved scoped audience only": users
 * linked today to an active employee of the company, who hold celebration.read in an active assignment (its role, its own
 * DB109 entry and the group's classification, as resolveAccess reads them), so an account with no employee link, a separated
 * employee whose assignment is still active and an assignment without the grant receive nothing. The same at fan-out and at
 * delivery (`onlyUserId`).
 */
async function celebrationAudience(tx: Queryable, companyId: string, onlyUserId: string | null = null, page: { after: string | null; limit: number } | null = null): Promise<string[]> {
  return (
    await tx.query<{ u: string }>(
      `with d as (select hrms_business_date($1, now()) as today)
       select distinct ra.user_id as u
         from d, role_assignment ra
         join user_account ua on ua.id = ra.user_id and ua.active
         join role r on r.company_id = ra.company_id and r.id = ra.role_id and r.active
         join permission p on p.resource = 'celebration' and p.action = 'read' and p.field_group = 'operational'
         join role_permission rp on rp.company_id = ra.company_id and rp.role_id = ra.role_id and rp.permission_id = p.id and rp.effect = 'ALLOW'
         join role_assignment_permission rap on rap.company_id = ra.company_id and rap.role_assignment_id = ra.id and rap.permission_id = p.id
              and rap.active and rap.effective_from <= now() and (rap.effective_to is null or rap.effective_to > now())
        where ra.company_id = $1 and ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
          and ($2::uuid is null or ra.user_id = $2)
          and (r.access_class in ('ADMIN', 'MANAGER') or exists (
                select 1 from confidential_field_policy cfp
                 where cfp.company_id = ra.company_id and cfp.resource_code = p.resource and cfp.field_group = p.field_group and cfp.classification = 'OPERATIONAL'
                   and cfp.effective_from <= d.today and (cfp.effective_to is null or cfp.effective_to > d.today)))
          and exists (
                select 1 from user_employee_link l
                  join employee e on e.company_id = l.company_id and e.id = l.employee_id
                  join reference_value st on st.company_id = e.company_id and st.id = e.status_id and st.code = any($3::text[])
                 where l.company_id = ra.company_id and l.user_id = ra.user_id
                   and l.effective_from <= d.today and (l.effective_to is null or l.effective_to > d.today))
          and ($4::uuid is null or ra.user_id > $4)
        order by u limit $5`,
      [companyId, onlyUserId, ACTIVE_EMPLOYEE_STATUSES, page?.after ?? null, page?.limit ?? null],
    )
  ).rows.map((x) => x.u);
}

/** Recipients for a selector. Notifications never grant record access; they only point to it. */
async function recipients(tx: Queryable, companyId: string, selector: string, ev: EventSpec): Promise<string[]> {
  switch (selector) {
    case 'DOCUMENT_READERS':
      return ev.subjectEmployeeId ? documentReaders(tx, companyId, ev.subjectEmployeeId) : [];
    case 'POLICY_MANAGERS': {
      const versionId = id(ev.policyVersionId);
      return versionId ? policyManagers(tx, companyId, versionId) : [];
    }
    case 'ASSIGNED_REVIEWER': {
      // Module describers build their own specs: a malformed task id names no reviewer.
      if (!id(ev.taskId)) return [];
      const r = (await tx.query<{ u: string }>(`select assignee_user_id as u from approval_task where company_id = $1 and id = $2`, [companyId, ev.taskId])).rows;
      return r.map((x) => x.u);
    }
    case 'SUBJECT_EMPLOYEE':
      if (!ev.subjectEmployeeId) return [];
      // I-89 item 7: a deceased employee's own self-service is never notified, whatever the event, while a death exit stands
      // (submitted to separated; a death entry rejected in error lets notices reach the employee again).
      return (
        await tx.query<{ u: string }>(
          `select l.user_id as u from user_employee_link l
            where l.company_id = $1 and l.employee_id = $2
              and l.effective_from <= hrms_business_date($1, now()) and (l.effective_to is null or l.effective_to > hrms_business_date($1, now()))
              and not exists (select 1 from exit_case x where x.company_id = l.company_id and x.employee_id = l.employee_id
                                 and x.separation_type = 'DEATH' and x.state in ('SUBMITTED', 'RECOMMENDED', 'APPROVED', 'SEPARATED'))`,
          [companyId, ev.subjectEmployeeId],
        )
      ).rows.map((x) => x.u);
    case 'SUBJECT_MANAGER':
      return ev.subjectEmployeeId ? managerUsers(tx, companyId, ev.subjectEmployeeId) : [];
    case 'PROPOSER_OR_MANAGER': {
      // Someone who both proposed and manages the employee gets one notice: fanOut's key is per event, recipient and rule (BR-034).
      if (!ev.subjectEmployeeId) return [];
      const managers = ev.managerAlso ? await managerUsers(tx, companyId, ev.subjectEmployeeId) : [];
      return [...(ev.proposerUserId ? [ev.proposerUserId] : []), ...managers];
    }
    case 'BIOMETRIC_SUPPORT':
      return biometricSupport(tx, companyId);
    case 'GRANT_APPROVERS': {
      const changeId = id(ev.rolePermissionChangeId);
      if (changeId) return rolePermissionDeciders(tx, companyId, changeId);
      const assignmentId = id(ev.grantAssignmentId);
      return assignmentId ? grantApprovers(tx, companyId, assignmentId) : [];
    }
    case 'BENEFICIARY_USER':
      return ev.beneficiaryUserId ? [ev.beneficiaryUserId] : [];
    case 'FALLBACK_REVIEWERS': {
      // Escalations inform the explicit fallback list; they grant no authority and change no state (DF03).
      const kind =
        ev.fallbackKind ??
        (ev.transactionId ? (await tx.query<{ kind: string }>(`select kind from business_transaction where company_id = $1 and id = $2`, [companyId, ev.transactionId])).rows[0]?.kind : undefined);
      if (!kind) return [];
      const listed = (
        await tx.query<{ u: string }>(
          `select user_id as u from workflow_fallback_reviewer
            where company_id = $1 and kind = (select coalesce(routing_kind, kind) from transaction_kind where kind = $2) and active order by priority`,
          [companyId, kind],
        )
      ).rows.map((x) => x.u);
      // A notice about an employee reaches only the list members whose row scope covers that employee (DF02, I-25).
      return ev.subjectEmployeeId && id(ev.subjectEmployeeId) ? usersCoveringEmployee(tx, companyId, listed, ev.subjectEmployeeId) : listed;
    }
    case 'COMPANY_CELEBRATION_AUDIENCE':
      return celebrationAudience(tx, companyId);
    default:
      return [];
  }
}

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9]*)\s*\}\}/g;

/** Renders only approved placeholders; a missing value blocks output instead of rendering a gap. */
export function render(template: string, approved: string[], data: Record<string, string>): { text: string } | { missing: string } {
  let missing: string | null = null;
  const text = template.replace(PLACEHOLDER, (_m, key: string) => {
    if (!approved.includes(key) || data[key] === undefined || data[key] === '') {
      missing ??= key;
      return '';
    }
    return data[key]!;
  });
  return missing ? { missing } : { text };
}

/**
 * Delivery-time authority: active user, still holding an active assignment in the company; reviewers still own an open
 * task (except for withdrawal notices, sent once the task closed) and still cover its employee (I-52); a proposer or
 * manager told of a decision still covers the employee; document notices still need a document-reading assignment whose
 * scope covers the employee; policy, biometric support and grant approval notices still need the assignment that holds
 * the duty. The one exception to "an active assignment": a user told their own role grant ended may hold no other (DF12).
 */
export async function stillEligible(tx: Queryable, companyId: string, userId: string, selector: string, ev: EventSpec): Promise<boolean> {
  if (ev.eventType === 'ACCESS_GRANT_ENDED') {
    return (await tx.query<{ active: boolean }>(`select active from user_account where id = $1`, [userId])).rows[0]?.active === true;
  }
  const base = (
    await tx.query<{ ok: boolean }>(
      `select exists (select 1 from role_assignment ra join user_account u on u.id = ra.user_id and u.active
                       where ra.company_id = $1 and ra.user_id = $2 and ra.state = 'ACTIVE'
                         and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())) as ok`,
      [companyId, userId],
    )
  ).rows[0]!.ok;
  if (!base) return false;
  // A delegate whose delegation ended hears nothing more about the task, open or closed (C1, ZT05; DF12 "recheck recipient").
  if (selector === 'ASSIGNED_REVIEWER' && id(ev.taskId)) {
    const ended = await tx.query(`select 1 from approval_task t where t.company_id = $1 and t.id = $2 and not ${taskDelegationLive('t')}`, [companyId, ev.taskId]);
    if ((ended.rowCount ?? 0) > 0) return false;
  }
  if (selector === 'ASSIGNED_REVIEWER' && ev.taskId) {
    if (!AFTER_TASK_CLOSED.has(ev.eventType)) {
      const open = await tx.query(`select 1 from approval_task where company_id = $1 and id = $2 and assignee_user_id = $3 and state = 'PENDING'`, [companyId, ev.taskId, userId]);
      if ((open.rowCount ?? 0) === 0) return false;
    }
    // A notice about an employee the reviewer no longer covers is not delivered, though the task stays theirs (C4, ZT02, I-52).
    return !ev.subjectEmployeeId || !id(ev.subjectEmployeeId) || (await usersCoveringEmployee(tx, companyId, [userId], ev.subjectEmployeeId)).length > 0;
  }
  if (selector === 'PROPOSER_OR_MANAGER') {
    return ev.subjectEmployeeId !== null && (await usersCoveringEmployee(tx, companyId, [userId], ev.subjectEmployeeId)).length > 0;
  }
  if (selector === 'DOCUMENT_READERS') {
    return ev.subjectEmployeeId !== null && (await documentReaders(tx, companyId, ev.subjectEmployeeId, userId)).length > 0;
  }
  if (selector === 'POLICY_MANAGERS') {
    const versionId = id(ev.policyVersionId);
    return versionId !== null && (await policyManagers(tx, companyId, versionId, userId)).length > 0;
  }
  if (selector === 'BIOMETRIC_SUPPORT') return (await biometricSupport(tx, companyId, userId)).length > 0;
  if (selector === 'COMPANY_CELEBRATION_AUDIENCE') return (await celebrationAudience(tx, companyId, userId)).length > 0;
  if (selector === 'GRANT_APPROVERS') {
    const changeId = id(ev.rolePermissionChangeId);
    if (changeId) return (await rolePermissionDeciders(tx, companyId, changeId, userId)).length > 0;
    const assignmentId = id(ev.grantAssignmentId);
    return assignmentId !== null && (await grantApprovers(tx, companyId, assignmentId, userId)).length > 0;
  }
  return true;
}

/**
 * In-app: delivered at once. Email (0247): the same preference and recipient checks, then the notice is rendered for email (state
 * placeholders only, values neutralised, wording checked; email-content.ts) and left QUEUED for the worker, which alone sends it
 * (email-delivery.ts). A request's transaction never waits for a mail server.
 */
async function deliver(
  tx: Queryable,
  companyId: string,
  n: { id: string; userId: string; selector: string; optional: boolean; eventType: string; channel: 'IN_APP' | 'EMAIL' },
  ev: EventSpec,
  template: { subject: string | null; body: string; approved: string[] },
): Promise<string> {
  const attempt = async (outcome: 'DELIVERED' | 'FAILED' | 'SUPPRESSED', failure: string | null) => {
    await tx.query(
      `insert into notification_delivery_attempt (company_id, notification_id, attempt_number, outcome, outcome_at, failure_code, created_by, updated_by)
       values ($1, $2, coalesce((select max(attempt_number) from notification_delivery_attempt where company_id = $1 and notification_id = $2), 0) + 1, $3, now(), $4, $5, $5)`,
      [companyId, n.id, outcome, failure, SYSTEM_ACTOR_ID],
    );
  };
  const settle = (state: 'SUPPRESSED' | 'FAILED') => tx.query(`update notification set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, n.id, state, SYSTEM_ACTOR_ID]);

  if (n.optional) {
    const pref = (
      await tx.query<{ receive_optional: boolean }>(
        `select receive_optional from notification_preference where company_id = $1 and user_id = $2 and event_type = $3 and channel = $4`,
        [companyId, n.userId, n.eventType, n.channel],
      )
    ).rows[0];
    if (pref && !pref.receive_optional) {
      await settle('SUPPRESSED');
      await attempt('SUPPRESSED', 'RECIPIENT_OPTED_OUT');
      return 'SUPPRESSED';
    }
  }
  if (!(await stillEligible(tx, companyId, n.userId, n.selector, ev))) {
    await settle('SUPPRESSED');
    await attempt('SUPPRESSED', 'RECIPIENT_NOT_ELIGIBLE');
    return 'SUPPRESSED';
  }
  if (n.channel === 'EMAIL') {
    const data = emailData(ev.data);
    const body = render(template.body, template.approved, data);
    const subject = render(template.subject ?? DEFAULT_EMAIL_SUBJECT, template.approved, data);
    if ('missing' in body || 'missing' in subject) {
      await settle('FAILED');
      await attempt('FAILED', 'MISSING_PLACEHOLDER');
      return 'FAILED';
    }
    if (emailContentRefusal(`${subject.text}\n${body.text}`)) {
      await settle('FAILED');
      await attempt('FAILED', 'CONFIDENTIAL_CONTENT_BLOCKED');
      return 'FAILED';
    }
    await tx.query(`update notification set title = $3, body = $4, email_next_attempt_at = now(), updated_by = $5 where company_id = $1 and id = $2`, [
      companyId,
      n.id,
      emailSubjectLine(subject.text),
      body.text,
      SYSTEM_ACTOR_ID,
    ]);
    return 'QUEUED';
  }
  const body = render(template.body, template.approved, ev.data);
  const subject = template.subject ? render(template.subject, template.approved, ev.data) : { text: null as string | null };
  if ('missing' in body || 'missing' in subject) {
    await settle('FAILED');
    await attempt('FAILED', 'MISSING_PLACEHOLDER');
    return 'FAILED';
  }
  await tx.query(`update notification set state = 'DELIVERED', title = $3, body = $4, updated_by = $5 where company_id = $1 and id = $2`, [companyId, n.id, subject.text, body.text, SYSTEM_ACTOR_ID]);
  await attempt('DELIVERED', null);
  return 'DELIVERED';
}

/**
 * Creates and delivers notifications for one described event inside the caller's transaction. `recorded` is
 * false when the event key was already processed (a replay or rerun), in which case nothing is created.
 */
export async function fanOut(tx: Queryable, companyId: string, eventKey: string, occurrenceDate: string | null, ev: EventSpec): Promise<{ created: number; recorded: boolean }> {
  const eventId = await recordEvent(tx, companyId, eventKey, occurrenceDate, ev);
  if (!eventId) return { created: 0, recorded: false }; // event already processed (replay)

  const rules = (
    await tx.query<NoticeRule>(
      `select r.id, r.revision, r.channel, r.recipient_selector, r.optional_event, t.subject_template, t.body_template, t.approved_placeholders
         from notification_rule r join notification_template t on t.company_id = r.company_id and t.id = r.template_id and t.active
        where r.company_id = $1 and r.event_type = $2 and ${RULE_IN_FORCE}`,
      [companyId, ev.eventType],
    )
  ).rows;

  let created = 0;
  for (const rule of rules) {
    for (const userId of await recipients(tx, companyId, rule.recipient_selector, ev)) {
      if (await notifyRecipient(tx, companyId, eventId, rule, userId, ev)) created++;
    }
  }
  return { created, recorded: true };
}

interface NoticeRule {
  id: string;
  revision: number;
  channel: 'IN_APP' | 'EMAIL';
  recipient_selector: string;
  optional_event: boolean;
  subject_template: string | null;
  body_template: string;
  approved_placeholders: string[];
}

/** A rule that applies to events recorded now (alias r). */
const RULE_IN_FORCE = `r.active and r.publication_state = 'PUBLISHED' and r.effective_from <= now() and (r.effective_to is null or r.effective_to > now())`;

/** Records the event; answers its id, or undefined when its key was already recorded. */
async function recordEvent(tx: Queryable, companyId: string, eventKey: string, occurrenceDate: string | null, ev: EventSpec): Promise<string | undefined> {
  return (
    await tx.query<{ id: string }>(
      `insert into notification_event (company_id, event_key, event_type, subject_employee_id, transaction_id, transaction_revision,
                                       occurrence_date, business_timezone, data, created_by, updated_by)
       select $1, $2, $3, $4, $5, $6, coalesce($7::date, hrms_business_date($1, now())), c.business_timezone, $8, $9, $9 from company c where c.id = $1
       on conflict (company_id, event_key) do nothing returning id`,
      [companyId, eventKey, ev.eventType, ev.subjectEmployeeId, ev.transactionId, ev.transactionRevision, occurrenceDate, ev.data, SYSTEM_ACTOR_ID],
    )
  ).rows[0]?.id;
}

/** One notification and its delivery. False when this recipient already has it under this rule revision and channel (BR-034). */
async function notifyRecipient(tx: Queryable, companyId: string, eventId: string, rule: NoticeRule, userId: string, ev: EventSpec): Promise<boolean> {
  const n = (
    await tx.query<{ id: string }>(
      `insert into notification (company_id, recipient_user_id, transaction_id, category, state, event_id, rule_id, channel, idempotency_key, created_by, updated_by)
       values ($1, $2, $3, $4, 'QUEUED', $5, $6, $7, $8, $9, $9) on conflict (company_id, idempotency_key) do nothing returning id`,
      [companyId, userId, ev.transactionId, ev.eventType, eventId, rule.id, rule.channel, `${eventId}:${userId}:${rule.channel}:${rule.id}:${rule.revision}`, SYSTEM_ACTOR_ID],
    )
  ).rows[0];
  if (!n) return false;
  await deliver(tx, companyId, { id: n.id, userId, selector: rule.recipient_selector, optional: rule.optional_event, eventType: ev.eventType, channel: rule.channel }, ev, {
    subject: rule.subject_template,
    body: rule.body_template,
    approved: rule.approved_placeholders,
  });
  return true;
}

/** Recipients written per transaction when an event goes to a whole company; a starting value, to be measured (G4). */
export const celebrationRecipientBatch = (): number => positiveIntFromEnv('CELEBRATION_RECIPIENT_BATCH') ?? 200;

/** The next recipients of a rule after a position, in user id order. Only the company-wide selector can be large, so only it is paged in SQL. */
async function recipientPage(tx: Queryable, companyId: string, selector: string, ev: EventSpec, after: string | null, limit: number): Promise<string[]> {
  if (selector === 'COMPANY_CELEBRATION_AUDIENCE') return celebrationAudience(tx, companyId, null, { after, limit });
  const all = [...new Set(await recipients(tx, companyId, selector, ev))].sort();
  return (after === null ? all : all.filter((u) => u > after)).slice(0, limit);
}

/** Records a new event with a position per rule in force; for an event already recorded, finds it if it still has recipients to go. */
async function openFanOut(tx: Queryable, companyId: string, eventKey: string, occurrenceDate: string | null, ev: EventSpec): Promise<{ id: string; data: Record<string, string> } | null> {
  const eventId = await recordEvent(tx, companyId, eventKey, occurrenceDate, ev);
  if (eventId) {
    await tx.query(
      `insert into notification_fan_out (company_id, event_id, rule_id, created_by, updated_by)
       select r.company_id, $2, r.id, $4, $4
         from notification_rule r join notification_template t on t.company_id = r.company_id and t.id = r.template_id and t.active
        where r.company_id = $1 and r.event_type = $3 and ${RULE_IN_FORCE}`,
      [companyId, eventId, ev.eventType, SYSTEM_ACTOR_ID],
    );
    return { id: eventId, data: ev.data };
  }
  return (
    (
      await tx.query<{ id: string; data: Record<string, string> }>(
        `select e.id, e.data from notification_event e
          where e.company_id = $1 and e.event_key = $2
            and exists (select 1 from notification_fan_out f where f.company_id = e.company_id and f.event_id = e.id and f.finished_at is null)`,
        [companyId, eventKey],
      )
    ).rows[0] ?? null
  );
}

/**
 * One batch of recipients of the first rule with any to go, in one transaction: the notices and the moved position commit
 * together, so a crash loses at most this batch and the next run starts right after the last recipient written. The position's
 * row lock keeps a second worker off until this batch is committed; it then continues from the new position. The rules are those
 * in force when the event was recorded, as if it had been written in one transaction; the recipient check runs at each delivery.
 */
async function fanOutBatch(tx: Queryable, companyId: string, eventId: string, ev: EventSpec, batchSize: number): Promise<{ created: number; done: boolean }> {
  const position = (
    await tx.query<NoticeRule & { after_user_id: string | null }>(
      `select r.id, r.revision, r.channel, r.recipient_selector, r.optional_event, t.subject_template, t.body_template, t.approved_placeholders, f.after_user_id
         from notification_fan_out f
         join notification_rule r on r.company_id = f.company_id and r.id = f.rule_id
         join notification_template t on t.company_id = r.company_id and t.id = r.template_id
        where f.company_id = $1 and f.event_id = $2 and f.finished_at is null
        order by f.rule_id limit 1 for update of f`,
      [companyId, eventId],
    )
  ).rows[0];
  if (!position) return { created: 0, done: true };
  const page = await recipientPage(tx, companyId, position.recipient_selector, ev, position.after_user_id, batchSize);
  let created = 0;
  for (const userId of page) if (await notifyRecipient(tx, companyId, eventId, position, userId, ev)) created++;
  await tx.query(
    `update notification_fan_out set after_user_id = $4, finished_at = case when $5::boolean then now() end, updated_by = $6
      where company_id = $1 and event_id = $2 and rule_id = $3`,
    [companyId, eventId, position.id, page.at(-1) ?? position.after_user_id, page.length < batchSize, SYSTEM_ACTOR_ID],
  );
  return { created, done: false };
}

/**
 * fanOut for an event that goes to a whole company (DF12 celebrations): one notice per recipient, written in transactions of at
 * most `batchSize` recipients, each recipient once across a crash and any rerun. `recorded` is false when the event's recipients
 * were all done before this call. A resumed event keeps the content it was recorded with, so every recipient reads the same notice.
 */
export async function fanOutInBatches(db: Database, companyId: string, eventKey: string, occurrenceDate: string | null, ev: EventSpec, batchSize: number): Promise<{ created: number; recorded: boolean }> {
  const event = await withTransaction(db, (tx) => openFanOut(tx, companyId, eventKey, occurrenceDate, ev));
  if (!event) return { created: 0, recorded: false };
  const recorded = { ...ev, data: event.data };
  let created = 0;
  for (;;) {
    const step = await withTransaction(db, (tx) => fanOutBatch(tx, companyId, event.id, recorded, batchSize));
    created += step.created;
    if (step.done) return { created, recorded: true };
  }
}

/** DF12: a failing event is retried after 1, 5 and 15 minutes, then FAILED; it never holds back the events behind it. */
const RETRY_MINUTES = [1, 5, 15];

/** A failure class for the retry log: a PostgreSQL code or the error's name, never its message (it may hold values). */
function failureCode(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && /^[A-Z0-9]{5}$/.test(code)) return `PG_${code}`;
  const name = err instanceof Error ? err.name : 'Error';
  return /^[A-Za-z0-9_.:-]{1,100}$/.test(name) ? name : 'Error';
}

/**
 * The claim: the next company's oldest ready event after a position. Within a company oldest first: ids are random UUIDs (0071),
 * so the order is the writing transaction's start time, then `seq`, the cell-local position that keeps the order in which one
 * transaction wrote its events. An event waiting for its retry is not in this index at all (0160), so no claim reads past one.
 */
export const OUTBOX_CLAIM_SQL = `select id::text, company_id, topic, aggregate_id, dedupe_key, payload, attempts from outbox_event
            where published_at is null and failed_at is null and next_attempt_at is null and company_id > $1
            order by company_id, created_at, seq limit 1 for update skip locked`;

const outboxTurns = companyTurns();

/**
 * Up to `limit` events: one transaction each, one company at a time, so a burst from one company leaves every other company's
 * next event within as many claims as there are companies with events ready. Retries that have fallen due first go back among
 * the ready events, at their own place in their company's order. Returns how many were consumed.
 */
export async function dispatchOutbox(db: Database, limit = 100): Promise<number> {
  await db.query(
    `with due as (select id from outbox_event
                   where published_at is null and failed_at is null and next_attempt_at <= now()
                   order by next_attempt_at limit $1 for update skip locked)
     update outbox_event e set next_attempt_at = null from due where e.id = due.id`,
    [limit],
  );
  let consumed = 0;
  for (let i = 0; i < limit; i++) {
    const claimed = await withTransaction(db, (tx) => outboxTurns.next((after) => processNextEvent(tx, after)));
    if (!claimed) break;
    consumed++;
  }
  return consumed;
}

async function processNextEvent(tx: Queryable, after: string): Promise<{ companyId: string } | null> {
  const o = (await tx.query<OutboxRow & { attempts: number }>(OUTBOX_CLAIM_SQL, [after])).rows[0];
  if (!o) return null;
  // Each event in its own savepoint: a failure undoes only that event's partial work and is retried later.
  await tx.query('savepoint outbox_event');
  try {
    const ev = await describe(tx, o);
    if (ev) await fanOut(tx, o.company_id, `outbox:${o.dedupe_key}`, null, ev);
    await tx.query('release savepoint outbox_event');
    await tx.query(`update outbox_event set published_at = now(), attempts = attempts + 1, next_attempt_at = null where id = $1`, [o.id]);
  } catch (err) {
    await tx.query('rollback to savepoint outbox_event');
    const attempt = o.attempts + 1;
    const code = failureCode(err);
    const delay = RETRY_MINUTES[attempt - 1] ?? null;
    await tx.query(`insert into outbox_event_attempt (event_id, company_id, attempt, error_code) values ($1, $2, $3, $4)`, [o.id, o.company_id, attempt, code]);
    await tx.query(
      `update outbox_event set attempts = $2, last_error = $3,
              next_attempt_at = case when $4::int is null then null else now() + make_interval(mins => $4::int) end,
              failed_at = case when $4::int is null then now() end
        where id = $1`,
      [o.id, attempt, code, delay],
    );
  }
  return { companyId: o.company_id };
}

/** Celebrants read per page; a starting value, to be measured (G4). */
export const celebrationPageSize = (): number => positiveIntFromEnv('CELEBRATION_PAGE_SIZE') ?? 100;

/**
 * FR-083 / DF12 celebrations for a company business date: opt-in only, active employments only; content is
 * name, department and event type (never birth date, year or age). 29 Feb birthdays are observed on 28 Feb in
 * non-leap years; work anniversaries use the service base date (or joining date) with month-end clamp.
 * Celebrants are read a page at a time and each event's notices are written in batches, never in one whole-company
 * transaction; a rerun after a crash finishes what is left (fanOutInBatches) and repeats nothing. A celebrant no longer due on
 * that rerun (opted out, or no longer active) is not continued.
 */
export async function runCelebrations(db: Database, companyId: string, day: string, options: { pageSize?: number; recipientBatch?: number } = {}) {
  const pageSize = options.pageSize ?? celebrationPageSize();
  const recipientBatch = options.recipientBatch ?? celebrationRecipientBatch();
  let events = 0;
  let after: { employee_id: string; kind: string } | null = null;
  for (;;) {
    const due: { employee_id: string; kind: 'BIRTHDAY' | 'WORK_ANNIVERSARY'; name: string; department: string; year: string }[] = (
      await db.query<{ employee_id: string; kind: 'BIRTHDAY' | 'WORK_ANNIVERSARY'; name: string; department: string; year: string }>(
        `with d as (select $2::date as day, extract(year from $2::date)::int as y)
         select e.id as employee_id, k.kind, e.display_name as name, coalesce(dep.name, 'the company') as department, d.y::text as year
           from d
           join employee e on e.company_id = $1
           join reference_value st on st.company_id = e.company_id and st.id = e.status_id and st.code = any($3::text[])
           join user_employee_link l on l.company_id = e.company_id and l.employee_id = e.id
                and l.effective_from <= d.day and (l.effective_to is null or l.effective_to > d.day)
           cross join (values ('BIRTHDAY'), ('WORK_ANNIVERSARY')) as k (kind)
           join notification_preference np on np.company_id = e.company_id and np.user_id = l.user_id
                and np.event_type = k.kind and np.channel = 'IN_APP' and np.publish_celebration
           left join employment_assignment ea on ea.company_id = e.company_id and ea.employee_id = e.id
                and ea.effective_from <= d.day and (ea.effective_to is null or ea.effective_to > d.day)
           left join department dep on dep.company_id = ea.company_id and dep.id = ea.department_id
          where ((k.kind = 'BIRTHDAY' and e.date_of_birth is not null
                  and (e.date_of_birth + make_interval(years => d.y - extract(year from e.date_of_birth)::int))::date = d.day)
              or (k.kind = 'WORK_ANNIVERSARY' and d.y > extract(year from coalesce(e.service_anniversary_date, e.joining_date))::int
                  and (coalesce(e.service_anniversary_date, e.joining_date)
                       + make_interval(years => d.y - extract(year from coalesce(e.service_anniversary_date, e.joining_date))::int))::date = d.day))
            and ($4::uuid is null or (e.id, k.kind) > ($4::uuid, $5::text))
          order by e.id, k.kind limit $6`,
        [companyId, day, ACTIVE_EMPLOYEE_STATUSES, after?.employee_id ?? null, after?.kind ?? null, pageSize],
      )
    ).rows;
    for (const c of due) {
      const result = await fanOutInBatches(
        db,
        companyId,
        `${c.kind}:${c.employee_id}:${c.year}`,
        day,
        {
          eventType: c.kind,
          subjectEmployeeId: c.employee_id,
          transactionId: null,
          transactionRevision: null,
          taskId: null,
          beneficiaryUserId: null,
          data: { employeeName: c.name, department: c.department },
        },
        recipientBatch,
      );
      if (result.created > 0) events++;
    }
    const last = due.at(-1);
    if (!last || due.length < pageSize) return { day, events };
    after = last;
  }
}
