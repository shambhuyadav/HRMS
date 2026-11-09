// Independent authorised reopen and reports over HTTP (FR-047, FR-048; F1 timesheets "corrections need independent
// authorised reopen with history" and utilisation; DF03; C4; BR-048 revision identity; ZT07/ZT10). Synthetic data.
// Fixed past weeks keep the utilisation figures exact: 2026-03-02 is a Monday; 2026-03-04 is a location holiday.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { addLine, allocate, approvedWeek, decide, sheet, submit, taskFor, type TimesheetWorld, timesheetWorld } from './timesheet.fixtures.js';

const W1 = '2026-03-02';
const W2 = '2026-03-09';
const W3 = '2026-03-16';

describe.runIf(isModuleActive('timesheet'))('timesheet: reopen and reports', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let w: TimesheetWorld;
  let bHr: TestActor;
  let hrFin: TestActor;
  let sheet1: string;
  let reopenId: string;

  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];
  const line = (workDate: string, extra: Record<string, unknown> = {}) => ({ workDate, jobId: w.jobId, activityId: w.devId, minutes: 480, ...extra });
  const reopenTaskFor = async (a: TestActor, id: string) =>
    ((await h.call(a, 'GET', '/v1/timesheet-reopen-tasks')).json().items as { taskId: string; request: { id: string } | null }[]).find((t) => t.request?.id === id)?.taskId;
  const decideReopen = (a: TestActor, taskId: string, decision: 'APPROVE' | 'REJECT', extra: Record<string, unknown> = {}) =>
    h.call(a, 'POST', `/v1/timesheet-reopen-tasks/${taskId}/decision`, { decision, idempotencyKey: uniq('reopen-key-'), ...extra });
  const utilisation = async (a: TestActor, query: string) => (await h.call(a, 'GET', `/v1/timesheet-reports/utilisation?${query}`)).json();

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    w = await timesheetWorld(h, A);
    bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    expect((await allocate(h, w.hr, { employeeId: w.employeeEmp, jobId: w.jobId })).statusCode).toBe(201);
    expect((await allocate(h, w.hr, { employeeId: w.peerEmp, jobId: w.jobId })).statusCode).toBe(201);
    // DF05 default shift: 09:00-18:00 with a 60-minute unpaid break (480 net minutes); the peer has no shift.
    const shift = await h.call(w.hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day shift', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] });
    expect(shift.statusCode, shift.body).toBe(201);
    expect((await h.call(w.hr, 'POST', `/v1/employees/${w.employeeEmp}/shift`, { shiftId: shift.json().id, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    expect((await h.call(w.hr, 'POST', '/v1/holidays', { locationId: A.loc, holidayDate: '2026-03-04', name: 'Synthetic holiday' })).statusCode).toBe(201);
    // W1: 1440 productive minutes (480 + 240 + 600 + weekend 120) and a 240-minute internal meeting.
    sheet1 = await approvedWeek(h, w, w.employee, W1, [
      line(W1),
      line('2026-03-03', { minutes: 240 }),
      line('2026-03-03', { activityId: w.meetId, minutes: 240 }),
      line('2026-03-05', { minutes: 600 }),
      line('2026-03-07', { minutes: 120 }),
    ]);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('computes utilisation from approved productive hours and scheduled hours of the shift and calendar (F1)', async () => {
    const report = await utilisation(w.hr, `from=${W1}&to=2026-03-08`);
    // Scheduled: Monday-Friday minus the Wednesday holiday = 4 x 480 = 1920; 1440 / 1920 x 100 = 75.00.
    const mine = report.items.find((i: { employeeId: string }) => i.employeeId === w.employeeEmp);
    expect(mine).toMatchObject({ status: 'OK', approvedMinutes: 1680, productiveMinutes: 1440, scheduledMinutes: 1920, utilisationPercent: '75.00' });
    // No shift on a working day: the schedule is unknown, so no figure is guessed.
    const peer = report.items.find((i: { employeeId: string }) => i.employeeId === w.peerEmp);
    expect(peer).toMatchObject({ status: 'NOT_CONFIGURED', reason: 'NO_SHIFT_ASSIGNED', unscheduledDays: 4, utilisationPercent: null });
    // A zero denominator gives N/A: the weekend only, or before the employment started.
    expect((await utilisation(w.hr, `from=2026-03-07&to=2026-03-08&employeeId=${w.employeeEmp}`)).items[0]).toMatchObject({ status: 'NOT_APPLICABLE', display: 'N/A', productiveMinutes: 120 });
    expect((await utilisation(w.hr, `from=2025-12-01&to=2025-12-31&employeeId=${w.employeeEmp}`)).items[0]).toMatchObject({ status: 'NOT_APPLICABLE', scheduledMinutes: 0 });
    // Row scope: the manager sees the team, a filtered HR assignment and another company see nobody.
    expect((await utilisation(w.manager, `from=${W1}&to=2026-03-08`)).items.map((i: { employeeId: string }) => i.employeeId).sort()).toEqual([w.employeeEmp, w.peerEmp].sort());
    expect((await utilisation(hrFin, `from=${W1}&to=2026-03-08`)).items).toEqual([]);
    expect((await utilisation(bHr, `from=${W1}&to=2026-03-08`)).items).toEqual([]);
    expect((await h.call(w.employee, 'GET', `/v1/timesheet-reports/utilisation?from=${W1}&to=2026-03-08`)).statusCode).toBe(403);
    expect((await h.call(w.hr, 'GET', '/v1/timesheet-reports/utilisation?from=2026-01-01&to=2027-01-02')).json().error).toBe('RANGE_TOO_LONG');
  });

  it('reopens an approved timesheet only through an independent HR decision, keeping the approved revision', async () => {
    // Nothing else reopens it: not the employee's own edit, not a draft request.
    expect((await addLine(h, w.employee, sheet1, line('2026-03-06'))).json().error).toBe('TIMESHEET_NOT_EDITABLE');
    expect((await h.call(w.peer, 'POST', `/v1/timesheets/${sheet1}/reopen-requests`, { reason: 'x' })).statusCode).toBe(404);
    expect((await h.call(bHr, 'POST', `/v1/timesheets/${sheet1}/reopen-requests`, { reason: 'x' })).statusCode).toBe(404);
    // Independence: the only listed reviewer cannot decide a request they made themselves (no auto-approval).
    const ownRequest = await h.call(w.hrReviewer, 'POST', `/v1/timesheets/${sheet1}/reopen-requests`, { reason: 'Synthetic HR correction' });
    expect([ownRequest.statusCode, ownRequest.json().error]).toEqual([422, 'NO_ELIGIBLE_REVIEWER']);

    const requested = await h.call(w.employee, 'POST', `/v1/timesheets/${sheet1}/reopen-requests`, { reason: 'Thursday was booked 2 hours too long (synthetic)' });
    expect(requested.statusCode, requested.body).toBe(201);
    reopenId = requested.json().reopenRequestId;
    expect(requested.json()).toMatchObject({ timesheetId: sheet1, approvedRevision: 1, state: 'SUBMITTED' });
    expect((await h.call(w.manager, 'POST', `/v1/timesheets/${sheet1}/reopen-requests`, { reason: 'Again' })).json().error).toBe('REOPEN_PENDING');
    // The manager who approved the timesheet is never the reopen reviewer (no reopen duty either); the listed HR
    // reviewer is.
    expect((await h.call(w.manager, 'GET', '/v1/timesheet-reopen-tasks')).statusCode).toBe(403);
    const reopenTask = await h.one<{ assignee: string }>(
      `select t.assignee_user_id as assignee from approval_task t join approval_instance i on i.id = t.instance_id
         join timesheet_reopen_request r on r.transaction_id = i.transaction_id where r.id = $1`,
      [reopenId],
    );
    expect(reopenTask.assignee).toBe(w.hrReviewer.user);
    const taskId = (await reopenTaskFor(w.hrReviewer, reopenId))!;
    expect(taskId).toBeDefined();
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(w.hrReviewer)).some((n) => n.category === 'TIMESHEET_REOPEN_SUBMITTED' && n.body.includes(`for ${W1} to 2026-03-08`))).toBe(true);
    expect((await decideReopen(w.hrReviewer, taskId, 'REJECT')).json().error).toBe('REASON_REQUIRED');
    const key = uniq('reopen-key-');
    const approved = await h.call(w.hrReviewer, 'POST', `/v1/timesheet-reopen-tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key });
    expect(approved.json()).toEqual({ reopenRequestId: reopenId, timesheetId: sheet1, state: 'APPROVED', newRevision: 2, replayed: false });
    expect((await h.call(w.hrReviewer, 'POST', `/v1/timesheet-reopen-tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key })).json()).toMatchObject({ replayed: true });

    // The correction is a new draft revision with the approved lines carried over; revision 1 stays approved and in
    // force until the correction is approved.
    let s = await sheet(h, w.employee, sheet1);
    expect(s).toMatchObject({ state: 'DRAFT', currentRevision: 2, approvedRevision: 1 });
    expect(s.revisions.map((r) => [r.revision, r.origin, r.state])).toEqual([
      [1, 'INITIAL', 'APPROVED'],
      [2, 'REOPENED', 'DRAFT'],
    ]);
    expect((await utilisation(w.hr, `from=${W1}&to=2026-03-08&employeeId=${w.employeeEmp}`)).items[0].utilisationPercent).toBe('75.00');
    const thursday = s.lines.find((l) => l.workDate === '2026-03-05')!;
    expect(thursday.source).toBe('CARRIED');
    expect((await h.call(w.employee, 'PUT', `/v1/me/timesheets/${sheet1}/lines/${thursday.id}`, { expectedVersion: thursday.version, minutes: 480 })).statusCode).toBe(200);
    expect((await submit(h, w.employee, sheet1)).json()).toMatchObject({ state: 'SUBMITTED', revision: 2, late: true });
    // BR-048: one approved revision is in force; a correction approved without superseding the original is refused.
    await expect(
      h.db.query(`update timesheet_revision set state = 'APPROVED', decided_at = now(), decided_by = $2 where timesheet_id = $1 and revision = 2`, [sheet1, w.manager.user]),
    ).rejects.toMatchObject({ code: '23P01' });
    expect((await decide(h, w.manager, (await taskFor(h, w.manager, sheet1))!, 'APPROVE')).json()).toMatchObject({ state: 'APPROVED', revision: 2 });

    s = await sheet(h, w.employee, sheet1);
    expect(s).toMatchObject({ state: 'APPROVED', currentRevision: 2, approvedRevision: 2 });
    // BR-048: original and corrected revisions both stay approved and identifiable; the original names its successor.
    expect(s.revisions.map((r) => [r.revision, r.state, r.supersededByRevision, r.totalMinutes])).toEqual([
      [1, 'APPROVED', 2, 1680],
      [2, 'APPROVED', null, 1560],
    ]);
    expect((await sheet(h, w.employee, sheet1, 1)).lines.find((l) => l.workDate === '2026-03-05')!.minutes).toBe(600);
    await expect(h.db.query(`update timesheet_line set minutes = 450 where timesheet_id = $1 and revision = 1`, [sheet1])).rejects.toMatchObject({ code: '23514' });
    // The revision in force is superseded only by a later approved revision of the same timesheet.
    await expect(
      h.db.query(`update timesheet_revision set superseded_at = now(), superseded_by_revision = 3 where timesheet_id = $1 and revision = 2`, [sheet1]),
    ).rejects.toMatchObject({ code: '23514' });
    expect((await utilisation(w.hr, `from=${W1}&to=2026-03-08&employeeId=${w.employeeEmp}`)).items[0]).toMatchObject({ productiveMinutes: 1320, utilisationPercent: '68.75' });

    await dispatchOutbox(h.pool, 500);
    expect((await inbox(w.employee)).find((n) => n.category === 'TIMESHEET_REOPEN_DECIDED')!.body).toBe(`The request to reopen your timesheet for ${W1} to 2026-03-08 was approved.`);
    const audit = (await h.db.query<{ action: string }>(`select action from audit_event where resource_code = 'timesheet_reopen_request' and record_key = $1 order by occurred_at`, [reopenId])).rows;
    expect(audit.map((a) => a.action)).toEqual(['SUBMIT', 'APPROVE']);
  });

  it('keeps the approved timesheet when the reopen is rejected; the requester is told; races decide once', async () => {
    const sheet2 = await approvedWeek(h, w, w.employee, W2, [line(W2), line('2026-03-10')]);
    // A manager in scope may ask too; the outcome reaches both the employee and the requesting manager.
    const requested = await h.call(w.manager, 'POST', `/v1/timesheets/${sheet2}/reopen-requests`, { reason: 'Synthetic double booking check' });
    expect(requested.statusCode, requested.body).toBe(201);
    const taskId = (await reopenTaskFor(w.hrReviewer, requested.json().reopenRequestId))!;
    const [a, b] = await Promise.all([decideReopen(w.hrReviewer, taskId, 'REJECT', { reason: 'Entries match the plan (synthetic)' }), decideReopen(w.hrReviewer, taskId, 'APPROVE')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const winner = [a, b].find((r) => r.statusCode === 200)!.json();
    const s = await sheet(h, w.employee, sheet2);
    if (winner.state === 'REJECTED') {
      expect(s).toMatchObject({ state: 'APPROVED', currentRevision: 1, approvedRevision: 1 });
      await dispatchOutbox(h.pool, 500);
      expect((await inbox(w.manager)).some((n) => n.category === 'TIMESHEET_REOPEN_DECIDED' && n.body.startsWith('Your request to reopen the timesheet of') && n.body.endsWith('was rejected.'))).toBe(true);
    } else {
      expect(s).toMatchObject({ state: 'DRAFT', currentRevision: 2, approvedRevision: 1 });
    }
    expect(Number((await h.one<{ n: string }>(`select count(*) as n from timesheet_reopen_request where timesheet_id = $1`, [sheet2])).n)).toBe(1);
    // Only an approved timesheet is reopened.
    const draft = await h.call(w.employee, 'POST', '/v1/me/timesheets', { periodStart: W3 });
    expect((await h.call(w.employee, 'POST', `/v1/timesheets/${draft.json().id}/reopen-requests`, { reason: 'x' })).json().error).toBe('INVALID_STATE');
  });

  it('reports hours by employee, project, job, activity and week that reconcile to the approved lines (FR-048)', async () => {
    const hours = (await h.call(w.hr, 'GET', `/v1/timesheet-reports/hours?from=${W1}&to=2026-03-08&groupBy=employee,activity`)).json();
    expect(hours.basis).toBe('APPROVED');
    // Only the approved revision in force counts (revision 2 of W1, not the superseded revision 1).
    expect(hours.groups.map((g: { activityId: string; minutes: number; hours: string; lineCount: number }) => [g.activityId, g.minutes, g.hours, g.lineCount])).toEqual([
      [w.devId, 1320, '22.00', 4],
      [w.meetId, 240, '4.00', 1],
    ]);
    expect(hours.totals).toEqual({ minutes: 1560, hours: '26.00', productiveMinutes: 1320, lineCount: 5 });
    for (const groupBy of ['employee', 'project', 'job', 'activity', 'period', 'project,job,activity,period']) {
      const r = (await h.call(w.hr, 'GET', `/v1/timesheet-reports/hours?from=${W1}&to=2026-03-15&groupBy=${groupBy}`)).json();
      const sum = r.groups.reduce((n: number, g: { minutes: number }) => n + g.minutes, 0);
      const lines = r.groups.reduce((n: number, g: { lineCount: number }) => n + g.lineCount, 0);
      expect([sum, lines], groupBy).toEqual([r.totals.minutes, r.totals.lineCount]);
    }
    const detail = (await h.call(w.hr, 'GET', `/v1/timesheet-reports/lines?from=${W1}&to=2026-03-08`)).json().items as { minutes: number; revision: number }[];
    expect(detail.reduce((n, l) => n + l.minutes, 0)).toBe(1560);
    expect(detail.every((l) => l.revision === 2)).toBe(true);
    const byPeriod = (await h.call(w.manager, 'GET', `/v1/timesheet-reports/hours?from=${W1}&to=2026-03-15&groupBy=period`)).json();
    // W2's approved revision stays in force whether or not its reopen was approved.
    expect(byPeriod.groups.map((g: { periodStart: string; minutes: number }) => [g.periodStart, g.minutes])).toEqual([
      [W1, 1560],
      [W2, 960],
    ]);
    // Filters and scope.
    expect((await h.call(w.hr, 'GET', `/v1/timesheet-reports/hours?from=${W1}&to=2026-03-08&groupBy=job&activityId=${w.meetId}`)).json().totals.minutes).toBe(240);
    expect((await h.call(hrFin, 'GET', `/v1/timesheet-reports/hours?from=${W1}&to=2026-03-08&groupBy=employee`)).json().totals).toEqual({ minutes: 0, hours: '0.00', productiveMinutes: 0, lineCount: 0 });
    expect((await h.call(bHr, 'GET', `/v1/timesheet-reports/hours?from=${W1}&to=2026-03-08&groupBy=employee`)).json().groups).toEqual([]);
    expect((await h.call(w.hr, 'GET', `/v1/timesheet-reports/hours?from=${W1}&to=2026-03-08&groupBy=salary`)).statusCode).toBe(400);
    expect((await h.call(w.employee, 'GET', `/v1/timesheet-reports/hours?from=${W1}&to=2026-03-08&groupBy=employee`)).statusCode).toBe(403);
  });
});
