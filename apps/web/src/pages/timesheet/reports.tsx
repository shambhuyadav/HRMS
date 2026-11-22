// Reports (FR-048): hours of approved time in force and utilisation, exactly as the API returns them.

import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { CheckField, FormField, FormGrid, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, LIST_PAGE_SIZE, NotPermitted, pageParams, Pager, Section } from '../../ui';
import { Refusal } from './refusals';
import {
  type Dimension,
  DIMENSION_LABEL,
  DIMENSIONS,
  FORM_END,
  MASTER_READ,
  Problem,
  Remark,
  shown,
  TS_REPORT,
  useKeys,
  WRAPPING_BUTTON,
} from './shared';
import type { Activity, HoursGroup, HoursReport, Project, ReportLine, UtilisationItem, UtilisationReport } from './types';

// ---------------------------------------------------------------------------------------------------------
// Screen: reports (FR-048; approved time in force only; utilisation exactly as the API returns it)
// ---------------------------------------------------------------------------------------------------------
export function ReportsScreen() {
  const { can } = useSession();
  if (!can(TS_REPORT)) return <NotPermitted>The selected role cannot run timesheet reports.</NotPermitted>;
  return (
    <div className="stack">
      <HoursReportSection />
      <UtilisationSection />
    </div>
  );
}

function groupCell(g: HoursGroup, d: Dimension): string {
  const s = (k: string) => (g[k] === null || g[k] === undefined ? '' : String(g[k]));
  if (d === 'employee') return `${s('employeeName')} (${s('employeeCode')})`;
  if (d === 'project') return `${s('projectCode')}: ${s('projectName')}`;
  if (d === 'job') return `${s('jobProjectCode')} / ${s('jobCode')}: ${s('jobName')}`;
  if (d === 'activity') return `${s('activityCode')}: ${s('activityName')}`;
  return `Week of ${formatDate(s('periodStart'))}`;
}

function HoursReportSection() {
  const { can } = useSession();
  const keys = useKeys();
  const masters = can(MASTER_READ);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [groupBy, setGroupBy] = useState<Dimension[]>(['employee']);
  const [projectId, setProjectId] = useState('');
  const [activityId, setActivityId] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [showLines, setShowLines] = useState(false);
  // FR-056: the groups and the lines page separately; the totals always cover every line in scope (computed by the API).
  const [groupPage, setGroupPage] = useState(1);
  const [linePage, setLinePage] = useState(1);
  const projects = useQuery({ queryKey: keys.projectList(''), queryFn: () => api<{ items: Project[] }>('/v1/timesheet/projects'), enabled: masters, retry: retryTransient });
  const activities = useQuery({ queryKey: keys.activityList(''), queryFn: () => api<{ items: Activity[] }>('/v1/timesheet/activities'), enabled: masters, retry: retryTransient });
  const report = useQuery({
    queryKey: keys.report('hours', `${query ?? ''}#${groupPage}`),
    queryFn: () => api<HoursReport>(`/v1/timesheet-reports/hours?${query ?? ''}&${pageParams(groupPage)}`),
    enabled: query !== null,
    retry: retryTransient,
  });
  const filters = query === null ? '' : new URLSearchParams([...new URLSearchParams(query)].filter(([k]) => k !== 'groupBy')).toString();
  const lines = useQuery({
    queryKey: keys.report('lines', `${filters}#${linePage}`),
    queryFn: () => api<{ items: ReportLine[]; total?: number }>(`/v1/timesheet-reports/lines?${filters}&${pageParams(linePage)}`),
    enabled: query !== null && showLines,
    retry: retryTransient,
  });
  const run = (e: FormEvent) => {
    e.preventDefault();
    if (!from || !to || groupBy.length === 0) {
      setProblem('Enter the range and group by at least one of employee, project, job, activity or week.');
      return;
    }
    setProblem(null);
    setShowLines(false);
    setGroupPage(1);
    setLinePage(1);
    const p = new URLSearchParams({ from, to, groupBy: DIMENSIONS.filter((d) => groupBy.includes(d)).join(',') });
    if (projectId) p.set('projectId', projectId);
    if (activityId) p.set('activityId', activityId);
    setQuery(p.toString());
  };
  const toggle = (d: Dimension) => setGroupBy((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  const data = shown(report);
  return (
    <Section title="Hours">
      <Hint>Approved time only, from the latest approved version of each timesheet. The totals add up to the lines below.</Hint>
      <FormGrid aria-label="Hours report" onSubmit={run} noValidate>
        <FormField>
          From
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField>
          To
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
        <FramedFieldset legend="Group by">
          {DIMENSIONS.map((d) => (
            <CheckField key={d}>
              <input type="checkbox" checked={groupBy.includes(d)} onChange={() => toggle(d)} /> {DIMENSION_LABEL[d]}
            </CheckField>
          ))}
        </FramedFieldset>
        {masters && (
          <>
            <FormField>
              Project filter
              <NativeSelect value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">All projects</option>
                {(shown(projects)?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code}: {p.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              Activity filter
              <NativeSelect value={activityId} onChange={(e) => setActivityId(e.target.value)}>
                <option value="">All activities</option>
                {(shown(activities)?.items ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code}: {a.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
          </>
        )}
        <div className={FORM_END}>
          <Problem text={problem} />
          <Button type="submit" className="self-start">
            Show hours
          </Button>
        </div>
      </FormGrid>
      {report.isFetching && <LoadingLine>Loading the report…</LoadingLine>}
      <Refusal error={report.error} act="report" />
      {data && (
        <>
          <Hint>
            {formatDate(data.from)} to {formatDate(data.to)} · basis: {data.basis === 'APPROVED' ? 'approved time in force' : readable(data.basis)}
          </Hint>
          {data.groups.length === 0 ? <Empty>No approved time in this range.</Empty> : <HoursTable report={data} />}
          {(data.totalGroups ?? data.groups.length) > LIST_PAGE_SIZE && <Hint>The total covers every group, not only the groups on this page.</Hint>}
          <Pager page={groupPage} pageSize={LIST_PAGE_SIZE} total={data.totalGroups ?? data.groups.length} onPage={setGroupPage} label="Hours group pages" noun="group" />
          <Button type="button" variant="outline" className={cn('mt-3', WRAPPING_BUTTON)} onClick={() => setShowLines(true)} disabled={showLines}>
            Show the approved lines behind this report
          </Button>
          {showLines && lines.isPending && <LoadingLine>Loading the lines…</LoadingLine>}
          <Refusal error={lines.error} act="report" />
          {showLines && shown(lines) && <ApprovedLinesTable items={shown(lines)!.items} />}
          {showLines && shown(lines) && (
            <Pager page={linePage} pageSize={LIST_PAGE_SIZE} total={shown(lines)!.total ?? shown(lines)!.items.length} onPage={setLinePage} label="Approved line pages" noun="line" />
          )}
        </>
      )}
    </Section>
  );
}

/** The hours of each group, one column per dimension grouped by, with the totals of every group in scope below. */
function HoursTable({ report }: { report: HoursReport }) {
  return (
    <Table aria-label="Hours by group">
      <TableHeader>
        <TableRow>
          {report.groupBy.map((d) => (
            <TableHead key={d} scope="col">
              {DIMENSION_LABEL[d]}
            </TableHead>
          ))}
          <TableHead scope="col">Hours</TableHead>
          <TableHead scope="col">Minutes</TableHead>
          <TableHead scope="col">Productive minutes</TableHead>
          <TableHead scope="col">Lines</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {report.groups.map((g, i) => (
          <TableRow key={i}>
            {report.groupBy.map((d) => (
              <TableCell key={d}>{groupCell(g, d)}</TableCell>
            ))}
            <TableCell>{g.hours}</TableCell>
            <TableCell>{g.minutes}</TableCell>
            <TableCell>{g.productiveMinutes}</TableCell>
            <TableCell>{g.lineCount}</TableCell>
          </TableRow>
        ))}
      </TableBody>
      <TableFooter>
        <TableRow>
          <TableHead scope="row" colSpan={report.groupBy.length}>
            Total
          </TableHead>
          <TableCell>{report.totals.hours}</TableCell>
          <TableCell>{report.totals.minutes}</TableCell>
          <TableCell>{report.totals.productiveMinutes}</TableCell>
          <TableCell>{report.totals.lineCount}</TableCell>
        </TableRow>
      </TableFooter>
    </Table>
  );
}

/** The approved lines the hours report counts, one page at a time. */
function ApprovedLinesTable({ items }: { items: ReportLine[] }) {
  return (
    <Table aria-label="Approved lines">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Work date</TableHead>
          <TableHead scope="col">Employee</TableHead>
          <TableHead scope="col">Project / job / activity</TableHead>
          <TableHead scope="col">Revision</TableHead>
          <TableHead scope="col">Minutes</TableHead>
          <TableHead scope="col">Productive</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((l) => (
          <TableRow key={l.id}>
            <TableCell>{formatDate(l.workDate)}</TableCell>
            <TableCell>{l.employeeCode}</TableCell>
            <TableCell>
              {l.projectCode} / {l.jobCode} / {l.activityCode}
            </TableCell>
            <TableCell>{l.revision}</TableCell>
            <TableCell>{l.minutes}</TableCell>
            <TableCell>{l.productive ? 'Yes' : 'No'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function UtilisationValue({ u }: { u: UtilisationItem }) {
  if (u.status === 'OK') return <>{u.utilisationPercent}%</>;
  if (u.status === 'NOT_APPLICABLE') return <>{u.display ?? 'N/A'} (no scheduled hours)</>;
  return (
    <>
      <Badge tone="warn">not configured</Badge>
      <Remark>
        {u.message ?? 'The scheduled hours are not known.'}
        {u.unscheduledDays !== undefined && ` (${u.unscheduledDays} working days without a shift)`}
      </Remark>
    </>
  );
}

function UtilisationSection() {
  const keys = useKeys();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [query, setQuery] = useState<string | null>(null);
  // FR-056: the employees page; the totals always cover every employee in scope (computed by the API).
  const [page, setPage] = useState(1);
  const report = useQuery({
    queryKey: keys.report('utilisation', `${query ?? ''}#${page}`),
    queryFn: () => api<UtilisationReport>(`/v1/timesheet-reports/utilisation?${query ?? ''}&${pageParams(page)}`),
    enabled: query !== null,
    retry: retryTransient,
  });
  const run = (e: FormEvent) => {
    e.preventDefault();
    if (!from || !to) {
      setProblem('Enter the range.');
      return;
    }
    setProblem(null);
    setQuery(new URLSearchParams({ from, to }).toString());
    setPage(1);
  };
  const data = shown(report);
  return (
    <Section title="Utilisation">
      <FormGrid aria-label="Utilisation report" onSubmit={run} noValidate>
        <FormField>
          From
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </FormField>
        <FormField>
          To
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </FormField>
        <div className={FORM_END}>
          <Problem text={problem} />
          <Button type="submit" className="self-start">
            Show utilisation
          </Button>
        </div>
      </FormGrid>
      {report.isFetching && <LoadingLine>Loading the report…</LoadingLine>}
      <Refusal error={report.error} act="report" />
      {data && (
        <>
          <Hint>
            Formula: {data.formula}. Schedule: {data.scheduleBasis}.
          </Hint>
          {data.items.length === 0 ? <Empty>No employee in scope had an allocation or approved time in this range.</Empty> : <UtilisationTable report={data} />}
          <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={setPage} label="Utilisation pages" noun="employee" />
        </>
      )}
    </Section>
  );
}

/** Each employee's utilisation exactly as the API returns it, with the totals of every employee in scope below. */
function UtilisationTable({ report }: { report: UtilisationReport }) {
  const totals = report.totals;
  return (
    <Table aria-label="Utilisation by employee">
      <TableHeader>
        <TableRow>
          <TableHead scope="col">Employee</TableHead>
          <TableHead scope="col">Approved minutes</TableHead>
          <TableHead scope="col">Productive minutes</TableHead>
          <TableHead scope="col">Scheduled minutes</TableHead>
          <TableHead scope="col">Utilisation</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {report.items.map((u) => (
          <TableRow key={u.employeeId}>
            <TableCell>
              {u.employeeName} ({u.employeeCode})
            </TableCell>
            <TableCell>{u.approvedMinutes}</TableCell>
            <TableCell>{u.productiveMinutes}</TableCell>
            <TableCell>{u.scheduledMinutes ?? '—'}</TableCell>
            <TableCell>
              <UtilisationValue u={u} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
      {totals && (
        <TableFooter>
          <TableRow>
            <TableHead scope="row">{`All ${totals.employees} employees in scope`}</TableHead>
            <TableCell>{totals.approvedMinutes}</TableCell>
            <TableCell>{totals.productiveMinutes}</TableCell>
            <TableCell>{totals.scheduledMinutes ?? 'not known'}</TableCell>
            <TableCell>{`${totals.byStatus.OK ?? 0} OK · ${totals.byStatus.NOT_APPLICABLE ?? 0} N/A · ${totals.byStatus.NOT_CONFIGURED ?? 0} not configured`}</TableCell>
          </TableRow>
        </TableFooter>
      )}
    </Table>
  );
}
