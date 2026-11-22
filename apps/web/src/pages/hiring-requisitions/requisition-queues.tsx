// The requisition decision queues (F1): validation, then HR budget and headcount approval.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, idempotencyKey, isForbidden, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Notice, NotPermitted, Section, When } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { Refusal, refusalText } from './refusals';
import { BudgetCheckText, RequisitionFacts } from './requisition-views';
import {
  PATHS,
  REQ_APPROVE,
  REQ_READ,
  REQ_VALIDATE,
  type RequisitionDecided,
  type RequisitionDecisionBody,
  type RequisitionTask,
  shown,
  stepText,
  useKeys,
} from './shared';

// ---------------------------------------------------------------------------------------------------------
// Decision queue: requisitions (F1: validation, then HR budget and headcount approval)
// ---------------------------------------------------------------------------------------------------------

type RequisitionStep = 'validate' | 'approve';

/**
 * F1's two requisition steps. Both are listed by GET /v1/hiring/requisition-tasks (requisition.read), but each is
 * decided with its own duty, so each step has its own queue, shown only with that duty.
 */
const REQUISITION_STEP_QUEUES: Record<RequisitionStep, { title: string; hint: string; list: string; empty: string }> = {
  validate: {
    title: 'Requisition validations',
    hint: 'Step 1: the requester’s direct manager (or HR when the manager cannot) validates the requisition; an independent HR Administrator then approves its budget and headcount. Returning or rejecting needs a reason.',
    list: 'Requisitions waiting for your validation',
    empty: 'No requisitions are waiting for your validation.',
  },
  approve: {
    title: 'Requisition budget and headcount approvals',
    hint: 'Step 2: an independent HR Administrator approves the budget and headcount of a validated requisition; one beyond its budget needs its exception approved explicitly. Returning or rejecting needs a reason.',
    list: 'Requisitions waiting for your budget and headcount approval',
    empty: 'No requisitions are waiting for your budget and headcount approval.',
  },
};

/** Step 1 tasks, for a role that reads requisitions and validates them. */
export function RequisitionValidationQueue() {
  const { can } = useSession();
  return can(REQ_READ) && can(REQ_VALIDATE) ? <RequisitionQueue step="validate" /> : null;
}

/** Step 2 tasks, for a role that reads requisitions and approves their budget and headcount. */
export function RequisitionApprovalQueue() {
  const { can } = useSession();
  return can(REQ_READ) && can(REQ_APPROVE) ? <RequisitionQueue step="approve" /> : null;
}

function RequisitionQueue({ step }: { step: RequisitionStep }) {
  const queue = REQUISITION_STEP_QUEUES[step];
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  // Both step queues read the same route under the same key: one request, each listing its own step's tasks.
  const tasks = useQuery({ queryKey: keys.requisitionTasks, queryFn: () => api<{ items: RequisitionTask[] }>('/v1/hiring/requisition-tasks'), retry: retryTransient });
  /** Tasks seen decided here, or found closed: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => t.stepAction === step && !gone.has(t.taskId));
  const finished = (t: RequisitionTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.requisitionTasks });
    void qc.invalidateQueries({ queryKey: keys.requisitions });
    // The item and its focused button go away; keep a keyboard user in the queue, unless they moved on.
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label={queue.title} tabIndex={-1}>
      <Section title={`${queue.title}${data ? ` (${items.length})` : ''}`}>
        <Hint>{queue.hint}</Hint>
        {tasks.isPending && <LoadingLine>Loading the requisitions waiting for you…</LoadingLine>}
        {isForbidden(tasks.error) ? <NotPermitted>The selected role cannot decide requisitions.</NotPermitted> : <ErrorNote error={tasks.error} />}
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>{queue.empty}</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label={queue.list}>
            {items.map((t) => (
              <RequisitionTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function requisitionDecidedText(code: string, body: RequisitionDecisionBody, result: RequisitionDecided): string {
  if (result.replayed) return `Your earlier decision on ${code} had already been recorded, so nothing was applied twice. Its state is now: ${readable(result.state).toLowerCase()}.`;
  if (result.pendingStep === 2) return `Validated ${code}. It now waits for HR budget and headcount approval.`;
  if (result.state === 'APPROVED') return body.approveBudgetException ? `Approved ${code} and its budget exception.` : `Approved ${code}.`;
  if (result.state === 'REJECTED') return `Rejected ${code}.`;
  if (result.state === 'DRAFT') return `Returned ${code} to the requester for changes.`;
  return `${code} is now ${readable(result.state).toLowerCase()}.`;
}

function RequisitionTaskItem({ task: t, onFinished }: { task: RequisitionTask; onFinished: (t: RequisitionTask, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const r = t.requisition;
  const validating = t.stepAction === 'validate';
  const approving = t.stepAction === 'approve';
  // A step this screen does not know is never decided here.
  const permitted = (validating && can(REQ_VALIDATE)) || (approving && can(REQ_APPROVE));
  const [reason, setReason] = useState('');
  const [exceptionApproved, setExceptionApproved] = useState(false);
  /** The server asked for an explicit exception decision (the budget moved since this queue was loaded). */
  const [askException, setAskException] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /**
   * The decision last sent and its idempotency key (ZT07). Sending that same decision again after a failure, whose
   * answer may have been lost, carries the same key: the server answers from what it recorded and never applies it
   * twice. Any other decision (another choice, reason or exception approval) is a new action with a new key.
   */
  const attempt = useRef<{ decision: string; reason: string; exception: boolean; key: string } | null>(null);
  const exceeds = r?.budgetCheck ? r.budgetCheck.budgetStatus !== 'WITHIN_BUDGET' : false;
  // Only a recorded exception (pinned with the submission) can be approved; without one the server refuses approval.
  const showException = approving && !!r?.budgetExceptionReason && (exceeds || askException);
  const code = r?.code ?? 'the requisition';
  const decide = useMutation({
    mutationFn: (body: RequisitionDecisionBody) => api<RequisitionDecided>(`/v1/hiring/requisition-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result, body) => {
      attempt.current = null;
      onFinished(t, requisitionDecidedText(code, body, result), true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      // The server took the key for another decision's and recorded nothing: the next attempt gets a new key.
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      else if (error.code === 'BUDGET_EXCEPTION_DECISION_REQUIRED' || error.code === 'BUDGET_EXCEPTION_REQUIRED') {
        // The budget moved since the queue was loaded: show the check as it is now (what was typed is kept).
        if (error.code === 'BUDGET_EXCEPTION_DECISION_REQUIRED') setAskException(true);
        void qc.invalidateQueries({ queryKey: keys.requisitionTasks });
      }
      // Decided, withdrawn or out of the role's reach meanwhile: nothing is left to decide here.
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t, refusalText(error, 'decide') ?? error.message, false);
      // The requisition changed while the decision was recorded (nothing was): reload it, as the refusal says.
      else if (error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.requisitionTasks });
    },
  });
  const busy = decide.isPending;

  const send = (decision: RequisitionDecisionBody['decision']) => {
    if (!permitted || busy || !r) return;
    const text = reason.trim();
    if (decision !== 'APPROVE' && !text) {
      setProblem(decision === 'RETURN' ? 'Enter a reason to return the requisition for changes.' : 'Enter a reason to reject the requisition.');
      decide.reset();
      return;
    }
    setProblem(null);
    const exception = decision === 'APPROVE' && showException && exceptionApproved;
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text && last.exception === exception ? last.key : idempotencyKey('hiring-requisition');
    attempt.current = { decision, reason: text, exception, key };
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}), ...(exception ? { approveBudgetException: true as const } : {}) });
  };

  const titleId = `${id}-title`;
  return (
    <li aria-labelledby={titleId}>
      <CardSubheading id={titleId}>{r ? `${r.code}: ${r.title}` : 'Requisition'}</CardSubheading>
      <DelegatedBadge taskId={t.taskId} />
      <Hint className="m-0">
        {stepText(t.step, t.stepAction)} · assigned <When at={t.assignedAt} />
      </Hint>
      {r ? (
        <>
          <RequisitionFacts r={r} />
          {r.budgetCheck && <BudgetCheckText check={r.budgetCheck} state={r.state} exceptionReason={r.budgetExceptionReason} />}
          {r.budgetExceptionReason && <p className="m-0">Budget exception reason: {r.budgetExceptionReason}</p>}
          <div>
            <Link to={PATHS.requisition(r.id)}>Open {r.code}</Link>
          </div>
        </>
      ) : (
        <Empty>This requisition is not available in the selected role’s scope.</Empty>
      )}
      {r &&
        (permitted ? (
          <>
            <FormField>
              Decision reason (required to return or reject)
              <Textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
            </FormField>
            {showException && (
              <CheckField>
                <input type="checkbox" checked={exceptionApproved} onChange={(e) => setExceptionApproved(e.target.checked)} /> Approve the budget exception
              </CheckField>
            )}
            {problem && <Notice notice={{ text: problem, ok: false }} />}
            <ButtonRow>
              <Button type="button" disabled={busy} onClick={() => send('APPROVE')}>
                {validating ? 'Validate' : 'Approve'}
              </Button>
              <Button type="button" variant="outline" disabled={busy} onClick={() => send('RETURN')}>
                Return for changes
              </Button>
              <Button type="button" variant="danger" disabled={busy} onClick={() => send('REJECT')}>
                Reject
              </Button>
            </ButtonRow>
            <Refusal error={decide.error} action="decide" />
          </>
        ) : (
          <Hint>The selected role cannot {validating ? 'validate requisitions' : 'approve requisition budgets and headcount'}.</Hint>
        ))}
    </li>
  );
}

