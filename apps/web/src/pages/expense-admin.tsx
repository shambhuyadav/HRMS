// Expense policies (FR-078; BR-019; DF06): revisions with their effective period, submission window, high-value threshold and
// category rules, a draft maintained by HR and activated by someone else, which ends the revision it replaces; and the
// categories. Every value comes from the person filling the form; the page proposes none. Limits are review thresholds: going
// over one flags a claim line for the financial reviewer, it does not refuse or pay it. The server re-checks every duty and
// rule; this page only offers what the role can do.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError, formatDate } from '../api';
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

const appliesTo = (r: Pick<Rule, 'grade' | 'location'>) => (r.grade || r.location ? [r.grade && `grade ${r.grade}`, r.location && `location ${r.location}`].filter(Boolean).join(', ') : 'the whole company');
const periodText = (p: ExpensePolicy) => (p.effectiveTo ? `from ${p.effectiveFrom}, until before ${p.effectiveTo}` : `from ${p.effectiveFrom}`);
const nameOf = (p: ExpensePolicy) => `${p.code} revision ${p.revision}`;
const money = (v: string, currency: string) => `${currency} ${Number(v).toFixed(2)}`;

/** Refusals of a policy change in plain words; any other is shown as the server sent it. */
function refusalText(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const details = error.details as { revisions?: { code: string; revision: number }[]; ties?: { category: string; grade: string; location: string }[]; lastUsedOn?: string } | undefined;
  if (error.code === 'POLICY_OVERLAP') {
    return `This revision's period overlaps ${(details?.revisions ?? []).map((r) => `${r.code} revision ${r.revision}`).join(', ')}, and a claim on those dates would be ambiguous. Change the dates, or retire the other revision.`;
  }
  if (error.code === 'POLICY_IN_USE') return `A submitted claim used the revision this would end for ${details?.lastUsedOn ?? 'a later date'}, so it cannot end on or before that date. Choose a later date.`;
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
            {o.code}
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
              {c.code}
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
  const remove = useMutation({ mutationFn: (ruleId: string) => api(`/v1/expense/policies/${policy.id}/rules/${ruleId}/remove`, { body: { expectedVersion: policy.version } }), onSuccess: onChanged, onError: refreshOnError });
  const activate = useMutation({ mutationFn: () => api(`/v1/expense/policies/${policy.id}/activate`, { body: { expectedVersion: policy.version } }), onSuccess: done, onError: refreshOnError });
  const retireIt = useMutation({ mutationFn: () => api(`/v1/expense/policies/${policy.id}/retire`, { body: { expectedVersion: policy.version, effectiveTo: retire.effectiveTo, reason: retire.reason.trim() } }), onSuccess: done, onError: refreshOnError });
  const name = nameOf(policy);
  const toggle = (which: 'edit' | 'rule' | 'retire') => setOpen(open === which ? null : which);
  return (
    <>
      {policy.state === 'DRAFT' && canManage && (
        <>
          <button type="button" className="link" onClick={() => toggle('edit')}>
            Edit {name}
          </button>{' '}
          <button type="button" className="link" onClick={() => toggle('rule')}>
            Add a rule to {name}
          </button>{' '}
          {policy.rules.map((r) => (
            <button key={r.id} type="button" className="link" disabled={remove.isPending} onClick={() => remove.mutate(r.id)}>
              Remove {r.category} for {appliesTo(r)}
            </button>
          ))}
        </>
      )}
      {policy.state === 'DRAFT' && canActivate && (
        <button type="button" className="link" disabled={activate.isPending} onClick={() => activate.mutate()}>
          Activate {name}
        </button>
      )}
      {policy.state === 'ACTIVE' && canActivate && (
        <button type="button" className="link" onClick={() => toggle('retire')}>
          Retire {name}
        </button>
      )}
      <Refusal error={remove.error ?? activate.error} />
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
              <th scope="col">Active</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {categories.data.items.map((c) => (
              <tr key={c.id}>
                <td>{c.code}</td>
                <td>{c.name}</td>
                <td>{(BASIS_TEXT[c.limitBasis] ?? c.limitBasis).replace(/^a /, '')}</td>
                <td>{c.active ? 'yes' : 'no'}</td>
                <td>
                  <button type="button" className="link" disabled={setActive.isPending} onClick={() => setActive.mutate(c)}>
                    {c.active ? `Deactivate ${c.code}` : `Reactivate ${c.code}`}
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
                    {p.rules.length > 0 && (
                      <ul>
                        {p.rules.map((r) => (
                          <li key={r.id}>{`${r.category} for ${appliesTo(r)}: ${money(r.limitAmount, p.currency)} ${BASIS_TEXT[r.limitBasis] ?? r.limitBasis}, receipt ${r.receiptRequired ? 'required' : 'not required'}`}</li>
                        ))}
                      </ul>
                    )}
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
    </>
  );
}

export const EXPENSE_ADMIN_SCREENS: readonly ScreenRoute[] = [{ path: '/expense/policies', title: 'Expense policies', permission: MANAGE, nav: true, component: ExpensePoliciesPage }];
