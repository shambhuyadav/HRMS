// Confirmation management screen (FR-080/FR-081/FR-082; DF11; DF02; C1; C4), jsdom: view tabs that request the chosen
// view with counts from the list, case history with confidential reasons only when the server returned them, the
// exact recommendation bodies (with the case version, also when retrying after a version conflict), opening a case
// from an employee search, DF11 exceptions (I-19: the exact proposal and decision bodies, the API's refusals in plain
// words, the pending queue where a proposer cannot decide their own proposal but can withdraw it, the new due date
// after an approved override), controls hidden without the permissions, and nothing cached for one role assignment
// shown under another. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONFIRMATION_SCREENS, ConfirmationPoliciesPage, ConfirmationsPage } from './confirmation';

// The selected company and role assignment, as the session stores them; tests switch the assignment to model a role
// switch. `userId` and `employeeId` are the signed-in user and their linked employee, as GET /v1/me/context returns them.
const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: '',
  userId: 'b0000000-0000-4000-8000-000000000001',
  employeeId: null as string | null,
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: session.userId,
      accountKey: 'syn.hr',
      companyName: 'Synthetic Co',
      roleCode: 'HR_ADMINISTRATOR',
      roleName: 'HR Administrator',
      scopeKind: 'COMPANY',
      employeeId: session.employeeId,
      displayName: 'Synthetic HR',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const READ = 'confirmation.read.operational';
const READ_REASON = 'confirmation.read.reason';
const MANAGE = 'confirmation.manage.operational';
const RECOMMEND = 'confirmation.recommend.operational';
const DECIDE = 'confirmation.decide.operational';
const PROPOSE = 'confirmation.propose_exception.operational';
const APPROVE_EXCEPTION = 'confirmation.approve_exception.operational';
const LIST_EMPLOYEES = 'employee.list.operational';
const MANAGE_POLICIES = 'confirmation_policy.manage.operational';

const C_UPCOMING = '10000000-0000-4000-8000-000000000001';
const C_DUE = '10000000-0000-4000-8000-000000000002';
const C_OVERDUE = '10000000-0000-4000-8000-000000000003';
const C_CONFIRMED = '10000000-0000-4000-8000-000000000004';
const C_LATER = '10000000-0000-4000-8000-000000000005';
const C_NEW = '10000000-0000-4000-8000-000000000006';
const E_NILA = '20000000-0000-4000-8000-000000000001';
const E_OM = '20000000-0000-4000-8000-000000000002';
const TASK = '30000000-0000-4000-8000-000000000001';
const X_ASHA_OVERRIDE = '40000000-0000-4000-8000-000000000001';
const X_ASHA_EXTRA = '40000000-0000-4000-8000-000000000002';
const X_MEERA_REJECTED = '40000000-0000-4000-8000-000000000003';
const X_MEERA_EXTRA = '40000000-0000-4000-8000-000000000004';
const X_NEW = '40000000-0000-4000-8000-000000000099';
const ASSIGNMENT_HR = 'a0000000-0000-4000-8000-000000000001';
const ASSIGNMENT_MANAGER = 'a0000000-0000-4000-8000-000000000002';
/** The signed-in HR user (as in the session mock) and another HR user. */
const U_ME = session.userId;
const U_OTHER = 'b0000000-0000-4000-8000-000000000002';

interface Case {
  id: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  startDate: string;
  initialDueDate: string;
  dueDate: string;
  extensionCount: number;
  actualConfirmationDate: string | null;
  state: string;
  lastOutcome: string | null;
  version: number;
  view: string;
  /** A live case extended at least once (the EXTENDED filter, I-36). */
  extended?: boolean;
}
interface Action {
  action: string;
  priorDueDate: string | null;
  newDueDate: string | null;
  actualConfirmationDate: string | null;
  reason?: string;
  occurredAt: string;
}

const kase = (id: string, employeeCode: string, employeeName: string, patch: Partial<Case>): Case => ({
  id,
  employeeId: `9${id.slice(1)}`,
  employeeCode,
  employeeName,
  startDate: '2026-05-01',
  initialDueDate: '2026-08-01',
  dueDate: '2026-08-01',
  extensionCount: 0,
  actualConfirmationDate: null,
  state: 'OPEN',
  lastOutcome: null,
  version: 1,
  view: 'UPCOMING',
  ...patch,
});

const CASES: Case[] = [
  kase(C_UPCOMING, 'SYN-101', 'Asha Synthetic', { startDate: '2026-08-03', initialDueDate: '2026-11-03', dueDate: '2026-11-03', version: 3, view: 'UPCOMING' }),
  kase(C_DUE, 'SYN-102', 'Ravi Synthetic', { startDate: '2026-07-25', initialDueDate: '2026-10-25', dueDate: '2026-10-25', state: 'REVIEW_PENDING', version: 2, view: 'DUE' }),
  kase(C_OVERDUE, 'SYN-103', 'Meera Synthetic', {
    startDate: '2026-04-30',
    initialDueDate: '2026-07-31',
    dueDate: '2026-08-31',
    extensionCount: 1,
    lastOutcome: 'RETURNED',
    version: 5,
    view: 'OVERDUE',
    extended: true,
  }),
  kase(C_CONFIRMED, 'SYN-104', 'Kiran Synthetic', {
    startDate: '2026-02-28',
    initialDueDate: '2026-05-31',
    dueDate: '2026-05-31',
    actualConfirmationDate: '2026-06-01',
    state: 'CONFIRMED',
    lastOutcome: 'CONFIRMED',
    version: 4,
    view: 'CONFIRMED',
  }),
  kase(C_LATER, 'SYN-105', 'Dev Synthetic', { startDate: '2026-10-15', initialDueDate: '2027-01-15', dueDate: '2027-01-15', view: 'LATER' }),
];

const MEERA_ACTIONS: Action[] = [
  { action: 'EXTENDED', priorDueDate: '2026-07-31', newDueDate: '2026-08-31', actualConfirmationDate: null, occurredAt: '2026-07-30T12:00:00.000Z' },
  { action: 'RETURNED', priorDueDate: '2026-08-31', newDueDate: '2026-08-31', actualConfirmationDate: null, occurredAt: '2026-08-28T12:00:00.000Z' },
];
const MEERA_REASONS = ['Needs one more month on the core project (synthetic)', 'Effective date missing from the evidence (synthetic)'];
const ACTIONS: Record<string, Action[]> = {
  [C_OVERDUE]: MEERA_ACTIONS,
  [C_CONFIRMED]: [{ action: 'CONFIRMED', priorDueDate: '2026-05-31', newDueDate: '2026-05-31', actualConfirmationDate: '2026-06-01', occurredAt: '2026-06-01T12:00:00.000Z' }],
};

const EMPLOYEES = [
  { id: E_NILA, employeeCode: 'SYN-201', displayName: 'Nila Synthetic', status: 'ACTIVE_PROBATION' },
  { id: E_OM, employeeCode: 'SYN-202', displayName: 'Om Synthetic', status: 'DRAFT' },
];

/** A DF11 exception as the mock server stores it; the reasons leave it only for a granted caller (`withReasons`). */
interface Exception {
  id: string;
  confirmationId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  kind: 'DUE_DATE_OVERRIDE' | 'EXTRA_EXTENSION';
  proposedDueDate: string | null;
  state: string;
  proposedBy: string;
  decidedBy: string | null;
  decidedAt: string | null;
  proposedAt: string;
  reason: string;
  decisionReason: string | null;
}

const PROPOSED_AT = '2026-10-20T09:15:00.000Z';
const DECIDED_AT = '2026-10-21T11:40:00.000Z';
const ASHA_REASON = 'Joined a long client engagement mid-probation (synthetic)';
const MEERA_REASON = 'Review panel unavailable until December (synthetic)';
const MEERA_DECISION = 'The current due date already allows the review (synthetic)';

const exception = (id: string, caseId: string, patch: Partial<Exception>): Exception => {
  const c = CASES.find((k) => k.id === caseId)!;
  return {
    id,
    confirmationId: c.id,
    employeeId: c.employeeId,
    employeeCode: c.employeeCode,
    employeeName: c.employeeName,
    kind: 'DUE_DATE_OVERRIDE',
    proposedDueDate: null,
    state: 'PROPOSED',
    proposedBy: U_OTHER,
    decidedBy: null,
    decidedAt: null,
    proposedAt: PROPOSED_AT,
    reason: 'Synthetic justification',
    decisionReason: null,
    ...patch,
  };
};

/** Waiting for a decision: proposed by another HR user, so the signed-in user may decide it. */
const ASHA_WAITING = () => exception(X_ASHA_OVERRIDE, C_UPCOMING, { proposedDueDate: '2026-12-15', reason: ASHA_REASON });
/** Waiting, proposed by the signed-in user. */
const ASHA_OWN_EXTRA = () => exception(X_ASHA_EXTRA, C_UPCOMING, { kind: 'EXTRA_EXTENSION', proposedBy: U_ME, proposedAt: '2026-10-22T08:05:00.000Z' });
const MEERA_REJECTED = () =>
  exception(X_MEERA_REJECTED, C_OVERDUE, {
    proposedDueDate: '2026-12-31',
    state: 'REJECTED',
    decidedBy: U_ME,
    decidedAt: DECIDED_AT,
    reason: MEERA_REASON,
    decisionReason: MEERA_DECISION,
  });
const MEERA_OWN_EXTRA = () => exception(X_MEERA_EXTRA, C_OVERDUE, { kind: 'EXTRA_EXTENSION', proposedBy: U_ME, proposedAt: '2026-10-22T08:05:00.000Z', reason: 'Synthetic own proposal' });

const NOT_FOUND = { error: 'NOT_FOUND', message: 'Resource not found' };
const INVALID_STATE = { error: 'INVALID_STATE', message: 'This exception has already been decided or withdrawn' };
const CASE_NOT_OPEN = { error: 'CASE_NOT_OPEN', message: 'The due date can change only while no recommendation is under review' };

/** An instant as the page shows it: the viewer's local date and time. */
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function localTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getDate()} ${MON[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}
type Reply = [status: number, body: unknown];
/**
 * A fixed reply, or a handler that sees the request and the mock's current cases (so it can change them); a handler
 * may also hold its reply back (return a promise) to keep a request in flight while the test acts.
 */
type Route = Reply | ((call: Call, cases: Case[]) => Reply | Promise<Reply>);

let calls: Call[] = [];
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const listViews = () => callsTo('GET', '/v1/confirmations').map((c) => c.params.get('view'));
const recommendations = (caseId: string) => callsTo('POST', `/v1/confirmations/${caseId}/recommendation`);
const proposals = (caseId: string) => callsTo('POST', `/v1/confirmations/${caseId}/exceptions`);
const decisions = (id: string) => callsTo('POST', `/v1/confirmation-exceptions/${id}/decision`);
const withdrawals = (id: string) => callsTo('POST', `/v1/confirmation-exceptions/${id}/withdraw`);
const pendingReads = () => callsTo('GET', '/v1/confirmation-exceptions/pending');

/** The mock server's exceptions (a test may change them as another user would), and whether it returns their reasons. */
let exceptions: Exception[] = [];
let withReasons = false;
/** Answers held back until the test releases them, by "METHOD /path". */
let holds = new Map<string, Promise<void>>();
/** Answers lost on the way back, by "METHOD /path": the server acts on the request, but the page never hears back. */
let lost = new Set<string>();
/** The idempotency keys of the decisions the mock server recorded (ZT07), as the API keeps them. */
let decisionKeys = new Map<string, { exceptionId: string; decidedBy: string; state: string }>();
const loseAnswer = (key: string) => lost.add(key);

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

/** An exception as the API lists it: the reasons only for a granted caller; the pending queue marks the caller's own. */
function listed(x: Exception, pending = false) {
  const { reason, decisionReason, ...rest } = x;
  return { ...rest, ...(withReasons ? { reason, decisionReason } : {}), ...(pending ? { ownProposal: x.proposedBy === session.userId } : {}) };
}

/**
 * A fetch stub over a small in-memory set of synthetic cases: "METHOD /path" overrides win; otherwise list, detail,
 * recommendation, employee search, case opening and the DF11 exceptions (propose, list, pending queue, decide,
 * withdraw) behave like the API. Every request is recorded in `calls`. Returns the cases, so a test can change them
 * the way another user's action would.
 */
function serve(overrides: Record<string, Route> = {}, seed: { exceptions?: Exception[]; withReasons?: boolean } = {}): Case[] {
  const cases = CASES.map((c) => ({ ...c }));
  exceptions = seed.exceptions ?? [];
  withReasons = seed.withReasons ?? false;
  holds = new Map();
  lost = new Set();
  decisionKeys = new Map();
  const routes: Record<string, Route> = {
    'GET /v1/confirmation-exceptions/pending': () => [200, { items: exceptions.filter((x) => x.state === 'PROPOSED').map((x) => listed(x, true)) }],
    'GET /v1/confirmations': (c) => {
      const view = c.params.get('view') ?? 'ALL';
      // EXTENDED is a filter of its own: extended live cases, which keep their date view (service.ts caseQuery).
      const items = view === 'ALL' ? cases : view === 'EXTENDED' ? cases.filter((k) => k.extended) : cases.filter((k) => k.view === view);
      return [200, { view, items, total: items.length }];
    },
    'GET /v1/confirmations/attention': [200, { items: [], total: 0, truncated: false }],
    'POST /v1/confirmations': (c) => {
      const employee = EMPLOYEES.find((e) => e.id === (c.body as { employeeId: string }).employeeId)!;
      cases.push(kase(C_NEW, employee.employeeCode, employee.displayName, { employeeId: employee.id, initialDueDate: '2027-01-31', dueDate: '2027-01-31', view: 'LATER' }));
      return [201, { caseId: C_NEW, dueDate: '2027-01-31' }];
    },
    'GET /v1/employees': (c) => {
      const search = (c.params.get('search') ?? '').toLowerCase();
      const status = c.params.get('status');
      const items = EMPLOYEES.filter(
        (e) => (!search || e.displayName.toLowerCase().includes(search) || e.employeeCode.toLowerCase().includes(search)) && (!status || e.status === status),
      );
      return [200, { items, total: items.length, page: 1, pageSize: 25 }];
    },
    ...overrides,
  };
  /** The DF11 exception routes, with the rules of apps/api/src/modules/confirmation/exceptions.ts that the tests rely on. */
  const exceptionRoute = (call: Call): Reply | null => {
    const onCase = /^\/v1\/confirmations\/([0-9a-f-]{36})\/exceptions$/.exec(call.path);
    if (onCase) {
      const kase = cases.find((k) => k.id === onCase[1]);
      if (!kase) return [404, NOT_FOUND];
      if (call.method === 'GET') return [200, { items: exceptions.filter((x) => x.confirmationId === kase.id).map((x) => listed(x)) }];
      const body = call.body as { kind: Exception['kind']; proposedDueDate?: string; reason: string };
      const id = `40000000-0000-4000-8000-1${String(exceptions.length).padStart(11, '0')}`;
      exceptions.push({
        id,
        confirmationId: kase.id,
        employeeId: kase.employeeId,
        employeeCode: kase.employeeCode,
        employeeName: kase.employeeName,
        kind: body.kind,
        proposedDueDate: body.proposedDueDate ?? null,
        state: 'PROPOSED',
        proposedBy: session.userId,
        decidedBy: null,
        decidedAt: null,
        proposedAt: '2026-10-25T10:00:00.000Z',
        reason: body.reason,
        decisionReason: null,
      });
      return [201, { exceptionId: id, state: 'PROPOSED' }];
    }
    const onException = /^\/v1\/confirmation-exceptions\/([0-9a-f-]{36})\/(decision|withdraw)$/.exec(call.path);
    if (!onException || call.method !== 'POST') return null;
    const x = exceptions.find((e) => e.id === onException[1]);
    if (!x) return [404, NOT_FOUND];
    if (onException[2] === 'withdraw') {
      if (x.proposedBy !== session.userId) return [404, NOT_FOUND];
      if (x.state !== 'PROPOSED') return [409, INVALID_STATE];
      x.state = 'WITHDRAWN';
      return [200, { exceptionId: x.id, state: 'WITHDRAWN' }];
    }
    const { decision, reason, idempotencyKey } = call.body as { decision: 'APPROVE' | 'REJECT'; reason: string; idempotencyKey?: string };
    // ZT07: a recorded key replays its decision without a second effect; another decision may not reuse it.
    const prior = idempotencyKey === undefined ? undefined : decisionKeys.get(idempotencyKey);
    if (prior) {
      if (prior.exceptionId !== x.id || prior.decidedBy !== session.userId) return [409, { error: 'IDEMPOTENCY_KEY_REUSED', message: 'This idempotency key was used for another decision' }];
      return [200, { exceptionId: x.id, state: prior.state, applied: null, replayed: true }];
    }
    if (x.state !== 'PROPOSED') return [409, INVALID_STATE];
    if (x.proposedBy === session.userId) return [403, { error: 'INDEPENDENT_APPROVER_REQUIRED', message: 'Another eligible HR user must decide your proposal' }];
    const kase = cases.find((k) => k.id === x.confirmationId)!;
    let applied: unknown = null;
    if (decision === 'APPROVE' && x.kind === 'DUE_DATE_OVERRIDE') {
      if (kase.state !== 'OPEN') return [409, CASE_NOT_OPEN];
      applied = { dueDate: { from: kase.dueDate, to: x.proposedDueDate } };
      kase.dueDate = x.proposedDueDate!;
      kase.version += 1;
    } else if (decision === 'APPROVE') {
      applied = { extensionLimit: { from: 2, to: 3 } };
    }
    Object.assign(x, { state: decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', decidedBy: session.userId, decidedAt: DECIDED_AT, decisionReason: reason });
    if (idempotencyKey !== undefined) decisionKeys.set(idempotencyKey, { exceptionId: x.id, decidedBy: session.userId, state: x.state });
    return [200, { exceptionId: x.id, state: x.state, applied, replayed: false }];
  };
  const dynamic = (call: Call): Reply => {
    const forException = exceptionRoute(call);
    if (forException) return forException;
    const detail = /^\/v1\/confirmations\/([0-9a-f-]{36})$/.exec(call.path);
    const target = cases.find((k) => k.id === (detail?.[1] ?? /^\/v1\/confirmations\/([0-9a-f-]{36})\/recommendation$/.exec(call.path)?.[1]));
    if (target && detail && call.method === 'GET') return [200, { ...target, actions: ACTIONS[target.id] ?? [] }];
    if (target && !detail && call.method === 'POST') {
      target.state = 'REVIEW_PENDING';
      target.version += 1;
      return [200, { caseId: target.id, taskId: TASK, state: 'REVIEW_PENDING' }];
    }
    return [404, { error: 'NOT_FOUND', message: `No mock for ${call.method} ${call.path}` }];
  };
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const held = holds.get(`${call.method} ${call.path}`);
      if (held) await held;
      const route = routes[`${call.method} ${call.path}`];
      const [status, body]: Reply = route === undefined ? dynamic(call) : typeof route === 'function' ? await route(call, cases) : route;
      // The request was acted on; its answer is lost, as when the connection drops on the way back.
      if (lost.delete(`${call.method} ${call.path}`)) throw new TypeError('Failed to fetch');
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return cases;
}

const detailOf = (id: string, actions: Action[]) => ({ ...CASES.find((c) => c.id === id)!, actions });
const STALE = { error: 'STALE_VERSION', message: 'The record changed; reload and retry' };

const testClient = (staleTime = 0) => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime }, mutations: { retry: false } } });

function renderPage(permissions: string[], entry = '/confirmations', options: { client?: QueryClient; assignmentId?: string; employeeId?: string } = {}) {
  session.permissions = permissions;
  session.assignmentId = options.assignmentId ?? ASSIGNMENT_HR;
  session.employeeId = options.employeeId ?? null;
  const client = options.client ?? testClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[entry]}>
        <ConfirmationsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((c) => c.textContent?.trim());
const rowWith = (scope: HTMLElement, text: string) => within(scope).getByText(text).closest('tr') as HTMLElement;
const caseRegion = (name: string) => screen.findByRole('region', { name: `Confirmation case: ${name}` });
const findSection = async (heading: string) => (await screen.findByRole('heading', { name: heading })).closest('section') as HTMLElement;
const headers = (table: HTMLElement) => within(table).getAllByRole('columnheader').map((h) => h.textContent);
const exceptionTable = (panel: HTMLElement) => within(panel).findByRole('table', { name: 'Exceptions' });
const dueDateIn = (panel: HTMLElement) => within(panel).getByText('Current due date').nextElementSibling!.textContent;
const pendingItem = async (name: string) => within(await findSection('Pending exceptions')).findByRole('listitem', { name });

/** Lets any request a click might have started reach the fetch stub before asserting that none was made. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));

async function openCase(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `View case of ${name}` }));
  return caseRegion(name);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('confirmation views (FR-082)', () => {
  it('exports the view on screen with its own right, and offers nothing without it (FR-093)', async () => {
    serve({ 'POST /v1/reports': [202, { id: 'r-1', state: 'QUEUED' }] });
    renderPage([READ], '/confirmations?view=OVERDUE');
    await screen.findByRole('tablist', { name: 'Confirmation views' });
    expect(screen.queryByRole('button', { name: 'Export this view' })).toBeNull();
    cleanup();

    serve({ 'POST /v1/reports': [202, { id: 'r-1', state: 'QUEUED' }] });
    renderPage([READ, 'confirmation.export.operational'], '/confirmations?view=OVERDUE');
    fireEvent.click(await screen.findByRole('button', { name: 'Export this view' }));
    await screen.findByText('Export requested. Download it from Reports when it is ready.');
    expect(calls.find((c) => c.method === 'POST' && c.path === '/v1/reports')?.body).toEqual({ reportCode: 'CONFIRMATION_DUE', filters: { view: 'OVERDUE' } });
  });

  it('shows the view tabs with counts from the list and requests the chosen view', async () => {
    serve();
    renderPage([READ]);
    const tablist = await screen.findByRole('tablist', { name: 'Confirmation views' });
    await waitFor(() =>
      expect(within(tablist).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Upcoming (1)', 'Due (1)', 'Overdue (1)', 'Extended (1)', 'Confirmed (1)', 'All (5)']),
    );
    expect(screen.getByRole('tab', { selected: true }).textContent).toBe('All (5)');
    // The All tab and the counts share one request.
    expect(listViews()).toEqual(['ALL']);
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getAllByRole('row')).toHaveLength(6);
    expect(within(panel).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Employee',
      'Start',
      'Initial due',
      'Current due',
      'Extensions',
      'State',
      'Last outcome',
      'Case',
    ]);
    // On All, the server-derived timing of running cases is shown next to the current due date.
    expect(cells(rowWith(panel, 'Meera Synthetic'))).toEqual(['Meera Synthetic SYN-103', '30 Apr 2026', '31 Jul 2026', '31 Aug 2026 overdue', '1', 'open', 'Recommendation returned', 'View case']);
    expect(cells(rowWith(panel, 'Dev Synthetic'))[3]).toBe('15 Jan 2027 later');

    for (const [label, view, name] of [
      ['Overdue (1)', 'OVERDUE', 'Meera Synthetic'],
      ['Upcoming (1)', 'UPCOMING', 'Asha Synthetic'],
      ['Due (1)', 'DUE', 'Ravi Synthetic'],
      ['Confirmed (1)', 'CONFIRMED', 'Kiran Synthetic'],
    ] as const) {
      fireEvent.click(screen.getByRole('tab', { name: label }));
      await waitFor(() => expect(listViews().at(-1)).toBe(view));
      expect(screen.getByRole('tab', { name: label }).getAttribute('aria-selected')).toBe('true');
      const rows = await waitFor(() => {
        const r = within(screen.getByRole('tabpanel')).getAllByRole('row');
        expect(r).toHaveLength(2);
        return r;
      });
      expect(within(rows[1]!).getByText(name)).toBeTruthy();
    }
    expect(cells(rowWith(screen.getByRole('tabpanel'), 'Kiran Synthetic'))).toEqual([
      'Kiran Synthetic SYN-104',
      '28 Feb 2026',
      '31 May 2026',
      '31 May 2026',
      '0',
      'confirmed',
      'Confirmed',
      'View case',
    ]);
  });

  it('moves between the tabs with the arrow keys', async () => {
    serve();
    renderPage([READ]);
    const all = await screen.findByRole('tab', { name: /^All/ });
    all.focus();
    fireEvent.keyDown(all, { key: 'ArrowRight' });
    await waitFor(() => expect(listViews().at(-1)).toBe('UPCOMING'));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^Upcoming/ }));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    await waitFor(() => expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/^All/));
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: /^All/ }));
  });

  it('opens the view and the case named in the address', async () => {
    serve();
    renderPage([READ], `/confirmations?view=OVERDUE&case=${C_OVERDUE}`);
    const panel = await caseRegion('Meera Synthetic (SYN-103)');
    expect(listViews()).toContain('OVERDUE');
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/^Overdue/);
    // A deep link does not move focus; only picking a case does.
    expect(document.activeElement).not.toBe(panel);
    // Closing returns focus to the case's row in the list.
    await screen.findByRole('button', { name: 'View case of Meera Synthetic (SYN-103)' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /Confirmation case/ })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View case of Meera Synthetic (SYN-103)' }));
    cleanup();

    // A case the chosen view does not list: closing it puts focus on the page heading, not on the document.
    serve();
    renderPage([READ], `/confirmations?view=OVERDUE&case=${C_UPCOMING}`);
    const other = await caseRegion('Asha Synthetic (SYN-101)');
    await waitFor(() => expect(within(screen.getByRole('tabpanel')).getAllByRole('row')).toHaveLength(2));
    fireEvent.click(within(other).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /Confirmation case/ })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 1, name: 'Confirmations' }));
  });

  it('tells an empty view apart from a role that may not view cases', async () => {
    serve({ 'GET /v1/confirmations': [200, { view: 'ALL', items: [], total: 0 }] });
    renderPage([READ]);
    expect(await screen.findByText('No confirmation cases in the selected role’s scope yet.')).toBeTruthy();
    expect(screen.queryByText(/not permitted/i)).toBeNull();
    cleanup();

    serve({ 'GET /v1/confirmations': [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    renderPage([READ]);
    expect(await screen.findByText(/cannot view confirmation cases/)).toBeTruthy();
    expect(screen.queryByText(/No confirmation cases/)).toBeNull();
    cleanup();

    serve();
    renderPage([]);
    expect(screen.getByText(/cannot view confirmation cases/)).toBeTruthy();
    expect(screen.queryByRole('tablist')).toBeNull();
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('the Extended view lists the live cases extended at least once, each with its own date view (I-36)', async () => {
    serve();
    renderPage([READ], '/confirmations?view=EXTENDED');
    await waitFor(() => expect(listViews()).toContain('EXTENDED'));
    expect(screen.getByRole('tab', { selected: true }).textContent).toMatch(/^Extended/);
    const panel = screen.getByRole('tabpanel');
    const rows = await waitFor(() => {
      const r = within(panel).getAllByRole('row');
      expect(r).toHaveLength(2);
      return r;
    });
    // The extended case keeps its date view, shown next to its due date.
    expect(cells(rows[1]!)).toEqual(['Meera Synthetic SYN-103', '30 Apr 2026', '31 Jul 2026', '31 Aug 2026 overdue', '1', 'open', 'Recommendation returned', 'View case']);
    // The count comes from the All list's extended flags, not from a second request.
    expect(screen.getByRole('tab', { name: 'Extended (1)' })).toBeTruthy();
    cleanup();

    serve({ 'GET /v1/confirmations': (c) => [200, { view: c.params.get('view'), items: c.params.get('view') === 'ALL' ? CASES.filter((k) => !k.extended) : [], total: 0 }] });
    renderPage([READ], '/confirmations?view=EXTENDED');
    expect(await screen.findByText('No case still open or under review has been extended.')).toBeTruthy();
  });
});

describe('attention list (FR-082, DF11, I-36)', () => {
  const NO_POLICY = '90000000-0000-4000-8000-000000000101';
  const AMBIGUOUS = '90000000-0000-4000-8000-000000000102';
  const NOT_OPENED = '90000000-0000-4000-8000-000000000103';
  const ATTENTION = {
    items: [
      { employeeId: NO_POLICY, employeeCode: 'SYN-301', employeeName: 'Tara Synthetic', joiningDate: '1999-06-01', caseId: null, state: null, issues: ['POLICY_NOT_FOUND'] },
      { employeeId: AMBIGUOUS, employeeCode: 'SYN-302', employeeName: 'Uma Synthetic', joiningDate: '2026-06-01', caseId: null, state: null, issues: ['POLICY_AMBIGUOUS'] },
      { employeeId: NOT_OPENED, employeeCode: 'SYN-303', employeeName: 'Vik Synthetic', joiningDate: '2026-06-02', caseId: null, state: null, issues: ['CASE_NOT_OPENED'] },
      {
        employeeId: CASES[0]!.employeeId,
        employeeCode: 'SYN-101',
        employeeName: 'Asha Synthetic',
        joiningDate: '2026-08-03',
        caseId: C_UPCOMING,
        state: 'OPEN',
        issues: ['MANAGER_MISSING', 'REVIEWER_MISSING'],
      },
    ],
    total: 4,
    truncated: false,
  };
  const attentionRow = (table: HTMLElement, name: string) => rowWith(table, name);

  it('reports each issue in plain words for HR review, changes nothing, and links an open case to its panel', async () => {
    serve({ 'GET /v1/confirmations/attention': [200, ATTENTION] });
    renderPage([READ, MANAGE]);
    const table = await screen.findByRole('table', { name: 'Needs HR attention' });
    expect(headers(table)).toEqual(['Employee', 'Joined', 'Case', 'What needs attention']);
    expect(attentionRow(table, 'Tara Synthetic').textContent).toContain('No confirmation policy applies on the employee’s start date, so no case can be opened.');
    expect(attentionRow(table, 'Tara Synthetic').textContent).toContain('No case');
    expect(attentionRow(table, 'Uma Synthetic').textContent).toContain('More than one confirmation policy applies equally');
    expect(attentionRow(table, 'Uma Synthetic').textContent).toContain('none is picked automatically');
    expect(attentionRow(table, 'Vik Synthetic').textContent).toContain('no case has been opened yet');
    const asha = attentionRow(table, 'Asha Synthetic');
    expect(within(asha).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'The case has no current direct manager to make the recommendation. MANAGER_MISSING',
      'No eligible HR reviewer is available on the confirmation review route, so the manager’s recommendation would be refused. REVIEWER_MISSING',
    ]);
    expect(within(asha).getByText('open')).toBeTruthy();
    // Reading the list sends nothing else.
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(screen.queryByText(/stopped before every employee/)).toBeNull();

    fireEvent.click(within(asha).getByRole('button', { name: 'View case of Asha Synthetic (SYN-101) from the attention list' }));
    expect(await caseRegion('Asha Synthetic (SYN-101)')).toBeTruthy();
  });

  it('is shown only with the HR manage duty, without case links for a role that cannot read cases', async () => {
    serve({ 'GET /v1/confirmations/attention': [200, ATTENTION] });
    renderPage([READ, RECOMMEND, DECIDE]);
    expect(await screen.findByRole('tablist', { name: 'Confirmation views' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Needs HR attention' })).toBeNull();
    await settle();
    expect(callsTo('GET', '/v1/confirmations/attention')).toHaveLength(0);
    cleanup();

    serve({ 'GET /v1/confirmations/attention': [200, ATTENTION] });
    renderPage([MANAGE]);
    const table = await screen.findByRole('table', { name: 'Needs HR attention' });
    expect(within(table).queryByRole('button')).toBeNull();
  });

  it('tells "nothing needs attention" apart from a refusal, and says when the check stopped early', async () => {
    serve();
    renderPage([MANAGE]);
    expect(await screen.findByText('No employee on probation in the selected role’s scope needs attention.')).toBeTruthy();
    cleanup();

    serve({ 'GET /v1/confirmations/attention': [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    renderPage([MANAGE]);
    expect(await screen.findByText(/cannot see the attention list/)).toBeTruthy();
    expect(screen.queryByText(/needs attention\./)).toBeNull();
    cleanup();

    serve({ 'GET /v1/confirmations/attention': [200, { ...ATTENTION, truncated: true }] });
    renderPage([MANAGE]);
    expect(await screen.findByText(/stopped before every employee on probation was examined/)).toBeTruthy();
  });

  it('reads the list again after HR opens a case', async () => {
    serve({ 'GET /v1/confirmations/attention': [200, ATTENTION] });
    renderPage([READ, MANAGE, LIST_EMPLOYEES]);
    await screen.findByRole('table', { name: 'Needs HR attention' });
    expect(callsTo('GET', '/v1/confirmations/attention')).toHaveLength(1);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'Nila' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Open case for Nila Synthetic (SYN-201)' }));
    await waitFor(() => expect(callsTo('GET', '/v1/confirmations/attention')).toHaveLength(2));
  });
});

describe('case detail and history (FR-081, CI17, DF02/DF11)', () => {
  it('shows the history without reasons when the server withholds them, and nothing hints at them', async () => {
    // The answer decides, not the permission list: a role that lists confirmation.read.reason still sees no Reason
    // column (and no placeholder) when the server returned no reasons.
    for (const permissions of [[READ], [READ, READ_REASON]]) {
      serve();
      renderPage(permissions);
      const panel = await openCase('Meera Synthetic (SYN-103)');
      expect(document.activeElement).toBe(panel);
      const history = within(panel).getByRole('table');
      expect(within(history).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Action', 'Prior due date', 'New due date', 'Actual confirmation date', 'Occurred at']);
      const [, extended, returned] = within(history).getAllByRole('row');
      expect(cells(extended!)).toHaveLength(5);
      expect(cells(extended!).slice(0, 4)).toEqual(['Probation extended', '31 Jul 2026', '31 Aug 2026', '—']);
      expect(cells(returned!).slice(0, 4)).toEqual(['Recommendation returned', '31 Aug 2026', '31 Aug 2026', '—']);
      expect(extended!.querySelector('time')!.getAttribute('datetime')).toBe('2026-07-30T12:00:00.000Z');
      expect(within(panel).queryByText(/reason/i)).toBeNull();
      expect(panel.textContent).not.toMatch(/hidden|withheld|restricted|redacted|confidential|\*\*\*/i);
      expect(within(panel).getByText('Initial due date').nextElementSibling!.textContent).toBe('31 Jul 2026');
      expect(within(panel).getByText('Extensions').nextElementSibling!.textContent).toBe('1');
      expect(callsTo('GET', `/v1/confirmations/${C_OVERDUE}`)).toHaveLength(1);
      cleanup();
    }
  });

  it('shows the reasons only when the server returned them', async () => {
    serve({ [`GET /v1/confirmations/${C_OVERDUE}`]: [200, detailOf(C_OVERDUE, MEERA_ACTIONS.map((a, i) => ({ ...a, reason: MEERA_REASONS[i]! })))] });
    renderPage([READ, READ_REASON]);
    const panel = await openCase('Meera Synthetic (SYN-103)');
    const history = within(panel).getByRole('table');
    expect(within(history).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Action',
      'Prior due date',
      'New due date',
      'Actual confirmation date',
      'Occurred at',
      'Reason',
    ]);
    const [, extended, returned] = within(history).getAllByRole('row');
    expect(cells(extended!).at(-1)).toBe(MEERA_REASONS[0]);
    expect(cells(returned!).at(-1)).toBe(MEERA_REASONS[1]);
  });

  it('shows the actual confirmation date of a confirmed case', async () => {
    serve();
    renderPage([READ]);
    const panel = await openCase('Kiran Synthetic (SYN-104)');
    const [, confirmed] = within(within(panel).getByRole('table')).getAllByRole('row');
    expect(cells(confirmed!).slice(0, 4)).toEqual(['Confirmed', '31 May 2026', '31 May 2026', '1 Jun 2026']);
    expect(within(panel).getByText('Actual confirmation date', { selector: 'dt' }).nextElementSibling!.textContent).toBe('1 Jun 2026');
    fireEvent.click(within(panel).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: /Confirmation case/ })).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'View case of Kiran Synthetic (SYN-104)' }));
  });
});

describe('recommendation (FR-081, DF11)', () => {
  it('sends exactly the CONFIRM body with the case version, after the required fields are filled', async () => {
    serve();
    renderPage([READ, RECOMMEND]);
    const panel = await openCase('Asha Synthetic (SYN-101)');
    expect(within(panel).getByText('No decisions recorded yet.')).toBeTruthy();
    const form = within(panel).getByRole('form', { name: 'Your recommendation' });
    const send = within(form).getByRole('button', { name: 'Send recommendation' });

    // Simple required-field checks only: the browser's own validation, and a reason that is not just spaces.
    expect((form as HTMLFormElement).checkValidity()).toBe(false);
    fireEvent.click(send);
    await settle();
    expect(recommendations(C_UPCOMING)).toHaveLength(0);

    fireEvent.click(within(form).getByLabelText('Confirm'));
    fireEvent.change(within(form).getByLabelText('Effective date'), { target: { value: '2026-10-20' } });
    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: '   ' } });
    fireEvent.click(send);
    expect(await within(form).findByText('Enter a reason.')).toBeTruthy();
    await settle();
    expect(recommendations(C_UPCOMING)).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: 'Meets every probation goal (synthetic)' } });
    send.focus(); // as a keyboard user would
    fireEvent.click(send);
    await waitFor(() => expect(recommendations(C_UPCOMING)).toHaveLength(1));
    expect(recommendations(C_UPCOMING)[0]!.body).toEqual({
      expectedVersion: 3,
      recommendation: 'CONFIRM',
      effectiveDate: '2026-10-20',
      reason: 'Meets every probation goal (synthetic)',
    });

    expect(await within(panel).findByText('Recommendation sent for HR review.')).toBeTruthy();
    await waitFor(() => expect(within(panel).queryByRole('form')).toBeNull());
    expect(within(panel).getByText(/waiting for an HR decision/)).toBeTruthy();
    expect(callsTo('GET', `/v1/confirmations/${C_UPCOMING}`).length).toBeGreaterThan(1);
    // The form and its focused button went away; focus stays in the case panel instead of falling to the page.
    expect(document.activeElement).toBe(panel);
  });

  it('offers the form again once the case is back to OPEN, without the earlier sent message', async () => {
    const client = testClient();
    const cases = serve();
    renderPage([READ, RECOMMEND], '/confirmations', { client });
    const panel = await openCase('Asha Synthetic (SYN-101)');
    const form = within(panel).getByRole('form', { name: 'Your recommendation' });
    fireEvent.click(within(form).getByLabelText('Extend probation'));
    fireEvent.change(within(form).getByLabelText('Extend by (months)'), { target: { value: '3' } });
    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: 'Synthetic extension' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send recommendation' }));
    expect(await within(panel).findByText('Recommendation sent for HR review.')).toBeTruthy();
    await waitFor(() => expect(within(panel).getByText(/waiting for an HR decision/)).toBeTruthy());

    // An HR reviewer returns the recommendation in the Decision inbox (the server bumps the version again).
    const asha = cases.find((c) => c.id === C_UPCOMING)!;
    Object.assign(asha, { state: 'OPEN', lastOutcome: 'RETURNED', version: asha.version + 1 });
    await act(() => client.invalidateQueries());

    const again = await within(panel).findByRole('form', { name: 'Your recommendation' });
    expect(within(panel).queryByText('Recommendation sent for HR review.')).toBeNull();
    // A fresh form: nothing typed for the earlier recommendation is carried over.
    expect((within(again).getByLabelText('Reason (required)') as HTMLTextAreaElement).value).toBe('');
    expect(within(again).queryByLabelText('Extend by (months)')).toBeNull();
  });

  it('sends exactly the EXTEND body with the case version and no confirmation date', async () => {
    serve();
    renderPage([READ, RECOMMEND]);
    const panel = await openCase('Asha Synthetic (SYN-101)');
    const form = within(panel).getByRole('form', { name: 'Your recommendation' });
    fireEvent.click(within(form).getByLabelText('Confirm'));
    fireEvent.change(within(form).getByLabelText('Effective date'), { target: { value: '2026-10-20' } });
    fireEvent.click(within(form).getByLabelText('Extend probation'));
    expect(within(form).queryByLabelText('Effective date')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Extend by (months)'), { target: { value: '2' } });
    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: 'Needs more time on the core project (synthetic)' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send recommendation' }));
    await waitFor(() => expect(recommendations(C_UPCOMING)).toHaveLength(1));
    expect(recommendations(C_UPCOMING)[0]!.body).toEqual({
      expectedVersion: 3,
      recommendation: 'EXTEND',
      extensionMonths: 2,
      reason: 'Needs more time on the core project (synthetic)',
    });
  });

  it('shows the server’s refusal, and reloads the case after a version conflict', async () => {
    serve({
      [`POST /v1/confirmations/${C_UPCOMING}/recommendation`]: [
        422,
        { error: 'EXTENSION_LIMIT_REACHED', message: 'The maximum number of extensions has been reached; an exception approval is required' },
      ],
    });
    renderPage([READ, RECOMMEND]);
    let panel = await openCase('Asha Synthetic (SYN-101)');
    let form = within(panel).getByRole('form', { name: 'Your recommendation' });
    fireEvent.click(within(form).getByLabelText('Extend probation'));
    fireEvent.change(within(form).getByLabelText('Extend by (months)'), { target: { value: '1' } });
    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: 'Synthetic extension' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Send recommendation' }));
    expect((await within(panel).findByRole('alert')).textContent).toContain('(EXTENSION_LIMIT_REACHED)');
    expect(within(panel).getByRole('form', { name: 'Your recommendation' })).toBeTruthy();
    cleanup();

    // The case changed after it was loaded (version 3 -> 4): the first send is refused, the case reloads, the entries
    // are kept, and sending again carries the reloaded version. The reload is held back so the test can try to send
    // while it is still in flight.
    const reload = { release: () => {} };
    serve({
      [`GET /v1/confirmations/${C_UPCOMING}`]: async (_call, cases) => {
        // Only the reload after the conflict (the second read) is held.
        if (callsTo('GET', `/v1/confirmations/${C_UPCOMING}`).length === 2) await new Promise<void>((resolve) => (reload.release = resolve));
        return [200, { ...cases.find((c) => c.id === C_UPCOMING)!, actions: [] }];
      },
      [`POST /v1/confirmations/${C_UPCOMING}/recommendation`]: (call, cases) => {
        const asha = cases.find((c) => c.id === C_UPCOMING)!;
        if (recommendations(C_UPCOMING).length === 1) asha.version = 4;
        if ((call.body as { expectedVersion: number }).expectedVersion !== asha.version) return [409, STALE];
        Object.assign(asha, { state: 'REVIEW_PENDING', version: asha.version + 1 });
        return [200, { caseId: C_UPCOMING, taskId: TASK, state: 'REVIEW_PENDING' }];
      },
    });
    renderPage([READ, RECOMMEND]);
    panel = await openCase('Asha Synthetic (SYN-101)');
    form = within(panel).getByRole('form', { name: 'Your recommendation' });
    fireEvent.click(within(form).getByLabelText('Confirm'));
    fireEvent.change(within(form).getByLabelText('Effective date'), { target: { value: '2026-10-20' } });
    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: 'Synthetic confirmation' } });
    const send = within(form).getByRole('button', { name: 'Send recommendation' }) as HTMLButtonElement;
    fireEvent.click(send);
    expect((await within(panel).findByRole('alert')).textContent).toContain('(STALE_VERSION)');
    await waitFor(() => expect(callsTo('GET', `/v1/confirmations/${C_UPCOMING}`)).toHaveLength(2));

    // While the reload is in flight nothing can be sent: it would repeat the stale version.
    expect(await within(panel).findByText('Reloading the case…')).toBeTruthy();
    expect(send.disabled).toBe(true);
    fireEvent.click(send);
    fireEvent.submit(form);
    await settle();
    expect(recommendations(C_UPCOMING)).toHaveLength(1);

    await act(async () => reload.release());
    await waitFor(() => expect(send.disabled).toBe(false));
    expect(within(panel).getByText(/case has been reloaded/)).toBeTruthy();
    expect((within(form).getByLabelText('Reason (required)') as HTMLTextAreaElement).value).toBe('Synthetic confirmation');
    fireEvent.click(send);
    expect(await within(panel).findByText('Recommendation sent for HR review.')).toBeTruthy();
    expect(recommendations(C_UPCOMING).map((c) => c.body)).toEqual([
      { expectedVersion: 3, recommendation: 'CONFIRM', effectiveDate: '2026-10-20', reason: 'Synthetic confirmation' },
      { expectedVersion: 4, recommendation: 'CONFIRM', effectiveDate: '2026-10-20', reason: 'Synthetic confirmation' },
    ]);
    expect(within(panel).queryByRole('alert')).toBeNull();
  });
});

describe('controls follow the selected assignment (C1)', () => {
  it('hides the recommendation, case opening and decision links without the permissions', async () => {
    serve();
    renderPage([READ]);
    const panel = await openCase('Asha Synthetic (SYN-101)');
    expect(within(panel).getByText(/Waiting for a recommendation from the employee/)).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Send recommendation' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Open a confirmation case' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Decision inbox' })).toBeNull();
    expect(callsTo('GET', '/v1/employees')).toHaveLength(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('offers the recommendation only on an open case', async () => {
    serve();
    renderPage([READ, RECOMMEND]);
    for (const name of ['Ravi Synthetic (SYN-102)', 'Kiran Synthetic (SYN-104)']) {
      const panel = await openCase(name);
      expect(within(panel).queryByRole('form')).toBeNull();
    }
    expect(within(await openCase('Meera Synthetic (SYN-103)')).getByRole('form', { name: 'Your recommendation' })).toBeTruthy();
  });

  it('points deciders to the Decision inbox instead of deciding here', async () => {
    serve();
    renderPage([READ, DECIDE]);
    const links = await screen.findAllByRole('link', { name: 'Decision inbox' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual(['/tasks']);
    const panel = await openCase('Ravi Synthetic (SYN-102)');
    expect(within(panel).getByText(/waiting for an HR decision/)).toBeTruthy();
    expect(within(panel).getByRole('link', { name: 'Decision inbox' }).getAttribute('href')).toBe('/tasks');
    expect(screen.queryByRole('button', { name: /^(Approve|Reject|Return)$/ })).toBeNull();
  });
});

describe('opening a case (FR-080)', () => {
  it('finds an employee on probation and opens a case with exactly the employee id', async () => {
    serve();
    renderPage([READ, MANAGE, LIST_EMPLOYEES]);
    const section = await findSection('Open a confirmation case');
    await settle();
    expect(callsTo('GET', '/v1/employees')).toHaveLength(0); // nothing is searched before the user types
    fireEvent.change(within(section).getByLabelText('Find employee'), { target: { value: ' Synthetic ' } });
    const open = await within(section).findByRole('button', { name: 'Open case for Nila Synthetic (SYN-201)' });
    expect(Object.fromEntries(callsTo('GET', '/v1/employees').at(-1)!.params)).toEqual({ search: 'Synthetic', page: '1', pageSize: '25', status: 'ACTIVE_PROBATION' });
    expect(within(section).queryByText('Om Synthetic')).toBeNull();

    fireEvent.click(open);
    await waitFor(() => expect(callsTo('POST', '/v1/confirmations')).toHaveLength(1));
    expect(callsTo('POST', '/v1/confirmations')[0]!.body).toEqual({ employeeId: E_NILA });
    expect(await within(section).findByText('Case opened for Nila Synthetic (SYN-201); planned due date 31 Jan 2027.')).toBeTruthy();
    // The new case is shown and the list reloads with it.
    expect(await caseRegion('Nila Synthetic (SYN-201)')).toBeTruthy();
    await waitFor(() => expect(listViews()).toEqual(['ALL', 'ALL']));
    expect(within(screen.getByRole('tabpanel')).getByText('Nila Synthetic')).toBeTruthy();

    // Unticking the probation filter searches everyone; the server still decides who can have a case.
    fireEvent.click(within(section).getByLabelText('Only employees on probation'));
    expect(await within(section).findByText('Om Synthetic')).toBeTruthy();
    expect(callsTo('GET', '/v1/employees').at(-1)!.params.has('status')).toBe(false);
  });

  it('shows the server’s refusal when a live case already exists', async () => {
    serve({ 'POST /v1/confirmations': [409, { error: 'DUPLICATE', message: 'A record with the same unique value already exists' }] });
    renderPage([READ, MANAGE, LIST_EMPLOYEES]);
    const section = await findSection('Open a confirmation case');
    fireEvent.change(within(section).getByLabelText('Find employee'), { target: { value: 'SYN-201' } });
    fireEvent.click(await within(section).findByRole('button', { name: 'Open case for Nila Synthetic (SYN-201)' }));
    expect((await within(section).findByRole('alert')).textContent).toContain('(DUPLICATE)');
    expect(within(section).getByText(/already has an open or pending confirmation case; find it in the list above/)).toBeTruthy();
    expect(within(section).queryByText(/Case opened/)).toBeNull();
    cleanup();

    // A role that may open cases but not read them has no list to point to.
    serve({ 'POST /v1/confirmations': [409, { error: 'DUPLICATE', message: 'A record with the same unique value already exists' }] });
    renderPage([MANAGE, LIST_EMPLOYEES]);
    const only = await findSection('Open a confirmation case');
    fireEvent.change(within(only).getByLabelText('Find employee'), { target: { value: 'SYN-201' } });
    fireEvent.click(await within(only).findByRole('button', { name: 'Open case for Nila Synthetic (SYN-201)' }));
    expect((await within(only).findByRole('alert')).textContent).toContain('(DUPLICATE)');
    expect(within(only).getByText(/already has an open or pending confirmation case/).textContent).not.toMatch(/list/);
    expect(callsTo('GET', '/v1/confirmations')).toHaveLength(0);
  });

  it('tells "no match" apart from a role that cannot search employees', async () => {
    serve();
    renderPage([READ, MANAGE, LIST_EMPLOYEES]);
    let section = await findSection('Open a confirmation case');
    fireEvent.change(within(section).getByLabelText('Find employee'), { target: { value: 'nobody' } });
    expect(await within(section).findByText('No employees on probation match “nobody”.')).toBeTruthy();
    expect(within(section).queryByText(/not permitted/i)).toBeNull();
    cleanup();

    serve();
    renderPage([READ, MANAGE]);
    section = await findSection('Open a confirmation case');
    expect(within(section).getByText(/cannot search employees/)).toBeTruthy();
    expect(within(section).queryByLabelText('Find employee')).toBeNull();
    expect(callsTo('GET', '/v1/employees')).toHaveLength(0);
  });
});

describe('exceptions on a case (DF11, I-19)', () => {
  it('shows the case’s exceptions without reasons when the server withholds them, and nothing hints at them', async () => {
    // As for the decision history, the answer decides: the role lists confirmation.read.reason, the server withheld them.
    serve({}, { exceptions: [MEERA_REJECTED(), MEERA_OWN_EXTRA()] });
    renderPage([READ, READ_REASON]);
    const panel = await openCase('Meera Synthetic (SYN-103)');
    const table = await exceptionTable(panel);
    expect(headers(table)).toEqual(['Exception', 'Proposed due date', 'State', 'Proposed at', 'Decided at']);
    const [, rejected, waiting] = within(table).getAllByRole('row');
    expect(cells(rejected!)).toEqual(['Due date override', '31 Dec 2026', 'rejected', localTime(PROPOSED_AT), localTime(DECIDED_AT)]);
    expect(cells(waiting!)).toEqual(['Extra extension', '—', 'proposed', localTime('2026-10-22T08:05:00.000Z'), '—']);
    expect([...rejected!.querySelectorAll('time')].map((t) => t.getAttribute('datetime'))).toEqual([PROPOSED_AT, DECIDED_AT]);
    expect(within(panel).queryByText(/reason/i)).toBeNull();
    expect(panel.textContent).not.toMatch(/hidden|withheld|restricted|redacted|confidential|\*\*\*/i);
    // Without the exception permissions there is nothing to propose, withdraw or decide, and no queue is asked for.
    expect(within(panel).queryByRole('form', { name: 'Propose an exception' })).toBeNull();
    expect(within(panel).queryByRole('button', { name: /withdraw/i })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Pending exceptions' })).toBeNull();
    expect(callsTo('GET', `/v1/confirmations/${C_OVERDUE}/exceptions`)).toHaveLength(1);
    expect(pendingReads()).toHaveLength(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('shows the private reasons only when the server returned them', async () => {
    serve({}, { exceptions: [MEERA_REJECTED(), MEERA_OWN_EXTRA()], withReasons: true });
    renderPage([READ, READ_REASON]);
    const panel = await openCase('Meera Synthetic (SYN-103)');
    const table = await exceptionTable(panel);
    expect(headers(table)).toEqual(['Exception', 'Proposed due date', 'State', 'Proposed at', 'Decided at', 'Reason', 'Decision reason']);
    const [, rejected, waiting] = within(table).getAllByRole('row');
    expect(cells(rejected!).slice(-2)).toEqual([MEERA_REASON, MEERA_DECISION]);
    // A proposal still waiting has no decision reason yet.
    expect(cells(waiting!).slice(-2)).toEqual(['Synthetic own proposal', '—']);
  });

  it('proposes a due date override with exactly the API’s body once the required fields are filled, then starts a clean form', async () => {
    serve();
    renderPage([READ, PROPOSE]);
    const panel = await openCase('Asha Synthetic (SYN-101)');
    expect(await within(panel).findByText('No exceptions have been proposed for this case.')).toBeTruthy();
    const form = within(panel).getByRole('form', { name: 'Propose an exception' });
    const send = within(form).getByRole('button', { name: 'Propose exception' });

    // Simple required-field checks only: the browser's own validation, and a reason that is not just spaces.
    expect((form as HTMLFormElement).checkValidity()).toBe(false);
    fireEvent.click(send);
    fireEvent.click(within(form).getByLabelText('Due date override'));
    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: 'Synthetic' } });
    expect((form as HTMLFormElement).checkValidity()).toBe(false); // the new due date is still missing
    fireEvent.click(send);
    fireEvent.change(within(form).getByLabelText('New due date'), { target: { value: '2026-12-15' } });
    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: '   ' } });
    fireEvent.click(send);
    expect((await within(form).findByRole('alert')).textContent).toBe('Enter a reason.');
    await settle();
    expect(proposals(C_UPCOMING)).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: `  ${ASHA_REASON}  ` } });
    fireEvent.click(send);
    await waitFor(() => expect(proposals(C_UPCOMING)).toHaveLength(1));
    expect(proposals(C_UPCOMING)[0]!.body).toEqual({ kind: 'DUE_DATE_OVERRIDE', proposedDueDate: '2026-12-15', reason: ASHA_REASON });
    expect((await within(form).findByRole('status')).textContent).toBe('Exception proposed. Another HR user decides it; the case changes only if it is approved.');
    // A clean form for the next proposal.
    expect((within(form).getByLabelText('Reason (required)') as HTMLTextAreaElement).value).toBe('');
    expect((within(form).getByLabelText('Due date override') as HTMLInputElement).checked).toBe(false);
    expect(within(form).queryByLabelText('New due date')).toBeNull();
    expect(within(form).queryByRole('alert')).toBeNull();
    // The case's exceptions show the waiting proposal; the due date stays until another HR user approves it.
    const table = await exceptionTable(panel);
    expect(cells(within(table).getAllByRole('row')[1]!).slice(0, 3)).toEqual(['Due date override', '15 Dec 2026', 'proposed']);
    expect(dueDateIn(panel)).toMatch(/^3 Nov 2026/);
  });

  it('proposes an extra extension without a date', async () => {
    serve();
    renderPage([READ, PROPOSE]);
    const panel = await openCase('Meera Synthetic (SYN-103)');
    const form = within(panel).getByRole('form', { name: 'Propose an exception' });
    // A date typed for an override is not sent with an extra extension.
    fireEvent.click(within(form).getByLabelText('Due date override'));
    fireEvent.change(within(form).getByLabelText('New due date'), { target: { value: '2026-12-15' } });
    fireEvent.click(within(form).getByLabelText('Extra extension'));
    expect(within(form).queryByLabelText('New due date')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: 'Needs a third extension (synthetic)' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Propose exception' }));
    await waitFor(() => expect(proposals(C_OVERDUE)).toHaveLength(1));
    expect(proposals(C_OVERDUE)[0]!.body).toEqual({ kind: 'EXTRA_EXTENSION', reason: 'Needs a third extension (synthetic)' });
    expect((await within(form).findByRole('status')).textContent).toMatch(/^Exception proposed/);
  });

  it('shows the API’s refusals in plain words and keeps what was typed', async () => {
    let refusal: Reply = [422, { error: 'RULE_VIOLATION', message: 'The due date cannot be before the joining date' }];
    const cases = serve({ [`POST /v1/confirmations/${C_UPCOMING}/exceptions`]: () => refusal });
    renderPage([READ, PROPOSE]);
    const panel = await openCase('Asha Synthetic (SYN-101)');
    const form = within(panel).getByRole('form', { name: 'Propose an exception' });
    const send = within(form).getByRole('button', { name: 'Propose exception' });
    const reason = () => within(form).getByLabelText('Reason (required)') as HTMLTextAreaElement;
    const override = () => within(form).getByLabelText('Due date override') as HTMLInputElement;
    fireEvent.click(override());
    fireEvent.change(within(form).getByLabelText('New due date'), { target: { value: '2026-07-01' } });
    fireEvent.change(reason(), { target: { value: 'Synthetic justification' } });

    const refusals: [Reply, string][] = [
      [refusal, 'The new due date cannot be before the employee’s start date (3 Aug 2026).'],
      [[422, { error: 'NO_CHANGE', message: 'This is already the due date' }], 'That date is already the case’s due date. Choose a different date.'],
      [
        [409, { error: 'OPEN_PROPOSAL_EXISTS', message: 'An exception of this kind is already waiting for a decision' }],
        'An exception of this kind is already waiting for a decision on this case. It has to be decided or withdrawn before another one can be proposed.',
      ],
      [[403, { error: 'SELF_ACTION', message: 'You cannot propose an exception for your own confirmation' }], 'You cannot propose an exception for your own confirmation.'],
    ];
    for (const [reply, text] of refusals) {
      refusal = reply;
      fireEvent.click(send);
      await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe(text));
      // Nothing typed is lost after a refusal.
      expect(reason().value).toBe('Synthetic justification');
      expect((within(form).getByLabelText('New due date') as HTMLInputElement).value).toBe('2026-07-01');
      expect(override().checked).toBe(true);
    }
    expect(within(form).queryByRole('status')).toBeNull();

    // An extra extension while the policy limit is not reached yet.
    refusal = [422, { error: 'LIMIT_NOT_REACHED', message: 'The case can still be extended without an exception' }];
    fireEvent.click(within(form).getByLabelText('Extra extension'));
    fireEvent.click(send);
    await waitFor(() => expect(within(form).getByRole('alert').textContent).toBe('This case can still be extended within its policy limit, so an extra extension is not needed yet.'));
    expect(proposals(C_UPCOMING).at(-1)!.body).toEqual({ kind: 'EXTRA_EXTENSION', reason: 'Synthetic justification' });

    // A recommendation arrived after the case was loaded: refused, the case reloads, and the override is no longer offered.
    refusal = [409, CASE_NOT_OPEN];
    fireEvent.click(override());
    cases.find((c) => c.id === C_UPCOMING)!.state = 'REVIEW_PENDING';
    fireEvent.click(send);
    await waitFor(() =>
      expect(within(form).getByRole('alert').textContent).toBe(
        'The due date can change only while the case is open, and it is not open now: a recommendation is under review, or the case has closed. Propose the new date once the case is open again.',
      ),
    );
    await waitFor(() => expect(override().disabled).toBe(true));
    expect(within(panel).getByText(/waiting for an HR decision/)).toBeTruthy();
    expect(reason().value).toBe('Synthetic justification');
    expect(proposals(C_UPCOMING)).toHaveLength(6);
  });

  it('offers the due date override only while the case is open, and no exception on a closed case or one’s own', async () => {
    serve();
    renderPage([READ, PROPOSE]);
    // Under review: only an extra extension can be proposed, and the form says why.
    let panel = await openCase('Ravi Synthetic (SYN-102)');
    const form = within(panel).getByRole('form', { name: 'Propose an exception' });
    const override = within(form).getByLabelText('Due date override') as HTMLInputElement;
    expect(override.disabled).toBe(true);
    expect((within(form).getByLabelText('Extra extension') as HTMLInputElement).disabled).toBe(false);
    const why = within(form).getByText('The due date cannot change while a recommendation is under review.');
    expect(override.getAttribute('aria-describedby')).toBe(why.id);
    // Confirmed: nothing to propose.
    panel = await openCase('Kiran Synthetic (SYN-104)');
    expect(await within(panel).findByText('No exceptions have been proposed for this case.')).toBeTruthy();
    expect(within(panel).queryByRole('form', { name: 'Propose an exception' })).toBeNull();
    cleanup();

    // The HR user's own confirmation (their linked employee): never proposed by them.
    serve();
    renderPage([READ, PROPOSE], '/confirmations', { employeeId: CASES[0]!.employeeId });
    panel = await openCase('Asha Synthetic (SYN-101)');
    expect(await within(panel).findByText('You cannot propose an exception for your own confirmation.')).toBeTruthy();
    expect(within(panel).queryByRole('form', { name: 'Propose an exception' })).toBeNull();
  });

  it('lets the proposer withdraw their own waiting proposal from the case, and nobody else’s', async () => {
    serve({}, { exceptions: [ASHA_WAITING(), ASHA_OWN_EXTRA()] });
    renderPage([READ, PROPOSE]);
    const panel = await openCase('Asha Synthetic (SYN-101)');
    const table = await exceptionTable(panel);
    const withdraw = within(table).getAllByRole('button', { name: /^Withdraw/ });
    expect(withdraw.map((b) => b.getAttribute('aria-label'))).toEqual(['Withdraw your extra extension proposal']);
    expect(rowWith(table, 'Due date override').querySelector('button')).toBeNull();
    fireEvent.click(withdraw[0]!);
    await waitFor(() => expect(withdrawals(X_ASHA_EXTRA)).toHaveLength(1));
    expect(withdrawals(X_ASHA_EXTRA)[0]!.body).toBeUndefined();
    expect((await within(panel).findByRole('status')).textContent).toBe('Proposal withdrawn.');
    await waitFor(() => expect(within(table).queryByRole('button', { name: /^Withdraw/ })).toBeNull());
    expect(cells(rowWith(table, 'Extra extension'))[2]).toBe('withdrawn');
    // The button went away; focus stays in the case panel instead of falling to the page.
    expect(panel.contains(document.activeElement)).toBe(true);
  });
});

describe('pending exceptions (DF11, C4)', () => {
  it('approves a due date override with a typed reason, after which the case shows its new due date', async () => {
    serve({}, { exceptions: [ASHA_WAITING(), MEERA_OWN_EXTRA()] });
    renderPage([READ, APPROVE_EXCEPTION], `/confirmations?case=${C_UPCOMING}`);
    const panel = await caseRegion('Asha Synthetic (SYN-101)');
    expect(dueDateIn(panel)).toMatch(/^3 Nov 2026/);
    expect(await within(panel).findByText('Waiting proposals are decided under Pending exceptions on this page.')).toBeTruthy();
    const queue = await findSection('Pending exceptions');
    const item = await within(queue).findByRole('listitem', { name: 'Due date override: Asha Synthetic (SYN-101)' });
    expect(within(queue).getAllByRole('listitem')).toHaveLength(2);
    expect(within(item).getByText('Proposed due date').nextElementSibling!.textContent).toBe('15 Dec 2026');
    expect(within(item).getByText('Proposed at').nextElementSibling!.textContent).toBe(localTime(PROPOSED_AT));
    // The server withheld the private reason: no Reason entry.
    expect(within(item).queryByText('Reason', { selector: 'dt' })).toBeNull();
    const approve = within(item).getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    const reject = within(item).getByRole('button', { name: 'Reject' }) as HTMLButtonElement;
    const field = within(item).getByLabelText('Decision reason (required)') as HTMLTextAreaElement;

    // Each decision needs a typed reason.
    fireEvent.click(approve);
    expect((await within(item).findByRole('alert')).textContent).toBe('Enter a reason for your decision.');
    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.click(reject);
    await settle();
    expect(decisions(X_ASHA_OVERRIDE)).toHaveLength(0);

    fireEvent.change(field, { target: { value: '  Engagement confirmed by the delivery head (synthetic)  ' } });
    const release = hold(`POST /v1/confirmation-exceptions/${X_ASHA_OVERRIDE}/decision`);
    fireEvent.click(approve);
    await waitFor(() => expect(decisions(X_ASHA_OVERRIDE)).toHaveLength(1));
    // While the decision is in flight neither button sends again.
    await waitFor(() => expect(approve.disabled).toBe(true));
    expect(reject.disabled).toBe(true);
    fireEvent.click(approve);
    fireEvent.click(reject);
    await settle();
    expect(decisions(X_ASHA_OVERRIDE)).toHaveLength(1);
    // Exactly the API's body: the decision, the trimmed reason and this decision's idempotency key.
    expect(decisions(X_ASHA_OVERRIDE)[0]!.body).toEqual({
      decision: 'APPROVE',
      reason: 'Engagement confirmed by the delivery head (synthetic)',
      idempotencyKey: expect.stringMatching(/^conf-exception-[0-9a-f-]{36}$/),
    });

    await act(async () => release());
    expect((await within(queue).findByRole('status')).textContent).toBe('Approved the due date override for Asha Synthetic (SYN-101): the due date is now 15 Dec 2026.');
    expect(within(queue).queryByRole('listitem', { name: 'Due date override: Asha Synthetic (SYN-101)' })).toBeNull();
    expect(within(queue).getAllByRole('listitem')).toHaveLength(1);
    // The decided item went away; focus stays in the queue instead of falling to the page.
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Pending exceptions' }));
    // The case reloads with its new due date, and so do the list and the case's exceptions.
    await waitFor(() => expect(dueDateIn(panel)).toMatch(/^15 Dec 2026/));
    await waitFor(() => expect(cells(rowWith(screen.getByRole('tabpanel'), 'Asha Synthetic'))[3]).toMatch(/^15 Dec 2026/));
    const table = await exceptionTable(panel);
    await waitFor(() => expect(cells(rowWith(table, 'Due date override'))[2]).toBe('approved'));
  });

  it('rejects with a typed reason and leaves the case as it was', async () => {
    serve({}, { exceptions: [ASHA_WAITING()] });
    renderPage([READ, APPROVE_EXCEPTION], `/confirmations?case=${C_UPCOMING}`);
    const panel = await caseRegion('Asha Synthetic (SYN-101)');
    const item = await pendingItem('Due date override: Asha Synthetic (SYN-101)');
    fireEvent.change(within(item).getByLabelText('Decision reason (required)'), { target: { value: 'No business need (synthetic)' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(decisions(X_ASHA_OVERRIDE)).toHaveLength(1));
    expect(decisions(X_ASHA_OVERRIDE)[0]!.body).toEqual({ decision: 'REJECT', reason: 'No business need (synthetic)', idempotencyKey: expect.stringMatching(/^conf-exception-[0-9a-f-]{36}$/) });
    const queue = await findSection('Pending exceptions');
    expect((await within(queue).findByRole('status')).textContent).toBe('Rejected the due date override for Asha Synthetic (SYN-101); the case is unchanged.');
    expect(await within(queue).findByText('No exceptions are waiting for a decision.')).toBeTruthy();
    const table = await exceptionTable(panel);
    await waitFor(() => expect(cells(rowWith(table, 'Due date override'))[2]).toBe('rejected'));
    expect(dueDateIn(panel)).toMatch(/^3 Nov 2026/);
  });

  it('does not let a proposer decide their own proposal, and lets them withdraw it', async () => {
    serve({}, { exceptions: [MEERA_OWN_EXTRA()] });
    renderPage([READ, APPROVE_EXCEPTION, PROPOSE]);
    let item = await pendingItem('Extra extension: Meera Synthetic (SYN-103)');
    const why = within(item).getByText('You proposed this exception, so another HR user has to decide it.');
    for (const name of ['Approve', 'Reject']) {
      const button = within(item).getByRole('button', { name }) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      expect(button.getAttribute('aria-describedby')?.split(' ')).toContain(why.id);
    }
    expect(within(item).queryByLabelText('Decision reason (required)')).toBeNull();
    fireEvent.click(within(item).getByRole('button', { name: 'Withdraw proposal' }));
    await waitFor(() => expect(withdrawals(X_MEERA_EXTRA)).toHaveLength(1));
    expect(withdrawals(X_MEERA_EXTRA)[0]!.body).toBeUndefined();
    const queue = await findSection('Pending exceptions');
    expect((await within(queue).findByRole('status')).textContent).toBe('Withdrew your extra extension proposal for Meera Synthetic (SYN-103).');
    expect(await within(queue).findByText('No exceptions are waiting for a decision.')).toBeTruthy();
    expect(decisions(X_MEERA_EXTRA)).toHaveLength(0);
    cleanup();

    // Without the propose permission (which withdrawing needs) there is no Withdraw.
    serve({}, { exceptions: [MEERA_OWN_EXTRA()] });
    renderPage([READ, APPROVE_EXCEPTION]);
    item = await pendingItem('Extra extension: Meera Synthetic (SYN-103)');
    expect(within(item).getByText('You proposed this exception, so another HR user has to decide it.')).toBeTruthy();
    expect(within(item).queryByRole('button', { name: 'Withdraw proposal' })).toBeNull();
    cleanup();

    // An exception for the HR user's own confirmation is never decided by them either.
    serve({}, { exceptions: [ASHA_WAITING()] });
    renderPage([READ, APPROVE_EXCEPTION], '/confirmations', { employeeId: CASES[0]!.employeeId });
    item = await pendingItem('Due date override: Asha Synthetic (SYN-101)');
    expect(within(item).getByText('This exception is for your own confirmation, so another HR user has to decide it.')).toBeTruthy();
    expect((within(item).getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(item).getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows decision refusals in plain words and keeps the typed reason', async () => {
    let refusal: Reply = [409, CASE_NOT_OPEN];
    serve({ [`POST /v1/confirmation-exceptions/${X_ASHA_OVERRIDE}/decision`]: () => refusal }, { exceptions: [ASHA_WAITING()] });
    renderPage([READ, APPROVE_EXCEPTION]);
    const item = await pendingItem('Due date override: Asha Synthetic (SYN-101)');
    const field = () => within(item).getByLabelText('Decision reason (required)') as HTMLTextAreaElement;
    fireEvent.change(field(), { target: { value: 'Synthetic decision' } });
    const refusals: [Reply, string, string][] = [
      [
        [409, CASE_NOT_OPEN],
        'Approve',
        'The due date can change only while the case is open, and it is not open now: a recommendation is under review, or the case has closed. Approve this once the case is open again, or reject it.',
      ],
      [[403, { error: 'SELF_ACTION', message: 'You cannot decide an exception for your own confirmation' }], 'Reject', 'You cannot decide an exception for your own confirmation.'],
      [
        [403, { error: 'INDEPENDENT_APPROVER_REQUIRED', message: 'Another eligible HR user must decide your proposal' }],
        'Approve',
        'You proposed this exception, so another eligible HR user has to decide it.',
      ],
    ];
    for (const [reply, button, text] of refusals) {
      refusal = reply;
      fireEvent.click(within(item).getByRole('button', { name: button }));
      await waitFor(() => expect(within(item).getByRole('alert').textContent).toBe(text));
      expect(field().value).toBe('Synthetic decision');
    }
    // Decided by someone else meanwhile: it leaves the queue with a note.
    refusal = [409, INVALID_STATE];
    exceptions[0]!.state = 'APPROVED';
    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }));
    const queue = await findSection('Pending exceptions');
    expect((await within(queue).findByRole('alert')).textContent).toBe('This proposal has already been decided or withdrawn.');
    expect(await within(queue).findByText('No exceptions are waiting for a decision.')).toBeTruthy();
    expect(decisions(X_ASHA_OVERRIDE)).toHaveLength(4);
  });

  it('sends one idempotency key per decision, so a retry after a lost answer is answered and never applied twice', async () => {
    const cases = serve({}, { exceptions: [ASHA_WAITING()] });
    renderPage([READ, APPROVE_EXCEPTION], `/confirmations?case=${C_UPCOMING}`);
    const panel = await caseRegion('Asha Synthetic (SYN-101)');
    let item = await pendingItem('Due date override: Asha Synthetic (SYN-101)');
    const field = within(item).getByLabelText('Decision reason (required)') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Engagement confirmed (synthetic)' } });
    // The server records the approval, but its answer never arrives.
    loseAnswer(`POST /v1/confirmation-exceptions/${X_ASHA_OVERRIDE}/decision`);
    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }));
    expect((await within(item).findByRole('alert')).textContent).toBe(
      'No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice.',
    );
    expect(field.value).toBe('Engagement confirmed (synthetic)');
    // The same decision sent again carries the same key: the server answers from what it recorded.
    fireEvent.click(within(item).getByRole('button', { name: 'Approve' }));
    const queue = await findSection('Pending exceptions');
    expect((await within(queue).findByRole('status')).textContent).toBe(
      'Approved the due date override for Asha Synthetic (SYN-101). Your earlier attempt had already been recorded, so nothing was applied twice.',
    );
    expect(within(queue).queryByRole('listitem')).toBeNull();
    const retried = decisions(X_ASHA_OVERRIDE).map((c) => (c.body as { idempotencyKey: string }).idempotencyKey);
    expect(retried).toHaveLength(2);
    expect(retried[0]).toMatch(/^conf-exception-[0-9a-f-]{36}$/);
    expect(retried[1]).toBe(retried[0]);
    // Applied once: the case shows its new due date, one version on.
    await waitFor(() => expect(dueDateIn(panel)).toMatch(/^15 Dec 2026/));
    expect(cases.find((c) => c.id === C_UPCOMING)!.version).toBe(4);
    cleanup();

    // Another decision, or another reason, is a new action with its own key. A key the server will not take for this
    // decision is said in plain words, the reason is kept, and the next attempt carries a new key.
    let reply: Reply = [503, { error: 'UNAVAILABLE', message: 'The service is busy; retry shortly' }];
    serve({ [`POST /v1/confirmation-exceptions/${X_ASHA_OVERRIDE}/decision`]: () => reply }, { exceptions: [ASHA_WAITING()] });
    renderPage([APPROVE_EXCEPTION]);
    item = await pendingItem('Due date override: Asha Synthetic (SYN-101)');
    const reason = within(item).getByLabelText('Decision reason (required)') as HTMLTextAreaElement;
    const decide = async (name: 'Approve' | 'Reject', sent: number) => {
      fireEvent.click(within(item).getByRole('button', { name }));
      await waitFor(() => expect(decisions(X_ASHA_OVERRIDE)).toHaveLength(sent));
      await waitFor(() => expect((within(item).getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
    };
    fireEvent.change(reason, { target: { value: 'Synthetic decision' } });
    await decide('Approve', 1);
    expect(within(item).getByRole('alert').textContent).toBe('The service is busy; retry shortly (UNAVAILABLE)');
    await decide('Approve', 2); // the same decision again
    await decide('Reject', 3); // another decision
    fireEvent.change(reason, { target: { value: 'Synthetic decision, reworded' } });
    await decide('Reject', 4); // another reason
    reply = [409, { error: 'IDEMPOTENCY_KEY_REUSED', message: 'This idempotency key was used for another decision' }];
    await decide('Reject', 5); // the same decision again, whose key the server refuses
    expect(within(item).getByRole('alert').textContent).toBe('Nothing was recorded: this attempt was matched to a different decision. Send your decision again.');
    expect(reason.value).toBe('Synthetic decision, reworded');
    reply = [200, { exceptionId: X_ASHA_OVERRIDE, state: 'REJECTED', applied: null, replayed: false }];
    fireEvent.click(within(item).getByRole('button', { name: 'Reject' }));
    expect((await within(await findSection('Pending exceptions')).findByRole('status')).textContent).toBe(
      'Rejected the due date override for Asha Synthetic (SYN-101); the case is unchanged.',
    );
    const sent = decisions(X_ASHA_OVERRIDE).map((c) => c.body as { decision: string; reason: string; idempotencyKey: string });
    expect(sent.map((b) => b.decision)).toEqual(['APPROVE', 'APPROVE', 'REJECT', 'REJECT', 'REJECT', 'REJECT']);
    const keys = sent.map((b) => b.idempotencyKey);
    expect(keys.every((k) => /^conf-exception-[0-9a-f-]{36}$/.test(k))).toBe(true);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[4]).toBe(keys[3]);
    expect(new Set([keys[0], keys[2], keys[3], keys[5]]).size).toBe(4);
  });

  it('shows the queue only to deciders, with reasons only when returned and case links only for readers', async () => {
    serve({}, { exceptions: [ASHA_WAITING()] });
    renderPage([READ, PROPOSE, DECIDE]);
    await screen.findByRole('button', { name: 'View case of Asha Synthetic (SYN-101)' });
    await settle();
    expect(screen.queryByRole('heading', { name: 'Pending exceptions' })).toBeNull();
    expect(pendingReads()).toHaveLength(0);
    cleanup();

    // With the reason group the proposer's justification is shown, and a reader can open the case from the queue.
    serve({}, { exceptions: [ASHA_WAITING()], withReasons: true });
    renderPage([READ, READ_REASON, APPROVE_EXCEPTION]);
    let item = await pendingItem('Due date override: Asha Synthetic (SYN-101)');
    expect(within(item).getByText('Reason', { selector: 'dt' }).nextElementSibling!.textContent).toBe(ASHA_REASON);
    fireEvent.click(within(item).getByRole('button', { name: 'Open the case of Asha Synthetic (SYN-101)' }));
    expect(document.activeElement).toBe(await caseRegion('Asha Synthetic (SYN-101)'));
    cleanup();

    // A decider who cannot read cases: the queue without links to cases, and no case requests.
    serve({}, { exceptions: [ASHA_WAITING()] });
    renderPage([APPROVE_EXCEPTION]);
    item = await pendingItem('Due date override: Asha Synthetic (SYN-101)');
    expect(within(item).queryByRole('button', { name: /Open the case/ })).toBeNull();
    await settle();
    expect(calls.map((c) => c.path)).toEqual(['/v1/confirmation-exceptions/pending']);
    cleanup();

    // The server's refusal, and an empty queue, told apart.
    serve({ 'GET /v1/confirmation-exceptions/pending': [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    renderPage([APPROVE_EXCEPTION]);
    let queue = await findSection('Pending exceptions');
    expect(await within(queue).findByText(/cannot decide confirmation exceptions/)).toBeTruthy();
    expect(within(queue).queryByText('No exceptions are waiting for a decision.')).toBeNull();
    cleanup();
    serve();
    renderPage([APPROVE_EXCEPTION]);
    queue = await findSection('Pending exceptions');
    expect(await within(queue).findByText('No exceptions are waiting for a decision.')).toBeTruthy();
    expect(within(queue).queryByText(/not permitted/i)).toBeNull();
  });

  it('says when the queue shows only the oldest proposals the API returns', async () => {
    const many = Array.from({ length: 200 }, (_, i) => exception(`40000000-0000-4000-8000-2${String(i).padStart(11, '0')}`, C_UPCOMING, { kind: 'EXTRA_EXTENSION' }));
    serve({}, { exceptions: many });
    renderPage([APPROVE_EXCEPTION]);
    const queue = await findSection('Pending exceptions');
    expect(await within(queue).findByText('Showing the oldest 200 waiting proposals; newer ones appear as these are decided.')).toBeTruthy();
    expect(within(queue).getAllByRole('listitem')).toHaveLength(200);
  });
});

describe('role switches (C1, DF02)', () => {
  it('never shows exception reasons answered for another role assignment, even from the cache', async () => {
    const client = testClient(15_000);
    serve({}, { exceptions: [ASHA_WAITING()], withReasons: true });
    const hr = renderPage([READ, READ_REASON, APPROVE_EXCEPTION], `/confirmations?case=${C_UPCOMING}`, { client, assignmentId: ASSIGNMENT_HR });
    expect(await within(await caseRegion('Asha Synthetic (SYN-101)')).findByText(ASHA_REASON)).toBeTruthy();
    expect(await within(await findSection('Pending exceptions')).findByText(ASHA_REASON)).toBeTruthy();
    hr.unmount();

    // Another assignment in the same browser: answered afresh, without the reasons.
    serve({}, { exceptions: [ASHA_WAITING()] });
    renderPage([READ, APPROVE_EXCEPTION], `/confirmations?case=${C_UPCOMING}`, { client, assignmentId: ASSIGNMENT_MANAGER });
    expect(screen.queryByText(ASHA_REASON)).toBeNull();
    const table = await exceptionTable(await caseRegion('Asha Synthetic (SYN-101)'));
    expect(headers(table)).not.toContain('Reason');
    await pendingItem('Due date override: Asha Synthetic (SYN-101)');
    expect(screen.queryByText(ASHA_REASON)).toBeNull();
    expect(callsTo('GET', `/v1/confirmations/${C_UPCOMING}/exceptions`)).toHaveLength(1);
    expect(pendingReads()).toHaveLength(1);
  });

  it('never shows a list or a case answered for another role assignment, even from the cache', async () => {
    // One query cache for the whole app, kept across role switches and sign-ins, fresh for 15 s (as in main.tsx).
    const client = testClient(15_000);
    serve({ [`GET /v1/confirmations/${C_OVERDUE}`]: [200, detailOf(C_OVERDUE, MEERA_ACTIONS.map((a, i) => ({ ...a, reason: MEERA_REASONS[i]! })))] });
    const hr = renderPage([READ, READ_REASON], `/confirmations?case=${C_OVERDUE}`, { client, assignmentId: ASSIGNMENT_HR });
    expect(await within(await caseRegion('Meera Synthetic (SYN-103)')).findByText(MEERA_REASONS[0]!)).toBeTruthy();
    expect(screen.getByText('Asha Synthetic')).toBeTruthy();
    hr.unmount();

    // The same browser after switching to a manager assignment: the server answers for its own scope, without reasons.
    serve({ 'GET /v1/confirmations': [200, { view: 'ALL', items: [CASES[2]], total: 1 }] });
    renderPage([READ], `/confirmations?case=${C_OVERDUE}`, { client, assignmentId: ASSIGNMENT_MANAGER });
    expect(screen.queryByText(MEERA_REASONS[0]!)).toBeNull();
    expect(screen.queryByText('Asha Synthetic')).toBeNull();
    const panel = await caseRegion('Meera Synthetic (SYN-103)');
    expect(within(within(panel).getByRole('table')).getAllByRole('columnheader').map((h) => h.textContent)).not.toContain('Reason');
    expect(screen.queryByText(MEERA_REASONS[0]!)).toBeNull();
    expect(callsTo('GET', `/v1/confirmations/${C_OVERDUE}`)).toHaveLength(1);
    await waitFor(() => expect(within(screen.getByRole('tabpanel')).getAllByRole('row')).toHaveLength(2));
    expect(screen.queryByText('Asha Synthetic')).toBeNull();
    expect(listViews()).toEqual(['ALL']);
  });
});

describe('cancelling a review (FR-082, DF11)', () => {
  const cancels = (caseId: string) => callsTo('POST', `/v1/confirmations/${caseId}/cancel`);
  const cancelledCase = (cases: Case[], caseId: string) => {
    const target = cases.find((k) => k.id === caseId)!;
    Object.assign(target, { state: 'CANCELLED', view: 'CANCELLED', version: target.version + 1, cancelledAt: '2026-10-30T10:00:00.000Z' });
  };
  const formIn = (panel: HTMLElement) => within(panel).getByRole('form', { name: 'Cancel this review' });

  it('sends exactly the reason and the case version, after which the case shows it is closed', async () => {
    serve({
      [`POST /v1/confirmations/${C_UPCOMING}/cancel`]: (_c, cases) => {
        cancelledCase(cases, C_UPCOMING);
        return [200, { caseId: C_UPCOMING, state: 'CANCELLED' }];
      },
    });
    renderPage([READ, MANAGE]);
    const panel = await openCase('Asha Synthetic (SYN-101)');
    const form = formIn(panel);
    const send = within(form).getByRole('button', { name: 'Cancel review' });

    fireEvent.click(send);
    await settle();
    expect(cancels(C_UPCOMING)).toHaveLength(0);
    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: '   ' } });
    fireEvent.click(send);
    expect(await within(form).findByText('Enter why the review is cancelled.')).toBeTruthy();
    expect(cancels(C_UPCOMING)).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: ' Opened for the wrong employee (synthetic) ' } });
    fireEvent.click(send);
    await waitFor(() => expect(cancels(C_UPCOMING)).toHaveLength(1));
    expect(cancels(C_UPCOMING)[0]!.body).toEqual({ expectedVersion: 3, reason: 'Opened for the wrong employee (synthetic)' });

    await waitFor(() => expect(within(panel).queryByRole('form', { name: 'Cancel this review' })).toBeNull());
    expect(within(panel).getByText('Cancelled on')).toBeTruthy();
    expect(within(panel).getByText('cancelled')).toBeTruthy();
    // The case left the date views and the list was asked again.
    expect(listViews().length).toBeGreaterThan(1);
  });

  it('shows the private reason only when the server returned it', async () => {
    const closed = { ...CASES[0]!, state: 'CANCELLED', view: 'CANCELLED', cancelledAt: '2026-10-30T10:00:00.000Z' };
    serve({ [`GET /v1/confirmations/${C_UPCOMING}`]: [200, { ...closed, actions: [] }] });
    const first = renderPage([READ, MANAGE], `/confirmations?case=${C_UPCOMING}`);
    const panel = await caseRegion('Asha Synthetic (SYN-101)');
    expect(within(panel).getByText('Cancelled on')).toBeTruthy();
    expect(within(panel).queryByText('Reason for cancelling')).toBeNull();
    expect(within(panel).queryByRole('form', { name: 'Cancel this review' })).toBeNull();
    first.unmount();

    serve({ [`GET /v1/confirmations/${C_UPCOMING}`]: [200, { ...closed, cancelReason: 'Opened for the wrong employee (synthetic)', actions: [] }] });
    renderPage([READ, READ_REASON, MANAGE], `/confirmations?case=${C_UPCOMING}`);
    const shown = await caseRegion('Asha Synthetic (SYN-101)');
    expect(within(shown).getByText('Opened for the wrong employee (synthetic)')).toBeTruthy();
  });

  it('shows a refusal in plain words, keeps the typed reason and reloads the case after a conflict, so a retry uses the new version', async () => {
    let refuse = true;
    serve({
      [`POST /v1/confirmations/${C_UPCOMING}/cancel`]: (_c, cases) => {
        if (refuse) {
          cases.find((k) => k.id === C_UPCOMING)!.version = 7;
          return [409, STALE];
        }
        cancelledCase(cases, C_UPCOMING);
        return [200, { caseId: C_UPCOMING, state: 'CANCELLED' }];
      },
    });
    renderPage([READ, MANAGE]);
    const panel = await openCase('Asha Synthetic (SYN-101)');
    const form = formIn(panel);
    const reason = within(form).getByLabelText('Reason (required)') as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: 'Synthetic reason' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel review' }));
    expect(await within(panel).findByText(STALE.message)).toBeTruthy();
    expect(reason.value).toBe('Synthetic reason');
    expect(within(panel).queryByText(/STALE_VERSION/)).toBeNull();
    await waitFor(() => expect(callsTo('GET', `/v1/confirmations/${C_UPCOMING}`).length).toBeGreaterThan(1));
    await settle();

    refuse = false;
    fireEvent.click(within(form).getByRole('button', { name: 'Cancel review' }));
    await waitFor(() => expect(cancels(C_UPCOMING)).toHaveLength(2));
    expect(cancels(C_UPCOMING)[1]!.body).toEqual({ expectedVersion: 7, reason: 'Synthetic reason' });
  });

  it('is offered on a live case only, to the HR duty only, and never on one’s own review', async () => {
    serve();
    const reader = renderPage([READ, RECOMMEND]);
    expect(within(await openCase('Asha Synthetic (SYN-101)')).queryByRole('form', { name: 'Cancel this review' })).toBeNull();
    reader.unmount();

    serve();
    const hr = renderPage([READ, MANAGE]);
    expect(formIn(await openCase('Ravi Synthetic (SYN-102)'))).toBeTruthy();
    hr.unmount();

    serve();
    const confirmed = renderPage([READ, MANAGE], `/confirmations?case=${C_CONFIRMED}`);
    const closed = await caseRegion('Kiran Synthetic (SYN-104)');
    expect(within(closed).queryByRole('form', { name: 'Cancel this review' })).toBeNull();
    confirmed.unmount();

    serve();
    renderPage([READ, MANAGE], `/confirmations?case=${C_UPCOMING}`, { employeeId: CASES[0]!.employeeId });
    const own = await caseRegion('Asha Synthetic (SYN-101)');
    expect(within(own).getByText('You cannot cancel your own confirmation review.')).toBeTruthy();
    expect(within(own).queryByRole('form', { name: 'Cancel this review' })).toBeNull();
  });

  it('a live case of an employee no longer on probation says so, offers no recommendation, and HR can cancel it', async () => {
    const leaver = { ...CASES[1]!, view: 'NOT_ON_PROBATION' };
    serve({ [`GET /v1/confirmations/${C_DUE}`]: [200, { ...leaver, actions: [] }], 'GET /v1/confirmations': [200, { view: 'ALL', items: [leaver], total: 1 }] });
    const hr = renderPage([READ, MANAGE, RECOMMEND], `/confirmations?case=${C_DUE}`);
    const panel = await caseRegion('Ravi Synthetic (SYN-102)');
    expect(within(panel).getByText(/no longer on probation, so the review cannot be recommended or decided/)).toBeTruthy();
    expect(within(panel).getAllByText('not on probation').length).toBeGreaterThan(0);
    expect(within(panel).queryByRole('form', { name: 'Your recommendation' })).toBeNull();
    expect(within(panel).queryByText(/waiting for an HR decision/)).toBeNull();
    expect(formIn(panel)).toBeTruthy();
    // It counts in no date tab.
    expect(await screen.findByRole('tab', { name: 'Due (0)' })).toBeTruthy();
    hr.unmount();

    const openLeaver = { ...CASES[0]!, view: 'NOT_ON_PROBATION' };
    serve({ [`GET /v1/confirmations/${C_UPCOMING}`]: [200, { ...openLeaver, actions: [] }] });
    renderPage([READ, RECOMMEND], `/confirmations?case=${C_UPCOMING}`);
    const managerPanel = await caseRegion('Asha Synthetic (SYN-101)');
    expect(within(managerPanel).queryByRole('form', { name: 'Your recommendation' })).toBeNull();
    expect(within(managerPanel).queryByText(/Cancel it below/)).toBeNull();
  });
});

describe('confirmation policies (FR-080, BR-029, DF11)', () => {
  const P_DEFAULT = '50000000-0000-4000-8000-000000000001';
  const P_INTERN_1 = '50000000-0000-4000-8000-000000000002';
  const P_INTERN_2 = '50000000-0000-4000-8000-000000000003';
  const P_NEW = '50000000-0000-4000-8000-000000000004';
  const GRADE = '60000000-0000-4000-8000-000000000001';
  const LOCATION = '60000000-0000-4000-8000-000000000002';
  const policy = (id: string, code: string, revision: number, patch: Record<string, unknown>): { id: string; [field: string]: unknown } => ({
    id,
    code,
    revision,
    duration: 3,
    durationUnit: 'CALENDAR_MONTHS',
    startBasis: 'JOINING_DATE',
    employmentType: null,
    gradeName: null,
    locationName: null,
    effectiveFrom: '2000-01-01',
    effectiveTo: null,
    status: 'IN_FORCE',
    latest: true,
    latestCaseStart: null,
    version: 1,
    ...patch,
  });
  const APPLICABILITY = {
    employmentTypes: [
      { code: 'INTERN', label: 'Intern' },
      { code: 'PERMANENT', label: 'Permanent' },
    ],
    grades: [{ id: GRADE, code: 'G1', name: 'Grade one' }],
    locations: [{ id: LOCATION, code: 'HQ', name: 'Head office' }],
  };
  const LIST = () => ({
    items: [
      policy(P_DEFAULT, 'DEFAULT', 1, {}),
      policy(P_INTERN_1, 'INTERN_TERMS', 1, { duration: 1, employmentType: 'INTERN', effectiveTo: '2026-03-01', status: 'ENDED', latest: false, latestCaseStart: '2026-01-31', version: 2 }),
      policy(P_INTERN_2, 'INTERN_TERMS', 2, { duration: 45, durationUnit: 'CALENDAR_DAYS', employmentType: 'INTERN', effectiveFrom: '2026-03-01', version: 4, latestCaseStart: '2026-04-02' }),
    ],
    applicability: APPLICABILITY,
  });
  const POLICIES = '/v1/confirmation-policies';
  const OVERLAP = { error: 'POLICY_OVERLAP', message: 'Policy DEFAULT revision 1 applies equally to the same employees on overlapping dates; end it first, or change this policy’s applicability or dates' };

  function renderPolicies(permissions: string[] = [MANAGE_POLICIES], options: { client?: QueryClient; assignmentId?: string } = {}) {
    session.permissions = permissions;
    session.assignmentId = options.assignmentId ?? ASSIGNMENT_HR;
    session.employeeId = null;
    return render(
      <QueryClientProvider client={options.client ?? testClient()}>
        <MemoryRouter initialEntries={['/confirmations/policies']}>
          <ConfirmationPoliciesPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }
  const reads = () => callsTo('GET', POLICIES);
  const row = (table: HTMLElement, code: string, revision: number) =>
    within(table).getAllByRole('row').find((r) => r.textContent?.includes(code) && r.textContent.includes(`revision ${revision}`))!;
  const fillTerms = (form: HTMLElement, t: { duration: string; unit: string; from: string; to?: string }) => {
    fireEvent.change(within(form).getByLabelText('Duration'), { target: { value: t.duration } });
    fireEvent.change(within(form).getByLabelText('Unit'), { target: { value: t.unit } });
    fireEvent.change(within(form).getByLabelText('Takes effect on'), { target: { value: t.from } });
    if (t.to) fireEvent.change(within(form).getByLabelText('Ends on (optional)'), { target: { value: t.to } });
  };

  it('is a menu screen under the policy duty, reached from the confirmations page by those who hold it', async () => {
    expect(CONFIRMATION_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([['/confirmations/policies', 'Confirmation policies', MANAGE_POLICIES, true]]);
    serve();
    const hr = renderPage([READ, MANAGE_POLICIES]);
    expect((await screen.findByRole('link', { name: 'confirmation policies' })).getAttribute('href')).toBe('/confirmations/policies');
    hr.unmount();
    serve();
    renderPage([READ]);
    await screen.findByRole('tab', { name: /All/ });
    expect(screen.queryByRole('link', { name: 'confirmation policies' })).toBeNull();
  });

  it('lists every revision with what it says, where it stands and what can be done with it', async () => {
    serve({ [`GET ${POLICIES}`]: [200, LIST()] });
    renderPolicies();
    const table = await screen.findByRole('table', { name: 'Confirmation policies' });
    expect(cells(row(table, 'DEFAULT', 1)).slice(1, 8)).toEqual(['Every employee', '3 calendar months', 'Joining date', '1 Jan 2000', 'No end date', 'in force', 'None']);
    const old = row(table, 'INTERN_TERMS', 1);
    expect(cells(old).slice(1, 8)).toEqual(['INTERN', '1 calendar months', 'Joining date', '1 Jan 2000', '1 Mar 2026', 'ended', 'In use (latest start 31 Jan 2026)']);
    // A superseded, ended revision offers nothing; the latest offers a new revision and an end date.
    expect(within(old).queryByRole('button')).toBeNull();
    const latest = row(table, 'INTERN_TERMS', 2);
    expect(cells(latest).slice(1, 3)).toEqual(['INTERN', '45 calendar days']);
    expect(within(latest).getByRole('button', { name: 'New revision of INTERN_TERMS revision 2' })).toBeTruthy();
    expect(within(latest).getByRole('button', { name: 'End INTERN_TERMS revision 2' })).toBeTruthy();
  });

  it('says so without the duty, and asks the server nothing', async () => {
    serve({ [`GET ${POLICIES}`]: [200, LIST()] });
    renderPolicies([READ, MANAGE]);
    expect(await screen.findByText('The selected role cannot manage confirmation policies.')).toBeTruthy();
    await settle();
    expect(reads()).toHaveLength(0);
    expect(screen.queryByRole('form', { name: 'New policy' })).toBeNull();
  });

  it('tells a refusal of the list apart from having no policies', async () => {
    serve({ [`GET ${POLICIES}`]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    const refused = renderPolicies();
    expect(await screen.findByText('The selected role cannot manage confirmation policies.')).toBeTruthy();
    refused.unmount();
    serve({ [`GET ${POLICIES}`]: [200, { items: [], applicability: APPLICABILITY }] });
    renderPolicies();
    expect(await screen.findByText('No confirmation policies yet.')).toBeTruthy();
  });

  it('creates a policy with exactly the API’s body, once the required fields are filled, then starts a clean form', async () => {
    let list = LIST();
    serve({
      [`GET ${POLICIES}`]: () => [200, list],
      [`POST ${POLICIES}`]: () => {
        const created = policy(P_NEW, 'INTERN_HQ', 1, { duration: 5, employmentType: 'INTERN', locationName: 'Head office' });
        list = { ...list, items: [...list.items, created] };
        return [201, created];
      },
    });
    renderPolicies();
    const form = await screen.findByRole('form', { name: 'New policy' });
    const send = within(form).getByRole('button', { name: 'Create policy' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: '   ' } });
    fillTerms(form, { duration: '5', unit: 'CALENDAR_MONTHS', from: '2026-02-01' });
    fireEvent.click(send);
    expect(await within(form).findByText('Enter the policy code.')).toBeTruthy();
    expect(callsTo('POST', POLICIES)).toHaveLength(0);

    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'INTERN_HQ' } });
    fireEvent.change(within(form).getByLabelText('Employment type'), { target: { value: 'INTERN' } });
    fireEvent.change(within(form).getByLabelText('Location'), { target: { value: LOCATION } });
    fireEvent.click(send);
    await waitFor(() => expect(callsTo('POST', POLICIES)).toHaveLength(1));
    expect(callsTo('POST', POLICIES)[0]!.body).toEqual({
      code: 'INTERN_HQ',
      duration: 5,
      durationUnit: 'CALENDAR_MONTHS',
      startBasis: 'JOINING_DATE',
      effectiveFrom: '2026-02-01',
      employmentType: 'INTERN',
      locationId: LOCATION,
    });
    expect(await screen.findByText('Policy INTERN_HQ created.')).toBeTruthy();
    await waitFor(() => expect(row(screen.getByRole('table', { name: 'Confirmation policies' }), 'INTERN_HQ', 1)).toBeTruthy());
    expect((within(form).getByLabelText('Code') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Duration') as HTMLInputElement).value).toBe('');
  });

  it('sends a count from the joining day as day one only when asked, and lists it (I-84 item 12)', async () => {
    let list = LIST();
    serve({
      [`GET ${POLICIES}`]: () => [200, list],
      [`POST ${POLICIES}`]: () => {
        const created = { ...policy(P_NEW, 'CONTRACT_SIX', 1, { duration: 6 }), startDayInclusive: true };
        list = { ...list, items: [...list.items, created] };
        return [201, created];
      },
    });
    renderPolicies();
    const form = await screen.findByRole('form', { name: 'New policy' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'CONTRACT_SIX' } });
    fillTerms(form, { duration: '6', unit: 'CALENDAR_MONTHS', from: '2026-02-01' });
    fireEvent.click(within(form).getByLabelText(/Count the joining day as day one/));
    fireEvent.click(within(form).getByRole('button', { name: 'Create policy' }));
    await waitFor(() => expect(callsTo('POST', POLICIES)).toHaveLength(1));
    expect(callsTo('POST', POLICIES)[0]!.body).toEqual({ code: 'CONTRACT_SIX', duration: 6, durationUnit: 'CALENDAR_MONTHS', startBasis: 'JOINING_DATE', effectiveFrom: '2026-02-01', startDayInclusive: true });
    await waitFor(() => expect(row(screen.getByRole('table', { name: 'Confirmation policies' }), 'CONTRACT_SIX', 1)).toBeTruthy());
    expect(cells(row(screen.getByRole('table', { name: 'Confirmation policies' }), 'CONTRACT_SIX', 1))[3]).toBe('Joining date, counted as day one');
    expect((within(form).getByLabelText(/Count the joining day as day one/) as HTMLInputElement).checked).toBe(false);
  });

  it('leaves the rules to the server: its refusals are shown in its own plain words and what was typed stays', async () => {
    const refusals: [number, { error: string; message: string }][] = [
      [422, { error: 'INVALID_DURATION', message: 'The duration must be a whole number of calendar days or months greater than zero' }],
      [422, { error: 'INVALID_PERIOD', message: 'The end date must be after the start date' }],
      [409, OVERLAP],
    ];
    let next = 0;
    serve({ [`GET ${POLICIES}`]: [200, LIST()], [`POST ${POLICIES}`]: () => refusals[next++]! });
    renderPolicies();
    const form = await screen.findByRole('form', { name: 'New policy' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'BAD_TERMS' } });
    fillTerms(form, { duration: '0', unit: 'CALENDAR_DAYS', from: '2026-06-01', to: '2026-05-01' });
    const send = within(form).getByRole('button', { name: 'Create policy' });
    fireEvent.click(send);
    expect(await screen.findByText(refusals[0]![1].message)).toBeTruthy();
    expect(callsTo('POST', POLICIES)[0]!.body).toMatchObject({ duration: 0, effectiveFrom: '2026-06-01', effectiveTo: '2026-05-01' });
    fireEvent.click(send);
    expect(await screen.findByText(refusals[1]![1].message)).toBeTruthy();
    fireEvent.click(send);
    expect(await screen.findByText(OVERLAP.message)).toBeTruthy();
    expect(screen.queryByText(/POLICY_OVERLAP/)).toBeNull();
    expect((within(form).getByLabelText('Code') as HTMLInputElement).value).toBe('BAD_TERMS');
    expect((within(form).getByLabelText('Duration') as HTMLInputElement).value).toBe('0');
  });

  it('creates a revision from the latest one with its version, starting from its terms', async () => {
    let list = LIST();
    serve({
      [`GET ${POLICIES}`]: () => [200, list],
      [`POST ${POLICIES}/${P_INTERN_2}/revisions`]: () => {
        const created = policy(P_NEW, 'INTERN_TERMS', 3, { duration: 60, durationUnit: 'CALENDAR_DAYS', employmentType: 'INTERN', effectiveFrom: '2027-01-01', status: 'SCHEDULED' });
        list = {
          ...list,
          items: [...list.items.map((p) => (p.id === P_INTERN_2 ? { ...p, latest: false, effectiveTo: '2027-01-01', version: 5 } : p)), created],
        };
        return [201, { ...created, closedRevisionId: P_INTERN_2 }];
      },
    });
    renderPolicies();
    const table = await screen.findByRole('table', { name: 'Confirmation policies' });
    fireEvent.click(within(row(table, 'INTERN_TERMS', 2)).getByRole('button', { name: 'New revision of INTERN_TERMS revision 2' }));
    const form = await screen.findByRole('form', { name: 'New revision of INTERN_TERMS' });
    expect(screen.getByText(/The date must come after 2 Apr 2026/)).toBeTruthy();
    expect((within(form).getByLabelText('Duration') as HTMLInputElement).value).toBe('45');
    expect((within(form).getByLabelText('Unit') as HTMLSelectElement).value).toBe('CALENDAR_DAYS');
    expect(within(form).queryByLabelText('Employment type')).toBeNull();

    fireEvent.change(within(form).getByLabelText('Duration'), { target: { value: '60' } });
    fireEvent.change(within(form).getByLabelText('Takes effect on'), { target: { value: '2027-01-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create revision' }));
    await waitFor(() => expect(callsTo('POST', `${POLICIES}/${P_INTERN_2}/revisions`)).toHaveLength(1));
    expect(callsTo('POST', `${POLICIES}/${P_INTERN_2}/revisions`)[0]!.body).toEqual({
      duration: 60,
      durationUnit: 'CALENDAR_DAYS',
      startBasis: 'JOINING_DATE',
      effectiveFrom: '2027-01-01',
      expectedVersion: 4,
    });
    expect(await screen.findByText('INTERN_TERMS revision 3 created; it applies from 1 Jan 2027.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New revision of INTERN_TERMS' })).toBeNull();
    await waitFor(() => expect(cells(row(screen.getByRole('table', { name: 'Confirmation policies' }), 'INTERN_TERMS', 3))[6]).toBe('scheduled'));
  });

  it('reloads after a version conflict, keeps what was typed, and a retry uses the new version', async () => {
    let conflict = true;
    let list = LIST();
    serve({
      [`GET ${POLICIES}`]: () => [200, list],
      [`POST ${POLICIES}/${P_INTERN_2}/revisions`]: () => {
        if (conflict) {
          list = { ...list, items: list.items.map((p) => (p.id === P_INTERN_2 ? { ...p, version: 9 } : p)) };
          return [409, STALE];
        }
        return [201, policy(P_NEW, 'INTERN_TERMS', 3, {})];
      },
    });
    renderPolicies();
    const table = await screen.findByRole('table', { name: 'Confirmation policies' });
    fireEvent.click(within(row(table, 'INTERN_TERMS', 2)).getByRole('button', { name: 'New revision of INTERN_TERMS revision 2' }));
    const form = await screen.findByRole('form', { name: 'New revision of INTERN_TERMS' });
    fireEvent.change(within(form).getByLabelText('Takes effect on'), { target: { value: '2027-01-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Create revision' }));
    expect(await screen.findByText(STALE.message)).toBeTruthy();
    await waitFor(() => expect(reads().length).toBeGreaterThan(1));
    await settle();
    expect((within(form).getByLabelText('Takes effect on') as HTMLInputElement).value).toBe('2027-01-01');

    conflict = false;
    fireEvent.click(within(form).getByRole('button', { name: 'Create revision' }));
    await waitFor(() => expect(callsTo('POST', `${POLICIES}/${P_INTERN_2}/revisions`)).toHaveLength(2));
    expect(callsTo('POST', `${POLICIES}/${P_INTERN_2}/revisions`)[1]!.body).toMatchObject({ expectedVersion: 9 });
  });

  it('ends a policy with exactly the date and its version, and shows why a case in use refuses an earlier date', async () => {
    const IN_USE = { error: 'POLICY_IN_USE', message: 'A case opened under this policy starts on 2026-04-02; the end date must come after it' };
    let refuse = true;
    let list = LIST();
    serve({
      [`GET ${POLICIES}`]: () => [200, list],
      [`POST ${POLICIES}/${P_INTERN_2}/retire`]: () => {
        if (refuse) return [422, IN_USE];
        const ended = { ...list.items.find((p) => p.id === P_INTERN_2)!, effectiveTo: '2026-12-01', version: 5 };
        list = { ...list, items: list.items.map((p) => (p.id === P_INTERN_2 ? ended : p)) };
        return [200, ended];
      },
    });
    renderPolicies();
    const table = await screen.findByRole('table', { name: 'Confirmation policies' });
    fireEvent.click(within(row(table, 'INTERN_TERMS', 2)).getByRole('button', { name: 'End INTERN_TERMS revision 2' }));
    const form = await screen.findByRole('form', { name: 'End INTERN_TERMS revision 2' });
    const date = within(form).getByLabelText('End date');
    fireEvent.change(date, { target: { value: '2026-04-02' } });
    fireEvent.click(within(form).getByRole('button', { name: 'End policy' }));
    expect(await screen.findByText(IN_USE.message)).toBeTruthy();
    expect((date as HTMLInputElement).value).toBe('2026-04-02');

    refuse = false;
    fireEvent.change(date, { target: { value: '2026-12-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'End policy' }));
    await waitFor(() => expect(callsTo('POST', `${POLICIES}/${P_INTERN_2}/retire`)).toHaveLength(2));
    expect(callsTo('POST', `${POLICIES}/${P_INTERN_2}/retire`)[1]!.body).toEqual({ effectiveTo: '2026-12-01', expectedVersion: 4 });
    expect(await screen.findByText('INTERN_TERMS revision 2 ends on 1 Dec 2026.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'End INTERN_TERMS revision 2' })).toBeNull();
    await waitFor(() => expect(cells(row(screen.getByRole('table', { name: 'Confirmation policies' }), 'INTERN_TERMS', 2))[5]).toBe('1 Dec 2026'));
  });

  it('never shows a list answered for another role assignment, even from the cache', async () => {
    const client = testClient(15_000);
    serve({ [`GET ${POLICIES}`]: [200, LIST()] });
    const hr = renderPolicies([MANAGE_POLICIES], { client, assignmentId: ASSIGNMENT_HR });
    await screen.findByRole('table', { name: 'Confirmation policies' });
    hr.unmount();
    serve({ [`GET ${POLICIES}`]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    renderPolicies([MANAGE_POLICIES], { client, assignmentId: ASSIGNMENT_MANAGER });
    expect(screen.queryByRole('table', { name: 'Confirmation policies' })).toBeNull();
    expect(await screen.findByText('The selected role cannot manage confirmation policies.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Confirmation policies' })).toBeNull();
  });
});
