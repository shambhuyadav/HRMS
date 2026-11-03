// Development entry point. Production configuration (OIDC verifier, secrets, TLS) is a separate,
// authorised deployment step and is intentionally not wired here.
import { buildApp } from './app.js';
import { devTokenVerifier } from './auth/tokens.js';
import { createPool } from './db/pool.js';
import { localFileStore } from './storage/files.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('server.ts is the development entry point and uses development tokens; do not run it in production');
}

const databaseUrl = process.env.DATABASE_URL;
const secret = process.env.DEV_TOKEN_SECRET;
if (!databaseUrl || !secret) throw new Error('DATABASE_URL and DEV_TOKEN_SECRET must be set (see .env.example)');

const tokens = { issuer: 'hrms-dev', audience: 'hrms-api', secret };
const db = createPool(databaseUrl);
const app = buildApp({
  db,
  verifier: devTokenVerifier(tokens),
  devLogin: tokens,
  files: localFileStore(process.env.FILE_STORE_DIR ?? '.dev-files'),
  logger: true,
});
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT ?? 3000) });

// Graceful shutdown: stop accepting requests, let in-flight ones finish, then release database connections.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app
      .close()
      .then(() => db.end())
      .finally(() => process.exit(0));
  });
}
