// The employee notes register as a file (BRD coverage CL-040 "Exit Notes/Remarks/Warnings", follow-up; FR-018 restricted notes;
// FR-056 to FR-058 reports; BR-026 row scope; BR-045 confidential derived values; DF02; DF09; decided under owner delegation,
// 6 Nov 2026; built 11 Nov 2026). Generated in the background by the report framework (FR-056) as CSV or XLSX with its filter context.
//
// - The rows are the register's (notes.ts noteRegisterConditions, the predicate GET /employee-notes pages through): the notes about the
//   employees in the requester's row scope, the requester's own record left out, filtered by the register's date range (`from`, `to`,
//   the note date), type (`category`: one note type, NOTE_KINDS; the report framework's record filter for a list's category), status
//   (`status`: ACTIVE, SUPERSEDED or VOIDED, as the register derives it) and search (`search`: employee name or code, or the
//   submitter's name). Same order as the register: newest note date first.
// - Columns: the employee, the note's type (an absconding warning says so, 0283), its date, status, who submitted it (their employee
//   name, else their account), when it was recorded (company time) and whether it was entered on screen or uploaded. The note text,
//   a void's reason and a supporting file are never in the file: it says which notes exist about whom, not what they say.
// - Its right is employee_note.export.restricted (0283), the confidential export right of reports derived from restricted notes:
//   ceiling only for the HR Administrator, approved per assignment, never a default duty. Reading the register does not open it.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import type { ReportDefinition, ReportFilters } from '../report/catalogue.js';
import { NOTE_KINDS, NOTE_STATUS_SQL, NOTE_STATUSES, NOTE_SUBMITTER_SQL, type NoteKind, type NoteStatus, noteRegisterConditions } from './notes.js';

/** Each note type in words (the register screen's labels). */
const KIND_LABEL: Readonly<Record<NoteKind, string>> = {
  APPRECIATION: 'Appreciation',
  EXIT_NOTE: 'Exit note',
  OFFER_REJECTION: 'Offer rejection',
  PIP: 'Performance improvement plan (PIP)',
  REMARK: 'Remark',
  WARNING: 'Warning',
  NOTE: 'Note',
};
const STATUS_LABEL: Readonly<Record<NoteStatus, string>> = { ACTIVE: 'Active', SUPERSEDED: 'Corrected by a later note', VOIDED: 'Voided' };

/** A fixed label as an SQL literal (the labels above are this module's constants, never input). */
const literal = (text: string) => `'${text.replace(/'/g, "''")}'`;
const TYPE_SQL = `case when n.note_kind = 'WARNING' and n.warning_category = 'ABSCONDING' then 'Absconding warning'
                       ${NOTE_KINDS.map((k) => `when n.note_kind = ${literal(k)} then ${literal(KIND_LABEL[k])}`).join(' ')} else n.note_kind end`;
const STATUS_TEXT_SQL = `case ${NOTE_STATUS_SQL} ${NOTE_STATUSES.map((s) => `when ${literal(s)} then ${literal(STATUS_LABEL[s])}`).join(' ')} end`;

function requireOneOf(value: string | undefined, allowed: readonly string[], field: string, what: string): void {
  if (value !== undefined && !allowed.includes(value)) throw new HttpError(422, 'INVALID_FILTER', `The ${what} is one of ${allowed.join(', ')}`, { field });
}

export async function noteRegisterExportRows(db: Queryable, grant: AccessGrant, f: ReportFilters): Promise<Record<string, unknown>[]> {
  const p = new SqlParams();
  const where = noteRegisterConditions(grant, { from: f.from, to: f.to, kind: f.category as NoteKind | undefined, status: f.status as NoteStatus | undefined, search: f.search }, p);
  return (
    await db.query(
      `select e.employee_code, e.display_name, ${TYPE_SQL} as note_type, to_char(n.note_date, 'YYYY-MM-DD') as note_date, ${STATUS_TEXT_SQL} as status,
              ${NOTE_SUBMITTER_SQL} as submitted_by, to_char(n.created_at at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI') as recorded_at,
              case n.source when 'IMPORT' then 'Bulk upload' else 'Entered on screen' end as source
         from employee_note n
         join employee e on e.company_id = n.company_id and e.id = n.employee_id
         join company c on c.id = n.company_id
        where ${where.join(' and ')}
        order by n.note_date desc, n.created_at desc, n.id`,
      p.values,
    )
  ).rows;
}

export const NOTES_REGISTER_REPORTS: Record<string, ReportDefinition> = {
  EMPLOYEE_NOTES_REGISTER: {
    code: 'EMPLOYEE_NOTES_REGISTER',
    title: 'Employee notes register',
    module: 'lifecycle',
    resource: 'employee_note',
    fieldGroup: 'restricted',
    requiresPeriod: false,
    xlsx: true,
    // The register's filters: the period is optional, as on the register.
    employeeFilters: ['search'],
    statusFilter: true,
    recordFilters: ['category'],
    checkFilters(f: ReportFilters) {
      requireOneOf(f.category, NOTE_KINDS, 'category', 'note type (category)');
      requireOneOf(f.status, NOTE_STATUSES, 'status', 'note status');
    },
    columns: [
      { key: 'employee_code', header: 'Employee code' },
      { key: 'display_name', header: 'Name' },
      { key: 'note_type', header: 'Type' },
      { key: 'note_date', header: 'Note date' },
      { key: 'status', header: 'Status' },
      { key: 'submitted_by', header: 'Submitted by' },
      { key: 'recorded_at', header: 'Recorded (company time)' },
      { key: 'source', header: 'Source' },
    ],
    rows: noteRegisterExportRows,
  },
};
