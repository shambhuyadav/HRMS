// Sensitive private-profile changes over HTTP (FR-104, FR-105; H1/BR-053 own-ESS; H2; H4; DB115/DB116; BR-054;
// BR-055). Synthetic data only: example.test addresses, a fictitious bank and made-up account identifiers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { applyDueChanges } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hrNoGrant: TestActor;
let employee: TestActor;
let colleague: TestActor;
let employeeEmp: string;
let colleagueEmp: string;
let today: string;

const REVIEW: `${string}.${string}.${string}`[] = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank'];
const pdf = Buffer.from('%PDF-1.4\n% synthetic evidence\n%%EOF\n').toString('base64');

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const draft = (a: TestActor, body: Record<string, unknown>) => h.call(a, 'POST', '/v1/me/sensitive-changes', { reason: 'Synthetic update', ...body });
const submit = (a: TestActor, id: string, expectedVersion: number) => h.call(a, 'POST', `/v1/me/sensitive-changes/${id}/submit`, { expectedVersion });
const tasks = async () =>
  (await h.call(hr, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; transactionId: string; request: Record<string, unknown> & { id: string } }[];
const taskFor = async (requestId: string) => (await tasks()).find((t) => t.request?.id === requestId)!;
const decide = (taskId: string, body: Record<string, unknown>) => h.call(hr, 'POST', `/v1/sensitive-changes/tasks/${taskId}/decision`, { idempotencyKey: uniq('sc-key-'), ...body });
const startReview = (taskId: string) => h.call(hr, 'POST', `/v1/sensitive-changes/tasks/${taskId}/start-review`);
const approve = async (requestId: string) => {
  const t = await taskFor(requestId);
  expect((await startReview(t.taskId)).json().state).toBe('IN_REVIEW');
  return decide(t.taskId, { decision: 'APPROVE', reason: 'Verified against synthetic evidence' });
};
const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];
// FR-106: the employee uploads their own evidence (own-ESS); an independent HR user verifies the released file.
const upload = async (a: TestActor, employeeId: string) =>
  (await h.call(a, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'evidence.pdf', contentBase64: pdf })).json().id as string;
const verify = (documentId: string) => h.call(hr, 'POST', `/v1/documents/${documentId}/verification`, { decision: 'VERIFIED' });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: [...REVIEW, 'document.read.document', 'document.verify.document', 'employee.create.personal', 'employee.update.personal'] });
  hrNoGrant = await h.actor(A, 'HR_ADMINISTRATOR');
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { dateOfBirth: '1990-04-12' }))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  employeeEmp = await person();
  colleagueEmp = await person();
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueEmp });
  expect((await h.call(hr, 'PUT', '/v1/workflows/sensitive_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).statusCode).toBe(200);
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
});

afterAll(async () => {
  await h?.stop();
});

describe('own private profile (H1/BR-053, H3 TN01/TN03)', () => {
  it('shows the employee their own values and nobody else’s; other roles need the Admin grant', async () => {
    const own = await h.call(employee, 'GET', '/v1/me/private-profile');
    expect(own.statusCode).toBe(200);
    expect(own.json()).toMatchObject({ employeeId: employeeEmp, personal: { revision: 0, values: { dateOfBirth: '1990-04-12' } }, address: { revision: 0, values: {} }, bank: { masked: true } });
    // Altered identifiers never reach another employee's record.
    expect((await h.call(employee, 'GET', `/v1/employees/${colleagueEmp}/private-profile`)).statusCode).toBe(404);
    expect((await h.call(employee, 'GET', `/v1/employees/${colleagueEmp}/sensitive-changes`)).statusCode).toBe(404);
    // An HR Administrator without the confidential grant is refused, and the refusal is audited.
    expect((await h.call(hrNoGrant, 'GET', `/v1/employees/${employeeEmp}/private-profile`)).statusCode).toBe(403);
    expect((await h.call(hrNoGrant, 'GET', '/v1/sensitive-changes/tasks/mine')).statusCode).toBe(403);
    // Admin roles cannot submit own-ESS requests from their operational context (BR-055).
    expect((await draft(hr, { category: 'ADDRESS', values: { line1: '1 Synthetic Road', city: 'Testville', countryCode: 'IN' } })).statusCode).toBe(403);
  });
});

describe('address change: draft, submit, independent review, application (FR-104)', () => {
  it('keeps the master unchanged until approval, then appends one revision', async () => {
    const created = await draft(employee, { category: 'ADDRESS', values: { line1: '12 Synthetic Street', city: 'Testville', postalCode: '560001', countryCode: 'in' } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ state: 'DRAFT', changedFields: ['city', 'countryCode', 'line1', 'postalCode'], evidenceRequired: false, effectiveDate: today });
    const id = created.json().requestId as string;
    // A second open request for the same details is refused.
    expect((await draft(employee, { category: 'ADDRESS', values: { line1: '99 Other Road', city: 'Testville', countryCode: 'IN' } })).json().error).toBe('OPEN_REQUEST_EXISTS');
    expect((await h.call(employee, 'GET', '/v1/me/private-profile')).json().address).toMatchObject({ revision: 0, values: {} });

    expect((await submit(employee, id, 1)).json()).toEqual({ requestId: id, state: 'SUBMITTED' });
    // A submitted request is kept as sent.
    expect((await h.call(employee, 'PUT', `/v1/me/sensitive-changes/${id}`, { values: { city: 'Elsewhere' }, reason: 'x', expectedVersion: 2 })).json().error).toBe('INVALID_STATE');

    await dispatchOutbox(h.pool);
    const notice = (await inbox(hr)).find((n) => n.category === 'SENSITIVE_CHANGE_SUBMITTED')!;
    expect(notice.body).toContain('change of address');
    expect(notice.body).not.toContain('Synthetic Street');

    const t = await taskFor(id);
    expect(t.request).toMatchObject({ state: 'SUBMITTED', category: 'ADDRESS', proposed: { line1: '12 Synthetic Street', countryCode: 'IN' }, current: {}, baseHolds: true, reason: 'Synthetic update' });
    expect((await decide(t.taskId, { decision: 'APPROVE', reason: 'ok' })).json().error).toBe('REVIEW_NOT_STARTED');
    expect((await startReview(t.taskId)).json().state).toBe('IN_REVIEW');
    expect((await decide(t.taskId, { decision: 'APPROVE' })).json().error).toBe('REASON_REQUIRED');
    const approved = await decide(t.taskId, { decision: 'APPROVE', reason: 'Verified against synthetic evidence' });
    expect(approved.json()).toMatchObject({ requestId: id, state: 'APPLIED' });

    expect((await h.call(employee, 'GET', '/v1/me/private-profile')).json().address).toEqual({
      revision: 1,
      effectiveFrom: today,
      values: { line1: '12 Synthetic Street', city: 'Testville', postalCode: '560001', countryCode: 'IN' },
    });
    const mine = (await h.call(employee, 'GET', '/v1/me/sensitive-changes')).json().items.find((r: { id: string }) => r.id === id);
    expect(mine).toMatchObject({ state: 'APPLIED', decisions: [{ decision: 'APPROVE' }], employeeMessage: null });
    // The reviewer's private note never reaches the employee.
    expect(JSON.stringify(mine)).not.toContain('Verified against');

    await dispatchOutbox(h.pool);
    expect((await inbox(employee)).find((n) => n.category === 'SENSITIVE_CHANGE_OUTCOME')!.body).toBe(`Your change of address effective ${today} was applied.`);

    // Values are stored only as envelopes; audit and outbox carry field names, never values.
    const stored = await h.one<{ p: string; v: string }>(
      `select r.proposed_payload as p, v.payload as v from employee_sensitive_change_request r join employee_private_profile_revision v on v.company_id = r.company_id and v.id = r.applied_revision_id where r.id = $1`,
      [id],
    );
    expect(stored.p.startsWith('v1.')).toBe(true);
    expect(`${stored.p}${stored.v}`).not.toContain('Synthetic');
    const trail = await h.one<{ t: string }>(`select coalesce(string_agg(coalesce(before_values::text, '') || after_values::text, ' '), '') as t from audit_event where company_id = $1 and record_key = $2`, [A.id, id]);
    expect(trail.t).toContain('changedFields');
    expect(trail.t).not.toContain('Synthetic Street');
    const events = await h.one<{ t: string }>(`select coalesce(string_agg(payload::text, ' '), '') as t from outbox_event where company_id = $1 and aggregate_id = $2`, [A.id, id]);
    expect(events.t).not.toContain('Synthetic');
  });

  it('refuses unknown fields, invalid values, past dates and no-op proposals', async () => {
    const err = async (body: Record<string, unknown>) => (await draft(colleague, body)).json().error;
    expect(await err({ category: 'PERSONAL', values: { salary: '100' } })).toBe('UNKNOWN_FIELD');
    expect(await err({ category: 'PERSONAL', values: { personalEmail: 'not-an-email' } })).toBe('INVALID_FIELD');
    expect(await err({ category: 'PERSONAL', values: { dateOfBirth: '2027-02-30' } })).toBe('INVALID_FIELD');
    expect(await err({ category: 'PERSONAL', values: { dateOfBirth: '1990-04-12' } })).toBe('NO_CHANGE');
    expect(await err({ category: 'ADDRESS', values: { line1: '1 Synthetic Road' } })).toBe('FIELD_REQUIRED');
    expect(await err({ category: 'ADDRESS', effectiveDate: addDays(today, -1), values: { line1: '1 Synthetic Road', city: 'Testville', countryCode: 'IN' } })).toBe('EFFECTIVE_DATE_IN_PAST');
    expect(await err({ category: 'BANK', values: { holderName: 'Synthetic Person', accountIdentifier: '12-34', countryCode: 'IN' } })).toBe('INVALID_FIELD');
  });
});

describe('bank change: evidence, masking and leading zeros (FR-105, H3 TN03)', () => {
  it('needs the employee’s own evidence and shows full values only to the owner’s request and eligible reviewers', async () => {
    const created = await draft(employee, { category: 'BANK', values: { holderName: 'Synthetic Person', accountIdentifier: '0001 2345 6789', routingReference: 'synt0000001', countryCode: 'IN' } });
    expect(created.json()).toMatchObject({ state: 'DRAFT', evidenceRequired: true });
    const id = created.json().requestId as string;
    expect((await submit(employee, id, 1)).json().error).toBe('EVIDENCE_REQUIRED');

    // Another employee's document is not evidence for this request.
    const foreign = await upload(colleague, colleagueEmp);
    const values = { holderName: 'Synthetic Person', accountIdentifier: '000123456789', routingReference: 'SYNT0000001', countryCode: 'IN' };
    expect((await h.call(employee, 'PUT', `/v1/me/sensitive-changes/${id}`, { values, reason: 'New synthetic account', evidenceDocumentIds: [foreign], expectedVersion: 1 })).json().error).toBe(
      'INVALID_EVIDENCE',
    );
    const own = await upload(employee, employeeEmp);
    const saved = await h.call(employee, 'PUT', `/v1/me/sensitive-changes/${id}`, { values, reason: 'New synthetic account', evidenceDocumentIds: [own], expectedVersion: 1 });
    expect(saved.json()).toMatchObject({ state: 'DRAFT', version: 2 });
    // The colleague cannot touch this request by its id.
    expect((await submit(colleague, id, 2)).statusCode).toBe(404);
    expect((await submit(employee, id, 2)).json().state).toBe('SUBMITTED');

    const t = await taskFor(id);
    expect(t.request).toMatchObject({
      proposed: { accountIdentifier: '000123456789' },
      evidenceRequired: true,
      evidence: [{ documentId: own, documentType: 'GENERAL', scanState: 'CLEAN', verificationState: 'UNVERIFIED' }],
    });
    // H4 / FR-106: bank changes need verified evidence before approval.
    expect((await approve(id)).json().error).toBe('EVIDENCE_NOT_VERIFIED');
    expect((await verify(own)).json()).toMatchObject({ verificationState: 'VERIFIED' });
    expect((await decide(t.taskId, { decision: 'APPROVE', reason: 'Verified against synthetic evidence' })).json().state).toBe('APPLIED');
    // FR-106: the evidence file is readable by its owner and the assigned reviewer only.
    const evidenceUrl = `/v1/sensitive-changes/${id}/evidence/${own}/content`;
    expect((await h.call(hr, 'GET', evidenceUrl)).statusCode).toBe(200);
    expect((await h.call(employee, 'GET', evidenceUrl)).statusCode).toBe(200);
    expect((await h.call(colleague, 'GET', evidenceUrl)).statusCode).toBe(404);
    expect((await h.call(hrNoGrant, 'GET', evidenceUrl)).statusCode).toBe(403);

    const mine = (await h.call(employee, 'GET', '/v1/me/private-profile')).json().bank;
    expect(mine).toEqual({ revision: 1, effectiveFrom: today, masked: true, values: { holderName: 'Synthetic Person', accountIdentifier: '••••6789', routingReference: 'SYNT0000001', countryCode: 'IN' } });
    const admin = (await h.call(hr, 'GET', `/v1/employees/${employeeEmp}/private-profile`)).json().bank;
    expect(admin).toMatchObject({ masked: false, values: { accountIdentifier: '000123456789' } });

    // A second bank change shows the reviewer the previous account masked, the proposal in full.
    const next = await draft(employee, { category: 'BANK', values: { accountIdentifier: '000987654321' }, evidenceDocumentIds: [own] });
    expect((await submit(employee, next.json().requestId, 1)).json().state).toBe('SUBMITTED');
    const t2 = await taskFor(next.json().requestId);
    expect(t2.request).toMatchObject({ before: { accountIdentifier: '••••6789' }, proposed: { accountIdentifier: '000987654321' }, current: { accountIdentifier: '••••6789' } });
    expect(JSON.stringify(t2.request.current)).not.toContain('000123456789');
    await decide(t2.taskId, { decision: 'REJECT', employeeMessage: 'Synthetic rejection for the test' });
  });
});

describe('return, revision, conflict and scheduling (H2)', () => {
  it('a returned request is revised through a new request that supersedes it', async () => {
    const id = (await draft(colleague, { category: 'PERSONAL', values: { personalEmail: 'colleague.private@example.test' } })).json().requestId as string;
    await submit(colleague, id, 1);
    const t = await taskFor(id);
    expect((await decide(t.taskId, { decision: 'RETURN', reason: 'private note' })).json().error).toBe('EMPLOYEE_MESSAGE_REQUIRED');
    expect((await decide(t.taskId, { decision: 'RETURN', reason: 'private note', employeeMessage: 'Please use your current address' })).json().state).toBe('RETURNED');
    const returned = (await h.call(colleague, 'GET', '/v1/me/sensitive-changes')).json().items.find((r: { id: string }) => r.id === id);
    expect(returned).toMatchObject({ state: 'RETURNED', employeeMessage: 'Please use your current address' });
    expect(JSON.stringify(returned)).not.toContain('private note');

    const revised = await h.call(colleague, 'POST', `/v1/me/sensitive-changes/${id}/revise`);
    expect(revised.statusCode).toBe(201);
    expect(revised.json()).toMatchObject({ state: 'DRAFT', changedFields: ['personalEmail'] });
    expect((await h.call(colleague, 'POST', `/v1/me/sensitive-changes/${id}/revise`)).json().error).toBe('ALREADY_REVISED');
    const listed = (await h.call(colleague, 'GET', '/v1/me/sensitive-changes')).json().items.find((r: { id: string }) => r.id === revised.json().requestId);
    expect(listed).toMatchObject({ supersedesRequestId: id, proposed: { personalEmail: 'colleague.private@example.test' } });
    expect((await h.call(colleague, 'POST', `/v1/me/sensitive-changes/${revised.json().requestId}/withdraw`)).json().state).toBe('WITHDRAWN');
  });

  it('a base changed by an Admin after submission ends the request in CONFLICT, never overwriting', async () => {
    const created = await draft(employee, { category: 'PERSONAL', values: { dateOfBirth: '1991-05-20' } });
    expect(created.json().evidenceRequired).toBe(true);
    const id = created.json().requestId as string;
    const birthEvidence = await upload(employee, employeeEmp);
    await h.call(employee, 'PUT', `/v1/me/sensitive-changes/${id}`, { values: { dateOfBirth: '1991-05-20' }, reason: 'Synthetic correction', evidenceDocumentIds: [birthEvidence], expectedVersion: 1 });
    expect((await submit(employee, id, 2)).json().state).toBe('SUBMITTED');
    const version = (await h.one<{ version: number }>(`select version from employee where id = $1`, [employeeEmp])).version;
    expect((await h.call(hr, 'PATCH', `/v1/employees/${employeeEmp}`, { expectedVersion: version, dateOfBirth: '1990-04-13' })).statusCode).toBe(200);

    const t = await taskFor(id);
    expect(t.request.baseHolds).toBe(false);
    expect((await approve(id)).json().state).toBe('CONFLICT');
    expect((await h.one<{ d: string }>(`select date_of_birth as d from employee where id = $1`, [employeeEmp])).d).toBe('1990-04-13');
    expect(await h.one<{ n: number }>(`select count(*)::int as n from employee_private_profile_revision where employee_id = $1 and category = 'PERSONAL'`, [employeeEmp])).toEqual({ n: 0 });

    // Rebasing creates a new draft whose before-values are the current ones.
    const rebased = await h.call(employee, 'POST', `/v1/me/sensitive-changes/${id}/revise`);
    expect(rebased.statusCode).toBe(201);
    const listed = (await h.call(employee, 'GET', '/v1/me/sensitive-changes')).json().items.find((r: { id: string }) => r.id === rebased.json().requestId);
    expect(listed).toMatchObject({ before: { dateOfBirth: '1990-04-13' }, proposed: { dateOfBirth: '1991-05-20' } });
    expect((await submit(employee, rebased.json().requestId, 1)).json().state).toBe('SUBMITTED');
    expect((await verify(birthEvidence)).statusCode).toBe(200);
    expect((await approve(rebased.json().requestId)).json().state).toBe('APPLIED');
    expect((await h.one<{ d: string }>(`select date_of_birth as d from employee where id = $1`, [employeeEmp])).d).toBe('1991-05-20');
  });

  it('a future-dated approval is scheduled and applied on its effective date by the daily job', async () => {
    const on = addDays(today, 3);
    const id = (await draft(employee, { category: 'ADDRESS', effectiveDate: on, values: { line1: '7 Future Lane', line2: null } })).json().requestId as string;
    await submit(employee, id, 1);
    expect((await approve(id)).json().state).toBe('SCHEDULED');
    expect((await h.call(employee, 'GET', '/v1/me/private-profile')).json().address.revision).toBe(1);

    const system = await h.makeUser();
    expect(await applyDueChanges(h.pool, A.id, addDays(on, -1), system)).toEqual({ due: 0, applied: 0, conflicts: 0 });
    expect(await applyDueChanges(h.pool, A.id, on, system)).toEqual({ due: 1, applied: 1, conflicts: 0 });
    expect(await applyDueChanges(h.pool, A.id, on, system)).toEqual({ due: 0, applied: 0, conflicts: 0 });
    const intervals = await h.db.query<{ revision: number; f: string; t: string | null }>(
      `select revision, to_char(effective_from, 'YYYY-MM-DD') as f, to_char(effective_to, 'YYYY-MM-DD') as t from employee_private_profile_revision
        where employee_id = $1 and category = 'ADDRESS' order by revision`,
      [employeeEmp],
    );
    expect(intervals.rows).toEqual([
      { revision: 1, f: today, t: on },
      { revision: 2, f: on, t: null },
    ]);
  });

  it('the employee can withdraw a request under review; the reviewer task closes', async () => {
    const id = (await draft(colleague, { category: 'ADDRESS', values: { line1: '3 Withdrawn Way', city: 'Testville', countryCode: 'IN' } })).json().requestId as string;
    await submit(colleague, id, 1);
    const t = await taskFor(id);
    await startReview(t.taskId);
    expect((await h.call(colleague, 'POST', `/v1/me/sensitive-changes/${id}/withdraw`)).json().state).toBe('WITHDRAWN');
    expect((await decide(t.taskId, { decision: 'APPROVE', reason: 'late' })).json().error).toBe('TASK_CLOSED');
    expect((await tasks()).some((x) => x.request?.id === id)).toBe(false);
  });
});
