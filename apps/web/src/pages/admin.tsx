import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, useMemo, useState } from 'react';
import { api, ApiError, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, nextSort, Pager, pageParams, Section, SortHeader, type SortState, sortParams, StateBadge } from '../ui';

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
          <input value={filters.resource} placeholder="e.g. employee" onChange={(e) => setFilters({ ...filters, resource: e.target.value.trim().toLowerCase() })} />
        </label>
        <label>
          Record id
          <input value={filters.recordKey} onChange={(e) => setFilters({ ...filters, recordKey: e.target.value.trim() })} />
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
                  {e.resource} <span className="hint">{e.recordKey.slice(0, 8)}</span>
                </td>
                <td>{e.action}</td>
                <td>
                  {e.actorAccountKey} {e.actingRoleCode && <span className="hint">({e.actingRoleCode})</span>}
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

// ---------------------------------------------------------------------------------------------------------
// Retention (FR-058, DF08): approved rules and holds; purge is disabled, so only a dry run is shown.
// ---------------------------------------------------------------------------------------------------------

interface Rule {
  id: string;
  resource: string;
  revision: number;
  retainDays: number;
  basisNote: string;
  state: string;
  version: number;
}
interface Hold {
  id: string;
  resource: string;
  recordKey: string | null;
  reason: string;
  state: string;
  version: number;
  requestedAt: string;
}

export function RetentionPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ['retention'] });
  const rules = useQuery({ queryKey: ['retention', 'rules'], queryFn: () => api<{ items: Rule[] }>('/v1/retention/rules') });
  const holds = useQuery({ queryKey: ['retention', 'holds'], queryFn: () => api<{ items: Hold[] }>('/v1/retention/holds') });
  const eligibility = useQuery({
    queryKey: ['retention', 'eligibility'],
    queryFn: () => api<{ rule: { retainDays: number } | null; cutoffDate: string | null; eligibleCount: number; heldCount: number; note: string }>('/v1/retention/eligibility?resource=audit_event'),
  });
  const [rule, setRule] = useState({ retainDays: '', basisNote: '' });
  const [hold, setHold] = useState({ resource: '', recordKey: '', reason: '' });
  const [releaseReason, setReleaseReason] = useState<Record<string, string>>({});
  const act = useMutation({ mutationFn: ({ path, body }: { path: string; body: object }) => api(path, { body }), onSuccess: refresh });
  const approver = can('retention.approve.operational');
  const manager = can('retention.manage.operational');

  return (
    <>
      <Section title="Retention dry run (audit trail)">
        {eligibility.data && (
          <p>
            {eligibility.data.rule
              ? `Rule: keep ${eligibility.data.rule.retainDays} days (cutoff ${formatDate(eligibility.data.cutoffDate)}). ${eligibility.data.eligibleCount} events would be eligible; ${eligibility.data.heldCount} are preserved by holds.`
              : 'No approved retention schedule: nothing is eligible.'}
          </p>
        )}
        <p className="hint">{eligibility.data?.note ?? ''}</p>
        <ErrorNote error={eligibility.error} />
      </Section>

      <Section title="Retention rules">
        {rules.data?.items.length === 0 && <Empty>No rules yet.</Empty>}
        <ul className="tasks">
          {rules.data?.items.map((r) => (
            <li key={r.id}>
              <div>
                <strong>
                  {r.resource} rev {r.revision}: keep {r.retainDays} days
                </strong>{' '}
                <StateBadge state={r.state} />
              </div>
              <div className="hint">{r.basisNote}</div>
              {r.state === 'DRAFT' && approver && (
                <div className="row">
                  <button type="button" onClick={() => act.mutate({ path: `/v1/retention/rules/${r.id}/activate`, body: { expectedVersion: r.version } })}>
                    Activate
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {manager && (
          <form
            className="grid-form"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ path: '/v1/retention/rules', body: { resource: 'audit_event', retainDays: Number(rule.retainDays), basisNote: rule.basisNote } });
              setRule({ retainDays: '', basisNote: '' });
            }}
          >
            <label>
              Keep audit events (days)
              <input type="number" min={1} max={36500} required value={rule.retainDays} onChange={(e) => setRule({ ...rule, retainDays: e.target.value })} />
            </label>
            <label className="wide">
              Basis (approved schedule reference)
              <input required maxLength={1000} value={rule.basisNote} onChange={(e) => setRule({ ...rule, basisNote: e.target.value })} />
            </label>
            <button type="submit">Propose rule</button>
          </form>
        )}
      </Section>

      <Section title="Holds">
        {holds.data?.items.length === 0 && <Empty>No holds.</Empty>}
        <ul className="tasks">
          {holds.data?.items.map((h) => (
            <li key={h.id}>
              <div>
                <strong>
                  {h.resource}
                  {h.recordKey ? ` ${h.recordKey.slice(0, 8)}` : ' (all records)'}
                </strong>{' '}
                <StateBadge state={h.state} /> <span className="hint">requested {formatDate(h.requestedAt)}</span>
              </div>
              <div className="hint">{h.reason}</div>
              {approver && h.state === 'PENDING' && (
                <div className="row">
                  <button type="button" onClick={() => act.mutate({ path: `/v1/retention/holds/${h.id}/decision`, body: { expectedVersion: h.version, decision: 'APPROVE' } })}>
                    Approve
                  </button>
                  <button type="button" className="danger" onClick={() => act.mutate({ path: `/v1/retention/holds/${h.id}/decision`, body: { expectedVersion: h.version, decision: 'REJECT' } })}>
                    Reject
                  </button>
                </div>
              )}
              {approver && h.state === 'ACTIVE' && (
                <div className="row">
                  <input aria-label="Release reason" placeholder="Release reason" value={releaseReason[h.id] ?? ''} onChange={(e) => setReleaseReason({ ...releaseReason, [h.id]: e.target.value })} />
                  <button
                    type="button"
                    className="secondary"
                    disabled={!releaseReason[h.id]?.trim()}
                    onClick={() => act.mutate({ path: `/v1/retention/holds/${h.id}/release`, body: { expectedVersion: h.version, reason: releaseReason[h.id] } })}
                  >
                    Release
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
        {manager && (
          <form
            className="grid-form"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate({ path: '/v1/retention/holds', body: { resource: hold.resource, reason: hold.reason, ...(hold.recordKey ? { recordKey: hold.recordKey } : {}) } });
              setHold({ resource: '', recordKey: '', reason: '' });
            }}
          >
            <label>
              Record kind
              <input required pattern="[a-z][a-z0-9_]*" value={hold.resource} onChange={(e) => setHold({ ...hold, resource: e.target.value.trim().toLowerCase() })} />
            </label>
            <label>
              Record id (blank = all)
              <input value={hold.recordKey} onChange={(e) => setHold({ ...hold, recordKey: e.target.value.trim() })} />
            </label>
            <label className="wide">
              Reason
              <input required maxLength={1000} value={hold.reason} onChange={(e) => setHold({ ...hold, reason: e.target.value })} />
            </label>
            <button type="submit">Request hold</button>
          </form>
        )}
        <ErrorNote error={act.error ?? rules.error ?? holds.error} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Reviewer routing (DF03): each kind's steps and the explicit HR fallback list.
// ---------------------------------------------------------------------------------------------------------

interface RoutingKind {
  kind: string;
  routingKind: string | null;
  steps: { sequence: number; permission: string; selectionRule: string; conditionCode: string | null }[];
  fallbackReviewers: { userId: string; accountKey: string; priority: number; eligible: boolean }[];
}

function FallbackEditor({ kind, current, onSaved }: { kind: string; current: RoutingKind['fallbackReviewers']; onSaved: () => void }) {
  const candidates = useQuery({
    queryKey: ['routing-candidates', kind],
    queryFn: () => api<{ items: { userId: string; accountKey: string; employeeCode: string | null; displayName: string | null }[] }>(`/v1/workflows/${kind}/candidates`),
  });
  const [selected, setSelected] = useState<string[]>(current.filter((r) => r.eligible).map((r) => r.userId));
  const save = useMutation({
    mutationFn: () => api(`/v1/workflows/${kind}/fallback-reviewers`, { method: 'PUT', body: { reviewers: selected.map((userId, i) => ({ userId, priority: i + 1 })) } }),
    onSuccess: onSaved,
  });
  const toggle = (id: string) => setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  return (
    <div className="stack">
      {candidates.data?.items.length === 0 && <Empty>Nobody currently holds the decision permission for this kind.</Empty>}
      {candidates.data?.items.map((c) => (
        <label key={c.userId} className="check">
          <input type="checkbox" checked={selected.includes(c.userId)} onChange={() => toggle(c.userId)} /> {c.displayName ?? c.accountKey}{' '}
          <span className="hint">
            {c.accountKey}
            {selected.includes(c.userId) ? ` · priority ${selected.indexOf(c.userId) + 1}` : ''}
          </span>
        </label>
      ))}
      <div className="row">
        <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          Save list
        </button>
      </div>
      <p className="hint">Priority follows the order in which reviewers are ticked.</p>
      <ErrorNote error={save.error ?? candidates.error} />
    </div>
  );
}

/** GET /v1/workflows/stranded-tasks (workflow.manage) and POST /v1/workflows/tasks/:id/reroute (workflow.reroute_task; I-84 item 1). */
const MANAGE_ROUTING = 'workflow.manage.operational';
const REROUTE_TASK = 'workflow.reroute_task.operational';

/** An open task its assignee can no longer decide (workflow/engine.ts strandedTasks): operational fields only. */
interface StrandedTask {
  taskId: string;
  kind: string;
  transactionId: string;
  ownerEmployeeId: string | null;
  ownerEmployeeCode: string | null;
  ownerName: string | null;
  assignedAt: string;
  assigneeUserId: string;
  assigneeAccountKey: string;
  step: number;
  delegationId: string | null;
}

/**
 * C4 "Changed organisation or manager" (DF03; I-57 item 3; I-84 item 1): open tasks in the caller's row scope whose assignee can no
 * longer decide them (a changed manager, scope or grant, or a delegation that ended). Nobody else sees them, and a task never moves by
 * itself. A reroute keeps the stranded task on record (superseded) and gives the same step to whoever the step's rule now selects: the
 * person rerouting never chooses the reviewer, never reroutes their own request, and gives a reason, which is audited; the new
 * assignee is told. The server decides every rule; this panel offers the action only with the reroute duty.
 */
function StrandedTasks() {
  const { can } = useSession();
  const qc = useQueryClient();
  const stranded = useQuery({ queryKey: ['stranded-tasks'], queryFn: () => api<{ items: StrandedTask[] }>('/v1/workflows/stranded-tasks') });
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);
  const reroute = useMutation({
    mutationFn: ({ task, reason }: { task: StrandedTask; reason: string }) =>
      api<{ taskId: string; supersededTaskId: string; assigneeUserId: string }>(`/v1/workflows/tasks/${encodeURIComponent(task.taskId)}/reroute`, { body: { reason } }),
    onMutate: () => setNote(null),
    onSuccess: (_r, { task }) => {
      setReasons((prev) => {
        const next = { ...prev };
        delete next[task.taskId];
        return next;
      });
      setNote(`The ${task.kind.replace(/_/g, ' ')} task${task.ownerEmployeeCode ? ` of ${task.ownerEmployeeCode}` : ''} was rerouted: a new task went to the reviewer its step now selects, and the stranded one is kept as superseded.`);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['stranded-tasks'] }),
  });
  const mayReroute = can(REROUTE_TASK);
  const items = stranded.data?.items ?? [];
  return (
    <Section title="Stranded tasks">
      <p className="hint">
        Open approval tasks in your scope that their assignee can no longer decide, for example after a change of manager, scope or role, or when the delegation they were
        assigned under ended. A task never moves by itself. Rerouting keeps it on record and gives the step to whoever its rule now selects: you never choose the reviewer, and
        you cannot reroute your own request.
        {mayReroute ? '' : ' The selected role cannot reroute tasks.'}
      </p>
      {stranded.data && items.length === 0 && <Empty>No stranded tasks in your scope.</Empty>}
      {items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table aria-label="Stranded tasks">
            <thead>
              <tr>
                <th>Request</th>
                <th>Employee</th>
                <th>Assigned to</th>
                <th>Since</th>
                {mayReroute && <th>Reroute</th>}
              </tr>
            </thead>
            <tbody>
              {items.map((t) => {
                const who = t.ownerEmployeeCode ? `${t.ownerEmployeeCode}${t.ownerName ? ` ${t.ownerName}` : ''}` : 'No employee (company-wide)';
                const reason = reasons[t.taskId] ?? '';
                return (
                  <tr key={t.taskId}>
                    <td>
                      {`${t.kind.replace(/_/g, ' ')}, step ${t.step}`} {t.delegationId && <Badge tone="warn">delegated</Badge>}
                    </td>
                    <td>{who}</td>
                    <td>{t.assigneeAccountKey}</td>
                    <td>{formatDate(t.assignedAt)}</td>
                    {mayReroute && (
                      <td>
                        <div className="row">
                          <input
                            aria-label={`Reason to reroute the task of ${who}`}
                            placeholder="Reason"
                            maxLength={500}
                            value={reason}
                            onChange={(e) => setReasons({ ...reasons, [t.taskId]: e.target.value })}
                          />
                          <button
                            type="button"
                            className="secondary"
                            disabled={!reason.trim() || reroute.isPending}
                            onClick={() => reroute.mutate({ task: t, reason: reason.trim() })}
                            aria-label={`Reroute the task of ${who}`}
                          >
                            Reroute
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      <ErrorNote error={reroute.error ?? stranded.error} />
    </Section>
  );
}

export function RoutingPage() {
  const { can } = useSession();
  return (
    <div className="stack">
      <ReviewerRouting />
      {can(MANAGE_ROUTING) && <StrandedTasks />}
    </div>
  );
}

/** Who reviews a step, in words (the permission behind it is the server's business, not the reader's). */
const RULE_WORDS: Readonly<Record<string, string>> = {
  DIRECT_MANAGER: 'the direct manager',
  HR_FALLBACK_LIST: 'the HR reviewer list',
};
const sentence = (code: string) => {
  const words = code.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * A listed reviewer by name. The routing list carries only the account; the kind's candidates (who can decide it now, the same
 * list the editor ticks from, fetched once per kind) give the person's name. One who can no longer decide is not a candidate,
 * so they keep their account key.
 */
function ReviewerName({ kind, userId, accountKey }: { kind: string; userId: string; accountKey: string }) {
  const candidates = useQuery({
    queryKey: ['routing-candidates', kind],
    queryFn: () => api<{ items: { userId: string; accountKey: string; employeeCode: string | null; displayName: string | null }[] }>(`/v1/workflows/${kind}/candidates`),
  });
  const name = candidates.data?.items.find((c) => c.userId === userId)?.displayName;
  return <span title={accountKey}>{name ?? accountKey}</span>;
}

function ReviewerRouting() {
  const qc = useQueryClient();
  const routing = useQuery({ queryKey: ['routing'], queryFn: () => api<{ items: RoutingKind[] }>('/v1/workflows') });
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <Section title="Reviewer routing">
      <ul className="tasks">
        {routing.data?.items.map((k) => (
          <li key={k.kind}>
            <div>
              <strong>{sentence(k.kind)}</strong>{' '}
              <span className="hint">{k.steps.map((s) => `Step ${s.sequence}: ${RULE_WORDS[s.selectionRule] ?? s.selectionRule.replace(/_/g, ' ').toLowerCase()}`).join(' → ')}</span>
            </div>
            {k.routingKind ? (
              <div className="hint">Uses the {k.routingKind.replace(/_/g, ' ')} fallback list.</div>
            ) : (
              <>
                <div>
                  Fallback reviewers:{' '}
                  {k.fallbackReviewers.length === 0
                    ? 'none'
                    : k.fallbackReviewers.map((r) => (
                        <Badge key={r.userId} tone={r.eligible ? 'good' : 'bad'}>
                          {r.priority}. <ReviewerName kind={k.kind} userId={r.userId} accountKey={r.accountKey} />
                          {r.eligible ? '' : ' (no longer eligible)'}
                        </Badge>
                      ))}
                </div>
                {editing === k.kind ? (
                  <FallbackEditor
                    kind={k.kind}
                    current={k.fallbackReviewers}
                    onSaved={() => {
                      setEditing(null);
                      void qc.invalidateQueries({ queryKey: ['routing'] });
                    }}
                  />
                ) : (
                  <div className="row">
                    <button type="button" className="secondary" onClick={() => setEditing(k.kind)}>
                      Edit list
                    </button>
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <ErrorNote error={routing.error} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Mobile-app link review (FR-023): independent decisions on link requests; revocation with a reason.
// ---------------------------------------------------------------------------------------------------------

interface MobileLink {
  id: string;
  employeeCode: string;
  employeeName: string;
  appAccountRef: string;
  state: string;
  replacesLinkId: string | null;
  version: number;
  requestedAt: string;
}

export function MobileLinkReviewPage() {
  const qc = useQueryClient();
  const [state, setState] = useState<'PENDING' | 'ACTIVE'>('PENDING');
  const list = useQuery({ queryKey: ['mobile-links', state], queryFn: () => api<{ items: MobileLink[] }>(`/v1/mobile-links?state=${state}`) });
  const [reason, setReason] = useState<Record<string, string>>({});
  const act = useMutation({
    mutationFn: ({ path, body }: { path: string; body: object }) => api(path, { body }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['mobile-links'] }),
  });
  return (
    <Section
      title="Mobile-app links"
      actions={
        <div className="row toggle-group">
          <button type="button" aria-pressed={state === 'PENDING'} className={state === 'PENDING' ? '' : 'secondary'} onClick={() => setState('PENDING')}>
            Waiting for review
          </button>
          <button type="button" aria-pressed={state === 'ACTIVE'} className={state === 'ACTIVE' ? '' : 'secondary'} onClick={() => setState('ACTIVE')}>
            Active
          </button>
        </div>
      }
    >
      {list.data?.items.length === 0 && <Empty>Nothing here.</Empty>}
      <ul className="tasks">
        {list.data?.items.map((l) => (
          <li key={l.id}>
            <div>
              <strong>{l.employeeName}</strong> <span className="hint">{l.employeeCode}</span> → <code>{l.appAccountRef}</code>{' '}
              {l.replacesLinkId && <Badge tone="warn">replaces the current link</Badge>} <span className="hint">requested {formatDate(l.requestedAt)}</span>
            </div>
            {l.state === 'PENDING' ? (
              <div className="row">
                <button type="button" onClick={() => act.mutate({ path: `/v1/mobile-links/${l.id}/decision`, body: { expectedVersion: l.version, decision: 'APPROVE' } })}>
                  Approve
                </button>
                <button type="button" className="danger" onClick={() => act.mutate({ path: `/v1/mobile-links/${l.id}/decision`, body: { expectedVersion: l.version, decision: 'REJECT' } })}>
                  Reject
                </button>
              </div>
            ) : (
              <div className="row">
                <input aria-label="Revocation reason" placeholder="Reason" value={reason[l.id] ?? ''} onChange={(e) => setReason({ ...reason, [l.id]: e.target.value })} />
                <button
                  type="button"
                  className="danger"
                  disabled={!reason[l.id]?.trim()}
                  onClick={() => act.mutate({ path: `/v1/mobile-links/${l.id}/revoke`, body: { expectedVersion: l.version, reason: reason[l.id] } })}
                >
                  Revoke
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="hint">You cannot decide a link you requested or one for your own employee record.</p>
      <ErrorNote error={act.error ?? list.error} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Notification rules (FR-085, FR-061; DF12; decision I-35): every revision of every rule with its wording. A change is
// a new revision effective from a future instant later than the latest one, audited with its reason; the revision it
// supersedes ends exactly then, so one revision is ever in force. Only the wording (approved placeholders only) and,
// for an optional rule, whether it sends can change: event, channel, recipients, timing and retry ceiling carry over,
// and a mandatory rule cannot be switched off. The server decides every rule; this screen only shows what it returned.
// ---------------------------------------------------------------------------------------------------------

/** GET /v1/notifications/rules and POST /v1/notifications/rules/:code/revisions (ceiling only, never a default duty). */
const MANAGE_RULES = 'notification.manage_rules.operational';

interface RuleRevision {
  id: string;
  code: string;
  revision: number;
  eventType: string;
  channel: string;
  recipientSelector: string;
  optionalEvent: boolean;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  retryCeiling: number;
  templateCode: string;
  templateRevision: number;
  subjectTemplate: string | null;
  bodyTemplate: string;
  approvedPlaceholders: string[];
  proposalReason?: string | null;
  decisionReason?: string | null;
  /** Worked out by the server: PROPOSED or REJECTED until published; then from its clock, IN_FORCE, SCHEDULED or SUPERSEDED. */
  status: string;
}

const RULE_STATUS: Record<string, { label: string; tone: 'good' | 'warn' | 'bad' | 'neutral' }> = {
  IN_FORCE: { label: 'in force', tone: 'good' },
  SCHEDULED: { label: 'scheduled', tone: 'warn' },
  SUPERSEDED: { label: 'superseded', tone: 'neutral' },
  PROPOSED: { label: 'waiting for approval', tone: 'warn' },
  REJECTED: { label: 'rejected', tone: 'bad' },
};

const TEXTAREA: CSSProperties = { font: 'inherit', padding: '0.4rem 0.5rem', border: '1px solid var(--line)', borderRadius: 6, color: 'var(--text)', resize: 'vertical' };
const pad2 = (n: number) => String(n).padStart(2, '0');

/** An instant shown as the viewer's local date and time. */
function localDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return formatDate(iso);
  return `${formatDate(iso)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

const readableCode = (code: string) => code.replace(/_/g, ' ').toLowerCase();

/** The API's refusals of a rule revision (modules/notification/rules.ts) in plain words; null for anything else. */
function revisionRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'EFFECTIVE_DATE_NOT_FUTURE':
      return 'A change takes effect from a future date and time only. Choose a later moment.';
    case 'EFFECTIVE_DATE_BEFORE_LATEST':
      return 'A change must take effect after the latest revision of this rule starts. Choose a later moment.';
    case 'MANDATORY_RULE':
      return 'This notification is mandatory and cannot be switched off.';
    case 'NO_CHANGE':
      return 'This revision changes nothing: the wording and whether the notification is sent are as they are now.';
    case 'REVISION_PENDING':
      return 'A change to this rule is already waiting for approval. It has to be decided before another can be proposed.';
    case 'PLACEHOLDER_NOT_APPROVED': {
      const placeholder = (error.details as { placeholder?: string } | undefined)?.placeholder;
      return `The wording uses ${placeholder ? `{{${placeholder}}}` : 'a placeholder'}, which is not approved for this message. Use only the approved placeholders.`;
    }
    case 'VALIDATION_FAILED':
      return 'The message cannot be blank.';
    case 'STALE_VERSION':
      return 'This rule changed since the page loaded it, so nothing was saved. It has been reloaded: check it and schedule the change again.';
    case 'NOT_FOUND':
      return 'This rule is not available in the selected company.';
    case 'FORBIDDEN':
      return 'The selected role cannot change notification rules.';
    default:
      return null;
  }
}

export function NotificationRulesPage() {
  const { can, stored } = useSession();
  const qc = useQueryClient();
  const allowed = can(MANAGE_RULES);
  // The selected company and assignment are part of the key, so one role's answer is never shown under another.
  const key = ['notification-rules', `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`] as const;
  const rules = useQuery({ queryKey: key, enabled: allowed, queryFn: () => api<{ items: RuleRevision[] }>('/v1/notifications/rules') });
  const [editing, setEditing] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<string | null>(null);
  const groups = useMemo(() => {
    const byCode = new Map<string, RuleRevision[]>();
    for (const r of rules.data?.items ?? []) byCode.set(r.code, [...(byCode.get(r.code) ?? []), r]);
    return [...byCode.entries()].map(([code, revisions]) => ({ code, revisions: [...revisions].sort((a, b) => a.revision - b.revision) }));
  }, [rules.data]);
  // An in-app rule whose email rule (CODE_EMAIL) exists in any state, proposed or rejected included, is not offered email again.
  const codes = useMemo(() => new Set(groups.map((g) => g.code)), [groups]);

  if (!allowed) {
    return (
      <Section title="Notification rules">
        <Empty>The selected role cannot change notification rules; that needs the rule-management grant.</Empty>
      </Section>
    );
  }
  return (
    <Section title="Notification rules">
      <p className="hint">
        A change is a new revision that takes effect from a future date and time once someone other than its author approves it; the revision before it then ends at that moment, so
        one revision is in force at a time. Only the wording and, for an optional notification, whether it is sent can change. The event, channel, recipients, timing and retry
        ceiling carry over unchanged.
      </p>
      {scheduled && (
        <p className="ok" role="status">
          {scheduled}
        </p>
      )}
      {rules.isPending && <p className="hint loading">Loading rules…</p>}
      <ErrorNote error={rules.error} />
      {rules.data && groups.length === 0 && <Empty>No notification rules are configured.</Empty>}
      <ul className="tasks">
        {groups.map(({ code, revisions }) => {
          // A rejected revision was never in force: the next change builds on what came before it.
          const latest = [...revisions].reverse().find((r) => r.status !== 'REJECTED') ?? revisions[revisions.length - 1]!;
          const pending = latest.status === 'PROPOSED';
          const inForce = revisions.find((r) => r.status === 'IN_FORCE');
          return (
            <li key={code} aria-label={`Rule ${code}`}>
              <div>
                <strong>{code}</strong> <Badge tone={latest.optionalEvent ? 'neutral' : 'warn'}>{latest.optionalEvent ? 'optional' : 'mandatory'}</Badge>{' '}
                {inForce && <Badge tone={inForce.active ? 'good' : 'neutral'}>{inForce.active ? 'sending now' : 'switched off now'}</Badge>}
              </div>
              <dl className="kv">
                <div>
                  <dt>Event</dt>
                  <dd>{readableCode(latest.eventType)}</dd>
                </div>
                <div>
                  <dt>Channel</dt>
                  <dd>{readableCode(latest.channel)}</dd>
                </div>
                <div>
                  <dt>Recipients</dt>
                  <dd>{readableCode(latest.recipientSelector)}</dd>
                </div>
                <div>
                  <dt>Retry ceiling</dt>
                  <dd>{latest.retryCeiling}</dd>
                </div>
              </dl>
              <table aria-label={`Revisions of ${code}`}>
                <thead>
                  <tr>
                    <th scope="col">Revision</th>
                    <th scope="col">Status</th>
                    <th scope="col">From</th>
                    <th scope="col">Until</th>
                    <th scope="col">Sent</th>
                    <th scope="col">Subject</th>
                    <th scope="col">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {revisions.map((r) => {
                    const status = RULE_STATUS[r.status] ?? { label: readableCode(r.status), tone: 'neutral' as const };
                    return (
                      <tr key={r.id}>
                        <td>
                          {r.revision} <span className="hint">wording {r.templateRevision}</span>
                        </td>
                        <td>
                          <Badge tone={status.tone}>{status.label}</Badge>
                          {r.status === 'REJECTED' && r.decisionReason ? <div className="hint">{r.decisionReason}</div> : null}
                        </td>
                        <td>{localDateTime(r.effectiveFrom)}</td>
                        <td>{localDateTime(r.effectiveTo)}</td>
                        <td>{r.active ? 'yes' : 'no (switched off)'}</td>
                        <td>{r.subjectTemplate ?? '—'}</td>
                        <td>{r.bodyTemplate}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {editing === code ? (
                <RuleRevisionForm
                  latest={latest}
                  onCancel={() => setEditing(null)}
                  onStale={() => void qc.invalidateQueries({ queryKey: key })}
                  onScheduled={(text) => {
                    setEditing(null);
                    setScheduled(text);
                    void qc.invalidateQueries({ queryKey: key });
                  }}
                />
              ) : editing === `${code}:email` ? (
                <EmailRuleForm
                  source={latest}
                  onCancel={() => setEditing(null)}
                  onProposed={(text) => {
                    setEditing(null);
                    setScheduled(text);
                    void qc.invalidateQueries({ queryKey: key });
                  }}
                />
              ) : (
                <>
                  {pending ? (
                    <p className="hint">A change is waiting for approval; it has to be decided before another can be proposed.</p>
                  ) : (
                    <div className="row">
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`Change ${code}`}
                        onClick={() => {
                          setScheduled(null);
                          setEditing(code);
                        }}
                      >
                        Change
                      </button>
                    </div>
                  )}
                  {latest.channel === 'IN_APP' && !codes.has(`${code}_EMAIL`) && (
                    <div className="row">
                      <button
                        type="button"
                        className="secondary"
                        aria-label={`Propose email for ${code}`}
                        onClick={() => {
                          setScheduled(null);
                          setEditing(`${code}:email`);
                        }}
                      >
                        Propose email
                      </button>
                    </div>
                  )}
                </>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function RuleRevisionForm({ latest, onScheduled, onStale, onCancel }: { latest: RuleRevision; onScheduled: (text: string) => void; onStale: () => void; onCancel: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [active, setActive] = useState(latest.active);
  const [subject, setSubject] = useState(latest.subjectTemplate ?? '');
  const [body, setBody] = useState(latest.bodyTemplate);
  const [reason, setReason] = useState('');
  // The datetime-local value is the viewer's local time; the API takes the instant.
  const instant = effectiveFrom ? new Date(effectiveFrom) : null;
  const validInstant = instant !== null && !Number.isNaN(instant.getTime());
  const subjectValue = subject.trim() === '' ? null : subject;
  const subjectChanged = subjectValue !== latest.subjectTemplate;
  const bodyChanged = body !== latest.bodyTemplate;
  const activeChanged = active !== latest.active;
  const save = useMutation({
    mutationFn: () =>
      api<{ revision: number; effectiveFrom: string }>(`/v1/notifications/rules/${encodeURIComponent(latest.code)}/revisions`, {
        body: {
          expectedRevision: latest.revision,
          effectiveFrom: instant!.toISOString(),
          reason: reason.trim(),
          ...(activeChanged ? { active } : {}),
          ...(subjectChanged ? { subjectTemplate: subjectValue } : {}),
          ...(bodyChanged ? { bodyTemplate: body } : {}),
        },
      }),
    onSuccess: (r) => onScheduled(`Revision ${r.revision} of ${latest.code} is waiting for approval. Once approved it takes effect from ${localDateTime(r.effectiveFrom)}.`),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onStale();
    },
  });
  const ready = validInstant && (subjectChanged || bodyChanged || activeChanged) && body.trim() !== '' && reason.trim() !== '' && !save.isPending;
  const refusal = revisionRefusal(save.error);
  return (
    <form
      className="grid-form"
      aria-label={`Change ${latest.code}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate();
      }}
    >
      <label>
        Takes effect from
        <input type="datetime-local" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      {latest.optionalEvent ? (
        <label className="check">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Send this notification
        </label>
      ) : (
        <p className="hint">Mandatory: this notification cannot be switched off.</p>
      )}
      <label className="wide">
        Subject (optional)
        <input maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="wide">
        Message
        <textarea rows={3} maxLength={1000} style={TEXTAREA} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="hint wide">
        {latest.approvedPlaceholders.length === 0
          ? 'This message has no approved placeholders.'
          : `Approved placeholders: ${latest.approvedPlaceholders.map((p) => `{{${p}}}`).join(', ')}.`}
      </p>
      <label className="wide">
        Reason for the change
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row wide">
        <button type="submit" disabled={!ready}>
          Propose change
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {save.error ? (
        refusal ? (
          <p role="alert" className="error wide">
            {refusal}
          </p>
        ) : (
          <div className="wide">
            <ErrorNote error={save.error} />
          </div>
        )
      ) : null}
    </form>
  );
}

/** The API's refusals of an email proposal (rules.ts proposeEmailRule) in plain words; the revision refusals cover the rest. */
function emailRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'EMAIL_RULE_EXISTS':
      return 'This notification already has an email rule. Change that rule instead.';
    case 'NOT_AN_IN_APP_RULE':
      return 'Email is proposed from an in-app notification only.';
    case 'CODE_TOO_LONG':
      return 'This notification’s code is too long to take an email rule.';
    default:
      return revisionRefusal(error);
  }
}

/**
 * FR-085 "configurable supported channels"; DF12: email for one event, proposed beside its in-app rule (POST
 * /v1/notifications/rules/:code/email). Like any rule change it waits for someone else to approve it, and nothing is sent until the
 * server also has email (SMTP) settings. Blank wording lets the server derive a safe subject and message from the in-app one.
 */
function EmailRuleForm({ source, onProposed, onCancel }: { source: RuleRevision; onProposed: (text: string) => void; onCancel: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reason, setReason] = useState('');
  const instant = effectiveFrom ? new Date(effectiveFrom) : null;
  const validInstant = instant !== null && !Number.isNaN(instant.getTime());
  const save = useMutation({
    mutationFn: () =>
      api<{ code: string; effectiveFrom: string }>(`/v1/notifications/rules/${encodeURIComponent(source.code)}/email`, {
        body: {
          effectiveFrom: instant!.toISOString(),
          reason: reason.trim(),
          ...(subject.trim() ? { subjectTemplate: subject.trim() } : {}),
          ...(body.trim() ? { bodyTemplate: body.trim() } : {}),
        },
      }),
    onSuccess: (r) => onProposed(`Email for ${source.code} is waiting for approval as ${r.code}. Once approved it applies from ${localDateTime(r.effectiveFrom)}; nothing is sent until email is set up on the server.`),
  });
  const ready = validInstant && reason.trim() !== '' && !save.isPending;
  const refusal = emailRefusal(save.error);
  return (
    <form
      className="grid-form"
      aria-label={`Propose email for ${source.code}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) save.mutate();
      }}
    >
      <label>
        Takes effect from
        <input type="datetime-local" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      <label className="wide">
        Email subject (optional)
        <input maxLength={150} value={subject} onChange={(e) => setSubject(e.target.value)} />
      </label>
      <label className="wide">
        Email message (optional)
        <textarea rows={3} maxLength={1000} style={TEXTAREA} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <p className="hint wide">
        Left blank, the email takes a safe subject and message from the in-app notification. Recipients, timing and retries are the in-app
        notification’s.{' '}
        {source.approvedPlaceholders.length > 0 && `Approved placeholders: ${source.approvedPlaceholders.map((p) => `{{${p}}}`).join(', ')}.`}
      </p>
      <label className="wide">
        Reason
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row wide">
        <button type="submit" disabled={!ready}>
          Propose email
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {save.error ? (
        refusal ? (
          <p role="alert" className="error wide">
            {refusal}
          </p>
        ) : (
          <div className="wide">
            <ErrorNote error={save.error} />
          </div>
        )
      ) : null}
    </form>
  );
}

// ---------------------------------------------------------------------------------------------------------
// C6 "publication and mandatory notification settings require business owner approval" (0133): someone other than the author
// publishes a proposed change before its date, or rejects it with a reason.
// ---------------------------------------------------------------------------------------------------------

const APPROVE_RULES = 'notification.approve_rules.operational';

interface RuleProposal {
  id: string;
  code: string;
  revision: number;
  version: number;
  effectiveFrom: string;
  active: boolean;
  optionalEvent: boolean;
  proposalReason: string | null;
  proposedByAccountKey: string | null;
  subjectTemplate: string | null;
  bodyTemplate: string;
  currentActive: boolean | null;
  currentSubjectTemplate: string | null;
  currentBodyTemplate: string | null;
}

function RuleProposalDecision({ proposal, onDone }: { proposal: RuleProposal; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (path: 'publish' | 'reject') =>
      api(`/v1/notifications/rules/proposals/${proposal.id}/${path}`, { body: path === 'publish' ? { expectedVersion: proposal.version } : { expectedVersion: proposal.version, reason: reason.trim() } }),
    onSuccess: onDone,
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') onDone();
    },
  });
  return (
    <div className="row">
      <button type="button" disabled={decide.isPending} aria-label={`Approve ${proposal.code}`} onClick={() => decide.mutate('publish')}>
        Approve
      </button>
      <input aria-label={`Reason for rejecting ${proposal.code}`} placeholder="Reason to reject" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button type="button" className="danger" disabled={decide.isPending || !reason.trim()} aria-label={`Reject ${proposal.code}`} onClick={() => decide.mutate('reject')}>
        Reject
      </button>
      <ErrorNote error={decide.error} />
    </div>
  );
}

export function NotificationRuleApprovalsPage() {
  const { can, stored } = useSession();
  const qc = useQueryClient();
  const allowed = can(APPROVE_RULES);
  const key = ['notification-rule-proposals', `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`] as const;
  const proposals = useQuery({ queryKey: key, enabled: allowed, queryFn: () => api<{ items: RuleProposal[] }>('/v1/notifications/rules/proposals') });
  if (!allowed) {
    return (
      <Section title="Notification rule approvals">
        <Empty>The selected role cannot approve notification rules; that needs the rule approval grant.</Empty>
      </Section>
    );
  }
  return (
    <Section title="Notification rule approvals">
      <p className="hint">A change comes into force only once someone other than its author approves it, before its date. A date that has passed cannot be approved: reject it so that a new date can be proposed.</p>
      <ErrorNote error={proposals.error} />
      {proposals.data?.items.length === 0 && <Empty>No change is waiting for approval.</Empty>}
      <ul className="tasks">
        {proposals.data?.items.map((p) => (
          <li key={p.id} aria-label={`Proposed change to ${p.code}`}>
            <div>
              <strong>{p.code}</strong> <span className="hint">revision {p.revision}, from {localDateTime(p.effectiveFrom)}, by {p.proposedByAccountKey ?? 'unknown'}</span>
            </div>
            <dl className="kv">
              <div>
                <dt>Why</dt>
                <dd>{p.proposalReason ?? '—'}</dd>
              </div>
              <div>
                <dt>Message now</dt>
                <dd>{p.currentBodyTemplate ?? '—'}</dd>
              </div>
              <div>
                <dt>Proposed message</dt>
                <dd>{p.bodyTemplate}</dd>
              </div>
              <div>
                <dt>Subject now</dt>
                <dd>{p.currentSubjectTemplate ?? '—'}</dd>
              </div>
              <div>
                <dt>Proposed subject</dt>
                <dd>{p.subjectTemplate ?? '—'}</dd>
              </div>
              {p.optionalEvent && p.active !== p.currentActive ? (
                <div>
                  <dt>Sending</dt>
                  <dd>{p.active ? 'switched on' : 'switched off'}</dd>
                </div>
              ) : null}
            </dl>
            <RuleProposalDecision proposal={p} onDone={() => void qc.invalidateQueries({ queryKey: key })} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Screens of this file offered through the registry. The other administration pages above predate it; adding them
 * to the router and menu is part of the App.tsx wiring that waits for the owner.
 */
export const ADMIN_SCREENS: ScreenRoute[] = [
  { path: '/admin/notification-rules', title: 'Notification rules', permission: MANAGE_RULES, nav: true, component: NotificationRulesPage },
  { path: '/admin/notification-rule-approvals', title: 'Notification rule approvals', permission: APPROVE_RULES, nav: true, component: NotificationRuleApprovalsPage },
];
