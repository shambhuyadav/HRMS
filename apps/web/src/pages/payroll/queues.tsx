// Decision queues: run reviews and approvals, salary holds, salary stops and payroll input batches, and the task decision.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { INPUT_SOURCE, type InputBatch, InputBatchView } from './inputs';
import { byPrefix, Note } from './pickers';
import { type Act, Problem } from './problems';
import { Fact, FLUSH, H3, type Hold, HOLD_DECIDE, HOLD_KIND, HOLD_READ, INPUT_APPROVE, INPUT_READ, label, money, PATHS, PLAIN_LIST, RUN_APPROVE, RUN_READ_AMOUNT, RUN_REVIEW, RUN_STATE, type SalaryStop, Status, STOP_DECIDE, STOP_MODE, STOP_READ, TASK_STEP, TEXTAREA, useIntentKey, useKeys } from './shared';
import type { RunDecided, RunTask } from './types';

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
        <p className="hint">The selected role cannot list payroll run tasks: it needs the payroll run amounts.</p>
      </Section>
    );
  }
  const mine = (tasks.data?.items ?? []).filter((t) => steps.includes(t.step));
  return (
    <Section title={title}>
      {tasks.isPending && <p className="hint loading">Loading your tasks…</p>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <p key={n.id} role="status" className="ok">
          {n.text} {n.nextRunId && <Link to={PATHS.run(n.nextRunId)}>Open the new revision</Link>}
        </p>
      ))}
      {tasks.data && mine.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      {mine.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
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

function RunTaskItem({ task, onFinished }: { task: RunTask; onFinished: (text: string, nextRunId?: string) => void }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const titleId = useId();
  const reasonId = useId();
  const intent = useIntentKey('payroll-run-decision');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const path = task.step === 'REVIEW' ? 'review' : task.step === 'APPROVAL' ? 'approve' : 'cover';
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
    <li aria-labelledby={titleId} className="card">
      <h3 id={titleId} style={H3}>
        {`${label(TASK_STEP, task.step)}: ${name}`}
      </h3>
      <DelegatedBadge taskId={task.taskId} />
      {task.run ? (
        <p style={FLUSH}>
          <Status map={RUN_STATE} code={task.run.state} /> <Link to={PATHS.run(task.run.id)}>Open the run (totals, members and exceptions)</Link>
        </p>
      ) : (
        <p className="hint">The run is not available in the selected role’s scope.</p>
      )}
      {task.step === 'COVER' && <p className="hint">Covering approval: a decider’s own record in this run needs a further, independent approver.</p>}
      <label htmlFor={reasonId}>
        Reason (needed to return)
        <textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <div className="row" style={{ marginTop: '0.5rem' }}>
        <button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')}>
          Approve
        </button>
        <button type="button" className="secondary" disabled={decide.isPending} onClick={() => send('RETURN')}>
          Return to a new revision
        </button>
      </div>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <Problem error={decide.error} act="run-decision" />
    </li>
  );
}

export function RunReviewQueue() {
  return <RunTaskQueue steps={['REVIEW']} permission={RUN_REVIEW} title="Payroll run reviews" />;
}
export function RunApprovalQueue() {
  return <RunTaskQueue steps={['APPROVAL', 'COVER']} permission={RUN_APPROVE} title="Payroll run approvals" />;
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
    <div className="stack" style={{ marginTop: '0.5rem' }}>
      {confirmMode && (
        <label className="check">
          <input type="checkbox" checked={modeConfirmed} onChange={(e) => setModeConfirmed(e.target.checked)} /> {`I approve the mode: ${label(STOP_MODE, confirmMode)}`}
        </label>
      )}
      <label htmlFor={reasonId}>
        Reason (needed to reject)
        <textarea id={reasonId} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <div className="row">
        <button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')} aria-label={`Approve ${name}`}>
          Approve
        </button>
        <button type="button" className="secondary" disabled={decide.isPending} onClick={() => send('REJECT')} aria-label={`Reject ${name}`}>
          Reject
        </button>
      </div>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
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
        <p className="hint">The selected role cannot list salary holds.</p>
      </Section>
    );
  }
  const refresh = () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-hold') });
  return (
    <Section title="Salary holds to decide">
      {tasks.isPending && <p className="hint loading">Loading your tasks…</p>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <p key={n.id} role="status" className="ok">
          {n.text}
        </p>
      ))}
      {tasks.data && tasks.data.items.length === 0 && <Empty>No salary hold is waiting for you.</Empty>}
      {tasks.data && tasks.data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {tasks.data.items.map(({ taskId, hold: h }) => {
            const name = h ? `${label(HOLD_KIND, h.holdKind)} of ${h.employeeCode} for ${h.periodCode}` : 'Salary hold';
            return (
              <li key={taskId} aria-label={name} className="card">
                <h3 style={H3}>{name}</h3>
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
                  <p className="hint">The hold is not available in the selected role’s scope.</p>
                )}
                {h !== null && h.proposedBy === me?.userId ? (
                  <p className="hint">You proposed this hold, so someone else decides it.</p>
                ) : (
                  <TaskDecision
                    path={`/v1/payroll/hold-tasks/${encodeURIComponent(taskId)}/decision`}
                    prefix="payroll-hold-decision"
                    act="hold-decide"
                    name={name}
                    onRefused={() => void refresh()}
                    onDecided={(decision, r) => {
                      setNotes((prev) => [
                        ...prev,
                        { id: taskId, text: r.replayed ? `${name}: this decision had already been recorded; nothing was applied twice.` : `${name}: ${decision === 'APPROVE' ? 'approved; the payment is withheld' : 'rejected; nothing is withheld'}.` },
                      ]);
                      void refresh();
                    }}
                  />
                )}
              </li>
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
        <p className="hint">The selected role cannot list salary stops.</p>
      </Section>
    );
  }
  const refresh = () => qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === 'string' && q.queryKey[0].startsWith('payroll-stop') });
  return (
    <Section title="Salary stops to decide">
      {tasks.isPending && <p className="hint loading">Loading your tasks…</p>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <p key={n.id} role="status" className="ok">
          {n.text}
        </p>
      ))}
      {tasks.data && tasks.data.items.length === 0 && <Empty>No salary stop is waiting for you.</Empty>}
      {tasks.data && tasks.data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {tasks.data.items.map(({ taskId, stop: s }) => {
            const name = s ? `Salary stop of ${s.employeeCode} for ${s.periodCode}` : 'Salary stop';
            return (
              <li key={taskId} aria-label={name} className="card">
                <h3 style={H3}>{name}</h3>
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
                  <p className="hint">The salary stop is not available in the selected role’s scope.</p>
                )}
                {s && s.proposedBy === me?.userId ? (
                  <p className="hint">You proposed this salary stop, so someone else decides it.</p>
                ) : (
                  <TaskDecision
                    path={`/v1/payroll/stop-tasks/${encodeURIComponent(taskId)}/decision`}
                    prefix="payroll-stop-decision"
                    act="hold-decide"
                    name={name}
                    onRefused={() => void refresh()}
                    {...(s ? { confirmMode: s.mode } : {})}
                    onDecided={(decision, r) => {
                      setNotes((prev) => [
                        ...prev,
                        { id: taskId, text: r.replayed ? `${name}: this decision had already been recorded; nothing was applied twice.` : `${name}: ${decision === 'APPROVE' ? 'approved' : 'rejected'}.` },
                      ]);
                      void refresh();
                    }}
                  />
                )}
              </li>
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
        <p className="hint">The selected role cannot list payroll input batches.</p>
      </Section>
    );
  }
  const refresh = () => qc.invalidateQueries(byPrefix('payroll-input'));
  return (
    <Section title="Payroll inputs to approve">
      <p className="hint">An approved batch is used by the next calculation of its period; a rejected one is never used.</p>
      {tasks.isPending && <p className="hint loading">Loading your tasks…</p>}
      {tasks.error && <Problem error={tasks.error} act="read" />}
      {notes.map((n) => (
        <Note key={n.id} text={n.text} />
      ))}
      {tasks.data && tasks.data.items.length === 0 && <Empty>No input batch is waiting for you.</Empty>}
      {tasks.data && tasks.data.items.length > 0 && (
        <ul style={PLAIN_LIST} className="stack">
          {tasks.data.items.map(({ taskId, batch: b }) => {
            const name = b ? `Input batch of ${b.periodCode} with ${b.lineCount} ${b.lineCount === 1 ? 'line' : 'lines'}` : 'Input batch';
            return (
              <li key={taskId} aria-label={name} className="card">
                <h3 style={H3}>{name}</h3>
                <DelegatedBadge taskId={taskId} />
                {b ? (
                  <>
                    <dl className="kv">
                      <Fact term="Source">{label(INPUT_SOURCE, b.source)}</Fact>
                      <Fact term="Submitted">{formatDate(b.submittedAt)}</Fact>
                    </dl>
                    <button type="button" className="link" onClick={() => setShown(shown === b.id ? null : b.id)} aria-label={`${shown === b.id ? 'Hide' : 'Show'} the lines of ${name}`}>
                      {shown === b.id ? 'Hide the lines' : 'Show the lines'}
                    </button>
                    {shown === b.id && <InputBatchView id={b.id} withActions={false} />}
                  </>
                ) : (
                  <p className="hint">The batch is not available in the selected role’s scope.</p>
                )}
                {b !== null && b.preparedBy === me?.userId ? (
                  <p className="hint">You prepared this batch, so someone else decides it.</p>
                ) : (
                  <TaskDecision
                    path={`/v1/payroll/input-tasks/${encodeURIComponent(taskId)}/decision`}
                    prefix="payroll-input-decision"
                    act="input-decide"
                    name={name}
                    onRefused={() => void refresh()}
                    onDecided={(decision, r) => {
                      setNotes((prev) => [
                        ...prev,
                        {
                          id: taskId,
                          text: r.replayed
                            ? `${name}: this decision had already been recorded; nothing was applied twice.`
                            : `${name}: ${decision === 'APPROVE' ? 'approved; the next calculation of the period uses these inputs' : 'rejected; none of its inputs is used'}.`,
                        },
                      ]);
                      void refresh();
                    }}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}
