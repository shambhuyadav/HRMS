// Employee History (FR-089; BR-038; DF14): one dated history of an employment, from joining to separation, with who did what
// and the decision behind it, and the approved assignment, manager, status and salary on a chosen date. A correction is a
// further event, never a rewritten one. The server leaves out salary and increment events and decision reasons the selected
// role has no grant for, so this page shows what it is sent and says when salary is withheld. The server re-checks everything.
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';

const READ_HISTORY = 'employee.read_history.operational';
const EMPLOYEE_LIST = 'employee.list.operational';
const EXIT_READ = 'exit.read.operational';
const CONFIRMATION_READ = 'confirmation.read.operational';

export interface TimelineEvent {
  category: string;
  type: string;
  effectiveDate: string;
  recordedAt: string;
  actor: string | null;
  /** The account a delegated approval decision was taken for (C4; I-57 item 7); null or absent otherwise. */
  onBehalfOf?: string | null;
  reason: string | null;
  source: { kind: string; id: string; decisionId?: string | null } | null;
  details: Record<string, unknown>;
}

export interface AsOfView {
  date: string;
  status: string | null;
  assignment: { department: string; location: string; designation: string; grade: string | null } | null;
  manager: { code: string; name: string } | null;
  salary?: { annualCtc: string; monthlyGross: string; currency: string } | null;
}

export interface Timeline {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  salaryShown: boolean;
  events: TimelineEvent[];
  asOf?: AsOfView;
}

const CATEGORIES: Readonly<Record<string, string>> = {
  JOINING: 'Joining',
  STATUS: 'Status',
  CONFIRMATION: 'Confirmation',
  ORGANISATION: 'Organisation',
  MANAGER: 'Manager',
  MASTER: 'Record change',
  SALARY: 'Salary',
  INCREMENT: 'Increment',
  EXIT: 'Exit',
};

const EVENTS: Readonly<Record<string, string>> = {
  JOINED: 'Joined',
  JOINING_DATE_CORRECTED: 'Joining date corrected',
  ACTIVATION: 'Activated',
  DRAFT_CLOSED: 'Draft closed',
  DIRECT: 'Status changed',
  CONFIRMED: 'Confirmed',
  EXTENDED: 'Probation extended',
  ASSIGNED: 'Assigned',
  ASSIGNMENT_CHANGED: 'Assignment changed',
  MANAGER_SET: 'Manager set',
  MANAGER_CHANGED: 'Manager changed',
  MANAGER_REMOVED: 'Manager removed',
  MASTER_UPDATED: 'Employee record changed',
  SALARY_SET: 'Salary set',
  INCREMENT_APPLIED: 'Increment applied',
  INCREMENT_CORRECTED: 'Increment corrected',
  EXIT_APPROVED: 'Exit approved',
  EXIT_WITHDRAWN: 'Exit withdrawn',
  SEPARATION: 'Separated',
};

const readable = (code: string | null | undefined) => (code ? code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ') : '—');

type Org = { department: string; location: string; designation: string; grade: string | null };
const orgText = (o: Org) => [o.department, o.location, o.designation, o.grade].filter(Boolean).join(', ');
const person = (p: { name: string; code: string }) => `${p.name} (${p.code})`;

/** The facts of one event, in words. Amounts are present only if the server sent them. */
function detailText(e: TimelineEvent): string {
  const d = e.details;
  switch (e.type) {
    case 'JOINED':
      return d.priorEmployeeCode ? `Follows the earlier employment ${String(d.priorEmployeeCode)}` : '';
    case 'JOINING_DATE_CORRECTED':
      return `From ${formatDate(String(d.priorDate))} to ${formatDate(String(d.newDate))}`;
    case 'EXTENDED':
      return `Due date moved from ${formatDate(String(d.priorDueDate))} to ${formatDate(String(d.newDueDate))}`;
    case 'ASSIGNED':
      return orgText(d.to as Org);
    case 'ASSIGNMENT_CHANGED':
      return `${orgText(d.from as Org)} to ${orgText(d.to as Org)}`;
    case 'MANAGER_SET':
      return person(d.to as { name: string; code: string });
    case 'MANAGER_CHANGED':
      return `${person(d.from as { name: string; code: string })} to ${person(d.to as { name: string; code: string })}`;
    case 'MANAGER_REMOVED':
      return `Was ${person(d.from as { name: string; code: string })}`;
    case 'MASTER_UPDATED':
      return `Changed: ${(d.fields as string[]).join(', ')}`;
    case 'SALARY_SET':
      return `Monthly gross ${String(d.monthlyGross)}, annual CTC ${String(d.annualCtc)} ${String(d.currency)}${d.superseded ? ' (replaced by a correction, never in force)' : ''}`;
    case 'INCREMENT_APPLIED':
    case 'INCREMENT_CORRECTED':
      return `${String(d.beforeAmount)} to ${String(d.afterAmount)} ${String(d.currency)}, ${d.changePercent === null ? `no percentage (${readable(String(d.percentNaReason)).toLowerCase()})` : `${String(d.changePercent)}%`}${d.supersededByCaseId ? ' (replaced by a correction)' : ''}`;
    case 'EXIT_APPROVED':
      return d.lastWorkingDate ? `Last working date ${formatDate(String(d.lastWorkingDate))}` : '';
    default:
      return d.status ? `${readable(String(d.priorStatus ?? '')).replace('—', 'New')} to ${readable(String(d.status))}`.toLowerCase().replace(/^./, (c) => c.toUpperCase()) : '';
  }
}

function SourceLink({ event }: { event: TimelineEvent }) {
  const { can } = useSession();
  const s = event.source;
  if (!s) return <>—</>;
  if (s.kind === 'EXIT_CASE' && can(EXIT_READ)) return <Link to={`/lifecycle/exits/${s.id}`}>Exit case</Link>;
  if (s.kind === 'CONFIRMATION_CASE' && can(CONFIRMATION_READ)) return <Link to="/confirmations">Confirmation case</Link>;
  if (s.kind === 'INCREMENT_CASE') return <Link to="/increments">Increment case</Link>;
  const words: Readonly<Record<string, string>> = {
    EXIT_CASE: 'Exit case',
    CONFIRMATION_CASE: 'Confirmation case',
    AUDIT_EVENT: 'Audit record',
    HIRING_HANDOVER: 'Hiring handover',
    SALARY_ARRANGEMENT: 'Salary record',
    EMPLOYEE: 'Employee record',
  };
  return <>{words[s.kind] ?? readable(s.kind)}</>;
}

function AsOfPanel({ employeeId }: { employeeId: string }) {
  const [day, setDay] = useState('');
  const [asked, setAsked] = useState('');
  useEffect(() => setAsked(''), [employeeId]);
  const view = useQuery({
    queryKey: ['employee-timeline', employeeId, 'as-of', asked],
    queryFn: () => api<Timeline>(`/v1/employees/${employeeId}/timeline?asOf=${asked}`),
    enabled: asked !== '',
  });
  const a = view.data?.asOf;
  return (
    <Section title="On a chosen date">
      <form
        className="grid-form"
        aria-label="On a chosen date"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setAsked(day);
        }}
      >
        <label>
          Date
          <input required type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </label>
        <button type="submit" className="secondary">
          Show
        </button>
      </form>
      <ErrorNote error={view.error} />
      {a && (
        <dl aria-label={`As of ${a.date}`}>
          <dt>Status</dt>
          <dd>{readable(a.status)}</dd>
          <dt>Assignment</dt>
          <dd>{a.assignment ? orgText(a.assignment) : 'None in force'}</dd>
          <dt>Manager</dt>
          <dd>{a.manager ? person(a.manager) : 'None in force'}</dd>
          {'salary' in a && (
            <>
              <dt>Salary</dt>
              <dd>{a.salary ? `Monthly gross ${a.salary.monthlyGross}, annual CTC ${a.salary.annualCtc} ${a.salary.currency}` : 'None in force'}</dd>
            </>
          )}
        </dl>
      )}
    </Section>
  );
}

function HistoryOf({ employeeId }: { employeeId: string }) {
  const [category, setCategory] = useState('');
  const timeline = useQuery({ queryKey: ['employee-timeline', employeeId], queryFn: () => api<Timeline>(`/v1/employees/${employeeId}/timeline`) });
  if (timeline.error) return <ErrorNote error={timeline.error} />;
  if (!timeline.data) return null;
  const t = timeline.data;
  const present = [...new Set(t.events.map((e) => e.category))];
  const shown = category ? t.events.filter((e) => e.category === category) : t.events;
  return (
    <>
      <Section title={`${t.employeeName} (${t.employeeCode})`}>
        {!t.salaryShown && <p className="hint">Salary and increment events are not shown: the selected role has no salary history grant.</p>}
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All</option>
            {present.map((c) => (
              <option key={c} value={c}>
                {CATEGORIES[c] ?? readable(c)}
              </option>
            ))}
          </select>
        </label>
        {shown.length === 0 && <Empty>No events to show.</Empty>}
        {shown.length > 0 && (
          <table aria-label="Employee history">
            <thead>
              <tr>
                <th scope="col">Effective</th>
                <th scope="col">Category</th>
                <th scope="col">Event</th>
                <th scope="col">Details</th>
                <th scope="col">By</th>
                <th scope="col">Reason</th>
                <th scope="col">Source</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the server's order is the history's order, and events have no id of their own
                <tr key={`${e.type}-${e.effectiveDate}-${i}`}>
                  <td>{formatDate(e.effectiveDate)}</td>
                  <td>
                    <Badge>{CATEGORIES[e.category] ?? readable(e.category)}</Badge>
                  </td>
                  <td>{EVENTS[e.type] ?? readable(e.type)}</td>
                  <td>{detailText(e)}</td>
                  <td>
                    {e.actor ?? 'System'}
                    {e.onBehalfOf && <span className="hint">{` on behalf of ${e.onBehalfOf}`}</span>}
                  </td>
                  <td>{e.reason ?? '—'}</td>
                  <td>
                    <SourceLink event={e} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      <AsOfPanel employeeId={employeeId} />
    </>
  );
}

interface EmployeeHit {
  id: string;
  employeeCode: string;
  displayName: string;
}

function EmployeeFinder() {
  const { can } = useSession();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  const hits = useQuery({
    queryKey: ['employee-history', 'search', term],
    queryFn: () => api<{ items: EmployeeHit[]; total: number }>(`/v1/employees?${new URLSearchParams({ search: term, page: '1', pageSize: '25' }).toString()}`),
    enabled: can(EMPLOYEE_LIST) && term !== '',
  });
  if (!can(EMPLOYEE_LIST)) return <p className="hint">The selected role cannot search employees; open a history from a link instead.</p>;
  return (
    <>
      <label>
        Find the employee
        <input type="search" maxLength={100} placeholder="Name, employee code or work email" value={search} onChange={(e) => setSearch(e.target.value)} />
      </label>
      <ErrorNote error={hits.error} />
      {term !== '' && hits.data?.items.length === 0 && <Empty>No employees match “{term}”.</Empty>}
      {term !== '' && hits.data && hits.data.items.length > 0 && (
        <ul className="choices" aria-label="Matching employees">
          {hits.data.items.map((e) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => {
                  setSearch('');
                  setTerm('');
                  navigate(`/employee-history/${e.id}`);
                }}
              >
                {`${e.displayName} (${e.employeeCode})`}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function EmployeeHistoryPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <>
      <Section title="Employee history">
        <EmployeeFinder />
      </Section>
      {id && <HistoryOf key={id} employeeId={id} />}
    </>
  );
}

export const EMPLOYEE_HISTORY_SCREENS: readonly ScreenRoute[] = [
  { path: '/employee-history', title: 'Employee history', permission: READ_HISTORY, nav: true, component: EmployeeHistoryPage },
  { path: '/employee-history/:id', title: 'Employee history', permission: READ_HISTORY, nav: false, component: EmployeeHistoryPage },
];
