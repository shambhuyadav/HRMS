// Payroll run reports (FR-038) and statutory outputs (FR-039), with their report catalogue exports.

import { useMutation, useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, download, formatDate, formatMonth, readable, retryTransient } from '../../api';
import { isReportRefusal } from '../../report-failures';
import { useSession } from '../../session';
import { Badge, Empty, Section } from '../../ui';
import { ACT_REFUSALS, Problem } from './problems';
import { ComponentTable } from './run-detail';
import { BATCH_STATE, Fact, FLUSH, label, money, PATHS, PAYMENT_STATE, REPORT_EXPORT, REPORT_READ, RUN_STATE, SCROLL, Status, STATUTORY_READ, useKeys } from './shared';
import type { RunComponents } from './types';

// =========================================================================================================
// Reports (FR-038) and statutory outputs (FR-039): exactly as returned, nothing computed here
// =========================================================================================================

interface ReportRun {
  id: string;
  periodCode: string;
  revision: number;
  state: string;
  currencyCode: string;
  lockVersion: number | null;
  processedAt: string | null;
}
interface RegisterRow {
  recordId: string;
  employeeCode: string;
  employeeName: string;
  calculationStatus: string;
  salaryStopMode?: string | null;
  paidUnits: string | null;
  earnings: string | null;
  reimbursements: string | null;
  deductions: string | null;
  net: string | null;
  employerContributions: string | null;
  bankStatus: string | null;
  held: string;
  reserved: string;
  paid: string;
}
interface Register {
  run: ReportRun;
  scope: string;
  totals: { records: number; earnings: string; reimbursements: string; deductions: string; net: string; employerContributions: string; held: string; reserved: string; paid: string };
  items: RegisterRow[];
  next: string | null;
}
interface Disbursement {
  run: ReportRun;
  totals: { payable: string; held: string; heldBySalaryStop?: string; salaryStopHolds?: number; excludedBySalaryStop?: number; reserved: string; paid: string; ready: string; reconciles: boolean };
  salaryStopExclusions?: { employeeCode: string; employeeName: string; mode: string }[];
  manifests: { id: string; templateCode: string; templateVersion: number; batchRevision: number; state: string; lineCount: number; totalAmount: string | null; ledger: { paymentState: string; lines: number; amount: string | null }[] }[];
  paymentStatusSource: string;
}
interface StatutoryRow {
  code: string;
  sourceLabel: string;
  status: string;
  needs: string[];
}

const registerPath = (runId: string, after: string) => `/v1/payroll-outputs/runs/${encodeURIComponent(runId)}/register${after ? `?after=${encodeURIComponent(after)}` : ''}`;

/** A report execution as GET /v1/reports/:id returns it. */
interface ReportExecution {
  id: string;
  reportCode: string;
  state: string;
  rowCount: number | null;
  failureCode: string | null;
  format?: string;
}
const EXPORT_FORMATS = ['CSV', 'XLSX'] as const;
const EXPORT_STATE: Record<string, string> = {
  QUEUED: 'Queued: it is generated in the background',
  RUNNING: 'Being generated',
  COMPLETED: 'Ready to download',
  FAILED: 'Failed: nothing was generated',
  EXPIRED: 'Expired: request it again',
};

/**
 * FR-038 export of one run report through the report catalogue (PAYROLL_REGISTER, PAYROLL_DISBURSEMENT,
 * PAYROLL_COMPARISON): the same rows as the report shown above, generated in the background as CSV or XLSX; the
 * download re-checks access. Offered only with the export key.
 */
function RunReportExport({ runId, reportCode, name }: { runId: string; reportCode: string; name: string }) {
  const { can } = useSession();
  const [format, setFormat] = useState<string>('CSV');
  const [requested, setRequested] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: (chosen: string) => api<{ id: string }>('/v1/reports', { body: { reportCode, filters: { runId }, format: chosen } }),
    onSuccess: (r) => setRequested(r.id),
  });
  if (!can(REPORT_EXPORT)) return null;
  return (
    <div style={{ marginTop: '0.5rem' }}>
      <form
        className="row"
        aria-label={`Export the ${name}`}
        onSubmit={(e) => {
          e.preventDefault();
          request.mutate(format);
        }}
      >
        <label className="inline">
          Format
          <select value={format} onChange={(e) => setFormat(e.target.value)}>
            {EXPORT_FORMATS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="secondary" disabled={request.isPending}>
          {`Export the ${name}`}
        </button>
      </form>
      <Problem error={request.error} act="export" />
      {requested && <RunReportExportStatus key={requested} id={requested} name={name} />}
    </div>
  );
}

function RunReportExportStatus({ id, name }: { id: string; name: string }) {
  const keys = useKeys();
  const [error, setError] = useState<unknown>(null);
  const status = useQuery({
    queryKey: keys.reportExport(id),
    queryFn: () => api<ReportExecution>(`/v1/reports/${encodeURIComponent(id)}`),
    refetchInterval: (q) => (!isReportRefusal(q.state.error) && (q.state.data?.state === 'QUEUED' || q.state.data?.state === 'RUNNING') ? 3000 : false),
    retry: retryTransient,
  });
  const s = status.data;
  const format = s?.format ?? 'CSV';
  return (
    <div role="status" aria-label={`Export of the ${name}`}>
      {s ? (
        <p style={FLUSH}>
          {label(EXPORT_STATE, s.state)}
          {s.rowCount !== null && ` · ${s.rowCount} ${s.rowCount === 1 ? 'row' : 'rows'}`}
          {s.state === 'FAILED' && s.failureCode && ` · ${label(ACT_REFUSALS.export ?? {}, s.failureCode)}`}{' '}
          {s.state === 'COMPLETED' && (
            <button type="button" className="link" onClick={() => download(`/v1/reports/${encodeURIComponent(id)}/download`).catch(setError)}>
              {`Download ${format}`}
            </button>
          )}
        </p>
      ) : (
        !status.error && <p className="hint">Checking the export…</p>
      )}
      <Problem error={status.error} act="read" />
      <Problem error={error} act="download" />
    </div>
  );
}

export function RunReportsScreen() {
  const { can } = useSession();
  const { id = '' } = useParams();
  if (!can(REPORT_READ)) {
    return (
      <Section title="Payroll reports">
        <Empty>The selected role cannot see payroll reports.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack" key={id}>
      <p style={FLUSH}>
        <Link to={PATHS.run(id)}>Back to the payroll run</Link>
        {can(STATUTORY_READ) && (
          <>
            {' · '}
            <Link to={PATHS.statutory}>Statutory outputs</Link>
          </>
        )}
      </p>
      <RegisterReport runId={id} />
      <DisbursementReport runId={id} />
      <ComparisonReport runId={id} />
      <JournalReport runId={id} />
      <StatutoryRegisters runId={id} />
      {/* FR-038 reimbursement register (I-40 item 11, I-89 item 1): an export only, under the same export key. */}
      {can(REPORT_EXPORT) && (
        <Section title="Reimbursement register">
          <p className="hint">Each reimbursement line of the run’s calculated records; the columns await the owner’s approval with samples.</p>
          <RunReportExport runId={id} reportCode="REIMBURSEMENT_REGISTER" name="reimbursement register" />
        </Section>
      )}
    </div>
  );
}

function RegisterReport({ runId }: { runId: string }) {
  const keys = useKeys();
  const [after, setAfter] = useState('');
  const [previous, setPrevious] = useState<string[]>([]);
  const register = useQuery({ queryKey: keys.register(runId, after), queryFn: () => api<Register>(registerPath(runId, after)), retry: retryTransient });
  const d = register.data;
  const cur = d?.run.currencyCode;
  return (
    <Section title="Payroll register">
      {register.isPending && <p className="hint loading">Loading the register…</p>}
      {register.error && <Problem error={register.error} act="read" />}
      {d && (
        <>
          <dl className="kv">
            <Fact term="Run">{`${d.run.periodCode} revision ${d.run.revision}`}</Fact>
            <Fact term="State">
              <Status map={RUN_STATE} code={d.run.state} />
            </Fact>
            <Fact term="Lock version">{d.run.lockVersion ?? '—'}</Fact>
            <Fact term="Processed">{formatDate(d.run.processedAt)}</Fact>
          </dl>
          {d.scope === 'ROW_SCOPE' && <p className="hint">Only the records within your scope are listed and totalled.</p>}
          <dl className="kv" aria-label="Register totals">
            <Fact term="Records">{d.totals.records}</Fact>
            <Fact term="Earnings">{money(d.totals.earnings, cur)}</Fact>
            <Fact term="Reimbursements">{money(d.totals.reimbursements, cur)}</Fact>
            <Fact term="Deductions">{money(d.totals.deductions, cur)}</Fact>
            <Fact term="Net">{money(d.totals.net, cur)}</Fact>
            <Fact term="Employer contributions">{money(d.totals.employerContributions, cur)}</Fact>
            <Fact term="Held">{money(d.totals.held, cur)}</Fact>
            <Fact term="Reserved, not paid">{money(d.totals.reserved, cur)}</Fact>
            <Fact term="Paid (confirmed from bank evidence)">{money(d.totals.paid, cur)}</Fact>
          </dl>
          {d.items.length === 0 && <Empty>No records in this register.</Empty>}
          {d.items.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Payroll register">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Calculation</th>
                    <th>Salary stop</th>
                    <th>Paid units</th>
                    <th>Earnings</th>
                    <th>Deductions</th>
                    <th>Net</th>
                    <th>Held</th>
                    <th>Reserved, not paid</th>
                    <th>Paid (confirmed)</th>
                    <th>Bank</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((r) => (
                    <tr key={r.recordId}>
                      <td>{`${r.employeeCode} ${r.employeeName}`}</td>
                      <td>{readable(r.calculationStatus)}</td>
                      <td>{r.salaryStopMode ? readable(r.salaryStopMode) : '—'}</td>
                      <td>{r.paidUnits ?? '—'}</td>
                      <td>{money(r.earnings, cur)}</td>
                      <td>{money(r.deductions, cur)}</td>
                      <td>{money(r.net, cur)}</td>
                      <td>{money(r.held, cur)}</td>
                      <td>{money(r.reserved, cur)}</td>
                      <td>{money(r.paid, cur)}</td>
                      <td>{r.bankStatus ? readable(r.bankStatus) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row" style={{ marginTop: '0.5rem' }}>
            {previous.length > 0 && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setAfter(previous[previous.length - 1] ?? '');
                  setPrevious(previous.slice(0, -1));
                }}
              >
                Previous page
              </button>
            )}
            {d.next && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  setPrevious([...previous, after]);
                  setAfter(d.next ?? '');
                }}
              >
                Next page
              </button>
            )}
          </div>
        </>
      )}
      <RunReportExport runId={runId} reportCode="PAYROLL_REGISTER" name="payroll register" />
    </Section>
  );
}

function DisbursementReport({ runId }: { runId: string }) {
  const keys = useKeys();
  const report = useQuery({ queryKey: keys.disbursement(runId), queryFn: () => api<Disbursement>(`/v1/payroll-outputs/runs/${encodeURIComponent(runId)}/disbursement`), retry: retryTransient });
  const d = report.data;
  const cur = d?.run.currencyCode;
  return (
    <Section title="Disbursement reconciliation">
      {report.isPending && <p className="hint loading">Loading the reconciliation…</p>}
      {report.error && <Problem error={report.error} act="read" />}
      {d && (
        <>
          <dl className="kv" aria-label="Reconciliation totals">
            <Fact term="Approved payable">{money(d.totals.payable, cur)}</Fact>
            <Fact term="Held">{money(d.totals.held, cur)}</Fact>
            {/* FR-031: what salary stops withhold, a part of Held, apart from policy holds and payment safety blocks. */}
            {(d.totals.salaryStopHolds ?? 0) > 0 && <Fact term="Of held, by salary stop">{`${money(d.totals.heldBySalaryStop ?? '0', cur)} for ${d.totals.salaryStopHolds} ${d.totals.salaryStopHolds === 1 ? 'employee' : 'employees'}`}</Fact>}
            <Fact term="Reserved, not paid">{money(d.totals.reserved, cur)}</Fact>
            <Fact term="Paid (confirmed from bank evidence)">{money(d.totals.paid, cur)}</Fact>
            <Fact term="Ready to pay">{money(d.totals.ready, cur)}</Fact>
            {/* FR-031: no net, so in none of the figures above. */}
            {(d.salaryStopExclusions?.length ?? 0) > 0 && (
              <Fact term="Excluded from calculation by a salary stop">{d.salaryStopExclusions!.map((x) => `${x.employeeCode} ${x.employeeName}`).join(', ')}</Fact>
            )}
            <Fact term="Reconciles">
              {d.totals.reconciles ? <Badge tone="good">Yes: payable equals held, reserved, paid and ready</Badge> : <Badge tone="bad">No: the figures do not reconcile; report this</Badge>}
            </Fact>
          </dl>
          {d.paymentStatusSource === 'RECORDED_OUTCOME_EVIDENCE_ONLY' && <p className="hint">Payment status comes only from the outcomes recorded from bank evidence.</p>}
          {d.manifests.length === 0 && <Empty>No bank manifest for this run yet.</Empty>}
          {d.manifests.length > 0 && (
            <div style={SCROLL}>
              <table aria-label="Manifests of the run">
                <thead>
                  <tr>
                    <th>Template</th>
                    <th>Manifest revision</th>
                    <th>State</th>
                    <th>Lines</th>
                    <th>Total</th>
                    <th>Payment states</th>
                  </tr>
                </thead>
                <tbody>
                  {d.manifests.map((m) => (
                    <tr key={m.id}>
                      <td>{`${m.templateCode} version ${m.templateVersion}`}</td>
                      <td>{m.batchRevision}</td>
                      <td>
                        <Status map={BATCH_STATE} code={m.state} />
                      </td>
                      <td>{m.lineCount}</td>
                      <td>{money(m.totalAmount, cur)}</td>
                      <td>{m.ledger.length === 0 ? '—' : m.ledger.map((l) => `${label(PAYMENT_STATE, l.paymentState)}: ${l.lines} ${l.lines === 1 ? 'line' : 'lines'}, ${money(l.amount, cur)}`).join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      <RunReportExport runId={runId} reportCode="PAYROLL_DISBURSEMENT" name="reconciliation totals" />
    </Section>
  );
}

function ComparisonReport({ runId }: { runId: string }) {
  const keys = useKeys();
  // The currency of the run comes with the register's first page (the same cached answer).
  const header = useQuery({ queryKey: keys.register(runId, ''), queryFn: () => api<Register>(registerPath(runId, '')), retry: retryTransient });
  const report = useQuery({ queryKey: keys.comparison(runId), queryFn: () => api<RunComponents>(`/v1/payroll-outputs/runs/${encodeURIComponent(runId)}/comparison`), retry: retryTransient });
  const c = report.data;
  return (
    <Section title="Prior-period comparison">
      {report.isPending && <p className="hint loading">Loading the comparison…</p>}
      {report.error && <Problem error={report.error} act="read" />}
      {c?.basis === 'SCOPE' && <p className="hint">Your scope covers part of this run: the records in your scope are compared with the same employees’ latest earlier processed records.</p>}
      {c?.basis === 'RUN' && !c.priorPeriodCode && <p className="hint">No earlier processed run of this calendar and scope to compare with.</p>}
      {c && <ComponentTable c={c} currency={header.data?.run.currencyCode ?? ''} name="Prior-period comparison" />}
      <RunReportExport runId={runId} reportCode="PAYROLL_COMPARISON" name="comparison" />
    </Section>
  );
}

interface StatutoryRegister {
  sourceLabel: string;
  notice: string;
  run: { currencyCode: string };
  packs: { packCode: string; packRevision: number | null }[];
  scope: string;
  totals: { records: number; amounts: Record<string, string> };
  items: { recordId: string; employeeCode: string; employeeName: string; packCode: string; facts: Record<string, unknown>; amounts: Record<string, string | null>; notApplicable: Record<string, string> }[];
  next: string | null;
}

/** FR-039 working registers (I-90 follow-up): the columns each register shows, in order, with their labels. */
const STATUTORY_REGISTERS: { code: string; title: string; facts: [string, string][]; amounts: [string, string][] }[] = [
  {
    code: 'PF_REGISTER',
    title: 'PF register',
    facts: [
      ['pfWages', 'PF wages'],
      ['contributionWages', 'Contribution wages'],
      ['option', 'Basis'],
    ],
    amounts: [
      ['employee', 'Employee'],
      ['pension', 'Pension (EPS)'],
      ['employerEpf', 'Employer EPF'],
      ['edli', 'EDLI'],
      ['adminCharges', 'Admin charges'],
    ],
  },
  {
    code: 'ESIC_REGISTER',
    title: 'ESIC register',
    facts: [
      ['esicWages', 'ESIC wages'],
      ['covered', 'Coverage'],
    ],
    amounts: [
      ['employee', 'Employee'],
      ['employer', 'Employer'],
    ],
  },
  {
    code: 'PT_REGISTER',
    title: 'Professional tax register',
    facts: [
      ['stateCode', 'State'],
      ['gross', 'Gross'],
      ['slab', 'Slab'],
    ],
    amounts: [['tax', 'Tax']],
  },
  {
    code: 'LWF_REGISTER',
    title: 'Labour welfare fund register',
    facts: [
      ['stateCode', 'State'],
      ['wages', 'Wages'],
      ['slab', 'Slab'],
    ],
    amounts: [
      ['employee', 'Employee'],
      ['employer', 'Employer'],
    ],
  },
];

const MONEY_FACTS = new Set(['pfWages', 'contributionWages', 'esicWages', 'gross', 'wages']);

function StatutoryRegisters({ runId }: { runId: string }) {
  const keys = useKeys();
  const [code, setCode] = useState('PF_REGISTER');
  const [after, setAfter] = useState('');
  const def = STATUTORY_REGISTERS.find((r) => r.code === code)!;
  const register = useQuery({
    queryKey: keys.statutoryRegister(runId, code, after),
    queryFn: () => api<StatutoryRegister>(`/v1/payroll-outputs/runs/${encodeURIComponent(runId)}/statutory-registers/${code}${after ? `?after=${encodeURIComponent(after)}` : ''}`),
    retry: retryTransient,
  });
  const d = register.data;
  const cur = d?.run.currencyCode;
  return (
    <Section title="Statutory registers">
      <label>
        Register
        <select
          value={code}
          onChange={(e) => {
            setCode(e.target.value);
            setAfter('');
          }}
        >
          {STATUTORY_REGISTERS.map((r) => (
            <option key={r.code} value={r.code}>
              {r.title}
            </option>
          ))}
        </select>
      </label>
      {register.isPending && <p className="hint loading">Loading the register…</p>}
      {register.error && <Problem error={register.error} act="read" />}
      {d && (
        <>
          <p className="hint">{d.notice}</p>
          <dl className="kv" aria-label={`${def.title} totals`}>
            <Fact term="Records">{d.totals.records}</Fact>
            {def.amounts.map(([k, l]) => (
              <Fact key={k} term={l}>
                {money(d.totals.amounts[k], cur)}
              </Fact>
            ))}
            <Fact term="Pack revisions">{d.packs.map((p) => `${p.packCode} ${p.packRevision === null ? 'none active' : `revision ${p.packRevision}`}`).join('; ') || '—'}</Fact>
          </dl>
          {d.scope === 'ROW_SCOPE' && <p className="hint">Only the records within your scope are listed and totalled.</p>}
          {d.items.length === 0 ? (
            <Empty>No record of this run has a valuation for this register.</Empty>
          ) : (
            <div style={SCROLL}>
              <table aria-label={def.title}>
                <thead>
                  <tr>
                    <th>Employee</th>
                    {def.facts.map(([k, l]) => (
                      <th key={k}>{l}</th>
                    ))}
                    {def.amounts.map(([k, l]) => (
                      <th key={k}>{l}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {d.items.map((i) => (
                    <tr key={i.recordId}>
                      <td>{`${i.employeeCode} ${i.employeeName}`}</td>
                      {def.facts.map(([k]) => (
                        <td key={k}>{i.facts[k] === undefined || i.facts[k] === null ? '—' : MONEY_FACTS.has(k) ? money(String(i.facts[k]), cur) : readable(String(i.facts[k]))}</td>
                      ))}
                      {def.amounts.map(([k]) => (
                        <td key={k}>{i.amounts[k] === null || i.amounts[k] === undefined ? readable(i.notApplicable[k] ?? 'NOT_APPLICABLE') : money(i.amounts[k], cur)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.next && (
            <button type="button" className="secondary" onClick={() => setAfter(d.next!)}>
              Next page
            </button>
          )}
        </>
      )}
    </Section>
  );
}

function JournalReport({ runId }: { runId: string }) {
  const keys = useKeys();
  const jv = useQuery({ queryKey: keys.journal(runId), queryFn: () => api<unknown>(`/v1/payroll-outputs/runs/${encodeURIComponent(runId)}/journal`), retry: retryTransient });
  const notConfigured = jv.error instanceof ApiError && jv.error.code === 'NOT_CONFIGURED';
  return (
    <Section title="Journal voucher">
      {jv.isPending && <p className="hint">Checking the journal voucher…</p>}
      {notConfigured && (
        <p>
          <Badge tone="warn">Not configured</Badge> A journal voucher needs an approved chart-of-accounts mapping for the payroll heads. None is configured, so no voucher is produced.
        </p>
      )}
      {jv.error && !notConfigured && <Problem error={jv.error} act="read" />}
    </Section>
  );
}

const OUTPUT_STATUS: Record<string, string> = { NOT_CONFIGURED: 'Not configured', AVAILABLE: 'Working register' };

export function StatutoryScreen() {
  const { can } = useSession();
  const keys = useKeys();
  const outputs = useQuery({ queryKey: keys.statutory, queryFn: () => api<{ items: StatutoryRow[] }>('/v1/payroll-outputs/statutory-outputs'), enabled: can(STATUTORY_READ), retry: retryTransient });
  if (!can(STATUTORY_READ)) {
    return (
      <Section title="Statutory outputs">
        <Empty>The selected role cannot see statutory outputs.</Empty>
      </Section>
    );
  }
  return (
    <Section title="Statutory outputs">
      <p className="hint">
        Each statutory register, certificate and return needs an activated rule pack and the payroll owner’s period template. While a PF, ESIC, professional tax or labour welfare fund pack is active, its register is a working register on each run’s reports page: what the calculation recorded, not a filing. Filing formats and the other outputs are not produced until the template and an approved sample exist; the source labels are kept as written until the owner confirms them.
      </p>
      {outputs.isPending && <p className="hint loading">Loading statutory outputs…</p>}
      {outputs.error && <Problem error={outputs.error} act="read" />}
      {outputs.data && outputs.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Statutory outputs">
            <thead>
              <tr>
                <th>Output</th>
                <th>Code</th>
                <th>Status</th>
                <th>What it needs</th>
              </tr>
            </thead>
            <tbody>
              {outputs.data.items.map((o) => (
                <tr key={o.code}>
                  <td>{o.sourceLabel}</td>
                  <td>{o.code}</td>
                  <td>
                    <Badge tone={o.status === 'AVAILABLE' ? 'good' : 'warn'}>{label(OUTPUT_STATUS, o.status)}</Badge>
                  </td>
                  <td>{o.needs.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(REPORT_READ) && <TdsRegister />}
    </Section>
  );
}

interface TdsRegisterView {
  from: string;
  to: string;
  notice: string;
  scope: string;
  totals: { employees: number; tds: string; months: { month: string; taxableSalary: string; tds: string }[] };
  items: { employeeId: string; employeeCode: string; employeeName: string; tds: string; months: { month: string; source: string; taxableSalary: string; tds: string }[] }[];
}

/** FR-039 Form 24Q working data (I-90 follow-up): the quarter's TDS on salary per employee and month, as the server reads it. */
function TdsRegister() {
  const keys = useKeys();
  const [fiscalYear, setFiscalYear] = useState('2026-27');
  const [quarter, setQuarter] = useState('1');
  const [asked, setAsked] = useState<{ fiscalYear: string; quarter: string } | null>(null);
  const register = useQuery({
    queryKey: [...keys.reportsAll, 'tds-register', asked] as const,
    enabled: asked !== null,
    queryFn: () => api<TdsRegisterView>(`/v1/payroll-outputs/tds-register?fiscalYear=${encodeURIComponent(asked!.fiscalYear)}&quarter=${encodeURIComponent(asked!.quarter)}`),
    retry: retryTransient,
  });
  const d = register.data;
  return (
    <Section title="TDS register (Form 24Q working data)">
      <form
        className="row"
        aria-label="TDS register"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          setAsked({ fiscalYear: fiscalYear.trim(), quarter });
        }}
      >
        <label>
          Financial year
          <input value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} placeholder="2026-27" />
        </label>
        <label>
          Quarter
          <select value={quarter} onChange={(e) => setQuarter(e.target.value)}>
            <option value="1">Q1 (April to June)</option>
            <option value="2">Q2 (July to September)</option>
            <option value="3">Q3 (October to December)</option>
            <option value="4">Q4 (January to March)</option>
          </select>
        </label>
        <button type="submit">Show</button>
      </form>
      {register.isFetching && <p className="hint loading">Loading the register…</p>}
      {register.error && <Problem error={register.error} act="read" />}
      {d && (
        <>
          <p className="hint">{d.notice}</p>
          <dl className="kv" aria-label="TDS register totals">
            <Fact term="Period">{`${formatDate(d.from)} to ${formatDate(d.to)}`}</Fact>
            <Fact term="Employees">{d.totals.employees}</Fact>
            <Fact term="TDS deducted">{money(d.totals.tds, 'INR')}</Fact>
            {d.totals.months.map((m) => (
              <Fact key={m.month} term={formatMonth(m.month)}>{`${money(m.tds, 'INR')} on ${money(m.taxableSalary, 'INR')}`}</Fact>
            ))}
          </dl>
          {d.scope === 'ROW_SCOPE' && <p className="hint">Only the employees within your scope are listed and totalled.</p>}
          {d.items.length === 0 ? (
            <Empty>No TDS was deducted on processed payroll or paid final settlements in this quarter.</Empty>
          ) : (
            <div style={SCROLL}>
              <table aria-label="TDS by employee">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Month</th>
                    <th>Source</th>
                    <th>Taxable salary</th>
                    <th>TDS</th>
                  </tr>
                </thead>
                <tbody>
                  {d.items.flatMap((i) =>
                    i.months.map((m, n) => (
                      <tr key={`${i.employeeId}-${m.month}-${m.source}`}>
                        <td>{n === 0 ? `${i.employeeCode} ${i.employeeName}` : ''}</td>
                        <td>{formatMonth(m.month)}</td>
                        <td>{m.source === 'FINAL_SETTLEMENT' ? 'Final settlement' : 'Payroll'}</td>
                        <td>{money(m.taxableSalary, 'INR')}</td>
                        <td>{money(m.tds, 'INR')}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
