// Notifications: committed events, recipients, privacy, replay, delivery-time authority, celebrations
// (FR-061, FR-083/084/085; BR-032/033/034; DF12; CI18; ZT18, ZT23).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox, render, runCelebrations, stillEligible } from './dispatcher.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let employeeEmp: string;

const mondayAfter = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};
const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json() as { items: { id: string; category: string; body: string; readAt: string | null }[]; unread: number };
const submitLeave = (start: string, reason?: string) =>
  h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: start, endDate: start, ...(reason ? { reason } : {}) });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items) {
    await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
  }
  const create = async (overrides = {}) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return e.id as string;
  };
  const managerEmp = await create();
  employeeEmp = await create();
  await h.call(hr, 'POST', `/v1/employees/${employeeEmp}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
  await h.call(hr, 'POST', '/v1/leave/adjustments', {
    employeeId: employeeEmp,
    leaveType: 'CASUAL',
    kind: 'OPENING',
    units: '5',
    effectiveDate: '2026-01-05',
    reason: 'Opening (synthetic)',
    idempotencyKey: uniq('open-key-'),
  });
});

afterAll(async () => {
  await h?.stop();
});

describe('request notifications (FR-084, BR-033)', () => {
  it('notifies the assigned reviewer on submission without the private reason, and the claimant on decision', async () => {
    const day = mondayAfter(20);
    await submitLeave(day, 'Private medical detail (synthetic)');
    await dispatchOutbox(h.pool);

    const reviewer = await inbox(manager);
    const submitted = reviewer.items.find((n) => n.category === 'LEAVE_SUBMITTED');
    expect(submitted?.body).toBe(`A CASUAL leave request for ${day} to ${day} (1.00 days) is waiting for your decision.`); // DF05: 2 decimals shown
    expect(JSON.stringify(reviewer)).not.toContain('medical');
    expect((await inbox(hr)).items).toEqual([]); // not routed to HR, so HR is not told

    const task = (await h.call(manager, 'GET', '/v1/leave/tasks')).json().items[0];
    await h.call(manager, 'POST', `/v1/leave/tasks/${task.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('dec-key-') });
    await dispatchOutbox(h.pool);
    const claimant = await inbox(employee);
    expect(claimant.items.find((n) => n.category === 'LEAVE_DECIDED')?.body).toBe(`Your CASUAL leave request for ${day} to ${day} was APPROVED.`);
  });

  it('replaying the outbox creates no duplicate notification (BR-034)', async () => {
    const before = (await inbox(manager)).items.length;
    await h.db.query(`update outbox_event set published_at = null where company_id = $1`, [A.id]);
    await dispatchOutbox(h.pool);
    expect((await inbox(manager)).items.length).toBe(before);
  });

  it('a failed (rolled back) submission emits nothing (ZT18)', async () => {
    const count = async () => Number((await h.one<{ n: string }>(`select count(*) as n from outbox_event where company_id = $1`, [A.id])).n);
    const before = await count();
    const res = await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: mondayAfter(60), endDate: mondayAfter(80) });
    expect(res.statusCode).toBe(422);
    expect(await count()).toBe(before);
  });

  it('re-checks recipient authority at delivery: a reviewer whose task closed is not notified', async () => {
    const day = mondayAfter(90);
    const { requestId } = (await submitLeave(day)).json();
    await h.call(employee, 'POST', `/v1/leave/requests/${requestId}/withdraw`);
    await dispatchOutbox(h.pool); // both events delivered after the withdrawal

    const states = (
      await h.db.query<{ category: string; state: string; failure: string | null }>(
        `select n.category, n.state, (select failure_code from notification_delivery_attempt a where a.notification_id = n.id) as failure
           from notification n join notification_event e on e.id = n.event_id
          where e.transaction_id = (select transaction_id from leave_request where id = $1) order by n.category`,
        [requestId],
      )
    ).rows;
    expect(states).toEqual([
      { category: 'LEAVE_SUBMITTED', state: 'SUPPRESSED', failure: 'RECIPIENT_NOT_ELIGIBLE' },
      { category: 'LEAVE_WITHDRAWN', state: 'DELIVERED', failure: null },
    ]);
  });

  it('inbox read marks are per recipient; the delivery log needs its own permission', async () => {
    const n = (await inbox(employee)).items[0]!;
    const lastChangedBy = async () => (await h.db.query<{ updated_by: string | null }>(`select updated_by from notification where id = $1`, [n.id])).rows[0]!.updated_by;
    const delivered = await lastChangedBy();
    expect((await h.call(manager, 'POST', `/v1/me/notifications/${n.id}/read`)).statusCode).toBe(404);
    expect(await lastChangedBy()).toBe(delivered);
    expect((await h.call(employee, 'POST', `/v1/me/notifications/${n.id}/read`)).statusCode).toBe(200);
    expect((await inbox(employee)).items.find((x) => x.id === n.id)?.readAt).not.toBeNull();
    // A read is the recipient's own action, so the record names them, not whoever delivered it.
    expect(delivered).toBe(SYSTEM_ACTOR_ID);
    expect(await lastChangedBy()).toBe(employee.user);

    expect((await h.call(employee, 'GET', '/v1/notifications/delivery')).statusCode).toBe(403);
    const sysAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const log = (await h.call(sysAdmin, 'GET', '/v1/notifications/delivery')).json().items;
    expect(log.length).toBeGreaterThan(0);
    expect(log[0]).not.toHaveProperty('body');
  });
});

describe('celebrations (FR-083, BR-032, DF12)', () => {
  /** An active colleague in the Employee role, holding celebration access by its default duty. */
  const colleague = async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return { id: e.id as string, actor: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) };
  };
  const birthday = (a: TestActor) => inbox(a).then((box) => box.items.find((n) => n.category === 'BIRTHDAY'));

  it('are opt-in, omit birth date/year/age, observe 29 Feb on 28 Feb in non-leap years and run once per day', async () => {
    const reader = (await colleague()).actor;
    const optedOut = (await colleague()).actor;
    await h.db.query(`update employee set date_of_birth = '1992-02-29' where id = $1`, [employeeEmp]);
    expect((await runCelebrations(h.pool, A.id, '2027-02-28')).events).toBe(0); // not opted in

    await h.call(employee, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: true });
    await h.call(optedOut, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', receiveOptional: false });
    expect((await runCelebrations(h.pool, A.id, '2027-02-28')).events).toBe(1);
    expect((await runCelebrations(h.pool, A.id, '2027-02-28')).events).toBe(0);

    const message = await birthday(reader);
    expect(message?.body).toMatch(/^Happy birthday, Synthetic Person from ENG!$/);
    expect(message?.body).not.toMatch(/1992|29|age/i);
    expect(await birthday(optedOut)).toBeUndefined(); // opted out of optional
  });

  it('reach active company employees with celebration access only (DF12; decisions-15)', async () => {
    const reader = await colleague();
    const separated = await colleague();
    const noGrantEmp = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id as string;
    await h.setStatus(A, noGrantEmp, 'ACTIVE_CONFIRMED');
    const noGrant = await h.actor(A, 'EMPLOYEE', { employeeId: noGrantEmp, duties: ['employee.read.operational'] });
    const sysAdmin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
    const auditor = await h.actor(A, 'AUDITOR');
    await h.setStatus(A, separated.id, 'INACTIVE_SEPARATED');
    await h.db.query(`update employee set date_of_birth = '1991-03-14' where id = $1`, [employeeEmp]);
    await h.call(employee, 'PUT', '/v1/me/notification-preferences', { eventType: 'BIRTHDAY', publishCelebration: true });
    expect((await runCelebrations(h.pool, A.id, '2029-03-14')).events).toBe(1);

    expect((await birthday(reader.actor))?.body).toMatch(/^Happy birthday/);
    // An account with no employee link: an administrator, an auditor, HR with no employee record, a manager's plain role.
    for (const a of [sysAdmin, auditor, hr]) expect(await birthday(a)).toBeUndefined();
    // A separated employee whose assignment is still active.
    expect(await birthday(separated.actor)).toBeUndefined();
    // An active employee whose assignment does not hold the access.
    expect(await birthday(noGrant)).toBeUndefined();
    const created = await h.one<{ n: string }>(`select count(*) as n from notification n join notification_event e on e.id = n.event_id where e.company_id = $1 and e.occurrence_date = '2029-03-14' and n.recipient_user_id = any($2::uuid[])`, [
      A.id,
      [sysAdmin.user, auditor.user, hr.user, separated.actor.user, noGrant.user],
    ]);
    expect(created.n).toBe('0');
  });

  it('recheck the audience at delivery: access or employment lost after the event is queued suppresses the notice (DF12 "recheck recipient")', async () => {
    const kept = await colleague();
    const revoked = await colleague();
    const left = await colleague();
    const isEligible = (a: TestActor) => withTransaction(h.pool, (tx) => stillEligible(tx, A.id, a.user, 'COMPANY_CELEBRATION_AUDIENCE', { eventType: 'BIRTHDAY', subjectEmployeeId: employeeEmp, transactionId: null, transactionRevision: null, taskId: null, beneficiaryUserId: null, data: {} } as never));
    for (const a of [kept, revoked, left]) expect(await isEligible(a.actor)).toBe(true);
    await h.db.query(
      `update role_assignment_permission set active = false
        where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'celebration' and action = 'read' and field_group = 'operational')`,
      [revoked.actor.assignment],
    );
    await h.setStatus(A, left.id, 'INACTIVE_SEPARATED');
    expect(await isEligible(kept.actor)).toBe(true);
    expect(await isEligible(revoked.actor)).toBe(false);
    expect(await isEligible(left.actor)).toBe(false);
    expect(await isEligible(await h.actor(A, 'SYSTEM_ADMINISTRATOR'))).toBe(false);
  });

  it('work anniversaries use the joining date and exclude separated employees', async () => {
    await h.call(employee, 'PUT', '/v1/me/notification-preferences', { eventType: 'WORK_ANNIVERSARY', publishCelebration: true });
    expect((await runCelebrations(h.pool, A.id, '2026-01-05')).events).toBe(0); // joining day itself is not an anniversary
    expect((await runCelebrations(h.pool, A.id, '2027-01-05')).events).toBe(1);
    await h.setStatus(A, employeeEmp, 'INACTIVE_SEPARATED');
    expect((await runCelebrations(h.pool, A.id, '2028-01-05')).events).toBe(0);
    await h.setStatus(A, employeeEmp, 'ACTIVE_CONFIRMED');
  });
});

describe('template rendering (CI18)', () => {
  it('renders approved placeholders only and blocks on a missing value', () => {
    expect(render('Hi {{name}}', ['name'], { name: 'A' })).toEqual({ text: 'Hi A' });
    expect(render('Hi {{name}} {{salary}}', ['name'], { name: 'A', salary: '100' })).toEqual({ missing: 'salary' });
    expect(render('Hi {{name}}', ['name'], {})).toEqual({ missing: 'name' });
  });
});
