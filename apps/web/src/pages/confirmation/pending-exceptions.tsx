// DF11/C4 exception proposals waiting for a decision in the selected role's scope, oldest first.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { api, ApiError, formatDate, idempotencyKey, isForbidden, localDateTime, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Item, NotPermitted, Section } from '../../ui';
import { Refusal, refusalText } from './refusals';
import { decidedText, type DecisionBody, type ExceptionDecided, type ExceptionDecision, H3, kindLabel, PENDING_LIMIT, type PendingException, PROPOSE_EXCEPTION, TEXTAREA, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// DF11/C4: exception proposals waiting for a decision in the selected role's scope, oldest first. Each decision needs
// a reason and carries an idempotency key; a proposal is never decided by its proposer or by the employee concerned.
// ---------------------------------------------------------------------------------------------------------

export function PendingExceptions({ onOpenCase }: { onOpenCase: ((caseId: string) => void) | null }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  const list = useQuery({
    queryKey: keys.pendingExceptions,
    queryFn: () => api<{ items: PendingException[] }>('/v1/confirmation-exceptions/pending'),
    retry: retryTransient,
  });
  /** Proposals seen decided or withdrawn here: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const items = (list.data?.items ?? []).filter((x) => !gone.has(x.id));

  const refreshCase = (x: PendingException) => {
    void qc.invalidateQueries({ queryKey: keys.case(x.confirmationId) });
    void qc.invalidateQueries({ queryKey: keys.allCases });
  };
  const finished = (x: PendingException, text: string, ok: boolean, caseChanged: boolean) => {
    setGone((prev) => new Set(prev).add(x.id));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.pendingExceptions });
    void qc.invalidateQueries({ queryKey: keys.exceptions(x.confirmationId) });
    // An approved override is the case's new due date (and may change its view).
    if (caseChanged) refreshCase(x);
    // The item and its focused button go away; keep a keyboard user in the queue, unless they moved on.
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };

  return (
    <div ref={region} role="region" aria-label="Pending exceptions" tabIndex={-1}>
      <Section title="Pending exceptions">
        <p className="hint">Due date overrides and extra extensions proposed by HR wait here for a decision by another HR user. Each decision needs a reason.</p>
        {list.isPending && <p className="hint loading">Loading the waiting proposals…</p>}
        {isForbidden(list.error) ? <NotPermitted>The selected role cannot decide confirmation exceptions.</NotPermitted> : <ErrorNote error={list.error} />}
        {notice && (
          <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
            {notice.text}
          </p>
        )}
        {list.data && items.length === 0 && <Empty>No exceptions are waiting for a decision.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Exceptions waiting for a decision">
            {items.map((x) => (
              <PendingItem
                key={x.id}
                item={x}
                ownCase={!!me?.employeeId && me.employeeId === x.employeeId}
                canWithdraw={can(PROPOSE_EXCEPTION)}
                onOpenCase={onOpenCase}
                onFinished={finished}
                onCaseConflict={refreshCase}
              />
            ))}
          </ul>
        )}
        {list.data && list.data.items.length >= PENDING_LIMIT && <p className="hint">Showing the oldest {PENDING_LIMIT} waiting proposals; newer ones appear as these are decided.</p>}
      </Section>
    </div>
  );
}

function PendingItem({
  item: x,
  ownCase,
  canWithdraw,
  onOpenCase,
  onFinished,
  onCaseConflict,
}: {
  item: PendingException;
  /** The exception concerns the signed-in user's own confirmation. */
  ownCase: boolean;
  /** Withdrawing needs the propose permission. */
  canWithdraw: boolean;
  onOpenCase: ((caseId: string) => void) | null;
  /** Decided or withdrawn (`ok`), or found final already: the item leaves the queue with `text`. */
  onFinished: (x: PendingException, text: string, ok: boolean, caseChanged: boolean) => void;
  onCaseConflict: (x: PendingException) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const who = `${x.employeeName} (${x.employeeCode})`;
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again (same choice, same reason)
   * after a failure, whose answer may have been lost on the way back, carries the same key: the server then answers
   * from what it recorded instead of refusing it as decided already, and never applies it twice. Any other decision is
   * a new user action with a new key.
   */
  const attempt = useRef<{ decision: ExceptionDecision; reason: string; key: string } | null>(null);
  const decide = useMutation({
    mutationFn: (body: DecisionBody) => api<ExceptionDecided>(`/v1/confirmation-exceptions/${encodeURIComponent(x.id)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.current = null;
      onFinished(x, decidedText(x, result), true, result.state === 'APPROVED');
    },
    onError: (error) => {
      // The server refused the key as another decision's and recorded nothing: the next attempt gets a new key.
      if (error instanceof ApiError && error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      // Decided or withdrawn by someone else, or out of the role's scope now: nothing left to decide here.
      else if (error instanceof ApiError && (error.code === 'INVALID_STATE' || error.status === 404)) onFinished(x, refusalText(error, 'decide') ?? error.message, false, true);
      // The case moved on (a recommendation under review, or closed): show it as it is now.
      else if (error instanceof ApiError && error.status === 409) onCaseConflict(x);
    },
  });
  const withdraw = useMutation({
    mutationFn: () => api<{ exceptionId: string; state: string }>(`/v1/confirmation-exceptions/${encodeURIComponent(x.id)}/withdraw`, { method: 'POST' }),
    onSuccess: () => onFinished(x, `Withdrew your ${kindLabel(x.kind).toLowerCase()} proposal for ${who}.`, true, false),
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'INVALID_STATE') onFinished(x, refusalText(error, 'withdraw') ?? error.message, false, true);
    },
  });
  const busy = decide.isPending || withdraw.isPending;
  // C4: never by the proposer, never by the employee concerned (the server refuses both as well).
  const blocked = x.ownProposal
    ? 'You proposed this exception, so another HR user has to decide it.'
    : ownCase
      ? 'This exception is for your own confirmation, so another HR user has to decide it.'
      : null;

  const send = (decision: ExceptionDecision) => {
    if (blocked !== null || busy) return;
    const text = reason.trim();
    if (!text) {
      setProblem('Enter a reason for your decision.');
      decide.reset();
      return;
    }
    setProblem(null);
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text ? last.key : idempotencyKey('conf-exception');
    attempt.current = { decision, reason: text, key };
    decide.mutate({ decision, reason: text, idempotencyKey: key });
  };

  const titleId = `${id}-title`;
  const blockedId = `${id}-blocked`;
  const describedBy = blocked === null ? titleId : `${titleId} ${blockedId}`;
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        {kindLabel(x.kind)}: {who}
      </h3>
      <dl className="kv">
        {x.kind === 'DUE_DATE_OVERRIDE' ? <Item term="Proposed due date">{formatDate(x.proposedDueDate)}</Item> : <Item term="Effect">One extension beyond the policy limit</Item>}
        <Item term="Proposed at">
          <time dateTime={x.proposedAt}>{localDateTime(x.proposedAt)}</time>
        </Item>
        {typeof x.reason === 'string' && <Item term="Reason">{x.reason}</Item>}
      </dl>
      {onOpenCase && (
        <div>
          <button type="button" className="link" onClick={() => onOpenCase(x.confirmationId)}>
            Open the case of {who}
          </button>
        </div>
      )}
      {blocked === null ? (
        <label>
          Decision reason (required)
          <textarea required maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
        </label>
      ) : (
        <p className="hint" id={blockedId}>
          {blocked}
        </p>
      )}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={blocked !== null || busy} aria-describedby={describedBy} onClick={() => send('APPROVE')}>
          Approve
        </button>
        <button type="button" className="danger" disabled={blocked !== null || busy} aria-describedby={describedBy} onClick={() => send('REJECT')}>
          Reject
        </button>
        {x.ownProposal && canWithdraw && (
          <button type="button" className="secondary" disabled={busy} onClick={() => withdraw.mutate()}>
            Withdraw proposal
          </button>
        )}
      </div>
      <Refusal error={decide.error} action="decide" />
      <Refusal error={withdraw.error} action="withdraw" />
    </li>
  );
}
