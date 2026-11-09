import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, formatDate, formatUnits } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, nextSort, Section, SortHeader, type SortState, sortParams, StateBadge } from '../ui';

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
  taskId: string;
  kind: string;
  ownerEmployeeCode: string | null;
  ownerName: string | null;
  assignedAt: string;
  dueAt: string | null;
  overdue: boolean;
  delegated: boolean;
}

const words = (code: string) => code.replace(/_/g, ' ').toLowerCase();

/** A figure as a person reads it: a code in words, a decimal without its padding zeros. Nothing is rounded, and other text stays as sent. */
function widgetText(value: number | string | undefined): string {
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
              <th />
            </tr>
          </thead>
          <tbody>
            {tasks.data.items.map((t) => (
              <tr key={t.taskId}>
                <td>
                  {words(t.kind)} {t.delegated && <Badge tone="warn">delegated</Badge>}
                </td>
                <td>{t.ownerName ? `${t.ownerName} (${t.ownerEmployeeCode})` : '—'}</td>
                <td>{formatDate(t.assignedAt)}</td>
                <td>
                  {formatDate(t.dueAt)} {t.overdue && <Badge tone="warn">overdue</Badge>}
                </td>
                <td>
                  <Link to="/tasks">Open decisions</Link>
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

/** DF17: role-labelled dashboard; refresh at most every 60 s with jitter, paused while the tab is hidden. */
export function DashboardPage() {
  const [jitter] = useState(() => 60_000 + Math.floor(Math.random() * 15_000));
  const dashboard = useDashboard(jitter);
  const d = dashboard.data;
  return (
    <>
      <h1>{d?.title ?? 'Home'}</h1>
      {d && (
        <p className="hint">
          {words(d.role)} · {d.company ? `${d.company} · ` : ''}scope {d.scope.toLowerCase()} · today {d.businessDate} · month from {d.period.from} · refreshed {new Date(d.refreshedAt).toLocaleTimeString()}
        </p>
      )}
      {d?.state === 'NO_DASHBOARD' && <Empty>No dashboard is available for this role.</Empty>}
      <div className="widgets">
        {d?.widgets.map((w) => (
          <div key={w.code} className="widget">
            <div className="widget-title">{w.title}</div>
            {w.status === 'OK' && <div className="widget-value">{w.source ? <Link to={w.source.href}>{widgetText(w.value)}</Link> : widgetText(w.value)}</div>}
            {w.status === 'NOT_CONFIGURED' && <div className="widget-note">{w.message}</div>}
            {w.status === 'NOT_AVAILABLE' && <div className="widget-note">Not available yet</div>}
            {w.status === 'SUPPRESSED' && (
              <>
                <div className="widget-value">Fewer than {w.threshold}</div>
                <div className="widget-note">Small counts are not shown where the records cannot be opened here.</div>
              </>
            )}
          </div>
        ))}
      </div>
      {d?.state === 'OK' && <PendingTasks />}
      {d?.state === 'OK' && <RecentActivity />}
      {!!d?.shortcuts?.length && (
        <Section title="Shortcuts">
          <ul>
            {d.shortcuts.map((s) => (
              <li key={s.to}>
                <Link to={s.to}>{s.label}</Link>
              </li>
            ))}
          </ul>
        </Section>
      )}
      <ErrorNote error={dashboard.error} />
    </>
  );
}

interface ListAnswer {
  items: Record<string, unknown>[];
  total?: number;
}

/** A row as a table shows it: one level of nesting opened up, and record references left out. */
function flatRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [inner, v] of Object.entries(value)) out[`${key}.${inner}`] = v;
    else out[key] = value;
  }
  return Object.fromEntries(Object.entries(out).filter(([k]) => !/(^|\.)(id|version|[a-z]+Id)$/.test(k)));
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
      <Link to="/">← Home</Link>
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

export const HOME_SCREENS: readonly ScreenRoute[] = [{ path: '/dashboard/sources/:code', title: 'Records behind a dashboard figure', permission: 'dashboard.read.operational', nav: false, component: WidgetSourcePage }];

interface Member {
  id: string;
  employeeCode: string;
  displayName: string;
  department: string | null;
  designation: string | null;
  location: string | null;
  manager: string | null;
  joiningDate: string | null;
  status: string;
  todayAttendance: string | null;
  nextReviewDate: string | null;
}

/** The columns GET /v1/my-team sorts by (team/service.ts). */
type TeamSort = 'employeeCode' | 'displayName' | 'department' | 'designation' | 'location' | 'joiningDate' | 'status' | 'nextReviewDate';

const TEAM_PAGE_SIZES = [25, 50, 100] as const;
/** The list's filters, in the address so a dashboard figure opens the list with its own (DF17) and the export holds the same (DF16). */
const TEAM_FILTERS = ['departmentId', 'locationId', 'status', 'reviewDueFrom', 'reviewDueTo', 'todayAttendance', 'confirmationDueTo'] as const;

export function MyTeamPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);
  const [sort, setSort] = useState<SortState<TeamSort>>(null);
  useEffect(() => {
    const t = setTimeout(() => {
      setQuery(search);
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [search]);
  const onSort = (column: TeamSort) => {
    setSort((current) => nextSort(current, column));
    setPage(1);
  };
  const filters = Object.fromEntries(TEAM_FILTERS.flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : []))) as Record<string, string>;
  const setFilter = (key: (typeof TEAM_FILTERS)[number], value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next);
    setPage(1);
  };
  const listFilters = { ...filters, ...(query ? { search: query } : {}), ...sortParams(sort) };
  const team = useQuery({
    queryKey: ['team', listFilters, page, pageSize],
    queryFn: () => api<{ items: Member[]; total: number }>(`/v1/my-team?${new URLSearchParams({ ...listFilters, page: String(page), pageSize: String(pageSize) }).toString()}`),
  });
  const options = useQuery({
    queryKey: ['team-filter-options'],
    queryFn: () => api<{ departments?: { id: string; name: string }[]; locations?: { id: string; name: string }[] }>('/v1/my-team/filter-options'),
  });
  // DF16 "Counts and export reflect identical membership and filters": the same filters and order as the list on screen.
  const exportTeam = useMutation({ mutationFn: () => api<{ id: string }>('/v1/reports', { body: { reportCode: 'MY_TEAM', filters: listFilters } }) });
  const pages = Math.max(1, Math.ceil((team.data?.total ?? 0) / pageSize));
  return (
    <Section title={`My team${team.data ? ` (${team.data.total})` : ''}`}>
      <div className="grid-form">
        <label className="inline">
          Search <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code, email or extension" />
        </label>
        <label className="inline">
          Department{' '}
          <select value={filters.departmentId ?? ''} onChange={(e) => setFilter('departmentId', e.target.value)}>
            <option value="">All</option>
            {options.data?.departments?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Location{' '}
          <select value={filters.locationId ?? ''} onChange={(e) => setFilter('locationId', e.target.value)}>
            <option value="">All</option>
            {options.data?.locations?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <label className="inline">
          Status{' '}
          <select value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">All</option>
            <option value="ACTIVE_PROBATION">Active (probation)</option>
            <option value="ACTIVE_CONFIRMED">Active (confirmed)</option>
            <option value="NOTICE">Notice</option>
          </select>
        </label>
        <label className="inline">
          Review due from <input type="date" value={filters.reviewDueFrom ?? ''} onChange={(e) => setFilter('reviewDueFrom', e.target.value)} />
        </label>
        <label className="inline">
          to <input type="date" value={filters.reviewDueTo ?? ''} onChange={(e) => setFilter('reviewDueTo', e.target.value)} />
        </label>
      </div>
      {filters.todayAttendance && (
        <p className="hint">
          Attendance today: {words(filters.todayAttendance)}{' '}
          <button className="secondary" onClick={() => setFilter('todayAttendance', '')}>
            Clear
          </button>
        </p>
      )}
      {filters.confirmationDueTo && (
        <p className="hint">
          Confirmation due by {formatDate(filters.confirmationDueTo)}{' '}
          <button className="secondary" onClick={() => setFilter('confirmationDueTo', '')}>
            Clear
          </button>
        </p>
      )}
      <table>
        <thead>
          <tr>
            <SortHeader column="employeeCode" label="Code" sort={sort} onSort={onSort} />
            <SortHeader column="displayName" label="Name" sort={sort} onSort={onSort} />
            <SortHeader column="department" label="Department" sort={sort} onSort={onSort} />
            <SortHeader column="designation" label="Designation" sort={sort} onSort={onSort} />
            <SortHeader column="location" label="Location" sort={sort} onSort={onSort} />
            <th>Manager</th>
            <SortHeader column="joiningDate" label="Joined" sort={sort} onSort={onSort} />
            <SortHeader column="status" label="Status" sort={sort} onSort={onSort} />
            <th>Today</th>
            <SortHeader column="nextReviewDate" label="Next review" sort={sort} onSort={onSort} />
          </tr>
        </thead>
        <tbody>
          {team.data?.items.map((m) => (
            <tr key={m.id}>
              <td>{m.employeeCode}</td>
              <td>
                <Link to={`/team/${m.id}`}>{m.displayName}</Link>
              </td>
              <td>{m.department ?? '—'}</td>
              <td>{m.designation ?? '—'}</td>
              <td>{m.location ?? '—'}</td>
              <td>{m.manager ?? '—'}</td>
              <td>{formatDate(m.joiningDate)}</td>
              <td>
                <StateBadge state={m.status} />
              </td>
              <td>
                <StateBadge state={m.todayAttendance ?? 'NOT_PROCESSED'} />
              </td>
              <td>{formatDate(m.nextReviewDate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {team.data?.items.length === 0 && <Empty>No current team members.</Empty>}
      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Next
        </button>
        <label className="inline">
          Rows{' '}
          <select
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {TEAM_PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
      </div>
      {can('team.export.operational') && (
        <p>
          <button className="secondary" disabled={exportTeam.isPending} onClick={() => exportTeam.mutate()}>
            Export this list
          </button>{' '}
          {exportTeam.isSuccess && (
            <span className="hint">
              Requested. Download it from <Link to="/reports">Reports</Link>.
            </span>
          )}
        </p>
      )}
      <ErrorNote error={team.error ?? exportTeam.error} />
    </Section>
  );
}

type TabSection = { available: true; items: Record<string, unknown>[] } | { available: false; message: string };
type Tab = { available: true; items?: Record<string, unknown>[]; data?: unknown; sections?: Record<string, TabSection> };

const TAB_TITLES: Record<string, string> = {
  workProfile: 'Work profile',
  employmentAndReporting: 'Employment and reporting',
  attendance: 'Attendance (30 days)',
  leave: 'Leave',
  skillsAndTraining: 'Skills and training',
  goalsAndTasks: 'Goals and tasks',
  history: 'History',
  compensation: 'Compensation and increment history',
  privateInformation: 'Private information and documents',
};

const SECTION_TITLES: Record<string, string> = {
  training: 'Training',
  skills: 'Skills',
  goals: 'Goals',
  salaryArrangements: 'Salary',
  incrementHistory: 'Increment history',
  personal: 'Personal',
  documents: 'Documents',
};

interface HistoryRow {
  occurredAt: string;
  effectiveDate: string | null;
  action: string;
  changes: { field: string; before: unknown; after: unknown; masked: boolean }[];
}

/** DF16 History: what changed, from what to what; a protected value reads "Protected", as the server sends it. */
function HistoryRows({ rows }: { rows: HistoryRow[] }) {
  return (
    <table>
      <thead>
        <tr>
          <th>When</th>
          <th>Change</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            <td>{formatDate(r.effectiveDate ?? r.occurredAt)}</td>
            <td>{words(r.action)}</td>
            <td>
              {r.changes.map((c) => (
                <div key={c.field}>
                  {c.field}: {format(c.before)} → {format(c.after)}
                </div>
              ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface AppraisalGoals {
  cycleCode: string;
  cycleName: string;
  state: string;
  taskStatus: string;
  goals: Record<string, unknown>[];
  /** I-89 item 4: the competencies copied into the appraisal (name, weight, completion flags); none when the cycle does not assess them. */
  competencies?: Record<string, unknown>[];
}

function GoalRows({ rows }: { rows: AppraisalGoals[] }) {
  return (
    <>
      {rows.map((a) => (
        <div key={a.cycleCode}>
          <p>
            {a.cycleName} ({a.cycleCode}) <StateBadge state={a.taskStatus} />
          </p>
          {a.goals.length === 0 ? <Empty>No goals set yet.</Empty> : <SimpleTable rows={a.goals} />}
          {!!a.competencies?.length && (
            <div aria-label={`Competencies of ${a.cycleCode}`}>
              <h4>Competencies</h4>
              <SimpleTable rows={a.competencies} />
            </div>
          )}
        </div>
      ))}
    </>
  );
}

function TabSectionView({ name, section }: { name: string; section: TabSection }) {
  if (!section.available) return <p className="hint">{section.message}</p>;
  if (section.items.length === 0) return <Empty>Nothing recorded yet.</Empty>;
  return name === 'goals' ? <GoalRows rows={section.items as unknown as AppraisalGoals[]} /> : <SimpleTable rows={section.items.map(flatRow)} />;
}

/** FR-095: only the tabs and sections the server returned are shown; an empty one says so, and one with no source says that. */
export function TeamMemberPage() {
  const { id } = useParams();
  const detail = useQuery({ queryKey: ['member', id], queryFn: () => api<{ tabs: Record<string, Tab> }>(`/v1/my-team/${id}`) });
  return (
    <>
      <Link to="/team">← My team</Link>
      {Object.entries(detail.data?.tabs ?? {}).map(([key, tab]) => (
        <Section key={key} title={TAB_TITLES[key] ?? key}>
          {tab.items && tab.items.length === 0 && <Empty>Nothing recorded yet.</Empty>}
          {tab.items && tab.items.length > 0 && (key === 'history' ? <HistoryRows rows={tab.items as unknown as HistoryRow[]} /> : <SimpleTable rows={tab.items} />)}
          {tab.data !== undefined && <KeyValues value={tab.data} />}
          {Object.entries(tab.sections ?? {}).map(([name, section]) => (
            <div key={name}>
              <h3>{SECTION_TITLES[name] ?? name}</h3>
              <TabSectionView name={name} section={section} />
              {name === 'documents' && section.available && section.items.length > 0 && <Link to={`/employees/${id}/documents`}>Open documents</Link>}
            </div>
          ))}
        </Section>
      ))}
      <ErrorNote error={detail.error} />
    </>
  );
}

export function SimpleTable({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = Object.keys(rows[0] ?? {});
  return (
    <table>
      <thead>
        <tr>
          {columns.map((c) => (
            <th key={c}>{c}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {columns.map((c) => (
              <td key={c}>{format(r[c])}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function format(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return formatDate(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function KeyValues({ value }: { value: unknown }) {
  if (!value || typeof value !== 'object') return <Empty>Nothing recorded yet.</Empty>;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.items)) return <SimpleTable rows={obj.items as Record<string, unknown>[]} />;
  return (
    <dl className="kv">
      {Object.entries(obj).map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{format(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The columns GET /v1/employees and the employee register sort by (employee/service.ts). */
type EmployeeSort = 'employeeCode' | 'displayName' | 'department' | 'location' | 'designation' | 'joiningDate' | 'status';

/** The list's filters, in the address so a dashboard figure opens the list with its own (DF17); the export holds the same (FR-007, I-37). */
const EMPLOYEE_FILTERS = ['status', 'statusGroup', 'departmentId', 'joinedFrom', 'joinedTo'] as const;
/** DF04's lifecycle states, which the list takes as `status`. */
const EMPLOYEE_STATUSES = [
  { code: 'DRAFT', label: 'Draft' },
  { code: 'ACTIVE_PROBATION', label: 'Active (probation)' },
  { code: 'ACTIVE_CONFIRMED', label: 'Active (confirmed)' },
  { code: 'NOTICE', label: 'Notice' },
  { code: 'INACTIVE_SEPARATED', label: 'Separated' },
  { code: 'ARCHIVED', label: 'Archived' },
] as const;
/** A choice that stands for a `statusGroup`, a named set of statuses, rather than one status. */
const GROUP_CHOICE = 'statusGroup:';
/** `statusGroup=ACTIVE`, the set a dashboard's "Active employees" figure counts (DF17). */
const ACTIVE_GROUP = { code: 'ACTIVE', label: 'Active (probation, confirmed or notice)' } as const;
/**
 * BR-003 / FR-006's reference views (I-82 item 3), which the list also takes as `statusGroup`. They are views over DF04's states,
 * not stored statuses, and may overlap: an employee on notice is both Current and On notice. The server decides who is in each.
 */
const EMPLOYEE_VIEWS = [
  { code: 'CURRENT', label: 'Current (probation, confirmed or notice)' },
  { code: 'OFFERED', label: 'Offered (pre-joining, not yet activated)' },
  { code: 'OFFERED_REJECTED', label: 'Offered, rejected (closed before joining)' },
  { code: 'ON_PROBATION', label: 'On probation' },
  { code: 'ON_NOTICE', label: 'On notice' },
  { code: 'LEFT', label: 'Left' },
] as const;
const STATUS_GROUPS: readonly { code: string; label: string }[] = [ACTIVE_GROUP, ...EMPLOYEE_VIEWS];
/** The views beside which offers still with the candidate, or declined, are found in Hiring rather than here. */
const OFFER_VIEWS: readonly string[] = ['OFFERED', 'OFFERED_REJECTED'];
/** Hiring's offer list (hiring-pipeline.tsx), under its own read duty. */
const HIRING_OFFERS = '/hiring/offers';
const OFFER_READ = 'offer.read.operational';
/** FR-007 exports of the record sections (I-82 item 2): confidential, under their own duty, with the list's own filters. */
const SECTION_EXPORT = 'employee.export.private';
const ORG_MASTER_READ = 'org_master.read.operational';

/** A report of this list (FR-007): asked for with exactly the filters and order the list was asked for. */
const useListReport = (reportCode: string, filters: Record<string, string>) => useMutation({ mutationFn: () => api<{ id: string }>('/v1/reports', { body: { reportCode, filters } }) });

export function EmployeesPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ column: EmployeeSort; direction: 'ASC' | 'DESC' }>({ column: 'employeeCode', direction: 'ASC' });
  const filters = Object.fromEntries(EMPLOYEE_FILTERS.flatMap((k) => (params.get(k) ? [[k, params.get(k)!]] : []))) as Partial<Record<(typeof EMPLOYEE_FILTERS)[number], string>>;
  // FR-007 "List and export use identical filters": both are built from this one object; the server refuses a reversed range on both.
  const listFilters: Record<string, string> = { ...filters, ...(search ? { search } : {}), ...sortParams(sort) };
  const list = useQuery({
    queryKey: ['employees', listFilters, page],
    queryFn: () =>
      api<{ items: { id: string; employeeCode: string; displayName: string; status: string; assignment: { departmentName: string; locationName: string; designationName: string } | null; joiningDate: string }[]; total: number }>(
        `/v1/employees?${new URLSearchParams({ ...listFilters, page: String(page), pageSize: '25' }).toString()}`,
      ),
  });
  const departmentChoices = can(ORG_MASTER_READ);
  // Inactive departments too: history keeps them, and the list can still be asked who was on one (FR-004).
  const departments = useQuery({
    queryKey: ['employee-filter-departments'],
    enabled: departmentChoices,
    queryFn: () => api<{ items: { id: string; code: string; name: string; active: boolean }[] }>('/v1/org/departments?includeInactive=true'),
  });
  const exportList = useListReport('EMPLOYEE_REGISTER', listFilters);
  const exportFamily = useListReport('EMPLOYEE_FAMILY', listFilters);
  const exportQualifications = useListReport('EMPLOYEE_QUALIFICATIONS', listFilters);
  const exportPriorEmployment = useListReport('EMPLOYEE_PRIOR_EMPLOYMENT', listFilters);
  const sectionExports = [
    { label: 'Export family details', request: exportFamily },
    { label: 'Export qualifications', request: exportQualifications },
    { label: 'Export prior employment', request: exportPriorEmployment },
  ];
  const exports = [exportList, exportFamily, exportQualifications, exportPriorEmployment];
  // A changed list starts again at its first page, and "Requested" no longer describes it.
  const listChanged = () => {
    setPage(1);
    for (const request of exports) request.reset();
  };
  const setFilters = (changes: Partial<Record<(typeof EMPLOYEE_FILTERS)[number], string>>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next);
    listChanged();
  };
  const onSort = (column: EmployeeSort) => {
    setSort((current) => nextSort(current, column));
    listChanged();
  };
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));
  // Either document grant reaches the documents page: reading lists them, uploading adds one (FR-010).
  const documents = can('document.read.document') || can('document.upload.document');
  const statusChoice = filters.status ?? (filters.statusGroup ? `${GROUP_CHOICE}${filters.statusGroup}` : '');
  const groupLabel = (code: string) => STATUS_GROUPS.find((g) => g.code === code)?.label ?? words(code);
  const exportButton = (label: string, request: typeof exportList) => (
    <span key={label}>
      <button className="secondary" disabled={request.isPending} onClick={() => request.mutate()}>
        {label}
      </button>{' '}
      {request.isSuccess && (
        <span className="hint">
          Requested. Download it from <Link to="/reports">Reports</Link>.
        </span>
      )}{' '}
    </span>
  );
  return (
    <Section title={`Employees${list.data ? ` (${list.data.total})` : ''}`}>
      <div className="grid-form">
        <label className="inline">
          Search{' '}
          <input
            maxLength={100}
            value={search}
            placeholder="Name, code, email or extension"
            onChange={(e) => {
              setSearch(e.target.value);
              listChanged();
            }}
          />
        </label>
        <label className="inline">
          Status{' '}
          <select
            value={statusChoice}
            onChange={(e) =>
              setFilters(e.target.value.startsWith(GROUP_CHOICE) ? { status: '', statusGroup: e.target.value.slice(GROUP_CHOICE.length) } : { status: e.target.value, statusGroup: '' })
            }
          >
            <option value="">All</option>
            <option value={`${GROUP_CHOICE}${ACTIVE_GROUP.code}`}>{ACTIVE_GROUP.label}</option>
            <optgroup label="Views">
              {EMPLOYEE_VIEWS.map((v) => (
                <option key={v.code} value={`${GROUP_CHOICE}${v.code}`}>
                  {v.label}
                </option>
              ))}
              {filters.statusGroup && !filters.status && !STATUS_GROUPS.some((g) => g.code === filters.statusGroup) && (
                <option value={`${GROUP_CHOICE}${filters.statusGroup}`}>{words(filters.statusGroup)}</option>
              )}
            </optgroup>
            <optgroup label="Statuses">
              {EMPLOYEE_STATUSES.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.label}
                </option>
              ))}
              {filters.status && !EMPLOYEE_STATUSES.some((s) => s.code === filters.status) && <option value={filters.status}>{words(filters.status)}</option>}
            </optgroup>
          </select>
        </label>
        {departmentChoices && (
          <label className="inline">
            Department{' '}
            <select value={filters.departmentId ?? ''} onChange={(e) => setFilters({ departmentId: e.target.value })}>
              <option value="">All</option>
              {departments.data?.items.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                  {d.active ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="inline">
          Joined from <input type="date" value={filters.joinedFrom ?? ''} onChange={(e) => setFilters({ joinedFrom: e.target.value })} />
        </label>
        <label className="inline">
          Joined to <input type="date" value={filters.joinedTo ?? ''} onChange={(e) => setFilters({ joinedTo: e.target.value })} />
        </label>
      </div>
      {filters.statusGroup && (
        <p className="hint">
          Status: {groupLabel(filters.statusGroup)}{' '}
          <button className="secondary" onClick={() => setFilters({ status: '', statusGroup: '' })}>
            Clear
          </button>
        </p>
      )}
      {!departmentChoices && (
        <p className="hint">
          Your role cannot read the department list, so it cannot choose a department here.{' '}
          {filters.departmentId && (
            <button className="secondary" onClick={() => setFilters({ departmentId: '' })}>
              Clear the department filter
            </button>
          )}
        </p>
      )}
      <ErrorNote error={departments.error} />
      <table>
        <thead>
          <tr>
            <SortHeader column="employeeCode" label="Code" sort={sort} onSort={onSort} />
            <SortHeader column="displayName" label="Name" sort={sort} onSort={onSort} />
            <SortHeader column="department" label="Department" sort={sort} onSort={onSort} />
            <SortHeader column="location" label="Location" sort={sort} onSort={onSort} />
            <SortHeader column="designation" label="Designation" sort={sort} onSort={onSort} />
            <SortHeader column="joiningDate" label="Joined" sort={sort} onSort={onSort} />
            <SortHeader column="status" label="Status" sort={sort} onSort={onSort} />
            {documents && <th />}
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((e) => (
            <tr key={e.id}>
              <td>{e.employeeCode}</td>
              <td>{can('employee.read.operational') ? <Link to={`/employees/${e.id}`}>{e.displayName}</Link> : e.displayName}</td>
              <td>{e.assignment?.departmentName ?? '—'}</td>
              <td>{e.assignment?.locationName ?? '—'}</td>
              <td>{e.assignment?.designationName ?? '—'}</td>
              <td>{formatDate(e.joiningDate)}</td>
              <td>
                <StateBadge state={e.status} />
              </td>
              {documents && (
                <td>
                  <Link to={`/employees/${e.id}/documents`}>Documents</Link>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Next
        </button>
      </div>
      {filters.statusGroup && !filters.status && OFFER_VIEWS.includes(filters.statusGroup) && can(OFFER_READ) && (
        <p className="hint">
          Offers still awaiting the candidate’s answer, and offers the candidate declined, are candidates rather than employee records: they stay in Hiring’s{' '}
          <Link to={HIRING_OFFERS}>offer list</Link>.
        </p>
      )}
      {(can('employee.export.operational') || can(SECTION_EXPORT)) && (
        <p>
          {can('employee.export.operational') && exportButton('Export this list', exportList)}
          {can(SECTION_EXPORT) && sectionExports.map((s) => exportButton(s.label, s.request))}
        </p>
      )}
      <ErrorNote error={list.error ?? exports.find((request) => request.error)?.error} />
    </Section>
  );
}
