// FR-020 acceptance across midnight: one minute below, equal to and above each threshold on an overnight shift, with
// missing punches (DF05: an overnight shift belongs to the date of its start; boundaries use exact minutes; a missing
// punch is an exception). These vectors follow the selected DF05 rules; their owner approval is a separate sign-off.
import { describe, expect, it } from 'vitest';
import { type DayInput, evaluateDay } from './evaluate.js';

const MIN = 60_000;
const start = Date.UTC(2026, 2, 2, 16, 30); // 22:00 Asia/Kolkata on a Monday; any fixed instant works
const at = (minutesFromStart: number) => start + minutesFromStart * MIN;
const policy = { graceMinutes: 10, presentPercent: 75, halfDayPercent: 50 };

// 22:00-06:00 with a 30-minute unpaid break at 02:00 (offset 240-270): net 450 minutes.
const night = { startMs: at(0), endMs: at(480), breaks: [{ startMs: at(240), endMs: at(270) }], netMinutes: 450 };
// 22:00-06:00 with no break: net 480 minutes, so each threshold falls on an exact minute.
const nightNoBreak = { startMs: at(0), endMs: at(480), breaks: [], netMinutes: 480 };

const run = (over: Partial<DayInput>) => evaluateDay({ offDay: null, leave: 'NONE', shift: night, punches: [], policy, ...over });
const inOut = (inMin: number, outMin: number) => [
  { atMs: at(inMin), direction: 'IN' as const },
  { atMs: at(outMin), direction: 'OUT' as const },
];

describe('the present threshold across midnight', () => {
  it('75% of 450 net minutes falls between 337 and 338 worked minutes (02:00 break crossed)', () => {
    // 22:00 to 04:07 is 367 minutes, less the 30-minute break.
    expect(run({ punches: inOut(0, 367) })).toMatchObject({ workedMinutes: 337, status: 'HALF_DAY', late: false, earlyDeparture: true });
    expect(run({ punches: inOut(0, 368) })).toMatchObject({ workedMinutes: 338, status: 'PRESENT', late: false, earlyDeparture: true });
  });

  it('exactly 75% of 480 net minutes is PRESENT; one minute below is not', () => {
    expect(run({ shift: nightNoBreak, punches: inOut(0, 359) })).toMatchObject({ workedMinutes: 359, status: 'HALF_DAY' });
    expect(run({ shift: nightNoBreak, punches: inOut(0, 360) })).toMatchObject({ workedMinutes: 360, status: 'PRESENT' });
    expect(run({ shift: nightNoBreak, punches: inOut(0, 361) })).toMatchObject({ workedMinutes: 361, status: 'PRESENT' });
  });
});

describe('the half-day threshold across midnight', () => {
  it('50% of 450 net minutes is exactly 225 worked minutes', () => {
    expect(run({ punches: inOut(0, 224) })).toMatchObject({ workedMinutes: 224, status: 'ABSENT' });
    expect(run({ punches: inOut(0, 225) })).toMatchObject({ workedMinutes: 225, status: 'HALF_DAY' });
    expect(run({ punches: inOut(0, 226) })).toMatchObject({ workedMinutes: 226, status: 'HALF_DAY' });
  });

  it('the same minutes counted after midnight weigh the same', () => {
    // 00:00 to 03:45 crosses the break, so it holds 195 minutes of work: below half. To 04:15 it holds 225.
    expect(run({ punches: inOut(120, 345) })).toMatchObject({ workedMinutes: 195, status: 'ABSENT' });
    expect(run({ punches: inOut(120, 375) })).toMatchObject({ workedMinutes: 225, status: 'HALF_DAY', late: true, earlyDeparture: true });
  });
});

describe('grace and early departure across midnight', () => {
  it('grace is inclusive: 22:10 is on time, 22:11 is late', () => {
    expect(run({ punches: inOut(9, 480) }).late).toBe(false);
    expect(run({ punches: inOut(10, 480) }).late).toBe(false);
    expect(run({ punches: inOut(11, 480) })).toMatchObject({ late: true, status: 'PRESENT' });
  });

  it('the last OUT is measured against 06:00 the next day: 05:59 is early, 06:00 is not', () => {
    expect(run({ punches: inOut(0, 479) })).toMatchObject({ earlyDeparture: true, status: 'PRESENT' });
    expect(run({ punches: inOut(0, 480) })).toMatchObject({ earlyDeparture: false, workedMinutes: 450, status: 'PRESENT' });
    expect(run({ punches: inOut(0, 481) })).toMatchObject({ earlyDeparture: false, workedMinutes: 451, status: 'PRESENT' });
  });

  it('a grace of zero and other configured thresholds hold across midnight too', () => {
    const strict = { graceMinutes: 0, presentPercent: 50, halfDayPercent: 25 };
    expect(run({ policy: strict, punches: inOut(0, 480) }).late).toBe(false);
    expect(run({ policy: strict, punches: inOut(1, 480) }).late).toBe(true);
    expect(run({ policy: strict, punches: inOut(0, 225) }).status).toBe('PRESENT');
    expect(run({ policy: strict, punches: inOut(0, 224) }).status).toBe('HALF_DAY');
  });
});

describe('missing and impossible punches across midnight (DF05: an exception, never absence)', () => {
  it('a missing OUT after midnight and a missing IN before it are exceptions with no worked minutes', () => {
    expect(run({ punches: [{ atMs: at(0), direction: 'IN' }] })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH', workedMinutes: 0, late: false, earlyDeparture: false });
    expect(run({ punches: [{ atMs: at(480), direction: 'OUT' }] })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_IN_PUNCH', workedMinutes: 0 });
  });

  it('a pair on each side of midnight adds up; a third punch left open is an exception', () => {
    expect(run({ punches: [...inOut(0, 120), ...inOut(150, 480)] })).toMatchObject({ workedMinutes: 420, status: 'PRESENT' });
    expect(run({ punches: [...inOut(0, 120), { atMs: at(150), direction: 'IN' }] })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH' });
  });

  it('a zero-length pair at midnight is impossible, and no punch at all is absence only after the calendar', () => {
    expect(run({ punches: inOut(120, 120) })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'INVALID_PUNCH_PAIR' });
    expect(run({ punches: [] })).toMatchObject({ status: 'ABSENT', workedMinutes: 0 });
    expect(run({ punches: [], offDay: 'HOLIDAY' }).status).toBe('HOLIDAY');
    expect(run({ punches: [], leave: 'FULL' }).status).toBe('LEAVE');
  });
});
