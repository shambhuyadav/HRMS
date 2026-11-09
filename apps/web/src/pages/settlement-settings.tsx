// Settlement policy and statutory rule packs (FR-052; decided under owner delegation, 6 Nov 2026: docs/03 I-88).
//   /lifecycle/settlement-settings
//
// The full-and-final calculation (lifecycle-documents.tsx) runs on the server under the settlement policy revision and the statutory
// rule packs in force on the employee's last working date. Both are dated configuration, never constants:
// - The settlement policy (payroll configuration duties): the pay components that stand for Basic and DA, the components an
//   encashment, a notice recovery and a gratuity are paid or recovered on, the daily-rate basis and divisor of encashment and of notice
//   recovery, and the encashable leave types with their caps. A change is a new DRAFT revision, written by one person and activated by
//   another (SELF_APPROVAL otherwise); the server's defaults prefill the form.
// - The statutory rule packs (statutory pack duties): each revision is an inactive draft until one authorised person records where
//   its values come from and how they were validated, and another activates it; until then an employee it applies to is blocked
//   with RULE_PACK_NOT_CONFIGURED.
// The server authorises every call and decides every rule; this screen hides what the selected assignment cannot use, shows what the
// server returned and says its refusals in plain words (the conventions of lifecycle-documents.tsx, whose helpers it shares).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError, formatDate, formatUnits, localDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, Section } from '../ui';
import { isConflict, Item, labelOf, LoadProblem, NotPermitted, PACK_STATE_LABEL, RATE_BASIS_LABEL, Refusal, retryTransient, UserRef, when, type Words } from './lifecycle-documents';

// ---------------------------------------------------------------------------------------------------------
// Permission keys (modules/lifecycle/settlement-calculation-routes.ts; payroll and lifecycle registrations; migration 0235) and paths
// ---------------------------------------------------------------------------------------------------------
const POLICY_READ = 'payroll_config.read.operational';
const POLICY_MANAGE = 'payroll_config.manage.operational';
const POLICY_ACTIVATE = 'payroll_config.activate.operational';
const PACK_READ = 'statutory_pack.read.operational';
const PACK_VALIDATE = 'statutory_pack.validate.operational';
const PACK_ACTIVATE = 'statutory_pack.activate.operational';
const SETTLEMENT_READ = 'settlement.read.operational';

const PATH = '/lifecycle/settlement-settings';
const SETTLEMENTS_PATH = '/lifecycle/settlements';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A cap of units (settlement-policy.ts): up to 4 digits and 4 decimal places. */
const CAP = /^\d{1,4}(\.\d{1,4})?$/;
const MAX_CODE = 40;
const MAX_REFERENCE = 500;
const MAX_ENCASHABLE = 50;

// ---------------------------------------------------------------------------------------------------------
// API shapes (modules/lifecycle/settlement-policy.ts, modules/statutory/rule-packs.ts)
// ---------------------------------------------------------------------------------------------------------
interface PolicyDefaults {
  encashmentRateBasis: string;
  encashmentDivisor: number;
  noticeRateBasis: string;
  noticeDivisor: number;
  encashableMaxUnits: string;
}

interface PolicyRevision {
  id: string;
  revision: number;
  effectiveFrom: string;
  basicComponentCode: string;
  daComponentCode: string | null;
  encashmentComponentCode: string | null;
  encashmentRateBasis: string;
  encashmentDivisor: number;
  noticeComponentCode: string | null;
  noticeRateBasis: string;
  noticeDivisor: number;
  gratuityComponentCode: string | null;
  encashable: { leaveType: string; maxUnits: string }[];
  /** DRAFT, ACTIVE, SUPERSEDED or CANCELLED. */
  state: string;
  createdBy: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
  version: number;
}

interface PolicyList {
  defaults: PolicyDefaults;
  rateBases: string[];
  items: PolicyRevision[];
}

interface PackRevision {
  id: string;
  code: string;
  revision: number;
  effectiveFrom: string;
  currencyCode: string;
  parameters: Record<string, unknown>;
  statuteReference: string;
  sourceReference: string | null;
  validationReference: string | null;
  /** DRAFT, VALIDATED, ACTIVE or RETIRED. */
  state: string;
  createdBy: string | null;
  validatedBy: string | null;
  validatedAt: string | null;
  activatedBy: string | null;
  activatedAt: string | null;
  version: number;
}

interface PackList {
  definitions: { code: string; title: string }[];
  items: PackRevision[];
}

// ---------------------------------------------------------------------------------------------------------
// Labels and the API's refusals in plain words
// ---------------------------------------------------------------------------------------------------------
const POLICY_STATE_LABEL: Record<string, string> = {
  DRAFT: 'Draft: not in force until someone else activates it',
  ACTIVE: 'Active',
  SUPERSEDED: 'Superseded',
  CANCELLED: 'Cancelled',
};
const POLICY_TONE: Record<string, 'good' | 'warn' | 'bad'> = { DRAFT: 'warn', ACTIVE: 'good' };
const PACK_TONE: Record<string, 'good' | 'warn' | 'bad'> = { DRAFT: 'warn', VALIDATED: 'warn', ACTIVE: 'good' };
const RATE_BASES = Object.keys(RATE_BASIS_LABEL);
/** The fields a refusal names (`details.field`), as the form labels them. */
const FIELD_LABEL: Record<string, string> = {
  effectiveFrom: 'the date it takes effect',
  basicComponentCode: 'the Basic component',
  daComponentCode: 'the DA component',
  encashmentComponentCode: 'the encashment component',
  noticeComponentCode: 'the notice recovery component',
  gratuityComponentCode: 'the gratuity component',
  encashmentDivisor: 'the encashment divisor',
  noticeDivisor: 'the notice recovery divisor',
  encashable: 'the encashable leave types',
};

const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
const H4: CSSProperties = { fontSize: '0.95rem', margin: '0.25rem 0' };
const SCROLL: CSSProperties = { overflowX: 'auto' };
const GROUP: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, padding: '0.5rem 0.75rem', margin: 0, minWidth: 0 };
const SR_ONLY: CSSProperties = { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clip: 'rect(0, 0, 0, 0)', whiteSpace: 'nowrap', border: 0 };

const detail = (e: ApiError, key: string): unknown => (e.details as Record<string, unknown> | undefined)?.[key];
const capitalised = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
const fieldOf = (e: ApiError) => {
  const field = detail(e, 'field');
  return typeof field === 'string' ? labelOf(FIELD_LABEL, field) : 'a field';
};
/** A refusal about one encashable leave type names its row (`details.index`, from 0). */
function atRow(e: ApiError, text: string): string {
  const index = detail(e, 'index');
  return typeof index === 'number' ? `Encashable leave type ${index + 1}: ${text}` : capitalised(text);
}
const codeIn = (e: ApiError, key: string) => {
  const value = detail(e, key);
  return typeof value === 'string' ? value : '';
};

const POLICY_WORDS: Words = {
  INVALID_DATE: 'Enter the date the revision takes effect as a valid date.',
  UNKNOWN_COMPONENT: (e) => `No active pay component has the code ${codeIn(e, 'componentCode') || 'given'} for ${fieldOf(e)}.`,
  COMPONENT_KIND_INVALID: (e) =>
    `${capitalised(fieldOf(e))} must be ${detail(e, 'field') === 'noticeComponentCode' ? 'a deduction' : 'an earning'}${codeIn(e, 'componentCode') ? `, and ${codeIn(e, 'componentCode')} is not` : ''}.`,
  BASIC_COMPONENT_REQUIRED: 'Name the pay component that stands for Basic.',
  DA_IS_BASIC: 'DA and Basic are different pay components: name another one for DA, or none.',
  UNKNOWN_LEAVE_TYPE: (e) => atRow(e, `no active leave type has the code ${codeIn(e, 'leaveType') || 'given'}.`),
  LEAVE_TYPE_NOT_PAID: (e) => atRow(e, `only a paid leave type is encashable${codeIn(e, 'leaveType') ? `, and ${codeIn(e, 'leaveType')} is unpaid` : ''}.`),
  INVALID_CAP: (e) => atRow(e, 'the cap is a number of units above zero, with up to 4 digits and 4 decimal places.'),
  DUPLICATE_LEAVE_TYPE: (e) => atRow(e, 'this leave type is already listed; each leave type appears once.'),
  ENCASHMENT_COMPONENT_REQUIRED: 'Name the earning component an encashment is paid on, or list no encashable leave type.',
  INVALID_DIVISOR: (e) => `${capitalised(fieldOf(e))} is a whole number of days from 1 to 31.`,
  INVALID_REQUEST:
    'Check the entries: codes have at most 40 characters, a divisor is a whole number from 1 to 31, a cap has up to 4 digits and 4 decimal places, and at most 50 leave types are encashable.',
  FORBIDDEN: 'The selected role cannot write settlement policy revisions: that needs the payroll configuration duty.',
};

const POLICY_ACTIVATE_WORDS: Words = {
  SELF_APPROVAL: 'A policy is activated by someone other than its author.',
  INVALID_STATE: 'Only a draft revision is activated, and this one is no longer a draft. The revisions have been reloaded.',
  STALE_VERSION: 'The revision changed after it was loaded. The revisions have been reloaded: check it and try again.',
  NOT_FOUND: 'This policy revision is not available.',
  FORBIDDEN: 'The selected role cannot activate settlement policy revisions: that needs the payroll configuration activation duty.',
};

const PACK_VALIDATE_WORDS: Words = {
  SOURCE_REQUIRED: `Record where the values were obtained (at most ${MAX_REFERENCE} characters).`,
  VALIDATION_REQUIRED: `Record how the values were validated for the jurisdiction and period (at most ${MAX_REFERENCE} characters).`,
  INVALID_STATE: 'Only an inactive draft is validated, and this revision is no longer one. The rule packs have been reloaded.',
  STALE_VERSION: 'The revision changed after it was loaded. The rule packs have been reloaded: check it and try again.',
  NOT_FOUND: 'This rule pack revision is not available.',
  FORBIDDEN: 'The selected role cannot validate statutory rule packs: that needs its own grant.',
};

const PACK_ACTIVATE_WORDS: Words = {
  SELF_APPROVAL: 'Activated by someone other than the person who wrote or validated it.',
  INVALID_STATE: 'Only a validated revision is activated, and this one is no longer waiting for activation. The rule packs have been reloaded.',
  STALE_VERSION: 'The revision changed after it was loaded. The rule packs have been reloaded: check it and try again.',
  NOT_FOUND: 'This rule pack revision is not available.',
  FORBIDDEN: 'The selected role cannot activate statutory rule packs: that needs its own grant.',
};

/** Query keys carry the selected company and assignment (as lifecycle-documents.tsx useKeys): one cache across role switches. */
function useSettingsKeys() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(
    () => ({
      policies: ['settlement-settings', context, 'policies'] as const,
      packs: ['settlement-settings', context, 'statutory-packs'] as const,
    }),
    [context],
  );
}

// =========================================================================================================
// The screen
// =========================================================================================================
function SettlementSettingsScreen() {
  const { can } = useSession();
  return (
    <>
      <h1>Settlement policy and statutory packs</h1>
      <p className="hint">
        A full-and-final settlement is calculated on the server under the settlement policy revision and the statutory rule packs in force on the employee’s last
        working date. Both are dated: a change is a new revision, and a revision takes effect only once a second person has activated it.
      </p>
      <p role="note">
        <Badge tone="warn">two people</Badge> A statutory value is used only once one authorised person has validated it and another has activated it; until then an
        employee it applies to is blocked with RULE_PACK_NOT_CONFIGURED.
      </p>
      {can(SETTLEMENT_READ) && (
        <p className="row">
          <Link to={SETTLEMENTS_PATH}>Full and final settlements</Link>
        </p>
      )}
      {can(POLICY_READ) ? (
        <PolicySection />
      ) : (
        <Section title="Settlement policy">
          <NotPermitted>The selected role cannot view the settlement policy: that needs the payroll configuration read duty.</NotPermitted>
        </Section>
      )}
      {can(PACK_READ) ? (
        <PackSection />
      ) : (
        <Section title="Statutory rule packs">
          <NotPermitted>The selected role cannot view the statutory rule packs: that needs the statutory pack read duty.</NotPermitted>
        </Section>
      )}
    </>
  );
}

// =========================================================================================================
// Settlement policy
// =========================================================================================================
const rateLabel = (basis: string) => labelOf(RATE_BASIS_LABEL, basis);
const encashableText = (items: PolicyRevision['encashable']) => (items.length === 0 ? 'None' : items.map((e) => `${e.leaveType} up to ${formatUnits(e.maxUnits)}`).join(', '));

function PolicySection() {
  const { can } = useSession();
  const keys = useSettingsKeys();
  const list = useQuery({ queryKey: keys.policies, queryFn: () => api<PolicyList>('/v1/settlements/policies'), retry: retryTransient });
  const [notice, setNotice] = useState<string | null>(null);
  const data = list.data;
  return (
    <>
      <Section title="Settlement policy">
        <p className="hint">
          The pay components that stand for Basic and DA, the components an encashment, a notice recovery and a gratuity are paid or recovered on, the daily rate of
          encashment and of notice recovery (a monthly rate basis divided by a number of days), and the leave types that are encashable, each up to its cap. The revision
          in force on an employee’s last working date is the one their settlement is calculated under.
        </p>
        {data && (
          <p className="hint">
            {`Defaults for a field left out: encashment on ${rateLabel(data.defaults.encashmentRateBasis)} / ${data.defaults.encashmentDivisor}, notice recovery on ${rateLabel(
              data.defaults.noticeRateBasis,
            )} / ${data.defaults.noticeDivisor}, an encashable leave type capped at ${formatUnits(data.defaults.encashableMaxUnits)} units. No leave type is encashable unless listed.`}
          </p>
        )}
        {notice && (
          <p className="ok" role="status">
            {notice}
          </p>
        )}
        {list.isPending && <p className="hint">Loading the settlement policy…</p>}
        <LoadProblem error={list.error} forbidden="The selected role cannot view the settlement policy." />
        {data && data.items.length === 0 && <Empty>No settlement policy revision yet: until one is active, the calculation shows encashment, notice recovery and gratuity as not configured.</Empty>}
        {data && data.items.length > 0 && <PolicyTable items={data.items} onNotice={setNotice} />}
      </Section>
      {data && can(POLICY_MANAGE) && <NewPolicyRevision data={data} onNotice={setNotice} />}
    </>
  );
}

function PolicyTable({ items, onNotice }: { items: readonly PolicyRevision[]; onNotice: (text: string) => void }) {
  const { can } = useSession();
  const activate = can(POLICY_ACTIVATE) && items.some((p) => p.state === 'DRAFT');
  return (
    <div style={SCROLL}>
      <table aria-label="Settlement policy revisions">
        <thead>
          <tr>
            <th scope="col">Revision</th>
            <th scope="col">From</th>
            <th scope="col">State</th>
            <th scope="col">Basic</th>
            <th scope="col">DA</th>
            <th scope="col">Encashment</th>
            <th scope="col">Encashable leave</th>
            <th scope="col">Notice recovery</th>
            <th scope="col">Gratuity</th>
            <th scope="col">Written by</th>
            <th scope="col">Activated</th>
            {activate && (
              <th scope="col">
                <span style={SR_ONLY}>Activate</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id}>
              <td>{p.revision}</td>
              <td>{formatDate(p.effectiveFrom)}</td>
              <td>
                <Badge tone={POLICY_TONE[p.state] ?? 'neutral'}>{labelOf(POLICY_STATE_LABEL, p.state)}</Badge>
              </td>
              <td>{p.basicComponentCode}</td>
              <td>{p.daComponentCode ?? '—'}</td>
              <td>{`${p.encashmentComponentCode ?? 'No component'}: ${rateLabel(p.encashmentRateBasis)} / ${p.encashmentDivisor}`}</td>
              <td>{encashableText(p.encashable)}</td>
              <td>{`${p.noticeComponentCode ?? 'No component'}: ${rateLabel(p.noticeRateBasis)} / ${p.noticeDivisor}`}</td>
              <td>{p.gratuityComponentCode ?? '—'}</td>
              <td>{p.createdBy ? <UserRef userId={p.createdBy} /> : '—'}</td>
              <td>
                {p.activatedAt ? (
                  <>
                    {when(p.activatedAt)}
                    {p.activatedBy && (
                      <>
                        {' by '}
                        <UserRef userId={p.activatedBy} />
                      </>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </td>
              {activate && <td>{p.state === 'DRAFT' && <ActivatePolicy p={p} onNotice={onNotice} />}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A DRAFT revision is activated against its version by someone other than its author. */
function ActivatePolicy({ p, onNotice }: { p: PolicyRevision; onNotice: (text: string) => void }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const keys = useSettingsKeys();
  const author = !!me?.userId && me.userId === p.createdBy;
  const hintId = `${useId()}-author`;
  const activate = useMutation({
    mutationFn: () => api<PolicyRevision>(`/v1/settlements/policies/${encodeURIComponent(p.id)}/activate`, { body: { expectedVersion: p.version } }),
    onSuccess: (r) => {
      onNotice(`Revision ${r.revision} of the settlement policy is active from ${formatDate(r.effectiveFrom)}.`);
      void qc.invalidateQueries({ queryKey: keys.policies });
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: keys.policies });
    },
  });
  return (
    <div className="stack">
      <button type="button" disabled={activate.isPending || author} aria-describedby={author ? hintId : undefined} onClick={() => activate.mutate()}>
        {`Activate revision ${p.revision}`}
      </button>
      {author && (
        <span className="hint" id={hintId}>
          You wrote this revision, so someone else activates it.
        </span>
      )}
      <Refusal error={activate.error} words={POLICY_ACTIVATE_WORDS} noAnswer="No answer came back, so the revision may or may not have been activated. Reload the page to check." />
    </div>
  );
}

interface EncashableRow {
  key: number;
  leaveType: string;
  maxUnits: string;
}

interface PolicyForm {
  effectiveFrom: string;
  basic: string;
  da: string;
  encashmentComponent: string;
  encashmentRateBasis: string;
  encashmentDivisor: string;
  encashable: EncashableRow[];
  noticeComponent: string;
  noticeRateBasis: string;
  noticeDivisor: string;
  gratuityComponent: string;
}

const blankForm = (d: PolicyDefaults): PolicyForm => ({
  effectiveFrom: localDate(),
  basic: '',
  da: '',
  encashmentComponent: '',
  encashmentRateBasis: d.encashmentRateBasis,
  encashmentDivisor: String(d.encashmentDivisor),
  encashable: [],
  noticeComponent: '',
  noticeRateBasis: d.noticeRateBasis,
  noticeDivisor: String(d.noticeDivisor),
  gratuityComponent: '',
});

const wholeDivisor = (text: string) => /^\d{1,2}$/.test(text.trim()) && Number(text) >= 1 && Number(text) <= 31;

/** POST /v1/settlements/policies: a new DRAFT revision, prefilled with the server's defaults; activated by someone else. */
function NewPolicyRevision({ data, onNotice }: { data: PolicyList; onNotice: (text: string) => void }) {
  const qc = useQueryClient();
  const keys = useSettingsKeys();
  const next = useRef(0);
  const [form, setForm] = useState<PolicyForm | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const values = form ?? blankForm(data.defaults);
  const bases = data.rateBases.length > 0 ? data.rateBases : RATE_BASES;
  const change = (patch: Partial<PolicyForm>) => setForm({ ...values, ...patch });
  const changeRow = (key: number, patch: Partial<EncashableRow>) => change({ encashable: values.encashable.map((r) => (r.key === key ? { ...r, ...patch } : r)) });
  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<PolicyRevision>('/v1/settlements/policies', { body }),
    onSuccess: (r) => {
      setForm(null);
      onNotice(`Revision ${r.revision} written as a draft from ${formatDate(r.effectiveFrom)}. It is not in force until someone other than you activates it.`);
      void qc.invalidateQueries({ queryKey: keys.policies });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (save.isPending) return;
    const code = (text: string) => text.trim().toUpperCase();
    // Format checks only: components, kinds and leave types are the server's to check.
    let missing: string | null = null;
    if (!DATE.test(values.effectiveFrom)) missing = 'Enter the date the revision takes effect.';
    else if (!code(values.basic)) missing = 'Name the pay component that stands for Basic.';
    else if (!wholeDivisor(values.encashmentDivisor)) missing = 'The encashment divisor is a whole number of days from 1 to 31.';
    else if (!wholeDivisor(values.noticeDivisor)) missing = 'The notice recovery divisor is a whole number of days from 1 to 31.';
    else {
      values.encashable.forEach((r, i) => {
        if (missing !== null) return;
        if (!code(r.leaveType)) missing = `Encashable leave type ${i + 1}: enter the leave type code.`;
        else if (r.maxUnits.trim() && (!CAP.test(r.maxUnits.trim()) || Number(r.maxUnits) <= 0)) {
          missing = `Encashable leave type ${i + 1}: the cap is a number of units above zero, with up to 4 digits and 4 decimal places.`;
        }
      });
    }
    setProblem(missing);
    if (missing !== null) {
      save.reset();
      return;
    }
    const optional = (key: string, text: string) => (code(text) ? { [key]: code(text) } : {});
    save.mutate({
      effectiveFrom: values.effectiveFrom,
      basicComponentCode: code(values.basic),
      ...optional('daComponentCode', values.da),
      ...optional('encashmentComponentCode', values.encashmentComponent),
      encashmentRateBasis: values.encashmentRateBasis,
      encashmentDivisor: Number(values.encashmentDivisor),
      ...(values.encashable.length > 0
        ? { encashable: values.encashable.map((r) => ({ leaveType: code(r.leaveType), ...(r.maxUnits.trim() ? { maxUnits: r.maxUnits.trim() } : {}) })) }
        : {}),
      ...optional('noticeComponentCode', values.noticeComponent),
      noticeRateBasis: values.noticeRateBasis,
      noticeDivisor: Number(values.noticeDivisor),
      ...optional('gratuityComponentCode', values.gratuityComponent),
    });
  };
  const busy = save.isPending;
  const basisSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <label>
      {label}
      <select value={value} disabled={busy} onChange={(e) => onChange(e.target.value)}>
        {bases.map((b) => (
          <option key={b} value={b}>
            {rateLabel(b)}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <Section title="New revision">
      <form className="stack" aria-label="New settlement policy revision" onSubmit={submit}>
        <p className="hint">
          A new revision is written as a draft and takes effect from its date once someone other than you activates it; an active revision of the same date is then
          superseded. Pay component and leave type codes are those of this company; the server checks them.
        </p>
        <div className="row">
          <label>
            Takes effect from
            <input type="date" value={values.effectiveFrom} disabled={busy} onChange={(e) => change({ effectiveFrom: e.target.value })} />
          </label>
          <label>
            Basic component (required)
            <input value={values.basic} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ basic: e.target.value.toUpperCase() })} />
          </label>
          <label>
            DA component (optional)
            <input value={values.da} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ da: e.target.value.toUpperCase() })} />
          </label>
        </div>
        <fieldset style={GROUP}>
          <legend>Leave encashment</legend>
          <div className="row">
            <label>
              Encashment component (an earning)
              <input value={values.encashmentComponent} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ encashmentComponent: e.target.value.toUpperCase() })} />
            </label>
            {basisSelect('Encashment rate basis', values.encashmentRateBasis, (v) => change({ encashmentRateBasis: v }))}
            <label>
              Encashment divisor (days)
              <input value={values.encashmentDivisor} inputMode="numeric" maxLength={2} disabled={busy} onChange={(e) => change({ encashmentDivisor: e.target.value })} />
            </label>
          </div>
          {values.encashable.length === 0 && <p className="hint">No leave type is encashable. Add one to make it encashable.</p>}
          {values.encashable.map((r, i) => (
            <div className="row" key={r.key}>
              <label>
                {`Encashable leave type ${i + 1}`}
                <input value={r.leaveType} maxLength={MAX_CODE} disabled={busy} onChange={(e) => changeRow(r.key, { leaveType: e.target.value.toUpperCase() })} />
              </label>
              <label>
                {`Cap of leave type ${i + 1} (units)`}
                <input
                  value={r.maxUnits}
                  inputMode="decimal"
                  maxLength={9}
                  placeholder={formatUnits(data.defaults.encashableMaxUnits)}
                  disabled={busy}
                  onChange={(e) => changeRow(r.key, { maxUnits: e.target.value })}
                />
              </label>
              <button
                type="button"
                className="secondary"
                disabled={busy}
                aria-label={`Remove encashable leave type ${i + 1}`}
                onClick={() => change({ encashable: values.encashable.filter((x) => x.key !== r.key) })}
              >
                Remove
              </button>
            </div>
          ))}
          <div className="row">
            <button
              type="button"
              className="secondary"
              disabled={busy || values.encashable.length >= MAX_ENCASHABLE}
              onClick={() => change({ encashable: [...values.encashable, { key: next.current++, leaveType: '', maxUnits: '' }] })}
            >
              Add an encashable leave type
            </button>
          </div>
          <p className="hint">{`A cap left blank is ${formatUnits(data.defaults.encashableMaxUnits)} units.`}</p>
        </fieldset>
        <fieldset style={GROUP}>
          <legend>Notice recovery</legend>
          <div className="row">
            <label>
              Notice recovery component (a deduction)
              <input value={values.noticeComponent} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ noticeComponent: e.target.value.toUpperCase() })} />
            </label>
            {basisSelect('Notice recovery rate basis', values.noticeRateBasis, (v) => change({ noticeRateBasis: v }))}
            <label>
              Notice recovery divisor (days)
              <input value={values.noticeDivisor} inputMode="numeric" maxLength={2} disabled={busy} onChange={(e) => change({ noticeDivisor: e.target.value })} />
            </label>
          </div>
        </fieldset>
        <div className="row">
          <label>
            Gratuity component (an earning)
            <input value={values.gratuityComponent} maxLength={MAX_CODE} disabled={busy} onChange={(e) => change({ gratuityComponent: e.target.value.toUpperCase() })} />
          </label>
        </div>
        {problem && (
          <p role="alert" className="error">
            {problem}
          </p>
        )}
        <div className="row">
          <button type="submit" disabled={busy}>
            Write the draft revision
          </button>
        </div>
        <Refusal
          error={save.error}
          words={POLICY_WORDS}
          noAnswer="No answer came back, so the revision may or may not have been written. Reload the page and check the revisions before trying again."
        />
      </form>
    </Section>
  );
}

// =========================================================================================================
// Statutory rule packs
// =========================================================================================================
const numberIn = (v: unknown): string | null => (typeof v === 'number' && Number.isFinite(v) ? String(v) : null);

/** A revision's parameters in plain words where the pack is known (GRATUITY), its JSON otherwise. */
function ParametersText({ pack: p }: { pack: PackRevision }) {
  const q = p.parameters ?? {};
  const wageDays = numberIn(q.wageDays);
  const divisor = numberIn(q.wageDivisor);
  const years = numberIn(q.minimumServiceYears);
  const partYear = numberIn(q.partYearMonthsOver);
  const ceiling = typeof q.ceilingAmount === 'string' ? q.ceilingAmount : null;
  const exempt = Array.isArray(q.exemptSeparationTypes) ? q.exemptSeparationTypes.filter((s): s is string => typeof s === 'string') : null;
  if (p.code === 'GRATUITY' && wageDays && divisor && years && partYear && ceiling && exempt) {
    return (
      <>
        {`${wageDays} days’ wages per counted year, a month’s wages / ${divisor}, ${years} years’ continuous service${exempt.length > 0 ? ` (none on ${exempt.join(', ')})` : ''}, a final part-year of more than ${partYear} months counts, ceiling ${ceiling} ${p.currencyCode}`}
      </>
    );
  }
  return <code>{JSON.stringify(q)}</code>;
}

function PackSection() {
  const keys = useSettingsKeys();
  const list = useQuery({ queryKey: keys.packs, queryFn: () => api<PackList>('/v1/statutory-rule-packs'), retry: retryTransient });
  const [notice, setNotice] = useState<string | null>(null);
  const data = list.data;
  // Every pack this build knows, then any other code a revision carries.
  const codes = data ? [...new Set([...data.definitions.map((d) => d.code), ...data.items.map((p) => p.code)])] : [];
  const titleOf = (code: string) => data?.definitions.find((d) => d.code === code)?.title ?? code;
  return (
    <Section title="Statutory rule packs">
      <p className="hint">
        Each revision carries its parameters, its currency and the statute they come from. It starts as an inactive draft; one authorised person records where the values
        were obtained and how they were validated, and another activates it. The revision active on the last working date is the one used.
      </p>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {list.isPending && <p className="hint">Loading the statutory rule packs…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view the statutory rule packs." />
      {data && codes.length === 0 && <Empty>No statutory rule pack is known.</Empty>}
      {codes.map((code) => {
        const revisions = (data?.items ?? []).filter((p) => p.code === code);
        return (
          <div key={code}>
            <h3 style={H3}>
              {titleOf(code)} <span className="hint">{code}</span>
            </h3>
            {revisions.length === 0 ? (
              <Empty>No revision yet.</Empty>
            ) : (
              <ul className="tasks" aria-label={`Revisions of ${code}`}>
                {revisions.map((p) => (
                  <PackItem key={p.id} p={p} onNotice={setNotice} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </Section>
  );
}

function PackItem({ p, onNotice }: { p: PackRevision; onNotice: (text: string) => void }) {
  const { can } = useSession();
  const titleId = `${useId()}-title`;
  return (
    <li aria-labelledby={titleId}>
      <h4 id={titleId} style={H4}>
        {`${p.code} revision ${p.revision}, from ${formatDate(p.effectiveFrom)}`}
      </h4>
      <dl className="kv">
        <Item term="State">
          <Badge tone={PACK_TONE[p.state] ?? 'neutral'}>{labelOf(PACK_STATE_LABEL, p.state)}</Badge>
        </Item>
        <Item term="Currency">{p.currencyCode}</Item>
        <Item term="Parameters">
          <ParametersText pack={p} />
        </Item>
        <Item term="Statute reference">{p.statuteReference}</Item>
        <Item term="Source reference">{p.sourceReference ?? '—'}</Item>
        <Item term="Validation reference">{p.validationReference ?? '—'}</Item>
        <Item term="Written by">{p.createdBy ? <UserRef userId={p.createdBy} /> : '—'}</Item>
        <Item term="Validated">
          {p.validatedAt ? (
            <>
              {when(p.validatedAt)}
              {p.validatedBy && (
                <>
                  {' by '}
                  <UserRef userId={p.validatedBy} />
                </>
              )}
            </>
          ) : (
            'Not yet'
          )}
        </Item>
        <Item term="Activated">
          {p.activatedAt ? (
            <>
              {when(p.activatedAt)}
              {p.activatedBy && (
                <>
                  {' by '}
                  <UserRef userId={p.activatedBy} />
                </>
              )}
            </>
          ) : (
            'Not yet'
          )}
        </Item>
      </dl>
      {p.state === 'DRAFT' && can(PACK_VALIDATE) && <ValidatePack p={p} onNotice={onNotice} />}
      {p.state === 'VALIDATED' && can(PACK_ACTIVATE) && <ActivatePack p={p} onNotice={onNotice} />}
    </li>
  );
}

/** A DRAFT revision is validated: where its values were obtained and how they were checked, against its version. */
function ValidatePack({ p, onNotice }: { p: PackRevision; onNotice: (text: string) => void }) {
  const qc = useQueryClient();
  const keys = useSettingsKeys();
  const [source, setSource] = useState('');
  const [validation, setValidation] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const validate = useMutation({
    mutationFn: (body: { sourceReference: string; validationReference: string; expectedVersion: number }) =>
      api<PackRevision>(`/v1/statutory-rule-packs/${encodeURIComponent(p.id)}/validate`, { body }),
    onSuccess: (r) => {
      setSource('');
      setValidation('');
      onNotice(`${r.code} revision ${r.revision} is validated. It is used once someone other than its author and its validator activates it.`);
      void qc.invalidateQueries({ queryKey: keys.packs });
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: keys.packs });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (validate.isPending) return;
    const s = source.trim();
    const v = validation.trim();
    const missing = !s ? 'Record where the values were obtained.' : !v ? 'Record how the values were validated for the jurisdiction and period.' : null;
    setProblem(missing);
    if (missing !== null) {
      validate.reset();
      return;
    }
    validate.mutate({ sourceReference: s, validationReference: v, expectedVersion: p.version });
  };
  return (
    <form className="stack" aria-label={`Validate ${p.code} revision ${p.revision}`} onSubmit={submit}>
      <label>
        Source reference: where the values were obtained (required)
        <input value={source} maxLength={MAX_REFERENCE} disabled={validate.isPending} onChange={(e) => setSource(e.target.value)} />
      </label>
      <label>
        Validation reference: how they were checked for the jurisdiction and period (required)
        <input value={validation} maxLength={MAX_REFERENCE} disabled={validate.isPending} onChange={(e) => setValidation(e.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" disabled={validate.isPending}>
          Record the validation
        </button>
      </div>
      <Refusal error={validate.error} words={PACK_VALIDATE_WORDS} noAnswer="No answer came back, so the validation may or may not have been recorded. Reload the page to check." />
    </form>
  );
}

/** A VALIDATED revision is activated against its version by someone who neither wrote nor validated it. */
function ActivatePack({ p, onNotice }: { p: PackRevision; onNotice: (text: string) => void }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const keys = useSettingsKeys();
  const involved = !!me?.userId && (me.userId === p.createdBy || me.userId === p.validatedBy);
  const hintId = `${useId()}-involved`;
  const activate = useMutation({
    mutationFn: () => api<PackRevision>(`/v1/statutory-rule-packs/${encodeURIComponent(p.id)}/activate`, { body: { expectedVersion: p.version } }),
    onSuccess: (r) => {
      onNotice(`${r.code} revision ${r.revision} is active from ${formatDate(r.effectiveFrom)}. A settlement calculated from now on uses it.`);
      void qc.invalidateQueries({ queryKey: keys.packs });
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: keys.packs });
    },
  });
  return (
    <div className="stack">
      {involved && (
        <p className="hint" id={hintId}>
          You wrote or validated this revision, so someone else activates it.
        </p>
      )}
      <div className="row">
        <button type="button" disabled={activate.isPending || involved} aria-describedby={involved ? hintId : undefined} onClick={() => activate.mutate()}>
          {`Activate ${p.code} revision ${p.revision}`}
        </button>
      </div>
      <Refusal error={activate.error} words={PACK_ACTIVATE_WORDS} noAnswer="No answer came back, so the revision may or may not have been activated. Reload the page to check." />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Exports for the navigation step (screens-registry.ts)
// ---------------------------------------------------------------------------------------------------------

/**
 * The settings screen. The menu entry follows the payroll configuration read duty (the policy's writers and activators hold it);
 * an HR Administrator who reads the statutory packs reaches the screen from a settlement's calculation.
 */
export const SETTLEMENT_SETTINGS_SCREENS: ScreenRoute[] = [{ path: PATH, title: 'Settlement policy and statutory packs', permission: POLICY_READ, nav: true, component: SettlementSettingsScreen }];
