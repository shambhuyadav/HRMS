// Timesheet screens (FR-045 to FR-048; F1 "Timesheets"; BR-048; BR-049; H3 TN13; I-30), jsdom: masters (a new project
// and activity with the exact bodies, the productive flag chosen explicitly, job-activity links), allocations (the
// API's over-allocation refusal and the manager's exception reason, cancellation with a reason), the manager's
// decision queue and the independent reopen queue with one idempotency key per decision, a timesheet's revisions,
// reopen requests, missed-submission follow-ups, reports exactly as returned (N/A, not configured) and the TN13 panel
// (own weeks, lines in quarter hours from own allocations, the API's 24-hour and duplicate refusals, late submission),
// and the allocation and timesheet-line imports (upload, row-by-row preview, commit or cancel, a file held for the
// malware scan checked again through the resume route, a quarantined file refused, the user's own batches listed and
// opened again). Controls are hidden without their permission keys and nothing cached for one role assignment is shown
// under another. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TIMESHEET_ESS_PANELS, TIMESHEET_SCREENS, TIMESHEET_TASK_QUEUES } from './timesheet';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: 'b0000000-0000-4000-8000-000000000001',
      accountKey: 'syn.asha',
      companyName: 'Synthetic Co',
      roleCode: 'EMPLOYEE',
      roleName: 'Employee',
      scopeKind: 'OWN',
      employeeId: '20000000-0000-4000-8000-000000000001',
      displayName: 'Asha Synthetic',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const MASTER_READ = 'timesheet_master.read.operational';
const MASTER_MANAGE = 'timesheet_master.manage.operational';
const ALLOC_READ = 'timesheet_allocation.read.operational';
const ALLOC_MANAGE = 'timesheet_allocation.manage.operational';
const TS_SUBMIT = 'timesheet.submit.operational';
const TS_READ = 'timesheet.read.operational';
const TS_APPROVE = 'timesheet.approve.operational';
const TS_REQUEST_REOPEN = 'timesheet.request_reopen.operational';
const TS_REOPEN = 'timesheet.reopen.operational';
const TS_RESOLVE = 'timesheet.resolve_exception.operational';
const TS_REPORT = 'timesheet.report.operational';
const ALLOC_IMPORT = 'timesheet_allocation.import.operational';
const TS_IMPORT = 'timesheet.import.operational';

const ASHA = '20000000-0000-4000-8000-000000000001';
const RAVI = '20000000-0000-4000-8000-000000000002';
const P1 = '30000000-0000-4000-8000-000000000001';
const J1 = '31000000-0000-4000-8000-000000000001';
const J2 = '31000000-0000-4000-8000-000000000002';
const A_DEV = '32000000-0000-4000-8000-000000000001';
const A_MEET = '32000000-0000-4000-8000-000000000002';
const A_QA = '32000000-0000-4000-8000-000000000003';
const AL1 = '33000000-0000-4000-8000-000000000001';
const S_DRAFT = '34000000-0000-4000-8000-000000000001';
const S_APPROVED = '34000000-0000-4000-8000-000000000002';
const L1 = '35000000-0000-4000-8000-000000000001';
const T1 = '36000000-0000-4000-8000-000000000001';
const RT1 = '36000000-0000-4000-8000-000000000002';
const X1 = '37000000-0000-4000-8000-000000000001';

const owner = { ownerEmployeeId: RAVI, ownerEmployeeCode: 'SYN-002', ownerName: 'Ravi Synthetic' };
const master = (id: string, code: string, name: string) => ({ id, code, name, ...owner, startDate: '2026-01-01', endDate: null, active: true, version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
const PROJECT = { ...master(P1, 'PRJ-A', 'Synthetic platform'), jobCount: 1 };
const JOB = {
  ...master(J1, 'BUILD', 'Build'),
  projectId: P1,
  projectCode: 'PRJ-A',
  projectName: 'Synthetic platform',
  activities: [
    { activityId: A_DEV, code: 'DEV', name: 'Development', productive: true, activityActive: true, linkActive: true },
    { activityId: A_MEET, code: 'MEET', name: 'Meetings', productive: false, activityActive: true, linkActive: false },
  ],
};
const ACTIVITIES = [
  { ...master(A_DEV, 'DEV', 'Development'), productive: true },
  { ...master(A_MEET, 'MEET', 'Meetings'), productive: false },
  { ...master(A_QA, 'QA', 'Testing'), productive: true },
];
const ALLOCATION = {
  id: AL1,
  employeeId: ASHA,
  employeeCode: 'SYN-001',
  employeeName: 'Asha Synthetic',
  projectId: P1,
  projectCode: 'PRJ-A',
  projectName: 'Synthetic platform',
  jobId: J1,
  jobCode: 'BUILD',
  jobName: 'Build',
  startDate: '2026-10-01',
  endDate: '2026-12-31',
  allocationPercent: '60.00',
  state: 'ACTIVE',
  source: 'MANUAL',
  overAllocation: { reason: 'Synthetic: release week', peakPercent: '110.00', managerEmployeeId: RAVI, recordedAt: '2026-10-02T10:00:00.000Z' },
  cancelReason: null,
  cancelledAt: null,
  version: 3,
  createdAt: '2026-10-01T09:00:00.000Z',
};
const OWN_ALLOCATIONS = [
  { id: AL1, projectId: P1, projectCode: 'PRJ-A', projectName: 'Synthetic platform', jobId: J1, jobCode: 'BUILD', jobName: 'Build', startDate: '2026-10-01', endDate: '2026-12-31', allocationPercent: '60.00', activities: [{ activityId: A_DEV, code: 'DEV', name: 'Development' }] },
  // Ended before the week: never offered for its days.
  { id: '33000000-0000-4000-8000-000000000002', projectId: P1, projectCode: 'PRJ-A', projectName: 'Synthetic platform', jobId: J2, jobCode: 'SUPPORT', jobName: 'Support', startDate: '2026-09-01', endDate: '2026-10-18', allocationPercent: '40.00', activities: [{ activityId: A_MEET, code: 'MEET', name: 'Meetings' }] },
];

const summary = (over: Record<string, unknown> = {}) => ({
  id: S_DRAFT,
  employeeId: ASHA,
  employeeCode: 'SYN-001',
  employeeName: 'Asha Synthetic',
  periodStart: '2026-10-19',
  periodEnd: '2026-10-25',
  dueDate: '2026-10-26',
  state: 'DRAFT',
  currentRevision: 1,
  approvedRevision: null,
  firstSubmittedAt: null,
  late: null,
  version: 4,
  totalMinutes: 240,
  approvedMinutes: 0,
  ...over,
});
const revision = (n: number, origin: string, state: string, over: Record<string, unknown> = {}) => ({
  revision: n,
  origin,
  previousRevision: n > 1 ? n - 1 : null,
  reopenRequestId: null,
  state,
  submittedAt: null,
  submittedOn: null,
  late: null,
  decidedAt: null,
  decisionReason: null,
  supersededAt: null,
  supersededByRevision: null,
  lineCount: 1,
  totalMinutes: 240,
  ...over,
});
const LINE = {
  id: L1,
  workDate: '2026-10-20',
  projectId: P1,
  projectCode: 'PRJ-A',
  projectName: 'Synthetic platform',
  jobId: J1,
  jobCode: 'BUILD',
  jobName: 'Build',
  activityId: A_DEV,
  activityCode: 'DEV',
  activityName: 'Development',
  minutes: 240,
  productive: true,
  note: null,
  source: 'MANUAL',
  carriedFromLineId: null,
  version: 1,
};
const detail = (over: Record<string, unknown> = {}) => {
  const { totalMinutes: _t, approvedMinutes: _a, ...base } = summary();
  return {
    ...base,
    shownRevision: 1,
    revisions: [revision(1, 'INITIAL', 'DRAFT')],
    lines: [LINE],
    dailyTotals: [{ workDate: '2026-10-20', minutes: 240, hours: '4.00' }],
    totalMinutes: 240,
    pendingWith: null,
    decisions: [],
    reopenRequests: [],
    ...over,
  };
};
const APPROVED = detail({
  id: S_APPROVED,
  state: 'APPROVED',
  currentRevision: 2,
  approvedRevision: 2,
  shownRevision: 2,
  firstSubmittedAt: '2026-10-26T08:00:00.000Z',
  late: false,
  revisions: [
    revision(1, 'INITIAL', 'RETURNED', { submittedOn: '2026-10-26', late: false, decidedAt: '2026-10-26T12:00:00.000Z', decisionReason: 'Synthetic: add the review meeting' }),
    revision(2, 'RETURNED', 'APPROVED', { submittedOn: '2026-10-27', late: true, decidedAt: '2026-10-27T12:00:00.000Z' }),
  ],
  decisions: [
    { revision: 1, decision: 'RETURN', decidedAt: '2026-10-26T12:00:00.000Z' },
    { revision: 2, decision: 'APPROVE', decidedAt: '2026-10-27T12:00:00.000Z' },
  ],
});

// ---------------------------------------------------------------------------------------------------------
// The fake API: "METHOD /path" → [status, body] or a function of the call; every request is recorded
// ---------------------------------------------------------------------------------------------------------
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Record<string, unknown> | undefined;
}
type Reply = [number, unknown];
type Handler = Reply | ((call: Call) => Reply);
let calls: Call[] = [];
let holds = new Map<string, Promise<void>>();

function serve(routes: Record<string, Handler>) {
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
      const route = routes[key];
      const reply: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${key}` }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}
/** Replies in turn; the last reply repeats. */
const sequence = (...replies: Reply[]) => {
  let n = 0;
  return () => replies[Math.min(n++, replies.length - 1)]!;
};
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
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodiesTo = (method: string, path: string) => callsTo(method, path).map((c) => c.body);
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
const KEY = (prefix: string) => expect.stringMatching(new RegExp(`^${prefix}-[0-9a-f-]{36}$`));

const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
const screensAt = (entry: string, client: QueryClient) => (
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        {TIMESHEET_SCREENS.map((s) => (
          <Route key={s.path} path={s.path} element={<s.component />} />
        ))}
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>
);
function renderAt(entry: string, permissions: string[], client = testClient()) {
  session.permissions = permissions;
  return render(screensAt(entry, client));
}
function renderComponent(Component: React.ComponentType, permissions: string[]) {
  session.permissions = permissions;
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter>
        <Component />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const queue = (title: string) => TIMESHEET_TASK_QUEUES.find((q) => q.title === title)!.component;
const Panel = TIMESHEET_ESS_PANELS[0]!.component;
const button = (scope: HTMLElement, name: string | RegExp) => within(scope).getByRole('button', { name }) as HTMLButtonElement;
const change = (scope: HTMLElement, label: string | RegExp, value: string) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const field = (scope: HTMLElement, label: string | RegExp) => within(scope).getByLabelText(label) as HTMLInputElement;
const form = (name: string) => screen.getByRole('form', { name });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.assignmentId = 'a0000000-0000-4000-8000-000000000001';
});

describe('exports for the navigation step', () => {
  it('offers the screens, the TN13 panel and both decision queues with their permission keys', () => {
    expect(TIMESHEET_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/timesheet/masters', MASTER_READ, true],
      ['/timesheet/projects/:id', MASTER_READ, false],
      ['/timesheet/jobs/:id', MASTER_READ, false],
      ['/timesheet/activities/:id', MASTER_READ, false],
      ['/timesheet/allocations', ALLOC_READ, true],
      ['/timesheet/allocation-imports', ALLOC_IMPORT, true],
      ['/timesheets', TS_READ, true],
      ['/timesheets/:id', TS_READ, false],
      ['/timesheet/line-imports', TS_IMPORT, true],
      ['/timesheet/approvals', TS_APPROVE, true],
      ['/timesheet/reopen-requests', TS_REOPEN, true],
      ['/timesheet/missed', TS_READ, true],
      ['/timesheet/reports', TS_REPORT, true],
    ]);
    expect(TIMESHEET_ESS_PANELS.map((p) => p.tabId)).toEqual(['TN13']);
    expect(TIMESHEET_TASK_QUEUES.map((q) => [q.permission, q.title])).toEqual([
      [TS_APPROVE, 'Timesheet approvals'],
      [TS_REOPEN, 'Timesheet reopen requests'],
    ]);
  });
});

describe('masters', () => {
  const routes = () => ({ 'GET /v1/timesheet/projects': [200, { items: [PROJECT] }] as Reply, 'GET /v1/timesheet/activities': [200, { items: ACTIVITIES }] as Reply });

  it('lists projects and activities and offers no creation without the manage key', async () => {
    serve(routes());
    renderAt('/timesheet/masters', [MASTER_READ]);
    expect((await screen.findByRole('link', { name: 'PRJ-A' })).getAttribute('href')).toBe(`/timesheet/projects/${P1}`);
    const activities = await screen.findByRole('table', { name: 'Activities' });
    expect(within(activities).getByText('QA').closest('tr')!.textContent).toContain('Productive');
    expect(within(activities).getByText('MEET').closest('tr')!.textContent).toContain('Not productive');
    expect(screen.queryByRole('form', { name: 'New project' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create project' })).toBeNull();
  });

  it('creates a project with the exact body, says CODE_EXISTS in words keeping what was typed, then resets', async () => {
    serve({ ...routes(), 'POST /v1/timesheet/projects': sequence([409, { error: 'CODE_EXISTS', message: 'A project with this code already exists' }], [201, { ...master(P1, 'PRJ-B', 'Synthetic data'), code: 'PRJ-B' }]) });
    renderAt('/timesheet/masters', [MASTER_READ, MASTER_MANAGE]);
    const f = await screen.findByRole('form', { name: 'New project' });
    change(f, 'Code', ' prj-b ');
    change(f, 'Name', 'Synthetic data');
    change(f, 'Owner', ASHA);
    change(f, 'Valid from', '2026-11-01');
    fireEvent.click(button(f, 'Create project'));
    expect((await within(f).findByRole('alert')).textContent).toBe('That code is already used. Codes never change, so choose another code.');
    expect(field(f, 'Code').value).toBe(' prj-b ');
    fireEvent.click(button(f, 'Create project'));
    expect((await within(f).findByRole('status')).textContent).toBe('Created project PRJ-B.');
    expect(bodiesTo('POST', '/v1/timesheet/projects')).toEqual([
      { code: 'prj-b', name: 'Synthetic data', ownerEmployeeId: ASHA, startDate: '2026-11-01', endDate: null },
      { code: 'prj-b', name: 'Synthetic data', ownerEmployeeId: ASHA, startDate: '2026-11-01', endDate: null },
    ]);
    expect(field(f, 'Code').value).toBe('');
    expect(field(f, 'Owner').value).toBe('');
  });

  it('requires the productive flag of a new activity to be chosen (no default)', async () => {
    serve({ ...routes(), 'POST /v1/timesheet/activities': [201, { ...master(A_QA, 'REVIEW', 'Review'), productive: false }] });
    renderAt('/timesheet/masters', [MASTER_READ, MASTER_MANAGE]);
    const f = await screen.findByRole('form', { name: 'New activity' });
    expect((within(f).getByLabelText('Productive') as HTMLInputElement).checked).toBe(false);
    expect((within(f).getByLabelText('Not productive') as HTMLInputElement).checked).toBe(false);
    change(f, 'Code', 'REVIEW');
    change(f, 'Name', 'Review');
    change(f, 'Owner', ASHA);
    change(f, 'Valid from', '2026-11-01');
    change(f, 'Valid to (optional)', '2027-03-31');
    fireEvent.click(button(f, 'Create activity'));
    expect((await within(f).findByRole('alert')).textContent).toContain('whether the activity is productive');
    await settle();
    expect(callsTo('POST', '/v1/timesheet/activities')).toHaveLength(0);
    fireEvent.click(within(f).getByLabelText('Not productive'));
    fireEvent.click(button(f, 'Create activity'));
    await within(f).findByRole('status');
    expect(bodiesTo('POST', '/v1/timesheet/activities')).toEqual([{ code: 'REVIEW', name: 'Review', ownerEmployeeId: ASHA, startDate: '2026-11-01', endDate: '2027-03-31', productive: false }]);
  });

  it('approves, deactivates and reactivates job-activity links with PUT; no link controls without the manage key', async () => {
    const put = (call: Call): Reply => [200, { ...JOB, activities: JOB.activities.map((a) => (a.activityId === call.path.split('/').pop() ? { ...a, linkActive: call.body!.active } : a)) }];
    serve({ ...routes(), [`GET /v1/timesheet/jobs/${J1}`]: [200, JOB], [`PUT /v1/timesheet/jobs/${J1}/activities/${A_MEET}`]: put, [`PUT /v1/timesheet/jobs/${J1}/activities/${A_QA}`]: put });
    renderAt(`/timesheet/jobs/${J1}`, [MASTER_READ, MASTER_MANAGE]);
    const table = await screen.findByRole('table', { name: 'Job activities' });
    expect(within(table).getByText('MEET: Meetings').closest('tr')!.textContent).toContain('Deactivated');
    expect(screen.getByRole('link', { name: 'Project PRJ-A: Synthetic platform' }).getAttribute('href')).toBe(`/timesheet/projects/${P1}`);
    fireEvent.click(screen.getByRole('button', { name: 'Reactivate MEET' }));
    await screen.findByText('The activity is approved for this job.');
    await screen.findByRole('option', { name: 'QA: Testing' });
    fireEvent.change(screen.getByLabelText('Activity to approve for this job'), { target: { value: A_QA } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve activity' }));
    await waitFor(() => expect(callsTo('PUT', `/v1/timesheet/jobs/${J1}/activities/${A_QA}`)).toHaveLength(1));
    expect(bodiesTo('PUT', `/v1/timesheet/jobs/${J1}/activities/${A_MEET}`)).toEqual([{ active: true }]);
    expect(bodiesTo('PUT', `/v1/timesheet/jobs/${J1}/activities/${A_QA}`)).toEqual([{ active: true }]);
    cleanup();
    renderAt(`/timesheet/jobs/${J1}`, [MASTER_READ]);
    await screen.findByRole('table', { name: 'Job activities' });
    expect(screen.queryByRole('button', { name: 'Deactivate DEV' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve activity' })).toBeNull();
  });
});

describe('allocations', () => {
  const routes = (post?: Handler): Record<string, Handler> => ({
    'GET /v1/timesheet/allocations': [200, { items: [ALLOCATION] }],
    'GET /v1/timesheet/projects': [200, { items: [PROJECT] }],
    [`GET /v1/timesheet/projects/${P1}`]: [200, { ...PROJECT, jobs: [JOB] }],
    ...(post ? { 'POST /v1/timesheet/allocations': post } : {}),
    [`POST /v1/timesheet/allocations/${AL1}/cancel`]: [200, { ...ALLOCATION, state: 'CANCELLED' }],
  });

  it('shows the recorded exception and offers no changes without the manage key', async () => {
    serve(routes());
    renderAt('/timesheet/allocations', [ALLOC_READ]);
    const table = await screen.findByRole('table', { name: 'Allocations' });
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('Peak 110.00%');
    expect(within(table).getByText('Reason: Synthetic: release week')).toBeTruthy();
    expect(within(table).getByText('60.00%')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Cancel SYN-001/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'New allocation' })).toBeNull();
    expect(calls.find((c) => c.path === '/v1/timesheet/allocations')!.params.get('state')).toBe('ACTIVE');
  });

  it('pages the allocations with the total of every match, back to the first page when a filter changes (FR-056)', async () => {
    serve({
      ...routes(),
      'GET /v1/timesheet/allocations': (c) => [200, { items: [ALLOCATION], total: 51, page: Number(c.params.get('page')), pageSize: 25 }],
    });
    renderAt('/timesheet/allocations', [ALLOC_READ]);
    await screen.findByRole('table', { name: 'Allocations' });
    expect(Object.fromEntries(callsTo('GET', '/v1/timesheet/allocations')[0]!.params)).toEqual({ state: 'ACTIVE', page: '1', pageSize: '25' });
    const pager = screen.getByRole('navigation', { name: 'Allocation pages' });
    expect(pager.textContent).toContain('Page 1 of 3 · 51 allocations');
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(callsTo('GET', '/v1/timesheet/allocations').at(-1)!.params.get('page')).toBe('2'));
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'CANCELLED' } });
    await waitFor(() => expect(Object.fromEntries(callsTo('GET', '/v1/timesheet/allocations').at(-1)!.params)).toEqual({ state: 'CANCELLED', page: '1', pageSize: '25' }));
  });

  it('asks for the manager’s exception reason when the API reports a total above 100%, then resets', async () => {
    serve(
      routes(
        sequence(
          [409, { error: 'OVER_ALLOCATED', message: 'above 100%', details: { peakPercent: '110.00', date: '2026-11-02' } }],
          [201, { ...ALLOCATION, id: '33000000-0000-4000-8000-000000000009', allocationPercent: '50' }],
        ),
      ),
    );
    renderAt('/timesheet/allocations', [ALLOC_READ, ALLOC_MANAGE, MASTER_READ]);
    const f = await screen.findByRole('form', { name: 'Allocate an employee to a job' });
    change(f, 'Employee', ASHA);
    await within(f).findByRole('option', { name: 'PRJ-A: Synthetic platform' });
    change(f, 'Project', P1);
    await within(f).findByRole('option', { name: 'BUILD: Build' });
    change(f, 'Job', J1);
    change(f, 'From', '2026-11-01');
    change(f, 'To', '2026-11-30');
    change(f, 'Allocation (%)', '50');
    expect(within(f).queryByLabelText(/Over-allocation exception reason/)).toBeNull();
    fireEvent.click(button(f, 'Allocate'));
    expect((await within(f).findByRole('alert')).textContent).toBe(
      'The employee would be allocated 110.00% on 2026-11-02. Above 100% needs an over-allocation exception with a reason, recorded by the employee’s direct manager.',
    );
    change(f, /Over-allocation exception reason/, 'Synthetic: go-live support');
    fireEvent.click(button(f, 'Allocate with the exception'));
    await within(f).findByRole('status');
    expect(bodiesTo('POST', '/v1/timesheet/allocations')).toEqual([
      { employeeId: ASHA, jobId: J1, startDate: '2026-11-01', endDate: '2026-11-30', allocationPercent: '50' },
      { employeeId: ASHA, jobId: J1, startDate: '2026-11-01', endDate: '2026-11-30', allocationPercent: '50', overAllocationReason: 'Synthetic: go-live support' },
    ]);
    expect(field(f, 'Allocation (%)').value).toBe('');
    expect(within(f).queryByLabelText(/Over-allocation exception reason/)).toBeNull();
  });

  it('cancels an allocation only with a reason, against its version', async () => {
    serve(routes());
    renderAt('/timesheet/allocations', [ALLOC_READ, ALLOC_MANAGE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel SYN-001 on BUILD' }));
    const f = form('Cancel the allocation of SYN-001 on BUILD');
    fireEvent.click(button(f, 'Cancel allocation'));
    expect(within(f).getByRole('alert').textContent).toBe('Enter a reason to cancel the allocation.');
    await settle();
    expect(callsTo('POST', `/v1/timesheet/allocations/${AL1}/cancel`)).toHaveLength(0);
    change(f, 'Cancellation reason', 'Synthetic: project paused');
    fireEvent.click(button(f, 'Cancel allocation'));
    await waitFor(() => expect(bodiesTo('POST', `/v1/timesheet/allocations/${AL1}/cancel`)).toEqual([{ reason: 'Synthetic: project paused', expectedVersion: 3 }]));
  });
});

describe('imports (FR-046 bulk upload, FR-047 imported entries, DF09, FR-106)', () => {
  /** allocations.ts and line-import.ts template columns, in order. */
  const ALLOC_HEADER = 'employeeCode,projectCode,jobCode,startDate,endDate,allocationPercent';
  const LINE_HEADER = 'employeeCode,workDate,projectCode,jobCode,activityCode,minutes,note';
  const ALLOC_BASE = '/v1/timesheet/allocation-imports';
  const LINE_BASE = '/v1/timesheet/line-imports';
  const AJ = '38000000-0000-4000-8000-000000000001';
  const LJ = '38000000-0000-4000-8000-000000000002';
  const valid = (...keys: string[]) => keys.map((businessKey, i) => ({ rowNumber: i + 1, businessKey, state: 'VALID', errorCode: null }));
  const ALLOC_ROWS = valid('SYN-001@PRJ-A/BUILD@2026-11-02', 'SYN-002@PRJ-A/SUPPORT@2026-11-02');
  const LINE_ROWS = valid('SYN-001@2026-10-20@PRJ-A/BUILD/DEV', 'SYN-001@2026-10-21@PRJ-A/BUILD/DEV', 'SYN-002@2026-10-21@PRJ-A/BUILD/MEET');
  const base = { acceptedCount: 0, rejectedCount: 0, scanState: 'CLEAN', createdAt: '2026-10-28T09:00:00.000Z' };
  const allocJob = (over: Record<string, unknown> = {}) => ({ ...base, id: AJ, state: 'PREVIEWED', template: 'RESOURCE_ALLOCATION_V1', fileName: 'allocations.csv', rowCount: 2, rows: ALLOC_ROWS, ...over });
  const lineJob = (over: Record<string, unknown> = {}) => ({ ...base, id: LJ, state: 'PREVIEWED', template: 'TIMESHEET_LINES_V1', fileName: 'lines.csv', rowCount: 3, rows: LINE_ROWS, ...over });
  const HELD = { state: 'UPLOADED', rowCount: null, rows: [], scanState: 'PENDING_SCAN' };
  const QUARANTINED: Reply = [422, { error: 'FILE_QUARANTINED', message: 'The malware scan flagged the file; nothing was read or imported' }];
  const csv = (name: string, ...lines: string[]) => new File([lines.join('\n')], name, { type: 'text/csv' });
  const ALLOC_FILE = () => csv('allocations.csv', ALLOC_HEADER, 'SYN-001,PRJ-A,BUILD,2026-11-02,2026-11-30,50', 'SYN-002,PRJ-A,SUPPORT,2026-11-02,2026-11-30,40');
  const LINE_FILE = () => csv('lines.csv', LINE_HEADER, 'SYN-001,2026-10-20,PRJ-A,BUILD,DEV,240,', 'SYN-001,2026-10-21,PRJ-A,BUILD,DEV,480,Synthetic build work', 'SYN-002,2026-10-21,PRJ-A,BUILD,MEET,60,');
  /** Clicks a button once it is enabled: controls stay disabled until the answer before has settled. */
  async function press(name: string | RegExp) {
    await waitFor(() => expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name }));
  }
  async function validate(file?: File) {
    if (file) {
      await waitFor(() => expect((screen.getByLabelText('Import file') as HTMLInputElement).disabled).toBe(false));
      fireEvent.change(screen.getByLabelText('Import file'), { target: { files: [file] } });
    }
    await press('Validate');
  }
  const preview = () => screen.queryByRole('heading', { name: /^Preview:/ });
  const alertText = async () => (await screen.findByRole('alert')).textContent;
  const keysSent = (path: string) => bodiesTo('POST', path).map((b) => b!.idempotencyKey);
  /** GET <base>: the user's own batches of the import (imports/routes.ts), job facts only. */
  const batches = (items: Record<string, unknown>[] = []): Reply => [200, { items, total: items.length, page: 1, pageSize: 25 }];
  const facts = (view: Record<string, unknown>) => {
    const batch: Record<string, unknown> = { ...view, updatedAt: '2026-10-28T09:00:00.000Z' };
    delete batch.rows;
    return batch;
  };
  /** The import routes, with an empty list of the user's batches for each import unless the test gives one. */
  const serveImports = (routes: Record<string, Handler>) => serve({ [`GET ${ALLOC_BASE}`]: batches(), [`GET ${LINE_BASE}`]: batches(), ...routes });

  it('offers each import only with every key its routes require and states the exact template header', () => {
    serveImports({});
    for (const [path, permissions, header] of [
      ['/timesheet/allocation-imports', [], null],
      ['/timesheet/allocation-imports', [ALLOC_IMPORT], null],
      ['/timesheet/allocation-imports', [ALLOC_MANAGE, ALLOC_READ], null],
      ['/timesheet/allocation-imports', [ALLOC_IMPORT, ALLOC_MANAGE], ALLOC_HEADER],
      ['/timesheet/line-imports', [TS_READ, TS_SUBMIT], null],
      ['/timesheet/line-imports', [TS_IMPORT], LINE_HEADER],
    ] as const) {
      renderAt(path, [...permissions]);
      if (header === null) {
        expect(screen.getByRole('note').textContent, `${path} ${permissions.join(' ')}`).toMatch(/cannot import/);
        expect(screen.queryByLabelText('Import file')).toBeNull();
      } else {
        expect(screen.getByText(header, { selector: 'code' })).toBeTruthy();
        expect(screen.getByLabelText('Import file')).toBeTruthy();
      }
      cleanup();
    }
    // Only a permitted screen asks for anything: the first page of the user's own batches.
    expect(calls.map((c) => `${c.method} ${c.path}?${c.params}`)).toEqual([`GET ${ALLOC_BASE}?page=1&pageSize=25`, `GET ${LINE_BASE}?page=1&pageSize=25`]);
  });

  it('downloads each import’s published template (DF09) from its own route, beside the column list', async () => {
    // jsdom has no object URLs: a downloaded file is "saved" through a click on a link to one, counted here.
    const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = vi.fn(() => 'blob:synthetic-template');
    URL.revokeObjectURL = vi.fn();
    const saved = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      for (const [path, permissions, base, code] of [
        ['/timesheet/allocation-imports', [ALLOC_IMPORT, ALLOC_MANAGE], ALLOC_BASE, 'RESOURCE_ALLOCATION_V1'],
        ['/timesheet/line-imports', [TS_IMPORT], LINE_BASE, 'TIMESHEET_LINES_V1'],
      ] as const) {
        serveImports({ [`GET ${base}/template`]: [200, 'header'] });
        saved.mockClear();
        renderAt(path, [...permissions]);
        expect(screen.getByText(`${code}.csv: the header line only, ready to fill in.`)).toBeTruthy();
        await press('Download the template');
        await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
        expect(callsTo('GET', `${base}/template`)).toHaveLength(1);
        cleanup();
      }
    } finally {
      URL.createObjectURL = original.create;
      URL.revokeObjectURL = original.revoke;
      saved.mockRestore();
    }
  });

  it('previews an allocation file row by row and creates the allocations only on request', async () => {
    serveImports({
      [`POST ${ALLOC_BASE}`]: [201, allocJob()],
      [`POST ${ALLOC_BASE}/${AJ}/commit`]: [200, allocJob({ state: 'COMMITTED', acceptedCount: 2, rows: ALLOC_ROWS.map((r) => ({ ...r, state: 'ACCEPTED' })) })],
    });
    renderAt('/timesheet/allocation-imports', [ALLOC_IMPORT, ALLOC_MANAGE]);
    await validate(ALLOC_FILE());
    expect(await screen.findByText(/All 2 rows are valid/)).toBeTruthy();
    expect(preview()!.textContent).toBe('Preview: allocations.csv (RESOURCE_ALLOCATION_V1)');
    const [sent] = bodiesTo('POST', ALLOC_BASE);
    expect(sent).toEqual({ fileName: 'allocations.csv', contentBase64: expect.any(String), idempotencyKey: KEY('allocation-import') });
    expect(atob(sent!.contentBase64 as string)).toBe([ALLOC_HEADER, 'SYN-001,PRJ-A,BUILD,2026-11-02,2026-11-30,50', 'SYN-002,PRJ-A,SUPPORT,2026-11-02,2026-11-30,40'].join('\n'));
    expect(screen.getByText('SYN-002@PRJ-A/SUPPORT@2026-11-02')).toBeTruthy();
    await settle();
    expect(callsTo('POST', `${ALLOC_BASE}/${AJ}/commit`)).toHaveLength(0);
    await press('Create 2 allocations');
    expect(await screen.findByText(/All 2 rows were applied/)).toBeTruthy();
    expect(bodiesTo('POST', `${ALLOC_BASE}/${AJ}/commit`)).toEqual([undefined]);
    expect(screen.queryByRole('button', { name: 'Cancel import' })).toBeNull();
    expect(field(screen.getByRole('form', { name: 'Allocation import' }), 'Import file').value).toBe('');
  });

  it('a rejected allocation batch says each row problem in plain words, applies nothing and offers no commit', async () => {
    serveImports({
      [`POST ${ALLOC_BASE}`]: [
        201,
        allocJob({
          state: 'REJECTED',
          rejectedCount: 3,
          rowCount: 3,
          rows: [
            { rowNumber: 1, businessKey: 'SYN-001@PRJ-A/BUILD@2026-11-02', state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
            { rowNumber: 2, businessKey: 'SYN-404@PRJ-A/BUILD@2026-11-02', state: 'REJECTED', errorCode: 'UNKNOWN_EMPLOYEE' },
            { rowNumber: 3, businessKey: 'SYN-002@PRJ-A/SUPPORT@2026-11-02', state: 'REJECTED', errorCode: 'OVER_ALLOCATED' },
          ],
        }),
      ],
    });
    renderAt('/timesheet/allocation-imports', [ALLOC_IMPORT, ALLOC_MANAGE]);
    await validate(ALLOC_FILE());
    expect(await screen.findByText(/This batch was rejected, so nothing was applied/)).toBeTruthy();
    const row = (key: string) => screen.getByText(key, { selector: 'td' }).closest('tr')!;
    expect(row('SYN-404@PRJ-A/BUILD@2026-11-02').textContent).toContain('No employee in this company has this employee code.UNKNOWN_EMPLOYEE');
    expect(row('SYN-002@PRJ-A/SUPPORT@2026-11-02').textContent).toContain('an import cannot record one.OVER_ALLOCATED');
    expect(row('SYN-001@PRJ-A/BUILD@2026-11-02').textContent).toContain('not applied (another row failed)');
    expect(screen.queryByRole('button', { name: /^Create/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel import' })).toBeNull();
  });

  it('holds a file the malware scan has not released, checks it again from its stored file (no second upload), then previews it', async () => {
    serveImports({
      [`POST ${ALLOC_BASE}`]: [202, allocJob(HELD)],
      [`POST ${ALLOC_BASE}/${AJ}/resume`]: sequence([202, allocJob(HELD)], [200, allocJob()]),
      [`POST ${ALLOC_BASE}/${AJ}/commit`]: [200, allocJob({ state: 'COMMITTED', acceptedCount: 2 })],
    });
    renderAt('/timesheet/allocation-imports', [ALLOC_IMPORT, ALLOC_MANAGE]);
    await validate(ALLOC_FILE());
    expect(await screen.findByText(/waiting for the malware scan, so nothing in it has been read yet/)).toBeTruthy();
    expect(screen.getByText(/The batch stays in your batches below/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Create/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel import' })).toBeTruthy();
    await press('Check the scan again');
    expect(await screen.findByText('Still waiting for the malware scan.')).toBeTruthy();
    await press('Check the scan again');
    expect(await screen.findByText(/All 2 rows are valid/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
    // The file was sent once; each check went to the resume route, with no body.
    expect(bodiesTo('POST', ALLOC_BASE)).toHaveLength(1);
    expect(bodiesTo('POST', `${ALLOC_BASE}/${AJ}/resume`)).toEqual([undefined, undefined]);
    await press('Create 2 allocations');
    expect(await screen.findByText(/All 2 rows were applied/)).toBeTruthy();
    // Every step read the list of the user's batches again.
    await waitFor(() => expect(callsTo('GET', ALLOC_BASE).length).toBeGreaterThanOrEqual(5));
  });

  it('a held batch can be cancelled, and one the scan then quarantines is closed with the refusal in plain words', async () => {
    serveImports({
      [`POST ${ALLOC_BASE}`]: [202, allocJob(HELD)],
      [`POST ${ALLOC_BASE}/${AJ}/cancel`]: [200, allocJob({ state: 'CANCELLED', rowCount: null, rows: [] })],
      [`POST ${ALLOC_BASE}/${AJ}/resume`]: QUARANTINED,
    });
    renderAt('/timesheet/allocation-imports', [ALLOC_IMPORT, ALLOC_MANAGE]);
    await validate(ALLOC_FILE());
    await press('Cancel import');
    expect(await screen.findByText('Import cancelled; nothing was applied.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check the scan again' })).toBeNull();
    expect(callsTo('POST', `${ALLOC_BASE}/${AJ}/commit`)).toEqual([]);

    await validate(ALLOC_FILE());
    await press('Check the scan again');
    expect(await alertText()).toBe('The malware scan flagged this file, so nothing in it was read or imported. Upload a clean copy of the file.FILE_QUARANTINED');
    expect(preview()).toBeNull();
    const [first, second] = keysSent(ALLOC_BASE);
    expect(keysSent(ALLOC_BASE)).toHaveLength(2);
    expect(second).not.toBe(first);
    expect(callsTo('POST', `${ALLOC_BASE}/${AJ}/resume`)).toHaveLength(1);
  });

  it('lists the user’s own batches, so a held batch is opened again after leaving the page and checked again', async () => {
    const LJ_DONE = '38000000-0000-4000-8000-000000000004';
    serveImports({
      [`GET ${LINE_BASE}`]: batches([facts(lineJob(HELD)), facts(lineJob({ id: LJ_DONE, fileName: 'october.csv', state: 'COMMITTED', acceptedCount: 3 }))]),
      [`GET ${LINE_BASE}/${LJ}`]: [200, lineJob(HELD)],
      [`POST ${LINE_BASE}/${LJ}/resume`]: [200, lineJob()],
    });
    renderAt('/timesheet/line-imports', [TS_IMPORT]);
    const list = await screen.findByRole('table', { name: 'Your timesheet entry import batches' });
    const row = (name: string) => within(screen.getByRole('table', { name: 'Your timesheet entry import batches' })).getByText(name).closest('tr')!;
    expect(row('lines.csv').textContent).toContain('held for the malware scan');
    expect(row('lines.csv').textContent).toContain('waiting for the malware scan');
    expect(row('october.csv').textContent).toContain('3 applied');
    expect(within(list).queryByText(LINE_ROWS[0]!.businessKey)).toBeNull();
    expect(callsTo('GET', LINE_BASE)[0]!.params.toString()).toBe('page=1&pageSize=25');

    fireEvent.click(within(row('lines.csv')).getByRole('button', { name: /^Open lines.csv/ }));
    expect(await screen.findByText(/waiting for the malware scan, so nothing in it has been read yet/)).toBeTruthy();
    expect(within(row('lines.csv')).getByText('open above')).toBeTruthy();
    await press('Check the scan again');
    expect(await screen.findByText(/All 3 rows are valid/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Record 3 timesheet lines' })).toBeTruthy();
    expect(callsTo('POST', LINE_BASE)).toEqual([]);
  });

  it('records timesheet lines from a corrected file after a rejected one, each upload with its own key', async () => {
    serveImports({
      [`POST ${LINE_BASE}`]: sequence(
        [
          201,
          lineJob({
            state: 'REJECTED',
            rejectedCount: 3,
            rows: [
              { ...LINE_ROWS[0]!, state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
              { ...LINE_ROWS[1]!, state: 'REJECTED', errorCode: 'DAILY_LIMIT_EXCEEDED' },
              { ...LINE_ROWS[2]!, state: 'REJECTED', errorCode: 'TIMESHEET_NOT_EDITABLE' },
            ],
          }),
        ],
        [201, lineJob({ id: '38000000-0000-4000-8000-000000000003' })],
      ),
      [`POST ${LINE_BASE}/38000000-0000-4000-8000-000000000003/commit`]: [200, lineJob({ id: '38000000-0000-4000-8000-000000000003', state: 'COMMITTED', acceptedCount: 3 })],
    });
    renderAt('/timesheet/line-imports', [TS_IMPORT]);
    await validate(LINE_FILE());
    expect(await screen.findByText(/This batch was rejected, so nothing was applied/)).toBeTruthy();
    expect(preview()!.textContent).toBe('Preview: lines.csv (TIMESHEET_LINES_V1)');
    expect(screen.getByText(/would total more than 24 hours, counting the lines already recorded and the earlier rows of this file/)).toBeTruthy();
    expect(screen.getByText(/is not a draft revision, so no line can be added to it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Record/ })).toBeNull();

    await validate(LINE_FILE());
    await press('Record 3 timesheet lines');
    expect(await screen.findByText(/All 3 rows were applied/)).toBeTruthy();
    const [first, second] = keysSent(LINE_BASE);
    expect(first).toEqual(KEY('line-import'));
    expect(second).toEqual(KEY('line-import'));
    expect(second).not.toBe(first);
    expect(bodiesTo('POST', `${LINE_BASE}/38000000-0000-4000-8000-000000000003/commit`)).toEqual([undefined]);
  });

  it('says file refusals in plain words; validating the same file again after a failure reuses its key', async () => {
    serveImports({
      [`POST ${LINE_BASE}`]: sequence(
        [500, { error: 'INTERNAL', message: 'Unexpected error' }],
        [422, { error: 'INVALID_HEADER', message: 'Template TIMESHEET_LINES_V1: the header must be exactly …' }],
        QUARANTINED,
      ),
    });
    renderAt('/timesheet/line-imports', [TS_IMPORT]);
    await validate(LINE_FILE());
    expect(await alertText()).toContain('INTERNAL');
    await validate();
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(`The first line of the file must be exactly the header ${LINE_HEADER}.INVALID_HEADER`));
    await validate(LINE_FILE());
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('The malware scan flagged this file, so nothing in it was read or imported.'));
    expect(preview()).toBeNull();
    const [first, second, third] = keysSent(LINE_BASE);
    expect(second).toBe(first);
    expect(third).not.toBe(second);
  });

  it('starts afresh under another role assignment, so a batch previewed under one is never committed under another', async () => {
    serveImports({ [`POST ${LINE_BASE}`]: [201, lineJob()] });
    const client = testClient();
    const view = renderAt('/timesheet/line-imports', [TS_IMPORT], client);
    await validate(LINE_FILE());
    await screen.findByRole('button', { name: 'Record 3 timesheet lines' });
    session.assignmentId = 'a0000000-0000-4000-8000-000000000002';
    view.rerender(screensAt('/timesheet/line-imports', client));
    expect(preview()).toBeNull();
    expect(screen.getByLabelText('Import file')).toBeTruthy();
    // The list of batches is read again for the new assignment, never served from the other one's answer.
    await waitFor(() => expect(callsTo('GET', LINE_BASE).length).toBeGreaterThanOrEqual(3));
  });
});

describe('decision queues', () => {
  const TASK = {
    taskId: T1,
    transactionId: X1,
    kind: 'timesheet',
    ownerEmployeeCode: 'SYN-002',
    ownerName: 'Ravi Synthetic',
    assignedAt: '2026-10-27T09:00:00.000Z',
    step: 1,
    stepAction: 'approve',
    timesheet: { ...summary({ id: S_APPROVED, employeeId: RAVI, employeeCode: 'SYN-002', employeeName: 'Ravi Synthetic', state: 'SUBMITTED', currentRevision: 2, totalMinutes: 2250 }), revisionLate: true },
  };
  const decision = `/v1/timesheet-tasks/${T1}/decision`;

  it('is not offered without the approve key and asks nothing of the API', async () => {
    serve({ 'GET /v1/timesheet-tasks': [200, { items: [TASK] }] });
    renderComponent(queue('Timesheet approvals'), [TS_READ]);
    expect(screen.getByRole('note').textContent).toContain('The selected role cannot decide timesheets.');
    await settle();
    expect(callsTo('GET', '/v1/timesheet-tasks')).toHaveLength(0);
  });

  it('approves with an idempotency key, disabling the decisions while in flight; a return needs a reason', async () => {
    serve({ 'GET /v1/timesheet-tasks': [200, { items: [TASK] }], [`POST ${decision}`]: [200, { timesheetId: S_APPROVED, revision: 2, state: 'APPROVED', replayed: false }] });
    renderComponent(queue('Timesheet approvals'), [TS_APPROVE]);
    const item = await screen.findByRole('listitem', { name: 'Ravi Synthetic (SYN-002): 2026-10-19 to 2026-10-25' });
    expect(item.textContent).toContain('submitted late');
    expect(item.textContent).toContain('37:30 h');
    fireEvent.click(button(item, 'Return for changes'));
    expect(within(item).getByRole('alert').textContent).toBe('Enter a reason to return the timesheet for changes.');
    await settle();
    expect(callsTo('POST', decision)).toHaveLength(0);
    const release = hold(`POST ${decision}`);
    fireEvent.click(button(item, 'Approve'));
    await waitFor(() => expect(button(item, 'Approve').disabled).toBe(true));
    expect(button(item, 'Reject').disabled).toBe(true);
    release();
    expect((await screen.findByRole('status')).textContent).toBe('Approved revision 2 of the timesheet of Ravi Synthetic (SYN-002) for 2026-10-19 to 2026-10-25.');
    expect(bodiesTo('POST', decision)).toEqual([{ decision: 'APPROVE', idempotencyKey: KEY('timesheet-decision') }]);
    expect(screen.queryByRole('listitem', { name: /Ravi Synthetic/ })).toBeNull();
  });

  it('links to the timesheet screens only when the read key is held as well (inbox with the decision key alone)', async () => {
    const reopen = {
      taskId: RT1,
      transactionId: X1,
      assignedAt: '2026-10-28T09:00:00.000Z',
      request: { id: 'r-1', timesheetId: S_APPROVED, employeeId: RAVI, employeeCode: 'SYN-002', employeeName: 'Ravi Synthetic', periodStart: '2026-10-19', periodEnd: '2026-10-25', approvedRevision: 2, reason: 'Synthetic: Friday missing', requestedAt: '2026-10-28T08:00:00.000Z' },
    };
    serve({ 'GET /v1/timesheet-tasks': [200, { items: [TASK] }], 'GET /v1/timesheet-reopen-tasks': [200, { items: [reopen] }] });
    const approvals = renderComponent(queue('Timesheet approvals'), [TS_APPROVE]);
    let item = await screen.findByRole('listitem', { name: /Ravi Synthetic/ });
    expect(within(item).queryByRole('link')).toBeNull();
    approvals.unmount();
    const reopens = renderComponent(queue('Timesheet reopen requests'), [TS_REOPEN]);
    item = await screen.findByRole('listitem', { name: /Reopen Ravi Synthetic/ });
    expect(within(item).queryByRole('link')).toBeNull();
    reopens.unmount();
    renderComponent(queue('Timesheet approvals'), [TS_APPROVE, TS_READ]);
    item = await screen.findByRole('listitem', { name: /Ravi Synthetic/ });
    expect(within(item).getByRole('link').getAttribute('href')).toBe(`/timesheets/${S_APPROVED}`);
  });

  it('sends a retried rejection with the same key and its reason', async () => {
    serve({
      'GET /v1/timesheet-tasks': [200, { items: [TASK] }],
      [`POST ${decision}`]: sequence([503, { error: 'UNAVAILABLE', message: 'Synthetic outage' }], [200, { timesheetId: S_APPROVED, revision: 2, state: 'REJECTED', replayed: false }]),
    });
    renderComponent(queue('Timesheet approvals'), [TS_APPROVE]);
    const item = await screen.findByRole('listitem', { name: /Ravi Synthetic/ });
    change(item, /Decision reason/, 'Synthetic: wrong project');
    fireEvent.click(button(item, 'Reject'));
    await within(item).findByRole('alert');
    fireEvent.click(button(item, 'Reject'));
    await screen.findByRole('status');
    const [first, second] = bodiesTo('POST', decision);
    expect(first).toEqual({ decision: 'REJECT', reason: 'Synthetic: wrong project', idempotencyKey: KEY('timesheet-decision') });
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
  });

  it('decides a reopen request independently: a rejection needs a reason, an approval opens the correction', async () => {
    const reopen = {
      taskId: RT1,
      transactionId: X1,
      assignedAt: '2026-10-28T09:00:00.000Z',
      request: { id: 'r-1', timesheetId: S_APPROVED, employeeId: RAVI, employeeCode: 'SYN-002', employeeName: 'Ravi Synthetic', periodStart: '2026-10-19', periodEnd: '2026-10-25', approvedRevision: 2, reason: 'Synthetic: Friday missing', requestedAt: '2026-10-28T08:00:00.000Z' },
    };
    const path = `/v1/timesheet-reopen-tasks/${RT1}/decision`;
    serve({ 'GET /v1/timesheet-reopen-tasks': [200, { items: [reopen] }], [`POST ${path}`]: [200, { reopenRequestId: 'r-1', timesheetId: S_APPROVED, state: 'APPROVED', newRevision: 3, replayed: false }] });
    renderComponent(queue('Timesheet reopen requests'), [TS_REOPEN]);
    const item = await screen.findByRole('listitem', { name: 'Reopen Ravi Synthetic (SYN-002): 2026-10-19 to 2026-10-25' });
    expect(item.textContent).toContain('Synthetic: Friday missing');
    fireEvent.click(button(item, 'Reject reopen'));
    expect(within(item).getByRole('alert').textContent).toBe('Enter a reason to reject the reopen request.');
    fireEvent.click(button(item, 'Approve reopen'));
    expect((await screen.findByRole('status')).textContent).toContain('revision 3 is open as a draft for the correction');
    expect(bodiesTo('POST', path)).toEqual([{ decision: 'APPROVE', idempotencyKey: KEY('timesheet-reopen') }]);
  });
});

describe('a timesheet and its revisions', () => {
  const routes = (): Record<string, Handler> => ({
    [`GET /v1/timesheets/${S_APPROVED}`]: (call) =>
      call.params.get('revision') === '1' ? [200, { ...APPROVED, shownRevision: 1, lines: [{ ...LINE, minutes: 120 }], dailyTotals: [{ workDate: '2026-10-20', minutes: 120, hours: '2.00' }], totalMinutes: 120 }] : [200, APPROVED],
    [`POST /v1/timesheets/${S_APPROVED}/reopen-requests`]: [201, { reopenRequestId: 'r-2', timesheetId: S_APPROVED, approvedRevision: 2, state: 'SUBMITTED' }],
  });

  it('shows every revision, opens an earlier one and requests a reopen of the approved one with a reason', async () => {
    serve(routes());
    renderAt(`/timesheets/${S_APPROVED}`, [TS_READ, TS_REQUEST_REOPEN]);
    const revisions = await screen.findByRole('table', { name: 'Revisions' });
    const rows = within(revisions).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('Reason: Synthetic: add the review meeting');
    expect(rows[1]!.textContent).toContain('approved revision in force');
    expect(rows[1]!.textContent).toContain('Submitted late');
    expect(screen.getByRole('list', { name: 'Decisions' }).textContent).toContain('Revision 1: Returned for changes');
    fireEvent.click(within(revisions).getByRole('button', { name: 'Show revision 1' }));
    await screen.findByRole('table', { name: 'Lines of revision 1' });
    expect(calls.at(-1)!.params.get('revision')).toBe('1');
    expect(screen.getByText(/2026-10-20 2.00 h/)).toBeTruthy();
    const f = form('Request a reopen');
    fireEvent.click(button(f, 'Request reopen'));
    expect(within(f).getByRole('alert').textContent).toBe('Enter why the approved timesheet needs a correction.');
    change(f, 'Reason for reopening the approved timesheet', 'Synthetic: Friday was missed');
    fireEvent.click(button(f, 'Request reopen'));
    await screen.findByText(/Reopen request sent/);
    expect(bodiesTo('POST', `/v1/timesheets/${S_APPROVED}/reopen-requests`)).toEqual([{ reason: 'Synthetic: Friday was missed' }]);
  });

  it('offers no reopen request without its key', async () => {
    serve(routes());
    renderAt(`/timesheets/${S_APPROVED}`, [TS_READ]);
    await screen.findByRole('table', { name: 'Revisions' });
    expect(screen.queryByRole('button', { name: 'Request reopen' })).toBeNull();
  });

  it('never shows one assignment’s timesheets under another', async () => {
    serve({ 'GET /v1/timesheets': [200, { items: [summary()] }] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    renderAt('/timesheets', [TS_READ], client);
    await screen.findByRole('table', { name: 'Timesheet weeks' });
    cleanup();
    session.assignmentId = 'a0000000-0000-4000-8000-000000000002';
    renderAt('/timesheets', [TS_READ], client);
    await waitFor(() => expect(callsTo('GET', '/v1/timesheets')).toHaveLength(2));
  });
});

describe('missed submissions', () => {
  const MISSED = { id: 'x-1', employeeId: RAVI, employeeCode: 'SYN-002', employeeName: 'Ravi Synthetic', periodStart: '2026-10-12', periodEnd: '2026-10-18', dueDate: '2026-10-19', raisedOn: '2026-10-20', state: 'OPEN', resolution: null, resolutionReason: null, timesheetId: null, resolvedAt: null, version: 1 };

  it('resolves a reminder only with a documented reason and says a self-resolution refusal in words', async () => {
    serve({ 'GET /v1/timesheet-exceptions': [200, { items: [MISSED] }], 'POST /v1/timesheet-exceptions/x-1/resolve': [403, { error: 'SELF_ACTION_NOT_ALLOWED', message: 'own' }] });
    renderAt('/timesheet/missed', [TS_READ, TS_RESOLVE]);
    const f = await screen.findByRole('form', { name: 'Resolve the reminder of SYN-002 for 2026-10-12' });
    expect(calls[0]!.params.get('state')).toBe('OPEN');
    expect(screen.getByText(/never a deduction or a penalty/)).toBeTruthy();
    fireEvent.click(button(f, 'Resolve reminder'));
    expect(within(f).getByRole('alert').textContent).toBe('Enter the documented reason for resolving the reminder.');
    change(f, 'Documented resolution reason', 'Synthetic: on approved leave');
    fireEvent.click(button(f, 'Resolve reminder'));
    expect((await within(f).findByText('You cannot resolve your own missed-timesheet reminder.')).getAttribute('role')).toBe('alert');
    expect(bodiesTo('POST', '/v1/timesheet-exceptions/x-1/resolve')).toEqual([{ reason: 'Synthetic: on approved leave' }]);
    expect(field(f, 'Documented resolution reason').value).toBe('Synthetic: on approved leave');
  });

  it('offers no resolution without its key', async () => {
    serve({ 'GET /v1/timesheet-exceptions': [200, { items: [MISSED] }] });
    renderAt('/timesheet/missed', [TS_READ]);
    await screen.findByRole('list', { name: 'Missed timesheets' });
    expect(screen.queryByRole('button', { name: 'Resolve reminder' })).toBeNull();
  });

  it('pages the missed timesheets with the total of every match in scope, from the first page again on a new filter (FR-056)', async () => {
    const missed = (n: number) => ({ ...MISSED, id: `x-${n}`, employeeCode: `SYN-${100 + n}`, employeeName: `Person ${n}` });
    serve({
      'GET /v1/timesheet-exceptions': (c) => [
        200,
        c.params.get('page') === '2' ? { items: [missed(26)], total: 26, page: 2, pageSize: 25 } : { items: Array.from({ length: 25 }, (_, i) => missed(i + 1)), total: 26, page: 1, pageSize: 25 },
      ],
    });
    renderAt('/timesheet/missed', [TS_READ]);
    const list = await screen.findByRole('list', { name: 'Missed timesheets' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(25);
    expect(Object.fromEntries(callsTo('GET', '/v1/timesheet-exceptions')[0]!.params)).toEqual({ state: 'OPEN', page: '1', pageSize: '25' });
    const pager = screen.getByRole('navigation', { name: 'Missed timesheet pages' });
    expect(pager.textContent).toContain('Page 1 of 2 · 26 missed timesheets');
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Missed timesheets' })).getAllByRole('listitem')).toHaveLength(1));
    expect(Object.fromEntries(callsTo('GET', '/v1/timesheet-exceptions').at(-1)!.params)).toEqual({ state: 'OPEN', page: '2', pageSize: '25' });
    expect(screen.getByRole('navigation', { name: 'Missed timesheet pages' }).textContent).toContain('Page 2 of 2 · 26 missed timesheets');
    // A new filter starts again from the first page.
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'RESOLVED' } });
    await waitFor(() => expect(Object.fromEntries(callsTo('GET', '/v1/timesheet-exceptions').at(-1)!.params)).toEqual({ state: 'RESOLVED', page: '1', pageSize: '25' }));
  });
});

describe('reports', () => {
  it('shows hours and utilisation exactly as returned, including N/A and not configured', async () => {
    serve({
      'GET /v1/timesheet-reports/hours': [
        200,
        {
          from: '2026-10-01',
          to: '2026-10-31',
          basis: 'APPROVED',
          groupBy: ['employee', 'project'],
          groups: [{ employeeId: ASHA, employeeCode: 'SYN-001', employeeName: 'Asha Synthetic', projectId: P1, projectCode: 'PRJ-A', projectName: 'Synthetic platform', minutes: 450, hours: '7.50', productiveMinutes: 450, lineCount: 1 }],
          totals: { minutes: 450, hours: '7.50', productiveMinutes: 450, lineCount: 1 },
        },
      ],
      'GET /v1/timesheet-reports/utilisation': [
        200,
        {
          from: '2026-10-01',
          to: '2026-10-31',
          formula: 'approved productive hours / scheduled eligible work hours x 100 (F1)',
          scheduleBasis: 'Synthetic basis',
          items: [
            { employeeId: ASHA, employeeCode: 'SYN-001', employeeName: 'Asha Synthetic', approvedMinutes: 1500, productiveMinutes: 1500, status: 'OK', scheduledMinutes: 2400, utilisationPercent: '62.50' },
            { employeeId: RAVI, employeeCode: 'SYN-002', employeeName: 'Ravi Synthetic', approvedMinutes: 0, productiveMinutes: 0, status: 'NOT_APPLICABLE', display: 'N/A', scheduledMinutes: 0, utilisationPercent: null },
            {
              employeeId: '20000000-0000-4000-8000-000000000003',
              employeeCode: 'SYN-003',
              employeeName: 'Meera Synthetic',
              approvedMinutes: 60,
              productiveMinutes: 60,
              status: 'NOT_CONFIGURED',
              reason: 'NO_SHIFT_ASSIGNED',
              message: 'Some working days in the range have no shift assigned, so the scheduled hours are not known',
              unscheduledDays: 2,
              scheduledMinutes: null,
              utilisationPercent: null,
            },
          ],
        },
      ],
    });
    renderAt('/timesheet/reports', [TS_REPORT]);
    const hours = form('Hours report');
    change(hours, 'From', '2026-10-01');
    change(hours, 'To', '2026-10-31');
    fireEvent.click(within(hours).getByLabelText('Project'));
    fireEvent.click(button(hours, 'Show hours'));
    const table = await screen.findByRole('table', { name: 'Hours by group' });
    expect(Object.fromEntries(callsTo('GET', '/v1/timesheet-reports/hours')[0]!.params)).toEqual({ from: '2026-10-01', to: '2026-10-31', groupBy: 'employee,project', page: '1', pageSize: '25' });
    expect(within(table).getAllByRole('row')[1]!.textContent).toBe('Asha Synthetic (SYN-001)PRJ-A: Synthetic platform7.504504501');
    const util = form('Utilisation report');
    change(util, 'From', '2026-10-01');
    change(util, 'To', '2026-10-31');
    fireEvent.click(button(util, 'Show utilisation'));
    const rows = within(await screen.findByRole('table', { name: 'Utilisation by employee' })).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toContain('62.50%');
    expect(rows[1]!.textContent).toContain('N/A (no scheduled hours)');
    expect(rows[2]!.textContent).toContain('not configured');
    expect(rows[2]!.textContent).toContain('no shift assigned');
    expect(rows[2]!.textContent).toContain('(2 working days without a shift)');
    expect(screen.queryByLabelText('Project filter')).toBeNull();
  });

  it('pages the utilisation report and shows the totals of every employee in scope, not only the page (FR-056)', async () => {
    const item = (n: number) => ({ employeeId: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`, employeeCode: `SYN-${n}`, employeeName: `Person ${n}`, approvedMinutes: 60, productiveMinutes: 30, status: 'OK', scheduledMinutes: 480, utilisationPercent: '6.25' });
    const totals = { employees: 26, byStatus: { OK: 24, NOT_APPLICABLE: 0, NOT_CONFIGURED: 2 }, approvedMinutes: 1560, productiveMinutes: 780, scheduledMinutes: null };
    serve({
      'GET /v1/timesheet-reports/utilisation': (c) => [
        200,
        {
          from: '2026-10-01',
          to: '2026-10-31',
          formula: 'approved productive hours / scheduled eligible work hours x 100 (F1)',
          scheduleBasis: 'Synthetic basis',
          items: c.params.get('page') === '2' ? [item(26)] : Array.from({ length: 25 }, (_, i) => item(i + 1)),
          total: 26,
          page: Number(c.params.get('page')),
          pageSize: 25,
          totals,
        },
      ],
    });
    renderAt('/timesheet/reports', [TS_REPORT]);
    const util = form('Utilisation report');
    change(util, 'From', '2026-10-01');
    change(util, 'To', '2026-10-31');
    fireEvent.click(button(util, 'Show utilisation'));
    const table = await screen.findByRole('table', { name: 'Utilisation by employee' });
    expect(Object.fromEntries(callsTo('GET', '/v1/timesheet-reports/utilisation')[0]!.params)).toEqual({ from: '2026-10-01', to: '2026-10-31', page: '1', pageSize: '25' });
    const footer = () => within(screen.getByRole('table', { name: 'Utilisation by employee' })).getAllByRole('row').at(-1)!.textContent;
    expect(footer()).toBe('All 26 employees in scope1560780not known24 OK · 0 N/A · 2 not configured');
    expect(within(table).getAllByRole('row')).toHaveLength(27);
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Utilisation pages' })).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Utilisation by employee' })).getAllByRole('row')).toHaveLength(3));
    // The totals are the same on every page.
    expect(footer()).toBe('All 26 employees in scope1560780not known24 OK · 0 N/A · 2 not configured');
  });

  it('pages the hours groups and the approved lines on their own, the total covering every group on every page (FR-056)', async () => {
    const range = { from: '2026-10-01', to: '2026-10-31' };
    const group = (n: number) => ({ employeeId: `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`, employeeCode: `SYN-${n}`, employeeName: `Person ${n}`, minutes: 60, hours: '1.00', productiveMinutes: 60, lineCount: 1 });
    const line = (n: number) => ({ id: `l-${n}`, timesheetId: 't-1', revision: 1, employeeCode: `SYN-${n}`, workDate: '2026-10-05', periodStart: '2026-10-05', projectCode: 'PRJ-A', jobCode: 'JOB-1', activityCode: 'DEV', minutes: 60, productive: true });
    const totals = { minutes: 1560, hours: '26.00', productiveMinutes: 1560, lineCount: 26 };
    serve({
      'GET /v1/timesheet-reports/hours': (c) => [
        200,
        { ...range, basis: 'APPROVED', groupBy: ['employee'], groups: c.params.get('page') === '2' ? [group(26)] : Array.from({ length: 25 }, (_, i) => group(i + 1)), totalGroups: 26, page: Number(c.params.get('page')), pageSize: 25, totals },
      ],
      'GET /v1/timesheet-reports/lines': (c) => [
        200,
        { ...range, basis: 'APPROVED', items: c.params.get('page') === '2' ? [line(26)] : Array.from({ length: 25 }, (_, i) => line(i + 1)), total: 26, page: Number(c.params.get('page')), pageSize: 25 },
      ],
    });
    renderAt('/timesheet/reports', [TS_REPORT]);
    const hours = form('Hours report');
    change(hours, 'From', range.from);
    change(hours, 'To', range.to);
    fireEvent.click(button(hours, 'Show hours'));
    const table = await screen.findByRole('table', { name: 'Hours by group' });
    // The header, 25 groups and the total.
    expect(within(table).getAllByRole('row')).toHaveLength(27);
    const footer = () => within(screen.getByRole('table', { name: 'Hours by group' })).getAllByRole('row').at(-1)!.textContent;
    expect(footer()).toBe('Total26.001560156026');
    expect(screen.getByText('The total covers every group, not only the groups on this page.')).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Hours group pages' }).textContent).toContain('Page 1 of 2 · 26 groups');
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Hours group pages' })).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Hours by group' })).getAllByRole('row')).toHaveLength(3));
    expect(footer()).toBe('Total26.001560156026');
    expect(Object.fromEntries(callsTo('GET', '/v1/timesheet-reports/hours').at(-1)!.params)).toEqual({ ...range, groupBy: 'employee', page: '2', pageSize: '25' });

    // The lines behind the report page on their own, with the report's filters and no grouping.
    fireEvent.click(screen.getByRole('button', { name: 'Show the approved lines behind this report' }));
    const lines = await screen.findByRole('table', { name: 'Approved lines' });
    expect(within(lines).getAllByRole('row')).toHaveLength(26);
    expect(Object.fromEntries(callsTo('GET', '/v1/timesheet-reports/lines')[0]!.params)).toEqual({ ...range, page: '1', pageSize: '25' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Approved line pages' })).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Approved lines' })).getAllByRole('row')).toHaveLength(2));
    expect(Object.fromEntries(callsTo('GET', '/v1/timesheet-reports/lines').at(-1)!.params)).toEqual({ ...range, page: '2', pageSize: '25' });
    // Showing the report again starts from the first page of groups.
    fireEvent.click(button(hours, 'Show hours'));
    await waitFor(() => expect(Object.fromEntries(callsTo('GET', '/v1/timesheet-reports/hours').at(-1)!.params)).toEqual({ ...range, groupBy: 'employee', page: '1', pageSize: '25' }));
  });

  it('is not offered without the report key', async () => {
    serve({});
    renderAt('/timesheet/reports', [TS_READ]);
    expect(screen.getByRole('note').textContent).toContain('cannot run timesheet reports');
    await settle();
    expect(calls).toHaveLength(0);
  });
});

describe('My ESS TN13', () => {
  const routes = (over: Record<string, Handler> = {}): Record<string, Handler> => ({
    'GET /v1/me/timesheets': [200, { items: [summary()] }],
    'GET /v1/me/timesheet-allocations': [200, { items: OWN_ALLOCATIONS }],
    'GET /v1/me/timesheet-exceptions': [
      200,
      { items: [{ id: 'x-9', employeeId: ASHA, employeeCode: 'SYN-001', employeeName: 'Asha Synthetic', periodStart: '2026-10-12', periodEnd: '2026-10-18', dueDate: '2026-10-19', raisedOn: '2026-10-20', state: 'OPEN', resolution: null, resolutionReason: null, timesheetId: null, resolvedAt: null, version: 1 }] },
    ],
    'GET /v1/me/requests': [200, { items: [{ transactionId: X1, requestId: S_APPROVED, kind: 'timesheet', state: 'APPROVED', pendingWith: null, createdAt: '2026-10-20T08:00:00Z', decisions: [{ step: 1, decision: 'APPROVE', decidedAt: '2026-10-27T12:00:00Z' }] }] }],
    [`GET /v1/timesheets/${S_DRAFT}`]: [200, detail()],
    ...over,
  });

  it('starts a week, says the API’s refusals in words and opens the existing week', async () => {
    serve(routes({ 'POST /v1/me/timesheets': sequence([422, { error: 'INVALID_PERIOD', message: 'Monday' }], [409, { error: 'TIMESHEET_EXISTS', message: 'exists', details: { timesheetId: S_DRAFT } }]) }));
    renderComponent(Panel, [TS_READ, TS_SUBMIT]);
    const f = screen.getByRole('form', { name: 'Start a timesheet' });
    change(f, 'Week starting (Monday)', '2026-10-20');
    fireEvent.click(button(f, 'Start timesheet'));
    expect((await screen.findByText(/choose the Monday the week starts on/)).getAttribute('role')).toBe('alert');
    change(f, 'Week starting (Monday)', '2026-10-19');
    fireEvent.click(button(f, 'Start timesheet'));
    await screen.findByText('You already have a timesheet for this week. It is opened below.');
    await screen.findByRole('heading', { name: 'My week 2026-10-19 to 2026-10-25' });
    expect(bodiesTo('POST', '/v1/me/timesheets')).toEqual([{ periodStart: '2026-10-20' }, { periodStart: '2026-10-19' }]);
    expect(screen.getByRole('list', { name: 'My reminders' }).textContent).toContain('was due on 2026-10-19 and has not been submitted');
    expect(screen.getByText(/never a deduction or a penalty/)).toBeTruthy();
    expect(screen.getByRole('table', { name: 'My timesheet decisions' }).textContent).toContain('Approved on 2026-10-27');
    expect(callsTo('GET', '/v1/me/requests')[0]!.params.get('kind')).toBe('timesheet');
  });

  it('adds a line from own allocations in quarter hours and shows the 24-hour and duplicate refusals', async () => {
    const lines = `/v1/me/timesheets/${S_DRAFT}/lines`;
    serve(
      routes({
        [`POST ${lines}`]: sequence(
          [422, { error: 'DAILY_LIMIT_EXCEEDED', message: 'limit', details: { workDate: '2026-10-19', totalMinutes: 1455 } }],
          [409, { error: 'DUPLICATE_LINE', message: 'duplicate' }],
          [201, { lineId: 'l-2', ...detail() }],
        ),
      }),
    );
    renderComponent(Panel, [TS_READ, TS_SUBMIT]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open week 2026-10-19' }));
    const f = await screen.findByRole('form', { name: 'Add a line' });
    await within(f).findByRole('option', { name: 'PRJ-A / BUILD: Build' });
    expect(within(f).queryByRole('option', { name: /SUPPORT/ })).toBeNull();
    expect(field(f, 'Work date').value).toBe('2026-10-19');
    change(f, 'Job', J1);
    change(f, 'Activity', A_DEV);
    change(f, 'Time (quarter hours)', '450');
    change(f, 'Note (optional)', 'Synthetic build');
    fireEvent.click(button(f, 'Add line'));
    expect((await within(f).findByRole('alert')).textContent).toBe('The lines of 2026-10-19 would total 24:15 h: a day holds at most 24 hours.');
    expect(field(f, 'Time (quarter hours)').value).toBe('450');
    fireEvent.click(button(f, 'Add line'));
    await within(f).findByText('There is already a line for this day, job and activity. Change the time of that line instead of adding another.');
    fireEvent.click(button(f, 'Add line'));
    await within(f).findByRole('status');
    expect(bodiesTo('POST', lines)[0]).toEqual({ workDate: '2026-10-19', jobId: J1, activityId: A_DEV, minutes: 450, note: 'Synthetic build' });
    expect(bodiesTo('POST', lines)).toHaveLength(3);
    expect(field(f, 'Job').value).toBe('');
    expect(field(f, 'Time (quarter hours)').value).toBe('');
  });

  it('submits the draft against its version and says when it is flagged late', async () => {
    serve(routes({ [`POST /v1/me/timesheets/${S_DRAFT}/submit`]: [200, { timesheetId: S_DRAFT, revision: 1, state: 'SUBMITTED', late: true }] }));
    renderComponent(Panel, [TS_READ, TS_SUBMIT]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open week 2026-10-19' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Submit revision 1' }));
    expect((await screen.findByText(/so it is flagged late/)).textContent).toBe(
      'Submitted revision 1 for your manager’s decision. It was submitted after its due date, so it is flagged late; a late timesheet is still accepted.',
    );
    expect(bodiesTo('POST', `/v1/me/timesheets/${S_DRAFT}/submit`)).toEqual([{ expectedVersion: 4 }]);
  });

  it('continues a returned week in a new revision, disabled while in flight, and reads only own records', async () => {
    const returned = detail({
      state: 'RETURNED',
      revisions: [revision(1, 'INITIAL', 'RETURNED', { submittedOn: '2026-10-26', late: false, decidedAt: '2026-10-26T12:00:00.000Z', decisionReason: 'Synthetic: add the review meeting' })],
    });
    const revised = detail({ currentRevision: 2, shownRevision: 2, version: 5, revisions: [returned.revisions[0], revision(2, 'RETURNED', 'DRAFT')] });
    serve(routes({ [`GET /v1/timesheets/${S_DRAFT}`]: sequence([200, returned], [200, revised]), [`POST /v1/me/timesheets/${S_DRAFT}/revise`]: [201, revised] }));
    renderComponent(Panel, [TS_READ, TS_SUBMIT]);
    fireEvent.click(await screen.findByRole('button', { name: 'Open week 2026-10-19' }));
    expect((await screen.findByText(/Your manager returned this timesheet for changes/)).textContent).toContain('Continue in a new revision');
    expect(screen.getByRole('table', { name: 'Revisions' }).textContent).toContain('Reason: Synthetic: add the review meeting');
    expect(screen.queryByRole('form', { name: 'Add a line' })).toBeNull();
    const release = hold(`POST /v1/me/timesheets/${S_DRAFT}/revise`);
    fireEvent.click(screen.getByRole('button', { name: 'Start a new revision' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Start a new revision' }) as HTMLButtonElement).disabled).toBe(true));
    release();
    expect((await screen.findByText(/Opened revision 2 as a draft/)).textContent).toBe('Opened revision 2 as a draft with the previous lines carried over.');
    await screen.findByRole('form', { name: 'Add a line' });
    expect(callsTo('POST', `/v1/me/timesheets/${S_DRAFT}/revise`)).toHaveLength(1);
    const read = calls.filter((c) => c.method === 'GET').map((c) => c.path);
    expect(read.every((p) => p.startsWith('/v1/me/') || p === `/v1/timesheets/${S_DRAFT}`)).toBe(true);
  });

  it('says when the Employee context is needed, and offers no entry without the submit key', async () => {
    serve(routes({ 'GET /v1/me/timesheets': [403, { error: 'EMPLOYEE_CONTEXT_REQUIRED', message: 'Select your Employee role' }] }));
    renderComponent(Panel, [TS_READ]);
    expect((await screen.findByText(/Your own timesheets are kept in your Employee role/)).getAttribute('role')).toBe('alert');
    expect(screen.queryByRole('button', { name: 'Start timesheet' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'My allocations' })).toBeNull();
    await settle();
    expect(callsTo('GET', '/v1/me/timesheet-allocations')).toHaveLength(0);
  });

  it('lists own allocations with the activities each job permits', async () => {
    serve(routes());
    renderComponent(Panel, [TS_READ, TS_SUBMIT]);
    const table = await screen.findByRole('table', { name: 'My allocations' });
    expect(within(table).getAllByRole('row')[1]!.textContent).toBe('PRJ-A / BUILD: Build2026-10-01 to 2026-12-3160.00%DEV: Development');
  });
});
