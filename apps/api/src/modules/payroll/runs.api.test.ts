// Payroll run lifecycle over HTTP (FR-030, FR-033, FR-037 as overridden by FR-099 and H2; BR-012; BR-047; CI25; ZT36;
// DF02; DF03; C4). Synthetic employees, components and amounts only.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { PAYROLL_EVENTS } from './events.js';
import {
  APPROVE,
  approvedLeave,
  attendance,
  bankRevision,
  calculate,
  calendar,
  CANCEL,
  CONFIG,
  createRun,
  getRun,
  grants,
  hasTask,
  head,
  key,
  laterArrangement,
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
  taskOf,
  trailText,
} from './payroll.fixtures.js';

describe.runIf(isModuleActive('payroll'))('payroll runs (FR-030, FR-033, FR-099)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let configA: TestActor;
  let configB: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let approver2: TestActor;
  let processor: TestActor;
  let canceller: TestActor;
  let periods: Record<string, string>;
  const team = () => ({ preparer, reviewer, approver });

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  /** An employee of a department with a monthly BASIC salary from January 2026. */
  const paid = async (dept: string, amount = '30000', extra: { name?: string } = {}) => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05', ...extra });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: amount, components: [{ code: 'BASIC', amount }] });
    return e;
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    // The preparer could review and approve in principle; the engine must still never route their own run to them.
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY, REVIEW, APPROVE) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    approver2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    canceller = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CANCEL });
    await reviewers(h, hr, 'payroll_run', [preparer, reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [preparer, approver, approver2]);
    await head(h, configA, configB, { code: 'BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    await head(h, configA, configB, { code: 'CANTEEN', headType: 'DEDUCTION', basis: 'FIXED', sequence: 2 });
    periods = (
      await calendar(
        h,
        configA,
        configB,
        Array.from({ length: 12 }, (_, i) => {
          const m = String(i + 1).padStart(2, '0');
          const end = new Date(Date.UTC(2026, i + 1, 0)).toISOString().slice(0, 10);
          return { code: `2026-${m}`, start: `2026-${m}-01`, end };
        }),
      )
    ).periods;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('binds a run to the scope the preparer confirmed; filters can never pull anyone else in', async () => {
    const eng = await department('SCOPE_ENG');
    const fin = await department('SCOPE_FIN');
    const e1 = await paid(eng);
    const e2 = await paid(eng);
    const f1 = await paid(fin);
    const period = periods['2026-01']!;
    const preview = await ok<{ scopeToken: string; memberCount: number; members: { employeeId: string }[]; notIncluded: unknown[] }>(
      await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: period, departmentIds: [eng] }),
    );
    expect(preview.members.map((m) => m.employeeId).sort()).toEqual([e1, e2].sort());
    // The token of one scope does not confirm another (a widened filter).
    expect((await h.call(preparer, 'POST', '/v1/payroll/runs', { periodId: period, departmentIds: [eng, fin], scopeToken: preview.scopeToken })).json().error).toBe('SCOPE_CHANGED');
    // A change of membership after the preview is refused too.
    const late = await paid(eng);
    expect((await h.call(preparer, 'POST', '/v1/payroll/runs', { periodId: period, departmentIds: [eng], scopeToken: preview.scopeToken })).json().error).toBe('SCOPE_CHANGED');
    const run = await createRun(h, preparer, period, { departmentIds: [eng] });
    expect(run).toMatchObject({ state: 'DRAFT', revision: 1, members: { included: 3, excluded: 0 } });
    const members = (await h.db.query<{ employee_id: string }>(`select employee_id from payroll_run_member where lineage_id = $1 order by 1`, [run.id])).rows.map((r) => r.employee_id);
    expect(members).toEqual([e1, e2, late].sort());
    // The employees of that run are not in any other run of the month, whatever the calendar or filter.
    const again = await ok<{ members: { employeeId: string }[]; notIncluded: { employeeId: string; reason: string; runId?: string }[] }>(
      await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: period }),
    );
    expect(again.members.map((m) => m.employeeId)).not.toContain(e1);
    expect(again.notIncluded).toEqual(expect.arrayContaining([{ employeeId: e1, employeeCode: expect.any(String), reason: 'IN_ANOTHER_RUN', runId: run.id }]));
    expect(again.members.map((m) => m.employeeId)).toContain(f1);
    // A department-limited preparer only ever sees employees of its scope.
    const finPreparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE, departmentFilter: fin });
    const scoped = await ok<{ members: { employeeId: string }[] }>(await h.call(finPreparer, 'POST', '/v1/payroll/runs/preview', { periodId: period }));
    expect(scoped.members.map((m) => m.employeeId)).toEqual([f1]);
    // The database refuses a second live membership of the month outright.
    const finRun = await createRun(h, preparer, period, { departmentIds: [fin] });
    await expect(h.db.query(`insert into payroll_run_member (company_id, lineage_id, employee_id, service_month) values ($1, $2, $3, '2026-01-01')`, [A.id, finRun.id, e1])).rejects.toThrow(
      /payroll_member_one_live_run/,
    );
    // Members join a run only when it is created; once its calculation has started nobody can be added.
    await calculate(h, preparer, finRun.id);
    await expect(h.db.query(`insert into payroll_run_member (company_id, lineage_id, employee_id, service_month) values ($1, $2, $3, '2026-01-01')`, [A.id, finRun.id, await paid(fin)])).rejects.toThrow(
      /members are confirmed when a run is created/,
    );
  });

  it('takes a run from draft to processed with a distinct preparer, reviewer and approver', async () => {
    const dept = await department('FLOW');
    const e = await paid(dept, '31415.27');
    const run = await createRun(h, preparer, periods['2026-02']!, { departmentIds: [dept] });
    // Not calculated yet: nothing to submit.
    expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: run.version })).json().error).toBe('INVALID_STATE');
    const calculated = await calculate(h, preparer, run.id);
    expect(calculated).toMatchObject({ state: 'CALCULATED', records: { CALCULATED: 1 }, preparedBy: preparer.user });
    // Replaying the calculation returns the same revision unchanged.
    expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/calculate`, { expectedVersion: calculated.version })).json()).toMatchObject({ replayed: true, version: calculated.version });
    // Only the preparer submits.
    const other = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE });
    expect((await h.call(other, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: calculated.version })).json().error).toBe('NOT_PREPARER');
    await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: calculated.version }));
    // The preparer is first on the reviewers' list but never gets their own run.
    expect(await hasTask(h, preparer, run.id, 'REVIEW')).toBe(false);
    const reviewTask = await taskOf(h, reviewer, run.id, 'REVIEW');
    expect((await h.call(preparer, 'POST', `/v1/payroll/run-tasks/${reviewTask}/review`, { decision: 'APPROVE', idempotencyKey: key() })).statusCode).toBe(404);
    // A return needs a reason.
    expect((await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${reviewTask}/review`, { decision: 'RETURN', idempotencyKey: key() })).json().error).toBe('REASON_REQUIRED');
    const reviewKey = key();
    expect(await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${reviewTask}/review`, { decision: 'APPROVE', idempotencyKey: reviewKey }))).toMatchObject({ step: 'APPROVAL' });
    // An idempotent replay changes nothing.
    expect(await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${reviewTask}/review`, { decision: 'APPROVE', idempotencyKey: reviewKey }))).toMatchObject({ replayed: true });
    // Neither the preparer (first on the approvers' list) nor the reviewer approves.
    expect(await hasTask(h, preparer, run.id, 'APPROVAL')).toBe(false);
    const approvalTask = await taskOf(h, approver, run.id, 'APPROVAL');
    // The approver is told while the task is open; notifications name the run and step, never amounts.
    await dispatchOutbox(h.pool);
    const inbox = (await h.call(approver, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
    expect(inbox.find((n) => n.category === 'PAYROLL_RUN_ASSIGNED')?.body).toBe('Revision 1 of the 2026-02 payroll run is waiting for your approval.');
    expect(await ok(await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() }))).toMatchObject({ state: 'APPROVED' });
    // The data layer refuses a preparer recorded as approver.
    await expect(h.db.query(`update payroll_run set approved_by = calculated_by where id = $1`, [run.id])).rejects.toThrow();

    const processed = await processRun(h, processor, run.id);
    expect(processed).toMatchObject({ state: 'PROCESSED_LOCKED', lockVersion: 1, processedBy: processor.user, paymentStatus: 'NOT_TRACKED_HERE' });
    const r = await record(h, processor, run.id, e);
    expect(r).toMatchObject({ net: '31415.2700', bankStatus: 'MISSING' });
    // Without an approved bank instruction the payment is blocked automatically; the earned salary stays payable.
    const holds = (await h.db.query<{ hold_kind: string; state: string; hold_amount: string; reason_code: string }>(`select hold_kind, state, hold_amount, reason_code from payroll_hold where run_id = $1`, [run.id])).rows;
    expect(holds).toEqual([{ hold_kind: 'PAYMENT_SAFETY_BLOCK', state: 'APPROVED_ACTIVE', hold_amount: '31415.2700', reason_code: 'BANK_MISSING' }]);

    await dispatchOutbox(h.pool);
    const prepInbox = (await h.call(preparer, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
    expect(prepInbox.find((n) => n.category === 'PAYROLL_RUN_PROCESSED')?.body).toBe('Revision 1 of the 2026-02 payroll run was processed and locked.');
    const trail = await trailText(h, A.id);
    expect(trail.outbox).not.toContain('31415.27');
    expect(trail.operational).not.toContain('31415.27');
    // Amounts are audited only under their confidential group.
    const processAudit = await h.one<{ after_values: { amount?: { totals: { net: string }[] } } }>(`select after_values from audit_event where record_key = $1 and action = 'PROCESS'`, [run.id]);
    expect(processAudit.after_values.amount?.totals[0]?.net).toBe('31415.2700');
  });

  it('routes a decider’s own record to a covering approver before the run is approved', async () => {
    const dept = await department('COVER');
    const reviewerEmp = await paid(dept);
    const approverEmp = await paid(dept);
    await paid(dept);
    // Deciders who are themselves employees in this run.
    const selfReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW, employeeId: reviewerEmp });
    const selfApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE, employeeId: approverEmp });
    await reviewers(h, hr, 'payroll_run', [selfReviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [selfApprover, approver2]);
    try {
      const run = await createRun(h, preparer, periods['2026-03']!, { departmentIds: [dept] });
      await calculate(h, preparer, run.id);
      await submitAndApprove(h, { preparer, reviewer: selfReviewer, approver: selfApprover }, run.id);
      let view = await getRun(h, preparer, run.id);
      expect(view.state).toBe('IN_REVIEW');
      expect((view as unknown as { covers: { employeeId: string; coveredRole: string; state: string }[] }).covers.sort((a, b) => a.coveredRole.localeCompare(b.coveredRole))).toEqual([
        { employeeId: approverEmp, coveredRole: 'APPROVER', state: 'SUBMITTED' },
        { employeeId: reviewerEmp, coveredRole: 'REVIEWER', state: 'SUBMITTED' },
      ]);
      // Processing waits for the covers.
      expect((await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: view.version })).json().error).toBe('NOT_APPROVED');
      // Neither cover goes to the approver whose own record it is (or to any earlier decider).
      expect(await hasTask(h, selfApprover, run.id, 'COVER')).toBe(false);
      const covers = ((await h.call(approver2, 'GET', '/v1/payroll/runs/tasks/mine')).json().items as { taskId: string; step: string; run: { id: string } }[]).filter(
        (t) => t.step === 'COVER' && t.run.id === run.id,
      );
      expect(covers).toHaveLength(2);
      await ok(await h.call(approver2, 'POST', `/v1/payroll/run-tasks/${covers[0]!.taskId}/cover`, { decision: 'APPROVE', idempotencyKey: key() }));
      expect((await getRun(h, preparer, run.id)).state).toBe('IN_REVIEW');
      expect(await ok(await h.call(approver2, 'POST', `/v1/payroll/run-tasks/${covers[1]!.taskId}/cover`, { decision: 'APPROVE', idempotencyKey: key() }))).toMatchObject({ state: 'APPROVED' });
      view = await getRun(h, preparer, run.id);
      expect(view.state).toBe('APPROVED');
      // The approval engine's own guard refuses a decision by the covered employee's user.
      const coverTx = (await h.one<{ transaction_id: string }>(`select transaction_id from payroll_record_cover where run_id = $1 and employee_id = $2`, [run.id, approverEmp])).transaction_id;
      const owner = await h.one<{ owner_employee_id: string }>(`select owner_employee_id from business_transaction where id = $1`, [coverTx]);
      expect(owner.owner_employee_id).toBe(approverEmp);
    } finally {
      await reviewers(h, hr, 'payroll_run', [preparer, reviewer]);
      await reviewers(h, hr, 'payroll_run_approval', [preparer, approver, approver2]);
    }
  });

  it('routes each run stage only to a listed reviewer whose row scope covers every member (I-25)', async () => {
    const eng = await department('ROUTE_ENG');
    const fin = await department('ROUTE_FIN');
    const e = await paid(eng);
    await paid(fin);
    const engReviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW, departmentFilter: eng });
    const engApprover = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE, departmentFilter: eng });
    try {
      // The only listed reviewer could not open the whole run: nobody to route to, and the run stays calculated.
      await reviewers(h, hr, 'payroll_run', [engReviewer]);
      const run = await createRun(h, preparer, periods['2026-07']!, { departmentIds: [eng, fin] });
      const calculated = await calculate(h, preparer, run.id);
      expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: calculated.version })).json().error).toBe('NO_ELIGIBLE_REVIEWER');
      expect((await getRun(h, preparer, run.id)).state).toBe('CALCULATED');
      // Listed first, the department-limited reviewer and approver are passed over for the full-scope ones.
      await reviewers(h, hr, 'payroll_run', [engReviewer, reviewer]);
      await reviewers(h, hr, 'payroll_run_approval', [engApprover, approver]);
      await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: calculated.version }));
      expect(await hasTask(h, engReviewer, run.id, 'REVIEW')).toBe(false);
      await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${await taskOf(h, reviewer, run.id, 'REVIEW')}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
      expect(await hasTask(h, engApprover, run.id, 'APPROVAL')).toBe(false);
      expect(await hasTask(h, approver, run.id, 'APPROVAL')).toBe(true);
      // A run of their own department is theirs to review.
      const own = await createRun(h, preparer, periods['2026-08']!, { departmentIds: [eng] });
      const ownCalculated = await calculate(h, preparer, own.id);
      await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${own.id}/submit`, { expectedVersion: ownCalculated.version }));
      expect(await hasTask(h, engReviewer, own.id, 'REVIEW')).toBe(true);
      expect((await record(h, engReviewer, own.id, e)).calculationStatus).toBe('CALCULATED');
    } finally {
      await reviewers(h, hr, 'payroll_run', [preparer, reviewer]);
      await reviewers(h, hr, 'payroll_run_approval', [preparer, approver, approver2]);
    }
  });

  it('returns to a new draft revision with the confirmed scope (optionally narrowed) and cancels only with authority and a reason', async () => {
    const dept = await department('RETURN');
    const keep = await paid(dept);
    const drop = await paid(dept);
    const period = periods['2026-04']!;
    const run = await createRun(h, preparer, period, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    const r1 = await getRun(h, preparer, run.id);
    await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: r1.version }));
    const task = await taskOf(h, reviewer, run.id, 'REVIEW');
    const returned = await ok<{ state: string; nextRunId: string }>(
      await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${task}/review`, { decision: 'RETURN', reason: 'Recheck one employee (synthetic)', excludeEmployeeIds: [drop], idempotencyKey: key() }),
    );
    expect(returned.state).toBe('RETURNED');
    const old = await getRun(h, preparer, run.id);
    expect(old).toMatchObject({ state: 'RETURNED', successorRunId: returned.nextRunId });
    // A returned revision never becomes live again, whatever the path (H2: only the listed transitions exist).
    await expect(h.db.query(`update payroll_run set state = 'DRAFT', closed_at = null, close_reason = null where id = $1`, [run.id])).rejects.toThrow(
      /cannot move from RETURNED to DRAFT/,
    );
    await expect(h.db.query(`update payroll_run set state = 'IN_REVIEW', closed_at = null, close_reason = null where id = $1`, [run.id])).rejects.toThrow(
      /cannot move from RETURNED to IN_REVIEW/,
    );
    const next = await getRun(h, preparer, returned.nextRunId);
    expect(next).toMatchObject({ state: 'DRAFT', revision: 2, members: { included: 1, excluded: 1 } });
    // The returned revision keeps its calculation (never rewritten) and can still be verified.
    expect(await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/verify`))).toMatchObject({ identical: true, records: 2 });
    // The excluded employee is free for another run of the month; the kept one is not.
    const preview = await ok<{ members: { employeeId: string }[] }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: period, departmentIds: [dept] }));
    expect(preview.members.map((m) => m.employeeId)).toEqual([drop]);
    // The preparer's own validation return opens revision 3.
    await calculate(h, preparer, next.id);
    const n2 = await getRun(h, preparer, next.id);
    const third = await ok<{ id: string; revision: number }>(await h.call(preparer, 'POST', `/v1/payroll/runs/${next.id}/revise`, { reason: 'Inputs corrected (synthetic)', expectedVersion: n2.version }), 201);
    expect(third.revision).toBe(3);
    // Cancellation: authority and a reason.
    const t3 = await getRun(h, preparer, third.id);
    expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${third.id}/cancel`, { reason: 'Not needed', expectedVersion: t3.version })).statusCode).toBe(403);
    const cancelled = await ok<{ state: string }>(await h.call(canceller, 'POST', `/v1/payroll/runs/${third.id}/cancel`, { reason: 'Superseded by a separate run (synthetic)', expectedVersion: t3.version }));
    expect(cancelled.state).toBe('CANCELLED');
    const freed = await ok<{ members: { employeeId: string }[] }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: period, departmentIds: [dept] }));
    expect(freed.members.map((m) => m.employeeId).sort()).toEqual([keep, drop].sort());
  });

  it('blocks approval on unresolved exceptions; only an independent approver documents a resolution', async () => {
    const dept = await department('EXCEPTION');
    const absent = await paid(dept);
    await attendance(h, A, absent, '2026-05-05', 'ABSENT');
    const run = await createRun(h, preparer, periods['2026-05']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    const exception = (await record(h, preparer, run.id, absent)).exceptions.find((x) => x.code === 'ATTENDANCE_NOT_VALUED')!;
    await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/submit`, { expectedVersion: (await getRun(h, preparer, run.id)).version }));
    await ok(await h.call(reviewer, 'POST', `/v1/payroll/run-tasks/${await taskOf(h, reviewer, run.id, 'REVIEW')}/review`, { decision: 'APPROVE', idempotencyKey: key() }));
    const approvalTask = await taskOf(h, approver, run.id, 'APPROVAL');
    const refused = await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() });
    expect(refused.json()).toMatchObject({ error: 'EXCEPTIONS_UNRESOLVED', details: { exceptions: [{ code: 'ATTENDANCE_NOT_VALUED', n: 1 }] } });
    // The preparer may hold the approval duty, but never resolves their own run's exceptions.
    expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/exceptions/${exception.id}/resolve`, { resolution: 'x' })).json().error).toBe('NOT_INDEPENDENT');
    await ok(await h.call(approver, 'POST', `/v1/payroll/runs/${run.id}/exceptions/${exception.id}/resolve`, { resolution: 'Manager confirms the day is paid (synthetic)' }));
    expect((await h.call(approver, 'POST', `/v1/payroll/runs/${run.id}/exceptions/${exception.id}/resolve`, { resolution: 'again' })).json().error).toBe('ALREADY_RESOLVED');
    expect(await ok(await h.call(approver, 'POST', `/v1/payroll/run-tasks/${approvalTask}/approve`, { decision: 'APPROVE', idempotencyKey: key() }))).toMatchObject({ state: 'APPROVED' });
    // A resolution note never changes the numbers.
    expect(await record(h, approver, run.id, absent)).toMatchObject({ paidUnits: '31.0000', net: '30000.0000' });
  });

  it('freezes a processed run: no edit, rerun, cancel or master backdating can change it (ZT36)', async () => {
    const dept = await department('FREEZE');
    const e = await paid(dept, '30000');
    const period = periods['2026-06']!;
    const run = await createRun(h, preparer, period, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, team(), run.id);
    const processed = await processRun(h, processor, run.id);
    const before = await record(h, processor, run.id, e);
    expect(before).toMatchObject({ net: '30000.0000', paidUnits: '30.0000' });

    // Rerun in place, revision, exclusion and cancellation are refused.
    expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/calculate`, { expectedVersion: processed.version })).json().error).toBe('ALREADY_CALCULATED');
    expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/revise`, { reason: 'x', expectedVersion: processed.version })).json().error).toBe('INVALID_STATE');
    expect((await h.call(canceller, 'POST', `/v1/payroll/runs/${run.id}/cancel`, { reason: 'x', expectedVersion: processed.version })).json().error).toBe('RUN_LOCKED');
    expect((await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: processed.version })).json()).toMatchObject({ replayed: true });
    // Direct writes are refused by the database (CI25).
    await expect(h.db.query(`update payroll_record set net = 1 where run_id = $1`, [run.id])).rejects.toThrow(/immutable|locked|frozen/);
    await expect(h.db.query(`update payroll_line set amount = 1 where record_id = $1`, [before.id])).rejects.toThrow(/append-only/);
    await expect(h.db.query(`delete from payroll_record where run_id = $1`, [run.id])).rejects.toThrow();
    await expect(h.db.query(`update payroll_run set state = 'APPROVED' where id = $1`, [run.id])).rejects.toThrow(/locked/);
    await expect(h.db.query(`update payroll_record_segment set paid_days = 1 where record_id = $1`, [before.id])).rejects.toThrow(/append-only/);
    // Not even the metadata of a frozen record, of the run's members or of its exceptions is rewritten.
    await expect(h.db.query(`update payroll_record set updated_by = updated_by where run_id = $1`, [run.id])).rejects.toThrow(/frozen payroll record is immutable/);
    await expect(h.db.query(`update payroll_run_member set updated_by = updated_by where lineage_id = $1`, [run.id])).rejects.toThrow(/locked/);
    await expect(h.db.query(`update payroll_exception set updated_by = updated_by where run_id = $1`, [run.id])).rejects.toThrow(/locked/);

    // Backdated master changes: a new arrangement over the processed month, a correcting head revision, a new bank
    // instruction and approved unpaid leave inside the processed month.
    await laterArrangement(h, A, e, '2026-06-01', '99999', [{ code: 'BASIC', amount: '99999' }]);
    await bankRevision(h, A, e);
    await approvedLeave(h, A, e, 'UNPAID', '2026-06-10', '2026-06-10', '1');
    const draft = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/heads', { componentCode: 'BASIC', effectiveFrom: '2026-06-01', inUse: true, headType: 'EARNING', calculationBasis: 'FIXED', taxTreatment: 'NON_TAXABLE', displaySequence: 1 }),
      201,
    );
    await ok(await h.call(configB, 'POST', `/v1/payroll/head-revisions/${draft.id}/activate`, { expectedVersion: draft.version }));
    const after = await record(h, processor, run.id, e);
    expect(after.lines).toEqual(before.lines);
    expect(after).toMatchObject({ net: before.net, earnings: before.earnings, paidUnits: before.paidUnits, bankStatus: before.bankStatus, bankRevisionId: before.bankRevisionId });
    expect(after.lossOfPay).toEqual(before.lossOfPay);
    expect(after.segments).toEqual(before.segments);
    // A rerun on the frozen snapshot is identical (FR-033), whatever happened to the masters.
    expect(await ok(await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/verify`))).toMatchObject({ identical: true, lineDifferences: 0, totalDifferences: 0, paidDayDifferences: 0 });
    // The employee's pay for June is frozen: no other run of the month can include them.
    const preview = await ok<{ notIncluded: { employeeId: string; reason: string }[] }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: period, departmentIds: [dept] }));
    expect(preview.notIncluded).toEqual([expect.objectContaining({ employeeId: e, reason: 'IN_ANOTHER_RUN' })]);
    // The next month uses the new masters (corrections of June are later-period adjustments, payroll-outputs stage).
    const july = await createRun(h, preparer, periods['2026-07']!, { departmentIds: [dept] });
    await calculate(h, preparer, july.id);
    expect(await record(h, preparer, july.id, e)).toMatchObject({ net: '99999.0000' });
    // FR-033 component totals with the prior period: the processed June run of the same calendar and scope.
    const comparison = await ok<{ basis: string; priorPeriodCode: string; priorRunIds: string[]; items: { componentCode: string; current: string; prior: string; difference: string }[] }>(
      await h.call(processor, 'GET', `/v1/payroll/runs/${july.id}/components`),
    );
    expect(comparison).toMatchObject({ basis: 'RUN', priorPeriodCode: '2026-06', priorRunIds: [run.id] });
    expect(comparison.items).toEqual([expect.objectContaining({ componentCode: 'BASIC', current: '99999.0000', prior: '30000.0000', difference: '69999.0000' })]);
    // Records list the prior net per employee too.
    const listed = await ok<{ items: { employeeId: string; priorNet: string | null }[] }>(await h.call(preparer, 'GET', `/v1/payroll/runs/${july.id}/records`));
    expect(listed.items.find((x) => x.employeeId === e)?.priorNet).toBe('30000.0000');
  });

  it('compares against prior totals only when the caller may read every prior member (FR-033, C4), never their own record', async () => {
    const stays = await department('CMP_STAYS');
    const leaves = await department('CMP_LEAVES');
    const e1 = await paid(stays, '30000');
    const e2 = await paid(leaves, '50000');
    const filters = { departmentIds: [stays, leaves] };
    // May: both departments. June, same calendar and filters: the other department's employee is no longer a member.
    const may = await createRun(h, preparer, periods['2026-05']!, filters);
    await calculate(h, preparer, may.id);
    await submitAndApprove(h, team(), may.id);
    await processRun(h, processor, may.id);
    const june = await createRun(h, preparer, periods['2026-06']!, filters);
    await ok(await h.call(preparer, 'POST', `/v1/payroll/runs/${june.id}/exclusions`, { employeeIds: [e2], reason: 'Paid by another run (synthetic)', expectedVersion: june.version }));
    await calculate(h, preparer, june.id);

    interface Comparison {
      basis: string;
      priorPeriodCode: string | null;
      priorRunIds: string[];
      items: { componentCode: string; current: string; prior: string; difference: string }[];
    }
    const compare = async (a: TestActor) => ok<Comparison>(await h.call(a, 'GET', `/v1/payroll/runs/${june.id}/components`));
    // A whole-company reader: the full prior run, including the employee no longer a member.
    expect(await compare(processor)).toMatchObject({ basis: 'RUN', priorPeriodCode: '2026-05', priorRunIds: [may.id], items: [{ componentCode: 'BASIC', current: '30000.0000', prior: '80000.0000' }] });
    // A reader whose scope covers June's members but not May's: the other department's May pay is not in the figure,
    // so it cannot be worked out by subtraction.
    const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_run.read.amount'], departmentFilter: stays });
    expect(await compare(narrow)).toMatchObject({ basis: 'SCOPE', priorPeriodCode: null, priorRunIds: [], items: [{ componentCode: 'BASIC', current: '30000.0000', prior: '30000.0000', difference: '0.0000' }] });

    // A reader linked to the only employee in their scope: their own lines are no part of the comparison (H1).
    const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_run.read.amount'], departmentFilter: stays, employeeId: e1 });
    expect(await compare(self)).toMatchObject({ basis: 'SCOPE', items: [] });
  });

  it('pages run records and keeps every describer silent on a malformed event', async () => {
    const dept = await department('PAGES');
    for (let i = 0; i < 3; i++) await paid(dept);
    const run = await createRun(h, preparer, periods['2026-12']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    const page1 = await ok<{ items: { employeeCode: string }[]; nextAfter: string | null }>(await h.call(preparer, 'GET', `/v1/payroll/runs/${run.id}/records?limit=2`));
    expect(page1.items).toHaveLength(2);
    expect(page1.nextAfter).toBe(page1.items[1]!.employeeCode);
    const page2 = await ok<{ items: { employeeCode: string }[]; nextAfter: string | null }>(await h.call(preparer, 'GET', `/v1/payroll/runs/${run.id}/records?limit=2&after=${page1.nextAfter}`));
    expect(page2.items).toHaveLength(1);
    expect(page2.nextAfter).toBeNull();
    expect(page2.items[0]!.employeeCode > page1.items[1]!.employeeCode).toBe(true);
    // Describers validate payloads before any lookup and return nothing for a malformed or unknown one.
    for (const [topic, describe] of Object.entries(PAYROLL_EVENTS)) {
      for (const payload of [{}, { runId: 'x', batchId: 1, holdId: null, taskId: 'not-a-uuid', step: 'nope', outcome: 'NOPE', waitingDays: -1 }, { runId: randomUUID(), holdId: randomUUID(), batchId: randomUUID(), stopId: randomUUID(), taskId: randomUUID(), step: 'review', outcome: 'HELD', waitingDays: 3 }]) {
        await expect(describe(h.pool, { companyId: A.id, topic, aggregateId: randomUUID(), payload }), topic).resolves.toBeNull();
      }
    }
  });

  it('leaves no partially locked run when processing fails, and processes once under concurrent requests', async () => {
    const dept = await department('ATOMIC');
    const e1 = await paid(dept, '1000');
    await paid(dept, '2000');
    const run = await createRun(h, preparer, periods['2026-08']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, team(), run.id);
    // A synthetic fault during processing (after the records were frozen and the run locked in the transaction).
    await h.db.query(`create function zz_payroll_fault() returns trigger language plpgsql as $$ begin raise exception 'synthetic processing fault' using errcode = '23514'; end $$`);
    await h.db.query(`create trigger zz_payroll_fault before insert on payroll_hold for each row execute function zz_payroll_fault()`);
    try {
      const v = await getRun(h, processor, run.id);
      expect((await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: v.version })).statusCode).toBe(422);
    } finally {
      await h.db.query(`drop trigger zz_payroll_fault on payroll_hold`);
      await h.db.query(`drop function zz_payroll_fault()`);
    }
    const after = await getRun(h, processor, run.id);
    expect(after).toMatchObject({ state: 'APPROVED', lockVersion: null, processedAt: null, progress: { processing: { started: true, frozen: 0, complete: false } } });
    expect((await record(h, processor, run.id, e1)).bankStatus).toBeNull();
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_hold where run_id = $1`, [run.id])).n).toBe(0);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action in ('PROCESS', 'PROCESS_CHUNK')`, [run.id])).n).toBe(0);
    // Once processing has started the revision can only be completed: no cancellation, no return.
    expect((await h.call(canceller, 'POST', `/v1/payroll/runs/${run.id}/cancel`, { reason: 'x', expectedVersion: after.version })).json().error).toBe('PROCESSING_STARTED');
    expect((await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/return`, { reason: 'x', expectedVersion: after.version })).json().error).toBe('PROCESSING_STARTED');
    // So any eligible processor may complete it (the starter stays recorded). Two requests at the same moment, by the
    // starter and by another eligible processor on another connection: one processes, the other reports the result.
    const otherProcessor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    const [a, b] = await Promise.all([
      h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: after.version }),
      h.call(otherProcessor, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: after.version }),
    ]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().replayed, b.json().replayed].sort()).toEqual([false, true]);
    expect(a.json()).toMatchObject({ state: 'PROCESSED_LOCKED', processedBy: processor.user });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_hold where run_id = $1`, [run.id])).n).toBe(2);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from audit_event where record_key = $1 and action = 'PROCESS'`, [run.id])).n).toBe(1);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from payroll_run_chunk where run_id = $1 and phase = 'PROCESS'`, [run.id])).n).toBe(1);
    // The lock is audited with its own actor and names the processor who started.
    const lockAudit = await h.one<{ actor_user_id: string; after_values: { operational: { startedBy: string } } }>(
      `select actor_user_id, after_values from audit_event where record_key = $1 and action = 'PROCESS'`,
      [run.id],
    );
    expect([processor.user, otherProcessor.user]).toContain(lockAudit.actor_user_id);
    expect(lockAudit.after_values.operational.startedBy).toBe(processor.user);
  });

  it('never lets the creator or the preparer process (lock) the run they prepared, even with the processing duty', async () => {
    const dept = await department('SELF_PROCESS');
    const e = await paid(dept);
    // Both hold the processing duty in the same assignment as the preparing duty.
    const creator = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, PROCESS) });
    const preparing = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, PROCESS) });
    const run = await createRun(h, creator, periods['2026-05']!, { departmentIds: [dept] });
    await calculate(h, preparing, run.id);
    // The listed full-scope reviewer first in line is `preparer` here (not this run's preparer); approval goes to `approver`.
    expect(await submitAndApprove(h, { preparer: preparing, reviewer: preparer, approver }, run.id)).toMatchObject({ state: 'APPROVED' });
    const approved = await getRun(h, processor, run.id);
    for (const a of [preparing, creator]) {
      expect((await h.call(a, 'POST', `/v1/payroll/runs/${run.id}/process`, { expectedVersion: approved.version })).json().error).toBe('NOT_INDEPENDENT');
    }
    expect(await getRun(h, processor, run.id)).toMatchObject({ state: 'APPROVED', progress: { processing: { started: false, frozen: 0 } } });
    // The database refuses a preparer recorded as processor whatever the path.
    await h.db.query('begin');
    try {
      await expect(h.db.query(`update payroll_run set processing_started_at = now(), processed_by = calculated_by where id = $1`, [run.id])).rejects.toThrow(/violates check constraint/);
    } finally {
      await h.db.query('rollback');
    }
    // An independent processor locks it.
    expect(await processRun(h, processor, run.id)).toMatchObject({ state: 'PROCESSED_LOCKED', processedBy: processor.user });
    expect((await record(h, processor, run.id, e)).net).toBe('30000.0000');
  });

  it('lets the processor return an approved run to a new draft before processing, never after', async () => {
    const dept = await department('VALIDATE');
    const keep = await paid(dept);
    const drop = await paid(dept);
    const run = await createRun(h, preparer, periods['2026-11']!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, team(), run.id);
    const approved = await getRun(h, processor, run.id);
    expect(approved.state).toBe('APPROVED');
    // A return needs a reason; the preparer (no processing duty) cannot return it this way.
    expect((await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/return`, { reason: ' ', expectedVersion: approved.version })).json().error).toBe('REASON_REQUIRED');
    expect((await h.call(preparer, 'POST', `/v1/payroll/runs/${run.id}/return`, { reason: 'x', expectedVersion: approved.version })).statusCode).toBe(403);
    const next = await ok<{ id: string; revision: number; state: string; members: { included: number; excluded: number } }>(
      await h.call(processor, 'POST', `/v1/payroll/runs/${run.id}/return`, { reason: 'Bank file validation found a problem (synthetic)', excludeEmployeeIds: [drop], expectedVersion: approved.version }),
      201,
    );
    expect(next).toMatchObject({ revision: 2, state: 'DRAFT', members: { included: 1, excluded: 1 } });
    expect((await getRun(h, processor, run.id)).state).toBe('RETURNED');
    // The new revision is calculated afresh and covers only the kept employee.
    const recalculated = await calculate(h, preparer, next.id);
    expect(recalculated.records).toEqual({ CALCULATED: 1 });
    expect((await record(h, preparer, next.id, keep)).net).toBe('30000.0000');
    expect((await h.call(preparer, 'GET', `/v1/payroll/runs/${next.id}/records/${drop}`)).statusCode).toBe(404);
  });

  it('creates one run when two preparers confirm the same scope at the same moment', async () => {
    const dept = await department('RACE');
    await paid(dept);
    const period = periods['2026-09']!;
    const preview = await ok<{ scopeToken: string }>(await h.call(preparer, 'POST', '/v1/payroll/runs/preview', { periodId: period, departmentIds: [dept] }));
    const other = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE });
    const [a, b] = await Promise.all([
      h.call(preparer, 'POST', '/v1/payroll/runs', { periodId: period, departmentIds: [dept], scopeToken: preview.scopeToken }),
      h.call(other, 'POST', '/v1/payroll/runs', { periodId: period, departmentIds: [dept], scopeToken: preview.scopeToken }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect([a, b].find((x) => x.statusCode === 409)!.json().error).toBe('SCOPE_CHANGED');
  });

  it('denies wrong roles, missing confidential grants, other companies, other scopes and own records', async () => {
    const dept = await department('ACCESS');
    const fin = await department('ACCESS_FIN');
    const e = await paid(dept);
    const f = await paid(fin);
    const selfEmp = await paid(dept);
    const run = await createRun(h, preparer, periods['2026-10']!, { departmentIds: [dept, fin] });
    await calculate(h, preparer, run.id);

    // An HR Administrator without the payroll grants; a payroll operator (operational role); another company.
    const hrNoGrant = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await h.call(hrNoGrant, 'POST', '/v1/payroll/runs/preview', { periodId: periods['2026-10'] })).statusCode).toBe(403);
    expect((await h.call(hrNoGrant, 'GET', `/v1/payroll/runs/${run.id}/records`)).statusCode).toBe(403);
    const operator = await h.actor(A, 'PAYROLL_OPERATOR');
    const opView = await ok<Record<string, unknown>>(await h.call(operator, 'GET', `/v1/payroll/runs/${run.id}`));
    expect(opView).toMatchObject({ state: 'CALCULATED', records: { CALCULATED: 3 } });
    expect(opView).not.toHaveProperty('totals');
    expect(opView).not.toHaveProperty('components');
    expect((await h.call(operator, 'GET', `/v1/payroll/runs/${run.id}/records`)).statusCode).toBe(403);
    expect((await h.call(operator, 'POST', '/v1/payroll/runs/preview', { periodId: periods['2026-10'] })).statusCode).toBe(403);
    const bAdmin = await h.actor(B, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, REVIEW) });
    expect((await h.call(bAdmin, 'GET', `/v1/payroll/runs/${run.id}`)).statusCode).toBe(404);
    expect((await h.call(bAdmin, 'GET', `/v1/payroll/runs/${run.id}/records/${e}`)).statusCode).toBe(404);
    expect((await h.call(bAdmin, 'POST', `/v1/payroll/runs/${run.id}/calculate`, { expectedVersion: 1 })).statusCode).toBe(404);
    expect((await h.call(preparer, 'GET', `/v1/payroll/runs/${run.id}/records/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).statusCode).toBe(404);

    // A reader limited to one department sees its records only, and partial totals are flagged.
    const finReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_run.read.amount'], departmentFilter: fin });
    const listed = (await ok<{ items: { employeeId: string }[] }>(await h.call(finReader, 'GET', `/v1/payroll/runs/${run.id}/records`))).items.map((r) => r.employeeId);
    expect(listed).toEqual([f]);
    expect((await h.call(finReader, 'GET', `/v1/payroll/runs/${run.id}/records/${e}`)).statusCode).toBe(404);
    expect(await ok(await h.call(finReader, 'GET', `/v1/payroll/runs/${run.id}`))).toMatchObject({ scopeComplete: false });
    // Nor may it calculate, submit or decide a run that includes employees outside its scope.
    const finPreparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PREPARE, departmentFilter: fin });
    expect((await h.call(finPreparer, 'POST', `/v1/payroll/runs/${run.id}/revise`, { reason: 'x', expectedVersion: (await getRun(h, preparer, run.id)).version })).json().error).toBe('SCOPE_INCOMPLETE');

    // An administrator never reads their own payroll record in this context (H1: own outputs come through ESS).
    const selfReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['payroll_run.read.amount'], employeeId: selfEmp });
    expect((await h.call(selfReader, 'GET', `/v1/payroll/runs/${run.id}/records/${selfEmp}`)).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    const own = (await ok<{ items: { employeeId: string }[] }>(await h.call(selfReader, 'GET', `/v1/payroll/runs/${run.id}/records`))).items.map((r) => r.employeeId);
    expect(own).not.toContain(selfEmp);
    expect(own).toContain(e);
    // Employees never see calculation previews (FR-107).
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    expect((await h.call(employee, 'GET', `/v1/payroll/runs/${run.id}/records/${e}`)).statusCode).toBe(403);
    expect((await h.call(employee, 'GET', `/v1/payroll/runs/${run.id}`)).statusCode).toBe(403);
    // Denials are audited without payload.
    const denial = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and action = 'ACCESS_DENIED' and resource_code = 'payroll_run'`, [A.id]);
    expect(denial.n).toBeGreaterThan(0);
  });
});
