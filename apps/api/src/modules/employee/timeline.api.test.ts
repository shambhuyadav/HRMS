// The employee timeline over HTTP (FR-089 acceptance; BR-038; DF14), built through the real module routes: joining, transfer,
// manager, confirmation decisions, salary, an increment and exit. Salary facts need their own grants, and the as-of view
// reconstructs the approved assignment and salary on a chosen date. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { separateDueExits } from '../lifecycle/exit.js';
import { addDays } from '../lifecycle/lifecycle.fixtures.js';

const FINANCE: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary', 'salary.history_read.salary', 'increment.read.salary', 'increment.history_read.salary', 'increment.propose.salary', 'increment.approve.salary', 'increment.read.reason', 'employee.update.personal'];
const JOINED = '2026-01-31';

interface Event {
  category: string;
  type: string;
  effectiveDate: string;
  actor: string | null;
  onBehalfOf?: string | null;
  reason: string | null;
  source: { kind: string; id: string; decisionId?: string | null } | null;
  details: Record<string, unknown>;
}

describe('employee timeline (FR-089; DF14)', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr: TestActor;
  let hr2: TestActor;
  let plainHr: TestActor;
  let manager: TestActor;
  let managerEmp: string;
  let otherManagerEmp: string;
  let today: string;

  const create = async (overrides: Record<string, unknown> = {}) => {
    const res = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: JOINED, ...overrides }));
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; version: number; employeeCode: string };
  };
  const timeline = async (a: TestActor, id: string, query = '') => {
    const res = await h.call(a, 'GET', `/v1/employees/${id}/timeline${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { employeeCode: string; salaryShown: boolean; events: Event[]; asOf?: Record<string, unknown> };
  };
  const eventsOf = (t: { events: Event[] }, type: string) => t.events.filter((e) => e.type === type);
  const accountKey = async (a: TestActor) => (await h.one<{ k: string }>(`select account_key as k from user_account where id = $1`, [a.user])).k;

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    hr2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    plainHr = await h.actor(A, 'HR_ADMINISTRATOR');
    for (const kind of ['employee_confirmation', 'increment_case', 'exit_case', 'exit_withdrawal']) {
      await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, $2, $3, 1, true), ($1, $2, $4, 2, true)`, [A.id, kind, hr.user, hr2.user]);
    }
    const m = await create({ displayName: 'Manager (synthetic)' });
    managerEmp = m.id;
    await h.setStatus(A, managerEmp, 'ACTIVE_CONFIRMED');
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const other = await create({ displayName: 'Second manager (synthetic)' });
    otherManagerEmp = other.id;
    await h.setStatus(A, otherManagerEmp, 'ACTIVE_CONFIRMED');
    today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('a whole employment, one history', () => {
    let id: string;
    let actor: TestActor;
    let decisionHrKey: string;

    beforeAll(async () => {
      decisionHrKey = await accountKey(hr);
      const e = await create({ displayName: 'Timeline person (synthetic)' });
      id = e.id;
      await h.setStatus(A, id, 'ACTIVE_PROBATION');
      actor = await h.actor(A, 'EMPLOYEE', { employeeId: id });
      expect((await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: JOINED })).statusCode).toBe(200);

      // Confirmation: extended, then confirmed, by independent HR decisions on the manager's recommendation.
      const caseId = (await h.call(hr, 'POST', '/v1/confirmations', { employeeId: id })).json().caseId as string;
      const recommend = async (body: Record<string, unknown>) => {
        const version = (await h.call(hr, 'GET', `/v1/confirmations/${caseId}`)).json().version as number;
        const res = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: version, reason: 'Manager review (synthetic)', ...body });
        expect(res.statusCode, res.body).toBeLessThan(300);
      };
      const approve = async () => {
        const items = (await h.call(hr, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[];
        const task = items.find((t) => t.ownerEmployeeId === id)!;
        const res = await h.call(hr, 'POST', `/v1/confirmations/tasks/${task.taskId}/decision`, { decision: 'APPROVE', reason: 'SECRET-CONFIRM-REASON', idempotencyKey: uniq('conf-key-') });
        expect(res.statusCode, res.body).toBe(200);
      };
      await recommend({ recommendation: 'EXTEND', extensionMonths: 1 });
      await approve();
      await recommend({ recommendation: 'CONFIRM', effectiveDate: '2026-06-01' });
      await approve();

      // A transfer and a change of manager, with reasons.
      const moved = await h.call(hr, 'POST', `/v1/employees/${id}/assignment`, { departmentId: A.financeDept, locationId: A.loc, designationId: A.desig, effectiveFrom: '2026-07-01', reason: 'Reorganisation (synthetic)' });
      expect(moved.statusCode, moved.body).toBe(200);
      expect((await h.call(hr, 'POST', `/v1/employees/${id}/manager`, { managerEmployeeId: otherManagerEmp, effectiveFrom: '2026-07-01' })).statusCode).toBe(200);

      // Salary, then an increment proposed by one HR and approved by the other.
      const salary = await h.call(hr, 'POST', `/v1/employees/${id}/salary`, { effectiveFrom: JOINED, monthlyGross: '100000', annualCtc: '1200000', currency: 'INR' });
      expect(salary.statusCode, salary.body).toBe(201);
      const inc = await h.call(hr2, 'POST', '/v1/increment-cases/off-cycle', { employeeId: id, effectiveDate: addDays(today, 5), proposedAmount: '110000', proposedCounterpart: '1320000', reason: 'SECRET-INCREMENT-REASON' });
      expect(inc.statusCode, inc.body).toBe(201);
      const tasks = (await h.call(hr, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[];
      const applied = await h.call(hr, 'POST', `/v1/increment-cases/tasks/${tasks.find((t) => t.ownerEmployeeId === id)!.taskId}/decision`, { decision: 'APPROVE', reason: 'SECRET-INCREMENT-DECISION', idempotencyKey: uniq('inc-key-') });
      expect(applied.json().state, applied.body).toBe('APPLIED');

      // A master change, whose new value must not be shown.
      const { version } = await h.one<{ version: number }>(`select version from employee where id = $1`, [id]);
      expect((await h.call(hr, 'PATCH', `/v1/employees/${id}`, { expectedVersion: version, dateOfBirth: '1988-03-14' })).statusCode).toBe(200);
    });

    it('has every category, newest first, each with its actor, reason and source decision', async () => {
      const t = await timeline(hr, id);
      expect(t.salaryShown).toBe(true);
      const dates = t.events.map((e) => e.effectiveDate);
      expect(dates).toEqual([...dates].sort().reverse());
      // STATUS: the fixture sets the first status directly, which the history records as such.
      expect(new Set(t.events.map((e) => e.category))).toEqual(new Set(['JOINING', 'STATUS', 'ORGANISATION', 'MANAGER', 'CONFIRMATION', 'MASTER', 'SALARY', 'INCREMENT']));

      expect(eventsOf(t, 'JOINED')).toMatchObject([{ effectiveDate: JOINED, source: { kind: 'EMPLOYEE', id } }]);
      const [moved] = eventsOf(t, 'ASSIGNMENT_CHANGED');
      expect(moved).toMatchObject({ effectiveDate: '2026-07-01', reason: 'Reorganisation (synthetic)', actor: decisionHrKey, source: { kind: 'AUDIT_EVENT' } });
      expect(moved!.details).toMatchObject({ from: { department: expect.any(String) }, to: { department: expect.any(String) } });
      expect((moved!.details.from as { department: string }).department).not.toBe((moved!.details.to as { department: string }).department);
      expect(eventsOf(t, 'MANAGER_CHANGED')).toMatchObject([{ effectiveDate: '2026-07-01', details: { from: { name: 'Manager (synthetic)' }, to: { name: 'Second manager (synthetic)' } } }]);

      const [extended] = eventsOf(t, 'EXTENDED');
      expect(extended).toMatchObject({ category: 'CONFIRMATION', source: { kind: 'CONFIRMATION_CASE', decisionId: expect.any(String) } });
      expect(extended!.details.newDueDate).not.toBe(extended!.details.priorDueDate);
      expect(eventsOf(t, 'CONFIRMED')).toMatchObject([{ effectiveDate: '2026-06-01', actor: decisionHrKey, source: { kind: 'CONFIRMATION_CASE' } }]);

      // The arrangement an increment made is that increment's event, not a second one.
      expect(eventsOf(t, 'SALARY_SET')).toMatchObject([{ effectiveDate: JOINED, details: { monthlyGross: '100000.0000', currency: 'INR' } }]);
      expect(eventsOf(t, 'INCREMENT_APPLIED')).toMatchObject([
        { effectiveDate: addDays(today, 5), reason: 'SECRET-INCREMENT-DECISION', source: { kind: 'INCREMENT_CASE', decisionId: expect.any(String) }, details: { beforeAmount: '100000.0000', afterAmount: '110000.0000', changePercent: '10.00' } },
      ]);
      // access-4 follow-up: every decision here was taken in the decider's own right, so no event names anyone it was taken for.
      expect(t.events.map((e) => e.onBehalfOf)).toEqual(t.events.map(() => null));
    });

    it('names a changed master field and never its value (FR-089 acceptance)', async () => {
      const t = await timeline(hr, id);
      expect(eventsOf(t, 'MASTER_UPDATED')).toMatchObject([{ actor: decisionHrKey, source: { kind: 'AUDIT_EVENT' } }]);
      expect(eventsOf(t, 'MASTER_UPDATED')[0]!.details.fields).toContain('dateOfBirth');
      expect(JSON.stringify(t)).not.toContain('1988-03-14');
    });

    it('withholds salary and increment events entirely without their grants, and each reason without its own (DF14)', async () => {
      const t = await timeline(plainHr, id);
      expect(t.salaryShown).toBe(false);
      expect(t.events.filter((e) => ['SALARY', 'INCREMENT'].includes(e.category))).toEqual([]);
      const text = JSON.stringify(t);
      expect(text).not.toContain('100000');
      expect(text).not.toContain('SECRET-INCREMENT-DECISION');
      expect((await timeline(plainHr, id, `?asOf=${today}`)).asOf).not.toHaveProperty('salary');

      // C4: the plain read grants do not open the past here either.
      const plainReads = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['salary.read.salary', 'increment.read.salary'] });
      const unopened = await timeline(plainReads, id);
      expect(unopened.salaryShown).toBe(false);
      expect(unopened.events.filter((e) => ['SALARY', 'INCREMENT'].includes(e.category))).toEqual([]);
      expect((await timeline(plainReads, id, `?asOf=${today}`)).asOf).not.toHaveProperty('salary');

      const salaryOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['salary.history_read.salary'] });
      const seen = await timeline(salaryOnly, id);
      expect(eventsOf(seen, 'INCREMENT_APPLIED')).toEqual([]);
      // Without increment access the same arrangement shows as a plain salary change, with no percentage.
      expect(eventsOf(seen, 'SALARY_SET').map((e) => e.details.monthlyGross).sort()).toEqual(['100000.0000', '110000.0000']);
      expect(JSON.stringify(seen)).not.toContain('changePercent');

      const noReason = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['increment.history_read.salary'] });
      expect(eventsOf(await timeline(noReason, id), 'INCREMENT_APPLIED')).toMatchObject([{ reason: null, details: { changePercent: '10.00' } }]);
    });

    it('a decision reason follows its own grant', async () => {
      const historyOnly = await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['employee.read_history.operational'] });
      expect(eventsOf(await timeline(historyOnly, id), 'CONFIRMED')).toMatchObject([{ reason: null, source: { kind: 'CONFIRMATION_CASE' } }]);
      const withReason = await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['employee.read_history.operational', 'confirmation.read.reason'] });
      expect(eventsOf(await timeline(withReason, id), 'CONFIRMED')).toMatchObject([{ reason: 'SECRET-CONFIRM-REASON' }]);
    });

    it('reconstructs the approved assignment, manager, status and salary on a chosen date (FR-089 acceptance)', async () => {
      const on = async (day: string) => (await timeline(hr, id, `?asOf=${day}`)).asOf as { date: string; status: string | null; assignment: { department: string } | null; manager: { name: string } | null; salary: { monthlyGross: string } | null };
      const before = await on('2026-01-30');
      expect(before).toMatchObject({ date: '2026-01-30', assignment: null, manager: null, salary: null });
      const early = await on('2026-03-01');
      expect(early).toMatchObject({ manager: { name: 'Manager (synthetic)' }, salary: { monthlyGross: '100000.0000', currency: 'INR' } });
      const late = await on('2026-08-01');
      expect(late.manager).toMatchObject({ name: 'Second manager (synthetic)' });
      expect(late.assignment!.department).not.toBe(early.assignment!.department);
      expect(late.salary).toMatchObject({ monthlyGross: '100000.0000' });
      expect((await on(addDays(today, 5))).salary).toMatchObject({ monthlyGross: '110000.0000' });
      expect((await on(today)).salary).toMatchObject({ monthlyGross: '100000.0000' });
    });

    it('follows row scope and refuses without the duty', async () => {
      const hrFiltered = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
      // Moved to finance: a department-filtered HR no longer reaches this employee.
      expect((await h.call(hrFiltered, 'GET', `/v1/employees/${id}/timeline`)).statusCode).toBe(404);
      expect((await h.call(await h.actor(B, 'HR_ADMINISTRATOR'), 'GET', `/v1/employees/${id}/timeline`)).statusCode).toBe(404);
      expect((await h.call(actor, 'GET', `/v1/employees/${id}/timeline`)).statusCode).toBe(403);
      expect((await h.call(hr, 'GET', `/v1/employees/${id}/timeline?asOf=not-a-date`)).statusCode).toBe(400);
    });
  });

  describe('corrections are new events (FR-089 "Reversal/correction is a new linked event")', () => {
    it('keeps a corrected joining date beside the correction', async () => {
      const e = await create({ joiningDate: '2026-03-02' });
      expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/joining-date`, { reason: 'Offer moved (synthetic)', expectedVersion: e.version, joiningDate: '2026-03-16' })).statusCode).toBe(200);
      const t = await timeline(hr, e.id);
      expect(eventsOf(t, 'JOINED')).toMatchObject([{ effectiveDate: '2026-03-16' }]);
      expect(eventsOf(t, 'JOINING_DATE_CORRECTED')).toMatchObject([{ reason: 'Offer moved (synthetic)', details: { priorDate: '2026-03-02', newDate: '2026-03-16' } }]);
    });

    it('shows a removed manager with its reason', async () => {
      const e = await create();
      await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
      expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: JOINED })).statusCode).toBe(200);
      expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: null, effectiveFrom: '2026-05-01', reason: 'Top of the line (synthetic)' })).statusCode).toBe(200);
      const t = await timeline(hr, e.id);
      expect(eventsOf(t, 'MANAGER_SET')).toMatchObject([{ effectiveDate: JOINED }]);
      expect(eventsOf(t, 'MANAGER_REMOVED')).toMatchObject([{ effectiveDate: '2026-05-01', reason: 'Top of the line (synthetic)', details: { to: null } }]);
      expect((await timeline(hr, e.id, '?asOf=2026-06-01')).asOf).toMatchObject({ manager: null });
    });

    it('shows an approved exit, its withdrawal and a separation, each linked to the exit case', async () => {
      const resign = async () => {
        const e = await create({ displayName: 'Leaver (synthetic)' });
        await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
        expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: JOINED })).statusCode).toBe(200);
        const self = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
        const lwd = addDays(today, 20);
        const exitId = (await h.call(self, 'POST', '/v1/me/resignation', { reason: 'SECRET-EXIT-REASON', proposedLastWorkingDate: lwd })).json().exitCaseId as string;
        const taskOf = async (a: TestActor, kind: string) => ((await h.call(a, 'GET', '/v1/exit-cases/tasks/mine')).json().items as { taskId: string; kind: string; exitCase: { id: string } | null }[]).find((x) => x.kind === kind && x.exitCase?.id === exitId);
        const mt = await taskOf(manager, 'exit_case');
        expect((await h.call(manager, 'POST', `/v1/exit-cases/tasks/${mt!.taskId}/recommend`, { recommendedLastWorkingDate: lwd, idempotencyKey: uniq('lc-key-') })).statusCode).toBeLessThan(300);
        const decider = (await taskOf(hr, 'exit_case')) ? hr : hr2;
        const decided = await h.call(decider, 'POST', `/v1/exit-cases/tasks/${(await taskOf(decider, 'exit_case'))!.taskId}/decision`, { decision: 'APPROVE', idempotencyKey: uniq('lc-key-') });
        expect(decided.json().state, decided.body).toBe('APPROVED');
        return { id: e.id, self, exitId, lwd, taskOf };
      };

      const leaver = await resign();
      const system = await h.makeUser();
      expect(await separateDueExits(h.pool, A.id, addDays(leaver.lwd, 1), system)).toMatchObject({ separated: 1 });
      const t = await timeline(hr, leaver.id);
      expect(eventsOf(t, 'EXIT_APPROVED')).toMatchObject([{ category: 'EXIT', effectiveDate: today, source: { kind: 'EXIT_CASE', id: leaver.exitId, decisionId: expect.any(String) }, details: { status: 'NOTICE', lastWorkingDate: leaver.lwd } }]);
      expect(eventsOf(t, 'SEPARATION')).toMatchObject([{ category: 'EXIT', effectiveDate: addDays(leaver.lwd, 1), source: { kind: 'EXIT_CASE', id: leaver.exitId }, details: { status: 'INACTIVE_SEPARATED' } }]);
      expect(eventsOf(t, 'SEPARATION')[0]!.reason).toBeNull();
      expect((await timeline(hr, leaver.id, `?asOf=${addDays(leaver.lwd, 1)}`)).asOf).toMatchObject({ status: 'INACTIVE_SEPARATED' });
      // The exit reason is a private note of its own group.
      const historyOnly = await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['employee.read_history.operational'] });
      expect(JSON.stringify(await timeline(historyOnly, leaver.id))).not.toContain('SECRET-EXIT-REASON');
      const withReason = await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['employee.read_history.operational', 'exit.read.reason'] });
      expect(eventsOf(await timeline(withReason, leaver.id), 'EXIT_APPROVED')).toMatchObject([{ reason: 'SECRET-EXIT-REASON' }]);

      const stayer = await resign();
      expect((await h.call(stayer.self, 'POST', `/v1/me/exit-cases/${stayer.exitId}/withdrawal-request`, { reason: 'Synthetic change of plans' })).statusCode).toBeLessThan(300);
      const decider = (await stayer.taskOf(hr, 'exit_withdrawal')) ? hr : hr2;
      const done = await h.call(decider, 'POST', `/v1/exit-withdrawals/tasks/${(await stayer.taskOf(decider, 'exit_withdrawal'))!.taskId}/decision`, { decision: 'APPROVE', reason: 'Synthetic', idempotencyKey: uniq('lc-key-') });
      expect(done.statusCode, done.body).toBeLessThan(300);
      const back = await timeline(hr, stayer.id);
      expect(eventsOf(back, 'EXIT_APPROVED')).toHaveLength(1);
      expect(eventsOf(back, 'EXIT_WITHDRAWN')).toMatchObject([{ source: { kind: 'EXIT_CASE', id: stayer.exitId }, details: { status: 'ACTIVE_CONFIRMED', priorStatus: 'NOTICE' } }]);
    });
  });

  // Last: the delegation below routes hr's later confirmation tasks to the delegate.
  describe('a decision taken under a delegation (access-4 follow-up; C4 "Preserve delegator, delegate and actual actor in history"; I-57 item 7)', () => {
    it('access-4 FR-089 C4: a confirmation decided by a delegate shows the delegate as its actor and the reviewer it was taken for', async () => {
      const admin = await h.actor(A, 'SYSTEM_ADMINISTRATOR');
      const delegateHr = await h.actor(A, 'HR_ADMINISTRATOR');
      // hr, the first reviewer of confirmations, delegates its confirmation decisions, approved by an independent System Administrator.
      const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
      const asked = await h.call(hr, 'POST', '/v1/access/delegations', { delegateUserId: delegateHr.user, permission: 'confirmation.decide.operational', effectiveFrom: iso(-60_000), effectiveTo: iso(5 * 86_400_000) });
      expect(asked.statusCode, asked.body).toBe(201);
      const approved = await h.call(admin, 'POST', `/v1/access/delegations/${asked.json().id}/approve`, { expectedVersion: 1 });
      expect(approved.statusCode, approved.body).toBe(200);

      const e = await create({ displayName: 'Delegated decision (synthetic)' });
      await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
      expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp, effectiveFrom: JOINED })).statusCode).toBe(200);
      const caseId = (await h.call(hr, 'POST', '/v1/confirmations', { employeeId: e.id })).json().caseId as string;
      const version = (await h.call(hr, 'GET', `/v1/confirmations/${caseId}`)).json().version as number;
      const recommended = await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: version, reason: 'Manager review (synthetic)', recommendation: 'CONFIRM', effectiveDate: '2026-06-01' });
      expect(recommended.statusCode, recommended.body).toBeLessThan(300);
      const task = ((await h.call(delegateHr, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((x) => x.ownerEmployeeId === e.id);
      expect(task, 'the task went to the delegate').toBeTruthy();
      const decided = await h.call(delegateHr, 'POST', `/v1/confirmations/tasks/${task!.taskId}/decision`, { decision: 'APPROVE', reason: 'Synthetic delegated decision', idempotencyKey: uniq('conf-key-') });
      expect(decided.statusCode, decided.body).toBe(200);

      const t = await timeline(hr, e.id);
      expect(eventsOf(t, 'CONFIRMED')).toMatchObject([{ actor: await accountKey(delegateHr), onBehalfOf: await accountKey(hr), source: { kind: 'CONFIRMATION_CASE', decisionId: expect.any(String) } }]);
      // Every other event names its actor alone.
      expect(t.events.filter((x) => x.type !== 'CONFIRMED').map((x) => x.onBehalfOf)).toEqual(t.events.filter((x) => x.type !== 'CONFIRMED').map(() => null));
    });
  });
});
