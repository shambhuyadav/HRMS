// Outdoor duty and work-on-holiday requests over HTTP (FR-027, FR-084; DF03; DF05). Synthetic data.
// Past fixed dates (2026-03-02 is a Monday) exercise attendance; future dates exercise manager routing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let employeeEmp: string;
let employeeCode: string;
let bystanderEmp: string;
let shiftId: string;

const TUE = '2026-03-03';
const WED = '2026-03-04';
const iso = (d: Date) => d.toISOString().slice(0, 10);
/** The next given ISO weekday (1 = Monday ... 6 = Saturday) at least `weeks` weeks ahead. */
const ahead = (weeks: number, isoDow: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  // In the week starting on the first Monday at least `weeks` weeks ahead, so weekdays asked for together keep their
  // order whatever day the tests run (a Tuesday run once put "Tuesday" before "Monday").
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCDate(d.getUTCDate() + isoDow - 1);
  return iso(d);
};

type Task = { taskId: string; kind: string; transactionId: string };
const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/work-requests/tasks/mine')).json().items as Task[];
const taskFor = async (a: TestActor, kind: string, requestId: string) => {
  const table = kind === 'outdoor_duty' ? 'outdoor_duty_request' : 'holiday_work_request';
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from ${table} where id = $1`, [requestId])).transaction_id;
  return (await tasks(a)).find((t) => t.transactionId === tx);
};
const decide = (a: TestActor, taskId: string, decision: string) =>
  h.call(a, 'POST', `/v1/work-requests/tasks/${taskId}/decision`, { decision, idempotencyKey: uniq('wr-key-'), ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic reason' }) });
const submit = (kind: string, body: Record<string, unknown>) => h.call(employee, 'POST', `/v1/work-requests/${kind}`, { purpose: 'Client site visit (synthetic)', ...body });
const recordOn = async (employeeId: string, d: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${d}&to=${d}`)).json().items[0];
const leaveMovements = async () => Number((await h.one<{ n: string }>(`select count(*) as n from leave_movement where employee_id = $1`, [employeeEmp])).n);

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
  const person = async (managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
    if (managerId) await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
    return e as { id: string; employeeCode: string };
  };
  const managerEmp = (await person()).id;
  const emp = await person(managerEmp);
  employeeEmp = emp.id;
  employeeCode = emp.employeeCode;
  bystanderEmp = (await person(managerEmp)).id;
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version });
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
    await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
  }
});

afterAll(async () => {
  await h?.stop();
});

describe('outdoor duty changes the day outcome once (FR-027)', () => {
  it('an approved full-day duty makes a working day ON_DUTY instead of ABSENT, and moves no leave balance', async () => {
    const before = await leaveMovements();
    const res = await submit('outdoor_duty', { startDate: TUE, endDate: TUE });
    expect(res.statusCode).toBe(201);
    const id = res.json().requestId;
    // More than 7 days back: reviewed by HR, not the manager (DF05).
    expect(await taskFor(manager, 'outdoor_duty', id)).toBeUndefined();
    expect((await decide(hr, (await taskFor(hr, 'outdoor_duty', id))!.taskId, 'APPROVE')).json()).toMatchObject({ kind: 'outdoor_duty', state: 'APPROVED' });

    await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: TUE });
    expect(await recordOn(employeeEmp, TUE)).toMatchObject({ status: 'ON_DUTY' });
    expect(await recordOn(bystanderEmp, TUE)).toMatchObject({ status: 'ABSENT' });
    // A rerun with unchanged inputs changes nothing.
    expect((await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: TUE })).result.UPDATED).toBe(0);
    expect(await leaveMovements()).toBe(before);
    // A second live outdoor request for the same day is refused.
    expect((await submit('outdoor_duty', { startDate: TUE, endDate: TUE })).statusCode).toBe(409);
  });

  it('a timed duty window counts as worked time with the punches', async () => {
    await h.call(hr, 'POST', '/v1/attendance/punches', {
      punches: [
        { employeeCode, occurredAt: `${WED}T14:00:00+05:30`, direction: 'IN', externalEventKey: uniq('evt-') },
        { employeeCode, occurredAt: `${WED}T18:00:00+05:30`, direction: 'OUT', externalEventKey: uniq('evt-') },
      ],
    });
    const id = (await submit('outdoor_duty', { startDate: WED, endDate: WED, startTime: '09:00', endTime: '13:00' })).json().requestId;
    await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: WED });
    expect(await recordOn(employeeEmp, WED)).toMatchObject({ status: 'HALF_DAY', workedMinutes: 240 }); // not yet approved
    await decide(hr, (await taskFor(hr, 'outdoor_duty', id))!.taskId, 'APPROVE');
    await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: WED });
    expect(await recordOn(employeeEmp, WED)).toMatchObject({ status: 'PRESENT', workedMinutes: 480 });
  });

  it('validates days, times and overlap with leave', async () => {
    const sat = ahead(3, 6);
    expect((await submit('outdoor_duty', { startDate: sat, endDate: sat })).json().error).toBe('NO_WORKING_DAYS');
    const mon = ahead(3, 1);
    expect((await submit('outdoor_duty', { startDate: mon, endDate: ahead(3, 2), startTime: '09:00', endTime: '12:00' })).json().error).toBe('RULE_VIOLATION');
    // An empty window is refused; an end before the start is an overnight window (DF05), not an error.
    expect((await submit('outdoor_duty', { startDate: mon, endDate: mon, startTime: '09:00', endTime: '09:00' })).json().error).toBe('RULE_VIOLATION');
    expect((await submit('holiday_work', { startDate: ahead(3, 6), endDate: ahead(3, 6), startTime: '14:00', endTime: '10:00' })).json().error).toBe('RULE_VIOLATION');
    expect((await submit('outdoor_duty', { startDate: mon, endDate: mon, startTime: '09:00' })).json().error).toBe('RULE_VIOLATION');
    expect((await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate: mon, endDate: mon })).statusCode).toBe(201);
    expect((await submit('outdoor_duty', { startDate: mon, endDate: mon })).json().error).toBe('OVERLAPS_LEAVE');
  });
});

describe('work on holiday (FR-027)', () => {
  it('is for one off day; approval records it without creating leave', async () => {
    const before = await leaveMovements();
    expect((await submit('holiday_work', { startDate: ahead(4, 1), endDate: ahead(4, 1) })).json().error).toBe('NOT_AN_OFF_DAY');
    expect((await submit('holiday_work', { startDate: ahead(4, 6), endDate: ahead(4, 7) })).json().error).toBe('RULE_VIOLATION');
    const sat = ahead(4, 6);
    const id = (await submit('holiday_work', { startDate: sat, endDate: sat, startTime: '10:00', endTime: '14:00' })).json().requestId;
    const task = (await taskFor(manager, 'holiday_work', id))!;
    expect((await decide(manager, task.taskId, 'APPROVE')).json()).toMatchObject({ kind: 'holiday_work', state: 'APPROVED' });
    expect(await leaveMovements()).toBe(before);

    const view = (await h.call(hr, 'GET', `/v1/work-requests/holiday_work?from=${sat}&to=${sat}&state=APPROVED`)).json().items;
    expect(view).toEqual([expect.objectContaining({ id, kind: 'holiday_work', employeeCode, startTime: '10:00', endTime: '14:00', state: 'APPROVED' })]);
  });
});

describe('review flow (DF03)', () => {
  it('return, correct and resubmit as a new revision; withdraw; notifications carry operational fields only', async () => {
    const mon = ahead(5, 1);
    const id = (await submit('outdoor_duty', { startDate: mon, endDate: mon, purpose: 'Vendor audit (synthetic)' })).json().requestId;
    await dispatchOutbox(h.pool);
    const inbox = (await h.call(manager, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
    expect(inbox.find((n) => n.category === 'WORK_REQUEST_SUBMITTED')?.body).toBe(`A request for outdoor duty from ${mon} to ${mon} is waiting for your decision.`);
    expect(JSON.stringify(inbox)).not.toContain('Vendor audit');

    expect((await decide(manager, (await taskFor(manager, 'outdoor_duty', id))!.taskId, 'RETURN')).json().state).toBe('RETURNED');
    const row = ((await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/work-requests`)).json().items as { id: string; version: number; state: string }[]).find((r) => r.id === id)!;
    expect(row.state).toBe('RETURNED');
    const tue = ahead(5, 2);
    const re = await h.call(employee, 'PUT', `/v1/work-requests/outdoor_duty/${id}`, { startDate: tue, endDate: tue, purpose: 'Vendor audit, moved (synthetic)', expectedVersion: row.version });
    expect(re.json()).toMatchObject({ revision: 2, state: 'SUBMITTED' });
    expect(await taskFor(manager, 'outdoor_duty', id)).toBeDefined();
    expect((await h.call(employee, 'POST', `/v1/work-requests/outdoor_duty/${id}/withdraw`)).json().state).toBe('WITHDRAWN');
    expect(await taskFor(manager, 'outdoor_duty', id)).toBeUndefined();
  });

  it('scope: managers see their team, other employees see nothing, and nobody decides their own request', async () => {
    expect((await h.call(manager, 'GET', `/v1/employees/${employeeEmp}/work-requests`)).statusCode).toBe(200);
    const other = await h.actor(A, 'EMPLOYEE', { employeeId: bystanderEmp });
    expect((await h.call(other, 'GET', `/v1/employees/${employeeEmp}/work-requests`)).statusCode).toBe(404);
    expect((await h.call(other, 'GET', `/v1/work-requests/outdoor_duty?from=2026-01-01&to=2027-12-31`)).json().items.every((r: { employeeId: string }) => r.employeeId === bystanderEmp)).toBe(true);
    expect((await h.call(employee, 'GET', '/v1/work-requests/tasks/mine')).statusCode).toBe(403);
  });
});

describe('the approved last working date (DF04, FR-051)', () => {
  /** An employee on the day shift without a manager, so HR (the fallback reviewer) decides their requests. */
  async function shiftEmployee(status: string) {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json() as { id: string };
    await h.setStatus(A, e.id, status);
    await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' });
    return e.id;
  }
  /** An approved exit with an inclusive last working date, written directly (the exit workflow is tested in lifecycle). */
  async function approveExit(employeeId: string, lastDay: string) {
    await h.db.query('begin');
    try {
      const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [A.id, employeeId]);
      const x = await h.one<{ id: string }>(
        `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
         values ($1, $2, $3, 'RESIGNATION', $4, $5, $5, 'SUBMITTED') returning id`,
        [A.id, employeeId, bt.id, iso(new Date()), lastDay],
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
  }

  it('accepts a request up to and on the inclusive last working date and refuses any date after it', async () => {
    const e = { id: await shiftEmployee('NOTICE') };
    const lastDay = ahead(5, 3);
    await approveExit(e.id, lastDay);
    const leaver = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    const ask = (startDate: string, endDate: string) =>
      h.call(leaver, 'POST', '/v1/work-requests/outdoor_duty', { purpose: 'Client site visit (synthetic)', startDate, endDate });
    expect((await ask(lastDay, lastDay)).statusCode).toBe(201);
    const after = await ask(ahead(5, 4), ahead(5, 4));
    expect(after.statusCode).toBe(422);
    expect(after.json()).toMatchObject({ error: 'AFTER_LAST_WORKING_DATE' });
    expect((await ask(ahead(5, 2), ahead(5, 4))).json().error).toBe('AFTER_LAST_WORKING_DATE');
  });

  it('an exit approved after a request was submitted stops its approval past the last working date; reject and return stay open', async () => {
    const e = await shiftEmployee('ACTIVE_CONFIRMED');
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    const ask = async (kind: string, startDate: string) => {
      const res = await h.call(self, 'POST', `/v1/work-requests/${kind}`, { purpose: 'Client site visit (synthetic)', startDate, endDate: startDate });
      expect(res.statusCode, res.body).toBe(201);
      const requestId = res.json().requestId as string;
      const task = await taskFor(hr, kind, requestId);
      expect(task).toBeDefined();
      return { requestId, taskId: task!.taskId };
    };
    const lastDay = ahead(6, 3); // a Wednesday
    // All submitted before the exit is approved.
    const within = await ask('outdoor_duty', ahead(6, 2));
    const dutyAfter = await ask('outdoor_duty', ahead(6, 4));
    const holidayAfter = await ask('holiday_work', ahead(6, 6));
    const dutyLater = await ask('outdoor_duty', ahead(7, 1));
    await approveExit(e, lastDay);

    for (const [kind, r] of [['outdoor_duty', dutyAfter], ['holiday_work', holidayAfter]] as const) {
      const refused = await decide(hr, r.taskId, 'APPROVE');
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ error: 'AFTER_LAST_WORKING_DATE', details: { lastWorkingDate: lastDay } });
      // The decision rolled back: the request still waits on the same open task.
      const table = kind === 'outdoor_duty' ? 'outdoor_duty_request' : 'holiday_work_request';
      expect((await h.one<{ state: string }>(`select state from ${table} where id = $1`, [r.requestId])).state).toBe('SUBMITTED');
      expect(await taskFor(hr, kind, r.requestId)).toMatchObject({ taskId: r.taskId });
    }
    expect((await decide(hr, dutyAfter.taskId, 'REJECT')).json()).toMatchObject({ state: 'REJECTED' });
    expect((await decide(hr, holidayAfter.taskId, 'RETURN')).json()).toMatchObject({ kind: 'holiday_work', state: 'RETURNED' });
    expect((await decide(hr, dutyLater.taskId, 'APPROVE')).json().error).toBe('AFTER_LAST_WORKING_DATE');
    // On or before the last working date it is approved as before.
    expect((await decide(hr, within.taskId, 'APPROVE')).json()).toMatchObject({ kind: 'outdoor_duty', state: 'APPROVED' });
  });
});
