// Daily attendance evaluation (FR-020; BR-009; DF05; F6). Pure and deterministic: the same inputs always
// give the same result, so a rerun with unchanged inputs reproduces the record (FR-022).
//
// Rules (DF05/F6):
//   * Off days (weekly off / location holiday) and approved full-day leave override punch-based outcomes.
//   * Punches pair chronologically IN -> OUT. A missing or out-of-order punch is an EXCEPTION, never ABSENT.
//     Zero-length pairs are invalid.
//   * Worked minutes = paired time minus overlap with scheduled unpaid breaks.
//   * PRESENT when worked >= present% of scheduled net minutes; HALF_DAY when >= half-day%; otherwise ABSENT
//     (absence is only concluded here after calendar and approved leave were applied).
//   * Approved half-day leave: worked >= half-day% gives HALF_DAY_LEAVE; less needs review (EXCEPTION).
//   * FR-027 approved outdoor duty: a full-day duty gives ON_DUTY on a working day; a timed duty window counts
//     as worked time, merged with punch pairs so overlapping time is counted once.
//   * DF09: when the punch source failed and no punch arrived, the day is a PUNCH_SOURCE_UNAVAILABLE exception
//     unless approved duty alone reaches PRESENT; duty never turns a failed fetch into ABSENT or HALF_DAY.
//   * Late when the first covered minute (punch or approved duty) is more than grace minutes after shift start
//     (inclusive grace: start + grace is on time). Early departure when the last covered minute is before shift
//     end. Neither changes pay (DF05). Flags exist only for outcomes measured against the shift: none on an off
//     day, a full leave day, an ON_DUTY day or an exception, and none from duty alone while the punch source is
//     unavailable (the lost punches might have covered the gap).
//
// Decided under owner delegation, 6 Nov 2026 (owner chose process rules only; I-78):
//   * Late minutes (item 6, E07): from the scheduled start to the first covered minute on a late day; 0 otherwise.
//   * Half weekly-off (item 4): a working day measured against the first half of the shift: the scheduled net minutes
//     are half the shift's (rounded down), ending when that much work time from the start has passed (breaks skipped).
//     Worked at least the present percentage of that half is PRESENT; less is HALF_DAY (the off half is a weekly off, so
//     the day is never ABSENT); approved half-day leave covers the working half. Early departure is measured against
//     that half's end.
//   * Overtime candidates (item 5, DF05): only where the policy's overtime setting is on, and never paid from here. The
//     same chronological pairs (and approved duty windows) as worked minutes, scheduled breaks deducted. Basis
//     AFTER_SHIFT_END: covered minutes after the scheduled end; BEYOND_SCHEDULED_NET: worked minutes above the scheduled
//     net minutes. Precedence: on a weekly off or holiday every worked minute; on a working day a PRESENT result only;
//     none on leave, half-day leave, on duty, an exception, absence or a half day. Below the minimum, none; at or above
//     it, rounded down to whole rounding units.

export type AttendanceStatus = 'PRESENT' | 'HALF_DAY' | 'ABSENT' | 'EXCEPTION' | 'LEAVE' | 'HALF_DAY_LEAVE' | 'HOLIDAY' | 'WEEKLY_OFF' | 'ON_DUTY';

export interface Interval {
  startMs: number;
  endMs: number;
}

/** I-78 item 5: an attendance policy's overtime rules (all three, or none). */
export interface OvertimeRule {
  basis: 'AFTER_SHIFT_END' | 'BEYOND_SCHEDULED_NET';
  minimumMinutes: number;
  roundingMinutes: number;
}

export interface DayInput {
  offDay: 'WEEKLY_OFF' | 'HOLIDAY' | null;
  /** I-78 item 4: a half weekly-off of the employee's location (a working day measured against half the shift). */
  halfOff?: boolean | undefined;
  leave: 'NONE' | 'FULL' | 'HALF';
  shift: (Interval & { breaks: Interval[]; netMinutes: number }) | null;
  punches: { atMs: number; direction: 'IN' | 'OUT' }[];
  policy: { graceMinutes: number; presentPercent: number; halfDayPercent: number; overtime?: OvertimeRule | null | undefined };
  /** A device source for this employee failed for the day's window (DF09: a failed fetch is never absence). */
  sourceUnavailable?: boolean | undefined;
  /** FR-027 approved outdoor duty covering the whole working day. */
  dutyFullDay?: boolean | undefined;
  /** FR-027 approved timed outdoor duty windows on this day. */
  dutyIntervals?: Interval[] | undefined;
}

export interface DayResult {
  status: AttendanceStatus;
  workedMinutes: number;
  scheduledNetMinutes: number;
  late: boolean;
  /** Minutes from the scheduled start to the first covered minute on a late day; 0 otherwise. */
  lateMinutes: number;
  earlyDeparture: boolean;
  /** Overtime candidate minutes; null when the policy's overtime setting is off (or has no rules). */
  overtimeCandidateMinutes: number | null;
  exceptionCode: string | null;
}

const MINUTE = 60_000;
/** Outcomes not measured against the scheduled shift: they never carry a late or early-departure flag. */
const UNFLAGGED: ReadonlySet<AttendanceStatus> = new Set<AttendanceStatus>(['EXCEPTION', 'ON_DUTY', 'WEEKLY_OFF', 'HOLIDAY', 'LEAVE']);

/** Whether an outcome can carry late/early-departure flags (an amendment to any other outcome drops them). */
export const carriesShiftFlags = (status: string): boolean => !UNFLAGGED.has(status as AttendanceStatus);

/** Whether an outcome can carry overtime candidates (I-78 item 5): off days and PRESENT only. */
export const carriesOvertime = (status: string): boolean => status === 'PRESENT' || status === 'WEEKLY_OFF' || status === 'HOLIDAY';

function overlapMs(a: Interval, b: Interval): number {
  return Math.max(0, Math.min(a.endMs, b.endMs) - Math.max(a.startMs, b.startMs));
}

/** Union of intervals, so time covered twice (punch and duty) counts once. */
function merge(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((x, y) => x.startMs - y.startMs);
  const out: Interval[] = [];
  for (const i of sorted) {
    const last = out.at(-1);
    if (last && i.startMs <= last.endMs) last.endMs = Math.max(last.endMs, i.endMs);
    else out.push({ ...i });
  }
  return out;
}

function pair(punches: DayInput['punches']): { pairs: Interval[]; error: string | null } {
  const sorted = [...punches].sort((x, y) => x.atMs - y.atMs);
  const pairs: Interval[] = [];
  let open: number | null = null;
  for (const p of sorted) {
    if (p.direction === 'IN') {
      if (open !== null) return { pairs, error: 'MISSING_OUT_PUNCH' };
      open = p.atMs;
    } else {
      if (open === null) return { pairs, error: 'MISSING_IN_PUNCH' };
      if (p.atMs <= open) return { pairs, error: 'INVALID_PUNCH_PAIR' };
      pairs.push({ startMs: open, endMs: p.atMs });
      open = null;
    }
  }
  if (open !== null) return { pairs, error: 'MISSING_OUT_PUNCH' };
  return { pairs, error: null };
}

/** The instant `netMinutes` of work time after the shift start, scheduled breaks skipped (the end of a half weekly-off). */
function workTimeEnd(shift: NonNullable<DayInput['shift']>, netMinutes: number): number {
  let at = shift.startMs;
  let remaining = netMinutes * MINUTE;
  for (const b of [...shift.breaks].sort((x, y) => x.startMs - y.startMs)) {
    const before = Math.max(0, b.startMs - at);
    if (before >= remaining) break;
    remaining -= before;
    at = Math.max(at, b.endMs);
  }
  return at + remaining;
}

/** I-78 item 5: below the minimum nothing; otherwise rounded down to whole units. */
export function roundOvertime(rawMinutes: number, rule: OvertimeRule): number {
  if (rawMinutes <= 0 || rawMinutes < rule.minimumMinutes) return 0;
  return Math.floor(rawMinutes / rule.roundingMinutes) * rule.roundingMinutes;
}

export function evaluateDay(input: DayInput): DayResult {
  const halfOff = !!input.halfOff && !input.offDay && !!input.shift;
  const fullNet = input.shift?.netMinutes ?? 0;
  const scheduledNetMinutes = halfOff ? Math.floor(fullNet / 2) : fullNet;
  const scheduledEndMs = input.shift ? (halfOff ? workTimeEnd(input.shift, scheduledNetMinutes) : input.shift.endMs) : undefined;
  const { pairs, error } = pair(input.punches);
  const covered = merge([...pairs, ...(input.dutyIntervals ?? [])]);
  const breakOverlap = (i: Interval) => (input.shift ? input.shift.breaks.reduce((s, b) => s + overlapMs(i, b), 0) : 0);
  const pairedMs = covered.reduce((sum, p) => sum + (p.endMs - p.startMs), 0);
  const breakMs = covered.reduce((sum, p) => sum + breakOverlap(p), 0);
  const workedMinutes = error ? 0 : Math.floor((pairedMs - breakMs) / MINUTE);

  // DF09: the source failed and no punch arrived, so only approved duty is known about the day.
  const punchesLost = !!input.sourceUnavailable && pairs.length === 0;
  // Approved duty is attended time: the day starts at the first covered minute and ends at the last.
  const firstIn = covered[0]?.startMs;
  const lastOut = covered.at(-1)?.endMs;
  const minutesLate = input.shift && firstIn !== undefined ? Math.floor((firstIn - input.shift.startMs) / MINUTE) : 0;
  const late = !!input.shift && firstIn !== undefined && minutesLate > input.policy.graceMinutes;
  const earlyDeparture = scheduledEndMs !== undefined && lastOut !== undefined && lastOut < scheduledEndMs;

  const overtimeOf = (status: AttendanceStatus): number | null => {
    const rule = input.policy.overtime;
    if (!rule) return null;
    if (error || !carriesOvertime(status)) return 0;
    if (status !== 'PRESENT') return roundOvertime(workedMinutes, rule);
    if (rule.basis === 'BEYOND_SCHEDULED_NET') return roundOvertime(workedMinutes - scheduledNetMinutes, rule);
    const after = covered.reduce((sum, p) => {
      const tail = { startMs: Math.max(p.startMs, scheduledEndMs!), endMs: p.endMs };
      return tail.endMs > tail.startMs ? sum + (tail.endMs - tail.startMs) - breakOverlap(tail) : sum;
    }, 0);
    return roundOvertime(Math.floor(after / MINUTE), rule);
  };

  const result = (status: AttendanceStatus, exceptionCode: string | null = null): DayResult => {
    const flagged = !UNFLAGGED.has(status) && !punchesLost;
    return {
      status,
      workedMinutes,
      scheduledNetMinutes,
      late: flagged && late,
      lateMinutes: flagged && late ? minutesLate : 0,
      earlyDeparture: flagged && earlyDeparture,
      overtimeCandidateMinutes: overtimeOf(status),
      exceptionCode,
    };
  };

  if (input.offDay) return result(input.offDay);
  if (input.leave === 'FULL') return result('LEAVE');
  if (input.dutyFullDay) return result('ON_DUTY');
  if (!input.shift) return result('EXCEPTION', 'NO_SHIFT_ASSIGNED');
  if (error) return result('EXCEPTION', error);

  // Integer comparison: worked * 100 >= percent * net (percent carries up to 2 decimals).
  const meets = (percent: number) => workedMinutes * 10_000 >= Math.round(percent * 100) * scheduledNetMinutes;

  if (halfOff) {
    // The working half is covered by the half-day leave; otherwise it is worked, or the day is half a day.
    if (input.leave === 'HALF') return result('HALF_DAY_LEAVE');
    if (punchesLost && !meets(input.policy.presentPercent)) return result('EXCEPTION', 'PUNCH_SOURCE_UNAVAILABLE');
    return result(covered.length > 0 && meets(input.policy.presentPercent) ? 'PRESENT' : 'HALF_DAY');
  }
  if (input.leave === 'HALF') {
    if (covered.length > 0 && meets(input.policy.halfDayPercent)) return result('HALF_DAY_LEAVE');
    return result('EXCEPTION', 'HALF_DAY_LEAVE_SHORTFALL');
  }
  // A failed fetch is never absence: duty alone may prove presence, but a shortfall cannot be concluded.
  if (punchesLost && !meets(input.policy.presentPercent)) return result('EXCEPTION', 'PUNCH_SOURCE_UNAVAILABLE');
  if (covered.length === 0) return result('ABSENT');
  if (meets(input.policy.presentPercent)) return result('PRESENT');
  if (meets(input.policy.halfDayPercent)) return result('HALF_DAY');
  return result('ABSENT');
}
