// Paged timesheet lists and reports with complete totals (FR-056 "pagination, total counts"; FR-046; FR-048; F1
// utilisation). A team larger than one page: the pages continue without overlap, `total` counts every match in row
// scope, and the utilisation totals are computed over every employee in scope whatever page is shown. Synthetic data.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { isModuleActive } from '../registry.js';
import { allocate, approvedWeek, openWeek, person, type TimesheetWorld, timesheetWorld } from './timesheet.fixtures.js';

const W1 = '2026-03-02';
const W1_END = '2026-03-08';
const EXTRA_TEAM = 26;

interface Paged<T> {
  items: T[];
  total: number;
  page?: number;
  pageSize?: number;
}
interface Utilisation extends Paged<{ employeeId: string; status: string; approvedMinutes: number; productiveMinutes: number; scheduledMinutes: number | null }> {
  totals: { employees: number; byStatus: Record<string, number>; approvedMinutes: number; productiveMinutes: number; scheduledMinutes: number | null };
}

describe.runIf(isModuleActive('timesheet'))('timesheet: paged lists and reports (FR-056)', () => {
  let h: Harness;
  let A: Company;
  let w: TimesheetWorld;
  let hrFin: TestActor;

  const get = async <T>(a: TestActor, url: string): Promise<T> => {
    const res = await h.call(a, 'GET', url);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as T;
  };
  const line = (workDate: string, extra: Record<string, unknown> = {}) => ({ workDate, jobId: w.jobId, activityId: w.devId, minutes: 480, ...extra });

  beforeAll(async () => {
    h = await startHarness();
    A = await h.makeCompany();
    w = await timesheetWorld(h, A);
    hrFin = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.financeDept });
    // The manager's team grows past one page; the outsider reports to another manager.
    for (const id of [w.employeeEmp, w.peerEmp, w.outsiderEmp]) expect((await allocate(h, w.hr, { employeeId: id, jobId: w.jobId })).statusCode).toBe(201);
    for (let i = 0; i < EXTRA_TEAM; i++) {
      const p = await person(h, A, w.hr, w.managerEmp);
      const res = await allocate(h, w.hr, { employeeId: p.id, jobId: w.jobId });
      expect(res.statusCode, res.body).toBe(201);
    }
    // One employee has a shift (a known schedule) and an approved week; the peer has a draft week.
    const shift = await h.call(w.hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day shift', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] });
    expect(shift.statusCode, shift.body).toBe(201);
    expect((await h.call(w.hr, 'POST', `/v1/employees/${w.employeeEmp}/shift`, { shiftId: shift.json().id, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
    await approvedWeek(h, w, w.employee, W1, [line(W1), line('2026-03-03', { minutes: 240 }), line('2026-03-03', { activityId: w.meetId, minutes: 240 })]);
    await openWeek(h, w.peer, W1);
  });

  afterAll(async () => {
    await h?.stop();
  });

  it('pages allocations: the pages continue without overlap and the total counts every allocation in row scope', async () => {
    const population = EXTRA_TEAM + 3;
    const all = await get<Paged<{ id: string; employeeId: string }>>(w.hr, `/v1/timesheet/allocations?jobId=${w.jobId}`);
    expect(all.total).toBe(population);
    expect(all.items).toHaveLength(population);
    expect(all).not.toHaveProperty('page');
    const p1 = await get<Paged<{ id: string }>>(w.hr, `/v1/timesheet/allocations?jobId=${w.jobId}&page=1&pageSize=25`);
    const p2 = await get<Paged<{ id: string }>>(w.hr, `/v1/timesheet/allocations?jobId=${w.jobId}&page=2&pageSize=25`);
    expect(p1).toMatchObject({ total: population, page: 1, pageSize: 25 });
    expect(p1.items).toHaveLength(25);
    expect(p2.items).toHaveLength(population - 25);
    expect([...p1.items, ...p2.items].map((a) => a.id)).toEqual(all.items.map((a) => a.id));
    expect(await get(w.hr, `/v1/timesheet/allocations?jobId=${w.jobId}&page=3&pageSize=25`)).toEqual({ items: [], total: population, page: 3, pageSize: 25 });
    // Row scope applies to the pages and the total: the manager's team only, nobody for HR limited to finance.
    const team = await get<Paged<{ employeeId: string }>>(w.manager, `/v1/timesheet/allocations?jobId=${w.jobId}&page=1&pageSize=50`);
    expect(team.total).toBe(population - 1);
    expect(team.items.map((a) => a.employeeId)).not.toContain(w.outsiderEmp);
    expect(await get(hrFin, `/v1/timesheet/allocations?jobId=${w.jobId}&page=1&pageSize=25`)).toEqual({ items: [], total: 0, page: 1, pageSize: 25 });
  });

  it('pages the utilisation report by employee with totals computed over every employee in scope, never only the page', async () => {
    const q = `from=${W1}&to=${W1_END}`;
    const all = await get<Utilisation>(w.hr, `/v1/timesheet-reports/utilisation?${q}`);
    const population = EXTRA_TEAM + 3;
    expect(all.total).toBe(population);
    expect(all.items).toHaveLength(population);
    const p1 = await get<Utilisation>(w.hr, `/v1/timesheet-reports/utilisation?${q}&page=1&pageSize=25`);
    const p2 = await get<Utilisation>(w.hr, `/v1/timesheet-reports/utilisation?${q}&page=2&pageSize=25`);
    const past = await get<Utilisation>(w.hr, `/v1/timesheet-reports/utilisation?${q}&page=3&pageSize=25`);
    expect(p1).toMatchObject({ total: population, page: 1, pageSize: 25 });
    expect(p1.items).toHaveLength(25);
    expect(p2.items).toHaveLength(population - 25);
    expect(past.items).toEqual([]);
    expect([...p1.items, ...p2.items].map((u) => u.employeeId)).toEqual(all.items.map((u) => u.employeeId));
    // The totals are the same on every page and add up every employee's measures, not only the page's.
    const sum = (k: 'approvedMinutes' | 'productiveMinutes') => all.items.reduce((s, u) => s + u[k], 0);
    const count = (status: string) => all.items.filter((u) => u.status === status).length;
    const expected = {
      employees: population,
      byStatus: { OK: count('OK'), NOT_APPLICABLE: count('NOT_APPLICABLE'), NOT_CONFIGURED: count('NOT_CONFIGURED') },
      approvedMinutes: sum('approvedMinutes'),
      productiveMinutes: sum('productiveMinutes'),
      // Some employees have no shift: the scheduled hours of the population are not known.
      scheduledMinutes: null,
    };
    expect(expected).toMatchObject({ approvedMinutes: 960, productiveMinutes: 720, byStatus: { OK: 1 } });
    expect(expected.byStatus.NOT_CONFIGURED).toBeGreaterThan(0);
    for (const r of [all, p1, p2, past]) expect(r.totals).toEqual(expected);
    expect(past.total).toBe(population);
    // With every schedule known the scheduled total is the sum (one employee: 5 x 480 minutes).
    const one = await get<Utilisation>(w.hr, `/v1/timesheet-reports/utilisation?${q}&employeeId=${w.employeeEmp}`);
    expect(one.totals).toEqual({ employees: 1, byStatus: { OK: 1, NOT_APPLICABLE: 0, NOT_CONFIGURED: 0 }, approvedMinutes: 960, productiveMinutes: 720, scheduledMinutes: 2400 });
    // Row scope applies to the rows and the totals.
    const team = await get<Utilisation>(w.manager, `/v1/timesheet-reports/utilisation?${q}&page=2&pageSize=25`);
    expect(team.total).toBe(population - 1);
    expect(team.totals.employees).toBe(population - 1);
    expect(team.items.map((u) => u.employeeId)).not.toContain(w.outsiderEmp);
    const none = await get<Utilisation>(hrFin, `/v1/timesheet-reports/utilisation?${q}&page=1&pageSize=25`);
    expect(none).toMatchObject({ items: [], total: 0, totals: { employees: 0, approvedMinutes: 0, productiveMinutes: 0, scheduledMinutes: 0 } });
  });

  it('pages timesheets and the hours report; the hours totals always cover every approved line', async () => {
    const range = `from=${W1}&to=${W1_END}`;
    const sheets = await get<Paged<{ employeeId: string }>>(w.hr, `/v1/timesheets?${range}&page=1&pageSize=25`);
    expect(sheets).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(await get(w.hr, `/v1/timesheets?${range}&page=2&pageSize=25`)).toEqual({ items: [], total: 2, page: 2, pageSize: 25 });
    expect((await get<Paged<unknown>>(w.hr, `/v1/timesheets?${range}`)).total).toBe(2);
    expect((await get<Paged<unknown>>(hrFin, `/v1/timesheets?${range}&page=1&pageSize=25`)).total).toBe(0);
    expect(await get(w.employee, `/v1/me/timesheets?${range}&page=1&pageSize=25`)).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    // Hours: a page past the groups still carries the totals of every line.
    const hours = await get<{ groups: unknown[]; totalGroups: number; totals: { minutes: number; lineCount: number } }>(w.hr, `/v1/timesheet-reports/hours?${range}&groupBy=employee`);
    expect(hours).toMatchObject({ totalGroups: 1, totals: { minutes: 960, lineCount: 3 } });
    expect(hours).not.toHaveProperty('page');
    const pastGroups = await get<typeof hours & { page: number }>(w.hr, `/v1/timesheet-reports/hours?${range}&groupBy=employee&page=2&pageSize=25`);
    expect(pastGroups).toMatchObject({ groups: [], totalGroups: 1, page: 2, pageSize: 25, totals: hours.totals });
    const lines = await get<Paged<{ minutes: number }>>(w.hr, `/v1/timesheet-reports/lines?${range}&page=1&pageSize=25`);
    expect(lines).toMatchObject({ total: 3, page: 1, pageSize: 25 });
    expect(lines.items.reduce((s, l) => s + l.minutes, 0)).toBe(hours.totals.minutes);
  });
});
