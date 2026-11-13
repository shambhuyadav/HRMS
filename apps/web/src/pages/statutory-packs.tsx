// Statutory rule packs: gratuity, PF, ESIC and the state professional tax packs (decided under owner delegation, 6 Nov 2026: docs/03
// I-85 and I-88).
//   /payroll/statutory-packs
//
// Every rate, ceiling and slab payroll and settlements use for these is a value of a pack revision, never of the code. A revision starts
// as an inactive draft (the seeded ones were written by the system and are not advice); one authorised person records where its values
// were obtained and how they were validated against the law in force, and another person (neither its author nor its validator)
// activates it. Only an ACTIVE revision values anything: until then an employee a statutory head applies to is blocked with
// RULE_PACK_NOT_CONFIGURED. An active revision can be retired, with a reason, by someone holding the activation duty.
// The server authorises every call and decides every rule; this screen hides what the selected assignment cannot use, shows what the
// server returned and says its refusals in plain words (the conventions of lifecycle-documents.tsx, whose helpers it shares).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type FormEvent, useId, useMemo, useState } from 'react';
import { api, ApiError, formatAmount, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, Section } from '../ui';
import { isConflict, Item, labelOf, LoadProblem, PACK_STATE_LABEL, Refusal, retryTransient, UserRef, when, type Words } from './lifecycle-documents';

const PACK_READ = 'statutory_pack.read.operational';
const PACK_VALIDATE = 'statutory_pack.validate.operational';
const PACK_ACTIVATE = 'statutory_pack.activate.operational';
const PATH = '/payroll/statutory-packs';
const MAX_REFERENCE = 500;

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

const TONE: Record<string, 'good' | 'warn' | 'bad'> = { DRAFT: 'warn', VALIDATED: 'warn', ACTIVE: 'good' };
const H3: CSSProperties = { fontSize: '1rem', margin: '0.5rem 0 0' };
const H4: CSSProperties = { fontSize: '0.95rem', margin: '0.25rem 0' };
const SCROLL: CSSProperties = { overflowX: 'auto' };

const STALE = 'The revision changed after it was loaded. The rule packs have been reloaded: check it and try again.';
const GONE = 'This rule pack revision is not available.';
const VALIDATE_WORDS: Words = {
  SOURCE_REQUIRED: `Record where the values were obtained (at most ${MAX_REFERENCE} characters).`,
  VALIDATION_REQUIRED: `Record how the values were validated for the jurisdiction and period (at most ${MAX_REFERENCE} characters).`,
  INVALID_STATE: 'Only an inactive draft is validated, and this revision is no longer one. The rule packs have been reloaded.',
  STALE_VERSION: STALE,
  NOT_FOUND: GONE,
  FORBIDDEN: 'The selected role cannot validate statutory rule packs: that needs its own grant.',
};
const ACTIVATE_WORDS: Words = {
  SELF_APPROVAL: 'Activated by someone other than the person who wrote or validated it.',
  INVALID_STATE: 'Only a validated revision is activated, and this one is no longer waiting for activation. The rule packs have been reloaded.',
  STALE_VERSION: STALE,
  NOT_FOUND: GONE,
  FORBIDDEN: 'The selected role cannot activate statutory rule packs: that needs its own grant.',
};
const RETIRE_WORDS: Words = {
  REASON_REQUIRED: `Record why the revision is retired (at most ${MAX_REFERENCE} characters).`,
  INVALID_STATE: 'Only an active revision is retired, and this one is no longer active. The rule packs have been reloaded.',
  STALE_VERSION: STALE,
  NOT_FOUND: GONE,
  FORBIDDEN: 'The selected role cannot retire statutory rule packs: that needs the activation duty.',
};

/** Query keys carry the selected company and assignment, so one role's answer is never shown to another. */
function usePackKey() {
  const { stored } = useSession();
  const context = `${stored?.companyId ?? '-'}:${stored?.assignmentId ?? '-'}`;
  return useMemo(() => ['statutory-packs', context] as const, [context]);
}

// ---------------------------------------------------------------------------------------------------------
// Parameters in words (the pack definitions of modules/statutory/rule-packs.ts); anything else as JSON
// ---------------------------------------------------------------------------------------------------------
const text = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : null);
const ROUNDING: Record<string, string> = { HALF_UP_WHOLE: 'to the nearest whole unit, half up', UP_WHOLE: 'up to the next whole unit' };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m: unknown) => MONTHS[Number(m) - 1] ?? String(m);
/** An amount of a pack as money ("INR 15,000.00"), as everywhere else in the app; a dash when the pack holds none. */
const money = (v: unknown, currency: string) => {
  const t = text(v);
  return t === null ? '—' : formatAmount(t, currency);
};

function Slabs({ slabs, currency }: { slabs: unknown[]; currency: string }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Monthly slabs">
        <thead>
          <tr>
            <th scope="col">Monthly gross up to</th>
            <th scope="col">Amount</th>
            <th scope="col">In a given month</th>
          </tr>
        </thead>
        <tbody>
          {slabs.map((raw, i) => {
            const s = (raw ?? {}) as { upTo?: unknown; amount?: unknown; monthAmounts?: Record<string, unknown> };
            const months = s.monthAmounts && typeof s.monthAmounts === 'object' ? Object.entries(s.monthAmounts) : [];
            return (
              <tr key={i}>
                <td>{text(s.upTo) ? money(s.upTo, currency) : 'No upper limit'}</td>
                <td>{money(s.amount, currency)}</td>
                <td>{months.length === 0 ? '—' : months.map(([m, a]) => `${monthName(m)}: ${money(a, currency)}`).join(', ')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function LwfSlabs({ slabs, currency }: { slabs: unknown[]; currency: string }) {
  return (
    <div style={SCROLL}>
      <table aria-label="Wage slabs">
        <thead>
          <tr>
            <th scope="col">Monthly wages up to</th>
            <th scope="col">Employee</th>
            <th scope="col">Employer</th>
          </tr>
        </thead>
        <tbody>
          {slabs.map((raw, i) => {
            const s = (raw ?? {}) as { upTo?: unknown; employee?: unknown; employer?: unknown };
            return (
              <tr key={i}>
                <td>{text(s.upTo) ? money(s.upTo, currency) : 'No upper limit'}</td>
                <td>{money(s.employee, currency)}</td>
                <td>{money(s.employer, currency)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const TAX_ROUNDING: Record<string, string> = { NEAREST_TEN: 'to the nearest ten', NEAREST_RUPEE: 'to the nearest rupee' };

/** One regime of an INCOME_TAX revision (I-90): its slabs, rebate, surcharge, cess and rounding, and its exemptions and caps, in words. */
function TaxRegime({ code, regime: r, currency: c }: { code: string; regime: Record<string, unknown>; currency: string }) {
  const slabs = Array.isArray(r.slabs) ? (r.slabs as { upTo?: unknown; ratePercent?: unknown }[]) : [];
  const bands = Array.isArray(r.surcharge) ? (r.surcharge as { incomeAbove?: unknown; ratePercent?: unknown }[]) : [];
  const rebate = (r.rebate ?? {}) as { incomeUpTo?: unknown; maxAmount?: unknown; marginalRelief?: unknown };
  const hra = r.hraExemption as { metroPercent?: unknown; otherPercent?: unknown; rentAboveSalaryPercent?: unknown } | undefined;
  const name = code === 'NEW' ? 'New regime' : code === 'OLD' ? 'Old regime' : code;
  return (
    <div>
      <p>
        {`${name}: standard deduction ${money(r.standardDeduction, c)}; rebate of up to ${money(rebate.maxAmount, c)} on taxable income up to ${money(rebate.incomeUpTo, c)}${rebate.marginalRelief === true ? ', with marginal relief just above it' : ''}; ${bands.length > 0 ? `surcharge ${bands.map((b) => `${text(b.ratePercent)}% above ${money(b.incomeAbove, c)}`).join(', ')} (with marginal relief)` : 'no surcharge'}; cess ${text(r.cessPercent) ?? '—'}%; the year's tax rounded ${labelOf(TAX_ROUNDING, String(r.rounding))}.`}
        {hra ? ` House rent allowance exempt: the least of the allowance, rent less ${text(hra.rentAboveSalaryPercent)}% of salary, and ${text(hra.metroPercent)}% of salary (four metro cities) or ${text(hra.otherPercent)}% elsewhere.` : ' No house rent allowance exemption.'}
        {text(r.employerNpsLimitPercent) ? ` Employer NPS contribution deductible up to ${text(r.employerNpsLimitPercent)}% of salary.` : ''}
      </p>
      <div style={SCROLL}>
        <table aria-label={`${name} slabs`}>
          <thead>
            <tr>
              <th scope="col">Taxable income up to</th>
              <th scope="col">Rate</th>
            </tr>
          </thead>
          <tbody>
            {slabs.map((s, i) => (
              <tr key={i}>
                <td>{text(s.upTo) ? money(s.upTo, c) : 'No upper limit'}</td>
                <td>{`${text(s.ratePercent) ?? '—'}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ParametersText({ pack: p }: { pack: PackRevision }) {
  const q = p.parameters ?? {};
  const c = p.currencyCode;
  const m = (v: unknown) => money(v, c);
  if (/^LWF_[A-Z]{2}$/.test(p.code) && Array.isArray(q.slabs)) {
    const months = Array.isArray(q.contributionMonths) ? q.contributionMonths.map(monthName).join(' and ') : '—';
    return (
      <>
        {`State ${text(q.stateCode) ?? p.code.slice(4)}; contributions with the wages of ${months}; the slab holding the month's wages applies.`}
        <LwfSlabs slabs={q.slabs} currency={c} />
      </>
    );
  }
  if (p.code === 'INCOME_TAX' && q.regimes && typeof q.regimes === 'object') {
    const regimes = q.regimes as Record<string, Record<string, unknown>>;
    return (
      <>
        {`Financial year ${text(q.fiscalYear) ?? '—'}; an employee who chooses no regime is taxed under the ${q.defaultRegime === 'OLD' ? 'old' : 'new'} regime.`}
        {['NEW', 'OLD']
          .filter((k) => regimes[k])
          .map((k) => (
            <TaxRegime key={k} code={k} regime={regimes[k]!} currency={c} />
          ))}
      </>
    );
  }
  if (p.code === 'PF' && text(q.employeeRatePercent) && text(q.wageCeiling)) {
    return (
      <>
        {`Employee ${text(q.employeeRatePercent)}% and employer ${text(q.employerRatePercent)}% of PF wages up to ${m(q.wageCeiling)} (all wages under the employee's higher-wage option); of the employer's share, pension ${text(q.pensionRatePercent)}% of wages up to ${m(q.pensionWageCeiling)}; EDLI ${text(q.edliRatePercent)}% of wages up to ${m(q.edliWageCeiling)}; administration charges ${text(q.adminChargesRatePercent)}%; each figure rounded ${labelOf(ROUNDING, String(q.rounding))}.`}
      </>
    );
  }
  if (p.code === 'ESIC' && text(q.employeeRatePercent) && text(q.wageCeiling)) {
    const starts = Array.isArray(q.contributionPeriodStartMonths) ? q.contributionPeriodStartMonths.map(monthName).join(' and ') : '—';
    return (
      <>
        {`Employee ${text(q.employeeRatePercent)}% and employer ${text(q.employerRatePercent)}% of wages, for monthly wages up to ${m(q.wageCeiling)}; contribution periods start in ${starts}, and an employee covered at a period's start stays covered to its end; rounded ${labelOf(ROUNDING, String(q.rounding))}.`}
      </>
    );
  }
  if (/^PT_[A-Z]{2}$/.test(p.code) && Array.isArray(q.slabs)) {
    return (
      <>
        {`State ${text(q.stateCode) ?? p.code.slice(3)}; the slab holding the month's gross applies.`}
        <Slabs slabs={q.slabs} currency={c} />
      </>
    );
  }
  if (p.code === 'GRATUITY' && text(q.wageDays) && text(q.wageDivisor)) {
    // Separation types in words ("death, disablement"), not their codes.
    const exempt = Array.isArray(q.exemptSeparationTypes) ? q.exemptSeparationTypes.map((t) => String(t).replace(/_/g, ' ').toLowerCase()).join(', ') : '';
    return (
      <>
        {`${text(q.wageDays)} days' wages per counted year, a month's wages / ${text(q.wageDivisor)}, ${text(q.minimumServiceYears)} years' continuous service${exempt ? ` (none on ${exempt})` : ''}, a final part-year of more than ${text(q.partYearMonthsOver)} months counts, ceiling ${m(q.ceilingAmount)}`}
      </>
    );
  }
  return <code>{JSON.stringify(q)}</code>;
}

// =========================================================================================================
// The screen
// =========================================================================================================
function StatutoryPacksScreen() {
  const key = usePackKey();
  const list = useQuery({ queryKey: key, queryFn: () => api<PackList>('/v1/statutory-rule-packs'), retry: retryTransient });
  const [notice, setNotice] = useState<string | null>(null);
  const data = list.data;
  const codes = data ? [...new Set([...data.definitions.map((d) => d.code), ...data.items.map((p) => p.code)])] : [];
  const titleOf = (code: string) =>
    data?.definitions.find((d) => d.code === code)?.title ?? (code.startsWith('PT_') ? `Professional tax (${code.slice(3)})` : code.startsWith('LWF_') ? `Labour welfare fund (${code.slice(4)})` : code);
  return (
    <>
      <h1>Statutory packs</h1>
      <p className="hint">
        Gratuity, provident fund, employees’ state insurance and each state’s professional tax are valued in payroll and settlements from these packs only. Every rate,
        ceiling and slab is a value of a dated revision, and the revision in force for the period is the one used.
      </p>
      <p className="hint" role="note">
        A revision is used only after one authorised person has validated it against the law in force and a second person, who neither wrote nor validated it, has
        activated it. Until then, payroll and settlements stop for any employee that statutory head applies to. The drafts supplied are starting points to check, not
        advice.
      </p>
      {notice && (
        <p className="ok" role="status">
          {notice}
        </p>
      )}
      {list.isPending && <p className="hint loading">Loading the statutory packs…</p>}
      <LoadProblem error={list.error} forbidden="The selected role cannot view the statutory packs: that needs the statutory pack read duty." />
      {data && codes.length === 0 && <Empty>No statutory pack is known.</Empty>}
      {codes.map((code) => {
        const revisions = (data?.items ?? []).filter((p) => p.code === code);
        return (
          <Section key={code} title={titleOf(code)}>
            {revisions.length === 0 ? (
              <Empty>No revision yet.</Empty>
            ) : (
              <ul className="tasks" aria-label={`Revisions of ${code}`}>
                {revisions.map((p) => (
                  <PackItem key={p.id} p={p} onNotice={setNotice} />
                ))}
              </ul>
            )}
          </Section>
        );
      })}
    </>
  );
}

function Who({ at, by }: { at: string | null; by: string | null }) {
  if (!at) return <>Not yet</>;
  return (
    <>
      {when(at)}
      {by && (
        <>
          {' by '}
          <UserRef userId={by} />
        </>
      )}
    </>
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
          <Badge tone={TONE[p.state] ?? 'neutral'}>{labelOf(PACK_STATE_LABEL, p.state)}</Badge>
        </Item>
        <Item term="Currency">{p.currencyCode}</Item>
        <Item term="Values" wide>
          <ParametersText pack={p} />
        </Item>
        <Item term="Statute reference" wide>
          {p.statuteReference}
        </Item>
        <Item term="Source reference" wide={!!p.sourceReference}>
          {p.sourceReference ?? '—'}
        </Item>
        <Item term="Validation reference" wide={!!p.validationReference}>
          {p.validationReference ?? '—'}
        </Item>
        <Item term="Written by">{p.createdBy ? <UserRef userId={p.createdBy} /> : '—'}</Item>
        <Item term="Validated">
          <Who at={p.validatedAt} by={p.validatedBy} />
        </Item>
        <Item term="Activated">
          <Who at={p.activatedAt} by={p.activatedBy} />
        </Item>
      </dl>
      {p.state === 'DRAFT' && can(PACK_VALIDATE) && <ValidatePack p={p} onNotice={onNotice} />}
      {p.state === 'VALIDATED' && can(PACK_ACTIVATE) && <ActivatePack p={p} onNotice={onNotice} />}
      {p.state === 'ACTIVE' && can(PACK_ACTIVATE) && <RetirePack p={p} onNotice={onNotice} />}
    </li>
  );
}

/** A DRAFT revision is validated: where its values were obtained and how they were checked, against its version. */
function ValidatePack({ p, onNotice }: { p: PackRevision; onNotice: (text: string) => void }) {
  const qc = useQueryClient();
  const key = usePackKey();
  const [source, setSource] = useState('');
  const [validation, setValidation] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const validate = useMutation({
    mutationFn: (body: { sourceReference: string; validationReference: string; expectedVersion: number }) => api<PackRevision>(`/v1/statutory-rule-packs/${encodeURIComponent(p.id)}/validate`, { body }),
    onSuccess: (r) => {
      setSource('');
      setValidation('');
      onNotice(`${r.code} revision ${r.revision} is validated. It is used once someone other than its author and its validator activates it.`);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: key });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (validate.isPending) return;
    const s = source.trim();
    const v = validation.trim();
    const missing = !s ? 'Record where the values were obtained.' : !v ? 'Record how the values were validated against the law in force for the period.' : null;
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
        Validation reference: how they were checked against the law in force for the jurisdiction and period (required)
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
      <Refusal error={validate.error} words={VALIDATE_WORDS} noAnswer="No answer came back, so the validation may or may not have been recorded. Reload the page to check." />
    </form>
  );
}

/** A VALIDATED revision is activated against its version by someone who neither wrote nor validated it. */
function ActivatePack({ p, onNotice }: { p: PackRevision; onNotice: (text: string) => void }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const key = usePackKey();
  const involved = !!me?.userId && (me.userId === p.createdBy || me.userId === p.validatedBy);
  const hintId = `${useId()}-involved`;
  const activate = useMutation({
    mutationFn: () => api<PackRevision>(`/v1/statutory-rule-packs/${encodeURIComponent(p.id)}/activate`, { body: { expectedVersion: p.version } }),
    onSuccess: (r) => {
      onNotice(`${r.code} revision ${r.revision} is active from ${formatDate(r.effectiveFrom)}. Payroll and settlements calculated from now on use it.`);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: key });
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
        <button type="button" aria-label={`Activate ${p.code} revision ${p.revision}`} disabled={activate.isPending || involved} aria-describedby={involved ? hintId : undefined} onClick={() => activate.mutate()}>
          Activate
        </button>
      </div>
      <Refusal error={activate.error} words={ACTIVATE_WORDS} noAnswer="No answer came back, so the revision may or may not have been activated. Reload the page to check." />
    </div>
  );
}

/** An ACTIVE revision is retired, with a reason; from then on nothing is valued under it. */
function RetirePack({ p, onNotice }: { p: PackRevision; onNotice: (text: string) => void }) {
  const qc = useQueryClient();
  const key = usePackKey();
  const [reason, setReason] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const retire = useMutation({
    mutationFn: (body: { reason: string; expectedVersion: number }) => api<PackRevision>(`/v1/statutory-rule-packs/${encodeURIComponent(p.id)}/retire`, { body }),
    onSuccess: (r) => {
      setReason('');
      onNotice(`${r.code} revision ${r.revision} is retired. Without another active revision, employees it applied to are blocked with RULE_PACK_NOT_CONFIGURED.`);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (error) => {
      if (isConflict(error) || !(error instanceof ApiError)) void qc.invalidateQueries({ queryKey: key });
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (retire.isPending) return;
    const r = reason.trim();
    setProblem(r ? null : 'Record why the revision is retired.');
    if (!r) {
      retire.reset();
      return;
    }
    retire.mutate({ reason: r, expectedVersion: p.version });
  };
  return (
    <form className="stack" aria-label={`Retire ${p.code} revision ${p.revision}`} onSubmit={submit}>
      <label>
        Reason for retiring (required)
        <input value={reason} maxLength={MAX_REFERENCE} disabled={retire.isPending} onChange={(e) => setReason(e.target.value)} />
      </label>
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="row">
        <button type="submit" className="danger" aria-label={`Retire ${p.code} revision ${p.revision}`} disabled={retire.isPending}>
          Retire
        </button>
      </div>
      <Refusal error={retire.error} words={RETIRE_WORDS} noAnswer="No answer came back, so the revision may or may not have been retired. Reload the page to check." />
    </form>
  );
}

/** The statutory packs screen, in the menu for whoever reads the packs (an operational duty of HR Administrators). */
export const STATUTORY_PACK_SCREENS: ScreenRoute[] = [{ path: PATH, title: 'Statutory packs', permission: PACK_READ, nav: true, component: StatutoryPacksScreen }];
