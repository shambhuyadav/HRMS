// Leave policies: leave types, policy revisions with their mappings, and the policies page.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { CheckField, FilterBar, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { RowActions, RowActionsCell } from '@/components/row-actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError } from '../../api';
import { useSession } from '../../session';
import { Badge, Empty, ErrorNote, Notice, Section, StateBadge, WarningNote } from '../../ui';
import {
  ACTIVATE,
  codeWords,
  eligibilityWords,
  keepOnPage,
  type LeaveType,
  MANAGE,
  mappingText,
  mappingWords,
  type Option,
  periodText,
  type PolicyOptions,
  type PolicyRevision,
  ReportExport,
} from './shared';

/** A form opened from a row's actions, below the row's buttons. */
const ROW_FORM = 'mt-3';

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
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Code</TableHead>
            <TableHead scope="col">Name</TableHead>
            <TableHead scope="col">Pay</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {types.data?.items.map((t) => (
            <TableRow key={t.id}>
              <TableCell>{t.code}</TableCell>
              <TableCell>{t.name}</TableCell>
              <TableCell>{t.paid ? 'Paid' : 'Unpaid'}</TableCell>
              <TableCell>{t.active ? <Badge tone="good">Active</Badge> : <Badge>Inactive</Badge>}</TableCell>
              <RowActionsCell>
                {canManage && (
                  <RowActions>
                    <Button
                      type="button"
                      variant={t.active ? 'danger' : 'outline'}
                      size="sm"
                      aria-label={t.active ? `Deactivate ${t.code}` : `Reactivate ${t.code}`}
                      onClick={() => toggle.mutate(t)}
                    >
                      {t.active ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </RowActions>
                )}
              </RowActionsCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ErrorNote error={types.error ?? toggle.error} />
      {canManage && (
        <FormGrid
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <FormField>
            New type code
            <Input required maxLength={40} value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </FormField>
          <FormField>
            New type name
            <Input required maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </FormField>
          <CheckField>
            <input type="checkbox" checked={form.paid} onChange={(e) => setForm({ ...form, paid: e.target.checked })} /> Paid (fixed once created)
          </CheckField>
          <Button type="submit" disabled={create.isPending}>
            Add leave type
          </Button>
          <ErrorNote error={create.error} />
        </FormGrid>
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
      <FormField>
        Effective from
        <Input type="date" required {...field('effectiveFrom')} />
      </FormField>
      <FormField>
        Effective until (exclusive, optional)
        <Input type="date" {...field('effectiveTo')} />
      </FormField>
      <FormField>
        Eligibility code
        <Input required maxLength={60} {...field('eligibility')} />
      </FormField>
      <FormField>
        Accrual rule
        <NativeSelect {...field('accrualRule')}>
          <option value="NONE">No accrual</option>
          <option value="MONTHLY_PRORATED">Monthly, prorated</option>
        </NativeSelect>
      </FormField>
      <FormField>
        Annual entitlement (days)
        <Input required inputMode="decimal" pattern="\d{1,8}(\.\d{1,4})?" {...field('annualEntitlement')} />
      </FormField>
      <FormField>
        Minimum service (days)
        <Input required inputMode="numeric" pattern="\d{1,6}" {...field('minServiceDays')} />
      </FormField>
      <FormField>
        Carry cap (days)
        <Input required inputMode="decimal" pattern="\d{1,8}(\.\d{1,4})?" {...field('carryCap')} />
      </FormField>
      <FormField>
        Leave year starts in
        <NativeSelect {...field('leaveYearStartMonth')}>
          <option value="">Not set (nothing expires)</option>
          {MONTHS.map((m, i) => (
            <option key={m} value={String(i + 1)}>
              {m}
            </option>
          ))}
        </NativeSelect>
      </FormField>
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
      <FormGrid
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormField>
          Leave type
          <NativeSelect value={chosen} onChange={(e) => setLeaveType(e.target.value)}>
            {types
              .filter((t) => t.active)
              .map((t) => (
                <option key={t.id} value={t.code}>
                  {t.name}
                </option>
              ))}
          </NativeSelect>
        </FormField>
        <DraftFields values={values} onChange={setValues} />
        <Button type="submit" disabled={create.isPending || !chosen}>
          Create draft
        </Button>
      </FormGrid>
      <Hint>The revision stays a draft until someone other than its author activates it. Policy values need the owner’s approval before activation.</Hint>
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
    <FormField>
      {label}
      <NativeSelect value={choice[key]} onChange={(e) => setChoice({ ...choice, [key]: e.target.value })}>
        <option value="">Any</option>
        {items?.map((o) => (
          <option key={o.id} value={o.id}>
            {key === 'gradeId' ? `${o.name} (${o.code})` : o.name}
          </option>
        ))}
      </NativeSelect>
    </FormField>
  );
  return (
    <FormGrid
      className={ROW_FORM}
      aria-label={`Map ${policy.leaveType} revision ${policy.revision}`}
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        add.mutate();
      }}
    >
      {select('Employment type', 'employmentTypeId', options.data?.employmentTypes)}
      {select('Grade', 'gradeId', options.data?.grades)}
      {select('Location', 'locationId', options.data?.locations)}
      <Button type="submit" disabled={add.isPending}>
        Add mapping
      </Button>
      <ErrorNote error={options.error ?? add.error} />
    </FormGrid>
  );
}

/** A refused activation that overlaps: which revisions, in words, with the choice of ending an earlier one. */
function overlapText(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== 'POLICY_OVERLAP') return null;
  const revisions = (error.details as { revisions?: { revision: number }[] } | undefined)?.revisions ?? [];
  return `This revision ties with revision ${revisions.map((r) => r.revision).join(', ')} for the same employees in an overlapping period. Change the mappings or the dates, or end an earlier revision when this one starts.`;
}

/** A revision's actions, as its row's last cell: the buttons, and below them the form one of them opened. */
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
    <RowActionsCell expanded={open !== null}>
      <RowActions>
        {policy.state === 'DRAFT' && canManage && (
          <>
            <Button type="button" variant="outline" size="sm" aria-label={`Edit ${name}`} aria-expanded={open === 'edit'} onClick={() => setOpen(open === 'edit' ? null : 'edit')}>
              Edit
            </Button>{' '}
            <Button type="button" variant="outline" size="sm" aria-label={`Map ${name}`} aria-expanded={open === 'map'} onClick={() => setOpen(open === 'map' ? null : 'map')}>
              Map
            </Button>{' '}
          </>
        )}
        {policy.state === 'DRAFT' && canActivate && (
          <Button type="button" variant="outline" size="sm" aria-label={`Activate ${name}`} aria-expanded={open === 'activate'} onClick={() => setOpen(open === 'activate' ? null : 'activate')}>
            Activate
          </Button>
        )}
        {policy.state === 'ACTIVE' && canActivate && (
          <Button type="button" variant="danger" size="sm" aria-label={`Retire ${name}`} aria-expanded={open === 'retire'} onClick={() => setOpen(open === 'retire' ? null : 'retire')}>
            Retire
          </Button>
        )}
      </RowActions>
      {open === 'edit' && (
        <FormGrid
          className={ROW_FORM}
          aria-label={`Edit ${name}`}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            edit.mutate();
          }}
        >
          <DraftFields values={values} onChange={setValues} />
          <Button type="submit" disabled={edit.isPending}>
            Save draft
          </Button>
          <ErrorNote error={edit.error} />
        </FormGrid>
      )}
      {open === 'map' && <AddMapping policy={policy} onDone={done} />}
      {open === 'activate' && (
        <form
          className="mt-3 flex flex-col items-start gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            activate.mutate();
          }}
        >
          <CheckField>
            <input type="checkbox" checked={closePredecessors} onChange={(e) => setClosePredecessors(e.target.checked)} /> End an earlier overlapping revision when this one starts
          </CheckField>
          <Button type="submit" disabled={activate.isPending}>
            Confirm activation
          </Button>
          {overlap ? <Notice notice={{ text: overlap, ok: false }} /> : <ErrorNote error={activate.error} />}
        </form>
      )}
      {open === 'retire' && (
        <FormGrid
          className={ROW_FORM}
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            retireIt.mutate();
          }}
        >
          <FormField>
            No longer applies from
            <Input type="date" required value={retire.effectiveTo} onChange={(e) => setRetire({ ...retire, effectiveTo: e.target.value })} />
          </FormField>
          <FormField className="col-span-full">
            Reason for retiring
            <Input required maxLength={500} value={retire.reason} onChange={(e) => setRetire({ ...retire, reason: e.target.value })} />
          </FormField>
          <Button type="submit" disabled={retireIt.isPending}>
            Confirm retirement
          </Button>
          <ErrorNote error={retireIt.error} />
        </FormGrid>
      )}
    </RowActionsCell>
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
                <Button type="button" variant="danger" size="sm" aria-label={`Remove ${mappingText(m)}`} disabled={remove.isPending} onClick={() => remove.mutate(m.id)}>
                  Remove
                </Button>
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
        <FilterBar asChild>
          <form onSubmit={keepOnPage}>
            <FormField>
              Leave type
              <NativeSelect value={filters.leaveType} onChange={(e) => setFilters({ ...filters, leaveType: e.target.value })}>
                <option value="">All</option>
                {types.data?.items.map((t) => (
                  <option key={t.id} value={t.code}>
                    {t.name}
                  </option>
                ))}
              </NativeSelect>
            </FormField>
            <FormField>
              Effective from, on or after
              <Input type="date" value={filters.effectiveFrom} onChange={(e) => setFilters({ ...filters, effectiveFrom: e.target.value })} />
            </FormField>
            <FormField>
              State
              <NativeSelect value={filters.state} onChange={(e) => setFilters({ ...filters, state: e.target.value })}>
                <option value="">All</option>
                <option value="DRAFT">Draft</option>
                <option value="ACTIVE">Active</option>
                <option value="RETIRED">Retired</option>
              </NativeSelect>
            </FormField>
          </form>
        </FilterBar>
        <ErrorNote error={revisions.error} />
        {revisions.isSuccess && items.length === 0 && <Empty>No policy revisions match.</Empty>}
        {unmapped > 0 && (
          <WarningNote badge="unmapped">
            {unmapped === 1 ? 'One revision has' : `${unmapped} revisions have`} no mapping, so {unmapped === 1 ? 'it applies' : 'they apply'} to nobody.
          </WarningNote>
        )}
        {items.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Revision</TableHead>
                <TableHead scope="col">State</TableHead>
                <TableHead scope="col">Period</TableHead>
                <TableHead scope="col">Values</TableHead>
                <TableHead scope="col">Mapped to</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((p) => (
                <TableRow key={p.id}>
                  <TableCell>{`${p.leaveType} revision ${p.revision}`}</TableCell>
                  <TableCell>
                    <StateBadge state={p.state} />
                  </TableCell>
                  <TableCell>{periodText(p)}</TableCell>
                  <TableCell>
                    {`${p.accrualRule === 'NONE' ? 'No accrual' : 'Monthly accrual'}, ${Number(p.annualEntitlement)} days a year, ${p.minServiceDays} days of service, carry cap ${Number(p.carryCap)}, ${leaveYearText(p.leaveYearStartMonth)}`}{' '}
                    <Hint as="span">(eligible: {eligibilityWords(p.eligibility, eligibleTypes(p))})</Hint>
                  </TableCell>
                  <TableCell>
                    <MappingList key={p.version} policy={p} options={options.data} canRemove={p.state === 'DRAFT' && canManage} onChanged={refresh} />
                    {p.warnings.map((w) => (
                      <WarningNote key={w.code} badge={w.code === 'UNMAPPED' ? 'unmapped' : 'overlap'}>
                        {w.text}
                      </WarningNote>
                    ))}
                  </TableCell>
                  <RevisionActions key={p.version} policy={p} canManage={canManage} canActivate={canActivate} onChanged={refresh} />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {can('leave_policy.export.operational') && (
          <ReportExport
            reportCode="LEAVE_POLICY_MAPPING"
            label="Export mapped policies"
            filters={{ ...(filters.leaveType ? { leaveType: filters.leaveType } : {}), ...(filters.effectiveFrom ? { from: filters.effectiveFrom } : {}), ...(filters.state ? { status: filters.state } : {}) }}
          />
        )}
        <Hint>When two revisions apply, the mapping naming more of grade, location and employment type wins; two revisions tying for the same employees in the same period cannot both be active.</Hint>
      </Section>
      {canManage && types.data && <NewRevision types={types.data.items} />}
    </>
  );
}
