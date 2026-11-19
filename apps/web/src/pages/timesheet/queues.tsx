// Decision queues: the manager's timesheet approvals and the independent reopen decisions.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Item, Notice, NotPermitted, Section, When } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { ReadProblem, Refusal, refusalText } from './refusals';
import { FLUSH, H3, hm, lateText, PATHS, Problem, shown, TEXTAREA, TS_APPROVE, TS_READ, TS_REOPEN, useAttemptKey, useKeys, weekText } from './shared';
import type { ReopenDecided, ReopenTask, TimesheetDecided, TimesheetTask } from './types';

// ---------------------------------------------------------------------------------------------------------
// Decision queues: the manager's timesheet approvals and the independent reopen decisions
// ---------------------------------------------------------------------------------------------------------
function useQueueState(key: readonly unknown[]) {
  const qc = useQueryClient();
  const keys = useKeys();
  const region = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);
  const finished = (taskId: string, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: keys.sheets });
    const active = document.activeElement;
    if (!active || active === document.body || region.current?.contains(active)) region.current?.focus();
  };
  return { region, gone, notice, finished };
}

export function ApprovalsScreen() {
  return <TimesheetDecisionQueue />;
}

/** The direct manager's (or HR fallback reviewer's) open timesheet tasks: approve, return or reject. */
export function TimesheetDecisionQueue() {
  const { can } = useSession();
  const keys = useKeys();
  const tasks = useQuery({ queryKey: keys.tasks, queryFn: () => api<{ items: TimesheetTask[] }>('/v1/timesheet-tasks'), enabled: can(TS_APPROVE), retry: retryTransient });
  const { region, gone, notice, finished } = useQueueState(keys.tasks);
  if (!can(TS_APPROVE)) return <NotPermitted>The selected role cannot decide timesheets.</NotPermitted>;
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => !gone.has(t.taskId));
  return (
    <div ref={region} role="region" aria-label="Timesheet approvals" tabIndex={-1}>
      <Section title={`Timesheet approvals${data ? ` (${items.length})` : ''}`}>
        <p className="hint">Approve, return for changes or reject each submitted week. Returning or rejecting needs a reason the employee sees; the employee then continues in a new revision.</p>
        {tasks.isPending && <p className="hint loading">Loading the timesheets waiting for you…</p>}
        <ReadProblem error={tasks.error} what="timesheet tasks" />
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>No timesheets are waiting for your decision.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Timesheets waiting for your decision">
            {items.map((t) => (
              <TimesheetTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function decidedText(who: string, result: TimesheetDecided): string {
  if (result.replayed) return `Your earlier decision on the timesheet of ${who} had already been recorded, so nothing was applied twice.`;
  if (result.state === 'APPROVED') return `Approved revision ${result.revision} of the timesheet of ${who}.`;
  if (result.state === 'RETURNED') return `Returned the timesheet of ${who} for changes.`;
  if (result.state === 'REJECTED') return `Rejected revision ${result.revision} of the timesheet of ${who}.`;
  return `The timesheet of ${who} is now ${readable(result.state).toLowerCase()}.`;
}

function TimesheetTaskItem({ task: t, onFinished }: { task: TimesheetTask; onFinished: (taskId: string, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  // The queue needs only the approve key; the timesheet screen behind the link needs the read key as well.
  const canRead = can(TS_READ);
  const id = useId();
  const s = t.timesheet;
  const attempt = useAttemptKey('timesheet-decision');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const who = s ? `${s.employeeName} (${s.employeeCode}) for ${weekText(s)}` : 'the employee';
  const decide = useMutation({
    mutationFn: (body: { decision: string; reason?: string; idempotencyKey: string }) => api<TimesheetDecided>(`/v1/timesheet-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.clear();
      onFinished(t.taskId, decidedText(who, result), true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.clear();
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t.taskId, refusalText(error, 'decide') ?? error.message, false);
    },
  });
  const busy = decide.isPending;
  const send = (decision: 'APPROVE' | 'RETURN' | 'REJECT') => {
    if (busy || !s) return;
    const text = reason.trim();
    if (decision !== 'APPROVE' && !text) {
      setProblem(decision === 'RETURN' ? 'Enter a reason to return the timesheet for changes.' : 'Enter a reason to reject the timesheet.');
      decide.reset();
      return;
    }
    setProblem(null);
    const key = attempt.keyFor(`${decision}|${text}`);
    decide.mutate({ decision, idempotencyKey: key, ...(text ? { reason: text } : {}) });
  };
  return (
    <li aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} style={H3}>
        {s ? `${s.employeeName} (${s.employeeCode}): ${weekText(s)}` : 'Timesheet'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <p className="hint" style={FLUSH}>
        Assigned <When at={t.assignedAt} />
      </p>
      {s ? (
        <>
          <dl className="kv">
            <Item term="Revision">{s.currentRevision}</Item>
            <Item term="Time">{hm(s.totalMinutes)}</Item>
            <Item term="Due">{formatDate(s.dueDate)}</Item>
            <Item term="Submission">{s.revisionLate === true ? <Badge tone="warn">submitted late</Badge> : lateText(s.revisionLate)}</Item>
          </dl>
          {canRead && (
            <div>
              <Link to={PATHS.timesheet(s.id)}>Open the lines of {s.employeeName}’s week</Link>
            </div>
          )}
          <label>
            Decision reason (required to return or reject)
            <textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          <Problem text={problem} />
          <div className="row">
            <button type="button" disabled={busy} onClick={() => send('APPROVE')}>
              Approve
            </button>
            <button type="button" className="secondary" disabled={busy} onClick={() => send('RETURN')}>
              Return for changes
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => send('REJECT')}>
              Reject
            </button>
          </div>
          <Refusal error={decide.error} act="decide" />
        </>
      ) : (
        <Empty>This timesheet is not available in the selected role’s scope.</Empty>
      )}
    </li>
  );
}

export function ReopenScreen() {
  return <ReopenDecisionQueue />;
}

/** F1: the independent HR reviewer's open reopen requests (never the requester, the employee or an earlier decider). */
export function ReopenDecisionQueue() {
  const { can } = useSession();
  const keys = useKeys();
  const tasks = useQuery({ queryKey: keys.reopenTasks, queryFn: () => api<{ items: ReopenTask[] }>('/v1/timesheet-reopen-tasks'), enabled: can(TS_REOPEN), retry: retryTransient });
  const { region, gone, notice, finished } = useQueueState(keys.reopenTasks);
  if (!can(TS_REOPEN)) return <NotPermitted>The selected role cannot decide timesheet reopen requests.</NotPermitted>;
  const data = shown(tasks);
  const items = (data?.items ?? []).filter((t) => !gone.has(t.taskId));
  return (
    <div ref={region} role="region" aria-label="Timesheet reopen requests" tabIndex={-1}>
      <Section title={`Timesheet reopen requests${data ? ` (${items.length})` : ''}`}>
        <p className="hint">Approving opens a correction as a new draft revision with the approved lines carried over; the approved revision stays in force until its correction is approved. Rejecting needs a reason.</p>
        {tasks.isPending && <p className="hint loading">Loading the reopen requests waiting for you…</p>}
        <ReadProblem error={tasks.error} what="reopen requests" />
        <Notice notice={notice} />
        {data && items.length === 0 && <Empty>No reopen requests are waiting for your decision.</Empty>}
        {items.length > 0 && (
          <ul className="tasks" aria-label="Reopen requests waiting for your decision">
            {items.map((t) => (
              <ReopenTaskItem key={t.taskId} task={t} onFinished={finished} />
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function ReopenTaskItem({ task: t, onFinished }: { task: ReopenTask; onFinished: (taskId: string, text: string, ok: boolean) => void }) {
  const { can } = useSession();
  // The queue needs only the reopen key; the timesheet screen behind the link needs the read key as well.
  const canRead = can(TS_READ);
  const id = useId();
  const r = t.request;
  const attempt = useAttemptKey('timesheet-reopen');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const who = r ? `${r.employeeName} (${r.employeeCode}) for ${weekText(r)}` : 'the employee';
  const decide = useMutation({
    mutationFn: (body: { decision: string; reason?: string; idempotencyKey: string }) => api<ReopenDecided>(`/v1/timesheet-reopen-tasks/${encodeURIComponent(t.taskId)}/decision`, { body }),
    onSuccess: (result) => {
      attempt.clear();
      const text = result.replayed
        ? `Your earlier decision on the reopen request of ${who} had already been recorded, so nothing was applied twice.`
        : result.state === 'APPROVED'
          ? `Reopened the timesheet of ${who}: revision ${result.newRevision ?? '—'} is open as a draft for the correction.`
          : `Rejected the reopen request of ${who}; the approved revision stays in force.`;
      onFinished(t.taskId, text, true);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.code === 'IDEMPOTENCY_KEY_REUSED') attempt.clear();
      else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t.taskId, refusalText(error, 'reopen-decide') ?? error.message, false);
    },
  });
  const busy = decide.isPending;
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (busy || !r) return;
    const text = reason.trim();
    if (decision === 'REJECT' && !text) {
      setProblem('Enter a reason to reject the reopen request.');
      decide.reset();
      return;
    }
    setProblem(null);
    decide.mutate({ decision, idempotencyKey: attempt.keyFor(`${decision}|${text}`), ...(text ? { reason: text } : {}) });
  };
  return (
    <li aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} style={H3}>
        {r ? `Reopen ${r.employeeName} (${r.employeeCode}): ${weekText(r)}` : 'Reopen request'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      <p className="hint" style={FLUSH}>
        Assigned <When at={t.assignedAt} />
      </p>
      {r ? (
        <>
          <dl className="kv">
            <Item term="Approved revision">{r.approvedRevision}</Item>
            <Item term="Requested">
              <When at={r.requestedAt} />
            </Item>
            <Item term="Reason given">{r.reason}</Item>
          </dl>
          {canRead && (
            <div>
              <Link to={PATHS.timesheet(r.timesheetId)}>Open the timesheet of {r.employeeName}</Link>
            </div>
          )}
          <label>
            Decision reason (required to reject)
            <textarea maxLength={1000} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} style={TEXTAREA} />
          </label>
          <Problem text={problem} />
          <div className="row">
            <button type="button" disabled={busy} onClick={() => send('APPROVE')}>
              Approve reopen
            </button>
            <button type="button" className="danger" disabled={busy} onClick={() => send('REJECT')}>
              Reject reopen
            </button>
          </div>
          <Refusal error={decide.error} act="reopen-decide" />
        </>
      ) : (
        <Empty>This reopen request is not available in the selected role’s scope.</Empty>
      )}
    </li>
  );
}
