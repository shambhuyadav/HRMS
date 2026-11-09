// Exit separation types (FR-051, FR-052, FR-055; I-88 item 8; decided under owner delegation, 6 Nov 2026, docs/03 I-89 item 7;
// 0242). One table of rules, read by the exit service (entry, recommendation, approval, withdrawal, separation), the settlement
// calculation (notice) and the notification describers. Nothing here is an amount or a threshold: notice periods stay the contract's
// (recorded per exit), and gratuity's exempt types are the GRATUITY statutory pack's parameters (0235).
export const SEPARATION_TYPES = ['RESIGNATION', 'RETIREMENT', 'TERMINATION', 'DEATH', 'DISABLEMENT', 'END_OF_CONTRACT'] as const;
export type SeparationType = (typeof SEPARATION_TYPES)[number];

/** The types only HR enters; the employee's own route is a resignation (HR may also enter one from a letter, I-81 item 3). */
export const HR_ENTERED_TYPES = SEPARATION_TYPES.filter((t) => t !== 'RESIGNATION') as Exclude<SeparationType, 'RESIGNATION'>[];

export interface SeparationRule {
  /** Words for notices and screens. */
  label: string;
  /**
   * RECOVERED: the employee's contractual notice; a shortfall is recovered in the settlement (waivable, I-88 item 5).
   * EMPLOYER: per contract, the employer's to give; nothing is recovered from the employee and any pay in lieu is an entered line.
   * NONE: no notice applies.
   */
  notice: 'RECOVERED' | 'EMPLOYER' | 'NONE';
  /** Only a resignation is withdrawn (by the employee before the decision; afterwards through HR, F1). */
  withdrawable: boolean;
  /** The last working date is the event's own date: the recommendation and the approval confirm it and never move it. */
  dateFixed: boolean;
  /** Which last working dates an entry accepts, against the company-local business date (always on or after joining). */
  dates: 'FROM_TODAY' | 'UP_TO_TODAY' | 'ANY';
  /** The ground is recorded as an EXIT_REASON code (confidential reason group, like every exit reason). */
  reasonCodeRequired: boolean;
  /** What the one released, verified document of the employee proves (every HR entry carries one, 0185). */
  evidence: string;
}

export const SEPARATION_RULES: Readonly<Record<SeparationType, SeparationRule>> = {
  RESIGNATION: { label: 'Resignation', notice: 'RECOVERED', withdrawable: true, dateFixed: false, dates: 'FROM_TODAY', reasonCodeRequired: false, evidence: 'the resignation letter or e-mail (HR entry only)' },
  RETIREMENT: { label: 'Retirement', notice: 'NONE', withdrawable: false, dateFixed: true, dates: 'FROM_TODAY', reasonCodeRequired: false, evidence: 'the retirement order or superannuation note' },
  TERMINATION: { label: 'Termination', notice: 'EMPLOYER', withdrawable: false, dateFixed: false, dates: 'FROM_TODAY', reasonCodeRequired: true, evidence: 'the termination order' },
  DEATH: { label: 'Death', notice: 'NONE', withdrawable: false, dateFixed: true, dates: 'UP_TO_TODAY', reasonCodeRequired: false, evidence: 'the death certificate' },
  DISABLEMENT: { label: 'Disablement', notice: 'NONE', withdrawable: false, dateFixed: true, dates: 'ANY', reasonCodeRequired: false, evidence: 'the medical certificate or board finding' },
  END_OF_CONTRACT: { label: 'End of contract', notice: 'NONE', withdrawable: false, dateFixed: true, dates: 'FROM_TODAY', reasonCodeRequired: false, evidence: 'the fixed-term contract or its non-renewal letter' },
};

export const isSeparationType = (t: string): t is SeparationType => (SEPARATION_TYPES as readonly string[]).includes(t);
export const ruleOf = (t: string): SeparationRule => SEPARATION_RULES[isSeparationType(t) ? t : 'RESIGNATION'];

/** Why a last working date is not accepted for this type at entry, or null. Dates are ISO strings (compared as text). */
export function lastWorkingDateProblem(type: SeparationType, date: string, today: string, joiningDate: string): string | null {
  if (date < joiningDate) return 'The last working date cannot be before the joining date';
  const rule = SEPARATION_RULES[type];
  if (rule.dates === 'FROM_TODAY' && date < today) return 'The last working date must be from today';
  if (rule.dates === 'UP_TO_TODAY' && date > today) return 'The date of death cannot be in the future';
  return null;
}

/**
 * The exit's request date: the business date it is recorded on, or the event's own date when that is earlier (a death recorded
 * afterwards), so the request never follows its last working date (0038).
 */
export const requestDateOf = (type: SeparationType, date: string, today: string): string => (SEPARATION_RULES[type].dates !== 'FROM_TODAY' && date < today ? date : today);
