// FR-029 employee salary master (E08; CL-075, CL-204-CL-210): the salary master list with E08's filters (a day or a
// month, employee search, status), the salary and annual salary exports, and the salary master upload. Amounts are
// confidential (DF02): the list needs the salary read grant, the upload the salary manage grant, the exports the salary
// export grant; the server checks each again. Amounts are shown exactly as the server returns them and never computed here:
// the estimated in-hand is the server's (BR-011; I-80, decided under owner delegation, 6 Nov 2026), shown with the server's
// own note on how it is made, and "Not available" where the server makes none.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, type ReactNode, useRef, useState } from 'react';
import { api, ApiError, download, fileToBase64, formatAmount, formatDate, idempotencyKey, localDate, pinSession } from '../api';
import { isReportRefusal, reportProblem } from '../report-failures';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from './records';

const SALARY_READ = 'salary.read.salary';
const SALARY_MANAGE = 'salary.manage.salary';
const SALARY_EXPORT = 'salary.export.salary';

const PATHS = { master: '/salary-master', upload: '/salary-master/upload' } as const;
const LIST = '/v1/salary-master';
const PAGE_SIZE = 25;

/** The employee lifecycle states (DF04), the E08 status filter's choices. */
const STATUSES: { value: string; label: string }[] = [
  { value: 'DRAFT', label: 'Draft' },
  { value: 'ACTIVE_PROBATION', label: 'Active (probation)' },
  { value: 'ACTIVE_CONFIRMED', label: 'Active (confirmed)' },
  { value: 'NOTICE', label: 'Notice' },
  { value: 'INACTIVE_SEPARATED', label: 'Separated' },
  { value: 'ARCHIVED', label: 'Archived' },
];
const statusLabel = (code: string) => STATUSES.find((s) => s.value === code)?.label ?? code;

const SCROLL: CSSProperties = { overflowX: 'auto' };
const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;
/** C4: a refusal of the past, not of salaries: today and later still answer. */
const needsHistoryGrant = (error: unknown) => error instanceof ApiError && error.code === 'HISTORY_GRANT_REQUIRED';
const HISTORY_GRANT_NOTE = 'Earlier dates and whole months need the salary history grant, which the selected role does not hold. Today and later dates are available.';
/** A refusal or bad request will not change on retry; only transient failures are retried (once). */
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;

function NotPermitted({ children }: { children: ReactNode }) {
  return (
    <p role="note">
      <Badge tone="warn">not permitted</Badge> {children}
    </p>
  );
}

/** A decimal string the server returned, with its currency. Never computed here. */
const money = (value: string, currency: string) => formatAmount(value, currency);

/** The last day of a calendar month (YYYY-MM). */
function monthEnd(month: string): string {
  const [year, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(year, m, 0)).getUTCDate()).padStart(2, '0')}`;
}

/** The starting year of the financial year (April to March, DF14) that contains today. */
function currentFinancialYear(): number {
  const today = new Date();
  return today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
}

// ---------------------------------------------------------------------------------------------------------
// Screen: the salary master list and its exports
// ---------------------------------------------------------------------------------------------------------

interface SalaryRow {
  employeeId: string;
  employeeCode: string;
  displayName: string;
  status: string;
  grade: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  currency: string;
  annualCtc: string;
  monthlyGross: string;
  estimatedInHand?: string | null;
}

interface SalaryPage {
  period: { from: string; to: string; date?: string; month?: string };
  items: SalaryRow[];
  total: number;
  page: number;
  pageSize: number;
  estimate?: { label: string; message: string };
}

interface Filters {
  view: 'day' | 'month';
  date: string;
  month: string;
  search: string;
  status: string;
}

/** The effective period the filters select: one day, or one calendar month from its first to its last day. */
const periodOf = (f: Filters) => (f.view === 'month' ? { from: `${f.month}-01`, to: monthEnd(f.month) } : { from: f.date, to: f.date });

function SalaryMasterScreen() {
  const { me, can } = useSession();
  if (!me) return <p className="hint">Loading…</p>;
  const read = can(SALARY_READ);
  const exporting = can(SALARY_EXPORT);
  return (
    <>
      <h1>Salary master</h1>
      {read || exporting ? (
        <SalaryMaster read={read} exporting={exporting} />
      ) : (
        <Section title="Salary master">
          <NotPermitted>The selected role cannot view or export salaries: that needs the salary read or export grant.</NotPermitted>
        </Section>
      )}
    </>
  );
}

function SalaryMaster({ read, exporting }: { read: boolean; exporting: boolean }) {
  const today = localDate();
  const initial: Filters = { view: 'day', date: today, month: today.slice(0, 7), search: '', status: '' };
  const [filters, setFilters] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters>(initial);
  const [page, setPage] = useState(1);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setApplied(filters);
    setPage(1);
  };
  const ready = filters.view === 'day' ? /^\d{4}-\d{2}-\d{2}$/.test(filters.date) : /^\d{4}-\d{2}$/.test(filters.month);
  return (
    <>
      <Section title="Filters">
        <form className="grid-form" aria-label="Salary master filters" onSubmit={submit}>
          <label>
            Effective
            <select value={filters.view} onChange={(e) => setFilters({ ...filters, view: e.target.value as Filters['view'] })}>
              <option value="day">On a day</option>
              <option value="month">In a month</option>
            </select>
          </label>
          {filters.view === 'day' ? (
            <label>
              Day
              <input type="date" required value={filters.date} onChange={(e) => setFilters({ ...filters, date: e.target.value })} />
            </label>
          ) : (
            <label>
              Month
              <input type="month" required value={filters.month} onChange={(e) => setFilters({ ...filters, month: e.target.value })} />
            </label>
          )}
          <label>
            Employee
            <input value={filters.search} maxLength={100} placeholder="Code, name or work email" onChange={(e) => setFilters({ ...filters, search: e.target.value })} />
          </label>
          <label>
            Status
            <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
              <option value="">Any status</option>
              {STATUSES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={!ready}>
            Show
          </button>
        </form>
        <p className="hint">
          A day shows the salary arrangement each employee had in force on it; a month shows every arrangement in force at any time in it, so an employee whose salary changed that month
          appears once per arrangement. The exports below take the same filters.
        </p>
      </Section>
      {read ? (
        <SalaryList filters={applied} page={page} onPage={setPage} />
      ) : (
        <Section title="Salaries">
          <NotPermitted>The selected role can export salaries but cannot view them here: that needs the salary read grant.</NotPermitted>
        </Section>
      )}
      {exporting && <SalaryExports filters={applied} />}
    </>
  );
}

function SalaryList({ filters, page, onPage }: { filters: Filters; page: number; onPage: (page: number) => void }) {
  const { stored } = useSession();
  const query = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (filters.view === 'month') query.set('month', filters.month);
  else query.set('date', filters.date);
  if (filters.search.trim()) query.set('search', filters.search.trim());
  if (filters.status) query.set('status', filters.status);
  const list = useQuery({
    // The selected company and assignment are part of the key: an answer to one role is never shown under another.
    queryKey: ['salary-master', stored?.companyId ?? '-', stored?.assignmentId ?? '-', query.toString()],
    queryFn: () => api<SalaryPage>(`${LIST}?${query.toString()}`),
    retry: retryTransient,
  });
  // Figures the server now refuses must not stay on screen next to the refusal.
  const data = list.isSuccess ? list.data : undefined;
  const pages = Math.max(1, Math.ceil((data?.total ?? 0) / PAGE_SIZE));
  const period = data ? (data.period.month ? `in ${data.period.month}` : `on ${formatDate(data.period.from)}`) : '';
  return (
    <Section title={data ? `Salaries ${period} (${data.total})` : 'Salaries'}>
      {list.isPending && <p className="hint">Loading salaries…</p>}
      {needsHistoryGrant(list.error) ? <NotPermitted>{HISTORY_GRANT_NOTE}</NotPermitted> : isForbidden(list.error) ? <NotPermitted>The selected role cannot view salaries.</NotPermitted> : <ErrorNote error={list.error} />}
      {data && data.items.length === 0 && <Empty>{page === 1 ? 'No salary arrangement matches these filters.' : 'No arrangements on this page.'}</Empty>}
      {data && data.items.length > 0 && (
        <>
          <div style={SCROLL}>
            <table aria-label="Salary master">
              <thead>
                <tr>
                  <th scope="col">Employee</th>
                  <th scope="col">Status</th>
                  <th scope="col">Grade</th>
                  <th scope="col">Effective from</th>
                  <th scope="col">Effective to</th>
                  <th scope="col">Annual CTC</th>
                  <th scope="col">Monthly gross</th>
                  {data.estimate && <th scope="col">{`${data.estimate.label} (estimate)`}</th>}
                </tr>
              </thead>
              <tbody>
                {data.items.map((r) => (
                  <tr key={`${r.employeeId}-${r.effectiveFrom}`}>
                    <td>
                      {r.displayName} <span className="hint">{r.employeeCode}</span>
                    </td>
                    <td>{statusLabel(r.status)}</td>
                    <td>{r.grade ?? '—'}</td>
                    <td>{formatDate(r.effectiveFrom)}</td>
                    <td>{r.effectiveTo ? formatDate(r.effectiveTo) : 'No end date'}</td>
                    <td>{money(r.annualCtc, r.currency)}</td>
                    <td>{money(r.monthlyGross, r.currency)}</td>
                    {data.estimate && <td>{r.estimatedInHand ? money(r.estimatedInHand, r.currency) : 'Not available'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">An arrangement stays in force until the day the next one starts.</p>
          {data.estimate && <p className="hint">{`${data.estimate.label}: ${data.estimate.message}`}</p>}
        </>
      )}
      {pages > 1 && (
        <div className="row">
          <button type="button" className="secondary" disabled={page <= 1} onClick={() => onPage(page - 1)}>
            Previous
          </button>
          <span className="hint">
            Page {page} of {pages}
          </span>
          <button type="button" className="secondary" disabled={page >= pages} onClick={() => onPage(page + 1)}>
            Next
          </button>
        </div>
      )}
    </Section>
  );
}

interface ReportState {
  reportCode: string;
  state: string;
  rowCount: number | null;
  failureCode: string | null;
}

/** FR-029 salary and annual salary exports (report catalogue SALARY_MASTER and ANNUAL_SALARY), generated in the background. */
function SalaryExports({ filters }: { filters: Filters }) {
  const [year, setYear] = useState(String(currentFinancialYear()));
  const [requested, setRequested] = useState<{ id: string; label: string }[]>([]);
  const narrow = { ...(filters.search.trim() ? { search: filters.search.trim() } : {}), ...(filters.status ? { status: filters.status } : {}) };
  const request = useMutation({
    mutationFn: async ({ reportCode, period, label }: { reportCode: 'SALARY_MASTER' | 'ANNUAL_SALARY'; period: { from: string; to: string }; label: string }) => ({
      ...(await api<{ id: string }>('/v1/reports', { body: { reportCode, filters: { ...period, ...narrow } } })),
      label,
    }),
    onSuccess: (r) => setRequested((list) => [{ id: r.id, label: r.label }, ...list]),
  });
  const period = periodOf(filters);
  const fy = Number(year);
  const validYear = /^\d{4}$/.test(year) && fy >= 2000 && fy <= 2100;
  const shown = filters.view === 'month' ? `for ${filters.month}` : `on ${formatDate(period.from)}`;
  return (
    <Section title="Exports">
      <div className="row">
        <button type="button" disabled={request.isPending} onClick={() => request.mutate({ reportCode: 'SALARY_MASTER', period, label: `Salary export ${shown}` })}>
          Export salaries {shown}
        </button>
      </div>
      <div className="row">
        <label>
          Financial year starting April
          <input inputMode="numeric" value={year} maxLength={4} onChange={(e) => setYear(e.target.value.trim())} />
        </label>
        <button
          type="button"
          className="secondary"
          disabled={request.isPending || !validYear}
          onClick={() => request.mutate({ reportCode: 'ANNUAL_SALARY', period: { from: `${fy}-04-01`, to: `${fy + 1}-03-31` }, label: `Annual salary export ${fy}-${String(fy + 1).slice(2)}` })}
        >
          Export annual salaries {validYear ? `${fy}-${String(fy + 1).slice(2)}` : ''}
        </button>
      </div>
      <p className="hint">
        The exports use the filters shown above (as last applied with Show). The annual export lists every arrangement in force during the financial year, 1 April to 31 March. Exports are
        generated in the background, re-check your access when downloaded and expire after 24 hours.
      </p>
      {needsHistoryGrant(request.error) ? <NotPermitted>{HISTORY_GRANT_NOTE}</NotPermitted> : isForbidden(request.error) ? <NotPermitted>The selected role cannot export salaries.</NotPermitted> : <ErrorNote error={request.error} />}
      {requested.length > 0 && (
        <ul className="tasks" aria-label="Requested exports">
          {requested.map((r) => (
            <ExportStatus key={r.id} id={r.id} label={r.label} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function ExportStatus({ id, label }: { id: string; label: string }) {
  const status = useQuery({
    queryKey: ['report', id],
    queryFn: () => api<ReportState>(`/v1/reports/${encodeURIComponent(id)}`),
    refetchInterval: (q) => (!isReportRefusal(q.state.error) && (q.state.data?.state === 'QUEUED' || q.state.data?.state === 'RUNNING') ? 3000 : false),
    retry: retryTransient,
  });
  const get = useMutation({ mutationFn: () => download(`/v1/reports/${encodeURIComponent(id)}/download`) });
  const s = status.data;
  return (
    <li>
      <strong>{label}</strong> <StateBadge state={s?.state} />
      {s?.rowCount !== null && s?.rowCount !== undefined && <span className="hint"> {s.rowCount} rows</span>}
      {s && reportProblem(s) && <span className="hint"> {reportProblem(s)}</span>}
      {s?.state === 'COMPLETED' && (
        <button type="button" className="link" disabled={get.isPending} onClick={() => get.mutate()}>
          Download CSV
        </button>
      )}
      <ErrorNote error={get.error ?? status.error} />
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Screen: the salary master upload (SALARY_MASTER_V1)
// ---------------------------------------------------------------------------------------------------------

/** SALARY_MASTER_V1 row problems (increment/salary-master.ts, the rules of POST /employees/:id/salary, imports/batch.ts). */
const ROW_PROBLEMS: Record<string, string> = {
  INVALID_DATE: 'effectiveFrom is not a valid date (YYYY-MM-DD).',
  INVALID_ANNUAL_CTC: 'annualCtc must be digits with up to four decimal places, without commas, spaces or a sign.',
  INVALID_MONTHLY_GROSS: 'monthlyGross must be digits with up to four decimal places, without commas, spaces or a sign.',
  INVALID_CURRENCY: 'currency must be a three-letter upper-case code, for example INR.',
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  OUT_OF_SCOPE: 'This employee is outside the scope of your role.',
  SALARY_EXISTS: 'This employee already has a salary on record; a change to it goes through an increment case, which an independent approver decides.',
  DUPLICATE_IN_BATCH: 'This employee is already on an earlier row; each employee may appear on one row only.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
};

const SALARY_TEMPLATE: ImportTemplate = {
  code: 'SALARY_MASTER_V1',
  label: 'Salary master',
  permissions: [SALARY_MANAGE],
  base: '/v1/salary-master/imports',
  columns: 'employeeCode,effectiveFrom,annualCtc,monthlyGross,currency',
  keyLabel: 'Employee code',
  noun: ['initial salary', 'initial salaries'],
  verb: 'Record',
  note: 'Each row records the first salary arrangement of an employee who has none yet, exactly as recording it on the employee’s salary panel does: amounts as digits with up to four decimal places and no commas, the currency as a three-letter code. A recorded salary is not changed by an upload; changes go through an increment case.',
  problems: ROW_PROBLEMS,
};

function SalaryUploadScreen() {
  const { me, can } = useSession();
  if (!me) return <p className="hint">Loading…</p>;
  return (
    <>
      <h1>Salary master upload</h1>
      {can(SALARY_MANAGE) ? (
        <SalaryUpload />
      ) : (
        <Section title="Upload">
          <NotPermitted>The selected role cannot upload salaries: that needs the salary manage grant.</NotPermitted>
        </Section>
      )}
    </>
  );
}

function SalaryUpload() {
  const t = SALARY_TEMPLATE;
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  // Remounting the file input clears the chosen file once its preview is on screen.
  const [fileInput, setFileInput] = useState(0);
  const [job, setJob] = useState<ImportJob | null>(null);
  // One idempotency key per chosen file: validating the same file again returns the same batch.
  const uploadKey = useRef<string | null>(null);
  const choose = (next: File | null) => {
    setFile(next);
    uploadKey.current = null;
  };
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
  const act = useMutation({
    mutationFn: async ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => {
      // The decision and any look at the batch after it go out under the role it was made in (BR-046).
      const send = pinSession();
      try {
        return await send<ImportJob>(`${t.base}/${id}/${action}`, { method: 'POST' });
      } catch (err) {
        // The batch may have moved on (this very decision went through but its answer was lost): its view says where it stands.
        const current = await send<ImportJob>(`${t.base}/${id}`).catch(() => null);
        if (current?.state === (action === 'commit' ? 'COMMITTED' : 'CANCELLED')) return current;
        if (current) setJob((shown) => (shown?.id === id ? current : shown));
        throw err;
      }
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      // A committed batch recorded salaries: the salary master shows them.
      if (view.state === 'COMMITTED') void qc.invalidateQueries({ queryKey: ['salary-master'] });
    },
    onSettled: refresh,
  });
  const upload = useMutation({
    mutationFn: async (f: File) => {
      const key = (uploadKey.current ??= idempotencyKey('salary-master'));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onMutate: () => {
      resume.reset();
      open.reset();
    },
    onSuccess: (view) => {
      setJob(view);
      act.reset();
      // The preview is on screen, so the form starts clean: the next file is a new upload with its own key.
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
    onSettled: refresh,
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (file && !busy) upload.mutate(file);
  };
  return (
    <>
      <Section title="Upload">
        <form onSubmit={submit} className="stack">
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code> (template {t.code}). {t.note} Nothing is recorded until you commit a preview, and a batch is applied all or nothing: one
            row with a problem rejects the whole batch.
          </p>
          <TemplateDownload base={t.base} code={t.code} />
          <div className="inline">
            <label>
              Salary file
              <input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => choose(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={!file || busy}>
              Validate
            </button>
          </div>
        </form>
        {isForbidden(upload.error) ? <NotPermitted>The selected role cannot upload salaries.</NotPermitted> : <ErrorNote error={upload.error ?? resume.error} />}
      </Section>
      {job && (
        <>
          <ImportJobView job={job} template={t} pending={act.isPending} onAction={(action) => act.mutate({ id: job.id, action })} error={act.error} />
          <HeldBatchCheck job={job} busy={busy} onCheck={() => resume.mutate(job.id)} checked={resume.isPending ? undefined : resume.data} watch={watch} />
        </>
      )}
      <ImportBatches base={t.base} title="Your salary master batches" openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

export const SALARY_SCREENS: ScreenRoute[] = [
  { path: PATHS.master, title: 'Salary master', permission: SALARY_READ, nav: true, component: SalaryMasterScreen },
  { path: PATHS.upload, title: 'Salary master upload', permission: SALARY_MANAGE, nav: true, component: SalaryUploadScreen },
];
