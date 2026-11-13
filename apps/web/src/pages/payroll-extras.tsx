// Payroll inputs and reports, batch R3 (BRD coverage CL-074 challan master, CL-081 TDS challans, CL-084 / CL-119 past salary, CL-085
// perquisites, CL-097 GL mapping and salary JV, CL-098 liability provisions, CL-100 export for EDOC, CL-113 medical claims; FR-028 to
// FR-039). Every screen re-checks its own keys and the server re-checks every call. Uploads use the shared batch screens (records.tsx):
// a preview first, then an explicit commit, all or nothing. Figures the server cannot work out from configured rules arrive as
// NOT_CONFIGURED with the reason, and the screens show the reason, never a number.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, download, fileToBase64, formatDate, formatMonth, idempotencyKey, localDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Section } from '../ui';
import { type BulkJob, jobErrorText, useBulkJob } from './bulk-jobs';
import { HeldBatchCheck, ImportBatches, type ImportJob, ImportJobView, type ImportTemplate, TemplateDownload, useBatchFollowUp } from './records';

const CHALLAN_READ = 'payroll_challan.read.operational';
const CHALLAN_MANAGE = 'payroll_challan.manage.operational';
const TAX_READ = 'payroll_tax_input.read.amount';
const TAX_IMPORT = 'payroll_tax_input.import.amount';
const MAPPING_READ = 'payroll_gl_mapping.read.operational';
const MAPPING_MANAGE = 'payroll_gl_mapping.manage.operational';
const REPORT_READ = 'payroll_report.read.amount';
/** The liability provisions are worked from salaries (the server also needs the salary history duty for an earlier date). */
const SALARY_READ = 'salary.read.salary';
/** GET /v1/payroll/runs needs both groups of the run read duty. */
const RUN_LIST = 'payroll_run.read.amount';
const REPORT_EXPORT = 'payroll_report.export.amount';
const EDOC_EXPORT = 'payroll_output.export.amount';
const MEDICAL_READ = 'expense.read.operational';

/** The financial year (April to March) of a day, written 2026-27. */
export function fiscalYearOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

const plain = (code: string) => code.replace(/_/g, ' ').toLowerCase();
const amount = (value: string | null | undefined) => (value === null || value === undefined || value === '' ? '—' : Number(value).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// ---------------------------------------------------------------------------------------------------------
// A batch upload through the shared import screens (preview, commit or cancel, the caller's own batches).
// ---------------------------------------------------------------------------------------------------------
function UploadPanel({ template: t, title, fileLabel }: { template: ImportTemplate; title: string; fileLabel: string }) {
  const qc = useQueryClient();
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
      const key = (uploadKey.current ??= idempotencyKey(t.code.toLowerCase()));
      return api<ImportJob>(t.base, { body: { fileName: f.name, contentBase64: await fileToBase64(f), idempotencyKey: key } });
    },
    onSettled: refresh,
    onSuccess: (view) => {
      setJob(view);
      setFile(null);
      uploadKey.current = null;
      setFileInput((n) => n + 1);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === 'IDEMPOTENCY_KEY_IN_USE') uploadKey.current = null;
    },
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'commit' | 'cancel' }) => api<ImportJob>(`${t.base}/${id}/${action}`, { method: 'POST' }),
    onSuccess: (view) => {
      setJob(view);
      void qc.invalidateQueries({ queryKey: ['payroll-extras'] });
    },
    onSettled: refresh,
  });
  const busy = upload.isPending || act.isPending || resume.isPending || open.isPending;
  return (
    <>
      <Section title={title}>
        <form
          className="stack"
          aria-label={title}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (file && !busy) upload.mutate(file);
          }}
        >
          <p className="hint">
            CSV with exactly the header <code>{t.columns}</code>. {t.note} Nothing is applied until you commit the preview, and one row with a problem rejects the whole file.
          </p>
          <TemplateDownload base={t.base} code={t.code} />
          <div className="inline">
            <label>
              {fileLabel}
              <input key={fileInput} type="file" accept=".csv,text/csv" disabled={busy} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </label>
            <button type="submit" disabled={!file || busy}>
              Validate
            </button>
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
      <ImportBatches base={t.base} title={`Your ${t.label.toLowerCase()} batches`} openedId={job?.id ?? null} busy={busy} onOpen={(id) => open.mutate(id)} error={open.error} />
    </>
  );
}

const EMPLOYEE_PROBLEMS = {
  UNKNOWN_EMPLOYEE: 'No employee in this company has this employee code.',
  OUT_OF_SCOPE: 'This employee is outside your role’s scope.',
  OWN_RECORD: 'This is your own record; another administrator must record it.',
  NOT_EMPLOYED_IN_MONTH: 'The employee had not joined by this month.',
  FUTURE_MONTH: 'This month has not started yet.',
  DUPLICATE_IN_BATCH: 'The file already has a row for the same key.',
  COLUMN_COUNT: 'The row does not have exactly one cell for each column of the header.',
};

export const TDS_CHALLAN_TEMPLATE: ImportTemplate = {
  code: 'TDS_CHALLAN_V1',
  label: 'TDS challan',
  permissions: [CHALLAN_MANAGE],
  base: '/v1/payroll-extras/tds-challan-imports',
  columns: 'month,section,bsrCode,challanSerial,depositDate,amount',
  keyLabel: 'BSR code @ deposit date @ serial',
  noun: ['challan', 'challans'],
  verb: 'Record',
  note: 'Each row is one deposit: the month (YYYY-MM) whose tax it pays, the section, the bank’s 7-digit BSR code, the challan serial number, the deposit date and the amount.',
  problems: {
    CHALLAN_EXISTS: 'A challan with this BSR code, deposit date and serial number is already recorded.',
    INVALID_MONTH: 'The month must be written YYYY-MM.',
    FUTURE_MONTH: 'This month has not started yet.',
    INVALID_SECTION: 'The section is 1 to 10 letters or digits, for example 192.',
    INVALID_BSR_CODE: 'A BSR code is 7 digits.',
    INVALID_CHALLAN_SERIAL: 'The challan serial number is up to 5 digits.',
    INVALID_DEPOSIT_DATE: 'The deposit date must be written YYYY-MM-DD.',
    FUTURE_DEPOSIT_DATE: 'The deposit date is after today.',
    DEPOSIT_BEFORE_MONTH: 'Tax of a month is deposited on or after the first day of that month.',
    INVALID_AMOUNT: 'The amount is a number above zero with at most 2 decimals.',
    DUPLICATE_IN_BATCH: 'The file already has this challan on an earlier row.',
  },
};

export const PERQUISITES_TEMPLATE: ImportTemplate = {
  code: 'PERQUISITES_V1',
  label: 'Perquisites',
  permissions: [TAX_IMPORT],
  base: '/v1/payroll-extras/perquisite-imports',
  columns: 'employeeCode,month,perquisiteType,value',
  keyLabel: 'Employee @ month @ type',
  noun: ['perquisite', 'perquisites'],
  verb: 'Record',
  note: 'Each row is the taxable value of one perquisite of an employee for a month (YYYY-MM), by a type code such as RENT_FREE_ACCOMMODATION. A row for a key already recorded replaces it as a new revision; the earlier value stays on record.',
  changeFields: ['value'],
  problems: { ...EMPLOYEE_PROBLEMS, INVALID_MONTH: 'The month must be written YYYY-MM.', INVALID_PERQUISITE_TYPE: 'The type is a code of capital letters, digits and _.', INVALID_VALUE: 'The value is a number of at least zero with at most 2 decimals.' },
};

export const PAST_SALARY_TEMPLATE: ImportTemplate = {
  code: 'PAST_SALARY_V1',
  label: 'Past salary',
  permissions: [TAX_IMPORT],
  base: '/v1/payroll-extras/past-salary-imports',
  columns: 'employeeCode,financialYear,source,fromMonth,toMonth,taxableSalary,tdsDeducted',
  keyLabel: 'Employee @ year @ source',
  noun: ['past salary', 'past salaries'],
  verb: 'Record',
  note: 'Each row is the taxable salary paid and the tax deducted in a financial year (2026-27) over its months, before this payroll ran here (BEFORE_GO_LIVE) or by an earlier employer (PREVIOUS_EMPLOYER).',
  changeFields: ['taxableSalary', 'tdsDeducted'],
  problems: {
    ...EMPLOYEE_PROBLEMS,
    INVALID_FISCAL_YEAR: 'The financial year is written like 2026-27.',
    INVALID_SOURCE: 'The source is BEFORE_GO_LIVE or PREVIOUS_EMPLOYER.',
    INVALID_MONTHS: 'The months are written YYYY-MM, the first not after the last.',
    MONTHS_OUTSIDE_YEAR: 'Both months must fall in the financial year given.',
    AFTER_JOINING: 'An earlier employer’s months end by the month the employee joined here.',
    OVERLAPS_PROCESSED_PAYROLL: 'These months overlap payroll already processed here, which the tax projection already counts.',
    INVALID_AMOUNT: 'Amounts are numbers of at least zero with at most 2 decimals.',
  },
};

// ---------------------------------------------------------------------------------------------------------
// CL-074 challan master
// ---------------------------------------------------------------------------------------------------------
interface ChallanSetting {
  id: string;
  statute: string;
  revision: number;
  effectiveFrom: string;
  tan: string | null;
  establishmentCode: string | null;
  bankName: string;
  bankBranch: string | null;
  bsrCode: string | null;
  reason: string;
}

export function ChallanMasterPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['payroll-extras', 'challan-settings'], queryFn: () => api<{ asOf: string; inForce: Record<string, ChallanSetting | null>; items: ChallanSetting[] }>('/v1/payroll-extras/challan-settings') });
  const [form, setForm] = useState({ statute: 'TDS', effectiveFrom: localDate(), identifier: '', bankName: '', bankBranch: '', bsrCode: '', reason: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const save = useMutation({
    mutationFn: () =>
      api<ChallanSetting>('/v1/payroll-extras/challan-settings', {
        body: {
          statute: form.statute,
          effectiveFrom: form.effectiveFrom,
          ...(form.statute === 'TDS' ? { tan: form.identifier } : { establishmentCode: form.identifier }),
          bankName: form.bankName,
          bankBranch: form.bankBranch || null,
          bsrCode: form.bsrCode || null,
          reason: form.reason,
        },
      }),
    onSuccess: () => {
      setForm((f) => ({ ...f, identifier: '', reason: '' }));
      void qc.invalidateQueries({ queryKey: ['payroll-extras', 'challan-settings'] });
    },
  });
  if (!can(CHALLAN_READ)) return <Empty>The challan master needs the challan read duty.</Empty>;
  return (
    <>
      <Section title="Challan master">
        <p className="hint">The company’s deposit particulars per statute. A change is a new dated revision; earlier revisions stay on record.</p>
        <ErrorNote error={settings.error} />
        {settings.data && (
          <table aria-label="In force">
            <thead>
              <tr>
                <th scope="col">Statute</th>
                <th scope="col">TAN or establishment code</th>
                <th scope="col">Bank</th>
                <th scope="col">BSR code</th>
                <th scope="col">From</th>
                <th scope="col">Revision</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(settings.data.inForce).map(([statute, s]) => (
                <tr key={statute}>
                  <td>{statute}</td>
                  {s ? (
                    <>
                      <td>{s.tan ?? s.establishmentCode}</td>
                      <td>{[s.bankName, s.bankBranch].filter(Boolean).join(', ')}</td>
                      <td>{s.bsrCode ?? '—'}</td>
                      <td>{formatDate(s.effectiveFrom)}</td>
                      <td>{s.revision}</td>
                    </>
                  ) : (
                    <td colSpan={5}>Not recorded</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {settings.data && settings.data.items.length > 0 && (
          <details>
            <summary>All revisions ({settings.data.items.length})</summary>
            <ul>
              {settings.data.items.map((s) => (
                <li key={s.id}>
                  {s.statute} revision {s.revision} from {formatDate(s.effectiveFrom)}: {s.tan ?? s.establishmentCode}, {s.bankName} — {s.reason}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Section>
      {can(CHALLAN_MANAGE) && (
        <Section title="New revision">
          <form
            className="grid-form"
            aria-label="New revision"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!save.isPending) save.mutate();
            }}
          >
            <label>
              Statute
              <select value={form.statute} onChange={set('statute')}>
                <option value="TDS">TDS</option>
                <option value="PF">PF</option>
                <option value="ESIC">ESIC</option>
              </select>
            </label>
            <label>
              Effective from
              <input type="date" value={form.effectiveFrom} onChange={set('effectiveFrom')} required />
            </label>
            <label>
              {form.statute === 'TDS' ? 'TAN' : 'Establishment code'}
              <input value={form.identifier} onChange={set('identifier')} required maxLength={30} />
            </label>
            <label>
              Bank
              <input value={form.bankName} onChange={set('bankName')} required maxLength={120} />
            </label>
            <label>
              Branch
              <input value={form.bankBranch} onChange={set('bankBranch')} maxLength={120} />
            </label>
            <label>
              BSR code
              <input value={form.bsrCode} onChange={set('bsrCode')} maxLength={7} />
            </label>
            <label>
              Reason
              <input value={form.reason} onChange={set('reason')} required maxLength={500} />
            </label>
            <button type="submit" disabled={save.isPending}>
              Record revision
            </button>
          </form>
          <ErrorNote error={save.error} />
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// CL-081 TDS challans
// ---------------------------------------------------------------------------------------------------------
interface TdsChallan {
  id: string;
  month: string;
  section: string;
  bsrCode: string;
  challanSerial: string;
  depositDate: string;
  /** Null when the amounts are hidden (amountsHidden). */
  amount: string | null;
  source: string;
  state: string;
  cancelReason: string | null;
  version: number;
}

/** The year's challans; without the payroll report read duty the amounts and totals are hidden (null). */
interface ChallanList {
  amountsHidden?: boolean;
  items: TdsChallan[];
  months: { month: string; deposited: string | null }[];
}

interface Reconciliation {
  form24Q: { status: string; reason: string };
  months: { month: string; deducted: string; deposited: string; difference: string; status: string }[];
}

export function TdsChallansPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [year, setYear] = useState(fiscalYearOf(localDate()));
  const challans = useQuery({
    queryKey: ['payroll-extras', 'tds-challans', year],
    queryFn: () => api<ChallanList>(`/v1/payroll-extras/tds-challans?fiscalYear=${encodeURIComponent(year)}`),
  });
  const reconciliation = useQuery({
    queryKey: ['payroll-extras', 'tds-reconciliation', year],
    queryFn: () => api<Reconciliation>(`/v1/payroll-extras/tds-reconciliation?fiscalYear=${encodeURIComponent(year)}`),
    enabled: can(REPORT_READ),
  });
  // No section is assumed: the section numbers change with the Income-tax Act in force, so the user enters the challan's own.
  const blank = { month: '', section: '', bsrCode: '', challanSerial: '', depositDate: '', amount: '' };
  const [form, setForm] = useState(blank);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const refresh = () => void qc.invalidateQueries({ queryKey: ['payroll-extras'] });
  const record = useMutation({
    mutationFn: () => api<TdsChallan>('/v1/payroll-extras/tds-challans', { body: form }),
    onSuccess: () => {
      setForm(blank);
      refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: ({ c, reason }: { c: TdsChallan; reason: string }) => api<TdsChallan>(`/v1/payroll-extras/tds-challans/${c.id}/cancel`, { body: { reason, expectedVersion: c.version } }),
    onSuccess: refresh,
  });
  if (!can(CHALLAN_READ)) return <Empty>TDS challans need the challan read duty.</Empty>;
  const manage = can(CHALLAN_MANAGE);
  const amountsHidden = challans.data?.amountsHidden === true;
  return (
    <>
      <Section title="TDS challans">
        <div className="filters">
          <label>
            Financial year
            <input value={year} onChange={(e) => setYear(e.target.value)} pattern="\d{4}-\d{2}" />
          </label>
        </div>
        <ErrorNote error={challans.error} />
        {challans.data && challans.data.items.length === 0 && <Empty>No challan is recorded for {year}.</Empty>}
        {challans.data && challans.data.items.length > 0 && (
          <table aria-label="Challans">
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Section</th>
                <th scope="col">BSR code</th>
                <th scope="col">Serial</th>
                <th scope="col">Deposited on</th>
                <th scope="col">Amount</th>
                <th scope="col">State</th>
                {manage && <th scope="col">Action</th>}
              </tr>
            </thead>
            <tbody>
              {challans.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{formatMonth(c.month)}</td>
                  <td>{c.section}</td>
                  <td>{c.bsrCode}</td>
                  <td>{c.challanSerial}</td>
                  <td>{formatDate(c.depositDate)}</td>
                  <td>{amountsHidden ? 'Hidden' : amount(c.amount)}</td>
                  <td>{c.state === 'CANCELLED' ? `cancelled: ${c.cancelReason ?? ''}` : 'recorded'}</td>
                  {manage && (
                    <td>
                      {c.state === 'RECORDED' && (
                        <button
                          type="button"
                          disabled={cancel.isPending}
                          onClick={() => {
                            const reason = window.prompt('Why is this challan cancelled?');
                            if (reason?.trim()) cancel.mutate({ c, reason: reason.trim() });
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {challans.data && challans.data.items.length > 0 && amountsHidden && <p className="hint">The amounts deposited are company payroll figures: seeing them needs the payroll report read duty, company-wide.</p>}
        <ErrorNote error={cancel.error} />
      </Section>
      {can(REPORT_READ) && (
        <Section title="Deducted and deposited">
          <ErrorNote error={reconciliation.error} />
          {reconciliation.data && (
            <>
              <p className="hint">Form 24Q: {plain(reconciliation.data.form24Q.status)}. {reconciliation.data.form24Q.reason}</p>
              {reconciliation.data.months.length === 0 ? (
                <Empty>Nothing deducted or deposited in {year}.</Empty>
              ) : (
                <table aria-label="Reconciliation">
                  <thead>
                    <tr>
                      <th scope="col">Month</th>
                      <th scope="col">TDS deducted</th>
                      <th scope="col">Deposited</th>
                      <th scope="col">Difference</th>
                      <th scope="col">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliation.data.months.map((m) => (
                      <tr key={m.month}>
                        <td>{formatMonth(m.month)}</td>
                        <td>{amount(m.deducted)}</td>
                        <td>{amount(m.deposited)}</td>
                        <td>{amount(m.difference)}</td>
                        <td>{plain(m.status)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </Section>
      )}
      {manage && (
        <>
          <Section title="Enter a challan">
            <form
              className="grid-form"
              aria-label="Enter a challan"
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (!record.isPending) record.mutate();
              }}
            >
              <label>
                Month
                <input type="month" value={form.month} onChange={set('month')} required />
              </label>
              <label>
                Section
                <input value={form.section} onChange={set('section')} required maxLength={10} />
              </label>
              <label>
                BSR code
                <input value={form.bsrCode} onChange={set('bsrCode')} required maxLength={7} />
              </label>
              <label>
                Challan serial
                <input value={form.challanSerial} onChange={set('challanSerial')} required maxLength={5} />
              </label>
              <label>
                Deposit date
                <input type="date" value={form.depositDate} onChange={set('depositDate')} required />
              </label>
              <label>
                Amount
                <input value={form.amount} onChange={set('amount')} required inputMode="decimal" />
              </label>
              <button type="submit" disabled={record.isPending}>
                Record challan
              </button>
            </form>
            <ErrorNote error={record.error} />
          </Section>
          <UploadPanel template={TDS_CHALLAN_TEMPLATE} title="Upload TDS challans" fileLabel="Challan file" />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// CL-085 perquisites, CL-084 / CL-119 past salary
// ---------------------------------------------------------------------------------------------------------
interface TaxInputs {
  tdsProjection: { status: string; reason: string };
  items: {
    employeeId: string;
    employeeCode: string;
    employeeName: string;
    perquisites: { month: string; perquisiteType: string; value: string; revision: number }[];
    pastSalary: { source: string; fromMonth: string; toMonth: string; taxableSalary: string; tdsDeducted: string; revision: number }[];
  }[];
}

export function TaxInputsPage() {
  const { can } = useSession();
  const [year, setYear] = useState(fiscalYearOf(localDate()));
  const [search, setSearch] = useState('');
  const view = useQuery({
    queryKey: ['payroll-extras', 'tax-inputs', year, search],
    queryFn: () => api<TaxInputs>(`/v1/payroll-extras/tax-inputs?${new URLSearchParams({ fiscalYear: year, ...(search.trim() ? { search: search.trim() } : {}) })}`),
    enabled: can(TAX_READ),
  });
  if (!can(TAX_READ) && !can(TAX_IMPORT)) return <Empty>Perquisites and past salary need the payroll tax input duties.</Empty>;
  return (
    <>
      {can(TAX_READ) && (
        <Section title="Perquisites and past salary">
          {view.data && (
            <p className="hint" role="note">
              Tax projection: {plain(view.data.tdsProjection.status)}. {view.data.tdsProjection.reason}
            </p>
          )}
          <div className="filters">
            <label>
              Financial year
              <input value={year} onChange={(e) => setYear(e.target.value)} pattern="\d{4}-\d{2}" />
            </label>
            <label>
              Name or code
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
          </div>
          <ErrorNote error={view.error} />
          {view.data && view.data.items.length === 0 && <Empty>Nothing is recorded for {year}.</Empty>}
          {view.data && view.data.items.length > 0 && (
            <table aria-label="Recorded inputs">
              <thead>
                <tr>
                  <th scope="col">Employee</th>
                  <th scope="col">Perquisites</th>
                  <th scope="col">Past salary</th>
                </tr>
              </thead>
              <tbody>
                {view.data.items.map((i) => (
                  <tr key={i.employeeId}>
                    <td>
                      {i.employeeName} ({i.employeeCode})
                    </td>
                    <td>{i.perquisites.map((p) => `${formatMonth(p.month)} ${plain(p.perquisiteType)} ${amount(p.value)}`).join('; ') || '—'}</td>
                    <td>{i.pastSalary.map((s) => `${plain(s.source)} ${formatMonth(s.fromMonth)} to ${formatMonth(s.toMonth)}: salary ${amount(s.taxableSalary)}, TDS ${amount(s.tdsDeducted)}`).join('; ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>
      )}
      {can(TAX_IMPORT) && (
        <>
          <UploadPanel template={PERQUISITES_TEMPLATE} title="Upload perquisites" fileLabel="Perquisites file" />
          <UploadPanel template={PAST_SALARY_TEMPLATE} title="Upload past salary" fileLabel="Past salary file" />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// CL-113 medical claims
// ---------------------------------------------------------------------------------------------------------
interface MedicalRow {
  employee_code: string;
  employee_name: string;
  department: string;
  claim_id: string;
  claim_state: string;
  payment_state: string;
  expense_date: string;
  category: string;
  merchant: string;
  claimed_amount: string;
  approved_amount: string;
  currency: string;
  line: number;
}

export function MedicalClaimsPage() {
  const { can } = useSession();
  const today = localDate();
  const [filters, setFilters] = useState({ from: `${today.slice(0, 7)}-01`, to: today, search: '' });
  const [asked, setAsked] = useState(filters);
  const claims = useQuery({
    queryKey: ['payroll-extras', 'medical-claims', asked],
    queryFn: () => api<{ items: MedicalRow[] }>(`/v1/payroll-extras/medical-claims?${new URLSearchParams({ from: asked.from, to: asked.to, ...(asked.search.trim() ? { search: asked.search.trim() } : {}) })}`),
    enabled: can(MEDICAL_READ),
  });
  if (!can(MEDICAL_READ)) return <Empty>Medical claims need the expense read duty.</Empty>;
  return (
    <Section title="Medical claims">
      <p className="hint">Medical bills from submitted expense claims, listed by bill date.</p>
      <form
        className="filters"
        aria-label="Medical claim filters"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setAsked(filters);
        }}
      >
        <label>
          From
          <input type="date" value={filters.from} onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))} required />
        </label>
        <label>
          To
          <input type="date" value={filters.to} onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))} required />
        </label>
        <label>
          Search
          <input type="search" value={filters.search} onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
        </label>
        <button type="submit">Show</button>
      </form>
      <ErrorNote error={claims.error} />
      {claims.data && claims.data.items.length === 0 && <Empty>No medical claim in this period.</Empty>}
      {claims.data && claims.data.items.length > 0 && (
        <table aria-label="Medical claims">
          <thead>
            <tr>
              <th scope="col">Employee</th>
              <th scope="col">Department</th>
              <th scope="col">Bill date</th>
              <th scope="col">Category</th>
              <th scope="col">Merchant</th>
              <th scope="col">Claimed</th>
              <th scope="col">Approved</th>
              <th scope="col">Claim</th>
            </tr>
          </thead>
          <tbody>
            {claims.data.items.map((r) => (
              <tr key={`${r.claim_id}-${r.line}`}>
                <td>
                  {r.employee_name} ({r.employee_code})
                </td>
                <td>{r.department || '—'}</td>
                <td>{formatDate(r.expense_date)}</td>
                <td>{r.category}</td>
                <td>{r.merchant}</td>
                <td>{amount(r.claimed_amount)}</td>
                <td>{amount(r.approved_amount)}</td>
                <td>
                  {plain(r.claim_state)}, {plain(r.payment_state)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// CL-098 liability provisions
// ---------------------------------------------------------------------------------------------------------
interface Provisions {
  asOf: string;
  employees: number;
  items: { item: string; status: string; reason: string | null; totals: { currencyCode: string; amount: string }[]; rows: number; unresolved: number }[];
  departments: { departmentCode: string; department: string; currencyCode: string; amounts: Record<string, string>; total: string }[];
  rows: { item: string; status: string; employeeCode: string; employeeName: string; department: string; amount: string | null; vested: string; basis: string }[];
}

const ITEM_LABEL: Record<string, string> = { GRATUITY: 'Gratuity', STATUTORY_BONUS: 'Statutory bonus', LEAVE_ENCASHMENT: 'Leave encashment', NOTICE_PAY: 'Notice pay' };

export function LiabilityProvisionsPage() {
  const { can } = useSession();
  const [asOf, setAsOf] = useState(localDate());
  const [asked, setAsked] = useState(asOf);
  const data = useQuery({
    queryKey: ['payroll-extras', 'liability-provisions', asked],
    queryFn: () => api<Provisions>(`/v1/payroll-extras/liability-provisions?asOf=${encodeURIComponent(asked)}`),
    enabled: can(REPORT_READ) && can(SALARY_READ),
  });
  if (!can(REPORT_READ)) return <Empty>Liability provisions need the payroll report read duty.</Empty>;
  // Every figure is worked from salaries: the salary read duty too (and the salary history duty for an earlier date, which the server checks).
  if (!can(SALARY_READ)) return <Empty>Liability provisions are worked from salaries: they need the salary read duty as well.</Empty>;
  const d = data.data;
  return (
    <>
      <Section title="Liability provisions">
        <form
          className="filters"
          aria-label="As on"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            setAsked(asOf);
          }}
        >
          <label>
            As on
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} required />
          </label>
          <button type="submit">Show</button>
        </form>
        <ErrorNote error={data.error} />
        {d && (
          <table aria-label="Provision items">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Status</th>
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((i) => (
                <tr key={i.item}>
                  <td>{ITEM_LABEL[i.item] ?? i.item}</td>
                  <td>{i.status === 'CALCULATED' ? 'calculated' : `${plain(i.status)}: ${plain(i.reason ?? '')}`}</td>
                  <td>{i.status === 'CALCULATED' ? i.totals.map((t) => `${t.currencyCode} ${amount(t.amount)}`).join(', ') || '0.00' : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
      {d && d.departments.length > 0 && (
        <Section title="By department">
          <table aria-label="By department">
            <thead>
              <tr>
                <th scope="col">Department</th>
                {d.items.map((i) => (
                  <th scope="col" key={i.item}>
                    {ITEM_LABEL[i.item] ?? i.item}
                  </th>
                ))}
                <th scope="col">Total</th>
              </tr>
            </thead>
            <tbody>
              {d.departments.map((g) => (
                <tr key={`${g.departmentCode}-${g.currencyCode}`}>
                  <td>{g.department || 'No department'}</td>
                  {d.items.map((i) => (
                    <td key={i.item}>{amount(g.amounts[i.item])}</td>
                  ))}
                  <td>
                    {g.currencyCode} {amount(g.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
      {d && d.rows.length > 0 && (
        <Section title="Employees">
          <table aria-label="Employee provisions">
            <thead>
              <tr>
                <th scope="col">Employee</th>
                <th scope="col">Department</th>
                <th scope="col">Item</th>
                <th scope="col">Amount</th>
                <th scope="col">Basis</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r, n) => (
                <tr key={`${r.item}-${r.employeeCode}-${n}`}>
                  <td>
                    {r.employeeName} ({r.employeeCode})
                  </td>
                  <td>{r.department || '—'}</td>
                  <td>{ITEM_LABEL[r.item] ?? r.item}</td>
                  <td>{r.status === 'CALCULATED' ? amount(r.amount) : plain(r.status)}</td>
                  <td>
                    {r.basis}
                    {r.vested ? ` (vested: ${r.vested.toLowerCase()})` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// CL-097 GL mapping and salary JV
// ---------------------------------------------------------------------------------------------------------
interface GlMapping {
  id: string;
  revision: number;
  effectiveFrom: string;
  netPayAccountCode: string;
  netPayAccountName: string | null;
  lines: { componentCode: string; componentName: string; accountCode: string; accountName: string | null; payableAccountCode: string | null }[];
}

interface Jv {
  status: string;
  reason: string | null;
  periodCode: string;
  voucherDate: string;
  missing: { componentCode: string; problem: string }[];
  mappingRevision: number | null;
  lines: { side: string; accountCode: string; accountName: string; costCentre: string; componentCode: string; narration: string; amount: string }[];
  totals: { debit: string; credit: string; balanced: boolean } | null;
}

/** "CODE=ACCOUNT" or "CODE=ACCOUNT/PAYABLE" per line, as the mapping form takes them. */
export function parseMappingLines(text: string): { componentCode: string; accountCode: string; payableAccountCode?: string }[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [head = '', accounts = ''] = l.split('=').map((s) => s.trim());
      const [account = '', payable] = accounts.split('/').map((s) => s.trim());
      return { componentCode: head, accountCode: account, ...(payable ? { payableAccountCode: payable } : {}) };
    });
}

export function SalaryJvPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const mappings = useQuery({ queryKey: ['payroll-extras', 'gl-mappings'], queryFn: () => api<{ inForce: GlMapping | null; items: GlMapping[] }>('/v1/payroll-extras/gl-mappings'), enabled: can(MAPPING_READ) });
  const [form, setForm] = useState({ effectiveFrom: localDate(), netPayAccountCode: '', lines: '', reason: '' });
  const save = useMutation({
    mutationFn: () => api<GlMapping>('/v1/payroll-extras/gl-mappings', { body: { effectiveFrom: form.effectiveFrom, netPayAccountCode: form.netPayAccountCode, reason: form.reason, lines: parseMappingLines(form.lines) } }),
    onSuccess: () => {
      setForm((f) => ({ ...f, reason: '' }));
      void qc.invalidateQueries({ queryKey: ['payroll-extras'] });
    },
  });
  const [runId, setRunId] = useState('');
  const [shownRun, setShownRun] = useState('');
  // The runs a voucher can be prepared from (approved or processed), for a role that may list runs; others type the run's id.
  const runs = useQuery({
    queryKey: ['payroll-extras', 'jv-runs'],
    queryFn: () => api<{ items: { id: string; revision: number; state: string; periodCode: string }[] }>('/v1/payroll/runs?states=APPROVED,PROCESSED_LOCKED&page=1&pageSize=50'),
    enabled: can(REPORT_READ) && can(RUN_LIST),
    retry: false,
  });
  const pickable = runs.data?.items ?? [];
  const jv = useQuery({ queryKey: ['payroll-extras', 'salary-jv', shownRun], queryFn: () => api<Jv>(`/v1/payroll-extras/runs/${encodeURIComponent(shownRun)}/salary-jv`), enabled: shownRun !== '' && can(REPORT_READ) });
  const exportJv = useMutation({ mutationFn: () => api<{ id: string }>('/v1/reports', { body: { reportCode: 'SALARY_JV', filters: { runId: shownRun } } }) });
  if (!can(MAPPING_READ) && !can(REPORT_READ)) return <Empty>The salary JV needs the GL mapping or payroll report duties.</Empty>;
  const inForce = mappings.data?.inForce;
  return (
    <>
      {can(MAPPING_READ) && (
        <Section title="GL mapping">
          <ErrorNote error={mappings.error} />
          {mappings.isSuccess && !inForce && <Empty>No GL mapping is in force: the salary JV is not configured until the pay heads are mapped to your ledger accounts.</Empty>}
          {inForce && (
            <>
              <p className="hint">
                Revision {inForce.revision} from {formatDate(inForce.effectiveFrom)}. Net pay is credited to {inForce.netPayAccountCode}
                {inForce.netPayAccountName ? ` (${inForce.netPayAccountName})` : ''}; expenses carry the department as cost centre.
              </p>
              <table aria-label="Mapped heads">
                <thead>
                  <tr>
                    <th scope="col">Pay head</th>
                    <th scope="col">Account</th>
                    <th scope="col">Liability account</th>
                  </tr>
                </thead>
                <tbody>
                  {inForce.lines.map((l) => (
                    <tr key={l.componentCode}>
                      <td>
                        {l.componentName} ({l.componentCode})
                      </td>
                      <td>{l.accountCode}</td>
                      <td>{l.payableAccountCode ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Section>
      )}
      {can(MAPPING_MANAGE) && (
        <Section title="New mapping revision">
          <form
            className="grid-form"
            aria-label="New mapping revision"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              if (!save.isPending) save.mutate();
            }}
          >
            <label>
              Effective from
              <input type="date" value={form.effectiveFrom} onChange={(e) => setForm((f) => ({ ...f, effectiveFrom: e.target.value }))} required />
            </label>
            <label>
              Net pay account
              <input value={form.netPayAccountCode} onChange={(e) => setForm((f) => ({ ...f, netPayAccountCode: e.target.value }))} required maxLength={40} />
            </label>
            <label>
              Heads (one per line: HEAD=ACCOUNT, or HEAD=ACCOUNT/LIABILITY for an employer contribution)
              <textarea value={form.lines} onChange={(e) => setForm((f) => ({ ...f, lines: e.target.value }))} required rows={6} />
            </label>
            <label>
              Reason
              <input value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} required maxLength={500} />
            </label>
            <button type="submit" disabled={save.isPending}>
              Record mapping
            </button>
          </form>
          <ErrorNote error={save.error} />
        </Section>
      )}
      {can(REPORT_READ) && (
        <Section title="Salary JV">
          <form
            className="filters"
            aria-label="Payroll run"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              setShownRun(runId.trim());
              exportJv.reset();
            }}
          >
            {pickable.length > 0 ? (
              <label>
                Payroll run
                <select value={runId} onChange={(e) => setRunId(e.target.value)} required>
                  <option value="">Choose a run…</option>
                  {pickable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.periodCode} · revision {r.revision} · {r.state === 'APPROVED' ? 'approved' : 'processed'}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <label>
                Payroll run id
                <input value={runId} onChange={(e) => setRunId(e.target.value)} required />
              </label>
            )}
            <button type="submit">Show voucher</button>
          </form>
          <p className="hint">{pickable.length > 0 ? 'Approved and processed runs, most recent first.' : 'An approved or processed run; its id is on the payroll run’s page.'}</p>
          <ErrorNote error={jv.error} />
          {jv.data?.status === 'NOT_CONFIGURED' && (
            <p className="error" role="status">
              Not configured: {jv.data.reason === 'NO_GL_MAPPING' ? 'no GL mapping is in force for this period.' : `map ${jv.data.missing.map((m) => `${m.componentCode} (${plain(m.problem)})`).join(', ')}.`}
            </p>
          )}
          {jv.data?.status === 'READY' && jv.data.totals && (
            <>
              <table aria-label="Voucher">
                <thead>
                  <tr>
                    <th scope="col">Account</th>
                    <th scope="col">Cost centre</th>
                    <th scope="col">Narration</th>
                    <th scope="col">Debit</th>
                    <th scope="col">Credit</th>
                  </tr>
                </thead>
                <tbody>
                  {jv.data.lines.map((l, n) => (
                    <tr key={n}>
                      <td>
                        {l.accountCode}
                        {l.accountName ? ` ${l.accountName}` : ''}
                      </td>
                      <td>{l.costCentre || '—'}</td>
                      <td>{l.narration}</td>
                      <td>{l.side === 'DEBIT' ? amount(l.amount) : ''}</td>
                      <td>{l.side === 'CREDIT' ? amount(l.amount) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p role="status">
                {jv.data.periodCode}, dated {formatDate(jv.data.voucherDate)}: debits {amount(jv.data.totals.debit)}, credits {amount(jv.data.totals.credit)}
                {jv.data.totals.balanced ? ', balanced.' : ', NOT balanced.'}
              </p>
              {can(REPORT_EXPORT) && (
                <button type="button" disabled={exportJv.isPending} onClick={() => exportJv.mutate()}>
                  Request CSV / XLSX export
                </button>
              )}
              {exportJv.isSuccess && (
                <p role="status">
                  Export requested. Download it from <Link to="/reports">Reports</Link> once it is ready.
                </p>
              )}
              <ErrorNote error={exportJv.error} />
            </>
          )}
        </Section>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// CL-100 export for EDOC
// ---------------------------------------------------------------------------------------------------------
function EdocJob({ jobId }: { jobId: string }) {
  const job = useBulkJob(jobId);
  const save = useMutation({ mutationFn: () => download(`/v1/payroll-extras/edoc-exports/${encodeURIComponent(jobId)}/download`) });
  const j: BulkJob | undefined = job.data;
  return (
    <>
      <ErrorNote error={job.error} />
      {j && (
        <p role="status">
          {j.state === 'COMPLETED'
            ? `Ready: ${String(j.result.files ?? 0)} payslip PDFs for ${String(j.result.month ?? '')}.`
            : j.state === 'FAILED'
              ? `The export failed: ${jobErrorText(j.errorCode ?? 'Error')}`
              : `Preparing the payslips (${j.processed} so far)…`}
        </p>
      )}
      {j?.state === 'COMPLETED' && (
        <button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          Download ZIP
        </button>
      )}
      <ErrorNote error={save.error} />
    </>
  );
}

export function EdocExportPage() {
  const { can } = useSession();
  const today = localDate();
  const [month, setMonth] = useState(today.slice(0, 7));
  const [jobId, setJobId] = useState<string | null>(null);
  // One export of a month at a time: a repeat while it is open answers that export (existing), which is followed instead.
  const start = useMutation({
    mutationFn: () => api<{ jobId: string; existing?: boolean }>('/v1/payroll-extras/edoc-exports', { body: { month, idempotencyKey: idempotencyKey('edoc') } }),
    onSuccess: (r) => setJobId(r.jobId),
  });
  if (!can(EDOC_EXPORT)) return <Empty>Exporting payslips needs the payroll output export duty.</Empty>;
  return (
    <Section title="Export payslips for EDOC">
      <p className="hint">
        One PDF per issued payslip of the month (the current issue), for the employees in your scope and never your own, in one ZIP. It is prepared in the background; download it within 24 hours.
      </p>
      <form
        className="filters"
        aria-label="EDOC export"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (!start.isPending) start.mutate();
        }}
      >
        <label>
          Month
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} max={today.slice(0, 7)} required />
        </label>
        <button type="submit" disabled={start.isPending}>
          Prepare export
        </button>
      </form>
      <ErrorNote error={start.error} />
      {start.data?.existing && <p className="hint">Your export of this month is still open (being prepared, or ready to download): it is shown below instead of a new one.</p>}
      {jobId && <EdocJob key={jobId} jobId={jobId} />}
    </Section>
  );
}

export const PAYROLL_EXTRAS_SCREENS: readonly ScreenRoute[] = [
  { path: '/payroll/challan-master', title: 'Challan master', permission: CHALLAN_READ, nav: true, component: ChallanMasterPage },
  { path: '/payroll/tds-challans', title: 'TDS challans', permission: CHALLAN_READ, nav: true, component: TdsChallansPage },
  { path: '/payroll/tax-inputs', title: 'Perquisites and past salary', permission: TAX_READ, nav: true, component: TaxInputsPage },
  { path: '/payroll/medical-claims', title: 'Medical claims', permission: MEDICAL_READ, nav: true, staffOnly: true, component: MedicalClaimsPage },
  { path: '/payroll/liability-provisions', title: 'Liability provisions', permission: REPORT_READ, nav: true, component: LiabilityProvisionsPage },
  { path: '/payroll/salary-jv', title: 'GL mapping and salary JV', permission: MAPPING_READ, nav: true, component: SalaryJvPage },
  { path: '/payroll/edoc-export', title: 'Export payslips for EDOC', permission: EDOC_EXPORT, nav: true, component: EdocExportPage },
];
