// Leave and the approved last working date (DF04 "leave/attendance/payroll eligibility stops after approved last
// working date"; FR-051; DF05 accrual "prorated by calendar service days in the accrual month"; F1 "approved last
// working date is inclusive"): submissions refused after it, and monthly accrual for the days served up to it, also once
// the employee is separated. Exits are written directly (the exit workflow is tested in lifecycle). Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { runBulkJobs } from '../bulk/service.js';

let h: Harness;
let A: Company;
let hr: TestActor;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (base: string, n: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
/** Monday on or after today + `days`. */
const mondayAfter = (days: number) => {
  const d = new Date(`${addDays(iso(new Date()), days)}T00:00:00Z`);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
};

async function employee(status: string, joiningDate = '2026-01-05'): Promise<string> {
  const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { employeeCode: uniq('LX'), joiningDate }));
  expect(res.statusCode, res.body).toBe(201);
  await h.setStatus(A, res.json().id, status);
  return res.json().id as string;
}

/** An approved exit with `lastWorkingDate` (inclusive), optionally already SEPARATED, written in one transaction. */
async function exitOf(employeeId: string, requestDate: string, lastWorkingDate: string, separated = false) {
  await h.db.query('begin');
  try {
    const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [A.id, employeeId]);
    const x = await h.one<{ id: string }>(
      `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
       values ($1, $2, $3, 'RESIGNATION', $4, $5, $5, 'SUBMITTED') returning id`,
      [A.id, employeeId, bt.id, requestDate, lastWorkingDate],
    );
    await h.db.query(`update business_transaction set state = 'RECOMMENDED' where id = $1`, [bt.id]);
    await h.db.query(`update exit_case set state = 'RECOMMENDED', recommended_leaving_date = $2, recommended_at = now() where id = $1`, [x.id, lastWorkingDate]);
    await h.db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [bt.id]);
    await h.db.query(`update exit_case set state = 'APPROVED', approved_leaving_date = $2, approved_at = now(), prior_status_code = 'ACTIVE_CONFIRMED' where id = $1`, [x.id, lastWorkingDate]);
    if (separated) {
      await h.db.query(`update business_transaction set state = 'SEPARATED' where id = $1`, [bt.id]);
      await h.db.query(`update exit_case set state = 'SEPARATED', separated_at = now() where id = $1`, [x.id]);
    }
    await h.db.query('commit');
  } catch (e) {
    await h.db.query('rollback');
    throw e;
  }
  if (separated) await h.setStatus(A, employeeId, 'INACTIVE_SEPARATED');
}

const opening = (employeeId: string, leaveType: string, units: string) =>
  h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId, leaveType, kind: 'OPENING', units, effectiveDate: '2026-01-05', reason: 'Opening balance (synthetic)', idempotencyKey: uniq('opening-key-') });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  const policies = (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[];
  for (const p of policies) expect((await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('leave requests and the approved last working date (DF04, FR-051)', () => {
  it('accepts leave up to and on the inclusive last working date and refuses any date after it', async () => {
    const e = await employee('NOTICE');
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    expect((await opening(e, 'CASUAL', '5')).statusCode).toBe(201);
    const monday = mondayAfter(14);
    const lastWorkingDate = addDays(monday, 2); // a Wednesday
    const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    await exitOf(e, today, lastWorkingDate);
    const submit = (startDate: string, endDate: string) => h.call(self, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate, endDate });

    expect((await submit(monday, monday)).statusCode).toBe(201); // before
    expect((await submit(lastWorkingDate, lastWorkingDate)).statusCode).toBe(201); // on
    const spanning = await submit(addDays(lastWorkingDate, -1), addDays(lastWorkingDate, 1));
    expect(spanning.statusCode).toBe(422);
    expect(spanning.json()).toMatchObject({ error: 'AFTER_LAST_WORKING_DATE', details: { lastWorkingDate } });
    expect((await submit(addDays(lastWorkingDate, 1), addDays(lastWorkingDate, 1))).json().error).toBe('AFTER_LAST_WORKING_DATE'); // after
    // A refused request reserves nothing: only the two accepted days are pending.
    const casual = ((await h.call(hr, 'GET', `/v1/employees/${e}/leave-balances`)).json().items as { leaveType: string; pending: string }[]).find((b) => b.leaveType === 'CASUAL');
    expect(casual?.pending).toBe('2.0000');

    // Without an approved exit the same dates stay open.
    const stays = await employee('ACTIVE_CONFIRMED');
    const stayer = await h.actor(A, 'EMPLOYEE', { employeeId: stays });
    await opening(stays, 'CASUAL', '1');
    const after = addDays(lastWorkingDate, 1);
    expect((await h.call(stayer, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: after, endDate: after })).statusCode).toBe(201);
  });

  it('an exit approved after a request was submitted stops its approval past the last working date; reject and return stay open; leave already approved is kept', async () => {
    const e = await employee('ACTIVE_CONFIRMED');
    const self = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    expect((await opening(e, 'CASUAL', '10')).statusCode).toBe(201);
    const monday = mondayAfter(21);
    const lastWorkingDate = addDays(monday, 2); // a Wednesday
    // The employee has no manager, so HR (the fallback reviewer) holds each request's task.
    const submit = async (startDate: string, endDate: string) => {
      const res = await h.call(self, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate, endDate });
      expect(res.statusCode, res.body).toBe(201);
      const requestId = res.json().requestId as string;
      const { transaction_id } = await h.one<{ transaction_id: string }>(`select transaction_id from leave_request where id = $1`, [requestId]);
      const task = ((await h.call(hr, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === transaction_id);
      expect(task).toBeDefined();
      return { requestId, taskId: task!.taskId };
    };
    const decide = (taskId: string, decision: string) =>
      h.call(hr, 'POST', `/v1/leave/tasks/${taskId}/decision`, { decision, idempotencyKey: uniq('exit-decision-'), ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic reason' }) });
    const stateOf = async (id: string) => (await h.one<{ state: string }>(`select state from leave_request where id = $1`, [id])).state;
    const casual = async () => ((await h.call(hr, 'GET', `/v1/employees/${e}/leave-balances`)).json().items as { leaveType: string; pending: string; taken: string }[]).find((b) => b.leaveType === 'CASUAL')!;

    // All submitted, and one approved, before the exit is approved.
    const approvedEarlier = await submit(addDays(monday, 7), addDays(monday, 7));
    expect((await decide(approvedEarlier.taskId, 'APPROVE')).statusCode).toBe(200);
    const spanning = await submit(addDays(monday, 1), addDays(monday, 3)); // Tuesday to Thursday
    const within = await submit(monday, monday);
    const later = await submit(addDays(monday, 8), addDays(monday, 8));
    const today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    await exitOf(e, today, lastWorkingDate);
    expect(await casual()).toMatchObject({ pending: '5.0000', taken: '1.0000' });

    const refused = await decide(spanning.taskId, 'APPROVE');
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: 'AFTER_LAST_WORKING_DATE', details: { lastWorkingDate } });
    // Nothing changed: the request still waits on the same open task, its days still reserved, nothing consumed.
    expect(await stateOf(spanning.requestId)).toBe('SUBMITTED');
    expect(await casual()).toMatchObject({ pending: '5.0000', taken: '1.0000' });
    const reject = await decide(spanning.taskId, 'REJECT');
    expect(reject.statusCode, reject.body).toBe(200);
    expect(reject.json().state).toBe('REJECTED');
    expect((await decide(later.taskId, 'APPROVE')).json().error).toBe('AFTER_LAST_WORKING_DATE');
    expect((await decide(later.taskId, 'RETURN')).json().state).toBe('RETURNED');
    // Up to and on the last working date it is approved as before.
    expect((await decide(within.taskId, 'APPROVE')).json().state).toBe('APPROVED');
    // Leave approved before the exit stays approved (cancel or keep is an owner decision, I-40 item 4).
    expect(await stateOf(approvedEarlier.requestId)).toBe('APPROVED');
    expect(await casual()).toMatchObject({ pending: '0.0000', taken: '2.0000' });
  });
});

describe('monthly accrual up to the approved last working date (DF05, DF04)', () => {
  it('prorates the end-of-service month by calendar days served, also after separation, and accrues nothing later', async () => {
    const midMonth = await employee('ACTIVE_CONFIRMED');
    await exitOf(midMonth, '2026-02-20', '2026-03-20', true);
    const endOfFebruary = await employee('ACTIVE_CONFIRMED');
    await exitOf(endOfFebruary, '2026-02-01', '2026-02-28', true);
    const shortService = await employee('ACTIVE_CONFIRMED', '2026-03-10');
    await exitOf(shortService, '2026-03-10', '2026-03-20', true);
    const noDate = await employee('INACTIVE_SEPARATED'); // separated without an approved exit: no service end known
    const onNotice = await employee('NOTICE');
    await exitOf(onNotice, '2026-03-15', '2026-04-10');

    const march = await h.runBulkJob(hr, '/v1/leave/accruals', { month: '2026-03' });
    expect(march.result.credited).toBeGreaterThan(0);
    await h.runBulkJob(hr, '/v1/leave/accruals', { month: '2026-04' });
    // Idempotent: a rerun credits nothing.
    expect((await h.runBulkJob(hr, '/v1/leave/accruals', { month: '2026-03' })).result.credited).toBe(0);

    const accruals = async (employeeId: string) =>
      (
        await h.db.query<{ code: string; on: string; units: string }>(
          `select t.code, to_char(m.effective_date, 'YYYY-MM-DD') as on, m.units::text as units
             from leave_movement m join leave_type t on t.id = m.leave_type_id
            where m.employee_id = $1 and m.movement_kind = 'ACCRUAL' and m.effective_date >= '2026-03-01' order by m.effective_date, t.code`,
          [employeeId],
        )
      ).rows;
    // 1 to 20 March: 20 of 31 days -> 24/12 * 20/31 = 1.2903 and 6/12 * 20/31 = 0.3226, dated the last working date.
    expect(await accruals(midMonth)).toEqual([
      { code: 'ANNUAL', on: '2026-03-20', units: '1.2903' },
      { code: 'CASUAL', on: '2026-03-20', units: '0.3226' },
      { code: 'SICK', on: '2026-03-20', units: '0.3226' },
    ]);
    // Last working date 28 February: nothing for March or April.
    expect(await accruals(endOfFebruary)).toEqual([]);
    // Joined 10 March, last working date 20 March: 11 of 31 days -> 0.7097 and 0.1774.
    expect(await accruals(shortService)).toEqual([
      { code: 'ANNUAL', on: '2026-03-20', units: '0.7097' },
      { code: 'CASUAL', on: '2026-03-20', units: '0.1774' },
      { code: 'SICK', on: '2026-03-20', units: '0.1774' },
    ]);
    expect(await accruals(noDate)).toEqual([]);
    // Still on notice: March in full; April 1 to 10 of 30 days -> 0.6667 and 0.1667.
    expect(await accruals(onNotice)).toEqual([
      { code: 'ANNUAL', on: '2026-03-31', units: '2.0000' },
      { code: 'CASUAL', on: '2026-03-31', units: '0.5000' },
      { code: 'SICK', on: '2026-03-31', units: '0.5000' },
      { code: 'ANNUAL', on: '2026-04-10', units: '0.6667' },
      { code: 'CASUAL', on: '2026-04-10', units: '0.1667' },
      { code: 'SICK', on: '2026-04-10', units: '0.1667' },
    ]);
  });

  it('a company-scope assignment narrowed by a department filter cannot run the company-wide accrual (DF02 row scope)', async () => {
    // An employee outside the filtered department, in service all of May.
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { employeeCode: uniq('LX'), joiningDate: '2026-01-05', departmentId: A.financeDept }));
    expect(res.statusCode, res.body).toBe(201);
    const outside = res.json().id as string;
    await h.setStatus(A, outside, 'ACTIVE_CONFIRMED');
    const credited = async () =>
      (await h.one<{ n: number }>(`select count(*)::int as n from leave_movement where employee_id = $1 and movement_kind = 'ACCRUAL' and effective_date >= '2026-05-01'`, [outside])).n;

    const deptHr = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    const refused = await h.call(deptHr, 'POST', '/v1/leave/accruals', { month: '2026-05' });
    expect(refused.statusCode, refused.body).toBe(403);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from bulk_job where company_id = $1 and requested_by = $2`, [A.id, deptHr.user])).n).toBe(0);
    expect(await credited()).toBe(0);

    // A filter added after the job was queued ends it at its next chunk (ACCESS_REVOKED) before anything is credited.
    const later = await h.actor(A, 'HR_ADMINISTRATOR');
    const queued = await h.call(later, 'POST', '/v1/leave/accruals', { month: '2026-05' });
    expect(queued.statusCode, queued.body).toBe(202);
    await h.db.query(`insert into role_scope_filter (company_id, role_assignment_id, dimension, department_id) values ($1, $2, 'DEPARTMENT', $3)`, [A.id, later.assignment, A.dept]);
    for (let i = 0; i < 100 && (await runBulkJobs(h.pool, 100)) > 0; i++);
    expect(await h.one(`select state, error_code from bulk_job where id = $1`, [queued.json().jobId])).toEqual({ state: 'FAILED', error_code: 'ACCESS_REVOKED' });
    expect(await credited()).toBe(0);

    // An unrestricted company-scope assignment runs it for every employee in service, the other department included.
    await h.runBulkJob(hr, '/v1/leave/accruals', { month: '2026-05' });
    expect(await credited()).toBeGreaterThan(0);
  });
});
