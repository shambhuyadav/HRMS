// C1 access decision (BRD v8.1 Appendix C, FR-002/098, BR-006/043/044/046, DF02, CI22/CI24).
//
// Everything is evaluated inside ONE explicitly selected role assignment: the action, the field grants,
// the confidentiality eligibility and the row scope must all come from that same assignment, so grants can
// never be stitched together across assignments. Default is deny.
//
// Order: active user -> active company -> selected assignment is the caller's, ACTIVE and effective now ->
// role active -> per field group: role ALLOWs the exact resource/action/field_group AND the assignment's
// DB109 allowlist has an active, effective entry -> confidential field groups additionally need an
// ADMIN/MANAGER access class -> row scope (OWN/TEAM/ASSIGNED/COMPANY) intersected with the assignment's
// filters (values OR within a dimension, dimensions AND).
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';

export type ScopeKind = 'OWN' | 'TEAM' | 'ASSIGNED' | 'COMPANY';
export type AccessClass = 'ADMIN' | 'MANAGER' | 'OTHER';

export type DenyReason =
  | 'UNKNOWN_CONTEXT'
  | 'USER_INACTIVE'
  | 'COMPANY_INACTIVE'
  | 'ASSIGNMENT_NOT_ACTIVE'
  | 'ROLE_INACTIVE'
  | 'NO_PERMISSION'
  | 'CONFIDENTIAL_NOT_ELIGIBLE';

export interface AccessRequest {
  userId: string;
  companyId: string;
  /** The assignment the user selected for this session/context (BR-046). Never inferred. */
  assignmentId: string;
  resource: string;
  action: string;
  /** Field groups the caller wants; the grant reports which are allowed. */
  fieldGroups: readonly string[];
  /** Decision instant; defaults to now. */
  at?: Date;
}

export interface FieldGroupDenial {
  fieldGroup: string;
  reason: Extract<DenyReason, 'NO_PERMISSION' | 'CONFIDENTIAL_NOT_ELIGIBLE'>;
}

export interface ScopeFilters {
  departments: string[];
  locations: string[];
  employees: string[];
}

export interface AccessGrant {
  allowed: true;
  userId: string;
  companyId: string;
  assignmentId: string;
  roleCode: string;
  accessClass: AccessClass;
  scopeKind: ScopeKind;
  filters: ScopeFilters;
  allowedFieldGroups: string[];
  /**
   * Allowed groups that come only from the H1 Employee OWN exception. Endpoints use this to keep reviewer-
   * authored text (e.g. HR amendment notes) out of the employee's own view while showing their own submissions.
   */
  ownEssFieldGroups: string[];
  deniedFieldGroups: FieldGroupDenial[];
  /** The caller's own employee in this company on the business date, if linked. */
  linkedEmployeeId: string | null;
  at: Date;
  /** Company-local business date (YYYY-MM-DD) used for effective-dated scope checks. */
  businessDate: string;
}

export interface AccessDenied {
  allowed: false;
  reason: DenyReason;
  deniedFieldGroups: FieldGroupDenial[];
}

export type AccessDecision = AccessGrant | AccessDenied;

const deny = (reason: DenyReason, deniedFieldGroups: FieldGroupDenial[] = []): AccessDenied => ({
  allowed: false,
  reason,
  deniedFieldGroups,
});

interface ContextRow {
  user_active: boolean;
  company_active: boolean;
  business_date: string;
  assignment_id: string | null;
  scope_kind: ScopeKind | null;
  role_id: string | null;
  role_code: string | null;
  role_active: boolean | null;
  access_class: AccessClass | null;
  linked_employee_id: string | null;
}

interface FieldGroupRow {
  field_group: string;
  granted: boolean;
  classification: 'CONFIDENTIAL' | 'OPERATIONAL';
  own_ess: boolean;
}

/**
 * BRD v8.2 H1/BR-053: only the Employee baseline role, in OWN scope, may use the Employee OWN ESS exception.
 * Other roles never inherit it (DF02 v8.2: the person selects their Employee context for own ESS records).
 */
export const OWN_ESS_ROLE_CODES: readonly string[] = ['EMPLOYEE'];

export async function resolveAccess(db: Queryable, req: AccessRequest): Promise<AccessDecision> {
  if (req.fieldGroups.length === 0) return deny('NO_PERMISSION');
  const at = req.at ?? new Date();

  const ctx = (
    await db.query<ContextRow>(
      `select u.active as user_active,
              c.active as company_active,
              to_char(hrms_business_date(c.id, $4), 'YYYY-MM-DD') as business_date,
              ra.id as assignment_id,
              ra.scope_kind,
              r.id as role_id,
              r.code as role_code,
              r.active as role_active,
              r.access_class,
              (select l.employee_id
                 from user_employee_link l
                where l.company_id = c.id and l.user_id = u.id
                  and l.effective_from <= hrms_business_date(c.id, $4)
                  and (l.effective_to is null or l.effective_to > hrms_business_date(c.id, $4))) as linked_employee_id
         from user_account u
        cross join company c
         left join role_assignment ra
                on ra.id = $3 and ra.company_id = c.id and ra.user_id = u.id
               and ra.state = 'ACTIVE'
               and ra.effective_from <= $4 and (ra.effective_to is null or ra.effective_to > $4)
         left join role r on r.company_id = ra.company_id and r.id = ra.role_id
        where u.id = $1 and c.id = $2`,
      [req.userId, req.companyId, req.assignmentId, at],
    )
  ).rows[0];

  if (!ctx) return deny('UNKNOWN_CONTEXT');
  if (!ctx.user_active) return deny('USER_INACTIVE');
  if (!ctx.company_active) return deny('COMPANY_INACTIVE');
  if (!ctx.assignment_id || !ctx.scope_kind || !ctx.role_id || !ctx.role_code || !ctx.access_class) {
    return deny('ASSIGNMENT_NOT_ACTIVE');
  }
  if (!ctx.role_active) return deny('ROLE_INACTIVE');

  // A missing classification policy means CONFIDENTIAL (BR-043).
  const groups = (
    await db.query<FieldGroupRow>(
      `select g.field_group,
              exists (
                select 1
                  from permission p
                  join role_permission rp
                    on rp.company_id = $1 and rp.role_id = $2 and rp.permission_id = p.id and rp.effect = 'ALLOW'
                  join role_assignment_permission rap
                    on rap.company_id = $1 and rap.role_assignment_id = $3 and rap.permission_id = p.id
                   and rap.active
                   and rap.effective_from <= $4 and (rap.effective_to is null or rap.effective_to > $4)
                 where p.resource = $5 and p.action = $6 and p.field_group = g.field_group
              ) as granted,
              coalesce((
                select cfp.classification
                  from confidential_field_policy cfp
                 where cfp.company_id = $1 and cfp.resource_code = $5 and cfp.field_group = g.field_group
                   and cfp.effective_from <= $7::date and (cfp.effective_to is null or cfp.effective_to > $7::date)
              ), 'CONFIDENTIAL') as classification,
              coalesce((select p.own_ess from permission p where p.resource = $5 and p.action = $6 and p.field_group = g.field_group), false) as own_ess
         from unnest($8::text[]) as g (field_group)`,
      [req.companyId, ctx.role_id, ctx.assignment_id, at, req.resource, req.action, ctx.business_date, [...new Set(req.fieldGroups)]],
    )
  ).rows;

  const eligibleForConfidential = ctx.access_class === 'ADMIN' || ctx.access_class === 'MANAGER';
  // H1: the Employee OWN context may hold catalogued own-ESS groups; OWN row scope keeps them to the own record.
  const ownEssContext = OWN_ESS_ROLE_CODES.includes(ctx.role_code) && ctx.scope_kind === 'OWN';
  const allowedFieldGroups: string[] = [];
  const ownEssFieldGroups: string[] = [];
  const deniedFieldGroups: FieldGroupDenial[] = [];
  for (const g of groups) {
    if (!g.granted) deniedFieldGroups.push({ fieldGroup: g.field_group, reason: 'NO_PERMISSION' });
    else if (g.classification === 'CONFIDENTIAL' && !eligibleForConfidential) {
      if (ownEssContext && g.own_ess) {
        allowedFieldGroups.push(g.field_group);
        ownEssFieldGroups.push(g.field_group);
      } else deniedFieldGroups.push({ fieldGroup: g.field_group, reason: 'CONFIDENTIAL_NOT_ELIGIBLE' });
    } else allowedFieldGroups.push(g.field_group);
  }

  if (allowedFieldGroups.length === 0) {
    const onlyConfidential = deniedFieldGroups.every((d) => d.reason === 'CONFIDENTIAL_NOT_ELIGIBLE');
    return deny(onlyConfidential ? 'CONFIDENTIAL_NOT_ELIGIBLE' : 'NO_PERMISSION', deniedFieldGroups);
  }

  const filterRows = (
    await db.query<{ dimension: 'DEPARTMENT' | 'LOCATION' | 'EMPLOYEE'; value: string }>(
      `select dimension, coalesce(department_id, location_id, employee_id) as value
         from role_scope_filter where company_id = $1 and role_assignment_id = $2`,
      [req.companyId, ctx.assignment_id],
    )
  ).rows;
  const filters: ScopeFilters = { departments: [], locations: [], employees: [] };
  for (const f of filterRows) {
    if (f.dimension === 'DEPARTMENT') filters.departments.push(f.value);
    else if (f.dimension === 'LOCATION') filters.locations.push(f.value);
    else filters.employees.push(f.value);
  }

  return {
    allowed: true,
    userId: req.userId,
    companyId: req.companyId,
    assignmentId: ctx.assignment_id,
    roleCode: ctx.role_code,
    accessClass: ctx.access_class,
    scopeKind: ctx.scope_kind,
    filters,
    allowedFieldGroups,
    ownEssFieldGroups,
    deniedFieldGroups,
    linkedEmployeeId: ctx.linked_employee_id,
    at,
    businessDate: ctx.business_date,
  };
}

/** Collects positional parameters while a SQL fragment is built. */
export class SqlParams {
  readonly values: unknown[];
  constructor(initial: unknown[] = []) {
    this.values = [...initial];
  }
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/**
 * SQL condition: the assignee may still act on approval task `task`. An ordinary task has nothing to check here; a
 * delegated one needs its delegation live and its delegator's authority and scope intact (C1 "When a role or delegation
 * expires, the next data request and decision must fail"; C4 "Delegated task"; ZT05; hrms_delegated_task_live, 0090).
 */
export const taskDelegationLive = (task: string, at = 'now()'): string =>
  `(${task}.delegation_id is null or hrms_delegated_task_live(${task}.company_id, ${task}.id, ${at}))`;

/**
 * SQL `from ... where ...` of the pending approval tasks of active instances that one assignment is itself eligible for
 * (C1 "ASSIGNED via eligible current approval_task"; RBAC instruction "Do not combine..."; CI24): assigned to its user,
 * with the step's permission ALLOWed by its role and active in its own DB109 allowlist, and, for a delegated task, a live
 * delegation. A task routed through another assignment of the same user lends it nothing. Aliases are prefixed so they
 * never capture a caller's column: asg_t task, asg_i instance, asg_bt business transaction. Callers append `and ...` conditions.
 */
export function eligibleTasksOf(refs: { company: string; assignment: string; user: string; at: string }): string {
  return `from approval_task asg_t
       join approval_instance asg_i on asg_i.company_id = asg_t.company_id and asg_i.id = asg_t.instance_id and asg_i.state = 'ACTIVE'
       join business_transaction asg_bt on asg_bt.company_id = asg_i.company_id and asg_bt.id = asg_i.transaction_id
       join workflow_step asg_s on asg_s.company_id = asg_t.company_id and asg_s.id = asg_t.step_id
       join role_assignment asg_ra on asg_ra.company_id = asg_t.company_id and asg_ra.id = ${refs.assignment}
       join role_permission asg_rp on asg_rp.company_id = asg_ra.company_id and asg_rp.role_id = asg_ra.role_id
                                  and asg_rp.permission_id = asg_s.permission_id and asg_rp.effect = 'ALLOW'
       join role_assignment_permission asg_rap on asg_rap.company_id = asg_ra.company_id and asg_rap.role_assignment_id = asg_ra.id
                                              and asg_rap.permission_id = asg_s.permission_id and asg_rap.active
                                              and asg_rap.effective_from <= ${refs.at} and (asg_rap.effective_to is null or asg_rap.effective_to > ${refs.at})
      where asg_t.company_id = ${refs.company} and asg_t.assignee_user_id = ${refs.user} and asg_t.state = 'PENDING'
        and ${taskDelegationLive('asg_t', refs.at)}`;
}

/** eligibleTasksOf for the grant's own assignment; `company` is an already added company parameter. */
export function eligibleTasksOfGrant(grant: AccessGrant, company: string, params: SqlParams): string {
  return eligibleTasksOf({
    company,
    assignment: `${params.add(grant.assignmentId)}::uuid`,
    user: `${params.add(grant.userId)}::uuid`,
    at: `${params.add(grant.at)}::timestamptz`,
  });
}

/**
 * Row-scope predicate over an employee id column. Used identically by detail checks, lists, counts,
 * dashboards and exports so they always see the same record set (BR-026, BR-045).
 * Always includes the tenant guard on `companyColumn`. `withoutDelegatedTasks` leaves out reach that only a delegated task
 * gives, for My Team (DF16 "A delegated reviewer can access only assigned transactions unless an independent team assignment exists").
 */
export function employeeScopePredicate(
  grant: AccessGrant,
  columns: { company: string; employee: string },
  params: SqlParams,
  options: { withoutDelegatedTasks?: boolean } = {},
): string {
  const company = `${params.add(grant.companyId)}::uuid`;
  // Added on first use only: an unreferenced parameter has no inferable type.
  let day: string | undefined;
  const effective = (alias: string) => {
    day ??= `${params.add(grant.businessDate)}::date`;
    return `${alias}.effective_from <= ${day} and (${alias}.effective_to is null or ${alias}.effective_to > ${day})`;
  };
  const parts = [`${columns.company} = ${company}`];

  switch (grant.scopeKind) {
    case 'COMPANY':
      break;
    case 'OWN':
      parts.push(grant.linkedEmployeeId ? `${columns.employee} = ${params.add(grant.linkedEmployeeId)}::uuid` : 'false');
      break;
    case 'TEAM': {
      // DF16: current direct reports only.
      if (!grant.linkedEmployeeId) {
        parts.push('false');
        break;
      }
      const manager = `${params.add(grant.linkedEmployeeId)}::uuid`;
      parts.push(
        `exists (select 1 from manager_assignment ma
                  where ma.company_id = ${company} and ma.employee_id = ${columns.employee}
                    and ma.manager_employee_id = ${manager} and ${effective('ma')})`,
      );
      break;
    }
    case 'ASSIGNED':
      parts.push(`exists (select 1 ${eligibleTasksOfGrant(grant, company, params)} and asg_bt.owner_employee_id = ${columns.employee}${options.withoutDelegatedTasks ? ' and asg_t.delegation_id is null' : ''})`);
      break;
    default:
      parts.push('false');
  }

  const { departments, locations, employees } = grant.filters;
  if (departments.length > 0 || locations.length > 0) {
    const conditions = [];
    if (departments.length > 0) conditions.push(`ea.department_id = any(${params.add(departments)}::uuid[])`);
    if (locations.length > 0) conditions.push(`ea.location_id = any(${params.add(locations)}::uuid[])`);
    parts.push(
      `exists (select 1 from employment_assignment ea
                where ea.company_id = ${company} and ea.employee_id = ${columns.employee}
                  and ${effective('ea')} and ${conditions.join(' and ')})`,
    );
  }
  if (employees.length > 0) parts.push(`${columns.employee} = any(${params.add(employees)}::uuid[])`);

  return `(${parts.join(' and ')})`;
}

/** Single-record row scope check, using the same predicate as lists. */
export async function canAccessEmployee(db: Queryable, grant: AccessGrant, employeeId: string, options: { withoutDelegatedTasks?: boolean } = {}): Promise<boolean> {
  const params = new SqlParams([employeeId]);
  const predicate = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params, options);
  const row = (
    await db.query<{ ok: boolean }>(`select exists (select 1 from employee e where e.id = $1 and ${predicate}) as ok`, params.values)
  ).rows[0];
  return row?.ok === true;
}

/**
 * A task is listed or counted only while its owner is in the grant's current row scope (ZT02, C1 "counts, dashboard
 * totals"; C4 "New list/read access uses current effective assignment"). A transaction owned by no employee has no row
 * to scope. `bt` is the caller's business_transaction alias.
 */
export function taskOwnerInScope(grant: AccessGrant, params: SqlParams, bt = 'bt'): string {
  return `(${bt}.owner_employee_id is null or ${employeeScopePredicate(grant, { company: `${bt}.company_id`, employee: `${bt}.owner_employee_id` }, params)})`;
}

/**
 * C4 self approval; RBAC instruction "Apply all C4 separation-of-duty rules even when a user holds multiple roles"; DF02
 * "Admin status does not bypass these checks": a direct write that benefits the actor's own employee record is refused
 * in every assignment. Own means linked in any period, as the approval decision guard applies it (0002).
 */
export async function assertNotOwnRecord(db: Queryable, grant: AccessGrant, employeeId: string): Promise<void> {
  const own =
    grant.linkedEmployeeId === employeeId ||
    ((await db.query(`select 1 from user_employee_link where company_id = $1 and user_id = $2 and employee_id = $3`, [grant.companyId, grant.userId, employeeId])).rowCount ?? 0) > 0;
  if (own) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot make this change on your own record; another administrator must do it');
}
