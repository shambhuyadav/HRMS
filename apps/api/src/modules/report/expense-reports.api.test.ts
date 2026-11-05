// The expense outputs of section 11 (line 2287; FR-079; BR-026; DF07; ZT17): each with the scope and period of its underlying
// claims, reconciling with the ledger and the lists. Column sets await the owner's samples (I-40 item 12); these tests hold what
// the figures mean. Synthetic INR amounts; dates relative to today.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { prepareReady, releaseNaming } from '../expense/payment.fixtures.js';
import { csvTable } from './csv.fixtures.js';
import { processReportQueue } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let reader: TestActor;
let fin1: TestActor;
let fin2: TestActor;
let fin3: TestActor;
let employee: TestActor;
let employeeCode: string;
let otherDeptEmployee: TestActor;
let otherDeptCode: string;
let paid: string;
let settled: string;
let unpaid: string;
let zero: string;
let waitingManager: string;
let waitingFinance: string;
let rejected: string;
let withdrawn: string;
let draftOnly: string;
let otherDeptClaim: string;

const FINANCE: PermissionKey[] = [
  'expense.read.operational',
  'expense.export.operational',
  'expense.manager_decide.operational',
  'expense.finance_decide.operational',
  'expense.high_value_decide.operational',
  'payment.read.operational',
  'payment.prepare.operational',
  'payment.release.operational',
  'payment.confirm_outcome.operational',
  'payment.reverse.operational',
];

const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const PERIOD = { from: daysAgo(10), to: daysAgo(-1) };
const line = async (a: TestActor, category: string, amount: string, extra: Record<string, unknown> = {}) => {
  const uploaded = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic report receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
  return { category, expenseDate: daysAgo(2), merchant: 'Synthetic Merchant', grossAmount: amount, claimedAmount: amount, description: `${category} (synthetic)`, receipt: { receiptId: uploaded.json().receiptId as string }, ...extra };
};
const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const draft = async (a: TestActor, lines: object[]) => {
  const res = await h.call(a, 'POST', '/v1/expense/claims', { purpose: 'Reports check (synthetic)', currency: 'INR', lines });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().claimId as string;
};
const submitted = async (a: TestActor, lines: object[]) => {
  const id = await draft(a, lines);
  const res = await h.call(a, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(a, id)).version });
  expect(res.statusCode, res.body).toBe(200);
  return id;
};
const taskOf = async (a: TestActor, id: string) => {
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [id])).transaction_id;
  return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
};
const decide = async (a: TestActor, id: string, body: Record<string, unknown>) => {
  const res = await h.call(a, 'POST', `/v1/expense/tasks/${await taskOf(a, id)}/decision`, { idempotencyKey: uniq('report-key-'), ...body });
  expect(res.statusCode, res.body).toBe(200);
  return res.json();
};
const finalApprove = async (id: string, amount: (claimed: string) => string = (c) => c) => {
  await decide(manager, id, { decision: 'APPROVE' });
  const lines = (await view(fin1, id)).lines as { id: string; claimedAmount: string }[];
  await decide(fin1, id, { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: amount(l.claimedAmount), reason: 'Decided (synthetic)' })) });
};
const pay = async (claimId: string, amount: string) => {
  const res = await prepareReady(h, fin2, { claimId, amount, paymentDate: daysAgo(0), idempotencyKey: uniq('report-pay-') });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().instructionId as string;
};
const act = async (pi: string, path: string, body?: object) => {
  const res = path === 'release' ? await releaseNaming(h, fin3, pi) : await h.call(fin3, 'POST', `/v1/expense/payments/${pi}/${path}`, body);
  expect(res.statusCode, res.body).toBe(200);
};

/** Generates a report and reads it as rows keyed by column header. */
async function report(a: TestActor, reportCode: string, filters: object = {}): Promise<Record<string, string>[]> {
  const requested = await h.call(a, 'POST', '/v1/reports', { reportCode, filters });
  expect(requested.statusCode, requested.body).toBe(202);
  await processReportQueue(h.pool);
  const res = await h.call(a, 'GET', `/v1/reports/${requested.json().id}/download`);
  expect(res.statusCode, res.body).toBe(200);
  const [header, ...rows] = csvTable(res.body).trimEnd().split('\r\n').map((row: string) => row.split(/,(?=")/).map((cell) => cell.replace(/^"|"$/g, '').replace(/""/g, '"')));
  return rows.map((row) => Object.fromEntries(header!.map((column, i) => [column, row[i]!])));
}

async function withoutTriggers(work: () => Promise<unknown>) {
  await h.db.query(`set session_replication_role = replica`);
  try {
    await work();
  } finally {
    await h.db.query(`set session_replication_role = origin`);
  }
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  fin1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin3 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  reader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.export.operational', 'payment.export.operational', 'expense.read.operational', 'payment.read.operational'] });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [A.id, fin1.user]);
  const person = async (overrides: Record<string, unknown> = {}) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return { id: e.id as string, code: e.employeeCode as string };
  };
  const boss = await person();
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: boss.id });
  const own = await person();
  employeeCode = own.code;
  await h.call(hr, 'POST', `/v1/employees/${own.id}/manager`, { managerEmployeeId: boss.id, effectiveFrom: '2026-01-05' });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: own.id });
  const other = await person({ departmentId: A.financeDept });
  otherDeptCode = other.code;
  await h.call(hr, 'POST', `/v1/employees/${other.id}/manager`, { managerEmployeeId: boss.id, effectiveFrom: '2026-01-05' });
  otherDeptEmployee = await h.actor(A, 'EMPLOYEE', { employeeId: other.id });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);

  // DF07's worked example: approved 1,000, paid 600, reversal 100, pending 300.
  paid = await submitted(employee, [await line(employee, 'OTHER', '400', { invoiceReference: 'REPORT-INV-1' }), await line(employee, 'TRAVEL', '600', { expenseDate: daysAgo(3), merchant: '=Synthetic formula' })]);
  await finalApprove(paid);
  const first = await pay(paid, '600');
  await act(first, 'release');
  await act(first, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('report-evidence-') });
  await act(first, 'reversal', { amount: '100', evidenceKey: uniq('report-reversal-'), reason: 'Bank return (synthetic)' });
  await pay(paid, '300');

  // Paid in full: nothing outstanding.
  settled = await submitted(employee, [await line(employee, 'MEALS', '40', { expenseDate: daysAgo(9) })]);
  await finalApprove(settled);
  const whole = await pay(settled, '40');
  await act(whole, 'release');
  await act(whole, 'outcome', { outcome: 'CONFIRMED', evidenceKey: uniq('report-evidence-') });

  // A reduced approval, nothing paid.
  unpaid = await submitted(employee, [await line(employee, 'OTHER', '200', { expenseDate: daysAgo(4) })]);
  await finalApprove(unpaid, () => '150');
  // A zero entitlement: approved with nothing payable.
  zero = await submitted(employee, [await line(employee, 'OFFICE_SUPPLIES', '50')]);
  await finalApprove(zero, () => '0');

  waitingManager = await submitted(employee, [await line(employee, 'OTHER', '70', { expenseDate: daysAgo(5) })]);
  waitingFinance = await submitted(employee, [await line(employee, 'OTHER', '80', { expenseDate: daysAgo(6) })]);
  await decide(manager, waitingFinance, { decision: 'APPROVE' });
  rejected = await submitted(employee, [await line(employee, 'OTHER', '90', { expenseDate: daysAgo(7) })]);
  await decide(manager, rejected, { decision: 'REJECT', reason: 'Synthetic rejection' });
  withdrawn = await submitted(employee, [await line(employee, 'OTHER', '60', { expenseDate: daysAgo(8) })]);
  expect((await h.call(employee, 'POST', `/v1/expense/claims/${withdrawn}/withdraw`)).statusCode).toBe(200);
  draftOnly = await draft(employee, [await line(employee, 'OTHER', '10')]);

  otherDeptClaim = await submitted(otherDeptEmployee, [await line(otherDeptEmployee, 'OTHER', '110', { expenseDate: daysAgo(4) })]);
});

afterAll(async () => {
  await h?.stop();
});

describe('the catalogue (FR-079)', () => {
  it('offers each output of section 11 with its columns', async () => {
    const items = (await h.call(reader, 'GET', '/v1/reports/catalogue')).json().items as { code: string; title: string; requiresPeriod: boolean }[];
    const shown = Object.fromEntries(items.map((r) => [r.code, r]));
    expect(shown.EXPENSE_REGISTER!.title).toBe('Expense claim register');
    expect(shown.EXPENSE_LINE_REGISTER).toMatchObject({ title: 'Expense claim line register', requiresPeriod: true });
    expect(shown.EXPENSE_APPROVAL_AGEING).toMatchObject({ title: 'Expense approval ageing', requiresPeriod: false });
    expect(shown.EXPENSE_CATEGORY_SPEND).toMatchObject({ title: 'Expense category spend', requiresPeriod: true });
    expect(shown.EXPENSE_PAYABLE_AGEING).toMatchObject({ title: 'Expense payable ageing', requiresPeriod: false });
    expect(shown.EXPENSE_PAYMENT_RECONCILIATION).toMatchObject({ title: 'Expense payment reconciliation', requiresPeriod: true });
  });

  it('needs the export right, a period where it has one, and refuses one where it has none', async () => {
    for (const code of ['EXPENSE_LINE_REGISTER', 'EXPENSE_APPROVAL_AGEING', 'EXPENSE_CATEGORY_SPEND', 'EXPENSE_PAYABLE_AGEING', 'EXPENSE_PAYMENT_RECONCILIATION']) {
      expect((await h.call(hr, 'POST', '/v1/reports', { reportCode: code, filters: PERIOD })).statusCode, code).toBe(403);
      expect((await h.call(employee, 'POST', '/v1/reports', { reportCode: code, filters: PERIOD })).statusCode, code).toBe(403);
    }
    for (const code of ['EXPENSE_LINE_REGISTER', 'EXPENSE_CATEGORY_SPEND', 'EXPENSE_PAYMENT_RECONCILIATION']) {
      expect((await h.call(reader, 'POST', '/v1/reports', { reportCode: code })).json().error, code).toBe('PERIOD_REQUIRED');
    }
    for (const code of ['EXPENSE_APPROVAL_AGEING', 'EXPENSE_PAYABLE_AGEING']) {
      const refused = await h.call(reader, 'POST', '/v1/reports', { reportCode: code, filters: PERIOD });
      expect(refused.statusCode, code).toBe(422);
      expect(refused.json().error, code).toBe('FILTER_NOT_SUPPORTED');
    }
  });

  const CLAIM_REPORTS: [string, object][] = [
    ['EXPENSE_REGISTER', PERIOD],
    ['EXPENSE_LINE_REGISTER', PERIOD],
    ['EXPENSE_APPROVAL_AGEING', {}],
    ['EXPENSE_CATEGORY_SPEND', PERIOD],
    ['EXPENSE_PAYABLE_AGEING', {}],
    ['EXPENSE_PAYMENT_RECONCILIATION', PERIOD],
  ];

  it('an export right alone opens no claim: amounts are for assigned reviewers and payment operators (DF02 "exports"; decisions-2)', async () => {
    const exportOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.export.operational', 'payment.export.operational'] });
    for (const [code, filters] of CLAIM_REPORTS) {
      expect(await report(exportOnly, code, filters), code).toEqual([]);
      expect((await report(reader, code, filters)).length, code).toBeGreaterThan(0);
    }
  });

  it('a reviewer’s export holds the claims their step was assigned, and no other', async () => {
    const reviewerExport = await h.actor(A, 'HR_ADMINISTRATOR', { user: fin1.user, extra: ['expense.export.operational', 'expense.read.operational', 'expense.finance_decide.operational'] });
    const claims = (await report(reviewerExport, 'EXPENSE_REGISTER', PERIOD)).map((r) => r.Claim);
    // fin1 took the finance step of these; the manager step of `waitingManager` and `rejected` never reached them.
    expect(claims).toEqual(expect.arrayContaining([paid, settled, unpaid, zero]));
    expect(claims).not.toContain(waitingManager);
    expect(claims).not.toContain(rejected);
    expect(claims).not.toContain(otherDeptClaim);
  });
});

describe('the line register', () => {
  it('has one row per line of the current submitted revision, with its final amount, by submission period', async () => {
    const rows = await report(reader, 'EXPENSE_LINE_REGISTER', PERIOD);
    const ofPaid = rows.filter((r) => r.Claim === paid);
    expect(ofPaid).toHaveLength(2);
    expect(ofPaid[0]).toMatchObject({ 'Employee code': employeeCode, Revision: '1', State: 'APPROVED', Line: '1', Category: 'OTHER', 'Invoice reference': 'REPORT-INV-1', 'Claimed amount': '400.00', 'Approved amount': '400.00', Currency: 'INR' });
    expect(ofPaid[1]).toMatchObject({ Line: '2', Category: 'TRAVEL', 'Expense date': daysAgo(3), Merchant: "'=Synthetic formula", 'Claimed amount': '600.00', 'Approved amount': '600.00' });
    expect(rows.find((r) => r.Claim === unpaid)).toMatchObject({ 'Claimed amount': '200.00', 'Approved amount': '150.00' });
    // Not yet decided: no approved amount. A draft was never submitted.
    expect(rows.find((r) => r.Claim === waitingManager)).toMatchObject({ State: 'MANAGER_PENDING', 'Approved amount': '' });
    expect(rows.some((r) => r.Claim === draftOnly)).toBe(false);
    expect(await report(reader, 'EXPENSE_LINE_REGISTER', { from: daysAgo(400), to: daysAgo(300) })).toEqual([]);
  });

  it('shows a flagged line\'s flags, never its reasons', async () => {
    const a = otherDeptEmployee;
    const flagged = await submitted(a, [await line(a, 'MEALS', '1500', { exceptionReason: 'SECRET-CLAIMANT-REASON (synthetic)', expenseDate: daysAgo(9) })]);
    const rows = await report(reader, 'EXPENSE_LINE_REGISTER', PERIOD);
    expect(rows.find((r) => r.Claim === flagged)).toMatchObject({ Flags: 'OVER_LIMIT' });
    expect(JSON.stringify(rows)).not.toContain('SECRET-CLAIMANT-REASON');
  });
});

describe('approval ageing', () => {
  it('lists each claim waiting, its step and reviewer, with its age in calendar days', async () => {
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [waitingFinance])).transaction_id;
    await withoutTriggers(() =>
      h.db.query(`update approval_task t set created_at = now() - interval '6 days' from approval_instance i where i.company_id = t.company_id and i.id = t.instance_id and i.transaction_id = $1 and t.state = 'PENDING'`, [tx]),
    );
    const rows = await report(reader, 'EXPENSE_APPROVAL_AGEING');
    // Its open task only: the manager's decided task of the same claim is not waiting.
    expect(rows.filter((r) => r.Claim === waitingFinance)).toHaveLength(1);
    const finance = rows.find((r) => r.Claim === waitingFinance)!;
    expect(finance).toMatchObject({ State: 'FINANCE_PENDING', Step: 'finance_decide', Revision: '1', 'Claimed total': '80.00', Currency: 'INR', 'Age (calendar days)': '6' });
    const fin1Key = (await h.one<{ account_key: string }>(`select account_key from user_account where id = $1`, [fin1.user])).account_key;
    expect(finance.Reviewer).toBe(fin1Key);
    expect(rows.find((r) => r.Claim === waitingManager)).toMatchObject({ State: 'MANAGER_PENDING', Step: 'manager_decide', 'Age (calendar days)': '0' });
    // Oldest first; only what is waiting.
    expect(rows[0]!.Claim).toBe(waitingFinance);
    for (const closed of [paid, settled, unpaid, zero, rejected, withdrawn, draftOnly]) expect(rows.some((r) => r.Claim === closed), closed).toBe(false);
  });
});

describe('category spend', () => {
  it('adds up what final approval entitled, per category and currency, and reconciles with the claim register', async () => {
    const rows = await report(reader, 'EXPENSE_CATEGORY_SPEND', PERIOD);
    const by = Object.fromEntries(rows.map((r) => [r.Category, r]));
    expect(by.OTHER).toMatchObject({ 'Category name': 'Other business expense', Currency: 'INR', 'Approved claims': '2', Lines: '2', 'Claimed total': '600.00', 'Approved total': '550.00' });
    expect(by.TRAVEL).toMatchObject({ 'Approved claims': '1', Lines: '1', 'Claimed total': '600.00', 'Approved total': '600.00' });
    expect(by.MEALS).toMatchObject({ 'Approved claims': '1', Lines: '1', 'Claimed total': '40.00', 'Approved total': '40.00' });
    expect(by.OFFICE_SUPPLIES).toMatchObject({ 'Approved claims': '1', 'Claimed total': '50.00', 'Approved total': '0.00' });
    const register = await report(reader, 'EXPENSE_REGISTER', PERIOD);
    const approvedInRegister = register.filter((r) => r.State === 'APPROVED').reduce((sum, r) => sum + Number(r['Approved amount'] || 0), 0);
    expect(rows.reduce((sum, r) => sum + Number(r['Approved total']), 0)).toBe(approvedInRegister);
    expect(await report(reader, 'EXPENSE_CATEGORY_SPEND', { from: daysAgo(400), to: daysAgo(300) })).toEqual([]);
  });
});

describe('payable ageing', () => {
  it('lists the same claims as the payables list, with their age since approval and the ledger\'s figures', async () => {
    await withoutTriggers(() => h.db.query(`update expense_obligation set created_at = now() - interval '4 days' where claim_id = $1`, [unpaid]));
    const rows = await report(reader, 'EXPENSE_PAYABLE_AGEING');
    const list = (await h.call(reader, 'GET', '/v1/expense/payables')).json().items as { claimId: string; approvedAmount: string; netPaid: string; pending: string; allocatable: string; paymentState: string }[];
    expect(rows.map((r) => r.Claim).sort()).toEqual(list.map((p) => p.claimId).sort());
    expect(rows[0]).toMatchObject({ Claim: unpaid, 'Age (calendar days)': '4', 'Approved amount': '150.00', 'Net paid': '0.00', Pending: '0.00', Outstanding: '150.00', Allocatable: '150.00', 'Payment state': 'UNPAID' });
    const part = rows.find((r) => r.Claim === paid)!;
    expect(part).toMatchObject({ 'Age (calendar days)': '0', 'Approved amount': '1000.00', 'Net paid': '500.00', Pending: '300.00', Outstanding: '500.00', Allocatable: '200.00', 'Payment state': 'PART_PAID' });
    expect(part).toMatchObject({ Allocatable: list.find((p) => p.claimId === paid)!.allocatable, 'Net paid': list.find((p) => p.claimId === paid)!.netPaid });
    // A zero entitlement has nothing payable, and a claim paid in full nothing left.
    expect(rows.some((r) => r.Claim === zero)).toBe(false);
    expect(rows.some((r) => r.Claim === settled)).toBe(false);
  });
});

describe('payment reconciliation (DF07)', () => {
  it('reconciles DF07\'s example: approved 1,000, paid 600, reversal 100, pending 300', async () => {
    const rows = await report(reader, 'EXPENSE_PAYMENT_RECONCILIATION', PERIOD);
    const row = rows.find((r) => r.Claim === paid)!;
    expect(row).toMatchObject({ 'Employee code': employeeCode, 'Approved amount': '1000.00', Confirmed: '600.00', Reversed: '100.00', 'Net paid': '500.00', Pending: '300.00', Outstanding: '500.00', Allocatable: '200.00', 'Payment state': 'PART_PAID', Currency: 'INR' });
    for (const r of rows) {
      expect(Number(r.Confirmed) - Number(r.Reversed)).toBe(Number(r['Net paid']));
      expect(Number(r['Net paid']) + Number(r.Outstanding)).toBe(Number(r['Approved amount']));
      expect(Number(r['Net paid']) + Number(r.Pending)).toBeLessThanOrEqual(Number(r['Approved amount']));
    }
    expect(rows.find((r) => r.Claim === unpaid)).toMatchObject({ Confirmed: '0.00', Reversed: '0.00', 'Net paid': '0.00', Outstanding: '150.00' });
    expect(rows.find((r) => r.Claim === settled)).toMatchObject({ Confirmed: '40.00', 'Net paid': '40.00', Outstanding: '0.00', 'Payment state': 'PAID' });
    expect(rows.some((r) => r.Claim === zero)).toBe(false);
    expect(await report(reader, 'EXPENSE_PAYMENT_RECONCILIATION', { from: daysAgo(400), to: daysAgo(300) })).toEqual([]);
  });
});

describe('row scope (FR-079 "same scope"; BR-026)', () => {
  it('a reader limited to one department sees only that department\'s claims, in every output', async () => {
    const limited = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['expense.export.operational', 'payment.export.operational', 'payment.read.operational'], departmentFilter: A.financeDept });
    const lines = await report(limited, 'EXPENSE_LINE_REGISTER', PERIOD);
    expect(new Set(lines.map((r) => r['Employee code']))).toEqual(new Set([otherDeptCode]));
    const ageing = await report(limited, 'EXPENSE_APPROVAL_AGEING');
    expect(ageing.map((r) => r.Claim)).toContain(otherDeptClaim);
    expect(new Set(ageing.map((r) => r['Employee code']))).toEqual(new Set([otherDeptCode]));
    // That department's only claims are still in review, so nothing was entitled there.
    expect(await report(limited, 'EXPENSE_CATEGORY_SPEND', PERIOD)).toEqual([]);
    expect(await report(limited, 'EXPENSE_PAYABLE_AGEING')).toEqual([]);
    expect(await report(limited, 'EXPENSE_PAYMENT_RECONCILIATION', PERIOD)).toEqual([]);

    const whole = await report(reader, 'EXPENSE_LINE_REGISTER', PERIOD);
    expect(whole.length).toBeGreaterThan(lines.length);
  });
});
