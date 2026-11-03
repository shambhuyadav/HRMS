// Flexible confirmation over HTTP (FR-080/081/082; BR-029/030; DF11; CI17; ZT22).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hr2: TestActor;
let manager: TestActor;
let managerEmp: string;

const tomorrow = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 2); // safely after the company business date in any zone
  return d.toISOString().slice(0, 10);
};

async function probationer(overrides: Record<string, unknown> = {}): Promise<string> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides))).json();
  await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
  await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: e.joiningDate });
  return e.id;
}

const open = (employeeId: string) => h.call(hr, 'POST', '/v1/confirmations', { employeeId });
const getCase = async (actor: TestActor, id: string) => (await h.call(actor, 'GET', `/v1/confirmations/${id}`)).json();
const recommendation = async (caseId: string, body: Record<string, unknown>) =>
  h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: (await getCase(hr, caseId)).version, reason: 'Manager review (synthetic)', ...body });
const taskFor = async (actor: TestActor, employeeId: string) =>
  ((await h.call(actor, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === employeeId);
const decide = (actor: TestActor, taskId: string, decision: string) =>
  h.call(actor, 'POST', `/v1/confirmations/tasks/${taskId}/decision`, { decision, reason: 'HR decision (synthetic)', idempotencyKey: uniq('conf-key-') });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(
    `insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true), ($1, 'employee_confirmation', $3, 2, true)`,
    [A.id, hr.user, hr2.user],
  );
  const m = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  managerEmp = m.id;
  await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('due dates (FR-080, DF11, BR-029)', () => {
  it('3 calendar months from 31 January clamps to 30 April; a more specific 1-month intern policy gives 28 February', async () => {
    const e = await probationer({ joiningDate: '2026-01-31' });
    expect((await open(e)).json().dueDate).toBe('2026-04-30');

    await h.db.query(
      `insert into confirmation_policy (company_id, code, revision, duration, duration_unit, start_basis, month_end_rule, start_day_inclusive, employment_type_id, effective_from)
       select $1, 'INTERN', 1, 1, 'CALENDAR_MONTHS', 'JOINING_DATE', 'CLAMP_TO_MONTH_END', false, id, '2000-01-01'
         from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and code = 'INTERN'`,
      [A.id],
    );
    const intern = await probationer({ joiningDate: '2026-01-31', employmentType: 'INTERN' });
    expect((await open(intern)).json().dueDate).toBe('2026-02-28');
  });

  it('only probationers get a case, and only one live case per employee', async () => {
    const draft = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
    expect((await open(draft)).statusCode).toBe(422);
    const e = await probationer();
    expect((await open(e)).statusCode).toBe(201);
    expect((await open(e)).statusCode).toBe(409);
  });
});

describe('recommendation, independent decision and history (FR-081, BR-030, CI17, ZT22)', () => {
  it('overdue never auto-confirms; extension keeps prior/new due dates; confirmation sets the actual date', async () => {
    const e = await probationer({ joiningDate: '2026-01-31' });
    const { caseId } = (await open(e)).json();

    const overdue = (await h.call(hr, 'GET', '/v1/confirmations?view=OVERDUE')).json().items.map((i: { id: string }) => i.id);
    expect(overdue).toContain(caseId);
    expect((await getCase(hr, caseId)).state).toBe('OPEN');

    const notManager = await h.call(hr, 'POST', `/v1/confirmations/${caseId}/recommendation`, {
      expectedVersion: (await getCase(hr, caseId)).version,
      recommendation: 'EXTEND',
      reason: 'x',
    });
    expect(notManager.statusCode).toBe(403);

    expect((await recommendation(caseId, { recommendation: 'EXTEND', extensionMonths: 1 })).json().state).toBe('REVIEW_PENDING');
    expect((await recommendation(caseId, { recommendation: 'EXTEND' })).statusCode).toBe(409);

    const extendTask = await taskFor(hr, e);
    const extended = (await decide(hr, extendTask!.taskId, 'APPROVE')).json();
    expect(extended).toMatchObject({ state: 'OPEN', action: 'EXTENDED', dueDate: '2026-05-30' });

    // A confirmation date after the decision date is refused and nothing changes.
    await recommendation(caseId, { recommendation: 'CONFIRM', effectiveDate: tomorrow() });
    const futureTask = await taskFor(hr, e);
    expect((await decide(hr, futureTask!.taskId, 'APPROVE')).statusCode).toBe(422);
    expect((await getCase(hr, caseId)).state).toBe('REVIEW_PENDING');
    expect((await decide(hr, futureTask!.taskId, 'RETURN')).json()).toMatchObject({ state: 'OPEN', action: 'RETURNED' });

    await recommendation(caseId, { recommendation: 'CONFIRM', effectiveDate: '2026-06-01' });
    const confirmTask = await taskFor(hr, e);
    expect((await decide(hr, confirmTask!.taskId, 'APPROVE')).json()).toMatchObject({ state: 'CONFIRMED', actualConfirmationDate: '2026-06-01' });

    const final = await getCase(hr, caseId);
    expect(final).toMatchObject({ initialDueDate: '2026-04-30', dueDate: '2026-05-30', actualConfirmationDate: '2026-06-01', view: 'CONFIRMED' });
    expect(final.actions.map((a: { action: string }) => a.action)).toEqual(['EXTENDED', 'RETURNED', 'CONFIRMED']);
    expect(final.actions[0]).toMatchObject({ priorDueDate: '2026-04-30', newDueDate: '2026-05-30' });
    expect((await h.call(hr, 'GET', `/v1/employees/${e}`)).json()).toMatchObject({ status: 'ACTIVE_CONFIRMED', confirmationDate: '2026-06-01' });

    // DF02/DF11: action reasons are private. Default HR duties, the manager and the employee see the history
    // without reasons; only an assignment granted the confidential reason group sees them.
    expect(final.actions.every((a: object) => !('reason' in a))).toBe(true);
    expect((await getCase(manager, caseId)).actions.every((a: object) => !('reason' in a))).toBe(true);
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    const own = await getCase(self, caseId);
    expect(own.actions).toHaveLength(3);
    expect(JSON.stringify(own)).not.toContain('HR decision');
    const reasonReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['confirmation.read.reason'] });
    expect((await getCase(reasonReader, caseId)).actions.map((a: { reason: string }) => a.reason)).toEqual([
      'HR decision (synthetic)',
      'HR decision (synthetic)',
      'HR decision (synthetic)',
    ]);
  });

  it('enforces the extension limit (DF11: two unless an exception is approved)', async () => {
    const e = await probationer();
    const { caseId } = (await open(e)).json();
    for (let i = 0; i < 2; i++) {
      await recommendation(caseId, { recommendation: 'EXTEND' });
      await decide(hr, (await taskFor(hr, e))!.taskId, 'APPROVE');
    }
    const third = await recommendation(caseId, { recommendation: 'EXTEND' });
    expect(third.statusCode).toBe(422);
    expect(third.json().error).toBe('EXTENSION_LIMIT_REACHED');
  });

  it('an HR administrator never decides their own confirmation: routing skips to the next fallback reviewer', async () => {
    const own = await probationer();
    const hrSelf = await h.actor(A, 'HR_ADMINISTRATOR', { user: hr.user, employeeId: own });
    const { caseId } = (await h.call(hrSelf, 'POST', '/v1/confirmations', { employeeId: own })).json();
    await recommendation(caseId, { recommendation: 'EXTEND' });
    expect(await taskFor(hr, own)).toBeUndefined();
    expect(await taskFor(hr2, own)).toBeDefined();
  });
});

describe('visibility (FR-082)', () => {
  it('an employee sees their own case only', async () => {
    const e = await probationer();
    const other = await probationer();
    const mine = (await open(e)).json().caseId;
    const theirs = (await open(other)).json().caseId;
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    expect((await h.call(self, 'GET', `/v1/confirmations/${mine}`)).statusCode).toBe(200);
    expect((await h.call(self, 'GET', `/v1/confirmations/${theirs}`)).statusCode).toBe(404);
    expect((await h.call(self, 'GET', '/v1/confirmations')).json().items.map((i: { id: string }) => i.id)).toEqual([mine]);
  });

  it('the EXTENDED view lists live cases extended at least once, alongside their date view, until they close', async () => {
    const extendedEmp = await probationer();
    const plainEmp = await probationer();
    const { caseId } = (await open(extendedEmp)).json();
    const plain = (await open(plainEmp)).json().caseId;
    const extendedIds = async () => (await h.call(hr, 'GET', '/v1/confirmations?view=EXTENDED')).json().items.map((i: { id: string }) => i.id) as string[];
    expect(await extendedIds()).not.toContain(caseId);

    await recommendation(caseId, { recommendation: 'EXTEND' });
    await decide(hr, (await taskFor(hr, extendedEmp))!.taskId, 'APPROVE');
    expect(await extendedIds()).toContain(caseId);
    expect(await extendedIds()).not.toContain(plain);
    const row = await getCase(hr, caseId);
    expect(row).toMatchObject({ state: 'OPEN', extended: true, extensionCount: 1 });
    expect(row.view).not.toBe('EXTENDED'); // the date view (upcoming/due/overdue/later) is kept

    await recommendation(caseId, { recommendation: 'CONFIRM', effectiveDate: '2026-06-01' });
    await decide(hr, (await taskFor(hr, extendedEmp))!.taskId, 'APPROVE');
    expect(await extendedIds()).not.toContain(caseId);
    expect(await getCase(hr, caseId)).toMatchObject({ state: 'CONFIRMED', extended: false, view: 'CONFIRMED' });
  });
});

describe('missing policy or reviewer reported for HR review (FR-082, DF11)', () => {
  it('lists probationers without a policy or case and open cases without a manager or HR reviewer, and changes nothing', async () => {
    const B = await h.makeCompany();
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const reviewerB = await h.actor(B, 'HR_ADMINISTRATOR');
    const employee = async (overrides: Record<string, unknown>, status = 'ACTIVE_PROBATION') => {
      const e = (await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B, overrides))).json();
      await h.setStatus(B, e.id, status);
      return e.id as string;
    };
    const mgrEmp = await employee({}, 'ACTIVE_CONFIRMED');
    const mgr = await h.actor(B, 'REPORTING_MANAGER', { employeeId: mgrEmp });
    // Two equally specific fixed-term policies: ambiguous, never resolved by picking one (BR-029). They can only be
    // rows recorded before migration 0081's guard, which refuses a second one now, so the guard is off while they go in.
    await h.db.query(`alter table confirmation_policy disable trigger confirmation_policy_overlap_guard`);
    try {
      for (const code of ['FT_A', 'FT_B']) {
        await h.db.query(
          `insert into confirmation_policy (company_id, code, revision, duration, duration_unit, start_basis, month_end_rule, start_day_inclusive, employment_type_id, effective_from)
           select $1, $2, 1, 6, 'CALENDAR_MONTHS', 'JOINING_DATE', 'CLAMP_TO_MONTH_END', false, id, '2000-01-01'
             from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and code = 'FIXED_TERM'`,
          [B.id, code],
        );
      }
    } finally {
      await h.db.query(`alter table confirmation_policy enable trigger confirmation_policy_overlap_guard`);
    }
    const noPolicy = await employee({ joiningDate: '1999-06-01' }); // before every policy's start
    const ambiguous = await employee({ employmentType: 'FIXED_TERM' });
    const notOpened = await employee({});
    const withManager = await employee({});
    await h.call(hrB, 'POST', `/v1/employees/${withManager}/manager`, { managerEmployeeId: mgrEmp, effectiveFrom: '2026-01-05' });
    const noManager = await employee({});
    const confirmedEmp = await employee({}, 'ACTIVE_CONFIRMED');
    const withManagerCase = (await h.call(hrB, 'POST', '/v1/confirmations', { employeeId: withManager })).json().caseId;
    expect((await h.call(hrB, 'POST', '/v1/confirmations', { employeeId: noManager })).statusCode).toBe(201);

    const attention = async (a: TestActor = hrB) => {
      const res = await h.call(a, 'GET', '/v1/confirmations/attention');
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: { employeeId: string; caseId: string | null; issues: string[] }[]; total: number; truncated: boolean };
      return { ...body, byEmployee: Object.fromEntries(body.items.map((i) => [i.employeeId, i.issues])) };
    };
    const casesBefore = Number((await h.one<{ n: string }>(`select count(*) as n from employee_confirmation where company_id = $1`, [B.id])).n);
    const first = await attention();
    expect(first.byEmployee).toEqual({
      [noPolicy]: ['POLICY_NOT_FOUND'],
      [ambiguous]: ['POLICY_AMBIGUOUS'],
      [notOpened]: ['CASE_NOT_OPENED'],
      [withManager]: ['REVIEWER_MISSING'],
      [noManager]: ['MANAGER_MISSING', 'REVIEWER_MISSING'],
    });
    expect(first.byEmployee[confirmedEmp]).toBeUndefined();
    expect(first).toMatchObject({ total: 5, truncated: false });
    // What the list predicts is what routing does: the manager's recommendation is refused, not auto-routed.
    const refused = await h.call(mgr, 'POST', `/v1/confirmations/${withManagerCase}/recommendation`, {
      expectedVersion: (await h.call(hrB, 'GET', `/v1/confirmations/${withManagerCase}`)).json().version,
      recommendation: 'EXTEND',
      reason: 'Manager review (synthetic)',
    });
    expect(refused.json().error).toBe('NO_ELIGIBLE_REVIEWER');
    expect(Number((await h.one<{ n: string }>(`select count(*) as n from employee_confirmation where company_id = $1`, [B.id])).n)).toBe(casesBefore);

    // HR repairs the routing; the report follows, and the reviewer list never names an employee's own user.
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true)`, [
      B.id,
      reviewerB.user,
    ]);
    const repaired = await attention();
    expect(repaired.byEmployee[withManager]).toBeUndefined();
    expect(repaired.byEmployee[noManager]).toEqual(['MANAGER_MISSING']);
    const selfReviewer = await h.actor(B, 'HR_ADMINISTRATOR', { user: reviewerB.user, employeeId: withManager });
    expect(selfReviewer.user).toBe(reviewerB.user);
    expect((await attention()).byEmployee[withManager]).toEqual(['REVIEWER_MISSING']);

    // HR review duty only, within row scope.
    const self = await h.actor(B, 'EMPLOYEE', { employeeId: notOpened });
    expect((await h.call(self, 'GET', '/v1/confirmations/attention')).statusCode).toBe(403);
    expect((await h.call(mgr, 'GET', '/v1/confirmations/attention')).statusCode).toBe(403);
    const otherDept = await h.actor(B, 'HR_ADMINISTRATOR', { departmentFilter: B.financeDept });
    expect((await attention(otherDept)).items).toEqual([]);
  });
});
