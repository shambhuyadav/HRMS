// Later-period payroll cases over HTTP: late or amended timesheets (FR-100; DB111; H2; H4; BR-047; BR-048; CI25; CI26; ZT37) and
// arrears cases with the arrear register (FR-035; DF05; DF15), under the active valuation policy of this company (I-79, decided under
// owner delegation, 6 Nov 2026). Each late week here restores one unpaid day of a 31-day March on 30,000: 30,000 / 31 = 967.74. A
// processed run never changes. Without a policy, and payment by a later payroll: adjustments-payroll.api.test.ts and
// arrears-payroll.api.test.ts. Synthetic employees, weeks and amounts only.
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import {
  APPROVE,
  approvedLeave,
  calculate,
  calendar,
  CONFIG,
  createRun,
  grantOf,
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
  trailText,
  valuationPolicy,
} from '../payroll/payroll.fixtures.js';
import { isModuleActive } from '../registry.js';
import { allocate, approvedWeek, decide as decideTimesheet, openWeek, submit as submitTimesheet, taskFor, type TimesheetWorld, timesheetWorld } from '../timesheet/timesheet.fixtures.js';
import { decideAdjustment, openAdjustment, submitAdjustment, updateAdjustment } from './adjustments.js';
import { decideArrears, proposeArrears } from './arrears.js';

const ADJ_MAKER: PermissionKey[] = ['payroll_adjustment.read.amount', 'payroll_adjustment.propose.amount'];
const ADJ_DECIDER: PermissionKey[] = ['payroll_adjustment.read.amount', 'payroll_adjustment.decide.amount'];
const ARR_MAKER: PermissionKey[] = ['payroll_arrears.read.amount', 'payroll_arrears.propose.amount'];
const ARR_DECIDER: PermissionKey[] = ['payroll_arrears.read.amount', 'payroll_arrears.decide.amount'];

interface Adjustment {
  id: string;
  state: string;
  version: number;
  adjustmentKind: string;
  sourceRevision: number;
  previousRecognizedUnits: string | null;
  correctedUnits: string | null;
  deltaAmount: string | null;
  targetRunId: string | null;
  appliedPayrollLineId: string | null;
  followsAdjustmentId: string | null;
  valuationPolicyId: string | null;
  ruleSnapshot: Record<string, unknown>;
  sourceMinutes: number;
  originPaidUnits: string;
  valuation: { status: string; code: string };
}
interface ArrearsCase {
  id: string;
  state: string;
  sourceRevisionId: string;
  periodCode: string;
  followsCaseId: string | null;
  lines: { componentCode: string; amount: string }[];
  totalEntered: string;
  calculation: { status: string };
  replayed?: boolean;
}

describe.runIf(isModuleActive('payroll-adjustments'))('later-period payroll cases (FR-035, FR-100, DB111)', () => {
  let h: Harness;
  let A: Company;
  let w: TimesheetWorld;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let runReviewer: TestActor;
  let runApprover: TestActor;
  let processor: TestActor;
  let maker: TestActor;
  let decider: TestActor;
  let periods: Record<string, string>;

  const staff = async () => {
    const dept = (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, 'D' || upper(substr(md5(random()::text), 1, 8)), 'Synthetic', true) returning id`, [A.id])).id;
    const id = await person(h, A, w.hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await ok(await h.call(w.hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: w.managerEmp, effectiveFrom: '2026-01-05' }));
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: id });
    await salary(h, preparer, id, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'HD_ADJ_BASIC', amount: '30000' }] });
    await ok(await allocate(h, w.hr, { employeeId: id, jobId: w.jobId }), 201);
    return { id, actor, dept };
  };
  const line = (workDate: string, minutes = 480) => ({ workDate, jobId: w.jobId, activityId: w.devId, minutes });
  const processed = async (month: string, s: { id: string; dept: string }) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [s.dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer: runReviewer, approver: runApprover }, run.id);
    await processRun(h, processor, run.id);
    return { runId: run.id, recordId: (await record(h, processor, run.id, s.id)).id };
  };
  const open = (a: TestActor, timesheetId: string, originRecordId: string, extra: Record<string, unknown> = {}, revision = 1) =>
    h.call(a, 'POST', '/v1/payroll/adjustments', { timesheetId, revision, originRecordId, ...extra });
  /** A processed March for a fresh employee with Tuesday 10 March unpaid, and the week approved after the freeze with work that day. */
  const lateCase = async () => {
    const s = await staff();
    await approvedLeave(h, A, s.id, 'UNPAID', '2026-03-10', '2026-03-10', '1');
    const { runId, recordId } = await processed('2026-03', s);
    const timesheetId = await approvedWeek(h, w, s.actor, '2026-03-09', [line('2026-03-10')]);
    return { ...s, runId, recordId, timesheetId };
  };
  const adjustmentTask = async (a: TestActor, id: string) =>
    ((await h.call(a, 'GET', '/v1/payroll/adjustments/tasks/mine')).json().items as { taskId: string; adjustment: { id: string } }[]).find((t) => t.adjustment.id === id)?.taskId;
  const arrearsTask = async (a: TestActor, id: string) =>
    ((await h.call(a, 'GET', '/v1/payroll/arrears-cases/tasks/mine')).json().items as { taskId: string; case: { id: string } }[]).find((t) => t.case.id === id)?.taskId;
  const submittedCase = async (explanation = 'Synthetic late week explanation') => {
    const c = await lateCase();
    const a = await ok<Adjustment>(await open(maker, c.timesheetId, c.recordId, { explanation }), 201);
    const s = await ok<Adjustment>(await h.call(maker, 'POST', `/v1/payroll/adjustments/${a.id}/submit`, { expectedVersion: a.version }));
    return { ...c, adjustment: s };
  };
  const decideAdj = async (a: TestActor, id: string, body: Record<string, unknown>) => {
    const taskId = await adjustmentTask(a, id);
    expect(taskId, `task of adjustment ${id}`).toBeDefined();
    return h.call(a, 'POST', `/v1/payroll/adjustment-tasks/${taskId}/decision`, { idempotencyKey: key('adj-'), ...body });
  };
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
  const withdraw = async (a: TestActor, permission: PermissionKey) => {
    const [resource, action, fieldGroup] = permission.split('.');
    await h.db.query(
      `update role_assignment_permission set active = false
        where company_id = $1 and role_assignment_id = $2 and permission_id = (select id from permission where resource = $3 and action = $4 and field_group = $5)`,
      [A.id, a.assignment, resource, action, fieldGroup],
    );
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await timesheetWorld(h, A);
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    runReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    runApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    maker = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(ADJ_MAKER, ARR_MAKER) });
    decider = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(ADJ_DECIDER, ARR_DECIDER) });
    await reviewers(h, w.hr, 'payroll_run', [runReviewer]);
    await reviewers(h, w.hr, 'payroll_run_approval', [runApprover]);
    await reviewers(h, w.hr, 'timesheet_adjustment', [decider]);
    await reviewers(h, w.hr, 'payroll_arrears_case', [decider]);
    await head(h, configA, configB, { code: 'HD_ADJ_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'HD_ADJ_OTHER', headType: 'EARNING', basis: 'FIXED', sequence: 2 });
    // I-79: arrears are approved under an active valuation policy (its effect on payroll: arrears-payroll.api.test.ts).
    await valuationPolicy(h, configA, configB, { prefix: 'HD_ADJ' });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('FR-100 late or amended timesheets', () => {
    it('finds a revision approved after the freeze, and not one approved before it', async () => {
      const s = await staff();
      const before = await approvedWeek(h, w, s.actor, '2026-03-02', [line('2026-03-03')]);
      const { recordId } = await processed('2026-03', s);
      const after = await approvedWeek(h, w, s.actor, '2026-03-09', [line('2026-03-10')]);
      const candidates = (await ok<{ items: { timesheetId: string; originRecordId: string; adjustmentKind: string; originPeriodCode: string }[] }>(await h.call(maker, 'GET', `/v1/payroll/adjustments/candidates?employeeId=${s.id}`))).items;
      expect(candidates).toEqual([expect.objectContaining({ timesheetId: after, originRecordId: recordId, adjustmentKind: 'LATE_TIMESHEET', originPeriodCode: '2026-03' })]);
      // Reading the candidates opens nothing.
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_adjustment where employee_id = $1`, [s.id])).n).toBe(0);
      const refused = await open(maker, before, recordId);
      expect([refused.statusCode, refused.json().error]).toEqual([409, 'TIMESHEET_NOT_LATE']);
      // BR-049 a timesheet that is simply missing creates nothing: April has no sheet and no candidate.
      expect(candidates.some((c) => c.originPeriodCode === '2026-04')).toBe(false);
    });

    it('records source, origin and a snapshot reference, and values the week against the frozen record (BR-048)', async () => {
      const c = await lateCase();
      const a = await ok<Adjustment>(await open(maker, c.timesheetId, c.recordId), 201);
      expect(a).toMatchObject({
        state: 'DRAFT',
        adjustmentKind: 'LATE_TIMESHEET',
        sourceRevision: 1,
        // The week of 9 to 15 March: 6 days paid of 7; the late week records work on the unpaid one.
        previousRecognizedUnits: '6.0000',
        correctedUnits: '7.0000',
        deltaAmount: '967.7400',
        valuationPolicyId: expect.any(String),
        targetRunId: null,
        appliedPayrollLineId: null,
        sourceMinutes: 480,
        valuation: { status: 'CONFIGURED', code: 'ADJUSTMENT_VALUATION_POLICY_ACTIVE' },
      });
      expect(a.ruleSnapshot).toMatchObject({ originRunId: c.runId, periodCode: '2026-03' });
    });

    it('is unique per source revision, origin and kind, even when opened twice at once (ZT37)', async () => {
      const c = await lateCase();
      const both = await Promise.all([open(maker, c.timesheetId, c.recordId), open(maker, c.timesheetId, c.recordId)]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      const refused = both.find((r) => r.statusCode === 409)!;
      expect(refused.json().error).toBe('ADJUSTMENT_EXISTS');
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_adjustment where source_timesheet_id = $1`, [c.timesheetId])).n).toBe(1);
      // The database holds it for any writer.
      await expect(
        h.db.query(
          `insert into payroll_adjustment (company_id, employee_id, source_timesheet_id, source_revision, origin_payroll_record_id, origin_run_id, transaction_id, adjustment_kind, currency_code, rule_snapshot)
           select company_id, employee_id, source_timesheet_id, source_revision, origin_payroll_record_id, origin_run_id, gen_random_uuid(), adjustment_kind, currency_code, rule_snapshot from payroll_adjustment where source_timesheet_id = $1`,
          [c.timesheetId],
        ),
      ).rejects.toThrow(/payroll_adjustment_one_effective/);
    });

    it('refuses what is not an approved revision in force, a processed origin, the same employee or the same dates', async () => {
      const s = await staff();
      const { recordId } = await processed('2026-03', s);
      // A draft revision.
      const week = await openWeek(h, s.actor, '2026-03-16');
      expect((await open(maker, week.id, recordId)).json().error).toBe('SOURCE_NOT_IN_FORCE');
      // Another employee's record reads as missing (CI26).
      const other = await lateCase();
      expect((await open(maker, other.timesheetId, recordId)).statusCode).toBe(404);
      // A week outside the record's period.
      const april = await approvedWeek(h, w, s.actor, '2026-04-06', [line('2026-04-07')]);
      expect((await open(maker, april, recordId)).json().error).toBe('OUTSIDE_ORIGIN_PERIOD');
      // A run that is only calculated.
      const run = await createRun(h, preparer, periods['2026-05']!, { departmentIds: [s.dept] });
      await calculate(h, preparer, run.id);
      const unprocessed = (await record(h, preparer, run.id, s.id)).id;
      const may = await approvedWeek(h, w, s.actor, '2026-05-04', [line('2026-05-05')]);
      expect((await open(maker, may, unprocessed)).json().error).toBe('ORIGIN_NOT_PROCESSED');
      // Unknown source.
      expect((await open(maker, '00000000-0000-4000-8000-000000000000', recordId)).statusCode).toBe(404);
      // The database refuses these for any writer too.
      await expect(
        h.db.query(
          `insert into payroll_adjustment (company_id, employee_id, source_timesheet_id, source_revision, origin_payroll_record_id, origin_run_id, transaction_id, adjustment_kind, currency_code, rule_snapshot)
           values ($1, $2, $3, 1, $4, (select run_id from payroll_record where id = $4), gen_random_uuid(), 'LATE_TIMESHEET', 'INR', '{}')`,
          [A.id, s.id, april, recordId],
        ),
      ).rejects.toThrow(/outside the origin period/);
    });

    it('makes a new case from a reopened revision as AMENDED and retires the revision it replaced', async () => {
      await reviewers(h, w.hr, 'timesheet_reopen', [w.hrReviewer]);
      const c = await lateCase();
      const first = await ok<Adjustment>(await open(maker, c.timesheetId, c.recordId, { explanation: 'Synthetic first case' }), 201);
      const reopen = await ok<{ reopenRequestId: string }>(await h.call(c.actor, 'POST', `/v1/timesheets/${c.timesheetId}/reopen-requests`, { reason: 'Synthetic correction' }), 201);
      const reopenTask = ((await h.call(w.hrReviewer, 'GET', '/v1/timesheet-reopen-tasks')).json().items as { taskId: string; request: { id: string } }[]).find((t) => t.request.id === reopen.reopenRequestId)!.taskId;
      await ok(await h.call(w.hrReviewer, 'POST', `/v1/timesheet-reopen-tasks/${reopenTask}/decision`, { decision: 'APPROVE', idempotencyKey: key('reopen-') }));
      expect((await submitTimesheet(h, c.actor, c.timesheetId)).statusCode).toBe(200);
      await ok(await decideTimesheet(h, w.manager, (await taskFor(h, w.manager, c.timesheetId))!, 'APPROVE'));
      // Revision 2 is in force: the draft on revision 1 can no longer go forward, and revision 2 gets its own case.
      expect((await h.call(maker, 'POST', `/v1/payroll/adjustments/${first.id}/submit`, { expectedVersion: first.version })).json().error).toBe('SOURCE_NOT_IN_FORCE');
      expect((await open(maker, c.timesheetId, c.recordId)).json().error).toBe('SOURCE_NOT_IN_FORCE');
      const amended = await ok<Adjustment>(await open(maker, c.timesheetId, c.recordId, {}, 2), 201);
      expect(amended).toMatchObject({ adjustmentKind: 'AMENDED_TIMESHEET', sourceRevision: 2 });
    });

    it('calculates the figures: those sent must match, never replace them; only the maker changes the draft', async () => {
      const c = await lateCase();
      expect((await open(maker, c.timesheetId, c.recordId, { deltaAmount: '12.345' })).json().error).toBe('INVALID_AMOUNT');
      expect((await open(maker, c.timesheetId, c.recordId, { correctedUnits: '-1' })).json().error).toBe('INVALID_UNITS');
      const entered = await open(maker, c.timesheetId, c.recordId, { deltaAmount: '-250.50', previousRecognizedUnits: '10.5', correctedUnits: '9' });
      expect([entered.statusCode, entered.json().error, entered.json().details?.calculated]).toEqual([
        422,
        'FIGURES_DIFFER',
        { previousRecognizedUnits: '6.0000', correctedUnits: '7.0000', deltaAmount: '967.7400' },
      ]);
      const a = await ok<Adjustment>(await open(maker, c.timesheetId, c.recordId, { deltaAmount: '967.74' }), 201);
      expect(a).toMatchObject({ deltaAmount: '967.7400', previousRecognizedUnits: '6.0000', correctedUnits: '7.0000' });
      const another = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADJ_MAKER });
      expect((await h.call(another, 'PUT', `/v1/payroll/adjustments/${a.id}`, { expectedVersion: a.version, deltaAmount: '1.00' })).json().error).toBe('NOT_MAKER');
      expect((await h.call(another, 'POST', `/v1/payroll/adjustments/${a.id}/submit`, { expectedVersion: a.version })).json().error).toBe('NOT_MAKER');
      // H2 "approves amount and explanation": the explanation may not wait.
      expect((await h.call(maker, 'POST', `/v1/payroll/adjustments/${a.id}/submit`, { expectedVersion: a.version })).json().error).toBe('EXPLANATION_REQUIRED');
      expect((await h.call(maker, 'PUT', `/v1/payroll/adjustments/${a.id}`, { expectedVersion: a.version + 5, explanation: 'x' })).json().error).toBe('STALE_VERSION');
      expect((await h.call(maker, 'PUT', `/v1/payroll/adjustments/${a.id}`, { expectedVersion: a.version, explanation: 'x', deltaAmount: '1.00' })).json().error).toBe('FIGURES_DIFFER');
      const saved = await ok<Adjustment>(await h.call(maker, 'PUT', `/v1/payroll/adjustments/${a.id}`, { expectedVersion: a.version, explanation: 'Synthetic explanation' }));
      expect(saved.deltaAmount).toBe('967.7400');
      const submitted = await ok<Adjustment>(await h.call(maker, 'POST', `/v1/payroll/adjustments/${a.id}/submit`, { expectedVersion: saved.version }));
      expect(submitted).toMatchObject({ state: 'SUBMITTED', deltaAmount: '967.7400' });
      expect((await h.call(maker, 'PUT', `/v1/payroll/adjustments/${a.id}`, { expectedVersion: submitted.version, explanation: 'y' })).json().error).toBe('INVALID_STATE');
      await expect(h.db.query(`update payroll_adjustment set delta_amount = 1 where id = $1`, [a.id])).rejects.toThrow(/immutable/);
      await expect(h.db.query(`update payroll_adjustment set valuation_policy_id = null where id = $1`, [a.id])).rejects.toThrow(/immutable/);
    });

    it('routes to an independent reviewer: not the maker and not the manager who approved the timesheet', async () => {
      const c = await lateCase();
      const both = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(ADJ_MAKER, ADJ_DECIDER) });
      const a = await ok<Adjustment>(await open(both, c.timesheetId, c.recordId, { explanation: 'Synthetic' }), 201);
      await reviewers(h, w.hr, 'timesheet_adjustment', [both]);
      const self = await h.call(both, 'POST', `/v1/payroll/adjustments/${a.id}/submit`, { expectedVersion: a.version });
      await reviewers(h, w.hr, 'timesheet_adjustment', [decider]);
      expect([self.statusCode, self.json().error]).toEqual([422, 'NO_ELIGIBLE_REVIEWER']);
      expect((await h.one<{ state: string }>(`select state from payroll_adjustment where id = $1`, [a.id])).state).toBe('DRAFT');
      const ok1 = await ok<Adjustment>(await h.call(both, 'POST', `/v1/payroll/adjustments/${a.id}/submit`, { expectedVersion: a.version }));
      expect(ok1.state).toBe('SUBMITTED');
      // The approving manager is excluded even when eligible: their user is passed to the engine.
      const approvedBy = await h.one<{ decided_by: string }>(`select decided_by from timesheet_revision where timesheet_id = $1 and revision = 1`, [c.timesheetId]);
      expect(approvedBy.decided_by).toBe(w.manager.user);
      const excluded = await h.one<{ e: string[] }>(`select i.excluded_user_ids as e from approval_instance i where i.transaction_id = (select transaction_id from payroll_adjustment where id = $1)`, [a.id]);
      expect(excluded.e).toEqual(expect.arrayContaining([both.user, w.manager.user]));
    });

    it('approves the calculated amount and explanation; the processed origin and its run stay exactly as they were (BR-047)', async () => {
      const c = await submittedCase();
      const before = await frozen(c.runId);
      const res = await ok<{ state: string; replayed: boolean }>(await decideAdj(decider, c.adjustment.id, { decision: 'APPROVE' }));
      expect(res).toMatchObject({ state: 'APPROVED', replayed: false });
      expect(await adjustmentTask(decider, c.adjustment.id)).toBeUndefined();
      const row = await h.one<{ state: string; decided_by: string | null; target_run_id: string | null; applied_payroll_line_id: string | null }>(`select state, decided_by, target_run_id, applied_payroll_line_id from payroll_adjustment where id = $1`, [c.adjustment.id]);
      // Applied only when a later payroll is processed (adjustments-payroll.api.test.ts).
      expect(row).toEqual({ state: 'APPROVED', decided_by: decider.user, target_run_id: null, applied_payroll_line_id: null });
      expect((await h.one<{ n: number }>(`select count(*)::int as n from approval_decision d join approval_task t on t.id = d.task_id join approval_instance i on i.id = t.instance_id where i.transaction_id = (select transaction_id from payroll_adjustment where id = $1)`, [c.adjustment.id])).n).toBe(1);
      expect(await frozen(c.runId)).toBe(before);
    });

    it('refuses a reviewer linked to the employee after the task reached them', async () => {
      const d = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADJ_DECIDER });
      await reviewers(h, w.hr, 'timesheet_adjustment', [d]);
      const c = await submittedCase();
      await reviewers(h, w.hr, 'timesheet_adjustment', [decider]);
      const taskId = (await adjustmentTask(d, c.adjustment.id))!;
      // A link in the past is enough (C4: whoever is or was the employee).
      await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2025-01-01', '2026-01-01')`, [A.id, d.user, c.id]);
      expect((await h.call(d, 'POST', `/v1/payroll/adjustment-tasks/${taskId}/decision`, { decision: 'REJECT', reason: 'Synthetic', idempotencyKey: key() })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    });

    it('returns or rejects with a reason; each ends the case, and the new one links back', async () => {
      const c = await submittedCase();
      expect((await decideAdj(decider, c.adjustment.id, { decision: 'RETURN' })).json().error).toBe('REASON_REQUIRED');
      const taskId = (await adjustmentTask(decider, c.adjustment.id))!;
      const idempotencyKey = key('adj-replay-');
      const once = await ok<{ state: string; replayed: boolean }>(await h.call(decider, 'POST', `/v1/payroll/adjustment-tasks/${taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic: check the week', idempotencyKey }));
      const twice = await ok<{ state: string; replayed: boolean }>(await h.call(decider, 'POST', `/v1/payroll/adjustment-tasks/${taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic: check the week', idempotencyKey }));
      expect(once).toMatchObject({ state: 'RETURNED', replayed: false });
      expect(twice).toMatchObject({ state: 'RETURNED', replayed: true });
      const next = await ok<Adjustment>(await open(maker, c.timesheetId, c.recordId, { explanation: 'Synthetic second attempt' }), 201);
      expect(next.followsAdjustmentId).toBe(c.adjustment.id);
      const nextSubmitted = await ok<Adjustment>(await h.call(maker, 'POST', `/v1/payroll/adjustments/${next.id}/submit`, { expectedVersion: next.version }));
      await ok(await decideAdj(decider, nextSubmitted.id, { decision: 'REJECT', reason: 'Synthetic: nothing to correct' }));
      const third = await ok<Adjustment>(await open(maker, c.timesheetId, c.recordId), 201);
      expect(third.followsAdjustmentId).toBe(nextSubmitted.id);
      await expect(h.db.query(`update payroll_adjustment set state = 'SUBMITTED' where id = $1`, [nextSubmitted.id])).rejects.toThrow(/cannot become/);
    });

    it('holds DB111 in the database: applied needs one line, the target is set only by application, the origin is never the target, no delete', async () => {
      const c = await submittedCase();
      await expect(h.db.query(`update payroll_adjustment set target_run_id = origin_run_id where id = $1`, [c.adjustment.id])).rejects.toThrow(/set when it is applied/);
      await expect(h.db.query(`update payroll_adjustment set state = 'APPLIED' where id = $1`, [c.adjustment.id])).rejects.toThrow(/cannot become/);
      await expect(h.db.query(`delete from payroll_adjustment where id = $1`, [c.adjustment.id])).rejects.toThrow();
    });

    it('is confidential and never about the own record', async () => {
      const c = await lateCase();
      const payrollOperator = await h.actor(A, 'PAYROLL_OPERATOR');
      for (const a of [payrollOperator, w.hr, c.actor, w.manager]) {
        expect((await h.call(a, 'GET', '/v1/payroll/adjustments')).statusCode).toBe(403);
        expect((await h.call(a, 'GET', '/v1/payroll/adjustments/candidates')).statusCode).toBe(403);
        expect((await open(a, c.timesheetId, c.recordId)).statusCode).toBe(403);
      }
      const own = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADJ_MAKER, user: c.actor.user });
      expect((await open(own, c.timesheetId, c.recordId)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      expect((await ok<{ items: { timesheetId: string }[] }>(await h.call(own, 'GET', '/v1/payroll/adjustments/candidates'))).items.map((x) => x.timesheetId)).not.toContain(c.timesheetId);
      const a = await ok<Adjustment>(await open(maker, c.timesheetId, c.recordId), 201);
      expect((await ok<{ items: { id: string }[] }>(await h.call(own, 'GET', '/v1/payroll/adjustments'))).items.map((x) => x.id)).not.toContain(a.id);
      expect((await h.call(own, 'GET', `/v1/payroll/adjustments/${a.id}`)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      // Row scope: an assignment filtered to another department sees nothing of it.
      const scoped = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADJ_MAKER, departmentFilter: A.financeDept });
      expect((await ok<{ items: { id: string }[] }>(await h.call(scoped, 'GET', '/v1/payroll/adjustments'))).items.map((x) => x.id)).not.toContain(a.id);
      expect((await h.call(scoped, 'GET', `/v1/payroll/adjustments/${a.id}`)).statusCode).toBe(404);
      expect((await open(scoped, c.timesheetId, c.recordId)).statusCode).toBe(404);
      // Another company.
      const B = await h.makeCompany();
      const bMaker = await h.actor(B, 'HR_ADMINISTRATOR', { extra: ADJ_MAKER });
      expect((await h.call(bMaker, 'GET', `/v1/payroll/adjustments/${a.id}`)).statusCode).toBe(404);
    });

    it('shows the employee the linked case on TN13: week, period and state, never figures or notes (H3)', async () => {
      const c = await lateCase();
      const a = await ok<Adjustment>(await open(maker, c.timesheetId, c.recordId, { explanation: 'SECRET-EXPLANATION' }), 201);
      expect(a.deltaAmount).toBe('967.7400');
      expect((await ok<{ items: unknown[] }>(await h.call(c.actor, 'GET', '/v1/me/payroll-adjustments'))).items).toEqual([]);
      await ok(await h.call(maker, 'POST', `/v1/payroll/adjustments/${a.id}/submit`, { expectedVersion: a.version }));
      const res = await h.call(c.actor, 'GET', '/v1/me/payroll-adjustments');
      const items = (await ok<{ items: Record<string, unknown>[] }>(res)).items;
      expect(items).toEqual([{ id: a.id, timesheetId: c.timesheetId, revision: 1, serviceStart: '2026-03-09', serviceEnd: '2026-03-15', originPeriodCode: '2026-03', adjustmentKind: 'LATE_TIMESHEET', state: 'SUBMITTED', submittedAt: expect.any(String) }]);
      expect(res.body).not.toContain('967.74');
      expect(res.body).not.toContain('SECRET-EXPLANATION');
      // Someone else's case is not listed, and another role switches to its Employee context (BR-055).
      expect((await ok<{ items: { id: string }[] }>(await h.call(w.peer, 'GET', '/v1/me/payroll-adjustments'))).items.map((x) => x.id)).not.toContain(a.id);
      expect((await h.call(w.hr, 'GET', '/v1/me/payroll-adjustments')).json().error).toBe('EMPLOYEE_CONTEXT_REQUIRED');
    });

    it('re-checks authority inside each transaction, recording nothing', async () => {
      const c = await lateCase();
      const m = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADJ_MAKER });
      const grant = await grantOf(h, m, 'payroll_adjustment', 'propose', ['amount']);
      const draft = await ok<Adjustment>(await open(m, c.timesheetId, c.recordId, { explanation: 'Synthetic' }), 201);
      await withdraw(m, 'payroll_adjustment.propose.amount');
      const c2 = await lateCase();
      await expect(withTransaction(h.pool, (tx) => openAdjustment(tx, grant, { timesheetId: c2.timesheetId, revision: 1, originRecordId: c2.recordId }))).rejects.toMatchObject({ statusCode: 403 });
      await expect(withTransaction(h.pool, (tx) => updateAdjustment(tx, grant, draft.id, { expectedVersion: draft.version, explanation: 'x' }))).rejects.toMatchObject({ statusCode: 403 });
      await expect(withTransaction(h.pool, (tx) => submitAdjustment(tx, grant, draft.id, { expectedVersion: draft.version }))).rejects.toMatchObject({ statusCode: 403 });
      expect((await h.one<{ state: string; explanation: string }>(`select state, explanation from payroll_adjustment where id = $1`, [draft.id]))).toEqual({ state: 'DRAFT', explanation: 'Synthetic' });

      const d = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ADJ_DECIDER });
      await reviewers(h, w.hr, 'timesheet_adjustment', [d]);
      const sub = await submittedCase();
      await reviewers(h, w.hr, 'timesheet_adjustment', [decider]);
      const taskId = (await adjustmentTask(d, sub.adjustment.id))!;
      const decideGrant = await grantOf(h, d, 'payroll_adjustment', 'decide', ['amount']);
      await withdraw(d, 'payroll_adjustment.decide.amount');
      await expect(withTransaction(h.pool, (tx) => decideAdjustment(tx, decideGrant, taskId, { decision: 'REJECT', reason: 'Synthetic', idempotencyKey: key() }))).rejects.toMatchObject({ statusCode: 403 });
      expect((await h.one<{ state: string }>(`select state from payroll_adjustment where id = $1`, [sub.adjustment.id])).state).toBe('SUBMITTED');
    });

    it('notifies with kind, identity, period and outcome only', async () => {
      const c = await submittedCase('SECRET-CASE-EXPLANATION');
      await ok(await decideAdj(decider, c.adjustment.id, { decision: 'REJECT', reason: 'SECRET-CASE-REASON' }));
      await dispatchOutbox(h.pool, 500);
      const inbox = await h.call(decider, 'GET', '/v1/me/notifications');
      expect(inbox.body).toContain('late-timesheet adjustment');
      const trail = await trailText(h, A.id);
      for (const text of [trail.outbox, trail.notifications, trail.operational]) {
        expect(text).not.toContain('SECRET-CASE');
      }
    });
  });

  describe('FR-035 arrears cases and register', () => {
    /** A processed March from the first salary, then a revision effective inside it, written directly (the increment flow is tested elsewhere). */
    const retroactive = async () => {
      const s = await staff();
      const { runId, recordId } = await processed('2026-03', s);
      const revisionId = await laterArrangement(h, A, s.id, '2026-03-01', '36000', [{ code: 'HD_ADJ_BASIC', amount: '36000' }]);
      return { ...s, runId, recordId, revisionId };
    };
    const propose = (a: TestActor, c: { revisionId: string; recordId: string }, extra: Record<string, unknown> = {}) =>
      h.call(a, 'POST', '/v1/payroll/arrears-cases', {
        sourceRevisionId: c.revisionId,
        originRecordId: c.recordId,
        reason: 'Synthetic retroactive revision',
        idempotencyKey: key('arr-'),
        lines: [{ componentCode: 'HD_ADJ_BASIC', amount: '6000.00' }],
        ...extra,
      });
    const decideCase = async (a: TestActor, id: string, body: Record<string, unknown>) => {
      const taskId = await arrearsTask(a, id);
      expect(taskId, `task of arrears case ${id}`).toBeDefined();
      return h.call(a, 'POST', `/v1/payroll/arrears-tasks/${taskId}/decision`, { idempotencyKey: key('arr-'), ...body });
    };

    it('lists the retroactive revision of a processed period, without computing a difference', async () => {
      const c = await retroactive();
      const items = (await ok<{ items: Record<string, unknown>[] }>(await h.call(maker, 'GET', `/v1/payroll/arrears-cases/candidates?employeeId=${c.id}`))).items;
      expect(items).toEqual([expect.objectContaining({ sourceRevisionId: c.revisionId, originRecordId: c.recordId, periodCode: '2026-03', currencyCode: 'INR' })]);
      expect(JSON.stringify(items)).not.toMatch(/6000|36000|amount|difference/i);
    });

    it('FR-035: calculates component and month detail, refuses amounts that differ from it, and names source revision and period in the register', async () => {
      const c = await retroactive();
      // 30,000 to 36,000 over all of March, every day paid: 6,000 x 31 / 31.
      const differs = await propose(maker, c, { lines: [{ componentCode: 'HD_ADJ_BASIC', amount: '5000.00' }, { componentCode: 'HD_ADJ_OTHER', amount: '1000.25' }] });
      expect(differs.statusCode).toBe(422);
      expect(differs.json()).toMatchObject({ error: 'ARREARS_LINES_DIFFER', details: { calculated: [{ componentCode: 'HD_ADJ_BASIC', amount: '6000.0000' }] } });
      const created = await ok<ArrearsCase>(await propose(maker, c, { lines: undefined }), 201);
      expect(created).toMatchObject({
        state: 'SUBMITTED',
        sourceRevisionId: c.revisionId,
        periodCode: '2026-03',
        lines: [{ componentCode: 'HD_ADJ_BASIC', amount: '6000.0000' }],
        totalEntered: '6000.0000',
        calculation: { status: 'CALCULATED' },
      });
      const register = await ok<{ items: { id: string; sourceRevisionId: string; sourceEffectiveFrom: string; periodCode: string; serviceStart: string; serviceEnd: string }[]; calculation: { status: string } }>(await h.call(maker, 'GET', `/v1/payroll/arrears-cases?employeeId=${c.id}`));
      expect(register.calculation.status).toBe('CALCULATED');
      expect(register.items).toEqual([expect.objectContaining({ id: created.id, sourceRevisionId: c.revisionId, sourceEffectiveFrom: '2026-03-01', periodCode: '2026-03', serviceStart: '2026-03-01', serviceEnd: '2026-03-31' })]);
    });

    it('raises one case per employee, revision and period: rerunning the revision pays nothing twice', async () => {
      const c = await retroactive();
      const body = { idempotencyKey: key('arr-same-') };
      const first = await ok<ArrearsCase>(await propose(maker, c, body), 201);
      // The same submission is the same case.
      expect(await ok<ArrearsCase>(await propose(maker, c, body))).toMatchObject({ id: first.id, replayed: true });
      const another = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_MAKER });
      expect((await propose(another, c, body)).json().error).toBe('IDEMPOTENCY_KEY_REUSED');
      const again = await propose(maker, c);
      expect([again.statusCode, again.json().error]).toEqual([409, 'ARREARS_CASE_EXISTS']);
      expect(again.json().details.caseId).toBe(first.id);
      // Twice at once, for a revision with no case yet.
      const c2 = await retroactive();
      const both = await Promise.all([propose(maker, c2), propose(maker, c2)]);
      expect(both.map((r) => r.statusCode).sort()).toEqual([201, 409]);
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_arrears_case where employee_id = $1`, [c2.id])).n).toBe(1);
      // Approved, the key stays taken.
      await ok(await decideCase(decider, first.id, { decision: 'APPROVE' }));
      expect((await propose(maker, c)).json().error).toBe('ARREARS_CASE_EXISTS');
      // The database holds it for any writer.
      await expect(
        h.db.query(
          `insert into payroll_arrears_case (company_id, employee_id, transaction_id, source_arrangement_id, origin_payroll_record_id, origin_run_id, origin_period_id, currency_code, reason, submit_key, state)
           select company_id, employee_id, gen_random_uuid(), source_arrangement_id, origin_payroll_record_id, origin_run_id, origin_period_id, currency_code, reason, 'another-key-1', 'SUBMITTED' from payroll_arrears_case where id = $1`,
          [first.id],
        ),
      ).rejects.toThrow(/payroll_arrears_one_live/);
    });

    it('takes only a real retroactive revision and processed origin, in the record\'s currency unit', async () => {
      const s = await staff();
      const { recordId } = await processed('2026-03', s);
      const original = await h.one<{ id: string }>(`select id from salary_arrangement where company_id = $1 and employee_id = $2`, [A.id, s.id]);
      // The revision the record was calculated from leaves no difference.
      expect((await propose(maker, { revisionId: original.id, recordId })).json().error).toBe('REVISION_ALREADY_CALCULATED');
      // A revision effective after the period does not reach it.
      const later = await laterArrangement(h, A, s.id, '2026-04-01', '36000', [{ code: 'HD_ADJ_BASIC', amount: '36000' }]);
      expect((await propose(maker, { revisionId: later, recordId })).json().error).toBe('REVISION_NOT_IN_PERIOD');
      // Another employee's revision reads as missing.
      const other = await retroactive();
      expect((await propose(maker, { revisionId: other.revisionId, recordId })).statusCode).toBe(404);
      // A run that is only calculated.
      const c = await retroactive();
      const run = await createRun(h, preparer, periods['2026-05']!, { departmentIds: [c.dept] });
      await calculate(h, preparer, run.id);
      expect((await propose(maker, { revisionId: c.revisionId, recordId: (await record(h, preparer, run.id, c.id)).id })).json().error).toBe('ORIGIN_NOT_PROCESSED');
      // Lines sent are a check on the calculation (I-79): anything else is refused, and an amount below the currency unit is invalid.
      expect((await propose(maker, c, { lines: [{ componentCode: 'NOT_A_HEAD', amount: '6000.00' }] })).json().error).toBe('ARREARS_LINES_DIFFER');
      expect((await propose(maker, c, { lines: [{ componentCode: 'HD_ADJ_BASIC', amount: '3000.00' }, { componentCode: 'HD_ADJ_BASIC', amount: '3000.00' }] })).json().error).toBe('ARREARS_LINES_DIFFER');
      expect((await propose(maker, c, { lines: [{ componentCode: 'HD_ADJ_BASIC', amount: '0.00' }] })).json().error).toBe('ARREARS_LINES_DIFFER');
      expect((await propose(maker, c, { lines: [{ componentCode: 'HD_ADJ_BASIC', amount: '1.234' }] })).json().error).toBe('INVALID_AMOUNT');
      // A corrected revision is out of the chain.
      await h.db.query(`update salary_arrangement set superseded_at = now(), effective_to = effective_from where id = $1`, [c.revisionId]);
      expect((await propose(maker, c)).json().error).toBe('SOURCE_SUPERSEDED');
    });

    it('is decided independently; approval changes nothing but the case, and a superseded source is refused then too', async () => {
      const c = await retroactive();
      const a = await ok<ArrearsCase>(await propose(maker, c), 201);
      // The maker is never routed the task: alone on the list, the proposal is refused whole.
      const both = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(ARR_MAKER, ARR_DECIDER) });
      await reviewers(h, w.hr, 'payroll_arrears_case', [both]);
      const c2 = await retroactive();
      const self = await propose(both, c2);
      await reviewers(h, w.hr, 'payroll_arrears_case', [decider]);
      expect([self.statusCode, self.json().error]).toEqual([422, 'NO_ELIGIBLE_REVIEWER']);
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_arrears_case where employee_id = $1`, [c2.id])).n).toBe(0);
      expect((await decideCase(decider, a.id, { decision: 'RETURN' })).json().error).toBe('REASON_REQUIRED');
      expect((await decideCase(decider, a.id, { decision: 'REJECT' })).json().error).toBe('REASON_REQUIRED');
      const before = await frozen(c.runId);
      const lineCount = async () => (await h.one<{ n: number }>(`select count(*)::int as n from payroll_line where company_id = $1`, [A.id])).n;
      const lines = await lineCount();
      const inputs = (await h.one<{ n: number }>(`select count(*)::int as n from payroll_input where company_id = $1`, [A.id])).n;
      const res = await ok<{ state: string }>(await decideCase(decider, a.id, { decision: 'APPROVE' }));
      expect(res.state).toBe('APPROVED');
      expect(await frozen(c.runId)).toBe(before);
      expect(await lineCount()).toBe(lines);
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_input where company_id = $1`, [A.id])).n).toBe(inputs);
      await expect(h.db.query(`update payroll_arrears_case set state = 'REJECTED' where id = $1`, [a.id])).rejects.toThrow(/final/);
      await expect(h.db.query(`insert into payroll_arrears_line (company_id, case_id, component_id, amount) select company_id, case_id, component_id, 1 from payroll_arrears_line where case_id = $1 limit 1`, [a.id])).rejects.toThrow(/fixed before its decision/);

      const c3 = await retroactive();
      const b = await ok<ArrearsCase>(await propose(maker, c3), 201);
      await h.db.query(`update salary_arrangement set superseded_at = now(), effective_to = effective_from where id = $1`, [c3.revisionId]);
      expect((await decideCase(decider, b.id, { decision: 'APPROVE' })).json().error).toBe('SOURCE_SUPERSEDED');
      expect((await ok<{ state: string }>(await decideCase(decider, b.id, { decision: 'REJECT', reason: 'Synthetic: the revision was corrected' }))).state).toBe('REJECTED');
    });

    it('refuses a reviewer linked to the employee after the task reached them', async () => {
      const c = await retroactive();
      const d = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_DECIDER });
      await reviewers(h, w.hr, 'payroll_arrears_case', [d]);
      const a = await ok<ArrearsCase>(await propose(maker, c), 201);
      await reviewers(h, w.hr, 'payroll_arrears_case', [decider]);
      const taskId = (await arrearsTask(d, a.id))!;
      await h.db.query(`insert into user_employee_link (company_id, user_id, employee_id, effective_from, effective_to) values ($1, $2, $3, '2025-01-01', '2026-01-01')`, [A.id, d.user, c.id]);
      expect((await h.call(d, 'POST', `/v1/payroll/arrears-tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    });

    // A recovery refused for want of a recovery deduction, and recovered through payroll: arrears-payroll.api.test.ts.
    it('calculates a lower revision as a negative arrear, and a returned case frees its key with a link (H2)', async () => {
      const s = await staff();
      const { runId, recordId } = await processed('2026-03', s);
      const lower = await laterArrangement(h, A, s.id, '2026-03-01', '24000', [{ code: 'HD_ADJ_BASIC', amount: '24000' }]);
      const c = { ...s, runId, recordId, revisionId: lower };
      const a = await ok<ArrearsCase>(await propose(maker, c, { lines: undefined }), 201);
      expect(a.lines).toEqual([{ componentCode: 'HD_ADJ_BASIC', amount: '-6000.0000' }]);
      await ok(await decideCase(decider, a.id, { decision: 'RETURN', reason: 'Synthetic: check the revision' }));
      const next = await ok<ArrearsCase>(await propose(maker, c, { lines: undefined }), 201);
      expect(next.followsCaseId).toBe(a.id);
    });

    it('is confidential and never about the own record', async () => {
      const c = await retroactive();
      const payrollOperator = await h.actor(A, 'PAYROLL_OPERATOR');
      for (const a of [payrollOperator, w.hr, c.actor]) {
        expect((await h.call(a, 'GET', '/v1/payroll/arrears-cases')).statusCode).toBe(403);
        expect((await h.call(a, 'GET', '/v1/payroll/arrears-cases/candidates')).statusCode).toBe(403);
        expect((await propose(a, c)).statusCode).toBe(403);
      }
      const own = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_MAKER, user: c.actor.user });
      expect((await propose(own, c)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
      const made = await ok<ArrearsCase>(await propose(maker, c), 201);
      expect((await ok<{ items: { id: string }[] }>(await h.call(own, 'GET', '/v1/payroll/arrears-cases'))).items.map((x) => x.id)).not.toContain(made.id);
      const scoped = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_MAKER, departmentFilter: A.financeDept });
      expect((await ok<{ items: { id: string }[] }>(await h.call(scoped, 'GET', '/v1/payroll/arrears-cases'))).items.map((x) => x.id)).not.toContain(made.id);
      expect((await h.call(scoped, 'GET', `/v1/payroll/arrears-cases/${made.id}`)).statusCode).toBe(404);
    });

    it('re-checks authority inside each transaction, recording nothing', async () => {
      const c = await retroactive();
      const m = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_MAKER });
      const grant = await grantOf(h, m, 'payroll_arrears', 'propose', ['amount']);
      await withdraw(m, 'payroll_arrears.propose.amount');
      const input = { sourceRevisionId: c.revisionId, originRecordId: c.recordId, reason: 'Synthetic', idempotencyKey: key('arr-'), lines: [{ componentCode: 'HD_ADJ_BASIC', amount: '1.00' }] };
      await expect(withTransaction(h.pool, (tx) => proposeArrears(tx, grant, input))).rejects.toMatchObject({ statusCode: 403 });
      expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_arrears_case where employee_id = $1`, [c.id])).n).toBe(0);

      const d = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ARR_DECIDER });
      await reviewers(h, w.hr, 'payroll_arrears_case', [d]);
      const made = await ok<ArrearsCase>(await propose(maker, c), 201);
      await reviewers(h, w.hr, 'payroll_arrears_case', [decider]);
      const taskId = (await arrearsTask(d, made.id))!;
      const decideGrant = await grantOf(h, d, 'payroll_arrears', 'decide', ['amount']);
      await withdraw(d, 'payroll_arrears.decide.amount');
      await expect(withTransaction(h.pool, (tx) => decideArrears(tx, decideGrant, taskId, { decision: 'APPROVE', idempotencyKey: key() }))).rejects.toMatchObject({ statusCode: 403 });
      expect((await h.one<{ state: string }>(`select state from payroll_arrears_case where id = $1`, [made.id])).state).toBe('SUBMITTED');
    });

    it('notifies with no amount or reason', async () => {
      // A revision whose arrear is a figure found nowhere else: 34,242.42 over all of March gives 4,242.42.
      const s = await staff();
      const { runId, recordId } = await processed('2026-03', s);
      const c = { ...s, runId, recordId, revisionId: await laterArrangement(h, A, s.id, '2026-03-01', '34242.42', [{ code: 'HD_ADJ_BASIC', amount: '34242.42' }]) };
      const a = await ok<ArrearsCase>(await propose(maker, c, { reason: 'SECRET-ARREARS-REASON', lines: undefined }), 201);
      expect(a.lines).toEqual([{ componentCode: 'HD_ADJ_BASIC', amount: '4242.4200' }]);
      await ok(await decideCase(decider, a.id, { decision: 'APPROVE' }));
      await dispatchOutbox(h.pool, 500);
      expect((await h.call(decider, 'GET', '/v1/me/notifications')).body).toContain('arrears case');
      const trail = await trailText(h, A.id);
      for (const text of [trail.outbox, trail.notifications, trail.operational]) {
        expect(text).not.toContain('SECRET-ARREARS');
        expect(text).not.toContain('4242.42');
      }
    });
  });

  describe('a processed run never changes; an approved arrear reaches only the next calculation (I-79)', () => {
    it('leaves a processed run as it was, and the next calculation pays the approved arrear once beside its own salary', async () => {
      const c = await submittedCase();
      const revisionId = await laterArrangement(h, A, c.id, '2026-03-01', '36000', [{ code: 'HD_ADJ_BASIC', amount: '36000' }]);
      const before = await frozen(c.runId);
      const netBefore = (await record(h, processor, c.runId, c.id)).net;
      // March paid 30 of its 31 days (10 March unpaid): 6,000 x 30 / 31 = 5,806.45.
      const arrears = await ok<ArrearsCase>(
        await h.call(maker, 'POST', '/v1/payroll/arrears-cases', { sourceRevisionId: revisionId, originRecordId: c.recordId, reason: 'Synthetic', idempotencyKey: key('arr-'), lines: [{ componentCode: 'HD_ADJ_BASIC', amount: '5806.45' }] }),
        201,
      );
      const arrearsTaskId = (await arrearsTask(decider, arrears.id))!;
      await ok(await h.call(decider, 'POST', `/v1/payroll/arrears-tasks/${arrearsTaskId}/decision`, { decision: 'APPROVE', idempotencyKey: key('arr-') }));
      await ok(await decideAdj(decider, c.adjustment.id, { decision: 'REJECT', reason: 'Synthetic' }));
      expect(await frozen(c.runId)).toBe(before);
      expect((await record(h, processor, c.runId, c.id)).net).toBe(netBefore);
      // The next month: its own salary revision, and the approved arrear on the policy's component; the rejected correction never.
      const next = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [c.dept] });
      await calculate(h, preparer, next.id);
      const after = await record(h, preparer, next.id, c.id);
      expect(after.net).toBe('41806.4500');
      const lines = (
        await h.db.query<{ code: string; amount: string }>(
          `select pc.code, l.amount::text from payroll_line l join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id where l.company_id = $1 and l.record_id = $2 order by pc.code`,
          [A.id, after.id],
        )
      ).rows;
      expect(lines).toEqual([
        { code: 'HD_ADJ_ARREARS', amount: '5806.4500' },
        { code: 'HD_ADJ_BASIC', amount: '36000.0000' },
      ]);
    });

    it('the calculation only reads cases; only processing marks an arrear or a timesheet adjustment applied, once each', () => {
      const read = (f: string) => readFileSync(new URL(`../payroll/${f}`, import.meta.url), 'utf8');
      const calculation = read('calculate.ts');
      expect(calculation).not.toMatch(/(update|insert into|delete from) payroll_(arrears_case|arrears_line|adjustment)\b/);
      expect(read('inputs.ts')).not.toMatch(/payroll_adjustment|payroll_arrears/);
      expect(read('runs.ts').match(/update payroll_arrears_case/g)).toHaveLength(1);
      expect(read('runs.ts').match(/update payroll_adjustment/g)).toHaveLength(1);
    });
  });
});
