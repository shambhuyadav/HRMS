// The manpower budget revision decision queue (FR-011): an independent HR Administrator approves or rejects.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, idempotencyKey, isForbidden, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, ErrorNote, Item, Notice, NotPermitted, Section, When } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { Refusal, refusalText } from './refusals';
import { BUDGET_APPROVE, BUDGET_READ, type BudgetDecided, type BudgetTask, lineLabel, PATHS, periodText, shown, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Decision queue: manpower budget revisions (FR-011: an independent HR Administrator approves or rejects)
// ---------------------------------------------------------------------------------------------------------

export function BudgetDecisionQueue() {
  const { can } = useSession();
  return can(BUDGET_APPROVE) ? <BudgetQueue /> : null;
}

function BudgetQueue() {
  const keys = useKeys();
  const qc = useQueryClient();
  const region = useRef<HTMLDivElement>(null);
  const tasks = useQuery({ queryKey: keys.budgetTasks, queryFn: () => api<{ items: BudgetTask[] }>('/v1/hiring/budget-tasks'), retry: retryTransient });
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => !gone.has(t.taskId));
  const finished = (t: BudgetTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.budgetTasks });
    void qc.invalidateQueries({ queryKey: keys.budgets });
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return (
    <div ref={region} role="region" aria-label="Manpower budget approvals" tabIndex={-1}>
      <Section title={`Manpower budget approvals${data ? ` (${items.length})` : ''}`}>
        <Hint>Budget revisions prepared by other HR users wait here. Approving puts the revision’s headcount in force; rejecting is final and needs a reason.</Hint>
        {tasks.isPending && <LoadingLine>Loading the revisions waiting for you…</LoadingLine>}
        {isForbidden(tasks.error) ? <NotPermitted>The selected role cannot decide manpower budgets.</NotPermitted> : <ErrorNote error={tasks.error} />}
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>No budget revisions are waiting for your decision.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Budget revisions waiting for your decision">
            {items.map((t) => (
              <BudgetTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

/** What a recorded decision did, in words; `revision` is the one the queue showed, when it showed one. */
function budgetDecidedText(subject: string, revision: BudgetTask['revision'], result: BudgetDecided): string {
  if (result.replayed) return `Your earlier decision on ${subject} had already been recorded, so nothing was applied twice.`;
  if (result.state !== 'APPROVED') return `Rejected ${subject}; the headcount in force is unchanged.`;
  return revision ? `Approved ${subject}: headcount ${revision.headcount} is now in force.` : `Approved ${subject}.`;
}

function BudgetTaskItem({ task: t, onFinished }: { task: BudgetTask; onFinished: (t: BudgetTask, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const id = useId();
  const v = t.revision;
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const attempt = useRef<{ decision: string; reason: string; key: string } | null>(null);
  const subject = v ? `revision ${v.revision} for ${lineLabel(v)}` : 'the revision';
  const decide = useMutation({
    mutationFn: (body: { decision: 'APPROVE' | 'REJECT'; reason?: string; idempotencyKey: string }) =>
      api<BudgetDecided>(`/v1/hiring/budget-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.current = null;
      onFinished(t, budgetDecidedText(subject, v, result), true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.current = null;
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t, refusalText(error, 'budget-decide') ?? error.message, false);
      // The revision changed while the decision was recorded (nothing was): reload it, as the refusal says.
      else if (error.code === 'STALE_VERSION') void qc.invalidateQueries({ queryKey: keys.budgetTasks });
    },
  });
  const busy = decide.isPending;
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (busy || !v) return;
    const text = reason.trim();
    if (decision === 'REJECT' && !text) {
      setProblem('Enter a reason to reject the revision.');
      decide.reset();
      return;
    }
    setProblem(null);
    const last = attempt.current;
    const key = last !== null && last.decision === decision && last.reason === text ? last.key : idempotencyKey('hiring-budget');
    attempt.current = { decision, reason: text, key };
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}) });
  };
  const titleId = `${id}-title`;
  return (
    <li aria-labelledby={titleId}>
      <CardSubheading id={titleId}>{v ? `Revision ${v.revision}: ${lineLabel(v)}` : 'Budget revision'}</CardSubheading>
      <DelegatedBadge taskId={t.taskId} />
      <Hint className="m-0">
        Assigned <When at={t.assignedAt} />
      </Hint>
      {v ? (
        <>
          <dl className="kv">
            <Item term="Period">{periodText(v)}</Item>
            <Item term="Proposed headcount">{v.headcount}</Item>
            <Item term="Headcount in force">{v.approvedHeadcount ?? 'None approved yet'}</Item>
            <Item term="Committed">{v.committed}</Item>
            <Item term="Reason">{v.reason}</Item>
            <Item term="Submitted">
              <When at={v.submittedAt} />
            </Item>
          </dl>
          {can(BUDGET_READ) && (
            <div>
              <Link to={PATHS.budget(v.id)}>Open the budget line</Link>
            </div>
          )}
          <FormField>
            Decision reason (required to reject)
            <Textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
          {problem && <Notice notice={{ text: problem, ok: false }} />}
          <ButtonRow>
            <Button type="button" disabled={busy} onClick={() => send('APPROVE')}>
              Approve
            </Button>
            <Button type="button" variant="danger" disabled={busy} onClick={() => send('REJECT')}>
              Reject
            </Button>
          </ButtonRow>
          <Refusal error={decide.error} action="budget-decide" />
        </>
      ) : (
        <Empty>This revision is not available in the selected role’s scope.</Empty>
      )}
    </li>
  );
}

