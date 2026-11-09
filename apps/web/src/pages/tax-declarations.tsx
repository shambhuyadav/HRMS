// Tax declarations and investment proofs (FR-036 declaration checking; FR-108; H3 TN08, TN09; H4; BR-053): capture and review only.
// My ESS (Employee OWN context): the employee's own declaration and proofs. The regimes and categories shown are exactly what the
// active rule pack lists; the app holds none of its own and never calculates tax. Rule packs: the registry that lists them, with an
// independent activation. Review: the independent decision, with the employee-visible explanation apart from the private reason.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError, download, formatAmount, formatDate, idempotencyKey } from '../api';
import type { EssPanel, ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Section, StateBadge } from '../ui';

const OWN_READ = 'own_tax.read.tax';
const OWN_SUBMIT = 'own_tax.submit.tax';
const REVIEW_READ = 'tax_declaration.read.tax';
const REVIEW = 'tax_declaration.review.tax';
const CONFIG_READ = 'payroll_config.read.operational';
const CONFIG_MANAGE = 'payroll_config.manage.operational';
const CONFIG_ACTIVATE = 'payroll_config.activate.operational';

interface Regime {
  code: string;
  name: string;
  categories: { code: string; name: string }[];
}
interface OpenPeriod {
  rulePackId: string;
  fiscalPeriodCode: string;
  periodStart: string;
  periodEnd: string;
  cutoffDate: string;
  currencyCode: string;
  cutoffPassed: boolean;
  regimes: Regime[];
}
interface Declaration {
  id: string;
  fiscalPeriodCode: string;
  cutoffDate: string;
  currencyCode: string;
  regimeCode: string;
  lines: { categoryCode: string; amount: string }[];
  state: string;
  employeeExplanation: string | null;
  employeeCode?: string;
  employeeName?: string;
  version: number;
}
interface OwnDeclarations {
  items: Declaration[];
  configuration: { status: 'ACTIVE' | 'NOT_CONFIGURED'; message?: string };
  openPeriods: OpenPeriod[];
  calculation: { message: string };
}
interface Proof {
  id: string;
  declarationId: string;
  fiscalPeriodCode: string;
  categoryCode: string;
  categoryName: string | null;
  claimedAmount: string;
  acceptedAmount: string | null;
  rejectedAmount: string | null;
  currencyCode: string;
  state: string;
  employeeExplanation: string | null;
  employeeCode?: string;
  employeeName?: string;
  evidence: { documentId: string; documentType: string; scanState: string | null; verificationState: string }[];
}
interface OwnProofs {
  items: Proof[];
  configuration: { status: 'ACTIVE' | 'NOT_CONFIGURED'; message?: string };
}

const notPermitted = (message: string) => <p className="hint">{message}</p>;

// =========================================================================================================
// TN08 own declaration
// =========================================================================================================

function DeclarationForm({ period, onDone }: { period: OpenPeriod; onDone: () => void }) {
  const [regimeCode, setRegimeCode] = useState(period.regimes[0]?.code ?? '');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const regime = period.regimes.find((r) => r.code === regimeCode);
  const save = useMutation({
    mutationFn: () =>
      api<Declaration>('/v1/me/tax-declarations', {
        body: {
          fiscalPeriodCode: period.fiscalPeriodCode,
          regimeCode,
          lines: (regime?.categories ?? []).filter((c) => amounts[c.code]?.trim()).map((c) => ({ categoryCode: c.code, amount: amounts[c.code]!.trim() })),
        },
      }),
    onSuccess: () => onDone(),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  };
  return (
    <form onSubmit={submit} className="stack" aria-label={`Declare for ${period.fiscalPeriodCode}`} noValidate>
      <p className="hint">{`${period.fiscalPeriodCode}: ${formatDate(period.periodStart)} to ${formatDate(period.periodEnd)}. Accepted until ${formatDate(period.cutoffDate)}. Amounts in ${period.currencyCode}.`}</p>
      <label>
        Regime
        <select value={regimeCode} onChange={(e) => setRegimeCode(e.target.value)}>
          {period.regimes.map((r) => (
            <option key={r.code} value={r.code}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      {regime?.categories.length === 0 && <p className="hint">This regime lists no categories to declare.</p>}
      {regime?.categories.map((c) => (
        <label key={c.code}>
          {c.name}
          <input inputMode="decimal" value={amounts[c.code] ?? ''} onChange={(e) => setAmounts({ ...amounts, [c.code]: e.target.value })} />
        </label>
      ))}
      <ErrorNote error={save.error} />
      <button type="submit" disabled={save.isPending || !regimeCode}>
        Save draft
      </button>
    </form>
  );
}

function OwnDeclarationItem({ d, canSubmit, onChanged }: { d: Declaration; canSubmit: boolean; onChanged: () => void }) {
  const send = useMutation({
    mutationFn: () => api<Declaration>(`/v1/me/tax-declarations/${encodeURIComponent(d.id)}/submit`, { body: { expectedVersion: d.version } }),
    onSuccess: () => onChanged(),
  });
  return (
    <li className="card" aria-label={`Declaration for ${d.fiscalPeriodCode}`}>
      <strong>{d.fiscalPeriodCode}</strong> <StateBadge state={d.state} />
      <p className="hint">Regime: {d.regimeCode}</p>
      {d.lines.length === 0 ? (
        <p className="hint">No categories declared.</p>
      ) : (
        <ul>
          {d.lines.map((l) => (
            <li key={l.categoryCode}>{`${l.categoryCode}: ${formatAmount(l.amount, d.currencyCode)}`}</li>
          ))}
        </ul>
      )}
      {d.employeeExplanation && <p>Reviewer&apos;s explanation: {d.employeeExplanation}</p>}
      {d.state === 'RETURNED' && <p className="hint">Start a new declaration for this period to correct it.</p>}
      <ErrorNote error={send.error} />
      {canSubmit && d.state === 'DRAFT' && (
        <button type="button" onClick={() => send.mutate()} disabled={send.isPending}>
          Submit for review
        </button>
      )}
    </li>
  );
}

function MyTaxDeclarationPanel() {
  const { can } = useSession();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['tax-own-declarations'], queryFn: () => api<OwnDeclarations>('/v1/me/tax-declarations'), enabled: can(OWN_READ) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tax-own-declarations'] });
  if (!can(OWN_READ)) return notPermitted('Your own tax declaration is shown in your Employee role. Switch to it to see it.');
  const data = list.data;
  const live = (fiscalPeriodCode: string) => data?.items.some((d) => d.fiscalPeriodCode === fiscalPeriodCode && !['RETURNED', 'REJECTED'].includes(d.state));
  return (
    <Section title="My tax declaration">
      {list.isPending && <p className="hint">Loading your declarations…</p>}
      <ErrorNote error={list.error} />
      {data?.configuration.status === 'NOT_CONFIGURED' && <p role="status">{data.configuration.message}</p>}
      {data && <p className="hint">{data.calculation.message}</p>}
      {data && data.items.length === 0 && data.configuration.status === 'ACTIVE' && <Empty>You have no declarations yet.</Empty>}
      {data && data.items.length > 0 && (
        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {data.items.map((d) => (
            <OwnDeclarationItem key={d.id} d={d} canSubmit={can(OWN_SUBMIT)} onChanged={refresh} />
          ))}
        </ul>
      )}
      {can(OWN_SUBMIT) &&
        data?.openPeriods
          .filter((p) => !p.cutoffPassed && !live(p.fiscalPeriodCode))
          .map((p) => <DeclarationForm key={p.rulePackId} period={p} onDone={refresh} />)}
      {data?.openPeriods
        .filter((p) => p.cutoffPassed && !live(p.fiscalPeriodCode))
        .map((p) => (
          <p className="hint" key={p.rulePackId}>{`The cutoff for ${p.fiscalPeriodCode} passed on ${formatDate(p.cutoffDate)}.`}</p>
        ))}
    </Section>
  );
}

// =========================================================================================================
// TN09 own investment proofs
// =========================================================================================================

function ProofForm({ declarations, onDone, employeeId }: { declarations: Declaration[]; onDone: () => void; employeeId: string }) {
  const [declarationId, setDeclarationId] = useState(declarations[0]?.id ?? '');
  const [categoryCode, setCategoryCode] = useState('');
  const [claimedAmount, setClaimedAmount] = useState('');
  const [evidence, setEvidence] = useState<string[]>([]);
  const [key] = useState(() => idempotencyKey('tax-proof'));
  const documents = useQuery({
    queryKey: ['tax-own-documents', employeeId],
    queryFn: () => api<{ items: { id: string; fileName: string | null; documentType: string }[] }>(`/v1/employees/${encodeURIComponent(employeeId)}/documents`),
  });
  const declaration = declarations.find((d) => d.id === declarationId);
  const send = useMutation({
    mutationFn: () => api<Proof>('/v1/me/tax-proofs', { body: { declarationId, categoryCode, claimedAmount: claimedAmount.trim(), evidenceDocumentIds: evidence, idempotencyKey: key } }),
    onSuccess: () => onDone(),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!send.isPending) send.mutate();
  };
  return (
    <form onSubmit={submit} className="stack" aria-label="Submit an investment proof" noValidate>
      <label>
        Declaration
        <select value={declarationId} onChange={(e) => setDeclarationId(e.target.value)}>
          {declarations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.fiscalPeriodCode}
            </option>
          ))}
        </select>
      </label>
      <label>
        Category
        <select value={categoryCode} onChange={(e) => setCategoryCode(e.target.value)}>
          <option value="">Choose…</option>
          {declaration?.lines.map((l) => (
            <option key={l.categoryCode} value={l.categoryCode}>
              {l.categoryCode}
            </option>
          ))}
        </select>
      </label>
      <label>
        Amount claimed
        <input inputMode="decimal" value={claimedAmount} onChange={(e) => setClaimedAmount(e.target.value)} />
      </label>
      <fieldset>
        <legend>Evidence (your uploaded documents)</legend>
        {documents.data?.items.length === 0 && <p className="hint">Upload the document under Document upload first.</p>}
        {documents.data?.items.map((d) => (
          <label key={d.id}>
            <input type="checkbox" checked={evidence.includes(d.id)} onChange={(e) => setEvidence(e.target.checked ? [...evidence, d.id] : evidence.filter((x) => x !== d.id))} />
            {d.fileName ?? d.documentType}
          </label>
        ))}
      </fieldset>
      <ErrorNote error={send.error} />
      <button type="submit" disabled={send.isPending || !categoryCode || !claimedAmount.trim() || evidence.length === 0}>
        Submit proof
      </button>
    </form>
  );
}

function MyInvestmentProofsPanel() {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const proofs = useQuery({ queryKey: ['tax-own-proofs'], queryFn: () => api<OwnProofs>('/v1/me/tax-proofs'), enabled: can(OWN_READ) });
  const declarations = useQuery({ queryKey: ['tax-own-declarations'], queryFn: () => api<OwnDeclarations>('/v1/me/tax-declarations'), enabled: can(OWN_READ) });
  if (!can(OWN_READ)) return notPermitted('Your own investment proofs are shown in your Employee role. Switch to it to see them.');
  const open = declarations.data?.items.filter((d) => (d.state === 'SUBMITTED' || d.state === 'ACCEPTED') && d.lines.length > 0) ?? [];
  const data = proofs.data;
  return (
    <Section title="My investment proofs">
      {proofs.isPending && <p className="hint">Loading your proofs…</p>}
      <ErrorNote error={proofs.error} />
      {data?.configuration.status === 'NOT_CONFIGURED' && <p role="status">{data.configuration.message}</p>}
      {data && <p className="hint">An accepted amount gives no tax relief by itself; no tax is calculated here.</p>}
      {data && data.items.length === 0 && data.configuration.status === 'ACTIVE' && <Empty>You have submitted no proofs.</Empty>}
      {data && data.items.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table aria-label="My investment proofs">
            <thead>
              <tr>
                <th>Period</th>
                <th>Category</th>
                <th>Claimed</th>
                <th>Accepted</th>
                <th>Rejected</th>
                <th>Status</th>
                <th>Reviewer&apos;s explanation</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.fiscalPeriodCode}</td>
                  <td>{p.categoryName ?? p.categoryCode}</td>
                  <td>{formatAmount(p.claimedAmount, p.currencyCode)}</td>
                  <td>{formatAmount(p.acceptedAmount, p.currencyCode)}</td>
                  <td>{formatAmount(p.rejectedAmount, p.currencyCode)}</td>
                  <td>
                    <StateBadge state={p.state} />
                  </td>
                  <td>{p.employeeExplanation ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {can(OWN_SUBMIT) && open.length > 0 && me?.employeeId && <ProofForm declarations={open} employeeId={me.employeeId} onDone={() => void qc.invalidateQueries({ queryKey: ['tax-own-proofs'] })} />}
    </Section>
  );
}

// =========================================================================================================
// Independent review (queue also shown in the decision inbox)
// =========================================================================================================

function ReviewControls({ url, showAmount, onDone, name }: { url: string; showAmount: boolean; onDone: () => void; name: string }) {
  const [explanation, setExplanation] = useState('');
  const [reason, setReason] = useState('');
  const [acceptedAmount, setAcceptedAmount] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'ACCEPT' | 'REJECT' | 'RETURN') =>
      api(url, {
        body: {
          decision,
          idempotencyKey: idempotencyKey('tax-review'),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(decision !== 'ACCEPT' && explanation.trim() ? { explanation: explanation.trim() } : {}),
          ...(decision === 'ACCEPT' && showAmount && acceptedAmount.trim() ? { acceptedAmount: acceptedAmount.trim() } : {}),
        },
      }),
    onSuccess: () => onDone(),
  });
  return (
    <form className="stack" aria-label={`Review ${name}`} onSubmit={(e) => e.preventDefault()}>
      {showAmount && (
        <label>
          Accepted amount
          <input inputMode="decimal" value={acceptedAmount} onChange={(e) => setAcceptedAmount(e.target.value)} />
        </label>
      )}
      <label>
        Explanation the employee sees (needed to return or reject)
        <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} maxLength={1000} rows={2} />
      </label>
      <label>
        Private reason (never shown to the employee)
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
      </label>
      <ErrorNote error={decide.error} />
      <div className="row">
        <button type="button" onClick={() => decide.mutate('ACCEPT')} disabled={decide.isPending}>
          Accept
        </button>
        <button type="button" className="secondary" onClick={() => decide.mutate('RETURN')} disabled={decide.isPending}>
          Return
        </button>
        <button type="button" className="danger" onClick={() => decide.mutate('REJECT')} disabled={decide.isPending}>
          Reject
        </button>
      </div>
    </form>
  );
}

/** FR-106: only a file the malware scan released is served, so the words say where this one stands. */
function evidenceState(d: Proof['evidence'][number]): string {
  if (d.scanState === 'QUARANTINED') return 'quarantined by the malware scan';
  if (d.scanState !== 'CLEAN') return 'waiting for the malware scan';
  if (d.verificationState === 'VERIFIED') return 'released and verified';
  if (d.verificationState === 'REJECTED') return 'released, rejected by the verifier';
  return 'released, not verified yet';
}

function ProofEvidence({ proofId, evidence }: { proofId: string; evidence: Proof['evidence'][number] }) {
  const open = useMutation({ mutationFn: () => download(`/v1/tax-proofs/${encodeURIComponent(proofId)}/evidence/${encodeURIComponent(evidence.documentId)}`) });
  const refusal = open.error instanceof ApiError && open.error.code === 'FILE_NOT_RELEASED' ? open.error : null;
  return (
    <li>
      <button type="button" className="secondary" disabled={open.isPending} onClick={() => open.mutate()}>
        {`Open ${evidence.documentType}`}
      </button>
      {` (${evidenceState(evidence)})`}
      {refusal ? (
        <div role="alert" className="error">
          {(refusal.details as { scanState?: string } | undefined)?.scanState === 'QUARANTINED'
            ? 'The malware scan flagged this file, so it can never be opened.'
            : 'This file is still waiting for the malware scan, so it cannot be opened yet. Try again shortly.'}
        </div>
      ) : (
        <ErrorNote error={open.error} />
      )}
    </li>
  );
}

function TaxReviewQueue() {
  const { can } = useSession();
  const qc = useQueryClient();
  const declarations = useQuery({ queryKey: ['tax-tasks-declarations'], queryFn: () => api<{ items: { taskId: string; declaration: Declaration }[] }>('/v1/tax-declarations/tasks/mine'), enabled: can(REVIEW) });
  const proofs = useQuery({ queryKey: ['tax-tasks-proofs'], queryFn: () => api<{ items: { taskId: string; proof: Proof }[] }>('/v1/tax-proofs/tasks/mine'), enabled: can(REVIEW) });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['tax-tasks-declarations'] });
    void qc.invalidateQueries({ queryKey: ['tax-tasks-proofs'] });
  };
  if (!can(REVIEW)) return notPermitted('The selected role does not review tax declarations.');
  return (
    <Section title="Tax declarations and proofs to review">
      <p className="hint">Accepting records the review only: no tax is calculated, and nothing reaches payroll.</p>
      <ErrorNote error={declarations.error ?? proofs.error} />
      {declarations.data?.items.length === 0 && proofs.data?.items.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      {declarations.data?.items.map(({ taskId, declaration: d }) => (
        <div className="card" key={taskId} aria-label={`Declaration of ${d.employeeCode}`}>
          <strong>{`${d.employeeName} (${d.employeeCode}): ${d.fiscalPeriodCode}`}</strong>
          <p className="hint">Regime: {d.regimeCode}</p>
          <ul>
            {d.lines.map((l) => (
              <li key={l.categoryCode}>{`${l.categoryCode}: ${formatAmount(l.amount, d.currencyCode)}`}</li>
            ))}
          </ul>
          <ReviewControls url={`/v1/tax-declaration-tasks/${encodeURIComponent(taskId)}/decision`} showAmount={false} onDone={refresh} name={`the declaration of ${d.employeeCode}`} />
        </div>
      ))}
      {proofs.data?.items.map(({ taskId, proof: p }) => (
        <div className="card" key={taskId} aria-label={`Proof of ${p.employeeCode}`}>
          <strong>{`${p.employeeName} (${p.employeeCode}): ${p.categoryCode}, ${formatAmount(p.claimedAmount, p.currencyCode)}`}</strong>
          <ul>
            {p.evidence.map((d) => (
              <ProofEvidence key={d.documentId} proofId={p.id} evidence={d} />
            ))}
          </ul>
          <ReviewControls url={`/v1/tax-proof-tasks/${encodeURIComponent(taskId)}/decision`} showAmount onDone={refresh} name={`the proof of ${p.employeeCode}`} />
        </div>
      ))}
    </Section>
  );
}

function TaxReviewScreen() {
  const { can } = useSession();
  const declarations = useQuery({ queryKey: ['tax-review-declarations'], queryFn: () => api<{ items: Declaration[]; total: number }>('/v1/tax-declarations?page=1&pageSize=50'), enabled: can(REVIEW_READ) });
  const proofs = useQuery({ queryKey: ['tax-review-proofs'], queryFn: () => api<{ items: Proof[]; total: number }>('/v1/tax-proofs?page=1&pageSize=50'), enabled: can(REVIEW_READ) });
  return (
    <div className="stack">
      {can(REVIEW) && <TaxReviewQueue />}
      {can(REVIEW_READ) && (
        <Section title="Declarations and proofs">
          <ErrorNote error={declarations.error ?? proofs.error} />
          {declarations.data && (
            <ul aria-label="Declarations">
              {declarations.data.items.map((d) => (
                <li key={d.id}>
                  {`${d.employeeCode} ${d.fiscalPeriodCode} `}
                  <StateBadge state={d.state} />
                </li>
              ))}
            </ul>
          )}
          {proofs.data && (
            <ul aria-label="Proofs">
              {proofs.data.items.map((p) => (
                <li key={p.id}>
                  {`${p.employeeCode} ${p.fiscalPeriodCode} ${p.categoryCode} `}
                  <StateBadge state={p.state} />
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {can(REVIEW_READ) && <Form16PartB declarations={declarations.data?.items ?? []} />}
    </div>
  );
}

interface PartB {
  status: string;
  message?: string;
  regime?: string;
  regimeSource?: string;
  salary: {
    processedMonths: number;
    grossSalary: string;
    exemptAllowances: string;
    tdsDeducted: string;
    finalSettlement?: { taxableSalary: string; exemptAllowances: string; tdsDeducted: string } | null;
  };
  standardDeduction?: string;
  hraExemption?: { exemption: string; hraReceived: string; salaryForHra: string; rentPaid: string; metro: boolean } | null;
  previousEmployment?: { salary: string; tds: string } | null;
  deductions?: { categoryCode: string; amount: string; limit: string | null; allowed: string }[];
  taxableIncome?: string;
  tax?: { slabTax: string; rebate: string; surcharge: string; cess: string; total: string };
  balance?: string;
  partA: { status: string; reason: string };
}

/**
 * FR-107 (I-90): Form 16 Part B working data of one employee and year, as the server computes it from processed payroll, the accepted
 * declaration and proofs, and the active INCOME_TAX pack. It is the reviewer's working data, never the certificate (Part A comes from
 * TRACES); figures are shown exactly as returned.
 */
function Form16PartB({ declarations }: { declarations: (Declaration & { employeeId?: string })[] }) {
  const [employeeId, setEmployeeId] = useState('');
  const [fiscalYear, setFiscalYear] = useState('2026-27');
  const [asked, setAsked] = useState<{ employeeId: string; fiscalYear: string } | null>(null);
  const partB = useQuery({
    queryKey: ['form16-part-b', asked],
    enabled: asked !== null,
    queryFn: () => api<PartB>(`/v1/payroll/form16/part-b?employeeId=${encodeURIComponent(asked!.employeeId)}&fiscalYear=${encodeURIComponent(asked!.fiscalYear)}`),
  });
  const amount = (v: string | undefined) => (v === undefined ? '—' : formatAmount(v, 'INR'));
  const d = partB.data;
  return (
    <Section title="Form 16 Part B (working data)">
      <p className="hint">Salary and tax for a year, from processed payroll and accepted proofs, valued under the income tax pack two people validated and activated. Part A comes from TRACES; no certificate is issued here.</p>
      {declarations.some((x) => x.employeeId) && (
        <ul aria-label="Part B by declaration">
          {declarations
            .filter((x) => x.employeeId)
            .map((x) => (
              <li key={x.id}>
                <button type="button" className="secondary" onClick={() => setAsked({ employeeId: x.employeeId!, fiscalYear: x.fiscalPeriodCode })}>
                  {`Part B: ${x.employeeCode ?? ''} ${x.fiscalPeriodCode}`}
                </button>
              </li>
            ))}
        </ul>
      )}
      <form
        className="row"
        aria-label="Form 16 Part B"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (employeeId.trim() && fiscalYear.trim()) setAsked({ employeeId: employeeId.trim(), fiscalYear: fiscalYear.trim() });
        }}
      >
        <label>
          Employee ID
          <input value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} />
        </label>
        <label>
          Financial year
          <input value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} placeholder="2026-27" />
        </label>
        <button type="submit">Show Part B</button>
      </form>
      <ErrorNote error={partB.error} />
      {d && (
        <dl className="kv" aria-label="Part B figures">
          <dt>Status</dt>
          <dd>{d.status === 'CALCULATED' ? `Calculated (${d.regime} regime, ${d.regimeSource === 'DECLARATION' ? 'as declared' : 'the default'})` : (d.message ?? d.status)}</dd>
          <dt>Months processed</dt>
          <dd>{d.salary.processedMonths}</dd>
          {d.salary.finalSettlement && (
            <>
              <dt>Final settlement (included)</dt>
              <dd>{`${amount(d.salary.finalSettlement.taxableSalary)} taxable, ${amount(d.salary.finalSettlement.tdsDeducted)} TDS`}</dd>
            </>
          )}
          <dt>Gross salary</dt>
          <dd>{amount(d.salary.grossSalary)}</dd>
          <dt>Exempt allowances</dt>
          <dd>{amount(d.salary.exemptAllowances)}</dd>
          {d.previousEmployment && (
            <>
              <dt>Earlier employer this year (Form 12B)</dt>
              <dd>{`${amount(d.previousEmployment.salary)} salary, ${amount(d.previousEmployment.tds)} tax deducted`}</dd>
            </>
          )}
          {d.hraExemption && (
            <>
              <dt>House rent allowance exempt</dt>
              <dd>{`${amount(d.hraExemption.exemption)} (allowance ${amount(d.hraExemption.hraReceived)}, rent ${amount(d.hraExemption.rentPaid)}${d.hraExemption.metro ? ', metro city' : ''})`}</dd>
            </>
          )}
          <dt>Standard deduction</dt>
          <dd>{amount(d.standardDeduction)}</dd>
          <dt>Deductions allowed</dt>
          <dd>{d.deductions && d.deductions.length > 0 ? d.deductions.map((x) => `${x.categoryCode} ${amount(x.allowed)}`).join('; ') : '—'}</dd>
          <dt>Taxable income</dt>
          <dd>{amount(d.taxableIncome)}</dd>
          <dt>Tax for the year</dt>
          <dd>{amount(d.tax?.total)}</dd>
          <dt>TDS deducted</dt>
          <dd>{amount(d.salary.tdsDeducted)}</dd>
          <dt>Balance</dt>
          <dd>{amount(d.balance)}</dd>
          <dt>Part A</dt>
          <dd>{d.partA.reason}</dd>
        </dl>
      )}
    </Section>
  );
}

// =========================================================================================================
// Rule pack registry: lists what a supplied pack declares; no rate is entered anywhere
// =========================================================================================================

interface Pack {
  id: string;
  code: string;
  revision: number;
  fiscalPeriodCode: string;
  cutoffDate: string;
  state: string;
  version: number;
  createdBy: string | null;
  regimes: Regime[];
}

const parseRegimes = (text: string): Regime[] =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [regime, categories] = l.split(':');
      const [code, ...name] = (regime ?? '').trim().split(' ');
      return {
        code: code ?? '',
        name: name.join(' ') || (code ?? ''),
        categories: (categories ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean)
          .map((c) => {
            const [categoryCode, ...categoryName] = c.split(' ');
            return { code: categoryCode ?? '', name: categoryName.join(' ') || (categoryCode ?? '') };
          }),
      };
    });

function PackForm({ onDone }: { onDone: () => void }) {
  const empty = { code: '', fiscalPeriodCode: '', periodStart: '', periodEnd: '', cutoffDate: '', currencyCode: '', currencyMinorUnit: '', sourceReference: '', validationReference: '', regimes: '' };
  const [f, setF] = useState(empty);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = useMutation({
    mutationFn: () => api<Pack>('/v1/payroll/tax-rule-packs', { body: { ...f, currencyMinorUnit: Number(f.currencyMinorUnit), regimes: parseRegimes(f.regimes) } }),
    onSuccess: () => {
      setF(empty);
      onDone();
    },
  });
  return (
    <form
      className="stack"
      aria-label="Record a tax rule pack"
      onSubmit={(e) => {
        e.preventDefault();
        if (!create.isPending) create.mutate();
      }}
      noValidate
    >
      <p className="hint">Records what the supplied pack lists. It holds no rate and calculates nothing; someone else activates it.</p>
      <label>
        Pack code
        <input value={f.code} onChange={set('code')} />
      </label>
      <label>
        Fiscal period code
        <input value={f.fiscalPeriodCode} onChange={set('fiscalPeriodCode')} />
      </label>
      <label>
        Period start
        <input type="date" value={f.periodStart} onChange={set('periodStart')} />
      </label>
      <label>
        Period end
        <input type="date" value={f.periodEnd} onChange={set('periodEnd')} />
      </label>
      <label>
        Cutoff date
        <input type="date" value={f.cutoffDate} onChange={set('cutoffDate')} />
      </label>
      <label>
        Currency code
        <input value={f.currencyCode} onChange={set('currencyCode')} />
      </label>
      <label>
        Currency decimals
        <input inputMode="numeric" value={f.currencyMinorUnit} onChange={set('currencyMinorUnit')} />
      </label>
      <label>
        Source of the pack
        <input value={f.sourceReference} onChange={set('sourceReference')} />
      </label>
      <label>
        Validation reference
        <input value={f.validationReference} onChange={set('validationReference')} />
      </label>
      <label>
        Regimes and categories, one regime per line: CODE Name: CAT_ONE First name, CAT_TWO Second name
        <textarea rows={3} value={f.regimes} onChange={set('regimes')} />
      </label>
      <ErrorNote error={create.error} />
      <button type="submit" disabled={create.isPending || !f.code || !f.regimes.trim()}>
        Save draft
      </button>
    </form>
  );
}

function PackRow({ pack, onDone }: { pack: Pack; onDone: () => void }) {
  const { can, me } = useSession();
  const activate = useMutation({
    mutationFn: () => api<Pack>(`/v1/payroll/tax-rule-packs/${encodeURIComponent(pack.id)}/activate`, { body: { expectedVersion: pack.version } }),
    onSuccess: () => onDone(),
  });
  return (
    <li className="card" aria-label={`Pack ${pack.code} revision ${pack.revision}`}>
      <strong>{`${pack.code} r${pack.revision}`}</strong> <StateBadge state={pack.state} />
      <p className="hint">{`${pack.fiscalPeriodCode}; cutoff ${formatDate(pack.cutoffDate)}`}</p>
      <ul>
        {pack.regimes.map((r) => (
          <li key={r.code}>{`${r.name}: ${r.categories.map((c) => c.name).join(', ') || 'no categories'}`}</li>
        ))}
      </ul>
      <ErrorNote error={activate.error} />
      {pack.state === 'DRAFT' && can(CONFIG_ACTIVATE) && pack.createdBy !== me?.userId && (
        <button type="button" onClick={() => activate.mutate()} disabled={activate.isPending}>
          Activate
        </button>
      )}
    </li>
  );
}

function TaxRulePacksScreen() {
  const { can } = useSession();
  const qc = useQueryClient();
  const packs = useQuery({ queryKey: ['tax-rule-packs'], queryFn: () => api<{ items: Pack[]; calculation: { message: string } }>('/v1/payroll/tax-rule-packs'), enabled: can(CONFIG_READ) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['tax-rule-packs'] });
  if (!can(CONFIG_READ)) return notPermitted('The selected role cannot read payroll configuration.');
  return (
    <Section title="Tax rule packs">
      <ErrorNote error={packs.error} />
      {packs.data && <p className="hint">{packs.data.calculation.message}</p>}
      {packs.data?.items.length === 0 && <Empty>No rule pack has been recorded. Tax declarations and proofs stay unavailable to employees until one is activated.</Empty>}
      {packs.data && packs.data.items.length > 0 && (
        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {packs.data.items.map((p) => (
            <PackRow key={p.id} pack={p} onDone={refresh} />
          ))}
        </ul>
      )}
      {can(CONFIG_MANAGE) && <PackForm onDone={refresh} />}
    </Section>
  );
}

// =========================================================================================================

export const TAX_SCREENS: ScreenRoute[] = [
  { path: '/payroll/tax-rule-packs', title: 'Tax rule packs', permission: CONFIG_READ, nav: true, component: TaxRulePacksScreen },
  { path: '/payroll/tax-review', title: 'Tax declaration review', permission: REVIEW_READ, nav: true, component: TaxReviewScreen },
];

/** H3 TN08 and TN09 in the Employee OWN context (the API says NOT_CONFIGURED on the tab until a rule pack is activated). */
export const TAX_ESS_PANELS: EssPanel[] = [
  { tabId: 'TN08', component: MyTaxDeclarationPanel },
  { tabId: 'TN09', component: MyInvestmentProofsPanel },
];

export const TAX_TASK_QUEUES = [{ permission: REVIEW, title: 'Tax declarations and proofs', component: TaxReviewQueue }];
