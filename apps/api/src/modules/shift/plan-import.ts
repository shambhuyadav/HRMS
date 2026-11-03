// Shift-plan imports (FR-023; DF09). Template SHIFT_PLAN_V1: employeeCode,shiftCode,effectiveFrom. Each row is
// applied through the ordinary effective-dated shift change (history, audit); an assignment outside the
// employee's employment dates is rejected. Batches are all-or-nothing (imports/batch.ts); the caller's own batches
// are listed and one held for the malware scan is resumed from its stored file (imports/routes.ts).
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';
import { changeShift } from '../employee/changes.js';
import { isCalendarDate, MAX_BATCH_BYTES, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';

const COLUMNS = ['employeeCode', 'shiftCode', 'effectiveFrom'] as const;
type Column = (typeof COLUMNS)[number];
export const SHIFT_PLAN_TEMPLATE: Template<Column> = { code: 'SHIFT_PLAN_V1', columns: COLUMNS };

const ENDED_STATUSES = ['INACTIVE_SEPARATED', 'ARCHIVED'];

export const SHIFT_PLAN_SPEC: BatchSpec<Column> = {
  kind: 'shift_plan',
  template: SHIFT_PLAN_TEMPLATE,
  parse: (bytes) => parseTemplate(bytes, SHIFT_PLAN_TEMPLATE),
  keyOf: (row, n) => (row.employeeCode ? `${row.employeeCode.toUpperCase()}@${row.effectiveFrom}` : `ROW-${n}`),
  async apply(client, grant: AccessGrant, row) {
    if (!isCalendarDate(row.effectiveFrom)) throw new RowError('INVALID_DATE');
    const employee = (
      await client.query<{ id: string; joining_date: string; status: string }>(
        `select e.id, to_char(e.joining_date, 'YYYY-MM-DD') as joining_date, st.code as status
           from employee e join reference_value st on st.company_id = e.company_id and st.id = e.status_id
          where e.company_id = $1 and e.employee_code = $2`,
        [grant.companyId, row.employeeCode.toUpperCase()],
      )
    ).rows[0];
    if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
    // FR-023 acceptance: an assignment outside the employment dates is rejected.
    if (ENDED_STATUSES.includes(employee.status)) throw new RowError('EMPLOYMENT_ENDED');
    if (row.effectiveFrom < employee.joining_date) throw new RowError('BEFORE_JOINING');
    const shift = (await client.query<{ id: string }>(`select id from shift where company_id = $1 and code = $2 and active`, [grant.companyId, row.shiftCode.toUpperCase()])).rows[0];
    if (!shift) throw new RowError('UNKNOWN_SHIFT');
    await changeShift(client, grant, employee.id, { shiftId: shift.id, effectiveFrom: row.effectiveFrom });
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

async function grants(db: Database, request: Parameters<typeof requireAccess>[1]) {
  await requireAccess(db, request, 'shift', 'import', ['operational'], { requireAll: true });
  // Rows are applied under the caller's shift assignment grant, so its scope still applies per row.
  return requireAccess(db, request, 'shift', 'assign', ['operational'], { requireAll: true });
}

export async function shiftPlanImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  app.post(
    '/shifts/plan-imports',
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
      const { status, view } = await submitBatch(db, files, scanner, grant, SHIFT_PLAN_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get('/shifts/plan-imports/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'shift', 'import', ['operational'], { requireAll: true, recordKey: id });
    const view = await jobView(db, grant, SHIFT_PLAN_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches (read grant) and resuming one held for the malware scan (upload grants; imports/routes.ts).
  batchFollowUpRoutes(app, {
    db,
    files,
    scanner,
    path: '/shifts/plan-imports',
    spec: SHIFT_PLAN_SPEC,
    readGrant: (request) => requireAccess(db, request, 'shift', 'import', ['operational'], { requireAll: true }),
    submitGrant: (request) => grants(db, request),
  });

  app.post('/shifts/plan-imports/:id/commit', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await grants(db, request);
    return commitBatch(db, files, grant, SHIFT_PLAN_SPEC, id);
  });

  app.post('/shifts/plan-imports/:id/cancel', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'shift', 'import', ['operational'], { requireAll: true, recordKey: id });
    return cancelBatch(db, grant, SHIFT_PLAN_SPEC.kind, id);
  });
}
