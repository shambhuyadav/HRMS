// Bulk employee update import (FR-009: "separate employee creation and employee update imports"; DF09; DB083/DB084).
// Template EMPLOYEE_UPDATE_V1. A blank cell means "no change". Display name and work email change through the
// ordinary update path; department/location/designation/grade and manager changes are effective-dated changes
// through the ordinary change paths (history kept, no back-dating before the current period). Each row shows its
// proposed changes in the preview; the batch is all-or-nothing and belongs to its submitter (shared mechanics in
// ../imports, including the caller's own batches and resuming one held for the malware scan). Operational fields
// only: personal or private values are never imported.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import type { Database } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';
import { isCalendarDate, markRepeats, MAX_BATCH_BYTES, parseTemplate, RowError, type RowChanges, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { changeAssignment, changeManager } from './changes.js';
import { updateEmployee } from './service.js';

export const EMPLOYEE_UPDATE_COLUMNS = [
  'employeeCode',
  'displayName',
  'workEmail',
  'effectiveFrom',
  'departmentCode',
  'locationCode',
  'designationCode',
  'gradeCode',
  'managerEmployeeCode',
] as const;
type Column = (typeof EMPLOYEE_UPDATE_COLUMNS)[number];
export const EMPLOYEE_UPDATE_TEMPLATE: Template<Column> = { code: 'EMPLOYEE_UPDATE_V1', columns: EMPLOYEE_UPDATE_COLUMNS };

const MASTERS = { departmentCode: 'department', locationCode: 'location', designationCode: 'designation', gradeCode: 'grade' } as const;

async function masterByCode(client: pg.PoolClient, table: (typeof MASTERS)[keyof typeof MASTERS], companyId: string, code: string): Promise<string> {
  const row = (await client.query<{ id: string }>(`select id from ${table} where company_id = $1 and code = $2 and active`, [companyId, code.toUpperCase()])).rows[0];
  if (!row) throw new RowError(`UNKNOWN_${table.toUpperCase()}`);
  return row.id;
}

async function applyRow(client: pg.PoolClient, grant: AccessGrant, r: Record<Column, string>): Promise<RowChanges> {
  const target = (
    await client.query<{ id: string; display_name: string; work_email: string | null; version: number }>(
      `select id, display_name, work_email, version from employee where company_id = $1 and employee_code = $2`,
      // Employee codes are stored upper-case (0001 check constraint), as the batch's duplicate key compares them.
      [grant.companyId, r.employeeCode.toUpperCase()],
    )
  ).rows[0];
  if (!target) throw new RowError('UNKNOWN_EMPLOYEE');
  const changes: RowChanges = {};

  // Not effective-dated: the ordinary update path (row scope, history, audit, outbox).
  const update: { displayName?: string; workEmail?: string } = {};
  if (r.displayName !== '') {
    if (r.displayName.length > 200) throw new RowError('INVALID_DISPLAY_NAME');
    if (r.displayName !== target.display_name) {
      update.displayName = r.displayName;
      changes.displayName = { from: target.display_name, to: r.displayName };
    }
  }
  if (r.workEmail !== '') {
    const email = r.workEmail.toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new RowError('INVALID_WORK_EMAIL');
    if (email !== target.work_email) {
      update.workEmail = email;
      changes.workEmail = { from: target.work_email, to: email };
    }
  }
  if (Object.keys(update).length > 0) await updateEmployee(client, grant, target.id, { expectedVersion: target.version, ...update });

  const orgGiven = (Object.keys(MASTERS) as (keyof typeof MASTERS)[]).some((c) => r[c] !== '');
  if ((orgGiven || r.managerEmployeeCode !== '') && !isCalendarDate(r.effectiveFrom)) throw new RowError('EFFECTIVE_DATE_REQUIRED');
  if (!orgGiven && r.managerEmployeeCode === '' && r.effectiveFrom !== '') throw new RowError('NOTHING_TO_DATE');

  if (orgGiven) {
    const current = (
      await client.query<{ department_id: string; location_id: string; designation_id: string; grade_id: string | null; dept: string; loc: string; desig: string; grade: string | null }>(
        `select a.department_id, a.location_id, a.designation_id, a.grade_id, d.code as dept, l.code as loc, g.code as desig, gr.code as grade
           from employment_assignment a
           join department d on d.company_id = a.company_id and d.id = a.department_id
           join location l on l.company_id = a.company_id and l.id = a.location_id
           join designation g on g.company_id = a.company_id and g.id = a.designation_id
           left join grade gr on gr.company_id = a.company_id and gr.id = a.grade_id
          where a.company_id = $1 and a.employee_id = $2 and a.effective_to is null`,
        [grant.companyId, target.id],
      )
    ).rows[0];
    if (!current) throw new RowError('NO_CURRENT_ASSIGNMENT');
    const pick = async (column: keyof typeof MASTERS, currentId: string | null, currentCode: string | null) => {
      if (r[column] === '' || r[column].toUpperCase() === currentCode) return currentId;
      const id = await masterByCode(client, MASTERS[column], grant.companyId, r[column]);
      changes[column.replace(/Code$/, '')] = { from: currentCode, to: r[column].toUpperCase() };
      return id;
    };
    const departmentId = (await pick('departmentCode', current.department_id, current.dept))!;
    const locationId = (await pick('locationCode', current.location_id, current.loc))!;
    const designationId = (await pick('designationCode', current.designation_id, current.desig))!;
    const gradeId = await pick('gradeCode', current.grade_id, current.grade);
    if (departmentId !== current.department_id || locationId !== current.location_id || designationId !== current.designation_id || gradeId !== current.grade_id) {
      await changeAssignment(client, grant, target.id, { departmentId, locationId, designationId, gradeId: gradeId ?? undefined, effectiveFrom: r.effectiveFrom });
    }
  }

  if (r.managerEmployeeCode !== '') {
    const managerCode = r.managerEmployeeCode.toUpperCase();
    const manager = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, managerCode])).rows[0];
    if (!manager) throw new RowError('UNKNOWN_MANAGER');
    if (manager.id === target.id) throw new RowError('SELF_MANAGER');
    const now = (
      await client.query<{ id: string; code: string }>(
        `select m.manager_employee_id as id, me.employee_code as code from manager_assignment m join employee me on me.company_id = m.company_id and me.id = m.manager_employee_id
          where m.company_id = $1 and m.employee_id = $2 and m.effective_to is null`,
        [grant.companyId, target.id],
      )
    ).rows[0];
    if (now?.id !== manager.id) {
      try {
        await changeManager(client, grant, target.id, { managerEmployeeId: manager.id, effectiveFrom: r.effectiveFrom });
      } catch (err) {
        // A reporting line on or naming the caller's own record is refused in the single request's words, not as out of scope.
        if (err instanceof HttpError && err.code === 'SELF_ACTION_NOT_ALLOWED') throw new RowError(err.code);
        throw err;
      }
      changes.manager = { from: now?.code ?? null, to: managerCode };
    }
  }

  if (Object.keys(changes).length === 0) throw new RowError('NO_CHANGE');
  if (changes.department || changes.location || changes.designation || changes.grade || changes.manager) changes.effectiveFrom = { from: null, to: r.effectiveFrom };
  return changes;
}

export const EMPLOYEE_UPDATE_SPEC: BatchSpec<Column> = {
  kind: 'employee_update',
  template: EMPLOYEE_UPDATE_TEMPLATE,
  // One row per employee: a repeated code would make the outcome depend on row order.
  parse: (bytes) => markRepeats(parseTemplate(bytes, EMPLOYEE_UPDATE_TEMPLATE), (row) => row.employeeCode.toUpperCase(), 'DUPLICATE_IN_BATCH'),
  keyOf: (row, n) => row.employeeCode.toUpperCase() || `ROW-${n}`,
  // Rows apply under the caller's update grant, so its scope and filters apply to every row.
  apply: (client, grant, row) => applyRow(client, grant, row),
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

async function importGrants(db: Database, request: Parameters<typeof requireAccess>[1]) {
  await requireAccess(db, request, 'employee', 'import', ['operational'], { requireAll: true });
  return requireAccess(db, request, 'employee', 'update', ['operational'], { requireAll: true });
}

export async function employeeUpdateImportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  app.post(
    '/employees/update-imports',
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
      const { status, view } = await submitBatch(db, files, scanner, grant, EMPLOYEE_UPDATE_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get('/employees/update-imports/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'import', ['operational'], { requireAll: true, recordKey: id });
    const view = await jobView(db, grant, EMPLOYEE_UPDATE_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own batches (read grant) and resuming one held for the malware scan (upload grants; imports/routes.ts).
  batchFollowUpRoutes(app, {
    db,
    files,
    scanner,
    path: '/employees/update-imports',
    spec: EMPLOYEE_UPDATE_SPEC,
    readGrant: (request) => requireAccess(db, request, 'employee', 'import', ['operational'], { requireAll: true }),
    submitGrant: (request) => importGrants(db, request),
  });

  app.post('/employees/update-imports/:id/commit', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await importGrants(db, request);
    return commitBatch(db, files, grant, EMPLOYEE_UPDATE_SPEC, id);
  });

  app.post('/employees/update-imports/:id/cancel', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'import', ['operational'], { requireAll: true, recordKey: id });
    return cancelBatch(db, grant, EMPLOYEE_UPDATE_SPEC.kind, id);
  });
}
