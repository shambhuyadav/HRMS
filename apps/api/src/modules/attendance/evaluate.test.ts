// DF05 / F6 boundary fixtures for the pure daily evaluation (FR-020 acceptance: one minute below, equal to and
// above each threshold; midnight crossing; missing punches).
import { describe, expect, it } from 'vitest';
import { type DayInput, evaluateDay } from './evaluate.js';

const MIN = 60_000;
const day = Date.UTC(2026, 10, 2, 3, 30); // 09:00 Asia/Kolkata expressed in UTC; any fixed instant works
const at = (minutesFromStart: number) => day + minutesFromStart * MIN;

// DF05 default: 09:00-18:00, 60-minute unpaid break at 13:00 (offset 240-300), net 480 minutes.
const dayShift = { startMs: at(0), endMs: at(540), breaks: [{ startMs: at(240), endMs: at(300) }], netMinutes: 480 };
const policy = { graceMinutes: 10, presentPercent: 75, halfDayPercent: 50 };

function run(over: Partial<DayInput>) {
  return evaluateDay({ offDay: null, leave: 'NONE', shift: dayShift, punches: [], policy, ...over });
}
const inOut = (inMin: number, outMin: number) => [
  { atMs: at(inMin), direction: 'IN' as const },
  { atMs: at(outMin), direction: 'OUT' as const },
];

describe('F6 thresholds on an 8-hour net shift', () => {
  // Punch pairs that avoid the break so worked minutes equal the paired span.
  it.each([
    [360, 'PRESENT'], // exactly 75%
    [361, 'PRESENT'],
    [359, 'HALF_DAY'], // one minute below 75%
    [240, 'HALF_DAY'], // exactly 50%
    [239, 'ABSENT'], // one minute below 50%
  ])('%i worked minutes -> %s', (worked, status) => {
    const r = run({ punches: inOut(300, 300 + worked) }); // starts after the break
    expect(r.workedMinutes).toBe(worked);
    expect(r.status).toBe(status);
  });

  it('subtracts the scheduled break from a full day: 09:00-18:00 is 480 worked', () => {
    expect(run({ punches: inOut(0, 540) })).toMatchObject({ workedMinutes: 480, status: 'PRESENT', late: false, earlyDeparture: false });
  });
});

describe('F6 grace and early departure', () => {
  it('09:10 is within a 10-minute grace; 09:11 is late; grace never changes the status', () => {
    expect(run({ punches: inOut(10, 540) })).toMatchObject({ late: false, status: 'PRESENT' });
    expect(run({ punches: inOut(11, 540) })).toMatchObject({ late: true, status: 'PRESENT' });
  });

  it('flags leaving before shift end', () => {
    expect(run({ punches: inOut(0, 539) })).toMatchObject({ earlyDeparture: true });
  });
});

describe('missing and invalid punches are exceptions, not absence (DF05)', () => {
  it.each([
    [[{ atMs: at(0), direction: 'IN' as const }], 'MISSING_OUT_PUNCH'],
    [[{ atMs: at(540), direction: 'OUT' as const }], 'MISSING_IN_PUNCH'],
    [
      [
        { atMs: at(0), direction: 'IN' as const },
        { atMs: at(10), direction: 'IN' as const },
        { atMs: at(540), direction: 'OUT' as const },
      ],
      'MISSING_OUT_PUNCH',
    ],
    [
      [
        { atMs: at(100), direction: 'IN' as const },
        { atMs: at(100), direction: 'OUT' as const },
      ],
      'INVALID_PUNCH_PAIR',
    ],
  ])('%#', (punches, code) => {
    expect(run({ punches })).toMatchObject({ status: 'EXCEPTION', exceptionCode: code, workedMinutes: 0 });
  });

  it('no punches on a working day without leave is ABSENT', () => {
    expect(run({}).status).toBe('ABSENT');
  });
});

describe('calendar and leave precedence', () => {
  it('weekly off and holidays override punches; approved full-day leave overrides absence', () => {
    expect(run({ offDay: 'WEEKLY_OFF', punches: inOut(0, 540) })).toMatchObject({ status: 'WEEKLY_OFF', workedMinutes: 480 });
    expect(run({ offDay: 'HOLIDAY' }).status).toBe('HOLIDAY');
    expect(run({ leave: 'FULL' }).status).toBe('LEAVE');
  });

  it('approved half-day leave needs half-day presence; less needs review', () => {
    expect(run({ leave: 'HALF', punches: inOut(300, 540) }).status).toBe('HALF_DAY_LEAVE'); // 240 = 50%
    expect(run({ leave: 'HALF', punches: inOut(300, 539) })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'HALF_DAY_LEAVE_SHORTFALL' });
    expect(run({ leave: 'HALF' })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'HALF_DAY_LEAVE_SHORTFALL' });
  });

  it('no shift on a working day is an exception', () => {
    expect(run({ shift: null, punches: inOut(0, 540) })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'NO_SHIFT_ASSIGNED' });
  });
});

describe('overnight shift (DF05: belongs to the start date)', () => {
  it('22:00-06:00 with a 30-minute break: punches across midnight give 450 worked minutes', () => {
    const night = { startMs: at(0), endMs: at(480), breaks: [{ startMs: at(240), endMs: at(270) }], netMinutes: 450 };
    expect(run({ shift: night, punches: inOut(0, 480) })).toMatchObject({ workedMinutes: 450, status: 'PRESENT', late: false, earlyDeparture: false });
  });
});

describe('approved outdoor duty (FR-027)', () => {
  it('a full-day duty gives ON_DUTY on a working day, but off days and full leave keep precedence', () => {
    expect(run({ dutyFullDay: true }).status).toBe('ON_DUTY');
    expect(run({ dutyFullDay: true, punches: [{ atMs: at(0), direction: 'IN' }] }).status).toBe('ON_DUTY');
    expect(run({ dutyFullDay: true, offDay: 'HOLIDAY' }).status).toBe('HOLIDAY');
    expect(run({ dutyFullDay: true, leave: 'FULL' }).status).toBe('LEAVE');
  });

  it('a timed duty window counts as worked time, and overlap with punches counts once', () => {
    // Duty 09:00-13:00 (240) + punches 14:00-18:00 (240) = 480 worked -> PRESENT.
    expect(run({ dutyIntervals: [{ startMs: at(0), endMs: at(240) }], punches: inOut(300, 540) })).toMatchObject({ workedMinutes: 480, status: 'PRESENT' });
    // Duty alone 09:00-13:00 = 240 = exactly 50% -> HALF_DAY, never ABSENT for missing punches.
    expect(run({ dutyIntervals: [{ startMs: at(0), endMs: at(240) }] })).toMatchObject({ workedMinutes: 240, status: 'HALF_DAY' });
    // Duty 09:00-15:00 overlapping punches 12:00-18:00: union 09:00-18:00 minus the 60-minute break = 480, not 600.
    expect(run({ dutyIntervals: [{ startMs: at(0), endMs: at(360) }], punches: inOut(180, 540) })).toMatchObject({ workedMinutes: 480, status: 'PRESENT' });
  });
});

const duty = (fromMin: number, toMin: number) => [{ startMs: at(fromMin), endMs: at(toMin) }];

describe('approved timed duty while the punch source is unavailable (DF09: a failed fetch is never absence)', () => {
  it('duty that does not prove presence leaves the day a source exception, never ABSENT or HALF_DAY', () => {
    // 09:00-11:00 on duty; the day's biometric fetch failed and no punch arrived.
    expect(run({ sourceUnavailable: true, dutyIntervals: duty(0, 120) })).toMatchObject({
      status: 'EXCEPTION',
      exceptionCode: 'PUNCH_SOURCE_UNAVAILABLE',
      workedMinutes: 120,
      late: false,
      earlyDeparture: false,
    });
    // 09:00-13:00 = 240 = exactly the half-day threshold: still no HALF_DAY conclusion.
    expect(run({ sourceUnavailable: true, dutyIntervals: duty(0, 240) })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'PUNCH_SOURCE_UNAVAILABLE' });
    // 09:00-15:59 = 419 - 60 break = 359, one minute below PRESENT.
    expect(run({ sourceUnavailable: true, dutyIntervals: duty(0, 419) })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'PUNCH_SOURCE_UNAVAILABLE' });
    // Without any duty the day was already a source exception.
    expect(run({ sourceUnavailable: true })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'PUNCH_SOURCE_UNAVAILABLE' });
  });

  it('duty that alone meets the present threshold proves presence; lost punches imply no late or early flag', () => {
    // 09:00-16:00 = 420 - 60 break = 360 = exactly 75%.
    expect(run({ sourceUnavailable: true, dutyIntervals: duty(0, 420) })).toMatchObject({ status: 'PRESENT', workedMinutes: 360, late: false, earlyDeparture: false });
    // 10:00-17:00 on duty: present, but whether the employee was also in the office earlier or later is unknown.
    expect(run({ sourceUnavailable: true, dutyIntervals: duty(60, 480) })).toMatchObject({ status: 'PRESENT', workedMinutes: 360, late: false, earlyDeparture: false });
    // With the source working, the same duty-only day did start late and end early.
    expect(run({ dutyIntervals: duty(60, 480) })).toMatchObject({ status: 'PRESENT', workedMinutes: 360, late: true, earlyDeparture: true });
  });
});

describe('late and early flags count approved duty as attended time (DF05 grace; FR-027)', () => {
  it('a duty before the office punches is not a late arrival; a duty after them is not an early departure', () => {
    // Duty 09:00-13:00, punches 14:00-18:00.
    expect(run({ dutyIntervals: duty(0, 240), punches: inOut(300, 540) })).toMatchObject({ status: 'PRESENT', workedMinutes: 480, late: false, earlyDeparture: false });
    // Punches 09:00-13:00, duty 14:00-18:00.
    expect(run({ punches: inOut(0, 240), dutyIntervals: duty(300, 540) })).toMatchObject({ status: 'PRESENT', workedMinutes: 480, late: false, earlyDeparture: false });
  });

  it('the first and last covered minute keep the inclusive grace and the shift end', () => {
    // Duty from 09:10 is within grace; from 09:11 it is late. The last punch out at 17:59 is early.
    expect(run({ dutyIntervals: duty(10, 240), punches: inOut(300, 540) })).toMatchObject({ late: false, earlyDeparture: false });
    expect(run({ dutyIntervals: duty(11, 240), punches: inOut(300, 539) })).toMatchObject({ late: true, earlyDeparture: true });
  });

  it('a full-day duty (ON_DUTY) carries no late or early flag from office punches', () => {
    // Office IN at 10:00 and OUT at 14:00 on a day covered by an approved full-day duty.
    expect(run({ dutyFullDay: true, punches: inOut(60, 300) })).toMatchObject({ status: 'ON_DUTY', late: false, earlyDeparture: false });
  });

  it('off days and full-day leave override punch-based outcomes, flags included', () => {
    // 10:00-14:00 in the office or on duty (e.g. a holiday added after the duty was approved).
    for (const over of [{ offDay: 'WEEKLY_OFF' as const }, { offDay: 'HOLIDAY' as const }, { leave: 'FULL' as const }]) {
      expect(run({ ...over, punches: inOut(60, 300) })).toMatchObject({ late: false, earlyDeparture: false });
      expect(run({ ...over, dutyIntervals: duty(60, 300) })).toMatchObject({ late: false, earlyDeparture: false });
    }
  });
});

describe('overnight shift with a duty window after midnight (DF05: the shift belongs to its start date)', () => {
  it('22:00-06:00 with punches 22:00-00:00 and duty 00:00-06:00 is one PRESENT night of 450 worked minutes', () => {
    const night = { startMs: at(0), endMs: at(480), breaks: [{ startMs: at(240), endMs: at(270) }], netMinutes: 450 };
    expect(run({ shift: night, punches: inOut(0, 120), dutyIntervals: duty(120, 480) })).toMatchObject({
      workedMinutes: 450,
      status: 'PRESENT',
      late: false,
      earlyDeparture: false,
    });
  });
});
