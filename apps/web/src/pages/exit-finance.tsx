// Exit finance decided under owner delegation, 6 Nov 2026 (docs/03 I-81): FR-034 loan early settlement (recorded from evidence under
// the disbursement duty, decided by someone else; a waiver or write-off needs its own right), the employee's own documents received
// in-app (FR-018, FR-054, DF09: "send" is delivery to the person's own self-service, never an e-mail attachment; BR-053 own outputs,
// kept after leaving), and the verified-evidence choice the exit and settlement screens share. The server decides every rule; these
// screens hide what the selected assignment cannot use and say the server's refusals in plain words.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ButtonRow, CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, download, formatAmount, formatDate, idempotencyKey, localDate, retryTransient } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Item, Notice, Section, StateBadge } from '../ui';

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
const enc = encodeURIComponent;

// The screens' own layout pieces, as utility classes (shadcn/ui move, 20 Nov 2026).
/** Links side by side under the page's title (the old `p.row`). */
const LINK_ROW = 'flex flex-wrap items-center gap-x-4 gap-y-1';
/** The early settlements waiting for a decision, one card under another. */
const DECISION_LIST = 'm-0 flex list-none flex-col gap-3 p-0';
/**
 * One early settlement to decide: a card inside the queue's card, its parts stacked. It keeps the `card` marker class, so its note is
 * drawn as a card's own (a boxed hint), as the other decision items of payroll are.
 */
const DECISION_ITEM = 'card flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4 shadow-xs';
/** The reason of a decision keeps a readable width, as the old form fields had it. */
const READABLE_WIDTH = 'max-w-[560px]';
/** A date or an amount of a table: it stays on one line. */
const FIGURE_CELL = 'whitespace-nowrap';

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

/**
 * One released, verified document of the employee as evidence; the files are not opened here. Placed in a form grid (FormGrid), it
 * takes the grid's whole row, as the payroll screens' evidence choice does.
 */
export function VerifiedEvidencePicker({ employeeId, chosen, onChange, legend }: { employeeId: string; chosen: string | null; onChange: (id: string) => void; legend: string }) {
  const { can } = useSession();
  const name = useId();
  const docs = useQuery({
    queryKey: ['exit-finance', 'evidence', employeeId],
    queryFn: () => api<{ items: EvidenceDocument[] }>(`/v1/employees/${enc(employeeId)}/documents`),
    enabled: can(DOCUMENT_READ),
    retry: retryTransient,
  });
  if (!can(DOCUMENT_READ)) return <Hint className="col-span-full">The selected role cannot list the employee’s documents, so it cannot choose the evidence here.</Hint>;
  return (
    <FieldSet className="col-span-full gap-[0.55rem]">
      <legend>{legend}</legend>
      {docs.isPending && <LoadingLine>Loading the employee’s documents…</LoadingLine>}
      <ErrorNote error={docs.error} />
      {docs.data && docs.data.items.length === 0 && <Hint>The employee has no documents yet: add the evidence to their record and have it verified first.</Hint>}
      {docs.data?.items.map((d) => {
        const usable = d.scanState === 'CLEAN' && d.verificationState === 'VERIFIED';
        return (
          <CheckField key={d.id}>
            <input type="radio" name={name} checked={chosen === d.id} disabled={!usable} onChange={() => onChange(d.id)} />{' '}
            {`${d.documentType}${d.fileName ? ` · ${d.fileName}` : ''} (${formatDate(d.uploadedAt)}): ${evidenceState(d)}`}
          </CheckField>
        );
      })}
    </FieldSet>
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
  if (error instanceof ApiError && LOAN_WORDS[error.code]) return <Notice notice={{ text: LOAN_WORDS[error.code]!, ok: false }} />;
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
        <Hint>
          An early settlement closes a disbursed loan in full: the employee repays the balance outside payroll or through the paid full and final settlement, and the
          company may waive or write off the rest. You enter the amounts with the evidence; someone else decides. Nothing is calculated here.
        </Hint>
        {!can(LOAN_READ) && <Hint>The selected role cannot view loans.</Hint>}
        <ErrorNote error={loans.error} />
        {loans.data && loans.data.items.length === 0 && <Empty>No disbursed loan or advance in the selected role’s scope.</Empty>}
        {loans.data && loans.data.items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Employee</TableHead>
                <TableHead scope="col">Kind</TableHead>
                <TableHead scope="col">Principal</TableHead>
                <TableHead scope="col">Outstanding</TableHead>
                <TableHead scope="col">Disbursed</TableHead>
                <TableHead scope="col">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loans.data.items.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.employeeCode}</TableCell>
                  <TableCell>{l.loanKind === 'ADVANCE' ? 'Salary advance' : 'Loan'}</TableCell>
                  <TableCell className={FIGURE_CELL}>{formatAmount(l.principal, l.currencyCode)}</TableCell>
                  <TableCell className={FIGURE_CELL}>{formatAmount(l.outstanding, l.currencyCode)}</TableCell>
                  <TableCell className={FIGURE_CELL}>{formatDate(l.disbursementDate)}</TableCell>
                  <TableCell>{can(LOAN_DISBURSE) ? <Link to={EXIT_FINANCE_PATHS.recordLoanSettlement(l.id)}>Record an early settlement</Link> : '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
        <Hint>The selected role cannot record early settlements of loans.</Hint>
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
      <p className={LINK_ROW}>
        <Link to={EXIT_FINANCE_PATHS.loanSettlements}>Loan early settlement</Link>
      </p>
      <ErrorNote error={loan.error} />
      {l && (
        <Section title={`${l.loanKind === 'ADVANCE' ? 'Salary advance' : 'Loan'} of ${l.employeeCode}`}>
          <dl className="kv">
            <Item term="State">
              <StateBadge state={l.state} />
            </Item>
            <Item term="Principal">{formatAmount(l.principal, l.currencyCode)}</Item>
            <Item term="Recovered from processed payroll">{formatAmount(l.recovered, l.currencyCode)}</Item>
            <Item term="Deducted, not yet recognised">{formatAmount(l.awaitingRecognition, l.currencyCode)}</Item>
            <Item term="Outstanding">{formatAmount(l.outstanding, l.currencyCode)}</Item>
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
          <FormGrid onSubmit={submit} aria-label="Record an early settlement">
            <Hint>The repaid and waived amounts must add up to the outstanding balance; the loan closes in full once someone else approves.</Hint>
            <FormField>
              Repaid by the employee
              <Input inputMode="decimal" value={repaid} onChange={(e) => setRepaid(e.target.value)} placeholder={l.outstanding} />
            </FormField>
            <FormField>
              How it was repaid
              <NativeSelect value={route} onChange={(e) => setRoute(e.target.value)}>
                {Object.entries(ROUTE_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            {route === 'DIRECT_REPAYMENT' && (
              <>
                <FormField>
                  Repayment date
                  <Input type="date" value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} />
                </FormField>
                <FormField>
                  Receipt or bank reference
                  <Input value={reference} maxLength={500} onChange={(e) => setReference(e.target.value)} />
                </FormField>
                <VerifiedEvidencePicker employeeId={l.employeeId} chosen={doc} onChange={setDoc} legend="Evidence of the repayment (released and verified)" />
              </>
            )}
            {route === 'FINAL_SETTLEMENT' && (
              <FormField>
                Paid full and final settlement
                <NativeSelect value={settlementId} onChange={(e) => setSettlementId(e.target.value)}>
                  <option value="">Choose…</option>
                  {(paidSettlements.data?.items ?? [])
                    .filter((s) => s.employeeId === l.employeeId)
                    .map((s) => (
                      <option key={s.id} value={s.id}>{`Revision ${s.revision}, paid ${formatDate(s.paymentDate ?? null)}`}</option>
                    ))}
                </NativeSelect>
              </FormField>
            )}
            <FormField>
              Waived or written off
              <Input inputMode="decimal" value={waived} onChange={(e) => setWaived(e.target.value)} placeholder="0" />
            </FormField>
            <FormField>
              Kind
              <NativeSelect value={waiverKind} onChange={(e) => setWaiverKind(e.target.value)}>
                <option value="">Nothing waived</option>
                {Object.entries(WAIVER_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField className="col-span-full">
              Reason
              <Textarea value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            <ButtonRow>
              <Button type="submit" disabled={record.isPending}>
                Record for an independent decision
              </Button>
            </ButtonRow>
          </FormGrid>
          {problem && <Notice notice={{ text: problem, ok: false }} />}
          <Refusal error={record.error} />
          {record.isSuccess && <Notice notice={{ text: 'Recorded. Someone other than you decides it; the loan closes only when it is approved.', ok: true }} />}
        </Section>
      )}
      {pending && <Hint>An early settlement of this loan is waiting for its decision.</Hint>}
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
    <li className={DECISION_ITEM}>
      <p className="m-0">
        {`${item.employeeCode}: balance ${formatAmount(item.balance, item.currencyCode)}; repaid ${formatAmount(item.repaidAmount, item.currencyCode)}${item.repaymentRoute ? ` (${ROUTE_LABEL[item.repaymentRoute]})` : ''}; ${item.waiverKind ? `${WAIVER_LABEL[item.waiverKind]} ${formatAmount(item.waivedAmount, item.currencyCode)}` : 'nothing waived'}.`}
      </p>
      {recorder && <Hint>You recorded this settlement, so someone else decides it.</Hint>}
      <FormField className={READABLE_WIDTH}>
        Reason (required to reject)
        <Input value={reason} maxLength={1000} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <ButtonRow>
        <Button type="button" disabled={decide.isPending || recorder} onClick={() => decide.mutate('APPROVE')}>
          Approve and close the loan
        </Button>
        <Button type="button" variant="danger" disabled={decide.isPending || recorder || !reason.trim()} onClick={() => decide.mutate('REJECT')}>
          Reject
        </Button>
      </ButtonRow>
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
      <ul className={DECISION_LIST}>
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
        <Hint>Documents HR sends you arrive here, never as e-mail attachments. They stay available after you leave.</Hint>
        {!can(OWN_DELIVERY) && <Hint>The selected role has no self-service documents.</Hint>}
        <ErrorNote error={list.error} />
        {list.data && list.data.items.length === 0 && <Empty>Nothing has been sent to you yet.</Empty>}
        {list.data && list.data.items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Document</TableHead>
                <TableHead scope="col">Format</TableHead>
                <TableHead scope="col">Sent</TableHead>
                <TableHead scope="col">Opened</TableHead>
                <TableHead scope="col">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell>{d.title}</TableCell>
                  <TableCell>{d.format === 'TEXT' ? 'Text' : d.format}</TableCell>
                  <TableCell className={FIGURE_CELL}>{formatDate(d.sentAt)}</TableCell>
                  <TableCell>{d.firstReadAt ? formatDate(d.firstReadAt) : 'Not yet'}</TableCell>
                  <RowActionsCell>
                    <RowActions>
                      <Button type="button" variant="outline" size="sm" disabled={open.isPending} onClick={() => open.mutate(d.id)}>
                        Download
                      </Button>
                    </RowActions>
                  </RowActionsCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
