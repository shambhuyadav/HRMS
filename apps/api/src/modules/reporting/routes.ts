// Reporting routes (I-83): dated reporting settings, the claim-state list, the dashboard's recent activity and the salary
// progression chart. Every route checks its own permission in the selected assignment; nothing here writes except a settings
// revision, which is audited.
import type { FastifyInstance } from 'fastify';
import { optionalPaging, type Paging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { recentActivity } from './activity.js';
import { CLAIM_STATE_QUERY_SCHEMA, type ClaimStateQuery, listClaimStates } from './claim-states.js';
import { MAX_SPAN_YEARS, type ProgressionBasis, salaryProgression } from './salary-progression.js';
import { listSettings, type NewRevision, startRevision } from './settings.js';

const uuid = { type: 'string', format: 'uuid' } as const;

export async function reportingRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.get('/reporting-settings', async (request) => listSettings(db, await requireAccess(db, request, 'reporting_setting', 'manage', ['operational'])));

  app.post(
    '/reporting-settings',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveFrom', 'smallCountThreshold', 'recentActivityDays', 'salaryProgressionYears', 'reason'],
          properties: {
            effectiveFrom: { type: 'string', format: 'date' },
            smallCountThreshold: { type: 'integer', minimum: 1, maximum: 100 },
            recentActivityDays: { type: 'integer', minimum: 1, maximum: 366 },
            salaryProgressionYears: { type: 'integer', minimum: 1, maximum: MAX_SPAN_YEARS },
            // I-92 (0245): business days from a claim's arrival at its financial step to its final decision's due date.
            expenseDecisionDueDays: { type: 'integer', minimum: 1, maximum: 30 },
            reason: { type: 'string', minLength: 1, maxLength: 1000, pattern: '\\S' },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'reporting_setting', 'manage', ['operational'], { requireAll: true });
      const created = await withTransaction(db, (tx) => startRevision(tx, grant, request.body as NewRevision));
      reply.status(201);
      return created;
    },
  );

  // I-62 item 4: the claims behind the Finance Reviewer's and Expense Finance Approver's figures (I-92: their payment follow-up and
  // decision-due figures too).
  app.get('/expense/claim-states', { schema: { querystring: CLAIM_STATE_QUERY_SCHEMA } }, async (request) =>
    listClaimStates(db, await requireAccess(db, request, 'expense_state', 'read', ['operational']), request.query as ClaimStateQuery),
  );

  // DF17 "recent operational activity" of the selected assignment.
  app.get('/dashboard/activity', { schema: { querystring: { type: 'object', additionalProperties: false, properties: optionalPaging } } }, async (request) =>
    recentActivity(db, await requireAccess(db, request, 'dashboard', 'read', ['operational']), request.query as Paging),
  );

  // FR-038 salary progression chart: salary read and the salary history grant, in one assignment, for an employee in its scope.
  app.get(
    '/employees/:id/salary-progression',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { basis: { type: 'string', enum: ['MONTHLY_GROSS', 'ANNUAL_CTC'], default: 'MONTHLY_GROSS' }, years: { type: 'integer', minimum: 1, maximum: MAX_SPAN_YEARS } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      await requireAccess(db, request, 'salary', 'read', ['salary'], { requireAll: true, recordKey: id });
      const grant = await requireAccess(db, request, 'salary', 'history_read', ['salary'], { requireAll: true, recordKey: id });
      const q = request.query as { basis: ProgressionBasis; years?: number };
      return salaryProgression(db, grant, id, q);
    },
  );
}
