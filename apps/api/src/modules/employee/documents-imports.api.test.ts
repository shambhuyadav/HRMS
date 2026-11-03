// Employee documents (FR-010, DF02) and bulk employee import (FR-009, DF09) at the API surface, including the caller's
// own import batches and resuming one held for the malware scan (FR-106). Synthetic data; file bytes are synthetic
// PDF/PNG headers and synthetic CSV rows.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor as Actor } from '../../test/harness.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { EMPLOYEE_IMPORT_COLUMNS } from './imports.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: Actor;
let hrDocs: Actor;
let hrDocsB: Actor;
let employeeId: string;

const one = <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => h.one<T>(sql, params);
const pdf = Buffer.from('%PDF-1.4\n% synthetic test document\n%%EOF\n');
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
const csv = (...rows: string[]) => [EMPLOYEE_IMPORT_COLUMNS.join(','), ...rows].join('\r\n');

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hrDocs = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.upload.document', 'document.read.document'] });
  hrDocsB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: ['document.upload.document', 'document.read.document'] });
  employeeId = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
});

afterAll(async () => {
  await h?.stop();
});

describe('employee documents (FR-010, DF02)', () => {
  it('needs the confidential document grant: default HR duties cannot upload or list', async () => {
    const upload = await h.call(hr, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'id.pdf', contentBase64: b64(pdf) });
    expect(upload.statusCode).toBe(403);
    expect((await h.call(hr, 'GET', `/v1/employees/${employeeId}/documents`)).statusCode).toBe(403);
  });

  it('stores a document by content, lists metadata only and audits each content read', async () => {
    const upload = await h.call(hrDocs, 'POST', `/v1/employees/${employeeId}/documents`, {
      documentType: 'GENERAL',
      fileName: 'offer-letter.pdf',
      contentBase64: b64(pdf),
      expiresOn: '2026-02-01',
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json()).toMatchObject({ mediaType: 'application/pdf', byteSize: pdf.length });
    const docId = upload.json().id;

    const list = await h.call(hrDocs, 'GET', `/v1/employees/${employeeId}/documents`);
    expect(list.statusCode).toBe(200);
    const [item] = list.json().items;
    expect(item).toMatchObject({ id: docId, documentType: 'GENERAL', fileName: 'offer-letter.pdf', expiresOn: '2026-02-01', expired: true });
    expect(JSON.stringify(list.json())).not.toMatch(/content|reference|checksum/i);

    const content = await h.call(hrDocs, 'GET', `/v1/documents/${docId}/content`);
    expect(content.statusCode).toBe(200);
    expect(content.headers['content-type']).toBe('application/pdf');
    expect(content.headers['cache-control']).toBe('no-store');
    expect(content.rawPayload.equals(pdf)).toBe(true);
    const reads = await one<{ n: string }>(`select count(*) as n from audit_event where record_key = $1 and action = 'READ_CONTENT'`, [docId]);
    expect(Number(reads.n)).toBe(1);
  });

  it('rejects files whose content is not PDF, JPEG or PNG regardless of name', async () => {
    const res = await h.call(hrDocs, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'fake.pdf', contentBase64: b64('<html>not a pdf</html>') });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('UNSUPPORTED_FILE');
    const badType = await h.call(hrDocs, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'PASSPORT', fileName: 'x.pdf', contentBase64: b64(pdf) });
    expect(badType.json().error).toBe('INVALID_REFERENCE');
  });

  it('hides another company’s employee and document as not found', async () => {
    const docId = (await h.call(hrDocs, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'b.pdf', contentBase64: b64(pdf) })).json().id;
    expect((await h.call(hrDocsB, 'GET', `/v1/employees/${employeeId}/documents`)).statusCode).toBe(404);
    expect((await h.call(hrDocsB, 'GET', `/v1/documents/${docId}/content`)).statusCode).toBe(404);
  });
});

describe('bulk employee import (FR-009, DF09)', () => {
  const countOf = async (codes: string[]) => Number((await one<{ n: string }>(`select count(*) as n from employee where company_id = $1 and employee_code = any($2)`, [A.id, codes])).n);

  it('rejects the whole batch when any row has an identity, reference or value error (DF09), creating nobody', async () => {
    const good1 = uniq('IMP');
    const good2 = uniq('IMP');
    const file = csv(
      `${good1},Synthetic One,${good1.toLowerCase()}@example.test,2026-03-02,PERMANENT,ENG,HQ,DEV,`,
      `${good2},"Synthetic, Two",,2026-03-02,intern,eng,hq,dev,`,
      `${good1},Duplicate In File,,2026-03-02,PERMANENT,ENG,HQ,DEV,`,
      `${uniq('IMP')},Unknown Dept,,2026-03-02,PERMANENT,NOPE,HQ,DEV,`,
      `${uniq('IMP')},Bad Date,,2026-02-30,PERMANENT,ENG,HQ,DEV,`,
      `${uniq('IMP')},Extra Cell,,2026-03-02,PERMANENT,ENG,HQ,DEV,,1990-05-17`,
    );
    const upload = await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'joiners.csv', contentBase64: b64(file), idempotencyKey: uniq('import-key-') });
    expect(upload.statusCode).toBe(201);
    const job = upload.json();
    expect(job).toMatchObject({ state: 'REJECTED', template: 'EMPLOYEE_ONBOARDING_V1', rowCount: 6, acceptedCount: 0, rejectedCount: 6 });
    expect(job.rows.map((r: { state: string; errorCode: string | null }) => [r.state, r.errorCode])).toEqual([
      ['REJECTED', 'BATCH_REJECTED'],
      ['REJECTED', 'BATCH_REJECTED'],
      ['REJECTED', 'DUPLICATE'],
      ['REJECTED', 'UNKNOWN_DEPARTMENT'],
      ['REJECTED', 'INVALID_JOINING_DATE'],
      ['REJECTED', 'COLUMN_COUNT'],
    ]);
    expect((await h.call(hr, 'POST', `/v1/employees/imports/${job.id}/commit`)).statusCode).toBe(409);
    expect(await countOf([good1, good2])).toBe(0);
  });

  it('a clean batch previews without creating anything, then commits every row with its audit', async () => {
    const good1 = uniq('IMP');
    const good2 = uniq('IMP');
    const file = csv(`${good1},Synthetic One,${good1.toLowerCase()}@example.test,2026-03-02,PERMANENT,ENG,HQ,DEV,`, `${good2},"Synthetic, Two",,2026-03-02,intern,eng,hq,dev,`);
    const key = uniq('import-key-');
    const job = (await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'joiners.csv', contentBase64: b64(file), idempotencyKey: key })).json();
    expect(job).toMatchObject({ state: 'PREVIEWED', rowCount: 2 });
    expect(job.rows.map((r: { state: string }) => r.state)).toEqual(['VALID', 'VALID']);
    expect(await countOf([good1, good2])).toBe(0);
    // The stored raw file is confidential (it may carry cells nobody should import).
    const stored = await one<{ classification: string }>(`select a.classification from import_job j join attachment a on a.id = j.attachment_id where j.id = $1`, [job.id]);
    expect(stored.classification).toBe('CONFIDENTIAL');

    // Same submitter and key: the same job (200), not a second import.
    const again = await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'joiners.csv', contentBase64: b64(file), idempotencyKey: key });
    expect(again.statusCode).toBe(200);
    expect(again.json().id).toBe(job.id);

    const commit = await h.call(hr, 'POST', `/v1/employees/imports/${job.id}/commit`);
    expect(commit.json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 2, rejectedCount: 0 });
    const created = await h.db.query<{ display_name: string }>(`select display_name from employee where company_id = $1 and employee_code = any($2)`, [A.id, [good1, good2]]);
    expect(created.rows.map((r) => r.display_name).sort()).toEqual(['Synthetic One', 'Synthetic, Two']);
    const audits = await one<{ n: string }>(
      `select count(*) as n from audit_event where resource_code = 'employee' and action = 'CREATE' and record_key in (select id from employee where company_id = $1 and employee_code = any($2))`,
      [A.id, [good1, good2]],
    );
    expect(Number(audits.n)).toBe(2);
    expect((await h.call(hr, 'POST', `/v1/employees/imports/${job.id}/commit`)).json().acceptedCount).toBe(2); // idempotent
    expect((await h.call(hr, 'POST', `/v1/employees/imports/${job.id}/cancel`)).statusCode).toBe(409);
  });

  it('a row that became invalid after preview rejects the batch at commit and nothing is created', async () => {
    const late = uniq('IMP');
    const other = uniq('IMP');
    const file = csv(`${late},Late Conflict,,2026-03-02,PERMANENT,ENG,HQ,DEV,`, `${other},Innocent Row,,2026-03-02,PERMANENT,ENG,HQ,DEV,`);
    const job = (await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'late.csv', contentBase64: b64(file), idempotencyKey: uniq('import-key-') })).json();
    expect(job.state).toBe('PREVIEWED');
    expect((await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { employeeCode: late }))).statusCode).toBe(201);
    const commit = (await h.call(hr, 'POST', `/v1/employees/imports/${job.id}/commit`)).json();
    expect(commit).toMatchObject({ state: 'REJECTED', acceptedCount: 0, rejectedCount: 2 });
    expect(commit.rows.map((r: { errorCode: string }) => r.errorCode)).toEqual(['DUPLICATE', 'BATCH_REJECTED']);
    expect(await countOf([other])).toBe(0);
  });

  it('a job belongs to its submitter: another HR user cannot see, commit, cancel or reuse its key (sec-2)', async () => {
    const key = uniq('import-key-');
    const job = (await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'mine.csv', contentBase64: b64(csv(`${uniq('IMP')},Mine,,2026-03-02,PERMANENT,ENG,HQ,DEV,`)), idempotencyKey: key })).json();
    const colleague = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await h.call(colleague, 'GET', `/v1/employees/imports/${job.id}`)).statusCode).toBe(404);
    expect((await h.call(colleague, 'POST', `/v1/employees/imports/${job.id}/commit`)).statusCode).toBe(404);
    expect((await h.call(colleague, 'POST', `/v1/employees/imports/${job.id}/cancel`)).statusCode).toBe(404);
    const reuse = await h.call(colleague, 'POST', '/v1/employees/imports', { fileName: 'theirs.csv', contentBase64: b64(csv(`${uniq('IMP')},Theirs,,2026-03-02,PERMANENT,ENG,HQ,DEV,`)), idempotencyKey: key });
    expect(reuse.statusCode).toBe(409);
    expect(reuse.json().error).toBe('IDEMPOTENCY_KEY_IN_USE');
    expect(JSON.stringify(reuse.json())).not.toContain('mine.csv');
  });

  it('enforces the DF09 batch limits (10,000 rows)', async () => {
    const rows = Array.from({ length: 10_001 }, (_, i) => `R${i},Row ${i},,2026-03-02,PERMANENT,ENG,HQ,DEV,`);
    const res = await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'big.csv', contentBase64: b64(csv(...rows)), idempotencyKey: uniq('import-key-') });
    expect(res.json().error).toBe('TOO_MANY_ROWS');
  });

  it('rejects a wrong header, personal columns and callers without the import duty', async () => {
    const withPersonal = `${EMPLOYEE_IMPORT_COLUMNS.join(',')},dateOfBirth\r\nX1,Name,,2026-03-02,PERMANENT,ENG,HQ,DEV,,1990-01-01`;
    const res = await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'p.csv', contentBase64: b64(withPersonal), idempotencyKey: uniq('import-key-') });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('INVALID_HEADER');
    const manager = await h.actor(A, 'REPORTING_MANAGER');
    const denied = await h.call(manager, 'POST', '/v1/employees/imports', { fileName: 'a.csv', contentBase64: b64(csv()), idempotencyKey: uniq('import-key-') });
    expect(denied.statusCode).toBe(403);
  });

  it('cancels a previewed import and hides jobs across companies', async () => {
    const file = csv(`${uniq('IMP')},To Cancel,,2026-03-02,PERMANENT,ENG,HQ,DEV,`);
    const job = (await h.call(hr, 'POST', '/v1/employees/imports', { fileName: 'c.csv', contentBase64: b64(file), idempotencyKey: uniq('import-key-') })).json();
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    expect((await h.call(hrB, 'GET', `/v1/employees/imports/${job.id}`)).statusCode).toBe(404);
    expect((await h.call(hrB, 'POST', `/v1/employees/imports/${job.id}/commit`)).statusCode).toBe(404);
    expect((await h.call(hr, 'POST', `/v1/employees/imports/${job.id}/cancel`)).json().state).toBe('CANCELLED');
    expect((await h.call(hr, 'POST', `/v1/employees/imports/${job.id}/commit`)).statusCode).toBe(409);
  });
});

followUpSuite({
  path: '/v1/employees/imports',
  template: 'EMPLOYEE_ONBOARDING_V1',
  harness: () => h,
  company: () => A,
  submitter: () => h.actor(A, 'HR_ADMINISTRATOR'),
  denied: async () => [await h.actor(A, 'REPORTING_MANAGER'), await h.actor(A, 'AUDITOR')],
  validFile: async () => ({ text: csv(`${uniq('IMP')},Synthetic Joiner,,2026-03-02,PERMANENT,ENG,HQ,DEV,`, `${uniq('IMP')},Synthetic Second Joiner,,2026-03-02,PERMANENT,ENG,HQ,DEV,`), rows: 2 }),
});
