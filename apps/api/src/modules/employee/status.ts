// The EMPLOYEE_STATUS catalogue (FR-006 "Define allowed transitions during design"; CI15; DF04; DF08) and how a status change
// tells the database what it is (0101). The trigger on employee writes the history row, so every change has one; this module
// supplies its effective date and source, and the services refuse a transition the catalogue does not allow.
//
//   DRAFT               -> ACTIVE_PROBATION (activation), ARCHIVED (a draft who never joined; kept on record, DF08)
//   ACTIVE_PROBATION    -> ACTIVE_CONFIRMED (confirmation decision), NOTICE (approved exit), INACTIVE_SEPARATED (separation job)
//   ACTIVE_CONFIRMED    -> NOTICE, INACTIVE_SEPARATED
//   NOTICE              -> the status before notice (approved withdrawal), INACTIVE_SEPARATED
//   INACTIVE_SEPARATED  -> ARCHIVED (no route yet: archiving waits for an approved retention schedule, DF08)
//   ARCHIVED            -> nothing; a rehire is a new employment linked to the prior one (DF04)
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';

export const EMPLOYEE_STATUS_TRANSITIONS: Readonly<Record<string, readonly string[]>> = {
  DRAFT: ['ACTIVE_PROBATION', 'ARCHIVED'],
  ACTIVE_PROBATION: ['ACTIVE_CONFIRMED', 'NOTICE', 'INACTIVE_SEPARATED'],
  ACTIVE_CONFIRMED: ['NOTICE', 'INACTIVE_SEPARATED'],
  NOTICE: ['ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'INACTIVE_SEPARATED'],
  INACTIVE_SEPARATED: ['ARCHIVED'],
  ARCHIVED: [],
};

export function assertStatusTransition(from: string, to: string): void {
  if (!EMPLOYEE_STATUS_TRANSITIONS[from]?.includes(to)) {
    throw new HttpError(409, 'INVALID_STATUS_TRANSITION', `An employee cannot move from ${from} to ${to}`, { from, to });
  }
}

export type StatusSourceKind = 'ACTIVATION' | 'CONFIRMATION' | 'EXIT_APPROVED' | 'EXIT_WITHDRAWN' | 'SEPARATION' | 'DRAFT_CLOSED';

export interface StatusSource {
  kind: StatusSourceKind;
  /** The business date the status applies from. */
  effectiveDate: string;
  /** The record behind the change (exit case, confirmation case), when there is one. */
  sourceId?: string | null | undefined;
}

/** Runs the statement that writes employee.status_id with its source in place (transaction-local, as is the rollback). */
export async function withStatusSource<T>(tx: Queryable, source: StatusSource, write: () => Promise<T>): Promise<T> {
  const value = JSON.stringify({ kind: source.kind, effectiveDate: source.effectiveDate, sourceId: source.sourceId ?? null });
  await tx.query(`select set_config('hrms.employee_status_source', $1, true)`, [value]);
  const result = await write();
  await tx.query(`select set_config('hrms.employee_status_source', '', true)`);
  return result;
}
