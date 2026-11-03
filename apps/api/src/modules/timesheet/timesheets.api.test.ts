// Timesheet entry, submission, review and locking over HTTP (FR-047; DB070/DB071; F1 timesheets; DF02; DF03; DF08;
// DF12; C4; CI12; CI14; ZT06/ZT07/ZT08/ZT10/ZT11), with the caller's own line-import batches and resuming one held for
// the malware scan (FR-106). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { followUpSuite } from '../imports/follow-up.fixtures.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { addDays, isoWeekday } from './common.js';
import { TIMESHEET_EVENTS } from './events.js';
import { addLine, allocate, csv, decide, openWeek, person, sheet, submit, taskFor, type TimesheetWorld, timesheetWorld } from './timesheet.fixtures.js';

describe.runIf(isModuleActive('timesheet'))('timesheet: entry, review and locking', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let w: TimesheetWorld;
  let bHr: TestActor;
  let hrFin: TestActor;
  let weekA: string;
  let sheetA: string;

  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];
  const line = (workDate: string, extra: Record<string, unknown> = {}) => ({ workDate, jobId: w.jobId, activityId: w.devId, minutes: 480, ...extra });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    w = await timesheetWorld(h, A);
    bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    for (const jobId of [w.jobId, w.job2Id]) expect((await allocate(h, w.hr, { employeeId: w.employeeEmp, jobId, allocationPercent: '50' })).statusCode).toBe(201);
    expect((await allocate(h, w.hr, { employeeId: w.peerEmp, jobId: w.jobId })).statusCode).toBe(201);
    weekA = addDays(w.lastMonday, -7);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('opens one timesheet per employee and Monday-Sunday week, in the Employee OWN context', async () => {
    expect((await h.call(w.employee, 'POST', '/v1/me/timesheets', { periodStart: addDays(weekA, 1) })).json().error).toBe('INVALID_PERIOD');
    expect((await h.call(w.employee, 'POST', '/v1/me/timesheets', { periodStart: addDays(w.thisMonday, 7) })).json().error).toBe('PERIOD_IN_FUTURE');
    expect((await h.call(w.employee, 'POST', '/v1/me/timesheets', { periodStart: '2025-12-29' })).json().error).toBe('OUTSIDE_EMPLOYMENT');
    const created = await openWeek(h, w.employee, weekA);
    sheetA = created.id;
    expect(created).toMatchObject({ periodStart: weekA, periodEnd: addDays(weekA, 6), dueDate: addDays(weekA, 7), state: 'DRAFT', currentRevision: 1, approvedRevision: null, lines: [] });
    const again = await h.call(w.employee, 'POST', '/v1/me/timesheets', { periodStart: weekA });
    expect([again.statusCode, again.json().error, again.json().details]).toEqual([409, 'TIMESHEET_EXISTS', { timesheetId: sheetA }]);
    // Entry and submission are own-ESS duties of the Employee role only.
    expect((await h.call(w.manager, 'POST', '/v1/me/timesheets', { periodStart: weekA })).statusCode).toBe(403);
    expect((await h.call(w.hr, 'GET', '/v1/me/timesheets')).json().error).toBe('EMPLOYEE_CONTEXT_REQUIRED');
    // The database holds the week shape and the uniqueness itself (ZT07/ZT08).
    await expect(h.db.query(`update timesheet set period_start = period_start + 7 where id = $1`, [sheetA])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`delete from timesheet where id = $1`, [sheetA])).rejects.toMatchObject({ code: '23514' });
  });

  it('records lines only within the week, employment, an active allocation and permitted active masters, in quarter hours (F1)', async () => {
    const ok = await addLine(h, w.employee, sheetA, line(weekA, { note: 'Synthetic build work' }));
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json().lines).toEqual([expect.objectContaining({ workDate: weekA, jobId: w.jobId, activityId: w.devId, minutes: 480, productive: true, note: 'Synthetic build work', source: 'MANUAL' })]);
    // Quarter hours, positive (schema), and the same rule in the database.
    expect((await addLine(h, w.employee, sheetA, line(weekA, { minutes: 20, activityId: w.meetId }))).statusCode).toBe(400);
    expect((await addLine(h, w.employee, sheetA, line(weekA, { minutes: 0, activityId: w.meetId }))).statusCode).toBe(400);
    expect((await addLine(h, w.employee, sheetA, line(addDays(weekA, 7)))).json().error).toBe('OUTSIDE_PERIOD');
    // The peer is allocated to the build job only.
    const peerSheet = await openWeek(h, w.peer, weekA);
    expect((await addLine(h, w.peer, peerSheet.id, line(weekA, { jobId: w.job2Id }))).json().error).toBe('NO_ACTIVE_ALLOCATION');
    expect((await addLine(h, w.employee, sheetA, line(weekA, { jobId: '00000000-0000-4000-8000-000000000000' }))).json().error).toBe('UNKNOWN_JOB');
    // An activity the job does not permit, an inactive one and one outside its period.
    const activity = async (body: Record<string, unknown>, link: boolean) => {
      const a = await h.call(w.hr, 'POST', '/v1/timesheet/activities', { code: uniq('ACT'), name: 'Synthetic activity', ownerEmployeeId: w.managerEmp, startDate: '2026-01-01', productive: true, ...body });
      if (link) await h.call(w.hr, 'PUT', `/v1/timesheet/jobs/${w.jobId}/activities/${a.json().id}`, { active: true });
      return a.json() as { id: string; version: number };
    };
    const unlinked = await activity({}, false);
    expect((await addLine(h, w.employee, sheetA, line(weekA, { activityId: unlinked.id }))).json().error).toBe('ACTIVITY_NOT_PERMITTED');
    const retired = await activity({}, true);
    await h.call(w.hr, 'PATCH', `/v1/timesheet/activities/${retired.id}`, { expectedVersion: retired.version, active: false });
    expect((await addLine(h, w.employee, sheetA, line(weekA, { activityId: retired.id }))).json().error).toBe('INACTIVE_MASTER');
    const later = await activity({ startDate: addDays(weekA, 3) }, true);
    expect((await addLine(h, w.employee, sheetA, line(weekA, { activityId: later.id }))).json().error).toBe('MASTER_OUT_OF_PERIOD');
    // Duplicate lines are rejected; a day holds at most 24 hours across all lines.
    expect((await addLine(h, w.employee, sheetA, line(weekA, { minutes: 60 }))).json().error).toBe('DUPLICATE_LINE');
    expect((await addLine(h, w.employee, sheetA, line(weekA, { activityId: w.meetId }))).statusCode).toBe(201);
    expect((await addLine(h, w.employee, sheetA, line(weekA, { jobId: w.job2Id }))).statusCode).toBe(201);
    const over = await addLine(h, w.employee, sheetA, line(weekA, { jobId: w.job2Id, activityId: w.meetId, minutes: 15 }));
    expect([over.statusCode, over.json().error, over.json().details]).toEqual([422, 'DAILY_LIMIT_EXCEEDED', { workDate: weekA, totalMinutes: 1455 }]);
    // Time is recorded for days already worked.
    if (isoWeekday(w.today) < 7) {
      const current = await openWeek(h, w.peer, w.thisMonday);
      expect((await addLine(h, w.peer, current.id, line(addDays(w.today, 1)))).json().error).toBe('WORK_DATE_IN_FUTURE');
    }

    // Edit and remove draft lines (versioned; a removed line is kept on record but no longer counts).
    let s = await sheet(h, w.employee, sheetA);
    expect(s.dailyTotals).toEqual([{ workDate: weekA, minutes: 1440, hours: '24.00' }]);
    const meeting = s.lines.find((l) => l.activityId === w.meetId)!;
    const edited = await h.call(w.employee, 'PUT', `/v1/me/timesheets/${sheetA}/lines/${meeting.id}`, { expectedVersion: meeting.version, minutes: 105, workDate: addDays(weekA, 1) });
    expect(edited.statusCode, edited.body).toBe(200);
    expect((await h.call(w.employee, 'PUT', `/v1/me/timesheets/${sheetA}/lines/${meeting.id}`, { expectedVersion: meeting.version, minutes: 30 })).json().error).toBe('STALE_VERSION');
    const support = s.lines.find((l) => l.jobId === w.job2Id)!;
    expect((await h.call(w.employee, 'POST', `/v1/me/timesheets/${sheetA}/lines/${support.id}/remove`)).statusCode).toBe(200);
    expect((await h.call(w.employee, 'PUT', `/v1/me/timesheets/${sheetA}/lines/${support.id}`, { expectedVersion: 2, minutes: 30 })).statusCode).toBe(404);
    s = await sheet(h, w.employee, sheetA);
    expect(s.dailyTotals).toEqual([
      { workDate: weekA, minutes: 480, hours: '8.00' },
      { workDate: addDays(weekA, 1), minutes: 105, hours: '1.75' },
    ]);
    expect(Number((await h.one<{ n: string }>(`select count(*) as n from timesheet_line where timesheet_id = $1 and removed_at is not null`, [sheetA])).n)).toBe(1);

    // The database refuses what the service refuses, whatever writes it (ZT08; F1 24-hour day).
    const ids = await h.one<{ project_id: string }>(`select project_id from timesheet_line where timesheet_id = $1 limit 1`, [sheetA]);
    const insertDirect = (minutes: number, activityId: string) =>
      h.db.query(
        `insert into timesheet_line (company_id, timesheet_id, employee_id, revision, period_start, work_date, project_id, job_id, activity_id, minutes, productive, source)
         values ($1, $2, $3, 1, $4, $4, $5, $6, $7, $8, true, 'MANUAL')`,
        [A.id, sheetA, w.employeeEmp, weekA, ids.project_id, w.job2Id, activityId, minutes],
      );
    // 975 minutes with the 480 already on that day exceeds 24 hours; 10 minutes is not a quarter hour.
    await expect(insertDirect(975, w.devId)).rejects.toMatchObject({ code: '23514' });
    await expect(insertDirect(10, w.devId)).rejects.toMatchObject({ code: '23514' });
    await expect(insertDirect(60, unlinked.id)).rejects.toMatchObject({ code: '23503' });
  });

  it('submits with the late flag, routes to the direct manager, and locks on approval', async () => {
    const stale = await h.call(w.employee, 'POST', `/v1/me/timesheets/${sheetA}/submit`, { expectedVersion: 1 });
    expect(stale.json().error).toBe('STALE_VERSION');
    const submitted = await submit(h, w.employee, sheetA);
    expect(submitted.statusCode, submitted.body).toBe(200);
    // Due by the following Monday: a submission after it is accepted and flagged late (no other effect).
    expect(submitted.json()).toEqual({ timesheetId: sheetA, revision: 1, state: 'SUBMITTED', late: true });
    expect((await addLine(h, w.employee, sheetA, line(addDays(weekA, 2)))).json().error).toBe('TIMESHEET_NOT_EDITABLE');

    // DF03: the direct manager decides; the HR fallback reviewer is not involved while the manager is eligible.
    const taskId = await taskFor(h, w.manager, sheetA);
    expect(taskId).toBeDefined();
    expect(await taskFor(h, w.hrReviewer, sheetA)).toBeUndefined();
    const tasks = (await h.call(w.manager, 'GET', '/v1/timesheet-tasks')).json().items as { taskId: string; timesheet: Record<string, unknown> }[];
    expect(tasks.find((t) => t.taskId === taskId)!.timesheet).toMatchObject({ employeeCode: w.employeeCode, periodStart: weekA, totalMinutes: 585, late: true, revisionLate: true });
    expect((await h.call(w.employee, 'GET', '/v1/timesheet-tasks')).statusCode).toBe(403);
    expect((await h.call(w.hrReviewer, 'POST', `/v1/timesheet-tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('ts-key-') })).statusCode).toBe(404);
    expect((await h.call(w.manager, 'POST', `/v1/timesheet-tasks/${taskId}/decision`, { decision: 'RETURN', idempotencyKey: uniq('ts-key-') })).json().error).toBe('REASON_REQUIRED');
    const key = uniq('ts-key-');
    const approved = await h.call(w.manager, 'POST', `/v1/timesheet-tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key });
    expect(approved.json()).toEqual({ timesheetId: sheetA, revision: 1, state: 'APPROVED', replayed: false });
    // ZT07: the same key replays without a second effect; on another task it is a conflict.
    expect((await h.call(w.manager, 'POST', `/v1/timesheet-tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key })).json()).toMatchObject({ state: 'APPROVED', replayed: true });
    expect((await h.call(w.manager, 'POST', `/v1/timesheet-tasks/${taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('ts-key-') })).json().error).toBe('TASK_CLOSED');

    const s = await sheet(h, w.employee, sheetA);
    expect(s).toMatchObject({ state: 'APPROVED', currentRevision: 1, approvedRevision: 1, late: true, pendingWith: null });
    expect(s.decisions).toEqual([expect.objectContaining({ revision: 1, decision: 'APPROVE' })]);
    // Locked: no edit, no revision without a reopen, and the database keeps the approved lines immutable.
    expect((await addLine(h, w.employee, sheetA, line(addDays(weekA, 2)))).json().error).toBe('TIMESHEET_NOT_EDITABLE');
    expect((await h.call(w.employee, 'POST', `/v1/me/timesheets/${sheetA}/revise`)).json().error).toBe('INVALID_STATE');
    await expect(h.db.query(`update timesheet_line set minutes = 60 where timesheet_id = $1`, [sheetA])).rejects.toMatchObject({ code: '23514' });
    await expect(h.db.query(`update timesheet_revision set decision_reason = 'changed' where timesheet_id = $1`, [sheetA])).rejects.toMatchObject({ code: '23514' });

    // This week's timesheet, submitted before its due date, is on time.
    const current = await openWeek(h, w.employee, w.thisMonday);
    expect((await addLine(h, w.employee, current.id, line(w.thisMonday, { minutes: 240 }))).statusCode).toBe(201);
    expect((await submit(h, w.employee, current.id)).json()).toMatchObject({ state: 'SUBMITTED', late: false });
  });

  it('keeps a returned or rejected revision and its reason; the employee continues in a linked new revision', async () => {
    const weekB = addDays(w.lastMonday, -14);
    const ts = await openWeek(h, w.employee, weekB);
    expect((await addLine(h, w.employee, ts.id, line(weekB))).statusCode).toBe(201);
    expect((await addLine(h, w.employee, ts.id, line(addDays(weekB, 1), { jobId: w.job2Id, minutes: 450 }))).statusCode).toBe(201);
    expect((await submit(h, w.employee, ts.id)).statusCode).toBe(200);
    const returned = await decide(h, w.manager, (await taskFor(h, w.manager, ts.id))!, 'RETURN', { reason: 'Split Tuesday between build and support (synthetic)' });
    expect(returned.json()).toMatchObject({ state: 'RETURNED', revision: 1 });
    // Submitted revisions are immutable: the employee revises into revision 2 with the lines carried over.
    expect((await addLine(h, w.employee, ts.id, line(addDays(weekB, 2)))).json().error).toBe('TIMESHEET_NOT_EDITABLE');
    const revised = await h.call(w.employee, 'POST', `/v1/me/timesheets/${ts.id}/revise`);
    expect(revised.statusCode, revised.body).toBe(201);
    expect(revised.json()).toMatchObject({ state: 'DRAFT', currentRevision: 2 });
    expect(revised.json().lines.map((l: { source: string }) => l.source)).toEqual(['CARRIED', 'CARRIED']);
    const tuesday = (revised.json().lines as { id: string; workDate: string; version: number }[]).find((l) => l.workDate === addDays(weekB, 1))!;
    expect((await h.call(w.employee, 'PUT', `/v1/me/timesheets/${ts.id}/lines/${tuesday.id}`, { expectedVersion: tuesday.version, minutes: 240 })).statusCode).toBe(200);
    expect((await addLine(h, w.employee, ts.id, line(addDays(weekB, 1), { minutes: 210 }))).statusCode).toBe(201);
    expect((await submit(h, w.employee, ts.id)).json()).toMatchObject({ state: 'SUBMITTED', revision: 2 });
    // Each revision has its own approval; the rejected revision keeps its reason (FR-047).
    const rejected = await decide(h, w.manager, (await taskFor(h, w.manager, ts.id))!, 'REJECT', { reason: 'Support was not planned that week (synthetic)' });
    expect(rejected.json()).toMatchObject({ state: 'REJECTED', revision: 2 });
    const third = await h.call(w.employee, 'POST', `/v1/me/timesheets/${ts.id}/revise`);
    expect(third.json()).toMatchObject({ state: 'DRAFT', currentRevision: 3 });
    expect((await submit(h, w.employee, ts.id)).statusCode).toBe(200);
    expect((await decide(h, w.manager, (await taskFor(h, w.manager, ts.id))!, 'APPROVE')).json()).toMatchObject({ state: 'APPROVED', revision: 3 });

    const s = await sheet(h, w.employee, ts.id);
    expect(s.revisions.map((r) => [r.revision, r.origin, r.state, r.decisionReason, r.totalMinutes])).toEqual([
      [1, 'INITIAL', 'RETURNED', 'Split Tuesday between build and support (synthetic)', 930],
      [2, 'RETURNED', 'REJECTED', 'Support was not planned that week (synthetic)', 930],
      [3, 'REJECTED', 'APPROVED', null, 930],
    ]);
    expect(s.decisions.map((d) => [d.revision, d.decision])).toEqual([
      [1, 'RETURN'],
      [2, 'REJECT'],
      [3, 'APPROVE'],
    ]);
    // History: each revision's lines stay readable as they were submitted.
    expect((await sheet(h, w.employee, ts.id, 1)).lines.map((l) => l.minutes)).toEqual([480, 450]);
    expect((await sheet(h, w.employee, ts.id, 2)).lines.map((l) => l.minutes).sort()).toEqual([210, 240, 480]);
    // The bookkeeping agrees with the engine (CI02/CI12): one approval instance per revision.
    const instances = await h.db.query<{ transaction_revision: number; state: string }>(
      `select i.transaction_revision, i.state from approval_instance i join timesheet t on t.transaction_id = i.transaction_id where t.id = $1 order by i.transaction_revision`,
      [ts.id],
    );
    expect(instances.rows.map((r) => [r.transaction_revision, r.state])).toEqual([
      [1, 'RETURNED'],
      [2, 'REJECTED'],
      [3, 'APPROVED'],
    ]);
  });

  it('routes to the HR fallback list when there is no eligible manager; nobody decides their own timesheet', async () => {
    const lone = await person(h, A, w.hr);
    expect((await allocate(h, w.hr, { employeeId: lone.id, jobId: w.jobId })).statusCode).toBe(201);
    const loneActor = await h.actor(A, 'EMPLOYEE', { employeeId: lone.id });
    // The same person also holds an HR assignment and heads the fallback list: they are still never their own reviewer.
    const loneHr = await h.actor(A, 'HR_ADMINISTRATOR', { user: loneActor.user });
    const setList = (reviewers: { userId: string; priority: number }[]) => h.call(w.hr, 'PUT', '/v1/workflows/timesheet/fallback-reviewers', { reviewers });
    expect((await setList([{ userId: loneHr.user, priority: 1 }, { userId: w.hrReviewer.user, priority: 2 }])).statusCode).toBe(200);
    const ts = await openWeek(h, loneActor, w.lastMonday);
    expect((await addLine(h, loneActor, ts.id, line(w.lastMonday))).statusCode).toBe(201);
    expect((await submit(h, loneActor, ts.id)).statusCode).toBe(200);
    expect(await taskFor(h, loneHr, ts.id)).toBeUndefined();
    const taskId = await taskFor(h, w.hrReviewer, ts.id);
    expect(taskId).toBeDefined();
    expect((await decide(h, w.hrReviewer, taskId!, 'APPROVE')).json().state).toBe('APPROVED');
    expect((await setList([{ userId: w.hrReviewer.user, priority: 1 }])).statusCode).toBe(200);
  });

  it('serialises parallel writes: the 24-hour day and a single submission and decision hold under races', async () => {
    const weekC = addDays(w.lastMonday, -21);
    const ts = await openWeek(h, w.employee, weekC);
    const [a, b] = await Promise.all([
      addLine(h, w.employee, ts.id, line(weekC, { minutes: 765 })),
      addLine(h, w.employee, ts.id, line(weekC, { jobId: w.job2Id, minutes: 765 })),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 422]);
    expect([a, b].find((r) => r.statusCode === 422)!.json().error).toBe('DAILY_LIMIT_EXCEEDED');
    const { version } = await sheet(h, w.employee, ts.id);
    const submits = await Promise.all([1, 2].map(() => h.call(w.employee, 'POST', `/v1/me/timesheets/${ts.id}/submit`, { expectedVersion: version })));
    expect(submits.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const taskId = (await taskFor(h, w.manager, ts.id))!;
    const decisions = await Promise.all([decide(h, w.manager, taskId, 'APPROVE'), decide(h, w.manager, taskId, 'RETURN')]);
    expect(decisions.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect(Number((await h.one<{ n: string }>(`select count(*) as n from approval_decision where task_id = $1`, [taskId])).n)).toBe(1);
  });

  it('keeps a line out of a revision that another connection is submitting, whatever writes it (BR-048 immutability)', async () => {
    const weekE = addDays(w.lastMonday, -35);
    const ts = await openWeek(h, w.peer, weekE);
    const project = await h.one<{ project_id: string }>(`select project_id from timesheet_job where id = $1`, [w.jobId]);
    const submitter = await h.pool.connect();
    const writer = await h.pool.connect();
    try {
      await submitter.query('begin');
      await submitter.query(
        `update timesheet_revision set state = 'SUBMITTED', submitted_at = now(), submitted_by = $2, submitted_on = current_date, late = false where timesheet_id = $1 and revision = 1`,
        [ts.id, w.peer.user],
      );
      // The writer reaches the line guard while the submission is uncommitted, waits for it, then sees SUBMITTED.
      const insert = writer
        .query(
          `insert into timesheet_line (company_id, timesheet_id, employee_id, revision, period_start, work_date, project_id, job_id, activity_id, minutes, productive, source)
           values ($1, $2, $3, 1, $4, $4, $5, $6, $7, 60, true, 'MANUAL')`,
          [A.id, ts.id, w.peerEmp, weekE, project.project_id, w.jobId, w.devId],
        )
        .then(
          () => 'inserted',
          (err: { code?: string }) => err.code,
        );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await submitter.query('commit');
      expect(await insert).toBe('23514');
    } finally {
      submitter.release();
      writer.release();
    }
  });

  it('shows timesheets only within scope: other employees, other teams and other companies read nothing', async () => {
    expect((await h.call(w.peer, 'GET', `/v1/timesheets/${sheetA}`)).statusCode).toBe(404);
    expect((await h.call(w.peer, 'POST', `/v1/me/timesheets/${sheetA}/lines`, line(weekA))).statusCode).toBe(404);
    expect((await h.call(hrFin, 'GET', `/v1/timesheets/${sheetA}`)).statusCode).toBe(404);
    expect((await h.call(bHr, 'GET', `/v1/timesheets/${sheetA}`)).statusCode).toBe(404);
    expect((await h.call(w.employee, 'GET', `/v1/timesheets/00000000-0000-4000-8000-000000000000`)).statusCode).toBe(404);
    expect((await h.call(w.employee, 'GET', `/v1/timesheets/${sheetA}?revision=9`)).statusCode).toBe(404);
    // The employee's list is their own; the manager's is the team's; HR's is the company's within its filter.
    const own = (await h.call(w.employee, 'GET', '/v1/timesheets')).json().items as { employeeId: string }[];
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((t) => t.employeeId === w.employeeEmp)).toBe(true);
    const team = (await h.call(w.manager, 'GET', `/v1/timesheets?from=${weekA}&to=${addDays(weekA, 6)}`)).json().items as { employeeId: string }[];
    expect(team.map((t) => t.employeeId).sort()).toEqual([w.employeeEmp, w.peerEmp].sort());
    expect((await h.call(hrFin, 'GET', '/v1/timesheets')).json().items).toEqual([]);
    expect((await h.call(bHr, 'GET', '/v1/timesheets')).json().items).toEqual([]);
    // Denials are audited without payload.
    const denied = await h.one<{ n: string }>(`select count(*) as n from audit_event where action = 'ACCESS_DENIED' and resource_code = 'timesheet'`);
    expect(Number(denied.n)).toBeGreaterThan(0);
    // Altered ids: a line is only ever addressed through its own timesheet and revision.
    const weekE = addDays(w.lastMonday, -35);
    const other = await openWeek(h, w.employee, weekE);
    const added = await addLine(h, w.employee, other.id, line(weekE));
    const lineId = added.json().lineId as string;
    const otherDraft = await openWeek(h, w.employee, addDays(weekE, -7));
    expect((await h.call(w.employee, 'PUT', `/v1/me/timesheets/${otherDraft.id}/lines/${lineId}`, { expectedVersion: 1, minutes: 60 })).statusCode).toBe(404);
    expect((await h.call(w.employee, 'POST', `/v1/me/timesheets/${otherDraft.id}/lines/${lineId}/remove`)).statusCode).toBe(404);
    expect((await h.call(w.peer, 'POST', `/v1/me/timesheets/${other.id}/lines/${lineId}/remove`)).statusCode).toBe(404);
    // A deactivated job-activity link stops new entries; existing entries keep it (the link row is never deleted).
    expect((await h.call(w.hr, 'PUT', `/v1/timesheet/jobs/${w.jobId}/activities/${w.devId}`, { active: false })).json().activities.find((a: { activityId: string }) => a.activityId === w.devId).linkActive).toBe(false);
    expect((await addLine(h, w.employee, other.id, line(addDays(weekE, 1)))).json().error).toBe('ACTIVITY_NOT_PERMITTED');
    expect((await sheet(h, w.employee, other.id)).lines).toHaveLength(1);
    expect((await h.call(w.hr, 'PUT', `/v1/timesheet/jobs/${w.jobId}/activities/${w.devId}`, { active: true })).statusCode).toBe(200);
    expect((await addLine(h, w.employee, other.id, line(addDays(weekE, 1)))).statusCode).toBe(201);
  });

  it('describes notification events defensively: malformed or stale payloads produce nothing', async () => {
    const event = (topic: string, payload: Record<string, unknown>) => TIMESHEET_EVENTS[topic]!(h.db, { companyId: A.id, topic, aggregateId: sheetA, payload });
    expect(await event('timesheet.submitted', { timesheetId: 'not-a-uuid', revision: 1, taskId: 'x' })).toBeNull();
    expect(await event('timesheet.decided', { timesheetId: sheetA, revision: 99, outcome: 'APPROVED' })).toBeNull();
    expect(await event('timesheet.decided', { timesheetId: sheetA, revision: 1, outcome: 'SOMETHING' })).toBeNull();
    expect(await event('timesheet_reopen.decided', { reopenRequestId: '00000000-0000-4000-8000-000000000000', outcome: 'APPROVED' })).toBeNull();
    expect(await event('timesheet.missing', { exceptionId: 42 })).toBeNull();
    // Another company's event never describes this company's timesheet.
    expect(await TIMESHEET_EVENTS['timesheet.decided']!(h.db, { companyId: B.id, topic: 'timesheet.decided', aggregateId: sheetA, payload: { timesheetId: sheetA, revision: 1, outcome: 'APPROVED' } })).toBeNull();
    expect(await event('timesheet.decided', { timesheetId: sheetA, revision: 1, outcome: 'APPROVED' })).toMatchObject({ eventType: 'TIMESHEET_DECIDED', subjectEmployeeId: w.employeeEmp, data: { outcome: 'approved' } });
  });

  it('writes operational audit and outbox records and notifies the reviewer and the employee', async () => {
    const events = (await h.db.query<{ topic: string; payload: Record<string, unknown> }>(`select topic, payload from outbox_event where topic like 'timesheet%' and aggregate_id = $1 order by created_at, seq`, [sheetA])).rows;
    expect(events.map((e) => e.topic)).toEqual(['timesheet.submitted', 'timesheet.decided']);
    expect(Object.keys(events[0]!.payload).sort()).toEqual(['revision', 'taskId', 'timesheetId']);
    expect(events[1]!.payload).toEqual({ timesheetId: sheetA, revision: 1, outcome: 'APPROVED' });
    const audits = (await h.db.query<{ action: string; before_values: Record<string, unknown> | null; after_values: Record<string, unknown> }>(
      `select action, before_values, after_values from audit_event where resource_code = 'timesheet' and record_key = $1 order by occurred_at, action`,
      [sheetA],
    )).rows;
    expect(audits.map((a) => a.action)).toEqual(['CREATE', 'SUBMIT', 'APPROVE']);
    expect(audits.every((a) => Object.keys(a.after_values).every((k) => k === 'operational'))).toBe(true);
    await dispatchOutbox(h.pool, 500);
    // A reviewer notice is delivered while the reviewer still holds the open task (this week's timesheet).
    const managerNotes = (await inbox(w.manager)).filter((n) => n.category === 'TIMESHEET_SUBMITTED');
    expect(managerNotes.some((n) => n.body.includes(`(${w.employeeCode}) for ${w.thisMonday} to ${addDays(w.thisMonday, 6)} (revision 1, 4.00 hours)`))).toBe(true);
    const employeeNotes = (await inbox(w.employee)).filter((n) => n.category === 'TIMESHEET_DECIDED');
    expect(employeeNotes.map((n) => n.body)).toContain(`Your timesheet for ${weekA} to ${addDays(weekA, 6)} (revision 1) was approved.`);
    expect(employeeNotes.some((n) => n.title === 'Timesheet returned for correction')).toBe(true);
  });

  it('records imported entries through the same rules, including the 24-hour day with the lines already there', async () => {
    const weekD = addDays(w.lastMonday, -28);
    const header = 'employeeCode,workDate,projectCode,jobCode,activityCode,minutes,note';
    const projectCode = (await h.call(w.hr, 'GET', `/v1/timesheet/projects/${w.projectId}`)).json().code as string;
    const dev = (await h.call(w.hr, 'GET', `/v1/timesheet/activities/${w.devId}`)).json().code as string;
    const meet = (await h.call(w.hr, 'GET', `/v1/timesheet/activities/${w.meetId}`)).json().code as string;
    // A manual line first; the imported rows count together with it.
    const ts = await openWeek(h, w.employee, weekD);
    expect((await addLine(h, w.employee, ts.id, line(weekD, { minutes: 600 }))).statusCode).toBe(201);
    const upload = (rows: string[]) => h.call(w.hr, 'POST', '/v1/timesheet/line-imports', { fileName: 'lines.csv', idempotencyKey: uniq('line-import-'), contentBase64: csv([header, ...rows]) });
    const rejected = await upload([
      `${w.employeeCode},${weekD},${projectCode},BUILD,${meet},480,Imported synthetic meeting`,
      `${w.employeeCode},${weekD},${projectCode},SUPPORT,${dev},480,`,
      `NOBODY-2,${weekD},${projectCode},BUILD,${dev},60,`,
      `${w.employeeCode},${addDays(weekD, 1)},${projectCode},BUILD,NOACTIVITY,60,`,
      `${w.employeeCode},${addDays(weekD, 1)},${projectCode},BUILD,${dev},20,`,
    ]);
    expect(rejected.json().state).toBe('REJECTED');
    expect(rejected.json().rows.map((r: { errorCode: string }) => r.errorCode)).toEqual(['BATCH_REJECTED', 'DAILY_LIMIT_EXCEEDED', 'UNKNOWN_EMPLOYEE', 'UNKNOWN_ACTIVITY', 'INVALID_MINUTES']);
    expect((await sheet(h, w.employee, ts.id)).lines).toHaveLength(1);
    // A valid file: the week's draft gets the lines; the peer's week is opened for them.
    const peerCode = (await h.one<{ code: string }>(`select employee_code as code from employee where id = $1`, [w.peerEmp])).code;
    const accepted = await upload([
      `${w.employeeCode},${weekD},${projectCode},BUILD,${meet},480,Imported synthetic meeting`,
      `${w.employeeCode},${addDays(weekD, 1)},${projectCode},BUILD,${dev},360,`,
      `${peerCode},${addDays(weekD, 2)},${projectCode},BUILD,${dev},120,`,
    ]);
    expect(accepted.json().state).toBe('PREVIEWED');
    expect((await h.call(w.hr, 'POST', `/v1/timesheet/line-imports/${accepted.json().id}/commit`)).json()).toMatchObject({ state: 'COMMITTED', acceptedCount: 3 });
    const peerWeek = (await h.call(w.peer, 'GET', `/v1/me/timesheets?from=${weekD}&to=${weekD}`)).json().items as { periodStart: string; state: string; totalMinutes: number }[];
    expect(peerWeek).toEqual([expect.objectContaining({ periodStart: weekD, state: 'DRAFT', totalMinutes: 120 })]);
    const s = await sheet(h, w.employee, ts.id);
    expect(s.lines.map((l) => [l.workDate, l.minutes, l.source])).toEqual([
      [weekD, 600, 'MANUAL'],
      [weekD, 480, 'IMPORT'],
      [addDays(weekD, 1), 360, 'IMPORT'],
    ]);
    // ...and a manual entry afterwards still meets the same daily limit.
    expect((await addLine(h, w.employee, ts.id, line(weekD, { jobId: w.job2Id, minutes: 375 }))).json().error).toBe('DAILY_LIMIT_EXCEEDED');
    // A row for an approved week cannot change it.
    const locked = await upload([`${w.employeeCode},${weekA},${projectCode},SUPPORT,${dev},60,`]);
    expect(locked.json().rows[0].errorCode).toBe('TIMESHEET_NOT_EDITABLE');
    expect((await h.call(w.manager, 'POST', '/v1/timesheet/line-imports', { fileName: 'l.csv', idempotencyKey: uniq('line-import-'), contentBase64: csv([header]) })).statusCode).toBe(403);
  });

  it('serves H3 TN13 in the Employee OWN context and lists the employee own timesheet requests', async () => {
    const ess = (await h.call(w.employee, 'GET', '/v1/me/ess')).json();
    const tn13 = ess.tabs.find((t: { id: string }) => t.id === 'TN13');
    expect(tn13.status).toBe('AVAILABLE');
    expect(tn13.links.map((l: { rel: string }) => l.rel)).toEqual(['timesheets', 'createTimesheet', 'allocations', 'missedReminders', 'decisionHistory']);
    const requests = (await h.call(w.employee, 'GET', '/v1/me/requests?kind=timesheet')).json().items as { requestId: string; state: string }[];
    expect(requests.find((r) => r.requestId === sheetA)).toMatchObject({ state: 'APPROVED' });
    const mine = (await h.call(w.employee, 'GET', '/v1/me/timesheets')).json().items as { id: string; approvedMinutes: number }[];
    expect(mine.find((t) => t.id === sheetA)!.approvedMinutes).toBe(585);
  });

  followUpSuite({
    path: '/v1/timesheet/line-imports',
    template: 'TIMESHEET_LINES_V1',
    harness: () => h,
    company: () => A,
    submitter: () => h.actor(A, 'HR_ADMINISTRATOR'),
    denied: async () => [w.manager, w.employee],
    // Lines in a past week no other test uses, on the employee's allocated job (nothing is committed).
    validFile: async () => {
      const week = addDays(w.lastMonday, -56);
      const projectCode = (await h.call(w.hr, 'GET', `/v1/timesheet/projects/${w.projectId}`)).json().code as string;
      const dev = (await h.call(w.hr, 'GET', `/v1/timesheet/activities/${w.devId}`)).json().code as string;
      const header = 'employeeCode,workDate,projectCode,jobCode,activityCode,minutes,note';
      return { text: [header, `${w.employeeCode},${week},${projectCode},BUILD,${dev},120,Synthetic imported work`, `${w.employeeCode},${addDays(week, 1)},${projectCode},BUILD,${dev},60,`].join('\n'), rows: 2 };
    },
  });
});
