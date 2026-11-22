// Hold criteria, hold proposals from processed records, hold detail, withdrawal, review renewal and salary stop proposals.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router-dom';
import { CardSubheading } from '@/components/card-subheading';
import { ButtonRow, CheckField, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { FieldSet } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { api, type EmployeeHit, formatDate, localDate, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Empty, Section } from '../../ui';
import { byPrefix, EmployeePicker, EvidencePicker, Missing, Note, type PeriodChoice, PeriodPicker } from './pickers';
import { Problem, ReasonForm } from './problems';
import { Fact, type Hold, HOLD_ACTIVATE, HOLD_DEFINE, HOLD_KIND, HOLD_PROPOSE, HOLD_READ, HOLD_STATE, label, MONEY, money, PATHS, type SalaryStop, Status, STOP_MODE, useIntentKey, useKeys } from './shared';
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
/** A group of radio buttons under its legend, one under another, as close together as the old fieldset rule drew them. */
const CHOICE_GROUP = 'gap-[0.55rem]';

function useCriteria() {
  const { can } = useSession();
  const keys = useKeys();
  return useQuery({ queryKey: keys.criteria, queryFn: () => api<{ items: HoldCriterion[] }>('/v1/payroll/hold-criteria'), enabled: can(HOLD_READ), retry: retryTransient });
}

/** What a criterion's change cell offers: activation by someone other than its author, retirement once active. */
function CriterionChange({ criterion: c, busy, onActivate, onRetire }: { criterion: HoldCriterion; busy: boolean; onActivate: () => void; onRetire: () => void }) {
  const { me } = useSession();
  return (
    <RowActions>
      {c.state === 'DRAFT' && c.createdBy === me?.userId && 'You wrote it: someone else activates it'}
      {c.state === 'DRAFT' && c.createdBy !== me?.userId && (
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={onActivate} aria-label={`Activate criterion ${c.code} revision ${c.revision}`}>
          Activate
        </Button>
      )}
      {c.state === 'ACTIVE' && (
        <Button type="button" variant="danger" size="sm" disabled={busy} onClick={onRetire} aria-label={`Retire criterion ${c.code} revision ${c.revision}`}>
          Retire
        </Button>
      )}
      {c.state === 'RETIRED' && '—'}
    </RowActions>
  );
}

export function HoldCriteriaSection() {
  const { can } = useSession();
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
      <Hint>
        {`Salary holds are disabled until the company activates a validated criterion; each is activated by someone other than its author.${manage || can(HOLD_DEFINE) ? '' : ' Read only for the selected role.'}`}
      </Hint>
      {criteria.isPending && <LoadingLine>Loading hold criteria…</LoadingLine>}
      {criteria.error && <Problem error={criteria.error} act="read" />}
      <Note text={note} />
      {criteria.data && criteria.data.items.length === 0 && <Empty>No hold criterion is defined, so no salary hold can be proposed.</Empty>}
      {criteria.data && criteria.data.items.length > 0 && (
        <Table aria-label="Hold criteria">
          <TableHeader>
            <TableRow>
              <TableHead scope="col">Code</TableHead>
              <TableHead scope="col">Revision</TableHead>
              <TableHead scope="col">Category</TableHead>
              <TableHead scope="col">Holds allowed</TableHead>
              <TableHead scope="col">Longest review</TableHead>
              <TableHead scope="col">Escalation while unresolved</TableHead>
              <TableHead scope="col">Applies when</TableHead>
              <TableHead scope="col">State</TableHead>
              {manage && <TableHead scope="col">Change</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {criteria.data.items.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{c.code}</TableCell>
                <TableCell>{c.revision}</TableCell>
                <TableCell>{label(CRITERION_CATEGORY, c.category)}</TableCell>
                <TableCell>{label(SCOPE_MODE, c.scopeMode)}</TableCell>
                <TableCell>{`${c.maxReviewDays} days`}</TableCell>
                <TableCell>{cadenceText(c)}</TableCell>
                <TableCell>{c.applicability}</TableCell>
                <TableCell>
                  <Status map={CRITERION_STATE} code={c.state} />
                </TableCell>
                {manage && (
                  <RowActionsCell>
                    <CriterionChange
                      criterion={c}
                      busy={act.isPending}
                      onActivate={() => {
                        setNote(null);
                        act.mutate({ c, action: 'activate', body: { expectedVersion: c.version } });
                      }}
                      onRetire={() => {
                        act.reset();
                        setNote(null);
                        setRetiring(c);
                      }}
                    />
                  </RowActionsCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
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

/** The narrowed choices of an escalation interval: the default first (an empty value), then every shorter whole number of days. */
function EscalationChoice({ text, defaultDays, value, onChange }: { text: string; defaultDays: number; value: string; onChange: (v: string) => void }) {
  return (
    <FormField>
      {text}
      <NativeSelect value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{`${defaultDays} (default)`}</option>
        {Array.from({ length: defaultDays - 1 }, (_, i) => String(i + 1)).map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </NativeSelect>
    </FormField>
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
    <FormGrid onSubmit={submit} aria-label="Define a hold criterion">
      <CardSubheading>Define a hold criterion</CardSubheading>
      <FormField>
        Criterion code
        <Input value={f.code} onChange={(e) => set({ code: e.target.value })} maxLength={40} autoComplete="off" />
      </FormField>
      <FormField>
        Category
        <NativeSelect value={f.category} onChange={(e) => set({ category: e.target.value })}>
          <option value="">Choose the category</option>
          {Object.entries(CRITERION_CATEGORY).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Holds allowed
        <NativeSelect value={f.scopeMode} onChange={(e) => set({ scopeMode: e.target.value })}>
          <option value="">Choose</option>
          {Object.entries(SCOPE_MODE).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </NativeSelect>
      </FormField>
      <FormField>
        Longest review interval (days)
        <Input value={f.maxReviewDays} onChange={(e) => set({ maxReviewDays: e.target.value })} inputMode="numeric" maxLength={3} />
      </FormField>
      <EscalationChoice text="First escalation after (business days)" defaultDays={DEFAULT_FIRST_ESCALATION} value={f.firstEscalation} onChange={(v) => set({ firstEscalation: v })} />
      <EscalationChoice text="Then escalate every (business days)" defaultDays={DEFAULT_ESCALATION_INTERVAL} value={f.escalationInterval} onChange={(v) => set({ escalationInterval: v })} />
      <Hint>
        An unresolved hold under this criterion is reminded daily and escalated on this cadence. The criterion may shorten the H2 defaults (2, then every 5 business days), never
        lengthen them; each hold keeps the cadence of the revision it was decided under. An automatic bank safety block always keeps the defaults.
      </Hint>
      <FormField className="col-span-full">
        When the criterion applies
        <Textarea value={f.applicability} onChange={(e) => set({ applicability: e.target.value })} maxLength={2000} rows={2} />
      </FormField>
      <FormField>
        Evidence reference
        <Input value={f.evidenceReference} onChange={(e) => set({ evidenceReference: e.target.value })} maxLength={500} autoComplete="off" />
      </FormField>
      <FormField>
        Validation reference
        <Input value={f.validationReference} onChange={(e) => set({ validationReference: e.target.value })} maxLength={500} autoComplete="off" />
      </FormField>
      <ButtonRow>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? 'Saving…' : 'Save the criterion as a draft'}
        </Button>
      </ButtonRow>
      <Missing text={problem} />
      <div className="col-span-full">
        <Note text={note} />
        <Problem error={create.error} act="criterion" />
      </div>
    </FormGrid>
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
    <div role="region" aria-label={`Salary hold position of ${record.employeeCode}`} className="mt-2">
      <CardSubheading>{`Salary hold: ${record.employeeCode} ${record.employeeName}`}</CardSubheading>
      {can(HOLD_READ) && (
        <>
          {balance.isPending && <LoadingLine>Loading the hold position…</LoadingLine>}
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
  if (!can(HOLD_READ)) return <Hint>The selected role cannot list the hold criteria, so it cannot propose a hold.</Hint>;
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
    <FormGrid onSubmit={submit} aria-label={`Propose a hold for ${record.employeeCode}`} className="mt-2">
      {criteria.data && active.length === 0 && <Hint>No hold criterion is active, so no hold can be proposed (holds are disabled until a validated criterion is activated).</Hint>}
      <FormField>
        Hold criterion
        <NativeSelect
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
        </NativeSelect>
      </FormField>
      <FieldSet className={CHOICE_GROUP}>
        <legend>What is held</legend>
        <CheckField>
          <input type="radio" name={`scope-${record.id}`} checked={f.scope === 'FULL'} onChange={() => set({ scope: 'FULL', amount: '' })} /> The whole unpaid, unreserved net
        </CheckField>
        <CheckField>
          <input type="radio" name={`scope-${record.id}`} checked={f.scope === 'PARTIAL'} disabled={!partialAllowed} onChange={() => set({ scope: 'PARTIAL' })} /> Part of it
        </CheckField>
      </FieldSet>
      {f.scope === 'PARTIAL' && (
        <FormField>
          {`Amount to hold (${record.currencyCode})`}
          <Input value={f.amount} onChange={(e) => set({ amount: e.target.value })} inputMode="decimal" maxLength={20} autoComplete="off" />
        </FormField>
      )}
      {criterion && <Hint>{`The review date is at most ${criterion.maxReviewDays} days after the effective date. A partial hold is at most the unpaid, unreserved amount.`}</Hint>}
      <FormField>
        Effective date
        <Input type="date" value={f.effectiveDate} onChange={(e) => set({ effectiveDate: e.target.value })} />
      </FormField>
      <FormField>
        Review date
        <Input type="date" value={f.reviewDueOn} onChange={(e) => set({ reviewDueOn: e.target.value })} />
      </FormField>
      <FormField className="col-span-full">
        Reason for the hold
        <Textarea value={f.reason} onChange={(e) => set({ reason: e.target.value })} maxLength={1000} rows={2} />
      </FormField>
      <FormField className="col-span-full">
        Release criterion
        <Textarea value={f.releaseCriterion} onChange={(e) => set({ releaseCriterion: e.target.value })} maxLength={1000} rows={2} />
      </FormField>
      <FormField>
        Evidence reference
        <Input value={f.evidenceReference} onChange={(e) => set({ evidenceReference: e.target.value })} maxLength={500} autoComplete="off" />
      </FormField>
      <EvidencePicker employeeId={record.employeeId} chosen={documents} onChange={setDocuments} max={10} />
      <ButtonRow>
        <Button type="submit" disabled={propose.isPending}>
          {propose.isPending ? 'Proposing…' : 'Propose the hold'}
        </Button>
      </ButtonRow>
      <Missing text={problem} />
      <div className="col-span-full">
        <Note text={note} />
        <Problem error={propose.error} act="hold-propose" />
      </div>
    </FormGrid>
  );
}

export function HoldDetailView({ id }: { id: string }) {
  const keys = useKeys();
  const hold = useQuery({ queryKey: keys.hold(id), queryFn: () => api<HoldDetail>(`/v1/payroll/holds/${encodeURIComponent(id)}`), retry: retryTransient });
  const h = hold.data;
  if (hold.isPending) return <LoadingLine>Loading the hold…</LoadingLine>;
  if (!h) return <Problem error={hold.error} act="read" />;
  return (
    <div role="region" aria-label={`Hold of ${h.employeeCode} for ${h.periodCode}`} className="mt-2">
      <CardSubheading>{`${label(HOLD_KIND, h.holdKind)} of ${h.employeeCode} for ${h.periodCode}`}</CardSubheading>
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
    <FormGrid onSubmit={submit} aria-label={`Renew the review of the hold of ${hold.employeeCode}`}>
      {maker && <Hint>You proposed this hold, so someone else renews its review.</Hint>}
      <FormField>
        New review date
        <Input type="date" value={reviewDueOn} min={localDate()} onChange={(e) => setReviewDueOn(e.target.value)} />
      </FormField>
      <FormField className="col-span-full">
        Why the hold continues
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
      </FormField>
      <ButtonRow>
        <Button type="submit" disabled={renew.isPending || maker}>
          {renew.isPending ? 'Renewing…' : 'Renew the review'}
        </Button>
      </ButtonRow>
      <Missing text={problem} />
      <div className="col-span-full">
        <Problem error={renew.error} act="hold-act" />
      </div>
    </FormGrid>
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
      <Hint>
        A salary stop is decided by someone independent before the period’s calculation. Withholding the payment keeps the salary calculated but unpaid; leaving the employee out
        of the calculation is an exceptional mode that must be confirmed.
      </Hint>
      <FormGrid onSubmit={submit} aria-label="Propose a salary stop">
        <PeriodPicker value={period} onChange={setPeriod} purpose="of the salary stop" />
        <EmployeePicker
          title="Employee"
          value={employee}
          onChange={(e) => {
            setEmployee(e);
            setDocuments([]);
          }}
        />
        <FieldSet className={CHOICE_GROUP}>
          <legend>Mode</legend>
          <CheckField>
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
          </CheckField>
          <CheckField>
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
          </CheckField>
        </FieldSet>
        {withhold && !can(HOLD_READ) && <Hint>The selected role cannot list the hold criteria, so it cannot propose withholding a payment.</Hint>}
        {withhold && can(HOLD_READ) && criteria.data && active.length === 0 && <Hint>No hold criterion is active, so a payment cannot be withheld (disabled until a validated criterion is activated).</Hint>}
        {withhold && (
          <>
            <FormField>
              Hold criterion
              <NativeSelect value={criterionId} onChange={(e) => setCriterionId(e.target.value)}>
                <option value="">Choose a criterion</option>
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {`${c.code} revision ${c.revision}`}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField className="col-span-full">
              Release criterion
              <Textarea value={releaseCriterion} onChange={(e) => setReleaseCriterion(e.target.value)} maxLength={1000} rows={2} />
            </FormField>
          </>
        )}
        {!withhold && (
          <CheckField className="col-span-full">
            <input type="checkbox" checked={excludeConfirmed} onChange={(e) => setExcludeConfirmed(e.target.checked)} /> I confirm that the employee is left out of this period’s calculation entirely: nothing is calculated for them, which is not a payment hold.
          </CheckField>
        )}
        <FormField className="col-span-full">
          Reason for the salary stop
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} rows={2} />
        </FormField>
        <FormField>
          Evidence reference
          <Input value={evidenceReference} onChange={(e) => setEvidenceReference(e.target.value)} maxLength={500} autoComplete="off" />
        </FormField>
        {employee && <EvidencePicker employeeId={employee.id} chosen={documents} onChange={setDocuments} max={10} />}
        <ButtonRow>
          <Button type="submit" disabled={propose.isPending}>
            {propose.isPending ? 'Proposing…' : 'Propose the salary stop'}
          </Button>
        </ButtonRow>
        <Missing text={problem} />
        <div className="col-span-full">
          <Note text={note} />
          <Problem error={propose.error} act="stop-propose" />
        </div>
      </FormGrid>
      <Hint>
        Many stops at once: <Link to={PATHS.stopUpload}>upload a file of salary stops</Link>.
      </Hint>
    </Section>
  );
}
