// Attendance and the processed-payroll lock (FR-022 "payroll-lock dependencies"; BR-037 "locked historical results are
// not silently rewritten"; BR-047; ZT36). Payroll is calculated, approved and processed through the API; every attempt to
// change a day the frozen record used is then refused or skipped with a count, and the source punch still arrives.
// Synthetic employees, banks and amounts only. Fixed past dates (2026-03-02 is a Monday).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { calculate, calendar, CONFIG, createRun, grantOf, grants, head, months, ok, PREPARE, PROCESS, processRun, REVIEW, APPROVE, reviewers, SALARY, salary, submitAndApprove, attendance, key, getRun } from '../payroll/payroll.fixtures.js';
import { processRun as processService } from '../payroll/runs.js';
import { isModuleActive } from '../registry.js';

const MON = '2026-03-02';
const TUE = '2026-03-03';
const WED = '2026-03-04';
const LOCK_ERROR = { statusCode: 409, error: 'PAYROLL_LOCKED' };

describe.runIf(isModuleActive('payroll'))('attendance a processed payroll used (FR-022, BR-037, BR-047, ZT36)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let preparer: TestActor;
  let reviewer: TestActor;
  let approver: TestActor;
  let processor: TestActor;
  let managerEmp: string;
  let manager: TestActor;
  let periods: Record<string, string>;
  let shiftId: string;

  const department = async () => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, uniq('LK').toUpperCase()])).id;
  const person = async (departmentId: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId }))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
    await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    await salary(h, preparer, e.id, { effectiveFrom: '2026-01-05', monthlyGross: '31000', components: [{ code: 'LK_BASIC', amount: '31000' }] });
    return { id: e.id as string, code: e.employeeCode as string };
  };
  const recordOn = async (employeeId: string, day: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${day}&to=${day}`)).json().items[0];
  const amend = (a: TestActor, r: { id: string; version: number }, status: string) =>
    h.call(a, 'POST', `/v1/attendance/records/${r.id}/amend`, { expectedVersion: r.version, status, reason: 'Synthetic amendment' });
  const processDay = async (workDate: string) => (await h.runBulkJob(hr, '/v1/attendance/processing', { workDate })).result;
  const runFor = async (period: string, departmentId: string) => {
    const run = await createRun(h, preparer, periods[period]!, { departmentIds: [departmentId] });
    await calculate(h, preparer, run.id);
    await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
    return run;
  };
  /** Payroll processed for the department: its records are frozen. */
  const processedRun = async (period: string, departmentId: string) => {
    const run = await runFor(period, departmentId);
    await processRun(h, processor, run.id);
    return run;
  };

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
    await head(h, configA, configB, { code: 'LK_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
    // A month far ahead too: a run can be processed before its month ends, and it cannot have used a later day.
    periods = (await calendar(h, configA, configB, [...months(2026), { code: '2090-03', start: '2090-03-01', end: '2090-03-31' }])).periods;
    shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
    const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
    await ok(await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version }));
    const m = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, m.id, 'ACTIVE_CONFIRMED');
    managerEmp = m.id;
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('reprocessing skips a used day with a count; the late punch stays as evidence and the record does not change', async () => {
    const dept = await department();
    const e = await person(dept);
    await attendance(h, A, e.id, MON, 'PRESENT');
    await processedRun('2026-03', dept);

    const accepted = await h.call(hr, 'POST', '/v1/attendance/punches', {
      punches: [{ employeeCode: e.code, occurredAt: `${MON}T09:00:00+05:30`, direction: 'IN', externalEventKey: uniq('evt-') }],
    });
    expect(accepted.json()).toMatchObject({ accepted: 1, rejected: [] });
    const before = await recordOn(e.id, MON);
    const result = await processDay(MON);
    expect(result.SKIPPED_LOCKED).toBeGreaterThanOrEqual(1);
    expect(await recordOn(e.id, MON)).toEqual(before);
    expect(before).toMatchObject({ status: 'PRESENT', calculationCount: 1, version: 1 });
    const stored = await h.one<{ n: number }>(`select count(*)::int as n from attendance_punch where employee_id = $1`, [e.id]);
    expect(stored.n).toBe(1);
    const audit = await h.one<{ after_values: { operational: Record<string, unknown> } }>(
      `select after_values from audit_event where company_id = $1 and resource_code = 'attendance_processing' and action = 'PROCESS' order by occurred_at desc limit 1`,
      [A.id],
    );
    expect(audit.after_values.operational).toMatchObject({ workDate: MON, SKIPPED_LOCKED: result.SKIPPED_LOCKED });
  });

  it('an HR amendment of a used day is refused and records nothing; a day of an unprocessed period still amends', async () => {
    const dept = await department();
    const e = await person(dept);
    await attendance(h, A, e.id, TUE, 'PRESENT');
    await attendance(h, A, e.id, '2026-04-07', 'PRESENT');
    const usedRun = await processedRun('2026-03', dept);

    const r = await recordOn(e.id, TUE);
    const refused = await amend(hr, r, 'ABSENT');
    expect({ statusCode: refused.statusCode, error: refused.json().error }).toEqual(LOCK_ERROR);
    expect(await recordOn(e.id, TUE)).toMatchObject({ status: 'PRESENT', amended: false, version: r.version });
    const trail = await h.one<{ n: number }>(`select count(*)::int as n from attendance_amendment where attendance_record_id = $1`, [r.id]);
    expect(trail.n).toBe(0);

    // April's run is calculated and approved, not processed: nothing froze it, so the correction still happens.
    const april = await recordOn(e.id, '2026-04-07');
    await runFor('2026-04', dept);
    expect((await amend(hr, april, 'HALF_DAY')).statusCode).toBe(200);
    expect((await getRun(h, processor, usedRun.id)).state).toBe('PROCESSED_LOCKED');
  });

  it('the database refuses a direct change of a used day too', async () => {
    const dept = await department();
    const e = await person(dept);
    await attendance(h, A, e.id, WED, 'PRESENT');
    await processedRun('2026-03', dept);
    const r = await recordOn(e.id, WED);
    await expect(h.db.query(`update attendance_record set worked_minutes = 1 where id = $1`, [r.id])).rejects.toThrow(/processed payroll/);
    expect(await recordOn(e.id, WED)).toMatchObject({ workedMinutes: 0, version: r.version });
  });

  it('a correction of a used day is refused when asked; one asked before processing cannot be approved after it, and can be rejected', async () => {
    const dept = await department();
    const e = await person(dept);
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    await attendance(h, A, e.id, TUE, 'PRESENT');
    const r = await recordOn(e.id, TUE);
    const correction = (status: string) => h.call(self, 'POST', '/v1/me/attendance-corrections', { attendanceRecordId: r.id, status, reason: 'Synthetic correction' });
    const pending = await ok<{ requestId: string }>(await correction('HALF_DAY'), 201);
    await processedRun('2026-03', dept);

    const late = await correction('ABSENT');
    expect({ statusCode: late.statusCode, error: late.json().error }).toEqual(LOCK_ERROR);

    const task = ((await h.call(manager, 'GET', '/v1/attendance-corrections/tasks/mine')).json().items as { taskId: string; request: { id: string } }[]).find((t) => t.request.id === pending.requestId)!;
    const decide = (decision: string, reason?: string) => h.call(manager, 'POST', `/v1/attendance-corrections/tasks/${task.taskId}/decision`, { decision, idempotencyKey: key(), ...(reason ? { reason } : {}) });
    const approved = await decide('APPROVE');
    expect({ statusCode: approved.statusCode, error: approved.json().error }).toEqual(LOCK_ERROR);
    expect(await recordOn(e.id, TUE)).toMatchObject({ status: 'PRESENT', amended: false });
    // The whole decision rolled back: the task is still open, and the reviewer can reject it.
    expect((await decide('REJECT', 'A processed payroll used this day (synthetic)')).json().state).toBe('REJECTED');
  });

  it('a day after the date the record was frozen was not used: it is evaluated and amended as usual', async () => {
    const dept = await department();
    const e = await person(dept);
    await processedRun('2090-03', dept);
    const day = '2090-03-06'; // a Monday
    const processed = await processDay(day);
    expect(processed.SKIPPED_LOCKED).toBe(0);
    const r = await recordOn(e.id, day);
    expect(r).toMatchObject({ status: 'ABSENT' });
    expect((await amend(hr, r, 'PRESENT')).statusCode).toBe(200);
  });

  it('an amendment racing the freeze waits for it and is then refused (BR-047)', async () => {
    const dept = await department();
    const first = await person(dept);
    const second = await person(dept);
    await attendance(h, A, first.id, TUE, 'PRESENT');
    await attendance(h, A, second.id, TUE, 'PRESENT');
    const run = await runFor('2026-03', dept);
    const approved = await getRun(h, processor, run.id);
    // Processing has started and frozen one record; the other is frozen by a transaction still open.
    const grant = await grantOf(h, processor, 'payroll_run', 'process', ['amount']);
    await processService(h.pool, grant, run.id, { expectedVersion: approved.version }, { chunkSize: 1, maxChunks: 1 });
    const open = await h.one<{ employee_id: string }>(`select employee_id from payroll_record where run_id = $1 and frozen_at is null`, [run.id]);
    const r = await recordOn(open.employee_id, TUE);

    await h.db.query('begin');
    let amendment: ReturnType<typeof amend> | undefined;
    try {
      await h.db.query(`update payroll_record set bank_status = 'MISSING', frozen_at = now() where run_id = $1 and employee_id = $2`, [run.id, open.employee_id]);
      amendment = amend(hr, r, 'ABSENT');
      let blocked = false;
      for (let i = 0; i < 200 && !blocked; i++) {
        const waiting = await h.pool.query(`select 1 from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%from payroll_record%for share%' and datname = current_database()`);
        blocked = (waiting.rowCount ?? 0) > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(blocked).toBe(true);
    } finally {
      await h.db.query('commit');
    }
    const res = await amendment!;
    expect({ statusCode: res.statusCode, error: res.json().error }).toEqual(LOCK_ERROR);
    expect(await recordOn(open.employee_id, TUE)).toMatchObject({ status: 'PRESENT', amended: false });
  });
});
