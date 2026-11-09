// FR-031 payroll inputs through the stored import framework (preview, commit or cancel, the submitter's own batches, the malware-scan
// hold and the published template; imports/jobs.ts and imports/routes.ts). Decided under owner delegation, 6 Nov 2026 (docs/03 I-91;
// P9 / I-84 item 9). The one-period upload (PAYROLL_INPUTS_V1, inputs.ts uploadBatch) stays as it is.
//
// Template PAYROLL_INPUTS_V2: period_code, employee_code, component_code, external_code, input_kind, amount, currency_code,
// effective_date, reference. Each row names its period by code and exactly one of a pay component or an outside deduction code; an
// outside code resolves through the external deduction mapping in force on the effective date (external-deductions.ts), and an
// unknown, unmapped or retired code rejects the row by name. Every row is checked as an entered line is (inputs.ts checkLines). The file
// is all or nothing (FR-064 "no silent partial processing"): one row error rejects every batch in it. One input batch is written per
// period, then submitted and decided as any other. Import rows keep the employee code and reference (the business key), never an amount.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { MAX_BATCH_BYTES, parseTemplate, RowError, type Template, type TemplateRow } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import type { PeriodRow } from './config.js';
import { type CheckedLine, checkImportLine, openImportPeriod, writeImportBatch } from './inputs.js';

const COLUMNS = ['period_code', 'employee_code', 'component_code', 'external_code', 'input_kind', 'amount', 'currency_code', 'effective_date', 'reference'] as const;
type Column = (typeof COLUMNS)[number];
export const PAYROLL_INPUTS_V2: Template<Column> = { code: 'PAYROLL_INPUTS_V2', columns: COLUMNS };

/** The rows of one period in one run over the file (a preview or a commit), with their checked lines as they are applied. */
interface Group {
  fileHash: string;
  size: number;
  period: PeriodRow | { error: string } | null;
  lines: CheckedLine[];
  references: Set<string>;
}

const placeOf = new WeakMap<Record<Column, string>, { group: Group; index: number }>();

function parse(bytes: Buffer): TemplateRow<Column>[] {
  const rows = parseTemplate(bytes, PAYROLL_INPUTS_V2);
  const fileHash = createHash('sha256').update(bytes).digest('hex');
  const groups = new Map<string, Group>();
  for (const r of rows) {
    const key = r.row.period_code.toUpperCase();
    let group = groups.get(key);
    if (!group) groups.set(key, (group = { fileHash, size: 0, period: null, lines: [], references: new Set() }));
    placeOf.set(r.row, { group, index: group.size++ });
  }
  return rows;
}

export const PAYROLL_INPUTS_SPEC: BatchSpec<Column> = {
  kind: 'payroll_inputs',
  template: PAYROLL_INPUTS_V2,
  parse,
  keyOf: (row, n) => (row.employee_code && row.reference ? `${row.employee_code.toUpperCase()}/${row.reference}` : `ROW-${n}`),
  async apply(client, grant, row) {
    const place = placeOf.get(row);
    if (!place) throw new Error('A payroll input import row was not parsed by its spec');
    const { group, index } = place;
    let period: PeriodRow | { error: string };
    try {
      period = group.period ??= await openImportPeriod(client, grant, row.period_code);
    } catch (err) {
      // The preparation grant withdrawn since the route guard: the batch is refused, never applied.
      if (err instanceof HttpError && err.statusCode === 403) throw new RowError('FORBIDDEN');
      if (err instanceof HttpError) throw new RowError(err.code);
      throw err;
    }
    if ('error' in period) throw new RowError(period.error);
    const checked = await checkImportLine(client, grant, period, {
      employeeCode: row.employee_code,
      componentCode: row.component_code,
      externalCode: row.external_code || undefined,
      inputKind: row.input_kind,
      amount: row.amount,
      currencyCode: row.currency_code,
      effectiveDate: row.effective_date,
      reference: row.reference,
    });
    if ('error' in checked) throw new RowError(checked.error);
    if (group.references.has(checked.reference)) throw new RowError('DUPLICATE_REFERENCE');
    group.references.add(checked.reference);
    group.lines.push(checked);
    // The period's last row writes its batch (all or nothing: an error in any row rolls the whole file back).
    if (index === group.size - 1) await writeImportBatch(client, grant, period, group.lines, group.fileHash);
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
export const PAYROLL_INPUT_IMPORTS = '/payroll/input-imports';

export async function payrollInputImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  // As entry and the one-period upload: input preparation with the confidential amount group.
  const prepare = (request: Parameters<typeof requireAccess>[1], recordKey?: string) =>
    requireAccess(db, request, 'payroll_input', 'prepare', ['amount'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.post(
    PAYROLL_INPUT_IMPORTS,
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
      const { status, view } = await submitBatch(db, files, scanner, grant, PAYROLL_INPUTS_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get(`${PAYROLL_INPUT_IMPORTS}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await jobView(db, await prepare(request, id), PAYROLL_INPUTS_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  batchFollowUpRoutes(app, { db, files, scanner, path: PAYROLL_INPUT_IMPORTS, spec: PAYROLL_INPUTS_SPEC, readGrant: (request) => prepare(request), submitGrant: (request, id) => prepare(request, id) });

  app.post(`${PAYROLL_INPUT_IMPORTS}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return commitBatch(db, files, await prepare(request, id), PAYROLL_INPUTS_SPEC, id);
  });

  app.post(`${PAYROLL_INPUT_IMPORTS}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return cancelBatch(db, await prepare(request, id), PAYROLL_INPUTS_SPEC.kind, id);
  });
}
