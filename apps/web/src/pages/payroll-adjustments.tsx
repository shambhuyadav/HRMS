// Later-period payroll cases (FR-035 arrears; FR-100 late or amended timesheets; DB111; H2; H3 TN13; H7) and the valuation policy they
// are paid under (I-79, decided under owner delegation, 6 Nov 2026). The server calculates every amount: a case shows its figures as
// returned and is never typed in. An independent reviewer approves; the first later payroll pays an approved case once and the case then
// names that payroll. Without an active valuation policy, approval of a timesheet adjustment is not offered and the reason is said.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ComponentPropsWithoutRef, type FormEvent, useState } from 'react';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { StatusNote } from '@/components/status-note';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
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

// The screens' own layout pieces, as utility classes and small components (shadcn/ui move, 20 Nov 2026).
/** A textarea keeps a readable width in a one-column form, as the old `.stack > label > textarea` rule had it. */
const READABLE_WIDTH = 'max-w-[560px]';

/**
 * One case of a list: a card inside the list's card. It keeps the `card` marker class, so its notes and forms are drawn as a card's
 * own (a boxed hint, a form without a frame of its own), as they were before the move to shadcn/ui.
 */
function CaseCard(props: ComponentPropsWithoutRef<'div'>) {
  return <div className="card rounded-xl border border-border bg-card px-5 py-4 shadow-xs not-last:mb-3" {...props} />;
}

function DecisionButtons({ url, canApprove, name, onDone, approveNote }: { url: string; canApprove: boolean; name: string; onDone: () => void; approveNote?: string }) {
  const [reason, setReason] = useState('');
  const decide = useMutation({
    mutationFn: (decision: 'APPROVE' | 'RETURN' | 'REJECT') => api(url, { body: { decision, idempotencyKey: idempotencyKey('payroll-case'), ...(reason.trim() ? { reason: reason.trim() } : {}) } }),
    onSuccess: () => onDone(),
  });
  return (
    <form className="flex flex-col gap-3" aria-label={`Decide ${name}`} onSubmit={(e) => e.preventDefault()}>
      <FormField className={READABLE_WIDTH}>
        Reason (needed to return or reject)
        <Textarea rows={2} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      {approveNote && <Hint>{approveNote}</Hint>}
      <ErrorNote error={decide.error} />
      <ButtonRow>
        {canApprove && (
          <Button type="button" onClick={() => decide.mutate('APPROVE')} disabled={decide.isPending}>
            Approve
          </Button>
        )}
        <Button type="button" variant="outline" onClick={() => decide.mutate('RETURN')} disabled={decide.isPending}>
          Return
        </Button>
        <Button type="button" variant="danger" onClick={() => decide.mutate('REJECT')} disabled={decide.isPending}>
          Reject
        </Button>
      </ButtonRow>
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
    <form className="flex flex-col gap-3" aria-label={`Draft case of ${a.employeeCode}`} onSubmit={submit}>
      <Hint>The figures are calculated from the processed payroll under the valuation policy in effect; saving or submitting values the case again.</Hint>
      <FormField className={READABLE_WIDTH}>
        Explanation
        <Textarea rows={2} maxLength={2000} value={explanation} onChange={(e) => setExplanation(e.target.value)} />
      </FormField>
      <ErrorNote error={save.error ?? send.error} />
      <ButtonRow>
        <Button type="submit" variant="outline" disabled={save.isPending}>
          Save draft
        </Button>
        <Button type="button" onClick={() => send.mutate()} disabled={send.isPending}>
          Submit for review
        </Button>
      </ButtonRow>
    </form>
  );
}

function AdjustmentQueue() {
  const { can } = useSession();
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['adjustment-tasks'], queryFn: () => api<{ items: { taskId: string; adjustment: Adjustment }[]; valuation: Note }>('/v1/payroll/adjustments/tasks/mine'), enabled: can(ADJ_DECIDE) });
  if (!can(ADJ_DECIDE)) return <Hint>The selected role does not decide payroll adjustments.</Hint>;
  return (
    <Section title="Late-timesheet adjustments to review">
      <ErrorNote error={tasks.error} />
      {tasks.data && (
        <StatusNote tone="info" role="status">
          {tasks.data.valuation.message}
        </StatusNote>
      )}
      {tasks.data?.items.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      {tasks.data?.items.map(({ taskId, adjustment: a }) => (
        <CaseCard key={taskId} aria-label={`Case of ${a.employeeCode}`}>
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
        </CaseCard>
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
  if (!can(ADJ_READ) && !can(ADJ_DECIDE)) return <Hint>The selected role cannot read payroll adjustments.</Hint>;
  return (
    <div className="flex flex-col gap-3">
      {can(ADJ_DECIDE) && <AdjustmentQueue />}
      {can(ADJ_READ) && (
        <Section title="Late or amended timesheets after a processed payroll">
          <ErrorNote error={candidates.error ?? open.error} />
          {candidates.data?.items.length === 0 && <Empty>No approved timesheet came after a processed payroll.</Empty>}
          {candidates.data && candidates.data.items.length > 0 && (
            <ul aria-label="Timesheets to raise">
              {candidates.data.items.map((c) => (
                <li key={`${c.timesheetId}:${c.originRecordId}`} className="py-1">
                  {`${c.employeeName} (${c.employeeCode}), ${formatDate(c.serviceStart)} to ${formatDate(c.serviceEnd)}, payroll ${c.originPeriodCode}: ${KIND[c.adjustmentKind] ?? c.adjustmentKind} `}
                  {can(ADJ_PROPOSE) && (
                    <Button type="button" variant="outline" size="sm" onClick={() => open.mutate(c)} disabled={open.isPending}>
                      Open a case
                    </Button>
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
          {list.data && (
            <StatusNote tone="info" role="status">
              {list.data.valuation.message}
            </StatusNote>
          )}
          {list.data?.items.length === 0 && <Empty>No cases yet.</Empty>}
          {list.data?.items.map((a) => (
            <CaseCard key={a.id} aria-label={`Adjustment of ${a.employeeCode}`}>
              <strong>{`${a.employeeName} (${a.employeeCode}) `}</strong>
              <StateBadge state={a.state} />
              <ul>
                {facts(a).map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
              {a.state === 'DRAFT' && can(ADJ_PROPOSE) && a.createdBy === me?.userId ? <DraftActions key={a.version} a={a} onDone={refresh} /> : a.explanation && <p>{a.explanation}</p>}
            </CaseCard>
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
          <Hint>{list.data.notice}</Hint>
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
      className="flex flex-col gap-3"
      aria-label={`Raise arrears for ${candidate.employeeCode} ${candidate.periodCode}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!propose.isPending) propose.mutate();
      }}
    >
      <p className="m-0">{`${candidate.employeeName} (${candidate.employeeCode}): salary revision from ${formatDate(candidate.sourceEffectiveFrom)}, processed payroll ${candidate.periodCode}`}</p>
      <Hint>{`The amounts are calculated in ${candidate.currencyCode} from the processed record and the revision, per component, as the month was paid.`}</Hint>
      <FormField className={READABLE_WIDTH}>
        Reason
        <Textarea rows={2} maxLength={2000} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
      <ErrorNote error={propose.error} />
      <ButtonRow>
        <Button type="submit" disabled={propose.isPending || !reason.trim()}>
          Raise the case
        </Button>
      </ButtonRow>
    </form>
  );
}

function ArrearsQueue() {
  const { can } = useSession();
  const qc = useQueryClient();
  const tasks = useQuery({ queryKey: ['arrears-tasks'], queryFn: () => api<{ items: { taskId: string; case: ArrearsCase }[] }>('/v1/payroll/arrears-cases/tasks/mine'), enabled: can(ARR_DECIDE) });
  if (!can(ARR_DECIDE)) return <Hint>The selected role does not decide arrears cases.</Hint>;
  return (
    <Section title="Arrears cases to decide">
      <Hint>Approving lets the first later payroll of the employee pay the calculated amount once, or recover a negative one. A processed payroll never changes.</Hint>
      <ErrorNote error={tasks.error} />
      {tasks.data?.items.length === 0 && <Empty>Nothing is waiting for you.</Empty>}
      {tasks.data?.items.map(({ taskId, case: c }) => (
        <CaseCard key={taskId} aria-label={`Arrears of ${c.employeeCode}`}>
          <strong>{`${c.employeeName} (${c.employeeCode}), ${c.periodCode}, revision from ${formatDate(c.sourceEffectiveFrom)}`}</strong>
          <ul>
            {c.lines.map((l) => (
              <li key={l.componentCode}>{`${l.componentCode}: ${formatAmount(l.amount, c.currencyCode)}`}</li>
            ))}
          </ul>
          <p>{c.reason}</p>
          <DecisionButtons url={`/v1/payroll/arrears-tasks/${encodeURIComponent(taskId)}/decision`} canApprove name={`the arrears of ${c.employeeCode}`} onDone={() => void qc.invalidateQueries({ queryKey: ['arrears-tasks'] })} />
        </CaseCard>
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
  if (!can(ARR_READ) && !can(ARR_DECIDE)) return <Hint>The selected role cannot read arrears cases.</Hint>;
  const refresh = () => {
    setRaising(null);
    void qc.invalidateQueries({ queryKey: ['arrears-register'] });
    void qc.invalidateQueries({ queryKey: ['arrears-candidates'] });
  };
  return (
    <div className="flex flex-col gap-3">
      {can(ARR_DECIDE) && <ArrearsQueue />}
      {can(ARR_READ) && (
        <Section title="Salary revisions a processed payroll did not reach">
          <ErrorNote error={candidates.error} />
          {candidates.data?.items.length === 0 && <Empty>No processed payroll is behind a salary revision.</Empty>}
          {candidates.data && candidates.data.items.length > 0 && (
            <ul aria-label="Revisions to raise">
              {candidates.data.items.map((c) => (
                <li key={`${c.sourceRevisionId}:${c.originRecordId}`} className="py-1">
                  {`${c.employeeName} (${c.employeeCode}): revision from ${formatDate(c.sourceEffectiveFrom)}, payroll ${c.periodCode} `}
                  {can(ARR_PROPOSE) && (
                    <Button type="button" variant="outline" size="sm" onClick={() => setRaising(c)}>
                      Raise a case
                    </Button>
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
          {register.data && (
            <StatusNote tone="info" role="status">
              {register.data.calculation.message}
            </StatusNote>
          )}
          {register.data?.items.length === 0 && <Empty>No arrears cases yet.</Empty>}
          {register.data && register.data.items.length > 0 && (
            <Table aria-label="Arrear register">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Employee</TableHead>
                  <TableHead scope="col">Source revision from</TableHead>
                  <TableHead scope="col">Period</TableHead>
                  <TableHead scope="col">Component detail</TableHead>
                  <TableHead scope="col">Total</TableHead>
                  <TableHead scope="col">State</TableHead>
                  <TableHead scope="col">Paid in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {register.data.items.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>{`${c.employeeName} (${c.employeeCode})`}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatDate(c.sourceEffectiveFrom)}</TableCell>
                    <TableCell>{c.periodCode}</TableCell>
                    <TableCell>{c.lines.map((l) => `${l.componentCode} ${formatAmount(l.amount, c.currencyCode)}`).join('; ')}</TableCell>
                    <TableCell className="whitespace-nowrap">{formatAmount(c.totalEntered, c.currencyCode)}</TableCell>
                    <TableCell>
                      <StateBadge state={c.state} />
                    </TableCell>
                    <TableCell>{c.appliedPeriodCode ?? (c.appliedSettlementId ? 'Final settlement' : '—')}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
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
    <FormGrid
      aria-label="New valuation policy"
      onSubmit={(e) => {
        e.preventDefault();
        if (!create.isPending && ready) create.mutate();
      }}
    >
      <Hint>Each component is a pay head on the input basis: arrears and adjustments are earnings, the recovery is a deduction. Without a recovery deduction, a negative arrear or adjustment cannot be approved.</Hint>
      <FormField>
        Effective from
        <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
      </FormField>
      <FormField>
        Arrears component code
        <Input value={arrears} onChange={(e) => setArrears(e.target.value)} />
      </FormField>
      <FormField>
        Timesheet adjustment component code
        <Input value={adjustment} onChange={(e) => setAdjustment(e.target.value)} />
      </FormField>
      <FormField>
        Recovery deduction code (optional)
        <Input value={recovery} onChange={(e) => setRecovery(e.target.value)} />
      </FormField>
      <FormField>
        Timesheet unit
        <NativeSelect value={unit} onChange={(e) => setUnit(e.target.value as 'DAY' | 'HOUR')}>
          <option value="DAY">Day</option>
          <option value="HOUR">Hour</option>
        </NativeSelect>
      </FormField>
      {unit === 'HOUR' && (
        <FormField>
          Hours a day
          <Input inputMode="decimal" value={hours} onChange={(e) => setHours(e.target.value)} />
        </FormField>
      )}
      <ErrorNote error={create.error} />
      <Button type="submit" disabled={create.isPending || !ready}>
        Save as draft
      </Button>
    </FormGrid>
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
    <div className="flex flex-col gap-3">
      <Section title="Valuation policies">
        <Hint>
          The active policy in effect pays approved arrears and late-timesheet adjustments through the first later payroll, and values a late timesheet by the day or by the hour. A policy is activated by
          someone other than the person who drafted it; one with a later start date takes over from that date.
        </Hint>
        <ErrorNote error={policies.error ?? activate.error} />
        {policies.data?.items.length === 0 && <Empty>No valuation policy yet: arrears and timesheet adjustments cannot be approved.</Empty>}
        {policies.data && policies.data.items.length > 0 && (
          <Table aria-label="Valuation policies">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Revision</TableHead>
                <TableHead scope="col">From</TableHead>
                <TableHead scope="col">Arrears</TableHead>
                <TableHead scope="col">Adjustment</TableHead>
                <TableHead scope="col">Recovery</TableHead>
                <TableHead scope="col">Unit</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {policies.data.items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{p.revision}</TableCell>
                  <TableCell className="whitespace-nowrap">{formatDate(p.effectiveFrom)}</TableCell>
                  <TableCell>{p.arrearsComponentCode}</TableCell>
                  <TableCell>{p.adjustmentComponentCode}</TableCell>
                  <TableCell>{p.recoveryComponentCode ?? 'None'}</TableCell>
                  <TableCell>{p.timesheetUnit === 'HOUR' ? `Hour (${p.hoursPerDay} a day)` : 'Day'}</TableCell>
                  <TableCell>
                    <StateBadge state={p.state} />
                  </TableCell>
                  <RowActionsCell>
                    {p.state === 'DRAFT' && can(CONFIG_ACTIVATE) && p.createdBy !== me?.userId && (
                      <RowActions>
                        <Button type="button" variant="outline" size="sm" onClick={() => activate.mutate(p)} disabled={activate.isPending}>
                          Activate
                        </Button>
                      </RowActions>
                    )}
                  </RowActionsCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
