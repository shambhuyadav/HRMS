// Shared helpers of the timesheet module: calendar dates, actors, audit, locks and the employee's employment window.
// Everything runs inside the caller's transaction; date arithmetic is on ISO calendar dates (never local time).
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Employee statuses in which time can be recorded and allocated (DF04: employed and activated). */
export const ACTIVE_STATUSES = ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE'] as const;

/** A real calendar date in ISO form (no silent roll-over such as 2026-02-30). */
export const isIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** ISO weekday: 1 = Monday ... 7 = Sunday. */
export const isoWeekday = (d: string): number => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

/** The Monday of the Monday-Sunday week containing `d` (F1 weekly period). */
export const mondayOf = (d: string): string => addDays(d, 1 - isoWeekday(d));

export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export function requireDate(value: string, field: string, code = 'INVALID_DATE'): string {
  if (!isIsoDate(value)) throw new HttpError(422, code, `The ${field} is not a valid date`, { field });
  return value;
}

export interface Actor {
  companyId: string;
  userId: string;
  assignmentId: string | null;
}

export const actorOf = (grant: AccessGrant): Actor => ({ companyId: grant.companyId, userId: grant.userId, assignmentId: grant.assignmentId });

/** Audit entry; every value recorded by this module is operational (registration.ts). */
export async function audit(
  tx: Queryable,
  actor: Actor,
  resource: string,
  recordKey: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  extra: { reason?: string | null; priorVersion?: number | null; newVersion?: number | null } = {},
): Promise<void> {
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource,
    recordKey,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action,
    before: before ? { operational: before } : null,
    after: after ? { operational: after } : null,
    reason: extra.reason ?? null,
    priorVersion: extra.priorVersion ?? null,
    newVersion: extra.newVersion ?? null,
  });
}

/** Serialises work on one key for the rest of the transaction. */
export async function advisoryLock(tx: Queryable, key: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

/** Serialises an employee's allocation changes so the capacity check cannot race (F1 > 100% rule). */
export const lockAllocations = (tx: Queryable, companyId: string, employeeId: string) => advisoryLock(tx, `timesheet_allocation:${companyId}:${employeeId}`);

/** Serialises a missed-submission exception with the employee's submissions (BR-049). */
export const lockEmployeeTimesheets = (tx: Queryable, companyId: string, employeeId: string) => advisoryLock(tx, `timesheet_employee:${companyId}:${employeeId}`);

export interface Employment {
  employeeCode: string;
  status: string;
  joiningDate: string;
  /** Approved last working date (inclusive), or null while no approved exit is in effect. */
  lastWorkingDate: string | null;
}

/** The employee's employment window (DF04: eligibility stops after the approved last working date). */
export async function employmentOf(tx: Queryable, companyId: string, employeeId: string): Promise<Employment | null> {
  const row = (
    await tx.query<{ code: string; status: string; joining_date: string; last_working_date: string | null }>(
      `select e.employee_code as code, st.code as status, to_char(e.joining_date, 'YYYY-MM-DD') as joining_date,
              to_char(hrms_exit_last_working_date(e.company_id, e.id), 'YYYY-MM-DD') as last_working_date
         from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        where e.company_id = $1 and e.id = $2`,
      [companyId, employeeId],
    )
  ).rows[0];
  return row ? { employeeCode: row.code, status: row.status, joiningDate: row.joining_date, lastWorkingDate: row.last_working_date } : null;
}

export const isActiveStatus = (status: string): boolean => (ACTIVE_STATUSES as readonly string[]).includes(status);

/** Within the employment window on `day` (inclusive at both ends). */
export const employedOn = (e: Employment, day: string): boolean => day >= e.joiningDate && (e.lastWorkingDate === null || day <= e.lastWorkingDate);

/** Company-wide reference data (masters) is maintained under unrestricted company scope only. */
export function assertCompanyWide(grant: AccessGrant): void {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) {
    throw new HttpError(403, 'FORBIDDEN', 'Timesheet masters are maintained with company-wide scope');
  }
}

export function ownEmployee(grant: AccessGrant): string {
  if (!grant.linkedEmployeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  return grant.linkedEmployeeId;
}

/** Minutes as exact decimal hours ('7.25'): minutes are whole quarter hours, so two decimals are exact. */
export function hoursOf(minutes: number): string {
  const whole = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${whole}.${String(Math.round((rest * 100) / 60)).padStart(2, '0')}`;
}
