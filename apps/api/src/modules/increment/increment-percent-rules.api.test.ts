// BR-039 increment percentages and annual growth (BRD line 1871; DF14, line 5025). Expected values are worked by hand from the BRD's
// formulas, not read from the service: per change = (after - before) / before x 100; annual = (closing - opening) / opening x 100;
// never a sum; 2 decimals half-up; zero, missing or non-comparable is N/A with a reason, never 0. Synthetic INR amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';

let h: Harness;
let A: Company;
let hr1: TestActor;
let hr2: TestActor;
let hrPlain: TestActor;
let managerEmp: string;

const GRANTS: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary', 'salary.history_read.salary', 'increment.read.salary', 'increment.history_read.salary', 'increment.propose.salary', 'increment.approve.salary'];

async function employee(salary: { gross: string; ctc: string; from?: string }, joiningDate = '2026-01-05'): Promise<string> {
  const e = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate }))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  await h.call(hrPlain, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: joiningDate });
  const res = await h.call(hr1, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: salary.from ?? joiningDate, monthlyGross: salary.gross, annualCtc: salary.ctc, currency: 'INR' });
  expect(res.statusCode, res.body).toBe(201);
  return e.id;
}

/** An off-cycle change proposed by one HR user and approved by the other; answers what the approval returned. */
async function change(employeeId: string, effectiveDate: string, gross: string, ctc: string) {
  const proposed = await h.call(hr2, 'POST', '/v1/increment-cases/off-cycle', { employeeId, effectiveDate, proposedAmount: gross, proposedCounterpart: ctc, reason: 'Off-cycle adjustment (synthetic)' });
  expect(proposed.statusCode, proposed.body).toBe(201);
  const tasks = (await h.call(hr1, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[];
  const task = tasks.find((t) => t.ownerEmployeeId === employeeId)!;
  const decided = await h.call(hr1, 'POST', `/v1/increment-cases/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'Independent review (synthetic)', idempotencyKey: uniq('pct-key-') });
  expect(decided.statusCode, decided.body).toBe(200);
  return decided.json() as { state: string; changePercent: string | null; percentNaReason: string | null };
}

const annual = async (employeeId: string, financialYear: number, basis?: string) =>
  (await h.call(hr1, 'GET', `/v1/employees/${employeeId}/annual-increment?financialYear=${financialYear}${basis ? `&basis=${basis}` : ''}`)).json();

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: GRANTS });
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: GRANTS });
  hrPlain = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true), ($1, 'increment_case', $3, 2, true)`, [A.id, hr1.user, hr2.user]);
  managerEmp = (await h.call(hrPlain, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id;
  await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
});

afterAll(async () => {
  await h?.stop();
});

describe('increment percentages and annual growth (BR-039, DF14)', () => {
  it('BR-039: each change is (after - before) / before x 100, and annual growth is (closing - opening) / opening x 100, not the sum of the changes', async () => {
    const e = await employee({ gross: '80000', ctc: '960000' });
    // 8000 / 80000 = 10%; 4400 / 88000 = 5%. Their sum would be 15; 12400 / 80000 is 15.5.
    expect(await change(e, '2027-05-01', '88000', '1056000')).toMatchObject({ state: 'APPLIED', changePercent: '10.00', percentNaReason: null });
    expect(await change(e, '2027-09-01', '92400', '1108800')).toMatchObject({ state: 'APPLIED', changePercent: '5.00', percentNaReason: null });
    const y = await annual(e, 2027);
    expect(y).toMatchObject({ opening: '80000.0000', closing: '92400.0000', annualGrowthPercent: '15.50', percentNaReason: null });
    expect(y.changes.map((c: { changePercent: string }) => c.changePercent)).toEqual(['10.00', '5.00']);
    expect(y.annualGrowthPercent).not.toBe('15.00');
    const history = (await h.call(hr1, 'GET', `/v1/employees/${e}/increment-history`)).json().items;
    expect(history.map((x: { changePercent: string }) => x.changePercent)).toEqual(['10.00', '5.00']);
  });

  it('BR-039: a basis is compared with itself only: annual cost grows by its own figures, not by those of monthly gross', async () => {
    const e = await employee({ gross: '50000', ctc: '800000' });
    await change(e, '2027-06-01', '55000', '1000000');
    // Gross: 5000 / 50000 = 10%. Annual cost: 200000 / 800000 = 25%.
    expect(await annual(e, 2027)).toMatchObject({ basis: 'MONTHLY_GROSS', opening: '50000.0000', closing: '55000.0000', annualGrowthPercent: '10.00' });
    expect(await annual(e, 2027, 'ANNUAL_CTC')).toMatchObject({ basis: 'ANNUAL_CTC', opening: '800000.0000', closing: '1000000.0000', annualGrowthPercent: '25.00' });
  });

  it('BR-039: the percentage is rounded half-up to 2 decimals (DF14): 10 / 8000 is 0.125, shown as 0.13', async () => {
    const e = await employee({ gross: '8000', ctc: '96000' });
    expect((await change(e, '2027-06-01', '8010', '96120')).changePercent).toBe('0.13');
    expect((await annual(e, 2027)).annualGrowthPercent).toBe('0.13');
  });

  it('BR-039: a decrement is negative, and no change reads 0 only where both values are known and comparable (DF14)', async () => {
    const e = await employee({ gross: '100000', ctc: '1200000' });
    expect((await change(e, '2027-06-01', '90000', '1080000')).changePercent).toBe('-10.00');
    expect(await annual(e, 2027)).toMatchObject({ opening: '100000.0000', closing: '90000.0000', annualGrowthPercent: '-10.00', percentNaReason: null });
    // The next year holds no change: opening and closing are both known and equal.
    expect(await annual(e, 2028)).toMatchObject({ opening: '90000.0000', closing: '90000.0000', annualGrowthPercent: '0.00', percentNaReason: null, changes: [] });
  });

  it('BR-039: a zero baseline gives N/A with a reason, per change and for the year, never 0', async () => {
    const e = await employee({ gross: '0', ctc: '0' });
    expect(await change(e, '2027-05-01', '50000', '600000')).toMatchObject({ state: 'APPLIED', changePercent: null, percentNaReason: 'ZERO_BASELINE' });
    expect(await annual(e, 2027)).toMatchObject({ annualGrowthPercent: null, percentNaReason: 'ZERO_BASELINE' });
  });

  it('BR-039: a missing opening or closing gives N/A with a reason, never 0', async () => {
    // Joined inside FY 2027: nothing was in force on 31 March 2027, the day before the year starts.
    const joinedInYear = await employee({ gross: '60000', ctc: '720000' }, '2027-10-15');
    expect(await annual(joinedInYear, 2027)).toMatchObject({ opening: null, closing: '60000.0000', annualGrowthPercent: null, percentNaReason: 'MISSING_OPENING_OR_CLOSING' });
    // A year before any salary: neither is known.
    expect(await annual(joinedInYear, 2020)).toMatchObject({ opening: null, closing: null, annualGrowthPercent: null, percentNaReason: 'MISSING_OPENING_OR_CLOSING' });
  });

  it('BR-039: opening and closing in different currencies are not comparable: N/A with a reason, never a number', async () => {
    const e = await employee({ gross: '70000', ctc: '840000' });
    // Foreign currency is disabled in wave 1 (DF06), so only a direct write can reach this; a stored row must still not give a figure.
    await h.db.query(`update salary_arrangement set effective_to = '2027-06-01' where company_id = $1 and employee_id = $2 and effective_to is null`, [A.id, e]);
    await h.db.query(`insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code) values ($1, $2, '2027-06-01', 9000, 750, 'USD')`, [A.id, e]);
    expect(await annual(e, 2027)).toMatchObject({ opening: '70000.0000', closing: '750.0000', annualGrowthPercent: null, percentNaReason: 'CURRENCY_CHANGED' });
  });
});
