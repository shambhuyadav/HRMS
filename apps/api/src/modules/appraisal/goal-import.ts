// KRA/goal upload (FR-041; F1 "upload creates DRAFT and never silently substitutes for human approval"; DF09; I-13).
// Template APPRAISAL_GOALS_V1: cycleCode,employeeCode,sequence,description,target,weight — one row per goal. The rows of
// one employee and cycle become one new DRAFT appraisal with those goals, enrolled through the ordinary path (row scope,
// active employee, open cycle, open goal-setting window, no overlapping cycle, never the importer's own appraisal).
// FR-041 target validations: a valid open cycle, a whole-number weight 1..100 on every goal and an employee total of
// exactly 100. Nothing is submitted, rated or approved by an upload, and the source's upload modes 0/1/2 are not copied
// (F1: unexplained source values are not new rules). Batches are all-or-nothing (imports/batch.ts); the caller's own
// batches are listed and one held for the malware scan is resumed from its stored file (imports/routes.ts).
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';
import { MAX_BATCH_BYTES, parseTemplate, RowError, type Template, type TemplateRow } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { cleanGoals, createAppraisal } from './appraisals.js';
import { audit } from './common.js';

const COLUMNS = ['cycleCode', 'employeeCode', 'sequence', 'description', 'target', 'weight'] as const;
type Column = (typeof COLUMNS)[number];
/** Internal marker added while parsing: the first row of its employee and cycle enrols the appraisal. */
type Row = Column | 'groupStart';
export const GOAL_TEMPLATE: Template<Column> = { code: 'APPRAISAL_GOALS_V1', columns: COLUMNS };

const WHOLE = /^\d{1,3}$/;
const groupKey = (row: Record<Column, string>) => `${row.cycleCode.toUpperCase()}|${row.employeeCode.toUpperCase()}`;

/** File-level rules: one row per goal sequence, and each employee's weights total exactly 100. */
export function parseGoalFile(bytes: Buffer): TemplateRow<Row>[] {
  const rows = parseTemplate(bytes, GOAL_TEMPLATE);
  const totals = new Map<string, number | null>();
  const sequences = new Set<string>();
  const flagged = rows.map((r): TemplateRow<Column> => {
    if (r.columnCountMismatch || r.rowError) return r;
    const key = groupKey(r.row);
    const weight = WHOLE.test(r.row.weight) ? Number(r.row.weight) : null;
    const running = totals.has(key) ? totals.get(key)! : 0;
    totals.set(key, running === null || weight === null ? null : running + weight);
    const seq = `${key}|${r.row.sequence}`;
    if (sequences.has(seq)) return { ...r, rowError: 'DUPLICATE_SEQUENCE' };
    sequences.add(seq);
    return r;
  });
  const started = new Set<string>();
  return flagged.map((r) => {
    const key = groupKey(r.row);
    const first = !started.has(key);
    started.add(key);
    const total = totals.get(key);
    const rowError = r.rowError ?? (!r.columnCountMismatch && total !== null && total !== undefined && total !== 100 ? 'WEIGHT_TOTAL_NOT_100' : undefined);
    return { ...r, row: { ...r.row, groupStart: first ? 'Y' : 'N' }, ...(rowError ? { rowError } : {}) };
  });
}

async function apply(client: Parameters<BatchSpec<Row>['apply']>[0], grant: AccessGrant, row: Record<Row, string>): Promise<void> {
  if (!WHOLE.test(row.sequence) || Number(row.sequence) < 1 || Number(row.sequence) > 100) throw new RowError('INVALID_SEQUENCE');
  if (!WHOLE.test(row.weight) || Number(row.weight) < 1 || Number(row.weight) > 100) throw new RowError('INVALID_WEIGHT');
  if (!row.description || row.description.length > 500) throw new RowError('INVALID_DESCRIPTION');
  if (row.target.length > 1000) throw new RowError('INVALID_TARGET');
  const cycle = (await client.query<{ id: string; state: string }>(`select id, state from appraisal_cycle where company_id = $1 and code = $2`, [grant.companyId, row.cycleCode.toUpperCase()]))
    .rows[0];
  if (!cycle) throw new RowError('UNKNOWN_CYCLE');
  const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, row.employeeCode.toUpperCase()])).rows[0];
  if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
  const goal = cleanGoals([{ sequence: Number(row.sequence), description: row.description, target: row.target || null, weight: Number(row.weight) }]);
  if (row.groupStart === 'Y') {
    await createAppraisal(client, grant, { cycleId: cycle.id, employeeId: employee.id, goals: goal }, 'UPLOAD');
    return;
  }
  // Later rows add their goal to the appraisal the group's first row enrolled in this batch (a failed first row
  // rejects the whole batch, so a pre-existing appraisal is never extended by an upload).
  const appraisal = (
    await client.query<{ id: string }>(`select id from appraisal where company_id = $1 and cycle_id = $2 and employee_id = $3 and state = 'DRAFT' and source = 'UPLOAD'`, [
      grant.companyId,
      cycle.id,
      employee.id,
    ])
  ).rows[0];
  if (!appraisal) throw new RowError('APPRAISAL_NOT_ENROLLED');
  const g = goal[0]!;
  await client.query(
    `insert into appraisal_item (company_id, appraisal_id, sequence, description, target, weight, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $7)`,
    [grant.companyId, appraisal.id, g.sequence, g.description, g.target, g.weight, grant.userId],
  );
  await audit(client, grant, 'appraisal', appraisal.id, 'ADD_GOAL', null, { source: 'UPLOAD', sequence: g.sequence, description: g.description, weight: g.weight });
}

export const GOAL_IMPORT_SPEC: BatchSpec<Row> = {
  kind: 'appraisal_goals',
  // The published template (header check) is the six public columns; groupStart is added by the parser.
  template: GOAL_TEMPLATE as unknown as Template<Row>,
  parse: parseGoalFile,
  keyOf: (row, n) => (row.employeeCode ? `${row.cycleCode.toUpperCase()}/${row.employeeCode.toUpperCase()}#${row.sequence}` : `ROW-${n}`),
  apply,
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

async function grants(db: Database, request: Parameters<typeof requireAccess>[1]) {
  await requireAccess(db, request, 'appraisal', 'import', ['operational'], { requireAll: true });
  // Rows are applied under the caller's goal-setting grant, so its row scope still applies per row.
  return requireAccess(db, request, 'appraisal', 'manage', ['operational'], { requireAll: true });
}

export async function goalImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  app.post(
    '/appraisal-goal-imports',
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
      const { status, view } = await submitBatch(db, files, scanner, grant, GOAL_IMPORT_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get('/appraisal-goal-imports/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'appraisal', 'import', ['operational'], { requireAll: true, recordKey: id });
    const view = await jobView(db, grant, GOAL_IMPORT_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches (read grant) and resuming one held for the malware scan (upload grants; imports/routes.ts).
  batchFollowUpRoutes(app, {
    db,
    files,
    scanner,
    path: '/appraisal-goal-imports',
    spec: GOAL_IMPORT_SPEC,
    readGrant: (request) => requireAccess(db, request, 'appraisal', 'import', ['operational'], { requireAll: true }),
    submitGrant: (request) => grants(db, request),
  });

  app.post('/appraisal-goal-imports/:id/commit', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await grants(db, request);
    return commitBatch(db, files, grant, GOAL_IMPORT_SPEC, id);
  });

  app.post('/appraisal-goal-imports/:id/cancel', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'appraisal', 'import', ['operational'], { requireAll: true, recordKey: id });
    return cancelBatch(db, grant, GOAL_IMPORT_SPEC.kind, id);
  });
}
