// Shared parts of the lifecycle process screens: keys, paths, limits, query keys, labels, helpers and small components.

import { type ReactNode, useMemo, useRef } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { CheckField, FormField } from '@/components/form-field';
import { LoadingLine } from '@/components/loading-line';
import { Textarea } from '@/components/ui/textarea';
import { idempotencyKey, isForbidden, isNotFound, plural, readable } from '../../api';
import { type MeContext, useSession } from '../../session';
import { Empty, ErrorNote, Notice, NotPermitted, pageParams, Section } from '../../ui';
import type { NoteKind, NoticePeriod, OwnerRef, ProcessTask } from './types';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/lifecycle/registration.ts; migration 0038_lifecycle.sql; the requireAccess calls of
// process-routes.ts and exit-routes.ts) and screen paths
// ---------------------------------------------------------------------------------------------------------
export const TEMPLATE_READ = 'lifecycle_process.read.operational';
export const TEMPLATE_MANAGE = 'lifecycle_process.manage.operational';
export const PROCESS_READ = 'employee_process.read.operational';
export const PROCESS_MANAGE = 'employee_process.manage.operational';
export const TASK_COMPLETE = 'employee_process.complete_task.operational';
export const PROCESS_REOPEN = 'employee_process.reopen.operational';
export const EVIDENCE_READ = 'employee_process.read_evidence.evidence';
export const NOTE_READ = 'employee_note.read.restricted';
export const NOTE_WRITE = 'employee_note.write.restricted';
export const EXIT_SUBMIT = 'exit.submit.operational';
export const EXIT_READ = 'exit.read.operational';
export const EXIT_RECOMMEND = 'exit.recommend.operational';
export const EXIT_APPROVE = 'exit.approve.operational';
export const EXIT_MANAGE = 'exit.manage.operational';
/** GET /v1/employees: the employee search. */
export const EMPLOYEE_LIST = 'employee.list.operational';
/** GET /v1/employees/:id: the employee's name on their lifecycle screen. */
export const EMPLOYEE_READ = 'employee.read.operational';

export const PATHS = {
  templates: '/lifecycle/process-templates',
  template: (id: string) => `/lifecycle/process-templates/${id}`,
  processes: '/lifecycle/processes',
  process: (id: string) => `/lifecycle/processes/${id}`,
  employee: (id: string) => `/lifecycle/employees/${id}`,
  exits: '/lifecycle/exits',
  exit: (id: string) => `/lifecycle/exits/${id}`,
  notes: '/lifecycle/notes',
  notesUpload: '/lifecycle/notes/upload',
  myResignation: '/me/resignation',
  myProcesses: '/me/processes',
} as const;

/** The Employee role in OWN scope is the own-ESS context (BR-055; access/authorize.ts OWN_ESS_ROLE_CODES). */
const OWN_ESS_ROLE = 'EMPLOYEE';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Template, task and process codes (process-routes.ts `code`). */
export const CODE = /^[A-Z][A-Z0-9_]{0,39}$/;
/** Process types and owner role codes. */
export const LONG_CODE = /^[A-Z][A-Z0-9_]{0,59}$/;
export const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Upload file names: no path separators, reserved characters or control characters (storage/files.ts). */
export const FILE_NAME = /^[^/\\<>:"|?*\u0000-\u001f\u007f]+$/;
export const MAX_FILE_NAME = 255;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TASKS = 200;
export const MAX_NAME = 200;
const MAX_REASON = 1000;
export const MAX_REMARK = 2000;
export const MAX_NOTE = 4000;
export const DUE_OFFSET_LIMIT = 3650;
export const NOTICE_DAYS_LIMIT = 3650;
/**
 * FR-056: the exit, process, task and note lists are read a page at a time (page/pageSize); every answer carries the
 * total of every match in scope, so nothing beyond a fixed limit is silently left out.
 */
export interface Paged<T> {
  items: T[];
  total?: number;
}
/** The total of a paged answer (an older answer without one counts its items). */
export const totalOf = (p: Paged<unknown>) => p.total ?? p.items.length;
export const pagedUrl = (path: string, page: number, query?: URLSearchParams) => `${path}?${query && query.toString() ? `${query.toString()}&` : ''}${pageParams(page)}`;
/** GET /v1/employees accepts page sizes of 25, 50 or 100. */
export const EMPLOYEE_PAGE_SIZE = 25;
export const EXIT_TYPE = 'EXIT';

/** The LIFECYCLE_PROCESS_TYPE values the module seeds (FR-015 target examples); a company may add others. */
export const PROCESS_TYPES: readonly (readonly [code: string, label: string])[] = [
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
export const OWNER_ROLES: readonly (readonly [code: string, label: string])[] = [
  ['HR_ADMINISTRATOR', 'HR Administrator'],
  ['REPORTING_MANAGER', 'Reporting manager'],
  ['EMPLOYEE', 'Employee'],
  ['SYSTEM_ADMINISTRATOR', 'System Administrator'],
  ['PAYROLL_OPERATOR', 'Payroll operator'],
  ['FINANCE_REVIEWER', 'Finance reviewer'],
];
/** The exit states GET /v1/exit-cases filters by. */
export const EXIT_STATES = ['SUBMITTED', 'RECOMMENDED', 'APPROVED', 'SEPARATED', 'REJECTED', 'WITHDRAWN'] as const;
export const OPEN_EXIT_STATES: ReadonlySet<string> = new Set(['SUBMITTED', 'RECOMMENDED', 'APPROVED']);

// ---------------------------------------------------------------------------------------------------------
// Query keys: they carry the selected company and assignment. The app keeps one query cache across role switches, and
// an answer given to one assignment (a scoped list, a remark, an exit reason) is never shown under another.
// ---------------------------------------------------------------------------------------------------------
export function useKeys() {
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

/** The latest answer, unless the server has since refused it (403/404): what the role may no longer see is not kept. */
export function shown<T>(query: { data: T | undefined; error: unknown }): T | undefined {
  return isForbidden(query.error) || isNotFound(query.error) ? undefined : query.data;
}

export const typeLabel = (code: string) => PROCESS_TYPES.find(([c]) => c === code)?.[1] ?? readable(code);
export const roleLabel = (code: string) => OWNER_ROLES.find(([c]) => c === code)?.[1] ?? readable(code);

export const PROCESS_ACTION_LABEL: Record<string, string> = {
  START: 'Process started',
  COMPLETE: 'Task completed',
  SKIP: 'Task skipped',
  REOPEN_TASK: 'Task reopened',
  REASSIGN: 'Task reassigned',
  CLOSE: 'Process closed',
  REOPEN: 'Process reopened',
  CANCEL: 'Process cancelled',
};
export const EXIT_ACTION_LABEL: Record<string, string> = {
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
export const EXIT_STATE_HINT: Record<string, string> = {
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
export const statusLabel = (code: string) => EMPLOYEE_STATUS_LABEL[code] ?? readable(code);
export const DECISION_LABEL: Record<string, string> = { APPROVE: 'approved', REJECT: 'not approved' };
export const NOTE_KINDS: readonly (readonly [NoteKind, string])[] = [
  ['NOTE', 'Note'],
  ['REMARK', 'Remark'],
  ['WARNING', 'Warning'],
  // The reference register's types (CL-040, 0260).
  ['APPRECIATION', 'Appreciation'],
  ['EXIT_NOTE', 'Exit note'],
  ['OFFER_REJECTION', 'Offer rejection'],
  ['PIP', 'Performance improvement plan (PIP)'],
];
export const noteKindLabel = (kind: string) => NOTE_KINDS.find(([k]) => k === kind)?.[1] ?? readable(kind);
/** A note's type in words, lower case: an absconding warning (CL-052, 0283) says so. */
export const noteTypeText = (n: { kind: string; warningCategory?: string | null }) => (n.kind === 'WARNING' && n.warningCategory === 'ABSCONDING' ? 'absconding warning' : noteKindLabel(n.kind).toLowerCase());
/** CL-052 (0283): the checkbox that marks a warning as an absconding warning; the server refuses the mark on any other type. */
export function AbscondingMark({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <CheckField>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> Absconding warning (away from work without leave or word)
    </CheckField>
  );
}
export const SCAN_TEXT: Record<string, string> = {
  PENDING_SCAN: 'waiting for the malware scan',
  CLEAN: 'released by the malware scan',
  QUARANTINED: 'quarantined by the malware scan',
};
export const SCAN_TONE: Record<string, 'good' | 'warn' | 'bad'> = { CLEAN: 'good', PENDING_SCAN: 'warn', QUARANTINED: 'bad' };

export function dueOffsetText(days: number): string {
  if (days === 0) return 'On the effective date';
  return days > 0 ? `${plural(days, 'day')} after the effective date` : `${plural(-days, 'day')} before the effective date`;
}

/** F1: the notice period is a configured contractual field, shown as recorded; nothing is derived from it here. */
export function noticeText(n: NoticePeriod): string {
  return n.status === 'RECORDED' ? `${plural(n.contractualNoticeDays, 'day')} (contractual)` : 'Not recorded';
}

/** A user by the id the server returned; "You" for the signed-in user. The API returns no names for users. */
export const userText = (id: string | null | undefined, myUserId: string | null) => (!id ? '—' : id === myUserId ? 'You' : `User ${id}`);

export function ownerText(t: { ownerRoleCode: string | null; ownerUserId: string | null; ownerName?: string | null }, myUserId: string | null): string {
  if (t.ownerRoleCode) return `${roleLabel(t.ownerRoleCode)} (role)`;
  if (!t.ownerUserId) return '—';
  if (t.ownerUserId === myUserId) return t.ownerName ? `You (${t.ownerName})` : 'You';
  return t.ownerName ?? `User ${t.ownerUserId}`;
}
export const ownerRefText = (o: OwnerRef | null, myUserId: string | null) => (!o ? '—' : o.roleCode ? `${roleLabel(o.roleCode)} (role)` : userText(o.userId, myUserId));

/**
 * Whether the signed-in assignment owns a task, as the API decides it (processes.ts ownsTask): on one's own record only
 * the Employee role's tasks, in the Employee role; otherwise the task's named user or role.
 */
export function ownsTask(me: MeContext | null, employeeId: string, t: Pick<ProcessTask, 'ownerRoleCode' | 'ownerUserId'>): boolean {
  if (!me) return false;
  if (me.employeeId === employeeId) return t.ownerRoleCode === OWN_ESS_ROLE && me.roleCode === OWN_ESS_ROLE;
  return t.ownerUserId === me.userId || (t.ownerRoleCode !== null && t.ownerRoleCode === me.roleCode);
}

/** H3/BR-055: own ESS data is used in the Employee role's OWN context; other roles switch to it. */
export const inOwnContext = (me: MeContext | null) => me !== null && me.roleCode === OWN_ESS_ROLE && me.scopeKind === 'OWN' && me.employeeId !== null;

/**
 * One idempotency key per decision (ZT07). Sending the same decision again after a failure (its answer may have been
 * lost) reuses the key, so the server answers from what it recorded and never applies it twice; any other decision is
 * a new action with a new key.
 */
export function useDecisionKey(prefix: string) {
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
// Shared pieces
// ---------------------------------------------------------------------------------------------------------
/** The fields of a one-column form side by side, in columns at least 190px wide, lined up along their bottom; none outgrows its column. */
export const FIELDS = 'grid grid-cols-[repeat(auto-fill,minmax(190px,1fr))] items-end gap-3 *:min-w-0';

export type NoticeState = { text: string; ok: boolean } | null;

// The screens of this module take their notice from here; it is the app's own, so an outcome reads the same on every screen.
export { Notice };

export function Problem({ text }: { text: string | null }) {
  if (!text) return null;
  return <Notice notice={{ text, ok: false }} />;
}

/**
 * The role context and its permissions arrive together (session.tsx). Until then nothing is known: no screen says the
 * role is not permitted and no own-record panel asks to switch roles.
 */
export function RoleReady({ children }: { children: ReactNode }) {
  const { me } = useSession();
  return me ? <>{children}</> : <LoadingLine>Loading your role…</LoadingLine>;
}

/** A read that failed: not permitted, not in scope (when `missing` is given) or the API's own error. */
export function QueryProblem({ error, forbidden, missing }: { error: unknown; forbidden: string; missing?: string }) {
  if (!error) return null;
  if (isForbidden(error)) return <NotPermitted>{forbidden}</NotPermitted>;
  if (missing !== undefined && isNotFound(error)) return <Empty>{missing}</Empty>;
  return <ErrorNote error={error} />;
}

/** A titled block: a card of its own on a screen, or a sub-heading inside another card (the My ESS panels). */
export function Block({ title, nested, children }: { title: string; nested?: boolean; children: ReactNode }) {
  if (!nested) return <Section title={title}>{children}</Section>;
  return (
    <div className="stack">
      <CardSubheading>{title}</CardSubheading>
      {children}
    </div>
  );
}

export function ReasonField({ label, value, onChange, max = MAX_REASON }: { label: string; value: string; onChange: (value: string) => void; max?: number }) {
  return (
    <FormField>
      {label}
      <Textarea rows={2} maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} className="resize-y" />
    </FormField>
  );
}
