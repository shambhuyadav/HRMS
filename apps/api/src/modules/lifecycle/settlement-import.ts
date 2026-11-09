// FR-054 "bulk settlement upload" (CL-244; DF09; FR-064; FR-106): the lines of many draft settlements in one file,
// through the shared import lifecycle (preview, commit or cancel, the submitter's own batches, the malware-scan hold
// and the published template; imports/jobs.ts and imports/routes.ts).
//
// The file is the published SETTLEMENT_LINES_V1 template of the one-settlement upload, unchanged: employee_code,
// last_working_date, component_code, amount, line_kind. The employee code and the approved last working date name the
// settlement (the live draft revision of that exit); every row is checked as the one-settlement upload checks its rows
// (settlement.ts checkUploadRow: row scope, never one's own, only the revision's preparer, a draft, the date, an active
// component, a valid signed amount and line kind, the notice period for a notice adjustment, one line per component).
// The rows of a settlement replace its lines, as that upload does. The batch is all or nothing (DF09 "atomic per
// business transaction"; FR-064 "no silent partial processing"): one row error rejects every settlement in the file.
// Nothing is submitted: each draft is submitted, reviewed and approved as before. Import rows keep the employee and
// component codes (the business key), never an amount.
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { MAX_BATCH_BYTES, parseTemplate, RowError, type Template, type TemplateRow } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { type CheckedLine, checkUploadRow, UPLOAD_HEADER, UPLOAD_TEMPLATE, type UploadRowCaches, writeUploadLine } from './settlement.js';

type Column = (typeof UPLOAD_HEADER)[number];
export const SETTLEMENT_LINES_TEMPLATE: Template<Column> = { code: UPLOAD_TEMPLATE, columns: UPLOAD_HEADER };

/**
 * The rows of one settlement in one run over the file (a preview or a commit): its rows in file order and, as they
 * are applied, each one's checked line (null once it failed). Every run parses the file again, so its groups are its own.
 */
interface Group {
  caches: UploadRowCaches;
  size: number;
  lines: (CheckedLine | null)[];
}

/** Each parsed row's group and its place in it (keyed by the row object the framework passes back to apply). */
const placeOf = new WeakMap<Record<Column, string>, { group: Group; index: number }>();

function parse(bytes: Buffer): TemplateRow<Column>[] {
  const rows = parseTemplate(bytes, SETTLEMENT_LINES_TEMPLATE);
  const caches: UploadRowCaches = { components: new Map(), employees: new Map(), paidInPayroll: new Map() };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    // A settlement is named by the employee and the approved last working date (cells are trimmed by parseTemplate).
    const key = `${r.row.employee_code.toUpperCase()}\u0000${r.row.last_working_date}`;
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { caches, size: 0, lines: [] }));
    placeOf.set(r.row, { group, index: group.size++ });
  }
  return rows;
}

export const SETTLEMENT_LINES_SPEC: BatchSpec<Column> = {
  kind: 'settlement_lines',
  template: SETTLEMENT_LINES_TEMPLATE,
  parse,
  keyOf: (row, n) => (row.employee_code && row.component_code ? `${row.employee_code.toUpperCase()}/${row.component_code.toUpperCase()}` : `ROW-${n}`),
  async apply(client, grant, row) {
    const place = placeOf.get(row);
    if (!place) throw new Error('A settlement upload row was not parsed by its spec');
    const { group, index } = place;
    group.lines[index] = null;
    const checked = await checkUploadRow(
      client,
      grant,
      { employeeCode: row.employee_code, lastWorkingDate: row.last_working_date, componentCode: row.component_code, amount: row.amount, lineKind: row.line_kind },
      group.caches,
    );
    if ('error' in checked) throw new RowError(checked.error);
    const earlier = group.lines.slice(0, index).filter((l): l is CheckedLine => l !== null && l !== undefined);
    // One line per component: the first valid row of a component counts, as in the one-settlement upload.
    if (earlier.some((l) => l.componentId === checked.line.componentId)) throw new RowError('DUPLICATE_COMPONENT');
    try {
      await writeUploadLine(client, grant, checked.settlement, checked.line, { first: earlier.length === 0, last: index === group.size - 1, lineCount: earlier.length + 1 });
    } catch (err) {
      // The preparation grant withdrawn since the route guard: the batch is refused, never applied.
      if (err instanceof HttpError && err.statusCode === 403) throw new RowError('FORBIDDEN');
      throw err;
    }
    group.lines[index] = checked.line;
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
export const SETTLEMENT_IMPORTS = '/settlements/line-imports';

export async function settlementImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  // Every route needs what the one-settlement upload needs: settlement preparation with the confidential amount group.
  const prepare = (request: Parameters<typeof requireAccess>[1], recordKey?: string) =>
    requireAccess(db, request, 'settlement', 'prepare', ['amount'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.post(
    SETTLEMENT_IMPORTS,
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
      const grant = await prepare(request);
      const { status, view } = await submitBatch(db, files, scanner, grant, SETTLEMENT_LINES_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get(`${SETTLEMENT_IMPORTS}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await jobView(db, await prepare(request, id), SETTLEMENT_LINES_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches, the published template and resuming a batch held for the malware scan (imports/routes.ts).
  batchFollowUpRoutes(app, { db, files, scanner, path: SETTLEMENT_IMPORTS, spec: SETTLEMENT_LINES_SPEC, readGrant: (request) => prepare(request), submitGrant: (request, id) => prepare(request, id) });

  app.post(`${SETTLEMENT_IMPORTS}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return commitBatch(db, files, await prepare(request, id), SETTLEMENT_LINES_SPEC, id);
  });

  app.post(`${SETTLEMENT_IMPORTS}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return cancelBatch(db, await prepare(request, id), SETTLEMENT_LINES_SPEC.kind, id);
  });
}
