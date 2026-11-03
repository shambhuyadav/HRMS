// Document and receipt quarantine, scanning and verification (FR-106; H4 upload rules; H3 TN05; DF06 v8.2; H1/BR-053).
// Synthetic data only: the "infected" files are synthetic PDFs carrying the EICAR anti-virus test string, which every
// scanner treats as a test finding (the string is assembled at run time; see storage/scan.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { devTokenVerifier } from '../../auth/tokens.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { EICAR_TEST_STRING, scanPendingAttachments } from '../../storage/scan.js';
import { memoryFileStore } from '../../storage/files.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hrPlain: TestActor;
let employee: TestActor;
let colleague: TestActor;
let employeeEmp: string;
let colleagueEmp: string;

const pdf = (note: string) => Buffer.from(`%PDF-1.4\n% synthetic ${note}\n%%EOF\n`).toString('base64');
const infectedPdf = () => Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF\n`, 'latin1').toString('base64');
const upload = (a: TestActor, employeeId: string, content: string) =>
  h.call(a, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'synthetic.pdf', contentBase64: content });
const list = async (a: TestActor, employeeId: string) => (await h.call(a, 'GET', `/v1/employees/${employeeId}/documents`)).json().items as Record<string, unknown>[];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.upload.document', 'document.read.document', 'document.verify.document'] });
  hrPlain = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.read.document', 'document.verify.document'] });
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  employeeEmp = await person();
  colleagueEmp = await person();
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('own documents and quarantine (FR-106, H3 TN05)', () => {
  it('lets the employee upload and read their own released documents, never a colleague’s', async () => {
    const res = await upload(employee, employeeEmp, pdf('own'));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ scanState: 'CLEAN' });
    expect((await list(employee, employeeEmp)).find((d) => d.id === res.json().id)).toMatchObject({ scanState: 'CLEAN', verificationState: 'UNVERIFIED' });
    expect((await h.call(employee, 'GET', `/v1/documents/${res.json().id}/content`)).statusCode).toBe(200);
    // Altered identifiers: another employee's record is not found, for upload, list and content alike.
    expect((await upload(employee, colleagueEmp, pdf('foreign'))).statusCode).toBe(404);
    expect((await h.call(employee, 'GET', `/v1/employees/${colleagueEmp}/documents`)).statusCode).toBe(404);
    const theirs = (await upload(colleague, colleagueEmp, pdf('theirs'))).json().id as string;
    expect((await h.call(employee, 'GET', `/v1/documents/${theirs}/content`)).statusCode).toBe(404);
  });

  it('quarantines a file the scan flags: nobody can read or verify it', async () => {
    const res = await upload(employee, employeeEmp, infectedPdf());
    expect(res.json()).toMatchObject({ scanState: 'QUARANTINED' });
    const id = res.json().id as string;
    for (const a of [employee, hr]) {
      const read = await h.call(a, 'GET', `/v1/documents/${id}/content`);
      expect(read.statusCode).toBe(409);
      expect(read.json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'QUARANTINED' } });
    }
    expect((await h.call(hr, 'POST', `/v1/documents/${id}/verification`, { decision: 'VERIFIED' })).json().error).toBe('FILE_NOT_RELEASED');
    const finding = await h.one<{ f: string | null }>(`select a.scan_finding as f from employee_document d join attachment a on a.id = d.attachment_id where d.id = $1`, [id]);
    expect(finding.f).toBe('EICAR-Test-File');
    const audit = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and record_key = $2 and action = 'SCAN_QUARANTINED'`, [A.id, id]);
    expect(audit.n).toBe(1);
    // A verdict is final: the database refuses to release a quarantined file.
    await expect(h.db.query(`update attachment set scan_state = 'CLEAN' where id = (select attachment_id from employee_document where id = $1)`, [id])).rejects.toThrow('a scan verdict is final');
  });

  it('keeps a file pending while the scanner is unavailable and releases it on a later scan', async () => {
    // A second app on the same database whose scanner always errors (e.g. an outage).
    const files = memoryFileStore();
    const app = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), files, scanner: { scan: async () => ({ verdict: 'ERROR' }) } });
    const headers = { authorization: `Bearer ${employee.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: employee.assignment };
    try {
      const res = await app.inject({ method: 'POST', url: `/v1/employees/${employeeEmp}/documents`, headers, payload: { documentType: 'GENERAL', fileName: 'pending.pdf', contentBase64: pdf('pending') } });
      expect(res.json()).toMatchObject({ scanState: 'PENDING_SCAN' });
      const id = res.json().id as string;
      expect((await app.inject({ method: 'GET', url: `/v1/documents/${id}/content`, headers })).json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'PENDING_SCAN' } });
      const outcome = await scanPendingAttachments(h.pool, files, { scan: async () => ({ verdict: 'CLEAN' }) }, A.id);
      expect(outcome).toMatchObject({ clean: 1, stillPending: 0 });
      expect((await app.inject({ method: 'GET', url: `/v1/documents/${id}/content`, headers })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});

describe('verification as master evidence (FR-106)', () => {
  it('needs an independent reviewer, a released file and a reason to reject; the verdict is final', async () => {
    const own = (await upload(employee, employeeEmp, pdf('to verify'))).json().id as string;
    // The employee cannot verify (no grant); the uploader can never verify their own upload.
    expect((await h.call(employee, 'POST', `/v1/documents/${own}/verification`, { decision: 'VERIFIED' })).statusCode).toBe(403);
    const byHr = (await upload(hr, employeeEmp, pdf('hr upload'))).json().id as string;
    expect((await h.call(hr, 'POST', `/v1/documents/${byHr}/verification`, { decision: 'VERIFIED' })).json().error).toBe('INDEPENDENT_VERIFIER_REQUIRED');
    expect((await h.call(hrPlain, 'POST', `/v1/documents/${byHr}/verification`, { decision: 'VERIFIED' })).json()).toMatchObject({ verificationState: 'VERIFIED' });

    expect((await h.call(hr, 'POST', `/v1/documents/${own}/verification`, { decision: 'REJECTED' })).json().error).toBe('NOTE_REQUIRED');
    expect((await h.call(hr, 'POST', `/v1/documents/${own}/verification`, { decision: 'REJECTED', note: 'Synthetic: unreadable scan' })).json()).toMatchObject({ verificationState: 'REJECTED' });
    expect((await h.call(hrPlain, 'POST', `/v1/documents/${own}/verification`, { decision: 'VERIFIED' })).json().error).toBe('ALREADY_VERIFIED');
    // The reviewer's note is HR-authored: the employee sees the state, not the note (I-16).
    const mine = (await list(employee, employeeEmp)).find((d) => d.id === own)!;
    expect(mine).toMatchObject({ verificationState: 'REJECTED' });
    expect(mine.verificationNote).toBeUndefined();
    expect((await list(hr, employeeEmp)).find((d) => d.id === own)).toMatchObject({ verificationNote: 'Synthetic: unreadable scan' });
  });
});

describe('receipts (DF06 v8.2, FR-106)', () => {
  it('quarantines a flagged receipt so it cannot become claim evidence; the claimant reads their own released receipt', async () => {
    const bad = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'bad.pdf', contentBase64: infectedPdf() });
    expect(bad.json()).toMatchObject({ scanState: 'QUARANTINED' });
    const line = { category: 'OTHER', expenseDate: (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()) - 1, 'YYYY-MM-DD') as d`, [A.id])).d, merchant: 'Synthetic', grossAmount: '10', claimedAmount: '10', description: 'Synthetic' };
    const refused = await h.call(employee, 'POST', '/v1/expense/claims', { purpose: 'Synthetic', currency: 'INR', lines: [{ ...line, receipt: { receiptId: bad.json().receiptId } }] });
    expect(refused.json().error).toBe('RECEIPT_QUARANTINED');

    const good = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'good.pdf', contentBase64: pdf('receipt') });
    expect(good.json()).toMatchObject({ scanState: 'CLEAN' });
    const claim = await h.call(employee, 'POST', '/v1/expense/claims', { purpose: 'Synthetic', currency: 'INR', lines: [{ ...line, receipt: { receiptId: good.json().receiptId } }] });
    expect(claim.statusCode).toBe(201);
    const lineId = (await h.call(employee, 'GET', `/v1/expense/claims/${claim.json().claimId}`)).json().lines[0].id as string;
    expect((await h.call(employee, 'GET', `/v1/expense/lines/${lineId}/receipt`)).statusCode).toBe(200);
    expect((await h.call(colleague, 'GET', `/v1/expense/lines/${lineId}/receipt`)).statusCode).toBe(404);
  });
});
