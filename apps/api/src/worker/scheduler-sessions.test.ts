// Sessions (DF10), reminders/escalations (DF03, DF11, BR-031) and the scheduler ledger.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../db/tests/fixtures.js';
import { SYSTEM_ACTOR_ID } from '../audit/actors.js';
import { MODULE_DAILY_JOBS } from '../modules/jobs-registry.js';
import { runReminders } from '../modules/notification/reminders.js';
import { dispatchOutbox } from '../modules/notification/dispatcher.js';
import { type Company, type Harness, startHarness, type TestActor } from '../test/harness.js';
import { runScheduledJobs } from './scheduler.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let manager: TestActor;
let employee: TestActor;
let employeeEmp: string;

/** Test-only time travel: creation metadata is immutable by trigger, so fixture ageing bypasses triggers for one statement. */
const backdateTask = async (taskId: string, interval: string) => {
  await h.db.query("set session_replication_role = replica");
  try {
    await h.db.query("update approval_task set created_at = now() - $2::interval where id = $1", [taskId, interval]);
  } finally {
    await h.db.query("set session_replication_role = origin");
  }
};
const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
const sessionOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()).sid as string;
const mondayAfter = (days: number) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  for (const kind of ['leave_request', 'employee_confirmation']) {
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, $2, $3, 1, true)`, [A.id, kind, hr.user]);
  }
  const create = async (status: string, managerId?: string) => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, status);
    if (managerId) await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerId, effectiveFrom: '2026-01-05' });
    return e.id as string;
  };
  const managerEmp = await create('ACTIVE_CONFIRMED');
  employeeEmp = await create('ACTIVE_CONFIRMED', managerEmp);
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  employee = await h.actor(A, 'EMPLOYEE', { employeeId: employeeEmp });
});

afterAll(async () => {
  await h?.stop();
});

describe('sessions (DF10)', () => {
  it('idle sessions, signed-out sessions and expired sessions stop working on the next request', async () => {
    const a = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await h.call(a, 'GET', '/v1/employees')).statusCode).toBe(200);
    await h.db.query(`update user_session set last_seen_at = now() - interval '31 minutes' where id = $1`, [sessionOf(a.token)]);
    const idle = await h.call(a, 'GET', '/v1/employees');
    expect(idle.statusCode).toBe(401);
    expect(idle.json().error).toBe('SESSION_IDLE');

    const b = await h.actor(A, 'HR_ADMINISTRATOR');
    expect((await h.call(b, 'POST', '/v1/me/logout')).json()).toEqual({ signedOut: true });
    expect((await h.call(b, 'GET', '/v1/employees')).json().error).toBe('SESSION_REVOKED');

    const c = await h.actor(A, 'HR_ADMINISTRATOR');
    await h.db.query(`update user_session set created_at = now() - interval '13 hours', last_seen_at = now(), expires_at = now() - interval '1 hour' where id = $1`, [sessionOf(c.token)]);
    expect((await h.call(c, 'GET', '/v1/employees')).json().error).toBe('SESSION_EXPIRED');
  });

  it("a token cannot ride on another user's session", async () => {
    const other = await h.actor(A, 'HR_ADMINISTRATOR');
    const { issueDevToken } = await import('../auth/tokens.js');
    const { tokenConfig } = await import('../test/harness.js');
    const stolen = { ...hr, token: await issueDevToken(tokenConfig, hr.user, sessionOf(other.token)) };
    expect((await h.call(stolen, 'GET', '/v1/employees')).json().error).toBe('SESSION_WRONG_USER');
  });
});

describe('reminders and escalation (DF03, DF11, BR-031)', () => {
  it('reminds the reviewer after 2 business days and escalates to the fallback list after 5, once each, without changing state', async () => {
    for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items) await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
    await h.call(hr, 'POST', '/v1/leave/adjustments', {
      employeeId: employeeEmp,
      leaveType: 'CASUAL',
      kind: 'OPENING',
      units: '3',
      effectiveDate: '2026-01-05',
      reason: 'Opening (synthetic)',
      idempotencyKey: uniq('open-key-'),
    });
    const { requestId } = (await h.call(employee, 'POST', '/v1/leave/requests', { leaveType: 'CASUAL', startDate: mondayAfter(30), endDate: mondayAfter(30) })).json();
    const task = await h.one<{ id: string }>(
      `select t.id from approval_task t join approval_instance i on i.id = t.instance_id join leave_request lr on lr.transaction_id = i.transaction_id where lr.id = $1`,
      [requestId],
    );

    await backdateTask(task.id, '4 days');
    await runReminders(h.pool, A.id);
    await runReminders(h.pool, A.id);
    // Four calendar days always contain at least two weekdays.
    expect((await inbox(manager)).filter((n) => n.category === 'APPROVAL_REMINDER')).toHaveLength(1);
    expect((await inbox(hr)).filter((n) => n.category === 'APPROVAL_ESCALATION')).toHaveLength(0);

    await backdateTask(task.id, '9 days');
    await runReminders(h.pool, A.id);
    expect((await inbox(hr)).filter((n) => n.category === 'APPROVAL_ESCALATION')).toHaveLength(1);
    expect((await h.one<{ state: string }>(`select state from approval_task where id = $1`, [task.id])).state).toBe('PENDING');
  });

  it('sends confirmation reminders 7 days before due to manager and HR, and weekly overdue reminders', async () => {
    const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
    await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
    const managerEmp = (await h.call(manager, 'GET', `/v1/employees/${employeeEmp}`)).json().manager.id;
    await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: '2026-01-05' });
    const { caseId } = (await h.call(hr, 'POST', '/v1/confirmations', { employeeId: e.id })).json();

    await h.db.query(`update employee_confirmation set current_due_date = hrms_business_date(company_id, now()) + 7 where id = $1`, [caseId]);
    await runReminders(h.pool, A.id);
    await runReminders(h.pool, A.id);
    expect((await inbox(manager)).filter((n) => n.category === 'CONFIRMATION_DUE')).toHaveLength(1);
    expect((await inbox(hr)).filter((n) => n.category === 'CONFIRMATION_DUE')).toHaveLength(1);

    await h.db.query(`update employee_confirmation set current_due_date = hrms_business_date(company_id, now()) - 14 where id = $1`, [caseId]);
    await runReminders(h.pool, A.id);
    const overdue = (await inbox(manager)).filter((n) => n.category === 'CONFIRMATION_OVERDUE');
    expect(overdue).toHaveLength(1);
    expect(overdue[0]!.body).toContain('14 days overdue');
  });
});

describe('scheduler ledger', () => {
  it('runs each daily job once per company-local day, only after its start hour', async () => {
    const day = new Date();
    const atLocal = (hour: number) => new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, 0) - 330 * 60_000); // Asia/Kolkata
    // As worker.ts runs them: every daily job works as an account with no assignment and no employee.
    const deps = { db: h.pool, providers: new Map(), systemUserId: SYSTEM_ACTOR_ID };

    // Effective-dated private profile changes and module jobs starting at midnight run first; reminders and
    // celebrations later in the day. Module jobs come from modules/jobs-registry.ts (active modules only).
    const moduleJobs = (fromHour: (h: number) => boolean) => MODULE_DAILY_JOBS.filter((j) => fromHour(j.fromHour)).map((j) => `${j.code}:${A.id}`);
    const early = await runScheduledJobs(deps, atLocal(7));
    expect(early.ran.filter((r) => r.endsWith(A.id)).sort()).toEqual([`PRIVATE_PROFILE_CHANGES:${A.id}`, ...moduleJobs((h) => h <= 7)].sort());
    const first = await runScheduledJobs(deps, atLocal(10));
    expect(first.ran.filter((r) => r.endsWith(A.id)).sort()).toEqual([`CELEBRATIONS:${A.id}`, `REMINDERS:${A.id}`, ...moduleJobs((h) => h > 7 && h <= 10)].sort());
    const second = await runScheduledJobs(deps, atLocal(11));
    expect(second.ran.filter((r) => r.endsWith(A.id))).toEqual(moduleJobs((h) => h === 11));
    const ledger = await h.one<{ n: string }>(`select count(*) as n from scheduled_job_run where company_id = $1 and outcome = 'OK'`, [A.id]);
    expect(Number(ledger.n)).toBe(3 + MODULE_DAILY_JOBS.filter((j) => j.fromHour <= 11).length);
    expect(await dispatchOutbox(h.pool)).toBe(0); // the scheduler already drained the outbox
  });
});

describe('bulk jobs on the scheduler tick (NFR-S09)', () => {
  it('runs queued bulk jobs in bounded chunks on every tick and reports how many chunks ran', async () => {
    const day = new Date();
    const at = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 11, 0) - 330 * 60_000); // 11:00 Asia/Kolkata
    const deps = { db: h.pool, providers: new Map(), systemUserId: hr.user };
    const res = await h.call(hr, 'POST', '/v1/attendance/processing', { workDate: '2026-03-02' });
    expect(res.statusCode).toBe(202);
    expect((await runScheduledJobs(deps, at)).bulkChunks).toBe(1); // a handful of employees: one chunk
    const job = (await h.call(hr, 'GET', `/v1/bulk-jobs/${res.json().jobId}`)).json();
    expect(job).toMatchObject({ state: 'COMPLETED', errorCode: null });
    expect(job.processed).toBeGreaterThan(0);
    expect((await runScheduledJobs(deps, at)).bulkChunks).toBe(0);
  });
});

// B1 line 2800, "updated metadata on immutable rows stays equal to creation metadata". These read what the tests above left behind.
describe('who the records say acted', () => {
  it.each(['notification_event', 'notification', 'notification_delivery_attempt'])('everything the dispatcher wrote to %s names the system actor', async (table) => {
    const rows = await h.one<{ total: number; other: number }>(
      `select count(*)::int as total, count(*) filter (where created_by is distinct from $2 or updated_by is distinct from $2)::int as other from ${table} where company_id = $1`,
      [A.id, SYSTEM_ACTOR_ID],
    );
    expect(rows.total).toBeGreaterThan(0);
    expect(rows.other).toBe(0);
  });

  it('an audit row’s updated metadata equals its creation metadata', async () => {
    const rows = await h.one<{ total: number; other: number }>(`select count(*)::int as total, count(*) filter (where updated_by is distinct from created_by or created_by is null)::int as other from audit_event where company_id = $1`, [A.id]);
    expect(rows.total).toBeGreaterThan(0);
    expect(rows.other).toBe(0);
  });
});
