// Assets screens (FR-110 assets part; H3 TN16; I-31; DF02; DF03; C4), jsdom: the register (filters, new items in stock,
// corrections, retirement), issue and return with the custody history, an employee's items, the custody-request
// decision queue (approve, or reject with a note; approval never issues anything) and My ESS TN16 in the Employee OWN
// context (own items, acknowledgment once per issue, custody requests and their decision history; no issue, return,
// retire, transfer or write-off for the employee). Controls are hidden without their permission keys, refusals are said
// in plain words, values the API leaves out are not shown, and each action carries one idempotency key. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASSETS_ESS_PANELS, ASSETS_SCREENS, ASSETS_TASK_QUEUES } from './assets';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  companyId: 'c0000000-0000-4000-8000-000000000001',
  assignmentId: 'a0000000-0000-4000-8000-000000000001',
  userId: 'b0000000-0000-4000-8000-000000000001',
  employeeId: '20000000-0000-4000-8000-000000000001' as string | null,
  roleCode: 'HR_ADMINISTRATOR',
  scopeKind: 'COMPANY',
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: session.companyId, assignmentId: session.assignmentId },
    me: {
      userId: session.userId,
      accountKey: 'syn.asha',
      companyName: 'Synthetic Co',
      roleCode: session.roleCode,
      roleName: session.roleCode,
      scopeKind: session.scopeKind,
      employeeId: session.employeeId,
      displayName: 'Asha Synthetic',
    },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const READ = 'asset.read.operational';
const MANAGE = 'asset.manage.operational';
const CUSTODY = 'asset.custody.operational';
const ACKNOWLEDGE = 'asset.acknowledge.operational';
const SUBMIT = 'asset_request.submit.operational';
const REQUEST_READ = 'asset_request.read.operational';
const DECIDE = 'asset_request.decide.operational';
const EMPLOYEE_LIST = 'employee.list.operational';
const ADMIN = [READ, MANAGE, CUSTODY, REQUEST_READ, DECIDE, EMPLOYEE_LIST];
const EMPLOYEE = [READ, ACKNOWLEDGE, SUBMIT, REQUEST_READ];

const ASSIGNMENT_A = 'a0000000-0000-4000-8000-000000000001';
const ASSIGNMENT_B = 'a0000000-0000-4000-8000-000000000002';
const ASHA = { id: session.employeeId!, employeeCode: 'SYN-001', displayName: 'Asha Synthetic', status: 'ACTIVE_CONFIRMED' };
const RAVI = { id: '20000000-0000-4000-8000-000000000002', employeeCode: 'SYN-002', displayName: 'Ravi Synthetic', status: 'ACTIVE_CONFIRMED' };
const MEERA = { id: '20000000-0000-4000-8000-000000000003', employeeCode: 'SYN-003', displayName: 'Meera Synthetic', status: 'ACTIVE_PROBATION' };
const A_STOCK = '30000000-0000-4000-8000-000000000001';
const A_ISSUED = '30000000-0000-4000-8000-000000000002';
const A_RETIRED = '30000000-0000-4000-8000-000000000003';
const A_OWN = '30000000-0000-4000-8000-000000000004';
const K_RAVI = '40000000-0000-4000-8000-000000000001';
const K_OLD = '40000000-0000-4000-8000-000000000002';
const K_OWN = '40000000-0000-4000-8000-000000000003';
const R_APPROVED = '50000000-0000-4000-8000-000000000001';
const R_WAITING = '50000000-0000-4000-8000-000000000002';
const R_OWN_WAITING = '50000000-0000-4000-8000-000000000003';
const R_OWN_REJECTED = '50000000-0000-4000-8000-000000000004';
const R_OWN_DONE = '50000000-0000-4000-8000-000000000005';
const R_RAVI_SUBMITTED = '50000000-0000-4000-8000-000000000006';
const T_MEERA = '60000000-0000-4000-8000-000000000001';
const T_HIDDEN = '60000000-0000-4000-8000-000000000002';
const AT = '2026-10-20T09:00:00.000Z';
const TODAY = '2026-10-28';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;
interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: Obj | undefined;
}
type RouteReply = [number, unknown] | ((call: Call) => [number, unknown] | undefined);

const GENERAL = { code: 'GENERAL', label: 'General item' };
const LAPTOP = { code: 'LAPTOP', label: 'Laptop' };
const asset = (id: string, code: string, state: string, patch: Obj = {}): Obj => ({
  id,
  assetCode: code,
  category: LAPTOP,
  description: `Synthetic ${code}`,
  identifier: null,
  state,
  retiredOn: null,
  retirementNote: null,
  holder: null,
  createdAt: AT,
  updatedAt: AT,
  version: 3,
  ...patch,
});
const custody = (id: string, assetRow: Obj, who: Obj, patch: Obj = {}): Obj => ({
  custodyId: id,
  assetId: assetRow.id,
  employeeId: who.id,
  issuedOn: '2026-10-01',
  issueCondition: 'Good working order (synthetic)',
  acknowledgedAt: null,
  returnedOn: null,
  returnCondition: null,
  requestId: null,
  status: 'HELD',
  employeeCode: who.employeeCode,
  employeeName: who.displayName,
  assetCode: assetRow.assetCode,
  category: assetRow.category,
  description: assetRow.description,
  identifier: assetRow.identifier,
  ...patch,
});
const request = (id: string, who: Obj, state: string, patch: Obj = {}): Obj => ({
  id,
  employeeId: who.id,
  employeeCode: who.employeeCode,
  employeeName: who.displayName,
  category: LAPTOP,
  itemDescription: null,
  reason: 'Synthetic project work',
  state,
  submittedAt: AT,
  decidedAt: state === 'SUBMITTED' || state === 'WITHDRAWN' ? null : '2026-10-21T10:00:00.000Z',
  version: 1,
  pendingWith: state === 'SUBMITTED' ? 'Hema Synthetic' : null,
  decisions: state === 'APPROVED' ? [{ decision: 'APPROVE', decidedAt: '2026-10-21T10:00:00.000Z' }] : state === 'REJECTED' ? [{ decision: 'REJECT', decidedAt: '2026-10-21T10:00:00.000Z' }] : [],
  fulfilment: null,
  ...patch,
});

let db: { assets: Map<string, Obj>; custody: Obj[]; requests: Obj[]; tasks: Obj[] };
let calls: Call[] = [];
let holds = new Map<string, Promise<void>>();
let lost = new Set<string>();

function seed() {
  const stock = asset(A_STOCK, 'LAP-0001', 'IN_STOCK', { identifier: 'SN-0001' });
  const issued = asset(A_ISSUED, 'DOCK-0002', 'ISSUED', { category: GENERAL });
  const retired = asset(A_RETIRED, 'OLD-0003', 'RETIRED', { retiredOn: '2026-09-30', retirementNote: 'Beyond repair (synthetic)' });
  const own = asset(A_OWN, 'MON-0004', 'ISSUED', { category: GENERAL });
  const kRavi = custody(K_RAVI, issued, RAVI);
  const kOwn = custody(K_OWN, own, ASHA, { requestId: R_OWN_DONE });
  const kOld = custody(K_OLD, stock, ASHA, { issuedOn: '2026-06-01', acknowledgedAt: '2026-06-01T08:00:00.000Z', returnedOn: '2026-09-01', returnCondition: 'Returned in good order (synthetic)', status: 'RETURNED' });
  issued.holder = { custodyId: K_RAVI, employeeId: RAVI.id, employeeCode: RAVI.employeeCode, employeeName: RAVI.displayName, issuedOn: '2026-10-01', acknowledgedAt: null };
  own.holder = { custodyId: K_OWN, employeeId: ASHA.id, employeeCode: ASHA.employeeCode, employeeName: ASHA.displayName, issuedOn: '2026-10-01', acknowledgedAt: null };
  db = {
    assets: new Map([
      [A_STOCK, stock],
      [A_ISSUED, issued],
      [A_RETIRED, retired],
      [A_OWN, own],
    ]),
    custody: [kRavi, kOwn, kOld],
    requests: [
      request(R_APPROVED, RAVI, 'APPROVED', { itemDescription: 'Synthetic docking station' }),
      request(R_RAVI_SUBMITTED, RAVI, 'SUBMITTED', { itemDescription: 'Synthetic headset' }),
      request(R_WAITING, MEERA, 'SUBMITTED', { reason: 'Synthetic hot-desk setup' }),
      request(R_OWN_WAITING, ASHA, 'SUBMITTED', { category: GENERAL, itemDescription: 'Synthetic keyboard' }),
      request(R_OWN_REJECTED, ASHA, 'REJECTED'),
      request(R_OWN_DONE, ASHA, 'APPROVED', { category: GENERAL, fulfilment: { custodyId: K_OWN, assetId: A_OWN, assetCode: 'MON-0004', issuedOn: '2026-10-01' } }),
    ],
    tasks: [
      {
        taskId: T_MEERA,
        transactionId: '70000000-0000-4000-8000-000000000001',
        ownerEmployeeId: MEERA.id,
        ownerEmployeeCode: MEERA.employeeCode,
        ownerName: MEERA.displayName,
        assignedAt: AT,
        step: 1,
        request: { ...request(R_WAITING, MEERA, 'SUBMITTED', { reason: 'Synthetic hot-desk setup' }), currentlyHeld: [{ assetCode: 'PHN-0009', category: 'General item', description: 'Synthetic phone', issuedOn: '2026-08-01' }] },
      },
    ],
  };
}

const detail = (id: string) => ({ ...db.assets.get(id)!, custody: db.custody.filter((k) => k.assetId === id) });

function fakeApi(call: Call): [number, unknown] {
  const { method, path, body } = call;
  const m = (re: RegExp) => re.exec(path);
  if (method === 'GET' && (path === '/v1/asset-categories' || path === '/v1/me/asset-categories')) return [200, { items: [GENERAL, LAPTOP] }];
  if (method === 'GET' && path === '/v1/assets') {
    const state = call.params.get('state');
    const items = [...db.assets.values()].filter((a) => !state || a.state === state);
    return [200, { items, total: items.length, page: Number(call.params.get('page')), pageSize: Number(call.params.get('pageSize')) }];
  }
  if (method === 'POST' && path === '/v1/assets') {
    const created = asset('30000000-0000-4000-8000-000000000099', String(body!.assetCode).toUpperCase(), 'IN_STOCK', { category: LAPTOP, description: body!.description, identifier: body!.identifier ?? null, version: 1 });
    db.assets.set(created.id, created);
    return [201, created];
  }
  let hit = m(/^\/v1\/assets\/([^/]+)$/);
  if (hit && method === 'GET') return db.assets.has(hit[1]!) ? [200, detail(hit[1]!)] : [404, { error: 'NOT_FOUND', message: 'Not found' }];
  if (hit && method === 'PATCH') {
    const a = db.assets.get(hit[1]!)!;
    const { expectedVersion: _v, ...changes } = body!;
    Object.assign(a, changes, { version: a.version + 1 });
    return [200, a];
  }
  hit = m(/^\/v1\/assets\/([^/]+)\/(issue|return|retire)$/);
  if (hit && method === 'POST') {
    const a = db.assets.get(hit[1]!)!;
    if (hit[2] === 'retire') {
      Object.assign(a, { state: 'RETIRED', retiredOn: body!.retiredOn ?? TODAY, retirementNote: body!.note, version: a.version + 1 });
      return [200, a];
    }
    if (hit[2] === 'issue') {
      const who = [ASHA, RAVI, MEERA].find((e) => e.id === body!.employeeId)!;
      const k = custody('40000000-0000-4000-8000-000000000099', a, who, { issuedOn: body!.issuedOn ?? TODAY, issueCondition: body!.condition });
      db.custody.unshift(k);
      Object.assign(a, { state: 'ISSUED', holder: { custodyId: k.custodyId, employeeId: who.id, employeeCode: who.employeeCode, employeeName: who.displayName, issuedOn: k.issuedOn, acknowledgedAt: null }, version: a.version + 1 });
      return [201, { custodyId: k.custodyId, assetId: a.id, employeeId: who.id, issuedOn: k.issuedOn, state: 'ISSUED', replayed: false }];
    }
    const k = db.custody.find((x) => x.assetId === a.id && x.status === 'HELD')!;
    Object.assign(k, { status: 'RETURNED', returnedOn: body!.returnedOn ?? TODAY, returnCondition: body!.condition });
    Object.assign(a, { state: 'RETURNED_TO_STOCK', holder: null, version: a.version + 1 });
    return [200, { custodyId: k.custodyId, assetId: a.id, employeeId: k.employeeId, returnedOn: k.returnedOn, state: 'RETURNED_TO_STOCK', replayed: false }];
  }
  if (method === 'GET' && path === '/v1/employees') return [200, { items: [RAVI], total: 1 }];
  hit = m(/^\/v1\/employees\/([^/]+)\/assets$/);
  if (hit && method === 'GET') {
    const status = call.params.get('status');
    const employee = hit[1] === ASHA.id ? { id: ASHA.id, employeeCode: ASHA.employeeCode, employeeName: ASHA.displayName } : undefined;
    return [200, { employee, items: db.custody.filter((k) => k.employeeId === hit![1] && (!status || k.status === status)).map(({ employeeCode: _c, employeeName: _n, ...k }) => k) }];
  }
  hit = m(/^\/v1\/employees\/([^/]+)\/asset-requests$/);
  if (hit && method === 'GET') return [200, { items: db.requests.filter((r) => r.employeeId === hit![1]) }];
  if (method === 'POST' && path === '/v1/me/asset-acknowledgments') {
    const k = db.custody.find((x) => x.custodyId === body!.custodyId)!;
    k.acknowledgedAt = '2026-10-28T06:30:00.000Z';
    return [201, { custodyId: k.custodyId, acknowledgedAt: k.acknowledgedAt, replayed: false }];
  }
  if (method === 'POST' && path === '/v1/me/asset-requests') {
    db.requests.unshift(request('50000000-0000-4000-8000-000000000099', ASHA, 'SUBMITTED', { category: LAPTOP, itemDescription: body!.itemDescription ?? null, reason: body!.reason }));
    return [201, { requestId: '50000000-0000-4000-8000-000000000099', state: 'SUBMITTED', replayed: false }];
  }
  hit = m(/^\/v1\/me\/asset-requests\/([^/]+)\/withdraw$/);
  if (hit && method === 'POST') {
    const r = db.requests.find((x) => x.id === hit![1])!;
    Object.assign(r, { state: 'WITHDRAWN', pendingWith: null });
    return [200, { requestId: r.id, state: 'WITHDRAWN' }];
  }
  if (method === 'GET' && path === '/v1/asset-requests') {
    const state = call.params.get('state');
    const unfulfilled = call.params.get('unfulfilled') === 'true';
    const items = db.requests.filter((r) => (!state || r.state === state) && (!unfulfilled || (r.state === 'APPROVED' && r.fulfilment === null)));
    return [200, { items, total: items.length, page: 1, pageSize: 25 }];
  }
  if (method === 'GET' && path === '/v1/asset-requests/tasks/mine') return [200, { items: db.tasks }];
  hit = m(/^\/v1\/asset-requests\/tasks\/([^/]+)\/decision$/);
  if (hit && method === 'POST') {
    const t = db.tasks.find((x) => x.taskId === hit![1])!;
    db.tasks = db.tasks.filter((x) => x !== t);
    return [200, { requestId: t.request.id, state: body!.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED', replayed: false }];
  }
  return [404, { error: 'NOT_FOUND', message: `No mock for ${method} ${path}` }];
}

function serve(overrides: Record<string, RouteReply> = {}) {
  seed();
  calls = [];
  holds = new Map();
  lost = new Set();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const key = `${call.method} ${call.path}`;
      const held = holds.get(key);
      if (held) await held;
      if (lost.delete(key)) throw new TypeError('Failed to fetch');
      const route = overrides[key];
      const reply = (route === undefined ? undefined : typeof route === 'function' ? route(call) : route) ?? fakeApi(call);
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}

function hold(key: string): () => void {
  let release = () => {};
  holds.set(
    key,
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  return () => {
    holds.delete(key);
    release();
  };
}

/** Refuses the first `times` calls with the given answer, then lets the fake API answer. */
function refuseFirst(times: number, status: number, error: string, message = error): RouteReply {
  let left = times;
  return () => (left-- > 0 ? [status, { error, message }] : undefined);
}

const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodiesTo = (method: string, path: string) => callsTo(method, path).map((c) => c.body);
const testClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

function selectContext(permissions: string[], own = false, assignmentId = ASSIGNMENT_A) {
  session.permissions = permissions;
  session.assignmentId = assignmentId;
  session.roleCode = own ? 'EMPLOYEE' : 'HR_ADMINISTRATOR';
  session.scopeKind = own ? 'OWN' : 'COMPANY';
}

function renderAt(entry: string, permissions: string[], own = false) {
  selectContext(permissions, own);
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          {ASSETS_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderQueue(permissions: string[], client = testClient(), assignmentId = ASSIGNMENT_A) {
  selectContext(permissions, false, assignmentId);
  const Queue = ASSETS_TASK_QUEUES[0]!.component;
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Queue />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function renderPanel(permissions: string[], own = true) {
  selectContext(permissions, own);
  const Panel = ASSETS_ESS_PANELS[0]!.component;
  return render(
    <QueryClientProvider client={testClient()}>
      <MemoryRouter>
        <Panel />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const findSection = async (heading: string) => (await screen.findByRole('heading', { name: heading })).closest('section') as HTMLElement;
const button = (scope: HTMLElement, name: string | RegExp) => within(scope).getByRole('button', { name }) as HTMLButtonElement;
const change = (scope: HTMLElement, label: string | RegExp, value: string) => fireEvent.change(within(scope).getByLabelText(label), { target: { value } });
const valueOf = (scope: HTMLElement, label: string | RegExp) => (within(scope).getByLabelText(label) as HTMLInputElement).value;
const key = (prefix: string) => expect.stringMatching(new RegExp(`^${prefix}-[0-9a-f-]{36}$`));
/** For waits behind the 300 ms search debounce, which take longer when the suite runs in parallel. */
const SLOW = { timeout: 4000 };
const alertText = (scope: HTMLElement = document.body) =>
  within(scope)
    .queryAllByRole('alert')
    .map((a) => a.textContent)
    .join(' | ');

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exports for the navigation step', () => {
  it('offers the register, item, employee and request screens, the TN16 My ESS panel and the custody-request queue', () => {
    expect(ASSETS_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([
      ['/assets', 'Asset register', MANAGE, true],
      ['/assets/items/:id', 'Asset', READ, false],
      ['/assets/employees/:id', 'Employee’s items', READ, false],
      ['/assets/requests', 'Custody requests', DECIDE, true],
    ]);
    expect(ASSETS_ESS_PANELS.map((p) => p.tabId)).toEqual(['TN16']);
    expect(ASSETS_TASK_QUEUES.map((q) => [q.permission, q.title])).toEqual([[DECIDE, 'Custody requests']]);
  });
});

describe('the register', () => {
  it('lists items with their state in words and the holder, and filters by state and search', async () => {
    serve();
    renderAt('/assets', ADMIN);
    const table = await screen.findByRole('table', { name: 'Register items' });
    expect(table.textContent).toContain('LAP-0001');
    expect(table.textContent).toContain('In stock');
    expect(table.textContent).toContain('Retired (final)');
    const row = within(table).getByText('DOCK-0002').closest('tr')!;
    expect(row.textContent).toContain('Issued');
    expect(row.textContent).toContain('Ravi Synthetic (SYN-002)');
    expect(row.textContent).toContain('1 Oct 2026');
    expect(callsTo('GET', '/v1/assets')[0]!.params.toString()).toBe('page=1&pageSize=25');

    const filters = screen.getByRole('form', { name: 'Filter the register' });
    change(filters, 'State', 'RETIRED');
    await waitFor(() => expect(callsTo('GET', '/v1/assets').some((c) => c.params.get('state') === 'RETIRED')).toBe(true));
    change(filters, 'Search', 'old');
    fireEvent.click(button(filters, 'Search'));
    await waitFor(() => expect(callsTo('GET', '/v1/assets').some((c) => c.params.get('search') === 'old' && c.params.get('state') === 'RETIRED')).toBe(true));
  });

  it('offers new items only with asset.manage, and is not read without asset.read or in the Employee OWN context', async () => {
    serve();
    renderAt('/assets', [READ]);
    await screen.findByRole('table', { name: 'Register items' });
    expect(screen.queryByRole('form', { name: 'Add an item' })).toBeNull();
    cleanup();

    serve();
    renderAt('/assets', [MANAGE]);
    expect(screen.getByRole('note').textContent).toContain('cannot read the asset register');
    cleanup();

    serve();
    renderAt('/assets', EMPLOYEE, true);
    expect(screen.getByRole('note').textContent).toContain('unrestricted company-scope Admin assignment');
    expect(callsTo('GET', '/v1/assets')).toHaveLength(0);
  });

  it('says the company-scope refusal in words', async () => {
    serve({ 'GET /v1/assets': [403, { error: 'FORBIDDEN', message: 'The asset register needs an unrestricted company-scope assignment' }] });
    renderAt('/assets', ADMIN);
    await waitFor(() => expect(screen.getByText(/needs an unrestricted company-scope Admin assignment\./)).toBeTruthy());
    expect(screen.queryByRole('table', { name: 'Register items' })).toBeNull();
  });

  it('adds an item with the exact body, keeps what was typed after a refusal and resets after success', async () => {
    serve({ 'POST /v1/assets': refuseFirst(1, 409, 'ASSET_CODE_EXISTS') });
    renderAt('/assets', ADMIN);
    const form = await screen.findByRole('form', { name: 'Add an item' });
    await waitFor(() => expect(within(form).getAllByRole('option').length).toBe(3));
    fireEvent.click(button(form, 'Add the item'));
    expect(alertText()).toContain('Enter the asset code, choose a category and describe the item.');
    expect(callsTo('POST', '/v1/assets')).toHaveLength(0);

    change(form, 'Asset code', 'lap-0042');
    change(form, 'Category', 'LAPTOP');
    change(form, /^Identifier/, 'SN-0042');
    change(form, 'Description', 'Synthetic laptop, 14 inch');
    fireEvent.click(button(form, 'Add the item'));
    await waitFor(() => expect(alertText()).toContain('An item with this asset code already exists. Asset codes are permanent and never reused.'));
    expect(valueOf(form, 'Asset code')).toBe('lap-0042');
    expect(valueOf(form, 'Description')).toBe('Synthetic laptop, 14 inch');

    fireEvent.click(button(form, 'Add the item'));
    await screen.findByText(/was added to the register \(In stock\)/);
    expect(bodiesTo('POST', '/v1/assets')[1]).toEqual({ assetCode: 'lap-0042', categoryCode: 'LAPTOP', description: 'Synthetic laptop, 14 inch', identifier: 'SN-0042' });
    expect(valueOf(form, 'Asset code')).toBe('');
    expect(valueOf(form, 'Description')).toBe('');
    await waitFor(() => expect(callsTo('GET', '/v1/assets').length).toBeGreaterThan(1));
  });

  it('disables the add button while the item is being added and leaves out an empty identifier', async () => {
    serve();
    renderAt('/assets', ADMIN);
    const form = await screen.findByRole('form', { name: 'Add an item' });
    await waitFor(() => expect(within(form).getAllByRole('option').length).toBe(3));
    change(form, 'Asset code', 'CHR-0005');
    change(form, 'Category', 'GENERAL');
    change(form, 'Description', 'Synthetic chair');
    const release = hold('POST /v1/assets');
    fireEvent.click(button(form, 'Add the item'));
    await waitFor(() => expect(button(form, 'Adding…').disabled).toBe(true));
    release();
    await waitFor(() => expect(button(form, 'Add the item').disabled).toBe(false));
    expect(bodiesTo('POST', '/v1/assets')[0]).toEqual({ assetCode: 'CHR-0005', categoryCode: 'GENERAL', description: 'Synthetic chair' });
  });
});

describe('one item', () => {
  it('issues an item in stock to a chosen employee, offering only approved requests without an item, with one idempotency key', async () => {
    serve();
    renderAt(`/assets/items/${A_STOCK}`, ADMIN);
    const form = await screen.findByRole('form', { name: 'Issue the item' });
    const history = await screen.findByRole('table', { name: 'Custody history' });
    expect(history.textContent).toContain('Asha Synthetic (SYN-001)');
    expect(history.textContent).toContain('Returned in good order (synthetic)');
    expect(screen.queryByRole('form', { name: 'Record the return' })).toBeNull();

    fireEvent.click(button(form, 'Issue the item'));
    expect(alertText()).toContain('Choose the employee who receives the item.');
    change(form, 'Find the employee', 'Ravi');
    fireEvent.click(await within(form).findByRole('button', { name: 'Choose Ravi Synthetic (SYN-002)' }, SLOW));
    const select = (await within(form).findByLabelText(/Fulfils the approved custody request/)) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(2));
    expect(select.options[1]!.textContent).toContain('Laptop: Synthetic docking station');
    change(form, /Fulfils the approved custody request/, R_APPROVED);
    change(form, 'Condition at issue', 'Good working order (synthetic)');
    fireEvent.click(button(form, 'Issue the item'));

    await screen.findByRole('form', { name: 'Record the return' });
    expect(screen.getByRole('status').textContent).toBe('LAP-0001 was issued to Ravi Synthetic (SYN-002) on 28 Oct 2026.');
    expect(bodiesTo('POST', `/v1/assets/${A_STOCK}/issue`)).toEqual([
      { employeeId: RAVI.id, condition: 'Good working order (synthetic)', requestId: R_APPROVED, idempotencyKey: key('asset-issue') },
    ]);
    expect(callsTo('GET', `/v1/employees/${RAVI.id}/asset-requests`).length).toBeGreaterThan(0);
  });

  it('sends the same key again after a lost answer and says refusals in words, keeping what was typed', async () => {
    serve({ [`POST /v1/assets/${A_STOCK}/issue`]: refuseFirst(1, 422, 'EMPLOYEE_NOT_ACTIVE') });
    lost.add(`POST /v1/assets/${A_STOCK}/issue`);
    renderAt(`/assets/items/${A_STOCK}`, ADMIN);
    const form = await screen.findByRole('form', { name: 'Issue the item' });
    change(form, 'Find the employee', 'Ravi');
    fireEvent.click(await within(form).findByRole('button', { name: 'Choose Ravi Synthetic (SYN-002)' }, SLOW));
    change(form, /^Issued on/, '2026-10-27');
    change(form, 'Condition at issue', 'Scratched lid (synthetic)');
    fireEvent.click(button(form, 'Issue the item'));
    await waitFor(() => expect(alertText()).toContain('No answer came back'));
    fireEvent.click(button(form, 'Issue the item'));
    await waitFor(() => expect(alertText()).toContain('Items are issued only to active employees'));
    const [first, second] = bodiesTo('POST', `/v1/assets/${A_STOCK}/issue`);
    expect(first).toEqual({ employeeId: RAVI.id, issuedOn: '2026-10-27', condition: 'Scratched lid (synthetic)', idempotencyKey: key('asset-issue') });
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
    expect(valueOf(form, 'Condition at issue')).toBe('Scratched lid (synthetic)');
    expect(within(form).getByText(/Issue to:/).textContent).toContain('Ravi Synthetic (SYN-002)');
  });

  it('records the return of an issued item; a held item offers no issue or retirement', async () => {
    serve({ [`POST /v1/assets/${A_ISSUED}/return`]: refuseFirst(1, 422, 'DATE_BEFORE_ISSUE', 'The item was issued on 2026-10-01') });
    renderAt(`/assets/items/${A_ISSUED}`, ADMIN);
    const form = await screen.findByRole('form', { name: 'Record the return' });
    const facts = (await findSection('Item')).textContent!;
    expect(facts).toContain('Ravi Synthetic (SYN-002)');
    expect(facts).toContain('Not acknowledged yet');
    expect(screen.queryByRole('form', { name: 'Issue the item' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Retire the item' })).toBeNull();

    change(form, /^Returned on/, '2026-09-30');
    change(form, 'Condition at return', 'Returned in good order (synthetic)');
    fireEvent.click(button(form, 'Record the return'));
    await waitFor(() => expect(alertText()).toContain('The return cannot be dated before the issue on 2026-10-01.'));
    change(form, /^Returned on/, '2026-10-27');
    fireEvent.click(button(form, 'Record the return'));
    await screen.findByRole('form', { name: 'Issue the item' });
    expect(screen.getByRole('status').textContent).toContain('The return of DOCK-0002 on 27 Oct 2026 was recorded.');
    const bodies = bodiesTo('POST', `/v1/assets/${A_ISSUED}/return`);
    expect(bodies[1]).toEqual({ returnedOn: '2026-10-27', condition: 'Returned in good order (synthetic)', idempotencyKey: key('asset-return') });
    expect(bodies[1]!.idempotencyKey).not.toBe(bodies[0]!.idempotencyKey);
    expect((await screen.findByRole('table', { name: 'Custody history' })).textContent).toContain('27 Oct 2026');
  });

  it('retires an item in stock with a note and the loaded version, saying date refusals in words', async () => {
    serve({ [`POST /v1/assets/${A_STOCK}/retire`]: refuseFirst(1, 422, 'DATE_IN_FUTURE') });
    renderAt(`/assets/items/${A_STOCK}`, ADMIN);
    const form = await screen.findByRole('form', { name: 'Retire the item' });
    fireEvent.click(button(form, 'Retire the item'));
    expect(alertText()).toContain('Record why the item is retired.');
    change(form, /^Retired on/, '2026-11-01');
    change(form, 'Why the item is retired', 'Beyond repair (synthetic)');
    fireEvent.click(button(form, 'Retire the item'));
    await waitFor(() => expect(alertText()).toContain('The date cannot be later than today'));
    expect(valueOf(form, 'Why the item is retired')).toBe('Beyond repair (synthetic)');
    change(form, /^Retired on/, '');
    fireEvent.click(button(form, 'Retire the item'));
    await waitFor(() => expect((screen.getAllByText('Retired (final)').length)).toBeGreaterThan(0));
    expect(bodiesTo('POST', `/v1/assets/${A_STOCK}/retire`)).toEqual([
      { retiredOn: '2026-11-01', note: 'Beyond repair (synthetic)', expectedVersion: 3 },
      { note: 'Beyond repair (synthetic)', expectedVersion: 3 },
    ]);
    expect(screen.queryByRole('form', { name: 'Issue the item' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Correct the register entry' })).toBeNull();
  });

  it('corrects the register entry with only the changed fields and reloads after a stale version', async () => {
    serve({ [`PATCH /v1/assets/${A_STOCK}`]: refuseFirst(1, 409, 'STALE_VERSION') });
    renderAt(`/assets/items/${A_STOCK}`, ADMIN);
    const form = await screen.findByRole('form', { name: 'Correct the register entry' });
    fireEvent.click(button(form, 'Save the correction'));
    expect(alertText()).toContain('Nothing differs from the register entry.');
    change(form, 'Description', 'Synthetic laptop, 14 inch');
    change(form, /^Identifier/, '');
    const loads = callsTo('GET', `/v1/assets/${A_STOCK}`).length;
    fireEvent.click(button(form, 'Save the correction'));
    await waitFor(() => expect(alertText()).toContain('The item changed since it was loaded'));
    await waitFor(() => expect(callsTo('GET', `/v1/assets/${A_STOCK}`).length).toBeGreaterThan(loads));
    fireEvent.click(button(form, 'Save the correction'));
    await screen.findByText('The register entry was corrected.');
    expect(bodiesTo('PATCH', `/v1/assets/${A_STOCK}`)).toEqual([
      { expectedVersion: 3, description: 'Synthetic laptop, 14 inch', identifier: null },
      { expectedVersion: 3, description: 'Synthetic laptop, 14 inch', identifier: null },
    ]);
  });

  it('a read-only role sees the item, its retirement and history but no register or custody actions', async () => {
    serve();
    renderAt(`/assets/items/${A_RETIRED}`, [READ]);
    const facts = (await findSection('Item')).textContent!;
    expect(facts).toContain('Retired (final)');
    expect(facts).toContain('30 Sep 2026');
    expect(facts).toContain('Beyond repair (synthetic)');
    expect(screen.getByText('The item has never been issued.')).toBeTruthy();
    expect(screen.queryAllByRole('form')).toHaveLength(0);
    cleanup();

    serve();
    renderAt(`/assets/items/${A_STOCK}`, [READ]);
    await screen.findByRole('table', { name: 'Custody history' });
    expect(screen.queryAllByRole('form')).toHaveLength(0);
  });
});

describe('an employee’s items', () => {
  it('lists what the employee holds and has returned, and filters by status', async () => {
    serve();
    renderAt(`/assets/employees/${ASHA.id}`, ADMIN);
    const table = await screen.findByRole('table', { name: 'The employee’s items' });
    expect(screen.getByText('Asha Synthetic (SYN-001)')).toBeTruthy();
    expect(table.textContent).toContain('MON-0004');
    expect(table.textContent).toContain('LAP-0001');
    expect((await screen.findByRole('table', { name: 'The employee’s custody requests' })).textContent).toContain('Synthetic keyboard');
    change(document.body, 'Show', 'HELD');
    await waitFor(() => expect(callsTo('GET', `/v1/employees/${ASHA.id}/assets`).some((c) => c.params.get('status') === 'HELD')).toBe(true));
    await waitFor(() => expect(screen.getByRole('table', { name: 'The employee’s items' }).textContent).not.toContain('LAP-0001'));
  });
});

describe('the custody-request decision queue', () => {
  it('shows the request with the items held now, approves without a note and never issues anything', async () => {
    serve();
    renderQueue(ADMIN);
    const task = await screen.findByRole('listitem', { name: 'Custody request of Meera Synthetic (SYN-003)' });
    expect(task.textContent).toContain('Synthetic hot-desk setup');
    expect(task.textContent).toContain('Laptop');
    expect(within(task).getByRole('list', { name: 'Items Meera Synthetic (SYN-003) holds now' }).textContent).toContain('PHN-0009');
    expect(screen.getByText(/Approval issues nothing/)).toBeTruthy();
    fireEvent.click(button(task, 'Approve'));
    await screen.findByText(/was approved\. No item has been issued: issue one from the register\./);
    expect(bodiesTo('POST', `/v1/asset-requests/tasks/${T_MEERA}/decision`)).toEqual([{ decision: 'APPROVE', idempotencyKey: key('asset-decision') }]);
    expect(calls.some((c) => c.path.endsWith('/issue'))).toBe(false);
    expect(screen.queryByRole('listitem', { name: /Custody request of Meera/ })).toBeNull();
  });

  it('a rejection needs a note: nothing is sent without one; with one the buttons are disabled while it is sent', async () => {
    serve();
    renderQueue(ADMIN);
    const task = await screen.findByRole('listitem', { name: 'Custody request of Meera Synthetic (SYN-003)' });
    fireEvent.click(button(task, 'Reject'));
    expect(alertText(task)).toContain('Enter a note explaining the rejection. The employee never sees it.');
    expect(callsTo('POST', `/v1/asset-requests/tasks/${T_MEERA}/decision`)).toHaveLength(0);
    change(task, /^Note/, 'Synthetic: a spare desk set is available');
    const release = hold(`POST /v1/asset-requests/tasks/${T_MEERA}/decision`);
    fireEvent.click(button(task, 'Reject'));
    await waitFor(() => expect(button(task, 'Approve').disabled).toBe(true));
    expect(button(task, 'Reject').disabled).toBe(true);
    release();
    await screen.findByText(/was rejected\. Your note is not shown to the employee\./);
    expect(bodiesTo('POST', `/v1/asset-requests/tasks/${T_MEERA}/decision`)).toEqual([
      { decision: 'REJECT', reason: 'Synthetic: a spare desk set is available', idempotencyKey: key('asset-decision') },
    ]);
  });

  it('shows no held items when the API leaves them out, offers no decision outside scope, and says a closed task in words', async () => {
    serve({ [`POST /v1/asset-requests/tasks/${T_MEERA}/decision`]: [409, { error: 'TASK_CLOSED', message: 'closed' }] });
    db.tasks = [
      { ...db.tasks[0]!, request: { ...db.tasks[0]!.request } },
      { taskId: T_HIDDEN, transactionId: '70000000-0000-4000-8000-000000000002', ownerEmployeeId: RAVI.id, ownerEmployeeCode: 'SYN-002', ownerName: 'Ravi Synthetic', assignedAt: AT, step: 1, request: null },
    ];
    delete db.tasks[0]!.request.currentlyHeld;
    renderQueue([DECIDE]);
    const task = await screen.findByRole('listitem', { name: 'Custody request of Meera Synthetic (SYN-003)' });
    expect(task.textContent).not.toContain('Items the employee holds now');
    const hidden = screen.getByRole('listitem', { name: 'Custody request of Ravi Synthetic (SYN-002)' });
    expect(within(hidden).queryAllByRole('button')).toHaveLength(0);
    expect(hidden.textContent).toContain('outside the selected role’s scope');
    fireEvent.click(button(task, 'Approve'));
    await screen.findByText('This request has already been decided or withdrawn.');
    expect(screen.queryByRole('listitem', { name: /Custody request of Meera/ })).toBeNull();
  });

  it('query keys carry the selected assignment: another role never sees the first one’s cached queue', async () => {
    serve();
    const client = testClient();
    renderQueue(ADMIN, client);
    await screen.findByRole('listitem', { name: /Custody request of Meera/ });
    cleanup();
    // While the second assignment's own answer is outstanding, nothing cached for the first one may be shown.
    const release = hold('GET /v1/asset-requests/tasks/mine');
    renderQueue(ADMIN, client, ASSIGNMENT_B);
    await waitFor(() => expect(callsTo('GET', '/v1/asset-requests/tasks/mine')).toHaveLength(2));
    expect(screen.queryByRole('listitem', { name: /Custody request of Meera/ })).toBeNull();
    expect(screen.getByText('Loading the requests waiting for you…')).toBeTruthy();
    release();
    await screen.findByRole('listitem', { name: /Custody request of Meera/ });
  });

  it('the requests screen lists requests, filters approved ones waiting for an item, and shows the queue only with the decide key', async () => {
    serve();
    renderAt('/assets/requests', [REQUEST_READ]);
    const table = await screen.findByRole('table', { name: 'Custody requests' });
    expect(table.textContent).toContain('Meera Synthetic (SYN-003)');
    expect(screen.queryByRole('region', { name: 'Custody requests to decide' })).toBeNull();
    change(document.body, 'Show', 'UNFULFILLED');
    await waitFor(() => expect(callsTo('GET', '/v1/asset-requests').some((c) => c.params.get('unfulfilled') === 'true' && !c.params.has('state'))).toBe(true));
    await waitFor(() => expect(screen.getByRole('table', { name: 'Custody requests' }).textContent).toContain('Not issued yet'));
    expect(callsTo('GET', '/v1/asset-requests/tasks/mine')).toHaveLength(0);
  });
});

describe('My ESS TN16', () => {
  it('outside the Employee OWN context nothing is fetched', async () => {
    serve();
    renderPanel(EMPLOYEE, false);
    expect(screen.getByText('Select your Employee role to see your own items and custody requests.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('shows own held and returned items and acknowledges receipt once with the custody id; no custody actions for the employee', async () => {
    serve();
    renderPanel(EMPLOYEE);
    const held = await screen.findByRole('table', { name: 'Items I hold' });
    expect(held.textContent).toContain('MON-0004');
    expect(held.textContent).not.toContain('LAP-0001');
    const returned = await screen.findByRole('table', { name: 'Items I have returned' });
    expect(returned.textContent).toContain('LAP-0001');
    expect(returned.textContent).toContain('Acknowledged');
    expect(within(returned).queryAllByRole('button')).toHaveLength(0);
    expect(calls.every((c) => !c.path.startsWith('/v1/assets'))).toBe(true);
    for (const b of screen.getAllByRole('button')) expect(b.textContent).not.toMatch(/\b(issue|return|retire|transfer|write)/i);

    fireEvent.click(button(held, 'Acknowledge receipt of MON-0004'));
    await screen.findByText('Your acknowledgment of receipt was recorded.');
    expect(bodiesTo('POST', '/v1/me/asset-acknowledgments')).toEqual([{ custodyId: K_OWN }]);
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'Items I hold' })).queryAllByRole('button')).toHaveLength(0));
    expect(screen.getByRole('table', { name: 'Items I hold' }).textContent).toContain('Acknowledged');
  });

  it('DF03: a request that raises a rejected one again says so, and the rejected one is no longer offered', async () => {
    serve();
    db.requests.push(request('40000000-0000-4000-8000-0000000000f1', ASHA, 'SUBMITTED', { predecessorRequestId: R_OWN_REJECTED }));
    renderPanel(EMPLOYEE);
    const table = await screen.findByRole('table', { name: 'My custody requests' });
    expect(table.textContent).toContain('Raised again after a rejected request');
    expect(within(table).queryByRole('button', { name: /^Raise again/ })).toBeNull();
  });

  it('DF03: a rejected request can be raised again from what it asked, linked to it, with its own key', async () => {
    serve();
    renderPanel(EMPLOYEE);
    const table = await screen.findByRole('table', { name: 'My custody requests' });
    fireEvent.click(button(table, /^Raise again the rejected request/));
    const form = await screen.findByRole('form', { name: 'Ask for an item' });
    await waitFor(() => expect(valueOf(form, 'Why you need it')).toBe('Synthetic project work'));
    await waitFor(() => expect(valueOf(form, 'Category')).toBe('LAPTOP'));
    expect(screen.getByText('Make it an unlinked request')).toBeTruthy();
    fireEvent.click(button(form, 'Send the request'));
    await screen.findByText('Your request was sent and is waiting for a decision.');
    expect(bodiesTo('POST', '/v1/me/asset-requests')[0]).toEqual({ categoryCode: 'LAPTOP', reason: 'Synthetic project work', predecessorRequestId: R_OWN_REJECTED, idempotencyKey: key('asset-request') });
    expect(screen.queryByText('Make it an unlinked request')).toBeNull();
  });

  it('asks for an item from the own category list with the exact body; refusals in words keep what was typed', async () => {
    serve({ 'POST /v1/me/asset-requests': refuseFirst(1, 422, 'NO_ELIGIBLE_REVIEWER') });
    renderPanel(EMPLOYEE);
    const form = await screen.findByRole('form', { name: 'Ask for an item' });
    await waitFor(() => expect(within(form).getAllByRole('option').length).toBe(3));
    expect(callsTo('GET', '/v1/me/asset-categories')).toHaveLength(1);
    change(form, 'Category', 'LAPTOP');
    fireEvent.click(button(form, 'Send the request'));
    expect(alertText()).toContain('Explain why you need the item.');
    change(form, /^Specific item/, 'Synthetic 14 inch laptop');
    change(form, 'Why you need it', 'Synthetic project work');
    fireEvent.click(button(form, 'Send the request'));
    await waitFor(() => expect(alertText()).toContain('No eligible reviewer is set up for custody requests'));
    expect(valueOf(form, 'Why you need it')).toBe('Synthetic project work');
    fireEvent.click(button(form, 'Send the request'));
    await screen.findByText('Your request was sent and is waiting for a decision.');
    const [first, second] = bodiesTo('POST', '/v1/me/asset-requests');
    expect(first).toEqual({ categoryCode: 'LAPTOP', itemDescription: 'Synthetic 14 inch laptop', reason: 'Synthetic project work', idempotencyKey: key('asset-request') });
    expect(second!.idempotencyKey).toBe(first!.idempotencyKey);
    expect(valueOf(form, 'Why you need it')).toBe('');
    expect(valueOf(form, 'Category')).toBe('');
    await waitFor(() => expect(screen.getByRole('table', { name: 'My custody requests' }).textContent).toContain('Synthetic 14 inch laptop'));
  });

  it('shows own requests with outcomes and the item issued (never a reviewer note) and withdraws a waiting one', async () => {
    serve();
    renderPanel(EMPLOYEE);
    const table = await screen.findByRole('table', { name: 'My custody requests' });
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(4);
    expect(table.textContent).toContain('Waiting for a decision · with Hema Synthetic');
    expect(table.textContent).toContain('Rejected');
    expect(table.textContent).toContain('MON-0004, issued 1 Oct 2026');
    expect(within(table).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Withdraw the request for General item', 'Raise again the rejected request for Laptop']);
    fireEvent.click(button(table, 'Withdraw the request for General item'));
    await screen.findByText('Your request was withdrawn.');
    expect(callsTo('POST', `/v1/me/asset-requests/${R_OWN_WAITING}/withdraw`)).toHaveLength(1);
    expect(callsTo('POST', `/v1/me/asset-requests/${R_OWN_WAITING}/withdraw`)[0]!.body).toBeUndefined();
    await waitFor(() => expect(within(screen.getByRole('table', { name: 'My custody requests' })).queryByRole('button', { name: /^Withdraw/ })).toBeNull());
  });

  it('without the submit key there is no request form or withdrawal; without the acknowledge key no acknowledgment', async () => {
    serve();
    renderPanel([READ, REQUEST_READ]);
    const held = await screen.findByRole('table', { name: 'Items I hold' });
    await screen.findByRole('table', { name: 'My custody requests' });
    expect(within(held).queryAllByRole('button')).toHaveLength(0);
    expect(held.textContent).toContain('Not acknowledged');
    expect(screen.queryByRole('form', { name: 'Ask for an item' })).toBeNull();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    expect(callsTo('GET', '/v1/me/asset-categories')).toHaveLength(0);
  });
});
