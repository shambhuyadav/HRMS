// F2 role widgets on real records (gates-12: ZT28, FR-096, FR-097, BR-045, F2). wave2-dashboards.api.test.ts asserts these on a fresh
// company, where a widget hard-coded to 0 would pass; widget-sources.api.test.ts walks most metrics under one synthetic assignment. Here
// each role's own GET /v1/dashboard is read over records made through the real routes: every number is written out as the count those
// records must give, compared with the widget's source list under the same actor, and read again under an assignment filtered to one
// department, which must count less and must not move when a record outside its scope appears. Where a baseline role cannot reach a
// number at all, the test says so as an open defect. Synthetic data only: amounts below are markers searched for in the answers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { resolveAccess } from '../access/authorize.js';
import type { PermissionKey } from '../access/baseline.js';
import { prepareReady, releaseNaming } from '../expense/payment.fixtures.js';
import { addDays as addHiringDays, approvedRequisition, hiringWorld, type HiringWorld } from '../hiring/test-fixtures.js';
import { advance, addDays, businessDate, newPlan, nominated, person } from '../training/training.fixtures.js';
import { METRICS } from './service.js';
import { METRIC_SOURCES, type SourceList } from './sources.js';

let h: Harness;

type Widget = { code: string; kind: string; status: string; value?: number | string; source?: { combine: string; lists: SourceList[] } };
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
/** The value a widget's own source lists give, under the same actor. */
const fromSource = async (a: TestActor, w: Widget) => {
  expect(w.source, `${w.code} has no source list`).toBeTruthy();
  const counts: number[] = [];
  for (const list of w.source!.lists) counts.push(await listCount(a, list));
  return w.source!.combine === 'PARTS' ? counts.join('/') : counts.reduce((x, y) => x + y, 0);
};
/** Each widget shows exactly this and, where it has a source, its source shows the same. */
const expectWidgets = async (a: TestActor, expected: Record<string, number | string>) => {
  const { byCode } = await dashboardOf(a);
  for (const [code, value] of Object.entries(expected)) {
    expect(byCode[code], code).toMatchObject({ status: 'OK', value });
    if (byCode[code]!.source) expect(await fromSource(a, byCode[code]!), `${code} against its source list`).toEqual(value);
  }
};
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const metricOf = async (a: TestActor, company: Company, metric: string) => {
  const grant = await resolveAccess(h.db, { userId: a.user, companyId: company.id, assignmentId: a.assignment, resource: 'dashboard', action: 'read', fieldGroups: ['operational'] });
  if (!grant.allowed) throw new Error(grant.reason);
  return METRICS[metric]!(h.db, grant);
};

const DECIDE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];
const PREPARE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.prepare.operational'];
const SETTLE: PermissionKey[] = ['expense.read.operational', 'payment.read.operational', 'payment.release.operational', 'payment.confirm_outcome.operational', 'payment.reverse.operational'];

/** Claimants in the two departments, with a manager, a reviewer list and an active expense policy, and approved claims through the real route. */
async function expenseWorld(c: Company, reviewers: TestActor[]) {
  const hr = await h.actor(c, 'HR_ADMINISTRATOR');
  const activator = await h.actor(c, 'HR_ADMINISTRATOR');
  for (const [i, r] of reviewers.entries()) {
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, $3, true)`, [c.id, r.user, i + 1]);
  }
  const boss = await person(h, c, hr);
  const manager = await h.actor(c, 'REPORTING_MANAGER', { employeeId: boss });
  const claimant = async (departmentId: string) => h.actor(c, 'EMPLOYEE', { employeeId: await person(h, c, hr, { departmentId, managerId: boss }) });
  const eng = await claimant(c.dept);
  const fin = await claimant(c.financeDept);
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(activator, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);

  const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
  const receipt = async (a: TestActor) => {
    const res = await h.call(a, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic widget receipt ${uniq('w')}\n%%EOF\n`).toString('base64') });
    expect(res.statusCode, res.body).toBe(201);
    return { receiptId: res.json().receiptId as string };
  };
  const taskOf = async (a: TestActor, claimId: string) => {
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
    return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!.taskId;
  };
  const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('widget-key-'), ...body });
  /** A claim submitted and past its manager: waiting at the finance step of the first reviewer. */
  const atFinance = async (who: TestActor, amount: string, extra?: Record<string, unknown>, expenseDate = daysAgo(0)) => {
    const lineExtra = extra ?? { receipt: await receipt(who) };
    const created = await h.call(who, 'POST', '/v1/expense/claims', {
      purpose: 'Widget marker purpose (synthetic)',
      currency: 'INR',
      lines: [{ category: 'OFFICE_SUPPLIES', expenseDate, merchant: 'Widget Marker Merchant', grossAmount: amount, claimedAmount: amount, description: 'Widget (synthetic)', ...lineExtra }],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().claimId as string;
    const submitted = await h.call(who, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(who, id)).version });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect((await decide(manager, await taskOf(manager, id), { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    return id;
  };
  return { manager, eng, fin, view, receipt, taskOf, decide, atFinance };
}

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

describe('Recruiter (F2; FR-096; BR-045)', () => {
  let c: Company;
  let w: HiringWorld;
  let recruiter: TestActor;
  let financeRecruiter: TestActor;
  const CTC = '912345.67';

  const applyTo = async (requisitionId: string) => {
    const candidate = await h.call(recruiter, 'POST', '/v1/hiring/candidates', { fullName: 'Synthetic Candidate', sourceCode: 'DIRECT', consentStatus: 'GIVEN', consentRecordedOn: w.today });
    expect(candidate.statusCode, candidate.body).toBe(201);
    const applied = await h.call(recruiter, 'POST', `/v1/hiring/requisitions/${requisitionId}/applications`, { candidateId: candidate.json().id });
    expect(applied.statusCode, applied.body).toBe(201);
    return applied.json().id as string;
  };
  const move = async (applicationId: string, toStage: string, note?: string) => {
    const current = (await h.call(recruiter, 'GET', `/v1/hiring/applications/${applicationId}`)).json();
    const res = await h.call(recruiter, 'POST', `/v1/hiring/applications/${applicationId}/stage`, { toStage, expectedVersion: current.version, ...(note ? { note } : {}) });
    expect(res.statusCode, res.body).toBe(200);
  };

  beforeAll(async () => {
    c = await h.makeCompany();
    w = await hiringWorld(h, c);
    recruiter = await h.actor(c, 'RECRUITER');
    financeRecruiter = await h.actor(c, 'RECRUITER', { departmentFilter: c.financeDept });
    const pricer = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['offer.read.compensation', 'offer.manage.compensation', 'offer.approve.compensation'] });
    const approver = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['offer.read.compensation', 'offer.approve.compensation'] });
    expect((await h.call(w.hr, 'PUT', '/v1/workflows/hiring_offer/fallback-reviewers', { reviewers: [{ userId: pricer.user, priority: 1 }, { userId: approver.user, priority: 2 }] })).statusCode).toBe(200);

    // Two approved requisitions in Engineering, one in Finance, and one still a draft.
    const eng = await approvedRequisition(h, c, w, { title: 'Synthetic widget role', vacancies: 3 });
    await approvedRequisition(h, c, w, { title: 'Synthetic quiet role' });
    const finance = await approvedRequisition(h, c, w, { title: 'Synthetic finance role', departmentId: c.financeDept });
    const unapproved = await h.call(w.requester, 'POST', '/v1/hiring/requisitions', {
      title: 'Synthetic draft role',
      departmentId: c.dept,
      locationId: c.loc,
      designationId: c.desig,
      employmentType: 'PERMANENT',
      vacancies: 1,
      reasonType: 'NEW',
      reason: 'Synthetic fixture',
      targetDate: addHiringDays(w.today, 45),
      hiringManagerId: w.requesterEmp,
    });
    expect(unapproved.statusCode, unapproved.body).toBe(201);

    // Engineering: one just applied, one rejected (no longer in the pipeline), one at offer with a submitted offer. Finance: one applied.
    await applyTo(eng.id);
    await move(await applyTo(eng.id), 'REJECTED', 'Synthetic');
    const atOffer = await applyTo(eng.id);
    for (const stage of ['SCREENING', 'INTERVIEW', 'OFFER']) await move(atOffer, stage);
    const created = await h.call(recruiter, 'POST', `/v1/hiring/applications/${atOffer}/offers`, { proposedJoiningDate: addHiringDays(w.today, 40) });
    expect(created.statusCode, created.body).toBe(201);
    const offerId = created.json().id as string;
    const version = async (a: TestActor) => (await h.call(a, 'GET', `/v1/hiring/offers/${offerId}`)).json().version;
    const priced = await h.call(pricer, 'PUT', `/v1/hiring/offers/${offerId}/compensation`, { currencyCode: 'INR', annualCtc: CTC, expectedVersion: await version(pricer) });
    expect(priced.statusCode, priced.body).toBe(200);
    expect((await h.call(recruiter, 'POST', `/v1/hiring/offers/${offerId}/submit`, { expectedVersion: await version(recruiter) })).json().state).toBe('SUBMITTED');
    await applyTo(finance.id);
  });

  it('approved requisitions, open pipeline and offers awaiting review are the records made, and equal their lists', async () => {
    await expectWidgets(recruiter, { APPROVED_REQUISITIONS: 3, PIPELINE: 3, OFFERS_AWAITING: 1 });
    expect((await dashboardOf(recruiter)).byCode.INTERVIEWS_DUE).toMatchObject({ status: 'NOT_AVAILABLE' });
  });

  it('a department filter narrows every number, and a record outside it does not move them', async () => {
    await expectWidgets(financeRecruiter, { APPROVED_REQUISITIONS: 1, PIPELINE: 1, OFFERS_AWAITING: 0 });
    const outside = await approvedRequisition(h, c, w, { title: 'Synthetic later role' });
    await applyTo(outside.id);
    await expectWidgets(financeRecruiter, { APPROVED_REQUISITIONS: 1, PIPELINE: 1, OFFERS_AWAITING: 0 });
    await expectWidgets(recruiter, { APPROVED_REQUISITIONS: 4, PIPELINE: 4, OFFERS_AWAITING: 1 });
  });

  it('counts only: the offer’s compensation appears nowhere on the dashboard', async () => {
    expect((await dashboardOf(recruiter)).body).not.toContain(CTC);
  });
});

describe('Training Coordinator (F2; FR-096; BR-045)', () => {
  let coordinator: TestActor;
  let financeCoordinator: TestActor;

  beforeAll(async () => {
    const c = await h.makeCompany();
    const hr = await h.actor(c, 'HR_ADMINISTRATOR');
    coordinator = await h.actor(c, 'TRAINING_COORDINATOR');
    financeCoordinator = await h.actor(c, 'TRAINING_COORDINATOR', { departmentFilter: c.financeDept });
    const day = await businessDate(h, c);
    const eng = await person(h, c, hr);
    const eng2 = await person(h, c, hr);
    const fin = await person(h, c, hr, { departmentId: c.financeDept });
    const owner = await person(h, c, hr);

    // Running now and in the future count as sessions; one that has finished does not.
    const running = await newPlan(h, coordinator, { startDate: addDays(day, -1), endDate: addDays(day, 5), ownerEmployeeId: owner });
    await newPlan(h, coordinator, { startDate: addDays(day, 10), endDate: addDays(day, 11), ownerEmployeeId: owner });
    const finished = await newPlan(h, coordinator, { startDate: addDays(day, -5), endDate: addDays(day, -2), ownerEmployeeId: owner, feedbackQuestionCodes: ['OVERALL'] });

    // Confirmed: Engineering and Finance. A nominee not yet confirmed is not.
    const [confirmedEng, confirmedFin] = await nominated(h, coordinator, running.id, [eng, fin]);
    await advance(h, coordinator, running.id, [confirmedEng!, confirmedFin!], ['CONFIRM']);
    await nominated(h, coordinator, running.id, [eng2]);

    // Finished: two completed (one in Finance, one who has given feedback) and one no-show.
    const [doneEng, doneFin, missed] = await nominated(h, coordinator, finished.id, [eng, fin, eng2]);
    await advance(h, coordinator, finished.id, [doneEng!, doneFin!], ['CONFIRM', 'MARK_ATTENDED', 'COMPLETE']);
    await advance(h, coordinator, finished.id, [missed!], ['CONFIRM', 'MARK_NO_SHOW']);
    const self = await h.actor(c, 'EMPLOYEE', { employeeId: eng });
    const gave = await h.call(self, 'POST', '/v1/me/training-feedback', { participantId: doneEng, answers: [{ questionCode: 'OVERALL', score: 4 }] });
    expect(gave.statusCode, gave.body).toBe(201);
  });

  it('sessions, confirmed, completed/no-show and feedback pending are the records made, and equal their lists', async () => {
    await expectWidgets(coordinator, { SESSIONS: 2, CONFIRMED: 2, COMPLETION_NO_SHOW: '2/1', FEEDBACK_PENDING: 1 });
  });

  it('a department filter narrows participation counts to its people; the plan register is company-wide by design', async () => {
    await expectWidgets(financeCoordinator, { SESSIONS: 2, CONFIRMED: 1, COMPLETION_NO_SHOW: '1/0', FEEDBACK_PENDING: 1 });
  });
});

describe('payment widgets (F2 Treasury Operator, Treasury Approver; DF07; BR-045)', () => {
  let c: Company;
  let preparer: TestActor;
  let settler: TestActor;
  let operator: TestActor;
  let financeOperator: TestActor;
  const AMOUNT = '731.37';

  beforeAll(async () => {
    c = await h.makeCompany();
    const approver = await h.actor(c, 'HR_ADMINISTRATOR', { extra: DECIDE });
    preparer = await h.actor(c, 'HR_ADMINISTRATOR', { extra: PREPARE });
    settler = await h.actor(c, 'HR_ADMINISTRATOR', { extra: SETTLE });
    operator = await h.actor(c, 'TREASURY_OPERATOR');
    financeOperator = await h.actor(c, 'TREASURY_OPERATOR', { departmentFilter: c.financeDept });
    const w = await expenseWorld(c, [approver]);
    const today = await businessDate(h, c);

    const approved = async (who: TestActor) => {
      const id = await w.atFinance(who, AMOUNT);
      const lines = (await w.view(approver, id)).lines as { id: string; claimedAmount: string }[];
      const res = await w.decide(approver, await w.taskOf(approver, id), { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
      expect(res.json().state, res.body).toBe('APPROVED');
      return id;
    };
    const prepared = async (who: TestActor, paymentDate = today) => {
      const res = await prepareReady(h, preparer, { claimId: await approved(who), amount: AMOUNT, paymentDate, idempotencyKey: uniq('pay-key-') });
      expect(res.statusCode, res.body).toBe(201);
      return res.json().instructionId as string;
    };
    const released = async (who: TestActor) => {
      const pi = await prepared(who);
      expect((await releaseNaming(h, settler, pi)).json().state).toBe('RELEASED');
      return pi;
    };
    const outcome = async (pi: string, kind: string) => expect((await h.call(settler, 'POST', `/v1/expense/payments/${pi}/outcome`, { outcome: kind, evidenceKey: uniq('bank-ref-') })).statusCode).toBe(200);

    await released(w.eng); // awaiting its outcome
    await released(w.fin); // awaiting its outcome, in Finance
    await outcome(await released(w.eng), 'FAILED');
    await outcome(await released(w.eng), 'FAILED');
    await outcome(await released(w.fin), 'FAILED');
    const paid = await released(w.eng);
    await outcome(paid, 'CONFIRMED');
    expect((await h.call(settler, 'POST', `/v1/expense/payments/${paid}/reversal`, { amount: '10', evidenceKey: uniq('reversal-key-'), reason: 'Bank return (synthetic)' })).statusCode).toBe(200);
    await outcome(await released(w.eng), 'CONFIRMED');
    await prepared(w.eng); // ready, due today
    await prepared(w.eng, addDays(today, -2)); // ready, past its payment date
    await prepared(w.fin, addDays(today, -2)); // ready, past its payment date, in Finance
    // A draft nobody has marked ready is not waiting for anyone's release.
    const draft = await h.call(preparer, 'POST', '/v1/expense/payments', { claimId: await approved(w.eng), amount: AMOUNT, paymentDate: addDays(today, -3), idempotencyKey: uniq('pay-key-') });
    expect(draft.statusCode, draft.body).toBe(201);
  });

  it('Treasury Operator: awaiting outcome and failed are the instructions made, and equal the payment list', async () => {
    await expectWidgets(operator, { AWAITING_OUTCOME: 2, FAILED: 3 });
    const { byCode } = await dashboardOf(operator);
    for (const code of ['MY_TASKS', 'RECONCILE']) expect(byCode[code], code).toMatchObject({ status: 'NOT_AVAILABLE' });
  });

  it('Treasury Operator: a department filter counts its own people only', async () => {
    await expectWidgets(financeOperator, { AWAITING_OUTCOME: 1, FAILED: 1 });
  });

  it('the release and outcome counts follow the instructions, and independence: under company scope, the source lists agree, and the preparer has nothing to release', async () => {
    // The role itself is ASSIGNED only, so its logic is read under a company-scope reader holding the same grants (see the open defect below).
    const reader = await h.customActor(c, { scope: 'COMPANY', permissions: ['dashboard.read.operational', 'payment.read.operational'] });
    const expected: Record<string, number | string> = { PAYMENTS_AWAITING_RELEASE: 3, PAYMENTS_RELEASE_OVERDUE: 2, PAYMENTS_CONFIRMED_REVERSED: '2/1', PAYMENTS_AWAITING_OUTCOME: 2 };
    const grant = await resolveAccess(h.db, { userId: reader.user, companyId: c.id, assignmentId: reader.assignment, resource: 'dashboard', action: 'read', fieldGroups: ['operational'] });
    if (!grant.allowed) throw new Error(grant.reason);
    for (const [metric, value] of Object.entries(expected)) {
      expect(await metricOf(reader, c, metric), metric).toEqual({ status: 'OK', value });
      const source = METRIC_SOURCES[metric]!;
      const counts: number[] = [];
      for (const list of source.lists(grant)) counts.push(await listCount(reader, list));
      expect(source.combine === 'PARTS' ? counts.join('/') : counts.reduce((x, y) => x + y, 0), `${metric} against its source list`).toEqual(value);
    }
    expect(await metricOf(preparer, c, 'PAYMENTS_AWAITING_RELEASE')).toEqual({ status: 'OK', value: 0 });
    expect((await h.call(preparer, 'GET', '/v1/expense/payments?state=PREPARED&releasableByMe=true')).json().total).toBe(0);
  });

  // DEFECT left open, needs a decision: C2 allows this role ASSIGNED scope only and a payment batch has no approval task, so nothing is ever in its scope: every number is 0 whatever exists.
  it.fails('Treasury Approver: its own dashboard shows the instructions awaiting it', async () => {
    const approver = await h.actor(c, 'TREASURY_APPROVER');
    await expectWidgets(approver, { RELEASE_TASKS: 3, OVERDUE_RELEASES: 2, CONFIRMED_REVERSED: '2/1', AWAITING_OUTCOME: 2 });
  });

  it('counts and states only: no amount or claim fact reaches either treasury dashboard, with real payments behind them', async () => {
    for (const a of [operator, financeOperator, await h.actor(c, 'TREASURY_APPROVER')]) {
      const { body, byCode } = await dashboardOf(a);
      for (const marker of [AMOUNT, 'Widget Marker', 'receipt']) expect(body.toLowerCase(), marker).not.toContain(marker.toLowerCase());
      for (const w of Object.values(byCode)) if (w.status === 'OK') expect(String(w.value), w.code).toMatch(/^\d+(\/\d+)?$/);
    }
  });
});

describe('Finance Reviewer and Expense Finance Approver (F2; DF02; DF17; BR-045)', () => {
  const AMOUNT = '644.21';

  /** Four claims waiting at the finance step of `decider`: two plain, in each department, one flagged late, one with no receipt. */
  async function queued(c: Company, decider: TestActor) {
    const w = await expenseWorld(c, [decider]);
    await w.atFinance(w.eng, AMOUNT);
    await w.atFinance(w.fin, AMOUNT);
    await w.atFinance(w.eng, AMOUNT, { receipt: await w.receipt(w.eng), exceptionReason: 'Late, synthetic' }, daysAgo(40));
    await w.atFinance(w.eng, AMOUNT, { exceptionReason: 'No receipt, synthetic' });
    return w;
  }

  it('as built: the Finance Reviewer’s assigned expense tasks count what the same person may decide in their Admin assignment (owner question: DF17 "no merging")', async () => {
    const c = await h.makeCompany();
    // The final decision belongs to an Admin assignment carrying the duty (DF02, F3 row 2); the same person also holds the ordinary role.
    const decider = await h.actor(c, 'HR_ADMINISTRATOR', { extra: DECIDE });
    const review = await h.actor(c, 'FINANCE_REVIEWER', { user: decider.user });
    await queued(c, decider);
    const { byCode, body } = await dashboardOf(review);
    expect((await h.call(decider, 'GET', '/v1/expense/tasks')).json().items).toHaveLength(4);
    expect(byCode.EXPENSE_REVIEW_TASKS).toMatchObject({ status: 'OK', value: 4 });
    expect(byCode.EXPENSE_REVIEW_TASKS).not.toHaveProperty('source');
    expect((await h.call(review, 'GET', '/v1/expense/tasks')).statusCode).toBe(403);
    for (const code of ['RECONCILIATION_TASKS', 'UNRECONCILED_OUTCOMES', 'EXPENSE_STATES']) expect(byCode[code], code).toMatchObject({ status: 'NOT_AVAILABLE' });
    for (const marker of [AMOUNT, 'Widget Marker']) expect(body, marker).not.toContain(marker);
  });

  it('a department filter on the Finance Reviewer’s assignment counts only tasks about its people', async () => {
    const c = await h.makeCompany();
    const decider = await h.actor(c, 'HR_ADMINISTRATOR', { extra: DECIDE });
    const filtered = await h.actor(c, 'FINANCE_REVIEWER', { user: decider.user, departmentFilter: c.financeDept });
    await queued(c, decider);
    expect((await dashboardOf(filtered)).byCode.EXPENSE_REVIEW_TASKS).toMatchObject({ status: 'OK', value: 1 });
  });

  it('the metrics behind the final-decision widgets count real tasks and flags, under an assignment that may decide them', async () => {
    const c = await h.makeCompany();
    // A company-specific ASSIGNED role holding the duties: what these metrics do once someone can reach them.
    const holder = await h.customActor(c, { scope: 'ASSIGNED', permissions: ['dashboard.read.operational', ...DECIDE] });
    const w = await queued(c, holder);
    expect(await metricOf(holder, c, 'EXPENSE_FINAL_DECISION_TASKS')).toEqual({ status: 'OK', value: 4 });
    expect(await metricOf(holder, c, 'EXPENSE_LATE_RECEIPT_EXCEPTIONS')).toEqual({ status: 'OK', value: 2 });
    expect(await metricOf(holder, c, 'EXPENSE_RETURNED_BY_ME')).toEqual({ status: 'OK', value: 0 });
    expect((await h.call(holder, 'GET', '/v1/expense/tasks')).json().items).toHaveLength(4);

    // One goes back to its claimant: a task fewer, a return more.
    const back = await w.atFinance(w.fin, AMOUNT);
    expect(await metricOf(holder, c, 'EXPENSE_FINAL_DECISION_TASKS')).toEqual({ status: 'OK', value: 5 });
    expect((await w.decide(holder, await w.taskOf(holder, back), { decision: 'RETURN', reason: 'Please correct (synthetic)' })).json().state).toBe('RETURNED');
    expect(await metricOf(holder, c, 'EXPENSE_FINAL_DECISION_TASKS')).toEqual({ status: 'OK', value: 4 });
    expect(await metricOf(holder, c, 'EXPENSE_RETURNED_BY_ME')).toEqual({ status: 'OK', value: 1 });
  });

  it('claims returned follow the assignment’s row scope: one outside its department filter does not move the count (BRD line 92; BR-045)', async () => {
    const c = await h.makeCompany();
    const decider = await h.actor(c, 'HR_ADMINISTRATOR', { extra: DECIDE });
    const whole = await h.actor(c, 'EXPENSE_FINANCE_APPROVER', { user: decider.user });
    const financeOnly = await h.actor(c, 'EXPENSE_FINANCE_APPROVER', { user: decider.user, departmentFilter: c.financeDept });
    const w = await expenseWorld(c, [decider]);
    const returned = async (a: TestActor) => (await dashboardOf(a)).byCode.RETURNED;
    const sendBack = async (who: TestActor) => {
      const id = await w.atFinance(who, AMOUNT);
      expect((await w.decide(decider, await w.taskOf(decider, id), { decision: 'RETURN', reason: 'Please correct (synthetic)' })).json().state).toBe('RETURNED');
    };
    expect([await returned(whole), await returned(financeOnly)]).toMatchObject([{ value: 0 }, { value: 0 }]);

    await sendBack(w.eng);
    expect(await returned(whole)).toMatchObject({ status: 'OK', value: 1 });
    expect(await returned(financeOnly)).toMatchObject({ status: 'OK', value: 0 });

    await sendBack(w.fin);
    expect(await returned(whole)).toMatchObject({ status: 'OK', value: 2 });
    expect(await returned(financeOnly)).toMatchObject({ status: 'OK', value: 1 });
  });

  // DEFECT left open, needs a decision: the role's ceiling holds no expense duty and its ASSIGNED scope reaches only tasks it may decide, so these two can only ever be 0 (DF17 keeps the same person's Admin tasks out).
  it.fails('Expense Finance Approver: its own dashboard shows the final decisions and late or missing-receipt claims waiting', async () => {
    const c = await h.makeCompany();
    const decider = await h.actor(c, 'HR_ADMINISTRATOR', { extra: DECIDE });
    const approverRole = await h.actor(c, 'EXPENSE_FINANCE_APPROVER', { user: decider.user });
    await queued(c, decider);
    const { byCode } = await dashboardOf(approverRole);
    expect(byCode.FINAL_DECISIONS).toMatchObject({ status: 'OK', value: 4 });
    expect(byCode.LATE_RECEIPT).toMatchObject({ status: 'OK', value: 2 });
  });
});

describe('System Administrator (F2; FR-096; BR-045)', () => {
  it('accounts, pending grants, failed integration runs and failed deliveries are the records made, and equal their lists', async () => {
    const c = await h.makeCompany();
    const admin = await h.actor(c, 'SYSTEM_ADMINISTRATOR', { extra: ['biometric.read.operational', 'biometric.profile_manage.operational', 'biometric.mapping_manage.operational'] });
    const user = await h.makeUser();
    const other = await h.makeUser();
    const holder = await h.actor(c, 'EMPLOYEE', { user });

    // Two pending grants: one a new request, one for someone who holds nothing yet.
    for (const u of [user, other]) {
      await h.db.query(
        `insert into role_assignment (company_id, user_id, role_id, scope_kind, effective_from, state, created_by)
         select $1, $2, r.id, 'TEAM', now(), 'PENDING', $3 from role r where r.company_id = $1 and r.code = 'REPORTING_MANAGER'`,
        [c.id, u, admin.user],
      );
    }
    // Deliveries: one failed, one delivered.
    await h.db.query(`insert into notification (company_id, recipient_user_id, category, state, channel, idempotency_key, body) values ($1, $2, 'SYNTHETIC', 'FAILED', 'IN_APP', $3, null), ($1, $2, 'SYNTHETIC', 'DELIVERED', 'IN_APP', $4, 'Synthetic')`, [
      c.id,
      holder.user,
      uniq('failed-'),
      uniq('delivered-'),
    ]);
    // Integration runs: failed and partial this month count; a completed run and last month's failure do not.
    const profileCode = uniq('BIO').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const profile = await h.call(admin, 'POST', '/v1/biometric/profiles', {
      code: profileCode,
      name: 'Synthetic devices',
      requestConfigReference: `secret-store://biometric/${profileCode}/request`,
      authReference: `secret-store://biometric/${profileCode}/credential`,
      providerTimezone: 'Asia/Kolkata',
      paginationMode: 'CURSOR',
      scheduleReference: 'every-15-minutes',
      lookbackMinutes: 10080,
    });
    expect(profile.statusCode, profile.body).toBe(201);
    const mapping = await h.call(admin, 'POST', `/v1/biometric/profiles/${profile.json().id}/mappings`, {
      dedupeStrategy: 'PROVIDER_EVENT_KEY',
      timestampRule: 'ISO_WITH_OFFSET',
      effectiveFrom: '2026-01-01T00:00:00Z',
      fields: [
        { sourcePath: 'emp', targetField: 'EMPLOYEE_KEY', transformCode: 'TRIM', required: true },
        { sourcePath: 'ts', targetField: 'PUNCH_INSTANT', transformCode: 'PARSE_INSTANT', required: true },
        { sourcePath: 'dir', targetField: 'DIRECTION', transformCode: 'ENUM_MAP', enumConfig: { '0': 'IN', '1': 'OUT' }, required: true },
        { sourcePath: 'id', targetField: 'EVENT_KEY', transformCode: 'IDENTITY', required: true },
      ],
    });
    expect(mapping.statusCode, mapping.body).toBe(201);
    const day = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [c.id])).d;
    for (const [state, startedAt] of [['FAILED', `${day}T06:00:00Z`], ['PARTIAL', `${day}T06:00:00Z`], ['COMPLETED', `${day}T06:00:00Z`], ['FAILED', '2020-01-15T06:00:00Z']] as const) {
      await h.db.query(
        `insert into biometric_sync_run (company_id, profile_id, mapping_revision_id, window_start, window_end, state, started_at, finished_at, failure_code)
         values ($1, $2, $3, now() - interval '1 hour', now(), $4, $5::timestamptz, now(), $6)`,
        [c.id, profile.json().id, mapping.json().mappingRevisionId, state, startedAt, state === 'COMPLETED' ? null : 'SYNTHETIC'],
      );
    }

    await expectWidgets(admin, { PENDING_GRANTS: 2, FAILED_INTEGRATIONS: 2, FAILED_NOTIFICATIONS: 1 });
    // Accounts holding access: the administrator and the employee, not someone with only a pending grant.
    const accounts = (await dashboardOf(admin)).byCode.ACTIVE_ACCOUNTS!;
    const holding = await h.one<{ n: number }>(`select count(distinct user_id)::int as n from role_assignment where company_id = $1 and state = 'ACTIVE'`, [c.id]);
    expect(accounts).toMatchObject({ status: 'OK', value: holding.n });
    expect(holding.n).toBeGreaterThanOrEqual(2);
    expect(await fromSource(admin, accounts)).toBe(holding.n);
  });
});

describe('Employee’s own balance (F2; FR-096; DF17)', () => {
  it('after activation the widget is the same number as /leave-balances, through a credit and a reservation', async () => {
    const c = await h.makeCompany();
    const hr = await h.actor(c, 'HR_ADMINISTRATOR');
    const activator = await h.actor(c, 'HR_ADMINISTRATOR');
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [c.id, hr.user]);
    const id = await person(h, c, hr);
    const self = await h.actor(c, 'EMPLOYEE', { employeeId: id });
    const balance = async () => ((await h.call(self, 'GET', `/v1/employees/${id}/leave-balances`)).json().items as { leaveType: string; available: string; pending: string }[]).find((b) => b.leaveType === 'ANNUAL')!;
    const widget = async () => (await dashboardOf(self)).byCode.LEAVE_BALANCE!;

    expect(await widget()).toMatchObject({ status: 'NOT_CONFIGURED', message: 'Policy not active' });
    for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
      expect((await h.call(activator, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);
    }
    expect(await widget()).toMatchObject({ status: 'OK', value: '0.0000' });
    expect(await balance()).toMatchObject({ available: '0.0000' });

    const credit = await h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId: id, leaveType: 'ANNUAL', kind: 'OPENING', units: '5', effectiveDate: '2026-01-05', reason: 'Opening balance (synthetic)', idempotencyKey: uniq('opening-key-') });
    expect(credit.statusCode, credit.body).toBe(201);
    expect(await widget()).toMatchObject({ status: 'OK', value: (await balance()).available });
    expect((await widget()).value).toBe('5.0000');

    const monday = new Date(Date.now() + 30 * 86_400_000);
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1);
    const day = monday.toISOString().slice(0, 10);
    const request = await h.call(self, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: day, endDate: day, halfDay: true });
    expect(request.statusCode, request.body).toBe(201);
    expect(await balance()).toMatchObject({ available: '4.5000', pending: '0.5000' });
    expect(await widget()).toMatchObject({ status: 'OK', value: '4.5000' });
  });
});
