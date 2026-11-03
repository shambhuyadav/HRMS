// Opening leave-balance upload (FR-025 "opening leave-balance upload"; "duplicate opening-balance batches are blocked";
// DF09). Template LEAVE_OPENING_V1: employeeCode,leaveType,units,effectiveDate,reason. Each row goes through the single
// route's own path (adjustBalance: row scope, never one's own balance, one opening per employee and type, audit), so an
// existing opening is a row error and a batch repeated after its commit is rejected whole. Batches are all-or-nothing
// (imports/batch.ts); the caller's own batches are listed and one held for the malware scan is resumed from its stored
// file (imports/routes.ts).
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';
import { isCalendarDate, markRepeats, MAX_BATCH_BYTES, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { adjustBalance } from './service.js';

const COLUMNS = ['employeeCode', 'leaveType', 'units', 'effectiveDate', 'reason'] as const;
type Column = (typeof COLUMNS)[number];
export const LEAVE_OPENING_TEMPLATE: Template<Column> = { code: 'LEAVE_OPENING_V1', columns: COLUMNS };

/** Positive units, up to the ledger's 4 decimals (an opening is never negative, 0007). */
const OPENING_UNITS = /^\d{1,4}(\.\d{1,4})?$/;

const rowKey = (row: Record<Column, string>) => `${row.employeeCode.toUpperCase()}@${row.leaveType.toUpperCase()}`;

export const LEAVE_OPENING_SPEC: BatchSpec<Column> = {
  kind: 'leave_opening',
  template: LEAVE_OPENING_TEMPLATE,
  parse: (bytes) => markRepeats(parseTemplate(bytes, LEAVE_OPENING_TEMPLATE), rowKey, 'DUPLICATE_IN_BATCH'),
  keyOf: (row, n) => (row.employeeCode ? rowKey(row) : `ROW-${n}`),
  async apply(client, grant: AccessGrant, row) {
    if (!OPENING_UNITS.test(row.units) || Number(row.units) === 0) throw new RowError('INVALID_UNITS');
    if (!isCalendarDate(row.effectiveDate)) throw new RowError('INVALID_DATE');
    if (row.reason === '' || row.reason.length > 500) throw new RowError('INVALID_REASON');
    const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, row.employeeCode.toUpperCase()])).rows[0];
    if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
    const type = await client.query(`select 1 from leave_type where company_id = $1 and code = $2`, [grant.companyId, row.leaveType.toUpperCase()]);
    if (!type.rowCount) throw new RowError('UNKNOWN_LEAVE_TYPE');
    // A key of its own for each pass: repeats are stopped by the one-opening rule (OPENING_EXISTS), never read as a replay.
    await adjustBalance(client, grant, {
      employeeId: employee.id,
      leaveType: row.leaveType.toUpperCase(),
      kind: 'OPENING',
      units: row.units,
      effectiveDate: row.effectiveDate,
      reason: row.reason,
      idempotencyKey: `opening-import:${randomUUID()}`,
    });
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const PATH = '/leave/opening-imports';

async function grants(db: Database, request: Parameters<typeof requireAccess>[1], recordKey?: string) {
  await requireAccess(db, request, 'leave', 'import', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  // Rows are applied under the caller's adjustment grant, so its scope still applies per row.
  return requireAccess(db, request, 'leave', 'adjust', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
}

export async function leaveOpeningImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  app.post(
    PATH,
    {
      bodyLimit: Math.ceil(MAX_BATCH_BYTES * 1.4),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['fileName', 'contentBase64', 'idempotencyKey'],
          properties: {
            fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\<>:"|?*\\x00-\\x1f\\x7f]+$' },
            contentBase64: { type: 'string', minLength: 4 },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await grants(db, request);
      const { status, view } = await submitBatch(db, files, scanner, grant, LEAVE_OPENING_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get(`${PATH}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'leave', 'import', ['operational'], { requireAll: true, recordKey: id });
    const view = await jobView(db, grant, LEAVE_OPENING_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches (read grant), resuming one held for the malware scan and the template (upload grants; imports/routes.ts).
  batchFollowUpRoutes(app, {
    db,
    files,
    scanner,
    path: PATH,
    spec: LEAVE_OPENING_SPEC,
    readGrant: (request) => requireAccess(db, request, 'leave', 'import', ['operational'], { requireAll: true }),
    submitGrant: (request, id) => grants(db, request, id),
  });

  app.post(`${PATH}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await grants(db, request, id);
    return commitBatch(db, files, grant, LEAVE_OPENING_SPEC, id);
  });

  app.post(`${PATH}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'leave', 'import', ['operational'], { requireAll: true, recordKey: id });
    return cancelBatch(db, grant, LEAVE_OPENING_SPEC.kind, id);
  });
}
