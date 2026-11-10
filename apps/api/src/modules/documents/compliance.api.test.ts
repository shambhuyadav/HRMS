// Mandatory document types and the employee document compliance report (BRD coverage CL-150 "Employee Document Compliance" under
// FR-056 to FR-058; FR-010; BR-026 scope and filters; BR-045 confidential derived values; DF02; migration 0261). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { EICAR_TEST_STRING } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hrDocs: TestActor;
let hrDocsEng: TestActor;
let verifier: TestActor;
let employeeRole: TestActor;
let secondLocation: string;
let today: string;
const emp: Record<string, { id: string; code: string }> = {};

const DOCS: PermissionKey[] = ['document.upload.document', 'document.read.document', 'document_compliance.export.document'];
const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`, 'latin1').toString('base64');
const plusDays = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

async function report(a: TestActor, filters: object) {
  const requested = await h.call(a, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_DOCUMENT_COMPLIANCE', filters });
  expect(requested.statusCode, requested.body).toBe(202);
  await processReportQueue(h.pool);
  const file = await h.call(a, 'GET', `/v1/reports/${requested.json().id}/download`);
  expect(file.statusCode, file.body).toBe(200);
  const [header, ...rows] = csvTable(file.body).trimEnd().split('\r\n').filter(Boolean).map(cells);
  return rows.map((row) => Object.fromEntries(header!.map((column, i) => [column, row[i]!])));
}

async function person(key: string, opts: { departmentId?: string; locationId?: string; employmentType?: string; status?: string } = {}) {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { displayName: `Synthetic ${key}`, ...opts }));
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { id: string; employeeCode: string };
  await h.setStatus(A, body.id, opts.status ?? 'ACTIVE_CONFIRMED');
  emp[key] = { id: body.id, code: body.employeeCode };
}

async function upload(key: string, documentType: string, opts: { expiresOn?: string; content?: string } = {}) {
  const res = await h.call(hrDocs, 'POST', `/v1/employees/${emp[key]!.id}/documents`, {
    documentType,
    fileName: `${documentType.toLowerCase()}.pdf`,
    contentBase64: pdf(opts.content ?? `synthetic ${key} ${documentType}`),
    ...(opts.expiresOn ? { expiresOn: opts.expiresOn } : {}),
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; scanState: string };
}

const require_ = (a: TestActor, body: object) => h.call(a, 'POST', '/v1/document-requirements', body);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hrDocs = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCS });
  hrDocsEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCS, departmentFilter: A.dept });
  verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.read.document', 'document.verify.document'] });
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  for (const [code, label] of [
    ['PAN', 'PAN card'],
    ['AADHAAR', 'Aadhaar card'],
    ['OFFER_ACCEPTANCE', 'Signed offer'],
    ['VISA', 'Visa'],
  ]) {
    await h.db.query(`insert into reference_value (company_id, category, code, label, active, created_by) values ($1, 'DOCUMENT_TYPE', $2, $3, true, $4)`, [A.id, code, label, SYSTEM_ACTOR_ID]);
  }
  secondLocation = (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, 'Synthetic Branch', true) returning id`, [A.id, uniq('L2').toUpperCase().replace(/[^A-Z0-9_-]/g, '')])).id;
  await person('E1 Compliant');
  await person('E2 Rejected Expired');
  await person('E3 Intern', { departmentId: A.financeDept, locationId: secondLocation, employmentType: 'INTERN' });
  await person('E4 Quarantined', { departmentId: A.financeDept });
  await person('E5 Separated', { status: 'INACTIVE_SEPARATED' });
  employeeRole = await h.actor(A, 'EMPLOYEE', { employeeId: emp['E1 Compliant']!.id });
  // Documents: E1 holds both; E2's PAN is rejected and its Aadhaar expired; E3 holds a PAN still waiting for verification; E4's
  // PAN file was quarantined by the malware scan; E5 holds nothing.
  await upload('E1 Compliant', 'PAN');
  await upload('E1 Compliant', 'AADHAAR', { expiresOn: plusDays(400) });
  const rejected = await upload('E2 Rejected Expired', 'PAN');
  expect((await h.call(verifier, 'POST', `/v1/documents/${rejected.id}/verification`, { decision: 'REJECTED', note: 'Synthetic: unreadable scan' })).statusCode).toBe(200);
  await upload('E2 Rejected Expired', 'AADHAAR', { expiresOn: plusDays(-1) });
  await upload('E3 Intern', 'PAN');
  expect((await upload('E4 Quarantined', 'PAN', { content: EICAR_TEST_STRING })).scanState).toBe('QUARANTINED');
  await upload('E4 Quarantined', 'AADHAAR');
}, 300_000);

afterAll(async () => {
  await h?.stop();
});

describe('mandatory document types (CL-150; FR-010; dated configuration)', () => {
  it('FR-056: HR keeps the mandatory types as dated configuration from today on, per company or per employment type; never back-dated, overlapping or deleted', async () => {
    const opened = await h.call(hr, 'GET', '/v1/document-requirements');
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json().options.documentTypes.map((o: { code: string }) => o.code)).toEqual(expect.arrayContaining(['PAN', 'AADHAAR', 'GENERAL']));
    expect(opened.json().options.employmentTypes.map((o: { code: string }) => o.code)).toEqual(expect.arrayContaining(['PERMANENT', 'INTERN']));
    const pan = await require_(hr, { documentType: 'PAN', effectiveFrom: today, reason: 'Synthetic: tax identity for payroll' });
    expect(pan.statusCode, pan.body).toBe(201);
    expect(pan.json()).toMatchObject({ documentType: { code: 'PAN', label: 'PAN card' }, employmentType: null, effectiveFrom: today, effectiveTo: null, inForceToday: true });
    expect((await require_(hr, { documentType: 'AADHAAR', effectiveFrom: today, reason: 'Synthetic: identity' })).statusCode).toBe(201);
    const intern = await require_(hr, { documentType: 'OFFER_ACCEPTANCE', employmentType: 'INTERN', effectiveFrom: today, reason: 'Synthetic: intern agreement' });
    expect(intern.json()).toMatchObject({ employmentType: { code: 'INTERN' } });
    // The same type again over an overlapping period, a past start and unknown codes are refused.
    expect((await require_(hr, { documentType: 'PAN', effectiveFrom: plusDays(30), reason: 'Synthetic' })).json().error).toBe('OVERLAPPING_REQUIREMENT');
    expect((await require_(hr, { documentType: 'VISA', effectiveFrom: plusDays(-1), reason: 'Synthetic' })).json().error).toBe('EFFECTIVE_DATE_IN_PAST');
    expect((await require_(hr, { documentType: 'NOPE', effectiveFrom: today, reason: 'Synthetic' })).json().error).toBe('INVALID_REFERENCE');
    expect((await require_(hr, { documentType: 'VISA', employmentType: 'ROBOT', effectiveFrom: today, reason: 'Synthetic' })).json().error).toBe('INVALID_REFERENCE');
    // A requirement withdrawn on the day it starts is never in force; ending is recorded once, with a reason and the version.
    const visa = (await require_(hr, { documentType: 'VISA', effectiveFrom: today, reason: 'Synthetic: travel role' })).json();
    expect((await h.call(hr, 'POST', `/v1/document-requirements/${visa.id}/end`, { effectiveTo: today, reason: 'Synthetic: entered by mistake', expectedVersion: 9 })).json().error).toBe('VERSION_CONFLICT');
    const ended = await h.call(hr, 'POST', `/v1/document-requirements/${visa.id}/end`, { effectiveTo: today, reason: 'Synthetic: entered by mistake', expectedVersion: 1 });
    expect(ended.json()).toMatchObject({ effectiveTo: today, inForceToday: false, endReason: 'Synthetic: entered by mistake', version: 2 });
    expect((await h.call(hr, 'POST', `/v1/document-requirements/${visa.id}/end`, { effectiveTo: today, reason: 'again', expectedVersion: 2 })).json().error).toBe('ALREADY_ENDED');
    await expect(h.db.query(`delete from document_requirement where id = $1`, [visa.id])).rejects.toThrow(/never deleted/);
    await expect(h.db.query(`update document_requirement set reason = 'changed' where id = $1`, [pan.json().id])).rejects.toThrow(/only the end/);
    await expect(h.db.query(`update document_requirement set end_reason = 'changed' where id = $1`, [visa.id])).rejects.toThrow(/final/);
    // Audited, with the reason.
    expect((await h.db.query<{ action: string }>(`select action from audit_event where record_key = $1 order by occurred_at`, [visa.id])).rows.map((r) => r.action)).toEqual(['CREATE', 'END']);
  });

  it('BR-026: only an unrestricted company-scope HR assignment changes the setting; other roles cannot read it', async () => {
    expect((await require_(hrDocsEng, { documentType: 'GENERAL', effectiveFrom: today, reason: 'Synthetic' })).statusCode).toBe(403);
    expect((await require_(employeeRole, { documentType: 'GENERAL', effectiveFrom: today, reason: 'Synthetic' })).statusCode).toBe(403);
    expect((await h.call(employeeRole, 'GET', '/v1/document-requirements')).statusCode).toBe(403);
    const manager = await h.actor(A, 'REPORTING_MANAGER');
    expect((await h.call(manager, 'GET', '/v1/document-requirements')).statusCode).toBe(403);
  });
});

describe('employee document compliance report (CL-150; FR-056; BR-045)', () => {
  it('FR-056 BR-026: lists each active employee missing a mandatory type, with the missing types and counts; held, rejected, expired and quarantined documents count as the rule says', async () => {
    const rows = await report(hrDocs, {});
    const by = Object.fromEntries(rows.map((r) => [r['Name'], r]));
    expect(Object.keys(by).sort()).toEqual(['Synthetic E2 Rejected Expired', 'Synthetic E3 Intern', 'Synthetic E4 Quarantined']);
    // A rejected PAN and an expired Aadhaar are missing; both are mandatory for a permanent employee.
    expect(by['Synthetic E2 Rejected Expired']).toMatchObject({ 'Missing document types': 'Aadhaar card; PAN card', 'Missing count': '2', 'Mandatory types': '2', Department: 'ENG', Location: 'HQ' });
    // An intern also needs the signed offer; a PAN waiting for verification counts as supplied.
    expect(by['Synthetic E3 Intern']).toMatchObject({ 'Missing document types': 'Aadhaar card; Signed offer', 'Missing count': '2', 'Mandatory types': '3', Department: 'FIN', Location: 'Synthetic Branch' });
    // A file the malware scan quarantined is not a document held.
    expect(by['Synthetic E4 Quarantined']).toMatchObject({ 'Missing document types': 'PAN card', 'Missing count': '1', 'Mandatory types': '2' });
    // The withdrawn VISA requirement is never in force, so nobody misses it.
    expect(rows.some((r) => r['Missing document types']!.includes('Visa'))).toBe(false);
    // The counts reconcile: every row's missing count is the number of types it names.
    for (const r of rows) expect(r['Missing document types']!.split('; ').length).toBe(Number(r['Missing count']));
  });

  it('FR-056: filters by department, location and employee status; the as-on date reads the rules of that day; a period start is refused', async () => {
    expect((await report(hrDocs, { departmentId: A.financeDept })).map((r) => r['Name']).sort()).toEqual(['Synthetic E3 Intern', 'Synthetic E4 Quarantined']);
    expect((await report(hrDocs, { locationId: secondLocation })).map((r) => r['Name'])).toEqual(['Synthetic E3 Intern']);
    expect((await report(hrDocs, { status: 'INACTIVE_SEPARATED' })).map((r) => [r['Name'], r['Missing count']])).toEqual([['Synthetic E5 Separated', '2']]);
    expect((await report(hrDocs, { statusGroup: 'LEFT' })).map((r) => r['Name'])).toEqual(['Synthetic E5 Separated']);
    // Before the requirements started, nobody was missing anything.
    expect(await report(hrDocs, { to: plusDays(-1) })).toEqual([]);
    expect((await h.call(hrDocs, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_DOCUMENT_COMPLIANCE', filters: { from: today, to: today } })).json().error).toBe('FILTER_NOT_SUPPORTED');
  });

  it('BR-045 BR-044 BR-026: the report needs its own confidential export right and keeps to the requester\'s row scope', async () => {
    expect((await report(hrDocsEng, {})).map((r) => r['Name'])).toEqual(['Synthetic E2 Rejected Expired']);
    for (const a of [hr, verifier, employeeRole]) {
      const refused = await h.call(a, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_DOCUMENT_COMPLIANCE', filters: {} });
      expect(refused.statusCode).toBe(403);
      const catalogue = (await h.call(a, 'GET', '/v1/reports/catalogue')).json().items as { code: string }[];
      expect(catalogue.some((r) => r.code === 'EMPLOYEE_DOCUMENT_COMPLIANCE')).toBe(false);
    }
    expect(((await h.call(hrDocs, 'GET', '/v1/reports/catalogue')).json().items as { code: string }[]).some((r) => r.code === 'EMPLOYEE_DOCUMENT_COMPLIANCE')).toBe(true);
  });
});
