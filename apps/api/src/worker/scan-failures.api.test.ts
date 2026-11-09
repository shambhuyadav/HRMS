// Files whose malware scan could not be completed, and uploads scanned in the request (I-84 items 8 and 9, decided under owner
// delegation, 6 Nov 2026; I-73 items 1 and 2; FR-106; H4; H7 "scan"; NFR-S09; docs/09 §7.2, §8.3). On the real routes, the real worker
// pass and the real database, with an app built as a deployment builds it (the scanner is never asked in the request for a stored
// upload). Scanner doubles only; synthetic data only.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { uniq } from '../../../../db/tests/fixtures.js';
import { buildApp } from '../app.js';
import { devTokenVerifier } from '../auth/tokens.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../http/context.js';
import { BASELINE_ROLES } from '../modules/access/baseline.js';
import { dispatchOutbox } from '../modules/notification/dispatcher.js';
import { memoryFileStore } from '../storage/files.js';
import { scanDueAttachments, scanInMemory, type ScanProvider, type ScanSettings, scanSettings, type ScanVerdict } from '../storage/scan.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../test/harness.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let hrB: TestActor;
let sysadmin: TestActor;
let sysadminB: TestActor;
let employeeId: string;
let employeeB: string;

const REQUEUE = 'attachment.requeue_scan.operational';
const files = memoryFileStore();
const scanner = { answer: (async () => ({ verdict: 'CLEAN' })) as (bytes: Buffer) => Promise<ScanVerdict> };
const provider: ScanProvider = { scan: (bytes) => scanner.answer(bytes) };
const DOWN = async (): Promise<ScanVerdict> => ({ verdict: 'ERROR' });
const CLEAN: ScanVerdict = { verdict: 'CLEAN' };
let app: ReturnType<typeof buildApp>;
const send = (a: TestActor, method: 'GET' | 'POST', url: string, payload?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: a.company.id, [ASSIGNMENT_HEADER]: a.assignment }, ...(payload ? { payload } : {}) });

const pdf = () => Buffer.from(`%PDF-1.4\n% synthetic ${uniq('n')}\n%%EOF\n`).toString('base64');
const upload = async (a: TestActor, employee: string) => {
  const res = await send(a, 'POST', `/v1/employees/${employee}/documents`, { documentType: 'GENERAL', fileName: `${uniq('private-name-')}.pdf`, contentBase64: pdf() });
  expect(res.statusCode, res.body).toBe(201);
  const documentId = res.json().id as string;
  const { attachment_id: attachmentId } = await h.one<{ attachment_id: string }>(`select attachment_id from employee_document where id = $1`, [documentId]);
  return { documentId, attachmentId };
};
const settings = (over: Partial<ScanSettings> = {}): ScanSettings => ({ ...scanSettings(), maxAttempts: 1, pauseAfterErrors: 100, ...over });
/** An upload whose one allowed attempt fails: the worker marks it failed. */
const failedUpload = async (a: TestActor = hr, employee: string = employeeId) => {
  const file = await upload(a, employee);
  scanner.answer = DOWN;
  expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ failed: 1 });
  scanner.answer = async () => CLEAN;
  return file;
};
const fileState = (attachmentId: string) =>
  h.one<{ scan_state: string; failed: boolean; scan_attempts: number; scan_last_error: string | null }>(
    `select scan_state, scan_failed_at is not null as failed, scan_attempts, scan_last_error from attachment where id = $1`,
    [attachmentId],
  );
const notices = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string; body: string }[]).filter((n) => n.category === 'FILE_SCAN_FAILED');
const requeue = (a: TestActor, attachmentIds: string[], reason = 'Scanner outage over (synthetic)') => send(a, 'POST', '/v1/attachments/scan-failures/requeue', { attachmentIds, reason });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  const DOCS = ['document.upload.document', 'document.read.document'] as const;
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...DOCS] });
  hrB = await h.actor(B, 'HR_ADMINISTRATOR', { extra: [...DOCS] });
  sysadmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
  sysadminB = await h.actor(B, 'SYSTEM_ADMINISTRATOR');
  employeeId = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  employeeB = (await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B))).json().id;
  app = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), files, scanner: provider });
});

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

beforeEach(async () => {
  scanner.answer = async () => CLEAN;
  // Nothing left over from an earlier test is scanned in this one.
  await h.db.query(`update attachment set scan_failed_at = now(), scan_next_attempt_at = null where scan_state = 'PENDING_SCAN' and scan_failed_at is null`);
});

describe('a file whose scan could not be completed (I-84 item 8; I-73 item 1)', () => {
  it('stays unusable and is no finding: still PENDING_SCAN, never QUARANTINED, and the content is refused', async () => {
    const { documentId, attachmentId } = await failedUpload();
    expect(await fileState(attachmentId)).toEqual({ scan_state: 'PENDING_SCAN', failed: true, scan_attempts: 1, scan_last_error: 'SCANNER_ERROR' });
    expect((await send(hr, 'GET', `/v1/documents/${documentId}/content`)).json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'PENDING_SCAN' } });
  });

  it('H7 "scan": its uploader is told once, with the upload date and nothing about the file; a requeued file is not reported', async () => {
    await dispatchOutbox(h.pool, 500);
    const before = (await notices(hr)).length;
    await failedUpload();
    await dispatchOutbox(h.pool, 500);
    await dispatchOutbox(h.pool, 500);
    const told = await notices(hr);
    expect(told).toHaveLength(before + 1);
    expect(told[0]!.title).toBe('Uploaded file could not be checked');
    expect(told[0]!.body).toMatch(/^A file you uploaded on \d{4}-\d{2}-\d{2} could not be checked for malware yet, so it cannot be used\./);
    expect(JSON.stringify(told)).not.toContain('private-name-');
    // Requeued before the notice went out: the file is no longer failed, so nobody is told it is.
    const { attachmentId } = await failedUpload();
    expect((await requeue(sysadmin, [attachmentId])).statusCode).toBe(200);
    await dispatchOutbox(h.pool, 500);
    expect(await notices(hr)).toHaveLength(before + 1);
  });

  it('a System Administrator lists them for the whole company: ids, dates, attempts and the failure class, never the file', async () => {
    const { attachmentId } = await failedUpload();
    const { attachmentId: other } = await failedUpload(hrB, employeeB);
    const res = await send(sysadmin, 'GET', '/v1/attachments/scan-failures');
    expect(res.statusCode, res.body).toBe(200);
    const items = res.json().items as { id: string }[];
    expect(items.find((i) => i.id === attachmentId)).toEqual({ id: attachmentId, uploadedAt: expect.any(String), scanFailedAt: expect.any(String), scanAttempts: 1, scanLastError: 'SCANNER_ERROR' });
    expect(items.map((i) => i.id)).not.toContain(other);
    expect(res.body).not.toContain('private-name-');
    expect(res.body).not.toContain('application/pdf');
  });

  it('only a holder of the requeue duty over the whole company may list or requeue them', async () => {
    expect(BASELINE_ROLES.filter((r) => r.ceiling.includes(REQUEUE)).map((r) => r.code)).toEqual(['SYSTEM_ADMINISTRATOR']);
    expect(BASELINE_ROLES.filter((r) => r.defaultDuties.includes(REQUEUE)).map((r) => r.code)).toEqual(['SYSTEM_ADMINISTRATOR']);
    const { attachmentId } = await failedUpload();
    for (const a of [hr, await h.actor(A, 'EMPLOYEE', { employeeId }), await h.actor(A, 'AUDITOR')]) {
      expect((await send(a, 'GET', '/v1/attachments/scan-failures')).statusCode).toBe(403);
      expect((await requeue(a, [attachmentId])).statusCode).toBe(403);
    }
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    expect((await send(filtered, 'GET', '/v1/attachments/scan-failures')).json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
    expect((await requeue(filtered, [attachmentId])).json().error).toBe('SCOPE_EXCEEDS_ADMINISTRATOR');
    const without = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { duties: BASELINE_ROLES.find((r) => r.code === 'SYSTEM_ADMINISTRATOR')!.defaultDuties.filter((k) => k !== REQUEUE) });
    expect((await requeue(without, [attachmentId])).statusCode).toBe(403);
    expect((await fileState(attachmentId)).failed).toBe(true);
  });

  it('a requeue sends the named failed files back to the worker with a reason, audited; anything else is not requeued, all alike', async () => {
    const { documentId, attachmentId } = await failedUpload();
    const { attachmentId: foreign } = await failedUpload(hrB, employeeB);
    const { attachmentId: released } = await upload(hr, employeeId);
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ clean: 1 });
    const unknown = '00000000-0000-4000-8000-0000000000aa';
    expect((await requeue(sysadmin, [attachmentId], '   ')).json().error).toBe('REASON_REQUIRED');
    const res = await requeue(sysadmin, [attachmentId, foreign, released, unknown]);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ requeued: [attachmentId], notRequeued: [foreign, released, unknown].sort() });
    expect(await fileState(attachmentId)).toEqual({ scan_state: 'PENDING_SCAN', failed: false, scan_attempts: 0, scan_last_error: null });
    expect((await fileState(foreign)).failed).toBe(true);
    const audit = await h.one<{ action: string; actor_user_id: string; reason: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
      `select action, actor_user_id, reason, before_values as before, after_values as after from audit_event where resource_code = 'attachment' and record_key = $1 and action = 'SCAN_REQUEUED'`,
      [attachmentId],
    );
    expect(audit).toEqual({
      action: 'SCAN_REQUEUED',
      actor_user_id: sysadmin.user,
      reason: 'Scanner outage over (synthetic)',
      before: { operational: { scanState: 'PENDING_SCAN', scanFailed: true, attempts: 1, errorCode: 'SCANNER_ERROR' } },
      after: { operational: { scanState: 'PENDING_SCAN', scanFailed: false, attempts: 0 } },
    });
    // Requeued once, it is not requeued twice; the worker reaches the verdict, and only the verdict releases it.
    expect((await requeue(sysadmin, [attachmentId])).json()).toEqual({ requeued: [], notRequeued: [attachmentId] });
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 1, clean: 1 });
    expect((await fileState(attachmentId)).scan_state).toBe('CLEAN');
    expect((await send(hr, 'GET', `/v1/documents/${documentId}/content`)).statusCode).toBe(200);
  });

  it('a requeued file that fails again is marked again, within the same attempt limit, and its uploader is told again', async () => {
    await dispatchOutbox(h.pool, 500);
    const before = (await notices(hr)).length;
    const { attachmentId } = await failedUpload();
    expect((await requeue(sysadmin, [attachmentId])).json().requeued).toEqual([attachmentId]);
    scanner.answer = DOWN;
    expect(await scanDueAttachments(h.pool, files, provider, settings())).toMatchObject({ scanned: 1, failed: 1 });
    expect(await fileState(attachmentId)).toEqual({ scan_state: 'PENDING_SCAN', failed: true, scan_attempts: 1, scan_last_error: 'SCANNER_ERROR' });
    await dispatchOutbox(h.pool, 500);
    expect(await notices(hr)).toHaveLength(before + 2);
  });

  it('a System Administrator of another company neither sees nor requeues them', async () => {
    const { attachmentId } = await failedUpload();
    expect(((await send(sysadminB, 'GET', '/v1/attachments/scan-failures')).json().items as { id: string }[]).map((i) => i.id)).not.toContain(attachmentId);
    expect((await requeue(sysadminB, [attachmentId])).json()).toEqual({ requeued: [], notRequeued: [attachmentId] });
    expect((await fileState(attachmentId)).failed).toBe(true);
  });
});

describe('an upload scanned in the request (I-84 item 9; I-73 item 2; NFR-S09)', () => {
  it('at most the configured number run at once in a process; one more gets no verdict at once and the scanner is not asked', async () => {
    let asked = 0;
    const waiting: (() => void)[] = [];
    const slow: ScanProvider = {
      scan: () => {
        asked++;
        return new Promise<ScanVerdict>((resolve) => waiting.push(() => resolve(CLEAN)));
      },
    };
    const bounds = { timeoutMs: 10_000, inlineConcurrency: 2 };
    const first = scanInMemory(slow, Buffer.from('a'), bounds);
    const second = scanInMemory(slow, Buffer.from('b'), bounds);
    expect(await scanInMemory(slow, Buffer.from('c'), bounds)).toEqual({ verdict: 'ERROR' });
    expect(asked).toBe(2);
    for (const release of waiting.splice(0)) release();
    expect(await Promise.all([first, second])).toEqual([CLEAN, CLEAN]);
    // A slot is free again once a scan ends, also one that failed or timed out.
    expect(await scanInMemory(slow, Buffer.from('d'), { timeoutMs: 20, inlineConcurrency: 1 })).toEqual({ verdict: 'ERROR' });
    expect(await scanInMemory({ scan: async () => CLEAN }, Buffer.from('e'), { timeoutMs: 1_000, inlineConcurrency: 1 })).toEqual(CLEAN);
  });

  it('the limit is a named starting value, read from the environment', () => {
    const saved = process.env.SCAN_INLINE_CONCURRENCY;
    try {
      delete process.env.SCAN_INLINE_CONCURRENCY;
      expect(scanSettings().inlineConcurrency).toBe(4);
      process.env.SCAN_INLINE_CONCURRENCY = '9';
      expect(scanSettings().inlineConcurrency).toBe(9);
    } finally {
      if (saved === undefined) delete process.env.SCAN_INLINE_CONCURRENCY;
      else process.env.SCAN_INLINE_CONCURRENCY = saved;
    }
  });
});
