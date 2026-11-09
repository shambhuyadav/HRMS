// FR-020 test vectors for the rules decided under owner delegation, 6 Nov 2026 (owner chose process rules only; I-78):
// overtime candidates (DF05; item 5), late minutes (E07; item 6) and half weekly-offs (item 4), one minute below, equal to
// and above each threshold, across midnight and with missing punches. The owner's sign-off of these vectors stays pending
// review: they record the delegated decision, not an approval. Pure evaluation; synthetic values only. The threshold rules
// (present, half day, grace) are in evaluate.test.ts and evaluate-midnight.test.ts.
import { describe, expect, it } from 'vitest';
import { type DayInput, evaluateDay, type OvertimeRule, roundOvertime } from './evaluate.js';

const MIN = 60_000;
const day = Date.UTC(2026, 10, 2, 3, 30); // 09:00 Asia/Kolkata on a Monday; any fixed instant works
const at = (minutesFromStart: number) => day + minutesFromStart * MIN;
const inOut = (inMin: number, outMin: number) => [
  { atMs: at(inMin), direction: 'IN' as const },
  { atMs: at(outMin), direction: 'OUT' as const },
];

// DF05 default: 09:00-18:00, a 60-minute unpaid break at 13:00 (offset 240-300), 480 net minutes.
const dayShift = { startMs: at(0), endMs: at(540), breaks: [{ startMs: at(240), endMs: at(300) }], netMinutes: 480 };
// 22:00-06:00 with a 30-minute break at 02:00 (offset 240-270): 450 net minutes.
const night = { startMs: at(0), endMs: at(480), breaks: [{ startMs: at(240), endMs: at(270) }], netMinutes: 450 };
const policy = { graceMinutes: 10, presentPercent: 75, halfDayPercent: 50 };
const afterEnd = (minimumMinutes: number, roundingMinutes = 1): OvertimeRule => ({ basis: 'AFTER_SHIFT_END', minimumMinutes, roundingMinutes });
const beyondNet = (minimumMinutes: number, roundingMinutes = 1): OvertimeRule => ({ basis: 'BEYOND_SCHEDULED_NET', minimumMinutes, roundingMinutes });

const run = (over: Partial<DayInput> & { overtime?: OvertimeRule | null }) => {
  const { overtime, ...rest } = over;
  return evaluateDay({ offDay: null, leave: 'NONE', shift: dayShift, punches: [], ...rest, policy: { ...policy, ...rest.policy, overtime: overtime ?? null } });
};

describe('FR-020 DF05 overtime candidates: the minimum and the rounding unit (I-78 item 5)', () => {
  it('FR-020 DF05 a minimum of 30 after the shift end: 29 minutes are none, 30 and 31 are candidates', () => {
    expect(run({ overtime: afterEnd(30), punches: inOut(0, 569) })).toMatchObject({ status: 'PRESENT', overtimeCandidateMinutes: 0 });
    expect(run({ overtime: afterEnd(30), punches: inOut(0, 570) })).toMatchObject({ status: 'PRESENT', overtimeCandidateMinutes: 30 });
    expect(run({ overtime: afterEnd(30), punches: inOut(0, 571) })).toMatchObject({ status: 'PRESENT', overtimeCandidateMinutes: 31 });
  });

  it('FR-020 DF05 a rounding unit of 15 rounds down: 44 is 30, 45 is 45, 46 is 45 (unworked time is never proposed)', () => {
    expect(run({ overtime: afterEnd(0, 15), punches: inOut(0, 584) }).overtimeCandidateMinutes).toBe(30);
    expect(run({ overtime: afterEnd(0, 15), punches: inOut(0, 585) }).overtimeCandidateMinutes).toBe(45);
    expect(run({ overtime: afterEnd(0, 15), punches: inOut(0, 586) }).overtimeCandidateMinutes).toBe(45);
    // The minimum applies before the rounding: 44 against a minimum of 45 is none.
    expect(roundOvertime(44, afterEnd(45, 15))).toBe(0);
    expect(roundOvertime(45, afterEnd(45, 15))).toBe(45);
  });

  it('FR-020 DF05 the basis: after the shift end ignores an early arrival; beyond scheduled net counts it', () => {
    // 08:00 to 18:00 is 600 minutes, less the break: 540 worked, 60 above the 480 scheduled, none after 18:00.
    expect(run({ overtime: afterEnd(1), punches: inOut(-60, 540) })).toMatchObject({ workedMinutes: 540, overtimeCandidateMinutes: 0 });
    expect(run({ overtime: beyondNet(1), punches: inOut(-60, 540) })).toMatchObject({ workedMinutes: 540, overtimeCandidateMinutes: 60 });
    // Beyond net: 479, 480 and 481 worked minutes give none, none and one.
    expect(run({ overtime: beyondNet(1), punches: inOut(0, 539) }).overtimeCandidateMinutes).toBe(0);
    expect(run({ overtime: beyondNet(1), punches: inOut(0, 540) }).overtimeCandidateMinutes).toBe(0);
    expect(run({ overtime: beyondNet(1), punches: inOut(0, 541) }).overtimeCandidateMinutes).toBe(1);
  });

  it('FR-020 DF05 punch pairing: the same chronological pairs as worked minutes, duty counted once, no unpaired punch', () => {
    // Two pairs after the end with a gap: 18:30-19:00 and 19:30-20:00 are 60 minutes; the gap is not.
    const punches = [...inOut(0, 540), ...inOut(570, 600), ...inOut(630, 660)];
    expect(run({ overtime: afterEnd(1), punches }).overtimeCandidateMinutes).toBe(60);
    // An approved duty window 18:20-19:20 over the first evening pair counts once: 18:20-19:20 and 19:30-20:00 are 90.
    expect(run({ overtime: afterEnd(1), punches, dutyIntervals: [{ startMs: at(560), endMs: at(620) }] }).overtimeCandidateMinutes).toBe(90);
    // A missing OUT leaves the evening unknown: an exception, and no candidate.
    expect(run({ overtime: afterEnd(1), punches: [...inOut(0, 540), { atMs: at(570), direction: 'IN' }] })).toMatchObject({ status: 'EXCEPTION', overtimeCandidateMinutes: 0 });
  });

  it('FR-020 DF05 across midnight: after a 06:00 end, 06:29, 06:30 and 06:31 against a minimum of 30', () => {
    expect(run({ shift: night, overtime: afterEnd(30), punches: inOut(0, 509) }).overtimeCandidateMinutes).toBe(0);
    expect(run({ shift: night, overtime: afterEnd(30), punches: inOut(0, 510) }).overtimeCandidateMinutes).toBe(30);
    expect(run({ shift: night, overtime: afterEnd(30), punches: inOut(0, 511) }).overtimeCandidateMinutes).toBe(31);
  });

  it('FR-020 DF05 precedence: every worked minute on an off day; PRESENT only on a working day; none elsewhere', () => {
    const rule = afterEnd(30);
    expect(run({ overtime: rule, offDay: 'WEEKLY_OFF', punches: inOut(0, 240) })).toMatchObject({ status: 'WEEKLY_OFF', overtimeCandidateMinutes: 240 });
    expect(run({ overtime: rule, offDay: 'HOLIDAY', punches: inOut(0, 29) })).toMatchObject({ status: 'HOLIDAY', overtimeCandidateMinutes: 0 });
    expect(run({ overtime: rule, offDay: 'HOLIDAY', punches: inOut(0, 30) })).toMatchObject({ status: 'HOLIDAY', overtimeCandidateMinutes: 30 });
    expect(run({ overtime: rule, leave: 'FULL', punches: inOut(0, 600) })).toMatchObject({ status: 'LEAVE', overtimeCandidateMinutes: 0 });
    expect(run({ overtime: rule, dutyFullDay: true, punches: inOut(0, 600) })).toMatchObject({ status: 'ON_DUTY', overtimeCandidateMinutes: 0 });
    // Half day (14:00 to 19:00: 300 worked, 60 after the end) and half-day leave carry none.
    expect(run({ overtime: rule, punches: inOut(300, 600) })).toMatchObject({ status: 'HALF_DAY', overtimeCandidateMinutes: 0 });
    expect(run({ overtime: rule, leave: 'HALF', punches: inOut(300, 600) })).toMatchObject({ status: 'HALF_DAY_LEAVE', overtimeCandidateMinutes: 0 });
    expect(run({ overtime: rule })).toMatchObject({ status: 'ABSENT', overtimeCandidateMinutes: 0 });
    // A policy without overtime rules has no candidates at all.
    expect(run({ punches: inOut(0, 600) })).toMatchObject({ status: 'PRESENT', overtimeCandidateMinutes: null });
  });
});

describe('FR-020 E07 late minutes (I-78 item 6)', () => {
  it('FR-020 E07 counted from the scheduled start on a late day: 09:10 is 0 (inclusive grace), 09:11 is 11, 09:12 is 12', () => {
    expect(run({ punches: inOut(10, 540) })).toMatchObject({ late: false, lateMinutes: 0 });
    expect(run({ punches: inOut(11, 540) })).toMatchObject({ late: true, lateMinutes: 11 });
    expect(run({ punches: inOut(12, 540) })).toMatchObject({ late: true, lateMinutes: 12 });
    expect(run({ punches: inOut(-5, 540) })).toMatchObject({ late: false, lateMinutes: 0 });
  });

  it('FR-020 E07 across midnight and with missing punches: 22:11 is 11; an exception or off day has none', () => {
    expect(run({ shift: night, punches: inOut(11, 480) })).toMatchObject({ late: true, lateMinutes: 11 });
    expect(run({ shift: night, punches: [{ atMs: at(30), direction: 'IN' }] })).toMatchObject({ status: 'EXCEPTION', late: false, lateMinutes: 0 });
    expect(run({ offDay: 'WEEKLY_OFF', punches: inOut(60, 540) })).toMatchObject({ late: false, lateMinutes: 0 });
  });
});

describe('FR-020 half weekly-off: measured against the first half of the shift (I-78 item 4)', () => {
  it('FR-020 the half of 480 net minutes is 240, ending at 13:00 before the break; 75% of it is 180', () => {
    expect(run({ halfOff: true, punches: inOut(0, 179) })).toMatchObject({ scheduledNetMinutes: 240, workedMinutes: 179, status: 'HALF_DAY' });
    expect(run({ halfOff: true, punches: inOut(0, 180) })).toMatchObject({ workedMinutes: 180, status: 'PRESENT' });
    expect(run({ halfOff: true, punches: inOut(0, 181) })).toMatchObject({ workedMinutes: 181, status: 'PRESENT' });
  });

  it('FR-020 early departure on a half weekly-off is measured against the half end: 12:59 early, 13:00 and 13:01 not', () => {
    expect(run({ halfOff: true, punches: inOut(0, 239) }).earlyDeparture).toBe(true);
    expect(run({ halfOff: true, punches: inOut(0, 240) }).earlyDeparture).toBe(false);
    expect(run({ halfOff: true, punches: inOut(0, 241) }).earlyDeparture).toBe(false);
    expect(run({ halfOff: true, punches: inOut(11, 240) })).toMatchObject({ late: true, lateMinutes: 11, status: 'PRESENT' });
  });

  it('FR-020 no work on a half weekly-off is a half day, never absence; half-day leave covers the working half', () => {
    expect(run({ halfOff: true })).toMatchObject({ status: 'HALF_DAY', workedMinutes: 0 });
    expect(run({ halfOff: true, leave: 'HALF' })).toMatchObject({ status: 'HALF_DAY_LEAVE' });
    expect(run({ halfOff: true, leave: 'FULL' }).status).toBe('LEAVE');
    expect(run({ halfOff: true, offDay: 'HOLIDAY' })).toMatchObject({ status: 'HOLIDAY', scheduledNetMinutes: 480 });
    expect(run({ halfOff: true, punches: [{ atMs: at(0), direction: 'IN' }] })).toMatchObject({ status: 'EXCEPTION', exceptionCode: 'MISSING_OUT_PUNCH' });
  });

  it('FR-020 across midnight: a 22:00 half weekly-off night (225 of 450 net) ends at 01:45; 80% of it is 180', () => {
    const strict = { graceMinutes: 10, presentPercent: 80, halfDayPercent: 40 };
    expect(run({ shift: night, halfOff: true, policy: strict, punches: inOut(0, 179) })).toMatchObject({ scheduledNetMinutes: 225, status: 'HALF_DAY' });
    expect(run({ shift: night, halfOff: true, policy: strict, punches: inOut(0, 180) })).toMatchObject({ status: 'PRESENT', earlyDeparture: true });
    expect(run({ shift: night, halfOff: true, policy: strict, punches: inOut(0, 225) })).toMatchObject({ status: 'PRESENT', earlyDeparture: false });
  });

  it('FR-020 DF05 overtime after the end of the working half, its break deducted', () => {
    // 09:00-15:00 on a half weekly-off: 120 minutes after 13:00, less the 13:00-14:00 break, are 60.
    expect(run({ halfOff: true, overtime: afterEnd(1), punches: inOut(0, 360) })).toMatchObject({ status: 'PRESENT', overtimeCandidateMinutes: 60 });
  });
});
