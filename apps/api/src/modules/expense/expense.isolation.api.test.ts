// ZT01 / ZT39 for expense: another company's claims, lines, receipts, tasks and payments, by direct identifier. A payment operator with
// every duty, an assigned reviewer and a claimant of company B ask for company A's records; each table entry proves its refusal is the
// record's company and not a missing duty. claim-evidence.api.test.ts holds one duplicate-invoice check across companies, and
// report-parity.api.test.ts the register. Synthetic INR amounts and dates relative to today.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { changedTables, companyState } from '../../test/company-state.fixtures.js';
import { type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type IsolationContext, itListsOnlyOwnRecords, itRefusesAnotherCompanyInTheHeader, itRefusesForeignRecords, type Probe, type World } from '../../test/isolation.fixtures.js';
import type { PermissionKey } from '../access/baseline.js';
import { prepareReady, releaseNaming } from './payment.fixtures.js';

let h: Harness;
let foreign: World;
let home: World;

const FINANCE: PermissionKey[] = [
  'expense.read.operational',
  'expense.export.operational',
  'expense.view_receipt.receipt',
  'expense.manager_decide.operational',
  'expense.finance_decide.operational',
  'expense.high_value_decide.operational',
  'payment.read.operational',
  'payment.prepare.operational',
  'payment.release.operational',
  'payment.confirm_outcome.operational',
  'payment.reverse.operational',
];
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const receiptBytes = () => Buffer.from(`%PDF-1.4\n% synthetic isolation receipt ${uniq('r')}\n%%EOF\n`).toString('base64');

async function world(): Promise<World> {
  const company = await h.makeCompany();
  const hr = await h.actor(company, 'HR_ADMINISTRATOR');
  const fin1 = await h.actor(company, 'HR_ADMINISTRATOR', { extra: FINANCE });
  const fin2 = await h.actor(company, 'HR_ADMINISTRATOR', { extra: FINANCE });
  const fin3 = await h.actor(company, 'HR_ADMINISTRATOR', { extra: FINANCE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [company.id, fin1.user]);
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(company))).json() as { id: string; employeeCode: string };
    await h.setStatus(company, e.id, 'ACTIVE_CONFIRMED');
    return e;
  };
  const boss = await person();
  const claimant = await person();
  expect((await h.call(hr, 'POST', `/v1/employees/${claimant.id}/manager`, { managerEmployeeId: boss.id, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
  const manager = await h.actor(company, 'REPORTING_MANAGER', { employeeId: boss.id });
  const employee = await h.actor(company, 'EMPLOYEE', { employeeId: claimant.id });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);

  const purpose = `Isolation ${uniq('purpose')} (synthetic)`;
  const uploadReceipt = async () => {
    const res = await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: receiptBytes() });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().receiptId as string;
  };
  const lineOf = async (amount = '100') => ({ category: 'OTHER', expenseDate: daysAgo(2), merchant: 'Synthetic Merchant', grossAmount: amount, claimedAmount: amount, description: 'Synthetic line', receipt: { receiptId: await uploadReceipt() } });
  const drafted = async () => {
    const res = await h.call(employee, 'POST', '/v1/expense/claims', { purpose, currency: 'INR', lines: [await lineOf()] });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().claimId as string;
  };
  const versionOf = async (id: string) => (await h.one<{ version: number }>(`select version from expense_claim where id = $1`, [id])).version;
  const submitted = async () => {
    const id = await drafted();
    const res = await h.call(employee, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: await versionOf(id) });
    expect(res.statusCode, res.body).toBe(200);
    return id;
  };
  const taskOf = async (a: TestActor, claimId: string) => {
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
    return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
  };
  const decide = async (a: TestActor, claimId: string, body: Record<string, unknown>) => {
    const res = await h.call(a, 'POST', `/v1/expense/tasks/${await taskOf(a, claimId)}/decision`, { idempotencyKey: uniq('iso-exp-'), ...body });
    expect(res.statusCode, res.body).toBe(200);
  };
  const linesOf = async (claimId: string) => (await h.call(fin1, 'GET', `/v1/expense/claims/${claimId}`)).json().lines as { id: string }[];
  const finalBody = async (claimId: string) => ({ decision: 'APPROVE', lines: (await linesOf(claimId)).map((l) => ({ lineId: l.id, allowedAmount: '100', reason: 'Decided (synthetic)' })) });
  const approved = async () => {
    const id = await submitted();
    await decide(manager, id, { decision: 'APPROVE' });
    await decide(fin1, id, await finalBody(id));
    return id;
  };
  const prepared = async () => {
    const claimId = await approved();
    const res = await h.call(fin2, 'POST', '/v1/expense/payments', { claimId, amount: '100', paymentDate: daysAgo(0), idempotencyKey: uniq('iso-pay-') });
    expect(res.statusCode, res.body).toBe(201);
    return { claimId, instruction: res.json().instructionId as string };
  };
  const ready = async () => {
    const claimId = await approved();
    const res = await prepareReady(h, fin2, { claimId, amount: '100', paymentDate: daysAgo(0), idempotencyKey: uniq('iso-pay-') });
    expect(res.statusCode, res.body).toBe(201);
    return { claimId, instruction: res.json().instructionId as string };
  };
  const released = async () => {
    const r = await ready();
    expect((await releaseNaming(h, fin3, r.instruction)).statusCode).toBe(200);
    return r;
  };

  const toEdit = await drafted();
  const toSubmit = await drafted();
  const toWithdraw = await submitted();
  const atManager = await submitted();
  const atFinance = await submitted();
  await decide(manager, atFinance, { decision: 'APPROVE' });
  const viewed = await approved();
  const lineWithReceipt = (await linesOf(viewed))[0]!.id;
  const toPrepare = await approved();
  const toMarkReady = await prepared();
  const toRelease = await ready();
  const toAssign = await released();
  const toConfirm = await released();
  const toReverse = await released();
  expect((await h.call(fin3, 'POST', `/v1/expense/payments/${toReverse.instruction}/outcome`, { outcome: 'CONFIRMED', evidenceKey: uniq('iso-evidence-') })).statusCode).toBe(200);
  const spareReceipt = await uploadReceipt();

  return {
    company,
    actors: { hr, fin1, fin2, fin3, manager, employee },
    ids: {
      claimant: claimant.id,
      code: claimant.employeeCode,
      purpose,
      toEdit,
      toSubmit,
      toWithdraw,
      managerTask: await taskOf(manager, atManager),
      financeTask: await taskOf(fin1, atFinance),
      financeLine: (await linesOf(atFinance))[0]!.id,
      viewed,
      lineWithReceipt,
      toPrepare,
      toMarkReady: toMarkReady.instruction,
      toRelease: toRelease.instruction,
      toAssign: toAssign.instruction,
      toConfirm: toConfirm.instruction,
      toReverse: toReverse.instruction,
      spareReceipt,
      fin3User: fin3.user,
    },
    versions: { toEdit: await versionOf(toEdit), toSubmit: await versionOf(toSubmit) },
  };
}

const ctx = (): IsolationContext => ({ h, foreign, home });

const editBody = (w: World) => ({ purpose: 'Edited by another company (synthetic)', currency: 'INR', expectedVersion: w.versions.toEdit, lines: [{ category: 'OTHER', expenseDate: daysAgo(2), merchant: 'Synthetic Merchant', grossAmount: '100', claimedAmount: '100', description: 'Synthetic line', receipt: { receiptId: w.ids.spareReceipt } }] });

const READS: Probe[] = [
  { name: 'GET a foreign claim', as: 'fin1', method: 'GET', path: (w) => `/v1/expense/claims/${w.ids.viewed}` },
  { name: 'GET a foreign employee’s claims', as: 'fin1', method: 'GET', path: (w) => `/v1/employees/${w.ids.claimant}/expense-claims` },
  { name: 'GET a foreign line’s receipt file', as: 'fin1', method: 'GET', path: (w) => `/v1/expense/lines/${w.ids.lineWithReceipt}/receipt` },
  { name: 'GET a foreign claim’s payments (history)', as: 'fin1', method: 'GET', path: (w) => `/v1/expense/claims/${w.ids.viewed}/payments` },
  { name: 'GET a foreign instruction’s outcome actors', as: 'fin3', method: 'GET', path: (w) => `/v1/expense/payments/${w.ids.toAssign}/outcome-actors` },
];

const WRITES: Probe[] = [
  { name: 'PUT a foreign draft', as: 'employee', method: 'PUT', path: (w) => `/v1/expense/claims/${w.ids.toEdit}`, body: editBody },
  { name: 'POST the submission of a foreign draft', as: 'employee', method: 'POST', path: (w) => `/v1/expense/claims/${w.ids.toSubmit}/submit`, body: (w) => ({ expectedVersion: w.versions.toSubmit }) },
  { name: 'POST the withdrawal of a foreign claim', as: 'employee', method: 'POST', path: (w) => `/v1/expense/claims/${w.ids.toWithdraw}/withdraw` },
  // The route finds the caller's own task first, to know which duty to check: under any other company there is none, so it reads as missing.
  { name: 'POST a manager decision on a foreign task', as: 'manager', method: 'POST', path: (w) => `/v1/expense/tasks/${w.ids.managerTask}/decision`, body: () => ({ decision: 'APPROVE', idempotencyKey: uniq('iso-exp-') }), headerRefusal: [404, 'NOT_FOUND'] },
  {
    name: 'POST a finance decision on a foreign task, naming its line',
    as: 'fin1',
    method: 'POST',
    path: (w) => `/v1/expense/tasks/${w.ids.financeTask}/decision`,
    body: (w) => ({ decision: 'APPROVE', idempotencyKey: uniq('iso-exp-'), lines: [{ lineId: w.ids.financeLine, allowedAmount: '100', reason: 'Decided (synthetic)' }] }),
    headerRefusal: [404, 'NOT_FOUND'],
  },
  { name: 'POST a payment against a foreign claim', as: 'fin2', method: 'POST', path: () => '/v1/expense/payments', body: (w) => ({ claimId: w.ids.toPrepare, amount: '100', paymentDate: daysAgo(0), idempotencyKey: uniq('iso-pay-') }), control: 201 },
  { name: 'POST the READY of a foreign instruction', as: 'fin2', method: 'POST', path: (w) => `/v1/expense/payments/${w.ids.toMarkReady}/ready` },
  { name: 'POST the release of a foreign instruction', as: 'fin3', method: 'POST', path: (w) => `/v1/expense/payments/${w.ids.toRelease}/release`, body: (w) => ({ outcomeActorUserId: w.ids.fin3User }) },
  { name: 'POST the outcome actor of a foreign instruction', as: 'fin3', method: 'POST', path: (w) => `/v1/expense/payments/${w.ids.toAssign}/outcome-actor`, body: (w) => ({ outcomeActorUserId: w.ids.fin3User, reason: 'Isolation check (synthetic)' }), control: 422 },
  { name: 'POST the outcome of a foreign instruction', as: 'fin3', method: 'POST', path: (w) => `/v1/expense/payments/${w.ids.toConfirm}/outcome`, body: () => ({ outcome: 'CONFIRMED', evidenceKey: uniq('iso-evidence-') }) },
  { name: 'POST the reversal of a foreign instruction', as: 'fin3', method: 'POST', path: (w) => `/v1/expense/payments/${w.ids.toReverse}/reversal`, body: () => ({ amount: '10', evidenceKey: uniq('iso-reversal-'), reason: 'Isolation check (synthetic)' }) },
];

beforeAll(async () => {
  h = await startHarness();
  foreign = await world();
  home = await world();
});

afterAll(async () => {
  await h?.stop();
});

describe('expense across companies (ZT01; ZT39; FR-079)', () => {
  // The lists first: the table below decides the home company's tasks as its positive control.
  itListsOnlyOwnRecords(ctx, [
    { name: 'GET /expense/tasks holds only the company’s own', as: 'fin1', path: '/v1/expense/tasks', holds: (w) => [w.ids.financeTask], never: (w) => [w.ids.financeTask, w.ids.managerTask, w.ids.code] },
    { name: 'GET /expense/payables holds only the company’s own', as: 'fin2', path: '/v1/expense/payables', holds: (w) => [w.ids.toPrepare, w.ids.code], never: (w) => [w.ids.toPrepare, w.ids.viewed, w.ids.code, w.ids.purpose] },
    { name: 'GET /expense/payments holds only the company’s own', as: 'fin3', path: '/v1/expense/payments', holds: (w) => [w.ids.toRelease], never: (w) => [w.ids.toRelease, w.ids.toConfirm, w.ids.toReverse, w.ids.code] },
  ]);
  itRefusesForeignRecords(ctx, [...READS, ...WRITES]);
  itRefusesAnotherCompanyInTheHeader(ctx, [...READS, ...WRITES.filter((p) => p.as !== 'employee')]);

  it('a receipt of another company cannot be put on one’s own claim', async () => {
    const employee = home.actors.employee!;
    const before = await companyState(h, foreign.company.id);
    const line = (receiptId: string) => ({ category: 'OTHER', expenseDate: daysAgo(2), merchant: 'Synthetic Merchant', grossAmount: '50', claimedAmount: '50', description: 'Synthetic line', receipt: { receiptId } });
    const body = (receiptId: string) => ({ purpose: 'Isolation check (synthetic)', currency: 'INR', lines: [line(receiptId)] });
    const inForeign = await h.call(employee, 'POST', '/v1/expense/claims', body(foreign.ids.spareReceipt!));
    const nowhere = await h.call(employee, 'POST', '/v1/expense/claims', body('00000000-0000-4000-8000-000000000009'));
    expect(inForeign.statusCode, inForeign.body).toBeGreaterThanOrEqual(400);
    expect(inForeign.statusCode, inForeign.body).toBeLessThan(500);
    expect([inForeign.statusCode, inForeign.json()]).toEqual([nowhere.statusCode, nowhere.json()]);
    expect(changedTables(before, await companyState(h, foreign.company.id))).toEqual([]);
    const fresh = (await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: receiptBytes() })).json().receiptId as string;
    expect((await h.call(employee, 'POST', '/v1/expense/claims', body(fresh))).statusCode).toBe(201);
  });

  it('the register export holds only the company’s claims, whatever else it is asked for', async () => {
    const { processReportQueue } = await import('../report/service.js');
    const requested = await h.call(home.actors.fin1!, 'POST', '/v1/reports', { reportCode: 'EXPENSE_REGISTER', filters: { from: daysAgo(30), to: daysAgo(-1) } });
    expect(requested.statusCode, requested.body).toBe(202);
    await processReportQueue(h.pool);
    const file = await h.call(home.actors.fin1!, 'GET', `/v1/reports/${requested.json().id}/download`);
    expect(file.statusCode, file.body).toBe(200);
    expect(file.body).toContain(home.ids.code);
    for (const value of [foreign.ids.code!, foreign.ids.viewed!, foreign.ids.toPrepare!]) expect(file.body).not.toContain(value);
  });
});
