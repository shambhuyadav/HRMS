// Loans and advances (HR): list, detail, decisions, a request for an employee, disbursement, cancellation and recoveries.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type EmployeeHit, formatDate, localDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../../ui';
import { ScheduleTables } from './ess';
import { ZERO } from './hold-proposals';
import { EmployeePicker, EvidencePicker, Missing, Note } from './pickers';
import { Problem, ReasonForm } from './problems';
import { Fact, GROUP, H3, label, LOAN_DECIDE, LOAN_DISBURSE, LOAN_KIND, LOAN_READ, LOAN_REQUEST, LOAN_STATE, MONEY, money, MONTH, PATHS, PLAIN_LIST, SCROLL, Status, TEXTAREA, useIntentKey, useKeys } from './shared';
import type { Loan, RunDetail } from './types';

// =========================================================================================================
// Loans and advances (HR)
// =========================================================================================================

const LOAN_FILTERS = ['REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'CANCELLED', 'DISBURSED', 'CLOSED'];

export function LoansScreen() {
  const { can } = useSession();
  if (!can(LOAN_READ)) {
    return (
      <Section title="Loans and advances">
        <Empty>The selected role cannot see loans and advances.</Empty>
      </Section>
    );
  }
  return (
    <div className="stack">
      {can(LOAN_DECIDE) && <LoanDecisionQueue />}
      {can(LOAN_REQUEST) && <LoanRequestFor />}
      <LoanList />
    </div>
  );
}

function LoanList() {
  const keys = useKeys();
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<string | null>(null);
  // FR-056: one page at a time; `total` counts every loan in scope.
  const loans = useQuery({
    queryKey: [...keys.loans(state), page],
    queryFn: () => api<{ items: Loan[]; total?: number }>(`/v1/payroll-outputs/loans?${state ? `state=${encodeURIComponent(state)}&` : ''}${pageParams(page)}`),
    retry: retryTransient,
  });
  return (
    <Section
      title="Loans and advances"
      actions={
        <label className="inline">
          State
          <select
            value={state}
            onChange={(e) => {
              setState(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All</option>
            {LOAN_FILTERS.map((s) => (
              <option key={s} value={s}>
                {label(LOAN_STATE, s)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      {loans.isPending && <p className="hint loading">Loading loans…</p>}
      {loans.error && <Problem error={loans.error} act="read" />}
      {loans.data && loans.data.items.length === 0 && <Empty>No loans or advances in the selected role’s scope.</Empty>}
      {loans.data && loans.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Loans and advances">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Kind</th>
                <th>Principal</th>
                <th>State</th>
                <th>Requested</th>
                <th>Recovery head</th>
                <th>Recovered</th>
                <th>Outstanding</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {loans.data.items.map((l) => (
                <tr key={l.id}>
                  <td>{l.employeeCode}</td>
                  <td>{label(LOAN_KIND, l.loanKind)}</td>
                  <td>{money(l.principal, l.currencyCode)}</td>
                  <td>
                    <Status map={LOAN_STATE} code={l.state} />
                  </td>
                  <td>{formatDate(l.requestedAt)}</td>
                  <td>{l.recoveryHead ?? '—'}</td>
                  <td>{money(l.recovered, l.currencyCode)}</td>
                  <td>{money(l.outstanding, l.currencyCode)}</td>
                  <td>
                    <button type="button" className="link" onClick={() => setOpenId(openId === l.id ? null : l.id)} aria-label={`Details of the loan of ${l.employeeCode}`}>
                      {openId === l.id ? 'Hide' : 'Details'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {loans.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={loans.data.total ?? loans.data.items.length} onPage={setPage} label="Loan pages" noun="loan" />}
      {openId && <LoanDetail id={openId} />}
    </Section>
  );
}

function LoanDetail({ id }: { id: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [note, setNote] = useState<string | null>(null);
  const loan = useQuery({ queryKey: keys.loan(id), queryFn: () => api<Loan>(`/v1/payroll-outputs/loans/${encodeURIComponent(id)}`), retry: retryTransient });
  const l = loan.data;
  if (loan.isPending) return <p className="hint loading">Loading the loan…</p>;
  if (!l) return <Problem error={loan.error} act="read" />;
  const name = `${label(LOAN_KIND, l.loanKind)} of ${l.employeeCode}`;
  return (
    <div role="region" aria-label={name}>
      <h3 style={H3}>{name}</h3>
      <dl className="kv">
        <Fact term="Purpose">{l.purpose}</Fact>
        {/[1-9]/.test(l.awaitingRecognition ?? '') && <Fact term="Deducted, not yet recognised">{money(l.awaitingRecognition!, l.currencyCode)}</Fact>}
        <Fact term="Requested by">{l.requestOrigin === 'EMPLOYEE' ? 'The employee' : 'HR, for the employee'}</Fact>
        {l.decidedAt && <Fact term="Decided">{formatDate(l.decidedAt)}</Fact>}
        {l.decisionReason && <Fact term="Decision reason">{l.decisionReason}</Fact>}
        {l.disbursementDate && <Fact term="Disbursed">{formatDate(l.disbursementDate)}</Fact>}
        {l.disbursementReference && <Fact term="Disbursement evidence">{l.disbursementReference}</Fact>}
        {l.closeReason && <Fact term="Close reason">{l.closeReason}</Fact>}
      </dl>
      <ScheduleTables loan={l} name={name} />
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      {l.state === 'APPROVED' && can(LOAN_DISBURSE) && <DisbursementForm loan={l} onDone={setNote} />}
      {l.state === 'APPROVED' && can(LOAN_DECIDE) && <LoanCancel loan={l} onDone={setNote} />}
    </div>
  );
}

export function LoanDecisionQueue() {
  const { can } = useSession();
  const keys = useKeys();
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  const [page, setPage] = useState(1);
  const pending = useQuery({
    queryKey: [...keys.loans('REQUESTED'), 'queue', page],
    queryFn: () => api<{ items: Loan[]; total?: number }>(`/v1/payroll-outputs/loans?state=REQUESTED&${pageParams(page)}`),
    enabled: can(LOAN_DECIDE) && can(LOAN_READ),
    retry: retryTransient,
  });
  if (!can(LOAN_DECIDE)) return null;
  if (!can(LOAN_READ)) {
    return (
      <Section title="Loan requests to decide">
        <p className="hint">The selected role cannot list loan requests.</p>
      </Section>
    );
  }
  return (
    <Section title="Loan requests to decide">
      <p className="hint">An approval fixes the recovery head and a schedule that recovers exactly the principal; neither changes afterwards. Loans carry no interest.</p>
      {pending.isPending && <p className="hint loading">Loading loan requests…</p>}
      {pending.error && <Problem error={pending.error} act="read" />}
      {notes.map((n) => (
        <p key={n.id} role="status" className="ok">
          {n.text}
        </p>
      ))}
      {pending.data && pending.data.items.length === 0 && <Empty>No loan request is waiting for a decision.</Empty>}
      {pending.data && pending.data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {pending.data.items.map((l) => (
            <LoanDecisionItem key={l.id} loan={l} onFinished={(text) => setNotes((prev) => [...prev, { id: l.id, text }])} />
          ))}
        </ul>
      )}
      {pending.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={pending.data.total ?? pending.data.items.length} onPage={setPage} label="Loan request pages" noun="loan request" />}
    </Section>
  );
}

interface InstalmentDraft {
  id: number;
  dueMonth: string;
  amount: string;
}

function LoanDecisionItem({ loan, onFinished }: { loan: Loan; onFinished: (text: string) => void }) {
  const { me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const titleId = useId();
  const nextRow = useRef(1);
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [reason, setReason] = useState('');
  const [head, setHead] = useState('');
  const [rows, setRows] = useState<InstalmentDraft[]>([{ id: 0, dueMonth: '', amount: '' }]);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Loan>(`/v1/payroll-outputs/loans/${encodeURIComponent(loan.id)}/decision`, { body }),
    onSuccess: (r) => onFinished(`${loan.employeeCode}: ${r.state === 'APPROVED' ? 'approved with its recovery schedule; it is disbursed only from verified evidence by someone else' : 'rejected'}.`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.loansAll }),
  });
  const own = loan.requestedBy === me?.userId;
  const beneficiary = !!me?.employeeId && me.employeeId === loan.employeeId;
  const blocked = own || beneficiary;
  const name = `${label(LOAN_KIND, loan.loanKind)} of ${loan.employeeCode}`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (decide.isPending || blocked) return;
    const why = reason.trim();
    if (decision === 'REJECT') {
      if (!why) return setProblem('Give the reason for rejecting the request.');
      setProblem(null);
      decide.reset();
      return decide.mutate({ decision, reason: why, expectedVersion: loan.version });
    }
    const code = head.trim();
    if (!code) return setProblem('Name the recovery deduction head.');
    const list = rows.map((r) => ({ dueMonth: r.dueMonth.trim(), amount: r.amount.trim() }));
    if (list.length === 0) return setProblem('Add at least one instalment.');
    if (list.some((r) => !MONTH.test(r.dueMonth) || !MONEY.test(r.amount))) return setProblem('Give every instalment a due month and an amount such as 3000.00.');
    setProblem(null);
    decide.reset();
    decide.mutate({ decision, recoveryComponentCode: code, installments: list, expectedVersion: loan.version, ...(why ? { reason: why } : {}) });
  };
  return (
    <li aria-labelledby={titleId} className="card">
      <h3 id={titleId} style={H3}>
        {name}
      </h3>
      <dl className="kv">
        <Fact term="Principal">{money(loan.principal, loan.currencyCode)}</Fact>
        <Fact term="Purpose">{loan.purpose}</Fact>
        <Fact term="Requested">{`${formatDate(loan.requestedAt)} by ${loan.requestOrigin === 'EMPLOYEE' ? 'the employee' : 'HR'}`}</Fact>
      </dl>
      {own && <p className="hint">You entered this request, so someone else decides it.</p>}
      {beneficiary && <p className="hint">This is your own loan, so someone else decides it.</p>}
      <form onSubmit={submit} aria-label={`Decide ${name}`} className="stack" style={{ marginTop: '0.5rem' }}>
        <fieldset style={GROUP}>
          <legend>Decision</legend>
          <label className="check">
            <input type="radio" name={`${titleId}-decision`} checked={decision === 'APPROVE'} onChange={() => setDecision('APPROVE')} /> Approve
          </label>
          <label className="check">
            <input type="radio" name={`${titleId}-decision`} checked={decision === 'REJECT'} onChange={() => setDecision('REJECT')} /> Reject
          </label>
        </fieldset>
        {decision === 'APPROVE' && (
          <>
            <label>
              Recovery deduction head (code)
              <input value={head} onChange={(e) => setHead(e.target.value)} maxLength={40} autoComplete="off" />
            </label>
            <fieldset style={GROUP}>
              <legend>Instalments (they must recover exactly the principal)</legend>
              {rows.map((r, i) => (
                <div key={r.id} className="row" style={{ alignItems: 'flex-end' }}>
                  <label>
                    {`Instalment ${i + 1} due month`}
                    <input type="month" value={r.dueMonth} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, dueMonth: e.target.value } : x)))} />
                  </label>
                  <label>
                    {`Instalment ${i + 1} amount`}
                    <input value={r.amount} onChange={(e) => setRows(rows.map((x) => (x.id === r.id ? { ...x, amount: e.target.value } : x)))} inputMode="decimal" autoComplete="off" />
                  </label>
                  {rows.length > 1 && (
                    <button type="button" className="secondary" onClick={() => setRows(rows.filter((x) => x.id !== r.id))} aria-label={`Remove instalment ${i + 1}`}>
                      Remove
                    </button>
                  )}
                </div>
              ))}
              <div className="row">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setRows([...rows, { id: nextRow.current, dueMonth: '', amount: '' }]);
                    nextRow.current += 1;
                  }}
                >
                  Add an instalment
                </button>
              </div>
            </fieldset>
          </>
        )}
        <label>
          {decision === 'REJECT' ? 'Reason' : 'Reason (optional)'}
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
        </label>
        <div className="row">
          <button type="submit" disabled={decide.isPending || blocked}>
            {decide.isPending ? 'Sending…' : 'Send the decision'}
          </button>
        </div>
      </form>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Problem error={decide.error} act="loan-decide" />
    </li>
  );
}

// =========================================================================================================
// HR loans: request for an employee, disbursement from evidence, cancellation, recovery recognition
// =========================================================================================================

function LoanRequestFor() {
  const keys = useKeys();
  const qc = useQueryClient();
  const intent = useIntentKey('payroll-loan-for');
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [loanKind, setLoanKind] = useState('LOAN');
  const [currencyCode, setCurrencyCode] = useState('');
  const [principal, setPrincipal] = useState('');
  const [purpose, setPurpose] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: ({ employeeId, body }: { employeeId: string; body: Record<string, unknown> }) => api<Loan & { replayed: boolean }>(`/v1/payroll-outputs/employees/${encodeURIComponent(employeeId)}/loans`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      void qc.invalidateQueries({ queryKey: keys.loansAll });
    },
    onSuccess: (l) => {
      setEmployee(null);
      setPrincipal('');
      setPurpose('');
      setNote(
        l.replayed
          ? 'This request had already been recorded; nothing was requested twice.'
          : `${label(LOAN_KIND, l.loanKind)} of ${money(l.principal, l.currencyCode)} requested for ${l.employeeCode}: it waits for an independent decision. Loans carry no interest.`,
      );
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (request.isPending) return;
    const currency = currencyCode.trim().toUpperCase();
    if (!employee) return setProblem('Choose the employee.');
    if (!/^[A-Z]{3}$/.test(currency)) return setProblem('The currency is a three-letter ISO code.');
    if (!MONEY.test(principal.trim()) || ZERO.test(principal.trim())) return setProblem('Enter the amount: above zero, with at most four decimals.');
    if (!purpose.trim()) return setProblem('Give the purpose of the request.');
    setProblem(null);
    setNote(null);
    request.reset();
    const body = { loanKind, currencyCode: currency, principal: principal.trim(), purpose: purpose.trim() };
    request.mutate({ employeeId: employee.id, body: { ...body, idempotencyKey: intent.key(JSON.stringify([employee.id, body])) } });
  };
  return (
    <Section title="Request a loan or advance for an employee">
      <form onSubmit={submit} aria-label="Request a loan for an employee" className="grid-form">
        <EmployeePicker title="Employee" value={employee} onChange={setEmployee} />
        <label>
          Kind
          <select value={loanKind} onChange={(e) => setLoanKind(e.target.value)}>
            {Object.entries(LOAN_KIND).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label>
          Currency
          <input value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} maxLength={3} autoComplete="off" />
        </label>
        <label>
          Amount
          <input value={principal} onChange={(e) => setPrincipal(e.target.value)} inputMode="decimal" maxLength={20} autoComplete="off" />
        </label>
        <label className="wide">
          Purpose
          <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
        </label>
        <div className="row">
          <button type="submit" disabled={request.isPending}>
            {request.isPending ? 'Sending…' : 'Send the request'}
          </button>
        </div>
        <Missing text={problem} />
        <div className="wide">
          <Note text={note} />
          <Problem error={request.error} act="loan-request" />
        </div>
      </form>
      <p className="hint">
        Many requests at once: <Link to={PATHS.loanUpload}>upload a file of loan and advance requests</Link>.
      </p>
    </Section>
  );
}

function DisbursementForm({ loan, onDone }: { loan: Loan; onDone: (text: string) => void }) {
  const { me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const intent = useIntentKey('payroll-loan-disbursement');
  const [date, setDate] = useState('');
  const [reference, setReference] = useState('');
  const [documents, setDocuments] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const involved = loan.requestedBy === me?.userId || loan.decidedBy === me?.userId;
  const disburse = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Loan & { replayed: boolean }>(`/v1/payroll-outputs/loans/${encodeURIComponent(loan.id)}/disbursement`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      void qc.invalidateQueries({ queryKey: keys.loansAll });
    },
    onSuccess: (l) =>
      onDone(
        l.replayed
          ? 'This disbursement had already been recorded with this evidence key; nothing was recorded twice.'
          : `The disbursement of ${money(l.principal, l.currencyCode)} on ${formatDate(l.disbursementDate)} is recorded from its evidence; it is recovered through processed payroll.`,
      ),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (disburse.isPending || involved) return;
    if (!date) return setProblem('Give the date the amount was disbursed.');
    if (date > localDate()) return setProblem('A disbursement is recorded once it has happened: the date cannot be in the future.');
    if (!reference.trim() || documents.length !== 1) return setProblem('Give the evidence reference and choose the released, verified document of the disbursement.');
    setProblem(null);
    disburse.reset();
    const intended = [date, reference.trim(), documents];
    disburse.mutate({ disbursementDate: date, evidenceKey: intent.key(JSON.stringify(intended)), evidenceReference: reference.trim(), evidenceDocumentIds: documents, expectedVersion: loan.version });
  };
  return (
    <form onSubmit={submit} aria-label={`Record the disbursement of the loan of ${loan.employeeCode}`} className="grid-form" style={{ marginTop: '0.5rem' }}>
      <h3 style={H3} className="wide">
        Record the disbursement
      </h3>
      {involved && <p className="hint wide">You requested or decided this loan, so someone else records its disbursement.</p>}
      <label>
        Disbursement date
        <input type="date" value={date} max={localDate()} onChange={(e) => setDate(e.target.value)} />
      </label>
      <label>
        Evidence reference
        <input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={500} autoComplete="off" />
      </label>
      <EvidencePicker employeeId={loan.employeeId} chosen={documents} onChange={setDocuments} max={1} />
      <div className="row">
        <button type="submit" disabled={disburse.isPending || involved}>
          {disburse.isPending ? 'Recording…' : 'Record the disbursement'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Problem error={disburse.error} act="disburse" />
      </div>
    </form>
  );
}

function LoanCancel({ loan, onDone }: { loan: Loan; onDone: (text: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: (reason: string) => api<Loan>(`/v1/payroll-outputs/loans/${encodeURIComponent(loan.id)}/cancel`, { body: { reason, expectedVersion: loan.version } }),
    onSuccess: () => onDone(`The approved ${label(LOAN_KIND, loan.loanKind).toLowerCase()} of ${loan.employeeCode} was cancelled; nothing was disbursed.`),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.loansAll }),
  });
  return (
    <>
      <ReasonForm
        name={`Cancel the approved loan of ${loan.employeeCode}`}
        field="Why the approved loan is cancelled"
        button="Cancel the approved loan"
        busy={cancel.isPending}
        danger
        onSend={(reason) => cancel.mutateAsync(reason)}
      />
      <Problem error={cancel.error} act="loan-cancel" />
    </>
  );
}

interface RecoveryResult {
  runId: string;
  recognised: number;
  closed: number;
  exceptions: { loanId: string; employeeCode: string; code: string }[];
  remaining: number;
  done: boolean;
}

export function LoanRecoveries({ run }: { run: RunDetail }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const recognise = useMutation({
    mutationFn: () => api<RecoveryResult>(`/v1/payroll-outputs/runs/${encodeURIComponent(run.id)}/loan-recoveries`, { method: 'POST' }),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.loansAll }),
  });
  const r = recognise.data;
  return (
    <Section title="Loan recoveries">
      <p className="hint">Recoveries are recognised only from this processed run’s frozen deduction lines, and never above a loan’s outstanding balance.</p>
      <div className="row">
        <button type="button" disabled={recognise.isPending} onClick={() => recognise.mutate()}>
          {recognise.isPending ? 'Recognising…' : r && !r.done ? 'Continue' : 'Recognise loan recoveries'}
        </button>
      </div>
      {r && (
        <p role="status" className="ok">
          {`${r.recognised} ${r.recognised === 1 ? 'recovery' : 'recoveries'} recognised in this pass; ${r.closed} ${r.closed === 1 ? 'loan' : 'loans'} fully recovered and closed. ${
            r.done ? 'Every recovery of this run is recognised.' : `${r.remaining} still to recognise: continue.`
          }`}
        </p>
      )}
      {r && r.exceptions.length > 0 && (
        <ul aria-label="Recoveries not recognised">
          {r.exceptions.map((x) => (
            <li key={x.loanId}>
              {`${x.employeeCode}: ${
                x.code === 'RECOVERY_EXCEEDS_OUTSTANDING' ? 'the deduction is above the outstanding balance (or in another currency), so it was not recognised; it needs a later-period correction' : readable(x.code)
              }.`}
            </li>
          ))}
        </ul>
      )}
      <Problem error={recognise.error} act="recover" />
    </Section>
  );
}
