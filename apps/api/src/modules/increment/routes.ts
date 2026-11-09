import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import { myOpenTasks } from '../workflow/engine.js';
import { incrementCycleRoutes } from './cycle-routes.js';
import { salaryMasterRoutes } from './salary-master.js';
import {
  annualGrowth,
  type CorrectionProposal,
  createInitialSalary,
  CURRENCY_PATTERN,
  decideIncrement,
  incrementHistory,
  type InitialSalary,
  listCases,
  MONEY_PATTERN,
  type Proposal,
  propose,
  proposeCorrection,
  proposeOffCycle,
  salaryHistory,
} from './service.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const money = { type: 'string', pattern: MONEY_PATTERN } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
// FR-092 / DB104: the optional component breakdown of an increase, line by line as the new arrangement will carry it.
// The item bound is a technical input limit, not a policy.
const components = {
  type: 'array',
  minItems: 1,
  maxItems: 100,
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['componentCode', 'amount', 'basis'],
    properties: { componentCode: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' }, amount: money, basis: { type: 'string', enum: ['MONTHLY', 'ANNUAL'] } },
  },
} as const;

export async function incrementRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db } = opts;

  app.post(
    '/employees/:id/salary',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveFrom', 'annualCtc', 'monthlyGross', 'currency'],
          properties: {
            effectiveFrom: date,
            annualCtc: money,
            monthlyGross: money,
            currency: { type: 'string', pattern: CURRENCY_PATTERN },
            ctcCategoryCode: { type: ['string', 'null'], minLength: 1, maxLength: 40 },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'salary', 'manage', ['salary'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => createInitialSalary(tx, grant, id, request.body as InitialSalary));
      reply.status(201);
      return result;
    },
  );

  // FR-029 salary master: the list with its filters and the salary master upload (salary-master.ts).
  await salaryMasterRoutes(app, opts);

  app.get('/employees/:id/salary', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'salary', 'read', ['salary'], { requireAll: true, recordKey: id });
    return salaryHistory(db, grant, id);
  });

  app.get('/employees/:id/increment-history', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    // C4, C6 increment_history_read: applied changes are the financial past, whatever the plain read grant shows of open cases.
    const grant = await requireAccess(db, request, 'increment', 'history_read', ['salary'], { requireAll: true, recordKey: id });
    return incrementHistory(db, grant, id);
  });

  app.get(
    '/employees/:id/annual-increment',
    {
      schema: {
        params: idParams,
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['financialYear'],
          properties: { financialYear: { type: 'integer', minimum: 2000, maximum: 2100 }, basis: { type: 'string', enum: ['MONTHLY_GROSS', 'ANNUAL_CTC'], default: 'MONTHLY_GROSS' } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const q = request.query as { financialYear: number; basis: 'MONTHLY_GROSS' | 'ANNUAL_CTC' };
      const grant = await requireAccess(db, request, 'increment', 'history_read', ['salary'], { requireAll: true, recordKey: id });
      return annualGrowth(db, grant, id, q.financialYear, q.basis);
    },
  );

  // DF15 / FR-091: cycle definitions and revisions, review openings, cycle assignment and review-date overrides.
  await incrementCycleRoutes(app, opts);

  app.get(
    '/increment-cases',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', pattern: '^[A-Z_]{1,20}$' } } } } },
    async (request) => {
      const grant = await requireAccess(db, request, 'increment', 'read', ['operational', 'salary']);
      return listCases(db, grant, request.query as { state?: string });
    },
  );

  app.post(
    '/increment-cases/:id/proposal',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion', 'outcome', 'reason'],
          properties: {
            expectedVersion: { type: 'integer', minimum: 1 },
            outcome: { type: 'string', enum: ['INCREASE', 'NO_CHANGE', 'DEFER'] },
            proposedAmount: money,
            proposedCounterpart: money,
            components,
            reason,
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'increment', 'propose', ['salary'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => propose(tx, grant, id, request.body as Proposal));
    },
  );

  // BR-038; DF14: a correction of an applied change, decided independently like an off-cycle change.
  app.post(
    '/increment-history/:id/corrections',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveDate', 'proposedAmount', 'proposedCounterpart', 'reason'],
          properties: { effectiveDate: date, proposedAmount: money, proposedCounterpart: money, components, reason: { ...reason, pattern: '\\S' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'increment', 'propose', ['salary'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => proposeCorrection(tx, grant, id, request.body as CorrectionProposal));
      reply.status(201);
      return result;
    },
  );

  app.post(
    '/increment-cases/off-cycle',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['employeeId', 'effectiveDate', 'proposedAmount', 'proposedCounterpart', 'reason'],
          properties: {
            employeeId: uuid,
            effectiveDate: date,
            proposedAmount: money,
            proposedCounterpart: money,
            basis: { type: 'string', enum: ['MONTHLY_GROSS', 'ANNUAL_CTC'], default: 'MONTHLY_GROSS' },
            components,
            reason,
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'increment', 'propose', ['salary'], { requireAll: true });
      const result = await withTransaction(db, (tx) => proposeOffCycle(tx, grant, request.body as Parameters<typeof proposeOffCycle>[2]));
      reply.status(201);
      return result;
    },
  );

  app.get('/increment-cases/tasks/mine', async (request) => {
    const grant = await requireAccess(db, request, 'increment', 'approve', ['salary']);
    return myOpenTasks(db, grant, 'increment_case');
  });

  app.post(
    '/increment-cases/tasks/:id/decision',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'reason', 'idempotencyKey'],
          properties: {
            decision: { type: 'string', enum: ['APPROVE', 'REJECT', 'RETURN'] },
            reason,
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'increment', 'approve', ['salary'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => decideIncrement(tx, grant, id, request.body as { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason: string; idempotencyKey: string }));
    },
  );
}
