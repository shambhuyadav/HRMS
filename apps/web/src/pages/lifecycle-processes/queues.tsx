// Decision queues: exit recommendation, approval and withdrawal decisions (F1) and the process task queue (FR-016).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDate, plural, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Item, LIST_PAGE_SIZE, Pager, Section, When } from '../../ui';
import { DelegatedBadge } from '../delegations';
import { TaskActions, TaskFacts } from './process-view';
import { type Act, type Done, Refusal, refusalText } from './refusals';
import { EXIT_APPROVE, EXIT_READ, EXIT_RECOMMEND, FLUSH, H3, ISO_DATE, Loading, Notice, type NoticeState, noticeText, type Paged, pagedUrl, PATHS, Problem, PROCESS_READ, QueryProblem, ReasonField, shown, TASK_COMPLETE, totalOf, useDecisionKey, useKeys } from './shared';
import type { ExitCase, ExitDecided, ExitDecisionBody, ExitDetail, ExitTask, MyTask, RecommendResult, WithdrawalDecided, WithdrawalDecisionBody } from './types';

// ---------------------------------------------------------------------------------------------------------
// Exit decision queues (F1): the manager's recommendation, then the independent HR decision; withdrawal requests.
// GET /v1/exit-cases/tasks/mine lists all three; each is decided with its step's own duty and an idempotency key.
// ---------------------------------------------------------------------------------------------------------
export type ExitQueueKind = 'recommend' | 'approve' | 'withdrawal';

const EXIT_QUEUES: Record<ExitQueueKind, { title: string; hint: string; empty: string; permission: string; matches: (t: ExitTask) => boolean }> = {
  recommend: {
    title: 'Resignation recommendations',
    hint: 'Recommend each resignation’s last working date; the date is inclusive. An independent HR Administrator then decides.',
    empty: 'No resignations are waiting for your recommendation.',
    permission: EXIT_RECOMMEND,
    matches: (t) => t.kind === 'exit_case' && t.step === 'recommend',
  },
  approve: {
    title: 'Resignation approvals',
    hint: 'Approve the recommended last working date or another one, or do not approve the resignation with a private reason and a message for the employee.',
    empty: 'No resignations are waiting for your decision.',
    permission: EXIT_APPROVE,
    matches: (t) => t.kind === 'exit_case' && t.step === 'approve',
  },
  withdrawal: {
    title: 'Resignation withdrawal requests',
    hint: 'An approved resignation is withdrawn only through an independent HR decision, with a reason; not approving also needs a message for the employee.',
    empty: 'No withdrawal requests are waiting for your decision.',
    permission: EXIT_APPROVE,
    matches: (t) => t.kind === 'exit_withdrawal',
  },
};

export function ExitRecommendationQueue() {
  const { can } = useSession();
  if (!can(EXIT_READ) || !can(EXIT_RECOMMEND)) return null;
  return <ExitQueue kind="recommend" />;
}

export function ExitApprovalQueue() {
  const { can } = useSession();
  if (!can(EXIT_READ) || !can(EXIT_APPROVE)) return null;
  return <ExitQueue kind="approve" />;
}

export function ExitWithdrawalQueue() {
  const { can } = useSession();
  if (!can(EXIT_READ) || !can(EXIT_APPROVE)) return null;
  return <ExitQueue kind="withdrawal" />;
}

function ExitQueue({ kind }: { kind: ExitQueueKind }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const queue = EXIT_QUEUES[kind];
  const tasks = useQuery({ queryKey: keys.exitTasks, queryFn: () => api<{ items: ExitTask[] }>('/v1/exit-cases/tasks/mine'), retry: retryTransient });
  /** Tasks the server answered for here: they leave the queue at once, before it has reloaded. */
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<NoticeState>(null);
  const data = shown(tasks);
  const items = (data?.items ?? []).filter(queue.matches).filter((t) => !gone.has(t.taskId));
  const finished = (t: ExitTask, text: string, ok: boolean) => {
    setGone((prev) => new Set(prev).add(t.taskId));
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.exits });
    void qc.invalidateQueries({ queryKey: keys.processes });
  };
  return (
    <Section title={`${queue.title}${data ? ` (${items.length})` : ''}`}>
      <p className="hint">{queue.hint}</p>
      {tasks.isPending && <Loading>Loading the resignations waiting for you…</Loading>}
      <QueryProblem error={tasks.error} forbidden="The selected role cannot view exit tasks." />
      <Notice notice={notice} />
      {data && items.length === 0 && <Empty>{queue.empty}</Empty>}
      {items.length > 0 && (
        <ul className="tasks" aria-label={queue.title}>
          {items.map((t) => (
            <ExitTaskItem key={t.taskId} task={t} kind={kind} onFinished={finished} />
          ))}
        </ul>
      )}
    </Section>
  );
}

type Finished = (t: ExitTask, text: string, ok: boolean) => void;

export function ExitTaskItem({ task: t, kind, onFinished, linkToExit = true }: { task: ExitTask; kind: ExitQueueKind; onFinished: Finished; linkToExit?: boolean }) {
  const { can } = useSession();
  const headingId = useId();
  const x = t.exitCase;
  const permitted = can(EXIT_QUEUES[kind].permission);
  return (
    <li aria-labelledby={headingId}>
      <h3 id={headingId} style={H3}>
        {x ? `${x.employeeName} (${x.employeeCode})` : 'Resignation'}
      </h3>
      <DelegatedBadge taskId={t.taskId} />
      {!x ? (
        <Empty>This resignation is not available in the selected role’s scope.</Empty>
      ) : (
        <>
          <p className="hint" style={FLUSH}>
            {kind === 'recommend' ? 'Recommendation of the last working date' : kind === 'approve' ? 'HR decision on the resignation' : 'Withdrawal of an approved resignation'}
          </p>
          <dl className="kv">
            <Item term="Resignation date">{formatDate(x.requestDate)}</Item>
            <Item term="Proposed last working date">{formatDate(x.proposedLastWorkingDate)}</Item>
            {kind !== 'recommend' && <Item term="Recommended last working date">{formatDate(x.recommendedLastWorkingDate)}</Item>}
            {kind === 'withdrawal' && <Item term="Approved last working date">{formatDate(x.approvedLastWorkingDate)}</Item>}
            <Item term="Contractual notice period">{noticeText(x.noticePeriod)}</Item>
            {x.reason !== undefined && x.reason !== null && <Item term="Employee’s reason">{x.reason}</Item>}
          </dl>
          {linkToExit && (
            <div>
              <Link to={PATHS.exit(x.id)}>Open the exit case</Link>
            </div>
          )}
          {!permitted ? (
            <p className="hint">The selected role cannot take this decision.</p>
          ) : kind === 'recommend' ? (
            <RecommendForm task={t} exit={x} onFinished={onFinished} />
          ) : kind === 'approve' ? (
            <ExitDecisionForm task={t} exit={x} onFinished={onFinished} />
          ) : (
            <WithdrawalDecisionForm task={t} exit={x} onFinished={onFinished} />
          )}
        </>
      )}
    </li>
  );
}

/** A refusal that leaves nothing to decide here (decided, withdrawn or out of reach meanwhile) closes the item. */
function finalRefusal(error: Error, t: ExitTask, action: Act, onFinished: Finished, decisionKey: { reset(): void }): void {
  if (!(error instanceof ApiError)) return;
  // The server took the key for another decision's and recorded nothing: the next attempt gets a new key.
  if (error.code === 'IDEMPOTENCY_KEY_REUSED') decisionKey.reset();
  else if (error.code === 'TASK_CLOSED' || error.code === 'INVALID_STATE' || error.status === 404) onFinished(t, refusalText(error, action) ?? error.message, false);
}

function RecommendForm({ task: t, exit: x, onFinished }: { task: ExitTask; exit: ExitCase; onFinished: Finished }) {
  const decisionKey = useDecisionKey('exit-recommend');
  const [date, setDate] = useState(x.proposedLastWorkingDate);
  const [problem, setProblem] = useState<string | null>(null);
  const name = `${x.employeeName} (${x.employeeCode})`;
  const recommend = useMutation({
    mutationFn: (body: { recommendedLastWorkingDate: string; idempotencyKey: string }) => api<RecommendResult>(`/v1/exit-cases/tasks/${t.taskId}/recommend`, { body }),
    onSuccess: (r, body) => {
      decisionKey.reset();
      onFinished(
        t,
        r.replayed
          ? `Your earlier recommendation for ${name} had already been recorded, so nothing was applied twice.`
          : `Recommended ${formatDate(r.recommendedLastWorkingDate ?? body.recommendedLastWorkingDate)} as the last working date of ${name}. The resignation now waits for the HR decision.`,
        true,
      );
    },
    onError: (error) => finalRefusal(error, t, 'recommend', onFinished, decisionKey),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (recommend.isPending) return;
    if (!ISO_DATE.test(date)) {
      setProblem('Enter the recommended last working date.');
      recommend.reset();
      return;
    }
    setProblem(null);
    recommend.mutate({ recommendedLastWorkingDate: date, idempotencyKey: decisionKey.next(date) });
  };
  return (
    <form aria-label={`Recommend the last working date of ${name}`} className="stack" onSubmit={submit}>
      <label>
        Recommended last working date (inclusive)
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={recommend.isPending}>
          Recommend this date
        </button>
      </div>
      <Refusal error={recommend.error} action="recommend" />
    </form>
  );
}

function exitDecidedText(name: string, r: ExitDecided): string {
  if (r.replayed) return `Your earlier decision on the resignation of ${name} had already been recorded, so nothing was applied twice.`;
  if (r.state === 'APPROVED') return `Approved the resignation of ${name}: the last working date is ${formatDate(r.approvedLastWorkingDate)} (inclusive).`;
  if (r.state === 'REJECTED') return `The resignation of ${name} was not approved; they will see your message.`;
  return `Your decision on the resignation of ${name} was recorded; it waits for the next step.`;
}

function ExitDecisionForm({ task: t, exit: x, onFinished }: { task: ExitTask; exit: ExitCase; onFinished: Finished }) {
  const decisionKey = useDecisionKey('exit-decision');
  const [date, setDate] = useState(x.recommendedLastWorkingDate ?? x.lastWorkingDate);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const name = `${x.employeeName} (${x.employeeCode})`;
  const decide = useMutation({
    mutationFn: (body: ExitDecisionBody) => api<ExitDecided>(`/v1/exit-cases/tasks/${t.taskId}/decision`, { body }),
    onSuccess: (r) => {
      decisionKey.reset();
      onFinished(t, exitDecidedText(name, r), true);
    },
    onError: (error) => finalRefusal(error, t, 'exit-decide', onFinished, decisionKey),
  });
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (decide.isPending) return;
    const why = reason.trim();
    const msg = message.trim();
    let issue: string | null = null;
    if (decision === 'REJECT' && (!why || !msg)) issue = 'To not approve the resignation, record the private reason and the message for the employee.';
    else if (decision === 'APPROVE' && date !== '' && !ISO_DATE.test(date)) issue = 'Enter a valid approved last working date, or leave it empty to approve the recommended date.';
    setProblem(issue);
    if (issue) {
      decide.reset();
      return;
    }
    const fields =
      decision === 'APPROVE'
        ? { decision, ...(date ? { approvedLastWorkingDate: date } : {}), ...(why ? { reason: why } : {}) }
        : { decision, reason: why, employeeMessage: msg };
    decide.mutate({ ...fields, idempotencyKey: decisionKey.next(JSON.stringify(fields)) } as ExitDecisionBody);
  };
  return (
    <div className="stack" role="group" aria-label={`Decide the resignation of ${name}`}>
      <label>
        Approved last working date (inclusive)
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <p className="hint" style={FLUSH}>
        Keep the recommended date ({formatDate(x.recommendedLastWorkingDate)}) or set another one, not before the resignation date or today.
      </p>
      <ReasonField label="Private reason (never shown to the employee; required to not approve)" value={reason} onChange={setReason} />
      <ReasonField label="Message to the employee (required to not approve)" value={message} onChange={setMessage} />
      <Problem text={problem} />
      <div className="row">
        <button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')}>
          Approve
        </button>
        <button type="button" className="danger" disabled={decide.isPending} onClick={() => send('REJECT')}>
          Do not approve
        </button>
      </div>
      <Refusal error={decide.error} action="exit-decide" />
    </div>
  );
}

function withdrawalDecidedText(name: string, r: WithdrawalDecided): string {
  if (r.replayed) return `Your earlier decision on the withdrawal request of ${name} had already been recorded, so nothing was applied twice.`;
  if (r.state === 'APPROVED') return `Approved the withdrawal: the resignation of ${name} is withdrawn.`;
  if (r.state === 'REJECTED') return `The withdrawal was not approved: the resignation of ${name} stands, and they will see your message.`;
  return `Your decision on the withdrawal request of ${name} was recorded; it waits for the next step.`;
}

function WithdrawalDecisionForm({ task: t, exit: x, onFinished }: { task: ExitTask; exit: ExitCase; onFinished: Finished }) {
  const keys = useKeys();
  const decisionKey = useDecisionKey('exit-withdrawal');
  // The request itself (when it was made and, for a granted caller, its reason) is on the exit case.
  const detail = useQuery({ queryKey: keys.exit(x.id), queryFn: () => api<ExitDetail>(`/v1/exit-cases/${x.id}`), retry: retryTransient });
  const pending = shown(detail)?.withdrawals.find((w) => w.state === 'SUBMITTED') ?? null;
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const name = `${x.employeeName} (${x.employeeCode})`;
  const decide = useMutation({
    mutationFn: (body: WithdrawalDecisionBody) => api<WithdrawalDecided>(`/v1/exit-withdrawals/tasks/${t.taskId}/decision`, { body }),
    onSuccess: (r) => {
      decisionKey.reset();
      onFinished(t, withdrawalDecidedText(name, r), true);
    },
    onError: (error) => finalRefusal(error, t, 'withdrawal-decide', onFinished, decisionKey),
  });
  const send = (decision: 'APPROVE' | 'REJECT') => {
    if (decide.isPending) return;
    const why = reason.trim();
    const msg = message.trim();
    let issue: string | null = null;
    if (!why) issue = 'Record the reason for your decision; it is never shown to the employee.';
    else if (decision === 'REJECT' && !msg) issue = 'To not approve the withdrawal, explain the decision to the employee.';
    setProblem(issue);
    if (issue) {
      decide.reset();
      return;
    }
    const fields = { decision, reason: why, ...(decision === 'REJECT' ? { employeeMessage: msg } : {}) };
    decide.mutate({ ...fields, idempotencyKey: decisionKey.next(JSON.stringify(fields)) });
  };
  return (
    <div className="stack" role="group" aria-label={`Decide the withdrawal request of ${name}`}>
      {pending ? (
        <p style={FLUSH}>
          Withdrawal requested <When at={pending.requestedAt} />
          {pending.reason !== undefined ? `. Reason: ${pending.reason}` : ''}
        </p>
      ) : (
        detail.isPending && <Loading>Loading the withdrawal request…</Loading>
      )}
      <ReasonField label="Reason for your decision (required; never shown to the employee)" value={reason} onChange={setReason} />
      <ReasonField label="Message to the employee (required to not approve)" value={message} onChange={setMessage} />
      <Problem text={problem} />
      <div className="row">
        <button type="button" disabled={decide.isPending} onClick={() => send('APPROVE')}>
          Approve the withdrawal
        </button>
        <button type="button" className="danger" disabled={decide.isPending} onClick={() => send('REJECT')}>
          Do not approve
        </button>
      </div>
      <Refusal error={decide.error} action="withdrawal-decide" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Process task queue (FR-016): open tasks the caller's user or role owns, in scope, in open processes.
// ---------------------------------------------------------------------------------------------------------
export function ProcessTaskQueue() {
  const { can } = useSession();
  if (!can(TASK_COMPLETE)) return null;
  return <MyProcessTasks />;
}

function MyProcessTasks() {
  const keys = useKeys();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const tasks = useQuery({
    queryKey: [...keys.myTasks, page],
    queryFn: () => api<Paged<MyTask> & { overdue: number }>(pagedUrl('/v1/employee-process-tasks/mine', page)),
    retry: retryTransient,
  });
  const [notice, setNotice] = useState<NoticeState>(null);
  const data = shown(tasks);
  const done: Done = (text, ok = true) => {
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.processes });
    void qc.invalidateQueries({ queryKey: keys.exits });
  };
  // `total` and `overdue` count every task waiting for the caller, not only this page.
  return (
    <Section title={`My process tasks${data ? ` (${totalOf(data)})` : ''}`}>
      <p className="hint">Open tasks of open processes that you or your role own, earliest due first.</p>
      {tasks.isPending && <Loading>Loading your process tasks…</Loading>}
      <QueryProblem error={tasks.error} forbidden="The selected role cannot complete process tasks." />
      <Notice notice={notice} />
      {data && data.overdue > 0 && (
        <p style={FLUSH}>
          <Badge tone="bad">overdue</Badge> {`${plural(data.overdue, 'task')} past the due date.`}
        </p>
      )}
      {data && data.items.length === 0 && <Empty>No process tasks are waiting for you.</Empty>}
      {data && data.items.length > 0 && (
        <ul className="tasks" aria-label="My process tasks">
          {data.items.map((t) => (
            <MyTaskItem key={t.id} task={t} onDone={done} />
          ))}
        </ul>
      )}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(data)} onPage={setPage} label="Task pages" noun="task" />}
    </Section>
  );
}

function MyTaskItem({ task: t, onDone }: { task: MyTask; onDone: Done }) {
  const { can } = useSession();
  const headingId = useId();
  const canComplete = can(TASK_COMPLETE);
  return (
    <li aria-labelledby={headingId}>
      <h3 id={headingId} style={H3}>
        {`${t.title} (${t.code})`}
      </h3>
      <p style={FLUSH}>
        {can(PROCESS_READ) ? <Link to={PATHS.process(t.processId)}>{t.processName}</Link> : t.processName} for {t.employeeName} ({t.employeeCode})
      </p>
      <TaskFacts task={t} employeeId={t.employeeId} />
      <TaskActions task={t} allowed={{ complete: canComplete, skip: canComplete && !t.required, reassign: false, reopen: false }} onDone={onDone} />
    </li>
  );
}
