// Leave (FR-024 to FR-026): balances, the request form and own requests with withdrawal.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, formatUnits } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { canRaiseAgain, type Evidence, EvidenceChoice, EvidenceError, EvidenceList, followedRequests, ownRecordInScope, ownRecordNotFound, RaiseAgainNote, RaisedAgainHint } from '../requests';

// ---------------------------------------------------------------------------------------------------------
// Leave (FR-024-FR-026): balances, request form, own requests with withdrawal.
// ---------------------------------------------------------------------------------------------------------

interface Balance {
  leaveType: string;
  /** The name HR gave the type; the code is shown when an older server sends none. */
  leaveTypeName?: string;
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
export const leaveEvidencePath = (requestId: string, documentId: string) => `/v1/leave/requests/${requestId}/evidence/${documentId}/content`;

/** A follow-up form in a request's actions cell (the old `td form.inline`): its fields and button side by side, bottoms aligned. */
const CELL_FORM = 'mt-[0.4rem] flex flex-wrap items-end gap-x-4 gap-y-3';

/** Which inline follow-up an own request offers (DF03): resubmit a returned request, or ask to cancel approved leave. */
type FollowUp = 'resubmit' | 'cancel' | 'cancellation-waiting' | null;

function followUpOf(r: LeaveRequest, can: (permission: string) => boolean): FollowUp {
  if (r.state === 'RETURNED' && can('leave.submit.operational')) return 'resubmit';
  if (r.state === 'APPROVED' && r.cancellationState === 'SUBMITTED') return 'cancellation-waiting';
  if (r.state === 'APPROVED' && can('leave.cancel.operational')) return 'cancel';
  return null;
}

/**
 * An own request's actions cell: the actions given as children (withdraw, raise again), then the inline follow-up. Closed, the cell
 * takes only the room of its buttons; with a follow-up form open it takes the room the form needs, its words wrapping.
 */
function RequestActionsCell({ request: r, onChanged, children }: { request: LeaveRequest; onChanged: () => void; children: ReactNode }) {
  const { can } = useSession();
  const [open, setOpen] = useState(false);
  const followUp = followUpOf(r, can);
  const done = () => {
    setOpen(false);
    onChanged();
  };
  return (
    <RowActionsCell expanded={open}>
      <RowActions>
        {children}
        {followUp === 'resubmit' && !open && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            Correct and resubmit
          </Button>
        )}
        {followUp === 'cancellation-waiting' && <Hint as="span">Cancellation waiting for decision</Hint>}
        {followUp === 'cancel' && !open && (
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            Cancel leave
          </Button>
        )}
      </RowActions>
      {followUp === 'resubmit' && open && <ResubmitForm request={r} onDone={done} />}
      {followUp === 'cancel' && open && <CancellationForm request={r} onDone={done} />}
    </RowActionsCell>
  );
}

/** Correcting a returned request: new dates, a new private reason and documents, each kept from before when left alone. */
function ResubmitForm({ request: r, onDone }: { request: LeaveRequest; onDone: () => void }) {
  const [dates, setDates] = useState({ startDate: r.startDate.slice(0, 10), endDate: r.endDate.slice(0, 10), halfDay: r.halfDay });
  // The earlier private reason is kept by the server unless a new one is sent (the employee cannot read it back).
  const [newReason, setNewReason] = useState('');
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
    onSuccess: onDone,
  });
  return (
    <form
      className={CELL_FORM}
      onSubmit={(e) => {
        e.preventDefault();
        resubmit.mutate();
      }}
    >
      <Input type="date" aria-label="From" required className="w-auto" value={dates.startDate} onChange={(e) => setDates({ ...dates, startDate: e.target.value })} />
      {!dates.halfDay && <Input type="date" aria-label="To" required className="w-auto" value={dates.endDate} onChange={(e) => setDates({ ...dates, endDate: e.target.value })} />}
      <CheckField>
        <input type="checkbox" checked={dates.halfDay} onChange={(e) => setDates({ ...dates, halfDay: e.target.checked })} /> Half day
      </CheckField>
      <Input
        aria-label="New reason (private)"
        placeholder="New reason (private, optional)"
        maxLength={1000}
        className="w-auto"
        value={newReason}
        onChange={(e) => setNewReason(e.target.value)}
      />
      <EvidenceChoice chosen={evidence} onChange={setEvidence} earlier={r.evidence ?? []} />
      <Button disabled={resubmit.isPending}>Resubmit</Button>
      <Hint as="span">Leave the new reason empty and your earlier reason is kept; tick no document and the documents attached before are kept.</Hint>
      <EvidenceError error={resubmit.error} keptEarlier={evidence.length === 0} />
    </form>
  );
}

/** Asking to cancel approved leave, with the reason for it. */
function CancellationForm({ request: r, onDone }: { request: LeaveRequest; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => api(`/v1/leave/requests/${r.id}/cancellation`, { body: { reason } }),
    onSuccess: onDone,
  });
  return (
    <form
      className={CELL_FORM}
      onSubmit={(e) => {
        e.preventDefault();
        cancel.mutate();
      }}
    >
      <Input aria-label="Cancellation reason" placeholder="Reason" required maxLength={1000} className="w-auto" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button disabled={cancel.isPending}>Ask to cancel</Button>
      <ErrorNote error={cancel.error} />
    </form>
  );
}

export function LeavePage() {
  const { me, can, switchRole } = useSession();
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
  const typeName = (code: string) => balances.data?.items.find((b) => b.leaveType === code)?.leaveTypeName || code;

  if (!employeeId) return <Empty>No employee record is linked to this account.</Empty>;
  if (!own || ownRecordNotFound(balances.error) || ownRecordNotFound(requests.error)) {
    // Said in the reader's terms: where their own leave is, and where their team's requests are.
    return (
      <Section title="Leave">
        <p>
          Your own leave is not in this role’s scope.{' '}
          <Button type="button" variant="link" size="inline" onClick={switchRole}>
            Switch role
          </Button>{' '}
          and choose your Employee role to see your balances or request leave.
        </p>
        {can('leave.approve.operational') && (
          <p>
            Your team’s leave requests are waiting for you in <Link to="/tasks">Decisions</Link>.
          </p>
        )}
      </Section>
    );
  }
  return (
    <>
      <Section title="Leave balances (days)">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Type</TableHead>
              <TableHead scope="col">Available</TableHead>
              <TableHead scope="col">Pending</TableHead>
              <TableHead scope="col">Taken</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {balances.data?.items.map((b) => (
              <TableRow key={b.leaveType}>
                <TableCell>
                  {b.leaveTypeName || b.leaveType} {b.paid || /unpaid/i.test(b.leaveTypeName ?? '') ? '' : '(unpaid)'}
                </TableCell>
                <TableCell>{b.paid ? formatUnits(b.available) : '—'}</TableCell>
                <TableCell>{formatUnits(b.pending)}</TableCell>
                <TableCell>{formatUnits(b.taken)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <ErrorNote error={balances.error} />
      </Section>

      {can('leave.submit.operational') && (
        <Section title="Request leave">
          {raisingAgain && <RaiseAgainNote onCancel={() => setRaisingAgain(null)} />}
          <FormGrid
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              submit.mutate();
            }}
          >
            <FormField>
              Type
              <NativeSelect value={form.leaveType} onChange={(e) => setForm({ ...form, leaveType: e.target.value })}>
                {(balances.data?.items ?? []).map((b) => (
                  <option key={b.leaveType} value={b.leaveType}>
                    {b.leaveTypeName || b.leaveType}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              From
              <Input type="date" required value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            </FormField>
            {!form.halfDay && (
              <FormField>
                To
                <Input type="date" required value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
              </FormField>
            )}
            {/* Its own row under the dates, not floating beside them. */}
            <CheckField className="col-span-full">
              <input type="checkbox" checked={form.halfDay} onChange={(e) => setForm({ ...form, halfDay: e.target.checked })} /> Half day
            </CheckField>
            <FormField className="col-span-full">
              Reason (private, optional)
              <Input value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} maxLength={1000} />
            </FormField>
            <EvidenceChoice chosen={evidence} onChange={setEvidence} />
            <Button type="submit" disabled={submit.isPending}>
              Submit request
            </Button>
          </FormGrid>
          {submit.isSuccess && <StatusNote tone="success">Request submitted for review.</StatusNote>}
          <EvidenceError error={submit.error} />
        </Section>
      )}

      <Section title="My requests">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Type</TableHead>
              <TableHead scope="col">From</TableHead>
              <TableHead scope="col">To</TableHead>
              <TableHead scope="col">Days</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Documents</TableHead>
              <TableHead scope="col">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {requests.data?.items.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{typeName(r.leaveType)}</TableCell>
                <TableCell>{formatDate(r.startDate)}</TableCell>
                <TableCell>{formatDate(r.endDate)}</TableCell>
                <TableCell>{formatUnits(r.units)}</TableCell>
                <TableCell>
                  <StateBadge state={r.state} />
                  <RaisedAgainHint predecessorRequestId={r.predecessorRequestId} />
                </TableCell>
                <TableCell>
                  <EvidenceList evidence={r.evidence ?? []} openPath={(documentId) => leaveEvidencePath(r.id, documentId)} />
                </TableCell>
                <RequestActionsCell request={r} onChanged={refresh}>
                  {(r.state === 'SUBMITTED' || r.state === 'RETURNED') && can('leave.withdraw.operational') && (
                    <Button variant="danger" size="sm" onClick={() => withdraw.mutate(r.id)}>
                      Withdraw
                    </Button>
                  )}{' '}
                  {canRaiseAgain(r, followedRequests(requests.data?.items ?? [])) && can('leave.submit.operational') && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        submit.reset();
                        // The private reason is not read back: the new request states its own.
                        setForm({ leaveType: r.leaveType, startDate: r.startDate.slice(0, 10), endDate: r.endDate.slice(0, 10), halfDay: r.halfDay, reason: '' });
                        setEvidence([]);
                        setRaisingAgain(r.id);
                      }}
                    >
                      Raise again
                    </Button>
                  )}{' '}
                </RequestActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {requests.data?.items.length === 0 && <Empty>{can('leave.submit.operational') ? 'No leave requests yet. Use Request leave above to ask for time off.' : 'No leave requests yet.'}</Empty>}
        {requests.isPending && <LoadingLine>Loading your requests…</LoadingLine>}
        <ErrorNote error={requests.error} />
        <ErrorNote error={withdraw.error} />
      </Section>
    </>
  );
}
