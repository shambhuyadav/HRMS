// The API's OpenAPI description (improvement plan H1), generated from the JSON schemas every route already declares: the machine-
// readable contract at /docs/json and a browsable page at /docs. On development servers only by default: production does not serve it
// (HRMS_API_DOCS=on turns it on anywhere, =off turns it off; the production reverse proxy forwards only /v1 and the sign-in paths, so
// even then it is reachable on the server alone). It describes request shapes; it holds no data and needs no sign-in.
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';

export function apiDocsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HRMS_API_DOCS === 'on') return true;
  if (env.HRMS_API_DOCS === 'off') return false;
  return env.NODE_ENV !== 'production' && !env.VITEST;
}

/** Registers the description and its page. Must come before the routes it describes. */
export function registerApiDocs(app: FastifyInstance): void {
  app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'HRMS API',
        version: '1',
        description:
          'Every /v1 call needs a bearer session token and, for company data, the x-hrms-company and x-hrms-assignment headers (the ' +
          'selected company and role). Errors answer {error, message, details?}; see docs/api-error-codes.md.',
      },
      components: { securitySchemes: { session: { type: 'http', scheme: 'bearer' } } },
      security: [{ session: [] }],
    },
  });
  app.register(swaggerUi, { routePrefix: '/docs', uiConfig: { docExpansion: 'none', deepLinking: true } });
}
