// Employee History screen (jsdom; FR-089; DF14): one dated history with who, why and the decision behind each event, the
// position on a chosen date, and only what the server sent: a role with no salary grant is told so. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPLOYEE_HISTORY_SCREENS, EmployeeHistoryPage, type Timeline, type TimelineEvent } from './employee-history';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

type Reply = [number, unknown];
type Call = { method: string; url: string };
function mockApi(routes: Record<string, Reply>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? 'GET', url };
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
const open = (path: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/employee-history" element={<EmployeeHistoryPage />} />
          <Route path="/employee-history/:id" element={<EmployeeHistoryPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const event = (extra: Partial<TimelineEvent>): TimelineEvent => ({ category: 'JOINING', type: 'JOINED', effectiveDate: '2026-01-31', recordedAt: '2026-01-31T04:00:00Z', actor: 'hr@demo.test', reason: null, source: { kind: 'EMPLOYEE', id: 'e-1' }, details: {}, ...extra });
const ORG_A = { department: 'Engineering', location: 'Head office', designation: 'Analyst', grade: null };
const ORG_B = { department: 'Finance', location: 'Head office', designation: 'Analyst', grade: 'G2' };
const EVENTS: TimelineEvent[] = [
  event({ category: 'EXIT', type: 'EXIT_APPROVED', effectiveDate: '2026-11-01', source: { kind: 'EXIT_CASE', id: 'x-1', decisionId: 'd-9' }, details: { status: 'NOTICE', priorStatus: 'ACTIVE_CONFIRMED', lastWorkingDate: '2026-12-01' } }),
  event({ category: 'INCREMENT', type: 'INCREMENT_APPLIED', effectiveDate: '2026-09-01', reason: 'Annual review', source: { kind: 'INCREMENT_CASE', id: 'i-1', decisionId: 'd-8' }, details: { currency: 'INR', beforeAmount: '100000.0000', afterAmount: '110000.0000', changePercent: '10.00', percentNaReason: null } }),
  event({ category: 'ORGANISATION', type: 'ASSIGNMENT_CHANGED', effectiveDate: '2026-07-01', reason: 'Reorganisation', source: { kind: 'AUDIT_EVENT', id: 'a-1' }, details: { from: ORG_A, to: ORG_B } }),
  event({ category: 'MANAGER', type: 'MANAGER_REMOVED', effectiveDate: '2026-06-15', reason: 'Top of the line', source: { kind: 'AUDIT_EVENT', id: 'a-2' }, details: { from: { code: 'M1', name: 'Mira Synthetic' }, to: null } }),
  event({ category: 'CONFIRMATION', type: 'EXTENDED', effectiveDate: '2026-04-30', source: { kind: 'CONFIRMATION_CASE', id: 'c-1', decisionId: 'd-7' }, details: { priorDueDate: '2026-04-30', newDueDate: '2026-05-30' } }),
  event({ category: 'MASTER', type: 'MASTER_UPDATED', effectiveDate: '2026-03-01', source: { kind: 'AUDIT_EVENT', id: 'a-3' }, details: { fields: ['dateOfBirth'] } }),
  event({ category: 'STATUS', type: 'DIRECT', effectiveDate: '2026-02-01', actor: null, source: null, details: { status: 'ACTIVE_PROBATION', priorStatus: 'DRAFT' } }),
  event({}),
];
const TIMELINE: Timeline = { employeeId: 'e-1', employeeCode: 'E1', employeeName: 'Asha Synthetic', salaryShown: true, events: EVENTS };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('employee history', () => {
  it('is a menu screen with a linkable employee route, under the history duty', () => {
    expect(EMPLOYEE_HISTORY_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/employee-history', 'employee.read_history.operational', true],
      ['/employee-history/:id', 'employee.read_history.operational', false],
    ]);
  });

  it('finds an employee first, then opens their history', async () => {
    session.permissions = ['employee.list.operational'];
    const calls = mockApi({ 'GET /v1/employees?': [200, { items: [{ id: 'e-1', employeeCode: 'E1', displayName: 'Asha Synthetic' }], total: 1 }], 'GET /v1/employees/e-1/timeline': [200, TIMELINE] });
    open('/employee-history');
    expect(calls.some((c) => c.url.includes('/timeline'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Find the employee'), { target: { value: 'asha' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Asha Synthetic (E1)' }));
    expect(await screen.findByRole('table', { name: 'Employee history' })).toBeTruthy();
    expect(calls.some((c) => c.url === '/v1/employees/e-1/timeline')).toBe(true);
  });

  it('says plainly when the role cannot search', () => {
    mockApi({});
    open('/employee-history');
    expect(screen.getByText('The selected role cannot search employees; open a history from a link instead.')).toBeTruthy();
    expect(screen.queryByLabelText('Find the employee')).toBeNull();
  });

  it('shows each event with its date, details, actor, reason and source', async () => {
    mockApi({ 'GET /v1/employees/e-1/timeline': [200, TIMELINE] });
    open('/employee-history/e-1');
    const table = await screen.findByRole('table', { name: 'Employee history' });
    const row = (name: string) => within(table).getByRole('cell', { name }).closest('tr')!;
    expect(screen.getByRole('heading', { name: 'Asha Synthetic (E1)' })).toBeTruthy();
    expect(row('Assignment changed').textContent).toContain('Engineering, Head office, Analyst to Finance, Head office, Analyst, G2');
    expect(row('Assignment changed').textContent).toContain('Reorganisation');
    expect(row('Assignment changed').textContent).toContain('Audit record');
    expect(row('Increment applied').textContent).toContain('100000.0000 to 110000.0000 INR, 10.00%');
    expect(row('Probation extended').textContent).toContain('Due date moved from');
    expect(row('Manager removed').textContent).toContain('Was Mira Synthetic (M1)');
    expect(row('Manager removed').textContent).toContain('Top of the line');
    expect(row('Employee record changed').textContent).toContain('Changed: dateOfBirth');
    expect(row('Status changed').textContent).toContain('System');
    expect(row('Exit approved').textContent).toContain('Last working date');
  });

  it('shows a corrected increment as a further event beside the one it replaced', async () => {
    const details = { currency: 'INR', beforeAmount: '100000.0000', percentNaReason: null };
    mockApi({
      'GET /v1/employees/e-1/timeline': [
        200,
        {
          ...TIMELINE,
          events: [
            event({ category: 'INCREMENT', type: 'INCREMENT_CORRECTED', source: { kind: 'INCREMENT_CASE', id: 'i-2' }, details: { ...details, afterAmount: '105000.0000', changePercent: '5.00', correctsCaseId: 'i-1', supersededByCaseId: null } }),
            event({ category: 'INCREMENT', type: 'INCREMENT_APPLIED', source: { kind: 'INCREMENT_CASE', id: 'i-1' }, details: { ...details, afterAmount: '110000.0000', changePercent: '10.00', correctsCaseId: null, supersededByCaseId: 'i-2' } }),
          ],
        },
      ],
    });
    open('/employee-history/e-1');
    const table = await screen.findByRole('table', { name: 'Employee history' });
    expect(within(table).getByRole('cell', { name: 'Increment corrected' }).closest('tr')!.textContent).toContain('100000.0000 to 105000.0000 INR, 5.00%');
    expect(within(table).getByRole('cell', { name: 'Increment applied' }).closest('tr')!.textContent).toContain('10.00% (replaced by a correction)');
  });

  it('links a source decision only where the role can open it', async () => {
    session.permissions = ['exit.read.operational'];
    mockApi({ 'GET /v1/employees/e-1/timeline': [200, TIMELINE] });
    open('/employee-history/e-1');
    const table = await screen.findByRole('table', { name: 'Employee history' });
    expect(within(table).getByRole('link', { name: 'Exit case' }).getAttribute('href')).toBe('/lifecycle/exits/x-1');
    expect(within(table).queryByRole('link', { name: 'Confirmation case' })).toBeNull();
    expect(within(table).getByText('Confirmation case')).toBeTruthy();
  });

  it('filters by category and offers only the categories present', async () => {
    mockApi({ 'GET /v1/employees/e-1/timeline': [200, TIMELINE] });
    open('/employee-history/e-1');
    const table = await screen.findByRole('table', { name: 'Employee history' });
    const select = screen.getByLabelText('Category') as HTMLSelectElement;
    expect(within(select).queryByRole('option', { name: 'Salary' })).toBeNull();
    fireEvent.change(select, { target: { value: 'MANAGER' } });
    expect(within(table).getAllByRole('row')).toHaveLength(2);
    expect(within(table).getByText('Manager removed')).toBeTruthy();
  });

  it('says salary is withheld for a role without the grant, rather than implying there were no changes', async () => {
    mockApi({ 'GET /v1/employees/e-1/timeline': [200, { ...TIMELINE, salaryShown: false, events: [event({})] }] });
    open('/employee-history/e-1');
    expect(await screen.findByText('Salary and increment events are not shown: the selected role has no salary history grant.')).toBeTruthy();
    expect(screen.queryByText(/INR/)).toBeNull();
  });

  it('reconstructs a chosen date, with salary only when it is sent', async () => {
    const asOf = { date: '2026-03-01', status: 'ACTIVE_PROBATION', assignment: ORG_A, manager: { code: 'M1', name: 'Mira Synthetic' }, salary: { annualCtc: '1200000.0000', monthlyGross: '100000.0000', currency: 'INR' } };
    const calls = mockApi({ 'GET /v1/employees/e-1/timeline?asOf=': [200, { ...TIMELINE, asOf }], 'GET /v1/employees/e-1/timeline': [200, TIMELINE] });
    open('/employee-history/e-1');
    const form = await screen.findByRole('form', { name: 'On a chosen date' });
    fireEvent.change(within(form).getByLabelText('Date'), { target: { value: '2026-03-01' } });
    fireEvent.submit(form);
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/employees/e-1/timeline?asOf=2026-03-01')).toBe(true));
    await screen.findByText('Engineering, Head office, Analyst');
    expect(screen.getByText('Active probation')).toBeTruthy();
    expect(screen.getByText('Mira Synthetic (M1)')).toBeTruthy();
    expect(screen.getByText('Monthly gross 100000.0000, annual CTC 1200000.0000 INR')).toBeTruthy();
  });

  it('leaves salary out of the chosen date when the server does', async () => {
    const asOf = { date: '2026-03-01', status: 'ACTIVE_PROBATION', assignment: null, manager: null };
    mockApi({ 'GET /v1/employees/e-1/timeline?asOf=': [200, { ...TIMELINE, asOf }], 'GET /v1/employees/e-1/timeline': [200, TIMELINE] });
    open('/employee-history/e-1');
    const form = await screen.findByRole('form', { name: 'On a chosen date' });
    fireEvent.change(within(form).getByLabelText('Date'), { target: { value: '2026-03-01' } });
    fireEvent.submit(form);
    await screen.findByText('Active probation');
    expect(screen.getAllByText('None in force')).toHaveLength(2);
    expect(screen.queryByText('Salary', { selector: 'dt' })).toBeNull();
  });
});
