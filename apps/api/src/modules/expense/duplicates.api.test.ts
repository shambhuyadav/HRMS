// Suspected duplicate expense lines (FR-075, BR-023, DF06). A line is DUPLICATE_SUSPECTED, and needs a documented
// exception reason before the claim can be submitted, when its employee/date/category/amount/receipt fingerprint or
// its receipt file (checksum) matches another line of the same revision, or a line of the submitted current revision
// of another live claim. Never-submitted drafts, superseded revisions and the claim's own other revisions are not
// compared. Synthetic INR amounts; dates relative to today.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let manager: TestActor;
let employee: TestActor;
let colleague: TestActor;

type Receipt = { receiptId: string };

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
/** Synthetic PDF bytes, unique per call; uploading the same bytes twice models a re-uploaded copy of one file. */
const receiptBytes = () => `%PDF-1.4\n% synthetic duplicate-review receipt ${uniq('d')}\n%%EOF\n`;
const upload = async (a: TestActor, bytes: string): Promise<Receipt> => {
  const res = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'receipt.pdf', contentBase64: Buffer.from(bytes).toString('base64') });
  expect(res.statusCode).toBe(201);
  return { receiptId: res.json().receiptId as string };
};
const line = (category: string, amount: string, receipt?: Receipt, extra: Record<string, unknown> = {}) => ({
  category,
  expenseDate: daysAgo(3),
  merchant: 'Synthetic Merchant',
  grossAmount: amount,
  claimedAmount: amount,
  description: `${category} (synthetic)`,
  ...(receipt ? { receipt } : {}),
  ...extra,
});

const PURPOSE = 'Duplicate review (synthetic)';
const draft = async (lines: object[], a: TestActor = employee) => {
  const res = await h.call(a, 'POST', '/v1/expense/claims', { purpose: PURPOSE, currency: 'INR', lines });
  expect(res.statusCode).toBe(201);
  return res.json().claimId as string;
};
const view = async (id: string, a: TestActor = employee) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const submit = async (id: string, a: TestActor = employee) => h.call(a, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(id, a)).version });
const revise = async (id: string, lines: object[]) =>
  h.call(employee, 'PUT', `/v1/expense/claims/${id}`, { expectedVersion: (await view(id)).version, purpose: PURPOSE, currency: 'INR', lines });
const flags = async (id: string) => (await view(id)).lines.map((l: { exceptionFlags: string[] }) => l.exceptionFlags);
const returnToClaimant = async (id: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [id])).transaction_id;
  const task = ((await h.call(manager, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx);
  expect(task).toBeDefined();
  const res = await h.call(manager, 'POST', `/v1/expense/tasks/${task!.taskId}/decision`, {
    idempotencyKey: uniq('dup-review-key-'),
    decision: 'RETURN',
    reason: 'Please re-check the receipts (synthetic)',
  });
  expect(res.json().state).toBe('RETURNED');
};

const SUBMITTED = { state: 'MANAGER_PENDING' };
/** The submission refusal naming exactly these lines, each flagged only as a suspected duplicate. */
const duplicateOn = (...lines: number[]) => ({
  error: 'EXCEPTION_REASON_REQUIRED',
  details: { lines: lines.map((n) => ({ line: n, flags: ['DUPLICATE_SUSPECTED'] })) },
});

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  const hr = await h.actor(A, 'HR_ADMINISTRATOR');
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await person();
  const employeeEmp = await person();
  const colleagueEmp = await person();
  for (const e of [employeeEmp, colleagueEmp]) {
    await h.call(hr, 'POST', `/v1/employees/${e}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  }
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  colleague = await h.actor(A, 'EMPLOYEE', { employeeId: colleagueEmp });
  // The seeded policy is a DRAFT; HR (not its author) activates it so claims can be submitted.
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('lines of the same claim (data-6 / brd-2)', () => {
  it('one receipt on two identical OFFICE_SUPPLIES lines flags both lines; once explained, both keep the flag', async () => {
    const receipt = await upload(employee, receiptBytes());
    const twice = [line('OFFICE_SUPPLIES', '500', receipt), line('OFFICE_SUPPLIES', '500', receipt)];
    const id = await draft(twice);
    expect((await submit(id)).json()).toMatchObject(duplicateOn(1, 2));
    expect((await view(id)).state).toBe('DRAFT');

    const explained = twice.map((l, i) => ({ ...l, exceptionReason: `Two purchases on one bill, part ${i + 1} (synthetic)` }));
    expect((await revise(id, explained)).statusCode).toBe(200);
    expect((await submit(id)).json()).toMatchObject(SUBMITTED);
    expect(await flags(id)).toEqual([['DUPLICATE_SUSPECTED'], ['DUPLICATE_SUSPECTED']]);
  });

  it('a re-uploaded copy of one receipt file on two lines flags both, even with different categories and amounts', async () => {
    const bytes = receiptBytes();
    const id = await draft([line('OFFICE_SUPPLIES', '300', await upload(employee, bytes)), line('OTHER', '200', await upload(employee, bytes))]);
    expect((await submit(id)).json()).toMatchObject(duplicateOn(1, 2));
  });

  it('two identical lines without receipts share a fingerprint and are both flagged', async () => {
    const id = await draft([line('TRAVEL', '250'), line('TRAVEL', '250')]);
    expect((await submit(id)).json()).toMatchObject({
      error: 'EXCEPTION_REASON_REQUIRED',
      details: { lines: [1, 2].map((n) => ({ line: n, flags: ['RECEIPT_MISSING', 'DUPLICATE_SUSPECTED'] })) },
    });
  });

  it('only the lines that match each other are flagged; a line with its own receipt is not', async () => {
    const shared = receiptBytes();
    const id = await draft([
      line('OFFICE_SUPPLIES', '500', await upload(employee, receiptBytes())),
      line('OFFICE_SUPPLIES', '500', await upload(employee, shared)),
      line('OFFICE_SUPPLIES', '500', await upload(employee, shared)),
    ]);
    expect((await submit(id)).json()).toMatchObject(duplicateOn(2, 3));
  });

  it('otherwise identical lines with different receipts are not duplicates', async () => {
    const id = await draft([line('OFFICE_SUPPLIES', '450', await upload(employee, receiptBytes())), line('OFFICE_SUPPLIES', '450', await upload(employee, receiptBytes()))]);
    expect((await submit(id)).json()).toMatchObject(SUBMITTED);
    expect(await flags(id)).toEqual([[], []]);
  });
});

describe('lines of other claims (brd-3)', () => {
  it('a corrected retry of a draft that failed submission is not a duplicate of that draft; submitting the old draft later is', async () => {
    const bytes = receiptBytes();
    const original = await upload(employee, bytes);
    const failed = await draft([line('OTHER', '150', original, { expenseDate: daysAgo(-2) })]);
    expect((await submit(failed)).json()).toMatchObject({ error: 'CLAIM_INVALID', details: { errors: [{ line: 1, code: 'FUTURE_EXPENSE_DATE' }] } });

    const retry = await draft([line('OTHER', '150', await upload(employee, bytes))]);
    expect((await submit(retry)).json()).toMatchObject(SUBMITTED);
    expect(await flags(retry)).toEqual([[]]);

    // The abandoned draft still holds the file: correcting and submitting it as well is a suspected duplicate.
    expect((await revise(failed, [line('OTHER', '150', original)])).statusCode).toBe(200);
    expect((await submit(failed)).json()).toMatchObject(duplicateOn(1));
  });

  it('retrying with the same upload after a failed submission is not a duplicate either', async () => {
    const receipt = await upload(employee, receiptBytes());
    const failed = await draft([line('OTHER', '155', receipt, { expenseDate: daysAgo(-2) })]);
    expect((await submit(failed)).json().error).toBe('CLAIM_INVALID');
    const retry = await draft([line('OTHER', '155', receipt)]);
    expect((await submit(retry)).json()).toMatchObject(SUBMITTED);
    expect(await flags(retry)).toEqual([[]]);
  });

  it('a receipt kept only by the superseded revision of a returned claim is not a duplicate; its current revision still counts', async () => {
    const moved = await upload(employee, receiptBytes());
    const keptBytes = receiptBytes();
    const returned = await draft([line('OTHER', '160', moved)]);
    expect((await submit(returned)).json()).toMatchObject(SUBMITTED);
    await returnToClaimant(returned);
    // Revision 2 replaces the receipt, so the moved receipt now lives only in the superseded revision 1.
    expect((await revise(returned, [line('OTHER', '160', await upload(employee, keptBytes))])).json().revision).toBe(2);
    expect((await submit(returned)).json()).toMatchObject({ ...SUBMITTED, revision: 2 });

    // The same line (same fingerprint as revision 1) and the same upload move to a new claim: not a duplicate.
    const moving = await draft([line('OTHER', '160', moved)]);
    expect((await submit(moving)).json()).toMatchObject(SUBMITTED);
    expect(await flags(moving)).toEqual([[]]);

    // The receipt in the returned claim's current submitted revision is still compared.
    const reuse = await draft([line('OTHER', '165', await upload(employee, keptBytes))]);
    expect((await submit(reuse)).json()).toMatchObject(duplicateOn(1));
  });

  it('a returned claim resubmitted with its own receipt is not a duplicate of its earlier revision', async () => {
    const receipt = await upload(employee, receiptBytes());
    const id = await draft([line('OTHER', '180', receipt)]);
    expect((await submit(id)).json()).toMatchObject(SUBMITTED);
    await returnToClaimant(id);
    expect((await revise(id, [line('OTHER', '180', receipt, { description: 'OTHER with more detail (synthetic)' })])).json().revision).toBe(2);
    expect((await submit(id)).json()).toMatchObject({ ...SUBMITTED, revision: 2 });
    expect(await flags(id)).toEqual([[]]);
  });

  it('a colleague claiming a copy of a submitted receipt is still flagged', async () => {
    const bytes = receiptBytes();
    const mine = await draft([line('OTHER', '190', await upload(employee, bytes))]);
    expect((await submit(mine)).json()).toMatchObject(SUBMITTED);
    const theirs = await draft([line('OTHER', '95', await upload(colleague, bytes))], colleague);
    expect((await submit(theirs, colleague)).json()).toMatchObject(duplicateOn(1));
  });

  it('two claims sharing a receipt file submitted at the same moment: exactly one is accepted, the other is flagged', async () => {
    // Several rounds: without serialisation both submissions miss each other (neither flagged) under most timings.
    for (let round = 0; round < 5; round++) {
      const bytes = receiptBytes();
      const ids = [await draft([line('OTHER', '210', await upload(employee, bytes))]), await draft([line('OTHER', '220', await upload(employee, bytes))])];
      const versions = await Promise.all(ids.map(async (id) => (await view(id)).version as number));
      const results = await Promise.all(ids.map((id, i) => h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: versions[i] })));
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422]);
      expect(results.find((r) => r.statusCode === 422)!.json()).toMatchObject(duplicateOn(1));
    }
  });

  it('a withdrawn claim no longer holds its receipt', async () => {
    const receipt = await upload(employee, receiptBytes());
    const withdrawn = await draft([line('OTHER', '120', receipt)]);
    expect((await submit(withdrawn)).json()).toMatchObject(SUBMITTED);
    await returnToClaimant(withdrawn);
    expect((await h.call(employee, 'POST', `/v1/expense/claims/${withdrawn}/withdraw`)).json().state).toBe('WITHDRAWN');
    const again = await draft([line('OTHER', '120', receipt)]);
    expect((await submit(again)).json()).toMatchObject(SUBMITTED);
  });
});
