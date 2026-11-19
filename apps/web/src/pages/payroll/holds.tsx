// Salary holds and salary stops: the hold and stop lists and hold release.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, LIST_PAGE_SIZE, Pager, pageParams, Section } from '../../ui';
import { HoldDetailView, HoldRenew, HoldWithdraw } from './hold-proposals';
import { Problem, ReasonForm } from './problems';
import { Fact, type Hold, HOLD_DECIDE, HOLD_KIND, HOLD_PROPOSE, HOLD_RELEASE, HOLD_STATE, type HoldTotals, label, money, type SalaryStop, SCROLL, Status, STOP_DECIDE, STOP_MODE, STOP_PROPOSE, STOP_STATE, TEXTAREA, useKeys } from './shared';

// =========================================================================================================
// Salary holds and salary stops: decisions and release (proposals need verified evidence documents: not here)
// =========================================================================================================

const HOLD_FILTERS = ['PROPOSED', 'APPROVED_ACTIVE', 'EXPIRED_REVIEW', 'RELEASED', 'REJECTED', 'WITHDRAWN'];

export function HoldList() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [state, setState] = useState('');
  const [acting, setActing] = useState<{ hold: Hold; action: 'release' | 'withdraw' | 'renew' | 'details' } | null>(null);
  const releasing = acting?.action === 'release' ? acting.hold : null;
  const [note, setNote] = useState<string | null>(null);
  const open = (hold: Hold, action: 'release' | 'withdraw' | 'renew' | 'details') => {
    setNote(null);
    setActing(acting?.hold.id === hold.id && acting.action === action ? null : { hold, action });
  };
  const done = (text: string) => {
    setActing(null);
    setNote(text);
    void qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-hold') });
  };
  const [page, setPage] = useState(1);
  // FR-056: one page at a time; `total` counts every hold in scope. H7 totals (per currency, every matching hold, under
  // the hold amount grant) come with each page.
  const holds = useQuery({
    queryKey: [...keys.holds(state), page],
    queryFn: () => api<{ items: Hold[]; total?: number; totals?: HoldTotals[] }>(`/v1/payroll/holds?${state ? `state=${encodeURIComponent(state)}&` : ''}${pageParams(page)}`),
    retry: retryTransient,
  });
  return (
    <Section
      title="Salary holds"
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
            {HOLD_FILTERS.map((s) => (
              <option key={s} value={s}>
                {label(HOLD_STATE, s)}
              </option>
            ))}
          </select>
        </label>
      }
    >
      <p className="hint">
        A hold withholds payment of earned salary; it never reduces what was earned. A released amount is paid only through a new manifest and a confirmed outcome. A hold is proposed from the member list of a processed payroll run.
      </p>
      {holds.isPending && <p className="hint loading">Loading holds…</p>}
      {holds.error && <Problem error={holds.error} act="read" />}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      {holds.data && holds.data.items.length === 0 && <Empty>No salary holds in the selected role’s scope.</Empty>}
      {holds.data && holds.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Salary holds">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Period</th>
                <th>Kind</th>
                <th>Held</th>
                <th>State</th>
                <th>Review due</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {holds.data.items.map((h) => {
                const live = h.state === 'APPROVED_ACTIVE' || h.state === 'EXPIRED_REVIEW';
                const maker = h.proposedBy === me?.userId;
                const of = `${h.employeeCode} for ${h.periodCode}`;
                return (
                  <tr key={h.id}>
                    <td>{`${h.employeeCode} ${h.employeeName}`}</td>
                    <td>{`${h.periodCode} revision ${h.runRevision}`}</td>
                    <td>{label(HOLD_KIND, h.holdKind)}</td>
                    <td>{h.scope === 'PARTIAL' ? money(h.holdAmount, h.currencyCode) : 'Full net pay'}</td>
                    <td>
                      <Status map={HOLD_STATE} code={h.state} />
                    </td>
                    <td>{formatDate(h.reviewDueOn)}</td>
                    <td>
                      <div className="row">
                        <button type="button" className="link" onClick={() => open(h, 'details')} aria-label={`Details of the hold of ${of}`}>
                          Details
                        </button>
                        {live && can(HOLD_RELEASE) && (
                          <button type="button" className="link" onClick={() => open(h, 'release')} aria-label={`Release the hold of ${of}`}>
                            Release
                          </button>
                        )}
                        {h.state === 'PROPOSED' && maker && can(HOLD_PROPOSE) && (
                          <button type="button" className="link" onClick={() => open(h, 'withdraw')} aria-label={`Withdraw the hold proposal of ${of}`}>
                            Withdraw
                          </button>
                        )}
                        {h.state === 'EXPIRED_REVIEW' && h.holdKind === 'POLICY_HOLD' && can(HOLD_DECIDE) && (
                          <button type="button" className="link" onClick={() => open(h, 'renew')} aria-label={`Renew the review of the hold of ${of}`}>
                            Renew review
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {holds.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={holds.data.total ?? holds.data.items.length} onPage={setPage} label="Hold pages" noun="hold" />}
      {holds.data?.totals && holds.data.totals.length > 0 && (
        <>
          <p className="hint">
            Totals of every hold matching the filter, on all pages: the held salary still owed until its payment is confirmed (once per payroll record, never more than the record pays), what the payment
            allocations of released holds have reserved, and what the bank confirmed paid less reversals.
          </p>
          {holds.data.totals.map((t) => (
            <dl key={t.currencyCode} className="kv" aria-label={`Hold totals in ${t.currencyCode}`}>
              {t.outstanding !== undefined && <Fact term="Outstanding (held, not yet confirmed paid)">{money(t.outstanding, t.currencyCode)}</Fact>}
              <Fact term="Reserved for payment, not paid">{money(t.reserved, t.currencyCode)}</Fact>
              <Fact term="Paid (confirmed from bank evidence)">{money(t.confirmed, t.currencyCode)}</Fact>
            </dl>
          ))}
        </>
      )}
      {releasing &&<ReleaseForm key={releasing.id} hold={releasing} maker={releasing.holdKind !== 'PAYMENT_SAFETY_BLOCK' && releasing.proposedBy === me?.userId} onDone={done} />}
      {acting?.action === 'details' && <HoldDetailView key={acting.hold.id} id={acting.hold.id} />}
      {acting?.action === 'withdraw' && <HoldWithdraw key={acting.hold.id} hold={acting.hold} onDone={done} />}
      {acting?.action === 'renew' && <HoldRenew key={acting.hold.id} hold={acting.hold} maker={acting.hold.proposedBy === me?.userId} onDone={done} />}
    </Section>
  );
}

function ReleaseForm({ hold, maker, onDone }: { hold: Hold; maker: boolean; onDone: (text: string) => void }) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const release = useMutation({
    mutationFn: (body: { reason: string; evidenceReference: string; expectedVersion: number }) => api<Hold>(`/v1/payroll/holds/${encodeURIComponent(hold.id)}/release`, { body }),
    onSuccess: () => onDone(`The hold of ${hold.employeeCode} was released. The amount becomes payable through a new manifest; it is not paid until a confirmed outcome.`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (release.isPending || maker) return;
    const why = reason.trim();
    const ref = evidence.trim();
    if (!why) return setProblem('Give the reason for the release.');
    if (!ref) return setProblem('Give the evidence reference for the release.');
    setProblem(null);
    release.reset();
    release.mutate({ reason: why, evidenceReference: ref, expectedVersion: hold.version });
  };
  const name = `Release the hold of ${hold.employeeCode}`;
  return (
    <form onSubmit={submit} aria-label={name} className="grid-form" style={{ marginTop: '0.5rem' }}>
      {maker && <p className="hint wide">You proposed this hold, so someone else releases it.</p>}
      <label className="wide">
        Reason for the release
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <label>
        Evidence reference
        <input value={evidence} onChange={(e) => setEvidence(e.target.value)} maxLength={500} autoComplete="off" />
      </label>
      <div className="row">
        <button type="submit" disabled={release.isPending || maker}>
          {release.isPending ? 'Releasing…' : 'Release the hold'}
        </button>
      </div>
      {problem && (
        <p role="alert" className="error wide">
          {problem}
        </p>
      )}
      <div className="wide">
        <Problem error={release.error} act="hold-release" />
      </div>
    </form>
  );
}

export function StopList() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [acting, setActing] = useState<{ stop: SalaryStop; action: 'withdraw' | 'revoke' } | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  // FR-056: one page at a time; `total` counts every salary stop in scope.
  const stops = useQuery({
    queryKey: [...keys.stops, page],
    queryFn: () => api<{ items: SalaryStop[]; total?: number }>(`/v1/payroll/salary-stops?${pageParams(page)}`),
    retry: retryTransient,
  });
  const change = useMutation({
    mutationFn: ({ stop: s, action, reason }: { stop: SalaryStop; action: 'withdraw' | 'revoke'; reason: string }) =>
      api<SalaryStop>(`/v1/payroll/salary-stops/${encodeURIComponent(s.id)}/${action}`, { body: action === 'withdraw' ? { reason } : { reason, expectedVersion: s.version } }),
    onSuccess: (s, { action }) => {
      setActing(null);
      setNote(action === 'withdraw' ? `The salary stop proposal of ${s.employeeCode} was withdrawn.` : `The salary stop of ${s.employeeCode} was revoked: the next calculation pays the employee as usual.`);
    },
    onSettled: () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-stop') }),
  });
  /** What the selected role may do with a stop: withdraw its own proposal, or revoke an approved stop it did not make. */
  const actionOf = (s: SalaryStop): 'withdraw' | 'revoke' | null =>
    s.state === 'SUBMITTED' && s.proposedBy === me?.userId && can(STOP_PROPOSE) ? 'withdraw' : s.state === 'APPROVED' && s.proposedBy !== me?.userId && can(STOP_DECIDE) ? 'revoke' : null;
  const withActions = (stops.data?.items ?? []).some((s) => actionOf(s) !== null);
  return (
    <Section title="Salary stops">
      {stops.isPending && <p className="hint loading">Loading salary stops…</p>}
      {stops.error && <Problem error={stops.error} act="read" />}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      {stops.data && stops.data.items.length === 0 && <Empty>No salary stops in the selected role’s scope.</Empty>}
      {stops.data && stops.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Salary stops">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Period</th>
                <th>Mode</th>
                <th>State</th>
                <th>Decided</th>
                {withActions && <th>Change</th>}
              </tr>
            </thead>
            <tbody>
              {stops.data.items.map((s) => {
                const action = actionOf(s);
                return (
                  <tr key={s.id}>
                    <td>{`${s.employeeCode} ${s.employeeName}`}</td>
                    <td>{s.periodCode}</td>
                    <td>{label(STOP_MODE, s.approvedMode ?? s.mode)}</td>
                    <td>
                      <Status map={STOP_STATE} code={s.state} />
                    </td>
                    <td>{formatDate(s.decidedAt)}</td>
                    {withActions && (
                      <td>
                        {action ? (
                          <button
                            type="button"
                            className="link"
                            disabled={change.isPending}
                            onClick={() => {
                              change.reset();
                              setNote(null);
                              setActing({ stop: s, action });
                            }}
                            aria-label={`${action === 'withdraw' ? 'Withdraw' : 'Revoke'} the salary stop of ${s.employeeCode} for ${s.periodCode}`}
                          >
                            {action === 'withdraw' ? 'Withdraw' : 'Revoke'}
                          </button>
                        ) : (
                          '—'
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {stops.data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={stops.data.total ?? stops.data.items.length} onPage={setPage} label="Salary stop pages" noun="salary stop" />}
      {acting && (
        <ReasonForm
          key={`${acting.stop.id}:${acting.action}`}
          name={`${acting.action === 'withdraw' ? 'Withdraw' : 'Revoke'} the salary stop of ${acting.stop.employeeCode}`}
          field={acting.action === 'withdraw' ? 'Why the proposal is withdrawn' : 'Why the approved stop is revoked'}
          button={acting.action === 'withdraw' ? 'Withdraw the proposal' : 'Revoke the salary stop'}
          busy={change.isPending}
          danger={acting.action === 'revoke'}
          onSend={(reason) => change.mutateAsync({ stop: acting.stop, action: acting.action, reason })}
        />
      )}
      <Problem error={change.error} act="stop-act" />
    </Section>
  );
}
