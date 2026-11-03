// Timesheets (FR-045 to FR-048; F1 timesheets): HTTP routes. Every route checks access first (DF02/C1): masters and
// allocations by their own resources, the employee's own weeks in the Employee OWN context (H3 TN13; BR-055),
// reviews through the engine's tasks, and reports within the assignment's row scope.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { optionalPaging, type Paging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { type AccessGrant, OWN_ESS_ROLE_CODES } from '../access/authorize.js';
import { MAX_BATCH_BYTES } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import {
  ALLOCATION_IMPORT_SPEC,
  type AllocationInput,
  type AllocationPatch,
  type AllocationQuery,
  allocationView,
  cancelAllocation,
  createAllocation,
  listAllocations,
  ownAllocations,
  updateAllocation,
} from './allocations.js';
import { listExceptions, listOwnExceptions, resolveException } from './exceptions.js';
import { LINE_IMPORT_SPEC } from './line-import.js';
import {
  activityDetail,
  createActivity,
  createJob,
  createProject,
  jobDetail,
  listActivities,
  listProjects,
  type MasterInput,
  type MasterPatch,
  projectDetail,
  setJobActivity,
  updateActivity,
  updateJob,
  updateProject,
} from './masters.js';
import { decideReopen, reopenTasks, requestReopen } from './reopen.js';
import { type Dimension, hoursLines, hoursReport, utilisationReport } from './reports.js';
import {
  addOwnLine,
  createOwnTimesheet,
  type DecisionInput,
  decideTimesheet,
  type LineInput,
  listOwnTimesheets,
  listTimesheets,
  removeOwnLine,
  reviseTimesheet,
  type SheetQuery,
  submitTimesheet,
  timesheetDetail,
  timesheetTasks,
  updateOwnLine,
} from './sheets.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const taskParams = { type: 'object', required: ['taskId'], properties: { taskId: uuid } } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const code = { type: 'string', pattern: '^\\s*[A-Za-z0-9][A-Za-z0-9_-]{0,39}\\s*$' } as const;
const name = { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' } as const;
const percent = { type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,2})?$' } as const;
const minutes = { type: 'integer', minimum: 15, maximum: 1440, multipleOf: 15 } as const;
const note = { anyOf: [{ type: 'string', maxLength: 500 }, { type: 'null' }] } as const;
const masterBody = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'name', 'ownerEmployeeId', 'startDate'],
  properties: { code, name, ownerEmployeeId: uuid, startDate: date, endDate: { anyOf: [date, { type: 'null' }] } },
} as const;
const masterPatch = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  minProperties: 2,
  properties: { expectedVersion, name, ownerEmployeeId: uuid, startDate: date, endDate: { anyOf: [date, { type: 'null' }] }, active: { type: 'boolean' } },
} as const;
// FR-056: page/pageSize ask for a page; without them a list keeps its capped first answer, `total` counting every match.
const activeQuery = { type: 'object', additionalProperties: false, properties: { active: { type: 'boolean' }, ...optionalPaging } } as const;
const rangeQuery = { type: 'object', additionalProperties: false, properties: { from: date, to: date, ...optionalPaging } } as const;
const pagingQuery = { type: 'object', additionalProperties: false, properties: { ...optionalPaging } } as const;
const importBody = {
  type: 'object',
  additionalProperties: false,
  required: ['fileName', 'contentBase64', 'idempotencyKey'],
  properties: {
    fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\<>:"|?*\\x00-\\x1f\\x7f]+$' },
    contentBase64: { type: 'string', minLength: 4 },
    idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
  },
} as const;

/** BR-055 / H3: own timesheets are served in the Employee OWN context; other roles switch to it. */
function ownContext(grant: AccessGrant): AccessGrant {
  if (!OWN_ESS_ROLE_CODES.includes(grant.roleCode) || grant.scopeKind !== 'OWN' || !grant.linkedEmployeeId) {
    throw new HttpError(403, 'EMPLOYEE_CONTEXT_REQUIRED', 'Select your Employee role to work on your own timesheets');
  }
  return grant;
}

export async function timesheetRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  const access = (request: FastifyRequest, resource: string, action: string, recordKey?: string) =>
    requireAccess(db, request, resource, action, ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const own = async (request: FastifyRequest, action: 'submit' | 'read', recordKey?: string) => ownContext(await access(request, 'timesheet', action, recordKey));

  // ---- FR-045 masters --------------------------------------------------------------------------------------------
  app.get('/timesheet/projects', { schema: { querystring: activeQuery } }, async (request) =>
    listProjects(db, await access(request, 'timesheet_master', 'read'), request.query as { active?: boolean } & Paging),
  );
  app.post('/timesheet/projects', { schema: { body: masterBody } }, async (request, reply) => {
    const grant = await access(request, 'timesheet_master', 'manage');
    const result = await withTransaction(db, (tx) => createProject(tx, grant, request.body as MasterInput));
    reply.status(201);
    return result;
  });
  app.get('/timesheet/projects/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return projectDetail(db, await access(request, 'timesheet_master', 'read', id), id);
  });
  app.patch('/timesheet/projects/:id', { schema: { params: idParams, body: masterPatch } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await access(request, 'timesheet_master', 'manage', id);
    return withTransaction(db, (tx) => updateProject(tx, grant, id, request.body as MasterPatch));
  });
  app.post('/timesheet/projects/:id/jobs', { schema: { params: idParams, body: masterBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await access(request, 'timesheet_master', 'manage', id);
    const result = await withTransaction(db, (tx) => createJob(tx, grant, id, request.body as MasterInput));
    reply.status(201);
    return result;
  });
  app.get('/timesheet/jobs/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return jobDetail(db, await access(request, 'timesheet_master', 'read', id), id);
  });
  app.patch('/timesheet/jobs/:id', { schema: { params: idParams, body: masterPatch } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await access(request, 'timesheet_master', 'manage', id);
    return withTransaction(db, (tx) => updateJob(tx, grant, id, request.body as MasterPatch));
  });
  app.put(
    '/timesheet/jobs/:id/activities/:activityId',
    {
      schema: {
        params: { type: 'object', required: ['id', 'activityId'], properties: { id: uuid, activityId: uuid } },
        body: { type: 'object', additionalProperties: false, required: ['active'], properties: { active: { type: 'boolean' } } },
      },
    },
    async (request) => {
      const { id, activityId } = request.params as { id: string; activityId: string };
      const grant = await access(request, 'timesheet_master', 'manage', id);
      return withTransaction(db, (tx) => setJobActivity(tx, grant, id, activityId, (request.body as { active: boolean }).active));
    },
  );
  app.get('/timesheet/activities', { schema: { querystring: activeQuery } }, async (request) =>
    listActivities(db, await access(request, 'timesheet_master', 'read'), request.query as { active?: boolean } & Paging),
  );
  app.post(
    '/timesheet/activities',
    { schema: { body: { ...masterBody, required: [...masterBody.required, 'productive'], properties: { ...masterBody.properties, productive: { type: 'boolean' } } } } },
    async (request, reply) => {
      const grant = await access(request, 'timesheet_master', 'manage');
      const result = await withTransaction(db, (tx) => createActivity(tx, grant, request.body as MasterInput & { productive: boolean }));
      reply.status(201);
      return result;
    },
  );
  app.get('/timesheet/activities/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return activityDetail(db, await access(request, 'timesheet_master', 'read', id), id);
  });
  app.patch(
    '/timesheet/activities/:id',
    { schema: { params: idParams, body: { ...masterPatch, properties: { ...masterPatch.properties, productive: { type: 'boolean' } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await access(request, 'timesheet_master', 'manage', id);
      return withTransaction(db, (tx) => updateActivity(tx, grant, id, request.body as MasterPatch & { productive?: boolean }));
    },
  );

  // ---- FR-046 allocations ----------------------------------------------------------------------------------------
  app.get(
    '/timesheet/allocations',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { employeeId: uuid, projectId: uuid, jobId: uuid, from: date, to: date, state: { type: 'string', enum: ['ACTIVE', 'CANCELLED'] }, ...optionalPaging },
        },
      },
    },
    async (request) => listAllocations(db, await access(request, 'timesheet_allocation', 'read'), request.query as AllocationQuery),
  );
  app.post(
    '/timesheet/allocations',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['employeeId', 'jobId', 'startDate', 'endDate', 'allocationPercent'],
          properties: { employeeId: uuid, jobId: uuid, startDate: date, endDate: date, allocationPercent: percent, overAllocationReason: reason },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as AllocationInput;
      const grant = await access(request, 'timesheet_allocation', 'manage', body.employeeId);
      const result = await withTransaction(db, (tx) => createAllocation(tx, grant, body));
      reply.status(201);
      return result;
    },
  );
  app.get('/timesheet/allocations/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return allocationView(db, await access(request, 'timesheet_allocation', 'read', id), id);
  });
  app.patch(
    '/timesheet/allocations/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          minProperties: 2,
          properties: { expectedVersion, endDate: date, allocationPercent: percent, overAllocationReason: reason },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await access(request, 'timesheet_allocation', 'manage', id);
      return withTransaction(db, (tx) => updateAllocation(tx, grant, id, request.body as AllocationPatch));
    },
  );
  app.post(
    '/timesheet/allocations/:id/cancel',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason', 'expectedVersion'], properties: { reason, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await access(request, 'timesheet_allocation', 'manage', id);
      return withTransaction(db, (tx) => cancelAllocation(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
    },
  );

  // ---- DF09 batch imports: allocations (FR-046 bulk upload) and timesheet entries (FR-047) ----------------------
  // `guard` is the upload and commit grant (rows apply under it), `viewer` the read grant; the caller's own batches and
  // resuming one held for the malware scan come from imports/routes.ts under the same two grants.
  const importRoutes = <C extends string>(path: string, spec: BatchSpec<C>, guard: (request: FastifyRequest) => Promise<AccessGrant>, viewer: (request: FastifyRequest, id?: string) => Promise<AccessGrant>) => {
    app.post(path, { bodyLimit: Math.ceil(MAX_BATCH_BYTES * 1.4), schema: { body: importBody } }, async (request, reply) => {
      const grant = await guard(request);
      const { status, view } = await submitBatch(db, files, scanner, grant, spec, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    });
    app.get(`${path}/:id`, { schema: { params: idParams } }, async (request) => {
      const { id } = request.params as { id: string };
      const view = await jobView(db, await viewer(request, id), spec.kind, id);
      if (!view) throw notFound();
      return view;
    });
    app.post(`${path}/:id/commit`, { schema: { params: idParams } }, async (request) => {
      const { id } = request.params as { id: string };
      return commitBatch(db, files, await guard(request), spec, id);
    });
    app.post(`${path}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
      const { id } = request.params as { id: string };
      return cancelBatch(db, await viewer(request, id), spec.kind, id);
    });
    batchFollowUpRoutes(app, { db, files, scanner, path, spec, readGrant: (request) => viewer(request), submitGrant: (request) => guard(request) });
  };
  // Rows are applied under the caller's allocation grant, so its row scope still applies to every row.
  importRoutes(
    '/timesheet/allocation-imports',
    ALLOCATION_IMPORT_SPEC,
    async (request) => {
      await access(request, 'timesheet_allocation', 'import');
      return access(request, 'timesheet_allocation', 'manage');
    },
    (request, id) => access(request, 'timesheet_allocation', 'import', id),
  );
  importRoutes(
    '/timesheet/line-imports',
    LINE_IMPORT_SPEC,
    (request) => access(request, 'timesheet', 'import'),
    (request, id) => access(request, 'timesheet', 'import', id),
  );

  // ---- H3 TN13: the employee's own weeks (Employee OWN context) --------------------------------------------------
  app.get('/me/timesheets', { schema: { querystring: rangeQuery } }, async (request) =>
    listOwnTimesheets(db, await own(request, 'read'), request.query as { from?: string; to?: string } & Paging),
  );
  app.post(
    '/me/timesheets',
    { schema: { body: { type: 'object', additionalProperties: false, required: ['periodStart'], properties: { periodStart: date } } } },
    async (request, reply) => {
      const grant = await own(request, 'submit');
      const result = await withTransaction(db, (tx) => createOwnTimesheet(tx, grant, request.body as { periodStart: string }));
      reply.status(201);
      return result;
    },
  );
  app.post(
    '/me/timesheets/:id/lines',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['workDate', 'jobId', 'activityId', 'minutes'], properties: { workDate: date, jobId: uuid, activityId: uuid, minutes, note } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await own(request, 'submit', id);
      const result = await withTransaction(db, (tx) => addOwnLine(tx, grant, id, request.body as LineInput));
      reply.status(201);
      return result;
    },
  );
  app.put(
    '/me/timesheets/:id/lines/:lineId',
    {
      schema: {
        params: { type: 'object', required: ['id', 'lineId'], properties: { id: uuid, lineId: uuid } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          minProperties: 2,
          properties: { expectedVersion, workDate: date, jobId: uuid, activityId: uuid, minutes, note },
        },
      },
    },
    async (request) => {
      const { id, lineId } = request.params as { id: string; lineId: string };
      const grant = await own(request, 'submit', id);
      return withTransaction(db, (tx) => updateOwnLine(tx, grant, id, lineId, request.body as Partial<LineInput> & { expectedVersion: number }));
    },
  );
  app.post('/me/timesheets/:id/lines/:lineId/remove', { schema: { params: { type: 'object', required: ['id', 'lineId'], properties: { id: uuid, lineId: uuid } } } }, async (request) => {
    const { id, lineId } = request.params as { id: string; lineId: string };
    const grant = await own(request, 'submit', id);
    return withTransaction(db, (tx) => removeOwnLine(tx, grant, id, lineId));
  });
  app.post(
    '/me/timesheets/:id/submit',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await own(request, 'submit', id);
      return withTransaction(db, (tx) => submitTimesheet(tx, grant, id, request.body as { expectedVersion: number }));
    },
  );
  app.post('/me/timesheets/:id/revise', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await own(request, 'submit', id);
    const result = await withTransaction(db, (tx) => reviseTimesheet(tx, grant, id));
    reply.status(201);
    return result;
  });
  app.get('/me/timesheet-allocations', { schema: { querystring: pagingQuery } }, async (request) => ownAllocations(db, await own(request, 'submit'), request.query as Paging));
  app.get('/me/timesheet-exceptions', { schema: { querystring: pagingQuery } }, async (request) => listOwnExceptions(db, await own(request, 'read'), request.query as Paging));

  // ---- CL-137/CL-138 review and HR view (row scope) --------------------------------------------------------------
  app.get(
    '/timesheets',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { from: date, to: date, employeeId: uuid, state: { type: 'string', enum: ['DRAFT', 'SUBMITTED', 'RETURNED', 'REJECTED', 'APPROVED'] }, ...optionalPaging },
        },
      },
    },
    async (request) => listTimesheets(db, await access(request, 'timesheet', 'read'), request.query as SheetQuery),
  );
  app.get(
    '/timesheets/:id',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { revision: { type: 'integer', minimum: 1, maximum: 100000 } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      return timesheetDetail(db, await access(request, 'timesheet', 'read', id), id, request.query as { revision?: number });
    },
  );
  app.get('/timesheet-tasks', async (request) => timesheetTasks(db, await access(request, 'timesheet', 'approve')));
  app.post(
    '/timesheet-tasks/:taskId/decision',
    {
      schema: {
        params: taskParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'idempotencyKey'],
          properties: { decision: { type: 'string', enum: ['APPROVE', 'RETURN', 'REJECT'] }, reason, idempotencyKey },
        },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      const grant = await access(request, 'timesheet', 'approve', taskId);
      return withTransaction(db, (tx) => decideTimesheet(tx, grant, taskId, request.body as DecisionInput));
    },
  );

  // ---- F1 independent authorised reopen --------------------------------------------------------------------------
  app.post(
    '/timesheets/:id/reopen-requests',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await access(request, 'timesheet', 'request_reopen', id);
      const result = await withTransaction(db, (tx) => requestReopen(tx, grant, id, request.body as { reason: string }));
      reply.status(201);
      return result;
    },
  );
  app.get('/timesheet-reopen-tasks', async (request) => reopenTasks(db, await access(request, 'timesheet', 'reopen')));
  app.post(
    '/timesheet-reopen-tasks/:taskId/decision',
    {
      schema: {
        params: taskParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'idempotencyKey'],
          properties: { decision: { type: 'string', enum: ['APPROVE', 'REJECT'] }, reason, idempotencyKey },
        },
      },
    },
    async (request) => {
      const { taskId } = request.params as { taskId: string };
      const grant = await access(request, 'timesheet', 'reopen', taskId);
      return withTransaction(db, (tx) => decideReopen(tx, grant, taskId, request.body as { decision: 'APPROVE' | 'REJECT'; reason?: string; idempotencyKey: string }));
    },
  );

  // ---- BR-049 missed submissions ---------------------------------------------------------------------------------
  app.get(
    '/timesheet-exceptions',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: ['OPEN', 'RESOLVED'] }, from: date, to: date, ...optionalPaging } } } },
    async (request) => listExceptions(db, await access(request, 'timesheet', 'read'), request.query as { state?: string; from?: string; to?: string } & Paging),
  );
  app.post(
    '/timesheet-exceptions/:id/resolve',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await access(request, 'timesheet', 'resolve_exception', id);
      return withTransaction(db, (tx) => resolveException(tx, grant, id, request.body as { reason: string }));
    },
  );

  // ---- FR-048 reports --------------------------------------------------------------------------------------------
  // Report rows page (FR-056); the totals of every report always cover the whole scope, whatever page is shown.
  const reportFilters = { employeeId: uuid, projectId: uuid, jobId: uuid, activityId: uuid, ...optionalPaging } as const;
  app.get(
    '/timesheet-reports/hours',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['from', 'to', 'groupBy'],
          properties: {
            from: date,
            to: date,
            groupBy: { type: 'string', pattern: '^(employee|project|job|activity|period)(,(employee|project|job|activity|period)){0,4}$' },
            ...reportFilters,
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { from: string; to: string; groupBy: string; employeeId?: string; projectId?: string; jobId?: string; activityId?: string } & Paging;
      const grant = await access(request, 'timesheet', 'report');
      return hoursReport(db, grant, { ...q, groupBy: q.groupBy.split(',') as Dimension[] });
    },
  );
  app.get(
    '/timesheet-reports/lines',
    { schema: { querystring: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: date, to: date, ...reportFilters } } } },
    async (request) => hoursLines(db, await access(request, 'timesheet', 'report'), request.query as { from: string; to: string } & Paging),
  );
  app.get(
    '/timesheet-reports/utilisation',
    { schema: { querystring: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: { from: date, to: date, employeeId: uuid, ...optionalPaging } } } },
    async (request) => utilisationReport(db, await access(request, 'timesheet', 'report'), request.query as { from: string; to: string; employeeId?: string } & Paging),
  );
}
