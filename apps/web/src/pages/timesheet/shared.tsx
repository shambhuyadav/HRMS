// Shared parts of the timesheet screens: permission keys, paths, query keys, styles and small helpers.

import { type CSSProperties, useMemo, useRef } from 'react';
import { formatDate, idempotencyKey, isForbidden, isNotFound } from '../../api';
import { useSession } from '../../session';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/timesheet/registration.ts, routes.ts; migration 0037) and screen paths
// ---------------------------------------------------------------------------------------------------------
export const MASTER_READ = 'timesheet_master.read.operational';
export const MASTER_MANAGE = 'timesheet_master.manage.operational';
export const ALLOC_READ = 'timesheet_allocation.read.operational';
export const ALLOC_MANAGE = 'timesheet_allocation.manage.operational';
/** POST /v1/timesheet/allocation-imports: with the manage key for the upload and the commit (rows apply under it). */
export const ALLOC_IMPORT = 'timesheet_allocation.import.operational';
export const TS_SUBMIT = 'timesheet.submit.operational';
export const TS_READ = 'timesheet.read.operational';
export const TS_APPROVE = 'timesheet.approve.operational';
export const TS_REQUEST_REOPEN = 'timesheet.request_reopen.operational';
export const TS_REOPEN = 'timesheet.reopen.operational';
export const TS_RESOLVE = 'timesheet.resolve_exception.operational';
export const TS_REPORT = 'timesheet.report.operational';
/** Every /v1/timesheet/line-imports route. */
export const TS_IMPORT = 'timesheet.import.operational';
/** GET /v1/employees: the owner and employee search. */
export const EMPLOYEE_LIST = 'employee.list.operational';

export const PATHS = {
  masters: '/timesheet/masters',
  project: (id: string) => `/timesheet/projects/${id}`,
  job: (id: string) => `/timesheet/jobs/${id}`,
  activity: (id: string) => `/timesheet/activities/${id}`,
  allocations: '/timesheet/allocations',
  allocationImports: '/timesheet/allocation-imports',
  timesheets: '/timesheets',
  lineImports: '/timesheet/line-imports',
  timesheet: (id: string) => `/timesheets/${id}`,
  approvals: '/timesheet/approvals',
  reopens: '/timesheet/reopen-requests',
  missed: '/timesheet/missed',
  reports: '/timesheet/reports',
} as const;

/** What the master routes accept as a code. */
export const CODE = /^\s*[A-Za-z0-9][A-Za-z0-9_-]{0,39}\s*$/;
/** What the allocation routes accept as a percentage (more than 0 and at most 100 is the API's rule). */
export const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;
/** Quarter hours from 15 minutes to 24 hours: what the line routes accept. */
export const QUARTERS = Array.from({ length: 96 }, (_, i) => (i + 1) * 15);
export const SHEET_STATES = ['DRAFT', 'SUBMITTED', 'RETURNED', 'REJECTED', 'APPROVED'] as const;
export const DIMENSIONS = ['employee', 'project', 'job', 'activity', 'period'] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export const DIMENSION_LABEL: Record<Dimension, string> = { employee: 'Employee', project: 'Project', job: 'Job', activity: 'Activity', period: 'Week' };

// ---------------------------------------------------------------------------------------------------------
// Query keys, styles and small helpers
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and an
 * answer given to one assignment (a scoped list, a reviewer's queue) must never be shown under another.
 */
export function useRoleContext(): string {
  const { stored } = useSession();
  return `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
}

export function useKeys() {
  const context = useRoleContext();
  return useMemo(() => {
    const base = ['timesheet', context] as const;
    return {
      masters: [...base, 'masters'] as const,
      projectList: (filter: string) => [...base, 'masters', 'projects', filter] as const,
      project: (id: string) => [...base, 'masters', 'project', id] as const,
      job: (id: string) => [...base, 'masters', 'job', id] as const,
      activityList: (filter: string) => [...base, 'masters', 'activities', filter] as const,
      activity: (id: string) => [...base, 'masters', 'activity', id] as const,
      allocations: [...base, 'allocations'] as const,
      allocationList: (query: string) => [...base, 'allocations', query] as const,
      sheets: [...base, 'sheets'] as const,
      sheetList: (query: string) => [...base, 'sheets', 'list', query] as const,
      sheet: (id: string, revision: number | null) => [...base, 'sheets', 'detail', id, revision ?? 'current'] as const,
      own: [...base, 'own'] as const,
      ownSheets: [...base, 'own', 'sheets'] as const,
      ownAllocations: [...base, 'own', 'allocations'] as const,
      ownReminders: [...base, 'own', 'reminders'] as const,
      ownHistory: [...base, 'own', 'history'] as const,
      tasks: [...base, 'tasks'] as const,
      reopenTasks: [...base, 'reopen-tasks'] as const,
      missed: [...base, 'missed'] as const,
      missedList: (query: string) => [...base, 'missed', query] as const,
      report: (kind: string, query: string) => [...base, 'reports', kind, query] as const,
      employeeSearch: (term: string) => [...base, 'employee-search', term] as const,
    };
  }, [context]);
}
export type Keys = ReturnType<typeof useKeys>;

export const SCROLL: CSSProperties = { overflowX: 'auto' };
export const FLUSH: CSSProperties = { margin: 0 };
export const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
export const SPACED: CSSProperties = { marginTop: '0.75rem' };
export const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', background: 'var(--surface)', resize: 'vertical' };

/** The latest answer, unless the server has since refused it (403/404): what the role may no longer see is not kept. */
export function shown<T>(query: { data: T | undefined; error: unknown }): T | undefined {
  return isForbidden(query.error) || isNotFound(query.error) ? undefined : query.data;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Whole minutes (quarter hours) as hours and minutes, e.g. 450 → 7:30 h. */
export const hm = (minutes: number) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)} h`;
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_MS = 86_400_000;
/** The seven calendar days of the week starting on `monday`. */
export const weekDays = (monday: string) => Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${monday}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10));
/** The Monday of the week holding a calendar day. */
export function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const weekday = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - weekday * DAY_MS).toISOString().slice(0, 10);
}
export const dayLabel = (day: string, i: number) => `${DAY_NAMES[i] ?? ''} ${formatDate(day)}`;
export const weekText = (s: { periodStart: string; periodEnd: string }) => `${formatDate(s.periodStart)} to ${formatDate(s.periodEnd)}`;
export const periodText = (m: { startDate: string; endDate: string | null }) => `${formatDate(m.startDate)} to ${m.endDate ? formatDate(m.endDate) : 'open-ended'}`;
export const activeText = (active: boolean) => (active ? 'Active' : 'Inactive');
export const lateText = (late: boolean | null) => (late === true ? 'Submitted late' : late === false ? 'On time' : '—');
export const ORIGIN_LABEL: Record<string, string> = { INITIAL: 'First entry', RETURNED: 'After a return', REJECTED: 'After a rejection', REOPENED: 'Correction after a reopen' };
export const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', RETURN: 'Returned for changes', REJECT: 'Rejected' };

export function Problem({ text }: { text: string | null }) {
  return text ? (
    <p role="alert" className="error">
      {text}
    </p>
  ) : null;
}

/**
 * The idempotency key of a decision (ZT07). Sending the same decision again after a failure, whose answer may have
 * been lost, carries the same key, so the server answers from what it recorded; any other decision gets a new key.
 */
export function useAttemptKey(prefix: string) {
  const last = useRef<{ signature: string; key: string } | null>(null);
  return useMemo(
    () => ({
      keyFor(signature: string): string {
        if (last.current?.signature !== signature) last.current = { signature, key: idempotencyKey(prefix) };
        return last.current.key;
      },
      clear() {
        last.current = null;
      },
    }),
    [prefix],
  );
}
