// Attendance dashboard and attendance reports (jsdom; BRD coverage CL-053 and CL-047, CL-049 to CL-051; FR-021, FR-022, FR-056;
// BR-026): the counts per department and in total, whether the date is processed, a count opening the employees behind it
// with the same date and departments, and each report sending exactly the filters it takes. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATTENDANCE_CONTROL_SCREENS } from './attendance-control';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

type Reply = [number, unknown];
type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
function mockApi(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const key = Object.keys(routes)
        .filter((k) => `${call.method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const [status, body]: Reply = key === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : routes[key]!;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const screenOf = (path: string) => ATTENDANCE_CONTROL_SCREENS.find((s) => s.path === path)!;
const open = (path: string) => {
  const Page = screenOf(path).component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const CATEGORIES = ['PRESENT', 'ABSENT', 'ON_LEAVE', 'OUTDOOR_OR_HOLIDAY_WORK', 'OFF_DAY', 'NEEDS_REVIEW', 'PUNCHED', 'NOT_PUNCHED'];
const counts = (over: Record<string, number>) => ({ ...Object.fromEntries([...CATEGORIES, 'LATE'].map((c) => [c, 0])), ...over });
const dept = (id: string, code: string, total: number, over: Record<string, number>) => ({ departmentId: id, departmentCode: code, departmentName: `${code} department`, total, counts: counts(over) });
const PROCESSED = {
  date: '2026-03-05',
  processing: { state: 'PROCESSED', employees: 7, processed: 7 },
  categories: CATEGORIES,
  departments: [dept('d-abs', 'ABS', 4, { ABSENT: 2, ON_LEAVE: 2 }), dept('d-eng', 'ENG', 3, { PRESENT: 2, LATE: 1, NEEDS_REVIEW: 1 })],
  total: { departmentId: null, departmentCode: null, departmentName: null, total: 7, counts: counts({ PRESENT: 2, LATE: 1, ABSENT: 2, ON_LEAVE: 2, NEEDS_REVIEW: 1 }) },
};
const NOT_PROCESSED = {
  ...PROCESSED,
  date: '2026-03-09',
  processing: { state: 'NOT_PROCESSED', employees: 9, processed: 0 },
  departments: [dept('d-eng', 'ENG', 9, { PUNCHED: 2, NOT_PUNCHED: 6, ON_LEAVE: 1 })],
  total: { departmentId: null, departmentCode: null, departmentName: null, total: 9, counts: counts({ PUNCHED: 2, NOT_PUNCHED: 6, ON_LEAVE: 1 }) },
};
const ROW = {
  employeeId: 'e-1',
  employeeCode: 'SYN1',
  employeeName: 'Synthetic One',
  departmentCode: 'ABS',
  shiftCode: 'DAY',
  category: 'ABSENT',
  processedStatus: 'ABSENT',
  processed: true,
  late: false,
  lateMinutes: 0,
  punchCount: 0,
  firstPunch: null,
  lastPunch: null,
  punchSourceUnavailable: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('attendance dashboard (CL-053)', () => {
  it('CL-053 FR-021: is a menu screen for the roles that review attendance, and shows the counts per department and in total', async () => {
    expect(screenOf('/attendance/dashboard')).toMatchObject({ title: 'Attendance dashboard', nav: true, permission: 'attendance.approve_correction.operational' });
    mockApi({ 'GET /v1/attendance/dashboard': [200, PROCESSED] });
    open('/attendance/dashboard');
    const table = await screen.findByRole('table', { name: 'Attendance by department' });
    const rows = within(table).getAllByRole('row');
    expect(within(rows[0]!).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Department',
      'Employees',
      'Present',
      'Absent',
      'On leave',
      'Outdoor duty or holiday work',
      'Weekly off or holiday',
      'Exception to review',
      'Punched, not yet processed',
      'Not punched yet',
      'Late',
    ]);
    // The department by name; a count shows its number, with what it counts for a screen reader only.
    expect(within(rows[1]!).getAllByRole('cell')[0]!.textContent).toBe('ABS department');
    const absent = within(rows[1]!).getByRole('button', { name: '2 Absent in ABS department' });
    expect(absent.querySelector('.sr-only')!.textContent).toBe(' Absent in ABS department');
    expect(within(rows[3]!).getByText('Total')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Processed for all 7 employees');
    // The date shown is the day the counts are for, without choosing one.
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-03-05');
  });

  it('FR-022: a date not processed yet says so; a count opens its employees with the same date, departments and department row', async () => {
    session.permissions = ['org_master.read.operational'];
    const calls = mockApi({
      'GET /v1/attendance/dashboard': [200, NOT_PROCESSED],
      'GET /v1/org/departments': [200, { items: [{ id: 'd-eng', code: 'ENG' }, { id: 'd-abs', code: 'ABS' }] }],
      'GET /v1/attendance/dashboard/employees': [200, { items: [{ ...ROW, category: 'NOT_PUNCHED', processed: false, processedStatus: null, punchSourceUnavailable: true }], total: 1, page: 1 }],
    });
    open('/attendance/dashboard');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-03-09' } });
    const select = (await screen.findByLabelText('Departments')) as HTMLSelectElement;
    for (const o of [...select.options]) o.selected = true;
    fireEvent.change(select);
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/attendance/dashboard?date=2026-03-09&departmentId=d-eng&departmentId=d-abs')).toBe(true));
    expect((await screen.findByRole('status')).textContent).toMatch(/has not been processed yet, so the counts show what is known/);
    fireEvent.click(screen.getAllByRole('button', { name: /^6 Not punched yet in ENG/ })[0]!);
    await waitFor(() =>
      expect(calls.some((c) => c.url.startsWith('/v1/attendance/dashboard/employees?date=2026-03-09&list=NOT_PUNCHED&departmentId=d-eng&departmentId=d-abs&inDepartment=d-eng&page=1'))).toBe(true),
    );
    const list = await screen.findByRole('table', { name: 'Employees in this count' });
    expect(within(list).getByText('SYN1')).toBeTruthy();
    expect(within(list).getByText('not processed')).toBeTruthy();
    expect(within(list).getByText('punch source failed')).toBeTruthy();
    // The total row's count opens the whole selection.
    fireEvent.click(screen.getByRole('button', { name: /^1 On leave$/ }));
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/v1/attendance/dashboard/employees?date=2026-03-09&list=ON_LEAVE&departmentId=d-eng&departmentId=d-abs&page=1'))).toBe(true));
  });
});

describe('attendance reports (CL-047, CL-049 to CL-051; FR-056)', () => {
  const choosePeriod = () => {
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
  };
  const generate = async (calls: Call[]) => {
    const posts = () => calls.filter((c) => c.method === 'POST' && c.url === '/v1/reports');
    const before = posts().length;
    fireEvent.click(await screen.findByRole('button', { name: /^Generate the / }));
    await waitFor(() => expect(posts().length).toBe(before + 1));
    return posts().at(-1)!.body;
  };

  it('FR-056: the shift punch register sends its view, its punch source and the XLSX format', async () => {
    session.permissions = ['attendance.export.operational'];
    expect(screenOf('/attendance/reports')).toMatchObject({ nav: true, permission: 'attendance.export.operational' });
    const calls = mockApi({ 'POST /v1/reports': [202, { id: 'x-1', state: 'QUEUED' }], 'GET /v1/reports/x-1': [200, { state: 'QUEUED', rowCount: null, failureCode: null }] });
    open('/attendance/reports');
    expect((screen.getByRole('button', { name: /^Generate the / }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose a period (From and To) to generate the report.')).toBeTruthy();
    choosePeriod();
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'FIRST_LAST' } });
    fireEvent.change(screen.getByLabelText('Punch source'), { target: { value: 'TERMINAL' } });
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'XLSX' } });
    expect(await generate(calls)).toEqual({ reportCode: 'SHIFT_PUNCH_REGISTER', filters: { from: '2026-03-01', to: '2026-03-31', punchView: 'FIRST_LAST', punchSource: 'TERMINAL' }, format: 'XLSX' });
  });

  it('FR-021: the deviation register’s "late by at least" is the minute comparison; the absconding report needs its run length', async () => {
    session.permissions = ['attendance.export.operational'];
    const calls = mockApi({ 'POST /v1/reports': [202, { id: 'x-2', state: 'QUEUED' }], 'GET /v1/reports/x-2': [200, { state: 'QUEUED', rowCount: null, failureCode: null }] });
    open('/attendance/reports');
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'SHIFT_DEVIATION_REGISTER' } });
    choosePeriod();
    fireEvent.change(screen.getByLabelText('Deviation'), { target: { value: 'LATE' } });
    fireEvent.change(screen.getByLabelText('At least (minutes)'), { target: { value: '15' } });
    expect(await generate(calls)).toEqual({ reportCode: 'SHIFT_DEVIATION_REGISTER', filters: { from: '2026-03-01', to: '2026-03-31', minuteField: 'LATE', minuteOp: 'GTE', minuteValue: 15 } });

    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'ABSCONDING_REPORT' } });
    // The button stays in view, not offered until the run length is filled in, and the page says what is missing.
    expect((screen.getByRole('button', { name: /^Generate the / }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Choose a period and the number of consecutive absent days.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Consecutive absent days, at least'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'fromDate' } });
    expect(await generate(calls)).toEqual({ reportCode: 'ABSCONDING_REPORT', filters: { from: '2026-03-01', to: '2026-03-31', minimumDays: 3, sort: 'fromDate' } });
  });

  it('CL-047 CL-049 FR-056: the punch register one row per punch and the plan register as a month grid, with the same filters; one row per day stays the default', async () => {
    session.permissions = ['attendance.export.operational'];
    const calls = mockApi({ 'POST /v1/reports': [202, { id: 'x-3', state: 'QUEUED' }], 'GET /v1/reports/x-3': [200, { state: 'QUEUED', rowCount: null, failureCode: null }] });
    open('/attendance/reports');
    choosePeriod();
    const layout = () => screen.getByLabelText('Layout') as HTMLSelectElement;
    expect(layout().value).toBe('DAY');
    expect([...layout().options].map((o) => o.textContent)).toEqual(['One row per employee and day', 'One row per punch']);
    fireEvent.change(layout(), { target: { value: 'OTHER' } });
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'PUNCHED' } });
    fireEvent.change(screen.getByLabelText('Punch source'), { target: { value: 'IMPORT' } });
    expect(screen.getByRole('button', { name: 'Generate the shift punch register, one row per punch' })).toBeTruthy();
    expect(await generate(calls)).toEqual({ reportCode: 'SHIFT_PUNCH_REGISTER_PUNCHES', filters: { from: '2026-03-01', to: '2026-03-31', punchView: 'PUNCHED', punchSource: 'IMPORT' } });

    // Another register starts again from one row per day.
    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'SHIFT_PLAN_REGISTER' } });
    expect(layout().value).toBe('DAY');
    expect(await generate(calls)).toEqual({ reportCode: 'SHIFT_PLAN_REGISTER', filters: { from: '2026-03-01', to: '2026-03-31' } });
    fireEvent.change(layout(), { target: { value: 'OTHER' } });
    expect(screen.getByText(/W a weekly off, H a holiday, "No shift" when none is assigned/)).toBeTruthy();
    expect(await generate(calls)).toEqual({ reportCode: 'SHIFT_PLAN_MONTH_GRID', filters: { from: '2026-03-01', to: '2026-03-31' } });

    fireEvent.change(screen.getByLabelText('Report'), { target: { value: 'SHIFT_DEVIATION_REGISTER' } });
    expect(screen.queryByLabelText('Layout')).toBeNull();
  });
});
