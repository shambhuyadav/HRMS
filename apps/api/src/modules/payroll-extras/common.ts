// Shared helpers of the payroll-extras module (batch R3; see registration.ts).
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';

/** The module key in modules/registry.ts. */
export const MODULE_KEY = 'payroll-extras';

export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
export const FISCAL_YEAR = /^(\d{4})-(\d{2})$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A valid calendar date written YYYY-MM-DD. */
export function isIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** The last day of a month (YYYY-MM). */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** A financial year label (2026-27): its first and last day, or null when the label is not one. */
export function fiscalYearBounds(label: string): { from: string; to: string; startYear: number } | null {
  const m = FISCAL_YEAR.exec(label);
  if (!m || (Number(m[1]) + 1) % 100 !== Number(m[2])) return null;
  const y = Number(m[1]);
  return { from: `${y}-04-01`, to: `${y + 1}-03-31`, startYear: y };
}

export function requireFiscalYear(label: string): { from: string; to: string; startYear: number } {
  const b = fiscalYearBounds(label);
  if (!b) throw new HttpError(422, 'INVALID_FISCAL_YEAR', 'A financial year looks like 2026-27');
  return b;
}

/** The financial year (1 April to 31 March) a month (YYYY-MM) belongs to. */
export function fiscalYearOfMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const start = Number(month.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * An unrestricted company-scope assignment without denied scopes (as statutory-files/formats.ts companyWide): company records and
 * company figures need one. A scoped DENY of the same permission on another assignment of the user (C1) takes rows out of the grant,
 * so company figures would no longer be whole.
 */
export function isCompanyWide(grant: Pick<AccessGrant, 'scopeKind' | 'filters' | 'deniedScopes'>): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0 && grant.deniedScopes.length === 0;
}

export function requireCompanyWide(grant: AccessGrant): void {
  if (!isCompanyWide(grant)) throw new HttpError(403, 'COMPANY_SCOPE_REQUIRED', 'This needs an assignment with unrestricted company scope');
}

/**
 * C4: whether the user is or was, in any period, linked (user_employee_link) to anyone with a record in the payroll run, whatever its
 * calculation status. Company figures of the run (the salary JV) would hold that person's pay, so someone else prepares them.
 */
export async function linkedToRun(db: Queryable, companyId: string, userId: string, runId: string): Promise<boolean> {
  return (
    (
      await db.query<{ hit: boolean }>(
        `select exists (select 1 from user_employee_link l join payroll_record r on r.company_id = l.company_id and r.employee_id = l.employee_id and r.run_id = $3
                         where l.company_id = $1 and l.user_id = $2) as hit`,
        [companyId, userId, runId],
      )
    ).rows[0]?.hit === true
  );
}

/**
 * C4, as statutory-files/service.ts linkedInQuarter: whether any employee the user is or was linked to was paid between the two days, by
 * processed payroll (a PROCESSED_LOCKED run starting in them) or a paid final settlement (leaving in them). The Form 24Q working data
 * leaves one's own record out, so company totals over such a period would be short.
 */
export async function linkedAndPaidBetween(db: Queryable, companyId: string, userId: string, from: string, to: string): Promise<boolean> {
  return (
    (
      await db.query<{ hit: boolean }>(
        `select exists (
           select 1 from user_employee_link l
            where l.company_id = $1 and l.user_id = $2
              and (exists (select 1 from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
                            where r.company_id = $1 and r.employee_id = l.employee_id and ru.state = 'PROCESSED_LOCKED' and ru.service_start between $3::date and $4::date)
                   or exists (select 1 from settlement s join exit_case x on x.company_id = s.company_id and x.id = s.exit_case_id
                               where s.company_id = $1 and s.employee_id = l.employee_id and s.state = 'PAID' and x.approved_leaving_date between $3::date and $4::date))) as hit`,
        [companyId, userId, from, to],
      )
    ).rows[0]?.hit === true
  );
}

/** One audit record of the module, under the acting assignment (FR-057). */
export async function auditChange(
  tx: Queryable,
  grant: AccessGrant,
  e: { resource: string; recordKey: string; action: string; after?: Record<string, unknown> | null; before?: Record<string, unknown> | null; reason?: string | null; newVersion?: number; priorVersion?: number },
): Promise<void> {
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: e.resource,
    recordKey: e.recordKey,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: e.action,
    before: e.before ?? null,
    after: e.after ?? null,
    reason: e.reason ?? null,
    ...(e.newVersion !== undefined ? { newVersion: e.newVersion } : {}),
    ...(e.priorVersion !== undefined ? { priorVersion: e.priorVersion } : {}),
  });
}

/** Trimmed required text of at most `max` characters, else 422 with the field named. */
export function requireText(value: unknown, field: string, max: number): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s === '' || s.length > max) throw new HttpError(422, 'INVALID_VALUE', `${field} is required (at most ${max} characters)`, { field });
  return s;
}

/** Optional trimmed text: null when blank. */
export function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  const s = typeof value === 'string' ? value.trim() : '';
  if (s === '') return null;
  if (s.length > max) throw new HttpError(422, 'INVALID_VALUE', `${field} is at most ${max} characters`, { field });
  return s;
}

/** A positive or zero amount with at most two decimals, written plainly. */
export const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;
