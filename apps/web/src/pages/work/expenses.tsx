// Expenses (FR-070 to FR-077): a draft with lines, submission and own claims.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, fileToBase64, formatAmount, pinSession } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { canRaiseAgain, followedRequests, RaiseAgainNote, RaisedAgainHint } from '../requests';

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
  /** I-87: the currency paid in, when not INR ('' is INR); submission converts it at the rate in force on the expense date. */
  currency?: string;
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
/** I-87: the currencies a line is commonly paid in; INR is the claim's own (nothing extra is sent for it). */
const CLAIM_CURRENCIES: readonly string[] = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD'];
/** FR-074, DF03: a claim can be withdrawn at any state before its final decision. */
const WITHDRAWABLE_CLAIM = ['DRAFT', 'RETURNED', 'MANAGER_PENDING', 'FINANCE_PENDING', 'HIGH_VALUE_PENDING'];

interface OwnClaimLine {
  category: string;
  expenseDate: string;
  nights: number | null;
  merchant: string;
  invoiceReference: string | null;
  claimedAmount: string | null;
  grossAmount: string | null;
  description: string;
  receiptId?: string | null;
  receiptScanState?: string | null;
  /** I-87: a line paid in another currency, its own amounts, and the rate it was converted at once submitted. */
  currency?: string | null;
  sourceClaimedAmount?: string | null;
  sourceGrossAmount?: string | null;
  exchangeRate?: string | null;
}

/** The form's amounts of a stored line: in its own currency when it has one (I-87). */
const lineAmounts = (l: OwnClaimLine) => ({
  amount: Number(l.currency ? l.sourceClaimedAmount : l.claimedAmount).toFixed(2),
  gross: Number(l.currency ? l.sourceGrossAmount : l.grossAmount).toFixed(2),
  currency: l.currency ?? '',
});

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
          ...(l.currency && l.currency !== 'INR' ? { currency: l.currency } : {}),
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
          ...lineAmounts(l),
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
          ...lineAmounts(l),
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
          {receiptDropped && <p className="hint">A receipt on this claim failed the safety check and was removed; attach another.</p>}
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
              // A framed block per line: a grid-form inside a card draws no frame of its own, the fieldset does.
              <fieldset key={i}>
                <legend>Line {i + 1}</legend>
                <div className="grid-form">
                  {/* Full width, so a long category name is never cut off. */}
                  <label className="wide">
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
                    Currency paid in
                    <select value={l.currency || 'INR'} onChange={(e) => update(i, { currency: e.target.value === 'INR' ? '' : e.target.value })}>
                      {/* A currency not in the list (a stored line) keeps its own code. */}
                      {[...CLAIM_CURRENCIES, ...(l.currency && !CLAIM_CURRENCIES.includes(l.currency) ? [l.currency] : [])].map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {`Amount (${l.currency || 'INR'})`}
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
                </div>
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
              <th>
                <span className="sr-only">Actions</span>
              </th>
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
        {claims.data?.items.length === 0 && <Empty>{can('expense.draft.operational') ? 'No claims yet. Fill in New expense claim above to claim an expense.' : 'No claims yet.'}</Empty>}
        <ErrorNote error={claims.error ?? correct.error ?? raiseAgain.error ?? withdraw.error} />
      </Section>
    </>
  );
}
