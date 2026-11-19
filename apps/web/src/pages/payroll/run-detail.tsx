// Payroll run detail: the run, its actions, totals, records, exceptions and component comparison.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, formatDate, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { statutoryNote } from './ess';
import { RecordHoldPanel } from './hold-proposals';
import { LoanRecoveries } from './loans';
import { Problem, ReasonForm } from './problems';
import { MemberExclusion, RunVerify } from './run-extras';
import { RunBank, RunPayslips } from './run-outputs';
import { BANK_READ, canReadRuns, Fact, FLUSH, H3, HEAD_TYPE, HOLD_PROPOSE, HOLD_READ, involvement, label, LOAN_RECOVER, money, OUTPUT_PUBLISH, OUTPUT_READ, PATHS, PLAIN_LIST, REPORT_READ, RUN_APPROVE, RUN_CANCEL, RUN_PREPARE, RUN_PROCESS, RUN_READ_AMOUNT, RUN_STATE, SCROLL, Status, useKeys } from './shared';
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
        <Empty>The selected role cannot see payroll runs.</Empty>
      </Section>
    );
  }
  return <RunView key={id} id={id} />;
}

function RunView({ id }: { id: string }) {
  const { can, me } = useSession();
  const keys = useKeys();
  const run = useQuery({ queryKey: keys.run(id), queryFn: () => api<RunDetail>(`/v1/payroll/runs/${encodeURIComponent(id)}`), retry: retryTransient });
  const r = run.data;
  if (run.isPending) return <p className="hint loading">Loading the payroll run…</p>;
  if (!r) {
    return (
      <Section title="Payroll run">
        <Problem error={run.error} act="read" />
        <Link to={PATHS.runs}>Back to payroll runs</Link>
      </Section>
    );
  }
  const mine = involvement(r, me?.userId);
  return (
    <div className="stack">
      <Section title={`Payroll run ${r.period.periodCode} · revision ${r.revision}`} actions={<Link to={PATHS.runs}>All runs</Link>}>
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
            {r.progress.calculation.complete
              ? `Complete: ${r.progress.calculation.calculated} records`
              : r.progress.calculation.started
                ? `In progress: ${r.progress.calculation.calculated} of ${r.progress.calculation.members}`
                : 'Not started'}
          </Fact>
          <Fact term="Processing">
            {r.progress.processing.complete
              ? `Locked: ${r.progress.processing.frozen} records frozen`
              : r.progress.processing.started
                ? `In progress: ${r.progress.processing.frozen} of ${r.progress.processing.records} frozen`
                : 'Not started'}
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
        {r.paymentStatus === 'NOT_TRACKED_HERE' && <p className="hint">Payment is not tracked on the run: it comes only from the outcomes recorded on its bank manifests.</p>}
        {r.supersedesRunId && (
          <p style={FLUSH}>
            <Link to={PATHS.run(r.supersedesRunId)}>Previous revision</Link>
          </p>
        )}
        {r.successorRunId && (
          <p style={FLUSH}>
            <Link to={PATHS.run(r.successorRunId)}>Next revision</Link>
          </p>
        )}
        {can(REPORT_READ) && (
          <p style={FLUSH}>
            <Link to={PATHS.reports(r.id)}>Reports of this run</Link>
          </p>
        )}
        {mine.length > 0 && (
          <p role="note" className="hint">
            {`You ${mine.join(' and ')} this revision, so ${
              mine.includes('created') || mine.includes('calculated')
                ? 'you do not review, approve or process it'
                : mine.includes('reviewed')
                  ? 'you do not approve it or give its covering approvals'
                  : 'you do not give its covering approvals'
            }, and you never authorise its bank release or record its payment outcomes.`}
          </p>
        )}
        {r.decisions.length > 0 && (
          <>
            <h3 style={H3}>Decisions</h3>
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
      if (action === 'calculate') {
        const c = result.progress.calculation;
        setNote(c.complete ? `Calculated: ${c.calculated} records. Check the exceptions and totals, then submit it for review.` : `Calculation continues: ${c.calculated} of ${c.members} members calculated. Continue the calculation.`);
      } else if (action === 'process') {
        const p = result.progress.processing;
        setNote(
          result.state === 'PROCESSED_LOCKED'
            ? 'Processed and locked. Payslips and bank files can now be prepared; nothing has been paid.'
            : `Processing continues: ${p.frozen} of ${p.records} records frozen. Continue processing.`,
        );
      } else if (action === 'submit') setNote('Submitted for an independent review.');
      else if (action === 'cancel') setNote('This revision was cancelled.');
      else {
        setNote(null);
        navigate(PATHS.run(result.id));
      }
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
        <button type="button" disabled={busy || (calcStarted && notCalculator)} onClick={() => void send('calculate').catch(() => undefined)}>
          {calcStarted ? 'Continue the calculation' : 'Calculate'}
        </button>
        {calcStarted && notCalculator && <p className="hint">The preparer who started this calculation continues it.</p>}
      </div>,
    );
    if (!calcStarted) controls.push(<MemberExclusion key="exclude" run={run} />);
  }
  if (run.state === 'CALCULATED' && can(RUN_PREPARE)) {
    controls.push(
      <div key="submit">
        <button type="button" disabled={busy || notCalculator} onClick={() => void send('submit').catch(() => undefined)}>
          Submit for review
        </button>
        {notCalculator && <p className="hint">Only the preparer who calculated this revision submits it.</p>}
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
      <p key="review" className="hint">
        Waiting for the independent review and approval: <Link to={PATHS.decisions}>Run decisions</Link>.
      </p>,
    );
  }
  if (run.state === 'APPROVED' && can(RUN_PROCESS)) {
    controls.push(
      <div key="process">
        <button type="button" disabled={busy || runActor} onClick={() => void send('process').catch(() => undefined)}>
          {run.processingStartedAt ? 'Continue processing' : 'Process and lock'}
        </button>
        {runActor && <p className="hint">You created or calculated this run, so someone else processes it.</p>}
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
    <div style={{ marginTop: '0.75rem' }}>
      <h3 style={H3}>Actions</h3>
      {controls.length === 0 ? <p className="hint">No action on this revision is available to the selected role.</p> : <div className="stack">{controls}</div>}
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
      <Problem error={act.error} act={act.variables?.action === 'process' ? 'process' : 'run'} />
    </div>
  );
}

function RunTotalsSection({ run, totals }: { run: RunDetail; totals: RunTotals[] }) {
  return (
    <Section title="Run totals">
      {run.scopeComplete === false && <p className="hint">Your scope covers part of this run: these totals are of the records in your scope only.</p>}
      {totals.length === 0 ? (
        <Empty>No records are calculated yet.</Empty>
      ) : (
        <div style={SCROLL}>
          <table aria-label="Run totals">
            <thead>
              <tr>
                <th>Currency</th>
                <th>Records</th>
                <th>Paid units</th>
                <th>Earnings</th>
                <th>Reimbursements</th>
                <th>Gross</th>
                <th>Deductions</th>
                <th>Net</th>
                <th>Employer contributions</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((t) => (
                <tr key={t.currencyCode}>
                  <td>{t.currencyCode}</td>
                  <td>{t.records}</td>
                  <td>{t.paidUnits ?? '—'}</td>
                  <td>{money(t.earnings, t.currencyCode)}</td>
                  <td>{money(t.reimbursements, t.currencyCode)}</td>
                  <td>{money(t.gross, t.currencyCode)}</td>
                  <td>{money(t.deductions, t.currencyCode)}</td>
                  <td>{money(t.net, t.currencyCode)}</td>
                  <td>{money(t.employerContributions, t.currencyCode)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <button type="button" className="secondary" onClick={onClose}>
        Close
      </button>
      {detail.isPending && <p className="hint loading">Loading the record…</p>}
      {detail.error && <Problem error={detail.error} act="read" />}
      {d && (
        <>
          {d.segments.length > 0 && (
            <table aria-label="Paid days">
              <thead>
                <tr>
                  <th>From</th>
                  <th>To</th>
                  <th>Calendar days</th>
                  <th>Unpaid leave</th>
                  <th>Attendance loss of pay</th>
                  <th>Paid days</th>
                </tr>
              </thead>
              <tbody>
                {d.segments.map((g) => (
                  <tr key={g.segmentStart}>
                    <td>{formatDate(g.segmentStart)}</td>
                    <td>{formatDate(g.segmentEnd)}</td>
                    <td>{g.calendarDays}</td>
                    <td>{g.leaveLopUnits}</td>
                    <td>{g.attendanceLopUnits}</td>
                    <td>{g.paidDays}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.lines.length === 0 ? (
            <Empty>{`No lines: the record is ${readable(d.calculationStatus).toLowerCase()}.`}</Empty>
          ) : (
            <table aria-label="Record lines">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Kind</th>
                  <th>Basis</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.componentCode}>
                    <td>{l.componentName}</td>
                    <td>{readable(l.headType)}</td>
                    <td>{readable(l.calculationBasis)}</td>
                    <td>{money(l.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.inputs.length > 0 && (
            <table aria-label="Approved inputs">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Reference</th>
                  <th>Amount</th>
                </tr>
              </thead>
              <tbody>
                {d.inputs.map((i) => (
                  <tr key={i.inputId}>
                    <td>{i.componentCode}</td>
                    <td>{i.reference}</td>
                    <td>{money(i.amount, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {d.statutory.length > 0 && (
            <table aria-label="Statutory workings">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Pack</th>
                  <th>Amount</th>
                  <th>How it was worked out</th>
                </tr>
              </thead>
              <tbody>
                {d.statutory.map((s) => (
                  <tr key={s.componentCode}>
                    <td>{name(s.componentCode)}</td>
                    <td>{`${String(s.workings.packCode ?? '—')}${s.workings.packRevision ? ` revision ${String(s.workings.packRevision)}` : ''}`}</td>
                    <td>{s.amount === null ? '—' : money(s.amount, cur)}</td>
                    <td>{statutoryNote({ componentCode: s.componentCode, componentName: name(s.componentCode), status: s.status, amount: s.amount, workings: s.workings }, cur)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Section>
  );
}

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
      <label className="check">
        <input type="checkbox" checked={onlyExceptions} onChange={(e) => reset(e.target.checked)} /> Only members with exceptions
      </label>
      {records.isPending && <p className="hint loading">Loading the members…</p>}
      {records.error && <Problem error={records.error} act="read" />}
      {records.data && records.data.items.length === 0 && <Empty>{run.progress.calculation.started ? 'No member records to show.' : 'Member records appear once the run is calculated.'}</Empty>}
      {records.data && records.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Run members">
            <thead>
              <tr>
                <th>Employee</th>
                <th>Calculation</th>
                <th>Paid units</th>
                <th>Gross</th>
                <th>Deductions</th>
                <th>Net</th>
                <th>Prior net</th>
                <th>Salary stop</th>
                <th>Bank</th>
                <th>Exceptions</th>
                {holdColumn && <th>Salary hold</th>}
              </tr>
            </thead>
            <tbody>
              {records.data.items.map((rec) => (
                <tr key={rec.id}>
                  <td>
                    <button type="button" className="link" onClick={() => setDetail(rec)} aria-label={`Details of ${rec.employeeCode}`}>
                      {`${rec.employeeCode} ${rec.employeeName}`}
                    </button>
                  </td>
                  <td>{readable(rec.calculationStatus)}</td>
                  <td>{rec.paidUnits ?? '—'}</td>
                  <td>{money(rec.gross, rec.currencyCode)}</td>
                  <td>{money(rec.deductions, rec.currencyCode)}</td>
                  <td>{money(rec.net, rec.currencyCode)}</td>
                  <td>{money(rec.priorNet, rec.currencyCode)}</td>
                  <td>{rec.salaryStopMode ? readable(rec.salaryStopMode) : '—'}</td>
                  <td>{rec.bankStatus ? readable(rec.bankStatus) : '—'}</td>
                  <td>
                    {rec.exceptions.length === 0 ? (
                      'None'
                    ) : (
                      <ul style={PLAIN_LIST}>
                        {rec.exceptions.map((x) => {
                          const open = x.severity === 'BLOCKING' && !x.resolvedAt;
                          const extra = exceptionDetail(x.detail);
                          return (
                            <li key={x.id}>
                              {`${readable(x.code)} (${x.severity === 'BLOCKING' ? 'blocking' : 'warning'}${x.resolvedAt ? `, resolved ${formatDate(x.resolvedAt)}` : open ? ', unresolved' : ''})`}
                              {extra && <span className="hint">{` ${extra}`}</span>}
                              {open && !x.resolvable && <span className="hint"> Needs corrected data and a new revision, or the employee left out.</span>}
                              {open && x.resolvable && canResolve && (
                                <>
                                  {' '}
                                  <button
                                    type="button"
                                    className="link"
                                    disabled={resolve.isPending}
                                    onClick={() => {
                                      resolve.reset();
                                      setNote(null);
                                      setResolving({ exception: x, employee: rec.employeeCode });
                                    }}
                                    aria-label={`Resolve ${readable(x.code)} of ${rec.employeeCode}`}
                                  >
                                    Resolve
                                  </button>
                                </>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </td>
                  {holdColumn && (
                    <td>
                      <button type="button" className="link" onClick={() => setHolding(holding?.id === rec.id ? null : rec)} aria-label={`Salary hold of ${rec.employeeCode}`}>
                        {holding?.id === rec.id ? 'Hide' : can(HOLD_PROPOSE) ? 'Balance and hold' : 'Balance'}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {holding && <RecordHoldPanel key={holding.id} record={holding} />}
      {detail && <RecordDetailPanel key={detail.id} runId={run.id} record={detail} onClose={() => setDetail(null)} />}
      <div className="row" style={{ marginTop: '0.5rem' }}>
        {previous.length > 0 && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setAfter(previous[previous.length - 1] ?? null);
              setPrevious(previous.slice(0, -1));
            }}
          >
            Previous page
          </button>
        )}
        {records.data?.nextAfter && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              setPrevious([...previous, after]);
              setAfter(records.data?.nextAfter ?? null);
            }}
          >
            Next page
          </button>
        )}
      </div>
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
      {note && (
        <p role="status" className="ok">
          {note}
        </p>
      )}
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
      {data.isPending && <p className="hint loading">Loading the component totals…</p>}
      {data.error && <Problem error={data.error} act="read" />}
      {c?.basis === 'SCOPE' && <p className="hint">Your scope covers part of this run: the records in your scope are compared with the same employees’ latest earlier processed records.</p>}
      {c?.basis === 'RUN' && !c.priorPeriodCode && <p className="hint">No earlier processed run of this calendar and scope to compare with.</p>}
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
        <div style={SCROLL}>
          <table aria-label={name}>
            <thead>
              <tr>
                <th>Component</th>
                <th>Type</th>
                <th>This run</th>
                <th>{c.priorPeriodCode ? `Prior period (${c.priorPeriodCode})` : 'Prior period'}</th>
                <th>Difference</th>
              </tr>
            </thead>
            <tbody>
              {c.items.map((i) => (
                <tr key={`${i.componentCode}:${i.headType}`}>
                  <td>{i.componentCode}</td>
                  <td>{label(HEAD_TYPE, i.headType)}</td>
                  <td>{money(i.current, currency)}</td>
                  <td>{money(i.prior, currency)}</td>
                  <td>{money(i.difference, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
