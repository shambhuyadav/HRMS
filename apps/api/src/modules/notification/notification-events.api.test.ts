// What request notifications say (FR-084, BR-033, DF05, DF12): each event is described with the revision it
// was raised for (data-10), withdrawing an outdoor-duty or holiday-work request tells its reviewer (brd-6),
// and day counts are shown with 2 decimals (brd-17). Synthetic data; dates relative to today.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from './dispatcher.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let employeeEmp: string;
// Requests from the revision tests, reused by the fallback test for events queued without a revision.
let returnedLeaveId: string;
let returnedWorkId: string;

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

type Item = { category: string; title: string | null; body: string };
type Task = { taskId: string; transactionId: string; kind: string };
type EventRow = { event_type: string; transaction_revision: number | null; data: Record<string, string> };
const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as Item[];
const bodies = async (a: TestActor, category: string) => (await inbox(a)).filter((n) => n.category === category).map((n) => n.body);
const transactionOf = async (table: string, id: string) => (await h.one<{ transaction_id: string }>(`select transaction_id from ${table} where id = $1`, [id])).transaction_id;
const leaveTask = async (transactionId: string) => ((await h.call(manager, 'GET', '/v1/leave/tasks')).json().items as Task[]).find((t) => t.transactionId === transactionId)!;
const workTask = async (transactionId: string) => ((await h.call(manager, 'GET', '/v1/work-requests/tasks/mine')).json().items as Task[]).find((t) => t.transactionId === transactionId)!;
/** notification_event rows by event key (`outbox:<dedupe key>`). */
const eventsByKey = async (transactionId: string) =>
  new Map(
    (
      await h.db.query<EventRow & { event_key: string }>(
        `select event_key, event_type, transaction_revision, data from notification_event where company_id = $1 and transaction_id = $2`,
        [A.id, transactionId],
      )
    ).rows.map(({ event_key, ...e }) => [event_key, e]),
  );

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
    units: '20',
    effectiveDate: '2026-01-05',
    reason: 'Opening balance (synthetic)',
    idempotencyKey: uniq('opening-key-'),
  });
});

afterAll(async () => {
  await h?.stop();
});

describe('events are described with the revision they were raised for (data-10)', () => {
  it('a returned leave resubmitted with other dates before dispatch: revision 1 events keep revision 1 dates and units', async () => {
    const mon = ahead(3, 1);
    const tue = ahead(3, 2);
    const fri = ahead(3, 5);
    const submitted = await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: mon, endDate: tue });
    expect(submitted.statusCode, submitted.body).toBe(201);
    const id = (returnedLeaveId = submitted.json().requestId as string);
    const tx = await transactionOf('leave_request', id);
    const returned = await h.call(manager, 'POST', `/v1/leave/tasks/${(await leaveTask(tx)).taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic reason', idempotencyKey: uniq('dec-key-') });
    expect(returned.json().state).toBe('RETURNED');
    const version = ((await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/leave-requests`)).json().items as { id: string; version: number }[]).find((r) => r.id === id)!.version;
    const resubmitted = await h.call(employee, 'PUT', `/v1/leave/requests/${id}`, { startDate: fri, endDate: fri, expectedVersion: version });
    expect(resubmitted.json()).toMatchObject({ revision: 2, state: 'SUBMITTED' });

    await dispatchOutbox(h.pool); // all three events are dispatched after the resubmission
    const events = await eventsByKey(tx);
    const submitted1 = events.get(`outbox:leave.submitted:${id}:1`);
    const decided1 = events.get(`outbox:leave.decided:${id}:1`);
    const submitted2 = events.get(`outbox:leave.submitted:${id}:2`);
    expect(submitted1).toMatchObject({ event_type: 'LEAVE_SUBMITTED', transaction_revision: 1, data: { leaveType: 'CASUAL', startDate: mon, endDate: tue } });
    expect(Number(submitted1?.data.units)).toBe(2);
    expect(decided1).toMatchObject({ event_type: 'LEAVE_DECIDED', transaction_revision: 1, data: { startDate: mon, endDate: tue, outcome: 'RETURNED' } });
    expect(submitted2).toMatchObject({ event_type: 'LEAVE_SUBMITTED', transaction_revision: 2, data: { startDate: fri, endDate: fri } });
    expect(Number(submitted2?.data.units)).toBe(1);
    // The claimant is told which request was returned: the one they sent, not the correction.
    expect(await bodies(employee, 'LEAVE_DECIDED')).toContain(`Your CASUAL leave request for ${mon} to ${tue} was RETURNED.`);
  });

  it('a returned outdoor-duty request resubmitted before dispatch: the decision names the returned dates', async () => {
    const mon = ahead(5, 1);
    const tue = ahead(5, 2);
    const submitted = await h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { startDate: mon, endDate: mon, purpose: 'Site survey (synthetic)' });
    expect(submitted.statusCode).toBe(201);
    const id = (returnedWorkId = submitted.json().requestId as string);
    const tx = await transactionOf('outdoor_duty_request', id);
    const returned = await h.call(manager, 'POST', `/v1/work-requests/tasks/${(await workTask(tx)).taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic reason', idempotencyKey: uniq('wr-key-') });
    expect(returned.json().state).toBe('RETURNED');
    const row = ((await h.call(employee, 'GET', `/v1/employees/${employeeEmp}/work-requests`)).json().items as { id: string; version: number }[]).find((r) => r.id === id)!;
    const resubmitted = await h.call(employee, 'PUT', `/v1/work-requests/outdoor_duty/${id}`, { startDate: tue, endDate: tue, purpose: 'Site survey, moved (synthetic)', expectedVersion: row.version });
    expect(resubmitted.json()).toMatchObject({ revision: 2, state: 'SUBMITTED' });

    await dispatchOutbox(h.pool);
    const events = await eventsByKey(tx);
    expect(events.get(`outbox:work_request.submitted:${id}:1`)).toMatchObject({ event_type: 'WORK_REQUEST_SUBMITTED', transaction_revision: 1, data: { startDate: mon, endDate: mon } });
    expect(events.get(`outbox:work_request.decided:${id}:1`)).toMatchObject({
      event_type: 'WORK_REQUEST_DECIDED',
      transaction_revision: 1,
      data: { requestKind: 'outdoor duty', startDate: mon, endDate: mon, outcome: 'RETURNED' },
    });
    expect(events.get(`outbox:work_request.submitted:${id}:2`)).toMatchObject({ event_type: 'WORK_REQUEST_SUBMITTED', transaction_revision: 2, data: { startDate: tue, endDate: tue } });
    expect(await bodies(employee, 'WORK_REQUEST_DECIDED')).toContain(`Your request for outdoor duty from ${mon} to ${mon} was RETURNED.`);
    expect(await bodies(manager, 'WORK_REQUEST_SUBMITTED')).toContain(`A request for outdoor duty from ${tue} to ${tue} is waiting for your decision.`);
  });

  it('events queued before payloads carried a revision are still described, from the current state', async () => {
    const legacy = async (topic: string, aggregateId: string, payload: object) => {
      const dedupeKey = uniq(`legacy:${topic}:`);
      await h.db.query(`insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload) values ($1, $2, $3, $4, $5)`, [A.id, topic, aggregateId, dedupeKey, payload]);
      return `outbox:${dedupeKey}`;
    };
    const leaveKey = await legacy('leave.decided', returnedLeaveId, { requestId: returnedLeaveId, outcome: 'APPROVED' });
    const workKey = await legacy('work_request.decided', returnedWorkId, { kind: 'outdoor_duty', requestId: returnedWorkId, outcome: 'APPROVED' });
    await dispatchOutbox(h.pool);
    const fri = ahead(3, 5);
    const tue = ahead(5, 2);
    expect((await eventsByKey(await transactionOf('leave_request', returnedLeaveId))).get(leaveKey)).toMatchObject({
      event_type: 'LEAVE_DECIDED',
      transaction_revision: 2,
      data: { startDate: fri, endDate: fri, outcome: 'APPROVED' },
    });
    expect((await eventsByKey(await transactionOf('outdoor_duty_request', returnedWorkId))).get(workKey)).toMatchObject({
      event_type: 'WORK_REQUEST_DECIDED',
      transaction_revision: 2,
      data: { startDate: tue, endDate: tue, outcome: 'APPROVED' },
    });
  });
});

describe('withdrawing a work request tells its reviewer (brd-6, DF12)', () => {
  it('a pending outdoor-duty request: the reviewer is told the kind and dates, never the purpose', async () => {
    const wed = ahead(7, 3);
    const id = (await h.call(employee, 'POST', '/v1/work-requests/outdoor_duty', { startDate: wed, endDate: wed, purpose: 'Confidential client visit (synthetic)' })).json().requestId as string;
    expect((await h.call(employee, 'POST', `/v1/work-requests/outdoor_duty/${id}/withdraw`)).json().state).toBe('WITHDRAWN');
    await dispatchOutbox(h.pool); // the reviewer's task is already closed when the notice is delivered

    expect(await bodies(manager, 'WORK_REQUEST_WITHDRAWN')).toContain(`A request for outdoor duty from ${wed} to ${wed} was withdrawn.`);
    expect((await inbox(manager)).find((n) => n.category === 'WORK_REQUEST_WITHDRAWN')?.title).toBe('Work request withdrawn');
    expect(JSON.stringify(await inbox(manager))).not.toContain('Confidential client visit');
    const event = (await eventsByKey(await transactionOf('outdoor_duty_request', id))).get(`outbox:work_request.withdrawn:${id}`);
    expect(event).toMatchObject({ event_type: 'WORK_REQUEST_WITHDRAWN', transaction_revision: 1 });
    expect(JSON.stringify(event)).not.toContain('Confidential client visit');
    expect(await bodies(employee, 'WORK_REQUEST_WITHDRAWN')).toEqual([]); // the employee withdrew it themselves
  });

  it('a returned holiday-work request withdrawn instead of corrected: the reviewer who returned it is told', async () => {
    const sat = ahead(8, 6);
    const id = (await h.call(employee, 'POST', '/v1/work-requests/holiday_work', { startDate: sat, endDate: sat, purpose: 'Release support (synthetic)' })).json().requestId as string;
    const tx = await transactionOf('holiday_work_request', id);
    expect((await h.call(manager, 'POST', `/v1/work-requests/tasks/${(await workTask(tx)).taskId}/decision`, { decision: 'RETURN', reason: 'Synthetic reason', idempotencyKey: uniq('wr-key-') })).json().state).toBe(
      'RETURNED',
    );
    expect((await h.call(employee, 'POST', `/v1/work-requests/holiday_work/${id}/withdraw`)).json().state).toBe('WITHDRAWN');
    await dispatchOutbox(h.pool);
    expect(await bodies(manager, 'WORK_REQUEST_WITHDRAWN')).toContain(`A request for holiday work from ${sat} to ${sat} was withdrawn.`);
  });
});

describe('a malformed outbox payload never blocks the outbox', () => {
  it('an event whose identifiers are not ids is consumed without effect, and the events after it are delivered', async () => {
    const queue = async (topic: string, payload: object) =>
      (
        await h.one<{ id: string }>(
          `insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload) values ($1, $2, gen_random_uuid(), $3, $4) returning id::text as id`,
          [A.id, topic, uniq(`malformed:${topic}:`), payload],
        )
      ).id;
    const malformed = [
      await queue('leave.submitted', { requestId: 'not-a-request-id', taskId: 'not-a-task-id', revision: 1 }),
      await queue('leave.withdrawn', { requestId: returnedLeaveId, taskId: 'not-a-task-id', revision: 2 }),
      await queue('leave.cancellation_requested', { requestId: returnedLeaveId, cancellationId: 42, taskId: null }),
      await queue('work_request.withdrawn', { kind: 'outdoor_duty', requestId: { id: returnedWorkId }, taskId: 'x' }),
      await queue('confirmation.decided', { caseId: 'case-1', outcome: 'CONFIRMED' }),
      await queue('access.grant_approved', { assignmentId: '' }),
    ];
    // A valid event queued after them.
    const fri = ahead(11, 5);
    expect((await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: fri, endDate: fri })).statusCode).toBe(201);

    await expect(dispatchOutbox(h.pool)).resolves.toBeGreaterThan(0);
    const left = await h.db.query(`select id from outbox_event where id = any($1::uuid[]) and published_at is null`, [malformed]);
    expect(left.rowCount).toBe(0);
    expect(await bodies(manager, 'LEAVE_SUBMITTED')).toContain(`A CASUAL leave request for ${fri} to ${fri} (1.00 days) is waiting for your decision.`);
  });
});

describe('day counts are shown with 2 decimals (brd-17, DF05)', () => {
  it('a half day and a three-day request', async () => {
    const thu = ahead(9, 4);
    const mon = ahead(10, 1);
    const wed = ahead(10, 3);
    expect((await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: thu, endDate: thu, halfDay: true })).statusCode).toBe(201);
    expect((await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: mon, endDate: wed })).statusCode).toBe(201);
    await dispatchOutbox(h.pool);
    const submitted = await bodies(manager, 'LEAVE_SUBMITTED');
    expect(submitted).toContain(`A CASUAL leave request for ${thu} to ${thu} (0.50 days) is waiting for your decision.`);
    expect(submitted).toContain(`A CASUAL leave request for ${mon} to ${wed} (3.00 days) is waiting for your decision.`);
    expect(submitted.join('\n')).not.toMatch(/\d\.\d{3,} days/);
  });
});
