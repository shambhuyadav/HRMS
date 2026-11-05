// Uploads and the scan worker on the real routes and the real database (NFR-S09; FR-106; FR-104; FR-105; docs/09 §7.2, §8.3). An app built as
// a deployment builds it never asks the scanner in the request: the file is stored, answered PENDING_SCAN, unusable, and the worker
// reaches the verdict, retrying with backoff up to a limit. Nothing marks a file clean because the scanner was down. Scanner doubles and
// EICAR test strings only; synthetic data only.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { uniq } from '../../../../db/tests/fixtures.js';
import { buildApp } from '../app.js';
import { SYSTEM_ACTOR_ID } from '../audit/actors.js';
import { devTokenVerifier } from '../auth/tokens.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../http/context.js';
import { EMPLOYEE_IMPORT_COLUMNS } from '../modules/employee/imports.js';
import { dispatchOutbox } from '../modules/notification/dispatcher.js';
import { memoryFileStore } from '../storage/files.js';
import { EICAR_TEST_STRING, scanBackoffMs, scanDueAttachments, scanInMemory, scanPendingAttachments, type ScanProvider, type ScanSettings, scanSettings, type ScanVerdict } from '../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../test/harness.js';
import { runScheduledJobs } from './scheduler.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let hrB: TestActor;
let verifier: TestActor;
let employeeId: string;
let employeeB: string;

const files = memoryFileStore();
/** A scanner whose answer each test decides; `calls` counts how often it was asked. */
const scanner = { calls: 0, answer: (async () => ({ verdict: 'CLEAN' })) as (bytes: Buffer) => Promise<ScanVerdict> };
const provider: ScanProvider = {
  scan: (bytes) => {
    scanner.calls++;
    return scanner.answer(bytes);
  },
};
const NEVER = () => new Promise<ScanVerdict>(() => undefined);
const CLEAN: ScanVerdict = { verdict: 'CLEAN' };
const DOWN = async (): Promise<ScanVerdict> => ({ verdict: 'ERROR' });
let app: ReturnType<typeof buildApp>;
const send = (a: TestActor, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: a.company.id, [ASSIGNMENT_HEADER]: a.assignment }, ...(payload ? { payload } : {}) });

const pdf = (note = uniq('n')) => Buffer.from(`%PDF-1.4\n% synthetic ${note}\n%%EOF\n`).toString('base64');
const infected = () => Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF\n`, 'latin1').toString('base64');
const upload = async (a: TestActor = hr, employee: string = employeeId, content: string = pdf()) => {
  const res = await send(a, 'POST', `/v1/employees/${employee}/documents`, { documentType: 'GENERAL', fileName: `${uniq('f')}.pdf`, contentBase64: content });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; scanState: string };
};
const attachmentOf = (documentId: string) =>
  h.one<{ id: string; scan_state: string; scan_attempts: number; next_in_s: number | null; scan_last_error: string | null; failed: boolean; checked: boolean; updated_by: string }>(
    `select a.id, a.scan_state, a.scan_attempts, extract(epoch from (a.scan_next_attempt_at - now()))::float as next_in_s, a.scan_last_error, a.scan_failed_at is not null as failed, a.scan_checked_at is not null as checked, a.updated_by
       from employee_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id where d.id = $1`,
    [documentId],
  );
const dueNow = () => h.db.query(`update attachment set scan_next_attempt_at = now() - interval '1 second' where scan_next_attempt_at is not null`);
const quickSettings = (overrides: Partial<ScanSettings> = {}): ScanSettings => ({ ...scanSettings(), ...overrides });

beforeAll(async () => {
  h = await startHarness();
  // In id order, so a backlog in A is always in the company a walk from the start reaches first: the worst case for B.
  [A, B] = [await h.makeCompany(), await h.makeCompany()].sort((x, y) => (x.id < y.id ? -1 : 1)) as [Company, Company];
  const DOCS = ['document.upload.document', 'document.read.document'] as const;
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...DOCS] });
  hrB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [...DOCS] });
  verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.read.document', 'document.verify.document'] });
  employeeId = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  employeeB = (await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B))).json().id;
  await h.setStatus(A, employeeId, 'ACTIVE_CONFIRMED');
  // As a deployment builds it: no in-request scanning. The scanner never answers in the tests of the request itself.
  app = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), files, scanner: provider });
});

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

beforeEach(async () => {
  scanner.calls = 0;
  scanner.answer = async () => CLEAN;
  // Nothing left over from an earlier test.
  await h.db.query(`update attachment set scan_failed_at = now(), scan_next_attempt_at = null where scan_state = 'PENDING_SCAN' and scan_failed_at is null`);
});

describe('an upload does not wait for the scanner (NFR-S09)', () => {
  beforeEach(() => {
    scanner.answer = NEVER;
  });

  it('employee documents and receipts answer at once, whatever the scanner is doing', async () => {
    const document = await upload();
    expect(document.scanState).toBe('PENDING_SCAN');
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId });
    const receipt = await send(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: pdf() });
    expect(receipt.statusCode, receipt.body).toBe(201);
    expect(receipt.json().scanState).toBe('PENDING_SCAN');
    expect(scanner.calls).toBe(0);
  });

  it('company policies and staged bulk documents answer at once', async () => {
    const policy = await send(hr, 'POST', '/v1/company-policies', { policyCode: uniq('POL_'), title: 'Synthetic policy', classification: 'OPERATIONAL', fileName: 'policy.pdf', contentBase64: pdf() });
    expect(policy.statusCode, policy.body).toBeLessThan(300);
    expect(policy.json().scanState).toBe('PENDING_SCAN');
    const staged = await send(hr, 'POST', '/v1/documents/bulk-uploads', { fileName: `${uniq('s')}.pdf`, contentBase64: pdf() });
    expect(staged.statusCode, staged.body).toBe(201);
    expect(staged.json().scanState).toBe('PENDING_SCAN');
    expect(scanner.calls).toBe(0);
  });

  it('a batch import is held unread until the worker’s verdict, on the upload and on its resume, and the same upload resumes it', async () => {
    const code = uniq('IMP');
    const key = uniq('scan-key-');
    const csv = [EMPLOYEE_IMPORT_COLUMNS.join(','), `${code},Synthetic Joiner,,2026-03-02,PERMANENT,ENG,HQ,DEV,`].join('\r\n');
    const body = { fileName: 'held.csv', contentBase64: Buffer.from(csv).toString('base64'), idempotencyKey: key };
    const held = await send(hr, 'POST', '/v1/employees/imports', body);
    expect(held.statusCode, held.body).toBe(202);
    expect(held.json()).toMatchObject({ state: 'UPLOADED', scanState: 'PENDING_SCAN', rowCount: null, rows: [] });
    const resumed = await send(hr, 'POST', `/v1/employees/imports/${held.json().id}/resume`);
    expect(resumed.statusCode).toBe(202);
    expect((await send(hr, 'POST', '/v1/employees/imports', body)).statusCode).toBe(202);
    expect(scanner.calls).toBe(0);

    scanner.answer = async () => CLEAN;
    expect(await scanPendingAttachments(h.pool, files, provider, A.id)).toMatchObject({ clean: 1 });
    const previewed = await send(hr, 'POST', '/v1/employees/imports', body);
    expect(previewed.statusCode).toBe(200);
    expect(previewed.json()).toMatchObject({ state: 'PREVIEWED', scanState: 'CLEAN', rowCount: 1 });
    expect(scanner.calls).toBe(1);
  });

  it('only a test harness can scan in the request: production refuses it', () => {
    const saved = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), files, scanner: provider, scanInRequest: true })).toThrow(/never in the request/);
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});

describe('an import from upload to commit, as a deployment runs it (FR-106, NFR-S09)', () => {
  const employees = async (code: string) => (await h.one<{ n: number }>(`select count(*)::int as n from employee where company_id = $1 and employee_code = $2`, [A.id, code])).n;
  const importBody = (code: string, name = 'Synthetic Joiner') => ({
    fileName: `${uniq('walk')}.csv`,
    contentBase64: Buffer.from([EMPLOYEE_IMPORT_COLUMNS.join(','), `${code},${name},,2026-03-02,PERMANENT,ENG,HQ,DEV,`].join('\r\n'), 'latin1').toString('base64'),
    idempotencyKey: uniq('walk-key-'),
  });

  it('held on upload, held on resume without fetching the file, released by the worker, previewed on resume, applied on commit', async () => {
    const code = uniq('IMP');
    const held = await send(hr, 'POST', '/v1/employees/imports', importBody(code));
    expect(held.statusCode, held.body).toBe(202);
    expect(held.json()).toMatchObject({ state: 'UPLOADED', scanState: 'PENDING_SCAN', rowCount: null, rows: [] });
    const id = held.json().id as string;
    const url = `/v1/employees/imports/${id}`;

    // Asked again and again while the scan is pending: the same answer, and the stored file is not fetched for it.
    const fetched = vi.spyOn(files, 'get');
    try {
      for (let i = 0; i < 3; i++) {
        const waiting = await send(hr, 'POST', `${url}/resume`);
        expect(waiting.statusCode).toBe(202);
        expect(waiting.json()).toMatchObject({ id, state: 'UPLOADED', scanState: 'PENDING_SCAN', rows: [] });
      }
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      fetched.mockRestore();
    }
    const early = await send(hr, 'POST', `${url}/commit`);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'PENDING_SCAN' } });
    expect(await employees(code)).toBe(0);

    expect(await scanDueAttachments(h.pool, files, provider)).toMatchObject({ clean: 1 });
    const previewed = await send(hr, 'POST', `${url}/resume`);
    expect(previewed.statusCode, previewed.body).toBe(200);
    expect(previewed.json()).toMatchObject({ id, state: 'PREVIEWED', scanState: 'CLEAN', rowCount: 1, rows: [{ state: 'VALID' }] });
    expect(await employees(code)).toBe(0);

    expect((await send(hr, 'POST', `${url}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 1 });
    expect(await employees(code)).toBe(1);
    // A repeat changes nothing, and the batch's own trail is whole.
    expect((await send(hr, 'POST', `${url}/resume`)).json()).toMatchObject({ id, state: 'COMMITTED' });
    const actions = await h.db.query<{ action: string }>(`select action from audit_event where company_id = $1 and resource_code = 'import_job' and record_key = $2 order by created_at`, [A.id, id]);
    expect(actions.rows.map((r) => r.action)).toEqual(['CREATE', 'PREVIEW', 'COMMIT']);
  });

  it('a finding: the worker quarantines, the resume refuses and closes the batch unread, and nothing can commit it', async () => {
    const code = uniq('IMP');
    const held = await send(hr, 'POST', '/v1/employees/imports', importBody(code, EICAR_TEST_STRING));
    expect(held.statusCode, held.body).toBe(202);
    const url = `/v1/employees/imports/${held.json().id as string}`;
    scanner.answer = async (bytes) => (bytes.includes(Buffer.from(EICAR_TEST_STRING, 'latin1')) ? { verdict: 'INFECTED', finding: 'EICAR-Test-File' } : CLEAN);
    expect(await scanDueAttachments(h.pool, files, provider)).toMatchObject({ quarantined: 1 });

    const refused = await send(hr, 'POST', `${url}/resume`);
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toBe('FILE_QUARANTINED');
    expect((await send(hr, 'GET', url)).json()).toMatchObject({ state: 'REJECTED', scanState: 'QUARANTINED', rows: [] });
    // Asked once more (a screen whose answer was lost), it says where the batch stands.
    const again = await send(hr, 'POST', `${url}/resume`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ state: 'REJECTED' });
    expect((await send(hr, 'POST', `${url}/commit`)).statusCode).toBe(409);
    expect(await employees(code)).toBe(0);
  });
});

describe('a file stays unusable until the worker’s verdict (FR-106)', () => {
  it('pending: not served, not verifiable; released by a clean verdict', async () => {
    const { id } = await upload();
    const read = await send(hr, 'GET', `/v1/documents/${id}/content`);
    expect(read.statusCode).toBe(409);
    expect(read.json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'PENDING_SCAN' } });
    expect((await send(verifier, 'POST', `/v1/documents/${id}/verification`, { decision: 'VERIFIED' })).json().error).toBe('FILE_NOT_RELEASED');

    expect(await scanDueAttachments(h.pool, files, provider)).toMatchObject({ scanned: 1, clean: 1, quarantined: 0, stillPending: 0, failed: 0, paused: false });
    const released = await attachmentOf(id);
    expect(released).toMatchObject({ scan_state: 'CLEAN', checked: true, next_in_s: null, updated_by: SYSTEM_ACTOR_ID });
    expect((await send(hr, 'GET', `/v1/documents/${id}/content`)).statusCode).toBe(200);
    expect((await send(verifier, 'POST', `/v1/documents/${id}/verification`, { decision: 'VERIFIED' })).json()).toMatchObject({ verificationState: 'VERIFIED' });
    const audit = await h.one<{ action: string; actor_user_id: string; updated_by: string; after: Record<string, unknown> }>(
      `select action, actor_user_id, updated_by, after_values as after from audit_event where company_id = $1 and resource_code = 'attachment' and record_key = $2`,
      [A.id, released.id],
    );
    expect(audit).toEqual({ action: 'SCAN_RELEASED', actor_user_id: SYSTEM_ACTOR_ID, updated_by: SYSTEM_ACTOR_ID, after: { operational: { scanState: 'CLEAN' } } });
  });

  it('a finding: quarantined for good, the uploader told once, the audit naming no content', async () => {
    const quarantineNotices = async () => ((await h.call(hr, 'GET', '/v1/me/notifications')).json().items as { category: string }[]).filter((n) => n.category === 'FILE_QUARANTINED').length;
    await dispatchOutbox(h.pool, 500);
    const noticesBefore = await quarantineNotices();
    const { id } = await upload(hr, employeeId, infected());
    scanner.answer = async (bytes) => (bytes.includes(Buffer.from(EICAR_TEST_STRING, 'latin1')) ? { verdict: 'INFECTED', finding: 'EICAR-Test-File' } : CLEAN);
    expect(await scanDueAttachments(h.pool, files, provider)).toMatchObject({ scanned: 1, quarantined: 1 });
    const file = await attachmentOf(id);
    expect(file.scan_state).toBe('QUARANTINED');
    const read = await send(hr, 'GET', `/v1/documents/${id}/content`);
    expect(read.json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'QUARANTINED' } });
    expect((await h.one<{ action: string }>(`select action from audit_event where record_key = $1 and resource_code = 'attachment'`, [file.id])).action).toBe('SCAN_QUARANTINED');
    await dispatchOutbox(h.pool, 500);
    expect(await quarantineNotices()).toBe(noticesBefore + 1);
    // A later pass repeats nothing.
    expect(await scanDueAttachments(h.pool, files, provider)).toMatchObject({ scanned: 0 });
    await expect(h.db.query(`update attachment set scan_state = 'CLEAN' where id = $1`, [file.id])).rejects.toThrow('a scan verdict is final');
  });
});

describe('pending scans retry with backoff and a limit (docs/09 §8.3)', () => {
  const settings = (overrides: Partial<ScanSettings> = {}) => quickSettings({ maxAttempts: 3, pauseAfterErrors: 100, ...overrides });

  it('the wait doubles from the base up to the maximum, with jitter in its upper half', () => {
    const s = { backoffBaseMs: 60_000, backoffMaxMs: 3_600_000 };
    expect([1, 2, 3, 7, 8].map((n) => scanBackoffMs(n, s, () => 1))).toEqual([60_000, 120_000, 240_000, 3_600_000, 3_600_000]);
    expect([1, 2, 7].map((n) => scanBackoffMs(n, s, () => 0))).toEqual([30_000, 60_000, 1_800_000]);
    for (const n of [1, 2, 3, 12]) expect(scanBackoffMs(n, s)).toBeGreaterThanOrEqual(30_000);
  });

  it('a scanner error leaves the file pending, waits, and asks nothing again before its time; never clean', async () => {
    const { id } = await upload();
    scanner.answer = DOWN;
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 1, stillPending: 1, failed: 0 });
    const first = await attachmentOf(id);
    expect(first).toMatchObject({ scan_state: 'PENDING_SCAN', scan_attempts: 1, scan_last_error: 'SCANNER_ERROR', failed: false, checked: false });
    expect(first.next_in_s).toBeGreaterThan(25); // the upper half of a 60 s wait, less the time this takes
    expect(first.next_in_s).toBeLessThanOrEqual(60);

    // Not due: another pass, and another worker's, leave the scanner alone, even once it answers.
    scanner.calls = 0;
    scanner.answer = async () => CLEAN;
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 0 });
    expect(await scanPendingAttachments(h.pool, files, provider, A.id)).toMatchObject({ scanned: 0 });
    expect(scanner.calls).toBe(0);
    expect((await send(hr, 'GET', `/v1/documents/${id}/content`)).statusCode).toBe(409);

    await dueNow();
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 1, clean: 1 });
    expect(await attachmentOf(id)).toMatchObject({ scan_state: 'CLEAN', scan_attempts: 2, scan_last_error: null, failed: false });
  });

  it('at the limit the failure is explicit: still pending, still refused, marked and audited, and never asked about again', async () => {
    const { id } = await upload();
    scanner.answer = DOWN;
    for (const attempt of [1, 2]) {
      expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ stillPending: 1, failed: 0 });
      expect((await attachmentOf(id)).scan_attempts).toBe(attempt);
      await dueNow();
    }
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 1, stillPending: 0, failed: 1 });
    const file = await attachmentOf(id);
    expect(file).toMatchObject({ scan_state: 'PENDING_SCAN', scan_attempts: 3, scan_last_error: 'SCANNER_ERROR', failed: true, next_in_s: null, checked: false });
    const read = await send(hr, 'GET', `/v1/documents/${id}/content`);
    expect(read.json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'PENDING_SCAN' } });
    expect((await send(verifier, 'POST', `/v1/documents/${id}/verification`, { decision: 'VERIFIED' })).json().error).toBe('FILE_NOT_RELEASED');
    const audit = await h.one<{ action: string; actor_user_id: string; after: Record<string, unknown> }>(`select action, actor_user_id, after_values as after from audit_event where resource_code = 'attachment' and record_key = $1`, [file.id]);
    expect(audit).toEqual({ action: 'SCAN_FAILED', actor_user_id: SYSTEM_ACTOR_ID, after: { operational: { scanState: 'PENDING_SCAN', attempts: 3, errorCode: 'SCANNER_ERROR' } } });

    // The scanner recovers: a failed file is not picked up by itself, and is not released by anything but a verdict.
    scanner.calls = 0;
    scanner.answer = async () => CLEAN;
    await dueNow();
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 0 });
    expect(scanner.calls).toBe(0);
    expect((await attachmentOf(id)).scan_state).toBe('PENDING_SCAN');
    await expect(h.db.query(`update attachment set scan_state = 'CLEAN', scan_checked_at = now() where id = $1`, [file.id])).rejects.toThrow(/attachment_scan_failed_pending/);
  });

  it('a timeout and an unreadable file count as failed attempts, named as such', async () => {
    const slow = await upload();
    scanner.answer = NEVER;
    expect(await scanDueAttachments(h.pool, files, provider, settings({ timeoutMs: 20 }))).toMatchObject({ scanned: 1, stillPending: 1 });
    expect(await attachmentOf(slow.id)).toMatchObject({ scan_state: 'PENDING_SCAN', scan_last_error: 'SCANNER_TIMEOUT' });
    await h.db.query(`update attachment set scan_failed_at = now(), scan_next_attempt_at = null where id = (select attachment_id from employee_document where id = $1)`, [slow.id]);

    const lost = await upload();
    await h.db.query(`update attachment set content_reference = 'missing-reference' where id = (select attachment_id from employee_document where id = $1)`, [lost.id]);
    scanner.answer = async () => CLEAN;
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 0, stillPending: 1, clean: 0 });
    expect(await attachmentOf(lost.id)).toMatchObject({ scan_state: 'PENDING_SCAN', scan_last_error: 'FILE_UNREADABLE' });
  });

  it('a worker that dies after its claim: the file comes back at its retry, and at the limit it is marked failed without another scan', async () => {
    const { id } = await upload();
    const file = await attachmentOf(id);
    // What a worker leaves when it dies holding its claim: the attempt booked, the retry set, no result.
    await h.db.query(`update attachment set scan_attempts = 1, scan_next_attempt_at = now() + interval '1 minute' where id = $1`, [file.id]);
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 0 });
    await dueNow();
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 1, clean: 1 });

    const second = await upload();
    const secondFile = await attachmentOf(second.id);
    await h.db.query(`update attachment set scan_attempts = 3, scan_next_attempt_at = now() - interval '1 second' where id = $1`, [secondFile.id]);
    scanner.calls = 0;
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 0, failed: 1 });
    expect(scanner.calls).toBe(0);
    expect(await attachmentOf(second.id)).toMatchObject({ scan_state: 'PENDING_SCAN', failed: true, scan_last_error: 'WORKER_INTERRUPTED' });
  });

  it('an outage: a pass stops after a few failures in a row, leaving the other files’ attempts unspent, and recovery is bounded per pass', async () => {
    const documents: string[] = [];
    for (let i = 0; i < 8; i++) documents.push((await upload()).id);
    scanner.answer = DOWN;
    const paused = await scanDueAttachments(h.pool, files, provider, settings({ pauseAfterErrors: 3 }));
    expect(paused).toMatchObject({ scanned: 3, stillPending: 3, paused: true });
    expect(scanner.calls).toBe(3);
    const attempts = await Promise.all(documents.map(async (d) => (await attachmentOf(d)).scan_attempts));
    expect(attempts.filter((n) => n === 1)).toHaveLength(3);
    expect(attempts.filter((n) => n === 0)).toHaveLength(5);

    scanner.calls = 0;
    scanner.answer = async () => CLEAN;
    expect(await scanDueAttachments(h.pool, files, provider, settings({ perPass: 2 }))).toMatchObject({ scanned: 2, clean: 2 });
    expect(scanner.calls).toBe(2);
    await dueNow();
    expect(await scanDueAttachments(h.pool, files, provider, settings({ perPass: 100 }))).toMatchObject({ scanned: 6, clean: 6 });
  });

  it('files take turns by company, and two workers at once ask about each file once', async () => {
    for (let i = 0; i < 6; i++) await upload();
    const ofB = await upload(hrB, employeeB);
    expect(await scanDueAttachments(h.pool, files, provider, settings({ perPass: 2 }))).toMatchObject({ scanned: 2 });
    expect((await attachmentOf(ofB.id)).scan_state).toBe('CLEAN');

    scanner.calls = 0;
    scanner.answer = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return CLEAN;
    };
    const [one, two] = await Promise.all([scanDueAttachments(h.pool, files, provider, settings()), scanDueAttachments(h.pool, files, provider, settings())]);
    expect(one!.scanned + two!.scanned).toBe(5);
    expect(scanner.calls).toBe(5);
  });

  it('an inactive company’s files wait, as they did on the company loop', async () => {
    const { id } = await upload(hrB, employeeB);
    await h.db.query(`update company set active = false where id = $1`, [B.id]);
    try {
      expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 0 });
      expect((await attachmentOf(id)).scan_state).toBe('PENDING_SCAN');
    } finally {
      await h.db.query(`update company set active = true where id = $1`, [B.id]);
    }
  });
});

describe('the scan pass on the scheduler tick', () => {
  /** 11:00 in Asia/Kolkata on a day of its own. */
  let days = 0;
  const nextDay = () => new Date(Date.UTC(2032, 0, ++days, 5, 30));

  it('reaches the verdict on a tick, reporting its counts', async () => {
    const { id } = await upload();
    const tick = await runScheduledJobs({ db: h.pool, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID, files, scanner: provider }, nextDay());
    expect(tick.scans).toMatchObject({ scanned: 1, clean: 1 });
    expect((await attachmentOf(id)).scan_state).toBe('CLEAN');
  });

  it('a scanner that hangs holds back neither the relay nor the company loop, and the pass ends at its time limit', async () => {
    const { id } = await upload();
    let ticked = false;
    let release = () => {};
    scanner.answer = () =>
      new Promise((resolve) => {
        release = () => resolve(CLEAN);
      });
    const event = (await h.one<{ id: string }>(`insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload) values ($1, 'test.none', gen_random_uuid(), $2, '{}'::jsonb) returning id::text`, [A.id, uniq('test.none:')])).id;
    const at = nextDay();
    const tick = runScheduledJobs(
      { db: h.pool, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID, files, scanner: provider, scan: quickSettings({ timeoutMs: 60_000 }), settings: { relayBatch: 100, relayIntervalMs: 25, runLeaseMs: 60_000 } },
      at,
    ).then((r) => {
      ticked = true;
      return r;
    });
    await vi.waitFor(() => expect(scanner.calls).toBeGreaterThanOrEqual(1), { timeout: 30_000, interval: 25 });
    await vi.waitFor(async () => {
      const ran = await h.one<{ open: number; done: number }>(`select count(*) filter (where finished_at is null)::int as open, count(*) filter (where finished_at is not null)::int as done from scheduled_job_run where company_id = $1 and run_key like $2`, [A.id, `%:${at.toISOString().slice(0, 10)}`]);
      expect(ran.done).toBeGreaterThan(0);
      expect(ran.open).toBe(0);
    }, { timeout: 30_000, interval: 25 });
    expect((await h.one<{ p: boolean }>(`select published_at is not null as p from outbox_event where id = $1`, [event])).p).toBe(true);
    expect(ticked).toBe(false); // the tick itself still waits for the pass
    release();
    expect((await tick).scans).toMatchObject({ clean: 1 });
    expect((await attachmentOf(id)).scan_state).toBe('CLEAN');
  });

  it('an in-memory upload asks with a time limit, and a timeout reads as no verdict', async () => {
    const saved = process.env.SCAN_TIMEOUT_MS;
    process.env.SCAN_TIMEOUT_MS = '20';
    try {
      expect(await scanInMemory({ scan: NEVER }, Buffer.from('x'))).toEqual({ verdict: 'ERROR' });
      expect(await scanInMemory({ scan: async () => { throw new Error('down'); } }, Buffer.from('x'))).toEqual({ verdict: 'ERROR' });
      expect(await scanInMemory({ scan: async () => CLEAN }, Buffer.from('x'))).toEqual(CLEAN);
    } finally {
      if (saved === undefined) delete process.env.SCAN_TIMEOUT_MS;
      else process.env.SCAN_TIMEOUT_MS = saved;
    }
  });
});

describe('settings', () => {
  it('have named starting values, and read a positive whole number from the environment', () => {
    const names = ['SCAN_PER_TICK', 'SCAN_MAX_ATTEMPTS', 'SCAN_BACKOFF_BASE_MS', 'SCAN_BACKOFF_MAX_MS', 'SCAN_TIMEOUT_MS', 'SCAN_PAUSE_AFTER_ERRORS'];
    const saved = names.map((n) => [n, process.env[n]] as const);
    try {
      for (const n of names) delete process.env[n];
      expect(scanSettings()).toEqual({ perPass: 200, maxAttempts: 10, backoffBaseMs: 60_000, backoffMaxMs: 3_600_000, timeoutMs: 30_000, pauseAfterErrors: 5 });
      process.env.SCAN_MAX_ATTEMPTS = '4';
      process.env.SCAN_PER_TICK = '0'; // not positive: the default stays
      expect(scanSettings()).toMatchObject({ maxAttempts: 4, perPass: 200 });
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) delete process.env[n];
        else process.env[n] = v;
      }
    }
  });
});
