// Payroll Approver review figures in the ordinary role context (I-83 item 3, decided under owner delegation, 6 Nov 2026; F2; DF17 "no
// merging across role assignments"; I-62 items 4 and 6; FR-096; FR-097; BR-045). The run review and approval decisions are an eligible
// Admin assignment's duties, so the ordinary role's figures are the runs waiting in review, from the run list it reads, whoever holds
// the tasks. Synthetic employees and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { CONFIG, calculate, calendar, createRun, getRun, grants, head, ok, PREPARE, person, REVIEW, reviewers, SALARY, salary } from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';

describe.runIf(isModuleActive('payroll'))('Payroll Approver: runs awaiting review (I-83 item 3; ZT28; FR-096; FR-097)', () => {
  let h: Harness;
  let A: Company;
  let reviewer: TestActor;

  type Widget = { code: string; status: string; value?: number | string; message?: string; source?: { lists: { api: string }[] } };
  const dashboardOf = async (a: TestActor) => {
    const res = await h.call(a, 'GET', '/v1/dashboard');
    expect(res.statusCode, res.body).toBe(200);
    return Object.fromEntries((res.json().widgets as Widget[]).map((w) => [w.code, w])) as Record<string, Widget>;
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    const hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await head(h, configA, configB, { code: 'BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    // January was due to be paid on 5 February; February's payment date is far ahead.
    const { periods } = await calendar(h, configA, configB, [
      { code: '2026-01', start: '2026-01-01', end: '2026-01-31', cutoff: '2026-02-01', payment: '2026-02-05' },
      { code: '2026-02', start: '2026-02-01', end: '2026-02-28' },
    ]);
    const e = await person(h, A, hr, { joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'BASIC', amount: '30000' }] });
    for (const period of [periods['2026-01']!, periods['2026-02']!]) {
      const run = await createRun(h, preparer, period);
      await calculate(h, preparer, run.id);
      await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: (await getRun(h, preparer, run.id)).version }));
      expect((await getRun(h, preparer, run.id)).state).toBe('IN_REVIEW');
    }
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('counts the runs in review and those past their payment date, equal to the run list, whoever holds the review tasks', async () => {
    const other = await h.actor(A, 'PAYROLL_APPROVER');
    const sameUser = await h.actor(A, 'PAYROLL_APPROVER', { user: reviewer.user });
    for (const approver of [other, sameUser]) {
      const byCode = await dashboardOf(approver);
      expect(byCode.REVIEW_TASKS).toMatchObject({ status: 'OK', value: 2, source: { lists: [{ api: '/v1/payroll/runs?states=IN_REVIEW' }] } });
      expect((await h.call(approver, 'GET', byCode.REVIEW_TASKS!.source!.lists[0]!.api)).json().total).toBe(2);
      expect(byCode.OVERDUE_REVIEWS).toMatchObject({ status: 'OK', value: 1 });
    }
    // The review tasks are the Admin assignment's, shown on its own dashboard (DF17 "Admin context").
    expect((await h.call(reviewer, 'GET', '/v1/dashboard')).json().widgets.find((w: Widget) => w.code === 'MY_TASKS')).toMatchObject({ status: 'OK', value: 2 });
  });

  it('a filtered assignment is not given a whole-company count of runs (I-62 item 6)', async () => {
    const filtered = await h.actor(A, 'PAYROLL_APPROVER', { departmentFilter: A.financeDept });
    const byCode = await dashboardOf(filtered);
    for (const code of ['REVIEW_TASKS', 'OVERDUE_REVIEWS', 'UNRESOLVED_EXCEPTIONS']) {
      expect(byCode[code], code).toMatchObject({ status: 'NOT_CONFIGURED', message: 'This count needs an unrestricted company-scope assignment' });
    }
  });
});
