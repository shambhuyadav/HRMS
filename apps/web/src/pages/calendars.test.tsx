// Holiday, shift and weekly-off maintenance (jsdom; FR-005; DF05; DF08; I-04; I-54): corrections and withdrawals keep the
// earlier entry and need a reason, every change shows the dates HR must reprocess and which are final, shift times change by
// a dated revision, patterns are whole days per location. Duties decide what is offered. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALENDARS_SCREENS, type Holiday, type Shift, type WeeklyOffCalendar } from './calendars';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

type Reply = [number, unknown];
type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
function mockApi(routes: Record<string, Reply | ((c: Call) => Reply)>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined };
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
const open = (path: string) => {
  const Page = CALENDARS_SCREENS.find((s) => s.path === path)!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};
const click = (el: HTMLElement) => fireEvent.click(el);
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const posts = (calls: Call[], url: string) => calls.filter((c) => c.method === 'POST' && c.url === url);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('screens', () => {
  it('are menu screens under the read duties', () => {
    expect(CALENDARS_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/calendars/holidays', 'holiday.read.operational', true],
      ['/calendars/shifts', 'shift.read.operational', true],
      ['/calendars/weekly-off', 'shift.read.operational', true],
    ]);
  });
});

const OPTIONS = {
  locations: [
    { id: 'l-1', code: 'HQ', name: 'Head office', active: true },
    { id: 'l-2', code: 'PLANT', name: 'Plant', active: true },
  ],
  types: [
    { code: 'HOLIDAY', label: 'Holiday' },
    { code: 'RESTRICTED', label: 'Restricted' },
  ],
};
const YEAR = new Date().getFullYear();
const HOLIDAYS = `GET /v1/holidays?locationId=l-1&year=${YEAR}`;
const ACTIVE: Holiday = { id: 'h-1', locationId: 'l-1', holidayDate: `${YEAR}-03-10`, name: 'Founders day', holidayType: 'HOLIDAY', state: 'ACTIVE', version: 3, supersedesId: null, supersededById: null, closedAt: null, closedReason: null };
const REACHED = { days: [{ workDate: `${YEAR}-03-10`, toReprocess: 4, amended: 1, locked: 2 }], truncated: false };
const LABEL = `Founders day on ${YEAR}-03-10`;

describe('holiday calendar (FR-005, DF08, I-04)', () => {
  it('shows the calendar in force; reading offers no change', async () => {
    session.permissions = ['holiday.read.operational'];
    mockApi({ 'GET /v1/holidays/options': [200, OPTIONS], [HOLIDAYS]: [200, { items: [ACTIVE] }] });
    open('/calendars/holidays');
    const row = within(await screen.findByRole('table', { name: 'Holidays' })).getByText('Founders day').closest('tr')!;
    expect(within(row).getByText('active')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Withdraw ${LABEL}` })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Add a holiday' })).toBeNull();
  });

  it('a withdrawal needs a reason, sends the version and shows the dates to reprocess and which are final', async () => {
    session.permissions = ['holiday.read.operational', 'holiday.manage.operational', 'attendance.process.operational'];
    const calls = mockApi({
      'GET /v1/holidays/options': [200, OPTIONS],
      [HOLIDAYS]: [200, { items: [ACTIVE] }],
      'POST /v1/holidays/h-1/withdraw': [200, { id: 'h-1', state: 'WITHDRAWN', reprocess: REACHED }],
      'POST /v1/attendance/processing': [202, { jobId: 'job-1' }],
    });
    open('/calendars/holidays');
    click(await screen.findByRole('button', { name: `Withdraw ${LABEL}` }));
    const form = screen.getByRole('form', { name: `Withdraw ${LABEL}` });
    expect((within(form).getByLabelText('Reason') as HTMLInputElement).required).toBe(true);
    type(within(form).getByLabelText('Reason'), ' Declared by mistake ');
    click(within(form).getByRole('button', { name: 'Confirm withdrawal' }));

    const table = await screen.findByRole('table', { name: 'Dates to reprocess' });
    expect(posts(calls, '/v1/holidays/h-1/withdraw')[0]!.body).toEqual({ expectedVersion: 3, reason: 'Declared by mistake' });
    expect(within(within(table).getAllByRole('row')[1]!).getAllByRole('cell').slice(0, 4).map((c) => c.textContent)).toEqual([`${YEAR}-03-10`, '4', '1', '2']);
    expect(screen.getByText(/keep their results until they are processed again/)).toBeTruthy();

    // HR reprocesses from here: queued, and followed in the background jobs.
    click(within(table).getByRole('button', { name: `Reprocess ${YEAR}-03-10` }));
    expect((await screen.findByRole('link', { name: 'My background jobs' })).getAttribute('href')).toBe('/bulk-jobs');
    expect(posts(calls, '/v1/attendance/processing')[0]!.body).toMatchObject({ workDate: `${YEAR}-03-10`, idempotencyKey: expect.any(String) });
  });

  it('without the processing duty the dates are listed but not offered; a day with nothing to reprocess offers nothing', async () => {
    session.permissions = ['holiday.read.operational', 'holiday.manage.operational'];
    mockApi({
      'GET /v1/holidays/options': [200, OPTIONS],
      [HOLIDAYS]: [200, { items: [ACTIVE] }],
      'POST /v1/holidays/h-1/withdraw': [200, { id: 'h-1', state: 'WITHDRAWN', reprocess: REACHED }],
    });
    open('/calendars/holidays');
    click(await screen.findByRole('button', { name: `Withdraw ${LABEL}` }));
    type(within(screen.getByRole('form', { name: `Withdraw ${LABEL}` })).getByLabelText('Reason'), 'Mistake');
    click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    await screen.findByRole('table', { name: 'Dates to reprocess' });
    expect(screen.queryByRole('button', { name: /Reprocess/ })).toBeNull();
    cleanup();

    session.permissions = ['holiday.read.operational', 'holiday.manage.operational', 'attendance.process.operational'];
    mockApi({
      'GET /v1/holidays/options': [200, OPTIONS],
      [HOLIDAYS]: [200, { items: [ACTIVE] }],
      'POST /v1/holidays/h-1/withdraw': [200, { id: 'h-1', state: 'WITHDRAWN', reprocess: { days: [{ workDate: `${YEAR}-03-10`, toReprocess: 0, amended: 0, locked: 3 }], truncated: false } }],
    });
    open('/calendars/holidays');
    click(await screen.findByRole('button', { name: `Withdraw ${LABEL}` }));
    type(within(screen.getByRole('form', { name: `Withdraw ${LABEL}` })).getByLabelText('Reason'), 'Mistake');
    click(screen.getByRole('button', { name: 'Confirm withdrawal' }));
    await screen.findByRole('table', { name: 'Dates to reprocess' });
    expect(screen.queryByRole('button', { name: /Reprocess/ })).toBeNull();
  });

  it('a correction sends only what changed and the current version; a clash is refused in words', async () => {
    session.permissions = ['holiday.read.operational', 'holiday.manage.operational'];
    let refuse = true;
    const calls = mockApi({
      'GET /v1/holidays/options': [200, OPTIONS],
      [HOLIDAYS]: [200, { items: [ACTIVE] }],
      'POST /v1/holidays/h-1/correct': () => (refuse ? [409, { error: 'DUPLICATE', message: 'A record with the same unique value already exists' }] : [201, { id: 'h-2', reprocess: { days: [], truncated: false } }]),
    });
    open('/calendars/holidays');
    click(await screen.findByRole('button', { name: `Correct ${LABEL}` }));
    const form = screen.getByRole('form', { name: `Correct ${LABEL}` });
    type(within(form).getByLabelText('Date'), `${YEAR}-03-11`);
    type(within(form).getByLabelText('Location'), 'l-2');
    type(within(form).getByLabelText('Reason'), 'Wrong date');
    click(within(form).getByRole('button', { name: 'Save correction' }));
    expect((await screen.findByRole('alert')).textContent).toContain('already has a holiday of that type');
    expect(posts(calls, '/v1/holidays/h-1/correct')[0]!.body).toEqual({ expectedVersion: 3, reason: 'Wrong date', holidayDate: `${YEAR}-03-11`, locationId: 'l-2' });

    refuse = false;
    click(within(form).getByRole('button', { name: 'Save correction' }));
    expect((await screen.findByText(/No evaluated attendance day is affected/)).getAttribute('role')).toBe('status');
    expect(screen.queryByRole('form', { name: `Correct ${LABEL}` })).toBeNull();
  });

  it('a closed entry is shown with its reason on request, and offers no change', async () => {
    session.permissions = ['holiday.read.operational', 'holiday.manage.operational'];
    const closed: Holiday = { ...ACTIVE, state: 'WITHDRAWN', closedAt: `${YEAR}-03-12T10:00:00Z`, closedReason: 'Declared by mistake' };
    const calls = mockApi({
      'GET /v1/holidays/options': [200, OPTIONS],
      [`${HOLIDAYS}&state=ACTIVE`]: [200, { items: [] }],
      [`${HOLIDAYS}&state=ALL`]: [200, { items: [closed] }],
    });
    open('/calendars/holidays');
    expect(await screen.findByText('No holidays in force for this location and year.')).toBeTruthy();
    type(screen.getByLabelText('Show'), 'ALL');
    const table = await screen.findByRole('table', { name: 'Holidays' });
    expect(within(table).getByText(/Declared by mistake/)).toBeTruthy();
    expect(within(table).getByText('withdrawn')).toBeTruthy();
    expect(screen.queryByRole('button', { name: `Withdraw ${LABEL}` })).toBeNull();
    expect(calls.some((c) => c.url.endsWith('state=ALL'))).toBe(true);
  });

  it('adds a holiday to the chosen location and lists the dates it reaches', async () => {
    session.permissions = ['holiday.read.operational', 'holiday.manage.operational'];
    const calls = mockApi({
      'GET /v1/holidays/options': [200, OPTIONS],
      'GET /v1/holidays?locationId=l-2': [200, { items: [] }],
      'GET /v1/holidays?locationId=l-1': [200, { items: [] }],
      'POST /v1/holidays': [201, { id: 'h-3', reprocess: REACHED }],
    });
    open('/calendars/holidays');
    const form = await screen.findByRole('form', { name: 'Add a holiday' });
    await waitFor(() => expect((screen.getByLabelText('Location') as HTMLSelectElement).value).toBe('l-1'));
    type(screen.getByLabelText('Location'), 'l-2');
    type(within(form).getByLabelText('Date'), `${YEAR}-03-10`);
    type(within(form).getByLabelText('Name'), ' Founders day ');
    type(within(form).getByLabelText('Type'), 'RESTRICTED');
    click(within(form).getByRole('button', { name: 'Add holiday' }));
    await screen.findByRole('table', { name: 'Dates to reprocess' });
    expect(posts(calls, '/v1/holidays')[0]!.body).toEqual({ locationId: 'l-2', holidayDate: `${YEAR}-03-10`, name: 'Founders day', holidayType: 'RESTRICTED' });
  });
});

const SHIFT: Shift = {
  id: 's-1',
  code: 'NIGHT',
  name: 'Night',
  inTime: '22:00',
  outTime: '06:00',
  spansMidnight: true,
  netScheduledMinutes: 450,
  active: true,
  version: 2,
  revision: 2,
  effectiveFrom: '2026-03-01',
  breaks: [{ startOffsetMinutes: 180, endOffsetMinutes: 210 }],
  revisions: [
    { revision: 1, effectiveFrom: null, inTime: '21:00', outTime: '05:00', spansMidnight: true, netScheduledMinutes: 480, breaks: [], reason: null },
    { revision: 2, effectiveFrom: '2026-03-01', inTime: '22:00', outTime: '06:00', spansMidnight: true, netScheduledMinutes: 450, breaks: [{ startOffsetMinutes: 180, endOffsetMinutes: 210 }], reason: 'Later start' },
  ],
};

describe('shift master (FR-005, DF05)', () => {
  it('shows the times in force and every revision; reading offers no change', async () => {
    session.permissions = ['shift.read.operational'];
    mockApi({ 'GET /v1/shifts': [200, { items: [SHIFT] }] });
    open('/calendars/shifts');
    const table = await screen.findByRole('table', { name: 'Shifts' });
    // Break offsets are shown as clock times, past midnight on a night shift.
    expect(within(table).getAllByText(/22:00-06:00 \(next day\), break 01:00-01:30, 450 net minutes/)).toHaveLength(2);
    expect(within(table).getByText('Revision 2, from 2026-03-01')).toBeTruthy();
    expect(within(table).getByText(/Revision 1, from the start: 21:00-05:00/)).toBeTruthy();
    expect(within(table).getByText(/Later start/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change times of NIGHT' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'New shift' })).toBeNull();
  });

  it('a change of times is a dated revision with a reason, starting from what is in force', async () => {
    session.permissions = ['shift.read.operational', 'shift.update.operational', 'attendance.process.operational'];
    const calls = mockApi({ 'GET /v1/shifts': [200, { items: [SHIFT] }], 'POST /v1/shifts/s-1/revisions': [201, { ...SHIFT, reprocess: REACHED }] });
    open('/calendars/shifts');
    click(await screen.findByRole('button', { name: 'Change times of NIGHT' }));
    const form = screen.getByRole('form', { name: 'Change times of NIGHT' });
    expect((within(form).getByLabelText('In time') as HTMLInputElement).value).toBe('22:00');
    expect((within(form).getByLabelText('Break 1 from') as HTMLInputElement).value).toBe('01:00');
    type(within(form).getByLabelText('Applies from'), '2026-04-01');
    type(within(form).getByLabelText('Break 1 to'), '02:00');
    click(within(form).getByRole('button', { name: 'Add a break' }));
    type(within(form).getByLabelText('Break 2 from'), '04:00');
    type(within(form).getByLabelText('Break 2 to'), '04:15');
    type(within(form).getByLabelText('Reason'), ' Longer break ');
    click(within(form).getByRole('button', { name: 'Save revision' }));
    await screen.findByRole('table', { name: 'Dates to reprocess' });
    expect(posts(calls, '/v1/shifts/s-1/revisions')[0]!.body).toEqual({
      expectedVersion: 2,
      effectiveFrom: '2026-04-01',
      inTime: '22:00',
      outTime: '06:00',
      // From 22:00: 01:00 is 180 minutes in, 02:00 is 240, 04:00 is 360, 04:15 is 375.
      breaks: [
        { startOffsetMinutes: 180, endOffsetMinutes: 240 },
        { startOffsetMinutes: 360, endOffsetMinutes: 375 },
      ],
      reason: 'Longer break',
    });
  });

  it('a new change offers a date again even if an earlier change queued it', async () => {
    session.permissions = ['shift.read.operational', 'shift.update.operational', 'attendance.process.operational'];
    const calls = mockApi({ 'GET /v1/shifts': [200, { items: [SHIFT] }], 'POST /v1/shifts/s-1/revisions': [201, { ...SHIFT, reprocess: REACHED }], 'POST /v1/attendance/processing': [202, { jobId: 'job-1' }] });
    open('/calendars/shifts');
    const change = async () => {
      click(await screen.findByRole('button', { name: 'Change times of NIGHT' }));
      const form = screen.getByRole('form', { name: 'Change times of NIGHT' });
      type(within(form).getByLabelText('Applies from'), '2026-04-01');
      type(within(form).getByLabelText('Reason'), 'Later');
      click(within(form).getByRole('button', { name: 'Save revision' }));
    };
    await change();
    click(await screen.findByRole('button', { name: `Reprocess ${YEAR}-03-10` }));
    await screen.findByRole('link', { name: 'My background jobs' });
    await change();
    await waitFor(() => expect(posts(calls, '/v1/shifts/s-1/revisions')).toHaveLength(2));
    expect(await screen.findByRole('button', { name: `Reprocess ${YEAR}-03-10` })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'My background jobs' })).toBeNull();
  });

  it('refuses in words, and a stale version reloads the list', async () => {
    session.permissions = ['shift.read.operational', 'shift.update.operational'];
    const calls = mockApi({ 'GET /v1/shifts': [200, { items: [SHIFT] }], 'POST /v1/shifts/s-1/revisions': [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }] });
    open('/calendars/shifts');
    click(await screen.findByRole('button', { name: 'Change times of NIGHT' }));
    const form = screen.getByRole('form', { name: 'Change times of NIGHT' });
    type(within(form).getByLabelText('Applies from'), '2026-04-01');
    type(within(form).getByLabelText('Reason'), 'Later');
    const before = calls.filter((c) => c.url === '/v1/shifts').length;
    click(within(form).getByRole('button', { name: 'Save revision' }));
    expect((await screen.findByRole('alert')).textContent).toContain('This changed since you opened it');
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/shifts').length).toBeGreaterThan(before));
  });

  it('renames and deactivates with the version; a new shift needs the create duty and proposes no times', async () => {
    session.permissions = ['shift.read.operational', 'shift.update.operational', 'shift.create.operational'];
    const calls = mockApi({ 'GET /v1/shifts': [200, { items: [SHIFT] }], 'PATCH /v1/shifts/s-1': [200, SHIFT], 'POST /v1/shifts': [201, SHIFT] });
    open('/calendars/shifts');
    click(await screen.findByRole('button', { name: 'Deactivate NIGHT' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ expectedVersion: 2, active: false }));

    const form = screen.getByRole('form', { name: 'New shift' });
    expect((within(form).getByLabelText('In time') as HTMLInputElement).value).toBe('');
    expect(within(form).queryByLabelText('Break 1 from')).toBeNull();
    type(within(form).getByLabelText('Code'), 'DAY');
    type(within(form).getByLabelText('Name'), 'Day');
    type(within(form).getByLabelText('In time'), '09:00');
    type(within(form).getByLabelText('Out time'), '18:00');
    click(within(form).getByRole('button', { name: 'Add a break' }));
    type(within(form).getByLabelText('Break 1 from'), '13:00');
    type(within(form).getByLabelText('Break 1 to'), '14:00');
    click(within(form).getByRole('button', { name: 'Create shift' }));
    await waitFor(() => expect(posts(calls, '/v1/shifts')).toHaveLength(1));
    expect(posts(calls, '/v1/shifts')[0]!.body).toEqual({ code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] });
  });
});

const DEFAULT_CALENDAR: WeeklyOffCalendar = { locationId: 'l-1', locationCode: 'HQ', locationName: 'Head office', active: true, inForce: { offDays: [6, 7], isDefault: true, revision: null, effectiveFrom: null }, latestRevision: 0, entries: [] };
const SIX_DAY: WeeklyOffCalendar = {
  locationId: 'l-2',
  locationCode: 'PLANT',
  locationName: 'Plant',
  active: true,
  inForce: { offDays: [7], isDefault: false, revision: 2, effectiveFrom: '2026-03-01' },
  latestRevision: 2,
  entries: [
    { id: 'p-1', revision: 1, effectiveFrom: '2026-01-01', offDays: [5, 6], reason: 'Old roster' },
    { id: 'p-2', revision: 2, effectiveFrom: '2026-03-01', offDays: [7], reason: 'Six-day week' },
  ],
};

describe('weekly-off patterns (FR-005, DF05)', () => {
  it('shows the default and the dated entries per location; reading offers no change', async () => {
    session.permissions = ['shift.read.operational'];
    mockApi({ 'GET /v1/weekly-off-patterns': [200, { defaultOffDays: [6, 7], items: [DEFAULT_CALENDAR, SIX_DAY] }] });
    open('/calendars/weekly-off');
    const table = await screen.findByRole('table', { name: 'Weekly-off patterns' });
    const [, hq, plant] = within(table).getAllByRole('row');
    expect(hq!.textContent).toContain('Saturday, Sunday off');
    expect(hq!.textContent).toContain('The Monday to Friday default');
    expect(plant!.textContent).toContain('Entry 2, from 2026-03-01');
    expect(plant!.textContent).toContain('Entry 1, from 2026-01-01: Friday, Saturday off. Old roster');
    expect(screen.queryByRole('button', { name: 'Change pattern of HQ' })).toBeNull();
  });

  it('saves whole days from a date with the latest entry seen; no half day is offered', async () => {
    session.permissions = ['shift.read.operational', 'shift.update.operational', 'attendance.process.operational'];
    const calls = mockApi({ 'GET /v1/weekly-off-patterns': [200, { defaultOffDays: [6, 7], items: [DEFAULT_CALENDAR, SIX_DAY] }], 'POST /v1/weekly-off-patterns': [201, { id: 'p-3', reprocess: REACHED }] });
    open('/calendars/weekly-off');
    click(await screen.findByRole('button', { name: 'Change pattern of PLANT' }));
    const form = screen.getByRole('form', { name: 'Change pattern of PLANT' });
    expect((within(form).getByLabelText('Sunday') as HTMLInputElement).checked).toBe(true);
    expect((within(form).getByLabelText('Saturday') as HTMLInputElement).checked).toBe(false);
    expect(within(form).queryByLabelText(/half/i)).toBeNull();
    expect(within(form).getAllByRole('checkbox')).toHaveLength(7);
    click(within(form).getByLabelText('Friday'));
    type(within(form).getByLabelText('Applies from'), '2026-05-01');
    type(within(form).getByLabelText('Reason'), ' Friday prayers roster ');
    click(within(form).getByRole('button', { name: 'Save pattern' }));
    await screen.findByRole('table', { name: 'Dates to reprocess' });
    expect(posts(calls, '/v1/weekly-off-patterns')[0]!.body).toEqual({ locationId: 'l-2', effectiveFrom: '2026-05-01', offDays: [5, 7], reason: 'Friday prayers roster', expectedRevision: 2 });
  });

  it('a week with no working day is refused in words', async () => {
    session.permissions = ['shift.read.operational', 'shift.update.operational'];
    mockApi({ 'GET /v1/weekly-off-patterns': [200, { defaultOffDays: [6, 7], items: [DEFAULT_CALENDAR] }], 'POST /v1/weekly-off-patterns': [422, { error: 'NO_WORKING_DAY', message: 'A pattern must leave at least one working day in the week' }] });
    open('/calendars/weekly-off');
    click(await screen.findByRole('button', { name: 'Change pattern of HQ' }));
    const form = screen.getByRole('form', { name: 'Change pattern of HQ' });
    for (const day of ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']) click(within(form).getByLabelText(day));
    type(within(form).getByLabelText('Applies from'), '2026-05-01');
    type(within(form).getByLabelText('Reason'), 'Closed');
    click(within(form).getByRole('button', { name: 'Save pattern' }));
    expect((await screen.findByRole('alert')).textContent).toContain('at least one working day');
  });
});
