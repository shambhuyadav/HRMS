import { type ComponentType, useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, matchPath, useLocation } from 'react-router-dom';
import { groupIcon, Icon, navIcon } from './icons';
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

/** Where a path sits in the menu: its module group (none for the core pages) and its title, for the breadcrumb and the window title. */
export function pageOf(pathname: string): { group: string | null; title: string } {
  const core = NAV.find((n) => n.to === pathname);
  if (core) return { group: null, title: core.label };
  const screen = MODULE_SCREENS.find((s) => matchPath({ path: s.path, end: true }, pathname));
  if (screen) return { group: moduleGroupOf(screen.path), title: screen.title };
  if (matchPath('/team/:id', pathname)) return { group: 'My team', title: 'Team member' };
  if (matchPath('/employees/:id/documents', pathname)) return { group: 'Employees', title: 'Documents' };
  return { group: null, title: 'HRMS' };
}

const OPEN_GROUPS_KEY = 'hrms.nav.groups';
function loadGroupChoices(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_GROUPS_KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

/**
 * The menu: the core pages, then the module groups. A group opens by itself when the current page is in it; the user can open or
 * close any group, and that choice is remembered on this device (a convenience only: nothing depends on it).
 */
function Sidebar({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const { me, can } = useSession();
  const entries = visibleNav(can, me ?? null);
  const groups = visibleModuleGroups(can);
  const activeGroup = groups.find((g) => g.screens.some((s) => matchPath({ path: s.path, end: true }, pathname)))?.label ?? null;
  const [choices, setChoices] = useState<Record<string, boolean>>(loadGroupChoices);
  const isOpen = (label: string) => choices[label] ?? label === activeGroup;
  const toggle = (label: string) => {
    const next = { ...choices, [label]: !isOpen(label) };
    setChoices(next);
    try {
      localStorage.setItem(OPEN_GROUPS_KEY, JSON.stringify(next));
    } catch {
      /* storage unavailable: the choice lasts for this page only */
    }
  };
  return (
    <nav className="sidebar" aria-label="Main">
      {entries.length > 0 && (
        <div className="nav-section">
          <p className="nav-section-title">Workspace</p>
          {entries.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.to === '/' || n.to === '/me'} onClick={onNavigate}>
              <Icon name={navIcon(n.to)} />
              <span>{n.label}</span>
            </NavLink>
          ))}
        </div>
      )}
      {groups.length > 0 && (
        <div className="nav-section">
          <p className="nav-section-title">Modules</p>
          {groups.map((g) => {
            const open = isOpen(g.label);
            return (
              <div key={g.label} className={`nav-group${open ? ' open' : ''}${g.label === activeGroup ? ' current' : ''}`} role="group" aria-label={g.label}>
                <button type="button" className="nav-group-toggle" aria-expanded={open} onClick={() => toggle(g.label)}>
                  <Icon name={groupIcon(g.label)} />
                  <span className="nav-group-label">{g.label}</span>
                  <span className="nav-count" aria-hidden="true">
                    {g.screens.length}
                  </span>
                  <Icon name="chevron" size={15} className="chevron" />
                </button>
                {open && (
                  <div className="nav-group-items">
                    {g.screens.map((s) => (
                      <NavLink key={s.path} to={s.path} end onClick={onNavigate}>
                        {s.title}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </nav>
  );
}

const initialsOf = (name: string) =>
  name
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

export function App() {
  const { stored, me, switchRole, signOut } = useSession();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const page = pageOf(pathname);
  useEffect(() => {
    document.title = page.title === 'HRMS' ? 'HRMS' : `${page.title} · HRMS`;
  }, [page.title]);
  if (!stored) return <SignInPage />;
  if (!stored.companyId || !stored.assignmentId) return <SelectRolePage />;

  const name = me ? (me.displayName ?? me.accountKey) : '';
  return (
    <div className={`shell${menuOpen ? ' menu-open' : ''}`}>
      <aside className="side">
        <div className="side-brand">
          <span className="brand-mark" aria-hidden="true" />
          <div className="brand-text">
            <span className="brand">HRMS</span>
            <span className="brand-company">{me?.companyName ?? ''}</span>
          </div>
        </div>
        <Sidebar pathname={pathname} onNavigate={() => setMenuOpen(false)} />
      </aside>
      {menuOpen && <div className="scrim" aria-hidden="true" onClick={() => setMenuOpen(false)} />}
      <div className="main-col">
        <header className="topbar">
          <button type="button" className="icon-button menu-toggle" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
            <Icon name="menu" size={20} />
          </button>
          <nav className="crumbs" aria-label="Breadcrumb">
            {page.group && (
              <>
                <span className="crumb">{page.group}</span>
                <Icon name="chevron" size={14} className="crumb-sep" />
              </>
            )}
            <span className="crumb current" aria-current="page">
              {page.title}
            </span>
          </nav>
          <div className="topbar-actions">
            {/* FR-096: the acting role and its scope are always visible. */}
            <div className="role-chip" aria-label="Current role">
              {me ? (
                <>
                  <span className="role-name">{me.roleName}</span>
                  <span className="role-meta">
                    {me.companyName} · scope {me.scopeKind.toLowerCase()}
                  </span>
                </>
              ) : (
                'Loading…'
              )}
            </div>
            <button type="button" className="ghost" aria-label="Switch role" title="Switch role" onClick={switchRole}>
              <Icon name="swap" size={16} />
              <span>Switch role</span>
            </button>
            <NavLink to="/inbox" className="icon-button" aria-label="Notifications" title="Notifications">
              <Icon name="bell" size={19} />
            </NavLink>
            <div className="user-chip" title={me?.accountKey ?? ''}>
              <span className="avatar" aria-hidden="true">
                {initialsOf(name)}
              </span>
              <span className="user-name">{name}</span>
            </div>
            <button type="button" className="ghost" aria-label="Sign out" title="Sign out" onClick={() => void signOut()}>
              <Icon name="logOut" size={16} />
              <span>Sign out</span>
            </button>
          </div>
        </header>
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
    </div>
  );
}
