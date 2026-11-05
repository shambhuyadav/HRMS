// Correcting an applied increment (BR-038 "later corrections use controlled attributable superseding events"; DF14; DF15;
// FR-089; FR-090; 0095), through the real routes, with payroll calculated and processed through the API. The original record
// stays, the approved chain moves to the correction, and nothing processed changes. Synthetic INR amounts only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import type { PermissionKey } from '../access/baseline.js';
import { addDays, APPROVE, calculate, calendar, components, CONFIG, createRun, grants, head, months, ok, PREPARE, PROCESS, processRun, record, REVIEW, reviewers, SALARY, submitAndApprove } from '../payroll/payroll.fixtures.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';

const FINANCE: PermissionKey[] = ['salary.manage.salary', 'salary.read.salary', 'salary.history_read.salary', 'increment.read.salary', 'increment.history_read.salary', 'increment.propose.salary', 'increment.approve.salary', 'increment.read.reason', 'increment.export.salary'];

interface HistoryRow {
  id: string;
  effectiveDate: string;
  beforeAmount: string;
  afterAmount: string;
  changeAmount: string;
  changePercent: string | null;
  correctsHistoryId: string | null;
  supersededByHistoryId: string | null;
  correctable: boolean;
  reason?: string;
}

describe('correcting an applied increment', () => {
  let h: Harness;
  let A: Company;
  let B: Company;
  let hr1: TestActor;
  let hr2: TestActor;
  let plain: TestActor;
  let today: string;

  const JOINED = '2026-01-05';

  const person = async (salary = true) => {
    const e = (await h.call(plain, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: JOINED }))).json();
    await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
    if (salary) expect((await h.call(hr1, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: JOINED, monthlyGross: '100000', annualCtc: '1200000', currency: 'INR' })).statusCode).toBe(201);
    return e.id as string;
  };
  const taskFor = async (a: TestActor, employeeId: string) => ((await h.call(a, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string; ownerEmployeeId: string }[]).find((t) => t.ownerEmployeeId === employeeId);
  const decide = (a: TestActor, taskId: string, decision: 'APPROVE' | 'REJECT' | 'RETURN', key = uniq('inc-key-')) => h.call(a, 'POST', `/v1/increment-cases/tasks/${taskId}/decision`, { decision, reason: 'Independent review (synthetic)', idempotencyKey: key });
  /** An off-cycle change proposed by hr2 and approved by hr1 (DF15). */
  const applied = async (employeeId: string, effectiveDate: string, amount = '110000', counterpart = '1320000') => {
    const res = await h.call(hr2, 'POST', '/v1/increment-cases/off-cycle', { employeeId, effectiveDate, proposedAmount: amount, proposedCounterpart: counterpart, reason: 'Off-cycle adjustment (synthetic)' });
    expect(res.statusCode, res.body).toBe(201);
    const decided = await decide(hr1, (await taskFor(hr1, employeeId))!.taskId, 'APPROVE');
    expect(decided.json().state, decided.body).toBe('APPLIED');
    return latest(employeeId);
  };
  const historyOf = async (employeeId: string, a = hr1) => (await h.call(a, 'GET', `/v1/employees/${employeeId}/increment-history`)).json().items as HistoryRow[];
  const latest = async (employeeId: string) => (await historyOf(employeeId)).at(-1)!;
  const salaryOf = async (employeeId: string) =>
    ((await h.call(hr1, 'GET', `/v1/employees/${employeeId}/salary`)).json().items as { monthlyGross: string; effectiveFrom: string; effectiveTo: string | null }[]).map((s) => [s.monthlyGross, s.effectiveFrom, s.effectiveTo]);
  const correct = (a: TestActor, historyId: string, body: Record<string, unknown>) =>
    h.call(a, 'POST', `/v1/increment-history/${historyId}/corrections`, { proposedAmount: '105000', proposedCounterpart: '1260000', reason: 'Amount entered wrongly (synthetic)', ...body });
  /** Proposed by hr2, approved by hr1. */
  const corrected = async (employeeId: string, historyId: string, body: Record<string, unknown>) => {
    const res = await correct(hr2, historyId, body);
    expect(res.statusCode, res.body).toBe(201);
    const decided = await decide(hr1, (await taskFor(hr1, employeeId))!.taskId, 'APPROVE');
    expect(decided.json().state, decided.body).toBe('APPLIED');
    return decided.json() as { changePercent: string };
  };

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    B = await h.makeCompany();
    hr1 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    hr2 = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE });
    plain = await h.actor(A, 'HR_ADMINISTRATOR');
    await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true), ($1, 'increment_case', $3, 2, true)`, [A.id, hr1.user, hr2.user]);
    today = (await h.one<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [A.id])).d;
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('the chain moves and the original stays (BR-038; DF14)', () => {
    it('a wrong amount: the record stays, the correction supersedes it, and the salary in force follows', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      expect(first).toMatchObject({ afterAmount: '110000.0000', changePercent: '10.00', correctable: true, supersededByHistoryId: null, correctsHistoryId: null });
      expect((await corrected(e, first.id, { effectiveDate: on })).changePercent).toBe('5.00');

      const rows = await historyOf(e);
      expect(rows.map((r) => [r.afterAmount, r.changePercent, r.correctable])).toEqual([
        ['110000.0000', '10.00', false],
        ['105000.0000', '5.00', true],
      ]);
      expect(rows[0]!.supersededByHistoryId).toBe(rows[1]!.id);
      expect(rows[1]).toMatchObject({ correctsHistoryId: first.id, beforeAmount: '100000.0000', changeAmount: '5000.0000', reason: 'Independent review (synthetic)' });
      // Only the approved chain is in force; the corrected arrangement is on record but leaves it.
      expect(await salaryOf(e)).toEqual([
        ['100000.0000', JOINED, on],
        ['105000.0000', on, null],
      ]);
      const retired = await h.one<{ gross: string; from: string; to: string; superseded: boolean }>(
        `select monthly_gross::text as gross, effective_from as from, effective_to as to, superseded_at is not null as superseded from salary_arrangement where employee_id = $1 and monthly_gross = 110000`,
        [e],
      );
      expect(retired).toEqual({ gross: '110000.0000', from: on, to: on, superseded: true });
      const audits = await h.db.query<{ action: string }>(`select a.action from audit_event a join salary_arrangement s on s.id = a.record_key where s.employee_id = $1 and a.resource_code = 'salary_arrangement' and a.action = 'SUPERSEDE'`, [e]);
      expect(audits.rowCount).toBe(1);
    });

    it('a wrong date, later and earlier: the salary before it ends on the corrected date, leaving no gap or overlap', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const later = addDays(on, 10);
      const first = await applied(e, on);
      await corrected(e, first.id, { effectiveDate: later, proposedAmount: '110000', proposedCounterpart: '1320000' });
      expect(await salaryOf(e)).toEqual([
        ['100000.0000', JOINED, later],
        ['110000.0000', later, null],
      ]);
      const earlier = addDays(on, -5);
      await corrected(e, (await latest(e)).id, { effectiveDate: earlier, proposedAmount: '110000', proposedCounterpart: '1320000' });
      expect(await salaryOf(e)).toEqual([
        ['100000.0000', JOINED, earlier],
        ['110000.0000', earlier, null],
      ]);
      // Every record stays, whatever date each one named.
      expect((await historyOf(e)).map((r) => r.effectiveDate).sort()).toEqual([earlier, on, later]);
    });

    it('a reversal is a correction back to the earlier amount: a new linked record, 0%, nothing deleted', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      expect((await corrected(e, first.id, { effectiveDate: on, proposedAmount: '100000', proposedCounterpart: '1200000' })).changePercent).toBe('0.00');
      expect((await historyOf(e)).map((r) => r.afterAmount)).toEqual(['110000.0000', '100000.0000']);
      expect(await salaryOf(e)).toEqual([
        ['100000.0000', JOINED, on],
        ['100000.0000', on, null],
      ]);
    });

    it('a correction can itself be corrected; annual growth and its change list follow the chain', async () => {
      const e = await person();
      const year = Number(today.slice(0, 4)) + 1;
      const on = `${year}-06-01`;
      const first = await applied(e, on);
      await corrected(e, first.id, { effectiveDate: on });
      await corrected(e, (await latest(e)).id, { effectiveDate: on, proposedAmount: '121000', proposedCounterpart: '1452000' });
      const annual = (await h.call(hr1, 'GET', `/v1/employees/${e}/annual-increment?financialYear=${year}`)).json();
      expect(annual).toMatchObject({ opening: '100000.0000', closing: '121000.0000', annualGrowthPercent: '21.00' });
      expect(annual.changes.map((c: { afterAmount: string }) => c.afterAmount)).toEqual(['121000.0000']);
      expect((await historyOf(e)).filter((r) => r.correctable).map((r) => r.afterAmount)).toEqual(['121000.0000']);
    });

    it('a later ordinary change works from the corrected chain, unhindered by the retired row', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      await corrected(e, first.id, { effectiveDate: addDays(on, -5), proposedAmount: '110000', proposedCounterpart: '1320000' });
      await applied(e, addDays(on, -1), '115000', '1380000');
      // History reads by effective date, and the superseded record keeps its later one.
      expect((await historyOf(e)).find((r) => r.afterAmount === '115000.0000')).toMatchObject({ beforeAmount: '110000.0000', correctable: true });
      expect((await salaryOf(e)).at(-1)).toEqual(['115000.0000', addDays(on, -1), null]);
    });
  });

  describe('control (DF15; C4)', () => {
    it('the proposer never decides their own correction', async () => {
      const e = await person();
      const first = await applied(e, addDays(today, 30));
      expect((await correct(hr1, first.id, { effectiveDate: addDays(today, 30) })).statusCode).toBe(201);
      expect(await taskFor(hr1, e)).toBeUndefined();
      const task = (await taskFor(hr2, e))!;
      expect((await decide(hr1, task.taskId, 'APPROVE')).statusCode).toBe(404);
      expect((await historyOf(e)).length).toBe(1);
      // The database refuses it however it is reached (CI20).
      const caseRow = await h.one<{ id: string; old: string; neu: string; decision: string }>(
        `select c.id, h.old_salary_id as old, h.new_salary_id as neu, h.approval_decision_id as decision from increment_case c join increment_history h on h.id = c.corrects_history_id where c.employee_id = $1 and c.state = 'SUBMITTED'`,
        [e],
      );
      await expect(
        h.db.query(
          `insert into increment_history (company_id, employee_id, case_id, approval_decision_id, old_salary_id, new_salary_id, effective_date, compensation_basis, currency_code, before_amount, after_amount, change_amount, change_percent, reason, applied_by)
           values ($1, $2, $3, $4, $5, $6, $7, 'MONTHLY_GROSS', 'INR', 1, 1, 0, 0, 'x', $8)`,
          [A.id, e, caseRow.id, caseRow.decision, caseRow.old, caseRow.neu, today, hr1.user],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });

    it('with no independent reviewer it is refused, not self-approved', async () => {
      const C = await h.makeCompany();
      const only = await h.actor(C, 'HR_ADMINISTRATOR', { extra: FINANCE });
      const other = await h.actor(C, 'HR_ADMINISTRATOR', { extra: FINANCE });
      await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'increment_case', $2, 1, true)`, [C.id, only.user]);
      const e = (await h.call(only, 'POST', '/v1/employees', h.newEmployeeBody(C, { joiningDate: JOINED }))).json().id as string;
      await h.setStatus(C, e, 'ACTIVE_CONFIRMED');
      expect((await h.call(only, 'POST', `/v1/employees/${e}/salary`, { effectiveFrom: JOINED, monthlyGross: '100000', annualCtc: '1200000', currency: 'INR' })).statusCode).toBe(201);
      const on = addDays(today, 30);
      const proposed = await h.call(other, 'POST', '/v1/increment-cases/off-cycle', { employeeId: e, effectiveDate: on, proposedAmount: '110000', proposedCounterpart: '1320000', reason: 'Synthetic' });
      expect(proposed.statusCode, proposed.body).toBe(201);
      const task = ((await h.call(only, 'GET', '/v1/increment-cases/tasks/mine')).json().items as { taskId: string }[])[0]!;
      expect((await decide(only, task.taskId, 'APPROVE')).json().state).toBe('APPLIED');
      const row = ((await h.call(only, 'GET', `/v1/employees/${e}/increment-history`)).json().items as HistoryRow[])[0]!;
      const refused = await h.call(only, 'POST', `/v1/increment-history/${row.id}/corrections`, { effectiveDate: on, proposedAmount: '105000', proposedCounterpart: '1260000', reason: 'Synthetic' });
      expect([refused.statusCode, refused.json().error]).toEqual([422, 'NO_ELIGIBLE_REVIEWER']);
      expect(((await h.call(only, 'GET', `/v1/employees/${e}/increment-history`)).json().items as HistoryRow[]).length).toBe(1);
    });

    it('needs the proposal grant, a whole-company assignment and row scope, and names no record across companies', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      expect((await correct(plain, first.id, { effectiveDate: on })).statusCode).toBe(403);
      const filtered = await h.actor(A, 'HR_ADMINISTRATOR', { extra: FINANCE, departmentFilter: A.dept });
      expect((await correct(filtered, first.id, { effectiveDate: on })).statusCode).toBe(403);
      expect((await correct(await h.actor(B, 'HR_ADMINISTRATOR', { extra: FINANCE }), first.id, { effectiveDate: on })).statusCode).toBe(404);
      expect((await correct(hr2, first.id, { effectiveDate: on, reason: ' ' })).statusCode).toBe(400);
    });

    it('is decided once: a replay applies nothing more, and a rejected or returned one leaves everything as it was', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      expect((await correct(hr2, first.id, { effectiveDate: on })).statusCode).toBe(201);
      expect((await correct(hr2, first.id, { effectiveDate: on, proposedAmount: '106000' })).json().error).toBe('CORRECTION_PENDING');
      expect((await decide(hr1, (await taskFor(hr1, e))!.taskId, 'REJECT')).json().state).toBe('REJECTED');
      expect((await historyOf(e)).length).toBe(1);
      expect(await salaryOf(e)).toEqual([
        ['100000.0000', JOINED, on],
        ['110000.0000', on, null],
      ]);

      expect((await correct(hr2, first.id, { effectiveDate: on })).statusCode).toBe(201);
      const taskId = (await taskFor(hr1, e))!.taskId;
      const key = uniq('inc-key-');
      expect((await decide(hr1, taskId, 'APPROVE', key)).json().state).toBe('APPLIED');
      expect((await decide(hr1, taskId, 'APPROVE', key)).json()).toMatchObject({ replayed: true });
      expect((await historyOf(e)).length).toBe(2);
    });
  });

  describe('what it refuses', () => {
    it('anything but the latest in-force change, and a correction changing nothing', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      expect((await correct(hr2, first.id, { effectiveDate: on, proposedAmount: '110000', proposedCounterpart: '1320000' })).json().error).toBe('NO_CHANGE');
      expect((await correct(hr2, first.id, { effectiveDate: JOINED })).json().error).toBe('INVALID_EFFECTIVE_DATE');
      const second = await applied(e, addDays(on, 30), '120000', '1440000');
      expect((await correct(hr2, first.id, { effectiveDate: on })).json().error).toBe('NOT_LATEST_CHANGE');
      await corrected(e, second.id, { effectiveDate: addDays(on, 30), proposedAmount: '118000', proposedCounterpart: '1416000' });
      expect((await correct(hr2, second.id, { effectiveDate: addDays(on, 30) })).json().error).toBe('ALREADY_CORRECTED');
    });

    it('a change that arrived while it waited stops it at approval; the task stays open and nothing moves', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      expect((await correct(hr2, first.id, { effectiveDate: on })).statusCode).toBe(201);
      const correctionTask = (await taskFor(hr1, e))!.taskId;
      // The later change goes in beside the waiting correction, whose task the same approver also holds.
      const later = await h.call(hr2, 'POST', '/v1/increment-cases/off-cycle', { employeeId: e, effectiveDate: addDays(on, 30), proposedAmount: '120000', proposedCounterpart: '1440000', reason: 'Synthetic' });
      expect(later.statusCode, later.body).toBe(201);
      expect((await decide(hr1, later.json().taskId, 'APPROVE')).json().state).toBe('APPLIED');
      const refused = await decide(hr1, correctionTask, 'APPROVE');
      expect([refused.statusCode, refused.json().error]).toEqual([409, 'NOT_LATEST_CHANGE']);
      expect(await salaryOf(e)).toEqual([
        ['100000.0000', JOINED, on],
        ['110000.0000', on, addDays(on, 30)],
        ['120000.0000', addDays(on, 30), null],
      ]);
    });

    it('an approved last working date before the corrected date', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      await h.db.query('begin');
      try {
        const bt = await h.one<{ id: string }>(`insert into business_transaction (company_id, kind, owner_employee_id, state) values ($1, 'exit_case', $2, 'SUBMITTED') returning id`, [A.id, e]);
        const x = await h.one<{ id: string }>(
          `insert into exit_case (company_id, employee_id, transaction_id, separation_type, request_date, proposed_leaving_date, leaving_date, state) values ($1, $2, $3, 'RESIGNATION', $4, $5, $5, 'SUBMITTED') returning id`,
          [A.id, e, bt.id, today, addDays(on, 5)],
        );
        await h.db.query(`update business_transaction set state = 'RECOMMENDED' where id = $1`, [bt.id]);
        await h.db.query(`update exit_case set state = 'RECOMMENDED', recommended_leaving_date = $2, recommended_at = now() where id = $1`, [x.id, addDays(on, 5)]);
        await h.db.query(`update business_transaction set state = 'APPROVED' where id = $1`, [bt.id]);
        await h.db.query(`update exit_case set state = 'APPROVED', approved_leaving_date = $2, approved_at = now(), prior_status_code = 'ACTIVE_CONFIRMED' where id = $1`, [x.id, addDays(on, 5)]);
        await h.db.query('commit');
      } catch (err) {
        await h.db.query('rollback');
        throw err;
      }
      expect((await correct(hr2, first.id, { effectiveDate: addDays(on, 10) })).statusCode).toBe(201);
      const refused = await decide(hr1, (await taskFor(hr1, e))!.taskId, 'APPROVE');
      expect([refused.statusCode, refused.json().error]).toEqual([422, 'SEPARATION_BEFORE_EFFECTIVE_DATE']);
    });
  });

  describe('the database holds the chain (0095)', () => {
    it('only a superseded row may be empty, a superseded row never changes again, and a record has one successor', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      const open = await h.one<{ id: string }>(`select id from salary_arrangement where employee_id = $1 and effective_to is null`, [e]);
      // An ordinary arrangement still needs an end after its start.
      await expect(h.db.query(`update salary_arrangement set effective_to = effective_from where id = $1`, [open.id])).rejects.toMatchObject({ code: '23514' });
      await expect(h.db.query(`update salary_arrangement set effective_to = effective_from - 1 where id = $1`, [open.id])).rejects.toMatchObject({ code: '23514' });
      await expect(h.db.query(`update salary_arrangement set superseded_at = now() where id = $1`, [open.id])).rejects.toMatchObject({ code: '23514' });
      await corrected(e, first.id, { effectiveDate: on });
      const retired = await h.one<{ id: string }>(`select id from salary_arrangement where employee_id = $1 and superseded_at is not null`, [e]);
      await expect(h.db.query(`update salary_arrangement set effective_to = effective_from + 30 where id = $1`, [retired.id])).rejects.toMatchObject({ code: '23514' });
      await expect(h.db.query(`update salary_arrangement set superseded_at = null where id = $1`, [retired.id])).rejects.toMatchObject({ code: '23514' });
      await expect(h.db.query(`update salary_arrangement set monthly_gross = 1 where id = $1`, [retired.id])).rejects.toMatchObject({ code: '23514' });
      // History stays append-only.
      await expect(h.db.query(`update increment_history set corrects_history_id = null where employee_id = $1`, [e])).rejects.toMatchObject({ code: '23514' });
      const view = await h.db.query<{ after_amount: string }>(`select after_amount::text from increment_history_in_force where employee_id = $1`, [e]);
      expect(view.rows).toEqual([{ after_amount: '105000.0000' }]);
    });
  });

  describe('reports, salary master, team and timeline read the chain', () => {
    it('INCREMENT_HISTORY and ANNUAL_INCREMENT count only what is in force', async () => {
      const e = await person();
      const code = (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [e])).c;
      const year = Number(today.slice(0, 4)) + 1;
      const on = `${year}-06-01`;
      const first = await applied(e, on);
      await corrected(e, first.id, { effectiveDate: on });
      const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));
      const exported = async (reportCode: string, filters: object) => {
        const res = await h.call(hr1, 'POST', '/v1/reports', { reportCode, filters });
        expect(res.statusCode, res.body).toBe(202);
        await processReportQueue(h.pool);
        const file = await h.call(hr1, 'GET', `/v1/reports/${res.json().id}/download`);
        expect(file.statusCode, file.body).toBe(200);
        const [header, ...lines] = csvTable(file.body).trimEnd().split('\r\n').map(cells);
        return lines.map((l) => Object.fromEntries(header!.map((k, i) => [k, l[i]!])));
      };
      const period = { from: `${year}-04-01`, to: `${year + 1}-03-31` };
      const history = (await exported('INCREMENT_HISTORY', period)).filter((r) => Object.values(r).includes(code));
      expect(history).toHaveLength(1);
      expect(Object.values(history[0]!)).toContain('105000.00');
      const annual = (await exported('ANNUAL_INCREMENT', period)).filter((r) => Object.values(r).includes(code));
      expect(annual).toHaveLength(1);
      expect(Object.values(annual[0]!)).toEqual(expect.arrayContaining(['100000.00', '105000.00', '5.00']));
    });

    it('the salary master lists no retired row, even for a period containing its date', async () => {
      const e = await person();
      // Mid-month, so the month overlaps the retired row's date as well as both salaries in force.
      const on = `${addDays(today, 40).slice(0, 7)}-15`;
      const first = await applied(e, on);
      await corrected(e, first.id, { effectiveDate: on });
      const code = (await h.one<{ c: string }>(`select employee_code as c from employee where id = $1`, [e])).c;
      const res = await h.call(hr1, 'GET', `/v1/salary-master?search=${encodeURIComponent(code)}&month=${on.slice(0, 7)}`);
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json().items as { monthlyGross: string }[]).map((r) => Number(r.monthlyGross)).sort()).toEqual([100000, 105000]);
    });

    it('the employee timeline shows the correction as a further event, keeping the original', async () => {
      const e = await person();
      const on = addDays(today, 30);
      const first = await applied(e, on);
      await corrected(e, first.id, { effectiveDate: on });
      const t = (await h.call(hr1, 'GET', `/v1/employees/${e}/timeline?asOf=${on}`)).json() as { events: { type: string; details: Record<string, unknown>; source: { id: string } }[]; asOf: { salary: { monthlyGross: string } } };
      const original = t.events.find((x) => x.type === 'INCREMENT_APPLIED')!;
      const correction = t.events.find((x) => x.type === 'INCREMENT_CORRECTED')!;
      expect(original.details).toMatchObject({ afterAmount: '110000.0000', supersededByCaseId: correction.source.id, correctsCaseId: null });
      expect(correction.details).toMatchObject({ afterAmount: '105000.0000', correctsCaseId: original.source.id, supersededByCaseId: null });
      expect(t.asOf.salary).toMatchObject({ monthlyGross: '105000.0000' });
      // A reader of salary alone sees the retired arrangement marked, not as an arrangement in force.
      const salaryOnly = await h.actor(A, 'HR_ADMINISTRATOR', { extra: ['salary.history_read.salary'] });
      const seen = (await h.call(salaryOnly, 'GET', `/v1/employees/${e}/timeline`)).json() as { events: { type: string; details: { monthlyGross?: string; superseded?: boolean } }[] };
      expect(seen.events.filter((x) => x.type === 'SALARY_SET').map((x) => [x.details.monthlyGross, x.details.superseded]).sort()).toEqual([
        ['100000.0000', false],
        ['105000.0000', false],
        ['110000.0000', true],
      ]);
    });
  });

  describe('payroll (DF15 "Existing locked payroll is preserved"; Appendix H)', () => {
    let preparer: TestActor;
    let reviewer: TestActor;
    let approver: TestActor;
    let processor: TestActor;
    let periods: Record<string, string>;

    const department = async () => (await h.one<{ id: string }>(`insert into department (company_id, code, name, active) values ($1, $2, $2, true) returning id`, [A.id, uniq('CR').toUpperCase()])).id;
    /** A confirmed employee alone in a new department, with a salary whose components payroll can read. */
    const payee = async () => {
      const departmentId = await department();
      const e = (await h.call(plain, 'POST', '/v1/employees', h.newEmployeeBody(A, { joiningDate: '2024-01-01', departmentId }))).json();
      await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
      const res = await h.call(preparer, 'POST', `/v1/employees/${e.id}/salary`, { effectiveFrom: '2024-01-01', monthlyGross: '31000', annualCtc: '372000', currency: 'INR' });
      expect(res.statusCode, res.body).toBe(201);
      await components(h, preparer, res.json().id, [{ code: 'CR_BASIC', amount: '31000' }]);
      return { id: e.id as string, departmentId };
    };
    const raise = async (employeeId: string, effectiveDate: string, amount: string, list?: { componentCode: string; amount: string; basis: 'MONTHLY' }[]) => {
      const res = await h.call(hr2, 'POST', '/v1/increment-cases/off-cycle', { employeeId, effectiveDate, proposedAmount: amount, proposedCounterpart: String(Number(amount) * 12), reason: 'Synthetic', ...(list ? { components: list } : {}) });
      expect(res.statusCode, res.body).toBe(201);
      const decided = await decide(hr1, res.json().taskId, 'APPROVE');
      expect(decided.json().state, decided.body).toBe('APPLIED');
      return latest(employeeId);
    };
    const approvedRun = async (period: string, departmentId: string) => {
      const run = await createRun(h, preparer, periods[period]!, { departmentIds: [departmentId] });
      await calculate(h, preparer, run.id);
      await submitAndApprove(h, { preparer, reviewer, approver }, run.id);
      return run;
    };
    const verify = async (runId: string) => ok(await h.call(processor, 'POST', `/v1/payroll/runs/${runId}/verify`));

    beforeAll(async () => {
      const configA = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
      const configB = await h.actor(A, 'HR_ADMINISTRATOR', { extra: CONFIG });
      preparer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: grants(PREPARE, SALARY) });
      reviewer = await h.actor(A, 'HR_ADMINISTRATOR', { extra: REVIEW });
      approver = await h.actor(A, 'HR_ADMINISTRATOR', { extra: APPROVE });
      processor = await h.actor(A, 'HR_ADMINISTRATOR', { extra: PROCESS });
      await reviewers(h, plain, 'payroll_run', [reviewer]);
      await reviewers(h, plain, 'payroll_run_approval', [approver]);
      await head(h, configA, configB, { code: 'CR_BASIC', headType: 'EARNING', basis: 'FIXED', sequence: 1 });
      periods = (await calendar(h, configA, configB, [...months(2026)])).periods;
    });

    it('a month containing the corrected date is calculated from the chain alone: two real segments, no empty one', async () => {
      const p = await payee();
      const first = await raise(p.id, '2026-03-16', '62000', [{ componentCode: 'CR_BASIC', amount: '62000', basis: 'MONTHLY' }]);
      await corrected(p.id, first.id, { effectiveDate: '2026-03-16', proposedAmount: '46500', proposedCounterpart: '558000', components: [{ componentCode: 'CR_BASIC', amount: '46500', basis: 'MONTHLY' }] });
      const run = await createRun(h, preparer, periods['2026-03']!, { departmentIds: [p.departmentId] });
      await calculate(h, preparer, run.id);
      const r = await record(h, preparer, run.id, p.id);
      expect(r.calculationStatus, JSON.stringify(r.exceptions)).toBe('CALCULATED');
      expect(r.segments.map((s) => [s.segmentStart, s.segmentEnd, s.calendarDays])).toEqual([
        ['2026-03-01', '2026-03-15', 15],
        ['2026-03-16', '2026-03-31', 16],
      ]);
      // 31000 x 15/31 + 46500 x 16/31; never the 62000 that was corrected away.
      expect(Number(r.earnings)).toBeCloseTo(15000 + 24000, 2);
    });

    it('the components of the retired arrangement stay on record and are never read; a correction without a breakdown says so instead of using them', async () => {
      const p = await payee();
      const first = await raise(p.id, '2026-04-16', '62000', [{ componentCode: 'CR_BASIC', amount: '62000', basis: 'MONTHLY' }]);
      await corrected(p.id, first.id, { effectiveDate: '2026-04-16', proposedAmount: '46500', proposedCounterpart: '558000' });
      const retired = await h.one<{ id: string; n: number }>(
        `select s.id, (select count(*)::int from salary_component c where c.salary_arrangement_id = s.id) as n from salary_arrangement s where s.employee_id = $1 and s.superseded_at is not null`,
        [p.id],
      );
      expect(retired.n).toBe(1);
      const refused = await h.call(preparer, 'POST', `/v1/payroll/salary-arrangements/${retired.id}/components`, { components: [{ componentCode: 'CR_BASIC', amount: '1', basis: 'MONTHLY' }] });
      expect(refused.statusCode).toBe(409);
      const run = await createRun(h, preparer, periods['2026-04']!, { departmentIds: [p.departmentId] });
      await calculate(h, preparer, run.id);
      const r = await record(h, preparer, run.id, p.id);
      expect(r.exceptions.map((x) => x.code)).toContain('SALARY_COMPONENTS_MISSING');
      expect(r.earnings).toBeNull();
    });

    it('never reaches a processed period; a run calculated before it stays reproducible', async () => {
      const p = await payee();
      const first = await raise(p.id, '2026-05-16', '62000', [{ componentCode: 'CR_BASIC', amount: '62000', basis: 'MONTHLY' }]);

      // A proposal made before the run is processed is stopped at its decision, and the task stays open.
      expect((await correct(hr2, first.id, { effectiveDate: '2026-05-16', proposedAmount: '46500', proposedCounterpart: '558000' })).statusCode).toBe(201);
      const waiting = (await taskFor(hr1, p.id))!.taskId;
      const run = await approvedRun('2026-05', p.departmentId);
      await processRun(h, processor, run.id);
      const before = await record(h, processor, run.id, p.id);

      const refused = await decide(hr1, waiting, 'APPROVE');
      expect([refused.statusCode, refused.json().error, refused.json().details]).toEqual([409, 'PAYROLL_PROCESSED', { processedThrough: '2026-05-31' }]);
      expect((await decide(hr1, waiting, 'REJECT')).json().state).toBe('REJECTED');

      for (const effectiveDate of ['2026-05-16', '2026-05-20', '2026-05-31']) {
        const res = await correct(hr2, first.id, { effectiveDate, proposedAmount: '46500', proposedCounterpart: '558000' });
        expect([res.statusCode, res.json().error], effectiveDate).toEqual([409, 'PAYROLL_PROCESSED']);
      }
      // A later date touches the salary from May 16 too: the original record is in force through the processed month.
      expect((await correct(hr2, first.id, { effectiveDate: '2026-07-01', proposedAmount: '46500', proposedCounterpart: '558000' })).json().error).toBe('PAYROLL_PROCESSED');

      const after = await record(h, processor, run.id, p.id);
      expect(after.segments).toEqual(before.segments);
      expect([after.earnings, after.net]).toEqual([before.earnings, before.net]);
      expect(await verify(run.id)).toMatchObject({ identical: true, lineDifferences: 0, totalDifferences: 0 });
    });

    it('a frozen run of an earlier period is untouched and still reproduces after a correction takes effect later', async () => {
      const p = await payee();
      const june = await approvedRun('2026-06', p.departmentId);
      await processRun(h, processor, june.id);
      const before = await record(h, processor, june.id, p.id);
      const first = await raise(p.id, '2026-08-01', '62000');
      await corrected(p.id, first.id, { effectiveDate: '2026-08-01', proposedAmount: '46500', proposedCounterpart: '558000' });
      const after = await record(h, processor, june.id, p.id);
      expect(after.segments).toEqual(before.segments);
      expect(after.net).toBe(before.net);
      expect(await verify(june.id)).toMatchObject({ identical: true, lineDifferences: 0, totalDifferences: 0, paidDayDifferences: 0 });
    });

    it('a period a live run has calculated is refused until that run is revised or cancelled', async () => {
      const p = await payee();
      const first = await raise(p.id, '2026-09-16', '62000', [{ componentCode: 'CR_BASIC', amount: '62000', basis: 'MONTHLY' }]);
      const run = await createRun(h, preparer, periods['2026-09']!, { departmentIds: [p.departmentId] });
      await calculate(h, preparer, run.id);
      expect((await correct(hr2, first.id, { effectiveDate: '2026-09-16', proposedAmount: '46500', proposedCounterpart: '558000' })).json().error).toBe('PAYROLL_IN_PROGRESS');
      const cancelled = await h.db.query(`select 1 from payroll_run where id = $1 and state = 'CALCULATED'`, [run.id]);
      expect(cancelled.rowCount).toBe(1);
    });
  });
});
