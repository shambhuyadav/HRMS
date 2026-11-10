// Early-departure minutes of the pure daily evaluation (FR-020 "derive ... early departure"; BRD coverage CL-050 shift deviation
// register; 0265, decided under owner delegation): one minute below, at and after the scheduled end; rounded up to whole minutes
// so a flagged day shows at least one; measured against the working half on a half weekly-off; none where the day carries no
// shift flags. Synthetic instants only.
import { describe, expect, it } from 'vitest';
import { type DayInput, evaluateDay } from './evaluate.js';

const MIN = 60_000;
const start = Date.UTC(2026, 2, 2, 3, 30); // 09:00 Asia/Kolkata
const at = (minutes: number) => start + minutes * MIN;
// 09:00-18:00 with a 60-minute unpaid break at 13:00: net 480 minutes.
const shift = { startMs: at(0), endMs: at(540), breaks: [{ startMs: at(240), endMs: at(300) }], netMinutes: 480 };
const policy = { graceMinutes: 10, presentPercent: 75, halfDayPercent: 50 };
const run = (over: Partial<DayInput>) => evaluateDay({ offDay: null, leave: 'NONE', shift, punches: [], policy, ...over });
const inOut = (inMs: number, outMs: number) => [
  { atMs: inMs, direction: 'IN' as const },
  { atMs: outMs, direction: 'OUT' as const },
];

describe('FR-020 early-departure minutes (CL-050; 0265)', () => {
  it.each([
    [539, true, 1],
    [540, false, 0],
    [541, false, 0],
    [520, true, 20],
  ])('FR-020: out at minute %i of the shift: early %s, %i minutes', (outMinute, early, minutes) => {
    expect(run({ punches: inOut(at(0), at(outMinute)) })).toMatchObject({ earlyDeparture: early, earlyDepartureMinutes: minutes });
  });

  it('FR-020: 30 seconds early is flagged and shows one minute (rounded up)', () => {
    expect(run({ punches: inOut(at(0), at(540) - 30_000) })).toMatchObject({ earlyDeparture: true, earlyDepartureMinutes: 1 });
  });

  it('FR-020 I-78 item 4: on a half weekly-off the minutes run to the end of the working half', () => {
    // Half of 480 net minutes is 240: the working half ends at 13:00, where the break starts.
    expect(run({ halfOff: true, punches: inOut(at(0), at(230)) })).toMatchObject({ status: 'PRESENT', earlyDeparture: true, earlyDepartureMinutes: 10 });
    expect(run({ halfOff: true, punches: inOut(at(0), at(240)) })).toMatchObject({ status: 'PRESENT', earlyDeparture: false, earlyDepartureMinutes: 0 });
  });

  it('FR-020 DF05: no minutes where the day carries no shift flags (leave, an off day, an exception)', () => {
    expect(run({ leave: 'FULL', punches: inOut(at(0), at(300)) })).toMatchObject({ status: 'LEAVE', earlyDepartureMinutes: 0 });
    expect(run({ offDay: 'WEEKLY_OFF', punches: inOut(at(0), at(300)) })).toMatchObject({ status: 'WEEKLY_OFF', earlyDepartureMinutes: 0 });
    expect(run({ punches: [{ atMs: at(0), direction: 'IN' }] })).toMatchObject({ status: 'EXCEPTION', earlyDepartureMinutes: 0 });
  });
});
