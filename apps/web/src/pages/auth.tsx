import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { api } from '../api';
import { type Company, useSession } from '../session';
import { ErrorNote } from '../ui';

/** Development sign-in for synthetic accounts (the server only exposes it in development). */
export function SignInPage() {
  const { signIn } = useSession();
  const [accountKey, setAccountKey] = useState('');
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await api<{ token: string; companies: Company[] }>('/dev/login', { body: { accountKey } });
      signIn(res.token, res.companies);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <main className="narrow">
      <h1>HRMS</h1>
      <p className="hint">Development sign-in (synthetic accounts only).</p>
      <form onSubmit={submit} className="stack">
        <label>
          Account key
          <input value={accountKey} onChange={(e) => setAccountKey(e.target.value)} autoComplete="username" required minLength={3} />
        </label>
        <button type="submit">Sign in</button>
      </form>
      <ErrorNote error={error} />
    </main>
  );
}

interface AssignmentOption {
  id: string;
  roleCode: string;
  roleName: string;
  accessClass: string;
  scopeKind: string;
}

/** BR-046: the user explicitly chooses the company and the role assignment to act under. */
export function SelectRolePage() {
  const { stored, selectCompany, selectAssignment, signOut } = useSession();
  const companies = stored?.companies ?? [];
  const assignments = useQuery({
    queryKey: ['assignments', stored?.companyId],
    enabled: !!stored?.companyId,
    queryFn: () => api<{ items: AssignmentOption[] }>('/v1/me/assignments', { withoutAssignment: true }),
  });

  return (
    <main className="narrow">
      <h1>Choose how you are working</h1>
      {companies.length === 0 && <p>You have no active role in any company. Contact your administrator.</p>}
      {companies.length > 1 && (
        <label>
          Company
          <select value={stored?.companyId ?? ''} onChange={(e) => selectCompany(e.target.value)}>
            <option value="" disabled>
              Select a company
            </option>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {assignments.data && (
        <ul className="choices">
          {assignments.data.items.map((a) => (
            <li key={a.id}>
              <button onClick={() => selectAssignment(a.id)}>
                <strong>{a.roleName}</strong> <span className="hint">scope: {a.scopeKind.toLowerCase()}</span>
              </button>
            </li>
          ))}
          {assignments.data.items.length === 0 && <li>No active roles in this company.</li>}
        </ul>
      )}
      <ErrorNote error={assignments.error} />
      <button className="link" onClick={() => void signOut()}>
        Sign out
      </button>
    </main>
  );
}
