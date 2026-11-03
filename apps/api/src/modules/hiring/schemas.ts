// JSON schema fragments shared by the hiring route files (shape only; the services validate business rules).
export const uuid = { type: 'string', format: 'uuid' } as const;
export const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
export const date = { type: 'string', format: 'date' } as const;
export const expectedVersion = { type: 'integer', minimum: 1 } as const;
export const versionBody = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } as const;
export const reasonText = { type: 'string', minLength: 1, maxLength: 1000 } as const;
export const reasonBody = { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: reasonText } } as const;
export const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
export const skills = { type: 'array', maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 100 } } as const;
export const paging = { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 } } as const;
/**
 * Paging for lists that answered a capped first slice before they could page: no defaults, so a request without
 * page or pageSize keeps that answer (backward compatible); either one asks for a page (db/paging.ts).
 */
export { optionalPaging } from '../../db/paging.js';
export const headcount = { type: 'integer', minimum: 0, maximum: 2147483647 } as const;

export const decisionBody = (decisions: readonly string[], extra: Record<string, unknown> = {}) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'idempotencyKey'],
    properties: { decision: { type: 'string', enum: decisions }, reason: reasonText, idempotencyKey, ...extra },
  }) as const;
