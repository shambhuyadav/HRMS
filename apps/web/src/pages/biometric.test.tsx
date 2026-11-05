// Biometric administration screens (jsdom; FR-086, FR-087, FR-088; BR-035; BR-036; DF09; DF13): references go in and never
// come back, a revision is approved by someone else, a preview applies nothing, links are ended or moved with a reason, and
// the monitor offers only what each record allows. Duties decide what is offered. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BIOMETRIC_SCREENS, type EmployeeLink, type MappingRevision, type Profile, type SyncException, type SyncRun } from './biometric';

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
  const Page = BIOMETRIC_SCREENS.find((s) => s.path === path)!.component;
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
const refused = (error: string, details?: unknown): Reply => [error === 'SELF_APPROVAL' ? 403 : 409, { error, message: `Server text for ${error}`, details }];
const pick = (label: string, value: string, within_: HTMLElement = document.body) => type(within(within_).getByLabelText(label), value);

const PROFILE: Profile = { id: 'p-1', code: 'GATE', name: 'Gate devices', providerTimezone: 'Asia/Kolkata', paginationMode: 'CURSOR', lookbackMinutes: 60, active: true, syncedUntil: null, version: 3 };
const IDLE: Profile = { ...PROFILE, id: 'p-2', code: 'YARD', name: 'Yard devices', active: false, version: 1 };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('screens', () => {
  it('are menu screens under their own duties', () => {
    expect(BIOMETRIC_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/biometric/profiles', 'biometric.profile_manage.operational', true],
      ['/biometric/field-mapping', 'biometric.mapping_manage.operational', true],
      ['/biometric/employee-mapping', 'biometric.employee_link_manage.operational', true],
      ['/biometric/sync-monitor', 'biometric.read.operational', true],
    ]);
  });
});

describe('API profiles', () => {
  it('sends references once, as entered, and proposes no value', async () => {
    const calls = mockApi({ 'GET /v1/biometric/profiles': [200, { items: [] }], 'POST /v1/biometric/profiles': [201, { id: 'p-9', active: false }] });
    open('/biometric/profiles');
    const form = await screen.findByRole('form', { name: 'New profile' });
    expect((within(form).getByLabelText('Lookback (minutes)') as HTMLInputElement).value).toBe('');
    expect((within(form).getByLabelText('Pagination') as HTMLSelectElement).value).toBe('');
    pick('Code', 'GATE', form);
    pick('Name', 'Gate devices', form);
    pick('Provider time zone', 'Asia/Kolkata', form);
    pick('Pagination', 'CURSOR', form);
    pick('Lookback (minutes)', '60', form);
    pick('Request settings reference', 'store://request', form);
    pick('Credential reference', 'store://credential', form);
    pick('Schedule reference', 'store://schedule', form);
    fireEvent.submit(form);
    await waitFor(() => expect(posts(calls, '/v1/biometric/profiles')).toHaveLength(1));
    expect(posts(calls, '/v1/biometric/profiles')[0]!.body).toEqual({
      code: 'GATE',
      name: 'Gate devices',
      providerTimezone: 'Asia/Kolkata',
      paginationMode: 'CURSOR',
      lookbackMinutes: 60,
      requestConfigReference: 'store://request',
      authReference: 'store://credential',
      scheduleReference: 'store://schedule',
    });
    await waitFor(() => expect((within(form).getByLabelText('Credential reference') as HTMLInputElement).value).toBe(''));
  });

  it('disables with a reason and the version it saw; activates; refusals are in plain words', async () => {
    const calls = mockApi({
      'GET /v1/biometric/profiles': [200, { items: [PROFILE, IDLE] }],
      'POST /v1/biometric/profiles/p-1/disable': [200, { id: 'p-1', active: false }],
      'POST /v1/biometric/profiles/p-2/activate': refused('MAPPING_NOT_APPROVED'),
    });
    open('/biometric/profiles');
    click(await screen.findByRole('button', { name: 'Disable GATE' }));
    const form = screen.getByRole('form', { name: 'Disable GATE' });
    expect(within(form).getByRole('button', { name: 'Confirm disable' })).toHaveProperty('disabled', true);
    expect(form.textContent).toContain('punches already made stay on record');
    pick('Reason', 'Device retired', form);
    click(within(form).getByRole('button', { name: 'Confirm disable' }));
    await waitFor(() => expect(posts(calls, '/v1/biometric/profiles/p-1/disable')).toHaveLength(1));
    expect(posts(calls, '/v1/biometric/profiles/p-1/disable')[0]!.body).toEqual({ reason: 'Device retired', expectedVersion: 3 });

    click(screen.getByRole('button', { name: 'Activate YARD' }));
    expect(await screen.findByText('Activation needs an approved mapping revision that is in force.')).toBeTruthy();
  });
});

describe('field mapping', () => {
  const REVISIONS: MappingRevision[] = [
    { id: 'm-3', revision: 3, effectiveFrom: '2026-06-01T00:00:00Z', effectiveTo: null, dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: 'ISO_WITH_OFFSET', approved: false, ownRevision: true, fields: [] },
    {
      id: 'm-2',
      revision: 2,
      effectiveFrom: '2026-05-01T00:00:00Z',
      effectiveTo: null,
      dedupeStrategy: 'FINGERPRINT',
      timestampRule: 'LOCAL_IN_PROVIDER_ZONE',
      approved: false,
      ownRevision: false,
      fields: [{ sourcePath: 'emp.code', targetField: 'EMPLOYEE_KEY', transformCode: 'TRIM', enumConfig: null, required: true, defaultCode: null }],
    },
  ];
  const world = (extra: Record<string, Reply | ((c: Call) => Reply)> = {}) =>
    mockApi({ 'GET /v1/biometric/profiles': [200, { items: [PROFILE] }], 'GET /v1/biometric/profiles/p-1/mappings': [200, { items: REVISIONS }], ...extra });
  const choose = async () => {
    open('/biometric/field-mapping');
    await screen.findByRole('option', { name: 'GATE · Gate devices' });
    pick('Profile', 'p-1');
  };

  it('asks for a profile first, and offers approval only on a revision someone else wrote', async () => {
    const calls = world({ 'POST /v1/biometric/mappings/m-2/approve': [200, { approved: true }] });
    open('/biometric/field-mapping');
    await screen.findByRole('option', { name: 'GATE · Gate devices' });
    expect(calls.some((c) => c.url.endsWith('/mappings'))).toBe(false);
    pick('Profile', 'p-1');
    await screen.findByRole('heading', { name: 'Revision 3' });
    expect(screen.queryByRole('button', { name: 'Approve revision 3' })).toBeNull();
    expect(screen.getByText('You wrote this revision, so someone else must approve it.')).toBeTruthy();
    expect(within(screen.getByRole('table', { name: 'Fields of revision 2' })).getByText('emp.code')).toBeTruthy();
    click(screen.getByRole('button', { name: 'Approve revision 2' }));
    await waitFor(() => expect(posts(calls, '/v1/biometric/mappings/m-2/approve')).toHaveLength(1));
  });

  it('sends only the mapped targets, with a direction value map and default, and explains an unusable mapping', async () => {
    const calls = world({ 'POST /v1/biometric/profiles/p-1/mappings': refused('MAPPING_INVALID', { errors: ['EMPLOYEE_KEY_REQUIRED', 'INVALID_PATH:DIRECTION'] }) });
    await choose();
    const form = await screen.findByRole('form', { name: 'New mapping revision' });
    pick('Duplicates by', 'PROVIDER_EVENT_KEY', form);
    pick('Time format', 'ISO_WITH_OFFSET', form);
    pick('In force from', '2026-06-01T09:00', form);
    pick('Punch time source path', 'ts', form);
    click(within(form).getByLabelText('Punch time required'));
    pick('Direction source path', 'dir', form);
    pick('Direction transform', 'ENUM_MAP', form);
    pick('Direction values', '0=IN\n1=OUT', form);
    pick('Direction default', 'IN', form);
    fireEvent.submit(form);
    await waitFor(() => expect(posts(calls, '/v1/biometric/profiles/p-1/mappings')).toHaveLength(1));
    expect(posts(calls, '/v1/biometric/profiles/p-1/mappings')[0]!.body).toEqual({
      dedupeStrategy: 'PROVIDER_EVENT_KEY',
      timestampRule: 'ISO_WITH_OFFSET',
      effectiveFrom: new Date('2026-06-01T09:00').toISOString(),
      fields: [
        { sourcePath: 'ts', targetField: 'PUNCH_INSTANT', transformCode: 'PARSE_INSTANT', required: true },
        { sourcePath: 'dir', targetField: 'DIRECTION', transformCode: 'ENUM_MAP', required: false, enumConfig: { 0: 'IN', 1: 'OUT' }, defaultCode: 'IN' },
      ],
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('This mapping cannot be used: the employee identity must be mapped and required; the source path of DIRECTION is not a plain field path.');
  });

  it('previews parsed samples and refuses what is not a list before sending it', async () => {
    const calls = world({
      'POST /v1/biometric/mappings/m-2/preview': [200, { results: [{ ok: true, value: { employeeKey: 'E-1', direction: 'IN', instant: { kind: 'ISO', value: '2026-03-02T03:30:00Z' } } }, { ok: false, code: 'INVALID_TIMESTAMP' }] }],
    });
    await choose();
    click(await screen.findByRole('button', { name: 'Preview revision 2' }));
    const form = screen.getByRole('form', { name: 'Preview revision 2' });
    pick('Sample records (a JSON list, at most 50)', '{"not":"a list"}', form);
    fireEvent.submit(form);
    expect(await within(form).findByRole('alert')).toBeTruthy();
    expect(posts(calls, '/v1/biometric/mappings/m-2/preview')).toHaveLength(0);

    pick('Sample records (a JSON list, at most 50)', '[{"emp":{"code":"E-1"}},{"bad":1}]', form);
    fireEvent.submit(form);
    const results = await within(form).findByRole('list', { name: 'Preview results' });
    expect(posts(calls, '/v1/biometric/mappings/m-2/preview')[0]!.body).toEqual({ records: [{ emp: { code: 'E-1' } }, { bad: 1 }] });
    expect(results.textContent).toContain('E-1 · 2026-03-02T03:30:00Z · IN');
    expect(results.textContent).toContain('Refused: INVALID_TIMESTAMP');
  });
});

describe('employee mapping', () => {
  const LINK: EmployeeLink = { id: 'l-1', externalEmployeeKey: 'DEV-1', employeeId: 'e-1', employeeCode: 'E1', employeeName: 'Asha Synthetic', effectiveFrom: '2026-01-01T00:00:00Z', effectiveTo: null, current: true, version: 4 };
  const ENDED: EmployeeLink = { ...LINK, id: 'l-2', externalEmployeeKey: 'DEV-2', effectiveTo: '2026-02-01T00:00:00Z', current: false, version: 2 };
  const world = (extra: Record<string, Reply | ((c: Call) => Reply)> = {}) =>
    mockApi({
      'GET /v1/biometric/profiles': [200, { items: [PROFILE] }],
      'GET /v1/biometric/profiles/p-1/links': [200, { items: [LINK, ENDED], total: 60, page: 1, pageSize: 25 }],
      'GET /v1/employees': [200, { items: [{ id: 'e-7', employeeCode: 'E7', displayName: 'Ravi Synthetic' }], total: 1 }],
      ...extra,
    });
  const choose = async () => {
    open('/biometric/employee-mapping');
    await screen.findByRole('option', { name: 'GATE · Gate devices' });
    pick('Profile', 'p-1');
    await screen.findByRole('table', { name: 'Employee links' });
  };
  const findAndChoose = async (form: HTMLElement) => {
    pick('Find the employee', 'Ravi', form);
    click(await within(form).findByRole('button', { name: 'Ravi Synthetic (E7)' }));
  };

  it('offers actions only on a link in force, and filters and pages on the server', async () => {
    session.permissions = ['employee.list.operational'];
    const calls = world();
    await choose();
    expect(screen.getByRole('button', { name: 'End DEV-1' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End DEV-2' })).toBeNull();
    pick('Search', 'dev 1');
    click(screen.getByLabelText(/In force now only/));
    await waitFor(() => expect(calls.some((c) => c.url.includes('search=dev%201') && c.url.includes('current=true'))).toBe(true));
    await screen.findByRole('table', { name: 'Employee links' });
    click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(calls.some((c) => c.url.includes('page=2&pageSize=25'))).toBe(true));
  });

  it('adds a link only once an employee is chosen, and explains an overlap', async () => {
    session.permissions = ['employee.list.operational'];
    const calls = world({ 'POST /v1/biometric/profiles/p-1/links': refused('OVERLAPPING_PERIOD') });
    await choose();
    const form = screen.getByRole('form', { name: 'New employee link' });
    expect(within(form).getByRole('button', { name: 'Add link' })).toHaveProperty('disabled', true);
    pick('Device identity', 'DEV-9', form);
    pick('From', '2026-03-01T09:00', form);
    await findAndChoose(form);
    click(within(form).getByRole('button', { name: 'Add link' }));
    await waitFor(() => expect(posts(calls, '/v1/biometric/profiles/p-1/links')).toHaveLength(1));
    expect(posts(calls, '/v1/biometric/profiles/p-1/links')[0]!.body).toEqual({ externalEmployeeKey: 'DEV-9', employeeId: 'e-7', effectiveFrom: new Date('2026-03-01T09:00').toISOString() });
    expect((await within(form.parentElement!).findByRole('alert')).textContent).toContain('overlaps an existing period');
  });

  it('ends a link with a date, a reason and the version it saw', async () => {
    const calls = world({ 'POST /v1/biometric/links/l-1/end': [200, { id: 'l-1' }] });
    await choose();
    click(screen.getByRole('button', { name: 'End DEV-1' }));
    const form = screen.getByRole('form', { name: 'End DEV-1' });
    expect(form.textContent).toContain('Punches already made under this link stay as they are');
    pick('Ends at', '2026-03-01T09:00', form);
    pick('Reason', 'Wrong person', form);
    click(within(form).getByRole('button', { name: 'Confirm end' }));
    await waitFor(() => expect(posts(calls, '/v1/biometric/links/l-1/end')).toHaveLength(1));
    expect(posts(calls, '/v1/biometric/links/l-1/end')[0]!.body).toEqual({ effectiveTo: new Date('2026-03-01T09:00').toISOString(), reason: 'Wrong person', expectedVersion: 4 });
  });

  it('moves an identity to another employee, and says plainly when the role cannot search for one', async () => {
    session.permissions = ['employee.list.operational'];
    const calls = world({ 'POST /v1/biometric/links/l-1/supersede': [201, { id: 'l-9' }] });
    await choose();
    click(screen.getByRole('button', { name: 'Move DEV-1' }));
    const form = screen.getByRole('form', { name: 'Move DEV-1' });
    pick('New employee from', '2026-03-01T09:00', form);
    pick('Reason', 'Device reissued', form);
    expect(within(form).getByRole('button', { name: 'Confirm move' })).toHaveProperty('disabled', true);
    await findAndChoose(form);
    click(within(form).getByRole('button', { name: 'Confirm move' }));
    await waitFor(() => expect(posts(calls, '/v1/biometric/links/l-1/supersede')).toHaveLength(1));
    expect(posts(calls, '/v1/biometric/links/l-1/supersede')[0]!.body).toEqual({ employeeId: 'e-7', effectiveFrom: new Date('2026-03-01T09:00').toISOString(), reason: 'Device reissued', expectedVersion: 4 });

    cleanup();
    session.permissions = [];
    world();
    await choose();
    click(screen.getByRole('button', { name: 'Move DEV-1' }));
    expect(screen.getAllByText('The selected role cannot search employees, so it cannot choose one here.').length).toBeGreaterThan(0);
  });
});

describe('sync monitor', () => {
  const RUN: SyncRun = {
    id: 'r-1',
    profileCode: 'GATE',
    mappingRevision: 2,
    state: 'PARTIAL',
    failureCode: 'LEASE_EXPIRED',
    windowStart: '2026-03-02T00:00:00Z',
    windowEnd: '2026-03-03T00:00:00Z',
    startedAt: '2026-03-03T00:01:00Z',
    finishedAt: '2026-03-03T00:40:00Z',
    pagesCommitted: 2,
    observations: 9,
    accepted: 5,
    duplicates: 2,
    rejected: 1,
    quarantined: 1,
  };
  const row = (extra: Partial<SyncException>): SyncException => ({
    id: 'o-1',
    runId: 'r-1',
    profileCode: 'GATE',
    outcome: 'QUARANTINED',
    failureCode: 'UNKNOWN_EMPLOYEE',
    sourceEventKey: 'k1',
    observedAt: '2026-03-03T00:02:00Z',
    eventId: 'ev-1',
    nextStep: 'REPROCESS',
    evidence: { employeeKey: 'NOBODY', instant: '2026-03-02T03:30:00.000Z', localTime: null, direction: 'IN', deviceId: null },
    kept: null,
    ...extra,
  });
  const ROWS = [
    row({}),
    row({ id: 'o-2', failureCode: 'AMBIGUOUS_LOCAL_TIME', sourceEventKey: 'k2', eventId: 'ev-2', nextStep: 'CORRECT_TIME', evidence: { employeeKey: 'NY-1', instant: null, localTime: '2026-11-01 01:30:00', direction: 'IN', deviceId: null } }),
    row({ id: 'o-3', failureCode: 'CONFLICTING_PAYLOAD', sourceEventKey: 'k3', eventId: 'ev-3', nextStep: 'NONE', kept: { employeeKey: 'E-1', instant: '2026-03-02T03:30:00Z', direction: 'IN' } }),
    row({ id: 'o-4', outcome: 'REJECTED', failureCode: 'INVALID_TIMESTAMP', sourceEventKey: null, eventId: null, nextStep: 'NONE', evidence: null }),
    row({ id: 'o-5', sourceEventKey: 'k5', eventId: 'ev-5', nextStep: 'RESOLVED' }),
  ];
  const world = (extra: Record<string, Reply | ((c: Call) => Reply)> = {}) =>
    mockApi({
      'GET /v1/biometric/profiles': [200, { items: [PROFILE] }],
      'GET /v1/biometric/runs': [200, { items: [RUN], total: 1, page: 1, pageSize: 25 }],
      'GET /v1/biometric/exceptions': [200, { items: ROWS, total: ROWS.length, page: 1, pageSize: 25 }],
      ...extra,
    });

  it('shows runs with reconciled counts and filters on the server; the fetch form needs its own duty', async () => {
    session.permissions = ['biometric.read.operational'];
    const calls = world();
    open('/biometric/sync-monitor');
    const runs = await screen.findByRole('table', { name: 'Runs' });
    const cells = within(runs).getAllByRole('row')[1]!.textContent!;
    expect(cells).toContain('Revision 2');
    expect(cells).toContain('The run stopped responding and was ended');
    expect(screen.queryByRole('form', { name: 'Fetch now' })).toBeNull();
    pick('State', 'FAILED');
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/v1/biometric/runs') && c.url.includes('state=FAILED'))).toBe(true));
    await screen.findByRole('option', { name: 'GATE · Gate devices' });
    pick('Profile', 'p-1');
    await waitFor(() => expect(calls.some((c) => c.url.startsWith('/v1/biometric/exceptions') && c.url.includes('profileId=p-1') && c.url.includes('open=true'))).toBe(true));
  });

  it('offers no action to a reader, and shows a conflict’s two versions with no way to overwrite', async () => {
    session.permissions = ['biometric.read.operational'];
    world();
    open('/biometric/sync-monitor');
    const table = await screen.findByRole('table', { name: 'Rejected and quarantined records' });
    expect(within(table).queryByRole('button')).toBeNull();
    const conflict = within(table).getByText('Same event key, different content').closest('tr')!;
    expect(conflict.textContent).toContain('NOBODY');
    expect(conflict.textContent).toContain('E-1');
    expect(conflict.textContent).toContain('The kept event was not overwritten');
    expect(within(conflict).getByRole('link', { name: 'attendance control' }).getAttribute('href')).toBe('/attendance/control');
    expect(within(table).getByText('2026-11-01 01:30:00', { exact: false })).toBeTruthy();
    expect(within(table).getByText('Since accepted')).toBeTruthy();
  });

  it('reprocesses an unknown identity, explaining when no link covers it yet', async () => {
    session.permissions = ['biometric.read.operational', 'biometric.sync_exception_reprocess.operational'];
    const calls = world({ 'POST /v1/biometric/events/ev-1/reprocess': [422, { error: 'STILL_UNMATCHED', message: 'Server text' }] });
    open('/biometric/sync-monitor');
    click(await screen.findByRole('button', { name: 'Reprocess k1' }));
    await waitFor(() => expect(posts(calls, '/v1/biometric/events/ev-1/reprocess')).toHaveLength(1));
    expect(await screen.findByText('No employee link covers this identity at that time. Add the link in Employee Mapping first.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reprocess k3' })).toBeNull();
  });

  it('corrects an ambiguous time only with a typed instant and a reason, proposing neither', async () => {
    session.permissions = ['biometric.read.operational', 'biometric.sync_exception_reprocess.operational'];
    const calls = world({ 'POST /v1/biometric/events/ev-2/correct': (c) => (String(c.body?.normalisedTime).endsWith('-04:00') ? [422, { error: 'TIME_NOT_THE_SOURCE_READING', message: 'Server text' }] : [200, { state: 'ACCEPTED' }]) });
    open('/biometric/sync-monitor');
    click(await screen.findByRole('button', { name: 'Correct time of k2' }));
    const form = screen.getByRole('form', { name: 'Correct time of k2' });
    const time = within(form).getByLabelText('Time with its UTC offset') as HTMLInputElement;
    expect(time.value).toBe('');
    type(time, '2026-11-01T09:00:00-04:00');
    pick('Reason', 'Read from the device', form);
    click(within(form).getByRole('button', { name: 'Confirm correction' }));
    expect((await within(form).findByRole('alert')).textContent).toContain('must read as the device recorded it');
    type(time, '2026-11-01T01:30:00-05:00');
    click(within(form).getByRole('button', { name: 'Confirm correction' }));
    await waitFor(() => expect(posts(calls, '/v1/biometric/events/ev-2/correct')).toHaveLength(2));
    expect(posts(calls, '/v1/biometric/events/ev-2/correct')[1]!.body).toEqual({ normalisedTime: '2026-11-01T01:30:00-05:00', reason: 'Read from the device' });
  });

  it('starts a manual run with its window and reports the counts; a missing provider is explained', async () => {
    session.permissions = ['biometric.read.operational', 'biometric.sync_run.operational'];
    let provider = false;
    const calls = world({ 'POST /v1/biometric/profiles/p-1/runs': () => (provider ? [200, RUN] : [422, { error: 'PROVIDER_NOT_CONFIGURED', message: 'Server text' }]) });
    open('/biometric/sync-monitor');
    const form = await screen.findByRole('form', { name: 'Fetch now' });
    await within(form).findByRole('option', { name: 'GATE · Gate devices' });
    pick('Profile', 'p-1', form);
    pick('Window from', '2026-03-02T00:00', form);
    pick('Window to', '2026-03-03T00:00', form);
    click(within(form).getByRole('button', { name: 'Start run' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No provider connection is set up');
    provider = true;
    click(within(form).getByRole('button', { name: 'Start run' }));
    expect((await screen.findByRole('status')).textContent).toBe('Run ended PARTIAL: 5 accepted, 2 duplicates, 1 quarantined, 1 rejected.');
    expect(posts(calls, '/v1/biometric/profiles/p-1/runs')[0]!.body).toEqual({ windowStart: new Date('2026-03-02T00:00').toISOString(), windowEnd: new Date('2026-03-03T00:00').toISOString() });
  });
});
