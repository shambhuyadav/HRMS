// The offer approvals queue (F1/C4): the independent eligible approver's decisions.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDate, idempotencyKey, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, NotPermitted, Section } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { DECISION_WORDS, LoadProblem, Refusal, refusalText } from './refusals';
import { COMPENSATION_APPROVE, COMPENSATION_READ, enc, H3, labelOf, Money, OFFER_READ, OFFER_STATE_LABEL, PATHS, RequisitionStateBadge, TEXTAREA, useKeys, useRefresh } from './shared';
import type { Decision, OfferDecided, OfferTask } from './types';

// ---------------------------------------------------------------------------------------------------------
// F1/C4 offer approvals: the independent eligible approver's queue (GET /v1/hiring/offer-tasks)
// ---------------------------------------------------------------------------------------------------------

export function OfferApprovalQueue() {
  const { can } = useSession();
  if (!can(COMPENSATION_APPROVE)) {
    return (
      <Section title="Offer approvals">
        <NotPermitted>The selected role cannot approve offers.</NotPermitted>
      </Section>
    );
  }
  return <OfferApprovalList />;
}

export function OfferApprovalList() {
  const keys = useKeys();
  const region = useRef<HTMLDivElement>(null);
  const tasks = useQuery({ queryKey: keys.offerTasks, queryFn: () => api<{ items: OfferTask[] }>('/v1/hiring/offer-tasks'), retry: retryTransient });
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const items = tasks.data?.items ?? [];
  const finished = (text: string, ok: boolean) => {
    setNotice({ text, ok });
    // The decided item and its focused button go away; keep a keyboard user in the queue, unless they moved on.
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label="Offer approvals" tabIndex={-1}>
      <Section title={`Offer approvals${tasks.data ? ` (${items.length})` : ''}`}>
        <p className="hint">
          Offers whose confidential compensation waits for your independent approval. An offer never reaches the person who prepared it, recorded its compensation
          or submitted it. Returning or rejecting needs a reason; a returned offer becomes a draft again and its next submission is a new revision.
        </p>
        {tasks.isPending && <p className="hint loading">Loading the offers waiting for you…</p>}
        <LoadProblem error={tasks.error} forbidden="The selected role cannot approve offers." />
        {notice && (
          <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
            {notice.text}
          </p>
        )}
        {tasks.data && items.length === 0 && <Empty>No offers are waiting for your approval.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Offers waiting for your approval">
            {items.map((t) => (
              <OfferTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function decidedText(result: OfferDecided, who: string): string {
  const replay = result.replayed ? ' Your earlier attempt had already been recorded, so nothing was applied twice.' : '';
  if (result.state === 'APPROVED') return `Approved the offer to ${who}.${replay}`;
  if (result.state === 'REJECTED') return `Rejected the offer to ${who}.${replay}`;
  if (result.state === 'DRAFT') return `Returned the offer to ${who} for changes: it is a draft again.${replay}`;
  return `The offer to ${who} is now ${labelOf(OFFER_STATE_LABEL, result.state).toLowerCase()}.${replay}`;
}

function OfferTaskItem({ task: t, onFinished }: { task: OfferTask; onFinished: (text: string, ok: boolean) => void }) {
  const { can } = useSession();
  const refresh = useRefresh();
  const id = useId();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const o = t.offer;
  const who = o ? `${o.candidate.fullName} (${o.candidate.candidateCode})` : 'the candidate';
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again (same choice, same reason)
   * after a failure, whose answer may have been lost on the way back, carries the same key: the server then answers from
   * what it recorded and never applies it twice. Any other decision is a new user action with a new key.
   */
  const attempt = useRef<{ decision: Decision; reason: string; key: string } | null>(null);
  const decide = useMutation({
    mutationFn: (body: { decision: Decision; reason?: string; idempotencyKey: string }) => api<OfferDecided>(`/v1/hiring/offer-tasks/${enc(t.taskId)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.current = null;
      onFinished(decidedText(result, who), true);
      refresh();
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      // The server took the key for another task's decision and recorded nothing: the next attempt gets a new key.
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      // Decided meanwhile, or no longer this user's or in scope: nothing is left to decide here.
      if (error.status === 404 || error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE') {
        onFinished(`Offer to ${who}: ${refusalText(error, DECISION_WORDS) ?? error.message}`, false);
        refresh();
      } else if (isConflict(error)) refresh();
    },
  });
  const send = (decision: Decision) => {
    if (decide.isPending) return;
    const text = reason.trim();
    if (decision !== 'APPROVE' && !text) {
      setProblem(decision === 'RETURN' ? 'Enter a reason to return the offer for changes.' : 'Enter a reason to reject the offer.');
      decide.reset();
      return;
    }
    setProblem(null);
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text ? last.key : idempotencyKey('offer-decision');
    attempt.current = { decision, reason: text, key };
    decide.mutate({ decision, ...(text ? { reason: text } : {}), idempotencyKey: key });
  };
  const titleId = `${id}-title`;
  if (!o) {
    return (
      <li aria-labelledby={titleId}>
        <h3 id={titleId} style={H3}>
          An offer outside the selected role’s scope
        </h3>
        <p className="hint">This approval’s offer is not in the selected role’s scope, so it cannot be decided here. Assigned {formatDate(t.assignedAt)}.</p>
      </li>
    );
  }
  const review = o.underReview;
  const currency = review?.currencyCode ?? null;
  const requisitionApproved = o.requisition.state === 'APPROVED';
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        Offer to {who} for {o.requisition.code}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <dl className="kv">
        <Item term="Requisition">
          {o.requisition.code} <span className="hint">{o.requisition.title}</span> <RequisitionStateBadge state={o.requisition.state} />
        </Item>
        <Item term="Revision under review">{review ? review.revision : '—'}</Item>
        <Item term="Proposed joining date">{formatDate(review?.proposedJoiningDate ?? o.proposedJoiningDate)}</Item>
        {currency && review?.annualCtc !== undefined && review.annualCtc !== null && (
          <Item term="Annual CTC">
            <Money value={review.annualCtc} currency={currency} />
          </Item>
        )}
        {currency && review?.monthlyGross !== undefined && review.monthlyGross !== null && (
          <Item term="Monthly gross">
            <Money value={review.monthlyGross} currency={currency} />
          </Item>
        )}
        <Item term="Submitted">{formatDate(review?.submittedAt ?? o.submittedAt)}</Item>
        <Item term="Assigned to you">{formatDate(t.assignedAt)}</Item>
      </dl>
      {!requisitionApproved && <p className="hint">The requisition is no longer approved: the offer can be returned or rejected, not approved.</p>}
      {(can(OFFER_READ) || can(COMPENSATION_READ)) && (
        <div>
          <Link to={PATHS.offer(o.id)}>Open the offer to {who}</Link>
        </div>
      )}
      <label>
        Reason (required to return or reject)
        <textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={decide.isPending || !requisitionApproved} aria-describedby={titleId} onClick={() => send('APPROVE')}>
          Approve
        </button>
        <button type="button" className="secondary" disabled={decide.isPending} aria-describedby={titleId} onClick={() => send('RETURN')}>
          Return for changes
        </button>
        <button type="button" className="danger" disabled={decide.isPending} aria-describedby={titleId} onClick={() => send('REJECT')}>
          Reject
        </button>
      </div>
      <Refusal error={decide.error} words={DECISION_WORDS} />
    </li>
  );
}

