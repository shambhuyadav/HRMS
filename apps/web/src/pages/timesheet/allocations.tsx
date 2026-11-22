// Resource allocations (FR-046): the list, a new allocation, its change and its cancellation.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, Notice, NotPermitted, pageParams, Pager, Section, StateBadge, When } from '../../ui';
import { EmployeeField, JobField } from './fields';
import { ReadProblem, Refusal } from './refusals';
import { ALLOC_MANAGE, ALLOC_READ, FORM_END, PERCENT, Problem, Remark, shown, useKeys } from './shared';
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
        <Hint>An allocation is a share of the employee’s daily capacity on a job. Overlapping jobs may total 100%; above that, only the employee’s direct manager records an exception with a reason.</Hint>
        <FilterBar>
          <FormField>
            Status
            <NativeSelect value={state} onChange={(e) => setState(e.target.value)}>
              <option value="">All</option>
              <option value="ACTIVE">Active</option>
              <option value="CANCELLED">Cancelled</option>
            </NativeSelect>
          </FormField>
          <FormField>
            Overlapping from
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </FormField>
          <FormField>
            Overlapping to
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </FormField>
        </FilterBar>
        <ReadProblem error={list.error} what="resource allocations" />
        {list.isPending && <LoadingLine>Loading allocations…</LoadingLine>}
        {data && data.items.length === 0 && <Empty>No allocations match.</Empty>}
        {data && data.items.length > 0 && (
          <Table aria-label="Allocations">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Employee</TableHead>
                <TableHead scope="col">Project and job</TableHead>
                <TableHead scope="col">Interval</TableHead>
                <TableHead scope="col">Allocation</TableHead>
                <TableHead scope="col">Status</TableHead>
                <TableHead scope="col">Over-allocation exception</TableHead>
                {can(ALLOC_MANAGE) && <TableHead scope="col">Change</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((a) => (
                <AllocationRow key={a.id} a={a} manage={can(ALLOC_MANAGE)} />
              ))}
            </TableBody>
          </Table>
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
      <TableRow>
        <TableCell>
          {a.employeeName} ({a.employeeCode})
        </TableCell>
        <TableCell>
          {a.projectCode} / {a.jobCode}: {a.jobName}
        </TableCell>
        <TableCell>
          {formatDate(a.startDate)} to {formatDate(a.endDate)}
        </TableCell>
        <TableCell>{a.allocationPercent}%</TableCell>
        <TableCell>
          <StateBadge state={a.state} />
          {a.source === 'IMPORT' && <Remark>imported</Remark>}
          {a.cancelReason && <Remark>Cancelled: {a.cancelReason}</Remark>}
        </TableCell>
        <TableCell>
          {a.overAllocation ? (
            <>
              Peak {a.overAllocation.peakPercent}% · recorded <When at={a.overAllocation.recordedAt} />
              <Remark>Reason: {a.overAllocation.reason}</Remark>
            </>
          ) : (
            '—'
          )}
        </TableCell>
        {manage && (
          <RowActionsCell>
            {a.state === 'ACTIVE' ? (
              <RowActions>
                <Button type="button" variant="outline" size="sm" aria-expanded={open === 'change'} onClick={() => setOpen(open === 'change' ? null : 'change')}>
                  Change {a.employeeCode} on {a.jobCode}
                </Button>
                <Button type="button" variant="danger" size="sm" aria-expanded={open === 'cancel'} onClick={() => setOpen(open === 'cancel' ? null : 'cancel')}>
                  Cancel {a.employeeCode} on {a.jobCode}
                </Button>
              </RowActions>
            ) : (
              '—'
            )}
          </RowActionsCell>
        )}
      </TableRow>
      {manage && open && (
        <TableRow>
          <TableCell colSpan={7}>
            {open === 'change' ? <ChangeAllocation a={a} onDone={() => setOpen(null)} /> : <CancelAllocation a={a} onDone={() => setOpen(null)} />}
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

/** The exception reason, offered once the API reports that the total would exceed 100% (or one is on record). */
function ExceptionReason({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <FormField className="col-span-full">
      Over-allocation exception reason (the employee’s direct manager only)
      <Textarea rows={2} maxLength={1000} value={value} onChange={(e) => onChange(e.target.value)} />
    </FormField>
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
      <FormGrid aria-labelledby={`${id}-title`} onSubmit={submit} noValidate>
        <CardSubheading id={`${id}-title`}>Allocate an employee to a job</CardSubheading>
        <EmployeeField label="Employee" value={f.employee} onChange={set('employee')} />
        <JobField projectId={f.project} jobId={f.job} onProject={set('project')} onJob={set('job')} />
        <FormField>
          From
          <Input type="date" value={f.start} onChange={(e) => set('start')(e.target.value)} />
        </FormField>
        <FormField>
          To
          <Input type="date" value={f.end} onChange={(e) => set('end')(e.target.value)} />
        </FormField>
        <FormField>
          Allocation (%)
          <Input inputMode="decimal" value={f.percent} maxLength={6} onChange={(e) => set('percent')(e.target.value)} />
        </FormField>
        {askReason && <ExceptionReason value={f.reason} onChange={set('reason')} />}
        <div className={FORM_END}>
          <Problem text={problem} />
          <Refusal error={create.error} act="allocation" />
          <Notice notice={notice} />
          <Button type="submit" className="self-start" disabled={create.isPending}>
            {askReason ? 'Allocate with the exception' : 'Allocate'}
          </Button>
        </div>
      </FormGrid>
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
    <FormGrid aria-label={`Change the allocation of ${a.employeeCode} on ${a.jobCode}`} onSubmit={submit} noValidate>
      <FormField>
        New end date
        <Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
      </FormField>
      <FormField>
        New allocation (%)
        <Input inputMode="decimal" value={percent} maxLength={6} onChange={(e) => setPercent(e.target.value)} />
      </FormField>
      {askReason && <ExceptionReason value={reason} onChange={setReason} />}
      <div className={FORM_END}>
        <Problem text={problem} />
        <Refusal error={save.error} act="allocation" />
        <ButtonRow>
          <Button type="submit" disabled={save.isPending}>
            Save allocation
          </Button>
          <Button type="button" variant="outline" onClick={onDone}>
            Close
          </Button>
        </ButtonRow>
      </div>
    </FormGrid>
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
      <FormField>
        Cancellation reason
        <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <Hint className="m-0">A cancelled allocation is final and stays on record.</Hint>
      <Problem text={problem} />
      <Refusal error={cancel.error} act="allocation" />
      <ButtonRow>
        <Button type="submit" variant="danger" disabled={cancel.isPending}>
          Cancel allocation
        </Button>
        <Button type="button" variant="outline" onClick={onDone}>
          Close
        </Button>
      </ButtonRow>
    </form>
  );
}
