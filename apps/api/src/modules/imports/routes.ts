// Follow-up routes every batch import shares (DF09; FR-106, I-21), registered next to each import's own upload, read,
// commit and cancel routes:
//   GET  <path>             the caller's own batches of that import, newest first and paged, job facts only, so a batch
//                           held for the malware scan can be found again after leaving the page (GET <path>/:id has rows);
//   POST <path>/:id/resume  a batch held for the malware scan, resumed from its stored file without a second upload;
//   GET  <path>/template    the published versioned template (DF09): a CSV file holding exactly the header the upload
//                           checks and no data rows, named by the template code (which carries its version), under the
//                           upload's own grants. Uploads outside the framework (payroll inputs) serve theirs with
//                           sendTemplate.
// A batch belongs to its submitter (jobs.ts): nobody else's is listed, and another user's batch reads as missing.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from '../../db/transaction.js';
import type { FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';
import { type BatchSpec, IMPORT_JOB_STATES, type JobListQuery, listJobs, resumeBatch } from './jobs.js';

const idParams = { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } } as const;

/** GET <path>: an optional job state, then pages of 25, 50 or 100 batches. */
export const JOB_LIST_QUERYSTRING = {
  type: 'object',
  additionalProperties: false,
  properties: {
    state: { type: 'string', enum: [...IMPORT_JOB_STATES] },
    page: { type: 'integer', minimum: 1, default: 1 },
    pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 },
  },
} as const;

export interface BatchFollowUp<C extends string> {
  db: Database;
  files: FileStore;
  scanner: ScanProvider;
  /** The import's collection path, e.g. /employees/imports: POST uploads a batch, GET /:id reads one. */
  path: string;
  spec: BatchSpec<C>;
  /** The grant GET <path>/:id requires; it lists the caller's batches. */
  readGrant: (request: FastifyRequest) => Promise<AccessGrant>;
  /**
   * The grant the upload and the commit require: a resumed file is validated under it, so its row scope applies. The
   * template download requires it too (without a batch id).
   */
  submitGrant: (request: FastifyRequest, id?: string) => Promise<AccessGrant>;
}

/** A published template as a file: its exact header line and no data rows (DF09; batch.ts parseTemplate checks it). */
export function templateFile(template: { code: string; columns: readonly string[] }): { fileName: string; content: string } {
  return { fileName: `${template.code}.csv`, content: `${template.columns.join(',')}\r\n` };
}

/** Sends a published template as a CSV download. The caller has already checked the upload's grants. */
export function sendTemplate(reply: FastifyReply, template: { code: string; columns: readonly string[] }) {
  const file = templateFile(template);
  return reply
    .header('content-type', 'text/csv; charset=utf-8')
    .header('content-disposition', `attachment; filename="${file.fileName}"`)
    .header('cache-control', 'no-store')
    .send(file.content);
}

export function batchFollowUpRoutes<C extends string>(app: FastifyInstance, o: BatchFollowUp<C>): void {
  app.get(o.path, { schema: { querystring: JOB_LIST_QUERYSTRING } }, async (request) => listJobs(o.db, await o.readGrant(request), o.spec.kind, request.query as JobListQuery));

  // DF09 published versioned template, under the same grants as uploading this import.
  app.get(`${o.path}/template`, async (request, reply) => {
    await o.submitGrant(request);
    return sendTemplate(reply, o.spec.template);
  });

  // 202 while the file is still held, the preview once the scan released it, 422 FILE_QUARANTINED if flagged (the batch
  // is then closed unread). A batch in any other state is returned as it stands, so a repeat changes nothing.
  app.post(`${o.path}/:id/resume`, { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { status, view } = await resumeBatch(o.db, o.files, o.scanner, await o.submitGrant(request, id), o.spec, id);
    reply.status(status);
    return view;
  });
}
