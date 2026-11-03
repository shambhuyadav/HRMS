// Employee document files over HTTP (FR-010, FR-057, DF02): download headers for any stored file name (sec-1,
// web-7), the content-read audit written only once the bytes were fetched, recorded denials outside row scope
// (sec-5, FR-098) and the file-safety evidence the verification log claims (brd-9). Synthetic data only: the
// bytes are synthetic PDF, JPEG and PNG headers and every name is invented.
import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attachmentDisposition, MAX_UPLOAD_BYTES } from '../../storage/files.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';

let h: Harness;
let A: Company;
let B: Company;
let hrDocs: TestActor;
let hrDocsEng: TestActor;
let hrDocsB: TestActor;
let engEmployee: string;
let finEmployee: string;
let employeeB: string;

const DOCUMENT_GRANTS: PermissionKey[] = ['document.upload.document', 'document.read.document'];
const pdf = (note = 'synthetic test document') => Buffer.from(`%PDF-1.4\n% ${note}\n%%EOF\n`);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('synthetic png body')]);
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** A synthetic PDF of exactly `size` bytes. */
const sizedPdf = (size: number) => {
  const bytes = Buffer.alloc(size, 0x20);
  bytes.write('%PDF-1.4\n');
  return bytes;
};

const upload = (a: TestActor, employeeId: string, fileName: string, bytes: Buffer) =>
  h.call(a, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName, contentBase64: b64(bytes) });
const uploaded = async (a: TestActor, employeeId: string, fileName: string, bytes: Buffer = pdf()) => {
  const res = await upload(a, employeeId, fileName, bytes);
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
};
const content = (a: TestActor, docId: string) => h.call(a, 'GET', `/v1/documents/${docId}/content`);
const setStored = (docId: string, column: 'file_name' | 'content_reference', value: string | null) =>
  h.db.query(`update attachment set ${column} = $2 where id = (select attachment_id from employee_document where id = $1)`, [docId, value]);
const contentReads = async (docId: string) =>
  Number(
    (
      await h.one<{ n: string }>(
        `select count(*) as n from audit_event where company_id = $1 and resource_code = 'employee_document' and record_key = $2 and action = 'READ_CONTENT'`,
        [A.id, docId],
      )
    ).n,
  );
const denialsBy = async (a: TestActor) =>
  (
    await h.db.query<{ record_key: string; action: string; reason: string; after_values: unknown }>(
      `select record_key, after_values->>'action' as action, after_values->>'reason' as reason, after_values from audit_event
        where company_id = $1 and actor_user_id = $2 and resource_code = 'employee_document' and action = 'ACCESS_DENIED'`,
      [A.id, a.user],
    )
  ).rows;
const attachmentOf = (docId: string) =>
  h.one<{ id: string; content_reference: string; checksum: string; byte_size: number }>(
    `select a.id, a.content_reference, a.checksum, a.byte_size
       from employee_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id where d.id = $1`,
    [docId],
  );

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hrDocs = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENT_GRANTS });
  // The same confidential grant, filtered to the ENG department (row scope).
  hrDocsEng = await h.actor(A, 'HR_ADMINISTRATOR', { extra: DOCUMENT_GRANTS, departmentFilter: A.dept });
  engEmployee = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  finEmployee = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.financeDept }))).json().id;
  B = await h.makeCompany();
  hrDocsB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: DOCUMENT_GRANTS });
  employeeB = (await h.call(await h.actor(B, 'HR_ADMINISTRATOR'), 'POST', '/v1/employees', h.newEmployeeBody(B))).json().id;
});

afterAll(async () => {
  await h?.stop();
});

/** Uploads, downloads and checks one named document: exact header, exact bytes, one audited read, name kept. */
async function expectServed(fileName: string, disposition: string) {
  const bytes = pdf(`named ${randomUUID()}`);
  const docId = await uploaded(hrDocs, engEmployee, fileName, bytes);
  const res = await content(hrDocs, docId);
  expect(res.statusCode).toBe(200);
  expect(res.headers['content-disposition']).toBe(disposition);
  expect(res.rawPayload.equals(bytes)).toBe(true);
  expect(await contentReads(docId)).toBe(1);
  // The metadata list still shows the name exactly as uploaded.
  const items = (await h.call(hrDocs, 'GET', `/v1/employees/${engEmployee}/documents`)).json().items as { id: string; fileName: string }[];
  expect(items.find((d) => d.id === docId)?.fileName).toBe(fileName);
}

describe('download headers for any stored file name (sec-1, web-7)', () => {
  // Characters above U+00FF that any server encoding used here can store (the en dash, euro sign and curly
  // quotes exist in WIN1252 too), so the header path itself is what is tested.
  it.each([
    ['bill – March.pdf', `attachment; filename="bill _ March.pdf"; filename*=UTF-8''bill%20%E2%80%93%20March.pdf`],
    ['€ invoice “final”.pdf', `attachment; filename="_ invoice _final_.pdf"; filename*=UTF-8''%E2%82%AC%20invoice%20%E2%80%9Cfinal%E2%80%9D.pdf`],
    ["Mother's bill (copy).pdf", `attachment; filename="Mother's bill (copy).pdf"; filename*=UTF-8''Mother%27s%20bill%20%28copy%29.pdf`],
    ['café 100%25.pdf', `attachment; filename="caf_ 100%25.pdf"; filename*=UTF-8''caf%C3%A9%20100%2525.pdf`],
  ])('serves "%s" with a printable-ASCII fallback and the exact UTF-8 name', expectServed);

  it('serves Devanagari and emoji names on a UTF-8 database', async (ctx) => {
    // A WIN1252 cluster (the Windows default for an embedded test server) cannot store these names at all.
    const { server_encoding } = await h.one<{ server_encoding: string }>(`show server_encoding`);
    if (server_encoding !== 'UTF8') ctx.skip();
    await expectServed('दस्तावेज़.pdf', `attachment; filename="_________.pdf"; filename*=UTF-8''%E0%A4%A6%E0%A4%B8%E0%A5%8D%E0%A4%A4%E0%A4%BE%E0%A4%B5%E0%A5%87%E0%A4%9C%E0%A4%BC.pdf`);
    await expectServed('scan 📄.pdf', `attachment; filename="scan _.pdf"; filename*=UTF-8''scan%20%F0%9F%93%84.pdf`);
  });

  it('still serves a stored name holding DEL, a tab, quotes or a backslash, or no name at all', async () => {
    const cases: [string | null, string][] = [
      ['a\x7fb\tc.pdf', `attachment; filename="a_b_c.pdf"; filename*=UTF-8''a%7Fb%09c.pdf`],
      ['say "hi" \\ now.pdf', `attachment; filename="say hi  now.pdf"; filename*=UTF-8''say%20%22hi%22%20%5C%20now.pdf`],
      [null, `attachment; filename="document"; filename*=UTF-8''document`],
    ];
    for (const [stored, disposition] of cases) {
      const docId = await uploaded(hrDocs, engEmployee, 'legacy.pdf');
      // Rows written before the upload pattern was tightened, or by another path, can hold any text.
      await setStored(docId, 'file_name', stored);
      const res = await content(hrDocs, docId);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toBe(disposition);
    }
  });

  it('refuses DEL, like the other control characters, in an uploaded file name', async () => {
    for (const fileName of ['bad\x7fname.pdf', 'bad\x1bname.pdf']) {
      const res = await upload(hrDocs, engEmployee, fileName, pdf());
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('INVALID_REQUEST');
    }
  });

  it('records a content read only once the bytes were fetched', async () => {
    const docId = await uploaded(hrDocs, engEmployee, 'lost.pdf');
    // A reference the store does not hold (for example a file lost from the store) makes the read fail.
    await setStored(docId, 'content_reference', `mem:${'0'.repeat(64)}`);
    const res = await content(hrDocs, docId);
    expect(res.statusCode).toBe(500);
    expect(await contentReads(docId)).toBe(0);
  });
});

describe('a denial outside row scope is recorded (sec-5, FR-098)', () => {
  it('an HR administrator limited to ENG gets not found for a FIN employee’s documents, and each attempt is recorded', async () => {
    const finDoc = await uploaded(hrDocs, finEmployee, 'fin-only.pdf');
    expect((await h.call(hrDocsEng, 'GET', `/v1/employees/${finEmployee}/documents`)).statusCode).toBe(404);
    expect((await content(hrDocsEng, finDoc)).statusCode).toBe(404);
    expect((await upload(hrDocsEng, finEmployee, 'not-mine.pdf', pdf())).statusCode).toBe(404);

    const rows = await denialsBy(hrDocsEng);
    expect(rows.map((r) => [r.record_key, r.action, r.reason].join(' ')).sort()).toEqual(
      [`${finEmployee} read OUT_OF_SCOPE`, `${finDoc} read OUT_OF_SCOPE`, `${finEmployee} upload OUT_OF_SCOPE`].sort(),
    );
    // Redacted metadata only: no file name or content in a denial.
    expect(JSON.stringify(rows)).not.toMatch(/fin-only|not-mine|PDF/);
    expect(await contentReads(finDoc)).toBe(0);
    const stored = await h.one<{ n: string }>(`select count(*) as n from employee_document where company_id = $1 and employee_id = $2`, [A.id, finEmployee]);
    expect(Number(stored.n)).toBe(1); // the refused upload stored nothing
  });

  it('inside its department the same administrator works normally, and unknown ids are plain not found', async () => {
    const before = (await denialsBy(hrDocsEng)).length;
    const engDoc = await uploaded(hrDocsEng, engEmployee, 'eng.pdf');
    expect((await h.call(hrDocsEng, 'GET', `/v1/employees/${engEmployee}/documents`)).statusCode).toBe(200);
    expect((await content(hrDocsEng, engDoc)).statusCode).toBe(200);
    expect((await content(hrDocsEng, randomUUID())).statusCode).toBe(404);
    expect((await h.call(hrDocsEng, 'GET', `/v1/employees/${randomUUID()}/documents`)).statusCode).toBe(404);
    expect((await upload(hrDocsEng, randomUUID(), 'nobody.pdf', pdf())).statusCode).toBe(404);
    expect((await denialsBy(hrDocsEng)).length).toBe(before);
  });
});

describe('file safety evidence (FR-010, FR-057, brd-9)', () => {
  it('serves content as a no-store, nosniff attachment of the sniffed type', async () => {
    const docId = await uploaded(hrDocs, engEmployee, 'offer-letter.pdf');
    const res = await content(hrDocs, docId);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="offer-letter\.pdf"/);
  });

  it('accepts JPEG and PNG by their magic bytes whatever the name, and refuses a renamed text file', async () => {
    const accepted = [
      [jpeg, 'image/jpeg', 'photo.jpg'],
      [png, 'image/png', 'scan.txt'],
    ] as const;
    for (const [bytes, mediaType, fileName] of accepted) {
      const res = await upload(hrDocs, engEmployee, fileName, bytes);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({ mediaType, byteSize: bytes.length });
      const served = await content(hrDocs, res.json().id);
      expect(served.headers['content-type']).toBe(mediaType);
      expect(served.rawPayload.equals(bytes)).toBe(true);
    }
    for (const fileName of ['notes.jpg', 'notes.png', 'notes.pdf']) {
      const res = await upload(hrDocs, engEmployee, fileName, Buffer.from('plain synthetic text, not an image'));
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('UNSUPPORTED_FILE');
    }
  });

  it('addresses stored bytes by company and SHA-256: the checksum and content reference derive from the bytes', async () => {
    const bytes = pdf(`content-addressed ${randomUUID()}`);
    const first = await attachmentOf(await uploaded(hrDocs, engEmployee, 'copy-1.pdf', bytes));
    const second = await attachmentOf(await uploaded(hrDocs, engEmployee, 'copy-2.pdf', bytes));
    const other = await attachmentOf(await uploaded(hrDocs, engEmployee, 'other.pdf', pdf(`different ${randomUUID()}`)));
    expect(first.checksum).toBe(sha256(bytes));
    // The object key starts with the company (docs/09 §3.4), so a company's objects move or are erased as a unit.
    expect(first.content_reference).toBe(`mem:${A.id}/${sha256(bytes)}`);
    expect(first.byte_size).toBe(bytes.length);
    // Same bytes: same checksum and stored object, though each upload keeps its own attachment row.
    expect(second).toMatchObject({ checksum: first.checksum, content_reference: first.content_reference });
    expect(second.id).not.toBe(first.id);
    expect(other.checksum).not.toBe(first.checksum);
    expect(other.content_reference).not.toBe(first.content_reference);
  });

  it('never shares a stored object between companies: the same bytes in company B are B’s own object', async () => {
    const bytes = pdf(`cross-company ${randomUUID()}`);
    const inA = await attachmentOf(await uploaded(hrDocs, engEmployee, 'same-a.pdf', bytes));
    const inB = await attachmentOf(await uploaded(hrDocsB, employeeB, 'same-b.pdf', bytes));
    expect(inB.checksum).toBe(inA.checksum);
    expect(inA.content_reference).toBe(`mem:${A.id}/${sha256(bytes)}`);
    expect(inB.content_reference).toBe(`mem:${B.id}/${sha256(bytes)}`);
    // Each company's stored references are listed by its prefix alone.
    const foreign = await h.one<{ n: string }>(`select count(*) as n from attachment where company_id = $1 and content_reference not like $2`, [B.id, `mem:${B.id}/%`]);
    expect(Number(foreign.n)).toBe(0);
    const served = await content(hrDocsB, (await h.one<{ id: string }>(`select id from employee_document where attachment_id = $1`, [inB.id])).id);
    expect(served.statusCode).toBe(200);
    expect(served.rawPayload.equals(bytes)).toBe(true);
  });

  it('refuses uploads over 10 MB; exactly 10 MB is accepted', async () => {
    const atLimit = await upload(hrDocs, engEmployee, 'at-limit.pdf', sizedPdf(MAX_UPLOAD_BYTES));
    expect(atLimit.statusCode).toBe(201);
    expect(atLimit.json().byteSize).toBe(10 * 1024 * 1024);
    const over = await upload(hrDocs, engEmployee, 'over-limit.pdf', sizedPdf(MAX_UPLOAD_BYTES + 1));
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toBe('FILE_SIZE');
    const stored = await h.one<{ n: string }>(`select count(*) as n from attachment where company_id = $1 and file_name = 'over-limit.pdf'`, [A.id]);
    expect(Number(stored.n)).toBe(0);
  });
});

describe('attachmentDisposition (sec-1)', () => {
  it('turns Devanagari and emoji into a printable-ASCII fallback plus the exact UTF-8 name', () => {
    for (const name of ['दस्तावेज़.pdf', 'scan 📄.pdf', 'notes… ™.pdf']) {
      const header = attachmentDisposition(name, 'document');
      expect(header).toMatch(/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''[A-Za-z0-9%!#$&+\-.^_`|~]+$/);
      expect(decodeURIComponent(header.split("UTF-8''")[1]!)).toBe(name);
    }
    expect(attachmentDisposition('scan 📄.pdf', 'document')).toBe(`attachment; filename="scan _.pdf"; filename*=UTF-8''scan%20%F0%9F%93%84.pdf`);
    expect(attachmentDisposition('दस्तावेज़.pdf', 'document')).toMatch(/^attachment; filename="_________\.pdf"; /);
  });

  it('replaces a lone surrogate and falls back to the default name when nothing printable is left', () => {
    expect(attachmentDisposition('\ud800 lone.pdf', 'document')).toBe(`attachment; filename="_ lone.pdf"; filename*=UTF-8''%EF%BF%BD%20lone.pdf`);
    expect(attachmentDisposition('""', 'receipt')).toBe(`attachment; filename="receipt"; filename*=UTF-8''%22%22`);
    expect(attachmentDisposition('   ', 'receipt')).toBe(`attachment; filename="receipt"; filename*=UTF-8''receipt`);
  });
});
