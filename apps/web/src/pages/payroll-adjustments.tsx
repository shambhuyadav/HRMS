// Later-period payroll cases (FR-035 arrears; FR-100 late or amended timesheets; DB111; H2; H3 TN13; H7) and the valuation policy they
// are paid under (I-79, decided under owner delegation, 6 Nov 2026). The server calculates every amount: a case shows its figures as
// returned and is never typed in. An independent reviewer approves; the first later payroll pays an approved case once and the case then
// names that payroll. Without an active valuation policy, approval of a timesheet adjustment is not offered and the reason is said.
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
const CONFIG_READ = 'payroll_config.read.operational';
const CONFIG_MANAGE = 'payroll_config.manage.operational';
const CONFIG_ACTIVATE = 'payroll_config.activate.operational';

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
  targetPeriodCode?: string | null;
  /** I-88 follow-up: the final settlement that paid it. */
  appliedSettlementId?: string | null;
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
  a.deltaAmount === null
    ? 'Not valued: no valuation policy was in effect'
    : `Calculated: previously recognised ${a.previousRecognizedUnits}, corrected ${a.correctedUnits}, difference ${formatAmount(a.deltaAmount, a.currencyCode)}`,
  ...(a.targetPeriodCode ? [`Paid in payroll ${a.targetPeriodCode}`] : []),
  ...(a.appliedSettlementId ? ['Paid in the final settlement'] : []),
];

function DraftActions({ a, onDone }: { a: Adjustment; onDone: () => void }) {
  const [explanation, setExplanation] = useState(a.explanation ?? '');
  const save = useMutation({
    mutationFn: () => api<Adjustment>(`/v1/payroll/adjustments/${encodeURIComponent(a.id)}`, { method: 'PUT', body: { expectedVersion: a.version, explanation: explanation.trim() || null } }),
    onSuccess: () => onDone(),
  });
  const send = useMutation({ mutationFn: () => api(`/v1/payroll/adjustments/${encodeURIComponent(a.id)}/submit`, { body: { expectedVersion: a.version } }), onSuccess: () => onDone() });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!save.isPending) save.mutate();
  };
  return (
    <form className="stack" aria-label={`Draft case of ${a.employeeCode}`} onSubmit={submit}>
      <p className="hint">The figures are calculated from the processed payroll under the valuation policy in effect; saving or submitting values the case again.</p>
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
          {/* H2: an unresolved policy, or a case never valued, blocks approval, so the action is not offered; the server refuses it as well. */}
          <DecisionButtons
            url={`/v1/payroll/adjustment-tasks/${encodeURIComponent(taskId)}/decision`}
            canApprove={tasks.data.valuation.status === 'CONFIGURED' && a.deltaAmount !== null}
            approveNote={tasks.data.valuation.status === 'CONFIGURED' && a.deltaAmount === null ? 'This case was submitted before a valuation policy was in effect: return it so it is opened again and valued.' : undefined}
            name={`the case of ${a.employeeCode}`}
            onDone={() => void qc.invalidateQueries({ queryKey: ['adjustment-tasks'] })}
          />
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
  appliedPeriodCode?: string | null;
  /** I-88 follow-up: the final settlement that paid it. */
  appliedSettlementId?: string | null;
}

function ArrearsForm({ candidate, onDone }: { candidate: ArrearsCandidate; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [key] = useState(() => idempotencyKey('arrears'));
  const propose = useMutation({
    mutationFn: () => api<ArrearsCase>('/v1/payroll/arrears-cases', { body: { sourceRevisionId: candidate.sourceRevisionId, originRecordId: candidate.originRecordId, reason: reason.trim(), idempotencyKey: key } }),
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
      <p className="hint">{`The amounts are calculated in ${candidate.currencyCode} from the processed record and the revision, per component, as the month was paid.`}</p>
      <label>
        Reason
        <textarea rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <ErrorNote error={propose.error} />
      <button type="submit" disabled={propose.isPending || !reason.trim()}>
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
      <p className="hint">Approving lets the first later payroll of the employee pay the calculated amount once, or recover a negative one. A processed payroll never changes.</p>
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
                    <th>Total</th>
                    <th>State</th>
                    <th>Paid in</th>
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
                      <td>{c.appliedPeriodCode ?? (c.appliedSettlementId ? 'Final settlement' : '—')}</td>
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
// I-79 valuation policy: the components arrears and adjustments are paid through, and the timesheet unit
// =========================================================================================================

interface ValuationPolicy {
  id: string;
  revision: number;
  effectiveFrom: string;
  arrearsComponentCode: string;
  adjustmentComponentCode: string;
  recoveryComponentCode: string | null;
  timesheetUnit: 'DAY' | 'HOUR';
  hoursPerDay: string | null;
  state: string;
  createdBy: string;
  version: number;
}

function ValuationPolicyForm({ onDone }: { onDone: () => void }) {
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const [arrears, setArrears] = useState('');
  const [adjustment, setAdjustment] = useState('');
  const [recovery, setRecovery] = useState('');
  const [unit, setUnit] = useState<'DAY' | 'HOUR'>('DAY');
  const [hours, setHours] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<ValuationPolicy>('/v1/payroll/valuation-policies', {
        body: {
          effectiveFrom,
          arrearsComponentCode: arrears.trim(),
          adjustmentComponentCode: adjustment.trim(),
          ...(recovery.trim() ? { recoveryComponentCode: recovery.trim() } : {}),
          timesheetUnit: unit,
          ...(unit === 'HOUR' ? { hoursPerDay: hours.trim() } : {}),
        },
      }),
    onSuccess: () => onDone(),
  });
  const ready = effectiveFrom && arrears.trim() && adjustment.trim() && (unit === 'DAY' || hours.trim());
  return (
    <form
      className="stack"
      aria-label="New valuation policy"
      onSubmit={(e) => {
        e.preventDefault();
        if (!create.isPending && ready) create.mutate();
      }}
    >
      <p className="hint">Each component is a pay head on the input basis: arrears and adjustments are earnings, the recovery is a deduction. Without a recovery deduction, a negative arrear or adjustment cannot be approved.</p>
      <label>
        Effective from
        <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </label>
      <label>
        Arrears component code
        <input value={arrears} onChange={(e) => setArrears(e.target.value)} />
      </label>
      <label>
        Timesheet adjustment component code
        <input value={adjustment} onChange={(e) => setAdjustment(e.target.value)} />
      </label>
      <label>
        Recovery deduction code (optional)
        <input value={recovery} onChange={(e) => setRecovery(e.target.value)} />
      </label>
      <label>
        Timesheet unit
        <select value={unit} onChange={(e) => setUnit(e.target.value as 'DAY' | 'HOUR')}>
          <option value="DAY">Day</option>
          <option value="HOUR">Hour</option>
        </select>
      </label>
      {unit === 'HOUR' && (
        <label>
          Hours a day
          <input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
        </label>
      )}
      <ErrorNote error={create.error} />
      <button type="submit" disabled={create.isPending || !ready}>
        Save as draft
      </button>
    </form>
  );
}

function ValuationPoliciesScreen() {
  const { can, me } = useSession();
  const qc = useQueryClient();
  const policies = useQuery({ queryKey: ['valuation-policies'], queryFn: () => api<{ items: ValuationPolicy[] }>('/v1/payroll/valuation-policies') });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['valuation-policies'] });
  const activate = useMutation({
    mutationFn: (p: ValuationPolicy) => api<ValuationPolicy>(`/v1/payroll/valuation-policies/${encodeURIComponent(p.id)}/activate`, { body: { expectedVersion: p.version } }),
    onSuccess: () => refresh(),
  });
  return (
    <div className="stack">
      <Section title="Valuation policies">
        <p className="hint">
          The active policy in effect pays approved arrears and late-timesheet adjustments through the first later payroll, and values a late timesheet by the day or by the hour. A policy is activated by
          someone other than the person who drafted it; one with a later start date takes over from that date.
        </p>
        <ErrorNote error={policies.error ?? activate.error} />
        {policies.data?.items.length === 0 && <Empty>No valuation policy yet: arrears and timesheet adjustments cannot be approved.</Empty>}
        {policies.data && policies.data.items.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table aria-label="Valuation policies">
              <thead>
                <tr>
                  <th>Revision</th>
                  <th>From</th>
                  <th>Arrears</th>
                  <th>Adjustment</th>
                  <th>Recovery</th>
                  <th>Unit</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {policies.data.items.map((p) => (
                  <tr key={p.id}>
                    <td>{p.revision}</td>
                    <td>{formatDate(p.effectiveFrom)}</td>
                    <td>{p.arrearsComponentCode}</td>
                    <td>{p.adjustmentComponentCode}</td>
                    <td>{p.recoveryComponentCode ?? 'None'}</td>
                    <td>{p.timesheetUnit === 'HOUR' ? `Hour (${p.hoursPerDay} a day)` : 'Day'}</td>
                    <td>
                      <StateBadge state={p.state} />
                    </td>
                    <td>
                      {p.state === 'DRAFT' && can(CONFIG_ACTIVATE) && p.createdBy !== me?.userId && (
                        <button type="button" className="secondary" onClick={() => activate.mutate(p)} disabled={activate.isPending}>
                          Activate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
      {can(CONFIG_MANAGE) && (
        <Section title="Draft a valuation policy">
          <ValuationPolicyForm onDone={refresh} />
        </Section>
      )}
    </div>
  );
}

// =========================================================================================================

export const PAYROLL_ADJUSTMENT_SCREENS: ScreenRoute[] = [
  { path: '/payroll/adjustments', title: 'Late-timesheet adjustments', permission: ADJ_READ, nav: true, component: AdjustmentsScreen },
  { path: '/payroll/arrears', title: 'Arrear register', permission: ARR_READ, nav: true, component: ArrearsScreen },
  { path: '/payroll/valuation-policies', title: 'Arrears and adjustment valuation', permission: CONFIG_READ, nav: true, component: ValuationPoliciesScreen },
];

export const PAYROLL_ADJUSTMENT_TASK_QUEUES = [
  { permission: ADJ_DECIDE, title: 'Late-timesheet adjustments', component: AdjustmentQueue },
  { permission: ARR_DECIDE, title: 'Arrears cases', component: ArrearsQueue },
];
