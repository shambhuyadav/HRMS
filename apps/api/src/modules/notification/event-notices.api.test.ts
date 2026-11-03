// The events DF12 and H7 require that used to be consumed without effect: what each notice says, who gets it and how
// often (FR-079, FR-084, FR-088; BR-033; BR-034; DF07; DF12; H7; CR-007; I-52; I-60). Every test reads the whole trail, inbox,
// event data and outbox, for values that must never travel. Synthetic data only; amounts carry a dot so an identifier
// cannot match them by chance.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { developmentScanner, EICAR_TEST_STRING, scanPendingAttachments } from '../../storage/scan.js';
import type { FileStore } from '../../storage/files.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { type AccessGrant, resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { type BiometricProvider, runSync } from '../biometric/sync.js';
import { submitClaim, withdrawClaim } from '../expense/service.js';
import { dispatchOutbox, type EventSpec, stillEligible } from './dispatcher.js';

let h: Harness;
let A: Company;
let B: Company;
let hr: TestActor;
let fin1: TestActor;
let fin2: TestActor;
let fin3: TestActor;
let m1: TestActor;
let m1Emp: string;
let m2: TestActor;
let m2Emp: string;
let today: string;

const FINANCE: PermissionKey[] = [
  'expense.read.operational',
  'expense.manager_decide.operational',
  'expense.finance_decide.operational',
  'expense.high_value_decide.operational',
  'payment.read.operational',
  'payment.prepare.operational',
  'payment.release.operational',
  'payment.reverse.operational',
];
const INCREMENT_FINANCE: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary', 'increment.read.salary', 'increment.propose.salary', 'increment.approve.salary'];
const BIOMETRIC: PermissionKey[] = ['biometric.profile_manage.operational', 'biometric.mapping_manage.operational', 'biometric.employee_link_manage.operational', 'biometric.sync_run.operational'];

type Actor = TestActor & { employeeId: string; code: string };
type Item = { category: string; title: string | null; body: string };
const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as Item[];
const bodies = async (a: TestActor, category: string) => (await inbox(a)).filter((n) => n.category === category).map((n) => n.body);
const titles = async (a: TestActor, category: string) => (await inbox(a)).filter((n) => n.category === category).map((n) => n.title);
const dispatch = () => dispatchOutbox(h.pool, 1000);

/** Everything this company's events left behind: notices, their event data, the outbox payloads and keys. */
const wholeTrail = async () =>
  (
    await h.one<{ t: string }>(
      `select coalesce((select string_agg(coalesce(title, '') || ' ' || coalesce(body, ''), ' ') from notification where company_id = $1), '')
              || ' ' || coalesce((select string_agg(data::text, ' ') from notification_event where company_id = $1), '')
              || ' ' || coalesce((select string_agg(payload::text || ' ' || dedupe_key, ' ') from outbox_event where company_id = $1), '') as t`,
      [A.id],
    )
  ).t;

/** How a recipient's notice about one event type ended (a suppression stays visible in the log, FR-085). */
const outcomes = async (a: TestActor, category: string, employeeId: string) =>
  (
    await h.db.query<{ state: string; failure_code: string | null }>(
      `select n.state, (select d.failure_code from notification_delivery_attempt d where d.company_id = n.company_id and d.notification_id = n.id order by d.attempt_number desc limit 1) as failure_code
         from notification n join notification_event e on e.company_id = n.company_id and e.id = n.event_id
        where n.company_id = $1 and n.recipient_user_id = $2 and n.category = $3 and e.subject_employee_id = $4`,
      [A.id, a.user, category, employeeId],
    )
  ).rows;

async function person(managerEmp?: string): Promise<{ id: string; code: string }> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  if (managerEmp) expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
  return { id: e.id as string, code: e.employeeCode as string };
}
async function claimant(managerEmp = m1Emp): Promise<Actor> {
  const e = await person(managerEmp);
  return { ...(await h.actor(A, 'EMPLOYEE', { employeeId: e.id })), employeeId: e.id, code: e.code };
}
const setManager = async (employeeId: string, managerEmp: string) =>
  expect((await h.call(hr, 'POST', `/v1/employees/${employeeId}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: today })).statusCode).toBe(200);

// Expense ------------------------------------------------------------------------------------------------------------
const PURPOSE = 'SECRET-PURPOSE client visit';
const MERCHANT = 'SECRET-MERCHANT cabs';
const DESCRIPTION = 'SECRET-DESCRIPTION airport';
const daysAgo = (n: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};
const line = async (a: TestActor, category: string, amount: string) => {
  const upload = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'SECRET-RECEIPT.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic ${uniq('r')}\n%%EOF\n`).toString('base64') });
  expect(upload.statusCode).toBe(201);
  return { category, expenseDate: daysAgo(3), merchant: MERCHANT, grossAmount: amount, claimedAmount: amount, description: DESCRIPTION, receipt: { receiptId: upload.json().receiptId as string } };
};
const draft = async (a: TestActor, lines: [string, string][]) =>
  (await h.call(a, 'POST', '/v1/expense/claims', { purpose: PURPOSE, currency: 'INR', lines: await Promise.all(lines.map(([c, x]) => line(a, c, x))) })).json().claimId as string;
const claimOf = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
const submit = async (a: TestActor, id: string) => {
  const res = await h.call(a, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await claimOf(a, id)).version });
  expect(res.statusCode, res.body).toBe(200);
};
const taskOf = async (a: TestActor, claimId: string) =>
  ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; claimId: string }[]).find((t) => t.claimId === claimId)!;
const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('exp-key-'), ...body });
const approveLines = async (a: TestActor, claimId: string, allowed?: string) => {
  const c = await claimOf(a, claimId);
  return decide(a, (await taskOf(a, claimId)).taskId, {
    decision: 'APPROVE',
    lines: c.lines.map((l: { id: string; claimedAmount: string }) => ({ lineId: l.id, allowedAmount: allowed ?? l.claimedAmount, ...(allowed ? { reason: 'SECRET-LINE-REASON' } : {}) })),
  });
};
const expectNoExpenseSecret = async (...more: string[]) => {
  const trail = await wholeTrail();
  for (const secret of ['SECRET-PURPOSE', 'SECRET-MERCHANT', 'SECRET-DESCRIPTION', 'SECRET-RECEIPT', 'SECRET-LINE-REASON', ...more]) expect(trail).not.toContain(secret);
};
const reviewerText = (code: string, step: string) => `An expense claim from Synthetic Person (${code}), submitted on ${today}, is waiting for your ${step}.`;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  B = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  fin1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  fin3 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true), ($1, 'expense_claim', $3, 2, true), ($1, 'expense_claim', $4, 3, true)`, [
    A.id,
    fin1.user,
    fin2.user,
    fin3.user,
  ]);
  const incrementGrants: PermissionKey[] = ['increment.propose.salary', 'increment.read.salary'];
  m1Emp = (await person()).id;
  m2Emp = (await person()).id;
  m1 = await h.actor(A, 'REPORTING_MANAGER', { employeeId: m1Emp, extra: incrementGrants });
  m2 = await h.actor(A, 'REPORTING_MANAGER', { employeeId: m2Emp, extra: incrementGrants });
  today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('expense review notices (FR-079, BR-033, DF12)', () => {
  it('each reviewer step is told when it is assigned and the claimant is told the final decision, with no confidential value', async () => {
    const self = await claimant();
    const id = await draft(self, [...Array.from({ length: 10 }, (): [string, string] => ['TRAVEL', '4999.37']), ['OTHER', '999.91']]);
    await submit(self, id);
    await dispatch();
    expect(await bodies(m1, 'EXPENSE_SUBMITTED')).toContain(reviewerText(self.code, 'manager review'));
    expect(await titles(m1, 'EXPENSE_SUBMITTED')).toContain('Expense claim waiting for you');

    expect((await decide(m1, (await taskOf(m1, id)).taskId, { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    await dispatch();
    expect(await bodies(fin1, 'EXPENSE_ASSIGNED')).toContain(reviewerText(self.code, 'financial review'));

    expect((await approveLines(fin1, id)).json().state).toBe('HIGH_VALUE_PENDING');
    await dispatch();
    expect(await bodies(fin2, 'EXPENSE_ASSIGNED')).toContain(reviewerText(self.code, 'high-value approval'));
    expect(await bodies(fin1, 'EXPENSE_ASSIGNED')).not.toContain(reviewerText(self.code, 'high-value approval'));
    expect(await bodies(self, 'EXPENSE_DECIDED')).toEqual([]); // NEXT_STEP is not an outcome for the claimant

    const key = uniq('exp-key-');
    const finalTask = (await taskOf(fin2, id)).taskId;
    expect((await decide(fin2, finalTask, { decision: 'APPROVE', idempotencyKey: key })).json().state).toBe('APPROVED');
    await dispatch();
    expect(await bodies(self, 'EXPENSE_DECIDED')).toEqual([`Your expense claim submitted on ${today} was approved.`]);
    expect(await titles(self, 'EXPENSE_DECIDED')).toEqual(['Expense claim approved']);

    // A replayed decision is no second decision, and no second notice.
    expect((await decide(fin2, finalTask, { decision: 'APPROVE', idempotencyKey: key })).json().replayed).toBe(true);
    await dispatch();
    expect(await bodies(self, 'EXPENSE_DECIDED')).toHaveLength(1);

    await expectNoExpenseSecret('4999.37', '999.91', '50993');
  });

  it('a return, a rejection and a zero entitlement are told as such, without the reviewer’s reason', async () => {
    const self = await claimant();
    const returned = await draft(self, [['OTHER', '111.11']]);
    await submit(self, returned);
    await decide(m1, (await taskOf(m1, returned)).taskId, { decision: 'RETURN', reason: 'SECRET-RETURN-REASON' });
    const rejected = await draft(self, [['OTHER', '222.22']]);
    await submit(self, rejected);
    await decide(m1, (await taskOf(m1, rejected)).taskId, { decision: 'REJECT', reason: 'SECRET-REJECT-REASON' });
    const zero = await draft(self, [['OTHER', '333.33']]);
    await submit(self, zero);
    await decide(m1, (await taskOf(m1, zero)).taskId, { decision: 'APPROVE' });
    expect((await approveLines(fin1, zero, '0')).json()).toMatchObject({ state: 'APPROVED', paymentState: 'NO_PAYABLE_AMOUNT' });
    await dispatch();
    expect((await bodies(self, 'EXPENSE_DECIDED')).sort()).toEqual([
      `Your expense claim submitted on ${today} was approved with no payable amount.`,
      `Your expense claim submitted on ${today} was rejected.`,
      `Your expense claim submitted on ${today} was returned for correction.`,
    ]);
    await expectNoExpenseSecret('SECRET-RETURN-REASON', 'SECRET-REJECT-REASON', '111.11', '222.22', '333.33');
  });

  it('a resubmitted revision tells the reviewer again (one notice per revision)', async () => {
    const self = await claimant();
    const id = await draft(self, [['OTHER', '444.44']]);
    await submit(self, id);
    await dispatch();
    await decide(m1, (await taskOf(m1, id)).taskId, { decision: 'RETURN', reason: 'Synthetic reason' });
    await dispatch();
    const version = (await claimOf(self, id)).version as number;
    const revised = await h.call(self, 'PUT', `/v1/expense/claims/${id}`, { purpose: PURPOSE, currency: 'INR', lines: [await line(self, 'OTHER', '444.45')], expectedVersion: version });
    expect(revised.statusCode, revised.body).toBe(200);
    await submit(self, id);
    await dispatch();
    expect((await bodies(m1, 'EXPENSE_SUBMITTED')).filter((b) => b === reviewerText(self.code, 'manager review'))).toHaveLength(2);
  });

  it('withdrawing a returned claim tells the reviewer who returned it; a draft nobody reviewed tells nobody', async () => {
    const self = await claimant();
    const id = await draft(self, [['OTHER', '555.55']]);
    await submit(self, id);
    await decide(m1, (await taskOf(m1, id)).taskId, { decision: 'RETURN', reason: 'Synthetic reason' });
    expect((await h.call(self, 'POST', `/v1/expense/claims/${id}/withdraw`)).json().state).toBe('WITHDRAWN');
    await dispatch(); // the reviewer's task is already closed when the notice is delivered
    expect(await bodies(m1, 'EXPENSE_WITHDRAWN')).toContain(`The expense claim from Synthetic Person (${self.code}), submitted on ${today}, was withdrawn.`);
    expect(await titles(m1, 'EXPENSE_WITHDRAWN')).toContain('Expense claim withdrawn');
    expect(await bodies(self, 'EXPENSE_WITHDRAWN')).toEqual([]); // the claimant withdrew it themselves

    const never = await draft(self, [['OTHER', '666.66']]);
    expect((await h.call(self, 'POST', `/v1/expense/claims/${never}/withdraw`)).json().state).toBe('WITHDRAWN');
    expect((await h.db.query(`select 1 from outbox_event where company_id = $1 and aggregate_id = $2`, [A.id, never])).rowCount).toBe(0);
    await expectNoExpenseSecret('555.55', '666.66');
  });
});

describe('expense payment status notices (DF07, DF12 "payment operational status")', () => {
  it('confirmation, failure and reversal reach the claimant as states only; a replay repeats nothing', async () => {
    const self = await claimant();
    const id = await draft(self, [['OTHER', '999.37']]);
    await submit(self, id);
    await decide(m1, (await taskOf(m1, id)).taskId, { decision: 'APPROVE' });
    expect((await approveLines(fin1, id)).json().state).toBe('APPROVED');
    await dispatch();

    const prepared = async (amount: string) => {
      const res = await h.call(fin2, 'POST', '/v1/expense/payments', { claimId: id, amount, paymentDate: today, idempotencyKey: uniq('pay-key-') });
      expect(res.statusCode, res.body).toBe(201);
      const instruction = res.json().instructionId as string;
      expect((await h.call(fin3, 'POST', `/v1/expense/payments/${instruction}/release`)).statusCode).toBe(200);
      return instruction;
    };
    const paymentText = (event: string, status: string) => `The payment of your expense claim submitted on ${today} was ${event}. Its payment status is now ${status}.`;
    const payments = async () => (await bodies(self, 'EXPENSE_PAYMENT_STATUS')).sort();

    // Preparing and releasing change no payment status (DF07): the claimant hears of the recorded outcome.
    const first = await prepared('400.11');
    await dispatch();
    expect(await payments()).toEqual([]);

    const evidence = uniq('BANKREF-SECRET-');
    const confirm = () => h.call(fin3, 'POST', `/v1/expense/payments/${first}/outcome`, { outcome: 'CONFIRMED', evidenceKey: evidence });
    expect((await confirm()).json().state).toBe('CONFIRMED');
    expect((await confirm()).json().replayed).toBe(true);
    await dispatch();
    expect(await payments()).toEqual([paymentText('confirmed', 'part-paid')]);
    expect(await titles(self, 'EXPENSE_PAYMENT_STATUS')).toEqual(['Expense payment confirmed']);

    const failing = await prepared('599.26');
    expect((await h.call(fin3, 'POST', `/v1/expense/payments/${failing}/outcome`, { outcome: 'FAILED', evidenceKey: uniq('BANKREF-SECRET-') })).json().state).toBe('FAILED');
    await dispatch();
    expect(await payments()).toEqual([paymentText('confirmed', 'part-paid'), paymentText('recorded as failed', 'part-paid')].sort());

    const rest = await prepared('599.26');
    expect((await h.call(fin3, 'POST', `/v1/expense/payments/${rest}/outcome`, { outcome: 'CONFIRMED', evidenceKey: uniq('BANKREF-SECRET-') })).json().state).toBe('CONFIRMED');
    await dispatch();
    expect(await payments()).toContain(paymentText('confirmed', 'paid'));

    const reversalKey = uniq('BANKREF-SECRET-');
    const reverse = () => h.call(fin3, 'POST', `/v1/expense/payments/${first}/reversal`, { amount: '100.05', evidenceKey: reversalKey, reason: 'SECRET-REVERSAL-REASON' });
    expect((await reverse()).statusCode).toBe(200);
    expect((await reverse()).json().replayed).toBe(true);
    await dispatch();
    const told = await payments();
    expect(told).toContain(paymentText('reversed', 'part-paid'));
    expect(told).toHaveLength(4);

    await expectNoExpenseSecret('BANKREF-SECRET', 'SECRET-REVERSAL-REASON', '400.11', '599.26', '999.37', '100.05');
    // Evidence keys stay out of the event keys as well (wholeTrail reads them): a restricted reference (DF07).
    expect((await h.db.query(`select 1 from notification_event where company_id = $1 and event_key like '%BANKREF%'`, [A.id])).rowCount).toBe(0);
  });
});

describe('who is told about an expense claim at delivery (I-52)', () => {
  it('a reviewer who no longer covers the claimant gets no assignment notice; the suppression stays visible', async () => {
    const self = await claimant();
    const id = await draft(self, [['OTHER', '121.21']]);
    await submit(self, id);
    await setManager(self.employeeId, m2Emp);
    await dispatch();
    expect(await bodies(m1, 'EXPENSE_SUBMITTED')).not.toContain(reviewerText(self.code, 'manager review'));
    expect(await outcomes(m1, 'EXPENSE_SUBMITTED', self.employeeId)).toEqual([{ state: 'SUPPRESSED', failure_code: 'RECIPIENT_NOT_ELIGIBLE' }]);
    expect(await bodies(m2, 'EXPENSE_SUBMITTED')).not.toContain(reviewerText(self.code, 'manager review')); // tasks do not transfer (C4)
  });

  it('a task decided before the notice went out tells that reviewer nothing', async () => {
    const self = await claimant();
    const id = await draft(self, [['OTHER', '131.31']]);
    await submit(self, id);
    await decide(m1, (await taskOf(m1, id)).taskId, { decision: 'APPROVE' });
    await dispatch();
    expect(await outcomes(m1, 'EXPENSE_SUBMITTED', self.employeeId)).toEqual([{ state: 'SUPPRESSED', failure_code: 'RECIPIENT_NOT_ELIGIBLE' }]);
  });

  it('a former reviewer is not told of a withdrawal either, of an expense claim or a work request', async () => {
    const self = await claimant();
    const id = await draft(self, [['OTHER', '141.41']]);
    await submit(self, id);
    await decide(m1, (await taskOf(m1, id)).taskId, { decision: 'RETURN', reason: 'Synthetic reason' });
    await setManager(self.employeeId, m2Emp);
    expect((await h.call(self, 'POST', `/v1/expense/claims/${id}/withdraw`)).json().state).toBe('WITHDRAWN');
    await dispatch();
    expect(await outcomes(m1, 'EXPENSE_WITHDRAWN', self.employeeId)).toEqual([{ state: 'SUPPRESSED', failure_code: 'RECIPIENT_NOT_ELIGIBLE' }]);

    const worker = await claimant();
    const monday = new Date(Date.now() + 40 * 86_400_000);
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
    const start = monday.toISOString().slice(0, 10);
    const submitted = await h.call(worker, 'POST', '/v1/work-requests/outdoor_duty', { startDate: start, endDate: start, purpose: 'Site survey (synthetic)' });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const request = submitted.json().requestId as string;
    const transaction = (await h.one<{ transaction_id: string }>(`select transaction_id from outdoor_duty_request where id = $1`, [request])).transaction_id;
    const task = ((await h.call(m1, 'GET', '/v1/work-requests/tasks/mine')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === transaction)!;
    expect((await h.call(m1, 'POST', `/v1/work-requests/tasks/${task.taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic reason', idempotencyKey: uniq('wr-key-') })).statusCode).toBe(200);
    await setManager(worker.employeeId, m2Emp);
    expect((await h.call(worker, 'POST', `/v1/work-requests/outdoor_duty/${request}/withdraw`)).json().state).toBe('WITHDRAWN');
    await dispatch();
    expect(await outcomes(m1, 'WORK_REQUEST_WITHDRAWN', worker.employeeId)).toEqual([{ state: 'SUPPRESSED', failure_code: 'RECIPIENT_NOT_ELIGIBLE' }]);
  });

  it('a claimant holding no live assignment is not told the outcome', async () => {
    const self = await claimant();
    const id = await draft(self, [['OTHER', '151.51']]);
    await submit(self, id);
    await decide(m1, (await taskOf(m1, id)).taskId, { decision: 'REJECT', reason: 'Synthetic reason' });
    await h.db.query(`update role_assignment set state = 'REVOKED', decision_reason = 'Synthetic reason' where company_id = $1 and id = $2`, [A.id, self.assignment]);
    await dispatch();
    expect(await outcomes(self, 'EXPENSE_DECIDED', self.employeeId)).toEqual([{ state: 'SUPPRESSED', failure_code: 'RECIPIENT_NOT_ELIGIBLE' }]);
  });
});

describe('authority inside the transaction (docs/09 §6.5)', () => {
  const guardFor = async (a: TestActor, action: string) =>
    (await resolveAccess(h.pool, { userId: a.user, companyId: A.id, assignmentId: a.assignment, resource: 'expense', action, fieldGroups: ['operational'] })) as AccessGrant;
  const setEntry = (a: TestActor, action: string, active: boolean) =>
    h.db.query(
      `update role_assignment_permission set active = $4 where company_id = $1 and role_assignment_id = $2
          and permission_id = (select id from permission where resource = 'expense' and action = $3 and field_group = 'operational')`,
      [A.id, a.assignment, action, active],
    );

  it('withdrawing and submitting use the authority current at commit, not the one the route guard saw', async () => {
    const self = await claimant();
    const id = await draft(self, [['OTHER', '161.61']]);
    const version = (await claimOf(self, id)).version as number;

    const submitGuard = await guardFor(self, 'submit');
    await setEntry(self, 'submit', false);
    await expect(withTransaction(h.pool, (tx) => submitClaim(tx, submitGuard, id, version))).rejects.toMatchObject({ statusCode: 403 });
    expect((await claimOf(self, id)).state).toBe('DRAFT');
    await setEntry(self, 'submit', true);

    const withdrawGuard = await guardFor(self, 'withdraw');
    await setEntry(self, 'withdraw', false);
    await expect(withTransaction(h.pool, (tx) => withdrawClaim(tx, withdrawGuard, id))).rejects.toMatchObject({ statusCode: 403 });
    expect((await claimOf(self, id)).state).toBe('DRAFT');
    await setEntry(self, 'withdraw', true);
  });
});

// Increment ----------------------------------------------------------------------------------------------------------
describe('increment notices (FR-084, DF12, DF15, CR-007)', () => {
  let hr1: TestActor;
  let hr2: TestActor;
  const AMOUNT = '123456.78';
  const COUNTERPART = '1481481.36';
  const REASON = 'SECRET-INCREMENT-REASON';

  const cased = async (a: TestActor, employeeId: string) =>
    ((await h.call(a, 'GET', '/v1/increment-cases')).json().items as { id: string; employeeId: string; occurrence: string; state: string; version: number }[]).find((c) => c.employeeId === employeeId && c.occurrence === 'ANNUAL:2027')!;
  const incrementTask = async (a: TestActor, employeeId: string) => ((await h.call(a, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === employeeId)!;
  const propose = async (a: TestActor, employeeId: string, outcome = 'INCREASE') => {
    const c = await cased(hr1, employeeId);
    const res = await h.call(a, 'POST', `/v1/increment-cases/${c.id}/proposal`, { expectedVersion: c.version, outcome, ...(outcome === 'INCREASE' ? { proposedAmount: AMOUNT, proposedCounterpart: COUNTERPART } : {}), reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
  };
  const decideCase = async (a: TestActor, employeeId: string, decision: string) => {
    const res = await h.call(a, 'POST', `/v1/increment-cases/tasks/${(await incrementTask(a, employeeId)).taskId}/decision`, { decision, reason: REASON, idempotencyKey: uniq('inc-key-') });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const decidedText = (code: string, outcome: string) => `The increment review for Synthetic Person (${code}) was decided: ${outcome}.`;
  const roster = new Map<string, { id: string; code: string; self: TestActor }>();

  beforeAll(async () => {
    hr1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INCREMENT_FINANCE });
    hr2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: INCREMENT_FINANCE });
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true), ($1, 'increment_case', $3, 2, true)`, [A.id, hr1.user, hr2.user]);
    for (const name of ['applied', 'returned', 'moved']) {
      const e = await person(m1Emp);
      expect((await h.call(hr1, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: '2026-01-05', monthlyGross: '100000', annualCtc: '1200000', currency: 'INR' })).statusCode).toBe(201);
      roster.set(name, { ...e, self: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) });
    }
    const cycle = (await h.call(hr1, 'GET', '/v1/increment-cycles')).json().items[0].id as string;
    await h.runBulkJob(hr1, `/v1/increment-cycles/${cycle}/reviews`, { year: 2027 });
  });

  const expectNoIncrementSecret = async () => {
    const trail = await wholeTrail();
    for (const secret of [AMOUNT, COUNTERPART, REASON, '100000', '10.00']) expect(trail.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '')).not.toContain(secret);
  };

  it('a proposal reaches its assigned approver and the decision reaches the proposer once, as a state', async () => {
    const e = roster.get('applied')!;
    await propose(m1, e.id);
    await dispatch();
    // hr1 opened the roster, so hr2 is the assigned, independent approver.
    expect(await bodies(hr2, 'INCREMENT_PROPOSED')).toContain(`An increment proposal for Synthetic Person (${e.code}) is waiting for your decision.`);
    expect(await bodies(hr1, 'INCREMENT_PROPOSED')).not.toContain(`An increment proposal for Synthetic Person (${e.code}) is waiting for your decision.`);
    expect(await bodies(m1, 'INCREMENT_DECIDED')).not.toContain(decidedText(e.code, 'applied'));

    expect((await decideCase(hr2, e.id, 'APPROVE')).state).toBe('APPLIED');
    await dispatch();
    // The proposer also is the current manager: one notice, not one per reason to tell them (BR-034).
    expect((await bodies(m1, 'INCREMENT_DECIDED')).filter((b) => b === decidedText(e.code, 'applied'))).toHaveLength(1);
    expect(await titles(m1, 'INCREMENT_DECIDED')).toContain('Increment review applied');
    expect(await bodies(hr2, 'INCREMENT_DECIDED')).not.toContain(decidedText(e.code, 'applied')); // the decider decided it
    expect(await bodies(e.self, 'INCREMENT_DECIDED')).toEqual([]); // DF12 names no notice to the employee (owner question)
    await expectNoIncrementSecret();
  });

  it('each occurrence of a decision is told: returned, then no change, then deferred', async () => {
    const e = roster.get('returned')!;
    await propose(m1, e.id);
    expect((await decideCase(hr2, e.id, 'RETURN')).state).toBe('RETURNED');
    await dispatch();
    expect(await bodies(m1, 'INCREMENT_DECIDED')).toContain(decidedText(e.code, 'returned for correction'));

    await propose(m1, e.id, 'NO_CHANGE');
    expect((await decideCase(hr2, e.id, 'RETURN')).state).toBe('RETURNED');
    await propose(m1, e.id, 'DEFER');
    expect((await decideCase(hr2, e.id, 'APPROVE')).state).toBe('DEFERRED');
    await dispatch();
    expect((await bodies(m1, 'INCREMENT_DECIDED')).filter((b) => b === decidedText(e.code, 'returned for correction'))).toHaveLength(2);
    expect(await bodies(m1, 'INCREMENT_DECIDED')).toContain(decidedText(e.code, 'deferred'));
    await expectNoIncrementSecret();
  });

  it('after a manager change the former manager is not told and the current manager is', async () => {
    const e = roster.get('moved')!;
    await propose(m1, e.id);
    await setManager(e.id, m2Emp);
    expect((await decideCase(hr2, e.id, 'REJECT')).state).toBe('REJECTED');
    await dispatch();
    expect(await bodies(m2, 'INCREMENT_DECIDED')).toContain(decidedText(e.code, 'rejected'));
    expect(await bodies(m1, 'INCREMENT_DECIDED')).not.toContain(decidedText(e.code, 'rejected'));
    expect(await outcomes(m1, 'INCREMENT_DECIDED', e.id)).toEqual([{ state: 'SUPPRESSED', failure_code: 'RECIPIENT_NOT_ELIGIBLE' }]);
  });

  it('an off-cycle proposal is told to its approver and its decision to the HR proposer, not to the manager', async () => {
    const e = await person(m1Emp);
    expect((await h.call(hr1, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: '2026-01-05', monthlyGross: '100000', annualCtc: '1200000', currency: 'INR' })).statusCode).toBe(201);
    const res = await h.call(hr1, 'POST', '/v1/increment-cases/off-cycle', { employeeId: e.id, effectiveDate: '2027-10-01', proposedAmount: AMOUNT, proposedCounterpart: COUNTERPART, reason: REASON });
    expect(res.statusCode, res.body).toBe(201);
    await dispatch();
    expect(await bodies(hr2, 'INCREMENT_PROPOSED')).toContain(`An increment proposal for Synthetic Person (${e.code}) is waiting for your decision.`);

    expect((await decideCase(hr2, e.id, 'REJECT')).state).toBe('REJECTED');
    await dispatch();
    expect(await bodies(hr1, 'INCREMENT_DECIDED')).toContain(decidedText(e.code, 'rejected'));
    expect(await bodies(m1, 'INCREMENT_DECIDED')).not.toContain(decidedText(e.code, 'rejected'));
    await expectNoIncrementSecret();
  });
});

// Biometric ----------------------------------------------------------------------------------------------------------
describe('biometric sync failure notices (FR-084, FR-088, DF09, I-60)', () => {
  class FailingProvider implements BiometricProvider {
    constructor(private readonly failPage: number) {}
    async fetchPage({ cursor }: { cursor: string | null }) {
      const index = cursor ? Number(cursor.slice(1)) : 0;
      if (index === this.failPage) throw new Error('provider unavailable, SECRET-PROVIDER-DETAIL');
      return { records: [], nextCursor: `p${index + 1}` };
    }
  }
  const FIELDS = [
    { sourcePath: 'emp.code', targetField: 'EMPLOYEE_KEY', transformCode: 'TRIM', required: true },
    { sourcePath: 'ts', targetField: 'PUNCH_INSTANT', transformCode: 'PARSE_INSTANT', required: true },
    { sourcePath: 'dir', targetField: 'DIRECTION', transformCode: 'ENUM_MAP', enumConfig: { '0': 'IN', '1': 'OUT' }, required: true },
    { sourcePath: 'id', targetField: 'EVENT_KEY', transformCode: 'IDENTITY', required: true },
  ];

  it('a failed and a partial run reach the unrestricted holders of sync_run, and nobody else, with no provider detail', async () => {
    const support = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: BIOMETRIC });
    const approver = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: BIOMETRIC });
    const filtered = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: BIOMETRIC, departmentFilter: A.dept });
    const readOnly = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { extra: ['biometric.read.operational'] });
    const plain = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const otherCompany = await h.actor(B, 'SYSTEM_ADMINISTRATOR', { extra: BIOMETRIC });
    const code = uniq('SYNC').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
    const profile = (
      await h.call(support, 'POST', '/v1/biometric/profiles', {
        code,
        name: `${code} devices`,
        requestConfigReference: 'secret-store://biometric/x/request',
        authReference: 'secret-store://biometric/x/credential',
        providerTimezone: 'Asia/Kolkata',
        paginationMode: 'CURSOR',
        scheduleReference: 'every-15-minutes',
        lookbackMinutes: 10080,
      })
    ).json().id as string;
    const mapping = await h.call(support, 'POST', `/v1/biometric/profiles/${profile}/mappings`, { dedupeStrategy: 'PROVIDER_EVENT_KEY', timestampRule: 'ISO_WITH_OFFSET', effectiveFrom: '2026-01-01T00:00:00Z', fields: FIELDS });
    expect(mapping.statusCode, mapping.body).toBe(201);
    expect((await h.call(approver, 'POST', `/v1/biometric/mappings/${mapping.json().mappingRevisionId}/approve`)).statusCode).toBe(200);
    expect((await h.call(support, 'POST', `/v1/biometric/profiles/${profile}/activate`)).statusCode).toBe(200);

    const sync = (provider: BiometricProvider) =>
      runSync(h.pool, { companyId: A.id, profileId: profile, actorUserId: support.user, windowStart: new Date('2026-03-02T00:00:00Z'), windowEnd: new Date('2026-03-03T00:00:00Z') }, provider, [0, 0]);
    expect((await sync(new FailingProvider(0))).state).toBe('FAILED');
    expect((await sync(new FailingProvider(1))).state).toBe('PARTIAL');
    await dispatch();

    const failed = `The biometric sync of profile ${code} ended FAILED (FETCH_FAILED); the checkpoint stays at the last committed page.`;
    const partial = `The biometric sync of profile ${code} ended PARTIAL (FETCH_FAILED); the checkpoint stays at the last committed page.`;
    expect((await bodies(support, 'BIOMETRIC_SYNC_FAILED')).sort()).toEqual([failed, partial]);
    expect((await bodies(approver, 'BIOMETRIC_SYNC_FAILED')).sort()).toEqual([failed, partial]);
    expect(await titles(support, 'BIOMETRIC_SYNC_FAILED')).toContain('Biometric sync FAILED');
    for (const nobody of [filtered, readOnly, plain, otherCompany]) expect(await bodies(nobody, 'BIOMETRIC_SYNC_FAILED')).toEqual([]);
    const trail = await wholeTrail();
    expect(trail).not.toContain('secret-store');
    expect(trail).not.toContain('SECRET-PROVIDER-DETAIL');

    // The check at delivery decides as the recipient list does.
    const event: EventSpec = { eventType: 'BIOMETRIC_SYNC_FAILED', subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: null, data: {} };
    expect(await stillEligible(h.pool, A.id, support.user, 'BIOMETRIC_SUPPORT', event)).toBe(true);
    expect(await stillEligible(h.pool, A.id, filtered.user, 'BIOMETRIC_SUPPORT', event)).toBe(false);
    expect(await stillEligible(h.pool, A.id, readOnly.user, 'BIOMETRIC_SUPPORT', event)).toBe(false);
  });
});

// Role grants --------------------------------------------------------------------------------------------------------
describe('role grant notices (DF12 "role-grant/security change", FR-067, C4)', () => {
  const COORDINATOR = 'TRAINING_COORDINATOR';
  const propose = async (by: TestActor, userId: string, filters?: object) => {
    const res = await h.call(by, 'POST', '/v1/access/assignments', { userId, roleCode: COORDINATOR, effectiveFrom: '2026-01-01T00:00:00Z', purpose: 'SECRET-GRANT-PURPOSE', ...(filters ? { filters } : {}) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().id as string;
  };
  const versionOf = async (id: string) => (await h.one<{ version: number }>(`select version from role_assignment where id = $1`, [id])).version;
  const asUser = async (user: string, assignment: string): Promise<TestActor> => ({ user, assignment, company: A, token: await h.tokenFor(user) });
  const waiting = `A ${COORDINATOR} role assignment is waiting for your approval.`;

  it('a proposal reaches approvers whose scope contains it, never its requester or beneficiary, and only while pending', async () => {
    const requester = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const approver = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const narrow = await h.actor(A, 'SYSTEM_ADMINISTRATOR', { departmentFilter: A.dept });
    const unrelated = await h.actor(A, 'HR_ADMINISTRATOR');
    const beneficiary = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const count = async (a: TestActor) => (await bodies(a, 'ACCESS_GRANT_PROPOSED')).length;

    const wide = await propose(requester, beneficiary.user);
    await dispatch();
    expect(await bodies(approver, 'ACCESS_GRANT_PROPOSED')).toContain(waiting);
    expect(await titles(approver, 'ACCESS_GRANT_PROPOSED')).toContain('Role assignment waiting for approval');
    expect(await count(requester)).toBe(0);
    expect(await count(beneficiary)).toBe(0);
    expect(await count(unrelated)).toBe(0);
    expect(await count(narrow)).toBe(0); // a narrower administrator could not approve an unrestricted grant

    await propose(requester, (await h.makeUser()), { departments: [A.dept] });
    await dispatch();
    expect(await count(narrow)).toBe(1); // this one is within its administrative scope

    // Decided before the notice went out: nothing is waiting any more.
    const before = await count(approver);
    const decided = await propose(requester, (await h.makeUser()));
    expect((await h.call(approver, 'POST', `/v1/access/assignments/${decided}/approve`, { expectedVersion: await versionOf(decided) })).statusCode).toBe(200);
    await dispatch();
    expect(await count(approver)).toBe(before);

    const event: EventSpec = { eventType: 'ACCESS_GRANT_PROPOSED', subjectEmployeeId: null, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: null, grantAssignmentId: wide, data: {} };
    expect(await stillEligible(h.pool, A.id, approver.user, 'GRANT_APPROVERS', event)).toBe(true);
    expect(await stillEligible(h.pool, A.id, requester.user, 'GRANT_APPROVERS', event)).toBe(false);
    expect(await stillEligible(h.pool, A.id, unrelated.user, 'GRANT_APPROVERS', event)).toBe(false);
    expect((await wholeTrail())).not.toContain('SECRET-GRANT-PURPOSE');
  });

  it('a rejection and a revocation reach the beneficiary as states, even when it was their only assignment', async () => {
    const admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const approver = await h.actor(A, 'SYSTEM_ADMINISTRATOR');

    const rejectedUser = await h.makeUser();
    const rejected = await propose(admin, rejectedUser);
    expect((await h.call(approver, 'POST', `/v1/access/assignments/${rejected}/reject`, { expectedVersion: await versionOf(rejected), reason: 'SECRET-GRANT-REASON' })).statusCode).toBe(200);
    await dispatch();
    const rejectedActor = await asUser(rejectedUser, rejected);
    expect(await bodies(rejectedActor, 'ACCESS_GRANT_ENDED')).toEqual([`A ${COORDINATOR} role assignment for you was rejected.`]);
    expect(await titles(rejectedActor, 'ACCESS_GRANT_ENDED')).toEqual(['Role assignment rejected']);

    const revokedUser = await h.makeUser();
    const revoked = await propose(admin, revokedUser);
    expect((await h.call(approver, 'POST', `/v1/access/assignments/${revoked}/approve`, { expectedVersion: await versionOf(revoked) })).statusCode).toBe(200);
    expect((await h.call(approver, 'POST', `/v1/access/assignments/${revoked}/revoke`, { expectedVersion: await versionOf(revoked), reason: 'SECRET-GRANT-REASON' })).statusCode).toBe(200);
    await dispatch();
    expect(await bodies(await asUser(revokedUser, revoked), 'ACCESS_GRANT_ENDED')).toEqual([`A ${COORDINATOR} role assignment for you was revoked.`]);

    // An account that was deactivated meanwhile hears nothing (FR-067; ZT05).
    const goneUser = await h.makeUser();
    const gone = await propose(admin, goneUser);
    expect((await h.call(approver, 'POST', `/v1/access/assignments/${gone}/reject`, { expectedVersion: await versionOf(gone), reason: 'SECRET-GRANT-REASON' })).statusCode).toBe(200);
    await h.db.query(`update user_account set active = false where id = $1`, [goneUser]);
    await dispatch();
    expect((await h.db.query<{ state: string }>(`select state from notification where company_id = $1 and recipient_user_id = $2 and category = 'ACCESS_GRANT_ENDED'`, [A.id, goneUser])).rows).toEqual([{ state: 'SUPPRESSED' }]);

    expect(await wholeTrail()).not.toContain('SECRET-GRANT-REASON');
  });
});

// Malware scan -------------------------------------------------------------------------------------------------------
describe('background scan quarantine notice (H7, FR-106)', () => {
  it('the uploader of a file the worker quarantined is told once, without its name or the finding; a clean file tells nobody', async () => {
    const uploader = await h.actor(A, 'EMPLOYEE');
    const reference = (kind: string) => `SECRET-FILE-REFERENCE/${kind}/${randomUUID()}`;
    const stored = new Map<string, Buffer>();
    const pending = async (content: string) => {
      const contentReference = reference('stored');
      stored.set(contentReference, Buffer.from(content, 'latin1'));
      const checksum = randomUUID().replace(/-/g, '').padEnd(64, '0');
      return (
        await h.one<{ id: string }>(
          `insert into attachment (company_id, owner_user_id, content_reference, media_type, checksum, classification, scan_state)
           values ($1, $2, $3, 'application/pdf', $4, 'CONFIDENTIAL', 'PENDING_SCAN') returning id`,
          [A.id, uploader.user, contentReference, checksum],
        )
      ).id;
    };
    const infected = await pending(EICAR_TEST_STRING);
    await pending('%PDF-1.4 clean synthetic file');
    const files = { get: async (ref: string) => stored.get(ref)! } as unknown as FileStore;

    expect(await scanPendingAttachments(h.pool, files, developmentScanner(), A.id)).toMatchObject({ scanned: 2, clean: 1, quarantined: 1 });
    await dispatch();
    const uploadedOn = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, created_at), 'YYYY-MM-DD') as d from attachment where id = $2`, [A.id, infected])).d;
    expect(await bodies(uploader, 'FILE_QUARANTINED')).toEqual([`A file you uploaded on ${uploadedOn} failed the malware scan and cannot be used; please upload a replacement.`]);

    // A later run has nothing left to scan and repeats nothing.
    expect(await scanPendingAttachments(h.pool, files, developmentScanner(), A.id)).toMatchObject({ scanned: 0 });
    await dispatch();
    expect(await bodies(uploader, 'FILE_QUARANTINED')).toHaveLength(1);
    const trail = await wholeTrail();
    expect(trail).not.toContain('SECRET-FILE-REFERENCE');
    expect(trail).not.toContain('EICAR');
  });

  it('an upload the scanner refuses at once is answered to the uploader and raises no notice', async () => {
    const uploader = await claimant();
    const upload = await h.call(uploader, 'POST', '/v1/expense/receipts', { fileName: 'receipt.pdf', contentBase64: Buffer.from(`%PDF-1.4\n${EICAR_TEST_STRING}\n%%EOF\n`, 'latin1').toString('base64') });
    expect(upload.json().scanState).toBe('QUARANTINED');
    await dispatch();
    expect(await bodies(uploader, 'FILE_QUARANTINED')).toEqual([]);
  });
});

// Every new event ----------------------------------------------------------------------------------------------------
describe('replays and bad payloads (BR-034, FR-061)', () => {
  const NEW_CATEGORIES = [
    'EXPENSE_SUBMITTED',
    'EXPENSE_ASSIGNED',
    'EXPENSE_DECIDED',
    'EXPENSE_WITHDRAWN',
    'EXPENSE_PAYMENT_STATUS',
    'INCREMENT_PROPOSED',
    'INCREMENT_DECIDED',
    'BIOMETRIC_SYNC_FAILED',
    'ACCESS_GRANT_PROPOSED',
    'ACCESS_GRANT_ENDED',
    'FILE_QUARANTINED',
  ];
  const countsByCategory = async () =>
    Object.fromEntries((await h.db.query<{ category: string; n: number }>(`select category, count(*)::int as n from notification where company_id = $1 group by category`, [A.id])).rows.map((r) => [r.category, r.n]));

  it('processing every event again, as a crashed worker would, creates no second notice of any kind', async () => {
    const before = await countsByCategory();
    for (const category of NEW_CATEGORIES) expect(before[category], category).toBeGreaterThan(0);
    await h.db.query(`update outbox_event set published_at = null, failed_at = null where company_id = $1`, [A.id]);
    await dispatch();
    expect(await countsByCategory()).toEqual(before);
    expect((await h.db.query(`select 1 from outbox_event where company_id = $1 and published_at is null`, [A.id])).rowCount).toBe(0);
  });

  it('a malformed payload on any new topic is consumed without effect and without a failure', async () => {
    const claim = (await h.one<{ id: string }>(`select id from expense_claim where company_id = $1 limit 1`, [A.id])).id;
    const queue = async (topic: string, payload: object) =>
      (
        await h.one<{ id: string }>(`insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload) values ($1, $2, gen_random_uuid(), $3, $4) returning id::text as id`, [
          A.id,
          topic,
          uniq(`malformed:${topic}:`),
          payload,
        ])
      ).id;
    const before = await countsByCategory();
    const queued = [
      await queue('expense.submitted', { claimId: 'x', taskId: 'y' }),
      await queue('expense.submitted', { claimId: claim, taskId: randomUUID() }), // a task of no claim
      await queue('expense.assigned', { claimId: randomUUID(), taskId: randomUUID() }),
      await queue('expense.decided', { claimId: claim, outcome: 'SECRET-OUTCOME' }),
      await queue('expense.decided', { claimId: claim, outcome: 'constructor' }),
      await queue('expense.withdrawn', { claimId: claim, taskId: 42 }),
      await queue('expense.payment_status', { claimId: claim, paymentEvent: 'CONFIRMED', paymentState: 'NOT_APPLICABLE' }),
      await queue('increment.proposed', { caseId: randomUUID(), taskId: randomUUID() }),
      await queue('increment.decided', { caseId: 'x', outcome: 'APPLIED' }),
      await queue('biometric.sync_failed', { runId: 'x' }),
      await queue('biometric.sync_failed', { runId: randomUUID() }),
      await queue('access.grant_proposed', { assignmentId: 'x' }),
      await queue('access.grant_ended', { assignmentId: randomUUID(), outcome: 'REVOKED' }),
      await queue('access.grant_ended', { assignmentId: randomUUID(), outcome: 'SECRET-OUTCOME' }),
      await queue('storage.scan_quarantined', { attachmentId: randomUUID() }),
      await queue('sensitive_change.bank_cutoff', { requestId: randomUUID(), periodCode: 'P1', inputCutoff: 'not-a-date' }),
    ];
    await dispatch();
    expect((await h.db.query(`select 1 from outbox_event where id = any($1::uuid[]) and (published_at is null or failed_at is not null or last_error is not null)`, [queued])).rowCount).toBe(0);
    expect(await countsByCategory()).toEqual(before);
  });
});
