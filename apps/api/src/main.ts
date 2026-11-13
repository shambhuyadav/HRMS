// Production API entry point (NODE_ENV=production; server.ts is the development one). Everything production needs comes from the
// environment and is checked here or by buildApp before the server listens:
//   DATABASE_URL                 PostgreSQL
//   SESSION_TOKEN_SECRET         HS256 secret of the HRMS session tokens (32+ characters; auth/tokens.ts)
//   OIDC_ISSUER, OIDC_CLIENT_ID  the sign-in provider (ADR-06; owner decision of 9 Nov 2026: Keycloak); optionally OIDC_DISCOVERY_URL and
//                                OIDC_JWKS_URI (an internal address of the same provider), OIDC_REQUIRE_MFA, OIDC_MFA_AMR, OIDC_MFA_ACR
//   HRMS_FIELD_KEYS              keys of the protected private values (ADR-11)
//   HRMS_CANDIDATE_IDENTITY_KEY  candidate duplicate detection (hiring)
//   FILE_STORE_DIR               where uploads are kept (a directory on this server, backed up with the database)
//   CLAMD_SOCKET or CLAMD_HOST/CLAMD_PORT  the malware scanner (ADR-12)
//   HOST, PORT                   where to listen (127.0.0.1:3000 behind the reverse proxy unless given)
//   KEYCLOAK_ADMIN_URL, KEYCLOAK_ADMIN_TOKEN_REALM, KEYCLOAK_ADMIN_USERNAME, KEYCLOAK_ADMIN_PASSWORD (or a client id and secret;
//                                KEYCLOAK_REALM, default hrms) the provider's user administration for the User accounts screen
//                                (optional; auth/identity-admin.ts; written by deploy/keycloak/configure-user-admin.sh)
// The development sign-in, the synthetic scanner and the in-request scan are refused in production by buildApp.
import { buildApp } from './app.js';
import { keycloakAdminConfigFromEnv, keycloakIdentityAdmin } from './auth/identity-admin.js';
import { type OidcProvider, oidcConfigFromEnv, oidcProvider } from './auth/oidc.js';
import { sessionTokenVerifier } from './auth/tokens.js';
import { createPool } from './db/pool.js';
import { clamavScannerFromEnv } from './storage/clamav.js';
import { localFileStore } from './storage/files.js';

if (process.env.NODE_ENV !== 'production') throw new Error('main.ts is the production entry point: run it with NODE_ENV=production (server.ts is the development one)');
const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
};

const databaseUrl = required('DATABASE_URL');
const secret = required('SESSION_TOKEN_SECRET');
if (secret.length < 32) throw new Error('SESSION_TOKEN_SECRET must be at least 32 characters');
const tokens = { issuer: process.env.SESSION_TOKEN_ISSUER?.trim() || 'hrms', audience: 'hrms-api', secret };
const oidcConfig = oidcConfigFromEnv();
if (!oidcConfig) throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID must be set');

// The provider may still be starting (same server): read its metadata with a few retries before giving up.
let provider: OidcProvider | null = null;
for (let attempt = 1; !provider; attempt++) {
  try {
    provider = await oidcProvider(oidcConfig);
  } catch (err) {
    if (attempt >= 30) throw err;
    console.error(`OIDC discovery failed (attempt ${attempt}); retrying in 5 s: ${(err as Error).message}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}

// The provider's user administration for the User accounts screen (deploy/keycloak/configure-user-admin.sh writes these settings).
// Without them the API still serves everything else; creating accounts and resetting passwords answer that the provider is unavailable.
const identityConfig = keycloakAdminConfigFromEnv();
if (!identityConfig) console.error('The sign-in provider user administration is not configured (KEYCLOAK_ADMIN_*): account creation and password resets are unavailable');

const db = createPool(databaseUrl);
const app = buildApp({
  db,
  verifier: sessionTokenVerifier(tokens),
  oidc: { provider, tokens },
  identity: identityConfig ? keycloakIdentityAdmin(identityConfig) : null,
  files: localFileStore(required('FILE_STORE_DIR')),
  scanner: clamavScannerFromEnv(),
  logger: true,
});
await app.listen({ host: process.env.HOST?.trim() || '127.0.0.1', port: Number(process.env.PORT ?? 3000) });

// Graceful shutdown: stop accepting requests, let in-flight ones finish, then release database connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => db.end())
      .finally(() => process.exit(0));
  });
}
