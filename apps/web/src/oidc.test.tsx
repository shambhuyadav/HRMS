// Production sign-in in the browser (oidc.ts, pages/auth.tsx; ADR-06, Keycloak), jsdom: the provider sign-in is offered when the server
// says OIDC; the way out to the provider carries PKCE (S256), a fresh state and nonce; the way back checks the state, exchanges the code
// at the provider for the ID token and hands it with the nonce to /sign-in/oidc, which opens the HRMS session; a mismatched state or a
// provider error is refused in words; signing out also ends the provider's session. Synthetic endpoints only.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeOidcSignIn, type OidcSignInConfig, pkceChallenge, providerLogout, rememberProviderLogout, startOidcSignIn } from './oidc';
import { SignInPage } from './pages/auth';
import { SessionProvider, useSession } from './session';

const CONFIG: OidcSignInConfig = {
  mode: 'OIDC',
  issuer: 'https://hr.example.test/kc/realms/hrms',
  clientId: 'hrms-web',
  authorizationEndpoint: 'https://hr.example.test/kc/realms/hrms/protocol/openid-connect/auth',
  tokenEndpoint: 'https://hr.example.test/kc/realms/hrms/protocol/openid-connect/token',
  endSessionEndpoint: 'https://hr.example.test/kc/realms/hrms/protocol/openid-connect/logout',
  scopes: 'openid email profile',
};

type Call = { method: string; url: string; body: string | undefined };
let calls: Call[] = [];
function serve(answer: (c: Call) => [number, unknown]) {
  calls = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call = { method: init?.method ?? 'GET', url: String(url), body: init?.body ? String(init.body) : undefined };
      calls.push(call);
      const [status, body] = answer(call);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Shell() {
  const { stored } = useSession();
  return stored ? <p>{`Signed in with ${stored.token} to ${stored.companies.map((c) => c.name).join(', ')}`}</p> : <SignInPage />;
}
const renderSignIn = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SessionProvider>
        <Shell />
      </SessionProvider>
    </QueryClientProvider>,
  );

describe('OIDC sign-in in the browser', () => {
  it('goes to the provider with the code flow, PKCE (S256), a fresh state and nonce, and this app’s way back', async () => {
    let url = '';
    await startOidcSignIn(CONFIG, (u) => (url = u));
    const go = new URL(url);
    const pending = JSON.parse(sessionStorage.getItem('hrms.oidc.pending')!) as { state: string; nonce: string; verifier: string };
    expect(`${go.origin}${go.pathname}`).toBe(CONFIG.authorizationEndpoint);
    expect(Object.fromEntries(go.searchParams)).toEqual({
      response_type: 'code',
      client_id: 'hrms-web',
      redirect_uri: `${window.location.origin}/signed-in`,
      scope: 'openid email profile',
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await pkceChallenge(pending.verifier),
      code_challenge_method: 'S256',
    });
    expect(pending.state.length).toBeGreaterThanOrEqual(40);
    expect(pending.verifier.length).toBeGreaterThanOrEqual(43);
    // RFC 7636 appendix B.
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('offers the organisation sign-in when the server says OIDC, not the account-key form', async () => {
    serve((c) => (c.url === '/sign-in/config' ? [200, CONFIG] : [404, {}]));
    renderSignIn();
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByLabelText('Account key')).toBeNull();
    expect(screen.getByText(/second factor/)).toBeTruthy();
  });

  it('back from the provider: checks the state, exchanges the code for the ID token and opens the HRMS session with it and the nonce', async () => {
    sessionStorage.setItem('hrms.oidc.pending', JSON.stringify({ state: 'state-from-this-tab-0123456789', nonce: 'nonce-from-this-tab-0123456789', verifier: 'v'.repeat(64) }));
    window.history.replaceState(null, '', '/signed-in?code=provider-code&state=state-from-this-tab-0123456789&session_state=x');
    serve((c) => {
      if (c.url === '/sign-in/config') return [200, CONFIG];
      if (c.url === CONFIG.tokenEndpoint) return [200, { id_token: 'provider.id.token', access_token: 'not used' }];
      if (c.url === '/sign-in/oidc') return [200, { token: 'hrms-session-token', companies: [{ id: 'c1', code: 'SYN', name: 'Synthetic Co' }] }];
      return [404, {}];
    });
    renderSignIn();
    expect(await screen.findByText('Signed in with hrms-session-token to Synthetic Co')).toBeTruthy();
    const exchange = calls.find((c) => c.url === CONFIG.tokenEndpoint)!;
    expect(exchange.method).toBe('POST');
    expect(Object.fromEntries(new URLSearchParams(exchange.body))).toEqual({
      grant_type: 'authorization_code',
      code: 'provider-code',
      redirect_uri: `${window.location.origin}/signed-in`,
      client_id: 'hrms-web',
      code_verifier: 'v'.repeat(64),
    });
    expect(JSON.parse(calls.find((c) => c.url === '/sign-in/oidc')!.body!)).toEqual({ idToken: 'provider.id.token', nonce: 'nonce-from-this-tab-0123456789' });
    // The sign-in's secrets are gone, the address is clean, and the provider's sign-out is remembered for this session.
    expect(sessionStorage.getItem('hrms.oidc.pending')).toBeNull();
    expect(window.location.pathname).toBe('/');
    expect(sessionStorage.getItem('hrms.oidc.logout')).toContain('hrms-web');
  });

  it('refuses a way back it cannot match to this tab, or a provider error, and offers to sign in again', async () => {
    sessionStorage.setItem('hrms.oidc.pending', JSON.stringify({ state: 'mine-0123456789', nonce: 'n'.repeat(20), verifier: 'v'.repeat(64) }));
    await expect(completeOidcSignIn(CONFIG, '?code=x&state=someone-else')).rejects.toThrow('could not be matched');
    sessionStorage.setItem('hrms.oidc.pending', JSON.stringify({ state: 'mine-0123456789', nonce: 'n'.repeat(20), verifier: 'v'.repeat(64) }));
    await expect(completeOidcSignIn(CONFIG, '?error=access_denied&error_description=User%20cancelled')).rejects.toThrow('User cancelled');
    window.history.replaceState(null, '', '/signed-in?code=x&state=nothing-pending');
    serve((c) => (c.url === '/sign-in/config' ? [200, CONFIG] : [404, {}]));
    renderSignIn();
    expect(await screen.findByRole('button', { name: 'Sign in again' })).toBeTruthy();
    await waitFor(() => expect(calls.some((c) => c.url === CONFIG.tokenEndpoint)).toBe(false));
  });

  it('after a first sign-in that only set up the authenticator app, offers a full sign-in with a code (the provider asks again)', async () => {
    sessionStorage.setItem('hrms.oidc.pending', JSON.stringify({ state: 'state-first-sign-in-0123456789', nonce: 'nonce-first-0123456789', verifier: 'v'.repeat(64) }));
    window.history.replaceState(null, '', '/signed-in?code=provider-code&state=state-first-sign-in-0123456789');
    serve((c) => {
      if (c.url === '/sign-in/config') return [200, CONFIG];
      if (c.url === CONFIG.tokenEndpoint) return [200, { id_token: 'provider.id.token.without.otp' }];
      if (c.url === '/sign-in/oidc') return [401, { error: 'SIGN_IN_MFA_REQUIRED', message: 'Sign in with a second factor (an authenticator app) to use HRMS' }];
      return [404, {}];
    });
    renderSignIn();
    expect(await screen.findByRole('button', { name: 'Sign in with your code' })).toBeTruthy();
    expect(screen.getByText(/authenticator app is set up/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Sign in again' })).toBeNull();

    // That sign-in asks the provider to authenticate again; an ordinary one does not.
    let again = '';
    await startOidcSignIn(CONFIG, (u) => (again = u), { reauthenticate: true });
    expect(new URL(again).searchParams.get('prompt')).toBe('login');
    let ordinary = '';
    await startOidcSignIn(CONFIG, (u) => (ordinary = u));
    expect(new URL(ordinary).searchParams.has('prompt')).toBe(false);
  });

  it('signing out ends the provider session too, back to this app', () => {
    rememberProviderLogout(CONFIG);
    let url = '';
    providerLogout((u) => (url = u));
    const go = new URL(url);
    expect(`${go.origin}${go.pathname}`).toBe(CONFIG.endSessionEndpoint);
    expect(Object.fromEntries(go.searchParams)).toEqual({ client_id: 'hrms-web', post_logout_redirect_uri: `${window.location.origin}/` });
    // Only once.
    url = '';
    providerLogout((u) => (url = u));
    expect(url).toBe('');
  });
});
