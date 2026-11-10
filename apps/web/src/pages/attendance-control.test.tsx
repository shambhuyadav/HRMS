// Attendance control (jsdom; FR-021; E07): filters reach the server as chosen, a day shows its source punches beside the
// derived result and why the status changed, an amendment is offered only with the duty and never on a locked day, and
// the export takes the same filters. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const Page = ATTENDANCE_CONTROL_SCREENS[0]!.component;
const open = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
const row = (over: Record<string, unknown> = {}) => ({
  id: 'r-1',
  employeeId: 'e-1',
  employeeCode: 'SYN1',
  employeeName: 'Synthetic One',
  departmentCode: 'ENG',
  locationCode: 'HQ',
  workDate: '2026-03-02',
  status: 'PRESENT',
  workedMinutes: 480,
  scheduledNetMinutes: 480,
  late: true,
  earlyDeparture: false,
  exceptionCode: null,
  amended: false,
  version: 3,
  shiftCode: 'DAY',
  policyCode: 'DEFAULT',
  policyRevision: 2,
  payrollLocked: false,
  ...over,
});
const DAY = {
  derived: { status: 'PRESENT', workedMinutes: 480, scheduledNetMinutes: 480, exceptionCode: null, shiftCode: 'DAY', policyCode: 'DEFAULT', policyRevision: 2 },
  punches: [{ occurredAt: '2026-03-02T03:30:00.000Z', direction: 'IN', sourceKind: 'BIOMETRIC_API' }],
};
const LOG = {
  items: [{ occurredAt: '2026-03-03T03:30:00.000Z', oldStatus: 'ABSENT', newStatus: 'PRESENT', actorUserId: 'u-1' }],
  revisions: [{ occurredAt: '2026-03-02T20:00:00.000Z', cause: 'PROCESSING', status: 'EXCEPTION', workedMinutes: 0, exceptionCode: 'MISSING_OUT_PUNCH', policyCode: 'DEFAULT', policyRevision: 1 }],
};
const choosePeriod = () => {
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-03-01' } });
  fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('attendance control (FR-021, E07)', () => {
  it('asks for nothing before a period, sends the chosen filters, and sends a minute comparison only when whole', async () => {
    const calls = mockApi({ 'GET /v1/attendance/records': [200, { items: [row()], total: 26, page: 1, pageSize: 25 }] });
    open();
    expect(calls.filter((c) => c.url.startsWith('/v1/attendance/records'))).toHaveLength(0);
    choosePeriod();
    expect(await screen.findByText('SYN1 Synthetic One')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('26 days');
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'PRESENT' } });
    fireEvent.change(screen.getByLabelText('Entity (minutes of)'), { target: { value: 'SHORTFALL' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('status=PRESENT'))).toBe(true));
    expect(calls.some((c) => c.url.includes('minuteField'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Compared'), { target: { value: 'GTE' } });
    fireEvent.change(screen.getByLabelText('Number of minutes'), { target: { value: '30' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('minuteField=SHORTFALL') && c.url.includes('minuteOp=GTE') && c.url.includes('minuteValue=30'))).toBe(true));
    fireEvent.click(screen.getByText('Next page'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('page=2'))).toBe(true));
  });

  it('E07 the entity of the minute comparison includes late and overtime-candidate minutes, shown on the row (I-78 item 6)', async () => {
    const calls = mockApi({ 'GET /v1/attendance/records': [200, { items: [row({ lateMinutes: 11, overtimeCandidateMinutes: 45 })], total: 1, page: 1, pageSize: 25 }] });
    open();
    choosePeriod();
    expect(await screen.findByText('late 11 min')).toBeTruthy();
    expect(screen.getByText('overtime candidate 45 min')).toBeTruthy();
    expect(screen.getByText(/Organisation and working organisation: the company you are acting for/)).toBeTruthy();
    const entity = screen.getByLabelText('Entity (minutes of)') as HTMLSelectElement;
    // 0265 (CL-050) added early-departure minutes beside late and overtime-candidate minutes.
    expect([...entity.options].map((o) => o.value)).toEqual(['', 'WORKED', 'SCHEDULED', 'SHORTFALL', 'LATE', 'EARLY_DEPARTURE', 'OVERTIME_CANDIDATE']);
    fireEvent.change(entity, { target: { value: 'OVERTIME_CANDIDATE' } });
    fireEvent.change(screen.getByLabelText('Compared'), { target: { value: 'GTE' } });
    fireEvent.change(screen.getByLabelText('Number of minutes'), { target: { value: '30' } });
    await waitFor(() => expect(calls.some((c) => c.url.includes('minuteField=OVERTIME_CANDIDATE') && c.url.includes('minuteValue=30'))).toBe(true));
  });

  it('opens a day with its source punches, policy revision and why the status changed', async () => {
    mockApi({
      'GET /v1/attendance/records?': [200, { items: [row()], total: 1, page: 1, pageSize: 25 }],
      'GET /v1/attendance/records/r-1/day': [200, DAY],
      'GET /v1/attendance/records/r-1/amendments': [200, LOG],
    });
    open();
    choosePeriod();
    fireEvent.click(await screen.findByText('Open SYN1'));
    expect(await screen.findByText('Biometric device')).toBeTruthy();
    expect(screen.getByText(/Result: Present, 480 of 480 minutes, policy DEFAULT revision 2/)).toBeTruthy();
    expect(await screen.findByText(/amended from Absent to Present/)).toBeTruthy();
    expect(screen.getByText(/reprocessing replaced Exception, 0 minutes, policy DEFAULT revision 1, exception MISSING_OUT_PUNCH/)).toBeTruthy();
    expect(screen.queryByText('Amend')).toBeNull(); // no amendment without the duty
  });

  it('amends with a reason under the version shown, and shows a refusal as the server words it', async () => {
    session.permissions = ['attendance.amend.operational'];
    const calls = mockApi({
      'GET /v1/attendance/records?': [200, { items: [row()], total: 1, page: 1, pageSize: 25 }],
      'GET /v1/attendance/records/r-1/day': [200, DAY],
      'GET /v1/attendance/records/r-1/amendments': [200, { items: [], revisions: [] }],
      'POST /v1/attendance/records/r-1/amend': [422, { error: 'NO_APPROVED_LEAVE', message: 'No approved full-day leave covers this date' }],
    });
    open();
    choosePeriod();
    fireEvent.click(await screen.findByText('Open SYN1'));
    expect(await screen.findByText('The result has not changed since it was first evaluated.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Amend to'), { target: { value: 'LEAVE' } });
    fireEvent.change(screen.getByLabelText('Reason for the amendment'), { target: { value: 'Synthetic reason' } });
    fireEvent.click(screen.getByRole('button', { name: 'Amend' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No approved full-day leave covers this date');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ expectedVersion: 3, status: 'LEAVE', reason: 'Synthetic reason' }]);
  });

  it('a day a processed payroll used says so and offers no amendment, whatever the duty', async () => {
    session.permissions = ['attendance.amend.operational'];
    mockApi({
      'GET /v1/attendance/records?': [200, { items: [row({ payrollLocked: true })], total: 1, page: 1, pageSize: 25 }],
      'GET /v1/attendance/records/r-1/day': [200, DAY],
      'GET /v1/attendance/records/r-1/amendments': [200, { items: [], revisions: [] }],
    });
    open();
    choosePeriod();
    fireEvent.click(await screen.findByText('Open SYN1'));
    expect(await screen.findByText(/A processed payroll used this day/)).toBeTruthy();
    expect(screen.queryByLabelText('Amend to')).toBeNull();
  });

  it('exports with the filters shown, only with the export duty', async () => {
    session.permissions = ['attendance.export.operational'];
    const calls = mockApi({ 'GET /v1/attendance/records?': [200, { items: [row()], total: 1, page: 1, pageSize: 25 }], 'POST /v1/reports': [201, { id: 'r-9' }], 'GET /v1/reports/r-9': [200, { state: 'QUEUED', rowCount: null, failureCode: null }] });
    open();
    choosePeriod();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'ABSENT' } });
    fireEvent.click(await screen.findByText('Export this list'));
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/reports').map((c) => c.body)).toEqual([{ reportCode: 'ATTENDANCE_REGISTER', filters: { from: '2026-03-01', to: '2026-03-31', status: 'ABSENT' } }]));
    cleanup();
    session.permissions = [];
    open();
    choosePeriod();
    await screen.findByText('SYN1 Synthetic One');
    expect(screen.queryByText('Export this list')).toBeNull();
  });
});
