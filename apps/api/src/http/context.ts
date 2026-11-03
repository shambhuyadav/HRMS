// Per-request actor context: authenticated user plus the explicitly selected company and role assignment
// (BR-046). No request runs under an implicit or "best" assignment. Only routes that exist to let the user
// choose an assignment (config.assignmentOptional) may omit it, and they can never pass an access guard.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SessionStore } from '../auth/sessions.js';
import type { TokenVerifier } from '../auth/tokens.js';
import { HttpError } from './errors.js';

export interface Actor {
  userId: string;
  sessionId: string;
  companyId: string;
  assignmentId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
  interface FastifyContextConfig {
    assignmentOptional?: boolean;
  }
}

export const COMPANY_HEADER = 'x-hrms-company';
export const ASSIGNMENT_HEADER = 'x-hrms-assignment';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

export function registerActorContext(app: FastifyInstance, verifier: TokenVerifier, sessions: SessionStore): void {
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (request) => {
    if (!request.url.startsWith('/v1/')) return;
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new HttpError(401, 'UNAUTHENTICATED', 'Missing bearer token');
    let userId: string;
    let sessionId: string;
    try {
      ({ userId, sessionId } = await verifier.verify(header.slice('Bearer '.length)));
    } catch {
      throw new HttpError(401, 'UNAUTHENTICATED', 'Invalid or expired token');
    }
    // DF10: idle timeout, absolute expiry and revocation are enforced server-side on every request.
    const session = await sessions.check(sessionId, userId);
    if (session !== 'OK') throw new HttpError(401, `SESSION_${session}`, 'The session is no longer valid; sign in again');
    const companyId = request.headers[COMPANY_HEADER];
    const assignmentId = request.headers[ASSIGNMENT_HEADER];
    const assignmentOptional = request.routeOptions.config?.assignmentOptional === true;
    if (!isId(companyId) || (!isId(assignmentId) && !(assignmentOptional && assignmentId === undefined))) {
      throw new HttpError(400, 'CONTEXT_REQUIRED', `Headers ${COMPANY_HEADER} and ${ASSIGNMENT_HEADER} must be valid ids`);
    }
    // Canonical ids from here on: another letter case names the same row to PostgreSQL, but ids also end up in object
    // keys (storage/files.ts) and comparisons.
    request.actor = { userId, sessionId, companyId: companyId.toLowerCase(), assignmentId: isId(assignmentId) ? assignmentId.toLowerCase() : null };
  });
}

export function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw new HttpError(401, 'UNAUTHENTICATED', 'No authenticated actor');
  return request.actor;
}
