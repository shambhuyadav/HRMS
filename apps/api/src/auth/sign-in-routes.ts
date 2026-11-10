// Sign-in routes outside /v1 (no bearer token yet; http/context.ts checks /v1 only):
//   GET  /sign-in/config  what the browser offers: OIDC (the provider's public endpoints and this client), the development sign-in
//                         (synthetic accounts, never in production), or nothing configured.
//   POST /sign-in/oidc    the provider's ID token and the nonce the browser generated: verified (auth/oidc.ts), the account found or
//                         linked, a server-side session opened and the HRMS session token returned with the user's companies, as
//                         the development sign-in returns them.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/transaction.js';
import { accountOf, type OidcProvider } from './oidc.js';
import type { SessionStore } from './sessions.js';
import { ABSOLUTE_SESSION_SECONDS, type DevTokenConfig, issueSessionToken } from './tokens.js';

export async function signInRoutes(
  app: FastifyInstance,
  opts: { db: Database; sessions: SessionStore; oidc: { provider: OidcProvider; tokens: DevTokenConfig } | null; devLogin: boolean },
): Promise<void> {
  const { db, sessions, oidc } = opts;
  app.get('/sign-in/config', async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    if (oidc) return oidc.provider.browser;
    return { mode: opts.devLogin ? 'DEV' : 'NONE' };
  });

  if (!oidc) return;
  app.post(
    '/sign-in/oidc',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['idToken', 'nonce'],
          properties: { idToken: { type: 'string', minLength: 20, maxLength: 20000 }, nonce: { type: 'string', minLength: 16, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      const { idToken, nonce } = request.body as { idToken: string; nonce: string };
      const identity = await oidc.provider.verifyIdToken(idToken, nonce);
      const userId = await accountOf(db, identity);
      const sessionId = await sessions.create(userId, ABSOLUTE_SESSION_SECONDS);
      // The companies the user holds an active role in (as the development sign-in returns them).
      const companies = await db.query(
        `select distinct c.id, c.code, c.name from role_assignment ra join company c on c.id = ra.company_id and c.active
          where ra.user_id = $1 and ra.state = 'ACTIVE' and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
          order by c.name`,
        [userId],
      );
      request.log.info({ userId, sessionId }, 'signed in through OIDC');
      return { token: await issueSessionToken(oidc.tokens, userId, sessionId, ABSOLUTE_SESSION_SECONDS), companies: companies.rows };
    },
  );
}
