// Automated accessibility checks (improvement plan M7), jsdom with axe-core: a representative set of screens, each rendered with
// synthetic data the way its own page test renders it, must give axe no violations. Rules jsdom cannot judge are off: colour
// contrast (no layout or computed colours), and the "region" landmark rule for a page rendered on its own, outside the shell
// that gives it its landmarks. The shell itself is checked with that rule on. Synthetic data only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { axe, toHaveNoViolations } from 'jest-axe';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { HolidayCalendarPage } from './pages/calendars';
import { MyEssPage } from './pages/ess';
import { DashboardPage, EmployeesPage } from './pages/home';
import { UserAccountsPage } from './pages/org-admin';
import { ExpensesPage, InboxPage, LeavePage, TasksPage } from './pages/work';

declare module 'vitest' {
  // jest-axe's matcher, registered with vitest's expect below.
  interface Assertion<T = any> {
    toHaveNoViolations(): T;
  }
}

expect.extend(toHaveNoViolations);

const EMPLOYEE = { userId: 'u-emp', accountKey: 'syn.user', companyName: 'Synthetic Co', roleCode: 'EMPLOYEE', roleName: 'Employee', scopeKind: 'OWN', employeeId: 'emp-1', displayName: 'Synthetic Person' };
const HR = { userId: 'u-hr', accountKey: 'syn.hr', companyName: 'Synthetic Co', roleCode: 'HR_ADMINISTRATOR', roleName: 'HR Administrator', scopeKind: 'COMPANY', employeeId: null, displayName: 'Asha Synthetic' };

const session = vi.hoisted(() => ({ me: null as null | Record<string, unknown>, permissions: new Set<string>() }));
vi.mock('./session', () => ({
  useSession: () => ({
    stored: { token: 'syn-token', companies: [], companyId: 'company-1', assignmentId: 'assignment-1' },
    me: session.me,
    contextFailed: false,
    retryContext: () => undefined,
    can: (p: string) => session.permissions.has(p),
    switchRole: () => undefined,
    signOut: async () => undefined,
  }),
}));

const as = (me: Record<string, unknown>, ...permissions: string[]) => {
  session.me = me;
  session.permissions = new Set(permissions);
};

/** Answers GETs by "METHOD /path" prefix (the longest wins); anything else is an empty list. */
function serve(routes: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = `${init?.method ?? 'GET'} ${url}`;
      const key = Object.keys(routes)
        .filter((k) => call.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      const body = key === undefined ? { items: [], total: 0 } : routes[key];
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }),
  );
}

const show = (ui: JSX.Element, entry = '/') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

/** axe on a page rendered on its own: no colour contrast, and no landmark "region" rule (the shell gives the landmarks). */
const axePage = (container: Element) => axe(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
  session.me = null;
  session.permissions = new Set();
});

const DASHBOARD = {
  role: 'REPORTING_MANAGER',
  scope: 'TEAM',
  company: 'Synthetic Company',
  title: 'My team',
  state: 'OK',
  businessDate: '2026-11-03',
  period: { from: '2026-11-01', to: '2026-11-03' },
  refreshedAt: '2026-11-03T06:00:00Z',
  widgets: [
    { code: 'TEAM_EXCEPTIONS', title: 'Unresolved attendance exceptions today', kind: 'COUNT', status: 'OK', value: 2, source: { href: '/team?todayAttendance=EXCEPTION', combine: 'SUM', lists: [{ api: '/v1/my-team?todayAttendance=EXCEPTION' }] } },
    { code: 'MY_TASKS', title: 'Leave and expense decisions waiting', kind: 'COUNT', status: 'OK', value: 7 },
    { code: 'SOURCED', title: 'Failed payments', kind: 'COUNT', status: 'OK', value: 3, source: { href: '/dashboard/sources/SOURCED', combine: 'SUM', lists: [{ api: '/v1/expense/payments?state=FAILED' }], shortcut: { to: '/payments', label: 'Payments' } } },
    { code: 'NOT_SET', title: 'Annual leave balance', kind: 'BALANCE', status: 'NOT_CONFIGURED', message: 'Policy not active' },
    { code: 'NONE', title: 'Interview tasks due', kind: 'COUNT', status: 'NOT_AVAILABLE' },
  ],
  shortcuts: [{ to: '/team', label: 'My team' }],
};
const DASHBOARD_ROUTES = {
  'GET /v1/dashboard/tasks': {
    items: [{ taskId: 't-1', kind: 'leave_request', ownerEmployeeCode: 'SYN-9', ownerName: 'Synthetic Member', assignedAt: '2026-11-01T06:00:00Z', dueAt: '2026-11-02T06:00:00Z', overdue: true, delegated: true }],
    total: 1,
  },
  'GET /v1/dashboard/activity': { status: 'OK', days: 7, items: [{ action: 'LEAVE_APPROVED', resource: 'LEAVE_REQUEST', occurredAt: '2026-11-02T06:00:00Z' }], total: 1 },
  'GET /v1/dashboard': DASHBOARD,
};

describe('the app shell', () => {
  it('the menu, header and home page inside the shell', async () => {
    as(
      HR,
      'dashboard.read.operational',
      'employee.list.operational',
      'leave.read.operational',
      'leave.approve.operational',
      'expense.draft.operational',
      'access.read_users.operational',
      'holiday.read.operational',
      'shift.read.operational',
      'org_master.read.operational',
    );
    serve({ ...DASHBOARD_ROUTES, 'GET /v1/reports/catalogue': { items: [{ code: 'HEADCOUNT', title: 'Headcount', requiresPeriod: false }] } });
    const { container } = show(<App />, '/');
    await screen.findByRole('link', { name: '3' });
    await screen.findByText(/Synthetic Member/);
    const nav = screen.getByRole('navigation', { name: 'Main' });
    // An open module group, so its links are checked too.
    const group = within(nav).getAllByRole('group')[0]!;
    fireEvent.click(within(group).getByRole('button'));
    expect(await axe(container, { rules: { 'color-contrast': { enabled: false } } })).toHaveNoViolations();
  });
});

describe('pages', () => {
  it('Home dashboard', async () => {
    as(EMPLOYEE, 'leave.read.operational', 'leave.submit.operational', 'expense.draft.operational');
    serve(DASHBOARD_ROUTES);
    const { container } = show(<DashboardPage />);
    await screen.findByRole('link', { name: '3' });
    await screen.findByText(/Synthetic Member/);
    expect(await axePage(container)).toHaveNoViolations();
  });

  it('Leave, with the resubmit form open', async () => {
    as(EMPLOYEE, 'leave.read.operational', 'leave.submit.operational', 'leave.withdraw.operational', 'leave.cancel.operational', 'document.read.document');
    const request = { leaveType: 'ANNUAL', startDate: '2026-11-02', endDate: '2026-11-03', halfDay: false, units: '2.0000', version: 3, cancellationState: null };
    serve({
      'GET /v1/employees/emp-1/leave-balances': { items: [{ leaveType: 'ANNUAL', paid: true, available: '10.0000', pending: '0.0000', taken: '1.5000' }] },
      'GET /v1/employees/emp-1/leave-requests': {
        items: [
          { ...request, id: 'lr-1', state: 'RETURNED' },
          { ...request, id: 'lr-2', state: 'REJECTED' },
          { ...request, id: 'lr-3', state: 'APPROVED' },
        ],
      },
      'GET /v1/employees/emp-1/documents': {
        items: [{ id: 'doc-1', documentType: 'GENERAL', fileName: 'medical-note.pdf', uploadedAt: '2026-10-01T00:00:00Z', scanState: 'CLEAN', verificationState: 'UNVERIFIED' }],
      },
    });
    const { container } = show(<LeavePage />, '/leave');
    fireEvent.click(await screen.findByText('Correct and resubmit'));
    await screen.findAllByLabelText(/medical-note\.pdf/);
    expect(await axePage(container)).toHaveNoViolations();
  });

  it('Decisions', async () => {
    as(HR, 'leave.approve.operational', 'employee.update.operational', 'attendance.approve_correction.operational', 'expense.read.operational', 'expense.view_receipt.receipt');
    const base = { ownerEmployeeCode: 'SYN-1', ownerName: 'Synthetic Person', stepAction: 'approve', step: 1, ownerEmployeeId: 'emp-1', assignedAt: '2026-10-24T06:00:00Z' };
    serve({
      'GET /v1/leave/tasks': {
        items: [
          { ...base, taskId: 't-l1', kind: 'leave_request', transactionId: 'tx-l1', summary: { leaveType: 'ANNUAL', startDate: '2026-11-02', endDate: '2026-11-03', halfDay: false, units: '2.0000', isCancellation: false } },
          { ...base, taskId: 't-l2', kind: 'leave_cancellation', transactionId: 'tx-l2', summary: { leaveType: 'SICK', startDate: '2026-10-10', endDate: '2026-10-10', halfDay: true, units: '0.5000', isCancellation: true } },
        ],
      },
      'GET /v1/work-requests/tasks/mine': {
        items: [
          {
            ...base,
            taskId: 't-w1',
            kind: 'outdoor_duty',
            transactionId: 'tx-w1',
            summary: { kind: 'outdoor_duty', startDate: '2026-11-04', endDate: '2026-11-04', startTime: '22:00', endTime: '06:00', purpose: 'Synthetic night audit' },
          },
        ],
      },
      'GET /v1/profile-changes/tasks/mine': {
        items: [
          {
            ...base,
            taskId: 't-p1',
            kind: 'profile_change',
            transactionId: 'tx-p1',
            request: {
              id: 'pc-1',
              employeeId: 'emp-1',
              employeeCode: 'SYN-1',
              employeeName: 'Synthetic Person',
              requested: { displayName: 'Synthetic Person-Renamed' },
              currentValues: { displayName: 'Synthetic Person' },
              recordNow: { displayName: 'Synthetic Person' },
              state: 'SUBMITTED',
            },
          },
        ],
      },
      'GET /v1/attendance-corrections/tasks/mine': {
        items: [
          {
            ...base,
            taskId: 't-c1',
            kind: 'attendance_correction',
            transactionId: 'tx-c1',
            request: { id: 'ac-1', employeeCode: 'SYN-1', employeeName: 'Synthetic Person', workDate: '2026-10-20', currentStatus: 'ABSENT', requestedStatus: 'PRESENT', state: 'SUBMITTED', reason: 'Badge reader fault' },
          },
        ],
      },
      'GET /v1/expense/tasks': { items: [{ ...base, taskId: 't-e1', kind: 'expense_claim', transactionId: 'tx-e1', stepAction: 'finance_decide', claimId: 'cl-9' }] },
      'GET /v1/expense/claims/cl-9': {
        id: 'cl-9',
        purpose: 'Synthetic client visit',
        currency: 'INR',
        lines: [
          {
            id: 'ln-1',
            sequence: 1,
            category: 'OTHER',
            expenseDate: '2026-10-01',
            merchant: 'Synthetic Cabs',
            claimedAmount: '450.0000',
            description: 'Airport transfer',
            exceptionFlags: ['LATE_SUBMISSION'],
            exceptionReason: 'Synthetic late filing',
            receiptPresent: true,
            receiptScanState: 'CLEAN',
            invoiceReference: 'SYN-77',
            appliedLimit: '1000.0000',
          },
        ],
        revisions: [
          { revision: 1, purpose: 'Synthetic visit, as first reviewed', claimedTotal: '500.00' },
          { revision: 2, purpose: 'Synthetic client visit', claimedTotal: '450.00' },
        ],
      },
      'GET /v1/me/delegated-tasks': {
        items: [
          {
            taskId: 't-l2',
            kind: 'leave_cancellation',
            ownerName: 'Synthetic Person',
            ownerEmployeeCode: 'SYN-1',
            delegationId: 'd-1',
            delegatedUntil: '2026-11-20T04:30:00.000Z',
            delegator: { userId: 'u-1', accountKey: 'syn.mira', employeeCode: 'SYN-2', displayName: 'Mira Synthetic' },
          },
        ],
      },
    });
    const { container } = show(<TasksPage />, '/tasks');
    await screen.findByRole('heading', { name: /Leave requests \(2\)/ });
    await screen.findByRole('heading', { name: /Profile changes \(1\)/ });
    await screen.findByRole('heading', { name: /Attendance corrections \(1\)/ });
    await screen.findByRole('heading', { name: /Outdoor duty and holiday work \(1\)/ });
    await screen.findByRole('heading', { name: /Delegated to you/ });
    await screen.findByRole('list', { name: 'Earlier revisions' });
    expect(await axePage(container)).toHaveNoViolations();
  });

  it('Employees list', async () => {
    as(HR, 'employee.list.operational', 'employee.read.operational', 'employee.export.operational', 'org_master.read.operational', 'employee.create.operational', 'document.read.document');
    serve({
      'GET /v1/org/departments': { items: [{ id: 'd-1', code: 'ENG', name: 'Engineering', active: true }] },
      'GET /v1/employees': {
        items: [{ id: 'e-1', employeeCode: 'SYN-1', displayName: 'Synthetic Person', status: 'ACTIVE_CONFIRMED', assignment: { departmentName: 'Engineering', locationName: 'Head office', designationName: 'Engineer' }, joiningDate: '2026-01-05' }],
        total: 40,
        page: 1,
        pageSize: 25,
      },
    });
    const { container } = show(<EmployeesPage />, '/employees');
    await screen.findByText('Synthetic Person');
    expect(await axePage(container)).toHaveNoViolations();
  });

  it('User accounts, with an account’s links and the new-account form open', async () => {
    as(HR, 'access.read_users.operational', 'access.link_user.operational', 'access.deactivate_user.operational', 'access.manage_accounts.operational');
    const user = { userId: 'u-1', accountKey: 'syn.one', active: true, version: 4, employee: { id: 'e-1', employeeCode: 'SYN-1', displayName: 'Synthetic One' }, assignments: { active: 1, pending: 0 } };
    const link = { id: 'l-1', userId: 'u-1', accountKey: 'syn.one', employeeId: 'e-1', employeeCode: 'SYN-1', employeeName: 'Synthetic One', effectiveFrom: '2026-01-05', effectiveTo: null, inForce: true, version: 3 };
    serve({
      'GET /v1/access/users': { items: [user, { ...user, userId: 'u-2', accountKey: 'syn.two', active: false, version: 7, employee: null }], total: 2 },
      'GET /v1/access/user-links': { items: [link, { ...link, id: 'l-0', effectiveTo: '2026-01-05', inForce: false, version: 2 }], total: 2 },
    });
    const { container } = show(<UserAccountsPage />, '/admin/user-accounts');
    await screen.findByText('syn.one');
    fireEvent.click(screen.getByRole('button', { name: 'Show links of syn.one' }));
    await screen.findByText('In force');
    fireEvent.click(screen.getByRole('button', { name: 'New account' }));
    expect(await axePage(container)).toHaveNoViolations();
  });

  it('Holiday calendar, with a withdrawal form open', async () => {
    as(HR, 'holiday.read.operational', 'holiday.manage.operational', 'attendance.process.operational');
    const year = new Date().getFullYear();
    serve({
      'GET /v1/holidays/options': {
        locations: [
          { id: 'l-1', code: 'HQ', name: 'Head office', active: true },
          { id: 'l-2', code: 'PLANT', name: 'Plant', active: true },
        ],
        types: [
          { code: 'HOLIDAY', label: 'Holiday' },
          { code: 'RESTRICTED', label: 'Restricted' },
        ],
      },
      'GET /v1/holidays?': {
        items: [
          { id: 'h-1', locationId: 'l-1', holidayDate: `${year}-03-10`, name: 'Founders day', holidayType: 'HOLIDAY', state: 'ACTIVE', version: 3, supersedesId: null, supersededById: null, closedAt: null, closedReason: null },
        ],
      },
    });
    const { container } = show(<HolidayCalendarPage />, '/calendars/holidays');
    fireEvent.click(await screen.findByRole('button', { name: `Withdraw Founders day on ${year}-03-10` }));
    await screen.findByRole('form', { name: `Withdraw Founders day on ${year}-03-10` });
    expect(await axePage(container)).toHaveNoViolations();
  });

  it('Notifications inbox', async () => {
    as(HR);
    serve({
      'GET /v1/me/notification-preferences': {
        items: [
          { eventType: 'BIRTHDAY', publishCelebration: false, receiveOptional: true, receiveEmail: true },
          { eventType: 'WORK_ANNIVERSARY', publishCelebration: true, receiveOptional: false, receiveEmail: false },
        ],
      },
      'GET /v1/me/notifications': {
        items: [
          { id: 'n-1', category: 'LEAVE_DECIDED', title: 'Leave approved', body: 'Your leave for 2 Nov was approved.', occurredAt: '2026-11-01T06:00:00Z', readAt: null },
          { id: 'n-2', category: 'EXPENSE_DECIDED', title: null, body: 'Your claim was paid.', occurredAt: '2026-10-30T06:00:00Z', readAt: '2026-10-30T07:00:00Z' },
        ],
      },
    });
    const { container } = show(<InboxPage />, '/inbox');
    await screen.findByText('Leave approved');
    await screen.findByRole('checkbox', { name: 'Share my birthday with colleagues' });
    expect(await axePage(container)).toHaveNoViolations();
  });

  it('My ESS', async () => {
    as(EMPLOYEE, 'employee.read.operational', 'sensitive_change.submit.private', 'document.read.document');
    const tab = (id: string, name: string, section: string, status = 'AVAILABLE') => ({
      id,
      name,
      section,
      status,
      links: [],
      ...(status === 'AVAILABLE' ? {} : { unavailable: { code: 'PAYROLL_NOT_ENABLED', message: 'Available once payroll is enabled for your company.' } }),
    });
    serve({
      'GET /v1/me/ess': {
        context: { employeeId: 'emp-1', employeeCode: 'E-001', employeeName: 'Synthetic Person', roleCode: 'EMPLOYEE', scopeKind: 'OWN' },
        tabs: [
          tab('TN01', 'My Profile', 'Personal'),
          tab('TN02', 'Personal details change request', 'Personal'),
          tab('TN03', 'Bank change request', 'Personal'),
          tab('TN04', 'Address change', 'Personal'),
          tab('TN06', 'Payslip', 'Financial', 'UNAVAILABLE'),
          tab('TN10', 'Leave', 'Time and Requests'),
          tab('TN14', 'Expense', 'Time and Requests'),
        ],
      },
      'GET /v1/me/private-profile': {
        personal: { revision: 0, effectiveFrom: null, values: { dateOfBirth: '1990-04-12' } },
        address: { revision: 1, effectiveFrom: '2026-10-25', values: { line1: '12 Synthetic Street', city: 'Testville', countryCode: 'IN' } },
        bank: { revision: 1, effectiveFrom: '2026-10-25', masked: true, values: { holderName: 'Synthetic Person', accountIdentifier: '••••6789', routingReference: 'SYNT0000001', countryCode: 'IN' } },
      },
      'GET /v1/me/sensitive-changes': {
        items: [
          {
            id: 'sc-3',
            category: 'BANK',
            state: 'RETURNED',
            effectiveDate: '2026-10-25',
            changedFields: ['accountIdentifier'],
            proposed: { accountIdentifier: '000987654321' },
            before: { accountIdentifier: '••••6789' },
            employeeMessage: 'Attach a bank letter',
            pendingWith: null,
            decisions: [{ decision: 'RETURN', decidedAt: '2026-10-25T06:00:00Z' }],
            version: 2,
          },
        ],
      },
      'GET /v1/employees/emp-1/documents': {
        items: [{ id: 'doc-1', documentType: 'BANK_PROOF', fileName: 'bank-letter.pdf', uploadedAt: '2026-10-01T00:00:00Z', scanState: 'CLEAN', verificationState: 'UNVERIFIED' }],
      },
    });
    const { container } = show(<MyEssPage />, '/me');
    await screen.findByText('••••6789');
    expect(await axePage(container)).toHaveNoViolations();
    // A change-request tab: its form and the list of the person's own requests.
    fireEvent.click(screen.getByRole('tab', { name: 'Bank change request' }));
    await screen.findByRole('form', { name: 'New bank details request' });
    await screen.findByText('Attach a bank letter');
    expect(await axePage(container)).toHaveNoViolations();
  });

  it('Expenses', async () => {
    as(EMPLOYEE, 'expense.draft.operational', 'expense.submit.operational', 'expense.withdraw.operational', 'expense.read.operational');
    const claim = { id: 'cl-5', purpose: 'Synthetic visit', state: 'RETURNED', paymentState: 'NOT_APPLICABLE', claimedTotal: '300.00', currency: 'INR', version: 4 };
    serve({
      'GET /v1/employees/emp-1/expense-claims': {
        items: [claim, { ...claim, id: 'cl-6', purpose: 'Synthetic draft', state: 'DRAFT' }, { ...claim, id: 'cl-7', purpose: 'Synthetic rejected', state: 'REJECTED' }],
      },
      'GET /v1/expense/categories': {
        items: [
          { code: 'CAMP', name: 'Camp', limitBasis: 'PER_NIGHT' },
          { code: 'OTHER', name: 'Other', limitBasis: 'PER_LINE' },
        ],
      },
    });
    const { container } = show(<ExpensesPage />, '/expenses');
    await screen.findByText('Synthetic visit');
    await screen.findByRole('option', { name: 'Camp' });
    expect(await axePage(container)).toHaveNoViolations();
  });
});
