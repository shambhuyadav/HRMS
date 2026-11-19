// The audit trail screen (FR-058): who did what to which record and when, and the payroll trace (FR-057).
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, formatDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, nextSort, pageParams, Pager, Section, SortHeader, sortParams, type SortState, StateBadge } from '../../ui';

// ---------------------------------------------------------------------------------------------------------
// Audit trail (FR-058): who did what to which record and when. Values are never shown here (DF02).
// ---------------------------------------------------------------------------------------------------------

interface AuditEvent {
  id: string;
  occurredAt: string;
  resource: string;
  recordKey: string;
  action: string;
  actorAccountKey: string;
  actingRoleCode: string | null;
  valueGroups: string[];
  changedFields: string[];
  reasonRecorded: boolean;
}

/** A record kind, action or role code as a person reads it: "leave_request" is "Leave request", "ACCESS_DENIED" "Access denied", "HR_ADMINISTRATOR" "HR administrator". */
const codeWords = (code: string) => {
  const words = code.toLowerCase().replace(/_/g, ' ').replace(/\bhr\b/g, 'HR');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** The columns GET /v1/audit/events sorts by (audit-trail/service.ts); newest first until one is chosen. */
type AuditSort = 'occurredAt' | 'resource' | 'action' | 'actor';

export function AuditTrailPage() {
  const { can } = useSession();
  const [filters, setFilters] = useState({ resource: '', recordKey: '', from: '', to: '' });
  const [applied, setApplied] = useState(filters);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState<AuditSort>>(null);
  const onSort = (column: AuditSort) => {
    setSort((current) => nextSort(current, column));
    setPage(1);
  };
  const query = new URLSearchParams({ page: String(page), pageSize: '50', ...sortParams(sort) });
  for (const [k, v] of Object.entries(applied)) if (v) query.set(k, v);
  const events = useQuery({ queryKey: ['audit-events', applied, page, sort], queryFn: () => api<{ items: AuditEvent[]; total: number }>(`/v1/audit/events?${query.toString()}`) });
  // "Record kind" offers the kinds the trail holds, in words; without that list (a refusal or a failure) it offers "All" only.
  const kinds = useQuery({ queryKey: ['audit-resources'], queryFn: () => api<{ items: string[] }>('/v1/audit/resources') });
  // BR-026: the export holds the events shown: the same record filters and period, not just the period.
  const exportFilters = Object.fromEntries(Object.entries(applied).filter(([, v]) => v));
  const exportReport = useMutation({ mutationFn: () => api<{ id: string }>('/v1/reports', { body: { reportCode: 'AUDIT_TRAIL', filters: exportFilters } }) });
  const pages = Math.max(1, Math.ceil((events.data?.total ?? 0) / 50));

  return (
    <Section title={`Audit trail${events.data ? ` (${events.data.total})` : ''}`}>
      <form
        className="grid-form"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setApplied(filters);
        }}
      >
        <label>
          Record kind
          <select value={filters.resource} onChange={(e) => setFilters({ ...filters, resource: e.target.value })}>
            <option value="">All</option>
            {(kinds.data?.items ?? []).map((k) => (
              <option key={k} value={k}>
                {codeWords(k)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Record id
          <input value={filters.recordKey} placeholder="Optional: one record’s id" onChange={(e) => setFilters({ ...filters, recordKey: e.target.value.trim() })} />
        </label>
        <label>
          From
          <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
        </label>
        <button type="submit">Show</button>
        {can('audit.export.operational') && (
          <button type="button" className="secondary" disabled={!applied.from || !applied.to || exportReport.isPending} onClick={() => exportReport.mutate()}>
            Export these events
          </button>
        )}
      </form>
      <p className="hint">Shows who changed which record and when, with the field names involved. Values are never shown here; open the record itself where you hold access.</p>
      {exportReport.isSuccess && <p className="ok">Export requested — download it from Reports when it is ready.</p>}
      <ErrorNote error={exportReport.error} />
      {events.data?.items.length === 0 && <Empty>No audit events match.</Empty>}
      {!!events.data?.items.length && (
        <table>
          <thead>
            <tr>
              <SortHeader column="occurredAt" label="When" sort={sort} onSort={onSort} />
              <SortHeader column="resource" label="Record" sort={sort} onSort={onSort} />
              <SortHeader column="action" label="Action" sort={sort} onSort={onSort} />
              <SortHeader column="actor" label="Actor" sort={sort} onSort={onSort} />
              <th>Fields</th>
            </tr>
          </thead>
          <tbody>
            {events.data.items.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.occurredAt).toLocaleString()}</td>
                <td>
                  {codeWords(e.resource)} <span className="hint">{e.recordKey.slice(0, 8)}</span>
                </td>
                <td>{codeWords(e.action)}</td>
                <td>
                  {e.actorAccountKey} {e.actingRoleCode && <span className="hint">({codeWords(e.actingRoleCode)})</span>}
                </td>
                <td>
                  {e.changedFields.join(', ') || '—'}
                  {e.valueGroups.filter((g) => g !== 'operational').map((g) => (
                    <Badge key={g} tone="warn">
                      {g}
                    </Badge>
                  ))}
                  {e.reasonRecorded && <Badge>reason recorded</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="pager">
        <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button type="button" disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Next
        </button>
      </div>
      <ErrorNote error={events.error} />
      <PayrollTrace />
    </Section>
  );
}

interface TraceAssignment {
  id: string;
  gradeCode: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  recordedAt: string;
  recordedBy: string | null;
  changedFields: string[];
}
interface TraceRun {
  runId: string;
  revision: number;
  state: string;
  periodCode: string;
  selectedAssignmentId: string | null;
  calculatedAssignmentId: string | null;
  salaryArrangementIds: string[];
}
interface Trace {
  employee: { id: string; code: string; name: string };
  assignments: TraceAssignment[];
  runs: TraceRun[];
  total: number;
}

const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const shortId = (id: string | null) => (id ? id.slice(0, 8) : 'not recorded');

/**
 * FR-057 "trace who changed an employee grade and which payroll run used it": who recorded each assignment revision and
 * which payroll runs used it. Identifiers and dates only, never an amount; nothing here changes anything.
 */
function PayrollTrace() {
  const [input, setInput] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [page, setPage] = useState(1);
  const trace = useQuery({
    queryKey: ['audit-payroll-trace', employeeId, page],
    enabled: !!employeeId,
    queryFn: () => api<Trace>(`/v1/audit/employees/${encodeURIComponent(employeeId)}/payroll-trace?${pageParams(page)}`),
  });
  const entered = input.trim();
  const t = trace.data;
  return (
    <section aria-label="Grade and payroll trace">
      <h3>Grade and payroll trace</h3>
      <form
        className="grid-form"
        onSubmit={(e) => {
          e.preventDefault();
          setPage(1);
          setEmployeeId(entered);
        }}
      >
        <label>
          Employee id
          <input value={input} onChange={(e) => setInput(e.target.value)} />
        </label>
        <button type="submit" disabled={!UUID_FORM.test(entered)}>
          Trace
        </button>
      </form>
      <p className="hint">Who recorded each assignment and which payroll runs used it. Identifiers and dates only: amounts are never shown here.</p>
      <ErrorNote error={trace.error} />
      {t && (
        <>
          <p>
            {t.employee.name} ({t.employee.code})
          </p>
          {t.assignments.length === 0 && <Empty>No assignment is recorded for this employee.</Empty>}
          {t.assignments.length > 0 && (
            <table aria-label="Assignment revisions">
              <thead>
                <tr>
                  <th>Assignment</th>
                  <th>Grade</th>
                  <th>From</th>
                  <th>To</th>
                  <th>Changed</th>
                  <th>Recorded by</th>
                  <th>Recorded at</th>
                </tr>
              </thead>
              <tbody>
                {t.assignments.map((a) => (
                  <tr key={a.id}>
                    <td>{shortId(a.id)}</td>
                    <td>{a.gradeCode ?? '—'}</td>
                    <td>{formatDate(a.effectiveFrom)}</td>
                    <td>{a.effectiveTo ? formatDate(a.effectiveTo) : '—'}</td>
                    <td>{a.changedFields.join(', ') || '—'}</td>
                    <td>{a.recordedBy ?? '—'}</td>
                    <td>{new Date(a.recordedAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {t.runs.length === 0 && <Empty>No payroll run has used this employee.</Empty>}
          {t.runs.length > 0 && (
            <table aria-label="Payroll runs that used an assignment">
              <thead>
                <tr>
                  <th>Period</th>
                  <th>Run</th>
                  <th>Revision</th>
                  <th>State</th>
                  <th>Selected with</th>
                  <th>Calculated with</th>
                  <th>Salary arrangements</th>
                </tr>
              </thead>
              <tbody>
                {t.runs.map((r) => (
                  <tr key={r.runId}>
                    <td>{r.periodCode}</td>
                    <td>{shortId(r.runId)}</td>
                    <td>{r.revision}</td>
                    <td>
                      <StateBadge state={r.state} />
                    </td>
                    <td>{shortId(r.selectedAssignmentId)}</td>
                    <td>{shortId(r.calculatedAssignmentId)}</td>
                    <td>{r.salaryArrangementIds.map(shortId).join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Pager page={page} pageSize={LIST_PAGE_SIZE} total={t.total} onPage={setPage} label="Payroll run pages" noun="run" />
        </>
      )}
    </section>
  );
}
