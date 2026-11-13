// Increment and salary screen (FR-029, FR-089-FR-092; DF14; DF15; DF02; C1), jsdom: amount columns only when the API
// returned amounts, the exact proposal bodies (with the case version; no amounts unless the outcome is an increase),
// stale-version refusals that are never lost, money sent exactly as typed, the salary panel only with the matching
// salary grants, controls hidden without the permissions, and no cached answer shown under another assignment or after
// the server refuses it. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAmount } from '../api';
import { BULK_JOB_POLL_MS } from './bulk-jobs';
import { IncrementsPage } from './increments';

const session = vi.hoisted(() => ({
  permissions: [] as string[],
  employeeId: null as string | null,
  scopeKind: 'COMPANY',
  assignmentId: 'assignment-1',
  /** false while the role context and permissions are still loading (the session then has no `me`). */
  loaded: true,
}));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'tkn', companies: [], companyId: 'company-1', assignmentId: session.assignmentId },
    me: session.loaded
      ? {
          accountKey: 'syn.user',
          companyName: 'Synthetic Co',
          roleCode: 'HR_ADMINISTRATOR',
          roleName: 'HR Administrator',
          scopeKind: session.scopeKind,
          employeeId: session.employeeId,
          displayName: 'Synthetic User',
        }
      : null,
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const CYCLE_MANAGE = 'increment_cycle.manage.operational';
const READ_OPERATIONAL = 'increment.read.operational';
const READ_SALARY = 'increment.read.salary';
const READ_HISTORY = 'increment.history_read.salary';
const PROPOSE = 'increment.propose.salary';
const APPROVE = 'increment.approve.salary';
const SALARY_READ = 'salary.read.salary';
const SALARY_MANAGE = 'salary.manage.salary';
const LIST_EMPLOYEES = 'employee.list.operational';

const CYCLE = '10000000-0000-4000-8000-000000000001';
const CYCLE_RETIRED = '10000000-0000-4000-8000-000000000002';
const CYCLE_ANNIVERSARY = '10000000-0000-4000-8000-000000000003';
const E_ASHA = '20000000-0000-4000-8000-000000000001';
const E_RAVI = '20000000-0000-4000-8000-000000000002';
const E_MEERA = '20000000-0000-4000-8000-000000000003';
const E_MANAGER = '20000000-0000-4000-8000-000000000009';
const CASE_DRAFT = '30000000-0000-4000-8000-000000000001';
const CASE_RETURNED = '30000000-0000-4000-8000-000000000002';
const CASE_SUBMITTED = '30000000-0000-4000-8000-000000000003';
const CASE_OFF_CYCLE = '30000000-0000-4000-8000-000000000004';
const TASK = '40000000-0000-4000-8000-000000000001';
const OFF_CYCLE_TX = '50000000-0000-4000-8000-000000000001';
const JOB = '70000000-0000-4000-8000-000000000001';

const CYCLES = [
  { id: CYCLE_RETIRED, code: 'ANNUAL', revision: 1, recurrenceBasis: 'COMMON_DATE', compensationBasis: 'MONTHLY_GROSS', active: false, version: 2 },
  { id: CYCLE, code: 'ANNUAL', revision: 2, recurrenceBasis: 'COMMON_DATE', compensationBasis: 'MONTHLY_GROSS', active: true, version: 1 },
  { id: CYCLE_ANNIVERSARY, code: 'SERVICE', revision: 1, recurrenceBasis: 'SERVICE_ANNIVERSARY', compensationBasis: 'ANNUAL_CTC', active: true, version: 1 },
];

/** The operational fields every increment reader receives. */
const CASES = [
  { id: CASE_DRAFT, employeeId: E_ASHA, employeeCode: 'SYN-301', occurrence: 'ANNUAL:2027', offCycle: false, state: 'DRAFT', proposedOutcome: null, effectiveDate: '2027-04-01', version: 3 },
  {
    id: CASE_OFF_CYCLE,
    employeeId: E_ASHA,
    employeeCode: 'SYN-301',
    occurrence: `OFF_CYCLE:${OFF_CYCLE_TX}`,
    offCycle: true,
    state: 'RETURNED',
    proposedOutcome: 'INCREASE',
    effectiveDate: '2026-12-01',
    version: 2,
  },
  { id: CASE_RETURNED, employeeId: E_RAVI, employeeCode: 'SYN-302', occurrence: 'ANNUAL:2027', offCycle: false, state: 'RETURNED', proposedOutcome: 'INCREASE', effectiveDate: '2027-04-01', version: 5 },
  { id: CASE_SUBMITTED, employeeId: E_MEERA, employeeCode: 'SYN-303', occurrence: 'ANNUAL:2027', offCycle: false, state: 'SUBMITTED', proposedOutcome: 'NO_CHANGE', effectiveDate: '2027-04-01', version: 2 },
];

/** The confidential fields the server adds only for a caller holding the salary grant. */
const AMOUNTS: Record<string, { baselineAmount: string; proposedAmount: string | null; currency: string }> = {
  [CASE_DRAFT]: { baselineAmount: '100000.0000', proposedAmount: null, currency: 'INR' },
  [CASE_OFF_CYCLE]: { baselineAmount: '100000.0000', proposedAmount: '125000.0000', currency: 'INR' },
  [CASE_RETURNED]: { baselineAmount: '80000.0000', proposedAmount: '88000.0000', currency: 'INR' },
  [CASE_SUBMITTED]: { baselineAmount: '70000.0000', proposedAmount: null, currency: 'INR' },
};

const EMPLOYEES = [
  { id: E_ASHA, employeeCode: 'SYN-301', displayName: 'Asha Synthetic', status: 'ACTIVE_CONFIRMED' },
  { id: E_RAVI, employeeCode: 'SYN-302', displayName: 'Ravi Synthetic', status: 'ACTIVE_CONFIRMED' },
  { id: E_MEERA, employeeCode: 'SYN-303', displayName: 'Meera Synthetic', status: 'ACTIVE_PROBATION' },
];

interface Call {
  method: string;
  path: string;
  params: URLSearchParams;
  body: unknown;
}
type Reply = [status: number, body: unknown];
type Route = Reply | ((call: Call) => Reply | Promise<Reply>);

/** ZT26: 100000 -> 110000 -> 121000 is two 10% changes and 21% annual growth, never 20%. */
const SALARY_ROUTES: Record<string, Route> = {
  [`GET /v1/employees/${E_ASHA}/salary`]: [
    200,
    {
      employeeId: E_ASHA,
      items: [
        { id: '60000000-0000-4000-8000-000000000001', effectiveFrom: '2025-01-06', effectiveTo: '2027-04-01', annualCtc: '1200000.0000', monthlyGross: '100000.0000', currency: 'INR' },
        { id: '60000000-0000-4000-8000-000000000002', effectiveFrom: '2027-04-01', effectiveTo: '2027-10-01', annualCtc: '1320000.0000', monthlyGross: '110000.0000', currency: 'INR' },
        { id: '60000000-0000-4000-8000-000000000003', effectiveFrom: '2027-10-01', effectiveTo: null, annualCtc: '1452000.0000', monthlyGross: '121000.0000', currency: 'INR' },
      ],
    },
  ],
  [`GET /v1/employees/${E_ASHA}/increment-history`]: [
    200,
    {
      employeeId: E_ASHA,
      items: [
        {
          effectiveDate: '2027-04-01',
          basis: 'MONTHLY_GROSS',
          currency: 'INR',
          beforeAmount: '100000.0000',
          afterAmount: '110000.0000',
          changeAmount: '10000.0000',
          changePercent: '10.00',
          percentNaReason: null,
          reason: 'Cycle approval (synthetic)',
        },
        {
          effectiveDate: '2027-10-01',
          basis: 'MONTHLY_GROSS',
          currency: 'INR',
          beforeAmount: '110000.0000',
          afterAmount: '121000.0000',
          changeAmount: '11000.0000',
          changePercent: '10.00',
          percentNaReason: null,
          reason: 'Off-cycle approval (synthetic)',
        },
      ],
    },
  ],
  [`GET /v1/employees/${E_ASHA}/annual-increment`]: (call) =>
    call.params.get('basis') === 'ANNUAL_CTC'
      ? [
          200,
          {
            employeeId: E_ASHA,
            financialYear: Number(call.params.get('financialYear')),
            basis: 'ANNUAL_CTC',
            periodStart: '2024-04-01',
            periodEnd: '2025-03-31',
            opening: null,
            closing: '1200000.0000',
            currency: 'INR',
            annualGrowthPercent: null,
            percentNaReason: 'MISSING_OPENING_OR_CLOSING',
            changes: [],
          },
        ]
      : [
          200,
          {
            employeeId: E_ASHA,
            financialYear: Number(call.params.get('financialYear')),
            basis: 'MONTHLY_GROSS',
            periodStart: '2027-04-01',
            periodEnd: '2028-03-31',
            opening: '100000.0000',
            closing: '121000.0000',
            currency: 'INR',
            annualGrowthPercent: '21.00',
            percentNaReason: null,
            changes: [
              { effectiveDate: '2027-04-01', beforeAmount: '100000.0000', afterAmount: '110000.0000', changePercent: '10.00', percentNaReason: null },
              { effectiveDate: '2027-10-01', beforeAmount: '110000.0000', afterAmount: '121000.0000', changePercent: '10.00', percentNaReason: null },
            ],
          },
        ],
  [`GET /v1/employees/${E_RAVI}/salary`]: [200, { employeeId: E_RAVI, items: [] }],
  [`GET /v1/employees/${E_RAVI}/increment-history`]: [200, { employeeId: E_RAVI, items: [] }],
};

let calls: Call[] = [];
const callsTo = (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path);
const bodyOf = (method: string, path: string) => callsTo(method, path)[0]?.body;
const salaryCalls = () => calls.filter((c) => /\/(salary|increment-history|annual-increment)$/.test(c.path));

/**
 * A fetch stub: "METHOD /path" routes over synthetic data; `amounts` decides whether the case list carries the
 * confidential amount fields (as the server does for a caller with the salary grant). Every request is recorded.
 */
function serve(options: { amounts?: boolean; routes?: Record<string, Route> } = {}) {
  const routes: Record<string, Route> = {
    'GET /v1/increment-cycles': [200, { items: CYCLES }],
    'GET /v1/increment-cases': (call) => {
      const state = call.params.get('state');
      const items = CASES.filter((k) => !state || k.state === state).map((k) => (options.amounts ? { ...k, ...AMOUNTS[k.id] } : { ...k }));
      return [200, { items }];
    },
    'GET /v1/employees': (call) => {
      const search = (call.params.get('search') ?? '').toLowerCase();
      const items = EMPLOYEES.filter((e) => e.displayName.toLowerCase().includes(search) || e.employeeCode.toLowerCase().includes(search));
      return [200, { items, total: items.length, page: 1, pageSize: Number(call.params.get('pageSize')) }];
    },
    ...Object.fromEntries(EMPLOYEES.map((e): [string, Route] => [`GET /v1/employees/${e.id}`, [200, { ...e, joiningDate: '2025-01-06', version: 1 }]])),
    ...options.routes,
  };
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const call: Call = { method: init?.method ?? 'GET', path: url.pathname, params: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const route = routes[`${call.method} ${call.path}`];
      const [status, body]: Reply =
        route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${call.method} ${call.path}` }] : typeof route === 'function' ? await route(call) : route;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });

/** `client` lets several renders share one query cache, as the app does across role switches and sign-ins. */
function renderPage(
  permissions: string[],
  me: { employeeId?: string | null; scopeKind?: string; assignmentId?: string; loaded?: boolean; client?: QueryClient } = {},
) {
  session.permissions = permissions;
  session.employeeId = me.employeeId === undefined ? E_MANAGER : me.employeeId;
  session.scopeKind = me.scopeKind ?? 'COMPANY';
  session.assignmentId = me.assignmentId ?? 'assignment-1';
  session.loaded = me.loaded ?? true;
  const client = me.client ?? newClient();
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/increments']}>
        <IncrementsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const findSection = async (name: string | RegExp) => (await screen.findByRole('heading', { level: 2, name })).closest('section') as HTMLElement;
const sectionOf = (name: string | RegExp) => screen.getByRole('heading', { level: 2, name }).closest('section') as HTMLElement;

async function choose(scope: HTMLElement, label: string, term: string, button: string) {
  fireEvent.change(within(scope).getByLabelText(label), { target: { value: term } });
  fireEvent.click(await within(scope).findByRole('button', { name: button }));
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  session.permissions = [];
  session.employeeId = null;
  session.scopeKind = 'COMPANY';
  session.assignmentId = 'assignment-1';
  session.loaded = true;
});

describe('increment cases (FR-092, BR-044)', () => {
  it('shows the amount columns when the API returned amounts', async () => {
    serve({ amounts: true });
    renderPage([READ_OPERATIONAL, READ_SALARY]);
    const cases = await findSection(/^Increment cases/);
    const ravi = (await within(cases).findByText('SYN-302')).closest('tr') as HTMLElement;
    expect(within(cases).getByRole('columnheader', { name: 'Baseline' })).toBeTruthy();
    expect(within(cases).getByRole('columnheader', { name: 'Proposed amount' })).toBeTruthy();
    expect(within(ravi).getByText(formatAmount('80000.0000', 'INR'))).toBeTruthy();
    expect(within(ravi).getByText(formatAmount('88000.0000', 'INR'))).toBeTruthy();
    expect(within(cases).queryByText(/confidential salary grant/)).toBeNull();
  });

  it('shows no amount columns when the API returned none, even for a role holding the salary grant, and says why', async () => {
    serve({ amounts: false });
    renderPage([READ_OPERATIONAL, READ_SALARY]);
    const cases = await findSection(/^Increment cases/);
    await within(cases).findByText('SYN-302');
    expect(within(cases).queryByRole('columnheader', { name: 'Baseline' })).toBeNull();
    expect(within(cases).queryByRole('columnheader', { name: 'Proposed amount' })).toBeNull();
    expect(within(cases).getByText('Amounts are shown only to roles holding a confidential salary grant.')).toBeTruthy();
    expect(within(cases).queryByText(/INR/)).toBeNull();
  });

  it('requests the chosen state and shows an empty result as empty, not as not permitted', async () => {
    serve({ amounts: false });
    renderPage([READ_OPERATIONAL]);
    const cases = await findSection(/^Increment cases/);
    await within(cases).findByText('SYN-303');
    fireEvent.change(within(cases).getByLabelText('State'), { target: { value: 'RETURNED' } });
    await waitFor(() => expect(callsTo('GET', '/v1/increment-cases').map((c) => c.params.get('state'))).toEqual([null, 'RETURNED']));
    expect(await within(cases).findByText('SYN-302')).toBeTruthy();
    expect(within(cases).queryByText('SYN-303')).toBeNull();
    // Off-cycle cases show as such, not as their internal occurrence key.
    expect(within(cases).getByText('Off-cycle')).toBeTruthy();
    expect(within(cases).queryByText(new RegExp(OFF_CYCLE_TX))).toBeNull();

    fireEvent.change(within(cases).getByLabelText('State'), { target: { value: 'APPLIED' } });
    expect(await within(cases).findByText('No increment cases are in the state “Applied”.')).toBeTruthy();
    expect(within(cases).queryByText('not permitted')).toBeNull();
    expect(within(cases).queryByText(/confidential salary grant/)).toBeNull();
  });

  it('shows not permitted instead of the case list without an increment read duty, and requests nothing', async () => {
    serve();
    renderPage([]);
    const cases = sectionOf('Increment cases');
    expect(within(cases).getByText('The selected role cannot view increment cases.')).toBeTruthy();
    expect(within(cases).getByText('not permitted')).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);
  });

  it('shows loading, not "not permitted", while the role context is still arriving', async () => {
    serve();
    renderPage([], { loaded: false });
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText('not permitted')).toBeNull();
    expect(screen.queryByText('The selected role cannot view increment cases.')).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toHaveLength(0);
  });
});

describe('proposals (DF15, FR-092)', () => {
  it('sends an increase with the case version and both amounts exactly as typed', async () => {
    serve({ amounts: true, routes: { [`POST /v1/increment-cases/${CASE_DRAFT}/proposal`]: [200, { caseId: CASE_DRAFT, taskId: TASK, state: 'SUBMITTED' }] } });
    renderPage([READ_OPERATIONAL, READ_SALARY, PROPOSE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose outcome for SYN-301' }));
    const form = within(screen.getByRole('form', { name: 'Proposal for SYN-301 (ANNUAL:2027)' }));
    fireEvent.change(form.getByLabelText('Proposed outcome'), { target: { value: 'INCREASE' } });
    expect(form.getByText(new RegExp(`Current baseline on the cycle basis: ${formatAmount('100000.0000', 'INR')}`))).toBeTruthy();
    fireEvent.change(form.getByLabelText('New amount on the cycle basis'), { target: { value: '110000' } });
    fireEvent.change(form.getByLabelText('Counterpart figure'), { target: { value: '1320000.50' } });
    fireEvent.change(form.getByLabelText('Reason (required)'), { target: { value: '  Strong year (synthetic)  ' } });
    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));

    await waitFor(() => expect(callsTo('POST', `/v1/increment-cases/${CASE_DRAFT}/proposal`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/increment-cases/${CASE_DRAFT}/proposal`)).toEqual({
      expectedVersion: 3,
      outcome: 'INCREASE',
      proposedAmount: '110000',
      proposedCounterpart: '1320000.50',
      reason: 'Strong year (synthetic)',
    });
    expect(await screen.findByText('Proposal for SYN-301 sent for an independent decision.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: /Proposal for SYN-301/ })).toBeNull();
    // The list is reloaded so the case shows its new state and version.
    await waitFor(() => expect(callsTo('GET', '/v1/increment-cases')).toHaveLength(2));
  });

  it('sends no amounts for no change or defer, even after amounts were typed', async () => {
    serve({
      amounts: true,
      routes: {
        [`POST /v1/increment-cases/${CASE_RETURNED}/proposal`]: [200, { caseId: CASE_RETURNED, taskId: TASK, state: 'SUBMITTED' }],
        [`POST /v1/increment-cases/${CASE_DRAFT}/proposal`]: [200, { caseId: CASE_DRAFT, taskId: TASK, state: 'SUBMITTED' }],
      },
    });
    renderPage([READ_OPERATIONAL, READ_SALARY, PROPOSE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose outcome for SYN-302' }));
    let form = within(screen.getByRole('form', { name: 'Proposal for SYN-302 (ANNUAL:2027)' }));
    fireEvent.change(form.getByLabelText('Proposed outcome'), { target: { value: 'INCREASE' } });
    fireEvent.change(form.getByLabelText('New amount on the cycle basis'), { target: { value: '88000' } });
    fireEvent.change(form.getByLabelText('Counterpart figure'), { target: { value: '1056000' } });
    fireEvent.change(form.getByLabelText('Proposed outcome'), { target: { value: 'NO_CHANGE' } });
    expect(form.queryByLabelText('New amount on the cycle basis')).toBeNull();
    expect(form.queryByLabelText('Counterpart figure')).toBeNull();
    fireEvent.change(form.getByLabelText('Reason (required)'), { target: { value: 'Revised recently (synthetic)' } });
    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));
    await waitFor(() => expect(callsTo('POST', `/v1/increment-cases/${CASE_RETURNED}/proposal`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/increment-cases/${CASE_RETURNED}/proposal`)).toEqual({ expectedVersion: 5, outcome: 'NO_CHANGE', reason: 'Revised recently (synthetic)' });

    fireEvent.click(await screen.findByRole('button', { name: 'Propose outcome for SYN-301' }));
    form = within(screen.getByRole('form', { name: 'Proposal for SYN-301 (ANNUAL:2027)' }));
    fireEvent.change(form.getByLabelText('Proposed outcome'), { target: { value: 'DEFER' } });
    fireEvent.change(form.getByLabelText('Reason (required)'), { target: { value: 'Project review pending (synthetic)' } });
    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));
    await waitFor(() => expect(callsTo('POST', `/v1/increment-cases/${CASE_DRAFT}/proposal`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/increment-cases/${CASE_DRAFT}/proposal`)).toEqual({ expectedVersion: 3, outcome: 'DEFER', reason: 'Project review pending (synthetic)' });
  });

  it('checks only the money format, and sends nothing until it is right', async () => {
    serve({ amounts: true, routes: { [`POST /v1/increment-cases/${CASE_DRAFT}/proposal`]: [200, { caseId: CASE_DRAFT, taskId: TASK, state: 'SUBMITTED' }] } });
    renderPage([READ_OPERATIONAL, READ_SALARY, PROPOSE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose outcome for SYN-301' }));
    const form = within(screen.getByRole('form', { name: /Proposal for SYN-301/ }));
    fireEvent.change(form.getByLabelText('Proposed outcome'), { target: { value: 'INCREASE' } });
    fireEvent.change(form.getByLabelText('New amount on the cycle basis'), { target: { value: '1,10,000' } });
    fireEvent.change(form.getByLabelText('Counterpart figure'), { target: { value: '1320000' } });
    fireEvent.change(form.getByLabelText('Reason (required)'), { target: { value: 'Strong year (synthetic)' } });
    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));
    expect(form.getByRole('alert').textContent).toMatch(/new amount as digits with up to four decimal places/);

    fireEvent.change(form.getByLabelText('New amount on the cycle basis'), { target: { value: '110000.12345' } });
    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));
    expect(form.getByRole('alert').textContent).toMatch(/up to four decimal places/);
    expect(callsTo('POST', `/v1/increment-cases/${CASE_DRAFT}/proposal`)).toHaveLength(0);

    fireEvent.change(form.getByLabelText('New amount on the cycle basis'), { target: { value: '110000.1234' } });
    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));
    await waitFor(() => expect(callsTo('POST', `/v1/increment-cases/${CASE_DRAFT}/proposal`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/increment-cases/${CASE_DRAFT}/proposal`)).toMatchObject({ proposedAmount: '110000.1234', proposedCounterpart: '1320000' });
  });

  it('shows the server refusal as it is, without inventing a rule', async () => {
    serve({
      amounts: true,
      routes: { [`POST /v1/increment-cases/${CASE_DRAFT}/proposal`]: [403, { error: 'FORBIDDEN', message: 'Only the current direct manager can propose' }] },
    });
    renderPage([READ_OPERATIONAL, READ_SALARY, PROPOSE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose outcome for SYN-301' }));
    const form = within(screen.getByRole('form', { name: /Proposal for SYN-301/ }));
    fireEvent.change(form.getByLabelText('Proposed outcome'), { target: { value: 'NO_CHANGE' } });
    fireEvent.change(form.getByLabelText('Reason (required)'), { target: { value: 'Recently revised (synthetic)' } });
    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));
    expect((await form.findByRole('alert')).textContent).toContain('Only the current direct manager can propose (FORBIDDEN)');
  });

  it('keeps a stale-version refusal on screen when the reloaded case is no longer open for a proposal', async () => {
    let listed = 0;
    serve({
      routes: {
        'GET /v1/increment-cases': () => {
          listed += 1;
          // Another proposal went in meanwhile: after the reload the case is submitted, with a newer version.
          const items = CASES.map((k) => (k.id === CASE_DRAFT && listed > 1 ? { ...k, state: 'SUBMITTED', proposedOutcome: 'NO_CHANGE', version: 4 } : { ...k }));
          return [200, { items }];
        },
        [`POST /v1/increment-cases/${CASE_DRAFT}/proposal`]: [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }],
      },
    });
    renderPage([READ_OPERATIONAL, PROPOSE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose outcome for SYN-301' }));
    const form = within(screen.getByRole('form', { name: /Proposal for SYN-301/ }));
    fireEvent.change(form.getByLabelText('Proposed outcome'), { target: { value: 'DEFER' } });
    fireEvent.change(form.getByLabelText('Reason (required)'), { target: { value: 'Project review pending (synthetic)' } });
    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));

    const cases = sectionOf(/^Increment cases/);
    expect(await within(cases).findByText('The proposal for SYN-301 was not accepted, and the case list was reloaded. Check the case’s current state.')).toBeTruthy();
    expect(within(cases).getByRole('alert').textContent).toContain('The record changed; reload and retry (STALE_VERSION)');
    expect(screen.queryByRole('form', { name: /Proposal for SYN-301/ })).toBeNull();
    expect(within(cases).queryByText(/sent for an independent decision/)).toBeNull();
    expect(callsTo('GET', '/v1/increment-cases')).toHaveLength(2);
  });

  it('keeps the typed proposal after a stale-version refusal and resends it with the reloaded version', async () => {
    let listed = 0;
    let posted = 0;
    serve({
      routes: {
        'GET /v1/increment-cases': () => {
          listed += 1;
          // Meanwhile the case was proposed and returned: still open, with a newer version.
          const items = CASES.map((k) => (k.id === CASE_DRAFT && listed > 1 ? { ...k, state: 'RETURNED', proposedOutcome: 'INCREASE', version: 5 } : { ...k }));
          return [200, { items }];
        },
        [`POST /v1/increment-cases/${CASE_DRAFT}/proposal`]: () => {
          posted += 1;
          return posted === 1 ? [409, { error: 'STALE_VERSION', message: 'The record changed; reload and retry' }] : [200, { caseId: CASE_DRAFT, taskId: TASK, state: 'SUBMITTED' }];
        },
      },
    });
    renderPage([READ_OPERATIONAL, PROPOSE]);
    fireEvent.click(await screen.findByRole('button', { name: 'Propose outcome for SYN-301' }));
    const form = within(screen.getByRole('form', { name: /Proposal for SYN-301/ }));
    fireEvent.change(form.getByLabelText('Proposed outcome'), { target: { value: 'DEFER' } });
    fireEvent.change(form.getByLabelText('Reason (required)'), { target: { value: 'Project review pending (synthetic)' } });
    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));

    expect((await form.findByRole('alert')).textContent).toContain('(STALE_VERSION)');
    expect(await screen.findByText('The decision maker returned this case; propose again with any changes.')).toBeTruthy();
    expect(form.getByText('The case list was reloaded; check this case and send the proposal again.')).toBeTruthy();
    expect(screen.queryByText(/was not accepted, and the case list was reloaded/)).toBeNull();
    expect((form.getByLabelText('Reason (required)') as HTMLTextAreaElement).value).toBe('Project review pending (synthetic)');

    fireEvent.click(form.getByRole('button', { name: 'Send proposal' }));
    await waitFor(() => expect(callsTo('POST', `/v1/increment-cases/${CASE_DRAFT}/proposal`)).toHaveLength(2));
    expect(callsTo('POST', `/v1/increment-cases/${CASE_DRAFT}/proposal`).map((c) => c.body)).toEqual([
      { expectedVersion: 3, outcome: 'DEFER', reason: 'Project review pending (synthetic)' },
      { expectedVersion: 5, outcome: 'DEFER', reason: 'Project review pending (synthetic)' },
    ]);
    expect(await screen.findByText('Proposal for SYN-301 sent for an independent decision.')).toBeTruthy();
  });

  it('offers proposals only on open cycle cases, with the propose grant and a linked employee', async () => {
    serve({ amounts: true });
    renderPage([READ_OPERATIONAL, READ_SALARY, PROPOSE]);
    await screen.findByText('SYN-302');
    // DRAFT and RETURNED cycle cases only: not the submitted case and not the returned off-cycle case.
    expect(screen.getAllByRole('button', { name: /^Propose outcome for/ }).map((b) => b.getAttribute('aria-label'))).toEqual([
      'Propose outcome for SYN-301',
      'Propose outcome for SYN-302',
    ]);
    cleanup();

    serve({ amounts: true });
    renderPage([READ_OPERATIONAL, READ_SALARY, PROPOSE], { employeeId: null });
    await screen.findByText('SYN-302');
    expect(screen.queryByRole('button', { name: /^Propose outcome for/ })).toBeNull();
    cleanup();

    serve({ amounts: true });
    renderPage([READ_OPERATIONAL, READ_SALARY]);
    await screen.findByText('SYN-302');
    expect(screen.queryByRole('button', { name: /^Propose outcome for/ })).toBeNull();
  });

  it('sends the off-cycle body with the figures mapped to the chosen basis, exactly as typed', async () => {
    serve({ routes: { 'POST /v1/increment-cases/off-cycle': [201, { caseId: '30000000-0000-4000-8000-000000000099', taskId: TASK, state: 'SUBMITTED' }] } });
    renderPage([READ_OPERATIONAL, PROPOSE, LIST_EMPLOYEES]);
    const offCycle = await findSection('Propose an off-cycle change');
    await choose(offCycle, 'Find employee for the off-cycle change', 'Ravi', 'Choose Ravi Synthetic (SYN-302)');
    expect(callsTo('GET', '/v1/employees')[0]!.params.get('pageSize')).toBe('25');
    expect(within(offCycle).getByText('Ravi Synthetic (SYN-302)')).toBeTruthy();
    const form = within(within(offCycle).getByRole('form', { name: 'Off-cycle change' }));
    fireEvent.change(form.getByLabelText('Effective date'), { target: { value: '2027-10-01' } });
    fireEvent.change(form.getByLabelText('Increment basis'), { target: { value: 'ANNUAL_CTC' } });
    fireEvent.change(form.getByLabelText('New monthly gross'), { target: { value: '96800' } });
    fireEvent.change(form.getByLabelText('New annual CTC'), { target: { value: '1161600.25' } });
    fireEvent.change(form.getByLabelText('Reason (required)'), { target: { value: 'Role change (synthetic)' } });
    fireEvent.click(form.getByRole('button', { name: 'Send off-cycle proposal' }));

    await waitFor(() => expect(callsTo('POST', '/v1/increment-cases/off-cycle')).toHaveLength(1));
    expect(bodyOf('POST', '/v1/increment-cases/off-cycle')).toEqual({
      employeeId: E_RAVI,
      effectiveDate: '2027-10-01',
      basis: 'ANNUAL_CTC',
      proposedAmount: '1161600.25',
      proposedCounterpart: '96800',
      reason: 'Role change (synthetic)',
    });
    expect(await within(offCycle).findByText('Off-cycle proposal for Ravi Synthetic (SYN-302) sent for an independent decision.')).toBeTruthy();
  });

  it('asks for the employee before sending an off-cycle proposal', async () => {
    serve();
    renderPage([READ_OPERATIONAL, PROPOSE, LIST_EMPLOYEES]);
    const form = within(within(await findSection('Propose an off-cycle change')).getByRole('form', { name: 'Off-cycle change' }));
    fireEvent.change(form.getByLabelText('Effective date'), { target: { value: '2027-10-01' } });
    fireEvent.change(form.getByLabelText('New monthly gross'), { target: { value: '96800' } });
    fireEvent.change(form.getByLabelText('New annual CTC'), { target: { value: '1161600' } });
    fireEvent.change(form.getByLabelText('Reason (required)'), { target: { value: 'Role change (synthetic)' } });
    fireEvent.click(form.getByRole('button', { name: 'Send off-cycle proposal' }));
    expect(form.getByRole('alert').textContent).toBe('Choose the employee first.');
    expect(callsTo('POST', '/v1/increment-cases/off-cycle')).toHaveLength(0);
  });
});

/** GET /v1/bulk-jobs/:id of the opening job: counts and fixed values only in the result. */
function openingJob(state: string, extra: Record<string, unknown> = {}) {
  const done = state === 'COMPLETED';
  return {
    id: JOB,
    kind: 'INCREMENT_REVIEW_OPENING',
    state,
    parameters: { cycleId: CYCLE, year: 2027 },
    processed: done ? 4 : state === 'RUNNING' ? 2 : 0,
    result: {
      cycleId: CYCLE,
      cycleCode: state === 'QUEUED' ? null : 'ANNUAL',
      period: '2027',
      asOf: state === 'QUEUED' ? null : '2026-10-29',
      rerun: state === 'QUEUED' ? null : false,
      run: done ? 1 : null,
      created: done ? 2 : state === 'RUNNING' ? 1 : 0,
      excluded: done ? 1 : 0,
      excludedByReason: done ? { NOT_CONFIRMED: 1 } : {},
    },
    errorCode: null,
    attempts: 0,
    nextAttemptAt: null,
    createdAt: '2026-10-29T09:00:00.000Z',
    startedAt: state === 'QUEUED' ? null : '2026-10-29T09:00:01.000Z',
    finishedAt: done || state === 'FAILED' ? '2026-10-29T09:00:05.000Z' : null,
    ...extra,
  };
}

const REPAIR_NOT_CONFIRMED = "Record the employee's confirmation, then rerun the review before the roster freezes.";
const OPENED = (employeeId: string, employeeCode: string, employeeName: string, caseId: string) => ({
  caseId,
  employeeId,
  employeeCode,
  employeeName,
  occurrence: 'ANNUAL:2027',
  effectiveDate: '2027-04-01',
  decisionDueOn: '2027-03-15',
  state: 'DRAFT',
});

describe('cycles (FR-091, DF15)', () => {
  it('queues the opening of a review for the chosen year and says plainly that it is queued (NFR-S09)', async () => {
    serve({
      routes: {
        [`POST /v1/increment-cycles/${CYCLE}/reviews`]: [202, { jobId: JOB, state: 'QUEUED' }],
        [`GET /v1/bulk-jobs/${JOB}`]: [200, openingJob('QUEUED')],
      },
    });
    renderPage([CYCLE_MANAGE, READ_OPERATIONAL]);
    const cycles = await findSection('Increment cycles');
    await within(cycles).findByText('Service');
    // Only the active common-date cycle offers a review; the others say why.
    expect(within(cycles).getAllByRole('button', { name: 'Open review' })).toHaveLength(1);
    expect(within(cycles).getByText('Inactive cycle')).toBeTruthy();
    expect(within(cycles).getByText('No common review date')).toBeTruthy();
    await waitFor(() => expect(callsTo('GET', '/v1/increment-cases')).toHaveLength(1));

    fireEvent.change(within(cycles).getByLabelText('Review year'), { target: { value: '2027' } });
    fireEvent.click(within(cycles).getByRole('button', { name: 'Open review' }));
    await waitFor(() => expect(callsTo('POST', `/v1/increment-cycles/${CYCLE}/reviews`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/increment-cycles/${CYCLE}/reviews`)).toEqual({ year: 2027 });
    const status = await within(cycles).findByRole('status');
    expect(status.textContent).toBe(
      'Review of ANNUAL (revision 2) for 2027 queued. The draft cases are created in the background and appear in the case list once the opening has run.',
    );
    // The queued job's live status follows the message.
    const job = within(cycles).getByRole('region', { name: 'Background job status' });
    expect(await within(job).findByText('Queued')).toBeTruthy();
    expect(within(job).getByText('Increment review opening')).toBeTruthy();
    // Nothing is reported as opened, and no cases exist yet to reload or list.
    expect(within(cycles).queryByText(/opened/)).toBeNull();
    expect(within(cycles).queryByRole('table', { name: 'Excluded employees' })).toBeNull();
    expect(callsTo('GET', '/v1/increment-cases')).toHaveLength(1);
    expect(calls.filter((c) => c.path.startsWith('/v1/increment-review-openings/'))).toHaveLength(0);
  });

  it('follows the opening until it completes, then lists the cases it created and the employees it excluded with the repair path, and stops asking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let polls = 0;
    const casesUrl = `/v1/increment-review-openings/${JOB}/cases`;
    const exclusionsUrl = `/v1/increment-review-openings/${JOB}/exclusions`;
    const page = (items: unknown[], nextAfter: string | null) => ({ jobId: JOB, state: 'COMPLETED', run: 1, items, nextAfter });
    const NEXT = JSON.stringify(['SYN-301', 'ANNUAL:2027']);
    serve({
      routes: {
        [`POST /v1/increment-cycles/${CYCLE}/reviews`]: [202, { jobId: JOB, state: 'QUEUED' }],
        [`GET /v1/bulk-jobs/${JOB}`]: () => [200, openingJob(++polls === 1 ? 'RUNNING' : 'COMPLETED')],
        [`GET ${casesUrl}`]: (call) =>
          call.params.get('after') === NEXT
            ? [200, page([OPENED(E_RAVI, 'SYN-302', 'Ravi Synthetic', CASE_RETURNED)], null)]
            : [200, page([OPENED(E_ASHA, 'SYN-301', 'Asha Synthetic', CASE_DRAFT)], NEXT)],
        [`GET ${exclusionsUrl}`]: [
          200,
          page([{ employeeId: E_MEERA, employeeCode: 'SYN-303', employeeName: 'Meera Synthetic', occurrence: 'ANNUAL:2027', reason: 'NOT_CONFIRMED', repairPath: REPAIR_NOT_CONFIRMED }], null),
        ],
      },
    });
    renderPage([CYCLE_MANAGE, READ_OPERATIONAL]);
    const cycles = await findSection('Increment cycles');
    fireEvent.change(await within(cycles).findByLabelText('Review year'), { target: { value: '2027' } });
    fireEvent.click(within(cycles).getByRole('button', { name: 'Open review' }));
    const job = await within(cycles).findByRole('region', { name: 'Background job status' });
    expect(await within(job).findByText('Running')).toBeTruthy();
    expect(within(job).getByText('This status refreshes by itself.', { exact: false })).toBeTruthy();
    // Nothing is listed before the opening completes.
    expect(callsTo('GET', casesUrl)).toHaveLength(0);
    expect(callsTo('GET', '/v1/increment-cases')).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BULK_JOB_POLL_MS);
    });
    expect(await within(job).findByText('Completed')).toBeTruthy();
    expect((await within(cycles).findByRole('status')).textContent).toBe(
      'Review of ANNUAL (revision 2) for 2027 opened: 2 draft cases created, 1 employee excluded. It changed no salary.',
    );
    // The counts come from the job's result, in words.
    expect(within(job).getByText('Draft cases created').nextSibling?.textContent).toBe('2');
    expect(within(job).getByText('Employees excluded').nextSibling?.textContent).toBe('1');

    // The created cases, a page at a time.
    const cases = await within(cycles).findByRole('table', { name: 'Draft cases created' });
    expect(within(cases).getByText('Asha Synthetic (SYN-301)')).toBeTruthy();
    expect(within(cycles).getByText('Showing 1 of 2 cases.')).toBeTruthy();
    expect(callsTo('GET', casesUrl)[0]!.params.get('limit')).toBe('50');
    expect(callsTo('GET', casesUrl)[0]!.params.has('after')).toBe(false);
    fireEvent.click(within(cycles).getByRole('button', { name: 'Show more cases' }));
    expect(await within(cases).findByText('Ravi Synthetic (SYN-302)')).toBeTruthy();
    expect(callsTo('GET', casesUrl)[1]!.params.get('after')).toBe(NEXT);
    expect(within(cycles).queryByRole('button', { name: 'Show more cases' })).toBeNull();

    // The excluded employees with the reason in words and the server's repair path.
    const excluded = within(cycles).getByRole('table', { name: 'Excluded employees' });
    const meera = within(excluded).getByText('Meera Synthetic (SYN-303)').closest('tr') as HTMLElement;
    expect(within(meera).getByText('Not confirmed')).toBeTruthy();
    expect(within(meera).getByText(REPAIR_NOT_CONFIRMED)).toBeTruthy();
    // Operational fields only: no amount is shown.
    expect(within(cycles).queryByText(/INR/)).toBeNull();

    // The case list is reloaded once, and the finished job is not asked about again.
    await waitFor(() => expect(callsTo('GET', '/v1/increment-cases')).toHaveLength(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BULK_JOB_POLL_MS * 4);
    });
    expect(callsTo('GET', `/v1/bulk-jobs/${JOB}`)).toHaveLength(2);
  });

  it('says plainly why an opening stopped, and lists nothing', async () => {
    serve({
      routes: {
        [`POST /v1/increment-cycles/${CYCLE}/reviews`]: [202, { jobId: JOB, state: 'QUEUED' }],
        [`GET /v1/bulk-jobs/${JOB}`]: [200, openingJob('FAILED', { errorCode: 'ACCESS_REVOKED', processed: 2 })],
      },
    });
    renderPage([CYCLE_MANAGE, READ_OPERATIONAL]);
    const cycles = await findSection('Increment cycles');
    fireEvent.change(await within(cycles).findByLabelText('Review year'), { target: { value: '2027' } });
    fireEvent.click(within(cycles).getByRole('button', { name: 'Open review' }));
    const job = await within(cycles).findByRole('region', { name: 'Background job status' });
    expect((await within(job).findByRole('alert')).textContent).toContain('no longer holds the permission or the scope the job needs');
    expect(within(job).getByRole('alert').textContent).toContain('ACCESS_REVOKED');
    expect(within(cycles).getByRole('status').textContent).toBe('The review of ANNUAL (revision 2) for 2027 stopped before it finished; the reason is below.');
    expect(calls.filter((c) => c.path.startsWith('/v1/increment-review-openings/'))).toHaveLength(0);
  });

  it('shows the refusal of a review the server will not queue', async () => {
    serve({
      routes: {
        [`POST /v1/increment-cycles/${CYCLE}/reviews`]: [422, { error: 'CYCLE_NOT_EFFECTIVE', message: 'This revision does not govern the review effective 2031-04-01' }],
      },
    });
    renderPage([CYCLE_MANAGE, READ_OPERATIONAL]);
    const cycles = await findSection('Increment cycles');
    fireEvent.change(await within(cycles).findByLabelText('Review year'), { target: { value: '2031' } });
    fireEvent.click(within(cycles).getByRole('button', { name: 'Open review' }));
    expect((await within(cycles).findByRole('alert')).textContent).toContain('CYCLE_NOT_EFFECTIVE');
    expect(within(cycles).queryByRole('status')).toBeNull();
  });

  it('starts with no review year and checks the year format before opening a review', async () => {
    serve();
    renderPage([CYCLE_MANAGE, READ_OPERATIONAL]);
    const cycles = await findSection('Increment cycles');
    await within(cycles).findByText('Service');
    // Opened cases cannot be withdrawn, so the year is never prefilled.
    expect((within(cycles).getByLabelText('Review year') as HTMLInputElement).value).toBe('');
    fireEvent.submit(within(cycles).getByRole('form', { name: 'Open a review of ANNUAL revision 2' }));
    expect(within(cycles).getByRole('alert').textContent).toBe('Enter the review year as four digits, for example 2027.');
    expect(callsTo('POST', `/v1/increment-cycles/${CYCLE}/reviews`)).toHaveLength(0);
  });
});

describe('employee salary panel (FR-029, FR-089, FR-090, DF14)', () => {
  it('is absent without salary grants, and no salary data is requested', async () => {
    serve({ amounts: false });
    renderPage([READ_OPERATIONAL, LIST_EMPLOYEES, CYCLE_MANAGE, PROPOSE]);
    await screen.findByText('SYN-302');
    expect(screen.queryByRole('heading', { name: 'Employee salary' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Salary for/ })).toBeNull();
    expect(salaryCalls()).toHaveLength(0);
  });

  describe('history grants (C4; C6)', () => {
    it('the plain increment read grant shows no applied changes or annual growth, and asks the server for neither', async () => {
      serve({ routes: SALARY_ROUTES });
      renderPage([LIST_EMPLOYEES, SALARY_READ, READ_SALARY]);
      const panel = await findSection('Employee salary');
      await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
      await within(panel).findByRole('table', { name: 'Salary arrangements' });
      expect(within(panel).queryByRole('heading', { name: 'Increment history' })).toBeNull();
      expect(within(panel).queryByRole('heading', { name: 'Annual growth' })).toBeNull();
      expect(callsTo('GET', `/v1/employees/${E_ASHA}/increment-history`)).toHaveLength(0);
    });

    it('says earlier arrangements are withheld when the server leaves them out', async () => {
      serve({ routes: { ...SALARY_ROUTES, [`GET /v1/employees/${E_ASHA}/salary`]: [200, { employeeId: E_ASHA, historyIncluded: false, items: [{ id: 's-1', effectiveFrom: '2027-04-01', effectiveTo: null, annualCtc: '1320000.0000', monthlyGross: '110000.0000', currency: 'INR' }] }] } });
      renderPage([LIST_EMPLOYEES, SALARY_READ]);
      const panel = await findSection('Employee salary');
      await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
      expect(await within(panel).findByText('Earlier arrangements are not shown: the selected role has no salary history grant.')).toBeTruthy();
    });

    it('does not claim anything is withheld when the role holds the grant', async () => {
      serve({ routes: { ...SALARY_ROUTES, [`GET /v1/employees/${E_ASHA}/salary`]: [200, { employeeId: E_ASHA, historyIncluded: true, items: [{ id: 's-1', effectiveFrom: '2027-04-01', effectiveTo: null, annualCtc: '1320000.0000', monthlyGross: '110000.0000', currency: 'INR' }] }] } });
      renderPage([LIST_EMPLOYEES, SALARY_READ]);
      const panel = await findSection('Employee salary');
      await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
      await within(panel).findByRole('table', { name: 'Salary arrangements' });
      expect(within(panel).queryByText(/Earlier arrangements are not shown/)).toBeNull();
    });
  });

  describe('correcting an applied change (BR-038; DF14)', () => {
    const ROW = { basis: 'MONTHLY_GROSS', currency: 'INR', beforeAmount: '100000.0000', changeAmount: '10000.0000', changePercent: '10.00', percentNaReason: null };
    const HISTORY = {
      employeeId: E_ASHA,
      items: [
        { ...ROW, id: 'h-1', effectiveDate: '2027-04-01', afterAmount: '110000.0000', correctsHistoryId: null, supersededByHistoryId: 'h-2', correctable: false },
        { ...ROW, id: 'h-2', effectiveDate: '2027-04-01', afterAmount: '105000.0000', correctsHistoryId: 'h-1', supersededByHistoryId: null, correctable: true },
      ],
    };
    const routes = (post: Route = [201, { caseId: 'c-1', taskId: 't-1', state: 'SUBMITTED' }]) => ({
      ...SALARY_ROUTES,
      [`GET /v1/employees/${E_ASHA}/increment-history`]: [200, HISTORY] as Route,
      'POST /v1/increment-history/h-2/corrections': post,
    });
    const open = async (permissions: string[], me: { scopeKind?: string } = {}) => {
      renderPage(permissions, me);
      const panel = await findSection('Employee salary');
      await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
      return { panel, table: await within(panel).findByRole('table', { name: 'Increment history' }) };
    };
    const fill = (form: HTMLElement) => {
      fireEvent.change(within(form).getByLabelText('Effective date'), { target: { value: '2027-04-01' } });
      fireEvent.change(within(form).getByLabelText('Corrected monthly gross'), { target: { value: '106000' } });
      fireEvent.change(within(form).getByLabelText('Corrected annual CTC'), { target: { value: '1272000' } });
      fireEvent.change(within(form).getByLabelText('Reason (required)'), { target: { value: 'Amount entered wrongly (synthetic)' } });
    };

    it('marks the superseded record and the correction, and offers Correct only on the latest', async () => {
      serve({ routes: routes() });
      const { panel, table } = await open([LIST_EMPLOYEES, SALARY_READ, READ_HISTORY, 'increment.propose.salary']);
      expect(within(table).getByText('Superseded by a correction')).toBeTruthy();
      expect(within(table).getByText('Correction')).toBeTruthy();
      expect(within(table).getAllByRole('button', { name: 'Correct' })).toHaveLength(1);
      expect(within(panel).getByText('A superseded change stays on record; reports and annual growth use the correction.')).toBeTruthy();
    });

    it('needs the proposal duty and a company-wide assignment', async () => {
      serve({ routes: routes() });
      const reader = await open([LIST_EMPLOYEES, SALARY_READ, READ_HISTORY]);
      expect(within(reader.table).queryByRole('button', { name: 'Correct' })).toBeNull();
      cleanup();
      serve({ routes: routes() });
      const scoped = await open([LIST_EMPLOYEES, SALARY_READ, READ_HISTORY, 'increment.propose.salary'], { scopeKind: 'TEAM' });
      expect(within(scoped.table).queryByRole('button', { name: 'Correct' })).toBeNull();
    });

    it('sends both figures as typed, proposing no value, and says it waits for a decision', async () => {
      serve({ routes: routes() });
      const { panel, table } = await open([LIST_EMPLOYEES, SALARY_READ, READ_HISTORY, 'increment.propose.salary']);
      fireEvent.click(within(table).getByRole('button', { name: 'Correct' }));
      const form = within(panel).getByRole('form', { name: /^Correct the change effective/ });
      expect((within(form).getByLabelText('Corrected monthly gross') as HTMLInputElement).value).toBe('');
      expect((within(form).getByLabelText('Effective date') as HTMLInputElement).value).toBe('');
      fill(form);
      fireEvent.click(within(form).getByRole('button', { name: 'Send correction' }));
      await within(panel).findByText('Correction sent for an independent decision.');
      expect(bodyOf('POST', '/v1/increment-history/h-2/corrections')).toEqual({ effectiveDate: '2027-04-01', proposedAmount: '106000', proposedCounterpart: '1272000', reason: 'Amount entered wrongly (synthetic)' });
      expect(within(panel).queryByRole('form', { name: /^Correct the change effective/ })).toBeNull();
    });

    it('checks the amounts before sending, and explains a period payroll has processed', async () => {
      serve({ routes: routes([409, { error: 'PAYROLL_PROCESSED', message: 'Server text', details: { processedThrough: '2027-04-30' } }]) });
      const { panel, table } = await open([LIST_EMPLOYEES, SALARY_READ, READ_HISTORY, 'increment.propose.salary']);
      fireEvent.click(within(table).getByRole('button', { name: 'Correct' }));
      const form = within(panel).getByRole('form', { name: /^Correct the change effective/ });
      fill(form);
      fireEvent.change(within(form).getByLabelText('Corrected monthly gross'), { target: { value: '1,06,000' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Send correction' }));
      expect((await within(form).findByRole('alert')).textContent).toContain('no commas or spaces');
      expect(callsTo('POST', '/v1/increment-history/h-2/corrections')).toHaveLength(0);

      fireEvent.change(within(form).getByLabelText('Corrected monthly gross'), { target: { value: '106000' } });
      fireEvent.click(within(form).getByRole('button', { name: 'Send correction' }));
      await waitFor(() => expect(within(form).getByRole('alert').textContent).toContain('processed payroll never changes'));
      expect(within(form).getByRole('alert').textContent).not.toContain('Server text');
    });
  });

  it('shows arrangements, increment history and annual growth for the chosen financial year', async () => {
    serve({ routes: SALARY_ROUTES });
    renderPage([LIST_EMPLOYEES, SALARY_READ, READ_HISTORY]);
    const panel = await findSection('Employee salary');
    await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');

    const arrangements = within(await within(panel).findByRole('table', { name: 'Salary arrangements' }));
    expect(arrangements.getAllByRole('row')).toHaveLength(4);
    expect(arrangements.getByText('No end date')).toBeTruthy();
    expect(arrangements.getByText(formatAmount('1452000.0000', 'INR'))).toBeTruthy();

    const history = within(await within(panel).findByRole('table', { name: 'Increment history' }));
    expect(history.getAllByText('10.00%')).toHaveLength(2);
    expect(history.getByText(formatAmount('11000.0000', 'INR'))).toBeTruthy();
    expect(history.getByText('Off-cycle approval (synthetic)')).toBeTruthy();

    fireEvent.change(within(panel).getByLabelText('Financial year from April'), { target: { value: '2027' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Show growth' }));
    expect(await within(panel).findByText('21.00%')).toBeTruthy();
    const growthCall = callsTo('GET', `/v1/employees/${E_ASHA}/annual-increment`)[0]!;
    expect(growthCall.params.get('financialYear')).toBe('2027');
    expect(growthCall.params.get('basis')).toBe('MONTHLY_GROSS');
    const changes = within(within(panel).getByRole('table', { name: 'Changes in the year' }));
    expect(changes.getAllByText('10.00%')).toHaveLength(2);
    expect(within(panel).getByText(/the change percentages are never added up/)).toBeTruthy();

    // Not applicable is shown with the server's reason, distinct from an empty year.
    fireEvent.change(within(panel).getByLabelText('Financial year from April'), { target: { value: '2024' } });
    fireEvent.change(within(panel).getByLabelText('Basis'), { target: { value: 'ANNUAL_CTC' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Show growth' }));
    expect(await within(panel).findByText('N/A: no salary in force at the start or the end of the year')).toBeTruthy();
    expect(within(panel).getByText('No increments took effect in this financial year.')).toBeTruthy();
    expect(callsTo('GET', `/v1/employees/${E_ASHA}/annual-increment`)[1]!.params.get('basis')).toBe('ANNUAL_CTC');
    // Without the manage grant there is no salary entry.
    expect(within(panel).queryByRole('form', { name: 'Initial salary' })).toBeNull();
  });

  it('shows each part only with its own grant', async () => {
    serve({ routes: SALARY_ROUTES });
    renderPage([LIST_EMPLOYEES, READ_HISTORY]);
    let panel = await findSection('Employee salary');
    await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
    expect(await within(panel).findByRole('table', { name: 'Increment history' })).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: 'Annual growth' })).toBeTruthy();
    expect(within(panel).queryByRole('heading', { name: 'Salary arrangements' })).toBeNull();
    expect(callsTo('GET', `/v1/employees/${E_ASHA}/salary`)).toHaveLength(0);
    cleanup();

    serve({ routes: SALARY_ROUTES });
    renderPage([LIST_EMPLOYEES, SALARY_READ]);
    panel = await findSection('Employee salary');
    await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
    expect(await within(panel).findByRole('table', { name: 'Salary arrangements' })).toBeTruthy();
    expect(within(panel).queryByRole('heading', { name: 'Increment history' })).toBeNull();
    expect(within(panel).queryByRole('heading', { name: 'Annual growth' })).toBeNull();
    expect(callsTo('GET', `/v1/employees/${E_ASHA}/increment-history`)).toHaveLength(0);
    expect(within(panel).queryByRole('form', { name: 'Initial salary' })).toBeNull();
  });

  it('records the initial salary exactly as typed when none exists, and does not offer it otherwise', async () => {
    serve({
      routes: {
        ...SALARY_ROUTES,
        [`GET /v1/employees/${E_MEERA}/salary`]: [200, { employeeId: E_MEERA, items: [] }],
        [`POST /v1/employees/${E_MEERA}/salary`]: [201, { id: '60000000-0000-4000-8000-000000000099' }],
      },
    });
    renderPage([LIST_EMPLOYEES, SALARY_READ, SALARY_MANAGE]);
    const panel = await findSection('Employee salary');
    // An employee who already has an arrangement changes salary through an increment case only.
    await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
    await within(panel).findByRole('table', { name: 'Salary arrangements' });
    expect(within(panel).queryByRole('form', { name: 'Initial salary' })).toBeNull();

    fireEvent.click(within(panel).getByRole('button', { name: 'Choose another employee' }));
    await choose(panel, 'Find employee to view salary', 'Meera', 'Choose Meera Synthetic (SYN-303)');
    expect(await within(panel).findByText('No salary arrangement is recorded for this employee.')).toBeTruthy();
    const form = within(within(panel).getByRole('form', { name: 'Initial salary' }));
    fireEvent.change(form.getByLabelText('Effective from'), { target: { value: '2026-11-01' } });
    fireEvent.change(form.getByLabelText('Monthly gross'), { target: { value: '85000.50' } });
    fireEvent.change(form.getByLabelText('Annual CTC'), { target: { value: '1026006' } });
    expect((form.getByLabelText('Currency') as HTMLInputElement).value).toBe('INR');
    fireEvent.click(form.getByRole('button', { name: 'Record initial salary' }));

    await waitFor(() => expect(callsTo('POST', `/v1/employees/${E_MEERA}/salary`)).toHaveLength(1));
    expect(bodyOf('POST', `/v1/employees/${E_MEERA}/salary`)).toEqual({ effectiveFrom: '2026-11-01', monthlyGross: '85000.50', annualCtc: '1026006', currency: 'INR' });
    expect(await within(panel).findByText('Initial salary recorded.')).toBeTruthy();
    expect(within(panel).queryByRole('form', { name: 'Initial salary' })).toBeNull();
  });

  it('opens the panel for the employee of a case row', async () => {
    serve({ amounts: true, routes: SALARY_ROUTES });
    renderPage([READ_OPERATIONAL, READ_SALARY, READ_HISTORY, SALARY_READ]);
    fireEvent.click(await screen.findByRole('button', { name: 'Salary for SYN-302' }));
    const panel = sectionOf('Employee salary');
    expect(within(panel).getByText('SYN-302')).toBeTruthy();
    expect(await within(panel).findByText('No salary arrangement is recorded for this employee.')).toBeTruthy();
    expect(await within(panel).findByText('No increments have been applied for this employee.')).toBeTruthy();
    expect(callsTo('GET', `/v1/employees/${E_RAVI}/salary`)).toHaveLength(1);
  });

  it('says not permitted when the server refuses a salary read', async () => {
    serve({ routes: { ...SALARY_ROUTES, [`GET /v1/employees/${E_ASHA}/salary`]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] } });
    renderPage([LIST_EMPLOYEES, SALARY_READ]);
    const panel = await findSection('Employee salary');
    await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
    expect(await within(panel).findByText('The selected role cannot read this employee’s salary.')).toBeTruthy();
    expect(within(panel).queryByText('No salary arrangement is recorded for this employee.')).toBeNull();
  });

  it('does not label the opening amount with the closing currency when the currency changed in the year', async () => {
    serve({
      routes: {
        ...SALARY_ROUTES,
        [`GET /v1/employees/${E_ASHA}/annual-increment`]: (call) => [
          200,
          {
            employeeId: E_ASHA,
            financialYear: Number(call.params.get('financialYear')),
            basis: 'MONTHLY_GROSS',
            periodStart: '2029-04-01',
            periodEnd: '2030-03-31',
            opening: '100000.0000',
            closing: '1500.0000',
            currency: 'USD',
            annualGrowthPercent: null,
            percentNaReason: 'CURRENCY_CHANGED',
            changes: [],
          },
        ],
      },
    });
    renderPage([LIST_EMPLOYEES, READ_HISTORY]);
    const panel = await findSection('Employee salary');
    await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
    fireEvent.change(within(panel).getByLabelText('Financial year from April'), { target: { value: '2029' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'Show growth' }));
    expect(await within(panel).findByText('N/A: the currency changed')).toBeTruthy();
    expect(within(panel).getByText(formatAmount('1500.0000', 'USD'))).toBeTruthy();
    expect(within(panel).getByText(formatAmount('100000.0000', '').trim())).toBeTruthy();
    expect(within(panel).queryByText(formatAmount('100000.0000', 'USD'))).toBeNull();
    expect(within(panel).getByText(/currency changed during the year/)).toBeTruthy();
  });
});

describe('cached answers (C1, BR-046)', () => {
  it('never shows case amounts that another assignment left in the shared query cache', async () => {
    const client = newClient();
    serve({ amounts: true });
    renderPage([READ_OPERATIONAL, READ_SALARY], { client, assignmentId: 'assignment-hr-salary' });
    await within(await findSection(/^Increment cases/)).findByText(formatAmount('88000.0000', 'INR'));
    cleanup();

    // The same browser switches to an assignment without the salary grant; its own answer is still on the way.
    let release: (reply: Reply) => void = () => undefined;
    serve({ routes: { 'GET /v1/increment-cases': () => new Promise<Reply>((resolve) => (release = resolve)) } });
    renderPage([READ_OPERATIONAL], { client, assignmentId: 'assignment-team-manager', scopeKind: 'TEAM' });
    const cases = sectionOf(/^Increment cases/);
    await waitFor(() => expect(callsTo('GET', '/v1/increment-cases')).toHaveLength(1));
    expect(within(cases).getByText('Loading cases…')).toBeTruthy();
    expect(within(cases).queryByText('SYN-302')).toBeNull();
    expect(within(cases).queryByRole('columnheader', { name: 'Baseline' })).toBeNull();
    expect(within(cases).queryByText(/INR/)).toBeNull();

    release([200, { items: CASES.filter((k) => k.employeeCode === 'SYN-302').map((k) => ({ ...k })) }]);
    expect(await within(cases).findByText('SYN-302')).toBeTruthy();
    expect(within(cases).queryByText('SYN-303')).toBeNull();
    expect(within(cases).queryByRole('columnheader', { name: 'Baseline' })).toBeNull();
    expect(within(cases).getByText('Amounts are shown only to roles holding a confidential salary grant.')).toBeTruthy();
  });

  it('stops showing a salary the server now refuses, although an earlier answer is cached', async () => {
    const client = newClient();
    serve({ routes: SALARY_ROUTES });
    renderPage([LIST_EMPLOYEES, SALARY_READ], { client });
    let panel = await findSection('Employee salary');
    await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
    expect(await within(panel).findByRole('table', { name: 'Salary arrangements' })).toBeTruthy();
    cleanup();

    // The grant was withdrawn meanwhile: the next read of the same employee in the same assignment is refused.
    serve({ routes: { ...SALARY_ROUTES, [`GET /v1/employees/${E_ASHA}/salary`]: [403, { error: 'FORBIDDEN', message: 'Not permitted' }] } });
    renderPage([LIST_EMPLOYEES, SALARY_READ], { client });
    panel = await findSection('Employee salary');
    await choose(panel, 'Find employee to view salary', 'Asha', 'Choose Asha Synthetic (SYN-301)');
    expect(await within(panel).findByText('The selected role cannot read this employee’s salary.')).toBeTruthy();
    expect(within(panel).queryByRole('table', { name: 'Salary arrangements' })).toBeNull();
    expect(within(panel).queryByText(formatAmount('1452000.0000', 'INR'))).toBeNull();
  });
});

describe('controls hidden without permissions (C1)', () => {
  it('hides cycle management, proposals, off-cycle changes, the decision inbox link and the salary panel', async () => {
    serve({ amounts: false });
    renderPage([READ_OPERATIONAL]);
    const cases = await findSection(/^Increment cases/);
    await within(cases).findByText('SYN-302');
    expect(screen.queryByRole('heading', { name: 'Increment cycles' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open review' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Propose outcome for/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Propose an off-cycle change' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Decisions' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Employee salary' })).toBeNull();
    expect(calls.every((c) => c.method === 'GET' && c.path === '/v1/increment-cases')).toBe(true);
  });

  it('hides company-wide actions from a role that is not company-wide', async () => {
    serve({ amounts: true });
    renderPage([CYCLE_MANAGE, READ_OPERATIONAL, READ_SALARY, PROPOSE, LIST_EMPLOYEES], { scopeKind: 'TEAM' });
    const cycles = await findSection('Increment cycles');
    await within(cycles).findByText('Service');
    expect(within(cycles).queryByRole('button', { name: 'Open review' })).toBeNull();
    expect(within(cycles).getByText('Reviews are opened from a company-wide role')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Propose an off-cycle change' })).toBeNull();
    // The direct manager still proposes cycle outcomes for the team.
    expect(await screen.findByRole('button', { name: 'Propose outcome for SYN-302' })).toBeTruthy();
  });

  it('links to the decision inbox for a role that decides increments, and decides nothing here', async () => {
    serve({ amounts: true });
    renderPage([READ_OPERATIONAL, READ_SALARY, APPROVE]);
    const link = await screen.findByRole('link', { name: 'Decisions' });
    expect(link.getAttribute('href')).toBe('/tasks');
    await screen.findByText('SYN-302');
    expect(screen.queryByRole('button', { name: /approve|reject|return/i })).toBeNull();
  });
});
