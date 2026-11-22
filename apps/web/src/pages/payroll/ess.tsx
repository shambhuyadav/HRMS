// My ESS payroll panels: TN06 own issued payslips (with own hold status) and TN15 own loans and advances.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentPropsWithoutRef, type FormEvent, type ReactNode, useId, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, download, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { statutoryWorkingsNote } from '../../statutory-note';
import { Badge, Empty, LIST_PAGE_SIZE, Notice, Pager, pageParams, Section } from '../../ui';
import { Missing, Note } from './pickers';
import { Problem, ReasonForm } from './problems';
import { Fact, label, LOAN_KIND, LOAN_STATE, MONEY, money, OWN_LOAN_READ, OWN_LOAN_REQUEST, OWN_PAYSLIP, ownContext, Status, useIntentKey, useKeys } from './shared';
import type { Installment, LoanRecovery, OwnLoan, OwnLoans, OwnPayslip, OwnPayslips } from './types';

// =========================================================================================================
// Loans as cards in a list (one's own loans here, the requests to decide on the HR loans screen)
// =========================================================================================================

/** A list of loans, one card under another. */
export const LOAN_LIST = 'm-0 flex list-none flex-col gap-3 p-0';

/**
 * One loan of a list: a card inside the list's card. It keeps the `card` marker class, so its notes and forms are drawn as a card's
 * own (a boxed hint, a form without a frame of its own), as they were before the move to shadcn/ui.
 */
export function LoanCard(props: ComponentPropsWithoutRef<'li'>) {
  return <li className="card rounded-xl border border-border bg-card px-5 py-4 shadow-xs" {...props} />;
}

// =========================================================================================================
// My ESS TN06: own issued payslips
// =========================================================================================================

function OwnOnly({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section title={title}>
      <Hint>{children}</Hint>
    </Section>
  );
}

export function MyPayslipsPanel() {
  const { me, can } = useSession();
  if (!me) return <LoadingLine>Loading your role…</LoadingLine>;
  if (!ownContext(me)) return <OwnOnly title="My payslips">Your own payslips are shown in your Employee role. Switch to it to see them.</OwnOnly>;
  if (!can(OWN_PAYSLIP)) return <OwnOnly title="My payslips">Your Employee role does not include payslips; contact HR.</OwnOnly>;
  return (
    <>
      <OwnPayslipList />
      <OwnHoldStatus />
    </>
  );
}

/** GET /v1/me/payroll-holds (H7): the status of the employee's own held salary; never a reason or an amount. */
interface OwnHold {
  id: string;
  periodCode: string;
  state: 'ON_HOLD' | 'RELEASED';
  heldFrom: string;
  releasedAt: string | null;
}

/**
 * H7 "employee sees own permitted reason/status" (TN06): the period, ON_HOLD or RELEASED and the dates. Which reason
 * text an employee may see is an owner decision, so no reason is shown; the held amount is on the payslip above.
 */
function OwnHoldStatus() {
  const keys = useKeys();
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: [...keys.ownHolds, page],
    queryFn: () => api<{ items: OwnHold[]; total?: number }>(`/v1/me/payroll-holds?${pageParams(page)}`),
    retry: retryTransient,
  });
  const data = list.data;
  return (
    <Section title="My salary payment holds">
      <Hint>A hold withholds payment of earned salary; it never reduces what you earned. Only the status and dates are shown here.</Hint>
      {list.isPending && <LoadingLine>Loading your salary payment holds…</LoadingLine>}
      {list.error && <Problem error={list.error} act="own" />}
      {data && data.items.length === 0 && <Empty>No payment of your salary is or was on hold.</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="My salary payment holds">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Period</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Held from</TableHead>
              <TableHead scope="col">Released</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((h) => (
              <TableRow key={h.id}>
                <TableCell>{h.periodCode}</TableCell>
                <TableCell>{h.state === 'RELEASED' ? <Badge tone="good">Released for payment</Badge> : <Badge tone="warn">On hold</Badge>}</TableCell>
                <TableCell>{formatDate(h.heldFrom)}</TableCell>
                <TableCell>{h.releasedAt ? formatDate(h.releasedAt) : '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={data.total ?? data.items.length} onPage={setPage} label="Salary hold pages" noun="hold" />}
    </Section>
  );
}

function OwnPayslipList() {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownPayslips, queryFn: () => api<OwnPayslips>('/v1/me/payslips'), retry: retryTransient });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [viewing, setViewing] = useState<OwnPayslip | null>(null);
  const fetchFile = async (p: OwnPayslip) => {
    if (busyId) return;
    setBusyId(p.id);
    setFailure(null);
    try {
      await download(`/v1/me/payslips/${encodeURIComponent(p.id)}/file`);
    } catch (e) {
      setFailure(e);
    } finally {
      setBusyId(null);
    }
  };
  const data = list.data;
  return (
    <Section title="My payslips">
      <Hint role="note">
        Publication of a payslip does not mean the salary has been paid. Earned is your frozen net pay; held is withheld under an approved hold; reserved is in a bank file being paid;
        paid is only what confirmed payment evidence shows.
      </Hint>
      {list.isPending && <LoadingLine>Loading your payslips…</LoadingLine>}
      {list.error && <Problem error={list.error} act="own" />}
      {data && data.items.length === 0 && <Empty>No payslip has been issued to you yet.</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="My payslips">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Period</TableHead>
              <TableHead scope="col">Version</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Issued</TableHead>
              <TableHead scope="col">Earned</TableHead>
              <TableHead scope="col">Held</TableHead>
              <TableHead scope="col">Reserved</TableHead>
              <TableHead scope="col">Paid (confirmed)</TableHead>
              <TableHead scope="col">File</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.periodCode}</TableCell>
                <TableCell>{p.version}</TableCell>
                <TableCell>
                  {p.publicationState === 'SUPERSEDED' ? (
                    <Badge tone="warn">{`Replaced by a later version${p.supersededAt ? ` on ${formatDate(p.supersededAt)}` : ''}`}</Badge>
                  ) : (
                    <Badge>Current version</Badge>
                  )}
                </TableCell>
                <TableCell>{formatDate(p.issuedAt)}</TableCell>
                {p.payment ? (
                  <>
                    <TableCell>{money(p.payment.earned)}</TableCell>
                    <TableCell>{money(p.payment.held)}</TableCell>
                    <TableCell>{money(p.payment.reserved)}</TableCell>
                    <TableCell>{money(p.payment.paid)}</TableCell>
                  </>
                ) : (
                  <TableCell colSpan={4}>See the current version</TableCell>
                )}
                <RowActionsCell>
                  <RowActions>
                    <Button type="button" variant="outline" size="sm" onClick={() => setViewing(p)} aria-label={`View payslip ${p.periodCode} version ${p.version}`}>
                      View
                    </Button>{' '}
                    <Button type="button" variant="outline" size="sm" disabled={busyId !== null} onClick={() => void fetchFile(p)} aria-label={`Download payslip ${p.periodCode} version ${p.version}`}>
                      {busyId === p.id ? 'Downloading…' : 'Download'}
                    </Button>
                  </RowActions>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {failure !== null && <Problem error={failure} act="download" />}
      {data?.form16?.status === 'NOT_CONFIGURED' && <Hint>Form 16 is not available: no statutory Form 16 template is configured yet.</Hint>}
      {viewing && <PayslipDocument payslip={viewing} onClose={() => setViewing(null)} />}
    </Section>
  );
}

interface PayslipStatutory {
  componentCode: string;
  componentName: string;
  status: string;
  amount: string | null;
  workings: Record<string, unknown>;
}
interface PayslipDoc {
  period: { code: string; serviceStart: string; serviceEnd: string; paymentDate: string | null };
  version: number;
  currencyCode: string;
  paidDays: string | null;
  daysInMonth: number;
  lines: { componentCode: string; componentName: string; headType: string; amount: string }[];
  statutory?: PayslipStatutory[];
  totals: { earnings: string | null; reimbursements: string | null; gross: string | null; deductions: string | null; net: string | null; employerContributions: string | null };
  paymentAtPublication: { earned: string; held: string; reserved: string; paid: string };
  notices: string[];
}

const LINE_GROUPS: [string, string][] = [
  ['EARNING', 'Earnings'],
  ['REIMBURSEMENT', 'Reimbursements'],
  ['DEDUCTION', 'Deductions'],
  ['EMPLOYER_CONTRIBUTION', 'Paid by the employer (not part of your pay)'],
];

/**
 * A payslip table's name (Earnings, Deductions …) reads as its heading, above it on the left in the text colour: these tables have
 * no column headings, so the name is what says what the lines are.
 */
const PAYSLIP_CAPTION = 'mt-0 mb-2 text-left font-medium text-foreground';

/**
 * How a statutory line was worked out, in plain words, from the workings the calculation recorded on the payslip (I-85, I-90, FR-039):
 * the employee sees the basis of each deduction, never a figure computed here.
 */
export function statutoryNote(s: PayslipStatutory, currency: string): string {
  return statutoryWorkingsNote(s.status === 'VALUED', s.workings, (v) => money(v, currency));
}

/** The issued payslip itself, read from the stored file (the same bytes the download gives, re-checked on every read, CI30). */
function PayslipDocument({ payslip, onClose }: { payslip: OwnPayslip; onClose: () => void }) {
  const keys = useKeys();
  const doc = useQuery({
    queryKey: keys.ownPayslipFile(payslip.id),
    queryFn: () => api<PayslipDoc>(`/v1/me/payslips/${encodeURIComponent(payslip.id)}/file`),
    retry: retryTransient,
  });
  const d = doc.data;
  const cur = d?.currencyCode;
  return (
    <Section title={`Payslip ${payslip.periodCode}, version ${payslip.version}`}>
      <Button type="button" variant="outline" onClick={onClose}>
        Close
      </Button>
      {doc.isPending && <LoadingLine>Loading the payslip…</LoadingLine>}
      {doc.error && <Problem error={doc.error} act="own" />}
      {d && (
        <>
          <dl className="kv" aria-label="Payslip period">
            <Fact term="Period">{`${d.period.code} (${formatDate(d.period.serviceStart)} to ${formatDate(d.period.serviceEnd)})`}</Fact>
            <Fact term="Paid days">{`${d.paidDays ?? '—'} of ${d.daysInMonth}`}</Fact>
          </dl>
          {LINE_GROUPS.map(([type, title]) => {
            const lines = d.lines.filter((l) => l.headType === type);
            if (lines.length === 0) return null;
            return (
              <Table key={type} aria-label={title} className="caption-top">
                <TableCaption className={PAYSLIP_CAPTION}>{title}</TableCaption>
                <TableBody>
                  {lines.map((l) => (
                    <TableRow key={l.componentCode}>
                      <TableCell>{l.componentName}</TableCell>
                      <TableCell>{money(l.amount, cur)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            );
          })}
          <dl className="kv" aria-label="Payslip totals">
            <Fact term="Gross">{money(d.totals.gross, cur)}</Fact>
            <Fact term="Deductions">{money(d.totals.deductions, cur)}</Fact>
            <Fact term="Net pay">{money(d.totals.net, cur)}</Fact>
          </dl>
          {d.statutory && d.statutory.length > 0 && (
            <Table aria-label="How statutory amounts were worked out" className="caption-top">
              <TableCaption className={PAYSLIP_CAPTION}>How statutory amounts were worked out</TableCaption>
              <TableBody>
                {d.statutory.map((s) => (
                  <TableRow key={s.componentCode}>
                    <TableCell>{s.componentName}</TableCell>
                    <TableCell>{s.amount === null ? '—' : money(s.amount, cur)}</TableCell>
                    <TableCell>{statutoryNote(s, d.currencyCode)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <dl className="kv" aria-label="Payment at publication">
            <Fact term="Earned">{money(d.paymentAtPublication.earned, cur)}</Fact>
            <Fact term="Held">{money(d.paymentAtPublication.held, cur)}</Fact>
            <Fact term="Reserved">{money(d.paymentAtPublication.reserved, cur)}</Fact>
            <Fact term="Paid (confirmed)">{money(d.paymentAtPublication.paid, cur)}</Fact>
          </dl>
          {d.notices.map((n) => (
            <Hint key={n}>{n}</Hint>
          ))}
        </>
      )}
    </Section>
  );
}

// =========================================================================================================
// My ESS TN15: own loans and advances
// =========================================================================================================

export function MyLoansPanel() {
  const { me, can } = useSession();
  if (!me) return <LoadingLine>Loading your role…</LoadingLine>;
  if (!ownContext(me)) return <OwnOnly title="My loans and advances">Your own loans are shown in your Employee role. Switch to it to see or request them.</OwnOnly>;
  if (!can(OWN_LOAN_READ) && !can(OWN_LOAN_REQUEST)) return <OwnOnly title="My loans and advances">Your Employee role does not include loans; contact HR.</OwnOnly>;
  return (
    <div className="stack">
      {can(OWN_LOAN_READ) && <OwnLoanList canWithdraw={can(OWN_LOAN_REQUEST)} />}
      {can(OWN_LOAN_REQUEST) && <LoanRequestForm />}
    </div>
  );
}

function OwnLoanList({ canWithdraw }: { canWithdraw: boolean }) {
  const keys = useKeys();
  const list = useQuery({ queryKey: keys.ownLoans, queryFn: () => api<OwnLoans>('/v1/me/loans'), retry: retryTransient });
  const [note, setNote] = useState<string | null>(null);
  const data = list.data;
  return (
    <Section title="My loans and advances">
      {list.isPending && <LoadingLine>Loading your loans…</LoadingLine>}
      {list.error && <Problem error={list.error} act="own" />}
      {data?.interest?.status === 'NOT_CONFIGURED' && <Hint>Loans carry no interest: no approved interest rate is configured.</Hint>}
      {data?.earlySettlement?.status === 'NOT_CONFIGURED' && <Hint>Early settlement is not available: no settlement rule is configured.</Hint>}
      <Notice notice={note ? { text: note, ok: true } : null} />
      {data && data.items.length === 0 && <Empty>You have no loans or advances.</Empty>}
      {data && data.items.length > 0 && (
        <ul className={LOAN_LIST}>
          {data.items.map((l) => (
            <OwnLoanItem key={l.id} loan={l} canWithdraw={canWithdraw} onWithdrawn={() => setNote('Your request was withdrawn.')} />
          ))}
        </ul>
      )}
    </Section>
  );
}

export function ScheduleTables({ loan, name }: { loan: { currencyCode: string; installments?: Installment[]; recoveries?: LoanRecovery[] }; name: string }) {
  return (
    <>
      {loan.installments && loan.installments.length > 0 ? (
        <Table aria-label={`Recovery schedule of ${name}`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Instalment</TableHead>
              <TableHead scope="col">Due month</TableHead>
              <TableHead scope="col">Amount</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loan.installments.map((i) => (
              <TableRow key={i.sequence}>
                <TableCell>{i.sequence}</TableCell>
                <TableCell>{i.dueMonth}</TableCell>
                <TableCell>{money(i.amount, loan.currencyCode)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <Hint>No recovery schedule yet: it is fixed when the request is approved.</Hint>
      )}
      {loan.recoveries && loan.recoveries.length > 0 && (
        <Table aria-label={`Recoveries of ${name}`}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Payroll period</TableHead>
              <TableHead scope="col">Recovered</TableHead>
              <TableHead scope="col">Recognised</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loan.recoveries.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.periodCode}</TableCell>
                <TableCell>{money(r.amount, loan.currencyCode)}</TableCell>
                <TableCell>{formatDate(r.recognisedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function OwnLoanItem({ loan, canWithdraw, onWithdrawn }: { loan: OwnLoan; canWithdraw: boolean; onWithdrawn: () => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const titleId = useId();
  const name = `${label(LOAN_KIND, loan.loanKind)} requested ${formatDate(loan.requestedAt)}`;
  const withdraw = useMutation({
    mutationFn: (reason: string) => api<OwnLoan>(`/v1/me/loans/${encodeURIComponent(loan.id)}/withdraw`, { body: { reason, expectedVersion: loan.version } }),
    onSuccess: () => onWithdrawn(),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.ownLoans }),
  });
  // Only the requester withdraws, and only while undecided: an own request is one made in the Employee context.
  const withdrawable = canWithdraw && loan.state === 'REQUESTED' && loan.requestOrigin === 'EMPLOYEE';
  return (
    <LoanCard aria-labelledby={titleId}>
      <CardSubheading id={titleId}>{name}</CardSubheading>
      <dl className="kv">
        <Fact term="State">
          <Status map={LOAN_STATE} code={loan.state} />
        </Fact>
        <Fact term="Principal">{money(loan.principal, loan.currencyCode)}</Fact>
        <Fact term="Recovered">{money(loan.recovered, loan.currencyCode)}</Fact>
        {/[1-9]/.test(loan.awaitingRecognition ?? '') && <Fact term="Deducted, not yet recognised">{money(loan.awaitingRecognition!, loan.currencyCode)}</Fact>}
        <Fact term="Outstanding balance">{money(loan.outstanding, loan.currencyCode)}</Fact>
        <Fact term="Purpose">{loan.purpose}</Fact>
        <Fact term="Requested by">{loan.requestOrigin === 'EMPLOYEE' ? 'You' : 'HR, for you'}</Fact>
        {loan.decidedAt && <Fact term="Decided">{formatDate(loan.decidedAt)}</Fact>}
        {loan.decisionReason && <Fact term="Decision reason">{loan.decisionReason}</Fact>}
        {loan.disbursementDate && <Fact term="Disbursed">{formatDate(loan.disbursementDate)}</Fact>}
        {loan.closedAt && <Fact term="Closed">{formatDate(loan.closedAt)}</Fact>}
      </dl>
      <ScheduleTables loan={loan} name={name} />
      {withdrawable && (
        <ReasonForm
          name={`Withdraw ${name}`}
          field="Reason for withdrawing"
          button={withdraw.isPending ? 'Withdrawing…' : 'Withdraw the request'}
          busy={withdraw.isPending}
          danger
          onSend={(reason) => withdraw.mutateAsync(reason)}
        />
      )}
      <Problem error={withdraw.error} act="loan-withdraw" />
    </LoanCard>
  );
}

function LoanRequestForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  const intent = useIntentKey('own-loan');
  const [kind, setKind] = useState('LOAN');
  const [currency, setCurrency] = useState('');
  const [principal, setPrincipal] = useState('');
  const [purpose, setPurpose] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const send = useMutation({
    mutationFn: (body: { loanKind: string; currencyCode: string; principal: string; purpose: string; idempotencyKey: string }) =>
      api<OwnLoan & { replayed: boolean }>('/v1/me/loans', { body }),
    onSettled: (_data, error) => {
      intent.settle(error);
      void qc.invalidateQueries({ queryKey: keys.ownLoans });
    },
    onSuccess: (result) => {
      setKind('LOAN');
      setCurrency('');
      setPrincipal('');
      setPurpose('');
      setDone(result.replayed ? 'This request had already been received; nothing was sent twice.' : 'Your request was sent for an independent decision.');
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (send.isPending) return;
    setDone(null);
    const cur = currency.trim().toUpperCase();
    const amt = principal.trim();
    const text = purpose.trim();
    if (!/^[A-Z]{3}$/.test(cur)) return setProblem('Enter the currency as its three-letter code.');
    if (!MONEY.test(amt) || /^0+(\.0+)?$/.test(amt)) return setProblem('Enter the amount as a positive number, for example 25000.00.');
    if (!text) return setProblem('Give the purpose of the request.');
    setProblem(null);
    send.reset();
    const content = { loanKind: kind, currencyCode: cur, principal: amt, purpose: text };
    send.mutate({ ...content, idempotencyKey: intent.key(JSON.stringify(content)) });
  };
  return (
    <Section title="Request a loan or advance">
      <Hint>An independent HR administrator decides the request and fixes the recovery schedule. No interest is charged.</Hint>
      <FormGrid onSubmit={submit} aria-label="Request a loan or advance">
        <FormField>
          Kind
          <NativeSelect value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="LOAN">Loan</option>
            <option value="ADVANCE">Salary advance</option>
          </NativeSelect>
        </FormField>
        <FormField>
          Currency (three-letter code)
          <Input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} autoComplete="off" />
        </FormField>
        <FormField>
          Amount
          <Input value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" autoComplete="off" />
        </FormField>
        <FormField className="col-span-full">
          Purpose
          <Textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={1000} rows={2} />
        </FormField>
        <ButtonRow className="col-span-full">
          <Button type="submit" disabled={send.isPending}>
            {send.isPending ? 'Sending…' : 'Send the request'}
          </Button>
        </ButtonRow>
      </FormGrid>
      <Missing text={problem} />
      <Problem error={send.error} act="loan-request" />
      <Note text={done} />
    </Section>
  );
}
