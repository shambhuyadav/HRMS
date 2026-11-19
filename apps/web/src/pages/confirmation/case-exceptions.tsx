// DF11 exceptions of one case (I-19): their history, the proposer's withdrawal, and a new proposal.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useRef, useState } from 'react';
import { api, ApiError, formatDate, isForbidden, localDateTime, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, NotPermitted, StateBadge } from '../../ui';
import { Refusal } from './refusals';
import { APPROVE_EXCEPTION, type CaseDetail, type CaseException, type ExceptionBody, type ExceptionKind, GROUP, H3, kindLabel, PROPOSE_EXCEPTION, SCROLL, SR_ONLY, TEXTAREA, useKeys, useUserId } from './shared';

// ---------------------------------------------------------------------------------------------------------
// DF11 exceptions of one case (I-19): their history, the proposer's withdrawal, and a new proposal.
// ---------------------------------------------------------------------------------------------------------

export function CaseExceptions({ kase, onCaseChanged }: { kase: CaseDetail; onCaseChanged: () => void }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const userId = useUserId();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const tableBox = useRef<HTMLDivElement>(null);
  const canPropose = can(PROPOSE_EXCEPTION);
  const list = useQuery({
    queryKey: keys.exceptions(kase.id),
    queryFn: () => api<{ items: CaseException[] }>(`/v1/confirmations/${encodeURIComponent(kase.id)}/exceptions`),
    retry: retryTransient,
  });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: keys.exceptions(kase.id) });
    void qc.invalidateQueries({ queryKey: keys.pendingExceptions });
  };
  const withdraw = useMutation({
    mutationFn: (x: CaseException) => api<{ exceptionId: string; state: string }>(`/v1/confirmation-exceptions/${encodeURIComponent(x.id)}/withdraw`, { method: 'POST' }),
    onSuccess: () => {
      refresh();
      // The row's button goes away; keep a keyboard user in the case panel, unless they moved on.
      const active = document.activeElement;
      if (!active || active === document.body || tableBox.current?.contains(active)) heading.current?.focus();
    },
    // Decided or withdrawn meanwhile: reload, so the row shows where it stands now.
    onError: (error) => {
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) refresh();
    },
  });

  const items = list.data?.items ?? [];
  const mayWithdraw = (x: CaseException) => canPropose && userId !== null && x.state === 'PROPOSED' && x.proposedBy === userId;
  // Sending, and until the list shows the withdrawal, so it cannot be sent twice.
  const withdrawing = withdraw.isPending || (withdraw.isSuccess && list.isFetching);
  // DF11: an exception can be proposed while the case is open or under review, never once it is closed.
  const canStillChange = kase.state === 'OPEN' || kase.state === 'REVIEW_PENDING';
  const ownCase = !!me?.employeeId && me.employeeId === kase.employeeId;

  return (
    <>
      <h3 id={headingId} ref={heading} tabIndex={-1} style={H3}>
        Exceptions
      </h3>
      <p className="hint">An approved due date override replaces the case’s due date; an approved extra extension allows one extension beyond the policy limit.</p>
      {list.isPending && <p className="hint loading">Loading exceptions…</p>}
      {isForbidden(list.error) ? <NotPermitted>The selected role cannot view this case’s exceptions.</NotPermitted> : <ErrorNote error={list.error} />}
      {list.data && items.length === 0 && <Empty>No exceptions have been proposed for this case.</Empty>}
      {items.length > 0 && (
        <div ref={tableBox}>
          <ExceptionTable items={items} labelledBy={headingId} mayWithdraw={mayWithdraw} busy={withdrawing} onWithdraw={(x) => withdraw.mutate(x)} />
        </div>
      )}
      {withdraw.isSuccess && (
        <p className="ok" role="status">
          Proposal withdrawn.
        </p>
      )}
      <Refusal error={withdraw.error} action="withdraw" />
      {can(APPROVE_EXCEPTION) && items.some((x) => x.state === 'PROPOSED') && <p className="hint">Waiting proposals are decided under Pending exceptions on this page.</p>}
      {canPropose &&
        canStillChange &&
        (ownCase ? (
          <p className="hint">You cannot propose an exception for your own confirmation.</p>
        ) : (
          <ProposeExceptionForm
            kase={kase}
            onProposed={refresh}
            onConflict={() => {
              onCaseChanged();
              refresh();
            }}
          />
        ))}
    </>
  );
}

function ExceptionTable({
  items,
  labelledBy,
  mayWithdraw,
  busy,
  onWithdraw,
}: {
  items: CaseException[];
  labelledBy: string;
  mayWithdraw: (x: CaseException) => boolean;
  busy: boolean;
  onWithdraw: (x: CaseException) => void;
}) {
  // The private reasons arrive for every row or for none (the confirmation reason group).
  const withReasons = items.some((x) => typeof x.reason === 'string');
  const withAction = items.some(mayWithdraw);
  return (
    <div style={SCROLL}>
      <table aria-labelledby={labelledBy}>
        <thead>
          <tr>
            <th scope="col">Exception</th>
            <th scope="col">Proposed due date</th>
            <th scope="col">State</th>
            <th scope="col">Proposed at</th>
            <th scope="col">Decided at</th>
            {withReasons && <th scope="col">Reason</th>}
            {withReasons && <th scope="col">Decision reason</th>}
            {withAction && (
              <th scope="col">
                <span style={SR_ONLY}>Action</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((x) => (
            <tr key={x.id}>
              <td>{kindLabel(x.kind)}</td>
              <td>{formatDate(x.proposedDueDate)}</td>
              <td>
                <StateBadge state={x.state} />
              </td>
              <td>
                <time dateTime={x.proposedAt}>{localDateTime(x.proposedAt)}</time>
              </td>
              <td>{x.decidedAt ? <time dateTime={x.decidedAt}>{localDateTime(x.decidedAt)}</time> : '—'}</td>
              {withReasons && <td>{x.reason}</td>}
              {withReasons && <td>{x.decisionReason ?? '—'}</td>}
              {withAction && (
                <td>
                  {mayWithdraw(x) && (
                    <button type="button" className="link" disabled={busy} aria-label={`Withdraw your ${kindLabel(x.kind).toLowerCase()} proposal`} onClick={() => onWithdraw(x)}>
                      Withdraw
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A new exception with its private reason; another HR user decides it. Required-field checks only: whether the case
 * allows it (state, extension limit, an open proposal of the kind, the employee's start date) is the server's call.
 */
function ProposeExceptionForm({ kase, onProposed, onConflict }: { kase: CaseDetail; onProposed: () => void; onConflict: () => void }) {
  const id = useId();
  const [kind, setKind] = useState<'' | ExceptionKind>('');
  const [dueDate, setDueDate] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // DF11: the due date changes only while the case is open; a recommendation under review keeps the date it was made
  // for. A choice made before the case moved on no longer applies (what was typed is kept).
  const overrideOpen = kase.state === 'OPEN';
  const chosen = kind === 'DUE_DATE_OVERRIDE' && !overrideOpen ? '' : kind;
  const propose = useMutation({
    mutationFn: (body: ExceptionBody) => api<{ exceptionId: string; state: string }>(`/v1/confirmations/${encodeURIComponent(kase.id)}/exceptions`, { body }),
    // A proposal sent starts the form clean; a refused one keeps what was typed.
    onSuccess: () => {
      setKind('');
      setDueDate('');
      setReason('');
      onProposed();
    },
    // The case moved on (a recommendation arrived, it closed, a proposal of this kind appeared): show it as it is now.
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onConflict();
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = reason.trim();
    const missing =
      chosen === '' ? 'Choose the kind of exception.' : chosen === 'DUE_DATE_OVERRIDE' && !dueDate ? 'Enter the new due date.' : !text ? 'Enter a reason.' : null;
    setProblem(missing);
    if (missing !== null) {
      propose.reset();
      return;
    }
    if (chosen === '' || propose.isPending) return;
    propose.mutate(chosen === 'DUE_DATE_OVERRIDE' ? { kind: chosen, proposedDueDate: dueDate, reason: text } : { kind: chosen, reason: text });
  };

  const overrideHint = `${id}-override`;
  return (
    <>
      <h3 id={`${id}-title`} style={H3}>
        Propose an exception
      </h3>
      <form className="grid-form" aria-labelledby={`${id}-title`} onSubmit={submit}>
        <fieldset className="wide" style={GROUP}>
          <legend>Exception</legend>
          <div className="row">
            <label className="check">
              <input
                type="radio"
                name={`${id}-kind`}
                value="DUE_DATE_OVERRIDE"
                required
                disabled={!overrideOpen}
                aria-describedby={overrideOpen ? undefined : overrideHint}
                checked={chosen === 'DUE_DATE_OVERRIDE'}
                onChange={() => setKind('DUE_DATE_OVERRIDE')}
              />{' '}
              Due date override
            </label>
            <label className="check">
              <input type="radio" name={`${id}-kind`} value="EXTRA_EXTENSION" required checked={chosen === 'EXTRA_EXTENSION'} onChange={() => setKind('EXTRA_EXTENSION')} />{' '}
              Extra extension
            </label>
          </div>
          {!overrideOpen && (
            <p className="hint" id={overrideHint}>
              The due date cannot change while a recommendation is under review.
            </p>
          )}
        </fieldset>
        {chosen === 'DUE_DATE_OVERRIDE' && (
          <label>
            New due date
            <input type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </label>
        )}
        <label className="wide">
          Reason (required)
          <textarea required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
        <p className="hint wide">The reason is confidential. Another HR user decides the exception; the case changes only if it is approved.</p>
        {problem && (
          <p role="alert" className="error wide">
            {problem}
          </p>
        )}
        {propose.error && (
          <div className="wide">
            <Refusal error={propose.error} action="propose" sent={{ kind: propose.variables?.kind, startDate: kase.startDate }} />
          </div>
        )}
        <div className="wide row">
          <button type="submit" disabled={propose.isPending}>
            Propose exception
          </button>
        </div>
        {propose.isSuccess && (
          <p className="ok wide" role="status">
            Exception proposed. Another HR user decides it; the case changes only if it is approved.
          </p>
        )}
      </form>
    </>
  );
}
