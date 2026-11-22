// Decision queues: run reviews and approvals, salary holds, salary stops and payroll input batches, and the task decision.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentPropsWithoutRef, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, Section } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { INPUT_SOURCE, type InputBatch, InputBatchView } from './inputs';
import { byPrefix, Missing, Note } from './pickers';
import { type Act, Problem } from './problems';
import {
  Fact,
  type Hold,
  HOLD_DECIDE,
  HOLD_KIND,
  HOLD_READ,
  INPUT_APPROVE,
  INPUT_READ,
  label,
  money,
  PATHS,
  RUN_APPROVE,
  RUN_READ_AMOUNT,
  RUN_REVIEW,
  RUN_STATE,
  type SalaryStop,
  Status,
  STOP_DECIDE,
  STOP_MODE,
  STOP_READ,
  TASK_STEP,
  useIntentKey,
  useKeys,
} from './shared';
import type { RunDecided, RunTask } from './types';

/** A queue's tasks, one card under another. */
const TASK_LIST = 'm-0 flex list-none flex-col gap-3 p-0';

/**
 * One task of a queue: a card inside the queue's card. It keeps the `card` marker class, so its notes and forms are drawn as a
 * card's own (a boxed hint, a form without a frame of its own), as they were before the move to shadcn/ui.
 */
function TaskCard(props: ComponentPropsWithoutRef<'li'>) {
  return <li className="card rounded-xl border border-border bg-card px-5 py-4 shadow-xs" {...props} />;
}

// =========================================================================================================
// Run decision queues (review, approval and covering approval)
// =========================================================================================================

function RunTaskQueue({ steps, permission, title }: { steps: readonly string[]; permission: string; title: string }) {
  const { can } = useSession();
  const keys = useKeys();
  const [notes, setNotes] = useState<{ id: string; text: string; nextRunId?: string }[]>([]);
  const tasks = useQuery({
    queryKey: keys.runTasks,
    queryFn: () => api<{ items: RunTask[] }>('/v1/payroll/runs/tasks/mine'),
    enabled: can(permission) && can(RUN_READ_AMOUNT),
    retry: retryTransient,
  });
  if (!can(permission)) return null;
  if (!can(RUN_READ_AMOUNT)) {
    return (
      <Section title={title}>
        <Hint>The selected role cannot list payroll run tasks: it needs the payroll run amounts.</Hint>
      </Section>
    );
  }
  const mine = (tasks.data?.items ?? []).filter((t) => steps.includes(t.step));
  return (
    <Section title={title}>
      {tasks.isPending && <LoadingLine>Loading your tasks…</LoadingLine>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <StatusNote key={n.id} tone="success" role="status">
          {n.text} {n.nextRunId && <Link to={PATHS.run(n.nextRunId)}>Open the new revision</Link>}
        </StatusNote>
      ))}
      {tasks.data && mine.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      {mine.length > 0 && (
        <ul className={TASK_LIST}>
          {mine.map((t) => (
            <RunTaskItem key={t.taskId} task={t} onFinished={(text, nextRunId) => setNotes((prev) => [...prev, { id: t.taskId, text, ...(nextRunId ? { nextRunId } : {}) }])} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function decidedText(task: RunTask, decision: 'APPROVE' | 'RETURN', r: RunDecided): string {
  const name = task.run ? `${task.run.periodCode} revision ${task.run.revision}` : 'The run';
  if (r.replayed) return `${name}: this decision had already been recorded; nothing was applied twice.`;
  if (decision === 'RETURN') return `${name} was returned${task.run ? `: revision ${task.run.revision + 1} is open as a draft` : ''}.`;
  if (task.step === 'REVIEW') return `${name} was reviewed and goes to an independent approver.`;
  if (r.state === 'APPROVED') return `${name} was approved and can be processed by someone independent of its creator and preparer.`;
  if (r.step === 'COVER') {
    return `${name}: your approval was recorded; ${r.coversRequired ?? 'some'} covering ${r.coversRequired === 1 ? 'approval is' : 'approvals are'} needed for deciders’ own records.`;
  }
  return `${name}: your approval was recorded.`;
}

/** The route of a run task's decision: each step has its own. */
function decisionPath(step: string): string {
  if (step === 'REVIEW') return 'review';
  return step === 'APPROVAL' ? 'approve' : 'cover';
}

function RunTaskItem({ task, onFinished }: { task: RunTask; onFinished: (text: string, nextRunId?: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const titleId = useId();
  const reasonId = useId();
  const intent = useIntentKey('payroll-run-decision');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const path = decisionPath(task.step);
  const decide = useMutation({
    mutationFn: (body: { decision: 'APPROVE' | 'RETURN'; idempotencyKey: string; reason?: string }) =>
      api<RunDecided>(`/v1/payroll/run-tasks/${encodeURIComponent(task.taskId)}/${path}`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      if (!error || error instanceof ApiError) void Promise.all([qc.invalidateQueries({ queryKey: keys.runTasks }), qc.invalidateQueries({ queryKey: keys.runAll }), qc.invalidateQueries({ queryKey: keys.runsAll })]);
    },
    onSuccess: (r, body) => onFinished(decidedText(task, body.decision, r), body.decision === 'RETURN' ? r.nextRunId : undefined),
  });
  const send = (decision: 'APPROVE' | 'RETURN') => {
    if (decide.isPending) return;
    const text = reason.trim();
    if (decision === 'RETURN' && !text) {
      setProblem('Give the reason for returning the run.');
      return;
    }
    setProblem(null);
    decide.reset();
    const key = intent.key(`${decision}|${text}`);
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}) });
  };
  const name = task.run ? `${task.run.periodCode} revision ${task.run.revision}` : 'Payroll run';
  return (
    <TaskCard aria-labelledby={titleId}>
      <CardSubheading id={titleId}>{`${label(TASK_STEP, task.step)}: ${name}`}</CardSubheading>
      <DelegatedBadge taskId={task.taskId} />
      {task.run ? (
        <p className="my-1">
          <Status map={RUN_STATE} code={task.run.state} /> <Link to={PATHS.run(task.run.id)}>Open the run (totals, members and exceptions)</Link>
        </p>
      ) : (
        <Hint>The run is not available in the selected role’s scope.</Hint>
      )}
      {task.step === 'COVER' && <Hint>Covering approval: a decider’s own record in this run needs a further, independent approver.</Hint>}
      <FormField htmlFor={reasonId}>
        Reason (needed to return)
        <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
      </FormField>
      <ButtonRow className="mt-2">
        <Button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')}>
          Approve
        </Button>
        <Button type="button" variant="outline" disabled={decide.isPending} onClick={() => send('RETURN')}>
          Return to a new revision
        </Button>
      </ButtonRow>
      <Missing text={problem} />
      <Problem error={decide.error} act="run-decision" />
    </TaskCard>
  );
}

export function RunReviewQueue() {
  return <RunTaskQueue steps={['REVIEW']} permission={RUN_REVIEW} title="Payroll run reviews" />;
}
export function RunApprovalQueue() {
  return <RunTaskQueue steps={['APPROVAL', 'COVER']} permission={RUN_APPROVE} title="Payroll run approvals" />;
}

/** The note after a decision of a hold, stop or input task: its outcome, or that the same decision had already been recorded. */
function decidedNote(name: string, replayed: boolean, outcome: string): string {
  return replayed ? `${name}: this decision had already been recorded; nothing was applied twice.` : `${name}: ${outcome}.`;
}

/** A task decision (approve or reject) with its idempotency key per intended decision; the reason is needed to reject. */
function TaskDecision({
  path,
  prefix,
  act,
  name,
  confirmMode,
  onDecided,
  onRefused,
}: {
  path: string;
  prefix: string;
  act: Act;
  name: string;
  confirmMode?: string;
  onDecided: (decision: 'APPROVE' | 'REJECT', result: { state: string; replayed: boolean }) => void;
  /** After a definite refusal (decided elsewhere, stale, out of scope) the queue is reloaded. */
  onRefused?: () => void;
}) {
  const reasonId = useId();
  const intent = useIntentKey(prefix);
  const [reason, setReason] = useState('');
  const [modeConfirmed, setModeConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<{ state: string; replayed: boolean }>(path, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      if (error instanceof ApiError) onRefused?.();
    },
    onSuccess: (r, body) => onDecided(body.decision as 'APPROVE' | 'REJECT', r),
  });
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (decide.isPending) return;
    const text = reason.trim();
    if (decision === 'REJECT' && !text) return setProblem('Give the reason for rejecting.');
    if (decision === 'APPROVE' && confirmMode && !modeConfirmed) return setProblem('Confirm the stop mode you approve.');
    setProblem(null);
    decide.reset();
    const mode = decision === 'APPROVE' && confirmMode ? confirmMode : undefined;
    const key = intent.key(`${decision}|${text}|${mode ?? ''}`);
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}), ...(mode ? { confirmMode: mode } : {}) });
  };
  return (
    <div className="mt-2 flex flex-col gap-3">
      {confirmMode && (
        <CheckField>
          <input type="checkbox" checked={modeConfirmed} onChange={(e) => setModeConfirmed(e.target.checked)} /> {`I approve the mode: ${label(STOP_MODE, confirmMode)}`}
        </CheckField>
      )}
      <FormField htmlFor={reasonId}>
        Reason (needed to reject)
        <Textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
      </FormField>
      <ButtonRow>
        <Button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')} aria-label={`Approve ${name}`}>
          Approve
        </Button>
        <Button type="button" variant="outline" disabled={decide.isPending} onClick={() => send('REJECT')} aria-label={`Reject ${name}`}>
          Reject
        </Button>
      </ButtonRow>
      <Missing text={problem} />
      <Problem error={decide.error} act={act} />
    </div>
  );
}

export function HoldDecisionQueue() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  const tasks = useQuery({
    queryKey: keys.holdTasks,
    queryFn: () => api<{ items: { taskId: string; hold: Hold | null }[] }>('/v1/payroll/holds/tasks/mine'),
    enabled: can(HOLD_DECIDE) && can(HOLD_READ),
    retry: retryTransient,
  });
  if (!can(HOLD_DECIDE)) return null;
  if (!can(HOLD_READ)) {
    return (
      <Section title="Salary holds to decide">
        <Hint>The selected role cannot list salary holds.</Hint>
      </Section>
    );
  }
  const refresh = () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-hold') });
  return (
    <Section title="Salary holds to decide">
      {tasks.isPending && <LoadingLine>Loading your tasks…</LoadingLine>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <Notice key={n.id} notice={{ text: n.text, ok: true }} />
      ))}
      {tasks.data && tasks.data.items.length === 0 && <Empty>No salary hold is waiting for you.</Empty>}
      {tasks.data && tasks.data.items.length > 0 && (
        <ul className={TASK_LIST}>
          {tasks.data.items.map(({ taskId, hold: h }) => {
            const name = h ? `${label(HOLD_KIND, h.holdKind)} of ${h.employeeCode} for ${h.periodCode}` : 'Salary hold';
            return (
              <TaskCard key={taskId} aria-label={name}>
                <CardSubheading>{name}</CardSubheading>
                <DelegatedBadge taskId={taskId} />
                {h ? (
                  <dl className="kv">
                    <Fact term="Scope">{h.scope === 'PARTIAL' ? `Partial: ${money(h.holdAmount, h.currencyCode)}` : 'Full net pay'}</Fact>
                    {h.criterionCode && <Fact term="Criterion">{h.criterionCode}</Fact>}
                    {h.reason && <Fact term="Reason">{h.reason}</Fact>}
                    <Fact term="Review due">{formatDate(h.reviewDueOn)}</Fact>
                    {h.releaseCriterion && <Fact term="Release criterion">{h.releaseCriterion}</Fact>}
                  </dl>
                ) : (
                  <Hint>The hold is not available in the selected role’s scope.</Hint>
                )}
                {h !== null && h.proposedBy === me?.userId ? (
                  <Hint>You proposed this hold, so someone else decides it.</Hint>
                ) : (
                  <TaskDecision
                    path={`/v1/payroll/hold-tasks/${encodeURIComponent(taskId)}/decision`}
                    prefix="payroll-hold-decision"
                    act="hold-decide"
                    name={name}
                    onRefused={() => void refresh()}
                    onDecided={(decision, r) => {
                      const outcome = decision === 'APPROVE' ? 'approved; the payment is withheld' : 'rejected; nothing is withheld';
                      setNotes((prev) => [...prev, { id: taskId, text: decidedNote(name, r.replayed, outcome) }]);
                      void refresh();
                    }}
                  />
                )}
              </TaskCard>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export function StopDecisionQueue() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  const tasks = useQuery({
    queryKey: keys.stopTasks,
    queryFn: () => api<{ items: { taskId: string; stop: SalaryStop | null }[] }>('/v1/payroll/salary-stops/tasks/mine'),
    enabled: can(STOP_DECIDE) && can(STOP_READ),
    retry: retryTransient,
  });
  if (!can(STOP_DECIDE)) return null;
  if (!can(STOP_READ)) {
    return (
      <Section title="Salary stops to decide">
        <Hint>The selected role cannot list salary stops.</Hint>
      </Section>
    );
  }
  const refresh = () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-stop') });
  return (
    <Section title="Salary stops to decide">
      {tasks.isPending && <LoadingLine>Loading your tasks…</LoadingLine>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <Notice key={n.id} notice={{ text: n.text, ok: true }} />
      ))}
      {tasks.data && tasks.data.items.length === 0 && <Empty>No salary stop is waiting for you.</Empty>}
      {tasks.data && tasks.data.items.length > 0 && (
        <ul className={TASK_LIST}>
          {tasks.data.items.map(({ taskId, stop: s }) => {
            const name = s ? `Salary stop of ${s.employeeCode} for ${s.periodCode}` : 'Salary stop';
            return (
              <TaskCard key={taskId} aria-label={name}>
                <CardSubheading>{name}</CardSubheading>
                <DelegatedBadge taskId={taskId} />
                {s ? (
                  <dl className="kv">
                    <Fact term="Mode">{label(STOP_MODE, s.mode)}</Fact>
                    {s.criterionCode && <Fact term="Criterion">{s.criterionCode}</Fact>}
                    <Fact term="Reason">{s.reason}</Fact>
                    {s.releaseCriterion && <Fact term="Release criterion">{s.releaseCriterion}</Fact>}
                    {s.evidenceReference && <Fact term="Evidence">{s.evidenceReference}</Fact>}
                  </dl>
                ) : (
                  <Hint>The salary stop is not available in the selected role’s scope.</Hint>
                )}
                {s && s.proposedBy === me?.userId ? (
                  <Hint>You proposed this salary stop, so someone else decides it.</Hint>
                ) : (
                  <TaskDecision
                    path={`/v1/payroll/stop-tasks/${encodeURIComponent(taskId)}/decision`}
                    prefix="payroll-stop-decision"
                    act="hold-decide"
                    name={name}
                    onRefused={() => void refresh()}
                    {...(s ? { confirmMode: s.mode } : {})}
                    onDecided={(decision, r) => {
                      setNotes((prev) => [...prev, { id: taskId, text: decidedNote(name, r.replayed, decision === 'APPROVE' ? 'approved' : 'rejected') }]);
                      void refresh();
                    }}
                  />
                )}
              </TaskCard>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

export function InputDecisionQueue() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [notes, setNotes] = useState<{ id: string; text: string }[]>([]);
  const [shown, setShown] = useState<string | null>(null);
  const tasks = useQuery({
    queryKey: keys.inputTasks,
    queryFn: () => api<{ items: { taskId: string; batch: InputBatch | null }[] }>('/v1/payroll/input-batches/tasks/mine'),
    enabled: can(INPUT_APPROVE) && can(INPUT_READ),
    retry: retryTransient,
  });
  if (!can(INPUT_APPROVE)) return null;
  if (!can(INPUT_READ)) {
    return (
      <Section title="Payroll inputs to approve">
        <Hint>The selected role cannot list payroll input batches.</Hint>
      </Section>
    );
  }
  const refresh = () => qc.invalidateQueries(byPrefix('payroll-input'));
  return (
    <Section title="Payroll inputs to approve">
      <Hint>An approved batch is used by the next calculation of its period; a rejected one is never used.</Hint>
      {tasks.isPending && <LoadingLine>Loading your tasks…</LoadingLine>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <Note key={n.id} text={n.text} />
      ))}
      {tasks.data && tasks.data.items.length === 0 && <Empty>No input batch is waiting for you.</Empty>}
      {tasks.data && tasks.data.items.length > 0 && (
        <ul className={TASK_LIST}>
          {tasks.data.items.map(({ taskId, batch: b }) => {
            const name = b ? `Input batch of ${b.periodCode} with ${b.lineCount} ${b.lineCount === 1 ? 'line' : 'lines'}` : 'Input batch';
            return (
              <TaskCard key={taskId} aria-label={name}>
                <CardSubheading>{name}</CardSubheading>
                <DelegatedBadge taskId={taskId} />
                {b ? (
                  <>
                    <dl className="kv">
                      <Fact term="Source">{label(INPUT_SOURCE, b.source)}</Fact>
                      <Fact term="Submitted">{formatDate(b.submittedAt)}</Fact>
                    </dl>
                    <Button type="button" variant="outline" size="sm" onClick={() => setShown(shown === b.id ? null : b.id)} aria-label={`${shown === b.id ? 'Hide' : 'Show'} the lines of ${name}`}>
                      {shown === b.id ? 'Hide the lines' : 'Show the lines'}
                    </Button>
                    {shown === b.id && <InputBatchView id={b.id} withActions={false} />}
                  </>
                ) : (
                  <Hint>The batch is not available in the selected role’s scope.</Hint>
                )}
                {b !== null && b.preparedBy === me?.userId ? (
                  <Hint>You prepared this batch, so someone else decides it.</Hint>
                ) : (
                  <TaskDecision
                    path={`/v1/payroll/input-tasks/${encodeURIComponent(taskId)}/decision`}
                    prefix="payroll-input-decision"
                    act="input-decide"
                    name={name}
                    onRefused={() => void refresh()}
                    onDecided={(decision, r) => {
                      const outcome = decision === 'APPROVE' ? 'approved; the next calculation of the period uses these inputs' : 'rejected; none of its inputs is used';
                      setNotes((prev) => [...prev, { id: taskId, text: decidedNote(name, r.replayed, outcome) }]);
                      void refresh();
                    }}
                  />
                )}
              </TaskCard>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
