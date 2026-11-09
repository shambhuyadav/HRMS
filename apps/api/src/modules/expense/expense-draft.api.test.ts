// FR-070 (BRD line 1211): an employee creates and edits their own expense draft with business purpose, currency, dated category lines and
// receipt links. Its acceptance clause and nothing more: a two-line draft retains both line amounts; another employee cannot edit it; a
// missing unconfirmed exchange rate does not prevent saving the draft but blocks submission. A claim is reimbursed in the policy currency;
// a draft whose whole claim is in another currency is refused at submission here, and a line in another currency without a rate in force
// is the same case line by line (I-87; currencies.api.test.ts). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let owner: TestActor;
let colleague: TestActor;

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/** A synthetic PDF receipt uploaded by `a` (unique bytes, so no duplicate flag), and a line linking it. */
const line = async (a: TestActor, amount: string, expenseDate = daysAgo(3)) => {
  const res = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'receipt.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
  expect(res.statusCode, res.body).toBe(201);
  const receiptId = res.json().receiptId as string;
  return { category: 'OTHER', expenseDate, merchant: 'Synthetic Merchant', grossAmount: amount, claimedAmount: amount, description: 'Synthetic', receipt: { receiptId } };
};
const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const draft = async (a: TestActor, lines: object[], currency = 'INR') => {
  const res = await h.call(a, 'POST', '/v1/expense/claims', { purpose: 'Client visit (synthetic)', currency, lines });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().claimId as string;
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const person = async (managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    if (managerId) expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    return e.id as string;
  };
  // A manager to route to, so a submission in the policy currency can go through as the control.
  const managerEmp = await person();
  await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  owner = await h.actor(A, 'EMPLOYEE', { employeeId: await person(managerEmp) });
  colleague = await h.actor(A, 'EMPLOYEE', { employeeId: await person(managerEmp) });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('expense draft', () => {
  it('FR-070: a two-line draft retains both line amounts, with its purpose, currency, dated lines and receipt links, and its owner can edit it', async () => {
    const first = await line(owner, '120.50', daysAgo(4));
    const second = await line(owner, '80', daysAgo(2));
    const id = await draft(owner, [first, second]);
    const saved = await view(owner, id);
    expect(saved).toMatchObject({ purpose: 'Client visit (synthetic)', currency: 'INR', state: 'DRAFT' });
    expect(saved.lines.map((l: { claimedAmount: string }) => Number(l.claimedAmount))).toEqual([120.5, 80]);
    expect(saved.lines.map((l: { expenseDate: string }) => l.expenseDate)).toEqual([daysAgo(4), daysAgo(2)]);
    expect(saved.lines.map((l: { receiptId: string }) => l.receiptId)).toEqual([first.receipt.receiptId, second.receipt.receiptId]);

    const edited = await h.call(owner, 'PUT', `/v1/expense/claims/${id}`, { purpose: 'Client visit, revised (synthetic)', currency: 'INR', lines: [first, { ...second, grossAmount: '95', claimedAmount: '95' }], expectedVersion: saved.version });
    expect(edited.statusCode, edited.body).toBe(200);
    const after = await view(owner, id);
    expect(after.purpose).toBe('Client visit, revised (synthetic)');
    expect(after.lines.map((l: { claimedAmount: string }) => Number(l.claimedAmount))).toEqual([120.5, 95]);
  });

  it('FR-070: another employee cannot edit the draft, and it stays as its owner left it', async () => {
    const id = await draft(owner, [await line(owner, '60'), await line(owner, '40')]);
    const before = await view(owner, id);
    const attempt = await h.call(colleague, 'PUT', `/v1/expense/claims/${id}`, { purpose: 'Changed by a colleague (synthetic)', currency: 'INR', lines: [await line(colleague, '999')], expectedVersion: before.version });
    expect(attempt.statusCode, attempt.body).toBe(404);
    expect(await view(owner, id)).toEqual(before);
  });

  it('FR-070: a draft in a currency with no confirmed exchange rate is saved, and its submission is refused; in the policy currency it is submitted', async () => {
    const foreign = await draft(owner, [await line(owner, '100')], 'USD');
    expect(await view(owner, foreign)).toMatchObject({ currency: 'USD', state: 'DRAFT' });
    const refused = await h.call(owner, 'POST', `/v1/expense/claims/${foreign}/submit`, { expectedVersion: (await view(owner, foreign)).version });
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().error).toBe('UNSUPPORTED_CURRENCY');
    expect((await view(owner, foreign)).state).toBe('DRAFT');

    const home = await draft(owner, [await line(owner, '100')]);
    const sent = await h.call(owner, 'POST', `/v1/expense/claims/${home}/submit`, { expectedVersion: (await view(owner, home)).version });
    expect(sent.statusCode, sent.body).toBe(200);
  });
});
