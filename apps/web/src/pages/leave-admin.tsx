// Leave administration (FR-024, FR-025; BR-010; E06): leave types, policy revisions with their effective period and
// grade, location and employment-type mappings, independent activation and retirement, the mapped-policy export, the
// employees listed before accrual and the employee leave ledger. A warning is always in words as well as colour
// (FR-024 "with text as well as colour"). Every value comes from the person filling the form: the page proposes none but
// the zero carry DF05 states. The server re-checks every duty and rule; this page only offers what the role can do.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api, ApiError, download, formatDate } from '../api';
import { isReportRefusal, reportProblem } from '../report-failures';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, LIST_PAGE_SIZE, Pager, pageParams, Section, StateBadge } from '../ui';

interface LeaveType {
  id: string;
  code: string;
  name: string;
  paid: boolean;
  active: boolean;
  version: number;
}
interface Mapping {
  id: string;
  employmentType: string | null;
  grade: string | null;
  location: string | null;
  priority: number;
}
export interface PolicyRevision {
  id: string;
  leaveType: string;
  leaveTypeName: string;
  paid: boolean;
  revision: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  eligibility: string;
  accrualRule: string;
  annualEntitlement: string;
  minServiceDays: number;
  carryCap: string;
  state: string;
  version: number;
  mappings: Mapping[];
  unmapped: boolean;
  warnings: { code: string; text: string }[];
  overlaps: { policyId: string; revision: number }[];
}
interface Option {
  id: string;
  code: string;
  name: string;
}
interface PolicyOptions {
  employmentTypes: Option[];
  grades: Option[];
  locations: Option[];
}

const MANAGE = 'leave_policy.manage.operational';
const ACTIVATE = 'leave_policy.activate.operational';

const mappingText = (m: Mapping) => [m.employmentType && `employment type ${m.employmentType}`, m.grade && `grade ${m.grade}`, m.location && `location ${m.location}`].filter(Boolean).join(', ');
const periodText = (p: Pick<PolicyRevision, 'effectiveFrom' | 'effectiveTo'>) => `${formatDate(p.effectiveFrom)} – ${p.effectiveTo ? `before ${formatDate(p.effectiveTo)}` : 'no end date'}`;
/** A filter form applies as it changes: Enter in one of its fields does not reload the page. */
export const keepOnPage = (e: FormEvent) => e.preventDefault();

/**
 * Requests a report for the shown filters and offers its download when it is ready: reports are generated in the
 * background and the download re-checks access (FR-056).
 */
export function ReportExport({ reportCode, filters, label }: { reportCode: string; filters: Record<string, unknown>; label: string }) {
  const request = useMutation({ mutationFn: () => api<{ id: string }>('/v1/reports', { body: { reportCode, filters } }) });
  const id = request.data?.id;
  const status = useQuery({
    queryKey: ['report', id],
    enabled: !!id,
    queryFn: () => api<{ state: string; rowCount: number | null; failureCode: string | null }>(`/v1/reports/${id}`),
    refetchInterval: (q) => (!isReportRefusal(q.state.error) && (q.state.data?.state === 'QUEUED' || q.state.data?.state === 'RUNNING') ? 3000 : false),
  });
  const save = useMutation({ mutationFn: () => download(`/v1/reports/${id}/download`) });
  return (
    <div className="inline">
      <button type="button" className="secondary" disabled={request.isPending} onClick={() => request.mutate()}>
        {label}
      </button>
      {status.data && <StateBadge state={status.data.state} />}
      {status.data?.state === 'COMPLETED' && (
        <button type="button" className="link" onClick={() => save.mutate()}>
          Download{status.data.rowCount !== null ? ` (${status.data.rowCount} rows)` : ''}
        </button>
      )}
      {status.data && reportProblem(status.data) && <span className="hint">{reportProblem(status.data)}</span>}
      <ErrorNote error={request.error ?? status.error ?? save.error} />
    </div>
  );
}

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
            <th />
          </tr>
        </thead>
        <tbody>
          {types.data?.items.map((t) => (
            <tr key={t.id}>
              <td>{t.code}</td>
              <td>{t.name}</td>
              <td>{t.paid ? 'Paid' : 'Unpaid'}</td>
              <td>{t.active ? 'Active' : 'Inactive'}</td>
              <td>
                {canManage && (
                  <button type="button" className="link" onClick={() => toggle.mutate(t)}>
                    {t.active ? `Deactivate ${t.code}` : `Reactivate ${t.code}`}
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
}
const blankDraft: DraftValues = { effectiveFrom: '', effectiveTo: '', eligibility: '', accrualRule: 'NONE', annualEntitlement: '', minServiceDays: '', carryCap: '0' };

/** The API's body of a draft: every value as entered; an empty end means no end. */
const draftBody = (v: DraftValues) => ({
  effectiveFrom: v.effectiveFrom,
  effectiveTo: v.effectiveTo || null,
  eligibility: v.eligibility.trim().toUpperCase(),
  accrualRule: v.accrualRule,
  annualEntitlement: v.annualEntitlement,
  minServiceDays: Number(v.minServiceDays),
  carryCap: v.carryCap,
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
          <option value="MONTHLY_PRORATED">Monthly, prorated (DF05)</option>
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
                  {t.code}
                </option>
              ))}
          </select>
        </label>
        <DraftFields values={values} onChange={setValues} />
        <button type="submit" disabled={create.isPending || !chosen}>
          Create draft
        </button>
      </form>
      <p className="hint">The revision stays a draft until someone other than its author activates it. Policy values need the owner’s approval before activation (FR-024).</p>
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
            {o.code}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <form
      className="grid-form"
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
  });
  const [closePredecessors, setClosePredecessors] = useState(false);
  const [retire, setRetire] = useState({ effectiveTo: '', reason: '' });
  const done = () => {
    setOpen(null);
    onChanged();
  };
  const edit = useMutation({ mutationFn: () => api(`/v1/leave/policies/${policy.id}`, { method: 'PATCH', body: { expectedVersion: policy.version, ...draftBody(values) } }), onSuccess: done });
  const remove = useMutation({ mutationFn: (mappingId: string) => api(`/v1/leave/policies/${policy.id}/mappings/${mappingId}/remove`, { body: { expectedVersion: policy.version } }), onSuccess: onChanged });
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
          <button type="button" className="link" onClick={() => setOpen(open === 'edit' ? null : 'edit')}>
            Edit {name}
          </button>{' '}
          <button type="button" className="link" onClick={() => setOpen(open === 'map' ? null : 'map')}>
            Map {name}
          </button>{' '}
          {policy.mappings.map((m) => (
            <button key={m.id} type="button" className="link" onClick={() => remove.mutate(m.id)}>
              Remove {mappingText(m)}
            </button>
          ))}
        </>
      )}
      {policy.state === 'DRAFT' && canActivate && (
        <button type="button" className="link" onClick={() => setOpen(open === 'activate' ? null : 'activate')}>
          Activate {name}
        </button>
      )}
      {policy.state === 'ACTIVE' && canActivate && (
        <button type="button" className="link" onClick={() => setOpen(open === 'retire' ? null : 'retire')}>
          Retire {name}
        </button>
      )}
      <ErrorNote error={remove.error} />
      {open === 'edit' && (
        <form
          className="grid-form"
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

function LeavePoliciesPage() {
  const { can } = useSession();
  const qc = useQueryClient();
  const canManage = can(MANAGE);
  const canActivate = can(ACTIVATE);
  const [filters, setFilters] = useState({ leaveType: '', effectiveFrom: '', state: '' });
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '')).toString();
  const types = useQuery({ queryKey: ['leave-types'], queryFn: () => api<{ items: LeaveType[] }>('/v1/leave/types') });
  const revisions = useQuery({ queryKey: ['leave-policies', query], queryFn: () => api<{ items: PolicyRevision[] }>(`/v1/leave/policies${query ? `?${query}` : ''}`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['leave-policies'] });
  const items = revisions.data?.items ?? [];
  const unmapped = items.filter((p) => p.unmapped).length;
  return (
    <>
      <LeaveTypes canManage={canManage} />
      <Section title="Policy revisions">
        <form className="grid-form" onSubmit={keepOnPage}>
          <label>
            Leave type
            <select value={filters.leaveType} onChange={(e) => setFilters({ ...filters, leaveType: e.target.value })}>
              <option value="">All</option>
              {types.data?.items.map((t) => (
                <option key={t.id} value={t.code}>
                  {t.code}
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
                <th />
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
                    {`${p.accrualRule === 'NONE' ? 'No accrual' : 'Monthly accrual'}, ${Number(p.annualEntitlement)} days a year, ${p.minServiceDays} days of service, carry cap ${Number(p.carryCap)}`} <span className="hint">({p.eligibility})</span>
                  </td>
                  <td>
                    {p.mappings.length > 0 && <ul>{p.mappings.map((m) => <li key={m.id}>{mappingText(m)}</li>)}</ul>}
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

// ---------------------------------------------------------------------------------------------------------
// Before accrual
// ---------------------------------------------------------------------------------------------------------

interface WithoutPolicy {
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  employmentType: string | null;
  asOf: string;
  unresolved: { leaveType: string; reason: string }[];
  mappedLeaveTypes: string[];
}

const UNRESOLVED_TEXT: Record<string, string> = {
  POLICY_NOT_FOUND: 'no policy applies, so the run credits nothing for this type',
  POLICY_AMBIGUOUS: 'two policies tie, so the run stops on this employee',
};

function BeforeAccrualPage() {
  const [month, setMonth] = useState('');
  const [page, setPage] = useState(1);
  const list = useQuery({
    queryKey: ['leave-without-policy', month, page],
    enabled: /^\d{4}-\d{2}$/.test(month),
    queryFn: () => api<{ items: WithoutPolicy[]; total: number; page: number; pageSize: number }>(`/v1/leave/accruals/employees-without-policy?month=${month}&${pageParams(page)}`),
  });
  return (
    <Section title="Employees without a policy, before accrual">
      <form className="grid-form" onSubmit={keepOnPage}>
        <label>
          Accrual month
          <input
            type="month"
            value={month}
            onChange={(e) => {
              setMonth(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </form>
      <p className="hint">Employees the month’s accrual would cover, in your scope, for whom a paid leave type resolves to no policy or to a tie. A group with no paid type by policy (for example contractors) appears here too: check it is meant.</p>
      <ErrorNote error={list.error} />
      {list.isSuccess && list.data.total === 0 && <Empty>Every employee in your scope resolves to one policy for every paid leave type.</Empty>}
      {list.isSuccess && list.data.items.length > 0 && (
        <>
          <p role="status">{`${list.data.total} ${list.data.total === 1 ? 'employee needs' : 'employees need'} a look`}</p>
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Employee</th>
                <th>Employment type</th>
                <th>Paid types not resolved</th>
                <th>Types that resolve</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((e) => (
                <tr key={e.employeeId}>
                  <td>{e.employeeCode}</td>
                  <td>{e.employeeName}</td>
                  <td>{e.employmentType ?? '—'}</td>
                  <td>
                    <ul>
                      {e.unresolved.map((u) => (
                        <li key={u.leaveType}>{`${u.leaveType}: ${UNRESOLVED_TEXT[u.reason] ?? u.reason}`}</li>
                      ))}
                    </ul>
                  </td>
                  <td>{e.mappedLeaveTypes.join(', ') || 'none'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={list.data.page} pageSize={LIST_PAGE_SIZE} total={list.data.total} onPage={setPage} label="Employees without a policy pages" noun="employee" />
        </>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Employee leave ledger
// ---------------------------------------------------------------------------------------------------------

interface Ledger {
  items: {
    leaveType: string;
    paid: boolean;
    opening: string;
    credits: string;
    debits: string;
    closing: string;
    movements: { id: string; kind: string; units: string; effectiveDate: string; requestId: string | null; actorUserId: string | null; reason?: string | null }[];
  }[];
}

const MOVEMENT_TEXT: Record<string, string> = {
  OPENING: 'Opening balance',
  ACCRUAL: 'Accrual',
  ADJUSTMENT: 'Adjustment',
  EXPIRY: 'Expiry',
  RESERVATION: 'Reserved by a request',
  RESERVATION_RELEASE: 'Reservation released',
  CONSUMPTION: 'Taken on approval',
  REVERSAL: 'Returned by a cancellation',
};

const days = (value: string) => Number(value).toFixed(2);

function LeaveLedgerPage() {
  const { me } = useSession();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState('');
  const [period, setPeriod] = useState({ from: '', to: '' });
  const employees = useQuery({
    queryKey: ['ledger-employees', search],
    enabled: search.trim().length >= 2,
    queryFn: () => api<{ items: { id: string; employeeCode: string; displayName: string }[] }>(`/v1/employees?search=${encodeURIComponent(search.trim())}&pageSize=25`),
  });
  const employeeId = picked || me?.employeeId || '';
  const ledger = useQuery({
    queryKey: ['leave-ledger', employeeId, period],
    enabled: !!employeeId && !!period.from && !!period.to,
    queryFn: () => api<Ledger>(`/v1/employees/${employeeId}/leave-ledger?from=${period.from}&to=${period.to}`),
  });
  return (
    <Section title="Employee leave ledger">
      <form className="grid-form" onSubmit={keepOnPage}>
        <label>
          Find an employee (code or name)
          <input value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} />
        </label>
        <label>
          Employee
          <select value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">{me?.employeeId ? 'Myself' : 'Choose'}</option>
            {employees.data?.items.map((e) => (
              <option key={e.id} value={e.id}>
                {`${e.employeeCode} ${e.displayName}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input type="date" required value={period.from} onChange={(e) => setPeriod({ ...period, from: e.target.value })} />
        </label>
        <label>
          To
          <input type="date" required value={period.to} onChange={(e) => setPeriod({ ...period, to: e.target.value })} />
        </label>
      </form>
      <ErrorNote error={employees.error ?? ledger.error} />
      {ledger.data?.items.length === 0 && <Empty>No leave types to show.</Empty>}
      {ledger.data?.items.map((t) => (
        <section key={t.leaveType} aria-label={`${t.leaveType} ledger`}>
          <h3>{`${t.leaveType}${t.paid ? '' : ' (unpaid)'}`}</h3>
          <p>{`Opening ${days(t.opening)} + credits ${days(t.credits)} − debits ${days(t.debits)} = closing ${days(t.closing)}`}</p>
          {t.movements.length === 0 ? (
            <Empty>No movements in this period.</Empty>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Movement</th>
                  <th>Days</th>
                  <th>Linked request</th>
                  <th>Note</th>
                </tr>
              </thead>
              <tbody>
                {t.movements.map((m) => (
                  <tr key={m.id}>
                    <td>{formatDate(m.effectiveDate)}</td>
                    <td>{MOVEMENT_TEXT[m.kind] ?? m.kind}</td>
                    <td>{days(m.units)}</td>
                    <td>{m.requestId ? 'Yes' : '—'}</td>
                    <td>{m.reason ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}
    </Section>
  );
}

export const LEAVE_ADMIN_SCREENS: readonly ScreenRoute[] = [
  { path: '/leave/policies', title: 'Leave policies', permission: MANAGE, nav: true, component: LeavePoliciesPage },
  { path: '/leave/before-accrual', title: 'Before leave accrual', permission: 'leave.accrue.operational', nav: true, component: BeforeAccrualPage },
  { path: '/leave/ledger', title: 'Leave ledger', permission: 'leave.adjust.operational', nav: true, component: LeaveLedgerPage },
];
