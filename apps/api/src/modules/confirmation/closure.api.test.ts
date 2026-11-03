// How a confirmation review closes: HR cancellation (FR-082 "confirming or cancelling the review suppresses future
// open-review reminders"; DF11 "Confirmed/cancelled closes the active task"; BR-031; DF12) and an employee's exit (DF04;
// DF11; FR-081 "update the employee confirmation status only through an approved decision"; F1 withdrawal). A decision
// and an exit that cross are strictly ordered behind the employee's row lock. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { withTransaction } from '../../db/transaction.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { separateDueExits } from '../lifecycle/exit.js';
import { addDays, key, narrowedGrant, statusOf, today as businessDate } from '../lifecycle/lifecycle.fixtures.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { runReminders } from '../notification/reminders.js';
import { cancelConfirmation, openConfirmation, recommend } from './service.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let hr2: TestActor;
let manager: TestActor;
let managerEmp: string;
let today: string;
let system: string;

interface Person {
  emp: string;
  actor: TestActor;
}

const probationer = async (overrides: Record<string, unknown> = {}): Promise<Person> => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, overrides))).json();
  await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
  await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: e.joiningDate });
  return { emp: e.id as string, actor: await h.actor(A, 'EMPLOYEE', { employeeId: e.id }) };
};
const open = async (emp: string): Promise<string> => {
  const res = await h.call(hr, 'POST', '/v1/confirmations', { employeeId: emp });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().caseId as string;
};
const getCase = async (id: string, actor: TestActor = hr) => (await h.call(actor, 'GET', `/v1/confirmations/${id}`)).json();
const recommendation = async (caseId: string, body: Record<string, unknown>) =>
  h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: (await getCase(caseId)).version, reason: 'Manager review (synthetic)', ...body });
const recommendConfirm = async (caseId: string) => {
  const res = await recommendation(caseId, { recommendation: 'CONFIRM', effectiveDate: today });
  expect(res.statusCode, res.body).toBe(200);
};
const taskFor = async (actor: TestActor, emp: string) =>
  ((await h.call(actor, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === emp);
const decide = (actor: TestActor, taskId: string, decision: string, idempotencyKey = uniq('conf-key-')) =>
  h.call(actor, 'POST', `/v1/confirmations/tasks/${taskId}/decision`, { decision, reason: 'HR decision (synthetic)', idempotencyKey });
const cancel = async (caseId: string, actor: TestActor = hr, body: Record<string, unknown> = {}) =>
  h.call(actor, 'POST', `/v1/confirmations/${caseId}/cancel`, { expectedVersion: (await getCase(caseId)).version, reason: 'Review no longer needed (synthetic)', ...body });
const statusChange = (emp: string, status: string) => h.setStatus(A, emp, status);

const setDue = (caseId: string, days: number) => h.db.query(`update employee_confirmation set current_due_date = hrms_business_date(company_id, now()) + $2::int where id = $1`, [caseId, days]);
const reminderEvents = async (caseId: string) =>
  (await h.one<{ n: number }>(`select count(*)::int as n from notification_event where company_id = $1 and event_key like 'CONFIRMATION_%:' || $2 || ':%'`, [A.id, caseId])).n;
/** Runs the reminder job on a day the case's reminder would fire; true when it raised one. */
const reminderFires = async (caseId: string, days: number) => {
  await setDue(caseId, days);
  const before = await reminderEvents(caseId);
  await runReminders(h.pool, A.id);
  return (await reminderEvents(caseId)) > before;
};
const dashboard = async (a: TestActor, code: string) => ((await h.call(a, 'GET', '/v1/dashboard')).json().widgets as { code: string; value?: number }[]).find((w) => w.code === code)!.value!;
const inView = async (view: string, caseId: string) => ((await h.call(hr, 'GET', `/v1/confirmations?view=${view}`)).json().items as { id: string }[]).some((i) => i.id === caseId);
const auditOf = async (caseId: string) =>
  (
    await h.db.query<{ action: string; reason: string | null; actor_user_id: string; before_values: { operational: Record<string, unknown> }; after_values: { operational: Record<string, unknown> } }>(
      `select action, reason, actor_user_id, before_values, after_values from audit_event where company_id = $1 and resource_code = 'employee_confirmation' and record_key = $2 and action = 'CANCEL'`,
      [A.id, caseId],
    )
  ).rows;
const approvalsOf = async (caseId: string) =>
  (
    await h.db.query<{ instance: string; task: string }>(
      `select i.state as instance, t.state as task from employee_confirmation c
         join approval_instance i on i.company_id = c.company_id and i.transaction_id = c.transaction_id
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
        where c.id = $1 order by t.created_at`,
      [caseId],
    )
  ).rows;
const caseFacts = (caseId: string) =>
  h.one<{ state: string; bt: string; actual: string | null; pending: string | null; cancelled_by: string | null; cancel_reason: string | null; actions: number; decisions: number }>(
    `select c.state, bt.state as bt, c.actual_confirmation_date::text as actual, c.pending_recommendation as pending, c.cancelled_by, c.cancel_reason,
            (select count(*)::int from confirmation_action a where a.confirmation_id = c.id) as actions,
            (select count(*)::int from approval_decision d join approval_task t on t.id = d.task_id join approval_instance i on i.id = t.instance_id where i.transaction_id = c.transaction_id) as decisions
       from employee_confirmation c join business_transaction bt on bt.id = c.transaction_id where c.id = $1`,
    [caseId],
  );

// The exit path, through the API.
const resign = (p: Person, date: string) => h.call(p.actor, 'POST', '/v1/me/resignation', { proposedLastWorkingDate: date, reason: 'Synthetic personal reason' });
const exitTask = async (a: TestActor, exitCaseId: string, kind = 'exit_case') =>
  ((await h.call(a, 'GET', '/v1/exit-cases/tasks/mine')).json().items as { taskId: string; kind: string; exitCase: { id: string } | null }[]).find((t) => t.kind === kind && t.exitCase?.id === exitCaseId);
const decideExit = (a: TestActor, taskId: string, body: Record<string, unknown> = { decision: 'APPROVE' }) => h.call(a, 'POST', `/v1/exit-cases/tasks/${taskId}/decision`, { idempotencyKey: key(), ...body });
/** Resignation and the manager's recommendation; the HR decision is left to the caller. */
const exitAwaitingHr = async (p: Person, date = addDays(today, 30)) => {
  const created = await resign(p, date);
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().exitCaseId as string;
  const rec = await h.call(manager, 'POST', `/v1/exit-cases/tasks/${(await exitTask(manager, id))!.taskId}/recommend`, { recommendedLastWorkingDate: date, idempotencyKey: key() });
  expect(rec.statusCode, rec.body).toBe(200);
  return { id, task: (await exitTask(hr, id))!.taskId };
};
const approvedExit = async (p: Person, date = addDays(today, 30)) => {
  const { id, task } = await exitAwaitingHr(p, date);
  const res = await decideExit(hr, task);
  expect(res.statusCode, res.body).toBe(200);
  return id;
};

/** Holds the employee's row, as a transaction in the middle of a decision or an exit does. */
const holdingEmployee = async <T>(emp: string, work: () => Promise<T>): Promise<T> => {
  await h.db.query('begin');
  try {
    await h.db.query(`select 1 from employee where id = $1 for update`, [emp]);
    const result = await work();
    await h.db.query('commit');
    return result;
  } catch (err) {
    await h.db.query('rollback');
    throw err;
  }
};
const untilWaiting = async (n: number) => {
  for (let i = 0; i < 400; i++) {
    const waiting = (await h.pool.query<{ n: number }>(`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)).rows[0]!.n;
    if (waiting >= n) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Fewer than ${n} sessions waited on a lock`);
};

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['exit.read.reason'] });
  hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true), ($1, 'employee_confirmation', $3, 2, true)`, [
    A.id,
    hr.user,
    hr2.user,
  ]);
  expect((await h.call(hr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }, { userId: hr2.user, priority: 2 }] })).statusCode).toBe(200);
  const m = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  managerEmp = m.id;
  await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
  manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
  today = await businessDate(h, A);
  system = await h.makeUser();
});

afterAll(async () => {
  await h?.stop();
});

describe('HR cancels a live review (FR-082, DF11, BR-031)', () => {
  it('cancels an open review with an audited private reason; the employee is untouched, reminders stop and a new case can follow', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    expect(await reminderFires(caseId, 7)).toBe(true);
    await dispatchOutbox(h.pool);
    expect(await inView('UPCOMING', caseId)).toBe(true);
    const due = await dashboard(hr, 'CONFIRMATIONS_DUE');

    const res = await cancel(caseId, hr, { reason: '  Wrong employee selected (synthetic)  ' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ caseId, state: 'CANCELLED' });

    const reasonReader = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['confirmation.read.reason'] });
    const shown = await getCase(caseId);
    expect(shown).toMatchObject({ state: 'CANCELLED', view: 'CANCELLED', extended: false });
    expect(shown.cancelledAt).toBeTruthy();
    expect(JSON.stringify(shown)).not.toContain('Wrong employee');
    expect(JSON.stringify(await getCase(caseId, manager))).not.toContain('Wrong employee');
    expect(JSON.stringify(await getCase(caseId, p.actor))).not.toContain('Wrong employee');
    expect(await getCase(caseId, reasonReader)).toMatchObject({ cancelReason: 'Wrong employee selected (synthetic)' });
    expect(JSON.stringify((await h.call(hr, 'GET', '/v1/confirmations?view=ALL')).json())).not.toContain('Wrong employee');

    expect(await caseFacts(caseId)).toMatchObject({ state: 'CANCELLED', bt: 'CANCELLED', actual: null, cancelled_by: hr.user, cancel_reason: 'Wrong employee selected (synthetic)' });
    expect(await statusOf(h, p.emp)).toBe('ACTIVE_PROBATION');
    expect(await auditOf(caseId)).toEqual([
      expect.objectContaining({ action: 'CANCEL', actor_user_id: hr.user, reason: 'Wrong employee selected (synthetic)', after_values: { operational: { state: 'CANCELLED' } } }),
    ]);

    // BR-031: no more open-review reminders, in any later occurrence.
    for (const days of [1, 0, -7]) expect(await reminderFires(caseId, days)).toBe(false);
    expect(await inView('UPCOMING', caseId)).toBe(false);
    expect(await inView('OVERDUE', caseId)).toBe(false);
    expect(await dashboard(hr, 'CONFIRMATIONS_DUE')).toBe(due - 1);

    // The employee and the manager are told the operational outcome, without the reason.
    await dispatchOutbox(h.pool);
    const inbox = (await h.call(p.actor, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
    expect(inbox.find((n) => n.category === 'CONFIRMATION_DECIDED')?.body).toContain('CANCELLED');
    expect(JSON.stringify(inbox)).not.toContain('Wrong employee');

    // CANCELLED is terminal, and the employee can have a new review.
    const second = await open(p.emp);
    expect(second).not.toBe(caseId);
    expect((await getCase(caseId)).state).toBe('CANCELLED');
  });

  it('cancelling a review waiting for the HR decision closes the active approval and its task', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    await recommendConfirm(caseId);
    const task = (await taskFor(hr, p.emp))!;
    expect(await approvalsOf(caseId)).toEqual([{ instance: 'ACTIVE', task: 'PENDING' }]);

    expect((await cancel(caseId)).statusCode).toBe(200);
    expect(await approvalsOf(caseId)).toEqual([{ instance: 'CANCELLED', task: 'CANCELLED' }]);
    expect(await taskFor(hr, p.emp)).toBeUndefined();
    expect(await caseFacts(caseId)).toMatchObject({ state: 'CANCELLED', bt: 'CANCELLED', pending: null, decisions: 0 });
    // The recommendation it dropped stays on the record.
    expect((await auditOf(caseId))[0]!.before_values.operational).toMatchObject({ state: 'REVIEW_PENDING', recommendation: 'CONFIRM', effectiveDate: today });

    const late = await decide(hr, task.taskId, 'APPROVE');
    expect(late.statusCode).toBe(409);
    expect(late.json().error).toBe('TASK_CLOSED');
    expect(await statusOf(h, p.emp)).toBe('ACTIVE_PROBATION');
  });

  it('refuses a stale version, a closed case, a blank reason, a role without the duty, a case out of scope and one’s own review', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    const version = (await getCase(caseId)).version;
    const refused = async (actor: TestActor, body: Record<string, unknown>, status: number, error?: string) => {
      const res = await h.call(actor, 'POST', `/v1/confirmations/${caseId}/cancel`, { expectedVersion: version, reason: 'Synthetic reason', ...body });
      expect(res.statusCode, res.body).toBe(status);
      if (error) expect(res.json().error).toBe(error);
    };
    await refused(hr, { expectedVersion: version + 1 }, 409, 'STALE_VERSION');
    await refused(hr, { reason: '   ' }, 422, 'REASON_REQUIRED');
    await refused(hr, { reason: '' }, 400);
    expect((await h.call(hr, 'POST', `/v1/confirmations/${caseId}/cancel`, { expectedVersion: version })).statusCode).toBe(400);
    await refused(manager, {}, 403);
    await refused(p.actor, {}, 403);
    const otherDept = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    await refused(otherDept, {}, 404);
    const B = await h.makeCompany();
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    await refused(hrB, {}, 404);
    const hrSelf = await h.actor(A, 'HR_ADMINISTRATOR', { user: p.actor.user });
    await refused(hrSelf, {}, 403, 'SELF_ACTION');
    expect(await caseFacts(caseId)).toMatchObject({ state: 'OPEN', cancelled_by: null });
    expect(await auditOf(caseId)).toEqual([]);

    expect((await cancel(caseId)).statusCode).toBe(200);
    const again = await cancel(caseId);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('INVALID_STATE');

    const confirmed = await probationer();
    const confirmedCase = await open(confirmed.emp);
    await recommendConfirm(confirmedCase);
    expect((await decide(hr, (await taskFor(hr, confirmed.emp))!.taskId, 'APPROVE')).json().state).toBe('CONFIRMED');
    expect((await cancel(confirmedCase)).json().error).toBe('INVALID_STATE');
    expect(await statusOf(h, confirmed.emp)).toBe('ACTIVE_CONFIRMED');
  });

  it('every mutating transaction re-checks the duty after its locks: a narrowing after the route guard records nothing', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    const narrowed = await h.actor(A, 'HR_ADMINISTRATOR');
    const grant = await narrowedGrant(h, A, narrowed, 'confirmation.manage.operational');
    const version = (await getCase(caseId)).version;
    await expect(withTransaction(h.pool, (tx) => cancelConfirmation(tx, grant, caseId, { expectedVersion: version, reason: 'Synthetic reason' }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await caseFacts(caseId)).state).toBe('OPEN');

    const fresh = await probationer();
    await expect(withTransaction(h.pool, (tx) => openConfirmation(tx, grant, fresh.emp))).rejects.toMatchObject({ statusCode: 403 });
    expect((await h.one<{ n: number }>(`select count(*)::int as n from employee_confirmation where employee_id = $1`, [fresh.emp])).n).toBe(0);

    const managerEmp2 = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json().id as string;
    await h.setStatus(A, managerEmp2, 'ACTIVE_CONFIRMED');
    const manager2 = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp2 });
    const report = await probationer();
    await h.call(hr, 'POST', `/v1/employees/${report.emp}/manager`, { managerEmployeeId: managerEmp2, effectiveFrom: '2026-02-01' });
    const reportCase = await open(report.emp);
    const managerGrant = await narrowedGrant(h, A, manager2, 'confirmation.recommend.operational');
    await expect(
      withTransaction(h.pool, (tx) => recommend(tx, managerGrant, reportCase, { expectedVersion: 1, recommendation: 'CONFIRM', effectiveDate: today, reason: 'Synthetic' })),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await caseFacts(reportCase)).state).toBe('OPEN');
  });

  it('a cancellation and an HR decision at the same moment: exactly one takes effect', async () => {
    for (let i = 0; i < 2; i++) {
      const p = await probationer();
      const caseId = await open(p.emp);
      await recommendConfirm(caseId);
      const task = (await taskFor(hr, p.emp))!;
      const version = (await getCase(caseId)).version;
      const [cancelled, decided] = await Promise.all([
        h.call(hr2, 'POST', `/v1/confirmations/${caseId}/cancel`, { expectedVersion: version, reason: 'Synthetic' }),
        decide(hr, task.taskId, 'APPROVE'),
      ]);
      expect([cancelled.statusCode, decided.statusCode].sort()).toEqual([200, 409]);
      const facts = await caseFacts(caseId);
      if (cancelled.statusCode === 200) {
        expect(facts).toMatchObject({ state: 'CANCELLED', actual: null, decisions: 0 });
        expect(await statusOf(h, p.emp)).toBe('ACTIVE_PROBATION');
      } else {
        expect(facts).toMatchObject({ state: 'CONFIRMED', actual: today, cancelled_by: null });
        expect(await statusOf(h, p.emp)).toBe('ACTIVE_CONFIRMED');
      }
    }
  });
});

describe('an exit closes the review (DF04, DF11)', () => {
  it('an approved exit closes an open review; NOTICE stands, and no reminder follows', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    expect(await reminderFires(caseId, 7)).toBe(true);
    const exitId = await approvedExit(p);

    expect(await statusOf(h, p.emp)).toBe('NOTICE');
    expect(await caseFacts(caseId)).toMatchObject({ state: 'CANCELLED', bt: 'CANCELLED', actual: null, cancelled_by: hr.user });
    expect((await auditOf(caseId))[0]!.after_values.operational).toEqual({ state: 'CANCELLED', cause: 'EXIT_APPROVED', exitCaseId: exitId });
    for (const days of [1, 0, -7]) expect(await reminderFires(caseId, days)).toBe(false);
    for (const view of ['UPCOMING', 'DUE', 'OVERDUE', 'EXTENDED']) expect(await inView(view, caseId)).toBe(false);
    // Nothing can reopen it: the manager's recommendation is refused, HR has nothing left to cancel.
    expect((await recommendation(caseId, { recommendation: 'CONFIRM', effectiveDate: today })).json().error).toBe('EMPLOYEE_NOT_ON_PROBATION');
    expect((await cancel(caseId)).json().error).toBe('INVALID_STATE');
    expect((await h.call(hr, 'POST', '/v1/confirmations', { employeeId: p.emp })).statusCode).toBe(422);
  });

  it('an approved exit closes a review waiting for the HR decision with its active approval, and the stale task decides nothing', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    await recommendConfirm(caseId);
    const task = (await taskFor(hr, p.emp))!;
    await approvedExit(p);

    expect(await approvalsOf(caseId)).toEqual([{ instance: 'CANCELLED', task: 'CANCELLED' }]);
    expect(await taskFor(hr, p.emp)).toBeUndefined();
    const late = await decide(hr, task.taskId, 'APPROVE');
    expect(late.statusCode).toBe(409);
    expect(await statusOf(h, p.emp)).toBe('NOTICE');
    expect(await caseFacts(caseId)).toMatchObject({ state: 'CANCELLED', actual: null, decisions: 0 });
  });

  it('an exit still under review or not approved leaves the review running, and a confirmation meanwhile is what the exit records', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    const { task } = await exitAwaitingHr(p);
    expect((await caseFacts(caseId)).state).toBe('OPEN');
    expect((await decideExit(hr, task, { decision: 'REJECT', reason: 'Synthetic private reason', employeeMessage: 'Please talk to HR (synthetic)' })).json().state).toBe('REJECTED');
    expect((await caseFacts(caseId)).state).toBe('OPEN');
    expect(await statusOf(h, p.emp)).toBe('ACTIVE_PROBATION');

    const second = await exitAwaitingHr(p);
    await recommendConfirm(caseId);
    expect((await decide(hr, (await taskFor(hr, p.emp))!.taskId, 'APPROVE')).json().state).toBe('CONFIRMED');
    expect(await statusOf(h, p.emp)).toBe('ACTIVE_CONFIRMED');
    expect((await decideExit(hr, second.task)).statusCode).toBe(200);
    expect(await statusOf(h, p.emp)).toBe('NOTICE');
    expect((await h.one<{ prior_status_code: string }>(`select prior_status_code from exit_case where id = $1`, [second.id])).prior_status_code).toBe('ACTIVE_CONFIRMED');
    expect((await caseFacts(caseId)).state).toBe('CONFIRMED');
  });

  it('separation closes a live review left over and leaves INACTIVE_SEPARATED in place', async () => {
    const p = await probationer();
    const lastDay = addDays(today, 3);
    const exitId = await approvedExit(p, lastDay);
    // A case left live by an approval made before exits closed them.
    await statusChange(p.emp, 'ACTIVE_PROBATION');
    const caseId = await open(p.emp);
    await recommendConfirm(caseId);
    await statusChange(p.emp, 'NOTICE');

    const run = await separateDueExits(h.pool, A.id, addDays(lastDay, 1), system);
    expect(run.separated).toBeGreaterThanOrEqual(1);
    expect(await statusOf(h, p.emp)).toBe('INACTIVE_SEPARATED');
    expect(await caseFacts(caseId)).toMatchObject({ state: 'CANCELLED', bt: 'CANCELLED', cancelled_by: system, pending: null });
    expect(await approvalsOf(caseId)).toEqual([{ instance: 'CANCELLED', task: 'CANCELLED' }]);
    expect((await auditOf(caseId))[0]!.after_values.operational).toEqual({ state: 'CANCELLED', cause: 'SEPARATED', exitCaseId: exitId });
    expect(await reminderFires(caseId, -7)).toBe(false);
  });

  it('refuses a recommendation and every decision for an employee on notice or separated, and never overwrites the status', async () => {
    for (const status of ['NOTICE', 'INACTIVE_SEPARATED']) {
      // Live cases left over from before exits closed them, or a status set some other way.
      const open1 = await probationer();
      const openCase = await open(open1.emp);
      await statusChange(open1.emp, status);
      const refused = await recommendation(openCase, { recommendation: 'CONFIRM', effectiveDate: today });
      expect(refused.statusCode).toBe(409);
      expect(refused.json().error).toBe('EMPLOYEE_NOT_ON_PROBATION');
      expect((await caseFacts(openCase)).state).toBe('OPEN');

      const pending = await probationer();
      const pendingCase = await open(pending.emp);
      await recommendConfirm(pendingCase);
      const task = (await taskFor(hr, pending.emp))!;
      await statusChange(pending.emp, status);
      for (const decision of ['APPROVE', 'REJECT', 'RETURN']) {
        const res = await decide(hr, task.taskId, decision);
        expect(res.statusCode, res.body).toBe(409);
        expect(res.json().error).toBe('EMPLOYEE_NOT_ON_PROBATION');
      }
      expect(await statusOf(h, pending.emp)).toBe(status);
      expect(await caseFacts(pendingCase)).toMatchObject({ state: 'REVIEW_PENDING', actual: null, actions: 0, decisions: 0 });
      expect(await h.one<{ confirmation_date: string | null }>(`select confirmation_date from employee where id = $1`, [pending.emp])).toEqual({ confirmation_date: null });
    }
  });

  it('a decision recorded before the exit still answers its own retry', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    await recommendConfirm(caseId);
    const task = (await taskFor(hr, p.emp))!;
    const idempotencyKey = uniq('conf-key-');
    expect((await decide(hr, task.taskId, 'APPROVE', idempotencyKey)).json().state).toBe('CONFIRMED');
    await approvedExit(p);
    expect(await statusOf(h, p.emp)).toBe('NOTICE');
    const retried = await decide(hr, task.taskId, 'APPROVE', idempotencyKey);
    expect(retried.statusCode, retried.body).toBe(200);
    expect(retried.json()).toMatchObject({ caseId, state: 'CONFIRMED', replayed: true });
    expect(await statusOf(h, p.emp)).toBe('NOTICE');
  });

  it('a live case left over for a leaver is not due: no reminder, no due view or count, shown under All for HR to cancel', async () => {
    const leaver = await probationer();
    const caseId = await open(leaver.emp);
    await setDue(caseId, 7);
    await recommendConfirm(caseId);
    const task = (await taskFor(hr, leaver.emp))!;
    expect(await inView('UPCOMING', caseId)).toBe(true);
    const hrCount = await dashboard(hr, 'CONFIRMATIONS_DUE');
    const teamCount = await dashboard(manager, 'TEAM_REVIEWS');
    const teamRow = async () =>
      ((await h.call(manager, 'GET', `/v1/my-team?search=${(await h.call(hr, 'GET', `/v1/employees/${leaver.emp}`)).json().employeeCode}&page=1&pageSize=25`)).json().items as { id: string; nextReviewDate: string | null }[]).find(
        (m) => m.id === leaver.emp,
      )!;
    expect((await teamRow()).nextReviewDate).toBeTruthy();

    await statusChange(leaver.emp, 'NOTICE');
    expect(await reminderFires(caseId, 7)).toBe(false);
    // The waiting decision would be refused, so it raises no approval reminder or escalation either.
    await h.db.query(`set session_replication_role = replica`);
    try {
      await h.db.query(`update approval_task set created_at = now() - interval '14 days' where id = $1`, [task.taskId]);
    } finally {
      await h.db.query(`set session_replication_role = origin`);
    }
    await runReminders(h.pool, A.id);
    expect((await h.one<{ n: number }>(`select count(*)::int as n from notification_event where company_id = $1 and event_key in ($2, $3)`, [A.id, `APPROVAL_REMINDER:${task.taskId}`, `APPROVAL_ESCALATION:${task.taskId}`])).n).toBe(0);

    for (const view of ['UPCOMING', 'DUE', 'OVERDUE']) expect(await inView(view, caseId)).toBe(false);
    expect(await getCase(caseId)).toMatchObject({ state: 'REVIEW_PENDING', view: 'NOT_ON_PROBATION', extended: false });
    expect(await dashboard(hr, 'CONFIRMATIONS_DUE')).toBe(hrCount - 1);
    expect(await dashboard(manager, 'TEAM_REVIEWS')).toBe(teamCount - 1);
    expect((await teamRow()).nextReviewDate).toBeNull();

    expect((await cancel(caseId)).statusCode).toBe(200);
    expect(await approvalsOf(caseId)).toEqual([{ instance: 'CANCELLED', task: 'CANCELLED' }]);
    expect(await statusOf(h, leaver.emp)).toBe('NOTICE');
  });

  it('an approved withdrawal restores probation but does not reopen the closed review: HR is told and may open a new one', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    await recommendConfirm(caseId);
    const exitId = await approvedExit(p);
    expect((await caseFacts(caseId)).state).toBe('CANCELLED');

    const asked = await h.call(p.actor, 'POST', `/v1/me/exit-cases/${exitId}/withdrawal-request`, { reason: 'Synthetic: staying' });
    expect(asked.statusCode, asked.body).toBe(201);
    const wt = ((await exitTask(hr, exitId, 'exit_withdrawal')) ?? (await exitTask(hr2, exitId, 'exit_withdrawal')))!;
    const decider = (await exitTask(hr, exitId, 'exit_withdrawal')) ? hr : hr2;
    const decided = await h.call(decider, 'POST', `/v1/exit-withdrawals/tasks/${wt.taskId}/decision`, { decision: 'APPROVE', reason: 'Synthetic', idempotencyKey: key() });
    expect(decided.statusCode, decided.body).toBe(200);

    expect(await statusOf(h, p.emp)).toBe('ACTIVE_PROBATION');
    expect(await caseFacts(caseId)).toMatchObject({ state: 'CANCELLED', bt: 'CANCELLED', pending: null });
    expect(await approvalsOf(caseId)).toEqual([{ instance: 'CANCELLED', task: 'CANCELLED' }]);
    expect(await reminderFires(caseId, 7)).toBe(false);
    const attention = (await h.call(hr, 'GET', '/v1/confirmations/attention')).json().items as { employeeId: string; issues: string[] }[];
    expect(attention.find((i) => i.employeeId === p.emp)?.issues).toEqual(['CASE_NOT_OPENED']);

    const next = await open(p.emp);
    expect(next).not.toBe(caseId);
    expect((await getCase(next)).state).toBe('OPEN');
    expect((await caseFacts(caseId)).state).toBe('CANCELLED');
  });
});

describe('a decision and an exit that cross (DF04, FR-081)', () => {
  /** A probationer with a recommendation waiting for HR and a resignation waiting for HR. */
  const crossing = async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    await recommendConfirm(caseId);
    const task = (await taskFor(hr, p.emp))!.taskId;
    const exit = await exitAwaitingHr(p);
    return { p, caseId, task, exit };
  };

  it('the decision first: the employee is confirmed, then goes on notice, and the exit records the confirmed status', async () => {
    const { p, caseId, task, exit } = await crossing();
    const [decided, approved] = await holdingEmployee(p.emp, async () => {
      const decision = decide(hr, task, 'APPROVE');
      await untilWaiting(1);
      const exitDecision = decideExit(hr, exit.task);
      await untilWaiting(2);
      return [decision, exitDecision] as const;
    });
    expect((await decided).json().state).toBe('CONFIRMED');
    const answer = await approved;
    expect(answer.statusCode, answer.body).toBe(200);
    expect(await statusOf(h, p.emp)).toBe('NOTICE');
    expect((await caseFacts(caseId)).state).toBe('CONFIRMED');
    expect((await h.one<{ prior_status_code: string }>(`select prior_status_code from exit_case where id = $1`, [exit.id])).prior_status_code).toBe('ACTIVE_CONFIRMED');
  });

  it('the exit first: the review closes and the decision is refused; NOTICE is not overwritten', async () => {
    const { p, caseId, task, exit } = await crossing();
    const [approved, decided] = await holdingEmployee(p.emp, async () => {
      const exitDecision = decideExit(hr, exit.task);
      await untilWaiting(1);
      const decision = decide(hr, task, 'APPROVE');
      await untilWaiting(2);
      return [exitDecision, decision] as const;
    });
    expect((await approved).statusCode).toBe(200);
    const refused = await decided;
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('TASK_CLOSED');
    expect(await statusOf(h, p.emp)).toBe('NOTICE');
    expect(await caseFacts(caseId)).toMatchObject({ state: 'CANCELLED', actual: null, decisions: 0 });
    expect((await h.one<{ prior_status_code: string }>(`select prior_status_code from exit_case where id = $1`, [exit.id])).prior_status_code).toBe('ACTIVE_PROBATION');
  });

  it('a recommendation that crosses an exit approval is refused and starts no approval', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    const exit = await exitAwaitingHr(p);
    const version = (await getCase(caseId)).version;
    const [approved, recommended] = await holdingEmployee(p.emp, async () => {
      const exitDecision = decideExit(hr, exit.task);
      await untilWaiting(1);
      const rec = h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: version, recommendation: 'CONFIRM', effectiveDate: today, reason: 'Synthetic' });
      await untilWaiting(2);
      return [exitDecision, rec] as const;
    });
    expect((await approved).statusCode).toBe(200);
    expect((await recommended).json().error).toBe('EMPLOYEE_NOT_ON_PROBATION');
    expect((await caseFacts(caseId)).state).toBe('CANCELLED');
    expect(await approvalsOf(caseId)).toEqual([]);
  });

  it('a decision that crosses the separation job is refused; the separated status stands', async () => {
    const p = await probationer();
    const lastDay = addDays(today, 3);
    await approvedExit(p, lastDay);
    await statusChange(p.emp, 'ACTIVE_PROBATION');
    const caseId = await open(p.emp);
    await recommendConfirm(caseId);
    const task = (await taskFor(hr, p.emp))!.taskId;
    const [separated, decided] = await holdingEmployee(p.emp, async () => {
      const job = separateDueExits(h.pool, A.id, addDays(lastDay, 1), system);
      await untilWaiting(1);
      const decision = decide(hr, task, 'APPROVE');
      await untilWaiting(2);
      return [job, decision] as const;
    });
    expect((await separated).separated).toBeGreaterThanOrEqual(1);
    expect((await decided).statusCode).toBe(409);
    expect(await statusOf(h, p.emp)).toBe('INACTIVE_SEPARATED');
    expect(await caseFacts(caseId)).toMatchObject({ state: 'CANCELLED', actual: null, decisions: 0 });
  });

  it('left to run freely, a decision and an exit approval never leave a confirmed status on an approved exit', async () => {
    for (let i = 0; i < 3; i++) {
      const { p, caseId, task, exit } = await crossing();
      const [decided, approved] = await Promise.all([decide(hr, task, 'APPROVE'), decideExit(hr, exit.task)]);
      // Neither path ever deadlocks or errors, whichever comes first.
      expect(approved.statusCode, approved.body).toBe(200);
      expect([200, 409]).toContain(decided.statusCode);
      expect(await statusOf(h, p.emp)).toBe('NOTICE');
      const facts = await caseFacts(caseId);
      const prior = (await h.one<{ prior_status_code: string }>(`select prior_status_code from exit_case where id = $1`, [exit.id])).prior_status_code;
      if (decided.statusCode === 200) {
        expect(facts.state).toBe('CONFIRMED');
        expect(prior).toBe('ACTIVE_CONFIRMED');
      } else {
        expect(facts).toMatchObject({ state: 'CANCELLED', actual: null });
        expect(prior).toBe('ACTIVE_PROBATION');
      }
    }
  });
});

describe('the employee row comes first on every path (the exit path holds it, then takes the case)', () => {
  it('a decision, a recommendation and a cancellation wait for the employee before they take the transaction or the case', async () => {
    const p = await probationer();
    const caseId = await open(p.emp);
    const { transaction_id: transactionId } = await h.one<{ transaction_id: string }>(`select transaction_id from employee_confirmation where id = $1`, [caseId]);
    /** Neither of what the exit path takes next is held by a session that waits for the employee. */
    const caseIsFree = async () => {
      const row = await h.pool.query(`select 1 from employee_confirmation where id = $1 for update nowait`, [caseId]);
      expect(row.rowCount).toBe(1);
      const lock = await h.pool.query<{ ok: boolean }>(`select pg_try_advisory_xact_lock(hashtextextended('bt:' || $1, 0)) as ok`, [transactionId]);
      expect(lock.rows[0]!.ok).toBe(true);
    };

    const version = (await getCase(caseId)).version;
    const [recommended] = await holdingEmployee(p.emp, async () => {
      const pending = h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: version, recommendation: 'CONFIRM', effectiveDate: today, reason: 'Synthetic' });
      await untilWaiting(1);
      await caseIsFree();
      return [pending] as const;
    });
    expect((await recommended).statusCode).toBe(200);
    const task = (await taskFor(hr, p.emp))!.taskId;

    const [returned] = await holdingEmployee(p.emp, async () => {
      const pending = decide(hr, task, 'RETURN');
      await untilWaiting(1);
      await caseIsFree();
      return [pending] as const;
    });
    expect((await returned).json()).toMatchObject({ state: 'OPEN', action: 'RETURNED' });

    const nextVersion = (await getCase(caseId)).version;
    const [cancelled] = await holdingEmployee(p.emp, async () => {
      const pending = h.call(hr, 'POST', `/v1/confirmations/${caseId}/cancel`, { expectedVersion: nextVersion, reason: 'Synthetic' });
      await untilWaiting(1);
      await caseIsFree();
      return [pending] as const;
    });
    expect((await cancelled).statusCode).toBe(200);
    expect((await caseFacts(caseId)).state).toBe('CANCELLED');
  });
});
