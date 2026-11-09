// FR-052 settlement formulas (decided under owner delegation, 6 Nov 2026; docs/03 I-88). Pure functions over exact decimals: amounts
// and units are decimal strings of at most four fraction digits (numeric(19, 4), as the database holds them), computed as BigInt
// fractions and rounded once, half-up, to the currency's minor unit, exactly as the payroll core rounds (0043
// hrms_payroll_round_half_up: div(2 * n * scale + d, 2 * d) / scale). No rate, divisor, cap or threshold is a constant here: each
// comes from the company's settlement policy or the statutory rule pack, as an argument.

const SCALE = 4;
const TEN = 10n;
const UNIT = TEN ** BigInt(SCALE);
const DECIMAL = /^(-)?(\d{1,15})(?:\.(\d{1,4}))?$/;

/** A decimal string as a BigInt of 1/10,000ths ("12.5" -> 125000n). */
export function toUnits(text: string | number): bigint {
  const m = DECIMAL.exec(String(text).trim());
  if (!m) throw new Error(`not a decimal of at most four fraction digits: ${text}`);
  const value = BigInt(m[2]!) * UNIT + BigInt((m[3] ?? '').padEnd(SCALE, '0'));
  return m[1] ? -value : value;
}

/** 1/10,000ths as a decimal string with four fraction digits (125000n -> "12.5000"). */
export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const text = `${abs / UNIT}.${(abs % UNIT).toString().padStart(SCALE, '0')}`;
  return negative && abs !== 0n ? `-${text}` : text;
}

/** n / d (n >= 0, d > 0) rounded half-up to `minor` decimals, as a four-decimal string (the payroll core's rounding). */
export function roundHalfUp(n: bigint, d: bigint, minor: number): string {
  if (n < 0n || d <= 0n || minor < 0 || minor > SCALE) throw new Error('rounding needs a non-negative amount and a positive divisor');
  const scale = TEN ** BigInt(minor);
  const rounded = (2n * n * scale + d) / (2n * d);
  return fromUnits(rounded * TEN ** BigInt(SCALE - minor));
}

export const negate = (amount: string): string => fromUnits(-toUnits(amount));
export const sum = (amounts: readonly string[]): string => fromUnits(amounts.reduce((a, x) => a + toUnits(x), 0n));
export const isZero = (amount: string): boolean => toUnits(amount) === 0n;
export const min = (a: string, b: string): string => (toUnits(a) <= toUnits(b) ? a : b);

/**
 * DF05 proration, as the payroll core values a monthly FIXED component (payroll/calculate.ts linesSql): the monthly amount of each
 * arrangement segment x its paid days, summed, / the calendar days of the month, rounded once.
 */
export function prorate(segments: readonly { monthlyAmount: string; paidDays: string }[], daysInMonth: number, minor: number): string {
  const n = segments.reduce((a, s) => a + toUnits(s.monthlyAmount) * toUnits(s.paidDays), 0n);
  return roundHalfUp(n, UNIT * UNIT * BigInt(daysInMonth), minor);
}

/** A day-rate value: a monthly rate / the divisor x the units (days), rounded once. Encashment and notice recovery. */
export function dayRateValue(monthly: string, units: string, divisor: number, minor: number): string {
  if (!Number.isInteger(divisor) || divisor <= 0) throw new Error('the divisor is a positive whole number of days');
  return roundHalfUp(toUnits(monthly) * toUnits(units), UNIT * UNIT * BigInt(divisor), minor);
}

/** Calendar date arithmetic (UTC, no zone shift). Adding months clamps to the month's end, as PostgreSQL does (31 Aug + 6 months = 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = total - year * 12;
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}
export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Continuous service from the joining date to the (inclusive) last working date: completed years, and the years counted when a final
 * part-year of more than `partYearMonthsOver` months counts as a year (Payment of Gratuity Act s.4(2) "for every completed year of
 * service or part thereof in excess of six months"). The service ends the day after the last working date: a remainder counts when
 * joining + completed years + the months stated is still before that day (exactly six months does not count, six months and a day does).
 */
export function serviceYears(joiningDate: string, lastWorkingDate: string, partYearMonthsOver: number) {
  const end = addDays(lastWorkingDate, 1);
  let completed = 0;
  while (addMonths(joiningDate, (completed + 1) * 12) <= end) completed++;
  const anniversary = addMonths(joiningDate, completed * 12);
  const partYearCounts = addMonths(anniversary, partYearMonthsOver) < end;
  return { completedYears: completed, lastAnniversary: anniversary, partYearCounts, countedYears: completed + (partYearCounts ? 1 : 0) };
}

export interface GratuityParameters {
  wageDays: number;
  wageDivisor: number;
  minimumServiceYears: number;
  partYearMonthsOver: number;
  ceilingAmount: string;
  exemptSeparationTypes: string[];
}

/**
 * Payment of Gratuity Act s.4(1): payable after `minimumServiceYears` of continuous service, except on a separation type the pack
 * exempts (death or disablement). Eligibility counts completed years only; rounding a part-year up is for the amount (s.4(2)).
 */
export function gratuityEligibility(p: GratuityParameters, joiningDate: string, lastWorkingDate: string, separationType: string) {
  const service = serviceYears(joiningDate, lastWorkingDate, p.partYearMonthsOver);
  const exempt = p.exemptSeparationTypes.includes(separationType);
  return { ...service, exempt, eligible: exempt || service.completedYears >= p.minimumServiceYears };
}

/**
 * s.4(2): `wageDays` days' wages (Basic + DA last drawn) per counted year, a month's wages being divided by `wageDivisor` (15 / 26 for
 * a monthly-rated employee), rounded once; s.4(3): never above the ceiling.
 */
export function gratuityAmount(p: GratuityParameters, monthlyWages: string, countedYears: number, minor: number) {
  const n = toUnits(monthlyWages) * toUnits(p.wageDays) * BigInt(countedYears);
  const uncapped = roundHalfUp(n, UNIT * toUnits(p.wageDivisor), minor);
  const capped = toUnits(uncapped) > toUnits(p.ceilingAmount);
  return { uncapped, amount: capped ? fromUnits(toUnits(p.ceilingAmount)) : uncapped, capped };
}

/**
 * F1 notice: the days served run from the resignation date to the (inclusive) last working date, both counted; the shortfall is what
 * the recorded contractual notice exceeds them by, never below zero.
 */
export function noticeShortfall(requestDate: string, lastWorkingDate: string, contractualNoticeDays: number) {
  const served = daysBetween(requestDate, lastWorkingDate) + 1;
  return { required: contractualNoticeDays, served, shortfall: Math.max(0, contractualNoticeDays - served) };
}
