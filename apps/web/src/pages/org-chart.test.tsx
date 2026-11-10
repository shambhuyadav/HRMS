// Organisation chart (jsdom; coverage CL-023 under FR-001 and FR-003): the tree is built from each person's manager, the top of each
// branch opens by default (two levels show), branches open and close, a search keeps the matches with the line above them, and names link to the record only
// for a session that may read it. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOrgTree, type OrgChartNode, OrgChartPage } from './org-chart';
import { ORG_SCREENS } from './org';

const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('../session', () => ({
  useSession: () => ({ stored: { companyId: 'c-1', assignmentId: 'a-1' }, me: { employeeId: null, scopeKind: 'COMPANY' }, can: (p: string) => session.permissions.includes(p) }),
}));

const node = (id: string, name: string, managerId: string | null, designation = 'Analyst'): OrgChartNode => ({
  id,
  code: id.toUpperCase(),
  name,
  designation,
  department: 'Finance',
  location: 'Pune',
  managerId,
});
const PEOPLE = [
  node('e0', 'Asha Rao', null, 'Director'),
  node('e1', 'Bina Shah', 'e0', 'Manager'),
  node('e2', 'Chirag Iyer', 'e1'),
  node('e3', 'Deepa Nair', 'e1'),
  node('e4', 'Eshan Gill', 'e2', 'Trainee'),
  node('e5', 'Farah Khan', 'e0', 'Lead'),
  node('e6', 'Gopal Das', 'outside', 'Consultant'),
];

function serve(items: OrgChartNode[], truncated = false) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ asOf: '2026-11-10', items, truncated }), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
  return calls;
}
const show = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <OrgChartPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  session.permissions = [];
});

describe('organisation chart tree (CL-023)', () => {
  it('builds roots from people whose manager is not in the list, and counts everyone below', () => {
    const tree = buildOrgTree(PEOPLE);
    expect(tree.roots.map((r) => r.id)).toEqual(['e0', 'e6']);
    expect(tree.children.get('e1')!.map((c) => c.id)).toEqual(['e2', 'e3']);
    expect(tree.below.get('e0')).toBe(5);
    expect(tree.below.get('e1')).toBe(3);
    expect(tree.parent.get('e4')).toBe('e2');
  });

  it('still shows everyone when the reporting lines loop', () => {
    const tree = buildOrgTree([node('a', 'A', 'b'), node('b', 'B', 'a')]);
    expect(tree.roots).toHaveLength(1);
    const shown = new Set([...tree.roots.map((r) => r.id), ...[...tree.children.values()].flat().map((c) => c.id)]);
    expect([...shown].sort()).toEqual(['a', 'b']);
  });
});

describe('organisation chart page (FR-001, FR-003)', () => {
  it('is on the organisation menu for a session that may list employees', () => {
    const route = ORG_SCREENS.find((s) => s.path === '/organisation/chart')!;
    expect(route.permission).toBe('employee.list.operational');
    expect(route.nav).toBe(true);
  });

  it('shows the top two levels, then opens and closes a branch', async () => {
    const calls = serve(PEOPLE);
    show();
    const tree = await screen.findByRole('tree', { name: 'Organisation chart' });
    expect(calls).toEqual(['/v1/org/chart']);
    expect(within(tree).getByText('Asha Rao')).toBeTruthy();
    expect(within(tree).getByText('Bina Shah')).toBeTruthy();
    expect(within(tree).getByText('Gopal Das')).toBeTruthy();
    expect(within(tree).queryByText('Chirag Iyer')).toBeNull();
    expect(screen.getByLabelText('Chart summary').textContent).toContain('7 people');
    fireEvent.click(screen.getByRole('button', { name: 'Show the team of Bina Shah' }));
    expect(within(tree).getByText('Chirag Iyer')).toBeTruthy();
    expect(within(tree).queryByText('Eshan Gill')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the team of Bina Shah' }));
    expect(within(tree).queryByText('Chirag Iyer')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(within(tree).getByText('Eshan Gill')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(within(tree).queryByText('Bina Shah')).toBeNull();
  });

  it('a search keeps the matches and the line above them, all open', async () => {
    serve(PEOPLE);
    show();
    await screen.findByRole('tree');
    fireEvent.change(screen.getByLabelText('Find a person'), { target: { value: 'trainee' } });
    const tree = screen.getByRole('tree');
    for (const name of ['Asha Rao', 'Bina Shah', 'Chirag Iyer', 'Eshan Gill']) expect(within(tree).getByText(name)).toBeTruthy();
    for (const name of ['Deepa Nair', 'Farah Khan', 'Gopal Das']) expect(within(tree).queryByText(name)).toBeNull();
    fireEvent.change(screen.getByLabelText('Find a person'), { target: { value: 'nobody here' } });
    expect(screen.getByText(/No one matches/)).toBeTruthy();
  });

  it('links names to the record only for a session that may read it', async () => {
    serve(PEOPLE);
    const first = show();
    await screen.findByRole('tree');
    expect(screen.queryByRole('link', { name: 'Asha Rao' })).toBeNull();
    first.unmount();
    session.permissions = ['employee.read.operational'];
    show();
    const link = await screen.findByRole('link', { name: 'Asha Rao' });
    expect(link.getAttribute('href')).toBe('/employees/e0');
  });

  it('says when no one is visible and when the answer was cut short', async () => {
    serve([]);
    const first = show();
    expect(await screen.findByText('No one employed today is visible to you.')).toBeTruthy();
    first.unmount();
    serve(PEOPLE.slice(0, 2), true);
    show();
    expect(await screen.findByText(/shows the first 2 people only/)).toBeTruthy();
  });
});
