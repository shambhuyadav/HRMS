// User accounts and reference values (§5.1; DB007; DB009; FR-004; DF04), jsdom: each action sends what the server needs with the
// version it read, nothing is offered without the duty, protected lists and codes offer no change, and a refusal is shown.
// Account administration: create, edit, delete and reset password; a temporary password is shown once and kept in no cache.
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

describe('account administration', () => {
  const MANAGER = ['access.read_users.operational', 'access.manage_accounts.operational'];
  const ALPHA = { userId: 'u-11', accountKey: 'syn.alpha@example.invalid', active: true, version: 4, employee: null, assignments: { active: 1, pending: 0 } };
  const BETA = { userId: 'u-12', accountKey: 'syn.beta@example.invalid', active: false, version: 8, employee: null, assignments: { active: 0, pending: 0 } };
  // The versions differ from the list's on purpose: a change is checked against the version read when the panel opened.
  const ALPHA_DETAIL = { userId: 'u-11', accountKey: 'syn.alpha@example.invalid', active: true, version: 6, firstName: 'Synthetic', lastName: 'Alpha', signInAccount: true, signedIn: true, deletable: false };
  const BETA_DETAIL = { userId: 'u-12', accountKey: 'syn.beta@example.invalid', active: false, version: 9, firstName: null, lastName: null, signInAccount: true, signedIn: false, deletable: true };
  const accountRoutes = { 'GET /v1/access/users': { items: [ALPHA, BETA], total: 2 }, 'GET /v1/access/accounts/u-11': ALPHA_DETAIL, 'GET /v1/access/accounts/u-12': BETA_DETAIL };
  const fill = (form: HTMLElement, values: Record<string, string>) => {
    for (const [label, value] of Object.entries(values)) fireEvent.change(within(form).getByLabelText(label), { target: { value } });
  };
  const detailReads = (calls: Call[]) => calls.filter((c) => c.method === 'GET' && c.url.startsWith('/v1/access/accounts/')).map((c) => c.url);

  it('offers no account change without the manage duty', async () => {
    session.permissions = ['access.read_users.operational', 'access.deactivate_user.operational', 'access.link_user.operational'];
    const calls = mockApi(accountRoutes);
    renderPage(<UserAccountsPage />);
    await screen.findByText('syn.alpha@example.invalid');
    expect(screen.getByRole('button', { name: 'Deactivate syn.alpha@example.invalid' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'New account' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^(Edit|Reset password of|Delete) / })).toBeNull();
    expect(calls.filter((c) => c.url.startsWith('/v1/access/accounts'))).toEqual([]);
  });

  it('creates an account after checking the email, shows the temporary password once, and Done clears it', async () => {
    session.permissions = [...MANAGER, 'access.link_user.operational'];
    const calls = mockApi({
      ...accountRoutes,
      'POST /v1/access/accounts': () => [201, { userId: 'u-13', accountKey: 'syn.gamma@example.invalid', version: 1, temporaryPassword: 'Syn-Temp-4821' }],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <UserAccountsPage />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'New account' }));
    const form = screen.getByRole('form', { name: 'New account' });
    fill(form, { 'Email (sign-in)': 'syn.gamma', 'First name': ' Synthetic ', 'Last name': 'Gamma' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create account' }));
    await within(form).findByText(/Enter the email address the person signs in with/);
    expect(posts(calls, '/v1/access/accounts')).toEqual([]);

    const listed = calls.filter((c) => c.url.startsWith('/v1/access/users')).length;
    fill(form, { 'Email (sign-in)': ' syn.gamma@example.invalid ' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create account' }));
    const panel = await screen.findByRole('status', { name: 'Temporary password for syn.gamma@example.invalid' });
    expect(posts(calls, '/v1/access/accounts').map((c) => c.body)).toEqual([{ email: 'syn.gamma@example.invalid', firstName: 'Synthetic', lastName: 'Gamma' }]);
    expect(within(panel).getByText('Syn-Temp-4821')).toBeTruthy();
    expect(within(panel).getByText('Give it to the person privately. It works once: at their first sign-in they choose their own password and set up their authenticator app. It is not shown again.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'New account' })).toBeNull();
    await waitFor(() => expect(calls.filter((c) => c.url.startsWith('/v1/access/users')).length).toBeGreaterThan(listed));
    // Linking the new account is one step away: its key is filled in.
    const link = screen.getByRole('form', { name: 'Link an account' });
    expect((within(link).getByLabelText('Account key') as HTMLInputElement).value).toBe('syn.gamma@example.invalid');

    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      fireEvent.click(within(panel).getByRole('button', { name: 'Copy' }));
      await within(panel).findByText('Copied.');
      expect(writeText).toHaveBeenCalledWith('Syn-Temp-4821');
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard;
    }

    fireEvent.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('status', { name: /Temporary password/ })).toBeNull();
    expect(screen.queryByText('Syn-Temp-4821')).toBeNull();
    // The password was never kept in a query or mutation cache.
    await waitFor(() =>
      expect(JSON.stringify([...client.getQueryCache().getAll().map((q) => q.state.data), ...client.getMutationCache().getAll().map((m) => m.state.data)])).not.toContain('Syn-Temp-4821'),
    );
  });

  it('on a server without a sign-in provider, says the account signs in through the development sign-in', async () => {
    session.permissions = MANAGER;
    mockApi({ ...accountRoutes, 'POST /v1/access/accounts': () => [201, { userId: 'u-13', accountKey: 'syn.gamma@example.invalid', version: 1, temporaryPassword: null }] });
    renderPage(<UserAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New account' }));
    const form = screen.getByRole('form', { name: 'New account' });
    fill(form, { 'Email (sign-in)': 'syn.gamma@example.invalid', 'First name': 'Synthetic', 'Last name': 'Gamma' });
    fireEvent.click(within(form).getByRole('button', { name: 'Create account' }));
    const panel = await screen.findByRole('status', { name: 'Account created for syn.gamma@example.invalid' });
    expect(within(panel).getByText(/the account signs in through the development sign-in/)).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Copy' })).toBeNull();
    // Without the link duty there is no link card to point to.
    expect(within(panel).queryByText(/Link an account to an employee/)).toBeNull();
  });

  it('resets a password after a confirmation with a reason, then shows the temporary password once', async () => {
    session.permissions = MANAGER;
    const calls = mockApi({ ...accountRoutes, 'POST /v1/access/accounts/u-11/reset-password': { userId: 'u-11', temporaryPassword: 'Syn-Reset-7310', sessionsRevoked: 2 } });
    renderPage(<UserAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reset password of syn.alpha@example.invalid' }));
    // An inactive account has no password to reset.
    expect(screen.queryByRole('button', { name: 'Reset password of syn.beta@example.invalid' })).toBeNull();
    const form = screen.getByRole('form', { name: 'Reset the password of syn.alpha@example.invalid' });
    expect(within(form).getByText(/They are signed out and must use the new temporary password\./)).toBeTruthy();
    const confirm = within(form).getByRole('button', { name: 'Reset password' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(within(form).getByLabelText('Reason'), { target: { value: ' Forgot it (synthetic) ' } });
    fireEvent.click(confirm);
    const panel = await screen.findByRole('status', { name: 'Temporary password for syn.alpha@example.invalid' });
    expect(posts(calls, '/reset-password').map((c) => c.body)).toEqual([{ reason: 'Forgot it (synthetic)' }]);
    expect(within(panel).getByText('Syn-Reset-7310')).toBeTruthy();
    expect(within(panel).getByText(/signed out of 2 sessions/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: /Reset the password/ })).toBeNull();
    fireEvent.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(screen.queryByText('Syn-Reset-7310')).toBeNull();
  });

  it('edits with the version read when the panel opened, sending the new values', async () => {
    session.permissions = MANAGER;
    const calls = mockApi({ ...accountRoutes, 'PATCH /v1/access/accounts/u-11': { userId: 'u-11', accountKey: 'syn.alpha2@example.invalid', version: 7 } });
    renderPage(<UserAccountsPage />);
    await screen.findByText('syn.alpha@example.invalid');
    // An account's details are read for the row opened, not for every row.
    expect(detailReads(calls)).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Edit syn.alpha@example.invalid' }));
    const form = await screen.findByRole('form', { name: 'Edit syn.alpha@example.invalid' });
    expect(detailReads(calls)).toEqual(['/v1/access/accounts/u-11']);
    expect((within(form).getByLabelText('Email (sign-in)') as HTMLInputElement).value).toBe('syn.alpha@example.invalid');
    expect((within(form).getByLabelText('First name') as HTMLInputElement).value).toBe('Synthetic');
    expect((within(form).getByLabelText('Last name') as HTMLInputElement).value).toBe('Alpha');
    fill(form, { 'Email (sign-in)': 'syn.alpha2@example.invalid', 'Last name': 'Alpha-Two' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(posts(calls, '/v1/access/accounts/u-11')).toHaveLength(1));
    expect(posts(calls, '/v1/access/accounts/u-11')[0]).toEqual({
      url: '/v1/access/accounts/u-11',
      method: 'PATCH',
      body: { expectedVersion: 6, email: 'syn.alpha2@example.invalid', firstName: 'Synthetic', lastName: 'Alpha-Two' },
    });
    await screen.findByText('Saved syn.alpha2@example.invalid.');
    expect(screen.queryByRole('form', { name: 'Edit syn.alpha@example.invalid' })).toBeNull();
  });

  it('offers Delete only for an account never used, and removes its row after a reason', async () => {
    session.permissions = MANAGER;
    let gone = false;
    const calls = mockApi({
      ...accountRoutes,
      'GET /v1/access/users': () => [200, gone ? { items: [ALPHA], total: 1 } : { items: [ALPHA, BETA], total: 2 }],
      'POST /v1/access/accounts/u-12/delete': () => {
        gone = true;
        return [200, { userId: 'u-12', deleted: true }];
      },
    });
    renderPage(<UserAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit syn.alpha@example.invalid' }));
    await screen.findByRole('form', { name: 'Edit syn.alpha@example.invalid' });
    expect(screen.getByText(/kept for the record: it can be deactivated, not deleted/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Delete / })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit syn.beta@example.invalid' }));
    await screen.findByRole('form', { name: 'Edit syn.beta@example.invalid' });
    expect(screen.queryByRole('form', { name: 'Edit syn.alpha@example.invalid' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete syn.beta@example.invalid' }));
    const confirm = screen.getByRole('form', { name: 'Delete syn.beta@example.invalid' });
    const send = within(confirm).getByRole('button', { name: 'Delete account' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(within(confirm).getByLabelText('Reason'), { target: { value: 'Created by mistake (synthetic)' } });
    fireEvent.click(send);
    await waitFor(() => expect(posts(calls, '/delete')).toHaveLength(1));
    expect(posts(calls, '/delete')[0]!.body).toEqual({ expectedVersion: 9, reason: 'Created by mistake (synthetic)' });
    await screen.findByText('Deleted syn.beta@example.invalid.');
    expect(screen.queryByRole('cell', { name: 'syn.beta@example.invalid' })).toBeNull();
    expect(screen.getByRole('cell', { name: 'syn.alpha@example.invalid' })).toBeTruthy();
  });

  it('says plainly why a delete or a password reset was refused', async () => {
    session.permissions = MANAGER;
    mockApi({
      ...accountRoutes,
      'POST /v1/access/accounts/u-12/delete': () => [409, { error: 'ACCOUNT_IN_USE', message: 'This account has been used, so it is kept for the record: deactivate it instead' }],
      'POST /v1/access/accounts/u-11/reset-password': () => [403, { error: 'SELF_ACTION_NOT_ALLOWED', message: 'Not on your own account' }],
    });
    renderPage(<UserAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit syn.beta@example.invalid' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete syn.beta@example.invalid' }));
    const confirm = screen.getByRole('form', { name: 'Delete syn.beta@example.invalid' });
    fireEvent.change(within(confirm).getByLabelText('Reason'), { target: { value: 'Synthetic' } });
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete account' }));
    await screen.findByText('This account has been used, so it is kept for the record and cannot be deleted. Deactivate it instead.');
    expect(screen.getByRole('cell', { name: 'syn.beta@example.invalid' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Reset password of syn.alpha@example.invalid' }));
    const reset = screen.getByRole('form', { name: 'Reset the password of syn.alpha@example.invalid' });
    fireEvent.change(within(reset).getByLabelText('Reason'), { target: { value: 'Synthetic' } });
    fireEvent.click(within(reset).getByRole('button', { name: 'Reset password' }));
    await within(reset).findByText('You cannot change your own account here; another administrator must do it.');
    expect(screen.queryByRole('status', { name: /Temporary password/ })).toBeNull();
  });

  it('shows a taken email and a stale edit in plain words, reloading the account after the stale one', async () => {
    session.permissions = MANAGER;
    const calls = mockApi({
      ...accountRoutes,
      'PATCH /v1/access/accounts/u-11': () => [409, { error: 'STALE_VERSION', message: 'The record was changed by someone else' }],
      'POST /v1/access/accounts': () => [409, { error: 'ACCOUNT_EXISTS', message: 'An account with this email already exists' }],
    });
    renderPage(<UserAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New account' }));
    const create = screen.getByRole('form', { name: 'New account' });
    fill(create, { 'Email (sign-in)': 'syn.alpha@example.invalid', 'First name': 'Synthetic', 'Last name': 'Again' });
    fireEvent.click(within(create).getByRole('button', { name: 'Create account' }));
    await within(create).findByText(/An account with this email already exists\. Use another email/);
    expect(screen.queryByRole('status', { name: /Temporary password/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Edit syn.alpha@example.invalid' }));
    const form = await screen.findByRole('form', { name: 'Edit syn.alpha@example.invalid' });
    fill(form, { 'First name': 'Changed' });
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await screen.findByText(/This account changed since you opened it, so nothing was saved/);
    await waitFor(() => expect(detailReads(calls)).toHaveLength(2));
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
