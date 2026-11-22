// My ESS (H3 own-record context): the employee's own resignation and processes, as panels and screens.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useId, useState } from 'react';
import { CardSubheading } from '@/components/card-subheading';
import { ConfirmBox } from '@/components/confirm-box';
import { ButtonRow, FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, formatDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, LIST_PAGE_SIZE, NotPermitted, Pager, Section, StateBadge } from '../../ui';
import { DecisionTrail, ExitFacts, ExitHistory, WithdrawalList } from './exits';
import { ProcessView } from './process-view';
import { type Act, type Done, Refusal, reportGone } from './refusals';
import { EXIT_READ, EXIT_SUBMIT, inOwnContext, ISO_DATE, Notice, type NoticeState, OPEN_EXIT_STATES, type Paged, pagedUrl, Problem, PROCESS_READ, QueryProblem, ReasonField, shown, totalOf, typeLabel, useKeys } from './shared';
import type { ExitDetail, ProcessSummary, ResignationResult } from './types';

// ---------------------------------------------------------------------------------------------------------
// My ESS (H3 own-record context): the employee's own resignation and processes, through the module's own routes
// (/v1/me/resignation, /v1/me/exit-cases, /v1/me/processes). No H3 tab (TN01–TN18) covers them and the lifecycle
// registration declares no essTabs, so these panels carry ids of their own.
// ---------------------------------------------------------------------------------------------------------
function OwnContextNote({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Section title={title}>
      <Empty>{children}</Empty>
    </Section>
  );
}

export function MyResignationPanel() {
  const { me, can } = useSession();
  if (!me) return <OwnContextNote title="Resignation">Loading your role…</OwnContextNote>;
  if (!inOwnContext(me)) return <OwnContextNote title="Resignation">Your own resignation is handled in your Employee role. Switch to it to submit or follow one.</OwnContextNote>;
  if (!can(EXIT_READ) && !can(EXIT_SUBMIT)) {
    return (
      <Section title="Resignation">
        <NotPermitted>Your Employee role does not include resignations yet; contact HR.</NotPermitted>
      </Section>
    );
  }
  return <OwnResignation />;
}

function OwnResignation() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canRead = can(EXIT_READ);
  const canSubmit = can(EXIT_SUBMIT);
  const exits = useQuery({ enabled: canRead, queryKey: keys.myExits, queryFn: () => api<{ items: ExitDetail[] }>('/v1/me/exit-cases'), retry: retryTransient });
  const [notice, setNotice] = useState<NoticeState>(null);
  const items = canRead ? shown(exits)?.items : undefined;
  const current = items?.find((x) => OPEN_EXIT_STATES.has(x.state)) ?? null;
  const earlier = (items ?? []).filter((x) => x !== current);
  const done: Done = (text, ok = true) => {
    setNotice({ text, ok });
    void qc.invalidateQueries({ queryKey: keys.exits });
  };
  const loading = canRead && exits.isPending;
  return (
    <Section title="Resignation">
      <Notice notice={notice} />
      {loading && <LoadingLine>Loading your resignations…</LoadingLine>}
      {canRead && <QueryProblem error={exits.error} forbidden="Your Employee role cannot view resignations." />}
      {/* With no open resignation the form says what to do; the empty note is only for a role that cannot resign. */}
      {current ? <OwnExitCard exit={current} canAct={canSubmit} onDone={done} /> : items && !canSubmit && <Empty>You have no open resignation.</Empty>}
      {canSubmit && !current && !loading && <ResignationForm onDone={done} />}
      {earlier.length > 0 && (
        <div className="stack">
          <CardSubheading>Earlier resignations</CardSubheading>
          <ul className="tasks" aria-label="Earlier resignations">
            {earlier.map((x) => (
              <li key={x.id}>
                <div>
                  <StateBadge state={x.state} /> {`resigned ${formatDate(x.requestDate)}, last working date ${formatDate(x.lastWorkingDate)}`}
                </div>
                {x.employeeMessage && <div>{`Message from HR: ${x.employeeMessage}`}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/** Own-exit refusals after which the action is gone once the exit reloads (it was decided or changed meanwhile). */
const OWN_EXIT_GONE: ReadonlySet<string> = new Set(['INVALID_STATE', 'USE_WITHDRAWAL_REQUEST', 'WITHDRAWAL_PENDING', 'EXIT_RELEASED', 'OPEN_EXIT_EXISTS', 'NOT_FOUND']);

/** A refused own-exit action: the own exits reload when the refusal says they changed; see OWN_EXIT_GONE. */
function useOwnExitRefusal(action: Act, onDone: Done) {
  const keys = useKeys();
  const qc = useQueryClient();
  return (error: Error) => {
    if (!(error instanceof ApiError)) return;
    if (error.status === 409 || error.status === 404) void qc.invalidateQueries({ queryKey: keys.exits });
    reportGone(error, action, OWN_EXIT_GONE, onDone);
  };
}

function OwnExitCard({ exit: x, canAct, onDone }: { exit: ExitDetail; canAct: boolean; onDone: Done }) {
  const pending = x.withdrawals.find((w) => w.state === 'SUBMITTED') ?? null;
  const withdrawRefused = useOwnExitRefusal('withdraw', onDone);
  const cancelRefused = useOwnExitRefusal('withdrawal-cancel', onDone);
  const withdraw = useMutation({
    mutationFn: () => api<{ exitCaseId: string; state: string }>(`/v1/me/exit-cases/${x.id}/withdraw`, { method: 'POST' }),
    onSuccess: () => onDone('Your resignation is withdrawn. The request and its history are kept.'),
    onError: withdrawRefused,
  });
  const cancelRequest = useMutation({
    mutationFn: (withdrawalId: string) => api<{ withdrawalId: string; state: string }>(`/v1/me/exit-withdrawals/${withdrawalId}/cancel`, { method: 'POST' }),
    onSuccess: () => onDone('Your withdrawal request is cancelled; your approved resignation stands.'),
    onError: cancelRefused,
  });
  const canWithdraw = canAct && (x.state === 'SUBMITTED' || x.state === 'RECOMMENDED');
  const canRequest = canAct && x.state === 'APPROVED' && !x.released && pending === null;
  return (
    <article aria-label="Your resignation" className="stack">
      <ExitFacts x={x} ownView />
      {canWithdraw && (
        <div className="stack">
          <Hint className="m-0">Until HR decides, you can withdraw your resignation yourself.</Hint>
          <div>
            <Button type="button" variant="danger" disabled={withdraw.isPending} onClick={() => withdraw.mutate()}>
              Withdraw my resignation
            </Button>
          </div>
          <Refusal error={withdraw.error} action="withdraw" except={OWN_EXIT_GONE} />
        </div>
      )}
      {canRequest && <WithdrawalRequestForm exit={x} onDone={onDone} />}
      <WithdrawalList
        withdrawals={x.withdrawals}
        nested
        ownView
        action={(w) =>
          canAct && w.state === 'SUBMITTED' ? (
            <>
              <div>
                <Button type="button" variant="outline" disabled={cancelRequest.isPending} onClick={() => cancelRequest.mutate(w.id)}>
                  Cancel my withdrawal request
                </Button>
              </div>
              <Refusal error={cancelRequest.error} action="withdrawal-cancel" except={OWN_EXIT_GONE} />
            </>
          ) : null
        }
      />
      <DecisionTrail decisions={x.decisions} nested />
      <ExitHistory history={x.history} nested ownView />
    </article>
  );
}

function WithdrawalRequestForm({ exit: x, onDone }: { exit: ExitDetail; onDone: Done }) {
  const refused = useOwnExitRefusal('withdrawal-request', onDone);
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const request = useMutation({
    mutationFn: (text: string) => api<{ withdrawalId: string; exitCaseId: string; state: string }>(`/v1/me/exit-cases/${x.id}/withdrawal-request`, { body: { reason: text } }),
    onSuccess: () => {
      setReason('');
      onDone('Your withdrawal request was sent. An HR Administrator decides it independently; until then your approved resignation stands.');
    },
    onError: refused,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (request.isPending) return;
    const text = reason.trim();
    setProblem(text ? null : 'Enter why you want to withdraw your resignation.');
    if (!text) {
      request.reset();
      return;
    }
    request.mutate(text);
  };
  return (
    <form aria-label="Request to withdraw your resignation" className="stack" onSubmit={submit}>
      <Hint className="m-0">Your resignation is approved, so withdrawing it needs an independent HR decision. You can ask until your last working date.</Hint>
      <ReasonField label="Why do you want to withdraw it? (required)" value={reason} onChange={setReason} />
      <Problem text={problem} />
      <div>
        <Button type="submit" disabled={request.isPending}>
          Request withdrawal
        </Button>
      </div>
      <Refusal error={request.error} action="withdrawal-request" except={OWN_EXIT_GONE} />
    </form>
  );
}

function ResignationForm({ onDone }: { onDone: Done }) {
  const refused = useOwnExitRefusal('resign', onDone);
  const [date, setDate] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  // Resigning is not a click to make by accident: the checked form first asks for a confirmation that names the date.
  const [confirming, setConfirming] = useState(false);
  // The optional reason code is not asked of the employee (HR codes are internal): none is sent.
  const submit = useMutation({
    mutationFn: (body: { proposedLastWorkingDate: string; reason?: string }) => api<ResignationResult>('/v1/me/resignation', { body }),
    onSuccess: (r) => {
      setConfirming(false);
      setDate('');
      setReason('');
      onDone(
        `Your resignation was submitted on ${formatDate(r.requestDate)} with the proposed last working date ${formatDate(r.proposedLastWorkingDate)}. Your manager recommends the last working date, then HR decides.`,
      );
    },
    // An open resignation recorded meanwhile (another tab): it shows once the list reloads, in place of this form. A refusal
    // returns to the form, so what it says can be corrected.
    onError: (error) => {
      setConfirming(false);
      refused(error);
    },
  });
  const check = (): boolean => {
    const issue: string | null = ISO_DATE.test(date) ? null : 'Choose your proposed last working day.';
    setProblem(issue);
    if (issue) submit.reset();
    return !issue;
  };
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (submit.isPending) return;
    if (check()) setConfirming(true);
  };
  const confirm = () => {
    if (submit.isPending || !check()) return;
    const text = reason.trim();
    submit.mutate({ proposedLastWorkingDate: date, ...(text ? { reason: text } : {}) });
  };
  // Any change to what was confirmed asks again.
  const edit = <T,>(set: (v: T) => void) => (v: T) => {
    setConfirming(false);
    set(v);
  };
  return (
    <form aria-label="Submit your resignation" className="stack" onSubmit={send}>
      {/* The card's "Resignation" heading is the form's heading: no second one. */}
      <Hint className="m-0">Choose your proposed last working day. Your manager and HR review it; you can withdraw until HR decides.</Hint>
      <FormField>
        Proposed last working day (you work on this day)
        <Input type="date" value={date} onChange={(e) => edit(setDate)(e.target.value)} />
      </FormField>
      <ReasonField label="Reason (optional; seen by you and authorised reviewers only)" value={reason} onChange={edit(setReason)} />
      <Problem text={problem} />
      {confirming ? (
        <ConfirmBox role="group" aria-label="Confirm your resignation">
          <p>
            You are resigning with <strong>{formatDate(date)}</strong> as your last working day. You can withdraw it yourself until HR decides.
          </p>
          <ButtonRow>
            <Button type="button" variant="danger" disabled={submit.isPending} onClick={confirm}>
              Yes, submit my resignation
            </Button>
            <Button type="button" variant="outline" disabled={submit.isPending} onClick={() => setConfirming(false)}>
              Go back
            </Button>
          </ButtonRow>
        </ConfirmBox>
      ) : (
        <div>
          <Button type="submit" disabled={submit.isPending}>
            Submit resignation
          </Button>
        </div>
      )}
      <Refusal error={submit.error} action="resign" except={OWN_EXIT_GONE} />
    </form>
  );
}

export function MyProcessesPanel() {
  const { me, can } = useSession();
  if (!me) return <OwnContextNote title="Processes and tasks">Loading your role…</OwnContextNote>;
  if (!inOwnContext(me)) return <OwnContextNote title="Processes and tasks">Your own processes are shown in your Employee role. Switch to it to follow them.</OwnContextNote>;
  if (!can(PROCESS_READ)) {
    return (
      <Section title="Processes and tasks">
        <NotPermitted>Your Employee role does not include processes yet; contact HR.</NotPermitted>
      </Section>
    );
  }
  return <OwnProcesses />;
}

function OwnProcesses() {
  const keys = useKeys();
  const panelId = useId();
  const [page, setPage] = useState(1);
  const list = useQuery({ queryKey: [...keys.myProcesses, page], queryFn: () => api<Paged<ProcessSummary>>(pagedUrl('/v1/me/processes', page)), retry: retryTransient });
  const [openId, setOpenId] = useState<string | null>(null);
  const data = shown(list);
  return (
    <Section title="Processes and tasks">
      <Hint>Your own record only: processes about you, such as onboarding or exit clearance. Tasks owned by the Employee role are yours to complete.</Hint>
      {list.isPending && <LoadingLine>Loading your processes…</LoadingLine>}
      <QueryProblem error={list.error} forbidden="Your Employee role cannot view processes." />
      {data && data.items.length === 0 && <Empty>No processes about you right now. HR starts one, such as onboarding, when it applies to you.</Empty>}
      {data && data.items.length > 0 && (
        <Table aria-label="My processes">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Process</TableHead>
              <TableHead scope="col">Type</TableHead>
              <TableHead scope="col">State</TableHead>
              <TableHead scope="col">Effective date</TableHead>
              <TableHead scope="col">Open tasks</TableHead>
              <TableHead scope="col">Overdue</TableHead>
              <TableHead scope="col">Tasks</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.processName}</TableCell>
                <TableCell>{typeLabel(p.processType)}</TableCell>
                <TableCell>
                  <StateBadge state={p.state} />
                </TableCell>
                <TableCell>{formatDate(p.effectiveDate)}</TableCell>
                <TableCell>{`${p.openTasks} of ${p.taskCount}`}</TableCell>
                <TableCell>{p.overdueTasks > 0 ? <Badge tone="bad">{`${p.overdueTasks} overdue`}</Badge> : '0'}</TableCell>
                <RowActionsCell>
                  <RowActions>
                    <Button type="button" variant="outline" size="sm" aria-expanded={openId === p.id} aria-controls={panelId} onClick={() => setOpenId(openId === p.id ? null : p.id)}>
                      {openId === p.id ? 'Hide tasks' : 'Show tasks'}
                    </Button>
                  </RowActions>
                </RowActionsCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {data && <Pager page={page} pageSize={LIST_PAGE_SIZE} total={totalOf(data)} onPage={setPage} label="My process pages" noun="process" plural="processes" />}
      <div id={panelId} className="stack">
        {openId && <ProcessView key={openId} processId={openId} embedded />}
      </div>
    </Section>
  );
}

export function MyResignationScreen() {
  return (
    <>
      <h1>My resignation</h1>
      <MyResignationPanel />
    </>
  );
}

export function MyProcessesScreen() {
  return (
    <>
      <h1>My processes</h1>
      <MyProcessesPanel />
    </>
  );
}
