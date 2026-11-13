// Statutory settings screen (I-85, FR-039), jsdom: the dated work location states (professional tax and labour welfare fund) and an
// employee's PF contribution basis, as the server returns them; recording each with its date; gating by the payroll configuration
// duties (an employee's PF option is read and written under manage only); refusals in plain words. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { STATUTORY_SETTINGS_SCREENS } from './statutory-settings';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({
    stored: { token: 'synthetic-token', companies: [], companyId: 'c0000000-0000-4000-8000-000000000001', assignmentId: 'a0000000-0000-4000-8000-000000000001' },
    me: { userId: 'b0000000-0000-4000-8000-000000000001', scopeKind: 'COMPANY', employeeId: null, roleCode: 'HR_ADMINISTRATOR' },
    can: (permission: string) => session.permissions.includes(permission),
  }),
}));

const READ = 'payroll_config.read.operational';
const MANAGE = 'payroll_config.manage.operational';
const E1 = 'e0000000-0000-4000-8000-000000000001';

type Reply = [number, unknown];
interface Call {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | null;
}
let calls: Call[] = [];

function serve(routes: Record<string, Reply | Reply[]>) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://hrms.test');
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, search: url.search, body: init?.body ? JSON.parse(String(init.body)) : null });
      const route = routes[`${method} ${url.pathname}`];
      const reply: Reply = route === undefined ? [404, { error: 'NOT_FOUND', message: `No mock for ${method} ${url.pathname}` }] : Array.isArray(route[0]) ? (route as Reply[]).shift()! : (route as Reply);
      return new Response(JSON.stringify(reply[1]), { status: reply[0], headers: { 'content-type': 'application/json' } });
    }),
  );
}
function renderScreen(permissions: string[]) {
  session.permissions = permissions;
  const Screen = STATUTORY_SETTINGS_SCREENS[0]!.component;
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>
      <MemoryRouter initialEntries={['/payroll/statutory-settings']}>
        <Screen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const STATES = {
  items: [
    { id: 's1', locationCode: 'MUM', sequence: 1, effectiveFrom: '2026-01-01', stateCode: 'MH' },
    { id: 's2', locationCode: 'MUM', sequence: 2, effectiveFrom: '2026-06-01', stateCode: 'KA' },
  ],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('statutory settings', () => {
  it('exports one menu screen under the payroll configuration read duty', () => {
    expect(STATUTORY_SETTINGS_SCREENS.map((s) => [s.path, s.title, s.permission, s.nav])).toEqual([['/payroll/statutory-settings', 'Statutory settings', READ, true]]);
  });

  it('a reader sees the dated work location states and is offered no form, nor any employee’s PF option', async () => {
    serve({ 'GET /v1/statutory/pt-states': [200, STATES] });
    renderScreen([READ]);
    const table = await screen.findByRole('table', { name: 'Work location states' });
    expect(within(table).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell').map((c) => c.textContent))).toEqual([
      ['MUM', '1 Jan 2026', 'MH'],
      ['MUM', '1 Jun 2026', 'KA'],
    ]);
    expect(screen.queryByRole('form', { name: 'Record a work location state' })).toBeNull();
    expect(screen.queryByRole('form', { name: 'Find an employee' })).toBeNull();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /v1/statutory/pt-states']);
  });

  it('records a location’s state from a date, upper-cased, and shows the server’s refusal in words', async () => {
    serve({
      'GET /v1/statutory/pt-states': [200, STATES],
      'POST /v1/statutory/pt-states': [
        [422, { error: 'UNKNOWN_LOCATION', message: 'No work location has that code' }],
        [201, { id: 's3', locationCode: 'PUN', sequence: 1, effectiveFrom: '2026-07-01', stateCode: 'MH' }],
      ],
    });
    renderScreen([READ, MANAGE]);
    const form = await screen.findByRole('form', { name: 'Record a work location state' });
    fireEvent.change(within(form).getByLabelText('Location code'), { target: { value: 'XYZ' } });
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-07-01' } });
    fireEvent.change(within(form).getByLabelText('State (two letters)'), { target: { value: 'mh' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record the state' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No work location has that code');
    fireEvent.change(within(form).getByLabelText('Location code'), { target: { value: 'PUN' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record the state' }));
    expect((await screen.findByRole('status')).textContent).toBe('Recorded: PUN is in MH from 1 Jul 2026.');
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toEqual([
      { locationCode: 'XYZ', effectiveFrom: '2026-07-01', stateCode: 'MH' },
      { locationCode: 'PUN', effectiveFrom: '2026-07-01', stateCode: 'MH' },
    ]);
  });

  it('finds an employee, shows their PF options (none: the ceiling applies) and records a joint option with its reference', async () => {
    serve({
      'GET /v1/statutory/pt-states': [200, { items: [] }],
      'GET /v1/employees': [200, { items: [{ id: E1, employeeCode: 'SYN-001', displayName: 'Asha Synthetic' }] }],
      'GET /v1/statutory/pf-options': [
        [200, { items: [] }],
        [200, { items: [{ id: 'o1', sequence: 1, effectiveFrom: '2026-04-01', contributionBasis: 'HIGHER_WAGES', reference: 'Form 26(6)-001' }] }],
      ],
      'POST /v1/statutory/pf-options': [201, { id: 'o1', sequence: 1, effectiveFrom: '2026-04-01', contributionBasis: 'HIGHER_WAGES', reference: 'Form 26(6)-001' }],
    });
    renderScreen([READ, MANAGE]);
    const find = await screen.findByRole('form', { name: 'Find an employee' });
    fireEvent.change(within(find).getByLabelText('Employee code or name'), { target: { value: 'SYN' } });
    fireEvent.click(within(find).getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'SYN-001 Asha Synthetic' }));
    expect(await screen.findByText('No option recorded: contributions are on wages up to the ceiling.')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Record a PF option' });
    fireEvent.change(within(form).getByLabelText('From'), { target: { value: '2026-04-01' } });
    fireEvent.change(within(form).getByLabelText('Reference (the option form)'), { target: { value: 'Form 26(6)-001' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Record the option' }));
    expect((await screen.findByRole('status')).textContent).toBe('Recorded: On higher wages (joint option, para 26(6)) from 1 Apr 2026.');
    const options = await screen.findByRole('table', { name: 'PF options' });
    expect(options.textContent).toContain('Form 26(6)-001');
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ employeeId: E1, effectiveFrom: '2026-04-01', contributionBasis: 'HIGHER_WAGES', reference: 'Form 26(6)-001' });
    expect(calls.filter((c) => c.path === '/v1/statutory/pf-options' && c.method === 'GET').map((c) => c.search)).toEqual([`?employeeId=${E1}`, `?employeeId=${E1}`]);
    await waitFor(() => expect(calls.find((c) => c.path === '/v1/employees')!.search).toContain('search=SYN'));
  });

  it('a role without either duty is told so and calls nothing', () => {
    serve({});
    renderScreen([]);
    expect(screen.getByText('The selected role cannot see the statutory settings.')).toBeTruthy();
    expect(calls).toEqual([]);
  });
});
