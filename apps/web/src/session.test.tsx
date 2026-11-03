// Session lifecycle (jsdom, real SessionProvider): nothing cached for one user, company or role is shown under
// another (web-1), and a reload keeps the session because the very first requests already carry the stored token
// (web-6). The fetch mock plays a small synthetic server that answers by bearer token and assignment header.
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setSession } from './api';
import { SelectRolePage, SignInPage } from './pages/auth';
import { EmployeeDocumentsPage } from './pages/records';
import { SessionProvider, useSession } from './session';

type Call = { method: string; url: string; headers: Record<string, string>; body: Record<string, unknown> | undefined };
type Reply = [number, unknown];

const C1 = { id: 'c-1', code: 'SYN', name: 'Synthetic Co' };
const C2 = { id: 'c-2', code: 'SYN2', name: 'Synthetic Two' };
const ROLES = {
  hrAll: { id: 'a-hr-all', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR Administrator', accessClass: 'ADMIN', scopeKind: 'COMPANY' },
  hrFinance: { id: 'a-hr-fin', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR Administrator (Finance)', accessClass: 'ADMIN', scopeKind: 'COMPANY' },
  employee: { id: 'a-emp', roleCode: 'EMPLOYEE', roleName: 'Employee', accessClass: 'OTHER', scopeKind: 'OWN' },
};
const USERS: Record<string, { token: string; roles: (typeof ROLES)[keyof typeof ROLES][] }> = {
  'syn.hr': { token: 'tok-hr', roles: [ROLES.hrAll, ROLES.hrFinance] },
  'syn.emp': { token: 'tok-emp', roles: [ROLES.employee] },
};
const DOCUMENT = { id: 'd-1', documentType: 'CONTRACT', fileName: 'synthetic-contract.pdf', mediaType: 'application/pdf', byteSize: 10, expiresOn: null, expired: false, uploadedAt: '2026-10-01T05:00:00Z' };

let calls: Call[] = [];
/** `extra` may answer first; a promise is an answer still on its way. */
function serve(extra: (c: Call) => Reply | Promise<Reply> | undefined = () => undefined) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? 'GET', url, headers: { ...((init?.headers ?? {}) as Record<string, string>) }, body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const [status, body] = (await extra(call)) ?? syntheticServer(call);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function syntheticServer(c: Call): Reply {
  if (c.method === 'POST' && c.url === '/dev/login') {
    const user = USERS[String(c.body?.accountKey)];
    return user ? [200, { token: user.token, companies: [C1] }] : [401, { error: 'UNKNOWN_ACCOUNT', message: 'Unknown account' }];
  }
  const token = c.headers.authorization?.replace(/^Bearer /, '');
  const user = Object.values(USERS).find((u) => u.token === token);
  if (!user) return [401, { error: 'UNAUTHENTICATED', message: 'Sign in again' }];
  const role = user.roles.find((r) => r.id === c.headers['x-hrms-assignment']);
  if (c.url === '/v1/me/logout') return [200, { ok: true }];
  if (c.url === '/v1/me/assignments') return [200, { items: user.roles }];
  if (!role) return [403, { error: 'ASSIGNMENT_REQUIRED', message: 'Choose a role' }];
  if (c.url === '/v1/me/context') return [200, { accountKey: 'syn', companyName: C1.name, roleCode: role.roleCode, roleName: role.roleName, scopeKind: role.scopeKind, employeeId: null, displayName: null }];
  if (c.url === '/v1/me/permissions') return [200, { permissions: role === ROLES.employee ? [] : ['document.read.document', 'document.upload.document'] }];
  if (c.url === '/v1/employees/emp-9/documents') {
    // Only the all-departments HR role reaches this employee; the Finance-only role is out of row scope.
    if (role === ROLES.hrAll) return [200, { items: [DOCUMENT] }];
    return role === ROLES.hrFinance ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : [403, { error: 'FORBIDDEN', message: 'Not permitted' }];
  }
  if (c.url === '/v1/dashboard') return [200, { title: 'Synthetic dashboard' }];
  return [404, { error: 'NOT_FOUND', message: 'Not found' }];
}

/** The same query defaults as main.tsx (retries off so refusals show at once). */
const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 15_000 } } });

/** A cut-down App: sign-in, role choice, then the documents page with Switch role and Sign out. */
function Harness() {
  const { stored, switchRole, signOut } = useSession();
  if (!stored) return <SignInPage />;
  if (!stored.companyId || !stored.assignmentId) return <SelectRolePage />;
  return (
    <>
      <button onClick={switchRole}>Switch role</button>
      <button onClick={() => void signOut()}>Sign out</button>
      <Routes>
        <Route path="/employees/:id/documents" element={<EmployeeDocumentsPage />} />
      </Routes>
    </>
  );
}

function renderApp(client = newClient()) {
  render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <MemoryRouter initialEntries={['/employees/emp-9/documents']}>
          <Harness />
        </MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>,
  );
  return client;
}

async function signInAs(accountKey: string) {
  fireEvent.change(await screen.findByLabelText('Account key'), { target: { value: accountKey } });
  fireEvent.click(screen.getByText('Sign in'));
}

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setSession(null);
  sessionStorage.clear();
});

describe('cached data never crosses users, companies or roles (web-1)', () => {
  it('the role picker of the next user never lists the previous user’s roles', async () => {
    serve();
    renderApp();
    await signInAs('syn.hr');
    expect(await screen.findByText('HR Administrator (Finance)')).toBeTruthy();
    fireEvent.click(screen.getByText('Sign out'));
    await signInAs('syn.emp');
    expect(await screen.findByText('Employee')).toBeTruthy();
    expect(screen.queryByText('HR Administrator')).toBeNull();
    expect(screen.queryByText('HR Administrator (Finance)')).toBeNull();
  });

  it('a role switch drops the documents list cached under the previous role', async () => {
    serve();
    const client = renderApp();
    await signInAs('syn.hr');
    fireEvent.click(await screen.findByText('HR Administrator'));
    expect(await screen.findByText('synthetic-contract.pdf')).toBeTruthy();

    fireEvent.click(screen.getByText('Switch role'));
    fireEvent.click(await screen.findByText('HR Administrator (Finance)'));
    // The narrower role is out of scope for this employee: the server's answer is shown, never the old list.
    expect(await screen.findByText(/NOT_FOUND/)).toBeTruthy();
    expect(screen.queryByText('synthetic-contract.pdf')).toBeNull();
    expect(client.getQueryData(['documents', 'emp-9'])).toBeUndefined();
  });

  it('an answer for the previous role that arrives after the switch is dropped, never shown under the new role', async () => {
    let release: () => void = () => undefined;
    const late = new Promise<Reply>((resolve) => (release = () => resolve([200, { items: [DOCUMENT] }])));
    serve((c) => (c.url === '/v1/employees/emp-9/documents' && c.headers['x-hrms-assignment'] === ROLES.hrAll.id ? late : undefined));
    const client = renderApp();
    await signInAs('syn.hr');
    fireEvent.click(await screen.findByText('HR Administrator'));
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/employees/emp-9/documents')).toBe(true));

    fireEvent.click(screen.getByText('Switch role'));
    fireEvent.click(await screen.findByText('HR Administrator (Finance)'));
    expect(await screen.findByText(/NOT_FOUND/)).toBeTruthy();
    await act(async () => {
      release();
      await late;
    });
    expect(screen.queryByText('synthetic-contract.pdf')).toBeNull();
    expect(client.getQueryData(['documents', 'emp-9'])).toBeUndefined();
    // The narrower role asked for itself rather than sharing the earlier role's request.
    const asked = calls.filter((c) => c.url === '/v1/employees/emp-9/documents').map((c) => c.headers['x-hrms-assignment']);
    expect(asked).toEqual([ROLES.hrAll.id, ROLES.hrFinance.id]);
  });

  it('sign-in, company choice, role choice, role switch, sign-out and a 401 each empty the cache', async () => {
    serve();
    const client = newClient();
    function Controls() {
      const s = useSession();
      return (
        <>
          <button onClick={() => s.signIn('tok-hr', [C1, C2])}>do sign in</button>
          <button onClick={() => s.selectCompany('c-1')}>do company</button>
          <button onClick={() => s.selectAssignment('a-hr-all')}>do assignment</button>
          <button onClick={() => s.switchRole()}>do switch</button>
          <button onClick={() => void s.signOut()}>do sign out</button>
        </>
      );
    }
    render(
      <QueryClientProvider client={client}>
        <SessionProvider>
          <Controls />
        </SessionProvider>
      </QueryClientProvider>,
    );
    for (const action of ['do sign in', 'do company', 'do assignment', 'do switch', 'do assignment', 'do sign out']) {
      client.setQueryData(['cached', action], 'value from the previous context');
      fireEvent.click(screen.getByText(action));
      await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(0));
    }

    // A 401 for the session in use signs out and empties the cache too.
    fireEvent.click(screen.getByText('do sign in'));
    fireEvent.click(screen.getByText('do company'));
    fireEvent.click(screen.getByText('do assignment'));
    serve((c) => (c.url === '/v1/employees' ? [401, { error: 'SESSION_IDLE', message: 'The session is no longer valid; sign in again' }] : undefined));
    client.setQueryData(['cached', '401'], 'value');
    await act(async () => {
      await api('/v1/employees').catch(() => undefined);
    });
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(sessionStorage.getItem('hrms.session')).toBeNull();
  });
});

describe('a reload keeps the session (web-6)', () => {
  it('the first request after a reload carries the stored token, company and role', async () => {
    sessionStorage.setItem('hrms.session', JSON.stringify({ token: 'tok-hr', companies: [C1], companyId: 'c-1', assignmentId: 'a-hr-all' }));
    serve();
    function Probe() {
      const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<{ title: string }>('/v1/dashboard') });
      return <p>{q.data?.title ?? (q.error ? 'failed' : 'loading')}</p>;
    }
    render(
      <QueryClientProvider client={newClient()}>
        <SessionProvider>
          <Probe />
        </SessionProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/dashboard')).toBe(true));
    const first = calls.find((c) => c.url === '/v1/dashboard')!;
    expect(first.headers.authorization).toBe('Bearer tok-hr');
    expect(await screen.findByText('Synthetic dashboard')).toBeTruthy();
    expect(first.headers['x-hrms-company']).toBe('c-1');
    expect(first.headers['x-hrms-assignment']).toBe('a-hr-all');
    expect(calls.every((c) => c.headers.authorization === 'Bearer tok-hr')).toBe(true);
    expect(JSON.parse(sessionStorage.getItem('hrms.session')!)).toMatchObject({ token: 'tok-hr', assignmentId: 'a-hr-all' });
  });
});
