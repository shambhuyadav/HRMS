// ZT06 "Referential scan shows zero orphans": the scan over a database filled by the application itself, the seed and real requests
// across modules, with no write that goes round a key. It is scoped to what those rows are: the test states how many keys actually
// held rows, so a passing scan cannot be mistaken for one over an empty database. db/tests/fk-catalogue.test.ts proves the scan finds a
// planted orphan and a planted company mismatch. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { foreignKeys, orphanScan } from '../../../../db/tests/catalogue.fixtures.js';
import { uniq } from '../../../../db/tests/fixtures.js';
import { seedDevCompany } from '../dev/seed.js';
import type { PermissionKey } from '../modules/access/baseline.js';
import { dispatchOutbox } from '../modules/notification/dispatcher.js';
import { type Company, type Harness, startHarness, type TestActor } from './harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let fin: TestActor;
let employeeEmp: string;

const FINANCE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational', 'payment.read.operational', 'payment.prepare.operational'];
const REVIEW: PermissionKey[] = ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank'];
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const ok = <T extends { statusCode: number; body: string }>(res: T) => {
  expect(res.statusCode, res.body).toBeLessThan(300);
  return res;
};

beforeAll(async () => {
  h = await startHarness();
  await seedDevCompany(h.db, 'SCAN');
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
  fin = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true), ($1, 'leave_request', $3, 1, true)`, [A.id, fin.user, hr.user]);
  ok(await h.call(hr, 'PUT', '/v1/workflows/sensitive_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] }));
  ok(await h.call(hr, 'PUT', '/v1/workflows/profile_change/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] }));
  const person = async () => {
    const e = ok(await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await person();
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employeeEmp = await person();
  ok(await h.call(hr, 'POST', `/v1/employees/${employeeEmp}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' }));
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });

  // Leave: submitted and approved.
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) ok(await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version }));
  ok(await h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId: employeeEmp, leaveType: 'CASUAL', kind: 'OPENING', units: '5', effectiveDate: '2026-01-05', reason: 'Opening balance (synthetic)', idempotencyKey: uniq('opening-key-') }));
  const monday = new Date();
  monday.setUTCDate(monday.getUTCDate() + 14);
  while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
  const leaveDay = monday.toISOString().slice(0, 10);
  ok(await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: leaveDay, endDate: leaveDay }));
  const leaveTask = ((await h.call(manager, 'GET', '/v1/leave/tasks')).json().items as { taskId: string }[])[0]!;
  ok(await h.call(manager, 'POST', `/v1/leave/tasks/${leaveTask.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('scan-key-') }));

  // Expense: claim, two approvals, obligation and a prepared payment.
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  const activator = await h.actor(A, 'HR_ADMINISTRATOR');
  ok(await h.call(activator, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version }));
  const receipt = ok(await h.call(employee, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from('%PDF-1.4\n% synthetic scan receipt\n%%EOF\n').toString('base64') })).json().receiptId as string;
  const claimId = ok(
    await h.call(employee, 'POST', '/v1/expense/claims', {
      purpose: 'Scan (synthetic)',
      currency: 'INR',
      lines: [{ category: 'OTHER', expenseDate: daysAgo(3), merchant: 'Synthetic Merchant', grossAmount: '120', claimedAmount: '120', description: 'Scan (synthetic)', exceptionReason: 'Above the limit on purpose (synthetic)', receipt: { receiptId: receipt } }],
    }),
  ).json().claimId as string;
  const claim = async () => (await h.call(employee, 'GET', `/v1/expense/claims/${claimId}`)).json();
  ok(await h.call(employee, 'POST', `/v1/expense/claims/${claimId}/submit`, { expectedVersion: (await claim()).version }));
  const expenseTask = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string }[])[0]!.taskId;
  ok(await h.call(manager, 'POST', `/v1/expense/tasks/${await expenseTask(manager)}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('scan-key-') }));
  const lines = ((await claim()).lines as { id: string; claimedAmount: string }[]).map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount, reason: 'Cleared (synthetic)' }));
  ok(await h.call(fin, 'POST', `/v1/expense/tasks/${await expenseTask(fin)}/decision`, { decision: 'APPROVE', lines, idempotencyKey: uniq('scan-key-') }));
  // C4: whoever approved the entitlement does not prepare its payment.
  const preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  ok(await h.call(preparer, 'POST', '/v1/expense/payments', { claimId, amount: '120', paymentDate: daysAgo(0), idempotencyKey: uniq('scan-key-') }));

  // Sensitive change: applied, with its private revision.
  const change = ok(await h.call(employee, 'POST', '/v1/me/sensitive-changes', { reason: 'Synthetic update', category: 'ADDRESS', values: { line1: '1 Synthetic Road', city: 'Testville', countryCode: 'IN' } })).json().requestId as string;
  ok(await h.call(employee, 'POST', `/v1/me/sensitive-changes/${change}/submit`, { expectedVersion: 1 }));
  const reviewTask = ((await h.call(hr, 'GET', '/v1/sensitive-changes/tasks/mine')).json().items as { taskId: string }[])[0]!.taskId;
  ok(await h.call(hr, 'POST', `/v1/sensitive-changes/tasks/${reviewTask}/start-review`));
  ok(await h.call(hr, 'POST', `/v1/sensitive-changes/tasks/${reviewTask}/decision`, { decision: 'APPROVE', reason: 'Checked (synthetic)', idempotencyKey: uniq('scan-key-') }));

  // Profile change, salary and a confirmation case.
  ok(await h.call(employee, 'POST', '/v1/me/profile-changes', { displayName: 'Renamed (synthetic)' }));
  await dispatchOutbox(h.pool, 500);
});

afterAll(async () => {
  await h?.stop();
});

describe('the referential scan over a populated database', () => {
  it('finds no orphan under any key, and says how much it looked at', { timeout: 300_000 }, async () => {
    const fks = await foreignKeys(h.db);
    const counts = await orphanScan(h.db, fks);
    expect(counts).toHaveLength(fks.length);
    expect(counts.filter((c) => c.orphans > 0)).toEqual([]);
    const withRows = counts.filter((c) => c.rows > 0);
    const companyKeysWithRows = withRows.filter((c) => {
      const fk = fks.find((x) => x.name === c.constraint)!;
      return fk.childOwned && fk.parentOwned;
    });
    const tables = new Set(withRows.map((c) => c.child));
    console.log(`orphan scan: ${fks.length} keys, ${withRows.length} with rows, ${companyKeysWithRows.length} of those between company-owned tables, ${tables.size} tables holding rows`);
    expect(withRows.length).toBeGreaterThan(150);
    expect(companyKeysWithRows.length).toBeGreaterThan(50);
    expect(tables.size).toBeGreaterThan(40);
  });
});
