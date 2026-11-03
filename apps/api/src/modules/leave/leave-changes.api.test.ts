// Changing leave after a decision: resubmission of returned requests as new revisions, and controlled
// cancellation of approved leave (FR-026, FR-084; DF03; DF05). Synthetic data; dates relative to today.
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

const iso = (d: Date) => d.toISOString().slice(0, 10);
const shift = (base: string, n: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
/** The n-th Monday from today (n = 1 is the next Monday at least 7 days away). */
const monday = (n: number) => {
  const d = new Date(`${shift(iso(new Date()), 7 * n)}T00:00:00Z`);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
};
const weekdayBefore = (days: number) => {
  const d = new Date(`${shift(iso(new Date()), -days)}T00:00:00Z`);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return iso(d);
};

type Task = { taskId: string; kind: string; transactionId: string };
const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/leave/tasks')).json().items as Task[];
const decide = (a: TestActor, taskId: string, decision: string, key = uniq('decision-key-')) =>
  h.call(a, 'POST', `/v1/leave/tasks/${taskId}/decision`, { decision, idempotencyKey: key, ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic reason' }) });
const casual = async () =>
  ((await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/leave-balances`)).json().items as { leaveType: string; available: string; pending: string; taken: string }[]).find(
    (b) => b.leaveType === 'CASUAL',
  )!;
const requestOf = async (id: string) =>
  ((await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/leave-requests`)).json().items as { id: string; state: string; version: number; revision: number; startDate: string; cancellationState: string | null }[]).find(
    (r) => r.id === id,
  )!;
const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];

async function submit(start: string, end = start) {
  const res = await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: start, endDate: end });
  expect(res.statusCode).toBe(201);
  return res.json().requestId as string;
}
async function approved(start: string, end = start) {
  const id = await submit(start, end);
  const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from leave_request where id = $1`, [id])).transaction_id;
  const task = (await tasks(manager)).find((t) => t.transactionId === tx)!;
  expect((await decide(manager, task.taskId, 'APPROVE')).json().state).toBe('APPROVED');
  return id;
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
});

afterAll(async () => {
  await h?.stop();
});

describe('resubmission after return (DF03)', () => {
  it('a returned request is corrected and resubmitted as revision 2 with a new reservation and a new approval', async () => {
    const start = monday(2);
    const id = await submit(start, shift(start, 1)); // 2 days reserved
    expect((await casual()).pending).toBe('2.0000');
    const task = (await tasks(manager)).find((t) => t.kind === 'leave_request')!;
    expect((await decide(manager, task.taskId, 'RETURN')).json().state).toBe('RETURNED');
    expect((await casual()).pending).toBe('0.0000'); // the return released the reservation

    const before = await requestOf(id);
    expect(before).toMatchObject({ state: 'RETURNED', revision: 1 });
    const stale = await h.call(employee, 'PUT', `/v1/leave/requests/${id}`, { startDate: start, endDate: start, expectedVersion: before.version - 1 });
    expect(stale.statusCode).toBe(409);

    const res = await h.call(employee, 'PUT', `/v1/leave/requests/${id}`, { startDate: start, endDate: start, expectedVersion: before.version });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ revision: 2, units: '1', state: 'SUBMITTED' });
    expect(await requestOf(id)).toMatchObject({ state: 'SUBMITTED', revision: 2, startDate: start });
    expect((await casual()).pending).toBe('1.0000');

    const revisions = await h.db.query<{ revision: number; units: string }>(
      `select revision, requested_units::text as units from leave_request_revision where request_id = $1 order by revision`,
      [id],
    );
    expect(revisions.rows).toEqual([
      { revision: 1, units: '2.0000' },
      { revision: 2, units: '1.0000' },
    ]);
    const instances = await h.db.query<{ state: string }>(
      `select i.state from approval_instance i join leave_request lr on lr.transaction_id = i.transaction_id where lr.id = $1 order by i.transaction_revision`,
      [id],
    );
    expect(instances.rows.map((r) => r.state)).toEqual(['RETURNED', 'ACTIVE']);

    // Only a returned request can be resubmitted.
    const again = await h.call(employee, 'PUT', `/v1/leave/requests/${id}`, { startDate: start, endDate: start, expectedVersion: (await requestOf(id)).version });
    expect(again.json().error).toBe('INVALID_STATE');
    const next = (await tasks(manager)).find((t) => t.kind === 'leave_request')!;
    expect((await decide(manager, next.taskId, 'APPROVE')).json().state).toBe('APPROVED');
    expect(await casual()).toMatchObject({ pending: '0.0000', taken: '1.0000' });
  });
});

describe('cancelling approved leave (FR-026, DF03)', () => {
  it('stays approved until the reviewer approves the cancellation, then a reversal restores the units once', async () => {
    const start = monday(4);
    const id = await approved(start, shift(start, 2)); // 3 days consumed
    const taken = (await casual()).taken;

    const withdraw = await h.call(employee, 'POST', `/v1/leave/requests/${id}/withdraw`);
    expect(withdraw.json().error).toBe('INVALID_STATE'); // approved leave is cancelled, not withdrawn
    const res = await h.call(employee, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: 'Plans changed (synthetic)' });
    expect(res.statusCode).toBe(201);
    expect(await requestOf(id)).toMatchObject({ state: 'APPROVED', cancellationState: 'SUBMITTED' });
    expect((await h.call(employee, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: 'Again' })).json().error).toBe('CANCELLATION_PENDING');

    await dispatchOutbox(h.pool);
    expect((await inbox(manager)).find((n) => n.category === 'LEAVE_CANCELLATION_REQUESTED')?.body).toBe(
      `Cancellation of approved CASUAL leave for ${start} to ${shift(start, 2)} (3.00 days) is waiting for your decision.`,
    );

    const task = (await tasks(manager)).find((t) => t.kind === 'leave_cancellation')!;
    expect((await decide(manager, task.taskId, 'RETURN')).json().error).toBe('RETURN_NOT_ALLOWED');
    const key = uniq('decision-key-');
    expect((await decide(manager, task.taskId, 'APPROVE', key)).json().state).toBe('APPROVED');
    expect((await decide(manager, task.taskId, 'APPROVE', key)).json()).toMatchObject({ state: 'APPROVED', replayed: true });

    expect(await requestOf(id)).toMatchObject({ state: 'CANCELLED', cancellationState: 'APPROVED' });
    const after = await casual();
    expect(Number(after.taken)).toBe(Number(taken) - 3);
    const ledger = await h.db.query<{ kind: string; units: string }>(
      `select movement_kind as kind, units::text from leave_movement where request_id = $1 and movement_kind in ('CONSUMPTION', 'REVERSAL') order by created_at`,
      [id],
    );
    expect(ledger.rows).toEqual([
      { kind: 'CONSUMPTION', units: '-3.0000' },
      { kind: 'REVERSAL', units: '3.0000' },
    ]);

    await dispatchOutbox(h.pool);
    expect((await inbox(employee)).find((n) => n.category === 'LEAVE_CANCELLATION_DECIDED')?.body).toBe(
      `Your request to cancel CASUAL leave for ${start} to ${shift(start, 2)} was APPROVED.`,
    );
    expect((await h.call(employee, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: 'Again' })).json().error).toBe('INVALID_STATE');
    // The dates are free again.
    expect((await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: start, endDate: start })).statusCode).toBe(201);
  });

  it('a rejected cancellation leaves the leave approved and the balance untouched; a new cancellation may follow', async () => {
    const start = monday(6);
    const id = await approved(start);
    const taken = (await casual()).taken;
    await h.call(employee, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: 'Maybe not needed (synthetic)' });
    const task = (await tasks(manager)).find((t) => t.kind === 'leave_cancellation')!;
    expect((await decide(manager, task.taskId, 'REJECT')).json().state).toBe('REJECTED');
    expect(await requestOf(id)).toMatchObject({ state: 'APPROVED', cancellationState: 'REJECTED' });
    expect((await casual()).taken).toBe(taken);
    expect((await h.call(employee, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: 'Second try (synthetic)' })).statusCode).toBe(201);
  });

  it('cancelling leave that started more than 7 days ago goes to the HR fallback list (DF05)', async () => {
    const day = weekdayBefore(14);
    const id = await submit(day);
    const hrTask = (await tasks(hr)).find((t) => t.kind === 'leave_request')!;
    expect((await decide(hr, hrTask.taskId, 'APPROVE')).json().state).toBe('APPROVED');
    const { cancellationId } = (await h.call(employee, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: 'Came to work after all (synthetic)' })).json();
    const tx = (await h.one<{ transaction_id: string }>(`select transaction_id from leave_cancellation where id = $1`, [cancellationId])).transaction_id;
    expect((await tasks(hr)).some((t) => t.transactionId === tx)).toBe(true);
    expect((await tasks(manager)).some((t) => t.transactionId === tx)).toBe(false);
  });

  it('only the employee cancels their own leave, and the database refuses a cancellation without approval', async () => {
    const id = await approved(monday(8));
    expect((await h.call(manager, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: 'x' })).statusCode).toBe(403);
    const other = await h.actor(A, 'EMPLOYEE', { employeeId: (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id });
    expect((await h.call(other, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: 'x' })).statusCode).toBe(404);
    await expect(
      h.db.query(
        `with t as (update business_transaction set state = 'CANCELLED' where id = (select transaction_id from leave_request where id = $1))
         update leave_request set state = 'CANCELLED' where id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
