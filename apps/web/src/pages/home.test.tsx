// Home, My Team and employee lists, jsdom. Employee list sorting (FR-007): a heading asks the server for that column and
// direction, the next click reverses it, a new sort goes back to the first page, and the current order is announced. The
// dashboard links a figure and offers a shortcut only as the server says (FR-097, DF17); My Team pages and filters at the
// server, in the address (DF16); the member page shows what the server returned, a section with no source in plain words. The
// employee list offers BR-003's reference views as status choices, and the record-section exports (FR-007) under their own duty.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage, EmployeesPage, MyTeamPage, TeamMemberPage, WidgetSourcePage } from './home';

const session = vi.hoisted(() => ({ granted: new Set<string>() }));
vi.mock('../session', () => ({ useSession: () => ({ can: (k: string) => session.granted.has(k), stored: { assignmentId: 'a-1', companyId: 'c-1' } }) }));

const urls: string[] = [];
const ITEM = { id: 'e-1', employeeCode: 'SYN-1', displayName: 'Synthetic Person', status: 'DRAFT', assignment: { departmentName: 'Engineering' }, joiningDate: '2026-01-05' };

function mockApi(total = 1) {
  urls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ items: [ITEM], total, page: 1, pageSize: 25 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}
/** Answers by the path: each entry's key is the start of the URL. */
function mockRoutes(answers: Record<string, unknown>) {
  urls.length = 0;
  const posts: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(url);
      if (init?.method === 'POST') posts.push({ url, body: JSON.parse(String(init.body)) });
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((k) => url.startsWith(k));
      if (!key) return new Response(JSON.stringify({ error: 'NOT_FOUND', message: `No answer for ${url}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(answers[key]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return { posts };
}
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const renderPage = (entry = '/employees') =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[entry]}>
        <EmployeesPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
const heading = (name: RegExp) => screen.getByRole('button', { name });
const params = () => new URL(urls.at(-1)!, 'http://test').searchParams;
const listParams = (prefix: string) => new URL([...urls].reverse().find((u) => u.startsWith(prefix))!, 'http://test').searchParams;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.granted.clear();
});

const DASHBOARD = {
  role: 'REPORTING_MANAGER',
  scope: 'TEAM',
  company: 'Synthetic Company',
  title: 'My team',
  state: 'OK',
  businessDate: '2026-11-03',
  period: { from: '2026-11-01', to: '2026-11-03' },
  refreshedAt: '2026-11-03T06:00:00Z',
  widgets: [
    { code: 'TEAM_EXCEPTIONS', title: 'Unresolved attendance exceptions today', kind: 'COUNT', status: 'OK', value: 2, source: { href: '/team?todayAttendance=EXCEPTION', combine: 'SUM', lists: [{ api: '/v1/my-team?todayAttendance=EXCEPTION' }] } },
    { code: 'MY_TASKS', title: 'Leave and expense decisions waiting', kind: 'COUNT', status: 'OK', value: 7 },
    { code: 'SOURCED', title: 'Failed payments', kind: 'COUNT', status: 'OK', value: 3, source: { href: '/dashboard/sources/SOURCED', combine: 'SUM', lists: [{ api: '/v1/expense/payments?state=FAILED' }], shortcut: { to: '/payments', label: 'Payments' } } },
    { code: 'PARTS', title: 'Completed / no-show', kind: 'STATUS', status: 'OK', value: '1/1', source: { href: '/dashboard/sources/PARTS', combine: 'PARTS', lists: [{ label: 'Completed', api: '/v1/training-participants?state=COMPLETED' }, { label: 'No-show', api: '/v1/training-participants?state=NO_SHOW' }] } },
    { code: 'NOT_SET', title: 'Annual leave balance', kind: 'BALANCE', status: 'NOT_CONFIGURED', message: 'Policy not active' },
    { code: 'NONE', title: 'Interview tasks due', kind: 'COUNT', status: 'NOT_AVAILABLE' },
  ],
  shortcuts: [{ to: '/team', label: 'My team' }],
};

const renderAt = (entry: string, path: string, element: JSX.Element) =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path={path} element={element} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('role dashboard (FR-096, FR-097, DF17)', () => {
  it('states the role, company, scope and period; a figure links only when the server gave it a source; unavailable and unset read differently', async () => {
    mockRoutes({ '/v1/dashboard/tasks': { items: [], total: 0 }, '/v1/dashboard': DASHBOARD });
    renderAt('/', '/', <DashboardPage />);
    expect((await screen.findByRole('link', { name: '2' })).getAttribute('href')).toBe('/team?todayAttendance=EXCEPTION');
    expect(screen.getByRole('link', { name: '3' }).getAttribute('href')).toBe('/dashboard/sources/SOURCED');
    expect(screen.queryByRole('link', { name: '7' })).toBeNull();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('Policy not active')).toBeTruthy();
    expect(screen.getByText('Not available yet')).toBeTruthy();
    const context = screen.getByText(/Synthetic Company/).textContent!;
    expect(context).toContain('Reporting manager');
    expect(context).toContain('My team');
    expect(context).toContain('2026-11-01');
  });

  it('a code reads in words and a decimal loses only its padding zeros; nothing is rounded', async () => {
    const figure = (code: string, value: string) => ({ code, title: `Figure ${code}`, kind: 'STATUS', status: 'OK', value });
    mockRoutes({
      '/v1/dashboard/tasks': { items: [], total: 0 },
      '/v1/dashboard': { ...DASHBOARD, widgets: [figure('A', 'NOT_PROCESSED'), figure('B', '12.0000'), figure('C', '12.5000'), figure('D', '100.0000'), figure('E', '1/1'), figure('F', 'PRESENT')] },
    });
    renderAt('/', '/', <DashboardPage />);
    for (const text of ['Not processed', '12', '12.5', '100', '1/1', 'Present']) expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText('NOT_PROCESSED')).toBeNull();
    expect(screen.queryByText('12.0000')).toBeNull();
  });

  it('shows only the shortcuts the server listed, and none when it lists none', async () => {
    mockRoutes({ '/v1/dashboard/tasks': { items: [], total: 0 }, '/v1/dashboard': DASHBOARD });
    renderAt('/', '/', <DashboardPage />);
    const shortcut = await screen.findByRole('link', { name: 'My team' });
    expect(shortcut.getAttribute('href')).toBe('/team');
    expect(screen.queryByRole('link', { name: 'Payments' })).toBeNull();
    cleanup();

    mockRoutes({ '/v1/dashboard/tasks': { items: [], total: 0 }, '/v1/dashboard': { ...DASHBOARD, shortcuts: [] } });
    renderAt('/', '/', <DashboardPage />);
    await screen.findByRole('link', { name: '2' });
    expect(screen.queryByRole('link', { name: 'My team' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Quick actions' })).toBeNull();
  });

  it('lists pending tasks, each leading to the decisions, says when nothing is waiting, and marks delegated and overdue', async () => {
    const task = { taskId: 't-1', kind: 'leave_request', ownerEmployeeCode: 'SYN-9', ownerName: 'Synthetic Member', assignedAt: '2026-11-01T06:00:00Z', dueAt: '2026-11-02T06:00:00Z', overdue: true, delegated: true };
    mockRoutes({ '/v1/dashboard/tasks': { items: [task], total: 1 }, '/v1/dashboard': DASHBOARD });
    renderAt('/', '/', <DashboardPage />);
    const row = (await screen.findByText(/leave request/)).closest('tr')!;
    expect(within(row).getByText('delegated')).toBeTruthy();
    expect(within(row).getByText('overdue')).toBeTruthy();
    expect(within(row).getByText('Synthetic Member (SYN-9)')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Open decisions' }).getAttribute('href')).toBe('/tasks');
    cleanup();

    mockRoutes({ '/v1/dashboard/tasks': { items: [], total: 0 }, '/v1/dashboard': DASHBOARD });
    renderAt('/', '/', <DashboardPage />);
    expect(await screen.findByText('Nothing waiting for you.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Open decisions' })).toBeNull();
  });

  it('FR-041, FR-096: lists a goal (KRA) review waiting for the user with the tasks, leading to the appraisal where it is reviewed', async () => {
    const task = { taskId: 't-1', kind: 'leave_request', ownerEmployeeCode: 'SYN-9', ownerName: 'Synthetic Member', assignedAt: '2026-11-01T06:00:00Z', dueAt: null, overdue: false, delegated: false };
    const review = {
      taskId: null,
      appraisalId: 'ap-1',
      kind: 'appraisal_goal_review',
      step: null,
      ownerEmployeeCode: 'SYN-7',
      ownerName: 'Synthetic Reviewee',
      assignedAt: '2026-11-03T06:00:00Z',
      dueAt: null,
      overdue: false,
      delegated: false,
    };
    mockRoutes({ '/v1/dashboard/tasks': { items: [task, review], total: 2 }, '/v1/dashboard': DASHBOARD });
    renderAt('/', '/', <DashboardPage />);
    expect(await screen.findByRole('heading', { name: 'Pending tasks (2)' })).toBeTruthy();
    const row = (await screen.findByText('Goal (KRA) review')).closest('tr')!;
    expect(within(row).getByText('Synthetic Reviewee (SYN-7)')).toBeTruthy();
    expect(within(row).getByRole('link', { name: 'Review the goals' }).getAttribute('href')).toBe('/appraisal/appraisals/ap-1');
    expect(within(row).queryByRole('link', { name: 'Open decisions' })).toBeNull();
    const other = screen.getByText(/leave request/).closest('tr')!;
    expect(within(other).getByRole('link', { name: 'Open decisions' }).getAttribute('href')).toBe('/tasks');
  });

  it('a role without a dashboard reads the neutral state, with no task list', async () => {
    mockRoutes({ '/v1/dashboard': { ...DASHBOARD, title: null, state: 'NO_DASHBOARD', widgets: [], shortcuts: [] } });
    renderAt('/', '/', <DashboardPage />);
    expect(await screen.findByText('No dashboard is available for this role.')).toBeTruthy();
    expect(urls.some((u) => u.startsWith('/v1/dashboard/tasks'))).toBe(false);
  });
});

describe('the records behind a figure (FR-097, DF17 "the same filters")', () => {
  it('asks for exactly the list the widget names, with its count; shows no record references; offers the module screen', async () => {
    mockRoutes({
      '/v1/dashboard': DASHBOARD,
      '/v1/expense/payments': { items: [{ id: 'p-1', employeeCode: 'SYN-2', employeeName: 'Synthetic Claimant', state: 'FAILED', paymentDate: '2026-11-02' }], total: 3 },
    });
    renderAt('/dashboard/sources/SOURCED', '/dashboard/sources/:code', <WidgetSourcePage />);
    expect(await screen.findByText('Synthetic Claimant')).toBeTruthy();
    expect(urls).toContain('/v1/expense/payments?state=FAILED');
    expect(screen.getByText('3 records')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open Payments' }).getAttribute('href')).toBe('/payments');
    expect(screen.queryByRole('columnheader', { name: 'id' })).toBeNull();
  });

  it('each list of a split figure is asked for and labelled', async () => {
    mockRoutes({
      '/v1/dashboard': DASHBOARD,
      '/v1/training-participants?state=COMPLETED': { items: [{ planCode: 'P1', state: 'COMPLETED' }], total: 1 },
      '/v1/training-participants?state=NO_SHOW': { items: [], total: 0 },
    });
    renderAt('/dashboard/sources/PARTS', '/dashboard/sources/:code', <WidgetSourcePage />);
    expect(await screen.findByText('Completed: 1 record')).toBeTruthy();
    expect(await screen.findByText('No-show: 0 records')).toBeTruthy();
    expect(screen.getByText('No records.')).toBeTruthy();
  });

  it('a figure with no source, or one no longer permitted in this role, asks for nothing and says so', async () => {
    mockRoutes({ '/v1/dashboard': DASHBOARD });
    renderAt('/dashboard/sources/MY_TASKS', '/dashboard/sources/:code', <WidgetSourcePage />);
    expect(await screen.findByText('This list is not available in the selected role.')).toBeTruthy();
    expect(urls).toEqual(['/v1/dashboard']);
  });
});

const MEMBER = { id: 'e-1', employeeCode: 'SYN-1', displayName: 'Synthetic Person', status: 'ACTIVE_CONFIRMED', department: 'Engineering', designation: 'Developer', location: 'Head office', manager: 'Synthetic Lead', joiningDate: '2026-01-05', todayAttendance: null, nextReviewDate: null };

describe('my team (FR-094, FR-056, DF16)', () => {
  const TEAM = {
    '/v1/my-team/filter-options': { departments: [{ id: 'd-1', name: 'Engineering' }], locations: [{ id: 'l-1', name: 'Head office' }] },
    '/v1/my-team': { items: [MEMBER], total: 60, page: 1, pageSize: 25 },
  };
  const team = () => listParams('/v1/my-team?');
  const Address = () => <span data-testid="address">{useLocation().search}</span>;
  const renderTeam = (entry = '/team') =>
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={[entry]}>
          <MyTeamPage />
          <Address />
        </MemoryRouter>
      </QueryClientProvider>,
    );

  it('keeps the server’s order until a heading is chosen, then asks the server for that column, reversing on the second click', async () => {
    mockRoutes(TEAM);
    renderTeam();
    await screen.findByText('SYN-1');
    expect(team().has('sort')).toBe(false);
    expect(team().get('pageSize')).toBe('25');
    expect(screen.getByRole('columnheader', { name: /Name/ }).getAttribute('aria-sort')).toBe('none');
    fireEvent.click(heading(/^Next review/));
    await waitFor(() => expect(team().get('sort')).toBe('nextReviewDate'));
    expect(team().get('direction')).toBe('ASC');
    await waitFor(() => expect(screen.getByRole('columnheader', { name: /Next review/ }).getAttribute('aria-sort')).toBe('ascending'));
    fireEvent.click(heading(/^Next review/));
    await waitFor(() => expect(team().get('direction')).toBe('DESC'));
    // Today’s attendance is a value of today, not a sortable column.
    expect(screen.queryByRole('button', { name: /^Today/ })).toBeNull();
  });

  it('shows the DF16 columns: location, manager and joining date', async () => {
    mockRoutes(TEAM);
    renderTeam();
    const row = (await screen.findByText('SYN-1')).closest('tr')!;
    expect(within(row).getByText('Head office')).toBeTruthy();
    expect(within(row).getByText('Synthetic Lead')).toBeTruthy();
    for (const name of [/^Location/, /^Joined/]) expect(heading(name)).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Manager' })).toBeTruthy();
  });

  it('pages at the server in 25, 50 or 100 and shows the total; a new size returns to page one', async () => {
    mockRoutes(TEAM);
    renderTeam();
    await screen.findByText('SYN-1');
    expect(screen.getByRole('heading', { name: 'My team (60)' })).toBeTruthy();
    expect(screen.getByText('Page 1 of 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(team().get('page')).toBe('2'));
    const size = screen.getByLabelText(/Rows/) as HTMLSelectElement;
    expect([...size.options].map((o) => o.value)).toEqual(['25', '50', '100']);
    fireEvent.change(size, { target: { value: '50' } });
    await waitFor(() => expect(team().get('pageSize')).toBe('50'));
    expect(team().get('page')).toBe('1');
  });

  it('sends each filter to the server, and keeps it in the address', async () => {
    mockRoutes(TEAM);
    renderTeam();
    await screen.findByRole('option', { name: 'Engineering' });
    fireEvent.change(screen.getByLabelText(/Department/), { target: { value: 'd-1' } });
    await waitFor(() => expect(team().get('departmentId')).toBe('d-1'));
    fireEvent.change(screen.getByLabelText(/Location/), { target: { value: 'l-1' } });
    await waitFor(() => expect(team().get('locationId')).toBe('l-1'));
    fireEvent.change(screen.getByLabelText(/Status/), { target: { value: 'NOTICE' } });
    await waitFor(() => expect(team().get('status')).toBe('NOTICE'));
    fireEvent.change(screen.getByLabelText(/Review due from/), { target: { value: '2026-11-01' } });
    await waitFor(() => expect(team().get('reviewDueFrom')).toBe('2026-11-01'));
    fireEvent.change(screen.getByLabelText(/^to/), { target: { value: '2026-11-30' } });
    await waitFor(() => expect(team().get('reviewDueTo')).toBe('2026-11-30'));
    expect(screen.getByTestId('address').textContent).toContain('departmentId=d-1');
    fireEvent.change(screen.getByLabelText(/Search/), { target: { value: 'syn' } });
    await waitFor(() => expect(team().get('search')).toBe('syn'));
  });

  it('opened from a dashboard figure, applies its filter and states it; clearing it lists everyone', async () => {
    mockRoutes(TEAM);
    renderTeam('/team?todayAttendance=EXCEPTION');
    await screen.findByText('SYN-1');
    expect(team().get('todayAttendance')).toBe('EXCEPTION');
    expect(screen.getByText(/Attendance today: exception/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(team().has('todayAttendance')).toBe(false));
    expect(screen.queryByText(/Attendance today/)).toBeNull();
  });

  it('offers the export only with its own grant, and asks for it with the list’s filters and order', async () => {
    mockRoutes(TEAM);
    renderTeam();
    await screen.findByText('SYN-1');
    expect(screen.queryByRole('button', { name: 'Export this list' })).toBeNull();
    cleanup();

    session.granted.add('team.export.operational');
    const { posts } = mockRoutes({ ...TEAM, '/v1/reports': { id: 'r-1', state: 'QUEUED', format: 'CSV' } });
    renderTeam('/team?status=NOTICE');
    await screen.findByText('SYN-1');
    fireEvent.click(heading(/^Location/));
    await waitFor(() => expect(team().get('sort')).toBe('location'));
    fireEvent.click(screen.getByRole('button', { name: 'Export this list' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/v1/reports', body: { reportCode: 'MY_TEAM', filters: { status: 'NOTICE', sort: 'location', direction: 'ASC' } } });
    expect((await screen.findByRole('link', { name: 'Reports' })).getAttribute('href')).toBe('/reports');
  });
});

describe('member detail (FR-095, DF16)', () => {
  const detail = (tabs: Record<string, unknown>) => ({ '/v1/my-team/e-1': { employeeId: 'e-1', tabs } });
  const renderMember = () => renderAt('/team/e-1', '/team/:id', <TeamMemberPage />);

  it('shows only the tabs the server returned, under DF16’s titles', async () => {
    mockRoutes(detail({ workProfile: { available: true, data: { employeeCode: 'SYN-1' } }, attendance: { available: true, items: [] } }));
    renderMember();
    await screen.findByRole('heading', { name: 'Work profile' });
    expect(screen.getByRole('heading', { name: 'Attendance (30 days)' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Compensation and increment history' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'History' })).toBeNull();
    expect(screen.getByText('Nothing recorded yet.')).toBeTruthy();
  });

  it('a category with no source reads differently from an empty one', async () => {
    mockRoutes(
      detail({
        skillsAndTraining: {
          available: true,
          sections: {
            training: { available: true, items: [] },
            skills: { available: false, message: 'This system does not keep a skills record, so no skills can be shown.' },
          },
        },
      }),
    );
    renderMember();
    await screen.findByRole('heading', { name: 'Skills and training' });
    expect(screen.getByText('This system does not keep a skills record, so no skills can be shown.')).toBeTruthy();
    expect(screen.getAllByText('Nothing recorded yet.')).toHaveLength(1);
  });

  it('history shows what changed, and a masked value as the server sent it', async () => {
    mockRoutes(
      detail({
        history: {
          available: true,
          items: [
            { occurredAt: '2026-10-01T06:00:00Z', effectiveDate: null, action: 'UPDATE', changes: [{ field: 'displayName', before: 'Old', after: 'New', masked: false }, { field: 'dateOfBirth', before: 'Protected', after: 'Protected', masked: true }] },
          ],
        },
      }),
    );
    renderMember();
    await screen.findByRole('heading', { name: 'History' });
    expect(screen.getByText('displayName: Old → New')).toBeTruthy();
    expect(screen.getByText('dateOfBirth: Protected → Protected')).toBeTruthy();
  });

  it('goals read by cycle with their task status; compensation by its granted sections; documents open on the documents page', async () => {
    mockRoutes(
      detail({
        goalsAndTasks: { available: true, sections: { goals: { available: true, items: [{ cycleCode: 'FY-1', cycleName: 'Synthetic cycle', state: 'SUBMITTED', taskStatus: 'AWAITING_REVIEW', goals: [{ sequence: 1, name: 'Synthetic goal', weight: 100, selfEntryComplete: true, managerRatingComplete: false }] }] } } },
        compensation: { available: true, sections: { incrementHistory: { available: true, items: [{ effectiveDate: '2026-04-01', afterAmount: '110000.00' }] } } },
        privateInformation: { available: true, sections: { documents: { available: true, items: [{ id: 'doc-1', documentType: 'GENERAL', fileName: 'released.pdf' }] } } },
      }),
    );
    renderMember();
    expect(await screen.findByText('Synthetic goal')).toBeTruthy();
    expect(screen.getByText(/Synthetic cycle \(FY-1\)/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Increment history' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Salary' })).toBeNull();
    expect(screen.getByText('110000.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open documents' }).getAttribute('href')).toBe('/employees/e-1/documents');
  });

  // I-89 item 4 (I-62, I-86 item 6): the copied competencies beside the goals, names, weights and completion flags only.
  it('goals and tasks list each appraisal’s competencies beside its goals, and nothing for a cycle without them', async () => {
    const goal = { sequence: 1, name: 'Synthetic goal', weight: 100, selfEntryComplete: true, managerRatingComplete: false };
    mockRoutes(
      detail({
        goalsAndTasks: {
          available: true,
          sections: {
            goals: {
              available: true,
              items: [
                {
                  cycleCode: 'FY-2',
                  cycleName: 'Competency cycle',
                  state: 'SELF_SUBMITTED',
                  taskStatus: 'AWAITING_RATING',
                  goals: [goal],
                  competencies: [
                    { sequence: 1, name: 'Synthetic teamwork', weight: 60, selfEntryComplete: true, managerRatingComplete: false },
                    { sequence: 2, name: 'Synthetic ownership', weight: 40, selfEntryComplete: false, managerRatingComplete: false },
                  ],
                },
                { cycleCode: 'FY-1', cycleName: 'Goals-only cycle', state: 'APPROVED', taskStatus: 'COMPLETED', goals: [goal], competencies: [] },
              ],
            },
          },
        },
      }),
    );
    renderMember();
    const competencies = within(await screen.findByLabelText('Competencies of FY-2'));
    expect(competencies.getByText('Synthetic teamwork')).toBeTruthy();
    expect(competencies.getByText('60')).toBeTruthy();
    expect(competencies.getByText('Synthetic ownership')).toBeTruthy();
    expect(competencies.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['sequence', 'name', 'weight', 'selfEntryComplete', 'managerRatingComplete']);
    expect(competencies.getAllByText('yes')).toHaveLength(1);
    // A cycle that does not assess competencies shows its goals and no competency table.
    expect(screen.getByText(/Goals-only cycle \(FY-1\)/)).toBeTruthy();
    expect(screen.queryByLabelText('Competencies of FY-1')).toBeNull();
    expect(screen.getAllByRole('heading', { name: 'Competencies' })).toHaveLength(1);
  });
});

describe('employee list links (FR-008)', () => {
  it('a name opens the record for a role that may read it, and is plain text for one that may not', async () => {
    mockApi();
    renderPage();
    await screen.findByText('SYN-1');
    expect(screen.queryByRole('link', { name: 'Synthetic Person' })).toBeNull();
    expect(screen.getByText('Synthetic Person')).toBeTruthy();
    cleanup();

    session.granted.add('employee.read.operational');
    mockApi();
    renderPage();
    expect((await screen.findByRole('link', { name: 'Synthetic Person' })).getAttribute('href')).toBe('/employees/e-1');
  });
});

describe('employee list sorting (FR-007)', () => {
  it('starts on the employee code and asks the server for each column, reversing on the second click', async () => {
    mockApi();
    renderPage();
    await screen.findByText('SYN-1');
    expect(params().get('sort')).toBe('employeeCode');
    expect(params().get('direction')).toBe('ASC');
    expect(screen.getByRole('columnheader', { name: /Code/ }).getAttribute('aria-sort')).toBe('ascending');
    expect(screen.getByRole('columnheader', { name: /Name/ }).getAttribute('aria-sort')).toBe('none');

    fireEvent.click(heading(/^Joined/));
    await waitFor(() => expect(params().get('sort')).toBe('joiningDate'));
    expect(params().get('direction')).toBe('ASC');
    expect(screen.getByRole('columnheader', { name: /Joined/ }).getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(heading(/^Joined/));
    await waitFor(() => expect(params().get('direction')).toBe('DESC'));
    expect(screen.getByRole('columnheader', { name: /Joined/ }).getAttribute('aria-sort')).toBe('descending');

    // Another column starts ascending again.
    fireEvent.click(heading(/^Department/));
    await waitFor(() => expect(params().get('sort')).toBe('department'));
    expect(params().get('direction')).toBe('ASC');
  });

  it('a new sort returns to the first page, and the search stays', async () => {
    mockApi(60);
    renderPage();
    await screen.findByText('SYN-1');
    fireEvent.change(screen.getByLabelText(/Search/), { target: { value: 'syn' } });
    await waitFor(() => expect(params().get('search')).toBe('syn'));
    fireEvent.click(await screen.findByRole('button', { name: 'Next' }));
    await waitFor(() => expect(params().get('page')).toBe('2'));

    fireEvent.click(heading(/^Status/));
    await waitFor(() => expect(params().get('sort')).toBe('status'));
    expect(params().get('page')).toBe('1');
    expect(params().get('search')).toBe('syn');
  });

  it('offers every column the server allows, each asking for that column', async () => {
    mockApi();
    renderPage();
    await screen.findByText('SYN-1');
    const columns: [RegExp, string][] = [
      [/^Name/, 'displayName'],
      [/^Department/, 'department'],
      [/^Location/, 'location'],
      [/^Designation/, 'designation'],
      [/^Joined/, 'joiningDate'],
      [/^Status/, 'status'],
      [/^Code/, 'employeeCode'],
    ];
    for (const [name, sort] of columns) {
      fireEvent.click(heading(name));
      await waitFor(() => expect(params().get('sort')).toBe(sort));
    }
  });

  it('opened from a dashboard figure, applies its status filter and states it; clearing it lists everyone', async () => {
    mockApi();
    renderPage('/employees?statusGroup=ACTIVE');
    await screen.findByText('SYN-1');
    expect(params().get('statusGroup')).toBe('ACTIVE');
    expect(screen.getByText(/Status: Active \(probation, confirmed or notice\)/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(params().has('statusGroup')).toBe(false));
    cleanup();

    mockApi();
    renderPage('/employees?status=DRAFT');
    await screen.findByText('SYN-1');
    expect(params().get('status')).toBe('DRAFT');
  });
});

describe('employee list filters and export (FR-007, I-37)', () => {
  const ORG_READ = 'org_master.read.operational';
  const EXPORT = 'employee.export.operational';
  const LIST = { items: [ITEM], total: 60, page: 1, pageSize: 25 };
  const DEPARTMENTS = { items: [{ id: 'd-1', code: 'ENG', name: 'Engineering', active: true }, { id: 'd-2', code: 'OLD', name: 'Old department', active: false }] };
  const answers = { '/v1/employees': LIST, '/v1/org/departments': DEPARTMENTS, '/v1/reports': { id: 'r-1', state: 'QUEUED' } };
  const list = () => listParams('/v1/employees');
  const Address = () => <span data-testid="address">{useLocation().search}</span>;
  const renderWithAddress = (entry = '/employees') =>
    render(
      <QueryClientProvider client={client()}>
        <MemoryRouter initialEntries={[entry]}>
          <EmployeesPage />
          <Address />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

  it('sends each filter to the server and keeps it in the address; a filter returns to the first page', async () => {
    session.granted.add(ORG_READ);
    mockRoutes(answers);
    renderWithAddress();
    await screen.findByText('SYN-1');
    await screen.findByRole('option', { name: 'Engineering' });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(list().get('page')).toBe('2'));

    change('Status', 'NOTICE');
    await waitFor(() => expect(list().get('status')).toBe('NOTICE'));
    expect(list().get('page')).toBe('1');
    change('Department', 'd-1');
    await waitFor(() => expect(list().get('departmentId')).toBe('d-1'));
    change('Joined from', '2026-01-01');
    await waitFor(() => expect(list().get('joinedFrom')).toBe('2026-01-01'));
    change('Joined to', '2026-06-30');
    await waitFor(() => expect(list().get('joinedTo')).toBe('2026-06-30'));
    // Every filter holds together.
    expect(Object.fromEntries(list())).toMatchObject({ status: 'NOTICE', departmentId: 'd-1', joinedFrom: '2026-01-01', joinedTo: '2026-06-30', sort: 'employeeCode', direction: 'ASC' });
    expect(screen.getByTestId('address').textContent).toBe('?status=NOTICE&departmentId=d-1&joinedFrom=2026-01-01&joinedTo=2026-06-30');

    // A filter emptied goes from the request and the address.
    change('Department', '');
    await waitFor(() => expect(list().has('departmentId')).toBe(false));
    expect(screen.getByTestId('address').textContent).not.toContain('departmentId');
  });

  it('offers DF04’s statuses and the active set; each choice replaces the other, and an address opens on its own choice', async () => {
    mockRoutes(answers);
    renderWithAddress('/employees?statusGroup=ACTIVE');
    await screen.findByText('SYN-1');
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual([
      '',
      'statusGroup:ACTIVE',
      ...['CURRENT', 'OFFERED', 'OFFERED_REJECTED', 'ON_PROBATION', 'ON_NOTICE', 'LEFT'].map((v) => `statusGroup:${v}`),
      'DRAFT',
      'ACTIVE_PROBATION',
      'ACTIVE_CONFIRMED',
      'NOTICE',
      'INACTIVE_SEPARATED',
      'ARCHIVED',
    ]);
    expect(select.value).toBe('statusGroup:ACTIVE');

    change('Status', 'DRAFT');
    await waitFor(() => expect(list().get('status')).toBe('DRAFT'));
    expect(list().has('statusGroup')).toBe(false);
    change('Status', 'statusGroup:ACTIVE');
    await waitFor(() => expect(list().get('statusGroup')).toBe('ACTIVE'));
    expect(list().has('status')).toBe(false);
    cleanup();

    mockRoutes(answers);
    renderWithAddress('/employees?status=INACTIVE_SEPARATED&joinedFrom=2026-02-01');
    await screen.findByText('SYN-1');
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('INACTIVE_SEPARATED');
    expect((screen.getByLabelText('Joined from') as HTMLInputElement).value).toBe('2026-02-01');
    expect(list().get('joinedFrom')).toBe('2026-02-01');
  });

  it('clearing a dashboard’s status leaves the other filters in place', async () => {
    mockRoutes(answers);
    renderWithAddress('/employees?statusGroup=ACTIVE&joinedTo=2026-06-30');
    await screen.findByText('SYN-1');
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() => expect(list().has('statusGroup')).toBe(false));
    expect(list().get('joinedTo')).toBe('2026-06-30');
  });

  it('department choices come from the master, inactive ones marked; without its read duty there is no choice and nothing is asked', async () => {
    session.granted.add(ORG_READ);
    mockRoutes(answers);
    renderPage();
    await screen.findByRole('option', { name: 'Old department (inactive)' });
    expect(urls).toContain('/v1/org/departments?includeInactive=true');
    cleanup();
    session.granted.clear();

    mockRoutes(answers);
    renderWithAddress('/employees?departmentId=d-1');
    await screen.findByText('SYN-1');
    expect(screen.queryByLabelText('Department')).toBeNull();
    expect(urls.filter((u) => u.startsWith('/v1/org/'))).toEqual([]);
    expect(screen.getByText(/Your role cannot read the department list/)).toBeTruthy();
    // A filter it came with is applied, and it can still let go of it.
    expect(list().get('departmentId')).toBe('d-1');
    fireEvent.click(screen.getByRole('button', { name: 'Clear the department filter' }));
    await waitFor(() => expect(list().has('departmentId')).toBe(false));
  });

  it('a reversed date range is the server’s to refuse: it is sent, and the refusal reads beside the list', async () => {
    urls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const reversed = url.includes('joinedFrom=2026-03-10');
        return new Response(JSON.stringify(reversed ? { error: 'INVALID_PERIOD', message: 'The joining date range ends before it starts' } : LIST), { status: reversed ? 422 : 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    renderWithAddress('/employees?joinedTo=2026-03-01');
    await screen.findByText('SYN-1');
    change('Joined from', '2026-03-10');
    expect((await screen.findByRole('alert')).textContent).toContain('The joining date range ends before it starts');
    expect(list().get('joinedFrom')).toBe('2026-03-10');
    expect(list().get('joinedTo')).toBe('2026-03-01');
    expect((screen.getByLabelText('Joined from') as HTMLInputElement).value).toBe('2026-03-10');
  });

  it('offers the export only with its own grant', async () => {
    mockRoutes(answers);
    renderPage();
    await screen.findByText('SYN-1');
    expect(screen.queryByRole('button', { name: 'Export this list' })).toBeNull();
    cleanup();

    session.granted.add(EXPORT);
    mockRoutes(answers);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Export this list' })).toBeTruthy();
  });

  it('asks for the employee register with exactly the list’s filters and order, the active set too', async () => {
    session.granted.add(EXPORT);
    session.granted.add(ORG_READ);
    const { posts } = mockRoutes(answers);
    renderPage('/employees?statusGroup=ACTIVE&departmentId=d-1&joinedFrom=2026-01-01&joinedTo=2026-06-30');
    await screen.findByText('SYN-1');
    fireEvent.change(screen.getByLabelText(/Search/), { target: { value: 'syn' } });
    await waitFor(() => expect(list().get('search')).toBe('syn'));
    fireEvent.click(heading(/^Joined/));
    fireEvent.click(heading(/^Joined/));
    await waitFor(() => expect(list().get('direction')).toBe('DESC'));

    fireEvent.click(screen.getByRole('button', { name: 'Export this list' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      url: '/v1/reports',
      body: {
        reportCode: 'EMPLOYEE_REGISTER',
        filters: { statusGroup: 'ACTIVE', departmentId: 'd-1', joinedFrom: '2026-01-01', joinedTo: '2026-06-30', search: 'syn', sort: 'joiningDate', direction: 'DESC' },
      },
    });
    // What the export holds is what the list was asked for, the page aside.
    const { page, pageSize, ...asked } = Object.fromEntries(list());
    expect(asked).toEqual((posts[0]!.body as { filters: Record<string, string> }).filters);
    expect([page, pageSize]).toEqual(['1', '25']);
  });

  it('says where to collect the export; changing the list takes that away, since it no longer describes the list', async () => {
    session.granted.add(EXPORT);
    mockRoutes(answers);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Export this list' }));
    expect((await screen.findByRole('link', { name: 'Reports' })).getAttribute('href')).toBe('/reports');
    change('Status', 'NOTICE');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Reports' })).toBeNull());
  });

  it('an export the server refuses says so', async () => {
    session.granted.add(EXPORT);
    urls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url);
        const refused = init?.method === 'POST';
        return new Response(JSON.stringify(refused ? { error: 'FORBIDDEN', message: 'Not permitted' } : LIST), { status: refused ? 403 : 200, headers: { 'Content-Type': 'application/json' } });
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Export this list' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Not permitted');
    expect(screen.queryByRole('link', { name: 'Reports' })).toBeNull();
  });

  it('BR-003 offers the reference views and asks the list and the export for the chosen view', async () => {
    session.granted.add(EXPORT);
    const { posts } = mockRoutes(answers);
    renderWithAddress('/employees?status=DRAFT');
    await screen.findByText('SYN-1');
    const select = screen.getByLabelText('Status') as HTMLSelectElement;
    const views = select.querySelector('optgroup[label="Views"]')!;
    expect([...views.querySelectorAll('option')].map((o) => [o.value, o.textContent])).toEqual([
      ['statusGroup:CURRENT', 'Current (probation, confirmed or notice)'],
      ['statusGroup:OFFERED', 'Offered (pre-joining, not yet activated)'],
      ['statusGroup:OFFERED_REJECTED', 'Offered, rejected (closed before joining)'],
      ['statusGroup:ON_PROBATION', 'On probation'],
      ['statusGroup:ON_NOTICE', 'On notice'],
      ['statusGroup:LEFT', 'Left'],
    ]);

    // A view replaces the status chosen; the list, the address and the export all carry it.
    change('Status', 'statusGroup:OFFERED_REJECTED');
    await waitFor(() => expect(list().get('statusGroup')).toBe('OFFERED_REJECTED'));
    expect(list().has('status')).toBe(false);
    expect(screen.getByTestId('address').textContent).toBe('?statusGroup=OFFERED_REJECTED');
    expect(select.value).toBe('statusGroup:OFFERED_REJECTED');
    expect(screen.getByText(/Status: Offered, rejected \(closed before joining\)/)).toBeTruthy();
    // Without Hiring's read duty there is no pointer to its offer list.
    expect(screen.queryByRole('link', { name: 'offer list' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Export this list' }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ url: '/v1/reports', body: { reportCode: 'EMPLOYEE_REGISTER', filters: { statusGroup: 'OFFERED_REJECTED', sort: 'employeeCode', direction: 'ASC' } } });

    change('Status', 'statusGroup:ON_NOTICE');
    await waitFor(() => expect(list().get('statusGroup')).toBe('ON_NOTICE'));
    expect(screen.getByText(/Status: On notice/)).toBeTruthy();
    // A status replaces the view in turn.
    change('Status', 'NOTICE');
    await waitFor(() => expect(list().get('status')).toBe('NOTICE'));
    expect(list().has('statusGroup')).toBe(false);
    cleanup();

    // An address opens on its own view; with Hiring's read duty, offers that are not employee records are pointed to Hiring.
    session.granted.add('offer.read.operational');
    mockRoutes(answers);
    renderWithAddress('/employees?statusGroup=OFFERED');
    await screen.findByText('SYN-1');
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('statusGroup:OFFERED');
    expect(list().get('statusGroup')).toBe('OFFERED');
    expect(screen.getByText(/awaiting the candidate’s answer, and offers the candidate declined, are candidates rather than employee records/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'offer list' }).getAttribute('href')).toBe('/hiring/offers');
    change('Status', 'statusGroup:CURRENT');
    await waitFor(() => expect(list().get('statusGroup')).toBe('CURRENT'));
    expect(screen.queryByRole('link', { name: 'offer list' })).toBeNull();
  });

  it('FR-007 offers the section exports only with employee.export.private and sends the list’s filters', async () => {
    const SECTION_EXPORTS = ['Export family details', 'Export qualifications', 'Export prior employment'];
    session.granted.add(EXPORT);
    mockRoutes(answers);
    renderPage();
    await screen.findByText('SYN-1');
    expect(screen.getByRole('button', { name: 'Export this list' })).toBeTruthy();
    for (const name of SECTION_EXPORTS) expect(screen.queryByRole('button', { name })).toBeNull();
    cleanup();

    session.granted.add('employee.export.private');
    const { posts } = mockRoutes(answers);
    renderPage('/employees?statusGroup=LEFT&joinedFrom=2026-01-01');
    await screen.findByText('SYN-1');
    fireEvent.change(screen.getByLabelText(/Search/), { target: { value: 'syn' } });
    await waitFor(() => expect(list().get('search')).toBe('syn'));
    for (const name of ['Export this list', ...SECTION_EXPORTS]) fireEvent.click(screen.getByRole('button', { name }));
    await waitFor(() => expect(posts).toHaveLength(4));
    const filters = { statusGroup: 'LEFT', joinedFrom: '2026-01-01', search: 'syn', sort: 'employeeCode', direction: 'ASC' };
    expect(posts.every((p) => p.url === '/v1/reports')).toBe(true);
    const requested = posts.map((p) => p.body as { reportCode: string }).sort((a, b) => a.reportCode.localeCompare(b.reportCode));
    expect(requested).toEqual(['EMPLOYEE_FAMILY', 'EMPLOYEE_PRIOR_EMPLOYMENT', 'EMPLOYEE_QUALIFICATIONS', 'EMPLOYEE_REGISTER'].map((reportCode) => ({ reportCode, filters })));
    // Each export holds what the list was asked for, the page aside.
    const { page, pageSize, ...asked } = Object.fromEntries(list());
    expect(asked).toEqual(filters);
    expect([page, pageSize]).toEqual(['1', '25']);
    // Each says where to collect it; a changed list takes every one of those away.
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Reports' })).toHaveLength(4));
    change('Status', 'NOTICE');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Reports' })).toBeNull());
    cleanup();

    // They follow their own duty, not the register's.
    session.granted.delete(EXPORT);
    mockRoutes(answers);
    renderPage();
    await screen.findByText('SYN-1');
    expect(screen.queryByRole('button', { name: 'Export this list' })).toBeNull();
    for (const name of SECTION_EXPORTS) expect(screen.getByRole('button', { name })).toBeTruthy();
  });
});
