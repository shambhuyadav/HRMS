// Bulk employee onboarding import (FR-009; DF09; DB083/DB084). Template EMPLOYEE_ONBOARDING_V1. Preview runs the
// real create path in a rolled-back transaction; the batch is all-or-nothing (DF09: an employee master batch with
// an identity/company/reference error is rejected entirely — every row error rejects it here); a job belongs to
// its submitter. Imports carry operational fields only; personal fields are never imported. Mechanics live in
// ../imports (batch.ts, jobs.ts, routes.ts: the caller's own batches and resuming one held for the malware scan),
// shared with every other batch import.
import type { FastifyInstance } from 'fastify';
import type { Queryable } from '../../db/queryable.js';
import type { Database } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { isCalendarDate, MAX_BATCH_BYTES, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { type CreateEmployeeInput, createEmployee } from './service.js';

export const EMPLOYEE_IMPORT_COLUMNS = [
  'employeeCode',
  'displayName',
  'workEmail',
  'joiningDate',
  'employmentType',
  'departmentCode',
  'locationCode',
  'designationCode',
  'gradeCode',
] as const;
type Column = (typeof EMPLOYEE_IMPORT_COLUMNS)[number];
export const EMPLOYEE_IMPORT_TEMPLATE: Template<Column> = { code: 'EMPLOYEE_ONBOARDING_V1', columns: EMPLOYEE_IMPORT_COLUMNS };

async function masterId(tx: Queryable, table: 'department' | 'location' | 'designation' | 'grade', companyId: string, code: string): Promise<string> {
  const row = (await tx.query<{ id: string }>(`select id from ${table} where company_id = $1 and code = $2 and active`, [companyId, code.toUpperCase()])).rows[0];
  if (!row) throw new RowError(`UNKNOWN_${table.toUpperCase()}`);
  return row.id;
}

async function toInput(tx: Queryable, companyId: string, r: Record<Column, string>): Promise<CreateEmployeeInput> {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(r.employeeCode)) throw new RowError('INVALID_EMPLOYEE_CODE');
  if (r.displayName === '' || r.displayName.length > 200) throw new RowError('INVALID_DISPLAY_NAME');
  if (r.workEmail !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.workEmail)) throw new RowError('INVALID_WORK_EMAIL');
  if (!isCalendarDate(r.joiningDate)) throw new RowError('INVALID_JOINING_DATE');
  return {
    employeeCode: r.employeeCode,
    displayName: r.displayName,
    workEmail: r.workEmail || undefined,
    joiningDate: r.joiningDate,
    employmentType: r.employmentType.toUpperCase(),
    departmentId: await masterId(tx, 'department', companyId, r.departmentCode),
    locationId: await masterId(tx, 'location', companyId, r.locationCode),
    designationId: await masterId(tx, 'designation', companyId, r.designationCode),
    gradeId: r.gradeCode ? await masterId(tx, 'grade', companyId, r.gradeCode) : undefined,
  };
}

export const EMPLOYEE_IMPORT_SPEC: BatchSpec<Column> = {
  kind: 'employee',
  template: EMPLOYEE_IMPORT_TEMPLATE,
  parse: (bytes) => parseTemplate(bytes, EMPLOYEE_IMPORT_TEMPLATE),
  keyOf: (row, n) => row.employeeCode.toUpperCase() || `ROW-${n}`,
  // Rows are created under the caller's create grant, so its company scope and filters apply to every row.
  apply: async (client, grant, row) => {
    await createEmployee(client, grant, await toInput(client, grant.companyId, row));
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

async function importGrants(db: Database, request: Parameters<typeof requireAccess>[1]) {
  await requireAccess(db, request, 'employee', 'import', ['operational'], { requireAll: true });
  return requireAccess(db, request, 'employee', 'create', ['operational'], { requireAll: true });
}

export async function employeeImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  app.post(
    '/employees/imports',
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
      const grant = await importGrants(db, request);
      const { status, view } = await submitBatch(db, files, scanner, grant, EMPLOYEE_IMPORT_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get('/employees/imports/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'import', ['operational'], { requireAll: true, recordKey: id });
    const view = await jobView(db, grant, EMPLOYEE_IMPORT_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches (read grant) and resuming one held for the malware scan (upload grants; imports/routes.ts).
  batchFollowUpRoutes(app, {
    db,
    files,
    scanner,
    path: '/employees/imports',
    spec: EMPLOYEE_IMPORT_SPEC,
    readGrant: (request) => requireAccess(db, request, 'employee', 'import', ['operational'], { requireAll: true }),
    submitGrant: (request) => importGrants(db, request),
  });

  app.post('/employees/imports/:id/commit', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await importGrants(db, request);
    return commitBatch(db, files, grant, EMPLOYEE_IMPORT_SPEC, id);
  });

  app.post('/employees/imports/:id/cancel', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'import', ['operational'], { requireAll: true, recordKey: id });
    return cancelBatch(db, grant, EMPLOYEE_IMPORT_SPEC.kind, id);
  });
}
