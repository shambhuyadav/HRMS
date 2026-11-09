import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { HttpError } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import { ATTENDANCE_MINUTE_FIELDS } from '../attendance/service.js';
import { EMPLOYEE_SORTS, EMPLOYEE_STATUS_GROUPS, SORT_DIRECTIONS } from '../employee/service.js';
import { TEAM_SORTS } from '../team/service.js';
import { COMPENSATION_BASES, REPORT_FORMATS, REPORTS, type ReportFilters, type ReportFormat } from './catalogue.js';
import { downloadReport, listOwnReports, reportCatalogue, reportStatus, requestReport, SCOPE_CHANGED } from './service.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;
const uuid = { type: 'string', format: 'uuid' } as const;

export async function reportRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // Only the reports the selected role may ask for (reportCatalogue). `formats` is listed only for a report that offers more than
  // CSV (FR-046 XLSX).
  app.get('/reports/catalogue', async (request) => ({
    items: (await reportCatalogue(db, actorOf(request))).map((r) => ({
      code: r.code,
      title: r.title,
      requiresPeriod: r.requiresPeriod,
      columns: r.columns.map((c) => c.header),
      ...(r.xlsx ? { formats: [...REPORT_FORMATS] } : {}),
    })),
  }));

  app.post(
    '/reports',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reportCode'],
          properties: {
            reportCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' },
            filters: {
              type: 'object',
              additionalProperties: false,
              properties: {
                from: { type: 'string', format: 'date' },
                to: { type: 'string', format: 'date' },
                status: { type: 'string', pattern: '^[A-Z_]{1,40}$' },
                // FR-007: the employee list's filters, for reports that declare them (the employee register).
                search: { type: 'string', maxLength: 100 },
                statusGroup: { type: 'string', enum: Object.keys(EMPLOYEE_STATUS_GROUPS) },
                departmentId: { type: 'string', format: 'uuid' },
                joinedFrom: { type: 'string', format: 'date' },
                joinedTo: { type: 'string', format: 'date' },
                // Each report's own sort columns are checked when it is requested (the employee list's, or My Team's).
                sort: { type: 'string', enum: [...new Set<string>([...EMPLOYEE_SORTS, ...TEAM_SORTS])] },
                direction: { type: 'string', enum: [...SORT_DIRECTIONS] },
                // DF16: the My Team list's filters, for its export.
                reviewDueFrom: { type: 'string', format: 'date' },
                reviewDueTo: { type: 'string', format: 'date' },
                todayAttendance: { type: 'string', pattern: '^[A-Z_]{1,40}$' },
                confirmationDueTo: { type: 'string', format: 'date' },
                // FR-093 / DF14: the comparable basis, for reports that declare it (the employee annual increment).
                basis: { type: 'string', enum: [...COMPENSATION_BASES] },
                // A list's record filters, for reports that declare them (the timesheet exports, FR-046/FR-048; the
                // payroll run of the payroll reports, FR-038).
                employeeId: uuid,
                projectId: uuid,
                jobId: uuid,
                activityId: uuid,
                runId: uuid,
                // FR-021 / E07 attendance control's filters, for the attendance register.
                locationId: uuid,
                shiftId: uuid,
                minuteField: { type: 'string', enum: [...ATTENDANCE_MINUTE_FIELDS] },
                minuteOp: { type: 'string', enum: ['LT', 'LTE', 'EQ', 'GTE', 'GT'] },
                minuteValue: { type: 'integer', minimum: 0, maximum: 100000 },
                // FR-024 / E06: one leave type, for the mapped-policy export.
                leaveType: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' },
                // BR-026: the audit viewer's record filters, with its own patterns (audit-trail/routes.ts), for the audit export.
                resource: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,59}$' },
                recordKey: uuid,
                actorUserId: uuid,
                action: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' },
                // FR-093: the confirmation list's view, the delivery log's event type and one biometric profile, with each
                // list's own patterns; every report that takes one checks its values when it is requested.
                view: { type: 'string', pattern: '^[A-Z_0-9]{1,20}$' },
                category: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' },
                profileId: uuid,
              },
            },
            // FR-046: CSV by default; XLSX for reports that declare it.
            format: { type: 'string', enum: [...REPORT_FORMATS] },
          },
        },
      },
    },
    async (request, reply) => {
      const { reportCode, filters, format } = request.body as { reportCode: string; filters?: ReportFilters; format?: ReportFormat };
      const def = REPORTS[reportCode];
      if (!def) throw new HttpError(422, 'UNKNOWN_REPORT', 'Unknown report');
      const grant = await requireAccess(db, request, def.resource, 'export', [def.fieldGroup], { requireAll: true });
      const result = await withTransaction(db, (tx) => requestReport(tx, grant, reportCode, filters ?? {}, format ?? 'CSV'));
      reply.status(202);
      return result;
    },
  );

  // FR-056 "recoverable download links": the caller's own executions under the selected assignment, newest first.
  app.get('/reports', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { ...optionalPaging } } } }, async (request) =>
    listOwnReports(db, actorOf(request), request.query as Paging),
  );

  app.get('/reports/:id', { schema: { params: idParams } }, async (request) => {
    return reportStatus(db, actorOf(request), (request.params as { id: string }).id);
  });

  app.get('/reports/:id/download', { schema: { params: idParams } }, async (request, reply) => {
    const actor = actorOf(request);
    const { id } = request.params as { id: string };
    const file = await downloadReport(db, actor, id).catch(async (e: unknown) => {
      // FR-098: a file withheld because its scope narrowed leaves redacted evidence (no filter, row or name).
      if (e instanceof HttpError && e.code === SCOPE_CHANGED) await auditDenial(db, request, { resource: 'report_execution', action: 'export', reason: 'SCOPE_NARROWED', recordKey: id });
      throw e;
    });
    reply
      .header('content-type', typeof file.content === 'string' ? `${file.mediaType}; charset=utf-8` : file.mediaType)
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .header('cache-control', 'no-store');
    return file.content;
  });
}
