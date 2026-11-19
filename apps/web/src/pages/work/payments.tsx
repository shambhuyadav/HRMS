// Payments (FR-076/077, DF07): manual outcome tracking of approved claims.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, ApiError, formatAmount, formatDate, idempotencyKey, localDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../../ui';

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
        <p className="hint">Recording payments here never transfers money; outcomes come from bank evidence.</p>
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
              <th scope="col"><span className="sr-only">Actions</span></th>
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
  // BR-024 (I-81 item 8): payroll reimbursements entered for this employee since the claim was submitted could be the same money; the
  // server lists them and waits for the preparer's recorded review of why they do not pay this claim.
  const [payrollReview, setPayrollReview] = useState('');
  const prepare = useMutation({
    mutationFn: () => {
      prepareKey.current ??= idempotencyKey('pay');
      return api('/v1/expense/payments', {
        body: {
          claimId,
          amount: amount || payable?.allocatable,
          paymentDate,
          idempotencyKey: prepareKey.current,
          ...(chosenRetry ? { retryOfInstructionId: chosenRetry } : {}),
          ...(payrollReview.trim() ? { payrollReimbursementReview: payrollReview.trim() } : {}),
        },
      });
    },
    onSuccess: () => {
      prepareKey.current = null;
      setAmount('');
      setRetryOf('');
      setPayrollReview('');
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
        {payrollInputsToReview(prepare.error).length > 0 && (
          <fieldset>
            <legend>Payroll reimbursements to review</legend>
            <p className="hint">
              Payroll does not pay expense claims, but these payroll reimbursements were entered for this employee since the claim was submitted. Check that none of
              them pays this claim, then say why before preparing the payment.
            </p>
            <ul>
              {payrollInputsToReview(prepare.error).map((p) => (
                <li key={p.inputId}>
                  {`Period ${p.periodCode}, reference ${p.reference}, ${p.state.toLowerCase()}, dated ${formatDate(p.effectiveDate)}${p.matchesAmount ? ', for the same amount as this payment' : ''}`}
                </li>
              ))}
            </ul>
            <label>
              Why these do not pay this claim
              <textarea value={payrollReview} maxLength={1000} required onChange={(e) => setPayrollReview(e.target.value)} />
            </label>
          </fieldset>
        )}
        <button type="submit" disabled={prepare.isPending}>
          Prepare payment
        </button>
      </form>
      {payrollInputsToReview(prepare.error).length === 0 && <ErrorNote error={prepare.error} />}
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
/** BR-024 (I-81 item 8): the payroll reimbursements a refused payment listed for review; none for any other answer. */
interface PayrollInputToReview {
  inputId: string;
  periodCode: string;
  reference: string;
  state: string;
  effectiveDate: string;
  matchesAmount: boolean;
}
function payrollInputsToReview(error: unknown): PayrollInputToReview[] {
  if (!(error instanceof ApiError) || error.code !== 'PAYROLL_REIMBURSEMENT_REVIEW_REQUIRED') return [];
  const listed = (error.details as { payrollInputs?: PayrollInputToReview[] } | undefined)?.payrollInputs;
  return Array.isArray(listed) ? listed : [];
}

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}
