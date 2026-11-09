// FR-100 late-timesheet adjustments are valued and reach payroll (decided under owner delegation, 6 Nov 2026; docs/03 I-79; migrations
// 0205, 0206). Values worked by hand from the rule as written on synthetic salaries of 30,000 in 30-day April: a day the processed
// record left unpaid, on which the approved late week records work, is restored (DAY: 30,000 / 30 = 1,000.00 a day; HOUR at 8 hours a
// day: 30,000 / 30 / 8 = 125.00 an hour, up to a day's hours). Missing time never reduces pay (BR-049). Without a policy a case is held
// and approval is refused (H2). An approved case is paid once by the first later payroll and names its run and line (DB111; ZT37).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
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
import { isModuleActive } from '../registry.js';
import { allocate, approvedWeek, type TimesheetWorld, timesheetWorld } from '../timesheet/timesheet.fixtures.js';

const ADJ_MAKER: PermissionKey[] = ['payroll_adjustment.read.amount', 'payroll_adjustment.propose.amount'];
const ADJ_DECIDER: PermissionKey[] = ['payroll_adjustment.read.amount', 'payroll_adjustment.decide.amount'];

interface Adjustment {
  id: string;
  state: string;
  version: number;
  previousRecognizedUnits: string | null;
  correctedUnits: string | null;
  deltaAmount: string | null;
  valuationPolicyId: string | null;
  targetRunId: string | null;
  targetPeriodCode: string | null;
  appliedPayrollLineId: string | null;
  valuedDays: { day: string; recognized: string; corrected: string }[];
  valuation: { status: string; code: string; timesheetUnit?: string };
}

describe.runIf(isModuleActive('payroll-adjustments'))('late-timesheet adjustments valued and paid (FR-100, ZT37)', () => {
  let h: Harness;
  let A: Company;
  let w: TimesheetWorld;
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

  /** An employee of their own department, on 30,000 of TA_BASIC from 5 January, who records time on the world's job. */
  const staff = async () => {
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'D' || upper(substr(md5(random()::text), 1, 8)), 'Synthetic', true) returning id`, [A.id])).id;
    const id = await person(h, A, w.hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await ok(await h.call(w.hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: w.managerEmp, effectiveFrom: '2026-01-05' }));
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'TA_BASIC', amount: '30000' }] });
    await ok(await allocate(h, w.hr, { employeeId: id, jobId: w.jobId }), 201);
    return { id, actor, dept };
  };
  const line = (workDate: string, minutes = 480) => ({ workDate, jobId: w.jobId, activityId: w.devId, minutes });
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
  /** April processed with approved unpaid leave on `unpaid`, then the week from `week` approved after the freeze with `worked`. */
  const lateApril = async (unpaid: string[], week: string, worked: { day: string; minutes?: number }[]) => {
    const s = await staff();
    for (const d of unpaid) await approvedLeave(h, A, s.id, 'UNPAID', d, d, '1');
    const april = await processed('2026-04', s);
    const timesheetId = await approvedWeek(h, w, s.actor, week, worked.map((x) => line(x.day, x.minutes)));
    return { ...s, ...april, timesheetId };
  };
  const open = (c: { timesheetId: string; recordId: string }, extra: Record<string, unknown> = {}) =>
    h.call(maker, 'POST', '/v1/payroll/adjustments', { timesheetId: c.timesheetId, revision: 1, originRecordId: c.recordId, explanation: 'Synthetic late week', ...extra });
  const submit = async (a: { id: string; version: number }) => ok<Adjustment>(await h.call(maker, 'POST', `/v1/payroll/adjustments/${a.id}/submit`, { expectedVersion: a.version }));
  const taskOf = async (id: string) =>
    ((await h.call(decider, 'GET', '/v1/payroll/adjustments/tasks/mine')).json().items as { taskId: string; adjustment: { id: string } }[]).find((t) => t.adjustment.id === id)?.taskId;
  const decide = async (id: string, body: Record<string, unknown>) => {
    const task = await taskOf(id);
    expect(task, `task of adjustment ${id}`).toBeDefined();
    return h.call(decider, 'POST', `/v1/payroll/adjustment-tasks/${task}/decision`, { idempotencyKey: key('ta-'), ...body });
  };
  const detail = async (id: string) => ok<Adjustment>(await h.call(maker, 'GET', `/v1/payroll/adjustments/${id}`));
  /** Everything a processed run froze, as one hash. */
  const frozen = async (runId: string) =>
    (
      await h.one<{ t: string }>(
        `select md5(string_agg(x, '|' order by x)) as t from (
           select r::text as x from payroll_run r where r.company_id = $1 and r.id = $2
           union all select rec::text from payroll_record rec where rec.company_id = $1 and rec.run_id = $2
           union all select s::text from payroll_record_segment s join payroll_record rec on rec.company_id = s.company_id and rec.id = s.record_id where rec.company_id = $1 and rec.run_id = $2
           union all select l::text from payroll_line l join payroll_record rec on rec.company_id = l.company_id and rec.id = l.record_id where rec.company_id = $1 and rec.run_id = $2
         ) q`,
        [A.id, runId],
      )
    ).t;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await timesheetWorld(h, A);
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADJ_MAKER });
    decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADJ_DECIDER });
    await reviewers(h, w.hr, 'payroll_run', [reviewer]);
    await reviewers(h, w.hr, 'payroll_run_approval', [approver]);
    await reviewers(h, w.hr, 'timesheet_adjustment', [decider]);
    await head(h, configA, configB, { code: 'TA_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  // The order matters: no policy at first, then a DAY policy from January, then an HOUR policy from March that takes over.
  let held: string;
  let heldDraft: Adjustment;

  it('FR-100, H2: without a valuation policy a case is recorded and held unvalued, approval is refused, and the database holds it', async () => {
    const c = await lateApril(['2026-04-14'], '2026-04-13', [{ day: '2026-04-14' }]);
    const before = await frozen(c.runId);
    expect((await open(c, { deltaAmount: '1000.00' })).json()).toMatchObject({ error: 'NOT_CONFIGURED', details: { code: 'ADJUSTMENT_VALUATION_POLICY_NOT_CONFIGURED' } });
    const a = await ok<Adjustment>(await open(c), 201);
    expect(a).toMatchObject({ previousRecognizedUnits: null, correctedUnits: null, deltaAmount: null, valuationPolicyId: null, valuedDays: [], valuation: { status: 'NOT_CONFIGURED' } });
    const s = await submit(a);
    expect(s.state).toBe('SUBMITTED');
    const res = await decide(s.id, { decision: 'APPROVE' });
    expect([res.statusCode, res.json().details?.code]).toEqual([409, 'ADJUSTMENT_VALUATION_POLICY_NOT_CONFIGURED']);
    expect(res.json().message).toContain('adjustment valuation policy');
    expect(await taskOf(s.id)).toBeDefined();
    expect(await h.one(`select state, decided_by, target_run_id, applied_payroll_line_id from payroll_adjustment where id = $1`, [s.id])).toEqual({
      state: 'SUBMITTED',
      decided_by: null,
      target_run_id: null,
      applied_payroll_line_id: null,
    });
    // DB111/0206: an approved case was valued, under a policy, for any writer.
    await expect(h.db.query(`update payroll_adjustment set state = 'APPROVED', decided_at = now(), decided_by = $2 where id = $1`, [s.id, decider.user])).rejects.toThrow(
      /payroll_adjustment_(check\d*|approved_valued)/,
    );
    expect(await frozen(c.runId)).toBe(before);
    held = s.id;
    heldDraft = await ok<Adjustment>(await open(await lateApril(['2026-04-14'], '2026-04-13', [{ day: '2026-04-14' }])), 201);
  });

  it('ZT37, FR-100: two unpaid days on which the late week records work: 2 x 30,000 / 30 = 2,000.00; figures sent are a check, never an entry', async () => {
    const policy = await valuationPolicy(h, configA, configB, { prefix: 'TAD' });
    const c = await lateApril(['2026-04-13', '2026-04-14'], '2026-04-13', [{ day: '2026-04-13' }, { day: '2026-04-14' }, { day: '2026-04-15', minutes: 240 }]);
    const differ = await open(c, { deltaAmount: '2500.00' });
    expect([differ.statusCode, differ.json().error, differ.json().details?.calculated]).toEqual([
      422,
      'FIGURES_DIFFER',
      { previousRecognizedUnits: '5.0000', correctedUnits: '7.0000', deltaAmount: '2000.0000' },
    ]);
    const a = await ok<Adjustment>(await open(c, { deltaAmount: '2000.00', correctedUnits: '7' }), 201);
    expect(a).toMatchObject({ previousRecognizedUnits: '5.0000', correctedUnits: '7.0000', deltaAmount: '2000.0000', valuationPolicyId: policy.id, valuation: { status: 'CONFIGURED', timesheetUnit: 'DAY' } });
    expect(a.valuedDays).toEqual([
      { day: '2026-04-13', recognized: '0.0000', corrected: '1.0000' },
      { day: '2026-04-14', recognized: '0.0000', corrected: '1.0000' },
    ]);
    // BR-049: an unpaid day the week records no work on stays as it was, and a week that records nothing new changes nothing.
    const none = await lateApril(['2026-04-14'], '2026-04-13', [{ day: '2026-04-15' }]);
    expect((await open(none)).json().error).toBe('NO_DIFFERENCE');
    // A draft held without a policy is valued once it is saved under one: one day, 1,000.00.
    const revalued = await ok<Adjustment>(await h.call(maker, 'PUT', `/v1/payroll/adjustments/${heldDraft.id}`, { expectedVersion: heldDraft.version, explanation: 'Synthetic late week' }));
    expect(revalued).toMatchObject({ previousRecognizedUnits: '6.0000', correctedUnits: '7.0000', deltaAmount: '1000.0000', valuationPolicyId: policy.id });
    // A case submitted unvalued is not approved under a policy it was never valued under: it goes back to be opened again.
    const stale = await decide(held, { decision: 'APPROVE' });
    expect([stale.statusCode, stale.json().error]).toEqual([409, 'REVALUATION_REQUIRED']);
  });

  it('FR-100: the first later payroll pays an approved correction once on the policy component, names its run and line, and the origin never changes', async () => {
    const c = await lateApril(['2026-04-13', '2026-04-14'], '2026-04-13', [{ day: '2026-04-13' }, { day: '2026-04-14' }]);
    const before = await frozen(c.runId);
    const a = await submit(await ok<Adjustment>(await open(c), 201));
    expect((await ok<{ state: string }>(await decide(a.id, { decision: 'APPROVE' }))).state).toBe('APPROVED');
    const may = await processed('2026-05', c);
    const paid = await record(h, processor, may.runId, c.id);
    expect(paid.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ componentCode: 'TA_BASIC', amount: '30000.0000' }), expect.objectContaining({ componentCode: 'TAD_LATE', headType: 'EARNING', amount: '2000.0000' })]),
    );
    expect(paid.net).toBe('32000.0000');
    const lineId = (await h.one<{ id: string }>(`select pl.id from payroll_line pl join pay_component pc on pc.id = pl.component_id where pl.record_id = $1 and pc.code = 'TAD_LATE'`, [may.recordId])).id;
    expect(await detail(a.id)).toMatchObject({ state: 'APPLIED', targetRunId: may.runId, targetPeriodCode: '2026-05', appliedPayrollLineId: lineId });
    expect(await frozen(c.runId)).toBe(before);
    const june = await processed('2026-06', c);
    expect((await record(h, processor, june.runId, c.id)).lines.map((l) => l.componentCode)).not.toContain('TAD_LATE');
    // Applied once, for any writer: the target is named by the application and never moves.
    await expect(h.db.query(`update payroll_adjustment set target_run_id = $2 where id = $1`, [a.id, june.runId])).rejects.toThrow(/set when it is applied/);
    // TN13: the employee sees the state, never the amount.
    const own = await h.call(c.actor, 'GET', '/v1/me/payroll-adjustments');
    expect((await ok<{ items: { id: string; state: string }[] }>(own)).items).toEqual([expect.objectContaining({ id: a.id, state: 'APPLIED' })]);
    expect(own.body).not.toContain('2000.0000');
  });

  it('FR-100: a correction approved after the calculation refuses processing; returned, the new revision pays it', async () => {
    const c = await lateApril(['2026-04-14'], '2026-04-13', [{ day: '2026-04-14' }]);
    const mayRun = await calculated('2026-05', c);
    await submitAndApprove(h, team(), mayRun);
    const a = await submit(await ok<Adjustment>(await open(c), 201));
    await ok(await decide(a.id, { decision: 'APPROVE' }));
    const refused = await h.call(processor, 'POST', `/v1/payroll/runs/${mayRun}/process`, { expectedVersion: (await getRun(h, processor, mayRun)).version });
    expect(refused.statusCode, refused.body).toBe(409);
    expect(refused.json()).toMatchObject({ error: 'ADJUSTMENTS_CHANGED', details: { cases: 0, adjustments: 1 } });
    const next = await ok<{ id: string }>(await h.call(processor, 'POST', `/v1/payroll/runs/${mayRun}/return`, { reason: 'Adjustment approved after the calculation (synthetic)', expectedVersion: (await getRun(h, processor, mayRun)).version }), 201);
    await calculate(h, preparer, next.id);
    await submitAndApprove(h, team(), next.id);
    await processRun(h, processor, next.id);
    expect((await record(h, processor, next.id, c.id)).lines).toEqual(expect.arrayContaining([expect.objectContaining({ componentCode: 'TAD_LATE', amount: '1000.0000' })]));
    expect((await detail(a.id)).state).toBe('APPLIED');
  });

  it('FR-100: by the hour at 8 hours a day: 8 h = 1,000.00 and 4 h = 500.00; two weeks of one record are paid on one line, each naming it', async () => {
    await valuationPolicy(h, configA, configB, { prefix: 'TAH', effectiveFrom: '2026-03-01', timesheetUnit: 'HOUR', hoursPerDay: '8' });
    const s = await staff();
    for (const d of ['2026-04-13', '2026-04-20']) await approvedLeave(h, A, s.id, 'UNPAID', d, d, '1');
    const april = await processed('2026-04', s);
    const whole = await approvedWeek(h, w, s.actor, '2026-04-13', [line('2026-04-13', 480)]);
    const half = await approvedWeek(h, w, s.actor, '2026-04-20', [line('2026-04-20', 240)]);
    const first = await ok<Adjustment>(await open({ timesheetId: whole, recordId: april.recordId }), 201);
    const second = await ok<Adjustment>(await open({ timesheetId: half, recordId: april.recordId }), 201);
    expect(first).toMatchObject({ previousRecognizedUnits: '48.0000', correctedUnits: '56.0000', deltaAmount: '1000.0000', valuation: { timesheetUnit: 'HOUR' } });
    expect(second).toMatchObject({ previousRecognizedUnits: '48.0000', correctedUnits: '52.0000', deltaAmount: '500.0000' });
    for (const a of [first, second]) await ok(await decide((await submit(a)).id, { decision: 'APPROVE' }));
    const may = await processed('2026-05', s);
    const paid = await record(h, processor, may.runId, s.id);
    expect(paid.lines).toEqual(expect.arrayContaining([expect.objectContaining({ componentCode: 'TAH_LATE', amount: '1500.0000' })]));
    expect(paid.net).toBe('31500.0000');
    const [x, y] = [await detail(first.id), await detail(second.id)];
    expect([x.state, y.state]).toEqual(['APPLIED', 'APPLIED']);
    expect(x.appliedPayrollLineId).not.toBeNull();
    expect(y.appliedPayrollLineId).toBe(x.appliedPayrollLineId);
  });
});
