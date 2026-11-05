// Employee documents (FR-010, FR-106; DB012; DF02; CI11; H1/BR-053). Documents are confidential by field group:
// upload and read each need their own grant, and every content read is audited. Expired documents stay on record.
// FR-106: every upload is quarantined until the scan worker's scanner releases it; only released (CLEAN) content is served, and a
// document becomes verified master evidence only through an independent reviewer's verification of a released file.
// The employee uploads and reads their own documents in the Employee OWN context (own-ESS groups).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { auditDenial, requireAccess } from '../../http/guard.js';
import { decodeUpload, downloadHeaders, type FileStore, MAX_UPLOAD_BYTES, UPLOAD_FILE_NAME } from '../../storage/files.js';
import { type ScanProvider, scanAttachment } from '../../storage/scan.js';
import { type AccessGrant, canAccessEmployee } from '../access/authorize.js';

const uuid = { type: 'string', format: 'uuid' } as const;

export async function documentRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore; scanner: ScanProvider }): Promise<void> {
  const { db, files, scanner } = opts;

  // Row scope over the document's employee (DF02). An existing employee outside it is a recorded denial (FR-098);
  // either way the caller sees not found, as for an unknown id.
  const requireEmployeeInScope = async (request: FastifyRequest, grant: AccessGrant, employeeId: string, action: 'read' | 'upload') => {
    if (await canAccessEmployee(db, grant, employeeId)) return;
    const existing = await db.query(`select 1 from employee where company_id = $1 and id = $2`, [grant.companyId, employeeId]);
    if (existing.rowCount) await auditDenial(db, request, { resource: 'employee_document', action, reason: 'OUT_OF_SCOPE', recordKey: employeeId });
    throw notFound();
  };

  app.post(
    '/employees/:id/documents',
    {
      bodyLimit: Math.ceil(MAX_UPLOAD_BYTES * 1.4),
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['documentType', 'fileName', 'contentBase64'],
          properties: {
            documentType: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,59}$' },
            fileName: UPLOAD_FILE_NAME,
            contentBase64: { type: 'string', minLength: 4 },
            expiresOn: { type: 'string', format: 'date' },
          },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { documentType: string; fileName: string; contentBase64: string; expiresOn?: string };
      const grant = await requireAccess(db, request, 'document', 'upload', ['document'], { requireAll: true, recordKey: id });
      await requireEmployeeInScope(request, grant, id, 'upload');
      const { bytes, mediaType } = decodeUpload(body.contentBase64);
      const stored = await files.put(grant.companyId, bytes);

      const documentId = await withTransaction(db, async (tx) => {
        const type = (
          await tx.query<{ id: string }>(`select id from reference_value_in_force where company_id = $1 and category = 'DOCUMENT_TYPE' and code = $2`, [grant.companyId, body.documentType])
        ).rows[0];
        if (!type) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown document type');
        const attachmentId = (
          await tx.query<{ id: string }>(
            `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size,
                                     scan_state, created_by, updated_by)
             values ($1, $2, $3, $4, $5, $6, 'CONFIDENTIAL', $7, $8, 'PENDING_SCAN', $2, $2) returning id`,
            [grant.companyId, grant.userId, id, stored.reference, mediaType, stored.checksum, body.fileName.trim(), stored.byteSize],
          )
        ).rows[0]!.id;
        const doc = (
          await tx.query<{ id: string }>(
            `insert into employee_document (company_id, employee_id, document_type_id, attachment_id, expires_on, created_by, updated_by)
             values ($1, $2, $3, $4, $5, $6, $6) returning id`,
            [grant.companyId, id, type.id, attachmentId, body.expiresOn ?? null, grant.userId],
          )
        ).rows[0]!.id;
        await writeAudit(tx, {
          companyId: grant.companyId,
          resource: 'employee_document',
          recordKey: doc,
          actorUserId: grant.userId,
          actingAssignmentId: grant.assignmentId,
          action: 'CREATE',
          after: { document: { employeeId: id, documentType: body.documentType, fileName: body.fileName, byteSize: stored.byteSize, expiresOn: body.expiresOn ?? null } },
        });
        return doc;
      });
      // FR-106: the upload stays quarantined until a scanner releases it. NFR-S09: nothing waits for that here: in every deployment this
      // answers PENDING_SCAN and the scan worker reaches the verdict and audits it (storage/scan.ts).
      const attachmentId = (await db.query<{ id: string }>(`select attachment_id as id from employee_document where company_id = $1 and id = $2`, [grant.companyId, documentId])).rows[0]!.id;
      const scanState = await scanAttachment(db, scanner, { companyId: grant.companyId, id: attachmentId, bytes });
      if (scanState !== 'PENDING_SCAN') {
        await writeAudit(db, {
          companyId: grant.companyId,
          resource: 'employee_document',
          recordKey: documentId,
          actorUserId: grant.userId,
          actingAssignmentId: grant.assignmentId,
          action: scanState === 'CLEAN' ? 'SCAN_RELEASED' : 'SCAN_QUARANTINED',
          after: { document: { scanState } },
        });
      }
      reply.status(201);
      return { id: documentId, mediaType, byteSize: stored.byteSize, scanState };
    },
  );

  app.get('/employees/:id/documents', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'document', 'read', ['document'], { requireAll: true, recordKey: id });
    await requireEmployeeInScope(request, grant, id, 'read');
    // A reviewer's verification note is HR-authored: not shown in the employee's own view (I-16).
    const withNote = !grant.ownEssFieldGroups.includes('document');
    const rows = await db.query(
      `select d.id, t.code as "documentType", a.file_name as "fileName", a.media_type as "mediaType", a.byte_size as "byteSize",
              d.expires_on as "expiresOn", coalesce(d.expires_on < hrms_business_date(d.company_id, now()), false) as expired, d.created_at as "uploadedAt",
              a.scan_state as "scanState", d.verification_state as "verificationState", d.verified_at as "verifiedAt"
              ${withNote ? ', d.verification_note as "verificationNote"' : ''}
         from employee_document d
         join reference_value t on t.company_id = d.company_id and t.id = d.document_type_id
         join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where d.company_id = $1 and d.employee_id = $2 order by d.created_at desc`,
      [grant.companyId, id],
    );
    return { items: rows.rows };
  });

  app.get('/documents/:id/content', { schema: { params: { type: 'object', required: ['id'], properties: { id: uuid } } } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const grant = await requireAccess(db, request, 'document', 'read', ['document'], { requireAll: true, recordKey: id });
    const doc = (
      await db.query<{ employee_id: string; content_reference: string; media_type: string; file_name: string | null; scan_state: string | null }>(
        `select d.employee_id, a.content_reference, a.media_type, a.file_name, a.scan_state from employee_document d
           join attachment a on a.company_id = d.company_id and a.id = d.attachment_id where d.company_id = $1 and d.id = $2`,
        [grant.companyId, id],
      )
    ).rows[0];
    if (!doc) throw notFound();
    if (!(await canAccessEmployee(db, grant, doc.employee_id))) {
      await auditDenial(db, request, { resource: 'employee_document', action: 'read', reason: 'OUT_OF_SCOPE', recordKey: id });
      throw notFound();
    }
    // FR-106: quarantined or not-yet-scanned content is never served, to anyone.
    if (doc.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'This file has not been released by the malware scan', { scanState: doc.scan_state });
    const headers = downloadHeaders({ mediaType: doc.media_type, fileName: doc.file_name }, 'document');
    const bytes = await files.get(doc.content_reference);
    // FR-057: reading confidential content is attributable. Recorded once the bytes are in hand, so a read that
    // fails leaves no record of content that was never returned.
    await writeAudit(db, {
      companyId: grant.companyId,
      resource: 'employee_document',
      recordKey: id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'READ_CONTENT',
      after: { document: { employeeId: doc.employee_id } },
    });
    reply.headers(headers);
    return bytes;
  });

  // FR-106: an independent reviewer verifies (or rejects) a released document as master evidence. The database
  // refuses a file that is not CLEAN, the uploader verifying their own upload, and changing a verdict.
  app.post(
    '/documents/:id/verification',
    {
      schema: {
        params: { type: 'object', required: ['id'], properties: { id: uuid } },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: { decision: { type: 'string', enum: ['VERIFIED', 'REJECTED'] }, note: { type: 'string', minLength: 1, maxLength: 1000 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { decision: 'VERIFIED' | 'REJECTED'; note?: string };
      const grant = await requireAccess(db, request, 'document', 'verify', ['document'], { requireAll: true, recordKey: id });
      if (body.decision === 'REJECTED' && !body.note?.trim()) throw new HttpError(422, 'NOTE_REQUIRED', 'Say why the document is rejected');
      return withTransaction(db, async (tx) => {
        const doc = (
          await tx.query<{ employee_id: string; verification_state: string; scan_state: string | null; owner_user_id: string }>(
            `select d.employee_id, d.verification_state, a.scan_state, a.owner_user_id from employee_document d
               join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
              where d.company_id = $1 and d.id = $2 for update of d`,
            [grant.companyId, id],
          )
        ).rows[0];
        if (!doc || !(await canAccessEmployee(tx, grant, doc.employee_id))) throw notFound();
        if (grant.linkedEmployeeId === doc.employee_id) throw new HttpError(403, 'SELF_ACTION', 'You cannot verify your own documents');
        if (doc.owner_user_id === grant.userId) throw new HttpError(403, 'INDEPENDENT_VERIFIER_REQUIRED', 'Someone other than the uploader must verify this document');
        if (doc.verification_state !== 'UNVERIFIED') throw new HttpError(409, 'ALREADY_VERIFIED', 'This document already has a verification decision');
        if (doc.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'Only a released file can be verified', { scanState: doc.scan_state });
        await tx.query(
          `update employee_document set verification_state = $3, verified_by = $4, verified_at = now(), verification_note = $5, updated_by = $4 where company_id = $1 and id = $2`,
          [grant.companyId, id, body.decision, grant.userId, body.note?.trim() || null],
        );
        await writeAudit(tx, {
          companyId: grant.companyId,
          resource: 'employee_document',
          recordKey: id,
          actorUserId: grant.userId,
          actingAssignmentId: grant.assignmentId,
          action: body.decision === 'VERIFIED' ? 'VERIFY' : 'REJECT',
          before: { document: { verificationState: 'UNVERIFIED' } },
          after: { document: { verificationState: body.decision } },
          reason: body.note?.trim() || null,
        });
        return { id, verificationState: body.decision };
      });
    },
  );
}
