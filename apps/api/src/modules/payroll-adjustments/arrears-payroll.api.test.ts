// FR-035 arrears reach payroll (decided under owner delegation, 6 Nov 2026; docs/03 I-79; migration 0205). Values worked by hand from the
// rule as written (DF05: a monthly component x paid calendar days / calendar days of the month) on synthetic salaries: the arrear of a
// revision is calculated, approved under an active valuation policy, and paid once by the first later payroll on the policy's component,
// or recovered on its deduction. ZT16 (owner-approved fixtures): these are the fixtures decided under that delegation.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PermissionKey } from '../access/baseline.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import {
  APPROVE,
  approvedLeave,
  calculate,
  calendar,
  CONFIG,
  createRun,
  getRun,
  grants,
  head,
  key,
  laterArrangement,
  months,
  ok,
  person,
  PREPARE,
  PROCESS,
  processRun,
  record,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
  valuationPolicy,
} from '../payroll/payroll.fixtures.js';

const ARR_MAKER: PermissionKey[] = ['payroll_arrears.read.amount', 'payroll_arrears.propose.amount'];
const ARR_DECIDER: PermissionKey[] = ['payroll_arrears.read.amount', 'payroll_arrears.decide.amount'];

interface ArrearsCase {
  id: string;
  state: string;
  lines: { componentCode: string; amount: string }[];
  appliedRecordId: string | null;
  appliedPeriodCode: string | null;
}

describe.runIf(isModuleActive('payroll-adjustments'))('arrears paid through payroll (FR-035, ZT16)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let maker: TestActor;
  let decider: TestActor;
  let periods: Record<string, string>;
  const team = () => ({ preparer, reviewer, approver });

  /** An employee of their own department on 30,000 of AP_BASIC from 5 January. */
  const staff = async () => {
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'D' || upper(substr(md5(random()::text), 1, 8)), 'Synthetic', true) returning id`, [A.id])).id;
    const id = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'AP_BASIC', amount: '30000' }] });
    return { id, dept };
  };
  const calculated = async (month: string, s: { dept: string }) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [s.dept] });
    await calculate(h, preparer, run.id);
    return run.id;
  };
  const processed = async (month: string, s: { id: string; dept: string }) => {
    const runId = await calculated(month, s);
    await submitAndApprove(h, team(), runId);
    await processRun(h, processor, runId);
    return { runId, recordId: (await record(h, processor, runId, s.id)).id };
  };
  const propose = (originRecordId: string, sourceRevisionId: string) =>
    h.call(maker, 'POST', '/v1/payroll/arrears-cases', { sourceRevisionId, originRecordId, reason: 'Synthetic retroactive revision', idempotencyKey: key('ap-') });
  const decide = async (id: string, body: Record<string, unknown>) => {
    const task = ((await h.call(decider, 'GET', '/v1/payroll/arrears-cases/tasks/mine')).json().items as { taskId: string; case: { id: string } }[]).find((t) => t.case.id === id)?.taskId;
    expect(task, `task of arrears case ${id}`).toBeDefined();
    return h.call(decider, 'POST', `/v1/payroll/arrears-tasks/${task}/decision`, { idempotencyKey: key('ap-'), ...body });
  };
  const caseOf = async (id: string) => ok<ArrearsCase>(await h.call(maker, 'GET', `/v1/payroll/arrears-cases/${id}`));
  /** April processed on 30,000, then a revision to `amount` from `from`. */
  const revisedApril = async (from: string, amount: string, before?: (s: { id: string }) => Promise<void>) => {
    const s = await staff();
    if (before) await before(s);
    const april = await processed('2026-04', s);
    const revision = await laterArrangement(h, A, s.id, from, amount, [{ code: 'AP_BASIC', amount }]);
    return { ...s, ...april, revision };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_MAKER });
    decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_DECIDER });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await reviewers(h, hr, 'payroll_arrears_case', [decider]);
    await head(h, configA, configB, { code: 'AP_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  // The order matters: no policy at first, then one without a recovery deduction, then one with it.
  it('ZT16, FR-035: a revision from the 16th of a 30-day month: 3,000 x 15 / 30 = 1,500.00; with an unpaid day in it, 3,000 x 14 / 30 = 1,400.00', async () => {
    const whole = await revisedApril('2026-04-16', '33000');
    expect((await ok<ArrearsCase>(await propose(whole.recordId, whole.revision), 201)).lines).toEqual([{ componentCode: 'AP_BASIC', amount: '1500.0000' }]);
    // Monday 20 April, approved unpaid leave: one loss-of-pay day inside the revision's part of the month.
    const lop = await revisedApril('2026-04-16', '33000', (s) => approvedLeave(h, A, s.id, 'UNPAID', '2026-04-20', '2026-04-20', '1').then(() => undefined));
    expect((await ok<ArrearsCase>(await propose(lop.recordId, lop.revision), 201)).lines).toEqual([{ componentCode: 'AP_BASIC', amount: '1400.0000' }]);
  });

  it('FR-035: approval needs an active valuation policy, and a recovery needs its deduction (H2)', async () => {
    const up = await revisedApril('2026-04-16', '33000');
    const raised = await ok<ArrearsCase>(await propose(up.recordId, up.revision), 201);
    const none = await decide(raised.id, { decision: 'APPROVE' });
    expect([none.statusCode, none.json().details?.code]).toEqual([409, 'VALUATION_POLICY_NOT_CONFIGURED']);
    await valuationPolicy(h, configA, configB, { prefix: 'APN', recovery: false });
    expect((await ok<{ state: string }>(await decide(raised.id, { decision: 'APPROVE' }))).state).toBe('APPROVED');
    const down = await revisedApril('2026-04-01', '24000');
    const recovery = await ok<ArrearsCase>(await propose(down.recordId, down.revision), 201);
    expect(recovery.lines).toEqual([{ componentCode: 'AP_BASIC', amount: '-6000.0000' }]);
    const refused = await decide(recovery.id, { decision: 'APPROVE' });
    expect([refused.statusCode, refused.json().details?.code]).toEqual([409, 'RECOVERY_POLICY_NOT_CONFIGURED']);
    // From here on the policy in effect names a recovery deduction (a later start date takes over).
    await valuationPolicy(h, configA, configB, { prefix: 'APR', effectiveFrom: '2026-02-01' });
    expect((await ok<{ state: string }>(await decide(recovery.id, { decision: 'APPROVE' }))).state).toBe('APPROVED');
  });

  it('FR-035: the first later payroll pays an approved arrear once on the policy component, the case names it, and the revision is not raised again', async () => {
    const c = await revisedApril('2026-04-16', '33000');
    const raised = await ok<ArrearsCase>(await propose(c.recordId, c.revision), 201);
    await ok(await decide(raised.id, { decision: 'APPROVE' }));
    const may = await processed('2026-05', c);
    const paid = await record(h, processor, may.runId, c.id);
    expect(paid.lines).toEqual(expect.arrayContaining([expect.objectContaining({ componentCode: 'AP_BASIC', amount: '33000.0000' }), expect.objectContaining({ componentCode: 'APR_ARREARS', headType: 'EARNING', amount: '1500.0000' })]));
    expect(paid.net).toBe('34500.0000');
    expect(await caseOf(raised.id)).toMatchObject({ state: 'APPLIED', appliedRecordId: may.recordId, appliedPeriodCode: '2026-05' });
    const june = await processed('2026-06', c);
    expect((await record(h, processor, june.runId, c.id)).lines.map((l) => l.componentCode)).not.toContain('APR_ARREARS');
    expect((await propose(c.recordId, c.revision)).json().error).toBe('ARREARS_CASE_EXISTS');
  });

  it('FR-035: a negative arrear is recovered once on the recovery deduction', async () => {
    const c = await revisedApril('2026-04-01', '24000');
    const raised = await ok<ArrearsCase>(await propose(c.recordId, c.revision), 201);
    await ok(await decide(raised.id, { decision: 'APPROVE' }));
    const may = await processed('2026-05', c);
    const paid = await record(h, processor, may.runId, c.id);
    expect(paid.lines).toEqual(expect.arrayContaining([expect.objectContaining({ componentCode: 'APR_RECOVERY', headType: 'DEDUCTION', amount: '6000.0000' })]));
    expect(paid.net).toBe('18000.0000');
    expect((await caseOf(raised.id)).state).toBe('APPLIED');
  });

  it('FR-035: an arrear approved after the calculation refuses processing; returned, the new revision pays it', async () => {
    const c = await revisedApril('2026-04-16', '33000');
    const mayRun = await calculated('2026-05', c);
    await submitAndApprove(h, team(), mayRun);
    const raised = await ok<ArrearsCase>(await propose(c.recordId, c.revision), 201);
    await ok(await decide(raised.id, { decision: 'APPROVE' }));
    const refused = await h.call(processor, 'POST', `/v1/payroll/runs/${mayRun}/process`, { expectedVersion: (await getRun(h, processor, mayRun)).version });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'ADJUSTMENTS_CHANGED', details: { cases: 1 } });
    const next = await ok<{ id: string }>(await h.call(processor, 'POST', `/v1/payroll/runs/${mayRun}/return`, { reason: 'Arrears approved after the calculation (synthetic)', expectedVersion: (await getRun(h, processor, mayRun)).version }), 201);
    await calculate(h, preparer, next.id);
    await submitAndApprove(h, team(), next.id);
    await processRun(h, processor, next.id);
    expect((await record(h, processor, next.id, c.id)).lines).toEqual(expect.arrayContaining([expect.objectContaining({ componentCode: 'APR_ARREARS', amount: '1500.0000' })]));
    expect((await caseOf(raised.id)).state).toBe('APPLIED');
  });
});
