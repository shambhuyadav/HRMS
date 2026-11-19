// Resource allocations (FR-046): the list, a new allocation, its change and its cancellation.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, Notice, NotPermitted, pageParams, Pager, Section, StateBadge, When } from '../../ui';
import { EmployeeField, JobField } from './fields';
import { ReadProblem, Refusal } from './refusals';
import { ALLOC_MANAGE, ALLOC_READ, FLUSH, H3, PERCENT, Problem, SCROLL, shown, TEXTAREA, useKeys } from './shared';
import type { Allocation } from './types';

// ---------------------------------------------------------------------------------------------------------
// Screen: resource allocations (FR-046)
// ---------------------------------------------------------------------------------------------------------
export function AllocationsScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const [state, setState] = useState('ACTIVE');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const query = new URLSearchParams(Object.entries({ state, from, to }).filter(([, v]) => v !== '')).toString();
  // FR-056: one page at a time (back to the first page when a filter changes); `total` counts every match in scope.
  const [paging, setPaging] = useState({ query, page: 1 });
  const page = paging.query === query ? paging.page : 1;
  const list = useQuery({
    queryKey: keys.allocationList(`${query}#${page}`),
    queryFn: () => api<{ items: Allocation[]; total?: number }>(`/v1/timesheet/allocations?${query ? `${query}&` : ''}${pageParams(page)}`),
    enabled: can(ALLOC_READ),
    retry: retryTransient,
  });
  if (!can(ALLOC_READ)) return <NotPermitted>The selected role cannot see resource allocations.</NotPermitted>;
  const data = shown(list);
  return (
    <div className="stack">
      <Section title="Resource allocations">
        <p className="hint">An allocation is a share of the employee’s daily capacity on a job. Overlapping jobs may total 100%; above that, only the employee’s direct manager records an exception with a reason.</p>
        <div className="row">
          <label>
            Status
            <select value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </label>
          <label>
            Overlapping from
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Overlapping to
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <ReadProblem error={list.error} what="resource allocations" />
        {list.isPending && <p className="hint loading">Loading allocations…</p>}
        {data && data.items.length === 0 && <Empty>No allocations match.</Empty>}
        {data && data.items.length > 0 && (
          <div style={SCROLL}>
            <table aria-label="Allocations">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Project and job</th>
                  <th>Interval</th>
                  <th>Allocation</th>
                  <th>Status</th>
                  <th>Over-allocation exception</th>
                  {can(ALLOC_MANAGE) && <th>Change</th>}
                </tr>
              </thead>
              <tbody>
                {data.items.map((a) => (
                  <AllocationRow key={a.id} a={a} manage={can(ALLOC_MANAGE)} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={(p) => setPaging({ query, page: p })} label="Allocation pages" noun="allocation" />}
      </Section>
      {can(ALLOC_MANAGE) && <NewAllocationForm />}
    </div>
  );
}

function AllocationRow({ a, manage }: { a: Allocation; manage: boolean }) {
  const [open, setOpen] = useState<'change' | 'cancel' | null>(null);
  return (
    <>
      <tr>
        <td>
          {a.employeeName} ({a.employeeCode})
        </td>
        <td>
          {a.projectCode} / {a.jobCode}: {a.jobName}
        </td>
        <td>
          {formatDate(a.startDate)} to {formatDate(a.endDate)}
        </td>
        <td>{a.allocationPercent}%</td>
        <td>
          <StateBadge state={a.state} />
          {a.source === 'IMPORT' && <div className="hint">imported</div>}
          {a.cancelReason && <div className="hint">Cancelled: {a.cancelReason}</div>}
        </td>
        <td>
          {a.overAllocation ? (
            <>
              Peak {a.overAllocation.peakPercent}% · recorded <When at={a.overAllocation.recordedAt} />
              <div className="hint">Reason: {a.overAllocation.reason}</div>
            </>
          ) : (
            '—'
          )}
        </td>
        {manage && (
          <td>
            {a.state === 'ACTIVE' ? (
              <div className="row">
                <button type="button" className="secondary" aria-expanded={open === 'change'} onClick={() => setOpen(open === 'change' ? null : 'change')}>
                  Change {a.employeeCode} on {a.jobCode}
                </button>
                <button type="button" className="danger" aria-expanded={open === 'cancel'} onClick={() => setOpen(open === 'cancel' ? null : 'cancel')}>
                  Cancel {a.employeeCode} on {a.jobCode}
                </button>
              </div>
            ) : (
              '—'
            )}
          </td>
        )}
      </tr>
      {manage && open && (
        <tr>
          <td colSpan={7}>{open === 'change' ? <ChangeAllocation a={a} onDone={() => setOpen(null)} /> : <CancelAllocation a={a} onDone={() => setOpen(null)} />}</td>
        </tr>
      )}
    </>
  );
}

/** The exception reason, offered once the API reports that the total would exceed 100% (or one is on record). */
function ExceptionReason({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <label className="wide">
      Over-allocation exception reason (the employee’s direct manager only)
      <textarea rows={2} maxLength={1000} value={value} onChange={(e) => onChange(e.target.value)} style={TEXTAREA} />
    </label>
  );
}

function NewAllocationForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const empty = { employee: '', project: '', job: '', start: '', end: '', percent: '', reason: '' };
  const [f, setF] = useState(empty);
  const [askReason, setAskReason] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const set = (k: keyof typeof empty) => (v: string) => setF((prev) => ({ ...prev, [k]: v }));
  const create = useMutation({
    mutationFn: (body: Record<string, string>) => api<Allocation>('/v1/timesheet/allocations', { body }),
    onSuccess: (a) => {
      setF(empty);
      setAskReason(false);
      setNotice({ text: `Allocated ${a.employeeName} (${a.employeeCode}) to ${a.projectCode} / ${a.jobCode} at ${a.allocationPercent}%.`, ok: true });
      void qc.invalidateQueries({ queryKey: keys.allocations });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'OVER_ALLOCATED') setAskReason(true);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    setNotice(null);
    const missing = [!f.employee && 'an employee', !f.job && 'a job', !f.start && 'a start date', !f.end && 'an end date', !PERCENT.test(f.percent.trim()) && 'a percentage (up to two decimals)'].filter(Boolean);
    if (missing.length > 0) {
      setProblem(`Enter ${missing.join(', ')}.`);
      create.reset();
      return;
    }
    setProblem(null);
    const reason = f.reason.trim();
    create.mutate({ employeeId: f.employee, jobId: f.job, startDate: f.start, endDate: f.end, allocationPercent: f.percent.trim(), ...(askReason && reason ? { overAllocationReason: reason } : {}) });
  };
  return (
    <Section title="New allocation">
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <h3 id={`${id}-title`} className="wide" style={H3}>
          Allocate an employee to a job
        </h3>
        <EmployeeField label="Employee" value={f.employee} onChange={set('employee')} />
        <JobField projectId={f.project} jobId={f.job} onProject={set('project')} onJob={set('job')} />
        <label>
          From
          <input type="date" value={f.start} onChange={(e) => set('start')(e.target.value)} />
        </label>
        <label>
          To
          <input type="date" value={f.end} onChange={(e) => set('end')(e.target.value)} />
        </label>
        <label>
          Allocation (%)
          <input inputMode="decimal" value={f.percent} maxLength={6} onChange={(e) => set('percent')(e.target.value)} />
        </label>
        {askReason && <ExceptionReason value={f.reason} onChange={set('reason')} />}
        <div className="wide">
          <Problem text={problem} />
          <Refusal error={create.error} act="allocation" />
          <Notice notice={notice} />
          <button type="submit" disabled={create.isPending}>
            {askReason ? 'Allocate with the exception' : 'Allocate'}
          </button>
        </div>
      </form>
    </Section>
  );
}

function ChangeAllocation({ a, onDone }: { a: Allocation; onDone: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [end, setEnd] = useState(a.endDate);
  const [percent, setPercent] = useState(a.allocationPercent);
  const [reason, setReason] = useState('');
  const [askReason, setAskReason] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Allocation>(`/v1/timesheet/allocations/${encodeURIComponent(a.id)}`, { method: 'PATCH', body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.allocations });
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'OVER_ALLOCATED') setAskReason(true);
      if (error instanceof ApiError && error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.allocations });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (save.isPending) return;
    const body: Record<string, unknown> = { expectedVersion: a.version };
    if (end !== a.endDate) body.endDate = end;
    if (percent.trim() !== a.allocationPercent) body.allocationPercent = percent.trim();
    if (askReason && reason.trim()) body.overAllocationReason = reason.trim();
    if (!PERCENT.test(percent.trim()) || !end) {
      setProblem('Enter an end date and a percentage (up to two decimals).');
      return;
    }
    if (Object.keys(body).length < 2) {
      setProblem('Change the end date or the percentage to save.');
      return;
    }
    setProblem(null);
    save.mutate(body);
  };
  return (
    <form className="grid-form" aria-label={`Change the allocation of ${a.employeeCode} on ${a.jobCode}`} onSubmit={submit} noValidate>
      <label>
        New end date
        <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
      </label>
      <label>
        New allocation (%)
        <input inputMode="decimal" value={percent} maxLength={6} onChange={(e) => setPercent(e.target.value)} />
      </label>
      {askReason && <ExceptionReason value={reason} onChange={setReason} />}
      <div className="wide">
        <Problem text={problem} />
        <Refusal error={save.error} act="allocation" />
        <div className="row">
          <button type="submit" disabled={save.isPending}>
            Save allocation
          </button>
          <button type="button" className="secondary" onClick={onDone}>
            Close
          </button>
        </div>
      </div>
    </form>
  );
}

function CancelAllocation({ a, onDone }: { a: Allocation; onDone: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: (body: { reason: string; expectedVersion: number }) => api<Allocation>(`/v1/timesheet/allocations/${encodeURIComponent(a.id)}/cancel`, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.allocations });
      onDone();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.allocations });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (cancel.isPending) return;
    if (!reason.trim()) {
      setProblem('Enter a reason to cancel the allocation.');
      return;
    }
    setProblem(null);
    cancel.mutate({ reason: reason.trim(), expectedVersion: a.version });
  };
  return (
    <form aria-label={`Cancel the allocation of ${a.employeeCode} on ${a.jobCode}`} onSubmit={submit} noValidate className="stack">
      <label>
        Cancellation reason
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      <p className="hint" style={FLUSH}>
        A cancelled allocation is final and stays on record.
      </p>
      <Problem text={problem} />
      <Refusal error={cancel.error} act="allocation" />
      <div className="row">
        <button type="submit" className="danger" disabled={cancel.isPending}>
          Cancel allocation
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Close
        </button>
      </div>
    </form>
  );
}
