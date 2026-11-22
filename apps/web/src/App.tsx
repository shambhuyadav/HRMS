import { Component, type ComponentType, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, NavLink, Navigate, Route, Routes, matchPath, useLocation } from 'react-router-dom';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';
import { api } from './api';
import { groupIcon, Icon, navIcon } from './icons';
import { useSession } from './session';
import { markFittingCards } from './sticky-heads';
import { labelTableCells } from './table-cards';
import { useMediaQuery, useTheme } from './theme';
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
import { ExpensesPage, hasDecisionQueues, InboxPage, LeavePage, PaymentsPage, ReportsPage, TasksPage } from './pages/work';
import type { ScreenRoute } from './screens';
import { MODULE_SCREENS } from './screens-registry';
import { PageTitleContext, scopeWords } from './ui';

interface NavEntry {
  to: string;
  label: string;
  /** Shown only when the selected assignment holds this permission. */
  permission?: string;
  /** Shown when the selected assignment holds any of these permissions. */
  anyOf?: readonly string[];
  /** Employee own-record screens (H3, BR-055): shown only in an OWN-scope context linked to an employee. */
  own?: boolean;
  /** Shown only when this holds for the selected assignment's permissions. */
  when?: (can: (permission: string) => boolean) => boolean;
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
  { to: '/tasks', label: 'Decisions', when: hasDecisionQueues },
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
  announcements: 'Events and announcements',
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
  // Confirmation policies are set-up, and a second "Confirmations" heading beside the core page of that name reads as a duplicate.
  confirmations: 'Administration',
  // Likewise the set-up screens under /leave and /employees: named apart from the Leave and Employees pages in Workspace.
  leave: 'Leave administration',
  employees: 'Employee administration',
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
    if (n.when && !n.when(can)) return false;
    return true;
  });
}

/** The module menu screens this context may see, grouped in registry order. */
export function visibleModuleGroups(can: (permission: string) => boolean, context?: { scopeKind: string } | null): { label: string; screens: ScreenRoute[] }[] {
  const groups = new Map<string, ScreenRoute[]>();
  const ownOnly = context?.scopeKind === 'OWN';
  for (const s of MODULE_SCREENS) {
    if (!s.nav || (s.permission && !can(s.permission))) continue;
    if (s.staffOnly && ownOnly) continue;
    const label = moduleGroupOf(s.path);
    groups.set(label, [...(groups.get(label) ?? []), s]);
  }
  return [...groups].map(([label, screens]) => ({ label, screens }));
}

/** Where a path sits in the menu: its module group (none for the core pages) and its title, for the breadcrumb and the window title. */
export function pageOf(pathname: string): { group: string | null; title: string } {
  const core = NAV.find((n) => n.to === pathname);
  if (core) return { group: null, title: core.label };
  // A fixed path wins over a pattern (/employees/manager-change is not the record /employees/:id), as in the router.
  const matches = MODULE_SCREENS.filter((s) => matchPath({ path: s.path, end: true }, pathname));
  const screen = matches.find((s) => !s.path.includes(':')) ?? matches[0];
  if (screen) {
    const group = moduleGroupOf(screen.path);
    return { group: group === screen.title ? null : group, title: screen.title };
  }
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
 * The name of the module group holding the page shown, open or closed, in the menu's strong text colour (its icon too). The brand
 * red marker stays on the page's own row (components/ui/sidebar.tsx), the menu's one red signal.
 */
const CURRENT_GROUP = 'text-sidebar-accent-foreground';

/** A group's chevron, in the menu's muted colour, turning a quarter when the group opens (not for a person who asks for less motion). */
const GROUP_CHEVRON = 'text-sidebar-muted-foreground transition-transform duration-150 group-data-[state=open]/collapsible:rotate-90 motion-reduce:transition-none';

/**
 * The menu: the core pages, then the module groups. A group opens by itself when the current page is in it; the user can open or
 * close any group, and that choice is remembered on this device (a convenience only: nothing depends on it).
 */
function MainMenu({ pathname, onNavigate }: { pathname: string; onNavigate: () => void }) {
  const { me, can } = useSession();
  // Reports appears once the role's catalogue offers at least one report (the Reports page reads the same cached catalogue);
  // if the catalogue cannot be read the entry stays, and the page says why.
  const catalogue = useQuery({ queryKey: ['catalogue'], queryFn: () => api<{ items: unknown[] }>('/v1/reports/catalogue') });
  const offered = catalogue.data?.items;
  const hasReports = !catalogue.isPending && (catalogue.isError || !Array.isArray(offered) || offered.length > 0);
  const entries = visibleNav(can, me ?? null).filter((n) => n.to !== '/reports' || hasReports);
  const groups = visibleModuleGroups(can, me ?? null);
  const activeGroup = groups.find((g) => g.screens.some((s) => matchPath({ path: s.path, end: true }, pathname)))?.label ?? null;
  const inModuleScreen = MODULE_SCREENS.some((s) => s.nav && !s.path.includes(':') && matchPath({ path: s.path, end: true }, pathname));
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
    <SidebarContent>
      <nav aria-label="Main" className="flex flex-col gap-[1.1rem]">
        {entries.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Workspace</SidebarGroupLabel>
            <SidebarMenu>
              {entries.map((n) => (
                // Active on its own page and on the pages under it (an employee's record keeps Employees lit), but not on a module
                // screen under its path (/confirmations/policies lights its own entry, not Confirmations as well).
                <SidebarMenuItem key={n.to}>
                  <SidebarMenuButton asChild>
                    <NavLink to={n.to} end={n.to === '/' || n.to === '/me' || inModuleScreen} onClick={onNavigate}>
                      <Icon name={navIcon(n.to)} />
                      <span>{n.label}</span>
                    </NavLink>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        )}
        {groups.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Modules</SidebarGroupLabel>
            <SidebarMenu>
              {groups.map((g) => {
                // A group of one screen is that screen's link, not a heading to open first.
                const only = g.screens.length === 1 ? g.screens[0]! : null;
                if (only) {
                  return (
                    <SidebarMenuItem key={g.label}>
                      <SidebarMenuButton asChild>
                        <NavLink to={only.path} end onClick={onNavigate} title={only.title === g.label ? undefined : g.label}>
                          <Icon name={groupIcon(g.label)} />
                          <span>{only.title}</span>
                        </NavLink>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                }
                const current = g.label === activeGroup;
                return (
                  <SidebarMenuItem key={g.label}>
                    <Collapsible open={isOpen(g.label)} onOpenChange={() => toggle(g.label)} role="group" aria-label={g.label} className="group/collapsible">
                      <CollapsibleTrigger asChild>
                        <SidebarMenuButton className={cn(current && CURRENT_GROUP)}>
                          <Icon name={groupIcon(g.label)} />
                          <span className="min-w-0 flex-1">{g.label}</span>
                          <Icon name="chevron" size={15} className={GROUP_CHEVRON} />
                        </SidebarMenuButton>
                      </CollapsibleTrigger>
                      <CollapsibleContent>
                        <SidebarMenuSub>
                          {g.screens.map((s) => (
                            <SidebarMenuSubItem key={s.path}>
                              <SidebarMenuSubButton asChild>
                                <NavLink to={s.path} end onClick={onNavigate}>
                                  {s.title}
                                </NavLink>
                              </SidebarMenuSubButton>
                            </SidebarMenuSubItem>
                          ))}
                        </SidebarMenuSub>
                      </CollapsibleContent>
                    </Collapsible>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        )}
      </nav>
    </SidebarContent>
  );
}

/** The phone's bottom bar offers the first four of these the role may open (as in the menu), then "More" for the full menu. */
const PHONE_BAR_PATHS: readonly string[] = ['/', '/me', '/team', '/leave', '/tasks', '/employees', '/inbox'];

/** Phone width, where the bottom bar is shown (the same width at which tables read as cards, styles.css). */
const PHONE_QUERY = '(max-width: 560px)';

/**
 * A place in the phone bar: its icon over its name, the whole cell a 54px target. The page shown (and "More" while the menu is open)
 * has its name in the text colour and its icon on a soft red pill; in Windows high-contrast mode, the system's highlight colours.
 */
const PHONE_BAR_ITEM = cn(
  'h-auto min-h-[54px] min-w-0 flex-col gap-[0.2rem] px-[0.15rem] py-[0.3rem] text-[0.78rem] leading-[1.2] font-semibold text-muted-foreground no-underline phone:min-h-[54px] has-[>svg]:px-[0.15rem]',
  'hover:bg-transparent hover:text-foreground dark:hover:bg-transparent',
  '[&_svg]:box-content [&_svg]:rounded-full [&_svg]:px-[0.85rem] [&_svg]:py-[0.15rem] [&_svg]:transition-colors',
  '[&.active]:text-foreground [&.active_svg]:bg-[var(--accent-soft)] [&.active_svg]:text-[var(--accent)]',
  'aria-expanded:text-foreground aria-expanded:[&_svg]:bg-[var(--accent-soft)] aria-expanded:[&_svg]:text-[var(--accent)]',
  'forced-colors:[&.active]:bg-[color:Highlight] forced-colors:[&.active]:text-[color:HighlightText] forced-colors:[&.active]:forced-color-adjust-none forced-colors:[&.active_svg]:bg-transparent forced-colors:[&.active_svg]:text-[color:HighlightText]',
);

/**
 * On a phone, the everyday pages within thumb's reach at the bottom of the screen, and the full menu behind "More" (the same menu
 * sheet as the top bar's menu button on a tablet). Rendered only at phone width, so a larger screen (and assistive technology there)
 * has one menu, not two.
 */
function PhoneBar({ menuOpen, onMenu, onNavigate }: { menuOpen: boolean; onMenu: () => void; onNavigate: () => void }) {
  const { me, can } = useSession();
  const entries = visibleNav(can, me ?? null);
  const picks = PHONE_BAR_PATHS.flatMap((path) => entries.filter((n) => n.to === path)).slice(0, 4);
  return (
    <nav
      aria-label="Shortcuts"
      className="relative z-[6] grid flex-none auto-cols-fr grid-flow-col gap-[0.15rem] border-t border-border bg-card px-[0.35rem] pt-[0.3rem] pb-[calc(0.3rem+env(safe-area-inset-bottom,0px))]"
    >
      {picks.map((n) => (
        <Button key={n.to} asChild variant="ghost" className={PHONE_BAR_ITEM}>
          <NavLink to={n.to} end={n.to === '/' || n.to === '/me'} onClick={onNavigate}>
            <Icon name={navIcon(n.to)} size={20} className="size-[20px]" />
            <span className="max-w-full truncate">{n.label}</span>
          </NavLink>
        </Button>
      ))}
      <Button variant="ghost" aria-expanded={menuOpen} onClick={onMenu} className={PHONE_BAR_ITEM}>
        <Icon name="menu" size={20} className="size-[20px]" />
        <span className="max-w-full truncate">More</span>
      </Button>
    </nav>
  );
}

/**
 * A page that fails while rendering shows a message inside the shell, instead of taking the whole application (menu and header)
 * down with it. Moving to another page clears it.
 */
class PageErrorBoundary extends Component<{ resetKey: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidUpdate(previous: { resetKey: string }) {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) this.setState({ failed: false });
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card" role="alert">
        <h2>This page could not be shown</h2>
        <p>Something went wrong while showing this page. Reload to try again; if it keeps happening, tell your administrator.</p>
        <div className="row">
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
          <Link to="/">Go to Home</Link>
        </div>
      </section>
    );
  }
}

/** A staff register opened by its address in a role that covers only the person's own record: say so, and where their own items are. */
function StaffOnlyNotice() {
  return (
    <section className="card" role="note">
      <h2>This page is for HR staff</h2>
      <p>Your selected role covers only your own record. Your own requests and records are under My ESS.</p>
      <div className="row">
        <Link to="/me">Go to My ESS</Link>
      </div>
    </section>
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
  const { stored, me, contextFailed, retryContext, switchRole, signOut } = useSession();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const { theme, toggle: toggleTheme } = useTheme();
  const phone = useMediaQuery(PHONE_QUERY);
  // At 920px wide or less the menu is a sheet over the page (hooks/use-mobile), opened from the top bar or, on a phone, the bar's "More".
  const sheetMenu = useIsMobile();
  const page = pageOf(pathname);
  useEffect(() => {
    document.title = page.title === 'HRMS' ? 'HRMS' : `${page.title} · HRMS`;
  }, [page.title]);
  // The page header names the page, unless the page names itself (its own h1 first in the content: the dashboard, and pages with
  // their own title and introduction). Checked after each render of the content, so a page that shows its title later is seen too.
  const mainRef = useRef<HTMLElement>(null);
  const [ownTitle, setOwnTitle] = useState(false);
  useLayoutEffect(() => {
    const main = mainRef.current;
    if (!main) return undefined;
    const check = () => setOwnTitle(main.querySelector(':scope > h1:not(.page-title)') !== null);
    check();
    const watcher = new MutationObserver(check);
    watcher.observe(main, { childList: true });
    return () => watcher.disconnect();
  }, [pathname, stored?.assignmentId]);
  // On a phone a table's rows read as stacked cards, each value under its column's name (styles.css, max-width 560px): every body
  // cell carries the name of its column, and the cell that heads the card is marked (table-cards.ts), kept up to date as pages render.
  useEffect(() => {
    const main = mainRef.current;
    if (!main || typeof MutationObserver === 'undefined') return undefined;
    // The same pass marks the cards whose tables fit their width, so those lists keep their headings in view (sticky-heads.ts); a
    // change of window size re-checks them.
    let frame = 0;
    const label = () => {
      frame = 0;
      labelTableCells(main);
      markFittingCards(main);
    };
    const later = () => {
      if (!frame) frame = requestAnimationFrame(label);
    };
    const watcher = new MutationObserver(later);
    watcher.observe(main, { childList: true, subtree: true });
    const resized = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later);
    resized?.observe(main);
    label();
    return () => {
      watcher.disconnect();
      resized?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [me, stored?.assignmentId]);
  if (!stored) return <SignInPage />;
  if (!stored.companyId || !stored.assignmentId) return <SelectRolePage />;

  // A sign-in name without a display name shows its part before the "@" (the whole address is in the tooltip), not a cut-off address.
  const name = me ? (me.displayName ?? me.accountKey.replace(/@.*$/, '')) : '';
  const phoneBar = phone && !!me;
  return (
    // The shell: the menu beside the page on a wide screen, a sheet over it at 920px or less (components/ui/sidebar). The shell's
    // classes follow the menu sheet and the phone bar.
    <SidebarProvider
      openMobile={menuOpen}
      onOpenMobileChange={setMenuOpen}
      className={cn('shell', menuOpen && 'menu-open', phoneBar && 'has-phone-bar')}
    >
      {/* Keyboard users jump past the menu and header to the page itself; the link shows only when it has the focus. */}
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Sidebar>
        <aside className="flex min-h-0 flex-1 flex-col">
          <SidebarHeader className="min-h-[60px] flex-row items-center gap-3 border-b border-sidebar-border px-5 py-[0.85rem]">
            {/* The brand mark: a white square outline on the brand red. */}
            <span
              aria-hidden="true"
              className="relative size-[30px] flex-none rounded-[8px] bg-[var(--accent-bright)] shadow-[inset_0_-1px_0_rgba(0,0,0,0.18)] after:absolute after:inset-[8.5px] after:rounded-[4px] after:border-[2.5px] after:border-white/95 after:content-['']"
            />
            <div className="flex min-w-0 flex-col leading-[1.2]">
              <span className="text-[1.05rem] font-semibold tracking-tight text-sidebar-accent-foreground">HRMS</span>
              <span className="truncate text-[0.74rem] text-sidebar-muted-foreground">{me?.companyName ?? ''}</span>
            </div>
          </SidebarHeader>
          {/* The menu waits for the role's permissions: entries are never shown and then taken away. */}
          {me && <MainMenu pathname={pathname} onNavigate={() => setMenuOpen(false)} />}
        </aside>
      </Sidebar>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="relative z-[5] flex min-h-[60px] items-center gap-4 border-b border-border bg-card px-7 py-2 [@media(max-width:920px)]:gap-2 [@media(max-width:920px)]:px-4">
          {/* Only where the menu is a sheet, and not beside the phone bar, whose "More" opens it. */}
          {sheetMenu && !phoneBar && (
            <SidebarTrigger aria-label="Menu" aria-expanded={menuOpen} className="size-[var(--control-h)]">
              <Icon name="menu" size={20} className="size-[20px]" />
            </SidebarTrigger>
          )}
          {/* On a phone the page title sits just below; a cut-off copy of it ("Emplo…") in the bar adds nothing. */}
          <Breadcrumb aria-label="Breadcrumb" className="min-w-0 flex-1">
            <BreadcrumbList>
              {page.group && (
                <>
                  <BreadcrumbItem className="phone:hidden">{page.group}</BreadcrumbItem>
                  <BreadcrumbSeparator className="text-[var(--faint)] phone:hidden [&>svg]:size-[14px]">
                    <Icon name="chevron" size={14} />
                  </BreadcrumbSeparator>
                </>
              )}
              <BreadcrumbItem className="min-w-0 phone:hidden">
                <BreadcrumbPage>{page.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <div className="flex items-center gap-[0.45rem] phone:min-w-0">
            {/* FR-096: the acting role and its scope are always visible. */}
            <div className="role-chip" role="group" aria-label="Current role">
              {me ? (
                <>
                  <span className="role-name">{me.roleName}</span>
                  <span className="role-meta">
                    {me.companyName} · {scopeWords(me.scopeKind)}
                  </span>
                </>
              ) : (
                'Loading…'
              )}
            </div>
            {/* At 920px or less the two worded actions show their icons only (their names stay as labels and tooltips). */}
            <Button variant="ghost" aria-label="Switch role" title="Switch role" onClick={switchRole}>
              <Icon name="swap" size={16} className="size-[16px]" />
              <span className="[@media(max-width:920px)]:hidden">Switch role</span>
            </Button>
            {/* The theme switch: pressed means the dark theme is on (theme.ts keeps the choice on this device). */}
            <Button
              variant="ghost"
              size="icon"
              aria-label="Dark theme"
              aria-pressed={theme === 'dark'}
              title={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
              onClick={toggleTheme}
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} className="size-[18px]" />
            </Button>
            <Button asChild variant="ghost" size="icon" className="no-underline [&.active]:bg-[var(--accent-soft)] [&.active]:text-[var(--accent)]">
              <NavLink to="/inbox" aria-label="Notifications" title="Notifications">
                <Icon name="bell" size={19} className="size-[19px]" />
              </NavLink>
            </Button>
            <div className="ml-1 flex items-center gap-[0.55rem] border-l border-border pl-3 phone:hidden [@media(max-width:1180px)]:pl-2" title={me?.accountKey ?? ''}>
              <Avatar aria-hidden="true" className="size-[32px]">
                <AvatarFallback className="text-[0.74rem] font-medium text-foreground">{initialsOf(name)}</AvatarFallback>
              </Avatar>
              <span className="max-w-[170px] truncate text-[0.85rem] font-medium text-foreground [@media(max-width:1180px)]:hidden">{name}</span>
            </div>
            <Button variant="ghost" aria-label="Sign out" title="Sign out" onClick={() => void signOut()}>
              <Icon name="logOut" size={16} className="size-[16px]" />
              <span className="[@media(max-width:920px)]:hidden">Sign out</span>
            </Button>
          </div>
        </header>
        <main className="content" id="main" tabIndex={-1} ref={mainRef}>
          {!ownTitle && page.title !== 'HRMS' && (
            // The module's name is in the breadcrumb above; the header is the title alone, as on pages that title themselves.
            <header className="page-header">
              <h1 className="page-title">{page.title}</h1>
            </header>
          )}
          {/* Pages wait for the role's context and permissions, so none says "not permitted" while they are still loading. */}
          {!me ? (
            contextFailed ? (
              <section className="card" role="alert">
                <h2>Your workspace could not be loaded</h2>
                <p>Check your connection and try again.</p>
                <div className="row">
                  <button type="button" onClick={retryContext}>
                    Try again
                  </button>
                </div>
              </section>
            ) : (
              <p className="hint" role="status">
                Loading your workspace…
              </p>
            )
          ) : (
            <PageTitleContext.Provider value={!ownTitle && page.title !== 'HRMS' ? page.title : null}>
              <PageErrorBoundary resetKey={pathname}>
                <Routes>
                  {CORE_ROUTES.map((r) => (
                    <Route key={r.path} path={r.path} element={<r.component />} />
                  ))}
                  {/* Wave-2 module screens (screens-registry.ts); each screen re-checks its permissions and the server re-checks every call. */}
                  {MODULE_SCREENS.map((s) => (
                    <Route key={s.path} path={s.path} element={s.staffOnly && me.scopeKind === 'OWN' ? <StaffOnlyNotice /> : <s.component />} />
                  ))}
                  <Route path="*" element={<Navigate to="/" />} />
                </Routes>
              </PageErrorBoundary>
            </PageTitleContext.Provider>
          )}
        </main>
        {phoneBar && <PhoneBar menuOpen={menuOpen} onMenu={() => setMenuOpen(!menuOpen)} onNavigate={() => setMenuOpen(false)} />}
      </div>
    </SidebarProvider>
  );
}
