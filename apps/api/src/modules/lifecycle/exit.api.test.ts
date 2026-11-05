// Employee exit over HTTP (FR-051, FR-055; DB078; F1 "Employee can submit a resignation operational request; manager
// recommends last working date, HR Admin approves ... Approved last working date is inclusive. Withdrawal before final
// approval is allowed; after approval requires HR independent decision and history"; DF03; DF08; DF12). Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../db/transaction.js';
import { SYSTEM_ACTOR_ID } from '../../audit/actors.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { dispatchOutbox } from '../notification/dispatcher.js';
import { isModuleActive } from '../registry.js';
import { finalRelease, separateDueExits } from './exit.js';
import { addDays, key, narrowedGrant, person, publishedTemplate, statusOf, today as businessDate, trailText } from './lifecycle.fixtures.js';

describe.runIf(isModuleActive('lifecycle'))('employee exit (FR-051, FR-055)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let hr2: TestActor;
  let hrB: TestActor;
  let manager: TestActor;
  let otherManager: TestActor;
  let managerEmp: string;
  let today: string;
  let system: string;
  const staff: Record<string, { emp: string; actor: TestActor }> = {};

  const resign = (a: TestActor, body: Record<string, unknown>) => h.call(a, 'POST', '/v1/me/resignation', { reason: 'Synthetic personal reason', ...body });
  const tasks = async (a: TestActor) =>
    (await h.call(a, 'GET', '/v1/exit-cases/tasks/mine')).json().items as { taskId: string; kind: string; step: string; exitCase: { id: string } | null; withdrawal?: Record<string, unknown> | null }[];
  const taskFor = async (a: TestActor, exitCaseId: string, kind = 'exit_case') => (await tasks(a)).find((t) => t.kind === kind && t.exitCase?.id === exitCaseId);
  const recommend = (a: TestActor, taskId: string, date: string) => h.call(a, 'POST', `/v1/exit-cases/tasks/${taskId}/recommend`, { recommendedLastWorkingDate: date, idempotencyKey: key() });
  const decide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/exit-cases/tasks/${taskId}/decision`, { idempotencyKey: key(), ...body });
  const inbox = async (a: TestActor) => (await h.call(a, 'GET', '/v1/me/notifications')).json().items as { category: string; body: string }[];
  const detail = async (a: TestActor, id: string) => (await h.call(a, 'GET', `/v1/exit-cases/${id}`)).json();

  /** Resignation -> manager recommendation -> HR approval; returns the exit case id. */
  const approvedExit = async (name: string, proposed: string, approved?: string) => {
    const s = staff[name]!;
    const created = await resign(s.actor, { proposedLastWorkingDate: proposed });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().exitCaseId as string;
    expect((await recommend(manager, (await taskFor(manager, id))!.taskId, proposed)).json().state).toBe('RECOMMENDED');
    const t = (await taskFor(hr, id)) ?? (await taskFor(hr2, id));
    const approver = (await taskFor(hr, id)) ? hr : hr2;
    expect((await decide(approver, t!.taskId, { decision: 'APPROVE', ...(approved ? { approvedLastWorkingDate: approved } : {}) })).json().state).toBe('APPROVED');
    return id;
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['exit.read.reason'] });
    hr2 = await h.actor(A, 'HR_ADMINISTRATOR');
    hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    managerEmp = await person(h, A, hr, { name: 'Maya Manager (synthetic)' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    otherManager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await person(h, A, hr, { name: 'Omar Other (synthetic)' }) });
    for (const name of ['approve', 'withdrawEarly', 'withdrawLate', 'release', 'reject', 'race', 'probation']) {
      const emp = await person(h, A, hr, { managerId: managerEmp, name: `${name} person (synthetic)`, status: name === 'probation' ? 'ACTIVE_PROBATION' : 'ACTIVE_CONFIRMED' });
      staff[name] = { emp, actor: await h.actor(A, 'EMPLOYEE', { employeeId: emp }) };
    }
    const noManagerEmp = await person(h, A, hr, { name: 'Nia No-manager (synthetic)' });
    staff.noManager = { emp: noManagerEmp, actor: await h.actor(A, 'EMPLOYEE', { employeeId: noManagerEmp }) };
    expect((await h.call(hr, 'PUT', '/v1/workflows/exit_case/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }, { userId: hr2.user, priority: 2 }] })).statusCode).toBe(200);
    // Withdrawal requests share the exit list.
    expect((await h.call(hr, 'PUT', '/v1/workflows/exit_withdrawal/fallback-reviewers', { reviewers: [{ userId: hr.user, priority: 1 }] })).json().error).toBe('SHARED_ROUTING');
    today = await businessDate(h, A);
    system = SYSTEM_ACTOR_ID;
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('accepts a resignation only from the employee’s own context, with a valid date and one open exit', async () => {
    const s = staff.approve!;
    expect((await resign(s.actor, { proposedLastWorkingDate: addDays(today, -1) })).json().error).toBe('INVALID_LAST_WORKING_DATE');
    expect((await resign(s.actor, { proposedLastWorkingDate: '2026-02-30' })).statusCode).toBe(422);
    // No exit reason catalogue is defined by the BRD: none is seeded, so any code is unknown until configured.
    expect((await resign(s.actor, { proposedLastWorkingDate: addDays(today, 30), reasonCode: 'BETTER_OFFER' })).json().error).toBe('INVALID_REFERENCE');
    // Administrative and manager contexts cannot resign on anyone's behalf.
    expect((await resign(hr, { proposedLastWorkingDate: addDays(today, 30) })).statusCode).toBe(403);
    expect((await resign(manager, { proposedLastWorkingDate: addDays(today, 30) })).statusCode).toBe(403);

    // Two submissions at the same moment: one exit.
    const r = staff.race!;
    const [a, b] = await Promise.all([resign(r.actor, { proposedLastWorkingDate: addDays(today, 30) }), resign(r.actor, { proposedLastWorkingDate: addDays(today, 31) })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    expect((a.statusCode === 409 ? a : b).json().error).toBe('OPEN_EXIT_EXISTS');
    expect(await h.one<{ n: number }>(`select count(*)::int as n from exit_case where employee_id = $1`, [r.emp])).toEqual({ n: 1 });
  });

  it('routes to the manager, then an independent HR Administrator; approval moves the employee to NOTICE', async () => {
    const s = staff.approve!;
    const proposed = addDays(today, 30);
    const created = await resign(s.actor, { proposedLastWorkingDate: proposed });
    expect(created.json()).toMatchObject({ state: 'SUBMITTED', requestDate: today, proposedLastWorkingDate: proposed });
    const id = created.json().exitCaseId as string;
    expect((await resign(s.actor, { proposedLastWorkingDate: proposed })).json().error).toBe('OPEN_EXIT_EXISTS');

    await dispatchOutbox(h.pool);
    expect((await inbox(manager)).find((n) => n.category === 'EXIT_SUBMITTED')!.body).toContain(`proposed last working date of ${proposed}`);

    // Only the direct manager holds the recommendation task; another manager or another company sees nothing.
    expect(await taskFor(otherManager, id)).toBeUndefined();
    expect((await h.call(otherManager, 'GET', `/v1/exit-cases/${id}`)).statusCode).toBe(404);
    expect((await h.call(hrB, 'GET', `/v1/exit-cases/${id}`)).statusCode).toBe(404);
    const mt = (await taskFor(manager, id))!;
    expect(mt.step).toBe('recommend');
    // The HR decision route refuses a recommendation task; dates are validated.
    expect((await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: key() })).statusCode).toBe(403);
    expect((await recommend(manager, mt.taskId, addDays(today, -2))).json().error).toBe('INVALID_LAST_WORKING_DATE');
    const recommended = addDays(today, 25);
    const k = key();
    const rec = await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt.taskId}/recommend`, { recommendedLastWorkingDate: recommended, idempotencyKey: k });
    expect(rec.json()).toMatchObject({ state: 'RECOMMENDED', recommendedLastWorkingDate: recommended, replayed: false });
    // An idempotent replay returns the recorded outcome without a second effect.
    expect((await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt.taskId}/recommend`, { recommendedLastWorkingDate: recommended, idempotencyKey: k })).json()).toMatchObject({ replayed: true });

    // The HR approval task goes to the first listed HR reviewer (never the manager, never the employee).
    const ht = (await taskFor(hr, id))!;
    expect(ht.step).toBe('approve');
    await dispatchOutbox(h.pool);
    expect((await inbox(hr)).find((n) => n.category === 'EXIT_RECOMMENDED')!.body).toContain(recommended);
    expect((await decide(hr2, ht.taskId, { decision: 'APPROVE' })).statusCode).toBe(404);
    expect((await decide(hr, ht.taskId, { decision: 'APPROVE', approvedLastWorkingDate: addDays(today, -1) })).json().error).toBe('INVALID_LAST_WORKING_DATE');
    const approvedDate = addDays(today, 20);
    const decided = await decide(hr, ht.taskId, { decision: 'APPROVE', approvedLastWorkingDate: approvedDate, reason: 'Synthetic HR note' });
    expect(decided.json()).toMatchObject({ state: 'APPROVED', approvedLastWorkingDate: approvedDate });
    expect(await statusOf(h, s.emp)).toBe('NOTICE');
    expect(await h.one<{ d: string }>(`select to_char(hrms_exit_last_working_date($1, $2), 'YYYY-MM-DD') as d`, [A.id, s.emp])).toEqual({ d: approvedDate });

    // The employee sees dates, outcome and their own reason; never the reviewer's note.
    const own = (await h.call(s.actor, 'GET', '/v1/me/exit-cases')).json().items[0];
    expect(own).toMatchObject({
      id,
      state: 'APPROVED',
      requestDate: today,
      proposedLastWorkingDate: proposed,
      recommendedLastWorkingDate: recommended,
      approvedLastWorkingDate: approvedDate,
      lastWorkingDate: approvedDate,
      reason: 'Synthetic personal reason',
      noticePeriod: { status: 'NOT_RECORDED' },
    });
    expect(own.decisions.map((d: { action: string; decision: string }) => [d.action, d.decision])).toEqual([
      ['recommend', 'APPROVE'],
      ['approve', 'APPROVE'],
    ]);
    expect(own.history.map((e: { action: string }) => e.action)).toEqual(['SUBMIT', 'RECOMMEND', 'APPROVE']);
    expect(own.history[2]).toMatchObject({ employeeStatusBefore: 'ACTIVE_CONFIRMED', employeeStatusAfter: 'NOTICE', lastWorkingDate: approvedDate });
    expect(JSON.stringify(own)).not.toContain('Synthetic HR note');
    // The manager sees the operational record but not the private reason; HR with the reason grant does.
    const forManager = await detail(manager, id);
    expect(forManager.state).toBe('APPROVED');
    expect(forManager).not.toHaveProperty('reason');
    expect(await detail(hr2, id)).not.toHaveProperty('reason');
    expect((await detail(hr, id)).reason).toBe('Synthetic personal reason');

    // Notifications carry dates and outcome only.
    await dispatchOutbox(h.pool);
    expect((await inbox(s.actor)).find((n) => n.category === 'EXIT_DECIDED')!.body).toBe(`Your resignation was approved; the last working date is ${approvedDate}.`);
    expect((await inbox(manager)).find((n) => n.category === 'EXIT_DECIDED')!.body).toContain('was approved');
    const trail = await trailText(h, A.id, [id, s.emp]);
    expect(trail).toContain('NOTICE');
    expect(trail).not.toContain('Synthetic personal reason');

    // The submitted facts and decided dates are immutable; nothing is deleted.
    await expect(h.db.query(`update exit_case set proposed_leaving_date = proposed_leaving_date + 1 where id = $1`, [id])).rejects.toThrow(/immutable/);
    await expect(h.db.query(`update exit_case set approved_leaving_date = approved_leaving_date + 1, leaving_date = leaving_date + 1 where id = $1`, [id])).rejects.toThrow(/fixed/);
    await expect(h.db.query(`delete from exit_case where id = $1`, [id])).rejects.toThrow(/cannot be deleted/);
    // Before approval the employee withdraws; afterwards only through the HR decision.
    expect((await h.call(s.actor, 'POST', `/v1/me/exit-cases/${id}/withdraw`)).json().error).toBe('USE_WITHDRAWAL_REQUEST');
  });

  it('separates on the first day after the inclusive last working date, once, keeping all history', async () => {
    const s = staff.approve!;
    const id = (await h.one<{ id: string }>(`select id from exit_case where employee_id = $1`, [s.emp])).id;
    const lwd = addDays(today, 20);
    expect(await separateDueExits(h.pool, A.id, lwd, system)).toEqual({ due: 0, separated: 0, waitingForWithdrawalDecision: 0 });
    expect(await statusOf(h, s.emp)).toBe('NOTICE');
    expect(await separateDueExits(h.pool, A.id, addDays(lwd, 1), system)).toEqual({ due: 1, separated: 1, waitingForWithdrawalDecision: 0 });
    expect(await separateDueExits(h.pool, A.id, addDays(lwd, 2), system)).toEqual({ due: 0, separated: 0, waitingForWithdrawalDecision: 0 });
    expect(await statusOf(h, s.emp)).toBe('INACTIVE_SEPARATED');
    // A separated (or otherwise inactive) employee cannot resign again.
    expect((await resign(s.actor, { proposedLastWorkingDate: addDays(today, 30) })).json().error).toBe('EMPLOYEE_NOT_ACTIVE');
    const d = await detail(hr, id);
    expect(d.state).toBe('SEPARATED');
    expect(d.history.at(-1)).toMatchObject({ action: 'SEPARATE', employeeStatusBefore: 'NOTICE', employeeStatusAfter: 'INACTIVE_SEPARATED', actorUserId: system, businessDate: addDays(lwd, 1) });
    // The employee record, its links and history stay (FR-055): status changes are audited on the employee.
    const audits = (await h.db.query<{ a: string }>(`select after_values->'operational'->>'status' as a from audit_event where record_key = $1 and action = 'STATUS_CHANGE' order by occurred_at`, [s.emp])).rows;
    expect(audits.map((r) => r.a)).toEqual(['NOTICE', 'INACTIVE_SEPARATED']);
    expect(await h.one<{ n: number }>(`select count(*)::int as n from user_employee_link where employee_id = $1`, [s.emp])).toEqual({ n: 1 });
    expect(await h.one<{ s: string }>(`select state as s from business_transaction where id = (select transaction_id from exit_case where id = $1)`, [id])).toEqual({ s: 'SEPARATED' });
  });

  it('lets the employee withdraw before the final decision, preserving the trail', async () => {
    const s = staff.withdrawEarly!;
    const id = (await resign(s.actor, { proposedLastWorkingDate: addDays(today, 40) })).json().exitCaseId as string;
    const mt = (await taskFor(manager, id))!;
    expect((await recommend(manager, mt.taskId, addDays(today, 35))).json().state).toBe('RECOMMENDED');
    // A colleague cannot withdraw it by its id.
    expect((await h.call(staff.reject!.actor, 'POST', `/v1/me/exit-cases/${id}/withdraw`)).statusCode).toBe(404);
    expect((await h.call(s.actor, 'POST', `/v1/me/exit-cases/${id}/withdraw`)).json()).toEqual({ exitCaseId: id, state: 'WITHDRAWN' });
    // The pending HR task is closed; the decision trail and history remain.
    expect(await taskFor(hr, id)).toBeUndefined();
    const own = (await h.call(s.actor, 'GET', '/v1/me/exit-cases')).json().items[0];
    expect(own).toMatchObject({ state: 'WITHDRAWN', recommendedLastWorkingDate: addDays(today, 35) });
    expect(own.history.map((e: { action: string }) => e.action)).toEqual(['SUBMIT', 'RECOMMEND', 'WITHDRAW']);
    expect(own.decisions).toHaveLength(1);
    expect(await statusOf(h, s.emp)).toBe('ACTIVE_CONFIRMED');
    // A new resignation can follow a withdrawn one.
    expect((await resign(s.actor, { proposedLastWorkingDate: addDays(today, 60) })).statusCode).toBe(201);
  });

  it('rejects with a private reason and an employee message', async () => {
    const s = staff.reject!;
    const id = (await resign(s.actor, { proposedLastWorkingDate: addDays(today, 30) })).json().exitCaseId as string;
    await recommend(manager, (await taskFor(manager, id))!.taskId, addDays(today, 30));
    const ht = (await taskFor(hr, id))!;
    expect((await decide(hr, ht.taskId, { decision: 'REJECT', reason: 'Synthetic private reason' })).json().error).toBe('REASON_REQUIRED');
    expect((await decide(hr, ht.taskId, { decision: 'REJECT', reason: 'Synthetic private reason', employeeMessage: 'Please talk to HR first (synthetic)' })).json().state).toBe('REJECTED');
    // A decided task takes no second decision (another key), and a key never moves to another task.
    expect((await decide(hr, ht.taskId, { decision: 'APPROVE' })).json().error).toBe('TASK_CLOSED');
    const own = (await h.call(s.actor, 'GET', '/v1/me/exit-cases')).json().items[0];
    expect(own).toMatchObject({ state: 'REJECTED', employeeMessage: 'Please talk to HR first (synthetic)' });
    expect(JSON.stringify(own)).not.toContain('Synthetic private reason');
    expect(await statusOf(h, s.emp)).toBe('ACTIVE_CONFIRMED');
  });

  it('falls back to HR when there is no manager, and the second step goes to another HR Administrator', async () => {
    const s = staff.noManager!;
    const id = (await resign(s.actor, { proposedLastWorkingDate: addDays(today, 30) })).json().exitCaseId as string;
    const first = (await taskFor(hr, id))!;
    expect(first.step).toBe('recommend');
    expect((await recommend(hr, first.taskId, addDays(today, 28))).json().state).toBe('RECOMMENDED');
    // C4: the recommender never decides the next step.
    expect(await taskFor(hr, id)).toBeUndefined();
    const second = (await taskFor(hr2, id))!;
    expect(second.step).toBe('approve');
    expect((await decide(hr2, second.taskId, { decision: 'APPROVE' })).json()).toMatchObject({ state: 'APPROVED', approvedLastWorkingDate: addDays(today, 28) });
  });

  it('withdraws an approved resignation only through an independent HR decision, restoring the prior status', async () => {
    const s = staff.withdrawLate!;
    const p = staff.probation!;
    const id = await approvedExit('withdrawLate', addDays(today, 15));
    const probationId = await approvedExit('probation', addDays(today, 18));
    expect(await statusOf(h, p.emp)).toBe('NOTICE');
    // A clearance checklist for the probationer's exit, cancelled when the exit is withdrawn.
    await publishedTemplate(h, hr, 'EXIT_STD', 'EXIT', [{ code: 'ASSETS', title: 'Return assets', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false }]);
    const clearance = await h.call(hr, 'POST', `/v1/employees/${p.emp}/processes`, { processCode: 'EXIT_STD', exitCaseId: probationId });
    expect(clearance.statusCode, clearance.body).toBe(201);

    // The rejected path: the approved exit stands.
    const req = await h.call(s.actor, 'POST', `/v1/me/exit-cases/${id}/withdrawal-request`, { reason: 'Synthetic change of plans' });
    expect(req.statusCode).toBe(201);
    expect((await h.call(s.actor, 'POST', `/v1/me/exit-cases/${id}/withdrawal-request`, { reason: 'again' })).json().error).toBe('WITHDRAWAL_PENDING');
    // While the request waits, the separation job leaves the exit alone.
    expect((await separateDueExits(h.pool, A.id, addDays(today, 16), system)).waitingForWithdrawalDecision).toBe(1);
    await dispatchOutbox(h.pool);
    expect((await inbox(hr)).find((n) => n.category === 'EXIT_WITHDRAWAL_SUBMITTED')!.body).toContain(addDays(today, 15));
    const wt = (await taskFor(hr, id, 'exit_withdrawal'))!;
    // The decision task carries the request it decides (its reason under the exit reason grant).
    expect(wt.withdrawal).toMatchObject({ id: req.json().withdrawalId, state: 'SUBMITTED', reason: 'Synthetic change of plans' });
    expect((await taskFor(hr, id))).toBeUndefined();
    const withdrawalDecide = (a: TestActor, taskId: string, body: Record<string, unknown>) => h.call(a, 'POST', `/v1/exit-withdrawals/tasks/${taskId}/decision`, { idempotencyKey: key(), ...body });
    expect((await withdrawalDecide(hr, wt.taskId, { decision: 'REJECT', reason: 'Synthetic: replacement hired' })).json().error).toBe('EMPLOYEE_MESSAGE_REQUIRED');
    expect((await withdrawalDecide(hr, wt.taskId, { decision: 'REJECT', reason: 'Synthetic: replacement hired', employeeMessage: 'Your exit stands (synthetic)' })).json()).toMatchObject({
      state: 'REJECTED',
      exitState: 'APPROVED',
    });
    expect(await statusOf(h, s.emp)).toBe('NOTICE');

    // The approved path for the probationer: status restored, checklist cancelled, all history kept.
    const preq = await h.call(p.actor, 'POST', `/v1/me/exit-cases/${probationId}/withdrawal-request`, { reason: 'Synthetic: staying' });
    const pt = (await taskFor(hr, probationId, 'exit_withdrawal'))!;
    expect((await withdrawalDecide(hr, pt.taskId, { decision: 'APPROVE', reason: 'Synthetic: business agrees' })).json()).toMatchObject({ state: 'APPROVED', exitState: 'WITHDRAWN' });
    expect(await statusOf(h, p.emp)).toBe('ACTIVE_PROBATION');
    expect((await h.call(hr, 'GET', `/v1/employee-processes/${clearance.json().id}`)).json().state).toBe('CANCELLED');
    const pd = (await h.call(p.actor, 'GET', '/v1/me/exit-cases')).json().items[0];
    expect(pd).toMatchObject({ state: 'WITHDRAWN', approvedLastWorkingDate: addDays(today, 18), withdrawals: [expect.objectContaining({ id: preq.json().withdrawalId, state: 'APPROVED', reason: 'Synthetic: staying' })] });
    expect(pd.history.map((e: { action: string }) => e.action)).toEqual(['SUBMIT', 'RECOMMEND', 'APPROVE', 'WITHDRAWAL_REQUESTED', 'WITHDRAWAL_APPROVED']);
    expect(pd.history.at(-1)).toMatchObject({ employeeStatusBefore: 'NOTICE', employeeStatusAfter: 'ACTIVE_PROBATION' });
    expect(pd.decisions.map((d: { action: string }) => d.action)).toEqual(['recommend', 'approve', 'approve']);
    // Each decision names its transaction kind: the resignation's two steps, then the withdrawal request's.
    expect(pd.decisions.map((d: { kind: string }) => d.kind)).toEqual(['exit_case', 'exit_case', 'exit_withdrawal']);
    expect(pd.decisions[0]).not.toHaveProperty('actorUserId');
    expect(await h.one<{ d: string | null }>(`select hrms_exit_last_working_date($1, $2)::text as d`, [A.id, p.emp])).toEqual({ d: null });
    await dispatchOutbox(h.pool);
    expect((await inbox(p.actor)).find((n) => n.category === 'EXIT_WITHDRAWAL_DECIDED')!.body).toBe('Your request to withdraw your resignation was approved; your resignation is withdrawn.');
    // Cancelling an own pending request: the approved exit stays.
    const again = await h.call(s.actor, 'POST', `/v1/me/exit-cases/${id}/withdrawal-request`, { reason: 'Synthetic second thoughts' });
    expect((await h.call(s.actor, 'POST', `/v1/me/exit-withdrawals/${again.json().withdrawalId}/cancel`)).json()).toMatchObject({ state: 'WITHDRAWN' });
    expect((await h.call(staff.reject!.actor, 'POST', `/v1/me/exit-withdrawals/${again.json().withdrawalId}/cancel`)).statusCode).toBe(404);
    const stands = await detail(hr, id);
    expect(stands.state).toBe('APPROVED');
    // F1 inclusive last working date: no final release before it.
    expect((await h.call(hr, 'POST', `/v1/exit-cases/${id}/final-release`, { expectedVersion: stands.version })).json().error).toBe('BEFORE_LAST_WORKING_DATE');
  });

  it('refuses a withdrawal request once the inclusive last working date has passed', async () => {
    const emp = await person(h, A, hr, { managerId: managerEmp, name: 'Late person (synthetic)', status: 'NOTICE' });
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: emp });
    // An approved exit whose last working date was yesterday, written directly (the API never approves a past date).
    await h.db.query('begin');
    let id: string;
    try {
      const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [A.id, emp]);
      id = (
        await h.one<{ id: string }>(
          `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state)
           values ($1, $2, $3, 'RESIGNATION', $4, $5, $5, 'SUBMITTED') returning id`,
          [A.id, emp, bt.id, addDays(today, -20), addDays(today, -1)],
        )
      ).id;
      for (const state of ['RECOMMENDED', 'APPROVED']) await h.db.query(`update business_transaction set state = $2 where id = $1`, [bt.id, state]);
      await h.db.query(
        `update exit_case set state = 'APPROVED', recommended_leaving_date = proposed_leaving_date, recommended_at = now(), approved_leaving_date = proposed_leaving_date,
                              approved_at = now(), prior_status_code = 'ACTIVE_CONFIRMED' where id = $1`,
        [id],
      );
      await h.db.query('commit');
    } catch (err) {
      await h.db.query('rollback');
      throw err;
    }
    expect((await h.call(actor, 'POST', `/v1/me/exit-cases/${id}/withdrawal-request`, { reason: 'Synthetic: too late' })).json().error).toBe('LAST_WORKING_DATE_PASSED');
    expect(await h.one<{ n: number }>(`select count(*)::int as n from exit_withdrawal_request where exit_case_id = $1`, [id])).toEqual({ n: 0 });
  });

  it('records the contractual notice period and finally releases only after a complete clearance', async () => {
    const s = staff.release!;
    const id = await approvedExit('release', addDays(today, 10), today);
    let d = await detail(hr, id);
    // The notice period is recorded from the contract (no default) and audited.
    expect(d.noticePeriod).toEqual({ status: 'NOT_RECORDED' });
    d = (await h.call(hr, 'PUT', `/v1/exit-cases/${id}/notice-period`, { contractualNoticeDays: 30, expectedVersion: d.version })).json();
    expect(d.noticePeriod).toEqual({ status: 'RECORDED', contractualNoticeDays: 30 });
    expect((await h.call(manager, 'PUT', `/v1/exit-cases/${id}/notice-period`, { contractualNoticeDays: 1, expectedVersion: d.version })).statusCode).toBe(403);

    const release = (version: number) => h.call(hr, 'POST', `/v1/exit-cases/${id}/final-release`, { expectedVersion: version });
    expect((await release(d.version)).json().error).toBe('CLEARANCE_NOT_STARTED');
    // A clearance checklist needs an EXIT template, and an EXIT template needs the exit case.
    expect((await h.call(hr, 'POST', `/v1/employees/${s.emp}/processes`, { processCode: 'EXIT_STD' })).json().error).toBe('EXIT_CASE_MISMATCH');
    await publishedTemplate(h, hr, 'EXIT_FULL', 'EXIT', [
      { code: 'ASSETS', title: 'Return assets', ownerRoleCode: 'HR_ADMINISTRATOR', required: true, dueOffsetDays: 0, evidenceRequired: false },
      { code: 'HANDOVER', title: 'Hand over work', ownerRoleCode: 'REPORTING_MANAGER', required: true, dueOffsetDays: 0, evidenceRequired: false },
      { code: 'SURVEY', title: 'Exit survey', ownerRoleCode: 'EMPLOYEE', required: false, dueOffsetDays: 0, evidenceRequired: false },
    ]);
    // A clearance checklist starts only for an approved exit.
    const pendingExit = await h.one<{ id: string; employee_id: string }>(`select id, employee_id from exit_case where employee_id = $1 and state = 'SUBMITTED'`, [staff.withdrawEarly!.emp]);
    expect((await h.call(hr, 'POST', `/v1/employees/${pendingExit.employee_id}/processes`, { processCode: 'EXIT_FULL', exitCaseId: pendingExit.id })).json().error).toBe('EXIT_NOT_APPROVED');
    const started = await h.call(hr, 'POST', `/v1/employees/${s.emp}/processes`, { processCode: 'EXIT_FULL', exitCaseId: id });
    expect(started.statusCode, started.body).toBe(201);
    expect((await h.call(hr, 'POST', `/v1/employees/${s.emp}/processes`, { processCode: 'EXIT_FULL', exitCaseId: id })).json().error).toBe('CLEARANCE_EXISTS');
    const blocked = await release(d.version);
    expect(blocked.json()).toMatchObject({ error: 'CLEARANCE_INCOMPLETE', details: { tasks: ['ASSETS', 'HANDOVER'] } });
    const t = (code: string) => started.json().tasks.find((x: { code: string }) => x.code === code);
    expect((await h.call(hr, 'POST', `/v1/employee-process-tasks/${t('ASSETS').id}/complete`, { expectedVersion: 1 })).statusCode).toBe(200);
    expect((await release(d.version)).json()).toMatchObject({ error: 'CLEARANCE_INCOMPLETE', details: { tasks: ['HANDOVER'] } });
    expect((await h.call(manager, 'POST', `/v1/employee-process-tasks/${t('HANDOVER').id}/complete`, { expectedVersion: 1 })).statusCode).toBe(200);
    // docs/09 §6.5: the release duty is resolved again inside the transaction; withdrawn after the guard, nothing is released.
    const narrowed = await narrowedGrant(h, A, await h.actor(A, 'HR_ADMINISTRATOR'), 'exit.manage.operational');
    await expect(withTransaction(h.pool, (tx) => finalRelease(tx, narrowed, id, { expectedVersion: d.version }))).rejects.toMatchObject({ statusCode: 403 });
    expect((await detail(hr, id)).released).toBe(false);
    // The optional survey is still open: it never blocks the release.
    const released = await release(d.version);
    expect(released.json()).toMatchObject({ released: true, state: 'APPROVED', clearance: { complete: true } });
    expect((await release(released.json().version)).json().error).toBe('ALREADY_RELEASED');
    // A released exit is final: no withdrawal, no reopening its checklist.
    expect((await h.call(s.actor, 'POST', `/v1/me/exit-cases/${id}/withdrawal-request`, { reason: 'late' })).json().error).toBe('EXIT_RELEASED');
    const p = (await h.call(hr, 'GET', `/v1/employee-processes/${started.json().id}`)).json();
    // Its completed clearance tasks stay completed (the checklist is still open, but final).
    const assets = p.tasks.find((x: { code: string }) => x.code === 'ASSETS');
    expect((await h.call(hr, 'POST', `/v1/employee-process-tasks/${assets.id}/reopen`, { expectedVersion: assets.version, reason: 'Synthetic: late' })).json().error).toBe('EXIT_RELEASED');
    const closed = await h.call(hr, 'POST', `/v1/employee-processes/${p.id}/close`, { expectedVersion: p.version });
    expect(closed.json().state).toBe('CLOSED');
    expect((await h.call(hr, 'POST', `/v1/employee-processes/${p.id}/reopen`, { expectedVersion: closed.json().version, reason: 'x' })).json().error).toBe('EXIT_RELEASED');
    expect((await detail(hr, id)).history.map((e: { action: string }) => e.action)).toEqual(['SUBMIT', 'RECOMMEND', 'APPROVE', 'NOTICE_PERIOD_RECORDED', 'FINAL_RELEASE']);
  });

  it('counts an open resignation among the employee’s own pending requests', async () => {
    const s = staff.withdrawEarly!;
    const widgets = (await h.call(s.actor, 'GET', '/v1/dashboard')).json().widgets as { code: string; status: string; value?: number }[];
    expect(widgets.find((w) => w.code === 'MY_REQUESTS')).toMatchObject({ status: 'OK', value: 1 });
  });

  it('pages exit cases with the total of every case in row scope (FR-056)', async () => {
    type Page = { items: { id: string; employeeId: string; state: string }[]; total: number; page?: number; pageSize?: number };
    const list = async (a: TestActor, url: string) => {
      const res = await h.call(a, 'GET', url);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Page;
    };
    const all = await list(hr, '/v1/exit-cases');
    expect(all.total).toBeGreaterThan(1);
    expect(all.items).toHaveLength(all.total);
    expect(all).not.toHaveProperty('page');
    const first = await list(hr, '/v1/exit-cases?page=1&pageSize=25');
    expect(first).toMatchObject({ total: all.total, page: 1, pageSize: 25 });
    expect(first.items.map((x) => x.id)).toEqual(all.items.slice(0, 25).map((x) => x.id));
    const past = Math.ceil(all.total / 25) + 1;
    expect(await list(hr, `/v1/exit-cases?page=${past}&pageSize=25`)).toEqual({ items: [], total: all.total, page: past, pageSize: 25 });
    // Filters and row scope apply to the total: the manager's reports only; another manager's team has none.
    const approved = await list(hr, '/v1/exit-cases?state=APPROVED&page=1&pageSize=25');
    expect(approved.total).toBe(all.items.filter((x) => x.state === 'APPROVED').length);
    const team = await list(manager, '/v1/exit-cases');
    expect(team.total).toBeLessThan(all.total);
    expect(team.items.some((x) => x.employeeId === staff.noManager!.emp)).toBe(false);
    expect(await list(manager, '/v1/exit-cases?page=1&pageSize=25')).toMatchObject({ total: team.items.length, items: team.items.slice(0, 25) });
    expect(await list(otherManager, '/v1/exit-cases?page=1&pageSize=25')).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
    // One employee's cases.
    const one = staff.withdrawLate!.emp;
    expect(await list(hr, `/v1/employees/${one}/exit-cases?page=1&pageSize=25`)).toMatchObject({ total: all.items.filter((x) => x.employeeId === one).length, page: 1, pageSize: 25 });
  });

  it('separates every due exit in one run, reading them in keyset pages', async () => {
    const due: string[] = [];
    for (let i = 0; i < 3; i++) {
      const emp = await person(h, A, hr, { managerId: managerEmp, name: `Due ${i} (synthetic)` });
      staff[`due${i}`] = { emp, actor: await h.actor(A, 'EMPLOYEE', { employeeId: emp }) };
      due.push(await approvedExit(`due${i}`, addDays(today, 40 + i)));
    }
    const runDate = addDays(today, 60);
    const first = await separateDueExits(h.pool, A.id, runDate, system);
    expect(first.due).toBe(first.separated + first.waitingForWithdrawalDecision);
    expect(first.separated).toBeGreaterThanOrEqual(3);
    for (const id of due) expect((await detail(hr, id)).state).toBe('SEPARATED');
    // Nothing separable is left behind for a later run.
    expect((await separateDueExits(h.pool, A.id, runDate, system)).separated).toBe(0);
  });
});
