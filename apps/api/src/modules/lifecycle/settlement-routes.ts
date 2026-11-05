// HTTP routes of full-and-final settlement records (FR-052, FR-053, FR-054). Amounts are confidential (settlement
// amount group: eligible HR Administrator grants with row scope); state, revision and currency are operational.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { optionalPaging, type Paging, type Sorting, sortQuery } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { attachmentDisposition } from '../../storage/files.js';
import { type ScanProvider, scanInMemory } from '../../storage/scan.js';
import { sendTemplate } from '../imports/routes.js';
import { expectedVersion, idempotencyKey, idParams, pagingQuery, reason } from './process-routes.js';
import {
  approveSettlement,
  CALCULATION_STATUS,
  cancelDraft,
  createSettlement,
  EXPORT_FORMATS,
  type ExportFormat,
  exitSettlements,
  exitsAwaitingSettlement,
  exportSettlement,
  exportSettlementArchive,
  type LineInput,
  MAX_ARCHIVE_SETTLEMENTS,
  listSettlements,
  markReleaseEligible,
  replaceLines,
  reviewSettlement,
  SETTLEMENT_SORTS,
  type SettlementDecisionInput,
  settlementComponents,
  settlementDetail,
  settlementTasks,
  submitSettlement,
  UPLOAD_HEADER,
  UPLOAD_TEMPLATE,
  uploadLines,
} from './settlement.js';

const taskParams = { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string', format: 'uuid' } } } as const;
const UUID_TEXT = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const version = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } as const;
const decision = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'idempotencyKey'],
  properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] }, reason, idempotencyKey },
} as const;

export async function settlementRoutes(app: FastifyInstance, opts: { db: Database; scanner: ScanProvider }): Promise<void> {
  const { db, scanner } = opts;
  const read = (request: Parameters<typeof requireAccess>[1], recordKey?: string) =>
    requireAccess(db, request, 'settlement', 'read', ['operational', 'amount'], { requireGroups: ['operational'], ...(recordKey ? { recordKey } : {}) });

  // FR-052: no approved full-and-final policy or rate pack, so there is no calculation.
  app.get('/settlements/calculation', async (request) => {
    await requireAccess(db, request, 'settlement', 'read', ['operational']);
    return CALCULATION_STATUS;
  });

  app.post(
    '/exit-cases/:id/settlements',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, properties: { currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' } } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'settlement', 'prepare', ['amount'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => createSettlement(tx, grant, id, (request.body ?? {}) as { currencyCode?: string }));
      reply.status(201);
      return result;
    },
  );

  app.get('/exit-cases/:id/settlements', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return exitSettlements(db, await read(request, id), id);
  });

  app.get('/settlements/tasks/mine', async (request) => settlementTasks(db, await read(request)));

  // The preparer's form choices and work list, under the preparation grant the form already needs.
  const prepare = (request: Parameters<typeof requireAccess>[1]) => requireAccess(db, request, 'settlement', 'prepare', ['amount'], { requireAll: true });
  app.get('/settlements/pay-components', async (request) => settlementComponents(db, await prepare(request)));
  app.get('/settlements/awaiting-exits', { schema: { querystring: pagingQuery } }, async (request) => exitsAwaitingSettlement(db, await prepare(request), request.query as Paging));

  // FR-056: page/pageSize ask for a page; without them the 200 most recent, with `total` counting every match.
  app.get(
    '/settlements',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'REVIEWED', 'APPROVED', 'RELEASE_ELIGIBLE', 'RETURNED', 'REJECTED', 'CANCELLED'] },
            employeeCode: { type: 'string', minLength: 1, maxLength: 60 },
            lastWorkingMonth: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
            ...optionalPaging,
            ...sortQuery(SETTLEMENT_SORTS),
          },
        },
      },
    },
    async (request) => listSettlements(db, await read(request), request.query as { state?: string; employeeCode?: string; lastWorkingMonth?: string } & Paging & Sorting),
  );

  app.get('/settlements/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return settlementDetail(db, await read(request, id), id);
  });

  app.put(
    '/settlements/:id/lines',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['lines', 'expectedVersion'],
          properties: {
            expectedVersion,
            lines: {
              type: 'array',
              maxItems: 500,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['componentCode', 'amount'],
                properties: {
                  componentCode: { type: 'string', minLength: 1, maxLength: 40 },
                  amount: { type: 'string', minLength: 1, maxLength: 24 },
                  lineKind: { type: 'string', enum: ['STANDARD', 'NOTICE_ADJUSTMENT'] },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'settlement', 'prepare', ['amount'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => replaceLines(tx, grant, id, request.body as { lines: LineInput[]; expectedVersion: number }));
    },
  );

  app.post(
    '/settlements/:id/upload',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contentBase64', 'expectedVersion'],
          properties: { contentBase64: { type: 'string', minLength: 4, maxLength: 1_000_000 }, dryRun: { type: 'boolean' }, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'settlement', 'prepare', ['amount'], { requireAll: true, recordKey: id });
      const body = request.body as { contentBase64: string; dryRun?: boolean; expectedVersion: number };
      // FR-106: asked before the transaction opens, so a slow scanner holds no connection and no lock on the settlement.
      const verdict = await scanInMemory(scanner, Buffer.from(body.contentBase64, 'base64'));
      return withTransaction(db, (tx) => uploadLines(tx, grant, verdict, id, body));
    },
  );

  // DF09 published versioned template SETTLEMENT_LINES_V1: the exact header the upload checks, no rows, under the
  // upload's own grant (settlement preparation with the amount group).
  app.get('/settlements/lines/template', async (request, reply) => {
    await prepare(request);
    return sendTemplate(reply, { code: UPLOAD_TEMPLATE, columns: UPLOAD_HEADER });
  });

  app.post('/settlements/:id/submit', { schema: { params: idParams, body: version } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'settlement', 'prepare', ['amount'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => submitSettlement(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post(
    '/settlements/:id/cancel',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'reason'], properties: { expectedVersion, reason } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'settlement', 'prepare', ['amount'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => cancelDraft(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
    },
  );

  app.post('/settlements/tasks/:taskId/review', { schema: { params: taskParams, body: decision } }, async (request) => {
    const { taskId } = request.params as { taskId: string };
    const grant = await requireAccess(db, request, 'settlement', 'review', ['amount'], { requireAll: true, recordKey: taskId });
    return withTransaction(db, (tx) => reviewSettlement(tx, grant, taskId, request.body as SettlementDecisionInput));
  });

  app.post('/settlements/tasks/:taskId/approve', { schema: { params: taskParams, body: decision } }, async (request) => {
    const { taskId } = request.params as { taskId: string };
    const grant = await requireAccess(db, request, 'settlement', 'approve', ['amount'], { requireAll: true, recordKey: taskId });
    return withTransaction(db, (tx) => approveSettlement(tx, grant, taskId, request.body as SettlementDecisionInput));
  });

  // FR-053: eligibility for release only; it never triggers, records or implies a payment.
  app.post('/settlements/:id/release-eligibility', { schema: { params: idParams, body: version } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'settlement', 'release', ['amount'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => markReleaseEligible(tx, grant, id, request.body as { expectedVersion: number }));
  });

  // FR-054 outputs, built on request under the caller's current grants and never stored or sent: CSV (the default),
  // Excel (XLSX) or PDF of one approved revision, under the separate settlement export grant (FR-002, 0119).
  const format = { type: 'string', enum: [...EXPORT_FORMATS] } as const;
  const sendFile = (reply: FastifyReply, file: { fileName: string; mediaType: string; content: string | Buffer }, fallback: string) => {
    reply.headers({
      'content-type': file.mediaType,
      'content-disposition': attachmentDisposition(file.fileName, fallback),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    return file.content;
  };
  app.get(
    '/settlements/:id/export',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { format } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { format: chosen = 'CSV' } = request.query as { format?: ExportFormat };
      const grant = await requireAccess(db, request, 'settlement', 'export', ['amount'], { requireAll: true, recordKey: id });
      const file = await withTransaction(db, (tx) => exportSettlement(tx, grant, id, chosen));
      return sendFile(reply, file, `settlement.${chosen.toLowerCase()}`);
    },
  );

  // FR-054 ZIP output of the settlements selected from the list (comma-separated ids, at most 100, a technical bound):
  // each one's file in the chosen format, all re-checked and audited as their single exports, or none.
  app.get(
    '/settlements/export-archive',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['ids'],
          properties: {
            // Ids only; a longer list than the bound is refused by exportSettlementArchive in words (TOO_MANY_SETTLEMENTS).
            ids: { type: 'string', pattern: `^${UUID_TEXT}(,${UUID_TEXT})*$`, maxLength: 37 * MAX_ARCHIVE_SETTLEMENTS * 2 },
            format,
          },
        },
      },
    },
    async (request, reply) => {
      const { ids, format: chosen = 'CSV' } = request.query as { ids: string; format?: ExportFormat };
      const grant = await requireAccess(db, request, 'settlement', 'export', ['amount'], { requireAll: true });
      const archive = await withTransaction(db, (tx) => exportSettlementArchive(tx, grant, ids.split(','), chosen));
      return sendFile(reply, archive, 'settlements.zip');
    },
  );
}
