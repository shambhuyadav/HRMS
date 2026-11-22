// Shared parts of the outdoor duty and holiday work screens: the request's shape, the role context its query keys carry, whether
// the own record is in the role's scope, and the layout piece these screens have and the shared helpers do not.
import { ApiError } from '../../api';
import { useSession } from '../../session';
import type { Evidence } from './evidence';

export type Kind = 'outdoor_duty' | 'holiday_work';
export const KIND_LABEL: Record<Kind, string> = { outdoor_duty: 'Outdoor duty', holiday_work: 'Work on holiday' };

export interface WorkRequest {
  kind: Kind;
  id: string;
  employeeId?: string;
  employeeCode: string;
  employeeName: string;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  purpose: string;
  state: string;
  version: number;
  /** The supporting documents of the current revision. */
  evidence?: Evidence[];
  predecessorRequestId?: string | null;
}

/**
 * Own records are reachable only where the selected role's scope can include the caller's own record: a team scope
 * covers direct reports only and an assigned scope only the requesters of open tasks (employeeScopePredicate).
 */
export const ownRecordInScope = (scopeKind: string | undefined) => scopeKind === 'OWN' || scopeKind === 'COMPANY';

/** A 404 for one's own record: the role's scope (or its filters) leaves the own record out. */
export const ownRecordNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;

/**
 * The selected company and assignment. The query keys of role-dependent answers carry it (as in confirmation.tsx), so
 * an answer given to one assignment is never shown under another, not even from the cache while the new answer loads.
 */
export function useRoleContext(): string {
  const { stored } = useSession();
  return `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
}

// A layout piece of these screens, as a utility class (shadcn/ui move, 20 Nov 2026).
/** A form opened in a row's cell, under the row's buttons. It reads left to right, though on a phone a cell's values are right-aligned. */
export const CELL_FORM = 'mt-2 text-left';
