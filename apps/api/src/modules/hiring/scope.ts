// Row scope for hiring records (C1/DF02). Hiring records are not employee records, so the selected assignment's
// scope is applied to what each record is about:
//   requisition – COMPANY: every requisition; TEAM: the manager's own (as requester or hiring manager) and those
//                 raised by current direct reports; OWN: the caller's own; ASSIGNED: those with a pending task the
//                 selected assignment itself is eligible for (C1, CI24). Department/location filters apply to the
//                 requisition's department/location, employee filters to its requester or hiring manager (values OR
//                 within a dimension, dimensions AND).
//   candidate   – an unrestricted COMPANY assignment sees the whole register; a filtered COMPANY assignment sees
//                 candidates without applications (the open talent register) and those with an application to an
//                 in-scope requisition; other scopes see only candidates applying to in-scope requisitions.
//   budget      – COMPANY scope with department/location filters; pending reviewers through ASSIGNED.
// Anything outside scope reads as not found, exactly like a missing id.
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, eligibleTasksOfGrant, resolveAccess, SqlParams } from '../access/authorize.js';

const unrestricted = (g: AccessGrant) => g.scopeKind === 'COMPANY' && g.filters.departments.length + g.filters.locations.length + g.filters.employees.length === 0;

export function requisitionScope(grant: AccessGrant, r: string, params: SqlParams): string {
  const company = `${params.add(grant.companyId)}::uuid`;
  const parts = [`${r}.company_id = ${company}`];
  // Added only where referenced: an unreferenced parameter has no inferable type.
  const self = () => (grant.linkedEmployeeId ? `${params.add(grant.linkedEmployeeId)}::uuid` : null);
  switch (grant.scopeKind) {
    case 'COMPANY':
      break;
    case 'OWN': {
      const me = self();
      parts.push(me ? `(${r}.requesting_employee_id = ${me} or ${r}.hiring_manager_id = ${me})` : 'false');
      break;
    }
    case 'TEAM': {
      const me = self();
      if (!me) {
        parts.push('false');
        break;
      }
      const day = `${params.add(grant.businessDate)}::date`;
      parts.push(
        `(${r}.requesting_employee_id = ${me} or ${r}.hiring_manager_id = ${me}
          or exists (select 1 from manager_assignment ma
                      where ma.company_id = ${r}.company_id and ma.employee_id = ${r}.requesting_employee_id and ma.manager_employee_id = ${me}
                        and ma.effective_from <= ${day} and (ma.effective_to is null or ma.effective_to > ${day})))`,
      );
      break;
    }
    case 'ASSIGNED':
      parts.push(`exists (select 1 ${eligibleTasksOfGrant(grant, company, params)} and asg_i.transaction_id = ${r}.transaction_id)`);
      break;
    default:
      parts.push('false');
  }
  const { departments, locations, employees } = grant.filters;
  if (departments.length > 0) parts.push(`${r}.department_id = any(${params.add(departments)}::uuid[])`);
  if (locations.length > 0) parts.push(`${r}.location_id = any(${params.add(locations)}::uuid[])`);
  if (employees.length > 0) {
    const e = params.add(employees);
    parts.push(`(${r}.requesting_employee_id = any(${e}::uuid[]) or ${r}.hiring_manager_id = any(${e}::uuid[]))`);
  }
  return `(${parts.join(' and ')})`;
}

export function candidateScope(grant: AccessGrant, c: string, params: SqlParams): string {
  const company = `${params.add(grant.companyId)}::uuid`;
  if (unrestricted(grant)) return `(${c}.company_id = ${company})`;
  const inScope = `exists (select 1 from application sa join requisition sr on sr.company_id = sa.company_id and sr.id = sa.requisition_id
                            where sa.company_id = ${c}.company_id and sa.candidate_id = ${c}.id and ${requisitionScope(grant, 'sr', params)})`;
  const openRegister =
    grant.scopeKind === 'COMPANY' && grant.filters.employees.length === 0
      ? ` or not exists (select 1 from application sx where sx.company_id = ${c}.company_id and sx.candidate_id = ${c}.id)`
      : '';
  return `(${c}.company_id = ${company} and (${inScope}${openRegister}))`;
}

export function budgetScope(grant: AccessGrant, b: string, params: SqlParams): string {
  const company = `${params.add(grant.companyId)}::uuid`;
  const parts = [`${b}.company_id = ${company}`];
  if (grant.scopeKind === 'ASSIGNED') {
    parts.push(
      `exists (select 1 ${eligibleTasksOfGrant(grant, company, params)}
                  and exists (select 1 from manpower_budget_revision br
                               where br.company_id = asg_i.company_id and br.transaction_id = asg_i.transaction_id and br.budget_id = ${b}.id))`,
    );
  } else if (grant.scopeKind !== 'COMPANY') {
    parts.push('false');
  }
  const { departments, locations, employees } = grant.filters;
  if (employees.length > 0) parts.push('false'); // budgets are not any employee's record
  if (departments.length > 0) parts.push(`${b}.department_id = any(${params.add(departments)}::uuid[])`);
  if (locations.length > 0) parts.push(`${b}.location_id = any(${params.add(locations)}::uuid[])`);
  return `(${parts.join(' and ')})`;
}

const exists = async (db: Queryable, sql: string, params: SqlParams) => (await db.query<{ ok: boolean }>(`select exists (${sql}) as ok`, params.values)).rows[0]?.ok === true;

export async function canAccessRequisition(db: Queryable, grant: AccessGrant, requisitionId: string): Promise<boolean> {
  const p = new SqlParams([requisitionId]);
  return exists(db, `select 1 from requisition r where r.id = $1 and ${requisitionScope(grant, 'r', p)}`, p);
}

export async function canAccessCandidate(db: Queryable, grant: AccessGrant, candidateId: string): Promise<boolean> {
  const p = new SqlParams([candidateId]);
  return exists(db, `select 1 from candidate c where c.id = $1 and ${candidateScope(grant, 'c', p)}`, p);
}

export async function canAccessBudget(db: Queryable, grant: AccessGrant, budgetId: string): Promise<boolean> {
  const p = new SqlParams([budgetId]);
  return exists(db, `select 1 from manpower_budget b where b.id = $1 and ${budgetScope(grant, 'b', p)}`, p);
}

/**
 * Whether a new or edited record with these values would be inside the caller's scope (creation never places a
 * record where its creator could not see it).
 */
export function admitsRequisition(grant: AccessGrant, values: { requesterId: string; hiringManagerId: string; departmentId: string; locationId: string }): boolean {
  const { departments, locations, employees } = grant.filters;
  if (departments.length > 0 && !departments.includes(values.departmentId)) return false;
  if (locations.length > 0 && !locations.includes(values.locationId)) return false;
  if (employees.length > 0 && !employees.includes(values.requesterId) && !employees.includes(values.hiringManagerId)) return false;
  switch (grant.scopeKind) {
    case 'COMPANY':
      return true;
    case 'OWN':
    case 'TEAM':
      return grant.linkedEmployeeId === values.requesterId;
    default:
      return false;
  }
}

export function admitsBudget(grant: AccessGrant, values: { departmentId: string; locationId: string }): boolean {
  const { departments, locations, employees } = grant.filters;
  return (
    grant.scopeKind === 'COMPANY' &&
    employees.length === 0 &&
    (departments.length === 0 || departments.includes(values.departmentId)) &&
    (locations.length === 0 || locations.includes(values.locationId))
  );
}

/** Company-wide masters (vendors) need an unrestricted company-scope assignment, as organisation masters do. */
export const isUnrestricted = unrestricted;

// ---------------------------------------------------------------------------------------------------------
// Reviewer routing within scope (DF03 "a scoped HR Administrator"; decision I-25: no task is ever assigned to
// someone who could not open it). The engine checks a reviewer's row scope over the transaction's employee; offers
// and budget revisions have none, and a requisition is scoped by its own department and location, so the hiring
// module also routes around reviewers who could not open the record.
// ---------------------------------------------------------------------------------------------------------

export interface StepPermission {
  resource: string;
  action: string;
  fieldGroup: string;
}

/**
 * Whether the user could open a hiring record from one of their own active assignments that holds the step
 * permission. Assigned scope covers the record (the task itself confers it), with its filters still applied; own
 * scope never reviews (I-25).
 */
export async function couldReview(db: Queryable, companyId: string, userId: string, permission: StepPermission, opens: (grant: AccessGrant) => Promise<boolean>): Promise<boolean> {
  const assignments = (
    await db.query<{ id: string }>(
      `select id from role_assignment where company_id = $1 and user_id = $2 and state = 'ACTIVE'
          and effective_from <= now() and (effective_to is null or effective_to > now()) order by id`,
      [companyId, userId],
    )
  ).rows;
  for (const a of assignments) {
    const decision = await resolveAccess(db, { userId, companyId, assignmentId: a.id, resource: permission.resource, action: permission.action, fieldGroups: [permission.fieldGroup] });
    if (!decision.allowed || !decision.allowedFieldGroups.includes(permission.fieldGroup) || decision.scopeKind === 'OWN') continue;
    if (await opens(decision.scopeKind === 'ASSIGNED' ? { ...decision, scopeKind: 'COMPANY' } : decision)) return true;
  }
  return false;
}

/** The permission of the first step of the kind's active workflow (the step a submission routes), if configured. */
async function firstStepPermission(db: Queryable, companyId: string, kind: string): Promise<StepPermission | null> {
  return (
    (
      await db.query<StepPermission>(
        `select p.resource, p.action, p.field_group as "fieldGroup"
           from workflow_definition w
           join workflow_step s on s.company_id = w.company_id and s.workflow_id = w.id and s.condition_code is null
           join permission p on p.id = s.permission_id
          where w.company_id = $1 and w.kind = $2 and w.active and w.effective_from <= now() and (w.effective_to is null or w.effective_to > now())
          order by s.sequence limit 1`,
        [companyId, kind],
      )
    ).rows[0] ?? null
  );
}

/**
 * The kind's listed fallback reviewers, plus any other candidates (a direct manager), who could not open the record
 * with the first step's permission. A submission excludes them, so the engine routes to the next one in scope or,
 * with nobody left, refuses with NO_ELIGIBLE_REVIEWER.
 */
export async function reviewersOutsideScope(
  db: Queryable,
  companyId: string,
  kind: string,
  opens: (grant: AccessGrant) => Promise<boolean>,
  others: readonly string[] = [],
): Promise<string[]> {
  const permission = await firstStepPermission(db, companyId, kind);
  if (!permission) return []; // the submission itself reports the missing workflow
  const listed = (
    await db.query<{ user_id: string }>(
      `select user_id from workflow_fallback_reviewer
        where company_id = $1 and active and kind = (select coalesce(routing_kind, kind) from transaction_kind where kind = $2)`,
      [companyId, kind],
    )
  ).rows.map((r) => r.user_id);
  const outside: string[] = [];
  for (const userId of new Set([...listed, ...others])) {
    if (!(await couldReview(db, companyId, userId, permission, opens))) outside.push(userId);
  }
  return outside;
}
