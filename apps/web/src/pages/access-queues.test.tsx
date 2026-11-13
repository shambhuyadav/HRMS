// The System Administrator's access decisions on the decision inbox (FR-096; F2 "Pending independent access grants"): pending
// grants, delegations and role-permission changes are listed with a way to the screen that decides them, and an item the viewer
// asked for, or is part of, says that another administrator decides it. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MODULE_TASK_QUEUES } from '../screens-registry';
import { TasksPage } from './work';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { companyId: 'c-1', assignmentId: 'a-1' },
    me: { accountKey: 'syn.admin', employeeId: null, scopeKind: 'COMPANY', displayName: 'Synthetic Admin', roleName: 'System Administrator' },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

const APPROVE = 'access.approve_role_grant.operational';
const READ_USERS = 'access.read_users.operational';
const person = (accountKey: string, displayName: string | null) => ({ userId: `u-${accountKey}`, accountKey, employeeCode: null, displayName });

const ROUTES: Record<string, unknown> = {
  '/v1/access/assignments?state=PENDING': {
    items: [
      { id: 'g-1', userAccountKey: 'syn.hr', roleCode: 'HR_ADMINISTRATOR', scopeKind: 'COMPANY', effectiveFrom: '2026-11-01', requestedByAccountKey: 'syn.other' },
      { id: 'g-2', userAccountKey: 'syn.payroll', roleCode: 'PAYROLL_OPERATOR', scopeKind: 'COMPANY', effectiveFrom: '2026-11-02', requestedByAccountKey: 'syn.admin' },
    ],
    total: 2,
  },
  '/v1/access/roles': { items: [{ code: 'HR_ADMINISTRATOR', name: 'HR Administrator' }, { code: 'PAYROLL_OPERATOR', name: 'Payroll Operator' }] },
  '/v1/access/delegations?state=PENDING': {
    items: [
      {
        id: 'd-1',
        delegator: person('syn.meera', 'Meera Synthetic'),
        delegate: person('syn.dev', 'Dev Synthetic'),
        kinds: ['LEAVE_REQUEST'],
        effectiveFrom: '2026-11-10',
        effectiveTo: '2026-11-20',
        requestedBy: person('syn.meera', 'Meera Synthetic'),
      },
    ],
  },
  '/v1/access/role-permission-changes': {
    items: [
      { id: 'c-1', roleCode: 'EMPLOYEE', permission: 'holiday.read.operational', change: 'ALLOW', state: 'PROPOSED', requestedByAccountKey: 'syn.other' },
      { id: 'c-2', roleCode: 'EMPLOYEE', permission: 'leave.read.operational', change: 'REMOVE', state: 'APPROVED', requestedByAccountKey: 'syn.other' },
    ],
  },
};

function serve() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = ROUTES[url];
      return new Response(JSON.stringify(body ?? { items: [] }), { status: body === undefined ? 404 : 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <TasksPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('access decisions on the decision inbox', () => {
  it('are registered for the grant approver only', () => {
    expect(MODULE_TASK_QUEUES.filter((q) => q.permission === APPROVE).map((q) => q.title)).toEqual([
      'Access grants to approve',
      'Delegations to approve',
      'Role permission changes to approve',
    ]);
  });

  it('lists what waits, leads to the deciding screen, and names what another administrator must decide', async () => {
    session.permissions = [APPROVE, READ_USERS];
    serve();
    show();
    const grants = await screen.findByRole('list', { name: 'Access grants to approve' });
    const [other, own] = await within(grants).findAllByRole('listitem');
    expect(await within(other!).findByText('HR Administrator for syn.hr')).toBeTruthy();
    expect(other!.textContent).toContain('Company-wide, from 1 Nov 2026; requested by syn.other');
    expect(within(other!).getByRole('link', { name: 'Review on User access' }).getAttribute('href')).toBe('/access');
    expect(own!.textContent).toContain('another administrator approves it');
    expect(within(own!).queryByRole('link')).toBeNull();

    const delegations = await screen.findByRole('list', { name: 'Delegations to approve' });
    expect(await within(delegations).findByText('Meera Synthetic to Dev Synthetic')).toBeTruthy();
    expect(delegations.textContent).toContain('leave request; 10 Nov 2026 to 20 Nov 2026');
    expect(within(delegations).getByRole('link', { name: 'Review on Delegation approvals' }).getAttribute('href')).toBe('/access/delegations');

    // Only proposed changes wait; a decided one is history on its own screen.
    const changes = await screen.findByRole('list', { name: 'Role permission changes to approve' });
    expect(await within(changes).findByText('Allow holiday.read.operational in employee')).toBeTruthy();
    expect(within(changes).getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: 'Role permission changes to approve (1)' })).toBeTruthy();
    expect(screen.queryByText('You have no decision queues in this role.')).toBeNull();
  });
});
