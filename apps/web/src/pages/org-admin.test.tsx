// User accounts and reference values (§5.1; DB007; DB009; FR-004; DF04), jsdom: each action sends what the server needs with the
// version it read, nothing is offered without the duty, protected lists and codes offer no change, and a refusal is shown.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ORG_ADMIN_SCREENS, ReferenceValuesPage, UserAccountsPage } from './org-admin';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({ useSession: () => ({ can: (p: string) => session.permissions.includes(p) }) }));

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
type Route = unknown | ((call: Call) => [number, unknown]);

function mockApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const call: Call = { url, method, body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const key = Object.keys(routes).find((k) => `${method} ${url}`.startsWith(k));
      const route = key ? routes[key] : undefined;
      const [status, payload] = typeof route === 'function' ? (route as (c: Call) => [number, unknown])(call) : key ? [200, route] : [404, { error: 'NOT_FOUND', message: 'Not found' }];
      return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
    }),
  );
  return calls;
}
const renderPage = (ui: JSX.Element) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const posts = (calls: Call[], fragment: string) => calls.filter((c) => c.method !== 'GET' && c.url.includes(fragment));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

const USER = { userId: 'u-1', accountKey: 'syn.one', active: true, version: 4, employee: { id: 'e-1', employeeCode: 'SYN-1', displayName: 'Synthetic One' }, assignments: { active: 1, pending: 0 } };
const OFF = { ...USER, userId: 'u-2', accountKey: 'syn.two', active: false, version: 7, employee: null };
const LINK = { id: 'l-1', userId: 'u-1', accountKey: 'syn.one', employeeId: 'e-1', employeeCode: 'SYN-1', employeeName: 'Synthetic One', effectiveFrom: '2026-01-05', effectiveTo: null, inForce: true, version: 3 };
const ENDED = { ...LINK, id: 'l-0', effectiveTo: '2026-01-05', inForce: false, version: 2 };
const userRoutes = { 'GET /v1/access/users': { items: [USER, OFF], total: 2 }, 'GET /v1/access/user-links': { items: [LINK, ENDED], total: 2 } };

describe('user accounts', () => {
  it('registers its screens under the read duties', () => {
    expect(ORG_ADMIN_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([
      ['/admin/user-accounts', 'access.read_users.operational', true],
      ['/admin/reference-values', 'reference_value.read.operational', true],
    ]);
  });

  it('a reader sees accounts and links but is offered no change', async () => {
    session.permissions = ['access.read_users.operational'];
    const calls = mockApi(userRoutes);
    renderPage(<UserAccountsPage />);
    await screen.findByText('syn.one');
    expect(screen.getByText('Inactive')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Link an account' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Deactivate|Reactivate/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show links of syn.one' }));
    await screen.findByText('In force');
    expect(screen.queryByRole('button', { name: /End link/ })).toBeNull();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('links by exact account key and the employee of that code, and says a link grants nothing', async () => {
    session.permissions = ['access.read_users.operational', 'access.link_user.operational'];
    const calls = mockApi({
      ...userRoutes,
      'GET /v1/employees': { items: [{ id: 'e-9x', employeeCode: 'SYN-90' }, { id: 'e-9', employeeCode: 'SYN-9' }], total: 2 },
      'POST /v1/access/user-links': { id: 'l-9', version: 1 },
    });
    renderPage(<UserAccountsPage />);
    const form = await screen.findByRole('form', { name: 'Link an account' });
    expect(within(form).getByText(/gives the account no permission/)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText('Account key'), { target: { value: ' syn.new ' } });
    fireEvent.change(within(form).getByLabelText('Employee code'), { target: { value: 'syn-9' } });
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-02-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Link account' }));
    await waitFor(() => expect(posts(calls, '/user-links')).toHaveLength(1));
    // An exact code match, never the first search hit; optional fields stay out.
    expect(posts(calls, '/user-links')[0]!.body).toEqual({ accountKey: 'syn.new', employeeId: 'e-9', effectiveFrom: '2026-02-01' });
  });

  it('sends nothing when no employee has that exact code, and shows the server refusal of an overlap', async () => {
    session.permissions = ['access.read_users.operational', 'access.link_user.operational'];
    const calls = mockApi({
      ...userRoutes,
      'GET /v1/employees': { items: [{ id: 'e-90', employeeCode: 'SYN-90' }], total: 1 },
      'POST /v1/access/user-links': () => [409, { error: 'OVERLAPPING_PERIOD', message: 'The effective period overlaps an existing record' }],
    });
    renderPage(<UserAccountsPage />);
    const form = await screen.findByRole('form', { name: 'Link an account' });
    fireEvent.change(within(form).getByLabelText('Account key'), { target: { value: 'syn.new' } });
    fireEvent.change(within(form).getByLabelText('Employee code'), { target: { value: 'SYN-9' } });
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-02-01' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Link account' }));
    await within(form).findByText(/No employee with that code/);
    expect(posts(calls, '/user-links')).toEqual([]);

    fireEvent.change(within(form).getByLabelText('Employee code'), { target: { value: 'SYN-90' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Link account' }));
    await within(form).findByText(/overlaps an existing record/);
  });

  it('deactivates and reactivates with a required reason and the version it read', async () => {
    session.permissions = ['access.read_users.operational', 'access.deactivate_user.operational'];
    const calls = mockApi({ ...userRoutes, 'POST /v1/access/users/u-1/deactivate': { userId: 'u-1', active: false, version: 5 }, 'POST /v1/access/users/u-2/reactivate': { userId: 'u-2', active: true, version: 8 } });
    renderPage(<UserAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate syn.one' }));
    const form = screen.getByRole('form', { name: 'Deactivate syn.one' });
    const confirm = within(form).getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText(/Reason/), { target: { value: ' Left the company (synthetic) ' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(posts(calls, '/deactivate')).toHaveLength(1));
    expect(posts(calls, '/deactivate')[0]!.body).toEqual({ expectedVersion: 4, reason: 'Left the company (synthetic)' });

    fireEvent.click(await screen.findByRole('button', { name: 'Reactivate syn.two' }));
    const back = screen.getByRole('form', { name: 'Reactivate syn.two' });
    fireEvent.change(within(back).getByLabelText(/Reason/), { target: { value: 'Returned (synthetic)' } });
    fireEvent.click(within(back).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(posts(calls, '/reactivate')).toHaveLength(1));
    expect(posts(calls, '/reactivate')[0]!.body).toEqual({ expectedVersion: 7, reason: 'Returned (synthetic)' });
  });

  it('shows why an account that serves another company was refused', async () => {
    session.permissions = ['access.read_users.operational', 'access.deactivate_user.operational'];
    mockApi({ ...userRoutes, 'POST /v1/access/users/u-1/deactivate': () => [409, { error: 'ACCOUNT_SPANS_COMPANIES', message: 'This account also serves another company, so one company cannot change it' }] });
    renderPage(<UserAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deactivate syn.one' }));
    const form = screen.getByRole('form', { name: 'Deactivate syn.one' });
    fireEvent.change(within(form).getByLabelText(/Reason/), { target: { value: 'Synthetic' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm' }));
    await screen.findByText(/also serves another company/);
  });

  it('ends a link in force with a reason; an ended link offers nothing', async () => {
    session.permissions = ['access.read_users.operational', 'access.link_user.operational'];
    const calls = mockApi({ ...userRoutes, 'POST /v1/access/user-links/l-1/end': { id: 'l-1', effectiveTo: '2026-11-02', version: 4 } });
    renderPage(<UserAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Show links of syn.one' }));
    await screen.findByText('In force');
    expect(screen.getAllByRole('button', { name: 'End link to SYN-1' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'End link to SYN-1' }));
    const form = screen.getByRole('form', { name: 'End link to SYN-1' });
    fireEvent.change(within(form).getByLabelText(/Reason/), { target: { value: 'Moved on (synthetic)' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(posts(calls, '/end')).toHaveLength(1));
    expect(posts(calls, '/end')[0]!.body).toEqual({ expectedVersion: 3, reason: 'Moved on (synthetic)' });
  });
});

describe('reference values', () => {
  const CATEGORIES = {
    items: [
      { category: 'EMPLOYEE_STATUS', maintainable: false, protectedCodes: [] },
      { category: 'HOLIDAY_TYPE', maintainable: true, protectedCodes: ['HOLIDAY'] },
    ],
  };
  const VALUES = {
    items: [
      { id: 'v-1', category: 'HOLIDAY_TYPE', code: 'HOLIDAY', label: 'Holiday', active: true, validFrom: null, validTo: null, version: 2 },
      { id: 'v-2', category: 'HOLIDAY_TYPE', code: 'RESTRICTED', label: 'Restricted', active: true, validFrom: null, validTo: null, version: 5 },
    ],
  };
  const routes = {
    'GET /v1/reference-admin/categories': CATEGORIES,
    'GET /v1/reference-admin/values?category=HOLIDAY_TYPE': VALUES,
    'GET /v1/reference-admin/values?category=EMPLOYEE_STATUS': { items: [{ id: 'v-9', category: 'EMPLOYEE_STATUS', code: 'DRAFT', label: 'Draft', active: true, validFrom: null, validTo: null, version: 1 }] },
  };
  const choose = async (category: string) => {
    const list = await screen.findByLabelText(/^List/);
    await screen.findByRole('option', { name: /HOLIDAY_TYPE/ });
    fireEvent.change(list, { target: { value: category } });
  };

  it('a protected list is read-only even for a manager, and says why', async () => {
    session.permissions = ['reference_value.read.operational', 'reference_value.manage.operational'];
    const calls = mockApi(routes);
    renderPage(<ReferenceValuesPage />);
    await choose('EMPLOYEE_STATUS');
    await screen.findByText('Draft');
    expect(screen.getByText(/application depends on this list/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Add a value' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save|Deactivate/ })).toBeNull();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a reader without the manage duty changes nothing, on a maintainable list too', async () => {
    session.permissions = ['reference_value.read.operational'];
    mockApi(routes);
    renderPage(<ReferenceValuesPage />);
    await choose('HOLIDAY_TYPE');
    await screen.findByText('Restricted');
    expect(screen.queryByRole('form', { name: 'Add a value' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Save|Deactivate/ })).toBeNull();
  });

  it('adds a value, sending optional dates only when given', async () => {
    session.permissions = ['reference_value.read.operational', 'reference_value.manage.operational'];
    const calls = mockApi({ ...routes, 'POST /v1/reference-admin/values': { id: 'v-3' } });
    renderPage(<ReferenceValuesPage />);
    await choose('HOLIDAY_TYPE');
    const form = await screen.findByRole('form', { name: 'Add a value' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: ' seasonal ' } });
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: ' Seasonal (synthetic) ' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add value' }));
    await waitFor(() => expect(posts(calls, '/values')).toHaveLength(1));
    expect(posts(calls, '/values')[0]!.body).toEqual({ category: 'HOLIDAY_TYPE', code: 'seasonal', label: 'Seasonal (synthetic)' });
  });

  it('relabels and end-dates with the version it read, and deactivates; a protected code can only be relabelled', async () => {
    session.permissions = ['reference_value.read.operational', 'reference_value.manage.operational'];
    const calls = mockApi({ ...routes, 'PATCH /v1/reference-admin/values/v-2': { id: 'v-2' }, 'PATCH /v1/reference-admin/values/v-1': { id: 'v-1' } });
    renderPage(<ReferenceValuesPage />);
    await choose('HOLIDAY_TYPE');
    await screen.findByLabelText('Label of RESTRICTED');

    fireEvent.change(screen.getByLabelText('Label of RESTRICTED'), { target: { value: 'Optional (synthetic)' } });
    fireEvent.change(screen.getByLabelText('Until for RESTRICTED'), { target: { value: '2027-01-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save RESTRICTED' }));
    await waitFor(() => expect(posts(calls, '/v-2')).toHaveLength(1));
    expect(posts(calls, '/v-2')[0]).toMatchObject({ method: 'PATCH', body: { expectedVersion: 5, label: 'Optional (synthetic)', validTo: '2027-01-01' } });

    fireEvent.click(screen.getByRole('button', { name: 'Deactivate RESTRICTED' }));
    await waitFor(() => expect(posts(calls, '/v-2')).toHaveLength(2));
    expect(posts(calls, '/v-2')[1]!.body).toEqual({ expectedVersion: 5, active: false });

    // The code the application uses by name: a label, no end date and no deactivation.
    expect(screen.queryByLabelText('Until for HOLIDAY')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Deactivate HOLIDAY' })).toBeNull();
    expect(screen.getByText(/stays in force/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Label of HOLIDAY'), { target: { value: 'Public holiday (synthetic)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save HOLIDAY' }));
    await waitFor(() => expect(posts(calls, '/v-1')).toHaveLength(1));
    expect(posts(calls, '/v-1')[0]!.body).toEqual({ expectedVersion: 2, label: 'Public holiday (synthetic)' });
  });

  it('shows a refusal from the server', async () => {
    session.permissions = ['reference_value.read.operational', 'reference_value.manage.operational'];
    mockApi({ ...routes, 'POST /v1/reference-admin/values': () => [409, { error: 'DUPLICATE', message: 'A record with the same unique value already exists' }] });
    renderPage(<ReferenceValuesPage />);
    await choose('HOLIDAY_TYPE');
    const form = await screen.findByRole('form', { name: 'Add a value' });
    fireEvent.change(within(form).getByLabelText('Code'), { target: { value: 'RESTRICTED' } });
    fireEvent.change(within(form).getByLabelText('Label'), { target: { value: 'Again' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Add value' }));
    await within(form).findByText(/same unique value/);
  });
});
