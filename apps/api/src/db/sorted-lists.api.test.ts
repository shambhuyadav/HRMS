// FR-056 "sortable columns where appropriate" over HTTP: the exit, settlement, audit and team lists sort by an allowlisted
// column in SQL before paging, so the total and the pages stay consistent: nothing overlaps or goes missing between pages,
// also where a column has ties, and row scope and own-record rules hold under every order. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../test/harness.js';
import { AUDIT_SORTS } from '../modules/audit-trail/service.js';
import { EXIT_SORTS } from '../modules/lifecycle/exit.js';
import { HR_SETTLEMENT, person, today as businessDate } from '../modules/lifecycle/lifecycle.fixtures.js';
import { SETTLEMENT_SORTS } from '../modules/lifecycle/settlement.js';
import { approvedExit } from '../modules/payroll/payroll.fixtures.js';
import { isModuleActive } from '../modules/registry.js';
import { TEAM_SORTS } from '../modules/team/service.js';
import { sortedBy } from './paging.js';

/** More than one page of the smallest page size the lists accept (25). */
const COUNT = 27;

interface Row {
  id: string;
  [key: string]: unknown;
}

describe('sortedBy', () => {
  const columns = { name: 'x.name' };
  it('orders by the chosen column, blanks last either way, then the tie-break; anything else keeps the default', () => {
    expect(sortedBy({ sort: 'name' }, columns, 'created desc, id')).toBe('x.name asc nulls last, created desc, id');
    expect(sortedBy({ sort: 'name', direction: 'DESC' }, columns, 'created desc, id')).toBe('x.name desc nulls last, created desc, id');
    expect(sortedBy({ sort: 'name' }, columns, 'created desc, id', 'id')).toBe('x.name asc nulls last, id');
    expect(sortedBy({}, columns, 'created desc, id')).toBe('created desc, id');
    expect(sortedBy({ direction: 'DESC' }, columns, 'created desc, id')).toBe('created desc, id');
    // Never a value that is not on the list, nor a name every object inherits.
    expect(sortedBy({ sort: '1; drop table employee' }, columns, 'created desc, id')).toBe('created desc, id');
    expect(sortedBy({ sort: 'constructor' }, columns, 'created desc, id')).toBe('created desc, id');
  });
});

describe.runIf(isModuleActive('lifecycle'))('sorted lists (FR-056)', () => {
  let h: Harness;
  let A: Company;
  let hr: TestActor;
  let prep: TestActor;
  let manager: TestActor;
  let auditor: TestActor;
  let team: { employeeId: string; name: string; lastWorkingDate: string; exitId: string; settlementId: string }[];
  let financeEmployee: string;

  /** Every page of a list, as a reader walks them. */
  async function walk(a: TestActor, path: string, query: string) {
    const rows: Row[] = [];
    let total = -1;
    for (let page = 1; page < 20; page++) {
      const res = await h.call(a, 'GET', `${path}?${query}${query ? '&' : ''}page=${page}&pageSize=25`);
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as { items: Row[]; total: number };
      total = body.total;
      rows.push(...body.items);
      if (rows.length >= total || body.items.length === 0) break;
    }
    return { rows, total };
  }

  const expectConsistentPages = (shown: { rows: Row[]; total: number }, count: number) => {
    expect(shown.total).toBe(count);
    expect(shown.rows).toHaveLength(count);
    expect(new Set(shown.rows.map((r) => r.id)).size).toBe(count);
  };
  const combos = (sorts: readonly string[]) => sorts.flatMap((sort) => [[sort, 'ASC'], [sort, 'DESC']] as [string, string][]);

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    hr = await h.actor(A, 'HR_ADMINISTRATOR');
    prep = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT });
    auditor = await h.actor(A, 'AUDITOR');
    const managerEmp = await person(h, A, hr, { name: 'Maya Manager (synthetic)' });
    manager = await h.actor(A, 'REPORTING_MANAGER', { employeeId: managerEmp });
    const today = await businessDate(h, A);
    const later = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
    team = [];
    for (let i = 0; i < COUNT; i++) {
      // Names and dates run in a different order from the employee codes, which are issued in sequence.
      const position = (i * 7) % COUNT;
      const name = `Sorted ${String(position).padStart(2, '0')} (synthetic)`;
      const employeeId = await person(h, A, hr, { name, managerId: managerEmp });
      const lastWorkingDate = later(30 + ((i * 11) % COUNT));
      await approvedExit(h, A, employeeId, today, lastWorkingDate);
      const exitId = (await h.one<{ id: string }>(`select id from exit_case where company_id = $1 and employee_id = $2`, [A.id, employeeId])).id;
      const created = await h.call(prep, 'POST', `/v1/exit-cases/${exitId}/settlements`, { currencyCode: 'INR' });
      expect(created.statusCode, created.body).toBe(201);
      team.push({ employeeId, name, lastWorkingDate, exitId, settlementId: created.json().id as string });
    }
    const finance = await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { departmentId: A.financeDept, displayName: 'Finn Finance (synthetic)' }));
    financeEmployee = finance.json().id as string;
    await h.setStatus(A, financeEmployee, 'ACTIVE_CONFIRMED');
    await approvedExit(h, A, financeEmployee, today, later(100));
    const financeExit = (await h.one<{ id: string }>(`select id from exit_case where company_id = $1 and employee_id = $2`, [A.id, financeEmployee])).id;
    expect((await h.call(prep, 'POST', `/v1/exit-cases/${financeExit}/settlements`, { currencyCode: 'INR' })).statusCode).toBe(201);
  });

  afterAll(async () => {
    await h?.stop();
  });

  describe('exit cases', () => {
    it.each(combos(EXIT_SORTS))('%s %s pages without overlap or loss', async (sort, direction) => {
      expectConsistentPages(await walk(hr, '/v1/exit-cases', `sort=${sort}&direction=${direction}`), COUNT + 1);
    });

    it('sorts by the name and by the last working date, both ways, in SQL before paging', async () => {
      const names = team.map((t) => t.name).sort();
      const byName = (await walk(hr, '/v1/exit-cases', 'sort=employeeName&direction=ASC&state=APPROVED')).rows.filter((r) => String(r.employeeName).startsWith('Sorted')).map((r) => r.employeeName);
      expect(byName).toEqual(names);
      const dates = [...team.map((t) => t.lastWorkingDate)].sort().reverse();
      const byDate = (await walk(hr, '/v1/exit-cases', 'sort=lastWorkingDate&direction=DESC')).rows.filter((r) => String(r.employeeName).startsWith('Sorted')).map((r) => r.approvedLastWorkingDate);
      expect(byDate).toEqual(dates);
    });

    it('keeps the newest-first default, and row scope under every order', async () => {
      const plain = await walk(hr, '/v1/exit-cases', '');
      expect(plain.rows[0]!.employeeId).toBe(financeEmployee);
      const narrow = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
      for (const [sort, direction] of combos(EXIT_SORTS)) {
        const shown = await walk(narrow, '/v1/exit-cases', `sort=${sort}&direction=${direction}`);
        expect(shown.total).toBe(1);
        expect(shown.rows[0]!.employeeId).toBe(financeEmployee);
      }
    });

    it('refuses what is not on the list', async () => {
      for (const query of ['sort=reason', 'sort=employee_code', 'sort=password', 'sort=employeeName&direction=SIDEWAYS']) {
        expect((await h.call(hr, 'GET', `/v1/exit-cases?${query}`)).statusCode, query).toBe(400);
      }
    });
  });

  describe('settlements', () => {
    it.each(combos(SETTLEMENT_SORTS))('%s %s pages without overlap or loss', async (sort, direction) => {
      expectConsistentPages(await walk(prep, '/v1/settlements', `sort=${sort}&direction=${direction}`), COUNT + 1);
    });

    it('holds its filters, sorts before paging, and keeps one’s own settlement out under every order', async () => {
      const names = team.map((t) => t.name).sort();
      const shown = await walk(prep, '/v1/settlements', 'sort=employeeName&state=DRAFT');
      expect(shown.rows.filter((r) => String(r.employeeName).startsWith('Sorted')).map((r) => r.employeeName)).toEqual(names);
      expect((await walk(prep, '/v1/settlements', 'sort=employeeName&state=REJECTED')).total).toBe(0);
      const self = await h.actor(A, 'HR_ADMINISTRATOR', { extra: HR_SETTLEMENT, employeeId: team[0]!.employeeId });
      for (const [sort, direction] of combos(SETTLEMENT_SORTS)) {
        const own = await walk(self, '/v1/settlements', `sort=${sort}&direction=${direction}`);
        expect(own.total).toBe(COUNT);
        expect(own.rows.map((r) => r.id)).not.toContain(team[0]!.settlementId);
      }
    });

    it('never sorts by the net amount: its order would compare confidential amounts (DF02)', async () => {
      for (const a of [prep, hr]) expect((await h.call(a, 'GET', '/v1/settlements?sort=netAmount')).statusCode).toBe(400);
      expect((await h.call(prep, 'GET', '/v1/settlements?sort=net_amount')).statusCode).toBe(400);
    });

    it('shows no amount to a reader without the amount group, whatever the order', async () => {
      const reader = await h.actor(A, 'PAYROLL_OPERATOR', { extra: ['settlement.read.operational'] });
      const shown = await walk(reader, '/v1/settlements', 'sort=employeeName&direction=DESC');
      expect(shown.total).toBe(COUNT + 1);
      for (const r of shown.rows) expect(r).not.toHaveProperty('netAmount');
    });
  });

  describe('audit events', () => {
    it.each(combos(AUDIT_SORTS))('%s %s pages without overlap or loss', async (sort, direction) => {
      // Employees: one CREATE each, and nothing else writes that action on this resource during the walk.
      const count = (await h.call(auditor, 'GET', '/v1/audit/events?resource=employee&action=CREATE&pageSize=1')).json().total as number;
      expect(count).toBeGreaterThan(25);
      expectConsistentPages(await walk(auditor, '/v1/audit/events', `resource=employee&action=CREATE&sort=${sort}&direction=${direction}`), count);
    });

    it('stays newest first by default; a sort by time reads the same reversed, and filtered to one record', async () => {
      const newest = (await walk(auditor, '/v1/audit/events', 'resource=employee&action=CREATE')).rows.map((r) => r.id);
      expect((await walk(auditor, '/v1/audit/events', 'resource=employee&action=CREATE&sort=occurredAt&direction=DESC')).rows.map((r) => r.occurredAt)).toEqual(
        (await walk(auditor, '/v1/audit/events', 'resource=employee&action=CREATE')).rows.map((r) => r.occurredAt),
      );
      const ascending = (await walk(auditor, '/v1/audit/events', 'resource=employee&action=CREATE&sort=occurredAt&direction=ASC')).rows;
      const times = ascending.map((r) => Date.parse(String(r.occurredAt)));
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      expect(ascending).toHaveLength(newest.length);
      const one = await walk(auditor, '/v1/audit/events', `recordKey=${team[0]!.employeeId}&resource=employee&sort=action`);
      expect(one.rows.every((r) => r.recordKey === team[0]!.employeeId)).toBe(true);
    });

    it('refuses what is not on the list, and stays the audit duty’s', async () => {
      for (const query of ['sort=after_values', 'sort=reason', 'sort=occurredAt&direction=UP']) {
        expect((await h.call(auditor, 'GET', `/v1/audit/events?${query}`)).statusCode, query).toBe(400);
      }
      expect((await h.call(hr, 'GET', '/v1/audit/events?sort=actor')).statusCode).toBe(403);
      expect((await h.call(await h.actor(A, 'AUDITOR', { departmentFilter: A.dept }), 'GET', '/v1/audit/events?sort=actor')).statusCode).toBe(403);
    });
  });

  describe('my team', () => {
    it.each(combos(TEAM_SORTS))('%s %s pages without overlap or loss', async (sort, direction) => {
      expectConsistentPages(await walk(manager, '/v1/my-team', `sort=${sort}&direction=${direction}`), COUNT);
    });

    it('sorts by name both ways, and a manager sees only their own team under any order', async () => {
      const names = team.map((t) => t.name).sort();
      expect((await walk(manager, '/v1/my-team', 'sort=displayName')).rows.map((r) => r.displayName)).toEqual(names);
      expect((await walk(manager, '/v1/my-team', 'sort=displayName&direction=DESC')).rows.map((r) => r.displayName)).toEqual([...names].reverse());
      const other = await h.actor(A, 'REPORTING_MANAGER', { employeeId: await person(h, A, hr, { name: 'Omar Other Manager (synthetic)' }) });
      for (const [sort, direction] of combos(TEAM_SORTS)) expect((await walk(other, '/v1/my-team', `sort=${sort}&direction=${direction}`)).total).toBe(0);
    });

    it('refuses what is not on the list', async () => {
      for (const query of ['sort=salary', 'sort=workEmail', 'sort=displayName&direction=0']) {
        expect((await h.call(manager, 'GET', `/v1/my-team?${query}`)).statusCode, query).toBe(400);
      }
    });
  });
});
