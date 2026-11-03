// HTTP routes of letter templates and letter outputs (FR-017, FR-018, FR-055). Template text is operational; previews
// and outputs carry the rendered letter and are confidential (letter group, eligible HR grant with row scope).
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Paging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { downloadHeaders, type FileStore } from '../../storage/files.js';
import {
  createLetterTemplate,
  generateLetter,
  LETTER_PLACEHOLDERS,
  letterContent,
  type LetterDraftInput,
  letterTemplateDetail,
  listLetterOutputs,
  listLetterTemplates,
  previewLetter,
  publishLetterTemplate,
  saveLetterDraft,
  updateLetterTemplate,
} from './letters.js';
import { code, expectedVersion, idempotencyKey, idParams, pagingQuery } from './process-routes.js';

const body = { type: 'string', minLength: 1, maxLength: 20000 } as const;
const placeholderList = { type: 'array', maxItems: 50, uniqueItems: true, items: { type: 'string', pattern: '^[a-zA-Z][a-zA-Z0-9]*$' } } as const;
const name = { type: 'string', minLength: 1, maxLength: 200 } as const;
const templateCode = { type: 'object', additionalProperties: false, required: ['templateCode'], properties: { templateCode: code } } as const;
// The optional key makes a retried generation return the stored output instead of a second one.
const generation = { type: 'object', additionalProperties: false, required: ['templateCode'], properties: { templateCode: code, idempotencyKey } } as const;

export async function letterRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore }): Promise<void> {
  const { db, files } = opts;

  app.get('/letter-placeholders', async (request) => {
    await requireAccess(db, request, 'letter_template', 'read', ['operational']);
    return { items: Object.entries(LETTER_PLACEHOLDERS).map(([key, p]) => ({ key, source: p.source, label: p.label })) };
  });

  app.get('/letter-templates', async (request) => listLetterTemplates(db, await requireAccess(db, request, 'letter_template', 'read', ['operational'])));

  app.post(
    '/letter-templates',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'name', 'letterType', 'body'],
          properties: { code, name, letterType: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' }, body, optionalPlaceholders: placeholderList },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'letter_template', 'manage', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => createLetterTemplate(tx, grant, request.body as LetterDraftInput & { code: string; name: string; letterType: string }));
      reply.status(201);
      return result;
    },
  );

  app.get('/letter-templates/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return letterTemplateDetail(db, await requireAccess(db, request, 'letter_template', 'read', ['operational'], { recordKey: id }), id);
  });

  app.patch(
    '/letter-templates/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { name, active: { type: 'boolean' }, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'letter_template', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => updateLetterTemplate(tx, grant, id, request.body as { name?: string; active?: boolean; expectedVersion: number }));
    },
  );

  app.put(
    '/letter-templates/:id/draft',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['body'], properties: { body, optionalPlaceholders: placeholderList, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'letter_template', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => saveLetterDraft(tx, grant, id, request.body as LetterDraftInput & { expectedVersion?: number }));
    },
  );

  app.post(
    '/letter-templates/:id/publish',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['revision', 'expectedVersion'], properties: { revision: { type: 'integer', minimum: 1 }, expectedVersion } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'letter_template', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => publishLetterTemplate(tx, grant, id, request.body as { revision: number; expectedVersion: number }));
    },
  );

  // ---- Preview (never stored or sent) and final output ----
  app.post('/employee-processes/:id/letters/preview', { schema: { params: idParams, body: templateCode } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'letter', 'generate', ['letter'], { requireAll: true, recordKey: id });
    return previewLetter(db, grant, id, request.body as { templateCode: string });
  });

  app.post('/employee-processes/:id/letters', { schema: { params: idParams, body: generation } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'letter', 'generate', ['letter'], { requireAll: true, recordKey: id });
    const result = await withTransaction(db, (tx) => generateLetter(tx, grant, files, id, request.body as { templateCode: string; idempotencyKey?: string }));
    reply.status(201);
    return result;
  });

  app.get('/employees/:id/letter-outputs', { schema: { params: idParams, querystring: pagingQuery } }, async (request) => {
    const { id } = request.params as { id: string };
    return listLetterOutputs(db, await requireAccess(db, request, 'letter', 'read', ['letter'], { requireAll: true, recordKey: id }), id, request.query as Paging);
  });

  app.get('/letter-outputs/:id/content', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'letter', 'read', ['letter'], { requireAll: true, recordKey: id });
    const file = await letterContent(db, grant, id);
    const bytes = await files.get(file.reference);
    await writeAudit(db, {
      companyId: grant.companyId,
      resource: 'letter_output',
      recordKey: id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'READ_CONTENT',
      after: { letter: { employeeId: file.employeeId } },
    });
    reply.headers(downloadHeaders({ mediaType: file.mediaType, fileName: file.fileName }, 'letter.txt'));
    return bytes;
  });

  // FR-018: sending is a separate explicit action with recipient review and delivery status. It is not built:
  // DF12 enables in-app notifications only and DF09 disables e-mail attachments of confidential records.
  app.post('/letter-outputs/:id/send', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    await requireAccess(db, request, 'letter', 'read', ['letter'], { requireAll: true, recordKey: id });
    throw new HttpError(422, 'SENDING_NOT_AVAILABLE', 'Sending letters is not available; download the output for manual delivery');
  });
}
