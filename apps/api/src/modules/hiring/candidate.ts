// Candidate and CV register (DB061; FR-013; F1; DF02; DF04 candidate contract; DF08).
//
// Operational register: code, name, source/vendor, skills, consent/retention status, state. Private contacts
// (email/phone) are confidential: an eligible scoped Admin records and reads them; they are stored as a sealed
// envelope (security/field-crypto.ts) plus one keyed identity hash per normalised value (HMAC-SHA-256, company
// bound), which is all duplicate detection needs. A match is flagged for review, never merged. CV and other
// candidate documents are confidential attachments; every content read is audited. Nothing is deleted.
import { createHash, createHmac } from 'node:crypto';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { openJson, sealJson } from '../../security/field-crypto.js';
import type { FileStore, StoredFile } from '../../storage/files.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { audit, checkVersion, cleanSkills, lockIdentity, nextCode, type Paging, pageOf, referenceId, requireDate, requireText } from './common.js';
import { candidateScope, canAccessCandidate, isUnrestricted, requisitionScope } from './scope.js';

export type ConsentStatus = 'NOT_RECORDED' | 'GIVEN' | 'WITHDRAWN';

// ---------------------------------------------------------------------------------------------------------
// Identity keys and contact normalisation
// ---------------------------------------------------------------------------------------------------------

let devSecret: Buffer | null = null;

/**
 * Key for identity hashes: HRMS_CANDIDATE_IDENTITY_KEY (base64, 32 bytes). Outside production a fixed development
 * key is used when none is configured; production refuses to match (fail closed) until a key is configured.
 */
function identitySecret(): Buffer {
  const spec = process.env.HRMS_CANDIDATE_IDENTITY_KEY;
  if (!spec) {
    if (process.env.NODE_ENV === 'production') throw new HttpError(503, 'NOT_CONFIGURED', 'Candidate identity matching is not configured');
    devSecret ??= createHash('sha256').update('hrms-development-candidate-identity-key; never for real data').digest();
    return devSecret;
  }
  const key = Buffer.from(spec, 'base64');
  if (key.length !== 32) throw new HttpError(503, 'NOT_CONFIGURED', 'Candidate identity matching is not configured');
  return key;
}

/** Fails fast when the identity key is missing or malformed in production (for start-up wiring). */
export function assertCandidateIdentityKeyConfigured(): void {
  identitySecret();
}

export const identityKey = (companyId: string, basis: 'EMAIL' | 'PHONE', normalised: string) =>
  createHmac('sha256', identitySecret()).update(`hrms:candidate-identity:v1:${companyId}:${basis}:${normalised}`, 'utf8').digest('hex');

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Trimmed and lower-cased; otherwise kept as entered (no provider-specific rewriting). */
export function normaliseEmail(value: string): string {
  const v = value.trim().toLowerCase();
  if (v.length > 254 || !EMAIL.test(v)) throw new HttpError(422, 'INVALID_FIELD', 'The email address is not valid', { field: 'email' });
  return v;
}

/** Digits only (spaces, dashes, dots, brackets and a leading + are formatting); at most 15 digits (E.164). */
export function normalisePhone(value: string): string {
  const v = value.trim();
  if (!/^\+?[0-9 ().-]+$/.test(v)) throw new HttpError(422, 'INVALID_FIELD', 'The phone number is not valid', { field: 'phone' });
  const digits = v.replace(/\D/g, '');
  if (digits.length < 3 || digits.length > 15) throw new HttpError(422, 'INVALID_FIELD', 'The phone number is not valid', { field: 'phone' });
  return digits;
}

interface Contact {
  email: string | null;
  phone: string | null;
}

const contactBinding = (companyId: string, candidateId: string) => ({ purpose: 'candidate.contact', companyId, ownerId: candidateId, recordId: candidateId });

// ---------------------------------------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------------------------------------

export interface CandidateInput {
  fullName: string;
  sourceCode: string;
  vendorId?: string | null | undefined;
  skills?: string[] | undefined;
  consentStatus: ConsentStatus;
  consentRecordedOn?: string | null | undefined;
  retainUntil?: string | null | undefined;
}

interface CandidateValues {
  fullName: string;
  sourceId: string;
  sourceCode: string;
  vendorId: string | null;
  skills: string[];
  consentStatus: ConsentStatus;
  consentRecordedOn: string | null;
  retainUntil: string | null;
}

async function validateCandidate(tx: Queryable, grant: AccessGrant, input: CandidateInput): Promise<CandidateValues> {
  const sourceId = await referenceId(tx, grant.companyId, 'CANDIDATE_SOURCE', input.sourceCode);
  const vendorId = input.vendorId ?? null;
  // A vendor is recorded exactly when the candidate came through a vendor.
  if ((input.sourceCode === 'VENDOR') !== (vendorId !== null)) {
    throw new HttpError(422, 'VENDOR_MISMATCH', input.sourceCode === 'VENDOR' ? 'Name the recruitment vendor' : 'A vendor is recorded only for the VENDOR source', { field: 'vendorId' });
  }
  if (vendorId) {
    const v = await tx.query(`select 1 from recruitment_vendor where company_id = $1 and id = $2 and active`, [grant.companyId, vendorId]);
    if (!v.rowCount) throw new HttpError(422, 'INVALID_REFERENCE', 'The vendor is not an active vendor of this company', { field: 'vendorId' });
  }
  const consentRecordedOn = input.consentRecordedOn ?? null;
  if ((input.consentStatus === 'NOT_RECORDED') !== (consentRecordedOn === null)) {
    throw new HttpError(422, 'CONSENT_DATE_MISMATCH', 'Record the consent date exactly when consent is given or withdrawn', { field: 'consentRecordedOn' });
  }
  if (consentRecordedOn && requireDate(consentRecordedOn, 'consentRecordedOn') > grant.businessDate) {
    throw new HttpError(422, 'INVALID_DATE', 'The consent date cannot be in the future', { field: 'consentRecordedOn' });
  }
  const retainUntil = input.retainUntil ?? null;
  if (retainUntil) requireDate(retainUntil, 'retainUntil');
  const skills = cleanSkills(input.skills);
  if (skills.length > 50 || skills.some((s) => s.length > 100)) throw new HttpError(422, 'INVALID_FIELD', 'List at most 50 skills of up to 100 characters', { field: 'skills' });
  return { fullName: requireText(input.fullName, 'fullName'), sourceId, sourceCode: input.sourceCode, vendorId, skills, consentStatus: input.consentStatus, consentRecordedOn, retainUntil };
}

const candidateOperational = (v: CandidateValues) => ({
  fullName: v.fullName,
  sourceCode: v.sourceCode,
  vendorId: v.vendorId,
  skills: v.skills,
  consentStatus: v.consentStatus,
  consentRecordedOn: v.consentRecordedOn,
  retainUntil: v.retainUntil,
});

/** Registering a candidate is company-scope work: the new record joins the open talent register. */
function requireRegisterScope(grant: AccessGrant): void {
  if (grant.scopeKind !== 'COMPANY' || grant.filters.employees.length > 0) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

export async function createCandidate(tx: Queryable, grant: AccessGrant, input: CandidateInput): Promise<string> {
  requireRegisterScope(grant);
  const v = await validateCandidate(tx, grant, input);
  const code = await nextCode(tx, grant.companyId, 'CANDIDATE', grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into candidate (company_id, candidate_code, full_name, source_id, vendor_id, skills, consent_status, consent_recorded_on, retain_until, state, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'ACTIVE', $10, $10) returning id`,
      [grant.companyId, code, v.fullName, v.sourceId, v.vendorId, v.skills, v.consentStatus, v.consentRecordedOn, v.retainUntil, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, grant, 'candidate', id, 'CREATE', null, { candidateCode: code, ...candidateOperational(v), state: 'ACTIVE' });
  return id;
}

interface CandidateRow {
  id: string;
  full_name: string;
  source_code: string;
  vendor_id: string | null;
  skills: string[];
  consent_status: ConsentStatus;
  consent_recorded_on: string | null;
  retain_until: string | null;
  state: 'ACTIVE' | 'INACTIVE' | 'DUPLICATE';
  version: number;
}

async function lockCandidate(tx: Queryable, grant: AccessGrant, id: string): Promise<CandidateRow> {
  if (!(await canAccessCandidate(tx, grant, id))) throw notFound();
  const row = (
    await tx.query<CandidateRow>(
      `select c.id, c.full_name, s.code as source_code, c.vendor_id, c.skills, c.consent_status, to_char(c.consent_recorded_on, 'YYYY-MM-DD') as consent_recorded_on,
              to_char(c.retain_until, 'YYYY-MM-DD') as retain_until, c.state, c.version
         from candidate c join reference_value s on s.company_id = c.company_id and s.id = c.source_id
        where c.company_id = $1 and c.id = $2 for update of c`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

export interface CandidatePatch extends Partial<CandidateInput> {
  state?: 'ACTIVE' | 'INACTIVE' | undefined;
  expectedVersion: number;
}

export async function updateCandidate(tx: Queryable, grant: AccessGrant, id: string, patch: CandidatePatch): Promise<void> {
  const c = await lockCandidate(tx, grant, id);
  checkVersion(c.version, patch.expectedVersion);
  if (patch.state && c.state === 'DUPLICATE') throw new HttpError(409, 'INVALID_STATE', 'A confirmed duplicate stays retired; use the original record');
  const merged: CandidateInput = {
    fullName: patch.fullName ?? c.full_name,
    sourceCode: patch.sourceCode ?? c.source_code,
    vendorId: patch.vendorId !== undefined ? patch.vendorId : patch.sourceCode !== undefined && patch.sourceCode !== 'VENDOR' ? null : c.vendor_id,
    skills: patch.skills ?? c.skills,
    consentStatus: patch.consentStatus ?? c.consent_status,
    consentRecordedOn: patch.consentRecordedOn !== undefined ? patch.consentRecordedOn : patch.consentStatus === 'NOT_RECORDED' ? null : c.consent_recorded_on,
    retainUntil: patch.retainUntil !== undefined ? patch.retainUntil : c.retain_until,
  };
  const v = await validateCandidate(tx, grant, merged);
  const state = patch.state ?? c.state;
  await tx.query(
    `update candidate set full_name = $3, source_id = $4, vendor_id = $5, skills = $6, consent_status = $7, consent_recorded_on = $8, retain_until = $9, state = $10, updated_by = $11
      where company_id = $1 and id = $2`,
    [grant.companyId, id, v.fullName, v.sourceId, v.vendorId, v.skills, v.consentStatus, v.consentRecordedOn, v.retainUntil, state, grant.userId],
  );
  await audit(
    tx,
    grant,
    'candidate',
    id,
    'UPDATE',
    {
      fullName: c.full_name,
      sourceCode: c.source_code,
      vendorId: c.vendor_id,
      skills: c.skills,
      consentStatus: c.consent_status,
      consentRecordedOn: c.consent_recorded_on,
      retainUntil: c.retain_until,
      state: c.state,
    },
    { ...candidateOperational(v), state },
  );
}

const CANDIDATE_SELECT = `select c.id, c.candidate_code as "candidateCode", c.full_name as "fullName",
       json_build_object('code', s.code, 'label', s.label) as source,
       case when v.id is null then null else json_build_object('id', v.id, 'code', v.code, 'name', v.name) end as vendor,
       c.skills, c.consent_status as "consentStatus", to_char(c.consent_recorded_on, 'YYYY-MM-DD') as "consentRecordedOn",
       to_char(c.retain_until, 'YYYY-MM-DD') as "retainUntil", c.state, c.created_at as "createdAt", c.version
  from candidate c
  join reference_value s on s.company_id = c.company_id and s.id = c.source_id
  left join recruitment_vendor v on v.company_id = c.company_id and v.id = c.vendor_id`;

export async function listCandidates(db: Queryable, grant: AccessGrant, q: { search?: string | undefined; state?: string | undefined; page: number; pageSize: number }) {
  const p = new SqlParams();
  const where = [candidateScope(grant, 'c', p)];
  if (q.state) where.push(`c.state = ${p.add(q.state)}`);
  if (q.search?.trim()) {
    const pattern = p.add(`%${q.search.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
    // FR-013 search covers the operational metadata only (code, name, skills); contacts are never searchable here.
    where.push(`(c.candidate_code ilike ${pattern} or c.full_name ilike ${pattern} or array_to_string(c.skills, ' ') ilike ${pattern})`);
  }
  const page = await pageOf(db, `${CANDIDATE_SELECT} where ${where.join(' and ')}`, p.values, `"candidateCode", id`, { page: q.page, pageSize: q.pageSize }, q.pageSize);
  return { items: page.items, total: page.total, page: q.page, pageSize: q.pageSize };
}

export async function getCandidate(db: Queryable, grant: AccessGrant, id: string) {
  const p = new SqlParams([id]);
  const row = (await db.query(`${CANDIDATE_SELECT} where c.id = $1 and ${candidateScope(grant, 'c', p)}`, p.values)).rows[0];
  if (!row) return null;
  const ap = new SqlParams([id]);
  const applications = (
    await db.query(
      `select a.id as "applicationId", r.id as "requisitionId", r.code as "requisitionCode", r.title, a.stage, a.stage_entered_at as "stageEnteredAt"
         from application a join requisition r on r.company_id = a.company_id and r.id = a.requisition_id
        where a.candidate_id = $1 and ${requisitionScope(grant, 'r', ap)} order by a.created_at`,
      ap.values,
    )
  ).rows;
  const contactRecorded = (await db.query(`select 1 from candidate_contact where company_id = $1 and candidate_id = $2`, [grant.companyId, id])).rowCount! > 0;
  return { ...row, contactRecorded, applications, duplicateFlags: (await listDuplicateFlags(db, grant, { candidateId: id })).items };
}

// ---------------------------------------------------------------------------------------------------------
// Private contacts (confidential) and duplicate detection
// ---------------------------------------------------------------------------------------------------------

async function readContact(db: Queryable, companyId: string, candidateId: string): Promise<(Contact & { updatedAt: Date }) | null> {
  const row = (await db.query<{ payload: string; updated_at: Date }>(`select payload, updated_at from candidate_contact where company_id = $1 and candidate_id = $2`, [companyId, candidateId])).rows[0];
  return row ? { ...openJson<Contact>(row.payload, contactBinding(companyId, candidateId)), updatedAt: row.updated_at } : null;
}

export async function getContact(db: Queryable, grant: AccessGrant, candidateId: string) {
  if (!(await canAccessCandidate(db, grant, candidateId))) throw notFound();
  const contact = await readContact(db, grant.companyId, candidateId);
  // FR-057: reading confidential values is attributable (field names only in the trail).
  await audit(db, grant, 'candidate', candidateId, 'READ_CONTACT', null, { fields: contact ? (['email', 'phone'] as const).filter((f) => contact[f] !== null) : [] });
  return { candidateId, email: contact?.email ?? null, phone: contact?.phone ?? null, updatedAt: contact?.updatedAt ?? null };
}

export async function setContact(tx: Queryable, grant: AccessGrant, candidateId: string, input: { email?: string | null | undefined; phone?: string | null | undefined }) {
  await lockCandidate(tx, grant, candidateId);
  const current = await readContact(tx, grant.companyId, candidateId);
  const next: Contact = {
    email: input.email === undefined ? (current?.email ?? null) : input.email === null ? null : normaliseEmail(input.email),
    phone: input.phone === undefined ? (current?.phone ?? null) : input.phone === null ? null : input.phone.trim(),
  };
  const phoneDigits = next.phone === null ? null : normalisePhone(next.phone);
  const emailKey = next.email === null ? null : identityKey(grant.companyId, 'EMAIL', next.email);
  const phoneKey = phoneDigits === null ? null : identityKey(grant.companyId, 'PHONE', phoneDigits);
  // Concurrent entries of the same identity serialise here, so neither can miss the other.
  for (const key of [emailKey, phoneKey].filter((k): k is string => k !== null).sort()) await lockIdentity(tx, grant.companyId, key);
  await tx.query(
    `insert into candidate_contact (company_id, candidate_id, payload, email_key, phone_key, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $6)
     on conflict (company_id, candidate_id) do update set payload = excluded.payload, email_key = excluded.email_key, phone_key = excluded.phone_key, updated_by = excluded.updated_by`,
    [grant.companyId, candidateId, sealJson(next, contactBinding(grant.companyId, candidateId)), emailKey, phoneKey, grant.userId],
  );
  const matches = (
    await tx.query<{ candidate_id: string; basis: 'EMAIL' | 'PHONE' }>(
      `select candidate_id, 'EMAIL' as basis from candidate_contact where company_id = $1 and email_key = $2 and candidate_id <> $4
       union all
       select candidate_id, 'PHONE' as basis from candidate_contact where company_id = $1 and phone_key = $3 and candidate_id <> $4`,
      [grant.companyId, emailKey, phoneKey, candidateId],
    )
  ).rows;
  let flagged = 0;
  for (const m of matches) {
    const created = await tx.query(
      `insert into candidate_duplicate_flag (company_id, candidate_id, matched_candidate_id, basis, state, created_by, updated_by)
       values ($1, $2, $3, $4, 'OPEN', $5, $5) on conflict do nothing`,
      [grant.companyId, candidateId, m.candidate_id, m.basis, grant.userId],
    );
    flagged += created.rowCount ?? 0;
  }
  const changed = (['email', 'phone'] as const).filter((f) => (current?.[f] ?? null) !== next[f]);
  await audit(tx, grant, 'candidate', candidateId, 'SET_CONTACT', null, { changedFields: changed, duplicateFlagsRaised: flagged });
  return { candidateId, changedFields: changed, duplicateFlags: (await listDuplicateFlags(tx, grant, { candidateId, state: 'OPEN' })).items };
}

/** Without page or pageSize the flag list answers its latest 500 flags, as before paging; `total` counts them all. */
export const DUPLICATE_FLAG_LIST_CAP = 500;

/** Flags whose two candidates are both inside the caller's scope (no hint about records outside it). */
export async function listDuplicateFlags(db: Queryable, grant: AccessGrant, q: { state?: string | undefined; candidateId?: string | undefined } & Paging) {
  const p = new SqlParams();
  const where = [`f.company_id = ${p.add(grant.companyId)}::uuid`, candidateScope(grant, 'c1', p), candidateScope(grant, 'c2', p)];
  if (q.state) where.push(`f.state = ${p.add(q.state)}`);
  if (q.candidateId) {
    const c = p.add(q.candidateId);
    where.push(`(f.candidate_id = ${c}::uuid or f.matched_candidate_id = ${c}::uuid)`);
  }
  return pageOf(
    db,
    `select f.id as "flagId", f.basis, f.state, f.created_at as "flaggedAt", f.resolved_at as "resolvedAt", f.resolution_note as "resolutionNote",
            f.retired_candidate_id as "retiredCandidateId",
            json_build_object('id', c1.id, 'candidateCode', c1.candidate_code, 'fullName', c1.full_name, 'state', c1.state) as candidate,
            json_build_object('id', c2.id, 'candidateCode', c2.candidate_code, 'fullName', c2.full_name, 'state', c2.state) as "matchedCandidate"
       from candidate_duplicate_flag f
       join candidate c1 on c1.company_id = f.company_id and c1.id = f.candidate_id
       join candidate c2 on c2.company_id = f.company_id and c2.id = f.matched_candidate_id
      where ${where.join(' and ')}`,
    p.values,
    `"flaggedAt" desc, "flagId"`,
    q,
    DUPLICATE_FLAG_LIST_CAP,
  );
}

export async function resolveDuplicateFlag(
  tx: Queryable,
  grant: AccessGrant,
  flagId: string,
  input: { resolution: 'NOT_DUPLICATE' | 'CONFIRMED_DUPLICATE'; retireCandidateId?: string | undefined; note: string },
) {
  const flag = (
    await tx.query<{ candidate_id: string; matched_candidate_id: string; state: string }>(
      `select candidate_id, matched_candidate_id, state from candidate_duplicate_flag where company_id = $1 and id = $2 for update`,
      [grant.companyId, flagId],
    )
  ).rows[0];
  if (!flag || !(await canAccessCandidate(tx, grant, flag.candidate_id)) || !(await canAccessCandidate(tx, grant, flag.matched_candidate_id))) throw notFound();
  if (flag.state !== 'OPEN') throw new HttpError(409, 'INVALID_STATE', 'This flag has already been reviewed');
  const note = requireText(input.note, 'note');
  let retired: string | null = null;
  if (input.resolution === 'CONFIRMED_DUPLICATE') {
    retired = input.retireCandidateId ?? null;
    if (retired !== flag.candidate_id && retired !== flag.matched_candidate_id) {
      throw new HttpError(422, 'RETIRE_CANDIDATE_REQUIRED', 'Name which of the two records is the duplicate to retire', { field: 'retireCandidateId' });
    }
    await lockCandidate(tx, grant, retired);
  }
  // The review decision re-checks its duty after the locks (docs/09 §6.5).
  await reassertAccess(tx, grant, 'candidate', 'manage', ['operational']);
  if (retired) {
    // No merge: the duplicate record is retired (no new applications); its history and applications stay as they are.
    await tx.query(`update candidate set state = 'DUPLICATE', updated_by = $3 where company_id = $1 and id = $2 and state <> 'DUPLICATE'`, [grant.companyId, retired, grant.userId]);
    await audit(tx, grant, 'candidate', retired, 'RETIRE_DUPLICATE', null, { state: 'DUPLICATE', flagId });
  }
  await tx.query(
    `update candidate_duplicate_flag set state = $3, retired_candidate_id = $4, resolution_note = $5, resolved_by = $6, resolved_at = now(), updated_by = $6
      where company_id = $1 and id = $2`,
    [grant.companyId, flagId, input.resolution, retired, note, grant.userId],
  );
  await audit(tx, grant, 'candidate_duplicate_flag', flagId, 'RESOLVE', { state: 'OPEN' }, { state: input.resolution, retiredCandidateId: retired }, note);
  return { flagId, state: input.resolution, retiredCandidateId: retired };
}

// ---------------------------------------------------------------------------------------------------------
// Candidate documents (confidential)
// ---------------------------------------------------------------------------------------------------------

export async function addCandidateDocument(
  tx: Queryable,
  grant: AccessGrant,
  candidateId: string,
  input: { documentType: string; fileName: string; stored: StoredFile; mediaType: string },
) {
  if (!(await canAccessCandidate(tx, grant, candidateId))) throw notFound();
  const typeId = await referenceId(tx, grant.companyId, 'CANDIDATE_DOCUMENT_TYPE', input.documentType);
  // FR-106: a user upload is quarantined until the malware scanner releases it (scanned by the route right after
  // this commits; a scanner outage leaves it pending for the worker's retry).
  const attachmentId = (
    await tx.query<{ id: string }>(
      `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size,
                               scan_state, created_by, updated_by)
       values ($1, $2, null, $3, $4, $5, 'CONFIDENTIAL', $6, $7, 'PENDING_SCAN', $2, $2) returning id`,
      [grant.companyId, grant.userId, input.stored.reference, input.mediaType, input.stored.checksum, input.fileName.trim(), input.stored.byteSize],
    )
  ).rows[0]!.id;
  const id = (
    await tx.query<{ id: string }>(
      `insert into candidate_document (company_id, candidate_id, document_type_id, attachment_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5) returning id`,
      [grant.companyId, candidateId, typeId, attachmentId, grant.userId],
    )
  ).rows[0]!.id;
  // Document metadata is kept out of the operational group: the type and size only, never the file name or content.
  await audit(tx, grant, 'candidate_document', id, 'CREATE', null, { candidateId, documentType: input.documentType, byteSize: input.stored.byteSize, scanState: 'PENDING_SCAN' });
  return { id, attachmentId, mediaType: input.mediaType, byteSize: input.stored.byteSize, scanState: 'PENDING_SCAN' as const };
}

/** Records the scanner's verdict on a new upload (FR-057/FR-106; the state only, never a finding or the content). */
export async function recordCandidateScanVerdict(db: Queryable, grant: AccessGrant, documentId: string, scanState: 'CLEAN' | 'QUARANTINED'): Promise<void> {
  await audit(db, grant, 'candidate_document', documentId, scanState === 'CLEAN' ? 'SCAN_RELEASED' : 'SCAN_QUARANTINED', null, { scanState });
}

const DOCUMENT_SELECT = `select d.id, d.candidate_id as "candidateId", c.candidate_code as "candidateCode", t.code as "documentType", a.file_name as "fileName",
       a.media_type as "mediaType", a.byte_size as "byteSize", a.scan_state as "scanState", d.created_at as "uploadedAt"
  from candidate_document d
  join candidate c on c.company_id = d.company_id and c.id = d.candidate_id
  join reference_value t on t.company_id = d.company_id and t.id = d.document_type_id
  join attachment a on a.company_id = d.company_id and a.id = d.attachment_id`;

export async function listCandidateDocuments(db: Queryable, grant: AccessGrant, candidateId: string) {
  if (!(await canAccessCandidate(db, grant, candidateId))) throw notFound();
  return { items: (await db.query(`${DOCUMENT_SELECT} where d.company_id = $1 and d.candidate_id = $2 order by d.created_at desc`, [grant.companyId, candidateId])).rows };
}

/** Without page or pageSize the CV search answers its latest 200 hits, as before paging; `total` counts them all. */
export const DOCUMENT_SEARCH_CAP = 200;

/** FR-013 CV metadata search (file name, type, candidate code) within the caller's candidate scope. */
export async function searchCandidateDocuments(db: Queryable, grant: AccessGrant, search: string, paging: Paging = {}) {
  const p = new SqlParams();
  const pattern = p.add(`%${search.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`);
  return pageOf(
    db,
    `${DOCUMENT_SELECT} where ${candidateScope(grant, 'c', p)} and (a.file_name ilike ${pattern} or t.code ilike ${pattern} or c.candidate_code ilike ${pattern})`,
    p.values,
    `"uploadedAt" desc, id`,
    paging,
    DOCUMENT_SEARCH_CAP,
  );
}

export async function candidateDocumentContent(db: Queryable, grant: AccessGrant, files: FileStore, documentId: string) {
  const doc = (
    await db.query<{ candidate_id: string; content_reference: string; media_type: string; file_name: string | null; scan_state: string | null }>(
      `select d.candidate_id, a.content_reference, a.media_type, a.file_name, a.scan_state from candidate_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where d.company_id = $1 and d.id = $2`,
      [grant.companyId, documentId],
    )
  ).rows[0];
  if (!doc || !(await canAccessCandidate(db, grant, doc.candidate_id))) return null;
  // FR-106: only content the malware scanner released is ever served.
  if (doc.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'This file has not been released by the malware scan', { scanState: doc.scan_state });
  const bytes = await files.get(doc.content_reference);
  // FR-057: recorded once the bytes are in hand (a failed read leaves no record of content never returned).
  await audit(db, grant, 'candidate_document', documentId, 'READ_CONTENT', null, { candidateId: doc.candidate_id });
  return { bytes, mediaType: doc.media_type, fileName: doc.file_name };
}

/** Whether a candidate exists in the company at all (used to audit out-of-scope attempts on confidential data). */
export async function candidateExists(db: Queryable, companyId: string, candidateId: string): Promise<boolean> {
  return ((await db.query(`select 1 from candidate where company_id = $1 and id = $2`, [companyId, candidateId])).rowCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------------------
// Vendors (Hiring / Masters / Vendor): company-wide masters, deactivated never deleted (BR-004)
// ---------------------------------------------------------------------------------------------------------

export async function listVendors(db: Queryable, grant: AccessGrant, includeInactive: boolean) {
  const rows = await db.query(
    `select id, code, name, active, version from recruitment_vendor where company_id = $1 and ($2 or active) order by code`,
    [grant.companyId, includeInactive],
  );
  return { items: rows.rows };
}

export async function createVendor(tx: Queryable, grant: AccessGrant, input: { code: string; name: string }) {
  if (!isUnrestricted(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  const code = input.code.trim().toUpperCase();
  const name = requireText(input.name, 'name');
  const id = (
    await tx.query<{ id: string }>(`insert into recruitment_vendor (company_id, code, name, active, created_by, updated_by) values ($1, $2, $3, true, $4, $4) returning id`, [
      grant.companyId,
      code,
      name,
      grant.userId,
    ])
  ).rows[0]!.id;
  await audit(tx, grant, 'recruitment_vendor', id, 'CREATE', null, { code, name, active: true });
  return { id, code, name, active: true, version: 1 };
}

export async function updateVendor(tx: Queryable, grant: AccessGrant, id: string, input: { name?: string | undefined; active?: boolean | undefined; expectedVersion: number }) {
  if (!isUnrestricted(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  const v = (await tx.query<{ name: string; active: boolean; version: number; code: string }>(`select code, name, active, version from recruitment_vendor where company_id = $1 and id = $2 for update`, [grant.companyId, id])).rows[0];
  if (!v) throw notFound();
  checkVersion(v.version, input.expectedVersion);
  const name = input.name !== undefined ? requireText(input.name, 'name') : v.name;
  const active = input.active ?? v.active;
  const version = (
    await tx.query<{ version: number }>(`update recruitment_vendor set name = $3, active = $4, updated_by = $5 where company_id = $1 and id = $2 returning version`, [grant.companyId, id, name, active, grant.userId])
  ).rows[0]!.version;
  await audit(tx, grant, 'recruitment_vendor', id, 'UPDATE', { name: v.name, active: v.active }, { name, active });
  return { id, code: v.code, name, active, version };
}
