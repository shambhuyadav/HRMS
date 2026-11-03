import type { ComponentType } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useSession } from './session';
import { AccessAdminPage } from './pages/access';
import { AuditTrailPage, MobileLinkReviewPage, RetentionPage, RoutingPage } from './pages/admin';
import { SelectRolePage, SignInPage } from './pages/auth';
import { ConfirmationsPage } from './pages/confirmation';
import { MyEssPage, SensitiveChangeReviewPage } from './pages/ess';
import { DashboardPage, EmployeesPage, MyTeamPage, TeamMemberPage } from './pages/home';
import { IncrementsPage } from './pages/increments';
import { MyAttendancePage, MyProfilePage } from './pages/me';
import { EmployeeDocumentsPage, ImportsPage } from './pages/records';
import { WorkRequestsPage } from './pages/requests';
import { ExpensesPage, InboxPage, LeavePage, PaymentsPage, ReportsPage, TasksPage } from './pages/work';
import type { ScreenRoute } from './screens';
import { MODULE_SCREENS } from './screens-registry';

interface NavEntry {
  to: string;
  label: string;
  /** Shown only when the selected assignment holds this permission. */
  permission?: string;
  /** Shown when the selected assignment holds any of these permissions. */
  anyOf?: readonly string[];
  /** Employee own-record screens (H3, BR-055): shown only in an OWN-scope context linked to an employee. */
  own?: boolean;
}

/** Navigation entries appear only when the selected assignment holds the permission (server still enforces). */
const NAV: readonly NavEntry[] = [
  { to: '/', label: 'Home', permission: 'dashboard.read.operational' },
  { to: '/me', label: 'My ESS', permission: 'employee.read.operational', own: true },
  { to: '/me/profile', label: 'My profile', permission: 'profile_change.read.operational', own: true },
  { to: '/me/attendance', label: 'My attendance', permission: 'attendance.read.operational', own: true },
  { to: '/team', label: 'My team', permission: 'team.list.operational' },
  { to: '/employees', label: 'Employees', permission: 'employee.list.operational' },
  { to: '/imports', label: 'Import employees', permission: 'employee.import.operational' },
  { to: '/leave', label: 'Leave', permission: 'leave.read.operational' },
  { to: '/work-requests', label: 'Outdoor & holiday work', permission: 'work_request.read.operational' },
  { to: '/confirmations', label: 'Confirmations', permission: 'confirmation.read.operational' },
  {
    to: '/increments',
    label: 'Increments and salary',
    anyOf: ['increment.read.operational', 'increment_cycle.manage.operational', 'increment.propose.salary', 'increment.approve.salary', 'salary.read.salary'],
  },
  { to: '/expenses', label: 'Expenses', permission: 'expense.draft.operational' },
  { to: '/tasks', label: 'Decisions' },
  { to: '/sensitive-changes', label: 'Private detail reviews', permission: 'sensitive_change.review.private' },
  { to: '/payments', label: 'Payments', permission: 'payment.read.operational' },
  { to: '/reports', label: 'Reports' },
  { to: '/inbox', label: 'Notifications' },
  { to: '/access', label: 'User access', permission: 'access.read_users.operational' },
  { to: '/admin/audit', label: 'Audit trail', permission: 'audit.read.operational' },
  { to: '/admin/retention', label: 'Retention', anyOf: ['retention.manage.operational', 'retention.approve.operational'] },
  { to: '/admin/routing', label: 'Approval routing', permission: 'workflow.manage.operational' },
  { to: '/admin/mobile-links', label: 'Mobile link reviews', permission: 'mobile_link.approve.operational' },
];

/** Routes of the core pages; the module screens come from the screens registry. */
const CORE_ROUTES: readonly { path: string; component: ComponentType }[] = [
  { path: '/', component: DashboardPage },
  { path: '/me', component: MyEssPage },
  { path: '/me/profile', component: MyProfilePage },
  { path: '/me/attendance', component: MyAttendancePage },
  { path: '/team', component: MyTeamPage },
  { path: '/team/:id', component: TeamMemberPage },
  { path: '/employees', component: EmployeesPage },
  { path: '/employees/:id/documents', component: EmployeeDocumentsPage },
  { path: '/imports', component: ImportsPage },
  { path: '/leave', component: LeavePage },
  { path: '/work-requests', component: WorkRequestsPage },
  { path: '/confirmations', component: ConfirmationsPage },
  { path: '/increments', component: IncrementsPage },
  { path: '/expenses', component: ExpensesPage },
  { path: '/tasks', component: TasksPage },
  { path: '/sensitive-changes', component: SensitiveChangeReviewPage },
  { path: '/reports', component: ReportsPage },
  { path: '/payments', component: PaymentsPage },
  { path: '/inbox', component: InboxPage },
  { path: '/access', component: AccessAdminPage },
  { path: '/admin/audit', component: AuditTrailPage },
  { path: '/admin/retention', component: RetentionPage },
  { path: '/admin/routing', component: RoutingPage },
  { path: '/admin/mobile-links', component: MobileLinkReviewPage },
];

/** Every routed path, core pages first; each must be unique. */
export const APP_ROUTE_PATHS: readonly string[] = [...CORE_ROUTES.map((r) => r.path), ...MODULE_SCREENS.map((s) => s.path)];

/** Menu group of a module screen, from the first segment of its path. */
const GROUP_LABELS: Readonly<Record<string, string>> = {
  hiring: 'Hiring',
  lifecycle: 'Employee lifecycle',
  me: 'My records',
  appraisal: 'Appraisal',
  timesheet: 'Timesheets',
  timesheets: 'Timesheets',
  assets: 'Assets',
  training: 'Training',
  payroll: 'Payroll',
  'salary-master': 'Salary',
  documents: 'Documents and policies',
  policies: 'Documents and policies',
  admin: 'Administration',
  'bulk-jobs': 'Background jobs',
};

export function moduleGroupOf(path: string): string {
  const segment = path.split('/')[1] ?? '';
  return GROUP_LABELS[segment] ?? (segment ? segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ') : 'Other');
}

/** The core entries this context may see. */
export function visibleNav(can: (permission: string) => boolean, context: { scopeKind: string; employeeId: string | null } | null): NavEntry[] {
  return NAV.filter((n) => {
    if (n.own && !(context && context.scopeKind === 'OWN' && context.employeeId)) return false;
    if (n.permission && !can(n.permission)) return false;
    if (n.anyOf && !n.anyOf.some((p) => can(p))) return false;
    return true;
  });
}

/** The module menu screens this context may see, grouped in registry order. */
export function visibleModuleGroups(can: (permission: string) => boolean): { label: string; screens: ScreenRoute[] }[] {
  const groups = new Map<string, ScreenRoute[]>();
  for (const s of MODULE_SCREENS) {
    if (!s.nav || (s.permission && !can(s.permission))) continue;
    const label = moduleGroupOf(s.path);
    groups.set(label, [...(groups.get(label) ?? []), s]);
  }
  return [...groups].map(([label, screens]) => ({ label, screens }));
}

export function App() {
  const { stored, me, can, switchRole, signOut } = useSession();
  if (!stored) return <SignInPage />;
  if (!stored.companyId || !stored.assignmentId) return <SelectRolePage />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">HRMS</div>
        {/* FR-096: the acting role and its scope are always visible. */}
        <div className="context" aria-label="Current role">
          {me ? (
            <>
              <strong>{me.displayName ?? me.accountKey}</strong> · {me.companyName} · {me.roleName} <span className="hint">(scope {me.scopeKind.toLowerCase()})</span>
            </>
          ) : (
            'Loading…'
          )}
        </div>
        <button className="secondary" onClick={switchRole}>
          Switch role
        </button>
        <button className="secondary" onClick={() => void signOut()}>
          Sign out
        </button>
      </header>
      <nav className="sidebar" aria-label="Main">
        {visibleNav(can, me ?? null).map((n) => (
          <NavLink key={n.to} to={n.to} end={n.to === '/' || n.to === '/me'}>
            {n.label}
          </NavLink>
        ))}
        {visibleModuleGroups(can).map((g) => (
          <div key={g.label} className="nav-group" role="group" aria-label={g.label}>
            <p className="nav-group-title">{g.label}</p>
            {g.screens.map((s) => (
              <NavLink key={s.path} to={s.path} end>
                {s.title}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <main className="content">
        <Routes>
          {CORE_ROUTES.map((r) => (
            <Route key={r.path} path={r.path} element={<r.component />} />
          ))}
          {/* Wave-2 module screens (screens-registry.ts); each screen re-checks its permissions and the server re-checks every call. */}
          {MODULE_SCREENS.map((s) => (
            <Route key={s.path} path={s.path} element={<s.component />} />
          ))}
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </div>
  );
}
