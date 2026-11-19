// My ESS payroll panels: TN06 own issued payslips (with own hold status) and TN15 own loans and advances.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { api, download, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { statutoryWorkingsNote } from '../../statutory-note';
import { Badge, Empty, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../../ui';
import { Problem, ReasonForm } from './problems';
import { Fact, H3, label, LOAN_KIND, LOAN_STATE, MONEY, money, OWN_LOAN_READ, OWN_LOAN_REQUEST, OWN_PAYSLIP, ownContext, PLAIN_LIST, SCROLL, Status, TEXTAREA, useIntentKey, useKeys } from './shared';
import type { Installment, LoanRecovery, OwnLoan, OwnLoans, OwnPayslip, OwnPayslips } from './types';

// =========================================================================================================
// My ESS TN06: own issued payslips
// =========================================================================================================

function OwnOnly({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section title={title}>
      <p className="hint">{children}</p>
    </Section>
  );
}

export function MyPayslipsPanel() {
  const { me, can } = useSession();
  if (!me) return <p className="hint loading">Loading your role…</p>;
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
      <p className="hint">A hold withholds payment of earned salary; it never reduces what you earned. Only the status and dates are shown here.</p>
      {list.isPending && <p className="hint loading">Loading your salary payment holds…</p>}
      {list.error && <Problem error={list.error} act="own" />}
      {data && data.items.length === 0 && <Empty>No payment of your salary is or was on hold.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="My salary payment holds">
            <thead>
              <tr>
                <th>Period</th>
                <th>Status</th>
                <th>Held from</th>
                <th>Released</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((h) => (
                <tr key={h.id}>
                  <td>{h.periodCode}</td>
                  <td>{h.state === 'RELEASED' ? <Badge tone="good">Released for payment</Badge> : <Badge tone="warn">On hold</Badge>}</td>
                  <td>{formatDate(h.heldFrom)}</td>
                  <td>{h.releasedAt ? formatDate(h.releasedAt) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <p role="note" className="hint">
        Publication of a payslip does not mean the salary has been paid. Earned is your frozen net pay; held is withheld under an approved hold; reserved is in a bank file being paid;
        paid is only what confirmed payment evidence shows.
      </p>
      {list.isPending && <p className="hint loading">Loading your payslips…</p>}
      {list.error && <Problem error={list.error} act="own" />}
      {data && data.items.length === 0 && <Empty>No payslip has been issued to you yet.</Empty>}
      {data && data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="My payslips">
            <thead>
              <tr>
                <th>Period</th>
                <th>Version</th>
                <th>Status</th>
                <th>Issued</th>
                <th>Earned</th>
                <th>Held</th>
                <th>Reserved</th>
                <th>Paid (confirmed)</th>
                <th>File</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.periodCode}</td>
                  <td>{p.version}</td>
                  <td>
                    {p.publicationState === 'SUPERSEDED' ? (
                      <Badge tone="warn">{`Replaced by a later version${p.supersededAt ? ` on ${formatDate(p.supersededAt)}` : ''}`}</Badge>
                    ) : (
                      <Badge>Current version</Badge>
                    )}
                  </td>
                  <td>{formatDate(p.issuedAt)}</td>
                  {p.payment ? (
                    <>
                      <td>{money(p.payment.earned)}</td>
                      <td>{money(p.payment.held)}</td>
                      <td>{money(p.payment.reserved)}</td>
                      <td>{money(p.payment.paid)}</td>
                    </>
                  ) : (
                    <td colSpan={4}>See the current version</td>
                  )}
                  <td>
                    <button type="button" className="secondary" onClick={() => setViewing(p)} aria-label={`View payslip ${p.periodCode} version ${p.version}`}>
                      View
                    </button>{' '}
                    <button type="button" className="secondary" disabled={busyId !== null} onClick={() => void fetchFile(p)} aria-label={`Download payslip ${p.periodCode} version ${p.version}`}>
                      {busyId === p.id ? 'Downloading…' : 'Download'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {failure !== null && <Problem error={failure} act="download" />}
      {data?.form16?.status === 'NOT_CONFIGURED' && <p className="hint">Form 16 is not available: no statutory Form 16 template is configured yet.</p>}
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
      <button type="button" className="secondary" onClick={onClose}>
        Close
      </button>
      {doc.isPending && <p className="hint loading">Loading the payslip…</p>}
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
              <table key={type} aria-label={title}>
                <caption>{title}</caption>
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.componentCode}>
                      <td>{l.componentName}</td>
                      <td>{money(l.amount, cur)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          })}
          <dl className="kv" aria-label="Payslip totals">
            <Fact term="Gross">{money(d.totals.gross, cur)}</Fact>
            <Fact term="Deductions">{money(d.totals.deductions, cur)}</Fact>
            <Fact term="Net pay">{money(d.totals.net, cur)}</Fact>
          </dl>
          {d.statutory && d.statutory.length > 0 && (
            <table aria-label="How statutory amounts were worked out">
              <caption>How statutory amounts were worked out</caption>
              <tbody>
                {d.statutory.map((s) => (
                  <tr key={s.componentCode}>
                    <td>{s.componentName}</td>
                    <td>{s.amount === null ? '—' : money(s.amount, cur)}</td>
                    <td>{statutoryNote(s, d.currencyCode)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <dl className="kv" aria-label="Payment at publication">
            <Fact term="Earned">{money(d.paymentAtPublication.earned, cur)}</Fact>
            <Fact term="Held">{money(d.paymentAtPublication.held, cur)}</Fact>
            <Fact term="Reserved">{money(d.paymentAtPublication.reserved, cur)}</Fact>
            <Fact term="Paid (confirmed)">{money(d.paymentAtPublication.paid, cur)}</Fact>
          </dl>
          {d.notices.map((n) => (
            <p key={n} className="hint">
              {n}
            </p>
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
  if (!me) return <p className="hint loading">Loading your role…</p>;
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
      {list.isPending && <p className="hint loading">Loading your loans…</p>}
      {list.error && <Problem error={list.error} act="own" />}
      {data?.interest?.status === 'NOT_CONFIGURED' && <p className="hint">Loans carry no interest: no approved interest rate is configured.</p>}
      {data?.earlySettlement?.status === 'NOT_CONFIGURED' && <p className="hint">Early settlement is not available: no settlement rule is configured.</p>}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      {data && data.items.length === 0 && <Empty>You have no loans or advances.</Empty>}
      {data && data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
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
        <div style={SCROLL}>
          <table aria-label={`Recovery schedule of ${name}`}>
            <thead>
              <tr>
                <th>Instalment</th>
                <th>Due month</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {loan.installments.map((i) => (
                <tr key={i.sequence}>
                  <td>{i.sequence}</td>
                  <td>{i.dueMonth}</td>
                  <td>{money(i.amount, loan.currencyCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">No recovery schedule yet: it is fixed when the request is approved.</p>
      )}
      {loan.recoveries && loan.recoveries.length > 0 && (
        <div style={SCROLL}>
          <table aria-label={`Recoveries of ${name}`}>
            <thead>
              <tr>
                <th>Payroll period</th>
                <th>Recovered</th>
                <th>Recognised</th>
              </tr>
            </thead>
            <tbody>
              {loan.recoveries.map((r) => (
                <tr key={r.id}>
                  <td>{r.periodCode}</td>
                  <td>{money(r.amount, loan.currencyCode)}</td>
                  <td>{formatDate(r.recognisedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
    <li aria-labelledby={titleId} className="card">
      <h3 id={titleId} style={H3}>
        {name}
      </h3>
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
    </li>
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
      <p className="hint">An independent HR administrator decides the request and fixes the recovery schedule. No interest is charged.</p>
      <form onSubmit={submit} aria-label="Request a loan or advance" className="grid-form">
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="LOAN">Loan</option>
            <option value="ADVANCE">Salary advance</option>
          </select>
        </label>
        <label>
          Currency (three-letter code)
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} maxLength={3} autoComplete="off" />
        </label>
        <label>
          Amount
          <input value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" autoComplete="off" />
        </label>
        <label className="wide">
          Purpose
          <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
        </label>
        <div className="wide row">
          <button type="submit" disabled={send.isPending}>
            {send.isPending ? 'Sending…' : 'Send the request'}
          </button>
        </div>
      </form>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Problem error={send.error} act="loan-request" />
      {done && (
        <p role="status" className="ok">
          {done}
        </p>
      )}
    </Section>
  );
}
