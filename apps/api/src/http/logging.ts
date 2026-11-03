import type { FastifyRequest } from 'fastify';

/**
 * Errors Fastify logs itself (for example a handler finishing after its request was already answered at the deadline)
 * keep their class, code, message and stack, never driver detail with row values; Fastify's reply errors name the raw
 * URL in their message, so those keep their class and code only.
 */
const errorSerializer = (error: Error & { code?: unknown }) => {
  const code = typeof error.code === 'string' ? error.code : null;
  if (code?.startsWith('FST_ERR_REP_')) return { type: error.name, code, message: code, stack: '' };
  return { type: error.name, code, message: error.message, stack: error.stack ?? '' };
};

/** Fastify's own log messages that name the raw URL, as fixed text: the request id and route pattern still identify the request. */
const URL_MESSAGES: readonly (readonly [RegExp, string])[] = [
  [/^Route .* not found$/s, 'Route not found'], // the default 404 handler
  [/^Reply was already sent/, 'Reply was already sent'],
];

/**
 * The log call's arguments without a message that names the raw URL. A call with an `err` and no message takes the
 * error's message as its own, so a Fastify reply error (FST_ERR_REP_*, e.g. a late handler answering after the
 * deadline) is given its code instead.
 */
function withoutRawUrl(args: unknown[]): unknown[] {
  const at = typeof args[0] === 'string' ? 0 : typeof args[1] === 'string' ? 1 : -1;
  if (at >= 0) {
    const fixed = URL_MESSAGES.find(([pattern]) => pattern.test(args[at] as string));
    return fixed ? args.map((a, i) => (i === at ? fixed[1] : a)) : args;
  }
  const err = args.length === 1 && typeof args[0] === 'object' && args[0] !== null ? (args[0] as { err?: unknown }).err : undefined;
  const code = err instanceof Error ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code.startsWith('FST_ERR_REP_') ? [args[0], code] : args;
}

/**
 * Request logs carry the route pattern, never the raw URL (query strings hold name, code and email searches) or the
 * client address (CP-05 in docs/09 decides IP retention), and never tokens or cookies (NFR-S11; docs/09 §10.3).
 */
export function loggerOptions(stream?: NodeJS.WritableStream) {
  return {
    redact: ['req.headers.authorization', 'req.headers.cookie'],
    serializers: {
      req: (request: FastifyRequest) => ({ method: request.method, route: request.routeOptions?.url ?? null }),
      err: errorSerializer,
    },
    hooks: {
      logMethod(this: unknown, args: unknown[], method: (this: unknown, ...rest: unknown[]) => void) {
        method.apply(this, withoutRawUrl(args));
      },
    },
    ...(stream ? { stream } : {}),
  };
}
