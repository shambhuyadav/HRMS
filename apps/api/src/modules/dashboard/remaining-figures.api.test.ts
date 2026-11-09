// The F2 figures that had no source (decided under owner delegation, 6 Nov 2026, docs/03 I-92; 0245; F2; DF17; BR-045; FR-096;
// FR-097): Treasury Operator "Reservations needing reconciliation", Finance Reviewer reconciliation tasks, unreconciled outcomes and
// operational states, Expense Finance Approver "Decision due" under the dated due period, Recruiter interview tasks, and the Auditor's
// review evidence, which stays unavailable. Every figure is read over records made through the real routes and compared with the lists
// it links to under the same actor; filters narrow it; the same person's other assignment adds nothing; small counts without a list
// are hidden. Synthetic data only: amounts and texts below are markers searched for in the answers.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { BASELINE_ROLES, type PermissionKey } from '../access/baseline.js';
import { releaseNaming } from '../expense/payment.fixtures.js';
import { approvedRequisition, hiringWorld } from '../hiring/test-fixtures.js';
import { addDays, businessDate, person } from '../training/training.fixtures.js';
import type { SourceList } from './sources.js';

const DECIDE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];
const PREPARE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.prepare.operational'];
const SETTLE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.release.operational', 'payment.confirm_outcome.operational', 'payment.reverse.operational'];
const AMOUNT = '761.43';
const MARKERS = [AMOUNT, 'Remaining figures marker', 'Remaining Marker Merchant'];

let h: Harness;

type Widget = { code: string; title: string; kind: string; status: string; value?: number | string; message?: string; threshold?: number; source?: { combine: string; lists: SourceList[] } };
const dashboardOf = async (a: TestActor) => {
  const res = await h.call(a, 'GET', '/v1/dashboard');
  expect(res.statusCode, res.body).toBe(200);
  return { body: res.body, byCode: Object.fromEntries((res.json().widgets as Widget[]).map((w) => [w.code, w])) as Record<string, Widget> };
};
const listCount = async (a: TestActor, list: SourceList) => {
  const res = await h.call(a, 'GET', list.api);
  expect(res.statusCode, `${list.api}: ${res.body}`).toBe(200);
  const body = res.json() as { items: unknown[]; total?: number };
  return body.total ?? body.items.length;
};
/** The figure of `code`, checked against its own source lists under the same actor. */
const figure = async (a: TestActor, code: string): Promise<number | string> => {
  const w = (await dashboardOf(a)).byCode[code]!;
  expect(w, code).toMatchObject({ status: 'OK' });
  expect(w.source, `${code} links to its lists`).toBeTruthy();
  const counts: number[] = [];
  for (const list of w.source!.lists) counts.push(await listCount(a, list));
  const fromLists = w.source!.combine === 'PARTS' ? counts.join('/') : counts.reduce((x, y) => x + y, 0);
  expect(w.value, `${code} against its source lists`).toEqual(fromLists);
  return w.value!;
};
const isWeekday = (day: string) => ![0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
/** DF03 business days (Monday to Friday), as 0245 hrms_add_business_days counts them. */
const addBusinessDays = (day: string, n: number) => {
  let d = day;
  for (let left = n; left > 0; ) {
    d = addDays(d, 1);
    if (isWeekday(d)) left--;
  }
  return d;
};

/** Claimants in two departments, a manager, the finance decider on the reviewer list, a preparer and a settler, an active policy. */
async function expenseWorld(c: Company) {
  const hr = await h.actor(c, 'HR_ADMINISTRATOR');
  const decider = await h.actor(c, 'HR_ADMINISTRATOR', { extra: DECIDE });
  const preparer = await h.actor(c, 'HR_ADMINISTRATOR', { extra: PREPARE });
  const settler = await h.actor(c, 'HR_ADMINISTRATOR', { extra: SETTLE });
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [c.id, decider.user]);
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(await h.actor(c, 'HR_ADMINISTRATOR'), 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
  const boss = await person(h, c, hr);
  const manager = await h.actor(c, 'REPORTING_MANAGER', { employeeId: boss });
  const eng = await h.actor(c, 'EMPLOYEE', { employeeId: await person(h, c, hr, { departmentId: c.dept, managerId: boss }) });
  const fin = await h.actor(c, 'EMPLOYEE', { employeeId: await person(h, c, hr, { departmentId: c.financeDept, managerId: boss }) });
  const today = await businessDate(h, c);

  const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
  const transactionOf = async (claimId: string) => (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
  const taskOf = async (a: TestActor, claimId: string) => {
    const tx = await transactionOf(claimId);
    return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
  };
  const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('rf-key-'), ...body });
  /** A claim of `who` past its manager: waiting at the finance step. */
  const atFinance = async (who: TestActor, amount = AMOUNT) => {
    const receipt = await h.call(who, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic remaining receipt ${uniq('r')}\n%%EOF\n`).toString('base64') });
    expect(receipt.statusCode, receipt.body).toBe(201);
    const created = await h.call(who, 'POST', '/v1/expense/claims', {
      purpose: 'Remaining figures marker purpose (synthetic)',
      currency: 'INR',
      lines: [{ category: 'OFFICE_SUPPLIES', expenseDate: today, merchant: 'Remaining Marker Merchant', grossAmount: amount, claimedAmount: amount, description: 'Synthetic', receipt: { receiptId: receipt.json().receiptId } }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().claimId as string;
    expect((await h.call(who, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(who, id)).version })).statusCode).toBe(200);
    expect((await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    return id;
  };
  /** The same claim taken to FINAL_APPROVED by the finance decider. */
  const approved = async (who: TestActor, amount = AMOUNT) => {
    const id = await atFinance(who, amount);
    const lines = (await view(decider, id)).lines as { id: string; claimedAmount: string }[];
    const res = await decide(decider, await taskOf(decider, id), { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
    expect(res.json().state, res.body).toBe('APPROVED');
    return id;
  };
  const prepare = async (claimId: string, amount = AMOUNT, paymentDate = today, retryOfInstructionId?: string) => {
    const res = await h.call(preparer, 'POST', '/v1/expense/payments', { claimId, amount, paymentDate, idempotencyKey: uniq('rf-pay-'), ...(retryOfInstructionId ? { retryOfInstructionId } : {}) });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().instructionId as string;
  };
  const ready = async (instructionId: string) => expect((await h.call(preparer, 'POST', `/v1/expense/payments/${instructionId}/ready`)).statusCode).toBe(200);
  const release = async (instructionId: string) => expect((await releaseNaming(h, settler, instructionId)).json().state).toBe('RELEASED');
  const outcome = async (instructionId: string, kind: 'CONFIRMED' | 'FAILED') =>
    expect((await h.call(settler, 'POST', `/v1/expense/payments/${instructionId}/outcome`, { outcome: kind, evidenceKey: uniq('rf-bank-') })).statusCode).toBe(200);
  const reverse = async (instructionId: string, amount: string) =>
    expect((await h.call(settler, 'POST', `/v1/expense/payments/${instructionId}/reversal`, { amount, evidenceKey: uniq('rf-rev-'), reason: 'Bank return (synthetic)' })).statusCode).toBe(200);
  /** Moves the arrival of the claim's pending task back by `days` calendar days (creation metadata is fixed, so triggers are off for it). */
  const arrivedDaysAgo = async (claimId: string, days: number) => {
    const tx = await transactionOf(claimId);
    await h.db.query(`set session_replication_role = replica`);
    try {
      await h.db.query(
        `update approval_task t set created_at = now() - make_interval(days => $2::int) from approval_instance i
          where i.company_id = t.company_id and i.id = t.instance_id and i.transaction_id = $1 and i.state = 'ACTIVE' and t.state = 'PENDING'`,
        [tx, days],
      );
    } finally {
      await h.db.query(`set session_replication_role = origin`);
    }
    return (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now() - make_interval(days => $2::int)), 'YYYY-MM-DD') as d`, [c.id, days])).d;
  };
  return { hr, decider, preparer, settler, manager, eng, fin, today, taskOf, decide, atFinance, approved, prepare, ready, release, outcome, reverse, arrivedDaysAgo };
}

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

describe('Treasury Operator "Reservations needing reconciliation" (I-92)', () => {
  it('counts payments still holding a reservation after their payment date, prepared or released without an outcome, and equals its two lists', async () => {
    const c = await h.makeCompany();
    const w = await expenseWorld(c);
    const operator = await h.actor(c, 'TREASURY_OPERATOR');
    const financeOperator = await h.actor(c, 'TREASURY_OPERATOR', { departmentFilter: c.financeDept });
    const yesterday = addDays(w.today, -1);
    const { byCode } = await dashboardOf(operator);
    expect(byCode.RECONCILE).toMatchObject({ status: 'OK', value: 0, title: 'Payments past their date still holding a reservation' });
    expect(byCode.RECONCILE!.source!.lists.map((l) => l.api)).toEqual([
      `/v1/expense/payments?state=PREPARED&paymentDateBefore=${w.today}`,
      `/v1/expense/payments?state=RELEASED&paymentDateBefore=${w.today}`,
    ]);

    // Due today: not yet past its date.
    await w.prepare(await w.approved(w.eng), AMOUNT, w.today);
    expect(await figure(operator, 'RECONCILE')).toBe(0);
    // Past its date: counted while drafted, ready and released; an outcome ends the reservation.
    const late = await w.prepare(await w.approved(w.eng), AMOUNT, yesterday);
    expect(await figure(operator, 'RECONCILE')).toBe(1);
    await w.ready(late);
    expect(await figure(operator, 'RECONCILE')).toBe(1);
    await w.release(late);
    expect(await figure(operator, 'RECONCILE')).toBe(1);
    await w.outcome(late, 'CONFIRMED');
    expect(await figure(operator, 'RECONCILE')).toBe(0);
    const failed = await w.prepare(await w.approved(w.eng), AMOUNT, yesterday);
    await w.ready(failed);
    await w.release(failed);
    expect(await figure(operator, 'RECONCILE')).toBe(1);
    await w.outcome(failed, 'FAILED');
    expect(await figure(operator, 'RECONCILE')).toBe(0);

    // Row scope over the claimant: the Finance-filtered operator counts its own people only.
    await w.prepare(await w.approved(w.eng), AMOUNT, yesterday);
    expect(await figure(operator, 'RECONCILE')).toBe(1);
    expect(await figure(financeOperator, 'RECONCILE')).toBe(0);
    await w.prepare(await w.approved(w.fin), AMOUNT, yesterday);
    expect(await figure(operator, 'RECONCILE')).toBe(2);
    expect(await figure(financeOperator, 'RECONCILE')).toBe(1);

    // The preparer's own Treasury Operator context shows the scope's figure, not "their" preparations (DF17 no merging).
    expect(await figure(await h.actor(c, 'TREASURY_OPERATOR', { user: w.preparer.user }), 'RECONCILE')).toBe(2);
    const body = (await dashboardOf(operator)).body;
    for (const marker of MARKERS) expect(body, marker).not.toContain(marker);
  });
});

describe('Finance Reviewer reconciliation figures and operational states (I-92)', () => {
  it('follow each payment outcome of the claims in scope and equal the claim-state lists; no amount reaches the dashboard', async () => {
    const c = await h.makeCompany();
    const w = await expenseWorld(c);
    const reviewer = await h.actor(c, 'FINANCE_REVIEWER');
    const sameUser = await h.actor(c, 'FINANCE_REVIEWER', { user: w.settler.user });
    const financeOnly = await h.actor(c, 'FINANCE_REVIEWER', { departmentFilter: c.financeDept });
    const figures = async (a: TestActor) => [await figure(a, 'RECONCILIATION_TASKS'), await figure(a, 'UNRECONCILED_OUTCOMES'), await figure(a, 'EXPENSE_STATES')];
    const { byCode } = await dashboardOf(reviewer);
    expect(byCode.RECONCILIATION_TASKS).toMatchObject({ title: 'Claims with a failed or reversed payment still outstanding' });
    expect(byCode.UNRECONCILED_OUTCOMES).toMatchObject({ title: 'Claims with a released payment whose outcome is not recorded' });
    expect(byCode.EXPENSE_STATES).toMatchObject({ kind: 'STATUS', title: 'Returned / approved claims awaiting payment' });
    expect(await figures(reviewer)).toEqual([0, 0, '0/0']);

    const claim = await w.approved(w.eng, '1000.00');
    expect(await figures(reviewer)).toEqual([0, 0, '0/1']);
    const first = await w.prepare(claim, '1000.00');
    await w.ready(first);
    await w.release(first);
    expect(await figures(reviewer)).toEqual([0, 1, '0/1']);
    // A definitive failure: the outcome is known, the claim is still owed and nothing is reserved for it.
    await w.outcome(first, 'FAILED');
    expect(await figures(reviewer)).toEqual([1, 0, '0/1']);
    // A replacement reserves the amount again: no longer waiting for reconciliation.
    const second = await w.prepare(claim, '1000.00', w.today, first);
    expect(await figures(reviewer)).toEqual([0, 0, '0/1']);
    await w.ready(second);
    await w.release(second);
    await w.outcome(second, 'CONFIRMED');
    expect(await figures(reviewer)).toEqual([0, 0, '0/0']);
    // A reversal returns part of the money: owed again with nothing reserved.
    await w.reverse(second, '250.00');
    expect(await figures(reviewer)).toEqual([1, 0, '0/1']);
    // A claim returned at a financial step is the first part of the states figure.
    const returned = await w.atFinance(w.fin);
    expect((await w.decide(w.decider, await w.taskOf(w.decider, returned), { decision: 'RETURN', reason: 'Please correct (synthetic)' })).json().state).toBe('RETURNED');
    expect(await figures(reviewer)).toEqual([1, 0, '1/1']);

    // The same person's settling Admin assignment adds nothing; a department filter counts its own people only.
    expect(await figures(sameUser)).toEqual([1, 0, '1/1']);
    expect(await figures(financeOnly)).toEqual([0, 0, '1/0']);
    const rows = (await h.call(reviewer, 'GET', '/v1/expense/claim-states?payment=FAILED_OR_REVERSED')).json().items as Record<string, unknown>[];
    expect(rows).toEqual([expect.objectContaining({ claimId: claim, state: 'APPROVED', paymentState: 'PART_PAID', decisionDueOn: null })]);
    const body = (await dashboardOf(reviewer)).body;
    for (const marker of [...MARKERS, '1000.00', '250.00', '750.00']) expect(body, marker).not.toContain(marker);
  });

  it('without the claim-state list a small figure is hidden, never shown exactly, and has no link (BR-045; I-83 item 4)', async () => {
    const c = await h.makeCompany();
    const w = await expenseWorld(c);
    const duties = (BASELINE_ROLES.find((r) => r.code === 'FINANCE_REVIEWER')!.defaultDuties as PermissionKey[]).filter((k) => k !== 'expense_state.read.operational');
    const noList = await h.actor(c, 'FINANCE_REVIEWER', { duties });
    const pi = await w.prepare(await w.approved(w.eng));
    await w.ready(pi);
    await w.release(pi);
    const { byCode } = await dashboardOf(noList);
    expect(byCode.UNRECONCILED_OUTCOMES).toEqual(expect.objectContaining({ status: 'SUPPRESSED', threshold: 5 }));
    expect(byCode.UNRECONCILED_OUTCOMES).not.toHaveProperty('value');
    expect(byCode.UNRECONCILED_OUTCOMES).not.toHaveProperty('source');
    expect(byCode.RECONCILIATION_TASKS).toMatchObject({ status: 'OK', value: 0 });
    expect(byCode.RECONCILIATION_TASKS).not.toHaveProperty('source');
    expect((await h.call(noList, 'GET', '/v1/expense/claim-states?payment=OUTCOME_UNKNOWN')).statusCode).toBe(403);
  });
});

describe('Expense Finance Approver "Decision due" under the dated due period (I-92)', () => {
  it('a claim falls due the set number of business days after reaching its financial step; the value in force on arrival applies', async () => {
    const c = await h.makeCompany();
    const w = await expenseWorld(c);
    const approver = await h.actor(c, 'EXPENSE_FINANCE_APPROVER');
    const sameUser = await h.actor(c, 'EXPENSE_FINANCE_APPROVER', { user: w.decider.user });
    const financeOnly = await h.actor(c, 'EXPENSE_FINANCE_APPROVER', { departmentFilter: c.financeDept });
    expect((await dashboardOf(approver)).byCode.DECISIONS_DUE).toMatchObject({ status: 'OK', value: 0, title: 'Claims whose final decision is due' });

    // Arrived today: due five business days later (the delegated starting value), so not yet due.
    const fresh = await w.atFinance(w.eng);
    expect(await figure(approver, 'DECISIONS_DUE')).toBe(0);
    const dueOf = async (claimId: string) =>
      ((await h.call(approver, 'GET', '/v1/expense/claim-states?states=FINANCE_PENDING,HIGH_VALUE_PENDING')).json().items as { claimId: string; decisionDueOn: string | null }[]).find(
        (r) => r.claimId === claimId,
      )!.decisionDueOn;
    expect(await dueOf(fresh)).toBe(addBusinessDays(w.today, 5));
    // Arrived ten calendar days ago: due.
    const old = await w.atFinance(w.eng);
    const arrived = await w.arrivedDaysAgo(old, 10);
    expect(await dueOf(old)).toBe(addBusinessDays(arrived, 5));
    expect(await figure(approver, 'DECISIONS_DUE')).toBe(1);
    // The Finance claimant's claim, due as well: the filtered assignment counts its own people only.
    const finOld = await w.atFinance(w.fin);
    await w.arrivedDaysAgo(finOld, 10);
    expect(await figure(approver, 'DECISIONS_DUE')).toBe(2);
    expect(await figure(financeOnly, 'DECISIONS_DUE')).toBe(1);
    // The same person's deciding Admin assignment adds nothing to the ordinary role's figure (DF17 no merging).
    expect(await figure(sameUser, 'DECISIONS_DUE')).toBe(2);

    // HR changes the period from today: claims that arrived before keep the value in force then; new arrivals take the new one.
    const changed = await h.call(w.hr, 'POST', '/v1/reporting-settings', {
      effectiveFrom: w.today,
      smallCountThreshold: 5,
      recentActivityDays: 14,
      salaryProgressionYears: 5,
      expenseDecisionDueDays: 1,
      reason: 'Synthetic: decisions within a day',
    });
    expect(changed.statusCode, changed.body).toBe(201);
    expect(changed.json()).toMatchObject({ expenseDecisionDueDays: 1 });
    expect(await dueOf(old)).toBe(addBusinessDays(arrived, 5));
    expect(await dueOf(fresh)).toBe(addBusinessDays(w.today, 1));
    expect(await figure(approver, 'DECISIONS_DUE')).toBe(2);
    // A decision ends it.
    const lines = ((await h.call(w.decider, 'GET', `/v1/expense/claims/${old}`)).json().lines as { id: string; claimedAmount: string }[]).map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount }));
    expect((await w.decide(w.decider, await w.taskOf(w.decider, old), { decision: 'APPROVE', lines })).json().state).toBe('APPROVED');
    expect(await figure(approver, 'DECISIONS_DUE')).toBe(1);
    const body = (await dashboardOf(approver)).body;
    for (const marker of MARKERS) expect(body, marker).not.toContain(marker);
  });

  it('an ASSIGNED scope says the figure needs an organisation scope instead of a lasting 0', async () => {
    const c = await h.makeCompany();
    const { byCode } = await dashboardOf(await h.actor(c, 'EXPENSE_FINANCE_APPROVER', { scope: 'ASSIGNED' }));
    expect(byCode.DECISIONS_DUE).toMatchObject({ status: 'NOT_CONFIGURED', message: 'Claim counts need an organisation-scope assignment: claims are not assigned to this role' });
  });
});

describe('the dated due period of a final decision (I-92; 0245)', () => {
  it('is bounded, carried into a revision that leaves it out, audited, and frozen like the other values', async () => {
    const c = await h.makeCompany();
    const hr = await h.actor(c, 'HR_ADMINISTRATOR');
    const today = await businessDate(h, c);
    const base = { smallCountThreshold: 5, recentActivityDays: 14, salaryProgressionYears: 5, reason: 'Synthetic revision' };
    expect((await h.call(hr, 'GET', '/v1/reporting-settings')).json().inForce).toMatchObject({ effectiveFrom: '2000-01-01', expenseDecisionDueDays: 5 });
    for (const bad of [0, 31, 2.5]) expect((await h.call(hr, 'POST', '/v1/reporting-settings', { ...base, effectiveFrom: addDays(today, 30), expenseDecisionDueDays: bad })).statusCode, String(bad)).toBe(400);
    expect((await h.call(hr, 'POST', '/v1/reporting-settings', { ...base, effectiveFrom: addDays(today, 10), expenseDecisionDueDays: 3 })).statusCode).toBe(201);
    // Left out: the revision carries the value of the one it follows.
    const carried = await h.call(hr, 'POST', '/v1/reporting-settings', { ...base, effectiveFrom: addDays(today, 20) });
    expect(carried.statusCode, carried.body).toBe(201);
    expect(carried.json()).toMatchObject({ expenseDecisionDueDays: 3 });
    const created = await h.one<{ after_values: { expenseDecisionDueDays?: number } }>(
      `select after_values from audit_event where company_id = $1 and resource_code = 'reporting_setting' and action = 'CREATE' and record_key = $2`,
      [c.id, carried.json().id],
    );
    expect(JSON.stringify(created.after_values)).toContain('"expenseDecisionDueDays":3');
    const first = await h.one<{ id: string }>(`select id from reporting_setting where company_id = $1 and effective_from = '2000-01-01'`, [c.id]);
    await expect(h.db.query(`update reporting_setting set expense_decision_due_days = 9 where id = $1`, [first.id])).rejects.toThrow(/fixed/);
    // A recruiter or auditor neither reads nor changes it.
    for (const role of ['RECRUITER', 'AUDITOR']) expect((await h.call(await h.actor(c, role), 'POST', '/v1/reporting-settings', { ...base, effectiveFrom: addDays(today, 40), expenseDecisionDueDays: 2 })).statusCode).toBe(403);
  });

  it('business days run Monday to Friday', async () => {
    const add = async (day: string, n: number) => (await h.one<{ d: string }>(`select to_char(hrms_add_business_days($1::date, $2), 'YYYY-MM-DD') as d`, [day, n])).d;
    expect(await add('2026-11-06', 1)).toBe('2026-11-09'); // Friday + 1: Monday
    expect(await add('2026-11-07', 5)).toBe('2026-11-13'); // Saturday + 5: Friday
    expect(await add('2026-11-09', 5)).toBe('2026-11-16'); // Monday + 5: Monday
    expect(await add('2026-11-09', 30)).toBe('2026-12-21');
    for (const [day, n] of [['2026-12-31', 7], ['2027-02-26', 2], ['2026-11-08', 1]] as const) expect(await add(day, n), `${day} + ${n}`).toBe(addBusinessDays(day, n));
  });
});

describe('Recruiter "Interview tasks due" (I-92)', () => {
  it('counts the viewer’s own applications at the interview stage in scope, equals its list, and needs the owner duty in the same assignment', async () => {
    const c = await h.makeCompany();
    const world = await hiringWorld(h, c);
    const requisition = await approvedRequisition(h, c, world);
    const recruiter = await h.actor(c, 'RECRUITER');
    const colleague = await h.actor(c, 'RECRUITER');
    const candidate = async () =>
      (await h.call(recruiter, 'POST', '/v1/hiring/candidates', { fullName: `Synthetic ${uniq('Interviewee')}`, sourceCode: 'DIRECT', consentStatus: 'GIVEN', consentRecordedOn: world.today })).json().id as string;
    const apply = async () => {
      const res = await h.call(recruiter, 'POST', `/v1/hiring/requisitions/${requisition.id}/applications`, { candidateId: await candidate() });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().id as string;
    };
    const versionOf = async (id: string) => (await h.call(recruiter, 'GET', `/v1/hiring/applications/${id}`)).json().version as number;
    const move = async (id: string, toStage: string) => expect((await h.call(recruiter, 'POST', `/v1/hiring/applications/${id}/stage`, { toStage, expectedVersion: await versionOf(id) })).statusCode).toBeLessThan(300);

    expect((await dashboardOf(recruiter)).byCode.INTERVIEWS_DUE).toMatchObject({ status: 'OK', value: 0, title: 'Applications you own awaiting interview completion' });
    const first = await apply();
    await move(first, 'SCREENING');
    expect(await figure(recruiter, 'INTERVIEWS_DUE')).toBe(0);
    await move(first, 'INTERVIEW');
    const second = await apply();
    for (const stage of ['SCREENING', 'INTERVIEW']) await move(second, stage);
    expect(await figure(recruiter, 'INTERVIEWS_DUE')).toBe(2);
    expect(await figure(colleague, 'INTERVIEWS_DUE')).toBe(0);
    // Handed to the colleague: the task moves with the ownership.
    expect((await h.call(recruiter, 'PUT', `/v1/hiring/applications/${second}/owner`, { ownerUserId: colleague.user, expectedVersion: await versionOf(second) })).statusCode).toBe(200);
    expect(await figure(recruiter, 'INTERVIEWS_DUE')).toBe(1);
    expect(await figure(colleague, 'INTERVIEWS_DUE')).toBe(1);
    // Interview completed: the application moves on to the offer stage.
    await move(first, 'OFFER');
    expect(await figure(recruiter, 'INTERVIEWS_DUE')).toBe(0);

    // A Finance-filtered recruiter does not reach the Engineering requisition, even for applications it owns.
    const filtered = await h.actor(c, 'RECRUITER', { user: colleague.user, departmentFilter: c.financeDept });
    expect(await figure(filtered, 'INTERVIEWS_DUE')).toBe(0);
    // Without the application management duty the assignment owns nothing: said so, no number and no link (DF17 no merging).
    const duties = (BASELINE_ROLES.find((r) => r.code === 'RECRUITER')!.defaultDuties as PermissionKey[]).filter((k) => k !== 'application.manage.operational');
    const readOnly = (await dashboardOf(await h.actor(c, 'RECRUITER', { user: colleague.user, duties }))).byCode.INTERVIEWS_DUE;
    expect(readOnly).toMatchObject({ status: 'NOT_CONFIGURED', message: 'Interview tasks belong to application owners: this assignment does not hold the application management duty' });
    expect(readOnly).not.toHaveProperty('source');
  });
});

describe('Auditor "Review evidence tasks" (I-92)', () => {
  it('stays visibly unavailable, with no number and no link', async () => {
    const { byCode } = await dashboardOf(await h.actor(await h.makeCompany(), 'AUDITOR'));
    expect(byCode.REVIEW_EVIDENCE).toMatchObject({ status: 'NOT_AVAILABLE', title: 'Review evidence tasks' });
    expect(byCode.REVIEW_EVIDENCE).not.toHaveProperty('value');
    expect(byCode.REVIEW_EVIDENCE).not.toHaveProperty('source');
  });
});

describe('0245 moves existing companies’ widget rows (I-92)', () => {
  it('points the old rows at the new figures and titles; a row a company changed is left alone', async () => {
    const c = await h.makeCompany();
    const rows = async () =>
      Object.fromEntries(
        (
          await h.db.query<{ key: string; metric_code: string; title: string; permission: string }>(
            `select r.code || '.' || w.widget_code as key, w.metric_code, w.title, p.resource || '.' || p.action || '.' || p.field_group as permission
               from role_dashboard_widget w join role_dashboard_definition d on d.company_id = w.company_id and d.id = w.dashboard_id
               join role r on r.company_id = d.company_id and r.id = d.role_id join permission p on p.id = w.permission_id
              where w.company_id = $1 and (r.code, w.widget_code) in (('TREASURY_OPERATOR', 'RECONCILE'), ('FINANCE_REVIEWER', 'RECONCILIATION_TASKS'),
                    ('FINANCE_REVIEWER', 'UNRECONCILED_OUTCOMES'), ('FINANCE_REVIEWER', 'EXPENSE_STATES'), ('EXPENSE_FINANCE_APPROVER', 'DECISIONS_DUE'), ('RECRUITER', 'INTERVIEWS_DUE'))`,
            [c.id],
          )
        ).rows.map((r) => [r.key, [r.metric_code, r.title, r.permission]]),
      );
    const provisioned = await rows();
    expect(provisioned['TREASURY_OPERATOR.RECONCILE']).toEqual(['PAYMENT_RESERVATIONS_TO_RECONCILE', 'Payments past their date still holding a reservation', 'payment.read.operational']);
    const setRow = (role: string, widget: string, metric: string, title: string, permission = 'dashboard') =>
      h.db.query(
        `update role_dashboard_widget w set metric_code = $4, title = $5,
                permission_id = (select id from permission where resource = $6 and action = 'read' and field_group = 'operational')
           from role_dashboard_definition d join role r on r.company_id = d.company_id and r.id = d.role_id
          where d.company_id = w.company_id and d.id = w.dashboard_id and d.company_id = $1 and r.code = $2 and w.widget_code = $3`,
        [c.id, role, widget, metric, title, permission],
      );
    const old = async () => {
      await setRow('TREASURY_OPERATOR', 'RECONCILE', 'NOT_YET_AVAILABLE', 'Reservations needing reconciliation');
      await setRow('FINANCE_REVIEWER', 'RECONCILIATION_TASKS', 'FINANCE_RECONCILIATION_TASKS', 'Reconciliation tasks');
      await setRow('FINANCE_REVIEWER', 'UNRECONCILED_OUTCOMES', 'FINANCE_UNRECONCILED_OUTCOMES', 'Unreconciled payment outcomes');
      await setRow('FINANCE_REVIEWER', 'EXPENSE_STATES', 'FINANCE_EXPENSE_STATES', 'Operational expense states');
      await setRow('EXPENSE_FINANCE_APPROVER', 'DECISIONS_DUE', 'EXPENSE_DECISION_DUE_TASKS', 'Decision due tasks');
      await setRow('RECRUITER', 'INTERVIEWS_DUE', 'INTERVIEW_TASKS_DUE', 'Interview tasks due', 'application');
    };
    // The widget part of the migration (its column and function already exist here).
    const migration = readFileSync(new URL('../../../../../db/migrations/0245_remaining_dashboard_figures.sql', import.meta.url), 'utf8');
    const widgetPart = migration.slice(migration.indexOf('update role_dashboard_widget'));
    await old();
    expect((await dashboardOf(await h.actor(c, 'TREASURY_OPERATOR'))).byCode.RECONCILE).toMatchObject({ status: 'NOT_AVAILABLE' });
    await h.db.query(widgetPart);
    expect(await rows()).toEqual(provisioned);
    expect((await dashboardOf(await h.actor(c, 'TREASURY_OPERATOR'))).byCode.RECONCILE).toMatchObject({ status: 'OK' });
    // A company that pointed or renamed a widget keeps its choice.
    await old();
    await setRow('TREASURY_OPERATOR', 'RECONCILE', 'MY_OPEN_TASKS', 'Our reconciliation queue');
    await setRow('RECRUITER', 'INTERVIEWS_DUE', 'INTERVIEW_TASKS_DUE', 'Interviews this week', 'application');
    await h.db.query(widgetPart);
    const kept = await rows();
    expect(kept['TREASURY_OPERATOR.RECONCILE']).toEqual(['MY_OPEN_TASKS', 'Our reconciliation queue', 'dashboard.read.operational']);
    expect(kept['RECRUITER.INTERVIEWS_DUE']).toEqual(['INTERVIEW_TASKS_DUE', 'Interviews this week', 'application.read.operational']);
    expect(kept['FINANCE_REVIEWER.EXPENSE_STATES']).toEqual(provisioned['FINANCE_REVIEWER.EXPENSE_STATES']);
  });
});
