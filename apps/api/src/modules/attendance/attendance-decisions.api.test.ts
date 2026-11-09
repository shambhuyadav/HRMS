// FR-005, BR-008, FR-020, E07 and DF05 over HTTP: the rules decided under owner delegation, 6 Nov 2026 (owner chose process
// rules only; I-78 items 1, 2, 5 and 6). The shift buffer is the punch capture window and the 24-hour-cycle indicator is
// the overnight flag; the next-day out-time rule of in/out rows; overtime candidates and late minutes on the evaluated day
// and as the E07 entity of the minute filter. Vectors one minute below, at and above each edge, across midnight and with
// missing punches; their owner sign-off stays pending review. Synthetic data only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uniq } from '../../../../../db/tests/fixtures.js';
import { type Company, type Harness, startHarness, type TestActor } from '../../test/harness.js';

let h: Harness;
let A: Company;
let hr: TestActor;
let activator: TestActor;
let dayShift: string;
let nightShift: string;
let otPolicy: { id: string; version: number };

// 2026-03-02 is a Monday; Asia/Kolkata is UTC+05:30. Each test uses its own dates.
const local = (d: string, hhmm: string) => `${d}T${hhmm}:00+05:30`;
const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const utc = (d: string, hhmm: string) => new Date(Date.parse(local(d, hhmm))).toISOString();
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

interface DayRecord {
  id: string;
  status: string;
  workedMinutes: number;
  scheduledNetMinutes: number;
  late: boolean;
  lateMinutes: number | null;
  earlyDeparture: boolean;
  overtimeCandidateMinutes: number | null;
  exceptionCode: string | null;
}

async function worker(shiftId: string | null): Promise<{ id: string; code: string }> {
  const e = (await h.call(hr, 'POST', '/v1/employees', h.newEmployeeBody(A))).json();
  await h.setStatus(A, e.id, 'ACTIVE_CONFIRMED');
  if (shiftId) expect((await h.call(hr, 'POST', `/v1/employees/${e.id}/shift`, { shiftId, effectiveFrom: '2026-01-05' })).statusCode).toBe(200);
  return { id: e.id, code: e.employeeCode };
}

async function punches(code: string, list: [string, 'IN' | 'OUT'][]) {
  const res = await h.call(hr, 'POST', '/v1/attendance/punches', { punches: list.map(([occurredAt, direction]) => ({ employeeCode: code, occurredAt, direction, externalEventKey: uniq('evt-') })) });
  expect(res.json().accepted, res.body).toBe(list.length);
}

const process = (workDate: string) => h.runBulkJob(hr, '/v1/attendance/processing', { workDate });
const recordOf = async (employeeId: string, d: string) => (await h.call(hr, 'GET', `/v1/employees/${employeeId}/attendance?from=${d}&to=${d}`)).json().items[0] as DayRecord | undefined;
const storedPunches = async (employeeId: string, from: string, to: string) =>
  ((await h.call(hr, 'GET', `/v1/employees/${employeeId}/punches?from=${from}&to=${to}`)).json().items as { occurredAt: string; direction: string }[]).map((p) => [
    p.direction,
    new Date(p.occurredAt).toISOString(),
  ]);

async function inOutRows(rows: string[]) {
  const text = ['employeeCode,workDate,inTime,outTime', ...rows].join('\r\n');
  const res = await h.call(hr, 'POST', '/v1/attendance/in-out-imports', { fileName: 'in-out.csv', contentBase64: b64(text), idempotencyKey: uniq('in-out-key-') });
  expect(res.statusCode, res.body).toBe(201);
  const job = res.json() as { id: string; rows: { state: string; errorCode: string | null }[] };
  const done = await h.call(hr, 'POST', `/v1/attendance/in-out-imports/${job.id}/commit`);
  expect(done.statusCode, done.body).toBe(200);
  return (done.json() as { rows: { state: string; errorCode: string | null }[] }).rows.map((r) => [r.state, r.errorCode]);
}

const newShift = (body: Record<string, unknown>) => h.call(hr, 'POST', '/v1/shifts', { code: uniq('S').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30), name: 'Synthetic', breaks: [], ...body });

beforeAll(async () => {
  h = await startHarness();
  A = await h.makeCompany();
  hr = await h.actor(A, 'HR_ADMINISTRATOR');
  activator = await h.actor(A, 'HR_ADMINISTRATOR');
  // One-hour buffers, so the capture window edges are easy to name.
  dayShift = (await newShift({ code: 'DAY', inTime: '09:00', outTime: '18:00', bufferMinutes: 60, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 300 }] })).json().id;
  nightShift = (await newShift({ code: 'NIGHT', inTime: '22:00', outTime: '06:00', bufferMinutes: 60, breaks: [{ startOffsetMinutes: 240, endOffsetMinutes: 270 }] })).json().id;
  // A site policy with overtime rules, more specific than the company-wide default: synthetic values, not a proposal.
  const created = await h.call(hr, 'POST', '/v1/attendance/policies', {
    code: 'OT_SITE',
    effectiveFrom: '2026-01-01',
    graceMinutes: 10,
    presentPercent: '75',
    halfDayPercent: '50',
    overtimeEnabled: true,
    overtimeBasis: 'AFTER_SHIFT_END',
    overtimeMinimumMinutes: 30,
    overtimeRoundingMinutes: 15,
  });
  expect(created.statusCode, created.body).toBe(201);
  const mapped = await h.call(hr, 'POST', `/v1/attendance/policies/${created.json().id}/mappings`, { expectedVersion: created.json().version, locationId: A.loc });
  expect(mapped.statusCode, mapped.body).toBe(201);
  const activated = await h.call(activator, 'POST', `/v1/attendance/policies/${created.json().id}/activate`, { expectedVersion: mapped.json().policyVersion });
  expect(activated.statusCode, activated.body).toBe(200);
  otPolicy = { id: created.json().id, version: mapped.json().policyVersion + 1 };
});

afterAll(async () => {
  await h?.stop();
});

describe('FR-005 BR-008 the shift buffer (I-78 item 1)', () => {
  it('FR-005 BR-008 a new shift states its buffer, and a 9-hour shift takes at most 450 minutes each side', async () => {
    expect((await newShift({ inTime: '09:00', outTime: '18:00' })).statusCode).toBe(400);
    expect((await newShift({ inTime: '09:00', outTime: '18:00', bufferMinutes: 449 })).statusCode).toBe(201);
    const atEdge = await newShift({ inTime: '09:00', outTime: '18:00', bufferMinutes: 450 });
    expect(atEdge.statusCode, atEdge.body).toBe(201);
    expect(atEdge.json()).toMatchObject({ bufferMinutes: 450, scheduledMinutes: 540, revisions: [{ revision: 1, bufferMinutes: 450 }] });
    const above = await newShift({ inTime: '09:00', outTime: '18:00', bufferMinutes: 451 });
    expect(above.statusCode).toBe(422);
    expect(above.json()).toMatchObject({ error: 'BUFFER_OUT_OF_RANGE', details: { maxBufferMinutes: 450 } });
  });

  it('BR-008 the database keeps the windows of consecutive days apart and the first revision\'s buffer fixed', async () => {
    const insert = (buffer: number) =>
      h.db.query(`insert into shift (company_id, code, name, in_time, out_time, spans_midnight, buffer_minutes, active) values ($1, $2, 'x', '09:00', '18:00', false, $3, true)`, [
        A.id,
        uniq('DB').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30),
        buffer,
      ]);
    await expect(insert(451)).rejects.toThrow(/shift_buffer_fits/);
    await expect(insert(-1)).rejects.toThrow(/shift_buffer_fits/);
    await insert(450);
    await expect(h.db.query(`update shift set buffer_minutes = 30 where id = $1`, [dayShift])).rejects.toThrow(/dated revision/);
    await expect(
      h.db.query(`insert into shift_revision (company_id, shift_id, revision, effective_from, in_time, out_time, spans_midnight, buffer_minutes, reason) values ($1, $2, 90, '2030-01-01', '09:00', '18:00', false, 451, 'x')`, [
        A.id,
        dayShift,
      ]),
    ).rejects.toThrow(/shift_revision_buffer_fits/);
  });

  it('BR-008 a revision keeps the buffer in force unless it names one, and refuses one that no longer fits', async () => {
    const shift = (await newShift({ inTime: '09:00', outTime: '18:00', bufferMinutes: 120 })).json();
    const revise = (version: number, body: Record<string, unknown>) =>
      h.call(hr, 'POST', `/v1/shifts/${shift.id}/revisions`, { expectedVersion: version, breaks: [], reason: 'Synthetic revision', ...body });
    const kept = await revise(shift.version, { effectiveFrom: '2026-04-01', inTime: '08:00', outTime: '17:00' });
    expect(kept.statusCode, kept.body).toBe(201);
    expect(kept.json().revisions[1]).toMatchObject({ revision: 2, bufferMinutes: 120 });
    // 05:00 to 02:00 is 1,260 minutes: 120 each side no longer fits, 90 does exactly.
    const tooLong = await revise(kept.json().version, { effectiveFrom: '2026-05-01', inTime: '05:00', outTime: '02:00' });
    expect(tooLong.json()).toMatchObject({ error: 'BUFFER_OUT_OF_RANGE', details: { maxBufferMinutes: 90 } });
    const named = await revise(kept.json().version, { effectiveFrom: '2026-05-01', inTime: '05:00', outTime: '02:00', bufferMinutes: 90 });
    expect(named.statusCode, named.body).toBe(201);
    expect(named.json().revisions[2]).toMatchObject({ revision: 3, bufferMinutes: 90, spansMidnight: true, scheduledMinutes: 1260 });
  });

  it('BR-008 FR-005 the 24-hour-cycle indicator is the overnight flag, derived from the times; a 24-hour shift is refused', async () => {
    const shifts = (await h.call(hr, 'GET', '/v1/shifts')).json().items as { id: string; spansMidnight: boolean; scheduledMinutes: number }[];
    expect(shifts.find((s) => s.id === nightShift)).toMatchObject({ spansMidnight: true, scheduledMinutes: 480 });
    expect(shifts.find((s) => s.id === dayShift)).toMatchObject({ spansMidnight: false, scheduledMinutes: 540 });
    expect((await newShift({ inTime: '08:00', outTime: '08:00', bufferMinutes: 0 })).statusCode).toBe(422);
    // A value disagreeing with the clock times cannot be stored.
    await expect(
      h.db.query(`insert into shift (company_id, code, name, in_time, out_time, spans_midnight, buffer_minutes, active) values ($1, 'FLAG', 'x', '09:00', '18:00', true, 0, true)`, [A.id]),
    ).rejects.toThrow(/check constraint/);
  });

  it('FR-020 BR-008 a punch belongs to the night only inside its buffer: 20:59 is outside, 21:00 inside, 06:59 inside, 07:00 outside', async () => {
    const d = '2026-03-02';
    const n = nextDay(d);
    const cases = [
      ['in-outside', [[local(d, '20:59'), 'IN'], [local(n, '06:00'), 'OUT']]],
      ['in-at-edge', [[local(d, '21:00'), 'IN'], [local(n, '06:00'), 'OUT']]],
      ['out-inside', [[local(d, '22:00'), 'IN'], [local(n, '06:59'), 'OUT']]],
      ['out-at-close', [[local(d, '22:00'), 'IN'], [local(n, '07:00'), 'OUT']]],
    ] as const;
    const people: Record<string, string> = {};
    for (const [name, list] of cases) {
      const w = await worker(nightShift);
      await punches(w.code, list as unknown as [string, 'IN' | 'OUT'][]);
      people[name] = w.id;
    }
    await process(d);
    expect(await recordOf(people['in-outside']!, d)).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_IN_PUNCH' });
    // 21:00 to 06:00 is 540 minutes, less the 30-minute break.
    expect(await recordOf(people['in-at-edge']!, d)).toMatchObject({ status: 'PRESENT', workedMinutes: 510 });
    expect(await recordOf(people['out-inside']!, d)).toMatchObject({ status: 'PRESENT', workedMinutes: 509 });
    expect(await recordOf(people['out-at-close']!, d)).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH' });
    // The day view reads the same window and names the buffer it used.
    const view = (await h.call(hr, 'GET', `/v1/attendance/records/${(await recordOf(people['in-outside']!, d))!.id}/day`)).json();
    expect(view.derived).toMatchObject({ bufferMinutes: 60, shiftCode: 'NIGHT' });
    expect(view.punches.map((p: { direction: string }) => p.direction)).toEqual(['OUT']);
  });
});

describe('FR-020 the next-day out-time rule of in/out rows (I-78 item 2)', () => {
  it('FR-020 an out time one minute before the in time is the next day; equal is refused; one minute after is the same day', async () => {
    const d = '2026-03-09';
    const [before, equal, after] = [await worker(nightShift), await worker(nightShift), await worker(nightShift)];
    expect(await inOutRows([`${before.code},${d},22:00,21:59`, `${equal.code},${d},22:00,22:00`, `${after.code},${d},22:00,22:01`])).toEqual([
      ['ACCEPTED', null],
      ['QUARANTINED', 'ZERO_DURATION'],
      ['ACCEPTED', null],
    ]);
    expect(await storedPunches(before.id, d, nextDay(d))).toEqual([
      ['IN', utc(d, '22:00')],
      ['OUT', utc(nextDay(d), '21:59')],
    ]);
    expect(await storedPunches(after.id, d, nextDay(d))).toEqual([
      ['IN', utc(d, '22:00')],
      ['OUT', utc(d, '22:01')],
    ]);
  });

  it('FR-020 a time given alone, or an in time after midnight, lies in the capture window of the work date\'s shift', async () => {
    const d = '2026-03-10';
    const n = nextDay(d);
    const [outOnly, lateIn, inOnly, dayOut, dayLate, noShift] = [
      await worker(nightShift),
      await worker(nightShift),
      await worker(nightShift),
      await worker(dayShift),
      await worker(dayShift),
      await worker(null),
    ];
    expect(
      await inOutRows([`${outOnly.code},${d},,06:00`, `${lateIn.code},${d},00:30,06:00`, `${inOnly.code},${d},22:00,`, `${dayOut.code},${d},,18:00`, `${dayLate.code},${d},23:30,`, `${noShift.code},${d},22:00,06:00`]),
    ).toEqual(Array(6).fill(['ACCEPTED', null]));
    expect(await storedPunches(outOnly.id, d, n)).toEqual([['OUT', utc(n, '06:00')]]);
    expect(await storedPunches(lateIn.id, d, n)).toEqual([
      ['IN', utc(n, '00:30')],
      ['OUT', utc(n, '06:00')],
    ]);
    expect(await storedPunches(inOnly.id, d, n)).toEqual([['IN', utc(d, '22:00')]]);
    expect(await storedPunches(dayOut.id, d, n)).toEqual([['OUT', utc(d, '18:00')]]);
    // Outside every window of the day shift: the work date, where evaluation reports it.
    expect(await storedPunches(dayLate.id, d, n)).toEqual([['IN', utc(d, '23:30')]]);
    // Without a shift, the row alone decides: the out time before the in time is the next day.
    expect(await storedPunches(noShift.id, d, n)).toEqual([
      ['IN', utc(d, '22:00')],
      ['OUT', utc(n, '06:00')],
    ]);

    // Missing punches and midnight crossings evaluate on the shift's start date only.
    await process(d);
    expect(await recordOf(outOnly.id, d)).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_IN_PUNCH', workedMinutes: 0 });
    // 00:30 to 06:00 is 330 minutes less the break: 300, below 75% of 450; 150 minutes late.
    expect(await recordOf(lateIn.id, d)).toMatchObject({ status: 'HALF_DAY', workedMinutes: 300, late: true, lateMinutes: 150 });
    expect(await recordOf(inOnly.id, d)).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH' });
    expect(await recordOf(dayOut.id, d)).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_IN_PUNCH' });
    expect(await recordOf(dayLate.id, d)).toMatchObject({ status: 'ABSENT', workedMinutes: 0 });
    // The previous night of the OUT-only worker does not take the next morning's OUT.
    const previous = '2026-03-09';
    await process(previous);
    expect(await recordOf(outOnly.id, previous)).toMatchObject({ status: 'ABSENT' });
  });
});

describe('FR-020 DF05 overtime candidates and E07 late minutes on the evaluated day (I-78 items 5, 6)', () => {
  it('FR-020 DF05 overtime rules are all or nothing, required to activate, and frozen with the revision', async () => {
    const base = { code: 'OT_RULES', effectiveFrom: '2027-01-01', graceMinutes: 10, presentPercent: '75', halfDayPercent: '50' };
    expect((await h.call(hr, 'POST', '/v1/attendance/policies', { ...base, overtimeEnabled: true })).json().error).toBe('OVERTIME_RULES_REQUIRED');
    expect((await h.call(hr, 'POST', '/v1/attendance/policies', { ...base, overtimeEnabled: true, overtimeBasis: 'AFTER_SHIFT_END', overtimeMinimumMinutes: 30 })).json().error).toBe(
      'OVERTIME_RULES_REQUIRED',
    );
    expect((await h.call(hr, 'POST', '/v1/attendance/policies', { ...base, overtimeEnabled: false, overtimeBasis: 'AFTER_SHIFT_END', overtimeMinimumMinutes: 0, overtimeRoundingMinutes: 1 })).json().error).toBe(
      'OVERTIME_RULES_NOT_ALLOWED',
    );
    // A rounding unit of zero is no unit: refused, never a division by zero.
    expect((await h.call(hr, 'POST', '/v1/attendance/policies', { ...base, overtimeEnabled: true, overtimeBasis: 'AFTER_SHIFT_END', overtimeMinimumMinutes: 0, overtimeRoundingMinutes: 0 })).statusCode).toBe(400);
    expect((await h.call(hr, 'POST', '/v1/attendance/policies', { ...base, overtimeEnabled: true, overtimeBasis: 'AFTER_SHIFT_END', overtimeMinimumMinutes: 0, overtimeRoundingMinutes: 1441 })).statusCode).toBe(400);
    // Turning overtime off on a draft clears its rules.
    const draft = await h.call(hr, 'POST', '/v1/attendance/policies', { ...base, overtimeEnabled: true, overtimeBasis: 'BEYOND_SCHEDULED_NET', overtimeMinimumMinutes: 0, overtimeRoundingMinutes: 1 });
    expect(draft.statusCode, draft.body).toBe(201);
    expect((await h.call(hr, 'PATCH', `/v1/attendance/policies/${draft.json().id}`, { expectedVersion: draft.json().version, overtimeEnabled: false })).statusCode).toBe(200);
    const list = (await h.call(hr, 'GET', '/v1/attendance/policies')).json().items as { id: string; overtimeBasis: string | null; overtimeEnabled: boolean }[];
    expect(list.find((p) => p.id === draft.json().id)).toMatchObject({ overtimeEnabled: false, overtimeBasis: null });

    // The database: all three or none, never without the setting, and no activation without them.
    await expect(h.db.query(`update attendance_policy set overtime_basis = 'AFTER_SHIFT_END' where id = $1`, [draft.json().id])).rejects.toThrow(/attendance_policy_overtime_settings/);
    await h.db.query(`update attendance_policy set overtime_enabled = true where id = $1`, [draft.json().id]);
    await expect(h.db.query(`update attendance_policy set state = 'ACTIVE', activated_by = $2, activated_at = now() where id = $1`, [draft.json().id, activator.user])).rejects.toThrow(/before activation/);
    const refused = await h.call(activator, 'POST', `/v1/attendance/policies/${draft.json().id}/activate`, { expectedVersion: draft.json().version + 2 });
    expect(refused.json().error).toBe('OVERTIME_RULES_REQUIRED');
    await expect(h.db.query(`update attendance_policy set overtime_minimum_minutes = 0 where id = $1`, [otPolicy.id])).rejects.toThrow(/immutable/);
  });

  it('FR-020 DF05 candidates after the shift end at and around the minimum and the rounding unit, stored with late minutes', async () => {
    const d = '2026-03-16';
    const outs = { below: '18:29', atMinimum: '18:30', roundedDown: '18:44', atUnit: '18:45' } as const;
    const people: Record<string, string> = {};
    for (const [name, out] of Object.entries(outs)) {
      const w = await worker(dayShift);
      await punches(w.code, [
        [local(d, name === 'below' ? '09:11' : '09:00'), 'IN'],
        [local(d, out), 'OUT'],
      ]);
      people[name] = w.id;
    }
    await process(d);
    expect(await recordOf(people.below!, d)).toMatchObject({ status: 'PRESENT', overtimeCandidateMinutes: 0, late: true, lateMinutes: 11 });
    expect(await recordOf(people.atMinimum!, d)).toMatchObject({ status: 'PRESENT', overtimeCandidateMinutes: 30, late: false, lateMinutes: 0 });
    expect(await recordOf(people.roundedDown!, d)).toMatchObject({ overtimeCandidateMinutes: 30 });
    expect(await recordOf(people.atUnit!, d)).toMatchObject({ overtimeCandidateMinutes: 45 });

    // E07: the entity of the minute comparison.
    const codesWhere = async (query: string) =>
      ((await h.call(hr, 'GET', `/v1/attendance/records?from=${d}&to=${d}&${query}`)).json().items as { employeeId: string }[]).map((r) => r.employeeId).sort();
    expect(await codesWhere('minuteField=OVERTIME_CANDIDATE&minuteOp=GTE&minuteValue=45')).toEqual([people.atUnit]);
    expect(await codesWhere('minuteField=OVERTIME_CANDIDATE&minuteOp=EQ&minuteValue=30')).toEqual([people.atMinimum, people.roundedDown].sort());
    expect(await codesWhere('minuteField=LATE&minuteOp=GT&minuteValue=10')).toEqual([people.below]);
    expect((await h.call(hr, 'GET', `/v1/attendance/records?from=${d}&to=${d}&minuteField=ENTITY&minuteOp=GT&minuteValue=1`)).statusCode).toBe(400);

    // The database: late minutes agree with the late flag, and the new values change only with their revision (0181).
    const late = (await recordOf(people.below!, d))!;
    await expect(
      h.db.query(
        `insert into attendance_record (company_id, employee_id, work_date, policy_id, scheduled_net_minutes, worked_minutes, late, early_departure, status_id, late_minutes)
         select company_id, employee_id, '2030-01-07', policy_id, 0, 0, false, false, status_id, 5 from attendance_record where id = $1`,
        [late.id],
      ),
    ).rejects.toThrow(/attendance_record_late_minutes_flag/);
    await expect(h.db.query(`update attendance_record set overtime_candidate_minutes = 999 where id = $1`, [late.id])).rejects.toThrow(/only with its revision/);
    await expect(h.db.query(`update attendance_record set late_minutes = 12 where id = $1`, [late.id])).rejects.toThrow(/only with its revision/);

    // An amendment to an outcome without candidates drops them; the replaced values stay in the history.
    const day = (await recordOf(people.atUnit!, d))!;
    const res = await h.call(hr, 'POST', `/v1/attendance/records/${day.id}/amend`, { expectedVersion: (day as unknown as { version: number }).version, status: 'HALF_DAY', reason: 'Reviewed (synthetic)' });
    expect(res.statusCode, res.body).toBe(200);
    expect(await recordOf(people.atUnit!, d)).toMatchObject({ status: 'HALF_DAY', overtimeCandidateMinutes: 0 });
    const history = (await h.call(hr, 'GET', `/v1/attendance/records/${day.id}/amendments`)).json();
    expect(history.revisions.at(-1)).toMatchObject({ cause: 'AMENDMENT', status: 'PRESENT' });
    expect((await h.one<{ m: number }>(`select overtime_candidate_minutes as m from attendance_record_revision where attendance_record_id = $1 order by prior_version desc limit 1`, [day.id])).m).toBe(45);
  });

  it('FR-020 DF05 candidates across midnight and on a weekly off; none on an exception', async () => {
    const sat = '2026-03-21';
    const fri = '2026-03-20';
    const [night, offDay, missing] = [await worker(nightShift), await worker(dayShift), await worker(dayShift)];
    // 22:00 to 06:45 the next morning (a Saturday): 45 minutes after the end.
    await punches(night.code, [
      [local(fri, '22:00'), 'IN'],
      [local(sat, '06:45'), 'OUT'],
    ]);
    // On the Saturday weekly off, every worked minute: 10:00-12:44 is 164, rounded down to 150.
    await punches(offDay.code, [
      [local(sat, '10:00'), 'IN'],
      [local(sat, '12:44'), 'OUT'],
    ]);
    await punches(missing.code, [[local(fri, '09:00'), 'IN']]);
    await process(fri);
    await process(sat);
    expect(await recordOf(night.id, fri)).toMatchObject({ status: 'PRESENT', overtimeCandidateMinutes: 45 });
    expect(await recordOf(offDay.id, sat)).toMatchObject({ status: 'WEEKLY_OFF', workedMinutes: 164, overtimeCandidateMinutes: 150 });
    expect(await recordOf(missing.id, fri)).toMatchObject({ status: 'EXCEPTION', overtimeCandidateMinutes: 0 });
  });
});
