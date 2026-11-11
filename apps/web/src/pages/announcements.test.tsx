// Company events and ticker messages (jsdom; coverage CL-021, CL-022): the dashboard panel shows what the server answers and nothing
// without the read duty; HR adds, edits with the version on screen and switches off; refusals read in plain words. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCEMENT_SCREENS, AnnouncementsPanel, type CompanyEvent, EventsPage, TickerPage } from './announcements';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

type Reply = [number, unknown];
type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
function serve(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const key = Object.keys(routes)
        .filter((k) => `${call.method} ${url}`.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const route = key === undefined ? undefined : routes[key];
      const [status, body]: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const show = (node: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

const EVENT: CompanyEvent = {
  id: 'ev-1',
  name: 'Annual day',
  description: 'All hands',
  eventDate: '2026-11-20',
  audience: 'ALL',
  departmentId: null,
  departmentName: null,
  locationId: null,
  locationName: null,
  active: true,
  version: 3,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('dashboard panel (CL-021, CL-022)', () => {
  it('shows today’s messages and the upcoming events the server chose', async () => {
    session.permissions = ['announcement.read.operational'];
    serve({
      'GET /v1/announcements/feed': [
        200,
        {
          asOf: '2026-11-11',
          messages: [{ id: 't1', message: 'Office closed on Friday', startsOn: '2026-11-11', endsOn: '2026-11-14' }],
          events: [{ id: 'e1', name: 'Engineering offsite', description: null, eventDate: '2026-11-16', audience: 'DEPARTMENT', for: 'Engineering' }],
        },
      ],
    });
    show(<AnnouncementsPanel />);
    const banner = await screen.findByRole('region', { name: 'Announcements' });
    expect(banner.textContent).toContain('Office closed on Friday');
    const events = screen.getByRole('list', { name: 'Upcoming events' });
    expect(events.textContent).toContain('Engineering offsite');
    expect(events.textContent).toContain('2026-11-16 · Engineering');
  });

  it('asks for nothing and shows nothing without the read duty, or when there is nothing', async () => {
    const calls = serve({ 'GET /v1/announcements/feed': [200, { asOf: '2026-11-11', messages: [], events: [] }] });
    const first = show(<AnnouncementsPanel />);
    expect(calls).toEqual([]);
    expect(first.container.textContent).toBe('');
    first.unmount();
    session.permissions = ['announcement.read.operational'];
    const second = show(<AnnouncementsPanel />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(second.container.textContent).toBe('');
  });
});

describe('HR screens (CL-021, CL-022)', () => {
  it('are menu screens under the manage duty', () => {
    expect(ANNOUNCEMENT_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/announcements/events', 'announcement.manage.operational', true],
      ['/announcements/ticker', 'announcement.manage.operational', true],
    ]);
  });

  it('adds an event for one department, sending only that department', async () => {
    session.permissions = ['announcement.manage.operational', 'org_master.read.operational'];
    const calls = serve({
      'GET /v1/company-events': [200, { items: [] }],
      'GET /v1/org/departments': [200, { items: [{ id: 'd-1', code: 'ENG', name: 'Engineering', active: true }] }],
      'POST /v1/company-events': (c) => [201, { ...EVENT, id: 'ev-2', name: c.body!.name }],
    });
    show(<EventsPage />);
    expect(await screen.findByText('No events yet.')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'New event' });
    fireEvent.change(within(form).getByLabelText('Event name'), { target: { value: ' Offsite ' } });
    fireEvent.change(within(form).getByLabelText('Event date'), { target: { value: '2026-11-16' } });
    fireEvent.change(within(form).getByLabelText('For'), { target: { value: 'DEPARTMENT' } });
    await within(form).findByRole('option', { name: 'Engineering (ENG)' });
    fireEvent.change(within(form).getByLabelText('Department'), { target: { value: 'd-1' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Offsite added.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ name: 'Offsite', eventDate: '2026-11-16', audience: 'DEPARTMENT', description: null, departmentId: 'd-1', locationId: null });
  });

  it('switches an event off with the version on screen, and reads a stale version in plain words', async () => {
    session.permissions = ['announcement.manage.operational'];
    let stale = false;
    const calls = serve({
      'GET /v1/company-events': [200, { items: [EVENT] }],
      'PATCH /v1/company-events/ev-1': () => (stale ? [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }] : [200, { ...EVENT, active: false, version: 4 }]),
    });
    show(<EventsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Switch off Annual day' }));
    expect(await screen.findByText('Annual day switched off.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ expectedVersion: 3, active: false });
    stale = true;
    fireEvent.click(await screen.findByRole('button', { name: 'Switch off Annual day' }));
    expect(await screen.findByText(/Someone changed this since you opened it/)).toBeTruthy();
  });

  it('adds a ticker message and shows the server’s refusal of a reversed period', async () => {
    session.permissions = ['announcement.manage.operational'];
    const calls = serve({
      'GET /v1/ticker-messages': [200, { items: [] }],
      'POST /v1/ticker-messages': [422, { error: 'INVALID_PERIOD', message: 'The last day is before the first day' }],
    });
    show(<TickerPage />);
    const form = await screen.findByRole('form', { name: 'New message' });
    fireEvent.change(within(form).getByLabelText('Message'), { target: { value: 'Fire drill  ' } });
    fireEvent.change(within(form).getByLabelText('First day'), { target: { value: '2026-11-14' } });
    fireEvent.change(within(form).getByLabelText('Last day'), { target: { value: '2026-11-12' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The last day is before the first day')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ message: 'Fire drill', startsOn: '2026-11-14', endsOn: '2026-11-12' });
    expect((within(form).getByLabelText('Message') as HTMLInputElement).value).toBe('Fire drill  ');
  });
});
