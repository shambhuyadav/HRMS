// The employee notes register over HTTP (BRD coverage CL-040 "Exit Notes/Remarks/Warnings"; FR-018; BR-044; DF08; DF09; FR-106;
// migration 0260): the register list, voiding a note with a reason, a note's supporting file, and the bulk upload through the shared
// import lifecycle (stage, preview, commit or cancel; the submitter's own batches; the malware-scan hold; the published template).
// Every route needs the confidential restricted group of employee_note (an approved HR Administrator grant), resolves the selected
// assignment first and keeps to its row scope; one's own record is never shown or written. Writing one note stays at
// POST /employees/:id/notes (process-routes.ts).
//
// Bulk upload, template EMPLOYEE_NOTES_V1: employeeCode,noteType,noteDate,text, one note per row. The type is a code or the
// reference screen's label (APPRECIATION or "Appreciation", EXIT_NOTE or "Exit note", OFFER_REJECTION, PIP, REMARK or "Remarks",
// WARNING, NOTE), or "Absconding warning" for a warning of that category (CL-052, 0283); the date is YYYY-MM-DD, never after today. Each row is written exactly as a note entered on screen (addNote: row
// scope, never one's own record), marked as imported. The batch is all or nothing (DF09). A row repeating an earlier row of the file,
// or a note already on record (same employee, type, date and text, not voided), is refused, so uploading the same file again under
// a new idempotency key adds nothing; the same key returns the same batch, and a committed batch commits once. Import rows keep the
// employee code, type and date (the business key), never the text.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Database } from '../../db/transaction.js';
import { withTransaction } from '../../db/transaction.js';
import { notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { downloadHeaders, type FileStore } from '../../storage/files.js';
import type { ScanProvider } from '../../storage/scan.js';
import type { AccessGrant } from '../access/authorize.js';
import { canAccessEmployee } from '../access/authorize.js';
import { isCalendarDate, markRepeats, MAX_BATCH_BYTES, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';
import { addNote, listNoteRegister, MAX_NOTE_TEXT, NOTE_KINDS, NOTE_STATUSES, type NoteKind, noteAttachment, type RegisterQuery, voidNote, type WarningCategory } from './notes.js';

const COLUMNS = ['employeeCode', 'noteType', 'noteDate', 'text'] as const;
type Column = (typeof COLUMNS)[number];
export const NOTES_TEMPLATE: Template<Column> = { code: 'EMPLOYEE_NOTES_V1', columns: COLUMNS };

/** The reference screen's labels that differ from the code once spaces become underscores ("Remarks" is REMARK). */
const KIND_ALIASES: Readonly<Record<string, NoteKind>> = { REMARKS: 'REMARK', WARNINGS: 'WARNING', PERFORMANCE_IMPROVEMENT_PLAN: 'PIP' };

/** A type cell as a note kind: the code or the label, in any case; anything else is not a type. */
export function noteKindOf(cell: string): NoteKind | null {
  const normal = cell.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if ((NOTE_KINDS as readonly string[]).includes(normal)) return normal as NoteKind;
  return KIND_ALIASES[normal] ?? null;
}

/** CL-052 (0283): a type cell as a note type, where "Absconding warning" (ABSCONDING_WARNING) is a warning of that category. */
export function noteTypeOf(cell: string): { kind: NoteKind; warningCategory?: WarningCategory } | null {
  if (cell.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') === 'ABSCONDING_WARNING') return { kind: 'WARNING', warningCategory: 'ABSCONDING' };
  const kind = noteKindOf(cell);
  return kind ? { kind } : null;
}

const repeatKey = (row: Record<Column, string>) => `${row.employeeCode.toUpperCase()}\u0000${noteKindOf(row.noteType) ?? row.noteType}\u0000${row.noteDate}\u0000${row.text.trim()}`;

export const NOTES_IMPORT_SPEC: BatchSpec<Column> = {
  kind: 'employee_notes',
  template: NOTES_TEMPLATE,
  parse: (bytes) => markRepeats(parseTemplate(bytes, NOTES_TEMPLATE), repeatKey, 'DUPLICATE_IN_BATCH'),
  keyOf: (row, n) => (row.employeeCode ? `${row.employeeCode.toUpperCase()}/${noteKindOf(row.noteType) ?? row.noteType.toUpperCase()}/${row.noteDate}` : `ROW-${n}`),
  async apply(client, grant, row) {
    const type = noteTypeOf(row.noteType);
    if (!type) throw new RowError('UNKNOWN_NOTE_TYPE');
    const { kind } = type;
    if (!isCalendarDate(row.noteDate)) throw new RowError('INVALID_DATE');
    if (row.noteDate > grant.businessDate) throw new RowError('NOTE_DATE_IN_FUTURE');
    const text = row.text.trim();
    if (!text || text.length > MAX_NOTE_TEXT) throw new RowError('INVALID_TEXT');
    const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, row.employeeCode.toUpperCase()])).rows[0];
    if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
    if (!(await canAccessEmployee(client, grant, employee.id))) throw new RowError('OUT_OF_SCOPE');
    if (grant.linkedEmployeeId === employee.id) throw new RowError('OWN_RECORD');
    const same = await client.query(
      `select 1 from employee_note n
        where n.company_id = $1 and n.employee_id = $2 and n.note_kind = $3 and n.note_date = $4 and n.body = $5
          and not exists (select 1 from employee_note_void v where v.company_id = n.company_id and v.note_id = n.id)`,
      [grant.companyId, employee.id, kind, row.noteDate, text],
    );
    if ((same.rowCount ?? 0) > 0) throw new RowError('DUPLICATE_NOTE');
    await addNote(client, grant, employee.id, { kind, ...(type.warningCategory ? { warningCategory: type.warningCategory } : {}), body: text, noteDate: row.noteDate }, { source: 'IMPORT' });
  },
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' } as const;
export const NOTE_IMPORTS = '/employee-note-imports';

export async function noteRegisterRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;
  const restricted = (request: FastifyRequest, action: 'read' | 'write' | 'void' | 'import', recordKey?: string) =>
    requireAccess(db, request, 'employee_note', action, ['restricted'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

  // ---- The register (CL-040) ----
  app.get(
    '/employee-notes',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: date,
            to: date,
            kind: { type: 'string', enum: [...NOTE_KINDS] },
            status: { type: 'string', enum: [...NOTE_STATUSES] },
            search: { type: 'string', maxLength: 100 },
            page: { type: 'integer', minimum: 1, default: 1 },
            pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 },
          },
        },
      },
    },
    async (request) => listNoteRegister(db, await restricted(request, 'read'), request.query as RegisterQuery),
  );

  app.post(
    '/employee-notes/:id/void',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['reason'], properties: { reason: { type: 'string', minLength: 1, maxLength: 1000 } } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await restricted(request, 'void', id);
      return withTransaction(db, (tx) => voidNote(tx, grant, id, (request.body as { reason: string }).reason));
    },
  );

  app.get('/employee-notes/:id/attachment', { schema: { params: idParams } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await restricted(request, 'read', id);
    const file = await noteAttachment(db, grant, id);
    const headers = downloadHeaders({ mediaType: file.mediaType, fileName: file.fileName }, 'note-attachment');
    const bytes = await files.get(file.contentReference);
    // FR-057: reading confidential content is attributable, once the bytes are in hand.
    await writeAudit(db, {
      companyId: grant.companyId,
      resource: 'employee_note',
      recordKey: id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'READ_CONTENT',
      after: { restricted: { employeeId: file.employeeId } },
    });
    reply.headers(headers);
    return bytes;
  });

  // ---- Bulk upload (EMPLOYEE_NOTES_V1; DF09) ----
  // The upload and the commit need the import right and the write right each row is applied under (its row scope applies per row).
  const submitGrant = async (request: FastifyRequest, id?: string): Promise<AccessGrant> => {
    await restricted(request, 'import', id);
    return restricted(request, 'write', id);
  };

  app.post(
    NOTE_IMPORTS,
    {
      bodyLimit: Math.ceil(MAX_BATCH_BYTES * 1.4),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['fileName', 'contentBase64', 'idempotencyKey'],
          properties: {
            fileName: { type: 'string', minLength: 1, maxLength: 255, pattern: '^[^/\\\\<>:"|?*\\x00-\\x1f\\x7f]+$' },
            contentBase64: { type: 'string', minLength: 4 },
            idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await submitGrant(request);
      const { status, view } = await submitBatch(db, files, scanner, grant, NOTES_IMPORT_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get(`${NOTE_IMPORTS}/:id`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const view = await jobView(db, await restricted(request, 'import', id), NOTES_IMPORT_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  batchFollowUpRoutes(app, { db, files, scanner, path: NOTE_IMPORTS, spec: NOTES_IMPORT_SPEC, readGrant: (request) => restricted(request, 'import'), submitGrant });

  app.post(`${NOTE_IMPORTS}/:id/commit`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return commitBatch(db, files, await submitGrant(request, id), NOTES_IMPORT_SPEC, id);
  });

  app.post(`${NOTE_IMPORTS}/:id/cancel`, { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return cancelBatch(db, await restricted(request, 'import', id), NOTES_IMPORT_SPEC.kind, id);
  });
}
