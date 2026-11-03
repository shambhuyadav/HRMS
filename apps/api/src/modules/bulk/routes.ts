// Bulk-job status (NFR-S09; ADR-15): a job's state, progress, result and error class, for its requester only.
// The jobs themselves are enqueued by their own module's route (e.g. POST /v1/attendance/processing answers 202).
import type { FastifyInstance } from 'fastify';
import type { Database } from '../../db/transaction.js';
import { actorOf } from '../../http/context.js';
import { forbidden } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { BULK_JOB_KINDS, type BulkJobKind } from './kinds.js';
import { jobView, kindStillAuthorised, listOwnJobs, loadOwnJob } from './service.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

export async function bulkJobRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.get(
    '/bulk-jobs',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { kind: { type: 'string', enum: [...BULK_JOB_KINDS] }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 } },
        },
      },
    },
    async (request) => {
      const { kind, limit } = request.query as { kind?: BulkJobKind; limit: number };
      return listOwnJobs(db, actorOf(request), kind, limit);
    },
  );

  app.get('/bulk-jobs/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    // Only the requester, under the assignment the job was enqueued with, finds it (anyone else: 404) ...
    const job = await loadOwnJob(db, actorOf(request), id);
    // ... and only while that assignment still holds the permission the job was enqueued under.
    const grant = await requireAccess(db, request, job.permission_resource, job.permission_action, job.permission_field_groups, { requireAll: true, recordKey: id });
    if (!kindStillAuthorised(job.kind, grant)) throw forbidden();
    return jobView(job);
  });
}
