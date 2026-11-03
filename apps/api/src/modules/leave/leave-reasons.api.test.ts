// Private reasons through leave changes and foreign-task handling (brd-11, brd-15, sec-4; FR-026; DF02; DF03).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let reasonReader: TestActor;
let employeeEmp: string;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const monday = (weeks: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 7 * weeks);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
};
type Task = { taskId: string; transactionId: string; kind: string };
const tasks = async (a: TestActor) => (await h.call(a, 'GET', '/v1/leave/tasks')).json().items as Task[];
const decide = (a: TestActor, taskId: string, decision: string) =>
  h.call(a, 'POST', `/v1/leave/tasks/${taskId}/decision`, { decision, idempotencyKey: uniq('reason-key-'), ...(decision === 'APPROVE' ? {} : { reason: 'Synthetic decision' }) });
const txOf = async (id: string) => (await h.one<{ transaction_id: string }>(`select transaction_id from leave_request where id = $1`, [id])).transaction_id;
const requestAs = async (a: TestActor, id: string) =>
  ((await h.call(a, 'GET', `/v1/employees/${employeeEmp}/leave-requests`)).json().items as { id: string; reason?: string | null; version: number; state: string }[]).find((r) => r.id === id)!;

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  reasonReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['leave.read.reason'] });
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
    leaveType: 'SICK',
    kind: 'OPENING',
    units: '6',
    effectiveDate: '2026-01-05',
    reason: 'Opening balance (synthetic)',
    idempotencyKey: uniq('opening-key-'),
  });
});

afterAll(async () => {
  await h?.stop();
});

describe('private reasons through changes', () => {
  it('a resubmission keeps the earlier private reason unless a new one is given (brd-15)', async () => {
    const day = monday(2);
    const id = (await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'SICK', startDate: day, endDate: day, reason: 'Synthetic private medical reason' })).json().requestId;
    const tx = await txOf(id);
    const task = (await tasks(manager)).find((t) => t.transactionId === tx)!;
    expect((await decide(manager, task.taskId, 'RETURN')).json().state).toBe('RETURNED');
    const returned = await requestAs(employee, id);
    // BRD v8.2 H1/TN10: the employee sees the reason they submitted on their own request.
    expect(returned.reason).toBe('Synthetic private medical reason');
    // A manager without the confidential reason grant still does not.
    expect((await requestAs(manager, id)) as object).not.toHaveProperty('reason');

    expect((await h.call(employee, 'PUT', `/v1/leave/requests/${id}`, { startDate: monday(3), endDate: monday(3), expectedVersion: returned.version })).statusCode).toBe(200);
    expect((await requestAs(reasonReader, id)).reason).toBe('Synthetic private medical reason');
    const revisions = await h.db.query<{ reason: string | null }>(`select reason from leave_request_revision where request_id = $1 order by revision`, [id]);
    expect(revisions.rows.map((r) => r.reason)).toEqual(['Synthetic private medical reason', 'Synthetic private medical reason']);

    // A new reason replaces it.
    const next = (await tasks(manager)).find((t) => t.kind === 'leave_request')!;
    expect((await decide(manager, next.taskId, 'RETURN')).json().state).toBe('RETURNED');
    const again = await requestAs(employee, id);
    expect((await h.call(employee, 'PUT', `/v1/leave/requests/${id}`, { startDate: monday(3), endDate: monday(3), reason: 'Updated synthetic reason', expectedVersion: again.version })).statusCode).toBe(200);
    expect((await requestAs(reasonReader, id)).reason).toBe('Updated synthetic reason');
  });

  it('a cancellation needs a real reason (brd-11)', async () => {
    const day = monday(5);
    const id = (await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'SICK', startDate: day, endDate: day })).json().requestId;
    const tx = await txOf(id);
    const task = (await tasks(manager)).find((t) => t.transactionId === tx)!;
    expect((await decide(manager, task.taskId, 'APPROVE')).json().state).toBe('APPROVED');
    expect((await h.call(employee, 'POST', `/v1/leave/requests/${id}/cancellation`, {})).statusCode).toBe(400);
    expect([400, 422]).toContain((await h.call(employee, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: '   ' })).statusCode);
    expect((await h.call(employee, 'POST', `/v1/leave/requests/${id}/cancellation`, { reason: 'Plans changed (synthetic)' })).statusCode).toBe(201);
  });

  it('another reviewer’s cancellation task reads as not found, whatever the decision (sec-4)', async () => {
    const cancellation = (await tasks(manager)).find((t) => t.kind === 'leave_cancellation')!;
    expect(cancellation).toBeDefined();
    const outsider = await h.actor(A, 'HR_ADMINISTRATOR');
    for (const decision of ['RETURN', 'APPROVE']) {
      expect((await decide(outsider, cancellation.taskId, decision)).statusCode).toBe(404);
    }
    expect((await decide(manager, cancellation.taskId, 'RETURN')).json().error).toBe('RETURN_NOT_ALLOWED');
  });
});
