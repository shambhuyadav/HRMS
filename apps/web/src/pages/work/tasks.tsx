// Decision inbox (FR-060): the decision tasks assigned to the user, with the expense task.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { QuietWhenEmptyContext } from '@/components/card-context';
import { ButtonRow } from '@/components/form-field';
import { Hint, HintLine } from '@/components/hint';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, download, formatAmount, formatDate, idempotencyKey } from '../../api';
import { MODULE_TASK_QUEUES } from '../../screens-registry';
import { useSession } from '../../session';
import { Badge, CompactEmptyContext, Empty, ErrorNote, Section } from '../../ui';
import { DelegatedBadge, DelegatedTasksSection } from '../delegations';
import { describeWindow, type Evidence, EvidenceList, KIND_LABEL, WorkTaskEvidence } from '../requests';
import { leaveEvidencePath } from './leave';

// ---------------------------------------------------------------------------------------------------------
// Decision inbox (FR-060): leave, work-request, profile-change, attendance-correction, confirmation, expense and
// increment tasks assigned to the user. Every item says what is being decided.
// ---------------------------------------------------------------------------------------------------------

/** GET /v1/leave/tasks: what a leave request or a cancellation of approved leave decides (operational only). */
interface LeaveSummary {
  /** The leave request the task decides; its evidence route takes this id. */
  requestId?: string;
  leaveType: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  /** Decimal string with 4 places. */
  units: string;
  isCancellation: boolean;
  /** The supporting documents of the leave's current revision (FR-026, FR-106). */
  evidence?: Evidence[];
}
/** GET /v1/work-requests/tasks/mine. */
interface WorkSummary {
  /** The request the task decides (its evidence route takes this id). */
  requestId?: string;
  kind: 'outdoor_duty' | 'holiday_work';
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  purpose: string;
  /** The supporting documents of the revision being decided (metadata only; FR-027, FR-106). */
  evidence?: Evidence[];
}
/** GET /v1/profile-changes/tasks/mine: the requested values, the values when requested and the record now. */
interface ProfileChangeView {
  employeeName: string;
  employeeCode: string;
  requested: Record<string, string>;
  currentValues: Record<string, string | null> | null;
  recordNow: Record<string, string | null> | null;
}
/** GET /v1/attendance-corrections/tasks/mine; `reason` is present only for a reviewer with the reason grant. */
interface CorrectionView {
  employeeName: string;
  employeeCode: string;
  workDate: string;
  currentStatus: string;
  requestedStatus: string;
  reason?: string | null;
}

interface Task {
  taskId: string;
  kind: string;
  ownerEmployeeCode: string | null;
  ownerName: string | null;
  assignedAt: string;
  transactionId: string;
  stepAction: string;
  /** Present on expense tasks: the claim this task decides. */
  claimId?: string | null;
  /** Leave and work-request tasks. */
  summary?: LeaveSummary | WorkSummary | null;
  /** Profile-change and attendance-correction tasks. */
  request?: ProfileChangeView | CorrectionView | null;
}

interface Queue {
  permission: string;
  path: string;
  decide: (id: string) => string;
  needsReason: boolean;
  /** Profile changes and attendance corrections are approved or rejected, never returned (I-11, I-12). */
  canReturn: boolean;
  title: string;
}

const QUEUES: Queue[] = [
  { permission: 'leave.approve.operational', path: '/v1/leave/tasks', decide: (id) => `/v1/leave/tasks/${id}/decision`, needsReason: false, canReturn: true, title: 'Leave requests' },
  {
    permission: 'leave.approve.operational',
    path: '/v1/work-requests/tasks/mine',
    decide: (id) => `/v1/work-requests/tasks/${id}/decision`,
    needsReason: false,
    canReturn: true,
    title: 'Outdoor duty and holiday work',
  },
  {
    permission: 'employee.update.operational',
    path: '/v1/profile-changes/tasks/mine',
    decide: (id) => `/v1/profile-changes/tasks/${id}/decision`,
    needsReason: false,
    canReturn: false,
    title: 'Profile changes',
  },
  {
    permission: 'attendance.approve_correction.operational',
    path: '/v1/attendance-corrections/tasks/mine',
    decide: (id) => `/v1/attendance-corrections/tasks/${id}/decision`,
    needsReason: false,
    canReturn: false,
    title: 'Attendance corrections',
  },
  {
    permission: 'confirmation.decide.operational',
    path: '/v1/confirmations/tasks/mine',
    decide: (id) => `/v1/confirmations/tasks/${id}/decision`,
    needsReason: true,
    canReturn: true,
    title: 'Confirmation reviews',
  },
  { permission: 'expense.read.operational', path: '/v1/expense/tasks', decide: (id) => `/v1/expense/tasks/${id}/decision`, needsReason: false, canReturn: true, title: 'Expense claims' },
  {
    permission: 'increment.approve.salary',
    path: '/v1/increment-cases/tasks/mine',
    decide: (id) => `/v1/increment-cases/tasks/${id}/decision`,
    needsReason: true,
    canReturn: true,
    title: 'Increment cases',
  },
];

/** Whether the role decides anything: a role with no decision queue has no Decisions page in its menu. */
export const hasDecisionQueues = (can: (permission: string) => boolean) => QUEUES.some((q) => can(q.permission)) || MODULE_TASK_QUEUES.some((q) => can(q.permission));

export function TasksPage() {
  const { can } = useSession();
  const visible = QUEUES.filter((q) => can(q.permission));
  // Wave-2 module queues (screens-registry.ts); each renders its own section and checks its own decision keys.
  const modules = MODULE_TASK_QUEUES.filter((q) => can(q.permission));
  if (visible.length === 0 && modules.length === 0) return <Empty>You have no decision queues in this role.</Empty>;
  // A queue with nothing waiting is one quiet line after the queues that have something (QuietWhenEmptyContext; styles.css,
  // .decision-queues, lays the lines out). The `tasks` marker class of each queue's list and the compact empty states are what those
  // rules look for.
  return (
    <CompactEmptyContext.Provider value={true}>
      <QuietWhenEmptyContext.Provider value={true}>
        <div className="decision-queues">
          <DelegatedTasksSection />
          {visible.map((q) => (
            <TaskQueue key={q.path} queue={q} />
          ))}
          {modules.map((q) => (
            <q.component key={q.title} />
          ))}
        </div>
      </QuietWhenEmptyContext.Provider>
    </CompactEmptyContext.Provider>
  );
}

function TaskQueue({ queue }: { queue: Queue }) {
  // The key carries the company and assignment: one role's queue is never shown under another (prefix ['tasks'] still invalidates it).
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  const tasks = useQuery({ queryKey: ['tasks', queue.path, context], queryFn: () => api<{ items: Task[] }>(queue.path) });
  return (
    <Section title={`${queue.title}${tasks.data ? ` (${tasks.data.items.length})` : ''}`}>
      {tasks.data?.items.length === 0 && <Empty>Nothing waiting for you.</Empty>}
      <ul className="tasks">
        {tasks.data?.items.map((t) => (t.kind === 'expense_claim' ? <ExpenseTask key={t.taskId} task={t} /> : <DecisionTask key={t.taskId} task={t} queue={queue} />))}
      </ul>
      <ErrorNote error={tasks.error} />
    </Section>
  );
}

const statusText = (code: string) => code.replace(/_/g, ' ').toLowerCase();
const PROFILE_FIELD_LABEL: Record<string, string> = { displayName: 'Display name', workEmail: 'Work email' };

/** What the task decides, from the summary or request the queue endpoint returned with it. */
function TaskDetails({ task: t }: { task: Task }) {
  if ((t.kind === 'leave_request' || t.kind === 'leave_cancellation') && t.summary) {
    const s = t.summary as LeaveSummary;
    const halfDayNote = s.halfDay ? ' (half day)' : '';
    const when = s.halfDay || s.startDate === s.endDate ? `${formatDate(s.startDate)}${halfDayNote}` : `${formatDate(s.startDate)} – ${formatDate(s.endDate)}`;
    return (
      <>
        <div>{`${s.leaveType} · ${when} · ${Number(s.units).toFixed(2)} days`}</div>
        {s.requestId && !!s.evidence?.length && (
          <div>
            <Hint as="span">Supporting documents:</Hint> <EvidenceList evidence={s.evidence} openPath={(documentId) => leaveEvidencePath(s.requestId!, documentId)} />
          </div>
        )}
      </>
    );
  }
  if ((t.kind === 'outdoor_duty' || t.kind === 'holiday_work') && t.summary) {
    const s = t.summary as WorkSummary;
    return (
      <>
        <div>{`${KIND_LABEL[s.kind] ?? s.kind} · ${describeWindow(s)}`}</div>
        <div>{s.purpose}</div>
        {s.evidence && <WorkTaskEvidence summary={s} />}
      </>
    );
  }
  if (t.kind === 'profile_change' && t.request) {
    const r = t.request as ProfileChangeView;
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Field</TableHead>
            <TableHead scope="col">Current record</TableHead>
            <TableHead scope="col">Requested</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.keys(r.requested ?? {}).map((field) => {
            const now = r.recordNow?.[field] ?? null;
            const then = r.currentValues?.[field] ?? null;
            return (
              <TableRow key={field}>
                <TableCell>{PROFILE_FIELD_LABEL[field] ?? field}</TableCell>
                <TableCell>
                  <span>{now ?? '—'}</span>
                  {then !== now && (
                    <>
                      {' '}
                      <Hint as="span">was {then ?? '—'} when requested</Hint>
                    </>
                  )}
                </TableCell>
                <TableCell>{r.requested[field]}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }
  if (t.kind === 'attendance_correction' && t.request) {
    const r = t.request as CorrectionView;
    return (
      <>
        <div>{`${formatDate(r.workDate)}: ${statusText(r.currentStatus)} → ${statusText(r.requestedStatus)}`}</div>
        {r.reason && (
          <div>
            <Hint as="span">Reason (private):</Hint> <span>{r.reason}</span>
          </div>
        )}
      </>
    );
  }
  return null;
}

/** When the queue's decisions need a reason, said in the reason field. */
function reasonPlaceholder(queue: Queue): string {
  if (queue.needsReason) return 'Reason (required)';
  return queue.canReturn ? 'Reason (required to reject or return)' : 'Reason (required to reject)';
}

function DecisionTask({ task: t, queue }: { task: Task; queue: Queue }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'RETURN' | 'REJECT') =>
      api(queue.decide(t.taskId), { body: { decision, idempotencyKey: idempotencyKey('ui'), ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  const cancellation = t.kind === 'leave_cancellation' || (t.summary as LeaveSummary | null | undefined)?.isCancellation === true;
  // Returning and rejecting always need a reason (the decision record refuses one without it); the confirmation
  // and increment decision routes need one for approval too.
  const noReason = reason.trim() === '';
  return (
    <li>
      <div>
        <strong>{t.ownerName ?? 'Request'}</strong> {cancellation && <Badge tone="warn">cancel approved leave</Badge>}{' '}
        <Hint as="span">
          {t.ownerEmployeeCode} · assigned {formatDate(t.assignedAt)}
        </Hint>
        <DelegatedBadge taskId={t.taskId} />
      </div>
      <TaskDetails task={t} />
      <Input aria-label="Decision reason" placeholder={reasonPlaceholder(queue)} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      <ButtonRow>
        <Button disabled={decide.isPending || (queue.needsReason && noReason)} onClick={() => decide.mutate('APPROVE')}>
          Approve
        </Button>
        {queue.canReturn && !cancellation && (
          <Button variant="outline" disabled={decide.isPending || noReason} onClick={() => decide.mutate('RETURN')}>
            Return
          </Button>
        )}
        <Button variant="danger" disabled={decide.isPending || noReason} onClick={() => decide.mutate('REJECT')}>
          Reject
        </Button>
      </ButtonRow>
      <ErrorNote error={decide.error} />
    </li>
  );
}

interface ClaimLine {
  id: string;
  sequence: number;
  category: string;
  expenseDate: string;
  merchant: string;
  invoiceReference?: string | null;
  claimedAmount: string;
  description: string;
  exceptionFlags: string[];
  receiptPresent: boolean;
  /** FR-106: attached is not usable; only a CLEAN receipt opens. */
  receiptScanState?: string | null;
  /** The limit the line was judged under at submission (FR-078). */
  appliedLimit?: string | null;
  /** Only with the expense reason grant (DF02). */
  exceptionReason?: string | null;
  decisionReason?: string | null;
  /** I-87: paid in another currency, converted at submission at this frozen rate. */
  currency?: string | null;
  sourceClaimedAmount?: string | null;
  exchangeRate?: string | null;
}

const receiptReleased = (l: ClaimLine) => !l.receiptScanState || l.receiptScanState === 'CLEAN';

/** A line's receipt in words: missing, quarantined, attached (released by the malware scan) or still waiting for the scan. */
function receiptWords(l: ClaimLine): string {
  if (!l.receiptPresent) return 'missing';
  if (l.receiptScanState === 'QUARANTINED') return 'quarantined by the malware scan';
  return receiptReleased(l) ? 'attached' : 'waiting for the malware scan';
}

/** The claim's earlier revisions, a muted list under its purpose (the old `ul.hint`). */
const EARLIER_REVISIONS = 'text-[0.84rem] text-muted-foreground';

/**
 * Expense decision (FR-072/073/075, C5). The financial step decides an amount for every line (0..claimed) and needs a
 * reason for any reduction and for accepting any flagged line; manager and high-value steps approve, return or reject
 * the claim as submitted.
 */
function ExpenseTask({ task }: { task: Task }) {
  const qc = useQueryClient();
  const finance = task.stepAction === 'finance_decide';
  const { can } = useSession();
  const viewReceipt = useMutation({ mutationFn: (lineId: string) => download(`/v1/expense/lines/${lineId}/receipt`) });
  const claimQuery = useQuery({
    queryKey: ['claim-for-task', task.claimId],
    enabled: !!task.claimId,
    queryFn: () =>
      api<{ id: string; purpose: string; currency: string; lines: ClaimLine[]; revisions?: { revision: number; purpose: string | null; claimedTotal: string }[] }>(`/v1/expense/claims/${task.claimId}`),
  });
  const claim = claimQuery.data;
  const [allowed, setAllowed] = useState<Record<string, string>>({});
  const [lineReason, setLineReason] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: string) =>
      api(`/v1/expense/tasks/${task.taskId}/decision`, {
        body: {
          decision,
          idempotencyKey: idempotencyKey('ui'),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
          ...(finance && decision === 'APPROVE' && claim
            ? {
                lines: claim.lines.map((l) => ({
                  lineId: l.id,
                  allowedAmount: allowed[l.id] ?? Number(l.claimedAmount).toFixed(2),
                  ...(lineReason[l.id]?.trim() ? { reason: lineReason[l.id]!.trim() } : {}),
                })),
              }
            : {}),
        },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['tasks'] }),
  });
  // Returning and rejecting need a reason (the decision record refuses one without it).
  const noReason = reason.trim() === '';
  // A flagged line is accepted only with a recorded clearance reason, at any amount, and so is one whose receipt the scan has
  // not released, which the flags frozen at submission may not show (the server refuses either without it).
  const unclearedLines = finance && !!claim?.lines.some((l) => (l.exceptionFlags.length > 0 || !receiptReleased(l)) && !lineReason[l.id]?.trim());

  return (
    <li>
      <div>
        <strong>{task.ownerName ?? 'Claim'}</strong>{' '}
        <Hint as="span">
          {task.ownerEmployeeCode} · {finance ? 'financial review' : task.stepAction.replace(/_/g, ' ')} · assigned {formatDate(task.assignedAt)}
        </Hint>
        <DelegatedBadge taskId={task.taskId} />
      </div>
      {claim && (
        <>
          <div>{claim.purpose}</div>
          {claim.revisions && claim.revisions.length > 1 && (
            <ul className={EARLIER_REVISIONS} aria-label="Earlier revisions">
              {claim.revisions.slice(0, -1).map((r) => (
                <li key={r.revision}>{`Revision ${r.revision}, ${formatAmount(r.claimedTotal, claim.currency)}: ${r.purpose ?? 'purpose not recorded'}`}</li>
              ))}
            </ul>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">#</TableHead>
                <TableHead scope="col">Category</TableHead>
                <TableHead scope="col">Date</TableHead>
                <TableHead scope="col">Merchant</TableHead>
                <TableHead scope="col">Claimed</TableHead>
                <TableHead scope="col">Flags</TableHead>
                <TableHead scope="col">Receipt</TableHead>
                {finance && <TableHead scope="col">Approved amount</TableHead>}
                {finance && <TableHead scope="col">Reason (reduction or flagged line)</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {claim.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.sequence}</TableCell>
                  <TableCell>{l.category}</TableCell>
                  <TableCell>{formatDate(l.expenseDate)}</TableCell>
                  <TableCell>
                    {l.merchant}
                    {l.invoiceReference && <HintLine>Invoice {l.invoiceReference}</HintLine>}
                  </TableCell>
                  <TableCell>
                    {formatAmount(l.claimedAmount, claim.currency)}
                    {l.currency && l.sourceClaimedAmount && <HintLine>{`Paid ${formatAmount(l.sourceClaimedAmount, l.currency)} at ${Number(l.exchangeRate)} ${claim.currency} each`}</HintLine>}
                    {l.appliedLimit && <HintLine>Limit {formatAmount(l.appliedLimit, claim.currency)}</HintLine>}
                  </TableCell>
                  <TableCell>
                    {l.exceptionFlags.length ? l.exceptionFlags.join(', ').toLowerCase().replace(/_/g, ' ') : '—'}
                    {l.exceptionReason && <HintLine>Claimant: {l.exceptionReason}</HintLine>}
                    {l.decisionReason && <HintLine>Reviewer: {l.decisionReason}</HintLine>}
                  </TableCell>
                  <TableCell>
                    {receiptWords(l)}{' '}
                    {l.receiptPresent && receiptReleased(l) && can('expense.view_receipt.receipt') && (
                      <Button type="button" variant="outline" size="sm" onClick={() => viewReceipt.mutate(l.id)}>
                        View
                      </Button>
                    )}
                  </TableCell>
                  {finance && (
                    <TableCell>
                      <Input
                        aria-label={`Approved amount for line ${l.sequence}`}
                        inputMode="decimal"
                        className="w-auto"
                        value={allowed[l.id] ?? Number(l.claimedAmount).toFixed(2)}
                        onChange={(e) => setAllowed({ ...allowed, [l.id]: e.target.value })}
                      />
                    </TableCell>
                  )}
                  {finance && (
                    <TableCell>
                      <Input
                        aria-label={`Reason for line ${l.sequence}`}
                        className="w-auto"
                        value={lineReason[l.id] ?? ''}
                        onChange={(e) => setLineReason({ ...lineReason, [l.id]: e.target.value })}
                      />
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </>
      )}
      <Input aria-label="Decision reason" placeholder="Reason (required to reject or return)" maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      {unclearedLines && <Hint>Enter a reason for each flagged line to clear it before approving.{claim?.lines.some((l) => !receiptReleased(l)) ? ' A receipt the malware scan has not released counts as none.' : ''}</Hint>}
      <ButtonRow>
        <Button disabled={decide.isPending || unclearedLines} onClick={() => decide.mutate('APPROVE')}>
          {finance ? 'Approve amounts' : 'Approve'}
        </Button>
        <Button variant="outline" disabled={decide.isPending || noReason} onClick={() => decide.mutate('RETURN')}>
          Return
        </Button>
        <Button variant="danger" disabled={decide.isPending || noReason} onClick={() => decide.mutate('REJECT')}>
          Reject
        </Button>
      </ButtonRow>
      <ErrorNote error={claimQuery.error ?? decide.error ?? viewReceipt.error} />
    </li>
  );
}
