// Leave administration (jsdom; FR-024, FR-025; E06): warnings in words, draft maintenance and mappings, activation with
// its overlap refusal in plain words, retirement, the list before accrual and the ledger. Duties decide what is offered.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAVE_ADMIN_SCREENS, type PolicyRevision } from './leave-admin';

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
const screenOf = (path: string) => LEAVE_ADMIN_SCREENS.find((s) => s.path === path)!.component;
const open = (path: string) => {
  const Page = screenOf(path);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </QueryClientProvider>,
  );
};

const P = 'leave_policy.manage.operational';
const A = 'leave_policy.activate.operational';
const revision = (over: Partial<PolicyRevision>): PolicyRevision => ({
  id: 'p-1',
  leaveType: 'ANNUAL',
  leaveTypeName: 'Annual',
  paid: true,
  revision: 1,
  effectiveFrom: '2026-01-01',
  effectiveTo: null,
  eligibility: 'SYNTHETIC',
  accrualRule: 'MONTHLY_PRORATED',
  annualEntitlement: '24.0000',
  minServiceDays: 90,
  carryCap: '0.0000',
  state: 'ACTIVE',
  version: 2,
  mappings: [{ id: 'm-1', employmentType: 'PERMANENT', grade: null, location: null, priority: 1 }],
  unmapped: false,
  warnings: [],
  overlaps: [],
  ...over,
});
const types = { items: [{ id: 't-1', code: 'ANNUAL', name: 'Annual', paid: true, active: true, version: 1 }] };
const OPTIONS = { employmentTypes: [{ id: 'et-1', code: 'PERMANENT', name: 'Permanent' }], grades: [{ id: 'g-1', code: 'G1', name: 'Grade 1' }], locations: [{ id: 'l-1', code: 'HQ', name: 'HQ' }] };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('leave policies (FR-024, E06)', () => {
  it('says in words that a revision applies to nobody or overlaps another, not only in colour', async () => {
    session.permissions = [P];
    mockApi({
      'GET /v1/leave/types': [200, types],
      'GET /v1/leave/policies': [
        200,
        {
          items: [
            revision({ id: 'p-2', revision: 2, state: 'DRAFT', mappings: [], unmapped: true, warnings: [{ code: 'UNMAPPED', text: 'No grade, location or employment type is mapped, so this policy applies to nobody.' }] }),
            revision({ id: 'p-3', revision: 3, state: 'DRAFT', warnings: [{ code: 'OVERLAPPING_MAPPING', text: 'Its mappings overlap another revision of this leave type at the same priority.' }] }),
          ],
        },
      ],
    });
    open('/leave/policies');
    expect(await screen.findByText(/so this policy applies to nobody\./)).toBeTruthy();
    expect(screen.getByText(/overlap another revision/)).toBeTruthy();
    expect(screen.getByText(/One revision has/).textContent).toContain('so it applies to nobody');
  });

  it('names the employment types an eligibility code covers, with commas, and the types and statuses by name', async () => {
    session.permissions = [P];
    mockApi({
      'GET /v1/leave/types': [200, types],
      'GET /v1/leave/policies': [200, { items: [revision({ eligibility: 'PERMANENT_FIXED_TERM', mappings: [{ id: 'm-1', employmentType: 'PERMANENT', grade: null, location: null, priority: 1 }, { id: 'm-2', employmentType: 'FIXED_TERM', grade: null, location: null, priority: 1 }] })] }],
      'GET /v1/leave/policy-options': [200, OPTIONS],
    });
    open('/leave/policies');
    expect(await screen.findByText('(eligible: permanent, fixed term)')).toBeTruthy();
    expect(screen.getAllByText('Active').some((el) => el.className.includes('badge'))).toBe(true);
    expect(screen.getByRole('button', { name: 'Deactivate ANNUAL' }).textContent).toBe('Deactivate');
    expect(screen.getAllByRole('option', { name: 'Annual' }).length).toBeGreaterThan(0);
  });

  it('offers maintenance by duty: no activation without the activation duty, no change without the manage duty', async () => {
    session.permissions = [P];
    mockApi({ 'GET /v1/leave/types': [200, types], 'GET /v1/leave/policies': [200, { items: [revision({ state: 'DRAFT' })] }] });
    open('/leave/policies');
    expect((await screen.findByRole('button', { name: 'Edit ANNUAL revision 1' })).textContent).toBe('Edit');
    expect(screen.queryByRole('button', { name: 'Activate ANNUAL revision 1' })).toBeNull();
    expect(screen.getByText('Add leave type')).toBeTruthy();
    cleanup();

    session.permissions = [A];
    open('/leave/policies');
    expect((await screen.findByRole('button', { name: 'Activate ANNUAL revision 1' })).textContent).toBe('Activate');
    expect(screen.queryByRole('button', { name: 'Edit ANNUAL revision 1' })).toBeNull();
    expect(screen.queryByText('Add leave type')).toBeNull();
    expect(screen.queryByText('Create draft')).toBeNull();
  });

  it('creates a type and a draft with every value as entered, and filters the list', async () => {
    session.permissions = [P];
    const calls = mockApi({ 'GET /v1/leave/types': [200, types], 'GET /v1/leave/policies': [200, { items: [] }], 'POST /v1/leave/types': [201, { id: 't-2', version: 1 }], 'POST /v1/leave/policies': [201, { id: 'p-9', revision: 1, state: 'DRAFT', version: 1 }] });
    open('/leave/policies');
    await screen.findByText('Add leave type');
    fireEvent.change(screen.getByLabelText('New type code'), { target: { value: 'study' } });
    fireEvent.change(screen.getByLabelText('New type name'), { target: { value: 'Study leave' } });
    fireEvent.click(screen.getByText('Add leave type'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST' && c.url === '/v1/leave/types').map((c) => c.body)).toEqual([{ code: 'STUDY', name: 'Study leave', paid: false }]));

    fireEvent.change(screen.getByLabelText('Effective from'), { target: { value: '2027-01-01' } });
    fireEvent.change(screen.getByLabelText('Eligibility code'), { target: { value: 'all_staff' } });
    fireEvent.change(screen.getByLabelText('Accrual rule'), { target: { value: 'MONTHLY_PRORATED' } });
    fireEvent.change(screen.getByLabelText('Annual entitlement (days)'), { target: { value: '12.5' } });
    fireEvent.change(screen.getByLabelText('Minimum service (days)'), { target: { value: '30' } });
    // FR-024 (I-78 item 3): the leave year proposes no month.
    expect((screen.getByLabelText('Leave year starts in') as HTMLSelectElement).value).toBe('');
    fireEvent.click(screen.getByText('Create draft'));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST' && c.url === '/v1/leave/policies').map((c) => c.body)).toEqual([
        { leaveType: 'ANNUAL', effectiveFrom: '2027-01-01', effectiveTo: null, eligibility: 'ALL_STAFF', accrualRule: 'MONTHLY_PRORATED', annualEntitlement: '12.5', minServiceDays: 30, carryCap: '0', leaveYearStartMonth: null },
      ]),
    );

    const stateFilter = screen.getByLabelText('State');
    fireEvent.change(stateFilter, { target: { value: 'ACTIVE' } });
    await waitFor(() => expect(calls.some((c) => c.url === '/v1/leave/policies?state=ACTIVE')).toBe(true));
  });

  it('adds and removes a mapping under the version shown', async () => {
    session.permissions = [P];
    const calls = mockApi({
      'GET /v1/leave/types': [200, types],
      'GET /v1/leave/policies': [200, { items: [revision({ state: 'DRAFT', version: 4 })] }],
      'GET /v1/leave/policy-options': [200, OPTIONS],
      'POST /v1/leave/policies/p-1/mappings': (c) => (c.url.endsWith('/remove') ? [200, { policyVersion: 5 }] : [201, { id: 'm-2', policyVersion: 5 }]),
    });
    open('/leave/policies');
    fireEvent.click(await screen.findByRole('button', { name: 'Map ANNUAL revision 1' }));
    await screen.findByRole('option', { name: /\(G1\)$/ });
    fireEvent.change(screen.getByLabelText('Grade'), { target: { value: 'g-1' } });
    fireEvent.click(screen.getByText('Add mapping'));
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/leave/policies/p-1/mappings').map((c) => c.body)).toEqual([{ expectedVersion: 4, gradeId: 'g-1' }]));
    fireEvent.click(await screen.findByRole('button', { name: 'Remove employment type PERMANENT' }));
    await waitFor(() => expect(calls.filter((c) => c.url === '/v1/leave/policies/p-1/mappings/m-1/remove').map((c) => c.body)).toEqual([{ expectedVersion: 4 }]));
  });

  it('a refused activation names the overlapping revision and ends an earlier one only when asked', async () => {
    session.permissions = [A];
    let tries = 0;
    const calls = mockApi({
      'GET /v1/leave/types': [200, types],
      'GET /v1/leave/policies': [200, { items: [revision({ state: 'DRAFT', revision: 2, version: 3 })] }],
      'POST /v1/leave/policies/p-1/activate': () => (++tries === 1 ? [409, { error: 'POLICY_OVERLAP', message: 'overlap', details: { revisions: [{ policyId: 'p-0', revision: 1 }] } }] : [200, { id: 'p-1', state: 'ACTIVE', closed: ['p-0'] }]),
    });
    open('/leave/policies');
    fireEvent.click(await screen.findByRole('button', { name: 'Activate ANNUAL revision 2' }));
    fireEvent.click(screen.getByText('Confirm activation'));
    expect((await screen.findByRole('alert')).textContent).toContain('ties with revision 1');
    fireEvent.click(screen.getByLabelText(/End an earlier overlapping revision/));
    fireEvent.click(screen.getByText('Confirm activation'));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([{ expectedVersion: 3 }, { expectedVersion: 3, closePredecessors: true }]));
  });

  it('retires an active revision with a date and a reason', async () => {
    session.permissions = [A];
    const calls = mockApi({ 'GET /v1/leave/types': [200, types], 'GET /v1/leave/policies': [200, { items: [revision({ version: 7 })] }], 'POST /v1/leave/policies/p-1/retire': [200, { id: 'p-1', state: 'RETIRED', effectiveTo: '2027-04-01' }] });
    open('/leave/policies');
    fireEvent.click(await screen.findByRole('button', { name: 'Retire ANNUAL revision 1' }));
    fireEvent.change(screen.getByLabelText('No longer applies from'), { target: { value: '2027-04-01' } });
    fireEvent.change(screen.getByLabelText('Reason for retiring'), { target: { value: 'Replaced (synthetic)' } });
    fireEvent.click(screen.getByText('Confirm retirement'));
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/retire')).map((c) => c.body)).toEqual([{ expectedVersion: 7, effectiveTo: '2027-04-01', reason: 'Replaced (synthetic)' }]));
  });

  it('exports the mapped policies under the filters shown, only with the export duty', async () => {
    session.permissions = [P, 'leave_policy.export.operational'];
    const calls = mockApi({
      'GET /v1/leave/types': [200, types],
      'GET /v1/leave/policies': [200, { items: [revision({})] }],
      'POST /v1/reports': [201, { id: 'r-1', state: 'QUEUED' }],
      'GET /v1/reports/r-1': [200, { state: 'COMPLETED', rowCount: 3, failureCode: null }],
    });
    open('/leave/policies');
    await screen.findByText('Export mapped policies');
    fireEvent.change(screen.getByLabelText('Effective from, on or after'), { target: { value: '2026-06-01' } });
    fireEvent.click(screen.getByText('Export mapped policies'));
    expect(await screen.findByText('Download (3 rows)')).toBeTruthy();
    expect(calls.filter((c) => c.url === '/v1/reports').map((c) => c.body)).toEqual([{ reportCode: 'LEAVE_POLICY_MAPPING', filters: { from: '2026-06-01' } }]);
    cleanup();
    session.permissions = [P];
    open('/leave/policies');
    await screen.findByText('Add leave type');
    expect(screen.queryByText('Export mapped policies')).toBeNull();
  });
});

describe('before accrual (FR-024 acceptance)', () => {
  it('lists employees with each unresolved type in words and pages', async () => {
    session.permissions = ['leave.accrue.operational'];
    const calls = mockApi({
      'GET /v1/leave/accruals/employees-without-policy': [
        200,
        {
          month: '2026-02',
          total: 26,
          page: 1,
          pageSize: 25,
          items: [{ employeeId: 'e-1', employeeCode: 'SYN1', employeeName: 'Synthetic One', employmentType: 'CONTRACTOR', asOf: '2026-02-28', unresolved: [{ leaveType: 'ANNUAL', reason: 'POLICY_NOT_FOUND' }, { leaveType: 'SICK', reason: 'POLICY_AMBIGUOUS' }], mappedLeaveTypes: ['UNPAID'] }],
        },
      ],
    });
    open('/leave/before-accrual');
    expect(calls).toHaveLength(0); // nothing is asked for before a month is chosen
    expect(screen.getByText(/Choose an accrual month/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Accrual month'), { target: { value: '2026-02' } });
    expect(await screen.findByText('ANNUAL: no policy applies, so the run credits nothing for this type')).toBeTruthy();
    expect(screen.getByText('SICK: two policies tie, so the run stops on this employee')).toBeTruthy();
    expect(screen.getByText('UNPAID')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('26 employees need a look');
    fireEvent.click(screen.getByText('Next page'));
    await waitFor(() => expect(calls.some((c) => c.url.includes('page=2'))).toBe(true));
  });

  it('says so when everyone resolves', async () => {
    session.permissions = ['leave.accrue.operational'];
    mockApi({ 'GET /v1/leave/accruals/employees-without-policy': [200, { month: '2026-02', total: 0, page: 1, pageSize: 25, items: [] }] });
    open('/leave/before-accrual');
    fireEvent.change(screen.getByLabelText('Accrual month'), { target: { value: '2026-02' } });
    expect(await screen.findByText(/resolves to one policy/)).toBeTruthy();
  });

  it('FR-024 FR-025 queues the year-end expiry for a date and lists the pending requests that hold employees back (I-78 item 3)', async () => {
    session.permissions = ['leave.accrue.operational'];
    const calls = mockApi({
      'GET /v1/leave/year-end-runs/pending-requests': [
        200,
        { yearEnd: '2025-12-31', total: 1, page: 1, pageSize: 25, items: [{ requestId: 'r-1', employeeId: 'e-1', employeeCode: 'SYN1', employeeName: 'Synthetic One', leaveType: 'ANNUAL', startDate: '2025-12-29', endDate: '2025-12-29' }] },
      ],
      'POST /v1/leave/year-end-runs': [202, { jobId: 'job-1' }],
    });
    open('/leave/before-accrual');
    const form = screen.getByRole('form', { name: 'Leave year end' });
    expect((within(form).getByLabelText('Last day of the leave year') as HTMLInputElement).value).toBe('');
    fireEvent.change(within(form).getByLabelText('Last day of the leave year'), { target: { value: '2025-12-31' } });
    const table = await screen.findByRole('table', { name: 'Pending requests at the leave year end' });
    expect(within(table).getByText('SYN1')).toBeTruthy();
    expect(screen.getByText(/1 pending request holds its employee back until decided/)).toBeTruthy();
    fireEvent.click(within(form).getByRole('button', { name: 'Expire balances above the carry cap' }));
    expect(await screen.findByRole('link', { name: 'My background jobs' })).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ yearEnd: '2025-12-31' });
  });
});

describe('leave year of a revision (FR-024; I-78 item 3)', () => {
  it('FR-024 shows the leave year in words and edits it on a draft; unset says nothing expires', async () => {
    session.permissions = [P];
    const calls = mockApi({
      'GET /v1/leave/types': [200, types],
      'GET /v1/leave/policies': [200, { items: [revision({ state: 'DRAFT', leaveYearStartMonth: 4 }), revision({ id: 'p-2', revision: 2, leaveYearStartMonth: null })] }],
      'PATCH /v1/leave/policies/p-1': [200, { id: 'p-1', version: 3 }],
    });
    open('/leave/policies');
    expect(await screen.findByText(/leave year from April/)).toBeTruthy();
    expect(screen.getByText(/no leave year set, so nothing expires/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Edit ANNUAL revision 1' }));
    const select = screen.getAllByLabelText('Leave year starts in').find((s) => (s as HTMLSelectElement).value === '4') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: '1' } });
    fireEvent.click(screen.getByText('Save draft'));
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toMatchObject({ expectedVersion: 2, leaveYearStartMonth: 1 }));
  });
});

describe('employee leave ledger (FR-025)', () => {
  it('shows opening, credits, debits and closing per type, each movement in words, and a note only when the server sent one', async () => {
    session.permissions = ['leave.adjust.operational'];
    mockApi({
      'GET /v1/employees?search=': [200, { items: [{ id: 'e-1', employeeCode: 'SYN1', displayName: 'Synthetic One' }] }],
      'GET /v1/employees/e-1/leave-ledger': [
        200,
        {
          items: [
            {
              leaveType: 'CASUAL',
              paid: true,
              opening: '6.0000',
              credits: '2.0000',
              debits: '5.5000',
              closing: '2.5000',
              movements: [
                { id: 'm-1', kind: 'ADJUSTMENT', units: '-1.5000', effectiveDate: '2026-02-10', requestId: null, actorUserId: 'u-1', reason: 'Synthetic correction' },
                { id: 'm-2', kind: 'CONSUMPTION', units: '-2.0000', effectiveDate: '2026-03-02', requestId: 'lr-1', actorUserId: 'u-1' },
              ],
            },
            { leaveType: 'UNPAID', paid: false, opening: '0.0000', credits: '0.0000', debits: '0.0000', closing: '0.0000', movements: [] },
          ],
        },
      ],
    });
    open('/leave/ledger');
    // Until there is something to show, the page says what to choose.
    expect(screen.getByText('Choose an employee and a period to see their leave ledger.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Find an employee (code or name)'), { target: { value: 'syn' } });
    await screen.findByRole('option', { name: 'Synthetic One (SYN1)' });
    fireEvent.change(screen.getByLabelText('Employee'), { target: { value: 'e-1' } });
    expect(screen.getByText('Choose the period (From and To) to see the leave ledger.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-02-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
    const casual = await screen.findByRole('region', { name: 'CASUAL ledger' });
    expect(within(casual).getByText('Opening 6.00 + credits 2.00 − debits 5.50 = closing 2.50')).toBeTruthy();
    expect(within(casual).getByText('Adjustment')).toBeTruthy();
    expect(within(casual).getByText('Taken on approval')).toBeTruthy();
    expect(within(casual).getByText('Synthetic correction')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'UNPAID ledger' })).getByText('No movements in this period.')).toBeTruthy();
  });
});
