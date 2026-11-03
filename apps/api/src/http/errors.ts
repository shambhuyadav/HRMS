import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string = code,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = () => new HttpError(404, 'NOT_FOUND', 'Resource not found');
export const forbidden = () => new HttpError(403, 'FORBIDDEN', 'Not permitted');

// PostgreSQL integrity errors become client errors without leaking constraint internals or values.
const PG_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'DUPLICATE', message: 'A record with the same unique value already exists' },
  '23503': { status: 422, code: 'INVALID_REFERENCE', message: 'A referenced record does not exist in this company' },
  '23514': { status: 422, code: 'RULE_VIOLATION', message: 'The change violates a business rule' },
  '23P01': { status: 409, code: 'OVERLAPPING_PERIOD', message: 'The effective period overlaps an existing record' },
  '23502': { status: 422, code: 'MISSING_VALUE', message: 'A required value is missing' },
  '40001': { status: 409, code: 'STALE_VERSION', message: 'The record changed; reload and retry' },
  // A deadlock victim is rolled back whole; the client can safely retry.
  '40P01': { status: 409, code: 'RETRY', message: 'The change conflicted with another change at the same moment; retry' },
  '22P02': { status: 400, code: 'INVALID_VALUE', message: 'A value has an invalid format' },
  '22007': { status: 400, code: 'INVALID_VALUE', message: 'A date or time value is invalid' },
  '22008': { status: 400, code: 'INVALID_VALUE', message: 'A date or time value is out of range' },
};

// Overload and a lost database are retryable, never a 500 (NFR-S10; docs/09 §8.2): statement, lock and idle-in-transaction
// timeouts, connection limits and shutdowns, the pool's own wait timeout and a passed request deadline (http/deadline.ts).
// The client is told when to come back and nothing about the cause.
const RETRY_AFTER_SECONDS = 5;
const UNAVAILABLE_PG_CODES = new Set(['57014', '55P03', '25P03', '53300', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006']);
/** The database cannot be reached: a server that is down or a lost network answers with a socket error, not a SQLSTATE. */
const UNAVAILABLE_SOCKET_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN']);
/** A request past its deadline (db/budget.ts DeadlineExceeded), or a route given Fastify's own handlerTimeout. */
const DEADLINE_CODES = new Set(['DEADLINE_EXCEEDED', 'FST_ERR_HANDLER_TIMEOUT']);
const UNAVAILABLE_DRIVER_MESSAGES = new Set([
  'timeout exceeded when trying to connect', // pg-pool: no connection became free within connectionTimeoutMillis
  'Connection terminated due to connection timeout',
  'Connection terminated unexpectedly',
]);
const isUnavailable = (error: Error & { code?: string }) =>
  (error.code !== undefined && (UNAVAILABLE_PG_CODES.has(error.code) || UNAVAILABLE_SOCKET_CODES.has(error.code) || DEADLINE_CODES.has(error.code))) || UNAVAILABLE_DRIVER_MESSAGES.has(error.message);

/** Why a request was answered 503 (a PostgreSQL code, DEADLINE_EXCEEDED or POOL_TIMEOUT), for the metrics (http/metrics.ts). */
const unavailable = new WeakMap<FastifyRequest, string>();
export const unavailableCause = (request: FastifyRequest): string | undefined => unavailable.get(request);

export function errorHandler(error: FastifyError & { code?: string }, request: FastifyRequest, reply: FastifyReply) {
  if (error instanceof HttpError) {
    return reply.status(error.statusCode).send({ error: error.code, message: error.message, details: error.details });
  }
  if (error.validation) {
    return reply.status(400).send({ error: 'INVALID_REQUEST', message: error.message });
  }
  // Fastify's own client errors keep their status (e.g. 413 for a body over the route limit), never a 500.
  if (typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 && error.code?.startsWith('FST_')) {
    const code = error.statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : error.statusCode === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : 'INVALID_REQUEST';
    return reply.status(error.statusCode).send({ error: code, message: error.statusCode === 413 ? 'The request is larger than this endpoint accepts' : 'The request could not be processed' });
  }
  const pg = error.code ? PG_ERRORS[error.code] : undefined;
  if (pg) {
    // Business-rule message text from our own triggers is safe to surface; constraint names are not.
    return reply.status(pg.status).send({ error: pg.code, message: pg.message });
  }
  if (isUnavailable(error)) {
    const cause = error.code === 'FST_ERR_HANDLER_TIMEOUT' ? 'DEADLINE_EXCEEDED' : (error.code ?? 'POOL_TIMEOUT');
    unavailable.set(request, cause);
    request.log.warn({ failure: { code: cause } }, 'service unavailable');
    return reply.status(503).header('retry-after', String(RETRY_AFTER_SECONDS)).send({ error: 'UNAVAILABLE', message: 'The service is busy; retry shortly' });
  }
  // Class, code, message and stack only: driver errors can carry row values in their detail (NFR-S11).
  request.log.error({ failure: { class: error.name, code: error.code ?? null, message: error.message, stack: error.stack } }, 'unhandled error');
  return reply.status(500).send({ error: 'INTERNAL', message: 'Unexpected error' });
}
