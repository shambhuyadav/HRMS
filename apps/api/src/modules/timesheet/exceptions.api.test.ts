// Missed timesheets (BR-049; H2 late-timesheet journey; FR-101 acceptance "missing timesheet alone creates a follow-up
// exception and never an automatic salary hold or deduction"; DF12; H3 TN13 missed reminders). Synthetic data.
// Allocations recorded on 2026-02-20 for the weeks of 2026-03-02 and 2026-03-09 make those weeks due in the past.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { runMissingTimesheetReminders } from './exceptions.js';
import { addLine, openWeek, person, submit, type TimesheetWorld, timesheetWorld } from './timesheet.fixtures.js';

const W1 = '2026-03-02';
const W2 = '2026-03-09';

describe.runIf(isModuleActive('timesheet'))('timesheet: missed submissions (BR-049)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let w: TimesheetWorld;
  let bHr: TestActor;
  let hrFin: TestActor;
  let systemUser: string;

  interface Staff {
    id: string;
    actor: TestActor;
  }
  let late1: Staff;
  let late2: Staff;

  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; title: string | null; body: string }[];
  const own = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/timesheet-exceptions')).json().items as { id: string; periodStart: string; dueDate: string; state: string; resolution: string | null; timesheetId: string | null }[];
  /** An employee allocated (recorded on 2026-02-20) to the build job for the given weeks. */
  const staff = async (from = W1, to = '2026-03-15'): Promise<Staff> => {
    const p = await person(h, A, w.hr, w.managerEmp);
    await h.db.query(
      `insert into resource_allocation (company_id, employee_id, project_id, job_id, start_date, end_date, allocation_percent, state, source, created_at)
       values ($1, $2, $3, $4, $5, $6, 100, 'ACTIVE', 'MANUAL', '2026-02-20T09:00:00Z')`,
      [A.id, p.id, w.projectId, w.jobId, from, to],
    );
    return { id: p.id, actor: await h.actor(A, 'EMPLOYEE', { employeeId: p.id }) };
  };
  const submitWeek = async (s: Staff, week: string) => {
    const ts = await openWeek(h, s.actor, week);
    expect((await addLine(h, s.actor, ts.id, { workDate: week, jobId: w.jobId, activityId: w.devId, minutes: 480 })).statusCode).toBe(201);
    const res = await submit(h, s.actor, ts.id);
    expect(res.statusCode, res.body).toBe(200);
    return { timesheetId: ts.id, ...(res.json() as { late: boolean }) };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    w = await timesheetWorld(h, A);
    bHr = await h.actor(B, 'HR_ADMINISTRATOR');
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    systemUser = await h.makeUser();
    late1 = await staff();
    late2 = await staff();
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('raises one pending exception and one reminder per missed week, idempotently, and nothing else', async () => {
    // late2 submitted the first week before the run: that week is never flagged.
    expect((await submitWeek(late2, W1)).late).toBe(true);
    const run = await runMissingTimesheetReminders(h.pool, A.id, w.today, systemUser);
    expect(run).toEqual({ localDate: w.today, candidates: 3, raised: 3 });
    expect(await runMissingTimesheetReminders(h.pool, A.id, w.today, systemUser)).toEqual({ localDate: w.today, candidates: 0, raised: 0 });
    expect((await own(late1.actor)).map((x) => [x.periodStart, x.dueDate, x.state])).toEqual([
      [W2, '2026-03-16', 'OPEN'],
      [W1, '2026-03-09', 'OPEN'],
    ]);
    expect((await own(late2.actor)).map((x) => [x.periodStart, x.state])).toEqual([[W2, 'OPEN']]);
    await dispatchOutbox(h.pool, 500);
    const reminders = (await inbox(late1.actor)).filter((n) => n.category === 'TIMESHEET_MISSING');
    expect(reminders.map((n) => n.body).sort()).toEqual([
      `Your timesheet for ${W1} to 2026-03-08 was due on 2026-03-09 and has not been submitted. Please submit it; a late timesheet is still accepted.`,
      `Your timesheet for ${W2} to 2026-03-15 was due on 2026-03-16 and has not been submitted. Please submit it; a late timesheet is still accepted.`,
    ]);
    // BR-049: a reminder and an exception only; no attendance, leave, transaction or pay record is touched.
    for (const table of ['attendance_record', 'leave_movement', 'business_transaction']) {
      const column = table === 'business_transaction' ? 'owner_employee_id' : 'employee_id';
      expect(Number((await h.one<{ n: string }>(`select count(*) as n from ${table} where ${column} = $1`, [late1.id])).n), table).toBe(0);
    }
    const audit = await h.one<{ n: string }>(`select count(*) as n from audit_event where resource_code = 'timesheet_missing_exception' and action = 'RAISE' and actor_user_id = $1`, [systemUser]);
    expect(Number(audit.n)).toBe(3);
  });

  it('resolves the exception when the week is submitted late (accepted, flagged late, no penalty)', async () => {
    const submitted = await submitWeek(late1, W1);
    expect(submitted.late).toBe(true);
    const mine = await own(late1.actor);
    expect(mine.find((x) => x.periodStart === W1)).toMatchObject({ state: 'RESOLVED', resolution: 'SUBMITTED', timesheetId: submitted.timesheetId });
    expect(mine.find((x) => x.periodStart === W2)).toMatchObject({ state: 'OPEN' });
    // The late timesheet goes through the ordinary review.
    const tasks = (await h.call(w.manager, 'GET', '/v1/timesheet-tasks')).json().items as { timesheet: { id: string; late: boolean } | null }[];
    expect(tasks.find((t) => t.timesheet?.id === submitted.timesheetId)!.timesheet!.late).toBe(true);
  });

  it('lets an authorised reviewer document a resolution, never for themselves; reminders stop once resolved', async () => {
    const open = (await h.call(w.manager, 'GET', '/v1/timesheet-exceptions?state=OPEN')).json().items as { id: string; employeeId: string; periodStart: string }[];
    const late1W2 = open.find((x) => x.employeeId === late1.id && x.periodStart === W2)!;
    const late2W2 = open.find((x) => x.employeeId === late2.id && x.periodStart === W2)!;
    expect(late1W2 && late2W2).toBeTruthy();
    // Managers see their team's follow-ups but do not resolve them; the employee neither.
    expect((await h.call(w.manager, 'POST', `/v1/timesheet-exceptions/${late1W2.id}/resolve`, { reason: 'x' })).statusCode).toBe(403);
    expect((await h.call(late1.actor, 'POST', `/v1/timesheet-exceptions/${late1W2.id}/resolve`, { reason: 'x' })).statusCode).toBe(403);
    expect((await h.call(hrFin, 'POST', `/v1/timesheet-exceptions/${late1W2.id}/resolve`, { reason: 'x' })).statusCode).toBe(404);
    expect((await h.call(bHr, 'POST', `/v1/timesheet-exceptions/${late1W2.id}/resolve`, { reason: 'x' })).statusCode).toBe(404);
    expect((await h.call(hrFin, 'GET', '/v1/timesheet-exceptions')).json().items).toEqual([]);
    // The same person in an HR assignment cannot resolve their own exception.
    const selfHr = await h.actor(A, 'HR_ADMINISTRATOR', { user: late2.actor.user });
    expect((await h.call(selfHr, 'POST', `/v1/timesheet-exceptions/${late2W2.id}/resolve`, { reason: 'Own week' })).json().error).toBe('SELF_ACTION_NOT_ALLOWED');
    const resolved = await h.call(w.hr, 'POST', `/v1/timesheet-exceptions/${late1W2.id}/resolve`, { reason: 'Whole week on approved leave (synthetic)' });
    expect(resolved.json()).toMatchObject({ state: 'RESOLVED', resolution: 'DOCUMENTED', resolutionReason: 'Whole week on approved leave (synthetic)' });
    expect((await h.call(w.hr, 'POST', `/v1/timesheet-exceptions/${late1W2.id}/resolve`, { reason: 'again' })).json().error).toBe('INVALID_STATE');
    await expect(h.db.query(`update timesheet_missing_exception set state = 'OPEN', resolution = null, resolved_at = null, resolved_by = null where id = $1`, [late1W2.id])).rejects.toMatchObject({
      code: '23514',
    });

    // DF12: an exception resolved before its reminder is dispatched sends nothing.
    const late3 = await staff(W1, W1);
    expect(await runMissingTimesheetReminders(h.pool, A.id, w.today, systemUser)).toMatchObject({ raised: 1 });
    const x3 = (await own(late3.actor))[0]!;
    expect((await h.call(w.hr, 'POST', `/v1/timesheet-exceptions/${x3.id}/resolve`, { reason: 'Synthetic: not expected that week' })).statusCode).toBe(200);
    await dispatchOutbox(h.pool, 500);
    expect((await inbox(late3.actor)).filter((n) => n.category === 'TIMESHEET_MISSING')).toEqual([]);
  });

  it('never leaves an open exception for a week submitted while the job runs', async () => {
    const racer = await staff(W1, W1);
    const ts = await openWeek(h, racer.actor, W1);
    expect((await addLine(h, racer.actor, ts.id, { workDate: W1, jobId: w.jobId, activityId: w.devId, minutes: 480 })).statusCode).toBe(201);
    const [, submitted] = await Promise.all([runMissingTimesheetReminders(h.pool, A.id, w.today, systemUser), submit(h, racer.actor, ts.id)]);
    expect(submitted.statusCode, submitted.body).toBe(200);
    const states = (await own(racer.actor)).map((x) => x.state);
    expect(states.every((s) => s === 'RESOLVED')).toBe(true);
    expect(await runMissingTimesheetReminders(h.pool, A.id, w.today, systemUser)).toMatchObject({ raised: 0 });
  });
});
