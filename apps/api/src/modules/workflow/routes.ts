import type { FastifyInstance } from 'fastify';
import { type Database, withTransaction } from '../../db/transaction.js';
import { requireAccess } from '../../http/guard.js';
import { listCandidates, listRouting, rerouteOpenTask, setFallbackReviewers } from './admin.js';
import { strandedTasks } from './engine.js';

export async function workflowRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // DF03 routing administration: each kind's steps and the explicit HR fallback list it uses.
  app.get('/workflows', async (request) => {
    const grant = await requireAccess(db, request, 'workflow', 'manage', ['operational']);
    return listRouting(db, grant);
  });

  app.get(
    '/workflows/:kind/candidates',
    { schema: { params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,59}$' } } } } },
    async (request) => {
      const grant = await requireAccess(db, request, 'workflow', 'manage', ['operational']);
      return listCandidates(db, grant, (request.params as { kind: string }).kind);
    },
  );

  app.put(
    '/workflows/:kind/fallback-reviewers',
    {
      schema: {
        params: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,59}$' } } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reviewers'],
          properties: {
            reviewers: {
              type: 'array',
              maxItems: 50,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['userId', 'priority'],
                properties: { userId: { type: 'string', format: 'uuid' }, priority: { type: 'integer', minimum: 1, maximum: 1000 } },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { kind } = request.params as { kind: string };
      const grant = await requireAccess(db, request, 'workflow', 'manage', ['operational'], { requireAll: true });
      return withTransaction(db, (tx) => setFallbackReviewers(tx, grant, kind, (request.body as { reviewers: { userId: string; priority: number }[] }).reviewers));
    },
  );

  // C4 "Changed organisation or manager": open tasks their assignee can no longer decide, within the caller's row scope.
  app.get('/workflows/stranded-tasks', async (request) => {
    const grant = await requireAccess(db, request, 'workflow', 'manage', ['operational']);
    return strandedTasks(db, grant);
  });

  // C4 "owner-approved rerouting creates new task with history". Decided under owner delegation (docs/03 I-84 item 1; 0200):
  // workflow.reroute_task is a ceiling and default duty of the HR Administrator only, within row scope (a task with no employee
  // owner needs unrestricted company scope); the step's rule picks the new reviewer, never the caller, and nobody reroutes
  // their own request. Shown on the approval routing screen's "Stranded tasks" panel.
  app.post(
    '/workflows/tasks/:id/reroute',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
        body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'workflow', 'reroute_task', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => rerouteOpenTask(tx, grant, id, (request.body as { reason: string }).reason));
    },
  );
}
