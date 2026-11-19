// An employee process (FR-016): its detail, its tasks with their actions and forms, process actions and history.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useId, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, download, fileToBase64, formatDate, plural, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, Item, NotPermitted, Section, StateBadge, When } from '../../ui';
import { type Act, type Done, Refusal, reportGone } from './refusals';
import { Block, EVIDENCE_READ, EXIT_READ, FILE_NAME, FLUSH, GROUP, H3, Loading, LONG_CODE, MAX_FILE_BYTES, MAX_FILE_NAME, MAX_REMARK, Notice, type NoticeState, OWNER_ROLES, ownerRefText, ownerText, ownsTask, PATHS, Problem, PROCESS_ACTION_LABEL, PROCESS_MANAGE, PROCESS_READ, PROCESS_REOPEN, QueryProblem, ReasonField, RoleReady, SCAN_TEXT, SCAN_TONE, SCROLL, shown, TASK_COMPLETE, typeLabel, useKeys, userText, UUID } from './shared';
import type { ProcessDetail, ProcessEvent, ProcessTask } from './types';

export function ProcessDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  return (
    <>
      <p>
        <Link className="back-link" to={PATHS.processes}>← Employee processes</Link>
      </p>
      {!UUID.test(id) ? (
        <Empty>This process does not exist.</Empty>
      ) : (
        <RoleReady>{!can(PROCESS_READ) ? <NotPermitted>The selected role cannot view employee processes.</NotPermitted> : <ProcessView key={id} processId={id} />}</RoleReady>
      )}
    </>
  );
}

/** One employee process: its tasks with what the selected assignment may do on each, the process actions and history. */
export function ProcessView({ processId, embedded = false }: { processId: string; embedded?: boolean }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: keys.process(processId), queryFn: () => api<ProcessDetail>(`/v1/employee-processes/${processId}`), retry: retryTransient });
  const [notice, setNotice] = useState<NoticeState>(null);
  const p = shown(query);
  const done: Done = (text, ok = true) => {
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.processes });
    // A clearance checklist's tasks decide whether its exit can be released.
    void qc.invalidateQueries({ queryKey: keys.exits });
  };
  if (!p) {
    return (
      <>
        {query.isPending && <Loading>Loading the process…</Loading>}
        <QueryProblem error={query.error} forbidden="The selected role cannot view employee processes." missing="This process is not available in the selected role’s scope." />
      </>
    );
  }
  return (
    <>
      {embedded ? (
        <h3 style={H3}>
          {p.processName} ({p.processCode})
        </h3>
      ) : (
        <h1>
          {p.processName} for {p.employeeName} ({p.employeeCode})
        </h1>
      )}
      <dl className="kv">
        <Item term="State">
          <StateBadge state={p.state} />
        </Item>
        <Item term="Template">{`${p.processCode}, revision ${p.revision}`}</Item>
        <Item term="Type">{typeLabel(p.processType)}</Item>
        <Item term="Effective date">{formatDate(p.effectiveDate)}</Item>
        {!embedded && <Item term="Process owner">{userText(p.ownerUserId, me?.userId ?? null)}</Item>}
        <Item term="Started">
          <When at={p.createdAt} />
        </Item>
        {p.closedAt && (
          <Item term="Closed">
            <When at={p.closedAt} />
          </Item>
        )}
        {p.cancelledAt && (
          <Item term="Cancelled">
            <When at={p.cancelledAt} />
          </Item>
        )}
        {p.reopenCount > 0 && <Item term="Reopened">{plural(p.reopenCount, 'time')}</Item>}
        {p.exitCaseId && (
          <Item term="Exit case">{!embedded && can(EXIT_READ) ? <Link to={PATHS.exit(p.exitCaseId)}>Open the exit case</Link> : 'Exit clearance checklist'}</Item>
        )}
        {!embedded && (
          <Item term="Employee">
            <Link to={PATHS.employee(p.employeeId)}>All processes and exits of {p.employeeName}</Link>
          </Item>
        )}
      </dl>
      <Notice notice={notice} />
      <Block title="Tasks" nested={embedded}>
        <p className="hint" style={FLUSH}>
          {`${plural(p.counts.total, 'task')}: ${p.counts.open} open, ${p.counts.requiredOpen} required still open, ${p.counts.overdue} overdue.`}
        </p>
        {p.tasks.length === 0 ? (
          <Empty>This process has no tasks.</Empty>
        ) : (
          <ol className="tasks" aria-label="Tasks">
            {p.tasks.map((t) => (
              <TaskItem key={t.id} process={p} task={t} onDone={done} />
            ))}
          </ol>
        )}
      </Block>
      <ProcessActions process={p} onDone={done} />
      <ProcessHistory process={p} nested={embedded} />
    </>
  );
}

type TaskForm = 'complete' | 'skip' | 'reassign' | 'reopen';
type TaskPermissions = Record<TaskForm, boolean>;

/** Refusals after which a task form has nothing left to do: the task or its process moved on, or left the caller. */
const TASK_GONE: ReadonlySet<string> = new Set(['TASK_NOT_OPEN', 'TASK_NOT_DONE', 'PROCESS_NOT_OPEN', 'NOT_TASK_OWNER', 'NOT_FOUND']);

/**
 * A refused task action: the process reloads when the refusal says the task changed or moved on, so a retry uses its
 * current version; a form with nothing left to do closes and its refusal moves to the screen's notice.
 */
function useTaskRefusal(action: Act, onDone: Done) {
  const keys = useKeys();
  const qc = useQueryClient();
  return (error: Error) => {
    if (!(error instanceof ApiError)) return;
    if (error.status === 409 || error.status === 404 || error.code === 'NOT_TASK_OWNER') void qc.invalidateQueries({ queryKey: keys.processes });
    reportGone(error, action, TASK_GONE, onDone);
  };
}

function TaskItem({ process, task: t, onDone }: { process: ProcessDetail; task: ProcessTask; onDone: Done }) {
  const { can, me } = useSession();
  const headingId = useId();
  const own = me?.employeeId === process.employeeId;
  const processOpen = process.state === 'OPEN';
  const open = t.state === 'OPEN';
  const mine = ownsTask(me, process.employeeId, t);
  const allowed: TaskPermissions = {
    complete: can(TASK_COMPLETE) && processOpen && open && mine,
    skip: can(TASK_COMPLETE) && processOpen && open && mine && !t.required,
    reassign: can(PROCESS_MANAGE) && !own && processOpen && open,
    reopen: can(PROCESS_REOPEN) && !own && processOpen && !open,
  };
  return (
    <li aria-labelledby={headingId}>
      <h3 id={headingId} style={H3}>
        {`${t.sequence}. ${t.title} (${t.code})`}
      </h3>
      <TaskFacts task={t} employeeId={process.employeeId} />
      <TaskActions task={t} allowed={allowed} onDone={onDone} />
    </li>
  );
}

export function TaskFacts({ task: t, employeeId }: { task: ProcessTask; employeeId: string }) {
  const { me, can } = useSession();
  const myUserId = me?.userId ?? null;
  return (
    <dl className="kv">
      <Item term="Status">
        <StateBadge state={t.state} />
        {t.overdue && (
          <>
            {' '}
            <Badge tone="bad">overdue</Badge>
          </>
        )}
      </Item>
      <Item term="Required">{t.required ? 'Required' : 'Optional'}</Item>
      <Item term="Owner">{ownerText(t, myUserId)}</Item>
      <Item term="Due">{formatDate(t.dueDate)}</Item>
      {t.state !== 'OPEN' && <Item term={t.state === 'SKIPPED' ? 'Skipped' : 'Completed'}>{`${formatDate(t.doneOn)} by ${userText(t.doneBy, myUserId)}`}</Item>}
      <Item term="Evidence">
        <EvidenceState task={t} canOpen={can(EVIDENCE_READ) && me?.employeeId !== employeeId} />
      </Item>
    </dl>
  );
}

/** FR-106: the evidence's scan state as text; only a released file is offered for download, to the evidence grant. */
function EvidenceState({ task: t, canOpen }: { task: ProcessTask; canOpen: boolean }) {
  const open = useMutation({ mutationFn: () => download(`/v1/employee-process-tasks/${t.id}/evidence`) });
  if (!t.hasEvidence) return <>{t.evidenceRequired ? 'Required' : 'Not required'}</>;
  const scan = t.evidenceScanState;
  return (
    <>
      <Badge tone={(scan && SCAN_TONE[scan]) || 'warn'}>{scan ? (SCAN_TEXT[scan] ?? readable(scan).toLowerCase()) : 'not scanned'}</Badge>
      {scan === 'QUARANTINED' && <div className="hint">This file failed the malware scan and counts as no evidence: the task has to be reopened and completed again with a clean file.</div>}
      {canOpen && scan === 'CLEAN' && (
        <div>
          <button type="button" className="secondary" disabled={open.isPending} onClick={() => open.mutate()}>
            Download evidence
          </button>
        </div>
      )}
      <Refusal error={open.error} action="evidence" />
    </>
  );
}

export function TaskActions({ task, allowed, onDone }: { task: ProcessTask; allowed: TaskPermissions; onDone: Done }) {
  const [form, setForm] = useState<TaskForm | null>(null);
  const finish: Done = (text, ok = true) => {
    setForm(null);
    onDone(text, ok);
  };
  const toggle = (next: TaskForm) => setForm((prev) => (prev === next ? null : next));
  if (!allowed.complete && !allowed.skip && !allowed.reassign && !allowed.reopen) return null;
  return (
    <div className="stack">
      <div className="row">
        {allowed.complete && (
          <button type="button" aria-expanded={form === 'complete'} onClick={() => toggle('complete')}>
            Complete
          </button>
        )}
        {allowed.skip && (
          <button type="button" className="secondary" aria-expanded={form === 'skip'} onClick={() => toggle('skip')}>
            Skip
          </button>
        )}
        {allowed.reassign && (
          <button type="button" className="secondary" aria-expanded={form === 'reassign'} onClick={() => toggle('reassign')}>
            Reassign
          </button>
        )}
        {allowed.reopen && (
          <button type="button" className="secondary" aria-expanded={form === 'reopen'} onClick={() => toggle('reopen')}>
            Reopen
          </button>
        )}
      </div>
      {form === 'complete' && allowed.complete && <CompleteTaskForm task={task} onDone={finish} />}
      {form === 'skip' && allowed.skip && <TaskReasonForm task={task} kind="skip" onDone={finish} />}
      {form === 'reassign' && allowed.reassign && <ReassignTaskForm task={task} onDone={finish} />}
      {form === 'reopen' && allowed.reopen && <TaskReasonForm task={task} kind="reopen-task" onDone={finish} />}
    </div>
  );
}

/** FR-016: the owner completes a task (actor and business date recorded), with a remark and the evidence it asks for. */
function CompleteTaskForm({ task: t, onDone }: { task: ProcessTask; onDone: Done }) {
  const refused = useTaskRefusal('complete', onDone);
  const [remark, setRemark] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);
  const complete = useMutation({
    mutationFn: async (input: { remark: string; file: File | null }) => {
      const evidence = input.file ? { fileName: input.file.name, contentBase64: await fileToBase64(input.file) } : null;
      return api<ProcessTask>(`/v1/employee-process-tasks/${t.id}/complete`, {
        body: { expectedVersion: t.version, ...(input.remark ? { remark: input.remark } : {}), ...(evidence ? { evidence } : {}) },
      });
    },
    onSuccess: (doneTask) => {
      setRemark('');
      setFile(null);
      setFileKey((k) => k + 1);
      // In a deployment the stored file is waiting for the scan worker, so the answer says PENDING_SCAN (FR-106, NFR-S09).
      const scan = doneTask.evidenceScanState;
      if (scan === 'QUARANTINED') {
        onDone(
          `Completed ${t.title}, but its evidence failed the malware scan: it counts as no evidence and nobody can open it.${
            doneTask.evidenceRequired ? ' The task has to be reopened and completed again with a clean file.' : ''
          }`,
          false,
        );
        return;
      }
      onDone(
        scan === 'PENDING_SCAN'
          ? `Completed ${t.title}. Its evidence is waiting for the malware scan; nobody can open it until the scan releases it.`
          : scan === 'CLEAN'
            ? `Completed ${t.title}. Its evidence was released by the malware scan.`
            : `Completed ${t.title}.`,
      );
    },
    onError: refused,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (complete.isPending) return;
    let issue: string | null = null;
    if (t.evidenceRequired && !file) issue = 'This task needs evidence: choose a PDF, JPEG or PNG file.';
    else if (file && (file.size === 0 || file.size > MAX_FILE_BYTES)) issue = 'The evidence file must be between 1 byte and 10 MB.';
    else if (file && file.name.length > MAX_FILE_NAME) issue = `Rename the file first: its name can have at most ${MAX_FILE_NAME} characters.`;
    else if (file && !FILE_NAME.test(file.name)) issue = 'Rename the file first: its name cannot contain / \\ < > : " | ? * or control characters.';
    setProblem(issue);
    if (issue) {
      complete.reset();
      return;
    }
    complete.mutate({ remark: remark.trim(), file });
  };
  return (
    <form aria-label={`Complete ${t.title}`} className="stack" onSubmit={submit}>
      <ReasonField label="Remark (optional; restricted to authorised HR)" value={remark} onChange={setRemark} max={MAX_REMARK} />
      <label>
        {t.evidenceRequired ? 'Evidence file (required)' : 'Evidence file (optional)'}
        <input key={fileKey} type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <p className="hint" style={FLUSH}>
        PDF, JPEG or PNG up to 10 MB. The file is scanned for malware before anyone can open it.
      </p>
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={complete.isPending}>
          Complete task
        </button>
      </div>
      <Refusal error={complete.error} action="complete" except={TASK_GONE} />
    </form>
  );
}

/** Skipping an optional task, or reopening a done one (FR-016: with a reason and its own duty). */
function TaskReasonForm({ task: t, kind, onDone }: { task: ProcessTask; kind: 'skip' | 'reopen-task'; onDone: Done }) {
  const refused = useTaskRefusal(kind, onDone);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const skip = kind === 'skip';
  const act = useMutation({
    mutationFn: (text: string) => api<ProcessTask>(`/v1/employee-process-tasks/${t.id}/${skip ? 'skip' : 'reopen'}`, { body: { expectedVersion: t.version, reason: text } }),
    onSuccess: () => {
      setReason('');
      onDone(skip ? `Skipped ${t.title}.` : `Reopened ${t.title}; its earlier completion stays in the history.`);
    },
    onError: refused,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (act.isPending) return;
    const text = reason.trim();
    setProblem(text ? null : skip ? 'Enter the reason for skipping the task.' : 'Enter the reason for reopening the task.');
    if (!text) {
      act.reset();
      return;
    }
    act.mutate(text);
  };
  return (
    <form aria-label={skip ? `Skip ${t.title}` : `Reopen ${t.title}`} className="stack" onSubmit={submit}>
      <ReasonField label={skip ? 'Reason for skipping (required)' : 'Reason for reopening (required)'} value={reason} onChange={setReason} />
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={act.isPending}>
          {skip ? 'Skip task' : 'Reopen task'}
        </button>
      </div>
      <Refusal error={act.error} action={kind} except={TASK_GONE} />
    </form>
  );
}

/** FR-016: reassignment keeps the prior owner in the history. */
function ReassignTaskForm({ task: t, onDone }: { task: ProcessTask; onDone: Done }) {
  const { me } = useSession();
  const refused = useTaskRefusal('reassign', onDone);
  const radioName = useId();
  const roleListId = useId();
  const [kind, setKind] = useState<'ROLE' | 'USER'>('ROLE');
  const [role, setRole] = useState('');
  const [user, setUser] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const reassign = useMutation({
    mutationFn: (body: { expectedVersion: number; ownerRoleCode?: string; ownerUserId?: string; reason?: string }) =>
      api<ProcessTask>(`/v1/employee-process-tasks/${t.id}/reassign`, { body }),
    onSuccess: (moved) => {
      setRole('');
      setUser('');
      setReason('');
      onDone(`Reassigned ${t.title} to ${ownerText(moved, me?.userId ?? null)}; the earlier owner stays in the history.`);
    },
    onError: refused,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (reassign.isPending) return;
    const r = role.trim();
    const u = user.trim();
    const text = reason.trim();
    let issue: string | null = null;
    if (kind === 'ROLE' && !LONG_CODE.test(r)) issue = 'Enter the new owner role code, for example REPORTING_MANAGER.';
    else if (kind === 'USER' && !UUID.test(u)) issue = 'Enter the new owner’s user ID.';
    else if (kind === 'ROLE' ? r === t.ownerRoleCode && t.ownerUserId === null : u.toLowerCase() === t.ownerUserId?.toLowerCase() && t.ownerRoleCode === null) {
      issue = 'The task already has this owner.';
    }
    setProblem(issue);
    if (issue) {
      reassign.reset();
      return;
    }
    reassign.mutate({ expectedVersion: t.version, ...(kind === 'ROLE' ? { ownerRoleCode: r } : { ownerUserId: u }), ...(text ? { reason: text } : {}) });
  };
  return (
    <form aria-label={`Reassign ${t.title}`} className="stack" onSubmit={submit}>
      <fieldset style={GROUP}>
        <legend>New owner</legend>
        <div className="row">
          <label className="check">
            <input type="radio" name={radioName} checked={kind === 'ROLE'} onChange={() => setKind('ROLE')} /> A role
          </label>
          <label className="check">
            <input type="radio" name={radioName} checked={kind === 'USER'} onChange={() => setKind('USER')} /> A named user
          </label>
        </div>
        {kind === 'ROLE' ? (
          <label>
            New owner role code
            <input list={roleListId} value={role} maxLength={60} onChange={(e) => setRole(e.target.value.toUpperCase())} />
          </label>
        ) : (
          <label>
            New owner user ID
            <input value={user} maxLength={36} onChange={(e) => setUser(e.target.value)} />
          </label>
        )}
        <datalist id={roleListId}>
          {OWNER_ROLES.map(([c, label]) => (
            <option key={c} value={c}>
              {label}
            </option>
          ))}
        </datalist>
      </fieldset>
      <ReasonField label="Reason (optional; restricted to authorised HR)" value={reason} onChange={setReason} />
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={reassign.isPending}>
          Reassign task
        </button>
      </div>
      <Refusal error={reassign.error} action="reassign" except={TASK_GONE} />
    </form>
  );
}

/** Process refusals after which these actions are gone once the process reloads (it moved on meanwhile). */
const PROCESS_GONE: ReadonlySet<string> = new Set(['PROCESS_NOT_OPEN', 'PROCESS_NOT_CLOSED', 'NOT_FOUND']);

/**
 * A required task that still holds its process (and an exit's final release) open, as the API decides it
 * (processes.ts INCOMPLETE_REQUIRED): not completed, or completed with required evidence the malware scan has not
 * released (a file still waiting for its scan is not evidence yet, and a quarantined file never is).
 */
const holdsOpen = (t: ProcessTask) => t.required && (t.state !== 'COMPLETED' || (t.evidenceRequired && t.evidenceScanState !== 'CLEAN'));

/** FR-015/FR-016: close once every required task is complete; cancel an open process or reopen a closed one with a reason. */
function ProcessActions({ process: p, onDone }: { process: ProcessDetail; onDone: Done }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const own = me?.employeeId === p.employeeId;
  const canManage = can(PROCESS_MANAGE) && !own && p.state === 'OPEN';
  const canReopen = can(PROCESS_REOPEN) && !own && p.state === 'CLOSED';
  const [cancelReason, setCancelReason] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const [problem, setProblem] = useState<{ form: 'cancel' | 'reopen'; text: string } | null>(null);
  const conflict = (action: Act) => (error: Error) => {
    if (!(error instanceof ApiError)) return;
    if (error.status === 409 || error.status === 404) void qc.invalidateQueries({ queryKey: keys.processes });
    reportGone(error, action, PROCESS_GONE, onDone);
  };
  const close = useMutation({
    mutationFn: () => api<ProcessDetail>(`/v1/employee-processes/${p.id}/close`, { body: { expectedVersion: p.version } }),
    onSuccess: () => onDone('Closed the process.'),
    onError: conflict('close'),
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => api<ProcessDetail>(`/v1/employee-processes/${p.id}/cancel`, { body: { expectedVersion: p.version, reason } }),
    onSuccess: () => {
      setCancelReason('');
      onDone('Cancelled the process. Its tasks and history are kept.');
    },
    onError: conflict('cancel'),
  });
  const reopen = useMutation({
    mutationFn: (reason: string) => api<ProcessDetail>(`/v1/employee-processes/${p.id}/reopen`, { body: { expectedVersion: p.version, reason } }),
    onSuccess: () => {
      setReopenReason('');
      onDone('Reopened the process. Its history is kept.');
    },
    onError: conflict('reopen'),
  });
  if (!canManage && !canReopen) return null;
  const busy = close.isPending || cancel.isPending || reopen.isPending;
  const incomplete = p.tasks.filter(holdsOpen);
  // Completed, but their required evidence is not released yet (still waiting for the scan) or never will be.
  const quarantined = incomplete.some((t) => t.state === 'COMPLETED' && t.evidenceScanState === 'QUARANTINED');
  const awaitingScan = incomplete.some((t) => t.state === 'COMPLETED' && t.evidenceScanState !== 'QUARANTINED');
  const withReason = (form: 'cancel' | 'reopen', typed: string, send: (reason: string) => void) => (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const text = typed.trim();
    if (!text) {
      setProblem({ form, text: form === 'cancel' ? 'Enter the reason for cancelling the process.' : 'Enter the reason for reopening the process.' });
      return;
    }
    setProblem(null);
    send(text);
  };
  return (
    <Section title="Process actions">
      {canManage && (
        <div className="stack">
          <p className="hint" style={FLUSH}>
            {incomplete.length > 0
              ? `The process closes once every required task is complete. Still incomplete: ${incomplete.map((t) => t.code).join(', ')}.${
                  awaitingScan ? ' Required evidence still waiting for the malware scan counts once the scan releases it.' : ''
                }${quarantined ? ' A required task whose evidence failed the malware scan stays incomplete until it is reopened and completed with a clean file.' : ''}`
              : 'Every required task is done, so the process can close; open optional tasks do not hold it.'}
          </p>
          <div>
            <button type="button" disabled={busy || incomplete.length > 0} onClick={() => close.mutate()}>
              Close process
            </button>
          </div>
          <Refusal error={close.error} action="close" except={PROCESS_GONE} />
          <form aria-label="Cancel the process" className="stack" onSubmit={withReason('cancel', cancelReason, (reason) => cancel.mutate(reason))}>
            <ReasonField label="Reason for cancelling (required)" value={cancelReason} onChange={setCancelReason} />
            <Problem text={problem?.form === 'cancel' ? problem.text : null} />
            <div>
              <button type="submit" className="danger" disabled={busy}>
                Cancel process
              </button>
            </div>
            <Refusal error={cancel.error} action="cancel" except={PROCESS_GONE} />
          </form>
        </div>
      )}
      {canReopen && (
        <form aria-label="Reopen the process" className="stack" onSubmit={withReason('reopen', reopenReason, (reason) => reopen.mutate(reason))}>
          <ReasonField label="Reason for reopening (required)" value={reopenReason} onChange={setReopenReason} />
          <Problem text={problem?.form === 'reopen' ? problem.text : null} />
          <div>
            <button type="submit" disabled={busy}>
              Reopen process
            </button>
          </div>
          <Refusal error={reopen.error} action="reopen" except={PROCESS_GONE} />
        </form>
      )}
    </Section>
  );
}

function historyChange(e: ProcessEvent, myUserId: string | null): string {
  if (e.priorOwner || e.newOwner) return `Owner: ${ownerRefText(e.priorOwner, myUserId)} → ${ownerRefText(e.newOwner, myUserId)}`;
  if (e.fromState && e.toState) return `${readable(e.fromState)} → ${readable(e.toState)}`;
  return e.toState ? readable(e.toState) : '—';
}

/** Restricted (FR-018): a remark or reason appears only when the server returned it; otherwise whether one exists. */
function remarkText(e: ProcessEvent): string {
  if ('note' in e) return e.note ?? '—';
  return e.noteRecorded ? 'Recorded (restricted)' : '—';
}

function ProcessHistory({ process: p, nested }: { process: ProcessDetail; nested?: boolean }) {
  const { me } = useSession();
  const myUserId = me?.userId ?? null;
  return (
    <Block title="History" nested={nested}>
      {p.history.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Process history">
            <thead>
              <tr>
                <th>Business date</th>
                <th>Recorded</th>
                <th>Action</th>
                <th>Task</th>
                <th>Change</th>
                <th>Evidence</th>
                <th>Remark or reason</th>
                <th>By</th>
              </tr>
            </thead>
            <tbody>
              {p.history.map((e, i) => (
                <tr key={`${e.occurredAt}-${i}`}>
                  <td>{formatDate(e.businessDate)}</td>
                  <td>
                    <When at={e.occurredAt} />
                  </td>
                  <td>{PROCESS_ACTION_LABEL[e.action] ?? readable(e.action)}</td>
                  <td>{e.taskCode ?? '—'}</td>
                  <td>{historyChange(e, myUserId)}</td>
                  <td>{e.hasEvidence ? 'Attached' : '—'}</td>
                  <td>{remarkText(e)}</td>
                  <td>{userText(e.actorUserId, myUserId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}
