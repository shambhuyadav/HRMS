// Attendance registers over HTTP and the report worker (BRD coverage CL-047 shift punch register, CL-049 shift plan register,
// CL-050 shift deviation register, CL-051 absconding report; FR-019 to FR-027, FR-056; BR-026; ZT17; DF05; DF09): each report's
// rows on the constructed scenario (attendance-r2.fixtures.ts), its filters, the requester's row scope, and the absconding
// run-length rule. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';
import { csvTable } from '../report/csv.fixtures.js';
import { processReportQueue } from '../report/service.js';
import { approvedLeave, buildScenario, type Scenario } from './attendance-r2.fixtures.js';

let h: Harness;
let A: Company;
let s: Scenario;

const cells = (line: string) => [...line.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1]!.replace(/""/g, '"'));

async function requested(a: TestActor, reportCode: string, filters: object, format?: string) {
  return h.call(a, 'POST', '/v1/reports', { reportCode, filters, ...(format ? { format } : {}) });
}

async function report(a: TestActor, reportCode: string, filters: object): Promise<Record<string, string>[]> {
  const res = await requested(a, reportCode, filters);
  expect(res.statusCode, res.body).toBe(202);
  await processReportQueue(h.pool, 10);
  const status = (await h.call(a, 'GET', `/v1/reports/${res.json().id}`)).json();
  expect(status.state, JSON.stringify(status)).toBe('COMPLETED');
  const file = await h.call(a, 'GET', `/v1/reports/${res.json().id}/download`);
  expect(file.statusCode, file.body).toBe(200);
  const [header, ...rows] = csvTable(file.body).trimEnd().split('\r\n').filter((l) => l !== '').map(cells);
  return rows.map((row) => Object.fromEntries(header!.map((column, i) => [column, row[i]!])));
}

const pick = (rows: Record<string, string>[], ...columns: string[]) => rows.map((r) => columns.map((c) => r[c]));

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  s = await buildScenario(h, A);
}, 600_000);

afterAll(async () => {
  await h?.stop();
});

describe('shift punch register (CL-047; FR-019, FR-021, FR-056)', () => {
  const period = { from: '2026-03-02', to: '2026-03-03' };

  it('FR-019 FR-056: every employee-day with its shift, punches in the capture window, first and last punch and source', async () => {
    const rows = await report(s.hr, 'SHIFT_PUNCH_REGISTER', { ...period, departmentId: A.dept });
    expect(pick(rows, 'Employee code', 'Work date', 'Shift', 'Shift in', 'Shift out', 'Punches')).toEqual([
      ['L101', '2026-03-02', 'DAY', '09:00', '18:00', '4'],
      ['L101', '2026-03-03', 'DAY', '09:00', '18:00', '2'],
      ['P101', '2026-03-02', 'DAY', '09:00', '18:00', '2'],
      ['P101', '2026-03-03', 'DAY', '09:00', '18:00', '0'],
    ]);
    expect(rows[0]).toMatchObject({
      'First punch': '2026-03-02 09:25',
      'Last punch': '2026-03-02 17:40',
      'Punch times': '09:25 IN (Import); 13:00 OUT (Import); 14:00 IN (Import); 17:40 OUT (Import)',
      Sources: 'Import',
      Day: 'Mon',
    });
    // The 19:00 out punch lies in the four-hour buffer after the shift's end, so it belongs to the day.
    expect(rows[1]!['Punch times']).toBe('09:00 IN (Import); 19:00 OUT (Import)');
    expect(rows[2]).toMatchObject({ 'Punch times': '09:00 IN (Terminal); 18:00 OUT (Import)', Sources: 'Import, Terminal' });
    expect(rows[3]).toMatchObject({ 'Punch times': '', 'First punch': '', Sources: '' });
  });

  it('FR-019 FR-056: punched, not punched, only first and last, and one punch source', async () => {
    const view = async (punchView: string, extra: object = {}) => pick(await report(s.hr, 'SHIFT_PUNCH_REGISTER', { ...period, departmentId: A.dept, punchView, ...extra }), 'Employee code', 'Work date', 'Punch times');
    expect((await view('PUNCHED')).map((r) => `${r[0]} ${r[1]}`)).toEqual(['L101 2026-03-02', 'L101 2026-03-03', 'P101 2026-03-02']);
    expect(await view('NOT_PUNCHED')).toEqual([['P101', '2026-03-03', '']]);
    expect((await view('FIRST_LAST'))[0]).toEqual(['L101', '2026-03-02', '09:25 IN (Import); 17:40 OUT (Import)']);
    expect(await view('PUNCHED', { punchSource: 'TERMINAL' })).toEqual([['P101', '2026-03-02', '09:00 IN (Terminal)']]);
    expect((await view('ALL', { punchSource: 'IMPORT', employeeId: s.ids.P101 })).map((r) => r[2])).toEqual(['18:00 OUT (Import)', '']);
  });

  it('BR-026: a manager sees only their team, and nobody is listed before joining or outside the filter', async () => {
    const mine = await report(s.manager, 'SHIFT_PUNCH_REGISTER', period);
    expect(pick(mine, 'Employee code', 'Work date', 'Punches')).toEqual([
      ['TM01', '2026-03-02', '0'],
      ['TM01', '2026-03-03', '0'],
    ]);
    const all = await report(s.hr, 'SHIFT_PUNCH_REGISTER', period);
    // EX01, NS01, JN01 and SU01 joined after the period.
    expect([...new Set(all.map((r) => r['Employee code']))]).toEqual(['AB01', 'L101', 'MG01', 'P101', 'TM01']);
  });

  it('FR-056 DF09: the filters it does not take, an unknown view, a missing period and a long period are refused; XLSX is offered', async () => {
    expect((await requested(s.hr, 'SHIFT_PUNCH_REGISTER', { ...period, punchView: 'SOMETIMES' })).statusCode).toBe(400);
    expect((await requested(s.hr, 'SHIFT_PUNCH_REGISTER', { ...period, minimumDays: 2 })).json().error).toBe('FILTER_NOT_SUPPORTED');
    expect((await requested(s.hr, 'SHIFT_PUNCH_REGISTER', {})).json().error).toBe('PERIOD_REQUIRED');
    expect((await requested(s.hr, 'SHIFT_PUNCH_REGISTER', { from: '2026-03-01', to: '2026-04-01' })).json().error).toBe('PERIOD_TOO_LONG');
    const xlsx = await requested(s.hr, 'SHIFT_PUNCH_REGISTER', period, 'XLSX');
    expect(xlsx.statusCode, xlsx.body).toBe(202);
    await processReportQueue(h.pool, 10);
    const file = await h.call(s.hr, 'GET', `/v1/reports/${xlsx.json().id}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('spreadsheetml');
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: s.ids.TM01! });
    expect([403, 404]).toContain((await requested(employee, 'SHIFT_PUNCH_REGISTER', period)).statusCode);
  });
});

describe('shift plan register (CL-049; FR-023, DF05)', () => {
  const period = { from: '2026-03-07', to: '2026-03-11' };

  it('FR-023 DF05: the shift planned for each employee and day, its times, and what the calendar makes of the day', async () => {
    const rows = await report(s.hr, 'SHIFT_PLAN_REGISTER', { ...period, departmentId: A.dept });
    expect(rows).toHaveLength(4 * 5);
    const l101 = rows.filter((r) => r['Employee code'] === 'L101');
    expect(pick(l101, 'Date', 'Day', 'Shift code', 'Shift name', 'Shift in', 'Shift out', 'Day type')).toEqual([
      ['2026-03-07', 'Sat', 'DAY', 'Day', '09:00', '18:00', 'Weekly off'],
      ['2026-03-08', 'Sun', 'DAY', 'Day', '09:00', '18:00', 'Weekly off'],
      ['2026-03-09', 'Mon', 'DAY', 'Day', '09:00', '18:00', 'Working day'],
      ['2026-03-10', 'Tue', 'DAY', 'Day', '09:00', '18:00', 'Holiday'],
      ['2026-03-11', 'Wed', 'NIGHT', 'Night', '22:00', '06:00', 'Working day'],
    ]);
    expect(pick(rows.filter((r) => r['Employee code'] === 'NS01'), 'Shift code', 'Shift name')[2]).toEqual(['', 'No shift assigned']);
    // EX01 joined on 5 March, so every day of the period is theirs.
    expect(rows.filter((r) => r['Employee code'] === 'EX01')).toHaveLength(5);
  });

  it('FR-023 FR-056: filtered by shift and employee; scoped to the manager’s team', async () => {
    expect(pick(await report(s.hr, 'SHIFT_PLAN_REGISTER', { ...period, shiftId: s.night }), 'Employee code', 'Date')).toEqual([['L101', '2026-03-11']]);
    expect((await report(s.hr, 'SHIFT_PLAN_REGISTER', { ...period, employeeId: s.ids.P101 })).map((r) => r['Employee code'])).toEqual(Array(5).fill('P101'));
    expect([...new Set((await report(s.manager, 'SHIFT_PLAN_REGISTER', period)).map((r) => r['Employee code']))]).toEqual(['TM01']);
  });
});

describe('shift punch register, one row per punch (CL-047 follow-up; FR-019, FR-056)', () => {
  const period = { from: '2026-03-02', to: '2026-03-03' };
  const punches = async (filters: object, a: TestActor = s.hr) => pick(await report(a, 'SHIFT_PUNCH_REGISTER_PUNCHES', { ...period, ...filters }), 'Employee code', 'Work date', 'Shift', 'Punch time (company time)', 'Direction', 'Source');

  it('CL-047 FR-019: each punch of the capture window on its own row with the day’s shift; a day without a punch is one row with no punch time', async () => {
    expect(await punches({ departmentId: A.dept })).toEqual([
      ['L101', '2026-03-02', 'DAY', '2026-03-02 09:25', 'IN', 'Import'],
      ['L101', '2026-03-02', 'DAY', '2026-03-02 13:00', 'OUT', 'Import'],
      ['L101', '2026-03-02', 'DAY', '2026-03-02 14:00', 'IN', 'Import'],
      ['L101', '2026-03-02', 'DAY', '2026-03-02 17:40', 'OUT', 'Import'],
      ['L101', '2026-03-03', 'DAY', '2026-03-03 09:00', 'IN', 'Import'],
      // In the four-hour buffer after the shift's end, so the day's punch, as in the one-row-per-day layout.
      ['L101', '2026-03-03', 'DAY', '2026-03-03 19:00', 'OUT', 'Import'],
      ['P101', '2026-03-02', 'DAY', '2026-03-02 09:00', 'IN', 'Terminal'],
      ['P101', '2026-03-02', 'DAY', '2026-03-02 18:00', 'OUT', 'Import'],
      ['P101', '2026-03-03', 'DAY', '', '', ''],
    ]);
    const rows = await report(s.hr, 'SHIFT_PUNCH_REGISTER_PUNCHES', { ...period, employeeId: s.ids.L101 });
    expect(Object.keys(rows[0]!)).toEqual(['Employee code', 'Name', 'Department', 'Work date', 'Day', 'Shift', 'Shift in', 'Shift out', 'Punch time (company time)', 'Direction', 'Source']);
    expect(rows[0]).toMatchObject({ Day: 'Mon', 'Shift in': '09:00', 'Shift out': '18:00' });
    // The same punches as the one-row-per-day layout counts.
    const days = await report(s.hr, 'SHIFT_PUNCH_REGISTER', { ...period, departmentId: A.dept });
    const punched = (await punches({ departmentId: A.dept, punchView: 'PUNCHED' })).length;
    expect(punched).toBe(days.reduce((n, d) => n + Number(d.Punches), 0));
  });

  it('CL-047 FR-019: the same views and punch source as the one-row-per-day layout', async () => {
    const at = (rows: (string | undefined)[][]) => rows.map((r) => `${r[0]} ${r[3]}`.trim());
    expect(at(await punches({ departmentId: A.dept, punchView: 'FIRST_LAST' }))).toEqual(['L101 2026-03-02 09:25', 'L101 2026-03-02 17:40', 'L101 2026-03-03 09:00', 'L101 2026-03-03 19:00', 'P101 2026-03-02 09:00', 'P101 2026-03-02 18:00']);
    expect(await punches({ departmentId: A.dept, punchView: 'NOT_PUNCHED' })).toEqual([['P101', '2026-03-03', 'DAY', '', '', '']]);
    expect(await punches({ punchView: 'PUNCHED', punchSource: 'TERMINAL' })).toEqual([['P101', '2026-03-02', 'DAY', '2026-03-02 09:00', 'IN', 'Terminal']]);
    expect(await punches({ punchSource: 'IMPORT', employeeId: s.ids.P101 })).toEqual([
      ['P101', '2026-03-02', 'DAY', '2026-03-02 18:00', 'OUT', 'Import'],
      ['P101', '2026-03-03', 'DAY', '', '', ''],
    ]);
  });

  it('CL-047 BR-026 FR-056: the same row scope, permission, period cap and filters; XLSX is offered', async () => {
    expect((await punches({}, s.manager)).map((r) => r[0])).toEqual(['TM01', 'TM01']);
    expect((await requested(s.hr, 'SHIFT_PUNCH_REGISTER_PUNCHES', { from: '2026-03-01', to: '2026-04-01' })).json().error).toBe('PERIOD_TOO_LONG');
    expect((await requested(s.hr, 'SHIFT_PUNCH_REGISTER_PUNCHES', { ...period, minimumDays: 2 })).json().error).toBe('FILTER_NOT_SUPPORTED');
    expect((await requested(s.hr, 'SHIFT_PUNCH_REGISTER_PUNCHES', {})).json().error).toBe('PERIOD_REQUIRED');
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: s.ids.AB01! });
    expect([403, 404]).toContain((await requested(employee, 'SHIFT_PUNCH_REGISTER_PUNCHES', period)).statusCode);
    const xlsx = await requested(s.hr, 'SHIFT_PUNCH_REGISTER_PUNCHES', period, 'XLSX');
    expect(xlsx.statusCode, xlsx.body).toBe(202);
  });
});

describe('shift plan register, month grid (CL-049 follow-up; FR-023, DF05)', () => {
  const period = { from: '2026-03-07', to: '2026-03-11' };
  const days = (row: Record<string, string>, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row[String(from + i)]);

  it('CL-049 DF05: one row per employee and month, a column per day with the shift code, W for a weekly off and H for a holiday', async () => {
    const rows = await report(s.hr, 'SHIFT_PLAN_MONTH_GRID', { ...period, departmentId: A.dept });
    const listed = (await h.call(s.hr, 'GET', '/v1/reports/catalogue')).json().items as { code: string; columns: string[] }[];
    expect(listed.find((r) => r.code === 'SHIFT_PLAN_MONTH_GRID')!.columns).toEqual(['Employee code', 'Name', 'Department', 'Month', ...Array.from({ length: 31 }, (_, i) => String(i + 1))]);
    expect(rows.map((r) => [r['Employee code'], r.Month])).toEqual([
      ['EX01', '2026-03'],
      ['L101', '2026-03'],
      ['NS01', '2026-03'],
      ['P101', '2026-03'],
    ]);
    const of = (code: string) => rows.find((r) => r['Employee code'] === code)!;
    // L101: the weekend, a working day, the holiday, then the night shift from the 11th (as the one-row-per-day layout shows them).
    expect(days(of('L101'), 7, 11)).toEqual(['W', 'W', 'DAY', 'H', 'NIGHT']);
    expect(days(of('P101'), 7, 11)).toEqual(['W', 'W', 'DAY', 'H', 'DAY']);
    // NS01 has no shift: a working day says so.
    expect(days(of('NS01'), 7, 11)).toEqual(['W', 'W', 'No shift', 'H', 'No shift']);
    // Days outside the period are blank.
    expect([...days(of('L101'), 1, 6), ...days(of('L101'), 12, 31)].every((d) => d === '')).toBe(true);
    expect(of('L101').Department).not.toBe('');
  });

  it('CL-049 DF05: a period across months gives a row per month; a shorter month leaves its last days blank', async () => {
    const rows = await report(s.hr, 'SHIFT_PLAN_MONTH_GRID', { from: '2026-02-27', to: '2026-03-02', employeeId: s.ids.P101 });
    expect(rows.map((r) => r.Month)).toEqual(['2026-02', '2026-03']);
    expect(days(rows[0]!, 27, 31)).toEqual(['DAY', 'W', '', '', '']);
    expect(days(rows[1]!, 1, 3)).toEqual(['W', 'DAY', '']);
  });

  it('CL-049 BR-026 FR-056: the same filters, row scope, permission and period cap as the one-row-per-day layout; XLSX is offered', async () => {
    expect(pick(await report(s.hr, 'SHIFT_PLAN_MONTH_GRID', { ...period, shiftId: s.night }), 'Employee code', '10', '11')).toEqual([['L101', '', 'NIGHT']]);
    expect((await report(s.manager, 'SHIFT_PLAN_MONTH_GRID', period)).map((r) => r['Employee code'])).toEqual(['TM01']);
    expect((await requested(s.hr, 'SHIFT_PLAN_MONTH_GRID', { from: '2026-01-01', to: '2026-04-30' })).json().error).toBe('PERIOD_TOO_LONG');
    expect((await requested(s.hr, 'SHIFT_PLAN_MONTH_GRID', { ...period, punchView: 'ALL' })).json().error).toBe('FILTER_NOT_SUPPORTED');
    const employee = await h.actor(A, 'EMPLOYEE', { employeeId: s.ids.SU01! });
    expect([403, 404]).toContain((await requested(employee, 'SHIFT_PLAN_MONTH_GRID', period)).statusCode);
    const xlsx = await requested(s.hr, 'SHIFT_PLAN_MONTH_GRID', period, 'XLSX');
    expect(xlsx.statusCode, xlsx.body).toBe(202);
    await processReportQueue(h.pool, 10);
    const file = await h.call(s.hr, 'GET', `/v1/reports/${xlsx.json().id}/download`);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toContain('spreadsheetml');
  });
});

describe('shift deviation register (CL-050; FR-020, FR-021, ZT17)', () => {
  const period = { from: '2026-03-02', to: '2026-03-03' };

  it('FR-020: late-in, early-out and overtime-candidate minutes against the shift, on processed days with a deviation', async () => {
    const rows = await report(s.hr, 'SHIFT_DEVIATION_REGISTER', period);
    expect(pick(rows, 'Employee code', 'Work date', 'Shift', 'Shift in', 'Shift out', 'Status', 'Late-in minutes', 'Early-out minutes', 'Overtime candidate minutes', 'Worked minutes')).toEqual([
      ['L101', '2026-03-02', 'DAY', '09:00', '18:00', 'PRESENT', '25', '20', '0', '435'],
      ['L101', '2026-03-03', 'DAY', '09:00', '18:00', 'PRESENT', '0', '0', '60', '540'],
    ]);
  });

  it('FR-021 ZT17: "late by at least", "early by at least" and "overtime only" are the attendance list’s minute filters, with the same days', async () => {
    const list = async (q: string) =>
      ((await h.call(s.hr, 'GET', `/v1/attendance/records?from=${period.from}&to=${period.to}&${q}`)).json().items as { employeeCode: string; workDate: string }[]).map((r) => [r.employeeCode, String(r.workDate).slice(0, 10)]).sort();
    for (const [field, value, expected] of [
      ['LATE', 25, [['L101', '2026-03-02']]],
      ['LATE', 26, []],
      ['EARLY_DEPARTURE', 20, [['L101', '2026-03-02']]],
      ['EARLY_DEPARTURE', 21, []],
      ['OVERTIME_CANDIDATE', 30, [['L101', '2026-03-03']]],
    ] as const) {
      const rows = pick(await report(s.hr, 'SHIFT_DEVIATION_REGISTER', { ...period, minuteField: field, minuteOp: 'GTE', minuteValue: value }), 'Employee code', 'Work date');
      expect(rows, `${field} >= ${value}`).toEqual(expected);
      expect(await list(`minuteField=${field}&minuteOp=GTE&minuteValue=${value}`), `${field} >= ${value}`).toEqual(expected);
    }
    expect((await requested(s.hr, 'SHIFT_DEVIATION_REGISTER', { ...period, minuteField: 'LATE' })).json().error).toBe('MINUTE_FILTER_INCOMPLETE');
  });

  it('FR-021: an amendment that drops the early-departure flag drops its minutes, and the revision keeps them', async () => {
    const record = (await h.call(s.hr, 'GET', `/v1/employees/${s.ids.L101}/attendance?from=2026-03-02&to=2026-03-02`)).json().items[0];
    expect(record).toMatchObject({ earlyDeparture: true, earlyDepartureMinutes: 20, lateMinutes: 25 });
    // A leave approved afterwards: the day is amended to LEAVE, which is never measured against the shift.
    await approvedLeave(h, A, s.ids.L101!, '2026-03-02', '2026-03-02');
    const amended = await h.call(s.hr, 'POST', `/v1/attendance/records/${record.id}/amend`, { expectedVersion: record.version, status: 'LEAVE', reason: 'Synthetic review' });
    expect(amended.statusCode, amended.body).toBe(200);
    const after = (await h.call(s.hr, 'GET', `/v1/employees/${s.ids.L101}/attendance?from=2026-03-02&to=2026-03-02`)).json().items[0];
    expect(after).toMatchObject({ status: 'LEAVE', earlyDeparture: false, earlyDepartureMinutes: 0, late: false, lateMinutes: 0 });
    const revision = await h.one<{ early_departure_minutes: number }>(`select early_departure_minutes from attendance_record_revision where attendance_record_id = $1`, [record.id]);
    expect(revision.early_departure_minutes).toBe(20);
    // A leave day carries no deviation, so the register drops it.
    expect(pick(await report(s.hr, 'SHIFT_DEVIATION_REGISTER', period), 'Employee code', 'Work date')).toEqual([['L101', '2026-03-03']]);
  });
});

describe('absconding report (CL-051; FR-021, FR-025 to FR-027, DF05, DF09)', () => {
  const period = { from: '2026-03-02', to: '2026-03-11' };
  const runs = (rows: Record<string, string>[]) => pick(rows, 'Employee code', 'Absent from', 'Absent to', 'Absent working days', 'Calendar days');

  it('FR-021 DF05: runs of absent working days; weekends and holidays bridge a run, leave, outdoor duty and a punch end it', async () => {
    const rows = await report(s.hr, 'ABSCONDING_REPORT', { ...period, departmentId: s.abs, minimumDays: 1 });
    expect(runs(rows)).toEqual([
      // Absent 2-4 March; approved leave on the 5th ends the run; absent on the 6th, 9th and 11th, the weekend and the holiday of
      // the 10th between them neither counting nor ending the run.
      ['AB01', '2026-03-02', '2026-03-04', '3', '3'],
      ['AB01', '2026-03-06', '2026-03-11', '3', '6'],
      // Joined on the 5th: absent that day; outdoor duty on the 6th and a punch on the 9th end the runs.
      ['JN01', '2026-03-05', '2026-03-05', '1', '1'],
      ['JN01', '2026-03-11', '2026-03-11', '1', '1'],
      // DF09: a failed fetch on the 9th is not absence (and ends the run), so only the 11th counts.
      ['SU01', '2026-03-11', '2026-03-11', '1', '1'],
      // Never punched: one run over the weekend and the holiday, processed days and unprocessed ones alike.
      ['TM01', '2026-03-02', '2026-03-11', '7', '10'],
    ]);
    // MG01 was on approved leave throughout: never absent.
    expect(rows.find((r) => r['Employee code'] === 'MG01')).toBeUndefined();
    expect(rows.find((r) => r['Employee code'] === 'JN01' && r['Absent from'] === '2026-03-11')!['Last punch before (company time)']).toBe('2026-03-09 18:00');
    expect(rows[0]!['Last punch before (company time)']).toBe('');
  });

  it('FR-021: N or more consecutive days, sorted by employee code or by the run’s first day', async () => {
    expect(runs(await report(s.hr, 'ABSCONDING_REPORT', { ...period, departmentId: s.abs, minimumDays: 3 })).map((r) => `${r[0]} ${r[1]}`)).toEqual(['AB01 2026-03-02', 'AB01 2026-03-06', 'TM01 2026-03-02']);
    expect(runs(await report(s.hr, 'ABSCONDING_REPORT', { ...period, departmentId: s.abs, minimumDays: 4 })).map((r) => r[0])).toEqual(['TM01']);
    const byDate = runs(await report(s.hr, 'ABSCONDING_REPORT', { ...period, departmentId: s.abs, minimumDays: 1, sort: 'fromDate' }));
    expect(byDate.map((r) => `${r[0]} ${r[1]}`)).toEqual(['AB01 2026-03-02', 'TM01 2026-03-02', 'JN01 2026-03-05', 'AB01 2026-03-06', 'JN01 2026-03-11', 'SU01 2026-03-11']);
    // A run is cut at the period's edge.
    expect(runs(await report(s.hr, 'ABSCONDING_REPORT', { from: '2026-03-04', to: '2026-03-09', employeeId: s.ids.TM01, minimumDays: 1 }))).toEqual([['TM01', '2026-03-04', '2026-03-09', '4', '6']]);
  });

  it('BR-026: a manager sees only their team; the run length is required and the sort is the report’s own', async () => {
    expect(runs(await report(s.manager, 'ABSCONDING_REPORT', { ...period, minimumDays: 1 }))).toEqual([['TM01', '2026-03-02', '2026-03-11', '7', '10']]);
    expect((await requested(s.hr, 'ABSCONDING_REPORT', period)).json().error).toBe('MINIMUM_DAYS_REQUIRED');
    expect((await requested(s.hr, 'ABSCONDING_REPORT', { ...period, minimumDays: 1, sort: 'joiningDate' })).json().error).toBe('FILTER_NOT_SUPPORTED');
    expect((await requested(s.hr, 'SHIFT_PUNCH_REGISTER', { ...period, sort: 'fromDate' })).json().error).toBe('FILTER_NOT_SUPPORTED');
  });
});
