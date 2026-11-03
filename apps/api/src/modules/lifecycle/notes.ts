// Restricted HR notes, remarks and warnings (FR-018 "restrict notes and warnings to authorised HR roles"; reference
// menu "Exit Notes/Remarks/Warnings"). A confidential group of its own (employee_note.restricted), held only through
// an approved HR Administrator grant with row scope; never about one's own record. Notes are append-only: a
// correction is a new note that supersedes the earlier one.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { actorOf, assertInScope, assertNotSelf, audit } from './common.js';

export interface NoteInput {
  kind: 'NOTE' | 'REMARK' | 'WARNING';
  body: string;
  exitCaseId?: string | undefined;
  employeeProcessId?: string | undefined;
  supersedesNoteId?: string | undefined;
}

export async function addNote(tx: Queryable, grant: AccessGrant, employeeId: string, input: NoteInput) {
  await assertInScope(tx, grant, employeeId);
  assertNotSelf(grant, employeeId);
  // Linked records must belong to the same employee (composite keys enforce it; checked here for a clear error).
  const check = async (table: string, id: string | undefined) => {
    if (!id) return;
    const r = await tx.query(`select 1 from ${table} where company_id = $1 and id = $2 and employee_id = $3`, [grant.companyId, id, employeeId]);
    if ((r.rowCount ?? 0) === 0) throw new HttpError(422, 'INVALID_REFERENCE', 'The linked record does not belong to this employee');
  };
  await check('exit_case', input.exitCaseId);
  await check('employee_process', input.employeeProcessId);
  await check('employee_note', input.supersedesNoteId);
  if (input.supersedesNoteId) {
    const taken = await tx.query(`select 1 from employee_note where company_id = $1 and supersedes_note_id = $2`, [grant.companyId, input.supersedesNoteId]);
    if ((taken.rowCount ?? 0) > 0) throw new HttpError(409, 'ALREADY_SUPERSEDED', 'That note was already corrected');
  }
  const note = (
    await tx.query<{ id: string; created_at: Date }>(
      `insert into employee_note (company_id, employee_id, note_kind, body, exit_case_id, employee_process_id, supersedes_note_id, created_by, acting_assignment_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, created_at`,
      [grant.companyId, employeeId, input.kind, input.body.trim(), input.exitCaseId ?? null, input.employeeProcessId ?? null, input.supersedesNoteId ?? null, grant.userId, grant.assignmentId],
    )
  ).rows[0]!;
  // The note text stays in its confidential group; the audit carries the kind and links only.
  await audit(tx, actorOf(grant), 'employee_note', note.id, 'CREATE', null, {
    restricted: { employeeId, kind: input.kind, exitCaseId: input.exitCaseId ?? null, processId: input.employeeProcessId ?? null, supersedes: input.supersedesNoteId ?? null },
  });
  return { id: note.id, employeeId, kind: input.kind, createdAt: note.created_at };
}

/** Notes answered without page/pageSize (the list's first answer before it could page). */
export const NOTE_LIST_CAP = 500;

/** An employee's notes, newest first: one page (FR-056), or the first 500 without page/pageSize; `total` counts all. */
export async function listNotes(db: Queryable, grant: AccessGrant, employeeId: string, paging: Paging = {}) {
  await assertInScope(db, grant, employeeId);
  assertNotSelf(grant, employeeId);
  return pageOf(
    db,
    `select n.id, n.note_kind as kind, n.body, n.exit_case_id as "exitCaseId", n.employee_process_id as "processId", n.supersedes_note_id as "supersedesNoteId",
            (select s.id from employee_note s where s.company_id = n.company_id and s.supersedes_note_id = n.id) as "supersededByNoteId",
            n.created_by as "createdBy", n.created_at as "createdAt"
       from employee_note n where n.company_id = $1 and n.employee_id = $2`,
    [grant.companyId, employeeId],
    '"createdAt" desc, id',
    paging,
    NOTE_LIST_CAP,
  );
}
