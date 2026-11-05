// BRD Appendix F3 worked acceptance fixtures, rows 1-5 and 9, over the real routes (gates-14). Every expected value below is copied from
// the F3 table or worked by hand from the DF rule it cites, never read from the code. Row 1's manager half is held by
// team/team-dashboard.api.test.ts and is not repeated; rows 6-8 are outside this gate. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../db/tests/fixtures.js';
import type { PermissionKey } from '../modules/access/baseline.js';
import { prepareReady, releaseNaming } from '../modules/expense/payment.fixtures.js';
import { runReminders } from '../modules/notification/reminders.js';
import { processReportQueue } from '../modules/report/service.js';
import { type Company, type Harness, startHarness, type TestActor } from './harness.js';

let h: Harness;

const errorOf = (res: { statusCode: number; json(): { error?: string } }) => [res.statusCode, res.json().error];
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const DECIDE: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational', 'expense.finance_decide.operational', 'expense.high_value_decide.operational'];

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

/** A company with an HR Administrator, a manager and a claimant under that manager, an active expense policy and a reviewer list. */
async function expenseWorld(c: Company, reviewer: TestActor) {
  const hr = await h.actor(c, 'HR_ADMINISTRATOR');
  const activator = await h.actor(c, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'expense_claim', $2, 1, true)`, [c.id, reviewer.user]);
  const person = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(c))).json();
    await h.setStatus(c, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await person();
  const claimantEmp = await person();
  expect((await h.call(hr, 'POST', `/v1/employees/${claimantEmp}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
  const manager = await h.actor(c, 'REPORTING_MANAGER', { employeeId: managerEmp });
  const claimant = await h.actor(c, 'EMPLOYEE', { employeeId: claimantEmp });
  const policy = (await h.call(hr, 'GET', '/v1/expense/policies')).json().items[0];
  expect((await h.call(activator, 'POST', `/v1/expense/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);

  const view = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/expense/claims/${id}`)).json();
  const receipt = async (note: string) => {
    const res = await h.call(claimant, 'POST', '/v1/expense/receipts', { fileName: 'r.pdf', contentBase64: Buffer.from(`%PDF-1.4\n% synthetic ${note} ${uniq('f')}\n%%EOF\n`).toString('base64') });
    expect(res.statusCode, res.body).toBe(201);
    return { receiptId: res.json().receiptId as string };
  };
  const taskOf = async (a: TestActor, claimId: string) => {
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from expense_claim where id = $1`, [claimId])).transaction_id;
    return ((await h.call(a, 'GET', '/v1/expense/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)?.taskId;
  };
  const decide = (a: TestActor, taskId: string, body: object) => h.call(a, 'POST', `/v1/expense/tasks/${taskId}/decision`, { idempotencyKey: uniq('f3-key-'), ...body });
  /** A submitted claim of these line amounts, past its manager and waiting at the finance step. */
  const atFinance = async (amounts: string[], note = 'receipt') => {
    const lines = [];
    for (const amount of amounts) {
      lines.push({ category: 'OFFICE_SUPPLIES', expenseDate: daysAgo(1), merchant: `Synthetic Merchant ${uniq('m')}`, grossAmount: amount, claimedAmount: amount, description: 'F3 fixture (synthetic)', receipt: await receipt(note) });
    }
    const created = await h.call(claimant, 'POST', '/v1/expense/claims', { purpose: 'F3 fixture (synthetic)', currency: 'INR', lines });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().claimId as string;
    const submitted = await h.call(claimant, 'POST', `/v1/expense/claims/${id}/submit`, { expectedVersion: (await view(claimant, id)).version });
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect((await decide(manager, (await taskOf(manager, id))!, { decision: 'APPROVE' })).json().state).toBe('FINANCE_PENDING');
    return id;
  };
  return { hr, claimant, claimantEmp, view, taskOf, decide, atFinance };
}

describe('F3 rows 1 and 2: operational finance role, and a finance-duty Admin assignment (FR-098, DF02, CI24, ZT02, ZT03, ZT29, ZT30)', () => {
  let c: Company;
  let w: Awaited<ReturnType<typeof expenseWorld>>;
  let adminFinance: TestActor;
  let elsewhere: TestActor;
  let salaryReader: TestActor;
  let lineId: string;
  const MONTHLY = '73519.25';

  beforeAll(async () => {
    c = await h.makeCompany();
    // The Admin finance assignment: the expense final decision and nothing about employee records or salary.
    adminFinance = await h.actor(c, 'HR_ADMINISTRATOR', { duties: ['dashboard.read.operational', ...DECIDE] });
    // The same person's other assignment, which holds what the first lacks.
    elsewhere = await h.actor(c, 'HR_ADMINISTRATOR', { user: adminFinance.user, extra: ['salary.read.salary'] });
    salaryReader = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['salary.read.salary', 'salary.manage.salary'] });
    w = await expenseWorld(c, adminFinance);
    const set = await h.call(salaryReader, 'POST', `/v1/employees/${w.claimantEmp}/salary`, { effectiveFrom: '2026-01-05', monthlyGross: MONTHLY, annualCtc: '882231', currency: 'INR' });
    expect(set.statusCode, set.body).toBe(201);
    const id = await w.atFinance(['120']);
    lineId = ((await w.view(adminFinance, id)).lines as { id: string }[])[0]!.id;
  });

  it('row 1: the operational finance roles cannot fetch salary or a confidential receipt; those who may, can', async () => {
    const finance = await h.actor(c, 'FINANCE_REVIEWER');
    const approverRole = await h.actor(c, 'EXPENSE_FINANCE_APPROVER');
    const salaryUrl = `/v1/employees/${w.claimantEmp}/salary`;
    const receiptUrl = `/v1/expense/lines/${lineId}/receipt`;

    // Refused, and the refusal comes from the grant: both records exist and open for someone holding it.
    const control = await h.call(salaryReader, 'GET', salaryUrl);
    expect(control.statusCode).toBe(200);
    expect(control.body).toContain(MONTHLY.slice(0, 5));
    const receiptReader = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['expense.view_receipt.receipt', 'expense.read.operational', 'payment.read.operational'] });
    expect((await h.call(receiptReader, 'GET', receiptUrl)).statusCode).toBe(200);

    for (const role of [finance, approverRole]) {
      for (const url of [salaryUrl, receiptUrl, '/v1/salary-master']) {
        const res = await h.call(role, 'GET', url);
        expect(errorOf(res), url).toEqual([403, 'FORBIDDEN']);
        expect(res.body, url).not.toContain(MONTHLY.slice(0, 5));
      }
    }
    // The company-scope role sees the person's operational record, without the salary.
    const person = await h.call(finance, 'GET', `/v1/employees/${w.claimantEmp}`);
    expect(person.statusCode).toBe(200);
    expect(person.body).not.toContain(MONTHLY.slice(0, 5));
    // And neither role can be given the grant: the database refuses it above the role's ceiling.
    for (const role of ['FINANCE_REVIEWER', 'EXPENSE_FINANCE_APPROVER']) {
      await expect(h.actor(c, role, { extra: ['salary.read.salary'] }), role).rejects.toThrow('not allowed by the parent role');
      await expect(h.actor(c, role, { extra: ['expense.view_receipt.receipt'] }), role).rejects.toThrow('not allowed by the parent role');
    }
  });

  it('row 2: the Admin finance assignment decides the assigned claim; employee change and salary requests fail; its other assignment does not lend them', async () => {
    const id = await w.atFinance(['130']);
    const salaryUrl = `/v1/employees/${w.claimantEmp}/salary`;
    const employeeUrl = `/v1/employees/${w.claimantEmp}`;
    const nameBefore = (await h.one<{ n: string }>(`select display_name as n from employee where id = $1`, [w.claimantEmp])).n;
    const version = async () => (await h.one<{ version: number }>(`select version from employee where id = $1`, [w.claimantEmp])).version;

    expect(errorOf(await h.call(adminFinance, 'GET', salaryUrl))).toEqual([403, 'FORBIDDEN']);
    expect(errorOf(await h.call(adminFinance, 'PATCH', employeeUrl, { expectedVersion: await version(), displayName: 'Changed by finance' }))).toEqual([403, 'FORBIDDEN']);
    expect((await h.one<{ n: string }>(`select display_name as n from employee where id = $1`, [w.claimantEmp])).n).toBe(nameBefore);

    // The expense assigned review passes in this assignment.
    const lines = (await w.view(adminFinance, id)).lines as { id: string; claimedAmount: string }[];
    const approved = await w.decide(adminFinance, (await w.taskOf(adminFinance, id))!, { decision: 'APPROVE', lines: lines.map((l) => ({ lineId: l.id, allowedAmount: l.claimedAmount })) });
    expect(approved.json(), approved.body).toMatchObject({ state: 'APPROVED', approvedAmount: '130.0000' });

    // The other assignment answers for itself: it reads salary and edits the employee, and cannot take the decision.
    expect((await h.call(elsewhere, 'GET', salaryUrl)).statusCode).toBe(200);
    const renamed = await h.call(elsewhere, 'PATCH', employeeUrl, { expectedVersion: await version(), displayName: nameBefore });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const next = await w.atFinance(['140']);
    const taskId = (await w.taskOf(adminFinance, next))!;
    const lent = await w.decide(elsewhere, taskId, { decision: 'REJECT', reason: 'Synthetic' });
    expect(lent.statusCode, lent.body).toBe(403);
    expect((await w.view(adminFinance, next)).state).toBe('FINANCE_PENDING');
    // Holding both, the person is still refused salary under the finance assignment.
    expect(errorOf(await h.call(adminFinance, 'GET', salaryUrl))).toEqual([403, 'FORBIDDEN']);
  });
});

describe('F3 row 3: confirmation dates (FR-080, FR-082, DF11, DF12, ZT22)', () => {
  let c: Company;
  let hr: TestActor;
  let manager: TestActor;
  let managerEmp: string;

  const POLICIES = '/v1/confirmation-policies';
  const addPolicy = async (patch: Record<string, unknown>) => {
    const res = await h.call(hr, 'POST', POLICIES, { code: uniq('P').toUpperCase().replace(/[^A-Z0-9]/g, '_').slice(0, 40), startBasis: 'JOINING_DATE', effectiveFrom: '2000-01-01', ...patch });
    expect(res.statusCode, res.body).toBe(201);
  };
  const probationer = async (overrides: Record<string, unknown>) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(c, overrides))).json();
    await h.setStatus(c, e.id, 'ACTIVE_PROBATION');
    expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: e.joiningDate })).statusCode).toBe(200);
    return e.id as string;
  };
  const open = async (employeeId: string) => {
    const res = await h.call(hr, 'POST', '/v1/confirmations', { employeeId });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { caseId: string; dueDate: string };
  };
  const getCase = async (id: string) => (await h.call(hr, 'GET', `/v1/confirmations/${id}`)).json();
  const recommend = async (caseId: string, body: Record<string, unknown>) => {
    const res = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: (await getCase(caseId)).version, reason: 'Manager review (synthetic)', ...body });
    expect(res.json().state, res.body).toBe('REVIEW_PENDING');
  };
  const decideFor = async (employeeId: string) => {
    const task = ((await h.call(hr2(), 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === employeeId)!;
    return h.call(hr2(), 'POST', `/v1/confirmations/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'HR decision (synthetic)', idempotencyKey: uniq('conf-key-') });
  };
  let reviewer: TestActor;
  const hr2 = () => reviewer;
  const extend = async (employeeId: string, caseId: string) => {
    await recommend(caseId, { recommendation: 'EXTEND', extensionMonths: 1 });
    return (await decideFor(employeeId)).json();
  };
  const employeeFacts = async (id: string) => (await h.call(hr, 'GET', `/v1/employees/${id}`)).json();
  const reminderEvents = async (caseId: string) => (await h.one<{ n: number }>(`select count(*)::int as n from notification_event where company_id = $1 and event_key like 'CONFIRMATION_%:' || $2 || ':%'`, [c.id, caseId])).n;
  /** Moves the due date so that a reminder falls on today, runs the real job, and says whether it raised one. */
  const reminderFires = async (caseId: string, daysLeft: number) => {
    await h.db.query(`update employee_confirmation set current_due_date = hrms_business_date(company_id, now()) + $2::int where id = $1`, [caseId, daysLeft]);
    const before = await reminderEvents(caseId);
    await runReminders(h.pool, c.id);
    return (await reminderEvents(caseId)) > before;
  };

  beforeAll(async () => {
    c = await h.makeCompany();
    hr = await h.actor(c, 'HR_ADMINISTRATOR');
    reviewer = await h.actor(c, 'HR_ADMINISTRATOR');
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true)`, [c.id, reviewer.user]);
    const m = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(c))).json();
    managerEmp = m.id;
    await h.setStatus(c, managerEmp, 'ACTIVE_CONFIRMED');
    manager = await h.actor(c, 'REPORTING_MANAGER', { employeeId: managerEmp });
    await addPolicy({ duration: 1, durationUnit: 'CALENDAR_MONTHS', employmentType: 'INTERN' });
    await addPolicy({ duration: 45, durationUnit: 'CALENDAR_DAYS', employmentType: 'FIXED_TERM' });
  });

  it('starting 31 January on one calendar month: due 28 February, extended to 28 March, not 31 March; the next is 28 April; nothing confirms by date', async () => {
    const e = await probationer({ joiningDate: '2026-01-31', employmentType: 'INTERN' });
    const { caseId, dueDate } = await open(e);
    expect(dueDate).toBe('2026-02-28');

    // The date has long passed, and the reminder job has run: still open, the employee still on probation.
    await runReminders(h.pool, c.id);
    expect(await getCase(caseId)).toMatchObject({ state: 'OPEN', actualConfirmationDate: null, dueDate: '2026-02-28', view: 'OVERDUE' });
    expect((await employeeFacts(e)).status).toBe('ACTIVE_PROBATION');

    expect(await extend(e, caseId)).toMatchObject({ state: 'OPEN', action: 'EXTENDED', dueDate: '2026-03-28' });
    const once = await getCase(caseId);
    expect(once).toMatchObject({ initialDueDate: '2026-02-28', dueDate: '2026-03-28', state: 'OPEN', actualConfirmationDate: null });
    expect(once.actions[0]).toMatchObject({ action: 'EXTENDED', priorDueDate: '2026-02-28', newDueDate: '2026-03-28' });

    // DF11: from the current due date, so the clamp stays: 28 April, not 30 April.
    expect(await extend(e, caseId)).toMatchObject({ state: 'OPEN', action: 'EXTENDED', dueDate: '2026-04-28' });
    const twice = await getCase(caseId);
    expect(twice.actions.map((a: { priorDueDate: string; newDueDate: string }) => [a.priorDueDate, a.newDueDate])).toEqual([
      ['2026-02-28', '2026-03-28'],
      ['2026-03-28', '2026-04-28'],
    ]);
    expect((await employeeFacts(e)).status).toBe('ACTIVE_PROBATION');
    await runReminders(h.pool, c.id);
    expect(await getCase(caseId)).toMatchObject({ state: 'OPEN', actualConfirmationDate: null });
  });

  it('a day-based policy adds its days (DF11), and its extension is a calendar month from the current due date', async () => {
    const e = await probationer({ joiningDate: '2026-01-31', employmentType: 'FIXED_TERM' });
    const { caseId, dueDate } = await open(e);
    // 31 January + 45 days: 28 days to 28 February, 17 more to 17 March.
    expect(dueDate).toBe('2026-03-17');
    expect(await extend(e, caseId)).toMatchObject({ action: 'EXTENDED', dueDate: '2026-04-17' });
  });

  // BRD line 3926 and 2065 name start_day_inclusive with no worked value, and no route can set it: an expected date here could only be copied from the code.
  it.skip('a policy counting its start day as the first day gives the owner-approved date', () => undefined);

  it('confirmed, the case gets no further reminder in any later occurrence (DF12, BR-031, ZT22); the actual date is the one decided', async () => {
    const e = await probationer({ joiningDate: '2026-03-02' });
    const { caseId } = await open(e);
    expect(await reminderFires(caseId, 7)).toBe(true);

    await recommend(caseId, { recommendation: 'CONFIRM', effectiveDate: '2026-06-01' });
    expect((await decideFor(e)).json()).toMatchObject({ state: 'CONFIRMED', actualConfirmationDate: '2026-06-01' });
    expect(await employeeFacts(e)).toMatchObject({ status: 'ACTIVE_CONFIRMED', confirmationDate: '2026-06-01' });

    for (const daysLeft of [1, 0, -7]) expect(await reminderFires(caseId, daysLeft), `${daysLeft}`).toBe(false);
    // The case's own state stops them, not only the employee's status: a status set some other way changes nothing.
    await h.setStatus(c, e, 'ACTIVE_PROBATION');
    for (const daysLeft of [30, 1, 0, -14]) expect(await reminderFires(caseId, daysLeft), `${daysLeft} after a status change`).toBe(false);
  });
});

describe('F3 row 4: half a day of annual leave (FR-025, DF05, ZT16)', () => {
  it('24 days a year accrues 2.0000 for a full month; 0.5 is reserved on submission, consumed once on approval, and released on rejection', async () => {
    const c = await h.makeCompany();
    const hr = await h.actor(c, 'HR_ADMINISTRATOR');
    const activator = await h.actor(c, 'HR_ADMINISTRATOR');
    const person = async () => {
      const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(c, { joiningDate: '2026-01-05' }))).json();
      await h.setStatus(c, e.id, 'ACTIVE_CONFIRMED');
      return e.id as string;
    };
    const managerEmp = await person();
    const id = await person();
    expect((await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    const manager = await h.actor(c, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const self = await h.actor(c, 'EMPLOYEE', { employeeId: id });
    const policies = (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number; leaveType: string; annualEntitlement: string }[];
    // DF05: 24 for this permanent employee (the other annual revision, for interns, is 12).
    expect(policies.filter((p) => p.leaveType === 'ANNUAL').map((p) => Number(p.annualEntitlement))).toContain(24);
    for (const p of policies) expect((await h.call(activator, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);
    await h.runBulkJob(hr, '/v1/leave/accruals', { month: '2026-02' });

    const balance = async () => ((await h.call(self, 'GET', `/v1/employees/${id}/leave-balances`)).json().items as { leaveType: string; available: string; pending: string; taken: string }[]).find((b) => b.leaveType === 'ANNUAL')!;
    const movements = async () =>
      (
        await h.db.query<{ kind: string; units: string }>(
          `select m.movement_kind as kind, m.units::text as units from leave_movement m join leave_type t on t.id = m.leave_type_id
            where m.employee_id = $1 and t.code = 'ANNUAL' order by m.created_at, m.movement_kind`,
          [id],
        )
      ).rows;
    expect(await movements()).toEqual([{ kind: 'ACCRUAL', units: '2.0000' }]);
    expect(await balance()).toMatchObject({ available: '2.0000', pending: '0.0000', taken: '0.0000' });

    const monday = (days: number) => {
      const d = new Date(Date.now() + days * 86_400_000);
      while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const submit = async (day: string) => {
      const res = await h.call(self, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: day, endDate: day, halfDay: true, reason: 'Half-day appointment (synthetic)' });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().units).toBe('0.5');
      return res.json().requestId as string;
    };
    const taskFor = async () => ((await h.call(manager, 'GET', '/v1/leave/tasks')).json().items as { taskId: string }[])[0]!.taskId;

    await submit(monday(21));
    expect(await balance()).toMatchObject({ available: '1.5000', pending: '0.5000', taken: '0.0000' });

    const key = uniq('decision-key-');
    const taskId = await taskFor();
    const approve = () => h.call(manager, 'POST', `/v1/leave/tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key });
    expect((await approve()).json()).toMatchObject({ state: 'APPROVED', replayed: false });
    expect(await balance()).toMatchObject({ available: '1.5000', pending: '0.0000', taken: '0.5000' });
    expect((await approve()).json()).toMatchObject({ state: 'APPROVED', replayed: true });
    expect(await balance()).toMatchObject({ available: '1.5000', pending: '0.0000', taken: '0.5000' });
    expect((await movements()).filter((m) => m.kind === 'CONSUMPTION')).toEqual([{ kind: 'CONSUMPTION', units: '-0.5000' }]);

    await submit(monday(35));
    expect(await balance()).toMatchObject({ available: '1.0000', pending: '0.5000', taken: '0.5000' });
    const rejected = await h.call(manager, 'POST', `/v1/leave/tasks/${await taskFor()}/decision`, { decision: 'REJECT', reason: 'Not this week (synthetic)', idempotencyKey: uniq('decision-key-') });
    expect(rejected.json()).toMatchObject({ state: 'REJECTED' });
    expect(await balance()).toMatchObject({ available: '1.5000', pending: '0.0000', taken: '0.5000' });
    expect((await movements()).filter((m) => m.kind === 'CONSUMPTION')).toHaveLength(1);
  });
});

describe('F3 row 5: the 800 obligation paid 600 (FR-070 to FR-079, ZT13, ZT14, ZT17)', () => {
  it('lines 600 and 400 approved at 500 and 300: obligation 800, net paid 600, outstanding 200, at most 200 further reservation', async () => {
    const c = await h.makeCompany();
    const approver = await h.actor(c, 'HR_ADMINISTRATOR', { extra: DECIDE });
    const preparer = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'payment.read.operational', 'payment.prepare.operational'] });
    const settler = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['expense.read.operational', 'payment.read.operational', 'payment.release.operational', 'payment.confirm_outcome.operational'] });
    const w = await expenseWorld(c, approver);

    const id = await w.atFinance(['600', '400']);
    expect((await w.view(w.claimant, id)).lines.map((l: { claimedAmount: string }) => l.claimedAmount)).toEqual(['600.0000', '400.0000']);
    const lines = (await w.view(approver, id)).lines as { id: string }[];
    const approved = await w.decide(approver, (await w.taskOf(approver, id))!, {
      decision: 'APPROVE',
      lines: [
        { lineId: lines[0]!.id, allowedAmount: '500', reason: 'Above usual price (synthetic)' },
        { lineId: lines[1]!.id, allowedAmount: '300', reason: 'Partly personal (synthetic)' },
      ],
    });
    expect(approved.json(), approved.body).toMatchObject({ state: 'APPROVED', approvedAmount: '800.0000', paymentState: 'UNPAID' });
    const payment = async () => {
      const claim = await w.view(w.claimant, id);
      return { paymentState: claim.paymentState, ...claim.payment };
    };
    expect(await payment()).toMatchObject({ approvedAmount: '800.0000', netPaid: '0.0000', pending: '0.0000', outstanding: '800.0000', paymentState: 'UNPAID' });

    const prepare = (amount: string) => prepareReady(h, preparer, { claimId: id, amount, paymentDate: daysAgo(0), idempotencyKey: uniq('pay-key-') });
    const pay = (await prepare('600')).json().instructionId as string;
    expect((await releaseNaming(h, settler, pay)).json().state).toBe('RELEASED');
    expect((await h.call(settler, 'POST', `/v1/expense/payments/${pay}/outcome`, { outcome: 'CONFIRMED', evidenceKey: uniq('bank-ref-') })).statusCode).toBe(200);
    expect(await payment()).toMatchObject({ approvedAmount: '800.0000', netPaid: '600.0000', pending: '0.0000', outstanding: '200.0000', paymentState: 'PART_PAID' });

    const payable = async () => ((await h.call(preparer, 'GET', '/v1/expense/payables')).json().items as { claimId: string }[]).find((p) => p.claimId === id);
    expect(await payable()).toMatchObject({ approvedAmount: '800.00', netPaid: '600.00', pending: '0.00', allocatable: '200.00', currency: 'INR' });

    // At most 200 further.
    expect(errorOf(await prepare('200.01'))).toEqual([422, 'EXCEEDS_OUTSTANDING']);
    expect((await prepare('200')).statusCode).toBe(201);
    // A reservation is not paid (ZT17), and nothing further fits.
    expect(await payment()).toMatchObject({ netPaid: '600.0000', pending: '200.0000', outstanding: '200.0000', paymentState: 'PART_PAID' });
    expect(await payable()).toMatchObject({ netPaid: '600.00', pending: '200.00', allocatable: '0.00' });
    expect(errorOf(await prepare('0.01'))).toEqual([422, 'EXCEEDS_OUTSTANDING']);
  });
});

describe('F3 row 9: a role revoked around a confidential report (FR-098, ZT05, ZT30)', () => {
  let c: Company;
  let revoker: TestActor;
  let payroll: TestActor;
  let employeeId: string;
  const MONTHLY = '61827.50';
  const PERIOD = { from: '2026-07-01', to: '2026-07-31' };

  const request = async (a: TestActor) => {
    const res = await h.call(a, 'POST', '/v1/reports', { reportCode: 'SALARY_MASTER', filters: PERIOD });
    expect(res.statusCode, res.body).toBe(202);
    return res.json().id as string;
  };
  const exporter = () => h.actor(c, 'HR_ADMINISTRATOR', { extra: ['salary.read.salary', 'salary.history_read.salary', 'salary.export.salary'] });
  const revoke = async (a: TestActor) => {
    const { version } = await h.one<{ version: number }>(`select version from role_assignment where id = $1`, [a.assignment]);
    const res = await h.call(revoker, 'POST', `/v1/access/assignments/${a.assignment}/revoke`, { expectedVersion: version, reason: 'Left the role (synthetic)' });
    expect(res.statusCode, res.body).toBe(200);
  };
  /** What a revoked person can no longer open, still signed in: nothing that holds the salary, and the same refusal on each channel. */
  const deniedEverywhere = async (a: TestActor, reportId: string) => {
    for (const url of ['/v1/dashboard', `/v1/employees/${employeeId}/salary`, '/v1/salary-master', `/v1/employees/${employeeId}`]) {
      const res = await h.call(a, 'GET', url);
      expect(errorOf(res), url).toEqual([403, 'FORBIDDEN']);
      expect(res.body, url).not.toContain(MONTHLY.slice(0, 5));
    }
    const download = await h.call(a, 'GET', `/v1/reports/${reportId}/download`);
    expect(download.statusCode).toBeGreaterThanOrEqual(400);
    expect(download.body).not.toContain(MONTHLY.slice(0, 5));
    return download;
  };

  beforeAll(async () => {
    c = await h.makeCompany();
    revoker = await h.actor(c, 'SYSTEM_ADMINISTRATOR');
    payroll = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['salary.read.salary', 'salary.manage.salary'] });
    const e = (await h.call(payroll, 'POST', '/v1/employees', h.newEmployeeBody(c))).json();
    employeeId = e.id;
    await h.setStatus(c, employeeId, 'ACTIVE_CONFIRMED');
    const set = await h.call(payroll, 'POST', `/v1/employees/${employeeId}/salary`, { effectiveFrom: '2026-01-05', monthlyGross: MONTHLY, annualCtc: '741930', currency: 'INR' });
    expect(set.statusCode, set.body).toBe(201);
  });

  it('completed and then revoked: the download that worked is refused, and dashboard and records with it', async () => {
    const a = await exporter();
    const id = await request(a);
    await processReportQueue(h.pool);
    const before = await h.call(a, 'GET', `/v1/reports/${id}/download`);
    expect(before.statusCode, before.body).toBe(200);
    expect(before.body).toContain(MONTHLY.slice(0, 5));
    expect((await h.call(a, 'GET', '/v1/dashboard')).statusCode).toBe(200);

    await revoke(a);
    const download = await deniedEverywhere(a, id);
    expect(errorOf(download)).toEqual([403, 'FORBIDDEN']);
  });

  it('queued and then revoked: nothing is generated, so nothing can ever be delivered', async () => {
    const a = await exporter();
    const id = await request(a);
    await revoke(a);
    await processReportQueue(h.pool);
    expect(await h.one(`select state, failure_code, row_count from report_execution where id = $1`, [id])).toEqual({ state: 'FAILED', failure_code: 'ACCESS_REVOKED', row_count: null });
    expect((await h.db.query(`select 1 from report_output where execution_id = $1`, [id])).rowCount).toBe(0);
    const download = await deniedEverywhere(a, id);
    expect(errorOf(download)).toEqual([403, 'FORBIDDEN']); // refused before the state, so it does not say how far the report got
  });

  it('a grant withdrawn while the role stands: the file is refused the same way, the role’s other work goes on', async () => {
    const a = await exporter();
    const id = await request(a);
    await processReportQueue(h.pool);
    await h.db.query(
      `update role_assignment_permission set active = false
        where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'salary' and action = 'export' and field_group = 'salary')`,
      [a.assignment],
    );
    const res = await h.call(a, 'GET', `/v1/reports/${id}/download`);
    expect(errorOf(res)).toEqual([403, 'FORBIDDEN']);
    expect(res.body).not.toContain(MONTHLY.slice(0, 5));
    expect((await h.call(a, 'GET', '/v1/dashboard')).statusCode).toBe(200);
  });

  it('revoked: the report’s detail and the list are denied too, and say nothing about the report', async () => {
    const a = await exporter();
    const id = await request(a);
    await processReportQueue(h.pool);
    const listed = await h.call(a, 'GET', '/v1/reports');
    expect((listed.json().items as { id: string }[]).map((r) => r.id)).toEqual([id]);
    expect((await h.call(a, 'GET', `/v1/reports/${id}`)).json()).toMatchObject({ id, state: 'COMPLETED' });

    await revoke(a);
    for (const url of [`/v1/reports/${id}`, '/v1/reports']) {
      const res = await h.call(a, 'GET', url);
      expect(errorOf(res), url).toEqual([403, 'FORBIDDEN']);
      for (const fact of [id, 'rowCount', 'SALARY_MASTER', PERIOD.from]) expect(res.body, `${url} holds ${fact}`).not.toContain(fact);
    }
  });

  it('revoked with nothing ever requested: the list refuses all the same', async () => {
    const a = await exporter();
    expect((await h.call(a, 'GET', '/v1/reports')).json()).toMatchObject({ items: [], total: 0 });
    await revoke(a);
    expect(errorOf(await h.call(a, 'GET', '/v1/reports'))).toEqual([403, 'FORBIDDEN']);
  });

  it('queued and revoked, the requester is refused while the row says why nothing was generated', async () => {
    const a = await exporter();
    const id = await request(a);
    await revoke(a);
    await processReportQueue(h.pool);
    expect(errorOf(await h.call(a, 'GET', `/v1/reports/${id}`))).toEqual([403, 'FORBIDDEN']);
    expect(await h.one(`select state, failure_code from report_execution where id = $1`, [id])).toEqual({ state: 'FAILED', failure_code: 'ACCESS_REVOKED' });
  });

  it('a grant withdrawn while the role stands: that report leaves the detail and the list, with totals to match; the role’s other reports stay', async () => {
    const a = await exporter();
    const salaryReport = await request(a);
    const register = await h.call(a, 'POST', '/v1/reports', { reportCode: 'EMPLOYEE_REGISTER', filters: {} });
    expect(register.statusCode, register.body).toBe(202);
    await processReportQueue(h.pool);
    const listed = async () => (await h.call(a, 'GET', '/v1/reports')).json() as { items: { id: string }[]; total: number };
    expect((await listed()).total).toBe(2);

    await h.db.query(
      `update role_assignment_permission set active = false
        where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'salary' and action = 'export' and field_group = 'salary')`,
      [a.assignment],
    );
    expect(errorOf(await h.call(a, 'GET', `/v1/reports/${salaryReport}`))).toEqual([403, 'FORBIDDEN']);
    const after = await listed();
    expect(after.total).toBe(1);
    expect(after.items.map((r) => r.id)).toEqual([register.json().id]);
    expect((await h.call(a, 'GET', `/v1/reports/${register.json().id}`)).json()).toMatchObject({ state: 'COMPLETED' });
  });

  it('D-038 stands: another assignment of the same person finds nothing, rather than being told it is refused', async () => {
    const a = await exporter();
    const id = await request(a);
    await processReportQueue(h.pool);
    const other = await h.actor(c, 'HR_ADMINISTRATOR', { user: a.user, extra: ['salary.read.salary', 'salary.history_read.salary', 'salary.export.salary'] });
    expect(errorOf(await h.call(other, 'GET', `/v1/reports/${id}`))).toEqual([404, 'NOT_FOUND']);
    expect((await h.call(other, 'GET', '/v1/reports')).json()).toMatchObject({ items: [], total: 0 });
  });
});
