// Reporting (I-83, decided under owner delegation, 6 Nov 2026): the dated reporting settings HR changes (BR-045 small-count threshold,
// DF17 recent activity window, FR-038 progression span), the BR-045 classification every dashboard metric must carry, DF17 recent
// operational activity, and the FR-038 salary progression chart with its confidential access. Synthetic people and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { METRIC_SUBJECTS, METRICS, suppressSmallCount } from '../dashboard/service.js';
import { financialYearOf } from './salary-progression.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h?.stop();
});

const businessDate = async (c: Company) => (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [c.id])).d;
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const revision = (effectiveFrom: string, values: Partial<{ smallCountThreshold: number; recentActivityDays: number; salaryProgressionYears: number }> = {}) => ({
  effectiveFrom,
  smallCountThreshold: 5,
  recentActivityDays: 14,
  salaryProgressionYears: 5,
  reason: 'Synthetic revision',
  ...values,
});

describe('reporting settings: dated, HR-changed, never rewritten (I-83; BR-045; DF17; FR-038)', () => {
  let c: Company;
  let hr: TestActor;
  let today: string;

  beforeAll(async () => {
    c = await h.makeCompany();
    hr = await h.actor(c, 'HR_ADMINISTRATOR');
    today = await businessDate(c);
  });

  it('a new company starts with the delegated defaults in force: threshold 5, 14 days of activity, a 5-year span', async () => {
    const res = await h.call(hr, 'GET', '/v1/reporting-settings');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().inForce).toMatchObject({ effectiveFrom: '2000-01-01', effectiveTo: null, smallCountThreshold: 5, recentActivityDays: 14, salaryProgressionYears: 5 });
    expect(res.json().items).toHaveLength(1);
  });

  it('a later revision ends the one in force on its start date; nothing before today is changed; each write is audited with its reason', async () => {
    expect((await h.call(hr, 'POST', '/v1/reporting-settings', revision(addDays(today, -1)))).json().error).toBe('EFFECTIVE_DATE_IN_PAST');
    const later = await h.call(hr, 'POST', '/v1/reporting-settings', { ...revision(addDays(today, 10), { smallCountThreshold: 3 }), reason: 'Synthetic: smaller teams' });
    expect(later.statusCode, later.body).toBe(201);
    // Not yet in force: today still reads the first revision, which now ends on the new start.
    let view = (await h.call(hr, 'GET', '/v1/reporting-settings')).json();
    expect(view.inForce).toMatchObject({ effectiveFrom: '2000-01-01', effectiveTo: addDays(today, 10), smallCountThreshold: 5 });
    expect(view.items.map((r: { effectiveFrom: string }) => r.effectiveFrom)).toEqual([addDays(today, 10), '2000-01-01']);
    // A start before or on a planned revision would rewrite the plan: refused. A later one closes the planned revision.
    for (const day of [addDays(today, 5), addDays(today, 10)]) expect((await h.call(hr, 'POST', '/v1/reporting-settings', revision(day))).json().error, day).toBe('REVISION_ALREADY_PLANNED');
    expect((await h.call(hr, 'POST', '/v1/reporting-settings', revision(addDays(today, 20), { salaryProgressionYears: 7 }))).statusCode).toBe(201);
    view = (await h.call(hr, 'GET', '/v1/reporting-settings')).json();
    expect(view.items.map((r: { effectiveFrom: string; effectiveTo: string | null }) => [r.effectiveFrom, r.effectiveTo])).toEqual([
      [addDays(today, 20), null],
      [addDays(today, 10), addDays(today, 20)],
      ['2000-01-01', addDays(today, 10)],
    ]);
    const trail = (await h.db.query<{ action: string; reason: string; acting_assignment_id: string }>(`select action, reason, acting_assignment_id from audit_event where company_id = $1 and resource_code = 'reporting_setting' order by occurred_at, action`, [c.id])).rows;
    expect(trail.map((t) => t.action).sort()).toEqual(['CREATE', 'CREATE', 'UPDATE', 'UPDATE']);
    expect(trail.every((t) => t.acting_assignment_id === hr.assignment)).toBe(true);
    expect(trail.map((t) => t.reason)).toContain('Synthetic: smaller teams');
  });

  it('the values are bounded and a reason is required', async () => {
    for (const bad of [{ smallCountThreshold: 0 }, { smallCountThreshold: 101 }, { recentActivityDays: 0 }, { salaryProgressionYears: 21 }]) {
      expect((await h.call(hr, 'POST', '/v1/reporting-settings', revision(addDays(today, 40), bad))).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect((await h.call(hr, 'POST', '/v1/reporting-settings', { ...revision(addDays(today, 40)), reason: '   ' })).statusCode).toBe(400);
  });

  it('only a holder of reporting_setting.manage reads or changes them', async () => {
    for (const role of ['RECRUITER', 'TRAINING_COORDINATOR', 'AUDITOR', 'SYSTEM_ADMINISTRATOR']) {
      const a = await h.actor(c, role);
      expect((await h.call(a, 'GET', '/v1/reporting-settings')).statusCode, role).toBe(403);
      expect((await h.call(a, 'POST', '/v1/reporting-settings', revision(addDays(today, 60)))).statusCode, role).toBe(403);
    }
    const denied = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and action = 'ACCESS_DENIED' and resource_code = 'reporting_setting'`, [c.id]);
    expect(denied.n).toBeGreaterThanOrEqual(8);
  });

  it('the database keeps every revision as written: values never change, an end date stays, nothing is deleted or overlaps', async () => {
    const first = await h.one<{ id: string }>(`select id from reporting_setting where company_id = $1 and effective_from = '2000-01-01'`, [c.id]);
    await expect(h.db.query(`update reporting_setting set small_count_threshold = 1 where id = $1`, [first.id])).rejects.toThrow(/fixed/);
    await expect(h.db.query(`update reporting_setting set effective_to = effective_to + 1 where id = $1`, [first.id])).rejects.toThrow(/fixed/);
    await expect(h.db.query(`delete from reporting_setting where id = $1`, [first.id])).rejects.toThrow(/kept/);
    await expect(
      h.db.query(`insert into reporting_setting (company_id, effective_from, small_count_threshold, recent_activity_days, salary_progression_years, reason, created_by) values ($1, '2001-01-01', 1, 1, 1, 'x', $2)`, [c.id, hr.user]),
    ).rejects.toThrow(/reporting_setting_company_id_daterange_excl|conflicting key/);
  });
});

describe('BR-045 small-count rule (I-83 item 4)', () => {
  it('every dashboard metric says what it counts, so none can skip the rule unnoticed', () => {
    expect(Object.keys(METRICS).filter((code) => !METRIC_SUBJECTS[code])).toEqual([]);
    expect(Object.keys(METRIC_SUBJECTS).filter((code) => !METRICS[code])).toEqual([]);
  });

  it('hides 1 to N - 1, shows 0 and N upwards, hides a whole "a/b" figure when any part is small, and fails closed without a threshold', () => {
    const ok = (value: number | string) => ({ status: 'OK' as const, value });
    expect(suppressSmallCount(ok(0), 5)).toEqual(ok(0));
    expect(suppressSmallCount(ok(1), 5)).toEqual({ status: 'SUPPRESSED', threshold: 5 });
    expect(suppressSmallCount(ok(4), 5)).toEqual({ status: 'SUPPRESSED', threshold: 5 });
    expect(suppressSmallCount(ok(5), 5)).toEqual(ok(5));
    expect(suppressSmallCount(ok('7/0'), 5)).toEqual(ok('7/0'));
    expect(suppressSmallCount(ok('7/2'), 5)).toEqual({ status: 'SUPPRESSED', threshold: 5 });
    expect(suppressSmallCount(ok(1), 1)).toEqual(ok(1));
    expect(suppressSmallCount(ok(3), null)).toMatchObject({ status: 'NOT_CONFIGURED' });
    expect(suppressSmallCount({ status: 'NOT_AVAILABLE' }, 5)).toEqual({ status: 'NOT_AVAILABLE' });
  });
});

describe('DF17 recent operational activity (I-62 item 5; I-83 item 5)', () => {
  it('lists what the selected assignment itself did in the window, newest first: what and when, never values, reasons or other assignments', async () => {
    const c = await h.makeCompany();
    const hr = await h.actor(c, 'HR_ADMINISTRATOR');
    const today = await businessDate(c);
    const otherHr = await h.actor(c, 'HR_ADMINISTRATOR');
    expect((await h.call(hr, 'POST', '/v1/reporting-settings', { ...revision(addDays(today, 3)), reason: 'Synthetic activity reason' })).statusCode).toBe(201);
    expect((await h.call(otherHr, 'POST', '/v1/reporting-settings', revision(addDays(today, 6)))).statusCode).toBe(201);
    // The same person's other assignment, an old action and a refusal are not this assignment's recent activity.
    const sameUserEmployee = await h.actor(c, 'EMPLOYEE', { user: hr.user });
    await h.db.query(
      `insert into audit_event (company_id, resource_code, record_key, actor_user_id, acting_assignment_id, action, occurred_at, after_values, created_by, updated_by)
       values ($1, 'employee', gen_random_uuid(), $2, $3, 'CREATE', now() - interval '20 days', '{}'::jsonb, $2, $2)`,
      [c.id, hr.user, hr.assignment],
    );
    expect((await h.call(hr, 'GET', '/v1/salary-master')).statusCode).toBe(403);

    const res = await h.call(hr, 'GET', '/v1/dashboard/activity');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: 'OK', days: 14, total: 2 });
    // Both writes of one revision share their transaction's time, so their order between themselves is not fixed.
    expect([...res.json().items].sort((a: { action: string }, b: { action: string }) => a.action.localeCompare(b.action))).toEqual([
      { action: 'CREATE', resource: 'reporting_setting', occurredAt: expect.any(String) },
      { action: 'UPDATE', resource: 'reporting_setting', occurredAt: expect.any(String) },
    ]);
    expect(res.body).not.toContain('Synthetic activity reason');
    expect((await h.call(sameUserEmployee, 'GET', '/v1/dashboard/activity')).json()).toMatchObject({ total: 0, items: [] });
    // Another HR assignment's work is its own.
    expect((await h.call(otherHr, 'GET', '/v1/dashboard/activity')).json().total).toBe(2);
  });

  it('follows the dated window HR sets', async () => {
    const c = await h.makeCompany();
    const hr = await h.actor(c, 'HR_ADMINISTRATOR');
    const today = await businessDate(c);
    await h.db.query(
      `insert into audit_event (company_id, resource_code, record_key, actor_user_id, acting_assignment_id, action, occurred_at, after_values, created_by, updated_by)
       values ($1, 'employee', gen_random_uuid(), $2, $3, 'CREATE', now() - interval '20 days', '{}'::jsonb, $2, $2)`,
      [c.id, hr.user, hr.assignment],
    );
    expect((await h.call(hr, 'GET', '/v1/dashboard/activity')).json().total).toBe(0);
    expect((await h.call(hr, 'POST', '/v1/reporting-settings', revision(today, { recentActivityDays: 30 }))).statusCode).toBe(201);
    const wide = (await h.call(hr, 'GET', '/v1/dashboard/activity')).json();
    expect(wide).toMatchObject({ days: 30, total: 3 });
    expect(wide.items.at(-1)).toMatchObject({ action: 'CREATE', resource: 'employee' });
  });
});

describe('FR-038 salary progression chart (I-48 item 11; I-83 item 6; BR-044; C7)', () => {
  let c: Company;
  let hr: TestActor;
  let salaryHr: TestActor;
  let p: string;
  let q: string;
  let boss: string;
  let fy: number;
  const READ_HISTORY = ['salary.read.salary', 'salary.history_read.salary'] as const;

  const arrangement = (employee: string, from: string, to: string | null, monthly: string, annual: string, currency = 'INR') =>
    h.db.query(
      `insert into salary_arrangement (company_id, employee_id, effective_from, effective_to, annual_ctc, monthly_gross, currency_code, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [c.id, employee, from, to, annual, monthly, currency, hr.user],
    );
  const chart = (a: TestActor, employee: string, query = '') => h.call(a, 'GET', `/v1/employees/${employee}/salary-progression${query}`);

  beforeAll(async () => {
    c = await h.makeCompany();
    hr = await h.actor(c, 'HR_ADMINISTRATOR');
    salaryHr = await h.actor(c, 'HR_ADMINISTRATOR', { extra: [...READ_HISTORY] });
    fy = financialYearOf(await businessDate(c));
    const employee = async (joiningDate: string) => {
      const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(c, { joiningDate }));
      expect(res.statusCode, res.body).toBe(201);
      await h.setStatus(c, res.json().id, 'ACTIVE_CONFIRMED');
      return res.json().id as string;
    };
    boss = await employee(`${fy - 6}-04-01`);
    p = await employee(`${fy - 5}-04-01`);
    q = await employee(`${fy - 2}-04-01`);
    const managed = await h.call(hr, 'POST', `/v1/employees/${p}/manager`, { managerEmployeeId: boss, effectiveFrom: `${fy - 5}-04-01` });
    expect(managed.statusCode, managed.body).toBeLessThan(300);
    // P: 40,000 -> 44,000 (from October of FY-4) -> 48,400 (from July of FY-2). Q: INR, then paid in another currency.
    await arrangement(p, `${fy - 5}-04-01`, `${fy - 4}-10-01`, '40000', '500000');
    await arrangement(p, `${fy - 4}-10-01`, `${fy - 2}-07-01`, '44000', '560000');
    await arrangement(p, `${fy - 2}-07-01`, null, '48400', '616000');
    await arrangement(q, `${fy - 2}-04-01`, `${fy - 1}-06-01`, '30000', '360000');
    await arrangement(q, `${fy - 1}-06-01`, null, '400', '4800', 'USD');
  });

  it('by financial year over the default 5-year span: the value in force at each year end (today for this year), its change in the same currency, and the step line as stored', async () => {
    const res = await chart(salaryHr, p);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ employeeId: p, basis: 'MONTHLY_GROSS', span: { years: 5, firstFinancialYear: fy - 4, lastFinancialYear: fy, from: `${fy - 4}-04-01` } });
    expect(body.years.map((y: { financialYear: number; amount: string; changePercent: string | null; percentNaReason: string | null }) => [y.financialYear, y.amount, y.changePercent, y.percentNaReason])).toEqual([
      [fy - 4, '44000.0000', '10.00', null],
      [fy - 3, '44000.0000', '0.00', null],
      [fy - 2, '48400.0000', '10.00', null],
      [fy - 1, '48400.0000', '0.00', null],
      [fy, '48400.0000', '0.00', null],
    ]);
    expect(body.years[0]).toMatchObject({ label: `${fy - 4}-${String((fy - 3) % 100).padStart(2, '0')}`, periodStart: `${fy - 4}-04-01`, valueDate: `${fy - 3}-03-31`, currency: 'INR' });
    expect(body.years.at(-1).valueDate).toBe(await businessDate(c));
    expect(body.steps.map((s: { effectiveFrom: string; amount: string }) => [s.effectiveFrom, s.amount])).toEqual([
      [`${fy - 5}-04-01`, '40000.0000'],
      [`${fy - 4}-10-01`, '44000.0000'],
      [`${fy - 2}-07-01`, '48400.0000'],
    ]);
  });

  it('annual CTC on request, and a span of 1 to 20 years', async () => {
    const ctc = (await chart(salaryHr, p, '?basis=ANNUAL_CTC&years=3')).json();
    expect(ctc.years.map((y: { amount: string; changePercent: string | null }) => [y.amount, y.changePercent])).toEqual([
      ['616000.0000', '10.00'],
      ['616000.0000', '0.00'],
      ['616000.0000', '0.00'],
    ]);
    expect((await chart(salaryHr, p, '?years=0')).statusCode).toBe(400);
    expect((await chart(salaryHr, p, '?years=21')).statusCode).toBe(400);
    expect((await chart(salaryHr, p, '?basis=NET')).statusCode).toBe(400);
  });

  it('never compares across currencies or with a year without salary: each such change says why', async () => {
    const body = (await chart(salaryHr, q, '?years=4')).json();
    expect(body.years.map((y: { amount: string | null; currency: string | null; changePercent: string | null; percentNaReason: string | null }) => [y.amount, y.currency, y.changePercent, y.percentNaReason])).toEqual([
      [null, null, null, 'NO_SALARY'],
      ['30000.0000', 'INR', null, 'NO_PREVIOUS_SALARY'],
      ['400.0000', 'USD', null, 'CURRENCY_CHANGED'],
      ['400.0000', 'USD', '0.00', null],
    ]);
  });

  it('the default span is the dated setting HR changes', async () => {
    const today = await businessDate(c);
    expect((await h.call(hr, 'POST', '/v1/reporting-settings', revision(today, { salaryProgressionYears: 3 }))).statusCode).toBe(201);
    expect((await chart(salaryHr, p)).json().span).toMatchObject({ years: 3, firstFinancialYear: fy - 2 });
  });

  it('confidential: only one eligible assignment holding salary read, salary history and the employee in its row scope sees it; every refusal names no amount', async () => {
    const refusedWith = async (a: TestActor, employee: string, status: number) => {
      const res = await chart(a, employee);
      expect(res.statusCode, res.body).toBe(status);
      expect(res.body).not.toMatch(/48400|44000|616000/);
    };
    // Each grant alone, the plain HR assignment, the operational roles and the employee's own context.
    await refusedWith(await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['salary.read.salary'] }), p, 403);
    await refusedWith(await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['salary.history_read.salary'] }), p, 403);
    await refusedWith(hr, p, 403);
    for (const role of ['FINANCE_REVIEWER', 'PAYROLL_OPERATOR', 'TREASURY_APPROVER', 'EXPENSE_FINANCE_APPROVER', 'AUDITOR']) await refusedWith(await h.actor(c, role), p, 403);
    await refusedWith(await h.actor(c, 'EMPLOYEE', { employeeId: p }), p, 403);
    // One assignment cannot borrow the other grant from the same person's second assignment.
    const split = await h.actor(c, 'HR_ADMINISTRATOR', { extra: ['salary.read.salary'] });
    await h.actor(c, 'HR_ADMINISTRATOR', { user: split.user, extra: ['salary.history_read.salary'] });
    await refusedWith(split, p, 403);
    // A Reporting Manager with both grants: the direct report only. An HR assignment filtered to another department: nobody here.
    const manager = await h.actor(c, 'REPORTING_MANAGER', { employeeId: boss, extra: [...READ_HISTORY] });
    expect((await chart(manager, p)).statusCode).toBe(200);
    await refusedWith(manager, q, 404);
    await refusedWith(await h.actor(c, 'HR_ADMINISTRATOR', { extra: [...READ_HISTORY], departmentFilter: c.financeDept }), p, 404);
    // The refusals are audited against the permission that was missing.
    const denials = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and action = 'ACCESS_DENIED' and resource_code = 'salary'`, [c.id]);
    expect(denials.n).toBeGreaterThanOrEqual(9);
  });
});
