// Training screens (FR-049, FR-050; F1 "Training"; H3 TN17; I-26), jsdom: the plan register (views as returned, search
// and date filters, cost only when returned, zero distinct from no cost), new plans, changes and cancellation with a
// reason, participants (nomination, confirmation within capacity, attendance, completion, cancellation with a reason,
// never one's own), the feedback summary reconciled to participants with missing responses distinct and comments only
// when returned, and My ESS TN17 in the Employee OWN context (own participations, self-nomination, withdrawal, feedback
// with a required score 1 to 5 after completion; no attendance or completion for the employee). Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TRAINING_ESS_PANELS, TRAINING_SCREENS, TRAINING_TASK_QUEUES } from './training';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
  employeeId: '20000000-0000-4000-8000-000000000001' as string | null,
  roleCode: 'TRAINING_COORDINATOR',
  scopeKind: 'COMPANY',
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: session.userId,
      accountKey: 'syn.asha',
      companyName: 'Synthetic Co',
      roleCode: session.roleCode,
      roleName: session.roleCode,
      scopeKind: session.scopeKind,
      employeeId: session.employeeId,
      displayName: 'Asha Synthetic',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const PLAN_READ = 'training_plan.read.operational';
const PLAN_MANAGE = 'training_plan.manage.operational';
const PLAN_EXPORT = 'training_plan.export.operational';
const COST_READ = 'training_plan.read.cost';
const COST_MANAGE = 'training_plan.manage.cost';
const PART_READ = 'training_participant.read.operational';
const PART_MANAGE = 'training_participant.manage.operational';
const PART_ENROL = 'training_participant.enrol.operational';
const FB_READ = 'training_feedback.read.operational';
const FB_SUBMIT = 'training_feedback.submit.operational';
const FB_EXPORT = 'training_feedback.export.operational';
const COMMENT_READ = 'training_feedback.read.comment';
const COMMENT_SUBMIT = 'training_feedback.submit.comment';
const EMPLOYEE_LIST = 'employee.list.operational';
const COORDINATOR = [PLAN_READ, PLAN_MANAGE, PLAN_EXPORT, COST_READ, COST_MANAGE, PART_READ, PART_MANAGE, FB_READ, FB_EXPORT, EMPLOYEE_LIST];
const EMPLOYEE = [PART_READ, PART_ENROL, FB_READ, FB_SUBMIT, COMMENT_READ, COMMENT_SUBMIT];

const ASHA = { id: session.employeeId!, employeeCode: 'SYN-001', displayName: 'Asha Synthetic', status: 'ACTIVE_CONFIRMED' };
const RAVI = { id: '20000000-0000-4000-8000-000000000002', employeeCode: 'SYN-002', displayName: 'Ravi Synthetic', status: 'ACTIVE_CONFIRMED' };
const MEERA = { id: '20000000-0000-4000-8000-000000000003', employeeCode: 'SYN-003', displayName: 'Meera Synthetic', status: 'ACTIVE_PROBATION' };
const P_FUTURE = '30000000-0000-4000-8000-000000000001';
const P_CANCELLED = '30000000-0000-4000-8000-000000000002';
const P_PAST = '30000000-0000-4000-8000-000000000003';
const T_RAVI = '40000000-0000-4000-8000-000000000001';
const T_MEERA = '40000000-0000-4000-8000-000000000002';
const T_ASHA = '40000000-0000-4000-8000-000000000003';
const T_OWN_DONE = '40000000-0000-4000-8000-000000000004';
const AT = '2026-10-20T09:00:00.000Z';
const SLOW = { timeout: 4000 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Obj | undefined;
}
type RouteReply = [number, unknown] | ((call: Call) => [number, unknown] | undefined);

const IN_PERSON = { code: 'IN_PERSON', label: 'In person' };
const VIRTUAL = { code: 'VIRTUAL', label: 'Virtual' };
const OVERALL = { code: 'OVERALL', label: 'Overall rating of the training', position: 1 };
const plan = (id: string, code: string, patch: Obj = {}): Obj => ({
  id,
  code,
  title: `Synthetic course ${code}`,
  startDate: '2026-11-10',
  endDate: '2026-11-11',
  view: 'FUTURE',
  state: 'ACTIVE',
  mode: IN_PERSON,
  venue: 'Room 1 (synthetic)',
  trainer: 'Tess Trainer (synthetic)',
  capacity: 10,
  seatsTaken: 1,
  seatsAvailable: 9,
  nominationsPending: 2,
  owner: { employeeId: MEERA.id, employeeCode: MEERA.employeeCode, name: MEERA.displayName },
  selfNomination: true,
  cancellation: null,
  cost: { amount: '1500.00', currency: 'INR' },
  createdAt: AT,
  updatedAt: AT,
  version: 3,
  feedbackQuestions: [OVERALL],
  feedbackRecorded: false,
  ...patch,
});
const participant = (id: string, who: typeof ASHA, state: string, patch: Obj = {}): Obj => ({
  id,
  planId: P_FUTURE,
  employeeId: who.id,
  employeeCode: who.employeeCode,
  employeeName: who.displayName,
  state,
  selfNominated: false,
  nominatedAt: AT,
  confirmedAt: state === 'NOMINATED' ? null : AT,
  attendanceRecordedAt: null,
  completedAt: null,
  cancelledAt: null,
  cancellationReason: null,
  feedbackStatus: state === 'COMPLETED' ? 'MISSING' : 'NOT_APPLICABLE',
  version: 1,
  ...patch,
});
const summaryOf = (p: Obj) => ({ id: p.id, code: p.code, title: p.title, startDate: p.startDate, endDate: p.endDate, view: p.view, mode: p.mode, venue: p.venue, trainer: p.trainer, ownerName: p.owner.name });

let db: { plans: Map<string, Obj>; participants: Obj[]; ownFeedback: Obj[]; open: Obj[] };
let calls: Call[] = [];
let holds = new Map<string, Promise<void>>();
/** Which confidential groups the fake API answers with (the server decides; the screens render what is present). */
let groups = { cost: true, reason: false, comment: false };

function seed() {
  db = {
    plans: new Map([
      [P_FUTURE, plan(P_FUTURE, 'TRN-001')],
      [
        P_CANCELLED,
        plan(P_CANCELLED, 'TRN-002', {
          view: 'CANCELLED',
          state: 'CANCELLED',
          cost: null,
          cancellation: { cancelledAt: AT, cancelledBy: session.userId, reason: 'Venue closed (synthetic)', cancelledByName: 'Hema Synthetic' },
        }),
      ],
      [P_PAST, plan(P_PAST, 'TRN-003', { view: 'PAST', startDate: '2026-09-01', endDate: '2026-09-02', cost: { amount: '0.00', currency: 'INR' }, selfNomination: false })],
    ]),
    participants: [
      participant(T_RAVI, RAVI, 'NOMINATED'),
      participant(T_MEERA, MEERA, 'CANCELLED', { cancelledAt: AT, cancellationReason: 'Private matter (synthetic)' }),
      participant(T_ASHA, ASHA, 'CONFIRMED'),
    ],
    ownFeedback: [
      {
        participantId: T_OWN_DONE,
        completedAt: AT,
        status: 'MISSING',
        submittedAt: null,
        plan: { id: P_PAST, code: 'TRN-003', title: 'Synthetic course TRN-003', startDate: '2026-09-01', endDate: '2026-09-02', view: 'PAST' },
        questions: [OVERALL],
        answers: [],
      },
    ],
    open: [
      { ...summaryOf(plan(P_FUTURE, 'TRN-001')), startDate: '2026-11-10', endDate: '2026-11-11', myParticipation: null },
    ],
  };
}

const withoutGroups = (t: Obj) => {
  const { cancellationReason, ...rest } = t;
  return groups.reason ? { ...rest, cancellationReason } : rest;
};
const planOut = (p: Obj) => {
  const { cost, ...rest } = p;
  return groups.cost ? { ...rest, cost } : rest;
};

function fakeApi(call: Call): [number, unknown] {
  const { method, path, body } = call;
  const m = (re: RegExp) => re.exec(path);
  if (method === 'GET' && path === '/v1/training-modes') return [200, { items: [IN_PERSON, VIRTUAL] }];
  if (method === 'GET' && path === '/v1/training-feedback-questions') return [200, { items: [OVERALL] }];
  if (method === 'GET' && path === '/v1/training-plans') {
    const view = call.params.get('view');
    const items = [...db.plans.values()].filter((p) => !view || p.view === view).map(planOut);
    return [200, { items, total: items.length, page: 1, pageSize: 25, businessDate: '2026-10-28' }];
  }
  if (method === 'POST' && path === '/v1/training-plans') {
    const created = plan('30000000-0000-4000-8000-000000000099', String(body!.code).toUpperCase(), { title: body!.title, version: 1, seatsTaken: 0, nominationsPending: 0 });
    db.plans.set(created.id, created);
    return [201, planOut(created)];
  }
  let hit = m(/^\/v1\/training-plans\/([^/]+)$/);
  if (hit && method === 'GET') return db.plans.has(hit[1]!) ? [200, planOut(db.plans.get(hit[1]!)!)] : [404, { error: 'NOT_FOUND', message: 'Resource not found' }];
  if (hit && method === 'PATCH') {
    const p = db.plans.get(hit[1]!)!;
    const { expectedVersion: _v, ...changes } = body!;
    Object.assign(p, changes, { version: p.version + 1 });
    return [200, planOut(p)];
  }
  hit = m(/^\/v1\/training-plans\/([^/]+)\/cancel$/);
  if (hit && method === 'POST') {
    const p = db.plans.get(hit[1]!)!;
    Object.assign(p, { state: 'CANCELLED', view: 'CANCELLED', cancellation: { cancelledAt: AT, cancelledBy: session.userId, reason: body!.reason, cancelledByName: 'Asha Synthetic' } });
    return [200, { ...planOut(p), cancelledParticipations: 2, replayed: false }];
  }
  hit = m(/^\/v1\/training-plans\/([^/]+)\/participants$/);
  if (hit && method === 'GET') {
    const state = call.params.get('state');
    // One participant list serves every plan of the fixture.
    const items = db.participants.filter((t) => !state || t.state === state).map(withoutGroups);
    return [200, { items, total: items.length, page: 1, pageSize: 25, scope: { kind: 'COMPANY', companyWide: true } }];
  }
  if (hit && method === 'POST') {
    const added = (body!.employeeIds as string[]).map((id, i) => participant(`40000000-0000-4000-8000-00000000009${i}`, [ASHA, RAVI, MEERA].find((e) => e.id === id)!, 'NOMINATED'));
    db.participants.push(...added);
    return [201, { items: added.map(withoutGroups), nominated: added.length }];
  }
  hit = m(/^\/v1\/training-plans\/([^/]+)\/participant-actions$/);
  if (hit && method === 'POST') {
    const to: Obj = { CONFIRM: 'CONFIRMED', MARK_ATTENDED: 'ATTENDED', MARK_NO_SHOW: 'NO_SHOW', COMPLETE: 'COMPLETED', CANCEL: 'CANCELLED' };
    const rows = db.participants.filter((t) => (body!.participantIds as string[]).includes(t.id));
    for (const t of rows) t.state = to[body!.action];
    return [200, { action: body!.action, items: rows.map(withoutGroups), changed: rows.length, replayed: 0 }];
  }
  hit = m(/^\/v1\/training-plans\/([^/]+)\/feedback-summary$/);
  if (hit && method === 'GET') {
    const p = db.plans.get(hit[1]!)!;
    return [
      200,
      {
        plan: { id: p.id, code: p.code, title: p.title, startDate: p.startDate, endDate: p.endDate, view: p.view },
        scope: { kind: 'COMPANY', companyWide: true },
        generatedAt: AT,
        participants: { total: 4, byState: { NOMINATED: 0, CONFIRMED: 0, ATTENDED: 0, COMPLETED: 3, NO_SHOW: 1, CANCELLED: 0 } },
        feedback: { eligible: 3, responded: 2, missing: 1, notApplicable: 1 },
        questions: [{ code: 'OVERALL', label: OVERALL.label, position: 1, answered: 2, scores: { '1': 0, '2': 0, '3': 1, '4': 0, '5': 1 }, missing: 1 }],
        reconciles: { participants: true, responses: true, questions: true },
      },
    ];
  }
  hit = m(/^\/v1\/training-plans\/([^/]+)\/feedback$/);
  if (hit && method === 'GET') {
    const p = db.plans.get(hit[1]!)!;
    const answer = (score: number, comment: string) => (groups.comment ? { questionCode: 'OVERALL', score, comment } : { questionCode: 'OVERALL', score });
    return [
      200,
      {
        plan: { id: p.id, code: p.code, title: p.title, startDate: p.startDate, endDate: p.endDate, view: p.view },
        questions: [OVERALL],
        scope: { kind: 'COMPANY', companyWide: true },
        commentsIncluded: groups.comment,
        items: [
          { participantId: T_RAVI, employeeId: RAVI.id, employeeCode: RAVI.employeeCode, employeeName: RAVI.displayName, state: 'COMPLETED', completedAt: AT, feedbackStatus: 'RESPONDED', submittedAt: AT, answers: [answer(5, 'Very useful (synthetic narrative)')] },
          { participantId: T_MEERA, employeeId: MEERA.id, employeeCode: MEERA.employeeCode, employeeName: MEERA.displayName, state: 'COMPLETED', completedAt: AT, feedbackStatus: 'MISSING', submittedAt: null, answers: [] },
        ],
      },
    ];
  }
  if (method === 'GET' && path === '/v1/employees') return [200, { items: [RAVI, MEERA], total: 2 }];
  hit = m(/^\/v1\/employees\/([^/]+)\/training$/);
  if (hit && method === 'GET') {
    const own = [
      { ...withoutGroups(participant('40000000-0000-4000-8000-000000000011', ASHA, 'NOMINATED', { selfNominated: true })), plan: summaryOf(db.plans.get(P_FUTURE)!) },
      { ...withoutGroups(participant(T_OWN_DONE, ASHA, 'COMPLETED', { completedAt: AT, attendanceRecordedAt: AT })), plan: summaryOf(db.plans.get(P_PAST)!) },
    ];
    return [200, { items: hit[1] === ASHA.id ? own : [], businessDate: '2026-10-28' }];
  }
  if (method === 'GET' && path === '/v1/me/training-plans') return [200, { items: db.open, businessDate: '2026-10-28' }];
  if (method === 'POST' && path === '/v1/me/training-nominations') {
    db.open = db.open.map((p) => (p.id === body!.planId ? { ...p, myParticipation: { participantId: '40000000-0000-4000-8000-000000000012', state: 'NOMINATED', selfNominated: true } } : p));
    return [201, participant('40000000-0000-4000-8000-000000000012', ASHA, 'NOMINATED', { selfNominated: true })];
  }
  hit = m(/^\/v1\/me\/training-nominations\/([^/]+)\/withdraw$/);
  if (hit && method === 'POST') return [200, { ...participant(hit[1]!, ASHA, 'CANCELLED'), replayed: false }];
  if (method === 'GET' && path === '/v1/me/training-feedback') return [200, { items: db.ownFeedback }];
  if (method === 'POST' && path === '/v1/me/training-feedback') {
    const f = db.ownFeedback.find((x) => x.participantId === body!.participantId)!;
    Object.assign(f, { status: 'RESPONDED', submittedAt: AT, answers: body!.answers });
    return [201, { participantId: f.participantId, status: 'RESPONDED', submittedAt: AT, answers: body!.answers, replayed: false }];
  }
  return [404, { error: 'NOT_FOUND', message: `No mock for ${method} ${path}` }];
}

function serve(overrides: Record<string, RouteReply> = {}) {
  seed();
  calls = [];
  holds = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const held = holds.get(key);
      if (held) await held;
      const route = overrides[key];
      const reply = (route === undefined ? undefined : typeof route === 'function' ? route(call) : route) ?? fakeApi(call);
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}

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

const refuse = (status: number, error: string, details?: unknown): [number, unknown] => [status, { error, message: error, ...(details ? { details } : {}) }];
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodiesTo = (method: string, path: string) => callsTo(method, path).map((c) => c.body);
const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

function selectContext(permissions: string[], own = false) {
  session.permissions = permissions;
  session.roleCode = own ? 'EMPLOYEE' : 'TRAINING_COORDINATOR';
  session.scopeKind = own ? 'OWN' : 'COMPANY';
}

function renderAt(entry: string, permissions: string[]) {
  selectContext(permissions);
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {TRAINING_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderPanel(permissions: string[], own = true) {
  selectContext(permissions, own);
  const Panel = TRAINING_ESS_PANELS[0]!.component;
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter>
        <Panel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const findSection = async (heading: string | RegExp) => (await screen.findByRole('heading', { name: heading })).closest('section') as HTMLElement;
const button = (scope: HTMLElement, name: string | RegExp) => within(scope).getByRole('button', { name }) as HTMLButtonElement;
const change = (scope: HTMLElement, label: string | RegExp, value: string) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const valueOf = (scope: HTMLElement, label: string | RegExp) => (within(scope).getByLabelText(label) as HTMLInputElement).value;
const alertText = (scope: HTMLElement = document.body) =>
  within(scope)
    .queryAllByRole('alert')
    .map((a) => a.textContent)
    .join(' | ');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  groups = { cost: true, reason: false, comment: false };
});

describe('exports for the navigation step', () => {
  it('offers the plan, feedback, participation and employee screens, the TN17 panel and no decision queue', () => {
    expect(TRAINING_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([
      ['/training/plans', 'Training plans', PLAN_READ, true],
      ['/training/plans/:id', 'Training plan', PLAN_READ, false],
      ['/training/plans/:id/feedback', 'Training feedback', FB_READ, false],
      ['/training/participants/:id', 'Training participation', PART_READ, false],
      ['/training/employees/:id', 'Employee’s training', PART_READ, false],
    ]);
    expect(TRAINING_ESS_PANELS.map((p) => p.tabId)).toEqual(['TN17']);
    // I-26: no approval workflow, so the module has no task route to queue.
    expect(TRAINING_TASK_QUEUES).toEqual([]);
  });
});

describe('the plan register', () => {
  it('shows the view exactly as returned, the exact cost (zero distinct from no cost) and filters by view', async () => {
    serve();
    renderAt('/training/plans', COORDINATOR);
    const table = await screen.findByRole('table', { name: 'Training plans' });
    const row = (code: string) => within(table).getByText(code).closest('tr')!.textContent ?? '';
    expect(row('TRN-001')).toContain('Future');
    expect(row('TRN-001')).toContain('INR 1,500.00');
    expect(row('TRN-001')).toContain('1 of 10 taken · 2 waiting for confirmation');
    expect(row('TRN-002')).toContain('Cancelled');
    expect(row('TRN-002')).toContain('No cost recorded');
    expect(row('TRN-003')).toContain('Past');
    expect(row('TRN-003')).toContain('INR 0.00');
    expect(callsTo('GET', '/v1/training-plans')[0]!.params.toString()).toBe('page=1&pageSize=25');
    expect(screen.getByText(/business date \(28 Oct 2026\)/).textContent).toContain('cancelled whatever its dates');

    const filters = screen.getByRole('form', { name: 'Filter the plans' });
    change(filters, 'View', 'CANCELLED');
    change(filters, 'From', '2026-10-01');
    await waitFor(() => expect(callsTo('GET', '/v1/training-plans').some((c) => c.params.toString() === 'view=CANCELLED&from=2026-10-01&page=1&pageSize=25')).toBe(true));
    change(filters, 'Search', 'safety');
    fireEvent.click(button(filters, 'Search'));
    await waitFor(() => expect(callsTo('GET', '/v1/training-plans').some((c) => c.params.get('search') === 'safety' && c.params.get('view') === 'CANCELLED')).toBe(true));
  });

  it('renders no cost when the API leaves it out, and hides creation and export without their keys', async () => {
    groups.cost = false;
    serve();
    renderAt('/training/plans', [PLAN_READ]);
    const table = await screen.findByRole('table', { name: 'Training plans' });
    expect(within(table).queryByText('Cost')).toBeNull();
    expect(table.textContent).not.toContain('INR');
    expect(table.textContent).not.toContain('No cost');
    expect(screen.queryByRole('form', { name: 'New training plan' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
  });

  it('says the role is not permitted and fetches nothing without the read key', () => {
    serve();
    renderAt('/training/plans', [PART_READ]);
    expect(screen.getByRole('note').textContent).toContain('cannot read training plans');
    expect(calls).toHaveLength(0);
  });

  it('creates a plan with the exact body, resets the form, and keeps what was typed after a refusal', async () => {
    serve({ 'POST /v1/training-plans': (c) => (c.body!.code === 'TRN-001' ? [409, { error: 'PLAN_CODE_EXISTS', message: 'exists' }] : undefined) });
    renderAt('/training/plans', COORDINATOR);
    const form = await screen.findByRole('form', { name: 'New training plan' });
    await waitFor(() => expect(within(form).getByRole('option', { name: 'Virtual' })).toBeTruthy());
    change(form, 'Plan code', 'TRN-001');
    change(form, 'Course title', 'Synthetic fire safety');
    change(form, 'Start date', '2026-11-20');
    change(form, 'End date', '2026-11-19');
    change(form, 'Mode', 'VIRTUAL');
    change(form, 'Capacity (places)', '12');
    change(form, /^Cost \(optional/, '0');
    fireEvent.click(button(form, 'Make me the owner'));
    fireEvent.click(button(form, 'Create the plan'));
    expect(alertText()).toContain('The end date cannot be before the start date.');
    expect(callsTo('POST', '/v1/training-plans')).toHaveLength(0);

    change(form, 'End date', '2026-11-21');
    fireEvent.click(button(form, 'Create the plan'));
    await waitFor(() => expect(alertText()).toContain('A plan with this code already exists. Plan codes are permanent and never reused.'));
    expect(valueOf(form, 'Course title')).toBe('Synthetic fire safety');
    expect(bodiesTo('POST', '/v1/training-plans')[0]).toEqual({
      code: 'TRN-001',
      title: 'Synthetic fire safety',
      startDate: '2026-11-20',
      endDate: '2026-11-21',
      modeCode: 'VIRTUAL',
      capacity: 12,
      ownerEmployeeId: ASHA.id,
      selfNomination: false,
      cost: { amount: '0', currency: 'INR' },
    });

    change(form, 'Plan code', 'TRN-009');
    fireEvent.click(within(form).getByLabelText('Overall rating of the training'));
    fireEvent.click(within(form).getByLabelText('Employees may nominate themselves'));
    fireEvent.click(button(form, 'Create the plan'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('TRN-009 was created'));
    expect(bodiesTo('POST', '/v1/training-plans')[1]).toMatchObject({ code: 'TRN-009', selfNomination: true, feedbackQuestionCodes: ['OVERALL'] });
    expect(valueOf(form, 'Course title')).toBe('');
    expect(valueOf(form, 'Plan code')).toBe('');
  });

  it('offers no cost fields without the cost permission and sends no cost', async () => {
    serve();
    renderAt('/training/plans', COORDINATOR.filter((k) => k !== COST_MANAGE));
    const form = await screen.findByRole('form', { name: 'New training plan' });
    expect(within(form).queryByLabelText(/^Cost/)).toBeNull();
    expect(within(form).queryByLabelText('Cost currency')).toBeNull();
  });
});

describe('one plan', () => {
  it('shows a cancelled plan with its reason and offers no change, cancellation, nomination or actions', async () => {
    serve();
    renderAt(`/training/plans/${P_CANCELLED}`, COORDINATOR);
    const facts = await findSection('Synthetic course TRN-002 (TRN-002)');
    expect(facts.textContent).toContain('Cancelled');
    expect(facts.textContent).toContain('by Hema Synthetic. Reason: Venue closed (synthetic)');
    expect(facts.textContent).toContain('No cost recorded');
    expect(facts.textContent).toContain('A cancelled plan is final');
    await screen.findByRole('table', { name: 'Participants' });
    expect(screen.queryByRole('form', { name: 'Change the plan' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Cancel the plan' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Participation actions' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Nominate employees' })).toBeNull();
  });

  it('cancels a plan only with a reason, sending the version it was loaded at', async () => {
    serve();
    renderAt(`/training/plans/${P_FUTURE}`, COORDINATOR);
    const form = await screen.findByRole('form', { name: 'Cancel the plan' });
    fireEvent.click(button(form, 'Cancel the plan'));
    expect(alertText()).toContain('Record why the plan is cancelled.');
    expect(callsTo('POST', `/v1/training-plans/${P_FUTURE}/cancel`)).toHaveLength(0);
    change(form, 'Reason for cancelling', 'Trainer unavailable (synthetic)');
    fireEvent.click(button(form, 'Cancel the plan'));
    await waitFor(() => expect(bodiesTo('POST', `/v1/training-plans/${P_FUTURE}/cancel`)).toEqual([{ reason: 'Trainer unavailable (synthetic)', expectedVersion: 3 }]));
    await waitFor(() => expect(screen.getByText(/A cancelled plan is final/)).toBeTruthy());
  });

  it('sends only the changed fields with the expected version, and shows the capacity refusal in words', async () => {
    serve({ 'PATCH /v1/training-plans/30000000-0000-4000-8000-000000000001': (c) => (c.body!.capacity === 0 || c.body!.capacity === 1 ? refuse(409, 'CAPACITY_BELOW_SEATS', { seatsTaken: 2 }) as [number, unknown] : undefined) });
    renderAt(`/training/plans/${P_FUTURE}`, COORDINATOR);
    const form = await screen.findByRole('form', { name: 'Change the plan' });
    fireEvent.click(button(form, 'Save the changes'));
    expect(alertText()).toContain('Nothing was changed.');
    change(form, 'Capacity (places)', '1');
    fireEvent.click(button(form, 'Save the changes'));
    await waitFor(() => expect(alertText()).toContain('The capacity cannot be lower than the 2 places already taken.'));
    expect(valueOf(form, 'Capacity (places)')).toBe('1');
    change(form, 'Capacity (places)', '12');
    fireEvent.click(button(form, 'Save the changes'));
    await waitFor(() => expect(bodiesTo('PATCH', `/v1/training-plans/${P_FUTURE}`)[1]).toEqual({ expectedVersion: 3, capacity: 12 }));
    await waitFor(() => expect(screen.getByText('The plan was saved.')).toBeTruthy());
  });
});

describe('participants', () => {
  it('confirms the selected nominations, disables the actions while in flight, and never offers one’s own participation', async () => {
    serve();
    const release = hold(`POST /v1/training-plans/${P_FUTURE}/participant-actions`);
    renderAt(`/training/plans/${P_FUTURE}`, COORDINATOR);
    const table = await screen.findByRole('table', { name: 'Participants' });
    expect(within(table).getByText('Asha Synthetic (SYN-001)').closest('tr')!.textContent).toContain('another coordinator records it');
    expect(within(table).queryByLabelText('Select Asha Synthetic (SYN-001)')).toBeNull();
    expect(within(table).getByText('Ravi Synthetic (SYN-002)').closest('tr')!.textContent).toContain('Nominated, waiting for confirmation');
    fireEvent.click(within(table).getByLabelText('Select Ravi Synthetic (SYN-002)'));
    const actions = screen.getByRole('group', { name: 'Participation actions' });
    fireEvent.click(button(actions, 'Confirm'));
    await waitFor(() => expect(button(actions, 'Confirm').disabled).toBe(true));
    expect(button(actions, 'Mark completed').disabled).toBe(true);
    release();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 participation confirmed.'));
    expect(bodiesTo('POST', `/v1/training-plans/${P_FUTURE}/participant-actions`)).toEqual([{ action: 'CONFIRM', participantIds: [T_RAVI] }]);
    await waitFor(() => expect(button(actions, 'Confirm').disabled).toBe(false));
  });

  it('drops the selection when the state filter changes, so an action never reaches rows no longer shown', async () => {
    serve();
    renderAt(`/training/plans/${P_FUTURE}`, COORDINATOR);
    let table = await screen.findByRole('table', { name: 'Participants' });
    fireEvent.click(within(table).getByLabelText('Select Ravi Synthetic (SYN-002)'));
    expect((within(table).getByLabelText('Select Ravi Synthetic (SYN-002)') as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText('Participation state'), { target: { value: 'NOMINATED' } });
    await waitFor(() => expect(callsTo('GET', `/v1/training-plans/${P_FUTURE}/participants`).some((c) => c.params.get('state') === 'NOMINATED')).toBe(true));
    table = await screen.findByRole('table', { name: 'Participants' });
    await waitFor(() => expect((within(table).getByLabelText('Select Ravi Synthetic (SYN-002)') as HTMLInputElement).checked).toBe(false));
    const actions = screen.getByRole('group', { name: 'Participation actions' });
    fireEvent.click(button(actions, 'Confirm'));
    expect(alertText(actions)).toContain('Select the participations first.');
    expect(callsTo('POST', `/v1/training-plans/${P_FUTURE}/participant-actions`)).toHaveLength(0);
  });

  it('says in words when the plan is full, and needs a reason to cancel', async () => {
    serve({ [`POST /v1/training-plans/${P_FUTURE}/participant-actions`]: (c) => (c.body!.action === 'CONFIRM' ? refuse(409, 'PLAN_FULL', { capacity: 1, seatsTaken: 1, requested: 1 }) as [number, unknown] : undefined) });
    renderAt(`/training/plans/${P_FUTURE}`, COORDINATOR);
    const table = await screen.findByRole('table', { name: 'Participants' });
    fireEvent.click(within(table).getByLabelText('Select Ravi Synthetic (SYN-002)'));
    const actions = screen.getByRole('group', { name: 'Participation actions' });
    fireEvent.click(button(actions, 'Confirm'));
    await waitFor(() => expect(alertText(actions)).toContain('The plan is full: 1 of 1 places are taken and 1 confirmation was asked for.'));
    fireEvent.click(button(actions, 'Cancel participation'));
    expect(alertText(actions)).toContain('Record why the participation is cancelled.');
    expect(bodiesTo('POST', `/v1/training-plans/${P_FUTURE}/participant-actions`)).toHaveLength(1);
    change(actions, /^Reason/, 'Duplicate booking (synthetic)');
    fireEvent.click(button(actions, 'Cancel participation'));
    await waitFor(() => expect(bodiesTo('POST', `/v1/training-plans/${P_FUTURE}/participant-actions`)[1]).toEqual({ action: 'CANCEL', participantIds: [T_RAVI], reason: 'Duplicate booking (synthetic)' }));
  });

  it('shows participation reasons only when the API returns them', async () => {
    serve();
    const first = renderAt(`/training/plans/${P_FUTURE}`, COORDINATOR);
    let table = await screen.findByRole('table', { name: 'Participants' });
    expect(table.textContent).not.toContain('Cancellation reason');
    expect(table.textContent).not.toContain('Private matter');
    first.unmount();
    groups.reason = true;
    renderAt(`/training/plans/${P_FUTURE}`, [...COORDINATOR, 'training_participant.read.reason']);
    table = await screen.findByRole('table', { name: 'Participants' });
    expect(within(table).getByText('Meera Synthetic (SYN-003)').closest('tr')!.textContent).toContain('Private matter (synthetic)');
  });

  it('offers no attendance, completion or nomination without the manage key', async () => {
    serve();
    renderAt(`/training/plans/${P_FUTURE}`, [PLAN_READ, PART_READ]);
    await screen.findByRole('table', { name: 'Participants' });
    expect(screen.queryByRole('group', { name: 'Participation actions' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Mark attended' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Nominate employees' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Change the plan' })).toBeNull();
  });

  it('nominates the chosen employees and names the one who already takes part', async () => {
    let first = true;
    serve({
      [`POST /v1/training-plans/${P_FUTURE}/participants`]: () => {
        if (!first) return undefined;
        first = false;
        return refuse(409, 'PARTICIPANT_EXISTS', { employeeId: RAVI.id, participantId: T_RAVI, state: 'NOMINATED' }) as [number, unknown];
      },
    });
    renderAt(`/training/plans/${P_FUTURE}`, COORDINATOR);
    const section = await findSection('Nominate employees');
    expect(button(section, 'Nominate').disabled).toBe(true);
    change(section, 'Find an employee to nominate', 'syn');
    fireEvent.click(await within(section).findByRole('button', { name: 'Choose Ravi Synthetic (SYN-002)' }, SLOW));
    change(section, 'Find an employee to nominate', 'mee');
    fireEvent.click(await within(section).findByRole('button', { name: 'Choose Meera Synthetic (SYN-003)' }, SLOW));
    fireEvent.click(button(section, 'Nominate 2 employees'));
    await waitFor(() => expect(alertText(section)).toContain('Ravi Synthetic (SYN-002) already takes part in this training (nominated, waiting for confirmation).'));
    expect(within(section).getByRole('list', { name: 'Chosen employees' }).textContent).toContain('Meera Synthetic');
    fireEvent.click(button(section, 'Remove Ravi Synthetic (SYN-002)'));
    fireEvent.click(button(section, 'Nominate 1 employee'));
    await waitFor(() => expect(within(section).getByRole('status').textContent).toContain('1 employee was nominated.'));
    expect(bodiesTo('POST', `/v1/training-plans/${P_FUTURE}/participants`)).toEqual([{ employeeIds: [RAVI.id, MEERA.id] }, { employeeIds: [MEERA.id] }]);
    expect(within(section).queryByRole('list', { name: 'Chosen employees' })).toBeNull();
  });
});

describe('the feedback summary', () => {
  it('reconciles to the participants, shows missing responses distinctly and no comments when the API omits them', async () => {
    serve();
    renderAt(`/training/plans/${P_FUTURE}/feedback`, COORDINATOR);
    const counts = await screen.findByLabelText('Response counts');
    expect(counts.textContent).toContain('Completed (feedback expected)3');
    expect(counts.textContent).toContain('1 missing');
    expect(counts.textContent).toContain('Reconciles to the participantsYes');
    const scores = screen.getByRole('table', { name: 'Scores by question' });
    expect(within(scores).getByText(OVERALL.label).closest('tr')!.textContent).toBe(`${OVERALL.label}2001011`);
    const responses = await screen.findByRole('table', { name: 'Feedback responses' });
    expect(within(responses).getByText('Meera Synthetic (SYN-003)').closest('tr')!.textContent).toContain('Missing response');
    expect(within(responses).getByText('Ravi Synthetic (SYN-002)').closest('tr')!.textContent).toContain('Score 5');
    expect(responses.textContent).not.toContain('Comment');
    expect(screen.getByText(/Comments are confidential/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export scores (CSV)' })).toBeTruthy();
  });

  it('says the role is not permitted and fetches nothing with the feedback read but without the plan read', () => {
    serve();
    renderAt(`/training/plans/${P_FUTURE}/feedback`, EMPLOYEE);
    expect(screen.getByRole('note').textContent).toContain('The selected role cannot read training feedback.');
    expect(calls).toHaveLength(0);
  });

  it('shows a comment only when the API returns it to the caller', async () => {
    groups.comment = true;
    serve();
    renderAt(`/training/plans/${P_FUTURE}/feedback`, [PLAN_READ, FB_READ, COMMENT_READ]);
    const responses = await screen.findByRole('table', { name: 'Feedback responses' });
    expect(responses.textContent).toContain('Comment: Very useful (synthetic narrative)');
    expect(screen.queryByRole('button', { name: /Export/ })).toBeNull();
  });
});

describe('My ESS TN17', () => {
  it('asks for the Employee role outside the own context and fetches nothing', () => {
    serve();
    renderPanel(EMPLOYEE, false);
    expect(screen.getByText('Select your Employee role to see your own training.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('lists own participations with their state, offers no attendance or completion, and withdraws an own nomination with a reason', async () => {
    serve();
    renderPanel(EMPLOYEE);
    const table = await screen.findByRole('table', { name: 'My training' });
    expect(callsTo('GET', `/v1/employees/${ASHA.id}/training`)).toHaveLength(1);
    const pending = within(table).getByText(/Synthetic course TRN-001/).closest('tr')!;
    expect(pending.textContent).toContain('You nominated yourself');
    expect(pending.textContent).toContain('Nominated, waiting for confirmation');
    expect(within(table).getByText(/Synthetic course TRN-003/).closest('tr')!.textContent).toContain('Completed');
    expect(screen.queryByRole('button', { name: /Mark|Confirm/ })).toBeNull();
    expect(table.textContent).not.toContain('Cancellation reason');

    fireEvent.click(within(pending).getByRole('button', { name: 'Withdraw from Synthetic course TRN-001' }));
    const form = within(pending).getByRole('form', { name: 'Withdraw from Synthetic course TRN-001' });
    fireEvent.click(button(form, 'Withdraw my nomination'));
    expect(alertText(form)).toContain('Record why you withdraw.');
    change(form, 'Why you withdraw', 'Schedule conflict (synthetic)');
    fireEvent.click(button(form, 'Withdraw my nomination'));
    await waitFor(() => expect(bodiesTo('POST', '/v1/me/training-nominations/40000000-0000-4000-8000-000000000011/withdraw')).toEqual([{ reason: 'Schedule conflict (synthetic)' }]));
  });

  it('nominates oneself for an open plan, and says in words when the coordinator cancelled the place', async () => {
    let first = true;
    serve({
      'POST /v1/me/training-nominations': () => {
        if (!first) return undefined;
        first = false;
        return refuse(409, 'CANCELLED_BY_COORDINATOR') as [number, unknown];
      },
    });
    renderPanel(EMPLOYEE);
    const open = await screen.findByRole('table', { name: 'Open training' });
    fireEvent.click(within(open).getByRole('button', { name: 'Nominate myself for Synthetic course TRN-001' }));
    await waitFor(() => expect(alertText()).toContain('Your participation was cancelled by the training coordinator. Ask them to nominate you again.'));
    fireEvent.click(within(open).getByRole('button', { name: 'Nominate myself for Synthetic course TRN-001' }));
    await waitFor(() => expect(screen.getByText(/You nominated yourself for Synthetic course TRN-001/)).toBeTruthy());
    expect(bodiesTo('POST', '/v1/me/training-nominations')).toEqual([{ planId: P_FUTURE }, { planId: P_FUTURE }]);
    await waitFor(() => expect(within(open).queryByRole('button', { name: /Nominate myself/ })).toBeNull());
  });

  it('gives feedback after completion with a required score and an optional comment, once', async () => {
    let first = true;
    serve({
      'POST /v1/me/training-feedback': () => {
        if (!first) return undefined;
        first = false;
        return refuse(409, 'FEEDBACK_ALREADY_SUBMITTED') as [number, unknown];
      },
    });
    renderPanel(EMPLOYEE);
    const form = await screen.findByRole('form', { name: 'Give feedback for Synthetic course TRN-003' });
    change(form, /Comment on Overall/, 'Clear and practical (synthetic)');
    fireEvent.click(button(form, 'Send my feedback'));
    expect(alertText(form)).toContain('Give a score from 1 to 5 for each question.');
    expect(callsTo('POST', '/v1/me/training-feedback')).toHaveLength(0);
    change(form, /Score for Overall/, '4');
    fireEvent.click(button(form, 'Send my feedback'));
    await waitFor(() => expect(alertText(form)).toContain('Your feedback for this training was already recorded and cannot be changed.'));
    expect(valueOf(form, /Comment on Overall/)).toBe('Clear and practical (synthetic)');
    fireEvent.click(button(form, 'Send my feedback'));
    await waitFor(() => expect(screen.getByText(/Your feedback for Synthetic course TRN-003 was recorded/)).toBeTruthy());
    const body = { participantId: T_OWN_DONE, answers: [{ questionCode: 'OVERALL', score: 4, comment: 'Clear and practical (synthetic)' }] };
    expect(bodiesTo('POST', '/v1/me/training-feedback')).toEqual([body, body]);
    const answers = await screen.findByRole('list', { name: 'My answers for Synthetic course TRN-003' });
    expect(answers.textContent).toContain('score 4. My comment: Clear and practical (synthetic)');
    expect(screen.queryByRole('form', { name: /Give feedback/ })).toBeNull();
  });

  it('offers no comment field without the comment permission and sends the scores only', async () => {
    serve();
    renderPanel(EMPLOYEE.filter((k) => k !== COMMENT_SUBMIT));
    const form = await screen.findByRole('form', { name: 'Give feedback for Synthetic course TRN-003' });
    expect(within(form).queryByLabelText(/Comment on/)).toBeNull();
    change(form, /Score for Overall/, '2');
    fireEvent.click(button(form, 'Send my feedback'));
    await waitFor(() => expect(bodiesTo('POST', '/v1/me/training-feedback')).toEqual([{ participantId: T_OWN_DONE, answers: [{ questionCode: 'OVERALL', score: 2 }] }]));
  });
});
