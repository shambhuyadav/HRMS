// Expense policies (FR-078; BR-019; DF06): revisions with their effective period, submission window, high-value threshold and
// category rules, a draft maintained by HR and activated by someone else, which ends the revision it replaces; and the
// categories. Every value comes from the person filling the form; the page proposes none. Limits are review thresholds: going
// over one flags a claim line for the financial reviewer, it does not refuse or pay it. The server re-checks every duty and
// rule; this page only offers what the role can do.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError, formatAmount, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../ui';

const MANAGE = 'expense_policy.manage.operational';
const ACTIVATE = 'expense_policy.activate.operational';

interface Rule {
  id: string;
  category: string;
  limitBasis: string;
  grade: string | null;
  location: string | null;
  limitAmount: string;
  receiptRequired: boolean;
}
export interface ExpensePolicy {
  id: string;
  code: string;
  revision: number;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  submissionWindowDays: number;
  highValueThreshold: string;
  state: string;
  version: number;
  lastUsedOn: string | null;
  rules: Rule[];
  warnings: { code: string; text: string }[];
}
interface Option {
  id: string;
  code: string;
  name: string;
}
interface CategoryOption extends Option {
  limitBasis: string;
}
interface Category extends CategoryOption {
  active: boolean;
  version: number;
}

const BASIS_TEXT: Record<string, string> = { PER_DAY: 'a day', PER_NIGHT: 'a night', PER_LINE: 'a line' };
const WARNING_BADGE: Record<string, string> = { NO_RULES: 'no rules', TIED_RULES: 'tied rules', OVERLAPPING: 'overlap' };

interface DraftValues {
  effectiveFrom: string;
  effectiveTo: string;
  submissionWindowDays: string;
  highValueThreshold: string;
}
const BLANK: DraftValues = { effectiveFrom: '', effectiveTo: '', submissionWindowDays: '', highValueThreshold: '' };
const draftBody = (v: DraftValues) => ({
  effectiveFrom: v.effectiveFrom,
  effectiveTo: v.effectiveTo || null,
  submissionWindowDays: Number(v.submissionWindowDays),
  highValueThreshold: v.highValueThreshold,
});

/** Names for the codes a rule carries, where the page knows them; a code nobody can name (an inactive one) shows as itself. */
interface Names {
  category: (code: string) => string;
  location: (code: string) => string;
}
const CODES: Names = { category: (code) => code, location: (code) => code };
const appliesTo = (r: Pick<Rule, 'grade' | 'location'>, names: Names = CODES) =>
  r.grade || r.location ? [r.grade && `grade ${r.grade}`, r.location && `location ${names.location(r.location)}`].filter(Boolean).join(', ') : 'the whole company';
const periodText = (p: ExpensePolicy) => (p.effectiveTo ? `from ${formatDate(p.effectiveFrom)}, until before ${formatDate(p.effectiveTo)}` : `from ${formatDate(p.effectiveFrom)}`);
const nameOf = (p: ExpensePolicy) => `${p.code} revision ${p.revision}`;
// Digit grouping as everywhere else in the app ("INR 50,000.00").
const money = (v: string, currency: string) => formatAmount(v, currency);

/** Refusals of a policy change in plain words; any other is shown as the server sent it. */
function refusalText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.details as { revisions?: { code: string; revision: number }[]; ties?: { category: string; grade: string; location: string }[]; lastUsedOn?: string } | undefined;
  if (error.code === 'POLICY_OVERLAP') {
    return `This revision's period overlaps ${(details?.revisions ?? []).map((r) => `${r.code} revision ${r.revision}`).join(', ')}, and a claim on those dates would be ambiguous. Change the dates, or retire the other revision.`;
  }
  if (error.code === 'POLICY_IN_USE') return `A submitted claim used the revision this would end for ${details?.lastUsedOn ? formatDate(details.lastUsedOn) : 'a later date'}, so it cannot end on or before that date. Choose a later date.`;
  if (error.code === 'POLICY_AMBIGUOUS') {
    return `A grade rule and a location rule tie for an employee with both: ${(details?.ties ?? []).map((t) => `${t.category} for grade ${t.grade} at location ${t.location}`).join('; ')}. Add a rule naming that grade and location.`;
  }
  if (error.code === 'POLICY_HAS_NO_RULES') return 'Add at least one category rule first: a revision without rules would refuse every claim.';
  if (error.code === 'RULE_EXISTS') return 'This revision already has a rule for that category, grade and location.';
  if (error.code === 'SELF_APPROVAL') return 'Whoever wrote or last edited this revision cannot activate it; someone else must.';
  if (error.code === 'INVALID_PERIOD') return 'The end of the period must be after its start, and a retirement cannot extend a revision.';
  if (error.code === 'BACKDATED_RETIREMENT') return 'A revision is retired from today or a later date.';
  if (error.code === 'STALE_VERSION') return 'This changed since you opened it. It has been reloaded; try again.';
  if (error.code === 'CATEGORY_EXISTS') return 'This category code is already in use.';
  return null;
}

function Refusal({ error }: { error: unknown }) {
  const words = refusalText(error);
  if (!words) return <ErrorNote error={error} />;
  return (
    <p role="alert" className="error">
      {words}
    </p>
  );
}

function DraftFields({ values, onChange }: { values: DraftValues; onChange: (v: DraftValues) => void }) {
  const field = (key: keyof DraftValues) => ({ value: values[key], onChange: (e: { target: { value: string } }) => onChange({ ...values, [key]: e.target.value }) });
  return (
    <>
      <label>
        Effective from
        <input type="date" required {...field('effectiveFrom')} />
      </label>
      <label>
        Effective until (exclusive, optional)
        <input type="date" {...field('effectiveTo')} />
      </label>
      <label>
        Submission window (calendar days)
        <input required inputMode="numeric" pattern="[1-9]\d{0,3}" {...field('submissionWindowDays')} />
      </label>
      <label>
        High-value approval above (INR)
        <input required inputMode="decimal" pattern="\d{1,13}(\.\d{1,2})?" {...field('highValueThreshold')} />
      </label>
    </>
  );
}

function NewRevision({ onChanged }: { onChanged: () => void }) {
  const [code, setCode] = useState('');
  const [values, setValues] = useState(BLANK);
  const create = useMutation({
    mutationFn: () => api('/v1/expense/policies', { body: { code: code.trim().toUpperCase(), ...draftBody(values) } }),
    onSuccess: () => {
      setCode('');
      setValues(BLANK);
      onChanged();
    },
  });
  return (
    <Section title="New policy revision">
      <form
        className="grid-form"
        aria-label="New policy revision"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Policy code
          <input required maxLength={40} pattern="[A-Za-z][A-Za-z0-9_]*" value={code} onChange={(e) => setCode(e.target.value)} />
        </label>
        <DraftFields values={values} onChange={setValues} />
        <button type="submit" disabled={create.isPending}>
          Create draft
        </button>
      </form>
      <p className="hint">An existing code gets its next revision; a new code starts at revision 1. The revision stays a draft, applying to nobody, until it has its category rules and someone other than its author activates it. Claims are in INR only.</p>
      <Refusal error={create.error} />
    </Section>
  );
}

function AddRule({ policy, onDone }: { policy: ExpensePolicy; onDone: () => void }) {
  const options = useQuery({ queryKey: ['expense-policy-options'], queryFn: () => api<{ categories: CategoryOption[]; grades: Option[]; locations: Option[] }>('/v1/expense/policy-options') });
  const [rule, setRule] = useState({ categoryId: '', gradeId: '', locationId: '', limitAmount: '', receiptRequired: true });
  const add = useMutation({
    mutationFn: () =>
      api(`/v1/expense/policies/${policy.id}/rules`, {
        body: { expectedVersion: policy.version, categoryId: rule.categoryId, limitAmount: rule.limitAmount, receiptRequired: rule.receiptRequired, ...(rule.gradeId ? { gradeId: rule.gradeId } : {}), ...(rule.locationId ? { locationId: rule.locationId } : {}) },
      }),
    onSuccess: onDone,
  });
  const chosen = options.data?.categories.find((c) => c.id === rule.categoryId);
  const select = (label: string, key: 'gradeId' | 'locationId', items: Option[] | undefined) => (
    <label>
      {label}
      <select value={rule[key]} onChange={(e) => setRule({ ...rule, [key]: e.target.value })}>
        <option value="">Any</option>
        {items?.map((o) => (
          <option key={o.id} value={o.id}>
            {key === 'gradeId' ? `${o.name} (${o.code})` : o.name}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="grid-form"
      aria-label={`Add a rule to ${nameOf(policy)}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      <label>
        Category
        <select required value={rule.categoryId} onChange={(e) => setRule({ ...rule, categoryId: e.target.value })}>
          <option value="">Choose</option>
          {options.data?.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {select('Grade', 'gradeId', options.data?.grades)}
      {select('Location', 'locationId', options.data?.locations)}
      <label>
        Limit (INR{chosen ? `, ${BASIS_TEXT[chosen.limitBasis] ?? chosen.limitBasis}` : ''})
        <input required inputMode="decimal" pattern="\d{1,13}(\.\d{1,2})?" value={rule.limitAmount} onChange={(e) => setRule({ ...rule, limitAmount: e.target.value })} />
      </label>
      <label className="check">
        <input type="checkbox" checked={rule.receiptRequired} onChange={(e) => setRule({ ...rule, receiptRequired: e.target.checked })} /> Receipt required
      </label>
      <button type="submit" disabled={add.isPending}>
        Add rule
      </button>
      <p className="hint">Leaving both as Any covers the whole company, at the lowest priority. The rule naming most of grade and location wins for an employee on the expense date.</p>
      <Refusal error={options.error ?? add.error} />
    </form>
  );
}

function RevisionActions({ policy, canManage, canActivate, onChanged }: { policy: ExpensePolicy; canManage: boolean; canActivate: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState<'edit' | 'rule' | 'retire' | null>(null);
  const [values, setValues] = useState<DraftValues>({ effectiveFrom: policy.effectiveFrom, effectiveTo: policy.effectiveTo ?? '', submissionWindowDays: String(policy.submissionWindowDays), highValueThreshold: Number(policy.highValueThreshold).toFixed(2) });
  const [retire, setRetire] = useState({ effectiveTo: '', reason: '' });
  const done = () => {
    setOpen(null);
    onChanged();
  };
  // A stale version reloads the list, so the next attempt reviews the revision as it now stands.
  const refreshOnError = (err: unknown) => {
    if (err instanceof ApiError && err.code === 'STALE_VERSION') onChanged();
  };
  const edit = useMutation({ mutationFn: () => api(`/v1/expense/policies/${policy.id}`, { method: 'PATCH', body: { expectedVersion: policy.version, ...draftBody(values) } }), onSuccess: done, onError: refreshOnError });
  const activate = useMutation({ mutationFn: () => api(`/v1/expense/policies/${policy.id}/activate`, { body: { expectedVersion: policy.version } }), onSuccess: done, onError: refreshOnError });
  const retireIt = useMutation({ mutationFn: () => api(`/v1/expense/policies/${policy.id}/retire`, { body: { expectedVersion: policy.version, effectiveTo: retire.effectiveTo, reason: retire.reason.trim() } }), onSuccess: done, onError: refreshOnError });
  const name = nameOf(policy);
  const toggle = (which: 'edit' | 'rule' | 'retire') => setOpen(open === which ? null : which);
  return (
    <>
      {policy.state === 'DRAFT' && canManage && (
        <>
          <button type="button" className="link" aria-label={`Edit ${name}`} aria-expanded={open === 'edit'} onClick={() => toggle('edit')}>
            Edit
          </button>{' '}
          <button type="button" className="link" aria-label={`Add a rule to ${name}`} aria-expanded={open === 'rule'} onClick={() => toggle('rule')}>
            Add a rule
          </button>{' '}
        </>
      )}
      {policy.state === 'DRAFT' && canActivate && (
        <button type="button" className="link" aria-label={`Activate ${name}`} disabled={activate.isPending} onClick={() => activate.mutate()}>
          Activate
        </button>
      )}
      {policy.state === 'ACTIVE' && canActivate && (
        <button type="button" className="link danger" aria-label={`Retire ${name}`} aria-expanded={open === 'retire'} onClick={() => toggle('retire')}>
          Retire
        </button>
      )}
      <Refusal error={activate.error} />
      {open === 'edit' && (
        <form
          className="grid-form"
          aria-label={`Edit ${name}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            edit.mutate();
          }}
        >
          <DraftFields values={values} onChange={setValues} />
          <button type="submit" disabled={edit.isPending}>
            Save draft
          </button>
          <Refusal error={edit.error} />
        </form>
      )}
      {open === 'rule' && <AddRule policy={policy} onDone={done} />}
      {open === 'retire' && (
        <form
          className="grid-form"
          aria-label={`Retire ${name}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            retireIt.mutate();
          }}
        >
          <label>
            No longer applies from
            <input type="date" required value={retire.effectiveTo} onChange={(e) => setRetire({ ...retire, effectiveTo: e.target.value })} />
          </label>
          <label className="wide">
            Reason for retiring
            <input required maxLength={500} value={retire.reason} onChange={(e) => setRetire({ ...retire, reason: e.target.value })} />
          </label>
          <button type="submit" disabled={retireIt.isPending}>
            Confirm retirement
          </button>
          <Refusal error={retireIt.error} />
        </form>
      )}
    </>
  );
}

/** A revision's rules in words; on a draft its maintainer can take one out from beside it. */
function RuleList({ policy, names, canRemove, onChanged }: { policy: ExpensePolicy; names: Names; canRemove: boolean; onChanged: () => void }) {
  const remove = useMutation({
    mutationFn: (ruleId: string) => api(`/v1/expense/policies/${policy.id}/rules/${ruleId}/remove`, { body: { expectedVersion: policy.version } }),
    onSuccess: onChanged,
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') onChanged();
    },
  });
  if (policy.rules.length === 0) return null;
  return (
    <>
      <ul>
        {policy.rules.map((r) => (
          <li key={r.id}>
            {`${names.category(r.category)} for ${appliesTo(r, names)}: ${money(r.limitAmount, policy.currency)} ${BASIS_TEXT[r.limitBasis] ?? r.limitBasis}, receipt ${r.receiptRequired ? 'required' : 'not required'}`}
            {canRemove && (
              <>
                {' '}
                <button type="button" className="link" aria-label={`Remove ${r.category} for ${appliesTo(r)}`} disabled={remove.isPending} onClick={() => remove.mutate(r.id)}>
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <Refusal error={remove.error} />
    </>
  );
}

function CategoriesSection() {
  const qc = useQueryClient();
  const categories = useQuery({ queryKey: ['expense-category-maintenance'], queryFn: () => api<{ items: Category[] }>('/v1/expense/category-maintenance') });
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['expense-category-maintenance'] });
    void qc.invalidateQueries({ queryKey: ['expense-policy-options'] });
  };
  const [form, setForm] = useState({ code: '', name: '', limitBasis: '' });
  const create = useMutation({
    mutationFn: () => api('/v1/expense/categories', { body: { code: form.code.trim().toUpperCase(), name: form.name.trim(), limitBasis: form.limitBasis } }),
    onSuccess: () => {
      setForm({ code: '', name: '', limitBasis: '' });
      refresh();
    },
  });
  const setActive = useMutation({
    mutationFn: (c: Category) => api(`/v1/expense/categories/${c.id}`, { method: 'PATCH', body: { expectedVersion: c.version, active: !c.active } }),
    onSuccess: refresh,
    onError: (err: unknown) => {
      if (err instanceof ApiError && err.code === 'STALE_VERSION') refresh();
    },
  });
  return (
    <Section title="Expense categories">
      <ErrorNote error={categories.error} />
      {categories.data && categories.data.items.length > 0 && (
        <table aria-label="Expense categories">
          <thead>
            <tr>
              <th scope="col">Code</th>
              <th scope="col">Name</th>
              <th scope="col">Limit counts per</th>
              <th scope="col">Status</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {categories.data.items.map((c) => (
              <tr key={c.id}>
                <td>{c.code}</td>
                <td>{c.name}</td>
                <td>{(BASIS_TEXT[c.limitBasis] ?? c.limitBasis).replace(/^a /, '')}</td>
                <td>{c.active ? <Badge tone="good">Active</Badge> : <Badge>Inactive</Badge>}</td>
                <td>
                  <button
                    type="button"
                    className={c.active ? 'link danger' : 'link'}
                    aria-label={c.active ? `Deactivate ${c.code}` : `Reactivate ${c.code}`}
                    disabled={setActive.isPending}
                    onClick={() => setActive.mutate(c)}
                  >
                    {c.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        className="grid-form"
        aria-label="New category"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Category code
          <input required maxLength={40} pattern="[A-Za-z][A-Za-z0-9_]*" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
        </label>
        <label>
          Category name
          <input required maxLength={100} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label>
          Limit counts per
          <select required value={form.limitBasis} onChange={(e) => setForm({ ...form, limitBasis: e.target.value })}>
            <option value="">Choose</option>
            <option value="PER_DAY">Day</option>
            <option value="PER_NIGHT">Night</option>
            <option value="PER_LINE">Line</option>
          </select>
        </label>
        <button type="submit" disabled={create.isPending}>
          Add category
        </button>
      </form>
      <p className="hint">A category's code and what its limit counts per are fixed once created. It can be claimed only where the revision in force has a rule for it. Deactivating one stops new lines using it; lines and rules that already name it keep it.</p>
      <Refusal error={create.error ?? setActive.error} />
    </Section>
  );
}

export function ExpensePoliciesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canManage = can(MANAGE);
  const canActivate = can(ACTIVATE);
  const revisions = useQuery({ queryKey: ['expense-policies'], queryFn: () => api<{ items: ExpensePolicy[] }>('/v1/expense/policies') });
  // Rules carry codes; the categories (inactive ones too) and the locations give their names.
  const categories = useQuery({ queryKey: ['expense-category-maintenance'], enabled: canManage || canActivate, queryFn: () => api<{ items: Category[] }>('/v1/expense/category-maintenance') });
  const options = useQuery({ queryKey: ['expense-policy-options'], enabled: canManage || canActivate, queryFn: () => api<{ categories: CategoryOption[]; grades: Option[]; locations: Option[] }>('/v1/expense/policy-options') });
  const names: Names = {
    category: (code) => categories.data?.items.find((c) => c.code === code)?.name ?? options.data?.categories.find((c) => c.code === code)?.name ?? code,
    location: (code) => options.data?.locations.find((l) => l.code === code)?.name ?? code,
  };
  const refresh = () => void qc.invalidateQueries({ queryKey: ['expense-policies'] });
  const items = revisions.data?.items ?? [];
  return (
    <>
      <Section title="Expense policy revisions">
        <ErrorNote error={revisions.error} />
        {revisions.isSuccess && items.length === 0 && <Empty>No expense policy revisions yet.</Empty>}
        {items.length > 0 && (
          <table aria-label="Expense policy revisions">
            <thead>
              <tr>
                <th scope="col">Revision</th>
                <th scope="col">State</th>
                <th scope="col">Period</th>
                <th scope="col">Values</th>
                <th scope="col">Rules</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>{nameOf(p)}</td>
                  <td>
                    <StateBadge state={p.state} />
                  </td>
                  <td>
                    {periodText(p)}
                    {p.lastUsedOn && <div className="hint">Used by submitted claims up to {formatDate(p.lastUsedOn)}</div>}
                  </td>
                  <td>{`Submission within ${p.submissionWindowDays} days; high-value approval above ${money(p.highValueThreshold, p.currency)}`}</td>
                  <td>
                    <RuleList key={p.version} policy={p} names={names} canRemove={p.state === 'DRAFT' && canManage} onChanged={refresh} />
                    {p.warnings.map((w) => (
                      <p key={w.code} role="note">
                        <Badge tone="warn">{WARNING_BADGE[w.code] ?? w.code}</Badge> {w.text}
                      </p>
                    ))}
                  </td>
                  <td>
                    <RevisionActions key={p.version} policy={p} canManage={canManage} canActivate={canActivate} onChanged={refresh} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="hint">
          A claim line is judged by the revision in force on its expense date and the employee's grade and location on that date. An activated revision and its rules never change: a change is a new revision, and activating one ends the earlier revision of its code on the new revision's first day. A limit is a review threshold: a line over it needs a reason and the financial reviewer's decision.
        </p>
      </Section>
      {canManage && <NewRevision onChanged={refresh} />}
      {canManage && <CategoriesSection />}
      {canManage && <CurrenciesSection canActivate={canActivate} />}
      {canManage && <RatesSection canActivate={canActivate} />}
    </>
  );
}

interface ExchangeRate {
  id: string;
  currencyCode: string;
  effectiveFrom: string;
  rate: string;
  reason: string;
  state: string;
  createdBy: string;
  version: number;
}

/** I-87: dated rates to INR for enabled currencies, entered by one person and activated by another; claim lines convert once at submission. */
function RatesSection({ canActivate }: { canActivate: boolean }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const rates = useQuery({ queryKey: ['expense-rates'], queryFn: () => api<{ companyCurrency: string; items: ExchangeRate[] }>('/v1/expense/exchange-rates') });
  // A rate is entered only for a currency enabled for claims: those are the choices (the same list the section above shows).
  const currencies = useQuery({
    queryKey: ['expense-currencies'],
    queryFn: () => api<{ companyCurrency: string; reference: { code: string; minorUnit: number }[]; items: EnabledCurrency[] }>('/v1/expense/currencies'),
  });
  const enabled = (currencies.data?.items ?? []).filter((c) => c.state === 'ACTIVE').map((c) => c.currencyCode);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['expense-rates'] });
  const [currency, setCurrency] = useState('');
  const [from, setFrom] = useState('');
  const [rate, setRate] = useState('');
  const [reason, setReason] = useState('');
  const add = useMutation({
    mutationFn: () => api('/v1/expense/exchange-rates', { body: { currencyCode: currency.trim().toUpperCase(), effectiveFrom: from, rate: rate.trim(), reason: reason.trim() } }),
    onSuccess: refresh,
  });
  const decide = useMutation({
    mutationFn: (v: { r: ExchangeRate; action: 'ACTIVATE' | 'CANCEL' }) => api(`/v1/expense/exchange-rates/${encodeURIComponent(v.r.id)}/decision`, { body: { action: v.action, expectedVersion: v.r.version } }),
    onSuccess: refresh,
  });
  const ready = currency.trim().length === 3 && from && rate.trim() && reason.trim();
  return (
    <Section title="Exchange rates">
      <p className="hint">
        {`${rates.data?.companyCurrency ?? 'INR'} for one unit of an enabled currency, from a date. A claim line in that currency converts once, at submission, at the rate in force on its expense date; a later rate never changes a submitted claim.`}
      </p>
      <ErrorNote error={rates.error ?? add.error ?? decide.error} />
      {rates.data?.items.length === 0 && <Empty>No exchange rate yet.</Empty>}
      {rates.data && rates.data.items.length > 0 && (
        <ul aria-label="Exchange rates">
          {rates.data.items.map((r) => (
            <li key={r.id}>
              {`${r.currencyCode} from ${formatDate(r.effectiveFrom)}: ${r.rate} (${r.reason}) `}
              <StateBadge state={r.state} />
              {canActivate && r.state === 'DRAFT' && r.createdBy !== me?.userId && (
                <button type="button" className="secondary" onClick={() => decide.mutate({ r, action: 'ACTIVATE' })} disabled={decide.isPending}>
                  Activate
                </button>
              )}
              {canActivate && r.state === 'DRAFT' && (
                <button type="button" className="secondary" onClick={() => decide.mutate({ r, action: 'CANCEL' })} disabled={decide.isPending}>
                  Cancel
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="row"
        aria-label="Enter an exchange rate"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (ready && !add.isPending) add.mutate();
        }}
      >
        <label>
          Currency
          <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
            <option value="">{currencies.isSuccess && enabled.length === 0 ? 'None enabled yet' : 'Choose'}</option>
            {enabled.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          Rate
          <input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} />
        </label>
        <label>
          Source
          <input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <button type="submit" disabled={!ready || add.isPending}>
          Enter rate
        </button>
      </form>
    </Section>
  );
}

interface EnabledCurrency {
  id: string;
  currencyCode: string;
  state: string;
  reason: string;
  createdBy: string;
  version: number;
}

/** OQ-17 (I-80): the currencies Finance enables for claims, asked for by one person and enabled by another. */
function CurrenciesSection({ canActivate }: { canActivate: boolean }) {
  const { me } = useSession();
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['expense-currencies'],
    queryFn: () => api<{ companyCurrency: string; reference: { code: string; minorUnit: number }[]; items: EnabledCurrency[] }>('/v1/expense/currencies'),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['expense-currencies'] });
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const ask = useMutation({ mutationFn: () => api('/v1/expense/currencies', { body: { currencyCode: code, reason: reason.trim() } }), onSuccess: refresh });
  const decide = useMutation({
    mutationFn: (v: { c: EnabledCurrency; action: 'ACTIVATE' | 'RETIRE' }) => api(`/v1/expense/currencies/${encodeURIComponent(v.c.id)}/decision`, { body: { action: v.action, expectedVersion: v.c.version } }),
    onSuccess: refresh,
  });
  const others = list.data?.reference.filter((r) => r.code !== list.data?.companyCurrency) ?? [];
  return (
    <Section title="Claim currencies">
      <p className="hint">
        {`Claims are in ${list.data?.companyCurrency ?? 'the company currency'}. Another approved currency is usable once one person asks for it and another enables it; a claim in it is then refused at submission until an exchange rate converts it.`}
      </p>
      <ErrorNote error={list.error ?? ask.error ?? decide.error} />
      {list.data?.items.length === 0 && <Empty>No other currency is enabled.</Empty>}
      {list.data && list.data.items.length > 0 && (
        <ul aria-label="Claim currencies">
          {list.data.items.map((c) => (
            <li key={c.id}>
              {`${c.currencyCode}: ${c.reason} `}
              <StateBadge state={c.state} />
              {canActivate && c.state === 'DRAFT' && c.createdBy !== me?.userId && (
                <button type="button" className="secondary" onClick={() => decide.mutate({ c, action: 'ACTIVATE' })} disabled={decide.isPending}>
                  Enable
                </button>
              )}
              {canActivate && c.state === 'ACTIVE' && (
                <button type="button" className="secondary" onClick={() => decide.mutate({ c, action: 'RETIRE' })} disabled={decide.isPending}>
                  Retire
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        className="row"
        aria-label="Ask for a claim currency"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          if (code && reason.trim() && !ask.isPending) ask.mutate();
        }}
      >
        <label>
          Currency
          <select value={code} onChange={(e) => setCode(e.target.value)}>
            <option value="">Choose</option>
            {others.map((r) => (
              <option key={r.code} value={r.code}>
                {r.code}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reason
          <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </label>
        <button type="submit" disabled={!code || !reason.trim() || ask.isPending}>
          Ask to enable
        </button>
      </form>
    </Section>
  );
}

export const EXPENSE_ADMIN_SCREENS: readonly ScreenRoute[] = [{ path: '/expense/policies', title: 'Expense policies', permission: MANAGE, nav: true, component: ExpensePoliciesPage }];
