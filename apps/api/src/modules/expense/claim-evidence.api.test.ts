// What a submission judges and what a revision keeps: a receipt quarantined after the draft was saved (FR-071, FR-106), reuse of
// a merchant's invoice (FR-075, BR-023), nights grouped across lines (FR-071, FR-078, DF06), and the purpose of each revision
// (FR-072, BR-017, line 103). Synthetic INR amounts; dates relative to today; limits are the provisioned DF06 values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHECK_VIOLATION, expectSqlError, uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { createDraft, reviseDraft } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let managerEmp: string;
let fin: TestActor;
let employee: TestActor;
let colleague: TestActor;

const FINANCE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational', 'payment.read.operational'];

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const upload = async (a: TestActor) => {
  const res = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic evidence receipt ${uniq('e')}\n%%EOF\n`).toString('base64') });
  expect(res.statusCode).toBe(201);
  return { receiptId: res.json().receiptId as string };
};
const line = async (a: TestActor, category: string, amount: string, extra: Record<string, unknown> = {}) => ({
  category,
  expenseDate: daysAgo(3),
  merchant: 'Synthetic Merchant',
  grossAmount: amount,
  claimedAmount: amount,
  description: `${category} (synthetic)`,
  receipt: await upload(a),
  ...extra,
});
const PURPOSE = 'Evidence check (synthetic)';
const draft = async (a: TestActor, lines: object[], purpose = PURPOSE) => {
  const res = await h.call(a, 'POST', '/v1/expense/claims', { purpose, currency: 'INR', lines });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().claimId as string;
};
const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const submit = async (a: TestActor, id: string) => h.call(a, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(a, id)).version });
const submitted = async (a: TestActor, lines: object[]) => {
  const id = await draft(a, lines);
  const res = await submit(a, id);
  expect(res.statusCode, res.body).toBe(200);
  return id;
};
const taskOf = async (a: TestActor, claimId: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
  return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
};
const decide = async (a: TestActor, claimId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/expense/tasks/${await taskOf(a, claimId)}/decision`, { idempotencyKey: uniq('evidence-key-'), ...body });
const flagged = (...lines: { line: number; flags: string[] }[]) => ({ error: 'EXCEPTION_REASON_REQUIRED', details: { lines } });
const flagsOf = async (a: TestActor, id: string) => (await view(a, id)).lines.map((l: { exceptionFlags: string[] }) => l.exceptionFlags);

/** A claimant of their own, so what their other live claims hold stays out of a test. */
async function person(company = A, creator = hr, managerEmployee: string | null = managerEmp) {
  const e = (await h.call(creator, 'POST', '/v1/employees', h.newEmployeeBody(company))).json();
  await h.setStatus(company, e.id, 'ACTIVE_CONFIRMED');
  if (managerEmployee) await h.call(creator, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmployee, effectiveFrom: '2026-01-05' });
  return h.actor(company, 'EMPLOYEE', { employeeId: e.id });
}

/** A receipt as if the worker has not scanned it yet (uploads are scanned at once in tests); a verdict is final otherwise (0040). */
async function markPending(receiptId: string) {
  await h.db.query(`set session_replication_role = replica`);
  try {
    await h.db.query(`update attachment set scan_state = 'PENDING_SCAN', scan_checked_at = null, scan_finding = null where id = $1`, [receiptId]);
  } finally {
    await h.db.query(`set session_replication_role = origin`);
  }
}
const quarantine = (receiptId: string) => h.db.query(`update attachment set scan_state = 'QUARANTINED', scan_checked_at = now(), scan_finding = 'EICAR-Test-File' where id = $1`, [receiptId]);
const pendingUpload = async (a: TestActor) => {
  const receipt = await upload(a);
  await markPending(receipt.receiptId);
  return receipt;
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  fin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  const fin2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true), ($1, 'expense_claim', $3, 2, true)`, [A.id, fin.user, fin2.user]);
  const managerRow = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, managerRow.id, 'ACTIVE_CONFIRMED');
  managerEmp = managerRow.id;
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await person();
  colleague = await person();

  // A second per-night category, so grouping is seen to stay within one category; its limit is a test value.
  const camp = await h.call(hr, 'POST', '/v1/expense/categories', { code: 'CAMP', name: 'Synthetic camp stay', limitBasis: 'PER_NIGHT' });
  expect(camp.statusCode, camp.body).toBe(201);
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  const rule = await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/rules`, { expectedVersion: policy.version, categoryId: camp.json().id, limitAmount: '5000', receiptRequired: true });
  expect(rule.statusCode, rule.body).toBe(201);
  const activator = await h.actor(A, 'HR_ADMINISTRATOR');
  expect((await h.call(activator, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: rule.json().policyVersion })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('a receipt quarantined after the draft was saved (FR-071, FR-106, DF06)', () => {
  it('no longer satisfies the receipt requirement at submission', async () => {
    const a = await person();
    const receipt = await pendingUpload(a);
    const id = await draft(a, [await line(a, 'OTHER', '100', { receipt })]);
    await quarantine(receipt.receiptId);
    expect((await submit(a, id)).json()).toMatchObject(flagged({ line: 1, flags: ['RECEIPT_MISSING'] }));
    expect((await view(a, id)).state).toBe('DRAFT');
  });

  it('with the claimant reason it goes on flagged, and reviewers see the file is quarantined', async () => {
    const a = await person();
    const receipt = await pendingUpload(a);
    const id = await draft(a, [await line(a, 'OTHER', '100', { receipt, exceptionReason: 'Vendor will resend (synthetic)' })]);
    await quarantine(receipt.receiptId);
    expect((await submit(a, id)).statusCode).toBe(200);
    expect((await view(fin, id)).lines[0]).toMatchObject({ receiptPresent: true, receiptScanState: 'QUARANTINED', exceptionFlags: ['RECEIPT_MISSING'] });
  });

  it('where the rule needs no receipt, a quarantined one raises no flag at submission but is still not evidence at the financial step', async () => {
    const c = await h.makeCompany();
    const author = await h.actor(c, 'HR_ADMINISTRATOR');
    const activator = await h.actor(c, 'HR_ADMINISTRATOR');
    const finance = await h.actor(c, 'HR_ADMINISTRATOR', { extra: FINANCE });
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [c.id, finance.user]);
    const managerEmployee = (await h.call(author, 'POST', '/v1/employees', h.newEmployeeBody(c))).json();
    await h.setStatus(c, managerEmployee.id, 'ACTIVE_CONFIRMED');
    const boss = await h.actor(c, 'REPORTING_MANAGER', { employeeId: managerEmployee.id });
    const a = await person(c, author, managerEmployee.id);
    const seeded = (await h.call(author, 'GET', '/v1/expense/policies')).json().items[0];
    expect((await h.call(activator, 'POST', `/v1/expense/policies/${seeded.id}/activate`, { expectedVersion: seeded.version })).statusCode).toBe(200);
    const category = (await h.call(author, 'GET', '/v1/expense/policy-options')).json().categories.find((x: { code: string }) => x.code === 'OTHER').id;
    const next = await h.call(author, 'POST', '/v1/expense/policies', { code: 'DEFAULT', effectiveFrom: daysAgo(10), submissionWindowDays: 30, highValueThreshold: '50000' });
    const rule = await h.call(author, 'POST', `/v1/expense/policies/${next.json().id}/rules`, { expectedVersion: next.json().version, categoryId: category, limitAmount: '1000', receiptRequired: false });
    expect((await h.call(activator, 'POST', `/v1/expense/policies/${next.json().id}/activate`, { expectedVersion: rule.json().policyVersion })).statusCode).toBe(200);

    const receipt = await pendingUpload(a);
    const id = await draft(a, [await line(a, 'OTHER', '100', { receipt })]);
    await quarantine(receipt.receiptId);
    expect((await submit(a, id)).statusCode).toBe(200);
    expect(await flagsOf(a, id)).toEqual([[]]);
    expect((await decide(boss, id, { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    const lineId = (await view(finance, id)).lines[0].id;
    expect((await decide(finance, id, { decision: 'APPROVE', lines: [{ lineId, allowedAmount: '100' }] })).json().error).toBe('CLEARANCE_REASON_REQUIRED');
  });

  it('one still being scanned counts as attached at submission', async () => {
    const a = await person();
    const receipt = await pendingUpload(a);
    const id = await draft(a, [await line(a, 'OTHER', '100', { receipt })]);
    expect((await submit(a, id)).statusCode).toBe(200);
    expect((await view(fin, id)).lines[0]).toMatchObject({ receiptPresent: true, receiptScanState: 'PENDING_SCAN', exceptionFlags: [] });
    // A line with no receipt at all reads as such.
    const none = await draft(a, [{ ...(await line(a, 'TRAVEL', '100')), receipt: undefined, exceptionReason: 'Lost (synthetic)' }]);
    expect((await view(a, none)).lines[0]).toMatchObject({ receiptPresent: false, receiptScanState: null });
  });

  it('at the financial step a receipt not released needs the reviewer\'s recorded reason, whatever its scan says later', async () => {
    const a = await person();
    const receipt = await pendingUpload(a);
    const id = await draft(a, [await line(a, 'OTHER', '100', { receipt }), await line(a, 'TRAVEL', '200')]);
    expect((await submit(a, id)).statusCode).toBe(200);
    expect((await decide(manager, id, { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    await quarantine(receipt.receiptId);
    const lines = (await view(fin, id)).lines as { id: string; sequence: number }[];
    const amounts = lines.map((l) => ({ lineId: l.id, allowedAmount: l.sequence === 1 ? '100' : '200' }));
    const refused = await decide(fin, id, { decision: 'APPROVE', lines: amounts });
    expect(refused.statusCode).toBe(422);
    // Only the line whose receipt is not released: the other's receipt is clean.
    expect(refused.json()).toMatchObject({ error: 'CLEARANCE_REASON_REQUIRED', details: { lines: [{ line: 1, flags: ['RECEIPT_NOT_RELEASED'] }] } });
    expect((await view(a, id)).state).toBe('FINANCE_PENDING');
    const accepted = await decide(fin, id, { decision: 'APPROVE', lines: amounts.map((l, i) => (i === 0 ? { ...l, reason: 'Vendor copy seen in person (synthetic)' } : l)) });
    expect(accepted.json().state).toBe('APPROVED');
  });

  it('still being scanned at the financial step is no evidence either', async () => {
    const a = await person();
    const receipt = await pendingUpload(a);
    const id = await draft(a, [await line(a, 'OTHER', '100', { receipt })]);
    expect((await submit(a, id)).statusCode).toBe(200);
    expect((await decide(manager, id, { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    const lineId = (await view(fin, id)).lines[0].id;
    expect((await decide(fin, id, { decision: 'APPROVE', lines: [{ lineId, allowedAmount: '100' }] })).json()).toMatchObject({ error: 'CLEARANCE_REASON_REQUIRED', details: { lines: [{ line: 1, flags: ['RECEIPT_NOT_RELEASED'] }] } });
  });

  it('the database refuses such a line decision without a reason too', async () => {
    const a = await person();
    const receipt = await pendingUpload(a);
    const id = await draft(a, [await line(a, 'OTHER', '100', { receipt })]);
    expect((await submit(a, id)).statusCode).toBe(200);
    expect((await decide(manager, id, { decision: 'APPROVE' })).statusCode).toBe(200);
    const row = await h.one<{ line_id: string; decision_id: string }>(
      `select l.id as line_id, d.id as decision_id
         from expense_claim c
         join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id
         join expense_line l on l.company_id = r.company_id and l.revision_id = r.id
         join approval_instance i on i.company_id = c.company_id and i.transaction_id = c.transaction_id
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
        where c.id = $1`,
      [id],
    );
    const insert = (reason: string | null) => h.db.query(`insert into expense_line_decision (company_id, line_id, approval_decision_id, allowed_amount, exception_reason) values ($1, $2, $3, 100, $4)`, [A.id, row.line_id, row.decision_id, reason]);
    await expect(insert(null)).rejects.toThrow('a line whose receipt is not released needs a recorded reason');
    await expect(insert('  ')).rejects.toThrow('a line whose receipt is not released needs a recorded reason');
  });

  it('a clean receipt needs no reason, and a quarantined one cannot be newly attached', async () => {
    const a = await person();
    const receipt = await pendingUpload(a);
    await quarantine(receipt.receiptId);
    const refused = await h.call(a, 'POST', '/v1/expense/claims', { purpose: PURPOSE, currency: 'INR', lines: [await line(a, 'OTHER', '100', { receipt })] });
    expect(refused.json().error).toBe('RECEIPT_QUARANTINED');
    const id = await submitted(a, [await line(a, 'OTHER', '100')]);
    expect((await decide(manager, id, { decision: 'APPROVE' })).statusCode).toBe(200);
    const lineId = (await view(fin, id)).lines[0].id;
    expect((await decide(fin, id, { decision: 'APPROVE', lines: [{ lineId, allowedAmount: '100' }] })).json().state).toBe('APPROVED');
  });
});

describe('reuse of a merchant\'s invoice (FR-075, BR-023, DF06)', () => {
  const invoice = () => uniq('INV-');
  const dup = flagged({ line: 1, flags: ['DUPLICATE_SUSPECTED'] });

  it('the same merchant and invoice on another claim is suspected, whatever the scan, amount or date; the reason then carries it to review', async () => {
    const a = await person();
    const invoiceReference = invoice();
    const first = await submitted(a, [await line(a, 'OTHER', '120', { invoiceReference, expenseDate: daysAgo(4) })]);
    expect(await flagsOf(a, first)).toEqual([[]]);
    const second = await draft(a, [await line(a, 'OTHER', '130', { invoiceReference, expenseDate: daysAgo(5) })]);
    expect((await submit(a, second)).json()).toMatchObject(dup);
    const version = (await view(a, second)).version;
    const explained = await h.call(a, 'PUT', `/v1/expense/claims/${second}`, {
      expectedVersion: version,
      purpose: PURPOSE,
      currency: 'INR',
      lines: [await line(a, 'OTHER', '130', { invoiceReference, expenseDate: daysAgo(5), exceptionReason: 'Second part of one bill (synthetic)' })],
    });
    expect(explained.statusCode).toBe(200);
    expect((await submit(a, second)).statusCode).toBe(200);
    // Reviewers see the reference the flag is about; the earlier line's submitted facts stay as they were.
    expect((await view(fin, second)).lines[0]).toMatchObject({ invoiceReference, exceptionFlags: ['DUPLICATE_SUSPECTED'] });
    expect(await flagsOf(a, first)).toEqual([[]]);
  });

  it('matches trimmed, case-normalised text and collapsed spaces, and nothing merely similar (BR-023)', async () => {
    const a = await person();
    const n = uniq('');
    await submitted(a, [await line(a, 'OTHER', '10', { merchant: 'Synthetic  Hotel Group', invoiceReference: `Inv ${n}` })]);
    const same = await draft(a, [await line(a, 'OTHER', '11', { merchant: ' synthetic hotel   GROUP ', invoiceReference: ` INV  ${n} ` })]);
    expect((await submit(a, same)).json()).toMatchObject(dup);
    await submitted(a, [await line(a, 'OTHER', '12', { merchant: 'Synthetic Hotel Group', invoiceReference: `INV-${n}` })]);
    await submitted(a, [await line(a, 'OTHER', '13', { merchant: 'Synthetic Hotel Group', invoiceReference: `INV ${n}0` })]);
  });

  it('the same reference at another merchant is no match, and no reference matches nothing', async () => {
    const a = await person();
    const invoiceReference = invoice();
    await submitted(a, [await line(a, 'OTHER', '20', { merchant: 'Synthetic One', invoiceReference })]);
    await submitted(a, [await line(a, 'OTHER', '21', { merchant: 'Synthetic Two', invoiceReference })]);
    await submitted(a, [await line(a, 'OTHER', '22', { merchant: 'Synthetic Three' })]);
    await submitted(a, [await line(a, 'OTHER', '23', { merchant: 'Synthetic Three' })]);
    await submitted(a, [await line(a, 'OTHER', '24', { merchant: 'Synthetic Three', invoiceReference: '   ' })]);
    await submitted(a, [await line(a, 'OTHER', '25', { merchant: 'Synthetic Three', invoiceReference: '   ' })]);
  });

  it('a colleague reusing the invoice is suspected too; another company is not compared', async () => {
    const [a, b] = [await person(), await person()];
    const invoiceReference = invoice();
    await submitted(a, [await line(a, 'OTHER', '30', { invoiceReference })]);
    const reused = await draft(b, [await line(b, 'OTHER', '31', { invoiceReference })]);
    expect((await submit(b, reused)).json()).toMatchObject(dup);

    const c = await h.makeCompany();
    const author = await h.actor(c, 'HR_ADMINISTRATOR');
    const activator = await h.actor(c, 'HR_ADMINISTRATOR');
    const boss = (await h.call(author, 'POST', '/v1/employees', h.newEmployeeBody(c))).json();
    await h.setStatus(c, boss.id, 'ACTIVE_CONFIRMED');
    await h.actor(c, 'REPORTING_MANAGER', { employeeId: boss.id });
    const seeded = (await h.call(author, 'GET', '/v1/expense/policies')).json().items[0];
    await h.call(activator, 'POST', `/v1/expense/policies/${seeded.id}/activate`, { expectedVersion: seeded.version });
    const elsewhere = await person(c, author, boss.id);
    await submitted(elsewhere, [await line(elsewhere, 'OTHER', '30', { invoiceReference })]);
  });

  it('two lines of one claim with one invoice are both suspected', async () => {
    const a = await person();
    const invoiceReference = invoice();
    const id = await draft(a, [await line(a, 'OTHER', '40', { invoiceReference }), await line(a, 'TRAVEL', '50', { invoiceReference }), await line(a, 'OFFICE_SUPPLIES', '60', { invoiceReference: invoice() })]);
    expect((await submit(a, id)).json()).toMatchObject(flagged({ line: 1, flags: ['DUPLICATE_SUSPECTED'] }, { line: 2, flags: ['DUPLICATE_SUSPECTED'] }));
  });

  it('a rejected or withdrawn claim, a draft and a superseded revision no longer hold the invoice', async () => {
    const a = await person();
    const rejected = invoice();
    const r = await submitted(a, [await line(a, 'OTHER', '60', { invoiceReference: rejected })]);
    expect((await decide(manager, r, { decision: 'REJECT', reason: 'Synthetic rejection' })).json().state).toBe('REJECTED');
    await submitted(a, [await line(a, 'OTHER', '61', { invoiceReference: rejected })]);

    const withdrawn = invoice();
    const w = await submitted(a, [await line(a, 'OTHER', '62', { invoiceReference: withdrawn })]);
    expect((await h.call(a, 'POST', `/v1/expense/claims/${w}/withdraw`)).json().state).toBe('WITHDRAWN');
    await submitted(a, [await line(a, 'OTHER', '63', { invoiceReference: withdrawn })]);

    const drafted = invoice();
    await draft(a, [await line(a, 'OTHER', '64', { invoiceReference: drafted })]);
    await submitted(a, [await line(a, 'OTHER', '65', { invoiceReference: drafted })]);

    const superseded = invoice();
    const returned = await submitted(a, [await line(a, 'OTHER', '66', { invoiceReference: superseded })]);
    expect((await decide(manager, returned, { decision: 'RETURN', reason: 'Synthetic return' })).json().state).toBe('RETURNED');
    const put = await h.call(a, 'PUT', `/v1/expense/claims/${returned}`, { expectedVersion: (await view(a, returned)).version, purpose: PURPOSE, currency: 'INR', lines: [await line(a, 'OTHER', '67', { invoiceReference: invoice() })] });
    expect(put.statusCode).toBe(200);
    await submitted(a, [await line(a, 'OTHER', '68', { invoiceReference: superseded })]);
  });

  it('two colleagues submitting one invoice at the same moment: one goes through and the other is suspected', async () => {
    const [a, b] = [await person(), await person()];
    const invoiceReference = invoice();
    const first = await draft(a, [await line(a, 'OTHER', '70', { invoiceReference })]);
    const second = await draft(b, [await line(b, 'OTHER', '71', { invoiceReference })]);
    // Hold the invoice's key until both are waiting on it, so neither can finish before the other has started.
    const key = `hashtextextended('expense_duplicate:invoice:' || $1::text || ':' || hrms_expense_invoice_key('Synthetic Merchant', $2), 0)`;
    await h.db.query(`select pg_advisory_lock(${key})`, [A.id, invoiceReference]);
    const running = [submit(a, first), submit(b, second)];
    for (let i = 0; ; i++) {
      const waiting = await h.db.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and wait_event_type = 'Lock' and wait_event = 'advisory'`);
      if (waiting.rows[0]!.n >= 2) break;
      if (i > 400) throw new Error('both submissions should wait on the invoice key');
      await new Promise((res) => setTimeout(res, 25));
    }
    await h.db.query(`select pg_advisory_unlock(${key})`, [A.id, invoiceReference]);
    const results = await Promise.all(running);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 422]);
    expect(results.find((r) => r.statusCode === 422)!.json()).toMatchObject(dup);
  });
});

describe('nights grouped across accommodation lines (FR-071, FR-078, DF06 "actual expense service date and declared nights")', () => {
  // The provisioned limit is 5,000 a night.
  const stay = (a: TestActor, amount: string, firstNightAgo: number, nights: number, category = 'ACCOMMODATION') => line(a, category, amount, { expenseDate: daysAgo(firstNightAgo), nights });
  const over = (...lines: number[]) => flagged(...lines.map((n) => ({ line: n, flags: ['OVER_LIMIT'] })));

  it('two lines for one night are together over the limit, though each is within it', async () => {
    const a = await person();
    const id = await draft(a, [await stay(a, '5000', 10, 1), await stay(a, '4000', 10, 1)]);
    expect((await submit(a, id)).json()).toMatchObject(over(1, 2));
  });

  it('a stay and a line sharing one of its nights: 10,000 for two nights plus 5,000 for the second', async () => {
    const a = await person();
    const id = await draft(a, [await stay(a, '10000', 10, 2), await stay(a, '5000', 9, 1)]);
    expect((await submit(a, id)).json()).toMatchObject(over(1, 2));
  });

  it('counts a night held by the employee\'s other live claims, and flags the later claim only', async () => {
    const a = await person();
    const first = await submitted(a, [await stay(a, '5000', 10, 1)]);
    const second = await draft(a, [await stay(a, '4000', 10, 1)]);
    expect((await submit(a, second)).json()).toMatchObject(over(1));
    expect(await flagsOf(a, first)).toEqual([[]]);
    // A later claim overlapping a stay in an earlier one, not only the same first night.
    const third = await draft(a, [await stay(a, '100', 9, 1)]);
    expect((await submit(a, third)).statusCode).toBe(200);
    const fourth = await submitted(a, [await stay(a, '9000', 7, 2)]);
    const fifth = await draft(a, [await stay(a, '1500', 6, 1)]);
    expect((await submit(a, fifth)).json()).toMatchObject(over(1));
    expect(await flagsOf(a, fourth)).toEqual([[]]);
  });

  it('a withdrawn or rejected claim no longer holds its nights; a draft and a colleague\'s stay never do', async () => {
    const a = await person();
    const withdrawn = await submitted(a, [await stay(a, '5000', 12, 1)]);
    expect((await h.call(a, 'POST', `/v1/expense/claims/${withdrawn}/withdraw`)).json().state).toBe('WITHDRAWN');
    const rejected = await submitted(a, [await stay(a, '5000', 12, 1)]);
    expect((await decide(manager, rejected, { decision: 'REJECT', reason: 'Synthetic rejection' })).statusCode).toBe(200);
    await draft(a, [await stay(a, '5000', 12, 1)]);
    const b = await person();
    await submitted(b, [await stay(b, '5000', 12, 1)]);
    const held = await submitted(a, [await stay(a, '5000', 12, 1)]);
    expect(await flagsOf(a, held)).toEqual([[]]);
  });

  it('nights that do not coincide are not grouped, at the limit each', async () => {
    const a = await person();
    const held = await submitted(a, [await stay(a, '5000', 10, 1), await stay(a, '5000', 9, 1), await stay(a, '10000', 8, 2)]);
    expect(await flagsOf(a, held)).toEqual([[], [], []]);
  });

  it('flags only what no spreading over the declared nights could fit', async () => {
    const a = await person();
    // 8,000 for two nights and 1,500 on the second fit under 5,000 a night (5,000 and 4,500).
    const fits = await submitted(a, [await stay(a, '8000', 20, 2), await stay(a, '1500', 19, 1)]);
    expect(await flagsOf(a, fits)).toEqual([[], []]);
    // 1,000 over three nights beside 9,000 on the middle one: only the middle line cannot fit.
    const b = await person();
    const id = await draft(b, [await stay(b, '1000', 20, 3), await stay(b, '9000', 19, 1)]);
    expect((await submit(b, id)).json()).toMatchObject(over(2));
    // A stay over the limit does not flag the night before it, which it shares no night with.
    const c = await person();
    const beside = await draft(c, [await stay(c, '100', 20, 1), await stay(c, '11000', 19, 1)]);
    expect((await submit(c, beside)).json()).toMatchObject(over(2));
  });

  it('a line alone: its amount against the limit for its own nights', async () => {
    const a = await person();
    const within = await submitted(a, [await stay(a, '10000', 10, 2)]);
    expect(await flagsOf(a, within)).toEqual([[]]);
    const b = await person();
    const beyond = await draft(b, [await stay(b, '10000.01', 10, 2)]);
    expect((await submit(b, beyond)).json()).toMatchObject(over(1));
  });

  it('stays in another category are not grouped with these', async () => {
    const a = await person();
    const apart = await submitted(a, [await stay(a, '3000', 10, 1), await stay(a, '3000', 10, 1, 'CAMP')]);
    expect(await flagsOf(a, apart)).toEqual([[], []]);
  });
});

describe('the purpose of each revision (FR-072, FR-074, BR-017, line 103)', () => {
  const returned = async (a: TestActor, purpose: string) => {
    const id = await draft(a, [await line(a, 'OTHER', '90')], purpose);
    expect((await submit(a, id)).statusCode).toBe(200);
    expect((await decide(manager, id, { decision: 'RETURN', reason: 'Please correct (synthetic)' })).json().state).toBe('RETURNED');
    return id;
  };
  const revise = async (a: TestActor, id: string, purpose: string) => {
    const res = await h.call(a, 'PUT', `/v1/expense/claims/${id}`, { expectedVersion: (await view(a, id)).version, purpose, currency: 'INR', lines: [await line(a, 'OTHER', '91')] });
    expect(res.statusCode, res.body).toBe(200);
  };

  it('what the reviewer saw in revision 1 survives the correction and resubmission', async () => {
    const a = await person();
    const id = await returned(a, 'Client visit as first reviewed (synthetic)');
    await revise(a, id, 'Client visit as corrected (synthetic)');
    // Before resubmitting, the claimant's draft is the current text; the record of what was reviewed is untouched.
    const whileEditing = await view(a, id);
    expect(whileEditing.purpose).toBe('Client visit as corrected (synthetic)');
    expect(whileEditing.revisions).toEqual([expect.objectContaining({ revision: 1, purpose: 'Client visit as first reviewed (synthetic)', claimedTotal: '90.00' })]);
    expect((await submit(a, id)).statusCode).toBe(200);
    for (const reader of [a, manager]) {
      const shown = await view(reader, id);
      expect(shown.purpose).toBe('Client visit as corrected (synthetic)');
      expect(shown.revisions).toEqual([
        expect.objectContaining({ revision: 1, purpose: 'Client visit as first reviewed (synthetic)', claimedTotal: '90.00' }),
        expect.objectContaining({ revision: 2, purpose: 'Client visit as corrected (synthetic)', claimedTotal: '91.00' }),
      ]);
    }
  });

  it('a submitted revision\'s purpose is frozen in the database, and every new revision must have one', async () => {
    const a = await person();
    const id = await returned(a, 'Frozen purpose (synthetic)');
    await expectSqlError(h.db.query(`update expense_revision set purpose = 'Rewritten' where claim_id = $1 and revision = 1`, [id]), CHECK_VIOLATION);
    await revise(a, id, 'Open draft purpose (synthetic)');
    await h.db.query(`update expense_revision set purpose = 'A draft can still change' where claim_id = $1 and revision = 2`, [id]);
    await expectSqlError(h.db.query(`update expense_revision set purpose = null where claim_id = $1 and revision = 2`, [id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`update expense_revision set purpose = '  ' where claim_id = $1 and revision = 2`, [id]), CHECK_VIOLATION);
    await expectSqlError(h.db.query(`insert into expense_revision (company_id, claim_id, revision, currency_code) values ($1, $2, 3, 'INR')`, [A.id, id]), CHECK_VIOLATION);
  });

  it('every read gives the revision\'s own purpose: the claim, the claim list and the payables', async () => {
    const a = await person();
    const id = await submitted(a, [await line(a, 'OTHER', '95')]);
    expect((await decide(manager, id, { decision: 'APPROVE' })).statusCode).toBe(200);
    const lineId = (await view(fin, id)).lines[0].id;
    expect((await decide(fin, id, { decision: 'APPROVE', lines: [{ lineId, allowedAmount: '95' }] })).json().state).toBe('APPROVED');
    await h.db.query(`update expense_claim set purpose = 'Overwritten copy' where id = $1`, [id]);
    expect((await view(a, id)).purpose).toBe(PURPOSE);
    const employeeId = (await h.one<{ employee_id: string }>(`select employee_id from expense_claim where id = $1`, [id])).employee_id;
    expect((await h.call(a, 'GET', `/v1/employees/${employeeId}/expense-claims`)).json().items[0].purpose).toBe(PURPOSE);
    expect(((await h.call(fin, 'GET', '/v1/expense/payables')).json().items as { claimId: string; purpose: string }[]).find((p) => p.claimId === id)!.purpose).toBe(PURPOSE);
  });

  it('starting a new revision is audited', async () => {
    const a = await person();
    const id = await returned(a, 'Audited purpose (synthetic)');
    await revise(a, id, 'Audited correction (synthetic)');
    await revise(a, id, 'Audited second edit of that draft (synthetic)');
    // Editing the open draft again stays revision 2, with the text it now has.
    expect((await view(a, id)).purpose).toBe('Audited second edit of that draft (synthetic)');
    expect((await submit(a, id)).statusCode).toBe(200);
    expect((await view(a, id)).revisions.map((r: { revision: number; purpose: string }) => [r.revision, r.purpose])).toEqual([
      [1, 'Audited purpose (synthetic)'],
      [2, 'Audited second edit of that draft (synthetic)'],
    ]);
    const events =(await h.db.query<{ action: string; after_values: unknown }>(`select action, after_values from audit_event where resource_code = 'expense_claim' and record_key = $1 and action = 'REVISE'`, [id])).rows;
    expect(events).toEqual([expect.objectContaining({ action: 'REVISE', after_values: { operational: { revision: 2 } } })]);
  });

  it('drafting and revising re-check the duty inside their transaction', async () => {
    const a = await person();
    const id = await draft(a, [await line(a, 'OTHER', '96')]);
    const version = (await view(a, id)).version as number;
    const grant = (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'expense', action: 'draft', fieldGroups: ['operational'] })) as AccessGrant;
    expect(grant.allowed).toBe(true);
    await h.db.query(`update role_assignment_permission set active = false where company_id = $1 and role_assignment_id = $2 and permission_id in (select id from permission where resource = 'expense' and action = 'draft')`, [A.id, a.assignment]);
    const input = { purpose: 'After the grant ended (synthetic)', currency: 'INR', lines: [] };
    await expect(withTransaction(h.pool, (tx) => createDraft(tx, grant, input))).rejects.toMatchObject({ statusCode: 403 });
    await expect(withTransaction(h.pool, (tx) => reviseDraft(tx, grant, id, { ...input, expectedVersion: version }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.one<{ purpose: string }>(`select purpose from expense_revision where claim_id = $1`, [id])).purpose).toBe(PURPOSE);
  });
});

describe('the draft form\'s data', () => {
  it('the claimant reads back the receipt ids of their own claim to keep them when correcting it; nobody else gets them', async () => {
    const a = await person();
    const receipt = await upload(a);
    const id = await submitted(a, [await line(a, 'OTHER', '97', { receipt })]);
    expect((await view(a, id)).lines[0].receiptId).toBe(receipt.receiptId);
    expect((await view(fin, id)).lines[0]).not.toHaveProperty('receiptId');
    expect((await view(manager, id)).lines[0]).not.toHaveProperty('receiptId');
  });

  it('colleague and employee stay in their own lane', async () => {
    const id = await submitted(employee, [await line(employee, 'OTHER', '98')]);
    expect((await h.call(colleague, 'GET', `/v1/expense/claims/${id}`)).statusCode).toBe(404);
  });
});
