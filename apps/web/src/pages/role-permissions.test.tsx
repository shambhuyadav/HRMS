// Role permissions screen (C3 maintain_role_permissions; FR-066; FR-067), jsdom: proposals send what was chosen, decisions carry the row
// version and a rejection needs its reason, controls follow the selected role's permissions, and the record shows who decided what.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ROLE_PERMISSION_SCREENS, RolePermissionsPage } from './role-permissions';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'syn-token', companies: [], companyId: 'syn-company', assignmentId: 'syn-assignment' },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

const READ = 'access.read_users.operational';
const MAINTAIN = 'access.maintain_role_permissions.operational';
const APPROVE = 'access.approve_role_grant.operational';

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
function mockApi(routes: Record<string, unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${url}`];
      const [status, body] = Array.isArray(route) ? (route as [number, unknown]) : route === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : [200, route];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const page = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><RolePermissionsPage /></QueryClientProvider>);

const LIST = '/v1/access/role-permission-changes';
const ROLES = { items: [{ code: 'EMPLOYEE', name: 'Employee', active: true, permissions: [{ key: 'leave.read.operational' }], restorable: ['holiday.read.operational'] }, { code: 'OLD_ROLE', name: 'Old role', active: false, permissions: [], restorable: [] }] };
const OPEN = { id: 'c-1', roleCode: 'EMPLOYEE', permission: 'leave.read.operational', change: 'REMOVE', effectBefore: 'ALLOW', state: 'PROPOSED', reason: 'Synthetic review', requestedByAccountKey: 'syn.one', requestedAt: '2026-11-01T10:00:00Z', decidedByAccountKey: null, decidedAt: null, decisionReason: null, resultingAccess: null, version: 3 };
const DONE = { ...OPEN, id: 'c-2', permission: 'mobile_link.read.operational', state: 'APPROVED', decidedByAccountKey: 'syn.two', decidedAt: '2026-11-02T10:00:00Z', resultingAccess: { effectAfter: null, allowlistEntriesEnded: 4 } };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('role permissions', () => {
  it('is offered in the menu under the read duty; without it nothing is asked of the server', async () => {
    expect(ROLE_PERMISSION_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([['/access/role-permissions', READ, true]]);
    const calls = mockApi({});
    page();
    expect(screen.getByText(/cannot see role permission changes/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('proposes exactly what was chosen, from active roles, and needs a reason', async () => {
    session.permissions = [READ, MAINTAIN];
    const calls = mockApi({ [`GET ${LIST}`]: { items: [], total: 0 }, 'GET /v1/access/roles': ROLES, [`POST ${LIST}`]: [201, { id: 'c-9', state: 'PROPOSED' }] });
    page();
    await screen.findByRole('option', { name: 'Employee' });
    expect(screen.queryByRole('option', { name: 'Old role' })).toBeNull();
    const submit = screen.getByText('Propose change') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'EMPLOYEE' } });
    fireEvent.change(screen.getByLabelText('Change'), { target: { value: 'ALLOW' } });
    fireEvent.change(screen.getByLabelText('Permission'), { target: { value: 'holiday.read.operational' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Synthetic: back to baseline' } });
    fireEvent.click(submit);
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ roleCode: 'EMPLOYEE', permission: 'holiday.read.operational', change: 'ALLOW', reason: 'Synthetic: back to baseline' }));
  });

  it('shows the server’s refusal of a proposal', async () => {
    session.permissions = [READ, MAINTAIN];
    mockApi({ [`GET ${LIST}`]: { items: [], total: 0 }, 'GET /v1/access/roles': ROLES, [`POST ${LIST}`]: [422, { error: 'OUTSIDE_ROLE_CEILING', message: 'Role EMPLOYEE cannot hold employee.list.operational' }] });
    page();
    await screen.findByRole('option', { name: 'Employee' });
    fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'EMPLOYEE' } });
    fireEvent.change(screen.getByLabelText('Permission'), { target: { value: 'employee.list.operational' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Synthetic' } });
    fireEvent.click(screen.getByText('Propose change'));
    expect((await screen.findByRole('alert')).textContent).toContain('OUTSIDE_ROLE_CEILING');
  });

  it('approval carries the row version; a rejection needs its reason', async () => {
    session.permissions = [READ, APPROVE];
    const calls = mockApi({
      [`GET ${LIST}`]: { items: [OPEN], total: 1 },
      'GET /v1/access/roles': ROLES,
      [`POST ${LIST}/c-1/approve`]: { id: 'c-1', state: 'APPROVED' },
      [`POST ${LIST}/c-1/reject`]: { id: 'c-1', state: 'REJECTED' },
    });
    page();
    fireEvent.click(await screen.findByText('Approve'));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/approve'))?.body).toEqual({ expectedVersion: 3 }));
    const reject = screen.getByText('Reject') as HTMLButtonElement;
    expect(reject.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Reason for rejecting leave.read.operational'), { target: { value: 'Synthetic: still needed' } });
    fireEvent.click(reject);
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/reject'))?.body).toEqual({ expectedVersion: 3, reason: 'Synthetic: still needed' }));
  });

  it('a holder of the read duty alone sees the record, without proposal or decision controls', async () => {
    session.permissions = [READ];
    const calls = mockApi({ [`GET ${LIST}`]: { items: [OPEN, DONE], total: 2 }, 'GET /v1/access/roles': ROLES });
    page();
    expect(await screen.findByText('leave.read.operational')).toBeTruthy();
    expect(screen.queryByText('Approve')).toBeNull();
    expect(screen.queryByText('Propose change')).toBeNull();
    // FR-067: the decided record says who decided and what resulted.
    expect(screen.getByText('mobile_link.read.operational')).toBeTruthy();
    expect(screen.getByText('Now not in the role; 4 assignment entries ended')).toBeTruthy();
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });
});
