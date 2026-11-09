// FR-020 acceptance over HTTP on an overnight shift (DF05: it belongs to the date of its start; a punch instant keeps its
// offset): the company-timezone conversion and the shift's capture window (four hours each side) at their edges, and the
// threshold, grace and early-departure vectors through the real import and processing. Synthetic data only. Their owner
// approval is a separate sign-off.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let nightShift: string;

// 2026-03-02 is a Monday; each describe uses its own week. Asia/Kolkata is UTC+05:30.
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const local = (d: string, hhmm: string) => `${d}T${hhmm}:00+05:30`;

async function nightWorker(): Promise<{ id: string; code: string }> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId: nightShift, effectiveFrom: '2026-01-05' });
  return { id: e.id, code: e.employeeCode };
}

async function punches(employeeCode: string, list: [string, 'IN' | 'OUT'][]) {
  const res = await h.call(hr, 'POST', '/v1/attendance/punches', { punches: list.map(([occurredAt, direction]) => ({ employeeCode, occurredAt, direction, externalEventKey: uniq('evt-') })) });
  expect(res.json().accepted, res.body).toBe(list.length);
}

/** One night worker per case: their punches for `day`, processed once for all, then each record read back. */
async function evaluateNight(day: string, cases: { name: string; punches: (d: string, next: string) => [string, 'IN' | 'OUT'][] }[]) {
  const next = nextDay(day);
  const workers = [];
  for (const c of cases) {
    const w = await nightWorker();
    await punches(w.code, c.punches(day, next));
    workers.push({ name: c.name, ...w });
  }
  await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: day });
  const out: Record<string, { status: string; workedMinutes: number; late: boolean; earlyDeparture: boolean; exceptionCode: string | null; scheduledNetMinutes: number }> = {};
  for (const w of workers) out[w.name] = (await h.call(hr, 'GET', `/v1/employees/${w.id}/attendance?from=${day}&to=${day}`)).json().items[0];
  return out;
}

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  // 22:00-06:00 with a 30-minute break at 02:00: 450 net minutes.
  nightShift = (await h.call(hr, 'POST', '/v1/shifts', { code: 'NIGHT', name: 'Night', inTime: '22:00', outTime: '06:00', bufferMinutes: 240, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 270 }] })).json().id;
  const policy = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items[0];
  expect((await h.call(hr, 'POST', `/v1/attendance/policies/${policy.id}/activate`, { expectedVersion: policy.version })).statusCode).toBe(200);
});

afterAll(async () => {
  await h?.stop();
});

describe('thresholds, grace and early departure across midnight (FR-020)', () => {
  it('below, at and above each threshold, with minutes after midnight', async () => {
    const r = await evaluateNight('2026-03-02', [
      // 75% of 450 falls between 337 and 338: 22:00 to 04:07 holds 367 minutes, less the break.
      { name: 'present-below', punches: (d, n) => [[local(d, '22:00'), 'IN'], [local(n, '04:07'), 'OUT']] },
      { name: 'present-above', punches: (d, n) => [[local(d, '22:00'), 'IN'], [local(n, '04:08'), 'OUT']] },
      // 50% of 450 is exactly 225: 22:00 to 01:45.
      { name: 'half-below', punches: (d, n) => [[local(d, '22:00'), 'IN'], [local(n, '01:44'), 'OUT']] },
      { name: 'half-at', punches: (d, n) => [[local(d, '22:00'), 'IN'], [local(n, '01:45'), 'OUT']] },
      { name: 'half-above', punches: (d, n) => [[local(d, '22:00'), 'IN'], [local(n, '01:46'), 'OUT']] },
      // Grace is inclusive.
      { name: 'grace-at', punches: (d, n) => [[local(d, '22:10'), 'IN'], [local(n, '06:00'), 'OUT']] },
      { name: 'grace-above', punches: (d, n) => [[local(d, '22:11'), 'IN'], [local(n, '06:00'), 'OUT']] },
      // The last OUT against 06:00 the next day.
      { name: 'early', punches: (d, n) => [[local(d, '22:00'), 'IN'], [local(n, '05:59'), 'OUT']] },
      { name: 'on-time', punches: (d, n) => [[local(d, '22:00'), 'IN'], [local(n, '06:00'), 'OUT']] },
    ]);
    expect(r['present-below']).toMatchObject({ workedMinutes: 337, status: 'HALF_DAY', scheduledNetMinutes: 450 });
    expect(r['present-above']).toMatchObject({ workedMinutes: 338, status: 'PRESENT' });
    expect(r['half-below']).toMatchObject({ workedMinutes: 224, status: 'ABSENT' });
    expect(r['half-at']).toMatchObject({ workedMinutes: 225, status: 'HALF_DAY' });
    expect(r['half-above']).toMatchObject({ workedMinutes: 226, status: 'HALF_DAY' });
    expect(r['grace-at']).toMatchObject({ late: false, earlyDeparture: false, status: 'PRESENT' });
    expect(r['grace-above']).toMatchObject({ late: true, earlyDeparture: false, status: 'PRESENT' });
    expect(r['early']).toMatchObject({ late: false, earlyDeparture: true, status: 'PRESENT' });
    expect(r['on-time']).toMatchObject({ workedMinutes: 450, late: false, earlyDeparture: false, status: 'PRESENT' });
  });

  it('a punch keeps its instant, whatever offset it was recorded in', async () => {
    const r = await evaluateNight('2026-03-09', [
      // 22:00 and 06:00 in Kolkata, recorded in UTC and in Dubai time.
      { name: 'utc', punches: () => [['2026-03-09T16:30:00Z', 'IN'], ['2026-03-10T00:30:00Z', 'OUT']] },
      { name: 'dubai', punches: () => [['2026-03-09T20:30:00+04:00', 'IN'], ['2026-03-10T04:30:00+04:00', 'OUT']] },
    ]);
    expect(r['utc']).toMatchObject({ workedMinutes: 450, status: 'PRESENT', late: false, earlyDeparture: false });
    expect(r['dubai']).toMatchObject({ workedMinutes: 450, status: 'PRESENT', late: false, earlyDeparture: false });
  });
});

describe('the capture window of an overnight shift, at its edges (FR-020, DF05)', () => {
  it('opens four hours before the start and closes four hours after the end, that end excluded', async () => {
    const r = await evaluateNight('2026-03-16', [
      { name: 'in-at-open', punches: (d, n) => [[local(d, '18:00'), 'IN'], [local(n, '06:00'), 'OUT']] },
      { name: 'in-before-open', punches: (d, n) => [[local(d, '17:59'), 'IN'], [local(n, '06:00'), 'OUT']] },
      { name: 'out-last-minute', punches: (d, n) => [[local(d, '22:00'), 'IN'], [local(n, '09:59'), 'OUT']] },
      { name: 'out-at-close', punches: (d, n) => [[local(d, '22:00'), 'IN'], [local(n, '10:00'), 'OUT']] },
    ]);
    // 18:00 to 06:00 is 720 minutes, less the break.
    expect(r['in-at-open']).toMatchObject({ workedMinutes: 690, status: 'PRESENT' });
    expect(r['in-before-open']).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_IN_PUNCH' });
    expect(r['out-last-minute']).toMatchObject({ status: 'PRESENT', earlyDeparture: false });
    expect(r['out-at-close']).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH' });
  });

  it('a missing OUT after midnight is an exception on the start date, and the next night stays its own', async () => {
    const w = await nightWorker();
    const [mon, tue, wed] = ['2026-03-23', '2026-03-24', '2026-03-25'];
    await punches(w.code, [[local(mon, '22:00'), 'IN']]);
    await punches(w.code, [[local(tue, '22:00'), 'IN'], [local(wed, '06:00'), 'OUT']]);
    await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: mon });
    await h.runBulkJob(hr, '/v1/attendance/processing', { workDate: tue });
    const record = async (d: string) => (await h.call(hr, 'GET', `/v1/employees/${w.id}/attendance?from=${d}&to=${d}`)).json().items[0];
    expect(await record(mon)).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH', workedMinutes: 0 });
    expect(await record(tue)).toMatchObject({ status: 'PRESENT', workedMinutes: 450 });
  });
});
