// Employee processes and exit (FR-015, FR-016, FR-018; FR-051 as built; F1 "Exit and employee processes"; DF02; DF03;
// DF08; C4; ZT07; H3 own-record context), jsdom. Process templates: the list, a new template with the exact body, the
// draft revision edited as ordered tasks with explicit required or optional flags and one owner each, saved against its
// version (unsaved tasks kept after a version conflict) and published, renaming and (de)activation against the template
// version. Employee processes: the employee search, starting a published template for an employee in scope, the task
// list with owner, due date, state and completion (actor and date) as text, completion with evidence that waits for the
// malware scan, downloads of released evidence only, skipping optional tasks, reassignment with history, reasoned
// reopening, closing only once every required task is complete (as the API decides it), cancelling, and restricted
// remarks and HR notes only when the server returned them. Exit: the list and its state filter, the exit case with the
// contractual notice period as recorded, NOTICE and separation in the history, the clearance checklist and the final
// release; the decision queues (manager recommendation, HR decision, withdrawal decision) with one idempotency key per
// decision; the employee's own resignation, withdrawal before approval and the withdrawal request after it, in the
// Employee OWN context. Controls are hidden without their permission keys, refusals are said in plain words, buttons
// are disabled while their request is in flight, and nothing cached for one role assignment is shown under another.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComponentType } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIFECYCLE_PROCESSES_ESS_PANELS, LIFECYCLE_PROCESSES_SCREENS, LIFECYCLE_PROCESSES_TASK_QUEUES } from './lifecycle-processes';

// The selected company and role assignment and the signed-in user, as the session holds them; each test selects the
// context it needs (an HR Administrator, a reporting manager, or the employee in their Employee OWN context).
const session = vi.hoisted(() => ({
  /** False until GET /v1/me/context and /v1/me/permissions have answered: no role context and no permissions yet. */
  loaded: true,
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
  employeeId: null as string | null,
  roleCode: 'HR_ADMINISTRATOR',
  scopeKind: 'COMPANY',
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: session.loaded
      ? {
          userId: session.userId,
          accountKey: 'syn.user',
          companyName: 'Synthetic Co',
          roleCode: session.roleCode,
          roleName: session.roleCode,
          scopeKind: session.scopeKind,
          employeeId: session.employeeId,
          displayName: 'Synthetic User',
        }
      : null,
    can: (permission: string) => session.loaded && session.permissions.includes(permission),
  }),
}));

// Permission keys (modules/lifecycle/registration.ts, migration 0038_lifecycle.sql, the routes' requireAccess calls).
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
const EMPLOYEE_LIST = 'employee.list.operational';
const EMPLOYEE_READ = 'employee.read.operational';

const ASSIGNMENT_A = 'a0000000-0000-4000-8000-000000000001';
const ASSIGNMENT_B = 'a0000000-0000-4000-8000-000000000002';
const ASSIGNMENT_OWN = 'a0000000-0000-4000-8000-000000000003';
/** The signed-in HR Administrator, another HR user, Asha's own user, Asha's manager and the separation job. */
const U_ME = 'b0000000-0000-4000-8000-000000000001';
const U_RAVI = 'b0000000-0000-4000-8000-000000000002';
const U_ASHA = 'b0000000-0000-4000-8000-000000000003';
const U_MANAGER = 'b0000000-0000-4000-8000-000000000004';
const U_SYSTEM = 'b0000000-0000-4000-8000-000000000099';
const E_ASHA = '20000000-0000-4000-8000-000000000001';
const E_MEERA = '20000000-0000-4000-8000-000000000003';
const E_MANAGER = '20000000-0000-4000-8000-000000000004';
/** The signed-in HR Administrator's own employee record. */
const E_ME = '20000000-0000-4000-8000-000000000009';
const T_ONB = '10000000-0000-4000-8000-000000000001';
const T_EXIT = '10000000-0000-4000-8000-000000000002';
const T_OLD = '10000000-0000-4000-8000-000000000003';
const T_TRANSFER = '10000000-0000-4000-8000-000000000004';
const T_NEW = '10000000-0000-4000-8000-000000000005';
const P_ONB = '30000000-0000-4000-8000-000000000001';
const P_CLEAR = '30000000-0000-4000-8000-000000000002';
const P_NEW = '30000000-0000-4000-8000-000000000003';
const K_DOCS = '31000000-0000-4000-8000-000000000001';
const K_INTRO = '31000000-0000-4000-8000-000000000002';
const K_LUNCH = '31000000-0000-4000-8000-000000000003';
const K_ACK = '31000000-0000-4000-8000-000000000004';
const K_BUDDY = '31000000-0000-4000-8000-000000000005';
const X_ASHA = '40000000-0000-4000-8000-000000000001';
const X_OLD = '40000000-0000-4000-8000-000000000002';
const X_MEERA = '40000000-0000-4000-8000-000000000003';
const W_ASHA = '41000000-0000-4000-8000-000000000001';
const TK_RECOMMEND = '50000000-0000-4000-8000-000000000001';
const TK_APPROVE = '50000000-0000-4000-8000-000000000002';
const TK_WITHDRAWAL = '50000000-0000-4000-8000-000000000003';
const N_FIRST = '60000000-0000-4000-8000-000000000001';
const N_FIX = '60000000-0000-4000-8000-000000000002';
const N_WARN = '60000000-0000-4000-8000-000000000003';
const TX_EXIT = 'e0000000-0000-4000-8000-000000000001';

// ---------------------------------------------------------------------------------------------------------
// Contexts
// ---------------------------------------------------------------------------------------------------------
interface Context {
  permissions: string[];
  roleCode: string;
  scopeKind: string;
  userId: string;
  employeeId: string | null;
  assignmentId: string;
  /** False while the session is still loading the role context (default true). */
  loaded?: boolean;
}
/** An HR Administrator with company scope; their own employee record is E_ME. */
const hr = (permissions: string[], patch: Partial<Context> = {}): Context => ({
  permissions,
  roleCode: 'HR_ADMINISTRATOR',
  scopeKind: 'COMPANY',
  userId: U_ME,
  employeeId: E_ME,
  assignmentId: ASSIGNMENT_A,
  ...patch,
});
/** Asha's reporting manager, in team scope. */
const manager = (permissions: string[]): Context => ({ permissions, roleCode: 'REPORTING_MANAGER', scopeKind: 'TEAM', userId: U_MANAGER, employeeId: E_MANAGER, assignmentId: ASSIGNMENT_B });
/** Asha in her Employee OWN context (H3). */
const asha = (permissions: string[]): Context => ({ permissions, roleCode: 'EMPLOYEE', scopeKind: 'OWN', userId: U_ASHA, employeeId: E_ASHA, assignmentId: ASSIGNMENT_OWN });

function use(ctx: Context) {
  session.loaded = ctx.loaded ?? true;
  session.permissions = ctx.permissions;
  session.roleCode = ctx.roleCode;
  session.scopeKind = ctx.scopeKind;
  session.userId = ctx.userId;
  session.employeeId = ctx.employeeId;
  session.assignmentId = ctx.assignmentId;
}

// ---------------------------------------------------------------------------------------------------------
// The API stub: "METHOD /path" routes with fixed replies or handlers; every request is recorded
// ---------------------------------------------------------------------------------------------------------
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}
type Reply = [status: number, body: unknown];
type Handler = Reply | ((call: Call) => Reply | Promise<Reply>);

let calls: Call[] = [];
/** Answers held back until the test releases them, by "METHOD /path". */
let holds = new Map<string, Promise<void>>();
/** Answers lost on the way back, by "METHOD /path": the server acted on the request, but the page never hears back. */
let lost = new Set<string>();
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodiesTo = (method: string, path: string) => callsTo(method, path).map((c) => c.body);

/** Holds every answer to "METHOD /path" until the returned function is called, to act while a request is in flight. */
function hold(key: string): () => void {
  let release = () => {};
  holds.set(
    key,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return () => {
    holds.delete(key);
    release();
  };
}
const loseAnswer = (key: string) => lost.add(key);

function mockApi(routes: Record<string, Handler>) {
  calls = [];
  holds = new Map();
  lost = new Set();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const held = holds.get(key);
      if (held) await held;
      const route = routes[key];
      const [status, body]: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${key}` }] : typeof route === 'function' ? await route(call) : route;
      if (lost.delete(key)) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const STALE = { error: 'STALE_VERSION', message: 'The record changed; reload and retry' };

// ---------------------------------------------------------------------------------------------------------
// Rendering and queries
// ---------------------------------------------------------------------------------------------------------
const testClient = (staleTime = 0) => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime }, mutations: { retry: false } } });

/** Renders the module's screens at a path, routed as the app routes them (so links and route params work). */
function renderAt(entry: string, ctx: Context, client = testClient()) {
  use(ctx);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {LIFECYCLE_PROCESSES_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Renders one exported decision queue or My ESS panel on its own, as the inbox or the ESS hub would. */
function renderPart(Part: ComponentType, ctx: Context) {
  use(ctx);
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter>
        <Part />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const queueNamed = (title: string) => LIFECYCLE_PROCESSES_TASK_QUEUES.find((q) => q.title === title)!.component;
const panelFor = (tabId: string) => LIFECYCLE_PROCESSES_ESS_PANELS.find((p) => p.tabId === tabId)!.component;

const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent?.trim());
const rowWith = (table: HTMLElement, text: string) => within(table).getByText(text).closest('tr') as HTMLElement;
const headers = (table: HTMLElement) => within(table).getAllByRole('columnheader').map((h) => h.textContent);
const bodyRows = (table: HTMLElement) => within(table).getAllByRole('row').slice(1);
const findSection = async (heading: string) => (await screen.findByRole('heading', { name: heading })).closest('section') as HTMLElement;
const valueIn = (scope: HTMLElement, term: string) => within(scope).getByText(term, { selector: 'dt' }).nextElementSibling!.textContent;
const hasTerm = (scope: HTMLElement, term: string) => within(scope).queryByText(term, { selector: 'dt' }) !== null;
const button = (scope: HTMLElement, name: string) => within(scope).getByRole('button', { name }) as HTMLButtonElement;
const input = (scope: HTMLElement, label: string) => within(scope).getByLabelText(label) as HTMLInputElement;
const type = (scope: HTMLElement, label: string, value: string) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const taskItem = (name: string) => screen.findByRole('listitem', { name });

/** Lets any request a click might have started reach the stub before asserting that none was made. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

/** An instant as the page shows it: the viewer's local date and time. */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const localDay = (iso: string) => localTime(iso).replace(/ \d{2}:\d{2}$/, '');

const KEY = /^[a-z-]+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------------------
// Fixtures: templates
// ---------------------------------------------------------------------------------------------------------
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
interface Revision {
  revision: number;
  state: string;
  publishedAt: string | null;
  version: number;
  tasks: TemplateTask[];
}
interface Template {
  id: string;
  code: string;
  name: string;
  processType: string;
  active: boolean;
  version: number;
  revisions: Revision[];
}
type TaskInput = { code: string; title: string; ownerRoleCode?: string; ownerUserId?: string; required: boolean; dueOffsetDays: number; evidenceRequired: boolean };

const tt = (sequence: number, code: string, title: string, patch: Partial<TemplateTask> = {}): TemplateTask => ({
  sequence,
  code,
  title,
  ownerRoleCode: 'HR_ADMINISTRATOR',
  ownerUserId: null,
  required: true,
  dueOffsetDays: 0,
  evidenceRequired: false,
  ...patch,
});
const revisionOneTasks = (): TemplateTask[] => [
  tt(1, 'DOCS', 'Collect joining documents', { evidenceRequired: true }),
  tt(2, 'INTRO', 'Team introduction', { ownerRoleCode: 'REPORTING_MANAGER', dueOffsetDays: 3 }),
  tt(3, 'LUNCH', 'Welcome lunch', { ownerRoleCode: 'REPORTING_MANAGER', required: false, dueOffsetDays: 5 }),
];
const PUBLISHED_AT = '2026-10-01T10:00:00.000Z';
const REPUBLISHED_AT = '2026-10-26T11:00:00.000Z';

/** Standard onboarding: revision 1 published; by default a draft revision 2 (version 5) with the same tasks. */
function onboarding(draft: Revision | null = { revision: 2, state: 'DRAFT', publishedAt: null, version: 5, tasks: revisionOneTasks() }): Template {
  return {
    id: T_ONB,
    code: 'ONBOARD_STD',
    name: 'Standard onboarding',
    processType: 'ONBOARDING',
    active: true,
    version: 3,
    revisions: [{ revision: 1, state: 'PUBLISHED', publishedAt: PUBLISHED_AT, version: 2, tasks: revisionOneTasks() }, ...(draft ? [draft] : [])],
  };
}

/** The template list (GET /v1/lifecycle-processes), ordered by code as the API orders it. */
const SUMMARIES = [
  { id: T_EXIT, code: 'EXIT_STD', name: 'Exit clearance', processType: 'EXIT', active: true, version: 1, publishedRevision: 1, draftRevision: null },
  { id: T_OLD, code: 'OLD_ONBOARD', name: 'Old onboarding', processType: 'ONBOARDING', active: false, version: 4, publishedRevision: 2, draftRevision: null },
  { id: T_ONB, code: 'ONBOARD_STD', name: 'Standard onboarding', processType: 'ONBOARDING', active: true, version: 3, publishedRevision: 1, draftRevision: 2 },
  { id: T_TRANSFER, code: 'TRANSFER_STD', name: 'Transfer checklist', processType: 'TRANSFER', active: true, version: 1, publishedRevision: null, draftRevision: 1 },
];

// ---------------------------------------------------------------------------------------------------------
// Fixtures: employee processes
// ---------------------------------------------------------------------------------------------------------
interface ProcessTask {
  id: string;
  sequence: number;
  code: string;
  title: string;
  ownerRoleCode: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  required: boolean;
  evidenceRequired: boolean;
  dueDate: string;
  state: string;
  overdue: boolean;
  doneAt: string | null;
  doneOn: string | null;
  doneBy: string | null;
  hasEvidence: boolean;
  evidenceScanState: string | null;
  version: number;
}
interface ProcessEvent {
  action: string;
  taskCode: string | null;
  fromState: string | null;
  toState: string | null;
  priorOwner: { roleCode: string | null; userId: string | null } | null;
  newOwner: { roleCode: string | null; userId: string | null } | null;
  hasEvidence: boolean;
  note?: string | null;
  noteRecorded?: boolean;
  actorUserId: string;
  businessDate: string;
  occurredAt: string;
}

const pt = (id: string, sequence: number, code: string, title: string, patch: Partial<ProcessTask> = {}): ProcessTask => ({
  id,
  sequence,
  code,
  title,
  ownerRoleCode: 'HR_ADMINISTRATOR',
  ownerUserId: null,
  ownerName: null,
  required: true,
  evidenceRequired: false,
  dueDate: '2026-11-02',
  state: 'OPEN',
  overdue: false,
  doneAt: null,
  doneOn: null,
  doneBy: null,
  hasEvidence: false,
  evidenceScanState: null,
  version: 1,
  ...patch,
});
const BUDDY_DONE_AT = '2026-10-25T08:30:00.000Z';
const docsTask = () => pt(K_DOCS, 1, 'DOCS', 'Collect joining documents', { evidenceRequired: true });
const introTask = () => pt(K_INTRO, 2, 'INTRO', 'Team introduction', { ownerRoleCode: 'REPORTING_MANAGER', dueDate: '2026-10-20', overdue: true });
const lunchTask = () => pt(K_LUNCH, 3, 'LUNCH', 'Welcome lunch', { ownerRoleCode: 'REPORTING_MANAGER', required: false, dueDate: '2026-11-07' });
const ackTask = () => pt(K_ACK, 4, 'ACK', 'Acknowledge the handbook', { ownerRoleCode: 'EMPLOYEE', dueDate: '2026-11-03' });
const buddyTask = () =>
  pt(K_BUDDY, 5, 'BUDDY', 'Buddy check-in', {
    ownerRoleCode: null,
    ownerUserId: U_RAVI,
    ownerName: 'Ravi Synthetic',
    required: false,
    dueDate: '2026-11-04',
    state: 'COMPLETED',
    doneAt: BUDDY_DONE_AT,
    doneOn: '2026-10-25',
    doneBy: U_RAVI,
    version: 3,
  });
const onboardingTasks = (): ProcessTask[] => [docsTask(), introTask(), lunchTask(), ackTask(), buddyTask()];
const done = (t: ProcessTask, patch: Partial<ProcessTask> = {}): ProcessTask => ({ ...t, state: 'COMPLETED', overdue: false, doneAt: '2026-10-26T10:00:00.000Z', doneOn: '2026-10-26', doneBy: U_ME, version: t.version + 1, ...patch });
/** Every required task completed; DOCS with evidence in the given scan state; the optional lunch still open. */
const requiredDone = (scan: string): ProcessTask[] => [done(docsTask(), { hasEvidence: true, evidenceScanState: scan }), done(introTask()), lunchTask(), done(ackTask()), buddyTask()];

const ev = (action: string, patch: Partial<ProcessEvent> = {}): ProcessEvent => ({
  action,
  taskCode: null,
  fromState: null,
  toState: null,
  priorOwner: null,
  newOwner: null,
  hasEvidence: false,
  actorUserId: U_ME,
  businessDate: '2026-10-20',
  occurredAt: '2026-10-20T09:00:00.000Z',
  ...patch,
});
const REASSIGN_REASON = 'Ravi mentors new joiners (synthetic)';
const COMPLETE_REMARK = 'Buddy agreed to weekly calls (synthetic)';
/** The history as the API returns it: remarks only to an HR caller holding the notes grant, otherwise whether one exists. */
function historyOf(withNotes: boolean): ProcessEvent[] {
  const note = (text: string | null) => (withNotes ? { note: text } : { noteRecorded: text !== null });
  return [
    ev('START', { toState: 'OPEN', ...note(null) }),
    ev('REASSIGN', {
      taskCode: 'BUDDY',
      priorOwner: { roleCode: 'HR_ADMINISTRATOR', userId: null },
      newOwner: { roleCode: null, userId: U_RAVI },
      businessDate: '2026-10-21',
      occurredAt: '2026-10-21T09:00:00.000Z',
      ...note(REASSIGN_REASON),
    }),
    ev('COMPLETE', { taskCode: 'BUDDY', fromState: 'OPEN', toState: 'COMPLETED', actorUserId: U_RAVI, businessDate: '2026-10-25', occurredAt: BUDDY_DONE_AT, ...note(COMPLETE_REMARK) }),
  ];
}

const CREATED_AT = '2026-10-20T09:00:00.000Z';
/** An employee process as GET /v1/employee-processes/:id returns it, its counts derived from its tasks. */
function processOf(tasks: ProcessTask[], patch: Record<string, unknown> = {}, history: ProcessEvent[] = historyOf(false)) {
  const open = tasks.filter((t) => t.state === 'OPEN');
  return {
    id: P_ONB,
    employeeId: E_ASHA,
    employeeCode: 'SYN-101',
    employeeName: 'Asha Synthetic',
    processId: T_ONB,
    processCode: 'ONBOARD_STD',
    processName: 'Standard onboarding',
    processType: 'ONBOARDING',
    revision: 1,
    state: 'OPEN',
    effectiveDate: '2026-11-02',
    ownerUserId: U_ME,
    exitCaseId: null,
    closedAt: null,
    cancelledAt: null,
    reopenCount: 0,
    createdAt: CREATED_AT,
    version: 4,
    counts: { total: tasks.length, open: open.length, requiredOpen: open.filter((t) => t.required).length, overdue: tasks.filter((t) => t.overdue).length },
    tasks,
    history,
    ...patch,
  };
}
const ONBOARDING_SUMMARY = {
  id: P_ONB,
  processCode: 'ONBOARD_STD',
  processName: 'Standard onboarding',
  processType: 'ONBOARDING',
  revision: 1,
  state: 'OPEN',
  effectiveDate: '2026-11-02',
  exitCaseId: null,
  version: 4,
  taskCount: 5,
  openTasks: 4,
  requiredOpen: 3,
  overdueTasks: 1,
};
const ASHA_HIT = { id: E_ASHA, employeeCode: 'SYN-101', displayName: 'Asha Synthetic', status: 'ACTIVE_CONFIRMED' };

// ---------------------------------------------------------------------------------------------------------
// Fixtures: exit
// ---------------------------------------------------------------------------------------------------------
interface ExitCase {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  state: string;
  separationType: string;
  requestDate: string;
  proposedLastWorkingDate: string;
  recommendedLastWorkingDate: string | null;
  approvedLastWorkingDate: string | null;
  lastWorkingDate: string;
  noticePeriod: { status: 'NOT_RECORDED' } | { status: 'RECORDED'; contractualNoticeDays: number };
  reasonCode?: string | null;
  reason?: string | null;
  employeeMessage: string | null;
  released: boolean;
  releasedAt: string | null;
  submittedAt: string;
  version: number;
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
interface Withdrawal {
  id: string;
  state: string;
  reason?: string;
  employeeMessage: string | null;
  requestedAt: string;
  decidedAt: string | null;
}
interface Clearance {
  started: boolean;
  complete: boolean;
  processIds: string[];
  incompleteRequired: string[];
}
interface ExitDetail extends ExitCase {
  clearance: Clearance;
  withdrawals: Withdrawal[];
  decisions: { transactionId: string; step: number; action: string; decision: string; decidedAt: string }[];
  history: ExitEvent[];
}

const OWN_REASON = 'Moving closer to family (synthetic)';
/** Asha's resignation, as a caller without the exit reason group sees it (no reason fields at all). */
const exitCase = (patch: Partial<ExitCase> = {}): ExitCase => ({
  id: X_ASHA,
  employeeId: E_ASHA,
  employeeCode: 'SYN-101',
  employeeName: 'Asha Synthetic',
  state: 'SUBMITTED',
  separationType: 'RESIGNATION',
  requestDate: '2026-10-20',
  proposedLastWorkingDate: '2026-12-31',
  recommendedLastWorkingDate: null,
  approvedLastWorkingDate: null,
  lastWorkingDate: '2026-12-31',
  noticePeriod: { status: 'NOT_RECORDED' },
  employeeMessage: null,
  released: false,
  releasedAt: null,
  submittedAt: '2026-10-20T06:00:00.000Z',
  version: 1,
  ...patch,
});
const recommendedExit = (patch: Partial<ExitCase> = {}) => exitCase({ state: 'RECOMMENDED', recommendedLastWorkingDate: '2026-12-15', lastWorkingDate: '2026-12-15', version: 2, ...patch });
const approvedExit = (patch: Partial<ExitCase> = {}) =>
  exitCase({ state: 'APPROVED', recommendedLastWorkingDate: '2026-12-15', approvedLastWorkingDate: '2026-12-20', lastWorkingDate: '2026-12-20', version: 3, ...patch });

const xev = (action: string, fromState: string, toState: string, patch: Partial<ExitEvent> = {}): ExitEvent => ({
  action,
  fromState,
  toState,
  lastWorkingDate: null,
  employeeStatusBefore: null,
  employeeStatusAfter: null,
  actorUserId: U_ASHA,
  businessDate: '2026-10-20',
  occurredAt: '2026-10-20T06:00:00.000Z',
  ...patch,
});
const SUBMITTED_EVENT = xev('SUBMIT', 'NONE', 'SUBMITTED', { lastWorkingDate: '2026-12-31' });
const RECOMMENDED_EVENT = xev('RECOMMEND', 'SUBMITTED', 'RECOMMENDED', { lastWorkingDate: '2026-12-15', actorUserId: U_MANAGER, businessDate: '2026-10-21', occurredAt: '2026-10-21T06:00:00.000Z' });
const APPROVED_EVENT = xev('APPROVE', 'RECOMMENDED', 'APPROVED', {
  lastWorkingDate: '2026-12-20',
  employeeStatusBefore: 'ACTIVE_CONFIRMED',
  employeeStatusAfter: 'NOTICE',
  actorUserId: U_RAVI,
  businessDate: '2026-10-22',
  occurredAt: '2026-10-22T06:00:00.000Z',
});
const SEPARATED_EVENT = xev('SEPARATE', 'APPROVED', 'SEPARATED', {
  lastWorkingDate: '2026-12-20',
  employeeStatusBefore: 'NOTICE',
  employeeStatusAfter: 'INACTIVE_SEPARATED',
  actorUserId: U_SYSTEM,
  businessDate: '2026-12-21',
  occurredAt: '2026-12-21T00:05:00.000Z',
});
const DECISIONS = [
  { transactionId: TX_EXIT, step: 1, action: 'recommend', decision: 'APPROVE', decidedAt: '2026-10-21T06:00:00.000Z' },
  { transactionId: TX_EXIT, step: 2, action: 'approve', decision: 'APPROVE', decidedAt: '2026-10-22T06:00:00.000Z' },
];
const NO_CLEARANCE: Clearance = { started: false, complete: false, processIds: [], incompleteRequired: [] };
const detailOf = (x: ExitCase, patch: Partial<ExitDetail> = {}): ExitDetail => ({ ...x, clearance: NO_CLEARANCE, withdrawals: [], decisions: [], history: [SUBMITTED_EVENT], ...patch });
const approvedDetail = (patch: Partial<ExitDetail> = {}, x: ExitCase = approvedExit()) =>
  detailOf(x, { decisions: DECISIONS, history: [SUBMITTED_EVENT, RECOMMENDED_EVENT, APPROVED_EVENT], ...patch });
const REQUESTED_AT = '2026-10-26T07:15:00.000Z';

/** The exit tasks of GET /v1/exit-cases/tasks/mine. */
const recommendTask = (x: ExitCase = exitCase()) => ({ taskId: TK_RECOMMEND, kind: 'exit_case', step: 'recommend', exitCase: x });
const approveTask = (x: ExitCase = recommendedExit()) => ({ taskId: TK_APPROVE, kind: 'exit_case', step: 'approve', exitCase: x });
const withdrawalTask = (x: ExitCase = approvedExit()) => ({ taskId: TK_WITHDRAWAL, kind: 'exit_withdrawal', step: 'approve', exitCase: x });

// =========================================================================================================
describe('exports for the navigation step', () => {
  it('offers the screens, the own-record panels and the decision queues', () => {
    expect(LIFECYCLE_PROCESSES_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([
      ['/lifecycle/process-templates', 'Process templates', TEMPLATE_READ, true],
      ['/lifecycle/process-templates/:id', 'Process template', TEMPLATE_READ, false],
      ['/lifecycle/processes', 'Employee processes', PROCESS_READ, true],
      ['/lifecycle/processes/:id', 'Employee process', PROCESS_READ, false],
      ['/lifecycle/employees/:id', 'Employee processes and exit', PROCESS_READ, false],
      ['/lifecycle/exits', 'Exit cases', EXIT_READ, true],
      ['/lifecycle/exits/:id', 'Exit case', EXIT_READ, false],
      // CL-040 (0260): the notes register and its bulk upload (lifecycle-notes.test.tsx).
      ['/lifecycle/notes', 'Exit notes, remarks and warnings', NOTE_READ, true],
      ['/lifecycle/notes/upload', 'Notes bulk upload', 'employee_note.import.restricted', true],
      // CL-052 (0283): the absconding audit report (absconding-audit.test.tsx).
      ['/lifecycle/absconding-audit', 'Absconding audit', 'employee_note.export.restricted', true],
      ['/me/resignation', 'My resignation', EXIT_SUBMIT, true],
      ['/me/processes', 'My processes', PROCESS_READ, false],
    ]);
    expect(LIFECYCLE_PROCESSES_SCREENS.every((s) => typeof s.component === 'function')).toBe(true);
    // No H3 tab (TN01–TN18) covers them: the panels use the module's own /v1/me routes under ids of their own.
    expect(LIFECYCLE_PROCESSES_ESS_PANELS.map((p) => p.tabId)).toEqual(['RESIGNATION', 'MY_PROCESSES']);
    expect(LIFECYCLE_PROCESSES_ESS_PANELS.every((p) => typeof p.component === 'function')).toBe(true);
    expect(LIFECYCLE_PROCESSES_TASK_QUEUES.map((q) => [q.permission, q.title])).toEqual([
      [EXIT_RECOMMEND, 'Resignation recommendations'],
      [EXIT_APPROVE, 'Resignation approvals'],
      [EXIT_APPROVE, 'Resignation withdrawal requests'],
      [TASK_COMPLETE, 'My process tasks'],
    ]);
    expect(LIFECYCLE_PROCESSES_TASK_QUEUES.every((q) => typeof q.component === 'function')).toBe(true);
  });
});

// =========================================================================================================
describe('process templates (FR-015)', () => {
  it('lists the templates with their type, status and revisions; creating one needs the manage duty', async () => {
    mockApi({ 'GET /v1/lifecycle-processes': [200, { items: SUMMARIES }] });
    renderAt('/lifecycle/process-templates', hr([TEMPLATE_READ]));
    const table = await screen.findByRole('table', { name: 'Process templates' });
    expect(headers(table)).toEqual(['Code', 'Name', 'Type', 'Status', 'Published revision', 'Draft revision']);
    expect(cells(rowWith(table, 'ONBOARD_STD'))).toEqual(['ONBOARD_STD', 'Standard onboarding', 'Onboarding', 'Active', 'Revision 1', 'Revision 2']);
    expect(cells(rowWith(table, 'EXIT_STD'))).toEqual(['EXIT_STD', 'Exit clearance', 'Exit clearance', 'Active', 'Revision 1', '—']);
    expect(cells(rowWith(table, 'OLD_ONBOARD'))).toEqual(['OLD_ONBOARD', 'Old onboarding', 'Onboarding', 'Inactive', 'Revision 2', '—']);
    expect(cells(rowWith(table, 'TRANSFER_STD'))).toEqual(['TRANSFER_STD', 'Transfer checklist', 'Transfer', 'Active', 'None yet', 'Revision 1']);
    expect(screen.getByRole('heading', { name: 'Templates (4)' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'ONBOARD_STD' }).getAttribute('href')).toBe(`/lifecycle/process-templates/${T_ONB}`);
    expect(screen.queryByRole('form', { name: 'New process template' })).toBeNull();
  });

  it('is not offered, and nothing is requested, without the read duty', async () => {
    mockApi({});
    renderAt('/lifecycle/process-templates', hr([]));
    expect(await screen.findByText('The selected role cannot view process templates.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New process template' })).toBeNull();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('creates a template with the exact body and opens its empty draft revision', async () => {
    const created: Template = {
      id: T_NEW,
      code: 'PROBATION_CHECK',
      name: 'Probation check',
      processType: 'PROBATION_CONFIRMATION',
      active: true,
      version: 1,
      revisions: [{ revision: 1, state: 'DRAFT', publishedAt: null, version: 1, tasks: [] }],
    };
    mockApi({
      'GET /v1/lifecycle-processes': [200, { items: SUMMARIES }],
      'POST /v1/lifecycle-processes': [201, created],
      [`GET /v1/lifecycle-processes/${T_NEW}`]: [200, created],
    });
    renderAt('/lifecycle/process-templates', hr([TEMPLATE_READ, TEMPLATE_MANAGE]));
    const form = await screen.findByRole('form', { name: 'New process template' });
    type(form, 'Template code', 'probation_check');
    type(form, 'Template name', '  Probation check ');
    type(form, 'Process type', 'probation_confirmation');
    expect(input(form, 'Template code').value).toBe('PROBATION_CHECK');
    fireEvent.click(button(form, 'Create template'));
    expect(await screen.findByRole('heading', { name: 'Probation check (PROBATION_CHECK)' })).toBeTruthy();
    expect(bodiesTo('POST', '/v1/lifecycle-processes')).toEqual([{ code: 'PROBATION_CHECK', name: 'Probation check', processType: 'PROBATION_CONFIRMATION' }]);
    expect(valueIn(document.body, 'Published revision')).toBe('None yet');
    expect(valueIn(document.body, 'Draft revision')).toBe('Revision 1');
    const editor = await screen.findByRole('form', { name: 'Tasks of draft revision 1' });
    expect(within(editor).getByText('No tasks yet. Add the first task.')).toBeTruthy();
    // An empty draft cannot be published.
    expect(button(editor, 'Publish revision 1').disabled).toBe(true);
  });

  it('checks the code before sending, says a refusal in plain words and keeps what was typed', async () => {
    mockApi({
      'GET /v1/lifecycle-processes': [200, { items: SUMMARIES }],
      'POST /v1/lifecycle-processes': [409, { error: 'TEMPLATE_CODE_EXISTS', message: 'A process template with this code exists' }],
    });
    renderAt('/lifecycle/process-templates', hr([TEMPLATE_READ, TEMPLATE_MANAGE]));
    const form = await screen.findByRole('form', { name: 'New process template' });
    type(form, 'Template code', '9LIVES');
    type(form, 'Template name', 'Synthetic onboarding');
    type(form, 'Process type', 'ONBOARDING');
    fireEvent.click(button(form, 'Create template'));
    expect(await within(form).findByText('Enter a code of capital letters, digits and underscores that starts with a letter (at most 40 characters).')).toBeTruthy();
    await settle();
    expect(callsTo('POST', '/v1/lifecycle-processes')).toHaveLength(0);
    type(form, 'Template code', 'ONBOARD_STD');
    fireEvent.click(button(form, 'Create template'));
    expect(await within(form).findByText('A process template with this code already exists. Choose another code.')).toBeTruthy();
    expect(input(form, 'Template code').value).toBe('ONBOARD_STD');
    expect(input(form, 'Template name').value).toBe('Synthetic onboarding');
    expect(input(form, 'Process type').value).toBe('ONBOARDING');
  });

  it('edits the draft as ordered tasks with explicit required or optional flags, saves it against its version and publishes it', async () => {
    const template = onboarding();
    const draftOf = () => template.revisions.find((r) => r.state === 'DRAFT')!;
    mockApi({
      [`GET /v1/lifecycle-processes/${T_ONB}`]: () => [200, template],
      [`PUT /v1/lifecycle-processes/${T_ONB}/draft`]: (c) => {
        const body = c.body as { tasks: TaskInput[]; expectedVersion?: number };
        const draft = draftOf();
        if (body.expectedVersion !== draft.version) return [409, STALE];
        draft.tasks = body.tasks.map((t, i) => ({ ownerRoleCode: t.ownerRoleCode ?? null, ownerUserId: t.ownerUserId ?? null, code: t.code, title: t.title, required: t.required, dueOffsetDays: t.dueOffsetDays, evidenceRequired: t.evidenceRequired, sequence: i + 1 }));
        draft.version += 1;
        return [200, template];
      },
      [`POST /v1/lifecycle-processes/${T_ONB}/publish`]: (c) => {
        const body = c.body as { revision: number; expectedVersion: number };
        const draft = template.revisions.find((r) => r.revision === body.revision)!;
        if (draft.version !== body.expectedVersion) return [409, STALE];
        for (const r of template.revisions) if (r.state === 'PUBLISHED') Object.assign(r, { state: 'RETIRED', version: r.version + 1 });
        Object.assign(draft, { state: 'PUBLISHED', publishedAt: REPUBLISHED_AT, version: draft.version + 1 });
        template.version += 1;
        return [200, template];
      },
    });
    renderAt(`/lifecycle/process-templates/${T_ONB}`, hr([TEMPLATE_READ, TEMPLATE_MANAGE]));
    const editor = await screen.findByRole('form', { name: 'Tasks of draft revision 2' });
    expect(within(editor).getAllByRole('group').map((g) => (within(g).getByLabelText('Code') as HTMLInputElement).value)).toEqual(['DOCS', 'INTRO', 'LUNCH']);
    // Nothing changed yet: the saved draft can be published, and there is nothing to save.
    expect(button(editor, 'Publish revision 2').disabled).toBe(false);
    expect(button(editor, 'Save draft').disabled).toBe(true);

    fireEvent.click(button(editor, 'Add a task'));
    const added = within(editor).getByRole('group', { name: 'Task 4' });
    type(added, 'Code', 'buddy');
    type(added, 'Title', 'Buddy check-in');
    type(added, 'Owner type', 'USER');
    type(added, 'Owner user ID', U_RAVI);
    type(added, 'Due (days from the effective date)', '7');
    // Unsaved changes are never published.
    expect(button(editor, 'Publish revision 2').disabled).toBe(true);
    expect(within(editor).getByText('Save the draft before publishing it.')).toBeTruthy();
    // F1: required or optional is an explicit choice.
    fireEvent.click(button(editor, 'Save draft'));
    expect(await within(editor).findByText('Task 4: choose whether the task is required or optional.')).toBeTruthy();
    await settle();
    expect(callsTo('PUT', `/v1/lifecycle-processes/${T_ONB}/draft`)).toHaveLength(0);
    type(added, 'Required or optional', 'OPTIONAL');
    // The order is the task order: the buddy check-in moves before the lunch.
    fireEvent.click(button(added, 'Move up'));
    expect(input(within(editor).getByRole('group', { name: 'Task 3' }), 'Code').value).toBe('BUDDY');
    fireEvent.click(button(editor, 'Save draft'));
    expect(await screen.findByText('Saved draft revision 2.')).toBeTruthy();
    expect(bodiesTo('PUT', `/v1/lifecycle-processes/${T_ONB}/draft`)).toEqual([
      {
        tasks: [
          { code: 'DOCS', title: 'Collect joining documents', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: true },
          { code: 'INTRO', title: 'Team introduction', ownerRoleCode: 'REPORTING_MANAGER', required: true, dueOffsetDays: 3, evidenceRequired: false },
          { code: 'BUDDY', title: 'Buddy check-in', ownerUserId: U_RAVI, required: false, dueOffsetDays: 7, evidenceRequired: false },
          { code: 'LUNCH', title: 'Welcome lunch', ownerRoleCode: 'REPORTING_MANAGER', required: false, dueOffsetDays: 5, evidenceRequired: false },
        ],
        expectedVersion: 5,
      },
    ]);
    // Once the saved draft is back, it is published against its new version.
    await waitFor(() => expect(button(editor, 'Publish revision 2').disabled).toBe(false));
    expect(within(editor).getByText('Publishing freezes this revision and retires the one published before; new processes copy its tasks.')).toBeTruthy();
    fireEvent.click(button(editor, 'Publish revision 2'));
    expect(await screen.findByText('Published revision 2. New processes copy its tasks; running processes keep theirs.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/lifecycle-processes/${T_ONB}/publish`)).toEqual([{ revision: 2, expectedVersion: 6 }]);
    expect(await screen.findByRole('button', { name: 'Start draft revision 3' })).toBeTruthy();
    expect(valueIn(document.body, 'Published revision')).toBe(`Revision 2, published ${localDay(REPUBLISHED_AT)}`);
    const retired = await findSection('Revision 1');
    expect(within(retired).getByText('retired')).toBeTruthy();
    expect(bodyRows(within(await findSection('Revision 2')).getByRole('table')).map((r) => cells(r)[1])).toEqual(['DOCS', 'INTRO', 'BUDDY', 'LUNCH']);
  });

  it('starts the next draft revision from the published tasks, without a version to match', async () => {
    const template = onboarding(null);
    mockApi({
      [`GET /v1/lifecycle-processes/${T_ONB}`]: () => [200, template],
      [`PUT /v1/lifecycle-processes/${T_ONB}/draft`]: (c) => {
        const body = c.body as { tasks: TaskInput[] };
        template.revisions.push({
          revision: 2,
          state: 'DRAFT',
          publishedAt: null,
          version: 1,
          tasks: body.tasks.map((t, i) => ({ ...tt(i + 1, t.code, t.title), ownerRoleCode: t.ownerRoleCode ?? null, ownerUserId: t.ownerUserId ?? null, required: t.required, dueOffsetDays: t.dueOffsetDays, evidenceRequired: t.evidenceRequired })),
        });
        template.version += 1;
        return [200, template];
      },
    });
    renderAt(`/lifecycle/process-templates/${T_ONB}`, hr([TEMPLATE_READ, TEMPLATE_MANAGE]));
    const next = await findSection('New revision');
    expect(within(next).getByText(/A published revision is frozen\./)).toBeTruthy();
    fireEvent.click(button(next, 'Start draft revision 2'));
    const editor = within(next).getByRole('form', { name: 'Tasks of draft revision 2' });
    expect(within(editor).getAllByRole('group').map((g) => input(g, 'Title').value)).toEqual(['Collect joining documents', 'Team introduction', 'Welcome lunch']);
    expect(within(editor).queryByRole('button', { name: /^Publish/ })).toBeNull();
    type(within(editor).getByRole('group', { name: 'Task 3' }), 'Due (days from the effective date)', '-2');
    fireEvent.click(button(editor, 'Save as draft revision 2'));
    expect(await screen.findByText('Started draft revision 2.')).toBeTruthy();
    expect(bodiesTo('PUT', `/v1/lifecycle-processes/${T_ONB}/draft`)).toEqual([
      {
        tasks: [
          { code: 'DOCS', title: 'Collect joining documents', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: true },
          { code: 'INTRO', title: 'Team introduction', ownerRoleCode: 'REPORTING_MANAGER', required: true, dueOffsetDays: 3, evidenceRequired: false },
          { code: 'LUNCH', title: 'Welcome lunch', ownerRoleCode: 'REPORTING_MANAGER', required: false, dueOffsetDays: -2, evidenceRequired: false },
        ],
      },
    ]);
    const saved = await screen.findByRole('form', { name: 'Tasks of draft revision 2' });
    expect((await findSection('Draft revision 2')).contains(saved)).toBe(true);
    expect(button(saved, 'Save draft').disabled).toBe(true);
    expect(button(saved, 'Publish revision 2').disabled).toBe(false);
    expect(screen.queryByRole('heading', { name: 'New revision' })).toBeNull();
  });

  it('keeps unsaved tasks after a version conflict and saves them against the reloaded version', async () => {
    const template = onboarding();
    const draftOf = () => template.revisions.find((r) => r.state === 'DRAFT')!;
    let attempts = 0;
    mockApi({
      [`GET /v1/lifecycle-processes/${T_ONB}`]: () => [200, template],
      [`PUT /v1/lifecycle-processes/${T_ONB}/draft`]: (c) => {
        attempts += 1;
        const body = c.body as { tasks: TaskInput[]; expectedVersion?: number };
        const draft = draftOf();
        if (attempts === 1) {
          // Another HR user saved the draft meanwhile.
          draft.tasks = draft.tasks.map((t) => (t.code === 'INTRO' ? { ...t, title: 'Team introduction call' } : t));
          draft.version = 6;
          return [409, STALE];
        }
        if (body.expectedVersion !== draft.version) return [409, STALE];
        draft.version += 1;
        return [200, template];
      },
    });
    renderAt(`/lifecycle/process-templates/${T_ONB}`, hr([TEMPLATE_READ, TEMPLATE_MANAGE]));
    const editor = await screen.findByRole('form', { name: 'Tasks of draft revision 2' });
    const first = within(editor).getByRole('group', { name: 'Task 1' });
    type(first, 'Title', 'Collect signed joining documents');
    fireEvent.click(button(editor, 'Save draft'));
    expect(
      await within(editor).findByText('The draft revision was changed elsewhere since it was loaded. Your changes are kept: save again to replace that version, or discard them to load it.'),
    ).toBeTruthy();
    await waitFor(() => expect(callsTo('GET', `/v1/lifecycle-processes/${T_ONB}`)).toHaveLength(2));
    expect(input(first, 'Title').value).toBe('Collect signed joining documents');
    expect(input(within(editor).getByRole('group', { name: 'Task 2' }), 'Title').value).toBe('Team introduction');
    fireEvent.click(button(editor, 'Save draft'));
    expect(await screen.findByText('Saved draft revision 2.')).toBeTruthy();
    const second = bodiesTo('PUT', `/v1/lifecycle-processes/${T_ONB}/draft`)[1] as { tasks: TaskInput[]; expectedVersion: number };
    expect(second.expectedVersion).toBe(6);
    expect(second.tasks.map((t) => t.title)).toEqual(['Collect signed joining documents', 'Team introduction', 'Welcome lunch']);
  });

  it('loads the version saved elsewhere when the unsaved changes are discarded', async () => {
    const template = onboarding();
    mockApi({
      [`GET /v1/lifecycle-processes/${T_ONB}`]: () => [200, template],
      [`PUT /v1/lifecycle-processes/${T_ONB}/draft`]: () => {
        const draft = template.revisions.find((r) => r.state === 'DRAFT')!;
        draft.tasks = draft.tasks.map((t) => (t.code === 'INTRO' ? { ...t, title: 'Team introduction call' } : t));
        draft.version = 6;
        return [409, STALE];
      },
    });
    renderAt(`/lifecycle/process-templates/${T_ONB}`, hr([TEMPLATE_READ, TEMPLATE_MANAGE]));
    const editor = await screen.findByRole('form', { name: 'Tasks of draft revision 2' });
    type(within(editor).getByRole('group', { name: 'Task 1' }), 'Title', 'Collect signed joining documents');
    fireEvent.click(button(editor, 'Save draft'));
    await waitFor(() => expect(callsTo('GET', `/v1/lifecycle-processes/${T_ONB}`)).toHaveLength(2));
    fireEvent.click(button(editor, 'Discard changes'));
    expect(input(within(editor).getByRole('group', { name: 'Task 1' }), 'Title').value).toBe('Collect joining documents');
    expect(input(within(editor).getByRole('group', { name: 'Task 2' }), 'Title').value).toBe('Team introduction call');
    expect(button(editor, 'Save draft').disabled).toBe(true);
    expect(within(editor).queryByRole('alert')).toBeNull();
  });

  it('renames, deactivates and activates the template against its version, keeping a typed name after a refusal', async () => {
    const template = onboarding();
    let renames = 0;
    mockApi({
      [`GET /v1/lifecycle-processes/${T_ONB}`]: () => [200, template],
      [`PATCH /v1/lifecycle-processes/${T_ONB}`]: (c) => {
        const body = c.body as { name?: string; active?: boolean; expectedVersion: number };
        if (body.name !== undefined && ++renames === 1) {
          template.version += 1;
          return [409, STALE];
        }
        if (body.expectedVersion !== template.version) return [409, STALE];
        if (body.name !== undefined) template.name = body.name;
        if (body.active !== undefined) template.active = body.active;
        template.version += 1;
        return [200, template];
      },
    });
    renderAt(`/lifecycle/process-templates/${T_ONB}`, hr([TEMPLATE_READ, TEMPLATE_MANAGE]));
    const settings = await screen.findByRole('form', { name: 'Template settings' });
    expect(input(settings, 'Template name').value).toBe('Standard onboarding');
    expect(button(settings, 'Rename').disabled).toBe(true);
    type(settings, 'Template name', 'Standard onboarding 2026');
    fireEvent.click(button(settings, 'Rename'));
    expect(await screen.findByText('The template changed since it was loaded. It has been reloaded: check it and try again.')).toBeTruthy();
    await waitFor(() => expect(callsTo('GET', `/v1/lifecycle-processes/${T_ONB}`)).toHaveLength(2));
    expect(input(settings, 'Template name').value).toBe('Standard onboarding 2026');
    fireEvent.click(button(settings, 'Rename'));
    expect(await screen.findByRole('heading', { name: 'Standard onboarding 2026 (ONBOARD_STD)' })).toBeTruthy();
    expect(screen.getByText('Renamed the template to Standard onboarding 2026.')).toBeTruthy();
    expect(input(settings, 'Template name').value).toBe('Standard onboarding 2026');

    fireEvent.click(button(settings, 'Deactivate template'));
    expect(await screen.findByText('Deactivated the template: no new process can start from it.')).toBeTruthy();
    await waitFor(() => expect(valueIn(document.body, 'Status')).toBe('Inactive: no new process can start from it'));
    fireEvent.click(button(settings, 'Activate template'));
    expect(await screen.findByText('Activated the template: new processes can start from it.')).toBeTruthy();
    expect(bodiesTo('PATCH', `/v1/lifecycle-processes/${T_ONB}`)).toEqual([
      { name: 'Standard onboarding 2026', expectedVersion: 3 },
      { name: 'Standard onboarding 2026', expectedVersion: 4 },
      { active: false, expectedVersion: 5 },
      { active: true, expectedVersion: 6 },
    ]);
  });

  it('shows a template read-only, with every revision, to a role that cannot manage templates', async () => {
    mockApi({ [`GET /v1/lifecycle-processes/${T_ONB}`]: [200, onboarding()] });
    renderAt(`/lifecycle/process-templates/${T_ONB}`, hr([TEMPLATE_READ]));
    const draft = await findSection('Draft revision 2');
    expect(within(draft).getByRole('table', { name: 'Tasks of revision 2' })).toBeTruthy();
    const published = within(await findSection('Revision 1')).getByRole('table', { name: 'Tasks of revision 1' });
    expect(headers(published)).toEqual(['Order', 'Code', 'Task', 'Owner', 'Required', 'Due', 'Evidence']);
    expect(bodyRows(published).map(cells)).toEqual([
      ['1', 'DOCS', 'Collect joining documents', 'HR Administrator (role)', 'Required', 'On the effective date', 'Required'],
      ['2', 'INTRO', 'Team introduction', 'Reporting manager (role)', 'Required', '3 days after the effective date', 'Not required'],
      ['3', 'LUNCH', 'Welcome lunch', 'Reporting manager (role)', 'Optional', '5 days after the effective date', 'Not required'],
    ]);
    expect(valueIn(document.body, 'Status')).toBe('Active: new processes can start from it');
    expect(valueIn(document.body, 'Published revision')).toBe(`Revision 1, published ${localDay(PUBLISHED_AT)}`);
    expect(screen.queryByRole('form', { name: 'Template settings' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Tasks of draft revision 2' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Publish/ })).toBeNull();
  });
});

// =========================================================================================================
describe('employee processes (FR-016)', () => {
  /** The employee lifecycle screen's reads, for an HR Administrator. */
  const employeeRoutes = (processes = [ONBOARDING_SUMMARY], exits: ExitCase[] = [approvedExit()]): Record<string, Handler> => ({
    'GET /v1/employees': (c) => [200, { items: (c.params.get('search') ?? '').includes('asha') ? [ASHA_HIT] : [], total: 1, page: 1, pageSize: 25 }],
    [`GET /v1/employees/${E_ASHA}`]: [200, ASHA_HIT],
    [`GET /v1/employees/${E_ASHA}/processes`]: () => [200, { items: processes }],
    [`GET /v1/employees/${E_ASHA}/exit-cases`]: () => [200, { items: exits }],
    'GET /v1/lifecycle-processes': [200, { items: SUMMARIES }],
  });
  const HR_START = [EMPLOYEE_LIST, EMPLOYEE_READ, PROCESS_READ, PROCESS_MANAGE, TEMPLATE_READ, EXIT_READ];

  it('finds an employee in scope and starts a published template for them with the exact body', async () => {
    const processes = [ONBOARDING_SUMMARY];
    mockApi({
      ...employeeRoutes(processes),
      [`POST /v1/employees/${E_ASHA}/processes`]: (c) => {
        processes.unshift({ ...ONBOARDING_SUMMARY, id: P_NEW, effectiveDate: '2026-11-09', taskCount: 3, openTasks: 3, requiredOpen: 2, overdueTasks: 0 });
        return [201, { ...processOf([docsTask(), introTask(), lunchTask()], { id: P_NEW, effectiveDate: (c.body as { effectiveDate: string }).effectiveDate }), history: [] }];
      },
    });
    renderAt('/lifecycle/processes', hr(HR_START));
    const search = await screen.findByRole('search', { name: 'Find an employee' });
    type(search, 'Name or employee code', ' asha ');
    fireEvent.click(button(search, 'Search'));
    const results = await screen.findByRole('table', { name: 'Matching employees' });
    expect(callsTo('GET', '/v1/employees')[0]!.params.toString()).toBe('search=asha&page=1&pageSize=25');
    expect(cells(rowWith(results, 'Asha Synthetic'))).toEqual(['Asha Synthetic', 'SYN-101', 'Active (confirmed)']);
    fireEvent.click(within(results).getByRole('link', { name: 'Asha Synthetic' }));

    expect(await screen.findByRole('heading', { name: 'Asha Synthetic (SYN-101): processes and exit' })).toBeTruthy();
    const processTable = await screen.findByRole('table', { name: 'Processes' });
    expect(headers(processTable)).toEqual(['Process', 'Type', 'Revision', 'State', 'Effective date', 'Open tasks', 'Required still open', 'Overdue']);
    expect(cells(rowWith(processTable, 'Standard onboarding (ONBOARD_STD)'))).toEqual(['Standard onboarding (ONBOARD_STD)', 'Onboarding', '1', 'open', '2 Nov 2026', '4 of 5', '3', '1 overdue']);
    const exits = screen.getByRole('table', { name: 'Exit cases of the employee' });
    expect(headers(exits)[0]).toBe('Resignation date');
    expect(within(exits).getByRole('link', { name: '20 Oct 2026' }).getAttribute('href')).toBe(`/lifecycle/exits/${X_ASHA}`);

    const start = screen.getByRole('form', { name: 'Start a process' });
    const template = within(start).getByLabelText('Process template') as HTMLSelectElement;
    // Only active templates with a published revision can start.
    await waitFor(() =>
      expect(Array.from(template.options).map((o) => o.textContent)).toEqual([
        'Choose a template…',
        'Exit clearance (EXIT_STD) · Exit clearance · revision 1',
        'Standard onboarding (ONBOARD_STD) · Onboarding · revision 1',
      ]),
    );
    fireEvent.change(template, { target: { value: 'ONBOARD_STD' } });
    expect(within(start).queryByLabelText('Exit case')).toBeNull();
    type(start, 'Effective date (leave empty for today)', '2026-11-09');
    fireEvent.click(button(start, 'Start process'));
    expect(await within(start).findByText('Started Standard onboarding (ONBOARD_STD) with 3 tasks.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employees/${E_ASHA}/processes`)).toEqual([{ processCode: 'ONBOARD_STD', effectiveDate: '2026-11-09' }]);
    expect(within(start).getByRole('link', { name: 'Open the process' }).getAttribute('href')).toBe(`/lifecycle/processes/${P_NEW}`);
    // The form starts afresh, and the list shows the new process.
    expect(template.value).toBe('');
    expect(input(start, 'Effective date (leave empty for today)').value).toBe('');
    await waitFor(() => expect(bodyRows(screen.getByRole('table', { name: 'Processes' }))).toHaveLength(2));
  });

  it('starts an exit clearance checklist only for an approved exit of the employee', async () => {
    mockApi({
      ...employeeRoutes(),
      [`POST /v1/employees/${E_ASHA}/processes`]: [409, { error: 'CLEARANCE_EXISTS', message: 'This exit already has a clearance checklist' }],
    });
    renderAt(`/lifecycle/employees/${E_ASHA}`, hr(HR_START));
    const start = await screen.findByRole('form', { name: 'Start a process' });
    const template = within(start).getByLabelText('Process template') as HTMLSelectElement;
    await waitFor(() => expect(template.options).toHaveLength(3));
    fireEvent.change(template, { target: { value: 'EXIT_STD' } });
    const exit = within(start).getByLabelText('Exit case') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(exit.options).map((o) => o.textContent)).toEqual(['Choose the exit…', 'Resigned 20 Oct 2026, last working date 20 Dec 2026 (approved)']));
    fireEvent.click(button(start, 'Start process'));
    expect(await within(start).findByText('Choose the approved exit this clearance checklist belongs to.')).toBeTruthy();
    await settle();
    expect(callsTo('POST', `/v1/employees/${E_ASHA}/processes`)).toHaveLength(0);
    fireEvent.change(exit, { target: { value: X_ASHA } });
    fireEvent.click(button(start, 'Start process'));
    expect(await within(start).findByText('This exit already has a clearance checklist.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employees/${E_ASHA}/processes`)).toEqual([{ processCode: 'EXIT_STD', exitCaseId: X_ASHA }]);
    // The exits it offers reload; what was chosen stays.
    await waitFor(() => expect(callsTo('GET', `/v1/employees/${E_ASHA}/exit-cases`)).toHaveLength(2));
    expect(template.value).toBe('EXIT_STD');
  });

  it('names the template tasks whose named owner cannot act on the employee', async () => {
    mockApi({
      ...employeeRoutes(),
      [`POST /v1/employees/${E_ASHA}/processes`]: [
        422,
        { error: 'INVALID_OWNER', message: 'A named owner of this template cannot act on this employee; reassign the task in the template', details: { tasks: ['BUDDY', 'LUNCH'] } },
      ],
    });
    renderAt(`/lifecycle/employees/${E_ASHA}`, hr(HR_START));
    const start = await screen.findByRole('form', { name: 'Start a process' });
    const template = within(start).getByLabelText('Process template') as HTMLSelectElement;
    await waitFor(() => expect(template.options).toHaveLength(3));
    fireEvent.change(template, { target: { value: 'ONBOARD_STD' } });
    fireEvent.click(button(start, 'Start process'));
    expect(
      await within(start).findByText('These template tasks are owned by a named user who cannot act on this employee, or by the employee’s own user: BUDDY, LUNCH. Change their owner in the template first.'),
    ).toBeTruthy();
    expect(template.value).toBe('ONBOARD_STD');
  });

  it('offers no start form without the management duty, nor on the signed-in user’s own record', async () => {
    mockApi(employeeRoutes());
    renderAt(`/lifecycle/employees/${E_ASHA}`, hr([PROCESS_READ, EXIT_READ, EMPLOYEE_READ]));
    expect(await screen.findByRole('table', { name: 'Processes' })).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Start a process' })).toBeNull();
    await settle();
    expect(callsTo('GET', '/v1/lifecycle-processes')).toHaveLength(0);
    cleanup();

    mockApi({
      [`GET /v1/employees/${E_ME}`]: [200, { id: E_ME, employeeCode: 'SYN-900', displayName: 'Synthetic HR', status: 'ACTIVE_CONFIRMED' }],
      [`GET /v1/employees/${E_ME}/processes`]: [200, { items: [] }],
      [`GET /v1/employees/${E_ME}/exit-cases`]: [200, { items: [] }],
    });
    renderAt(`/lifecycle/employees/${E_ME}`, hr([...HR_START, NOTE_READ, NOTE_WRITE]));
    expect(await screen.findByText('This is your own record: processes, exits and notes about you are handled by another HR user.')).toBeTruthy();
    expect(screen.getByText('Notes about your own record are not shown to you, and you cannot add them.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Start a process' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add a note' })).toBeNull();
    await settle();
    expect(callsTo('GET', `/v1/employees/${E_ME}/notes`)).toHaveLength(0);
  });

  it('shows each task with its owner, required flag, due date, state and completion as text, and the history', async () => {
    mockApi({ [`GET /v1/employee-processes/${P_ONB}`]: [200, processOf(onboardingTasks())] });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ]));
    expect(await screen.findByRole('heading', { name: 'Standard onboarding for Asha Synthetic (SYN-101)' })).toBeTruthy();
    expect(valueIn(document.body, 'Template')).toBe('ONBOARD_STD, revision 1');
    expect(valueIn(document.body, 'Process owner')).toBe('You');
    expect(valueIn(document.body, 'Started')).toBe(localTime(CREATED_AT));
    expect(screen.getByText('5 tasks: 4 open, 3 required still open, 1 overdue.')).toBeTruthy();

    const intro = await taskItem('2. Team introduction (INTRO)');
    expect(valueIn(intro, 'Status')).toBe('open overdue');
    expect(valueIn(intro, 'Required')).toBe('Required');
    expect(valueIn(intro, 'Owner')).toBe('Reporting manager (role)');
    expect(valueIn(intro, 'Due')).toBe('20 Oct 2026');
    expect(hasTerm(intro, 'Completed')).toBe(false);
    const lunch = await taskItem('3. Welcome lunch (LUNCH)');
    expect(valueIn(lunch, 'Required')).toBe('Optional');
    expect(valueIn(lunch, 'Status')).toBe('open');
    const buddy = await taskItem('5. Buddy check-in (BUDDY)');
    expect(valueIn(buddy, 'Owner')).toBe('Ravi Synthetic');
    expect(valueIn(buddy, 'Status')).toBe('completed');
    expect(valueIn(buddy, 'Completed')).toBe(`25 Oct 2026 by User ${U_RAVI}`);
    expect(valueIn(await taskItem('1. Collect joining documents (DOCS)'), 'Evidence')).toBe('Required');
    expect(valueIn(await taskItem('4. Acknowledge the handbook (ACK)'), 'Owner')).toBe('Employee (role)');
    // A reader acts on nothing.
    expect(screen.queryByRole('button', { name: /^(Complete|Skip|Reassign|Reopen)$/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Process actions' })).toBeNull();

    const history = screen.getByRole('table', { name: 'Process history' });
    expect(headers(history)).toEqual(['Business date', 'Recorded', 'Action', 'Task', 'Change', 'Evidence', 'Remark or reason', 'By']);
    expect(bodyRows(history).map(cells)).toEqual([
      ['20 Oct 2026', localTime('2026-10-20T09:00:00.000Z'), 'Process started', '—', 'Open', '—', '—', 'You'],
      ['21 Oct 2026', localTime('2026-10-21T09:00:00.000Z'), 'Task reassigned', 'BUDDY', `Owner: HR Administrator (role) → User ${U_RAVI}`, '—', 'Recorded (restricted)', 'You'],
      ['25 Oct 2026', localTime(BUDDY_DONE_AT), 'Task completed', 'BUDDY', 'Open → Completed', '—', 'Recorded (restricted)', `User ${U_RAVI}`],
    ]);
    // FR-018: the remarks themselves never arrived, so they are nowhere on the page.
    expect(document.body.textContent).not.toContain(COMPLETE_REMARK);
    expect(document.body.textContent).not.toContain(REASSIGN_REASON);
  });

  it('shows the remarks and reasons only when the server returned them', async () => {
    mockApi({ [`GET /v1/employee-processes/${P_ONB}`]: [200, processOf(onboardingTasks(), {}, historyOf(true))] });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ]));
    const history = await screen.findByRole('table', { name: 'Process history' });
    expect(bodyRows(history).map((r) => cells(r)[6])).toEqual(['—', REASSIGN_REASON, COMPLETE_REMARK]);
    expect(history.textContent).not.toContain('Recorded (restricted)');
  });

  it('completes an owned task with a remark and the evidence it asks for, which waits for the malware scan', async () => {
    let tasks = onboardingTasks();
    const PDF_TEXT = '%PDF-1.4 synthetic joining letter';
    mockApi({
      [`GET /v1/employee-processes/${P_ONB}`]: () => [200, processOf(tasks)],
      [`POST /v1/employee-process-tasks/${K_DOCS}/complete`]: () => {
        const completed = done(docsTask(), { hasEvidence: true, evidenceScanState: 'PENDING_SCAN' });
        tasks = tasks.map((t) => (t.id === K_DOCS ? completed : t));
        return [200, completed];
      },
    });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ, TASK_COMPLETE, EVIDENCE_READ]));
    const docs = await taskItem('1. Collect joining documents (DOCS)');
    // The HR role owns DOCS; the manager's and the employee's tasks are theirs to complete.
    expect(within(await taskItem('2. Team introduction (INTRO)')).queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(within(await taskItem('4. Acknowledge the handbook (ACK)')).queryByRole('button', { name: 'Complete' })).toBeNull();
    // A required task offers no skip.
    expect(within(docs).queryByRole('button', { name: 'Skip' })).toBeNull();
    fireEvent.click(button(docs, 'Complete'));
    const form = within(docs).getByRole('form', { name: 'Complete Collect joining documents' });
    fireEvent.click(button(form, 'Complete task'));
    expect(await within(form).findByText('This task needs evidence: choose a PDF, JPEG or PNG file.')).toBeTruthy();
    await settle();
    expect(callsTo('POST', `/v1/employee-process-tasks/${K_DOCS}/complete`)).toHaveLength(0);

    type(form, 'Remark (optional; restricted to authorised HR)', '  Originals sighted (synthetic) ');
    fireEvent.change(within(form).getByLabelText('Evidence file (required)'), { target: { files: [new File([PDF_TEXT], 'joining.pdf', { type: 'application/pdf' })] } });
    const release = hold(`POST /v1/employee-process-tasks/${K_DOCS}/complete`);
    fireEvent.click(button(form, 'Complete task'));
    await waitFor(() => expect(callsTo('POST', `/v1/employee-process-tasks/${K_DOCS}/complete`)).toHaveLength(1));
    expect(button(form, 'Complete task').disabled).toBe(true);
    release();
    expect(await screen.findByText('Completed Collect joining documents. Its evidence is waiting for the malware scan; nobody can open it until the scan releases it.')).toBeTruthy();
    const [sent] = bodiesTo('POST', `/v1/employee-process-tasks/${K_DOCS}/complete`) as { evidence: { contentBase64: string } }[];
    expect(sent).toEqual({ expectedVersion: 1, remark: 'Originals sighted (synthetic)', evidence: { fileName: 'joining.pdf', contentBase64: expect.any(String) } });
    expect(atob(sent!.evidence.contentBase64)).toBe(PDF_TEXT);
    // The reloaded task: completed by the signed-in user on the business date, its evidence not yet released.
    await waitFor(() => expect(valueIn(docs, 'Completed')).toBe('26 Oct 2026 by You'));
    expect(valueIn(docs, 'Evidence')).toBe('waiting for the malware scan');
    expect(within(docs).queryByRole('button', { name: 'Download evidence' })).toBeNull();
    expect(within(docs).queryByRole('form')).toBeNull();
  });

  it('says at once when the evidence failed the malware scan on completion; the required task still holds the process', async () => {
    let tasks = onboardingTasks();
    mockApi({
      [`GET /v1/employee-processes/${P_ONB}`]: () => [200, processOf(tasks)],
      // The file is scanned right after it is stored, so the answer can already carry the verdict.
      [`POST /v1/employee-process-tasks/${K_DOCS}/complete`]: () => {
        const completed = done(docsTask(), { hasEvidence: true, evidenceScanState: 'QUARANTINED' });
        tasks = tasks.map((t) => (t.id === K_DOCS ? completed : t));
        return [200, completed];
      },
    });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ, PROCESS_MANAGE, TASK_COMPLETE, EVIDENCE_READ]));
    const docs = await taskItem('1. Collect joining documents (DOCS)');
    fireEvent.click(button(docs, 'Complete'));
    const form = within(docs).getByRole('form', { name: 'Complete Collect joining documents' });
    fireEvent.change(within(form).getByLabelText('Evidence file (required)'), { target: { files: [new File(['%PDF-1.4 synthetic'], 'joining.pdf', { type: 'application/pdf' })] } });
    fireEvent.click(button(form, 'Complete task'));
    const warning = await screen.findByText(
      'Completed Collect joining documents, but its evidence failed the malware scan: it counts as no evidence and nobody can open it. The task has to be reopened and completed again with a clean file.',
    );
    expect(warning.getAttribute('role')).toBe('alert');
    await waitFor(() => expect(valueIn(docs, 'Evidence')).toContain('quarantined by the malware scan'));
    expect(within(docs).queryByRole('button', { name: 'Download evidence' })).toBeNull();
    const actions = await findSection('Process actions');
    expect(within(actions).getByText(/Still incomplete: DOCS, INTRO, ACK\./)).toBeTruthy();
    expect(button(actions, 'Close process').disabled).toBe(true);
  });

  it('offers evidence downloads only for released files and only with the evidence grant', async () => {
    const tasks = [
      done(docsTask(), { hasEvidence: true, evidenceScanState: 'CLEAN', doneBy: U_RAVI }),
      done(pt(K_INTRO, 2, 'IDCHECK', 'Verify identity document', { evidenceRequired: true }), { hasEvidence: true, evidenceScanState: 'QUARANTINED', doneBy: U_RAVI }),
      lunchTask(),
    ];
    let reads = 0;
    mockApi({
      [`GET /v1/employee-processes/${P_ONB}`]: [200, processOf(tasks)],
      [`GET /v1/employee-process-tasks/${K_DOCS}/evidence`]: () =>
        ++reads === 1 ? [200, 'synthetic pdf bytes'] : [409, { error: 'FILE_NOT_RELEASED', message: 'This file has not been released by the malware scan', details: { scanState: 'QUARANTINED' } }],
    });
    const created = vi.fn(() => 'blob:synthetic-evidence');
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = created;
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ, EVIDENCE_READ]));
      const docs = await taskItem('1. Collect joining documents (DOCS)');
      expect(valueIn(docs, 'Evidence')).toContain('released by the malware scan');
      const idCheck = await taskItem('2. Verify identity document (IDCHECK)');
      expect(valueIn(idCheck, 'Evidence')).toContain('quarantined by the malware scan');
      expect(valueIn(idCheck, 'Evidence')).toContain('This file failed the malware scan and counts as no evidence: the task has to be reopened and completed again with a clean file.');
      expect(within(idCheck).queryByRole('button', { name: 'Download evidence' })).toBeNull();
      fireEvent.click(button(docs, 'Download evidence'));
      await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
      expect(callsTo('GET', `/v1/employee-process-tasks/${K_DOCS}/evidence`)).toHaveLength(1);
      expect(created).toHaveBeenCalledTimes(1);
      // Released files only: the server's refusal is said in words.
      fireEvent.click(button(docs, 'Download evidence'));
      expect(await within(docs).findByText('This file failed the malware scan, so it cannot be opened.')).toBeTruthy();
      expect(click).toHaveBeenCalledTimes(1);
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
    }
    cleanup();

    mockApi({ [`GET /v1/employee-processes/${P_ONB}`]: [200, processOf(tasks)] });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ]));
    const docs = await taskItem('1. Collect joining documents (DOCS)');
    expect(valueIn(docs, 'Evidence')).toBe('released by the malware scan');
    expect(within(docs).queryByRole('button', { name: 'Download evidence' })).toBeNull();
  });

  it('lets the owner skip an optional task with a reason, never a required one', async () => {
    let tasks = onboardingTasks();
    mockApi({
      [`GET /v1/employee-processes/${P_ONB}`]: () => [200, processOf(tasks)],
      [`POST /v1/employee-process-tasks/${K_LUNCH}/skip`]: () => {
        const skipped = done(lunchTask(), { state: 'SKIPPED', doneBy: U_MANAGER });
        tasks = tasks.map((t) => (t.id === K_LUNCH ? skipped : t));
        return [200, skipped];
      },
    });
    renderAt(`/lifecycle/processes/${P_ONB}`, manager([PROCESS_READ, TASK_COMPLETE]));
    const lunch = await taskItem('3. Welcome lunch (LUNCH)');
    const intro = await taskItem('2. Team introduction (INTRO)');
    expect(within(intro).getByRole('button', { name: 'Complete' })).toBeTruthy();
    expect(within(intro).queryByRole('button', { name: 'Skip' })).toBeNull();
    // The HR role's and the employee's tasks are not the manager's.
    expect(within(await taskItem('1. Collect joining documents (DOCS)')).queryByRole('button')).toBeNull();
    expect(within(await taskItem('4. Acknowledge the handbook (ACK)')).queryByRole('button')).toBeNull();
    // Without the HR duties: no reassignment, reopening, closing or cancelling.
    expect(screen.queryByRole('button', { name: /^(Reassign|Reopen)$/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Process actions' })).toBeNull();

    fireEvent.click(button(lunch, 'Skip'));
    const form = within(lunch).getByRole('form', { name: 'Skip Welcome lunch' });
    fireEvent.click(button(form, 'Skip task'));
    expect(await within(form).findByText('Enter the reason for skipping the task.')).toBeTruthy();
    await settle();
    expect(callsTo('POST', `/v1/employee-process-tasks/${K_LUNCH}/skip`)).toHaveLength(0);
    type(form, 'Reason for skipping (required)', 'The team works remotely (synthetic)');
    fireEvent.click(button(form, 'Skip task'));
    expect(await screen.findByText('Skipped Welcome lunch.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-process-tasks/${K_LUNCH}/skip`)).toEqual([{ expectedVersion: 1, reason: 'The team works remotely (synthetic)' }]);
    await waitFor(() => expect(valueIn(lunch, 'Skipped')).toBe('26 Oct 2026 by You'));
    expect(valueIn(lunch, 'Status')).toBe('skipped');
  });

  it('reassigns an open task with a reason; the prior owner stays in the history', async () => {
    let tasks = onboardingTasks();
    let history = historyOf(false);
    mockApi({
      [`GET /v1/employee-processes/${P_ONB}`]: () => [200, processOf(tasks, {}, history)],
      [`POST /v1/employee-process-tasks/${K_INTRO}/reassign`]: () => {
        const moved = { ...introTask(), ownerRoleCode: null, ownerUserId: U_RAVI, ownerName: 'Ravi Synthetic', version: 2 };
        tasks = tasks.map((t) => (t.id === K_INTRO ? moved : t));
        history = [
          ...history,
          ev('REASSIGN', {
            taskCode: 'INTRO',
            priorOwner: { roleCode: 'REPORTING_MANAGER', userId: null },
            newOwner: { roleCode: null, userId: U_RAVI },
            noteRecorded: true,
            businessDate: '2026-10-26',
            occurredAt: '2026-10-26T10:00:00.000Z',
          }),
        ];
        return [200, moved];
      },
    });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ, PROCESS_MANAGE]));
    const intro = await taskItem('2. Team introduction (INTRO)');
    // Only open tasks are reassigned; completing needs its own duty.
    expect(within(await taskItem('5. Buddy check-in (BUDDY)')).queryByRole('button', { name: 'Reassign' })).toBeNull();
    expect(within(intro).queryByRole('button', { name: 'Complete' })).toBeNull();
    fireEvent.click(button(intro, 'Reassign'));
    const form = within(intro).getByRole('form', { name: 'Reassign Team introduction' });
    type(form, 'New owner role code', 'reporting_manager');
    expect(input(form, 'New owner role code').value).toBe('REPORTING_MANAGER');
    fireEvent.click(button(form, 'Reassign task'));
    expect(await within(form).findByText('The task already has this owner.')).toBeTruthy();
    await settle();
    expect(callsTo('POST', `/v1/employee-process-tasks/${K_INTRO}/reassign`)).toHaveLength(0);
    fireEvent.click(within(form).getByLabelText('A named user'));
    type(form, 'New owner user ID', U_RAVI);
    type(form, 'Reason (optional; restricted to authorised HR)', 'Ravi covers the team this month (synthetic)');
    fireEvent.click(button(form, 'Reassign task'));
    expect(await screen.findByText('Reassigned Team introduction to Ravi Synthetic; the earlier owner stays in the history.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-process-tasks/${K_INTRO}/reassign`)).toEqual([{ expectedVersion: 1, ownerUserId: U_RAVI, reason: 'Ravi covers the team this month (synthetic)' }]);
    await waitFor(() => expect(valueIn(intro, 'Owner')).toBe('Ravi Synthetic'));
    const last = bodyRows(screen.getByRole('table', { name: 'Process history' })).at(-1)!;
    expect(cells(last).slice(2, 7)).toEqual(['Task reassigned', 'INTRO', `Owner: Reporting manager (role) → User ${U_RAVI}`, '—', 'Recorded (restricted)']);
  });

  it('reopens a completed task with a reason, with the reopen duty only', async () => {
    let tasks = onboardingTasks();
    mockApi({
      [`GET /v1/employee-processes/${P_ONB}`]: () => [200, processOf(tasks)],
      [`POST /v1/employee-process-tasks/${K_BUDDY}/reopen`]: () => {
        const reopened = { ...buddyTask(), state: 'OPEN', doneAt: null, doneOn: null, doneBy: null, version: 4 };
        tasks = tasks.map((t) => (t.id === K_BUDDY ? reopened : t));
        return [200, reopened];
      },
    });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ, PROCESS_REOPEN]));
    const buddy = await taskItem('5. Buddy check-in (BUDDY)');
    // Open tasks are not reopened; reassigning needs the management duty.
    expect(within(await taskItem('2. Team introduction (INTRO)')).queryByRole('button')).toBeNull();
    fireEvent.click(button(buddy, 'Reopen'));
    const form = within(buddy).getByRole('form', { name: 'Reopen Buddy check-in' });
    fireEvent.click(button(form, 'Reopen task'));
    expect(await within(form).findByText('Enter the reason for reopening the task.')).toBeTruthy();
    type(form, 'Reason for reopening (required)', 'The buddy left the team (synthetic)');
    fireEvent.click(button(form, 'Reopen task'));
    expect(await screen.findByText('Reopened Buddy check-in; its earlier completion stays in the history.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-process-tasks/${K_BUDDY}/reopen`)).toEqual([{ expectedVersion: 3, reason: 'The buddy left the team (synthetic)' }]);
    await waitFor(() => expect(valueIn(buddy, 'Status')).toBe('open'));
  });

  it('allows closing only once every required task is complete, as the API counts them', async () => {
    const cases: [ProcessTask[], string, boolean][] = [
      [onboardingTasks(), 'The process closes once every required task is complete. Still incomplete: DOCS, INTRO, ACK.', true],
      [
        requiredDone('QUARANTINED'),
        'The process closes once every required task is complete. Still incomplete: DOCS. A required task whose evidence failed the malware scan stays incomplete until it is reopened and completed with a clean file.',
        true,
      ],
      // FR-106: a file still waiting for its scan is not evidence yet.
      [requiredDone('PENDING_SCAN'), 'The process closes once every required task is complete. Still incomplete: DOCS. Required evidence still waiting for the malware scan counts once the scan releases it.', true],
      [requiredDone('CLEAN'), 'Every required task is done, so the process can close; open optional tasks do not hold it.', false],
    ];
    for (const [tasks, hint, disabled] of cases) {
      mockApi({ [`GET /v1/employee-processes/${P_ONB}`]: [200, processOf(tasks)] });
      renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ, PROCESS_MANAGE]));
      const actions = await findSection('Process actions');
      expect(within(actions).getByText(hint)).toBeTruthy();
      expect(button(actions, 'Close process').disabled).toBe(disabled);
      cleanup();
    }
  });

  it('closes the process against its version, saying a refusal in words and disabling the actions while in flight', async () => {
    let state = 'OPEN';
    let closes = 0;
    mockApi({
      [`GET /v1/employee-processes/${P_ONB}`]: () => [200, processOf(requiredDone('CLEAN'), { state, closedAt: state === 'CLOSED' ? '2026-10-26T12:00:00.000Z' : null, version: state === 'CLOSED' ? 5 : 4 })],
      [`POST /v1/employee-processes/${P_ONB}/close`]: () => {
        if (++closes === 1) return [409, { error: 'REQUIRED_TASKS_INCOMPLETE', message: 'Every required task must be completed first', details: { tasks: ['ACK'] } }];
        state = 'CLOSED';
        return [200, processOf(requiredDone('CLEAN'), { state, version: 5 })];
      },
    });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ, PROCESS_MANAGE]));
    const actions = await findSection('Process actions');
    fireEvent.click(button(actions, 'Close process'));
    expect(
      await within(actions).findByText(
        'Every required task must be completed first. Still incomplete: ACK. Required evidence counts only once the malware scan releases it: a file still waiting for the scan counts once released, and a task whose file failed the scan is reopened and completed again with a clean file.',
      ),
    ).toBeTruthy();
    const release = hold(`POST /v1/employee-processes/${P_ONB}/close`);
    fireEvent.click(button(actions, 'Close process'));
    await waitFor(() => expect(callsTo('POST', `/v1/employee-processes/${P_ONB}/close`)).toHaveLength(2));
    expect(button(actions, 'Close process').disabled).toBe(true);
    expect(button(actions, 'Cancel process').disabled).toBe(true);
    release();
    expect(await screen.findByText('Closed the process.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-processes/${P_ONB}/close`)).toEqual([{ expectedVersion: 4 }, { expectedVersion: 4 }]);
    await waitFor(() => expect(valueIn(document.body, 'State')).toBe('closed'));
    expect(screen.queryByRole('heading', { name: 'Process actions' })).toBeNull();
  });

  it('reopens a closed process and cancels an open one, each with a reason', async () => {
    let state = 'CLOSED';
    mockApi({
      [`GET /v1/employee-processes/${P_ONB}`]: () => [200, processOf(requiredDone('CLEAN'), { state, version: state === 'CLOSED' ? 5 : 6, reopenCount: state === 'OPEN' ? 1 : 0 })],
      [`POST /v1/employee-processes/${P_ONB}/reopen`]: () => {
        state = 'OPEN';
        return [200, processOf(requiredDone('CLEAN'), { state, version: 6 })];
      },
      [`POST /v1/employee-processes/${P_ONB}/cancel`]: () => {
        state = 'CANCELLED';
        return [200, processOf(requiredDone('CLEAN'), { state, version: 7 })];
      },
    });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ, PROCESS_MANAGE, PROCESS_REOPEN]));
    const reopen = await screen.findByRole('form', { name: 'Reopen the process' });
    expect(screen.queryByRole('button', { name: 'Close process' })).toBeNull();
    fireEvent.click(button(reopen, 'Reopen process'));
    expect(await within(reopen).findByText('Enter the reason for reopening the process.')).toBeTruthy();
    await settle();
    expect(callsTo('POST', `/v1/employee-processes/${P_ONB}/reopen`)).toHaveLength(0);
    type(reopen, 'Reason for reopening (required)', 'Audit finding on the documents (synthetic)');
    fireEvent.click(button(reopen, 'Reopen process'));
    expect(await screen.findByText('Reopened the process. Its history is kept.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-processes/${P_ONB}/reopen`)).toEqual([{ expectedVersion: 5, reason: 'Audit finding on the documents (synthetic)' }]);
    await waitFor(() => expect(valueIn(document.body, 'Reopened')).toBe('1 time'));

    const cancel = await screen.findByRole('form', { name: 'Cancel the process' });
    fireEvent.click(button(cancel, 'Cancel process'));
    expect(await within(cancel).findByText('Enter the reason for cancelling the process.')).toBeTruthy();
    type(cancel, 'Reason for cancelling (required)', 'Replaced by a new process (synthetic)');
    fireEvent.click(button(cancel, 'Cancel process'));
    expect(await screen.findByText('Cancelled the process. Its tasks and history are kept.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-processes/${P_ONB}/cancel`)).toEqual([{ expectedVersion: 6, reason: 'Replaced by a new process (synthetic)' }]);
    await waitFor(() => expect(valueIn(document.body, 'State')).toBe('cancelled'));
  });

  it('keeps the reason after a refused reopening of a released exit’s checklist', async () => {
    const checklist = processOf([done(pt(K_DOCS, 1, 'ASSETS', 'Return assets'))], { id: P_CLEAR, processCode: 'EXIT_STD', processName: 'Exit clearance', processType: 'EXIT', state: 'CLOSED', exitCaseId: X_ASHA });
    mockApi({
      [`GET /v1/employee-processes/${P_CLEAR}`]: [200, checklist],
      [`POST /v1/employee-processes/${P_CLEAR}/reopen`]: [409, { error: 'EXIT_RELEASED', message: 'The exit was finally released; its checklist is final' }],
    });
    renderAt(`/lifecycle/processes/${P_CLEAR}`, hr([PROCESS_READ, PROCESS_REOPEN, EXIT_READ]));
    expect(await screen.findByRole('link', { name: 'Open the exit case' })).toBeTruthy();
    const reopen = screen.getByRole('form', { name: 'Reopen the process' });
    type(reopen, 'Reason for reopening (required)', 'A laptop was not returned (synthetic)');
    fireEvent.click(button(reopen, 'Reopen process'));
    expect(await within(reopen).findByText('The exit was finally released, so its clearance checklist is final.')).toBeTruthy();
    expect((within(reopen).getByLabelText('Reason for reopening (required)') as HTMLTextAreaElement).value).toBe('A laptop was not returned (synthetic)');
  });

  it('says why a completed task of a released exit’s open checklist cannot be reopened, keeping the reason', async () => {
    const checklist = processOf([done(pt(K_DOCS, 1, 'ASSETS', 'Return assets')), pt(K_INTRO, 2, 'SURVEY', 'Exit survey', { ownerRoleCode: 'EMPLOYEE', required: false })], {
      id: P_CLEAR,
      processCode: 'EXIT_STD',
      processName: 'Exit clearance',
      processType: 'EXIT',
      exitCaseId: X_ASHA,
    });
    mockApi({
      [`GET /v1/employee-processes/${P_CLEAR}`]: [200, checklist],
      [`POST /v1/employee-process-tasks/${K_DOCS}/reopen`]: [409, { error: 'EXIT_RELEASED', message: 'The exit was finally released; its checklist is final' }],
    });
    renderAt(`/lifecycle/processes/${P_CLEAR}`, hr([PROCESS_READ, PROCESS_REOPEN]));
    const assets = await taskItem('1. Return assets (ASSETS)');
    fireEvent.click(button(assets, 'Reopen'));
    const form = within(assets).getByRole('form', { name: 'Reopen Return assets' });
    type(form, 'Reason for reopening (required)', 'A charger was not returned (synthetic)');
    fireEvent.click(button(form, 'Reopen task'));
    expect(await within(form).findByText('The exit was finally released, so its clearance checklist is final.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-process-tasks/${K_DOCS}/reopen`)).toEqual([{ expectedVersion: 2, reason: 'A charger was not returned (synthetic)' }]);
    expect((within(form).getByLabelText('Reason for reopening (required)') as HTMLTextAreaElement).value).toBe('A charger was not returned (synthetic)');
  });

  it('closes a task form whose task moved on meanwhile and says why at the top of the process', async () => {
    let tasks = onboardingTasks();
    mockApi({
      [`GET /v1/employee-processes/${P_ONB}`]: () => [200, processOf(tasks)],
      [`POST /v1/employee-process-tasks/${K_INTRO}/complete`]: () => {
        // Someone else completed it first.
        tasks = tasks.map((t) => (t.id === K_INTRO ? done(introTask(), { doneBy: U_RAVI }) : t));
        return [409, { error: 'TASK_NOT_OPEN', message: 'The task is not open' }];
      },
    });
    renderAt(`/lifecycle/processes/${P_ONB}`, manager([PROCESS_READ, TASK_COMPLETE]));
    const intro = await taskItem('2. Team introduction (INTRO)');
    fireEvent.click(button(intro, 'Complete'));
    const form = within(intro).getByRole('form', { name: 'Complete Team introduction' });
    expect(within(form).getByLabelText('Evidence file (optional)')).toBeTruthy();
    fireEvent.click(button(form, 'Complete task'));
    expect(await screen.findByText('This task is no longer open.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-process-tasks/${K_INTRO}/complete`)).toEqual([{ expectedVersion: 1 }]);
    await waitFor(() => expect(valueIn(intro, 'Completed')).toBe(`26 Oct 2026 by User ${U_RAVI}`));
    expect(within(intro).queryByRole('form')).toBeNull();
    expect(within(intro).queryByRole('button')).toBeNull();
  });

  it('offers an HR user nothing to do on a process about themselves, whatever their duties (C4)', async () => {
    const tasks = [
      done(docsTask(), { hasEvidence: true, evidenceScanState: 'CLEAN', doneBy: U_RAVI }),
      // Open, owned by the HR role the signed-in user holds; and open, owned by the Employee role.
      pt(K_INTRO, 2, 'BADGE', 'Issue the access badge'),
      ackTask(),
    ];
    mockApi({ [`GET /v1/employee-processes/${P_ONB}`]: [200, processOf(tasks, { employeeId: E_ME, employeeCode: 'SYN-900', employeeName: 'Synthetic HR' })] });
    renderAt(`/lifecycle/processes/${P_ONB}`, hr([PROCESS_READ, PROCESS_MANAGE, PROCESS_REOPEN, TASK_COMPLETE, EVIDENCE_READ]));
    expect(await screen.findByRole('heading', { name: 'Standard onboarding for Synthetic HR (SYN-900)' })).toBeTruthy();
    // No completion, skipping, reassignment, reopening or evidence download on one's own record.
    expect(within(screen.getByRole('list', { name: 'Tasks' })).queryAllByRole('button')).toHaveLength(0);
    expect(valueIn(await taskItem('1. Collect joining documents (DOCS)'), 'Evidence')).toBe('released by the malware scan');
    // Nor closing or cancelling the process.
    expect(screen.queryByRole('heading', { name: 'Process actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: /process$/ })).toBeNull();
  });
});

// =========================================================================================================
describe('my process tasks queue (FR-016)', () => {
  const myTask = (t: ProcessTask) => ({ ...t, processId: P_ONB, processCode: 'ONBOARD_STD', processName: 'Standard onboarding', employeeId: E_ASHA, employeeCode: 'SYN-101', employeeName: 'Asha Synthetic' });

  it('lists the open tasks the caller or their role owns and completes one from the queue', async () => {
    let mine = [myTask(introTask()), myTask(lunchTask())];
    mockApi({
      'GET /v1/employee-process-tasks/mine': () => [200, { items: mine, total: mine.length, overdue: mine.filter((t) => t.overdue).length }],
      [`POST /v1/employee-process-tasks/${K_INTRO}/complete`]: () => {
        mine = mine.filter((t) => t.id !== K_INTRO);
        return [200, done(introTask(), { doneBy: U_MANAGER })];
      },
    });
    renderPart(queueNamed('My process tasks'), manager([TASK_COMPLETE, PROCESS_READ]));
    expect(await screen.findByRole('heading', { name: 'My process tasks (2)' })).toBeTruthy();
    expect(screen.getByText('1 task past the due date.')).toBeTruthy();
    const intro = await taskItem('Team introduction (INTRO)');
    expect(within(intro).getByRole('link', { name: 'Standard onboarding' }).getAttribute('href')).toBe(`/lifecycle/processes/${P_ONB}`);
    expect(intro.textContent).toContain('for Asha Synthetic (SYN-101)');
    expect(valueIn(intro, 'Status')).toBe('open overdue');
    expect(within(await taskItem('Welcome lunch (LUNCH)')).getByRole('button', { name: 'Skip' })).toBeTruthy();
    expect(within(intro).queryByRole('button', { name: 'Skip' })).toBeNull();
    fireEvent.click(button(intro, 'Complete'));
    fireEvent.click(button(within(intro).getByRole('form', { name: 'Complete Team introduction' }), 'Complete task'));
    expect(await screen.findByText('Completed Team introduction.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-process-tasks/${K_INTRO}/complete`)).toEqual([{ expectedVersion: 1 }]);
    expect(await screen.findByRole('heading', { name: 'My process tasks (1)' })).toBeTruthy();
  });

  it('is not shown, and nothing is requested, without the completion duty', async () => {
    mockApi({});
    const { container } = renderPart(queueNamed('My process tasks'), manager([PROCESS_READ]));
    await settle();
    expect(container.textContent).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('pages the queue, showing the total and overdue count of every task, not only the page (FR-056)', async () => {
    mockApi({
      'GET /v1/employee-process-tasks/mine': (c) => [
        200,
        c.params.get('page') === '2' ? { items: [myTask(lunchTask())], total: 26, page: 2, pageSize: 25, overdue: 3 } : { items: [myTask(introTask())], total: 26, page: 1, pageSize: 25, overdue: 3 },
      ],
    });
    renderPart(queueNamed('My process tasks'), manager([TASK_COMPLETE, PROCESS_READ]));
    expect(await screen.findByRole('heading', { name: 'My process tasks (26)' })).toBeTruthy();
    expect(screen.getByText('3 tasks past the due date.')).toBeTruthy();
    expect(callsTo('GET', '/v1/employee-process-tasks/mine')[0]?.params.toString()).toBe('page=1&pageSize=25');
    const pager = screen.getByRole('navigation', { name: 'Task pages' });
    expect(pager.textContent).toContain('Page 1 of 2 · 26 tasks');
    expect(within(pager).getByRole('button', { name: 'Previous page' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    expect(await taskItem('Welcome lunch (LUNCH)')).toBeTruthy();
    expect(callsTo('GET', '/v1/employee-process-tasks/mine').at(-1)?.params.toString()).toBe('page=2&pageSize=25');
    expect(screen.getByRole('heading', { name: 'My process tasks (26)' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Task pages' })).getByRole('button', { name: 'Next page' }).hasAttribute('disabled')).toBe(true);
  });
});

// =========================================================================================================
describe('restricted HR notes (FR-018)', () => {
  const NOTES = [
    { id: N_FIX, kind: 'NOTE', body: 'Joining date confirmed by phone (synthetic)', exitCaseId: null, processId: null, supersedesNoteId: N_FIRST, supersededByNoteId: null, createdBy: U_RAVI, createdAt: '2026-10-24T09:00:00.000Z' },
    { id: N_WARN, kind: 'WARNING', body: 'Documents arrived late twice (synthetic)', exitCaseId: null, processId: P_ONB, supersedesNoteId: null, supersededByNoteId: null, createdBy: U_ME, createdAt: '2026-10-23T09:00:00.000Z' },
    { id: N_FIRST, kind: 'NOTE', body: 'Joining date to confirm (synthetic)', exitCaseId: null, processId: null, supersedesNoteId: null, supersededByNoteId: N_FIX, createdBy: U_RAVI, createdAt: '2026-10-22T09:00:00.000Z' },
  ];
  const routes = (notes: Handler): Record<string, Handler> => ({
    [`GET /v1/employees/${E_ASHA}`]: [200, ASHA_HIT],
    [`GET /v1/employees/${E_ASHA}/processes`]: [200, { items: [ONBOARDING_SUMMARY] }],
    [`GET /v1/employees/${E_ASHA}/exit-cases`]: [200, { items: [] }],
    [`GET /v1/employees/${E_ASHA}/notes`]: notes,
  });

  it('lists the append-only notes, adds one linked to a process and corrects the latest note', async () => {
    let corrections = 0;
    mockApi({
      ...routes([200, { items: NOTES }]),
      [`POST /v1/employees/${E_ASHA}/notes`]: (c) => {
        const body = c.body as { supersedesNoteId?: string };
        if (body.supersedesNoteId && ++corrections === 1) return [409, { error: 'ALREADY_SUPERSEDED', message: 'That note was already corrected' }];
        return [201, { id: '60000000-0000-4000-8000-000000000009', employeeId: E_ASHA, kind: 'WARNING', createdAt: '2026-10-26T10:00:00.000Z' }];
      },
    });
    renderAt(`/lifecycle/employees/${E_ASHA}`, hr([PROCESS_READ, EMPLOYEE_READ, NOTE_READ, NOTE_WRITE]));
    const list = await screen.findByRole('list', { name: 'Restricted HR notes' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]!.textContent).toContain('Corrects an earlier note.');
    expect(within(items[0]!).getByRole('button', { name: 'Correct this note' })).toBeTruthy();
    expect(items[1]!.textContent).toContain('warning');
    expect(items[1]!.textContent).toContain('Process: Standard onboarding (ONBOARD_STD)');
    expect(items[1]!.textContent).toContain(`${localTime('2026-10-23T09:00:00.000Z')} by You`);
    expect(items[2]!.textContent).toContain('Corrected by a later note.');
    expect(within(items[2]!).queryByRole('button', { name: 'Correct this note' })).toBeNull();

    const add = screen.getByRole('form', { name: 'Add a note' });
    type(add, 'Kind', 'WARNING');
    type(add, 'Linked to', `process:${P_ONB}`);
    type(add, 'Note (restricted to authorised HR)', '  Joining documents arrived late again (synthetic) ');
    fireEvent.click(button(add, 'Add note'));
    expect(await screen.findByText('Saved the warning.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employees/${E_ASHA}/notes`)).toEqual([{ kind: 'WARNING', body: 'Joining documents arrived late again (synthetic)', employeeProcessId: P_ONB }]);
    const fresh = screen.getByRole('form', { name: 'Add a note' });
    expect((within(fresh).getByLabelText('Note (restricted to authorised HR)') as HTMLTextAreaElement).value).toBe('');

    fireEvent.click(within(within(screen.getByRole('list', { name: 'Restricted HR notes' })).getAllByRole('listitem')[0]!).getByRole('button', { name: 'Correct this note' }));
    const correct = screen.getByRole('form', { name: 'Correct a note' });
    const text = within(correct).getByLabelText('Note (restricted to authorised HR)') as HTMLTextAreaElement;
    expect(text.value).toBe('Joining date confirmed by phone (synthetic)');
    fireEvent.change(text, { target: { value: 'Joining date confirmed by email (synthetic)' } });
    fireEvent.click(button(correct, 'Save correction'));
    expect(await within(correct).findByText('That note was already corrected; correct the latest note instead.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employees/${E_ASHA}/notes`)[1]).toEqual({ kind: 'NOTE', body: 'Joining date confirmed by email (synthetic)', supersedesNoteId: N_FIX });
    // The list reloads; what was typed stays.
    await waitFor(() => expect(callsTo('GET', `/v1/employees/${E_ASHA}/notes`).length).toBeGreaterThanOrEqual(3));
    expect(text.value).toBe('Joining date confirmed by email (synthetic)');
  });

  it('shows no notes, and requests none, without the restricted grants', async () => {
    mockApi(routes([200, { items: NOTES }]));
    renderAt(`/lifecycle/employees/${E_ASHA}`, hr([PROCESS_READ, EMPLOYEE_READ]));
    expect(await screen.findByRole('table', { name: 'Processes' })).toBeTruthy();
    await settle();
    expect(screen.queryByRole('heading', { name: 'Restricted HR notes' })).toBeNull();
    expect(callsTo('GET', `/v1/employees/${E_ASHA}/notes`)).toHaveLength(0);
    expect(document.body.textContent).not.toContain('Joining date');
  });
});

// =========================================================================================================
describe('exit cases (FR-051, F1)', () => {
  const MEERA_EXIT = exitCase({
    id: X_MEERA,
    employeeId: E_MEERA,
    employeeCode: 'SYN-103',
    employeeName: 'Meera Synthetic',
    state: 'SEPARATED',
    requestDate: '2026-08-01',
    proposedLastWorkingDate: '2026-09-30',
    recommendedLastWorkingDate: '2026-09-30',
    approvedLastWorkingDate: '2026-09-30',
    lastWorkingDate: '2026-09-30',
    noticePeriod: { status: 'RECORDED', contractualNoticeDays: 30 },
    released: true,
    releasedAt: '2026-10-02T09:00:00.000Z',
    version: 6,
  });

  it('sorts the exit cases on the server by a column heading, with the state filter, starting again at page 1 (FR-056)', async () => {
    mockApi({ 'GET /v1/exit-cases': () => [200, { items: [exitCase()], total: 30, page: 1, pageSize: 25 }] });
    renderAt('/lifecycle/exits', hr([EXIT_READ]));
    const table = await screen.findByRole('table', { name: 'Exit cases' });
    const last = () => callsTo('GET', '/v1/exit-cases').at(-1)!.params;
    expect(last().has('sort')).toBe(false);
    expect(within(table).getByRole('columnheader', { name: 'Resignation date' }).getAttribute('aria-sort')).toBe('none');
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'SEPARATED' } });
    await waitFor(() => expect(last().get('state')).toBe('SEPARATED'));
    fireEvent.click(within(await screen.findByRole('navigation', { name: 'Exit case pages' })).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(last().get('page')).toBe('2'));
    fireEvent.click(within(await screen.findByRole('table', { name: 'Exit cases' })).getByRole('button', { name: 'Resignation date' }));
    await waitFor(() => expect(last().get('sort')).toBe('requestDate'));
    expect(last().get('direction')).toBe('ASC');
    expect(last().get('state')).toBe('SEPARATED');
    expect(last().get('page')).toBe('1');
    const sorted = await screen.findByRole('table', { name: 'Exit cases' });
    expect(within(sorted).getByRole('columnheader', { name: /Resignation date/ }).getAttribute('aria-sort')).toBe('ascending');
    fireEvent.click(within(sorted).getByRole('button', { name: /Resignation date/ }));
    await waitFor(() => expect(last().get('direction')).toBe('DESC'));
  });

  it('lists the exits in scope with the contractual notice period as recorded, filtered by state', async () => {
    mockApi({ 'GET /v1/exit-cases': (c) => [200, { items: c.params.get('state') === 'SEPARATED' ? [MEERA_EXIT] : [exitCase(), MEERA_EXIT] }] });
    renderAt('/lifecycle/exits', hr([EXIT_READ]));
    const table = await screen.findByRole('table', { name: 'Exit cases' });
    expect(headers(table)).toEqual(['Employee', 'Resignation date', 'State', 'Proposed last working date', 'Recommended', 'Approved', 'Contractual notice period', 'Final release']);
    expect(cells(rowWith(table, 'Asha Synthetic (SYN-101)'))).toEqual(['Asha Synthetic (SYN-101)', '20 Oct 2026', 'submitted', '31 Dec 2026', '—', '—', 'Not recorded', 'Not released']);
    expect(cells(rowWith(table, 'Meera Synthetic (SYN-103)'))).toEqual(['Meera Synthetic (SYN-103)', '1 Aug 2026', 'separated', '30 Sep 2026', '30 Sep 2026', '30 Sep 2026', '30 days (contractual)', 'Released']);
    expect(within(table).getByRole('link', { name: 'Asha Synthetic (SYN-101)' }).getAttribute('href')).toBe(`/lifecycle/exits/${X_ASHA}`);
    fireEvent.change(screen.getByLabelText('State'), { target: { value: 'SEPARATED' } });
    await waitFor(() => expect(bodyRows(screen.getByRole('table', { name: 'Exit cases' }))).toHaveLength(1));
    expect(callsTo('GET', '/v1/exit-cases').map((c) => c.params.get('state'))).toEqual([null, 'SEPARATED']);
    // Without a decision duty there is no decision queue to load.
    expect(screen.queryByRole('heading', { name: /^Resignation (recommendations|approvals|withdrawal requests)/ })).toBeNull();
    expect(callsTo('GET', '/v1/exit-cases/tasks/mine')).toHaveLength(0);
  });

  it('shows the exit, its decisions and its history with the NOTICE status change, and no reason the server did not return', async () => {
    mockApi({
      [`GET /v1/exit-cases/${X_ASHA}`]: [
        200,
        approvedDetail({ withdrawals: [{ id: W_ASHA, state: 'REJECTED', employeeMessage: 'Your exit stands (synthetic)', requestedAt: REQUESTED_AT, decidedAt: '2026-10-26T09:00:00.000Z' }] }),
      ],
    });
    renderAt(`/lifecycle/exits/${X_ASHA}`, hr([EXIT_READ, PROCESS_READ]));
    expect(await screen.findByRole('heading', { name: 'Exit of Asha Synthetic (SYN-101)' })).toBeTruthy();
    const facts = await findSection('Exit');
    expect(valueIn(facts, 'State')).toBe('approved Approved; the employee separates after the inclusive last working date');
    expect(valueIn(facts, 'Separation type')).toBe('Resignation');
    expect(valueIn(facts, 'Resignation date')).toBe('20 Oct 2026');
    expect(valueIn(facts, 'Proposed last working date')).toBe('31 Dec 2026');
    expect(valueIn(facts, 'Recommended last working date')).toBe('15 Dec 2026');
    expect(valueIn(facts, 'Approved last working date')).toBe('20 Dec 2026');
    expect(valueIn(facts, 'Last working date (inclusive)')).toBe('20 Dec 2026');
    expect(valueIn(facts, 'Contractual notice period')).toBe('Not recorded');
    expect(valueIn(facts, 'Final release')).toBe('Not released');
    // The exit reason group was not granted: no reason, and no reason of the withdrawal request.
    expect(hasTerm(facts, 'Reason')).toBe(false);
    expect(hasTerm(facts, 'Reason code')).toBe(false);
    const withdrawals = screen.getByRole('list', { name: 'Withdrawal requests' });
    expect(withdrawals.textContent).toContain(`rejected requested ${localTime(REQUESTED_AT)}, decided ${localTime('2026-10-26T09:00:00.000Z')}`);
    expect(withdrawals.textContent).toContain('Message to the employee: Your exit stands (synthetic)');
    expect(withdrawals.textContent).not.toContain('Reason:');

    expect(within(screen.getByRole('list', { name: 'Decisions' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      `Recommendation of the last working date (step 1): approved on ${localTime('2026-10-21T06:00:00.000Z')}`,
      `HR decision (step 2): approved on ${localTime('2026-10-22T06:00:00.000Z')}`,
    ]);
    const history = screen.getByRole('table', { name: 'Exit history' });
    expect(headers(history)).toEqual(['Business date', 'Recorded', 'Step', 'State', 'Last working date', 'Employee status', 'By']);
    expect(bodyRows(history).map(cells)).toEqual([
      ['20 Oct 2026', localTime('2026-10-20T06:00:00.000Z'), 'Resignation submitted', 'New → Submitted', '31 Dec 2026', '—', `User ${U_ASHA}`],
      ['21 Oct 2026', localTime('2026-10-21T06:00:00.000Z'), 'Last working date recommended', 'Submitted → Recommended', '15 Dec 2026', '—', `User ${U_MANAGER}`],
      ['22 Oct 2026', localTime('2026-10-22T06:00:00.000Z'), 'Resignation approved', 'Recommended → Approved', '20 Dec 2026', 'Active (confirmed) → Notice', `User ${U_RAVI}`],
    ]);
    // Without the HR management duties: nothing to record here.
    expect(screen.queryByRole('form', { name: 'Contractual notice period' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Start the clearance checklist' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Final release' })).toBeNull();
    expect(within(await findSection('Clearance checklist')).getByText('Not started.')).toBeTruthy();
  });

  it('shows the reason, and a withdrawal request’s reason, when the server returned them', async () => {
    mockApi({
      [`GET /v1/exit-cases/${X_ASHA}`]: [
        200,
        approvedDetail(
          { withdrawals: [{ id: W_ASHA, state: 'SUBMITTED', reason: 'Plans changed (synthetic)', employeeMessage: null, requestedAt: REQUESTED_AT, decidedAt: null }] },
          approvedExit({ reasonCode: 'RELOCATION', reason: OWN_REASON }),
        ),
      ],
    });
    renderAt(`/lifecycle/exits/${X_ASHA}`, hr([EXIT_READ]));
    const facts = await findSection('Exit');
    expect(valueIn(facts, 'Reason code')).toBe('RELOCATION');
    expect(valueIn(facts, 'Reason')).toBe(OWN_REASON);
    expect(screen.getByRole('list', { name: 'Withdrawal requests' }).textContent).toContain('Reason: Plans changed (synthetic)');
  });

  it('shows the separation after the inclusive last working date as the server recorded it', async () => {
    mockApi({
      [`GET /v1/exit-cases/${X_ASHA}`]: [200, approvedDetail({ history: [SUBMITTED_EVENT, RECOMMENDED_EVENT, APPROVED_EVENT, SEPARATED_EVENT] }, approvedExit({ state: 'SEPARATED', version: 4 }))],
    });
    renderAt(`/lifecycle/exits/${X_ASHA}`, hr([EXIT_READ]));
    const facts = await findSection('Exit');
    expect(valueIn(facts, 'State')).toBe('separated Separated after the last working date');
    const last = bodyRows(screen.getByRole('table', { name: 'Exit history' })).at(-1)!;
    expect(cells(last)).toEqual(['21 Dec 2026', localTime('2026-12-21T00:05:00.000Z'), 'Separated', 'Approved → Separated', '20 Dec 2026', 'Notice → Inactive (separated)', `User ${U_SYSTEM}`]);
  });

  it('records the contractual notice period against the exit version, keeping the typed value after a refusal', async () => {
    let exit = approvedDetail();
    let records = 0;
    mockApi({
      [`GET /v1/exit-cases/${X_ASHA}`]: () => [200, exit],
      [`PUT /v1/exit-cases/${X_ASHA}/notice-period`]: (c) => {
        const body = c.body as { contractualNoticeDays: number; expectedVersion: number };
        if (++records === 1) {
          exit = { ...exit, version: 4 };
          return [409, STALE];
        }
        if (body.expectedVersion !== exit.version) return [409, STALE];
        exit = { ...exit, noticePeriod: { status: 'RECORDED', contractualNoticeDays: body.contractualNoticeDays }, version: exit.version + 1 };
        return [200, exit];
      },
    });
    renderAt(`/lifecycle/exits/${X_ASHA}`, hr([EXIT_READ, EXIT_MANAGE]));
    const form = await screen.findByRole('form', { name: 'Contractual notice period' });
    expect(input(form, 'Notice period (days)').value).toBe('');
    type(form, 'Notice period (days)', '4000');
    // The browser refuses it first (the field's own range); the page checks it again before sending.
    expect(input(form, 'Notice period (days)').validity.rangeOverflow).toBe(true);
    fireEvent.submit(form);
    expect(await screen.findByText('Enter the notice period as a whole number of days from 0 to 3650.')).toBeTruthy();
    await settle();
    expect(callsTo('PUT', `/v1/exit-cases/${X_ASHA}/notice-period`)).toHaveLength(0);
    type(form, 'Notice period (days)', '30');
    fireEvent.click(button(form, 'Record notice period'));
    expect(await screen.findByText('The exit case changed since it was loaded. It has been reloaded: check it and try again.')).toBeTruthy();
    await waitFor(() => expect(callsTo('GET', `/v1/exit-cases/${X_ASHA}`)).toHaveLength(2));
    expect(input(form, 'Notice period (days)').value).toBe('30');
    fireEvent.click(button(form, 'Record notice period'));
    expect(await screen.findByText('Recorded the contractual notice period: 30 days.')).toBeTruthy();
    expect(bodiesTo('PUT', `/v1/exit-cases/${X_ASHA}/notice-period`)).toEqual([
      { contractualNoticeDays: 30, expectedVersion: 3 },
      { contractualNoticeDays: 30, expectedVersion: 4 },
    ]);
    // Shown as the configured contractual field only; nothing is derived from it.
    await waitFor(() => expect(valueIn(screen.getByRole('heading', { name: 'Exit' }).closest('section') as HTMLElement, 'Contractual notice period')).toBe('30 days (contractual)'));
    expect(input(form, 'Notice period (days)').value).toBe('30');
  });

  it('starts the clearance checklist from an exit template and lists the required tasks still incomplete', async () => {
    let exit = approvedDetail();
    mockApi({
      [`GET /v1/exit-cases/${X_ASHA}`]: () => [200, exit],
      'GET /v1/lifecycle-processes': [200, { items: SUMMARIES }],
      [`POST /v1/employees/${E_ASHA}/processes`]: () => {
        exit = { ...exit, clearance: { started: true, complete: false, processIds: [P_CLEAR], incompleteRequired: ['ASSETS', 'HANDOVER'] } };
        return [201, { ...processOf([pt(K_DOCS, 1, 'ASSETS', 'Return assets'), pt(K_INTRO, 2, 'HANDOVER', 'Hand over work')], { id: P_CLEAR, processName: 'Exit clearance', exitCaseId: X_ASHA }), history: [] }];
      },
    });
    renderAt(`/lifecycle/exits/${X_ASHA}`, hr([EXIT_READ, EXIT_MANAGE, PROCESS_READ, PROCESS_MANAGE, TEMPLATE_READ]));
    const start = await screen.findByRole('form', { name: 'Start the clearance checklist' });
    const template = within(start).getByLabelText('Exit clearance template') as HTMLSelectElement;
    await waitFor(() => expect(Array.from(template.options).map((o) => o.textContent)).toEqual(['Choose a template…', 'Exit clearance (EXIT_STD) · revision 1']));
    // The final release waits for a complete clearance.
    expect(button(await findSection('Final release'), 'Record final release').disabled).toBe(true);
    fireEvent.click(button(start, 'Start clearance checklist'));
    expect(await within(start).findByText('Choose the exit clearance template.')).toBeTruthy();
    fireEvent.change(template, { target: { value: 'EXIT_STD' } });
    fireEvent.click(button(start, 'Start clearance checklist'));
    expect(await screen.findByText('Started the clearance checklist Exit clearance with 2 tasks.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employees/${E_ASHA}/processes`)).toEqual([{ processCode: 'EXIT_STD', exitCaseId: X_ASHA }]);
    const clearance = await findSection('Clearance checklist');
    expect(await within(clearance).findByText('Required clearance tasks still incomplete: ASSETS, HANDOVER.')).toBeTruthy();
    expect(within(clearance).getByRole('link', { name: 'Open the clearance checklist' }).getAttribute('href')).toBe(`/lifecycle/processes/${P_CLEAR}`);
    expect(screen.queryByRole('form', { name: 'Start the clearance checklist' })).toBeNull();
  });

  it('records the final release once the clearance is complete, saying the API’s refusals in words', async () => {
    const complete: Clearance = { started: true, complete: true, processIds: [P_CLEAR], incompleteRequired: [] };
    let exit = approvedDetail({ clearance: complete });
    let releases = 0;
    mockApi({
      [`GET /v1/exit-cases/${X_ASHA}`]: () => [200, exit],
      [`POST /v1/exit-cases/${X_ASHA}/final-release`]: () => {
        if (++releases === 1) return [409, { error: 'BEFORE_LAST_WORKING_DATE', message: 'The final release is on or after the last working date' }];
        exit = { ...exit, released: true, releasedAt: '2026-12-21T10:00:00.000Z', version: 4 };
        return [200, exit];
      },
    });
    renderAt(`/lifecycle/exits/${X_ASHA}`, hr([EXIT_READ, EXIT_MANAGE, PROCESS_READ]));
    const release = await findSection('Final release');
    expect(within(release).getByText(/The final release is recorded on or after the last working date \(20 Dec 2026\)/)).toBeTruthy();
    expect(within(await findSection('Clearance checklist')).getByText('Every required clearance task is complete.')).toBeTruthy();
    fireEvent.click(button(release, 'Record final release'));
    expect(await within(release).findByText('The final release is recorded on or after the last working date.')).toBeTruthy();
    const held = hold(`POST /v1/exit-cases/${X_ASHA}/final-release`);
    fireEvent.click(button(release, 'Record final release'));
    await waitFor(() => expect(callsTo('POST', `/v1/exit-cases/${X_ASHA}/final-release`)).toHaveLength(2));
    expect(button(release, 'Record final release').disabled).toBe(true);
    held();
    expect(await screen.findByText('Recorded the final release. The exit and its clearance checklist are final.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/exit-cases/${X_ASHA}/final-release`)).toEqual([{ expectedVersion: 3 }, { expectedVersion: 3 }]);
    await waitFor(() => expect(valueIn(screen.getByRole('heading', { name: 'Exit' }).closest('section') as HTMLElement, 'Final release')).toBe(`Released ${localTime('2026-12-21T10:00:00.000Z')}`));
    // A released exit is final: no release and no notice period to record.
    expect(screen.queryByRole('heading', { name: 'Final release' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Contractual notice period' })).toBeNull();
  });

  it('moves a refusal to the top when the release is gone after the reload', async () => {
    let exit = approvedDetail({ clearance: { started: true, complete: true, processIds: [P_CLEAR], incompleteRequired: [] } });
    mockApi({
      [`GET /v1/exit-cases/${X_ASHA}`]: () => [200, exit],
      [`POST /v1/exit-cases/${X_ASHA}/final-release`]: () => {
        // Another HR user released it first.
        exit = { ...exit, released: true, releasedAt: '2026-12-21T09:00:00.000Z', version: 4 };
        return [409, { error: 'ALREADY_RELEASED', message: 'The exit was already released' }];
      },
    });
    renderAt(`/lifecycle/exits/${X_ASHA}`, hr([EXIT_READ, EXIT_MANAGE]));
    fireEvent.click(button(await findSection('Final release'), 'Record final release'));
    expect(await screen.findByText('This exit was already finally released.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Final release' })).toBeNull());
    expect(screen.getByText('This exit was already finally released.')).toBeTruthy();
  });

  it('offers an HR user no notice period, clearance or release on their own exit (C4)', async () => {
    const own = approvedExit({ id: X_OLD, employeeId: E_ME, employeeCode: 'SYN-900', employeeName: 'Synthetic HR' });
    mockApi({ [`GET /v1/exit-cases/${X_OLD}`]: [200, approvedDetail({}, own)], 'GET /v1/lifecycle-processes': [200, { items: SUMMARIES }] });
    renderAt(`/lifecycle/exits/${X_OLD}`, hr([EXIT_READ, EXIT_MANAGE, PROCESS_READ, PROCESS_MANAGE, TEMPLATE_READ]));
    expect(await screen.findByRole('heading', { name: 'Exit of Synthetic HR (SYN-900)' })).toBeTruthy();
    expect(within(await findSection('Clearance checklist')).getByText('Not started.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Contractual notice period' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Start the clearance checklist' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Final release' })).toBeNull();
    await settle();
    // The templates a clearance would start from are not even requested.
    expect(callsTo('GET', '/v1/lifecycle-processes')).toHaveLength(0);
  });
});

// =========================================================================================================
describe('exit decision queues (F1; ZT07)', () => {
  it('lets the manager recommend the inclusive last working date with an idempotency key, disabled while in flight', async () => {
    let tasks = [recommendTask()];
    mockApi({
      'GET /v1/exit-cases/tasks/mine': () => [200, { items: tasks }],
      [`POST /v1/exit-cases/tasks/${TK_RECOMMEND}/recommend`]: (c) => {
        tasks = [];
        return [200, { exitCaseId: X_ASHA, state: 'RECOMMENDED', recommendedLastWorkingDate: (c.body as { recommendedLastWorkingDate: string }).recommendedLastWorkingDate, replayed: false }];
      },
    });
    renderPart(queueNamed('Resignation recommendations'), manager([EXIT_READ, EXIT_RECOMMEND]));
    expect(await screen.findByRole('heading', { name: 'Resignation recommendations (1)' })).toBeTruthy();
    const item = await taskItem('Asha Synthetic (SYN-101)');
    expect(valueIn(item, 'Resignation date')).toBe('20 Oct 2026');
    expect(valueIn(item, 'Proposed last working date')).toBe('31 Dec 2026');
    expect(valueIn(item, 'Contractual notice period')).toBe('Not recorded');
    // The reason group is not granted to this manager: no reason is shown.
    expect(hasTerm(item, 'Employee’s reason')).toBe(false);
    expect(within(item).getByRole('link', { name: 'Open the exit case' }).getAttribute('href')).toBe(`/lifecycle/exits/${X_ASHA}`);
    const form = within(item).getByRole('form', { name: 'Recommend the last working date of Asha Synthetic (SYN-101)' });
    expect(input(form, 'Recommended last working date (inclusive)').value).toBe('2026-12-31');
    type(form, 'Recommended last working date (inclusive)', '2026-12-15');
    const release = hold(`POST /v1/exit-cases/tasks/${TK_RECOMMEND}/recommend`);
    fireEvent.click(button(form, 'Recommend this date'));
    await waitFor(() => expect(callsTo('POST', `/v1/exit-cases/tasks/${TK_RECOMMEND}/recommend`)).toHaveLength(1));
    expect(button(form, 'Recommend this date').disabled).toBe(true);
    release();
    expect(await screen.findByText('Recommended 15 Dec 2026 as the last working date of Asha Synthetic (SYN-101). The resignation now waits for the HR decision.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/exit-cases/tasks/${TK_RECOMMEND}/recommend`)).toEqual([{ recommendedLastWorkingDate: '2026-12-15', idempotencyKey: expect.stringMatching(/^exit-recommend-/) }]);
    expect((bodiesTo('POST', `/v1/exit-cases/tasks/${TK_RECOMMEND}/recommend`)[0] as { idempotencyKey: string }).idempotencyKey).toMatch(KEY);
    expect(await screen.findByText('No resignations are waiting for your recommendation.')).toBeTruthy();
  });

  it('sends the same decision again with the same key after a lost answer, and a different decision with a new key', async () => {
    const recorded = new Map<string, string>();
    mockApi({
      'GET /v1/exit-cases/tasks/mine': () => [200, { items: recorded.size > 0 ? [] : [recommendTask()] }],
      [`POST /v1/exit-cases/tasks/${TK_RECOMMEND}/recommend`]: (c) => {
        const { recommendedLastWorkingDate, idempotencyKey } = c.body as { recommendedLastWorkingDate: string; idempotencyKey: string };
        // ZT07: a recorded key replays its outcome without a second effect.
        if (recorded.has(idempotencyKey)) return [200, { exitCaseId: X_ASHA, state: 'RECOMMENDED', replayed: true }];
        if (recommendedLastWorkingDate < '2026-10-26') return [422, { error: 'INVALID_LAST_WORKING_DATE', message: 'The recommended last working date must be a valid date' }];
        recorded.set(idempotencyKey, recommendedLastWorkingDate);
        return [200, { exitCaseId: X_ASHA, state: 'RECOMMENDED', recommendedLastWorkingDate, replayed: false }];
      },
    });
    renderPart(queueNamed('Resignation recommendations'), manager([EXIT_READ, EXIT_RECOMMEND]));
    const form = await screen.findByRole('form', { name: 'Recommend the last working date of Asha Synthetic (SYN-101)' });
    type(form, 'Recommended last working date (inclusive)', '2026-10-01');
    fireEvent.click(button(form, 'Recommend this date'));
    expect(await within(form).findByText('The recommended last working date must be a valid date, not before the resignation date or today.')).toBeTruthy();
    type(form, 'Recommended last working date (inclusive)', '2026-12-15');
    loseAnswer(`POST /v1/exit-cases/tasks/${TK_RECOMMEND}/recommend`);
    fireEvent.click(button(form, 'Recommend this date'));
    expect(await within(form).findByText('No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.')).toBeTruthy();
    fireEvent.click(button(form, 'Recommend this date'));
    expect(await screen.findByText('Your earlier recommendation for Asha Synthetic (SYN-101) had already been recorded, so nothing was applied twice.')).toBeTruthy();
    const keys = (bodiesTo('POST', `/v1/exit-cases/tasks/${TK_RECOMMEND}/recommend`) as { idempotencyKey: string }[]).map((b) => b.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[2]).toBe(keys[1]);
    expect(recorded.size).toBe(1);
  });

  it('lets an HR Administrator approve another inclusive date, or not approve with a private reason and a message', async () => {
    let tasks = [approveTask()];
    mockApi({
      'GET /v1/exit-cases/tasks/mine': () => [200, { items: tasks }],
      [`POST /v1/exit-cases/tasks/${TK_APPROVE}/decision`]: (c) => {
        const body = c.body as { decision: string; approvedLastWorkingDate?: string };
        tasks = [];
        return [200, body.decision === 'APPROVE' ? { exitCaseId: X_ASHA, state: 'APPROVED', approvedLastWorkingDate: body.approvedLastWorkingDate, replayed: false } : { exitCaseId: X_ASHA, state: 'REJECTED', replayed: false }];
      },
    });
    renderPart(queueNamed('Resignation approvals'), hr([EXIT_READ, EXIT_APPROVE]));
    const item = await taskItem('Asha Synthetic (SYN-101)');
    expect(valueIn(item, 'Recommended last working date')).toBe('15 Dec 2026');
    const group = within(item).getByRole('group', { name: 'Decide the resignation of Asha Synthetic (SYN-101)' });
    expect(input(group, 'Approved last working date (inclusive)').value).toBe('2026-12-15');
    // Not approving needs both the private reason and the message.
    fireEvent.click(button(group, 'Do not approve'));
    expect(await within(group).findByText('To not approve the resignation, record the private reason and the message for the employee.')).toBeTruthy();
    await settle();
    expect(callsTo('POST', `/v1/exit-cases/tasks/${TK_APPROVE}/decision`)).toHaveLength(0);
    type(group, 'Approved last working date (inclusive)', '2026-12-20');
    type(group, 'Private reason (never shown to the employee; required to not approve)', 'Handover needs one more week (synthetic)');
    const release = hold(`POST /v1/exit-cases/tasks/${TK_APPROVE}/decision`);
    fireEvent.click(button(group, 'Approve'));
    await waitFor(() => expect(callsTo('POST', `/v1/exit-cases/tasks/${TK_APPROVE}/decision`)).toHaveLength(1));
    // Both decisions wait while one is in flight.
    expect(button(group, 'Approve').disabled).toBe(true);
    expect(button(group, 'Do not approve').disabled).toBe(true);
    release();
    expect(await screen.findByText('Approved the resignation of Asha Synthetic (SYN-101): the last working date is 20 Dec 2026 (inclusive).')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/exit-cases/tasks/${TK_APPROVE}/decision`)).toEqual([
      { decision: 'APPROVE', approvedLastWorkingDate: '2026-12-20', reason: 'Handover needs one more week (synthetic)', idempotencyKey: expect.stringMatching(/^exit-decision-/) },
    ]);
    expect(await screen.findByText('No resignations are waiting for your decision.')).toBeTruthy();
    cleanup();

    tasks = [approveTask()];
    mockApi({
      'GET /v1/exit-cases/tasks/mine': () => [200, { items: tasks }],
      [`POST /v1/exit-cases/tasks/${TK_APPROVE}/decision`]: () => {
        tasks = [];
        return [200, { exitCaseId: X_ASHA, state: 'REJECTED', replayed: false }];
      },
    });
    renderPart(queueNamed('Resignation approvals'), hr([EXIT_READ, EXIT_APPROVE]));
    const again = within(await taskItem('Asha Synthetic (SYN-101)')).getByRole('group', { name: 'Decide the resignation of Asha Synthetic (SYN-101)' });
    type(again, 'Private reason (never shown to the employee; required to not approve)', 'Role cannot be backfilled yet (synthetic)');
    type(again, 'Message to the employee (required to not approve)', 'Please talk to HR first (synthetic)');
    fireEvent.click(button(again, 'Do not approve'));
    expect(await screen.findByText('The resignation of Asha Synthetic (SYN-101) was not approved; they will see your message.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/exit-cases/tasks/${TK_APPROVE}/decision`)).toEqual([
      { decision: 'REJECT', reason: 'Role cannot be backfilled yet (synthetic)', employeeMessage: 'Please talk to HR first (synthetic)', idempotencyKey: expect.stringMatching(KEY) },
    ]);
  });

  it('takes a decided task out of the queue with the reason in words; other refusals keep it', async () => {
    let decisions = 0;
    const refusals: Reply[] = [
      [409, STALE],
      [409, { error: 'EMPLOYEE_NOT_ACTIVE', message: 'The employee is no longer active' }],
      [409, { error: 'TASK_CLOSED', message: 'This task has already been decided' }],
    ];
    mockApi({
      'GET /v1/exit-cases/tasks/mine': () => [200, { items: decisions >= 3 ? [] : [approveTask()] }],
      [`POST /v1/exit-cases/tasks/${TK_APPROVE}/decision`]: () => refusals[decisions++]!,
    });
    renderPart(queueNamed('Resignation approvals'), hr([EXIT_READ, EXIT_APPROVE]));
    const group = within(await taskItem('Asha Synthetic (SYN-101)')).getByRole('group', { name: 'Decide the resignation of Asha Synthetic (SYN-101)' });
    fireEvent.click(button(group, 'Approve'));
    // A decision carries no version: nothing is reloaded, the same decision is simply sent again.
    expect(await within(group).findByText('Another change reached this request at the same moment, so your decision was not recorded. Send it again.')).toBeTruthy();
    fireEvent.click(button(group, 'Approve'));
    expect(await within(group).findByText('The employee is no longer active, so the resignation cannot be approved.')).toBeTruthy();
    fireEvent.click(button(group, 'Approve'));
    expect(await screen.findByText('This task has already been decided.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('listitem', { name: 'Asha Synthetic (SYN-101)' })).toBeNull());
    // The same decision sent again reuses its key (ZT07): a recorded decision would replay, never apply twice.
    const keys = (bodiesTo('POST', `/v1/exit-cases/tasks/${TK_APPROVE}/decision`) as { idempotencyKey: string }[]).map((b) => b.idempotencyKey);
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(1);
  });

  it('decides a withdrawal request with a reason, and with a message when not approving it', async () => {
    let decisions = 0;
    mockApi({
      'GET /v1/exit-cases/tasks/mine': () => [200, { items: decisions >= 2 ? [] : [withdrawalTask()] }],
      [`GET /v1/exit-cases/${X_ASHA}`]: [200, approvedDetail({ withdrawals: [{ id: W_ASHA, state: 'SUBMITTED', employeeMessage: null, requestedAt: REQUESTED_AT, decidedAt: null }] })],
      [`POST /v1/exit-withdrawals/tasks/${TK_WITHDRAWAL}/decision`]: () =>
        ++decisions === 1
          ? [409, { error: 'SETTLEMENT_IN_PROGRESS', message: 'A settlement is being prepared for this exit' }]
          : [200, { withdrawalId: W_ASHA, state: 'REJECTED', exitState: 'APPROVED', replayed: false }],
    });
    renderPart(queueNamed('Resignation withdrawal requests'), hr([EXIT_READ, EXIT_APPROVE]));
    const item = await taskItem('Asha Synthetic (SYN-101)');
    expect(valueIn(item, 'Approved last working date')).toBe('20 Dec 2026');
    const group = within(item).getByRole('group', { name: 'Decide the withdrawal request of Asha Synthetic (SYN-101)' });
    // The request as the exit case shows it; its reason was not returned to this role.
    await waitFor(() => expect(group.textContent).toContain(`Withdrawal requested ${localTime(REQUESTED_AT)}`));
    expect(group.textContent).not.toContain('Reason:');
    fireEvent.click(button(group, 'Approve the withdrawal'));
    expect(await within(group).findByText('Record the reason for your decision; it is never shown to the employee.')).toBeTruthy();
    type(group, 'Reason for your decision (required; never shown to the employee)', 'Business agrees to retain (synthetic)');
    fireEvent.click(button(group, 'Approve the withdrawal'));
    expect(await within(group).findByText('A settlement is being prepared for this exit; it has to be cancelled or finished before the withdrawal can be approved.')).toBeTruthy();
    fireEvent.click(button(group, 'Do not approve'));
    expect(await within(group).findByText('To not approve the withdrawal, explain the decision to the employee.')).toBeTruthy();
    type(group, 'Message to the employee (required to not approve)', 'Your exit stands (synthetic)');
    const release = hold(`POST /v1/exit-withdrawals/tasks/${TK_WITHDRAWAL}/decision`);
    fireEvent.click(button(group, 'Do not approve'));
    await waitFor(() => expect(callsTo('POST', `/v1/exit-withdrawals/tasks/${TK_WITHDRAWAL}/decision`)).toHaveLength(2));
    expect(button(group, 'Approve the withdrawal').disabled).toBe(true);
    expect(button(group, 'Do not approve').disabled).toBe(true);
    release();
    expect(await screen.findByText('The withdrawal was not approved: the resignation of Asha Synthetic (SYN-101) stands, and they will see your message.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/exit-withdrawals/tasks/${TK_WITHDRAWAL}/decision`)).toEqual([
      { decision: 'APPROVE', reason: 'Business agrees to retain (synthetic)', idempotencyKey: expect.stringMatching(/^exit-withdrawal-/) },
      { decision: 'REJECT', reason: 'Business agrees to retain (synthetic)', employeeMessage: 'Your exit stands (synthetic)', idempotencyKey: expect.stringMatching(/^exit-withdrawal-/) },
    ]);
  });

  it('shows each queue only with the decision duty, and none without the exit read duty', async () => {
    mockApi({ 'GET /v1/exit-cases/tasks/mine': [200, { items: [recommendTask()] }], 'GET /v1/exit-cases': [200, { items: [] }] });
    renderAt('/lifecycle/exits', manager([EXIT_READ, EXIT_RECOMMEND]));
    expect(await screen.findByRole('heading', { name: 'Resignation recommendations (1)' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /^Resignation approvals/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /^Resignation withdrawal requests/ })).toBeNull();
    cleanup();

    mockApi({});
    renderAt('/lifecycle/exits', hr([EXIT_RECOMMEND, EXIT_APPROVE]));
    expect(await screen.findByText('The selected role cannot view exit cases.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
    cleanup();

    mockApi({});
    const { container } = renderPart(queueNamed('Resignation approvals'), hr([EXIT_READ]));
    await settle();
    expect(container.textContent).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('offers the reviewer’s own decision on the exit case and drops it once decided', async () => {
    let tasks = [approveTask()];
    mockApi({
      [`GET /v1/exit-cases/${X_ASHA}`]: () => [200, detailOf(recommendedExit(), { history: [SUBMITTED_EVENT, RECOMMENDED_EVENT] })],
      'GET /v1/exit-cases/tasks/mine': () => [200, { items: tasks }],
      [`POST /v1/exit-cases/tasks/${TK_APPROVE}/decision`]: () => {
        tasks = [];
        return [200, { exitCaseId: X_ASHA, state: 'APPROVED', approvedLastWorkingDate: '2026-12-15', replayed: false }];
      },
    });
    renderAt(`/lifecycle/exits/${X_ASHA}`, hr([EXIT_READ, EXIT_APPROVE]));
    const waiting = await findSection('Waiting for your decision');
    // On the exit case itself the item does not link to it again.
    expect(within(waiting).queryByRole('link', { name: 'Open the exit case' })).toBeNull();
    fireEvent.click(button(within(waiting).getByRole('group', { name: 'Decide the resignation of Asha Synthetic (SYN-101)' }), 'Approve'));
    expect(await screen.findByText('Approved the resignation of Asha Synthetic (SYN-101): the last working date is 15 Dec 2026 (inclusive).')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/exit-cases/tasks/${TK_APPROVE}/decision`)).toEqual([{ decision: 'APPROVE', approvedLastWorkingDate: '2026-12-15', idempotencyKey: expect.stringMatching(KEY) }]);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Waiting for your decision' })).toBeNull());
  });
});

// =========================================================================================================
describe('my resignation (Employee OWN context; H3)', () => {
  /** The employee's own exits, as GET /v1/me/exit-cases returns them: their own reason included (H1). */
  const own = (x: ExitCase) => ({ ...x, reasonCode: null, reason: OWN_REASON });

  it('asks other roles to switch to their Employee role and requests nothing', async () => {
    mockApi({});
    renderPart(panelFor('RESIGNATION'), hr([EXIT_READ, EXIT_SUBMIT, PROCESS_READ]));
    expect(await screen.findByText('Your own resignation is handled in your Employee role. Switch to it to submit or follow one.')).toBeTruthy();
    cleanup();
    renderPart(panelFor('MY_PROCESSES'), hr([EXIT_READ, PROCESS_READ]));
    expect(await screen.findByText('Your own processes are shown in your Employee role. Switch to it to follow them.')).toBeTruthy();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('submits a resignation with the proposed inclusive last working date, keeping what was typed after a refusal', async () => {
    const rejected = detailOf(own(exitCase({ id: X_OLD, state: 'REJECTED', requestDate: '2026-09-01', proposedLastWorkingDate: '2026-10-31', lastWorkingDate: '2026-10-31', employeeMessage: 'Please talk to HR first (synthetic)' })));
    let exits: ExitDetail[] = [rejected];
    let posts = 0;
    mockApi({
      'GET /v1/me/exit-cases': () => [200, { items: exits }],
      'POST /v1/me/resignation': (c) => {
        const body = c.body as { proposedLastWorkingDate: string };
        if (++posts === 1) return [422, { error: 'INVALID_LAST_WORKING_DATE', message: 'Synthetic refusal' }];
        exits = [detailOf(own(exitCase())), rejected];
        return [201, { exitCaseId: X_ASHA, state: 'SUBMITTED', requestDate: '2026-10-26', proposedLastWorkingDate: body.proposedLastWorkingDate }];
      },
    });
    renderPart(panelFor('RESIGNATION'), asha([EXIT_SUBMIT, EXIT_READ]));
    const earlier = await screen.findByRole('list', { name: 'Earlier resignations' });
    expect(earlier.textContent).toContain('rejected resigned 1 Sep 2026, last working date 31 Oct 2026');
    expect(earlier.textContent).toContain('Message from HR: Please talk to HR first (synthetic)');

    // With the form shown, no "no open resignation" note, no second heading and no reason-code field.
    const form = screen.getByRole('form', { name: 'Submit your resignation' });
    expect(screen.queryByText('You have no open resignation.')).toBeNull();
    expect(within(form).queryByRole('heading')).toBeNull();
    expect(within(form).queryByLabelText(/Reason code/)).toBeNull();
    expect(form.textContent).toContain('Choose your proposed last working day. Your manager and HR review it; you can withdraw until HR decides.');
    fireEvent.click(button(form, 'Submit resignation'));
    expect(await within(form).findByText('Choose your proposed last working day.')).toBeTruthy();
    await settle();
    expect(callsTo('POST', '/v1/me/resignation')).toHaveLength(0);
    type(form, 'Proposed last working day (you work on this day)', '2026-12-31');
    type(form, 'Reason (optional; seen by you and authorised reviewers only)', OWN_REASON);
    fireEvent.click(button(form, 'Submit resignation'));
    // Nothing is sent until the employee confirms the date they are resigning with.
    const confirmation = within(form).getByRole('group', { name: 'Confirm your resignation' });
    expect(confirmation.textContent).toContain('You are resigning with 31 Dec 2026 as your last working day.');
    await settle();
    expect(callsTo('POST', '/v1/me/resignation')).toHaveLength(0);
    fireEvent.click(button(form, 'Yes, submit my resignation'));
    expect(await within(form).findByText('The proposed last working date must be a valid date, today or later.')).toBeTruthy();
    expect(input(form, 'Proposed last working day (you work on this day)').value).toBe('2026-12-31');
    fireEvent.click(button(form, 'Submit resignation'));
    fireEvent.click(button(form, 'Yes, submit my resignation'));
    expect(
      await screen.findByText('Your resignation was submitted on 26 Oct 2026 with the proposed last working date 31 Dec 2026. Your manager recommends the last working date, then HR decides.'),
    ).toBeTruthy();
    expect(bodiesTo('POST', '/v1/me/resignation')).toEqual([
      { proposedLastWorkingDate: '2026-12-31', reason: OWN_REASON },
      { proposedLastWorkingDate: '2026-12-31', reason: OWN_REASON },
    ]);
    const card = await screen.findByRole('article', { name: 'Your resignation' });
    expect(valueIn(card, 'State')).toBe('submitted Waiting for the recommendation of the last working date');
    expect(valueIn(card, 'Reason')).toBe(OWN_REASON);
    expect(hasTerm(card, 'Employee')).toBe(false);
    expect(within(card).getByRole('button', { name: 'Withdraw my resignation' })).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Submit your resignation' })).toBeNull();
  });

  it('withdraws the resignation before the HR decision, disabled while in flight', async () => {
    let exits = [detailOf(own(recommendedExit()), { history: [SUBMITTED_EVENT, RECOMMENDED_EVENT] })];
    mockApi({
      'GET /v1/me/exit-cases': () => [200, { items: exits }],
      [`POST /v1/me/exit-cases/${X_ASHA}/withdraw`]: () => {
        exits = [{ ...exits[0]!, state: 'WITHDRAWN', version: 3 }];
        return [200, { exitCaseId: X_ASHA, state: 'WITHDRAWN' }];
      },
    });
    renderPart(panelFor('RESIGNATION'), asha([EXIT_SUBMIT, EXIT_READ]));
    const card = await screen.findByRole('article', { name: 'Your resignation' });
    expect(valueIn(card, 'State')).toBe('recommended Waiting for the HR decision');
    expect(within(card).getByText('Until HR decides, you can withdraw your resignation yourself.')).toBeTruthy();
    // The own view shows no actors.
    expect(headers(within(card).getByRole('table', { name: 'Exit history' }))).toEqual(['Business date', 'Recorded', 'Step', 'State', 'Last working date', 'Employee status']);
    const release = hold(`POST /v1/me/exit-cases/${X_ASHA}/withdraw`);
    fireEvent.click(button(card, 'Withdraw my resignation'));
    await waitFor(() => expect(callsTo('POST', `/v1/me/exit-cases/${X_ASHA}/withdraw`)).toHaveLength(1));
    expect(button(card, 'Withdraw my resignation').disabled).toBe(true);
    release();
    expect(await screen.findByText('Your resignation is withdrawn. The request and its history are kept.')).toBeTruthy();
    expect(callsTo('POST', `/v1/me/exit-cases/${X_ASHA}/withdraw`)[0]!.body).toBeUndefined();
    expect((await screen.findByRole('list', { name: 'Earlier resignations' })).textContent).toContain('withdrawn resigned 20 Oct 2026, last working date 15 Dec 2026');
    expect(screen.getByRole('form', { name: 'Submit your resignation' })).toBeTruthy();
  });

  it('says when the resignation was approved meanwhile and offers the withdrawal request instead', async () => {
    let exits = [detailOf(own(exitCase()))];
    mockApi({
      'GET /v1/me/exit-cases': () => [200, { items: exits }],
      [`POST /v1/me/exit-cases/${X_ASHA}/withdraw`]: () => {
        exits = [approvedDetail({}, own(approvedExit()))];
        return [409, { error: 'USE_WITHDRAWAL_REQUEST', message: 'An approved resignation is withdrawn only through an HR decision' }];
      },
    });
    renderPart(panelFor('RESIGNATION'), asha([EXIT_SUBMIT, EXIT_READ]));
    fireEvent.click(button(await screen.findByRole('article', { name: 'Your resignation' }), 'Withdraw my resignation'));
    expect(await screen.findByText('Your resignation is approved, so it can be withdrawn only through an HR decision: request the withdrawal instead.')).toBeTruthy();
    expect(await screen.findByRole('form', { name: 'Request to withdraw your resignation' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Withdraw my resignation' })).toBeNull();
  });

  it('requests the withdrawal of an approved resignation and cancels the pending request', async () => {
    let withdrawals: Withdrawal[] = [];
    const exitNow = () => approvedDetail({ withdrawals }, own(approvedExit()));
    mockApi({
      'GET /v1/me/exit-cases': () => [200, { items: [exitNow()] }],
      [`POST /v1/me/exit-cases/${X_ASHA}/withdrawal-request`]: (c) => {
        withdrawals = [{ id: W_ASHA, state: 'SUBMITTED', reason: (c.body as { reason: string }).reason, employeeMessage: null, requestedAt: REQUESTED_AT, decidedAt: null }];
        return [201, { withdrawalId: W_ASHA, exitCaseId: X_ASHA, state: 'SUBMITTED' }];
      },
      [`POST /v1/me/exit-withdrawals/${W_ASHA}/cancel`]: () => {
        withdrawals = [{ ...withdrawals[0]!, state: 'WITHDRAWN' }];
        return [200, { withdrawalId: W_ASHA, state: 'WITHDRAWN' }];
      },
    });
    renderPart(panelFor('RESIGNATION'), asha([EXIT_SUBMIT, EXIT_READ]));
    const card = await screen.findByRole('article', { name: 'Your resignation' });
    expect(valueIn(card, 'Last working date (inclusive)')).toBe('20 Dec 2026');
    expect(within(card).queryByRole('button', { name: 'Withdraw my resignation' })).toBeNull();
    // The NOTICE status change is part of the own history.
    expect(cells(bodyRows(within(card).getByRole('table', { name: 'Exit history' })).at(-1)!)).toEqual([
      '22 Oct 2026',
      localTime('2026-10-22T06:00:00.000Z'),
      'Resignation approved',
      'Recommended → Approved',
      '20 Dec 2026',
      'Active (confirmed) → Notice',
    ]);
    const form = within(card).getByRole('form', { name: 'Request to withdraw your resignation' });
    fireEvent.click(button(form, 'Request withdrawal'));
    expect(await within(form).findByText('Enter why you want to withdraw your resignation.')).toBeTruthy();
    await settle();
    expect(callsTo('POST', `/v1/me/exit-cases/${X_ASHA}/withdrawal-request`)).toHaveLength(0);
    type(form, 'Why do you want to withdraw it? (required)', 'Plans changed (synthetic)');
    fireEvent.click(button(form, 'Request withdrawal'));
    expect(await screen.findByText('Your withdrawal request was sent. An HR Administrator decides it independently; until then your approved resignation stands.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/me/exit-cases/${X_ASHA}/withdrawal-request`)).toEqual([{ reason: 'Plans changed (synthetic)' }]);
    const requests = await within(card).findByRole('list', { name: 'Withdrawal requests' });
    expect(requests.textContent).toContain(`submitted requested ${localTime(REQUESTED_AT)}`);
    expect(requests.textContent).toContain('Reason: Plans changed (synthetic)');
    expect(within(card).queryByRole('form', { name: 'Request to withdraw your resignation' })).toBeNull();
    fireEvent.click(button(requests, 'Cancel my withdrawal request'));
    expect(await screen.findByText('Your withdrawal request is cancelled; your approved resignation stands.')).toBeTruthy();
    expect(callsTo('POST', `/v1/me/exit-withdrawals/${W_ASHA}/cancel`)[0]!.body).toBeUndefined();
    expect(await within(card).findByRole('form', { name: 'Request to withdraw your resignation' })).toBeTruthy();
  });
});

// =========================================================================================================
describe('my processes (Employee OWN context; H3)', () => {
  it('lists the own processes and completes the employee’s own task, without remarks, evidence or HR actions', async () => {
    let tasks = [done(docsTask(), { hasEvidence: true, evidenceScanState: 'CLEAN', doneBy: U_ME }), introTask(), lunchTask(), ackTask(), buddyTask()];
    mockApi({
      'GET /v1/me/processes': [200, { items: [ONBOARDING_SUMMARY] }],
      [`GET /v1/employee-processes/${P_ONB}`]: () => [200, processOf(tasks)],
      [`POST /v1/employee-process-tasks/${K_ACK}/complete`]: () => {
        const completed = done(ackTask(), { doneBy: U_ASHA });
        tasks = tasks.map((t) => (t.id === K_ACK ? completed : t));
        return [200, completed];
      },
    });
    // Even holding the evidence grant, nobody opens evidence about their own record.
    renderPart(panelFor('MY_PROCESSES'), asha([PROCESS_READ, TASK_COMPLETE, EVIDENCE_READ]));
    const table = await screen.findByRole('table', { name: 'My processes' });
    expect(headers(table)).toEqual(['Process', 'Type', 'State', 'Effective date', 'Open tasks', 'Overdue', 'Tasks']);
    expect(cells(bodyRows(table)[0]!)).toEqual(['Standard onboarding', 'Onboarding', 'open', '2 Nov 2026', '4 of 5', '1 overdue', 'Show tasks']);
    fireEvent.click(within(table).getByRole('button', { name: 'Show tasks' }));
    expect(await screen.findByRole('heading', { name: 'Standard onboarding (ONBOARD_STD)' })).toBeTruthy();
    const ack = await taskItem('4. Acknowledge the handbook (ACK)');
    const docs = await taskItem('1. Collect joining documents (DOCS)');
    expect(within(docs).queryByRole('button')).toBeNull();
    expect(valueIn(docs, 'Evidence')).toBe('released by the malware scan');
    expect(within(await taskItem('2. Team introduction (INTRO)')).queryByRole('button')).toBeNull();
    expect(hasTerm(document.body, 'Process owner')).toBe(false);
    expect(screen.queryByRole('heading', { name: 'Process actions' })).toBeNull();
    expect(screen.getByRole('table', { name: 'Process history' }).textContent).toContain('Recorded (restricted)');
    fireEvent.click(button(ack, 'Complete'));
    fireEvent.click(button(within(ack).getByRole('form', { name: 'Complete Acknowledge the handbook' }), 'Complete task'));
    expect(await screen.findByText('Completed Acknowledge the handbook.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employee-process-tasks/${K_ACK}/complete`)).toEqual([{ expectedVersion: 1 }]);
    await waitFor(() => expect(valueIn(ack, 'Completed')).toBe('26 Oct 2026 by You'));
  });
});

// =========================================================================================================
describe('the selected role assignment', () => {
  it('never shows what was loaded for one assignment under another', async () => {
    const client = testClient(Infinity);
    mockApi({ 'GET /v1/lifecycle-processes': () => [200, { items: session.assignmentId === ASSIGNMENT_A ? SUMMARIES : [SUMMARIES[0]] }] });
    const first = renderAt('/lifecycle/process-templates', hr([TEMPLATE_READ]), client);
    expect(await screen.findByRole('link', { name: 'ONBOARD_STD' })).toBeTruthy();
    first.unmount();
    const release = hold('GET /v1/lifecycle-processes');
    renderAt('/lifecycle/process-templates', hr([TEMPLATE_READ], { assignmentId: ASSIGNMENT_B }), client);
    await waitFor(() => expect(callsTo('GET', '/v1/lifecycle-processes')).toHaveLength(2));
    expect(screen.queryByRole('link', { name: 'ONBOARD_STD' })).toBeNull();
    release();
    expect(await screen.findByRole('link', { name: 'EXIT_STD' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'ONBOARD_STD' })).toBeNull();
  });

  it('says nothing is permitted, and asks no one to switch roles, only once the role context has loaded', async () => {
    mockApi({});
    const loading = <T extends Context>(ctx: T): T => ({ ...ctx, loaded: false });
    renderAt('/lifecycle/process-templates', loading(hr([TEMPLATE_READ])));
    expect(await screen.findByText('Loading your role…')).toBeTruthy();
    expect(screen.queryByText('The selected role cannot view process templates.')).toBeNull();
    cleanup();
    renderAt(`/lifecycle/exits/${X_ASHA}`, loading(hr([EXIT_READ])));
    expect(await screen.findByText('Loading your role…')).toBeTruthy();
    expect(screen.queryByText('The selected role cannot view exit cases.')).toBeNull();
    cleanup();
    // The ESS hub may show these panels before the role context arrives: the employee is not told to switch roles.
    renderPart(panelFor('RESIGNATION'), loading(asha([EXIT_SUBMIT, EXIT_READ])));
    expect(await screen.findByText('Loading your role…')).toBeTruthy();
    expect(screen.queryByText(/Switch to it/)).toBeNull();
    cleanup();
    renderPart(panelFor('MY_PROCESSES'), loading(asha([PROCESS_READ])));
    expect(await screen.findByText('Loading your role…')).toBeTruthy();
    expect(screen.queryByText(/Switch to it/)).toBeNull();
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe('exit decisions under owner delegation (I-81)', () => {
  const DOC = { id: 'd0000000-0000-4000-8000-000000000001', documentType: 'GENERAL', fileName: 'letter.pdf', uploadedAt: '2026-11-01T05:00:00.000Z', scanState: 'CLEAN', verificationState: 'VERIFIED' };

  it('FR-051 HR enters a resignation received outside the system with its reference and verified document', async () => {
    mockApi({
      [`GET /v1/employees/${E_ASHA}`]: [200, ASHA_HIT],
      [`GET /v1/employees/${E_ASHA}/processes`]: [200, { items: [] }],
      [`GET /v1/employees/${E_ASHA}/exit-cases`]: [200, { items: [] }],
      [`GET /v1/employees/${E_ASHA}/documents`]: [200, { items: [DOC] }],
      [`POST /v1/employees/${E_ASHA}/resignation`]: [201, { exitCaseId: X_ASHA, state: 'SUBMITTED', origin: 'HR' }],
    });
    renderAt(`/lifecycle/employees/${E_ASHA}`, hr([PROCESS_READ, EXIT_READ, EXIT_MANAGE, EMPLOYEE_READ, 'document.read.document']));
    const form = await screen.findByRole('form', { name: 'Enter a resignation' });
    // I-92: the other separation types have their own HR form beside it (separation-entry.test.tsx).
    expect(screen.getByRole('form', { name: 'Enter a separation' })).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Enter the resignation' }));
    expect(await within(form.closest('section') as HTMLElement).findByText(/Give the proposed last working date/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Proposed last working date'), { target: { value: '2026-12-31' } });
    fireEvent.change(within(form).getByLabelText('Reference of the resignation received'), { target: { value: 'Letter of 5 Nov (synthetic)' } });
    fireEvent.click(await within(form).findByRole('radio'));
    fireEvent.click(within(form).getByRole('button', { name: 'Enter the resignation' }));
    expect(await screen.findByText('The resignation is entered and waits for the manager’s recommendation.')).toBeTruthy();
    expect(bodiesTo('POST', `/v1/employees/${E_ASHA}/resignation`)).toEqual([{ proposedLastWorkingDate: '2026-12-31', evidenceReference: 'Letter of 5 Nov (synthetic)', evidenceDocumentIds: [DOC.id] }]);
  });

  it('FR-051 offers no HR entry without the exit management duty', async () => {
    mockApi({
      [`GET /v1/employees/${E_ASHA}`]: [200, ASHA_HIT],
      [`GET /v1/employees/${E_ASHA}/processes`]: [200, { items: [] }],
      [`GET /v1/employees/${E_ASHA}/exit-cases`]: [200, { items: [] }],
    });
    renderAt(`/lifecycle/employees/${E_ASHA}`, hr([PROCESS_READ, EXIT_READ, EMPLOYEE_READ]));
    expect(await screen.findByText('No processes for this employee yet.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Enter a resignation' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Enter a separation' })).toBeNull();
  });

  it('FR-051 shows who entered the resignation and lists what is kept after the last working date', async () => {
    mockApi({
      [`GET /v1/exit-cases/${X_ASHA}`]: [
        200,
        {
          ...approvedDetail({}, { ...approvedExit(), ...({ origin: 'HR', enteredBy: 'u-hr' } as object) } as ExitCase),
          afterLastWorkingDate: { treatment: 'KEPT', items: [{ kind: 'LEAVE_REQUEST', id: 'lr-1', startDate: '2026-12-22', endDate: '2026-12-23' }] },
        },
      ],
    });
    renderAt(`/lifecycle/exits/${X_ASHA}`, hr([EXIT_READ, PROCESS_READ]));
    const facts = await findSection('Exit');
    expect(valueIn(facts, 'Entered by')).toBe('HR, from a resignation given outside the system (with its evidence)');
    const kept = await findSection('Approved for days after the last working date');
    expect(kept.textContent).toContain('These are kept, not cancelled by the exit.');
    expect(kept.textContent).toContain('Leave: 22 Dec 2026 to 23 Dec 2026');
  });
});
