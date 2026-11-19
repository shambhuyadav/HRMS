// My team (DF16): the team list and one team member with their tabs.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, nextSort, Section, SortHeader, type SortState, sortParams, StateBadge } from '../../ui';
import { flatRow, format, SimpleTable, words } from './shared';

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
              <td className="nowrap">{formatDate(m.joiningDate)}</td>
              <td>
                <StateBadge state={m.status} />
              </td>
              <td>
                <StateBadge state={m.todayAttendance ?? 'NOT_PROCESSED'} />
              </td>
              <td className="nowrap">{formatDate(m.nextReviewDate)}</td>
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
      <Link className="back-link" to="/team">← My team</Link>
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
