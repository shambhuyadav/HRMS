// Export employee documents to a ZIP (BRD coverage CL-027 "Export Employee Documents to ZIP", under FR-010 documents; FR-057 attributable
// reads; FR-106 released files only; BR-026 row scope; BR-045 export eligibility; DF02; migration 0281; built 11 Nov 2026 from the
// reference system's screen: filters department, document type and employee, a ZIP of the files; decided under owner delegation,
// 6 Nov 2026).
//
// Rules, the single download's own (employee/documents.ts GET /documents/:id/content) applied to every file:
//   * Rights: document.export.document (the bulk export right, confidential, ceiling only) and document.read.document (what the single
//     download needs) on the same selected assignment; both are re-checked inside the export's transaction.
//   * Row scope: only employees in the assignment's row scope (employeeScopePredicate, as every list and report).
//   * Released files only: a file is in the archive only when the malware scan released it (CLEAN). Matching files still waiting for
//     the scan, quarantined or failed are left out and counted ("withheld"), never served.
//   * Filters: the department of the employee's latest assignment begun on or before today (so a former employee's documents are found
//     under the department they left from), one document type (by code), one employee. Each optional.
//   * Bounded and synchronous: the codebase has no job pattern that produces a stored file for download (bulk jobs keep counts only),
//     so the archive is built in the request and never stored, at most MAX_EXPORT_FILES files and MAX_EXPORT_BYTES of content. A larger
//     selection is refused with its counts (EXPORT_TOO_LARGE): narrow the filters and export in parts. Nothing is cut short silently.
//   * Logged and audited, in the transaction that reads the files: one document_export row (who, when, filters, counts), one audit
//     record of the export (counts and filter ids, never file names or content) and one EXPORT_CONTENT record per document carried, so
//     each document's own trail shows it left in an archive. If anything fails before the answer is built, nothing is recorded.
//   * The archive holds the files under <employee code>/ and export-log.csv: what the archive is (company, who, when, scope, filters,
//     counts) and one line per file. Text cells are written through the FR-065 formula guard.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Paging } from '../../db/paging.js';
import { pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import { attachmentDisposition, type FileStore } from '../../storage/files.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { contextCsvLines, csvCell, fileContext } from '../report/context.js';
import { zipStored } from '../report/xlsx.js';

/** Technical bounds of one synchronous archive (not business rules): the files and the bytes of their content. */
export const MAX_EXPORT_FILES = 200;
export const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
/** Exports built at once by this server process; another request meanwhile is answered 429 EXPORT_BUSY. */
export const MAX_CONCURRENT_EXPORTS = 1;

export interface ExportFilters {
  departmentId?: string | undefined;
  documentType?: string | undefined;
  /** One employee, by id or by code (the screen types a code); someone outside the scope reads as missing either way. */
  employeeId?: string | undefined;
  employeeCode?: string | undefined;
}

interface Candidate {
  id: string;
  employee_id: string;
  employee_code: string;
  display_name: string;
  type_code: string;
  type_label: string;
  file_name: string | null;
  media_type: string;
  byte_size: string;
  scan_state: string | null;
  content_reference: string;
  uploaded_at: string;
  expires_on: string | null;
  verification_state: string;
}

interface ResolvedFilters {
  department: { id: string; code: string; name: string } | null;
  documentType: { id: string; code: string; label: string } | null;
  employee: { id: string; code: string; name: string } | null;
}

/** The filters as records of the company: an unknown department or type is refused; an employee outside the scope reads as missing. */
async function resolveFilters(db: Queryable, grant: AccessGrant, f: ExportFilters): Promise<ResolvedFilters> {
  const department = f.departmentId
    ? (await db.query<{ id: string; code: string; name: string }>(`select id, code, name from department where company_id = $1 and id = $2`, [grant.companyId, f.departmentId])).rows[0]
    : null;
  if (f.departmentId && !department) throw new HttpError(422, 'UNKNOWN_DEPARTMENT', 'There is no such department', { field: 'departmentId' });
  const documentType = f.documentType
    ? (await db.query<{ id: string; code: string; label: string }>(`select id, code, label from reference_value where company_id = $1 and category = 'DOCUMENT_TYPE' and code = $2`, [grant.companyId, f.documentType.toUpperCase()])).rows[0]
    : null;
  if (f.documentType && !documentType) throw new HttpError(422, 'UNKNOWN_DOCUMENT_TYPE', 'There is no such document type', { field: 'documentType' });
  let employee: ResolvedFilters['employee'] = null;
  if (f.employeeId || f.employeeCode) {
    const found = (
      await db.query<{ id: string; code: string; name: string }>(
        `select id, employee_code as code, display_name as name from employee where company_id = $1 and ($2::uuid is null or id = $2::uuid) and ($3::text is null or employee_code = $3)`,
        [grant.companyId, f.employeeId ?? null, f.employeeCode?.trim().toUpperCase() ?? null],
      )
    ).rows[0];
    if (!found || !(await canAccessEmployee(db, grant, found.id))) throw notFound();
    employee = found;
  }
  return { department: department ?? null, documentType: documentType ?? null, employee };
}

/** Every matching document of the employees in scope, released or not, by employee code, type and upload time. */
async function candidates(db: Queryable, grant: AccessGrant, r: ResolvedFilters): Promise<Candidate[]> {
  const p = new SqlParams();
  const company = `${p.add(grant.companyId)}::uuid`;
  const where = [employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, p)];
  if (r.employee) where.push(`e.id = ${p.add(r.employee.id)}::uuid`);
  if (r.documentType) where.push(`d.document_type_id = ${p.add(r.documentType.id)}::uuid`);
  if (r.department) {
    const day = `${p.add(grant.businessDate)}::date`;
    where.push(`(select a.department_id from employment_assignment a
                  where a.company_id = e.company_id and a.employee_id = e.id and a.effective_from <= ${day}
                  order by a.effective_from desc limit 1) = ${p.add(r.department.id)}::uuid`);
  }
  return (
    await db.query<Candidate>(
      `select d.id, e.id as employee_id, e.employee_code, e.display_name, t.code as type_code, t.label as type_label, a.file_name, a.media_type,
              a.byte_size::text as byte_size, a.scan_state, a.content_reference, to_char(d.created_at, 'YYYY-MM-DD') as uploaded_at,
              to_char(d.expires_on, 'YYYY-MM-DD') as expires_on, d.verification_state
         from employee_document d
         join employee e on e.company_id = d.company_id and e.id = d.employee_id
         join reference_value t on t.company_id = d.company_id and t.id = d.document_type_id
         join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where d.company_id = ${company} and ${where.join(' and ')}
        order by e.employee_code, t.code, d.created_at, d.id`,
      p.values,
    )
  ).rows;
}

/** What an export with these filters would hold now: counts only, the same selection the archive takes. */
export async function exportSummary(db: Queryable, grant: AccessGrant, f: ExportFilters) {
  const resolved = await resolveFilters(db, grant, f);
  const all = await candidates(db, grant, resolved);
  const released = all.filter((c) => c.scan_state === 'CLEAN');
  const bytes = released.reduce((n, c) => n + Number(c.byte_size), 0);
  return {
    filters: { department: resolved.department, documentType: resolved.documentType, employee: resolved.employee },
    documents: released.length,
    employees: new Set(released.map((c) => c.employee_id)).size,
    bytes,
    withheld: all.length - released.length,
    limits: { files: MAX_EXPORT_FILES, bytes: MAX_EXPORT_BYTES },
    withinLimits: released.length <= MAX_EXPORT_FILES && bytes <= MAX_EXPORT_BYTES,
  };
}

/** A file name safe inside the archive on every system: no path separators, control or reserved characters, at most 120 characters. */
function safePart(text: string, fallback: string): string {
  const cleaned = text
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

const EXTENSIONS: Readonly<Record<string, string>> = { 'application/pdf': '.pdf', 'image/jpeg': '.jpg', 'image/png': '.png' };

/** The entry name of one document: <employee code>/<type code>-<document id prefix>-<original name>, with the type's extension. */
function entryName(c: Candidate): string {
  const ext = EXTENSIONS[c.media_type] ?? '';
  const base = safePart((c.file_name ?? '').replace(/\.[A-Za-z0-9]{1,5}$/, ''), 'document');
  return `${safePart(c.employee_code, 'EMPLOYEE')}/${c.type_code}-${c.id.slice(0, 8)}-${base}${ext}`;
}

/**
 * Builds the archive under the caller's grants inside one transaction: both rights re-checked, the selection read, every released file
 * fetched, then the log row and the audit records written; refused whole when it is empty or over a bound.
 */
export async function exportDocuments(db: Database, files: FileStore, grant: AccessGrant, f: ExportFilters) {
  return withTransaction(db, async (tx) => {
    await reassertAccess(tx, grant, 'document', 'export', ['document']);
    await reassertAccess(tx, grant, 'document', 'read', ['document']);
    const resolved = await resolveFilters(tx, grant, f);
    const all = await candidates(tx, grant, resolved);
    const released = all.filter((c) => c.scan_state === 'CLEAN');
    const withheld = all.length - released.length;
    const bytes = released.reduce((n, c) => n + Number(c.byte_size), 0);
    if (released.length === 0) throw new HttpError(422, 'NOTHING_TO_EXPORT', 'No released document matches these filters', { withheld });
    if (released.length > MAX_EXPORT_FILES || bytes > MAX_EXPORT_BYTES) {
      throw new HttpError(422, 'EXPORT_TOO_LARGE', `One archive holds at most ${MAX_EXPORT_FILES} files and ${MAX_EXPORT_BYTES / (1024 * 1024)} MB; narrow the filters`, {
        documents: released.length,
        bytes,
        maxFiles: MAX_EXPORT_FILES,
        maxBytes: MAX_EXPORT_BYTES,
      });
    }
    const employees = new Set(released.map((c) => c.employee_id)).size;
    const entries: { name: string; data: Buffer }[] = [];
    for (const c of released) entries.push({ name: entryName(c), data: await files.get(c.content_reference) });

    const log = (
      await tx.query<{ id: string; at: string }>(
        `insert into document_export (company_id, exported_by, acting_assignment_id, department_id, document_type_id, employee_id, document_count, employee_count, byte_size, withheld_count)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id, exported_at::text as at`,
        [grant.companyId, grant.userId, grant.assignmentId, resolved.department?.id ?? null, resolved.documentType?.id ?? null, resolved.employee?.id ?? null, released.length, employees, bytes, withheld],
      )
    ).rows[0]!;
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'document_export',
      recordKey: log.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'EXPORT',
      after: {
        document: {
          departmentId: resolved.department?.id ?? null,
          documentType: resolved.documentType?.code ?? null,
          employeeId: resolved.employee?.id ?? null,
          documentCount: released.length,
          employeeCount: employees,
          byteSize: bytes,
          withheldCount: withheld,
        },
      },
    });
    // FR-057: each document carried is a read of confidential content, recorded on the document's own trail.
    for (const c of released) {
      await writeAudit(tx, {
        companyId: grant.companyId,
        resource: 'employee_document',
        recordKey: c.id,
        actorUserId: grant.userId,
        actingAssignmentId: grant.assignmentId,
        action: 'EXPORT_CONTENT',
        after: { document: { employeeId: c.employee_id, exportId: log.id } },
      });
    }

    const context = await fileContext(tx, grant, {
      title: 'Employee documents export',
      code: 'EMPLOYEE_DOCUMENTS_ZIP',
      filters: {
        ...(resolved.department ? { department: `${resolved.department.code} ${resolved.department.name}` } : {}),
        ...(resolved.documentType ? { documentType: `${resolved.documentType.code} ${resolved.documentType.label}` } : {}),
        ...(resolved.employee ? { employee: resolved.employee.code } : {}),
      },
      rowCount: released.length,
    });
    const exporter = (
      await tx.query<{ who: string }>(
        `select coalesce((select e.display_name from user_employee_link l join employee e on e.company_id = l.company_id and e.id = l.employee_id
                           where l.company_id = $1 and l.user_id = $2 order by l.effective_from desc limit 1),
                         (select account_key from user_account where id = $2)) as who`,
        [grant.companyId, grant.userId],
      )
    ).rows[0]!.who;
    const manifest = [
      ...contextCsvLines([
        ...context,
        ['Export id', log.id],
        ['Exported by', exporter],
        ['Employees', String(employees)],
        ['Not released by the malware scan (left out)', String(withheld)],
      ]),
      ['employee_code', 'employee_name', 'document_type', 'file_in_archive', 'original_file_name', 'uploaded_on', 'expires_on', 'verification', 'document_id'].map(csvCell).join(','),
      ...released.map((c, i) =>
        [c.employee_code, c.display_name, c.type_label, entries[i]!.name, c.file_name ?? '', c.uploaded_at, c.expires_on ?? '', c.verification_state, c.id].map(csvCell).join(','),
      ),
    ].join('\r\n');
    // A byte order mark first, so a spreadsheet opens the log as UTF-8 (built from its code point: no invisible character in this file).
    const archive = zipStored([{ name: 'export-log.csv', data: Buffer.from(`${String.fromCharCode(0xfeff)}${manifest}\r\n`, 'utf8') }, ...entries]);
    return { id: log.id, fileName: `employee-documents-${log.at.slice(0, 10)}.zip`, content: archive, count: released.length };
  });
}

/**
 * The export log (CL-027): the company's exports, newest first. An export about one employee is listed only while they are in scope;
 * an export by department or type names no one, so it is listed to an unrestricted company-wide viewer, and otherwise only to its own
 * exporter (a filtered viewer never sees what others exported beyond their scope).
 */
export async function listExports(db: Queryable, grant: AccessGrant, paging: Paging) {
  const p = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'x.company_id', employee: 'x.employee_id' }, p);
  const { departments, locations, employees } = grant.filters;
  const unrestricted = grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0 && grant.deniedScopes.length === 0;
  const broad = unrestricted ? 'true' : `x.exported_by = ${p.add(grant.userId)}::uuid`;
  return pageOf(
    db,
    `select x.id, x.exported_at as "exportedAt", x.document_count as "documentCount", x.employee_count as "employeeCount", x.byte_size::text as "byteSize",
            x.withheld_count as "withheldCount", x.exported_by as "exportedBy",
            coalesce((select se.display_name from user_employee_link l join employee se on se.company_id = l.company_id and se.id = l.employee_id
                       where l.company_id = x.company_id and l.user_id = x.exported_by order by l.effective_from desc limit 1),
                     (select u.account_key from user_account u where u.id = x.exported_by)) as "exportedByName",
            (select json_build_object('id', d.id, 'code', d.code, 'name', d.name) from department d where d.company_id = x.company_id and d.id = x.department_id) as department,
            (select json_build_object('code', t.code, 'label', t.label) from reference_value t where t.company_id = x.company_id and t.id = x.document_type_id) as "documentType",
            (select json_build_object('id', e.id, 'employeeCode', e.employee_code, 'displayName', e.display_name) from employee e where e.company_id = x.company_id and e.id = x.employee_id) as employee
       from document_export x
      where x.company_id = ${p.add(grant.companyId)}::uuid and ((x.employee_id is null and ${broad}) or (x.employee_id is not null and ${scope}))`,
    p.values,
    '"exportedAt" desc, id',
    { page: paging.page ?? 1, pageSize: paging.pageSize ?? 25 },
    100,
  );
}

/** The screen's choices: the company's departments and document types, inactive ones included (their documents stay on record). */
export async function exportOptions(db: Queryable, grant: AccessGrant) {
  const departments = await db.query(`select id, code, name, active from department where company_id = $1 order by name, code`, [grant.companyId]);
  const documentTypes = await db.query(`select code, label, active from reference_value where company_id = $1 and category = 'DOCUMENT_TYPE' order by label, code`, [grant.companyId]);
  return { departments: departments.rows, documentTypes: documentTypes.rows, limits: { files: MAX_EXPORT_FILES, bytes: MAX_EXPORT_BYTES } };
}

const uuid = { type: 'string', format: 'uuid' } as const;
const filterQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    departmentId: uuid,
    documentType: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,59}$' },
    employeeId: uuid,
    employeeCode: { type: 'string', minLength: 1, maxLength: 60 },
  },
} as const;

function sendArchive(reply: FastifyReply, archive: { fileName: string; content: Buffer }) {
  return reply
    .header('content-type', 'application/zip')
    .header('content-disposition', attachmentDisposition(archive.fileName, 'employee-documents.zip'))
    .header('cache-control', 'no-store')
    .header('x-content-type-options', 'nosniff')
    .send(archive.content);
}

export async function documentExportRoutes(app: FastifyInstance, opts: { db: Database; files: FileStore }): Promise<void> {
  const { db, files } = opts;
  // Both rights, each resolved for the selected assignment: the export right, then the single download's read right. They share the
  // assignment's scope and filters but may each carry their own DENY scopes (a role may read a department's files yet not bulk-export
  // them), so the grant used holds both rights' denied scopes: a row either right excludes stays out.
  const grants = async (request: FastifyRequest) => {
    const exportGrant = await requireAccess(db, request, 'document', 'export', ['document'], { requireAll: true });
    const readGrant = await requireAccess(db, request, 'document', 'read', ['document'], { requireAll: true });
    return { ...readGrant, deniedScopes: [...readGrant.deniedScopes, ...exportGrant.deniedScopes] };
  };
  // A ZIP holds up to MAX_EXPORT_BYTES in memory twice while it is built; on a small server one export at a time is the bound.
  let exportsRunning = 0;

  app.get('/documents/export/options', async (request) => exportOptions(db, await grants(request)));

  app.get('/documents/export/summary', { schema: { querystring: filterQuery } }, async (request) => exportSummary(db, await grants(request), request.query as ExportFilters));

  app.get('/documents/export', { schema: { querystring: filterQuery } }, async (request, reply) => {
    const grant = await grants(request);
    if (exportsRunning >= MAX_CONCURRENT_EXPORTS) throw new HttpError(429, 'EXPORT_BUSY', 'Another document export is being built; try again in a minute');
    exportsRunning += 1;
    try {
      const archive = await exportDocuments(db, files, grant, request.query as ExportFilters);
      reply.header('x-export-id', archive.id);
      return sendArchive(reply, archive);
    } finally {
      exportsRunning -= 1;
    }
  });

  app.get(
    '/documents/exports',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: { page: { type: 'integer', minimum: 1, default: 1 }, pageSize: { type: 'integer', enum: [25, 50, 100], default: 25 } },
        },
      },
    },
    async (request) => listExports(db, await requireAccess(db, request, 'document', 'export', ['document'], { requireAll: true }), request.query as Paging),
  );
}
