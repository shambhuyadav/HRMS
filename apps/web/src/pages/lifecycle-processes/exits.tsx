// Exit cases (FR-051, F1): the list, an exit case with its facts, notice period, clearance, final release and history.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError, formatDate, plural, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Item, LIST_PAGE_SIZE, nextSort, NotPermitted, Pager, Section, SortHeader, sortParams, type SortState, StateBadge, When } from '../../ui';
import { ExitApprovalQueue, type ExitQueueKind, ExitRecommendationQueue, ExitTaskItem, ExitWithdrawalQueue } from './queues';
import { type Done, Refusal, reportGone } from './refusals';
import { Block, CODE, DECISION_LABEL, EXIT_ACTION_LABEL, EXIT_APPROVE, EXIT_MANAGE, EXIT_READ, EXIT_RECOMMEND, EXIT_STATE_HINT, EXIT_STATES, EXIT_TYPE, FIELDS, FLUSH, ISO_DATE, Loading, Notice, NOTICE_DAYS_LIMIT, type NoticeState, noticeText, type Paged, pagedUrl, PATHS, Problem, PROCESS_MANAGE, PROCESS_READ, QueryProblem, RoleReady, SCROLL, shown, statusLabel, TEMPLATE_READ, totalOf, useKeys, userText, UUID } from './shared';
import type { AfterLastWorkingDate, ExitCase, ExitDecision, ExitDetail, ExitEvent, ExitTask, ExitWithdrawal, ProcessDetail, TemplateSummary } from './types';

// ---------------------------------------------------------------------------------------------------------
// Screens: exit cases (FR-051, F1)
// ---------------------------------------------------------------------------------------------------------
export function ExitsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Exit cases</h1>
      <RoleReady>
        <ExitRecommendationQueue />
        <ExitApprovalQueue />
        <ExitWithdrawalQueue />
        {can(EXIT_READ) ? (
          <ExitList />
        ) : (
          <Section title="Exit cases">
            <NotPermitted>The selected role cannot view exit cases.</NotPermitted>
          </Section>
        )}
      </RoleReady>
    </>
  );
}

/** The columns GET /v1/exit-cases sorts by that this table shows (lifecycle/exit.ts). */
type ExitSort = 'employeeName' | 'requestDate' | 'state';

export function ExitTable({ exits, label, withEmployee = true, sort, onSort }: { exits: ExitCase[]; label: string; withEmployee?: boolean; sort?: SortState<ExitSort>; onSort?: (column: ExitSort) => void }) {
  const heading = (column: ExitSort, text: string) => (onSort ? <SortHeader column={column} label={text} sort={sort ?? null} onSort={onSort} /> : <th>{text}</th>);
  return (
    <div style={SCROLL}>
      <table aria-label={label}>
        <thead>
          <tr>
            {withEmployee && heading('employeeName', 'Employee')}
            {heading('requestDate', 'Resignation date')}
            {heading('state', 'State')}
            <th>Proposed last working date</th>
            <th>Recommended</th>
            <th>Approved</th>
            <th>Contractual notice period</th>
            <th>Final release</th>
          </tr>
        </thead>
        <tbody>
          {exits.map((x) => (
            <tr key={x.id}>
              {withEmployee && (
                <td>
                  <Link to={PATHS.exit(x.id)}>
                    {x.employeeName} ({x.employeeCode})
                  </Link>
                </td>
              )}
              <td>{withEmployee ? formatDate(x.requestDate) : <Link to={PATHS.exit(x.id)}>{formatDate(x.requestDate)}</Link>}</td>
              <td>
                <StateBadge state={x.state} />
              </td>
              <td>{formatDate(x.proposedLastWorkingDate)}</td>
              <td>{formatDate(x.recommendedLastWorkingDate)}</td>
              <td>{formatDate(x.approvedLastWorkingDate)}</td>
              <td>{noticeText(x.noticePeriod)}</td>
              <td>{x.released ? 'Released' : 'Not released'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ExitList() {
  const keys = useKeys();
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState<ExitSort>>(null);
  const onSort = (column: ExitSort) => {
    setSort((current) => nextSort(current, column));
    setPage(1);
  };
  const list = useQuery({
    queryKey: [...keys.exitList(state || 'ALL'), page, sort],
    queryFn: () => api<Paged<ExitCase>>(pagedUrl('/v1/exit-cases', page, new URLSearchParams({ ...(state ? { state } : {}), ...sortParams(sort) }))),
    retry: retryTransient,
  });
  const data = shown(list);
  return (
    <Section title={`Exit cases${data ? ` (${totalOf(data)})` : ''}`}>
      <label className="inline">
        State
        <select
          value={state}
          onChange={(e) => {
            setState(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All states</option>
          {EXIT_STATES.map((s) => (
            <option key={s} value={s}>
              {readable(s)}
            </option>
          ))}
        </select>
      </label>
      {list.isPending && <Loading>Loading the exit cases…</Loading>}
      <QueryProblem error={list.error} forbidden="The selected role cannot view exit cases." />
      {data && data.items.length === 0 && <Empty>{state ? 'No exit cases in this state.' : 'No exit cases in the selected role’s scope.'}</Empty>}
      {data && data.items.length > 0 && <ExitTable exits={data.items} label="Exit cases" sort={sort} onSort={onSort} />}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(data)} onPage={setPage} label="Exit case pages" noun="exit case" />}
    </Section>
  );
}

export function ExitDetailScreen() {
  const { id = '' } = useParams();
  const { can } = useSession();
  return (
    <>
      <p>
        <Link className="back-link" to={PATHS.exits}>← Exit cases</Link>
      </p>
      {!UUID.test(id) ? (
        <Empty>This exit case does not exist.</Empty>
      ) : (
        <RoleReady>{!can(EXIT_READ) ? <NotPermitted>The selected role cannot view exit cases.</NotPermitted> : <ExitView key={id} exitId={id} />}</RoleReady>
      )}
    </>
  );
}

const queueKindOf = (t: ExitTask): ExitQueueKind => (t.kind === 'exit_withdrawal' ? 'withdrawal' : t.step === 'recommend' ? 'recommend' : 'approve');

function ExitView({ exitId }: { exitId: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: keys.exit(exitId), queryFn: () => api<ExitDetail>(`/v1/exit-cases/${exitId}`), retry: retryTransient });
  const decides = can(EXIT_RECOMMEND) || can(EXIT_APPROVE);
  const tasks = useQuery({ enabled: decides, queryKey: keys.exitTasks, queryFn: () => api<{ items: ExitTask[] }>('/v1/exit-cases/tasks/mine'), retry: retryTransient });
  const [notice, setNotice] = useState<NoticeState>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());
  const x = shown(query);
  const done = (text: string, ok = true) => {
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.exits });
    void qc.invalidateQueries({ queryKey: keys.processes });
  };
  if (!x) {
    return (
      <>
        {query.isPending && <Loading>Loading the exit case…</Loading>}
        <QueryProblem error={query.error} forbidden="The selected role cannot view exit cases." missing="This exit case is not available in the selected role’s scope." />
      </>
    );
  }
  const own = me?.employeeId === x.employeeId;
  const mine = decides ? (shown(tasks)?.items ?? []).filter((t) => t.exitCase?.id === x.id && !gone.has(t.taskId)) : [];
  const live = ['SUBMITTED', 'RECOMMENDED', 'APPROVED', 'SEPARATED'].includes(x.state) && !x.released;
  const releasable = (x.state === 'APPROVED' || x.state === 'SEPARATED') && !x.released;
  return (
    <>
      <h1>
        Exit of {x.employeeName} ({x.employeeCode})
      </h1>
      <Notice notice={notice} />
      {mine.length > 0 && (
        <Section title="Waiting for your decision">
          <ul className="tasks" aria-label="Waiting for your decision">
            {mine.map((t) => (
              <ExitTaskItem
                key={t.taskId}
                task={t}
                kind={queueKindOf(t)}
                linkToExit={false}
                onFinished={(task, text, ok) => {
                  setGone((prev) => new Set(prev).add(task.taskId));
                  done(text, ok);
                }}
              />
            ))}
          </ul>
        </Section>
      )}
      <Section title="Exit">
        <ExitFacts x={x} />
        {can(PROCESS_READ) && (
          <p style={FLUSH}>
            <Link to={PATHS.employee(x.employeeId)}>All processes and exits of {x.employeeName}</Link>
          </p>
        )}
      </Section>
      {x.afterLastWorkingDate && <AfterLastWorkingDateList after={x.afterLastWorkingDate} />}
      {can(EXIT_MANAGE) && !own && live && <NoticePeriodForm exit={x} onDone={done} />}
      <ClearanceSection exit={x} own={own} onDone={done} />
      {can(EXIT_MANAGE) && !own && releasable && <FinalRelease exit={x} onDone={done} />}
      <WithdrawalList withdrawals={x.withdrawals} />
      <DecisionTrail decisions={x.decisions} />
      <ExitHistory history={x.history} />
    </>
  );
}

const AFTER_KIND_LABEL: Record<string, string> = {
  LEAVE_REQUEST: 'Leave',
  OUTDOOR_DUTY_REQUEST: 'Outdoor duty',
  HOLIDAY_WORK_REQUEST: 'Holiday work',
  RESOURCE_ALLOCATION: 'Project allocation',
  TIMESHEET: 'Timesheet',
};

/**
 * FR-051 (I-81 item 3): what was approved for days after the last working date stays as approved (a withdrawal can revive it, and
 * nothing approved is deleted), with no effect after that date; HR cancels any of it in its own module.
 */
function AfterLastWorkingDateList({ after }: { after: AfterLastWorkingDate }) {
  return (
    <Section title="Approved for days after the last working date">
      <p className="hint">These are kept, not cancelled by the exit. Payroll and attendance stop at the last working date, so none of them takes effect after it.</p>
      {after.items.length === 0 ? (
        <Empty>Nothing is approved for days after the last working date.</Empty>
      ) : (
        <ul>
          {after.items.map((i) => (
            <li key={i.id}>{`${AFTER_KIND_LABEL[i.kind] ?? readable(i.kind)}: ${formatDate(i.startDate)} to ${formatDate(i.endDate)}`}</li>
          ))}
        </ul>
      )}
    </Section>
  );
}

export function ExitFacts({ x, ownView = false }: { x: ExitCase; ownView?: boolean }) {
  return (
    <dl className="kv">
      {!ownView && <Item term="Employee">{`${x.employeeName} (${x.employeeCode})`}</Item>}
      <Item term="State">
        <StateBadge state={x.state} /> <span className="hint">{EXIT_STATE_HINT[x.state] ?? ''}</span>
      </Item>
      <Item term="Separation type">{readable(x.separationType)}</Item>
      {x.origin === 'HR' && <Item term="Entered by">HR, from a resignation given outside the system (with its evidence)</Item>}
      <Item term="Resignation date">{formatDate(x.requestDate)}</Item>
      <Item term="Proposed last working date">{formatDate(x.proposedLastWorkingDate)}</Item>
      <Item term="Recommended last working date">{formatDate(x.recommendedLastWorkingDate)}</Item>
      <Item term="Approved last working date">{formatDate(x.approvedLastWorkingDate)}</Item>
      <Item term="Last working date (inclusive)">{formatDate(x.lastWorkingDate)}</Item>
      <Item term="Contractual notice period">{noticeText(x.noticePeriod)}</Item>
      {x.reasonCode !== undefined && x.reasonCode !== null && <Item term="Reason code">{x.reasonCode}</Item>}
      {x.reason !== undefined && x.reason !== null && <Item term="Reason">{x.reason}</Item>}
      {x.employeeMessage && <Item term={ownView ? 'Message from HR' : 'Message to the employee'}>{x.employeeMessage}</Item>}
      <Item term="Final release">
        {x.released ? (
          <>
            Released <When at={x.releasedAt} />
          </>
        ) : (
          'Not released'
        )}
      </Item>
    </dl>
  );
}

/** Exit refusals after which an HR form is gone once the exit reloads (it closed or was released meanwhile). */
const EXIT_GONE: ReadonlySet<string> = new Set(['INVALID_STATE', 'ALREADY_RELEASED', 'NOT_FOUND']);

/** F1: the contractual notice period is recorded from the contract (no default); nothing is calculated from it here. */
function NoticePeriodForm({ exit: x, onDone }: { exit: ExitDetail; onDone: Done }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const recorded = x.noticePeriod.status === 'RECORDED' ? String(x.noticePeriod.contractualNoticeDays) : '';
  // The recorded value until something is typed; what was typed stays after a refusal (the version is read when sending).
  const [typed, setTyped] = useState<string | null>(null);
  const days = typed ?? recorded;
  const setDays = (value: string) => setTyped(value);
  const [problem, setProblem] = useState<string | null>(null);
  const record = useMutation({
    mutationFn: (n: number) => api<ExitDetail>(`/v1/exit-cases/${x.id}/notice-period`, { method: 'PUT', body: { contractualNoticeDays: n, expectedVersion: x.version } }),
    onSuccess: (_d, n) => {
      setTyped(null);
      onDone(`Recorded the contractual notice period: ${plural(n, 'day')}.`);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.status === 409 || error.status === 404) void qc.invalidateQueries({ queryKey: keys.exits });
      reportGone(error, 'notice-period', EXIT_GONE, onDone);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (record.isPending) return;
    const typed = days.trim();
    if (!/^\d{1,4}$/.test(typed) || Number(typed) > NOTICE_DAYS_LIMIT) {
      setProblem(`Enter the notice period as a whole number of days from 0 to ${NOTICE_DAYS_LIMIT}.`);
      record.reset();
      return;
    }
    setProblem(null);
    record.mutate(Number(typed));
  };
  return (
    <Section title="Contractual notice period">
      <p className="hint">
        Record the notice period from the employee’s contract. There is no default; a notice adjustment in the settlement needs it recorded. Nothing is calculated from it here.
      </p>
      <form aria-label="Contractual notice period" className="row" onSubmit={submit}>
        <label>
          Notice period (days)
          <input type="number" min={0} max={NOTICE_DAYS_LIMIT} step={1} value={days} onChange={(e) => setDays(e.target.value)} />
        </label>
        <button type="submit" disabled={record.isPending}>
          Record notice period
        </button>
      </form>
      <Problem text={problem} />
      <Refusal error={record.error} action="notice-period" except={EXIT_GONE} />
    </Section>
  );
}

/** F1 "no skipped required clearance at final release": the checklist of the exit and its incomplete required tasks. */
function ClearanceSection({ exit: x, own, onDone }: { exit: ExitDetail; own: boolean; onDone: Done }) {
  const { can } = useSession();
  const c = x.clearance;
  const canStart = can(PROCESS_MANAGE) && !own && (x.state === 'APPROVED' || x.state === 'SEPARATED') && !x.released && !c.started;
  return (
    <Section title="Clearance checklist">
      <p style={FLUSH}>
        {!c.started
          ? 'Not started.'
          : c.complete
            ? 'Every required clearance task is complete.'
            : `Required clearance tasks still incomplete: ${c.incompleteRequired.length > 0 ? c.incompleteRequired.join(', ') : 'see the checklist'}.`}
      </p>
      {c.processIds.length > 0 && (
        <ul aria-label="Clearance checklists">
          {c.processIds.map((id, i) => (
            <li key={id}>
              {can(PROCESS_READ) ? (
                <Link to={PATHS.process(id)}>{c.processIds.length > 1 ? `Open clearance checklist ${i + 1}` : 'Open the clearance checklist'}</Link>
              ) : (
                `Clearance checklist ${i + 1}`
              )}
            </li>
          ))}
        </ul>
      )}
      {canStart && <StartClearanceForm exit={x} onDone={onDone} />}
    </Section>
  );
}

/** Clearance refusals after which the start form is gone once the exit reloads. */
const CLEARANCE_GONE: ReadonlySet<string> = new Set(['CLEARANCE_EXISTS', 'EXIT_NOT_APPROVED']);

function StartClearanceForm({ exit: x, onDone }: { exit: ExitDetail; onDone: Done }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canList = can(TEMPLATE_READ);
  const templates = useQuery({
    enabled: canList,
    queryKey: keys.templateList,
    queryFn: () => api<{ items: TemplateSummary[] }>('/v1/lifecycle-processes'),
    retry: retryTransient,
  });
  const listed = shown(templates);
  const exitTemplates = (listed?.items ?? []).filter((t) => t.processType === EXIT_TYPE && t.active && t.publishedRevision !== null);
  const [code, setCode] = useState('');
  const [effectiveDate, setEffectiveDate] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: (body: { processCode: string; exitCaseId: string; effectiveDate?: string }) => api<ProcessDetail>(`/v1/employees/${x.employeeId}/processes`, { body }),
    onSuccess: (p) => {
      setCode('');
      setEffectiveDate('');
      onDone(`Started the clearance checklist ${p.processName} with ${plural(p.tasks.length, 'task')}.`);
    },
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.status === 409) {
        void qc.invalidateQueries({ queryKey: keys.exits });
        void qc.invalidateQueries({ queryKey: keys.processes });
      }
      reportGone(error, 'start', CLEARANCE_GONE, onDone);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (start.isPending) return;
    const processCode = code.trim();
    let issue: string | null = null;
    if (!CODE.test(processCode)) issue = canList ? 'Choose the exit clearance template.' : 'Enter the exit clearance template code.';
    else if (effectiveDate && !ISO_DATE.test(effectiveDate)) issue = 'Enter a valid effective date.';
    setProblem(issue);
    if (issue) {
      start.reset();
      return;
    }
    start.mutate({ processCode, exitCaseId: x.id, ...(effectiveDate ? { effectiveDate } : {}) });
  };
  return (
    <form aria-label="Start the clearance checklist" className="stack" onSubmit={submit}>
      <div style={FIELDS}>
        {canList ? (
          <label>
            Exit clearance template
            <select value={code} onChange={(e) => setCode(e.target.value)}>
              <option value="">Choose a template…</option>
              {exitTemplates.map((t) => (
                <option key={t.id} value={t.code}>
                  {`${t.name} (${t.code}) · revision ${t.publishedRevision}`}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Exit clearance template code
            <input value={code} maxLength={40} onChange={(e) => setCode(e.target.value.toUpperCase())} />
          </label>
        )}
        <label>
          Effective date (leave empty for today)
          <input type="date" value={effectiveDate} onChange={(e) => setEffectiveDate(e.target.value)} />
        </label>
      </div>
      {canList && listed && exitTemplates.length === 0 && (
        <p className="hint" style={FLUSH}>
          No active exit clearance template has a published revision yet.
        </p>
      )}
      <Problem text={problem} />
      <div>
        <button type="submit" disabled={start.isPending}>
          Start clearance checklist
        </button>
      </div>
      <Refusal error={start.error} action="start" except={CLEARANCE_GONE} />
    </form>
  );
}

function FinalRelease({ exit: x, onDone }: { exit: ExitDetail; onDone: Done }) {
  const keys = useKeys();
  const qc = useQueryClient();
  const release = useMutation({
    mutationFn: () => api<ExitDetail>(`/v1/exit-cases/${x.id}/final-release`, { body: { expectedVersion: x.version } }),
    onSuccess: () => onDone('Recorded the final release. The exit and its clearance checklist are final.'),
    onError: (error) => {
      if (!(error instanceof ApiError)) return;
      if (error.status === 409 || error.status === 404) void qc.invalidateQueries({ queryKey: keys.exits });
      reportGone(error, 'release', EXIT_GONE, onDone);
    },
  });
  return (
    <Section title="Final release">
      <p className="hint">
        The final release is recorded on or after the last working date ({formatDate(x.approvedLastWorkingDate)}), once every required clearance task is complete and no withdrawal request is
        waiting.
      </p>
      <div>
        <button type="button" disabled={release.isPending || !x.clearance.complete} onClick={() => release.mutate()}>
          Record final release
        </button>
      </div>
      <Refusal error={release.error} action="release" except={EXIT_GONE} />
    </Section>
  );
}

export function WithdrawalList({ withdrawals, nested, ownView, action }: { withdrawals: ExitWithdrawal[]; nested?: boolean; ownView?: boolean; action?: (w: ExitWithdrawal) => ReactNode }) {
  if (withdrawals.length === 0) return null;
  return (
    <Block title="Withdrawal requests" nested={nested}>
      <ul className="tasks" aria-label="Withdrawal requests">
        {withdrawals.map((w) => (
          <li key={w.id}>
            <div>
              <StateBadge state={w.state} /> requested <When at={w.requestedAt} />
              {w.decidedAt && (
                <>
                  , decided <When at={w.decidedAt} />
                </>
              )}
            </div>
            {w.reason !== undefined && <div>Reason: {w.reason}</div>}
            {w.employeeMessage && <div>{`${ownView ? 'Message from HR' : 'Message to the employee'}: ${w.employeeMessage}`}</div>}
            {action?.(w)}
          </li>
        ))}
      </ul>
    </Block>
  );
}

/**
 * Decisions in time order. The resignation's own decisions come first (a withdrawal request needs an approved
 * resignation), so a decision of another transaction is a withdrawal decision.
 */
export function DecisionTrail({ decisions, nested }: { decisions: ExitDecision[]; nested?: boolean }) {
  if (decisions.length === 0) return null;
  const exitTransaction = decisions[0]?.transactionId;
  const label = (d: ExitDecision) =>
    d.transactionId !== exitTransaction ? 'Withdrawal decision' : d.action === 'recommend' ? 'Recommendation of the last working date' : d.action === 'approve' ? 'HR decision' : readable(d.action);
  return (
    <Block title="Decisions" nested={nested}>
      <ul aria-label="Decisions">
        {decisions.map((d, i) => (
          <li key={`${d.transactionId}-${d.step}-${i}`}>
            {`${label(d)} (step ${d.step}): ${DECISION_LABEL[d.decision] ?? readable(d.decision).toLowerCase()} on `}
            <When at={d.decidedAt} />
          </li>
        ))}
      </ul>
    </Block>
  );
}

function exitStateChange(e: ExitEvent): string {
  if (e.fromState === e.toState) return readable(e.toState);
  return `${e.fromState === 'NONE' ? 'New' : readable(e.fromState)} → ${readable(e.toState)}`;
}
function statusChange(e: ExitEvent): string {
  if (!e.employeeStatusBefore && !e.employeeStatusAfter) return '—';
  return `${e.employeeStatusBefore ? statusLabel(e.employeeStatusBefore) : '—'} → ${e.employeeStatusAfter ? statusLabel(e.employeeStatusAfter) : '—'}`;
}

/** Every step, with the employee's status changes (NOTICE on approval, separation after the last working date). */
export function ExitHistory({ history, nested, ownView }: { history: ExitEvent[]; nested?: boolean; ownView?: boolean }) {
  const { me } = useSession();
  const myUserId = me?.userId ?? null;
  return (
    <Block title="History" nested={nested}>
      {history.length === 0 ? (
        <Empty>Nothing recorded yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Exit history">
            <thead>
              <tr>
                <th>Business date</th>
                <th>Recorded</th>
                <th>Step</th>
                <th>State</th>
                <th>Last working date</th>
                <th>Employee status</th>
                {!ownView && <th>By</th>}
              </tr>
            </thead>
            <tbody>
              {history.map((e, i) => (
                <tr key={`${e.occurredAt}-${i}`}>
                  <td>{formatDate(e.businessDate)}</td>
                  <td>
                    <When at={e.occurredAt} />
                  </td>
                  <td>{EXIT_ACTION_LABEL[e.action] ?? readable(e.action)}</td>
                  <td>{exitStateChange(e)}</td>
                  <td>{formatDate(e.lastWorkingDate)}</td>
                  <td>{statusChange(e)}</td>
                  {!ownView && <td>{userText(e.actorUserId, myUserId)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Block>
  );
}
