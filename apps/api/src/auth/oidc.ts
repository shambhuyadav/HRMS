// Production sign-in through an OIDC provider (ADR-06; owner decision of 9 Nov 2026: Keycloak, self-hosted; T-03). The browser signs in at
// the provider (authorization code with PKCE) and hands the provider's ID token to the API, which
//   1. verifies it against the provider's published keys: issuer, audience (this client), signature, lifetime and the nonce the browser
//      generated for this sign-in; a verified email; and, where required, a second factor (amr or acr);
//   2. finds the HRMS account: by the linked provider identity (issuer + subject), or on a first sign-in by the verified email as the
//      account key, linking the identity from then on (migration 0244); an inactive or unknown account is refused;
//   3. opens a server-side session (DF10: 30 minutes idle, 12 hours absolute, revocable) and issues the HRMS session token the API
//      accepts (auth/tokens.ts), as the development sign-in does for synthetic accounts.
// The provider's metadata may be read from an internal address (the provider behind the same reverse proxy), while the issuer the tokens
// carry and the endpoints the browser uses stay public.
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Queryable } from '../db/queryable.js';
import { HttpError } from '../http/errors.js';

export interface OidcConfig {
  /** The issuer the provider's tokens carry (public), e.g. https://hr.example.com/kc/realms/hrms. */
  issuer: string;
  /** This application's client id at the provider: the ID token's audience. */
  clientId: string;
  /** Where the server reads the provider's metadata; the issuer's well-known document unless given (e.g. an internal address). */
  discoveryUrl?: string;
  /** Where the server reads the provider's signing keys; the metadata's jwks_uri unless given. */
  jwksUri?: string;
  /** Refuse a sign-in without a second factor (ADR-06: MFA in production). */
  requireMfa: boolean;
  /** amr values that prove a second factor (e.g. otp, mfa, hwk). */
  mfaAmr: readonly string[];
  /** acr values that prove a second factor (a provider that states the level of assurance instead). */
  mfaAcr: readonly string[];
  scopes: string;
}

export interface BrowserSignIn {
  mode: 'OIDC';
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  endSessionEndpoint: string | null;
  scopes: string;
}

export interface ProviderIdentity {
  issuer: string;
  subject: string;
  email: string;
}

export interface OidcProvider {
  browser: BrowserSignIn;
  verifyIdToken(idToken: string, nonce: string): Promise<ProviderIdentity>;
}

/** A refusal at sign-in: always 401, with a code the browser can explain; nothing about the token or the account is echoed. */
const refuse = (code: string, message: string) => new HttpError(401, code, message);

/** Reads the provider's metadata once and returns the verifier (a test may pass its own key set). */
export async function oidcProvider(config: OidcConfig, opts: { fetch?: typeof fetch; jwks?: JWTVerifyGetKey } = {}): Promise<OidcProvider> {
  const get = opts.fetch ?? fetch;
  const discoveryUrl = config.discoveryUrl ?? `${config.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await get(discoveryUrl, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OIDC discovery failed at ${discoveryUrl}: HTTP ${res.status}`);
  const meta = (await res.json()) as { authorization_endpoint?: string; token_endpoint?: string; end_session_endpoint?: string; jwks_uri?: string };
  if (!meta.authorization_endpoint || !meta.token_endpoint || (!meta.jwks_uri && !config.jwksUri && !opts.jwks)) {
    throw new Error('OIDC discovery document lacks authorization_endpoint, token_endpoint or jwks_uri');
  }
  const jwks = opts.jwks ?? createRemoteJWKSet(new URL(config.jwksUri ?? meta.jwks_uri!));
  return {
    browser: {
      mode: 'OIDC',
      issuer: config.issuer,
      clientId: config.clientId,
      authorizationEndpoint: meta.authorization_endpoint,
      tokenEndpoint: meta.token_endpoint,
      endSessionEndpoint: meta.end_session_endpoint ?? null,
      scopes: config.scopes,
    },
    async verifyIdToken(idToken, nonce) {
      let payload: Record<string, unknown>;
      try {
        ({ payload } = await jwtVerify(idToken, jwks, {
          issuer: config.issuer,
          audience: config.clientId,
          algorithms: ['RS256', 'PS256', 'ES256'],
          requiredClaims: ['sub', 'iat', 'exp', 'nonce'],
          // An ID token is handed over right after the provider issued it; an old one is not accepted.
          maxTokenAge: '10m',
        }));
      } catch {
        throw refuse('SIGN_IN_TOKEN_INVALID', 'The sign-in could not be verified; sign in again');
      }
      // OIDC Core 3.1.3.7: with several audiences the authorised party must be this client.
      if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== config.clientId) throw refuse('SIGN_IN_TOKEN_INVALID', 'The sign-in could not be verified; sign in again');
      if (typeof nonce !== 'string' || nonce.length < 16 || payload.nonce !== nonce) throw refuse('SIGN_IN_TOKEN_INVALID', 'The sign-in could not be verified; sign in again');
      const subject = payload.sub;
      const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
      if (typeof subject !== 'string' || subject.trim() === '' || subject.length > 255) throw refuse('SIGN_IN_TOKEN_INVALID', 'The sign-in could not be verified; sign in again');
      if (!email || payload.email_verified !== true) throw refuse('SIGN_IN_EMAIL_UNVERIFIED', 'Your email address is not verified at the sign-in provider');
      if (config.requireMfa) {
        const amr = Array.isArray(payload.amr) ? payload.amr.filter((x): x is string => typeof x === 'string') : [];
        const acr = typeof payload.acr === 'string' ? payload.acr : '';
        if (!amr.some((m) => config.mfaAmr.includes(m)) && !config.mfaAcr.includes(acr)) {
          throw refuse('SIGN_IN_MFA_REQUIRED', 'Sign in with a second factor (an authenticator app) to use HRMS');
        }
      }
      return { issuer: config.issuer, subject, email };
    },
  };
}

/**
 * The HRMS account of a verified provider identity: the linked account, or on a first sign-in the active account whose key is the
 * verified email, which this links for good. Refused (401): no such active account, or the account is already linked to another
 * identity at this provider.
 */
export async function accountOf(db: Queryable, identity: ProviderIdentity): Promise<string> {
  const linked = (
    await db.query<{ user_id: string; active: boolean }>(
      `select l.user_id, u.active from user_external_identity l join user_account u on u.id = l.user_id where l.issuer = $1 and l.subject = $2`,
      [identity.issuer, identity.subject],
    )
  ).rows[0];
  if (linked) {
    if (!linked.active) throw refuse('SIGN_IN_ACCOUNT_INACTIVE', 'Your HRMS account is not active; contact your administrator');
    return linked.user_id;
  }
  const account = (await db.query<{ id: string; active: boolean }>(`select id, active from user_account where account_key = $1`, [identity.email])).rows[0];
  if (!account) throw refuse('SIGN_IN_NO_ACCOUNT', 'There is no HRMS account for this sign-in; contact your administrator');
  if (!account.active) throw refuse('SIGN_IN_ACCOUNT_INACTIVE', 'Your HRMS account is not active; contact your administrator');
  const inserted = await db.query(
    `insert into user_external_identity (user_id, issuer, subject) values ($1, $2, $3) on conflict do nothing returning id`,
    [account.id, identity.issuer, identity.subject],
  );
  if (inserted.rowCount === 0) {
    // Linked meanwhile: the same identity (a concurrent first sign-in) is fine; another identity for this account is not.
    const same = await db.query(`select 1 from user_external_identity where user_id = $1 and issuer = $2 and subject = $3`, [account.id, identity.issuer, identity.subject]);
    if (same.rowCount === 0) throw refuse('SIGN_IN_IDENTITY_MISMATCH', 'This HRMS account is linked to another sign-in identity; contact your administrator');
  }
  return account.id;
}

/** The OIDC configuration from the environment (production entry point); null when OIDC_ISSUER is not set. */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuer = env.OIDC_ISSUER?.trim();
  if (!issuer) return null;
  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!clientId) throw new Error('OIDC_CLIENT_ID must be set with OIDC_ISSUER');
  const list = (v: string | undefined, fallback: string[]) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : fallback);
  return {
    issuer,
    clientId,
    ...(env.OIDC_DISCOVERY_URL ? { discoveryUrl: env.OIDC_DISCOVERY_URL.trim() } : {}),
    ...(env.OIDC_JWKS_URI ? { jwksUri: env.OIDC_JWKS_URI.trim() } : {}),
    requireMfa: env.OIDC_REQUIRE_MFA !== 'false',
    mfaAmr: list(env.OIDC_MFA_AMR, ['otp', 'mfa', 'hwk', 'swk']),
    mfaAcr: list(env.OIDC_MFA_ACR, []),
    scopes: env.OIDC_SCOPES?.trim() || 'openid email profile',
  };
}
