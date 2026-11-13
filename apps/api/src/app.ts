import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { DevTokenConfig, TokenVerifier } from './auth/tokens.js';
import type { IdentityAdmin } from './auth/identity-admin.js';
import type { OidcProvider } from './auth/oidc.js';
import { signInRoutes } from './auth/sign-in-routes.js';
import { devLoginRoutes, meRoutes } from './modules/access/me.js';
import type { Database } from './db/transaction.js';
import { instrumentDatabase } from './db/instrument.js';
import { postgresSessionStore, type SessionStore } from './auth/sessions.js';
import { actorOf, registerActorContext } from './http/context.js';
import { registerDeadlines, type ServingBudgetOverrides, servingBudgets } from './http/deadline.js';
import { errorHandler } from './http/errors.js';
import { loggerOptions } from './http/logging.js';
import { registerMetrics } from './http/metrics.js';
import { delegationRoutes } from './modules/access/delegation-routes.js';
import { accessRoutes } from './modules/access/routes.js';
import { attendancePolicyRoutes } from './modules/attendance/policies.js';
import { punchImportRoutes } from './modules/attendance/punch-import.js';
import { attendanceRoutes } from './modules/attendance/routes.js';
import { auditTrailRoutes } from './modules/audit-trail/routes.js';
import { bulkJobRoutes } from './modules/bulk/routes.js';
import { mobileLinkRoutes } from './modules/mobile-link/routes.js';
import { MODULE_ROUTES } from './modules/routes-registry.js';
import { selfServiceRoutes } from './modules/self-service/routes.js';
import { shiftPlanImportRoutes } from './modules/shift/plan-import.js';
import { workflowRoutes } from './modules/workflow/routes.js';
import { biometricRoutes, type ProviderRegistry } from './modules/biometric/routes.js';
import { confirmationExceptionRoutes } from './modules/confirmation/exceptions.js';
import { confirmationPolicyRoutes } from './modules/confirmation/policies.js';
import { confirmationRoutes } from './modules/confirmation/routes.js';
import { documentRoutes } from './modules/employee/documents.js';
import { employeeImportRoutes } from './modules/employee/imports.js';
import { employeeRoutes } from './modules/employee/routes.js';
import { employeeUpdateImportRoutes } from './modules/employee/update-import.js';
import { essRoutes } from './modules/ess/routes.js';
import { expenseRoutes } from './modules/expense/routes.js';
import { incrementRoutes } from './modules/increment/routes.js';
import { leaveMonthlyAdjustmentImportRoutes } from './modules/leave/monthly-adjustment-import.js';
import { leaveOpeningImportRoutes } from './modules/leave/opening-import.js';
import { leaveRoutes } from './modules/leave/routes.js';
import { notificationRoutes } from './modules/notification/routes.js';
import { orgRoutes } from './modules/org/routes.js';
import { payrollExtrasRoutes } from './modules/payroll-extras/routes.js';
import { referenceValueRoutes } from './modules/reference/routes.js';
import { reportRoutes } from './modules/report/routes.js';
import { shiftRoutes } from './modules/shift/routes.js';
import { teamRoutes } from './modules/team/routes.js';
import { workRequestRoutes } from './modules/work-request/routes.js';
import { assertCandidateIdentityKeyConfigured } from './modules/hiring/candidate.js';
import { assertFieldKeysConfigured } from './security/field-crypto.js';
import { type FileStore, memoryFileStore } from './storage/files.js';
import { developmentScanner, type ScanProvider, scanInWorker } from './storage/scan.js';
import { scanFailureRoutes } from './storage/scan-failures.js';

export interface AppDependencies {
  db: Database;
  verifier: TokenVerifier;
  logger?: boolean;
  /** Biometric provider adapters by profile code; empty until a real provider contract is configured (DF13). */
  biometricProviders?: ProviderRegistry;
  /** Server-side session store (DF10); defaults to the PostgreSQL store. */
  sessions?: SessionStore;
  /** File store for documents and import files (ADR-07); tests default to memory. Production must pass its store. */
  files?: FileStore;
  /**
   * Malware scanner (FR-106); development and tests use the synthetic scanner. Production must pass its scanner. A stored upload is
   * never scanned in the request: it answers PENDING_SCAN and the scan worker reaches the verdict (NFR-S09). Only the uploads that are
   * read in the request and never stored (payroll inputs, settlement lines) ask it, under a time limit and outside any transaction.
   */
  scanner?: ScanProvider;
  /**
   * For a test harness only: upload routes ask the scanner in the request and answer its verdict, so a test can start from a released
   * or quarantined file without running the scan worker. Production refuses it.
   */
  scanInRequest?: boolean;
  /** Development-only sign-in for synthetic accounts. Never set in production. */
  devLogin?: DevTokenConfig;
  /**
   * Production sign-in (ADR-06): the OIDC provider whose ID tokens open a session, and the HRMS session token configuration the API
   * verifies (auth/sign-in-routes.ts). Without it the API offers no sign-in of its own besides the development one.
   */
  oidc?: { provider: OidcProvider; tokens: DevTokenConfig };
  /**
   * The sign-in provider's user administration (auth/identity-admin.ts): account creation, password resets and the like from the
   * User accounts screen. Without it (the development server) accounts are created alone and no temporary password is given.
   */
  identity?: IdentityAdmin | null;
  /** Request deadlines and transaction budgets per serving class (http/deadline.ts); else the environment, else the defaults. */
  serving?: ServingBudgetOverrides;
  /**
   * Bearer token of the internal metrics endpoint (http/metrics.ts; at least 32 characters); else HRMS_METRICS_TOKEN.
   * Without either the endpoint is not registered.
   */
  metricsToken?: string;
}

/** An inbound request id is kept only when it is a plain token (it ends up in logs and response headers). */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,100}$/;

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    // Request logs must never carry tokens, confidential values or search terms (NFR-S11; http/logging.ts).
    logger: deps.logger ? loggerOptions() : false,
    bodyLimit: 1_048_576,
    // G3 privacy-safe telemetry: every request has an id (a well-formed inbound x-request-id, else a new one) that
    // appears in the logs and is returned to the caller, so one request can be followed across services.
    genReqId: (req) => {
      const inbound = req.headers['x-request-id'];
      return typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
    },
  });
  app.setErrorHandler(errorHandler);
  // Every /v1 request runs under its serving class's deadline and transaction budget (docs/09 §8.2), registered before
  // any route and before the session check; from here on the app sees the database through the request's unit of
  // work, which counts its statements and starts none after the deadline (db/instrument.ts).
  registerDeadlines(app, servingBudgets(deps.serving));
  const pool = deps.db;
  deps = { ...deps, db: instrumentDatabase(deps.db) };
  const metricsToken = deps.metricsToken ?? process.env.HRMS_METRICS_TOKEN;
  if (metricsToken) registerMetrics(app, { token: metricsToken, pool });
  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
    // API answers carry personal and confidential data: no browser or intermediary may store them (downloads set the same).
    if (request.url.startsWith('/v1/') && !reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
  });
  const sessions = deps.sessions ?? postgresSessionStore(deps.db);
  registerActorContext(app, deps.verifier, sessions);

  // Liveness only; no dependency details are exposed.
  app.get('/health', async () => ({ status: 'ok' }));
  // Readiness for load balancers: the database answers. Failures say nothing about why.
  app.get('/ready', async (_request, reply) => {
    try {
      await deps.db.query('select 1');
      return { status: 'ready' };
    } catch {
      reply.status(503);
      return { status: 'unavailable' };
    }
  });

  // Sign-out revokes the server-side session; the token stops working on the next request (DF10).
  app.post('/v1/me/logout', { config: { assignmentOptional: true } }, async (request) => {
    await sessions.revoke(actorOf(request).sessionId);
    return { signedOut: true };
  });

  app.register(accessRoutes, { prefix: '/v1', db: deps.db, identity: deps.identity ?? null });
  app.register(delegationRoutes, { prefix: '/v1', db: deps.db });
  app.register(orgRoutes, { prefix: '/v1', db: deps.db });
  app.register(referenceValueRoutes, { prefix: '/v1', db: deps.db });
  if (deps.scanInRequest && process.env.NODE_ENV === 'production') throw new Error('In production uploads are scanned by the worker, never in the request (NFR-S09)');
  if (!deps.files && process.env.NODE_ENV === 'production') throw new Error('A file store must be configured in production');
  // Protected private-profile payloads (H4) cannot be sealed or opened without keys: fail at start-up, not on first use.
  // The same for the candidate duplicate-detection key (hiring): fail at start-up, not at the first contact write.
  if (process.env.NODE_ENV === 'production') {
    assertFieldKeysConfigured();
    assertCandidateIdentityKeyConfigured();
  }
  const files = deps.files ?? memoryFileStore();
  if (!deps.scanner && process.env.NODE_ENV === 'production') throw new Error('A malware scanner must be configured in production');
  const configuredScanner = deps.scanner ?? developmentScanner();
  const scanner = deps.scanInRequest ? configuredScanner : scanInWorker(configuredScanner);
  app.register(employeeRoutes, { prefix: '/v1', db: deps.db });
  app.register(employeeImportRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(employeeUpdateImportRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(documentRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(shiftRoutes, { prefix: '/v1', db: deps.db });
  app.register(leaveRoutes, { prefix: '/v1', db: deps.db, files });
  app.register(leaveOpeningImportRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(leaveMonthlyAdjustmentImportRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(attendanceRoutes, { prefix: '/v1', db: deps.db });
  app.register(attendancePolicyRoutes, { prefix: '/v1', db: deps.db });
  app.register(punchImportRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(workRequestRoutes, { prefix: '/v1', db: deps.db, files });
  app.register(confirmationRoutes, { prefix: '/v1', db: deps.db });
  app.register(confirmationExceptionRoutes, { prefix: '/v1', db: deps.db });
  app.register(confirmationPolicyRoutes, { prefix: '/v1', db: deps.db });
  app.register(notificationRoutes, { prefix: '/v1', db: deps.db });
  app.register(incrementRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(expenseRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(teamRoutes, { prefix: '/v1', db: deps.db });
  app.register(reportRoutes, { prefix: '/v1', db: deps.db });
  app.register(bulkJobRoutes, { prefix: '/v1', db: deps.db });
  app.register(biometricRoutes, { prefix: '/v1', db: deps.db, providers: deps.biometricProviders ?? new Map() });
  app.register(auditTrailRoutes, { prefix: '/v1', db: deps.db });
  app.register(selfServiceRoutes, { prefix: '/v1', db: deps.db });
  app.register(essRoutes, { prefix: '/v1', db: deps.db });
  app.register(mobileLinkRoutes, { prefix: '/v1', db: deps.db });
  app.register(shiftPlanImportRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(scanFailureRoutes, { prefix: '/v1', db: deps.db });
  app.register(payrollExtrasRoutes, { prefix: '/v1', db: deps.db, files, scanner });
  // Business modules added through modules/registry.ts and modules/routes-registry.ts.
  for (const m of MODULE_ROUTES) app.register(m.routes, { prefix: '/v1', db: deps.db, files, scanner });
  app.register(workflowRoutes, { prefix: '/v1', db: deps.db });
  app.register(meRoutes, { prefix: '/v1', db: deps.db });
  if (deps.devLogin) {
    if (process.env.NODE_ENV === 'production') throw new Error('Development sign-in cannot be enabled in production');
    app.register(devLoginRoutes, { db: deps.db, sessions, tokens: deps.devLogin });
  }
  if (!deps.oidc && process.env.NODE_ENV === 'production') throw new Error('An OIDC provider must be configured in production (ADR-06)');
  app.register(signInRoutes, { db: deps.db, sessions, oidc: deps.oidc ?? null, devLogin: Boolean(deps.devLogin) });
  return app;
}
