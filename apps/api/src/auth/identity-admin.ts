// The sign-in provider's user administration (owner request of 13 Nov 2026: the System Administrator creates, edits, deletes and
// resets the password of accounts from the HRMS, not on the server). The provider (Keycloak, ADR-06) keeps the passwords and the
// second factor; the HRMS asks it, through a client of its own that can manage users of the HRMS realm and nothing else
// (deploy/keycloak/configure-user-admin.sh), to:
//   - create a person's sign-in with a one-time temporary password: at the first sign-in they choose their own password and set up
//     an authenticator app (the same required actions as the accounts the set-up scripts create);
//   - change their name and email; give them a new temporary password (their authenticator app stays: a password alone never
//     signs anyone in, so a reset never hands an administrator someone else's account); sign them out; enable or disable the
//     sign-in; delete it.
// No password is ever logged, audited or stored by the HRMS: a temporary one is returned once, to be handed over.
import { randomInt } from 'node:crypto';

export interface IdentityPerson {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  enabled: boolean;
}

export interface IdentityAdmin {
  /** The person's sign-in by the provider's id (the subject the HRMS recorded at the first sign-in), or null. */
  get(id: string): Promise<IdentityPerson | null>;
  /** The person's sign-in by email (exact), or null. */
  findByEmail(email: string): Promise<IdentityPerson | null>;
  /** Creates a sign-in with a temporary password; returns its id. Throws IdentityConflict when the email is taken. */
  create(input: { email: string; firstName: string; lastName: string; temporaryPassword: string }): Promise<string>;
  update(id: string, change: { email?: string; firstName?: string; lastName?: string; enabled?: boolean }): Promise<void>;
  /** A new temporary password (the person must choose their own at the next sign-in). */
  setTemporaryPassword(id: string, password: string): Promise<void>;
  /** Ends every session the person has at the provider. */
  signOut(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** The email is already used by another sign-in at the provider. */
export class IdentityConflict extends Error {}
/** The provider could not be reached or refused the call. */
export class IdentityUnavailable extends Error {}

// Readable and long enough for the realm's policy (length 12, not the username or email): 4 groups of 4 from an alphabet without
// look-alike characters, with a capital, a small letter and a digit always present.
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnpqrstuvwxyz';
const DIGIT = '23456789';
export function temporaryPassword(): string {
  const all = UPPER + LOWER + DIGIT;
  const chars = Array.from({ length: 16 }, () => all[randomInt(all.length)]!);
  // One of each kind at random places.
  const places = new Set<number>();
  while (places.size < 3) places.add(randomInt(16));
  const [a, b, c] = [...places];
  chars[a!] = UPPER[randomInt(UPPER.length)]!;
  chars[b!] = LOWER[randomInt(LOWER.length)]!;
  chars[c!] = DIGIT[randomInt(DIGIT.length)]!;
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}

export interface KeycloakAdminConfig {
  /** Keycloak's base address as the server reaches it, e.g. http://127.0.0.1:8080/kc. */
  baseUrl: string;
  /** The realm whose users are administered (hrms). */
  realm: string;
  /** The realm the HRMS signs in to for its token: the administered realm itself, or master (the server's set-up). */
  tokenRealm: string;
  clientId: string;
  /**
   * How the HRMS signs in: a confidential client's own service account, or a dedicated login (username and password) through a
   * public client such as admin-cli. The server uses the login: Keycloak 26.8 refuses service-account tokens on its admin API
   * while it accepts a login's (found on this server on 14 Nov 2026; deploy/keycloak/configure-user-admin.sh).
   */
  credentials: { kind: 'client'; secret: string } | { kind: 'password'; username: string; password: string };
}

/**
 * From the environment; null when incomplete. KEYCLOAK_ADMIN_URL, KEYCLOAK_REALM (default hrms), KEYCLOAK_ADMIN_TOKEN_REALM (default
 * the realm), and either KEYCLOAK_ADMIN_USERNAME + KEYCLOAK_ADMIN_PASSWORD (with KEYCLOAK_ADMIN_CLIENT_ID, default admin-cli) or
 * KEYCLOAK_ADMIN_CLIENT_ID + KEYCLOAK_ADMIN_CLIENT_SECRET.
 */
export function keycloakAdminConfigFromEnv(env: NodeJS.ProcessEnv = process.env): KeycloakAdminConfig | null {
  const baseUrl = env.KEYCLOAK_ADMIN_URL?.trim();
  if (!baseUrl) return null;
  const realm = env.KEYCLOAK_REALM?.trim() || 'hrms';
  const tokenRealm = env.KEYCLOAK_ADMIN_TOKEN_REALM?.trim() || realm;
  const username = env.KEYCLOAK_ADMIN_USERNAME?.trim();
  const password = env.KEYCLOAK_ADMIN_PASSWORD;
  const common = { baseUrl: baseUrl.replace(/\/+$/, ''), realm, tokenRealm };
  if (username && password) return { ...common, clientId: env.KEYCLOAK_ADMIN_CLIENT_ID?.trim() || 'admin-cli', credentials: { kind: 'password', username, password } };
  const clientId = env.KEYCLOAK_ADMIN_CLIENT_ID?.trim();
  const secret = env.KEYCLOAK_ADMIN_CLIENT_SECRET?.trim();
  if (!clientId || !secret) return null;
  return { ...common, clientId, credentials: { kind: 'client', secret } };
}

interface KeycloakUser {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
}

const person = (u: KeycloakUser): IdentityPerson => ({ id: u.id, email: u.email ?? null, firstName: u.firstName ?? null, lastName: u.lastName ?? null, enabled: u.enabled !== false });

/** Keycloak's admin REST API, as the HRMS's own service-account client (client credentials; a fresh token when the last expires). */
export function keycloakIdentityAdmin(config: KeycloakAdminConfig, fetchImpl: typeof fetch = fetch): IdentityAdmin {
  let token: { value: string; until: number } | null = null;
  const admin = `${config.baseUrl}/admin/realms/${encodeURIComponent(config.realm)}`;

  async function accessToken(): Promise<string> {
    if (token && token.until > Date.now()) return token.value;
    let res: Response;
    try {
      const c = config.credentials;
      const form =
        c.kind === 'client'
          ? { grant_type: 'client_credentials', client_id: config.clientId, client_secret: c.secret }
          : { grant_type: 'password', client_id: config.clientId, username: c.username, password: c.password };
      res = await fetchImpl(`${config.baseUrl}/realms/${encodeURIComponent(config.tokenRealm)}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      throw new IdentityUnavailable(`sign-in provider unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) throw new IdentityUnavailable(`sign-in provider refused the HRMS client (${res.status})`);
    const body = (await res.json()) as { access_token: string; expires_in?: number };
    // Renewed 15 seconds early, so a token never expires on its way.
    token = { value: body.access_token, until: Date.now() + Math.max(5, (body.expires_in ?? 60) - 15) * 1000 };
    return token.value;
  }

  async function call(method: string, path: string, body?: unknown): Promise<Response> {
    const bearer = await accessToken();
    let res: Response;
    try {
      res = await fetchImpl(`${admin}${path}`, {
        method,
        headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new IdentityUnavailable(`sign-in provider unreachable: ${(err as Error).message}`);
    }
    if (res.status === 401) token = null;
    return res;
  }
  const failed = async (what: string, res: Response) => new IdentityUnavailable(`${what} failed at the sign-in provider (${res.status})`);

  return {
    async get(id) {
      const res = await call('GET', `/users/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await failed('Reading the sign-in', res);
      return person((await res.json()) as KeycloakUser);
    },
    async findByEmail(email) {
      const res = await call('GET', `/users?email=${encodeURIComponent(email)}&exact=true`);
      if (!res.ok) throw await failed('Finding the sign-in', res);
      const found = ((await res.json()) as KeycloakUser[]).find((u) => u.email?.toLowerCase() === email.toLowerCase());
      return found ? person(found) : null;
    },
    async create(input) {
      const res = await call('POST', '/users', {
        username: input.email,
        email: input.email,
        firstName: input.firstName,
        lastName: input.lastName,
        enabled: true,
        emailVerified: true,
        requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
        credentials: [{ type: 'password', value: input.temporaryPassword, temporary: true }],
      });
      if (res.status === 409) throw new IdentityConflict('The email is already used by another sign-in');
      if (!res.ok) throw await failed('Creating the sign-in', res);
      const id = res.headers.get('location')?.split('/').pop();
      if (id) return id;
      const made = await this.findByEmail(input.email);
      if (!made) throw new IdentityUnavailable('The sign-in was created but could not be found');
      return made.id;
    },
    async update(id, change) {
      const current = await call('GET', `/users/${encodeURIComponent(id)}`);
      if (!current.ok) throw await failed('Reading the sign-in', current);
      // The whole representation goes back with the changes (a partial one would clear the fields it leaves out).
      const user = { ...((await current.json()) as Record<string, unknown>) };
      if (change.email !== undefined) Object.assign(user, { email: change.email, username: change.email, emailVerified: true });
      if (change.firstName !== undefined) user.firstName = change.firstName;
      if (change.lastName !== undefined) user.lastName = change.lastName;
      if (change.enabled !== undefined) user.enabled = change.enabled;
      const res = await call('PUT', `/users/${encodeURIComponent(id)}`, user);
      if (res.status === 409) throw new IdentityConflict('The email is already used by another sign-in');
      if (!res.ok) throw await failed('Changing the sign-in', res);
    },
    async setTemporaryPassword(id, password) {
      const res = await call('PUT', `/users/${encodeURIComponent(id)}/reset-password`, { type: 'password', value: password, temporary: true });
      if (!res.ok) throw await failed('Setting the temporary password', res);
    },
    async signOut(id) {
      const res = await call('POST', `/users/${encodeURIComponent(id)}/logout`);
      if (!res.ok && res.status !== 404) throw await failed('Signing the person out', res);
    },
    async remove(id) {
      const res = await call('DELETE', `/users/${encodeURIComponent(id)}`);
      if (!res.ok && res.status !== 404) throw await failed('Deleting the sign-in', res);
    },
  };
}

/** An in-memory provider for tests and the development server: the same rules, nothing leaves the process. */
export function memoryIdentityAdmin(): IdentityAdmin & { people: Map<string, IdentityPerson & { password: string | null; temporary: boolean; signedOut: number }> } {
  const people = new Map<string, IdentityPerson & { password: string | null; temporary: boolean; signedOut: number }>();
  let next = 1;
  const byEmail = (email: string) => [...people.values()].find((p) => p.email?.toLowerCase() === email.toLowerCase()) ?? null;
  const view = (p: IdentityPerson): IdentityPerson => ({ id: p.id, email: p.email, firstName: p.firstName, lastName: p.lastName, enabled: p.enabled });
  return {
    people,
    async get(id) {
      const p = people.get(id);
      return p ? view(p) : null;
    },
    async findByEmail(email) {
      const p = byEmail(email);
      return p ? view(p) : null;
    },
    async create(input) {
      if (byEmail(input.email)) throw new IdentityConflict('The email is already used by another sign-in');
      const id = `idp-${next++}`;
      people.set(id, { id, email: input.email, firstName: input.firstName, lastName: input.lastName, enabled: true, password: input.temporaryPassword, temporary: true, signedOut: 0 });
      return id;
    },
    async update(id, change) {
      const p = people.get(id);
      if (!p) throw new IdentityUnavailable('No such sign-in');
      if (change.email !== undefined) {
        const other = byEmail(change.email);
        if (other && other.id !== id) throw new IdentityConflict('The email is already used by another sign-in');
        p.email = change.email;
      }
      if (change.firstName !== undefined) p.firstName = change.firstName;
      if (change.lastName !== undefined) p.lastName = change.lastName;
      if (change.enabled !== undefined) p.enabled = change.enabled;
    },
    async setTemporaryPassword(id, password) {
      const p = people.get(id);
      if (!p) throw new IdentityUnavailable('No such sign-in');
      p.password = password;
      p.temporary = true;
    },
    async signOut(id) {
      const p = people.get(id);
      if (p) p.signedOut++;
    },
    async remove(id) {
      people.delete(id);
    },
  };
}
