import { useQuery } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { FormField } from '@/components/form-field';
import { Hint } from '@/components/hint';
import { LoadingLine } from '@/components/loading-line';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { ApiError, api } from '../api';
import { Icon, type IconName } from '../icons';
import { CALLBACK_PATH, completeOidcSignIn, type OidcSignInConfig, rememberProviderLogout, startOidcSignIn } from '../oidc';
import { type Company, useSession } from '../session';
import { ErrorNote } from '../ui';

type SignInConfig = OidcSignInConfig | { mode: 'DEV' | 'NONE' };

/**
 * Sign-in: what the server offers (GET /sign-in/config). Production: the organisation's sign-in provider (OIDC, authorization code with
 * PKCE; ../oidc.ts), including the way back to CALLBACK_PATH. Development: the account-key form for synthetic accounts (also when the
 * server does not say, as an older development server does not).
 */
const FEATURES: readonly [IconName, string][] = [
  ['users', 'Employees, attendance and leave'],
  ['wallet', 'Payroll, statutory compliance and tax'],
  ['target', 'Hiring, appraisal and training'],
  ['shield', 'Two-step sign-in and a full audit trail'],
];

/** The card beside the brand panel (the old `.narrow`), drawn as a shadcn Card: up to 440px wide, its parts stacked. */
const AUTH_CARD = 'm-0 flex w-full max-w-[440px] flex-col gap-[0.9rem] rounded-xl border border-border bg-card px-8 py-9 shadow-sm';
/** The card's title, as in shadcn's sign-in cards (the h1 rule of styles.css makes it semibold and tight). */
const AUTH_TITLE = 'text-2xl';
/** The roles to choose from, one full-width choice under another (the old `.choices` list). */
const CHOICE_LIST = 'm-0 flex list-none flex-col gap-[0.6rem] p-0';
/**
 * One role as a full-width choice: its mark, its words from the left and wrapping, an arrow at the end, on the outline button's
 * hover tint under the pointer. Button narrows its side padding when it holds an icon (`has-[>svg]`); the arrow is one, so the
 * choice repeats its own padding for that case.
 */
const CHOICE_BUTTON = 'h-auto w-full justify-start gap-[0.85rem] px-4 py-[0.8rem] text-left whitespace-normal has-[>svg]:px-4';
/** The role's mark: its icon on a muted square. */
const CHOICE_ICON = 'grid size-[40px] flex-none place-items-center rounded-[10px] bg-muted text-foreground';
/** The role's name above its scope, taking the room between the mark and the arrow. */
const CHOICE_TEXT = 'flex min-w-0 flex-1 flex-col gap-[0.1rem]';

// The signed-out pages' frame: the brand panel beside the card. The panel is dark in both themes, as in shadcn's sign-in example (the
// --dark surface, zinc-900; white words; the light red of --accent-on-dark), with the brand red down its edge. At 920px or less the
// two stack: the panel becomes a bar holding only the logo (a stretched row left a third of a phone screen dark and empty), the card
// below it.

/** Two columns side by side; one column at 920px or less, the brand bar keeping its own height. */
const AUTH_FRAME =
  'grid min-h-screen grid-cols-[minmax(340px,1fr)_minmax(380px,1fr)] bg-background [@media(max-width:920px)]:grid-cols-1 [@media(max-width:920px)]:grid-rows-[auto_1fr]';
const BRAND_PANEL =
  'relative flex flex-col justify-between gap-8 overflow-hidden bg-[var(--dark)] px-12 py-10 text-white shadow-[inset_4px_0_0_var(--accent-bright)] [@media(max-width:920px)]:px-6 [@media(max-width:920px)]:py-5';
const LOGO = 'flex items-center gap-3 text-[1.35rem] font-semibold tracking-tight';
/** The brand's mark: a rounded square in the brand red holding a white frame. */
const BRAND_MARK =
  "relative size-[30px] flex-none rounded-[8px] bg-[var(--accent-bright)] shadow-[inset_0_-1px_0_rgb(0_0_0/0.18)] after:absolute after:inset-[8.5px] after:rounded-[4px] after:border-[2.5px] after:border-solid after:border-white/95 after:content-['']";
/** The headline and the features; left out of the one-column bar. */
const PITCH = '[@media(max-width:920px)]:hidden';
const HEADLINE = 'm-0 mb-7 max-w-[27rem] text-[2.1rem] leading-[1.2] font-semibold tracking-tight text-white';
const FEATURES_LIST = 'm-0 flex list-none flex-col gap-[0.9rem] p-0 text-white/84';
const FEATURE_ICON = 'grid size-[36px] flex-none place-items-center rounded-[10px] border border-white/10 bg-white/8 text-[var(--accent-on-dark)]';
/** The foot line, quieter than the features but still 4.5:1 on the panel (white at 60%). */
const FOOT = 'm-0 text-[0.8rem] text-white/60 [@media(max-width:920px)]:hidden';
/** The card's side: the card centred; under the bar at 920px or less, from the top. */
const CARD_SIDE = 'flex items-center justify-center px-6 py-8 [@media(max-width:920px)]:items-start [@media(max-width:920px)]:pt-10';

/** The signed-out pages (sign-in, the way back from the provider, the role choice): the product beside the card. */
function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className={AUTH_FRAME}>
      <section className={BRAND_PANEL}>
        <div className={LOGO}>
          <span className={BRAND_MARK} aria-hidden="true" />
          <span>HRMS</span>
        </div>
        <div className={PITCH}>
          <p className={HEADLINE}>Hire-to-retire HR and payroll, in one place.</p>
          <ul className={FEATURES_LIST}>
            {FEATURES.map(([icon, text]) => (
              <li key={text} className="flex items-center gap-[0.8rem]">
                <span className={FEATURE_ICON}>
                  <Icon name={icon} size={18} />
                </span>
                {text}
              </li>
            ))}
          </ul>
        </div>
        <p className={FOOT}>Secure sign-in · Your data stays on your company's server</p>
      </section>
      <div className={CARD_SIDE}>{children}</div>
    </div>
  );
}

export function SignInPage() {
  return (
    <AuthLayout>
      <SignInContent />
    </AuthLayout>
  );
}

function SignInContent() {
  const config = useQuery({ queryKey: ['sign-in-config'], queryFn: () => api<SignInConfig>('/sign-in/config'), retry: false, staleTime: Infinity });
  if (config.isPending) return <main className={AUTH_CARD}><LoadingLine>Loading…</LoadingLine></main>;
  const c = config.data;
  if (c?.mode === 'OIDC') return window.location.pathname === CALLBACK_PATH ? <OidcCallback config={c} /> : <OidcSignIn config={c} />;
  if (c?.mode === 'NONE') {
    return (
      <main className={AUTH_CARD}>
        <h1 className={AUTH_TITLE}>HRMS</h1>
        <p>Sign-in is not configured on this server. Contact your administrator.</p>
      </main>
    );
  }
  return <DevSignIn />;
}

function OidcSignIn({ config }: { config: OidcSignInConfig }) {
  const [error, setError] = useState<unknown>(null);
  return (
    <main className={AUTH_CARD}>
      <h1 className={AUTH_TITLE}>Welcome back</h1>
      <Hint>Sign in with your organisation account. You will be asked for your second factor (authenticator app).</Hint>
      {/* The card's one action, across the card and a little taller than other buttons (the old `full-width` button). */}
      <Button
        type="button"
        size="lg"
        className="w-full"
        onClick={() => {
          setError(null);
          startOidcSignIn(config).catch(setError);
        }}
      >
        Sign in
      </Button>
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
    <main className={AUTH_CARD}>
      <h1 className={AUTH_TITLE}>HRMS</h1>
      {secondFactorNeeded ? (
        <>
          <p>Your authenticator app is set up. To finish, sign in once more with your password and a code from the app.</p>
          <Button type="button" onClick={() => startOidcSignIn(config, undefined, { reauthenticate: true }).catch(setError)}>
            Sign in with your code
          </Button>
        </>
      ) : error ? (
        <>
          <ErrorNote error={error} />
          <Button type="button" onClick={() => startOidcSignIn(config).catch(setError)}>
            Sign in again
          </Button>
        </>
      ) : (
        <Hint>Signing you in…</Hint>
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
    <main className={AUTH_CARD}>
      <h1 className={AUTH_TITLE}>HRMS</h1>
      <Hint>Development sign-in (synthetic accounts only).</Hint>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <FormField>
          Account key
          <Input value={accountKey} onChange={(e) => setAccountKey(e.target.value)} autoComplete="username" required minLength={3} />
        </FormField>
        <Button type="submit">Sign in</Button>
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
    <AuthLayout>
      <main className={AUTH_CARD}>
        <h1 className={AUTH_TITLE}>Choose how you are working</h1>
        <Hint>Each role shows its own menu and data. You can switch at any time from the top bar.</Hint>
        {companies.length === 0 && <p>You have no active role in any company. Contact your administrator.</p>}
        {companies.length > 1 && (
          <FormField>
            Company
            <NativeSelect value={stored?.companyId ?? ''} onChange={(e) => selectCompany(e.target.value)}>
              <option value="" disabled>
                Select a company
              </option>
              {companies.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </NativeSelect>
          </FormField>
        )}
        {assignments.data && (
          <ul className={CHOICE_LIST}>
            {assignments.data.items.map((a) => (
              <li key={a.id}>
                <Button variant="outline" className={CHOICE_BUTTON} onClick={() => selectAssignment(a.id)}>
                  <span className={CHOICE_ICON}>
                    <Icon name={roleIcon(a.roleCode)} size={20} className="size-[20px]" />
                  </span>
                  <span className={CHOICE_TEXT}>
                    <strong>{a.roleName}</strong> <Hint as="span">scope: {a.scopeKind.toLowerCase()}</Hint>
                  </span>
                  <Icon name="chevron" size={16} className="size-4 text-muted-foreground" />
                </Button>
              </li>
            ))}
            {assignments.data.items.length === 0 && <li>No active roles in this company.</li>}
          </ul>
        )}
        <ErrorNote error={assignments.error} />
        <Button variant="link" onClick={() => void signOut()}>
          Sign out
        </Button>
      </main>
    </AuthLayout>
  );
}

const ROLE_ICONS: Readonly<Record<string, IconName>> = {
  SYSTEM_ADMINISTRATOR: 'settings',
  HR_ADMINISTRATOR: 'users',
  REPORTING_MANAGER: 'share',
  EMPLOYEE: 'user',
  AUDITOR: 'history',
};
const roleIcon = (code: string): IconName => ROLE_ICONS[code] ?? (/PAYROLL|FINANCE|TREASURY/.test(code) ? 'wallet' : 'idCard');
