// Shared helpers of the assets module: scope checks, dates, controlled categories and audit records.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, OWN_ESS_ROLE_CODES } from '../access/authorize.js';

/** Employment states in which an employee can receive an item or ask for one (as for other own requests). */
export const ACTIVE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'] as const;

export const CATEGORY_LIST = 'ASSET_CATEGORY';

/** A real calendar date in ISO form (no silent roll-over such as 2026-02-30). */
export const isIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function requireDate(value: string, field: string): string {
  if (!isIsoDate(value)) throw new HttpError(422, 'INVALID_DATE', `The ${field} is not a valid date`, { field });
  return value;
}

/**
 * The register is company property, not employee-scoped, and it shows who holds each item: like organisation
 * masters, it needs an unrestricted company-scope assignment.
 */
export function isCompanyWide(grant: AccessGrant): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0;
}

export function assertCompanyWide(grant: AccessGrant): void {
  if (!isCompanyWide(grant)) throw new HttpError(403, 'FORBIDDEN', 'The asset register needs an unrestricted company-scope assignment');
}

/**
 * The caller's own employee. Own items, acknowledgments and custody requests (H3 TN16) are served only in the
 * Employee OWN context: BR-055 "non-Employee roles must select Employee context for own ESS data".
 */
export function ownEmployee(grant: AccessGrant): string {
  if (!OWN_ESS_ROLE_CODES.includes(grant.roleCode) || grant.scopeKind !== 'OWN' || !grant.linkedEmployeeId) {
    throw new HttpError(403, 'EMPLOYEE_CONTEXT_REQUIRED', 'Select your Employee role to work on your own items');
  }
  return grant.linkedEmployeeId;
}

/** An active category of the company's controlled list (DF04). */
export async function categoryId(db: Queryable, companyId: string, code: string): Promise<string> {
  const row = (
    await db.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = $2 and code = $3`, [companyId, CATEGORY_LIST, code])
  ).rows[0];
  if (!row) throw new HttpError(422, 'INVALID_CATEGORY', 'Unknown or inactive asset category', { field: 'categoryCode' });
  return row.id;
}

export async function listCategories(db: Queryable, companyId: string) {
  const rows = await db.query<{ code: string; label: string }>(
    `select code, label from reference_value_in_force where company_id = $1 and category = $2 order by label, code`,
    [companyId, CATEGORY_LIST],
  );
  return { items: rows.rows };
}

export async function employeeStatus(db: Queryable, companyId: string, employeeId: string): Promise<string | null> {
  return (
    (
      await db.query<{ code: string }>(
        `select st.code from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id where e.company_id = $1 and e.id = $2`,
        [companyId, employeeId],
      )
    ).rows[0]?.code ?? null
  );
}

/** C4 / DF02: whether the user is or was linked to the employee (any period, as the decision guard applies it). */
export async function userIsEmployee(db: Queryable, companyId: string, userId: string, employeeId: string): Promise<boolean> {
  const r = await db.query(`select 1 from user_employee_link where company_id = $1 and user_id = $2 and employee_id = $3`, [companyId, userId, employeeId]);
  return (r.rowCount ?? 0) > 0;
}

export interface Actor {
  companyId: string;
  userId: string;
  assignmentId: string | null;
}

export async function audit(
  tx: Queryable,
  actor: Actor,
  entry: {
    resource: 'asset' | 'asset_custody' | 'asset_request';
    recordKey: string;
    action: string;
    before?: Record<string, unknown> | null;
    after: Record<string, unknown>;
    reason?: string | null;
    priorVersion?: number | null;
    newVersion?: number | null;
  },
): Promise<void> {
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource: entry.resource,
    recordKey: entry.recordKey,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action: entry.action,
    priorVersion: entry.priorVersion ?? null,
    newVersion: entry.newVersion ?? null,
    before: entry.before ? { operational: entry.before } : null,
    after: { operational: entry.after },
    reason: entry.reason ?? null,
  });
}
