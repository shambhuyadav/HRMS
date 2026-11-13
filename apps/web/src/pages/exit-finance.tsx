// Exit finance decided under owner delegation, 6 Nov 2026 (docs/03 I-81): FR-034 loan early settlement (recorded from evidence under
// the disbursement duty, decided by someone else; a waiver or write-off needs its own right), the employee's own documents received
// in-app (FR-018, FR-054, DF09: "send" is delivery to the person's own self-service, never an e-mail attachment; BR-053 own outputs,
// kept after leaving), and the verified-evidence choice the exit and settlement screens share. The server decides every rule; these
// screens hide what the selected assignment cannot use and say the server's refusals in plain words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, download, formatAmount, formatDate, idempotencyKey, localDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Section, StateBadge } from '../ui';

const LOAN_READ = 'payroll_loan.read.loan';
const LOAN_DISBURSE = 'payroll_loan.disburse.loan';
const LOAN_DECIDE = 'payroll_loan.decide.loan';
const DOCUMENT_READ = 'document.read.document';
const SETTLEMENT_READ_AMOUNT = 'settlement.read.amount';
const OWN_DELIVERY = 'own_delivery.read.delivery';

export const EXIT_FINANCE_PATHS = {
  loanSettlements: '/payroll/loan-settlements',
  recordLoanSettlement: (loanId: string) => `/payroll/loans/${encodeURIComponent(loanId)}/early-settlement`,
  documentsReceived: '/me/documents-received',
} as const;

const AMOUNT = /^\d{1,15}(\.\d{1,4})?$/;
const retryTransient = (failureCount: number, error: Error) => !(error instanceof ApiError && error.status < 500) && failureCount < 1;
const enc = encodeURIComponent;

// ---------------------------------------------------------------------------------------------------------
// Verified evidence (FR-106): the employee's own documents; only released and verified ones can be chosen.
// ---------------------------------------------------------------------------------------------------------
interface EvidenceDocument {
  id: string;
  documentType: string;
  fileName: string | null;
  uploadedAt: string;
  scanState: string | null;
  verificationState: string;
}

function evidenceState(d: EvidenceDocument): string {
  if (d.scanState === 'QUARANTINED') return 'quarantined by the malware scan, not usable';
  if (d.scanState !== 'CLEAN') return 'waiting for the malware scan, not usable yet';
  if (d.verificationState === 'VERIFIED') return 'released and verified';
  if (d.verificationState === 'REJECTED') return 'rejected by the verifier, not usable';
  return 'released, not verified yet, not usable';
}

/** One released, verified document of the employee as evidence; the files are not opened here. */
export function VerifiedEvidencePicker({ employeeId, chosen, onChange, legend }: { employeeId: string; chosen: string | null; onChange: (id: string) => void; legend: string }) {
  const { can } = useSession();
  const name = useId();
  const docs = useQuery({
    queryKey: ['exit-finance', 'evidence', employeeId],
    queryFn: () => api<{ items: EvidenceDocument[] }>(`/v1/employees/${enc(employeeId)}/documents`),
    enabled: can(DOCUMENT_READ),
    retry: retryTransient,
  });
  if (!can(DOCUMENT_READ)) return <p className="hint">The selected role cannot list the employee’s documents, so it cannot choose the evidence here.</p>;
  return (
    <fieldset>
      <legend>{legend}</legend>
      {docs.isPending && <p className="hint loading">Loading the employee’s documents…</p>}
      <ErrorNote error={docs.error} />
      {docs.data && docs.data.items.length === 0 && <p className="hint">The employee has no documents yet: add the evidence to their record and have it verified first.</p>}
      {docs.data?.items.map((d) => {
        const usable = d.scanState === 'CLEAN' && d.verificationState === 'VERIFIED';
        return (
          <label key={d.id} className="check">
            <input type="radio" name={name} checked={chosen === d.id} disabled={!usable} onChange={() => onChange(d.id)} />{' '}
            {`${d.documentType}${d.fileName ? ` · ${d.fileName}` : ''} (${formatDate(d.uploadedAt)}): ${evidenceState(d)}`}
          </label>
        );
      })}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-034 loan early settlement (I-81 item 1)
// ---------------------------------------------------------------------------------------------------------
interface EarlySettlementRecord {
  id: string;
  state: string;
  balance: string;
  repaidAmount: string;
  repaymentRoute: string | null;
  repaymentDate: string | null;
  waivedAmount: string;
  waiverKind: string | null;
  reason: string;
  recordedBy: string;
  recordedAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  version: number;
}

interface Loan {
  id: string;
  employeeId: string;
  employeeCode: string;
  loanKind: string;
  currencyCode: string;
  principal: string;
  state: string;
  recovered: string;
  awaitingRecognition: string;
  outstanding: string;
  settledEarly?: string;
  waived?: string;
  closeReason?: string | null;
  disbursementDate: string | null;
  version: number;
  earlySettlements?: EarlySettlementRecord[];
}

interface PaidSettlement {
  id: string;
  revision: number;
  employeeId: string;
  paymentDate?: string | null;
}

const ROUTE_LABEL: Record<string, string> = { DIRECT_REPAYMENT: 'Repaid by the employee outside payroll', FINAL_SETTLEMENT: 'Recovered through the paid full and final settlement' };
const WAIVER_LABEL: Record<string, string> = { WAIVER: 'Waived by the company', WRITE_OFF: 'Written off as not recoverable' };

/** Server refusals of the early settlement, in plain words. */
const LOAN_WORDS: Record<string, string> = {
  SETTLEMENT_NOT_BALANCED: 'The repaid and waived amounts must add up to the balance left on the loan.',
  REPAYMENT_ROUTE_REQUIRED: 'Say how the employee repaid: outside payroll, or through the full and final settlement.',
  REPAYMENT_IN_FUTURE: 'A repayment is recorded once it has happened: the date cannot be in the future.',
  RECOVERY_AWAITING_RECOGNITION: 'Processed payroll has deducted from this loan and the recovery is not recognised yet; recognise it first, then the balance is final.',
  SETTLEMENT_PENDING: 'An early settlement of this loan is already waiting for its decision.',
  SETTLEMENT_NOT_PAID: 'A recovery through the full and final settlement counts once that settlement’s payment is recorded.',
  SETTLEMENT_RECOVERY_MISMATCH: 'The settlement must deduct exactly the repaid amount on the loan’s recovery head.',
  WAIVER_KIND_REQUIRED: 'Say whether the rest is waived or written off.',
  EVIDENCE_NOT_VERIFIED: 'The evidence must be released by the malware scan and verified by someone independent.',
  NOT_INDEPENDENT: 'Whoever recorded an early settlement does not decide it.',
  LOAN_BALANCE_CHANGED: 'The loan balance changed since the settlement was recorded; reject it and record it again.',
  FORBIDDEN: 'The selected role cannot do this. Waiving or writing off a balance needs its own grant.',
};

function Refusal({ error }: { error: unknown }) {
  if (error instanceof ApiError && LOAN_WORDS[error.code]) {
    return (
      <p role="alert" className="error">
        {LOAN_WORDS[error.code]}
      </p>
    );
  }
  return <ErrorNote error={error} />;
}

function LoanSettlementsScreen() {
  const { can } = useSession();
  const loans = useQuery({
    queryKey: ['exit-finance', 'disbursed-loans'],
    queryFn: () => api<{ items: Loan[] }>('/v1/payroll-outputs/loans?state=DISBURSED'),
    enabled: can(LOAN_READ),
    retry: retryTransient,
  });
  return (
    <>
      <h1>Loan early settlement</h1>
      <Section title="Disbursed loans and advances">
        <p className="hint">
          An early settlement closes a disbursed loan in full: the employee repays the balance outside payroll or through the paid full and final settlement, and the
          company may waive or write off the rest. You enter the amounts with the evidence; someone else decides. Nothing is calculated here.
        </p>
        {!can(LOAN_READ) && <p className="hint">The selected role cannot view loans.</p>}
        <ErrorNote error={loans.error} />
        {loans.data && loans.data.items.length === 0 && <Empty>No disbursed loan or advance in the selected role’s scope.</Empty>}
        {loans.data && loans.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Employee</th>
                <th>Kind</th>
                <th>Principal</th>
                <th>Outstanding</th>
                <th>Disbursed</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {loans.data.items.map((l) => (
                <tr key={l.id}>
                  <td>{l.employeeCode}</td>
                  <td>{l.loanKind === 'ADVANCE' ? 'Salary advance' : 'Loan'}</td>
                  <td>{formatAmount(l.principal, l.currencyCode)}</td>
                  <td>{formatAmount(l.outstanding, l.currencyCode)}</td>
                  <td>{formatDate(l.disbursementDate)}</td>
                  <td>{can(LOAN_DISBURSE) ? <Link to={EXIT_FINANCE_PATHS.recordLoanSettlement(l.id)}>Record an early settlement</Link> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  );
}

function RecordLoanSettlementScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  const qc = useQueryClient();
  const loan = useQuery({ queryKey: ['exit-finance', 'loan', id], queryFn: () => api<Loan>(`/v1/payroll-outputs/loans/${enc(id)}`), retry: retryTransient });
  const l = loan.data;
  const paidSettlements = useQuery({
    queryKey: ['exit-finance', 'paid-settlements', l?.employeeCode ?? '-'],
    queryFn: () => api<{ items: PaidSettlement[] }>(`/v1/settlements?state=PAID&employeeCode=${enc(l!.employeeCode)}`),
    enabled: l !== undefined && can(SETTLEMENT_READ_AMOUNT),
    retry: retryTransient,
  });
  const [repaid, setRepaid] = useState('');
  const [route, setRoute] = useState('DIRECT_REPAYMENT');
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [doc, setDoc] = useState<string | null>(null);
  const [settlementId, setSettlementId] = useState('');
  const [waived, setWaived] = useState('');
  const [waiverKind, setWaiverKind] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const key = useRef<string | null>(null);
  const record = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Loan>(`/v1/payroll-outputs/loans/${enc(id)}/early-settlement`, { body }),
    onSuccess: () => {
      key.current = null;
      void qc.invalidateQueries({ queryKey: ['exit-finance'] });
    },
  });
  if (!can(LOAN_DISBURSE)) {
    return (
      <>
        <h1>Record an early settlement</h1>
        <p className="hint">The selected role cannot record early settlements of loans.</p>
      </>
    );
  }
  const pending = l?.earlySettlements?.find((s) => s.state === 'PROPOSED');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!l || record.isPending) return;
    const repaidAmount = repaid.trim() || '0';
    const waivedAmount = waived.trim() || '0';
    if (!AMOUNT.test(repaidAmount) || !AMOUNT.test(waivedAmount)) return setProblem('Amounts are decimal numbers with up to 4 decimal places.');
    if (!reason.trim()) return setProblem('Give the reason for the early settlement.');
    const repaying = Number(repaidAmount) > 0;
    if (repaying && route === 'DIRECT_REPAYMENT' && (!date || !reference.trim() || !doc)) return setProblem('Give the repayment date, its reference and its verified evidence document.');
    if (repaying && route === 'FINAL_SETTLEMENT' && !settlementId) return setProblem('Choose the paid full and final settlement that recovered the loan.');
    if (Number(waivedAmount) > 0 && !waiverKind) return setProblem('Say whether the rest is waived or written off.');
    setProblem(null);
    key.current ??= idempotencyKey('repay');
    record.mutate({
      repaidAmount,
      ...(repaying ? { repaymentRoute: route } : {}),
      ...(repaying && route === 'DIRECT_REPAYMENT' ? { repaymentDate: date, evidenceKey: key.current, evidenceReference: reference.trim(), evidenceDocumentIds: [doc] } : {}),
      ...(repaying && route === 'FINAL_SETTLEMENT' ? { settlementId } : {}),
      ...(Number(waivedAmount) > 0 ? { waivedAmount, waiverKind } : {}),
      reason: reason.trim(),
      expectedVersion: l.version,
    });
  };
  return (
    <>
      <h1>Record an early settlement</h1>
      <p className="row">
        <Link to={EXIT_FINANCE_PATHS.loanSettlements}>Loan early settlement</Link>
      </p>
      <ErrorNote error={loan.error} />
      {l && (
        <Section title={`${l.loanKind === 'ADVANCE' ? 'Salary advance' : 'Loan'} of ${l.employeeCode}`}>
          <dl className="kv">
            <dt>State</dt>
            <dd>
              <StateBadge state={l.state} />
            </dd>
            <dt>Principal</dt>
            <dd>{formatAmount(l.principal, l.currencyCode)}</dd>
            <dt>Recovered from processed payroll</dt>
            <dd>{formatAmount(l.recovered, l.currencyCode)}</dd>
            <dt>Deducted, not yet recognised</dt>
            <dd>{formatAmount(l.awaitingRecognition, l.currencyCode)}</dd>
            <dt>Outstanding</dt>
            <dd>{formatAmount(l.outstanding, l.currencyCode)}</dd>
          </dl>
          {(l.earlySettlements ?? []).length > 0 && (
            <ul>
              {(l.earlySettlements ?? []).map((s) => (
                <li key={s.id}>
                  {`${s.state === 'PROPOSED' ? 'Waiting for a decision' : s.state === 'APPROVED' ? 'Approved' : 'Rejected'}: repaid ${formatAmount(s.repaidAmount, l.currencyCode)}${s.repaymentRoute ? ` (${ROUTE_LABEL[s.repaymentRoute]})` : ''}, waived or written off ${formatAmount(s.waivedAmount, l.currencyCode)}, recorded ${formatDate(s.recordedAt)}`}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {l && l.state === 'DISBURSED' && !pending && (
        <Section title="Early settlement">
          <form onSubmit={submit} className="grid-form" aria-label="Record an early settlement">
            <p className="hint wide">The repaid and waived amounts must add up to the outstanding balance; the loan closes in full once someone else approves.</p>
            <label>
              Repaid by the employee
              <input inputMode="decimal" value={repaid} onChange={(e) => setRepaid(e.target.value)} placeholder={l.outstanding} />
            </label>
            <label>
              How it was repaid
              <select value={route} onChange={(e) => setRoute(e.target.value)}>
                {Object.entries(ROUTE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {route === 'DIRECT_REPAYMENT' && (
              <>
                <label>
                  Repayment date
                  <input type="date" value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} />
                </label>
                <label>
                  Receipt or bank reference
                  <input value={reference} maxLength={500} onChange={(e) => setReference(e.target.value)} />
                </label>
                <VerifiedEvidencePicker employeeId={l.employeeId} chosen={doc} onChange={setDoc} legend="Evidence of the repayment (released and verified)" />
              </>
            )}
            {route === 'FINAL_SETTLEMENT' && (
              <label>
                Paid full and final settlement
                <select value={settlementId} onChange={(e) => setSettlementId(e.target.value)}>
                  <option value="">Choose…</option>
                  {(paidSettlements.data?.items ?? [])
                    .filter((s) => s.employeeId === l.employeeId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>{`Revision ${s.revision}, paid ${formatDate(s.paymentDate ?? null)}`}</option>
                    ))}
                </select>
              </label>
            )}
            <label>
              Waived or written off
              <input inputMode="decimal" value={waived} onChange={(e) => setWaived(e.target.value)} placeholder="0" />
            </label>
            <label>
              Kind
              <select value={waiverKind} onChange={(e) => setWaiverKind(e.target.value)}>
                <option value="">Nothing waived</option>
                {Object.entries(WAIVER_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              Reason
              <textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
            </label>
            <div className="row">
              <button type="submit" disabled={record.isPending}>
                Record for an independent decision
              </button>
            </div>
          </form>
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
          <Refusal error={record.error} />
          {record.isSuccess && (
            <p role="status" className="ok">
              Recorded. Someone other than you decides it; the loan closes only when it is approved.
            </p>
          )}
        </Section>
      )}
      {pending && <p className="hint">An early settlement of this loan is waiting for its decision.</p>}
    </>
  );
}

interface PendingLoanSettlement {
  id: string;
  loanId: string;
  employeeCode: string;
  currencyCode: string;
  balance: string;
  repaidAmount: string;
  repaymentRoute: string | null;
  waivedAmount: string;
  waiverKind: string | null;
  recordedBy: string;
  recordedAt: string;
  version: number;
}

function LoanSettlementDecision({ item }: { item: PendingLoanSettlement }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'REJECT') =>
      api(`/v1/payroll-outputs/loan-settlements/${enc(item.id)}/decision`, { body: { decision, expectedVersion: item.version, ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['exit-finance'] }),
  });
  const recorder = me?.userId === item.recordedBy;
  return (
    <li>
      <p>
        {`${item.employeeCode}: balance ${formatAmount(item.balance, item.currencyCode)}; repaid ${formatAmount(item.repaidAmount, item.currencyCode)}${item.repaymentRoute ? ` (${ROUTE_LABEL[item.repaymentRoute]})` : ''}; ${item.waiverKind ? `${WAIVER_LABEL[item.waiverKind]} ${formatAmount(item.waivedAmount, item.currencyCode)}` : 'nothing waived'}.`}
      </p>
      {recorder && <p className="hint">You recorded this settlement, so someone else decides it.</p>}
      <label>
        Reason (required to reject)
        <input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row">
        <button type="button" disabled={decide.isPending || recorder} onClick={() => decide.mutate('APPROVE')}>
          Approve and close the loan
        </button>
        <button type="button" disabled={decide.isPending || recorder || !reason.trim()} onClick={() => decide.mutate('REJECT')}>
          Reject
        </button>
      </div>
      <Refusal error={decide.error} />
    </li>
  );
}

function LoanSettlementQueue() {
  const list = useQuery({
    queryKey: ['exit-finance', 'loan-settlement-queue'],
    queryFn: () => api<{ items: PendingLoanSettlement[] }>('/v1/payroll-outputs/loan-settlements'),
    retry: retryTransient,
  });
  return (
    <Section title="Loan early settlements to decide">
      <ErrorNote error={list.error} />
      {list.data && list.data.items.length === 0 && <Empty>No early settlement is waiting.</Empty>}
      <ul>
        {list.data?.items.map((i) => (
          <LoanSettlementDecision key={i.id} item={i} />
        ))}
      </ul>
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// FR-018, FR-054, BR-053 (I-81 items 4, 9): the employee's own letters and statements delivered in-app
// ---------------------------------------------------------------------------------------------------------
interface OwnDelivery {
  id: string;
  kind: string;
  title: string;
  format: string;
  status: string;
  sentAt: string;
  firstReadAt: string | null;
}

function DocumentsReceivedScreen() {
  const { can } = useSession();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['exit-finance', 'documents-received'],
    queryFn: () => api<{ items: OwnDelivery[] }>('/v1/me/deliveries'),
    enabled: can(OWN_DELIVERY),
    retry: retryTransient,
  });
  const open = useMutation({
    mutationFn: (id: string) => download(`/v1/me/deliveries/${enc(id)}/file`),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['exit-finance', 'documents-received'] }),
  });
  return (
    <>
      <h1>My documents received</h1>
      <Section title="Letters and statements sent to you">
        <p className="hint">Documents HR sends you arrive here, never as e-mail attachments. They stay available after you leave.</p>
        {!can(OWN_DELIVERY) && <p className="hint">The selected role has no self-service documents.</p>}
        <ErrorNote error={list.error} />
        {list.data && list.data.items.length === 0 && <Empty>Nothing has been sent to you yet.</Empty>}
        {list.data && list.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Format</th>
                <th>Sent</th>
                <th>Opened</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((d) => (
                <tr key={d.id}>
                  <td>{d.title}</td>
                  <td>{d.format === 'TEXT' ? 'Text' : d.format}</td>
                  <td>{formatDate(d.sentAt)}</td>
                  <td>{d.firstReadAt ? formatDate(d.firstReadAt) : 'Not yet'}</td>
                  <td>
                    <button type="button" disabled={open.isPending} onClick={() => open.mutate(d.id)}>
                      Download
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <ErrorNote error={open.error} />
      </Section>
    </>
  );
}

export const EXIT_FINANCE_SCREENS: ScreenRoute[] = [
  { path: EXIT_FINANCE_PATHS.loanSettlements, title: 'Loan early settlement', permission: LOAN_DISBURSE, nav: true, component: LoanSettlementsScreen },
  { path: '/payroll/loans/:id/early-settlement', title: 'Record an early settlement', permission: LOAN_DISBURSE, nav: false, component: RecordLoanSettlementScreen },
  { path: EXIT_FINANCE_PATHS.documentsReceived, title: 'My documents received', permission: OWN_DELIVERY, nav: true, component: DocumentsReceivedScreen },
];

export const EXIT_FINANCE_TASK_QUEUES = [{ permission: LOAN_DECIDE, title: 'Loan early settlements', component: LoanSettlementQueue }];
