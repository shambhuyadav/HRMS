// F2 role dashboards of wave-2 roles (FR-096, FR-097; BR-045; DF17; CI23; ZT28; F2 "Recruiter", "Training
// Coordinator", Employee "Own training/tasks due", and the financial, appraisal and audit roles): each widget comes
// from its module's metrics, within the assignment's scope, and a metric that is not built (or whose source the role
// cannot read) is shown as unavailable, never as zero. Financial dashboards show counts and states only. Synthetic
// data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { BASELINE_ROLES } from '../access/baseline.js';
import { CONFIGURATION_RESOURCES } from '../audit-trail/metrics.js';
import { CONFIG, calendar, months, today } from '../payroll/payroll.fixtures.js';
import { BASELINE_DASHBOARDS, dashboardFor, METRICS } from './service.js';

let h: Harness;
let A: Company;

type Widget = { code: string; title: string; kind: string; status: string; value?: unknown; message?: string };
const dashboardOf = async (a: TestActor) => {
  const res = await h.call(a, 'GET', '/v1/dashboard');
  expect(res.statusCode).toBe(200);
  const d = res.json() as { title: string; state: string; widgets: Widget[] };
  return { ...d, byCode: Object.fromEntries(d.widgets.map((w) => [w.code, w])) as Record<string, Widget> };
};
const dashboard = async (roleCode: string, company: Company = A) => dashboardOf(await h.actor(company, roleCode));

/** The role's full catalogue is shown (nothing omitted) under its title, and nothing reads as an amount. */
function expectCatalogue(d: Awaited<ReturnType<typeof dashboard>>, role: string) {
  expect(d).toMatchObject({ title: BASELINE_DASHBOARDS[role]!.title, state: 'OK' });
  expect(d.widgets.map((w) => w.code)).toEqual(BASELINE_DASHBOARDS[role]!.widgets.map((w) => w.code));
  for (const w of d.widgets) {
    if (w.status === 'OK') expect(String(w.value), `${role}.${w.code}`).toMatch(/^(\d+|\d+\/\d+|[A-Z_]+)$/);
    else expect(w, `${role}.${w.code}`).not.toHaveProperty('value');
  }
}

const FINANCIAL_ROLES = ['PAYROLL_OPERATOR', 'PAYROLL_APPROVER', 'FINANCE_REVIEWER', 'EXPENSE_FINANCE_APPROVER', 'TREASURY_OPERATOR', 'TREASURY_APPROVER'];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
});

afterAll(async () => {
  await h?.stop();
});

describe('F2 dashboards of the wave-2 roles', () => {
  it('every catalogued widget names a metric that exists and a permission the role can hold', () => {
    for (const [role, def] of Object.entries(BASELINE_DASHBOARDS)) {
      const ceiling = BASELINE_ROLES.find((r) => r.code === role)?.ceiling ?? [];
      expect(def.widgets, role).toHaveLength(4);
      for (const w of def.widgets) {
        expect(METRICS[w.metric], `${role}.${w.code} -> ${w.metric}`).toBeTypeOf('function');
        expect(ceiling, `${role}.${w.code} -> ${w.permission}`).toContain(w.permission);
        // F2: financial dashboards never read salary, bank, tax or receipt contents.
        if (FINANCIAL_ROLES.includes(role)) expect(w.permission, `${role}.${w.code}`).toMatch(/\.operational$/);
      }
    }
  });

  it('a fresh company gets every baseline role its F2 catalogue (title, widgets, order)', async () => {
    expect(BASELINE_ROLES.map((r) => r.code).filter((code) => !BASELINE_DASHBOARDS[code])).toEqual([]);
    const rows = (
      await h.db.query<{ role: string; title: string; widget_code: string; metric_code: string }>(
        `select r.code as role, d.title, w.widget_code, w.metric_code from role_dashboard_definition d join role r on r.company_id = d.company_id and r.id = d.role_id
           join role_dashboard_widget w on w.company_id = d.company_id and w.dashboard_id = d.id
          where d.company_id = $1 and d.dashboard_code = 'HOME' and d.state = 'ACTIVE' order by r.code, w.position`,
        [A.id],
      )
    ).rows;
    for (const role of BASELINE_ROLES) {
      const spec = dashboardFor(role.code, role.name);
      const mine = rows.filter((r) => r.role === role.code);
      expect(mine.map((r) => [r.widget_code, r.metric_code]), role.code).toEqual(spec.widgets.map((w) => [w.code, w.metric]));
      expect(mine[0]?.title, role.code).toBe(spec.title);
    }
  });

  it('Recruiter: approved requisitions, pipeline and offers counted in scope; interview tasks unavailable, not zero', async () => {
    const d = await dashboard('RECRUITER');
    expect(d).toMatchObject({ title: 'Recruitment', state: 'OK' });
    expect(d.byCode.APPROVED_REQUISITIONS).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.PIPELINE).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.INTERVIEWS_DUE).toMatchObject({ status: 'NOT_AVAILABLE' });
    expect(d.byCode.INTERVIEWS_DUE).not.toHaveProperty('value');
  });

  it('Training Coordinator: sessions, confirmations, completion/no-show and pending feedback (counts only)', async () => {
    const d = await dashboard('TRAINING_COORDINATOR');
    expect(d).toMatchObject({ title: 'Training', state: 'OK' });
    expect(d.byCode.SESSIONS).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.CONFIRMED).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.COMPLETION_NO_SHOW).toMatchObject({ status: 'OK', kind: 'STATUS' });
    expect(d.byCode.FEEDBACK_PENDING).toMatchObject({ status: 'OK', value: 0 });
  });

  it('Payroll Operator: open periods, input-validation exceptions and preparation counted; no current period is "not configured"', async () => {
    const d = await dashboard('PAYROLL_OPERATOR');
    expectCatalogue(d, 'PAYROLL_OPERATOR');
    expect(d.title).toBe('Payroll preparation');
    expect(d.byCode.OPEN_PERIODS).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.INPUT_EXCEPTIONS).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.PREPARATION).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.PERIOD_STATE).toMatchObject({ status: 'NOT_CONFIGURED', kind: 'STATUS', message: 'No active payroll period covers today' });
  });

  it('Payroll Approver: review tasks, tasks past the payment date and run exceptions counted; approved/locked needs a current period', async () => {
    const d = await dashboard('PAYROLL_APPROVER');
    expectCatalogue(d, 'PAYROLL_APPROVER');
    expect(d.title).toBe('Payroll approval');
    expect(d.byCode.REVIEW_TASKS).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.OVERDUE_REVIEWS).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.APPROVED_LOCKED).toMatchObject({ status: 'NOT_CONFIGURED', kind: 'STATUS' });
    expect(d.byCode.UNRESOLVED_EXCEPTIONS).toMatchObject({ status: 'OK', value: 0 });
  });

  it('Finance Reviewer: assigned expense review tasks counted; sources outside the role’s grants are unavailable, not zero', async () => {
    const d = await dashboard('FINANCE_REVIEWER');
    expectCatalogue(d, 'FINANCE_REVIEWER');
    expect(d.title).toBe('Financial review');
    expect(d.byCode.EXPENSE_REVIEW_TASKS).toMatchObject({ status: 'OK', value: 0 });
    for (const code of ['RECONCILIATION_TASKS', 'UNRECONCILED_OUTCOMES', 'EXPENSE_STATES']) expect(d.byCode[code], code).toMatchObject({ status: 'NOT_AVAILABLE' });
  });

  it('Expense Finance Approver: final decisions, late/receipt exceptions and returned claims counted; decision due is unavailable', async () => {
    const d = await dashboard('EXPENSE_FINANCE_APPROVER');
    expectCatalogue(d, 'EXPENSE_FINANCE_APPROVER');
    expect(d.title).toBe('Expense final decisions');
    expect(d.byCode.FINAL_DECISIONS).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.LATE_RECEIPT).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.RETURNED).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.DECISIONS_DUE).toMatchObject({ status: 'NOT_AVAILABLE' });
  });

  it('Treasury Approver: independent releases, overdue releases, confirmed/reversed and awaiting outcome counted in scope', async () => {
    const d = await dashboard('TREASURY_APPROVER');
    expectCatalogue(d, 'TREASURY_APPROVER');
    expect(d.title).toBe('Payment release');
    expect(d.byCode.RELEASE_TASKS).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.OVERDUE_RELEASES).toMatchObject({ status: 'OK', value: 0 });
    expect(d.byCode.CONFIRMED_REVERSED).toMatchObject({ status: 'OK', kind: 'STATUS', value: '0/0' });
    expect(d.byCode.AWAITING_OUTCOME).toMatchObject({ status: 'OK', value: 0 });
  });

  it('Appraisal Reviewer: assigned tasks and returned appraisals reconcile with the task and appraisal lists; overdue is unavailable', async () => {
    const reviewer = await h.actor(A, 'APPRAISAL_REVIEWER');
    const d = await dashboardOf(reviewer);
    expectCatalogue(d, 'APPRAISAL_REVIEWER');
    expect(d.title).toBe('Appraisal review');
    expect(d.byCode.SUBMITTED_REVIEWED).toMatchObject({ status: 'OK', kind: 'STATUS', value: '0/0' });
    expect(d.byCode.OVERDUE_REVIEWS).toMatchObject({ status: 'NOT_AVAILABLE' });
    const tasks = await h.call(reviewer, 'GET', '/v1/appraisal-tasks/mine');
    expect(tasks.statusCode).toBe(200);
    expect(d.byCode.ASSIGNED_TASKS).toMatchObject({ status: 'OK', value: tasks.json().items.length });
    const returned = await h.call(reviewer, 'GET', '/v1/appraisals?state=RETURNED');
    expect(returned.statusCode).toBe(200);
    expect(d.byCode.RETURNED).toMatchObject({ status: 'OK', value: returned.json().total });
  });

  it('Auditor: redacted audit, refused-access and configuration revision counts; review evidence tasks unavailable', async () => {
    const d = await dashboard('AUDITOR');
    expectCatalogue(d, 'AUDITOR');
    expect(d.title).toBe('Audit');
    for (const code of ['AUDIT_EVENTS', 'ACCESS_DENIED', 'CONFIG_REVISIONS']) expect(d.byCode[code], code).toMatchObject({ status: 'OK', value: expect.any(Number) });
    expect(d.byCode.REVIEW_EVIDENCE).toMatchObject({ status: 'NOT_AVAILABLE' });
  });
});

describe('F2 counts reconcile with their source lists (BR-045)', () => {
  let B: Company;
  let day: string;

  beforeAll(async () => {
    B = await h.makeCompany();
    day = await today(h, B);
    // Company configuration: an active monthly calendar with the twelve periods of the current year (synthetic).
    const author = await h.actor(B, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const activator = await h.actor(B, 'HR_ADMINISTRATOR', { extra: CONFIG });
    await calendar(h, author, activator, months(Number(day.slice(0, 4))));
  });

  it('Payroll Operator and Approver: open periods and exceptions match the calendar and run lists; the current period has not started', async () => {
    const operator = await h.actor(B, 'PAYROLL_OPERATOR');
    const d = await dashboardOf(operator);
    const calendars = (await h.call(operator, 'GET', '/v1/payroll/calendars')).json().items as { state: string; periods: { id: string; serviceStart: string }[] }[];
    const runs = (await h.call(operator, 'GET', '/v1/payroll/runs')).json().items as { periodId: string; state: string; unresolvedExceptions: number }[];
    const processed = new Set(runs.filter((r) => r.state === 'PROCESSED_LOCKED').map((r) => r.periodId));
    const open = calendars.filter((k) => k.state === 'ACTIVE').flatMap((k) => k.periods.filter((p) => p.serviceStart <= day && !processed.has(p.id)));
    expect(open.length).toBeGreaterThan(0);
    expect(d.byCode.OPEN_PERIODS).toMatchObject({ status: 'OK', value: open.length });
    const unresolved = runs.filter((r) => ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED'].includes(r.state)).reduce((n, r) => n + r.unresolvedExceptions, 0);
    expect(d.byCode.INPUT_EXCEPTIONS).toMatchObject({ status: 'OK', value: unresolved });
    expect(d.byCode.PREPARATION).toMatchObject({ status: 'OK', value: runs.filter((r) => r.state === 'DRAFT' || r.state === 'CALCULATED').length });
    expect(d.byCode.PERIOD_STATE).toMatchObject({ status: 'OK', value: 'NOT_STARTED' });

    const approver = await dashboard('PAYROLL_APPROVER', B);
    expect(approver.byCode.APPROVED_LOCKED).toMatchObject({ status: 'OK', value: '0/0' });
    expect(approver.byCode.UNRESOLVED_EXCEPTIONS).toMatchObject({ status: 'OK', value: unresolved });
  });

  it('Auditor: the month’s audit, refused-access and configuration revision counts match the audit viewer', async () => {
    const auditor = await h.actor(B, 'AUDITOR');
    // A refused request is recorded as an ACCESS_DENIED audit event (the auditor holds no payroll grant).
    expect((await h.call(auditor, 'GET', '/v1/payroll/calendars')).statusCode).toBe(403);
    const d = await dashboardOf(auditor);
    const range = `from=${day.slice(0, 8)}01&to=${day}`;
    const total = async (filter = '') => {
      const res = await h.call(auditor, 'GET', `/v1/audit/events?${range}${filter}&pageSize=1`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json().total as number;
    };
    expect(d.byCode.AUDIT_EVENTS).toMatchObject({ status: 'OK', value: await total() });
    const denied = await total('&action=ACCESS_DENIED');
    expect(denied).toBeGreaterThan(0);
    expect(d.byCode.ACCESS_DENIED).toMatchObject({ status: 'OK', value: denied });
    let revisions = 0;
    for (const resource of CONFIGURATION_RESOURCES) revisions += await total(`&resource=${resource}`);
    expect(revisions).toBeGreaterThan(0);
    expect(d.byCode.CONFIG_REVISIONS).toMatchObject({ status: 'OK', value: revisions });
  });
});
