// Bulk document mapping (FR-010 "support bulk document mapping"; acceptance: "unrecognised employee codes in a bulk
// document file are reported and not silently assigned"; DF09; I-13; FR-106; DF02). Migration 0054_company_documents.
//   1. The user stages employee documents (POST /documents/bulk-uploads): each is quarantined and scanned like every
//      upload and waits, unassigned, under its file name (one unmapped file per name and uploader).
//   2. A mapping file (template DOCUMENT_MAPPING_V1: fileName, employeeCode, documentType, expiresOn) assigns them on
//      the shared batch framework (../imports): the mapping file itself is scanned before any row is read, preview
//      runs every row through the real mapping in a rolled-back transaction, and the batch is all-or-nothing. A row
//      naming an unknown employee code is rejected as UNKNOWN_EMPLOYEE (its code reported as the row's key) and
//      rejects the batch, so nothing is assigned to a guessed employee. Only a released (CLEAN) staged file is mapped.
//   3. A mapped upload becomes an ordinary employee document (employee/documents.ts) and its staging row is final.
//   4. A staged file not mapped yet (one the scan quarantined, or one staged by mistake) can be discarded by its
//      uploader (migration 0056). DF08: a draft is cancelled and retained, never purged without an approved retention
//      schedule, so the row and its file stay on record as DISCARDED: final, never mapped, its file name free again.
//      A mapped file is an employee document and is never discarded.
// The caller's own mapping batches are listed (GET /documents/mapping-imports), so one held for the malware scan can
// be found again, resumed from its stored file (POST .../:id/resume), then committed or cancelled.
// Documents are confidential (DF02): staging and mapping need document.upload.document, and the batch needs the
// import duty; every row applies under the caller's grant and row scope. Nothing is deleted; audit records name
// the file and employee, never content.
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../../audit/audit.js';
import { optionalPaging, type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { decodeUpload, type FileStore, MAX_UPLOAD_BYTES, UPLOAD_FILE_NAME } from '../../storage/files.js';
import { type ScanProvider, scanAttachment } from '../../storage/scan.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';
import { isCalendarDate, MAX_BATCH_BYTES, markRepeats, parseTemplate, RowError, type Template } from '../imports/batch.js';
import { type BatchSpec, cancelBatch, commitBatch, jobView, submitBatch } from '../imports/jobs.js';
import { batchFollowUpRoutes } from '../imports/routes.js';

export const DOCUMENT_MAPPING_COLUMNS = ['fileName', 'employeeCode', 'documentType', 'expiresOn'] as const;
type Column = (typeof DOCUMENT_MAPPING_COLUMNS)[number];
export const DOCUMENT_MAPPING_TEMPLATE: Template<Column> = { code: 'DOCUMENT_MAPPING_V1', columns: DOCUMENT_MAPPING_COLUMNS };

async function applyRow(client: pg.PoolClient, grant: AccessGrant, r: Record<Column, string>): Promise<void> {
  if (r.fileName === '') throw new RowError('FILE_NAME_REQUIRED');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/.test(r.employeeCode)) throw new RowError('INVALID_EMPLOYEE_CODE');
  if (r.expiresOn !== '' && !isCalendarDate(r.expiresOn)) throw new RowError('INVALID_EXPIRES_ON');
  const staged = (
    await client.query<{ id: string; attachment_id: string; scan_state: string | null; byte_size: number }>(
      `select u.id, u.attachment_id, a.scan_state, a.byte_size from document_bulk_upload u join attachment a on a.company_id = u.company_id and a.id = u.attachment_id
        where u.company_id = $1 and u.uploaded_by = $2 and lower(u.file_name) = lower($3) and u.state = 'UNMAPPED' for update of u`,
      [grant.companyId, grant.userId, r.fileName],
    )
  ).rows[0];
  if (!staged) throw new RowError('UNKNOWN_FILE');
  if (staged.scan_state === 'QUARANTINED') throw new RowError('FILE_QUARANTINED');
  if (staged.scan_state !== 'CLEAN') throw new RowError('FILE_NOT_RELEASED');
  // FR-010 acceptance: an unrecognised code is reported, never matched loosely or assigned elsewhere.
  const employee = (await client.query<{ id: string }>(`select id from employee where company_id = $1 and employee_code = $2`, [grant.companyId, r.employeeCode.toUpperCase()])).rows[0];
  if (!employee) throw new RowError('UNKNOWN_EMPLOYEE');
  if (!(await canAccessEmployee(client, grant, employee.id))) throw new RowError('OUT_OF_SCOPE');
  const documentType = r.documentType.toUpperCase();
  const type = (
    await client.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = 'DOCUMENT_TYPE' and code = $2`, [grant.companyId, documentType])
  ).rows[0];
  if (!type) throw new RowError('UNKNOWN_DOCUMENT_TYPE');
  const assigned = await client.query(`update attachment set employee_id = $3, updated_at = now(), updated_by = $4 where company_id = $1 and id = $2 and employee_id is null`, [
    grant.companyId,
    staged.attachment_id,
    employee.id,
    grant.userId,
  ]);
  if (assigned.rowCount !== 1) throw new RowError('FILE_ALREADY_MAPPED');
  const documentId = (
    await client.query<{ id: string }>(
      `insert into employee_document (company_id, employee_id, document_type_id, attachment_id, expires_on, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $6) returning id`,
      [grant.companyId, employee.id, type.id, staged.attachment_id, r.expiresOn || null, grant.userId],
    )
  ).rows[0]!.id;
  await client.query(
    `update document_bulk_upload set state = 'MAPPED', mapped_document_id = $3, mapped_at = now(), updated_at = now(), updated_by = $4, version = version + 1
      where company_id = $1 and id = $2`,
    [grant.companyId, staged.id, documentId, grant.userId],
  );
  await writeAudit(client, {
    companyId: grant.companyId,
    resource: 'employee_document',
    recordKey: documentId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    after: { document: { employeeId: employee.id, documentType, fileName: r.fileName, byteSize: staged.byte_size, expiresOn: r.expiresOn || null, source: 'BULK_MAPPING', stagedUploadId: staged.id } },
  });
}

export const DOCUMENT_MAPPING_SPEC: BatchSpec<Column> = {
  kind: 'document_mapping',
  template: DOCUMENT_MAPPING_TEMPLATE,
  // One row per staged file: a repeated name would make the outcome depend on row order.
  parse: (bytes) => markRepeats(parseTemplate(bytes, DOCUMENT_MAPPING_TEMPLATE), (row) => row.fileName.toLowerCase(), 'DUPLICATE_IN_BATCH'),
  // The row's key is the employee code it names, so an unknown code is reported as written.
  keyOf: (row, n) => row.employeeCode.toUpperCase() || `ROW-${n}`,
  apply: (client, grant, row) => applyRow(client, grant, row),
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const STAGED_STATES = ['UNMAPPED', 'MAPPED', 'DISCARDED'] as const;
type StagedState = (typeof STAGED_STATES)[number];
/** The staged files GET /documents/bulk-uploads answered before it could page; an unpaged request still gets these. */
const STAGED_LIST_CAP = 1000;

const STAGED_VIEW = `select u.id, u.file_name as "fileName", a.media_type as "mediaType", a.byte_size as "byteSize", a.scan_state as "scanState", u.state,
       u.mapped_document_id as "mappedDocumentId", u.mapped_at as "mappedAt", u.discarded_at as "discardedAt", u.created_at as "uploadedAt"
  from document_bulk_upload u join attachment a on a.company_id = u.company_id and a.id = u.attachment_id`;

const upload = (db: Database, request: Parameters<typeof requireAccess>[1], recordKey?: string) =>
  requireAccess(db, request, 'document', 'upload', ['document'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });

async function mappingGrants(db: Database, request: Parameters<typeof requireAccess>[1], recordKey?: string) {
  await requireAccess(db, request, 'employee', 'import', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  return upload(db, request, recordKey);
}

export async function documentMappingRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  app.post(
    '/documents/bulk-uploads',
    {
      bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4),
      schema: { body: { type: 'object', additionalProperties: false, required: ['fileName', 'contentBase64'], properties: { fileName: UPLOAD_FILE_NAME, contentBase64: { type: 'string', minLength: 4 } } } },
    },
    async (request, reply) => {
      const body = request.body as { fileName: string; contentBase64: string };
      const grant = await upload(db, request);
      const fileName = body.fileName.trim();
      const { bytes, mediaType } = decodeUpload(body.contentBase64);
      const stored = await files.put(grant.companyId, bytes);
      const staged = await withTransaction(db, async (tx) => {
        const taken = await tx.query(`select 1 from document_bulk_upload where company_id = $1 and uploaded_by = $2 and lower(file_name) = lower($3) and state = 'UNMAPPED'`, [
          grant.companyId,
          grant.userId,
          fileName,
        ]);
        if ((taken.rowCount ?? 0) > 0) throw new HttpError(409, 'FILE_NAME_IN_USE', 'You already staged an unmapped file with this name; map or discard it, or rename this one');
        const attachmentId = (
          await tx.query<{ id: string }>(
            `insert into attachment (company_id, owner_user_id, content_reference, media_type, checksum, classification, file_name, byte_size, scan_state, created_by, updated_by)
             values ($1, $2, $3, $4, $5, 'CONFIDENTIAL', $6, $7, 'PENDING_SCAN', $2, $2) returning id`,
            [grant.companyId, grant.userId, stored.reference, mediaType, stored.checksum, fileName, stored.byteSize],
          )
        ).rows[0]!.id;
        const id = (
          await tx.query<{ id: string }>(
            `insert into document_bulk_upload (company_id, attachment_id, uploaded_by, file_name, state, created_by, updated_by) values ($1, $2, $3, $4, 'UNMAPPED', $3, $3) returning id`,
            [grant.companyId, attachmentId, grant.userId, fileName],
          )
        ).rows[0]!.id;
        await writeAudit(tx, {
          companyId: grant.companyId,
          resource: 'document_bulk_upload',
          recordKey: id,
          actorUserId: grant.userId,
          actingAssignmentId: grant.assignmentId,
          action: 'CREATE',
          after: { document: { fileName, byteSize: stored.byteSize } },
        });
        return { id, attachmentId };
      });
      // FR-106: quarantined until the scanner releases it; a scanner error leaves it pending (the scan worker retries).
      const scanState = await scanAttachment(db, scanner, { companyId: grant.companyId, id: staged.attachmentId, bytes });
      if (scanState !== 'PENDING_SCAN') {
        await writeAudit(db, {
          companyId: grant.companyId,
          resource: 'document_bulk_upload',
          recordKey: staged.id,
          actorUserId: grant.userId,
          actingAssignmentId: grant.assignmentId,
          action: scanState === 'CLEAN' ? 'SCAN_RELEASED' : 'SCAN_QUARANTINED',
          after: { document: { scanState } },
        });
      }
      reply.status(201);
      return { id: staged.id, fileName, mediaType, byteSize: stored.byteSize, scanState, state: 'UNMAPPED' };
    },
  );

  // The caller's own staged files (a staging pool belongs to its uploader, like an import job), newest first, paged with
  // a total (FR-056; I-43): without page or pageSize the latest STAGED_LIST_CAP, as before paging, with the total.
  app.get(
    '/documents/bulk-uploads',
    { schema: { querystring: { type: 'object', additionalProperties: false, properties: { state: { type: 'string', enum: [...STAGED_STATES] }, ...optionalPaging } } } },
    async (request) => {
      const { state, ...paging } = request.query as { state?: StagedState } & Paging;
      const grant = await upload(db, request);
      return pageOf(
        db,
        `${STAGED_VIEW} where u.company_id = $1 and u.uploaded_by = $2 and ($3::text is null or u.state = $3)`,
        [grant.companyId, grant.userId, state ?? null],
        '"uploadedAt" desc, id',
        paging,
        STAGED_LIST_CAP,
      );
    },
  );

  // The uploader discards a staged file that is not mapped yet (quarantined by the scan, or staged by mistake). It is
  // kept on record as DISCARDED (DF08: no deletion or purge), frees its file name and can never be mapped. A file
  // mapped to an employee record is never discarded. Discarding a discarded file again returns it unchanged.
  app.post('/documents/bulk-uploads/:id/discard', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await upload(db, request, id);
    return withTransaction(db, async (tx) => {
      // Locked like a mapping row locks it, so a discard and a commit naming the same file cannot both succeed.
      const staged = (
        await tx.query<{ state: StagedState; file_name: string; scan_state: string | null }>(
          `select u.state, u.file_name, a.scan_state from document_bulk_upload u join attachment a on a.company_id = u.company_id and a.id = u.attachment_id
            where u.company_id = $1 and u.id = $2 and u.uploaded_by = $3 for update of u`,
          [grant.companyId, id, grant.userId],
        )
      ).rows[0];
      if (!staged) throw notFound();
      if (staged.state === 'MAPPED') throw new HttpError(409, 'FILE_MAPPED', 'This file is mapped to an employee record and cannot be discarded');
      if (staged.state === 'UNMAPPED') {
        await tx.query(
          `update document_bulk_upload set state = 'DISCARDED', discarded_at = now(), updated_at = now(), updated_by = $3, version = version + 1 where company_id = $1 and id = $2`,
          [grant.companyId, id, grant.userId],
        );
        await writeAudit(tx, {
          companyId: grant.companyId,
          resource: 'document_bulk_upload',
          recordKey: id,
          actorUserId: grant.userId,
          actingAssignmentId: grant.assignmentId,
          action: 'DISCARD',
          before: { document: { state: 'UNMAPPED' } },
          after: { document: { state: 'DISCARDED', fileName: staged.file_name, scanState: staged.scan_state } },
        });
      }
      return stagedView(tx, grant.companyId, id);
    });
  });

  app.post(
    '/documents/mapping-imports',
    {
      bodyLimit: Math.ceil(MAX_BATCH_BYTES * 1.4),
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['fileName', 'contentBase64', 'idempotencyKey'],
          properties: { fileName: UPLOAD_FILE_NAME, contentBase64: { type: 'string', minLength: 4 }, idempotencyKey: { type: 'string', minLength: 8, maxLength: 200 } },
        },
      },
    },
    async (request, reply) => {
      const grant = await mappingGrants(db, request);
      const { status, view } = await submitBatch(db, files, scanner, grant, DOCUMENT_MAPPING_SPEC, request.body as { fileName: string; contentBase64: string; idempotencyKey: string });
      reply.status(status);
      return view;
    },
  );

  app.get('/documents/mapping-imports/:id', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await mappingGrants(db, request, id);
    const view = await jobView(db, grant, DOCUMENT_MAPPING_SPEC.kind, id);
    if (!view) throw notFound();
    return view;
  });

  // The caller's own mapping batches (GET, paged, job facts only) and resuming one held for the malware scan from its
  // stored file (POST /:id/resume), both under the same grants as one batch (imports/routes.ts).
  batchFollowUpRoutes(app, {
    db,
    files,
    scanner,
    path: '/documents/mapping-imports',
    spec: DOCUMENT_MAPPING_SPEC,
    readGrant: (request) => mappingGrants(db, request),
    submitGrant: (request, id) => mappingGrants(db, request, id),
  });

  app.post('/documents/mapping-imports/:id/commit', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await mappingGrants(db, request, id);
    return commitBatch(db, files, grant, DOCUMENT_MAPPING_SPEC, id);
  });

  app.post('/documents/mapping-imports/:id/cancel', { schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await mappingGrants(db, request, id);
    return cancelBatch(db, grant, DOCUMENT_MAPPING_SPEC.kind, id);
  });
}

/** One staged file as GET /documents/bulk-uploads lists it (caller has checked it is theirs). */
async function stagedView(db: Queryable, companyId: string, id: string) {
  return (await db.query(`${STAGED_VIEW} where u.company_id = $1 and u.id = $2`, [companyId, id])).rows[0];
}
