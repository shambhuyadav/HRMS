// Scan failures and replay on sensitive changes over HTTP (gates-10: ZT40, FR-104, FR-105, FR-106, BR-054, CI29). sensitive-change.api.test.ts
// holds independent approval, base conflicts, withdrawal and an unverified bank document; cutoff.api.test.ts the payroll cutoff;
// deferred-apply.api.test.ts the re-check of a scheduled change. Here: a request whose evidence the scan quarantined or has not finished,
// on submission and on approval, and the same decision sent again, in sequence and at the same moment, ending in exactly one DB116
// revision, one decision, one audit trail and one notice. Files reach PENDING_SCAN and QUARANTINED through the real upload route and the
// real scan job (a scanner in outage, then a verdict). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { buildApp } from '../../app.js';
import { devTokenVerifier } from '../../auth/tokens.js';
import { ASSIGNMENT_HEADER, COMPANY_HEADER } from '../../http/context.js';
import { memoryFileStore } from '../../storage/files.js';
import { EICAR_TEST_STRING, type ScanVerdict, scanPendingAttachments } from '../../storage/scan.js';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Company, type Harness, startHarness, type TestActor, tokenConfig } from '../../test/harness.js';
import { raceBehindLock } from '../../test/held-lock.fixtures.js';
import type { PermissionKey } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { applyDueChanges } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let otherReviewer: TestActor;
let verifier: TestActor;
let system: string;
let today: string;

const REVIEW: PermissionKey[] = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank'];
const BANK = { holderName: 'Synthetic Person', accountIdentifier: '000123456789', routingReference: 'SYNT0000001', countryCode: 'IN' };
const ADDRESS = { line1: '12 Synthetic Street', city: 'Testville', countryCode: 'IN' };
const errorOf = (res: { statusCode: number; json(): { error?: string } }) => [res.statusCode, res.json().error];
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

const pdf = (note: string) => Buffer.from(`%PDF-1.4\n% synthetic ${note} ${uniq('e')}\n%%EOF\n`).toString('base64');
const infected = () => Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF\n`, 'latin1').toString('base64');

// A second app on the same database whose scanner is in an outage: the upload is stored and stays PENDING_SCAN, as in production.
const outageFiles = memoryFileStore();
let outageApp: ReturnType<typeof buildApp>;
const documentBody = (contentBase64: string) => ({ documentType: 'GENERAL', fileName: 'evidence.pdf', contentBase64 });
const upload = async (a: TestActor, employeeId: string, content = pdf('evidence')) => {
  const res = await h.call(a, 'POST', `/v1/employees/${employeeId}/documents`, documentBody(content));
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { id: string; scanState: string };
};
const uploadWaitingForScan = async (a: TestActor, employeeId: string) => {
  const res = await outageApp.inject({
    method: 'POST',
    url: `/v1/employees/${employeeId}/documents`,
    payload: documentBody(pdf('waiting')),
    headers: { authorization: `Bearer ${a.token}`, [COMPANY_HEADER]: A.id, [ASSIGNMENT_HEADER]: a.assignment },
  });
  expect(res.statusCode, res.body).toBe(201);
  expect(res.json().scanState).toBe('PENDING_SCAN');
  return res.json().id as string;
};
/** The scan job finishing whatever is still waiting, with this verdict. */
const scanFinishes = (verdict: ScanVerdict) => scanPendingAttachments(h.pool, outageFiles, { scan: async () => verdict }, A.id);
const verify = (documentId: string) => h.call(verifier, 'POST', `/v1/documents/${documentId}/verification`, { decision: 'VERIFIED' });

const person = async () => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { dateOfBirth: '1990-04-12' }))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  return { id: e.id as string, actor: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) };
};
const draft = async (a: TestActor, category: string, values: Record<string, unknown>, evidenceDocumentIds: string[] = [], effectiveDate?: string) => {
  const res = await h.call(a, 'POST', '/v1/me/sensitive-changes', { reason: 'Synthetic update', category, values, evidenceDocumentIds, ...(effectiveDate ? { effectiveDate } : {}) });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().requestId as string;
};
const submit = (a: TestActor, id: string, expectedVersion = 1) => h.call(a, 'POST', `/v1/me/sensitive-changes/${id}/submit`, { expectedVersion });
const taskFor = async (requestId: string) => ((await h.call(hr, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; request: { id: string; evidence: { scanState: string }[] } }[]).find((t) => t.request?.id === requestId)!;
const startReview = (taskId: string) => h.call(hr, 'POST', `/v1/sensitive-changes/tasks/${taskId}/start-review`);
const decide = (taskId: string, body: Record<string, unknown>, a: TestActor = hr) => h.call(a, 'POST', `/v1/sensitive-changes/tasks/${taskId}/decision`, { idempotencyKey: uniq('sc-key-'), ...body });
const APPROVE = { decision: 'APPROVE', reason: 'Checked against synthetic evidence' };
/** A submitted request with its review started: the task an approval goes to. */
const inReview = async (a: TestActor, category: string, values: Record<string, unknown>, evidenceDocumentIds: string[] = [], effectiveDate?: string) => {
  const id = await draft(a, category, values, evidenceDocumentIds, effectiveDate);
  const submitted = await submit(a, id);
  expect(submitted.json().state, submitted.body).toBe('SUBMITTED');
  const { taskId } = await taskFor(id);
  expect((await startReview(taskId)).json().state).toBe('IN_REVIEW');
  return { id, taskId };
};

const stateOf = async (id: string) => (await h.one<{ state: string }>(`select state from employee_sensitive_change_request where id = $1`, [id])).state;
const transactionOf = async (id: string) => (await h.one<{ transaction_id: string }>(`select transaction_id from employee_sensitive_change_request where id = $1`, [id])).transaction_id;
const revisions = async (employeeId: string) =>
  (await h.db.query<{ revision: number; source_request_id: string; created_by: string; category: string }>(`select revision, source_request_id, created_by, category from employee_private_profile_revision where employee_id = $1 order by revision`, [employeeId])).rows;
const auditCount = async (id: string, action: string) =>
  (await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and resource_code = 'employee_sensitive_change_request' and record_key = $2 and action = $3`, [A.id, id, action])).n;
const decisions = async (taskId: string) => (await h.db.query<{ decision: string; actor_user_id: string }>(`select decision, actor_user_id from approval_decision where task_id = $1`, [taskId])).rows;
const outcomes = async (id: string) => (await h.db.query<{ outcome: string }>(`select payload->>'outcome' as outcome from outbox_event where company_id = $1 and topic = 'sensitive_change.outcome' and aggregate_id = $2 order by seq`, [A.id, id])).rows.map((r) => r.outcome);
const outcomeNotices = async (a: TestActor) => {
  await dispatchOutbox(h.pool, 500);
  return ((await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string }[]).filter((n) => n.category === 'SENSITIVE_CHANGE_OUTCOME').length;
};
const noApproval = async (id: string) => expect((await h.db.query(`select 1 from approval_instance where transaction_id = $1`, [await transactionOf(id)])).rowCount).toBe(0);
/** The lock every decision takes first (workflow/engine.ts lockTransaction). */
const transactionLock = (transactionId: string) => ({ sql: `select pg_advisory_xact_lock(hashtextextended('bt:' || $1, 0))`, params: [transactionId] });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REVIEW, 'employee.create.personal', 'employee.update.personal'] });
  otherReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
  verifier = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['document.read.document', 'document.verify.document'] });
  system = await h.makeUser();
  expect((await h.call(hr, 'PUT', '/v1/workflows/sensitive_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  outageApp = buildApp({ db: h.pool, verifier: devTokenVerifier(tokenConfig), files: outageFiles, scanner: { scan: async () => ({ verdict: 'ERROR' }) } });
});

afterAll(async () => {
  await outageApp?.close();
  await h?.stop();
});

describe('a file the scan quarantined cannot support a submission (FR-106, H4, ZT40)', () => {
  it('a bank change is refused and nothing at all is recorded; replacing the file lets it go through', async () => {
    const e = await person();
    const bad = await upload(e.actor, e.id, infected());
    expect(bad.scanState).toBe('QUARANTINED');
    const id = await draft(e.actor, 'BANK', BANK, [bad.id]);

    const before = await companyState(h, A.id);
    expect(errorOf(await submit(e.actor, id))).toEqual([422, 'EVIDENCE_UNUSABLE']);
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect(await stateOf(id)).toBe('DRAFT');
    await noApproval(id);
    expect(await revisions(e.id)).toEqual([]);

    // The file was the only thing wrong: the same request with a clean file is submitted.
    const clean = await upload(e.actor, e.id);
    const saved = await h.call(e.actor, 'PUT', `/v1/me/sensitive-changes/${id}`, { values: BANK, reason: 'Synthetic update', evidenceDocumentIds: [clean.id], expectedVersion: 1 });
    expect(saved.json()).toMatchObject({ state: 'DRAFT', version: 2 });
    expect((await submit(e.actor, id, 2)).json().state).toBe('SUBMITTED');
  });

  it('evidence the change does not need is held to the same rule: an address change with a quarantined file is refused', async () => {
    const e = await person();
    const bad = await upload(e.actor, e.id, infected());
    const id = await draft(e.actor, 'ADDRESS', ADDRESS, [bad.id]);
    expect(errorOf(await submit(e.actor, id))).toEqual([422, 'EVIDENCE_UNUSABLE']);
    expect(await stateOf(id)).toBe('DRAFT');
    await noApproval(id);
  });

  it('nor can a document a verifier rejected', async () => {
    const e = await person();
    const doc = await upload(e.actor, e.id);
    expect((await h.call(verifier, 'POST', `/v1/documents/${doc.id}/verification`, { decision: 'REJECTED', note: 'Synthetic: unreadable' })).statusCode).toBe(200);
    const id = await draft(e.actor, 'BANK', BANK, [doc.id]);
    expect(errorOf(await submit(e.actor, id))).toEqual([422, 'EVIDENCE_UNUSABLE']);
    expect(await stateOf(id)).toBe('DRAFT');
    await noApproval(id);
  });
});

describe('a file still waiting for its scan is not evidence (FR-106, H4, ZT40)', () => {
  it('a bank change waits: unreadable, unverifiable, approval refused and the master untouched; released and verified, it applies once', async () => {
    const e = await person();
    const waiting = await uploadWaitingForScan(e.actor, e.id);
    const { id, taskId } = await inReview(e.actor, 'BANK', BANK, [waiting]);
    expect((await taskFor(id)).request.evidence).toMatchObject([{ scanState: 'PENDING_SCAN' }]);

    const url = `/v1/sensitive-changes/${id}/evidence/${waiting}/content`;
    const read = await h.call(hr, 'GET', url);
    expect(read.statusCode).toBe(409);
    expect(read.json()).toMatchObject({ error: 'FILE_NOT_RELEASED', details: { scanState: 'PENDING_SCAN' } });
    expect(errorOf(await verify(waiting))).toEqual([409, 'FILE_NOT_RELEASED']);

    const before = await companyState(h, A.id);
    expect(errorOf(await decide(taskId, APPROVE))).toEqual([409, 'EVIDENCE_NOT_VERIFIED']);
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect(await stateOf(id)).toBe('IN_REVIEW');
    expect(await revisions(e.id)).toEqual([]);
    expect(await decisions(taskId)).toEqual([]);

    expect(await scanFinishes({ verdict: 'CLEAN' })).toMatchObject({ clean: 1, quarantined: 0 });
    // Released is not yet verified: the scan alone does not make it evidence.
    expect(errorOf(await decide(taskId, APPROVE))).toEqual([409, 'EVIDENCE_NOT_VERIFIED']);
    expect((await verify(waiting)).json()).toMatchObject({ verificationState: 'VERIFIED' });
    expect((await decide(taskId, APPROVE)).json()).toMatchObject({ state: 'APPLIED', replayed: false });
    expect((await revisions(e.id)).map((r) => [r.category, r.revision, r.source_request_id])).toEqual([['BANK', 1, id]]);
  });

  it('a change of birth date (identity-sensitive) waits the same way and the employee record does not move', async () => {
    const e = await person();
    const waiting = await uploadWaitingForScan(e.actor, e.id);
    const { id, taskId } = await inReview(e.actor, 'PERSONAL', { dateOfBirth: '1991-05-13' }, [waiting]);
    expect(errorOf(await decide(taskId, APPROVE))).toEqual([409, 'EVIDENCE_NOT_VERIFIED']);
    expect(await stateOf(id)).toBe('IN_REVIEW');
    expect((await h.one<{ d: string }>(`select to_char(date_of_birth, 'YYYY-MM-DD') as d from employee where id = $1`, [e.id])).d).toBe('1990-04-12');
    expect(await revisions(e.id)).toEqual([]);
    await scanFinishes({ verdict: 'CLEAN' });
  });

  it('quarantined while the review was open: approval of a bank change is refused though another file is verified; the reviewer can still return it', async () => {
    const e = await person();
    const good = await upload(e.actor, e.id);
    expect((await verify(good.id)).statusCode).toBe(200);
    const waiting = await uploadWaitingForScan(e.actor, e.id);
    const { id, taskId } = await inReview(e.actor, 'BANK', BANK, [good.id, waiting]);

    expect(await scanFinishes({ verdict: 'INFECTED', finding: 'EICAR-Test-File' })).toMatchObject({ quarantined: 1 });
    const before = await companyState(h, A.id);
    expect(errorOf(await decide(taskId, APPROVE))).toEqual([409, 'EVIDENCE_UNUSABLE']);
    expect(changedTables(before, await companyState(h, A.id))).toEqual([]);
    expect(await stateOf(id)).toBe('IN_REVIEW');
    expect(await revisions(e.id)).toEqual([]);
    expect(await decisions(taskId)).toEqual([]);

    const back = await decide(taskId, { decision: 'RETURN', employeeMessage: 'Replace the flagged file (synthetic)' });
    expect(back.json()).toMatchObject({ state: 'RETURNED', replayed: false });
    expect(await revisions(e.id)).toEqual([]);
  });

  it('quarantined while the review was open: an address change, whose evidence is optional, is refused too', async () => {
    const e = await person();
    const waiting = await uploadWaitingForScan(e.actor, e.id);
    const { id, taskId } = await inReview(e.actor, 'ADDRESS', ADDRESS, [waiting]);
    await scanFinishes({ verdict: 'INFECTED', finding: 'EICAR-Test-File' });
    expect(errorOf(await decide(taskId, APPROVE))).toEqual([409, 'EVIDENCE_UNUSABLE']);
    expect(await stateOf(id)).toBe('IN_REVIEW');
    expect(await revisions(e.id)).toEqual([]);
  });

  it('as built: optional evidence still waiting does not hold up an address change, and the document stays unverified (owner question, see the report)', async () => {
    const e = await person();
    const waiting = await uploadWaitingForScan(e.actor, e.id);
    const { taskId } = await inReview(e.actor, 'ADDRESS', ADDRESS, [waiting]);
    expect((await decide(taskId, APPROVE)).json()).toMatchObject({ state: 'APPLIED' });
    expect((await h.one<{ v: string }>(`select verification_state as v from employee_document where id = $1`, [waiting])).v).toBe('UNVERIFIED');
    await scanFinishes({ verdict: 'CLEAN' });
  });
});

describe('the same decision again has no second effect (ZT07, ZT40, CI29, FR-104)', () => {
  it('an approval replayed under its key answers as the first did: one revision, one decision, one audit trail, one notice', async () => {
    const e = await person();
    const { id, taskId } = await inReview(e.actor, 'ADDRESS', ADDRESS);
    const key = uniq('sc-key-');
    const first = await decide(taskId, { ...APPROVE, idempotencyKey: key });
    expect(first.json()).toEqual({ requestId: id, state: 'APPLIED', replayed: false });
    const notified = await outcomeNotices(e.actor);
    expect(notified).toBe(1);

    expect((await decide(taskId, { ...APPROVE, idempotencyKey: key })).json()).toEqual({ requestId: id, state: 'APPLIED', replayed: true });
    // A replay is the recorded result even if the words differ; it never makes a second decision.
    expect((await decide(taskId, { decision: 'REJECT', employeeMessage: 'Changed my mind (synthetic)', idempotencyKey: key })).json()).toEqual({ requestId: id, state: 'APPLIED', replayed: true });

    const rows = await revisions(e.id);
    expect(rows).toEqual([{ revision: 1, source_request_id: id, created_by: hr.user, category: 'ADDRESS' }]);
    expect(await decisions(taskId)).toEqual([{ decision: 'APPROVE', actor_user_id: hr.user }]);
    expect([await auditCount(id, 'APPROVE'), await auditCount(id, 'APPLY'), await auditCount(id, 'REJECT')]).toEqual([1, 1, 0]);
    expect(await outcomes(id)).toEqual(['APPLIED']);
    expect(await outcomeNotices(e.actor)).toBe(notified);
    expect(await stateOf(id)).toBe('APPLIED');
  });

  it('a new key on a decided task is refused; a key of another task is refused; the task’s real reviewer alone gets the replay', async () => {
    const e = await person();
    const { id, taskId } = await inReview(e.actor, 'ADDRESS', ADDRESS);
    const key = uniq('sc-key-');
    expect((await decide(taskId, { ...APPROVE, idempotencyKey: key })).statusCode).toBe(200);

    expect(errorOf(await decide(taskId, APPROVE))).toEqual([409, 'TASK_CLOSED']);
    expect(errorOf(await decide(taskId, { ...APPROVE, idempotencyKey: key }, otherReviewer))).toEqual([404, 'NOT_FOUND']);

    const other = await person();
    const second = await inReview(other.actor, 'ADDRESS', ADDRESS);
    expect(errorOf(await decide(second.taskId, { ...APPROVE, idempotencyKey: key }))).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect(await stateOf(second.id)).toBe('IN_REVIEW');
    expect(await revisions(other.id)).toEqual([]);
    expect((await revisions(e.id)).map((r) => r.source_request_id)).toEqual([id]);
  });

  it('a return replayed under its key leaves one return and the employee’s message as first written', async () => {
    const e = await person();
    const { id, taskId } = await inReview(e.actor, 'ADDRESS', ADDRESS);
    const key = uniq('sc-key-');
    const body = { decision: 'RETURN', employeeMessage: 'First message (synthetic)', idempotencyKey: key };
    expect((await decide(taskId, body)).json()).toEqual({ requestId: id, state: 'RETURNED', replayed: false });
    expect((await decide(taskId, { ...body, employeeMessage: 'Second message (synthetic)' })).json()).toEqual({ requestId: id, state: 'RETURNED', replayed: true });
    expect((await h.one<{ m: string }>(`select employee_message as m from employee_sensitive_change_request where id = $1`, [id])).m).toBe('First message (synthetic)');
    expect(await decisions(taskId)).toEqual([{ decision: 'RETURN', actor_user_id: hr.user }]);
    expect(await auditCount(id, 'RETURN')).toBe(1);
    expect(await outcomes(id)).toEqual(['RETURNED']);
  });

  it('H4: a return or rejection needs only its explanation to the employee; a private note, when given, stays the recorded reason', async () => {
    const reasonOf = async (taskId: string) => (await h.one<{ reason: string }>(`select reason from approval_decision where task_id = $1`, [taskId])).reason;
    const a = await person();
    const returned = await inReview(a.actor, 'ADDRESS', ADDRESS);
    expect((await decide(returned.taskId, { decision: 'RETURN', employeeMessage: 'Please correct the city (synthetic)' })).json()).toMatchObject({ state: 'RETURNED' });
    expect(await reasonOf(returned.taskId)).toBe('Please correct the city (synthetic)');

    const b = await person();
    const rejected = await inReview(b.actor, 'ADDRESS', ADDRESS);
    expect((await decide(rejected.taskId, { decision: 'REJECT', employeeMessage: 'Not acceptable (synthetic)' })).json()).toMatchObject({ state: 'REJECTED' });
    expect(await reasonOf(rejected.taskId)).toBe('Not acceptable (synthetic)');

    const c = await person();
    const withNote = await inReview(c.actor, 'ADDRESS', ADDRESS);
    expect((await decide(withNote.taskId, { decision: 'RETURN', reason: 'Private note (synthetic)', employeeMessage: 'Please correct (synthetic)' })).json()).toMatchObject({ state: 'RETURNED' });
    expect(await reasonOf(withNote.taskId)).toBe('Private note (synthetic)');
    expect((await h.one<{ m: string }>(`select employee_message as m from employee_sensitive_change_request where id = $1`, [withNote.id])).m).toBe('Please correct (synthetic)');
  });
});

describe('decisions at the same moment end in one result (ZT11, ZT40, CI29)', () => {
  it('the same approval twice: one applies, the other is the replay; one revision, one decision, one audit trail, one notice', async () => {
    const e = await person();
    const { id, taskId } = await inReview(e.actor, 'ADDRESS', ADDRESS);
    const key = uniq('sc-key-');
    const [one, two] = await raceBehindLock(h, transactionLock(await transactionOf(id)), [() => decide(taskId, { ...APPROVE, idempotencyKey: key }), () => decide(taskId, { ...APPROVE, idempotencyKey: key })]);
    expect([one!.statusCode, two!.statusCode]).toEqual([200, 200]);
    expect([one!.json().replayed, two!.json().replayed].sort()).toEqual([false, true]);
    expect([one!.json().state, two!.json().state]).toEqual(['APPLIED', 'APPLIED']);
    expect((await revisions(e.id)).map((r) => [r.revision, r.source_request_id])).toEqual([[1, id]]);
    expect(await decisions(taskId)).toHaveLength(1);
    expect([await auditCount(id, 'APPROVE'), await auditCount(id, 'APPLY')]).toEqual([1, 1]);
    expect(await outcomes(id)).toEqual(['APPLIED']);
    expect(await outcomeNotices(e.actor)).toBe(1);
  });

  it('two approvals under different keys: one applies, the other finds the task closed, and the master moved once', async () => {
    const e = await person();
    const { id, taskId } = await inReview(e.actor, 'ADDRESS', ADDRESS);
    const results = await raceBehindLock(h, transactionLock(await transactionOf(id)), [() => decide(taskId, APPROVE), () => decide(taskId, APPROVE)]);
    expect(results.map(errorOf).sort()).toEqual([[200, undefined], [409, 'TASK_CLOSED']]);
    expect((await revisions(e.id)).map((r) => r.revision)).toEqual([1]);
    expect(await decisions(taskId)).toHaveLength(1);
    expect([await auditCount(id, 'APPROVE'), await auditCount(id, 'APPLY')]).toEqual([1, 1]);
    expect(await outcomes(id)).toEqual(['APPLIED']);
  });

  it('an approval and a rejection: exactly one is decided, and the master follows that one', async () => {
    const e = await person();
    const { id, taskId } = await inReview(e.actor, 'ADDRESS', ADDRESS);
    const bodies = [APPROVE, { decision: 'REJECT', employeeMessage: 'Not acceptable (synthetic)' }];
    const results = await raceBehindLock(h, transactionLock(await transactionOf(id)), bodies.map((b) => () => decide(taskId, b)));
    expect(results.map(errorOf).sort()).toEqual([[200, undefined], [409, 'TASK_CLOSED']]);
    const approved = results[0]!.statusCode === 200;
    expect(await stateOf(id)).toBe(approved ? 'APPLIED' : 'REJECTED');
    expect((await revisions(e.id)).length).toBe(approved ? 1 : 0);
    expect((await decisions(taskId)).map((d) => d.decision)).toEqual([approved ? 'APPROVE' : 'REJECT']);
    expect(await outcomes(id)).toEqual([approved ? 'APPLIED' : 'REJECTED']);
  });

  it('the daily job running twice at once applies a scheduled change once', async () => {
    const e = await person();
    const on = addDays(today, 3);
    const { id, taskId } = await inReview(e.actor, 'ADDRESS', ADDRESS, [], on);
    expect((await decide(taskId, APPROVE)).json().state).toBe('SCHEDULED');
    const results = await raceBehindLock(h, transactionLock(await transactionOf(id)), [() => applyDueChanges(h.pool, A.id, on, system), () => applyDueChanges(h.pool, A.id, on, system)]);
    expect(results.map((r) => r.applied).sort()).toEqual([0, 1]);
    expect(await stateOf(id)).toBe('APPLIED');
    expect((await revisions(e.id)).map((r) => [r.revision, r.created_by])).toEqual([[1, system]]);
    expect(await auditCount(id, 'APPLY')).toBe(1);
    expect(await outcomes(id)).toEqual(['SCHEDULED', 'APPLIED']);
  });
});
