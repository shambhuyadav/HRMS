// Tax declarations and investment proofs over HTTP (FR-036; FR-108; H3 TN08, TN09). Every handler calls requireAccess first; the
// services insist on the Employee OWN context for own work, on row scope and never the own record for review, and re-resolve
// authority inside their transaction.
import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import { evidenceContent } from '../employee/evidence.js';
import {
  activatePack,
  createOwnDeclaration,
  createPack,
  decideDeclaration,
  decideProof,
  type DeclarationInput,
  declarationTasks,
  listDeclarations,
  listPacks,
  listProofs,
  ownDeclarations,
  ownProofs,
  type PackInput,
  type ProofInput,
  proofTasks,
  type ReviewDecision,
  submitOwnDeclaration,
  submitOwnProof,
  updateOwnDeclaration,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const money = { type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,4})?$' } as const;
const code = { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' } as const;
const name = { type: 'string', minLength: 1, maxLength: 200 } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const fiscalPeriodCode = { type: 'string', pattern: '^[A-Z0-9][A-Z0-9_/-]{0,19}$' } as const;
const versionBody = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } as const;
const lines = {
  type: 'array',
  maxItems: 200,
  items: { type: 'object', additionalProperties: false, required: ['categoryCode', 'amount'], properties: { categoryCode: code, amount: money } },
} as const;
const reviewProperties = {
  decision: { type: 'string', enum: ['ACCEPT', 'REJECT', 'RETURN'] },
  explanation: { type: 'string', minLength: 1, maxLength: 1000 },
  reason: { type: 'string', minLength: 1, maxLength: 1000 },
  idempotencyKey,
} as const;
const reviewFilter = (states: readonly string[]) =>
  ({ type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: [...states] }, employeeId: uuid, ...optionalPaging } }) as const;
const ownPaging = { type: 'object', additionalProperties: false, properties: { ...optionalPaging } } as const;

export async function taxDeclarationRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore }): Promise<void> {
  const { db, files } = opts;
  type Req = Parameters<typeof requireAccess>[1];
  const own = (request: Req, action: 'read' | 'submit', recordKey?: string) => requireAccess(db, request, 'own_tax', action, ['tax'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const review = (request: Req, action: 'read' | 'review', recordKey?: string) =>
    requireAccess(db, request, 'tax_declaration', action, ['tax'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  // Rule pack registry: what a supplied pack lists; no rate.
  app.get('/payroll/tax-rule-packs', async (request) => listPacks(db, await requireAccess(db, request, 'payroll_config', 'read', ['operational'])));
  app.post(
    '/payroll/tax-rule-packs',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'fiscalPeriodCode', 'periodStart', 'periodEnd', 'cutoffDate', 'currencyCode', 'currencyMinorUnit', 'sourceReference', 'validationReference', 'regimes'],
          properties: {
            code,
            fiscalPeriodCode,
            periodStart: date,
            periodEnd: date,
            cutoffDate: date,
            currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' },
            currencyMinorUnit: { type: 'integer', minimum: 0, maximum: 4 },
            sourceReference: { type: 'string', minLength: 1, maxLength: 500 },
            validationReference: { type: 'string', minLength: 1, maxLength: 500 },
            regimes: {
              type: 'array',
              minItems: 1,
              maxItems: 20,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'name', 'categories'],
                properties: {
                  code,
                  name,
                  categories: { type: 'array', maxItems: 200, items: { type: 'object', additionalProperties: false, required: ['code', 'name'], properties: { code, name } } },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'payroll_config', 'manage', ['operational']);
      const result = await withTransaction(db, (tx) => createPack(tx, grant, request.body as PackInput));
      reply.status(201);
      return result;
    },
  );
  app.post('/payroll/tax-rule-packs/:id/activate', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'payroll_config', 'activate', ['operational'], { recordKey: id });
    return withTransaction(db, (tx) => activatePack(tx, grant, id, request.body as { expectedVersion: number }));
  });

  // TN08: the employee's own declaration.
  app.get('/me/tax-declarations', { schema: { querystring: ownPaging } }, async (request) => ownDeclarations(db, await own(request, 'read'), request.query as Paging));
  app.post(
    '/me/tax-declarations',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['fiscalPeriodCode', 'regimeCode', 'lines'], properties: { fiscalPeriodCode, regimeCode: code, lines } } } },
    async (request, reply) => {
      const grant = await own(request, 'submit');
      const result = await withTransaction(db, (tx) => createOwnDeclaration(tx, grant, request.body as DeclarationInput & { fiscalPeriodCode: string }));
      reply.status(201);
      return result;
    },
  );
  app.put(
    '/me/tax-declarations/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'regimeCode', 'lines'], properties: { expectedVersion, regimeCode: code, lines } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await own(request, 'submit', id);
      return withTransaction(db, (tx) => updateOwnDeclaration(tx, grant, id, request.body as DeclarationInput & { expectedVersion: number }));
    },
  );
  app.post('/me/tax-declarations/:id/submit', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await own(request, 'submit', id);
    return withTransaction(db, (tx) => submitOwnDeclaration(tx, grant, id, request.body as { expectedVersion: number }));
  });

  // TN09: the employee's own proofs. Files are their own documents (TN05), scanned before anyone can open them.
  app.get('/me/tax-proofs', { schema: { querystring: ownPaging } }, async (request) => ownProofs(db, await own(request, 'read'), request.query as Paging));
  app.post(
    '/me/tax-proofs',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['declarationId', 'categoryCode', 'claimedAmount', 'evidenceDocumentIds', 'idempotencyKey'],
          properties: {
            declarationId: uuid,
            categoryCode: code,
            claimedAmount: money,
            evidenceDocumentIds: { type: 'array', maxItems: 10, uniqueItems: true, items: uuid },
            idempotencyKey,
            followsProofId: uuid,
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await own(request, 'submit');
      const result = await withTransaction(db, (tx) => submitOwnProof(tx, grant, request.body as ProofInput));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  // Independent review.
  app.get('/tax-declarations', { schema: { querystring: reviewFilter(['SUBMITTED', 'ACCEPTED', 'RETURNED', 'REJECTED']) } }, async (request) =>
    listDeclarations(db, await review(request, 'read'), request.query as { state?: string; employeeId?: string } & Paging),
  );
  app.get('/tax-declarations/tasks/mine', async (request) => declarationTasks(db, await review(request, 'review')));
  app.post(
    '/tax-declaration-tasks/:id/decision',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['decision', 'idempotencyKey'], properties: reviewProperties } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await review(request, 'review', id);
      return withTransaction(db, (tx) => decideDeclaration(tx, grant, id, request.body as ReviewDecision));
    },
  );
  app.get('/tax-proofs', { schema: { querystring: reviewFilter(['SUBMITTED', 'ACCEPTED', 'RETURNED', 'REJECTED']) } }, async (request) =>
    listProofs(db, await review(request, 'read'), request.query as { state?: string; employeeId?: string } & Paging),
  );
  app.get('/tax-proofs/tasks/mine', async (request) => proofTasks(db, await review(request, 'review')));
  app.post(
    '/tax-proof-tasks/:id/decision',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['decision', 'idempotencyKey'], properties: { ...reviewProperties, acceptedAmount: money } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await review(request, 'review', id);
      return withTransaction(db, (tx) => decideProof(tx, grant, id, request.body as ReviewDecision & { acceptedAmount?: string }));
    },
  );
  // FR-106: a released evidence file, for a reviewer assigned to this proof (evidenceContent re-checks scope and the task).
  app.get(
    '/tax-proofs/:id/evidence/:documentId',
    { schema: { params: { type: 'object', required: ['id', 'documentId'], properties: { id: uuid, documentId: uuid } } } },
    async (request, reply) => {
      const { id, documentId } = request.params as { id: string; documentId: string };
      const grant = await review(request, 'read', documentId);
      const target = (await db.query<{ transaction_id: string }>(`select transaction_id from tax_proof where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
      if (!target) throw notFound();
      const { headers, bytes } = await evidenceContent(db, files, grant, {
        transactionId: target.transaction_id,
        documentId,
        linked: async (q) =>
          ((await q.query(`select 1 from transaction_evidence where company_id = $1 and transaction_id = $2 and document_id = $3`, [grant.companyId, target.transaction_id, documentId])).rowCount ?? 0) > 0,
      });
      reply.headers(headers);
      return bytes;
    },
  );
}
