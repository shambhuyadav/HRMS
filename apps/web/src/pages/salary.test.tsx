// FR-029 salary master screens (jsdom): the list with E08's filters (a day or a month, employee search, status), paged
// with the total; the salary and annual salary exports requested with the same filters; and the SALARY_MASTER_V1 upload
// through the shared batch screens (template download, preview, all-or-nothing commit, the user's own batches). Every
// screen checks its own grant and the server checks every call again. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatDate, localDate } from '../api';
import { SALARY_SCREENS } from './salary';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: { userId: 'u-1', accountKey: 'syn.hr', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR Administrator', scopeKind: 'COMPANY', employeeId: null, displayName: null },
    stored: { token: 't', companies: [], companyId: 'co-1', assignmentId: 'as-1' },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
type Reply = [number, unknown];
type Route = unknown | ((call: Call) => Reply);
/** Routes are "METHOD /path" (the longest matching prefix wins); a function answers [status, body]. */
function mockApi(given: Record<string, Route>) {
  const calls: Call[] = [];
  const routes: Record<string, Route> = { 'GET /v1/salary-master/imports?': { items: [], total: 0, page: 1, pageSize: 25 }, ...given };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const key = Object.keys(routes)
        .filter((k) => `${call.method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const route = key === undefined ? undefined : routes[key];
      const [status, body] = key === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? (route as (c: Call) => Reply)(call) : [200, route];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}

const screenOf = (path: string) => SALARY_SCREENS.find((s) => s.path === path)!.component;
function renderScreen(path: string) {
  const Screen = screenOf(path);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Screen />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

const READ = 'salary.read.salary';
const MANAGE = 'salary.manage.salary';
const EXPORT = 'salary.export.salary';

const row = (over: Record<string, unknown> = {}) => ({
  employeeId: 'emp-1',
  employeeCode: 'SYN-1',
  displayName: 'Synthetic One',
  status: 'ACTIVE_CONFIRMED',
  grade: 'Grade One',
  effectiveFrom: '2026-01-05',
  effectiveTo: null,
  currency: 'INR',
  annualCtc: '1200000.0000',
  monthlyGross: '100000.0000',
  ...over,
});
const page = (items: unknown[], over: Record<string, unknown> = {}) => ({ period: { date: '2026-07-01', from: '2026-07-01', to: '2026-07-01' }, items, total: items.length, page: 1, pageSize: 25, ...over });
const listCalls = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/v1/salary-master?'));

describe('salary master screens', () => {
  it('are registered for the menu under the grants their calls need', () => {
    expect(SALARY_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/salary-master', READ, true],
      ['/salary-master/upload', MANAGE, true],
    ]);
  });

  it('without the salary grants say so and ask the server nothing', () => {
    const calls = mockApi({});
    renderScreen('/salary-master');
    expect(screen.getByText(/cannot view or export salaries/)).toBeTruthy();
    cleanup();
    renderScreen('/salary-master/upload');
    expect(screen.getByText(/cannot upload salaries/)).toBeTruthy();
    expect(screen.queryByLabelText('Salary file')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('salary master list (FR-029, E08)', () => {
  it('shows the server\'s estimated in-hand with its note, and "Not available" where the server makes none (BR-011, I-80)', async () => {
    session.permissions = [READ];
    mockApi({
      'GET /v1/salary-master?': page([row({ estimatedInHand: '39800.00' }), row({ employeeId: 'emp-2', employeeCode: 'SYN-2', estimatedInHand: null })], {
        estimate: { label: 'Estimated in-hand', message: 'An estimate, not a payslip: before income tax and statutory deductions.' },
      }),
    });
    renderScreen('/salary-master');
    const table = await screen.findByRole('table', { name: 'Salary master' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent).at(-1)).toBe('Estimated in-hand (estimate)');
    expect(within(within(table).getByText('SYN-1').closest('tr')!).getByText('INR 39,800.00')).toBeTruthy();
    expect(within(within(table).getByText('SYN-2').closest('tr')!).getByText('Not available')).toBeTruthy();
    expect(document.body.textContent).toContain('Estimated in-hand: An estimate, not a payslip: before income tax and statutory deductions.');
  });

  it('lists the salaries in force today by default, with the total and the E08 grid values; no estimate column unless the server sends one', async () => {
    session.permissions = [READ];
    const calls = mockApi({
      'GET /v1/salary-master?': page([row(), row({ employeeId: 'emp-2', employeeCode: 'SYN-2', displayName: 'Synthetic Two', grade: null, effectiveFrom: '2026-02-01', effectiveTo: '2026-07-15', status: 'NOTICE' })]),
    });
    renderScreen('/salary-master');
    const table = await screen.findByRole('table', { name: 'Salary master' });
    const first = listCalls(calls)[0]!;
    expect(new URL(first.url, 'http://x').searchParams.toString()).toBe(`page=1&pageSize=25&date=${localDate()}`);
    expect(screen.getByText('Salaries on 1 Jul 2026 (2)')).toBeTruthy();
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['Employee', 'Status', 'Grade', 'Effective from', 'Effective to', 'Annual CTC', 'Monthly gross']);
    expect(table.textContent).not.toMatch(/in-hand/i);
    const one = within(table).getByText('SYN-1').closest('tr')!;
    expect(within(one).getByText('INR 12,00,000.00')).toBeTruthy();
    expect(within(one).getByText('INR 1,00,000.00')).toBeTruthy();
    expect(within(one).getByText('No end date')).toBeTruthy();
    expect(within(one).getByText('Active (confirmed)')).toBeTruthy();
    const two = within(table).getByText('SYN-2').closest('tr')!;
    expect(within(two).getByText('15 Jul 2026')).toBeTruthy();
    expect(within(two).getByText('Notice')).toBeTruthy();
    expect(within(two).getByText('—')).toBeTruthy();
    // No export or upload is offered without those grants.
    expect(screen.queryByText(/^Export salaries/)).toBeNull();
  });

  it('sends a month, the employee search and the status as list filters, and pages through the total', async () => {
    session.permissions = [READ];
    const calls = mockApi({
      'GET /v1/salary-master?': (c: Call) => {
        const q = new URL(c.url, 'http://x').searchParams;
        return [200, page([row()], { total: 30, page: Number(q.get('page')), period: q.get('month') ? { month: q.get('month'), from: '2026-07-01', to: '2026-07-31' } : { date: q.get('date'), from: q.get('date'), to: q.get('date') } })];
      },
    });
    renderScreen('/salary-master');
    await screen.findByRole('table', { name: 'Salary master' });
    fireEvent.change(screen.getByLabelText('Effective'), { target: { value: 'month' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-07' } });
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: ' SYN-1 ' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'INACTIVE_SEPARATED' } });
    // Nothing is asked for until the filters are applied.
    expect(listCalls(calls)).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByText('Salaries in 2026-07 (30)')).toBeTruthy();
    expect(new URL(listCalls(calls).at(-1)!.url, 'http://x').searchParams.toString()).toBe('page=1&pageSize=25&month=2026-07&search=SYN-1&status=INACTIVE_SEPARATED');
    expect(screen.getByText('Page 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Page 2 of 2')).toBeTruthy();
    expect(new URL(listCalls(calls).at(-1)!.url, 'http://x').searchParams.get('page')).toBe('2');
  });

  it('a refused list reads as not permitted and shows no figures', async () => {
    session.permissions = [READ];
    mockApi({ 'GET /v1/salary-master?': () => [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    renderScreen('/salary-master');
    expect(await screen.findByText('The selected role cannot view salaries.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'Salary master' })).toBeNull();
  });

  it('a refused past date says the history grant is missing, not that salaries are closed to the role (C4)', async () => {
    session.permissions = [READ];
    mockApi({ 'GET /v1/salary-master?': () => [403, { error: 'HISTORY_GRANT_REQUIRED', message: 'Server text' }] });
    renderScreen('/salary-master');
    expect(await screen.findByText(/Earlier dates and whole months need the salary history grant/)).toBeTruthy();
    expect(screen.queryByText('The selected role cannot view salaries.')).toBeNull();
  });
});

describe('salary and annual salary exports (FR-029, FR-065)', () => {
  it('request the salary export for the applied day or month and the annual export for a financial year, with the same filters', async () => {
    session.permissions = [READ, EXPORT];
    let n = 0;
    const calls = mockApi({
      'GET /v1/salary-master?': page([row()]),
      'POST /v1/reports': () => [202, { id: `rep-${++n}`, state: 'QUEUED' }],
      'GET /v1/reports/rep-1': { reportCode: 'SALARY_MASTER', state: 'COMPLETED', rowCount: 3, failureCode: null },
      'GET /v1/reports/rep-2': { reportCode: 'ANNUAL_SALARY', state: 'FAILED', rowCount: null, failureCode: 'ACCESS_REVOKED' },
    });
    renderScreen('/salary-master');
    await screen.findByRole('table', { name: 'Salary master' });
    fireEvent.change(screen.getByLabelText('Effective'), { target: { value: 'month' } });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-02' } });
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'SYN-1' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ACTIVE_CONFIRMED' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Export salaries for Feb 2026' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ reportCode: 'SALARY_MASTER', filters: { from: '2026-02-01', to: '2026-02-28', search: 'SYN-1', status: 'ACTIVE_CONFIRMED' } });
    const requested = await screen.findByRole('list', { name: 'Requested exports' });
    expect(await within(requested).findByRole('button', { name: 'Download CSV' })).toBeTruthy();
    expect(within(requested).getByText('3 rows', { exact: false })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Financial year starting April'), { target: { value: '2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'Export annual salaries 2026-27' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST')[1]!.body).toEqual({ reportCode: 'ANNUAL_SALARY', filters: { from: '2026-04-01', to: '2027-03-31', search: 'SYN-1', status: 'ACTIVE_CONFIRMED' } });
    expect(await screen.findByText('Your access changed after the request, so nothing was generated.', { exact: false })).toBeTruthy();
    expect(screen.queryByText('ACCESS_REVOKED', { exact: false })).toBeNull();
    fireEvent.change(screen.getByLabelText('Financial year starting April'), { target: { value: '20x6' } });
    expect((screen.getByRole('button', { name: /^Export annual salaries/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('an export-only role can export without viewing; a refused request reads as not permitted', async () => {
    session.permissions = [EXPORT];
    const calls = mockApi({ 'POST /v1/reports': () => [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    renderScreen('/salary-master');
    expect(screen.getByText(/can export salaries but cannot view them/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: `Export salaries on ${formatDate(localDate())}` }));
    expect(await screen.findByText('The selected role cannot export salaries.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ reportCode: 'SALARY_MASTER', filters: { from: localDate(), to: localDate() } });
    expect(listCalls(calls)).toEqual([]);
  });
});

describe('salary master upload (FR-029, DF09)', () => {
  const job = (over: Record<string, unknown>) => ({
    id: 'job-1',
    state: 'PREVIEWED',
    template: 'SALARY_MASTER_V1',
    fileName: 'salaries.csv',
    rowCount: 2,
    acceptedCount: 0,
    rejectedCount: 0,
    rows: [
      { rowNumber: 1, businessKey: 'SYN-1', state: 'VALID', errorCode: null },
      { rowNumber: 2, businessKey: 'SYN-2', state: 'VALID', errorCode: null },
    ],
    ...over,
  });
  const choose = (text: string) => fireEvent.change(screen.getByLabelText('Salary file'), { target: { files: [new File([text], 'salaries.csv', { type: 'text/csv' })] } });

  it('shows the template and its rules, uploads to the salary master import and explains every row problem of a rejected batch', async () => {
    session.permissions = [MANAGE];
    const calls = mockApi({
      'POST /v1/salary-master/imports': () => [
        201,
        job({
          state: 'REJECTED',
          rejectedCount: 2,
          rows: [
            { rowNumber: 1, businessKey: 'SYN-1', state: 'REJECTED', errorCode: 'BATCH_REJECTED' },
            { rowNumber: 2, businessKey: 'SYN-2', state: 'REJECTED', errorCode: 'SALARY_EXISTS' },
          ],
        }),
      ],
    });
    renderScreen('/salary-master/upload');
    expect(screen.getByText('employeeCode,effectiveFrom,annualCtc,monthlyGross,currency')).toBeTruthy();
    expect(screen.getByText('SALARY_MASTER_V1.csv: the header line only, ready to fill in.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Download the template' })).toBeTruthy();
    expect(await screen.findByText('You have not uploaded a file for this import yet.')).toBeTruthy();
    choose('employeeCode,effectiveFrom,annualCtc,monthlyGross,currency\nSYN-1,2026-02-01,1200000,100000,INR');
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(/This batch was rejected, so nothing was applied/)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v1/salary-master/imports');
    expect(post.body).toMatchObject({ fileName: 'salaries.csv' });
    expect(post.body!.idempotencyKey).toMatch(/^salary-master-/);
    expect(atob(post.body!.contentBase64 as string)).toBe('employeeCode,effectiveFrom,annualCtc,monthlyGross,currency\nSYN-1,2026-02-01,1200000,100000,INR');
    const problem = screen.getByText('SYN-2').closest('tr')!;
    expect(within(problem).getByText(/already has a salary on record; a change to it goes through an increment case/)).toBeTruthy();
    expect(within(screen.getByText('SYN-1').closest('tr')!).getByText('not applied (another row failed)')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Record/ })).toBeNull();
  });

  it('commits a previewed batch only on request and reports every row applied', async () => {
    session.permissions = [MANAGE];
    const calls = mockApi({
      'POST /v1/salary-master/imports': () => [201, job({})],
      'POST /v1/salary-master/imports/job-1/commit': job({
        state: 'COMMITTED',
        acceptedCount: 2,
        rows: [
          { rowNumber: 1, businessKey: 'SYN-1', state: 'ACCEPTED', errorCode: null },
          { rowNumber: 2, businessKey: 'SYN-2', state: 'ACCEPTED', errorCode: null },
        ],
      }),
    });
    renderScreen('/salary-master/upload');
    choose('employeeCode,effectiveFrom,annualCtc,monthlyGross,currency\nSYN-1,2026-02-01,1200000,100000,INR');
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(/All 2 rows are valid/)).toBeTruthy();
    expect(calls.filter((c) => c.url.endsWith('/commit'))).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Record 2 initial salaries' }));
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual(['/v1/salary-master/imports', '/v1/salary-master/imports/job-1/commit']);
    // The user's own batches are read again after each change.
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/v1/salary-master/imports?')).length).toBeGreaterThanOrEqual(2));
  });
});
