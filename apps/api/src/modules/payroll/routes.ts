// Payroll calculation, freeze and holds (FR-028 to FR-033, FR-037 as overridden by FR-099 and H2, FR-101; DF05; H2):
// HTTP routes. Every handler calls requireAccess first; configuration needs the operational configuration duties,
// everything that shows or changes amounts, inputs, stops or holds needs the matching confidential grant of an
// eligible Admin assignment (DF02). Row scope and independence are checked by the services. Calculation, processing
// and verification run in bounded chunks (CP-08): an unfinished call answers 202 with its progress and is continued
// by calling again.
import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { type ScanProvider, scanInMemory } from '../../storage/scan.js';
import { sendTemplate } from '../imports/routes.js';
import type { FileStore } from '../../storage/files.js';
import { externalDeductionRoutes } from './external-deductions.js';
import { payrollInputImportRoutes } from './input-import.js';
import { gradeStructureRoutes } from './grade-structures.js';
import {
  activateCalendar,
  activateHeadRevision,
  activatePaidDayPolicy,
  calendar,
  cancelHeadRevision,
  createCalendar,
  createComponent,
  createHeadRevision,
  createPaidDayPolicy,
  createPeriod,
  type HeadInput,
  headRevision,
  listCalendars,
  listComponents,
  listHeads,
  listPaidDayPolicies,
  period,
  type PeriodInput,
  salaryComponents,
  setSalaryComponents,
  updatePeriod,
} from './config.js';
import {
  activateCriterion,
  createCriterion,
  type CriterionInput,
  decideHold,
  holdDetail,
  type HoldInput,
  holdTasks,
  listCriteria,
  listHolds,
  proposeHold,
  recordHoldBalance,
  type ReleaseInput,
  releaseHold,
  renewHoldReview,
  retireCriterion,
  withdrawHold,
} from './holds.js';
import {
  batchDetail,
  cancelBatch,
  createEntryBatch,
  decideBatch,
  decideStop,
  type InputLine,
  inputTasks,
  listBatches,
  listStops,
  MAX_UPLOAD_BYTES,
  proposeStop,
  reverseInputs,
  revokeStop,
  type StopInput,
  stopDetail,
  stopTasks,
  submitBatch,
  UPLOAD_HEADER,
  UPLOAD_TEMPLATE,
  uploadBatch,
  withdrawStop,
} from './inputs.js';
import {
  approveRun,
  calculateRun,
  cancelRun,
  coverRecord,
  createRun,
  excludeMembers,
  listOpenPeriods,
  listRuns,
  previewRun,
  processRun,
  recordDetail,
  resolveException,
  returnApprovedRun,
  reviewRun,
  reviseRun,
  type RunDecisionInput,
  runComponents,
  runDetail,
  runRecords,
  runTasks,
  type ScopeInput,
  submitRun,
  verifyRun,
} from './runs.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
const money = { type: 'string', pattern: '^\\d{1,15}(\\.\\d{1,4})?$' } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const reference = { type: 'string', minLength: 1, maxLength: 500 } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
const code = { type: 'string', minLength: 1, maxLength: 40 } as const;
const ids = { type: 'array', maxItems: 1000, uniqueItems: true, items: uuid } as const;
const documents = { type: 'array', maxItems: 10, uniqueItems: true, items: uuid } as const;
const versionBody = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } as const;
const reasonVersionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['reason', 'expectedVersion'],
  properties: { reason, expectedVersion },
} as const;
const decisionBody = (decisions: readonly string[], extra: Record<string, unknown> = {}) =>
  ({
    type: 'object',
    additionalProperties: false,
    required: ['decision', 'idempotencyKey'],
    properties: { decision: { type: 'string', enum: [...decisions] }, reason, idempotencyKey, ...extra },
  }) as const;

export async function payrollRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, scanner } = opts;
  // FR-028/029 grade salary structures and CTC categories (I-80; grade-structures.ts).
  await gradeStructureRoutes(app, { db });
  // FR-028 external deduction mapping and the PAYROLL_INPUTS_V2 import on the stored framework (I-91).
  await externalDeductionRoutes(app, { db });
  await payrollInputImportRoutes(app, opts);
  type Req = Parameters<typeof requireAccess>[1];
  const config = (request: Req, action: 'read' | 'manage' | 'activate') => requireAccess(db, request, 'payroll_config', action, ['operational'], { requireAll: true });
  const run = (request: Req, action: 'prepare' | 'review' | 'approve' | 'process' | 'cancel', recordKey?: string) =>
    requireAccess(db, request, 'payroll_run', action, ['amount'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const runRead = (request: Req, recordKey?: string) => requireAccess(db, request, 'payroll_run', 'read', ['amount'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const input = (request: Req, action: 'read' | 'prepare' | 'approve', recordKey?: string) =>
    requireAccess(db, request, 'payroll_input', action, ['amount'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const stop = (request: Req, action: 'read' | 'propose' | 'decide', recordKey?: string) =>
    requireAccess(db, request, 'payroll_stop', action, ['hold'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const hold = (request: Req, action: 'read' | 'propose' | 'decide' | 'release' | 'define_criterion' | 'activate_criterion', recordKey?: string) =>
    requireAccess(db, request, 'payroll_hold', action, ['hold'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  /** 202 while a chunked operation still has work left (call again to continue). */
  const progressStatus = (done: boolean) => (done ? 200 : 202);

  // ---------------------------------------------------------------------------------------------------------------
  // FR-028 masters: pay components and payroll heads
  // ---------------------------------------------------------------------------------------------------------------
  app.get('/payroll/components', async (request) => listComponents(db, await config(request, 'read')));

  app.post(
    '/payroll/components',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'name', 'componentKind'],
          properties: { code, name: { type: 'string', minLength: 1, maxLength: 200 }, componentKind: { type: 'string', enum: ['EARNING', 'DEDUCTION'] } },
        },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => createComponent(tx, grant, request.body as Parameters<typeof createComponent>[2]));
      reply.status(201);
      return result;
    },
  );

  app.get(
    '/payroll/heads',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { componentCode: code, asOf: date } } } },
    async (request) => listHeads(db, await config(request, 'read'), request.query as { componentCode?: string; asOf?: string }),
  );

  app.post(
    '/payroll/heads',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['componentCode', 'effectiveFrom', 'inUse'],
          properties: {
            componentCode: code,
            effectiveFrom: date,
            inUse: { type: 'boolean' },
            headType: { type: 'string', enum: ['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION', 'REIMBURSEMENT'] },
            calculationBasis: { type: 'string', enum: ['FIXED', 'INPUT', 'RULE_PACK'] },
            roundingRule: { type: 'string', enum: ['HALF_UP_MINOR_UNIT'] },
            taxTreatment: { type: 'string', minLength: 1, maxLength: 60 },
            rulePackCode: code,
            displaySequence: { type: 'integer', minimum: 1, maximum: 9999 },
            baseComponentCodes: { type: 'array', maxItems: 50, uniqueItems: true, items: code },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const { roundingRule: _rounding, ...body } = request.body as HeadInput & { roundingRule?: string };
      const result = await withTransaction(db, (tx) => createHeadRevision(tx, grant, body));
      reply.status(201);
      return result;
    },
  );

  app.get('/payroll/head-revisions/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return headRevision(db, await config(request, 'read'), id);
  });

  app.post('/payroll/head-revisions/:id/activate', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await config(request, 'activate');
    return withTransaction(db, (tx) => activateHeadRevision(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post('/payroll/head-revisions/:id/cancel', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await config(request, 'manage');
    return withTransaction(db, (tx) => cancelHeadRevision(tx, grant, id, request.body as { expectedVersion: number }));
  });

  // ---------------------------------------------------------------------------------------------------------------
  // FR-030 payroll calendar and periods
  // ---------------------------------------------------------------------------------------------------------------
  app.get('/payroll/calendars', async (request) => listCalendars(db, await config(request, 'read')));

  app.post(
    '/payroll/calendars',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'name', 'currencyCode', 'currencyMinorUnit'],
          properties: {
            code,
            name: { type: 'string', minLength: 1, maxLength: 200 },
            currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' },
            currencyMinorUnit: { type: 'integer', minimum: 0, maximum: 4 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => createCalendar(tx, grant, request.body as Parameters<typeof createCalendar>[2]));
      reply.status(201);
      return result;
    },
  );

  app.get('/payroll/calendars/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return calendar(db, await config(request, 'read'), id);
  });

  app.post('/payroll/calendars/:id/activate', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await config(request, 'activate');
    return withTransaction(db, (tx) => activateCalendar(tx, grant, id, request.body as { expectedVersion: number }));
  });

  const periodProps = { financialYear: { type: 'string', minLength: 1, maxLength: 20 }, serviceStart: date, serviceEnd: date, inputCutoff: date, paymentDate: date } as const;
  app.post(
    '/payroll/calendars/:id/periods',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['periodCode', 'financialYear', 'serviceStart', 'serviceEnd', 'inputCutoff', 'paymentDate'],
          properties: { periodCode: { type: 'string', minLength: 1, maxLength: 20 }, ...periodProps },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => createPeriod(tx, grant, id, request.body as PeriodInput));
      reply.status(201);
      return result;
    },
  );

  app.get('/payroll/periods/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return period(db, await config(request, 'read'), id);
  });

  app.put(
    '/payroll/periods/:id',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['financialYear', 'serviceStart', 'serviceEnd', 'inputCutoff', 'paymentDate', 'expectedVersion'],
          properties: { ...periodProps, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await config(request, 'manage');
      return withTransaction(db, (tx) => updatePeriod(tx, grant, id, request.body as Omit<PeriodInput, 'periodCode'> & { expectedVersion: number }));
    },
  );

  // ---------------------------------------------------------------------------------------------------------------
  // FR-032 paid-day policy
  // ---------------------------------------------------------------------------------------------------------------
  app.get('/payroll/paid-day-policies', async (request) => listPaidDayPolicies(db, await config(request, 'read')));

  app.post(
    '/payroll/paid-day-policies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveFrom', 'attendanceBasis'],
          properties: {
            effectiveFrom: date,
            attendanceBasis: { type: 'string', enum: ['APPROVED_LEAVE_ONLY', 'REVIEWED_ATTENDANCE'] },
            absentUnpaidUnits: { type: 'string', pattern: '^\\d(\\.\\d{1,2})?$' },
            halfDayUnpaidUnits: { type: 'string', pattern: '^\\d(\\.\\d{1,2})?$' },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => createPaidDayPolicy(tx, grant, request.body as Parameters<typeof createPaidDayPolicy>[2]));
      reply.status(201);
      return result;
    },
  );

  app.post('/payroll/paid-day-policies/:id/activate', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await config(request, 'activate');
    return withTransaction(db, (tx) => activatePaidDayPolicy(tx, grant, id, request.body as { expectedVersion: number }));
  });

  // ---------------------------------------------------------------------------------------------------------------
  // FR-029 salary components of an arrangement (salary master grants)
  // ---------------------------------------------------------------------------------------------------------------
  app.get('/payroll/salary-arrangements/:id/components', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'salary', 'read', ['salary'], { requireAll: true, recordKey: id });
    return salaryComponents(db, grant, id);
  });

  app.post(
    '/payroll/salary-arrangements/:id/components',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['components'],
          properties: {
            components: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['componentCode', 'amount', 'basis'],
                properties: { componentCode: code, amount: money, basis: { type: 'string', enum: ['MONTHLY', 'ANNUAL'] } },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'salary', 'manage', ['salary'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => setSalaryComponents(tx, grant, id, request.body as Parameters<typeof setSalaryComponents>[3]));
      reply.status(201);
      return result;
    },
  );

  // ---------------------------------------------------------------------------------------------------------------
  // FR-030 / FR-033 / FR-099 runs
  // ---------------------------------------------------------------------------------------------------------------
  const scopeProps = { periodId: uuid, departmentIds: ids, gradeIds: ids, locationIds: ids } as const;
  // Classifies or writes every member of the scope in one statement or transaction (docs/09 §8.2).
  app.post(
    '/payroll/runs/preview',
    { config: { servingClass: 'batch' }, schema: { body: { type: 'object', additionalProperties: false, required: ['periodId'], properties: scopeProps } } },
    async (request) => previewRun(db, await run(request, 'prepare'), request.body as ScopeInput),
  );

  app.post(
    '/payroll/runs',
    {
      config: { servingClass: 'batch' },
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['periodId', 'scopeToken'],
          properties: { ...scopeProps, scopeToken: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
        },
      },
    },
    async (request, reply) => {
      const grant = await run(request, 'prepare');
      const result = await withTransaction(db, (tx) => createRun(tx, grant, request.body as ScopeInput & { scopeToken: string }));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  app.get(
    '/payroll/runs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            periodId: uuid,
            state: { type: 'string', maxLength: 30 },
            states: { type: 'string', pattern: '^[A-Z_]{1,30}(,[A-Z_]{1,30}){0,9}$' },
            coversDate: date,
            // BR-012: the financial year label each calendar gives its periods (case does not matter).
            financialYear: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_/-]{0,19}$' },
            ...optionalPaging,
          },
        },
      },
    },
    async (request) => {
      const grant = await requireAccess(db, request, 'payroll_run', 'read', ['operational', 'amount']);
      return listRuns(db, grant, request.query as { periodId?: string; state?: string; states?: string; coversDate?: string; financialYear?: string } & Paging);
    },
  );

  // F2 "Open payroll periods": the list behind the widget.
  app.get('/payroll/periods', { schema: { querystring: { type: 'object', additionalProperties: false, required: ['open'], properties: { open: { type: 'boolean', const: true }, ...optionalPaging } } } }, async (request) =>
    listOpenPeriods(db, await config(request, 'read'), request.query as Paging),
  );

  app.get('/payroll/runs/tasks/mine', async (request) => runTasks(db, await runRead(request)));

  app.get('/payroll/runs/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'payroll_run', 'read', ['operational', 'amount'], { recordKey: id });
    return runDetail(db, grant, id);
  });

  app.get('/payroll/runs/:id/components', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return runComponents(db, await runRead(request, id), id);
  });

  app.get(
    '/payroll/runs/:id/records',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { status: { type: 'string', maxLength: 30 }, exceptions: { type: 'boolean' }, after: { type: 'string', maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 1000 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      return runRecords(db, await runRead(request, id), id, request.query as { status?: string; exceptions?: boolean; after?: string; limit?: number });
    },
  );

  app.get(
    '/payroll/runs/:id/records/:employeeId',
    { schema: { params: { type: 'object', required: ['id', 'employeeId'], properties: { id: uuid, employeeId: uuid } } } },
    async (request) => {
      const { id, employeeId } = request.params as { id: string; employeeId: string };
      return recordDetail(db, await runRead(request, employeeId), id, employeeId);
    },
  );

  app.post(
    '/payroll/runs/:id/exclusions',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['employeeIds', 'reason', 'expectedVersion'], properties: { employeeIds: { ...ids, minItems: 1 }, reason, expectedVersion } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await run(request, 'prepare', id);
      return withTransaction(db, (tx) => excludeMembers(tx, grant, id, request.body as { employeeIds: string[]; reason: string; expectedVersion: number }));
    },
  );

  app.post('/payroll/runs/:id/calculate', { schema: { params: idParams, body: versionBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await run(request, 'prepare', id);
    const result = await calculateRun(db, grant, id, request.body as { expectedVersion: number });
    reply.status(progressStatus(result.progress.calculation.complete));
    return result;
  });

  app.post(
    '/payroll/runs/:id/verify',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { after: uuid } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await verifyRun(db, await runRead(request, id), id, request.query as { after?: string });
      reply.status(progressStatus(result.complete));
      return result;
    },
  );

  app.post(
    '/payroll/runs/:id/revise',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['reason', 'expectedVersion'], properties: { reason, excludeEmployeeIds: ids, expectedVersion } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await run(request, 'prepare', id);
      const result = await withTransaction(db, (tx) => reviseRun(tx, grant, id, request.body as { reason: string; excludeEmployeeIds?: string[]; expectedVersion: number }));
      reply.status(201);
      return result;
    },
  );

  // The processor's pre-processing validation return of an approved revision (H2: return before processing).
  app.post(
    '/payroll/runs/:id/return',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['reason', 'expectedVersion'], properties: { reason, excludeEmployeeIds: ids, expectedVersion } },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await run(request, 'process', id);
      const result = await withTransaction(db, (tx) => returnApprovedRun(tx, grant, id, request.body as { reason: string; excludeEmployeeIds?: string[]; expectedVersion: number }));
      reply.status(201);
      return result;
    },
  );

  app.post('/payroll/runs/:id/submit', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await run(request, 'prepare', id);
    return withTransaction(db, (tx) => submitRun(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post(
    '/payroll/runs/:id/exceptions/:exceptionId/resolve',
    {
      schema: {
        params: { type: 'object', required: ['id', 'exceptionId'], properties: { id: uuid, exceptionId: uuid } },
        body: { type: 'object', additionalProperties: false, required: ['resolution'], properties: { resolution: reason } },
      },
    },
    async (request) => {
      const { id, exceptionId } = request.params as { id: string; exceptionId: string };
      const grant = await run(request, 'approve', exceptionId);
      return withTransaction(db, (tx) => resolveException(tx, grant, id, exceptionId, request.body as { resolution: string }));
    },
  );

  app.post('/payroll/runs/:id/process', { schema: { params: idParams, body: versionBody } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await run(request, 'process', id);
    const result = await processRun(db, grant, id, request.body as { expectedVersion: number });
    reply.status(progressStatus(result.state === 'PROCESSED_LOCKED'));
    return result;
  });

  // Releases every member of the run in chunks after the cancellation commits (docs/09 §8.2).
  app.post('/payroll/runs/:id/cancel', { config: { servingClass: 'batch' }, schema: { params: idParams, body: reasonVersionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await run(request, 'cancel', id);
    return cancelRun(db, grant, id, request.body as { reason: string; expectedVersion: number });
  });

  const runDecision = decisionBody(['APPROVE', 'RETURN'], { excludeEmployeeIds: ids });
  app.post('/payroll/run-tasks/:id/review', { schema: { params: idParams, body: runDecision } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await run(request, 'review', id);
    return withTransaction(db, (tx) => reviewRun(tx, grant, id, request.body as RunDecisionInput));
  });

  app.post('/payroll/run-tasks/:id/approve', { schema: { params: idParams, body: runDecision } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await run(request, 'approve', id);
    return withTransaction(db, (tx) => approveRun(tx, grant, id, request.body as RunDecisionInput));
  });

  app.post('/payroll/run-tasks/:id/cover', { schema: { params: idParams, body: runDecision } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await run(request, 'approve', id);
    return withTransaction(db, (tx) => coverRecord(tx, grant, id, request.body as RunDecisionInput));
  });

  // ---------------------------------------------------------------------------------------------------------------
  // FR-031 inputs
  // ---------------------------------------------------------------------------------------------------------------
  app.post(
    '/payroll/periods/:id/input-batches',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['lines'],
          properties: {
            idempotencyKey,
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 1000,
              items: {
                type: 'object',
                additionalProperties: false,
                // I-91: componentCode or externalCode (an outside deduction code), exactly one (checkLines: COMPONENT_OR_EXTERNAL_CODE).
                required: ['employeeId', 'inputKind', 'amount', 'currencyCode', 'effectiveDate', 'reference'],
                properties: {
                  employeeId: uuid,
                  componentCode: code,
                  externalCode: { type: 'string', minLength: 1, maxLength: 40 },
                  inputKind: { type: 'string', minLength: 1, maxLength: 60 },
                  amount: money,
                  currencyCode: { type: 'string', pattern: '^[A-Z]{3}$' },
                  effectiveDate: date,
                  reference: { type: 'string', minLength: 1, maxLength: 100 },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await input(request, 'prepare', id);
      const result = await withTransaction(db, (tx) => createEntryBatch(tx, grant, id, request.body as { lines: InputLine[]; idempotencyKey?: string }));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  app.post(
    '/payroll/periods/:id/input-batches/upload',
    {
      bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4),
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['contentBase64'],
          properties: { contentBase64: { type: 'string', minLength: 1 }, dryRun: { type: 'boolean' }, idempotencyKey },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await input(request, 'prepare', id);
      const body = request.body as { contentBase64: string; dryRun?: boolean; idempotencyKey?: string };
      // FR-106: asked before the transaction opens, so a slow scanner holds no connection and no service-month lock.
      const verdict = await scanInMemory(scanner, Buffer.from(body.contentBase64, 'base64'));
      return withTransaction(db, (tx) => uploadBatch(tx, grant, verdict, id, body));
    },
  );

  // DF09 published versioned template PAYROLL_INPUTS_V1: the exact header the upload checks, no rows, under the upload's grant.
  app.get('/payroll/input-batches/template', async (request, reply) => {
    await input(request, 'prepare');
    return sendTemplate(reply, { code: UPLOAD_TEMPLATE, columns: UPLOAD_HEADER });
  });

  app.get(
    '/payroll/input-batches',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { periodId: uuid, state: { type: 'string', maxLength: 30 }, ...optionalPaging } } } },
    async (request) => listBatches(db, await input(request, 'read'), request.query as { periodId?: string; state?: string } & Paging),
  );

  app.get('/payroll/input-batches/tasks/mine', async (request) => inputTasks(db, await input(request, 'read')));

  app.get('/payroll/input-batches/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return batchDetail(db, await input(request, 'read', id), id);
  });

  app.post('/payroll/input-batches/:id/submit', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await input(request, 'prepare', id);
    return withTransaction(db, (tx) => submitBatch(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post('/payroll/input-batches/:id/cancel', { schema: { params: idParams, body: reasonVersionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await input(request, 'prepare', id);
    return withTransaction(db, (tx) => cancelBatch(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
  });

  // DF03 controlled reversal of approved lines (I-13 batch bound: a batch holds at most 10,000 lines).
  app.post(
    '/payroll/input-batches/:id/reverse',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['inputIds', 'reason', 'expectedVersion'],
          properties: { inputIds: { type: 'array', minItems: 1, maxItems: 10_000, uniqueItems: true, items: uuid }, reason, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await input(request, 'approve', id);
      return withTransaction(db, (tx) => reverseInputs(tx, grant, id, request.body as { inputIds: string[]; reason: string; expectedVersion: number }));
    },
  );

  app.post('/payroll/input-tasks/:id/decision', { schema: { params: idParams, body: decisionBody(['APPROVE', 'REJECT']) } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await input(request, 'approve', id);
    return withTransaction(db, (tx) => decideBatch(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT'; reason?: string; idempotencyKey: string }));
  });

  // ---------------------------------------------------------------------------------------------------------------
  // FR-031 salary stops
  // ---------------------------------------------------------------------------------------------------------------
  app.post(
    '/payroll/periods/:id/salary-stops',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['employeeId', 'reason', 'evidenceReference', 'evidenceDocumentIds'],
          properties: {
            employeeId: uuid,
            mode: { type: 'string', enum: ['HOLD_DISBURSEMENT', 'EXCLUDE_CALCULATION'] },
            criterionId: uuid,
            reason,
            releaseCriterion: reason,
            evidenceReference: reference,
            evidenceDocumentIds: documents,
            idempotencyKey,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await stop(request, 'propose', id);
      const result = await withTransaction(db, (tx) => proposeStop(tx, grant, id, request.body as StopInput));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  app.get(
    '/payroll/salary-stops',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { periodId: uuid, state: { type: 'string', maxLength: 30 }, ...optionalPaging } } } },
    async (request) => listStops(db, await stop(request, 'read'), request.query as { periodId?: string; state?: string } & Paging),
  );

  app.get('/payroll/salary-stops/tasks/mine', async (request) => stopTasks(db, await stop(request, 'read')));

  app.get('/payroll/salary-stops/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return stopDetail(db, await stop(request, 'read', id), id);
  });

  app.post(
    '/payroll/salary-stops/:id/withdraw',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await stop(request, 'propose', id);
      return withTransaction(db, (tx) => withdrawStop(tx, grant, id, request.body as { reason: string }));
    },
  );

  app.post('/payroll/salary-stops/:id/revoke', { schema: { params: idParams, body: reasonVersionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await stop(request, 'decide', id);
    return withTransaction(db, (tx) => revokeStop(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
  });

  app.post(
    '/payroll/stop-tasks/:id/decision',
    { schema: { params: idParams, body: decisionBody(['APPROVE', 'REJECT'], { confirmMode: { type: 'string', enum: ['HOLD_DISBURSEMENT', 'EXCLUDE_CALCULATION'] } }) } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await stop(request, 'decide', id);
      return withTransaction(db, (tx) =>
        decideStop(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT'; reason?: string; idempotencyKey: string; confirmMode?: string }),
      );
    },
  );

  // ---------------------------------------------------------------------------------------------------------------
  // FR-101 hold criteria and holds
  // ---------------------------------------------------------------------------------------------------------------
  app.get('/payroll/hold-criteria', async (request) => listCriteria(db, await hold(request, 'read')));

  app.post(
    '/payroll/hold-criteria',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'category', 'applicability', 'scopeMode', 'maxReviewDays', 'evidenceReference', 'validationReference'],
          properties: {
            code,
            category: { type: 'string', enum: ['CONTRACTUAL', 'LEGAL_DISCIPLINARY'] },
            applicability: { type: 'string', minLength: 1, maxLength: 2000 },
            scopeMode: { type: 'string', enum: ['FULL_ONLY', 'FULL_OR_PARTIAL'] },
            maxReviewDays: { type: 'integer', minimum: 1, maximum: 366 },
            evidenceReference: reference,
            validationReference: reference,
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await hold(request, 'define_criterion');
      const result = await withTransaction(db, (tx) => createCriterion(tx, grant, request.body as CriterionInput));
      reply.status(201);
      return result;
    },
  );

  app.post('/payroll/hold-criteria/:id/activate', { schema: { params: idParams, body: versionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await hold(request, 'activate_criterion', id);
    return withTransaction(db, (tx) => activateCriterion(tx, grant, id, request.body as { expectedVersion: number }));
  });

  app.post('/payroll/hold-criteria/:id/retire', { schema: { params: idParams, body: reasonVersionBody } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await hold(request, 'activate_criterion', id);
    return withTransaction(db, (tx) => retireCriterion(tx, grant, id, request.body as { reason: string; expectedVersion: number }));
  });

  app.post(
    '/payroll/records/:id/holds',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['criterionId', 'scope', 'reason', 'effectiveDate', 'reviewDueOn', 'releaseCriterion', 'evidenceReference', 'evidenceDocumentIds'],
          properties: {
            criterionId: uuid,
            scope: { type: 'string', enum: ['FULL', 'PARTIAL'] },
            amount: money,
            reason,
            effectiveDate: date,
            reviewDueOn: date,
            releaseCriterion: reason,
            evidenceReference: reference,
            evidenceDocumentIds: documents,
            idempotencyKey,
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await hold(request, 'propose', id);
      const result = await withTransaction(db, (tx) => proposeHold(tx, grant, id, request.body as HoldInput));
      reply.status(result.replayed ? 200 : 201);
      return result;
    },
  );

  app.get('/payroll/records/:id/hold-balance', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return recordHoldBalance(db, await hold(request, 'read', id), id);
  });

  app.get(
    '/payroll/holds',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', maxLength: 30 }, runId: uuid, employeeId: uuid, ...optionalPaging } } } },
    async (request) => listHolds(db, await hold(request, 'read'), request.query as { state?: string; runId?: string; employeeId?: string } & Paging),
  );

  app.get('/payroll/holds/tasks/mine', async (request) => holdTasks(db, await hold(request, 'read')));

  app.get('/payroll/holds/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return holdDetail(db, await hold(request, 'read', id), id);
  });

  app.post(
    '/payroll/holds/:id/withdraw',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await hold(request, 'propose', id);
      return withTransaction(db, (tx) => withdrawHold(tx, grant, id, request.body as { reason: string }));
    },
  );

  app.post(
    '/payroll/holds/:id/release',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason', 'evidenceReference', 'expectedVersion'],
          properties: { reason, evidenceReference: reference, evidenceDocumentIds: documents, expectedVersion },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await hold(request, 'release', id);
      return withTransaction(db, (tx) => releaseHold(tx, grant, id, request.body as ReleaseInput));
    },
  );

  app.post(
    '/payroll/holds/:id/renew-review',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['reviewDueOn', 'reason', 'expectedVersion'], properties: { reviewDueOn: date, reason, expectedVersion } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await hold(request, 'decide', id);
      return withTransaction(db, (tx) => renewHoldReview(tx, grant, id, request.body as { reviewDueOn: string; reason: string; expectedVersion: number }));
    },
  );

  app.post('/payroll/hold-tasks/:id/decision', { schema: { params: idParams, body: decisionBody(['APPROVE', 'REJECT']) } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await hold(request, 'decide', id);
    return withTransaction(db, (tx) => decideHold(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT'; reason?: string; idempotencyKey: string }));
  });
}
