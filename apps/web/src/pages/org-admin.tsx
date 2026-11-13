import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, Fragment, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError, formatDate } from '../api';
import type { ScreenRoute } from '../screens';
import { useSession } from '../session';
import { Badge, Empty, ErrorNote, Section } from '../ui';

const READ_USERS = 'access.read_users.operational';
const LINK_USER = 'access.link_user.operational';
const DEACTIVATE_USER = 'access.deactivate_user.operational';
/** Create, edit, delete and reset the password of an account. */
const MANAGE_ACCOUNTS = 'access.manage_accounts.operational';
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

/** GET /v1/access/accounts/:userId: what editing or deleting one account needs. */
interface AccountDetail {
  userId: string;
  accountKey: string;
  active: boolean;
  version: number;
  firstName: string | null;
  lastName: string | null;
  signInAccount: boolean;
  /** Has signed in at least once. */
  signedIn: boolean;
  /** Never used, so it can be deleted; otherwise it is kept for the record and can only be deactivated. */
  deletable: boolean;
}

interface AccountFields {
  email: string;
  firstName: string;
  lastName: string;
}

interface CreatedAccount {
  userId: string;
  accountKey: string;
  version: number;
  temporaryPassword: string | null;
}

interface SavedAccount {
  userId: string;
  accountKey: string;
  version: number;
}

interface ResetResult {
  userId: string;
  temporaryPassword: string | null;
  sessionsRevoked: number;
}

/**
 * A temporary password the server issued. It is held only in the page's state until Done, never in a query cache, and the
 * mutation that brought it is dropped as soon as its form closes (gcTime 0).
 */
interface Issued {
  kind: 'created' | 'reset';
  accountKey: string;
  temporaryPassword: string | null;
  sessionsRevoked?: number;
}

const NO_FIELDS: AccountFields = { email: '', firstName: '', lastName: '' };
/** Only the shape: a name, an @ and a domain with a dot. The server decides the rest. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Refusals after which what the page shows is out of date: the list (and the open account) are loaded again. */
const RELOAD_ON = new Set(['STALE_VERSION', 'NOT_FOUND', 'ACCOUNT_IN_USE', 'INVALID_STATE']);
const NARROW: CSSProperties = { maxWidth: 560 };
const SECRET: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '1.05rem',
  letterSpacing: '0.04em',
  padding: '0.4rem 0.75rem',
  border: '1px solid var(--line-strong)',
  borderRadius: 6,
  background: '#fff',
  color: 'var(--text)',
  userSelect: 'all',
  wordBreak: 'break-all',
};

/** The account refusals in plain words; any other refusal falls back to the shared error note. */
function accountRefusal(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  switch (error.code) {
    case 'SELF_ACTION_NOT_ALLOWED':
      return 'You cannot change your own account here; another administrator must do it.';
    case 'ACCOUNT_EXISTS':
      return 'An account with this email already exists. Use another email, or find that account in the list.';
    case 'INVALID_EMAIL':
      return 'The sign-in does not accept this email address. Enter the address the person signs in with, such as name@example.com.';
    case 'SIGN_IN_PROVIDER_UNAVAILABLE':
      return 'The sign-in service is not available right now, so this was not done. Try again in a few minutes.';
    case 'STALE_VERSION':
      return 'This account changed since you opened it, so nothing was saved. It has been reloaded: check it and try again.';
    case 'ACCOUNT_SPANS_COMPANIES':
      return 'This account also serves another company, so it cannot be changed from one company.';
    case 'ACCOUNT_IN_USE':
      return 'This account has been used, so it is kept for the record and cannot be deleted. Deactivate it instead.';
    case 'INVALID_STATE':
      return 'This account is inactive. Reactivate it before resetting its password.';
    case 'NOT_FOUND':
      return 'This account is no longer available in the selected company.';
    default:
      return null;
  }
}

function AccountRefusal({ error }: { error: unknown }) {
  if (!error) return null;
  const text = accountRefusal(error);
  return text === null ? (
    <ErrorNote error={error} />
  ) : (
    <p role="alert" className="error">
      {text}
    </p>
  );
}

/** Email and names of an account, new or changed. The email's shape is checked here before anything is sent. */
function AccountForm({
  label,
  initial,
  submitText,
  pending,
  error,
  onSubmit,
  onCancel,
  children,
}: {
  label: string;
  initial: AccountFields;
  submitText: string;
  pending: boolean;
  error: unknown;
  onSubmit: (fields: AccountFields) => void;
  onCancel: () => void;
  children?: ReactNode;
}) {
  const [form, setForm] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <form
      className="grid-form"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        const fields = { email: form.email.trim(), firstName: form.firstName.trim(), lastName: form.lastName.trim() };
        // An email kept as it was is the server's to judge (an older account key); a new one must look like an address.
        const keptAsItWas = initial.email.trim() !== '' && fields.email === initial.email.trim();
        if (!keptAsItWas && !EMAIL_SHAPE.test(fields.email)) {
          setProblem('Enter the email address the person signs in with, such as name@example.com.');
          return;
        }
        if (fields.firstName === '' || fields.lastName === '') {
          setProblem('Enter the first name and the last name.');
          return;
        }
        setProblem(null);
        onSubmit(fields);
      }}
    >
      <label>
        Email (sign-in)
        <input inputMode="email" autoComplete="off" spellCheck={false} required maxLength={200} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </label>
      <label>
        First name
        <input required maxLength={100} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
      </label>
      <label>
        Last name
        <input required maxLength={100} value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
      </label>
      <div className="row">
        <button type="submit" disabled={pending}>
          {submitText}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {children}
      {problem ? (
        <p role="alert" className="error">
          {problem}
        </p>
      ) : (
        <AccountRefusal error={error} />
      )}
    </form>
  );
}

function NewAccountForm({ onCreated, onCancel }: { onCreated: (created: CreatedAccount) => void; onCancel: () => void }) {
  const create = useMutation({
    gcTime: 0,
    mutationFn: (fields: AccountFields) => api<CreatedAccount>('/v1/access/accounts', { body: fields }),
    onSuccess: onCreated,
  });
  return (
    <AccountForm label="New account" initial={NO_FIELDS} submitText="Create account" pending={create.isPending} error={create.error} onSubmit={(fields) => create.mutate(fields)} onCancel={onCancel}>
      <p className="hint wide" style={{ margin: 0 }}>
        A temporary password is shown once the account is created. Its roles and its employee link are given separately.
      </p>
    </AccountForm>
  );
}

const signedOutText = (sessions = 0) => (sessions === 0 ? 'They had no open session.' : `They are signed out of ${sessions} ${sessions === 1 ? 'session' : 'sessions'}.`);

/** The temporary password, shown this once. Focus moves to it, so the page scrolls to it wherever the action was taken. */
function IssuedPanel({ issued, linkPrefilled, onDone }: { issued: Issued; linkPrefilled: boolean; onDone: () => void }) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [copy, setCopy] = useState<'copied' | 'unavailable' | null>(null);
  useEffect(() => {
    setCopy(null);
    heading.current?.focus();
  }, [issued]);
  const password = issued.temporaryPassword;
  const title =
    password !== null ? `Temporary password for ${issued.accountKey}` : issued.kind === 'created' ? `Account created for ${issued.accountKey}` : `Password reset for ${issued.accountKey}`;
  const copyPassword = () => {
    const clipboard = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    if (password === null || typeof clipboard?.writeText !== 'function') {
      setCopy('unavailable');
      return;
    }
    try {
      clipboard.writeText(password).then(
        () => setCopy('copied'),
        () => setCopy('unavailable'),
      );
    } catch {
      setCopy('unavailable');
    }
  };
  return (
    <div className="confirm-box" role="status" aria-labelledby={titleId}>
      <h3 id={titleId} ref={heading} tabIndex={-1} style={{ margin: 0 }}>
        {title}
      </h3>
      <p>{issued.kind === 'created' ? 'The account is created.' : `The password is reset. ${signedOutText(issued.sessionsRevoked)}`}</p>
      {password !== null ? (
        <>
          <div className="row">
            <code style={SECRET}>{password}</code>
            <button type="button" className="secondary" onClick={copyPassword}>
              Copy
            </button>
            {copy === 'copied' && <span className="ok">Copied.</span>}
            {copy === 'unavailable' && <span className="hint">This browser did not allow copying: select the password and copy it by hand.</span>}
          </div>
          <p>Give it to the person privately. It works once: at their first sign-in they choose their own password and set up their authenticator app. It is not shown again.</p>
        </>
      ) : (
        <p>This server has no sign-in provider, so there is no temporary password: the account signs in through the development sign-in.</p>
      )}
      {linkPrefilled && <p>To connect the account to an employee, use "Link an account to an employee" below: its account key is filled in.</p>}
      <div className="row">
        <button type="button" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function ResetPasswordForm({ user, onReset, onRefused, onCancel }: { user: CompanyUser; onReset: (result: ResetResult) => void; onRefused: (error: unknown) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const reset = useMutation({
    gcTime: 0,
    mutationFn: (why: string) => api<ResetResult>(`/v1/access/accounts/${user.userId}/reset-password`, { body: { reason: why } }),
    onSuccess: onReset,
    onError: onRefused,
  });
  return (
    <form
      className="confirm-box"
      aria-label={`Reset the password of ${user.accountKey}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim() !== '') reset.mutate(reason.trim());
      }}
    >
      <p>
        Reset the password of <strong>{user.accountKey}</strong>? They are signed out and must use the new temporary password.
      </p>
      <label style={NARROW}>
        Reason
        <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      <div className="row">
        <button type="submit" className="danger" disabled={reset.isPending || reason.trim() === ''}>
          Reset password
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <AccountRefusal error={reset.error} />
    </form>
  );
}

/** One account opened for change: its details are read now (not for every row), with the version the change is checked against. */
function AccountPanel({
  user,
  onSaved,
  onDeleted,
  onRefused,
  onClose,
}: {
  user: CompanyUser;
  onSaved: (saved: SavedAccount) => void;
  onDeleted: () => void;
  onRefused: (error: unknown) => void;
  onClose: () => void;
}) {
  const detail = useQuery({ queryKey: ['access-account', user.userId], queryFn: () => api<AccountDetail>(`/v1/access/accounts/${user.userId}`) });
  const save = useMutation({
    mutationFn: ({ fields, version }: { fields: AccountFields; version: number }) =>
      api<SavedAccount>(`/v1/access/accounts/${user.userId}`, { method: 'PATCH', body: { expectedVersion: version, ...fields } }),
    onSuccess: onSaved,
    onError: onRefused,
  });
  const remove = useMutation({
    mutationFn: ({ version, reason }: { version: number; reason: string }) => api<{ userId: string; deleted: true }>(`/v1/access/accounts/${user.userId}/delete`, { body: { expectedVersion: version, reason } }),
    onSuccess: onDeleted,
    onError: onRefused,
  });
  const [deleting, setDeleting] = useState(false);
  const [reason, setReason] = useState('');
  const d = detail.data;
  return (
    <div className="stack">
      {detail.isPending && <p className="hint loading">Loading the account…</p>}
      <AccountRefusal error={detail.error} />
      {d && (
        <>
          <AccountForm
            key={d.version}
            label={`Edit ${user.accountKey}`}
            initial={{ email: d.accountKey, firstName: d.firstName ?? '', lastName: d.lastName ?? '' }}
            submitText="Save"
            pending={save.isPending}
            error={save.error}
            onSubmit={(fields) => save.mutate({ fields, version: d.version })}
            onCancel={onClose}
          />
          <p className="hint" style={{ margin: 0 }}>
            {d.signedIn ? 'Has signed in. ' : 'Has not signed in yet. '}
            {d.deletable ? 'It has never been used, so it can be deleted.' : 'It has been used, so it is kept for the record: it can be deactivated, not deleted.'}
          </p>
          {d.deletable && !deleting && (
            <div>
              <button type="button" className="link danger" aria-label={`Delete ${user.accountKey}`} onClick={() => setDeleting(true)}>
                Delete
              </button>
            </div>
          )}
          {d.deletable && deleting && (
            <form
              className="confirm-box"
              aria-label={`Delete ${user.accountKey}`}
              onSubmit={(e) => {
                e.preventDefault();
                if (reason.trim() !== '') remove.mutate({ version: d.version, reason: reason.trim() });
              }}
            >
              <p>
                Delete <strong>{user.accountKey}</strong>? It has never been used, so it is removed for good.
              </p>
              <label style={NARROW}>
                Reason
                <input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="row">
                <button type="submit" className="danger" disabled={remove.isPending || reason.trim() === ''}>
                  Delete account
                </button>
                <button type="button" className="secondary" onClick={() => setDeleting(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
      <AccountRefusal error={remove.error} />
    </div>
  );
}

function LinkForm({ onDone, accountKey = '' }: { onDone: () => void; accountKey?: string }) {
  const [form, setForm] = useState({ accountKey, employeeCode: '', effectiveFrom: '', effectiveTo: '', reason: '' });
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
      <p className="hint wide" style={{ margin: 0 }}>
        A link gives the account no permission. Its role assignments are granted separately.
      </p>
      <ErrorNote error={link.error} />
    </form>
  );
}

/** A row action that asks for a reason. The button shows just the verb; its accessible name (and the form's) says which row. */
function ReasonAction({ verb, label, onSubmit, pending, danger }: { verb: string; label: string; onSubmit: (reason: string) => void; pending: boolean; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  if (!open) {
    return (
      <button type="button" className={danger ? 'link danger' : 'link'} aria-label={label} onClick={() => setOpen(true)}>
        {verb}
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
  const { can, me } = useSession();
  const client = useQueryClient();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<CompanyUser | null>(null);
  const [creating, setCreating] = useState(false);
  /** The one row opened for a change (its panel shows under it). */
  const [panel, setPanel] = useState<{ userId: string; kind: 'edit' | 'reset' } | null>(null);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkPrefill, setLinkPrefill] = useState('');
  const manage = can(MANAGE_ACCOUNTS);
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
    void client.invalidateQueries({ queryKey: ['access-account'] });
  };
  const reloadIfStale = (error: unknown) => {
    if (error instanceof ApiError && RELOAD_ON.has(error.code)) refresh();
  };
  const issue = (next: Issued) => {
    setNotice(null);
    setPanel(null);
    setIssued(next);
    refresh();
  };
  const saved = (account: SavedAccount) => {
    setPanel(null);
    setNotice(`Saved ${account.accountKey}.`);
    if (selected?.userId === account.userId) setSelected({ ...selected, accountKey: account.accountKey });
    refresh();
  };
  const deleted = (user: CompanyUser) => {
    setPanel(null);
    // The row goes at once; the reload that follows confirms it.
    client.setQueriesData<{ items: CompanyUser[]; total: number }>({ queryKey: ['access-users'] }, (old) =>
      old ? { items: old.items.filter((x) => x.userId !== user.userId), total: Math.max(0, old.total - 1) } : old,
    );
    if (selected?.userId === user.userId) setSelected(null);
    setNotice(`Deleted ${user.accountKey}.`);
    refresh();
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
    <>
    <Section
      title={`User accounts${users.data ? ` (${users.data.total})` : ''}`}
      actions={
        manage ? (
          <button type="button" aria-expanded={creating} onClick={() => setCreating(!creating)}>
            New account
          </button>
        ) : undefined
      }
    >
      {(issued || notice || (manage && creating)) && (
        <div className="stack" style={{ marginBottom: '1rem' }}>
          {issued && <IssuedPanel issued={issued} linkPrefilled={issued.kind === 'created' && can(LINK_USER)} onDone={() => setIssued(null)} />}
          {notice && (
            <p className="ok" role="status" style={{ margin: 0 }}>
              {notice}
            </p>
          )}
          {manage && creating && (
            <Section title="New account">
              <NewAccountForm
                onCancel={() => setCreating(false)}
                onCreated={(created) => {
                  setCreating(false);
                  if (can(LINK_USER)) setLinkPrefill(created.accountKey);
                  issue({ kind: 'created', accountKey: created.accountKey, temporaryPassword: created.temporaryPassword });
                }}
              />
            </Section>
          )}
        </div>
      )}
      <div className="inline">
        <label className="inline">
          Search
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </label>
      </div>
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
            {users.data.items.map((u) => {
              // One's own account is changed by another administrator (the server refuses it too).
              const own = me?.userId === u.userId;
              const open = manage && !own && panel?.userId === u.userId ? panel.kind : null;
              const toggle = (kind: 'edit' | 'reset') => {
                setNotice(null);
                setPanel(open === kind ? null : { userId: u.userId, kind });
              };
              return (
                <Fragment key={u.userId}>
                  <tr>
                    <td>
                      {u.accountKey}
                      {own && <div className="hint">Your account</div>}
                    </td>
                    <td>{u.employee ? `${u.employee.displayName} (${u.employee.employeeCode})` : '—'}</td>
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
                      {manage && !own && (
                        <>
                          <button type="button" className="link" aria-label={`Edit ${u.accountKey}`} aria-expanded={open === 'edit'} onClick={() => toggle('edit')}>
                            Edit
                          </button>{' '}
                          {u.active && (
                            <>
                              <button type="button" className="link" aria-label={`Reset password of ${u.accountKey}`} aria-expanded={open === 'reset'} onClick={() => toggle('reset')}>
                                Reset password
                              </button>{' '}
                            </>
                          )}
                        </>
                      )}
                      {can(DEACTIVATE_USER) && (
                        <ReasonAction
                          key={`${u.userId}-${u.version}`}
                          danger={u.active}
                          verb={u.active ? 'Deactivate' : 'Reactivate'}
                          label={u.active ? `Deactivate ${u.accountKey}` : `Reactivate ${u.accountKey}`}
                          pending={setActive.isPending}
                          onSubmit={(reason) => setActive.mutate({ user: u, active: !u.active, reason })}
                        />
                      )}
                    </td>
                  </tr>
                  {open && (
                    <tr>
                      <td colSpan={5}>
                        {open === 'edit' ? (
                          <AccountPanel user={u} onSaved={saved} onDeleted={() => deleted(u)} onRefused={reloadIfStale} onClose={() => setPanel(null)} />
                        ) : (
                          <ResetPasswordForm
                            user={u}
                            onRefused={reloadIfStale}
                            onCancel={() => setPanel(null)}
                            onReset={(result) => issue({ kind: 'reset', accountKey: u.accountKey, temporaryPassword: result.temporaryPassword, sessionsRevoked: result.sessionsRevoked })}
                          />
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
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
                      {l.employeeName} ({l.employeeCode})
                    </td>
                    <td>{formatDate(l.effectiveFrom)}</td>
                    <td>{l.effectiveTo ? formatDate(l.effectiveTo) : '—'}</td>
                    <td>{l.inForce ? 'In force' : 'Not in force'}</td>
                    <td>
                      {can(LINK_USER) && (l.inForce || l.effectiveTo === null) && (
                        <ReasonAction key={`${l.id}-${l.version}`} danger verb="End link" label={`End link to ${l.employeeCode}`} pending={endLink.isPending} onSubmit={(reason) => endLink.mutate({ link: l, reason })} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <ErrorNote error={links.error ?? endLink.error} />
        </Section>
      )}
    </Section>
    {can(LINK_USER) && (
      <Section title="Link an account to an employee">
        <LinkForm key={linkPrefill} accountKey={linkPrefill} onDone={refresh} />
      </Section>
    )}
    </>
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
            aria-label={`Save ${value.code}`}
            disabled={save.isPending || label.trim() === ''}
            onClick={() => save.mutate({ ...(label.trim() !== value.label ? { label: label.trim() } : {}), ...(!codeProtected && validTo !== (value.validTo ?? '') ? { validTo: validTo || null } : {}) })}
          >
            Save
          </button>
        )}{' '}
        {editable && !codeProtected && (
          <button
            type="button"
            className={value.active ? 'link danger' : 'link'}
            aria-label={value.active ? `Deactivate ${value.code}` : `Reactivate ${value.code}`}
            disabled={save.isPending}
            onClick={() => save.mutate({ active: !value.active })}
          >
            {value.active ? 'Deactivate' : 'Reactivate'}
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
