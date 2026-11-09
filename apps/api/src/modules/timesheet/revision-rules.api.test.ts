// What a new timesheet revision re-checks and what it keeps, over HTTP (FR-045 acceptance "cannot reference an inactive
// or out-of-period master; historical entries retain the original classification"; FR-047; CI14; I-30 "Rules apply at
// entry and again at submission"). Fixed past weeks; 2026-02-02 is a Monday. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { addDays } from './common.js';
import { addLine, allocate, approvedWeek, decide, openWeek, sheet, submit, taskFor, type TimesheetWorld, timesheetWorld } from './timesheet.fixtures.js';

/** The Monday of the n-th fixed week; every test has weeks of its own. */
const week = (n: number) => addDays('2026-02-02', 7 * n);

describe.runIf(isModuleActive('timesheet'))('timesheet: revision rules', () => {
  let h: Harness;
  let A: Company;
  let w: TimesheetWorld;

  interface Masters {
    jobId: string;
    activityId: string;
    allocationId: string;
    allocationVersion: number;
  }

  /** A job and an activity of its own, allocated to the employee, so changing them disturbs no other test. */
  const masters = async (employeeId: string): Promise<Masters> => {
    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await h.call(w.hr, 'POST', path, { ownerEmployeeId: w.managerEmp, startDate: '2026-01-01', ...body });
      expect(res.statusCode, res.body).toBe(201);
      return res.json() as { id: string; version: number };
    };
    const jobId = (await post(`/v1/timesheet/projects/${w.projectId}/jobs`, { code: uniq('JOB'), name: 'Synthetic job' })).id;
    const activityId = (await post('/v1/timesheet/activities', { code: uniq('ACT'), name: 'Synthetic activity', productive: true })).id;
    expect((await h.call(w.hr, 'PUT', `/v1/timesheet/jobs/${jobId}/activities/${activityId}`, { active: true })).statusCode).toBe(200);
    const allocation = await allocate(h, w.hr, { employeeId, jobId, allocationPercent: '5' });
    expect(allocation.statusCode, allocation.body).toBe(201);
    return { jobId, activityId, allocationId: allocation.json().id, allocationVersion: allocation.json().version };
  };

  const patchMaster = async (path: string, patch: Record<string, unknown>) => {
    const { version } = (await h.call(w.hr, 'GET', path)).json() as { version: number };
    const res = await h.call(w.hr, 'PATCH', path, { expectedVersion: version, ...patch });
    expect(res.statusCode, res.body).toBe(200);
  };

  const lineOf = (m: Masters, workDate: string, minutes = 480) => ({ workDate, jobId: m.jobId, activityId: m.activityId, minutes });

  /** A line entered and submitted, decided by the manager and revised: revision 2 holds it carried unchanged. */
  const carriedDraft = async (employee: TestActor, m: Masters, n: number, decision: 'RETURN' | 'REJECT', workDate = week(n)) => {
    const ts = await openWeek(h, employee, week(n));
    expect((await addLine(h, employee, ts.id, lineOf(m, workDate))).statusCode).toBe(201);
    expect((await submit(h, employee, ts.id)).statusCode).toBe(200);
    expect((await decide(h, w.manager, (await taskFor(h, w.manager, ts.id))!, decision)).statusCode).toBe(200);
    const revised = await h.call(employee, 'POST', `/v1/me/timesheets/${ts.id}/revise`);
    expect(revised.statusCode, revised.body).toBe(201);
    expect(revised.json().lines).toMatchObject([{ workDate, source: 'CARRIED', version: 1 }]);
    return { id: ts.id, lineId: revised.json().lines[0].id as string };
  };

  const expectRefused = async (employee: TestActor, ts: { id: string; lineId: string }, workDate: string, code: string) => {
    const res = await submit(h, employee, ts.id);
    expect([res.statusCode, res.json().error], res.body).toEqual([422, 'LINES_INVALID']);
    expect(res.json().details.lines).toEqual([{ lineId: ts.lineId, workDate, code }]);
    expect(await sheet(h, employee, ts.id)).toMatchObject({ state: 'DRAFT', currentRevision: 2 });
  };

  /** An approved exit with an inclusive last working date, written directly (the exit workflow is tested in lifecycle). */
  const approveExit = async (employeeId: string, lastDay: string) => {
    await h.db.query('begin');
    try {
      const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [A.id, employeeId]);
      const x = await h.one<{ id: string }>(
        `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
         values ($1, $2, $3, 'RESIGNATION', '2026-01-10', $4, $4, 'SUBMITTED') returning id`,
        [A.id, employeeId, bt.id, lastDay],
      );
      await h.db.query(`update business_transaction set state = 'RECOMMENDED' where id = $1`, [bt.id]);
      await h.db.query(`update exit_case set state = 'RECOMMENDED', recommended_leaving_date = $2, recommended_at = now() where id = $1`, [x.id, lastDay]);
      await h.db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [bt.id]);
      await h.db.query(`update exit_case set state = 'APPROVED', approved_leaving_date = $2, approved_at = now(), prior_status_code = 'ACTIVE_CONFIRMED' where id = $1`, [x.id, lastDay]);
      await h.db.query('commit');
    } catch (err) {
      await h.db.query('rollback');
      throw err;
    }
  };

  const reopen = async (employee: TestActor, timesheetId: string) => {
    const requested = await h.call(employee, 'POST', `/v1/timesheets/${timesheetId}/reopen-requests`, { reason: 'Synthetic correction' });
    expect(requested.statusCode, requested.body).toBe(201);
    const tasks = (await h.call(w.hrReviewer, 'GET', '/v1/timesheet-reopen-tasks')).json().items as { taskId: string; request: { id: string } | null }[];
    const taskId = tasks.find((t) => t.request?.id === requested.json().reopenRequestId)!.taskId;
    const decided = await h.call(w.hrReviewer, 'POST', `/v1/timesheet-reopen-tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('reopen-key-') });
    expect(decided.statusCode, decided.body).toBe(200);
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await timesheetWorld(h, A);
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('lines carried from a returned or rejected revision were never approved, so submission checks them again (CI14)', () => {
    it('refuses a line whose allocation was cancelled, and the employee can correct it', async () => {
      const m = await masters(w.employeeEmp);
      const ts = await carriedDraft(w.employee, m, 0, 'RETURN');
      const cancelled = await h.call(w.hr, 'POST', `/v1/timesheet/allocations/${m.allocationId}/cancel`, { reason: 'Synthetic cancellation', expectedVersion: m.allocationVersion });
      expect(cancelled.statusCode, cancelled.body).toBe(200);
      await expectRefused(w.employee, ts, week(0), 'NO_ACTIVE_ALLOCATION');
      // Not a dead end: the line is replaced by one that meets the rules.
      expect((await h.call(w.employee, 'POST', `/v1/me/timesheets/${ts.id}/lines/${ts.lineId}/remove`)).statusCode).toBe(200);
      expect((await addLine(h, w.employee, ts.id, lineOf(await masters(w.employeeEmp), week(0)))).statusCode).toBe(201);
      expect((await submit(h, w.employee, ts.id)).json()).toMatchObject({ state: 'SUBMITTED', revision: 2 });
    });

    it('refuses a line whose activity was deactivated', async () => {
      const m = await masters(w.employeeEmp);
      const ts = await carriedDraft(w.employee, m, 1, 'REJECT');
      await patchMaster(`/v1/timesheet/activities/${m.activityId}`, { active: false });
      await expectRefused(w.employee, ts, week(1), 'INACTIVE_MASTER');
    });

    it('refuses a line whose job no longer covers the work date', async () => {
      const m = await masters(w.employeeEmp);
      const ts = await carriedDraft(w.employee, m, 2, 'RETURN');
      await patchMaster(`/v1/timesheet/jobs/${m.jobId}`, { endDate: addDays(week(2), -1) });
      await expectRefused(w.employee, ts, week(2), 'MASTER_OUT_OF_PERIOD');
    });

    it('refuses a line whose job no longer permits the activity', async () => {
      const m = await masters(w.employeeEmp);
      const ts = await carriedDraft(w.employee, m, 3, 'REJECT');
      expect((await h.call(w.hr, 'PUT', `/v1/timesheet/jobs/${m.jobId}/activities/${m.activityId}`, { active: false })).statusCode).toBe(200);
      await expectRefused(w.employee, ts, week(3), 'ACTIVITY_NOT_PERMITTED');
    });

    it('refuses a line after an approved last working date inside the week', async () => {
      const m = await masters(w.peerEmp);
      const tuesday = addDays(week(4), 1);
      const ts = await carriedDraft(w.peer, m, 4, 'RETURN', tuesday);
      await approveExit(w.peerEmp, week(4));
      await expectRefused(w.peer, ts, tuesday, 'OUTSIDE_EMPLOYMENT');
    });

    it('accepts a carried line that still meets the rules, with the classification it was entered with', async () => {
      const m = await masters(w.employeeEmp);
      const ts = await carriedDraft(w.employee, m, 5, 'REJECT');
      await patchMaster(`/v1/timesheet/activities/${m.activityId}`, { productive: false });
      expect((await submit(h, w.employee, ts.id)).json()).toMatchObject({ state: 'SUBMITTED', revision: 2 });
      expect((await sheet(h, w.employee, ts.id)).lines).toMatchObject([{ source: 'CARRIED', productive: true }]);
    });
  });

  describe('lines already approved stay as approved (FR-045 acceptance; BR-048)', () => {
    it('a reopened correction resubmits an approved line unchanged after its master was deactivated', async () => {
      const m = await masters(w.employeeEmp);
      const id = await approvedWeek(h, w, w.employee, week(6), [lineOf(m, week(6))]);
      await patchMaster(`/v1/timesheet/activities/${m.activityId}`, { active: false });
      await reopen(w.employee, id);
      expect((await submit(h, w.employee, id)).json()).toMatchObject({ state: 'SUBMITTED', revision: 2 });
      expect((await sheet(h, w.employee, id)).lines).toMatchObject([{ source: 'CARRIED', productive: true }]);
    });

    it('returning that correction keeps the approved line exempt, but not a line the correction changed', async () => {
      const m = await masters(w.employeeEmp);
      const tuesday = addDays(week(7), 1);
      const id = await approvedWeek(h, w, w.employee, week(7), [lineOf(m, week(7)), lineOf(m, tuesday)]);
      await reopen(w.employee, id);
      const edited = (await sheet(h, w.employee, id)).lines.find((l) => l.workDate === tuesday)!;
      expect((await h.call(w.employee, 'PUT', `/v1/me/timesheets/${id}/lines/${edited.id}`, { expectedVersion: edited.version, minutes: 240 })).statusCode).toBe(200);
      expect((await submit(h, w.employee, id)).statusCode).toBe(200);
      expect((await decide(h, w.manager, (await taskFor(h, w.manager, id))!, 'RETURN')).statusCode).toBe(200);
      const revised = await h.call(w.employee, 'POST', `/v1/me/timesheets/${id}/revise`);
      expect(revised.json().lines).toMatchObject([
        { workDate: week(7), source: 'CARRIED', version: 1 },
        { workDate: tuesday, source: 'CARRIED', version: 1, minutes: 240 },
      ]);
      const changed = (revised.json().lines as { id: string; workDate: string }[]).find((l) => l.workDate === tuesday)!;

      await patchMaster(`/v1/timesheet/activities/${m.activityId}`, { active: false });
      // Only the 240-minute line is refused: the 480-minute Monday still matches the approved revision in force.
      const res = await submit(h, w.employee, id);
      expect([res.statusCode, res.json().error], res.body).toEqual([422, 'LINES_INVALID']);
      expect(res.json().details.lines).toEqual([{ lineId: changed.id, workDate: tuesday, code: 'INACTIVE_MASTER' }]);
    });

    it('reclassifying or renaming a master changes no approved figure; a new line takes the new classification', async () => {
      const m = await masters(w.employeeEmp);
      const shift = await h.call(w.hr, 'POST', '/v1/shifts', { code: uniq('DAY'), name: 'Day shift', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] });
      expect(shift.statusCode, shift.body).toBe(201);
      expect((await h.call(w.hr, 'POST', `/v1/employees/${w.employeeEmp}/shift`, { shiftId: shift.json().id, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);

      const monday = week(8);
      const range = `from=${monday}&to=${addDays(monday, 6)}&employeeId=${w.employeeEmp}`;
      const figures = async () => ({
        lines: (await sheet(h, w.employee, id)).lines.map((l) => [l.workDate, l.jobId, l.activityId, l.minutes, l.productive]),
        hours: (await h.call(w.hr, 'GET', `/v1/timesheet-reports/hours?${range}&groupBy=employee`)).json().totals,
        utilisation: (await h.call(w.hr, 'GET', `/v1/timesheet-reports/utilisation?${range}`)).json().items[0].utilisationPercent,
      });
      const id = await approvedWeek(h, w, w.employee, monday, [lineOf(m, monday)]);
      const before = await figures();
      // One productive 480-minute line against Monday-Friday at 480 minutes a day.
      expect(before).toEqual({
        lines: [[monday, m.jobId, m.activityId, 480, true]],
        hours: { minutes: 480, hours: '8.00', productiveMinutes: 480, lineCount: 1 },
        utilisation: '20.00',
      });

      await patchMaster(`/v1/timesheet/activities/${m.activityId}`, { productive: false, name: 'Renamed synthetic activity' });
      await patchMaster(`/v1/timesheet/jobs/${m.jobId}`, { name: 'Renamed synthetic job' });
      expect(await figures()).toEqual(before);

      const later = await openWeek(h, w.employee, week(9));
      expect((await addLine(h, w.employee, later.id, lineOf(m, week(9)))).statusCode).toBe(201);
      expect((await sheet(h, w.employee, later.id)).lines).toMatchObject([{ productive: false, source: 'MANUAL' }]);
    });
  });
});
