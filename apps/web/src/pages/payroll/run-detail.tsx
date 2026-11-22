// Payroll run detail: the run, its actions, totals, records, exceptions and component comparison.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { BackLink } from '@/components/back-link';
import { CardSubheading } from '@/components/card-subheading';
import { CheckField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { PagerButton, PagerRow } from '@/components/pager';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Notice, Section } from '../../ui';
import { statutoryNote } from './ess';
import { RecordHoldPanel } from './hold-proposals';
import { LoanRecoveries } from './loans';
import { Problem, ReasonForm } from './problems';
import { MemberExclusion, RunVerify } from './run-extras';
import { RunBank, RunPayslips } from './run-outputs';
import {
  BANK_READ,
  canReadRuns,
  Fact,
  HEAD_TYPE,
  HOLD_PROPOSE,
  HOLD_READ,
  involvement,
  label,
  LOAN_RECOVER,
  money,
  OUTPUT_PUBLISH,
  OUTPUT_READ,
  PATHS,
  REPORT_READ,
  RUN_APPROVE,
  RUN_CANCEL,
  RUN_PREPARE,
  RUN_PROCESS,
  RUN_READ_AMOUNT,
  RUN_STATE,
  Status,
  useKeys,
} from './shared';
import type { RunComponents, RunDetail, RunException, RunRecord, RunTotals } from './types';

// =========================================================================================================
// Payroll run detail
// =========================================================================================================

export function RunScreen() {
  const { can } = useSession();
  const { id = '' } = useParams();
  if (!canReadRuns(can)) {
    return (
      <Section title="Payroll run">
        <Empty refusal>The selected role cannot see payroll runs.</Empty>
      </Section>
    );
  }
  return <RunView key={id} id={id} />;
}

/** What the reader's own part in a revision rules out for them (independence of the run's steps). */
function involvementText(mine: string[]): string {
  let ruledOut = 'you do not give its covering approvals';
  if (mine.includes('created') || mine.includes('calculated')) ruledOut = 'you do not review, approve or process it';
  else if (mine.includes('reviewed')) ruledOut = 'you do not approve it or give its covering approvals';
  return `You ${mine.join(' and ')} this revision, so ${ruledOut}, and you never authorise its bank release or record its payment outcomes.`;
}

/** A step's progress in words: complete, under way or not started. */
function progressText(complete: boolean, started: boolean, done: string, going: string): string {
  if (complete) return done;
  return started ? going : 'Not started';
}

function RunView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const run = useQuery({ queryKey: keys.run(id), queryFn: () => api<RunDetail>(`/v1/payroll/runs/${encodeURIComponent(id)}`), retry: retryTransient });
  const r = run.data;
  if (run.isPending) return <LoadingLine>Loading the payroll run…</LoadingLine>;
  if (!r) {
    return (
      <Section title="Payroll run">
        <Problem error={run.error} act="read" />
        {/* Here the way back sits in the card under the refusal, not above the page title, so it keeps its place. */}
        <BackLink className="order-none mb-0" to={PATHS.runs}>
          Back to payroll runs
        </BackLink>
      </Section>
    );
  }
  const mine = involvement(r, me?.userId);
  const calculation = r.progress.calculation;
  const processing = r.progress.processing;
  return (
    <div className="stack">
      <Section
        title={`Payroll run ${r.period.periodCode} · revision ${r.revision}`}
        actions={
          <Button asChild variant="outline" size="sm">
            <Link to={PATHS.runs}>All runs</Link>
          </Button>
        }
      >
        <dl className="kv">
          <Fact term="State">
            <Status map={RUN_STATE} code={r.state} />
          </Fact>
          <Fact term="Calendar">{r.calendarCode}</Fact>
          <Fact term="Financial year">{r.period.financialYear}</Fact>
          <Fact term="Service period">{`${formatDate(r.period.serviceStart)} to ${formatDate(r.period.serviceEnd)}`}</Fact>
          <Fact term="Payment date">{formatDate(r.period.paymentDate)}</Fact>
          <Fact term="Members">{`${r.members.included} included, ${r.members.excluded} left out`}</Fact>
          <Fact term="Exceptions">{`${r.exceptions.unresolved} unresolved of ${r.exceptions.blocking} blocking; ${r.exceptions.warnings} warnings`}</Fact>
          <Fact term="Calculation">
            {progressText(calculation.complete, calculation.started, `Complete: ${calculation.calculated} records`, `In progress: ${calculation.calculated} of ${calculation.members}`)}
          </Fact>
          <Fact term="Processing">
            {progressText(processing.complete, processing.started, `Locked: ${processing.frozen} records frozen`, `In progress: ${processing.frozen} of ${processing.records} frozen`)}
          </Fact>
          {Object.keys(r.records).length > 0 && (
            <Fact term="Records">
              {Object.entries(r.records)
                .map(([k, n]) => `${readable(k)}: ${n}`)
                .join('; ')}
            </Fact>
          )}
          <Fact term="Submitted">{formatDate(r.submittedAt)}</Fact>
          <Fact term="Reviewed">{formatDate(r.reviewedAt)}</Fact>
          <Fact term="Approved">{formatDate(r.approvedAt)}</Fact>
          <Fact term="Processed">{formatDate(r.processedAt)}</Fact>
          {r.lockVersion !== null && <Fact term="Lock version">{r.lockVersion}</Fact>}
          {r.closeReason && <Fact term="Close reason">{r.closeReason}</Fact>}
        </dl>
        {r.paymentStatus === 'NOT_TRACKED_HERE' && <Hint>Payment is not tracked on the run: it comes only from the outcomes recorded on its bank manifests.</Hint>}
        {r.supersedesRunId && (
          <p className="my-1">
            <Link to={PATHS.run(r.supersedesRunId)}>Previous revision</Link>
          </p>
        )}
        {r.successorRunId && (
          <p className="my-1">
            <Link to={PATHS.run(r.successorRunId)}>Next revision</Link>
          </p>
        )}
        {can(REPORT_READ) && (
          <p className="my-1">
            <Link to={PATHS.reports(r.id)}>Reports of this run</Link>
          </p>
        )}
        {mine.length > 0 && <Hint role="note">{involvementText(mine)}</Hint>}
        {r.decisions.length > 0 && (
          <>
            <CardSubheading>Decisions</CardSubheading>
            <ul>
              {r.decisions.map((d, i) => (
                <li key={i}>{`${readable(d.action)}: ${readable(d.decision)} on ${formatDate(d.decidedAt)}`}</li>
              ))}
            </ul>
          </>
        )}
        <RunActions run={r} />
      </Section>
      {r.totals && <RunTotalsSection run={r} totals={r.totals} />}
      {can(RUN_READ_AMOUNT) && <RunRecords run={r} />}
      {can(RUN_READ_AMOUNT) && <RunComponentsSection run={r} />}
      {r.state === 'PROCESSED_LOCKED' && (can(OUTPUT_READ) || can(OUTPUT_PUBLISH)) && <RunPayslips run={r} />}
      {r.state === 'PROCESSED_LOCKED' && can(BANK_READ) && <RunBank run={r} />}
      {r.state === 'PROCESSED_LOCKED' && can(LOAN_RECOVER) && <LoanRecoveries run={r} />}
      {can(RUN_READ_AMOUNT) && r.progress.calculation.complete && <RunVerify key={`${r.id}:${r.version}`} run={r} />}
    </div>
  );
}

type RunAction = 'calculate' | 'submit' | 'process' | 'revise' | 'return' | 'cancel';

/** What a run action that worked leaves to do next, in words; null after a new revision opened (the screen moves to it). */
function actionNote(action: RunAction, result: RunDetail): string | null {
  if (action === 'calculate') {
    const c = result.progress.calculation;
    return c.complete ? `Calculated: ${c.calculated} records. Check the exceptions and totals, then submit it for review.` : `Calculation continues: ${c.calculated} of ${c.members} members calculated. Continue the calculation.`;
  }
  if (action === 'process') {
    const p = result.progress.processing;
    return result.state === 'PROCESSED_LOCKED'
      ? 'Processed and locked. Payslips and bank files can now be prepared; nothing has been paid.'
      : `Processing continues: ${p.frozen} of ${p.records} records frozen. Continue processing.`;
  }
  if (action === 'submit') return 'Submitted for an independent review.';
  if (action === 'cancel') return 'This revision was cancelled.';
  return null;
}

function RunActions({ run }: { run: RunDetail }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [note, setNote] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ action, body }: { action: RunAction; body: Record<string, unknown> }) =>
      api<RunDetail & { replayed?: boolean }>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/${action}`, { body: { ...body, expectedVersion: run.version } }),
    onSuccess: (result, { action }) => {
      const text = actionNote(action, result);
      setNote(text);
      if (text === null) navigate(PATHS.run(result.id));
    },
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: keys.runAll }), qc.invalidateQueries({ queryKey: keys.runsAll })]),
  });
  const send = (action: RunAction, body: Record<string, unknown> = {}) => {
    if (act.isPending) return Promise.reject(new Error('busy'));
    setNote(null);
    return act.mutateAsync({ action, body });
  };
  const userId = me?.userId;
  const busy = act.isPending;
  const live = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED'].includes(run.state) && !run.processingStartedAt;
  const calcStarted = run.progress.calculation.started;
  const notCalculator = run.preparedBy !== null && run.preparedBy !== userId;
  const runActor = run.createdBy === userId || run.preparedBy === userId;
  const controls: ReactNode[] = [];
  if (run.state === 'DRAFT' && can(RUN_PREPARE)) {
    controls.push(
      <div key="calculate">
        <Button type="button" disabled={busy || (calcStarted && notCalculator)} onClick={() => void send('calculate').catch(() => undefined)}>
          {calcStarted ? 'Continue the calculation' : 'Calculate'}
        </Button>
        {calcStarted && notCalculator && <Hint>The preparer who started this calculation continues it.</Hint>}
      </div>,
    );
    if (!calcStarted) controls.push(<MemberExclusion key="exclude" run={run} />);
  }
  if (run.state === 'CALCULATED' && can(RUN_PREPARE)) {
    controls.push(
      <div key="submit">
        <Button type="button" disabled={busy || notCalculator} onClick={() => void send('submit').catch(() => undefined)}>
          Submit for review
        </Button>
        {notCalculator && <Hint>Only the preparer who calculated this revision submits it.</Hint>}
      </div>,
      <ReasonForm
        key="revise"
        name="Return to a new draft revision"
        field="Why a new revision is needed"
        button="Return to a new draft revision"
        busy={busy}
        onSend={(reason) => send('revise', { reason })}
      />,
    );
  }
  if (run.state === 'IN_REVIEW') {
    controls.push(
      <Hint key="review">
        Waiting for the independent review and approval: <Link to={PATHS.decisions}>Run decisions</Link>.
      </Hint>,
    );
  }
  if (run.state === 'APPROVED' && can(RUN_PROCESS)) {
    controls.push(
      <div key="process">
        <Button type="button" disabled={busy || runActor} onClick={() => void send('process').catch(() => undefined)}>
          {run.processingStartedAt ? 'Continue processing' : 'Process and lock'}
        </Button>
        {runActor && <Hint>You created or calculated this run, so someone else processes it.</Hint>}
      </div>,
    );
    if (!run.processingStartedAt) {
      controls.push(
        <ReasonForm
          key="return"
          name="Return before processing"
          field="Why the approved revision is returned"
          button="Return before processing"
          busy={busy}
          onSend={(reason) => send('return', { reason })}
        />,
      );
    }
  }
  if (live && can(RUN_CANCEL)) {
    controls.push(<ReasonForm key="cancel" name="Cancel this revision" field="Reason for cancelling" button="Cancel this revision" busy={busy} danger onSend={(reason) => send('cancel', { reason })} />);
  }
  return (
    <div className="mt-3">
      <CardSubheading>Actions</CardSubheading>
      {controls.length === 0 ? <Hint>No action on this revision is available to the selected role.</Hint> : <div className="flex flex-col gap-3">{controls}</div>}
      <Notice notice={note ? { text: note, ok: true } : null} />
      <Problem error={act.error} act={act.variables?.action === 'process' ? 'process' : 'run'} />
    </div>
  );
}

function RunTotalsSection({ run, totals }: { run: RunDetail; totals: RunTotals[] }) {
  return (
    <Section title="Run totals">
      {run.scopeComplete === false && <Hint>Your scope covers part of this run: these totals are of the records in your scope only.</Hint>}
      {totals.length === 0 ? (
        <Empty>No records are calculated yet.</Empty>
      ) : (
        <Table aria-label="Run totals">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Currency</TableHead>
              <TableHead scope="col">Records</TableHead>
              <TableHead scope="col">Paid units</TableHead>
              <TableHead scope="col">Earnings</TableHead>
              <TableHead scope="col">Reimbursements</TableHead>
              <TableHead scope="col">Gross</TableHead>
              <TableHead scope="col">Deductions</TableHead>
              <TableHead scope="col">Net</TableHead>
              <TableHead scope="col">Employer contributions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {totals.map((t) => (
              <TableRow key={t.currencyCode}>
                <TableCell>{t.currencyCode}</TableCell>
                <TableCell>{t.records}</TableCell>
                <TableCell>{t.paidUnits ?? '—'}</TableCell>
                <TableCell>{money(t.earnings, t.currencyCode)}</TableCell>
                <TableCell>{money(t.reimbursements, t.currencyCode)}</TableCell>
                <TableCell>{money(t.gross, t.currencyCode)}</TableCell>
                <TableCell>{money(t.deductions, t.currencyCode)}</TableCell>
                <TableCell>{money(t.net, t.currencyCode)}</TableCell>
                <TableCell>{money(t.employerContributions, t.currencyCode)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Section>
  );
}

interface RecordDetailView {
  calculationStatus: string;
  currencyCode: string;
  segments: { segmentStart: string; segmentEnd: string; calendarDays: number; leaveLopUnits: string; attendanceLopUnits: string; paidDays: string }[];
  inputs: { inputId: string; componentCode: string; amount: string; reference: string }[];
  lines: { componentCode: string; componentName: string; headType: string; calculationBasis: string; amount: string }[];
  statutory: { componentCode: string; rulePackCode: string; headType: string; status: string; amount: string | null; workings: Record<string, unknown> }[];
}

/**
 * One member's record as the calculation wrote it (GET /v1/payroll/runs/:id/records/:employeeId, the run amount grant): the paid-day
 * segments, the lines by kind, approved inputs, and how each statutory head was valued (the recorded workings, in plain words), so a
 * reviewer or approver can see where a figure came from before deciding.
 */
function RecordDetailPanel({ runId, record, onClose }: { runId: string; record: RunRecord; onClose: () => void }) {
  const keys = useKeys();
  const detail = useQuery({
    queryKey: [...keys.records(runId, null, false), 'detail', record.employeeId] as const,
    queryFn: () => api<RecordDetailView>(`/v1/payroll/runs/${encodeURIComponent(runId)}/records/${encodeURIComponent(record.employeeId)}`),
    retry: retryTransient,
  });
  const d = detail.data;
  const cur = d?.currencyCode ?? record.currencyCode;
  const name = (code: string) => d?.lines.find((l) => l.componentCode === code)?.componentName ?? code;
  return (
    <Section title={`Record of ${record.employeeCode} ${record.employeeName}`}>
      <Button type="button" variant="outline" onClick={onClose}>
        Close
      </Button>
      {detail.isPending && <LoadingLine>Loading the record…</LoadingLine>}
      {detail.error && <Problem error={detail.error} act="read" />}
      {d && (
        <>
          {d.segments.length > 0 && (
            <Table aria-label="Paid days">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">From</TableHead>
                  <TableHead scope="col">To</TableHead>
                  <TableHead scope="col">Calendar days</TableHead>
                  <TableHead scope="col">Unpaid leave</TableHead>
                  <TableHead scope="col">Attendance loss of pay</TableHead>
                  <TableHead scope="col">Paid days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.segments.map((g) => (
                  <TableRow key={g.segmentStart}>
                    <TableCell>{formatDate(g.segmentStart)}</TableCell>
                    <TableCell>{formatDate(g.segmentEnd)}</TableCell>
                    <TableCell>{g.calendarDays}</TableCell>
                    <TableCell>{g.leaveLopUnits}</TableCell>
                    <TableCell>{g.attendanceLopUnits}</TableCell>
                    <TableCell>{g.paidDays}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {d.lines.length === 0 ? (
            <Empty>{`No lines: the record is ${readable(d.calculationStatus).toLowerCase()}.`}</Empty>
          ) : (
            <Table aria-label="Record lines">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Component</TableHead>
                  <TableHead scope="col">Kind</TableHead>
                  <TableHead scope="col">Basis</TableHead>
                  <TableHead scope="col">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.lines.map((l) => (
                  <TableRow key={l.componentCode}>
                    <TableCell>{l.componentName}</TableCell>
                    <TableCell>{readable(l.headType)}</TableCell>
                    <TableCell>{readable(l.calculationBasis)}</TableCell>
                    <TableCell>{money(l.amount, cur)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {d.inputs.length > 0 && (
            <Table aria-label="Approved inputs">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Component</TableHead>
                  <TableHead scope="col">Reference</TableHead>
                  <TableHead scope="col">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.inputs.map((i) => (
                  <TableRow key={i.inputId}>
                    <TableCell>{i.componentCode}</TableCell>
                    <TableCell>{i.reference}</TableCell>
                    <TableCell>{money(i.amount, cur)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {d.statutory.length > 0 && (
            <Table aria-label="Statutory workings">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Component</TableHead>
                  <TableHead scope="col">Pack</TableHead>
                  <TableHead scope="col">Amount</TableHead>
                  <TableHead scope="col">How it was worked out</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {d.statutory.map((s) => (
                  <TableRow key={s.componentCode}>
                    <TableCell>{name(s.componentCode)}</TableCell>
                    <TableCell>{`${String(s.workings.packCode ?? '—')}${s.workings.packRevision ? ` revision ${String(s.workings.packRevision)}` : ''}`}</TableCell>
                    <TableCell>{s.amount === null ? '—' : money(s.amount, cur)}</TableCell>
                    <TableCell>
                      {statutoryNote({ componentCode: s.componentCode, componentName: name(s.componentCode), status: s.status, amount: s.amount, workings: s.workings }, cur)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </>
      )}
    </Section>
  );
}

function exceptionDetail(detail: unknown): string {
  if (!detail || typeof detail !== 'object') return '';
  return Object.entries(detail as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
}

/** An exception in words: its code, how serious it is and, for a blocking one, whether it is resolved. */
function exceptionText(x: RunException): string {
  const open = x.severity === 'BLOCKING' && !x.resolvedAt;
  let state = '';
  if (x.resolvedAt) state = `, resolved ${formatDate(x.resolvedAt)}`;
  else if (open) state = ', unresolved';
  return `${readable(x.code)} (${x.severity === 'BLOCKING' ? 'blocking' : 'warning'}${state})`;
}

/** The label of a member's hold button: hiding the open panel, or what the panel offers the role. */
function holdButtonText(shown: boolean, canPropose: boolean): string {
  if (shown) return 'Hide';
  return canPropose ? 'Balance and hold' : 'Balance';
}

/** A member's name that opens their record: drawn as a table's name links are, in their weight; on a phone card it may wrap. */
const NAME_BUTTON = 'font-normal phone:whitespace-normal';

function RunRecords({ run }: { run: RunDetail }) {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const [after, setAfter] = useState<string | null>(null);
  const [previous, setPrevious] = useState<(string | null)[]>([]);
  const [onlyExceptions, setOnlyExceptions] = useState(false);
  const [resolving, setResolving] = useState<{ exception: RunException; employee: string } | null>(null);
  const [holding, setHolding] = useState<RunRecord | null>(null);
  const [detail, setDetail] = useState<RunRecord | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // A hold applies to a processed record: its balance (hold read) and a proposal (hold propose) start from the member list.
  const holdColumn = run.state === 'PROCESSED_LOCKED' && (can(HOLD_READ) || can(HOLD_PROPOSE));
  const records = useQuery({
    queryKey: keys.records(run.id, after, onlyExceptions),
    queryFn: () => {
      const q = new URLSearchParams();
      if (onlyExceptions) q.set('exceptions', 'true');
      if (after) q.set('after', after);
      const s = q.toString();
      return api<{ items: RunRecord[]; nextAfter: string | null }>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/records${s ? `?${s}` : ''}`);
    },
    retry: retryTransient,
  });
  const resolve = useMutation({
    mutationFn: ({ exceptionId, resolution }: { exceptionId: string; resolution: string }) =>
      api<{ exceptionId: string; resolved: boolean }>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/exceptions/${encodeURIComponent(exceptionId)}/resolve`, { body: { resolution } }),
    onSuccess: () => {
      setResolving(null);
      setNote('The exception was resolved.');
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.run(run.id) }),
  });
  const canResolve = can(RUN_APPROVE) && (run.state === 'CALCULATED' || run.state === 'IN_REVIEW');
  const reset = (only: boolean) => {
    setOnlyExceptions(only);
    setAfter(null);
    setPrevious([]);
  };
  return (
    <Section title="Members and exceptions">
      <CheckField>
        <input type="checkbox" checked={onlyExceptions} onChange={(e) => reset(e.target.checked)} /> Only members with exceptions
      </CheckField>
      {records.isPending && <LoadingLine>Loading the members…</LoadingLine>}
      {records.error && <Problem error={records.error} act="read" />}
      {records.data && records.data.items.length === 0 && <Empty>{run.progress.calculation.started ? 'No member records to show.' : 'Member records appear once the run is calculated.'}</Empty>}
      {records.data && records.data.items.length > 0 && (
        <Table aria-label="Run members">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Employee</TableHead>
              <TableHead scope="col">Calculation</TableHead>
              <TableHead scope="col">Paid units</TableHead>
              <TableHead scope="col">Gross</TableHead>
              <TableHead scope="col">Deductions</TableHead>
              <TableHead scope="col">Net</TableHead>
              <TableHead scope="col">Prior net</TableHead>
              <TableHead scope="col">Salary stop</TableHead>
              <TableHead scope="col">Bank</TableHead>
              <TableHead scope="col">Exceptions</TableHead>
              {holdColumn && <TableHead scope="col">Salary hold</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {records.data.items.map((rec) => (
              <TableRow key={rec.id}>
                <TableCell>
                  <Button type="button" variant="link" size="inline" className={NAME_BUTTON} onClick={() => setDetail(rec)} aria-label={`Details of ${rec.employeeCode}`}>
                    {`${rec.employeeCode} ${rec.employeeName}`}
                  </Button>
                </TableCell>
                <TableCell>{readable(rec.calculationStatus)}</TableCell>
                <TableCell>{rec.paidUnits ?? '—'}</TableCell>
                <TableCell>{money(rec.gross, rec.currencyCode)}</TableCell>
                <TableCell>{money(rec.deductions, rec.currencyCode)}</TableCell>
                <TableCell>{money(rec.net, rec.currencyCode)}</TableCell>
                <TableCell>{money(rec.priorNet, rec.currencyCode)}</TableCell>
                <TableCell>{rec.salaryStopMode ? readable(rec.salaryStopMode) : '—'}</TableCell>
                <TableCell>{rec.bankStatus ? readable(rec.bankStatus) : '—'}</TableCell>
                <TableCell>
                  {rec.exceptions.length === 0 ? (
                    'None'
                  ) : (
                    <ul className="m-0 list-none p-0">
                      {rec.exceptions.map((x) => {
                        const open = x.severity === 'BLOCKING' && !x.resolvedAt;
                        const extra = exceptionDetail(x.detail);
                        return (
                          <li key={x.id}>
                            {exceptionText(x)}
                            {extra && <Hint as="span">{` ${extra}`}</Hint>}
                            {open && !x.resolvable && <Hint as="span"> Needs corrected data and a new revision, or the employee left out.</Hint>}
                            {open && x.resolvable && canResolve && (
                              <>
                                {' '}
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  disabled={resolve.isPending}
                                  onClick={() => {
                                    resolve.reset();
                                    setNote(null);
                                    setResolving({ exception: x, employee: rec.employeeCode });
                                  }}
                                  aria-label={`Resolve ${readable(x.code)} of ${rec.employeeCode}`}
                                >
                                  Resolve
                                </Button>
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </TableCell>
                {holdColumn && (
                  <RowActionsCell>
                    <RowActions>
                      <Button type="button" variant="outline" size="sm" onClick={() => setHolding(holding?.id === rec.id ? null : rec)} aria-label={`Salary hold of ${rec.employeeCode}`}>
                        {holdButtonText(holding?.id === rec.id, can(HOLD_PROPOSE))}
                      </Button>
                    </RowActions>
                  </RowActionsCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {holding && <RecordHoldPanel key={holding.id} record={holding} />}
      {detail && <RecordDetailPanel key={detail.id} runId={run.id} record={detail} onClose={() => setDetail(null)} />}
      <PagerRow>
        {previous.length > 0 && (
          <PagerButton
            onClick={() => {
              setAfter(previous[previous.length - 1] ?? null);
              setPrevious(previous.slice(0, -1));
            }}
          >
            Previous page
          </PagerButton>
        )}
        {records.data?.nextAfter && (
          <PagerButton
            onClick={() => {
              setPrevious([...previous, after]);
              setAfter(records.data?.nextAfter ?? null);
            }}
          >
            Next page
          </PagerButton>
        )}
      </PagerRow>
      {resolving && (
        <ReasonForm
          key={resolving.exception.id}
          name={`Resolve ${readable(resolving.exception.code)} of ${resolving.employee}`}
          field={`Resolution of ${readable(resolving.exception.code)} for ${resolving.employee}`}
          button={resolve.isPending ? 'Recording…' : 'Record the resolution'}
          busy={resolve.isPending}
          onSend={(resolution) => resolve.mutateAsync({ exceptionId: resolving.exception.id, resolution })}
        />
      )}
      <Problem error={resolve.error} act="resolve" />
      <Notice notice={note ? { text: note, ok: true } : null} />
    </Section>
  );
}

function RunComponentsSection({ run }: { run: RunDetail }) {
  const keys = useKeys();
  const data = useQuery({
    queryKey: keys.components(run.id),
    queryFn: () => api<RunComponents>(`/v1/payroll/runs/${encodeURIComponent(run.id)}/components`),
    retry: retryTransient,
  });
  const c = data.data;
  return (
    <Section title="Component totals and prior period">
      {data.isPending && <LoadingLine>Loading the component totals…</LoadingLine>}
      {data.error && <Problem error={data.error} act="read" />}
      {c?.basis === 'SCOPE' && <Hint>Your scope covers part of this run: the records in your scope are compared with the same employees’ latest earlier processed records.</Hint>}
      {c?.basis === 'RUN' && !c.priorPeriodCode && <Hint>No earlier processed run of this calendar and scope to compare with.</Hint>}
      {c && <ComponentTable c={c} currency={run.currencyCode} name="Component totals" />}
    </Section>
  );
}

/** Component totals with the prior period and the difference, each exactly as returned. */
export function ComponentTable({ c, currency, name }: { c: RunComponents; currency: string; name: string }) {
  return (
    <>
      {c.items.length === 0 && <Empty>No component totals yet.</Empty>}
      {c.items.length > 0 && (
        <Table aria-label={name}>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Component</TableHead>
              <TableHead scope="col">Type</TableHead>
              <TableHead scope="col">This run</TableHead>
              <TableHead scope="col">{c.priorPeriodCode ? `Prior period (${c.priorPeriodCode})` : 'Prior period'}</TableHead>
              <TableHead scope="col">Difference</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {c.items.map((i) => (
              <TableRow key={`${i.componentCode}:${i.headType}`}>
                <TableCell>{i.componentCode}</TableCell>
                <TableCell>{label(HEAD_TYPE, i.headType)}</TableCell>
                <TableCell>{money(i.current, currency)}</TableCell>
                <TableCell>{money(i.prior, currency)}</TableCell>
                <TableCell>{money(i.difference, currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}
