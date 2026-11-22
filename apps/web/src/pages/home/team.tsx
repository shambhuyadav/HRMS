// My team (DF16): the team list and one team member with their tabs.

import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { FilterBar, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { PagerButton, PagerCount, PagerRow } from '@/components/pager';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate } from '../../api';
import { placeFact, type ProfileFact, ProfileHeader, profileSubtitle } from '../../profile-header';
import { type BarSection, SectionBar } from '../../section-bar';
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
/** A date in the team list stays on one line ("3 Nov 2026", not "3 Nov" over "2026"), as it did before the move to shadcn. */
const DATE_CELL = 'whitespace-nowrap';
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
      <FilterBar>
        <FormField>
          Search <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code or email" />
        </FormField>
        <FormField>
          Department{' '}
          <NativeSelect value={filters.departmentId ?? ''} onChange={(e) => setFilter('departmentId', e.target.value)}>
            <option value="">All</option>
            {options.data?.departments?.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField>
          Location{' '}
          <NativeSelect value={filters.locationId ?? ''} onChange={(e) => setFilter('locationId', e.target.value)}>
            <option value="">All</option>
            {options.data?.locations?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
        <FormField>
          Status{' '}
          <NativeSelect value={filters.status ?? ''} onChange={(e) => setFilter('status', e.target.value)}>
            <option value="">All</option>
            <option value="ACTIVE_PROBATION">Active (probation)</option>
            <option value="ACTIVE_CONFIRMED">Active (confirmed)</option>
            <option value="NOTICE">Notice</option>
          </NativeSelect>
        </FormField>
        <FormField>
          Review due from <Input type="date" value={filters.reviewDueFrom ?? ''} onChange={(e) => setFilter('reviewDueFrom', e.target.value)} />
        </FormField>
        <FormField>
          to <Input type="date" value={filters.reviewDueTo ?? ''} onChange={(e) => setFilter('reviewDueTo', e.target.value)} />
        </FormField>
      </FilterBar>
      {filters.todayAttendance && (
        <Hint>
          Attendance today: {words(filters.todayAttendance)}{' '}
          <Button variant="outline" onClick={() => setFilter('todayAttendance', '')}>
            Clear
          </Button>
        </Hint>
      )}
      {filters.confirmationDueTo && (
        <Hint>
          Confirmation due by {formatDate(filters.confirmationDueTo)}{' '}
          <Button variant="outline" onClick={() => setFilter('confirmationDueTo', '')}>
            Clear
          </Button>
        </Hint>
      )}
      <Table>
        <TableHeader>
          <TableRow>
            <SortHeader column="employeeCode" label="Code" sort={sort} onSort={onSort} />
            <SortHeader column="displayName" label="Name" sort={sort} onSort={onSort} />
            <SortHeader column="department" label="Department" sort={sort} onSort={onSort} />
            <SortHeader column="designation" label="Designation" sort={sort} onSort={onSort} />
            <SortHeader column="location" label="Location" sort={sort} onSort={onSort} />
            <TableHead scope="col">Manager</TableHead>
            <SortHeader column="joiningDate" label="Joined" sort={sort} onSort={onSort} />
            <SortHeader column="status" label="Status" sort={sort} onSort={onSort} />
            <TableHead scope="col">Today</TableHead>
            <SortHeader column="nextReviewDate" label="Next review" sort={sort} onSort={onSort} />
          </TableRow>
        </TableHeader>
        <TableBody>
          {team.data?.items.map((m) => (
            <TableRow key={m.id}>
              <TableCell>{m.employeeCode}</TableCell>
              <TableCell>
                <Link to={`/team/${m.id}`}>{m.displayName}</Link>
              </TableCell>
              <TableCell>{m.department ?? '—'}</TableCell>
              <TableCell>{m.designation ?? '—'}</TableCell>
              <TableCell>{m.location ?? '—'}</TableCell>
              <TableCell>{m.manager ?? '—'}</TableCell>
              <TableCell className={DATE_CELL}>{formatDate(m.joiningDate)}</TableCell>
              <TableCell>
                <StateBadge state={m.status} />
              </TableCell>
              <TableCell>
                <StateBadge state={m.todayAttendance ?? 'NOT_PROCESSED'} />
              </TableCell>
              <TableCell className={DATE_CELL}>{formatDate(m.nextReviewDate)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {team.data?.items.length === 0 && <Empty>No current team members.</Empty>}
      <PagerRow>
        <PagerButton disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </PagerButton>
        <PagerCount>
          Page {page} of {pages}
        </PagerCount>
        <PagerButton disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Next
        </PagerButton>
        <FieldLabel className="font-normal text-muted-foreground">
          Rows{' '}
          <NativeSelect
            size="sm"
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
          </NativeSelect>
        </FieldLabel>
      </PagerRow>
      {can('team.export.operational') && (
        <p className="flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={exportTeam.isPending} onClick={() => exportTeam.mutate()}>
            Export this list
          </Button>{' '}
          {exportTeam.isSuccess && (
            <Hint as="span">
              Requested. Download it from <Link to="/reports">Reports</Link>.
            </Hint>
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
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead scope="col">When</TableHead>
          <TableHead scope="col">Change</TableHead>
          <TableHead scope="col">Details</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r, i) => (
          <TableRow key={i}>
            <TableCell>{formatDate(r.effectiveDate ?? r.occurredAt)}</TableCell>
            <TableCell>{words(r.action)}</TableCell>
            <TableCell>
              {r.changes.map((c) => (
                <div key={c.field}>
                  {c.field}: {format(c.before)} → {format(c.after)}
                </div>
              ))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
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
  if (!section.available) return <Hint>{section.message}</Hint>;
  if (section.items.length === 0) return <Empty>Nothing recorded yet.</Empty>;
  return name === 'goals' ? <GoalRows rows={section.items as unknown as AppraisalGoals[]} /> : <SimpleTable rows={section.items.map(flatRow)} />;
}

/** FR-095: only the tabs and sections the server returned are shown; an empty one says so, and one with no source says that. */
export function TeamMemberPage() {
  const { id } = useParams();
  const detail = useQuery({ queryKey: ['member', id], queryFn: () => api<{ tabs: Record<string, Tab> }>(`/v1/my-team/${id}`) });
  const tabs = detail.data?.tabs ?? {};
  // The header card reads the work profile and, when the server sent it, today's department and manager from the reporting history.
  const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  const profile = (tabs.workProfile?.data ?? {}) as Record<string, unknown>;
  const name = text(profile.displayName);
  const code = text(profile.employeeCode);
  const inForce = (kind: string) =>
    text(
      (tabs.employmentAndReporting?.items ?? [])
        .filter((r) => r.kind === kind && (r.effectiveTo === null || r.effectiveTo === undefined))
        .at(-1)?.detail,
    );
  const manager = inForce('MANAGER');
  const joined = text(profile.joiningDate);
  const type = text(profile.employmentType);
  const facts: ProfileFact[] = [
    ...placeFact(inForce('ASSIGNMENT'), null),
    ...(joined ? [{ icon: 'calendar' as const, text: `Joined ${formatDate(joined)}`, title: 'Date joined' }] : []),
    ...(manager ? [{ icon: 'users' as const, text: `Reports to ${manager}`, title: 'Reporting manager' }] : []),
  ];
  // The bar names each tab the server returned, in its order, in short words so they fit one line.
  const barLabels: Record<string, string> = {
    workProfile: 'Profile',
    employmentAndReporting: 'Reporting',
    attendance: 'Attendance',
    leave: 'Leave',
    skillsAndTraining: 'Training',
    goalsAndTasks: 'Goals',
    history: 'History',
    compensation: 'Compensation',
    privateInformation: 'Private',
  };
  const sections: BarSection[] = Object.keys(tabs).map((key) => ({ key, label: barLabels[key] ?? TAB_TITLES[key] ?? key, heading: TAB_TITLES[key] ?? key }));
  return (
    <>
      <BackLink to="/team">← My team</BackLink>
      {name && (
        <ProfileHeader
          name={name}
          subtitle={code ? profileSubtitle(code, null, type ? type.charAt(0) + words(type).slice(1) : null) : 'Team member'}
          status={text(profile.status)}
          facts={facts}
        />
      )}
      <SectionBar sections={sections} />
      {Object.entries(tabs).map(([key, tab]) => (
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
