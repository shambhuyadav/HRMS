// Later-period payroll cases (FR-035, FR-100; DB111; H2; H3 TN13), jsdom: approval of a timesheet adjustment is not offered while no
// valuation policy exists and the reason is said in plain words, figures are entered and shown as they are, the arrear register names
// source revision and period, and an employee sees no figures. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OwnLaterAdjustments, PAYROLL_ADJUSTMENT_SCREENS, PAYROLL_ADJUSTMENT_TASK_QUEUES } from './payroll-adjustments';

const session = vi.hoisted(() => ({ permissions: [] as string[], userId: 'maker-user' }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c1', assignmentId: 'a1' },
    me: { userId: session.userId, scopeKind: 'COMPANY', employeeId: null, roleCode: 'HR_ADMINISTRATOR' },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];
function serve(routes: Record<string, Reply>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : null });
      const reply = routes[`${method} ${url.pathname}`] ?? ([404, { error: 'NOT_FOUND', message: `No mock for ${method} ${url.pathname}` }] as Reply);
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}
const tree = (Component: React.ComponentType) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter>
      <Component />
    </MemoryRouter>
  </QueryClientProvider>
);
const screenOf = (path: string, permissions: string[]) => {
  session.permissions = permissions;
  return render(tree(PAYROLL_ADJUSTMENT_SCREENS.find((s) => s.path === path)!.component));
};

const VALUATION = { status: 'NOT_CONFIGURED', message: 'Approval, valuation and application to a later payroll wait for an activated adjustment valuation policy.' };
const CASE = {
  id: 'a1',
  employeeCode: 'SYN-001',
  employeeName: 'Asha Synthetic',
  adjustmentKind: 'LATE_TIMESHEET',
  sourceRevision: 1,
  serviceStart: '2026-09-07',
  serviceEnd: '2026-09-13',
  sourceMinutes: 480,
  originPeriodCode: '2026-09',
  originRunRevision: 1,
  originPaidUnits: '30.0000',
  previousRecognizedUnits: null,
  correctedUnits: null,
  deltaAmount: null,
  currencyCode: 'INR',
  explanation: null,
  state: 'DRAFT',
  version: 3,
  createdBy: 'maker-user',
};
const CANDIDATE = { timesheetId: 't1', revision: 1, serviceStart: '2026-09-07', serviceEnd: '2026-09-13', employeeCode: 'SYN-002', employeeName: 'Ravi Synthetic', originRecordId: 'r1', originPeriodCode: '2026-09', adjustmentKind: 'AMENDED_TIMESHEET' };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('late-timesheet adjustments (FR-100)', () => {
  const READ = 'payroll_adjustment.read.amount';
  const PROPOSE = 'payroll_adjustment.propose.amount';
  const DECIDE = 'payroll_adjustment.decide.amount';
  const lists = (items: unknown[] = [CASE], candidates: unknown[] = [CANDIDATE]) => ({
    'GET /v1/payroll/adjustments': [200, { items, total: items.length, valuation: VALUATION }] as Reply,
    'GET /v1/payroll/adjustments/candidates': [200, { items: candidates, total: candidates.length }] as Reply,
  });

  it('says what waits on the valuation policy, and opens a case from a candidate with its source and origin', async () => {
    serve({ ...lists([]), 'POST /v1/payroll/adjustments': [201, CASE] });
    screenOf('/payroll/adjustments', [READ, PROPOSE]);
    expect((await screen.findByRole('status')).textContent).toContain('adjustment valuation policy');
    fireEvent.click(await screen.findByRole('button', { name: 'Open a case' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ timesheetId: 't1', revision: 1, originRecordId: 'r1' });
  });

  it('offers no opening without the propose key', async () => {
    serve(lists([]));
    screenOf('/payroll/adjustments', [READ]);
    await screen.findByRole('list', { name: 'Timesheets to raise' });
    expect(screen.queryByRole('button', { name: 'Open a case' })).toBeNull();
  });

  it('shows pending figures as pending, and only the maker edits or submits a draft', async () => {
    serve({
      ...lists([CASE, { ...CASE, id: 'a2', employeeCode: 'SYN-009', createdBy: 'someone-else' }], []),
      'PUT /v1/payroll/adjustments/a1': [200, CASE],
      'POST /v1/payroll/adjustments/a1/submit': [200, { ...CASE, state: 'SUBMITTED' }],
    });
    screenOf('/payroll/adjustments', [READ, PROPOSE]);
    const card = await screen.findByLabelText('Adjustment of SYN-001');
    expect(card.textContent).toContain('previously recognised pending, corrected pending, difference pending');
    expect(card.textContent).toContain('8 hours approved');
    expect(within(screen.getByLabelText('Adjustment of SYN-009')).queryByRole('form')).toBeNull();
    const form = within(card).getByRole('form', { name: 'Draft case of SYN-001' });
    fireEvent.change(within(form).getByLabelText('Signed difference'), { target: { value: '-250.50' } });
    fireEvent.change(within(form).getByLabelText('Explanation'), { target: { value: 'Synthetic late week' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ expectedVersion: 3, previousRecognizedUnits: null, correctedUnits: null, deltaAmount: '-250.50', explanation: 'Synthetic late week' });
    fireEvent.click(within(form).getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/submit'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/submit'))!.body).toEqual({ expectedVersion: 3 });
  });

  it('offers return and reject but no approval while no valuation policy exists (H2)', async () => {
    const queue = PAYROLL_ADJUSTMENT_TASK_QUEUES.find((q) => q.title === 'Late-timesheet adjustments')!;
    expect(queue.permission).toBe(DECIDE);
    serve({ 'GET /v1/payroll/adjustments/tasks/mine': [200, { items: [{ taskId: 'task1', adjustment: { ...CASE, state: 'SUBMITTED', explanation: 'Synthetic' } }], valuation: VALUATION }], 'POST /v1/payroll/adjustment-tasks/task1/decision': [200, { state: 'RETURNED' }] });
    session.permissions = [DECIDE];
    render(tree(queue.component));
    const form = await screen.findByRole('form', { name: 'Decide the case of SYN-001' });
    expect(within(form).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(document.body.textContent).toContain('adjustment valuation policy');
    fireEvent.change(within(form).getByLabelText(/Reason/), { target: { value: 'Check the week' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Return' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ decision: 'RETURN', reason: 'Check the week', idempotencyKey: expect.stringMatching(/^payroll-case-/) });
  });
});

describe('TN13 own later-payroll adjustments', () => {
  it('lists week, period and state only', async () => {
    serve({ 'GET /v1/me/payroll-adjustments': [200, { items: [{ id: 'a1', serviceStart: '2026-09-07', serviceEnd: '2026-09-13', originPeriodCode: '2026-09', adjustmentKind: 'LATE_TIMESHEET', state: 'SUBMITTED' }], notice: 'These corrections are recorded and held.' }] });
    render(tree(OwnLaterAdjustments));
    const list = await screen.findByRole('list', { name: 'My later-payroll adjustments' });
    expect(list.textContent).toContain('2026-09-07 to 2026-09-13, payroll 2026-09');
    expect(document.body.textContent).toContain('These corrections are recorded and held.');
  });

  it('says when there are none', async () => {
    serve({ 'GET /v1/me/payroll-adjustments': [200, { items: [], notice: 'x' }] });
    render(tree(OwnLaterAdjustments));
    expect(await screen.findByText('None of your timesheets has a later-payroll adjustment.')).toBeTruthy();
  });
});

describe('arrears (FR-035)', () => {
  const READ = 'payroll_arrears.read.amount';
  const PROPOSE = 'payroll_arrears.propose.amount';
  const DECIDE = 'payroll_arrears.decide.amount';
  const REGISTER_CASE = { id: 'c1', employeeCode: 'SYN-001', employeeName: 'Asha Synthetic', sourceRevisionId: 'sa1', sourceEffectiveFrom: '2026-03-01', periodCode: '2026-03', currencyCode: 'INR', reason: 'Synthetic', state: 'APPROVED', lines: [{ componentCode: 'BASIC', amount: '6000.0000' }], totalEntered: '6000.0000' };
  const ARR_CANDIDATE = { employeeCode: 'SYN-002', employeeName: 'Ravi Synthetic', sourceRevisionId: 'sa2', sourceEffectiveFrom: '2026-03-01', originRecordId: 'r2', periodCode: '2026-03', currencyCode: 'INR' };
  const lists = (items: unknown[] = [REGISTER_CASE], candidates: unknown[] = [ARR_CANDIDATE]) => ({
    'GET /v1/payroll/arrears-cases': [200, { items, total: items.length, calculation: { status: 'NOT_CONFIGURED', message: 'Arrears are not calculated or paid here.' } }] as Reply,
    'GET /v1/payroll/arrears-cases/candidates': [200, { items: candidates, total: candidates.length }] as Reply,
  });

  it('names source revision and period in the register, and says nothing is paid', async () => {
    serve(lists());
    screenOf('/payroll/arrears', [READ]);
    const table = await screen.findByRole('table', { name: 'Arrear register' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(row.textContent).toContain('2026-03-01');
    expect(row.textContent).toContain('2026-03');
    expect(row.textContent).toContain('BASIC INR 6,000.00');
    expect(document.body.textContent).toContain('Arrears are not calculated or paid here.');
    expect(screen.queryByRole('button', { name: 'Raise a case' })).toBeNull();
  });

  it('raises a case with the amounts as typed and one idempotency key', async () => {
    serve({ ...lists([]), 'POST /v1/payroll/arrears-cases': [201, REGISTER_CASE] });
    screenOf('/payroll/arrears', [READ, PROPOSE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Raise a case' }));
    const form = screen.getByRole('form', { name: 'Raise arrears for SYN-002 2026-03' });
    const send = within(form).getByRole('button', { name: 'Raise the case' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/one component per line/), { target: { value: 'BASIC 5000.00\nHRA -100.50' } });
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Retroactive revision' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({
      sourceRevisionId: 'sa2',
      originRecordId: 'r2',
      reason: 'Retroactive revision',
      lines: [{ componentCode: 'BASIC', amount: '5000.00' }, { componentCode: 'HRA', amount: '-100.50' }],
      idempotencyKey: expect.stringMatching(/^arrears-/),
    });
  });

  it('decides with a reason, and says the decision pays nothing', async () => {
    const queue = PAYROLL_ADJUSTMENT_TASK_QUEUES.find((q) => q.title === 'Arrears cases')!;
    expect(queue.permission).toBe(DECIDE);
    serve({ 'GET /v1/payroll/arrears-cases/tasks/mine': [200, { items: [{ taskId: 'task2', case: { ...REGISTER_CASE, state: 'SUBMITTED' } }] }], 'POST /v1/payroll/arrears-tasks/task2/decision': [409, { error: 'NOT_CONFIGURED', message: 'A negative arrear is a recovery and needs an activated recovery policy' }] });
    session.permissions = [DECIDE];
    render(tree(queue.component));
    const form = await screen.findByRole('form', { name: 'Decide the arrears of SYN-001' });
    expect(document.body.textContent).toContain('Nothing is paid and no payroll changes.');
    fireEvent.click(within(form).getByRole('button', { name: 'Approve' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('needs an activated recovery policy');
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ decision: 'APPROVE' });
  });

  it('declares its screens with their keys', () => {
    expect(PAYROLL_ADJUSTMENT_SCREENS.map((s) => [s.path, s.permission])).toEqual([
      ['/payroll/adjustments', 'payroll_adjustment.read.amount'],
      ['/payroll/arrears', 'payroll_arrears.read.amount'],
    ]);
  });
});
