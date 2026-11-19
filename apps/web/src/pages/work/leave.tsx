// Leave (FR-024 to FR-026): balances, the request form and own requests with withdrawal.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
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
          <button type="button" className="link" onClick={switchRole}>
            Switch role
          </button>{' '}
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
                  {b.leaveTypeName || b.leaveType} {b.paid || /unpaid/i.test(b.leaveTypeName ?? '') ? '' : '(unpaid)'}
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
                  <option key={b.leaveType} value={b.leaveType}>
                    {b.leaveTypeName || b.leaveType}
                  </option>
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
            {/* Its own row under the dates, not floating beside them. */}
            <label className="check wide">
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
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {requests.data?.items.map((r) => (
              <tr key={r.id}>
                <td>{typeName(r.leaveType)}</td>
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
        {requests.data?.items.length === 0 && <Empty>{can('leave.submit.operational') ? 'No leave requests yet. Use Request leave above to ask for time off.' : 'No leave requests yet.'}</Empty>}
        {requests.isPending && <p className="hint loading">Loading your requests…</p>}
        <ErrorNote error={requests.error} />
        <ErrorNote error={withdraw.error} />
      </Section>
    </>
  );
}
