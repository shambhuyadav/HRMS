// Production sign-in in the browser (ADR-06; Keycloak by the owner's decision of 9 Nov 2026): the authorization code flow with PKCE, as a
// public client. The browser keeps a fresh state, nonce and code verifier for the one sign-in (session storage, this tab only), goes to
// the provider, and on its way back checks the state, exchanges the code for the provider's ID token, and hands that token and the nonce
// to the HRMS API (POST /sign-in/oidc), which verifies both and returns the HRMS session (auth/oidc.ts). No provider token is kept.

export interface OidcSignInConfig {
  mode: 'OIDC';
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint: string | null;
  scopes: string;
}

const PENDING = 'hrms.oidc.pending';
const LOGOUT = 'hrms.oidc.logout';
/** Where the provider sends the browser back (a path of this web app, registered at the provider). */
export const CALLBACK_PATH = '/signed-in';

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a);
}

/** RFC 7636 S256: the challenge of a code verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export const callbackUrl = () => `${window.location.origin}${CALLBACK_PATH}`;

/**
 * Starts a sign-in: remembers this sign-in's secrets and goes to the provider. `reauthenticate` makes the provider ask again even if its
 * own session is still open (prompt=login): after a first sign-in in which the authenticator app was only set up, the provider's
 * session does not count as signed in with it, and only a full sign-in (password and a code from the app) does.
 */
export async function startOidcSignIn(
  c: OidcSignInConfig,
  go: (url: string) => void = (url) => window.location.assign(url),
  options: { reauthenticate?: boolean } = {},
): Promise<void> {
  const pending = { state: randomToken(), nonce: randomToken(), verifier: randomToken(48) };
  sessionStorage.setItem(PENDING, JSON.stringify(pending));
  const url = new URL(c.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', callbackUrl());
  url.searchParams.set('scope', c.scopes);
  url.searchParams.set('state', pending.state);
  url.searchParams.set('nonce', pending.nonce);
  url.searchParams.set('code_challenge', await pkceChallenge(pending.verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  if (options.reauthenticate) url.searchParams.set('prompt', 'login');
  go(url.toString());
}

/** Back from the provider: checks the state and exchanges the code for the ID token, to be handed to the API with the nonce. */
export async function completeOidcSignIn(c: OidcSignInConfig, search: string): Promise<{ idToken: string; nonce: string }> {
  const params = new URLSearchParams(search);
  const saved = (() => {
    try {
      return JSON.parse(sessionStorage.getItem(PENDING) ?? 'null') as { state: string; nonce: string; verifier: string } | null;
    } catch {
      return null;
    }
  })();
  sessionStorage.removeItem(PENDING);
  if (params.get('error')) throw new Error(params.get('error_description') ?? 'The sign-in was not completed at the provider');
  const code = params.get('code');
  if (!saved || !code || params.get('state') !== saved.state) throw new Error('This sign-in could not be matched to this browser tab; sign in again');
  const res = await fetch(c.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl(), client_id: c.clientId, code_verifier: saved.verifier }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { id_token?: string };
  if (!res.ok || !body.id_token) throw new Error('The sign-in provider did not complete the sign-in; sign in again');
  return { idToken: body.id_token, nonce: saved.nonce };
}

/** Remembered at sign-in so that signing out also ends the provider's session (else the next sign-in would not ask again). */
export function rememberProviderLogout(c: OidcSignInConfig): void {
  if (c.endSessionEndpoint) sessionStorage.setItem(LOGOUT, JSON.stringify({ endSessionEndpoint: c.endSessionEndpoint, clientId: c.clientId }));
}

/** After the HRMS sign-out: the provider's sign-out, if this session signed in there. */
export function providerLogout(go: (url: string) => void = (url) => window.location.assign(url)): void {
  const raw = sessionStorage.getItem(LOGOUT);
  sessionStorage.removeItem(LOGOUT);
  if (!raw) return;
  try {
    const { endSessionEndpoint, clientId } = JSON.parse(raw) as { endSessionEndpoint: string; clientId: string };
    const url = new URL(endSessionEndpoint);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('post_logout_redirect_uri', `${window.location.origin}/`);
    go(url.toString());
  } catch {
    /* nothing to do */
  }
}
