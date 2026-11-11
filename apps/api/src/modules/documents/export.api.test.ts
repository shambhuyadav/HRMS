// Export employee documents to a ZIP (BRD coverage CL-027 "Export Employee Documents to ZIP", under FR-010; FR-057 attributable reads;
// FR-106 released files only; BR-026 row scope; BR-045 export eligibility; DF02; migration 0281). Synthetic data only: the files are
// synthetic PDFs, and the flagged one carries the EICAR test string (storage/scan.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { MAX_EXPORT_FILES } from './export.js';

let h: Harness;
let A: Company;
let B: Company;
let exporter: TestActor;
let readOnly: TestActor;
let exportOnly: TestActor;
let engExporter: TestActor;
let exporterB: TestActor;
let employee: TestActor;
let eng1: { id: string; code: string };
let eng2: { id: string; code: string };
let fin1: { id: string; code: string };
let bulky: { id: string; code: string };
const content = new Map<string, Buffer>();

const EXPORT: PermissionKey[] = ['document.upload.document', 'document.read.document', 'document.export.document'];
const pdf = (note: string) => Buffer.from(`%PDF-1.4\n% synthetic ${note}\n%%EOF\n`);
const infected = () => Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF\n`, 'latin1');

/** The entries of a ZIP of stored entries, read from its central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extra = zip.readUInt16LE(at + 30);
    const comment = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    out.set(name, zip.subarray(start, start + size));
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

const upload = async (employeeId: string, documentType: string, bytes: Buffer, fileName = 'synthetic.pdf') => {
  const res = await h.call(exporter, 'POST', `/v1/employees/${employeeId}/documents`, { documentType, fileName, contentBase64: bytes.toString('base64') });
  expect(res.statusCode, res.body).toBe(201);
  content.set(res.json().id, bytes);
  return res.json() as { id: string; scanState: string };
};
const summary = (a: TestActor, query = '') => h.call(a, 'GET', `/v1/documents/export/summary${query}`);
const exportZip = (a: TestActor, query = '') => h.app.inject({ method: 'GET', url: `/v1/documents/export${query}`, headers: headersOf(a) });
let headersOf: (a: TestActor) => Record<string, string>;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  const { ASSIGNMENT_HEADER, COMPANY_HEADER } = await import('../../http/context.js');
  headersOf = (a) => ({ authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: a.company.id, [ASSIGNMENT_HEADER]: a.assignment });
  exporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT });
  readOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.read.document'] });
  exportOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.export.document'] });
  engExporter = await h.actor(A, 'HR_ADMINISTRATOR', { extra: EXPORT, departmentFilter: A.dept });
  exporterB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: EXPORT });
  const person = async (departmentId: string) => {
    const body = h.newEmployeeBody(A, { departmentId });
    const res = await h.call(exporter, 'POST', '/v1/employees', body);
    expect(res.statusCode, res.body).toBe(201);
    await h.setStatus(A, res.json().id, 'ACTIVE_CONFIRMED');
    return { id: res.json().id as string, code: String(body.employeeCode).toUpperCase() };
  };
  eng1 = await person(A.dept);
  eng2 = await person(A.dept);
  fin1 = await person(A.financeDept);
  bulky = await person(A.financeDept);
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: eng1.id });
  const admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  for (const [code, label] of [['PASSPORT', 'Passport (synthetic)'], ['OFFER_LETTER', 'Offer letter (synthetic)']]) {
    expect((await h.call(admin, 'POST', '/v1/reference-admin/values', { category: 'DOCUMENT_TYPE', code, label })).statusCode).toBe(201);
  }
  await upload(eng1.id, 'GENERAL', pdf('eng1 general'), ' ..Résumé final.PDF');
  await upload(eng1.id, 'PASSPORT', pdf('eng1 passport'));
  await upload(eng2.id, 'GENERAL', pdf('eng2 general'));
  expect((await upload(eng2.id, 'PASSPORT', infected())).scanState).toBe('QUARANTINED');
  await upload(fin1.id, 'GENERAL', pdf('fin1 general'));
});

afterAll(async () => {
  await h?.stop();
});

describe('CL-027 export employee documents to a ZIP', () => {
  it('CL-027 FR-106 FR-057: a department\'s released files in one archive with its export log; a quarantined file is left out and counted; logged and audited per document', async () => {
    const s = await summary(exporter, `?departmentId=${A.dept}`);
    expect(s.statusCode, s.body).toBe(200);
    expect(s.json()).toMatchObject({ documents: 3, employees: 2, withheld: 1, withinLimits: true, limits: { files: 200, bytes: 50 * 1024 * 1024 }, filters: { department: { id: A.dept, code: 'ENG' } } });

    const res = await exportZip(exporter, `?departmentId=${A.dept}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="employee-documents-\d{4}-\d{2}-\d{2}\.zip"/);
    const files = unzip(res.rawPayload);
    const names = [...files.keys()];
    expect(names[0]).toBe('export-log.csv');
    expect(names.slice(1)).toHaveLength(3);
    for (const name of names.slice(1)) expect(name.startsWith(`${eng1.code}/`) || name.startsWith(`${eng2.code}/`)).toBe(true);
    // Each file is the uploaded bytes; an unsafe original name is made safe inside the archive.
    const released = (await h.db.query<{ id: string; employee_id: string }>(`select d.id, d.employee_id from employee_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id where d.company_id = $1 and a.scan_state = 'CLEAN' and d.employee_id = any($2::uuid[])`, [A.id, [eng1.id, eng2.id]])).rows;
    for (const doc of released) {
      const entry = names.find((n) => n.includes(`-${doc.id.slice(0, 8)}-`))!;
      expect(files.get(entry)!.equals(content.get(doc.id)!)).toBe(true);
    }
    expect(names.some((n) => n.startsWith(`${eng1.code}/GENERAL-`) && n.endsWith('-Résumé final.pdf'))).toBe(true);
    const log = files.get('export-log.csv')!.toString('utf8');
    expect(log).toContain('"Employee documents export"');
    expect(log).toContain('"Not released by the malware scan (left out)","1"');
    expect(log).toContain(`"${eng1.code}"`);
    expect(log).not.toContain('EICAR');

    const exportId = String(res.headers['x-export-id']);
    const row = await h.one<{ exported_by: string; department_id: string; document_count: number; employee_count: number; withheld_count: number }>(
      `select exported_by, department_id, document_count, employee_count, withheld_count from document_export where id = $1`,
      [exportId],
    );
    expect(row).toEqual({ exported_by: exporter.user, department_id: A.dept, document_count: 3, employee_count: 2, withheld_count: 1 });
    const audits = (await h.db.query<{ resource_code: string; action: string; after_values: Record<string, Record<string, unknown>> }>(
      `select resource_code, action, after_values from audit_event where company_id = $1 and (record_key = $2 or after_values -> 'document' ->> 'exportId' = $2::text)`,
      [A.id, exportId],
    )).rows;
    expect(audits.filter((a) => a.resource_code === 'document_export' && a.action === 'EXPORT')).toHaveLength(1);
    expect(audits.filter((a) => a.resource_code === 'employee_document' && a.action === 'EXPORT_CONTENT')).toHaveLength(3);
    // The audit holds counts and ids, never a file name.
    expect(JSON.stringify(audits)).not.toContain('Résumé');

    const listed = await h.call(exporter, 'GET', '/v1/documents/exports');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json().items[0]).toMatchObject({ id: exportId, documentCount: 3, employeeCount: 2, withheldCount: 1, department: { code: 'ENG' }, documentType: null, employee: null });
  });

  it('CL-027: filters by document type and by employee; refuses unknown filters, an employee outside the scope and an empty selection', async () => {
    expect((await summary(exporter, '?documentType=passport')).json()).toMatchObject({ documents: 1, employees: 1, withheld: 1 });
    expect((await summary(exporter, `?employeeId=${fin1.id}`)).json()).toMatchObject({ documents: 1, employees: 1, withheld: 0 });
    // By code too, as the screen types it; an unknown code and one outside the scope read alike.
    expect((await summary(exporter, `?employeeCode=${fin1.code.toLowerCase()}`)).json()).toMatchObject({ documents: 1, filters: { employee: { id: fin1.id, code: fin1.code } } });
    expect((await summary(exporter, '?employeeCode=NO-SUCH-CODE')).statusCode).toBe(404);
    expect((await summary(engExporter, `?employeeCode=${fin1.code}`)).statusCode).toBe(404);
    // The screen's choices.
    const options = (await h.call(exporter, 'GET', '/v1/documents/export/options')).json() as { departments: { code: string }[]; documentTypes: { code: string }[]; limits: unknown };
    expect(options.departments.map((d) => d.code).sort()).toEqual(['ENG', 'FIN']);
    expect(options.documentTypes.map((t) => t.code)).toEqual(expect.arrayContaining(['GENERAL', 'PASSPORT', 'OFFER_LETTER']));
    expect(options.limits).toEqual({ files: 200, bytes: 50 * 1024 * 1024 });
    expect((await h.call(readOnly, 'GET', '/v1/documents/export/options')).statusCode).toBe(403);
    const one = await exportZip(exporter, `?employeeId=${fin1.id}&documentType=GENERAL`);
    expect(one.statusCode).toBe(200);
    expect([...unzip(one.rawPayload).keys()].filter((n) => n !== 'export-log.csv').map((n) => n.split('/')[0])).toEqual([fin1.code]);

    expect((await summary(exporter, '?documentType=NO_SUCH_TYPE')).json()).toMatchObject({ error: 'UNKNOWN_DOCUMENT_TYPE' });
    expect((await summary(exporter, `?departmentId=${B.dept}`)).json()).toMatchObject({ error: 'UNKNOWN_DEPARTMENT' });
    const empty = await exportZip(exporter, '?documentType=OFFER_LETTER');
    expect([empty.statusCode, empty.json().error]).toEqual([422, 'NOTHING_TO_EXPORT']);
    // Only a quarantined file matches: nothing is served.
    const flagged = await exportZip(exporter, `?employeeId=${eng2.id}&documentType=PASSPORT`);
    expect([flagged.statusCode, flagged.json().error, flagged.json().details]).toEqual([422, 'NOTHING_TO_EXPORT', { withheld: 1 }]);
    // An employee outside the department filter reads as missing.
    expect((await exportZip(engExporter, `?employeeId=${fin1.id}`)).statusCode).toBe(404);
  });

  it('CL-027 BR-045 DF02: the export right and the single download\'s read right are both needed; row scope and the company bound every archive', async () => {
    for (const a of [readOnly, exportOnly, employee]) {
      expect((await summary(a)).statusCode).toBe(403);
      expect((await exportZip(a)).statusCode).toBe(403);
    }
    expect((await h.call(readOnly, 'GET', '/v1/documents/exports')).statusCode).toBe(403);
    // A refused export is recorded as a denial, never as an export.
    expect((await h.one<{ n: number }>(`select count(*)::int as n from document_export where acting_assignment_id = any($1::uuid[])`, [[readOnly.assignment, exportOnly.assignment, employee.assignment]])).n).toBe(0);

    // A department-filtered exporter gets only that department's employees, whatever the filters say.
    const scoped = await exportZip(engExporter);
    expect(scoped.statusCode).toBe(200);
    const codes = new Set([...unzip(scoped.rawPayload).keys()].filter((n) => n !== 'export-log.csv').map((n) => n.split('/')[0]));
    expect([...codes].sort()).toEqual([eng1.code, eng2.code].sort());
    expect((await summary(engExporter, `?departmentId=${A.financeDept}`)).json()).toMatchObject({ documents: 0, withheld: 0 });
    // Company B sees none of company A's documents or exports.
    expect((await exportZip(exporterB)).json().error).toBe('NOTHING_TO_EXPORT');
    expect((await h.call(exporterB, 'GET', '/v1/documents/exports')).json().items).toEqual([]);
    expect((await exportZip(exporterB, `?employeeId=${eng1.id}`)).statusCode).toBe(404);

    // The export log (security review, 11 Nov 2026): an export that names no one (by department or type) is listed to a company-wide
    // viewer and to its own exporter, never to another viewer with a narrower scope.
    const log = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/documents/exports')).json().items as { exportedBy: string; employee: unknown }[]).filter((x) => x.employee === null);
    expect((await log(exporter)).some((x) => x.exportedBy === exporter.user)).toBe(true);
    const engViewOfOthers = (await log(engExporter)).filter((x) => x.exportedBy !== engExporter.user);
    expect(engViewOfOthers).toEqual([]);
    expect((await log(engExporter)).some((x) => x.exportedBy === engExporter.user)).toBe(true);
  });

  it('CL-027: a selection over the bound (200 files or 50 MB) is refused with its counts, never cut short, and records nothing', async () => {
    const template = await h.one<{ content_reference: string; checksum: string; type_id: string }>(
      `select a.content_reference, a.checksum, d.document_type_id as type_id from employee_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where d.employee_id = $1 limit 1`,
      [fin1.id],
    );
    const clone = async (n: number, byteSize: number) =>
      h.db.query(
        `with a as (
           insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size, scan_state, scan_checked_at, created_by, updated_by)
           select $1, $2, $3, $4, 'application/pdf', $5, 'CONFIDENTIAL', 'bulk-' || g || '.pdf', $6, 'CLEAN', now(), $2, $2 from generate_series(1, $7::int) g
           returning id
         )
         insert into employee_document (company_id, employee_id, document_type_id, attachment_id, created_by, updated_by) select $1, $3, $8, a.id, $2, $2 from a`,
        [A.id, exporter.user, bulky.id, template.content_reference, template.checksum, byteSize, n, template.type_id],
      );
    const before = (await h.one<{ n: number }>(`select count(*)::int as n from document_export where company_id = $1`, [A.id])).n;
    await clone(MAX_EXPORT_FILES + 1, 100);
    const many = await exportZip(exporter, `?employeeId=${bulky.id}`);
    expect([many.statusCode, many.json().error]).toEqual([422, 'EXPORT_TOO_LARGE']);
    expect(many.json().details).toMatchObject({ documents: MAX_EXPORT_FILES + 1, maxFiles: 200 });
    expect((await summary(exporter, `?employeeId=${bulky.id}`)).json()).toMatchObject({ documents: MAX_EXPORT_FILES + 1, withinLimits: false });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from document_export where company_id = $1`, [A.id])).n).toBe(before);

    // Under the file bound but over 50 MB of content.
    expect((await exportZip(exporter, `?employeeId=${fin1.id}`)).statusCode).toBe(200);
    const fin1Heavy = await h.db.query(
      `with a as (
         insert into attachment (company_id, owner_user_id, employee_id, content_reference, media_type, checksum, classification, file_name, byte_size, scan_state, scan_checked_at, created_by, updated_by)
         select $1, $2, $3, $4, 'application/pdf', $5, 'CONFIDENTIAL', 'heavy-' || g || '.pdf', 10485760, 'CLEAN', now(), $2, $2 from generate_series(1, 6) g
         returning id
       )
       insert into employee_document (company_id, employee_id, document_type_id, attachment_id, created_by, updated_by) select $1, $3, $6, a.id, $2, $2 from a`,
      [A.id, exporter.user, fin1.id, template.content_reference, template.checksum, template.type_id],
    );
    expect(fin1Heavy.rowCount).toBe(6);
    const big = await exportZip(exporter, `?employeeId=${fin1.id}`);
    expect([big.statusCode, big.json().error]).toEqual([422, 'EXPORT_TOO_LARGE']);
    expect(big.json().details.bytes).toBeGreaterThan(50 * 1024 * 1024);
  });
});
