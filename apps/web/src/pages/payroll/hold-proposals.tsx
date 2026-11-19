// Hold criteria, hold proposals from processed records, hold detail, withdrawal, review renewal and salary stop proposals.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type EmployeeHit, formatDate, localDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { byPrefix, EmployeePicker, EvidencePicker, Missing, Note, type PeriodChoice, PeriodPicker } from './pickers';
import { Problem, ReasonForm } from './problems';
import { Fact, GROUP, H3, type Hold, HOLD_ACTIVATE, HOLD_DEFINE, HOLD_KIND, HOLD_PROPOSE, HOLD_READ, HOLD_STATE, label, MONEY, money, PATHS, type SalaryStop, SCROLL, Status, STOP_MODE, TEXTAREA, useIntentKey, useKeys } from './shared';
import type { RunRecord } from './types';

// =========================================================================================================
// Hold criteria, hold proposals from processed records, withdrawal, review renewal; salary stop proposals
// =========================================================================================================

interface HoldCriterion {
  id: string;
  code: string;
  revision: number;
  category: string;
  applicability: string;
  scopeMode: string;
  maxReviewDays: number;
  /** H2 narrowing of the review cadence (null: the defaults of 2 and 5 business days); 0255. */
  firstEscalationBusinessDays?: number | null;
  escalationIntervalBusinessDays?: number | null;
  evidenceReference: string;
  validationReference: string;
  state: string;
  createdBy: string | null;
  activatedAt: string | null;
  retiredAt: string | null;
  version: number;
}
/** H2 selected defaults: first escalation after 2 business days unresolved, then every 5 (a criterion may narrow them). */
const DEFAULT_FIRST_ESCALATION = 2;
const DEFAULT_ESCALATION_INTERVAL = 5;
/** A criterion's escalation cadence in words, defaults marked. */
function cadenceText(c: Pick<HoldCriterion, 'firstEscalationBusinessDays' | 'escalationIntervalBusinessDays'>): string {
  const first = c.firstEscalationBusinessDays ?? DEFAULT_FIRST_ESCALATION;
  const every = c.escalationIntervalBusinessDays ?? DEFAULT_ESCALATION_INTERVAL;
  const narrowed = c.firstEscalationBusinessDays != null || c.escalationIntervalBusinessDays != null;
  return `After ${first}, then every ${every} business day${every === 1 ? '' : 's'}${narrowed ? ' (narrowed)' : ' (default)'}`;
}
interface HoldBalance {
  payable: string | null;
  held: string;
  unreserved: string | null;
  currencyCode: string;
}
interface HoldDetail extends Hold {
  evidenceReference: string | null;
  approvedAt: string | null;
  releaseReason: string | null;
  releaseEvidenceReference: string | null;
  record: HoldBalance | null;
}

const CRITERION_STATE: Record<string, string> = { DRAFT: 'Draft, not active', ACTIVE: 'Active', RETIRED: 'Retired' };
const CRITERION_CATEGORY: Record<string, string> = { CONTRACTUAL: 'Contractual', LEGAL_DISCIPLINARY: 'Legal or disciplinary' };
const SCOPE_MODE: Record<string, string> = { FULL_ONLY: 'Full net pay only', FULL_OR_PARTIAL: 'Full or partial' };
/** A positive amount, decided on the string (never as a number): not only zeros. */
export const ZERO = /^0+(\.0+)?$/;

function useCriteria() {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({ queryKey: keys.criteria, queryFn: () => api<{ items: HoldCriterion[] }>('/v1/payroll/hold-criteria'), enabled: can(HOLD_READ), retry: retryTransient });
}

export function HoldCriteriaSection() {
  const { can, me } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const criteria = useCriteria();
  const [retiring, setRetiring] = useState<HoldCriterion | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const act = useMutation({
    mutationFn: ({ c, action, body }: { c: HoldCriterion; action: 'activate' | 'retire'; body: Record<string, unknown> }) =>
      api<HoldCriterion>(`/v1/payroll/hold-criteria/${encodeURIComponent(c.id)}/${action}`, { body }),
    onSuccess: (r, { action }) => {
      setRetiring(null);
      setNote(action === 'activate' ? `Criterion ${r.code} revision ${r.revision} is active: holds may now cite it.` : `Criterion ${r.code} revision ${r.revision} was retired: no new hold cites it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.criteria }),
  });
  const manage = can(HOLD_ACTIVATE);
  return (
    <Section title="Hold criteria">
      <p className="hint">
        {`Salary holds are disabled until the company activates a validated criterion; each is activated by someone other than its author.${manage || can(HOLD_DEFINE) ? '' : ' Read only for the selected role.'}`}
      </p>
      {criteria.isPending && <p className="hint loading">Loading hold criteria…</p>}
      {criteria.error && <Problem error={criteria.error} act="read" />}
      <Note text={note} />
      {criteria.data && criteria.data.items.length === 0 && <Empty>No hold criterion is defined, so no salary hold can be proposed.</Empty>}
      {criteria.data && criteria.data.items.length > 0 && (
        <div style={SCROLL}>
          <table aria-label="Hold criteria">
            <thead>
              <tr>
                <th>Code</th>
                <th>Revision</th>
                <th>Category</th>
                <th>Holds allowed</th>
                <th>Longest review</th>
                <th>Escalation while unresolved</th>
                <th>Applies when</th>
                <th>State</th>
                {manage && <th>Change</th>}
              </tr>
            </thead>
            <tbody>
              {criteria.data.items.map((c) => (
                <tr key={c.id}>
                  <td>{c.code}</td>
                  <td>{c.revision}</td>
                  <td>{label(CRITERION_CATEGORY, c.category)}</td>
                  <td>{label(SCOPE_MODE, c.scopeMode)}</td>
                  <td>{`${c.maxReviewDays} days`}</td>
                  <td>{cadenceText(c)}</td>
                  <td>{c.applicability}</td>
                  <td>
                    <Status map={CRITERION_STATE} code={c.state} />
                  </td>
                  {manage && (
                    <td>
                      {c.state === 'DRAFT' && c.createdBy === me?.userId && 'You wrote it: someone else activates it'}
                      {c.state === 'DRAFT' && c.createdBy !== me?.userId && (
                        <button
                          type="button"
                          className="link"
                          disabled={act.isPending}
                          onClick={() => {
                            setNote(null);
                            act.mutate({ c, action: 'activate', body: { expectedVersion: c.version } });
                          }}
                          aria-label={`Activate criterion ${c.code} revision ${c.revision}`}
                        >
                          Activate
                        </button>
                      )}
                      {c.state === 'ACTIVE' && (
                        <button
                          type="button"
                          className="link"
                          disabled={act.isPending}
                          onClick={() => {
                            act.reset();
                            setNote(null);
                            setRetiring(c);
                          }}
                          aria-label={`Retire criterion ${c.code} revision ${c.revision}`}
                        >
                          Retire
                        </button>
                      )}
                      {c.state === 'RETIRED' && '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {retiring && (
        <ReasonForm
          key={retiring.id}
          name={`Retire criterion ${retiring.code}`}
          field="Why the criterion is retired"
          button="Retire the criterion"
          busy={act.isPending}
          danger
          onSend={(reason) => act.mutateAsync({ c: retiring, action: 'retire', body: { reason, expectedVersion: retiring.version } })}
        />
      )}
      <Problem error={act.error} act="criterion" />
      {can(HOLD_DEFINE) && <CriterionForm />}
    </Section>
  );
}

function CriterionForm() {
  const keys = useKeys();
  const qc = useQueryClient();
  // Nothing prefilled: the category and whether partial holds are allowed are the definer's choice (I-28).
  // The escalation intervals stay at the H2 defaults unless the definer narrows them (never wider: 0255).
  const empty = { code: '', category: '', applicability: '', scopeMode: '', maxReviewDays: '', firstEscalation: '', escalationInterval: '', evidenceReference: '', validationReference: '' };
  const [f, setF] = useState(empty);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<HoldCriterion>('/v1/payroll/hold-criteria', { body }),
    onSuccess: (c) => {
      setF(empty);
      setNote(`Criterion ${c.code} revision ${c.revision} saved as a draft: someone other than you activates it.`);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.criteria }),
  });
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (create.isPending) return;
    if (!f.code.trim() || !f.applicability.trim()) return setProblem('Give the code and when the criterion applies.');
    if (!f.category || !f.scopeMode) return setProblem('Choose the category and whether partial holds are allowed.');
    const days = f.maxReviewDays.trim();
    if (!/^\d{1,3}$/.test(days) || Number(days) < 1 || Number(days) > 366) return setProblem('The longest review interval is 1 to 366 days.');
    if (!f.evidenceReference.trim() || !f.validationReference.trim()) return setProblem('Give the evidence reference and the validation reference.');
    setProblem(null);
    setNote(null);
    create.reset();
    create.mutate({
      code: f.code.trim().toUpperCase(),
      category: f.category,
      applicability: f.applicability.trim(),
      scopeMode: f.scopeMode,
      maxReviewDays: Number(days),
      ...(f.firstEscalation ? { firstEscalationBusinessDays: Number(f.firstEscalation) } : {}),
      ...(f.escalationInterval ? { escalationIntervalBusinessDays: Number(f.escalationInterval) } : {}),
      evidenceReference: f.evidenceReference.trim(),
      validationReference: f.validationReference.trim(),
    });
  };
  return (
    <form onSubmit={submit} aria-label="Define a hold criterion" className="grid-form" style={{ marginTop: '0.75rem' }}>
      <h3 style={H3} className="wide">
        Define a hold criterion
      </h3>
      <label>
        Criterion code
        <input value={f.code} onChange={(e) => set({ code: e.target.value })} maxLength={40} autoComplete="off" />
      </label>
      <label>
        Category
        <select value={f.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">Choose the category</option>
          {Object.entries(CRITERION_CATEGORY).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Holds allowed
        <select value={f.scopeMode} onChange={(e) => set({ scopeMode: e.target.value })}>
          <option value="">Choose</option>
          {Object.entries(SCOPE_MODE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      <label>
        Longest review interval (days)
        <input value={f.maxReviewDays} onChange={(e) => set({ maxReviewDays: e.target.value })} inputMode="numeric" maxLength={3} />
      </label>
      <label>
        First escalation after (business days)
        <select value={f.firstEscalation} onChange={(e) => set({ firstEscalation: e.target.value })}>
          <option value="">{`${DEFAULT_FIRST_ESCALATION} (default)`}</option>
          {Array.from({ length: DEFAULT_FIRST_ESCALATION - 1 }, (_, i) => String(i + 1)).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label>
        Then escalate every (business days)
        <select value={f.escalationInterval} onChange={(e) => set({ escalationInterval: e.target.value })}>
          <option value="">{`${DEFAULT_ESCALATION_INTERVAL} (default)`}</option>
          {Array.from({ length: DEFAULT_ESCALATION_INTERVAL - 1 }, (_, i) => String(i + 1)).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <p className="hint wide">
        An unresolved hold under this criterion is reminded daily and escalated on this cadence. The criterion may shorten the H2 defaults (2, then every 5 business days), never
        lengthen them; each hold keeps the cadence of the revision it was decided under. An automatic bank safety block always keeps the defaults.
      </p>
      <label className="wide">
        When the criterion applies
        <textarea value={f.applicability} onChange={(e) => set({ applicability: e.target.value })} maxLength={2000} rows={2} style={TEXTAREA} />
      </label>
      <label>
        Evidence reference
        <input value={f.evidenceReference} onChange={(e) => set({ evidenceReference: e.target.value })} maxLength={500} autoComplete="off" />
      </label>
      <label>
        Validation reference
        <input value={f.validationReference} onChange={(e) => set({ validationReference: e.target.value })} maxLength={500} autoComplete="off" />
      </label>
      <div className="row">
        <button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save the criterion as a draft'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Note text={note} />
        <Problem error={create.error} act="criterion" />
      </div>
    </form>
  );
}

/** The hold position of one processed record (hold read) and a hold proposal (hold propose). */
export function RecordHoldPanel({ record }: { record: RunRecord }) {
  const { can } = useSession();
  const keys = useKeys();
  const balance = useQuery({
    queryKey: keys.holdBalance(record.id),
    queryFn: () => api<HoldBalance>(`/v1/payroll/records/${encodeURIComponent(record.id)}/hold-balance`),
    enabled: can(HOLD_READ),
    retry: retryTransient,
  });
  const b = balance.data;
  return (
    <div role="region" aria-label={`Salary hold position of ${record.employeeCode}`} style={{ marginTop: '0.5rem' }}>
      <h3 style={H3}>{`Salary hold: ${record.employeeCode} ${record.employeeName}`}</h3>
      {can(HOLD_READ) && (
        <>
          {balance.isPending && <p className="hint loading">Loading the hold position…</p>}
          {balance.error && <Problem error={balance.error} act="read" />}
          {b && (
            <dl className="kv" aria-label="Hold position">
              <Fact term="Payable net">{money(b.payable, b.currencyCode)}</Fact>
              <Fact term="Held by live holds">{money(b.held, b.currencyCode)}</Fact>
              <Fact term="Unpaid and unreserved">{money(b.unreserved, b.currencyCode)}</Fact>
            </dl>
          )}
        </>
      )}
      {can(HOLD_PROPOSE) && <HoldProposalForm record={record} />}
    </div>
  );
}

function HoldProposalForm({ record }: { record: RunRecord }) {
  const { can } = useSession();
  const qc = useQueryClient();
  const criteria = useCriteria();
  const intent = useIntentKey('payroll-hold');
  const empty = { criterionId: '', scope: 'FULL', amount: '', effectiveDate: localDate(), reviewDueOn: '', reason: '', releaseCriterion: '', evidenceReference: '' };
  const [f, setF] = useState(empty);
  const [documents, setDocuments] = useState<string[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = (patch: Partial<typeof empty>) => setF((prev) => ({ ...prev, ...patch }));
  const propose = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Hold & { replayed: boolean }>(`/v1/payroll/records/${encodeURIComponent(record.id)}/holds`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      void qc.invalidateQueries(byPrefix('payroll-hold'));
    },
    onSuccess: (h) => {
      setF(empty);
      setDocuments([]);
      setNote(
        h.replayed
          ? 'This hold had already been proposed; nothing was proposed twice.'
          : `Hold proposed for ${h.employeeCode}: ${h.scope === 'PARTIAL' ? money(h.holdAmount, h.currencyCode) : 'the whole unpaid net'} is kept out of bank files while it waits for an independent decision.`,
      );
    },
  });
  if (!can(HOLD_READ)) return <p className="hint">The selected role cannot list the hold criteria, so it cannot propose a hold.</p>;
  const active = (criteria.data?.items ?? []).filter((c) => c.state === 'ACTIVE');
  const criterion = active.find((c) => c.id === f.criterionId);
  const partialAllowed = criterion?.scopeMode === 'FULL_OR_PARTIAL';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (propose.isPending) return;
    if (!criterion) return setProblem('Choose the active hold criterion.');
    const partial = f.scope === 'PARTIAL';
    if (partial && !partialAllowed) return setProblem('This criterion allows only a hold of the full unpaid net pay.');
    if (partial && (!MONEY.test(f.amount.trim()) || ZERO.test(f.amount.trim()))) return setProblem('Enter the amount to hold: above zero, with at most four decimals.');
    if (!f.effectiveDate || !f.reviewDueOn) return setProblem('Give the effective date and the review date.');
    if (!f.reason.trim() || !f.releaseCriterion.trim()) return setProblem('Give the reason and the release criterion.');
    if (!f.evidenceReference.trim() || documents.length === 0) return setProblem('Give the evidence reference and choose at least one released, verified document.');
    setProblem(null);
    setNote(null);
    propose.reset();
    const body = {
      criterionId: criterion.id,
      scope: f.scope,
      ...(partial ? { amount: f.amount.trim() } : {}),
      reason: f.reason.trim(),
      effectiveDate: f.effectiveDate,
      reviewDueOn: f.reviewDueOn,
      releaseCriterion: f.releaseCriterion.trim(),
      evidenceReference: f.evidenceReference.trim(),
      evidenceDocumentIds: documents,
    };
    propose.mutate({ ...body, idempotencyKey: intent.key(JSON.stringify([record.id, body])) });
  };
  return (
    <form onSubmit={submit} aria-label={`Propose a hold for ${record.employeeCode}`} className="grid-form" style={{ marginTop: '0.5rem' }}>
      {criteria.data && active.length === 0 && <p className="hint wide">No hold criterion is active, so no hold can be proposed (holds are disabled until a validated criterion is activated).</p>}
      <label>
        Hold criterion
        <select
          value={f.criterionId}
          onChange={(e) => {
            const c = active.find((x) => x.id === e.target.value);
            set({ criterionId: e.target.value, ...(c?.scopeMode === 'FULL_OR_PARTIAL' ? {} : { scope: 'FULL', amount: '' }) });
          }}
        >
          <option value="">Choose a criterion</option>
          {active.map((c) => (
            <option key={c.id} value={c.id}>
              {`${c.code} revision ${c.revision} (${label(CRITERION_CATEGORY, c.category)})`}
            </option>
          ))}
        </select>
      </label>
      <fieldset style={GROUP}>
        <legend>What is held</legend>
        <label className="check">
          <input type="radio" name={`scope-${record.id}`} checked={f.scope === 'FULL'} onChange={() => set({ scope: 'FULL', amount: '' })} /> The whole unpaid, unreserved net
        </label>
        <label className="check">
          <input type="radio" name={`scope-${record.id}`} checked={f.scope === 'PARTIAL'} disabled={!partialAllowed} onChange={() => set({ scope: 'PARTIAL' })} /> Part of it
        </label>
      </fieldset>
      {f.scope === 'PARTIAL' && (
        <label>
          {`Amount to hold (${record.currencyCode})`}
          <input value={f.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" maxLength={20} autoComplete="off" />
        </label>
      )}
      {criterion && <p className="hint wide">{`The review date is at most ${criterion.maxReviewDays} days after the effective date. A partial hold is at most the unpaid, unreserved amount.`}</p>}
      <label>
        Effective date
        <input type="date" value={f.effectiveDate} onChange={(e) => set({ effectiveDate: e.target.value })} />
      </label>
      <label>
        Review date
        <input type="date" value={f.reviewDueOn} onChange={(e) => set({ reviewDueOn: e.target.value })} />
      </label>
      <label className="wide">
        Reason for the hold
        <textarea value={f.reason} onChange={(e) => set({ reason: e.target.value })} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <label className="wide">
        Release criterion
        <textarea value={f.releaseCriterion} onChange={(e) => set({ releaseCriterion: e.target.value })} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <label>
        Evidence reference
        <input value={f.evidenceReference} onChange={(e) => set({ evidenceReference: e.target.value })} maxLength={500} autoComplete="off" />
      </label>
      <EvidencePicker employeeId={record.employeeId} chosen={documents} onChange={setDocuments} max={10} />
      <div className="row">
        <button type="submit" disabled={propose.isPending}>
          {propose.isPending ? 'Proposing…' : 'Propose the hold'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Note text={note} />
        <Problem error={propose.error} act="hold-propose" />
      </div>
    </form>
  );
}

export function HoldDetailView({ id }: { id: string }) {
  const keys = useKeys();
  const hold = useQuery({ queryKey: keys.hold(id), queryFn: () => api<HoldDetail>(`/v1/payroll/holds/${encodeURIComponent(id)}`), retry: retryTransient });
  const h = hold.data;
  if (hold.isPending) return <p className="hint loading">Loading the hold…</p>;
  if (!h) return <Problem error={hold.error} act="read" />;
  return (
    <div role="region" aria-label={`Hold of ${h.employeeCode} for ${h.periodCode}`} style={{ marginTop: '0.5rem' }}>
      <h3 style={H3}>{`${label(HOLD_KIND, h.holdKind)} of ${h.employeeCode} for ${h.periodCode}`}</h3>
      <dl className="kv">
        <Fact term="State">
          <Status map={HOLD_STATE} code={h.state} />
        </Fact>
        <Fact term="Held">{h.scope === 'PARTIAL' ? money(h.holdAmount, h.currencyCode) : 'Full net pay'}</Fact>
        {h.criterionCode && <Fact term="Criterion">{h.criterionCode}</Fact>}
        {h.reason && <Fact term="Reason">{h.reason}</Fact>}
        <Fact term="Effective">{formatDate(h.effectiveDate)}</Fact>
        <Fact term="Review due">{formatDate(h.reviewDueOn)}</Fact>
        {h.releaseCriterion && <Fact term="Release criterion">{h.releaseCriterion}</Fact>}
        {h.evidenceReference && <Fact term="Evidence">{h.evidenceReference}</Fact>}
        <Fact term="Proposed">{formatDate(h.proposedAt)}</Fact>
        <Fact term="Approved">{formatDate(h.approvedAt)}</Fact>
        <Fact term="Released">{formatDate(h.releasedAt)}</Fact>
        {h.releaseReason && <Fact term="Release reason">{h.releaseReason}</Fact>}
        {h.releaseEvidenceReference && <Fact term="Release evidence">{h.releaseEvidenceReference}</Fact>}
      </dl>
      {h.record && (
        <dl className="kv" aria-label="Hold position of the record">
          <Fact term="Payable net">{money(h.record.payable, h.record.currencyCode)}</Fact>
          <Fact term="Held by live holds">{money(h.record.held, h.record.currencyCode)}</Fact>
          <Fact term="Unpaid and unreserved">{money(h.record.unreserved, h.record.currencyCode)}</Fact>
        </dl>
      )}
    </div>
  );
}

export function HoldWithdraw({ hold, onDone }: { hold: Hold; onDone: (text: string) => void }) {
  const withdraw = useMutation({
    mutationFn: (reason: string) => api<Hold>(`/v1/payroll/holds/${encodeURIComponent(hold.id)}/withdraw`, { body: { reason } }),
    onSuccess: () => onDone(`The hold proposal of ${hold.employeeCode} was withdrawn: nothing is withheld for it.`),
  });
  return (
    <>
      <ReasonForm name={`Withdraw the hold proposal of ${hold.employeeCode}`} field="Why the proposal is withdrawn" button="Withdraw the proposal" busy={withdraw.isPending} onSend={(r) => withdraw.mutateAsync(r)} />
      <Problem error={withdraw.error} act="hold-act" />
    </>
  );
}

export function HoldRenew({ hold, maker, onDone }: { hold: Hold; maker: boolean; onDone: (text: string) => void }) {
  const [reviewDueOn, setReviewDueOn] = useState('');
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const renew = useMutation({
    mutationFn: (body: { reviewDueOn: string; reason: string; expectedVersion: number }) => api<Hold>(`/v1/payroll/holds/${encodeURIComponent(hold.id)}/renew-review`, { body }),
    onSuccess: (h) => onDone(`The review of the hold of ${hold.employeeCode} is renewed until ${formatDate(h.reviewDueOn)}; the payment stays withheld.`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (renew.isPending || maker) return;
    if (!reviewDueOn || !reason.trim()) return setProblem('Give the new review date and the reason.');
    setProblem(null);
    renew.reset();
    renew.mutate({ reviewDueOn, reason: reason.trim(), expectedVersion: hold.version });
  };
  return (
    <form onSubmit={submit} aria-label={`Renew the review of the hold of ${hold.employeeCode}`} className="grid-form" style={{ marginTop: '0.5rem' }}>
      {maker && <p className="hint wide">You proposed this hold, so someone else renews its review.</p>}
      <label>
        New review date
        <input type="date" value={reviewDueOn} min={localDate()} onChange={(e) => setReviewDueOn(e.target.value)} />
      </label>
      <label className="wide">
        Why the hold continues
        <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
      </label>
      <div className="row">
        <button type="submit" disabled={renew.isPending || maker}>
          {renew.isPending ? 'Renewing…' : 'Renew the review'}
        </button>
      </div>
      <Missing text={problem} />
      <div className="wide">
        <Problem error={renew.error} act="hold-act" />
      </div>
    </form>
  );
}

type StopModeCode = 'HOLD_DISBURSEMENT' | 'EXCLUDE_CALCULATION';

export function StopProposalForm() {
  const { can } = useSession();
  const qc = useQueryClient();
  const criteria = useCriteria();
  const intent = useIntentKey('payroll-stop');
  const [period, setPeriod] = useState<PeriodChoice | null>(null);
  const [employee, setEmployee] = useState<EmployeeHit | null>(null);
  const [mode, setMode] = useState<StopModeCode>('HOLD_DISBURSEMENT');
  const [criterionId, setCriterionId] = useState('');
  const [reason, setReason] = useState('');
  const [releaseCriterion, setReleaseCriterion] = useState('');
  const [evidenceReference, setEvidenceReference] = useState('');
  const [documents, setDocuments] = useState<string[]>([]);
  const [excludeConfirmed, setExcludeConfirmed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const propose = useMutation({
    mutationFn: ({ periodId, body }: { periodId: string; body: Record<string, unknown> }) =>
      api<SalaryStop & { replayed: boolean }>(`/v1/payroll/periods/${encodeURIComponent(periodId)}/salary-stops`, { body }),
    onSettled: (_d, error) => {
      intent.settle(error);
      void qc.invalidateQueries(byPrefix('payroll-stop'));
    },
    onSuccess: (s) => {
      setEmployee(null);
      setReason('');
      setReleaseCriterion('');
      setEvidenceReference('');
      setDocuments([]);
      setCriterionId('');
      setExcludeConfirmed(false);
      setMode('HOLD_DISBURSEMENT');
      setNote(
        s.replayed
          ? 'This salary stop had already been proposed; nothing was proposed twice.'
          : `Salary stop of ${s.employeeCode} for ${s.periodCode} proposed (${label(STOP_MODE, s.mode)}): it waits for an independent decision.`,
      );
    },
  });
  const active = (criteria.data?.items ?? []).filter((c) => c.state === 'ACTIVE');
  const withhold = mode === 'HOLD_DISBURSEMENT';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (propose.isPending) return;
    if (!period || !employee) return setProblem('Choose the period and the employee.');
    if (withhold && (!criterionId || !releaseCriterion.trim())) return setProblem('Withholding a payment needs an active hold criterion and the release criterion.');
    if (!withhold && !excludeConfirmed) return setProblem('Confirm that the employee is left out of the calculation.');
    if (!reason.trim()) return setProblem('Give the reason for the salary stop.');
    if (!evidenceReference.trim() || documents.length === 0) return setProblem('Give the evidence reference and choose at least one released, verified document.');
    setProblem(null);
    setNote(null);
    propose.reset();
    const body = {
      employeeId: employee.id,
      mode,
      ...(withhold ? { criterionId, releaseCriterion: releaseCriterion.trim() } : {}),
      reason: reason.trim(),
      evidenceReference: evidenceReference.trim(),
      evidenceDocumentIds: documents,
    };
    propose.mutate({ periodId: period.periodId, body: { ...body, idempotencyKey: intent.key(JSON.stringify([period.periodId, body])) } });
  };
  return (
    <Section title="Propose a salary stop">
      <p className="hint">A salary stop is decided by someone independent before the period’s calculation. Withholding the payment keeps the salary calculated but unpaid; leaving the employee out of the calculation is an exceptional mode that must be confirmed.</p>
      <form onSubmit={submit} aria-label="Propose a salary stop" className="grid-form">
        <PeriodPicker value={period} onChange={setPeriod} purpose="of the salary stop" />
        <EmployeePicker
          title="Employee"
          value={employee}
          onChange={(e) => {
            setEmployee(e);
            setDocuments([]);
          }}
        />
        <fieldset style={GROUP} className="wide">
          <legend>Mode</legend>
          <label className="check">
            <input
              type="radio"
              name="stop-mode"
              checked={withhold}
              onChange={() => {
                setMode('HOLD_DISBURSEMENT');
                setExcludeConfirmed(false);
              }}
            />{' '}
            {STOP_MODE.HOLD_DISBURSEMENT}
          </label>
          <label className="check">
            <input
              type="radio"
              name="stop-mode"
              checked={!withhold}
              onChange={() => {
                setMode('EXCLUDE_CALCULATION');
                setCriterionId('');
                setReleaseCriterion('');
              }}
            />{' '}
            {STOP_MODE.EXCLUDE_CALCULATION}
          </label>
        </fieldset>
        {withhold && !can(HOLD_READ) && <p className="hint wide">The selected role cannot list the hold criteria, so it cannot propose withholding a payment.</p>}
        {withhold && can(HOLD_READ) && criteria.data && active.length === 0 && <p className="hint wide">No hold criterion is active, so a payment cannot be withheld (disabled until a validated criterion is activated).</p>}
        {withhold && (
          <>
            <label>
              Hold criterion
              <select value={criterionId} onChange={(e) => setCriterionId(e.target.value)}>
                <option value="">Choose a criterion</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {`${c.code} revision ${c.revision}`}
                  </option>
                ))}
              </select>
            </label>
            <label className="wide">
              Release criterion
              <textarea value={releaseCriterion} onChange={(e) => setReleaseCriterion(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
            </label>
          </>
        )}
        {!withhold && (
          <label className="check wide">
            <input type="checkbox" checked={excludeConfirmed} onChange={(e) => setExcludeConfirmed(e.target.checked)} /> I confirm that the employee is left out of this period’s calculation entirely: nothing is calculated for them, which is not a payment hold.
          </label>
        )}
        <label className="wide">
          Reason for the salary stop
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} style={TEXTAREA} />
        </label>
        <label>
          Evidence reference
          <input value={evidenceReference} onChange={(e) => setEvidenceReference(e.target.value)} maxLength={500} autoComplete="off" />
        </label>
        {employee && <EvidencePicker employeeId={employee.id} chosen={documents} onChange={setDocuments} max={10} />}
        <div className="row">
          <button type="submit" disabled={propose.isPending}>
            {propose.isPending ? 'Proposing…' : 'Propose the salary stop'}
          </button>
        </div>
        <Missing text={problem} />
        <div className="wide">
          <Note text={note} />
          <Problem error={propose.error} act="stop-propose" />
        </div>
      </form>
      <p className="hint">
        Many stops at once: <Link to={PATHS.stopUpload}>upload a file of salary stops</Link>.
      </p>
    </Section>
  );
}
