// Organisation masters (jsdom; FR-004; BR-004; I-55): duties decide what is offered, every change names the version on screen and
// only what changed, the server's refusals read in plain words beside what was typed, and the client adds no rule of its own (a
// reversed period is sent, and the server refuses it). Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Company, type Master, ORG_SCREENS } from './org';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

const READ = 'org_master.read.operational';
const CREATE = 'org_master.create.operational';
const UPDATE = 'org_master.update.operational';

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
  const Page = ORG_SCREENS.find((s) => s.path === path)!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Page />
    </QueryClientProvider>,
  );
};
const click = (el: HTMLElement) => fireEvent.click(el);
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const inputOf = (el: HTMLElement) => el as HTMLInputElement;
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');
const alertText = async () => (await screen.findByRole('alert')).textContent;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

const DEPT: Master = { id: 'd-1', code: 'ENG', name: 'Engineering', active: true, validFrom: '2026-01-01', validTo: null, version: 4 };
const OLD: Master = { id: 'd-2', code: 'OLD', name: 'Old department', active: false, validFrom: null, validTo: '2025-07-01', version: 2 };
const LIST = 'GET /v1/org/departments';
const ITEM = 'PATCH /v1/org/departments/d-1';

describe('screens', () => {
  it('are five menu screens, each under the read duty its route checks', () => {
    expect(ORG_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([
      ['/organisation/company', 'Company', READ, true],
      ['/organisation/departments', 'Departments', READ, true],
      ['/organisation/locations', 'Locations', READ, true],
      ['/organisation/designations', 'Designations', READ, true],
      ['/organisation/grades', 'Grades', READ, true],
    ]);
  });

  it.each([
    ['/organisation/departments', 'departments', 'Departments', 'New department'],
    ['/organisation/locations', 'locations', 'Locations', 'New location'],
    ['/organisation/designations', 'designations', 'Designations', 'New designation'],
    ['/organisation/grades', 'grades', 'Grades', 'New grade'],
  ])('%s reads and writes its own master', async (path, kind, title, form) => {
    session.permissions = [READ, CREATE];
    const calls = mockApi({ [`GET /v1/org/${kind}`]: [200, { items: [{ ...DEPT, id: `${kind}-1` }] }], [`POST /v1/org/${kind}`]: [201, { ...DEPT, code: 'NEW1' }] });
    open(path);
    expect(within(await screen.findByRole('table', { name: title })).getByText('Engineering')).toBeTruthy();
    const create = screen.getByRole('form', { name: form });
    type(within(create).getByLabelText('Code'), 'NEW1');
    type(within(create).getByLabelText('Name'), 'Synthetic');
    click(within(create).getByRole('button', { name: /^Create/ }));
    await screen.findByText('NEW1 created.');
    expect(writes(calls).map((c) => [c.method, c.url])).toEqual([['POST', `/v1/org/${kind}`]]);
  });
});

describe('the list (FR-004)', () => {
  it('shows code, name, period and state; a role that only reads is offered no change', async () => {
    session.permissions = [READ];
    mockApi({ [LIST]: [200, { items: [DEPT] }] });
    open('/organisation/departments');
    const row = within(await screen.findByRole('table', { name: 'Departments' })).getByText('ENG').closest('tr')!;
    expect(within(row).getAllByRole('cell').slice(0, 5).map((c) => c.textContent)).toEqual(['ENG', 'Engineering', '2026-01-01', '—', 'active']);
    expect(within(row).queryByRole('button')).toBeNull();
    expect(screen.queryByRole('form', { name: 'New department' })).toBeNull();
  });

  it('asks for inactive masters only when told to, and they read as inactive', async () => {
    session.permissions = [READ];
    const calls = mockApi({ 'GET /v1/org/departments?includeInactive=true': [200, { items: [DEPT, OLD] }], [LIST]: [200, { items: [DEPT] }] });
    open('/organisation/departments');
    await screen.findByText('ENG');
    expect(screen.queryByText('OLD')).toBeNull();
    expect(calls.at(-1)!.url).toBe('/v1/org/departments');
    click(screen.getByLabelText('Show inactive'));
    const row = (await screen.findByText('OLD')).closest('tr')!;
    expect(within(row).getByText('inactive')).toBeTruthy();
    expect(within(row).getAllByRole('cell')[3]!.textContent).toBe('2025-07-01');
  });

  it('says so when there are none, and reads a list it may not read in the server’s words', async () => {
    session.permissions = [READ];
    mockApi({ [LIST]: [200, { items: [] }] });
    open('/organisation/departments');
    expect(await screen.findByText('No department to show.')).toBeTruthy();
    cleanup();
    mockApi({ [LIST]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    open('/organisation/departments');
    expect(await alertText()).toContain('Not permitted');
  });
});

describe('creating a master', () => {
  const form = () => screen.getByRole('form', { name: 'New department' });
  const fill = (values: { code: string; name: string; from?: string; to?: string }) => {
    type(within(form()).getByLabelText('Code'), values.code);
    type(within(form()).getByLabelText('Name'), values.name);
    if (values.from) type(within(form()).getByLabelText('From'), values.from);
    if (values.to) type(within(form()).getByLabelText('Until (not included)'), values.to);
  };

  it('sends what was typed, trimmed, without blank dates, then clears the form and reads the list again', async () => {
    session.permissions = [READ, CREATE];
    const calls = mockApi({ [LIST]: [200, { items: [DEPT] }], 'POST /v1/org/departments': [201, { ...DEPT, code: 'OPS' }] });
    open('/organisation/departments');
    await screen.findByText('ENG');
    fill({ code: ' ops ', name: ' Operations ', from: '2026-02-01' });
    const before = calls.filter((c) => c.method === 'GET').length;
    click(within(form()).getByRole('button', { name: 'Create department' }));
    expect(await screen.findByText('OPS created.')).toBeTruthy();
    expect(writes(calls)[0]!.body).toEqual({ code: 'ops', name: 'Operations', validFrom: '2026-02-01' });
    expect(inputOf(within(form()).getByLabelText('Code')).value).toBe('');
    await waitFor(() => expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(before));
  });

  it('sends a reversed period as typed: the server decides, its refusal reads in plain words, and what was typed stays', async () => {
    session.permissions = [READ, CREATE];
    const calls = mockApi({ [LIST]: [200, { items: [] }], 'POST /v1/org/departments': [422, { error: 'INVALID_PERIOD', message: 'A master must end after it starts' }] });
    open('/organisation/departments');
    await screen.findByText('No department to show.');
    fill({ code: 'OPS', name: 'Operations', from: '2026-07-01', to: '2026-06-01' });
    click(within(form()).getByRole('button', { name: 'Create department' }));
    expect(await alertText()).toBe('The end of the period must be after its start.');
    expect(writes(calls)[0]!.body).toEqual({ code: 'OPS', name: 'Operations', validFrom: '2026-07-01', validTo: '2026-06-01' });
    expect(inputOf(within(form()).getByLabelText('Code')).value).toBe('OPS');
    expect(inputOf(within(form()).getByLabelText('Until (not included)')).value).toBe('2026-06-01');
  });

  it.each([
    ['DUPLICATE', 409, 'Another department, active or inactive, already has this code.'],
    ['INVALID_REQUEST', 400, /A code starts with a letter or digit/],
    ['FORBIDDEN', 403, /company-wide scope/],
  ])('%s reads in plain words and keeps what was typed', async (code, status, words) => {
    session.permissions = [READ, CREATE];
    mockApi({ [LIST]: [200, { items: [] }], 'POST /v1/org/departments': [status as number, { error: code, message: 'raw server message' }] });
    open('/organisation/departments');
    await screen.findByText('No department to show.');
    fill({ code: '*bad*', name: 'Operations' });
    click(within(form()).getByRole('button', { name: 'Create department' }));
    const text = await alertText();
    expect(text).toMatch(words as string | RegExp);
    expect(text).not.toContain('raw server message');
    expect(inputOf(within(form()).getByLabelText('Code')).value).toBe('*bad*');
  });

  it('a refusal without plain words shows the server’s own', async () => {
    session.permissions = [READ, CREATE];
    mockApi({ [LIST]: [200, { items: [] }], 'POST /v1/org/departments': [422, { error: 'SOME_NEW_RULE', message: 'Readable server text' }] });
    open('/organisation/departments');
    await screen.findByText('No department to show.');
    fill({ code: 'OPS', name: 'Operations' });
    click(within(form()).getByRole('button', { name: 'Create department' }));
    expect(await alertText()).toContain('Readable server text');
  });
});

describe('changing a master', () => {
  const start = async (routes: Record<string, Reply | ((c: Call) => Reply)>) => {
    session.permissions = [READ, UPDATE];
    const calls = mockApi({ [LIST]: [200, { items: [DEPT] }], ...routes });
    open('/organisation/departments');
    click(await screen.findByRole('button', { name: 'Edit ENG' }));
    return { calls, form: screen.getByRole('form', { name: 'Edit ENG' }) };
  };

  it('sends the version on screen and only what changed; an emptied date clears it', async () => {
    const { calls, form } = await start({ [ITEM]: [200, { ...DEPT, validFrom: null, name: 'Eng', version: 5 }] });
    type(within(form).getByLabelText('Name'), ' Eng ');
    type(within(form).getByLabelText('From'), '');
    click(within(form).getByRole('button', { name: 'Save ENG' }));
    expect(await screen.findByText('ENG saved.')).toBeTruthy();
    expect(writes(calls)).toEqual([{ method: 'PATCH', url: '/v1/org/departments/d-1', body: { expectedVersion: 4, name: 'Eng', validFrom: null } }]);
    expect(screen.queryByRole('form', { name: 'Edit ENG' })).toBeNull();
  });

  it('closing a period sends only the end date', async () => {
    const { calls, form } = await start({ [ITEM]: [200, { ...DEPT, validTo: '2026-12-01', version: 5 }] });
    type(within(form).getByLabelText('Until (not included)'), '2026-12-01');
    click(within(form).getByRole('button', { name: 'Save ENG' }));
    await screen.findByText('ENG saved.');
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 4, validTo: '2026-12-01' });
  });

  it('saving nothing asks nothing of the server', async () => {
    const { calls, form } = await start({});
    click(within(form).getByRole('button', { name: 'Save ENG' }));
    expect(await screen.findByText('Nothing changed.')).toBeTruthy();
    expect(writes(calls)).toEqual([]);
  });

  it('a period that would strand a live assignment reads MASTER_IN_USE in plain words, with the count, and keeps what was typed', async () => {
    const { form } = await start({ [ITEM]: [409, { error: 'MASTER_IN_USE', message: 'Move the 3 assignment(s) on this department first', details: { assignments: 3 } }] });
    type(within(form).getByLabelText('Until (not included)'), '2026-12-01');
    click(within(form).getByRole('button', { name: 'Save ENG' }));
    expect(await alertText()).toBe('This department is still in use: 3 employee assignments would fall outside it. Move them to another department first. Nothing was changed.');
    expect(inputOf(within(form).getByLabelText('Until (not included)')).value).toBe('2026-12-01');
    expect(screen.queryByText('ENG saved.')).toBeNull();
  });

  it('a stale version reloads the list and keeps what was typed; the next save goes against the version now shown', async () => {
    let current = DEPT;
    const { calls, form } = await start({
      [LIST]: () => [200, { items: [current] }],
      [ITEM]: (c) => {
        if (c.body!.expectedVersion !== 4) return [200, { ...DEPT, name: 'Typed here', version: 10 }];
        current = { ...DEPT, name: 'Renamed elsewhere', version: 9 };
        return [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }];
      },
    });
    type(within(form).getByLabelText('Name'), 'Typed here');
    click(within(form).getByRole('button', { name: 'Save ENG' }));
    expect(await alertText()).toContain('It has been reloaded');
    // The row shows the record as it now stands; the form still holds what was typed.
    expect(await screen.findByText('Renamed elsewhere')).toBeTruthy();
    expect(inputOf(within(form).getByLabelText('Name')).value).toBe('Typed here');
    click(within(form).getByRole('button', { name: 'Save ENG' }));
    expect(await screen.findByText('ENG saved.')).toBeTruthy();
    expect(writes(calls).at(-1)!.body).toEqual({ expectedVersion: 9, name: 'Typed here' });
  });

  it('a stale version on deactivation reads the same and reloads', async () => {
    session.permissions = [READ, UPDATE];
    const calls = mockApi({ [LIST]: [200, { items: [DEPT] }], [ITEM]: [409, { error: 'STALE_VERSION', message: 'x' }] });
    open('/organisation/departments');
    click(await screen.findByRole('button', { name: 'Deactivate ENG' }));
    expect(await alertText()).toContain('It has been reloaded');
    await waitFor(() => expect(gets(calls)).toBeGreaterThan(1));
  });

  it('deactivating sends the version and says what happened; one in use is refused in plain words and stays active', async () => {
    session.permissions = [READ, UPDATE];
    let calls = mockApi({ [LIST]: [200, { items: [DEPT] }], [ITEM]: [200, { ...DEPT, active: false, version: 5 }] });
    open('/organisation/departments');
    click(await screen.findByRole('button', { name: 'Deactivate ENG' }));
    expect(await screen.findByText('ENG deactivated.')).toBeTruthy();
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 4, active: false });
    cleanup();

    calls = mockApi({ [LIST]: [200, { items: [DEPT] }], [ITEM]: [409, { error: 'MASTER_IN_USE', message: 'x', details: { assignments: 1 } }] });
    open('/organisation/departments');
    click(await screen.findByRole('button', { name: 'Deactivate ENG' }));
    expect(await alertText()).toBe('This department is still in use: 1 employee assignment would fall outside it. Move them to another department first. Nothing was changed.');
    expect(within(screen.getByText('ENG').closest('tr')!).getByText('active')).toBeTruthy();
  });

  it('an inactive master is offered reactivation, not deactivation', async () => {
    session.permissions = [READ, UPDATE];
    const calls = mockApi({ 'GET /v1/org/departments?includeInactive=true': [200, { items: [OLD] }], [LIST]: [200, { items: [] }], 'PATCH /v1/org/departments/d-2': [200, { ...OLD, active: true, version: 3 }] });
    open('/organisation/departments');
    await screen.findByText('No department to show.');
    click(screen.getByLabelText('Show inactive'));
    click(await screen.findByRole('button', { name: 'Reactivate OLD' }));
    expect(screen.queryByRole('button', { name: 'Deactivate OLD' })).toBeNull();
    expect(await screen.findByText('OLD reactivated.')).toBeTruthy();
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 2, active: true });
  });
});

const gets = (calls: Call[]) => calls.filter((c) => c.method === 'GET').length;

describe('the company (FR-004, DB001, DF05)', () => {
  const COMPANY: Company = { id: 'c-1', code: 'SYN', name: 'Synthetic Co', businessTimezone: 'Asia/Kolkata', active: true, version: 3 };
  const READ_COMPANY = 'GET /v1/org/company';
  const PATCH_COMPANY = 'PATCH /v1/org/company';
  const openCompany = async (permissions: string[], routes: Record<string, Reply | ((c: Call) => Reply)> = {}) => {
    session.permissions = permissions;
    const calls = mockApi({ [READ_COMPANY]: [200, COMPANY], ...routes });
    open('/organisation/company');
    await screen.findByText('Synthetic Co');
    return calls;
  };
  const form = () => screen.getByRole('form', { name: 'Edit company' });

  it('reads the code, name, timezone and state, and offers no change without the update duty', async () => {
    const calls = await openCompany([READ]);
    expect(screen.getByText('SYN')).toBeTruthy();
    expect(screen.getByText('Asia/Kolkata')).toBeTruthy();
    expect(screen.getByText('active')).toBeTruthy();
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(calls.map((c) => c.url)).toEqual(['/v1/org/company']);
  });

  it('the code is never offered for editing, and a role that cannot read is told so', async () => {
    await openCompany([READ, UPDATE]);
    expect(within(form()).queryByLabelText('Code')).toBeNull();
    expect(within(form()).getAllByRole('textbox').map((e) => inputOf(e).value)).toEqual(['Synthetic Co', 'Asia/Kolkata']);
    cleanup();

    session.permissions = [READ];
    mockApi({ [READ_COMPANY]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    open('/organisation/company');
    expect(await alertText()).toContain('Not permitted');
  });

  it('sends the version and only what changed, trimmed, then reads the company again', async () => {
    const calls = await openCompany([READ, UPDATE], { [PATCH_COMPANY]: [200, { ...COMPANY, name: 'Renamed Co', version: 4 }] });
    type(within(form()).getByLabelText('Name'), '  Renamed Co ');
    click(within(form()).getByRole('button', { name: 'Save company' }));
    expect(await screen.findByText('Company saved.')).toBeTruthy();
    expect(writes(calls)[0]).toMatchObject({ url: '/v1/org/company', body: { expectedVersion: 3, name: 'Renamed Co' } });
    expect(writes(calls)[0]!.body).not.toHaveProperty('businessTimezone');
    await waitFor(() => expect(gets(calls)).toBe(2));
  });

  it('saving nothing asks nothing of the server, and the client adds no rule of its own', async () => {
    const calls = await openCompany([READ, UPDATE], { [PATCH_COMPANY]: [422, { error: 'INVALID_TIMEZONE', message: 'x' }] });
    click(within(form()).getByRole('button', { name: 'Save company' }));
    expect(await screen.findByText('Nothing changed.')).toBeTruthy();
    expect(writes(calls)).toEqual([]);

    // Whether a timezone exists is the server's to say; what was typed stays.
    type(within(form()).getByLabelText('Business timezone'), 'Mars/Olympus');
    click(within(form()).getByRole('button', { name: 'Save company' }));
    expect(await alertText()).toBe('That is not a timezone the server knows. Use a name such as Asia/Kolkata.');
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 3, businessTimezone: 'Mars/Olympus' });
    expect(inputOf(within(form()).getByLabelText('Business timezone')).value).toBe('Mars/Olympus');
    expect(screen.queryByText('Nothing changed.')).toBeNull();
  });

  it('a stale version reloads the company and keeps what was typed; the next save goes against the version now shown', async () => {
    let reads = 0;
    const calls = await openCompany([READ, UPDATE], {
      [READ_COMPANY]: () => [200, { ...COMPANY, version: reads++ === 0 ? 3 : 9 }],
      [PATCH_COMPANY]: (c) => (c.body!.expectedVersion === 3 ? [409, { error: 'STALE_VERSION', message: 'x' }] : [200, { ...COMPANY, name: 'Renamed Co', version: 10 }]),
    });
    type(within(form()).getByLabelText('Name'), 'Renamed Co');
    click(within(form()).getByRole('button', { name: 'Save company' }));
    expect(await alertText()).toContain('This company changed since you opened it');
    await waitFor(() => expect(gets(calls)).toBe(2));
    expect(inputOf(within(form()).getByLabelText('Name')).value).toBe('Renamed Co');
    click(within(form()).getByRole('button', { name: 'Save company' }));
    await screen.findByText('Company saved.');
    expect(writes(calls)[1]!.body).toEqual({ expectedVersion: 9, name: 'Renamed Co' });
  });

  it('an administrator with a filter is told why the server refused', async () => {
    await openCompany([READ, UPDATE], { [PATCH_COMPANY]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] });
    type(within(form()).getByLabelText('Name'), 'Renamed Co');
    click(within(form()).getByRole('button', { name: 'Save company' }));
    expect(await alertText()).toContain('company-wide scope and no department, location or employee filter');
  });

  it('deactivating is asked twice; a company in use says what is left and stays as it was', async () => {
    const calls = await openCompany([READ, UPDATE], { [PATCH_COMPANY]: [409, { error: 'COMPANY_IN_USE', message: 'x', details: { employees: 2, roleAssignments: 1 } }] });
    click(screen.getByRole('button', { name: 'Deactivate SYN' }));
    expect(writes(calls)).toEqual([]);
    click(screen.getByRole('button', { name: 'Keep it active' }));
    expect(writes(calls)).toEqual([]);
    click(screen.getByRole('button', { name: 'Deactivate SYN' }));
    click(screen.getByRole('button', { name: 'Confirm deactivating SYN' }));
    expect(await alertText()).toBe('This company is still in use: 2 employed and 1 other role assignments. End them first. Nothing was changed.');
    expect(writes(calls)[0]!.body).toEqual({ expectedVersion: 3, active: false });
    expect(screen.getByText('active')).toBeTruthy();
  });

  it('once deactivated it says so and stops asking, because nobody can read the company any more', async () => {
    const calls = await openCompany([READ, UPDATE], { [PATCH_COMPANY]: [200, { ...COMPANY, active: false, version: 4 }] });
    click(screen.getByRole('button', { name: 'Deactivate SYN' }));
    click(screen.getByRole('button', { name: 'Confirm deactivating SYN' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('has been deactivated');
    expect(screen.queryByRole('form')).toBeNull();
    expect(gets(calls)).toBe(1);
  });
});
