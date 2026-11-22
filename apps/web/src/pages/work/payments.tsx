// Payments (FR-076/077, DF07): manual outcome tracking of approved claims.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { FormField, FormGrid, FramedFieldset } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, formatAmount, formatDate, idempotencyKey, localDate } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { CELL_CONTROLS } from './shared';

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
        <Hint>Recording payments here never transfers money; outcomes come from bank evidence.</Hint>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Purpose</TableHead>
              <TableHead scope="col">Approved</TableHead>
              <TableHead scope="col">Paid</TableHead>
              <TableHead scope="col">Pending</TableHead>
              <TableHead scope="col">Can still prepare</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {payables.data?.items.map((p) => (
              <TableRow key={p.claimId}>
                <TableCell>
                  {p.employeeName} <Hint as="span">{p.employeeCode}</Hint>
                </TableCell>
                <TableCell>{p.purpose}</TableCell>
                <TableCell>{formatAmount(p.approvedAmount, p.currency)}</TableCell>
                <TableCell>{formatAmount(p.netPaid, p.currency)}</TableCell>
                <TableCell>{formatAmount(p.pending, p.currency)}</TableCell>
                <TableCell>{formatAmount(p.allocatable, p.currency)}</TableCell>
                <TableCell>
                  <StateBadge state={p.paymentState} />
                </TableCell>
                <RowActionsCell>
                  <RowActions>
                    <Button variant="outline" size="sm" onClick={() => setSelected(p.claimId)}>
                      Manage
                    </Button>
                  </RowActions>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
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
      <NativeSelect aria-label="Outcome recorded by" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">Choose who records the outcome</option>
        {actors.data?.items.map((a) => (
          <option key={a.userId} value={a.userId}>
            {a.employeeName ? `${a.employeeName} (${a.employeeCode})` : a.accountKey}
          </option>
        ))}
      </NativeSelect>
      {actors.data?.items.length === 0 && <Hint as="span">Nobody independent holds the confirmation duty for this payment.</Hint>}
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
      <FormGrid
        onSubmit={(e) => {
          e.preventDefault();
          prepare.mutate();
        }}
      >
        <FormField>
          Amount
          <Input
            inputMode="decimal"
            placeholder={payable?.allocatable}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              prepareKey.current = null;
            }}
          />
        </FormField>
        <FormField>
          Payment date
          <Input
            type="date"
            value={paymentDate}
            onChange={(e) => {
              setPaymentDate(e.target.value);
              prepareKey.current = null;
            }}
            required
          />
        </FormField>
        {replaceable.length > 0 && (
          <FormField>
            Replaces a failed payment
            <NativeSelect
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
            </NativeSelect>
          </FormField>
        )}
        {payrollInputsToReview(prepare.error).length > 0 && (
          <FramedFieldset legend="Payroll reimbursements to review">
            <Hint>
              Payroll does not pay expense claims, but these payroll reimbursements were entered for this employee since the claim was submitted. Check that none of
              them pays this claim, then say why before preparing the payment.
            </Hint>
            <ul>
              {payrollInputsToReview(prepare.error).map((p) => (
                <li key={p.inputId}>
                  {`Period ${p.periodCode}, reference ${p.reference}, ${p.state.toLowerCase()}, dated ${formatDate(p.effectiveDate)}${p.matchesAmount ? ', for the same amount as this payment' : ''}`}
                </li>
              ))}
            </ul>
            <FormField>
              Why these do not pay this claim
              <Textarea value={payrollReview} maxLength={1000} required onChange={(e) => setPayrollReview(e.target.value)} />
            </FormField>
          </FramedFieldset>
        )}
        <Button type="submit" disabled={prepare.isPending}>
          Prepare payment
        </Button>
      </FormGrid>
      {payrollInputsToReview(prepare.error).length === 0 && <ErrorNote error={prepare.error} />}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Amount</TableHead>
            <TableHead scope="col">Date</TableHead>
            <TableHead scope="col">State</TableHead>
            <TableHead scope="col">Reversed</TableHead>
            <TableHead scope="col">Bank evidence reference</TableHead>
            <TableHead scope="col">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {instructions.data?.items.map((i) => (
            <TableRow key={i.id}>
              <TableCell>{formatAmount(i.amount, i.currency)}</TableCell>
              <TableCell>{formatDate(i.paymentDate)}</TableCell>
              <TableCell>
                <StateBadge state={i.state} />
                {i.retryOfInstructionId && <Hint as="span"> Replaces a failed payment</Hint>}
              </TableCell>
              <TableCell>{formatAmount(i.reversed, i.currency)}</TableCell>
              <TableCell>
                {((i.state === 'RELEASED' && i.outcomeAssignedToMe) || i.state === 'CONFIRMED') && (
                  <Input
                    aria-label="Evidence reference"
                    placeholder="e.g. bank reference"
                    className="w-auto"
                    value={evidence[i.id] ?? ''}
                    onChange={(e) => setEvidence({ ...evidence, [i.id]: e.target.value })}
                  />
                )}
              </TableCell>
              {/* The step's controls: fields beside their buttons, at the fields' height (not a row of small row actions). */}
              <TableCell>
                <div className={CELL_CONTROLS}>
                  {i.state === 'PREPARED' && i.batchState === 'DRAFT' && (
                    <>
                      <Badge tone="neutral">Draft</Badge>
                      {can('payment.prepare.operational') && (
                        <Button disabled={act.isPending} onClick={() => act.mutate(() => api(`/v1/expense/payments/${i.id}/ready`, { method: 'POST' }))}>
                          Mark ready
                        </Button>
                      )}
                    </>
                  )}
                  {i.state === 'PREPARED' && i.batchState === 'READY' && can('payment.release.operational') && (
                    <>
                      <OutcomeActorChoice instructionId={i.id} value={outcomeActor[i.id] ?? ''} onChange={(userId) => setOutcomeActor({ ...outcomeActor, [i.id]: userId })} />
                      <Button
                        disabled={act.isPending || !outcomeActor[i.id]}
                        onClick={() =>
                          act.mutate(() => api(`/v1/expense/payments/${i.id}/release`, { body: { outcomeActorUserId: outcomeActor[i.id] } }), { onSuccess: () => setOutcomeActor((current) => omit(current, i.id)) })
                        }
                      >
                        Release
                      </Button>
                    </>
                  )}
                  {i.state === 'RELEASED' && (
                    <>
                      <Hint as="span">{i.outcomeActorAccountKey ? `Outcome assigned to ${i.outcomeActorAccountKey}` : 'Nobody is assigned the outcome yet'}</Hint>
                      {i.outcomeAssignedToMe && can('payment.confirm_outcome.operational') && (
                        <>
                          <Button disabled={act.isPending || evidenceKey(i.id).length < 8} onClick={() => record(i.id, 'outcome', { outcome: 'CONFIRMED', evidenceKey: evidenceKey(i.id) })}>
                            Confirm paid
                          </Button>
                          <Button variant="danger" disabled={act.isPending || evidenceKey(i.id).length < 8} onClick={() => record(i.id, 'outcome', { outcome: 'FAILED', evidenceKey: evidenceKey(i.id) })}>
                            Record failure
                          </Button>
                        </>
                      )}
                      {can('payment.release.operational') && (
                        <>
                          <OutcomeActorChoice instructionId={i.id} value={outcomeActor[i.id] ?? ''} onChange={(userId) => setOutcomeActor({ ...outcomeActor, [i.id]: userId })} />
                          <Input
                            aria-label="Reason for reassigning"
                            placeholder="Reason"
                            className="w-auto"
                            value={reassignReason[i.id] ?? ''}
                            onChange={(e) => setReassignReason({ ...reassignReason, [i.id]: e.target.value })}
                          />
                          <Button
                            variant="outline"
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
                          </Button>
                        </>
                      )}
                    </>
                  )}
                  {i.state === 'CONFIRMED' && (
                    <>
                      <Input
                        aria-label="Amount to reverse"
                        placeholder="Amount"
                        inputMode="decimal"
                        className="w-auto"
                        value={reversal[i.id]?.amount ?? ''}
                        onChange={(e) => setReversal({ ...reversal, [i.id]: { amount: e.target.value, reason: reversal[i.id]?.reason ?? '' } })}
                      />
                      <Input
                        aria-label="Reason for the reversal"
                        placeholder="Reason"
                        className="w-auto"
                        value={reversal[i.id]?.reason ?? ''}
                        onChange={(e) => setReversal({ ...reversal, [i.id]: { amount: reversal[i.id]?.amount ?? '', reason: e.target.value } })}
                      />
                      <Button
                        variant="outline"
                        disabled={act.isPending || evidenceKey(i.id).length < 8 || !reversal[i.id]?.amount || !reversal[i.id]?.reason}
                        onClick={() => record(i.id, 'reversal', { amount: reversal[i.id]!.amount, evidenceKey: evidenceKey(i.id), reason: reversal[i.id]!.reason })}
                      >
                        Record reversal
                      </Button>
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {instructions.data?.items.length === 0 && <Empty>No payments prepared yet.</Empty>}
      <Hint>
        A prepared payment stays a draft until its preparer marks it ready, and only a ready payment can be released. The release names who records the outcome. Evidence
        references need at least 8 characters, and each outcome or reversal needs its own. The preparer, the approvers of the claim and the claimant cannot release, confirm or
        reverse. The entitlement approvers and the claimant cannot prepare.
      </Hint>
      {notice && (
        <StatusNote tone="info" role="status">
          {notice}
        </StatusNote>
      )}
      <ErrorNote error={instructions.error ?? act.error} />
    </Section>
  );
}

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

/** A copy of the map without one key. */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  const next = { ...map };
  delete next[key];
  return next;
}
