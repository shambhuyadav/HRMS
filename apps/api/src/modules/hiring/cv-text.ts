// Approved searchable CV content (FR-013 "Search CV metadata and approved searchable content"). Decided under owner
// delegation, 6 Nov 2026 (docs/03 I-82 item 4, answering I-40 item 7); migration 0192.
//
// What counts: the text of one CV document (type CV) of a candidate whose consent is GIVEN, whose file the malware scan released
// (FR-106), that an eligible Admin holding the confidential document grant (candidate.upload.document) has explicitly approved
// for search. Nothing is searchable on upload. The text is TRANSCRIBED (typed or pasted by that Admin from the released file) or
// EXTRACTED by a text-extraction component for the file's type. No component is configured: uploads are PDF, JPEG or PNG
// (storage/files.ts), there is no safe in-repo PDF or image text extractor, and no external service or new dependency is added.
// registerCvTextExtractor is the plug point for an approved in-process component.
//
// Search (candidate.read.document) matches approved text only, skips a candidate whose consent is no longer GIVEN or whose
// retention date has passed, and answers document and candidate metadata with a match flag, never the text. The approved text
// itself is read under the same document grant that reads the CV. Approving a new text revokes the previous one; a revocation
// keeps the row with its reason. Audit records identifiers, source and length, never the content.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { FileStore } from '../../storage/files.js';
import type { AccessGrant } from '../access/authorize.js';
import { advisoryLock } from '../lifecycle/common.js';
import { audit, personSql, requireText } from './common.js';
import { canAccessCandidate } from './scope.js';

/** The longest approved text (characters), as the database checks. */
export const MAX_CV_TEXT = 100_000;

/** A text-extraction component for one file type: the file's bytes in, its plain text out. */
export type CvTextExtractor = (bytes: Buffer) => Promise<string>;

const EXTRACTORS = new Map<string, CvTextExtractor>();

/**
 * Plugs in an approved, in-process text-extraction component for one media type (e.g. application/pdf). None is registered by
 * the application. Returns the function that removes it again.
 */
export function registerCvTextExtractor(mediaType: string, extractor: CvTextExtractor): () => void {
  EXTRACTORS.set(mediaType, extractor);
  return () => {
    if (EXTRACTORS.get(mediaType) === extractor) EXTRACTORS.delete(mediaType);
  };
}

/** Plain text: line breaks normalised, control characters other than tab and line feed dropped, outer blanks trimmed. */
export function normaliseCvText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

interface DocumentFacts {
  candidate_id: string;
  document_type: string;
  media_type: string;
  scan_state: string | null;
  checksum: string;
  content_reference: string;
  consent_status: string;
  /** As the search reads it: consent GIVEN and the retention date, if any, not yet passed. */
  candidate_searchable: boolean;
}

async function documentFacts(db: Queryable, grant: AccessGrant, documentId: string): Promise<DocumentFacts> {
  const doc = (
    await db.query<DocumentFacts>(
      `select d.candidate_id, t.code as document_type, a.media_type, a.scan_state, a.checksum, a.content_reference, c.consent_status,
              (c.consent_status = 'GIVEN' and (c.retain_until is null or c.retain_until >= $3::date)) as candidate_searchable
         from candidate_document d
         join candidate c on c.company_id = d.company_id and c.id = d.candidate_id
         join reference_value t on t.company_id = d.company_id and t.id = d.document_type_id
         join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where d.company_id = $1 and d.id = $2`,
      [grant.companyId, documentId, grant.businessDate],
    )
  ).rows[0];
  if (!doc || !(await canAccessCandidate(db, grant, doc.candidate_id))) throw notFound();
  return doc;
}

export async function approveCvText(tx: Queryable, grant: AccessGrant, files: FileStore, documentId: string, input: { content?: string | undefined }) {
  const doc = await documentFacts(tx, grant, documentId);
  // One approval at a time per document (the unique index keeps one approved text).
  await advisoryLock(tx, `hiring:cv_text:${grant.companyId}:${documentId}`);
  await reassertAccess(tx, grant, 'candidate', 'upload', ['document']);
  if (doc.document_type !== 'CV') throw new HttpError(422, 'NOT_A_CV', 'Only a CV document has searchable content');
  // FR-106: only a file the malware scan released is read or transcribed.
  if (doc.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'This file has not been released by the malware scan', { scanState: doc.scan_state });
  // FR-013 consent status: nothing of a candidate who has not given consent becomes searchable.
  const consent = (await tx.query<{ consent_status: string }>(`select consent_status from candidate where company_id = $1 and id = $2 for share`, [grant.companyId, doc.candidate_id])).rows[0]!;
  if (consent.consent_status !== 'GIVEN') throw new HttpError(409, 'CONSENT_REQUIRED', 'The candidate’s consent must be recorded as given before CV content becomes searchable', { consentStatus: consent.consent_status });

  let source: 'TRANSCRIBED' | 'EXTRACTED';
  let content: string;
  if (input.content !== undefined) {
    source = 'TRANSCRIBED';
    content = normaliseCvText(input.content);
  } else {
    const extractor = EXTRACTORS.get(doc.media_type);
    if (!extractor) {
      throw new HttpError(422, 'EXTRACTION_NOT_CONFIGURED', 'No text-extraction component is configured for this file type; type or paste the text to approve', { mediaType: doc.media_type });
    }
    source = 'EXTRACTED';
    content = normaliseCvText(await extractor(await files.get(doc.content_reference)));
  }
  if (content === '') throw new HttpError(422, 'NO_TEXT', 'There is no text to approve');
  if (content.length > MAX_CV_TEXT) throw new HttpError(422, 'TEXT_TOO_LONG', `Searchable text is at most ${MAX_CV_TEXT} characters`);

  const replaced = (
    await tx.query<{ id: string }>(
      `update candidate_cv_text set state = 'REVOKED', revoked_by = $3, revoked_at = now(), revocation_reason = 'Replaced by a newly approved text', updated_by = $3
        where company_id = $1 and candidate_document_id = $2 and state = 'APPROVED' returning id`,
      [grant.companyId, documentId, grant.userId],
    )
  ).rows[0];
  const id = (
    await tx.query<{ id: string }>(
      `insert into candidate_cv_text (company_id, candidate_id, candidate_document_id, source, content, document_checksum, state, approved_by, approved_assignment_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'APPROVED', $7, $8, $7, $7) returning id`,
      [grant.companyId, doc.candidate_id, documentId, source, content, doc.checksum, grant.userId, grant.assignmentId],
    )
  ).rows[0]!.id;
  await audit(tx, grant, 'candidate_cv_text', id, 'APPROVE', replaced ? { replacedCvTextId: replaced.id } : null, { candidateId: doc.candidate_id, candidateDocumentId: documentId, source, length: content.length });
  return { id, candidateDocumentId: documentId, candidateId: doc.candidate_id, source, state: 'APPROVED', length: content.length, replacedCvTextId: replaced?.id ?? null };
}

export async function revokeCvText(tx: Queryable, grant: AccessGrant, documentId: string, input: { reason: string }) {
  const doc = await documentFacts(tx, grant, documentId);
  await advisoryLock(tx, `hiring:cv_text:${grant.companyId}:${documentId}`);
  await reassertAccess(tx, grant, 'candidate', 'upload', ['document']);
  const reason = requireText(input.reason, 'reason');
  const revoked = (
    await tx.query<{ id: string }>(
      `update candidate_cv_text set state = 'REVOKED', revoked_by = $3, revoked_at = now(), revocation_reason = $4, updated_by = $3
        where company_id = $1 and candidate_document_id = $2 and state = 'APPROVED' returning id`,
      [grant.companyId, documentId, grant.userId, reason],
    )
  ).rows[0];
  if (!revoked) throw new HttpError(409, 'NO_APPROVED_TEXT', 'This document has no approved searchable text');
  await audit(tx, grant, 'candidate_cv_text', revoked.id, 'REVOKE', { state: 'APPROVED' }, { state: 'REVOKED', candidateId: doc.candidate_id, candidateDocumentId: documentId }, reason);
  return { id: revoked.id, candidateDocumentId: documentId, state: 'REVOKED' };
}

/** The document's approved text and its approval history (candidate.read.document, the grant that reads the CV itself). */
export async function cvTextOf(db: Queryable, grant: AccessGrant, documentId: string) {
  const doc = await documentFacts(db, grant, documentId);
  const rows = (
    await db.query<{ id: string; state: string; source: string; content: string; approvedAt: Date; approvedBy: string; approvedByPerson: unknown; revokedAt: Date | null; revocationReason: string | null }>(
      `select x.id, x.state, x.source, x.content, x.approved_at as "approvedAt", x.approved_by as "approvedBy", ${personSql('x.company_id', 'x.approved_by', 'x.approved_at')} as "approvedByPerson",
              x.revoked_at as "revokedAt", x.revocation_reason as "revocationReason"
         from candidate_cv_text x where x.company_id = $1 and x.candidate_document_id = $2 order by x.approved_at desc`,
      [grant.companyId, documentId],
    )
  ).rows;
  const approved = rows.find((r) => r.state === 'APPROVED');
  if (approved) await audit(db, grant, 'candidate_cv_text', approved.id, 'READ_CONTENT', null, { candidateId: doc.candidate_id, candidateDocumentId: documentId });
  return {
    candidateDocumentId: documentId,
    candidateId: doc.candidate_id,
    consentStatus: doc.consent_status,
    // Searchable now: approved, the candidate's consent still given and the retention date not passed (as the search reads it).
    searchable: approved !== undefined && doc.candidate_searchable,
    approved: approved ? { id: approved.id, source: approved.source, content: approved.content, approvedAt: approved.approvedAt, approvedBy: approved.approvedBy, approvedByPerson: approved.approvedByPerson } : null,
    history: rows.map(({ content: _c, ...r }) => r),
  };
}
