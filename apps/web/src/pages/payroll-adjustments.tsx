// Later-period payroll cases (FR-035 arrears; FR-100 late or amended timesheets; DB111; H2; H3 TN13; H7). Cases are recorded and
// reviewed here; nothing is valued or computed, approval of a timesheet adjustment waits for an adjustment valuation policy, and an
// approved arrears case pays nothing. Figures are shown exactly as the server returns them.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, formatAmount, formatDate, idempotencyKey } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Empty, ErrorNote, Section, StateBadge } from '../ui';

const ADJ_READ = 'payroll_adjustment.read.amount';
const ADJ_PROPOSE = 'payroll_adjustment.propose.amount';
const ADJ_DECIDE = 'payroll_adjustment.decide.amount';
const ARR_READ = 'payroll_arrears.read.amount';
const ARR_PROPOSE = 'payroll_arrears.propose.amount';
const ARR_DECIDE = 'payroll_arrears.decide.amount';

interface AdjustmentCandidate {
  timesheetId: string;
  revision: number;
  serviceStart: string;
  serviceEnd: string;
  employeeCode: string;
  employeeName: string;
  originRecordId: string;
  originPeriodCode: string;
  adjustmentKind: string;
}
interface Adjustment {
  id: string;
  employeeCode: string;
  employeeName: string;
  adjustmentKind: string;
  sourceRevision: number;
  serviceStart: string;
  serviceEnd: string;
  sourceMinutes: number;
  originPeriodCode: string;
  originRunRevision: number;
  originPaidUnits: string | null;
  previousRecognizedUnits: string | null;
  correctedUnits: string | null;
  deltaAmount: string | null;
  currencyCode: string;
  explanation: string | null;
  state: string;
  version: number;
}
interface Note {
  status: string;
  message: string;
}

const KIND: Record<string, string> = { LATE_TIMESHEET: 'Late timesheet', AMENDED_TIMESHEET: 'Amended timesheet' };

function DecisionButtons({ url, canApprove, name, onDone, approveNote }: { url: string; canApprove: boolean; name: string; onDone: () => void; approveNote?: string }) {
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'RETURN' | 'REJECT') => api(url, { body: { decision, idempotencyKey: idempotencyKey('payroll-case'), ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
    onSuccess: () => onDone(),
  });
  return (
    <form className="stack" aria-label={`Decide ${name}`} onSubmit={(e) => e.preventDefault()}>
      <label>
        Reason (needed to return or reject)
        <textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {approveNote && <p className="hint">{approveNote}</p>}
      <ErrorNote error={decide.error} />
      <div className="row">
        {canApprove && (
          <button type="button" onClick={() => decide.mutate('APPROVE')} disabled={decide.isPending}>
            Approve
          </button>
        )}
        <button type="button" className="secondary" onClick={() => decide.mutate('RETURN')} disabled={decide.isPending}>
          Return
        </button>
        <button type="button" className="danger" onClick={() => decide.mutate('REJECT')} disabled={decide.isPending}>
          Reject
        </button>
      </div>
    </form>
  );
}

// =========================================================================================================
// FR-100 late or amended timesheets
// =========================================================================================================

const facts = (a: Adjustment) => [
  `${KIND[a.adjustmentKind] ?? a.adjustmentKind}, revision ${a.sourceRevision}: ${formatDate(a.serviceStart)} to ${formatDate(a.serviceEnd)}, ${a.sourceMinutes / 60} hours approved`,
  `Processed payroll ${a.originPeriodCode}, run revision ${a.originRunRevision}, paid units ${a.originPaidUnits ?? '—'}`,
  `Entered figures: previously recognised ${a.previousRecognizedUnits ?? 'pending'}, corrected ${a.correctedUnits ?? 'pending'}, difference ${a.deltaAmount === null ? 'pending' : formatAmount(a.deltaAmount, a.currencyCode)}`,
];

function DraftActions({ a, onDone }: { a: Adjustment; onDone: () => void }) {
  const [previous, setPrevious] = useState(a.previousRecognizedUnits ?? '');
  const [corrected, setCorrected] = useState(a.correctedUnits ?? '');
  const [delta, setDelta] = useState(a.deltaAmount ?? '');
  const [explanation, setExplanation] = useState(a.explanation ?? '');
  const save = useMutation({
    mutationFn: () =>
      api<Adjustment>(`/v1/payroll/adjustments/${encodeURIComponent(a.id)}`, {
        method: 'PUT',
        body: { expectedVersion: a.version, previousRecognizedUnits: previous.trim() || null, correctedUnits: corrected.trim() || null, deltaAmount: delta.trim() || null, explanation: explanation.trim() || null },
      }),
    onSuccess: () => onDone(),
  });
  const send = useMutation({ mutationFn: () => api(`/v1/payroll/adjustments/${encodeURIComponent(a.id)}/submit`, { body: { expectedVersion: a.version } }), onSuccess: () => onDone() });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  };
  return (
    <form className="stack" aria-label={`Draft case of ${a.employeeCode}`} onSubmit={submit}>
      <p className="hint">The figures are optional: they are your entry, and nothing here computes them.</p>
      <label>
        Previously recognised units
        <input inputMode="decimal" value={previous} onChange={(e) => setPrevious(e.target.value)} />
      </label>
      <label>
        Corrected units
        <input inputMode="decimal" value={corrected} onChange={(e) => setCorrected(e.target.value)} />
      </label>
      <label>
        Signed difference
        <input inputMode="decimal" value={delta} onChange={(e) => setDelta(e.target.value)} />
      </label>
      <label>
        Explanation
        <textarea rows={2} maxLength={2000} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
      </label>
      <ErrorNote error={save.error ?? send.error} />
      <div className="row">
        <button type="submit" className="secondary" disabled={save.isPending}>
          Save draft
        </button>
        <button type="button" onClick={() => send.mutate()} disabled={send.isPending}>
          Submit for review
        </button>
      </div>
    </form>
  );
}

function AdjustmentQueue() {
  const { can } = useSession();
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['adjustment-tasks'], queryFn: () => api<{ items: { taskId: string; adjustment: Adjustment }[]; valuation: Note }>('/v1/payroll/adjustments/tasks/mine'), enabled: can(ADJ_DECIDE) });
  if (!can(ADJ_DECIDE)) return <p className="hint">The selected role does not decide payroll adjustments.</p>;
  return (
    <Section title="Late-timesheet adjustments to review">
      <ErrorNote error={tasks.error} />
      {tasks.data && <p role="status">{tasks.data.valuation.message}</p>}
      {tasks.data?.items.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      {tasks.data?.items.map(({ taskId, adjustment: a }) => (
        <div className="card" key={taskId} aria-label={`Case of ${a.employeeCode}`}>
          <strong>{`${a.employeeName} (${a.employeeCode})`}</strong>
          <ul>
            {facts(a).map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
          <p>{a.explanation}</p>
          {/* H2: an unresolved policy blocks approval, so the action is not offered; the server refuses it as well. */}
          <DecisionButtons url={`/v1/payroll/adjustment-tasks/${encodeURIComponent(taskId)}/decision`} canApprove={false} name={`the case of ${a.employeeCode}`} onDone={() => void qc.invalidateQueries({ queryKey: ['adjustment-tasks'] })} />
        </div>
      ))}
    </Section>
  );
}

function AdjustmentsScreen() {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['adjustments'] });
    void qc.invalidateQueries({ queryKey: ['adjustment-candidates'] });
  };
  const list = useQuery({ queryKey: ['adjustments'], queryFn: () => api<{ items: (Adjustment & { createdBy: string })[]; valuation: Note }>('/v1/payroll/adjustments?page=1&pageSize=50'), enabled: can(ADJ_READ) });
  const candidates = useQuery({ queryKey: ['adjustment-candidates'], queryFn: () => api<{ items: AdjustmentCandidate[] }>('/v1/payroll/adjustments/candidates?page=1&pageSize=50'), enabled: can(ADJ_READ) });
  const open = useMutation({
    mutationFn: (c: AdjustmentCandidate) => api<Adjustment>('/v1/payroll/adjustments', { body: { timesheetId: c.timesheetId, revision: c.revision, originRecordId: c.originRecordId } }),
    onSuccess: () => refresh(),
  });
  if (!can(ADJ_READ) && !can(ADJ_DECIDE)) return <p className="hint">The selected role cannot read payroll adjustments.</p>;
  return (
    <div className="stack">
      {can(ADJ_DECIDE) && <AdjustmentQueue />}
      {can(ADJ_READ) && (
        <Section title="Late or amended timesheets after a processed payroll">
          <ErrorNote error={candidates.error ?? open.error} />
          {candidates.data?.items.length === 0 && <Empty>No approved timesheet came after a processed payroll.</Empty>}
          {candidates.data && candidates.data.items.length > 0 && (
            <ul aria-label="Timesheets to raise">
              {candidates.data.items.map((c) => (
                <li key={`${c.timesheetId}:${c.originRecordId}`}>
                  {`${c.employeeName} (${c.employeeCode}), ${formatDate(c.serviceStart)} to ${formatDate(c.serviceEnd)}, payroll ${c.originPeriodCode}: ${KIND[c.adjustmentKind] ?? c.adjustmentKind} `}
                  {can(ADJ_PROPOSE) && (
                    <button type="button" className="secondary" onClick={() => open.mutate(c)} disabled={open.isPending}>
                      Open a case
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
      {can(ADJ_READ) && (
        <Section title="Adjustment cases">
          <ErrorNote error={list.error} />
          {list.data && <p role="status">{list.data.valuation.message}</p>}
          {list.data?.items.length === 0 && <Empty>No cases yet.</Empty>}
          {list.data?.items.map((a) => (
            <div className="card" key={a.id} aria-label={`Adjustment of ${a.employeeCode}`}>
              <strong>{`${a.employeeName} (${a.employeeCode}) `}</strong>
              <StateBadge state={a.state} />
              <ul>
                {facts(a).map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {a.state === 'DRAFT' && can(ADJ_PROPOSE) && a.createdBy === me?.userId ? <DraftActions key={a.version} a={a} onDone={refresh} /> : a.explanation && <p>{a.explanation}</p>}
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}

/** H3 TN13 "linked later-payroll adjustments": the week, the period and the state; no figures. */
export function OwnLaterAdjustments() {
  const list = useQuery({
    queryKey: ['own-payroll-adjustments'],
    queryFn: () => api<{ items: { id: string; serviceStart: string; serviceEnd: string; originPeriodCode: string; adjustmentKind: string; state: string }[]; notice: string }>('/v1/me/payroll-adjustments'),
  });
  return (
    <Section title="Later-payroll adjustments">
      <ErrorNote error={list.error} />
      {list.data?.items.length === 0 && <Empty>None of your timesheets has a later-payroll adjustment.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <>
          <p className="hint">{list.data.notice}</p>
          <ul aria-label="My later-payroll adjustments">
            {list.data.items.map((a) => (
              <li key={a.id}>
                {`${formatDate(a.serviceStart)} to ${formatDate(a.serviceEnd)}, payroll ${a.originPeriodCode}: `}
                <StateBadge state={a.state} />
              </li>
            ))}
          </ul>
        </>
      )}
    </Section>
  );
}

// =========================================================================================================
// FR-035 arrears cases and the arrear register
// =========================================================================================================

interface ArrearsCandidate {
  employeeCode: string;
  employeeName: string;
  sourceRevisionId: string;
  sourceEffectiveFrom: string;
  originRecordId: string;
  periodCode: string;
  currencyCode: string;
}
interface ArrearsCase {
  id: string;
  employeeCode: string;
  employeeName: string;
  sourceRevisionId: string;
  sourceEffectiveFrom: string;
  periodCode: string;
  currencyCode: string;
  reason: string;
  state: string;
  lines: { componentCode: string; amount: string }[];
  totalEntered: string;
}

const parseLines = (text: string) =>
  text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [componentCode, amount] = l.split(/\s+/);
      return { componentCode: componentCode ?? '', amount: amount ?? '' };
    });

function ArrearsForm({ candidate, onDone }: { candidate: ArrearsCandidate; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState('');
  const [key] = useState(() => idempotencyKey('arrears'));
  const propose = useMutation({
    mutationFn: () => api<ArrearsCase>('/v1/payroll/arrears-cases', { body: { sourceRevisionId: candidate.sourceRevisionId, originRecordId: candidate.originRecordId, reason: reason.trim(), lines: parseLines(lines), idempotencyKey: key } }),
    onSuccess: () => onDone(),
  });
  return (
    <form
      className="stack"
      aria-label={`Raise arrears for ${candidate.employeeCode} ${candidate.periodCode}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!propose.isPending) propose.mutate();
      }}
    >
      <p>{`${candidate.employeeName} (${candidate.employeeCode}): salary revision from ${formatDate(candidate.sourceEffectiveFrom)}, processed payroll ${candidate.periodCode}`}</p>
      <label>
        {`Amounts in ${candidate.currencyCode}, one component per line: CODE amount`}
        <textarea rows={2} value={lines} onChange={(e) => setLines(e.target.value)} />
      </label>
      <label>
        Reason
        <textarea rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <ErrorNote error={propose.error} />
      <button type="submit" disabled={propose.isPending || !reason.trim() || !lines.trim()}>
        Raise the case
      </button>
    </form>
  );
}

function ArrearsQueue() {
  const { can } = useSession();
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['arrears-tasks'], queryFn: () => api<{ items: { taskId: string; case: ArrearsCase }[] }>('/v1/payroll/arrears-cases/tasks/mine'), enabled: can(ARR_DECIDE) });
  if (!can(ARR_DECIDE)) return <p className="hint">The selected role does not decide arrears cases.</p>;
  return (
    <Section title="Arrears cases to decide">
      <p className="hint">Approving records your decision on the amounts entered. Nothing is paid and no payroll changes.</p>
      <ErrorNote error={tasks.error} />
      {tasks.data?.items.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      {tasks.data?.items.map(({ taskId, case: c }) => (
        <div className="card" key={taskId} aria-label={`Arrears of ${c.employeeCode}`}>
          <strong>{`${c.employeeName} (${c.employeeCode}), ${c.periodCode}, revision from ${formatDate(c.sourceEffectiveFrom)}`}</strong>
          <ul>
            {c.lines.map((l) => (
              <li key={l.componentCode}>{`${l.componentCode}: ${formatAmount(l.amount, c.currencyCode)}`}</li>
            ))}
          </ul>
          <p>{c.reason}</p>
          <DecisionButtons url={`/v1/payroll/arrears-tasks/${encodeURIComponent(taskId)}/decision`} canApprove name={`the arrears of ${c.employeeCode}`} onDone={() => void qc.invalidateQueries({ queryKey: ['arrears-tasks'] })} />
        </div>
      ))}
    </Section>
  );
}

function ArrearsScreen() {
  const { can } = useSession();
  const qc = useQueryClient();
  const [raising, setRaising] = useState<ArrearsCandidate | null>(null);
  const register = useQuery({ queryKey: ['arrears-register'], queryFn: () => api<{ items: ArrearsCase[]; calculation: Note }>('/v1/payroll/arrears-cases?page=1&pageSize=50'), enabled: can(ARR_READ) });
  const candidates = useQuery({ queryKey: ['arrears-candidates'], queryFn: () => api<{ items: ArrearsCandidate[] }>('/v1/payroll/arrears-cases/candidates?page=1&pageSize=50'), enabled: can(ARR_READ) });
  if (!can(ARR_READ) && !can(ARR_DECIDE)) return <p className="hint">The selected role cannot read arrears cases.</p>;
  const refresh = () => {
    setRaising(null);
    void qc.invalidateQueries({ queryKey: ['arrears-register'] });
    void qc.invalidateQueries({ queryKey: ['arrears-candidates'] });
  };
  return (
    <div className="stack">
      {can(ARR_DECIDE) && <ArrearsQueue />}
      {can(ARR_READ) && (
        <Section title="Salary revisions a processed payroll did not reach">
          <ErrorNote error={candidates.error} />
          {candidates.data?.items.length === 0 && <Empty>No processed payroll is behind a salary revision.</Empty>}
          {candidates.data && candidates.data.items.length > 0 && (
            <ul aria-label="Revisions to raise">
              {candidates.data.items.map((c) => (
                <li key={`${c.sourceRevisionId}:${c.originRecordId}`}>
                  {`${c.employeeName} (${c.employeeCode}): revision from ${formatDate(c.sourceEffectiveFrom)}, payroll ${c.periodCode} `}
                  {can(ARR_PROPOSE) && (
                    <button type="button" className="secondary" onClick={() => setRaising(c)}>
                      Raise a case
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {raising && can(ARR_PROPOSE) && <ArrearsForm key={`${raising.sourceRevisionId}:${raising.originRecordId}`} candidate={raising} onDone={refresh} />}
        </Section>
      )}
      {can(ARR_READ) && (
        <Section title="Arrear register">
          <ErrorNote error={register.error} />
          {register.data && <p role="status">{register.data.calculation.message}</p>}
          {register.data?.items.length === 0 && <Empty>No arrears cases yet.</Empty>}
          {register.data && register.data.items.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table aria-label="Arrear register">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Source revision from</th>
                    <th>Period</th>
                    <th>Component detail</th>
                    <th>Total entered</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {register.data.items.map((c) => (
                    <tr key={c.id}>
                      <td>{`${c.employeeName} (${c.employeeCode})`}</td>
                      <td>{formatDate(c.sourceEffectiveFrom)}</td>
                      <td>{c.periodCode}</td>
                      <td>{c.lines.map((l) => `${l.componentCode} ${formatAmount(l.amount, c.currencyCode)}`).join('; ')}</td>
                      <td>{formatAmount(c.totalEntered, c.currencyCode)}</td>
                      <td>
                        <StateBadge state={c.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      )}
    </div>
  );
}

// =========================================================================================================

export const PAYROLL_ADJUSTMENT_SCREENS: ScreenRoute[] = [
  { path: '/payroll/adjustments', title: 'Late-timesheet adjustments', permission: ADJ_READ, nav: true, component: AdjustmentsScreen },
  { path: '/payroll/arrears', title: 'Arrear register', permission: ARR_READ, nav: true, component: ArrearsScreen },
];

export const PAYROLL_ADJUSTMENT_TASK_QUEUES = [
  { permission: ADJ_DECIDE, title: 'Late-timesheet adjustments', component: AdjustmentQueue },
  { permission: ARR_DECIDE, title: 'Arrears cases', component: ArrearsQueue },
];
