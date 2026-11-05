// ZT11 for leave: leave.api.test.ts line 247 races two decisions but counted only one movement, and leave-concurrency.api.test.ts races a
// decision against a withdrawal. This asserts what the gate asks for on top: one decision and one audit, ledger and notice effect, the
// same as a request decided once. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { footprintOf, raceOnTransaction, statusesOf, transactionOfTask } from '../../test/race.fixtures.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let employeeEmp: string;
let weeksOut = 2;

const nextMonday = () => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * weeksOut++);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const submitted = async () => {
  const start = nextMonday();
  const res = await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: start, endDate: start });
  expect(res.statusCode, res.body).toBe(201);
  const id = res.json().requestId as string;
  const tx = (await h.one<{ t: string }>(`select transaction_id as t from leave_request where id = $1`, [id])).t;
  const task = ((await h.call(manager, 'GET', '/v1/leave/tasks')).json().items as { taskId: string; transactionId: string }[]).find((t) => t.transactionId === tx)!;
  return { id, tx, taskId: task.taskId };
};
const decide = (taskId: string, decision: string, key = uniq('race-key-')) => h.call(manager, 'POST', `/v1/leave/tasks/${taskId}/decision`, { decision, idempotencyKey: key, ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic reason' }) });
const movements = async (id: string) => (await h.db.query<{ kind: string; units: string }>(`select movement_kind as kind, units::text as units from leave_movement where request_id = $1 order by created_at, movement_kind`, [id])).rows;
const stateOf = async (id: string) => (await h.one<{ state: string }>(`select state from leave_request where id = $1`, [id])).state;
const footprint = (r: { id: string; tx: string }) => footprintOf(h, A.id, r.tx, r.id);

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
  await h.call(hr, 'POST', '/v1/leave/adjustments', { employeeId: employeeEmp, leaveType: 'CASUAL', kind: 'OPENING', units: '40', effectiveDate: '2026-01-05', reason: 'Opening balance (synthetic)', idempotencyKey: uniq('opening-key-') });
});

afterAll(async () => {
  await h?.stop();
});

describe('two decisions on one leave task', () => {
  it('approval queued first: one decision, one consumption, and the same trail as a request decided once', async () => {
    const alone = await submitted();
    expect((await decide(alone.taskId, 'APPROVE')).json().state).toBe('APPROVED');

    const r = await submitted();
    const [approve, reject] = await raceOnTransaction(h, r.tx, [() => decide(r.taskId, 'APPROVE'), () => decide(r.taskId, 'REJECT')]);
    expect(approve!.statusCode, approve!.body).toBe(200);
    expect(reject!.statusCode).toBe(409);
    expect(await stateOf(r.id)).toBe('APPROVED');
    expect(await movements(r.id)).toEqual(await movements(alone.id));
    const raced = await footprint(r);
    expect(raced.decisions).toBe(1);
    expect(raced).toEqual(await footprint(alone));
    expect(raced.audit.length).toBeGreaterThan(0);
    expect(raced.notifications.length).toBeGreaterThan(0);
  });

  it('rejection queued first: one decision, the reservation released once', async () => {
    const alone = await submitted();
    expect((await decide(alone.taskId, 'REJECT')).json().state).toBe('REJECTED');

    const r = await submitted();
    const [reject, approve] = await raceOnTransaction(h, r.tx, [() => decide(r.taskId, 'REJECT'), () => decide(r.taskId, 'APPROVE')]);
    expect(reject!.statusCode, reject!.body).toBe(200);
    expect(approve!.statusCode).toBe(409);
    expect(await stateOf(r.id)).toBe('REJECTED');
    expect(await movements(r.id)).toEqual(await movements(alone.id));
    expect(await footprint(r)).toEqual(await footprint(alone));
  });

  it('the same decision sent twice with one key: both answer, one effect', async () => {
    const r = await submitted();
    const key = uniq('race-key-');
    const results = await raceOnTransaction(h, await transactionOfTask(h, r.taskId), [() => decide(r.taskId, 'APPROVE', key), () => decide(r.taskId, 'APPROVE', key)]);
    expect(statusesOf(results)).toEqual([200, 200]);
    expect((await footprint(r)).decisions).toBe(1);
    expect((await movements(r.id)).filter((m) => m.kind === 'CONSUMPTION')).toHaveLength(1);
  });

  it('with no lock held, however the two interleave: one result', async () => {
    for (let round = 0; round < 4; round++) {
      const r = await submitted();
      const results = await Promise.all([decide(r.taskId, 'APPROVE'), decide(r.taskId, 'REJECT')]);
      expect(statusesOf(results), results.map((x) => x.body).join(' ')).toEqual([200, 409]);
      expect(await stateOf(r.id)).toBe(results[0]!.statusCode === 200 ? 'APPROVED' : 'REJECTED');
      expect((await footprint(r)).decisions).toBe(1);
      expect((await movements(r.id)).filter((m) => m.kind === 'RESERVATION_RELEASE')).toHaveLength(1);
    }
  });
});
