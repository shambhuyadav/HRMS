// Leave over HTTP: policies, accrual, ledger, submission, routing, decisions, withdrawal, concurrency.
// FR-024/025/026; BR-010; DF03; DF05; CI08; ZT04/07/09/10/11/16. Dates are relative to "today" so the
// suite stays valid as time passes. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let managerActor: TestActor;
let employeeActor: TestActor;
let managerEmp: string;
let employeeEmp: string;

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
/** A weekday `days` before today. */
const weekdayBefore = (days: number) => {
  const d = new Date(`${addDays(iso(new Date()), -days)}T00:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
};

const balance = async (actor: TestActor, employee: string, type: string) =>
  ((await h.call(actor, 'GET', `/v1/employees/${employee}/leave-balances`)).json().items as { leaveType: string; available: string; pending: string; taken: string }[]).find(
    (b) => b.leaveType === type,
  )!;
const tasksOf = async (actor: TestActor) => (await h.call(actor, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; transactionId: string }[];
const decide = (actor: TestActor, taskId: string, decision: string, reason?: string, key = uniq('decision-key-')) =>
  h.call(actor, 'POST', `/v1/leave/tasks/${taskId}/decision`, { decision, idempotencyKey: key, ...(reason ? { reason } : {}) });
const opening = (employee: string, leaveType: string, units: string, key = uniq('opening-key-')) =>
  h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId: employee, leaveType, kind: 'OPENING', units, effectiveDate: '2026-01-05', reason: 'Opening balance (synthetic)', idempotencyKey: key });

async function activeEmployee(code: string, managerId?: string): Promise<string> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { employeeCode: code }))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  if (managerId) await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
  return e.id;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  managerEmp = await activeEmployee('MGR');
  employeeEmp = await activeEmployee('EMP', managerEmp);
  managerActor = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employeeActor = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('policies (DF05, BR-010)', () => {
  it('blocks requests while policies are DRAFT, then HR activates them independently', async () => {
    const blocked = await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'SICK', startDate: mondayAfter(30), endDate: mondayAfter(30) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toBe('POLICY_NOT_FOUND');

    const policies = (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number; state: string }[];
    expect(policies).toHaveLength(5);
    expect(policies.every((p) => p.state === 'DRAFT')).toBe(true);
    for (const p of policies) {
      expect((await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version })).statusCode).toBe(200);
    }
  });

  it('the author of a policy cannot activate it', async () => {
    const own = await h.one<{ id: string }>(
      `insert into leave_policy (company_id, leave_type_id, revision, effective_from, eligibility_code, accrual_rule_code, annual_entitlement, state, created_by)
       select $1, id, 9, '2030-01-01', 'TEST', 'NONE', 0, 'DRAFT', $2 from leave_type where company_id = $1 and code = 'UNPAID' returning id`,
      [A.id, hr.user],
    );
    const res = await h.call(hr, 'POST', `/v1/leave/policies/${own.id}/activate`, { expectedVersion: 1 });
    expect(res.statusCode).toBe(403);
  });

  it('a company-scope assignment narrowed by a department filter cannot activate a policy, which applies company-wide (DF02 row scope)', async () => {
    // A draft with no mapping, so activating it changes no employee's leave in the later tests.
    const draft = await h.one<{ id: string }>(
      `insert into leave_policy (company_id, leave_type_id, revision, effective_from, eligibility_code, accrual_rule_code, annual_entitlement, state, created_by)
       select $1, id, 10, '2031-01-01', 'TEST', 'NONE', 0, 'DRAFT', $2 from leave_type where company_id = $1 and code = 'UNPAID' returning id`,
      [A.id, SYSTEM_ACTOR_ID],
    );
    const stateOf = async () => (await h.one<{ state: string }>(`select state from leave_policy where id = $1`, [draft.id])).state;
    const deptHr = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    const refused = await h.call(deptHr, 'POST', `/v1/leave/policies/${draft.id}/activate`, { expectedVersion: 1 });
    expect(refused.statusCode, refused.body).toBe(403);
    expect(await stateOf()).toBe('DRAFT');
    expect((await h.call(hr, 'POST', `/v1/leave/policies/${draft.id}/activate`, { expectedVersion: 1 })).statusCode).toBe(200);
    expect(await stateOf()).toBe('ACTIVE');
  });
});

describe('accrual and opening balances (FR-025, DF05, F3)', () => {
  it('accrues 24/12 = 2.0000 days for a full month and prorates the joining month; reruns change nothing', async () => {
    // NFR-S09: accrual is a queued bulk job; the helper enqueues it (202), runs the worker step and returns the job.
    const feb = await h.runBulkJob(hr, '/v1/leave/accruals', { month: '2026-02' });
    expect(feb.state).toBe('COMPLETED');
    expect(feb.result.credited).toBeGreaterThan(0);
    expect((await h.runBulkJob(hr, '/v1/leave/accruals', { month: '2026-02' })).result.credited).toBe(0);
    await h.runBulkJob(hr, '/v1/leave/accruals', { month: '2026-01' });

    const rows = (
      await h.db.query<{ code: string; month: string; units: string }>(
        `select t.code, to_char(m.effective_date, 'YYYY-MM') as month, m.units::text as units
           from leave_movement m join leave_type t on t.id = m.leave_type_id
          where m.employee_id = $1 and m.movement_kind = 'ACCRUAL' order by t.code, month`,
        [employeeEmp],
      )
    ).rows;
    // Joined 5 January: 27 of 31 days -> 2 * 27/31 = 1.7419 (4 dp); sick/casual 0.5 * 27/31 = 0.4355.
    expect(rows).toEqual([
      { code: 'ANNUAL', month: '2026-01', units: '1.7419' },
      { code: 'ANNUAL', month: '2026-02', units: '2.0000' },
      { code: 'CASUAL', month: '2026-01', units: '0.4355' },
      { code: 'CASUAL', month: '2026-02', units: '0.5000' },
      { code: 'SICK', month: '2026-01', units: '0.4355' },
      { code: 'SICK', month: '2026-02', units: '0.5000' },
    ]);
  });

  it('records one opening balance with a reason; a duplicate is refused and a replay is a no-op', async () => {
    const key = uniq('opening-key-');
    expect((await opening(employeeEmp, 'ANNUAL', '10', key)).statusCode).toBe(201);
    expect((await opening(employeeEmp, 'ANNUAL', '10', key)).statusCode).toBe(201);
    expect((await opening(employeeEmp, 'ANNUAL', '5')).statusCode).toBe(409);
    // 10 opening + 1.7419 + 2.0000 accrued
    expect((await balance(hr, employeeEmp, 'ANNUAL')).available).toBe('13.7419');
  });
});

describe('request, routing and decision (FR-026, DF03, ZT04, ZT07, ZT10)', () => {
  it('reserves on submission, routes to the direct manager and consumes once on approval', async () => {
    const start = mondayAfter(21);
    const res = await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: start, endDate: addDays(start, 2), reason: 'Family event (synthetic)' });
    expect(res.statusCode).toBe(201);
    expect(res.json().units).toBe('3');
    expect(await balance(employeeActor, employeeEmp, 'ANNUAL')).toMatchObject({ available: '10.7419', pending: '3.0000' });

    expect(await tasksOf(hr)).toEqual([]);
    const [task] = await tasksOf(managerActor);
    expect(task).toBeDefined();

    // The employee holds no approve permission; a non-assignee reviewer sees no such task.
    expect((await decide(employeeActor, task!.taskId, 'APPROVE')).statusCode).toBe(403);
    expect((await decide(hr, task!.taskId, 'APPROVE')).statusCode).toBe(404);

    const key = uniq('decision-key-');
    const approved = await decide(managerActor, task!.taskId, 'APPROVE', undefined, key);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ state: 'APPROVED', replayed: false });
    const replay = await decide(managerActor, task!.taskId, 'APPROVE', undefined, key);
    expect(replay.json()).toMatchObject({ state: 'APPROVED', replayed: true });
    expect(await balance(employeeActor, employeeEmp, 'ANNUAL')).toMatchObject({ available: '10.7419', pending: '0.0000', taken: '3.0000' });

    // Reasons are confidential: neither the manager nor HR sees them without a reason grant.
    const asManager = (await h.call(managerActor, 'GET', `/v1/employees/${employeeEmp}/leave-requests`)).json().items[0];
    expect(asManager).toMatchObject({ state: 'APPROVED', units: '3.0000' });
    expect(asManager).not.toHaveProperty('reason');

    // Overlap with an approved request is refused.
    const overlap = await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: addDays(start, 1), endDate: addDays(start, 1) });
    expect(overlap.statusCode).toBe(409);
  });

  it('excludes weekends and location holidays from the day count', async () => {
    const monday = mondayAfter(42);
    await h.call(hr, 'POST', '/v1/holidays', { locationId: A.loc, holidayDate: monday, name: 'Synthetic holiday' });
    const res = await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: addDays(monday, -2), endDate: addDays(monday, 1) });
    expect(res.statusCode).toBe(201);
    expect(res.json().units).toBe('1'); // Sat, Sun excluded; Monday holiday; Tuesday counts
    const holidayOnly = await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'SICK', startDate: monday, endDate: monday });
    expect(holidayOnly.statusCode).toBe(422);
  });

  it('rejection needs a reason and releases the reservation; withdrawal cancels the task', async () => {
    const start = mondayAfter(70);
    await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: start, endDate: start });
    const [task] = (await tasksOf(managerActor)).slice(-1);
    expect((await decide(managerActor, task!.taskId, 'REJECT')).statusCode).toBe(422);
    expect((await decide(managerActor, task!.taskId, 'REJECT', 'Team coverage')).json().state).toBe('REJECTED');

    const second = (await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: start, endDate: start })).json();
    const before = (await tasksOf(managerActor)).length;
    const withdrawn = await h.call(employeeActor, 'POST', `/v1/leave/requests/${second.requestId}/withdraw`);
    expect(withdrawn.json().state).toBe('WITHDRAWN');
    expect((await tasksOf(managerActor)).length).toBe(before - 1);
    expect((await h.call(employeeActor, 'POST', `/v1/leave/requests/${second.requestId}/withdraw`)).statusCode).toBe(409);
    expect((await balance(employeeActor, employeeEmp, 'ANNUAL')).pending).toBe('1.0000'); // only the holiday-week request is pending
  });

  it('refuses requests beyond the available paid balance', async () => {
    const start = mondayAfter(100);
    const res = await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'ANNUAL', startDate: start, endDate: addDays(start, 18) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toBe('INSUFFICIENT_BALANCE');
  });

  it('routes back-dated leave older than 7 days, and a manager’s own leave, to the HR fallback', async () => {
    const past = weekdayBefore(14);
    await h.call(employeeActor, 'POST', '/v1/leave/requests', { leaveType: 'SICK', startDate: past, endDate: past, halfDay: true });
    expect((await tasksOf(hr)).length).toBe(1);

    const managerSelf = await h.actor(A, 'EMPLOYEE', { user: managerActor.user });
    await opening(managerEmp, 'CASUAL', '2');
    const own = await h.call(managerSelf, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: mondayAfter(14), endDate: mondayAfter(14) });
    expect(own.statusCode).toBe(201);
    expect((await tasksOf(hr)).length).toBe(2); // manager has no manager -> fallback, never self

    await h.db.query(`update workflow_fallback_reviewer set active = false where company_id = $1`, [A.id]);
    const blocked = await h.call(managerSelf, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: mondayAfter(28), endDate: mondayAfter(28) });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().error).toBe('NO_ELIGIBLE_REVIEWER');
    await h.db.query(`update workflow_fallback_reviewer set active = true where company_id = $1`, [A.id]);
  });
});

describe('concurrency (FR-026, ZT11)', () => {
  it('two simultaneous requests cannot spend the same balance', async () => {
    const e = await activeEmployee(uniq('CON'), managerEmp);
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    await opening(e, 'CASUAL', '3');
    const w1 = mondayAfter(150);
    const w2 = mondayAfter(160);
    const [r1, r2] = await Promise.all([
      h.call(actor, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: w1, endDate: addDays(w1, 2) }),
      h.call(actor, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: w2, endDate: addDays(w2, 2) }),
    ]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 422]);
    expect((await balance(hr, e, 'CASUAL')).available).toBe('0.0000');
  });

  it('two simultaneous decisions on one task produce exactly one outcome', async () => {
    const e = await activeEmployee(uniq('DEC'), managerEmp);
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: e });
    await opening(e, 'CASUAL', '2');
    const day = mondayAfter(200);
    const submitted = (await h.call(actor, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: day, endDate: day })).json();
    const task = await h.one<{ id: string }>(
      `select t.id from approval_task t join approval_instance i on i.id = t.instance_id
         join leave_request lr on lr.transaction_id = i.transaction_id where lr.id = $1`,
      [submitted.requestId],
    );
    const [d1, d2] = await Promise.all([decide(managerActor, task.id, 'APPROVE'), decide(managerActor, task.id, 'REJECT', 'Conflicting decision')]);
    expect([d1.statusCode, d2.statusCode].sort()).toEqual([200, 409]);
    const movements = await h.one<{ n: string }>(`select count(*) as n from leave_movement where request_id = $1 and movement_kind = 'RESERVATION_RELEASE'`, [submitted.requestId]);
    expect(Number(movements.n)).toBe(1);
  });
});
