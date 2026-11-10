// End-to-end check of the production sign-in on the server, the way a browser does it, through nginx (https://127.0.0.1, trusting the
// server's own certificate): a temporary synthetic Keycloak user signs in with the authorization code flow and PKCE, sets up an
// authenticator app (CONFIGURE_TOTP), signs in a second time and must be asked for the one-time code, and both ID tokens are handed to
// the HRMS API (POST /sign-in/oidc). The user has no HRMS account, so the API's answer must be SIGN_IN_NO_ACCOUNT: everything before
// the account lookup (issuer, audience, signature, nonce, verified email, second factor) passed. The temporary user is always deleted.
//
//   sudo NODE_EXTRA_CA_CERTS=/etc/hrms/tls/hrms.crt node /var/www/html/HRMS/deploy/scripts/verify-sign-in.mjs
// (reads /etc/hrms/keycloak.env and /etc/hrms/hrms.env itself).
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

for (const file of ['/etc/hrms/keycloak.env', '/etc/hrms/hrms.env']) {
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}
const LOCAL = 'https://127.0.0.1';
const KC_DIRECT = 'http://127.0.0.1:8080/kc';
const issuer = process.env.OIDC_ISSUER;
const clientId = process.env.OIDC_CLIENT_ID ?? 'hrms-web';
if (!issuer || !process.env.KC_BOOTSTRAP_ADMIN_PASSWORD) throw new Error('OIDC_ISSUER or the Keycloak administrator is missing from /etc/hrms');
const publicOrigin = new URL(issuer).origin;
const redirectUri = `${publicOrigin}/signed-in`;
const local = (url) => url.replace(publicOrigin, LOCAL);
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const decodeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const results = [];
const check = (ok, what, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

function totp(secret, step = Math.floor(Date.now() / 1000 / 30)) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

function browser() {
  const jar = new Map();
  return async function go(url, init = {}) {
    const headers = { ...(init.headers ?? {}), cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') };
    const res = await fetch(local(url), { ...init, headers, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || value === '') jar.delete(name);
      else jar.set(name, value);
    }
    return res;
  };
}

/** The form with this id: its action and fields. */
function form(html, id) {
  const m = html.match(new RegExp(`<form[^>]*id="${id}"[^>]*>([\\s\\S]*?)</form>`));
  if (!m) return null;
  const action = decodeHtml(m[0].match(/action="([^"]+)"/)[1]);
  const fields = {};
  for (const input of m[1].matchAll(/<input[^>]*>/g)) {
    const name = input[0].match(/name="([^"]+)"/)?.[1];
    if (!name) continue;
    const type = input[0].match(/type="([^"]+)"/)?.[1] ?? 'text';
    if (type === 'checkbox' && !/checked/.test(input[0])) continue;
    fields[name] = decodeHtml(input[0].match(/value="([^"]*)"/)?.[1] ?? '');
  }
  return { action, fields };
}

const post = (go, f, values) =>
  go(f.action, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...f.fields, ...values }).toString() });

/** Follows Keycloak's redirects until it sends the browser back to the app (the code) or shows a page. */
async function follow(go, res) {
  for (let i = 0; i < 10 && res.status >= 300 && res.status < 400; i++) {
    const location = res.headers.get('location');
    if (location.startsWith(redirectUri)) return { back: new URL(location) };
    res = await go(new URL(location, publicOrigin).toString());
  }
  return { page: await res.text(), status: res.status };
}

async function signIn(meta, user, onPage, go = browser(), extra = {}) {
  const state = b64url(randomBytes(32));
  const nonce = b64url(randomBytes(32));
  const verifier = b64url(randomBytes(48));
  const auth = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'openid email profile', state, nonce,
    code_challenge: b64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', ...extra,
  })) auth.searchParams.set(k, v);
  let step = await follow(go, await go(auth.toString()));
  const login = step.page && form(step.page, 'kc-form-login');
  if (!login) throw new Error(`No sign-in form (HTTP ${step.status})`);
  step = await follow(go, await post(go, login, { username: user.email, password: user.password }));
  const pagesSeen = [];
  while (step.page) {
    const next = await onPage(step.page, pagesSeen);
    if (!next) throw new Error(`Stopped at an unexpected page: ${step.page.match(/<title>([^<]*)/)?.[1] ?? '?'} ${step.page.match(/kc-feedback-text[^>]*>([^<]*)/)?.[1] ?? ''}`);
    step = await follow(go, await post(go, next.form, next.values));
  }
  if (step.back.searchParams.get('state') !== state) throw new Error('state mismatch');
  const tokenRes = await go(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: step.back.searchParams.get('code'), redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }).toString(),
  });
  const tokens = await tokenRes.json();
  if (!tokens.id_token) throw new Error(`No ID token: ${JSON.stringify(tokens)}`);
  const claims = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString());
  const api = await fetch(`${LOCAL}/sign-in/oidc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: tokens.id_token, nonce }) });
  return { claims, nonce, pagesSeen, api: { status: api.status, body: await api.json().catch(() => ({})) } };
}

// ---- Keycloak administration (direct, on the server) -------------------------------------------------------------------------------
// A fresh token for every call: master-realm tokens live 60 seconds and this check takes longer.
async function adminToken() {
  const res = await fetch(`${KC_DIRECT}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: process.env.KC_BOOTSTRAP_ADMIN_USERNAME, password: process.env.KC_BOOTSTRAP_ADMIN_PASSWORD }),
  });
  const token = (await res.json()).access_token;
  if (!token) throw new Error(`Keycloak administrator sign-in failed: HTTP ${res.status}`);
  return token;
}
const admin = async (path, init = {}) =>
  fetch(`${KC_DIRECT}/admin/realms/hrms${path}`, { ...init, headers: { authorization: `Bearer ${await adminToken()}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });

const user = { email: `signin-check-${randomBytes(4).toString('hex')}@example.invalid`, password: `Check-${randomBytes(12).toString('hex')}` };
const created = await admin('/users', {
  method: 'POST',
  body: JSON.stringify({ username: user.email, email: user.email, emailVerified: true, enabled: true, firstName: 'Sign-in', lastName: 'Check', credentials: [{ type: 'password', value: user.password, temporary: false }] }),
});
if (created.status !== 201) throw new Error(`Could not create the temporary user: HTTP ${created.status} ${await created.text()}`);
const userId = created.headers.get('location').split('/').pop();
console.log(`Temporary user ${user.email} created`);

try {
  const meta = await (await fetch(`${LOCAL}/kc/realms/hrms/.well-known/openid-configuration`)).json();
  check(meta.issuer === issuer, 'the provider publishes the issuer the API expects', meta.issuer);
  const config = await (await fetch(`${LOCAL}/sign-in/config`)).json();
  check(config.mode === 'OIDC' && config.authorizationEndpoint === meta.authorization_endpoint, 'the API offers this provider to the browser');

  // 1. First sign-in: the user must set up an authenticator app. That sign-in did not use it, so the API asks for one that does.
  let secret = '';
  const firstBrowser = browser();
  const first = await signIn(meta, user, async (page, seen) => {
    const setup = form(page, 'kc-totp-settings-form');
    if (setup && !seen.includes('totp-setup')) {
      seen.push('totp-setup');
      secret = setup.fields.totpSecret;
      return { form: setup, values: { totp: totp(secret), userLabel: 'sign-in check' } };
    }
    return null;
  }, firstBrowser);
  check(first.pagesSeen.includes('totp-setup'), 'first sign-in: the authenticator app set-up is required');
  check(first.claims.nonce === first.nonce && first.claims.aud === clientId && first.claims.email_verified === true, 'first sign-in: ID token for this client, nonce and verified email');
  check(first.api.status === 401 && first.api.body.error === 'SIGN_IN_MFA_REQUIRED', 'first sign-in: the API asks for a sign-in with the code', `amr=${JSON.stringify(first.claims.amr)} → ${first.api.body.error}`);

  const nextCode = async () => {   // a code is accepted once: wait for the next 30-second step
    const wait = 30_000 - (Date.now() % 30_000) + 1500;
    console.log(`Waiting ${Math.round(wait / 1000)} s for the next one-time code…`);
    await new Promise((r) => setTimeout(r, wait));
  };
  const withCode = async (page, seen) => {
    const otp = form(page, 'kc-otp-login-form');
    if (otp && !seen.includes('otp')) {
      seen.push('otp');
      return { form: otp, values: { otp: totp(secret) } };
    }
    return null;
  };
  const accepted = (r) => r.api.status === 401 && r.api.body.error === 'SIGN_IN_NO_ACCOUNT';

  // 2. "Sign in with your code" in the same browser (the web app asks the provider to authenticate again, prompt=login).
  await nextCode();
  const again = await signIn(meta, user, withCode, firstBrowser, { prompt: 'login' });
  check(again.pagesSeen.includes('otp'), 'the same browser, signing in again: the password and the one-time code are asked for');
  check(accepted(again), 'the same browser, signing in again: the HRMS API accepts it', `amr=${JSON.stringify(again.claims.amr)} → HTTP ${again.api.status} ${again.api.body.error}`);

  // 3. A later sign-in in a new browser: the one-time code is asked for.
  await nextCode();
  const second = await signIn(meta, user, withCode);
  check(second.pagesSeen.includes('otp'), 'later sign-in: the one-time code is asked for');
  const amr = second.claims.amr ?? [];
  check(Array.isArray(amr) && amr.includes('otp'), 'later sign-in: the ID token says a second factor was used', `amr=${JSON.stringify(second.claims.amr)}`);
  check(
    accepted(second),
    'later sign-in: the HRMS API accepts the token and looks for the account (none for this synthetic user)',
    `HTTP ${second.api.status} ${second.api.body.error}`,
  );
} finally {
  const del = await admin(`/users/${userId}`, { method: 'DELETE' });
  console.log(del.status === 204 ? 'Temporary user deleted' : `COULD NOT DELETE the temporary user ${user.email}: HTTP ${del.status}`);
}
const failed = results.filter((ok) => !ok).length;
console.log(failed ? `${failed} check(s) failed` : 'All sign-in checks passed');
process.exit(failed ? 1 : 0);
