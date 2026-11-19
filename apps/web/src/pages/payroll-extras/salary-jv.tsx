// The GL mapping and salary JV screen (CL-097).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, formatDate, localDate } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section } from '../../ui';
import { amount, MAPPING_MANAGE, MAPPING_READ, plain, REPORT_EXPORT, REPORT_READ, RUN_LIST } from './shared';

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
