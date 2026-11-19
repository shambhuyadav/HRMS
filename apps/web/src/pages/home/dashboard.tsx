// The dashboard: widgets, pending tasks, recent activity and shortcuts, and the records behind a figure.

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, formatDate, formatUnits } from '../../api';
import { useSession } from '../../session';
import { Icon, type IconName } from '../../icons';
import { Badge, Empty, ErrorNote, scopeWords, Section } from '../../ui';
import { AnnouncementsPanel } from '../announcements';
import { flatRow, SimpleTable, words } from './shared';

interface SourceList {
  label?: string;
  api: string;
  sumOf?: string;
}

/** A widget's link (dashboard/sources.ts): present only when the destination is permitted in the selected assignment. */
interface WidgetSource {
  href: string;
  lists: SourceList[];
  shortcut?: { to: string; label: string };
}

interface Widget {
  code: string;
  title: string;
  kind: string;
  status: 'OK' | 'NOT_CONFIGURED' | 'NOT_AVAILABLE' | 'SUPPRESSED';
  value?: number | string;
  message?: string;
  /** SUPPRESSED (BR-045, I-83): a people-count between 1 and threshold - 1 with no list behind it; the number is never sent. */
  threshold?: number;
  source?: WidgetSource;
}

interface Dashboard {
  role: string;
  scope: string;
  company: string | null;
  title: string | null;
  state: string;
  businessDate: string;
  period: { from: string; to: string };
  refreshedAt: string;
  widgets: Widget[];
  shortcuts: { to: string; label: string }[];
}

/** The key carries the assignment: one role's figures are never shown under another. */
function useDashboard(refetchInterval?: number) {
  const { stored } = useSession();
  return useQuery({
    queryKey: ['dashboard', stored?.assignmentId ?? '-'],
    queryFn: () => api<Dashboard>('/v1/dashboard'),
    ...(refetchInterval ? { refetchInterval, refetchIntervalInBackground: false } : {}),
  });
}

interface PendingTask {
  /** Null for a goal (KRA) review, which is a state on the appraisal rather than a routed task. */
  taskId: string | null;
  /** A goal review's appraisal (kind appraisal_goal_review): its review is on the appraisal itself. */
  appraisalId?: string;
  kind: string;
  ownerEmployeeCode: string | null;
  ownerName: string | null;
  assignedAt: string;
  dueAt: string | null;
  overdue: boolean;
  delegated: boolean;
}

/** FR-041 KRA review (I-77 item 3): listed with the tasks, but reviewed on the appraisal (POST /v1/appraisals/:id/goal-review). */
const GOAL_REVIEW = 'appraisal_goal_review';

/** Codes whose plain reading is not just the code in words. */
const VALUE_WORDS: Record<string, string> = { NOT_PROCESSED: 'Not yet calculated' };

/** A figure as a person reads it: a code in words, a decimal without its padding zeros. Nothing is rounded, and other text stays as sent. */
function widgetText(value: number | string | undefined): string {
  if (typeof value === 'string' && VALUE_WORDS[value]) return VALUE_WORDS[value];
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value)) {
    const text = words(value);
    return text.charAt(0).toUpperCase() + text.slice(1);
  }
  return formatUnits(value);
}

/** DF17 priority task list: only what the selected assignment may decide, so each row's action is open to it. */
function PendingTasks() {
  const { stored } = useSession();
  const tasks = useQuery({ queryKey: ['dashboard-tasks', stored?.assignmentId ?? '-'], queryFn: () => api<{ items: PendingTask[]; total: number }>('/v1/dashboard/tasks') });
  return (
    <Section title={`Pending tasks${tasks.data ? ` (${tasks.data.total})` : ''}`}>
      {tasks.data?.items.length === 0 && <Empty>Nothing waiting for you.</Empty>}
      {!!tasks.data?.items.length && (
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th>Employee</th>
              <th>Assigned</th>
              <th>Due</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {tasks.data.items.map((t) => (
              <tr key={t.taskId ?? `goal-review:${t.appraisalId}`}>
                <td>
                  {t.kind === GOAL_REVIEW ? 'Goal (KRA) review' : words(t.kind)} {t.delegated && <Badge tone="warn">delegated</Badge>}
                </td>
                <td>{t.ownerName ? `${t.ownerName} (${t.ownerEmployeeCode})` : '—'}</td>
                <td>{formatDate(t.assignedAt)}</td>
                <td>
                  {formatDate(t.dueAt)} {t.overdue && <Badge tone="warn">overdue</Badge>}
                </td>
                <td>
                  {t.kind === GOAL_REVIEW && t.appraisalId ? (
                    <Link to={`/appraisal/appraisals/${encodeURIComponent(t.appraisalId)}`}>Review the goals</Link>
                  ) : (
                    <Link to="/tasks">Open decisions</Link>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorNote error={tasks.error} />
    </Section>
  );
}

interface Activity {
  status: 'OK' | 'NOT_CONFIGURED';
  message?: string;
  days?: number;
  items: { action: string; resource: string; occurredAt: string }[];
  total: number;
}

/**
 * DF17 "recent operational activity" (I-83): what the selected assignment itself did in the company's dated window, as the
 * audit trail recorded it. What and when only; nobody else's work.
 */
function RecentActivity() {
  const { stored } = useSession();
  const activity = useQuery({ queryKey: ['dashboard-activity', stored?.assignmentId ?? '-'], queryFn: () => api<Activity>('/v1/dashboard/activity') });
  const a = activity.data;
  return (
    <Section title={`Recent activity${a?.days ? ` (last ${a.days} days)` : ''}`}>
      {a?.status === 'NOT_CONFIGURED' && <Empty>{a.message}</Empty>}
      {a?.status === 'OK' && a.items.length === 0 && <Empty>Nothing recorded for this role in that time.</Empty>}
      {a?.status === 'OK' && a.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>What</th>
              <th>Record kind</th>
            </tr>
          </thead>
          <tbody>
            {a.items.map((item, i) => (
              <tr key={`${item.occurredAt}-${i}`}>
                <td>{new Date(item.occurredAt).toLocaleString()}</td>
                <td>{words(item.action)}</td>
                <td>{words(item.resource)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ErrorNote error={activity.error} />
    </Section>
  );
}

/** A figure's icon, from what its title is about (decoration only: the title says what it is). */
function widgetIcon(title: string): IconName {
  const t = title.toLowerCase();
  if (/leave|holiday|absence/.test(t)) return 'calendar';
  if (/attendance|late|punch|present|absent|shift|overtime/.test(t)) return 'clock';
  if (/payroll|salary|pay |payment|amount|expense|claim|reimburse|loan/.test(t)) return 'wallet';
  if (/confirm|probation/.test(t)) return 'badgeCheck';
  if (/task|decision|approv|review|pending/.test(t)) return 'checkSquare';
  if (/hiring|requisition|candidate|offer|interview|vacanc/.test(t)) return 'userPlus';
  if (/appraisal|goal|rating|kra/.test(t)) return 'target';
  if (/training|course/.test(t)) return 'graduation';
  if (/document|letter|policy/.test(t)) return 'fileText';
  if (/access|grant|role|security/.test(t)) return 'shield';
  if (/employee|people|headcount|team|member|draft/.test(t)) return 'users';
  return 'barChart';
}

/** A shortcut's icon, from where it leads. */
function shortcutIcon(to: string): IconName {
  if (to.startsWith('/team')) return 'users';
  if (to.startsWith('/employees')) return 'idCard';
  if (to.startsWith('/leave')) return 'calendar';
  if (to.startsWith('/tasks')) return 'checkSquare';
  if (to.startsWith('/confirmations')) return 'badgeCheck';
  if (to.startsWith('/payroll') || to.startsWith('/payments') || to.startsWith('/expenses')) return 'wallet';
  if (to.startsWith('/reports')) return 'barChart';
  if (to.startsWith('/timesheet') || to.startsWith('/me/attendance')) return 'clock';
  if (to.startsWith('/me') || to.startsWith('/profile')) return 'user';
  return 'sparkles';
}

/**
 * Where a figure's foot link leads, named for the reader. A figure whose list is a module screen with its filters goes there;
 * one whose list is the records page goes to the module screen where the reader acts (the figure itself still opens its
 * records, FR-097); one with neither goes to its records.
 */
function widgetFoot(source: WidgetSource): { to: string; label: string; sameAsFigure: boolean } {
  const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);
  const recordsPage = source.href.startsWith('/dashboard/sources/');
  if (!recordsPage) return { to: source.href, label: source.shortcut ? `See ${lower(source.shortcut.label)}` : 'See the list', sameAsFigure: true };
  if (source.shortcut) return { to: source.shortcut.to, label: `See ${lower(source.shortcut.label)}`, sameAsFigure: false };
  return { to: source.href, label: 'See the list', sameAsFigure: true };
}

/** The everyday tasks a role may start, offered beside the server's shortcuts when the role holds the screen's duties. */
const TASK_SHORTCUTS: readonly { to: string; label: string; permissions: readonly string[]; ownRecord?: boolean }[] = [
  { to: '/leave', label: 'Apply for leave', permissions: ['leave.read.operational', 'leave.submit.operational'], ownRecord: true },
  { to: '/expenses', label: 'Claim an expense', permissions: ['expense.draft.operational'], ownRecord: true },
  { to: '/timesheets', label: 'Fill in my timesheet', permissions: ['timesheet.read.operational', 'timesheet.submit.operational'], ownRecord: true },
];

const greetingAt = (hour: number) => (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** The company's business date (YYYY-MM-DD) as a person reads it, e.g. "Wednesday, 11 November 2026". */
function longDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return day;
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${d} ${MONTHS[m - 1]} ${y}`;
}

/** The month a period starting on `day` covers, in words ("November 2026"). */
function monthOf(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return y && m && MONTHS[m - 1] ? `${MONTHS[m - 1]} ${y}` : day;
}

/** DF17: role-labelled dashboard; refresh at most every 60 s with jitter, paused while the tab is hidden. */
export function DashboardPage() {
  const { me, can } = useSession();
  const [jitter] = useState(() => 60_000 + Math.floor(Math.random() * 15_000));
  const dashboard = useDashboard(jitter);
  const d = dashboard.data;
  // The role's everyday tasks first (own-record screens only where the scope reaches the own record), then the server's
  // shortcuts to other screens; one entry per screen.
  const ownRecord = !!me?.employeeId && (me.scopeKind === 'OWN' || me.scopeKind === 'COMPANY');
  const tasks = d?.state === 'OK' ? TASK_SHORTCUTS.filter((t) => (!t.ownRecord || ownRecord) && t.permissions.every((p) => can(p))) : [];
  const quickActions = [...tasks, ...(d?.shortcuts ?? []).filter((s) => !tasks.some((t) => t.to === s.to))];
  const firstName = (me?.displayName ?? '').trim().split(/\s+/)[0];
  const role = me?.roleName ?? (d ? words(d.role) : '');
  return (
    <>
      <h1 className="sr-only">{d?.title ?? 'Home'}</h1>
      <header className="dash-hero">
        <div className="dash-hero-text">
          <p className="page-eyebrow">{d ? `${d.title ?? 'Home'} · ${longDate(d.businessDate)}` : 'Home'}</p>
          <p className="dash-greeting">
            {greetingAt(new Date().getHours())}
            {firstName ? `, ${firstName}` : ''}
          </p>
          {d && (
            // FR-096: the acting role, its company and scope, and the period the figures cover are always visible.
            <p className="dash-context">
              <span>{role.charAt(0).toUpperCase() + role.slice(1)}</span>
              {d.company && <span>{d.company}</span>}
              <span>{scopeWords(d.scope)}</span>
              <span>Figures for {monthOf(d.period.from)}</span>
            </p>
          )}
        </div>
        {d && <span className="dash-refreshed">Updated {new Date(d.refreshedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}
      </header>
      {d?.state === 'NO_DASHBOARD' && <Empty>No dashboard is available for this role.</Empty>}
      <AnnouncementsPanel />
      {!!d?.widgets.length && (
        <div className="widgets">
          {d.widgets.map((w) => (
            <div key={w.code} className="widget">
              <div className="widget-head">
                <div className="widget-title">{w.title}</div>
                <span className="widget-icon" aria-hidden="true">
                  <Icon name={widgetIcon(w.title)} size={18} />
                </span>
              </div>
              {w.status === 'OK' && (
                <div className={typeof w.value === 'number' || /^[\d.,\s]*$/.test(String(w.value ?? '')) ? 'widget-value' : 'widget-value widget-value-text'}>
                  {w.source ? <Link to={w.source.href}>{widgetText(w.value)}</Link> : widgetText(w.value)}
                </div>
              )}
              {w.status === 'NOT_CONFIGURED' && <div className="widget-note">{w.message}</div>}
              {w.status === 'NOT_AVAILABLE' && <div className="widget-note">Not available yet</div>}
              {w.status === 'SUPPRESSED' && (
                <>
                  <div className="widget-value widget-value-text">Fewer than {w.threshold}</div>
                  <div className="widget-note">Small counts are not shown where the records cannot be opened here.</div>
                </>
              )}
              {w.status === 'OK' &&
                w.source &&
                (() => {
                  const foot = widgetFoot(w.source);
                  // Leading where the figure leads, it is a mouse convenience (the keyboard already reaches the figure's link);
                  // leading elsewhere, it is a link of its own.
                  return foot.sameAsFigure ? (
                    <Link className="widget-foot" to={foot.to} tabIndex={-1} aria-hidden="true">
                      {foot.label}
                    </Link>
                  ) : (
                    <Link className="widget-foot" to={foot.to}>
                      {foot.label}
                    </Link>
                  );
                })()}
            </div>
          ))}
        </div>
      )}
      {quickActions.length > 0 && (
        <Section title="Quick actions">
          <ul className="quick-actions">
            {quickActions.map((s) => (
              <li key={s.to}>
                <Link to={s.to} className="quick-action">
                  <span className="quick-action-icon" aria-hidden="true">
                    <Icon name={shortcutIcon(s.to)} size={18} />
                  </span>
                  <span className="quick-action-label">{s.label}</span>
                  <Icon name="chevron" size={16} className="quick-action-go" />
                </Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      {d?.state === 'OK' && (
        <div className="dash-columns">
          <PendingTasks />
          <RecentActivity />
        </div>
      )}
      <ErrorNote error={dashboard.error} />
    </>
  );
}

interface ListAnswer {
  items: Record<string, unknown>[];
  total?: number;
}

function SourceRows({ list }: { list: SourceList }) {
  const rows = useQuery({ queryKey: ['widget-source', list.api], queryFn: () => api<ListAnswer>(list.api) });
  const count = list.sumOf ? rows.data?.items.reduce((n, r) => n + Number(r[list.sumOf!] ?? 0), 0) : (rows.data?.total ?? rows.data?.items.length);
  return (
    <>
      {rows.data && (
        <p className="hint">
          {list.label ? `${list.label}: ` : ''}
          {count} {list.sumOf ? 'in total' : count === 1 ? 'record' : 'records'}
        </p>
      )}
      {rows.data?.items.length === 0 && <Empty>No records.</Empty>}
      {!!rows.data?.items.length && <SimpleTable rows={rows.data.items.map(flatRow)} />}
      <ErrorNote error={rows.error} />
    </>
  );
}

/**
 * FR-097, DF17 "Every widget links to source lists with the same filters": the records behind a widget, from the list routes
 * and filters the server gave the widget, so the two cannot differ. The dashboard answer is read again here: a destination no
 * longer permitted in the selected assignment is not offered.
 */
export function WidgetSourcePage() {
  const { code } = useParams();
  const dashboard = useDashboard();
  const widget = dashboard.data?.widgets.find((w) => w.code === code);
  return (
    <>
      <Link className="back-link" to="/">← Home</Link>
      {dashboard.data && !widget?.source && <Empty>This list is not available in the selected role.</Empty>}
      {widget?.source && (
        <Section title={widget.title}>
          {widget.source.lists.map((list) => (
            <SourceRows key={list.api} list={list} />
          ))}
          {widget.source.shortcut && <Link to={widget.source.shortcut.to}>Open {widget.source.shortcut.label}</Link>}
        </Section>
      )}
      <ErrorNote error={dashboard.error} />
    </>
  );
}
