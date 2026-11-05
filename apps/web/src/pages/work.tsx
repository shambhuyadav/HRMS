import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useRef, useState } from 'react';
import { api, download, fileToBase64, formatAmount, formatDate, formatUnits, idempotencyKey, localDate, pinSession } from '../api';
import { isReportRefusal, reportProblem } from '../report-failures';
import { MODULE_TASK_QUEUES } from '../screens-registry';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section, StateBadge } from '../ui';
import { DelegatedBadge, DelegatedTasksSection } from './delegations';
import { NotificationPreferencesPanel } from './notifications';
import { canRaiseAgain, describeWindow, type Evidence, EvidenceChoice, EvidenceError, EvidenceList, followedRequests, KIND_LABEL, ownRecordInScope, ownRecordNotFound, RaiseAgainNote, RaisedAgainHint, WorkTaskEvidence } from './requests';

// ---------------------------------------------------------------------------------------------------------
// Leave (FR-024-FR-026): balances, request form, own requests with withdrawal.
// ---------------------------------------------------------------------------------------------------------

interface Balance {
  leaveType: string;
  paid: boolean;
  available: string;
  pending: string;
  taken: string;
}
interface LeaveRequest {
  id: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  units: string;
  state: string;
  version: number;
  cancellationState: string | null;
  /** The supporting documents of the current revision (FR-026, FR-106). */
  evidence?: Evidence[];
  predecessorRequestId?: string | null;
}

/** The released content of one leave evidence document, for the requester or a reviewer assigned to the request (I-22). */
const leaveEvidencePath = (requestId: string, documentId: string) => `/v1/leave/requests/${requestId}/evidence/${documentId}/content`;

/** Inline follow-ups on an own request: resubmit a returned request, or ask to cancel approved leave (DF03). */
function LeaveRequestActions({ request: r, onChanged }: { request: LeaveRequest; onChanged: () => void }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const [dates, setDates] = useState({ startDate: r.startDate.slice(0, 10), endDate: r.endDate.slice(0, 10), halfDay: r.halfDay });
  // The earlier private reason is kept by the server unless a new one is sent (the employee cannot read it back).
  const [newReason, setNewReason] = useState('');
  const [reason, setReason] = useState('');
  // Nothing ticked: the server keeps the documents attached before (I-22).
  const [evidence, setEvidence] = useState<string[]>([]);
  const resubmit = useMutation({
    mutationFn: () =>
      api(`/v1/leave/requests/${r.id}`, {
        method: 'PUT',
        body: {
          ...dates,
          endDate: dates.halfDay ? dates.startDate : dates.endDate,
          ...(newReason.trim() ? { reason: newReason.trim() } : {}),
          ...(evidence.length ? { evidenceDocumentIds: evidence } : {}),
          expectedVersion: r.version,
        },
      }),
    onSuccess: () => {
      setOpen(false);
      setNewReason('');
      setEvidence([]);
      onChanged();
    },
  });
  const cancel = useMutation({
    mutationFn: () => api(`/v1/leave/requests/${r.id}/cancellation`, { body: { reason } }),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      onChanged();
    },
  });

  if (r.state === 'RETURNED' && can('leave.submit.operational')) {
    return open ? (
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          resubmit.mutate();
        }}
      >
        <input type="date" aria-label="From" required value={dates.startDate} onChange={(e) => setDates({ ...dates, startDate: e.target.value })} />
        {!dates.halfDay && <input type="date" aria-label="To" required value={dates.endDate} onChange={(e) => setDates({ ...dates, endDate: e.target.value })} />}
        <label className="check">
          <input type="checkbox" checked={dates.halfDay} onChange={(e) => setDates({ ...dates, halfDay: e.target.checked })} /> Half day
        </label>
        <input aria-label="New reason (private)" placeholder="New reason (private, optional)" maxLength={1000} value={newReason} onChange={(e) => setNewReason(e.target.value)} />
        <EvidenceChoice chosen={evidence} onChange={setEvidence} earlier={r.evidence ?? []} />
        <button disabled={resubmit.isPending}>Resubmit</button>
        <span className="hint">Leave the new reason empty and your earlier reason is kept; tick no document and the documents attached before are kept.</span>
        <EvidenceError error={resubmit.error} keptEarlier={evidence.length === 0} />
      </form>
    ) : (
      <button className="link" onClick={() => setOpen(true)}>
        Correct and resubmit
      </button>
    );
  }
  if (r.state === 'APPROVED' && r.cancellationState === 'SUBMITTED') return <span className="hint">Cancellation waiting for decision</span>;
  if (r.state === 'APPROVED' && can('leave.cancel.operational')) {
    return open ? (
      <form
        className="inline"
        onSubmit={(e) => {
          e.preventDefault();
          cancel.mutate();
        }}
      >
        <input aria-label="Cancellation reason" placeholder="Reason" required maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
        <button disabled={cancel.isPending}>Ask to cancel</button>
        <ErrorNote error={cancel.error} />
      </form>
    ) : (
      <button className="link" onClick={() => setOpen(true)}>
        Cancel leave
      </button>
    );
  }
  return null;
}

export function LeavePage() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const employeeId = me?.employeeId;
  const own = !!employeeId && ownRecordInScope(me?.scopeKind);
  const balances = useQuery({ queryKey: ['balances', employeeId], enabled: own, queryFn: () => api<{ items: Balance[] }>(`/v1/employees/${employeeId}/leave-balances`) });
  const requests = useQuery({ queryKey: ['leave', employeeId], enabled: own, queryFn: () => api<{ items: LeaveRequest[] }>(`/v1/employees/${employeeId}/leave-requests`) });
  const [form, setForm] = useState({ leaveType: 'ANNUAL', startDate: '', endDate: '', halfDay: false, reason: '' });
  const [evidence, setEvidence] = useState<string[]>([]);
  const [raisingAgain, setRaisingAgain] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['balances'] });
    void qc.invalidateQueries({ queryKey: ['leave'] });
  };
  const submit = useMutation({
    mutationFn: () =>
      api('/v1/leave/requests', {
        body: {
          leaveType: form.leaveType,
          startDate: form.startDate,
          endDate: form.halfDay ? form.startDate : form.endDate,
          halfDay: form.halfDay,
          ...(form.reason ? { reason: form.reason } : {}),
          ...(evidence.length ? { evidenceDocumentIds: evidence } : {}),
          ...(raisingAgain ? { predecessorRequestId: raisingAgain } : {}),
        },
      }),
    // A submitted request starts the form clean (the private reason does not stay on screen); a refused one keeps
    // what was typed for correction.
    onSuccess: () => {
      setForm((f) => ({ ...f, startDate: '', endDate: '', halfDay: false, reason: '' }));
      setEvidence([]);
      setRaisingAgain(null);
      refresh();
    },
  });
  const withdraw = useMutation({ mutationFn: (id: string) => api(`/v1/leave/requests/${id}/withdraw`, { method: 'POST' }), onSuccess: refresh });

  if (!employeeId) return <Empty>No employee record is linked to this account.</Empty>;
  if (!own || ownRecordNotFound(balances.error) || ownRecordNotFound(requests.error)) {
    return <Empty>Your own leave is not in this role’s scope ({me?.scopeKind.toLowerCase()}). Switch to a role that covers your own record to see or request leave.</Empty>;
  }
  return (
    <>
      <Section title="Leave balances (days)">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Available</th>
              <th>Pending</th>
              <th>Taken</th>
            </tr>
          </thead>
          <tbody>
            {balances.data?.items.map((b) => (
              <tr key={b.leaveType}>
                <td>
                  {b.leaveType} {b.paid ? '' : '(unpaid)'}
                </td>
                <td>{b.paid ? formatUnits(b.available) : '—'}</td>
                <td>{formatUnits(b.pending)}</td>
                <td>{formatUnits(b.taken)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ErrorNote error={balances.error} />
      </Section>

      {can('leave.submit.operational') && (
        <Section title="Request leave">
          {raisingAgain && <RaiseAgainNote onCancel={() => setRaisingAgain(null)} />}
          <form
            className="grid-form"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              submit.mutate();
            }}
          >
            <label>
              Type
              <select value={form.leaveType} onChange={(e) => setForm({ ...form, leaveType: e.target.value })}>
                {(balances.data?.items ?? []).map((b) => (
                  <option key={b.leaveType}>{b.leaveType}</option>
                ))}
              </select>
            </label>
            <label>
              From
              <input type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </label>
            {!form.halfDay && (
              <label>
                To
                <input type="date" required value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={form.halfDay} onChange={(e) => setForm({ ...form, halfDay: e.target.checked })} /> Half day
            </label>
            <label className="wide">
              Reason (private, optional)
              <input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} maxLength={1000} />
            </label>
            <EvidenceChoice chosen={evidence} onChange={setEvidence} />
            <button type="submit" disabled={submit.isPending}>
              Submit request
            </button>
          </form>
          {submit.isSuccess && <p className="ok">Request submitted for review.</p>}
          <EvidenceError error={submit.error} />
        </Section>
      )}

      <Section title="My requests">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>From</th>
              <th>To</th>
              <th>Days</th>
              <th>State</th>
              <th>Documents</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {requests.data?.items.map((r) => (
              <tr key={r.id}>
                <td>{r.leaveType}</td>
                <td>{formatDate(r.startDate)}</td>
                <td>{formatDate(r.endDate)}</td>
                <td>{formatUnits(r.units)}</td>
                <td>
                  <StateBadge state={r.state} />
                  <RaisedAgainHint predecessorRequestId={r.predecessorRequestId} />
                </td>
                <td>
                  <EvidenceList evidence={r.evidence ?? []} openPath={(documentId) => leaveEvidencePath(r.id, documentId)} />
                </td>
                <td>
                  {(r.state === 'SUBMITTED' || r.state === 'RETURNED') && can('leave.withdraw.operational') && (
                    <button className="link" onClick={() => withdraw.mutate(r.id)}>
                      Withdraw
                    </button>
                  )}{' '}
                  {canRaiseAgain(r, followedRequests(requests.data?.items ?? [])) && can('leave.submit.operational') && (
                    <button
                      type="button"
                      className="link"
                      onClick={() => {
                        submit.reset();
                        // The private reason is not read back: the new request states its own.
                        setForm({ leaveType: r.leaveType, startDate: r.startDate.slice(0, 10), endDate: r.endDate.slice(0, 10), halfDay: r.halfDay, reason: '' });
                        setEvidence([]);
                        setRaisingAgain(r.id);
                      }}
                    >
                      Raise again
                    </button>
                  )}{' '}
                  <LeaveRequestActions request={r} onChanged={refresh} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {requests.data?.items.length === 0 && <Empty>No leave requests yet.</Empty>}
        <ErrorNote error={withdraw.error} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Expenses (FR-070-FR-077): draft with lines, submit, own claims.
// ---------------------------------------------------------------------------------------------------------

interface DraftLine {
  category: string;
  expenseDate: string;
  nights: string;
  merchant: string;
  invoiceReference: string;
  amount: string;
  /** Correcting a line: the invoice gross it was claimed from (the form asks only for the claimed amount). */
  gross: string | null;
  description: string;
  exceptionReason: string;
  receipt: File | null;
  /** Correcting a line: its receipt, kept unless another file is chosen. */
  keptReceiptId: string | null;
}
const emptyLine = (): DraftLine => ({ category: 'OTHER', expenseDate: '', nights: '', merchant: '', invoiceReference: '', amount: '', gross: null, description: '', exceptionReason: '', receipt: null, keptReceiptId: null });

/** The provisioned categories (DF06), until the company's own list has loaded. */
const DEFAULT_CATEGORIES = [
  { code: 'TRAVEL', name: 'Travel', limitBasis: 'PER_LINE' },
  { code: 'ACCOMMODATION', name: 'Accommodation', limitBasis: 'PER_NIGHT' },
  { code: 'MEALS', name: 'Meals', limitBasis: 'PER_DAY' },
  { code: 'OFFICE_SUPPLIES', name: 'Office supplies', limitBasis: 'PER_LINE' },
  { code: 'OTHER', name: 'Other', limitBasis: 'PER_LINE' },
];
/** FR-074, DF03: a claim can be withdrawn at any state before its final decision. */
const WITHDRAWABLE_CLAIM = ['DRAFT', 'RETURNED', 'MANAGER_PENDING', 'FINANCE_PENDING', 'HIGH_VALUE_PENDING'];

interface OwnClaimLine {
  category: string;
  expenseDate: string;
  nights: number | null;
  merchant: string;
  invoiceReference: string | null;
  claimedAmount: string;
  grossAmount: string;
  description: string;
  receiptId?: string | null;
  receiptScanState?: string | null;
}

export function ExpensesPage() {
  const { me, can } = useSession();
  const qc = useQueryClient();
  const employeeId = me?.employeeId;
  const claims = useQuery({
    queryKey: ['claims', employeeId],
    enabled: !!employeeId,
    queryFn: () => api<{ items: { id: string; purpose: string; state: string; paymentState: string; claimedTotal: string; currency: string; version: number; predecessorRequestId?: string | null }[] }>(`/v1/employees/${employeeId}/expense-claims`),
  });
  const categories = useQuery({
    queryKey: ['expense-categories'],
    enabled: can('expense.draft.operational'),
    queryFn: () => api<{ items: { code: string; name: string; limitBasis: string }[] }>('/v1/expense/categories'),
  });
  const categoryList: { code: string; name: string; limitBasis: string }[] = categories.data?.items ?? DEFAULT_CATEGORIES;
  const [purpose, setPurpose] = useState('');
  // Remounting the form clears the chosen receipt files after a successful submission.
  const [formKey, setFormKey] = useState(0);
  const [lines, setLines] = useState<DraftLine[]>([emptyLine()]);
  // The state of the claim being corrected, when the form holds an existing one.
  const [correcting, setCorrecting] = useState<string | null>(null);
  // DF03: the rejected claim this new one raises again; named once, when the claim is created.
  const [raisingAgain, setRaisingAgain] = useState<string | null>(null);
  const [receiptDropped, setReceiptDropped] = useState(false);
  // What the server already holds from an earlier attempt: the draft claim and the uploaded receipt of each chosen
  // file. A retry after an error revises that draft and reuses those receipts, so it never leaves an orphan draft
  // behind or uploads the same receipt twice (which a duplicate check could then match).
  const draftId = useRef<string | null>(null);
  const uploaded = useRef(new WeakMap<File, string>());
  const [draftKept, setDraftKept] = useState(false);
  const create = useMutation({
    mutationFn: async () => {
      // Every step goes out under the role this submission started in, or not at all.
      const send = pinSession();
      // Receipts are uploaded first; the claim lines then refer to them by id (DF06).
      const receiptIds = await Promise.all(
        lines.map(async (l) => {
          if (!l.receipt) return l.keptReceiptId;
          const known = uploaded.current.get(l.receipt);
          if (known) return known;
          const contentBase64 = await fileToBase64(l.receipt);
          const { receiptId } = await send<{ receiptId: string }>('/v1/expense/receipts', { body: { fileName: l.receipt.name, contentBase64 } });
          uploaded.current.set(l.receipt, receiptId);
          return receiptId;
        }),
      );
      const claim = {
        purpose,
        currency: 'INR',
        lines: lines.map((l, i) => ({
          category: l.category,
          expenseDate: l.expenseDate,
          ...(l.nights ? { nights: Number(l.nights) } : {}),
          merchant: l.merchant,
          ...(l.invoiceReference.trim() ? { invoiceReference: l.invoiceReference.trim() } : {}),
          grossAmount: l.gross && Number(l.gross) >= Number(l.amount) ? l.gross : l.amount,
          claimedAmount: l.amount,
          description: l.description,
          ...(l.exceptionReason ? { exceptionReason: l.exceptionReason } : {}),
          ...(receiptIds[i] ? { receipt: { receiptId: receiptIds[i] } } : {}),
        })),
      };
      let claimId = draftId.current;
      if (claimId !== null) {
        const current = await send<{ version: number; state: string }>(`/v1/expense/claims/${claimId}`);
        // A returned claim gets a new revision here; the one reviewed stays as it was (FR-074).
        if (current.state === 'DRAFT' || current.state === 'RETURNED') {
          await send(`/v1/expense/claims/${claimId}`, { method: 'PUT', body: { expectedVersion: current.version, ...claim } });
        } else if (current.state === 'WITHDRAWN') {
          claimId = null; // withdrawn meanwhile (e.g. in another tab): this becomes a new claim
        } else {
          return current; // an earlier attempt went through although its answer was lost: nothing is left to submit
        }
      }
      if (claimId === null) {
        claimId = (await send<{ claimId: string }>('/v1/expense/claims', { body: { ...claim, ...(raisingAgain ? { predecessorRequestId: raisingAgain } : {}) } })).claimId;
        draftId.current = claimId;
        setDraftKept(true);
      }
      const { version } = await send<{ version: number }>(`/v1/expense/claims/${claimId}`);
      return send(`/v1/expense/claims/${claimId}/submit`, { body: { expectedVersion: version } });
    },
    onSuccess: () => clearForm(),
    // The claims list shows the kept draft after an error, and the new state after success.
    onSettled: () => void qc.invalidateQueries({ queryKey: ['claims'] }),
  });
  const clearForm = () => {
    draftId.current = null;
    uploaded.current = new WeakMap();
    setDraftKept(false);
    setCorrecting(null);
    setRaisingAgain(null);
    setReceiptDropped(false);
    setPurpose('');
    setLines([emptyLine()]);
    setFormKey((k) => k + 1);
  };
  // A rejected claim stays as it was: the form takes its text for a new claim, whose receipts are attached afresh.
  const raiseAgain = useMutation({
    mutationFn: (id: string) => api<{ id: string; purpose: string; lines: OwnClaimLine[] }>(`/v1/expense/claims/${id}`),
    onSuccess: (c) => {
      draftId.current = null;
      uploaded.current = new WeakMap();
      setDraftKept(false);
      setCorrecting(null);
      setRaisingAgain(c.id);
      setReceiptDropped(false);
      setPurpose(c.purpose);
      setLines(
        c.lines.map((l) => ({
          category: l.category,
          expenseDate: l.expenseDate,
          nights: l.nights === null ? '' : String(l.nights),
          merchant: l.merchant,
          invoiceReference: l.invoiceReference ?? '',
          amount: Number(l.claimedAmount).toFixed(2),
          gross: Number(l.grossAmount).toFixed(2),
          description: l.description,
          exceptionReason: '',
          receipt: null,
          keptReceiptId: null,
        })),
      );
      setFormKey((k) => k + 1);
      create.reset();
    },
  });
  // Correcting a returned claim, or going back to a kept draft: the form takes its current text and keeps its receipts. A
  // quarantined receipt is not kept: it cannot be attached again (FR-106). The claimant's own reasons are not read back
  // (DF06), so a line still flagged asks for its reason again at submission.
  const correct = useMutation({
    mutationFn: (id: string) => api<{ id: string; state: string; purpose: string; lines: OwnClaimLine[] }>(`/v1/expense/claims/${id}`),
    onSuccess: (c) => {
      draftId.current = c.id;
      uploaded.current = new WeakMap();
      setDraftKept(false);
      setCorrecting(c.state);
      setReceiptDropped(c.lines.some((l) => l.receiptScanState === 'QUARANTINED'));
      setPurpose(c.purpose);
      setLines(
        c.lines.map((l) => ({
          category: l.category,
          expenseDate: l.expenseDate,
          nights: l.nights === null ? '' : String(l.nights),
          merchant: l.merchant,
          invoiceReference: l.invoiceReference ?? '',
          amount: Number(l.claimedAmount).toFixed(2),
          gross: Number(l.grossAmount).toFixed(2),
          description: l.description,
          exceptionReason: '',
          receipt: null,
          keptReceiptId: l.receiptScanState === 'QUARANTINED' ? null : (l.receiptId ?? null),
        })),
      );
      setFormKey((k) => k + 1);
      create.reset();
    },
  });
  const withdraw = useMutation({
    mutationFn: (id: string) => api(`/v1/expense/claims/${id}/withdraw`, { method: 'POST' }),
    onSuccess: (_answer, id) => {
      if (draftId.current === id) clearForm();
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['claims'] }),
  });
  const update = (i: number, patch: Partial<DraftLine>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const basisOf = (code: string) => categoryList.find((c) => c.code === code)?.limitBasis;

  if (!employeeId) return <Empty>No employee record is linked to this account.</Empty>;
  return (
    <>
      {can('expense.draft.operational') && (
        <Section title={correcting === 'RETURNED' ? 'Correct returned claim' : correcting ? 'Edit draft claim' : 'New expense claim'}>
          {correcting === 'RETURNED' && <p className="hint">Submitting starts a new revision; the one already reviewed is kept as it was.</p>}
          {raisingAgain && <p className="hint">Attach the receipts again: they stay with the rejected claim.</p>}
          {raisingAgain && <RaiseAgainNote onCancel={() => setRaisingAgain(null)} />}
          {receiptDropped && <p className="hint">A receipt on this claim failed the malware scan and was removed; attach another.</p>}
          <form
            key={formKey}
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
            className="stack"
          >
            <label>
              Business purpose
              <input value={purpose} onChange={(e) => setPurpose(e.target.value)} required maxLength={500} />
            </label>
            {lines.map((l, i) => (
              <fieldset key={i} className="grid-form">
                <legend>Line {i + 1}</legend>
                <label>
                  Category
                  <select value={l.category} onChange={(e) => update(i, { category: e.target.value })}>
                    {/* The company's name for each category; the code is what is sent. A code no longer listed keeps its own text. */}
                    {[...categoryList.map((c) => ({ code: c.code, name: c.name })), ...(categoryList.some((c) => c.code === l.category) ? [] : [{ code: l.category, name: l.category }])].map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Date
                  <input type="date" required value={l.expenseDate} onChange={(e) => update(i, { expenseDate: e.target.value })} />
                </label>
                {basisOf(l.category) === 'PER_NIGHT' && (
                  <label>
                    Nights
                    <input type="number" min={1} required value={l.nights} onChange={(e) => update(i, { nights: e.target.value })} />
                  </label>
                )}
                <label>
                  Merchant
                  <input required value={l.merchant} onChange={(e) => update(i, { merchant: e.target.value })} />
                </label>
                <label>
                  Invoice reference (if the bill has one)
                  <input maxLength={100} value={l.invoiceReference} onChange={(e) => update(i, { invoiceReference: e.target.value })} />
                </label>
                <label>
                  Amount (INR)
                  <input required inputMode="decimal" pattern="\d+(\.\d{1,2})?" value={l.amount} onChange={(e) => update(i, { amount: e.target.value })} />
                </label>
                <label className="wide">
                  Description
                  <input required value={l.description} onChange={(e) => update(i, { description: e.target.value })} />
                </label>
                <label className="wide">
                  Exception reason (if over limit, late or without receipt)
                  <input value={l.exceptionReason} onChange={(e) => update(i, { exceptionReason: e.target.value })} />
                </label>
                <label className="wide">
                  Receipt (PDF, JPEG or PNG)
                  <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => update(i, { receipt: e.target.files?.[0] ?? null })} />
                  {l.keptReceiptId && !l.receipt && <span className="hint">The receipt already on this line is kept unless you choose another file.</span>}
                </label>
              </fieldset>
            ))}
            <div className="row">
              <button type="button" className="secondary" onClick={() => setLines([...lines, emptyLine()])}>
                Add line
              </button>
              <button type="submit" disabled={create.isPending}>
                Submit claim
              </button>
              {correcting && (
                <button type="button" className="secondary" onClick={clearForm}>
                  Leave this claim as it is
                </button>
              )}
            </div>
          </form>
          {create.isSuccess && <p className="ok">Claim submitted for review.</p>}
          <ErrorNote error={create.error} />
          {create.isError && draftKept && <p className="hint">Your claim is saved as a draft. Correct it and press Submit claim again; receipts already uploaded are reused.</p>}
        </Section>
      )}
      <Section title="My claims">
        <table>
          <thead>
            <tr>
              <th>Purpose</th>
              <th>Claimed</th>
              <th>State</th>
              <th>Payment</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {claims.data?.items.map((c) => (
              <tr key={c.id}>
                <td>{c.purpose}</td>
                <td>{formatAmount(c.claimedTotal, c.currency)}</td>
                <td>
                  <StateBadge state={c.state} />
                  <RaisedAgainHint predecessorRequestId={c.predecessorRequestId} />
                </td>
                <td>
                  <StateBadge state={c.paymentState === 'NOT_APPLICABLE' ? null : c.paymentState} />
                </td>
                <td>
                  {(c.state === 'DRAFT' || c.state === 'RETURNED') && can('expense.draft.operational') && (
                    <button className="link" disabled={correct.isPending} onClick={() => correct.mutate(c.id)}>
                      {c.state === 'RETURNED' ? 'Correct' : 'Edit'}
                    </button>
                  )}{' '}
                  {canRaiseAgain(c, followedRequests(claims.data?.items ?? [])) && can('expense.draft.operational') && (
                    <button className="link" disabled={raiseAgain.isPending} onClick={() => raiseAgain.mutate(c.id)}>
                      Raise again
                    </button>
                  )}{' '}
                  {WITHDRAWABLE_CLAIM.includes(c.state) && can('expense.withdraw.operational') && (
                    <button className="link" disabled={withdraw.isPending} onClick={() => withdraw.mutate(c.id)}>
                      Withdraw
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {claims.data?.items.length === 0 && <Empty>No claims yet.</Empty>}
        <ErrorNote error={claims.error ?? correct.error ?? raiseAgain.error ?? withdraw.error} />
      </Section>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Decision inbox (FR-060): leave, work-request, profile-change, attendance-correction, confirmation, expense and
// increment tasks assigned to the user. Every item says what is being decided.
// ---------------------------------------------------------------------------------------------------------

/** GET /v1/leave/tasks: what a leave request or a cancellation of approved leave decides (operational only). */
interface LeaveSummary {
  /** The leave request the task decides; its evidence route takes this id. */
  requestId?: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  /** Decimal string with 4 places. */
  units: string;
  isCancellation: boolean;
  /** The supporting documents of the leave's current revision (FR-026, FR-106). */
  evidence?: Evidence[];
}
/** GET /v1/work-requests/tasks/mine. */
interface WorkSummary {
  /** The request the task decides (its evidence route takes this id). */
  requestId?: string;
  kind: 'outdoor_duty' | 'holiday_work';
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  purpose: string;
  /** The supporting documents of the revision being decided (metadata only; FR-027, FR-106). */
  evidence?: Evidence[];
}
/** GET /v1/profile-changes/tasks/mine: the requested values, the values when requested and the record now. */
interface ProfileChangeView {
  employeeName: string;
  employeeCode: string;
  requested: Record<string, string>;
  currentValues: Record<string, string | null> | null;
  recordNow: Record<string, string | null> | null;
}
/** GET /v1/attendance-corrections/tasks/mine; `reason` is present only for a reviewer with the reason grant. */
interface CorrectionView {
  employeeName: string;
  employeeCode: string;
  workDate: string;
  currentStatus: string;
  requestedStatus: string;
  reason?: string | null;
}

interface Task {
  taskId: string;
  kind: string;
  ownerEmployeeCode: string | null;
  ownerName: string | null;
  assignedAt: string;
  transactionId: string;
  stepAction: string;
  /** Present on expense tasks: the claim this task decides. */
  claimId?: string | null;
  /** Leave and work-request tasks. */
  summary?: LeaveSummary | WorkSummary | null;
  /** Profile-change and attendance-correction tasks. */
  request?: ProfileChangeView | CorrectionView | null;
}

interface Queue {
  permission: string;
  path: string;
  decide: (id: string) => string;
  needsReason: boolean;
  /** Profile changes and attendance corrections are approved or rejected, never returned (I-11, I-12). */
  canReturn: boolean;
  title: string;
}

const QUEUES: Queue[] = [
  { permission: 'leave.approve.operational', path: '/v1/leave/tasks', decide: (id) => `/v1/leave/tasks/${id}/decision`, needsReason: false, canReturn: true, title: 'Leave requests' },
  {
    permission: 'leave.approve.operational',
    path: '/v1/work-requests/tasks/mine',
    decide: (id) => `/v1/work-requests/tasks/${id}/decision`,
    needsReason: false,
    canReturn: true,
    title: 'Outdoor duty and holiday work',
  },
  {
    permission: 'employee.update.operational',
    path: '/v1/profile-changes/tasks/mine',
    decide: (id) => `/v1/profile-changes/tasks/${id}/decision`,
    needsReason: false,
    canReturn: false,
    title: 'Profile changes',
  },
  {
    permission: 'attendance.approve_correction.operational',
    path: '/v1/attendance-corrections/tasks/mine',
    decide: (id) => `/v1/attendance-corrections/tasks/${id}/decision`,
    needsReason: false,
    canReturn: false,
    title: 'Attendance corrections',
  },
  {
    permission: 'confirmation.decide.operational',
    path: '/v1/confirmations/tasks/mine',
    decide: (id) => `/v1/confirmations/tasks/${id}/decision`,
    needsReason: true,
    canReturn: true,
    title: 'Confirmation reviews',
  },
  { permission: 'expense.read.operational', path: '/v1/expense/tasks', decide: (id) => `/v1/expense/tasks/${id}/decision`, needsReason: false, canReturn: true, title: 'Expense claims' },
  {
    permission: 'increment.approve.salary',
    path: '/v1/increment-cases/tasks/mine',
    decide: (id) => `/v1/increment-cases/tasks/${id}/decision`,
    needsReason: true,
    canReturn: true,
    title: 'Increment cases',
  },
];

export function TasksPage() {
  const { can } = useSession();
  const visible = QUEUES.filter((q) => can(q.permission));
  // Wave-2 module queues (screens-registry.ts); each renders its own section and checks its own decision keys.
  const modules = MODULE_TASK_QUEUES.filter((q) => can(q.permission));
  if (visible.length === 0 && modules.length === 0) return <Empty>You have no decision queues in this role.</Empty>;
  return (
    <>
      <DelegatedTasksSection />
      {visible.map((q) => (
        <TaskQueue key={q.path} queue={q} />
      ))}
      {modules.map((q) => (
        <q.component key={q.title} />
      ))}
    </>
  );
}

function TaskQueue({ queue }: { queue: Queue }) {
  // The key carries the company and assignment: one role's queue is never shown under another (prefix ['tasks'] still invalidates it).
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  const tasks = useQuery({ queryKey: ['tasks', queue.path, context], queryFn: () => api<{ items: Task[] }>(queue.path) });
  return (
    <Section title={`${queue.title}${tasks.data ? ` (${tasks.data.items.length})` : ''}`}>
      {tasks.data?.items.length === 0 && <Empty>Nothing waiting for you.</Empty>}
      <ul className="tasks">
        {tasks.data?.items.map((t) => (t.kind === 'expense_claim' ? <ExpenseTask key={t.taskId} task={t} /> : <DecisionTask key={t.taskId} task={t} queue={queue} />))}
      </ul>
      <ErrorNote error={tasks.error} />
    </Section>
  );
}

const statusText = (code: string) => code.replace(/_/g, ' ').toLowerCase();
const PROFILE_FIELD_LABEL: Record<string, string> = { displayName: 'Display name', workEmail: 'Work email' };

/** What the task decides, from the summary or request the queue endpoint returned with it. */
function TaskDetails({ task: t }: { task: Task }) {
  if ((t.kind === 'leave_request' || t.kind === 'leave_cancellation') && t.summary) {
    const s = t.summary as LeaveSummary;
    const when = s.halfDay || s.startDate === s.endDate ? `${formatDate(s.startDate)}${s.halfDay ? ' (half day)' : ''}` : `${formatDate(s.startDate)} – ${formatDate(s.endDate)}`;
    return (
      <>
        <div>{`${s.leaveType} · ${when} · ${Number(s.units).toFixed(2)} days`}</div>
        {s.requestId && !!s.evidence?.length && (
          <div>
            <span className="hint">Supporting documents:</span> <EvidenceList evidence={s.evidence} openPath={(documentId) => leaveEvidencePath(s.requestId!, documentId)} />
          </div>
        )}
      </>
    );
  }
  if ((t.kind === 'outdoor_duty' || t.kind === 'holiday_work') && t.summary) {
    const s = t.summary as WorkSummary;
    return (
      <>
        <div>{`${KIND_LABEL[s.kind] ?? s.kind} · ${describeWindow(s)}`}</div>
        <div>{s.purpose}</div>
        {s.evidence && <WorkTaskEvidence summary={s} />}
      </>
    );
  }
  if (t.kind === 'profile_change' && t.request) {
    const r = t.request as ProfileChangeView;
    return (
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Current record</th>
            <th>Requested</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(r.requested ?? {}).map((field) => {
            const now = r.recordNow?.[field] ?? null;
            const then = r.currentValues?.[field] ?? null;
            return (
              <tr key={field}>
                <td>{PROFILE_FIELD_LABEL[field] ?? field}</td>
                <td>
                  <span>{now ?? '—'}</span>
                  {then !== now && (
                    <>
                      {' '}
                      <span className="hint">was {then ?? '—'} when requested</span>
                    </>
                  )}
                </td>
                <td>{r.requested[field]}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    );
  }
  if (t.kind === 'attendance_correction' && t.request) {
    const r = t.request as CorrectionView;
    return (
      <>
        <div>{`${formatDate(r.workDate)}: ${statusText(r.currentStatus)} → ${statusText(r.requestedStatus)}`}</div>
        {r.reason && (
          <div>
            <span className="hint">Reason (private):</span> <span>{r.reason}</span>
          </div>
        )}
      </>
    );
  }
  return null;
}

function DecisionTask({ task: t, queue }: { task: Task; queue: Queue }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'RETURN' | 'REJECT') =>
      api(queue.decide(t.taskId), { body: { decision, idempotencyKey: idempotencyKey('ui'), ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  const cancellation = t.kind === 'leave_cancellation' || (t.summary as LeaveSummary | null | undefined)?.isCancellation === true;
  // Returning and rejecting always need a reason (the decision record refuses one without it); the confirmation
  // and increment decision routes need one for approval too.
  const noReason = reason.trim() === '';
  return (
    <li>
      <div>
        <strong>{t.ownerName ?? 'Request'}</strong> {cancellation && <Badge tone="warn">cancel approved leave</Badge>}{' '}
        <span className="hint">
          {t.ownerEmployeeCode} · assigned {formatDate(t.assignedAt)}
        </span>
        <DelegatedBadge taskId={t.taskId} />
      </div>
      <TaskDetails task={t} />
      <input
        aria-label="Decision reason"
        placeholder={queue.needsReason ? 'Reason (required)' : queue.canReturn ? 'Reason (required to reject or return)' : 'Reason (required to reject)'}
        maxLength={1000}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <div className="row">
        <button disabled={decide.isPending || (queue.needsReason && noReason)} onClick={() => decide.mutate('APPROVE')}>
          Approve
        </button>
        {queue.canReturn && !cancellation && (
          <button className="secondary" disabled={decide.isPending || noReason} onClick={() => decide.mutate('RETURN')}>
            Return
          </button>
        )}
        <button className="danger" disabled={decide.isPending || noReason} onClick={() => decide.mutate('REJECT')}>
          Reject
        </button>
      </div>
      <ErrorNote error={decide.error} />
    </li>
  );
}

interface ClaimLine {
  id: string;
  sequence: number;
  category: string;
  expenseDate: string;
  merchant: string;
  invoiceReference?: string | null;
  claimedAmount: string;
  description: string;
  exceptionFlags: string[];
  receiptPresent: boolean;
  /** FR-106: attached is not usable; only a CLEAN receipt opens. */
  receiptScanState?: string | null;
  /** The limit the line was judged under at submission (FR-078). */
  appliedLimit?: string | null;
  /** Only with the expense reason grant (DF02). */
  exceptionReason?: string | null;
  decisionReason?: string | null;
}

/**
 * Expense decision (FR-072/073/075, C5). The financial step decides an amount for every line (0..claimed) and needs a
 * reason for any reduction and for accepting any flagged line; manager and high-value steps approve, return or reject
 * the claim as submitted.
 */
const receiptReleased = (l: ClaimLine) => !l.receiptScanState || l.receiptScanState === 'CLEAN';
const receiptWords = (l: ClaimLine) => (!l.receiptPresent ? 'missing' : l.receiptScanState === 'QUARANTINED' ? 'quarantined by the malware scan' : receiptReleased(l) ? 'attached' : 'waiting for the malware scan');

function ExpenseTask({ task }: { task: Task }) {
  const qc = useQueryClient();
  const finance = task.stepAction === 'finance_decide';
  const { can } = useSession();
  const viewReceipt = useMutation({ mutationFn: (lineId: string) => download(`/v1/expense/lines/${lineId}/receipt`) });
  const claimQuery = useQuery({
    queryKey: ['claim-for-task', task.claimId],
    enabled: !!task.claimId,
    queryFn: () =>
      api<{ id: string; purpose: string; currency: string; lines: ClaimLine[]; revisions?: { revision: number; purpose: string | null; claimedTotal: string }[] }>(`/v1/expense/claims/${task.claimId}`),
  });
  const claim = claimQuery.data;
  const [allowed, setAllowed] = useState<Record<string, string>>({});
  const [lineReason, setLineReason] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: string) =>
      api(`/v1/expense/tasks/${task.taskId}/decision`, {
        body: {
          decision,
          idempotencyKey: idempotencyKey('ui'),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(finance && decision === 'APPROVE' && claim
            ? {
                lines: claim.lines.map((l) => ({
                  lineId: l.id,
                  allowedAmount: allowed[l.id] ?? Number(l.claimedAmount).toFixed(2),
                  ...(lineReason[l.id]?.trim() ? { reason: lineReason[l.id]!.trim() } : {}),
                })),
              }
            : {}),
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  // Returning and rejecting need a reason (the decision record refuses one without it).
  const noReason = reason.trim() === '';
  // A flagged line is accepted only with a recorded clearance reason, at any amount, and so is one whose receipt the scan has
  // not released, which the flags frozen at submission may not show (the server refuses either without it).
  const unclearedLines = finance && !!claim?.lines.some((l) => (l.exceptionFlags.length > 0 || !receiptReleased(l)) && !lineReason[l.id]?.trim());

  return (
    <li>
      <div>
        <strong>{task.ownerName ?? 'Claim'}</strong> <span className="hint">{task.ownerEmployeeCode} · {finance ? 'financial review' : task.stepAction.replace(/_/g, ' ')} · assigned {formatDate(task.assignedAt)}</span>
        <DelegatedBadge taskId={task.taskId} />
      </div>
      {claim && (
        <>
          <div>{claim.purpose}</div>
          {claim.revisions && claim.revisions.length > 1 && (
            <ul className="hint" aria-label="Earlier revisions">
              {claim.revisions.slice(0, -1).map((r) => (
                <li key={r.revision}>{`Revision ${r.revision}, ${formatAmount(r.claimedTotal, claim.currency)}: ${r.purpose ?? 'purpose not recorded'}`}</li>
              ))}
            </ul>
          )}
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Category</th>
                <th>Date</th>
                <th>Merchant</th>
                <th>Claimed</th>
                <th>Flags</th>
                <th>Receipt</th>
                {finance && <th>Approved amount</th>}
                {finance && <th>Reason (reduction or flagged line)</th>}
              </tr>
            </thead>
            <tbody>
              {claim.lines.map((l) => (
                <tr key={l.id}>
                  <td>{l.sequence}</td>
                  <td>{l.category}</td>
                  <td>{formatDate(l.expenseDate)}</td>
                  <td>
                    {l.merchant}
                    {l.invoiceReference && <div className="hint">Invoice {l.invoiceReference}</div>}
                  </td>
                  <td>
                    {formatAmount(l.claimedAmount, claim.currency)}
                    {l.appliedLimit && <div className="hint">Limit {formatAmount(l.appliedLimit, claim.currency)}</div>}
                  </td>
                  <td>
                    {l.exceptionFlags.length ? l.exceptionFlags.join(', ').toLowerCase().replace(/_/g, ' ') : '—'}
                    {l.exceptionReason && <div className="hint">Claimant: {l.exceptionReason}</div>}
                    {l.decisionReason && <div className="hint">Reviewer: {l.decisionReason}</div>}
                  </td>
                  <td>
                    {receiptWords(l)}{' '}
                    {l.receiptPresent && receiptReleased(l) && can('expense.view_receipt.receipt') && (
                      <button type="button" className="secondary" onClick={() => viewReceipt.mutate(l.id)}>
                        View
                      </button>
                    )}
                  </td>
                  {finance && (
                    <td>
                      <input
                        aria-label={`Approved amount for line ${l.sequence}`}
                        inputMode="decimal"
                        value={allowed[l.id] ?? Number(l.claimedAmount).toFixed(2)}
                        onChange={(e) => setAllowed({ ...allowed, [l.id]: e.target.value })}
                      />
                    </td>
                  )}
                  {finance && (
                    <td>
                      <input aria-label={`Reason for line ${l.sequence}`} value={lineReason[l.id] ?? ''} onChange={(e) => setLineReason({ ...lineReason, [l.id]: e.target.value })} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <input aria-label="Decision reason" placeholder="Reason (required to reject or return)" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      {unclearedLines && <p className="hint">Enter a reason for each flagged line to clear it before approving.{claim?.lines.some((l) => !receiptReleased(l)) ? ' A receipt the malware scan has not released counts as none.' : ''}</p>}
      <div className="row">
        <button disabled={decide.isPending || unclearedLines} onClick={() => decide.mutate('APPROVE')}>
          {finance ? 'Approve amounts' : 'Approve'}
        </button>
        <button className="secondary" disabled={decide.isPending || noReason} onClick={() => decide.mutate('RETURN')}>
          Return
        </button>
        <button className="danger" disabled={decide.isPending || noReason} onClick={() => decide.mutate('REJECT')}>
          Reject
        </button>
      </div>
      <ErrorNote error={claimQuery.error ?? decide.error ?? viewReceipt.error} />
    </li>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Payments (FR-076/077, DF07): manual outcome tracking; preparer, releaser and the claim's approvers differ.
// ---------------------------------------------------------------------------------------------------------

interface Payable {
  claimId: string;
  employeeCode: string;
  employeeName: string;
  purpose: string;
  paymentState: string;
  approvedAmount: string;
  netPaid: string;
  pending: string;
  allocatable: string;
  currency: string;
}

export function PaymentsPage() {
  const payables = useQuery({ queryKey: ['payables'], queryFn: () => api<{ items: Payable[] }>('/v1/expense/payables') });
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <Section title="Approved claims awaiting payment">
        <p className="hint">Recording payments here never transfers money; outcomes come from bank evidence (DF07).</p>
        <table>
          <thead>
            <tr>
              <th>Employee</th>
              <th>Purpose</th>
              <th>Approved</th>
              <th>Paid</th>
              <th>Pending</th>
              <th>Can still prepare</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {payables.data?.items.map((p) => (
              <tr key={p.claimId}>
                <td>
                  {p.employeeName} <span className="hint">{p.employeeCode}</span>
                </td>
                <td>{p.purpose}</td>
                <td>{formatAmount(p.approvedAmount, p.currency)}</td>
                <td>{formatAmount(p.netPaid, p.currency)}</td>
                <td>{formatAmount(p.pending, p.currency)}</td>
                <td>{formatAmount(p.allocatable, p.currency)}</td>
                <td>
                  <StateBadge state={p.paymentState} />
                </td>
                <td>
                  <button className="link" onClick={() => setSelected(p.claimId)}>
                    Manage
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {payables.data?.items.length === 0 && <Empty>Nothing awaiting payment.</Empty>}
        <ErrorNote error={payables.error} />
      </Section>
      {/* Keyed by claim: an amount, evidence reference or payment key entered for one claim never carries over to another. */}
      {selected && <ClaimPayments key={selected} claimId={selected} payable={payables.data?.items.find((p) => p.claimId === selected)} />}
    </>
  );
}

interface PaymentInstruction {
  id: string;
  amount: string;
  currency: string;
  state: string;
  /** C5 "payment batch DRAFT then READY". */
  batchState: string;
  paymentDate: string;
  reversed: string;
  outcomeActorAccountKey: string | null;
  outcomeAssignedToMe: boolean;
  /** CI06: the failed instruction this one replaces. */
  retryOfInstructionId?: string | null;
}

/** C3 "confirmation actor explicitly assigned": only people who can be named are offered (the server also refuses anyone else). */
function OutcomeActorChoice({ instructionId, value, onChange }: { instructionId: string; value: string; onChange: (userId: string) => void }) {
  const actors = useQuery({
    queryKey: ['outcome-actors', instructionId],
    queryFn: () => api<{ items: { userId: string; accountKey: string; employeeCode: string | null; employeeName: string | null }[] }>(`/v1/expense/payments/${instructionId}/outcome-actors`),
  });
  return (
    <>
      <select aria-label="Outcome recorded by" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose who records the outcome</option>
        {actors.data?.items.map((a) => (
          <option key={a.userId} value={a.userId}>
            {a.employeeName ? `${a.employeeName} (${a.employeeCode})` : a.accountKey}
          </option>
        ))}
      </select>
      {actors.data?.items.length === 0 && <span className="hint">Nobody independent holds the confirmation duty for this payment.</span>}
      <ErrorNote error={actors.error} />
    </>
  );
}

function ClaimPayments({ claimId, payable }: { claimId: string; payable: Payable | undefined }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const instructions = useQuery({
    queryKey: ['instructions', claimId],
    queryFn: () => api<{ items: PaymentInstruction[] }>(`/v1/expense/claims/${claimId}/payments`),
  });
  const [amount, setAmount] = useState('');
  const [paymentDate, setPaymentDate] = useState(() => localDate());
  const [retryOf, setRetryOf] = useState('');
  // CI06: a failed payment nothing has replaced yet can be named as what this one replaces. Naming it stays a choice (the owner decides
  // whether it must be required), and a choice that has since been replaced by someone else is no longer sent.
  const items = instructions.data?.items ?? [];
  const replaceable = items.filter((i) => i.state === 'FAILED' && !items.some((o) => o.retryOfInstructionId === i.id));
  const chosenRetry = replaceable.some((i) => i.id === retryOf) ? retryOf : '';
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [reversal, setReversal] = useState<Record<string, { amount: string; reason: string }>>({});
  const [outcomeActor, setOutcomeActor] = useState<Record<string, string>>({});
  const [reassignReason, setReassignReason] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['instructions', claimId] });
    void qc.invalidateQueries({ queryKey: ['payables'] });
  };
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onMutate: () => setNotice(null),
    onSuccess: refresh,
  });
  // One idempotency key per intended payment: a retry after an error or a lost answer is the same payment, which the
  // server answers from the first attempt instead of preparing a second one. A success, or a changed amount or
  // date, starts a new payment with a new key.
  const prepareKey = useRef<string | null>(null);
  const prepare = useMutation({
    mutationFn: () => {
      prepareKey.current ??= idempotencyKey('pay');
      return api('/v1/expense/payments', { body: { claimId, amount: amount || payable?.allocatable, paymentDate, idempotencyKey: prepareKey.current, ...(chosenRetry ? { retryOfInstructionId: chosenRetry } : {}) } });
    },
    onSuccess: () => {
      prepareKey.current = null;
      setAmount('');
      setRetryOf('');
    },
    // After an error too: an attempt whose answer was lost may have been prepared all the same.
    onSettled: refresh,
  });
  const evidenceKey = (id: string) => evidence[id]?.trim() || '';
  // An outcome or a reversal uses up its bank evidence reference: the server answers the same event again as a replay,
  // recording nothing new, and refuses the reference for anything else (EVIDENCE_KEY_REUSED, shown with what was typed
  // so it can be corrected). After a success the next action on the instruction starts with an empty reference.
  const record = (id: string, path: 'outcome' | 'reversal', body: Record<string, string>) =>
    act.mutate(() => api<{ replayed?: boolean }>(`/v1/expense/payments/${id}/${path}`, { body }), {
      onSuccess: (result) => {
        setEvidence((current) => omit(current, id));
        setReversal((current) => omit(current, id));
        if (path === 'reversal' && (result as { replayed?: boolean } | undefined)?.replayed) {
          setNotice('This reversal was already recorded under this evidence reference, so nothing new was recorded.');
        }
      },
    });

  return (
    <Section title={`Payments for ${payable?.employeeName ?? 'claim'}`}>
      <form
        className="grid-form"
        onSubmit={(e) => {
          e.preventDefault();
          prepare.mutate();
        }}
      >
        <label>
          Amount
          <input
            inputMode="decimal"
            placeholder={payable?.allocatable}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              prepareKey.current = null;
            }}
          />
        </label>
        <label>
          Payment date
          <input
            type="date"
            value={paymentDate}
            onChange={(e) => {
              setPaymentDate(e.target.value);
              prepareKey.current = null;
            }}
            required
          />
        </label>
        {replaceable.length > 0 && (
          <label>
            Replaces a failed payment
            <select
              value={chosenRetry}
              onChange={(e) => {
                setRetryOf(e.target.value);
                prepareKey.current = null;
              }}
            >
              <option value="">No, this is a new payment</option>
              {replaceable.map((i) => (
                <option key={i.id} value={i.id}>
                  {`The failed payment of ${formatAmount(i.amount, i.currency)} dated ${formatDate(i.paymentDate)}`}
                </option>
              ))}
            </select>
          </label>
        )}
        <button type="submit" disabled={prepare.isPending}>
          Prepare payment
        </button>
      </form>
      <ErrorNote error={prepare.error} />
      <table>
        <thead>
          <tr>
            <th>Amount</th>
            <th>Date</th>
            <th>State</th>
            <th>Reversed</th>
            <th>Bank evidence reference</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {instructions.data?.items.map((i) => (
            <tr key={i.id}>
              <td>{formatAmount(i.amount, i.currency)}</td>
              <td>{formatDate(i.paymentDate)}</td>
              <td>
                <StateBadge state={i.state} />
                {i.retryOfInstructionId && <span className="hint"> Replaces a failed payment</span>}
              </td>
              <td>{formatAmount(i.reversed, i.currency)}</td>
              <td>
                {((i.state === 'RELEASED' && i.outcomeAssignedToMe) || i.state === 'CONFIRMED') && (
                  <input aria-label="Evidence reference" placeholder="e.g. bank reference" value={evidence[i.id] ?? ''} onChange={(e) => setEvidence({ ...evidence, [i.id]: e.target.value })} />
                )}
              </td>
              <td className="row">
                {i.state === 'PREPARED' && i.batchState === 'DRAFT' && (
                  <>
                    <Badge tone="neutral">Draft</Badge>
                    {can('payment.prepare.operational') && (
                      <button disabled={act.isPending} onClick={() => act.mutate(() => api(`/v1/expense/payments/${i.id}/ready`, { method: 'POST' }))}>
                        Mark ready
                      </button>
                    )}
                  </>
                )}
                {i.state === 'PREPARED' && i.batchState === 'READY' && can('payment.release.operational') && (
                  <>
                    <OutcomeActorChoice instructionId={i.id} value={outcomeActor[i.id] ?? ''} onChange={(userId) => setOutcomeActor({ ...outcomeActor, [i.id]: userId })} />
                    <button
                      disabled={act.isPending || !outcomeActor[i.id]}
                      onClick={() => act.mutate(() => api(`/v1/expense/payments/${i.id}/release`, { body: { outcomeActorUserId: outcomeActor[i.id] } }), { onSuccess: () => setOutcomeActor((current) => omit(current, i.id)) })}
                    >
                      Release
                    </button>
                  </>
                )}
                {i.state === 'RELEASED' && (
                  <>
                    <span className="hint">{i.outcomeActorAccountKey ? `Outcome assigned to ${i.outcomeActorAccountKey}` : 'Nobody is assigned the outcome yet'}</span>
                    {i.outcomeAssignedToMe && can('payment.confirm_outcome.operational') && (
                      <>
                        <button disabled={act.isPending || evidenceKey(i.id).length < 8} onClick={() => record(i.id, 'outcome', { outcome: 'CONFIRMED', evidenceKey: evidenceKey(i.id) })}>
                          Confirm paid
                        </button>
                        <button className="danger" disabled={act.isPending || evidenceKey(i.id).length < 8} onClick={() => record(i.id, 'outcome', { outcome: 'FAILED', evidenceKey: evidenceKey(i.id) })}>
                          Record failure
                        </button>
                      </>
                    )}
                    {can('payment.release.operational') && (
                      <>
                        <OutcomeActorChoice instructionId={i.id} value={outcomeActor[i.id] ?? ''} onChange={(userId) => setOutcomeActor({ ...outcomeActor, [i.id]: userId })} />
                        <input aria-label="Reason for reassigning" placeholder="Reason" value={reassignReason[i.id] ?? ''} onChange={(e) => setReassignReason({ ...reassignReason, [i.id]: e.target.value })} />
                        <button
                          className="secondary"
                          disabled={act.isPending || !outcomeActor[i.id] || !reassignReason[i.id]?.trim()}
                          onClick={() =>
                            act.mutate(() => api(`/v1/expense/payments/${i.id}/outcome-actor`, { body: { outcomeActorUserId: outcomeActor[i.id], reason: reassignReason[i.id]!.trim() } }), {
                              onSuccess: () => {
                                setOutcomeActor((current) => omit(current, i.id));
                                setReassignReason((current) => omit(current, i.id));
                              },
                            })
                          }
                        >
                          Reassign outcome
                        </button>
                      </>
                    )}
                  </>
                )}
                {i.state === 'CONFIRMED' && (
                  <>
                    <input
                      aria-label="Amount to reverse"
                      placeholder="Amount"
                      inputMode="decimal"
                      value={reversal[i.id]?.amount ?? ''}
                      onChange={(e) => setReversal({ ...reversal, [i.id]: { amount: e.target.value, reason: reversal[i.id]?.reason ?? '' } })}
                    />
                    <input
                      aria-label="Reason for the reversal"
                      placeholder="Reason"
                      value={reversal[i.id]?.reason ?? ''}
                      onChange={(e) => setReversal({ ...reversal, [i.id]: { amount: reversal[i.id]?.amount ?? '', reason: e.target.value } })}
                    />
                    <button
                      className="secondary"
                      disabled={act.isPending || evidenceKey(i.id).length < 8 || !reversal[i.id]?.amount || !reversal[i.id]?.reason}
                      onClick={() => record(i.id, 'reversal', { amount: reversal[i.id]!.amount, evidenceKey: evidenceKey(i.id), reason: reversal[i.id]!.reason })}
                    >
                      Record reversal
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {instructions.data?.items.length === 0 && <Empty>No payments prepared yet.</Empty>}
      <p className="hint">
        A prepared payment stays a draft until its preparer marks it ready, and only a ready payment can be released. The release names who records the outcome. Evidence
        references need at least 8 characters, and each outcome or reversal needs its own. The preparer, the approvers of the claim and the claimant cannot release, confirm or
        reverse. The entitlement approvers and the claimant cannot prepare.
      </p>
      {notice && (
        <p role="status" className="hint">
          {notice}
        </p>
      )}
      <ErrorNote error={instructions.error ?? act.error} />
    </Section>
  );
}

/** A copy of the map without one key. */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}

// ---------------------------------------------------------------------------------------------------------
// Inbox (FR-061/085) and reports (FR-056/065).
// ---------------------------------------------------------------------------------------------------------

export function InboxPage() {
  const qc = useQueryClient();
  const inbox = useQuery({
    queryKey: ['inbox'],
    queryFn: () => api<{ items: { id: string; category: string; title: string | null; body: string; occurredAt: string; readAt: string | null }[] }>('/v1/me/notifications', { withoutAssignment: true }),
  });
  const read = useMutation({
    mutationFn: (id: string) => api(`/v1/me/notifications/${id}/read`, { method: 'POST', withoutAssignment: true }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['inbox'] }),
  });
  return (
    <>
      <Section title="Notifications">
        {inbox.data?.items.length === 0 && <Empty>No notifications.</Empty>}
        <ul className="tasks">
          {inbox.data?.items.map((n) => (
            <li key={n.id} className={n.readAt ? 'read' : 'unread'}>
              <div>
                <strong>{n.title ?? n.category}</strong> {!n.readAt && <span className="badge badge-warn">new</span>}
              </div>
              <div>{n.body}</div>
              <div className="hint">{new Date(n.occurredAt).toLocaleString()}</div>
              {!n.readAt && (
                <button className="link" onClick={() => read.mutate(n.id)}>
                  Mark as read
                </button>
              )}
            </li>
          ))}
        </ul>
        <ErrorNote error={inbox.error} />
      </Section>
      <NotificationPreferencesPanel />
    </>
  );
}

export function ReportsPage() {
  // `formats` is present only for a report that offers more than CSV (FR-046 XLSX).
  const catalogue = useQuery({
    queryKey: ['catalogue'],
    queryFn: () => api<{ items: { code: string; title: string; requiresPeriod: boolean; formats?: string[] }[] }>('/v1/reports/catalogue'),
  });
  const [code, setCode] = useState('EMPLOYEE_REGISTER');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [format, setFormat] = useState('CSV');
  const [page, setPage] = useState(1);
  const qc = useQueryClient();
  // FR-056 "recoverable download links": the requester's own reports from the server, so a reload loses nothing.
  const reports = useQuery({
    queryKey: ['reports', page],
    queryFn: () => api<{ items: OwnReport[]; total: number }>(`/v1/reports?${pageParams(page)}`),
    refetchInterval: (q) => (!isReportRefusal(q.state.error) && q.state.data?.items.some((r) => r.state === 'QUEUED' || r.state === 'RUNNING') ? 3000 : false),
  });
  // The server lists only the reports this role may ask for; the choice shown is the one sent, so a report not in the list is never asked for.
  const offered = catalogue.data?.items ?? [];
  const chosen = offered.some((r) => r.code === code) ? code : (offered[0]?.code ?? '');
  const def = offered.find((r) => r.code === chosen);
  // A format is sent only to a report that declares it; every other report is CSV.
  const chosenFormat = def?.formats?.includes(format) ? format : 'CSV';
  const request = useMutation({
    mutationFn: () =>
      api<{ id: string }>('/v1/reports', {
        // The dates chosen for an earlier report stay in the form, but only a report with a period takes them.
        body: { reportCode: chosen, filters: { ...(def?.requiresPeriod && from ? { from } : {}), ...(def?.requiresPeriod && to ? { to } : {}) }, ...(def?.formats ? { format: chosenFormat } : {}) },
      }),
    onSuccess: () => {
      setPage(1);
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
  });
  return (
    <>
      <Section title="Request a report">
        {catalogue.data && offered.length === 0 && <Empty>No report can be requested in this role.</Empty>}
        {offered.length > 0 && (
        <form
          className="grid-form"
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate();
          }}
        >
          <label>
            Report
            <select
              value={chosen}
              onChange={(e) => {
                setCode(e.target.value);
                setFormat('CSV');
              }}
            >
              {catalogue.data?.items.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
          {def?.formats && (
            <label>
              Format
              <select value={chosenFormat} onChange={(e) => setFormat(e.target.value)}>
                {def.formats.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
          )}
          {def?.requiresPeriod && (
            <>
              <label>
                From
                <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
              </label>
              <label>
                To
                <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
              </label>
            </>
          )}
          <button type="submit">Request</button>
        </form>
        )}
        <p className="hint">Reports are generated in the background; downloads expire after 24 hours and re-check your access.</p>
        <ErrorNote error={request.error ?? catalogue.error} />
      </Section>
      <Section title={`My reports${reports.data ? ` (${reports.data.total})` : ''}`}>
        {reports.data?.total === 0 && <Empty>You have not requested any reports under this role.</Empty>}
        <ul className="tasks">
          {reports.data?.items.map((r) => (
            <ReportRow key={r.id} report={r} />
          ))}
        </ul>
        <Pager page={page} pageSize={LIST_PAGE_SIZE} total={reports.data?.total ?? 0} onPage={setPage} label="Report pages" noun="report" />
        <ErrorNote error={reports.error} />
      </Section>
    </>
  );
}

/** GET /v1/reports: one of the requester's own report executions. */
interface OwnReport {
  id: string;
  title: string;
  state: string;
  rowCount: number | null;
  failureCode: string | null;
  requestedAt: string;
  expiresAt: string | null;
  format: string;
}

function ReportRow({ report: r }: { report: OwnReport }) {
  const [error, setError] = useState<unknown>(null);
  const problem = reportProblem(r);
  return (
    <li>
      <strong>{r.title}</strong> <StateBadge state={r.state} /> {r.rowCount !== null && <span className="hint">{r.rowCount} rows</span>}
      <div className="hint">
        Requested {new Date(r.requestedAt).toLocaleString()}
        {r.state === 'COMPLETED' && r.expiresAt && `; the download expires ${new Date(r.expiresAt).toLocaleString()}`}
        {r.state === 'EXPIRED' && '; the download has expired, so request the report again'}
      </div>
      {problem && <div className="hint">{problem}</div>}
      {r.state === 'COMPLETED' && (
        <button className="link" onClick={() => download(`/v1/reports/${r.id}/download`).catch(setError)}>
          Download {r.format}
        </button>
      )}
      <ErrorNote error={error} />
    </li>
  );
}
