// Attendance dashboard over HTTP (BRD coverage CL-053; FR-019 to FR-027; BR-026; ZT17; DF05; DF09): the counts of a date per
// department and in total on the constructed scenario (attendance-r2.fixtures.ts), from processed results where they exist and
// from what is known otherwise; every count reconciles with the list it opens; the row scope applies. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { buildScenario, type Scenario } from './attendance-r2.fixtures.js';

let h: Harness;
let A: Company;
let s: Scenario;

type Counts = Record<string, number>;
interface Dashboard {
  date: string;
  processing: { state: string; employees: number; processed: number };
  categories: string[];
  departments: { departmentId: string | null; departmentCode: string | null; total: number; counts: Counts }[];
  total: { total: number; counts: Counts };
}

const query = (date: string | null, departments: string[] = []) =>
  [...(date ? [`date=${date}`] : []), ...departments.map((d) => `departmentId=${d}`)].join('&');

async function dashboard(a: TestActor, date: string | null, departments: string[] = []): Promise<Dashboard> {
  const res = await h.call(a, 'GET', `/v1/attendance/dashboard?${query(date, departments)}`);
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Dashboard;
}

async function list(a: TestActor, date: string, name: string, extra = ''): Promise<{ codes: string[]; total: number; items: Record<string, unknown>[] }> {
  const codes: string[] = [];
  let total = 0;
  const items: Record<string, unknown>[] = [];
  for (let page = 1; page < 20; page++) {
    const res = await h.call(a, 'GET', `/v1/attendance/dashboard/employees?date=${date}&list=${name}&page=${page}&pageSize=25${extra}`);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { items: { employeeCode: string }[]; total: number };
    total = body.total;
    codes.push(...body.items.map((i) => i.employeeCode));
    items.push(...body.items);
    if (codes.length >= total || body.items.length === 0) break;
  }
  return { codes, total, items };
}

/** Only the counts that are not zero. */
const nonZero = (c: Counts) => Object.fromEntries(Object.entries(c).filter(([, n]) => n > 0));

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  s = await buildScenario(h, A);
}, 600_000);

afterAll(async () => {
  await h?.stop();
});

describe('attendance dashboard (CL-053; FR-021, FR-022, BR-026, ZT17)', () => {
  it('FR-021: a processed date is read from its results: present, late, absent, on leave and exceptions, per department and in total', async () => {
    const d = await dashboard(s.hr, '2026-03-05');
    expect(d.processing).toEqual({ state: 'PROCESSED', employees: 7, processed: 7 });
    expect(nonZero(d.total.counts)).toEqual({ PRESENT: 2, LATE: 1, ABSENT: 2, ON_LEAVE: 2, NEEDS_REVIEW: 1 });
    expect(d.total.total).toBe(7);
    expect(d.departments.map((x) => [x.departmentCode, x.total, nonZero(x.counts)])).toEqual([
      ['ABS', 4, { ABSENT: 2, ON_LEAVE: 2 }],
      ['ENG', 3, { PRESENT: 2, LATE: 1, NEEDS_REVIEW: 1 }],
    ]);
    // The categories hold every employee once.
    for (const x of [...d.departments, d.total]) expect(d.categories.reduce((n, c) => n + x.counts[c]!, 0)).toBe(x.total);
  });

  it('FR-022 DF09: a date not yet processed says so and shows what is known: punched, not punched, on approved leave', async () => {
    const d = await dashboard(s.hr, '2026-03-09');
    expect(d.processing).toEqual({ state: 'NOT_PROCESSED', employees: 9, processed: 0 });
    expect(nonZero(d.total.counts)).toEqual({ PUNCHED: 2, NOT_PUNCHED: 6, ON_LEAVE: 1 });
    const notPunched = await list(s.hr, '2026-03-09', 'NOT_PUNCHED');
    expect(notPunched.codes).toEqual(['AB01', 'L101', 'NS01', 'P101', 'SU01', 'TM01']);
    // DF09: the failed fetch is shown beside the employee, never as absence.
    expect(notPunched.items.find((i) => i.employeeCode === 'SU01')).toMatchObject({ punchSourceUnavailable: true, processed: false });
    expect((await list(s.hr, '2026-03-09', 'PUNCHED')).items.map((i) => [i.employeeCode, i.punchCount, i.firstPunch])).toEqual([
      ['EX01', 1, '2026-03-09 09:05'],
      ['JN01', 2, '2026-03-09 09:00'],
    ]);
    // A holiday: everyone is off except whoever worked on it.
    const holiday = await dashboard(s.hr, '2026-03-10');
    expect(nonZero(holiday.total.counts)).toEqual({ OFF_DAY: 8, OUTDOOR_OR_HOLIDAY_WORK: 1 });
    expect((await list(s.hr, '2026-03-10', 'OUTDOOR_OR_HOLIDAY_WORK')).codes).toEqual(['P101']);
  });

  it('ZT17 BR-026: every count opens a list of exactly that many employees, also per department and for the chosen departments', async () => {
    for (const date of ['2026-03-05', '2026-03-06', '2026-03-09', '2026-03-10']) {
      for (const departments of [[], [A.dept], [s.abs], [A.dept, s.abs]]) {
        const d = await dashboard(s.hr, date, departments);
        const chosen = departments.map((x) => `&departmentId=${x}`).join('');
        for (const name of [...d.categories, 'LATE']) {
          const all = await list(s.hr, date, name, chosen);
          expect([date, departments.length, name, all.total, all.codes.length]).toEqual([date, departments.length, name, d.total.counts[name], d.total.counts[name]]);
          for (const dep of d.departments) {
            const one = await list(s.hr, date, name, `${chosen}&inDepartment=${dep.departmentId}`);
            expect([date, dep.departmentCode, name, one.total]).toEqual([date, dep.departmentCode, name, dep.counts[name]]);
          }
        }
      }
    }
    expect((await list(s.hr, '2026-03-05', 'LATE')).codes).toEqual(['L101']);
    expect((await list(s.hr, '2026-03-05', 'PRESENT', `&inDepartment=${A.dept}`)).codes).toEqual(['L101', 'P101']);
    // Outdoor duty on a processed day.
    expect((await list(s.hr, '2026-03-06', 'OUTDOOR_OR_HOLIDAY_WORK')).codes).toEqual(['JN01']);
    expect((await dashboard(s.hr, '2026-03-05', [s.abs])).total.total).toBe(4);
    // Several hundred requests: a loaded machine needs more than the default minute.
  }, 240_000);

  it('BR-026: a manager sees only their team, an employee only themselves, a role without attendance access nothing', async () => {
    const mine = await dashboard(s.manager, '2026-03-05');
    expect([mine.total.total, nonZero(mine.total.counts)]).toEqual([1, { ABSENT: 1 }]);
    expect((await list(s.manager, '2026-03-05', 'ABSENT')).codes).toEqual(['TM01']);
    expect((await list(s.manager, '2026-03-05', 'PRESENT')).total).toBe(0);
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: s.ids.AB01! });
    expect(nonZero((await dashboard(employee, '2026-03-05')).total.counts)).toEqual({ ON_LEAVE: 1 });
    const payroll = await h.actor(A, 'PAYROLL_OPERATOR');
    expect((await h.call(payroll, 'GET', '/v1/attendance/dashboard')).statusCode).toBe(403);
  });

  it('ZT01 BR-026: another company’s employees and departments never appear, not even when named', async () => {
    const B = await h.makeCompany();
    const hrB = await h.actor(B, 'HR_ADMINISTRATOR');
    const other = await h.call(hrB, 'POST', '/v1/employees', h.newEmployeeBody(B, { employeeCode: 'OTH1', joiningDate: '2026-01-05' }));
    expect(other.statusCode, other.body).toBe(201);
    await h.setStatus(B, other.json().id, 'ACTIVE_CONFIRMED');
    expect((await dashboard(s.hr, '2026-03-05')).total.total).toBe(7);
    expect((await dashboard(s.hr, '2026-03-05', [B.dept])).total.total).toBe(0);
    expect((await list(s.hr, '2026-03-05', 'NOT_PUNCHED', `&inDepartment=${B.dept}`)).total).toBe(0);
    expect((await dashboard(hrB, '2026-03-05')).total).toMatchObject({ total: 1 });
    expect((await list(hrB, '2026-03-05', 'NOT_PUNCHED')).codes).toEqual(['OTH1']);
  });

  it('FR-022: today by default; a date processed for some of the selection says so; the department choice is bounded', async () => {
    const today = await dashboard(s.hr, null);
    expect(today.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(today.processing.state).toBe('NOT_PROCESSED');
    expect(today.total.total).toBe(9);
    // Processing 9 March for ENG only (a department-filtered HR assignment) leaves the rest unprocessed.
    const engHr = await h.actor(A, 'HR_ADMINISTRATOR', { departmentFilter: A.dept });
    await h.runBulkJob(engHr, '/v1/attendance/processing', { workDate: '2026-03-09' });
    const partly = await dashboard(s.hr, '2026-03-09');
    expect(partly.processing).toEqual({ state: 'PARTLY_PROCESSED', employees: 9, processed: 4 });
    expect((await dashboard(s.hr, '2026-03-09', [A.dept])).processing.state).toBe('PROCESSED');
    // ENG's results: two absent, two exceptions (a missing out punch, no shift); ABS still from what is known.
    expect(partly.departments.map((x) => [x.departmentCode, nonZero(x.counts)])).toEqual([
      ['ABS', { PUNCHED: 1, NOT_PUNCHED: 3, ON_LEAVE: 1 }],
      ['ENG', { ABSENT: 2, NEEDS_REVIEW: 2 }],
    ]);
    const many = Array.from({ length: 51 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    expect((await h.call(s.hr, 'GET', `/v1/attendance/dashboard?${query('2026-03-09', many)}`)).statusCode).toBe(400);
    expect((await h.call(s.hr, 'GET', '/v1/attendance/dashboard/employees?date=2026-03-09&list=SOMETHING')).statusCode).toBe(400);
  });
});
