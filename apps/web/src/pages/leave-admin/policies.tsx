// Leave policies: leave types, policy revisions with their mappings, and the policies page.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Section, StateBadge } from '../../ui';
import { ACTIVATE, codeWords, eligibilityWords, keepOnPage, type LeaveType, MANAGE, mappingText, mappingWords, type Option, periodText, type PolicyOptions, type PolicyRevision, ReportExport } from './shared';

// ---------------------------------------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------------------------------------

function LeaveTypes({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['leave-types'] });
    void qc.invalidateQueries({ queryKey: ['leave-policies'] });
  };
  const types = useQuery({ queryKey: ['leave-types'], queryFn: () => api<{ items: LeaveType[] }>('/v1/leave/types') });
  const [form, setForm] = useState({ code: '', name: '', paid: false });
  const create = useMutation({
    mutationFn: () => api('/v1/leave/types', { body: { code: form.code.trim().toUpperCase(), name: form.name.trim(), paid: form.paid } }),
    onSuccess: () => {
      setForm({ code: '', name: '', paid: false });
      refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (t: LeaveType) => api(`/v1/leave/types/${t.id}`, { method: 'PATCH', body: { expectedVersion: t.version, active: !t.active } }),
    onSuccess: refresh,
  });
  return (
    <Section title="Leave types">
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Name</th>
            <th>Pay</th>
            <th>Status</th>
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {types.data?.items.map((t) => (
            <tr key={t.id}>
              <td>{t.code}</td>
              <td>{t.name}</td>
              <td>{t.paid ? 'Paid' : 'Unpaid'}</td>
              <td>{t.active ? <Badge tone="good">Active</Badge> : <Badge>Inactive</Badge>}</td>
              <td>
                {canManage && (
                  <button type="button" className={t.active ? 'link danger' : 'link'} aria-label={t.active ? `Deactivate ${t.code}` : `Reactivate ${t.code}`} onClick={() => toggle.mutate(t)}>
                    {t.active ? 'Deactivate' : 'Reactivate'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ErrorNote error={types.error ?? toggle.error} />
      {canManage && (
        <form
          className="grid-form"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label>
            New type code
            <input required maxLength={40} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </label>
          <label>
            New type name
            <input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="check">
            <input type="checkbox" checked={form.paid} onChange={(e) => setForm({ ...form, paid: e.target.checked })} /> Paid (fixed once created)
          </label>
          <button type="submit" disabled={create.isPending}>
            Add leave type
          </button>
          <ErrorNote error={create.error} />
        </form>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Revisions
// ---------------------------------------------------------------------------------------------------------

interface DraftValues {
  effectiveFrom: string;
  effectiveTo: string;
  eligibility: string;
  accrualRule: string;
  annualEntitlement: string;
  minServiceDays: string;
  carryCap: string;
  /** '' when not set. */
  leaveYearStartMonth: string;
}
const blankDraft: DraftValues = { effectiveFrom: '', effectiveTo: '', eligibility: '', accrualRule: 'NONE', annualEntitlement: '', minServiceDays: '', carryCap: '0', leaveYearStartMonth: '' };

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const leaveYearText = (month: number | null | undefined) => (month ? `leave year from ${MONTHS[month - 1]}` : 'no leave year set, so nothing expires');

/** The API's body of a draft: every value as entered; an empty end means no end, an empty leave year none. */
const draftBody = (v: DraftValues) => ({
  effectiveFrom: v.effectiveFrom,
  effectiveTo: v.effectiveTo || null,
  eligibility: v.eligibility.trim().toUpperCase(),
  accrualRule: v.accrualRule,
  annualEntitlement: v.annualEntitlement,
  minServiceDays: Number(v.minServiceDays),
  carryCap: v.carryCap,
  leaveYearStartMonth: v.leaveYearStartMonth ? Number(v.leaveYearStartMonth) : null,
});

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
        Eligibility code
        <input required maxLength={60} {...field('eligibility')} />
      </label>
      <label>
        Accrual rule
        <select {...field('accrualRule')}>
          <option value="NONE">No accrual</option>
          <option value="MONTHLY_PRORATED">Monthly, prorated</option>
        </select>
      </label>
      <label>
        Annual entitlement (days)
        <input required inputMode="decimal" pattern="\d{1,8}(\.\d{1,4})?" {...field('annualEntitlement')} />
      </label>
      <label>
        Minimum service (days)
        <input required inputMode="numeric" pattern="\d{1,6}" {...field('minServiceDays')} />
      </label>
      <label>
        Carry cap (days)
        <input required inputMode="decimal" pattern="\d{1,8}(\.\d{1,4})?" {...field('carryCap')} />
      </label>
      <label>
        Leave year starts in
        <select {...field('leaveYearStartMonth')}>
          <option value="">Not set (nothing expires)</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={String(i + 1)}>
              {m}
            </option>
          ))}
        </select>
      </label>
    </>
  );
}

function NewRevision({ types }: { types: LeaveType[] }) {
  const qc = useQueryClient();
  const [leaveType, setLeaveType] = useState('');
  const [values, setValues] = useState(blankDraft);
  const chosen = leaveType || types.find((t) => t.active)?.code || '';
  const create = useMutation({
    mutationFn: () => api('/v1/leave/policies', { body: { leaveType: chosen, ...draftBody(values) } }),
    onSuccess: () => {
      setValues(blankDraft);
      void qc.invalidateQueries({ queryKey: ['leave-policies'] });
    },
  });
  return (
    <Section title="New policy revision">
      <form
        className="grid-form"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <label>
          Leave type
          <select value={chosen} onChange={(e) => setLeaveType(e.target.value)}>
            {types
              .filter((t) => t.active)
              .map((t) => (
                <option key={t.id} value={t.code}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
        <DraftFields values={values} onChange={setValues} />
        <button type="submit" disabled={create.isPending || !chosen}>
          Create draft
        </button>
      </form>
      <p className="hint">The revision stays a draft until someone other than its author activates it. Policy values need the owner’s approval before activation.</p>
      <ErrorNote error={create.error} />
    </Section>
  );
}

function AddMapping({ policy, onDone }: { policy: PolicyRevision; onDone: () => void }) {
  const options = useQuery({ queryKey: ['leave-policy-options'], queryFn: () => api<PolicyOptions>('/v1/leave/policy-options') });
  const [choice, setChoice] = useState({ employmentTypeId: '', gradeId: '', locationId: '' });
  const add = useMutation({
    mutationFn: () =>
      api(`/v1/leave/policies/${policy.id}/mappings`, {
        body: {
          expectedVersion: policy.version,
          ...(choice.employmentTypeId ? { employmentTypeId: choice.employmentTypeId } : {}),
          ...(choice.gradeId ? { gradeId: choice.gradeId } : {}),
          ...(choice.locationId ? { locationId: choice.locationId } : {}),
        },
      }),
    onSuccess: () => {
      setChoice({ employmentTypeId: '', gradeId: '', locationId: '' });
      onDone();
    },
  });
  const select = (label: string, key: keyof typeof choice, items: Option[] | undefined) => (
    <label>
      {label}
      <select value={choice[key]} onChange={(e) => setChoice({ ...choice, [key]: e.target.value })}>
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
      aria-label={`Map ${policy.leaveType} revision ${policy.revision}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      {select('Employment type', 'employmentTypeId', options.data?.employmentTypes)}
      {select('Grade', 'gradeId', options.data?.grades)}
      {select('Location', 'locationId', options.data?.locations)}
      <button type="submit" disabled={add.isPending}>
        Add mapping
      </button>
      <ErrorNote error={options.error ?? add.error} />
    </form>
  );
}

/** A refused activation that overlaps: which revisions, in words, with the choice of ending an earlier one. */
function overlapText(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'POLICY_OVERLAP') return null;
  const revisions = (error.details as { revisions?: { revision: number }[] } | undefined)?.revisions ?? [];
  return `This revision ties with revision ${revisions.map((r) => r.revision).join(', ')} for the same employees in an overlapping period. Change the mappings or the dates, or end an earlier revision when this one starts.`;
}

function RevisionActions({ policy, canManage, canActivate, onChanged }: { policy: PolicyRevision; canManage: boolean; canActivate: boolean; onChanged: () => void }) {
  const [open, setOpen] = useState<'edit' | 'map' | 'activate' | 'retire' | null>(null);
  const [values, setValues] = useState<DraftValues>({
    effectiveFrom: String(policy.effectiveFrom).slice(0, 10),
    effectiveTo: policy.effectiveTo ? String(policy.effectiveTo).slice(0, 10) : '',
    eligibility: policy.eligibility,
    accrualRule: policy.accrualRule,
    annualEntitlement: policy.annualEntitlement,
    minServiceDays: String(policy.minServiceDays),
    carryCap: policy.carryCap,
    leaveYearStartMonth: policy.leaveYearStartMonth ? String(policy.leaveYearStartMonth) : '',
  });
  const [closePredecessors, setClosePredecessors] = useState(false);
  const [retire, setRetire] = useState({ effectiveTo: '', reason: '' });
  const done = () => {
    setOpen(null);
    onChanged();
  };
  const edit = useMutation({ mutationFn: () => api(`/v1/leave/policies/${policy.id}`, { method: 'PATCH', body: { expectedVersion: policy.version, ...draftBody(values) } }), onSuccess: done });
  const activate = useMutation({
    mutationFn: () => api(`/v1/leave/policies/${policy.id}/activate`, { body: { expectedVersion: policy.version, ...(closePredecessors ? { closePredecessors } : {}) } }),
    onSuccess: done,
  });
  const retireIt = useMutation({ mutationFn: () => api(`/v1/leave/policies/${policy.id}/retire`, { body: { expectedVersion: policy.version, effectiveTo: retire.effectiveTo, reason: retire.reason.trim() } }), onSuccess: done });
  const name = `${policy.leaveType} revision ${policy.revision}`;
  const overlap = overlapText(activate.error);
  return (
    <>
      {policy.state === 'DRAFT' && canManage && (
        <>
          <button type="button" className="link" aria-label={`Edit ${name}`} aria-expanded={open === 'edit'} onClick={() => setOpen(open === 'edit' ? null : 'edit')}>
            Edit
          </button>{' '}
          <button type="button" className="link" aria-label={`Map ${name}`} aria-expanded={open === 'map'} onClick={() => setOpen(open === 'map' ? null : 'map')}>
            Map
          </button>{' '}
        </>
      )}
      {policy.state === 'DRAFT' && canActivate && (
        <button type="button" className="link" aria-label={`Activate ${name}`} aria-expanded={open === 'activate'} onClick={() => setOpen(open === 'activate' ? null : 'activate')}>
          Activate
        </button>
      )}
      {policy.state === 'ACTIVE' && canActivate && (
        <button type="button" className="link danger" aria-label={`Retire ${name}`} aria-expanded={open === 'retire'} onClick={() => setOpen(open === 'retire' ? null : 'retire')}>
          Retire
        </button>
      )}
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
          <ErrorNote error={edit.error} />
        </form>
      )}
      {open === 'map' && <AddMapping policy={policy} onDone={done} />}
      {open === 'activate' && (
        <form
          className="stack"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            activate.mutate();
          }}
        >
          <label className="check">
            <input type="checkbox" checked={closePredecessors} onChange={(e) => setClosePredecessors(e.target.checked)} /> End an earlier overlapping revision when this one starts
          </label>
          <button type="submit" disabled={activate.isPending}>
            Confirm activation
          </button>
          {overlap ? (
            <p role="alert" className="error">
              {overlap}
            </p>
          ) : (
            <ErrorNote error={activate.error} />
          )}
        </form>
      )}
      {open === 'retire' && (
        <form
          className="grid-form"
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
          <ErrorNote error={retireIt.error} />
        </form>
      )}
    </>
  );
}

/** A revision's mappings in words; on a draft its maintainer can take one out from beside it. */
function MappingList({ policy, options, canRemove, onChanged }: { policy: PolicyRevision; options: PolicyOptions | undefined; canRemove: boolean; onChanged: () => void }) {
  const remove = useMutation({ mutationFn: (mappingId: string) => api(`/v1/leave/policies/${policy.id}/mappings/${mappingId}/remove`, { body: { expectedVersion: policy.version } }), onSuccess: onChanged });
  if (policy.mappings.length === 0) return null;
  return (
    <>
      <ul>
        {policy.mappings.map((m) => (
          <li key={m.id}>
            {mappingWords(m, options)}
            {canRemove && (
              <>
                {' '}
                <button type="button" className="link" aria-label={`Remove ${mappingText(m)}`} disabled={remove.isPending} onClick={() => remove.mutate(m.id)}>
                  Remove
                </button>
              </>
            )}
          </li>
        ))}
      </ul>
      <ErrorNote error={remove.error} />
    </>
  );
}

export function LeavePoliciesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canManage = can(MANAGE);
  const canActivate = can(ACTIVATE);
  const [filters, setFilters] = useState({ leaveType: '', effectiveFrom: '', state: '' });
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '')).toString();
  const types = useQuery({ queryKey: ['leave-types'], queryFn: () => api<{ items: LeaveType[] }>('/v1/leave/types') });
  const revisions = useQuery({ queryKey: ['leave-policies', query], queryFn: () => api<{ items: PolicyRevision[] }>(`/v1/leave/policies${query ? `?${query}` : ''}`) });
  // Mappings and eligibility carry codes; the mapping form's choices give their names.
  const options = useQuery({ queryKey: ['leave-policy-options'], enabled: canManage || canActivate, queryFn: () => api<PolicyOptions>('/v1/leave/policy-options') });
  const eligibleTypes = (p: PolicyRevision): Option[] => [
    ...(options.data?.employmentTypes ?? []),
    ...p.mappings.flatMap((m) => (m.employmentType ? [{ id: m.id, code: m.employmentType, name: codeWords(m.employmentType) }] : [])),
  ];
  const refresh = () => void qc.invalidateQueries({ queryKey: ['leave-policies'] });
  const items = revisions.data?.items ?? [];
  const unmapped = items.filter((p) => p.unmapped).length;
  return (
    <>
      <LeaveTypes canManage={canManage} />
      <Section title="Policy revisions">
        <form className="grid-form filter-bar" onSubmit={keepOnPage}>
          <label>
            Leave type
            <select value={filters.leaveType} onChange={(e) => setFilters({ ...filters, leaveType: e.target.value })}>
              <option value="">All</option>
              {types.data?.items.map((t) => (
                <option key={t.id} value={t.code}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Effective from, on or after
            <input type="date" value={filters.effectiveFrom} onChange={(e) => setFilters({ ...filters, effectiveFrom: e.target.value })} />
          </label>
          <label>
            State
            <select value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value })}>
              <option value="">All</option>
              <option value="DRAFT">Draft</option>
              <option value="ACTIVE">Active</option>
              <option value="RETIRED">Retired</option>
            </select>
          </label>
        </form>
        <ErrorNote error={revisions.error} />
        {revisions.isSuccess && items.length === 0 && <Empty>No policy revisions match.</Empty>}
        {unmapped > 0 && (
          <p role="note">
            <Badge tone="warn">unmapped</Badge> {unmapped === 1 ? 'One revision has' : `${unmapped} revisions have`} no mapping, so {unmapped === 1 ? 'it applies' : 'they apply'} to nobody.
          </p>
        )}
        {items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Revision</th>
                <th>State</th>
                <th>Period</th>
                <th>Values</th>
                <th>Mapped to</th>
                <th scope="col"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <tr key={p.id}>
                  <td>{`${p.leaveType} revision ${p.revision}`}</td>
                  <td>
                    <StateBadge state={p.state} />
                  </td>
                  <td>{periodText(p)}</td>
                  <td>
                    {`${p.accrualRule === 'NONE' ? 'No accrual' : 'Monthly accrual'}, ${Number(p.annualEntitlement)} days a year, ${p.minServiceDays} days of service, carry cap ${Number(p.carryCap)}, ${leaveYearText(p.leaveYearStartMonth)}`}{' '}
                    <span className="hint">(eligible: {eligibilityWords(p.eligibility, eligibleTypes(p))})</span>
                  </td>
                  <td>
                    <MappingList key={p.version} policy={p} options={options.data} canRemove={p.state === 'DRAFT' && canManage} onChanged={refresh} />
                    {p.warnings.map((w) => (
                      <p key={w.code} role="note">
                        <Badge tone="warn">{w.code === 'UNMAPPED' ? 'unmapped' : 'overlap'}</Badge> {w.text}
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
        {can('leave_policy.export.operational') && (
          <ReportExport
            reportCode="LEAVE_POLICY_MAPPING"
            label="Export mapped policies"
            filters={{ ...(filters.leaveType ? { leaveType: filters.leaveType } : {}), ...(filters.effectiveFrom ? { from: filters.effectiveFrom } : {}), ...(filters.state ? { status: filters.state } : {}) }}
          />
        )}
        <p className="hint">When two revisions apply, the mapping naming more of grade, location and employment type wins; two revisions tying for the same employees in the same period cannot both be active.</p>
      </Section>
      {canManage && types.data && <NewRevision types={types.data.items} />}
    </>
  );
}
