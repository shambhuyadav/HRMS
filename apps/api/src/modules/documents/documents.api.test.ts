// Company policy documents and bulk document mapping (FR-010; DF02; DF09; FR-106; I-13), with discarding a staged
// file (DF08) and the caller's own mapping batches, including one held for the malware scan. Synthetic data only: file
// bytes are synthetic PDF headers; the "infected" files carry the EICAR anti-virus test string, assembled at run
// time (storage/scan.ts), never written literally.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { buildApp } from '../../app.js';
import { devTokenVerifier } from '../../auth/tokens.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { memoryFileStore } from '../../storage/files.js';
import { developmentScanner, EICAR_TEST_STRING, scanPendingAttachments } from '../../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../../test/harness.js';
import { DOCUMENT_MAPPING_COLUMNS } from './mapping.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let hrConfidential: TestActor;
let hrTeam: TestActor;
let employee: TestActor;
let payroll: TestActor;
let hrB: TestActor;
let docs: TestActor;
let docsOther: TestActor;
let employeeId: string;
let today: string;

const MARK = 'synthetic policy body';
const pdf = (text = MARK) => Buffer.from(`%PDF-1.4\n% ${text}\n%%EOF\n`).toString('base64');
const infected = () => Buffer.from(`%PDF-1.4\n% ${EICAR_TEST_STRING}\n%%EOF\n`, 'latin1').toString('base64');
const csv = (...rows: string[]) => Buffer.from([DOCUMENT_MAPPING_COLUMNS.join(','), ...rows].join('\r\n')).toString('base64');
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const CONFIDENTIAL: `${string}.${string}.${string}`[] = ['company_policy.read.confidential', 'company_policy.manage.confidential'];
const DOCS: `${string}.${string}.${string}`[] = ['document.upload.document', 'document.read.document'];

const publish = (a: TestActor, body: Record<string, unknown>) =>
  h.call(a, 'POST', '/v1/company-policies', { policyCode: uniq('POL_'), title: 'Synthetic policy', classification: 'OPERATIONAL', fileName: 'policy.pdf', contentBase64: pdf(), ...body });
const policyCodes = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/company-policies')).json().items as { policyCode: string }[]).map((p) => p.policyCode);
const documentCountOf = async (id: string) => (await h.one<{ n: number }>(`select count(*)::int as n from employee_document where company_id = $1 and employee_id = $2`, [A.id, id])).n;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hrConfidential = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIDENTIAL });
  hrTeam = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
  hrB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: CONFIDENTIAL });
  docs = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCS });
  docsOther = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCS });
  employeeId = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  employee = await h.actor(A, 'EMPLOYEE', { employeeId });
  payroll = await h.actor(A, 'PAYROLL_OPERATOR');
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
});

afterAll(async () => {
  await h?.stop();
});

describe('company policy documents (FR-010, DF02)', () => {
  it('publishes an operational policy any employee of the company reads, and no other company can download', async () => {
    const created = await publish(hr, { title: 'Synthetic leave handbook', expiresOn: addDays(today, 365) });
    expect(created.statusCode).toBe(201);
    const p = created.json();
    expect(p).toMatchObject({ classification: 'OPERATIONAL', versionNumber: 1, scanState: 'CLEAN', mediaType: 'application/pdf' });

    for (const reader of [employee, payroll, hr]) {
      const list = (await h.call(reader, 'GET', '/v1/company-policies')).json().items as Record<string, unknown>[];
      expect(list.find((i) => i.id === p.id)).toMatchObject({ title: 'Synthetic leave handbook', latestVersionNumber: 1, currentVersion: { id: p.versionId, versionNumber: 1, expired: false } });
      const content = await h.call(reader, 'GET', `/v1/company-policy-versions/${p.versionId}/content`);
      expect(content.statusCode).toBe(200);
      expect(content.body).toContain(MARK);
      expect(content.headers['cache-control']).toBe('no-store');
    }

    // FR-010 acceptance: another company's user (in their own company context) sees nothing and downloads nothing.
    expect(await policyCodes(hrB)).not.toContain(p.policyCode);
    expect((await h.call(hrB, 'GET', `/v1/company-policy-versions/${p.versionId}/content`)).statusCode).toBe(404);
    expect((await h.call(hrB, 'GET', `/v1/company-policies/${p.id}`)).statusCode).toBe(404);
    // Nor by claiming the other company's context.
    expect((await h.call({ ...hrB, company: A }, 'GET', `/v1/company-policy-versions/${p.versionId}/content`)).statusCode).toBe(403);

    // A narrower HR assignment cannot publish company policies; an employee cannot publish at all.
    expect((await publish(hrTeam, {})).statusCode).toBe(403);
    expect((await publish(employee, {})).statusCode).toBe(403);
    expect((await publish(hr, { expiresOn: addDays(today, -1) })).json().error).toBe('EXPIRY_IN_PAST');
    expect((await publish(hr, { policyCode: p.policyCode })).json().error).toBe('POLICY_EXISTS');
  });

  it('keeps every version and refuses changes or deletion of history', async () => {
    const p = (await publish(hr, { title: 'Synthetic travel policy' })).json();
    const v2 = await h.call(hr, 'POST', `/v1/company-policies/${p.id}/versions`, { fileName: 'policy-v2.pdf', contentBase64: pdf('second synthetic edition'), changeNote: 'Synthetic revision', expectedVersion: 1 });
    expect(v2.statusCode).toBe(201);
    expect(v2.json()).toMatchObject({ versionNumber: 2, version: 2, scanState: 'CLEAN' });
    // A stale view cannot publish over a newer version.
    expect((await h.call(hr, 'POST', `/v1/company-policies/${p.id}/versions`, { fileName: 'late.pdf', contentBase64: pdf(), expectedVersion: 1 })).json().error).toBe('STALE_VERSION');

    const detail = (await h.call(employee, 'GET', `/v1/company-policies/${p.id}`)).json();
    expect(detail.versions.map((v: { versionNumber: number }) => v.versionNumber)).toEqual([2, 1]);
    expect(detail.versions[0]).toMatchObject({ fileName: 'policy-v2.pdf', changeNote: 'Synthetic revision', scanState: 'CLEAN' });
    // The earlier version stays readable as history.
    expect((await h.call(employee, 'GET', `/v1/company-policy-versions/${p.versionId}/content`)).body).toContain(MARK);
    const listed = ((await h.call(employee, 'GET', '/v1/company-policies')).json().items as Record<string, unknown>[]).find((i) => i.id === p.id);
    expect(listed).toMatchObject({ latestVersionNumber: 2, currentVersion: { versionNumber: 2 } });

    // History cannot be rewritten or deleted, even directly in the database.
    await expect(h.db.query(`update company_policy_version set expires_on = '2030-01-01' where company_id = $1 and id = $2`, [A.id, p.versionId])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from company_policy_version where company_id = $1 and id = $2`, [A.id, p.versionId])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from company_policy where company_id = $1 and id = $2`, [A.id, p.id])).rejects.toMatchObject({ code: '23514' });

    // Audit records name the policy and versions, never the file content.
    const audit = await h.db.query<{ action: string; values: string }>(
      `select action, coalesce(after_values::text, '') || coalesce(before_values::text, '') as values from audit_event where company_id = $1 and resource_code = 'company_policy' and record_key = $2`,
      [A.id, p.id],
    );
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['CREATE', 'CREATE_VERSION', 'SCAN_RELEASED', 'READ_CONTENT']));
    for (const r of audit.rows) {
      expect(r.values).not.toContain(MARK);
      expect(r.values).not.toContain(pdf());
    }
  });

  it('shows a confidential policy only to holders of the confidential grant (DF02)', async () => {
    // An HR Administrator without the confidential grant cannot publish one.
    expect((await publish(hr, { classification: 'CONFIDENTIAL' })).statusCode).toBe(403);
    const p = (await publish(hrConfidential, { classification: 'CONFIDENTIAL', title: 'Synthetic restricted plan' })).json();
    expect(p).toMatchObject({ classification: 'CONFIDENTIAL', scanState: 'CLEAN' });

    expect(await policyCodes(hrConfidential)).toContain(p.policyCode);
    expect((await h.call(hrConfidential, 'GET', `/v1/company-policy-versions/${p.versionId}/content`)).statusCode).toBe(200);
    for (const reader of [employee, payroll, hr]) {
      expect(await policyCodes(reader)).not.toContain(p.policyCode);
      expect((await h.call(reader, 'GET', `/v1/company-policies/${p.id}`)).statusCode).toBe(404);
      expect((await h.call(reader, 'GET', `/v1/company-policy-versions/${p.versionId}/content`)).statusCode).toBe(404);
    }
    // The ordinary HR Administrator cannot add versions to it either; the refusals are recorded.
    expect((await h.call(hr, 'POST', `/v1/company-policies/${p.id}/versions`, { fileName: 'x.pdf', contentBase64: pdf(), expectedVersion: 1 })).statusCode).toBe(404);
    const denials = await h.one<{ n: number }>(
      `select count(*)::int as n from audit_event where company_id = $1 and resource_code = 'company_policy' and action = 'ACCESS_DENIED' and record_key = any($2)`,
      [A.id, [p.id, p.versionId]],
    );
    expect(denials.n).toBeGreaterThanOrEqual(7);

    // Reclassification needs the confidential grant both ways and applies to every version.
    const op = (await publish(hr, { title: 'Synthetic open policy' })).json();
    expect((await h.call(hr, 'PATCH', `/v1/company-policies/${op.id}`, { classification: 'CONFIDENTIAL', expectedVersion: 1 })).statusCode).toBe(403);
    const opened = await h.call(hrConfidential, 'PATCH', `/v1/company-policies/${p.id}`, { classification: 'OPERATIONAL', title: 'Synthetic plan (released)', expectedVersion: 1 });
    expect(opened.json()).toMatchObject({ classification: 'OPERATIONAL', title: 'Synthetic plan (released)', version: 2 });
    expect((await h.call(employee, 'GET', `/v1/company-policy-versions/${p.versionId}/content`)).statusCode).toBe(200);
  });

  it('serves only released files: a flagged upload stays quarantined', async () => {
    const p = await publish(hr, { contentBase64: infected() });
    expect(p.statusCode).toBe(201);
    expect(p.json().scanState).toBe('QUARANTINED');
    const res = await h.call(employee, 'GET', `/v1/company-policy-versions/${p.json().versionId}/content`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('FILE_NOT_RELEASED');
    const listed = ((await h.call(employee, 'GET', '/v1/company-policies')).json().items as Record<string, unknown>[]).find((i) => i.id === p.json().id);
    expect(listed).toMatchObject({ latestVersionNumber: 1, currentVersion: null });
    const scan = await h.one<{ after: string }>(`select after_values::text as after from audit_event where company_id = $1 and resource_code = 'company_policy' and record_key = $2 and action = 'SCAN_QUARANTINED'`, [
      A.id,
      p.json().id,
    ]);
    expect(scan.after).not.toContain('EICAR');
  });
});

describe('bulk document mapping (FR-010, DF09, I-13)', () => {
  const stage = (a: TestActor, fileName: string, contentBase64 = pdf(`synthetic ${fileName}`)) => h.call(a, 'POST', '/v1/documents/bulk-uploads', { fileName, contentBase64 });
  const submit = (a: TestActor, contentBase64: string) => h.call(a, 'POST', '/v1/documents/mapping-imports', { fileName: 'mapping.csv', contentBase64, idempotencyKey: uniq('map-key-') });
  const documentCount = async (id: string) => (await h.one<{ n: number }>(`select count(*)::int as n from employee_document where company_id = $1 and employee_id = $2`, [A.id, id])).n;

  it('reports unknown employee codes per row and assigns nothing; a clean batch maps every file', async () => {
    const first = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    const second = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    // Staging needs the confidential document grant.
    expect((await stage(hr, 'denied.pdf')).statusCode).toBe(403);
    const a = uniq('scan-a-') + '.pdf';
    const b = uniq('scan-b-') + '.pdf';
    const bad = uniq('scan-bad-') + '.pdf';
    expect((await stage(docs, a)).json()).toMatchObject({ scanState: 'CLEAN', state: 'UNMAPPED' });
    expect((await stage(docs, b)).json().scanState).toBe('CLEAN');
    expect((await stage(docs, bad, infected())).json().scanState).toBe('QUARANTINED');
    expect((await stage(docs, a)).json().error).toBe('FILE_NAME_IN_USE');

    const unknown = uniq('NOSUCH');
    const rejected = await submit(
      docs,
      csv(`${a},${first.employeeCode},GENERAL,`, `${b},${unknown},GENERAL,`, `${bad},${second.employeeCode},GENERAL,`, `missing.pdf,${second.employeeCode},GENERAL,`, `${a},${second.employeeCode},GENERAL,`),
    );
    expect(rejected.statusCode).toBe(201);
    expect(rejected.json()).toMatchObject({ state: 'REJECTED', template: 'DOCUMENT_MAPPING_V1', scanState: 'CLEAN' });
    expect(rejected.json().rows.map((r: { rowNumber: number; businessKey: string; errorCode: string }) => [r.rowNumber, r.businessKey, r.errorCode])).toEqual([
      [1, first.employeeCode, 'BATCH_REJECTED'],
      [2, unknown.toUpperCase(), 'UNKNOWN_EMPLOYEE'],
      [3, second.employeeCode, 'FILE_QUARANTINED'],
      [4, second.employeeCode, 'UNKNOWN_FILE'],
      [5, second.employeeCode, 'DUPLICATE_IN_BATCH'],
    ]);
    // Nothing assigned, nothing consumed.
    expect(await documentCount(first.id)).toBe(0);
    expect(await documentCount(second.id)).toBe(0);
    expect(((await h.call(docs, 'GET', '/v1/documents/bulk-uploads?state=UNMAPPED')).json().items as { fileName: string }[]).map((i) => i.fileName)).toEqual(expect.arrayContaining([a, b]));

    // A corrected file maps both documents in one batch; the job is its submitter's only.
    const ok = await submit(docs, csv(`${a},${first.employeeCode.toLowerCase()},GENERAL,${addDays(today, 30)}`, `${b},${second.employeeCode},GENERAL,`));
    expect(ok.json().state).toBe('PREVIEWED');
    expect(ok.json().rows.every((r: { state: string }) => r.state === 'VALID')).toBe(true);
    expect(await documentCount(first.id)).toBe(0); // preview applies nothing
    expect((await h.call(docsOther, 'POST', `/v1/documents/mapping-imports/${ok.json().id}/commit`)).statusCode).toBe(404);
    const committed = await h.call(docs, 'POST', `/v1/documents/mapping-imports/${ok.json().id}/commit`);
    expect(committed.json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 2 });

    const listed = (await h.call(docs, 'GET', `/v1/employees/${first.id}/documents`)).json().items;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ documentType: 'GENERAL', fileName: a, scanState: 'CLEAN', expiresOn: addDays(today, 30) });
    expect((await h.call(docs, 'GET', `/v1/documents/${listed[0].id}/content`)).body).toContain(`synthetic ${a}`);
    expect(await documentCount(second.id)).toBe(1);
    const mapped = (await h.call(docs, 'GET', '/v1/documents/bulk-uploads?state=MAPPED')).json().items as { fileName: string; mappedDocumentId: string }[];
    expect(mapped.find((m) => m.fileName === a)?.mappedDocumentId).toBe(listed[0].id);
    // A mapped file cannot be mapped again.
    const again = await submit(docs, csv(`${a},${second.employeeCode},GENERAL,`));
    expect(again.json().rows[0].errorCode).toBe('UNKNOWN_FILE');
    await expect(h.db.query(`update document_bulk_upload set state = 'UNMAPPED', mapped_document_id = null, mapped_at = null where company_id = $1 and file_name = $2`, [A.id, a])).rejects.toMatchObject({
      code: '23514',
    });
  });

  it('scans the mapping file before reading a row and needs the document grant', async () => {
    const flagged = await submit(docs, Buffer.from([DOCUMENT_MAPPING_COLUMNS.join(','), `x.pdf,${EICAR_TEST_STRING},GENERAL,`].join('\r\n'), 'latin1').toString('base64'));
    expect(flagged.statusCode).toBe(422);
    expect(flagged.json().error).toBe('FILE_QUARANTINED');
    expect((await submit(hr, csv('x.pdf,E1,GENERAL,'))).statusCode).toBe(403);
    expect((await submit(employee, csv('x.pdf,E1,GENERAL,'))).statusCode).toBe(403);
  });

  it('serves the published DOCUMENT_MAPPING_V1 template: exactly the header the upload accepts and no rows, under the mapping grants (DF09)', async () => {
    const res = await h.call(docs, 'GET', '/v1/documents/mapping-imports/template');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="DOCUMENT_MAPPING_V1.csv"');
    expect(res.body).toBe(`${DOCUMENT_MAPPING_COLUMNS.join(',')}\r\n`);
    // Round trip: the template with one valid synthetic row previews with the row valid.
    const target = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    const name = `${uniq('template-')}.pdf`;
    expect((await stage(docs, name)).json().scanState).toBe('CLEAN');
    const filled = await submit(docs, Buffer.from(`${res.body}${name},${target.employeeCode},GENERAL,`).toString('base64'));
    expect(filled.statusCode, filled.body).toBe(201);
    expect(filled.json()).toMatchObject({ state: 'PREVIEWED', template: 'DOCUMENT_MAPPING_V1', rowCount: 1, rows: [{ state: 'VALID' }] });
    expect((await h.call(docs, 'POST', `/v1/documents/mapping-imports/${filled.json().id}/cancel`)).json().state).toBe('CANCELLED');
    // Without the document upload grant (or the import duty) the template is refused like the upload.
    for (const a of [hr, employee, payroll]) expect((await h.call(a, 'GET', '/v1/documents/mapping-imports/template')).statusCode).toBe(403);
  });

  it('the uploader discards a staged file not yet mapped: kept on record, name freed, audited; a mapped file is never discarded (DF08)', async () => {
    const target = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    const flaggedName = uniq('discard-flagged-') + '.pdf';
    const flagged = (await stage(docs, flaggedName, infected())).json();
    expect(flagged).toMatchObject({ scanState: 'QUARANTINED', state: 'UNMAPPED' });
    const discard = (a: TestActor, id: string) => h.call(a, 'POST', `/v1/documents/bulk-uploads/${id}/discard`);

    // Only its uploader, with the document grant, can discard it; anyone else's staged file reads as missing.
    expect((await discard(docsOther, flagged.id)).statusCode).toBe(404);
    expect((await discard(employee, flagged.id)).statusCode).toBe(404);
    expect((await discard(hr, flagged.id)).statusCode).toBe(403);
    expect((await discard(payroll, flagged.id)).statusCode).toBe(403);
    const done = await discard(docs, flagged.id);
    expect(done.statusCode).toBe(200);
    expect(done.json()).toMatchObject({ id: flagged.id, fileName: flaggedName, state: 'DISCARDED', scanState: 'QUARANTINED', mappedDocumentId: null });
    expect(done.json().discardedAt).toBeTruthy();
    // Again: unchanged, audited once.
    expect((await discard(docs, flagged.id)).json()).toMatchObject({ state: 'DISCARDED', discardedAt: done.json().discardedAt });
    const audits = await h.db.query<{ action: string; before: unknown; after: unknown; values: string }>(
      `select action, before_values as before, after_values as after, after_values::text as values from audit_event where company_id = $1 and resource_code = 'document_bulk_upload' and record_key = $2 order by created_at`,
      [A.id, flagged.id],
    );
    expect(audits.rows.map((r) => r.action)).toEqual(['CREATE', 'SCAN_QUARANTINED', 'DISCARD']);
    expect(audits.rows[2]).toMatchObject({ before: { document: { state: 'UNMAPPED' } }, after: { document: { state: 'DISCARDED', fileName: flaggedName, scanState: 'QUARANTINED' } } });
    expect(audits.rows[2]!.values).not.toContain('EICAR');

    // Nothing is deleted: the row and its file stay on record, final.
    const kept = await h.one<{ state: string; scan_state: string; employee_id: string | null }>(
      `select u.state, a.scan_state, a.employee_id from document_bulk_upload u join attachment a on a.company_id = u.company_id and a.id = u.attachment_id where u.company_id = $1 and u.id = $2`,
      [A.id, flagged.id],
    );
    expect(kept).toEqual({ state: 'DISCARDED', scan_state: 'QUARANTINED', employee_id: null });
    await expect(h.db.query(`update document_bulk_upload set state = 'UNMAPPED', discarded_at = null where company_id = $1 and id = $2`, [A.id, flagged.id])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from document_bulk_upload where company_id = $1 and id = $2`, [A.id, flagged.id])).rejects.toMatchObject({ code: '23514' });

    // Listed apart from the files waiting to be mapped; its name can be staged again.
    const ids = async (state: string) => ((await h.call(docs, 'GET', `/v1/documents/bulk-uploads?state=${state}`)).json().items as { id: string }[]).map((i) => i.id);
    expect(await ids('DISCARDED')).toContain(flagged.id);
    expect(await ids('UNMAPPED')).not.toContain(flagged.id);
    const restaged = await stage(docs, flaggedName);
    expect(restaged.statusCode).toBe(201);
    expect(restaged.json().scanState).toBe('CLEAN');

    // A file discarded after its batch was previewed is not mapped: the commit rejects the batch and assigns nothing.
    const laterName = uniq('discard-later-') + '.pdf';
    const later = (await stage(docs, laterName)).json();
    const batch = (await submit(docs, csv(`${laterName},${target.employeeCode},GENERAL,`))).json();
    expect(batch.state).toBe('PREVIEWED');
    expect((await discard(docs, later.id)).json().state).toBe('DISCARDED');
    const committed = (await h.call(docs, 'POST', `/v1/documents/mapping-imports/${batch.id}/commit`)).json();
    expect(committed).toMatchObject({ state: 'REJECTED', rows: [{ errorCode: 'UNKNOWN_FILE' }] });
    expect(await documentCount(target.id)).toBe(0);

    // A mapped file is an employee document: never discarded.
    const mapped = (await submit(docs, csv(`${flaggedName},${target.employeeCode},GENERAL,`))).json();
    expect((await h.call(docs, 'POST', `/v1/documents/mapping-imports/${mapped.id}/commit`)).json().state).toBe('COMMITTED');
    const refused = await discard(docs, restaged.json().id);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('FILE_MAPPED');
    expect(await documentCount(target.id)).toBe(1);
    expect((await h.call(docs, 'GET', `/v1/documents/bulk-uploads?state=MAPPED`)).json().items.find((i: { id: string }) => i.id === restaged.json().id)).toMatchObject({ state: 'MAPPED', discardedAt: null });
  });

  it('lists the uploader’s own staged files newest first, a page at a time with the total; unpaged keeps the capped answer and adds the total (FR-056, I-43)', async () => {
    const stager = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCS });
    const other = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCS });
    const staged: string[] = [];
    for (let i = 0; i < 26; i += 1) {
      const res = await stage(stager, `page-${String(i).padStart(2, '0')}.pdf`);
      expect(res.statusCode).toBe(201);
      staged.push(res.json().id);
    }
    // One of them is discarded, and someone else's staged file is never listed.
    expect((await h.call(stager, 'POST', `/v1/documents/bulk-uploads/${staged[0]}/discard`)).statusCode).toBe(200);
    const othersFile = (await stage(other, 'page-other.pdf')).json().id as string;
    const list = (query: string) => h.call(stager, 'GET', `/v1/documents/bulk-uploads${query}`);
    const ids = (body: { items: { id: string }[] }) => body.items.map((i) => i.id);
    const newestFirst = [...staged].reverse();

    const first = (await list('?page=1&pageSize=25')).json();
    expect(first).toMatchObject({ total: 26, page: 1, pageSize: 25 });
    expect(ids(first)).toEqual(newestFirst.slice(0, 25));
    const second = (await list('?page=2&pageSize=25')).json();
    expect(second).toMatchObject({ total: 26, page: 2, pageSize: 25 });
    expect(ids(second)).toEqual(newestFirst.slice(25));
    expect((await list('?page=3')).json()).toMatchObject({ items: [], total: 26, page: 3, pageSize: 25 });
    // The state filter applies before paging, so the total counts only that state.
    const waiting = (await list('?state=UNMAPPED&page=1&pageSize=50')).json();
    expect(waiting).toMatchObject({ total: 25, page: 1, pageSize: 50 });
    expect(ids(waiting)).toEqual(newestFirst.slice(0, 25));
    // Without page or pageSize: every file up to the former cap, with the total and no paging fields.
    const unpaged = (await list('')).json();
    expect(Object.keys(unpaged).sort()).toEqual(['items', 'total']);
    expect(unpaged.total).toBe(26);
    expect(ids(unpaged)).toEqual(newestFirst);
    expect(JSON.stringify(unpaged)).not.toContain(othersFile);
    expect((await list('?pageSize=10')).statusCode).toBe(400);
    expect((await list('?page=0')).statusCode).toBe(400);
  });
});

describe('the caller’s mapping batches and a batch held for the malware scan (FR-010, FR-106, DF09)', () => {
  // A second app on the same database whose scanner always errors (an outage); its file store is shared with the scan
  // worker run below.
  const files = memoryFileStore();
  let outage: ReturnType<typeof buildApp>;
  const send = (a: TestActor, method: 'GET' | 'POST', url: string, payload?: object) =>
    outage.inject({ method, url, headers: { authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: a.assignment }, ...(payload ? { payload } : {}) });
  const submitHeld = (a: TestActor, contentBase64: string) => send(a, 'POST', '/v1/documents/mapping-imports', { fileName: 'held-mapping.csv', contentBase64, idempotencyKey: uniq('held-key-') });
  const list = async (a: TestActor, query = '') => h.call(a, 'GET', `/v1/documents/mapping-imports${query}`);

  beforeAll(() => {
    outage = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), files, scanner: { scan: async () => ({ verdict: 'ERROR' }) } });
  });
  afterAll(async () => {
    await outage?.close();
  });

  it('lists only the caller’s own batches, newest first and paged, without their rows', async () => {
    const lister = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCS });
    const other = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCS });
    const submitted: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const res = await h.call(lister, 'POST', '/v1/documents/mapping-imports', { fileName: `list-${i}.csv`, contentBase64: csv(`nosuch-${i}.pdf,E${i},GENERAL,`), idempotencyKey: uniq('list-key-') });
      expect(res.statusCode).toBe(201);
      submitted.push(res.json().id);
    }
    const otherJob = (await h.call(other, 'POST', '/v1/documents/mapping-imports', { fileName: 'other.csv', contentBase64: csv('x.pdf,E1,GENERAL,'), idempotencyKey: uniq('list-key-') })).json().id;

    const page = await list(lister);
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(page.json().items.map((j: { id: string }) => j.id)).toEqual([...submitted].reverse());
    expect(page.json().items[0]).toMatchObject({ state: 'REJECTED', template: 'DOCUMENT_MAPPING_V1', fileName: 'list-2.csv', rowCount: 1, rejectedCount: 1, scanState: 'CLEAN' });
    expect(Object.keys(page.json().items[0]).sort()).toEqual(['acceptedCount', 'createdAt', 'fileName', 'id', 'rejectedCount', 'rowCount', 'scanState', 'state', 'template', 'updatedAt']);
    expect(JSON.stringify(page.json())).not.toContain(otherJob);
    expect((await list(other)).json().items.map((j: { id: string }) => j.id)).toEqual([otherJob]);

    expect((await list(lister, '?state=REJECTED&pageSize=25&page=2')).json()).toMatchObject({ items: [], total: 3, page: 2 });
    expect((await list(lister, '?state=PREVIEWED')).json()).toMatchObject({ items: [], total: 0 });
    expect((await list(lister, '?pageSize=10')).statusCode).toBe(400);
    expect((await list(lister, '?state=DELETED')).statusCode).toBe(400);
    // The same grants as one batch: the import duty and the document grant.
    expect((await list(hr)).statusCode).toBe(403);
    expect((await list(employee)).statusCode).toBe(403);
    expect((await list(payroll)).statusCode).toBe(403);
  });

  it('a held batch is found again, resumed from its stored file once released, and committed; a flagged one is refused', async () => {
    const target = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    const name = uniq('held-doc-') + '.pdf';
    expect((await h.call(docs, 'POST', '/v1/documents/bulk-uploads', { fileName: name, contentBase64: pdf(`synthetic ${name}`) })).json().scanState).toBe('CLEAN');

    const held = await submitHeld(docs, csv(`${name},${target.employeeCode},GENERAL,`));
    expect(held.statusCode).toBe(202);
    const id = held.json().id as string;
    const listed = ((await list(docs, '?state=UPLOADED')).json().items as Record<string, unknown>[]).find((j) => j.id === id);
    expect(listed).toMatchObject({ state: 'UPLOADED', scanState: 'PENDING_SCAN', rowCount: null, fileName: 'held-mapping.csv' });

    // Only its submitter can resume it; while the scanner is still down it stays held and nothing is read.
    expect((await send(docsOther, 'POST', `/v1/documents/mapping-imports/${id}/resume`)).statusCode).toBe(404);
    expect((await send(hr, 'POST', `/v1/documents/mapping-imports/${id}/resume`)).statusCode).toBe(403);
    const still = await send(docs, 'POST', `/v1/documents/mapping-imports/${id}/resume`);
    expect(still.statusCode).toBe(202);
    expect(still.json()).toMatchObject({ id, state: 'UPLOADED', rows: [] });
    expect((await send(docs, 'POST', `/v1/documents/mapping-imports/${id}/commit`)).json().error).toBe('FILE_NOT_RELEASED');

    // The scan worker releases the file; resuming previews it (no second upload), again returns the same preview.
    await scanPendingAttachments(h.pool, files, developmentScanner(), A.id);
    const previewed = await send(docs, 'POST', `/v1/documents/mapping-imports/${id}/resume`);
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json()).toMatchObject({ id, state: 'PREVIEWED', scanState: 'CLEAN', rowCount: 1, rows: [{ businessKey: target.employeeCode, state: 'VALID' }] });
    expect((await send(docs, 'POST', `/v1/documents/mapping-imports/${id}/resume`)).json()).toMatchObject({ id, state: 'PREVIEWED' });
    expect(await documentCountOf(target.id)).toBe(0);
    expect((await send(docs, 'POST', `/v1/documents/mapping-imports/${id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 1 });
    expect(await documentCountOf(target.id)).toBe(1);
    expect(((await list(docs, '?state=COMMITTED')).json().items as { id: string }[]).map((j) => j.id)).toContain(id);
    const actions = await h.db.query<{ action: string }>(`select action from audit_event where company_id = $1 and resource_code = 'import_job' and record_key = $2 order by created_at`, [A.id, id]);
    expect(actions.rows.map((r) => r.action)).toEqual(['CREATE', 'PREVIEW', 'COMMIT']);

    // A held file the scan later flags: resuming refuses it, and the batch is closed without reading a row.
    const flagged = await submitHeld(docs, Buffer.from([DOCUMENT_MAPPING_COLUMNS.join(','), `${name},${EICAR_TEST_STRING},GENERAL,`].join('\r\n'), 'latin1').toString('base64'));
    expect(flagged.statusCode).toBe(202);
    await scanPendingAttachments(h.pool, files, developmentScanner(), A.id);
    const refused = await send(docs, 'POST', `/v1/documents/mapping-imports/${flagged.json().id}/resume`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('FILE_QUARANTINED');
    expect(((await list(docs)).json().items as Record<string, unknown>[]).find((j) => j.id === flagged.json().id)).toMatchObject({ state: 'REJECTED', scanState: 'QUARANTINED', rowCount: null });
  });
});
