// Distinct history grants (C4 "Changed organisation or manager ... Historical financial views require an explicit history
// grant"; C6 increment_history_read, confirmation_history_read; section 11 "Salary history grant plus row scope; manager status
// alone insufficient"; 0126). A plain read grant answers for what is in force and later; each route, list, report and tab of the
// past needs its own grant, on top of row scope. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { BASELINE_ROLES, type PermissionKey } from '../access/baseline.js';
import { addDays, components, CONFIG, grants, head, SALARY as PAYROLL_SALARY } from '../payroll/payroll.fixtures.js';
import { processReportQueue } from '../report/service.js';

const FINANCE: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary', 'salary.history_read.salary', 'salary.export.salary', 'increment.read.salary', 'increment.history_read.salary', 'increment.propose.salary', 'increment.approve.salary', 'increment.export.salary'];
const JOINED = '2026-01-05';

describe('history grants (C4; C6; 0126)', () => {
  let h: Harness;
  let A: Company;
  let hr1: TestActor;
  let hr2: TestActor;
  let plain: TestActor;
  let today: string;
  let raised: string;
  let future: string;
  let future2: string;

  const person = async (overrides: Record<string, unknown> = {}) => {
    const e = (await h.call(plain, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: JOINED, ...overrides }))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    return { id: e.id as string, code: e.employeeCode as string };
  };
  const offCycle = async (employeeId: string, effectiveDate: string, amount: string) => {
    const res = await h.call(hr2, 'POST', '/v1/increment-cases/off-cycle', { employeeId, effectiveDate, proposedAmount: amount, proposedCounterpart: String(Number(amount) * 12), reason: 'Synthetic' });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().taskId as string;
  };
  const decide = (taskId: string, decision = 'APPROVE') => h.call(hr1, 'POST', `/v1/increment-cases/tasks/${taskId}/decision`, { decision, reason: 'Independent review (synthetic)', idempotencyKey: uniq('inc-key-') });
  const reader = (...extra: PermissionKey[]) => h.actor(A, 'HR_ADMINISTRATOR', { extra });
  const salaryList = async (a: TestActor, e: string) => (await h.call(a, 'GET', `/v1/employees/${e}/salary`)).json() as { historyIncluded: boolean; items: { id: string; monthlyGross: string; effectiveFrom: string; effectiveTo: string | null }[] };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    hr2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    plain = await h.actor(A, 'HR_ADMINISTRATOR');
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true), ($1, 'increment_case', $3, 2, true)`, [A.id, hr1.user, hr2.user]);
    today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
    // An arrangement that ended before today, the one in force and one still to come.
    raised = addDays(today, -30);
    future = addDays(today, 30);
    future2 = addDays(today, 60);
  });

  afterAll(async () => {
    await h?.stop();
  });

  /** 100000 until `raised`, 110000 until `future`, 120000 after: one ended, one in force, one to come. */
  const threeArrangements = async () => {
    const e = await person();
    expect((await h.call(hr1, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: JOINED, monthlyGross: '100000', annualCtc: '1200000', currency: 'INR' })).statusCode).toBe(201);
    expect((await decide(await offCycle(e.id, raised, '110000'))).statusCode).toBe(200);
    expect((await decide(await offCycle(e.id, future, '120000'))).statusCode).toBe(200);
    return e;
  };

  describe('salary (C4)', () => {
    it('a plain read shows what is in force and later; the history grant shows the rest; each says which', async () => {
      const e = await threeArrangements();
      const current = await salaryList(await reader('salary.read.salary'), e.id);
      expect(current.historyIncluded).toBe(false);
      expect(current.items.map((s) => s.monthlyGross)).toEqual(['110000.0000', '120000.0000']);
      const all = await salaryList(await reader('salary.read.salary', 'salary.history_read.salary'), e.id);
      expect(all.historyIncluded).toBe(true);
      expect(all.items.map((s) => s.monthlyGross)).toEqual(['100000.0000', '110000.0000', '120000.0000']);
    });

    it('the history grant alone does not open the current route: it adds to read, it does not replace it', async () => {
      const e = await threeArrangements();
      expect((await h.call(await reader('salary.history_read.salary'), 'GET', `/v1/employees/${e.id}/salary`)).statusCode).toBe(403);
    });

    it('the salary master answers a past day or month only with the grant', async () => {
      const e = await threeArrangements();
      const q = (when: string) => `/v1/salary-master?search=${encodeURIComponent(e.code)}&${when}`;
      const current = await reader('salary.read.salary');
      const answered = await h.call(current, 'GET', q(`date=${today}`));
      expect((answered.json().items as { monthlyGross: string }[]).map((r) => r.monthlyGross)).toEqual(['110000.0000']);
      expect((await h.call(current, 'GET', q(`date=${future}`))).statusCode).toBe(200);
      for (const when of [`date=${addDays(today, -1)}`, `date=${JOINED}`, `month=${raised.slice(0, 7)}`]) {
        const refused = await h.call(current, 'GET', q(when));
        expect([refused.statusCode, refused.json().error], when).toEqual([403, 'HISTORY_GRANT_REQUIRED']);
      }
      const granted = await reader('salary.read.salary', 'salary.history_read.salary');
      expect(((await h.call(granted, 'GET', q(`date=${JOINED}`))).json().items as { monthlyGross: string }[]).map((r) => r.monthlyGross)).toEqual(['100000.0000']);
    });

    it('an ended arrangement’s components cannot be opened by its id without the grant', async () => {
      const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
      const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
      await head(h, configA, configB, { code: 'HG_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
      const e = await person();
      const manager = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PAYROLL_SALARY) });
      const created = await h.call(manager, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: JOINED, monthlyGross: '100000', annualCtc: '1200000', currency: 'INR' });
      const ended = created.json().id as string;
      await components(h, manager, ended, [{ code: 'HG_BASIC', amount: '100000' }]);
      expect((await h.call(await reader('salary.read.salary'), 'GET', `/v1/payroll/salary-arrangements/${ended}/components`)).statusCode).toBe(200);
      expect((await decide(await offCycle(e.id, raised, '110000'))).statusCode).toBe(200);

      const refused = await h.call(await reader('salary.read.salary'), 'GET', `/v1/payroll/salary-arrangements/${ended}/components`);
      expect([refused.statusCode, refused.json().error]).toEqual([403, 'HISTORY_GRANT_REQUIRED']);
      expect((await h.call(await reader('salary.read.salary', 'salary.history_read.salary'), 'GET', `/v1/payroll/salary-arrangements/${ended}/components`)).statusCode).toBe(200);
    });
  });

  describe('increments (C6 increment_history_read)', () => {
    it('applied changes and annual growth need the grant; the plain read grant is refused', async () => {
      const e = await threeArrangements();
      const year = Number(today.slice(0, 4));
      const read = await reader('increment.read.salary');
      for (const path of [`/v1/employees/${e.id}/increment-history`, `/v1/employees/${e.id}/annual-increment?financialYear=${year}`]) {
        expect((await h.call(read, 'GET', path)).statusCode, path).toBe(403);
        expect((await h.call(await reader('increment.history_read.salary'), 'GET', path)).statusCode, path).toBe(200);
      }
    });

    it('a refusal is audited like any other', async () => {
      const e = await threeArrangements();
      const read = await reader('increment.read.salary');
      await h.call(read, 'GET', `/v1/employees/${e.id}/increment-history`);
      const denied = await h.one<{ n: number }>(`select count(*)::int as n from audit_event where company_id = $1 and actor_user_id = $2 and action = 'ACCESS_DENIED' and record_key = $3`, [A.id, read.user, e.id]);
      expect(denied.n).toBe(1);
    });

    it('the decision reason still needs its own grant beside the history grant (DF02)', async () => {
      const e = await threeArrangements();
      const items = async (a: TestActor) => (await h.call(a, 'GET', `/v1/employees/${e.id}/increment-history`)).json().items as object[];
      expect((await items(await reader('increment.history_read.salary'))).every((x) => !('reason' in x))).toBe(true);
      expect((await items(await reader('increment.history_read.salary', 'increment.read.reason'))).every((x) => 'reason' in x)).toBe(true);
    });

    it('open cases show their amounts to a plain read; decided ones only with the grant', async () => {
      const e = await threeArrangements();
      const open = await offCycle(e.id, future2, '130000');
      const rows = async (a: TestActor) => ((await h.call(a, 'GET', '/v1/increment-cases')).json().items as { employeeId: string; state: string; proposedAmount?: string; baselineAmount?: string; currency?: string; components?: unknown }[]).filter((c) => c.employeeId === e.id);
      const read = await rows(await reader('increment.read.salary'));
      expect(read.map((c) => c.state).sort()).toEqual(['APPLIED', 'APPLIED', 'SUBMITTED']);
      expect(read.find((c) => c.state === 'SUBMITTED')).toMatchObject({ proposedAmount: '130000.0000', currency: 'INR' });
      for (const c of read.filter((x) => x.state === 'APPLIED')) {
        expect(c).not.toHaveProperty('proposedAmount');
        expect(c).not.toHaveProperty('baselineAmount');
        expect(c).not.toHaveProperty('components');
      }
      const granted = await rows(await reader('increment.read.salary', 'increment.history_read.salary'));
      expect(granted.filter((c) => c.state === 'APPLIED').every((c) => typeof c.proposedAmount === 'string')).toBe(true);
      expect((await decide(open, 'REJECT')).statusCode).toBe(200);
    });
  });

  describe('reports (section 11 "Salary history grant plus row scope")', () => {
    const requestAs = (a: TestActor, reportCode: string, filters: object) => h.call(a, 'POST', '/v1/reports', { reportCode, filters });
    const year = () => Number(today.slice(0, 4));
    const fy = () => ({ from: `${year()}-04-01`, to: `${year() + 1}-03-31` });

    it('INCREMENT_HISTORY and ANNUAL_INCREMENT need the increment grant, ANNUAL_SALARY the salary grant', async () => {
      const incrementOnly = await reader('increment.export.salary');
      const salaryOnly = await reader('salary.export.salary');
      for (const [a, code] of [[incrementOnly, 'INCREMENT_HISTORY'], [incrementOnly, 'ANNUAL_INCREMENT'], [salaryOnly, 'ANNUAL_SALARY']] as const) {
        const refused = await requestAs(a, code, fy());
        expect([refused.statusCode, refused.json().error], code).toEqual([403, 'HISTORY_GRANT_REQUIRED']);
      }
      const incrementFull = await reader('increment.export.salary', 'increment.history_read.salary');
      const salaryFull = await reader('salary.export.salary', 'salary.history_read.salary');
      for (const [a, code] of [[incrementFull, 'INCREMENT_HISTORY'], [incrementFull, 'ANNUAL_INCREMENT'], [salaryFull, 'ANNUAL_SALARY']] as const) {
        expect((await requestAs(a, code, fy())).statusCode, code).toBe(202);
      }
    });

    it('the salary master export needs it only for a past day or month', async () => {
      const exporter = await reader('salary.export.salary');
      expect((await requestAs(exporter, 'SALARY_MASTER', { from: today, to: today })).statusCode).toBe(202);
      const past = addDays(today, -1);
      expect((await requestAs(exporter, 'SALARY_MASTER', { from: past, to: past })).json().error).toBe('HISTORY_GRANT_REQUIRED');
    });

    it('a grant withdrawn after the request stops generation, and after generation stops the download (ZT05)', async () => {
      const queued = await reader('increment.export.salary', 'increment.history_read.salary');
      const revoke = (a: TestActor) =>
        h.db.query(`update role_assignment_permission set active = false where role_assignment_id = $1 and permission_id = (select id from permission where resource = 'increment' and action = 'history_read' and field_group = 'salary')`, [a.assignment]);
      const first = (await requestAs(queued, 'INCREMENT_HISTORY', fy())).json().id as string;
      await revoke(queued);
      await processReportQueue(h.pool);
      expect((await h.call(queued, 'GET', `/v1/reports/${first}`)).statusCode).toBe(403);
      expect(await h.one(`select state, failure_code from report_execution where id = $1`, [first])).toEqual({ state: 'FAILED', failure_code: 'ACCESS_REVOKED' });

      const finished = await reader('increment.export.salary', 'increment.history_read.salary');
      const second = (await requestAs(finished, 'INCREMENT_HISTORY', fy())).json().id as string;
      await processReportQueue(h.pool);
      expect((await h.call(finished, 'GET', `/v1/reports/${second}/download`)).statusCode).toBe(200);
      await revoke(finished);
      expect((await h.call(finished, 'GET', `/v1/reports/${second}/download`)).statusCode).toBe(403);
    });
  });

  describe('my team (C4 "manager status alone insufficient")', () => {
    it('a manager with salary read sees the current salary, never the past, until granted it', async () => {
      const e = await threeArrangements();
      const managerEmp = await person();
      expect((await h.call(plain, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: managerEmp.id, effectiveFrom: JOINED })).statusCode).toBe(200);
      const linked = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp.id });
      const detail = async (extra: PermissionKey[]) => {
        const manager = await h.actor(A, 'REPORTING_MANAGER', { user: linked.user, extra });
        const res = await h.call(manager, 'GET', `/v1/my-team/${e.id}`);
        expect(res.statusCode, res.body).toBe(200);
        return res.json().tabs.compensation?.sections as { salaryArrangements?: { items: { monthlyGross: string }[] }; incrementHistory?: { items: object[] } } | undefined;
      };
      expect(await detail([])).toBeUndefined();
      const current = await detail(['salary.read.salary', 'increment.read.salary']);
      expect(current!.salaryArrangements!.items.map((s) => s.monthlyGross)).toEqual(['110000.0000', '120000.0000']);
      expect(current).not.toHaveProperty('incrementHistory');
      const past = await detail(['salary.read.salary', 'salary.history_read.salary', 'increment.history_read.salary']);
      expect(past!.salaryArrangements!.items.map((s) => s.monthlyGross)).toEqual(['100000.0000', '110000.0000', '120000.0000']);
      expect(past!.incrementHistory!.items).toHaveLength(2);
    });

    it('the grants are ceilings only, for the eligible roles: nobody holds the financial past by default', () => {
      const role = (code: string) => BASELINE_ROLES.find((r) => r.code === code)!;
      for (const key of ['salary.history_read.salary', 'increment.history_read.salary'] as PermissionKey[]) {
        for (const r of BASELINE_ROLES) expect(r.defaultDuties, `${r.code} ${key}`).not.toContain(key);
        expect(role('HR_ADMINISTRATOR').ceiling, key).toContain(key);
        expect(role('REPORTING_MANAGER').ceiling, key).toContain(key);
        expect(role('SYSTEM_ADMINISTRATOR').ceiling, key).not.toContain(key);
      }
    });
  });

  describe('confirmation (C6 confirmation_history_read)', () => {
    const confirmationWorld = async () => {
      const m = await person();
      const manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: m.id });
      const e = await person({ joiningDate: '2026-01-31' });
      await h.setStatus(A, e.id, 'ACTIVE_PROBATION');
      expect((await h.call(plain, 'POST', `/v1/employees/${e.id}/manager`, { managerEmployeeId: m.id, effectiveFrom: '2026-01-31' })).statusCode).toBe(200);
      const caseId = (await h.call(plain, 'POST', '/v1/confirmations', { employeeId: e.id })).json().caseId as string;
      const self = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
      await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'employee_confirmation', $2, 1, true) on conflict do nothing`, [A.id, plain.user]);
      const version = (await h.call(plain, 'GET', `/v1/confirmations/${caseId}`)).json().version as number;
      expect((await h.call(manager, 'POST', `/v1/confirmations/${caseId}/recommendation`, { expectedVersion: version, reason: 'Manager review (synthetic)', recommendation: 'EXTEND', extensionMonths: 1 })).statusCode).toBeLessThan(300);
      const tasks = (await h.call(plain, 'GET', '/v1/confirmations/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[];
      const decided = await h.call(plain, 'POST', `/v1/confirmations/tasks/${tasks.find((t) => t.ownerEmployeeId === e.id)!.taskId}/decision`, { decision: 'APPROVE', reason: 'HR decision (synthetic)', idempotencyKey: uniq('conf-key-') });
      expect(decided.statusCode, decided.body).toBe(200);
      return { caseId, manager, self };
    };

    it('the case stays readable without it, without its earlier decisions, and says so', async () => {
      const { caseId } = await confirmationWorld();
      const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['confirmation.read.operational'] });
      const answer = (await h.call(narrow, 'GET', `/v1/confirmations/${caseId}`)).json();
      expect(answer).toMatchObject({ id: caseId, historyIncluded: false, actions: [] });
      const full = (await h.call(await h.actor(A, 'HR_ADMINISTRATOR', { duties: ['confirmation.read.operational', 'confirmation.history_read.operational'] }), 'GET', `/v1/confirmations/${caseId}`)).json();
      expect(full.historyIncluded).toBe(true);
      expect(full.actions.map((a: { action: string }) => a.action)).toEqual(['EXTENDED']);
    });

    it('HR and the reporting manager keep it by default, and an employee always sees their own', async () => {
      const { caseId, manager, self } = await confirmationWorld();
      for (const a of [plain, manager, self]) {
        const answer = (await h.call(a, 'GET', `/v1/confirmations/${caseId}`)).json();
        expect(answer.actions.map((x: { action: string }) => x.action)).toEqual(['EXTENDED']);
      }
    });
  });
});
