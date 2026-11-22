// Account administration (§5 System Administrator; DB009): a new account, one account opened for change (its names and email,
// deleting one never used) and a password reset, each refused in plain words. A temporary password the server issues is shown by
// issued-panel.tsx.
import { useMutation, useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { ConfirmBox } from '@/components/confirm-box';
import { ButtonRow, FormField, FormGrid } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { api, ApiError } from '../../api';
import { ErrorNote, Notice } from '../../ui';
import type { CompanyUser } from './shared';

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

export interface CreatedAccount {
  userId: string;
  accountKey: string;
  version: number;
  temporaryPassword: string | null;
}

export interface SavedAccount {
  userId: string;
  accountKey: string;
  version: number;
}

export interface ResetResult {
  userId: string;
  temporaryPassword: string | null;
  sessionsRevoked: number;
}

const NO_FIELDS: AccountFields = { email: '', firstName: '', lastName: '' };
/** Only the shape: a name, an @ and a domain with a dot. The server decides the rest. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A reason field in a confirm step: no wider than a line of reading. */
const REASON_FIELD = 'max-w-[560px]';

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
  if (text === null) return <ErrorNote error={error} />;
  return <Notice notice={{ text, ok: false }} />;
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
    <FormGrid
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
      <FormField>
        Email (sign-in)
        <Input inputMode="email" autoComplete="off" spellCheck={false} required maxLength={200} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
      </FormField>
      <FormField>
        First name
        <Input required maxLength={100} value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
      </FormField>
      <FormField>
        Last name
        <Input required maxLength={100} value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
      </FormField>
      <ButtonRow>
        <Button type="submit" disabled={pending}>
          {submitText}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </ButtonRow>
      {children}
      {problem ? <Notice notice={{ text: problem, ok: false }} /> : <AccountRefusal error={error} />}
    </FormGrid>
  );
}

export function NewAccountForm({ onCreated, onCancel }: { onCreated: (created: CreatedAccount) => void; onCancel: () => void }) {
  const create = useMutation({
    gcTime: 0,
    mutationFn: (fields: AccountFields) => api<CreatedAccount>('/v1/access/accounts', { body: fields }),
    onSuccess: onCreated,
  });
  return (
    <AccountForm label="New account" initial={NO_FIELDS} submitText="Create account" pending={create.isPending} error={create.error} onSubmit={(fields) => create.mutate(fields)} onCancel={onCancel}>
      <Hint className="m-0">A temporary password is shown once the account is created. Its roles and its employee link are given separately.</Hint>
    </AccountForm>
  );
}

export function ResetPasswordForm({ user, onReset, onRefused, onCancel }: { user: CompanyUser; onReset: (result: ResetResult) => void; onRefused: (error: unknown) => void; onCancel: () => void }) {
  const [reason, setReason] = useState('');
  const reset = useMutation({
    gcTime: 0,
    mutationFn: (why: string) => api<ResetResult>(`/v1/access/accounts/${user.userId}/reset-password`, { body: { reason: why } }),
    onSuccess: onReset,
    onError: onRefused,
  });
  return (
    <ConfirmBox asChild>
      <form
        aria-label={`Reset the password of ${user.accountKey}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (reason.trim() !== '') reset.mutate(reason.trim());
        }}
      >
        <p>
          Reset the password of <strong>{user.accountKey}</strong>? They are signed out and must use the new temporary password.
        </p>
        <FormField className={REASON_FIELD}>
          Reason
          <Input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <ButtonRow>
          <Button type="submit" variant="danger" disabled={reset.isPending || reason.trim() === ''}>
            Reset password
          </Button>
          <Button type="button" variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </ButtonRow>
        <AccountRefusal error={reset.error} />
      </form>
    </ConfirmBox>
  );
}

/** One account opened for change: its details are read now (not for every row), with the version the change is checked against. */
export function AccountPanel({
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
    <div className="flex flex-col gap-3">
      {detail.isPending && <LoadingLine>Loading the account…</LoadingLine>}
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
          <Hint className="m-0">
            {d.signedIn ? 'Has signed in. ' : 'Has not signed in yet. '}
            {d.deletable ? 'It has never been used, so it can be deleted.' : 'It has been used, so it is kept for the record: it can be deactivated, not deleted.'}
          </Hint>
          {d.deletable && !deleting && (
            <div>
              <Button type="button" variant="danger" size="sm" aria-label={`Delete ${user.accountKey}`} onClick={() => setDeleting(true)}>
                Delete
              </Button>
            </div>
          )}
          {d.deletable && deleting && (
            <ConfirmBox asChild>
              <form
                aria-label={`Delete ${user.accountKey}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  if (reason.trim() !== '') remove.mutate({ version: d.version, reason: reason.trim() });
                }}
              >
                <p>
                  Delete <strong>{user.accountKey}</strong>? It has never been used, so it is removed for good.
                </p>
                <FormField className={REASON_FIELD}>
                  Reason
                  <Input required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
                </FormField>
                <ButtonRow>
                  <Button type="submit" variant="danger" disabled={remove.isPending || reason.trim() === ''}>
                    Delete account
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setDeleting(false)}>
                    Cancel
                  </Button>
                </ButtonRow>
              </form>
            </ConfirmBox>
          )}
        </>
      )}
      <AccountRefusal error={remove.error} />
    </div>
  );
}
