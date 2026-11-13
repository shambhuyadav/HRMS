// I-83 screens, jsdom: the BR-045 suppressed figure and DF17 recent activity on the dashboard, the FR-038 salary progression chart
// (shown exactly as the server answers, one chart per currency, a table view, refusals in words) and the dated reporting settings.
// Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from './home';
import { type Progression, ReportingSettingsScreen, SalaryProgressionScreen } from './reporting';

vi.mock('../session', () => ({ useSession: () => ({ can: () => true, stored: { assignmentId: 'a-1', companyId: 'c-1' } }) }));

const calls: { url: string; method: string; body: unknown }[] = [];
/** Answers by the longest matching URL start; `status` per key, 200 otherwise. */
function mockRoutes(answers: Record<string, unknown>, statuses: Record<string, number> = {}) {
  calls.length = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const key = Object.keys(answers)
        .sort((a, b) => b.length - a.length)
        .find((k) => url.startsWith(k));
      if (!key) return new Response(JSON.stringify({ error: 'NOT_FOUND', message: `No answer for ${url}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(answers[key]), { status: statuses[key] ?? 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}
const renderAt = (entry: string, node: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const DASHBOARD = {
  role: 'EXPENSE_FINANCE_APPROVER',
  scope: 'COMPANY',
  company: 'Synthetic Co',
  title: 'Expense final decisions',
  state: 'OK',
  businessDate: '2026-11-06',
  period: { from: '2026-11-01', to: '2026-11-06' },
  refreshedAt: '2026-11-06T10:00:00Z',
  widgets: [
    { code: 'FINAL_DECISIONS', title: 'Claims awaiting a final decision', kind: 'COUNT', status: 'SUPPRESSED', threshold: 5 },
    { code: 'RETURNED', title: 'Claims returned at a financial step, awaiting the claimant', kind: 'COUNT', status: 'OK', value: 0 },
  ],
  shortcuts: [],
};

describe('dashboard (BR-045 small counts; DF17 recent activity)', () => {
  it('a suppressed figure reads "fewer than N" with no number; recent activity lists what and when', async () => {
    mockRoutes({
      '/v1/dashboard/tasks': { items: [], total: 0 },
      '/v1/dashboard/activity': { status: 'OK', days: 14, total: 1, items: [{ action: 'CREATE', resource: 'reporting_setting', occurredAt: '2026-11-05T09:30:00Z' }] },
      '/v1/dashboard': DASHBOARD,
    });
    renderAt('/', <DashboardPage />);
    expect(await screen.findByText('Fewer than 5')).toBeTruthy();
    const figure = screen.getByText('Claims awaiting a final decision').closest('.widget') as HTMLElement;
    expect(within(figure).queryByText(/^\d+$/)).toBeNull();
    expect(await screen.findByText('Recent activity (last 14 days)')).toBeTruthy();
    expect(await screen.findByText('reporting setting')).toBeTruthy();
    expect(screen.getByText('create')).toBeTruthy();
  });

  it('says so when no reporting setting is in force', async () => {
    mockRoutes({
      '/v1/dashboard/tasks': { items: [], total: 0 },
      '/v1/dashboard/activity': { status: 'NOT_CONFIGURED', message: 'No reporting setting is in force', items: [], total: 0 },
      '/v1/dashboard': DASHBOARD,
    });
    renderAt('/', <DashboardPage />);
    expect(await screen.findByText('No reporting setting is in force')).toBeTruthy();
  });
});

const PROGRESSION: Progression = {
  employeeId: 'e-1',
  employeeCode: 'SYN-1',
  employeeName: 'Synthetic Person',
  basis: 'MONTHLY_GROSS',
  span: { years: 3, firstFinancialYear: 2024, lastFinancialYear: 2026, from: '2024-04-01', to: '2026-11-06' },
  years: [
    { financialYear: 2024, label: '2024-25', periodStart: '2024-04-01', valueDate: '2025-03-31', amount: '30000.0000', currency: 'INR', changePercent: null, percentNaReason: 'NO_PREVIOUS_SALARY' },
    { financialYear: 2025, label: '2025-26', periodStart: '2025-04-01', valueDate: '2026-03-31', amount: '400.0000', currency: 'USD', changePercent: null, percentNaReason: 'CURRENCY_CHANGED' },
    { financialYear: 2026, label: '2026-27', periodStart: '2026-04-01', valueDate: '2026-11-06', amount: '440.0000', currency: 'USD', changePercent: '10.00', percentNaReason: null },
  ],
  steps: [
    { effectiveFrom: '2024-04-01', effectiveTo: '2025-06-01', amount: '30000.0000', currency: 'INR' },
    { effectiveFrom: '2025-06-01', effectiveTo: '2026-06-01', amount: '400.0000', currency: 'USD' },
    { effectiveFrom: '2026-06-01', effectiveTo: null, amount: '440.0000', currency: 'USD' },
  ],
};

describe('salary progression chart (FR-038; I-83 item 6)', () => {
  it('asks the server for the chosen employee, measure and span, and draws one chart per currency with a table of every year', async () => {
    mockRoutes({ '/v1/employees/e-1/salary-progression': PROGRESSION });
    renderAt('/salary/progression?employeeId=e-1&basis=MONTHLY_GROSS&years=3', <SalaryProgressionScreen />);
    const charts = await screen.findAllByRole('img');
    expect(charts.map((c) => c.getAttribute('aria-label'))).toEqual([
      'Monthly gross fixed pay of Synthetic Person in INR, 2024-04-01 to 2026-11-06',
      'Monthly gross fixed pay of Synthetic Person in USD, 2024-04-01 to 2026-11-06',
    ]);
    expect(calls.map((c) => c.url)).toContain('/v1/employees/e-1/salary-progression?basis=MONTHLY_GROSS&years=3');
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell').map((cell) => cell.textContent))).toEqual([
      ['FY 2024-25', '31 Mar 2025', 'INR 30,000.00', 'No salary the year before'],
      ['FY 2025-26', '31 Mar 2026', 'USD 400.00', 'Paid in another currency the year before'],
      ['FY 2026-27', '6 Nov 2026', 'USD 440.00', '10.00%'],
    ]);
    // Hover (or focus) a year's marker for its figure.
    fireEvent.mouseEnter(screen.getByLabelText('FY 2026-27: 440.0000'));
    expect(screen.getByText('FY 2026-27 · USD 440.00')).toBeTruthy();
    expect(screen.getByText('Change 10.00%')).toBeTruthy();
  });

  it('a refusal is said in words and no amount is shown', async () => {
    mockRoutes({ '/v1/employees/e-1/salary-progression': { error: 'FORBIDDEN', message: 'Not permitted' } }, { '/v1/employees/e-1/salary-progression': 403 });
    renderAt('/salary/progression?employeeId=e-1', <SalaryProgressionScreen />);
    expect(await screen.findByText(/cannot see salary progression/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('finds an employee by the employee list and opens their chart', async () => {
    mockRoutes({ '/v1/employees?': { items: [{ id: 'e-1', employeeCode: 'SYN-1', displayName: 'Synthetic Person' }], total: 1 }, '/v1/employees/e-1/salary-progression': PROGRESSION });
    renderAt('/salary/progression', <SalaryProgressionScreen />);
    fireEvent.change(screen.getByPlaceholderText('Name, code or email'), { target: { value: 'SYN' } });
    fireEvent.click(screen.getByRole('button', { name: 'Find' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Synthetic Person (SYN-1)' }));
    expect((await screen.findAllByRole('img')).length).toBe(2);
    expect(calls.some((c) => c.url.startsWith('/v1/employees/e-1/salary-progression?basis=MONTHLY_GROSS'))).toBe(true);
  });
});

describe('reporting settings (I-83)', () => {
  const SETTINGS = {
    businessDate: '2026-11-06',
    // expenseDecisionDueDays: the setting added with the expense decision due date (the form requires every value in force).
    inForce: { id: 's-1', effectiveFrom: '2000-01-01', effectiveTo: null, smallCountThreshold: 5, recentActivityDays: 14, salaryProgressionYears: 5, expenseDecisionDueDays: 5, reason: 'Initial' },
    items: [{ id: 's-1', effectiveFrom: '2000-01-01', effectiveTo: null, smallCountThreshold: 5, recentActivityDays: 14, salaryProgressionYears: 5, expenseDecisionDueDays: 5, reason: 'Initial' }],
  };

  it('shows the values in force and starts a new revision from the date given, with its reason', async () => {
    mockRoutes({ '/v1/reporting-settings': SETTINGS });
    renderAt('/admin/reporting-settings', <ReportingSettingsScreen />);
    expect(await screen.findByText('Small-count threshold: 5')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Small-count threshold'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Reason'), { target: { value: 'Synthetic: smaller teams' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save revision' }));
    await waitFor(() => expect(calls.find((c) => c.method === 'POST')).toBeTruthy());
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      effectiveFrom: '2026-11-06',
      smallCountThreshold: 3,
      recentActivityDays: 14,
      salaryProgressionYears: 5,
      expenseDecisionDueDays: 5,
      reason: 'Synthetic: smaller teams',
    });
  });

  it('a role without the grant is told so', async () => {
    mockRoutes({ '/v1/reporting-settings': { error: 'FORBIDDEN', message: 'Not permitted' } }, { '/v1/reporting-settings': 403 });
    renderAt('/admin/reporting-settings', <ReportingSettingsScreen />);
    expect(await screen.findByText('The selected role cannot view or change the reporting settings.')).toBeTruthy();
  });
});
