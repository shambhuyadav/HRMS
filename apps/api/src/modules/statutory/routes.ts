// HTTP routes of I-85 (decided under owner delegation, 6 Nov 2026; migration 0220): retiring an active statutory pack revision (the
// registry's other routes are in lifecycle/settlement-calculation-routes.ts), and the dated settings the evaluator reads: an employee's
// PF contribution basis and a work location's professional tax state (payroll configuration rights).
import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { expectedVersion, idParams } from '../lifecycle/process-routes.js';
import { retirePack } from './rule-packs.js';
import { listPfOptions, listPtStates, PF_BASES, recordPfOption, recordPtState } from './settings.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;

export async function statutoryRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  type Req = Parameters<typeof requireAccess>[1];
  const config = (request: Req, action: 'read' | 'manage', recordKey?: string) =>
    requireAccess(db, request, 'payroll_config', action, ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  app.post(
    '/statutory-rule-packs/:id/retire',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'reason'], properties: { expectedVersion, reason: { type: 'string', minLength: 1, maxLength: 500 } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'statutory_pack', 'activate', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => retirePack(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
    },
  );

  app.get(
    '/statutory/pf-options',
    { schema: { querystring: { type: 'object', additionalProperties: false, required: ['employeeId'], properties: { employeeId: uuid } } } },
    async (request) => {
      const { employeeId } = request.query as { employeeId: string };
      return listPfOptions(db, await config(request, 'manage', employeeId), employeeId);
    },
  );
  app.post(
    '/statutory/pf-options',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['employeeId', 'effectiveFrom', 'contributionBasis', 'reference'],
          properties: { employeeId: uuid, effectiveFrom: date, contributionBasis: { type: 'string', enum: [...PF_BASES] }, reference: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { employeeId: string; effectiveFrom: string; contributionBasis: string; reference: string };
      const grant = await config(request, 'manage', body.employeeId);
      const result = await withTransaction(db, (tx) => recordPfOption(tx, grant, body));
      reply.status(201);
      return result;
    },
  );

  app.get('/statutory/pt-states', async (request) => listPtStates(db, await config(request, 'read')));
  app.post(
    '/statutory/pt-states',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['locationCode', 'effectiveFrom', 'stateCode'],
          properties: { locationCode: { type: 'string', minLength: 1, maxLength: 40 }, effectiveFrom: date, stateCode: { type: 'string', pattern: '^[A-Za-z]{2}$' } },
        },
      },
    },
    async (request, reply) => {
      const grant = await config(request, 'manage');
      const result = await withTransaction(db, (tx) => recordPtState(tx, grant, request.body as { locationCode: string; effectiveFrom: string; stateCode: string }));
      reply.status(201);
      return result;
    },
  );
}
