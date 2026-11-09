// docs/10 A2 (I-28; decided under owner delegation, 6 Nov 2026): processing refuses with MASTERS_CHANGED when what the calculation read
// from the employee masters no longer holds: a salary arrangement, unpaid leave, reviewed attendance or a leaving date approved after the
// calculation. Nothing is frozen; the run is returned and a new revision calculates on the masters as they are. An unrelated change, such
// as leave in another month, refuses nothing, because values are compared, not timestamps. Synthetic employees and amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import {
  APPROVE,
  approvedExit,
  approvedLeave,
  attendanceMonth,
  calculate,
  calendar,
  CONFIG,
  createRun,
  getRun,
  grants,
  head,
  laterArrangement,
  months,
  ok,
  person,
  PREPARE,
  PROCESS,
  processRun,
  REVIEW,
  reviewers,
  SALARY,
  salary,
  submitAndApprove,
} from './payroll.fixtures.js';

describe.runIf(isModuleActive('payroll'))('employee masters changed after the calculation', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let periods: Record<string, string>;
  const team = () => ({ preparer, reviewer, approver });

  const department = async (code: string) => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, code])).id;
  const paid = async (dept: string) => {
    const e = await person(h, A, hr, { departmentId: dept, joiningDate: '2026-01-05' });
    await salary(h, preparer, e, { effectiveFrom: '2026-01-05', monthlyGross: '30000', components: [{ code: 'MC_BASIC', amount: '30000' }] });
    return e;
  };
  /** A run of one employee, calculated and independently approved: ready to process. */
  const approvedRun = async (month: string, dept: string) => {
    const run = await createRun(h, preparer, periods[month]!, { departmentIds: [dept] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, team(), run.id);
    return run.id;
  };
  const process = async (runId: string) => h.call(processor, 'POST', `/v1/payroll/runs/${runId}/process`, { expectedVersion: (await getRun(h, processor, runId)).version });
  /** MASTERS_CHANGED, with the run still approved and nothing frozen. */
  const refused = async (runId: string, records: Record<string, number>) => {
    const res = await process(runId);
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toMatchObject({ error: 'MASTERS_CHANGED', details: { records } });
    const after = await h.one<{ state: string; processing_started_at: string | null; frozen: number }>(
      `select r.state, r.processing_started_at, (select count(*)::int from payroll_record rec where rec.run_id = r.id and rec.frozen_at is not null) as frozen from payroll_run r where r.id = $1`,
      [runId],
    );
    expect(after).toEqual({ state: 'APPROVED', processing_started_at: null, frozen: 0 });
  };
  const nothingElse = { leavingDate: 0, salaryArrangements: 0, unpaidLeave: 0, attendance: 0 };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
    preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
    reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
    approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
    processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
    await reviewers(h, hr, 'payroll_run', [reviewer]);
    await reviewers(h, hr, 'payroll_run_approval', [approver]);
    await head(h, configA, configB, { code: 'MC_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    periods = (await calendar(h, configA, configB, months(2026))).periods;
    // December values reviewed attendance (the attendance case below); the other months pay on approved leave only.
    const draft = await ok<{ id: string; version: number }>(
      await h.call(configA, 'POST', '/v1/payroll/paid-day-policies', { effectiveFrom: '2026-12-01', attendanceBasis: 'REVIEWED_ATTENDANCE', absentUnpaidUnits: '1', halfDayUnpaidUnits: '0.5' }),
      201,
    );
    await ok(await h.call(configB, 'POST', `/v1/payroll/paid-day-policies/${draft.id}/activate`, { expectedVersion: draft.version }));
  }, 180_000);

  afterAll(async () => {
    await h?.stop();
  });

  it('a salary arrangement approved after the calculation refuses processing; returned, the new revision pays on both arrangements', async () => {
    const dept = await department('MC_SALARY');
    const e = await paid(dept);
    const runId = await approvedRun('2026-04', dept);
    await laterArrangement(h, A, e, '2026-04-16', '40000', [{ code: 'MC_BASIC', amount: '40000' }]);
    await refused(runId, { ...nothingElse, salaryArrangements: 1 });
    const next = await ok<{ id: string }>(await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/return`, { reason: 'Salary changed after the calculation (synthetic)', expectedVersion: (await getRun(h, processor, runId)).version }), 201);
    await calculate(h, preparer, next.id);
    await submitAndApprove(h, team(), next.id);
    expect(await processRun(h, processor, next.id)).toMatchObject({ state: 'PROCESSED_LOCKED' });
    const segments = await h.db.query(`select segment_start::text, segment_end::text from payroll_record_segment s join payroll_record r on r.id = s.record_id where r.run_id = $1 order by 1`, [next.id]);
    expect(segments.rows).toEqual([
      { segment_start: '2026-04-01', segment_end: '2026-04-15' },
      { segment_start: '2026-04-16', segment_end: '2026-04-30' },
    ]);
  });

  it('unpaid leave approved after the calculation refuses processing', async () => {
    const dept = await department('MC_LEAVE');
    const e = await paid(dept);
    const runId = await approvedRun('2026-05', dept);
    await approvedLeave(h, A, e, 'UNPAID', '2026-05-12', '2026-05-12', '1');
    await refused(runId, { ...nothingElse, unpaidLeave: 1 });
  });

  it('a leaving date approved after the calculation refuses processing', async () => {
    const dept = await department('MC_EXIT');
    const e = await paid(dept);
    const runId = await approvedRun('2026-06', dept);
    await approvedExit(h, A, e, '2026-06-01', '2026-06-19');
    await refused(runId, { ...nothingElse, leavingDate: 1 });
  });

  it('reviewed attendance changed after the calculation refuses processing', async () => {
    const dept = await department('MC_ATTENDANCE');
    const e = await paid(dept);
    await attendanceMonth(h, A, e, '2026-12-01', '2026-12-31');
    const runId = await approvedRun('2026-12', dept);
    const day = await h.one<{ id: string; version: number }>(`select id, version from attendance_record where company_id = $1 and employee_id = $2 and work_date = '2026-12-15'`, [A.id, e]);
    const amended = await h.call(hr, 'POST', `/v1/attendance/records/${day.id}/amend`, { expectedVersion: day.version, status: 'ABSENT', reason: 'Absent after all (synthetic)' });
    expect(amended.statusCode, amended.body).toBe(200);
    await refused(runId, { ...nothingElse, attendance: 1 });
  });

  it('a change that is not in the calculated period refuses nothing: leave in another month, approved after the calculation', async () => {
    const dept = await department('MC_UNRELATED');
    const e = await paid(dept);
    const runId = await approvedRun('2026-07', dept);
    await approvedLeave(h, A, e, 'UNPAID', '2026-08-11', '2026-08-11', '1');
    expect(await processRun(h, processor, runId)).toMatchObject({ state: 'PROCESSED_LOCKED' });
  });
});
