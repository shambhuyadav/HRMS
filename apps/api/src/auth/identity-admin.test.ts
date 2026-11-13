// The provider's user administration against a stand-in for Keycloak's admin REST API: the client-credentials token, the calls and
// their paths, a whole representation sent back on change, conflicts and failures as their own errors, a strong temporary password.
import { describe, expect, it } from 'vitest';
import { IdentityConflict, IdentityUnavailable, type KeycloakAdminConfig, keycloakAdminConfigFromEnv, keycloakIdentityAdmin, temporaryPassword } from './identity-admin.js';

const config = { baseUrl: 'http://kc.invalid/kc', realm: 'hrms', tokenRealm: 'hrms', clientId: 'hrms-user-admin', credentials: { kind: 'client' as const, secret: 'synthetic-secret' } };

function stand(responses: Record<string, (body: unknown) => Response>, cfg: KeycloakAdminConfig = config) {
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  const fake = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const body = raw instanceof URLSearchParams ? Object.fromEntries(raw) : typeof raw === 'string' ? JSON.parse(raw) : undefined;
    calls.push({ method, url, body, auth: new Headers(init?.headers).get('authorization') });
    if (url.endsWith('/protocol/openid-connect/token')) return Response.json({ access_token: 'tok', expires_in: 300 });
    const key = `${method} ${url.replace(`${config.baseUrl}/admin/realms/hrms`, '')}`;
    const handler = responses[key];
    return handler ? handler(body) : new Response('not stubbed', { status: 500 });
  }) as typeof fetch;
  return { calls, admin: keycloakIdentityAdmin(cfg, fake) };
}

describe('Keycloak user administration', () => {
  it('signs in with client credentials once and creates a sign-in with a temporary password and the first-sign-in actions', async () => {
    const { calls, admin } = stand({
      'POST /users': () => new Response(null, { status: 201, headers: { location: `${config.baseUrl}/admin/realms/hrms/users/u-1` } }),
      'PUT /users/u-1/reset-password': () => new Response(null, { status: 204 }),
    });
    expect(await admin.create({ email: 'syn@example.invalid', firstName: 'Syn', lastName: 'Person', temporaryPassword: 'Abcd-2345-efgh-6789' })).toBe('u-1');
    await admin.setTemporaryPassword('u-1', 'Wxyz-2345-efgh-6789');
    const token = calls.filter((c) => c.url.endsWith('/token'));
    expect(token).toHaveLength(1);
    expect(token[0]!.body).toEqual({ grant_type: 'client_credentials', client_id: 'hrms-user-admin', client_secret: 'synthetic-secret' });
    const created = calls.find((c) => c.method === 'POST' && c.url.endsWith('/users'))!;
    expect(created.auth).toBe('Bearer tok');
    expect(created.body).toMatchObject({
      username: 'syn@example.invalid',
      email: 'syn@example.invalid',
      emailVerified: true,
      enabled: true,
      requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
      credentials: [{ type: 'password', value: 'Abcd-2345-efgh-6789', temporary: true }],
    });
    expect(calls.find((c) => c.url.endsWith('/reset-password'))!.body).toEqual({ type: 'password', value: 'Wxyz-2345-efgh-6789', temporary: true });
  });

  it('sends the whole representation back with a change, and reads a taken email and a failure as their own errors', async () => {
    const { calls, admin } = stand({
      'GET /users/u-1': () => Response.json({ id: 'u-1', username: 'a@example.invalid', email: 'a@example.invalid', firstName: 'A', lastName: 'B', enabled: true, attributes: { x: ['1'] } }),
      'PUT /users/u-1': () => new Response(null, { status: 204 }),
      'POST /users': () => new Response(null, { status: 409 }),
      'DELETE /users/u-2': () => new Response(null, { status: 503 }),
    });
    await admin.update('u-1', { email: 'c@example.invalid', lastName: 'D' });
    expect(calls.find((c) => c.method === 'PUT')!.body).toMatchObject({ email: 'c@example.invalid', username: 'c@example.invalid', firstName: 'A', lastName: 'D', attributes: { x: ['1'] } });
    await expect(admin.create({ email: 'a@example.invalid', firstName: 'A', lastName: 'B', temporaryPassword: 'x' })).rejects.toBeInstanceOf(IdentityConflict);
    await expect(admin.remove('u-2')).rejects.toBeInstanceOf(IdentityUnavailable);
  });

  it('is configured from the environment only when all its settings are there: a login (the server’s) or a client', () => {
    expect(keycloakAdminConfigFromEnv({})).toBeNull();
    expect(keycloakAdminConfigFromEnv({ KEYCLOAK_ADMIN_URL: 'http://127.0.0.1:8080/kc', KEYCLOAK_ADMIN_USERNAME: 'u' })).toBeNull();
    expect(keycloakAdminConfigFromEnv({ KEYCLOAK_ADMIN_URL: 'http://127.0.0.1:8080/kc/', KEYCLOAK_ADMIN_CLIENT_ID: 'c', KEYCLOAK_ADMIN_CLIENT_SECRET: 's' })).toEqual({
      baseUrl: 'http://127.0.0.1:8080/kc',
      realm: 'hrms',
      tokenRealm: 'hrms',
      clientId: 'c',
      credentials: { kind: 'client', secret: 's' },
    });
    expect(
      keycloakAdminConfigFromEnv({
        KEYCLOAK_ADMIN_URL: 'http://127.0.0.1:8080/kc',
        KEYCLOAK_ADMIN_TOKEN_REALM: 'master',
        KEYCLOAK_ADMIN_USERNAME: 'hrms-user-admin',
        KEYCLOAK_ADMIN_PASSWORD: 'synthetic-password',
      }),
    ).toEqual({
      baseUrl: 'http://127.0.0.1:8080/kc',
      realm: 'hrms',
      tokenRealm: 'master',
      clientId: 'admin-cli',
      credentials: { kind: 'password', username: 'hrms-user-admin', password: 'synthetic-password' },
    });
  });

  it('with a login, signs in to its own realm by password through admin-cli and administers the hrms realm', async () => {
    const login: KeycloakAdminConfig = { ...config, tokenRealm: 'master', clientId: 'admin-cli', credentials: { kind: 'password', username: 'hrms-user-admin', password: 'synthetic-password' } };
    const { calls, admin } = stand({ 'GET /users/u-9': () => Response.json({ id: 'u-9', email: 'z@example.invalid', enabled: true }) }, login);
    expect(await admin.get('u-9')).toMatchObject({ id: 'u-9', email: 'z@example.invalid' });
    const token = calls.find((c) => c.url.endsWith('/token'))!;
    expect(token.url).toBe('http://kc.invalid/kc/realms/master/protocol/openid-connect/token');
    expect(token.body).toEqual({ grant_type: 'password', client_id: 'admin-cli', username: 'hrms-user-admin', password: 'synthetic-password' });
    expect(calls.find((c) => c.method === 'GET' && c.url.includes('/users/'))!.url).toBe('http://kc.invalid/kc/admin/realms/hrms/users/u-9');
  });

  it('makes temporary passwords the realm accepts: 16 characters in 4 groups, a capital, a small letter and a digit, never the same', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = temporaryPassword();
      expect(p).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[2-9]/);
      expect(p).not.toMatch(/[01OoIl]/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });
});
