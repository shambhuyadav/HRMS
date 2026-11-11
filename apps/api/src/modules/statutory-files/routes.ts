// Routes of the statutory-files module (batch R4: CL-093, CL-105, CL-106, CL-107; FR-036, FR-039, FR-107, FR-108). Registered through
// modules/routes-registry.ts, so nothing is served while the module is not active. Every route resolves its grant first (requireAccess):
// the outputs, formats and samples are statutory output configuration (payroll_statutory.read.operational); setting a format up and
// accepting or withdrawing one are the maker-checker pair payroll_statutory_format.define / .accept; a period's status is a payroll
// report (payroll_report.read.amount; its row errors about UAN or IP numbers are listed only to a reader of the payroll identifiers); a
// file is a report export (payroll_report.export.amount) and, where it carries UAN or IP numbers, a read of the payroll identifiers
// (employee.read.payroll_id) with no scoped DENY of them anywhere in the company. Writes and downloads run in one transaction with their
// audit record.
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { auditDenial, reassertAccess, requireAccess } from '../../http/guard.js';
import { downloadHeaders } from '../../storage/files.js';
import { acceptFormat, createFormat, formatSample, formatSampleFile, listFormats, type NewFormat, withdrawFormat } from './formats.js';
import { type FileFormat, isOutputCode, OUTPUT_CODES, OUTPUTS } from './outputs.js';
import { fileStatus, holdsUndenied, outputsOverview, payrollIdsDenied, type PeriodQuery, readsPayrollIds, readsPrivate, statutoryFile } from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const FORMATS = ['txt', 'csv', 'xlsx'] as const;
const codeParams = { type: 'object', required: ['code'], properties: { code: { type: 'string', enum: [...OUTPUT_CODES] } } } as const;
const periodProperties = {
  runId: uuid,
  fiscalYear: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
  quarter: { type: 'integer', minimum: 1, maximum: 4 },
  half: { type: 'integer', minimum: 1, maximum: 2 },
} as const;

const send = (reply: FastifyReply, file: { fileName: string; mediaType: string; bytes: Buffer }, fallback: string) => {
  reply.headers(downloadHeaders({ mediaType: file.mediaType, fileName: file.fileName }, fallback));
  return reply.send(file.bytes);
};

export async function statutoryFileRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  type Req = Parameters<typeof requireAccess>[1];
  const read = (request: Req) => requireAccess(db, request, 'payroll_statutory', 'read', ['operational'], { requireAll: true });
  const formatDuty = (request: Req, action: 'define' | 'accept', recordKey?: string) =>
    requireAccess(db, request, 'payroll_statutory_format', action, ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.get('/statutory-files/outputs', async (request) => outputsOverview(db, await read(request)));

  // ---------------------------------------------------------------------------------------------------------------
  // Accepted formats: set up by one person, the sample validated and accepted by another
  // ---------------------------------------------------------------------------------------------------------------
  app.get(
    '/statutory-files/formats',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { outputCode: { type: 'string', enum: [...OUTPUT_CODES] } } } } },
    async (request) => listFormats(db, await read(request), (request.query as { outputCode?: string }).outputCode),
  );

  app.post(
    '/statutory-files/formats',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['outputCode', 'formatReference', 'effectiveFrom'],
          properties: {
            outputCode: { type: 'string', enum: [...OUTPUT_CODES] },
            formatReference: { type: 'string', minLength: 1, maxLength: 200 },
            effectiveFrom: { type: 'string', format: 'date' },
            note: { anyOf: [{ type: 'string', maxLength: 500 }, { type: 'null' }] },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await formatDuty(request, 'define');
      const result = await withTransaction(db, (tx) => createFormat(tx, grant, request.body as NewFormat));
      reply.status(201);
      return result;
    },
  );

  app.get('/statutory-files/formats/:id/sample', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return formatSample(db, await read(request), id);
  });

  app.get(
    '/statutory-files/formats/:id/sample/:format',
    { schema: { params: { type: 'object', required: ['id', 'format'], properties: { id: uuid, format: { type: 'string', enum: [...FORMATS] } } } } },
    async (request, reply) => {
      const { id, format } = request.params as { id: string; format: FileFormat };
      return send(reply, await formatSampleFile(db, await read(request), id, format), 'statutory-sample.txt');
    },
  );

  app.post(
    '/statutory-files/formats/:id/acceptance',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['sampleHash', 'validationReference'],
          properties: { sampleHash: { type: 'string', pattern: '^[0-9a-f]{64}$' }, validationReference: { type: 'string', minLength: 1, maxLength: 500 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await formatDuty(request, 'accept', id);
      return withTransaction(db, (tx) => acceptFormat(tx, grant, id, request.body as { sampleHash: string; validationReference: string }));
    },
  );

  app.post(
    '/statutory-files/formats/:id/withdrawal',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await formatDuty(request, 'accept', id);
      return withTransaction(db, (tx) => withdrawFormat(tx, grant, id, request.body as { reason: string }));
    },
  );

  // ---------------------------------------------------------------------------------------------------------------
  // A period's status and its file
  // ---------------------------------------------------------------------------------------------------------------
  app.get(
    '/statutory-files/outputs/:code/status',
    { schema: { params: codeParams, querystring: { type: 'object', additionalProperties: false, properties: periodProperties } } },
    async (request) => {
      const { code } = request.params as { code: string };
      const q = request.query as PeriodQuery;
      const grant = await requireAccess(db, request, 'payroll_report', 'read', ['amount'], { requireAll: true, ...(q.runId ? { recordKey: q.runId } : {}) });
      return fileStatus(db, grant, code, q);
    },
  );

  app.get(
    '/statutory-files/outputs/:code/file',
    { config: { servingClass: 'batch' }, schema: { params: codeParams, querystring: { type: 'object', additionalProperties: false, properties: { ...periodProperties, format: { type: 'string', enum: [...FORMATS] } } } } },
    async (request, reply) => {
      const { code } = request.params as { code: string };
      if (!isOutputCode(code)) throw notFound();
      const { format, ...q } = request.query as PeriodQuery & { format?: string };
      const recordKey = q.runId ? { recordKey: q.runId } : {};
      const grant = await requireAccess(db, request, 'payroll_report', 'export', ['amount'], { requireAll: true, ...recordKey });
      // UAN and IP numbers are the confidential payroll identifiers (DF02): the same assignment must read them in full, for the whole
      // company. A scoped DENY of them on another assignment of the user (C1) would take rows out, and a company file is never partial,
      // so it refuses the file (audited, as any refusal).
      if (OUTPUTS[code].identifiers) {
        const ids = await requireAccess(db, request, 'employee', 'read', ['payroll_id'], { requireAll: true, ...recordKey });
        if (!holdsUndenied(ids, 'payroll_id')) {
          await auditDenial(db, request, { resource: 'employee', action: 'read', reason: 'SCOPED_DENY', fieldGroups: ['payroll_id'], recordKey: q.runId });
          throw payrollIdsDenied();
        }
      }
      const file = await withTransaction(db, async (tx) => {
        await reassertAccess(tx, grant, 'payroll_report', 'export', ['amount']);
        if (OUTPUTS[code].identifiers) {
          await reassertAccess(tx, grant, 'employee', 'read', ['payroll_id']);
          if (!(await readsPayrollIds(tx, grant))) throw payrollIdsDenied();
        }
        // The relative's name (family section, employee.private) is decided here, under the access current in this transaction; without
        // it in full for the whole company the file leaves the column empty, as for a caller who never held it.
        const relatives = code === 'PF_NEW_JOINERS' && (await readsPrivate(tx, grant));
        return statutoryFile(tx, grant, code, q, format, { relatives });
      });
      return send(reply, file, 'statutory-file.txt');
    },
  );
}
