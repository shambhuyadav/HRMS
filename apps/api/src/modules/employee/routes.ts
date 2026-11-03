import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { withTransaction } from '../../db/transaction.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import { notFound } from '../../http/errors.js';
import {
  activateEmployee,
  type AssignmentChange,
  changeAssignment,
  changeManager,
  changeShift,
  closeDraftEmployee,
  correctJoiningDate,
  employmentHistory,
  type JoiningDateCorrection,
  type ManagerChange,
  type ShiftChange,
} from './changes.js';
import {
  type CreateEmployeeInput,
  createEmployee,
  EMPLOYEE_SORTS,
  fieldGroupsForUpdate,
  getEmployee,
  type ListQuery,
  listEmployees,
  PERSONAL_FIELDS,
  SORT_DIRECTIONS,
  type UpdateEmployeeInput,
  updateEmployee,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const code = { type: 'string', minLength: 1, maxLength: 40, pattern: '^\\s*[A-Za-z0-9][A-Za-z0-9_-]*\\s*$' } as const;

const createSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['employeeCode', 'displayName', 'joiningDate', 'employmentType', 'departmentId', 'locationId', 'designationId'],
  properties: {
    employeeCode: code,
    displayName: { type: 'string', minLength: 1, maxLength: 200 },
    workEmail: { type: 'string', format: 'email', maxLength: 254 },
    joiningDate: date,
    employmentType: { type: 'string', enum: ['PERMANENT', 'FIXED_TERM', 'INTERN', 'CONTRACTOR'] },
    departmentId: uuid,
    locationId: uuid,
    designationId: uuid,
    gradeId: uuid,
    dateOfBirth: date,
    serviceAnniversaryDate: date,
    // DF04: a new employment links to the prior one.
    priorEmployeeId: uuid,
  },
} as const;

const joiningDateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'joiningDate', 'reason'],
  properties: { expectedVersion: { type: 'integer', minimum: 1 }, joiningDate: date, reason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

const closeDraftSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'reason'],
  properties: { expectedVersion: { type: 'integer', minimum: 1 }, reason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

const updateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  minProperties: 2,
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    displayName: { type: 'string', minLength: 1, maxLength: 200 },
    workEmail: { type: ['string', 'null'], format: 'email', maxLength: 254 },
    dateOfBirth: { type: ['string', 'null'], format: 'date' },
    serviceAnniversaryDate: { type: ['string', 'null'], format: 'date' },
  },
} as const;

const listSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    search: { type: 'string', maxLength: 100 },
    status: { type: 'string', pattern: '^[A-Z_]{1,60}$' },
    statusGroup: { type: 'string', enum: ['ACTIVE'] },
    departmentId: uuid,
    joinedFrom: date,
    joinedTo: date,
    sort: { type: 'string', enum: [...EMPLOYEE_SORTS] },
    direction: { type: 'string', enum: [...SORT_DIRECTIONS] },
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 },
  },
} as const;

const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

const managerChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['managerEmployeeId', 'effectiveFrom'],
  properties: {
    managerEmployeeId: { type: ['string', 'null'], format: 'uuid' },
    effectiveFrom: date,
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

const shiftChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['shiftId', 'effectiveFrom'],
  properties: { shiftId: uuid, effectiveFrom: date },
} as const;

const activateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  properties: { expectedVersion: { type: 'integer', minimum: 1 }, noManagerReason: { type: 'string', minLength: 1, maxLength: 500 } },
} as const;

const assignmentChangeSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['departmentId', 'locationId', 'designationId', 'effectiveFrom'],
  properties: {
    departmentId: uuid,
    locationId: uuid,
    designationId: uuid,
    gradeId: uuid,
    effectiveFrom: date,
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

export async function employeeRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  const readFor = async (request: FastifyRequest, id: string) => {
    const grant = await requireAccess(db, request, 'employee', 'read', ['operational', 'personal'], { recordKey: id });
    const view = await getEmployee(db, grant, id);
    if (!view) {
      await auditDenial(db, request, { resource: 'employee', action: 'read', reason: 'OUT_OF_SCOPE', recordKey: id });
      throw notFound(); // out of scope and nonexistent are indistinguishable
    }
    return view;
  };

  app.get('/employees', { schema: { querystring: listSchema } }, async (request) => {
    const grant = await requireAccess(db, request, 'employee', 'list', ['operational']);
    return listEmployees(db, grant, request.query as ListQuery);
  });

  app.get('/employees/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return readFor(request, id);
  });

  app.post('/employees', { schema: { body: createSchema } }, async (request, reply) => {
    const input = request.body as CreateEmployeeInput;
    const groups = PERSONAL_FIELDS.some((f) => input[f] !== undefined) ? ['operational', 'personal'] : ['operational'];
    const grant = await requireAccess(db, request, 'employee', 'create', groups, { requireAll: true });
    const id = await withTransaction(db, (tx) => createEmployee(tx, grant, input));
    reply.status(201);
    return readFor(request, id);
  });

  app.post('/employees/:id/manager', { schema: { params: idParams, body: managerChangeSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'update', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => changeManager(tx, grant, id, request.body as ManagerChange));
    return readFor(request, id);
  });

  app.post('/employees/:id/assignment', { schema: { params: idParams, body: assignmentChangeSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'update', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => changeAssignment(tx, grant, id, request.body as AssignmentChange));
    return readFor(request, id);
  });

  app.post('/employees/:id/shift', { schema: { params: idParams, body: shiftChangeSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'shift', 'assign', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => changeShift(tx, grant, id, request.body as ShiftChange));
    return readFor(request, id);
  });

  app.post('/employees/:id/activate', { schema: { params: idParams, body: activateSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'activate', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => activateEmployee(tx, grant, id, request.body as { expectedVersion: number; noManagerReason?: string }));
    return readFor(request, id);
  });

  // BR-002: a draft's joining date, corrected with its history; I-52: never on the actor's own record.
  app.post('/employees/:id/joining-date', { schema: { params: idParams, body: joiningDateSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'update', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => correctJoiningDate(tx, grant, id, request.body as JoiningDateCorrection));
    return readFor(request, id);
  });

  // DF08: a draft who never joined is closed and kept on record.
  app.post('/employees/:id/close-draft', { schema: { params: idParams, body: closeDraftSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'deactivate', ['operational'], { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => closeDraftEmployee(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
    return readFor(request, id);
  });

  app.get('/employees/:id/history', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee', 'read_history', ['operational'], { recordKey: id });
    const history = await employmentHistory(db, grant, id);
    if (!history) throw notFound();
    return history;
  });

  app.patch('/employees/:id', { schema: { params: idParams, body: updateSchema } }, async (request) => {
    const { id } = request.params as { id: string };
    const input = request.body as UpdateEmployeeInput;
    const grant = await requireAccess(db, request, 'employee', 'update', fieldGroupsForUpdate(input), { requireAll: true, recordKey: id });
    await withTransaction(db, (tx) => updateEmployee(tx, grant, id, input));
    return readFor(request, id);
  });
}
