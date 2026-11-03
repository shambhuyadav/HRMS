// Access administration screen (FR-066/067/068; C4; DF02), jsdom: users and their grants with confidential
// permissions and scope restrictions marked, proposals that send exactly the chosen permissions, decisions that need
// a reason and carry the row version, decision controls only for the permissions the selected assignment holds, and
// no answer cached for one role assignment shown under another. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessAdminPage } from './access';

const MY_ASSIGNMENT = '44444444-4444-4444-8444-444444444444';
const session = vi.hoisted(() => ({ permissions: [] as string[], assignmentId: '' }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: {
      accountKey: 'syn.admin',
      companyName: 'Synthetic Co',
      roleCode: 'SYSTEM_ADMINISTRATOR',
      roleName: 'System Administrator',
      scopeKind: 'COMPANY',
      employeeId: null,
      displayName: 'Synthetic Admin',
    },
    stored: { token: 'syn-token', companies: [], companyId: 'syn-company', assignmentId: session.assignmentId },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const READ = 'access.read_users.operational';
const ASSIGN = 'access.assign_role.operational';
const APPROVE = 'access.approve_role_grant.operational';
const REVOKE = 'access.revoke_role.operational';
const READ_ORG = 'org_master.read.operational';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const ADMIN = '33333333-3333-4333-8333-333333333333';
const OUTSIDER = '55555555-5555-4555-8555-555555555555'; // on no loaded user page: labelled by the account key the grant carries
const G_PENDING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const G_ACTIVE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const G_NEW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DEPT_ENG = 'dddddddd-0000-4000-8000-000000000001';
const DEPT_FIN = 'dddddddd-0000-4000-8000-000000000002';
const DEPT_OLD = 'dddddddd-0000-4000-8000-000000000003';

const USERS = [
  {
    userId: U1,
    accountKey: 'syn.asha',
    active: true,
    employee: { id: 'eeeeeeee-0000-4000-8000-000000000001', employeeCode: 'SYN-001', displayName: 'Asha Synthetic' },
    assignments: { active: 1, pending: 1 },
  },
  { userId: U2, accountKey: 'syn.auditor', active: true, employee: null, assignments: { active: 1, pending: 0 } },
  { userId: ADMIN, accountKey: 'syn.admin', active: true, employee: null, assignments: { active: 1, pending: 0 } },
];

const ROLES = [
  {
    code: 'HR_ADMINISTRATOR',
    name: 'HR Administrator',
    accessClass: 'ADMIN',
    defaultScope: 'COMPANY',
    active: true,
    permissions: [
      { key: 'employee.export.operational', confidential: false, defaultDuty: false },
      { key: 'employee.list.operational', confidential: false, defaultDuty: true },
      { key: 'employee.read.operational', confidential: false, defaultDuty: true },
      { key: 'leave.read.reason', confidential: true, defaultDuty: false },
      { key: 'salary.read.salary', confidential: true, defaultDuty: false },
    ],
  },
  {
    code: 'LEGACY_VIEWER',
    name: 'Legacy Viewer',
    accessClass: 'OTHER',
    defaultScope: null,
    active: false,
    permissions: [{ key: 'employee.list.operational', confidential: false, defaultDuty: false }],
  },
  {
    // A synthetic Other-class ceiling that lists a confidential permission: the screen must not let it be chosen.
    code: 'TRAINING_COORDINATOR',
    name: 'Training Coordinator',
    accessClass: 'OTHER',
    defaultScope: 'COMPANY',
    active: true,
    permissions: [
      { key: 'dashboard.read.operational', confidential: false, defaultDuty: true },
      { key: 'employee.list.operational', confidential: false, defaultDuty: true },
      { key: 'employee.read.personal', confidential: true, defaultDuty: false },
    ],
  },
  {
    code: 'EMPLOYEE',
    name: 'Employee',
    accessClass: 'OTHER',
    defaultScope: 'OWN',
    active: true,
    permissions: [{ key: 'employee.read.operational', confidential: false, defaultDuty: true }],
  },
];

// Grant rows as GET /v1/access/assignments returns them (the server's permission order is not guaranteed).
const PENDING_GRANT = {
  id: G_PENDING,
  userId: U1,
  userAccountKey: 'syn.asha',
  roleCode: 'HR_ADMINISTRATOR',
  scopeKind: 'COMPANY',
  state: 'PENDING',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  effectiveTo: null,
  purpose: 'Synthetic payroll review',
  requestedBy: ADMIN,
  requestedByAccountKey: 'syn.admin',
  approvedBy: null,
  approvedByAccountKey: null,
  version: 1,
  permissions: ['salary.read.salary', 'employee.list.operational'],
  filters: { departments: [DEPT_ENG], locations: [], employees: [] },
};

const ACTIVE_GRANT = {
  id: G_ACTIVE,
  userId: U1,
  userAccountKey: 'syn.asha',
  roleCode: 'EMPLOYEE',
  scopeKind: 'OWN',
  state: 'ACTIVE',
  effectiveFrom: '2025-06-01T00:00:00.000Z',
  effectiveTo: null,
  purpose: null,
  requestedBy: ADMIN,
  requestedByAccountKey: 'syn.admin',
  approvedBy: OUTSIDER,
  approvedByAccountKey: 'syn.outsider',
  version: 3,
  // A permission no role in the catalogue lists any more: its classification is unknown, so it is not folded away.
  permissions: ['legacy.read.operational', 'employee.read.operational'],
  filters: { departments: [], locations: [], employees: [] },
};

/** The assignment the signed-in administrator is using right now. */
const MY_GRANT = {
  id: MY_ASSIGNMENT,
  userId: ADMIN,
  userAccountKey: 'syn.admin',
  roleCode: 'SYSTEM_ADMINISTRATOR',
  scopeKind: 'COMPANY',
  state: 'ACTIVE',
  effectiveFrom: '2025-01-01T00:00:00.000Z',
  effectiveTo: null,
  purpose: null,
  requestedBy: null,
  requestedByAccountKey: null,
  approvedBy: U2,
  approvedByAccountKey: 'syn.auditor',
  version: 2,
  permissions: ['access.read_users.operational', 'access.revoke_role.operational'],
  filters: { departments: [], locations: [], employees: [] },
};

const DEPARTMENTS = [
  { id: DEPT_ENG, code: 'SYN-ENG', name: 'Engineering', active: true, version: 1 },
  { id: DEPT_FIN, code: 'SYN-FIN', name: 'Finance', active: true, version: 1 },
  { id: DEPT_OLD, code: 'SYN-OLD', name: 'Old Synthetic', active: false, version: 2 },
];

const FORBIDDEN: Reply = [403, { error: 'FORBIDDEN', message: 'Not permitted' }];

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}
type Reply = [status: number, body: unknown];
type Route = Reply | ((call: Call) => Reply);

let calls: Call[] = [];
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);

/** A fetch stub routing "METHOD /path" to canned replies; every request is recorded in `calls`. */
function serve(overrides: Record<string, Route> = {}) {
  const routes: Record<string, Route> = {
    'GET /v1/access/users': (c) => {
      const search = c.params.get('search')?.toLowerCase();
      const items = search ? USERS.filter((u) => u.accountKey.includes(search) || u.employee?.employeeCode.toLowerCase().includes(search)) : USERS;
      return [200, { items, total: items.length }];
    },
    'GET /v1/access/roles': [200, { items: ROLES }],
    'GET /v1/access/assignments': (c) => {
      if (c.params.get('state') === 'PENDING') return [200, { items: [PENDING_GRANT] }];
      const userId = c.params.get('userId');
      return [200, { items: userId === U1 ? [PENDING_GRANT, ACTIVE_GRANT] : userId === ADMIN ? [MY_GRANT] : [] }];
    },
    'GET /v1/org/departments': [200, { items: DEPARTMENTS }],
    'GET /v1/org/locations': FORBIDDEN,
    'POST /v1/access/assignments': [201, { id: G_NEW, state: 'PENDING' }],
    ...overrides,
  };
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body]: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${call.method} ${call.path}` }] : typeof route === 'function' ? route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

function renderWith(client: QueryClient, ...permissions: string[]) {
  session.permissions = permissions;
  return render(
    <QueryClientProvider client={client}>
      <AccessAdminPage />
    </QueryClientProvider>,
  );
}
const renderPage = (...permissions: string[]) => renderWith(newClient(), ...permissions);

const findSection = async (heading: string | RegExp) => (await screen.findByRole('heading', { name: heading })).closest('section') as HTMLElement;
const rowWith = (scope: HTMLElement, text: string) => within(scope).getByText(text).closest('tr') as HTMLElement;
const checkbox = (scope: HTMLElement, key: string) => within(scope).getByRole('checkbox', { name: new RegExp(`^${key.replace(/\./g, '\\.')}`) }) as HTMLInputElement;

async function selectAsha() {
  fireEvent.click(await screen.findByRole('button', { name: 'Show assignments for syn.asha' }));
  return findSection('Assignments of Asha Synthetic (SYN-001)');
}

beforeEach(() => {
  session.assignmentId = MY_ASSIGNMENT;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('users and their assignments (FR-066)', () => {
  it('lists users and shows the selected user’s assignments with confidential permissions and restrictions marked', async () => {
    serve();
    renderPage(READ);
    const users = await findSection('Users (3)');
    expect(within(rowWith(users, 'syn.asha')).getAllByRole('cell').map((c) => c.textContent?.trim())).toEqual(['syn.asha', 'SYN-001', 'Asha Synthetic', '1', '1', 'Show assignments']);
    expect(within(rowWith(users, 'syn.auditor')).getByText('No employee link')).toBeTruthy();
    const list = callsTo('GET', '/v1/access/users')[0]!;
    expect(list.params.get('page')).toBe('1');
    expect(list.params.get('pageSize')).toBe('25');
    expect(list.params.has('search')).toBe(false);

    const panel = await selectAsha();
    await within(panel).findByText('Synthetic payroll review');
    expect(callsTo('GET', '/v1/access/assignments').map((c) => c.params.get('userId'))).toEqual([U1]);

    const pending = rowWith(panel, 'Synthetic payroll review');
    expect(within(pending).getByText('HR Administrator')).toBeTruthy();
    expect(within(pending).getByText('pending')).toBeTruthy();
    expect(within(pending).getByText('salary.read.salary').closest('li')!.textContent).toContain('confidential');
    expect(within(pending).getByText('employee.list.operational').closest('li')!.textContent).not.toContain('confidential');
    expect(within(pending).getByText('syn.admin · you')).toBeTruthy();
    // The grant's own restriction is shown; without org master access it is named by a short id, not guessed.
    expect(within(pending).getByText('Departments: department dddddddd')).toBeTruthy();

    const active = rowWith(panel, 'EMPLOYEE');
    expect(within(active).getByText('active')).toBeTruthy();
    expect(within(active).getByText('no further restrictions')).toBeTruthy();
    expect(within(active).getByText('approved by syn.outsider')).toBeTruthy(); // account key from the grant row
    expect(within(active).getByText('legacy.read.operational').closest('li')!.textContent).toContain('not in role catalogue');

    // Read-only role: no decision or proposal controls, and no pending-approval queue or org master is even requested.
    expect(screen.queryByRole('button', { name: /^(Approve|Reject|Revoke)$/ })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'Actions' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Pending approvals/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Propose a grant/ })).toBeNull();
    expect(calls.some((c) => c.params.get('state') === 'PENDING')).toBe(false);
    expect(calls.some((c) => c.path.startsWith('/v1/org/'))).toBe(false);
  });

  it('searches and pages through the users', async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      userId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      accountKey: `syn.user${i}`,
      active: true,
      employee: null,
      assignments: { active: 0, pending: 0 },
    }));
    serve({
      'GET /v1/access/users': (c) => {
        const search = c.params.get('search');
        const items = search ? many.filter((u) => u.accountKey.includes(search)) : many;
        const page = Number(c.params.get('page'));
        const size = Number(c.params.get('pageSize'));
        return [200, { items: items.slice((page - 1) * size, page * size), total: items.length }];
      },
    });
    renderPage(READ);
    expect(await screen.findByText('Page 1 of 2')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('syn.user25')).toBeTruthy();
    expect(callsTo('GET', '/v1/access/users').at(-1)!.params.get('page')).toBe('2');

    // syn.user3 is on page 1 only, so it can appear here only through the (debounced, trimmed) search.
    fireEvent.change(screen.getByLabelText('Search users'), { target: { value: ' user3 ' } });
    await waitFor(() => expect(callsTo('GET', '/v1/access/users').at(-1)!.params.get('search')).toBe('user3'));
    expect(callsTo('GET', '/v1/access/users').at(-1)!.params.get('page')).toBe('1'); // a new search starts at page 1
    expect(await screen.findByText('syn.user3')).toBeTruthy();
    expect(await screen.findByText('Page 1 of 1')).toBeTruthy();
    expect(screen.queryByText('syn.user25')).toBeNull();
  });

  it('tells "not permitted" apart from an empty list', async () => {
    serve({ 'GET /v1/access/users': FORBIDDEN });
    renderPage(READ);
    expect(await screen.findByText(/cannot list users/)).toBeTruthy();
    expect(screen.queryByText(/No users/)).toBeNull();
    cleanup();

    serve({ 'GET /v1/access/users': [200, { items: [], total: 0 }] });
    renderPage(READ);
    expect(await screen.findByText('No users in your administrative scope.')).toBeTruthy();
    expect(screen.queryByText(/not permitted/i)).toBeNull();
    cleanup();

    serve();
    renderPage();
    expect(screen.getByText(/cannot administer user access/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('never shows answers cached for another role assignment', async () => {
    const client = newClient(); // the app keeps one query cache across role switches
    serve();
    renderWith(client, READ);
    await findSection('Users (3)');
    expect(await screen.findByText('syn.asha')).toBeTruthy();
    cleanup();

    // The same person switches to another assignment that the server refuses user administration.
    session.assignmentId = '66666666-6666-4666-8666-666666666666';
    serve({ 'GET /v1/access/users': FORBIDDEN });
    renderWith(client, READ);
    expect(screen.queryByText('syn.asha')).toBeNull();
    expect(await screen.findByText(/cannot list users/)).toBeTruthy();
    expect(screen.queryByText('syn.asha')).toBeNull();
    expect(callsTo('GET', '/v1/access/users')).toHaveLength(1);
  });

  it('says so when confidential permissions cannot be marked', async () => {
    serve({ 'GET /v1/access/roles': FORBIDDEN });
    renderPage(READ);
    const panel = await selectAsha();
    await within(panel).findByText('Synthetic payroll review');
    expect(within(panel).getByText(/could not be loaded, so confidential permissions are not marked/)).toBeTruthy();
    expect(within(panel).queryByText('confidential')).toBeNull(); // nothing is marked from a guess
  });
});

describe('proposing a grant (FR-067, DF02)', () => {
  it('sends exactly the checked permissions, and a business purpose once a confidential one is chosen', async () => {
    serve();
    renderPage(READ, ASSIGN, READ_ORG);
    await selectAsha();
    const form = await findSection(/^Propose a grant for Asha Synthetic/);
    const role = (await within(form).findByLabelText('Role')) as HTMLSelectElement;
    expect([...role.options].map((o) => o.value)).toEqual(['', 'HR_ADMINISTRATOR', 'TRAINING_COORDINATOR', 'EMPLOYEE']); // inactive roles are not offered
    fireEvent.change(role, { target: { value: 'HR_ADMINISTRATOR' } });
    expect((within(form).getByLabelText('Scope') as HTMLSelectElement).value).toBe('COMPANY');

    // Default duties pre-checked; confidential permissions unchecked and labelled.
    expect(checkbox(form, 'employee.list.operational').checked).toBe(true);
    expect(checkbox(form, 'employee.read.operational').checked).toBe(true);
    expect(checkbox(form, 'employee.export.operational').checked).toBe(false);
    expect(checkbox(form, 'salary.read.salary').checked).toBe(false);
    expect(checkbox(form, 'leave.read.reason').checked).toBe(false);
    expect(checkbox(form, 'salary.read.salary').closest('label')!.textContent).toContain('confidential');
    expect(checkbox(form, 'employee.list.operational').closest('label')!.textContent).not.toContain('confidential');

    fireEvent.click(checkbox(form, 'employee.read.operational')); // drop a default duty
    fireEvent.click(checkbox(form, 'employee.export.operational')); // add an operational permission
    fireEvent.click(checkbox(form, 'salary.read.salary')); // add a confidential permission
    fireEvent.change(within(form).getByLabelText('Effective from'), { target: { value: '2026-11-01' } });
    fireEvent.change(within(form).getByLabelText('Effective to (optional)'), { target: { value: '2026-12-31' } });
    fireEvent.click(await within(form).findByRole('checkbox', { name: /Engineering/ }));
    expect(within(form).getByRole('group', { name: 'Restrict to departments (optional)' })).toBeTruthy();
    expect(within(form).queryByRole('checkbox', { name: /Old Synthetic/ })).toBeNull(); // inactive entries are not offered
    expect(within(form).queryByRole('group', { name: /locations/ })).toBeNull(); // location masters are refused: no picker
    expect(callsTo('GET', '/v1/org/departments')[0]!.params.get('includeInactive')).toBe('true');

    const submit = within(form).getByRole('button', { name: 'Propose grant' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // a confidential permission needs a business purpose
    expect(within(form).getByText(/Still needed: a business purpose/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Business purpose (required for confidential permissions)'), { target: { value: '  Synthetic payroll audit  ' } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(await within(form).findByText('Proposed — needs independent approval')).toBeTruthy();
    const posts = callsTo('POST', '/v1/access/assignments');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toStrictEqual({
      userId: U1,
      roleCode: 'HR_ADMINISTRATOR',
      scopeKind: 'COMPANY',
      effectiveFrom: new Date('2026-11-01T00:00:00').toISOString(),
      effectiveTo: new Date('2026-12-31T00:00:00').toISOString(),
      permissions: ['employee.export.operational', 'employee.list.operational', 'salary.read.salary'],
      filters: { departments: [DEPT_ENG] },
      purpose: 'Synthetic payroll audit',
    });
    // The user's assignments are reloaded so the new pending grant shows.
    await waitFor(() => expect(callsTo('GET', '/v1/access/assignments').filter((c) => c.params.get('userId') === U1).length).toBeGreaterThan(1));
  });

  it('disables confidential permissions for an Other-class role and sends no purpose', async () => {
    serve();
    renderPage(READ, ASSIGN);
    await selectAsha();
    const form = await findSection(/^Propose a grant for/);
    fireEvent.change(await within(form).findByLabelText('Role'), { target: { value: 'TRAINING_COORDINATOR' } });

    const personal = checkbox(form, 'employee.read.personal');
    expect(personal.disabled).toBe(true);
    expect(personal.checked).toBe(false);
    expect(personal.closest('label')!.textContent).toContain('confidential');
    expect(within(form).getByText(/only Admin or Manager roles can hold confidential permissions/)).toBeTruthy();
    fireEvent.click(personal);
    expect(personal.checked).toBe(false);
    expect(checkbox(form, 'dashboard.read.operational').checked).toBe(true);
    expect(within(form).getByLabelText('Business purpose (optional)')).toBeTruthy();
    // Without org master access the filter pickers are neither requested (a refusal is audited) nor shown.
    expect(within(form).queryByRole('group', { name: /departments|locations/ })).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/v1/org/'))).toBe(false);

    fireEvent.change(within(form).getByLabelText('Effective from'), { target: { value: '2026-11-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Propose grant' }));
    expect(await within(form).findByText('Proposed — needs independent approval')).toBeTruthy();
    expect(callsTo('POST', '/v1/access/assignments')[0]!.body).toStrictEqual({
      userId: U1,
      roleCode: 'TRAINING_COORDINATOR',
      scopeKind: 'COMPANY',
      effectiveFrom: new Date('2026-11-01T00:00:00').toISOString(),
      permissions: ['dashboard.read.operational', 'employee.list.operational'],
    });
  });
});

describe('deciding grants (FR-068, C4)', () => {
  it('reject and revoke need a reason and send the row version; approval refusals are shown', async () => {
    serve({
      [`POST /v1/access/assignments/${G_PENDING}/approve`]: [403, { error: 'SELF_APPROVAL', message: 'A grant cannot be approved by its beneficiary or requester' }],
      [`POST /v1/access/assignments/${G_PENDING}/reject`]: [200, { id: G_PENDING, state: 'REVOKED' }],
      [`POST /v1/access/assignments/${G_ACTIVE}/revoke`]: [200, { id: G_ACTIVE, state: 'REVOKED' }],
    });
    renderPage(READ, APPROVE, REVOKE, READ_ORG);
    const queue = await findSection('Pending approvals (1)');
    await within(queue).findByText('Synthetic payroll review');
    const row = () => rowWith(queue, 'Synthetic payroll review');
    expect(await within(row()).findByText('syn.admin · you')).toBeTruthy();
    // The approver sees the restriction it would approve, named from the department master.
    expect(await within(row()).findByText('Departments: Engineering (SYN-ENG)')).toBeTruthy();

    // The server refuses self-approval; the screen shows its answer rather than guessing.
    fireEvent.click(within(row()).getByRole('button', { name: 'Approve' }));
    expect((await within(queue).findByRole('alert')).textContent).toContain('SELF_APPROVAL');
    expect(callsTo('POST', `/v1/access/assignments/${G_PENDING}/approve`).map((c) => c.body)).toStrictEqual([{ expectedVersion: 1 }]);

    fireEvent.click(within(row()).getByRole('button', { name: 'Reject' }));
    const confirmReject = within(row()).getByRole('button', { name: 'Confirm rejection' }) as HTMLButtonElement;
    const reason = within(row()).getByLabelText('Reason for rejection');
    expect(confirmReject.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(confirmReject.disabled).toBe(true);
    fireEvent.submit(reason.closest('form')!);
    expect(callsTo('POST', `/v1/access/assignments/${G_PENDING}/reject`)).toHaveLength(0);
    fireEvent.change(reason, { target: { value: 'Not needed (synthetic)' } });
    expect(confirmReject.disabled).toBe(false);
    const loadsBefore = callsTo('GET', '/v1/access/assignments').length;
    fireEvent.click(confirmReject);
    await waitFor(() => expect(callsTo('POST', `/v1/access/assignments/${G_PENDING}/reject`)).toHaveLength(1));
    expect(callsTo('POST', `/v1/access/assignments/${G_PENDING}/reject`)[0]!.body).toStrictEqual({ expectedVersion: 1, reason: 'Not needed (synthetic)' });
    expect(await within(queue).findByText('Rejected: HR Administrator for Asha Synthetic (SYN-001).')).toBeTruthy();
    await waitFor(() => expect(callsTo('GET', '/v1/access/assignments').length).toBeGreaterThan(loadsBefore)); // lists refreshed

    const panel = await selectAsha();
    await within(panel).findByText('EMPLOYEE');
    const active = () => rowWith(panel, 'EMPLOYEE');
    expect(within(active()).queryByRole('button', { name: 'Approve' })).toBeNull();
    fireEvent.click(within(active()).getByRole('button', { name: 'Revoke' }));
    const confirmRevoke = within(active()).getByRole('button', { name: 'Confirm revocation' }) as HTMLButtonElement;
    expect(confirmRevoke.disabled).toBe(true);
    expect(within(active()).queryByText(/assignment you are signed in with/)).toBeNull(); // someone else's grant
    fireEvent.change(within(active()).getByLabelText('Reason for revocation'), { target: { value: 'Role change (synthetic)' } });
    fireEvent.click(confirmRevoke);
    await waitFor(() => expect(callsTo('POST', `/v1/access/assignments/${G_ACTIVE}/revoke`)).toHaveLength(1));
    expect(callsTo('POST', `/v1/access/assignments/${G_ACTIVE}/revoke`)[0]!.body).toStrictEqual({ expectedVersion: 3, reason: 'Role change (synthetic)' });
  });

  it('reloads a grant whose version went stale, then approves with the fresh version', async () => {
    let version = 1;
    serve({
      'GET /v1/access/assignments': (c) => [
        200,
        { items: c.params.get('state') === 'PENDING' ? [{ ...PENDING_GRANT, version, purpose: version === 1 ? 'Synthetic payroll review' : 'Synthetic payroll review (amended)' }] : [] },
      ],
      [`POST /v1/access/assignments/${G_PENDING}/approve`]: (c) =>
        (c.body as { expectedVersion: number }).expectedVersion === version
          ? [200, { id: G_PENDING, state: 'ACTIVE' }]
          : [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }],
    });
    renderPage(READ, APPROVE);
    const queue = await findSection('Pending approvals (1)');
    await within(queue).findByText('Synthetic payroll review');
    version = 2; // someone else changed the grant in the meantime
    fireEvent.click(within(queue).getByRole('button', { name: 'Approve' }));
    expect((await within(queue).findByRole('alert')).textContent).toContain('STALE_VERSION');
    await within(queue).findByText('Synthetic payroll review (amended)'); // reloaded without a manual refresh
    fireEvent.click(within(queue).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(callsTo('POST', `/v1/access/assignments/${G_PENDING}/approve`)).toHaveLength(2));
    expect(callsTo('POST', `/v1/access/assignments/${G_PENDING}/approve`).map((c) => c.body)).toStrictEqual([{ expectedVersion: 1 }, { expectedVersion: 2 }]);
    expect(await within(queue).findByText(/^Approved: HR Administrator for /)).toBeTruthy();
  });

  it('explains a pending grant that someone else decided first', async () => {
    let decidedElsewhere = false;
    serve({
      'GET /v1/access/assignments': (c) => [200, { items: c.params.get('state') === 'PENDING' && !decidedElsewhere ? [PENDING_GRANT] : [] }],
      [`POST /v1/access/assignments/${G_PENDING}/approve`]: () => {
        decidedElsewhere = true; // another approver rejected it a moment earlier
        return [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }];
      },
    });
    renderPage(READ, APPROVE);
    const queue = await findSection('Pending approvals (1)');
    fireEvent.click(await within(queue).findByRole('button', { name: 'Approve' }));
    // The row leaves the reloaded list; the list still says the decision did not go through.
    expect(await within(queue).findByText('No grants are waiting for approval.')).toBeTruthy();
    expect(within(queue).getByText(/changed before your decision, so the lists were reloaded/)).toBeTruthy();
    expect(within(queue).queryByText(/^Approved:/)).toBeNull();
  });

  it('warns before revoking the assignment in use, then hides earlier answers once the server refuses it', async () => {
    let revoked = false;
    serve({
      'GET /v1/access/users': () => (revoked ? FORBIDDEN : [200, { items: USERS, total: USERS.length }]),
      'GET /v1/access/assignments': (c) => (revoked ? FORBIDDEN : [200, { items: c.params.get('userId') === ADMIN ? [MY_GRANT] : [] }]),
      [`POST /v1/access/assignments/${MY_ASSIGNMENT}/revoke`]: () => {
        revoked = true;
        return [200, { id: MY_ASSIGNMENT, state: 'REVOKED' }];
      },
    });
    renderPage(READ, REVOKE);
    fireEvent.click(await screen.findByRole('button', { name: 'Show assignments for syn.admin' }));
    const panel = await findSection('Assignments of syn.admin · you');
    fireEvent.click(await within(panel).findByRole('button', { name: 'Revoke' }));
    expect(within(panel).getByText(/assignment you are signed in with: revoking it ends your access/)).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText('Reason for revocation'), { target: { value: 'Leaving the role (synthetic)' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Confirm revocation' }));
    await waitFor(() => expect(callsTo('POST', `/v1/access/assignments/${MY_ASSIGNMENT}/revoke`)).toHaveLength(1));
    expect(callsTo('POST', `/v1/access/assignments/${MY_ASSIGNMENT}/revoke`)[0]!.body).toStrictEqual({ expectedVersion: 2, reason: 'Leaving the role (synthetic)' });

    // From now on the server refuses this assignment: what it answered before is no longer shown.
    expect(await within(panel).findByText(/cannot read role assignments/)).toBeTruthy();
    expect(within(panel).queryByText('SYSTEM_ADMINISTRATOR')).toBeNull();
    expect(await screen.findByText(/cannot list users/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Show assignments for/ })).toBeNull();
  });

  it('offers only the decisions the selected assignment can make', async () => {
    serve();
    renderPage(READ, REVOKE);
    let panel = await selectAsha();
    await within(panel).findByText('Synthetic payroll review');
    expect(within(rowWith(panel, 'EMPLOYEE')).getByRole('button', { name: 'Revoke' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Pending approvals/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /Propose a grant/ })).toBeNull();
    cleanup();

    serve();
    renderPage(READ, APPROVE);
    await findSection('Pending approvals (1)');
    panel = await selectAsha();
    await within(panel).findByText('Synthetic payroll review');
    const pending = rowWith(panel, 'Synthetic payroll review');
    expect(within(pending).getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(within(pending).getByRole('button', { name: 'Reject' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });
});
