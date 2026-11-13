// Timesheets (FR-045 to FR-048; F1 "Timesheets"; BR-048; BR-049; DF02; DF03; C4; H3 TN13; decision I-30).
//
// Masters (FR-045): company-wide projects, jobs (each in exactly one project, fixed at creation) and a reusable activity
// catalogue whose activities a job permits through approved job-activity links. Each master has an owner, an inclusive
// validity period and an active flag; codes never change and nothing is deleted. Each activity carries a required
// productive flag with no default.
// Allocations (FR-046): an employee's share of daily capacity on a job for an interval. Overlapping jobs may total
// 100%; above that only the employee's current direct manager records an exception with a reason (the API decides).
// Timesheets (FR-047): one per employee and Monday-Sunday week, entered in quarter hours from the employee's own active
// allocations, at most 24 hours a day (the API enforces it and its duplicate rule; its refusals are shown). Submission
// is due by the following Monday; a later one is accepted and flagged late. The direct manager approves, returns or
// rejects (a reason for the last two); the employee continues in a new revision. An approved timesheet is corrected
// only after an independent reopen decision: the correction is a new revision and every revision stays on record.
// Missed weeks raise a reminder, never a penalty (BR-049). Reports (FR-048) count approved time in force only;
// utilisation is shown exactly as the API returns it, including N/A and not configured.
// Imports (FR-046 bulk upload; FR-047 imported entries; DF09; FR-106): allocation and timesheet-line CSV batches are
// uploaded, previewed row by row and then committed or cancelled, all or nothing (the job view of records.tsx). A file
// the malware scan has not released is held unread; checking it again resumes the batch from its stored file, and the
// user's own batches are listed, so a held batch can be opened again after leaving the page.
// The server authorises every call and decides every rule; these screens hide what the selected assignment cannot use,
// show only what the server returned and say its refusals in plain words. Every timesheet field group is operational.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError, fileToBase64, formatDate, idempotencyKey, localDate, pinSession } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section, StateBadge } from '../ui';
import { DelegatedBadge } from './delegations';
import { OwnLaterAdjustments } from './payroll-adjustments';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from './records';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/timesheet/registration.ts, routes.ts; migration 0037) and screen paths
// ---------------------------------------------------------------------------------------------------------
const MASTER_READ = 'timesheet_master.read.operational';
const MASTER_MANAGE = 'timesheet_master.manage.operational';
const ALLOC_READ = 'timesheet_allocation.read.operational';
const ALLOC_MANAGE = 'timesheet_allocation.manage.operational';
/** POST /v1/timesheet/allocation-imports: with the manage key for the upload and the commit (rows apply under it). */
const ALLOC_IMPORT = 'timesheet_allocation.import.operational';
const TS_SUBMIT = 'timesheet.submit.operational';
const TS_READ = 'timesheet.read.operational';
const TS_APPROVE = 'timesheet.approve.operational';
const TS_REQUEST_REOPEN = 'timesheet.request_reopen.operational';
const TS_REOPEN = 'timesheet.reopen.operational';
const TS_RESOLVE = 'timesheet.resolve_exception.operational';
const TS_REPORT = 'timesheet.report.operational';
/** Every /v1/timesheet/line-imports route. */
const TS_IMPORT = 'timesheet.import.operational';
/** GET /v1/employees: the owner and employee search. */
const EMPLOYEE_LIST = 'employee.list.operational';

const PATHS = {
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
const CODE = /^\s*[A-Za-z0-9][A-Za-z0-9_-]{0,39}\s*$/;
/** What the allocation routes accept as a percentage (more than 0 and at most 100 is the API's rule). */
const PERCENT = /^\d{1,3}(\.\d{1,2})?$/;
/** Quarter hours from 15 minutes to 24 hours: what the line routes accept. */
const QUARTERS = Array.from({ length: 96 }, (_, i) => (i + 1) * 15);
const SHEET_STATES = ['DRAFT', 'SUBMITTED', 'RETURNED', 'REJECTED', 'APPROVED'] as const;
const DIMENSIONS = ['employee', 'project', 'job', 'activity', 'period'] as const;
type Dimension = (typeof DIMENSIONS)[number];
const DIMENSION_LABEL: Record<Dimension, string> = { employee: 'Employee', project: 'Project', job: 'Job', activity: 'Activity', period: 'Week' };

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/timesheet/masters.ts, allocations.ts, sheets.ts, reopen.ts, exceptions.ts, reports.ts)
// ---------------------------------------------------------------------------------------------------------
interface Master {
  id: string;
  code: string;
  name: string;
  ownerEmployeeId: string;
  ownerEmployeeCode: string;
  ownerName: string;
  startDate: string;
  endDate: string | null;
  active: boolean;
  version: number;
}
interface Project extends Master {
  jobCount?: number;
}
interface JobActivityLink {
  activityId: string;
  code: string;
  name: string;
  productive: boolean;
  activityActive: boolean;
  linkActive: boolean;
}
interface Job extends Master {
  projectId: string;
  projectCode?: string;
  projectName?: string;
  activities: JobActivityLink[];
}
interface ProjectDetail extends Master {
  jobs: Job[];
}
interface Activity extends Master {
  productive: boolean;
}
type MasterKind = 'project' | 'job' | 'activity';

interface Allocation {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  startDate: string;
  endDate: string;
  allocationPercent: string;
  state: string;
  source: string;
  overAllocation: { reason: string; peakPercent: string; managerEmployeeId: string; recordedAt: string } | null;
  cancelReason: string | null;
  cancelledAt: string | null;
  version: number;
}
/** GET /v1/me/timesheet-allocations: the own active allocations with the activities each job permits now. */
interface OwnAllocation {
  id: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  startDate: string;
  endDate: string;
  allocationPercent: string;
  activities: { activityId: string; code: string; name: string }[];
}

interface SheetSummary {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  state: string;
  currentRevision: number;
  approvedRevision: number | null;
  firstSubmittedAt: string | null;
  late: boolean | null;
  version: number;
  totalMinutes: number;
  approvedMinutes: number;
}
interface Revision {
  revision: number;
  origin: string;
  previousRevision: number | null;
  reopenRequestId: string | null;
  state: string;
  submittedAt: string | null;
  submittedOn: string | null;
  late: boolean | null;
  decidedAt: string | null;
  decisionReason: string | null;
  supersededAt: string | null;
  supersededByRevision: number | null;
  lineCount: number;
  totalMinutes: number;
}
interface Line {
  id: string;
  workDate: string;
  projectId: string;
  projectCode: string;
  projectName: string;
  jobId: string;
  jobCode: string;
  jobName: string;
  activityId: string;
  activityCode: string;
  activityName: string;
  minutes: number;
  productive: boolean;
  note: string | null;
  source: string;
  version: number;
}
interface ReopenRequest {
  id: string;
  approvedRevision: number;
  reason: string;
  state: string;
  newRevision: number | null;
  requestedAt: string;
  decidedAt: string | null;
}
interface SheetDetail extends Omit<SheetSummary, 'totalMinutes' | 'approvedMinutes'> {
  shownRevision: number;
  revisions: Revision[];
  lines: Line[];
  dailyTotals: { workDate: string; minutes: number; hours: string }[];
  totalMinutes: number;
  pendingWith: string | null;
  decisions: { revision: number; decision: string; decidedAt: string }[];
  reopenRequests: ReopenRequest[];
}
interface TimesheetTask {
  taskId: string;
  assignedAt: string;
  timesheet: (SheetSummary & { revisionLate: boolean | null }) | null;
}
interface TimesheetDecided {
  timesheetId: string;
  revision: number;
  state: string;
  replayed: boolean;
}
interface ReopenTask {
  taskId: string;
  assignedAt: string;
  request: {
    id: string;
    timesheetId: string;
    employeeCode: string;
    employeeName: string;
    periodStart: string;
    periodEnd: string;
    approvedRevision: number;
    reason: string;
    requestedAt: string;
  } | null;
}
interface ReopenDecided {
  reopenRequestId: string;
  state: string;
  newRevision?: number | null;
  replayed: boolean;
}
interface MissedWeek {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  periodStart: string;
  periodEnd: string;
  dueDate: string;
  raisedOn: string;
  state: string;
  resolution: string | null;
  resolutionReason: string | null;
  timesheetId: string | null;
  resolvedAt: string | null;
  version: number;
}
interface OwnRequest {
  transactionId: string;
  state: string;
  pendingWith: string | null;
  createdAt: string;
  decisions: { step: number; decision: string; decidedAt: string }[];
}
interface Measures {
  minutes: number;
  hours: string;
  productiveMinutes: number;
  lineCount: number;
}
type HoursGroup = Measures & Partial<Record<string, string | number | null>>;
interface HoursReport {
  from: string;
  to: string;
  basis: string;
  groupBy: Dimension[];
  groups: HoursGroup[];
  /** FR-056: every group of the report, whatever page is shown. */
  totalGroups?: number;
  totals: Measures;
}
interface ReportLine {
  id: string;
  timesheetId: string;
  revision: number;
  employeeCode: string;
  workDate: string;
  periodStart: string;
  projectCode: string;
  jobCode: string;
  activityCode: string;
  minutes: number;
  productive: boolean;
}
interface UtilisationItem {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  approvedMinutes: number;
  productiveMinutes: number;
  status: 'OK' | 'NOT_APPLICABLE' | 'NOT_CONFIGURED';
  scheduledMinutes: number | null;
  utilisationPercent: string | null;
  display?: string;
  message?: string;
  unscheduledDays?: number;
}
interface UtilisationReport {
  from: string;
  to: string;
  formula: string;
  scheduleBasis: string;
  items: UtilisationItem[];
  /** FR-056: every employee in scope, and totals over all of them (not only this page). */
  total?: number;
  totals?: { employees: number; byStatus: Record<string, number>; approvedMinutes: number; productiveMinutes: number; scheduledMinutes: number | null };
}
interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
}

// ---------------------------------------------------------------------------------------------------------
// Query keys, styles and small helpers
// ---------------------------------------------------------------------------------------------------------

/**
 * Query keys carry the selected company and assignment: the app keeps one query cache across role switches, and an
 * answer given to one assignment (a scoped list, a reviewer's queue) must never be shown under another.
 */
function useRoleContext(): string {
  const { stored } = useSession();
  return `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
}

function useKeys() {
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
type Keys = ReturnType<typeof useKeys>;

const SCROLL: CSSProperties = { overflowX: 'auto' };
const FLUSH: CSSProperties = { margin: 0 };
const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
const SPACED: CSSProperties = { marginTop: '0.75rem' };
const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', background: 'var(--surface)', resize: 'vertical' };

const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
const isNotFound = (error: unknown) => error instanceof ApiError && error.status === 404;
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;

/** The latest answer, unless the server has since refused it (403/404): what the role may no longer see is not kept. */
function shown<T>(query: { data: T | undefined; error: unknown }): T | undefined {
  return isForbidden(query.error) || isNotFound(query.error) ? undefined : query.data;
}

function readable(code: string): string {
  const text = code.replace(/_/g, ' ').toLowerCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Whole minutes (quarter hours) as hours and minutes, e.g. 450 → 7:30 h. */
const hm = (minutes: number) => `${Math.floor(minutes / 60)}:${pad(minutes % 60)} h`;
/** An instant shown as the viewer's local date and time. */
function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${formatDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function When({ at }: { at: string | null | undefined }) {
  return at ? <time dateTime={at}>{localDateTime(at)}</time> : <>—</>;
}
const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_MS = 86_400_000;
/** The seven calendar days of the week starting on `monday`. */
const weekDays = (monday: string) => Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${monday}T00:00:00Z`) + i * DAY_MS).toISOString().slice(0, 10));
/** The Monday of the week holding a calendar day. */
function mondayOf(day: string): string {
  const t = Date.parse(`${day}T00:00:00Z`);
  const weekday = (new Date(t).getUTCDay() + 6) % 7;
  return new Date(t - weekday * DAY_MS).toISOString().slice(0, 10);
}
const dayLabel = (day: string, i: number) => `${DAY_NAMES[i] ?? ''} ${formatDate(day)}`;
const weekText = (s: { periodStart: string; periodEnd: string }) => `${formatDate(s.periodStart)} to ${formatDate(s.periodEnd)}`;
const periodText = (m: { startDate: string; endDate: string | null }) => `${formatDate(m.startDate)} to ${m.endDate ? formatDate(m.endDate) : 'open-ended'}`;
const activeText = (active: boolean) => (active ? 'Active' : 'Inactive');
const lateText = (late: boolean | null) => (late === true ? 'Submitted late' : late === false ? 'On time' : '—');
const ORIGIN_LABEL: Record<string, string> = { INITIAL: 'First entry', RETURNED: 'After a return', REJECTED: 'After a rejection', REOPENED: 'Correction after a reopen' };
const DECISION_LABEL: Record<string, string> = { APPROVE: 'Approved', RETURN: 'Returned for changes', REJECT: 'Rejected' };

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

function Notice({ notice }: { notice: { text: string; ok: boolean } | null }) {
  if (!notice) return null;
  return (
    <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
      {notice.text}
    </p>
  );
}

function Problem({ text }: { text: string | null }) {
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
function useAttemptKey(prefix: string) {
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

// ---------------------------------------------------------------------------------------------------------
// The API's refusals in plain words
// ---------------------------------------------------------------------------------------------------------
type Act = 'master' | 'allocation' | 'week' | 'line' | 'submit' | 'revise' | 'decide' | 'reopen-request' | 'reopen-decide' | 'resolve' | 'report' | 'read';

const PLAIN: Record<string, string> = {
  EMPLOYEE_CONTEXT_REQUIRED: 'Your own timesheets are kept in your Employee role. Select your Employee role to work on them.',
  CODE_EXISTS: 'That code is already used. Codes never change, so choose another code.',
  INVALID_OWNER: 'The owner must be an employee of this company.',
  INVALID_PERCENT: 'The allocation must be more than 0% and at most 100%, with up to two decimals.',
  UNKNOWN_JOB: 'That job does not exist in this company.',
  UNKNOWN_ACTIVITY: 'That activity does not exist in this company.',
  INACTIVE_MASTER: 'The project, job or activity is not active.',
  INVALID_PROJECT_DATES: 'The allocation must lie within the job’s and the project’s validity periods.',
  EXCEPTION_NOT_NEEDED: 'The allocation stays within 100%, so no over-allocation exception is recorded. Clear the exception reason and save again.',
  MANAGER_EXCEPTION_REQUIRED: 'Only the employee’s current direct manager can record an over-allocation exception.',
  EMPLOYEE_NOT_ACTIVE: 'Only an active employee can be allocated or record time.',
  OUTSIDE_EMPLOYMENT: 'The dates are outside the employment (joining date to last working date).',
  DUPLICATE_ALLOCATION: 'The employee is already allocated to this job for an overlapping interval.',
  PERIOD_IN_FUTURE: 'Time is recorded only for a week that has already started.',
  TIMESHEET_EXISTS: 'You already have a timesheet for this week. It is opened below.',
  TIMESHEET_NOT_EDITABLE: 'Only a draft revision can be changed. An approved timesheet is corrected through a reopen request.',
  INVALID_DATE: 'The date is not a valid calendar date.',
  OUTSIDE_PERIOD: 'The work date is outside this timesheet’s week.',
  WORK_DATE_IN_FUTURE: 'Time is recorded only for days already worked.',
  INVALID_MINUTES: 'Time is recorded in quarter hours (steps of 15 minutes), at most 24 hours.',
  MASTER_OUT_OF_PERIOD: 'The project, job or activity is not valid on the work date.',
  ACTIVITY_NOT_PERMITTED: 'The job does not permit this activity.',
  NO_ACTIVE_ALLOCATION: 'You are not allocated to this job on the work date.',
  DUPLICATE_LINE: 'There is already a line for this day, job and activity. Change the time of that line instead of adding another.',
  REASON_REQUIRED: 'Enter a reason.',
  TASK_CLOSED: 'This task has already been decided.',
  IDEMPOTENCY_KEY_REUSED: 'This decision could not be matched to its earlier attempt. Nothing was recorded; decide again.',
  REOPEN_PENDING: 'A reopen request for this timesheet is already waiting for a decision.',
  TIMESHEET_CHANGED: 'The timesheet is no longer at the approved revision this request names, so nothing was reopened.',
  SELF_ACTION_NOT_ALLOWED: 'You cannot resolve your own missed-timesheet reminder.',
  RANGE_TOO_LONG: 'A report covers at most 366 days. Split the range.',
  GROUP_BY_REQUIRED: 'Group the report by at least one of employee, project, job, activity or week.',
  NO_ELIGIBLE_REVIEWER: 'No eligible reviewer is configured for this timesheet. Contact HR to repair the approval routing.',
  WORKFLOW_NOT_CONFIGURED: 'No approval workflow is configured for timesheets. Contact HR.',
  STALE_VERSION: 'Someone changed this record meanwhile. It has been reloaded: check it and try again.',
};

const INVALID_STATE_TEXT: Partial<Record<Act, string>> = {
  allocation: 'A cancelled allocation is final and cannot be changed.',
  submit: 'Only a draft revision can be submitted. The timesheet has been reloaded.',
  revise: 'Only a returned or rejected timesheet is revised; an approved one needs a reopen request.',
  decide: 'This timesheet is no longer waiting for a decision.',
  'reopen-request': 'Only an approved timesheet is reopened; a draft, returned or rejected one is corrected directly.',
  'reopen-decide': 'This reopen request is no longer waiting for a decision.',
  resolve: 'This reminder has already been resolved.',
};

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
function refusalText(error: unknown, act: Act): string | null {
  if (!(error instanceof ApiError)) return null;
  const d = (error.details ?? {}) as Record<string, unknown>;
  switch (error.code) {
    case 'INVALID_PERIOD':
      if (act === 'week') return 'A timesheet covers a Monday to Sunday week: choose the Monday the week starts on.';
      if (act === 'report') return 'The report range ends before it starts.';
      return 'The end date is before the start date.';
    case 'INVALID_STATE':
      return INVALID_STATE_TEXT[act] ?? 'This record is not in a state that allows this any more.';
    case 'OVER_ALLOCATED':
      return `The employee would be allocated ${typeof d.peakPercent === 'string' ? d.peakPercent : 'more than 100'}% on ${typeof d.date === 'string' ? formatDate(d.date) : 'a day of the interval'}. Above 100% needs an over-allocation exception with a reason, recorded by the employee’s direct manager.`;
    case 'DAILY_LIMIT_EXCEEDED':
      return `The lines of ${typeof d.workDate === 'string' ? formatDate(d.workDate) : 'that day'} would total ${typeof d.totalMinutes === 'number' ? hm(d.totalMinutes) : 'more than 24 hours'}: a day holds at most 24 hours.`;
    case 'LINES_INVALID': {
      const lines = Array.isArray(d.lines) ? (d.lines as { workDate: string; code: string }[]) : [];
      const each = lines.map((l) => `${formatDate(l.workDate)}: ${PLAIN[l.code] ?? readable(l.code)}`).join(' ');
      return `Some lines no longer meet the entry rules; correct or remove them, then submit again. ${each}`.trim();
    }
    case 'FORBIDDEN':
      return 'The selected role is not permitted to do this.';
  }
  if (PLAIN[error.code]) return PLAIN[error.code]!;
  if (error.status === 404) return 'This record is not available in the selected role’s scope, or it no longer exists.';
  return null;
}

function Refusal({ error, act }: { error: unknown; act: Act }) {
  if (!error) return null;
  const text = refusalText(error, act);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

/** A list or detail that could not be read: a scope refusal in words, anything else as the API sent it. */
function ReadProblem({ error, what }: { error: unknown; what: string }) {
  if (!error) return null;
  if (isForbidden(error) && !(error instanceof ApiError && error.code === 'EMPLOYEE_CONTEXT_REQUIRED')) return <NotPermitted>The selected role cannot see {what}.</NotPermitted>;
  return <Refusal error={error} act="read" />;
}

// ---------------------------------------------------------------------------------------------------------
// Employee and job choices for the forms
// ---------------------------------------------------------------------------------------------------------
interface Choice {
  id: string;
  label: string;
}

/** An employee: the signed-in one, the current one, or one found by an employee search (employee.list). */
function EmployeeField({ label, value, current, onChange }: { label: string; value: string; current?: Choice | null; onChange: (id: string) => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const canSearch = can(EMPLOYEE_LIST);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: keys.employeeSearch(term),
    queryFn: () => api<{ items: EmployeeHit[] }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25' }).toString()}`),
    enabled: canSearch && term !== '',
    retry: retryTransient,
  });
  const choices: Choice[] = [];
  const offer = (c: Choice) => {
    if (!choices.some((x) => x.id === c.id)) choices.push(c);
  };
  if (me?.employeeId) offer({ id: me.employeeId, label: me.displayName ? `You (${me.displayName})` : 'You' });
  if (current) offer(current);
  if (picked) offer(picked);
  const choose = (e: EmployeeHit) => {
    const c = { id: e.id, label: `${e.displayName} (${e.employeeCode})` };
    setPicked(c);
    onChange(c.id);
    setSearch('');
    setTerm('');
  };
  const found = term !== '' ? hits.data : undefined;
  const lower = label.toLowerCase();
  return (
    <>
      <label>
        {label}
        <select required value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      {canSearch ? (
        <div className="wide">
          <label>
            Find {choices.length > 0 ? `another ${lower}` : `the ${lower}`}
            <input type="search" value={search} maxLength={100} placeholder="Name, employee code or work email" onChange={(e) => setSearch(e.target.value)} />
          </label>
          {term !== '' && hits.isLoading && <p className="hint">Searching…</p>}
          {isForbidden(hits.error) ? <NotPermitted>The selected role cannot search employees.</NotPermitted> : <ErrorNote error={hits.error} />}
          {found && found.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
          {found && found.items.length > 0 && (
            <ul className="choices" aria-label={`Matching employees for ${lower}`}>
              {found.items.map((e) => (
                <li key={e.id}>
                  <button type="button" aria-label={`Choose ${e.displayName} (${e.employeeCode}) as ${lower}`} onClick={() => choose(e)}>
                    {e.displayName} ({e.employeeCode}) · {readable(e.status).toLowerCase()}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="hint wide">The selected role cannot search employees, so only the choices above are offered.</p>
      )}
    </>
  );
}

/** A job of an active project (timesheet_master.read): the project first, then one of its active jobs. */
function JobField({ projectId, jobId, onProject, onJob }: { projectId: string; jobId: string; onProject: (id: string) => void; onJob: (id: string) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const canRead = can(MASTER_READ);
  const projects = useQuery({ queryKey: keys.projectList('true'), queryFn: () => api<{ items: Project[] }>('/v1/timesheet/projects?active=true'), enabled: canRead, retry: retryTransient });
  const detail = useQuery({
    queryKey: keys.project(projectId),
    queryFn: () => api<ProjectDetail>(`/v1/timesheet/projects/${encodeURIComponent(projectId)}`),
    enabled: canRead && projectId !== '',
    retry: retryTransient,
  });
  if (!canRead) return <p className="hint wide">The selected role cannot list projects and jobs, so no job can be chosen here.</p>;
  const jobs = (shown(detail)?.jobs ?? []).filter((j) => j.active);
  return (
    <>
      <label>
        Project
        <select
          required
          value={projectId}
          onChange={(e) => {
            onProject(e.target.value);
            onJob('');
          }}
        >
          <option value="">Choose…</option>
          {(shown(projects)?.items ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.code}: {p.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Job
        <select required value={jobId} disabled={projectId === ''} onChange={(e) => onJob(e.target.value)}>
          <option value="">{projectId === '' ? 'Choose a project first' : 'Choose…'}</option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.code}: {j.name}
            </option>
          ))}
        </select>
      </label>
      <ErrorNote error={projects.error ?? detail.error} />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: masters (projects and the activity catalogue), and the project, job and activity details
// ---------------------------------------------------------------------------------------------------------
const MASTER_NOUN: Record<MasterKind, string> = { project: 'project', job: 'job', activity: 'activity' };

function MastersScreen() {
  const { can } = useSession();
  if (!can(MASTER_READ)) return <NotPermitted>The selected role cannot see the timesheet masters.</NotPermitted>;
  return (
    <div className="stack">
      <ProjectList />
      <ActivityList />
    </div>
  );
}

function ActiveFilter({ value, onChange, noun }: { value: string; onChange: (v: string) => void; noun: string }) {
  return (
    <label>
      Show {noun}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        <option value="true">Active only</option>
        <option value="false">Inactive only</option>
      </select>
    </label>
  );
}

function ProjectList() {
  const { can } = useSession();
  const keys = useKeys();
  const [active, setActive] = useState('');
  const list = useQuery({
    queryKey: keys.projectList(active),
    queryFn: () => api<{ items: Project[] }>(`/v1/timesheet/projects${active ? `?active=${active}` : ''}`),
    retry: retryTransient,
  });
  const data = shown(list);
  return (
    <Section title="Projects">
      <div className="row">
        <ActiveFilter value={active} onChange={setActive} noun="projects" />
      </div>
      <ReadProblem error={list.error} what="projects" />
      {list.isPending && <p className="hint loading">Loading projects…</p>}
      {data && data.items.length === 0 && (
        <Empty>{can(MASTER_MANAGE) ? 'No projects yet. Add the first one below.' : 'No projects yet. Your timesheet administrator sets them up.'}</Empty>
      )}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Projects">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Owner</th>
                <th>Valid</th>
                <th>Status</th>
                <th>Jobs</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    <Link to={PATHS.project(p.id)}>{p.code}</Link>
                  </td>
                  <td>{p.name}</td>
                  <td>
                    {p.ownerName} ({p.ownerEmployeeCode})
                  </td>
                  <td>{periodText(p)}</td>
                  <td>{activeText(p.active)}</td>
                  <td>{p.jobCount ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(MASTER_MANAGE) && <NewMasterForm kind="project" />}
    </Section>
  );
}

function ActivityList() {
  const { can } = useSession();
  const keys = useKeys();
  const [active, setActive] = useState('');
  const list = useQuery({
    queryKey: keys.activityList(active),
    queryFn: () => api<{ items: Activity[] }>(`/v1/timesheet/activities${active ? `?active=${active}` : ''}`),
    retry: retryTransient,
  });
  const data = shown(list);
  return (
    <Section title="Activity catalogue">
      <p className="hint">Each job lists the activities people can book time to. Changing whether an activity is productive does not change timesheets already filled in.</p>
      <div className="row">
        <ActiveFilter value={active} onChange={setActive} noun="activities" />
      </div>
      <ReadProblem error={list.error} what="activities" />
      {list.isPending && <p className="hint loading">Loading activities…</p>}
      {data && data.items.length === 0 && (
        <Empty>{can(MASTER_MANAGE) ? 'No activities yet. Add the first one below.' : 'No activities yet. Your timesheet administrator sets them up.'}</Empty>
      )}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Activities">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Productive</th>
                <th>Owner</th>
                <th>Valid</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link to={PATHS.activity(a.id)}>{a.code}</Link>
                  </td>
                  <td>{a.name}</td>
                  <td>{a.productive ? 'Productive' : 'Not productive'}</td>
                  <td>
                    {a.ownerName} ({a.ownerEmployeeCode})
                  </td>
                  <td>{periodText(a)}</td>
                  <td>{activeText(a.active)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(MASTER_MANAGE) && <NewMasterForm kind="activity" />}
    </Section>
  );
}

interface MasterBody {
  code: string;
  name: string;
  ownerEmployeeId: string;
  startDate: string;
  endDate: string | null;
  productive?: boolean;
}

/** A new project, a new job in a project (fixed at creation) or a new activity (productive chosen explicitly). */
function NewMasterForm({ kind, projectId }: { kind: MasterKind; projectId?: string }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const noun = MASTER_NOUN[kind];
  const empty = { code: '', name: '', owner: '', start: '', end: '', productive: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const set = (k: keyof typeof empty) => (v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const path = kind === 'project' ? '/v1/timesheet/projects' : kind === 'job' ? `/v1/timesheet/projects/${encodeURIComponent(projectId ?? '')}/jobs` : '/v1/timesheet/activities';
  const create = useMutation({
    mutationFn: (body: MasterBody) => api<Master>(path, { body }),
    onSuccess: (m) => {
      setF(empty);
      setNotice({ text: `Created ${noun} ${m.code}.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.masters });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    setNotice(null);
    const missing = [!CODE.test(f.code) && 'a code (letters, digits, - or _, at most 40)', !f.name.trim() && 'a name', !f.owner && 'an owner', !f.start && 'a start date', kind === 'activity' && !f.productive && 'whether the activity is productive'].filter(Boolean);
    if (missing.length > 0) {
      setProblem(`Enter ${missing.join(', ')}.`);
      create.reset();
      return;
    }
    setProblem(null);
    create.mutate({ code: f.code.trim(), name: f.name.trim(), ownerEmployeeId: f.owner, startDate: f.start, endDate: f.end || null, ...(kind === 'activity' ? { productive: f.productive === 'yes' } : {}) });
  };
  return (
    <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate style={SPACED}>
      <h3 id={`${id}-title`} className="wide" style={H3}>
        New {noun}
      </h3>
      <label>
        Code
        <input value={f.code} maxLength={40} onChange={(e) => set('code')(e.target.value)} />
      </label>
      <label>
        Name
        <input value={f.name} maxLength={200} onChange={(e) => set('name')(e.target.value)} />
      </label>
      <EmployeeField label="Owner" value={f.owner} onChange={set('owner')} />
      <label>
        Valid from
        <input type="date" value={f.start} onChange={(e) => set('start')(e.target.value)} />
      </label>
      <label>
        Valid to (optional)
        <input type="date" value={f.end} onChange={(e) => set('end')(e.target.value)} />
      </label>
      {kind === 'activity' && (
        // One line, two inline choices; neither is chosen for you (the server takes no default).
        <div className="row wide" role="radiogroup" aria-labelledby={`${id}-productive`}>
          <span id={`${id}-productive`}>Counts as productive time</span>
          <label className="check">
            <input type="radio" name={`${id}-productive`} checked={f.productive === 'yes'} onChange={() => set('productive')('yes')} /> Yes
          </label>
          <label className="check">
            <input type="radio" name={`${id}-productive`} checked={f.productive === 'no'} onChange={() => set('productive')('no')} /> No
          </label>
        </div>
      )}
      <div className="wide">
        <Problem text={problem} />
        <Refusal error={create.error} act="master" />
        <Notice notice={notice} />
        <button type="submit" disabled={create.isPending}>
          Create {noun}
        </button>
      </div>
    </form>
  );
}

function MasterFacts({ m, extra }: { m: Master; extra?: ReactNode }) {
  return (
    <dl className="kv">
      <Item term="Code">{m.code}</Item>
      <Item term="Name">{m.name}</Item>
      <Item term="Owner">
        {m.ownerName} ({m.ownerEmployeeCode})
      </Item>
      <Item term="Valid">{periodText(m)}</Item>
      <Item term="Status">{activeText(m.active)}</Item>
      {extra}
    </dl>
  );
}

/** Changes a master against its version; only the changed fields are sent (the code never changes). */
function MasterEdit({ kind, m, path, onSaved }: { kind: MasterKind; m: Master & { productive?: boolean }; path: string; onSaved: () => void }) {
  const id = useId();
  const initial = { name: m.name, owner: m.ownerEmployeeId, start: m.startDate, end: m.endDate ?? '', active: m.active, productive: m.productive };
  const [f, setF] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Master>(path, { method: 'PATCH', body }),
    onSuccess: () => {
      setNotice({ text: `Saved ${MASTER_NOUN[kind]} ${m.code}.`, ok: true });
      onSaved();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onSaved();
    },
  });
  // A newer version arrived (after a save or a reload): the form starts from it.
  useEffect(() => setF({ name: m.name, owner: m.ownerEmployeeId, start: m.startDate, end: m.endDate ?? '', active: m.active, productive: m.productive }), [m.version, m.name, m.ownerEmployeeId, m.startDate, m.endDate, m.active, m.productive]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    setNotice(null);
    const body: Record<string, unknown> = { expectedVersion: m.version };
    if (f.name.trim() !== m.name) body.name = f.name.trim();
    if (f.owner !== m.ownerEmployeeId) body.ownerEmployeeId = f.owner;
    if (f.start !== m.startDate) body.startDate = f.start;
    if ((f.end || null) !== m.endDate) body.endDate = f.end || null;
    if (f.active !== m.active) body.active = f.active;
    if (kind === 'activity' && f.productive !== m.productive) body.productive = f.productive;
    if (!f.name.trim() || !f.start) {
      setProblem('Enter a name and a start date.');
      return;
    }
    if (Object.keys(body).length < 2) {
      setProblem('Change at least one field to save.');
      return;
    }
    setProblem(null);
    save.mutate(body);
  };
  return (
    <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate style={SPACED}>
      <h3 id={`${id}-title`} className="wide" style={H3}>
        Change {MASTER_NOUN[kind]} {m.code}
      </h3>
      <label>
        Name
        <input value={f.name} maxLength={200} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </label>
      <EmployeeField label="Owner" value={f.owner} current={{ id: m.ownerEmployeeId, label: `${m.ownerName} (${m.ownerEmployeeCode})` }} onChange={(owner) => setF((p) => ({ ...p, owner }))} />
      <label>
        Valid from
        <input type="date" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} />
      </label>
      <label>
        Valid to (empty for open-ended)
        <input type="date" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Active
      </label>
      {kind === 'activity' && (
        <label className="check">
          <input type="checkbox" checked={f.productive === true} onChange={(e) => setF({ ...f, productive: e.target.checked })} /> Productive
        </label>
      )}
      <div className="wide">
        <Problem text={problem} />
        <Refusal error={save.error} act="master" />
        <Notice notice={notice} />
        <button type="submit" disabled={save.isPending}>
          Save changes
        </button>
      </div>
    </form>
  );
}

function ProjectScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: keys.project(id), queryFn: () => api<ProjectDetail>(`/v1/timesheet/projects/${encodeURIComponent(id)}`), enabled: can(MASTER_READ), retry: retryTransient });
  if (!can(MASTER_READ)) return <NotPermitted>The selected role cannot see the timesheet masters.</NotPermitted>;
  const p = shown(detail);
  return (
    <div className="stack">
      <p>
        <Link to={PATHS.masters}>All projects and activities</Link>
      </p>
      <Section title={p ? `Project ${p.code}: ${p.name}` : 'Project'}>
        {detail.isPending && <p className="hint loading">Loading the project…</p>}
        <ReadProblem error={detail.error} what="this project" />
        {p && <MasterFacts m={p} />}
        {p && can(MASTER_MANAGE) && <MasterEdit kind="project" m={p} path={`/v1/timesheet/projects/${encodeURIComponent(p.id)}`} onSaved={() => void qc.invalidateQueries({ queryKey: keys.masters })} />}
      </Section>
      {p && (
        <Section title="Jobs">
          <p className="hint">A job belongs to exactly this project; that never changes.</p>
          {p.jobs.length === 0 ? (
            <Empty>No jobs in this project yet.</Empty>
          ) : (
            <div style={SCROLL}>
              <table aria-label="Jobs">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Owner</th>
                    <th>Valid</th>
                    <th>Status</th>
                    <th>Approved activities</th>
                  </tr>
                </thead>
                <tbody>
                  {p.jobs.map((j) => (
                    <tr key={j.id}>
                      <td>
                        <Link to={PATHS.job(j.id)}>{j.code}</Link>
                      </td>
                      <td>{j.name}</td>
                      <td>
                        {j.ownerName} ({j.ownerEmployeeCode})
                      </td>
                      <td>{periodText(j)}</td>
                      <td>{activeText(j.active)}</td>
                      <td>{j.activities.filter((a) => a.linkActive).map((a) => a.code).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {can(MASTER_MANAGE) && <NewMasterForm kind="job" projectId={p.id} />}
        </Section>
      )}
    </div>
  );
}

function JobScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: keys.job(id), queryFn: () => api<Job>(`/v1/timesheet/jobs/${encodeURIComponent(id)}`), enabled: can(MASTER_READ), retry: retryTransient });
  if (!can(MASTER_READ)) return <NotPermitted>The selected role cannot see the timesheet masters.</NotPermitted>;
  const j = shown(detail);
  return (
    <div className="stack">
      {j && (
        <p>
          <Link to={PATHS.project(j.projectId)}>
            Project {j.projectCode}: {j.projectName}
          </Link>
        </p>
      )}
      <Section title={j ? `Job ${j.code}: ${j.name}` : 'Job'}>
        {detail.isPending && <p className="hint loading">Loading the job…</p>}
        <ReadProblem error={detail.error} what="this job" />
        {j && <MasterFacts m={j} extra={<Item term="Project">{`${j.projectCode ?? ''}: ${j.projectName ?? ''}`}</Item>} />}
        {j && can(MASTER_MANAGE) && <MasterEdit kind="job" m={j} path={`/v1/timesheet/jobs/${encodeURIComponent(j.id)}`} onSaved={() => void qc.invalidateQueries({ queryKey: keys.masters })} />}
      </Section>
      {j && <JobActivities job={j} />}
    </div>
  );
}

/** F1 approved job activities: link an activity to the job, or deactivate and reactivate a link (kept on record). */
function JobActivities({ job }: { job: Job }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const manage = can(MASTER_MANAGE);
  const [adding, setAdding] = useState('');
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const catalogue = useQuery({ queryKey: keys.activityList('true'), queryFn: () => api<{ items: Activity[] }>('/v1/timesheet/activities?active=true'), enabled: manage, retry: retryTransient });
  const link = useMutation({
    mutationFn: (v: { activityId: string; active: boolean }) => api<Job>(`/v1/timesheet/jobs/${encodeURIComponent(job.id)}/activities/${encodeURIComponent(v.activityId)}`, { method: 'PUT', body: { active: v.active } }),
    onSuccess: (_j, v) => {
      setAdding('');
      setNotice({ text: v.active ? 'The activity is approved for this job.' : 'The link is deactivated; it stays on record.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.masters });
    },
  });
  const linked = new Set(job.activities.map((a) => a.activityId));
  const offer = (shown(catalogue)?.items ?? []).filter((a) => !linked.has(a.id));
  return (
    <Section title="Approved activities">
      {job.activities.length === 0 ? (
        <Empty>No activity is linked to this job yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Job activities">
            <thead>
              <tr>
                <th>Activity</th>
                <th>Productive</th>
                <th>Activity status</th>
                <th>Link</th>
                {manage && <th>Change</th>}
              </tr>
            </thead>
            <tbody>
              {job.activities.map((a) => (
                <tr key={a.activityId}>
                  <td>
                    {a.code}: {a.name}
                  </td>
                  <td>{a.productive ? 'Productive' : 'Not productive'}</td>
                  <td>{activeText(a.activityActive)}</td>
                  <td>{a.linkActive ? 'Approved' : 'Deactivated'}</td>
                  {manage && (
                    <td>
                      <button type="button" className={a.linkActive ? 'danger' : 'secondary'} disabled={link.isPending} onClick={() => link.mutate({ activityId: a.activityId, active: !a.linkActive })}>
                        {a.linkActive ? `Deactivate ${a.code}` : `Reactivate ${a.code}`}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {manage && (
        <div className="row" style={SPACED}>
          <label>
            Activity to approve for this job
            <select value={adding} onChange={(e) => setAdding(e.target.value)}>
              <option value="">Choose…</option>
              {offer.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code}: {a.name}
                </option>
              ))}
            </select>
          </label>
          <button type="button" disabled={!adding || link.isPending} onClick={() => link.mutate({ activityId: adding, active: true })}>
            Approve activity
          </button>
        </div>
      )}
      <Refusal error={link.error} act="master" />
      <Notice notice={notice} />
    </Section>
  );
}

function ActivityScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: keys.activity(id), queryFn: () => api<Activity>(`/v1/timesheet/activities/${encodeURIComponent(id)}`), enabled: can(MASTER_READ), retry: retryTransient });
  if (!can(MASTER_READ)) return <NotPermitted>The selected role cannot see the timesheet masters.</NotPermitted>;
  const a = shown(detail);
  return (
    <div className="stack">
      <p>
        <Link to={PATHS.masters}>All projects and activities</Link>
      </p>
      <Section title={a ? `Activity ${a.code}: ${a.name}` : 'Activity'}>
        {detail.isPending && <p className="hint loading">Loading the activity…</p>}
        <ReadProblem error={detail.error} what="this activity" />
        {a && <MasterFacts m={a} extra={<Item term="Productive">{a.productive ? 'Productive' : 'Not productive'}</Item>} />}
        {a && can(MASTER_MANAGE) && <MasterEdit kind="activity" m={a} path={`/v1/timesheet/activities/${encodeURIComponent(a.id)}`} onSaved={() => void qc.invalidateQueries({ queryKey: keys.masters })} />}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: resource allocations (FR-046)
// ---------------------------------------------------------------------------------------------------------
function AllocationsScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const [state, setState] = useState('ACTIVE');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = new URLSearchParams(Object.entries({ state, from, to }).filter(([, v]) => v !== '')).toString();
  // FR-056: one page at a time (back to the first page when a filter changes); `total` counts every match in scope.
  const [paging, setPaging] = useState({ query, page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const list = useQuery({
    queryKey: keys.allocationList(`${query}#${page}`),
    queryFn: () => api<{ items: Allocation[]; total?: number }>(`/v1/timesheet/allocations?${query ? `${query}&` : ''}${pageParams(page)}`),
    enabled: can(ALLOC_READ),
    retry: retryTransient,
  });
  if (!can(ALLOC_READ)) return <NotPermitted>The selected role cannot see resource allocations.</NotPermitted>;
  const data = shown(list);
  return (
    <div className="stack">
      <Section title="Resource allocations">
        <p className="hint">An allocation is a share of the employee’s daily capacity on a job. Overlapping jobs may total 100%; above that, only the employee’s direct manager records an exception with a reason.</p>
        <div className="row">
          <label>
            Status
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </label>
          <label>
            Overlapping from
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Overlapping to
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <ReadProblem error={list.error} what="resource allocations" />
        {list.isPending && <p className="hint loading">Loading allocations…</p>}
        {data && data.items.length === 0 && <Empty>No allocations match.</Empty>}
        {data && data.items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="Allocations">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Project and job</th>
                  <th>Interval</th>
                  <th>Allocation</th>
                  <th>Status</th>
                  <th>Over-allocation exception</th>
                  {can(ALLOC_MANAGE) && <th>Change</th>}
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <AllocationRow key={a.id} a={a} manage={can(ALLOC_MANAGE)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={(p) => setPaging({ query, page: p })} label="Allocation pages" noun="allocation" />}
      </Section>
      {can(ALLOC_MANAGE) && <NewAllocationForm />}
    </div>
  );
}

function AllocationRow({ a, manage }: { a: Allocation; manage: boolean }) {
  const [open, setOpen] = useState<'change' | 'cancel' | null>(null);
  return (
    <>
      <tr>
        <td>
          {a.employeeName} ({a.employeeCode})
        </td>
        <td>
          {a.projectCode} / {a.jobCode}: {a.jobName}
        </td>
        <td>
          {formatDate(a.startDate)} to {formatDate(a.endDate)}
        </td>
        <td>{a.allocationPercent}%</td>
        <td>
          <StateBadge state={a.state} />
          {a.source === 'IMPORT' && <div className="hint">imported</div>}
          {a.cancelReason && <div className="hint">Cancelled: {a.cancelReason}</div>}
        </td>
        <td>
          {a.overAllocation ? (
            <>
              Peak {a.overAllocation.peakPercent}% · recorded <When at={a.overAllocation.recordedAt} />
              <div className="hint">Reason: {a.overAllocation.reason}</div>
            </>
          ) : (
            '—'
          )}
        </td>
        {manage && (
          <td>
            {a.state === 'ACTIVE' ? (
              <div className="row">
                <button type="button" className="secondary" aria-expanded={open === 'change'} onClick={() => setOpen(open === 'change' ? null : 'change')}>
                  Change {a.employeeCode} on {a.jobCode}
                </button>
                <button type="button" className="danger" aria-expanded={open === 'cancel'} onClick={() => setOpen(open === 'cancel' ? null : 'cancel')}>
                  Cancel {a.employeeCode} on {a.jobCode}
                </button>
              </div>
            ) : (
              '—'
            )}
          </td>
        )}
      </tr>
      {manage && open && (
        <tr>
          <td colSpan={7}>{open === 'change' ? <ChangeAllocation a={a} onDone={() => setOpen(null)} /> : <CancelAllocation a={a} onDone={() => setOpen(null)} />}</td>
        </tr>
      )}
    </>
  );
}

/** The exception reason, offered once the API reports that the total would exceed 100% (or one is on record). */
function ExceptionReason({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="wide">
      Over-allocation exception reason (the employee’s direct manager only)
      <textarea rows={2} maxLength={1000} value={value} onChange={(e) => onChange(e.target.value)} style={TEXTAREA} />
    </label>
  );
}

function NewAllocationForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const empty = { employee: '', project: '', job: '', start: '', end: '', percent: '', reason: '' };
  const [f, setF] = useState(empty);
  const [askReason, setAskReason] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const set = (k: keyof typeof empty) => (v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const create = useMutation({
    mutationFn: (body: Record<string, string>) => api<Allocation>('/v1/timesheet/allocations', { body }),
    onSuccess: (a) => {
      setF(empty);
      setAskReason(false);
      setNotice({ text: `Allocated ${a.employeeName} (${a.employeeCode}) to ${a.projectCode} / ${a.jobCode} at ${a.allocationPercent}%.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.allocations });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'OVER_ALLOCATED') setAskReason(true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    setNotice(null);
    const missing = [!f.employee && 'an employee', !f.job && 'a job', !f.start && 'a start date', !f.end && 'an end date', !PERCENT.test(f.percent.trim()) && 'a percentage (up to two decimals)'].filter(Boolean);
    if (missing.length > 0) {
      setProblem(`Enter ${missing.join(', ')}.`);
      create.reset();
      return;
    }
    setProblem(null);
    const reason = f.reason.trim();
    create.mutate({ employeeId: f.employee, jobId: f.job, startDate: f.start, endDate: f.end, allocationPercent: f.percent.trim(), ...(askReason && reason ? { overAllocationReason: reason } : {}) });
  };
  return (
    <Section title="New allocation">
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <h3 id={`${id}-title`} className="wide" style={H3}>
          Allocate an employee to a job
        </h3>
        <EmployeeField label="Employee" value={f.employee} onChange={set('employee')} />
        <JobField projectId={f.project} jobId={f.job} onProject={set('project')} onJob={set('job')} />
        <label>
          From
          <input type="date" value={f.start} onChange={(e) => set('start')(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={f.end} onChange={(e) => set('end')(e.target.value)} />
        </label>
        <label>
          Allocation (%)
          <input inputMode="decimal" value={f.percent} maxLength={6} onChange={(e) => set('percent')(e.target.value)} />
        </label>
        {askReason && <ExceptionReason value={f.reason} onChange={set('reason')} />}
        <div className="wide">
          <Problem text={problem} />
          <Refusal error={create.error} act="allocation" />
          <Notice notice={notice} />
          <button type="submit" disabled={create.isPending}>
            {askReason ? 'Allocate with the exception' : 'Allocate'}
          </button>
        </div>
      </form>
    </Section>
  );
}

function ChangeAllocation({ a, onDone }: { a: Allocation; onDone: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [end, setEnd] = useState(a.endDate);
  const [percent, setPercent] = useState(a.allocationPercent);
  const [reason, setReason] = useState('');
  const [askReason, setAskReason] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Allocation>(`/v1/timesheet/allocations/${encodeURIComponent(a.id)}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.allocations });
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'OVER_ALLOCATED') setAskReason(true);
      if (error instanceof ApiError && error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.allocations });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const body: Record<string, unknown> = { expectedVersion: a.version };
    if (end !== a.endDate) body.endDate = end;
    if (percent.trim() !== a.allocationPercent) body.allocationPercent = percent.trim();
    if (askReason && reason.trim()) body.overAllocationReason = reason.trim();
    if (!PERCENT.test(percent.trim()) || !end) {
      setProblem('Enter an end date and a percentage (up to two decimals).');
      return;
    }
    if (Object.keys(body).length < 2) {
      setProblem('Change the end date or the percentage to save.');
      return;
    }
    setProblem(null);
    save.mutate(body);
  };
  return (
    <form className="grid-form" aria-label={`Change the allocation of ${a.employeeCode} on ${a.jobCode}`} onSubmit={submit} noValidate>
      <label>
        New end date
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <label>
        New allocation (%)
        <input inputMode="decimal" value={percent} maxLength={6} onChange={(e) => setPercent(e.target.value)} />
      </label>
      {askReason && <ExceptionReason value={reason} onChange={setReason} />}
      <div className="wide">
        <Problem text={problem} />
        <Refusal error={save.error} act="allocation" />
        <div className="row">
          <button type="submit" disabled={save.isPending}>
            Save allocation
          </button>
          <button type="button" className="secondary" onClick={onDone}>
            Close
          </button>
        </div>
      </div>
    </form>
  );
}

function CancelAllocation({ a, onDone }: { a: Allocation; onDone: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (body: { reason: string; expectedVersion: number }) => api<Allocation>(`/v1/timesheet/allocations/${encodeURIComponent(a.id)}/cancel`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.allocations });
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.allocations });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cancel.isPending) return;
    if (!reason.trim()) {
      setProblem('Enter a reason to cancel the allocation.');
      return;
    }
    setProblem(null);
    cancel.mutate({ reason: reason.trim(), expectedVersion: a.version });
  };
  return (
    <form aria-label={`Cancel the allocation of ${a.employeeCode} on ${a.jobCode}`} onSubmit={submit} noValidate className="stack">
      <label>
        Cancellation reason
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      <p className="hint" style={FLUSH}>
        A cancelled allocation is final and stays on record.
      </p>
      <Problem text={problem} />
      <Refusal error={cancel.error} act="allocation" />
      <div className="row">
        <button type="submit" className="danger" disabled={cancel.isPending}>
          Cancel allocation
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Close
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// One timesheet: its revisions, the lines of the revision shown, decisions and reopen requests
// ---------------------------------------------------------------------------------------------------------
function SheetFacts({ s }: { s: SheetDetail }) {
  return (
    <dl className="kv">
      <Item term="Employee">
        {s.employeeName} ({s.employeeCode})
      </Item>
      <Item term="Week">{weekText(s)}</Item>
      <Item term="Due">{formatDate(s.dueDate)}</Item>
      <Item term="Status">
        <StateBadge state={s.state} />
        {s.pendingWith && <div className="hint">with {s.pendingWith}</div>}
      </Item>
      <Item term="Current revision">{s.currentRevision}</Item>
      <Item term="Approved revision in force">{s.approvedRevision ?? '—'}</Item>
      <Item term="First submission">
        {s.firstSubmittedAt ? (
          <>
            <When at={s.firstSubmittedAt} /> · {lateText(s.late)}
          </>
        ) : (
          'Not yet submitted'
        )}
      </Item>
    </dl>
  );
}

function RevisionTable({ s, onShow }: { s: SheetDetail; onShow: (revision: number) => void }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Revisions">
        <thead>
          <tr>
            <th>Revision</th>
            <th>Origin</th>
            <th>Status</th>
            <th>Submitted</th>
            <th>Decided</th>
            <th>Lines and time</th>
            <th>Show</th>
          </tr>
        </thead>
        <tbody>
          {s.revisions.map((r) => (
            <tr key={r.revision}>
              <td>
                {r.revision}
                {r.revision === s.approvedRevision && <div className="hint">approved revision in force</div>}
              </td>
              <td>
                {ORIGIN_LABEL[r.origin] ?? readable(r.origin)}
                {r.previousRevision !== null && <div className="hint">follows revision {r.previousRevision}</div>}
              </td>
              <td>
                <StateBadge state={r.state} />
                {r.supersededByRevision !== null && <div className="hint">superseded by revision {r.supersededByRevision}</div>}
              </td>
              <td>{r.submittedOn ? `${formatDate(r.submittedOn)} · ${lateText(r.late)}` : '—'}</td>
              <td>
                <When at={r.decidedAt} />
                {r.decisionReason && <div className="hint">Reason: {r.decisionReason}</div>}
              </td>
              <td>
                {r.lineCount} lines · {hm(r.totalMinutes)}
              </td>
              <td>
                {r.revision === s.shownRevision ? (
                  'Shown'
                ) : (
                  <button type="button" className="secondary" onClick={() => onShow(r.revision)}>
                    Show revision {r.revision}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinesTable({ s, actions }: { s: SheetDetail; actions?: (l: Line) => ReactNode }) {
  if (s.lines.length === 0) return <Empty>No lines in revision {s.shownRevision}.</Empty>;
  return (
    <>
      <div style={SCROLL}>
        <table aria-label={`Lines of revision ${s.shownRevision}`}>
          <thead>
            <tr>
              <th>Work date</th>
              <th>Project and job</th>
              <th>Activity</th>
              <th>Time</th>
              <th>Note</th>
              {actions && <th>Change</th>}
            </tr>
          </thead>
          <tbody>
            {s.lines.map((l) => (
              <tr key={l.id}>
                <td>{formatDate(l.workDate)}</td>
                <td>
                  {l.projectCode} / {l.jobCode}: {l.jobName}
                </td>
                <td>
                  {l.activityCode}: {l.activityName}
                  <div className="hint">{l.productive ? 'productive' : 'not productive'}</div>
                </td>
                <td>{hm(l.minutes)}</td>
                <td>{l.note ?? '—'}</td>
                {actions && <td>{actions(l)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="hint">
        Daily totals: {s.dailyTotals.map((d) => `${formatDate(d.workDate)} ${d.hours} h`).join(' · ')} · Revision total {hm(s.totalMinutes)}
      </p>
    </>
  );
}

function SheetHistory({ s }: { s: SheetDetail }) {
  return (
    <>
      <h3 style={H3}>Decisions</h3>
      {s.decisions.length === 0 ? (
        <Empty>No decisions yet.</Empty>
      ) : (
        <ul aria-label="Decisions">
          {s.decisions.map((d, i) => (
            <li key={i}>
              Revision {d.revision}: {DECISION_LABEL[d.decision] ?? readable(d.decision)} · <When at={d.decidedAt} />
            </li>
          ))}
        </ul>
      )}
      <h3 style={H3}>Reopen requests</h3>
      {s.reopenRequests.length === 0 ? (
        <Empty>No reopen requests.</Empty>
      ) : (
        <ul aria-label="Reopen requests">
          {s.reopenRequests.map((r) => (
            <li key={r.id}>
              About approved revision {r.approvedRevision}: <StateBadge state={r.state} /> · requested <When at={r.requestedAt} />
              {r.decidedAt && (
                <>
                  {' '}
                  · decided <When at={r.decidedAt} />
                </>
              )}
              {r.newRevision !== null && ` · correction opened as revision ${r.newRevision}`}
              <div className="hint">Reason: {r.reason}</div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** F1: an approved timesheet is corrected only after an independent reopen decision; the request needs a reason. */
function ReopenRequestForm({ s }: { s: SheetDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const send = useMutation({
    mutationFn: (body: { reason: string }) => api<{ reopenRequestId: string; state: string }>(`/v1/timesheets/${encodeURIComponent(s.id)}/reopen-requests`, { body }),
    onSuccess: () => {
      setReason('');
      setNotice({ text: 'Reopen request sent. An independent HR reviewer decides it; the approved revision stays in force until a correction is approved.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.sheets });
      void qc.invalidateQueries({ queryKey: keys.own });
    },
  });
  if (!can(TS_REQUEST_REOPEN) || s.state !== 'APPROVED') return <Notice notice={notice} />;
  if (s.reopenRequests.some((r) => r.state === 'SUBMITTED'))
    return (
      <>
        <Notice notice={notice} />
        <p className="hint">A reopen request is waiting for an independent HR reviewer.</p>
      </>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (send.isPending) return;
    setNotice(null);
    if (!reason.trim()) {
      setProblem('Enter why the approved timesheet needs a correction.');
      return;
    }
    setProblem(null);
    send.mutate({ reason: reason.trim() });
  };
  return (
    <form aria-label="Request a reopen" onSubmit={submit} noValidate className="stack" style={SPACED}>
      <label>
        Reason for reopening the approved timesheet
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      <Problem text={problem} />
      <Refusal error={send.error} act="reopen-request" />
      <Notice notice={notice} />
      <div>
        <button type="submit" disabled={send.isPending}>
          Request reopen
        </button>
      </div>
    </form>
  );
}

function useSheet(id: string, revision: number | null, enabled = true) {
  const keys = useKeys();
  return useQuery({
    queryKey: keys.sheet(id, revision),
    queryFn: () => api<SheetDetail>(`/v1/timesheets/${encodeURIComponent(id)}${revision !== null ? `?revision=${revision}` : ''}`),
    enabled: enabled && id !== '',
    retry: retryTransient,
  });
}

function TimesheetScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const raw = params.get('revision');
  const revision = raw && /^\d{1,6}$/.test(raw) ? Number(raw) : null;
  const detail = useSheet(id, revision, can(TS_READ));
  if (!can(TS_READ)) return <NotPermitted>The selected role cannot see timesheets.</NotPermitted>;
  const s = shown(detail);
  return (
    <div className="stack">
      <p>
        <Link to={PATHS.timesheets}>All timesheets</Link>
      </p>
      <Section title={s ? `Timesheet of ${s.employeeName} for ${weekText(s)}` : 'Timesheet'}>
        {detail.isPending && <p className="hint loading">Loading the timesheet…</p>}
        <ReadProblem error={detail.error} what="this timesheet" />
        {s && (
          <>
            <SheetFacts s={s} />
            <h3 style={H3}>Revisions</h3>
            <RevisionTable s={s} onShow={(r) => setParams(r === s.currentRevision ? {} : { revision: String(r) })} />
            <h3 style={H3}>Lines of revision {s.shownRevision}</h3>
            <LinesTable s={s} />
            <SheetHistory s={s} />
            <ReopenRequestForm s={s} />
          </>
        )}
      </Section>
    </div>
  );
}

/** CL-138: timesheets whose week overlaps the range, within the role's row scope. */
function TimesheetsScreen() {
  const { can, me } = useSession();
  const keys = useKeys();
  const [state, setState] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = new URLSearchParams(Object.entries({ state, from, to }).filter(([, v]) => v !== '')).toString();
  // FR-056: one page at a time (back to the first page when a filter changes); `total` counts every match in scope.
  const [paging, setPaging] = useState({ query, page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const list = useQuery({
    queryKey: keys.sheetList(`${query}#${page}`),
    queryFn: () => api<{ items: SheetSummary[]; total?: number }>(`/v1/timesheets?${query ? `${query}&` : ''}${pageParams(page)}`),
    enabled: can(TS_READ),
    retry: retryTransient,
  });
  if (!can(TS_READ)) return <NotPermitted>The selected role cannot see timesheets.</NotPermitted>;
  const data = shown(list);
  // An employee's own weeks are filled in on My ESS; this list is where they are looked up, so it leads there.
  const fillOwn = me?.scopeKind === 'OWN' && can(TS_SUBMIT);
  const own = me?.scopeKind === 'OWN';
  return (
    // An own-scope list gets a heading of its own ("Timesheets" is the page's title, which a card of that name would hide), and
    // filling in is the card's main action (styles.css: .card-header > a.primary).
    <Section
      title={own ? 'My timesheets' : 'Timesheets'}
      actions={
        fillOwn ? (
          <Link className="primary" to="/me?tab=TN13">
            Fill in my timesheet
          </Link>
        ) : undefined
      }
    >
      <div className="row">
        <label>
          Status
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All</option>
            {SHEET_STATES.map((st) => (
              <option key={st} value={st}>
                {readable(st)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Weeks from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Weeks to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <ReadProblem error={list.error} what="timesheets" />
      {list.isPending && <p className="hint loading">Loading timesheets…</p>}
      {data && data.items.length === 0 && (
        <Empty>{own && !state && !from && !to ? 'You haven’t filled in a timesheet yet.' : 'No timesheets match these filters.'}</Empty>
      )}
      {data && data.items.length > 0 && <SheetTable items={data.items} link />}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={(p) => setPaging({ query, page: p })} label="Timesheet pages" noun="timesheet" />}
    </Section>
  );
}

function SheetTable({ items, link, onOpen }: { items: SheetSummary[]; link?: boolean; onOpen?: (id: string) => void }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Timesheet weeks">
        <thead>
          <tr>
            {link && <th>Employee</th>}
            <th>Week</th>
            <th>Due</th>
            <th>Status</th>
            <th>Revision</th>
            <th>Submission</th>
            <th>Time (current revision)</th>
            <th>Approved time</th>
            <th>Open</th>
          </tr>
        </thead>
        <tbody>
          {items.map((s) => (
            <tr key={s.id}>
              {link && (
                <td>
                  {s.employeeName} ({s.employeeCode})
                </td>
              )}
              <td>{weekText(s)}</td>
              <td>{formatDate(s.dueDate)}</td>
              <td>
                <StateBadge state={s.state} />
              </td>
              <td>
                {s.currentRevision}
                {s.approvedRevision !== null && s.approvedRevision !== s.currentRevision && <div className="hint">approved: {s.approvedRevision}</div>}
              </td>
              <td>{s.firstSubmittedAt ? lateText(s.late) : 'Not yet submitted'}</td>
              <td>{hm(s.totalMinutes)}</td>
              <td>{s.approvedRevision !== null ? hm(s.approvedMinutes) : '—'}</td>
              <td>
                {link ? (
                  <Link to={PATHS.timesheet(s.id)}>Open week {formatDate(s.periodStart)}</Link>
                ) : (
                  <button type="button" className="secondary" onClick={() => onOpen?.(s.id)}>
                    Open week {formatDate(s.periodStart)}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Decision queues: the manager's timesheet approvals and the independent reopen decisions
// ---------------------------------------------------------------------------------------------------------
function useQueueState(key: readonly unknown[]) {
  const qc = useQueryClient();
  const keys = useKeys();
  const region = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const finished = (taskId: string, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: keys.sheets });
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return { region, gone, notice, finished };
}

function ApprovalsScreen() {
  return <TimesheetDecisionQueue />;
}

/** The direct manager's (or HR fallback reviewer's) open timesheet tasks: approve, return or reject. */
function TimesheetDecisionQueue() {
  const { can } = useSession();
  const keys = useKeys();
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<{ items: TimesheetTask[] }>('/v1/timesheet-tasks'), enabled: can(TS_APPROVE), retry: retryTransient });
  const { region, gone, notice, finished } = useQueueState(keys.tasks);
  if (!can(TS_APPROVE)) return <NotPermitted>The selected role cannot decide timesheets.</NotPermitted>;
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => !gone.has(t.taskId));
  return (
    <div ref={region} role="region" aria-label="Timesheet approvals" tabIndex={-1}>
      <Section title={`Timesheet approvals${data ? ` (${items.length})` : ''}`}>
        <p className="hint">Approve, return for changes or reject each submitted week. Returning or rejecting needs a reason the employee sees; the employee then continues in a new revision.</p>
        {tasks.isPending && <p className="hint loading">Loading the timesheets waiting for you…</p>}
        <ReadProblem error={tasks.error} what="timesheet tasks" />
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>No timesheets are waiting for your decision.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Timesheets waiting for your decision">
            {items.map((t) => (
              <TimesheetTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function decidedText(who: string, result: TimesheetDecided): string {
  if (result.replayed) return `Your earlier decision on the timesheet of ${who} had already been recorded, so nothing was applied twice.`;
  if (result.state === 'APPROVED') return `Approved revision ${result.revision} of the timesheet of ${who}.`;
  if (result.state === 'RETURNED') return `Returned the timesheet of ${who} for changes.`;
  if (result.state === 'REJECTED') return `Rejected revision ${result.revision} of the timesheet of ${who}.`;
  return `The timesheet of ${who} is now ${readable(result.state).toLowerCase()}.`;
}

function TimesheetTaskItem({ task: t, onFinished }: { task: TimesheetTask; onFinished: (taskId: string, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  // The queue needs only the approve key; the timesheet screen behind the link needs the read key as well.
  const canRead = can(TS_READ);
  const id = useId();
  const s = t.timesheet;
  const attempt = useAttemptKey('timesheet-decision');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const who = s ? `${s.employeeName} (${s.employeeCode}) for ${weekText(s)}` : 'the employee';
  const decide = useMutation({
    mutationFn: (body: { decision: string; reason?: string; idempotencyKey: string }) => api<TimesheetDecided>(`/v1/timesheet-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.clear();
      onFinished(t.taskId, decidedText(who, result), true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.clear();
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t.taskId, refusalText(error, 'decide') ?? error.message, false);
    },
  });
  const busy = decide.isPending;
  const send = (decision: 'APPROVE' | 'RETURN' | 'REJECT') => {
    if (busy || !s) return;
    const text = reason.trim();
    if (decision !== 'APPROVE' && !text) {
      setProblem(decision === 'RETURN' ? 'Enter a reason to return the timesheet for changes.' : 'Enter a reason to reject the timesheet.');
      decide.reset();
      return;
    }
    setProblem(null);
    const key = attempt.keyFor(`${decision}|${text}`);
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}) });
  };
  return (
    <li aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} style={H3}>
        {s ? `${s.employeeName} (${s.employeeCode}): ${weekText(s)}` : 'Timesheet'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <p className="hint" style={FLUSH}>
        Assigned <When at={t.assignedAt} />
      </p>
      {s ? (
        <>
          <dl className="kv">
            <Item term="Revision">{s.currentRevision}</Item>
            <Item term="Time">{hm(s.totalMinutes)}</Item>
            <Item term="Due">{formatDate(s.dueDate)}</Item>
            <Item term="Submission">{s.revisionLate === true ? <Badge tone="warn">submitted late</Badge> : lateText(s.revisionLate)}</Item>
          </dl>
          {canRead && (
            <div>
              <Link to={PATHS.timesheet(s.id)}>Open the lines of {s.employeeName}’s week</Link>
            </div>
          )}
          <label>
            Decision reason (required to return or reject)
            <textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          <Problem text={problem} />
          <div className="row">
            <button type="button" disabled={busy} onClick={() => send('APPROVE')}>
              Approve
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => send('RETURN')}>
              Return for changes
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => send('REJECT')}>
              Reject
            </button>
          </div>
          <Refusal error={decide.error} act="decide" />
        </>
      ) : (
        <Empty>This timesheet is not available in the selected role’s scope.</Empty>
      )}
    </li>
  );
}

function ReopenScreen() {
  return <ReopenDecisionQueue />;
}

/** F1: the independent HR reviewer's open reopen requests (never the requester, the employee or an earlier decider). */
function ReopenDecisionQueue() {
  const { can } = useSession();
  const keys = useKeys();
  const tasks = useQuery({ queryKey: keys.reopenTasks, queryFn: () => api<{ items: ReopenTask[] }>('/v1/timesheet-reopen-tasks'), enabled: can(TS_REOPEN), retry: retryTransient });
  const { region, gone, notice, finished } = useQueueState(keys.reopenTasks);
  if (!can(TS_REOPEN)) return <NotPermitted>The selected role cannot decide timesheet reopen requests.</NotPermitted>;
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => !gone.has(t.taskId));
  return (
    <div ref={region} role="region" aria-label="Timesheet reopen requests" tabIndex={-1}>
      <Section title={`Timesheet reopen requests${data ? ` (${items.length})` : ''}`}>
        <p className="hint">Approving opens a correction as a new draft revision with the approved lines carried over; the approved revision stays in force until its correction is approved. Rejecting needs a reason.</p>
        {tasks.isPending && <p className="hint loading">Loading the reopen requests waiting for you…</p>}
        <ReadProblem error={tasks.error} what="reopen requests" />
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>No reopen requests are waiting for your decision.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Reopen requests waiting for your decision">
            {items.map((t) => (
              <ReopenTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ReopenTaskItem({ task: t, onFinished }: { task: ReopenTask; onFinished: (taskId: string, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  // The queue needs only the reopen key; the timesheet screen behind the link needs the read key as well.
  const canRead = can(TS_READ);
  const id = useId();
  const r = t.request;
  const attempt = useAttemptKey('timesheet-reopen');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const who = r ? `${r.employeeName} (${r.employeeCode}) for ${weekText(r)}` : 'the employee';
  const decide = useMutation({
    mutationFn: (body: { decision: string; reason?: string; idempotencyKey: string }) => api<ReopenDecided>(`/v1/timesheet-reopen-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.clear();
      const text = result.replayed
        ? `Your earlier decision on the reopen request of ${who} had already been recorded, so nothing was applied twice.`
        : result.state === 'APPROVED'
          ? `Reopened the timesheet of ${who}: revision ${result.newRevision ?? '—'} is open as a draft for the correction.`
          : `Rejected the reopen request of ${who}; the approved revision stays in force.`;
      onFinished(t.taskId, text, true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.clear();
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t.taskId, refusalText(error, 'reopen-decide') ?? error.message, false);
    },
  });
  const busy = decide.isPending;
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (busy || !r) return;
    const text = reason.trim();
    if (decision === 'REJECT' && !text) {
      setProblem('Enter a reason to reject the reopen request.');
      decide.reset();
      return;
    }
    setProblem(null);
    decide.mutate({ decision, idempotencyKey: attempt.keyFor(`${decision}|${text}`), ...(text ? { reason: text } : {}) });
  };
  return (
    <li aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} style={H3}>
        {r ? `Reopen ${r.employeeName} (${r.employeeCode}): ${weekText(r)}` : 'Reopen request'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <p className="hint" style={FLUSH}>
        Assigned <When at={t.assignedAt} />
      </p>
      {r ? (
        <>
          <dl className="kv">
            <Item term="Approved revision">{r.approvedRevision}</Item>
            <Item term="Requested">
              <When at={r.requestedAt} />
            </Item>
            <Item term="Reason given">{r.reason}</Item>
          </dl>
          {canRead && (
            <div>
              <Link to={PATHS.timesheet(r.timesheetId)}>Open the timesheet of {r.employeeName}</Link>
            </div>
          )}
          <label>
            Decision reason (required to reject)
            <textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          <Problem text={problem} />
          <div className="row">
            <button type="button" disabled={busy} onClick={() => send('APPROVE')}>
              Approve reopen
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => send('REJECT')}>
              Reject reopen
            </button>
          </div>
          <Refusal error={decide.error} act="reopen-decide" />
        </>
      ) : (
        <Empty>This reopen request is not available in the selected role’s scope.</Empty>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: missed submissions (BR-049: a reminder and a pending follow-up, never a penalty)
// ---------------------------------------------------------------------------------------------------------
function missedText(x: MissedWeek): string {
  if (x.state === 'OPEN') return 'Open: not submitted yet';
  if (x.resolution === 'SUBMITTED') return 'Resolved: submitted late';
  if (x.resolution === 'DOCUMENTED') return 'Resolved with a documented reason';
  return readable(x.state);
}

function MissedScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const [state, setState] = useState('OPEN');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = new URLSearchParams(Object.entries({ state, from, to }).filter(([, v]) => v !== '')).toString();
  // FR-056: one page at a time (back to the first page when a filter changes); `total` counts every match in scope.
  const [paging, setPaging] = useState({ query, page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const list = useQuery({
    queryKey: keys.missedList(`${query}#${page}`),
    queryFn: () => api<{ items: MissedWeek[]; total?: number }>(`/v1/timesheet-exceptions?${query ? `${query}&` : ''}${pageParams(page)}`),
    enabled: can(TS_READ),
    retry: retryTransient,
  });
  if (!can(TS_READ)) return <NotPermitted>The selected role cannot see missed timesheets.</NotPermitted>;
  const data = shown(list);
  return (
    <Section title="Missed timesheets">
      <p className="hint">A week that was due and not submitted raises one reminder to the employee and a follow-up here. It is never a deduction or a penalty; a late submission resolves it.</p>
      <div className="row">
        <label>
          Status
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">All</option>
            <option value="OPEN">Open</option>
            <option value="RESOLVED">Resolved</option>
          </select>
        </label>
        <label>
          Weeks from
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Weeks to
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <ReadProblem error={list.error} what="missed timesheets" />
      {list.isPending && <p className="hint loading">Loading missed timesheets…</p>}
      {data && data.items.length === 0 && <Empty>No missed timesheets match.</Empty>}
      {data && data.items.length > 0 && (
        <ul className="tasks" aria-label="Missed timesheets">
          {data.items.map((x) => (
            <MissedItem key={x.id} x={x} />
          ))}
        </ul>
      )}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={(p) => setPaging({ query, page: p })} label="Missed timesheet pages" noun="missed timesheet" />}
    </Section>
  );
}

function MissedItem({ x }: { x: MissedWeek }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const resolve = useMutation({
    mutationFn: (body: { reason: string }) => api<MissedWeek>(`/v1/timesheet-exceptions/${encodeURIComponent(x.id)}/resolve`, { body }),
    onSuccess: () => {
      setReason('');
      void qc.invalidateQueries({ queryKey: keys.missed });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (resolve.isPending) return;
    if (!reason.trim()) {
      setProblem('Enter the documented reason for resolving the reminder.');
      return;
    }
    setProblem(null);
    resolve.mutate({ reason: reason.trim() });
  };
  return (
    <li aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} style={H3}>
        {x.employeeName} ({x.employeeCode}): {weekText(x)}
      </h3>
      <p style={FLUSH}>
        Due {formatDate(x.dueDate)} · reminder raised {formatDate(x.raisedOn)} · {missedText(x)}
        {x.resolvedAt && (
          <>
            {' '}
            on <When at={x.resolvedAt} />
          </>
        )}
      </p>
      {x.resolutionReason && <p className="hint" style={FLUSH}>Reason: {x.resolutionReason}</p>}
      {x.timesheetId && <Link to={PATHS.timesheet(x.timesheetId)}>Open the submitted timesheet</Link>}
      {x.state === 'OPEN' && can(TS_RESOLVE) && (
        <form aria-label={`Resolve the reminder of ${x.employeeCode} for ${formatDate(x.periodStart)}`} onSubmit={submit} noValidate className="stack">
          <label>
            Documented resolution reason
            <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          <Problem text={problem} />
          <Refusal error={resolve.error} act="resolve" />
          <div>
            <button type="submit" disabled={resolve.isPending}>
              Resolve reminder
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: reports (FR-048; approved time in force only; utilisation exactly as the API returns it)
// ---------------------------------------------------------------------------------------------------------
function ReportsScreen() {
  const { can } = useSession();
  if (!can(TS_REPORT)) return <NotPermitted>The selected role cannot run timesheet reports.</NotPermitted>;
  return (
    <div className="stack">
      <HoursReportSection />
      <UtilisationSection />
    </div>
  );
}

function groupCell(g: HoursGroup, d: Dimension): string {
  const s = (k: string) => (g[k] === null || g[k] === undefined ? '' : String(g[k]));
  if (d === 'employee') return `${s('employeeName')} (${s('employeeCode')})`;
  if (d === 'project') return `${s('projectCode')}: ${s('projectName')}`;
  if (d === 'job') return `${s('jobProjectCode')} / ${s('jobCode')}: ${s('jobName')}`;
  if (d === 'activity') return `${s('activityCode')}: ${s('activityName')}`;
  return `Week of ${formatDate(s('periodStart'))}`;
}

function HoursReportSection() {
  const { can } = useSession();
  const keys = useKeys();
  const masters = can(MASTER_READ);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState<Dimension[]>(['employee']);
  const [projectId, setProjectId] = useState('');
  const [activityId, setActivityId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [showLines, setShowLines] = useState(false);
  // FR-056: the groups and the lines page separately; the totals always cover every line in scope (computed by the API).
  const [groupPage, setGroupPage] = useState(1);
  const [linePage, setLinePage] = useState(1);
  const projects = useQuery({ queryKey: keys.projectList(''), queryFn: () => api<{ items: Project[] }>('/v1/timesheet/projects'), enabled: masters, retry: retryTransient });
  const activities = useQuery({ queryKey: keys.activityList(''), queryFn: () => api<{ items: Activity[] }>('/v1/timesheet/activities'), enabled: masters, retry: retryTransient });
  const report = useQuery({
    queryKey: keys.report('hours', `${query ?? ''}#${groupPage}`),
    queryFn: () => api<HoursReport>(`/v1/timesheet-reports/hours?${query ?? ''}&${pageParams(groupPage)}`),
    enabled: query !== null,
    retry: retryTransient,
  });
  const filters = query === null ? '' : new URLSearchParams([...new URLSearchParams(query)].filter(([k]) => k !== 'groupBy')).toString();
  const lines = useQuery({
    queryKey: keys.report('lines', `${filters}#${linePage}`),
    queryFn: () => api<{ items: ReportLine[]; total?: number }>(`/v1/timesheet-reports/lines?${filters}&${pageParams(linePage)}`),
    enabled: query !== null && showLines,
    retry: retryTransient,
  });
  const run = (e: FormEvent) => {
    e.preventDefault();
    if (!from || !to || groupBy.length === 0) {
      setProblem('Enter the range and group by at least one of employee, project, job, activity or week.');
      return;
    }
    setProblem(null);
    setShowLines(false);
    setGroupPage(1);
    setLinePage(1);
    const p = new URLSearchParams({ from, to, groupBy: DIMENSIONS.filter((d) => groupBy.includes(d)).join(',') });
    if (projectId) p.set('projectId', projectId);
    if (activityId) p.set('activityId', activityId);
    setQuery(p.toString());
  };
  const toggle = (d: Dimension) => setGroupBy((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  const data = shown(report);
  return (
    <Section title="Hours">
      <p className="hint">Approved time only, from the latest approved version of each timesheet. The totals add up to the lines below.</p>
      <form className="grid-form" aria-label="Hours report" onSubmit={run} noValidate>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <fieldset className="wide">
          <legend>Group by</legend>
          {DIMENSIONS.map((d) => (
            <label key={d} className="check">
              <input type="checkbox" checked={groupBy.includes(d)} onChange={() => toggle(d)} /> {DIMENSION_LABEL[d]}
            </label>
          ))}
        </fieldset>
        {masters && (
          <>
            <label>
              Project filter
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">All projects</option>
                {(shown(projects)?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code}: {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Activity filter
              <select value={activityId} onChange={(e) => setActivityId(e.target.value)}>
                <option value="">All activities</option>
                {(shown(activities)?.items ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code}: {a.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="wide">
          <Problem text={problem} />
          <button type="submit">Show hours</button>
        </div>
      </form>
      {report.isFetching && <p className="hint loading">Loading the report…</p>}
      <Refusal error={report.error} act="report" />
      {data && (
        <>
          <p className="hint">
            {formatDate(data.from)} to {formatDate(data.to)} · basis: {data.basis === 'APPROVED' ? 'approved time in force' : readable(data.basis)}
          </p>
          {data.groups.length === 0 ? (
            <Empty>No approved time in this range.</Empty>
          ) : (
            <div style={SCROLL}>
              <table aria-label="Hours by group">
                <thead>
                  <tr>
                    {data.groupBy.map((d) => (
                      <th key={d}>{DIMENSION_LABEL[d]}</th>
                    ))}
                    <th>Hours</th>
                    <th>Minutes</th>
                    <th>Productive minutes</th>
                    <th>Lines</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((g, i) => (
                    <tr key={i}>
                      {data.groupBy.map((d) => (
                        <td key={d}>{groupCell(g, d)}</td>
                      ))}
                      <td>{g.hours}</td>
                      <td>{g.minutes}</td>
                      <td>{g.productiveMinutes}</td>
                      <td>{g.lineCount}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={data.groupBy.length}>Total</th>
                    <td>{data.totals.hours}</td>
                    <td>{data.totals.minutes}</td>
                    <td>{data.totals.productiveMinutes}</td>
                    <td>{data.totals.lineCount}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {(data.totalGroups ?? data.groups.length) > LIST_PAGE_SIZE && <p className="hint">The total covers every group, not only the groups on this page.</p>}
          <Pager page={groupPage} pageSize={LIST_PAGE_SIZE} total={data.totalGroups ?? data.groups.length} onPage={setGroupPage} label="Hours group pages" noun="group" />
          <button type="button" className="secondary" onClick={() => setShowLines(true)} disabled={showLines}>
            Show the approved lines behind this report
          </button>
          {showLines && lines.isPending && <p className="hint loading">Loading the lines…</p>}
          <Refusal error={lines.error} act="report" />
          {showLines && shown(lines) && (
            <div style={SCROLL}>
              <table aria-label="Approved lines">
                <thead>
                  <tr>
                    <th>Work date</th>
                    <th>Employee</th>
                    <th>Project / job / activity</th>
                    <th>Revision</th>
                    <th>Minutes</th>
                    <th>Productive</th>
                  </tr>
                </thead>
                <tbody>
                  {shown(lines)!.items.map((l) => (
                    <tr key={l.id}>
                      <td>{formatDate(l.workDate)}</td>
                      <td>{l.employeeCode}</td>
                      <td>
                        {l.projectCode} / {l.jobCode} / {l.activityCode}
                      </td>
                      <td>{l.revision}</td>
                      <td>{l.minutes}</td>
                      <td>{l.productive ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {showLines && shown(lines) && (
            <Pager page={linePage} pageSize={LIST_PAGE_SIZE} total={shown(lines)!.total ?? shown(lines)!.items.length} onPage={setLinePage} label="Approved line pages" noun="line" />
          )}
        </>
      )}
    </Section>
  );
}

function UtilisationValue({ u }: { u: UtilisationItem }) {
  if (u.status === 'OK') return <>{u.utilisationPercent}%</>;
  if (u.status === 'NOT_APPLICABLE') return <>{u.display ?? 'N/A'} (no scheduled hours)</>;
  return (
    <>
      <Badge tone="warn">not configured</Badge>
      <div className="hint">
        {u.message ?? 'The scheduled hours are not known.'}
        {u.unscheduledDays !== undefined && ` (${u.unscheduledDays} working days without a shift)`}
      </div>
    </>
  );
}

function UtilisationSection() {
  const keys = useKeys();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  // FR-056: the employees page; the totals always cover every employee in scope (computed by the API).
  const [page, setPage] = useState(1);
  const report = useQuery({
    queryKey: keys.report('utilisation', `${query ?? ''}#${page}`),
    queryFn: () => api<UtilisationReport>(`/v1/timesheet-reports/utilisation?${query ?? ''}&${pageParams(page)}`),
    enabled: query !== null,
    retry: retryTransient,
  });
  const run = (e: FormEvent) => {
    e.preventDefault();
    if (!from || !to) {
      setProblem('Enter the range.');
      return;
    }
    setProblem(null);
    setQuery(new URLSearchParams({ from, to }).toString());
    setPage(1);
  };
  const data = shown(report);
  return (
    <Section title="Utilisation">
      <form className="grid-form" aria-label="Utilisation report" onSubmit={run} noValidate>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="wide">
          <Problem text={problem} />
          <button type="submit">Show utilisation</button>
        </div>
      </form>
      {report.isFetching && <p className="hint loading">Loading the report…</p>}
      <Refusal error={report.error} act="report" />
      {data && (
        <>
          <p className="hint">
            Formula: {data.formula}. Schedule: {data.scheduleBasis}.
          </p>
          {data.items.length === 0 ? (
            <Empty>No employee in scope had an allocation or approved time in this range.</Empty>
          ) : (
            <div style={SCROLL}>
              <table aria-label="Utilisation by employee">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Approved minutes</th>
                    <th>Productive minutes</th>
                    <th>Scheduled minutes</th>
                    <th>Utilisation</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((u) => (
                    <tr key={u.employeeId}>
                      <td>
                        {u.employeeName} ({u.employeeCode})
                      </td>
                      <td>{u.approvedMinutes}</td>
                      <td>{u.productiveMinutes}</td>
                      <td>{u.scheduledMinutes ?? '—'}</td>
                      <td>
                        <UtilisationValue u={u} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                {data.totals && (
                  <tfoot>
                    <tr>
                      <th>{`All ${data.totals.employees} employees in scope`}</th>
                      <td>{data.totals.approvedMinutes}</td>
                      <td>{data.totals.productiveMinutes}</td>
                      <td>{data.totals.scheduledMinutes ?? 'not known'}</td>
                      <td>{`${data.totals.byStatus.OK ?? 0} OK · ${data.totals.byStatus.NOT_APPLICABLE ?? 0} N/A · ${data.totals.byStatus.NOT_CONFIGURED ?? 0} not configured`}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={setPage} label="Utilisation pages" noun="employee" />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screens: allocation and timesheet-entry imports (FR-046 bulk upload; FR-047 imported entries; DF09; FR-106)
// ---------------------------------------------------------------------------------------------------------

/**
 * A timesheet batch template (allocations.ts ALLOCATION_IMPORT_SPEC, line-import.ts LINE_IMPORT_SPEC). The API serves
 * no template file, so the screen states the exact header and what each column holds.
 */
interface TimesheetImport extends ImportTemplate {
  /** The idempotency-key prefix of an upload. */
  keyPrefix: string;
  /** Shown instead of the form when the selected role lacks one of `permissions`. */
  notPermitted: string;
  /** The server's 403 on an upload, in plain words. */
  forbidden: string;
  /** The lists a committed batch changes. */
  changes: (keys: Keys) => readonly (readonly unknown[])[];
}

const COLUMN_COUNT_TEXT = 'The row does not have exactly one cell for each column of the header.';
const OUT_OF_SCOPE_TEXT = 'The employee is outside the scope of your role.';

/** RESOURCE_ALLOCATION_V1 row problems: allocations.ts (its import spec and createAllocation) and imports/batch.ts. */
const ALLOCATION_ROW_PROBLEMS: Record<string, string> = {
  INVALID_DATE: 'startDate or endDate is not a valid calendar date (YYYY-MM-DD).',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  UNKNOWN_PROJECT: 'No project has this project code.',
  UNKNOWN_JOB: 'The project has no job with this job code.',
  OUT_OF_SCOPE: OUT_OF_SCOPE_TEXT,
  INVALID_PERIOD: 'endDate is before startDate.',
  INVALID_PERCENT: 'allocationPercent must be more than 0 and at most 100, with up to two decimals.',
  EMPLOYEE_NOT_ACTIVE: 'Only an active employee can be allocated.',
  OUTSIDE_EMPLOYMENT: 'The interval is outside the employment (joining date to last working date).',
  INACTIVE_MASTER: 'The job or its project is not active.',
  INVALID_PROJECT_DATES: 'The interval must lie within the job’s and the project’s validity periods.',
  DUPLICATE_ALLOCATION: 'The employee is already allocated to this job for an overlapping interval, by an existing allocation or an earlier row of this file.',
  OVER_ALLOCATED:
    'The employee would be allocated above 100% on a day of the interval, counting the existing allocations and the earlier rows of this file. Above 100% needs an over-allocation exception, recorded with a reason by the employee’s direct manager; an import cannot record one.',
  COLUMN_COUNT: COLUMN_COUNT_TEXT,
};

/** TIMESHEET_LINES_V1 row problems: line-import.ts, the manual entry rules it shares (sheets.ts) and imports/batch.ts. */
const LINE_ROW_PROBLEMS: Record<string, string> = {
  INVALID_DATE: 'workDate is not a valid calendar date (YYYY-MM-DD).',
  INVALID_MINUTES: 'minutes must be whole quarter hours (15, 30, 45 and so on), at most 1440 (24 hours).',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  OUT_OF_SCOPE: OUT_OF_SCOPE_TEXT,
  UNKNOWN_PROJECT: 'No project has this project code.',
  UNKNOWN_JOB: 'The project has no job with this job code.',
  UNKNOWN_ACTIVITY: 'No activity has this activity code.',
  PERIOD_IN_FUTURE: 'The week of workDate has not started yet; time is recorded only for a week that has started.',
  EMPLOYEE_NOT_ACTIVE: 'Only an active employee records time.',
  OUTSIDE_EMPLOYMENT: 'The work date is outside the employment (joining date to last working date).',
  TIMESHEET_NOT_EDITABLE: 'The employee’s timesheet for that week is not a draft revision, so no line can be added to it. An approved timesheet is corrected only through a reopen request.',
  WORK_DATE_IN_FUTURE: 'Time is recorded only for days already worked.',
  INACTIVE_MASTER: 'The project, job or activity is not active.',
  MASTER_OUT_OF_PERIOD: 'The project, job or activity is not valid on the work date.',
  ACTIVITY_NOT_PERMITTED: 'The job does not permit this activity.',
  NO_ACTIVE_ALLOCATION: 'The employee is not allocated to this job on the work date.',
  DUPLICATE_LINE: 'The employee’s timesheet already has a line for this day, job and activity, or an earlier row of this file adds one.',
  DAILY_LIMIT_EXCEEDED: 'The employee’s lines of this day would total more than 24 hours, counting the lines already recorded and the earlier rows of this file.',
  COLUMN_COUNT: COLUMN_COUNT_TEXT,
};

const ALLOCATION_IMPORT: TimesheetImport = {
  code: 'RESOURCE_ALLOCATION_V1',
  label: 'Allocation import',
  permissions: [ALLOC_IMPORT, ALLOC_MANAGE],
  base: '/v1/timesheet/allocation-imports',
  columns: 'employeeCode,projectCode,jobCode,startDate,endDate,allocationPercent',
  keyLabel: 'Employee @ project/job @ start date',
  noun: ['allocation', 'allocations'],
  verb: 'Create',
  note:
    'Each row allocates the employee with that employee code to a job, named by its project code and job code, from startDate to endDate (YYYY-MM-DD, both days included) at allocationPercent of the employee’s daily capacity (more than 0 and at most 100, up to two decimals). Every row meets the same rules as an allocation entered by hand, counted together with the existing allocations and the rows before it; an import cannot record an over-allocation exception. Rows apply only to employees within your role’s scope.',
  problems: ALLOCATION_ROW_PROBLEMS,
  keyPrefix: 'allocation-import',
  notPermitted: 'The selected role cannot import resource allocations: that needs the allocation import duty and the allocation manage duty, under which every row is applied.',
  forbidden: 'The selected role cannot import resource allocations: that needs the allocation import duty and the allocation manage duty.',
  changes: (keys) => [keys.allocations],
};

const LINE_IMPORT: TimesheetImport = {
  code: 'TIMESHEET_LINES_V1',
  label: 'Timesheet entry import',
  permissions: [TS_IMPORT],
  base: '/v1/timesheet/line-imports',
  columns: 'employeeCode,workDate,projectCode,jobCode,activityCode,minutes,note',
  keyLabel: 'Employee @ work date @ project/job/activity',
  noun: ['timesheet line', 'timesheet lines'],
  verb: 'Record',
  note:
    'Each row records the minutes (whole quarter hours, 15 to 1440) the employee with that employee code worked on workDate (YYYY-MM-DD) on a job, named by its project code and job code, under activityCode; note may be left blank. The line goes into the employee’s draft timesheet of that Monday to Sunday week, which is opened when it does not exist yet; the employee still reviews and submits it. Every row meets the same rules as a line entered by hand, including the allocation to the job and the 24-hour day counted with the lines already recorded and the rows before it. Rows apply only to employees within your role’s scope.',
  problems: LINE_ROW_PROBLEMS,
  keyPrefix: 'line-import',
  notPermitted: 'The selected role cannot import timesheet entries: that needs the timesheet import duty.',
  forbidden: 'The selected role cannot import timesheet entries: that needs the timesheet import duty.',
  changes: (keys) => [keys.sheets, keys.own],
};

/** File-level refusals of an upload or a scan check (imports/jobs.ts, imports/batch.ts, the route's body limit). */
const IMPORT_UPLOAD_WORDS: Record<string, string> = {
  FILE_QUARANTINED: 'The malware scan flagged this file, so nothing in it was read or imported. Upload a clean copy of the file.',
  INVALID_FILE: 'The file is not a valid UTF-8 CSV file.',
  EMPTY_FILE: 'The file has no data rows below its header.',
  TOO_MANY_ROWS: 'A batch holds at most 10,000 rows; split the file.',
  FILE_SIZE: 'An import file must be between 1 byte and 10 MB.',
  PAYLOAD_TOO_LARGE: 'The file is larger than 10 MB.',
  IDEMPOTENCY_KEY_IN_USE: 'This upload could not be matched to your earlier one. Validate the file again to send it as a new upload.',
  FILE_INTEGRITY: 'The file stored for this batch no longer matches what was uploaded, so it was not read. Cancel this import and upload the file again.',
  INVALID_REQUEST: 'The file name cannot contain / \\ < > : " | ? * or control characters, and the file cannot be empty.',
};

function importRefusalText(error: unknown, t: TimesheetImport): string | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === 'INVALID_HEADER') return `The first line of the file must be exactly the header ${t.columns}.`;
  if (error.code === 'FORBIDDEN') return t.forbidden;
  return IMPORT_UPLOAD_WORDS[error.code] ?? null;
}

function ImportRefusal({ error, t }: { error: unknown; t: TimesheetImport }) {
  if (!error) return null;
  const text = importRefusalText(error, t);
  if (text === null) return <ErrorNote error={error} />;
  return (
    <div role="alert" className="error">
      {text}
      <div className="hint">{(error as ApiError).code}</div>
    </div>
  );
}

function AllocationImportScreen() {
  return <ImportScreen t={ALLOCATION_IMPORT} />;
}

function LineImportScreen() {
  return <ImportScreen t={LINE_IMPORT} />;
}

/**
 * Shown only with every key the template's routes require. A role switch starts the screen afresh (keyed by the role
 * context), so a batch previewed under one assignment is never committed under another.
 */
function ImportScreen({ t }: { t: TimesheetImport }) {
  const { can } = useSession();
  const context = useRoleContext();
  if (!t.permissions.every((p) => can(p))) return <NotPermitted>{t.notPermitted}</NotPermitted>;
  return <ImportBatch key={context} t={t} />;
}

/**
 * Upload, row-by-row preview, then an explicit commit or cancel, as the employee imports run (records.tsx): one
 * idempotency key per chosen file. A file waiting for the scan worker is held (UPLOADED) with nothing read, the normal first
 * answer; checking it again, by itself while the screen is open, resumes that batch from the file the server stored (no second
 * upload, no second batch). The user's own batches are listed below, so a held batch can be opened again after leaving the page.
 */
function ImportBatch({ t }: { t: TimesheetImport }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // Validating the same file again (after a lost answer or a double click) returns the same batch; a new file gets a new key.
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };

  // A held batch checked again (POST /:id/resume), or one of the user's batches opened from the list.
  const { resume, open, refresh, watch } = useBatchFollowUp(
    t.base,
    {
      show: setJob,
      closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
      onStart: () => {
        upload.reset();
        act.reset();
      },
    },
    job,
  );
  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const pinned = pinSession();
      try {
        return await pinned<ImportJob>(`${t.base}/${encodeURIComponent(id)}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on (this very decision went through but its answer was lost, or the batch changed
        // since the preview): its job view shows where it stands now.
        const current = await pinned<ImportJob>(`${t.base}/${encodeURIComponent(id)}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onMutate: () => {
      upload.reset();
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      if (view.state === 'COMMITTED') for (const key of t.changes(keys)) void qc.invalidateQueries({ queryKey: key });
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async ({ f, key }: { f: File; key: string }) => api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } }),
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      // The preview is on screen, so the form starts clean: the next file is a new upload with its own key.
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      // The key is someone else's: the next attempt must use a fresh one.
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
    onSettled: refresh,
  });

  // While a file is checked or a decision is on its way, nothing else starts: its answer would replace a newer view.
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!file || busy) return;
    upload.mutate({ f: file, key: (uploadKey.current ??= idempotencyKey(t.keyPrefix)) });
  };

  return (
    <div className="stack">
      <Section title={t.label}>
        <form onSubmit={submit} className="stack" aria-label={t.label}>
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}). {t.note} Nothing is applied until you commit a preview, and a batch is applied all or
            nothing: one row with a problem rejects the whole batch.
          </p>
          <TemplateDownload base={t.base} code={t.code} />
          <div className="inline">
            <label>
              Import file
              <input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={!file || busy}>
              Validate
            </button>
          </div>
        </form>
        <ImportRefusal error={upload.error ?? resume.error} t={t} />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title={`Your ${t.label.toLowerCase()} batches`} openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// My ESS TN13 (Employee OWN context): own weeks, lines, submission, decisions, allocations and reminders
// ---------------------------------------------------------------------------------------------------------
function MyTimesheetsPanel() {
  const { can } = useSession();
  const [openId, setOpenId] = useState<string | null>(null);
  if (!can(TS_READ) && !can(TS_SUBMIT)) return <NotPermitted>The selected role cannot use timesheets.</NotPermitted>;
  return (
    <div className="stack">
      <MyWeeks openId={openId} onOpen={setOpenId} />
      {openId && <MyWeek key={openId} id={openId} onClose={() => setOpenId(null)} />}
      {can(TS_SUBMIT) && <MyAllocations />}
      {can(TS_READ) && <MyReminders />}
      {can(TS_READ) && <MyDecisionHistory />}
      {can(TS_READ) && <OwnLaterAdjustments />}
    </div>
  );
}

function MyWeeks({ openId, onOpen }: { openId: string | null; onOpen: (id: string) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const thisMonday = mondayOf(localDate());
  const [periodStart, setPeriodStart] = useState(thisMonday);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const list = useQuery({ queryKey: keys.ownSheets, queryFn: () => api<{ items: SheetSummary[] }>('/v1/me/timesheets'), enabled: can(TS_READ), retry: retryTransient });
  const create = useMutation({
    mutationFn: (body: { periodStart: string }) => api<SheetDetail>('/v1/me/timesheets', { body }),
    onSuccess: (s) => {
      setPeriodStart(thisMonday);
      setNotice({ text: `Started your timesheet for ${weekText(s)}. Add your lines below.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.own });
      onOpen(s.id);
    },
    onError: (error) => {
      const d = error instanceof ApiError ? (error.details as { timesheetId?: string } | undefined) : undefined;
      if (error instanceof ApiError && error.code === 'TIMESHEET_EXISTS' && d?.timesheetId) onOpen(d.timesheetId);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending || !periodStart) return;
    setNotice(null);
    create.mutate({ periodStart });
  };
  const data = shown(list);
  return (
    <Section title="My timesheets">
      <p className="hint">One timesheet per Monday to Sunday week, due by the following Monday. A later submission is still accepted and flagged late.</p>
      {can(TS_SUBMIT) && (
        <form className="row" aria-label="Start a timesheet" onSubmit={submit} noValidate>
          <label>
            Week starting (Monday)
            <input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} />
          </label>
          <button type="submit" disabled={create.isPending || !periodStart}>
            Start timesheet
          </button>
        </form>
      )}
      <Refusal error={create.error} act="week" />
      <Notice notice={notice} />
      <ReadProblem error={list.error} what="your timesheets" />
      {list.isPending && can(TS_READ) && <p className="hint loading">Loading your timesheets…</p>}
      {data && data.items.length === 0 && <Empty>You have no timesheets yet.</Empty>}
      {data && data.items.length > 0 && <SheetTable items={data.items} onOpen={onOpen} />}
      {openId && data && !data.items.some((s) => s.id === openId) && <p className="hint">The week opened below is not in the list above yet.</p>}
    </Section>
  );
}

function MyWeek({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [revision, setRevision] = useState<number | null>(null);
  const [editing, setEditing] = useState<Line | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const detail = useSheet(id, revision);
  const s = shown(detail);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.sheets });
    void qc.invalidateQueries({ queryKey: keys.own });
  };
  const remove = useMutation({
    mutationFn: (lineId: string) => api<SheetDetail>(`/v1/me/timesheets/${encodeURIComponent(id)}/lines/${encodeURIComponent(lineId)}/remove`, { method: 'POST' }),
    onSuccess: () => {
      setNotice({ text: 'Removed the line; it stays on record.', ok: true });
      refresh();
    },
  });
  const submitSheet = useMutation({
    mutationFn: (body: { expectedVersion: number }) => api<{ revision: number; state: string; late: boolean }>(`/v1/me/timesheets/${encodeURIComponent(id)}/submit`, { body }),
    onSuccess: (r) => {
      setNotice({
        text: r.late
          ? `Submitted revision ${r.revision} for your manager’s decision. It was submitted after its due date, so it is flagged late; a late timesheet is still accepted.`
          : `Submitted revision ${r.revision} for your manager’s decision.`,
        ok: true,
      });
      refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError && (error.code === 'STALE_VERSION' || error.code === 'INVALID_STATE')) refresh();
    },
  });
  const revise = useMutation({
    mutationFn: () => api<SheetDetail>(`/v1/me/timesheets/${encodeURIComponent(id)}/revise`, { method: 'POST' }),
    onSuccess: (d) => {
      setRevision(null);
      setNotice({ text: `Opened revision ${d.currentRevision} as a draft with the previous lines carried over.`, ok: true });
      refresh();
    },
  });
  const current = s !== undefined && s.shownRevision === s.currentRevision;
  const editable = current && s.state === 'DRAFT' && can(TS_SUBMIT);
  const busy = remove.isPending || submitSheet.isPending || revise.isPending;
  return (
    <Section
      title={s ? `My week ${weekText(s)}` : 'My week'}
      actions={
        <button type="button" className="secondary" onClick={onClose}>
          Close the week
        </button>
      }
    >
      {detail.isPending && <p className="hint loading">Loading the week…</p>}
      <ReadProblem error={detail.error} what="this timesheet" />
      <Notice notice={notice} />
      {s && (
        <>
          <SheetFacts s={s} />
          <h3 style={H3}>Lines of revision {s.shownRevision}</h3>
          {!current && <p className="hint">An earlier revision is shown; it cannot be changed.</p>}
          <LinesTable
            s={s}
            actions={
              editable
                ? (l) => (
                    <div className="row">
                      <button type="button" className="secondary" disabled={busy} onClick={() => setEditing(l)}>
                        Change line {formatDate(l.workDate)} {l.jobCode}/{l.activityCode}
                      </button>
                      <button type="button" className="danger" disabled={busy} onClick={() => remove.mutate(l.id)}>
                        Remove line {formatDate(l.workDate)} {l.jobCode}/{l.activityCode}
                      </button>
                    </div>
                  )
                : undefined
            }
          />
          <Refusal error={remove.error} act="line" />
          {editable && editing && <EditLine key={editing.id} sheetId={id} line={editing} onDone={() => setEditing(null)} />}
          {editable && <AddLine s={s} />}
          {editable && (
            <div className="stack" style={SPACED}>
              <div>
                <button type="button" disabled={busy || s.lines.length === 0} onClick={() => submitSheet.mutate({ expectedVersion: s.version })}>
                  Submit revision {s.currentRevision}
                </button>
              </div>
              {s.lines.length === 0 && <p className="hint">Add at least one line to submit.</p>}
              <Refusal error={submitSheet.error} act="submit" />
            </div>
          )}
          {current && (s.state === 'RETURNED' || s.state === 'REJECTED') && can(TS_SUBMIT) && (
            <div className="stack" style={SPACED}>
              <p style={FLUSH}>
                {s.state === 'RETURNED' ? 'Your manager returned this timesheet for changes.' : 'Your manager rejected this revision.'} Continue in a new revision; this one stays on record.
              </p>
              <div>
                <button type="button" disabled={busy} onClick={() => revise.mutate()}>
                  Start a new revision
                </button>
              </div>
              <Refusal error={revise.error} act="revise" />
            </div>
          )}
          <h3 style={H3}>Revisions</h3>
          <RevisionTable s={s} onShow={(r) => setRevision(r === s.currentRevision ? null : r)} />
          <SheetHistory s={s} />
          {current && <ReopenRequestForm s={s} />}
        </>
      )}
    </Section>
  );
}

/** Job and activity from the own active allocations covering the work date; time in quarter hours. */
function AddLine({ s }: { s: SheetDetail }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const days = weekDays(s.periodStart);
  const allocations = useQuery({ queryKey: keys.ownAllocations, queryFn: () => api<{ items: OwnAllocation[] }>('/v1/me/timesheet-allocations'), retry: retryTransient });
  const empty = { workDate: days[0] ?? '', jobId: '', activityId: '', minutes: '', note: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const covering = (shown(allocations)?.items ?? []).filter((a) => a.startDate <= f.workDate && a.endDate >= f.workDate);
  const jobs = covering.filter((a, i) => covering.findIndex((b) => b.jobId === a.jobId) === i);
  const chosen = covering.find((a) => a.jobId === f.jobId);
  const add = useMutation({
    mutationFn: (body: { workDate: string; jobId: string; activityId: string; minutes: number; note?: string }) => api<SheetDetail & { lineId: string }>(`/v1/me/timesheets/${encodeURIComponent(s.id)}/lines`, { body }),
    onSuccess: () => {
      setF(empty);
      setNotice({ text: 'Added the line.', ok: true });
      void qc.invalidateQueries({ queryKey: keys.sheets });
      void qc.invalidateQueries({ queryKey: keys.own });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (add.isPending) return;
    setNotice(null);
    if (!f.workDate || !f.jobId || !f.activityId || !f.minutes) {
      setProblem('Choose the work date, the job, the activity and the time.');
      add.reset();
      return;
    }
    setProblem(null);
    const note = f.note.trim();
    add.mutate({ workDate: f.workDate, jobId: f.jobId, activityId: f.activityId, minutes: Number(f.minutes), ...(note ? { note } : {}) });
  };
  return (
    <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate style={SPACED}>
      <h3 id={`${id}-title`} className="wide" style={H3}>
        Add a line
      </h3>
      <label>
        Work date
        <select value={f.workDate} onChange={(e) => setF({ ...f, workDate: e.target.value, jobId: '', activityId: '' })}>
          {days.map((d, i) => (
            <option key={d} value={d}>
              {dayLabel(d, i)}
            </option>
          ))}
        </select>
      </label>
      <label>
        Job
        <select value={f.jobId} onChange={(e) => setF({ ...f, jobId: e.target.value, activityId: '' })}>
          <option value="">{jobs.length === 0 ? 'No allocation covers this day' : 'Choose…'}</option>
          {jobs.map((a) => (
            <option key={a.jobId} value={a.jobId}>
              {a.projectCode} / {a.jobCode}: {a.jobName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Activity
        <select value={f.activityId} disabled={!chosen} onChange={(e) => setF({ ...f, activityId: e.target.value })}>
          <option value="">{chosen ? 'Choose…' : 'Choose a job first'}</option>
          {(chosen?.activities ?? []).map((a) => (
            <option key={a.activityId} value={a.activityId}>
              {a.code}: {a.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Time (quarter hours)
        <select value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })}>
          <option value="">Choose…</option>
          {QUARTERS.map((m) => (
            <option key={m} value={m}>
              {hm(m)}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        Note (optional)
        <input value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} />
      </label>
      <div className="wide">
        <ReadProblem error={allocations.error} what="your allocations" />
        <Problem text={problem} />
        <Refusal error={add.error} act="line" />
        <Notice notice={notice} />
        <button type="submit" disabled={add.isPending}>
          Add line
        </button>
      </div>
    </form>
  );
}

function EditLine({ sheetId, line, onDone }: { sheetId: string; line: Line; onDone: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [minutes, setMinutes] = useState(String(line.minutes));
  const [note, setNote] = useState(line.note ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<SheetDetail>(`/v1/me/timesheets/${encodeURIComponent(sheetId)}/lines/${encodeURIComponent(line.id)}`, { method: 'PUT', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.sheets });
      void qc.invalidateQueries({ queryKey: keys.own });
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.sheets });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const body: Record<string, unknown> = { expectedVersion: line.version };
    if (Number(minutes) !== line.minutes) body.minutes = Number(minutes);
    if ((note.trim() || null) !== line.note) body.note = note.trim() || null;
    if (Object.keys(body).length < 2) {
      setProblem('Change the time or the note to save.');
      return;
    }
    setProblem(null);
    save.mutate(body);
  };
  return (
    <form className="grid-form" aria-label={`Change the line of ${formatDate(line.workDate)} ${line.jobCode}/${line.activityCode}`} onSubmit={submit} noValidate style={SPACED}>
      <label>
        New time (quarter hours)
        <select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
          {QUARTERS.map((m) => (
            <option key={m} value={m}>
              {hm(m)}
            </option>
          ))}
        </select>
      </label>
      <label className="wide">
        New note
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      </label>
      <div className="wide">
        <Problem text={problem} />
        <Refusal error={save.error} act="line" />
        <div className="row">
          <button type="submit" disabled={save.isPending}>
            Save line
          </button>
          <button type="button" className="secondary" onClick={onDone}>
            Close
          </button>
        </div>
      </div>
    </form>
  );
}

function MyAllocations() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownAllocations, queryFn: () => api<{ items: OwnAllocation[] }>('/v1/me/timesheet-allocations'), retry: retryTransient });
  const data = shown(list);
  return (
    <Section title="My allocations">
      <ReadProblem error={list.error} what="your allocations" />
      {list.isPending && <p className="hint loading">Loading your allocations…</p>}
      {data && data.items.length === 0 && <Empty>You have no active allocations, so no time can be recorded yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="My allocations">
            <thead>
              <tr>
                <th>Project and job</th>
                <th>Interval</th>
                <th>Allocation</th>
                <th>Activities you can book</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((a) => (
                <tr key={a.id}>
                  <td>
                    {a.projectCode} / {a.jobCode}: {a.jobName}
                  </td>
                  <td>
                    {formatDate(a.startDate)} to {formatDate(a.endDate)}
                  </td>
                  <td>{a.allocationPercent}%</td>
                  <td>{a.activities.map((x) => `${x.code}: ${x.name}`).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function MyReminders() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownReminders, queryFn: () => api<{ items: MissedWeek[] }>('/v1/me/timesheet-exceptions'), retry: retryTransient });
  const data = shown(list);
  return (
    <Section title="Missed-submission reminders">
      <p className="hint">A reminder only: a missed week is never a deduction or a penalty, and a late timesheet is still accepted.</p>
      <ReadProblem error={list.error} what="your reminders" />
      {list.isPending && <p className="hint loading">Loading your reminders…</p>}
      {data && data.items.length === 0 && <Empty>No reminders.</Empty>}
      {data && data.items.length > 0 && (
        <ul aria-label="My reminders">
          {data.items.map((x) => (
            <li key={x.id}>
              {x.state === 'OPEN'
                ? `Reminder: your timesheet for ${weekText(x)} was due on ${formatDate(x.dueDate)} and has not been submitted. Please submit it; it is still accepted.`
                : `${weekText(x)}: ${missedText(x)}.`}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** FR-109: own timesheet submissions with who they wait for and their decisions. */
function MyDecisionHistory() {
  const keys = useKeys();
  const history = useQuery({ queryKey: keys.ownHistory, queryFn: () => api<{ items: OwnRequest[] }>('/v1/me/requests?kind=timesheet'), retry: retryTransient });
  const data = shown(history);
  return (
    <Section title="Status and decision history">
      <ReadProblem error={history.error} what="your decision history" />
      {history.isPending && <p className="hint loading">Loading your history…</p>}
      {data && data.items.length === 0 && <Empty>No submissions yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="My timesheet decisions">
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Decisions</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.transactionId}>
                  <td>{formatDate(r.createdAt)}</td>
                  <td>
                    <StateBadge state={r.state} />
                    {r.pendingWith && <div className="hint">with {r.pendingWith}</div>}
                  </td>
                  <td>{r.decisions.length === 0 ? '—' : r.decisions.map((d) => `${DECISION_LABEL[d.decision] ?? readable(d.decision)} on ${formatDate(d.decidedAt)}`).join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires these)
// ---------------------------------------------------------------------------------------------------------

/** Screens of the timesheet module; detail screens are reached through links (nav: false). */
export const TIMESHEET_SCREENS: ScreenRoute[] = [
  { path: PATHS.masters, title: 'Projects and activities', permission: MASTER_READ, nav: true, component: MastersScreen },
  { path: '/timesheet/projects/:id', title: 'Timesheet project', permission: MASTER_READ, nav: false, component: ProjectScreen },
  { path: '/timesheet/jobs/:id', title: 'Timesheet job', permission: MASTER_READ, nav: false, component: JobScreen },
  { path: '/timesheet/activities/:id', title: 'Timesheet activity', permission: MASTER_READ, nav: false, component: ActivityScreen },
  { path: PATHS.allocations, title: 'Resource allocations', permission: ALLOC_READ, nav: true, component: AllocationsScreen },
  // The menu checks one key; the screen also needs the manage key the upload and commit require.
  { path: PATHS.allocationImports, title: 'Allocation import', permission: ALLOC_IMPORT, nav: true, component: AllocationImportScreen },
  { path: PATHS.timesheets, title: 'Timesheets', permission: TS_READ, nav: true, component: TimesheetsScreen },
  { path: '/timesheets/:id', title: 'Timesheet', permission: TS_READ, nav: false, component: TimesheetScreen },
  { path: PATHS.lineImports, title: 'Timesheet entry import', permission: TS_IMPORT, nav: true, component: LineImportScreen },
  { path: PATHS.approvals, title: 'Timesheet approvals', permission: TS_APPROVE, nav: true, component: ApprovalsScreen },
  { path: PATHS.reopens, title: 'Timesheet reopen requests', permission: TS_REOPEN, nav: true, component: ReopenScreen },
  { path: PATHS.missed, title: 'Missed timesheets', permission: TS_READ, nav: true, component: MissedScreen },
  { path: PATHS.reports, title: 'Timesheet reports', permission: TS_REPORT, nav: true, component: ReportsScreen },
];

/** H3 TN13 in the Employee OWN context (registration essTabs: /v1/me/timesheets and the own lists). */
export const TIMESHEET_ESS_PANELS: EssPanel[] = [{ tabId: 'TN13', component: MyTimesheetsPanel }];

/** The decision queues, also shown on the approvals and reopen screens. */
export const TIMESHEET_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: TS_APPROVE, title: 'Timesheet approvals', component: TimesheetDecisionQueue },
  { permission: TS_REOPEN, title: 'Timesheet reopen requests', component: ReopenDecisionQueue },
];
