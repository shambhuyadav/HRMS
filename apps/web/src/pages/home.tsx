import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, formatDate } from '../api';
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
  status: 'OK' | 'NOT_CONFIGURED' | 'NOT_AVAILABLE';
  value?: number | string;
  message?: string;
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
            {w.status === 'OK' && <div className="widget-value">{w.source ? <Link to={w.source.href}>{String(w.value)}</Link> : String(w.value)}</div>}
            {w.status === 'NOT_CONFIGURED' && <div className="widget-note">{w.message}</div>}
            {w.status === 'NOT_AVAILABLE' && <div className="widget-note">Not available yet</div>}
          </div>
        ))}
      </div>
      {d?.state === 'OK' && <PendingTasks />}
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
          Search <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code or email" />
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

type EmployeeSort = 'employeeCode' | 'displayName' | 'department' | 'joiningDate' | 'status';

export function EmployeesPage() {
  const { can } = useSession();
  const [params, setParams] = useSearchParams();
  // DF17: a dashboard figure opens this list with its own status filter.
  const status = params.get('status');
  const statusGroup = params.get('statusGroup');
  const statusFilter = `${status ? `&status=${encodeURIComponent(status)}` : ''}${statusGroup ? `&statusGroup=${encodeURIComponent(statusGroup)}` : ''}`;
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{ column: EmployeeSort; direction: 'ASC' | 'DESC' }>({ column: 'employeeCode', direction: 'ASC' });
  const list = useQuery({
    queryKey: ['employees', search, statusFilter, page, sort],
    queryFn: () =>
      api<{ items: { id: string; employeeCode: string; displayName: string; status: string; assignment: { departmentName: string } | null; joiningDate: string }[]; total: number }>(
        `/v1/employees?page=${page}&pageSize=25&sort=${sort.column}&direction=${sort.direction}${search ? `&search=${encodeURIComponent(search)}` : ''}${statusFilter}`,
      ),
  });
  const onSort = (column: EmployeeSort) => {
    setSort((current) => nextSort(current, column));
    setPage(1);
  };
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));
  // Either document grant reaches the documents page: reading lists them, uploading adds one (FR-010).
  const documents = can('document.read.document') || can('document.upload.document');
  return (
    <Section title={`Employees${list.data ? ` (${list.data.total})` : ''}`}>
      <label className="inline">
        Search{' '}
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </label>
      {(status || statusGroup) && (
        <p className="hint">
          Status: {words(status ?? statusGroup ?? '')}{' '}
          <button
            className="secondary"
            onClick={() => {
              setParams(new URLSearchParams());
              setPage(1);
            }}
          >
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
            <SortHeader column="joiningDate" label="Joined" sort={sort} onSort={onSort} />
            <SortHeader column="status" label="Status" sort={sort} onSort={onSort} />
            {documents && <th />}
          </tr>
        </thead>
        <tbody>
          {list.data?.items.map((e) => (
            <tr key={e.id}>
              <td>{e.employeeCode}</td>
              <td>{e.displayName}</td>
              <td>{e.assignment?.departmentName ?? '—'}</td>
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
      <ErrorNote error={list.error} />
    </Section>
  );
}
