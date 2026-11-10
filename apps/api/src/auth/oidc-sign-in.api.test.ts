// Production sign-in through an OIDC provider (ADR-06; Keycloak by the owner's decision of 9 Nov 2026; migration 0244), against the real
// app and database with a provider stood in by a local RSA key set: the provider's ID token is verified (issuer, audience, signature,
// lifetime, nonce, verified email, a second factor), the account is found by email on the first sign-in and the provider identity linked
// for good, a server-side session opens and the HRMS session token works on /v1. Every refusal is a 401 with a code, nothing echoed.
import { exportJWK, generateKeyPair, type JWK, createLocalJWKSet, SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import { COMPANY_HEADER } from '../http/context.js';
import { type Company, type Harness, startHarness, type TestActor } from '../test/harness.js';
import { oidcConfigFromEnv, oidcProvider, type OidcConfig } from './oidc.js';
import { sessionTokenVerifier } from './tokens.js';

const ISSUER = 'https://hr.example.test/kc/realms/hrms';
const CLIENT = 'hrms-web';
const NONCE = 'n0nce-0123456789abcdef';

describe('OIDC sign-in (ADR-06)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let app: FastifyInstance;
  let key: CryptoKey;
  let otherKey: CryptoKey;
  let email: string;
  const tokens = { issuer: 'hrms', audience: 'hrms-api', secret: 'production-like-session-secret-of-40-chars!' };
  const config: OidcConfig = { issuer: ISSUER, clientId: CLIENT, requireMfa: true, mfaAmr: ['otp', 'mfa'], mfaAcr: [], scopes: 'openid email profile' };

  /** An ID token as the provider issues it (overridable claim by claim, or signed with another key). */
  const idToken = async (claims: Record<string, unknown> = {}, opts: { signWith?: CryptoKey; iatOffset?: number } = {}) => {
    const now = Math.floor(Date.now() / 1000) + (opts.iatOffset ?? 0);
    return new SignJWT({ nonce: NONCE, email, email_verified: true, amr: ['pwd', 'otp'], ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(String(claims.iss ?? ISSUER))
      .setAudience((claims.aud as string) ?? CLIENT)
      .setSubject(String(claims.sub ?? 'kc-subject-1'))
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(opts.signWith ?? key);
  };
  const signIn = (token: string, nonce = NONCE) => app.inject({ method: 'POST', url: '/sign-in/oidc', payload: { idToken: token, nonce } });
  const codeOf = async (token: string, nonce?: string) => {
    const res = await signIn(token, nonce);
    return [res.statusCode, res.json().error];
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    email = (await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [hr.user])).account_key;
    const pair = await generateKeyPair('RS256');
    key = pair.privateKey as CryptoKey;
    otherKey = (await generateKeyPair('RS256')).privateKey as CryptoKey;
    const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const discovery = {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
      token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
      end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
      jwks_uri: `${ISSUER}/protocol/openid-connect/certs`,
    };
    const fetchStub = (async (url: string) => {
      expect(url).toBe(`${ISSUER}/.well-known/openid-configuration`);
      return new Response(JSON.stringify(discovery), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const provider = await oidcProvider(config, { fetch: fetchStub, jwks: createLocalJWKSet({ keys: [jwk] }) });
    app = buildApp({ db: h.pool, verifier: sessionTokenVerifier(tokens), oidc: { provider, tokens } });
    await app.ready();
  }, 300_000);

  afterAll(async () => {
    await app?.close();
    await h?.stop();
  });

  it('tells the browser where to sign in, and offers no development sign-in', async () => {
    const res = await app.inject({ method: 'GET', url: '/sign-in/config' });
    expect(res.json()).toEqual({
      mode: 'OIDC',
      issuer: ISSUER,
      clientId: CLIENT,
      authorizationEndpoint: `${ISSUER}/protocol/openid-connect/auth`,
      tokenEndpoint: `${ISSUER}/protocol/openid-connect/token`,
      endSessionEndpoint: `${ISSUER}/protocol/openid-connect/logout`,
      scopes: 'openid email profile',
    });
    expect((await app.inject({ method: 'POST', url: '/dev/login', payload: { accountKey: email } })).statusCode).toBe(404);
  });

  it('a verified sign-in with a second factor opens a session whose token works on /v1, and links the provider identity', async () => {
    const res = await signIn(await idToken());
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { token: string; companies: { id: string }[] };
    expect(body.companies.map((c) => c.id)).toEqual([A.id]);
    const mine = await app.inject({ method: 'GET', url: '/v1/me/assignments', headers: { authorization: `Bearer ${body.token}`, [COMPANY_HEADER]: A.id } });
    expect(mine.statusCode).toBe(200);
    expect(mine.json().items).toMatchObject([{ roleCode: 'HR_ADMINISTRATOR' }]);
    expect(await h.one(`select issuer, subject from user_external_identity where user_id = $1`, [hr.user])).toEqual({ issuer: ISSUER, subject: 'kc-subject-1' });
    // The session is a real one: signing out ends it.
    await app.inject({ method: 'POST', url: '/v1/me/logout', headers: { authorization: `Bearer ${body.token}`, [COMPANY_HEADER]: A.id } });
    expect((await app.inject({ method: 'GET', url: '/v1/me/assignments', headers: { authorization: `Bearer ${body.token}`, [COMPANY_HEADER]: A.id } })).statusCode).toBe(401);
  });

  it('once linked, the link decides: the same identity signs in again; another identity with the same email is refused', async () => {
    expect((await signIn(await idToken())).statusCode).toBe(200);
    expect(await codeOf(await idToken({ sub: 'kc-someone-else' }))).toEqual([401, 'SIGN_IN_IDENTITY_MISMATCH']);
    // The link is never changed.
    await expect(h.db.query(`update user_external_identity set subject = 'x' where user_id = $1`, [hr.user])).rejects.toThrow();
  });

  it('refuses a token it cannot trust: another key, issuer or audience, a wrong nonce, an old token', async () => {
    expect(await codeOf(await idToken({}, { signWith: otherKey }))).toEqual([401, 'SIGN_IN_TOKEN_INVALID']);
    expect(await codeOf(await idToken({ iss: 'https://evil.example.test/realms/hrms' }))).toEqual([401, 'SIGN_IN_TOKEN_INVALID']);
    expect(await codeOf(await idToken({ aud: 'another-client' }))).toEqual([401, 'SIGN_IN_TOKEN_INVALID']);
    expect(await codeOf(await idToken(), 'another-nonce-0123456789')).toEqual([401, 'SIGN_IN_TOKEN_INVALID']);
    expect(await codeOf(await idToken({}, { iatOffset: -3600 }))).toEqual([401, 'SIGN_IN_TOKEN_INVALID']);
    expect((await signIn('not.a.token-at-all-really', NONCE)).statusCode).toBe(401);
  });

  it('needs a verified email and a second factor (ADR-06: MFA)', async () => {
    expect(await codeOf(await idToken({ email_verified: false }))).toEqual([401, 'SIGN_IN_EMAIL_UNVERIFIED']);
    expect(await codeOf(await idToken({ amr: ['pwd'] }))).toEqual([401, 'SIGN_IN_MFA_REQUIRED']);
    expect(await codeOf(await idToken({ amr: undefined }))).toEqual([401, 'SIGN_IN_MFA_REQUIRED']);
  });

  it('an unknown email or an inactive account is refused, and nothing is linked', async () => {
    expect(await codeOf(await idToken({ email: 'nobody@example.test', sub: 'kc-nobody' }))).toEqual([401, 'SIGN_IN_NO_ACCOUNT']);
    const inactive = (await h.one<{ id: string }>(`insert into user_account (account_key, active) values ('left@example.test', false) returning id`)).id;
    expect(await codeOf(await idToken({ email: 'left@example.test', sub: 'kc-left' }))).toEqual([401, 'SIGN_IN_ACCOUNT_INACTIVE']);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from user_external_identity where subject in ('kc-nobody', 'kc-left') or user_id = $1`, [inactive])).n).toBe(0);
  });

  it('reads its configuration from the environment: MFA on unless switched off', () => {
    expect(oidcConfigFromEnv({})).toBeNull();
    expect(() => oidcConfigFromEnv({ OIDC_ISSUER: ISSUER })).toThrow('OIDC_CLIENT_ID');
    expect(oidcConfigFromEnv({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: CLIENT, OIDC_JWKS_URI: 'http://127.0.0.1:8080/kc/realms/hrms/protocol/openid-connect/certs' })).toMatchObject({
      requireMfa: true,
      mfaAmr: ['otp', 'mfa', 'hwk', 'swk'],
      jwksUri: 'http://127.0.0.1:8080/kc/realms/hrms/protocol/openid-connect/certs',
    });
    expect(oidcConfigFromEnv({ OIDC_ISSUER: ISSUER, OIDC_CLIENT_ID: CLIENT, OIDC_REQUIRE_MFA: 'false' })?.requireMfa).toBe(false);
  });
});
