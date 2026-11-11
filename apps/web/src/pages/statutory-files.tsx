// Statutory filing files, batch R4 (BRD coverage CL-093 TDS quarterly summary, CL-105 PF new joiners, CL-106 EPFO ECR, CL-107 ESIC
// monthly and half-yearly; FR-036, FR-039, FR-107, FR-108). One screen with an output selector: the period chooser, the status
// (NOT_CONFIGURED with what is missing, or AVAILABLE with row errors and totals), the download, and the format acceptance flow (one
// person sets a format up, another validates its synthetic sample and accepts it). Statutory content stays switched off until the owner's
// CA authorises the packs, so the screen mostly shows why a file is not configured, in the server's words; it computes nothing. Every
// action re-checks its own keys and the server re-checks every call.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, download, formatDate, localDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Section } from '../ui';

const STATUTORY_READ = 'payroll_statutory.read.operational';
const REPORT_READ = 'payroll_report.read.amount';
const REPORT_EXPORT = 'payroll_report.export.amount';
const PAYROLL_ID = 'employee.read.payroll_id';
const DEFINE = 'payroll_statutory_format.define.operational';
const ACCEPT = 'payroll_statutory_format.accept.operational';
/** GET /v1/payroll/runs needs the run read duty. */
const RUN_LIST = 'payroll_run.read.amount';

interface Missing {
  code: string;
  pack?: string;
  message: string;
}
interface Notice {
  code: string;
  count?: number;
  detail?: string;
}
export interface StatutoryOutput {
  code: string;
  title: string;
  clause: string;
  period: 'RUN' | 'QUARTER' | 'HALF_YEAR';
  packFamily: string;
  formats: string[];
  identifiers: boolean;
  upload: boolean;
  notice: string;
  status: 'AVAILABLE' | 'NOT_CONFIGURED';
  missing: Missing[];
  format: { id: string; revision: number; formatReference: string; effectiveFrom: string } | null;
}
interface FileStatus {
  status: 'AVAILABLE' | 'NOT_CONFIGURED';
  ready: boolean;
  missing: Missing[];
  selfIncluded?: boolean;
  rowCount?: number | null;
  rowErrors?: { employeeCode: string; code: string; field?: string }[];
  /** Rows with a UAN or IP number problem, counted only: listing them needs the payroll identifier read duty. */
  identifierErrorsWithheld?: number;
  warnings: Notice[];
  totals?: Record<string, string | number> | null;
  packs: { packCode: string; packRevision: number }[];
  files?: { format: string; fileName: string }[];
  format: { revision: number; formatReference: string; effectiveFrom: string } | null;
  period: { label: string; from: string; to: string };
}
interface Format {
  id: string;
  outputCode: string;
  revision: number;
  formatReference: string;
  effectiveFrom: string;
  state: 'AWAITING_VALIDATION' | 'ACCEPTED' | 'WITHDRAWN';
  sampleHash: string;
  validationReference: string | null;
  acceptedAt: string | null;
  withdrawalReason: string | null;
  note: string | null;
}
interface Sample {
  sampleHash: string;
  matchesRecorded: boolean;
  files: { format: string; fileName: string; content?: string }[];
}

/** What is missing, in plain words (the server's message stays beside it). */
export const MISSING_TEXT: Readonly<Record<string, string>> = {
  RULE_PACK_NOT_ACTIVE: 'The statutory pack has no active revision for the period. Statutory packs stay switched off until the CA authorises them.',
  RULE_PACK_NOT_PINNED: 'The payroll run valued nothing under this pack.',
  FORMAT_NOT_ACCEPTED: 'No accepted format is in force: one person sets it up below, another validates its sample and accepts it.',
  FORMAT_SAMPLE_CHANGED: 'The layout changed since the format was accepted: set up a new revision and have its sample validated.',
};

/** Row errors, in plain words. */
export const ROW_ERROR_TEXT: Readonly<Record<string, string>> = {
  MISSING_UAN: 'No UAN is recorded',
  INVALID_UAN: 'The UAN is not 12 digits',
  MISSING_IP_NUMBER: 'No ESIC IP number is recorded',
  INVALID_IP_NUMBER: 'The ESIC IP number is not 10 digits',
  IDENTIFIERS_UNREADABLE: 'The payroll identifiers could not be read',
  MISSING_NAME: 'The name is missing',
  INVALID_NAME: 'The name holds characters the layout cannot carry',
  NAME_NOT_ALPHABETIC: 'ESIC takes letters and spaces only in the name',
  NCP_DAYS_NOT_WHOLE: 'The loss-of-pay days are not whole days',
  DAYS_NOT_WHOLE: 'The days paid are not whole days',
  ROUNDING_NOT_RECORDED: 'The PF rounding was not recorded',
  EPS_NOT_RECORDED: 'No pension (EPS) head was valued',
  EDLI_NOT_RECORDED: 'No EDLI head was valued',
  EPF_EPS_DIFFERENCE_NOT_RECORDED: 'No employer EPF head was valued',
  AMOUNT_NOT_WHOLE: 'A contribution is not in whole rupees',
  WAGES_PRECISION: 'The wages have more than two decimals',
  ESIC_WAGES_NOT_RECORDED: 'The ESIC wages were not recorded',
  REASON_CODE_NOT_RECORDED: 'No day was paid and no reason is recorded',
  DUPLICATE_STATUTORY_ROW: 'Two heads carry the same statutory output',
  SLAB_NOT_RECORDED: 'The slab was not recorded',
};

const PERIOD_WORDS: Readonly<Record<StatutoryOutput['period'], string>> = { RUN: 'a processed payroll run', QUARTER: 'a quarter', HALF_YEAR: 'a contribution period' };
const STATE_WORDS: Readonly<Record<Format['state'], string>> = { AWAITING_VALIDATION: 'awaiting validation', ACCEPTED: 'accepted', WITHDRAWN: 'withdrawn' };
const plain = (code: string) => code.replace(/_/g, ' ').toLowerCase();
const label = (key: string) => key.replace(/([A-Z])/g, ' $1').toLowerCase();

/** The financial year (April to March) of a day, written 2026-27. */
export function fiscalYearOf(day: string): string {
  const y = Number(day.slice(0, 4));
  const start = Number(day.slice(5, 7)) >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** The status and file query of a period. */
export function periodQuery(kind: StatutoryOutput['period'], p: { runId: string; fiscalYear: string; quarter: string; half: string }): string {
  if (kind === 'RUN') return `runId=${encodeURIComponent(p.runId.trim())}`;
  return kind === 'QUARTER' ? `fiscalYear=${encodeURIComponent(p.fiscalYear)}&quarter=${p.quarter}` : `fiscalYear=${encodeURIComponent(p.fiscalYear)}&half=${p.half}`;
}

function MissingList({ missing }: { missing: Missing[] }) {
  return (
    <div className="error" role="status">
      <strong>Not configured.</strong>
      <ul>
        {missing.map((m) => (
          <li key={`${m.code}-${m.pack ?? ''}`}>
            {MISSING_TEXT[m.code] ?? plain(m.code)} ({m.message})
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// A period's status and its file
// ---------------------------------------------------------------------------------------------------------
function PeriodFile({ output }: { output: StatutoryOutput }) {
  const { can } = useSession();
  const today = localDate();
  const month = Number(today.slice(5, 7));
  const [form, setForm] = useState({ runId: '', fiscalYear: fiscalYearOf(today), quarter: String(month >= 4 ? Math.ceil((month - 3) / 3) : 4), half: month >= 4 && month <= 9 ? '1' : '2' });
  const [shown, setShown] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ['statutory-files', 'runs'],
    queryFn: () => api<{ items: { id: string; revision: number; periodCode: string }[] }>('/v1/payroll/runs?states=PROCESSED_LOCKED&page=1&pageSize=50'),
    enabled: output.period === 'RUN' && can(RUN_LIST),
    retry: false,
  });
  const status = useQuery({
    queryKey: ['statutory-files', 'status', output.code, shown],
    queryFn: () => api<FileStatus>(`/v1/statutory-files/outputs/${output.code}/status?${shown}`),
    enabled: shown !== null,
  });
  const save = useMutation({ mutationFn: (format: string) => download(`/v1/statutory-files/outputs/${output.code}/file?${shown}&format=${format}`) });
  const pickable = runs.data?.items ?? [];
  const mayDownload = can(REPORT_EXPORT) && (!output.identifiers || can(PAYROLL_ID));
  const s = status.data;
  return (
    <Section title="File for a period">
      <form
        className="filters"
        aria-label="Period"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          save.reset();
          setShown(periodQuery(output.period, form));
        }}
      >
        {output.period === 'RUN' &&
          (pickable.length > 0 ? (
            <label>
              Payroll run
              <select value={form.runId} onChange={(e) => setForm((f) => ({ ...f, runId: e.target.value }))} required>
                <option value="">Choose a run…</option>
                {pickable.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.periodCode} · revision {r.revision}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Payroll run id
              <input value={form.runId} onChange={(e) => setForm((f) => ({ ...f, runId: e.target.value }))} required />
            </label>
          ))}
        {output.period !== 'RUN' && (
          <label>
            Financial year
            <input value={form.fiscalYear} onChange={(e) => setForm((f) => ({ ...f, fiscalYear: e.target.value }))} required pattern="\d{4}-\d{2}" placeholder="2026-27" />
          </label>
        )}
        {output.period === 'QUARTER' && (
          <label>
            Quarter
            <select value={form.quarter} onChange={(e) => setForm((f) => ({ ...f, quarter: e.target.value }))}>
              <option value="1">Q1 (April to June)</option>
              <option value="2">Q2 (July to September)</option>
              <option value="3">Q3 (October to December)</option>
              <option value="4">Q4 (January to March)</option>
            </select>
          </label>
        )}
        {output.period === 'HALF_YEAR' && (
          <label>
            Contribution period
            <select value={form.half} onChange={(e) => setForm((f) => ({ ...f, half: e.target.value }))}>
              <option value="1">April to September</option>
              <option value="2">October to March</option>
            </select>
          </label>
        )}
        <button type="submit">Show status</button>
      </form>
      <p className="hint">
        {output.period === 'RUN'
          ? pickable.length > 0
            ? 'Processed (locked) runs, most recent first.'
            : 'A processed (locked) run; its id is on the payroll run’s page.'
          : `Every processed payroll run of ${PERIOD_WORDS[output.period]} is read.`}
      </p>
      {!can(REPORT_READ) && <p className="hint">The status of a period needs the payroll report duty.</p>}
      <ErrorNote error={status.error} />
      {s?.status === 'NOT_CONFIGURED' && <MissingList missing={s.missing} />}
      {s?.status === 'AVAILABLE' && (
        <div role="status" aria-label="File status">
          <p>
            Available for {s.period.label} ({formatDate(s.period.from)} to {formatDate(s.period.to)}), from {s.packs.map((p) => `${p.packCode} revision ${p.packRevision}`).join(', ') || 'no pinned pack'} in the accepted format{' '}
            {s.format ? `${s.format.formatReference} (revision ${s.format.revision})` : ''}.
          </p>
          {s.selfIncluded && <p className="error">Your own pay is in this file: someone else must produce it.</p>}
          {s.rowCount !== null && s.rowCount !== undefined && <p>{s.rowCount === 1 ? '1 row.' : `${s.rowCount} rows.`}</p>}
          {s.totals && (
            <table aria-label="Totals">
              <tbody>
                {Object.entries(s.totals).map(([key, value]) => (
                  <tr key={key}>
                    <th scope="row">{label(key)}</th>
                    <td>{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {s.warnings.length > 0 && (
            <ul className="hint" aria-label="Notes">
              {s.warnings.map((w, i) => (
                <li key={`${w.code}-${i}`}>
                  {w.detail ?? plain(w.code)}
                  {w.count !== undefined ? ` (${w.count})` : ''}
                </li>
              ))}
            </ul>
          )}
          {s.rowErrors && s.rowErrors.length > 0 && (
            <>
              <p className="error">No file is produced while a row has an error. Correct these and show the status again.</p>
              <table aria-label="Row errors">
                <thead>
                  <tr>
                    <th scope="col">Employee</th>
                    <th scope="col">Problem</th>
                  </tr>
                </thead>
                <tbody>
                  {s.rowErrors.map((r, i) => (
                    <tr key={`${r.employeeCode}-${r.code}-${i}`}>
                      <td>{r.employeeCode}</td>
                      <td>
                        {ROW_ERROR_TEXT[r.code] ?? plain(r.code)}
                        {r.field && !ROW_ERROR_TEXT[r.code] ? ` (${r.field})` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {(s.identifierErrorsWithheld ?? 0) > 0 && (
            <p className="error">
              {s.identifierErrorsWithheld === 1 ? '1 row has' : `${s.identifierErrorsWithheld} rows have`} a missing, invalid or unreadable UAN or IP number. No file is produced until it is
              corrected; seeing which needs the payroll identifier read duty.
            </p>
          )}
          {s.ready && mayDownload && (
            <div className="filters">
              {(s.files ?? []).map((f) => (
                <button key={f.format} type="button" disabled={save.isPending} onClick={() => save.mutate(f.format)}>
                  Download {f.format.toUpperCase()}
                </button>
              ))}
            </div>
          )}
          {s.ready && !mayDownload && <p className="hint">Downloading needs the payroll report export duty{output.identifiers ? ' and the payroll identifier read duty (the file carries UAN or IP numbers)' : ''}.</p>}
          {s.ready && <p className="hint">The file name says which pinned pack revisions it was produced from. Every download is recorded.</p>}
        </div>
      )}
      <ErrorNote error={save.error} />
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// The format acceptance flow
// ---------------------------------------------------------------------------------------------------------
function FormatSample({ format }: { format: Format }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const [reference, setReference] = useState('');
  const sample = useQuery({ queryKey: ['statutory-files', 'sample', format.id], queryFn: () => api<Sample>(`/v1/statutory-files/formats/${format.id}/sample`) });
  const save = useMutation({ mutationFn: (f: string) => download(`/v1/statutory-files/formats/${format.id}/sample/${f}`) });
  const accept = useMutation({
    mutationFn: () => api<Format>(`/v1/statutory-files/formats/${format.id}/acceptance`, { body: { sampleHash: sample.data!.sampleHash, validationReference: reference } }),
    onSuccess: () => {
      setReference('');
      void qc.invalidateQueries({ queryKey: ['statutory-files'] });
    },
  });
  return (
    <div aria-label={`Sample of revision ${format.revision}`}>
      <ErrorNote error={sample.error} />
      {sample.data && (
        <>
          <p className="hint">
            Synthetic rows, not for filing, rendered exactly as a file would be. Sample hash {sample.data.sampleHash}.
            {!sample.data.matchesRecorded && ' This build renders a different sample than the format was set up with: set up a new revision.'}
          </p>
          {sample.data.files
            .filter((f) => f.content !== undefined)
            .map((f) => (
              <pre key={f.format} aria-label={`Sample ${f.format}`}>
                {f.content}
              </pre>
            ))}
          <div className="filters">
            {sample.data.files.map((f) => (
              <button key={f.format} type="button" disabled={save.isPending} onClick={() => save.mutate(f.format)}>
                Download sample {f.format.toUpperCase()}
              </button>
            ))}
          </div>
          <ErrorNote error={save.error} />
          {can(ACCEPT) && sample.data.matchesRecorded && (
            <form
              className="grid-form"
              aria-label={`Accept revision ${format.revision}`}
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                if (!accept.isPending) accept.mutate();
              }}
            >
              <label>
                Validation reference
                <input value={reference} onChange={(e) => setReference(e.target.value)} required maxLength={500} placeholder="For example the portal validator’s run or the CA’s note" />
              </label>
              <button type="submit" disabled={accept.isPending}>
                Accept this format
              </button>
            </form>
          )}
          <ErrorNote error={accept.error} />
        </>
      )}
    </div>
  );
}

function Withdraw({ format }: { format: Format }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const withdraw = useMutation({
    mutationFn: () => api<Format>(`/v1/statutory-files/formats/${format.id}/withdrawal`, { body: { reason } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['statutory-files'] }),
  });
  return (
    <form
      className="filters"
      aria-label={`Withdraw revision ${format.revision}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!withdraw.isPending) withdraw.mutate();
      }}
    >
      <label>
        Reason
        <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
      </label>
      <button type="submit" disabled={withdraw.isPending}>
        Withdraw
      </button>
      <ErrorNote error={withdraw.error} />
    </form>
  );
}

function OutputFormats({ output }: { output: StatutoryOutput }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const formats = useQuery({
    queryKey: ['statutory-files', 'formats', output.code],
    queryFn: () => api<{ inForce: { format: Format | null; sampleCurrent: boolean | null }[]; items: Format[] }>(`/v1/statutory-files/formats?outputCode=${output.code}`),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ formatReference: '', effectiveFrom: localDate(), note: '' });
  const create = useMutation({
    mutationFn: () => api<Format>('/v1/statutory-files/formats', { body: { outputCode: output.code, formatReference: form.formatReference, effectiveFrom: form.effectiveFrom, note: form.note || null } }),
    onSuccess: (f) => {
      setForm((x) => ({ ...x, formatReference: '', note: '' }));
      setOpen(f.id);
      void qc.invalidateQueries({ queryKey: ['statutory-files'] });
    },
  });
  const inForce = formats.data?.inForce[0];
  return (
    <Section title="Accepted format">
      <p className="hint">
        A format is the published layout the company files to (for example ECR 2.0). One person sets it up; another validates its synthetic sample against the portal’s validator or the specification and
        accepts it with a reference. Formats are never edited: a change is a new revision.
      </p>
      <ErrorNote error={formats.error} />
      {formats.isSuccess && !inForce?.format && <Empty>No accepted format is in force for this output.</Empty>}
      {inForce?.format && (
        <p role="status">
          In force: {inForce.format.formatReference} (revision {inForce.format.revision}, from {formatDate(inForce.format.effectiveFrom)}){inForce.sampleCurrent === false ? ', but the layout has changed since: it does not apply.' : '.'}
        </p>
      )}
      {formats.data && formats.data.items.length > 0 && (
        <table aria-label="Format revisions">
          <thead>
            <tr>
              <th scope="col">Revision</th>
              <th scope="col">Format reference</th>
              <th scope="col">From</th>
              <th scope="col">State</th>
              <th scope="col">Validation reference</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {formats.data.items.map((f) => (
              <tr key={f.id}>
                <td>{f.revision}</td>
                <td>{f.formatReference}</td>
                <td>{formatDate(f.effectiveFrom)}</td>
                <td>{STATE_WORDS[f.state]}</td>
                <td>{f.validationReference ?? f.withdrawalReason ?? '—'}</td>
                <td>
                  {f.state === 'AWAITING_VALIDATION' && (
                    <button type="button" onClick={() => setOpen(open === f.id ? null : f.id)}>
                      {open === f.id ? 'Hide sample' : 'Sample'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {formats.data?.items
        .filter((f) => f.id === open && f.state === 'AWAITING_VALIDATION')
        .map((f) => (
          <FormatSample key={f.id} format={f} />
        ))}
      {can(ACCEPT) &&
        formats.data?.items
          .filter((f) => f.state !== 'WITHDRAWN')
          .map((f) => <Withdraw key={f.id} format={f} />)}
      {can(DEFINE) && (
        <form
          className="grid-form"
          aria-label="Set up a format"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (!create.isPending) create.mutate();
          }}
        >
          <label>
            Format reference
            <input value={form.formatReference} onChange={(e) => setForm((x) => ({ ...x, formatReference: e.target.value }))} required maxLength={200} />
          </label>
          <label>
            Effective from
            <input type="date" value={form.effectiveFrom} onChange={(e) => setForm((x) => ({ ...x, effectiveFrom: e.target.value }))} required />
          </label>
          <label>
            Note
            <input value={form.note} onChange={(e) => setForm((x) => ({ ...x, note: e.target.value }))} maxLength={500} />
          </label>
          <button type="submit" disabled={create.isPending}>
            Set up format
          </button>
          <ErrorNote error={create.error} />
        </form>
      )}
    </Section>
  );
}

export function StatutoryFilesPage() {
  const { can } = useSession();
  const outputs = useQuery({ queryKey: ['statutory-files', 'outputs'], queryFn: () => api<{ items: StatutoryOutput[] }>('/v1/statutory-files/outputs'), enabled: can(STATUTORY_READ) });
  const [code, setCode] = useState('');
  if (!can(STATUTORY_READ)) return <Empty>Statutory files need the statutory output read duty.</Empty>;
  const items = outputs.data?.items ?? [];
  const output = items.find((o) => o.code === code) ?? items[0];
  return (
    <>
      <Section title="Statutory files">
        <ErrorNote error={outputs.error} />
        {output && (
          <>
            <form className="filters" aria-label="Output" onSubmit={(e: FormEvent) => e.preventDefault()}>
              <label>
                Output
                <select value={output.code} onChange={(e) => setCode(e.target.value)}>
                  {items.map((o) => (
                    <option key={o.code} value={o.code}>
                      {o.title} ({o.clause})
                    </option>
                  ))}
                </select>
              </label>
            </form>
            <p className="hint">{output.notice}</p>
            {output.status === 'NOT_CONFIGURED' ? <MissingList missing={output.missing} /> : <p role="status">Configured today: an active pack and an accepted format are in force.</p>}
          </>
        )}
      </Section>
      {output && <PeriodFile key={`file-${output.code}`} output={output} />}
      {output && <OutputFormats key={`formats-${output.code}`} output={output} />}
    </>
  );
}

export const STATUTORY_FILE_SCREENS: readonly ScreenRoute[] = [{ path: '/payroll/statutory/files', title: 'Statutory files', permission: STATUTORY_READ, nav: true, component: StatutoryFilesPage }];
