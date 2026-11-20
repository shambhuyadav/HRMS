// Home dashboard charts (owner's request of 20 Nov 2026), jsdom: each chart is offered only under the permission of the page its
// list comes from (own-record charts only where the role is linked to an employee and its scope reaches the own record), reads
// that page's own request, holds its numbers in a table view, answers hover and keyboard focus, and is simply left out when its
// list is refused, fails or is empty, with no error on Home. The existing figures, quick actions and lists keep their place.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { axe } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from '../home';
import { share } from './charts';
import { monthDays } from './home-charts';

const session = vi.hoisted(() => ({ granted: new Set<string>(), me: undefined as { employeeId: string | null; scopeKind: string; displayName: string | null } | undefined }));
vi.mock('../../session', () => ({ useSession: () => ({ me: session.me, can: (k: string) => session.granted.has(k), stored: { assignmentId: 'a-1', companyId: 'c-1' } }) }));

const urls: string[] = [];
/** Answers by the longest matching URL start; `statuses` gives a key another status (with an error body). Anything else is 404. */
function mockRoutes(answers: Record<string, unknown>, statuses: Record<string, number> = {}) {
  urls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((k) => url.startsWith(k));
      if (!key) return new Response(JSON.stringify({ error: 'NOT_FOUND', message: `No answer for ${url}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      const status = statuses[key] ?? 200;
      const body = status === 200 ? answers[key] : { error: status === 403 ? 'FORBIDDEN' : 'ERROR', message: status === 403 ? 'Not permitted' : 'Failed' };
      return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.granted.clear();
  session.me = undefined;
});

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={['/']}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

const grant = (...keys: string[]) => keys.forEach((k) => session.granted.add(k));
const EMPLOYEE = { employeeId: 'emp-1', scopeKind: 'OWN', displayName: 'Synthetic Person' };

const DASHBOARD = {
  role: 'EMPLOYEE',
  scope: 'OWN',
  company: 'Synthetic Company',
  title: 'My work',
  state: 'OK',
  businessDate: '2026-11-03',
  period: { from: '2026-11-01', to: '2026-11-03' },
  refreshedAt: '2026-11-03T06:00:00Z',
  widgets: [{ code: 'MY_TASKS', title: 'Leave and expense decisions waiting', kind: 'COUNT', status: 'OK', value: 7 }],
  shortcuts: [],
};
const BASE = { '/v1/dashboard/tasks': { items: [], total: 0 }, '/v1/dashboard/activity': { status: 'OK', days: 7, items: [], total: 0 }, '/v1/dashboard': DASHBOARD };

const BALANCES = {
  employeeId: 'emp-1',
  items: [
    { leaveType: 'ANNUAL', leaveTypeName: 'Annual leave', paid: true, available: '8.0000', pending: '1.0000', taken: '4.5000' },
    { leaveType: 'SICK', leaveTypeName: 'Sick leave', paid: true, available: '6.0000', pending: '0.0000', taken: '0.0000' },
    { leaveType: 'LWP', leaveTypeName: 'Leave without pay', paid: false, available: '-2.0000', pending: '0.0000', taken: '2.0000' },
  ],
};
const ATTENDANCE = {
  employeeId: 'emp-1',
  items: [
    { id: 'r-1', workDate: '2026-11-01', status: 'WEEKLY_OFF', workedMinutes: null, late: false, amended: false },
    { id: 'r-2', workDate: '2026-11-02', status: 'PRESENT', workedMinutes: 485, late: true, amended: false },
  ],
};
const member = (n: number, todayAttendance: string | null) => ({ id: `t-${n}`, employeeCode: `SYN-${n}`, displayName: `Synthetic Member ${n}`, todayAttendance, status: 'ACTIVE_CONFIRMED' });
const TEAM = { items: [member(1, 'PRESENT'), member(2, 'LEAVE'), member(3, 'HALF_DAY_LEAVE'), member(4, 'ABSENT'), member(5, null)], total: 5, page: 1, pageSize: 100 };

const LEAVE_URL = '/v1/employees/emp-1/leave-balances';
const ATTENDANCE_URL = '/v1/employees/emp-1/attendance?from=2026-11-01&to=2026-11-03';
const TEAM_URL = '/v1/my-team?page=1&pageSize=100';

const cardOf = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('section') as HTMLElement;
const rowsOf = (table: HTMLElement) => within(table).getAllByRole('row').map((r) => within(r).queryAllByRole('cell').map((c) => c.textContent?.trim()));
const tipOf = (card: HTMLElement) => card.querySelector('.dash-chart-tip')?.textContent ?? null;
/** Lets every answered request settle. */
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 30)));

describe('My leave balances (leave.read.operational, own record)', () => {
  it('draws each paid type as one bar from the Leave page’s request, after the quick actions and before pending tasks', async () => {
    session.me = EMPLOYEE;
    grant('leave.read.operational', 'leave.submit.operational');
    mockRoutes({ ...BASE, [LEAVE_URL]: BALANCES });
    show();
    const card = await cardOf('My leave balances (days)');
    expect(urls).toContain(LEAVE_URL);
    expect(within(card).getByRole('img', { name: 'Annual leave, in days: 8 available, 4.5 taken, 1 pending' })).toBeTruthy();
    expect(within(card).getByRole('img', { name: 'Sick leave, in days: 6 available, 0 taken, 0 pending' })).toBeTruthy();
    // One legend for the list; the figures are written beside each bar, so no value is told by colour alone.
    expect(within(within(card).getByRole('list', { name: 'Leave balance parts' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Taken', 'Pending', 'Available']);
    expect(within(card).getByText('4.5 taken · 1 pending')).toBeTruthy();
    // Unpaid leave has no balance to fill: written, not drawn.
    expect(within(card).queryByRole('img', { name: /Leave without pay/ })).toBeNull();
    expect(within(card).getByText('Leave without pay (unpaid, no balance): 2 taken · 0 pending')).toBeTruthy();
    expect(within(card).getByRole('link', { name: 'Open Leave' }).getAttribute('href')).toBe('/leave');
    // Placed after the quick actions and before pending tasks and recent activity, which keep their order.
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Quick actions', 'My leave balances (days)', 'Pending tasks (0)', 'Recent activity (last 7 days)']),
    );
  });

  it('the table view holds the same numbers, as the Leave page names them', async () => {
    session.me = EMPLOYEE;
    grant('leave.read.operational');
    mockRoutes({ ...BASE, [LEAVE_URL]: BALANCES });
    show();
    const card = await cardOf('My leave balances (days)');
    fireEvent.click(within(card).getByRole('button', { name: 'Show as table' }));
    const table = within(card).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Type', 'Available', 'Pending', 'Taken']);
    expect(rowsOf(table).slice(1)).toEqual([
      ['Annual leave', '8', '1', '4.5'],
      ['Sick leave', '6', '0', '0'],
      ['Leave without pay (unpaid)', '—', '0', '2'],
    ]);
    expect(within(card).queryByRole('img')).toBeNull();
    fireEvent.click(within(card).getByRole('button', { name: 'Show as chart' }));
    expect(within(card).queryByRole('table')).toBeNull();
    expect(within(card).getAllByRole('img')).toHaveLength(2);
  });

  it('a part shows its value and share on hover; the bar shows every part on focus', async () => {
    session.me = EMPLOYEE;
    grant('leave.read.operational');
    mockRoutes({ ...BASE, [LEAVE_URL]: BALANCES });
    show();
    const card = await cardOf('My leave balances (days)');
    const bar = within(card).getByRole('img', { name: /^Annual leave/ });
    fireEvent.mouseEnter(bar.querySelector('[data-part="taken"]')!);
    expect(tipOf(card)).toBe('4.5 Taken · 33%');
    fireEvent.mouseLeave(bar);
    expect(tipOf(card)).toBeNull();
    act(() => bar.focus());
    expect(tipOf(card)).toContain('4.5 Taken · 33%');
    expect(tipOf(card)).toContain('1 Pending · 7%');
    expect(tipOf(card)).toContain('8 Available · 59%');
    act(() => bar.blur());
    expect(tipOf(card)).toBeNull();
    // A part at zero draws nothing: an unused type is all track.
    const sick = within(card).getByRole('img', { name: /^Sick leave/ });
    expect([...sick.querySelectorAll('[data-part]')].map((p) => p.getAttribute('data-part'))).toEqual(['available']);
  });
});

describe('My attendance this month (attendance.read.operational, own record)', () => {
  it('asks for the dashboard month to the business date and marks each day with its code and words', async () => {
    session.me = EMPLOYEE;
    grant('attendance.read.operational');
    mockRoutes({ ...BASE, '/v1/employees/emp-1/attendance': ATTENDANCE });
    show();
    const card = await cardOf('My attendance this month');
    expect(urls).toContain(ATTENDANCE_URL);
    const grid = within(card).getByRole('grid', { name: 'My attendance in November 2026' });
    expect(within(grid).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(within(grid).getByRole('gridcell', { name: '1 Nov 2026: Weekly off' }).textContent).toBe('1WO');
    expect(within(grid).getByRole('gridcell', { name: '2 Nov 2026: Present, 8h 05m worked, late' }).textContent).toBe('2P');
    const today = within(grid).getByRole('gridcell', { name: '3 Nov 2026: Not yet calculated' });
    expect(today.getAttribute('aria-current')).toBe('date');
    expect(within(grid).getByRole('gridcell', { name: '30 Nov 2026: upcoming' }).textContent).toBe('30');
    // The legend counts the days to today by outcome, each with the code the calendar shows.
    const legend = within(card).getByRole('list', { name: 'Days by status in November 2026' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['PPresent1', 'WOWeekly off1', '–Not yet calculated1']);
    expect(within(card).getByRole('link', { name: 'Open My attendance' }).getAttribute('href')).toBe('/me/attendance');
  });

  it('is one tab stop; the arrow keys, Home and End move between days and the focused day shows its details', async () => {
    session.me = EMPLOYEE;
    grant('attendance.read.operational');
    mockRoutes({ ...BASE, '/v1/employees/emp-1/attendance': ATTENDANCE });
    show();
    const card = await cardOf('My attendance this month');
    const grid = within(card).getByRole('grid');
    const focusable = within(grid)
      .getAllByRole('gridcell')
      .filter((c) => c.getAttribute('tabindex') === '0');
    expect(focusable.map((c) => c.getAttribute('aria-label'))).toEqual(['3 Nov 2026: Not yet calculated']);
    act(() => focusable[0]!.focus());
    expect(tipOf(card)).toBe('Not yet calculated Tue 3 Nov · today');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('2 Nov 2026: Present, 8h 05m worked, late');
    expect(tipOf(card)).toBe('Present Mon 2 Nov · 8h 05m worked · late');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('9 Nov 2026: upcoming');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('1 Nov 2026: Weekly off');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('1 Nov 2026: Weekly off');
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement?.getAttribute('aria-label')).toBe('30 Nov 2026: upcoming');
    // Still one tab stop, now on the day reached.
    expect(
      within(grid)
        .getAllByRole('gridcell')
        .filter((c) => c.getAttribute('tabindex') === '0')
        .map((c) => c.getAttribute('aria-label')),
    ).toEqual(['30 Nov 2026: upcoming']);
  });

  it('the table view lists every day to today with its status and worked time', async () => {
    session.me = EMPLOYEE;
    grant('attendance.read.operational');
    mockRoutes({ ...BASE, '/v1/employees/emp-1/attendance': ATTENDANCE });
    show();
    const card = await cardOf('My attendance this month');
    fireEvent.click(within(card).getByRole('button', { name: 'Show as table' }));
    const table = within(card).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Date', 'Status', 'Worked']);
    expect(rowsOf(table).slice(1)).toEqual([
      ['1 Nov 2026', 'Weekly off', '—'],
      ['2 Nov 2026', 'Present (late)', '8h 05m'],
      ['3 Nov 2026', 'Not yet calculated', '—'],
    ]);
    expect(within(card).queryByRole('grid')).toBeNull();
  });

  it('says so when nothing is calculated for the month yet', async () => {
    session.me = EMPLOYEE;
    grant('attendance.read.operational');
    mockRoutes({ ...BASE, '/v1/employees/emp-1/attendance': { employeeId: 'emp-1', items: [] } });
    show();
    const card = await cardOf('My attendance this month');
    expect(within(card).getByText('No attendance has been calculated for this month yet.')).toBeTruthy();
    expect(within(card).getByRole('grid')).toBeTruthy();
  });
});

describe('My team today (team.list.operational)', () => {
  it('splits the team by today’s attendance and names who is on leave or absent, from the My team list', async () => {
    session.me = { employeeId: 'emp-9', scopeKind: 'TEAM', displayName: 'Synthetic Manager' };
    grant('team.list.operational', 'leave.read.operational', 'attendance.read.operational');
    mockRoutes({ ...BASE, '/v1/my-team': TEAM });
    show();
    const card = await cardOf('My team today');
    expect(urls).toContain(TEAM_URL);
    // A team scope does not reach the manager's own record: no own-record chart, and no request for one.
    expect(urls.some((u) => u.startsWith('/v1/employees/'))).toBe(false);
    expect(screen.queryByRole('heading', { name: 'My leave balances (days)' })).toBeNull();
    expect(within(card).getByText('team members').closest('p')?.textContent).toBe('5 team members');
    expect(within(card).getByRole('img', { name: 'My team today, 5 members: 1 present or on duty, 2 on leave, 1 absent, 1 not yet calculated' })).toBeTruthy();
    const legend = within(card).getByRole('list', { name: 'Team members by attendance today' });
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['Present or on duty1', 'On leave2', 'Absent1', 'Not yet calculated1']);
    const onLeave = within(card).getByText('On leave', { selector: 'dt' }).closest('div')!;
    expect(within(onLeave).getByRole('link', { name: 'Synthetic Member 2' }).getAttribute('href')).toBe('/team/t-2');
    expect(within(onLeave).getByRole('link', { name: 'Synthetic Member 3' })).toBeTruthy();
    expect(onLeave.textContent).toContain('Synthetic Member 3 (half day)');
    const absent = within(card).getByText('Absent', { selector: 'dt' }).closest('div')!;
    expect(within(absent).getByRole('link', { name: 'Synthetic Member 4' }).getAttribute('href')).toBe('/team/t-4');
    // Present members are counted, not listed by name.
    expect(within(card).queryByRole('link', { name: 'Synthetic Member 1' })).toBeNull();
    expect(within(card).getByRole('link', { name: 'Open My team' }).getAttribute('href')).toBe('/team');
  });

  it('the table view gives every group its count and members', async () => {
    session.me = { employeeId: 'emp-9', scopeKind: 'TEAM', displayName: 'Synthetic Manager' };
    grant('team.list.operational');
    mockRoutes({ ...BASE, '/v1/my-team': TEAM });
    show();
    const card = await cardOf('My team today');
    fireEvent.click(within(card).getByRole('button', { name: 'Show as table' }));
    const table = within(card).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Attendance today', 'Team members', 'Who']);
    expect(rowsOf(table).slice(1)).toEqual([
      ['Present or on duty', '1', 'Synthetic Member 1'],
      ['On leave', '2', 'Synthetic Member 2, Synthetic Member 3 (half day)'],
      ['Absent', '1', 'Synthetic Member 4'],
      ['Exception to review', '0', '—'],
      ['Weekly off or holiday', '0', '—'],
      ['Not yet calculated', '1', 'Synthetic Member 5'],
    ]);
  });

  it('says when today is not calculated yet, and reads a team longer than one page whole', async () => {
    session.me = { employeeId: 'emp-9', scopeKind: 'TEAM', displayName: 'Synthetic Manager' };
    grant('team.list.operational');
    const all = Array.from({ length: 120 }, (_, i) => member(i + 1, null));
    mockRoutes({
      ...BASE,
      '/v1/my-team?page=1': { items: all.slice(0, 100), total: 120, page: 1, pageSize: 100 },
      '/v1/my-team?page=2': { items: all.slice(100), total: 120, page: 2, pageSize: 100 },
    });
    show();
    const card = await cardOf('My team today');
    expect(urls.filter((u) => u.startsWith('/v1/my-team'))).toEqual([TEAM_URL, '/v1/my-team?page=2&pageSize=100']);
    expect(within(card).getByText('team members').closest('p')?.textContent).toBe('120 team members');
    expect(within(card).getByText('Today’s attendance is not calculated yet; who is on leave or absent shows here once it is.')).toBeTruthy();
    expect(within(card).queryByText(/Showing the first/)).toBeNull();
  });

  it('a manager with no current members reads so, with no table toggle', async () => {
    session.me = { employeeId: 'emp-9', scopeKind: 'TEAM', displayName: 'Synthetic Manager' };
    grant('team.list.operational');
    mockRoutes({ ...BASE, '/v1/my-team': { items: [], total: 0, page: 1, pageSize: 100 } });
    show();
    const card = await cardOf('My team today');
    expect(within(card).getByText('No current team members.')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Show as table' })).toBeNull();
  });
});

describe('which charts a role sees', () => {
  it('none without the source pages’ permissions: no request is made and the row takes no room', async () => {
    session.me = EMPLOYEE;
    mockRoutes(BASE);
    const { container } = show();
    await screen.findByText('Nothing waiting for you.');
    await settle();
    expect(urls.some((u) => u.startsWith('/v1/employees/') || u.startsWith('/v1/my-team'))).toBe(false);
    expect(container.querySelector('.dash-charts')?.childElementCount).toBe(0);
  });

  it('no own-record chart for a role linked to no employee, or whose scope does not reach the own record', async () => {
    for (const me of [
      { employeeId: null, scopeKind: 'OWN', displayName: 'Synthetic Person' },
      { employeeId: 'emp-1', scopeKind: 'TEAM', displayName: 'Synthetic Person' },
    ]) {
      session.me = me;
      grant('leave.read.operational', 'attendance.read.operational');
      mockRoutes({ ...BASE, [LEAVE_URL]: BALANCES, '/v1/employees/emp-1/attendance': ATTENDANCE });
      show();
      await screen.findByText('Nothing waiting for you.');
      await settle();
      expect(urls.some((u) => u.startsWith('/v1/employees/'))).toBe(false);
      expect(screen.queryByRole('heading', { name: 'My leave balances (days)' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'My attendance this month' })).toBeNull();
      cleanup();
    }
  });

  it('a company scope linked to an employee reaches the own record, as the own quick actions do', async () => {
    session.me = { employeeId: 'emp-1', scopeKind: 'COMPANY', displayName: 'Synthetic Person' };
    grant('leave.read.operational', 'attendance.read.operational');
    mockRoutes({ ...BASE, [LEAVE_URL]: BALANCES, '/v1/employees/emp-1/attendance': ATTENDANCE });
    show();
    expect(await screen.findByRole('heading', { name: 'My leave balances (days)' })).toBeTruthy();
    expect(await screen.findByRole('heading', { name: 'My attendance this month' })).toBeTruthy();
    // Charts only: the team panel needs the team list permission.
    expect(screen.queryByRole('heading', { name: 'My team today' })).toBeNull();
  });

  it('a role without a dashboard asks for no chart', async () => {
    session.me = EMPLOYEE;
    grant('leave.read.operational', 'attendance.read.operational', 'team.list.operational');
    mockRoutes({ '/v1/dashboard': { ...DASHBOARD, title: null, state: 'NO_DASHBOARD', widgets: [], shortcuts: [] } });
    show();
    expect(await screen.findByText('No dashboard is available for this role.')).toBeTruthy();
    await settle();
    expect(urls.some((u) => u.startsWith('/v1/employees/') || u.startsWith('/v1/my-team'))).toBe(false);
  });

  it('a refused, missing or failing list leaves its chart out, with no error on Home', async () => {
    session.me = { employeeId: 'emp-1', scopeKind: 'COMPANY', displayName: 'Synthetic Person' };
    grant('leave.read.operational', 'attendance.read.operational', 'team.list.operational');
    mockRoutes({ ...BASE, [LEAVE_URL]: BALANCES, '/v1/employees/emp-1/attendance': ATTENDANCE }, { [LEAVE_URL]: 403, '/v1/employees/emp-1/attendance': 500 });
    show();
    await screen.findByText('Nothing waiting for you.');
    // A refusal is the answer; a server failure is tried once more (as every list), then left out too.
    await waitFor(() => expect(urls.filter((u) => u === ATTENDANCE_URL)).toHaveLength(2), { timeout: 4000 });
    await settle();
    expect(urls.filter((u) => u === LEAVE_URL)).toHaveLength(1);
    expect(urls).toContain(TEAM_URL);
    for (const title of ['My leave balances (days)', 'My attendance this month', 'My team today']) expect(screen.queryByRole('heading', { name: title })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    // The figures are untouched.
    expect(screen.getByText('7')).toBeTruthy();
  });

  it('an employee with no leave types sees no leave chart', async () => {
    session.me = EMPLOYEE;
    grant('leave.read.operational');
    mockRoutes({ ...BASE, [LEAVE_URL]: { employeeId: 'emp-1', items: [] } });
    show();
    await screen.findByText('Nothing waiting for you.');
    await waitFor(() => expect(urls).toContain(LEAVE_URL));
    await settle();
    expect(screen.queryByRole('heading', { name: 'My leave balances (days)' })).toBeNull();
  });
});

describe('accessibility', () => {
  it('gives axe no violations with every chart shown, as charts and as tables', async () => {
    session.me = { employeeId: 'emp-1', scopeKind: 'COMPANY', displayName: 'Synthetic Person' };
    grant('leave.read.operational', 'attendance.read.operational', 'team.list.operational');
    mockRoutes({ ...BASE, [LEAVE_URL]: BALANCES, '/v1/employees/emp-1/attendance': ATTENDANCE, '/v1/my-team': TEAM });
    const { container } = show();
    await cardOf('My leave balances (days)');
    await cardOf('My attendance this month');
    await cardOf('My team today');
    const rules = { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } };
    expect((await axe(container, rules)).violations).toEqual([]);
    for (const button of screen.getAllByRole('button', { name: 'Show as table' })) fireEvent.click(button);
    expect(screen.getAllByRole('table').length).toBeGreaterThanOrEqual(3);
    expect((await axe(container, rules)).violations).toEqual([]);
  });
});

describe('chart helpers', () => {
  it('lists every day of a month, leap years included, and nothing for a value that is not a day', () => {
    expect(monthDays('2026-11-03')).toHaveLength(30);
    expect(monthDays('2026-11-03')[0]).toBe('2026-11-01');
    expect(monthDays('2026-11-03').at(-1)).toBe('2026-11-30');
    expect(monthDays('2026-02-10')).toHaveLength(28);
    expect(monthDays('2028-02-01')).toHaveLength(29);
    expect(monthDays('not a day')).toEqual([]);
  });

  it('writes a share as a whole percent, a sliver as "<1%", and nothing of nothing as 0%', () => {
    expect(share(1, 3)).toBe('33%');
    expect(share(0.001, 100)).toBe('<1%');
    expect(share(0, 10)).toBe('0%');
    expect(share(1, 0)).toBe('0%');
  });
});
