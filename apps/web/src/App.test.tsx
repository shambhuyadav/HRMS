// The app shell: every registered screen is routed once, and the menu shows an entry only to a context that holds its
// permission (the server still re-checks every call). Own-record entries (H3, BR-055) appear only in an OWN context
// linked to an employee. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App, APP_ROUTE_PATHS, moduleGroupOf, visibleModuleGroups, visibleNav } from './App';
import { MODULE_SCREENS } from './screens-registry';

const session = vi.hoisted(() => ({
  value: {
    stored: { token: 'tkn', companies: [], companyId: 'company-1', assignmentId: 'assignment-1' },
    me: null as null | Record<string, unknown>,
    granted: new Set<string>(),
  },
}));

vi.mock('./session', () => ({
  useSession: () => ({
    stored: session.value.stored,
    me: session.value.me,
    can: (p: string) => session.value.granted.has(p),
    switchRole: () => undefined,
    signOut: async () => undefined,
  }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const holds = (...permissions: string[]) => (p: string) => permissions.includes(p);
const OWN = { scopeKind: 'OWN', employeeId: 'employee-1' };
const COMPANY = { scopeKind: 'COMPANY', employeeId: 'employee-2' };

describe('routes', () => {
  it('routes every registered module screen and every core page exactly once', () => {
    expect(new Set(APP_ROUTE_PATHS).size).toBe(APP_ROUTE_PATHS.length);
    for (const s of MODULE_SCREENS) expect(APP_ROUTE_PATHS).toContain(s.path);
    // Screens that other pages link to (the My ESS tab links and the decision inbox).
    for (const path of ['/me', '/me/attendance', '/tasks', '/leave', '/expenses', '/employees/:id/documents']) expect(APP_ROUTE_PATHS).toContain(path);
  });

  it('mounts a module screen at its path inside the shell', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    session.value.me = { displayName: 'Asha Synthetic', accountKey: 'asha', companyName: 'Synthetic Co', roleName: 'HR Administrator', scopeKind: 'COMPANY', employeeId: null };
    session.value.granted = new Set();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/bulk-jobs']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    // The module's own screen, not the home page the catch-all route would fall back to.
    expect(await screen.findByRole('heading', { level: 1, name: 'My background jobs' })).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Home' })).toBeNull();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });
});

describe('the menu', () => {
  it('shows a core entry only with its permission, and an any-of entry with any one of its permissions', () => {
    const labels = (can: (p: string) => boolean) => visibleNav(can, COMPANY).map((n) => n.label);
    expect(labels(holds())).toEqual(['Reports', 'Notifications']);
    // Decisions only for a role that decides something.
    expect(labels(holds('leave.approve.operational'))).toContain('Decisions');
    expect(labels(holds('access.approve_role_grant.operational'))).toContain('Decisions');
    expect(labels(holds('confirmation.read.operational'))).toContain('Confirmations');
    expect(labels(holds('salary.read.salary'))).toContain('Increments and salary');
    expect(labels(holds('increment_cycle.manage.operational'))).toContain('Increments and salary');
    expect(labels(holds('retention.approve.operational'))).toContain('Retention');
    expect(labels(holds('audit.read.operational'))).toContain('Audit trail');
    expect(labels(holds('employee.list.operational'))).not.toContain('Confirmations');
  });

  it('shows own-record entries only in an OWN context linked to an employee', () => {
    const can = holds('employee.read.operational', 'profile_change.read.operational', 'attendance.read.operational');
    const own = visibleNav(can, OWN).map((n) => n.to);
    expect(own).toEqual(expect.arrayContaining(['/me', '/me/profile', '/me/attendance']));
    expect(visibleNav(can, COMPANY).map((n) => n.to)).not.toContain('/me');
    expect(visibleNav(can, { scopeKind: 'OWN', employeeId: null }).map((n) => n.to)).not.toContain('/me');
    expect(visibleNav(can, null).map((n) => n.to)).not.toContain('/me');
  });

  it('lists module screens only with their permission, grouped by module, and never detail screens', () => {
    expect(visibleModuleGroups(holds())).toEqual(expect.not.arrayContaining([expect.objectContaining({ label: 'Payroll' })]));
    const all = (p: string) => p.length > 0;
    const groups = visibleModuleGroups(all);
    const shown = groups.flatMap((g) => g.screens);
    expect(shown.length).toBe(MODULE_SCREENS.filter((s) => s.nav).length);
    expect(shown.every((s) => s.nav)).toBe(true);
    for (const g of groups) for (const s of g.screens) expect(moduleGroupOf(s.path)).toBe(g.label);
    const payroll = MODULE_SCREENS.find((s) => s.nav && s.path.startsWith('/payroll') && s.permission);
    expect(payroll).toBeTruthy();
    const onlyPayroll = visibleModuleGroups(holds(payroll!.permission!));
    expect(onlyPayroll.flatMap((g) => g.screens).map((s) => s.path)).toContain(payroll!.path);
    expect(onlyPayroll.every((g) => g.screens.every((s) => !s.permission || s.permission === payroll!.permission))).toBe(true);
  });

  it('leaves staff registers out of the menu of a role that covers only the person’s own record', () => {
    const paths = (scopeKind: string) => visibleModuleGroups(() => true, { scopeKind }).flatMap((g) => g.screens.map((s) => s.path));
    for (const staff of ['/lifecycle/exits', '/lifecycle/processes', '/payroll/medical-claims', '/documents/bulk-mapping']) {
      expect(paths('COMPANY')).toContain(staff);
      expect(paths('OWN')).not.toContain(staff);
    }
    // The person's own screens stay.
    expect(paths('OWN')).toContain('/me/resignation');
  });

  it('lists the organisation masters under their read duty and a new employee under its create duty; the record is reached by links only', () => {
    const titles = (label: string, permission: string) => visibleModuleGroups(holds(permission)).find((g) => g.label === label)?.screens.map((s) => s.title);
    // CL-006 (0280): the city master sits with the other organisation masters.
    expect(titles('Organisation', 'org_master.read.operational')).toEqual(['Company', 'Departments', 'Locations', 'Designations', 'Grades', 'Cities']);
    expect(titles('Organisation', 'employee.read.operational')).toBeUndefined();
    expect(titles('Employee administration', 'employee.create.operational')).toEqual(['New employee']);
    expect(titles('Employee administration', 'employee.read.operational')).toBeUndefined();
    expect(visibleModuleGroups(() => true).flatMap((g) => g.screens.map((s) => s.path))).not.toContain('/employees/:id');
    expect(APP_ROUTE_PATHS).toEqual(expect.arrayContaining(['/organisation/departments', '/employees/new', '/employees/:id']));
  });

  it('routes /employees/new to the new-employee form and /employees/:id to the record, not to each other or to the documents page', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    session.value.me = { displayName: 'Asha Synthetic', accountKey: 'asha', companyName: 'Synthetic Co', roleName: 'HR Administrator', scopeKind: 'COMPANY', employeeId: null };
    session.value.granted = new Set();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/employees/new']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('form', { name: 'New employee' })).toBeTruthy();
    cleanup();

    const fetched = vi.fn(async (_url: string) => new Response(JSON.stringify({ id: 'e-1', employeeCode: 'SYN-1', displayName: 'Synthetic Person', status: 'ACTIVE_CONFIRMED', employmentType: 'PERMANENT', joiningDate: '2026-01-05', confirmationDate: null, workEmail: null, assignment: null, manager: null, version: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetched);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/employees/e-1']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('heading', { name: 'Synthetic Person (SYN-1)' })).toBeTruthy();
    expect(fetched.mock.calls.map((c) => c[0])).toContain('/v1/employees/e-1');
  });

  it('names groups from the path, with a readable fallback', () => {
    expect(moduleGroupOf('/hiring/requisitions')).toBe('Hiring');
    expect(moduleGroupOf('/payroll/runs/:id')).toBe('Payroll');
    expect(moduleGroupOf('/salary-master/upload')).toBe('Salary');
    expect(moduleGroupOf('/some-new-module/x')).toBe('Some new module');
  });

  it('renders the groups in the sidebar for a context that holds their permissions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], widgets: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const payrollScreens = MODULE_SCREENS.filter((s) => s.nav && s.path.startsWith('/payroll') && s.permission);
    const payroll = payrollScreens[0]!;
    const other = payrollScreens.find((s) => s.permission !== payroll.permission)!;
    session.value.me = { displayName: 'Asha Synthetic', accountKey: 'asha', companyName: 'Synthetic Co', roleName: 'Payroll Operator', scopeKind: 'COMPANY', employeeId: null };
    session.value.granted = new Set([payroll.permission!, other.permission!]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tasks']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const group = within(nav).getByRole('group', { name: 'Payroll' });
    // Module groups are collapsed unless the current page is in them; opening one shows its screens.
    const toggle = within(group).getByRole('button', { name: /Payroll/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(group).queryByRole('link', { name: payroll.title })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(group).getByRole('link', { name: payroll.title })).toBeTruthy();
    expect(within(nav).queryByRole('group', { name: 'Hiring' })).toBeNull();
    // The breadcrumb names the page.
    expect(within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByText('Decisions')).toBeTruthy();
  });

  it('shows a group of one screen as that screen’s link, with nothing to open first', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [], widgets: [] }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const payroll = MODULE_SCREENS.find((s) => s.nav && s.path.startsWith('/payroll') && s.permission)!;
    session.value.me = { displayName: 'Asha Synthetic', accountKey: 'asha', companyName: 'Synthetic Co', roleName: 'Payroll Operator', scopeKind: 'COMPANY', employeeId: null };
    session.value.granted = new Set([payroll.permission!]);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={['/tasks']}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('group', { name: 'Payroll' })).toBeNull();
    expect(within(nav).getByRole('link', { name: payroll.title }).getAttribute('href')).toBe(payroll.path);
  });
});
