// Leave balances: employees before accrual and the year end, the employee leave ledger and the monthly balance upload.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, fileToBase64, formatDate, idempotencyKey } from '../../api';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from '../records';
import { useSession } from '../../session';
import { Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section, WarningNote } from '../../ui';
import { keepOnPage } from './shared';

/** The file field and its Validate button side by side, their bottoms lined up (the old `div.inline`). */
const FIELD_ROW = 'flex flex-wrap items-end gap-x-4 gap-y-3';

// ---------------------------------------------------------------------------------------------------------
// Before accrual
// ---------------------------------------------------------------------------------------------------------

interface WithoutPolicy {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employmentType: string | null;
  asOf: string;
  unresolved: { leaveType: string; reason: string }[];
  mappedLeaveTypes: string[];
}

const UNRESOLVED_TEXT: Record<string, string> = {
  POLICY_NOT_FOUND: 'no policy applies, so the run credits nothing for this type',
  POLICY_AMBIGUOUS: 'two policies tie, so the run stops on this employee',
};

interface PendingAtYearEnd {
  requestId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  leaveType: string;
  startDate: string;
  endDate: string;
}

/**
 * FR-024 / FR-025 year-end expiry (I-78 item 3): units held above a policy's carry cap on the last day of its leave year
 * expire, once; leave already promised to later dates stays covered. A request still pending in the closing year holds its
 * employee back until it is decided, and running the same date again takes them.
 */
function YearEnd() {
  const [yearEnd, setYearEnd] = useState('');
  const [page, setPage] = useState(1);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(yearEnd);
  const run = useMutation({ mutationFn: () => api('/v1/leave/year-end-runs', { body: { yearEnd } }) });
  const pending = useQuery({
    queryKey: ['leave-year-end-pending', yearEnd, page],
    enabled: valid,
    queryFn: () => api<{ items: PendingAtYearEnd[]; total: number; page: number }>(`/v1/leave/year-end-runs/pending-requests?yearEnd=${yearEnd}&${pageParams(page)}`),
  });
  return (
    <Section title="Leave year end">
      <FormGrid
        aria-label="Leave year end"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          run.mutate();
        }}
      >
        <FormField>
          Last day of the leave year
          <Input
            type="date"
            required
            value={yearEnd}
            onChange={(e) => {
              setYearEnd(e.target.value);
              setPage(1);
              run.reset();
            }}
          />
        </FormField>
        <Button type="submit" disabled={run.isPending || !valid}>
          Expire balances above the carry cap
        </Button>
      </FormGrid>
      <Hint>
        Only leave types whose policy starts its leave year the next day are expired, each employee and type once. Units promised to leave after that day are kept, so no balance goes below zero.
      </Hint>
      {run.isSuccess && (
        <StatusNote tone="success" role="status">
          Queued. Follow it in <Link to="/bulk-jobs">My background jobs</Link>.
        </StatusNote>
      )}
      <ErrorNote error={run.error ?? pending.error} />
      {pending.isSuccess && pending.data.total === 0 && <Empty>No request in your scope is waiting for a decision in this leave year.</Empty>}
      {pending.isSuccess && pending.data.items.length > 0 && (
        <>
          <WarningNote badge="waiting">
            {`${pending.data.total} pending ${pending.data.total === 1 ? 'request holds its employee' : 'requests hold their employees'} back until decided; run this date again afterwards.`}
          </WarningNote>
          <Table aria-label="Pending requests at the leave year end">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Employee</TableHead>
                <TableHead scope="col">Leave type</TableHead>
                <TableHead scope="col">Dates</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pending.data.items.map((r) => (
                <TableRow key={r.requestId}>
                  <TableCell>{r.employeeCode}</TableCell>
                  <TableCell>{r.employeeName}</TableCell>
                  <TableCell>{r.leaveType}</TableCell>
                  <TableCell>{`${formatDate(r.startDate)} – ${formatDate(r.endDate)}`}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager page={pending.data.page} pageSize={LIST_PAGE_SIZE} total={pending.data.total} onPage={setPage} label="Pending request pages" noun="request" />
        </>
      )}
    </Section>
  );
}

export function BeforeAccrualPage() {
  return (
    <>
      <WithoutPolicyList />
      <YearEnd />
    </>
  );
}

function WithoutPolicyList() {
  const [month, setMonth] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['leave-without-policy', month, page],
    enabled: /^\d{4}-\d{2}$/.test(month),
    queryFn: () => api<{ items: WithoutPolicy[]; total: number; page: number; pageSize: number }>(`/v1/leave/accruals/employees-without-policy?month=${month}&${pageParams(page)}`),
  });
  return (
    <Section title="Employees without a policy, before accrual">
      <FilterBar asChild>
        <form onSubmit={keepOnPage}>
          <FormField>
            Accrual month
            <Input
              type="month"
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setPage(1);
              }}
            />
          </FormField>
        </form>
      </FilterBar>
      <Hint>
        Employees the month’s accrual would cover, in your scope, for whom a paid leave type resolves to no policy or to a tie. A group with no paid type by policy (for example contractors) appears here too: check it is meant.
      </Hint>
      <ErrorNote error={list.error} />
      {!/^\d{4}-\d{2}$/.test(month) && <Empty>Choose an accrual month to list the employees it would leave without a policy.</Empty>}
      {list.isSuccess && list.data.total === 0 && <Empty>Every employee in your scope resolves to one policy for every paid leave type.</Empty>}
      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <StatusNote tone="info" role="status">
            {`${list.data.total} ${list.data.total === 1 ? 'employee needs' : 'employees need'} a look`}
          </StatusNote>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Code</TableHead>
                <TableHead scope="col">Employee</TableHead>
                <TableHead scope="col">Employment type</TableHead>
                <TableHead scope="col">Paid types not resolved</TableHead>
                <TableHead scope="col">Types that resolve</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((e) => (
                <TableRow key={e.employeeId}>
                  <TableCell>{e.employeeCode}</TableCell>
                  <TableCell>{e.employeeName}</TableCell>
                  <TableCell>{e.employmentType ?? '—'}</TableCell>
                  <TableCell>
                    <ul>
                      {e.unresolved.map((u) => (
                        <li key={u.leaveType}>{`${u.leaveType}: ${UNRESOLVED_TEXT[u.reason] ?? u.reason}`}</li>
                      ))}
                    </ul>
                  </TableCell>
                  <TableCell>{e.mappedLeaveTypes.join(', ') || 'none'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Pager page={list.data.page} pageSize={LIST_PAGE_SIZE} total={list.data.total} onPage={setPage} label="Employees without a policy pages" noun="employee" />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Employee leave ledger
// ---------------------------------------------------------------------------------------------------------

interface Ledger {
  items: {
    leaveType: string;
    paid: boolean;
    opening: string;
    credits: string;
    debits: string;
    closing: string;
    movements: { id: string; kind: string; units: string; effectiveDate: string; requestId: string | null; actorUserId: string | null; reason?: string | null }[];
  }[];
}

const MOVEMENT_TEXT: Record<string, string> = {
  OPENING: 'Opening balance',
  ACCRUAL: 'Accrual',
  ADJUSTMENT: 'Adjustment',
  EXPIRY: 'Expiry',
  RESERVATION: 'Reserved by a request',
  RESERVATION_RELEASE: 'Reservation released',
  CONSUMPTION: 'Taken on approval',
  REVERSAL: 'Returned by a cancellation',
};

const days = (value: string) => Number(value).toFixed(2);

export function LeaveLedgerPage() {
  const { me } = useSession();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState('');
  const [period, setPeriod] = useState({ from: '', to: '' });
  const employees = useQuery({
    queryKey: ['ledger-employees', search],
    enabled: search.trim().length >= 2,
    queryFn: () => api<{ items: { id: string; employeeCode: string; displayName: string }[] }>(`/v1/employees?search=${encodeURIComponent(search.trim())}&pageSize=25`),
  });
  const employeeId = picked || me?.employeeId || '';
  const ledger = useQuery({
    queryKey: ['leave-ledger', employeeId, period],
    enabled: !!employeeId && !!period.from && !!period.to,
    queryFn: () => api<Ledger>(`/v1/employees/${employeeId}/leave-ledger?from=${period.from}&to=${period.to}`),
  });
  return (
    <Section title="Employee leave ledger">
      <FilterBar asChild>
        <form onSubmit={keepOnPage}>
          <FormField>
            Find an employee (code or name)
            <Input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} />
          </FormField>
          <FormField>
            Employee
            <NativeSelect value={picked} onChange={(e) => setPicked(e.target.value)}>
              <option value="">{me?.employeeId ? 'Myself' : 'Choose'}</option>
              {employees.data?.items.map((e) => (
                <option key={e.id} value={e.id}>
                  {`${e.displayName} (${e.employeeCode})`}
                </option>
              ))}
            </NativeSelect>
          </FormField>
          <FormField>
            From
            <Input type="date" required value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
          </FormField>
          <FormField>
            To
            <Input type="date" required value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
          </FormField>
        </form>
      </FilterBar>
      <ErrorNote error={employees.error ?? ledger.error} />
      {!employeeId ? (
        <Empty>Choose an employee and a period to see their leave ledger.</Empty>
      ) : (
        (!period.from || !period.to) && <Empty>Choose the period (From and To) to see the leave ledger.</Empty>
      )}
      {ledger.data?.items.length === 0 && <Empty>No leave types to show.</Empty>}
      {ledger.data?.items.map((t) => (
        <section key={t.leaveType} aria-label={`${t.leaveType} ledger`}>
          <h3>{`${t.leaveType}${t.paid ? '' : ' (unpaid)'}`}</h3>
          <p>{`Opening ${days(t.opening)} + credits ${days(t.credits)} − debits ${days(t.debits)} = closing ${days(t.closing)}`}</p>
          {t.movements.length === 0 ? (
            <Empty>No movements in this period.</Empty>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Date</TableHead>
                  <TableHead scope="col">Movement</TableHead>
                  <TableHead scope="col">Days</TableHead>
                  <TableHead scope="col">Linked request</TableHead>
                  <TableHead scope="col">Note</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {t.movements.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>{formatDate(m.effectiveDate)}</TableCell>
                    <TableCell>{MOVEMENT_TEXT[m.kind] ?? m.kind}</TableCell>
                    <TableCell>{days(m.units)}</TableCell>
                    <TableCell>{m.requestId ? 'Yes' : '—'}</TableCell>
                    <TableCell>{m.reason ?? ''}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      ))}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Monthly leave-balance upload (the reference's "Upload Monthly Leave Balance"; FR-025, DF05, DF09): one adjustment per
// employee, leave type and month, added to the leave ledger with its reason (never overwriting it), previewed with each
// balance at the month end before and after, then committed all or nothing.
// ---------------------------------------------------------------------------------------------------------

export const MONTHLY_BALANCE_TEMPLATE: ImportTemplate = {
  code: 'LEAVE_MONTHLY_ADJUSTMENT_V1',
  label: 'Monthly leave balance',
  permissions: ['leave.import.operational', 'leave.adjust.operational'],
  base: '/v1/leave/monthly-adjustment-imports',
  columns: 'employeeCode,leaveType,month,units,reason',
  keyLabel: 'Employee @ leave type @ month',
  noun: ['adjustment', 'adjustments'],
  verb: 'Record',
  note: 'Each row adds or removes days (for example 1.5 or -1) in the employee’s leave ledger for a month (YYYY-MM), dated its last day, with your reason.',
  changeFields: ['balanceAtMonthEnd'],
  problems: {
    MONTH_ALREADY_ADJUSTED: 'This employee already has an uploaded adjustment of this leave type for this month. Record a further correction as a single adjustment.',
    NEGATIVE_BALANCE: 'This deduction would take a paid leave balance below zero, at the month end or overall.',
    DUPLICATE_IN_BATCH: 'The file already has a row for this employee, leave type and month.',
    UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
    UNKNOWN_LEAVE_TYPE: 'There is no leave type with this code.',
    INVALID_UNITS: 'Units must be a number other than zero, with at most 4 decimals, for example 1.5 or -1.',
    INVALID_MONTH: 'The month must be written YYYY-MM, for example 2026-10.',
    FUTURE_MONTH: 'This month has not started yet.',
    NOT_EMPLOYED_IN_MONTH: 'The employee was not employed in this month (before joining, or after the last working date).',
    INVALID_REASON: 'A reason of at most 500 characters is required.',
    OUT_OF_SCOPE: 'This employee is outside your role’s scope, or it is your own balance, which another administrator must record.',
  },
};

export function MonthlyLeaveBalancePage() {
  const { can } = useSession();
  const t = MONTHLY_BALANCE_TEMPLATE;
  const [file, setFile] = useState<File | null>(null);
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  const uploadKey = useRef<string | null>(null);
  const { resume, open, refresh, watch } = useBatchFollowUp(
    t.base,
    {
      show: setJob,
      closed: (id) => setJob((shown) => (shown?.id === id ? null : shown)),
      onStart: () => {
        upload.reset();
        act.reset();
      },
    },
    job,
  );
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey('monthly-leave'));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onSettled: refresh,
    onSuccess: (view) => {
      setJob(view);
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => api<ImportJob>(`${t.base}/${id}/${action}`, { method: 'POST' }),
    onSuccess: setJob,
    onSettled: refresh,
  });
  if (!t.permissions.every((p) => can(p))) return <Empty>Uploading leave balances needs the leave import and adjustment duties.</Empty>;
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  return (
    <>
      <Section title="Upload monthly leave balance">
        <form
          className="flex flex-col gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (file && !busy) upload.mutate(file);
          }}
        >
          <Hint>
            {/* The header is one long word of comma-joined column names: it may break anywhere, or it runs out of the card on a phone. */}
            CSV with exactly the header <code className="break-all">{t.columns}</code>. {t.note} Nothing is applied until you commit the preview, and one row with a problem rejects the whole
            file. Each employee, leave type and month takes one uploaded adjustment, so a file cannot be applied twice; a deduction never takes a paid balance below zero.
          </Hint>
          <TemplateDownload base={t.base} code={t.code} />
          <div className={FIELD_ROW}>
            <FormField className="w-auto">
              Balance file
              <Input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </FormField>
            <Button type="submit" disabled={!file || busy}>
              Validate
            </Button>
          </div>
        </form>
        <ErrorNote error={upload.error ?? resume.error} />
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title="Your monthly leave balance batches" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}
