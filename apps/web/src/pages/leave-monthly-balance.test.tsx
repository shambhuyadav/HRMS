// Monthly leave-balance upload screen (jsdom; FR-025, DF05, DF09; the reference's "Upload Monthly Leave Balance"): offered with
// both duties, the preview shows each balance at the month end before and after and row problems in words, and commit or cancel
// go to the batch. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_ADMIN_SCREENS } from './leave-admin';

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
const screenOf = () => LEAVE_ADMIN_SCREENS.find((s) => s.path === '/leave/monthly-balance')!;
const open = () => {
  const Page = screenOf().component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
const BASE = '/v1/leave/monthly-adjustment-imports';
const BOTH = ['leave.import.operational', 'leave.adjust.operational'];
const job = (over: Record<string, unknown>) => ({
  id: 'j-1',
  state: 'PREVIEWED',
  template: 'LEAVE_MONTHLY_ADJUSTMENT_V1',
  fileName: 'october.csv',
  rowCount: 2,
  acceptedCount: 0,
  rejectedCount: 0,
  rows: [
    { rowNumber: 1, businessKey: 'SYN1@ANNUAL@2026-10', state: 'VALID', errorCode: null, proposedChanges: { balanceAtMonthEnd: { from: '10.0000', to: '11.5000' } } },
    { rowNumber: 2, businessKey: 'SYN2@SICK@2026-10', state: 'VALID', errorCode: null, proposedChanges: { balanceAtMonthEnd: { from: '3.0000', to: '2.0000' } } },
  ],
  ...over,
});
const chooseFile = () =>
  fireEvent.change(screen.getByLabelText('Balance file'), { target: { files: [new File(['employeeCode,leaveType,month,units,reason\r\nSYN1,ANNUAL,2026-10,1.5,Synthetic\r\n'], 'october.csv', { type: 'text/csv' })] } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('upload monthly leave balance (FR-025, DF09)', () => {
  it('FR-025: a menu screen under the import duty; without both duties nothing is offered', () => {
    expect(screenOf()).toMatchObject({ title: 'Upload monthly leave balance', nav: true, permission: 'leave.import.operational' });
    session.permissions = ['leave.import.operational'];
    mockApi({});
    open();
    expect(screen.getByText(/needs the leave import and adjustment duties/)).toBeTruthy();
  });

  it('FR-025 DF05: the preview shows each balance at the month end before and after; the commit applies the batch', async () => {
    session.permissions = BOTH;
    const calls = mockApi({
      [`GET ${BASE}?`]: [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      [`POST ${BASE}`]: [201, job({})],
      [`POST ${BASE}/j-1/commit`]: [200, job({ state: 'COMMITTED', acceptedCount: 2, rows: job({}).rows.map((r) => ({ ...r, state: 'ACCEPTED' })) })],
    });
    open();
    expect(screen.getByText('employeeCode,leaveType,month,units,reason')).toBeTruthy();
    chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    const preview = await screen.findByText('balanceAtMonthEnd: 10.0000 -> 11.5000');
    expect(preview).toBeTruthy();
    expect(screen.getByText('balanceAtMonthEnd: 3.0000 -> 2.0000')).toBeTruthy();
    const upload = calls.find((c) => c.method === 'POST' && c.url === BASE)!;
    expect(upload.body).toMatchObject({ fileName: 'october.csv' });
    expect(String(upload.body!.idempotencyKey)).toMatch(/^monthly-leave-/);
    fireEvent.click(screen.getByRole('button', { name: 'Record 2 adjustments' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url === `${BASE}/j-1/commit`)).toBe(true));
    expect(await screen.findByText('All 2 rows were applied.')).toBeTruthy();
  });

  it('DF09: a rejected batch lists its problem rows in words, with the code beneath', async () => {
    session.permissions = BOTH;
    mockApi({
      [`GET ${BASE}?`]: [200, { items: [], total: 0, page: 1, pageSize: 25 }],
      [`POST ${BASE}`]: [
        201,
        job({
          state: 'REJECTED',
          rows: [
            { rowNumber: 1, businessKey: 'SYN1@ANNUAL@2026-10', state: 'REJECTED', errorCode: 'MONTH_ALREADY_ADJUSTED', proposedChanges: null },
            { rowNumber: 2, businessKey: 'SYN2@SICK@2026-10', state: 'REJECTED', errorCode: 'NEGATIVE_BALANCE', proposedChanges: null },
          ],
        }),
      ],
    });
    open();
    chooseFile();
    fireEvent.click(screen.getByRole('button', { name: 'Validate' }));
    expect(await screen.findByText(/already has an uploaded adjustment of this leave type for this month/)).toBeTruthy();
    expect(screen.getByText(/would take a paid leave balance below zero/)).toBeTruthy();
    expect(screen.getByText('NEGATIVE_BALANCE')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Record / })).toBeNull();
  });
});
