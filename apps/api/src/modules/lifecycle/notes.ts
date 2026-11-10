// Restricted HR notes, remarks and warnings (FR-018 "restrict notes and warnings to authorised HR roles"; reference
// menu "Exit Notes/Remarks/Warnings", BRD coverage CL-040). A confidential group of its own (employee_note.restricted), held only
// through an approved HR Administrator grant with row scope; never about one's own record. Notes are append-only: a
// correction is a new note that supersedes the earlier one, and a note withdrawn by mistake is voided with a reason (0260); the
// note and its void both stay.
//
// The register (0260; decided under owner delegation, 6 Nov 2026): the reference screen's six types (Appreciation, Exit note, Offer
// rejection, PIP, Remarks, Warning) plus the general NOTE of 0038, a date the note is about (never after today), an optional
// supporting file (quarantined until the malware scan releases it, FR-106), and a status derived from what happened to it: ACTIVE,
// SUPERSEDED (corrected by a later note) or VOIDED. The list filters by date range, type and status and searches employee name and
// code and the submitter's name, within the caller's row scope and never showing the caller's own record. Audit records carry the
// type, links and source, never the text or a void's reason (they stay in the confidential group).
import type { Paging } from '../../db/paging.js';
import { pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { decodeUpload, type FileStore } from '../../storage/files.js';
import { type ScanProvider, scanAttachment } from '../../storage/scan.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { actorOf, assertInScope, assertNotSelf, audit, isIsoDate } from './common.js';

/** The note types (0260): the reference screen's six, and the general note of 0038. */
export const NOTE_KINDS = ['APPRECIATION', 'EXIT_NOTE', 'OFFER_REJECTION', 'PIP', 'REMARK', 'WARNING', 'NOTE'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
/** What happened to a note (derived, never stored). */
export const NOTE_STATUSES = ['ACTIVE', 'SUPERSEDED', 'VOIDED'] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];
export const MAX_NOTE_TEXT = 4000;

export interface NoteInput {
  kind: NoteKind;
  body: string;
  /** The day the note is about; today (the company's business date) when omitted. */
  noteDate?: string | undefined;
  exitCaseId?: string | undefined;
  employeeProcessId?: string | undefined;
  supersedesNoteId?: string | undefined;
}

/** A supporting file already stored (files.put); its attachment row is written with the note. */
interface StoredUpload {
  reference: string;
  checksum: string;
  byteSize: number;
  mediaType: string;
  fileName: string;
}

/** The company's business date: a note is never dated after it (the database refuses it too, 0260). */
function checkNoteDate(grant: AccessGrant, noteDate: string | undefined): string {
  const day = noteDate ?? grant.businessDate;
  if (!isIsoDate(day)) throw new HttpError(422, 'INVALID_DATE', 'The note date is not a valid date', { field: 'noteDate' });
  if (day > grant.businessDate) throw new HttpError(422, 'NOTE_DATE_IN_FUTURE', 'A note cannot be dated after today', { field: 'noteDate' });
  return day;
}

/**
 * Writes one note inside the caller's transaction (the screen, the bulk upload). The row scope, own-record and link checks come
 * first; a correction locks the note it corrects, so a concurrent void or second correction waits and is then refused.
 */
export async function addNote(tx: Queryable, grant: AccessGrant, employeeId: string, input: NoteInput, opts: { source?: 'ENTRY' | 'IMPORT'; file?: StoredUpload } = {}) {
  await assertInScope(tx, grant, employeeId);
  assertNotSelf(grant, employeeId);
  if (!(NOTE_KINDS as readonly string[]).includes(input.kind)) throw new HttpError(422, 'INVALID_NOTE_TYPE', 'Unknown note type', { field: 'kind' });
  const body = input.body.trim();
  if (!body || body.length > MAX_NOTE_TEXT) throw new HttpError(422, 'INVALID_TEXT', `The note needs text of at most ${MAX_NOTE_TEXT} characters`, { field: 'body' });
  const noteDate = checkNoteDate(grant, input.noteDate);
  // Linked records must belong to the same employee (composite keys enforce it; checked here for a clear error).
  const check = async (table: string, id: string | undefined, lock = false) => {
    if (!id) return;
    const r = await tx.query(`select 1 from ${table} where company_id = $1 and id = $2 and employee_id = $3${lock ? ' for update' : ''}`, [grant.companyId, id, employeeId]);
    if ((r.rowCount ?? 0) === 0) throw new HttpError(422, 'INVALID_REFERENCE', 'The linked record does not belong to this employee');
  };
  await check('exit_case', input.exitCaseId);
  await check('employee_process', input.employeeProcessId);
  await check('employee_note', input.supersedesNoteId, true);
  if (input.supersedesNoteId) {
    const taken = await tx.query(`select 1 from employee_note where company_id = $1 and supersedes_note_id = $2`, [grant.companyId, input.supersedesNoteId]);
    if ((taken.rowCount ?? 0) > 0) throw new HttpError(409, 'ALREADY_SUPERSEDED', 'That note was already corrected');
    const voided = await tx.query(`select 1 from employee_note_void where company_id = $1 and note_id = $2`, [grant.companyId, input.supersedesNoteId]);
    if ((voided.rowCount ?? 0) > 0) throw new HttpError(409, 'NOTE_VOIDED', 'That note was voided and cannot be corrected');
  }
  let attachmentId: string | null = null;
  if (opts.file) {
    // FR-106: quarantined (PENDING_SCAN) until the scanner releases it; confidential like the note.
    attachmentId = (
      await tx.query<{ id: string }>(
        `insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size, scan_state, created_by, updated_by)
         values ($1, $2, $3, $4, $5, $6, 'CONFIDENTIAL', $7, $8, 'PENDING_SCAN', $2, $2) returning id`,
        [grant.companyId, grant.userId, employeeId, opts.file.reference, opts.file.mediaType, opts.file.checksum, opts.file.fileName, opts.file.byteSize],
      )
    ).rows[0]!.id;
  }
  const source = opts.source ?? 'ENTRY';
  const note = (
    await tx.query<{ id: string; created_at: Date }>(
      `insert into employee_note (company_id, employee_id, note_kind, body, note_date, attachment_id, source, exit_case_id, employee_process_id, supersedes_note_id, created_by, acting_assignment_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id, created_at`,
      [grant.companyId, employeeId, input.kind, body, noteDate, attachmentId, source, input.exitCaseId ?? null, input.employeeProcessId ?? null, input.supersedesNoteId ?? null, grant.userId, grant.assignmentId],
    )
  ).rows[0]!;
  // The note text stays in its confidential group; the audit carries the kind, date, source and links only.
  await audit(tx, actorOf(grant), 'employee_note', note.id, 'CREATE', null, {
    restricted: {
      employeeId,
      kind: input.kind,
      noteDate,
      source,
      attachment: attachmentId !== null,
      exitCaseId: input.exitCaseId ?? null,
      processId: input.employeeProcessId ?? null,
      supersedes: input.supersedesNoteId ?? null,
    },
  });
  return { id: note.id, employeeId, kind: input.kind, noteDate, attachmentId, createdAt: note.created_at };
}

/**
 * A note written on screen, with an optional supporting file: the file is stored first, the note and its attachment row are
 * written in one transaction, then the file is offered to the scanner (FR-106: in every deployment it stays PENDING_SCAN until
 * the scan worker's verdict, which nothing here waits for).
 */
export async function createNote(
  db: Database,
  files: FileStore,
  scanner: ScanProvider,
  grant: AccessGrant,
  employeeId: string,
  input: NoteInput & { attachment?: { fileName: string; contentBase64: string } | undefined },
) {
  let stored: (StoredUpload & { bytes: Buffer }) | undefined;
  if (input.attachment) {
    // Scope and own record first: nothing is stored for an employee the caller may not write about.
    await assertInScope(db, grant, employeeId);
    assertNotSelf(grant, employeeId);
    const { bytes, mediaType } = decodeUpload(input.attachment.contentBase64);
    const put = await files.put(grant.companyId, bytes);
    stored = { ...put, mediaType, fileName: input.attachment.fileName.trim(), bytes };
  }
  const created = await withTransaction(db, (tx) => addNote(tx, grant, employeeId, input, stored ? { file: stored } : {}));
  let scanState: string | null = null;
  if (stored && created.attachmentId) {
    scanState = await scanAttachment(db, scanner, { companyId: grant.companyId, id: created.attachmentId, bytes: stored.bytes });
    if (scanState !== 'PENDING_SCAN') {
      await audit(db, actorOf(grant), 'employee_note', created.id, scanState === 'CLEAN' ? 'SCAN_RELEASED' : 'SCAN_QUARANTINED', null, { restricted: { employeeId, scanState } });
    }
  }
  return { ...created, attachment: created.attachmentId ? { id: created.attachmentId, scanState } : null };
}

/** The derived status of note `n` (0260). */
const STATUS_SQL = `case when exists (select 1 from employee_note_void v where v.company_id = n.company_id and v.note_id = n.id) then 'VOIDED'
            when exists (select 1 from employee_note s where s.company_id = n.company_id and s.supersedes_note_id = n.id) then 'SUPERSEDED'
            else 'ACTIVE' end`;

/** The submitter's name: the employee their account is linked to, else their account key. */
const SUBMITTER_SQL = `coalesce((select se.display_name from user_employee_link l join employee se on se.company_id = l.company_id and se.id = l.employee_id
                                   where l.company_id = n.company_id and l.user_id = n.created_by order by l.effective_from desc limit 1),
                                 (select u.account_key from user_account u where u.id = n.created_by))`;

/** The columns of one note `n` as every note list answers them. */
const NOTE_COLUMNS = `n.id, n.employee_id as "employeeId", n.note_kind as kind, n.note_date as "noteDate", n.body, n.source,
            n.exit_case_id as "exitCaseId", n.employee_process_id as "processId", n.supersedes_note_id as "supersedesNoteId",
            (select s.id from employee_note s where s.company_id = n.company_id and s.supersedes_note_id = n.id) as "supersededByNoteId",
            ${STATUS_SQL} as status,
            (select json_build_object('reason', v.reason, 'voidedAt', v.voided_at, 'voidedBy', v.voided_by) from employee_note_void v
              where v.company_id = n.company_id and v.note_id = n.id) as "void",
            (select json_build_object('id', a.id, 'fileName', a.file_name, 'mediaType', a.media_type, 'byteSize', a.byte_size, 'scanState', a.scan_state)
               from attachment a where a.company_id = n.company_id and a.id = n.attachment_id) as attachment,
            n.created_by as "createdBy", ${SUBMITTER_SQL} as "submittedByName", n.created_at as "createdAt"`;

/** Notes answered without page/pageSize (the list's first answer before it could page). */
export const NOTE_LIST_CAP = 500;

/** An employee's notes, newest first: one page (FR-056), or the first 500 without page/pageSize; `total` counts all. */
export async function listNotes(db: Queryable, grant: AccessGrant, employeeId: string, paging: Paging = {}) {
  await assertInScope(db, grant, employeeId);
  assertNotSelf(grant, employeeId);
  return pageOf(db, `select ${NOTE_COLUMNS} from employee_note n where n.company_id = $1 and n.employee_id = $2`, [grant.companyId, employeeId], '"createdAt" desc, id', paging, NOTE_LIST_CAP);
}

export interface RegisterQuery extends Paging {
  from?: string | undefined;
  to?: string | undefined;
  kind?: NoteKind | undefined;
  status?: NoteStatus | undefined;
  /** Employee name or code, or the submitter's name (case-insensitive, part of the text). */
  search?: string | undefined;
}

/**
 * The notes register (CL-040): every note about the employees in the caller's row scope, the caller's own record left out, newest
 * note date first, one page at a time with the total of every match (FR-056; BR-026: the filters apply before paging, so the
 * total reconciles with the pages).
 */
export async function listNoteRegister(db: Queryable, grant: AccessGrant, q: RegisterQuery) {
  if (q.from && !isIsoDate(q.from)) throw new HttpError(422, 'INVALID_DATE', 'The from date is not a valid date', { field: 'from' });
  if (q.to && !isIsoDate(q.to)) throw new HttpError(422, 'INVALID_DATE', 'The to date is not a valid date', { field: 'to' });
  if (q.from && q.to && q.to < q.from) throw new HttpError(422, 'INVALID_PERIOD', 'The period ends before it starts');
  const p = new SqlParams();
  const where = [employeeScopePredicate(grant, { company: 'n.company_id', employee: 'n.employee_id' }, p)];
  if (grant.linkedEmployeeId) where.push(`n.employee_id <> ${p.add(grant.linkedEmployeeId)}::uuid`);
  if (q.from) where.push(`n.note_date >= ${p.add(q.from)}::date`);
  if (q.to) where.push(`n.note_date <= ${p.add(q.to)}::date`);
  if (q.kind) where.push(`n.note_kind = ${p.add(q.kind)}`);
  if (q.search?.trim()) {
    const pattern = p.add(`%${q.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    where.push(`(e.employee_code ilike ${pattern} or e.display_name ilike ${pattern} or ${SUBMITTER_SQL} ilike ${pattern})`);
  }
  const base = `select ${NOTE_COLUMNS}, e.employee_code as "employeeCode", e.display_name as "employeeName"
                  from employee_note n join employee e on e.company_id = n.company_id and e.id = n.employee_id
                 where ${where.join(' and ')}`;
  const sql = q.status ? `select r.* from (${base}) r where r.status = ${p.add(q.status)}` : base;
  const page = await pageOf(db, sql, p.values, '"noteDate" desc, "createdAt" desc, id', { page: q.page ?? 1, pageSize: q.pageSize ?? 25 }, NOTE_LIST_CAP);
  return {
    ...page,
    filters: { from: q.from ?? null, to: q.to ?? null, kind: q.kind ?? null, status: q.status ?? null, search: q.search?.trim() || null },
    ownRecordExcluded: grant.linkedEmployeeId !== null,
    items: page.items.map(({ employeeCode, employeeName, employeeId, ...rest }) => ({ ...rest, employee: { id: employeeId, employeeCode, displayName: employeeName } })),
  };
}

/** One note as the register shows it (after a void). */
async function noteView(db: Queryable, grant: AccessGrant, noteId: string) {
  const row = (
    await db.query(
      `select ${NOTE_COLUMNS}, e.employee_code as "employeeCode", e.display_name as "employeeName"
         from employee_note n join employee e on e.company_id = n.company_id and e.id = n.employee_id where n.company_id = $1 and n.id = $2`,
      [grant.companyId, noteId],
    )
  ).rows[0] as Record<string, unknown> | undefined;
  if (!row) throw notFound();
  const { employeeCode, employeeName, employeeId, ...rest } = row;
  return { ...rest, employee: { id: employeeId, employeeCode, displayName: employeeName } };
}

/**
 * Withdraws a note with a reason (DF08): the note stays, marked VOIDED, and the void is its own append-only row. A note outside
 * the caller's scope reads as missing; one's own record is refused; a corrected note is not voided (its correction is), and a note
 * is voided once. The audit names the note and its type, never the text or the reason.
 */
export async function voidNote(tx: Queryable, grant: AccessGrant, noteId: string, reason: string) {
  const text = reason.trim();
  if (!text) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the note is voided');
  const note = (
    await tx.query<{ employee_id: string; note_kind: string }>(`select employee_id, note_kind from employee_note where company_id = $1 and id = $2 for update`, [grant.companyId, noteId])
  ).rows[0];
  if (!note) throw notFound();
  await assertInScope(tx, grant, note.employee_id);
  assertNotSelf(grant, note.employee_id);
  const voided = await tx.query(`select 1 from employee_note_void where company_id = $1 and note_id = $2`, [grant.companyId, noteId]);
  if ((voided.rowCount ?? 0) > 0) throw new HttpError(409, 'ALREADY_VOIDED', 'That note was already voided');
  const corrected = await tx.query(`select 1 from employee_note where company_id = $1 and supersedes_note_id = $2`, [grant.companyId, noteId]);
  if ((corrected.rowCount ?? 0) > 0) throw new HttpError(409, 'ALREADY_SUPERSEDED', 'That note was corrected; void its correction instead');
  await tx.query(
    `insert into employee_note_void (company_id, note_id, employee_id, reason, voided_by, acting_assignment_id) values ($1, $2, $3, $4, $5, $6)`,
    [grant.companyId, noteId, note.employee_id, text, grant.userId, grant.assignmentId],
  );
  await audit(tx, actorOf(grant), 'employee_note', noteId, 'VOID', { restricted: { status: 'ACTIVE' } }, { restricted: { employeeId: note.employee_id, kind: note.note_kind, status: 'VOIDED' } });
  return noteView(tx, grant, noteId);
}

/**
 * A note's supporting file for download: in scope, never one's own record, and only once the malware scan released it (FR-106).
 * The caller records the read (FR-057) once the bytes are in hand.
 */
export async function noteAttachment(db: Queryable, grant: AccessGrant, noteId: string) {
  const row = (
    await db.query<{ employee_id: string; content_reference: string | null; media_type: string | null; file_name: string | null; scan_state: string | null; attachment_id: string | null }>(
      `select n.employee_id, a.id as attachment_id, a.content_reference, a.media_type, a.file_name, a.scan_state
         from employee_note n left join attachment a on a.company_id = n.company_id and a.id = n.attachment_id
        where n.company_id = $1 and n.id = $2`,
      [grant.companyId, noteId],
    )
  ).rows[0];
  if (!row) throw notFound();
  await assertInScope(db, grant, row.employee_id);
  assertNotSelf(grant, row.employee_id);
  if (!row.attachment_id || !row.content_reference || !row.media_type) throw new HttpError(404, 'NO_ATTACHMENT', 'This note has no supporting file');
  if (row.scan_state !== 'CLEAN') throw new HttpError(409, 'FILE_NOT_RELEASED', 'This file has not been released by the malware scan', { scanState: row.scan_state });
  return { employeeId: row.employee_id, contentReference: row.content_reference, mediaType: row.media_type, fileName: row.file_name };
}
