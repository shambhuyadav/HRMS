// Saturday-working patterns and half weekly-offs over HTTP (FR-005 "weekly-off patterns"; E05 half weekly-off; FR-020;
// FR-024; DF05 "Monday-Friday workdays"), decided under owner delegation, 6 Nov 2026 (owner chose process rules only;
// I-78 item 4). A pattern entry may make the nth occurrence of a weekday in the month a whole day off (the 2nd and 4th
// Saturdays) or a half weekly-off: a working day for every count, which attendance measures against the first half of the
// shift. Synthetic data; March 2026 has Saturdays on the 7th (1st), 14th (2nd), 21st (3rd) and 28th (4th).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let shiftId: string;

const PATTERN = { offDays: [7], offOccurrences: [{ weekday: 6, weeks: [2, 4] }], halfOff: [{ weekday: 6, weeks: [1, 3, 5] }] };
const local = (d: string, hhmm: string) => `${d}T${hhmm}:00+05:30`;

const location = async () => (await h.one<{ id: string }>(`insert into location (company_id, code, name, active) values ($1, $2, 'Synthetic site', true) returning id`, [A.id, uniq('L').toUpperCase()])).id;
const post = (locationId: string, body: object = {}) =>
  h.call(hr, 'POST', '/v1/weekly-off-patterns', { locationId, effectiveFrom: '2026-03-01', reason: 'Alternate Saturdays (synthetic)', expectedRevision: 0, ...PATTERN, ...body });
const worker = async (locationId: string) => {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A, { locationId }))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' })).statusCode).toBeLessThan(300);
  return { id: e.id as string, code: e.employeeCode as string };
};
const punches = async (code: string, list: [string, 'IN' | 'OUT'][]) => {
  const res = await h.call(hr, 'POST', '/v1/attendance/punches', { punches: list.map(([occurredAt, direction]) => ({ employeeCode: code, occurredAt, direction, externalEventKey: uniq('evt-') })) });
  expect(res.json().accepted, res.body).toBe(list.length);
};
const recordOn = async (employeeId: string, d: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${d}&to=${d}`)).json().items[0];

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  await h.db.query(`insert into workflow_fallback_reviewer (company_id, kind, user_id, priority, active) values ($1, 'leave_request', $2, 1, true)`, [A.id, hr.user]);
  shiftId = (await h.call(hr, 'POST', '/v1/shifts', { code: 'DAY', name: 'Day', inTime: '09:00', outTime: '18:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
  for (const p of (await h.call(hr, 'GET', '/v1/leave/policies')).json().items as { id: string; version: number }[]) {
    await h.call(hr, 'POST', `/v1/leave/policies/${p.id}/activate`, { expectedVersion: p.version });
  }
});

afterAll(async () => {
  await h?.stop();
});

describe('FR-005 occurrences of a weekday in the month (I-48 item 6; I-78 item 4)', () => {
  it('FR-005 a pattern names whole Saturdays off by occurrence and half weekly-offs; the calendar lists both', async () => {
    const site = await location();
    const res = await post(site);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ revision: 1, ...PATTERN });
    const calendar = ((await h.call(hr, 'GET', '/v1/weekly-off-patterns')).json().items as { locationId: string; inForce: object; entries: object[] }[]).find((c) => c.locationId === site)!;
    expect(calendar.inForce).toMatchObject({ ...PATTERN, isDefault: false, revision: 1 });
    expect(calendar.entries[0]).toMatchObject(PATTERN);
    const stored = await h.one<{ off_occurrences: number[]; half_off: number[] }>(`select off_occurrences, half_off from weekly_off_pattern where id = $1`, [res.json().id]);
    expect(stored).toEqual({ off_occurrences: [62, 64], half_off: [61, 63, 65] });
    // The default location shows no occurrences.
    const def = ((await h.call(hr, 'GET', '/v1/weekly-off-patterns')).json().items as { locationId: string; inForce: object }[]).find((c) => c.locationId === A.loc)!;
    expect(def.inForce).toMatchObject({ offDays: [6, 7], offOccurrences: [], halfOff: [], isDefault: true });
  });

  it('FR-005 refuses a weekday named twice, one already off every week, a day both whole and half, and weeks outside 1 to 5', async () => {
    const site = await location();
    const refusal = async (body: object) => {
      const res = await post(site, body);
      return [res.statusCode, res.json().error];
    };
    expect(await refusal({ offOccurrences: [{ weekday: 7, weeks: [1] }] })).toEqual([422, 'INVALID_PATTERN']);
    expect(await refusal({ halfOff: [{ weekday: 6, weeks: [2] }] })).toEqual([422, 'INVALID_PATTERN']);
    expect(await refusal({ offOccurrences: [{ weekday: 6, weeks: [2] }, { weekday: 6, weeks: [4] }] })).toEqual([422, 'INVALID_PATTERN']);
    expect((await post(site, { halfOff: [{ weekday: 6, weeks: [6] }] })).statusCode).toBe(400);
    expect((await post(site, { halfOff: [{ weekday: 6, weeks: [] }] })).statusCode).toBe(400);
    expect((await post(site, { halfOff: [{ weekday: 8, weeks: [1] }] })).statusCode).toBe(400);
    // The database holds the same rules for any other path.
    const insert = (offDays: number[], occurrences: number[], half: number[]) =>
      h.db.query(`insert into weekly_off_pattern (company_id, location_id, revision, effective_from, off_days, off_occurrences, half_off, reason) values ($1, $2, 9, '2030-01-01', $3, $4, $5, 'x')`, [
        A.id,
        site,
        offDays,
        occurrences,
        half,
      ]);
    await expect(insert([7], [72], [])).rejects.toThrow(/weekly_off_pattern_occurrences_valid/);
    await expect(insert([7], [66], [])).rejects.toThrow(/weekly_off_pattern_occurrences_valid/);
    await expect(insert([7], [64, 62], [])).rejects.toThrow(/weekly_off_pattern_occurrences_valid/);
    await expect(insert([7], [62], [62])).rejects.toThrow(/weekly_off_pattern_half_off_valid/);
    await expect(insert([6, 7], [], [61])).rejects.toThrow(/weekly_off_pattern_half_off_valid/);
  });
});

describe('FR-020 FR-024 the occurrences in attendance and leave (I-78 item 4)', () => {
  it('FR-020 a 2nd Saturday is a weekly off; a 1st and 3rd Saturday are measured against half the shift', async () => {
    const site = await location();
    expect((await post(site)).statusCode).toBe(201);
    const [atThreshold, below, absent, offDay, third] = [await worker(site), await worker(site), await worker(site), await worker(site), await worker(site)];
    // Half of 480 net minutes is 240 (09:00-13:00); 75% of it is 180.
    await punches(atThreshold.code, [
      [local('2026-03-07', '09:00'), 'IN'],
      [local('2026-03-07', '12:00'), 'OUT'],
    ]);
    await punches(below.code, [
      [local('2026-03-07', '09:00'), 'IN'],
      [local('2026-03-07', '11:59'), 'OUT'],
    ]);
    await punches(offDay.code, [
      [local('2026-03-14', '09:00'), 'IN'],
      [local('2026-03-14', '13:00'), 'OUT'],
    ]);
    await punches(third.code, [
      [local('2026-03-21', '09:00'), 'IN'],
      [local('2026-03-21', '13:00'), 'OUT'],
    ]);
    for (const d of ['2026-03-07', '2026-03-14', '2026-03-21']) await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: d });
    expect(await recordOn(atThreshold.id, '2026-03-07')).toMatchObject({ status: 'PRESENT', workedMinutes: 180, scheduledNetMinutes: 240, earlyDeparture: true });
    expect(await recordOn(below.id, '2026-03-07')).toMatchObject({ status: 'HALF_DAY', workedMinutes: 179 });
    expect(await recordOn(absent.id, '2026-03-07')).toMatchObject({ status: 'HALF_DAY', workedMinutes: 0 });
    expect(await recordOn(offDay.id, '2026-03-14')).toMatchObject({ status: 'WEEKLY_OFF' });
    expect(await recordOn(third.id, '2026-03-21')).toMatchObject({ status: 'PRESENT', workedMinutes: 240, earlyDeparture: false });

    // A later entry changing the Saturdays lists the evaluated Saturdays it reaches for reprocessing.
    const changed = await post(site, { offOccurrences: [], halfOff: [], offDays: [6, 7], expectedRevision: 1, reason: 'Back to five days (synthetic)' });
    expect(changed.statusCode, changed.body).toBe(201);
    expect((changed.json().reprocess.days as { workDate: string }[]).map((d) => d.workDate)).toEqual(['2026-03-07', '2026-03-14', '2026-03-21']);
  });

  it('FR-024 leave counts a whole occurrence as off and a half weekly-off as a working day', async () => {
    const site = await location();
    expect((await post(site)).statusCode).toBe(201);
    const e = await worker(site);
    const actor = await h.actor(A, 'EMPLOYEE', { employeeId: e.id });
    const request = (startDate: string, endDate: string) => h.call(actor, 'POST', '/v1/leave/requests', { leaveType: 'UNPAID', startDate, endDate });
    // Friday 13 to Monday 16: the 2nd Saturday and the Sunday are off.
    const second = await request('2026-03-13', '2026-03-16');
    expect(second.statusCode, second.body).toBe(201);
    expect(second.json().units).toBe('2');
    // Friday 6 to Monday 9: the 1st Saturday is a half weekly-off, still one working day for leave and payroll.
    const first = await request('2026-03-06', '2026-03-09');
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().units).toBe('3');
    // The 4th Saturday alone holds no working day.
    expect((await request('2026-03-28', '2026-03-28')).json().error).toBe('NO_WORKING_DAYS');
  });
});
