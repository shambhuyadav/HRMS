import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { CALLBACK_PATH, completeOidcSignIn, type OidcSignInConfig, rememberProviderLogout, startOidcSignIn } from '../oidc';
import { type Company, useSession } from '../session';
import { ErrorNote } from '../ui';

type SignInConfig = OidcSignInConfig | { mode: 'DEV' | 'NONE' };

/**
 * Sign-in: what the server offers (GET /sign-in/config). Production: the organisation's sign-in provider (OIDC, authorization code with
 * PKCE; ../oidc.ts), including the way back to CALLBACK_PATH. Development: the account-key form for synthetic accounts (also when the
 * server does not say, as an older development server does not).
 */
export function SignInPage() {
  const config = useQuery({ queryKey: ['sign-in-config'], queryFn: () => api<SignInConfig>('/sign-in/config'), retry: false, staleTime: Infinity });
  if (config.isPending) return <main className="narrow"><p className="hint">Loading…</p></main>;
  const c = config.data;
  if (c?.mode === 'OIDC') return window.location.pathname === CALLBACK_PATH ? <OidcCallback config={c} /> : <OidcSignIn config={c} />;
  if (c?.mode === 'NONE') {
    return (
      <main className="narrow">
        <h1>HRMS</h1>
        <p>Sign-in is not configured on this server. Contact your administrator.</p>
      </main>
    );
  }
  return <DevSignIn />;
}

function OidcSignIn({ config }: { config: OidcSignInConfig }) {
  const [error, setError] = useState<unknown>(null);
  return (
    <main className="narrow">
      <h1>HRMS</h1>
      <p className="hint">Sign in with your organisation account. You will be asked for your second factor (authenticator app).</p>
      <button
        type="button"
        onClick={() => {
          setError(null);
          startOidcSignIn(config).catch(setError);
        }}
      >
        Sign in
      </button>
      <ErrorNote error={error} />
    </main>
  );
}

/** Back from the provider: the code is exchanged, the API verifies the ID token and opens the HRMS session. */
function OidcCallback({ config }: { config: OidcSignInConfig }) {
  const { signIn } = useSession();
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const { idToken, nonce } = await completeOidcSignIn(config, window.location.search);
      const res = await api<{ token: string; companies: Company[] }>('/sign-in/oidc', { body: { idToken, nonce } });
      rememberProviderLogout(config);
      window.history.replaceState(null, '', '/');
      signIn(res.token, res.companies);
    })().catch(setError);
  }, [config, signIn]);
  // A first sign-in sets up the authenticator app; that sign-in itself did not use it, so the API asks for one that does.
  const secondFactorNeeded = error instanceof ApiError && error.code === 'SIGN_IN_MFA_REQUIRED';
  return (
    <main className="narrow">
      <h1>HRMS</h1>
      {secondFactorNeeded ? (
        <>
          <p>Your authenticator app is set up. To finish, sign in once more with your password and a code from the app.</p>
          <button type="button" onClick={() => startOidcSignIn(config, undefined, { reauthenticate: true }).catch(setError)}>
            Sign in with your code
          </button>
        </>
      ) : error ? (
        <>
          <ErrorNote error={error} />
          <button type="button" onClick={() => startOidcSignIn(config).catch(setError)}>
            Sign in again
          </button>
        </>
      ) : (
        <p className="hint">Signing you in…</p>
      )}
    </main>
  );
}

/** Development sign-in for synthetic accounts (the server only exposes it in development). */
function DevSignIn() {
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
