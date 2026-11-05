// Notification preferences and the delivery log (jsdom; FR-061, FR-083, FR-085; DF12; BR-034): a toggle sends exactly the
// one choice changed and shows the server's answer, not its own hope; the log reaches the server with the filters and page
// chosen, shows states, attempts and failure codes, and never content; events that failed to dispatch are visible; nothing
// is asked without the duty. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_SCREENS } from '../screens-registry';
import { DeliveryLogPage, NOTIFICATION_SCREENS, NotificationPreferencesPanel } from './notifications';
import { InboxPage } from './work';

const READ_DELIVERY = 'notification.read_delivery.operational';
const PREFERENCES = '/v1/me/notification-preferences';
const DELIVERY = '/v1/notifications/delivery';
const FAILED = '/v1/notifications/delivery/failed-events';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: { accountKey: 'syn.user', companyName: 'Synthetic Co', roleCode: 'SYSTEM_ADMINISTRATOR', scopeKind: 'COMPANY', employeeId: null, displayName: null },
    stored: { token: 'syn-token', companies: [], companyId: 'syn-company', assignmentId: 'syn-assignment' },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

type Call = { url: string; method: string; body: unknown };
type Answer = (call: Call) => [number, unknown];
function mockApi(answer: Answer) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const [status, body] = answer(call);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const renderPage = (ui: JSX.Element) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const box = (name: string) => screen.findByRole('checkbox', { name }) as Promise<HTMLInputElement>;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('notification preferences panel (FR-083, FR-085, DF12)', () => {
  /** A little server: remembers what was saved, as the API does. */
  function preferenceServer(refuse = false) {
    const saved = [
      { eventType: 'BIRTHDAY', publishCelebration: false, receiveOptional: true },
      { eventType: 'WORK_ANNIVERSARY', publishCelebration: true, receiveOptional: false },
    ];
    return mockApi((call) => {
      if (call.method === 'PUT') {
        if (refuse) return [409, { error: 'STALE_VERSION', message: 'Synthetic refusal' }];
        const body = call.body as { eventType: string };
        Object.assign(saved.find((p) => p.eventType === body.eventType)!, body);
        return [200, body];
      }
      return [200, { items: saved }];
    });
  }

  it('shows what is saved and that mandatory notices cannot be switched off', async () => {
    const calls = preferenceServer();
    renderPage(<NotificationPreferencesPanel />);
    expect((await box('Publish my birthday to colleagues')).checked).toBe(false);
    expect((await box('Receive colleagues’ birthdays')).checked).toBe(true);
    expect((await box('Publish my work anniversary to colleagues')).checked).toBe(true);
    expect((await box('Receive colleagues’ work anniversaries')).checked).toBe(false);
    expect(screen.getByText(/mandatory and cannot be switched off/)).toBeTruthy();
    expect(calls[0]).toMatchObject({ url: PREFERENCES, method: 'GET' });
  });

  it('a toggle sends only that event and that choice, and the box then shows the saved answer', async () => {
    const calls = preferenceServer();
    renderPage(<NotificationPreferencesPanel />);
    fireEvent.click(await box('Publish my birthday to colleagues'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT')).toEqual([{ url: PREFERENCES, method: 'PUT', body: { eventType: 'BIRTHDAY', publishCelebration: true } }]));
    await waitFor(async () => expect((await box('Publish my birthday to colleagues')).checked).toBe(true));

    fireEvent.click(await box('Receive colleagues’ work anniversaries'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PUT').at(-1)).toEqual({ url: PREFERENCES, method: 'PUT', body: { eventType: 'WORK_ANNIVERSARY', receiveOptional: true } }));
    await waitFor(async () => expect((await box('Receive colleagues’ work anniversaries')).checked).toBe(true));
  });

  it('a refused save shows the refusal and leaves the box as saved', async () => {
    preferenceServer(true);
    renderPage(<NotificationPreferencesPanel />);
    fireEvent.click(await box('Publish my birthday to colleagues'));
    expect((await screen.findByRole('alert')).textContent).toContain('Synthetic refusal');
    expect((await box('Publish my birthday to colleagues')).checked).toBe(false);
  });

  it('sits on the inbox, for any user', async () => {
    const calls = mockApi((call) => (call.url === PREFERENCES ? [200, { items: [{ eventType: 'BIRTHDAY', publishCelebration: false, receiveOptional: true }] }] : [200, { items: [], unread: 0 }]));
    renderPage(<InboxPage />);
    expect(await box('Publish my birthday to colleagues')).toBeTruthy();
    expect(await screen.findByText('No notifications.')).toBeTruthy();
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining(['/v1/me/notifications', PREFERENCES]));
  });
});

describe('delivery log (FR-061, FR-085)', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 'n-1',
    category: 'EXPENSE_DECIDED',
    channel: 'IN_APP',
    state: 'SUPPRESSED',
    recipientUserId: 'u-1',
    recipientAccount: 'syn.recipient',
    occurredAt: '2026-11-02T04:30:00.000Z',
    attempts: 2,
    lastFailureCode: 'RECIPIENT_NOT_ELIGIBLE',
    ...over,
  });
  const failedEvent = (over: Record<string, unknown> = {}) => ({ id: 'e-1', topic: 'expense.decided', state: 'FAILED', occurredAt: '2026-11-02T04:30:00.000Z', attempts: 4, failureCode: 'PG_23514', nextAttemptAt: null, failedAt: '2026-11-02T05:00:00.000Z', ...over });
  const server = (over: { rows?: object[]; total?: number; events?: object[]; eventsTotal?: number } = {}) =>
    mockApi((call) =>
      call.url.startsWith(FAILED)
        ? [200, { items: over.events ?? [failedEvent()], total: over.eventsTotal ?? (over.events ?? [failedEvent()]).length }]
        : [200, { items: over.rows ?? [row()], total: over.total ?? (over.rows ?? [row()]).length }],
    );
  const logUrls = (calls: Call[]) => calls.filter((c) => c.url.startsWith(DELIVERY) && !c.url.startsWith(FAILED)).map((c) => c.url);

  it('is one screen in the menu, under its permission, and asks nothing without it', async () => {
    expect(NOTIFICATION_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([['/notifications/delivery', 'Delivery log', READ_DELIVERY, true]]);
    expect(MODULE_SCREENS.some((s) => s.path === '/notifications/delivery')).toBe(true);
    const calls = server();
    renderPage(<DeliveryLogPage />);
    expect(await screen.findByText(/cannot read the delivery log/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('shows state, attempts, failure code and recipient; a row carries no message', async () => {
    session.permissions = [READ_DELIVERY];
    server({ rows: [row({ body: 'SECRET-MESSAGE', title: 'SECRET-MESSAGE' })] });
    renderPage(<DeliveryLogPage />);
    const cells = within(within(await screen.findByRole('table', { name: 'Delivery log' })).getAllByRole('row')[1]!).getAllByRole('cell').map((c) => c.textContent);
    expect(cells.slice(1)).toEqual(['EXPENSE_DECIDED', 'syn.recipient', 'in app', 'suppressed', '2', 'RECIPIENT_NOT_ELIGIBLE']);
    expect(screen.queryByText(/SECRET-MESSAGE/)).toBeNull();
  });

  it('a filter reaches the server and returns to the first page; a page reaches the server with the filter', async () => {
    session.permissions = [READ_DELIVERY];
    const calls = server({ rows: Array.from({ length: 25 }, (_, i) => row({ id: `n-${i}` })), total: 60 });
    renderPage(<DeliveryLogPage />);
    await screen.findByRole('table', { name: 'Delivery log' });
    expect(logUrls(calls)[0]).toBe(`${DELIVERY}?page=1&pageSize=25`);

    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(logUrls(calls)).toContain(`${DELIVERY}?page=2&pageSize=25`));

    fireEvent.change(screen.getAllByLabelText('State')[0]!, { target: { value: 'FAILED' } });
    await waitFor(() => expect(logUrls(calls)).toContain(`${DELIVERY}?page=1&pageSize=25&state=FAILED`));

    fireEvent.change(screen.getByLabelText('Event'), { target: { value: 'expense decided' } });
    await waitFor(() => expect(logUrls(calls)).toContain(`${DELIVERY}?page=1&pageSize=25&state=FAILED&category=EXPENSE_DECIDED`));

    const pager = screen.getByRole('navigation', { name: 'Pages of the delivery log' });
    expect(pager.textContent).toContain('Page 1 of 3 · 60 notifications');
    fireEvent.click(within(pager).getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(logUrls(calls)).toContain(`${DELIVERY}?page=2&pageSize=25&state=FAILED&category=EXPENSE_DECIDED`));
  });

  it('the period reaches the list, and the export asks for what the filters show, only with its own right and a whole period (FR-093)', async () => {
    session.permissions = [READ_DELIVERY];
    const plain = server();
    renderPage(<DeliveryLogPage />);
    await screen.findByRole('table', { name: 'Delivery log' });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
    await waitFor(() => expect(logUrls(plain)).toContain(`${DELIVERY}?page=1&pageSize=25&from=2026-11-01`));
    expect(screen.queryByRole('button', { name: 'Export this log' })).toBeNull();
    cleanup();

    session.permissions = [READ_DELIVERY, 'notification.export.operational'];
    const calls = mockApi((call) => (call.method === 'POST' ? [202, { id: 'r-1', state: 'QUEUED' }] : call.url.startsWith(FAILED) ? [200, { items: [], total: 0 }] : [200, { items: [row()], total: 1 }]));
    renderPage(<DeliveryLogPage />);
    await screen.findByRole('table', { name: 'Delivery log' });
    const button = screen.getByRole('button', { name: 'Export this log' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.change(screen.getAllByLabelText('State')[0]!, { target: { value: 'FAILED' } });
    fireEvent.change(screen.getByLabelText('Event'), { target: { value: 'expense decided' } });
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-11-03' } });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await screen.findByText('Export requested. Download it from Reports when it is ready.');
    expect(calls.find((c) => c.method === 'POST' && c.url === '/v1/reports')!.body).toEqual({
      reportCode: 'NOTIFICATION_DELIVERY',
      filters: { from: '2026-11-01', to: '2026-11-03', status: 'FAILED', category: 'EXPENSE_DECIDED' },
    });
  });

  it('an event code the server would refuse is explained and not sent', async () => {
    session.permissions = [READ_DELIVERY];
    const calls = server();
    renderPage(<DeliveryLogPage />);
    await screen.findByRole('table', { name: 'Delivery log' });
    const before = logUrls(calls).length;
    fireEvent.change(screen.getByLabelText('Event'), { target: { value: '9 lives!' } });
    expect(await screen.findByText(/letters, digits and underscores/)).toBeTruthy();
    expect(logUrls(calls)).toHaveLength(before);
  });

  it('an empty match says so, and a refusal is shown as it is', async () => {
    session.permissions = [READ_DELIVERY];
    mockApi((call) => (call.url.startsWith(FAILED) ? [200, { items: [], total: 0 }] : [403, { error: 'FORBIDDEN', message: 'Not permitted' }]));
    renderPage(<DeliveryLogPage />);
    expect((await screen.findByRole('alert')).textContent).toContain('FORBIDDEN');
    expect(await screen.findByText('No events are retrying or failed.')).toBeTruthy();
    cleanup();
    server({ rows: [], total: 0 });
    renderPage(<DeliveryLogPage />);
    expect(await screen.findByText('No notifications match.')).toBeTruthy();
  });

  it('events that failed to dispatch are listed with attempts and error class, filter by state, and show no payload', async () => {
    session.permissions = [READ_DELIVERY];
    const calls = server({ events: [failedEvent({ payload: { secret: 'SECRET-PAYLOAD' } }), failedEvent({ id: 'e-2', state: 'RETRYING', nextAttemptAt: '2026-11-02T05:10:00.000Z', failedAt: null, attempts: 1, failureCode: 'TypeError' })] });
    renderPage(<DeliveryLogPage />);
    const table = await screen.findByRole('table', { name: 'Events not dispatched' });
    const rows = within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent));
    expect(rows[0]!.slice(1, 5)).toEqual(['expense.decided', 'failed', '4', 'PG_23514']);
    expect(rows[0]![5]).toBe('—');
    expect(rows[1]!.slice(1, 5)).toEqual(['expense.decided', 'retrying', '1', 'TypeError']);
    expect(rows[1]![5]).not.toBe('—');
    expect(screen.queryByText(/SECRET-PAYLOAD/)).toBeNull();

    fireEvent.change(screen.getAllByLabelText('State')[1]!, { target: { value: 'RETRYING' } });
    await waitFor(() => expect(calls.map((c) => c.url)).toContain(`${FAILED}?page=1&pageSize=25&state=RETRYING`));
  });
});
