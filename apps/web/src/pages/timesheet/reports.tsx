// Reports (FR-048): hours of approved time in force and utilisation, exactly as the API returns them.

import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, LIST_PAGE_SIZE, NotPermitted, pageParams, Pager, Section } from '../../ui';
import { Refusal } from './refusals';
import { type Dimension, DIMENSION_LABEL, DIMENSIONS, MASTER_READ, Problem, SCROLL, shown, TS_REPORT, useKeys } from './shared';
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
      <p className="hint">Approved time only, from the latest approved version of each timesheet. The totals add up to the lines below.</p>
      <form className="grid-form" aria-label="Hours report" onSubmit={run} noValidate>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <fieldset className="wide">
          <legend>Group by</legend>
          {DIMENSIONS.map((d) => (
            <label key={d} className="check">
              <input type="checkbox" checked={groupBy.includes(d)} onChange={() => toggle(d)} /> {DIMENSION_LABEL[d]}
            </label>
          ))}
        </fieldset>
        {masters && (
          <>
            <label>
              Project filter
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">All projects</option>
                {(shown(projects)?.items ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code}: {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Activity filter
              <select value={activityId} onChange={(e) => setActivityId(e.target.value)}>
                <option value="">All activities</option>
                {(shown(activities)?.items ?? []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code}: {a.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <div className="wide">
          <Problem text={problem} />
          <button type="submit">Show hours</button>
        </div>
      </form>
      {report.isFetching && <p className="hint loading">Loading the report…</p>}
      <Refusal error={report.error} act="report" />
      {data && (
        <>
          <p className="hint">
            {formatDate(data.from)} to {formatDate(data.to)} · basis: {data.basis === 'APPROVED' ? 'approved time in force' : readable(data.basis)}
          </p>
          {data.groups.length === 0 ? (
            <Empty>No approved time in this range.</Empty>
          ) : (
            <div style={SCROLL}>
              <table aria-label="Hours by group">
                <thead>
                  <tr>
                    {data.groupBy.map((d) => (
                      <th key={d}>{DIMENSION_LABEL[d]}</th>
                    ))}
                    <th>Hours</th>
                    <th>Minutes</th>
                    <th>Productive minutes</th>
                    <th>Lines</th>
                  </tr>
                </thead>
                <tbody>
                  {data.groups.map((g, i) => (
                    <tr key={i}>
                      {data.groupBy.map((d) => (
                        <td key={d}>{groupCell(g, d)}</td>
                      ))}
                      <td>{g.hours}</td>
                      <td>{g.minutes}</td>
                      <td>{g.productiveMinutes}</td>
                      <td>{g.lineCount}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={data.groupBy.length}>Total</th>
                    <td>{data.totals.hours}</td>
                    <td>{data.totals.minutes}</td>
                    <td>{data.totals.productiveMinutes}</td>
                    <td>{data.totals.lineCount}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
          {(data.totalGroups ?? data.groups.length) > LIST_PAGE_SIZE && <p className="hint">The total covers every group, not only the groups on this page.</p>}
          <Pager page={groupPage} pageSize={LIST_PAGE_SIZE} total={data.totalGroups ?? data.groups.length} onPage={setGroupPage} label="Hours group pages" noun="group" />
          <button type="button" className="secondary" onClick={() => setShowLines(true)} disabled={showLines}>
            Show the approved lines behind this report
          </button>
          {showLines && lines.isPending && <p className="hint loading">Loading the lines…</p>}
          <Refusal error={lines.error} act="report" />
          {showLines && shown(lines) && (
            <div style={SCROLL}>
              <table aria-label="Approved lines">
                <thead>
                  <tr>
                    <th>Work date</th>
                    <th>Employee</th>
                    <th>Project / job / activity</th>
                    <th>Revision</th>
                    <th>Minutes</th>
                    <th>Productive</th>
                  </tr>
                </thead>
                <tbody>
                  {shown(lines)!.items.map((l) => (
                    <tr key={l.id}>
                      <td>{formatDate(l.workDate)}</td>
                      <td>{l.employeeCode}</td>
                      <td>
                        {l.projectCode} / {l.jobCode} / {l.activityCode}
                      </td>
                      <td>{l.revision}</td>
                      <td>{l.minutes}</td>
                      <td>{l.productive ? 'Yes' : 'No'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {showLines && shown(lines) && (
            <Pager page={linePage} pageSize={LIST_PAGE_SIZE} total={shown(lines)!.total ?? shown(lines)!.items.length} onPage={setLinePage} label="Approved line pages" noun="line" />
          )}
        </>
      )}
    </Section>
  );
}

function UtilisationValue({ u }: { u: UtilisationItem }) {
  if (u.status === 'OK') return <>{u.utilisationPercent}%</>;
  if (u.status === 'NOT_APPLICABLE') return <>{u.display ?? 'N/A'} (no scheduled hours)</>;
  return (
    <>
      <Badge tone="warn">not configured</Badge>
      <div className="hint">
        {u.message ?? 'The scheduled hours are not known.'}
        {u.unscheduledDays !== undefined && ` (${u.unscheduledDays} working days without a shift)`}
      </div>
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
      <form className="grid-form" aria-label="Utilisation report" onSubmit={run} noValidate>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <div className="wide">
          <Problem text={problem} />
          <button type="submit">Show utilisation</button>
        </div>
      </form>
      {report.isFetching && <p className="hint loading">Loading the report…</p>}
      <Refusal error={report.error} act="report" />
      {data && (
        <>
          <p className="hint">
            Formula: {data.formula}. Schedule: {data.scheduleBasis}.
          </p>
          {data.items.length === 0 ? (
            <Empty>No employee in scope had an allocation or approved time in this range.</Empty>
          ) : (
            <div style={SCROLL}>
              <table aria-label="Utilisation by employee">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Approved minutes</th>
                    <th>Productive minutes</th>
                    <th>Scheduled minutes</th>
                    <th>Utilisation</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((u) => (
                    <tr key={u.employeeId}>
                      <td>
                        {u.employeeName} ({u.employeeCode})
                      </td>
                      <td>{u.approvedMinutes}</td>
                      <td>{u.productiveMinutes}</td>
                      <td>{u.scheduledMinutes ?? '—'}</td>
                      <td>
                        <UtilisationValue u={u} />
                      </td>
                    </tr>
                  ))}
                </tbody>
                {data.totals && (
                  <tfoot>
                    <tr>
                      <th>{`All ${data.totals.employees} employees in scope`}</th>
                      <td>{data.totals.approvedMinutes}</td>
                      <td>{data.totals.productiveMinutes}</td>
                      <td>{data.totals.scheduledMinutes ?? 'not known'}</td>
                      <td>{`${data.totals.byStatus.OK ?? 0} OK · ${data.totals.byStatus.NOT_APPLICABLE ?? 0} N/A · ${data.totals.byStatus.NOT_CONFIGURED ?? 0} not configured`}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
          <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={setPage} label="Utilisation pages" noun="employee" />
        </>
      )}
    </Section>
  );
}
