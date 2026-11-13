// Changing several people's manager (jsdom; coverage CL-020 under FR-003 and FR-009): people are filtered and chosen, one manager,
// date and reason are sent, moving open approvals is offered only with the routing duty and not for a future date, the new manager
// cannot be among the chosen, and the server's answer reads in plain words. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MANAGER_CHANGE_SCREENS, ManagerChangePage } from './manager-change';
import type { OrgChartNode } from './org-chart';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

const person = (id: string, name: string, managerId: string | null, department: string, location = 'Pune'): OrgChartNode => ({
  id,
  code: id.toUpperCase(),
  name,
  designation: 'Analyst',
  department,
  location,
  managerId,
});
const PEOPLE = [
  person('m1', 'Meera Old', null, 'Finance'),
  person('m2', 'Nikhil New', null, 'Finance'),
  person('e1', 'Asha Rao', 'm1', 'Finance'),
  person('e2', 'Bina Shah', 'm1', 'Finance', 'Mumbai'),
  person('e3', 'Chirag Iyer', 'm2', 'Sales'),
];

type Call = { method: string; url: string; body: Record<string, unknown> | undefined };
function serve(reply: [number, unknown] = [200, { changed: ['e1', 'e2'], unchanged: [], moved: [], left: 0 }]) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(init.body as string) : undefined };
      calls.push(call);
      const [status, body] = url === '/v1/org/chart' ? [200, { asOf: '2026-11-11', items: PEOPLE, truncated: false }] : reply;
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ManagerChangePage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
const field = (label: string) => within(screen.getByRole('form', { name: 'New manager' })).getByLabelText(label);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('change manager screen (CL-020; FR-003, FR-009)', () => {
  it('is an employee menu screen under the employee update duty', () => {
    expect(MANAGER_CHANGE_SCREENS.map((s) => [s.path, s.permission, s.nav])).toEqual([['/employees/manager-change', 'employee.update.operational', true]]);
  });

  it('filters by current manager, chooses everyone shown and sends one manager, date and reason', async () => {
    const calls = serve();
    show();
    await screen.findByRole('table', { name: 'People' });
    fireEvent.change(screen.getByLabelText('Current manager'), { target: { value: 'm1' } });
    const table = screen.getByRole('table', { name: 'People' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    fireEvent.click(screen.getByLabelText('Choose everyone shown'));
    expect(screen.getByText('New manager for 2 people')).toBeTruthy();
    fireEvent.change(field('New manager'), { target: { value: 'm2' } });
    expect(screen.queryByText(/Also move their open approvals/)).toBeNull();
    fireEvent.change(field('Reason'), { target: { value: '  Team restructure  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change manager' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('2 people now report to Nikhil New from 11 Nov 2026.');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('/v1/employees/manager-changes');
    expect(post.body).toEqual({ employeeIds: ['e1', 'e2'], managerEmployeeId: 'm2', effectiveFrom: '2026-11-11', reason: 'Team restructure' });
  });

  it('offers moving open approvals only with the routing duty, refuses it for a future date, and reports what moved', async () => {
    session.permissions = ['workflow.reroute_task.operational'];
    const calls = serve([200, { changed: ['e1'], unchanged: [], moved: [{ taskId: 't2', supersededTaskId: 't1', ownerEmployeeId: 'e1' }], left: 1 }]);
    show();
    await screen.findByRole('table', { name: 'People' });
    fireEvent.click(screen.getByLabelText('Choose Asha Rao'));
    fireEvent.change(field('New manager'), { target: { value: 'm2' } });
    fireEvent.change(field('Reason'), { target: { value: 'Synthetic' } });
    fireEvent.click(screen.getByLabelText(/Also move their open approvals/));
    fireEvent.change(field('Effective from'), { target: { value: '2026-12-01' } });
    expect(screen.getByText(/can move only once the change is in effect/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Change manager' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field('Effective from'), { target: { value: '2026-11-11' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change manager' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('1 open approval moved to the new manager; 1 stay with an approver'));
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ moveOpenApprovals: true });
  });

  it('will not send the new manager among the people chosen', async () => {
    const calls = serve();
    show();
    await screen.findByRole('table', { name: 'People' });
    fireEvent.click(screen.getByLabelText('Choose Nikhil New'));
    fireEvent.change(field('New manager'), { target: { value: 'm2' } });
    fireEvent.change(field('Reason'), { target: { value: 'Synthetic' } });
    expect(screen.getByText(/no one can manage themselves/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Change manager' }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('reads a refusal in plain words and keeps the choice', async () => {
    serve([422, { error: 'RULE_VIOLATION', message: 'The manager must be an active employee' }]);
    show();
    await screen.findByRole('table', { name: 'People' });
    fireEvent.click(screen.getByLabelText('Choose Chirag Iyer'));
    fireEvent.change(field('New manager'), { target: { value: 'm1' } });
    fireEvent.change(field('Reason'), { target: { value: 'Synthetic' } });
    fireEvent.click(screen.getByRole('button', { name: 'Change manager' }));
    expect(await screen.findByText('The manager must be an active employee. Nothing was changed.')).toBeTruthy();
    expect((screen.getByLabelText('Choose Chirag Iyer') as HTMLInputElement).checked).toBe(true);
  });

  it('filters by department and location', async () => {
    serve();
    show();
    await screen.findByRole('table', { name: 'People' });
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: 'Sales' } });
    expect(within(screen.getByRole('table', { name: 'People' })).getAllByRole('row')).toHaveLength(2);
    fireEvent.change(screen.getByLabelText('Department'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Location'), { target: { value: 'Mumbai' } });
    expect(screen.getByText('Bina Shah')).toBeTruthy();
    expect(screen.queryByText('Asha Rao')).toBeNull();
  });
});
