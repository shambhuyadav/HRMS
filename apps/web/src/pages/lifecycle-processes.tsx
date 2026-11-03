// Employee processes and exit (FR-015, FR-016, FR-018 restricted remarks and notes; FR-051 as built; F1 "Exit and
// employee processes"; DF02; DF03; DF08; C4; ZT07; H3 own-record context).
//
// Process templates (FR-015): HR-controlled checklists of ordered tasks, each with exactly one owner (a role or a named
// user), an explicit required or optional flag, a due offset from the process's effective date and an evidence rule.
// A template is edited as its DRAFT revision, whose tasks are replaced as a whole against the draft's version;
// publishing freezes the draft and retires the revision published before. A template is renamed, deactivated or
// activated again against its version.
// Employee processes (FR-016): HR starts a published template for an employee in scope; its tasks are copied with their
// due dates, so a later revision never rewrites a running process. A task's owner completes it, with a remark and, where
// the task asks for it, an evidence file that nobody can open until the malware scan releases it; the owner skips an
// optional task with a reason. Completion records the actor and the business date. HR reassigns an open task (the
// prior owner stays in the history), reopens a done task or a closed process with a reason (its own duty), closes a
// process once every required task is complete and cancels an open one with a reason. Remarks and reasons are
// restricted (FR-018): they appear only when the server returned them. Restricted HR notes and warnings are
// append-only; a correction supersedes the earlier note.
// Exit (FR-051, F1): the employee resigns in their Employee OWN context with a proposed last working date; the direct
// manager (HR when the manager cannot) recommends the inclusive last working date; an independent HR Administrator
// approves it, possibly with another date, or does not approve it with a private reason and a message for the employee.
// Before that decision the employee withdraws the resignation; afterwards a withdrawal is a request that an independent
// HR Administrator decides. HR records the contractual notice period (a configured field: nothing monetary is derived
// from it here), starts the exit clearance checklist from an EXIT template and records the final release once every
// required clearance task is complete. States, the employee's NOTICE and separation status changes and every step are
// shown as the server returned them.
// The server authorises every call and decides every rule; these screens hide what the selected assignment cannot use,
// show only what the server returned and say its refusals in plain words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentType, type CSSProperties, type FormEvent, type ReactNode, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, download, fileToBase64, formatDate, idempotencyKey } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { type MeContext, useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, nextSort, Pager, pageParams, Section, SortHeader, type SortState, sortParams, StateBadge } from '../ui';
import { DelegatedBadge } from './delegations';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/lifecycle/registration.ts; migration 0038_lifecycle.sql; the requireAccess calls of
// process-routes.ts and exit-routes.ts) and screen paths
// ---------------------------------------------------------------------------------------------------------
const TEMPLATE_READ = 'lifecycle_process.read.operational';
const TEMPLATE_MANAGE = 'lifecycle_process.manage.operational';
const PROCESS_READ = 'employee_process.read.operational';
const PROCESS_MANAGE = 'employee_process.manage.operational';
const TASK_COMPLETE = 'employee_process.complete_task.operational';
const PROCESS_REOPEN = 'employee_process.reopen.operational';
const EVIDENCE_READ = 'employee_process.read_evidence.evidence';
const NOTE_READ = 'employee_note.read.restricted';
const NOTE_WRITE = 'employee_note.write.restricted';
const EXIT_SUBMIT = 'exit.submit.operational';
const EXIT_READ = 'exit.read.operational';
const EXIT_RECOMMEND = 'exit.recommend.operational';
const EXIT_APPROVE = 'exit.approve.operational';
const EXIT_MANAGE = 'exit.manage.operational';
/** GET /v1/employees: the employee search. */
const EMPLOYEE_LIST = 'employee.list.operational';
/** GET /v1/employees/:id: the employee's name on their lifecycle screen. */
const EMPLOYEE_READ = 'employee.read.operational';

const PATHS = {
  templates: '/lifecycle/process-templates',
  template: (id: string) => `/lifecycle/process-templates/${id}`,
  processes: '/lifecycle/processes',
  process: (id: string) => `/lifecycle/processes/${id}`,
  employee: (id: string) => `/lifecycle/employees/${id}`,
  exits: '/lifecycle/exits',
  exit: (id: string) => `/lifecycle/exits/${id}`,
  myResignation: '/me/resignation',
  myProcesses: '/me/processes',
} as const;

/** The Employee role in OWN scope is the own-ESS context (BR-055; access/authorize.ts OWN_ESS_ROLE_CODES). */
const OWN_ESS_ROLE = 'EMPLOYEE';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Template, task and process codes (process-routes.ts `code`). */
const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
/** Process types and owner role codes. */
const LONG_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
/** Exit reason codes (exit-routes.ts). */
const REASON_CODE = /^[A-Z0-9][A-Z0-9_]{0,59}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Upload file names: no path separators, reserved characters or control characters (storage/files.ts). */
// eslint-disable-next-line no-control-regex
const FILE_NAME = /^[^/\\<>:"|?*\u0000-\u001f\u007f]+$/;
const MAX_FILE_NAME = 255;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TASKS = 200;
const MAX_NAME = 200;
const MAX_REASON = 1000;
const MAX_REMARK = 2000;
const MAX_NOTE = 4000;
const DUE_OFFSET_LIMIT = 3650;
const NOTICE_DAYS_LIMIT = 3650;
/**
 * FR-056: the exit, process, task and note lists are read a page at a time (page/pageSize); every answer carries the
 * total of every match in scope, so nothing beyond a fixed limit is silently left out.
 */
interface Paged<T> {
  items: T[];
  total?: number;
}
/** The total of a paged answer (an older answer without one counts its items). */
const totalOf = (p: Paged<unknown>) => p.total ?? p.items.length;
const pagedUrl = (path: string, page: number, query?: URLSearchParams) => `${path}?${query && query.toString() ? `${query.toString()}&` : ''}${pageParams(page)}`;
/** GET /v1/employees accepts page sizes of 25, 50 or 100. */
const EMPLOYEE_PAGE_SIZE = 25;
const EXIT_TYPE = 'EXIT';

/** The LIFECYCLE_PROCESS_TYPE values the module seeds (FR-015 target examples); a company may add others. */
const PROCESS_TYPES: readonly (readonly [code: string, label: string])[] = [
  ['ONBOARDING', 'Onboarding'],
  ['PROBATION_CONFIRMATION', 'Probation confirmation'],
  ['TRANSFER', 'Transfer'],
  ['PROMOTION', 'Promotion'],
  ['EXIT', 'Exit clearance'],
];
/**
 * Roles whose duties include completing process tasks (registration.ts). No route lists a company's roles to HR, so
 * these are suggestions: any role code may be typed and the server refuses one that cannot complete tasks.
 */
const OWNER_ROLES: readonly (readonly [code: string, label: string])[] = [
  ['HR_ADMINISTRATOR', 'HR Administrator'],
  ['REPORTING_MANAGER', 'Reporting manager'],
  ['EMPLOYEE', 'Employee'],
  ['SYSTEM_ADMINISTRATOR', 'System Administrator'],
  ['PAYROLL_OPERATOR', 'Payroll operator'],
  ['FINANCE_REVIEWER', 'Finance reviewer'],
];
/** The exit states GET /v1/exit-cases filters by. */
const EXIT_STATES = ['SUBMITTED', 'RECOMMENDED', 'APPROVED', 'SEPARATED', 'REJECTED', 'WITHDRAWN'] as const;
const OPEN_EXIT_STATES: ReadonlySet<string> = new Set(['SUBMITTED', 'RECOMMENDED', 'APPROVED']);

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/lifecycle/templates.ts, processes.ts, exit.ts, notes.ts)
// ---------------------------------------------------------------------------------------------------------
interface TemplateSummary {
  id: string;
  code: string;
  name: string;
  processType: string;
  active: boolean;
  version: number;
  publishedRevision: number | null;
  draftRevision: number | null;
}
interface TemplateTask {
  sequence: number;
  code: string;
  title: string;
  ownerRoleCode: string | null;
  ownerUserId: string | null;
  required: boolean;
  dueOffsetDays: number;
  evidenceRequired: boolean;
}
interface TemplateRevision {
  revision: number;
  /** DRAFT, PUBLISHED or RETIRED. */
  state: string;
  publishedAt: string | null;
  version: number;
  tasks: TemplateTask[];
}
interface TemplateDetail {
  id: string;
  code: string;
  name: string;
  processType: string;
  active: boolean;
  version: number;
  revisions: TemplateRevision[];
}
/** A task as POST /v1/lifecycle-processes and PUT .../draft take it: exactly one owner. */
type TemplateTaskInput = { code: string; title: string; required: boolean; dueOffsetDays: number; evidenceRequired: boolean } & (
  | { ownerRoleCode: string }
  | { ownerUserId: string }
);

/** FR-106: an upload is served only once the malware scan has released it (CLEAN). */
type ScanState = 'PENDING_SCAN' | 'CLEAN' | 'QUARANTINED' | null;
interface ProcessTask {
  id: string;
  sequence: number;
  code: string;
  title: string;
  ownerRoleCode: string | null;
  ownerUserId: string | null;
  /** The named owner's employee name, when that user is linked to an employee. */
  ownerName: string | null;
  required: boolean;
  evidenceRequired: boolean;
  dueDate: string;
  /** OPEN, COMPLETED or SKIPPED. */
  state: string;
  /** Derived by the server: due before the company business date, still open in an open process. */
  overdue: boolean;
  doneAt: string | null;
  doneOn: string | null;
  doneBy: string | null;
  hasEvidence: boolean;
  evidenceScanState: ScanState;
  version: number;
}
interface OwnerRef {
  roleCode: string | null;
  userId: string | null;
}
interface ProcessEvent {
  action: string;
  taskCode: string | null;
  fromState: string | null;
  toState: string | null;
  priorOwner: OwnerRef | null;
  newOwner: OwnerRef | null;
  hasEvidence: boolean;
  /** Restricted (FR-018): present only for an authorised HR caller who is not the employee. */
  note?: string | null;
  /** Otherwise only whether a remark or reason was recorded. */
  noteRecorded?: boolean;
  actorUserId: string;
  businessDate: string;
  occurredAt: string;
}
interface ProcessDetail {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  processId: string;
  processCode: string;
  processName: string;
  processType: string;
  revision: number;
  /** OPEN, CLOSED or CANCELLED. */
  state: string;
  effectiveDate: string;
  ownerUserId: string;
  exitCaseId: string | null;
  closedAt: string | null;
  cancelledAt: string | null;
  reopenCount: number;
  createdAt: string;
  version: number;
  counts: { total: number; open: number; requiredOpen: number; overdue: number };
  tasks: ProcessTask[];
  history: ProcessEvent[];
}
interface ProcessSummary {
  id: string;
  processCode: string;
  processName: string;
  processType: string;
  revision: number;
  state: string;
  effectiveDate: string;
  exitCaseId: string | null;
  version: number;
  taskCount: number;
  openTasks: number;
  requiredOpen: number;
  overdueTasks: number;
}
/** A task of GET /v1/employee-process-tasks/mine: open, in an open process, owned by the caller or the caller's role. */
interface MyTask extends ProcessTask {
  processId: string;
  processCode: string;
  processName: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
}

/** F1: the recorded contractual value only; there is no default. */
type NoticePeriod = { status: 'NOT_RECORDED' } | { status: 'RECORDED'; contractualNoticeDays: number };
interface ExitCase {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  /** SUBMITTED, RECOMMENDED, APPROVED, SEPARATED, REJECTED or WITHDRAWN. */
  state: string;
  separationType: string;
  requestDate: string;
  proposedLastWorkingDate: string;
  recommendedLastWorkingDate: string | null;
  approvedLastWorkingDate: string | null;
  /** The inclusive last working date in force. */
  lastWorkingDate: string;
  noticePeriod: NoticePeriod;
  /** Confidential (exit reason group): present only for a granted caller, the employee's own under H1. */
  reasonCode?: string | null;
  reason?: string | null;
  employeeMessage: string | null;
  released: boolean;
  releasedAt: string | null;
  submittedAt: string;
  version: number;
}
interface ExitWithdrawal {
  id: string;
  /** SUBMITTED, APPROVED, REJECTED or WITHDRAWN. */
  state: string;
  /** Confidential: present only for a caller granted the exit reason group. */
  reason?: string;
  employeeMessage: string | null;
  requestedAt: string;
  decidedAt: string | null;
}
/** Decision history: step, decision and time only (reviewers' reasons never leave the server). */
interface ExitDecision {
  transactionId: string;
  step: number;
  action: string;
  decision: string;
  decidedAt: string;
}
interface ExitEvent {
  action: string;
  fromState: string;
  toState: string;
  lastWorkingDate: string | null;
  employeeStatusBefore: string | null;
  employeeStatusAfter: string | null;
  actorUserId: string;
  businessDate: string;
  occurredAt: string;
}
interface ExitDetail extends ExitCase {
  clearance: { started: boolean; complete: boolean; processIds: string[]; incompleteRequired: string[] };
  withdrawals: ExitWithdrawal[];
  decisions: ExitDecision[];
  history: ExitEvent[];
}
/** GET /v1/exit-cases/tasks/mine: the manager's recommendations, HR decisions and withdrawal decisions. */
interface ExitTask {
  taskId: string;
  /** exit_case or exit_withdrawal. */
  kind: string;
  /** The step's action: recommend or approve. */
  step: string;
  exitCase: ExitCase | null;
}
interface RecommendResult {
  exitCaseId: string;
  state: string;
  recommendedLastWorkingDate?: string;
  replayed: boolean;
}
interface ExitDecided {
  exitCaseId: string;
  state: string;
  approvedLastWorkingDate?: string;
  replayed: boolean;
}
interface WithdrawalDecided {
  withdrawalId: string;
  state: string;
  exitState?: string;
  replayed: boolean;
}
interface ResignationResult {
  exitCaseId: string;
  state: string;
  requestDate: string;
  proposedLastWorkingDate: string;
}
type ExitDecisionBody =
  | { decision: 'APPROVE'; approvedLastWorkingDate?: string; reason?: string; idempotencyKey: string }
  | { decision: 'REJECT'; reason: string; employeeMessage: string; idempotencyKey: string };
type WithdrawalDecisionBody = { decision: 'APPROVE' | 'REJECT'; reason: string; employeeMessage?: string; idempotencyKey: string };

interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
  status: string;
}
interface NoteItem {
  id: string;
  /** NOTE, REMARK or WARNING. */
  kind: string;
  body: string;
  exitCaseId: string | null;
  processId: string | null;
  supersedesNoteId: string | null;
  supersededByNoteId: string | null;
  createdBy: string;
  createdAt: string;
}
type NoteKind = 'NOTE' | 'REMARK' | 'WARNING';
interface NoteBody {
  kind: NoteKind;
  body: string;
  exitCaseId?: string;
  employeeProcessId?: string;
  supersedesNoteId?: string;
}

// ---------------------------------------------------------------------------------------------------------
// Query keys: they carry the selected company and assignment. The app keeps one query cache across role switches, and
// an answer given to one assignment (a scoped list, a remark, an exit reason) is never shown under another.
// ---------------------------------------------------------------------------------------------------------
function useKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => {
    const base = ['lifecycle-processes', context] as const;
    return {
      /** Every template list and detail of the context. */
      templates: [...base, 'templates'] as const,
      templateList: [...base, 'templates', 'list'] as const,
      template: (id: string) => [...base, 'templates', 'detail', id] as const,
      /** Every process list, detail and task list of the context. */
      processes: [...base, 'processes'] as const,
      employeeProcesses: (employeeId: string) => [...base, 'processes', 'employee', employeeId] as const,
      process: (id: string) => [...base, 'processes', 'detail', id] as const,
      myTasks: [...base, 'processes', 'my-tasks'] as const,
      myProcesses: [...base, 'processes', 'mine'] as const,
      /** Every exit list, detail and task list of the context. */
      exits: [...base, 'exits'] as const,
      exitList: (state: string) => [...base, 'exits', 'list', state] as const,
      exit: (id: string) => [...base, 'exits', 'detail', id] as const,
      employeeExits: (employeeId: string) => [...base, 'exits', 'employee', employeeId] as const,
      exitTasks: [...base, 'exits', 'tasks'] as const,
      myExits: [...base, 'exits', 'mine'] as const,
      notes: (employeeId: string) => [...base, 'notes', employeeId] as const,
      employee: (id: string) => [...base, 'employee', id] as const,
      employeeSearch: (term: string) => [...base, 'employee-search', term] as const,
    };
  }, [context]);
}

// ---------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------
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
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pad = (n: number) => String(n).padStart(2, '0');

/** An instant shown as the viewer's local date and time. */
function localDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function When({ at }: { at: string | null | undefined }) {
  return at ? <time dateTime={at}>{localDateTime(at)}</time> : <>—</>;
}

const typeLabel = (code: string) => PROCESS_TYPES.find(([c]) => c === code)?.[1] ?? readable(code);
const roleLabel = (code: string) => OWNER_ROLES.find(([c]) => c === code)?.[1] ?? readable(code);

const PROCESS_ACTION_LABEL: Record<string, string> = {
  START: 'Process started',
  COMPLETE: 'Task completed',
  SKIP: 'Task skipped',
  REOPEN_TASK: 'Task reopened',
  REASSIGN: 'Task reassigned',
  CLOSE: 'Process closed',
  REOPEN: 'Process reopened',
  CANCEL: 'Process cancelled',
};
const EXIT_ACTION_LABEL: Record<string, string> = {
  SUBMIT: 'Resignation submitted',
  RECOMMEND: 'Last working date recommended',
  APPROVE: 'Resignation approved',
  REJECT: 'Resignation not approved',
  WITHDRAW: 'Withdrawn by the employee',
  WITHDRAWAL_REQUESTED: 'Withdrawal requested',
  WITHDRAWAL_CANCELLED: 'Withdrawal request cancelled',
  WITHDRAWAL_APPROVED: 'Withdrawal approved',
  WITHDRAWAL_REJECTED: 'Withdrawal not approved',
  NOTICE_PERIOD_RECORDED: 'Contractual notice period recorded',
  FINAL_RELEASE: 'Final release recorded',
  SEPARATE: 'Separated',
};
const EXIT_STATE_HINT: Record<string, string> = {
  SUBMITTED: 'Waiting for the recommendation of the last working date',
  RECOMMENDED: 'Waiting for the HR decision',
  APPROVED: 'Approved; the employee separates after the inclusive last working date',
  SEPARATED: 'Separated after the last working date',
  REJECTED: 'Not approved',
  WITHDRAWN: 'Withdrawn',
};
const EMPLOYEE_STATUS_LABEL: Record<string, string> = {
  ACTIVE_PROBATION: 'Active (probation)',
  ACTIVE_CONFIRMED: 'Active (confirmed)',
  NOTICE: 'Notice',
  INACTIVE_SEPARATED: 'Inactive (separated)',
};
const statusLabel = (code: string) => EMPLOYEE_STATUS_LABEL[code] ?? readable(code);
const DECISION_LABEL: Record<string, string> = { APPROVE: 'approved', REJECT: 'not approved' };
const NOTE_KINDS: readonly (readonly [NoteKind, string])[] = [
  ['NOTE', 'Note'],
  ['REMARK', 'Remark'],
  ['WARNING', 'Warning'],
];
const noteKindLabel = (kind: string) => NOTE_KINDS.find(([k]) => k === kind)?.[1] ?? readable(kind);
const SCAN_TEXT: Record<string, string> = {
  PENDING_SCAN: 'waiting for the malware scan',
  CLEAN: 'released by the malware scan',
  QUARANTINED: 'quarantined by the malware scan',
};
const SCAN_TONE: Record<string, 'good' | 'warn' | 'bad'> = { CLEAN: 'good', PENDING_SCAN: 'warn', QUARANTINED: 'bad' };

function dueOffsetText(days: number): string {
  if (days === 0) return 'On the effective date';
  return days > 0 ? `${plural(days, 'day')} after the effective date` : `${plural(-days, 'day')} before the effective date`;
}

/** F1: the notice period is a configured contractual field, shown as recorded; nothing is derived from it here. */
function noticeText(n: NoticePeriod): string {
  return n.status === 'RECORDED' ? `${plural(n.contractualNoticeDays, 'day')} (contractual)` : 'Not recorded';
}

/** A user by the id the server returned; "You" for the signed-in user. The API returns no names for users. */
const userText = (id: string | null | undefined, myUserId: string | null) => (!id ? '—' : id === myUserId ? 'You' : `User ${id}`);

function ownerText(t: { ownerRoleCode: string | null; ownerUserId: string | null; ownerName?: string | null }, myUserId: string | null): string {
  if (t.ownerRoleCode) return `${roleLabel(t.ownerRoleCode)} (role)`;
  if (!t.ownerUserId) return '—';
  if (t.ownerUserId === myUserId) return t.ownerName ? `You (${t.ownerName})` : 'You';
  return t.ownerName ?? `User ${t.ownerUserId}`;
}
const ownerRefText = (o: OwnerRef | null, myUserId: string | null) => (!o ? '—' : o.roleCode ? `${roleLabel(o.roleCode)} (role)` : userText(o.userId, myUserId));

/**
 * Whether the signed-in assignment owns a task, as the API decides it (processes.ts ownsTask): on one's own record only
 * the Employee role's tasks, in the Employee role; otherwise the task's named user or role.
 */
function ownsTask(me: MeContext | null, employeeId: string, t: Pick<ProcessTask, 'ownerRoleCode' | 'ownerUserId'>): boolean {
  if (!me) return false;
  if (me.employeeId === employeeId) return t.ownerRoleCode === OWN_ESS_ROLE && me.roleCode === OWN_ESS_ROLE;
  return t.ownerUserId === me.userId || (t.ownerRoleCode !== null && t.ownerRoleCode === me.roleCode);
}

/** H3/BR-055: own ESS data is used in the Employee role's OWN context; other roles switch to it. */
const inOwnContext = (me: MeContext | null) => me !== null && me.roleCode === OWN_ESS_ROLE && me.scopeKind === 'OWN' && me.employeeId !== null;

/**
 * One idempotency key per decision (ZT07). Sending the same decision again after a failure (its answer may have been
 * lost) reuses the key, so the server answers from what it recorded and never applies it twice; any other decision is
 * a new action with a new key.
 */
function useDecisionKey(prefix: string) {
  const last = useRef<{ signature: string; key: string } | null>(null);
  return useMemo(
    () => ({
      next(signature: string): string {
        const key = last.current !== null && last.current.signature === signature ? last.current.key : idempotencyKey(prefix);
        last.current = { signature, key };
        return key;
      },
      reset() {
        last.current = null;
      },
    }),
    [prefix],
  );
}

// ---------------------------------------------------------------------------------------------------------
// Refusals in plain words (the HttpError codes of templates.ts, processes.ts, exit.ts, notes.ts, workflow/engine.ts)
// ---------------------------------------------------------------------------------------------------------
type Act =
  | 'template-create'
  | 'template-update'
  | 'draft-save'
  | 'publish'
  | 'start'
  | 'complete'
  | 'skip'
  | 'reopen-task'
  | 'reassign'
  | 'close'
  | 'reopen'
  | 'cancel'
  | 'evidence'
  | 'note'
  | 'resign'
  | 'withdraw'
  | 'withdrawal-request'
  | 'withdrawal-cancel'
  | 'recommend'
  | 'exit-decide'
  | 'withdrawal-decide'
  | 'notice-period'
  | 'release';

const DECISION_ACTS: ReadonlySet<Act> = new Set<Act>(['recommend', 'exit-decide', 'withdrawal-decide']);
const TEMPLATE_ACTS: ReadonlySet<Act> = new Set<Act>(['template-create', 'template-update', 'draft-save', 'publish']);
const OWN_ACTS: ReadonlySet<Act> = new Set<Act>(['resign', 'withdraw', 'withdrawal-request', 'withdrawal-cancel']);
const NO_ANSWER_DECISION = 'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.';
const NO_ANSWER_CHANGE = 'No answer came back, so the change may or may not have been saved. Reload the page to check before trying again.';

const STALE_SUBJECT: Partial<Record<Act, string>> = {
  'template-update': 'The template',
  'draft-save': 'The draft revision',
  publish: 'The draft revision',
  complete: 'The task',
  skip: 'The task',
  'reopen-task': 'The task',
  reassign: 'The task',
  close: 'The process',
  reopen: 'The process',
  cancel: 'The process',
  'notice-period': 'The exit case',
  release: 'The exit case',
};
const INVALID_STATE_TEXT: Partial<Record<Act, string>> = {
  publish: 'Only a draft revision can be published, and this one has moved on. The template has been reloaded.',
  withdraw: 'This resignation can no longer be withdrawn.',
  'withdrawal-request': 'Only an approved resignation needs a withdrawal request.',
  'withdrawal-cancel': 'This withdrawal request has already been decided.',
  recommend: 'This resignation is no longer waiting for a recommendation.',
  'exit-decide': 'This resignation is no longer waiting for an HR decision.',
  'withdrawal-decide': 'This withdrawal request is no longer waiting for a decision.',
  'notice-period': 'This exit is closed, so its notice period can no longer be recorded.',
  release: 'Only an approved exit can be finally released.',
};

const tasksIn = (details: unknown): string[] => {
  const tasks = (details as { tasks?: unknown } | undefined)?.tasks;
  return Array.isArray(tasks) ? tasks.filter((t): t is string => typeof t === 'string') : [];
};
/** A refusal about one template task names it by its position (details.task, 1-based). */
function forTask(details: unknown, text: string): string {
  const n = (details as { task?: unknown } | undefined)?.task;
  return typeof n === 'number' ? `Task ${n}: ${text}` : text.charAt(0).toUpperCase() + text.slice(1);
}

/** A refusal in plain words; null for anything else, which is shown as the API sent it. */
function refusalText(error: unknown, action: Act): string | null {
  if (!error) return null;
  if (!(error instanceof ApiError)) {
    // A file that could not be read never reached the server; a failed fetch may have.
    if (action === 'complete' && !(error instanceof TypeError)) return 'The evidence file could not be read. Choose it again.';
    return DECISION_ACTS.has(action) ? NO_ANSWER_DECISION : NO_ANSWER_CHANGE;
  }
  const d = error.details;
  const listed = tasksIn(d);
  switch (error.code) {
    case 'FORBIDDEN':
      return 'The selected role is not permitted to do this.';
    case 'NOT_FOUND':
      if (DECISION_ACTS.has(action)) return 'This task is no longer assigned to you.';
      if (action === 'evidence') return 'No evidence file is recorded for this task now.';
      if (TEMPLATE_ACTS.has(action)) return 'This process template is not available.';
      if (OWN_ACTS.has(action)) return 'This resignation or request is not yours, or it no longer exists.';
      if (action === 'start' || action === 'note') return 'This employee is not in the selected role’s scope.';
      if (action === 'notice-period' || action === 'release') return 'This exit case is not available in the selected role’s scope.';
      return 'This process or task is not available in the selected role’s scope.';
    case 'STALE_VERSION':
      if (action === 'draft-save') return 'The draft revision was changed elsewhere since it was loaded. Your changes are kept: save again to replace that version, or discard them to load it.';
      // A decision carries no version: nothing reloads, and the same decision can simply be sent again.
      if (DECISION_ACTS.has(action)) return 'Another change reached this request at the same moment, so your decision was not recorded. Send it again.';
      return `${STALE_SUBJECT[action] ?? 'The record'} changed since it was loaded. It has been reloaded: check it and try again.`;
    case 'INVALID_REQUEST':
    case 'INVALID_VALUE':
    case 'MISSING_VALUE':
      return 'Some details are missing or not in the accepted format. Check the form and try again.';
    case 'DUPLICATE':
      return action === 'template-create' ? 'A process template with this code already exists. Choose another code.' : 'This was already recorded by another change. Reload the page to check.';
    case 'RULE_VIOLATION':
      return 'The change breaks a rule the system enforces, so nothing was saved. Reload the page to check the current state.';
    case 'UNAVAILABLE':
      return 'The service is busy right now and nothing was changed. Try again in a few seconds.';
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'You cannot act on your own record in this role; another HR user does.';
    case 'INVALID_STATE':
      return INVALID_STATE_TEXT[action] ?? null;
    // Templates (FR-015)
    case 'OWNER_REQUIRED':
      return forTask(d, 'give exactly one owner: a role or a named user.');
    case 'INVALID_OWNER': {
      if (action === 'start') {
        // details.tasks: template tasks whose named owner is the employee's own user or cannot act on this employee.
        if (listed.length > 0) {
          return `These template tasks are owned by a named user who cannot act on this employee, or by the employee’s own user: ${listed.join(', ')}. Change their owner in the template first.`;
        }
        return 'The process owner must be able to manage employee processes and must not be the employee, and every named task owner of the template must be able to act on this employee.';
      }
      if (action === 'reassign') {
        return 'That owner cannot complete process tasks for this employee, or is the employee’s own user (the employee’s own tasks belong to the Employee role). Choose another owner.';
      }
      const role = (d as { ownerRoleCode?: unknown } | undefined)?.ownerRoleCode;
      return forTask(d, typeof role === 'string' ? `the ${roleLabel(role)} role cannot complete process tasks. Choose another owner.` : 'that user cannot complete process tasks in this company. Choose another owner.');
    }
    case 'DUPLICATE_TASK_CODE':
      return 'Each task code can appear only once in a revision.';
    case 'INVALID_DUE_OFFSET':
      return forTask(d, 'the due offset is a whole number of days.');
    case 'TEMPLATE_CODE_EXISTS':
      return 'A process template with this code already exists. Choose another code.';
    case 'NO_TASKS':
      return 'A revision needs at least one task before it can be published.';
    case 'INVALID_REFERENCE':
      if (action === 'template-create') return 'That process type is not an active value in this company. Check the code.';
      if (action === 'start') return 'No process template has that code, or the exit case does not belong to this employee.';
      if (action === 'resign') return 'That reason code is not one your company uses. Leave it empty, or ask HR which codes apply.';
      if (action === 'note') return 'The linked process or exit does not belong to this employee.';
      return null;
    // Employee processes (FR-016)
    case 'TEMPLATE_INACTIVE':
      return 'That process template is inactive. Activate it before starting processes from it.';
    case 'TEMPLATE_NOT_PUBLISHED':
      return 'That process template has no published revision yet. Publish a revision first.';
    case 'EXIT_CASE_MISMATCH':
      return 'An exit clearance template needs the exit case it clears, and only an exit clearance template takes one.';
    case 'EXIT_NOT_APPROVED':
      return 'A clearance checklist starts once the exit is approved, and before its final release.';
    case 'CLEARANCE_EXISTS':
      return 'This exit already has a clearance checklist.';
    case 'INVALID_DATE':
      return 'Enter a valid effective date.';
    case 'NOT_TASK_OWNER':
      return 'This task is owned by someone else.';
    case 'PROCESS_NOT_OPEN':
      if (action === 'reopen-task') return 'Reopen the process before its tasks.';
      if (action === 'close') return 'Only an open process can be closed.';
      if (action === 'cancel') return 'Only an open process can be cancelled.';
      return 'The process is not open, so its tasks cannot change.';
    case 'TASK_NOT_OPEN':
      return 'This task is no longer open.';
    case 'TASK_NOT_DONE':
      return 'This task is already open.';
    case 'EVIDENCE_REQUIRED':
      return 'This task needs evidence: attach a PDF, JPEG or PNG file.';
    case 'FILE_SIZE':
      return 'The evidence file must be between 1 byte and 10 MB.';
    case 'UNSUPPORTED_FILE':
      return 'Only PDF, JPEG and PNG files are accepted as evidence.';
    case 'PAYLOAD_TOO_LARGE':
      return 'The file is larger than the 10 MB limit.';
    case 'REQUIRED_TASK':
      return 'A required task cannot be skipped.';
    case 'SAME_OWNER':
      return 'The task already has this owner.';
    case 'REQUIRED_TASKS_INCOMPLETE':
      return `Every required task must be completed first.${listed.length > 0 ? ` Still incomplete: ${listed.join(', ')}.` : ''} Required evidence counts only once the malware scan releases it: a file still waiting for the scan counts once released, and a task whose file failed the scan is reopened and completed again with a clean file.`;
    case 'PROCESS_NOT_CLOSED':
      return 'Only a closed process can be reopened.';
    case 'EXIT_RELEASED':
      return action === 'withdrawal-request' ? 'Your exit was finally released, so it can no longer be withdrawn.' : 'The exit was finally released, so its clearance checklist is final.';
    case 'FILE_NOT_RELEASED':
      return (d as { scanState?: unknown } | undefined)?.scanState === 'QUARANTINED'
        ? 'This file failed the malware scan, so it cannot be opened.'
        : 'This file cannot be opened until the malware scan releases it.';
    case 'ALREADY_SUPERSEDED':
      return 'That note was already corrected; correct the latest note instead.';
    // Exit (FR-051)
    case 'EMPLOYEE_NOT_ACTIVE':
      return action === 'resign' ? 'Only an active employee can resign.' : 'The employee is no longer active, so the resignation cannot be approved.';
    case 'OPEN_EXIT_EXISTS':
      return 'You already have an open resignation.';
    case 'INVALID_LAST_WORKING_DATE':
      if (action === 'resign') return 'The proposed last working date must be a valid date, today or later.';
      if (action === 'recommend') return 'The recommended last working date must be a valid date, not before the resignation date or today.';
      return 'The approved last working date must be a valid date, not before the resignation date or today.';
    case 'USE_WITHDRAWAL_REQUEST':
      return 'Your resignation is approved, so it can be withdrawn only through an HR decision: request the withdrawal instead.';
    case 'LAST_WORKING_DATE_PASSED':
      return 'Your last working date has passed, so the resignation can no longer be withdrawn.';
    case 'WITHDRAWAL_PENDING':
      return action === 'release' ? 'A withdrawal request is waiting for a decision; it has to be decided first.' : 'A withdrawal request is already waiting for a decision.';
    case 'TASK_CLOSED':
      return 'This task has already been decided.';
    case 'IDEMPOTENCY_KEY_REUSED':
      return 'Nothing was recorded: this attempt was matched to a different decision. Send your decision again.';
    case 'REASON_REQUIRED':
      return 'To not approve the resignation, record the private reason and the message for the employee.';
    case 'EMPLOYEE_MESSAGE_REQUIRED':
      return 'To not approve the withdrawal, explain the decision to the employee.';
    case 'SETTLEMENT_IN_PROGRESS':
      return action === 'notice-period'
        ? 'A submitted settlement relies on the recorded notice period, so it cannot change now.'
        : 'A settlement is being prepared for this exit; it has to be cancelled or finished before the withdrawal can be approved.';
    case 'BEFORE_LAST_WORKING_DATE':
      return 'The final release is recorded on or after the last working date.';
    case 'CLEARANCE_NOT_STARTED':
      return 'Start the exit clearance checklist first.';
    case 'CLEARANCE_INCOMPLETE':
      return `Every required clearance task must be completed first.${listed.length > 0 ? ` Still incomplete: ${listed.join(', ')}.` : ''} Required evidence counts only once the malware scan releases it.`;
    case 'ALREADY_RELEASED':
      return 'This exit was already finally released.';
    case 'NO_ELIGIBLE_REVIEWER':
      if (action === 'recommend') return 'No eligible HR Administrator is left to decide this resignation. Ask HR to add a reviewer to the exit reviewer list; your recommendation was not recorded.';
      return 'No eligible reviewer is set up for this request. Ask HR to repair the reviewer list; nothing was sent.';
    case 'WORKFLOW_NOT_CONFIGURED':
      return 'No approval route is set up for this yet. Ask the administrator to configure it; nothing was recorded.';
    case 'RETRY':
      return 'Your change met another change at the same moment. Try again.';
    default:
      return null;
  }
}

/** `except`: refusals already reported to the screen's notice (see reportGone), so they are not said twice. */
function Refusal({ error, action, except }: { error: unknown; action: Act; except?: ReadonlySet<string> }) {
  if (!error) return null;
  if (except && error instanceof ApiError && except.has(error.code)) return null;
  const text = refusalText(error, action);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

/** What a finished action tells its screen: a confirmation, or (ok false) a refusal that outlives the form. */
type Done = (text: string, ok?: boolean) => void;

/**
 * Reports a refusal to the screen's notice when it means the form has nothing left to do: once the record reloads,
 * the form is gone (the task, process or exit moved on meanwhile), so its own message would never be seen.
 */
function reportGone(error: Error, action: Act, codes: ReadonlySet<string>, onDone: Done): void {
  if (error instanceof ApiError && codes.has(error.code)) onDone(refusalText(error, action) ?? error.message, false);
}

// ---------------------------------------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------------------------------------
const H3: CSSProperties = { fontSize: '1rem', margin: '0.25rem 0 0' };
const FLUSH: CSSProperties = { margin: 0 };
const SCROLL: CSSProperties = { overflowX: 'auto' };
const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };
const GROUP: CSSProperties = { border: '1px solid var(--line)', borderRadius: 8, padding: '0.5rem 0.75rem', margin: 0, minWidth: 0 };
const FIELDS: CSSProperties = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '0.75rem', alignItems: 'end' };

type NoticeState = { text: string; ok: boolean } | null;

function Notice({ notice }: { notice: NoticeState }) {
  if (!notice) return null;
  return (
    <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
      {notice.text}
    </p>
  );
}

function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

function Item({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function Loading({ children }: { children: ReactNode }) {
  return <p className="hint">{children}</p>;
}

/**
 * The role context and its permissions arrive together (session.tsx). Until then nothing is known: no screen says the
 * role is not permitted and no own-record panel asks to switch roles.
 */
function RoleReady({ children }: { children: ReactNode }) {
  const { me } = useSession();
  return me ? <>{children}</> : <Loading>Loading your role…</Loading>;
}

/** A read that failed: not permitted, not in scope (when `missing` is given) or the API's own error. */
function QueryProblem({ error, forbidden, missing }: { error: unknown; forbidden: string; missing?: string }) {
  if (!error) return null;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (missing !== undefined && isNotFound(error)) return <Empty>{missing}</Empty>;
  return <ErrorNote error={error} />;
}

/** A titled block: a card of its own on a screen, or a sub-heading inside another card (the My ESS panels). */
function Block({ title, nested, children }: { title: string; nested?: boolean; children: ReactNode }) {
  if (!nested) return <Section title={title}>{children}</Section>;
  return (
    <div className="stack">
      <h3 style={H3}>{title}</h3>
      {children}
    </div>
  );
}

function ReasonField({ label, value, onChange, max = MAX_REASON }: { label: string; value: string; onChange: (value: string) => void; max?: number }) {
  return (
    <label>
      {label}
      <textarea rows={2} maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} style={TEXTAREA} />
    </label>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screens: process templates (FR-015)
// ---------------------------------------------------------------------------------------------------------
function TemplatesScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Process templates</h1>
      <p className="hint">
        Checklists for onboarding, probation confirmation, transfer, promotion, exit clearance and other processes: ordered tasks, each with one owner, a required or optional flag, a due date
        and an evidence rule. An employee’s process copies the revision published when it starts.
      </p>
      <RoleReady>
        {can(TEMPLATE_READ) ? (
          <TemplateList />
        ) : (
          <Section title="Templates">
            <NotPermitted>The selected role cannot view process templates.</NotPermitted>
          </Section>
        )}
        {can(TEMPLATE_MANAGE) && <NewTemplateForm />}
      </RoleReady>
    </>
  );
}

function TemplateList() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.templateList, queryFn: () => api<{ items: TemplateSummary[] }>('/v1/lifecycle-processes'), retry: retryTransient });
  const data = shown(list);
  return (
    <Section title={`Templates${data ? ` (${data.items.length})` : ''}`}>
      {list.isPending && <Loading>Loading the process templates…</Loading>}
      <QueryProblem error={list.error} forbidden="The selected role cannot view process templates." />
      {data && data.items.length === 0 && <Empty>No process templates yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Process templates">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Type</th>
                <th>Status</th>
                <th>Published revision</th>
                <th>Draft revision</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((t) => (
                <tr key={t.id}>
                  <td>
                    <Link to={PATHS.template(t.id)}>{t.code}</Link>
                  </td>
                  <td>{t.name}</td>
                  <td>{typeLabel(t.processType)}</td>
                  <td>{t.active ? 'Active' : 'Inactive'}</td>
                  <td>{t.publishedRevision === null ? 'None yet' : `Revision ${t.publishedRevision}`}</td>
                  <td>{t.draftRevision === null ? '—' : `Revision ${t.draftRevision}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

function NewTemplateForm() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const typeListId = useId();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState>(null);
  const create = useMutation({
    mutationFn: (body: { code: string; name: string; processType: string }) => api<TemplateDetail>('/v1/lifecycle-processes', { body }),
    onSuccess: (t) => {
      setCode('');
      setName('');
      setType('');
      void qc.invalidateQueries({ queryKey: keys.templates });
      if (can(TEMPLATE_READ)) navigate(PATHS.template(t.id));
      else setNotice({ text: `Created ${t.code} with an empty draft revision 1.`, ok: true });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    const c = code.trim();
    const n = name.trim();
    const p = type.trim();
    let issue: string | null = null;
    if (!CODE.test(c)) issue = 'Enter a code of capital letters, digits and underscores that starts with a letter (at most 40 characters).';
    else if (!n) issue = 'Enter the template name.';
    else if (!LONG_CODE.test(p)) issue = 'Enter the process type code, for example ONBOARDING or EXIT.';
    setProblem(issue);
    setNotice(null);
    if (issue) {
      create.reset();
      return;
    }
    create.mutate({ code: c, name: n, processType: p });
  };
  return (
    <Section title="New process template">
      <form aria-label="New process template" className="stack" onSubmit={submit}>
        <div style={FIELDS}>
          <label>
            Template code
            <input value={code} maxLength={40} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
          <label>
            Template name
            <input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            Process type
            <input list={typeListId} value={type} maxLength={60} onChange={(e) => setType(e.target.value.toUpperCase())} />
          </label>
          <datalist id={typeListId}>
            {PROCESS_TYPES.map(([c, label]) => (
              <option key={c} value={c}>
                {label}
              </option>
            ))}
          </datalist>
        </div>
        <p className="hint" style={FLUSH}>
          The template starts with an empty draft revision 1; add its tasks and publish it on the next screen. The process types offered are the ones every company starts with; your company may
          use others.
        </p>
        <Problem text={problem} />
        <div>
          <button type="submit" disabled={create.isPending}>
            Create template
          </button>
        </div>
        <Refusal error={create.error} action="template-create" />
        <Notice notice={notice} />
      </form>
    </Section>
  );
}

function TemplateDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  return (
    <>
      <p>
        <Link to={PATHS.templates}>← Process templates</Link>
      </p>
      {!UUID.test(id) ? (
        <Empty>This process template does not exist.</Empty>
      ) : (
        <RoleReady>{!can(TEMPLATE_READ) ? <NotPermitted>The selected role cannot view process templates.</NotPermitted> : <TemplateView key={id} id={id} />}</RoleReady>
      )}
    </>
  );
}

function TemplateView({ id }: { id: string }) {
  const keys = useKeys();
  const { can } = useSession();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: keys.template(id), queryFn: () => api<TemplateDetail>(`/v1/lifecycle-processes/${id}`), retry: retryTransient });
  const [startingRevision, setStartingRevision] = useState(false);
  const [notice, setNotice] = useState<NoticeState>(null);
  const t = shown(query);
  if (!t) {
    return (
      <>
        {query.isPending && <Loading>Loading the template…</Loading>}
        <QueryProblem error={query.error} forbidden="The selected role cannot view process templates." missing="This process template is not available." />
      </>
    );
  }
  const canManage = can(TEMPLATE_MANAGE);
  const revisions = [...t.revisions].sort((a, b) => b.revision - a.revision);
  const draft = revisions.find((r) => r.state === 'DRAFT') ?? null;
  const published = revisions.find((r) => r.state === 'PUBLISHED') ?? null;
  const nextRevision = (revisions[0]?.revision ?? 0) + 1;
  const saved = (text: string) => {
    setNotice({ text, ok: true });
    void qc.invalidateQueries({ queryKey: keys.templates });
  };
  /** A refusal whose editor goes away once the template reloads (its draft was published or replaced meanwhile). */
  const refused = (text: string) => setNotice({ text, ok: false });
  return (
    <>
      <h1>
        {t.name} ({t.code})
      </h1>
      <dl className="kv">
        <Item term="Type">{typeLabel(t.processType)}</Item>
        <Item term="Status">{t.active ? 'Active: new processes can start from it' : 'Inactive: no new process can start from it'}</Item>
        <Item term="Published revision">{published ? `Revision ${published.revision}, published ${formatDate(published.publishedAt)}` : 'None yet'}</Item>
        <Item term="Draft revision">{draft ? `Revision ${draft.revision}` : '—'}</Item>
      </dl>
      <Notice notice={notice} />
      {canManage && <TemplateSettings template={t} onSaved={saved} />}
      {draft ? (
        <Section title={`Draft revision ${draft.revision}`}>
          {canManage ? (
            <TaskEditor key={draft.revision} templateId={t.id} draft={draft} revisionNumber={draft.revision} seed={draft.tasks} onSaved={saved} onGone={refused} />
          ) : (
            <RevisionTasks revision={draft} />
          )}
        </Section>
      ) : canManage ? (
        <Section title="New revision">
          {startingRevision ? (
            <TaskEditor
              key={`new:${nextRevision}`}
              templateId={t.id}
              draft={null}
              revisionNumber={nextRevision}
              seed={(published ?? revisions[0])?.tasks ?? []}
              onSaved={(text) => {
                setStartingRevision(false);
                saved(text);
              }}
              onGone={(text) => {
                setStartingRevision(false);
                refused(text);
              }}
              onCancel={() => setStartingRevision(false)}
            />
          ) : (
            <>
              <p className="hint">
                A published revision is frozen. A change is a new draft revision, published when it is ready; running processes keep the revision they started with.
              </p>
              <div>
                <button type="button" onClick={() => setStartingRevision(true)}>
                  Start draft revision {nextRevision}
                </button>
              </div>
            </>
          )}
        </Section>
      ) : null}
      {revisions
        .filter((r) => r.state !== 'DRAFT')
        .map((r) => (
          <Section key={r.revision} title={`Revision ${r.revision}`}>
            <p className="hint" style={FLUSH}>
              <StateBadge state={r.state} />
              {r.publishedAt ? ` published ${formatDate(r.publishedAt)}` : ''}
            </p>
            <RevisionTasks revision={r} />
          </Section>
        ))}
    </>
  );
}

function RevisionTasks({ revision }: { revision: TemplateRevision }) {
  const { me } = useSession();
  if (revision.tasks.length === 0) return <Empty>This revision has no tasks yet.</Empty>;
  return (
    <div style={SCROLL}>
      <table aria-label={`Tasks of revision ${revision.revision}`}>
        <thead>
          <tr>
            <th>Order</th>
            <th>Code</th>
            <th>Task</th>
            <th>Owner</th>
            <th>Required</th>
            <th>Due</th>
            <th>Evidence</th>
          </tr>
        </thead>
        <tbody>
          {[...revision.tasks]
            .sort((a, b) => a.sequence - b.sequence)
            .map((task) => (
              <tr key={task.code}>
                <td>{task.sequence}</td>
                <td>{task.code}</td>
                <td>{task.title}</td>
                <td>{ownerText(task, me?.userId ?? null)}</td>
                <td>{task.required ? 'Required' : 'Optional'}</td>
                <td>{dueOffsetText(task.dueOffsetDays)}</td>
                <td>{task.evidenceRequired ? 'Required' : 'Not required'}</td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}

function TemplateSettings({ template, onSaved }: { template: TemplateDetail; onSaved: (text: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  // The saved name until something is typed; what was typed stays after a refusal (the version is read when sending).
  const [typed, setTyped] = useState<string | null>(null);
  const name = typed ?? template.name;
  const update = useMutation({
    mutationFn: (body: { name?: string; active?: boolean; expectedVersion: number }) => api<TemplateDetail>(`/v1/lifecycle-processes/${template.id}`, { method: 'PATCH', body }),
    onSuccess: (t, body) => {
      if (body.name !== undefined) setTyped(null);
      onSaved(body.active === undefined ? `Renamed the template to ${t.name}.` : t.active ? 'Activated the template: new processes can start from it.' : 'Deactivated the template: no new process can start from it.');
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.templates });
    },
  });
  const setName = (value: string) => setTyped(value);
  const trimmed = name.trim();
  return (
    <Section title="Template settings">
      <form
        aria-label="Template settings"
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (!update.isPending && trimmed && trimmed !== template.name) update.mutate({ name: trimmed, expectedVersion: template.version });
        }}
      >
        <label>
          Template name
          <input value={name} maxLength={MAX_NAME} onChange={(e) => setName(e.target.value)} />
        </label>
        <button type="submit" disabled={update.isPending || !trimmed || trimmed === template.name}>
          Rename
        </button>
        <button
          type="button"
          className={template.active ? 'danger' : undefined}
          disabled={update.isPending}
          onClick={() => update.mutate({ active: !template.active, expectedVersion: template.version })}
        >
          {template.active ? 'Deactivate template' : 'Activate template'}
        </button>
      </form>
      <Refusal error={update.error} action="template-update" />
    </Section>
  );
}

/** A template task being edited; `required` stays unset until chosen (F1: explicit required or optional tasks). */
interface EditableTask {
  key: string;
  code: string;
  title: string;
  ownerKind: 'ROLE' | 'USER';
  ownerRoleCode: string;
  ownerUserId: string;
  required: '' | 'REQUIRED' | 'OPTIONAL';
  dueOffsetDays: string;
  evidenceRequired: boolean;
}

const toEditable = (t: TemplateTask, key: string): EditableTask => ({
  key,
  code: t.code,
  title: t.title,
  ownerKind: t.ownerUserId ? 'USER' : 'ROLE',
  ownerRoleCode: t.ownerRoleCode ?? '',
  ownerUserId: t.ownerUserId ?? '',
  required: t.required ? 'REQUIRED' : 'OPTIONAL',
  dueOffsetDays: String(t.dueOffsetDays),
  evidenceRequired: t.evidenceRequired,
});
const blankTask = (key: string): EditableTask => ({
  key,
  code: '',
  title: '',
  ownerKind: 'ROLE',
  ownerRoleCode: '',
  ownerUserId: '',
  required: '',
  dueOffsetDays: '0',
  evidenceRequired: false,
});
const editorSignature = (rows: EditableTask[]) => JSON.stringify(rows.map(({ key: _key, ...rest }) => rest));

/** The tasks as the API takes them, or the first problem found (the server checks everything again). */
function checkTasks(rows: EditableTask[]): { tasks: TemplateTaskInput[] } | { problem: string } {
  if (rows.length > MAX_TASKS) return { problem: `A revision holds at most ${MAX_TASKS} tasks.` };
  const tasks: TemplateTaskInput[] = [];
  const seen = new Set<string>();
  for (const [i, r] of rows.entries()) {
    const n = i + 1;
    const code = r.code.trim();
    const title = r.title.trim();
    const days = r.dueOffsetDays.trim();
    if (!CODE.test(code)) return { problem: `Task ${n}: enter a code of capital letters, digits and underscores that starts with a letter (at most 40 characters).` };
    if (seen.has(code)) return { problem: `Task ${n}: the code ${code} is used by another task; each code appears once.` };
    seen.add(code);
    if (!title) return { problem: `Task ${n}: enter the task title.` };
    if (r.required === '') return { problem: `Task ${n}: choose whether the task is required or optional.` };
    if (!/^-?\d{1,4}$/.test(days) || Math.abs(Number(days)) > DUE_OFFSET_LIMIT) {
      return { problem: `Task ${n}: the due date is a whole number of days from the effective date, between -${DUE_OFFSET_LIMIT} and ${DUE_OFFSET_LIMIT}.` };
    }
    let owner: { ownerRoleCode: string } | { ownerUserId: string };
    if (r.ownerKind === 'ROLE') {
      const role = r.ownerRoleCode.trim();
      if (!LONG_CODE.test(role)) return { problem: `Task ${n}: enter the owner role code, for example HR_ADMINISTRATOR.` };
      owner = { ownerRoleCode: role };
    } else {
      const user = r.ownerUserId.trim();
      if (!UUID.test(user)) return { problem: `Task ${n}: enter the owner’s user ID.` };
      owner = { ownerUserId: user };
    }
    tasks.push({ code, title, ...owner, required: r.required === 'REQUIRED', dueOffsetDays: Number(days), evidenceRequired: r.evidenceRequired });
  }
  return { tasks };
}

/** Publishing refusals after which the draft is gone once the template reloads (published meanwhile, or out of reach). */
const PUBLISH_GONE: ReadonlySet<string> = new Set(['INVALID_STATE', 'NOT_FOUND']);
/** Saving a new revision: a stale version means another draft replaced this editor (reported to the screen). */
const STALE_ONLY: ReadonlySet<string> = new Set(['STALE_VERSION']);

/**
 * The ordered tasks of a draft revision, saved as a whole against the draft's version; without a draft, saving opens
 * the next revision. A saved draft is published from here, never with unsaved changes. When the draft reloads with
 * another version (a save from here, or a change made elsewhere), the editor shows it, unless that would lose unsaved
 * changes: those are kept, and saving them replaces the reloaded version.
 */
function TaskEditor({
  templateId,
  draft,
  revisionNumber,
  seed,
  onSaved,
  onGone,
  onCancel,
}: {
  templateId: string;
  draft: TemplateRevision | null;
  revisionNumber: number;
  seed: TemplateTask[];
  onSaved: (text: string) => void;
  /** A refusal after which this editor goes away once the template reloads. */
  onGone: (text: string) => void;
  onCancel?: () => void;
}) {
  const keys = useKeys();
  const qc = useQueryClient();
  const roleListId = useId();
  const counter = useRef(0);
  const initial = useMemo(() => [...seed].sort((a, b) => a.sequence - b.sequence).map((t) => toEditable(t, `seed-${t.sequence}`)), [seed]);
  const [rows, setRows] = useState<EditableTask[]>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  /** The draft version the rows were loaded from, its tasks, and whether a save from here waits for its reload. */
  const [loaded, setLoaded] = useState<{ version: number | null; rows: EditableTask[]; saved: boolean }>({ version: draft?.version ?? null, rows: initial, saved: false });
  const [changedElsewhere, setChangedElsewhere] = useState(false);
  if (draft !== null && draft.version !== loaded.version) {
    const unsaved = !loaded.saved && editorSignature(rows) !== editorSignature(loaded.rows);
    setLoaded({ version: draft.version, rows: initial, saved: false });
    if (!unsaved) setRows(initial);
    setChangedElsewhere(unsaved);
  }
  const dirty = draft === null || editorSignature(rows) !== editorSignature(initial);
  const reload = (error: ApiError) => {
    if (error.code === 'STALE_VERSION' || error.code === 'INVALID_STATE' || error.status === 404) void qc.invalidateQueries({ queryKey: keys.templates });
  };
  const save = useMutation({
    mutationFn: (tasks: TemplateTaskInput[]) =>
      api<TemplateDetail>(`/v1/lifecycle-processes/${templateId}/draft`, { method: 'PUT', body: draft ? { tasks, expectedVersion: draft.version } : { tasks } }),
    onSuccess: () => {
      setLoaded((prev) => ({ ...prev, saved: true }));
      setChangedElsewhere(false);
      onSaved(draft ? `Saved draft revision ${draft.revision}.` : `Started draft revision ${revisionNumber}.`);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      reload(error);
      // Without a draft, a stale version means another draft revision was started meanwhile: it replaces this editor.
      if (draft === null && error.code === 'STALE_VERSION') onGone('Another draft revision was started meanwhile and has been loaded; the tasks here were not saved.');
    },
  });
  const publish = useMutation({
    mutationFn: (d: TemplateRevision) => api<TemplateDetail>(`/v1/lifecycle-processes/${templateId}/publish`, { body: { revision: d.revision, expectedVersion: d.version } }),
    onSuccess: (_t, d) => onSaved(`Published revision ${d.revision}. New processes copy its tasks; running processes keep theirs.`),
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      reload(error);
      reportGone(error, 'publish', PUBLISH_GONE, onGone);
    },
  });
  const busy = save.isPending || publish.isPending;
  const patch = (key: string, change: Partial<EditableTask>) => setRows((prev) => prev.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const move = (index: number, by: -1 | 1) =>
    setRows((prev) => {
      const next = [...prev];
      const [row] = next.splice(index, 1);
      if (row) next.splice(index + by, 0, row);
      return next;
    });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy || loaded.saved) return;
    const checked = checkTasks(rows);
    if ('problem' in checked) {
      setProblem(checked.problem);
      save.reset();
      return;
    }
    setProblem(null);
    save.mutate(checked.tasks);
  };
  return (
    <form aria-label={`Tasks of draft revision ${revisionNumber}`} className="stack" onSubmit={submit}>
      <p className="hint" style={FLUSH}>
        Tasks run in this order. Each has exactly one owner: a role (whoever holds it and can reach the employee) or a named user. A required task can never be skipped, and a process closes only
        when every required task is complete. The due date counts days from the process’s effective date.
      </p>
      {changedElsewhere && !save.error && (
        <p className="hint" role="status" style={FLUSH}>
          This draft was saved elsewhere since you started editing. Your unsaved changes are kept: saving them replaces that version, and discarding them loads it.
        </p>
      )}
      {rows.length === 0 && <Empty>No tasks yet. Add the first task.</Empty>}
      {rows.map((r, i) => (
        <fieldset key={r.key} style={GROUP}>
          <legend>Task {i + 1}</legend>
          <div style={FIELDS}>
            <label>
              Code
              <input value={r.code} maxLength={40} onChange={(e) => patch(r.key, { code: e.target.value.toUpperCase() })} />
            </label>
            <label>
              Title
              <input value={r.title} maxLength={MAX_NAME} onChange={(e) => patch(r.key, { title: e.target.value })} />
            </label>
            <label>
              Owner type
              <select value={r.ownerKind} onChange={(e) => patch(r.key, { ownerKind: e.target.value === 'USER' ? 'USER' : 'ROLE' })}>
                <option value="ROLE">A role</option>
                <option value="USER">A named user</option>
              </select>
            </label>
            {r.ownerKind === 'ROLE' ? (
              <label>
                Owner role code
                <input list={roleListId} value={r.ownerRoleCode} maxLength={60} onChange={(e) => patch(r.key, { ownerRoleCode: e.target.value.toUpperCase() })} />
              </label>
            ) : (
              <label>
                Owner user ID
                <input value={r.ownerUserId} maxLength={36} onChange={(e) => patch(r.key, { ownerUserId: e.target.value })} />
              </label>
            )}
            <label>
              Required or optional
              <select value={r.required} onChange={(e) => patch(r.key, { required: e.target.value === 'REQUIRED' ? 'REQUIRED' : e.target.value === 'OPTIONAL' ? 'OPTIONAL' : '' })}>
                <option value="">Choose…</option>
                <option value="REQUIRED">Required (cannot be skipped)</option>
                <option value="OPTIONAL">Optional (can be skipped with a reason)</option>
              </select>
            </label>
            <label>
              Due (days from the effective date)
              <input type="number" step={1} min={-DUE_OFFSET_LIMIT} max={DUE_OFFSET_LIMIT} value={r.dueOffsetDays} onChange={(e) => patch(r.key, { dueOffsetDays: e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={r.evidenceRequired} onChange={(e) => patch(r.key, { evidenceRequired: e.target.checked })} /> Evidence file required
            </label>
          </div>
          <div className="row">
            <button type="button" className="secondary" disabled={i === 0} onClick={() => move(i, -1)}>
              Move up
            </button>
            <button type="button" className="secondary" disabled={i === rows.length - 1} onClick={() => move(i, 1)}>
              Move down
            </button>
            <button type="button" className="secondary" onClick={() => setRows((prev) => prev.filter((x) => x.key !== r.key))}>
              Remove
            </button>
          </div>
        </fieldset>
      ))}
      <datalist id={roleListId}>
        {OWNER_ROLES.map(([c, label]) => (
          <option key={c} value={c}>
            {label}
          </option>
        ))}
      </datalist>
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={rows.length >= MAX_TASKS}
          onClick={() => {
            counter.current += 1;
            setRows((prev) => [...prev, blankTask(`new-${counter.current}`)]);
          }}
        >
          Add a task
        </button>
        <button type="submit" disabled={busy || !dirty || loaded.saved}>
          {draft ? 'Save draft' : `Save as draft revision ${revisionNumber}`}
        </button>
        {draft && dirty && (
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              setRows(initial);
              setProblem(null);
              setChangedElsewhere(false);
              save.reset();
            }}
          >
            Discard changes
          </button>
        )}
        {onCancel && (
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <Problem text={problem} />
      <Refusal error={save.error} action="draft-save" except={draft === null ? STALE_ONLY : undefined} />
      {draft && (
        <div className="stack">
          <p className="hint" style={FLUSH}>
            {dirty
              ? 'Save the draft before publishing it.'
              : draft.tasks.length === 0
                ? 'Add at least one task and save the draft before publishing it.'
                : 'Publishing freezes this revision and retires the one published before; new processes copy its tasks.'}
          </p>
          <div>
            <button type="button" disabled={busy || dirty || draft.tasks.length === 0} onClick={() => publish.mutate(draft)}>
              Publish revision {draft.revision}
            </button>
          </div>
          <Refusal error={publish.error} action="publish" except={PUBLISH_GONE} />
        </div>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screens: employee processes (FR-016)
// ---------------------------------------------------------------------------------------------------------
function ProcessesScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Employee processes</h1>
      <RoleReady>
        <ProcessTaskQueue />
        {can(EMPLOYEE_LIST) ? (
          <EmployeeFinder />
        ) : can(PROCESS_MANAGE) ? (
          <Section title="Find an employee">
            <NotPermitted>The selected role cannot search employees. Open an employee’s processes from a task or an exit case.</NotPermitted>
          </Section>
        ) : null}
      </RoleReady>
    </>
  );
}

function EmployeeFinder() {
  const keys = useKeys();
  const [typed, setTyped] = useState('');
  const [term, setTerm] = useState<string | null>(null);
  const results = useQuery({
    enabled: term !== null,
    queryKey: keys.employeeSearch(term ?? ''),
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term ?? '', page: '1', pageSize: String(EMPLOYEE_PAGE_SIZE) }).toString()}`),
    retry: retryTransient,
  });
  const data = term === null ? undefined : shown(results);
  return (
    <Section title="Find an employee">
      <form
        role="search"
        aria-label="Find an employee"
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          setTerm(typed.trim());
        }}
      >
        <label>
          Name or employee code
          <input value={typed} maxLength={100} onChange={(e) => setTyped(e.target.value)} />
        </label>
        <button type="submit">Search</button>
      </form>
      {term !== null && results.isPending && <Loading>Searching…</Loading>}
      {term !== null && <QueryProblem error={results.error} forbidden="The selected role cannot search employees." />}
      {data && data.items.length === 0 && <Empty>No employee in the selected role’s scope matches.</Empty>}
      {data && data.items.length > 0 && (
        <>
          <table aria-label="Matching employees">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Code</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((e) => (
                <tr key={e.id}>
                  <td>
                    <Link to={PATHS.employee(e.id)}>{e.displayName}</Link>
                  </td>
                  <td>{e.employeeCode}</td>
                  <td>{statusLabel(e.status)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > data.items.length && (
            <p className="hint">
              Showing the first {data.items.length} of {data.total} matches; refine the search to narrow them.
            </p>
          )}
        </>
      )}
    </Section>
  );
}

function EmployeeLifecycleScreen() {
  const { id = '' } = useParams();
  return (
    <>
      <p>
        <Link to={PATHS.processes}>← Employee processes</Link>
      </p>
      {UUID.test(id) ? (
        <RoleReady>
          <EmployeeLifecycle key={id} employeeId={id} />
        </RoleReady>
      ) : (
        <Empty>This employee does not exist.</Empty>
      )}
    </>
  );
}

/** One employee's processes, exits and restricted notes, with starting a process. */
function EmployeeLifecycle({ employeeId }: { employeeId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const own = me?.employeeId === employeeId;
  const canReadProcesses = can(PROCESS_READ);
  const canReadExits = can(EXIT_READ);
  const employee = useQuery({
    enabled: can(EMPLOYEE_READ),
    queryKey: keys.employee(employeeId),
    queryFn: () => api<EmployeeHit>(`/v1/employees/${employeeId}`),
    retry: retryTransient,
  });
  const [processPage, setProcessPage] = useState(1);
  const [exitPage, setExitPage] = useState(1);
  const processes = useQuery({
    enabled: canReadProcesses,
    queryKey: [...keys.employeeProcesses(employeeId), processPage],
    queryFn: () => api<Paged<ProcessSummary>>(pagedUrl(`/v1/employees/${employeeId}/processes`, processPage)),
    retry: retryTransient,
  });
  const exits = useQuery({
    enabled: canReadExits,
    queryKey: [...keys.employeeExits(employeeId), exitPage],
    queryFn: () => api<Paged<ExitCase>>(pagedUrl(`/v1/employees/${employeeId}/exit-cases`, exitPage)),
    retry: retryTransient,
  });
  const person = shown(employee);
  const processData = canReadProcesses ? shown(processes) : undefined;
  const exitData = canReadExits ? shown(exits) : undefined;
  const processList = processData?.items;
  const exitList = exitData?.items;
  const firstExit = exitList?.[0];
  const name = person ? `${person.displayName} (${person.employeeCode})` : firstExit ? `${firstExit.employeeName} (${firstExit.employeeCode})` : 'Employee';
  return (
    <>
      <h1>{name}: processes and exit</h1>
      {own && <p className="hint">This is your own record: processes, exits and notes about you are handled by another HR user.</p>}
      <Section title="Processes">
        {!canReadProcesses ? (
          <NotPermitted>The selected role cannot view employee processes.</NotPermitted>
        ) : (
          <>
            {processes.isPending && <Loading>Loading the processes…</Loading>}
            <QueryProblem error={processes.error} forbidden="The selected role cannot view employee processes." missing="This employee is not in the selected role’s scope." />
            {processList && processList.length === 0 && <Empty>No processes for this employee yet.</Empty>}
            {processList && processList.length > 0 && (
              <div style={SCROLL}>
                <table aria-label="Processes">
                  <thead>
                    <tr>
                      <th>Process</th>
                      <th>Type</th>
                      <th>Revision</th>
                      <th>State</th>
                      <th>Effective date</th>
                      <th>Open tasks</th>
                      <th>Required still open</th>
                      <th>Overdue</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processList.map((p) => (
                      <tr key={p.id}>
                        <td>
                          <Link to={PATHS.process(p.id)}>
                            {p.processName} ({p.processCode})
                          </Link>
                        </td>
                        <td>{typeLabel(p.processType)}</td>
                        <td>{p.revision}</td>
                        <td>
                          <StateBadge state={p.state} />
                        </td>
                        <td>{formatDate(p.effectiveDate)}</td>
                        <td>{`${p.openTasks} of ${p.taskCount}`}</td>
                        <td>{p.requiredOpen}</td>
                        <td>{p.overdueTasks > 0 ? <Badge tone="bad">{`${p.overdueTasks} overdue`}</Badge> : '0'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {processData && <Pager page={processPage} pageSize={LIST_PAGE_SIZE} total={totalOf(processData)} onPage={setProcessPage} label="Process pages" noun="process" plural="processes" />}
          </>
        )}
      </Section>
      {can(PROCESS_MANAGE) && !own && <StartProcessForm employeeId={employeeId} exits={exitList} />}
      {canReadExits && (
        <Section title="Exit cases">
          {exits.isPending && <Loading>Loading the exit cases…</Loading>}
          <QueryProblem error={exits.error} forbidden="The selected role cannot view exit cases." missing="This employee is not in the selected role’s scope." />
          {exitList && exitList.length === 0 && <Empty>No exit cases for this employee.</Empty>}
          {exitList && exitList.length > 0 && <ExitTable exits={exitList} label="Exit cases of the employee" withEmployee={false} />}
          {exitData && <Pager page={exitPage} pageSize={LIST_PAGE_SIZE} total={totalOf(exitData)} onPage={setExitPage} label="Exit case pages" noun="exit case" />}
        </Section>
      )}
      <RestrictedNotes employeeId={employeeId} own={own} processes={processList ?? []} exits={exitList ?? []} />
    </>
  );
}

function StartProcessForm({ employeeId, exits }: { employeeId: string; exits: ExitCase[] | undefined }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canListTemplates = can(TEMPLATE_READ);
  const templates = useQuery({
    enabled: canListTemplates,
    queryKey: keys.templateList,
    queryFn: () => api<{ items: TemplateSummary[] }>('/v1/lifecycle-processes'),
    retry: retryTransient,
  });
  const listed = shown(templates);
  const startable = (listed?.items ?? []).filter((t) => t.active && t.publishedRevision !== null);
  const [code, setCode] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [exitCaseId, setExitCaseId] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [started, setStarted] = useState<ProcessDetail | null>(null);
  const chosen = startable.find((t) => t.code === code) ?? null;
  // Known from the template list; a role that cannot list templates types the code and picks the exit case itself.
  const takesExit = canListTemplates ? chosen?.processType === EXIT_TYPE : true;
  const clearable = (exits ?? []).filter((x) => (x.state === 'APPROVED' || x.state === 'SEPARATED') && !x.released);
  const start = useMutation({
    mutationFn: (body: { processCode: string; effectiveDate?: string; exitCaseId?: string; ownerUserId?: string }) =>
      api<ProcessDetail>(`/v1/employees/${employeeId}/processes`, { body }),
    onSuccess: (p) => {
      setCode('');
      setEffectiveDate('');
      setExitCaseId('');
      setOwnerUserId('');
      setStarted(p);
      void qc.invalidateQueries({ queryKey: keys.processes });
      void qc.invalidateQueries({ queryKey: keys.exits });
    },
    // A clearance checklist started meanwhile, or an exit that moved on: the exits offered here reload.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void qc.invalidateQueries({ queryKey: keys.exits });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (start.isPending) return;
    const processCode = code.trim();
    const owner = ownerUserId.trim();
    let issue: string | null = null;
    if (!CODE.test(processCode)) issue = canListTemplates ? 'Choose the process template.' : 'Enter the template code.';
    else if (canListTemplates && chosen?.processType === EXIT_TYPE && !exitCaseId) issue = 'Choose the approved exit this clearance checklist belongs to.';
    else if (effectiveDate && !ISO_DATE.test(effectiveDate)) issue = 'Enter a valid effective date.';
    else if (owner && !UUID.test(owner)) issue = 'Enter the process owner’s user ID, or leave it empty to own the process yourself.';
    setProblem(issue);
    setStarted(null);
    if (issue) {
      start.reset();
      return;
    }
    start.mutate({
      processCode,
      ...(effectiveDate ? { effectiveDate } : {}),
      ...(takesExit && exitCaseId ? { exitCaseId } : {}),
      ...(owner ? { ownerUserId: owner } : {}),
    });
  };
  return (
    <Section title="Start a process">
      <form aria-label="Start a process" className="stack" onSubmit={submit}>
        <div style={FIELDS}>
          {canListTemplates ? (
            <label>
              Process template
              <select
                value={code}
                onChange={(e) => {
                  setCode(e.target.value);
                  setExitCaseId('');
                }}
              >
                <option value="">Choose a template…</option>
                {startable.map((t) => (
                  <option key={t.id} value={t.code}>
                    {`${t.name} (${t.code}) · ${typeLabel(t.processType)} · revision ${t.publishedRevision}`}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Template code
              <input value={code} maxLength={40} onChange={(e) => setCode(e.target.value.toUpperCase())} />
            </label>
          )}
          <label>
            Effective date (leave empty for today)
            <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
          </label>
          {takesExit && (
            <label>
              {canListTemplates ? 'Exit case' : 'Exit case (exit clearance templates only)'}
              <select value={exitCaseId} onChange={(e) => setExitCaseId(e.target.value)}>
                <option value="">{canListTemplates ? 'Choose the exit…' : 'None'}</option>
                {clearable.map((x) => (
                  <option key={x.id} value={x.id}>
                    {`Resigned ${formatDate(x.requestDate)}, last working date ${formatDate(x.lastWorkingDate)} (${readable(x.state).toLowerCase()})`}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Process owner’s user ID (leave empty to own it yourself)
            <input value={ownerUserId} maxLength={36} onChange={(e) => setOwnerUserId(e.target.value)} />
          </label>
        </div>
        {canListTemplates && listed && startable.length === 0 && (
          <p className="hint" style={FLUSH}>
            No active template has a published revision yet. <Link to={PATHS.templates}>Open the process templates</Link>.
          </p>
        )}
        {takesExit && canListTemplates && clearable.length === 0 && (
          <p className="hint" style={FLUSH}>
            This employee has no approved exit without a final release, so an exit clearance checklist cannot start.
          </p>
        )}
        <Problem text={problem} />
        <div>
          <button type="submit" disabled={start.isPending}>
            Start process
          </button>
        </div>
        <Refusal error={start.error} action="start" />
        {started && (
          <p className="ok" role="status">
            {`Started ${started.processName} (${started.processCode}) with ${plural(started.tasks.length, 'task')}. `}
            {can(PROCESS_READ) && <Link to={PATHS.process(started.id)}>Open the process</Link>}
          </p>
        )}
      </form>
    </Section>
  );
}

function ProcessDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  return (
    <>
      <p>
        <Link to={PATHS.processes}>← Employee processes</Link>
      </p>
      {!UUID.test(id) ? (
        <Empty>This process does not exist.</Empty>
      ) : (
        <RoleReady>{!can(PROCESS_READ) ? <NotPermitted>The selected role cannot view employee processes.</NotPermitted> : <ProcessView key={id} processId={id} />}</RoleReady>
      )}
    </>
  );
}

/** One employee process: its tasks with what the selected assignment may do on each, the process actions and history. */
function ProcessView({ processId, embedded = false }: { processId: string; embedded?: boolean }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: keys.process(processId), queryFn: () => api<ProcessDetail>(`/v1/employee-processes/${processId}`), retry: retryTransient });
  const [notice, setNotice] = useState<NoticeState>(null);
  const p = shown(query);
  const done: Done = (text, ok = true) => {
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.processes });
    // A clearance checklist's tasks decide whether its exit can be released.
    void qc.invalidateQueries({ queryKey: keys.exits });
  };
  if (!p) {
    return (
      <>
        {query.isPending && <Loading>Loading the process…</Loading>}
        <QueryProblem error={query.error} forbidden="The selected role cannot view employee processes." missing="This process is not available in the selected role’s scope." />
      </>
    );
  }
  return (
    <>
      {embedded ? (
        <h3 style={H3}>
          {p.processName} ({p.processCode})
        </h3>
      ) : (
        <h1>
          {p.processName} for {p.employeeName} ({p.employeeCode})
        </h1>
      )}
      <dl className="kv">
        <Item term="State">
          <StateBadge state={p.state} />
        </Item>
        <Item term="Template">{`${p.processCode}, revision ${p.revision}`}</Item>
        <Item term="Type">{typeLabel(p.processType)}</Item>
        <Item term="Effective date">{formatDate(p.effectiveDate)}</Item>
        {!embedded && <Item term="Process owner">{userText(p.ownerUserId, me?.userId ?? null)}</Item>}
        <Item term="Started">
          <When at={p.createdAt} />
        </Item>
        {p.closedAt && (
          <Item term="Closed">
            <When at={p.closedAt} />
          </Item>
        )}
        {p.cancelledAt && (
          <Item term="Cancelled">
            <When at={p.cancelledAt} />
          </Item>
        )}
        {p.reopenCount > 0 && <Item term="Reopened">{plural(p.reopenCount, 'time')}</Item>}
        {p.exitCaseId && (
          <Item term="Exit case">{!embedded && can(EXIT_READ) ? <Link to={PATHS.exit(p.exitCaseId)}>Open the exit case</Link> : 'Exit clearance checklist'}</Item>
        )}
        {!embedded && (
          <Item term="Employee">
            <Link to={PATHS.employee(p.employeeId)}>All processes and exits of {p.employeeName}</Link>
          </Item>
        )}
      </dl>
      <Notice notice={notice} />
      <Block title="Tasks" nested={embedded}>
        <p className="hint" style={FLUSH}>
          {`${plural(p.counts.total, 'task')}: ${p.counts.open} open, ${p.counts.requiredOpen} required still open, ${p.counts.overdue} overdue.`}
        </p>
        {p.tasks.length === 0 ? (
          <Empty>This process has no tasks.</Empty>
        ) : (
          <ol className="tasks" aria-label="Tasks">
            {p.tasks.map((t) => (
              <TaskItem key={t.id} process={p} task={t} onDone={done} />
            ))}
          </ol>
        )}
      </Block>
      <ProcessActions process={p} onDone={done} />
      <ProcessHistory process={p} nested={embedded} />
    </>
  );
}

type TaskForm = 'complete' | 'skip' | 'reassign' | 'reopen';
type TaskPermissions = Record<TaskForm, boolean>;

/** Refusals after which a task form has nothing left to do: the task or its process moved on, or left the caller. */
const TASK_GONE: ReadonlySet<string> = new Set(['TASK_NOT_OPEN', 'TASK_NOT_DONE', 'PROCESS_NOT_OPEN', 'NOT_TASK_OWNER', 'NOT_FOUND']);

/**
 * A refused task action: the process reloads when the refusal says the task changed or moved on, so a retry uses its
 * current version; a form with nothing left to do closes and its refusal moves to the screen's notice.
 */
function useTaskRefusal(action: Act, onDone: Done) {
  const keys = useKeys();
  const qc = useQueryClient();
  return (error: Error) => {
    if (!(error instanceof ApiError)) return;
    if (error.status === 409 || error.status === 404 || error.code === 'NOT_TASK_OWNER') void qc.invalidateQueries({ queryKey: keys.processes });
    reportGone(error, action, TASK_GONE, onDone);
  };
}

function TaskItem({ process, task: t, onDone }: { process: ProcessDetail; task: ProcessTask; onDone: Done }) {
  const { can, me } = useSession();
  const headingId = useId();
  const own = me?.employeeId === process.employeeId;
  const processOpen = process.state === 'OPEN';
  const open = t.state === 'OPEN';
  const mine = ownsTask(me, process.employeeId, t);
  const allowed: TaskPermissions = {
    complete: can(TASK_COMPLETE) && processOpen && open && mine,
    skip: can(TASK_COMPLETE) && processOpen && open && mine && !t.required,
    reassign: can(PROCESS_MANAGE) && !own && processOpen && open,
    reopen: can(PROCESS_REOPEN) && !own && processOpen && !open,
  };
  return (
    <li aria-labelledby={headingId}>
      <h3 id={headingId} style={H3}>
        {`${t.sequence}. ${t.title} (${t.code})`}
      </h3>
      <TaskFacts task={t} employeeId={process.employeeId} />
      <TaskActions task={t} allowed={allowed} onDone={onDone} />
    </li>
  );
}

function TaskFacts({ task: t, employeeId }: { task: ProcessTask; employeeId: string }) {
  const { me, can } = useSession();
  const myUserId = me?.userId ?? null;
  return (
    <dl className="kv">
      <Item term="Status">
        <StateBadge state={t.state} />
        {t.overdue && (
          <>
            {' '}
            <Badge tone="bad">overdue</Badge>
          </>
        )}
      </Item>
      <Item term="Required">{t.required ? 'Required' : 'Optional'}</Item>
      <Item term="Owner">{ownerText(t, myUserId)}</Item>
      <Item term="Due">{formatDate(t.dueDate)}</Item>
      {t.state !== 'OPEN' && <Item term={t.state === 'SKIPPED' ? 'Skipped' : 'Completed'}>{`${formatDate(t.doneOn)} by ${userText(t.doneBy, myUserId)}`}</Item>}
      <Item term="Evidence">
        <EvidenceState task={t} canOpen={can(EVIDENCE_READ) && me?.employeeId !== employeeId} />
      </Item>
    </dl>
  );
}

/** FR-106: the evidence's scan state as text; only a released file is offered for download, to the evidence grant. */
function EvidenceState({ task: t, canOpen }: { task: ProcessTask; canOpen: boolean }) {
  const open = useMutation({ mutationFn: () => download(`/v1/employee-process-tasks/${t.id}/evidence`) });
  if (!t.hasEvidence) return <>{t.evidenceRequired ? 'Required' : 'Not required'}</>;
  const scan = t.evidenceScanState;
  return (
    <>
      <Badge tone={(scan && SCAN_TONE[scan]) || 'warn'}>{scan ? (SCAN_TEXT[scan] ?? readable(scan).toLowerCase()) : 'not scanned'}</Badge>
      {scan === 'QUARANTINED' && <div className="hint">This file failed the malware scan and counts as no evidence: the task has to be reopened and completed again with a clean file.</div>}
      {canOpen && scan === 'CLEAN' && (
        <div>
          <button type="button" className="secondary" disabled={open.isPending} onClick={() => open.mutate()}>
            Download evidence
          </button>
        </div>
      )}
      <Refusal error={open.error} action="evidence" />
    </>
  );
}

function TaskActions({ task, allowed, onDone }: { task: ProcessTask; allowed: TaskPermissions; onDone: Done }) {
  const [form, setForm] = useState<TaskForm | null>(null);
  const finish: Done = (text, ok = true) => {
    setForm(null);
    onDone(text, ok);
  };
  const toggle = (next: TaskForm) => setForm((prev) => (prev === next ? null : next));
  if (!allowed.complete && !allowed.skip && !allowed.reassign && !allowed.reopen) return null;
  return (
    <div className="stack">
      <div className="row">
        {allowed.complete && (
          <button type="button" aria-expanded={form === 'complete'} onClick={() => toggle('complete')}>
            Complete
          </button>
        )}
        {allowed.skip && (
          <button type="button" className="secondary" aria-expanded={form === 'skip'} onClick={() => toggle('skip')}>
            Skip
          </button>
        )}
        {allowed.reassign && (
          <button type="button" className="secondary" aria-expanded={form === 'reassign'} onClick={() => toggle('reassign')}>
            Reassign
          </button>
        )}
        {allowed.reopen && (
          <button type="button" className="secondary" aria-expanded={form === 'reopen'} onClick={() => toggle('reopen')}>
            Reopen
          </button>
        )}
      </div>
      {form === 'complete' && allowed.complete && <CompleteTaskForm task={task} onDone={finish} />}
      {form === 'skip' && allowed.skip && <TaskReasonForm task={task} kind="skip" onDone={finish} />}
      {form === 'reassign' && allowed.reassign && <ReassignTaskForm task={task} onDone={finish} />}
      {form === 'reopen' && allowed.reopen && <TaskReasonForm task={task} kind="reopen-task" onDone={finish} />}
    </div>
  );
}

/** FR-016: the owner completes a task (actor and business date recorded), with a remark and the evidence it asks for. */
function CompleteTaskForm({ task: t, onDone }: { task: ProcessTask; onDone: Done }) {
  const refused = useTaskRefusal('complete', onDone);
  const [remark, setRemark] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const complete = useMutation({
    mutationFn: async (input: { remark: string; file: File | null }) => {
      const evidence = input.file ? { fileName: input.file.name, contentBase64: await fileToBase64(input.file) } : null;
      return api<ProcessTask>(`/v1/employee-process-tasks/${t.id}/complete`, {
        body: { expectedVersion: t.version, ...(input.remark ? { remark: input.remark } : {}), ...(evidence ? { evidence } : {}) },
      });
    },
    onSuccess: (doneTask) => {
      setRemark('');
      setFile(null);
      setFileKey((k) => k + 1);
      // The file is scanned right after it is stored: the answer may already carry the verdict (FR-106).
      const scan = doneTask.evidenceScanState;
      if (scan === 'QUARANTINED') {
        onDone(
          `Completed ${t.title}, but its evidence failed the malware scan: it counts as no evidence and nobody can open it.${
            doneTask.evidenceRequired ? ' The task has to be reopened and completed again with a clean file.' : ''
          }`,
          false,
        );
        return;
      }
      onDone(
        scan === 'PENDING_SCAN'
          ? `Completed ${t.title}. Its evidence is waiting for the malware scan; nobody can open it until the scan releases it.`
          : scan === 'CLEAN'
            ? `Completed ${t.title}. Its evidence was released by the malware scan.`
            : `Completed ${t.title}.`,
      );
    },
    onError: refused,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (complete.isPending) return;
    let issue: string | null = null;
    if (t.evidenceRequired && !file) issue = 'This task needs evidence: choose a PDF, JPEG or PNG file.';
    else if (file && (file.size === 0 || file.size > MAX_FILE_BYTES)) issue = 'The evidence file must be between 1 byte and 10 MB.';
    else if (file && file.name.length > MAX_FILE_NAME) issue = `Rename the file first: its name can have at most ${MAX_FILE_NAME} characters.`;
    else if (file && !FILE_NAME.test(file.name)) issue = 'Rename the file first: its name cannot contain / \\ < > : " | ? * or control characters.';
    setProblem(issue);
    if (issue) {
      complete.reset();
      return;
    }
    complete.mutate({ remark: remark.trim(), file });
  };
  return (
    <form aria-label={`Complete ${t.title}`} className="stack" onSubmit={submit}>
      <ReasonField label="Remark (optional; restricted to authorised HR)" value={remark} onChange={setRemark} max={MAX_REMARK} />
      <label>
        {t.evidenceRequired ? 'Evidence file (required)' : 'Evidence file (optional)'}
        <input key={fileKey} type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <p className="hint" style={FLUSH}>
        PDF, JPEG or PNG up to 10 MB. The file is scanned for malware before anyone can open it.
      </p>
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={complete.isPending}>
          Complete task
        </button>
      </div>
      <Refusal error={complete.error} action="complete" except={TASK_GONE} />
    </form>
  );
}

/** Skipping an optional task, or reopening a done one (FR-016: with a reason and its own duty). */
function TaskReasonForm({ task: t, kind, onDone }: { task: ProcessTask; kind: 'skip' | 'reopen-task'; onDone: Done }) {
  const refused = useTaskRefusal(kind, onDone);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const skip = kind === 'skip';
  const act = useMutation({
    mutationFn: (text: string) => api<ProcessTask>(`/v1/employee-process-tasks/${t.id}/${skip ? 'skip' : 'reopen'}`, { body: { expectedVersion: t.version, reason: text } }),
    onSuccess: () => {
      setReason('');
      onDone(skip ? `Skipped ${t.title}.` : `Reopened ${t.title}; its earlier completion stays in the history.`);
    },
    onError: refused,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (act.isPending) return;
    const text = reason.trim();
    setProblem(text ? null : skip ? 'Enter the reason for skipping the task.' : 'Enter the reason for reopening the task.');
    if (!text) {
      act.reset();
      return;
    }
    act.mutate(text);
  };
  return (
    <form aria-label={skip ? `Skip ${t.title}` : `Reopen ${t.title}`} className="stack" onSubmit={submit}>
      <ReasonField label={skip ? 'Reason for skipping (required)' : 'Reason for reopening (required)'} value={reason} onChange={setReason} />
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={act.isPending}>
          {skip ? 'Skip task' : 'Reopen task'}
        </button>
      </div>
      <Refusal error={act.error} action={kind} except={TASK_GONE} />
    </form>
  );
}

/** FR-016: reassignment keeps the prior owner in the history. */
function ReassignTaskForm({ task: t, onDone }: { task: ProcessTask; onDone: Done }) {
  const { me } = useSession();
  const refused = useTaskRefusal('reassign', onDone);
  const radioName = useId();
  const roleListId = useId();
  const [kind, setKind] = useState<'ROLE' | 'USER'>('ROLE');
  const [role, setRole] = useState('');
  const [user, setUser] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const reassign = useMutation({
    mutationFn: (body: { expectedVersion: number; ownerRoleCode?: string; ownerUserId?: string; reason?: string }) =>
      api<ProcessTask>(`/v1/employee-process-tasks/${t.id}/reassign`, { body }),
    onSuccess: (moved) => {
      setRole('');
      setUser('');
      setReason('');
      onDone(`Reassigned ${t.title} to ${ownerText(moved, me?.userId ?? null)}; the earlier owner stays in the history.`);
    },
    onError: refused,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reassign.isPending) return;
    const r = role.trim();
    const u = user.trim();
    const text = reason.trim();
    let issue: string | null = null;
    if (kind === 'ROLE' && !LONG_CODE.test(r)) issue = 'Enter the new owner role code, for example REPORTING_MANAGER.';
    else if (kind === 'USER' && !UUID.test(u)) issue = 'Enter the new owner’s user ID.';
    else if (kind === 'ROLE' ? r === t.ownerRoleCode && t.ownerUserId === null : u.toLowerCase() === t.ownerUserId?.toLowerCase() && t.ownerRoleCode === null) {
      issue = 'The task already has this owner.';
    }
    setProblem(issue);
    if (issue) {
      reassign.reset();
      return;
    }
    reassign.mutate({ expectedVersion: t.version, ...(kind === 'ROLE' ? { ownerRoleCode: r } : { ownerUserId: u }), ...(text ? { reason: text } : {}) });
  };
  return (
    <form aria-label={`Reassign ${t.title}`} className="stack" onSubmit={submit}>
      <fieldset style={GROUP}>
        <legend>New owner</legend>
        <div className="row">
          <label className="check">
            <input type="radio" name={radioName} checked={kind === 'ROLE'} onChange={() => setKind('ROLE')} /> A role
          </label>
          <label className="check">
            <input type="radio" name={radioName} checked={kind === 'USER'} onChange={() => setKind('USER')} /> A named user
          </label>
        </div>
        {kind === 'ROLE' ? (
          <label>
            New owner role code
            <input list={roleListId} value={role} maxLength={60} onChange={(e) => setRole(e.target.value.toUpperCase())} />
          </label>
        ) : (
          <label>
            New owner user ID
            <input value={user} maxLength={36} onChange={(e) => setUser(e.target.value)} />
          </label>
        )}
        <datalist id={roleListId}>
          {OWNER_ROLES.map(([c, label]) => (
            <option key={c} value={c}>
              {label}
            </option>
          ))}
        </datalist>
      </fieldset>
      <ReasonField label="Reason (optional; restricted to authorised HR)" value={reason} onChange={setReason} />
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={reassign.isPending}>
          Reassign task
        </button>
      </div>
      <Refusal error={reassign.error} action="reassign" except={TASK_GONE} />
    </form>
  );
}

/** Process refusals after which these actions are gone once the process reloads (it moved on meanwhile). */
const PROCESS_GONE: ReadonlySet<string> = new Set(['PROCESS_NOT_OPEN', 'PROCESS_NOT_CLOSED', 'NOT_FOUND']);

/**
 * A required task that still holds its process (and an exit's final release) open, as the API decides it
 * (processes.ts INCOMPLETE_REQUIRED): not completed, or completed with required evidence the malware scan has not
 * released (a file still waiting for its scan is not evidence yet, and a quarantined file never is).
 */
const holdsOpen = (t: ProcessTask) => t.required && (t.state !== 'COMPLETED' || (t.evidenceRequired && t.evidenceScanState !== 'CLEAN'));

/** FR-015/FR-016: close once every required task is complete; cancel an open process or reopen a closed one with a reason. */
function ProcessActions({ process: p, onDone }: { process: ProcessDetail; onDone: Done }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const own = me?.employeeId === p.employeeId;
  const canManage = can(PROCESS_MANAGE) && !own && p.state === 'OPEN';
  const canReopen = can(PROCESS_REOPEN) && !own && p.state === 'CLOSED';
  const [cancelReason, setCancelReason] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const [problem, setProblem] = useState<{ form: 'cancel' | 'reopen'; text: string } | null>(null);
  const conflict = (action: Act) => (error: Error) => {
    if (!(error instanceof ApiError)) return;
    if (error.status === 409 || error.status === 404) void qc.invalidateQueries({ queryKey: keys.processes });
    reportGone(error, action, PROCESS_GONE, onDone);
  };
  const close = useMutation({
    mutationFn: () => api<ProcessDetail>(`/v1/employee-processes/${p.id}/close`, { body: { expectedVersion: p.version } }),
    onSuccess: () => onDone('Closed the process.'),
    onError: conflict('close'),
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => api<ProcessDetail>(`/v1/employee-processes/${p.id}/cancel`, { body: { expectedVersion: p.version, reason } }),
    onSuccess: () => {
      setCancelReason('');
      onDone('Cancelled the process. Its tasks and history are kept.');
    },
    onError: conflict('cancel'),
  });
  const reopen = useMutation({
    mutationFn: (reason: string) => api<ProcessDetail>(`/v1/employee-processes/${p.id}/reopen`, { body: { expectedVersion: p.version, reason } }),
    onSuccess: () => {
      setReopenReason('');
      onDone('Reopened the process. Its history is kept.');
    },
    onError: conflict('reopen'),
  });
  if (!canManage && !canReopen) return null;
  const busy = close.isPending || cancel.isPending || reopen.isPending;
  const incomplete = p.tasks.filter(holdsOpen);
  // Completed, but their required evidence is not released yet (still waiting for the scan) or never will be.
  const quarantined = incomplete.some((t) => t.state === 'COMPLETED' && t.evidenceScanState === 'QUARANTINED');
  const awaitingScan = incomplete.some((t) => t.state === 'COMPLETED' && t.evidenceScanState !== 'QUARANTINED');
  const withReason = (form: 'cancel' | 'reopen', typed: string, send: (reason: string) => void) => (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const text = typed.trim();
    if (!text) {
      setProblem({ form, text: form === 'cancel' ? 'Enter the reason for cancelling the process.' : 'Enter the reason for reopening the process.' });
      return;
    }
    setProblem(null);
    send(text);
  };
  return (
    <Section title="Process actions">
      {canManage && (
        <div className="stack">
          <p className="hint" style={FLUSH}>
            {incomplete.length > 0
              ? `The process closes once every required task is complete. Still incomplete: ${incomplete.map((t) => t.code).join(', ')}.${
                  awaitingScan ? ' Required evidence still waiting for the malware scan counts once the scan releases it.' : ''
                }${quarantined ? ' A required task whose evidence failed the malware scan stays incomplete until it is reopened and completed with a clean file.' : ''}`
              : 'Every required task is done, so the process can close; open optional tasks do not hold it.'}
          </p>
          <div>
            <button type="button" disabled={busy || incomplete.length > 0} onClick={() => close.mutate()}>
              Close process
            </button>
          </div>
          <Refusal error={close.error} action="close" except={PROCESS_GONE} />
          <form aria-label="Cancel the process" className="stack" onSubmit={withReason('cancel', cancelReason, (reason) => cancel.mutate(reason))}>
            <ReasonField label="Reason for cancelling (required)" value={cancelReason} onChange={setCancelReason} />
            <Problem text={problem?.form === 'cancel' ? problem.text : null} />
            <div>
              <button type="submit" className="danger" disabled={busy}>
                Cancel process
              </button>
            </div>
            <Refusal error={cancel.error} action="cancel" except={PROCESS_GONE} />
          </form>
        </div>
      )}
      {canReopen && (
        <form aria-label="Reopen the process" className="stack" onSubmit={withReason('reopen', reopenReason, (reason) => reopen.mutate(reason))}>
          <ReasonField label="Reason for reopening (required)" value={reopenReason} onChange={setReopenReason} />
          <Problem text={problem?.form === 'reopen' ? problem.text : null} />
          <div>
            <button type="submit" disabled={busy}>
              Reopen process
            </button>
          </div>
          <Refusal error={reopen.error} action="reopen" except={PROCESS_GONE} />
        </form>
      )}
    </Section>
  );
}

function historyChange(e: ProcessEvent, myUserId: string | null): string {
  if (e.priorOwner || e.newOwner) return `Owner: ${ownerRefText(e.priorOwner, myUserId)} → ${ownerRefText(e.newOwner, myUserId)}`;
  if (e.fromState && e.toState) return `${readable(e.fromState)} → ${readable(e.toState)}`;
  return e.toState ? readable(e.toState) : '—';
}

/** Restricted (FR-018): a remark or reason appears only when the server returned it; otherwise whether one exists. */
function remarkText(e: ProcessEvent): string {
  if ('note' in e) return e.note ?? '—';
  return e.noteRecorded ? 'Recorded (restricted)' : '—';
}

function ProcessHistory({ process: p, nested }: { process: ProcessDetail; nested?: boolean }) {
  const { me } = useSession();
  const myUserId = me?.userId ?? null;
  return (
    <Block title="History" nested={nested}>
      {p.history.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Process history">
            <thead>
              <tr>
                <th>Business date</th>
                <th>Recorded</th>
                <th>Action</th>
                <th>Task</th>
                <th>Change</th>
                <th>Evidence</th>
                <th>Remark or reason</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {p.history.map((e, i) => (
                <tr key={`${e.occurredAt}-${i}`}>
                  <td>{formatDate(e.businessDate)}</td>
                  <td>
                    <When at={e.occurredAt} />
                  </td>
                  <td>{PROCESS_ACTION_LABEL[e.action] ?? readable(e.action)}</td>
                  <td>{e.taskCode ?? '—'}</td>
                  <td>{historyChange(e, myUserId)}</td>
                  <td>{e.hasEvidence ? 'Attached' : '—'}</td>
                  <td>{remarkText(e)}</td>
                  <td>{userText(e.actorUserId, myUserId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Restricted HR notes, remarks and warnings (FR-018): their own confidential grants, never about one's own record;
// append-only, a correction supersedes the earlier note.
// ---------------------------------------------------------------------------------------------------------
function RestrictedNotes({ employeeId, own, processes, exits }: { employeeId: string; own: boolean; processes: ProcessSummary[]; exits: ExitCase[] }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canRead = can(NOTE_READ);
  const canWrite = can(NOTE_WRITE);
  const [notePage, setNotePage] = useState(1);
  const notes = useQuery({
    enabled: canRead && !own,
    queryKey: [...keys.notes(employeeId), notePage],
    queryFn: () => api<Paged<NoteItem>>(pagedUrl(`/v1/employees/${employeeId}/notes`, notePage)),
    retry: retryTransient,
  });
  const [correcting, setCorrecting] = useState<NoteItem | null>(null);
  const [formKey, setFormKey] = useState(0);
  const [notice, setNotice] = useState<NoticeState>(null);
  if (!canRead && !canWrite) return null;
  if (own) {
    return (
      <Section title="Restricted HR notes">
        <Empty>Notes about your own record are not shown to you, and you cannot add them.</Empty>
      </Section>
    );
  }
  const noteData = shown(notes);
  const items = noteData?.items;
  const linkText = (n: NoteItem) => {
    const parts: string[] = [];
    if (n.processId) {
      const p = processes.find((x) => x.id === n.processId);
      parts.push(p ? `Process: ${p.processName} (${p.processCode})` : 'Linked to a process');
    }
    if (n.exitCaseId) {
      const x = exits.find((e) => e.id === n.exitCaseId);
      parts.push(x ? `Exit: resigned ${formatDate(x.requestDate)}` : 'Linked to an exit');
    }
    return parts.join(' · ');
  };
  return (
    <Section title="Restricted HR notes">
      <p className="hint">Notes, remarks and warnings visible only to authorised HR. They are never changed: a correction is a new note that supersedes the earlier one.</p>
      <Notice notice={notice} />
      {canRead && (
        <>
          {notes.isPending && <Loading>Loading the notes…</Loading>}
          <QueryProblem error={notes.error} forbidden="The selected role cannot read restricted notes." missing="This employee is not in the selected role’s scope." />
          {items && items.length === 0 && <Empty>No notes about this employee.</Empty>}
          {items && items.length > 0 && (
            <ul className="tasks" aria-label="Restricted HR notes">
              {items.map((n) => (
                <li key={n.id}>
                  <div>
                    <Badge tone={n.kind === 'WARNING' ? 'bad' : 'neutral'}>{noteKindLabel(n.kind).toLowerCase()}</Badge> <When at={n.createdAt} /> by {userText(n.createdBy, me?.userId ?? null)}
                  </div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{n.body}</div>
                  {(n.processId || n.exitCaseId) && <div className="hint">{linkText(n)}</div>}
                  {n.supersedesNoteId && <div className="hint">Corrects an earlier note.</div>}
                  {n.supersededByNoteId ? (
                    <div className="hint">Corrected by a later note.</div>
                  ) : (
                    canWrite && (
                      <div>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setCorrecting(n);
                            setFormKey((k) => k + 1);
                          }}
                        >
                          Correct this note
                        </button>
                      </div>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
          {noteData && <Pager page={notePage} pageSize={LIST_PAGE_SIZE} total={totalOf(noteData)} onPage={setNotePage} label="Note pages" noun="note" />}
        </>
      )}
      {canWrite && (
        <NoteForm
          key={formKey}
          employeeId={employeeId}
          correcting={correcting}
          processes={processes}
          exits={exits}
          onCancel={() => {
            setCorrecting(null);
            setFormKey((k) => k + 1);
          }}
          onSaved={(text) => {
            setNotice({ text, ok: true });
            setCorrecting(null);
            setFormKey((k) => k + 1);
            void qc.invalidateQueries({ queryKey: keys.notes(employeeId) });
          }}
        />
      )}
    </Section>
  );
}

function NoteForm({
  employeeId,
  correcting,
  processes,
  exits,
  onSaved,
  onCancel,
}: {
  employeeId: string;
  correcting: NoteItem | null;
  processes: ProcessSummary[];
  exits: ExitCase[];
  onSaved: (text: string) => void;
  onCancel: () => void;
}) {
  const initialLink = correcting?.processId ? `process:${correcting.processId}` : correcting?.exitCaseId ? `exit:${correcting.exitCaseId}` : '';
  const [kind, setKind] = useState<NoteKind>(correcting && NOTE_KINDS.some(([k]) => k === correcting.kind) ? (correcting.kind as NoteKind) : 'NOTE');
  const [body, setBody] = useState(correcting?.body ?? '');
  const [link, setLink] = useState(initialLink);
  const [problem, setProblem] = useState<string | null>(null);
  const keys = useKeys();
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (note: NoteBody) => api<{ id: string }>(`/v1/employees/${employeeId}/notes`, { body: note }),
    onSuccess: (_r, note) => onSaved(note.supersedesNoteId ? 'Saved the correction; the earlier note is kept and marked as corrected.' : `Saved the ${noteKindLabel(note.kind).toLowerCase()}.`),
    // A note corrected meanwhile: the list reloads and shows the later correction; what was typed stays.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) void qc.invalidateQueries({ queryKey: keys.notes(employeeId) });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const text = body.trim();
    if (!text) {
      setProblem('Enter the note.');
      save.reset();
      return;
    }
    setProblem(null);
    const [linkKind, linkId] = link.split(':');
    save.mutate({
      kind,
      body: text,
      ...(linkKind === 'process' && linkId ? { employeeProcessId: linkId } : {}),
      ...(linkKind === 'exit' && linkId ? { exitCaseId: linkId } : {}),
      ...(correcting ? { supersedesNoteId: correcting.id } : {}),
    });
  };
  return (
    <form aria-label={correcting ? 'Correct a note' : 'Add a note'} className="stack" onSubmit={submit}>
      <h3 style={H3}>{correcting ? 'Correct a note' : 'Add a note'}</h3>
      {correcting && (
        <p className="hint" style={FLUSH}>
          Correcting the {noteKindLabel(correcting.kind).toLowerCase()} of {localDateTime(correcting.createdAt)}: the correction is saved as a new note and the earlier one stays.
        </p>
      )}
      <div style={FIELDS}>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind((NOTE_KINDS.find(([k]) => k === e.target.value)?.[0] ?? 'NOTE') as NoteKind)}>
            {NOTE_KINDS.map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Linked to
          <select value={link} onChange={(e) => setLink(e.target.value)}>
            <option value="">Not linked</option>
            {processes.map((p) => (
              <option key={p.id} value={`process:${p.id}`}>
                {`Process: ${p.processName} (${p.processCode})`}
              </option>
            ))}
            {exits.map((x) => (
              <option key={x.id} value={`exit:${x.id}`}>
                {`Exit: resigned ${formatDate(x.requestDate)}`}
              </option>
            ))}
          </select>
        </label>
      </div>
      <ReasonField label="Note (restricted to authorised HR)" value={body} onChange={setBody} max={MAX_NOTE} />
      <Problem text={problem} />
      <div className="row">
        <button type="submit" disabled={save.isPending}>
          {correcting ? 'Save correction' : 'Add note'}
        </button>
        {correcting && (
          <button type="button" className="secondary" disabled={save.isPending} onClick={onCancel}>
            Cancel correction
          </button>
        )}
      </div>
      <Refusal error={save.error} action="note" />
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screens: exit cases (FR-051, F1)
// ---------------------------------------------------------------------------------------------------------
function ExitsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Exit cases</h1>
      <RoleReady>
        <ExitRecommendationQueue />
        <ExitApprovalQueue />
        <ExitWithdrawalQueue />
        {can(EXIT_READ) ? (
          <ExitList />
        ) : (
          <Section title="Exit cases">
            <NotPermitted>The selected role cannot view exit cases.</NotPermitted>
          </Section>
        )}
      </RoleReady>
    </>
  );
}

/** The columns GET /v1/exit-cases sorts by that this table shows (lifecycle/exit.ts). */
type ExitSort = 'employeeName' | 'requestDate' | 'state';

function ExitTable({ exits, label, withEmployee = true, sort, onSort }: { exits: ExitCase[]; label: string; withEmployee?: boolean; sort?: SortState<ExitSort>; onSort?: (column: ExitSort) => void }) {
  const heading = (column: ExitSort, text: string) => (onSort ? <SortHeader column={column} label={text} sort={sort ?? null} onSort={onSort} /> : <th>{text}</th>);
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            {withEmployee && heading('employeeName', 'Employee')}
            {heading('requestDate', 'Resignation date')}
            {heading('state', 'State')}
            <th>Proposed last working date</th>
            <th>Recommended</th>
            <th>Approved</th>
            <th>Contractual notice period</th>
            <th>Final release</th>
          </tr>
        </thead>
        <tbody>
          {exits.map((x) => (
            <tr key={x.id}>
              {withEmployee && (
                <td>
                  <Link to={PATHS.exit(x.id)}>
                    {x.employeeName} ({x.employeeCode})
                  </Link>
                </td>
              )}
              <td>{withEmployee ? formatDate(x.requestDate) : <Link to={PATHS.exit(x.id)}>{formatDate(x.requestDate)}</Link>}</td>
              <td>
                <StateBadge state={x.state} />
              </td>
              <td>{formatDate(x.proposedLastWorkingDate)}</td>
              <td>{formatDate(x.recommendedLastWorkingDate)}</td>
              <td>{formatDate(x.approvedLastWorkingDate)}</td>
              <td>{noticeText(x.noticePeriod)}</td>
              <td>{x.released ? 'Released' : 'Not released'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExitList() {
  const keys = useKeys();
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState<ExitSort>>(null);
  const onSort = (column: ExitSort) => {
    setSort((current) => nextSort(current, column));
    setPage(1);
  };
  const list = useQuery({
    queryKey: [...keys.exitList(state || 'ALL'), page, sort],
    queryFn: () => api<Paged<ExitCase>>(pagedUrl('/v1/exit-cases', page, new URLSearchParams({ ...(state ? { state } : {}), ...sortParams(sort) }))),
    retry: retryTransient,
  });
  const data = shown(list);
  return (
    <Section title={`Exit cases${data ? ` (${totalOf(data)})` : ''}`}>
      <label className="inline">
        State
        <select
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All states</option>
          {EXIT_STATES.map((s) => (
            <option key={s} value={s}>
              {readable(s)}
            </option>
          ))}
        </select>
      </label>
      {list.isPending && <Loading>Loading the exit cases…</Loading>}
      <QueryProblem error={list.error} forbidden="The selected role cannot view exit cases." />
      {data && data.items.length === 0 && <Empty>{state ? 'No exit cases in this state.' : 'No exit cases in the selected role’s scope.'}</Empty>}
      {data && data.items.length > 0 && <ExitTable exits={data.items} label="Exit cases" sort={sort} onSort={onSort} />}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(data)} onPage={setPage} label="Exit case pages" noun="exit case" />}
    </Section>
  );
}

function ExitDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  return (
    <>
      <p>
        <Link to={PATHS.exits}>← Exit cases</Link>
      </p>
      {!UUID.test(id) ? (
        <Empty>This exit case does not exist.</Empty>
      ) : (
        <RoleReady>{!can(EXIT_READ) ? <NotPermitted>The selected role cannot view exit cases.</NotPermitted> : <ExitView key={id} exitId={id} />}</RoleReady>
      )}
    </>
  );
}

const queueKindOf = (t: ExitTask): ExitQueueKind => (t.kind === 'exit_withdrawal' ? 'withdrawal' : t.step === 'recommend' ? 'recommend' : 'approve');

function ExitView({ exitId }: { exitId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: keys.exit(exitId), queryFn: () => api<ExitDetail>(`/v1/exit-cases/${exitId}`), retry: retryTransient });
  const decides = can(EXIT_RECOMMEND) || can(EXIT_APPROVE);
  const tasks = useQuery({ enabled: decides, queryKey: keys.exitTasks, queryFn: () => api<{ items: ExitTask[] }>('/v1/exit-cases/tasks/mine'), retry: retryTransient });
  const [notice, setNotice] = useState<NoticeState>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const x = shown(query);
  const done = (text: string, ok = true) => {
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.exits });
    void qc.invalidateQueries({ queryKey: keys.processes });
  };
  if (!x) {
    return (
      <>
        {query.isPending && <Loading>Loading the exit case…</Loading>}
        <QueryProblem error={query.error} forbidden="The selected role cannot view exit cases." missing="This exit case is not available in the selected role’s scope." />
      </>
    );
  }
  const own = me?.employeeId === x.employeeId;
  const mine = decides ? (shown(tasks)?.items ?? []).filter((t) => t.exitCase?.id === x.id && !gone.has(t.taskId)) : [];
  const live = ['SUBMITTED', 'RECOMMENDED', 'APPROVED', 'SEPARATED'].includes(x.state) && !x.released;
  const releasable = (x.state === 'APPROVED' || x.state === 'SEPARATED') && !x.released;
  return (
    <>
      <h1>
        Exit of {x.employeeName} ({x.employeeCode})
      </h1>
      <Notice notice={notice} />
      {mine.length > 0 && (
        <Section title="Waiting for your decision">
          <ul className="tasks" aria-label="Waiting for your decision">
            {mine.map((t) => (
              <ExitTaskItem
                key={t.taskId}
                task={t}
                kind={queueKindOf(t)}
                linkToExit={false}
                onFinished={(task, text, ok) => {
                  setGone((prev) => new Set(prev).add(task.taskId));
                  done(text, ok);
                }}
              />
            ))}
          </ul>
        </Section>
      )}
      <Section title="Exit">
        <ExitFacts x={x} />
        {can(PROCESS_READ) && (
          <p style={FLUSH}>
            <Link to={PATHS.employee(x.employeeId)}>All processes and exits of {x.employeeName}</Link>
          </p>
        )}
      </Section>
      {can(EXIT_MANAGE) && !own && live && <NoticePeriodForm exit={x} onDone={done} />}
      <ClearanceSection exit={x} own={own} onDone={done} />
      {can(EXIT_MANAGE) && !own && releasable && <FinalRelease exit={x} onDone={done} />}
      <WithdrawalList withdrawals={x.withdrawals} />
      <DecisionTrail decisions={x.decisions} />
      <ExitHistory history={x.history} />
    </>
  );
}

function ExitFacts({ x, ownView = false }: { x: ExitCase; ownView?: boolean }) {
  return (
    <dl className="kv">
      {!ownView && <Item term="Employee">{`${x.employeeName} (${x.employeeCode})`}</Item>}
      <Item term="State">
        <StateBadge state={x.state} /> <span className="hint">{EXIT_STATE_HINT[x.state] ?? ''}</span>
      </Item>
      <Item term="Separation type">{readable(x.separationType)}</Item>
      <Item term="Resignation date">{formatDate(x.requestDate)}</Item>
      <Item term="Proposed last working date">{formatDate(x.proposedLastWorkingDate)}</Item>
      <Item term="Recommended last working date">{formatDate(x.recommendedLastWorkingDate)}</Item>
      <Item term="Approved last working date">{formatDate(x.approvedLastWorkingDate)}</Item>
      <Item term="Last working date (inclusive)">{formatDate(x.lastWorkingDate)}</Item>
      <Item term="Contractual notice period">{noticeText(x.noticePeriod)}</Item>
      {x.reasonCode !== undefined && x.reasonCode !== null && <Item term="Reason code">{x.reasonCode}</Item>}
      {x.reason !== undefined && x.reason !== null && <Item term="Reason">{x.reason}</Item>}
      {x.employeeMessage && <Item term={ownView ? 'Message from HR' : 'Message to the employee'}>{x.employeeMessage}</Item>}
      <Item term="Final release">
        {x.released ? (
          <>
            Released <When at={x.releasedAt} />
          </>
        ) : (
          'Not released'
        )}
      </Item>
    </dl>
  );
}

/** Exit refusals after which an HR form is gone once the exit reloads (it closed or was released meanwhile). */
const EXIT_GONE: ReadonlySet<string> = new Set(['INVALID_STATE', 'ALREADY_RELEASED', 'NOT_FOUND']);

/** F1: the contractual notice period is recorded from the contract (no default); nothing is calculated from it here. */
function NoticePeriodForm({ exit: x, onDone }: { exit: ExitDetail; onDone: Done }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const recorded = x.noticePeriod.status === 'RECORDED' ? String(x.noticePeriod.contractualNoticeDays) : '';
  // The recorded value until something is typed; what was typed stays after a refusal (the version is read when sending).
  const [typed, setTyped] = useState<string | null>(null);
  const days = typed ?? recorded;
  const setDays = (value: string) => setTyped(value);
  const [problem, setProblem] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: (n: number) => api<ExitDetail>(`/v1/exit-cases/${x.id}/notice-period`, { method: 'PUT', body: { contractualNoticeDays: n, expectedVersion: x.version } }),
    onSuccess: (_d, n) => {
      setTyped(null);
      onDone(`Recorded the contractual notice period: ${plural(n, 'day')}.`);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.status === 409 || error.status === 404) void qc.invalidateQueries({ queryKey: keys.exits });
      reportGone(error, 'notice-period', EXIT_GONE, onDone);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (record.isPending) return;
    const typed = days.trim();
    if (!/^\d{1,4}$/.test(typed) || Number(typed) > NOTICE_DAYS_LIMIT) {
      setProblem(`Enter the notice period as a whole number of days from 0 to ${NOTICE_DAYS_LIMIT}.`);
      record.reset();
      return;
    }
    setProblem(null);
    record.mutate(Number(typed));
  };
  return (
    <Section title="Contractual notice period">
      <p className="hint">
        Record the notice period from the employee’s contract. There is no default; a notice adjustment in the settlement needs it recorded. Nothing is calculated from it here.
      </p>
      <form aria-label="Contractual notice period" className="row" onSubmit={submit}>
        <label>
          Notice period (days)
          <input type="number" min={0} max={NOTICE_DAYS_LIMIT} step={1} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <button type="submit" disabled={record.isPending}>
          Record notice period
        </button>
      </form>
      <Problem text={problem} />
      <Refusal error={record.error} action="notice-period" except={EXIT_GONE} />
    </Section>
  );
}

/** F1 "no skipped required clearance at final release": the checklist of the exit and its incomplete required tasks. */
function ClearanceSection({ exit: x, own, onDone }: { exit: ExitDetail; own: boolean; onDone: Done }) {
  const { can } = useSession();
  const c = x.clearance;
  const canStart = can(PROCESS_MANAGE) && !own && (x.state === 'APPROVED' || x.state === 'SEPARATED') && !x.released && !c.started;
  return (
    <Section title="Clearance checklist">
      <p style={FLUSH}>
        {!c.started
          ? 'Not started.'
          : c.complete
            ? 'Every required clearance task is complete.'
            : `Required clearance tasks still incomplete: ${c.incompleteRequired.length > 0 ? c.incompleteRequired.join(', ') : 'see the checklist'}.`}
      </p>
      {c.processIds.length > 0 && (
        <ul aria-label="Clearance checklists">
          {c.processIds.map((id, i) => (
            <li key={id}>
              {can(PROCESS_READ) ? (
                <Link to={PATHS.process(id)}>{c.processIds.length > 1 ? `Open clearance checklist ${i + 1}` : 'Open the clearance checklist'}</Link>
              ) : (
                `Clearance checklist ${i + 1}`
              )}
            </li>
          ))}
        </ul>
      )}
      {canStart && <StartClearanceForm exit={x} onDone={onDone} />}
    </Section>
  );
}

/** Clearance refusals after which the start form is gone once the exit reloads. */
const CLEARANCE_GONE: ReadonlySet<string> = new Set(['CLEARANCE_EXISTS', 'EXIT_NOT_APPROVED']);

function StartClearanceForm({ exit: x, onDone }: { exit: ExitDetail; onDone: Done }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canList = can(TEMPLATE_READ);
  const templates = useQuery({
    enabled: canList,
    queryKey: keys.templateList,
    queryFn: () => api<{ items: TemplateSummary[] }>('/v1/lifecycle-processes'),
    retry: retryTransient,
  });
  const listed = shown(templates);
  const exitTemplates = (listed?.items ?? []).filter((t) => t.processType === EXIT_TYPE && t.active && t.publishedRevision !== null);
  const [code, setCode] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: (body: { processCode: string; exitCaseId: string; effectiveDate?: string }) => api<ProcessDetail>(`/v1/employees/${x.employeeId}/processes`, { body }),
    onSuccess: (p) => {
      setCode('');
      setEffectiveDate('');
      onDone(`Started the clearance checklist ${p.processName} with ${plural(p.tasks.length, 'task')}.`);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.status === 409) {
        void qc.invalidateQueries({ queryKey: keys.exits });
        void qc.invalidateQueries({ queryKey: keys.processes });
      }
      reportGone(error, 'start', CLEARANCE_GONE, onDone);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (start.isPending) return;
    const processCode = code.trim();
    let issue: string | null = null;
    if (!CODE.test(processCode)) issue = canList ? 'Choose the exit clearance template.' : 'Enter the exit clearance template code.';
    else if (effectiveDate && !ISO_DATE.test(effectiveDate)) issue = 'Enter a valid effective date.';
    setProblem(issue);
    if (issue) {
      start.reset();
      return;
    }
    start.mutate({ processCode, exitCaseId: x.id, ...(effectiveDate ? { effectiveDate } : {}) });
  };
  return (
    <form aria-label="Start the clearance checklist" className="stack" onSubmit={submit}>
      <div style={FIELDS}>
        {canList ? (
          <label>
            Exit clearance template
            <select value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Choose a template…</option>
              {exitTemplates.map((t) => (
                <option key={t.id} value={t.code}>
                  {`${t.name} (${t.code}) · revision ${t.publishedRevision}`}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Exit clearance template code
            <input value={code} maxLength={40} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
        )}
        <label>
          Effective date (leave empty for today)
          <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
        </label>
      </div>
      {canList && listed && exitTemplates.length === 0 && (
        <p className="hint" style={FLUSH}>
          No active exit clearance template has a published revision yet.
        </p>
      )}
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={start.isPending}>
          Start clearance checklist
        </button>
      </div>
      <Refusal error={start.error} action="start" except={CLEARANCE_GONE} />
    </form>
  );
}

function FinalRelease({ exit: x, onDone }: { exit: ExitDetail; onDone: Done }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const release = useMutation({
    mutationFn: () => api<ExitDetail>(`/v1/exit-cases/${x.id}/final-release`, { body: { expectedVersion: x.version } }),
    onSuccess: () => onDone('Recorded the final release. The exit and its clearance checklist are final.'),
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.status === 409 || error.status === 404) void qc.invalidateQueries({ queryKey: keys.exits });
      reportGone(error, 'release', EXIT_GONE, onDone);
    },
  });
  return (
    <Section title="Final release">
      <p className="hint">
        The final release is recorded on or after the last working date ({formatDate(x.approvedLastWorkingDate)}), once every required clearance task is complete and no withdrawal request is
        waiting.
      </p>
      <div>
        <button type="button" disabled={release.isPending || !x.clearance.complete} onClick={() => release.mutate()}>
          Record final release
        </button>
      </div>
      <Refusal error={release.error} action="release" except={EXIT_GONE} />
    </Section>
  );
}

function WithdrawalList({ withdrawals, nested, ownView, action }: { withdrawals: ExitWithdrawal[]; nested?: boolean; ownView?: boolean; action?: (w: ExitWithdrawal) => ReactNode }) {
  if (withdrawals.length === 0) return null;
  return (
    <Block title="Withdrawal requests" nested={nested}>
      <ul className="tasks" aria-label="Withdrawal requests">
        {withdrawals.map((w) => (
          <li key={w.id}>
            <div>
              <StateBadge state={w.state} /> requested <When at={w.requestedAt} />
              {w.decidedAt && (
                <>
                  , decided <When at={w.decidedAt} />
                </>
              )}
            </div>
            {w.reason !== undefined && <div>Reason: {w.reason}</div>}
            {w.employeeMessage && <div>{`${ownView ? 'Message from HR' : 'Message to the employee'}: ${w.employeeMessage}`}</div>}
            {action?.(w)}
          </li>
        ))}
      </ul>
    </Block>
  );
}

/**
 * Decisions in time order. The resignation's own decisions come first (a withdrawal request needs an approved
 * resignation), so a decision of another transaction is a withdrawal decision.
 */
function DecisionTrail({ decisions, nested }: { decisions: ExitDecision[]; nested?: boolean }) {
  if (decisions.length === 0) return null;
  const exitTransaction = decisions[0]?.transactionId;
  const label = (d: ExitDecision) =>
    d.transactionId !== exitTransaction ? 'Withdrawal decision' : d.action === 'recommend' ? 'Recommendation of the last working date' : d.action === 'approve' ? 'HR decision' : readable(d.action);
  return (
    <Block title="Decisions" nested={nested}>
      <ul aria-label="Decisions">
        {decisions.map((d, i) => (
          <li key={`${d.transactionId}-${d.step}-${i}`}>
            {`${label(d)} (step ${d.step}): ${DECISION_LABEL[d.decision] ?? readable(d.decision).toLowerCase()} on `}
            <When at={d.decidedAt} />
          </li>
        ))}
      </ul>
    </Block>
  );
}

function exitStateChange(e: ExitEvent): string {
  if (e.fromState === e.toState) return readable(e.toState);
  return `${e.fromState === 'NONE' ? 'New' : readable(e.fromState)} → ${readable(e.toState)}`;
}
function statusChange(e: ExitEvent): string {
  if (!e.employeeStatusBefore && !e.employeeStatusAfter) return '—';
  return `${e.employeeStatusBefore ? statusLabel(e.employeeStatusBefore) : '—'} → ${e.employeeStatusAfter ? statusLabel(e.employeeStatusAfter) : '—'}`;
}

/** Every step, with the employee's status changes (NOTICE on approval, separation after the last working date). */
function ExitHistory({ history, nested, ownView }: { history: ExitEvent[]; nested?: boolean; ownView?: boolean }) {
  const { me } = useSession();
  const myUserId = me?.userId ?? null;
  return (
    <Block title="History" nested={nested}>
      {history.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Exit history">
            <thead>
              <tr>
                <th>Business date</th>
                <th>Recorded</th>
                <th>Step</th>
                <th>State</th>
                <th>Last working date</th>
                <th>Employee status</th>
                {!ownView && <th>By</th>}
              </tr>
            </thead>
            <tbody>
              {history.map((e, i) => (
                <tr key={`${e.occurredAt}-${i}`}>
                  <td>{formatDate(e.businessDate)}</td>
                  <td>
                    <When at={e.occurredAt} />
                  </td>
                  <td>{EXIT_ACTION_LABEL[e.action] ?? readable(e.action)}</td>
                  <td>{exitStateChange(e)}</td>
                  <td>{formatDate(e.lastWorkingDate)}</td>
                  <td>{statusChange(e)}</td>
                  {!ownView && <td>{userText(e.actorUserId, myUserId)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exit decision queues (F1): the manager's recommendation, then the independent HR decision; withdrawal requests.
// GET /v1/exit-cases/tasks/mine lists all three; each is decided with its step's own duty and an idempotency key.
// ---------------------------------------------------------------------------------------------------------
type ExitQueueKind = 'recommend' | 'approve' | 'withdrawal';

const EXIT_QUEUES: Record<ExitQueueKind, { title: string; hint: string; empty: string; permission: string; matches: (t: ExitTask) => boolean }> = {
  recommend: {
    title: 'Resignation recommendations',
    hint: 'Recommend each resignation’s last working date; the date is inclusive. An independent HR Administrator then decides.',
    empty: 'No resignations are waiting for your recommendation.',
    permission: EXIT_RECOMMEND,
    matches: (t) => t.kind === 'exit_case' && t.step === 'recommend',
  },
  approve: {
    title: 'Resignation approvals',
    hint: 'Approve the recommended last working date or another one, or do not approve the resignation with a private reason and a message for the employee.',
    empty: 'No resignations are waiting for your decision.',
    permission: EXIT_APPROVE,
    matches: (t) => t.kind === 'exit_case' && t.step === 'approve',
  },
  withdrawal: {
    title: 'Resignation withdrawal requests',
    hint: 'An approved resignation is withdrawn only through an independent HR decision, with a reason; not approving also needs a message for the employee.',
    empty: 'No withdrawal requests are waiting for your decision.',
    permission: EXIT_APPROVE,
    matches: (t) => t.kind === 'exit_withdrawal',
  },
};

function ExitRecommendationQueue() {
  const { can } = useSession();
  if (!can(EXIT_READ) || !can(EXIT_RECOMMEND)) return null;
  return <ExitQueue kind="recommend" />;
}

function ExitApprovalQueue() {
  const { can } = useSession();
  if (!can(EXIT_READ) || !can(EXIT_APPROVE)) return null;
  return <ExitQueue kind="approve" />;
}

function ExitWithdrawalQueue() {
  const { can } = useSession();
  if (!can(EXIT_READ) || !can(EXIT_APPROVE)) return null;
  return <ExitQueue kind="withdrawal" />;
}

function ExitQueue({ kind }: { kind: ExitQueueKind }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const queue = EXIT_QUEUES[kind];
  const tasks = useQuery({ queryKey: keys.exitTasks, queryFn: () => api<{ items: ExitTask[] }>('/v1/exit-cases/tasks/mine'), retry: retryTransient });
  /** Tasks the server answered for here: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<NoticeState>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter(queue.matches).filter((t) => !gone.has(t.taskId));
  const finished = (t: ExitTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.exits });
    void qc.invalidateQueries({ queryKey: keys.processes });
  };
  return (
    <Section title={`${queue.title}${data ? ` (${items.length})` : ''}`}>
      <p className="hint">{queue.hint}</p>
      {tasks.isPending && <Loading>Loading the resignations waiting for you…</Loading>}
      <QueryProblem error={tasks.error} forbidden="The selected role cannot view exit tasks." />
      <Notice notice={notice} />
      {data && items.length === 0 && <Empty>{queue.empty}</Empty>}
      {items.length > 0 && (
        <ul className="tasks" aria-label={queue.title}>
          {items.map((t) => (
            <ExitTaskItem key={t.taskId} task={t} kind={kind} onFinished={finished} />
          ))}
        </ul>
      )}
    </Section>
  );
}

type Finished = (t: ExitTask, text: string, ok: boolean) => void;

function ExitTaskItem({ task: t, kind, onFinished, linkToExit = true }: { task: ExitTask; kind: ExitQueueKind; onFinished: Finished; linkToExit?: boolean }) {
  const { can } = useSession();
  const headingId = useId();
  const x = t.exitCase;
  const permitted = can(EXIT_QUEUES[kind].permission);
  return (
    <li aria-labelledby={headingId}>
      <h3 id={headingId} style={H3}>
        {x ? `${x.employeeName} (${x.employeeCode})` : 'Resignation'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      {!x ? (
        <Empty>This resignation is not available in the selected role’s scope.</Empty>
      ) : (
        <>
          <p className="hint" style={FLUSH}>
            {kind === 'recommend' ? 'Recommendation of the last working date' : kind === 'approve' ? 'HR decision on the resignation' : 'Withdrawal of an approved resignation'}
          </p>
          <dl className="kv">
            <Item term="Resignation date">{formatDate(x.requestDate)}</Item>
            <Item term="Proposed last working date">{formatDate(x.proposedLastWorkingDate)}</Item>
            {kind !== 'recommend' && <Item term="Recommended last working date">{formatDate(x.recommendedLastWorkingDate)}</Item>}
            {kind === 'withdrawal' && <Item term="Approved last working date">{formatDate(x.approvedLastWorkingDate)}</Item>}
            <Item term="Contractual notice period">{noticeText(x.noticePeriod)}</Item>
            {x.reason !== undefined && x.reason !== null && <Item term="Employee’s reason">{x.reason}</Item>}
          </dl>
          {linkToExit && (
            <div>
              <Link to={PATHS.exit(x.id)}>Open the exit case</Link>
            </div>
          )}
          {!permitted ? (
            <p className="hint">The selected role cannot take this decision.</p>
          ) : kind === 'recommend' ? (
            <RecommendForm task={t} exit={x} onFinished={onFinished} />
          ) : kind === 'approve' ? (
            <ExitDecisionForm task={t} exit={x} onFinished={onFinished} />
          ) : (
            <WithdrawalDecisionForm task={t} exit={x} onFinished={onFinished} />
          )}
        </>
      )}
    </li>
  );
}

/** A refusal that leaves nothing to decide here (decided, withdrawn or out of reach meanwhile) closes the item. */
function finalRefusal(error: Error, t: ExitTask, action: Act, onFinished: Finished, decisionKey: { reset(): void }): void {
  if (!(error instanceof ApiError)) return;
  // The server took the key for another decision's and recorded nothing: the next attempt gets a new key.
  if (error.code === 'IDEMPOTENCY_KEY_REUSED') decisionKey.reset();
  else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t, refusalText(error, action) ?? error.message, false);
}

function RecommendForm({ task: t, exit: x, onFinished }: { task: ExitTask; exit: ExitCase; onFinished: Finished }) {
  const decisionKey = useDecisionKey('exit-recommend');
  const [date, setDate] = useState(x.proposedLastWorkingDate);
  const [problem, setProblem] = useState<string | null>(null);
  const name = `${x.employeeName} (${x.employeeCode})`;
  const recommend = useMutation({
    mutationFn: (body: { recommendedLastWorkingDate: string; idempotencyKey: string }) => api<RecommendResult>(`/v1/exit-cases/tasks/${t.taskId}/recommend`, { body }),
    onSuccess: (r, body) => {
      decisionKey.reset();
      onFinished(
        t,
        r.replayed
          ? `Your earlier recommendation for ${name} had already been recorded, so nothing was applied twice.`
          : `Recommended ${formatDate(r.recommendedLastWorkingDate ?? body.recommendedLastWorkingDate)} as the last working date of ${name}. The resignation now waits for the HR decision.`,
        true,
      );
    },
    onError: (error) => finalRefusal(error, t, 'recommend', onFinished, decisionKey),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (recommend.isPending) return;
    if (!ISO_DATE.test(date)) {
      setProblem('Enter the recommended last working date.');
      recommend.reset();
      return;
    }
    setProblem(null);
    recommend.mutate({ recommendedLastWorkingDate: date, idempotencyKey: decisionKey.next(date) });
  };
  return (
    <form aria-label={`Recommend the last working date of ${name}`} className="stack" onSubmit={submit}>
      <label>
        Recommended last working date (inclusive)
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={recommend.isPending}>
          Recommend this date
        </button>
      </div>
      <Refusal error={recommend.error} action="recommend" />
    </form>
  );
}

function exitDecidedText(name: string, r: ExitDecided): string {
  if (r.replayed) return `Your earlier decision on the resignation of ${name} had already been recorded, so nothing was applied twice.`;
  if (r.state === 'APPROVED') return `Approved the resignation of ${name}: the last working date is ${formatDate(r.approvedLastWorkingDate)} (inclusive).`;
  if (r.state === 'REJECTED') return `The resignation of ${name} was not approved; they will see your message.`;
  return `Your decision on the resignation of ${name} was recorded; it waits for the next step.`;
}

function ExitDecisionForm({ task: t, exit: x, onFinished }: { task: ExitTask; exit: ExitCase; onFinished: Finished }) {
  const decisionKey = useDecisionKey('exit-decision');
  const [date, setDate] = useState(x.recommendedLastWorkingDate ?? x.lastWorkingDate);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const name = `${x.employeeName} (${x.employeeCode})`;
  const decide = useMutation({
    mutationFn: (body: ExitDecisionBody) => api<ExitDecided>(`/v1/exit-cases/tasks/${t.taskId}/decision`, { body }),
    onSuccess: (r) => {
      decisionKey.reset();
      onFinished(t, exitDecidedText(name, r), true);
    },
    onError: (error) => finalRefusal(error, t, 'exit-decide', onFinished, decisionKey),
  });
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (decide.isPending) return;
    const why = reason.trim();
    const msg = message.trim();
    let issue: string | null = null;
    if (decision === 'REJECT' && (!why || !msg)) issue = 'To not approve the resignation, record the private reason and the message for the employee.';
    else if (decision === 'APPROVE' && date !== '' && !ISO_DATE.test(date)) issue = 'Enter a valid approved last working date, or leave it empty to approve the recommended date.';
    setProblem(issue);
    if (issue) {
      decide.reset();
      return;
    }
    const fields =
      decision === 'APPROVE'
        ? { decision, ...(date ? { approvedLastWorkingDate: date } : {}), ...(why ? { reason: why } : {}) }
        : { decision, reason: why, employeeMessage: msg };
    decide.mutate({ ...fields, idempotencyKey: decisionKey.next(JSON.stringify(fields)) } as ExitDecisionBody);
  };
  return (
    <div className="stack" role="group" aria-label={`Decide the resignation of ${name}`}>
      <label>
        Approved last working date (inclusive)
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <p className="hint" style={FLUSH}>
        Keep the recommended date ({formatDate(x.recommendedLastWorkingDate)}) or set another one, not before the resignation date or today.
      </p>
      <ReasonField label="Private reason (never shown to the employee; required to not approve)" value={reason} onChange={setReason} />
      <ReasonField label="Message to the employee (required to not approve)" value={message} onChange={setMessage} />
      <Problem text={problem} />
      <div className="row">
        <button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')}>
          Approve
        </button>
        <button type="button" className="danger" disabled={decide.isPending} onClick={() => send('REJECT')}>
          Do not approve
        </button>
      </div>
      <Refusal error={decide.error} action="exit-decide" />
    </div>
  );
}

function withdrawalDecidedText(name: string, r: WithdrawalDecided): string {
  if (r.replayed) return `Your earlier decision on the withdrawal request of ${name} had already been recorded, so nothing was applied twice.`;
  if (r.state === 'APPROVED') return `Approved the withdrawal: the resignation of ${name} is withdrawn.`;
  if (r.state === 'REJECTED') return `The withdrawal was not approved: the resignation of ${name} stands, and they will see your message.`;
  return `Your decision on the withdrawal request of ${name} was recorded; it waits for the next step.`;
}

function WithdrawalDecisionForm({ task: t, exit: x, onFinished }: { task: ExitTask; exit: ExitCase; onFinished: Finished }) {
  const keys = useKeys();
  const decisionKey = useDecisionKey('exit-withdrawal');
  // The request itself (when it was made and, for a granted caller, its reason) is on the exit case.
  const detail = useQuery({ queryKey: keys.exit(x.id), queryFn: () => api<ExitDetail>(`/v1/exit-cases/${x.id}`), retry: retryTransient });
  const pending = shown(detail)?.withdrawals.find((w) => w.state === 'SUBMITTED') ?? null;
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const name = `${x.employeeName} (${x.employeeCode})`;
  const decide = useMutation({
    mutationFn: (body: WithdrawalDecisionBody) => api<WithdrawalDecided>(`/v1/exit-withdrawals/tasks/${t.taskId}/decision`, { body }),
    onSuccess: (r) => {
      decisionKey.reset();
      onFinished(t, withdrawalDecidedText(name, r), true);
    },
    onError: (error) => finalRefusal(error, t, 'withdrawal-decide', onFinished, decisionKey),
  });
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (decide.isPending) return;
    const why = reason.trim();
    const msg = message.trim();
    let issue: string | null = null;
    if (!why) issue = 'Record the reason for your decision; it is never shown to the employee.';
    else if (decision === 'REJECT' && !msg) issue = 'To not approve the withdrawal, explain the decision to the employee.';
    setProblem(issue);
    if (issue) {
      decide.reset();
      return;
    }
    const fields = { decision, reason: why, ...(decision === 'REJECT' ? { employeeMessage: msg } : {}) };
    decide.mutate({ ...fields, idempotencyKey: decisionKey.next(JSON.stringify(fields)) });
  };
  return (
    <div className="stack" role="group" aria-label={`Decide the withdrawal request of ${name}`}>
      {pending ? (
        <p style={FLUSH}>
          Withdrawal requested <When at={pending.requestedAt} />
          {pending.reason !== undefined ? `. Reason: ${pending.reason}` : ''}
        </p>
      ) : (
        detail.isPending && <Loading>Loading the withdrawal request…</Loading>
      )}
      <ReasonField label="Reason for your decision (required; never shown to the employee)" value={reason} onChange={setReason} />
      <ReasonField label="Message to the employee (required to not approve)" value={message} onChange={setMessage} />
      <Problem text={problem} />
      <div className="row">
        <button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')}>
          Approve the withdrawal
        </button>
        <button type="button" className="danger" disabled={decide.isPending} onClick={() => send('REJECT')}>
          Do not approve
        </button>
      </div>
      <Refusal error={decide.error} action="withdrawal-decide" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Process task queue (FR-016): open tasks the caller's user or role owns, in scope, in open processes.
// ---------------------------------------------------------------------------------------------------------
function ProcessTaskQueue() {
  const { can } = useSession();
  if (!can(TASK_COMPLETE)) return null;
  return <MyProcessTasks />;
}

function MyProcessTasks() {
  const keys = useKeys();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const tasks = useQuery({
    queryKey: [...keys.myTasks, page],
    queryFn: () => api<Paged<MyTask> & { overdue: number }>(pagedUrl('/v1/employee-process-tasks/mine', page)),
    retry: retryTransient,
  });
  const [notice, setNotice] = useState<NoticeState>(null);
  const data = shown(tasks);
  const done: Done = (text, ok = true) => {
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.processes });
    void qc.invalidateQueries({ queryKey: keys.exits });
  };
  // `total` and `overdue` count every task waiting for the caller, not only this page.
  return (
    <Section title={`My process tasks${data ? ` (${totalOf(data)})` : ''}`}>
      <p className="hint">Open tasks of open processes that you or your role own, earliest due first.</p>
      {tasks.isPending && <Loading>Loading your process tasks…</Loading>}
      <QueryProblem error={tasks.error} forbidden="The selected role cannot complete process tasks." />
      <Notice notice={notice} />
      {data && data.overdue > 0 && (
        <p style={FLUSH}>
          <Badge tone="bad">overdue</Badge> {`${plural(data.overdue, 'task')} past the due date.`}
        </p>
      )}
      {data && data.items.length === 0 && <Empty>No process tasks are waiting for you.</Empty>}
      {data && data.items.length > 0 && (
        <ul className="tasks" aria-label="My process tasks">
          {data.items.map((t) => (
            <MyTaskItem key={t.id} task={t} onDone={done} />
          ))}
        </ul>
      )}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(data)} onPage={setPage} label="Task pages" noun="task" />}
    </Section>
  );
}

function MyTaskItem({ task: t, onDone }: { task: MyTask; onDone: Done }) {
  const { can } = useSession();
  const headingId = useId();
  const canComplete = can(TASK_COMPLETE);
  return (
    <li aria-labelledby={headingId}>
      <h3 id={headingId} style={H3}>
        {`${t.title} (${t.code})`}
      </h3>
      <p style={FLUSH}>
        {can(PROCESS_READ) ? <Link to={PATHS.process(t.processId)}>{t.processName}</Link> : t.processName} for {t.employeeName} ({t.employeeCode})
      </p>
      <TaskFacts task={t} employeeId={t.employeeId} />
      <TaskActions task={t} allowed={{ complete: canComplete, skip: canComplete && !t.required, reassign: false, reopen: false }} onDone={onDone} />
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// My ESS (H3 own-record context): the employee's own resignation and processes, through the module's own routes
// (/v1/me/resignation, /v1/me/exit-cases, /v1/me/processes). No H3 tab (TN01–TN18) covers them and the lifecycle
// registration declares no essTabs, so these panels carry ids of their own.
// ---------------------------------------------------------------------------------------------------------
function OwnContextNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section title={title}>
      <Empty>{children}</Empty>
    </Section>
  );
}

function MyResignationPanel() {
  const { me, can } = useSession();
  if (!me) return <OwnContextNote title="Resignation">Loading your role…</OwnContextNote>;
  if (!inOwnContext(me)) return <OwnContextNote title="Resignation">Your own resignation is handled in your Employee role. Switch to it to submit or follow one.</OwnContextNote>;
  if (!can(EXIT_READ) && !can(EXIT_SUBMIT)) {
    return (
      <Section title="Resignation">
        <NotPermitted>Your Employee role does not include resignations yet; contact HR.</NotPermitted>
      </Section>
    );
  }
  return <OwnResignation />;
}

function OwnResignation() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canRead = can(EXIT_READ);
  const canSubmit = can(EXIT_SUBMIT);
  const exits = useQuery({ enabled: canRead, queryKey: keys.myExits, queryFn: () => api<{ items: ExitDetail[] }>('/v1/me/exit-cases'), retry: retryTransient });
  const [notice, setNotice] = useState<NoticeState>(null);
  const items = canRead ? shown(exits)?.items : undefined;
  const current = items?.find((x) => OPEN_EXIT_STATES.has(x.state)) ?? null;
  const earlier = (items ?? []).filter((x) => x !== current);
  const done: Done = (text, ok = true) => {
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.exits });
  };
  const loading = canRead && exits.isPending;
  return (
    <Section title="Resignation">
      <p className="hint">Your own record only.</p>
      <Notice notice={notice} />
      {loading && <Loading>Loading your resignations…</Loading>}
      {canRead && <QueryProblem error={exits.error} forbidden="Your Employee role cannot view resignations." />}
      {current ? (
        <OwnExitCard exit={current} canAct={canSubmit} onDone={done} />
      ) : (
        items && <Empty>You have no open resignation.</Empty>
      )}
      {canSubmit && !current && !loading && <ResignationForm onDone={done} />}
      {earlier.length > 0 && (
        <div className="stack">
          <h3 style={H3}>Earlier resignations</h3>
          <ul className="tasks" aria-label="Earlier resignations">
            {earlier.map((x) => (
              <li key={x.id}>
                <div>
                  <StateBadge state={x.state} /> {`resigned ${formatDate(x.requestDate)}, last working date ${formatDate(x.lastWorkingDate)}`}
                </div>
                {x.employeeMessage && <div>{`Message from HR: ${x.employeeMessage}`}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/** Own-exit refusals after which the action is gone once the exit reloads (it was decided or changed meanwhile). */
const OWN_EXIT_GONE: ReadonlySet<string> = new Set(['INVALID_STATE', 'USE_WITHDRAWAL_REQUEST', 'WITHDRAWAL_PENDING', 'EXIT_RELEASED', 'OPEN_EXIT_EXISTS', 'NOT_FOUND']);

/** A refused own-exit action: the own exits reload when the refusal says they changed; see OWN_EXIT_GONE. */
function useOwnExitRefusal(action: Act, onDone: Done) {
  const keys = useKeys();
  const qc = useQueryClient();
  return (error: Error) => {
    if (!(error instanceof ApiError)) return;
    if (error.status === 409 || error.status === 404) void qc.invalidateQueries({ queryKey: keys.exits });
    reportGone(error, action, OWN_EXIT_GONE, onDone);
  };
}

function OwnExitCard({ exit: x, canAct, onDone }: { exit: ExitDetail; canAct: boolean; onDone: Done }) {
  const pending = x.withdrawals.find((w) => w.state === 'SUBMITTED') ?? null;
  const withdrawRefused = useOwnExitRefusal('withdraw', onDone);
  const cancelRefused = useOwnExitRefusal('withdrawal-cancel', onDone);
  const withdraw = useMutation({
    mutationFn: () => api<{ exitCaseId: string; state: string }>(`/v1/me/exit-cases/${x.id}/withdraw`, { method: 'POST' }),
    onSuccess: () => onDone('Your resignation is withdrawn. The request and its history are kept.'),
    onError: withdrawRefused,
  });
  const cancelRequest = useMutation({
    mutationFn: (withdrawalId: string) => api<{ withdrawalId: string; state: string }>(`/v1/me/exit-withdrawals/${withdrawalId}/cancel`, { method: 'POST' }),
    onSuccess: () => onDone('Your withdrawal request is cancelled; your approved resignation stands.'),
    onError: cancelRefused,
  });
  const canWithdraw = canAct && (x.state === 'SUBMITTED' || x.state === 'RECOMMENDED');
  const canRequest = canAct && x.state === 'APPROVED' && !x.released && pending === null;
  return (
    <article aria-label="Your resignation" className="stack">
      <ExitFacts x={x} ownView />
      {canWithdraw && (
        <div className="stack">
          <p className="hint" style={FLUSH}>
            Until HR decides, you can withdraw your resignation yourself.
          </p>
          <div>
            <button type="button" className="danger" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>
              Withdraw my resignation
            </button>
          </div>
          <Refusal error={withdraw.error} action="withdraw" except={OWN_EXIT_GONE} />
        </div>
      )}
      {canRequest && <WithdrawalRequestForm exit={x} onDone={onDone} />}
      <WithdrawalList
        withdrawals={x.withdrawals}
        nested
        ownView
        action={(w) =>
          canAct && w.state === 'SUBMITTED' ? (
            <>
              <div>
                <button type="button" className="secondary" disabled={cancelRequest.isPending} onClick={() => cancelRequest.mutate(w.id)}>
                  Cancel my withdrawal request
                </button>
              </div>
              <Refusal error={cancelRequest.error} action="withdrawal-cancel" except={OWN_EXIT_GONE} />
            </>
          ) : null
        }
      />
      <DecisionTrail decisions={x.decisions} nested />
      <ExitHistory history={x.history} nested ownView />
    </article>
  );
}

function WithdrawalRequestForm({ exit: x, onDone }: { exit: ExitDetail; onDone: Done }) {
  const refused = useOwnExitRefusal('withdrawal-request', onDone);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: (text: string) => api<{ withdrawalId: string; exitCaseId: string; state: string }>(`/v1/me/exit-cases/${x.id}/withdrawal-request`, { body: { reason: text } }),
    onSuccess: () => {
      setReason('');
      onDone('Your withdrawal request was sent. An HR Administrator decides it independently; until then your approved resignation stands.');
    },
    onError: refused,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (request.isPending) return;
    const text = reason.trim();
    setProblem(text ? null : 'Enter why you want to withdraw your resignation.');
    if (!text) {
      request.reset();
      return;
    }
    request.mutate(text);
  };
  return (
    <form aria-label="Request to withdraw your resignation" className="stack" onSubmit={submit}>
      <p className="hint" style={FLUSH}>
        Your resignation is approved, so withdrawing it needs an independent HR decision. You can ask until your last working date.
      </p>
      <ReasonField label="Why do you want to withdraw it? (required)" value={reason} onChange={setReason} />
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={request.isPending}>
          Request withdrawal
        </button>
      </div>
      <Refusal error={request.error} action="withdrawal-request" except={OWN_EXIT_GONE} />
    </form>
  );
}

function ResignationForm({ onDone }: { onDone: Done }) {
  const refused = useOwnExitRefusal('resign', onDone);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const submit = useMutation({
    mutationFn: (body: { proposedLastWorkingDate: string; reasonCode?: string; reason?: string }) => api<ResignationResult>('/v1/me/resignation', { body }),
    onSuccess: (r) => {
      setDate('');
      setReason('');
      setReasonCode('');
      onDone(
        `Your resignation was submitted on ${formatDate(r.requestDate)} with the proposed last working date ${formatDate(r.proposedLastWorkingDate)}. Your manager recommends the last working date, then HR decides.`,
      );
    },
    // An open resignation recorded meanwhile (another tab): it shows once the list reloads, in place of this form.
    onError: refused,
  });
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (submit.isPending) return;
    const code = reasonCode.trim();
    const text = reason.trim();
    let issue: string | null = null;
    if (!ISO_DATE.test(date)) issue = 'Enter your proposed last working date.';
    else if (code && !REASON_CODE.test(code)) issue = 'A reason code has capital letters, digits and underscores only.';
    setProblem(issue);
    if (issue) {
      submit.reset();
      return;
    }
    submit.mutate({ proposedLastWorkingDate: date, ...(code ? { reasonCode: code } : {}), ...(text ? { reason: text } : {}) });
  };
  return (
    <form aria-label="Submit your resignation" className="stack" onSubmit={send}>
      <h3 style={H3}>Resign</h3>
      <p className="hint" style={FLUSH}>
        Propose your last working date; it is inclusive, so you work on that day. Your manager recommends the date, then an HR Administrator decides. Until that decision you can withdraw the
        resignation yourself.
      </p>
      <label>
        Proposed last working date (inclusive)
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <ReasonField label="Reason (optional; seen by you and authorised reviewers only)" value={reason} onChange={setReason} />
      <label>
        Reason code (optional, if your company uses them)
        <input value={reasonCode} maxLength={60} onChange={(e) => setReasonCode(e.target.value.toUpperCase())} />
      </label>
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={submit.isPending}>
          Submit resignation
        </button>
      </div>
      <Refusal error={submit.error} action="resign" except={OWN_EXIT_GONE} />
    </form>
  );
}

function MyProcessesPanel() {
  const { me, can } = useSession();
  if (!me) return <OwnContextNote title="Processes and tasks">Loading your role…</OwnContextNote>;
  if (!inOwnContext(me)) return <OwnContextNote title="Processes and tasks">Your own processes are shown in your Employee role. Switch to it to follow them.</OwnContextNote>;
  if (!can(PROCESS_READ)) {
    return (
      <Section title="Processes and tasks">
        <NotPermitted>Your Employee role does not include processes yet; contact HR.</NotPermitted>
      </Section>
    );
  }
  return <OwnProcesses />;
}

function OwnProcesses() {
  const keys = useKeys();
  const panelId = useId();
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: [...keys.myProcesses, page], queryFn: () => api<Paged<ProcessSummary>>(pagedUrl('/v1/me/processes', page)), retry: retryTransient });
  const [openId, setOpenId] = useState<string | null>(null);
  const data = shown(list);
  return (
    <Section title="Processes and tasks">
      <p className="hint">Your own record only: processes about you, such as onboarding or exit clearance. Tasks owned by the Employee role are yours to complete.</p>
      {list.isPending && <Loading>Loading your processes…</Loading>}
      <QueryProblem error={list.error} forbidden="Your Employee role cannot view processes." />
      {data && data.items.length === 0 && <Empty>No processes about you.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="My processes">
            <thead>
              <tr>
                <th>Process</th>
                <th>Type</th>
                <th>State</th>
                <th>Effective date</th>
                <th>Open tasks</th>
                <th>Overdue</th>
                <th>Tasks</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.processName}</td>
                  <td>{typeLabel(p.processType)}</td>
                  <td>
                    <StateBadge state={p.state} />
                  </td>
                  <td>{formatDate(p.effectiveDate)}</td>
                  <td>{`${p.openTasks} of ${p.taskCount}`}</td>
                  <td>{p.overdueTasks > 0 ? <Badge tone="bad">{`${p.overdueTasks} overdue`}</Badge> : '0'}</td>
                  <td>
                    <button type="button" className="secondary" aria-expanded={openId === p.id} aria-controls={panelId} onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                      {openId === p.id ? 'Hide tasks' : 'Show tasks'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(data)} onPage={setPage} label="My process pages" noun="process" plural="processes" />}
      <div id={panelId} className="stack">
        {openId && <ProcessView key={openId} processId={openId} embedded />}
      </div>
    </Section>
  );
}

function MyResignationScreen() {
  return (
    <>
      <h1>My resignation</h1>
      <MyResignationPanel />
    </>
  );
}

function MyProcessesScreen() {
  return (
    <>
      <h1>My processes</h1>
      <MyProcessesPanel />
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (App.tsx wires them): screens, own-record panels and decision queues
// ---------------------------------------------------------------------------------------------------------

/** The module's screens; detail screens are reached through links (`nav: false`). */
export const LIFECYCLE_PROCESSES_SCREENS: ScreenRoute[] = [
  { path: PATHS.templates, title: 'Process templates', permission: TEMPLATE_READ, nav: true, component: TemplatesScreen },
  { path: '/lifecycle/process-templates/:id', title: 'Process template', permission: TEMPLATE_READ, nav: false, component: TemplateDetailScreen },
  { path: PATHS.processes, title: 'Employee processes', permission: PROCESS_READ, nav: true, component: ProcessesScreen },
  { path: '/lifecycle/processes/:id', title: 'Employee process', permission: PROCESS_READ, nav: false, component: ProcessDetailScreen },
  { path: '/lifecycle/employees/:id', title: 'Employee processes and exit', permission: PROCESS_READ, nav: false, component: EmployeeLifecycleScreen },
  { path: PATHS.exits, title: 'Exit cases', permission: EXIT_READ, nav: true, component: ExitsScreen },
  { path: '/lifecycle/exits/:id', title: 'Exit case', permission: EXIT_READ, nav: false, component: ExitDetailScreen },
  { path: PATHS.myResignation, title: 'My resignation', permission: EXIT_SUBMIT, nav: true, component: MyResignationScreen },
  { path: PATHS.myProcesses, title: 'My processes', permission: PROCESS_READ, nav: false, component: MyProcessesScreen },
];

/**
 * The employee's own resignation and processes for the ESS hub (Employee OWN context). The lifecycle module serves no
 * H3 tab (TN01–TN18) and declares no essTabs: the panels use the module's own /v1/me routes, and their ids are not H3
 * ids, so the hub shows them beside its index-driven tabs (the /me/resignation and /me/processes screens show them too).
 */
export const LIFECYCLE_PROCESSES_ESS_PANELS: EssPanel[] = [
  { tabId: 'RESIGNATION', component: MyResignationPanel },
  { tabId: 'MY_PROCESSES', component: MyProcessesPanel },
];

/**
 * The decision queues, also shown on the exit and process screens. The three exit queues list
 * GET /v1/exit-cases/tasks/mine (exit.read) and decide with their step's own duty; the process task queue lists
 * GET /v1/employee-process-tasks/mine and completes or skips tasks.
 */
export const LIFECYCLE_PROCESSES_TASK_QUEUES: { permission: string; title: string; component: ComponentType }[] = [
  { permission: EXIT_RECOMMEND, title: 'Resignation recommendations', component: ExitRecommendationQueue },
  { permission: EXIT_APPROVE, title: 'Resignation approvals', component: ExitApprovalQueue },
  { permission: EXIT_APPROVE, title: 'Resignation withdrawal requests', component: ExitWithdrawalQueue },
  { permission: TASK_COMPLETE, title: 'My process tasks', component: ProcessTaskQueue },
];
