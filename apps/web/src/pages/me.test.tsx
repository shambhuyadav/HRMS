// Employee portal screens (FR-059; FR-023), jsdom: change requests send only what the employee typed, corrections
// are offered only for presence outcomes and carry the private reason, and nothing is offered without the duty.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MyAttendancePage, MyProfilePage } from './me';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: { accountKey: 'syn.emp', companyName: 'Synthetic Co', roleCode: 'EMPLOYEE', roleName: 'Employee', scopeKind: 'OWN', employeeId: 'emp-1', displayName: 'Synthetic Person' },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

type Call = { url: string; method: string; body: unknown };
function mockApi(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: init?.body ? JSON.parse(init.body as string) : undefined });
      const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
      return new Response(JSON.stringify(key ? routes[key] : { error: 'NOT_FOUND', message: 'Not found' }), { status: key ? 200 : 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const renderPage = (ui: JSX.Element) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('My record (FR-059)', () => {
  const routes = {
    'GET /v1/employees/emp-1/profile-changes': { items: [{ id: 'pc-1', requested: { displayName: 'Old Ask' }, state: 'SUBMITTED', submittedAt: '2026-10-20T05:00:00Z' }] },
    'GET /v1/employees/emp-1/mobile-links': { items: [] },
    'GET /v1/employees/emp-1': { employeeCode: 'SYN-1', displayName: 'Synthetic Person', workEmail: 'syn@example.test', joiningDate: '2026-01-05', status: 'ACTIVE_CONFIRMED', assignment: null },
    'POST /v1/me/profile-changes': { requestId: 'pc-2', state: 'SUBMITTED' },
    'POST /v1/profile-changes/pc-1/withdraw': { state: 'WITHDRAWN' },
  };

  it('sends only the fields the employee filled in, and offers withdrawal of a pending request', async () => {
    session.permissions = ['profile_change.submit.operational', 'profile_change.read.operational'];
    const calls = mockApi(routes);
    renderPage(<MyProfilePage />);
    expect(await screen.findByText('SYN-1')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('New display name'), { target: { value: '  New Name  ' } });
    fireEvent.click(screen.getByText('Send for review'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === '/v1/me/profile-changes')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/me/profile-changes')!.body).toEqual({ displayName: 'New Name' });
    fireEvent.click(await screen.findByText('Withdraw'));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/profile-changes/pc-1/withdraw' && c.method === 'POST')).toBe(true));
  });

  it('DF03: a rejected change can be raised again from what it asked, linked to it, or sent unlinked', async () => {
    session.permissions = ['profile_change.submit.operational', 'profile_change.read.operational'];
    const calls = mockApi({
      ...routes,
      'GET /v1/employees/emp-1/profile-changes': { items: [{ id: 'pc-9', requested: { displayName: 'Rejected Ask' }, state: 'REJECTED', submittedAt: '2026-10-01' }] },
    });
    renderPage(<MyProfilePage />);
    fireEvent.click(await screen.findByText('Raise again'));
    expect((screen.getByLabelText('New display name') as HTMLInputElement).value).toBe('Rejected Ask');
    fireEvent.click(screen.getByText('Send for review'));
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/me/profile-changes')).toHaveLength(1));
    expect(calls.find((c) => c.url === '/v1/me/profile-changes')!.body).toEqual({ displayName: 'Rejected Ask', predecessorRequestId: 'pc-9' });
    // The link is dropped with the form: the next one is unlinked.
    await waitFor(() => expect((screen.getByLabelText('New display name') as HTMLInputElement).value).toBe(''));
    fireEvent.click(await screen.findByText('Raise again'));
    fireEvent.click(screen.getByText('Make it an unlinked request'));
    fireEvent.click(screen.getByText('Send for review'));
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/me/profile-changes')).toHaveLength(2));
    expect(calls.filter((c) => c.url === '/v1/me/profile-changes')[1]!.body).toEqual({ displayName: 'Rejected Ask' });
  });

  it('offers no raising again without the submit duty', async () => {
    session.permissions = ['profile_change.read.operational'];
    mockApi({ ...routes, 'GET /v1/employees/emp-1/profile-changes': { items: [{ id: 'pc-9', requested: { displayName: 'Rejected Ask' }, state: 'REJECTED', submittedAt: '2026-10-01' }] } });
    renderPage(<MyProfilePage />);
    expect(await screen.findByText(/Rejected Ask/)).toBeTruthy();
    expect(screen.queryByText('Raise again')).toBeNull();
  });

  it('offers no change form without the self-service duty', async () => {
    mockApi(routes);
    renderPage(<MyProfilePage />);
    expect(await screen.findByText('SYN-1')).toBeTruthy();
    expect(screen.queryByText('Ask for a change')).toBeNull();
    expect(screen.queryByText('Request link')).toBeNull();
  });
});

describe('My attendance (FR-059, FR-021)', () => {
  const days = {
    items: [
      { id: 'd-1', workDate: '2026-03-02', status: 'ABSENT', workedMinutes: 0, late: false, amended: false },
      { id: 'd-2', workDate: '2026-03-03', status: 'LEAVE', workedMinutes: 0, late: false, amended: false },
      { id: 'd-3', workDate: '2026-03-04', status: 'HALF_DAY', workedMinutes: 240, late: false, amended: false },
    ],
  };

  it('offers corrections only for presence outcomes without a pending request, and sends the private reason', async () => {
    session.permissions = ['attendance.request_correction.operational'];
    const calls = mockApi({
      'GET /v1/employees/emp-1/attendance-corrections': { items: [{ id: 'c-1', workDate: '2026-03-04', currentStatus: 'HALF_DAY', requestedStatus: 'PRESENT', state: 'SUBMITTED' }] },
      'GET /v1/employees/emp-1/attendance': days,
      'POST /v1/me/attendance-corrections': { requestId: 'c-2', state: 'SUBMITTED' },
    });
    renderPage(<MyAttendancePage />);
    expect(await screen.findByText('2026-03-02')).toBeTruthy();
    // ABSENT: offered; LEAVE: never; HALF_DAY with a pending request: waiting.
    expect(screen.getAllByText('Request correction')).toHaveLength(1);
    expect(await screen.findByText('correction waiting for review')).toBeTruthy();
    fireEvent.click(screen.getByText('Request correction'));
    const select = screen.getByLabelText('Correct to') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['PRESENT', 'HALF_DAY']);
    fireEvent.change(screen.getByLabelText('Reason (private)'), { target: { value: 'Badge reader fault' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/me/attendance-corrections')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/me/attendance-corrections')!.body).toEqual({ attendanceRecordId: 'd-1', status: 'PRESENT', reason: 'Badge reader fault' });
  });

  it('DF03: a rejected correction can be raised again, linked to it; the list says what a request follows; nothing is offered once it is followed', async () => {
    session.permissions = ['attendance.request_correction.operational'];
    const rejected = { id: 'ac-1', attendanceRecordId: 'd-1', workDate: '2026-03-02', currentStatus: 'ABSENT', requestedStatus: 'HALF_DAY', state: 'REJECTED' };
    const calls = mockApi({
      'GET /v1/employees/emp-1/attendance-corrections': { items: [rejected, { ...rejected, id: 'ac-2', workDate: '2026-03-04', state: 'REJECTED' }, { ...rejected, id: 'ac-3', workDate: '2026-03-04', state: 'SUBMITTED', predecessorRequestId: 'ac-2' }] },
      'GET /v1/employees/emp-1/attendance': days,
      'POST /v1/me/attendance-corrections': { requestId: 'ac-4', state: 'SUBMITTED' },
    });
    renderPage(<MyAttendancePage />);
    const offers = await screen.findAllByText('Raise again');
    expect(offers).toHaveLength(1); // ac-1 only: ac-2 is already followed, ac-3 is not rejected
    expect(screen.getAllByText('Raised again after a rejected request')).toHaveLength(1);
    fireEvent.click(offers[0]!);
    expect(await screen.findByRole('status')).toBeTruthy();
    expect((screen.getByLabelText('Correct to') as HTMLSelectElement).value).toBe('HALF_DAY');
    fireEvent.change(screen.getByLabelText('Reason (private)'), { target: { value: 'Synthetic: new evidence' } });
    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/me/attendance-corrections')).toBe(true));
    expect(calls.find((c) => c.url === '/v1/me/attendance-corrections')!.body).toEqual({ attendanceRecordId: 'd-1', status: 'HALF_DAY', reason: 'Synthetic: new evidence', predecessorRequestId: 'ac-1' });
  });

  it('offers no correction without the duty', async () => {
    mockApi({ 'GET /v1/employees/emp-1/attendance-corrections': { items: [] }, 'GET /v1/employees/emp-1/attendance': days });
    renderPage(<MyAttendancePage />);
    expect(await screen.findByText('2026-03-02')).toBeTruthy();
    expect(screen.queryByText('Request correction')).toBeNull();
  });
});
