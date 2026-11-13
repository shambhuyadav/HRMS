// Delegation screens (FR-003, FR-068; DF03; C4), jsdom: a request sends exactly what was chosen and asks the server who can
// receive it; an approver is offered approval only when independent, and a rejection or an early end needs a reason; the end
// says that open tasks do not move; a decision task shows that the user acts as a delegate and in which role (FR-096); the
// server's refusals are shown as they are. Synthetic data only.
import { readFileSync } from 'node:fs';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DELEGATION_SCREENS, DelegatedBadge, DelegatedTasksSection } from './delegations';

const DELEGATE = 'access.delegate.operational';
const READ = 'access.read_users.operational';
const APPROVE = 'access.approve_role_grant.operational';
const REVOKE = 'access.revoke_role.operational';

const session = vi.hoisted(() => ({ permissions: [] as string[], accountKey: 'syn.mira', assignmentId: 'assignment-1' }));
vi.mock('../session', () => ({
  useSession: () => ({
    me: { accountKey: session.accountKey, companyName: 'Synthetic Co', roleCode: 'REPORTING_MANAGER', roleName: 'Reporting Manager', scopeKind: 'ASSIGNED', employeeId: null, displayName: 'Synthetic' },
    stored: { token: 'syn-token', companies: [], companyId: 'syn-company', assignmentId: session.assignmentId },
    can: (p: string) => session.permissions.includes(p),
  }),
}));

const MIRA = { userId: '11111111-1111-4111-8111-111111111111', accountKey: 'syn.mira', employeeCode: 'SYN-001', displayName: 'Mira Synthetic' };
const DEV = { userId: '22222222-2222-4222-8222-222222222222', accountKey: 'syn.dev', employeeCode: 'SYN-002', displayName: 'Dev Synthetic' };
const LEAVE = 'leave.approve.operational';
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const delegation = (over: Record<string, unknown> = {}) => ({
  id: ID,
  delegator: MIRA,
  delegate: DEV,
  permission: LEAVE,
  confidential: false,
  kinds: ['leave_cancellation', 'leave_request'],
  effectiveFrom: '2026-11-10T04:30:00.000Z',
  effectiveTo: '2026-11-20T04:30:00.000Z',
  state: 'PENDING',
  status: 'PENDING',
  purpose: 'Annual leave cover (synthetic)',
  requestedBy: MIRA,
  approvedBy: null,
  rejectionReason: null,
  endReason: null,
  version: 1,
  openTasks: 0,
  ...over,
});

type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}
let calls: Call[];
function mockApi(routes: Record<string, unknown | ((c: Call) => Reply)>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = { method: init?.method ?? 'GET', path: url, body: init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${url.split('?')[0]}`];
      const [status, body]: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: 'Not found' }] : typeof route === 'function' ? (route as (c: Call) => Reply)(call) : [200, route];
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}
const screenOf = (path: string) => DELEGATION_SCREENS.find((s) => s.path === path)!;
const show = (ui: JSX.Element) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);
const MineScreen = () => {
  const S = screenOf('/delegations').component;
  return <S />;
};
const AdminScreen = () => {
  const S = screenOf('/access/delegations').component;
  return <S />;
};

beforeEach(() => {
  session.permissions = [];
  session.accountKey = 'syn.mira';
  session.assignmentId = 'assignment-1';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('registered screens', () => {
  it('each screen is reached with the permission that uses it', () => {
    expect(screenOf('/delegations')).toMatchObject({ permission: DELEGATE, nav: true });
    expect(screenOf('/access/delegations')).toMatchObject({ permission: APPROVE, nav: true });
  });
});

describe('asking for a delegation', () => {
  it('sends exactly what was chosen, after asking the server who can receive that permission', async () => {
    session.permissions = [DELEGATE];
    mockApi({
      'GET /v1/me/delegations': { items: [] },
      'GET /v1/access/delegations/options': { items: [{ permission: LEAVE, kinds: ['leave_cancellation', 'leave_request'], confidential: false }] },
      'GET /v1/access/delegations/candidates': { items: [DEV] },
      'POST /v1/access/delegations': () => [201, { id: ID, state: 'PENDING', version: 1 }],
    });
    show(<MineScreen />);
    const decisions = await screen.findByLabelText('Decisions to delegate');
    await within(decisions as HTMLElement).findByRole('option', { name: /leave cancellation, leave request/ });
    expect(screen.getByRole('button', { name: 'Ask for approval' }).hasAttribute('disabled')).toBe(true);
    fireEvent.change(decisions, { target: { value: LEAVE } });
    const delegate = screen.getByLabelText('Delegate');
    await within(delegate).findByRole('option', { name: 'Dev Synthetic (SYN-002)' });
    expect(calls.find((c) => c.path.startsWith('/v1/access/delegations/candidates'))!.path).toContain(encodeURIComponent(LEAVE));
    fireEvent.change(delegate, { target: { value: DEV.userId } });
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-10T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends (not included)'), { target: { value: '2026-11-20T10:00' } });
    fireEvent.change(screen.getByLabelText('Purpose (optional)'), { target: { value: ' Cover (synthetic) ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for approval' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      delegateUserId: DEV.userId,
      permission: LEAVE,
      effectiveFrom: new Date('2026-11-10T10:00').toISOString(),
      effectiveTo: new Date('2026-11-20T10:00').toISOString(),
      purpose: 'Cover (synthetic)',
    });
    expect(await screen.findByText(/waiting for an independent approver/)).toBeTruthy();
  });

  it('shows the server’s refusal as it is, and says when nobody can receive the permission', async () => {
    session.permissions = [DELEGATE];
    mockApi({
      'GET /v1/me/delegations': { items: [] },
      'GET /v1/access/delegations/options': { items: [{ permission: LEAVE, kinds: ['leave_request'], confidential: false }] },
      'GET /v1/access/delegations/candidates': { items: [] },
    });
    show(<MineScreen />);
    const decisions = await screen.findByLabelText('Decisions to delegate');
    await within(decisions as HTMLElement).findByRole('option', { name: /leave request/ });
    fireEvent.change(decisions, { target: { value: LEAVE } });
    expect(await screen.findByText(/Nobody else can take these decisions/)).toBeTruthy();
    cleanup();
    mockApi({
      'GET /v1/me/delegations': { items: [] },
      'GET /v1/access/delegations/options': { items: [{ permission: LEAVE, kinds: ['leave_request'], confidential: false }] },
      'GET /v1/access/delegations/candidates': { items: [DEV] },
      'POST /v1/access/delegations': () => [409, { error: 'REDELEGATION_NOT_ALLOWED', message: 'A delegate cannot delegate again' }],
    });
    show(<MineScreen />);
    const again = await screen.findByLabelText('Decisions to delegate');
    await within(again as HTMLElement).findByRole('option', { name: /leave request/ });
    fireEvent.change(again, { target: { value: LEAVE } });
    const delegate = screen.getByLabelText('Delegate');
    await within(delegate).findByRole('option', { name: /Dev Synthetic/ });
    fireEvent.change(delegate, { target: { value: DEV.userId } });
    fireEvent.change(screen.getByLabelText('Starts'), { target: { value: '2026-11-10T10:00' } });
    fireEvent.change(screen.getByLabelText('Ends (not included)'), { target: { value: '2026-11-20T10:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask for approval' }));
    expect((await screen.findByRole('alert')).textContent).toContain('REDELEGATION_NOT_ALLOWED');
  });

  it('without the delegate duty there is no form, but a person who received a delegation still sees it and cannot end it', async () => {
    session.accountKey = 'syn.dev';
    mockApi({ 'GET /v1/me/delegations': { items: [delegation({ state: 'ACTIVE', status: 'LIVE', version: 2, approvedBy: { ...DEV, accountKey: 'syn.other', displayName: 'Ana Synthetic' }, openTasks: 2 })] } });
    show(<MineScreen />);
    expect(await screen.findByText('Live')).toBeTruthy();
    expect(screen.getByText('Mira Synthetic')).toBeTruthy();
    expect(screen.getByText('2 open tasks')).toBeTruthy();
    expect(screen.getByText('Approved by Ana Synthetic')).toBeTruthy();
    expect(screen.queryByLabelText('Decisions to delegate')).toBeNull();
    expect(screen.queryByRole('button', { name: 'End early' })).toBeNull();
    expect(calls.some((c) => c.path.startsWith('/v1/access/delegations'))).toBe(false);
  });
});

describe('ending a delegation', () => {
  it('needs a reason, carries the version, and says that open tasks stay open', async () => {
    session.permissions = [DELEGATE];
    mockApi({
      'GET /v1/me/delegations': { items: [delegation({ state: 'ACTIVE', status: 'LIVE', version: 2, openTasks: 1 })] },
      'GET /v1/access/delegations/options': { items: [] },
      [`POST /v1/access/delegations/${ID}/end`]: () => [200, { id: ID, state: 'ENDED', openTasks: 1 }],
    });
    show(<MineScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'End early' }));
    const confirm = screen.getByRole('button', { name: 'Confirm: end early' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason to end early/), { target: { value: 'Back early (synthetic)' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ expectedVersion: 2, reason: 'Back early (synthetic)' });
    expect((await screen.findByRole('status')).textContent).toContain('1 delegated task stays open');
  });

  it('C4 history: decisions taken are asked for when opened, each with the actual actor and whose authority was used', async () => {
    session.accountKey = 'syn.dev';
    mockApi({
      'GET /v1/me/delegations': { items: [delegation({ state: 'ACTIVE', status: 'ENDED', approvedBy: { ...DEV, accountKey: 'syn.other', displayName: 'Ana Synthetic' }, version: 3 })] },
      [`GET /v1/me/delegations/${ID}/decisions`]: { items: [{ taskId: 't-1', kind: 'leave_request', stepAction: 'approve', decision: 'APPROVE', decidedAt: '2026-11-12T04:30:00.000Z', actor: DEV }] },
    });
    show(<MineScreen />);
    const open = await screen.findByRole('button', { name: 'Decisions taken' });
    expect(calls.some((c) => c.path.endsWith('/decisions'))).toBe(false);
    fireEvent.click(open);
    const entry = await screen.findByText(/leave request: approve by Dev Synthetic/);
    expect(entry.textContent).toContain('on the authority of Mira Synthetic');
  });

  it('a pending request is withdrawn, and a finished one offers nothing', async () => {
    session.permissions = [DELEGATE];
    mockApi({
      'GET /v1/me/delegations': { items: [delegation(), delegation({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'ACTIVE', status: 'EXPIRED', version: 2 })] },
      'GET /v1/access/delegations/options': { items: [] },
    });
    show(<MineScreen />);
    expect(await screen.findByRole('button', { name: 'Withdraw' })).toBeTruthy();
    expect(screen.getByText('Expired')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End early' })).toBeNull();
  });
});

describe('approvals', () => {
  it('approves with the row version; a party is told someone else approves and is not offered it', async () => {
    session.permissions = [READ, APPROVE, REVOKE];
    session.accountKey = 'syn.admin';
    mockApi({
      'GET /v1/access/delegations': { items: [delegation()] },
      [`POST /v1/access/delegations/${ID}/approve`]: () => [200, { id: ID, state: 'ACTIVE' }],
    });
    show(<AdminScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ expectedVersion: 1 });
    expect(calls[0]!.path).toBe('/v1/access/delegations?state=PENDING');
    cleanup();

    session.accountKey = 'syn.dev';
    show(<AdminScreen />);
    expect(await screen.findByText(/You are a party to this delegation/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('a rejection needs a reason, and a stale row is reloaded with a note', async () => {
    session.permissions = [READ, APPROVE];
    session.accountKey = 'syn.admin';
    mockApi({
      'GET /v1/access/delegations': { items: [delegation()] },
      [`POST /v1/access/delegations/${ID}/reject`]: () => [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }],
    });
    show(<AdminScreen />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    const confirm = screen.getByRole('button', { name: 'Confirm rejection' });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason for rejecting/), { target: { value: 'No cover needed (synthetic)' } });
    fireEvent.click(confirm);
    expect((await screen.findByRole('status')).textContent).toContain('changed before your action');
    expect(calls.filter((c) => c.method === 'GET').length).toBeGreaterThan(1);
  });

  it('only the revocation duty ends a running delegation; without the read there is no list', async () => {
    session.permissions = [READ];
    session.accountKey = 'syn.admin';
    mockApi({ 'GET /v1/access/delegations': { items: [delegation({ state: 'ACTIVE', status: 'LIVE', version: 2 })] } });
    show(<AdminScreen />);
    expect(await screen.findByText('Live')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'End early' })).toBeNull();
    cleanup();
    session.permissions = [READ, REVOKE];
    show(<AdminScreen />);
    expect(await screen.findByRole('button', { name: 'End early' })).toBeTruthy();
    cleanup();
    session.permissions = [APPROVE];
    calls = [];
    show(<AdminScreen />);
    expect(await screen.findByText('The selected role cannot read delegations.')).toBeTruthy();
    expect(calls).toEqual([]);
  });
});

describe('the "delegated" indication on decision tasks (FR-096)', () => {
  it('every decision queue row shows it (the rule above is the same component everywhere)', () => {
    const rows: Record<string, number> = { appraisal: 1, assets: 1, 'hiring-pipeline': 1, 'hiring-requisitions': 2, 'lifecycle-documents': 1, 'lifecycle-processes': 1, timesheet: 2, payroll: 4, ess: 1, work: 2 };
    for (const [page, count] of Object.entries(rows)) {
      const source = readFileSync(`${process.cwd()}/src/pages/${page}.tsx`, 'utf8');
      expect(source.split('<DelegatedBadge taskId=').length - 1, page).toBe(count);
    }
  });

  const TASK = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const delegated = { taskId: TASK, kind: 'leave_request', ownerName: 'Eli Synthetic', ownerEmployeeCode: 'SYN-009', delegationId: ID, delegatedUntil: '2026-11-20T04:30:00.000Z', delegator: MIRA };

  it('names the delegator and the role the user acts in, only on the delegated task', async () => {
    mockApi({ 'GET /v1/me/delegated-tasks': { items: [delegated] } });
    show(
      <>
        <div data-testid="delegated">
          <DelegatedBadge taskId={TASK} />
        </div>
        <div data-testid="own">
          <DelegatedBadge taskId="dddddddd-dddd-4ddd-8ddd-dddddddddddd" />
        </div>
      </>,
    );
    const mark = await within(screen.getByTestId('delegated')).findByText('delegated');
    expect(mark).toBeTruthy();
    expect(screen.getByTestId('delegated').textContent).toContain('from Mira Synthetic');
    expect(screen.getByTestId('delegated').textContent).toContain('you decide as Reporting Manager');
    expect(screen.getByTestId('own').textContent).toBe('');
    // One request, however many rows ask.
    expect(calls.filter((c) => c.path === '/v1/me/delegated-tasks')).toHaveLength(1);
  });

  it('the inbox section lists them; a refusal or no delegated task shows nothing', async () => {
    mockApi({ 'GET /v1/me/delegated-tasks': { items: [delegated] } });
    show(<DelegatedTasksSection />);
    expect(await screen.findByRole('heading', { name: 'Delegated to you (1)' })).toBeTruthy();
    expect(screen.getByText('Eli Synthetic')).toBeTruthy();
    expect(screen.getByText(/acting as Reporting Manager/)).toBeTruthy();
    cleanup();
    mockApi({});
    const { container } = show(<DelegatedTasksSection />);
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(container.textContent).toBe('');
  });

  it('answers for one role are not shown under another', async () => {
    mockApi({ 'GET /v1/me/delegated-tasks': { items: [delegated] } });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <DelegatedBadge taskId={TASK} />
      </QueryClientProvider>,
    );
    await screen.findByText('delegated');
    session.assignmentId = 'assignment-2';
    mockApi({ 'GET /v1/me/delegated-tasks': { items: [] } });
    view.rerender(
      <QueryClientProvider client={client}>
        <DelegatedBadge taskId={TASK} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.queryByText('delegated')).toBeNull());
  });
});
