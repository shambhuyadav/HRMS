import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';

const READ_USERS = 'access.read_users.operational';
const LINK_USER = 'access.link_user.operational';
const DEACTIVATE_USER = 'access.deactivate_user.operational';
const READ_REFERENCE = 'reference_value.read.operational';
const MANAGE_REFERENCE = 'reference_value.manage.operational';

// ---------------------------------------------------------------------------------------------------------
// User accounts (§5 System Administrator; §5.1 User to employee; DB007; DB009). A link grants no permission by
// itself; role assignments stay on the access page. Every call is re-checked by the server.
// ---------------------------------------------------------------------------------------------------------

interface CompanyUser {
  userId: string;
  accountKey: string;
  active: boolean;
  version: number;
  employee: { id: string; employeeCode: string; displayName: string } | null;
  assignments: { active: number; pending: number };
}

interface UserLink {
  id: string;
  userId: string;
  accountKey: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  inForce: boolean;
  version: number;
}

function LinkForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({ accountKey: '', employeeCode: '', effectiveFrom: '', effectiveTo: '', reason: '' });
  const link = useMutation({
    mutationFn: async () => {
      // The account is named by its exact key; the employee is found among the employees this administrator can see.
      const found = await api<{ items: { id: string; employeeCode: string }[] }>(`/v1/employees?pageSize=100&search=${encodeURIComponent(form.employeeCode.trim())}`);
      const employee = found.items.find((e) => e.employeeCode === form.employeeCode.trim().toUpperCase());
      if (!employee) throw new ApiError(422, 'UNKNOWN_EMPLOYEE', 'No employee with that code in your scope');
      return api('/v1/access/user-links', {
        body: {
          accountKey: form.accountKey.trim(),
          employeeId: employee.id,
          effectiveFrom: form.effectiveFrom,
          ...(form.effectiveTo ? { effectiveTo: form.effectiveTo } : {}),
          ...(form.reason.trim() ? { reason: form.reason.trim() } : {}),
        },
      });
    },
    onSuccess: () => {
      setForm({ accountKey: '', employeeCode: '', effectiveFrom: '', effectiveTo: '', reason: '' });
      onDone();
    },
  });
  return (
    <form
      className="grid-form"
      aria-label="Link an account"
      onSubmit={(e) => {
        e.preventDefault();
        link.mutate();
      }}
    >
      <label>
        Account key
        <input required value={form.accountKey} onChange={(e) => setForm({ ...form, accountKey: e.target.value })} />
      </label>
      <label>
        Employee code
        <input required value={form.employeeCode} onChange={(e) => setForm({ ...form, employeeCode: e.target.value })} />
      </label>
      <label>
        From
        <input type="date" required value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} />
      </label>
      <label>
        Until (not included)
        <input type="date" value={form.effectiveTo} onChange={(e) => setForm({ ...form, effectiveTo: e.target.value })} />
      </label>
      <label>
        Reason
        <input value={form.reason} maxLength={500} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
      </label>
      <button type="submit" disabled={link.isPending}>
        Link account
      </button>
      <p className="muted">A link gives the account no permission. Its role assignments are granted separately.</p>
      <ErrorNote error={link.error} />
    </form>
  );
}

function ReasonAction({ label, onSubmit, pending }: { label: string; onSubmit: (reason: string) => void; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button type="button" className="link" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <form
      className="inline"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(reason.trim());
      }}
    >
      <label>
        Reason <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>{' '}
      <button type="submit" disabled={pending || reason.trim() === ''}>
        Confirm
      </button>{' '}
      <button type="button" className="link" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  );
}

export function UserAccountsPage() {
  const { can } = useSession();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CompanyUser | null>(null);
  const users = useQuery({
    queryKey: ['access-users', search, page],
    queryFn: () => api<{ items: CompanyUser[]; total: number }>(`/v1/access/users?page=${page}&pageSize=25${search.trim() ? `&search=${encodeURIComponent(search.trim())}` : ''}`),
  });
  const links = useQuery({
    queryKey: ['user-links', selected?.userId],
    enabled: selected !== null,
    queryFn: () => api<{ items: UserLink[]; total: number }>(`/v1/access/user-links?userId=${selected!.userId}&pageSize=100`),
  });
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['access-users'] });
    void client.invalidateQueries({ queryKey: ['user-links'] });
  };
  const setActive = useMutation({
    mutationFn: ({ user, active, reason }: { user: CompanyUser; active: boolean; reason: string }) =>
      api(`/v1/access/users/${user.userId}/${active ? 'reactivate' : 'deactivate'}`, { body: { expectedVersion: user.version, reason } }),
    onSuccess: refresh,
  });
  const endLink = useMutation({
    mutationFn: ({ link, reason }: { link: UserLink; reason: string }) => api(`/v1/access/user-links/${link.id}/end`, { body: { expectedVersion: link.version, reason } }),
    onSuccess: refresh,
  });
  const pages = Math.max(1, Math.ceil((users.data?.total ?? 0) / 25));
  return (
    <Section title={`User accounts${users.data ? ` (${users.data.total})` : ''}`}>
      {can(LINK_USER) && <LinkForm onDone={refresh} />}
      <label className="inline">
        Search{' '}
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
        />
      </label>
      {users.data?.items.length === 0 && <Empty>No accounts match.</Empty>}
      {users.data && users.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Account</th>
              <th>Employee</th>
              <th>State</th>
              <th>Assignments</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data.items.map((u) => (
              <tr key={u.userId}>
                <td>{u.accountKey}</td>
                <td>{u.employee ? `${u.employee.employeeCode} ${u.employee.displayName}` : '—'}</td>
                <td>
                  <Badge tone={u.active ? 'good' : 'warn'}>{u.active ? 'Active' : 'Inactive'}</Badge>
                </td>
                <td>
                  {u.assignments.active} active, {u.assignments.pending} pending
                </td>
                <td>
                  <button type="button" className="link" aria-label={`Show links of ${u.accountKey}`} onClick={() => setSelected(u)}>
                    Links
                  </button>{' '}
                  {can(DEACTIVATE_USER) && (
                    <ReasonAction key={`${u.userId}-${u.version}`} label={u.active ? `Deactivate ${u.accountKey}` : `Reactivate ${u.accountKey}`} pending={setActive.isPending} onSubmit={(reason) => setActive.mutate({ user: u, active: !u.active, reason })} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <div className="pager">
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {pages}
        </span>
        <button disabled={page >= pages} onClick={() => setPage(page + 1)}>
          Next
        </button>
      </div>
      <ErrorNote error={users.error ?? setActive.error} />
      {selected && (
        <Section title={`Links of ${selected.accountKey}`}>
          {links.data?.items.length === 0 && <Empty>This account has no link in this company.</Empty>}
          {links.data && links.data.items.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>From</th>
                  <th>Until</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {links.data.items.map((l) => (
                  <tr key={l.id}>
                    <td>
                      {l.employeeCode} {l.employeeName}
                    </td>
                    <td>{formatDate(l.effectiveFrom)}</td>
                    <td>{l.effectiveTo ? formatDate(l.effectiveTo) : '—'}</td>
                    <td>{l.inForce ? 'In force' : 'Not in force'}</td>
                    <td>{can(LINK_USER) && (l.inForce || l.effectiveTo === null) && <ReasonAction key={`${l.id}-${l.version}`} label={`End link to ${l.employeeCode}`} pending={endLink.isPending} onSubmit={(reason) => endLink.mutate({ link: l, reason })} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ErrorNote error={links.error ?? endLink.error} />
        </Section>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Reference values (FR-004 configurable entities; DF04; DB006). Create, relabel, deactivate or end-date, never
// delete. The server decides which lists can change and which codes must stay in force; the page shows it.
// ---------------------------------------------------------------------------------------------------------

interface ReferenceCategory {
  category: string;
  maintainable: boolean;
  protectedCodes: string[];
}

interface ReferenceValue {
  id: string;
  category: string;
  code: string;
  label: string;
  active: boolean;
  validFrom: string | null;
  validTo: string | null;
  version: number;
}

function ValueRow({ value, editable, codeProtected, onSaved }: { value: ReferenceValue; editable: boolean; codeProtected: boolean; onSaved: () => void }) {
  const [label, setLabel] = useState(value.label);
  const [validTo, setValidTo] = useState(value.validTo ?? '');
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api(`/v1/reference-admin/values/${value.id}`, { method: 'PATCH', body: { expectedVersion: value.version, ...patch } }),
    onSuccess: onSaved,
  });
  return (
    <tr>
      <td>{value.code}</td>
      <td>{editable ? <input aria-label={`Label of ${value.code}`} value={label} maxLength={200} onChange={(e) => setLabel(e.target.value)} /> : value.label}</td>
      <td>{value.validFrom ? formatDate(value.validFrom) : '—'}</td>
      <td>
        {editable && !codeProtected ? <input type="date" aria-label={`Until for ${value.code}`} value={validTo} onChange={(e) => setValidTo(e.target.value)} /> : value.validTo ? formatDate(value.validTo) : '—'}
      </td>
      <td>
        <Badge tone={value.active ? 'good' : 'warn'}>{value.active ? 'Active' : 'Inactive'}</Badge>
      </td>
      <td>
        {editable && (
          <button
            type="button"
            disabled={save.isPending || label.trim() === ''}
            onClick={() => save.mutate({ ...(label.trim() !== value.label ? { label: label.trim() } : {}), ...(!codeProtected && validTo !== (value.validTo ?? '') ? { validTo: validTo || null } : {}) })}
          >
            Save {value.code}
          </button>
        )}{' '}
        {editable && !codeProtected && (
          <button type="button" className="link" disabled={save.isPending} onClick={() => save.mutate({ active: !value.active })}>
            {value.active ? `Deactivate ${value.code}` : `Reactivate ${value.code}`}
          </button>
        )}
        {editable && codeProtected && <span className="muted">Used by the application: stays in force</span>}
        <ErrorNote error={save.error} />
      </td>
    </tr>
  );
}

export function ReferenceValuesPage() {
  const { can } = useSession();
  const client = useQueryClient();
  const [category, setCategory] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [form, setForm] = useState({ code: '', label: '', validFrom: '', validTo: '' });
  const categories = useQuery({ queryKey: ['reference-categories'], queryFn: () => api<{ items: ReferenceCategory[] }>('/v1/reference-admin/categories') });
  const current = categories.data?.items.find((c) => c.category === category);
  const values = useQuery({
    queryKey: ['reference-values-admin', category, includeInactive],
    enabled: category !== '',
    queryFn: () => api<{ items: ReferenceValue[] }>(`/v1/reference-admin/values?category=${encodeURIComponent(category)}&includeInactive=${includeInactive}`),
  });
  const editable = can(MANAGE_REFERENCE) && current?.maintainable === true;
  const refresh = () => void client.invalidateQueries({ queryKey: ['reference-values-admin'] });
  const create = useMutation({
    mutationFn: () =>
      api('/v1/reference-admin/values', {
        body: { category, code: form.code.trim(), label: form.label.trim(), ...(form.validFrom ? { validFrom: form.validFrom } : {}), ...(form.validTo ? { validTo: form.validTo } : {}) },
      }),
    onSuccess: () => {
      setForm({ code: '', label: '', validFrom: '', validTo: '' });
      refresh();
    },
  });
  return (
    <Section title="Reference values">
      <label className="inline">
        List{' '}
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">Choose a list</option>
          {categories.data?.items.map((c) => (
            <option key={c.category} value={c.category}>
              {c.category}
              {c.maintainable ? '' : ' (protected)'}
            </option>
          ))}
        </select>
      </label>{' '}
      <label className="inline">
        <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> Show inactive
      </label>
      {current && !current.maintainable && <p className="muted">The application depends on this list, so it cannot be changed here.</p>}
      {values.data?.items.length === 0 && <Empty>No values in this list.</Empty>}
      {values.data && values.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Code</th>
              <th>Label</th>
              <th>From</th>
              <th>Until</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {values.data.items.map((v) => (
              <ValueRow key={`${v.id}-${v.version}`} value={v} editable={editable} codeProtected={current?.protectedCodes.includes(v.code) ?? false} onSaved={refresh} />
            ))}
          </tbody>
        </table>
      )}
      {editable && (
        <form
          className="grid-form"
          aria-label="Add a value"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <label>
            Code
            <input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </label>
          <label>
            Label
            <input required maxLength={200} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          <label>
            From
            <input type="date" value={form.validFrom} onChange={(e) => setForm({ ...form, validFrom: e.target.value })} />
          </label>
          <label>
            Until (not included)
            <input type="date" value={form.validTo} onChange={(e) => setForm({ ...form, validTo: e.target.value })} />
          </label>
          <button type="submit" disabled={create.isPending}>
            Add value
          </button>
          <ErrorNote error={create.error} />
        </form>
      )}
      <ErrorNote error={categories.error ?? values.error} />
    </Section>
  );
}

export const ORG_ADMIN_SCREENS: ScreenRoute[] = [
  { path: '/admin/user-accounts', title: 'User accounts', permission: READ_USERS, nav: true, component: UserAccountsPage },
  { path: '/admin/reference-values', title: 'Reference values', permission: READ_REFERENCE, nav: true, component: ReferenceValuesPage },
];
