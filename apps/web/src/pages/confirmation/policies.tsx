// Confirmation policies (FR-080, BR-029, DF11): every dated revision, a new policy, a new revision, an end date.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, useState } from 'react';
import { api, ApiError, formatDate, isForbidden, readable, retryTransient } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, NotPermitted, Section } from '../../ui';
import { PlainRefusal } from './case-panel';
import { MANAGE_POLICIES, SCROLL, SR_ONLY, useKeys } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Confirmation policies (FR-080, BR-029, DF11): every dated revision, a new policy, a new revision, an end date.
// ---------------------------------------------------------------------------------------------------------

type DurationUnit = 'CALENDAR_MONTHS' | 'CALENDAR_DAYS';

/** A policy revision as GET /v1/confirmation-policies lists it, by code and revision. */
interface Policy {
  id: string;
  code: string;
  revision: number;
  duration: number;
  durationUnit: DurationUnit;
  startBasis: string;
  /** I-84 item 12: the joining day counts as day one, so the review falls due one day earlier. */
  startDayInclusive?: boolean;
  employmentType: string | null;
  gradeName: string | null;
  locationName: string | null;
  effectiveFrom: string;
  /** Exclusive: the policy no longer applies to an employee joining on this date. */
  effectiveTo: string | null;
  status: 'SCHEDULED' | 'IN_FORCE' | 'ENDED';
  latest: boolean;
  /** The latest start date of a case under this revision: a new revision or an end date must come after it. */
  latestCaseStart: string | null;
  version: number;
}

interface PolicyList {
  items: Policy[];
  /** The active values a new policy can apply to. */
  applicability: {
    employmentTypes: { code: string; label: string }[];
    grades: { id: string; code: string; name: string }[];
    locations: { id: string; code: string; name: string }[];
  };
}

const UNIT_LABEL: Record<DurationUnit, string> = { CALENDAR_MONTHS: 'calendar months', CALENDAR_DAYS: 'calendar days' };
const POLICY_STATUS_LABEL: Record<Policy['status'], string> = { SCHEDULED: 'scheduled', IN_FORCE: 'in force', ENDED: 'ended' };
const appliesTo = (p: Policy) => [p.employmentType, p.gradeName, p.locationName].filter(Boolean).join(' · ') || 'Every employee';
const policyLabel = (p: Pick<Policy, 'code' | 'revision'>) => `${p.code} revision ${p.revision}`;

type PolicyAction = { kind: 'revise' | 'retire'; id: string };

export function ConfirmationPoliciesPage() {
  const { can } = useSession();
  const keys = useKeys();
  const qc = useQueryClient();
  const canManage = can(MANAGE_POLICIES);
  const list = useQuery({ queryKey: keys.policies, enabled: canManage, queryFn: () => api<PolicyList>('/v1/confirmation-policies'), retry: retryTransient });
  const [action, setAction] = useState<PolicyAction | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const reload = () => {
    void qc.invalidateQueries({ queryKey: keys.policies });
    void qc.invalidateQueries({ queryKey: keys.attention });
  };
  const saved = (message: string) => {
    setAction(null);
    setDone(message);
    reload();
  };
  const selected = list.data?.items.find((p) => p.id === action?.id);

  return (
    <>
      <h1>Confirmation policies</h1>
      {!canManage ? (
        <Section title="Policies">
          <NotPermitted>The selected role cannot manage confirmation policies.</NotPermitted>
        </Section>
      ) : (
        <>
          <Section title="Policies">
            <p className="hint">
              A case takes the most specific policy that applies on the employee’s joining date and keeps it. A policy in use never changes: a change of terms is a new revision from a later date, and a policy
              is retired by ending it. Equally specific policies that could apply to the same employee on overlapping dates are refused. Due dates add the duration to the joining date; a month-end date is
              clamped to the end of the destination month.
            </p>
            {list.isPending && <p className="hint loading">Loading policies…</p>}
            {isForbidden(list.error) ? <NotPermitted>The selected role cannot manage confirmation policies.</NotPermitted> : <ErrorNote error={list.error} />}
            {list.data && list.data.items.length === 0 && <Empty>No confirmation policies yet.</Empty>}
            {list.data && list.data.items.length > 0 && (
              <PolicyTable
                items={list.data.items}
                onAction={(next) => {
                  setDone(null);
                  setAction(next);
                }}
              />
            )}
            {done && (
              <p className="ok" role="status">
                {done}
              </p>
            )}
          </Section>
          {action?.kind === 'revise' && selected && <RevisionForm key={selected.id} policy={selected} onSaved={saved} onConflict={reload} onClose={() => setAction(null)} />}
          {action?.kind === 'retire' && selected && <RetireForm key={selected.id} policy={selected} onSaved={saved} onConflict={reload} onClose={() => setAction(null)} />}
          {list.data && <CreatePolicyForm applicability={list.data.applicability} onSaved={saved} />}
        </>
      )}
    </>
  );
}

function PolicyTable({ items, onAction }: { items: Policy[]; onAction: (action: PolicyAction) => void }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Confirmation policies">
        <thead>
          <tr>
            <th scope="col">Policy</th>
            <th scope="col">Applies to</th>
            <th scope="col">Duration</th>
            <th scope="col">Counted from</th>
            <th scope="col">From</th>
            <th scope="col">Until</th>
            <th scope="col">Status</th>
            <th scope="col">Cases</th>
            <th scope="col">
              <span style={SR_ONLY}>Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>
                {p.code} <span className="hint">revision {p.revision}</span>
              </td>
              <td>{appliesTo(p)}</td>
              <td>
                {p.duration} {UNIT_LABEL[p.durationUnit]}
              </td>
              <td>
                {p.startBasis === 'JOINING_DATE' ? 'Joining date' : readable(p.startBasis)}
                {p.startDayInclusive ? ', counted as day one' : ''}
              </td>
              <td>{formatDate(p.effectiveFrom)}</td>
              <td>{p.effectiveTo ? formatDate(p.effectiveTo) : 'No end date'}</td>
              <td>
                <Badge tone={p.status === 'IN_FORCE' ? 'good' : 'neutral'}>{POLICY_STATUS_LABEL[p.status]}</Badge>
              </td>
              <td>{p.latestCaseStart ? `In use (latest start ${formatDate(p.latestCaseStart)})` : 'None'}</td>
              <td>
                {/* The row's actions side by side, never stacked in the narrow last column. */}
                <div className="row" style={{ flexWrap: 'nowrap' }}>
                  {p.latest && (
                    <button type="button" className="link" aria-label={`New revision of ${policyLabel(p)}`} onClick={() => onAction({ kind: 'revise', id: p.id })}>
                      New revision
                    </button>
                  )}
                  {p.status !== 'ENDED' && (
                    <button type="button" className="link danger" aria-label={`End ${policyLabel(p)}`} onClick={() => onAction({ kind: 'retire', id: p.id })}>
                      End policy
                    </button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TermsDraft {
  duration: string;
  unit: '' | DurationUnit;
  from: string;
  to: string;
}
const NO_TERMS: TermsDraft = { duration: '', unit: '', from: '', to: '' };

/** Required fields only; every rule on the values (positive duration, end after start, overlap, cases in use) is the server's. */
const missingTerm = (t: TermsDraft) => (!t.duration.trim() ? 'Enter the duration.' : !t.unit ? 'Choose whether the duration is in calendar months or days.' : !t.from ? 'Enter the date the policy takes effect.' : null);
const termsBody = (t: TermsDraft) => ({
  duration: Number(t.duration),
  durationUnit: t.unit,
  startBasis: 'JOINING_DATE',
  effectiveFrom: t.from,
  ...(t.to ? { effectiveTo: t.to } : {}),
});

/** A duration and its unit read as one value ("6 calendar months"), so they sit side by side on a row of their own. */
const DURATION_ROW: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: '0.9rem 1rem' };

function TermFields({ value, onChange }: { value: TermsDraft; onChange: (next: TermsDraft) => void }) {
  return (
    <>
      <div className="wide" style={DURATION_ROW}>
        <label style={{ flex: '0 1 10rem' }}>
          Duration
          <input type="number" step="1" required value={value.duration} onChange={(e) => onChange({ ...value, duration: e.target.value })} />
        </label>
        <label style={{ flex: '0 1 14rem' }}>
          Unit
          <select required value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as TermsDraft['unit'] })}>
            <option value="">Choose…</option>
            <option value="CALENDAR_MONTHS">Calendar months</option>
            <option value="CALENDAR_DAYS">Calendar days</option>
          </select>
        </label>
      </div>
      <label>
        Takes effect on
        <input type="date" required value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value })} />
      </label>
      <label>
        Ends on (optional)
        <input type="date" value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
      </label>
      <p className="hint wide">Counted from the employee’s joining date. An employee joining on the end date or later no longer gets this policy.</p>
    </>
  );
}

function FormProblem({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="error wide">
      {text}
    </p>
  );
}

function CreatePolicyForm({ applicability, onSaved }: { applicability: PolicyList['applicability']; onSaved: (message: string) => void }) {
  const [code, setCode] = useState('');
  const [terms, setTerms] = useState<TermsDraft>(NO_TERMS);
  const [employmentType, setEmploymentType] = useState('');
  const [gradeId, setGradeId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [inclusive, setInclusive] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (body: object) => api<Policy>('/v1/confirmation-policies', { body }),
    onSuccess: (policy) => {
      setCode('');
      setTerms(NO_TERMS);
      setEmploymentType('');
      setGradeId('');
      setLocationId('');
      setInclusive(false);
      onSaved(`Policy ${policy.code} created.`);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = !code.trim() ? 'Enter the policy code.' : missingTerm(terms);
    setProblem(missing);
    if (missing !== null) return;
    create.mutate({
      code: code.trim(),
      ...termsBody(terms),
      ...(employmentType ? { employmentType } : {}),
      ...(gradeId ? { gradeId } : {}),
      ...(locationId ? { locationId } : {}),
      ...(inclusive ? { startDayInclusive: true } : {}),
    });
  };
  return (
    <Section title="New policy">
      <form className="grid-form" aria-label="New policy" onSubmit={submit}>
        <label>
          Code
          <input required maxLength={40} value={code} placeholder="e.g. INTERN_SHORT" onChange={(e) => setCode(e.target.value)} />
        </label>
        <label>
          Employment type
          <select value={employmentType} onChange={(e) => setEmploymentType(e.target.value)}>
            <option value="">Any</option>
            {applicability.employmentTypes.map((t) => (
              <option key={t.code} value={t.code}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Grade
          <select value={gradeId} onChange={(e) => setGradeId(e.target.value)}>
            <option value="">Any</option>
            {applicability.grades.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Location
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)}>
            <option value="">Any</option>
            {applicability.locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <TermFields value={terms} onChange={setTerms} />
        <label className="wide">
          <input type="checkbox" checked={inclusive} onChange={(e) => setInclusive(e.target.checked)} /> Count the joining day as day one (the review falls due one day earlier; kept by every later
          revision)
        </label>
        <FormProblem text={problem} />
        <div className="wide row">
          <button type="submit" disabled={create.isPending}>
            Create policy
          </button>
        </div>
      </form>
      <PlainRefusal error={create.error} />
    </Section>
  );
}

function RevisionForm({ policy, onSaved, onConflict, onClose }: { policy: Policy; onSaved: (message: string) => void; onConflict: () => void; onClose: () => void }) {
  const [terms, setTerms] = useState<TermsDraft>({ ...NO_TERMS, duration: String(policy.duration), unit: policy.durationUnit });
  const [problem, setProblem] = useState<string | null>(null);
  const revise = useMutation({
    mutationFn: (body: object) => api<Policy>(`/v1/confirmation-policies/${encodeURIComponent(policy.id)}/revisions`, { body }),
    onSuccess: (next) => onSaved(`${policyLabel(next)} created; it applies from ${formatDate(next.effectiveFrom)}.`),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onConflict();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = missingTerm(terms);
    setProblem(missing);
    if (missing === null) revise.mutate({ ...termsBody(terms), expectedVersion: policy.version });
  };
  return (
    <Section
      title={`New revision of ${policy.code}`}
      actions={
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="hint">
        It applies to the same employees as revision {policy.revision} ({appliesTo(policy)}), which closes on the new date.
        {policy.latestCaseStart ? ` The date must come after ${formatDate(policy.latestCaseStart)}, the latest start of a case under it.` : ''} Cases already opened keep their policy and due date.
      </p>
      <form className="grid-form" aria-label={`New revision of ${policy.code}`} onSubmit={submit}>
        <TermFields value={terms} onChange={setTerms} />
        <FormProblem text={problem} />
        <div className="wide row">
          <button type="submit" disabled={revise.isPending}>
            Create revision
          </button>
        </div>
      </form>
      <PlainRefusal error={revise.error} />
    </Section>
  );
}

function RetireForm({ policy, onSaved, onConflict, onClose }: { policy: Policy; onSaved: (message: string) => void; onConflict: () => void; onClose: () => void }) {
  const [effectiveTo, setEffectiveTo] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const retire = useMutation({
    mutationFn: (body: { effectiveTo: string; expectedVersion: number }) => api<Policy>(`/v1/confirmation-policies/${encodeURIComponent(policy.id)}/retire`, { body }),
    onSuccess: (ended) => onSaved(`${policyLabel(ended)} ends on ${formatDate(ended.effectiveTo)}.`),
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) onConflict();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const missing = effectiveTo ? null : 'Enter the end date.';
    setProblem(missing);
    if (missing === null) retire.mutate({ effectiveTo, expectedVersion: policy.version });
  };
  return (
    <Section
      title={`End ${policyLabel(policy)}`}
      actions={
        <button type="button" className="secondary" onClick={onClose}>
          Close
        </button>
      }
    >
      <p className="hint">
        An employee joining on this date or later no longer gets this policy; another policy applies, or HR is told that none does. Cases already opened keep it.
        {policy.latestCaseStart ? ` The date must come after ${formatDate(policy.latestCaseStart)}, the latest start of a case under it.` : ''}
      </p>
      <form className="grid-form" aria-label={`End ${policyLabel(policy)}`} onSubmit={submit}>
        <label>
          End date
          <input type="date" required value={effectiveTo} onChange={(e) => setEffectiveTo(e.target.value)} />
        </label>
        <FormProblem text={problem} />
        <div className="wide row">
          <button type="submit" disabled={retire.isPending}>
            End policy
          </button>
        </div>
      </form>
      <PlainRefusal error={retire.error} />
    </Section>
  );
}
