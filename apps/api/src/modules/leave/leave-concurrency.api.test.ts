// Concurrency regressions for leave and work requests (data-1, data-3, data-7; FR-026; FR-027; I-05).
// Real races are staged with two database connections: the test holds a lock to pause one request at a known
// point, starts the competing request, waits until PostgreSQL shows it blocked, then releases the lock.
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let employeeEmp: string;
let casualId: string;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (base: string, n: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
const monday = (n: number) => {
  const d = new Date(`${shift(iso(new Date()), 7 * n)}T00:00:00Z`);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
};

type Task = { taskId: string; transactionId: string };
const leaveTasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/leave/tasks')).json().items as Task[];
const workTasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/work-requests/tasks/mine')).json().items as Task[];
const decide = (a: TestActor, path: string, taskId: string, decision: string) =>
  h.call(a, 'POST', `/v1/${path}/tasks/${taskId}/decision`, { decision, idempotencyKey: uniq('race-key-'), ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic reason' }) });
const txOf = async (table: string, id: string) => (await h.one<{ transaction_id: string }>(`select transaction_id from ${table} where id = $1`, [id])).transaction_id;
const versionOf = async (id: string) => (await h.one<{ version: number }>(`select version from leave_request where id = $1`, [id])).version;
const casual = async () =>
  ((await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/leave-balances`)).json().items as { leaveType: string; available: string; pending: string }[]).find((b) => b.leaveType === 'CASUAL')!;
const balanceKey = `hashtextextended('leave_balance:' || $1 || ':' || $2, 0)`;

/** Waits until at least `min` other sessions of this database match the pg_stat_activity predicate. */
async function waitFor(predicate: string, min = 1) {
  for (let i = 0; i < 400; i++) {
    const r = await h.db.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and ${predicate}`);
    if (r.rows[0]!.n >= min) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error(`timeout waiting for ${predicate}`);
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  const person = async (managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    if (managerId) await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
    return e.id as string;
  };
  const managerEmp = await person();
  employeeEmp = await person(managerEmp);
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
    await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
  }
  await h.call(hr, 'POST', '/v1/leave/adjustments', {
    employeeId: employeeEmp,
    leaveType: 'CASUAL',
    kind: 'OPENING',
    units: '10',
    effectiveDate: '2026-01-05',
    reason: 'Opening balance (synthetic)',
    idempotencyKey: uniq('opening-key-'),
  });
  casualId = (await h.one<{ id: string }>(`select id from leave_type where company_id = $1 and code = 'CASUAL'`, [A.id])).id;
});

afterAll(async () => {
  await h?.stop();
});

describe('withdraw racing a resubmission (data-1)', () => {
  it('the withdrawal waits, then withdraws the new revision and releases its reservation', async () => {
    const start = monday(2);
    const id = (await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: start, endDate: shift(start, 1) })).json().requestId as string;
    const tx = await txOf('leave_request', id);
    const task = (await leaveTasks(manager)).find((t) => t.transactionId === tx)!;
    expect((await decide(manager, 'leave', task.taskId, 'RETURN')).json().state).toBe('RETURNED');

    // Pause the resubmission while it holds the transaction lock (it waits on the balance lock held here).
    await h.db.query(`select pg_advisory_lock(${balanceKey})`, [employeeEmp, casualId]);
    const resubmit = h.call(employee, 'PUT', `/v1/leave/requests/${id}`, { startDate: start, endDate: start, expectedVersion: await versionOf(id) });
    await waitFor(`wait_event_type = 'Lock' and wait_event = 'advisory'`);
    const withdraw = h.call(employee, 'POST', `/v1/leave/requests/${id}/withdraw`);
    await waitFor(`wait_event_type = 'Lock' and wait_event = 'advisory'`, 2); // the withdrawal queues behind it
    await h.db.query(`select pg_advisory_unlock(${balanceKey})`, [employeeEmp, casualId]);
    const [r1, r2] = await Promise.all([resubmit, withdraw]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);

    const state = await h.one<{ lr: string; revision: number }>(
      `select lr.state as lr, bt.revision from leave_request lr join business_transaction bt on bt.id = lr.transaction_id where lr.id = $1`,
      [id],
    );
    expect(state).toEqual({ lr: 'WITHDRAWN', revision: 2 });
    const keys = (await h.db.query<{ key: string }>(`select idempotency_key as key from leave_movement where request_id = $1`, [id])).rows.map((r) => r.key);
    expect(keys).toEqual(expect.arrayContaining([`leave:reserve:${id}:2`, `leave:release:${id}:2`]));
    expect(await casual()).toMatchObject({ pending: '0.0000', available: '10.0000' });
  });
});

describe('decision racing a withdrawal (data-7)', () => {
  it('leave: one wins, the other gets a clean conflict — never a deadlock 500', async () => {
    const start = monday(4);
    const id = (await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: start, endDate: start })).json().requestId as string;
    const tx = await txOf('leave_request', id);
    const task = (await leaveTasks(manager)).find((t) => t.transactionId === tx)!;

    await h.db.query(`select pg_advisory_lock(${balanceKey})`, [employeeEmp, casualId]);
    const withdraw = h.call(employee, 'POST', `/v1/leave/requests/${id}/withdraw`);
    await waitFor(`wait_event_type = 'Lock' and wait_event = 'advisory'`);
    const decision = decide(manager, 'leave', task.taskId, 'APPROVE');
    await waitFor(`wait_event_type = 'Lock' and wait_event = 'advisory'`, 2);
    await h.db.query(`select pg_advisory_unlock(${balanceKey})`, [employeeEmp, casualId]);
    const [w, d] = await Promise.all([withdraw, decision]);
    expect([w.statusCode, d.statusCode].sort()).toEqual([200, 409]);
    expect((await h.one<{ state: string }>(`select state from leave_request where id = $1`, [id])).state).toBe('WITHDRAWN');
    expect(await casual()).toMatchObject({ pending: '0.0000' });
  });

  it('outdoor duty: return racing withdraw — one wins, the other gets a clean conflict', async () => {
    const day = monday(5);
    const id = (await h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { startDate: day, endDate: day, purpose: 'Client site visit (synthetic)' })).json().requestId as string;
    const tx = await txOf('outdoor_duty_request', id);
    const task = (await workTasks(manager)).find((t) => t.transactionId === tx)!;
    const instance = (await h.one<{ id: string }>(`select id from approval_instance where transaction_id = $1 and state = 'ACTIVE'`, [tx])).id;

    const holder: pg.PoolClient = await h.pool.connect();
    try {
      await holder.query('begin');
      await holder.query(`select 1 from approval_instance where id = $1 for update`, [instance]);
      const withdraw = h.call(employee, 'POST', `/v1/work-requests/outdoor_duty/${id}/withdraw`);
      await waitFor(`wait_event_type = 'Lock' and query like 'update approval_instance%'`);
      const decision = decide(manager, 'work-requests', task.taskId, 'RETURN');
      await waitFor(`wait_event_type = 'Lock' and wait_event = 'advisory'`);
      await holder.query('commit');
      const [w, d] = await Promise.all([withdraw, decision]);
      expect([w.statusCode, d.statusCode].sort()).toEqual([200, 409]);
      expect((await h.one<{ state: string }>(`select state from outdoor_duty_request where id = $1`, [id])).state).toBe('WITHDRAWN');
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
  });
});

describe('leave and outdoor duty never claim the same day (data-3, I-05)', () => {
  it('a leave request on an approved outdoor-duty day is refused, as is the reverse', async () => {
    const day = shift(monday(6), 2);
    const duty = (await h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { startDate: day, endDate: day, purpose: 'Client site visit (synthetic)' })).json().requestId as string;
    const tx = await txOf('outdoor_duty_request', duty);
    const task = (await workTasks(manager)).find((t) => t.transactionId === tx)!;
    expect((await decide(manager, 'work-requests', task.taskId, 'APPROVE')).json().state).toBe('APPROVED');
    expect((await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: day, endDate: day, halfDay: true })).json().error).toBe('OVERLAPS_OUTDOOR_DUTY');

    const day2 = shift(monday(7), 2);
    expect((await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: day2, endDate: day2 })).statusCode).toBe(201);
    expect((await h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { startDate: day2, endDate: day2, purpose: 'x' })).json().error).toBe('OVERLAPS_LEAVE');
  });
});
