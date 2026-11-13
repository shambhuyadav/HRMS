// Later-period payroll cases (FR-035, FR-100; DB111; H2; H3 TN13; I-79), jsdom: figures are the server's calculation and are never typed
// in, approval of a timesheet adjustment is offered only for a valued case under an active valuation policy (otherwise the reason is said
// in plain words), the arrear register names source revision, period and the payroll that paid it, the valuation policy is drafted by one
// person and activated by another, and an employee sees no figures. Synthetic data only.
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
const CONFIGURED = { status: 'CONFIGURED', message: 'Corrections are calculated from the processed record.' };
const VALUED = { previousRecognizedUnits: '6.0000', correctedUnits: '7.0000', deltaAmount: '967.7400' };
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

  it('shows the calculated figures, or that a case is not valued, and the maker saves or submits only the explanation', async () => {
    serve({
      ...lists([CASE, { ...CASE, id: 'a2', employeeCode: 'SYN-009', createdBy: 'someone-else', ...VALUED, state: 'APPLIED', targetPeriodCode: '2026-10' }], []),
      'PUT /v1/payroll/adjustments/a1': [200, CASE],
      'POST /v1/payroll/adjustments/a1/submit': [200, { ...CASE, state: 'SUBMITTED' }],
    });
    screenOf('/payroll/adjustments', [READ, PROPOSE]);
    const card = await screen.findByLabelText('Adjustment of SYN-001');
    expect(card.textContent).toContain('Not valued: no valuation policy was in effect');
    expect(card.textContent).toContain('8 hours approved');
    const applied = screen.getByLabelText('Adjustment of SYN-009');
    expect(applied.textContent).toContain('Calculated: previously recognised 6.0000, corrected 7.0000, difference INR 967.74');
    expect(applied.textContent).toContain('Paid in payroll 2026-10');
    expect(within(applied).queryByRole('form')).toBeNull();
    const form = within(card).getByRole('form', { name: 'Draft case of SYN-001' });
    expect(within(form).queryByLabelText('Signed difference')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Explanation'), { target: { value: 'Synthetic late week' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')!.body).toEqual({ expectedVersion: 3, explanation: 'Synthetic late week' });
    fireEvent.click(within(form).getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('/submit'))).toBe(true));
    expect(calls.find((c) => c.path.endsWith('/submit'))!.body).toEqual({ expectedVersion: 3 });
  });

  it('offers approval of a valued case under an active policy, and says why a case submitted unvalued goes back', async () => {
    const queue = PAYROLL_ADJUSTMENT_TASK_QUEUES.find((q) => q.title === 'Late-timesheet adjustments')!;
    serve({
      'GET /v1/payroll/adjustments/tasks/mine': [
        200,
        {
          items: [
            { taskId: 'task1', adjustment: { ...CASE, ...VALUED, state: 'SUBMITTED', explanation: 'Synthetic' } },
            { taskId: 'task2', adjustment: { ...CASE, id: 'a2', employeeCode: 'SYN-002', state: 'SUBMITTED', explanation: 'Synthetic' } },
          ],
          valuation: CONFIGURED,
        },
      ],
      'POST /v1/payroll/adjustment-tasks/task1/decision': [200, { state: 'APPROVED' }],
    });
    session.permissions = [DECIDE];
    render(tree(queue.component));
    const valued = await screen.findByRole('form', { name: 'Decide the case of SYN-001' });
    const unvalued = screen.getByRole('form', { name: 'Decide the case of SYN-002' });
    expect(within(unvalued).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(unvalued.textContent).toContain('return it so it is opened again and valued');
    fireEvent.click(within(valued).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ decision: 'APPROVE', idempotencyKey: expect.stringMatching(/^payroll-case-/) });
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
    expect(list.textContent).toContain('7 Sep 2026 to 13 Sep 2026, payroll 2026-09');
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
  const REGISTER_CASE = {
    id: 'c1',
    employeeCode: 'SYN-001',
    employeeName: 'Asha Synthetic',
    sourceRevisionId: 'sa1',
    sourceEffectiveFrom: '2026-03-01',
    periodCode: '2026-03',
    currencyCode: 'INR',
    reason: 'Synthetic',
    state: 'APPLIED',
    lines: [{ componentCode: 'BASIC', amount: '6000.0000' }],
    totalEntered: '6000.0000',
    appliedPeriodCode: '2026-05',
  };
  const ARR_CANDIDATE = { employeeCode: 'SYN-002', employeeName: 'Ravi Synthetic', sourceRevisionId: 'sa2', sourceEffectiveFrom: '2026-03-01', originRecordId: 'r2', periodCode: '2026-03', currencyCode: 'INR' };
  const lists = (items: unknown[] = [REGISTER_CASE], candidates: unknown[] = [ARR_CANDIDATE]) => ({
    'GET /v1/payroll/arrears-cases': [200, { items, total: items.length, calculation: { status: 'CALCULATED', message: 'Amounts are calculated from the processed record and the salary revision.' } }] as Reply,
    'GET /v1/payroll/arrears-cases/candidates': [200, { items: candidates, total: candidates.length }] as Reply,
  });

  it('names source revision, period and the payroll that paid it in the register, and says how amounts come about', async () => {
    serve(lists());
    screenOf('/payroll/arrears', [READ]);
    const table = await screen.findByRole('table', { name: 'Arrear register' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(row.textContent).toContain('1 Mar 2026');
    expect(row.textContent).toContain('2026-03');
    expect(row.textContent).toContain('BASIC INR 6,000.00');
    expect(row.textContent).toContain('2026-05');
    expect(document.body.textContent).toContain('Amounts are calculated from the processed record and the salary revision.');
    expect(screen.queryByRole('button', { name: 'Raise a case' })).toBeNull();
  });

  it('says "Final settlement" for a case a final settlement paid (I-88 follow-up)', async () => {
    serve(lists([{ ...REGISTER_CASE, appliedPeriodCode: null, appliedSettlementId: 's-1' }], []));
    screenOf('/payroll/arrears', [READ]);
    const table = await screen.findByRole('table', { name: 'Arrear register' });
    expect(within(table).getAllByRole('row')[1]!.textContent).toContain('Final settlement');
  });

  it('raises a case with a reason and one idempotency key; the server calculates the amounts', async () => {
    serve({ ...lists([]), 'POST /v1/payroll/arrears-cases': [201, REGISTER_CASE] });
    screenOf('/payroll/arrears', [READ, PROPOSE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Raise a case' }));
    const form = screen.getByRole('form', { name: 'Raise arrears for SYN-002 2026-03' });
    const send = within(form).getByRole('button', { name: 'Raise the case' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(within(form).queryByLabelText(/one component per line/)).toBeNull();
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: 'Retroactive revision' } });
    fireEvent.click(send);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      sourceRevisionId: 'sa2',
      originRecordId: 'r2',
      reason: 'Retroactive revision',
      idempotencyKey: expect.stringMatching(/^arrears-/),
    });
  });

  it('decides with a reason, and says what approval pays and that a processed payroll never changes', async () => {
    const queue = PAYROLL_ADJUSTMENT_TASK_QUEUES.find((q) => q.title === 'Arrears cases')!;
    expect(queue.permission).toBe(DECIDE);
    serve({ 'GET /v1/payroll/arrears-cases/tasks/mine': [200, { items: [{ taskId: 'task2', case: { ...REGISTER_CASE, state: 'SUBMITTED' } }] }], 'POST /v1/payroll/arrears-tasks/task2/decision': [409, { error: 'NOT_CONFIGURED', message: 'A negative arrear is a recovery and needs an activated recovery policy' }] });
    session.permissions = [DECIDE];
    render(tree(queue.component));
    const form = await screen.findByRole('form', { name: 'Decide the arrears of SYN-001' });
    expect(document.body.textContent).toContain('A processed payroll never changes.');
    fireEvent.click(within(form).getByRole('button', { name: 'Approve' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('needs an activated recovery policy');
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ decision: 'APPROVE' });
  });

  it('declares its screens with their keys', () => {
    expect(PAYROLL_ADJUSTMENT_SCREENS.map((s) => [s.path, s.permission])).toEqual([
      ['/payroll/adjustments', 'payroll_adjustment.read.amount'],
      ['/payroll/arrears', 'payroll_arrears.read.amount'],
      ['/payroll/valuation-policies', 'payroll_config.read.operational'],
    ]);
  });
});

describe('valuation policy (I-79)', () => {
  const READ = 'payroll_config.read.operational';
  const MANAGE = 'payroll_config.manage.operational';
  const ACTIVATE = 'payroll_config.activate.operational';
  const POLICY = { id: 'p1', revision: 1, effectiveFrom: '2026-01-01', arrearsComponentCode: 'ARREARS', adjustmentComponentCode: 'LATE_TS', recoveryComponentCode: null, timesheetUnit: 'DAY', hoursPerDay: null, state: 'ACTIVE', createdBy: 'someone', version: 2 };

  it('lists policies, and activates a draft only someone else drafted', async () => {
    serve({
      'GET /v1/payroll/valuation-policies': [
        200,
        {
          items: [
            POLICY,
            { ...POLICY, id: 'p2', revision: 2, effectiveFrom: '2026-03-01', timesheetUnit: 'HOUR', hoursPerDay: '8.00', state: 'DRAFT', createdBy: 'someone', version: 1 },
            { ...POLICY, id: 'p3', revision: 3, effectiveFrom: '2026-04-01', state: 'DRAFT', createdBy: 'maker-user', version: 1 },
          ],
        },
      ],
      'POST /v1/payroll/valuation-policies/p2/activate': [200, { ...POLICY, id: 'p2', state: 'ACTIVE' }],
    });
    screenOf('/payroll/valuation-policies', [READ, ACTIVATE]);
    const table = await screen.findByRole('table', { name: 'Valuation policies' });
    const [, first, second, third] = within(table).getAllByRole('row');
    expect(first!.textContent).toContain('None');
    expect(second!.textContent).toContain('Hour (8.00 a day)');
    expect(within(third!).queryByRole('button', { name: 'Activate' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New valuation policy' })).toBeNull();
    fireEvent.click(within(second!).getByRole('button', { name: 'Activate' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({ path: '/v1/payroll/valuation-policies/p2/activate', body: { expectedVersion: 1 } });
  });

  it('drafts a policy, asking hours a day only for the hour unit', async () => {
    serve({ 'GET /v1/payroll/valuation-policies': [200, { items: [] }], 'POST /v1/payroll/valuation-policies': [201, POLICY] });
    screenOf('/payroll/valuation-policies', [READ, MANAGE]);
    expect(await screen.findByText(/No valuation policy yet/)).toBeTruthy();
    const form = screen.getByRole('form', { name: 'New valuation policy' });
    expect(within(form).queryByLabelText('Hours a day')).toBeNull();
    fireEvent.change(within(form).getByLabelText('Effective from'), { target: { value: '2026-12-01' } });
    fireEvent.change(within(form).getByLabelText('Arrears component code'), { target: { value: 'ARREARS' } });
    fireEvent.change(within(form).getByLabelText('Timesheet adjustment component code'), { target: { value: 'LATE_TS' } });
    fireEvent.change(within(form).getByLabelText('Timesheet unit'), { target: { value: 'HOUR' } });
    const save = within(form).getByRole('button', { name: 'Save as draft' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Hours a day'), { target: { value: '8' } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ effectiveFrom: '2026-12-01', arrearsComponentCode: 'ARREARS', adjustmentComponentCode: 'LATE_TS', timesheetUnit: 'HOUR', hoursPerDay: '8' });
  });
});
