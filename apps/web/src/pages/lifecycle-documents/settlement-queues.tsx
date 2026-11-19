// The settlement decision queues (FR-053; DF03; C4; ZT07): independent review, then independent approval.
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, idempotencyKey, isConflict, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, NotPermitted, Section } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { DECISION_WORDS, Refusal, refusalText } from './refusals';
import { LineTable } from './settlement-views';
import { CALCULATION_LABEL, enc, H3, Item, labelOf, LoadProblem, MAX_REASON, Money, PATHS, SETTLEMENT_APPROVE, SETTLEMENT_READ, SETTLEMENT_REVIEW, settlementLabel, SettlementState, TEXTAREA, useKeys, UserRef, useSettlementRefresh, when } from './shared';
import type { Decision, DecisionBody, QueueKind, SettlementDecided, SettlementDetail, SettlementTask } from './types';

// =========================================================================================================
// Decision queues (FR-053; DF03; C4; ZT07): independent review, then independent approval
// =========================================================================================================
const QUEUES: Record<
  QueueKind,
  { title: string; decide: string; route: 'review' | 'approve'; keyPrefix: string; step: string; intro: string; empty: string; listLabel: string }
> = {
  settlement: {
    title: 'Settlement reviews',
    decide: SETTLEMENT_REVIEW,
    route: 'review',
    keyPrefix: 'settlement-review',
    step: 'Review',
    intro:
      'Submitted settlement revisions waiting for your independent review; a revision never reaches the person who prepared it. Returning or rejecting needs a reason; an approved review goes to an independent approver.',
    empty: 'No settlements are waiting for your review.',
    listLabel: 'Settlements waiting for your review',
  },
  settlement_approval: {
    title: 'Settlement approvals',
    decide: SETTLEMENT_APPROVE,
    route: 'approve',
    keyPrefix: 'settlement-approval',
    step: 'Approval',
    intro:
      'Reviewed settlement revisions waiting for your independent approval; an approver is never the preparer or the reviewer. Approval does not make the settlement eligible for release and makes no payment.',
    empty: 'No settlements are waiting for your approval.',
    listLabel: 'Settlements waiting for your approval',
  },
};

export function SettlementReviewQueue() {
  return <SettlementQueue kind="settlement" />;
}

export function SettlementApprovalQueue() {
  return <SettlementQueue kind="settlement_approval" />;
}

function SettlementQueue({ kind }: { kind: QueueKind }) {
  const { can } = useSession();
  const q = QUEUES[kind];
  if (!can(q.decide)) {
    return (
      <Section title={q.title}>
        <NotPermitted>The selected role cannot make this decision: it needs the confidential settlement {q.route === 'review' ? 'review' : 'approval'} grant.</NotPermitted>
      </Section>
    );
  }
  if (!can(SETTLEMENT_READ)) {
    return (
      <Section title={q.title}>
        <NotPermitted>The selected role cannot list settlement tasks: that needs the settlement read duty as well.</NotPermitted>
      </Section>
    );
  }
  return <SettlementQueueList kind={kind} />;
}

function SettlementQueueList({ kind }: { kind: QueueKind }) {
  const keys = useKeys();
  const q = QUEUES[kind];
  const region = useRef<HTMLDivElement>(null);
  // Both queues read the same list (one request): reviews are `settlement` tasks, approvals `settlement_approval` tasks.
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<{ items: SettlementTask[] }>('/v1/settlements/tasks/mine'), retry: retryTransient });
  /** Tasks seen decided here leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const items = (tasks.data?.items ?? []).filter((t) => t.kind === kind && !gone.has(t.taskId));
  const finished = (taskId: string, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(taskId));
    setNotice({ text, ok });
    // The item and its focused button go away; keep a keyboard user in the queue, unless they moved on.
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label={q.title} tabIndex={-1}>
      <Section title={`${q.title}${tasks.data ? ` (${items.length})` : ''}`}>
        <p className="hint">{q.intro}</p>
        {tasks.isPending && <p className="hint loading">Loading the settlements waiting for you…</p>}
        <LoadProblem error={tasks.error} forbidden="The selected role cannot list settlement tasks." />
        {notice && (
          <p className={notice.ok ? 'ok' : 'error'} role={notice.ok ? 'status' : 'alert'}>
            {notice.text}
          </p>
        )}
        {tasks.data && items.length === 0 && <Empty>{q.empty}</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label={q.listLabel}>
            {items.map((t) => (
              <SettlementTaskItem key={t.taskId} task={t} kind={kind} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function decidedText(kind: QueueKind, result: SettlementDecided, s: SettlementDetail, who: string): string {
  const subject = `revision ${s.revision} of the settlement of ${who}`;
  const replay = result.replayed ? ' Your earlier attempt had already been recorded, so nothing was applied twice.' : '';
  if (result.state === 'REVIEWED') return `Reviewed ${subject}: it now waits for an independent approval.${replay}`;
  if (result.state === 'APPROVED') return `Approved ${subject}. It is not yet eligible for release, and no payment is made here.${replay}`;
  if (result.state === 'RETURNED') return `Returned ${subject} for correction: the preparer prepares a corrected revision.${replay}`;
  if (result.state === 'REJECTED') return `Rejected ${subject}.${replay}`;
  return `${kind === 'settlement' ? 'Review' : 'Approval'} recorded: ${subject} is now ${settlementLabel(result.state).toLowerCase()}.${replay}`;
}

function SettlementTaskItem({ task: t, kind, onFinished }: { task: SettlementTask; kind: QueueKind; onFinished: (taskId: string, text: string, ok: boolean) => void }) {
  const { can, me } = useSession();
  const refresh = useSettlementRefresh();
  const id = useId();
  const q = QUEUES[kind];
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const s = t.settlement;
  const who = s ? `${s.employeeName} (${s.employeeCode})` : 'an employee';
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again (same choice, same reason)
   * after a failure, whose answer may have been lost on the way back, carries the same key: the server then answers from
   * what it recorded and never applies it twice. Any other decision is a new user action with a new key.
   */
  const attempt = useRef<{ decision: Decision; reason: string; key: string } | null>(null);
  const decide = useMutation({
    mutationFn: (body: DecisionBody) => api<SettlementDecided>(`/v1/settlements/tasks/${enc(t.taskId)}/${q.route}`, { body }),
    onSuccess: (result) => {
      attempt.current = null;
      if (s) onFinished(t.taskId, decidedText(kind, result, s, who), true);
      refresh(s);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      // The server took the key for another task's decision and recorded nothing: the next attempt gets a new key.
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      // Decided meanwhile, or no longer this user's or in scope: nothing is left to decide here.
      if (error.status === 404 || error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE') {
        onFinished(t.taskId, `Settlement of ${who}: ${refusalText(error, DECISION_WORDS) ?? error.message}`, false);
        refresh(s);
      } else if (isConflict(error)) refresh(s);
    },
  });
  const titleId = `${id}-title`;
  const blockedId = `${id}-blocked`;
  if (!s) {
    return (
      <li aria-labelledby={titleId}>
        <h3 id={titleId} style={H3}>
          A settlement outside the selected role’s scope
        </h3>
        <p className="hint">This task’s settlement is not in the selected role’s scope, so it cannot be decided here.</p>
      </li>
    );
  }
  // C4: never about one's own record, never by the preparer (the server refuses both as well).
  const blocked =
    !!me?.employeeId && me.employeeId === s.employeeId
      ? 'This settlement is about your own record, so someone else decides it.'
      : me?.userId === s.preparedBy
        ? 'You prepared this settlement, so someone else decides it.'
        : null;
  const send = (decision: Decision) => {
    if (blocked !== null || decide.isPending) return;
    const text = reason.trim();
    if (decision !== 'APPROVE' && !text) {
      setProblem(decision === 'RETURN' ? 'Enter a reason to return the settlement for correction.' : 'Enter a reason to reject the settlement.');
      decide.reset();
      return;
    }
    setProblem(null);
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text ? last.key : idempotencyKey(q.keyPrefix);
    attempt.current = { decision, reason: text, key };
    decide.mutate({ decision, ...(text ? { reason: text } : {}), idempotencyKey: key });
  };
  const describedBy = blocked === null ? titleId : `${titleId} ${blockedId}`;
  return (
    <li aria-labelledby={titleId}>
      <h3 id={titleId} style={H3}>
        {q.step}: settlement of {who}, revision {s.revision}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <dl className="kv">
        <Item term="State">
          <SettlementState state={s.state} />
        </Item>
        <Item term="Currency">{s.currencyCode}</Item>
        {s.netAmount !== undefined && (
          <Item term="Net amount">
            <Money value={s.netAmount} currency={s.currencyCode} />
          </Item>
        )}
        <Item term="Calculation">{labelOf(CALCULATION_LABEL, s.calculationStatus)}</Item>
        {/* I-88: the server refuses the final approval while an item of the calculation blocks it. */}
        {s.calculation && s.calculation.blockingCount > 0 && (
          <Item term="Blocking items">
            {s.calculation.blockingCount} <Badge tone="bad">{s.calculation.blockingCount === 1 ? 'blocks approval' : 'block approval'}</Badge>
          </Item>
        )}
        <Item term="Prepared by">
          <UserRef userId={s.preparedBy} />
        </Item>
        <Item term="Submitted">{when(s.submittedAt)}</Item>
        {kind === 'settlement_approval' && <Item term="Reviewed">{when(s.reviewedAt)}</Item>}
      </dl>
      {s.lines && s.lines.length > 0 && <LineTable lines={s.lines} currency={s.currencyCode} />}
      {can(SETTLEMENT_READ) && (
        <div>
          <Link to={PATHS.settlement(s.id)}>Open the settlement of {who}</Link>
        </div>
      )}
      {blocked === null ? (
        <label>
          Reason (required to return or reject)
          <textarea maxLength={MAX_REASON} rows={2} value={reason} disabled={decide.isPending} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
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
        <button type="button" disabled={blocked !== null || decide.isPending} aria-describedby={describedBy} onClick={() => send('APPROVE')}>
          {kind === 'settlement' ? 'Approve the review' : 'Approve'}
        </button>
        <button type="button" className="secondary" disabled={blocked !== null || decide.isPending} aria-describedby={describedBy} onClick={() => send('RETURN')}>
          Return for correction
        </button>
        <button type="button" className="danger" disabled={blocked !== null || decide.isPending} aria-describedby={describedBy} onClick={() => send('REJECT')}>
          Reject
        </button>
      </div>
      <Refusal
        error={decide.error}
        words={DECISION_WORDS}
        noAnswer="No answer came back, so your decision may or may not have been recorded. Send the same decision again: it is never applied twice."
      />
    </li>
  );
}

