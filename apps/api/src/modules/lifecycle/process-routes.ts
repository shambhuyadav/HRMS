// HTTP routes of process templates, employee processes, their tasks and restricted HR notes (FR-015, FR-016, FR-018).
// Every route resolves the caller's selected assignment first (requireAccess); row scope and ownership follow.
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import { optionalPaging, type Paging } from '../../db/paging.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { downloadHeaders, type FileStore, MAX_UPLOAD_BYTES, UPLOAD_FILE_NAME } from '../../storage/files.js';
import { type ScanProvider, scanAttachment } from '../../storage/scan.js';
import { createNote, listNotes, NOTE_KINDS, type NoteInput } from './notes.js';
import { LIFECYCLE_REFERENCE_CATEGORIES, listLifecycleReferenceValues, taskOwnerRoles } from './options.js';
import {
  cancelProcess,
  closeProcess,
  completeTask,
  type EvidenceInput,
  listEmployeeProcesses,
  listProcesses,
  myTasks,
  processDetail,
  reassignTask,
  recordEvidenceScan,
  reopenProcess,
  reopenTask,
  skipTask,
  startProcess,
  type StartInput,
  taskEvidence,
  taskView,
} from './processes.js';
import { createTemplate, listTemplates, publishTemplate, saveDraft, type TemplateTaskInput, templateDetail, updateTemplate } from './templates.js';

export const uuid = { type: 'string', format: 'uuid' } as const;
export const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
export const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
export const reason = { type: 'string', minLength: 1, maxLength: 1000 } as const;
export const expectedVersion = { type: 'integer', minimum: 1 } as const;
export const code = { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' } as const;
export const idempotencyKey = { type: 'string', minLength: 8, maxLength: 100, pattern: '^[A-Za-z0-9._:-]+$' } as const;
/** FR-056: page/pageSize ask for a page; without them a list keeps its capped first answer, `total` counting every match. */
export const pagingQuery = { type: 'object', additionalProperties: false, properties: { ...optionalPaging } } as const;
const name = { type: 'string', minLength: 1, maxLength: 200 } as const;
const roleCode = { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' } as const;

const templateTask = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'title', 'required', 'dueOffsetDays', 'evidenceRequired'],
  properties: {
    code,
    title: name,
    ownerRoleCode: roleCode,
    ownerUserId: uuid,
    required: { type: 'boolean' },
    dueOffsetDays: { type: 'integer', minimum: -3650, maximum: 3650 },
    evidenceRequired: { type: 'boolean' },
  },
} as const;
const templateTasks = { type: 'array', maxItems: 200, items: templateTask } as const;

export async function processRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  // ---- Form choices (DF04 controlled lists): each under the permission of the form that offers it ----
  app.get(
    '/lifecycle/reference-values',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          required: ['category'],
          properties: { category: { type: 'string', enum: Object.keys(LIFECYCLE_REFERENCE_CATEGORIES) } },
        },
      },
    },
    async (request) => {
      const { category } = request.query as { category: string };
      const form = LIFECYCLE_REFERENCE_CATEGORIES[category]!;
      return listLifecycleReferenceValues(db, await requireAccess(db, request, form.resource, form.action, ['operational'], { requireAll: true }), category);
    },
  );

  // Roles a template task or a reassignment may name as owner (exactly those the server accepts).
  app.get('/lifecycle-processes/owner-roles', async (request) =>
    taskOwnerRoles(db, await requireAccess(db, request, 'lifecycle_process', 'read', ['operational'], { requireAll: true })),
  );

  // ---- Process templates (HR-controlled, FR-015) ----
  app.get('/lifecycle-processes', async (request) => listTemplates(db, await requireAccess(db, request, 'lifecycle_process', 'read', ['operational'])));

  app.post(
    '/lifecycle-processes',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'name', 'processType'],
          properties: { code, name, processType: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' }, tasks: templateTasks },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'lifecycle_process', 'manage', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => createTemplate(tx, grant, request.body as { code: string; name: string; processType: string; tasks?: TemplateTaskInput[] }));
      reply.status(201);
      return result;
    },
  );

  app.get('/lifecycle-processes/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return templateDetail(db, await requireAccess(db, request, 'lifecycle_process', 'read', ['operational'], { recordKey: id }), id);
  });

  app.patch(
    '/lifecycle-processes/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { name, active: { type: 'boolean' }, expectedVersion } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'lifecycle_process', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => updateTemplate(tx, grant, id, request.body as { name?: string; active?: boolean; expectedVersion: number }));
    },
  );

  app.put(
    '/lifecycle-processes/:id/draft',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['tasks'], properties: { tasks: templateTasks, expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'lifecycle_process', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => saveDraft(tx, grant, id, request.body as { tasks: TemplateTaskInput[]; expectedVersion?: number }));
    },
  );

  app.post(
    '/lifecycle-processes/:id/publish',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['revision', 'expectedVersion'], properties: { revision: { type: 'integer', minimum: 1 }, expectedVersion } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'lifecycle_process', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => publishTemplate(tx, grant, id, request.body as { revision: number; expectedVersion: number }));
    },
  );

  // ---- Employee processes (FR-016) ----
  app.post(
    '/employees/:id/processes',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['processCode'],
          properties: { processCode: code, effectiveDate: date, exitCaseId: uuid, ownerUserId: uuid },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'employee_process', 'manage', ['operational'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => startProcess(tx, grant, id, request.body as StartInput));
      reply.status(201);
      return result;
    },
  );

  // FR-016 tracking across employees within row scope (e.g. every open process with an overdue task).
  app.get(
    '/employee-processes',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            state: { type: 'string', enum: ['OPEN', 'CLOSED', 'CANCELLED'] },
            processType: code,
            employeeCode: { type: 'string', minLength: 1, maxLength: 60 },
            overdue: { type: 'boolean' },
            ...optionalPaging,
          },
        },
      },
    },
    async (request) =>
      listProcesses(
        db,
        await requireAccess(db, request, 'employee_process', 'read', ['operational'], { requireAll: true }),
        request.query as { state?: string; processType?: string; employeeCode?: string; overdue?: boolean } & Paging,
      ),
  );

  app.get('/employees/:id/processes', { schema: { params: idParams, querystring: pagingQuery } }, async (request) => {
    const { id } = request.params as { id: string };
    return listEmployeeProcesses(db, await requireAccess(db, request, 'employee_process', 'read', ['operational'], { recordKey: id }), id, request.query as Paging);
  });

  // The employee's own processes and tasks (H1: operational fields only; remarks stay restricted).
  app.get('/me/processes', { schema: { querystring: pagingQuery } }, async (request) => {
    const grant = await requireAccess(db, request, 'employee_process', 'read', ['operational']);
    if (!grant.linkedEmployeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
    return listEmployeeProcesses(db, grant, grant.linkedEmployeeId, request.query as Paging);
  });

  app.get('/employee-processes/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee_process', 'read', ['operational', 'note'], { requireGroups: ['operational'], recordKey: id });
    return processDetail(db, grant, id);
  });

  app.post('/employee-processes/:id/close', { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee_process', 'manage', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => closeProcess(tx, grant, id, request.body as { expectedVersion: number }));
  });

  const versionAndReason = { type: 'object', additionalProperties: false, required: ['expectedVersion', 'reason'], properties: { expectedVersion, reason } } as const;

  app.post('/employee-processes/:id/reopen', { schema: { params: idParams, body: versionAndReason } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee_process', 'reopen', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => reopenProcess(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
  });

  app.post('/employee-processes/:id/cancel', { schema: { params: idParams, body: versionAndReason } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee_process', 'manage', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => cancelProcess(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
  });

  // ---- Tasks ----
  app.get('/employee-process-tasks/mine', { schema: { querystring: pagingQuery } }, async (request) =>
    myTasks(db, await requireAccess(db, request, 'employee_process', 'complete_task', ['operational']), request.query as Paging),
  );

  app.post(
    '/employee-process-tasks/:id/complete',
    {
      bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4),
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion'],
          properties: {
            expectedVersion,
            remark: { type: 'string', minLength: 1, maxLength: 2000 },
            evidence: {
              type: 'object',
              additionalProperties: false,
              required: ['fileName', 'contentBase64'],
              properties: { fileName: UPLOAD_FILE_NAME, contentBase64: { type: 'string', minLength: 4 } },
            },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'employee_process', 'complete_task', ['operational'], { requireAll: true, recordKey: id });
      const { evidence } = await withTransaction(db, (tx) => completeTask(tx, grant, files, id, request.body as { expectedVersion: number; remark?: string; evidence?: EvidenceInput }));
      if (evidence) {
        // FR-106: the stored file stays PENDING_SCAN for the scan worker; in every deployment nothing is scanned in this request (NFR-S09; storage/scan.ts).
        const scanState = await scanAttachment(db, scanner, { companyId: grant.companyId, id: evidence.attachmentId, bytes: evidence.bytes });
        if (scanState !== 'PENDING_SCAN') await recordEvidenceScan(db, grant, id, scanState);
      }
      return taskView(db, grant, id);
    },
  );

  app.post('/employee-process-tasks/:id/skip', { schema: { params: idParams, body: versionAndReason } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee_process', 'complete_task', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => skipTask(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
  });

  app.post('/employee-process-tasks/:id/reopen', { schema: { params: idParams, body: versionAndReason } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee_process', 'reopen', ['operational'], { requireAll: true, recordKey: id });
    return withTransaction(db, (tx) => reopenTask(tx, grant, id, request.body as { expectedVersion: number; reason: string }));
  });

  app.post(
    '/employee-process-tasks/:id/reassign',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion, ownerRoleCode: roleCode, ownerUserId: uuid, reason } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'employee_process', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => reassignTask(tx, grant, id, request.body as { expectedVersion: number; ownerRoleCode?: string; ownerUserId?: string; reason?: string }));
    },
  );

  app.get('/employee-process-tasks/:id/evidence', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'employee_process', 'read_evidence', ['evidence'], { requireAll: true, recordKey: id });
    const file = await taskEvidence(db, grant, id);
    const bytes = await files.get(file.reference);
    // FR-057: reading confidential content is attributable, once the bytes are in hand.
    await writeAudit(db, {
      companyId: grant.companyId,
      resource: 'employee_process_task',
      recordKey: id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'READ_CONTENT',
      after: { evidence: { employeeId: file.employeeId } },
    });
    reply.headers(downloadHeaders({ mediaType: file.mediaType, fileName: file.fileName }, 'evidence'));
    return bytes;
  });

  // ---- Restricted HR notes and warnings (FR-018; the register's types, date and supporting file, CL-040, 0260) ----
  app.post(
    '/employees/:id/notes',
    {
      bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4),
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'body'],
          properties: {
            kind: { type: 'string', enum: [...NOTE_KINDS] },
            body: { type: 'string', minLength: 1, maxLength: 4000 },
            noteDate: date,
            exitCaseId: uuid,
            employeeProcessId: uuid,
            supersedesNoteId: uuid,
            attachment: {
              type: 'object',
              additionalProperties: false,
              required: ['fileName', 'contentBase64'],
              properties: { fileName: UPLOAD_FILE_NAME, contentBase64: { type: 'string', minLength: 4 } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'employee_note', 'write', ['restricted'], { requireAll: true, recordKey: id });
      const result = await createNote(db, files, scanner, grant, id, request.body as NoteInput & { attachment?: { fileName: string; contentBase64: string } });
      reply.status(201);
      return result;
    },
  );

  app.get('/employees/:id/notes', { schema: { params: idParams, querystring: pagingQuery } }, async (request) => {
    const { id } = request.params as { id: string };
    return listNotes(db, await requireAccess(db, request, 'employee_note', 'read', ['restricted'], { requireAll: true, recordKey: id }), id, request.query as Paging);
  });
}
