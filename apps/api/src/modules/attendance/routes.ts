import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { BULK_KINDS } from '../bulk/kinds.js';
import { enqueueBulkJob } from '../bulk/service.js';
import {
  amendmentLog,
  amendRecord,
  type AttendanceControlFilters,
  attendanceControl,
  attendanceDay,
  listAttendance,
  NO_POLICY_PAGE_DEFAULT,
  NO_POLICY_PAGE_MAX,
  type NoPolicyPageQuery,
  processingNoPolicy,
  processingUnprocessed,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const noPolicyPage = {
  type: 'object',
  additionalProperties: false,
  properties: { after: { type: 'string', minLength: 1, maxLength: 400 }, limit: { type: 'integer', minimum: 1, maximum: NO_POLICY_PAGE_MAX, default: NO_POLICY_PAGE_DEFAULT } },
} as const;

const amendSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'status', 'reason'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    // Every reviewed outcome except EXCEPTION (an amendment resolves a review). Leave, outdoor duty and off days need
    // their fact on the work date (service.ts assertAmendmentFact): ON_DUTY records an outdoor duty approved after the
    // day was evaluated or already amended (FR-027).
    status: { type: 'string', enum: ['PRESENT', 'HALF_DAY', 'ABSENT', 'LEAVE', 'HALF_DAY_LEAVE', 'HOLIDAY', 'WEEKLY_OFF', 'ON_DUTY'] },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

/** FR-021 / E07 attendance control: the filters of the list and its export (service.ts AttendanceControlFilters), paged with totals. */
const controlQuery = {
  type: 'object',
  additionalProperties: false,
  required: ['from', 'to'],
  properties: {
    from: date,
    to: date,
    departmentId: uuid,
    locationId: uuid,
    status: { type: 'string', pattern: '^[A-Z_]{1,40}$' },
    shiftId: uuid,
    employeeId: uuid,
    search: { type: 'string', maxLength: 100 },
    minuteField: { type: 'string', enum: ['WORKED', 'SCHEDULED', 'SHORTFALL'] },
    minuteOp: { type: 'string', enum: ['LT', 'LTE', 'EQ', 'GTE', 'GT'] },
    minuteValue: { type: 'integer', minimum: 0, maximum: 100000 },
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 },
  },
} as const;

export async function attendanceRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // FR-022 processing of one work date over the caller's scope: queued as a bulk job and run by the worker in bounded
  // chunks under the caller's re-checked authority (NFR-S09); the answer is 202 with the job to follow (GET
  // /v1/bulk-jobs/:id: state and counts), and the employees it found without a policy are read below.
  app.post(
    '/attendance/processing',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['workDate'], properties: { workDate: date, idempotencyKey } } } },
    async (request, reply) => {
      const { resource, action, fieldGroups } = BULK_KINDS.ATTENDANCE_PROCESSING.permission; // attendance.process.operational
      const grant = await requireAccess(db, request, resource, action, fieldGroups, { requireAll: true });
      const { workDate, idempotencyKey: key } = request.body as { workDate: string; idempotencyKey?: string };
      const job = await withTransaction(db, (tx) => enqueueBulkJob(tx, grant, 'ATTENDANCE_PROCESSING', { workDate }, key));
      reply.status(202);
      return job;
    },
  );

  // The employees a processing job found without an applicable policy, a page at a time in employee-code order: the
  // job's requester under the processing permission, listing only the employees in the caller's row scope (as the
  // processing request); operational fields only (employee id, code, name).
  app.get('/attendance/processing/:id/no-policy-employees', { schema: { params: idParams, querystring: noPolicyPage } }, async (request) => {
    const { id } = request.params as { id: string };
    const { resource, action, fieldGroups } = BULK_KINDS.ATTENDANCE_PROCESSING.permission;
    const grant = await requireAccess(db, request, resource, action, fieldGroups, { requireAll: true, recordKey: id });
    return processingNoPolicy(db, grant, id, request.query as NoPolicyPageQuery);
  });

  // FR-022: who a job has not processed, a page at a time (the one a failing chunk stopped on carries its error class);
  // the same requester, permission and row scope as above.
  app.get('/attendance/processing/:id/unprocessed-employees', { schema: { params: idParams, querystring: noPolicyPage } }, async (request) => {
    const { id } = request.params as { id: string };
    const { resource, action, fieldGroups } = BULK_KINDS.ATTENDANCE_PROCESSING.permission;
    const grant = await requireAccess(db, request, resource, action, fieldGroups, { requireAll: true, recordKey: id });
    return processingUnprocessed(db, grant, id, request.query as NoPolicyPageQuery);
  });

  // FR-021 / E07: attendance across the caller's row scope.
  app.get('/attendance/records', { schema: { querystring: controlQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'attendance', 'read', ['operational']);
    const { page, pageSize, ...filters } = request.query as AttendanceControlFilters & { page: number; pageSize: number };
    return attendanceControl(db, grant, filters, { page, pageSize });
  });

  // FR-021: a day's untouched source punches beside its derived result.
  app.get('/attendance/records/:id/day', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'attendance', 'read', ['operational'], { recordKey: id });
    return attendanceDay(db, grant, id);
  });

  app.get(
    '/employees/:id/attendance',
    { schema: { params: idParams, querystring: { type: 'object', required: ['from', 'to'], additionalProperties: false, properties: { from: date, to: date } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const { from, to } = request.query as { from: string; to: string };
      if (to < from) throw new HttpError(400, 'INVALID_REQUEST', 'to must not be before from');
      const grant = await requireAccess(db, request, 'attendance', 'read', ['operational'], { recordKey: id });
      return listAttendance(db, grant, id, from, to);
    },
  );

  app.post('/attendance/records/:id/amend', { schema: { params: idParams, body: amendSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'attendance', 'amend', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => amendRecord(tx, grant, id, request.body as { expectedVersion: number; status: string; reason: string }));
    return { id, status: (request.body as { status: string }).status, amended: true };
  });

  app.get('/attendance/records/:id/amendments', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    // Amendment reasons are a separate confidential group ("attendance detail excludes private reasons").
    const grant = await requireAccess(db, request, 'attendance', 'read', ['operational', 'reason'], { recordKey: id });
    return amendmentLog(db, grant, id);
  });
}
