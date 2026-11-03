// An employee's change history as an Admin reads it (GET /v1/employees/:id/sensitive-changes) under FR-098/BR-044,
// H3 TN03 ("submitted full fields limited to owner and eligible reviewers") and I-18 (masked bank summary; previous
// bank values masked for reviewers too). A BANK account identifier is shown in full only to the reviewer assigned to
// the open request, or with the bank field grant in the same assignment for the account in force; a draft, a pending,
// returned or rejected proposal and an account since replaced stay masked.
// Synthetic data only: a fictitious bank and made-up account identifiers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
/** The only listed reviewer; no bank field grant. */
let reviewer: TestActor;
/** Reads the change history only. */
let reader: TestActor;
/** Reads the change history and holds the bank field grant in the same assignment. */
let bankReader: TestActor;
let employee: TestActor;
let employeeId: string;

const pdf = Buffer.from('%PDF-1.4\n% synthetic evidence\n%%EOF\n').toString('base64');
const FIRST = '000111222333';
const SECOND = '000444555666';
const THIRD = '000777888999';
const FOURTH = '000123450000';

interface Item {
  id: string;
  state: string;
  proposed: Record<string, string | null>;
  before: Record<string, string | null>;
}

async function history(a: TestActor, url = `/v1/employees/${employeeId}/sensitive-changes`) {
  const res = await h.call(a, 'GET', url);
  expect(res.statusCode).toBe(200);
  const items = res.json().items as Item[];
  return { body: res.body, of: (id: string) => items.find((i) => i.id === id)! };
}

/** The employee drafts and submits a BANK change with their own evidence, which the reviewer verifies. */
async function submitBank(accountIdentifier: string): Promise<string> {
  const doc = (await h.call(employee, 'POST', `/v1/employees/${employeeId}/documents`, { documentType: 'GENERAL', fileName: 'bank-letter.pdf', contentBase64: pdf })).json().id as string;
  expect((await h.call(reviewer, 'POST', `/v1/documents/${doc}/verification`, { decision: 'VERIFIED' })).statusCode).toBe(200);
  const created = await h.call(employee, 'POST', '/v1/me/sensitive-changes', {
    category: 'BANK',
    values: { holderName: 'Synthetic Person', accountIdentifier, routingReference: 'SYNT0000001', countryCode: 'IN' },
    reason: 'New synthetic account',
    evidenceDocumentIds: [doc],
  });
  expect(created.statusCode).toBe(201);
  const id = created.json().requestId as string;
  expect((await h.call(employee, 'POST', `/v1/me/sensitive-changes/${id}/submit`, { expectedVersion: 1 })).json().state).toBe('SUBMITTED');
  return id;
}

async function taskOf(requestId: string) {
  const items = (await h.call(reviewer, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string; request: (Item & { current: unknown }) | null }[];
  return items.find((t) => t.request?.id === requestId)!;
}

const decide = (taskId: string, body: Record<string, unknown>) => h.call(reviewer, 'POST', `/v1/sensitive-changes/tasks/${taskId}/decision`, { idempotencyKey: uniq('sc-key-'), ...body });

async function approve(requestId: string) {
  const { taskId } = await taskOf(requestId);
  expect((await h.call(reviewer, 'POST', `/v1/sensitive-changes/tasks/${taskId}/start-review`)).json().state).toBe('IN_REVIEW');
  expect((await decide(taskId, { decision: 'APPROVE', reason: 'Verified against synthetic evidence' })).json().state).toBe('APPLIED');
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['sensitive_change.review.private', 'sensitive_change.read.private', 'document.read.document', 'document.verify.document'] });
  reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['sensitive_change.read.private'] });
  bankReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['sensitive_change.read.private', 'employee.read.bank'] });
  const e = (await h.call(reviewer, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  employeeId = e.id as string;
  employee = await h.actor(A, 'EMPLOYEE', { employeeId });
  expect((await h.call(reviewer, 'PUT', '/v1/workflows/sensitive_change/fallback-reviewers', { reviewers: [{ userId: reviewer.user, priority: 1 }] })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('bank account identifiers in the HR change history (FR-105, FR-098/BR-044, H3 TN03, I-18)', () => {
  it('masks them for every reader but the assigned reviewer and the owner; the bank field grant reads only the account in force', async () => {
    const first = await submitBank(FIRST);
    await approve(first);
    const second = await submitBank(SECOND); // replaces the first account
    await approve(second);
    const third = await submitBank(THIRD); // pending with the reviewer

    // sensitive_change.read.private alone: the masked bank summary, for the submitted and the applied requests alike.
    const plain = await history(reader);
    expect(plain.of(third)).toMatchObject({ state: 'SUBMITTED', proposed: { accountIdentifier: '••••8999' }, before: { accountIdentifier: '••••5666' } });
    expect(plain.of(second)).toMatchObject({ state: 'APPLIED', proposed: { accountIdentifier: '••••5666' }, before: { accountIdentifier: '••••2333' } });
    // Holder, routing reference and country stay readable, as in the masked summary.
    expect(plain.of(first)).toMatchObject({ state: 'APPLIED', proposed: { holderName: 'Synthetic Person', accountIdentifier: '••••2333', routingReference: 'SYNT0000001', countryCode: 'IN' } });
    for (const account of [FIRST, SECOND, THIRD]) expect(plain.body).not.toContain(account);

    // The bank field grant in the same assignment: the account in force (what the private profile shows that grant
    // anyway). A holder of it who is no reviewer does not read the submitted proposal (TN03); the replaced account and
    // every before-value stay masked too (I-18).
    const granted = await history(bankReader);
    expect(granted.of(third)).toMatchObject({ proposed: { accountIdentifier: '••••8999' }, before: { accountIdentifier: '••••5666' } });
    expect(granted.of(second)).toMatchObject({ proposed: { accountIdentifier: SECOND }, before: { accountIdentifier: '••••2333' } });
    expect(granted.of(first).proposed.accountIdentifier).toBe('••••2333');
    expect(granted.body).not.toContain(FIRST);
    expect(granted.body).not.toContain(THIRD);
    expect((await h.call(bankReader, 'GET', `/v1/employees/${employeeId}/private-profile`)).json().bank).toMatchObject({ masked: false, values: { accountIdentifier: SECOND } });

    // A bank grant held by the same user in another assignment lends nothing (C1/BR-046).
    await h.actor(A, 'HR_ADMINISTRATOR', { user: reader.user, extra: ['sensitive_change.read.private', 'employee.read.bank'] });
    const stillPlain = await history(reader);
    for (const account of [FIRST, SECOND, THIRD]) expect(stillPlain.body).not.toContain(account);

    // The reviewer assigned to the open request sees its proposal in full, as in the review queue, and nothing else.
    expect((await taskOf(third)).request).toMatchObject({ proposed: { accountIdentifier: THIRD }, before: { accountIdentifier: '••••5666' } });
    const reviewing = await history(reviewer);
    expect(reviewing.of(third).proposed.accountIdentifier).toBe(THIRD);
    expect(reviewing.of(second).proposed.accountIdentifier).toBe('••••5666');
    expect(reviewing.of(first).proposed.accountIdentifier).toBe('••••2333');
    // Only from a context that may review: the same user reading through a history-only assignment sees it masked.
    const historyOnly = await h.actor(A, 'HR_ADMINISTRATOR', { user: reviewer.user, extra: ['sensitive_change.read.private'] });
    expect((await history(historyOnly)).body).not.toContain(THIRD);

    // Once decided, the reviewer is no longer assigned: the proposal is masked for them too.
    const { taskId } = await taskOf(third);
    expect((await decide(taskId, { decision: 'RETURN', reason: 'private note', employeeMessage: 'Please attach a clearer bank letter' })).json().state).toBe('RETURNED');
    expect((await history(reviewer)).of(third)).toMatchObject({ state: 'RETURNED', proposed: { accountIdentifier: '••••8999' } });
    // A returned proposal never took effect, and neither does a draft nobody submitted: the bank field grant reads neither.
    expect((await history(bankReader)).of(third).proposed.accountIdentifier).toBe('••••8999');
    const draft = await h.call(employee, 'POST', '/v1/me/sensitive-changes', { category: 'BANK', values: { accountIdentifier: FOURTH }, reason: 'Unsubmitted synthetic account' });
    expect(draft.statusCode).toBe(201);
    const fourth = draft.json().requestId as string;
    for (const a of [bankReader, reviewer, reader]) {
      const seen = await history(a);
      expect(seen.of(fourth)).toMatchObject({ state: 'DRAFT', proposed: { accountIdentifier: '••••0000' } });
      expect(seen.body).not.toContain(FOURTH);
    }

    // The owner's own list keeps every full proposal; before-values are masked there too.
    const own = await history(employee, '/v1/me/sensitive-changes');
    expect(own.of(first).proposed.accountIdentifier).toBe(FIRST);
    expect(own.of(second)).toMatchObject({ proposed: { accountIdentifier: SECOND }, before: { accountIdentifier: '••••2333' } });
    expect(own.of(third).proposed.accountIdentifier).toBe(THIRD);
    expect(own.of(fourth).proposed.accountIdentifier).toBe(FOURTH);
  });
});
