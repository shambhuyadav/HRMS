// Supporting evidence of requests (FR-027, FR-104/105, FR-106; DF02; CI08). Evidence is the requester's own document;
// a quarantined or rejected file is never evidence. A released (CLEAN) evidence file is readable by its owner and by
// the reviewers assigned to that transaction (FR-106: "owner and assigned eligible reviewers only can access a
// released file"), within row scope; every read is audited. A general document grant is not needed for that.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { downloadHeaders, type FileStore } from '../../storage/files.js';
import { type AccessGrant, canAccessEmployee, taskDelegationLive } from '../access/authorize.js';

/** At most this many documents per request revision (a technical bound on one request, not a business rule). */
export const MAX_EVIDENCE_DOCUMENTS = 10;

/** Refuses anything but the employee's own usable documents (not quarantined by the scan, not rejected). */
export async function assertUsableEvidence(tx: Queryable, companyId: string, employeeId: string, documentIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(documentIds)];
  if (ids.length > MAX_EVIDENCE_DOCUMENTS) throw new HttpError(422, 'TOO_MUCH_EVIDENCE', `Attach at most ${MAX_EVIDENCE_DOCUMENTS} documents`);
  if (ids.length === 0) return ids;
  const rows = (
    await tx.query<{ id: string; scan_state: string | null; verification_state: string }>(
      `select d.id, a.scan_state, d.verification_state from employee_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where d.company_id = $1 and d.employee_id = $2 and d.id = any($3::uuid[])`,
      [companyId, employeeId, ids],
    )
  ).rows;
  if (rows.length !== ids.length) throw new HttpError(422, 'INVALID_EVIDENCE', 'Evidence must be your own uploaded documents');
  if (rows.some((r) => r.scan_state === 'QUARANTINED' || r.verification_state === 'REJECTED')) {
    throw new HttpError(422, 'EVIDENCE_UNUSABLE', 'A supporting document failed the malware scan or was rejected; use another');
  }
  return ids;
}

/** Links evidence to the transaction's current revision (CI08 and the revision are re-checked by the database). */
export async function linkEvidence(tx: Queryable, grant: AccessGrant, transactionId: string, revision: number, employeeId: string, documentIds: readonly string[]) {
  for (const documentId of documentIds) {
    await tx.query(
      `insert into transaction_evidence (company_id, transaction_id, transaction_revision, employee_id, document_id, created_by) values ($1, $2, $3, $4, $5, $6)`,
      [grant.companyId, transactionId, revision, employeeId, documentId, grant.userId],
    );
  }
}

/** SQL for the evidence of one transaction revision, as metadata (never content). Column arguments are SQL. */
export const EVIDENCE_JSON = (companyColumn: string, transactionColumn: string, revisionColumn: string) => `
  coalesce((select json_agg(json_build_object('documentId', te.document_id, 'documentType', dt.code, 'scanState', a.scan_state,
                                              'verificationState', d.verification_state) order by te.created_at)
              from transaction_evidence te
              join employee_document d on d.company_id = te.company_id and d.id = te.document_id
              join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
              join reference_value dt on dt.company_id = d.company_id and dt.id = d.document_type_id
             where te.company_id = ${companyColumn} and te.transaction_id = ${transactionColumn} and te.transaction_revision = ${revisionColumn}), '[]'::json)`;

/** The document ids linked to one revision (carried forward on resubmission when none are given). */
export async function revisionEvidence(tx: Queryable, companyId: string, transactionId: string, revision: number): Promise<string[]> {
  return (
    await tx.query<{ document_id: string }>(
      `select document_id from transaction_evidence where company_id = $1 and transaction_id = $2 and transaction_revision = $3 order by created_at`,
      [companyId, transactionId, revision],
    )
  ).rows.map((r) => r.document_id);
}

/**
 * Content of one evidence document of a transaction. `linked` says whether the document is evidence of it (each
 * module keeps its own link table). Allowed for the transaction's owner, or for a user who holds or held a task on
 * one of its approval instances; row scope applies either way.
 */
export async function evidenceContent(
  db: Queryable,
  files: FileStore,
  grant: AccessGrant,
  input: { transactionId: string; documentId: string; linked: (db: Queryable) => Promise<boolean> },
): Promise<{ headers: Record<string, string>; bytes: Buffer }> {
  const bt = (await db.query<{ owner: string | null }>(`select owner_employee_id as owner from business_transaction where company_id = $1 and id = $2`, [grant.companyId, input.transactionId])).rows[0];
  if (!bt?.owner || !(await input.linked(db)) || !(await canAccessEmployee(db, grant, bt.owner))) throw notFound();
  const isOwner = grant.linkedEmployeeId === bt.owner;
  const reviewer = (
    await db.query(
      `select 1 from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and i.transaction_id = $2 and t.assignee_user_id = $3 and ${taskDelegationLive('t')} limit 1`,
      [grant.companyId, input.transactionId, grant.userId],
    )
  ).rowCount;
  if (!isOwner && !reviewer) throw notFound();
  const doc = (
    await db.query<{ content_reference: string; media_type: string; file_name: string | null; scan_state: string | null }>(
      `select a.content_reference, a.media_type, a.file_name, a.scan_state from employee_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where d.company_id = $1 and d.id = $2 and d.employee_id = $3`,
      [grant.companyId, input.documentId, bt.owner],
    )
  ).rows[0];
  if (!doc) throw notFound();
  if (doc.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'This file has not been released by the malware scan', { scanState: doc.scan_state });
  const bytes = await files.get(doc.content_reference);
  await writeAudit(db, {
    companyId: grant.companyId,
    resource: 'employee_document',
    recordKey: input.documentId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'READ_CONTENT',
    after: { document: { employeeId: bt.owner, asEvidenceOf: input.transactionId, as: isOwner ? 'OWNER' : 'ASSIGNED_REVIEWER' } },
  });
  return { headers: downloadHeaders({ mediaType: doc.media_type, fileName: doc.file_name }, 'evidence'), bytes };
}
