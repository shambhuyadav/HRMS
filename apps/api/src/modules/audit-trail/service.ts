// Audit trail read and retention controls (FR-058; DF08; BR-007; C4; DF02).
// The audit viewer shows who did what to which record and when — field names and recorded value groups, never
// the values. Values stay visible only through each module's own history views under their field grants (an
// auditor is not an expense reviewer, a salary reader or a reason reader). Audit access is company-wide only.
// DF08: purge is disabled; retention rules and holds exist so that a future, separately approved purge could
// remove only eligible records and never held ones. The eligibility dry run shows exactly that.
import { writeAudit } from '../../audit/audit.js';
import { type Paging, pageMeta, pageOf, type Sorting, sortedBy } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';

export const RETENTION_RESOURCES = ['audit_event'] as const;
export type RetentionResource = (typeof RETENTION_RESOURCES)[number];

/** Audit records are not employee-scoped, so only an unrestricted company-scope assignment may read them. */
export function isCompanyWide(grant: AccessGrant): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0;
}

export function assertCompanyWide(grant: AccessGrant): void {
  if (!isCompanyWide(grant)) throw new HttpError(403, 'FORBIDDEN', 'Audit access needs an unrestricted company-scope assignment');
}

/**
 * Company configuration resources whose audited changes are configuration revisions: policies, payroll masters and
 * calendars, bank templates, workflow routing, letter templates and retention rules (each create, update,
 * activation, retirement or cancellation is one recorded revision event).
 */
export const CONFIGURATION_RESOURCES: readonly string[] = [
  'attendance_policy',
  'leave_policy',
  'expense_policy',
  'confirmation_policy',
  'appraisal_setting',
  'pay_component',
  'payroll_config',
  'payroll_head_revision',
  'payroll_calendar',
  'payroll_period',
  'payroll_paid_day_policy',
  'payroll_hold_criterion',
  'payroll_bank_template',
  'letter_template',
  'workflow',
  'workflow_routing',
  'retention_rule',
];

export interface AuditQuery {
  resource?: string | undefined;
  /** F2 "Configuration revision count": the events of CONFIGURATION_RESOURCES. */
  resourceGroup?: 'CONFIGURATION' | undefined;
  recordKey?: string | undefined;
  actorUserId?: string | undefined;
  action?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
}

/** Shared by the viewer and the export, so both show the same events and the same columns (BR-026). */
export function auditEventQuery(grant: AccessGrant, q: AuditQuery, params: SqlParams): { select: string; from: string } {
  const where = [`a.company_id = ${params.add(grant.companyId)}::uuid`];
  if (q.resource) where.push(`a.resource_code = ${params.add(q.resource)}`);
  if (q.resourceGroup === 'CONFIGURATION') where.push(`a.resource_code = any(${params.add(CONFIGURATION_RESOURCES)}::text[])`);
  if (q.recordKey) where.push(`a.record_key = ${params.add(q.recordKey)}::uuid`);
  if (q.actorUserId) where.push(`a.actor_user_id = ${params.add(q.actorUserId)}::uuid`);
  if (q.action) where.push(`a.action = ${params.add(q.action)}`);
  // Periods are company-local calendar dates.
  if (q.from) where.push(`a.occurred_at >= (${params.add(q.from)}::date)::timestamp at time zone c.business_timezone`);
  if (q.to) where.push(`a.occurred_at < (${params.add(q.to)}::date + 1)::timestamp at time zone c.business_timezone`);
  const keys = (col: string) =>
    `case when jsonb_typeof(${col}) = 'object' then ${col} else '{}'::jsonb end`;
  return {
    select: `a.id, a.occurred_at, a.resource_code, a.record_key, a.action, a.actor_user_id, u.account_key as actor_account_key,
             r.code as acting_role_code, a.prior_version, a.new_version,
             array(select k from jsonb_object_keys(${keys('a.after_values')} || ${keys('a.before_values')}) as k order by k) as value_groups,
             array(select k from (select k from (select jsonb_object_keys(${keys("a.after_values -> 'operational'")}) as k
                                                 union select jsonb_object_keys(${keys("a.before_values -> 'operational'")})) top where k <> 'assignment'
                                  union
                                  -- FR-057: an assignment change names the fields that changed, so a grade change reads as one.
                                  select 'assignment.' || coalesce(na.key, nb.key)
                                    from jsonb_each(${keys("a.after_values #> '{operational,assignment}'")}) na
                                    full join jsonb_each(${keys("a.before_values #> '{operational,assignment}'")}) nb on nb.key = na.key
                                   where na.value is distinct from nb.value) f order by k) as changed_fields,
             a.reason is not null as reason_recorded`,
    from: `from audit_event a
             join company c on c.id = a.company_id
             join user_account u on u.id = a.actor_user_id
             left join role_assignment ra on ra.company_id = a.company_id and ra.id = a.acting_assignment_id
             left join role r on r.company_id = ra.company_id and r.id = ra.role_id
            where ${where.join(' and ')}`,
  };
}

/** FR-056: the audit viewer's sort keys and their columns in auditEventQuery; newest first by default. */
const AUDIT_SORT_COLUMNS = { occurredAt: 'a.occurred_at', resource: 'a.resource_code', action: 'a.action', actor: 'u.account_key' } as const;
export const AUDIT_SORTS = Object.keys(AUDIT_SORT_COLUMNS);

export async function listAuditEvents(db: Queryable, grant: AccessGrant, q: AuditQuery & Sorting & { page: number; pageSize: number }) {
  assertCompanyWide(grant);
  const params = new SqlParams();
  const { select, from } = auditEventQuery(grant, q, params);
  // The count runs before paging parameters exist: an unreferenced parameter has no inferable type.
  const total = Number((await db.query<{ n: string }>(`select count(*) as n ${from}`, [...params.values])).rows[0]!.n);
  const limit = params.add(q.pageSize);
  const offset = params.add((q.page - 1) * q.pageSize);
  const rows = await db.query<Record<string, unknown>>(`select ${select} ${from} order by ${sortedBy(q, AUDIT_SORT_COLUMNS, 'a.occurred_at desc, a.id')} limit ${limit}::int offset ${offset}::int`, params.values);
  return {
    items: rows.rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      resource: r.resource_code,
      recordKey: r.record_key,
      action: r.action,
      actorUserId: r.actor_user_id,
      actorAccountKey: r.actor_account_key,
      actingRoleCode: r.acting_role_code,
      priorVersion: r.prior_version,
      newVersion: r.new_version,
      valueGroups: r.value_groups,
      changedFields: r.changed_fields,
      reasonRecorded: r.reason_recorded,
    })),
    total,
  };
}

/**
 * FR-057 "Auditors can trace who changed an employee grade and which payroll run used it": the employee's assignment
 * revisions (who recorded each, when, and which fields it changed) and the payroll runs and records that used them
 * (0121), with the salary arrangements each calculation used. Identifiers, codes, dates and states only: never an
 * amount, so the audit duty needs no payroll grant. Read-only, like every audit route (FR-057 "audit access cannot
 * mutate the underlying transaction"). A run older than 0121 has no recorded assignment and says null.
 */
export async function employeePayrollTrace(db: Queryable, grant: AccessGrant, employeeId: string, paging: Paging = {}) {
  assertCompanyWide(grant);
  const employee = (await db.query<{ id: string; code: string; name: string }>(`select id, employee_code as code, display_name as name from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId])).rows[0];
  if (!employee) throw notFound();
  const assignments = (
    await db.query(
      `select x.id, x.grade_id as "gradeId", g.code as "gradeCode", to_char(x.effective_from, 'YYYY-MM-DD') as "effectiveFrom", to_char(x.effective_to, 'YYYY-MM-DD') as "effectiveTo",
              x.created_at as "recordedAt", u.account_key as "recordedBy",
              array_remove(array[
                case when x.prev is not null and x.department_id is distinct from x.prev_department then 'assignment.departmentId' end,
                case when x.prev is not null and x.designation_id is distinct from x.prev_designation then 'assignment.designationId' end,
                case when x.prev is not null and x.grade_id is distinct from x.prev_grade then 'assignment.gradeId' end,
                case when x.prev is not null and x.location_id is distinct from x.prev_location then 'assignment.locationId' end
              ], null) as "changedFields"
         from (select ea.*, lag(ea.id) over w as prev, lag(ea.department_id) over w as prev_department, lag(ea.designation_id) over w as prev_designation,
                      lag(ea.grade_id) over w as prev_grade, lag(ea.location_id) over w as prev_location
                 from employment_assignment ea where ea.company_id = $1 and ea.employee_id = $2 window w as (order by ea.effective_from)) x
         left join grade g on g.company_id = x.company_id and g.id = x.grade_id
         left join user_account u on u.id = x.created_by
        order by x.effective_from desc`,
      [grant.companyId, employeeId],
    )
  ).rows;
  const runs = await pageOf(
    db,
    `select r.id as "runId", r.lineage_id as "lineageId", r.revision, r.state, p.period_code as "periodCode", to_char(p.service_start, 'YYYY-MM-DD') as "serviceStart", to_char(p.service_end, 'YYYY-MM-DD') as "serviceEnd",
            m.employment_assignment_id as "selectedAssignmentId", rec.id as "recordId", rec.employment_assignment_id as "calculatedAssignmentId", rec.calculation_status as "calculationStatus",
            rec.frozen_at as "frozenAt",
            array(select distinct s.salary_arrangement_id from payroll_record_segment s where s.company_id = rec.company_id and s.record_id = rec.id) as "salaryArrangementIds"
       from payroll_run_member m
       join payroll_run r on r.company_id = m.company_id and r.lineage_id = m.lineage_id and (m.excluded_from_revision is null or m.excluded_from_revision > r.revision)
       join payroll_period p on p.company_id = r.company_id and p.id = r.period_id
       left join payroll_record rec on rec.company_id = r.company_id and rec.run_id = r.id and rec.employee_id = m.employee_id
      where m.company_id = $1 and m.employee_id = $2`,
    [grant.companyId, employeeId],
    '"serviceStart" desc, "lineageId", revision desc',
    paging,
    TRACE_RUNS_CAP,
  );
  return { employee, assignments, runs: runs.items, ...pageMeta(runs) };
}

/** Runs answered without page/pageSize: far more than one employee's years of monthly runs and their revisions. */
const TRACE_RUNS_CAP = 500;

// ---------------------------------------------------------------------------------------------------------
// Retention rules (owner-entered, independently activated) and holds (independently approved).
// ---------------------------------------------------------------------------------------------------------

export async function listRetentionRules(db: Queryable, grant: AccessGrant) {
  const rows = await db.query(
    `select id, resource_code as resource, revision, retain_days as "retainDays", basis_note as "basisNote", state,
            created_by as "createdBy", approved_by as "approvedBy", approved_at as "approvedAt", version
       from retention_rule where company_id = $1 order by resource_code, revision`,
    [grant.companyId],
  );
  return { items: rows.rows };
}

export async function proposeRetentionRule(tx: Queryable, grant: AccessGrant, input: { resource: RetentionResource; retainDays: number; basisNote: string }) {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('retention_rule:' || $1 || ':' || $2, 0))`, [grant.companyId, input.resource]);
  const revision = (
    await tx.query<{ next: number }>(`select coalesce(max(revision), 0) + 1 as next from retention_rule where company_id = $1 and resource_code = $2`, [grant.companyId, input.resource])
  ).rows[0]!.next;
  const id = (
    await tx.query<{ id: string }>(
      `insert into retention_rule (company_id, resource_code, revision, retain_days, basis_note, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'DRAFT', $6, $6) returning id`,
      [grant.companyId, input.resource, revision, input.retainDays, input.basisNote.trim(), grant.userId],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'retention_rule',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { resource: input.resource, revision, retainDays: input.retainDays, basisNote: input.basisNote.trim(), state: 'DRAFT' } },
  });
  return { id, revision, state: 'DRAFT' };
}

/** C4: the author never activates; the previous active revision of the same kind retires atomically. */
export async function activateRetentionRule(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number) {
  const rule = (
    await tx.query<{ resource_code: string; state: string; created_by: string; version: number }>(
      `select resource_code, state, created_by, version from retention_rule where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!rule) throw notFound();
  if (rule.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (rule.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft rule can be activated');
  if (rule.created_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'The author of a rule cannot activate it');
  await tx.query(`update retention_rule set state = 'RETIRED', updated_by = $3 where company_id = $1 and resource_code = $2 and state = 'ACTIVE'`, [
    grant.companyId,
    rule.resource_code,
    grant.userId,
  ]);
  await tx.query(`update retention_rule set state = 'ACTIVE', approved_by = $3, approved_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'retention_rule',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'ACTIVATE',
    priorVersion: rule.version,
    newVersion: rule.version + 1,
    before: { operational: { state: 'DRAFT' } },
    after: { operational: { state: 'ACTIVE' } },
  });
  return { id, state: 'ACTIVE' };
}

export async function listHolds(db: Queryable, grant: AccessGrant, state?: string) {
  const rows = await db.query(
    `select id, resource_code as resource, record_key as "recordKey", reason, state, requested_by as "requestedBy", decided_by as "decidedBy",
            decided_at as "decidedAt", released_by as "releasedBy", released_at as "releasedAt", release_reason as "releaseReason", created_at as "requestedAt", version
       from retention_hold where company_id = $1 and ($2::text is null or state = $2) order by created_at desc limit 500`,
    [grant.companyId, state ?? null],
  );
  return { items: rows.rows };
}

export async function requestHold(tx: Queryable, grant: AccessGrant, input: { resource: string; recordKey?: string | undefined; reason: string }) {
  const id = (
    await tx.query<{ id: string }>(
      `insert into retention_hold (company_id, resource_code, record_key, reason, state, requested_by, created_by, updated_by)
       values ($1, $2, $3, $4, 'PENDING', $5, $5, $5) returning id`,
      [grant.companyId, input.resource, input.recordKey ?? null, input.reason.trim(), grant.userId],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'retention_hold',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { operational: { resource: input.resource, recordKey: input.recordKey ?? null, state: 'PENDING' } },
    reason: input.reason.trim(),
  });
  return { id, state: 'PENDING' };
}

async function lockHold(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number) {
  const hold = (
    await tx.query<{ state: string; requested_by: string; version: number }>(`select state, requested_by, version from retention_hold where company_id = $1 and id = $2 for update`, [
      grant.companyId,
      id,
    ])
  ).rows[0];
  if (!hold) throw notFound();
  if (hold.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  return hold;
}

export async function decideHold(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number; decision: 'APPROVE' | 'REJECT' }) {
  const hold = await lockHold(tx, grant, id, input.expectedVersion);
  if (hold.state !== 'PENDING') throw new HttpError(409, 'INVALID_STATE', 'Only a pending hold can be decided');
  if (hold.requested_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'The requester of a hold cannot decide it');
  const state = input.decision === 'APPROVE' ? 'ACTIVE' : 'REJECTED';
  await tx.query(`update retention_hold set state = $3, decided_by = $4, decided_at = now(), updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, id, state, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'retention_hold',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.decision,
    priorVersion: hold.version,
    newVersion: hold.version + 1,
    before: { operational: { state: 'PENDING' } },
    after: { operational: { state } },
  });
  return { id, state };
}

export async function releaseHold(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number; reason: string }) {
  const hold = await lockHold(tx, grant, id, input.expectedVersion);
  if (hold.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'Only an active hold can be released');
  await tx.query(
    `update retention_hold set state = 'RELEASED', released_by = $3, released_at = now(), release_reason = $4, updated_by = $3 where company_id = $1 and id = $2`,
    [grant.companyId, id, grant.userId, input.reason.trim()],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'retention_hold',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'RELEASE',
    priorVersion: hold.version,
    newVersion: hold.version + 1,
    before: { operational: { state: 'ACTIVE' } },
    after: { operational: { state: 'RELEASED' } },
    reason: input.reason.trim(),
  });
  return { id, state: 'RELEASED' };
}

/**
 * Dry run (DF08: purge disabled): with the active rule, which audit events are older than the cutoff, and how
 * many of those an active hold preserves. A hold covers an audit event when it names the event itself or the
 * business record the event is about (or every record of that kind).
 */
export async function retentionEligibility(db: Queryable, grant: AccessGrant, resource: RetentionResource) {
  const rule = (
    await db.query<{ id: string; retain_days: number; revision: number }>(
      `select id, retain_days, revision from retention_rule where company_id = $1 and resource_code = $2 and state = 'ACTIVE'`,
      [grant.companyId, resource],
    )
  ).rows[0];
  const base = { resource, purgeEnabled: false as const, note: 'Purge is disabled (DF08): this is a dry run of what an approved purge could remove.' };
  if (!rule) return { ...base, rule: null, cutoffDate: null, eligibleCount: 0, heldCount: 0 };
  const counts = (
    await db.query<{ cutoff: string; eligible: string; held: string }>(
      `with c as (select business_timezone as tz, to_char(hrms_business_date(id, now()) - $2::int, 'YYYY-MM-DD') as cutoff from company where id = $1),
            old as (select a.id, a.resource_code, a.record_key from audit_event a, c
                     where a.company_id = $1 and a.occurred_at < (c.cutoff::date)::timestamp at time zone c.tz)
       select (select cutoff from c) as cutoff,
              count(*) filter (where not held) as eligible,
              count(*) filter (where held) as held
         from (select old.*, exists (
                 select 1 from retention_hold h
                  where h.company_id = $1 and h.state = 'ACTIVE'
                    and ((h.resource_code = 'audit_event' and (h.record_key is null or h.record_key = old.id))
                      or (h.resource_code = old.resource_code and (h.record_key is null or h.record_key = old.record_key)))) as held
                 from old) x`,
      [grant.companyId, rule.retain_days],
    )
  ).rows[0]!;
  return {
    ...base,
    rule: { id: rule.id, revision: rule.revision, retainDays: rule.retain_days },
    cutoffDate: counts.cutoff,
    eligibleCount: Number(counts.eligible),
    heldCount: Number(counts.held),
  };
}
