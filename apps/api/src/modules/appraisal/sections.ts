// FR-042 configurable appraisal sections (decided under owner delegation, 6 Nov 2026; I-86; migration 0231). The meanings are
// fixed here and in the database (hrms_appraisal_section_party); each cycle chooses which sections it includes (none by
// default). No section is scored: the overall result is the goals and competencies formula only. An included section's part
// must be filled before its party submits (the employee's at the self-entry, the manager's at the rating); an excluded section
// takes no entries and never blocks a submission. The employee's text is the own self-entry (own-ESS `self` group); the
// manager's text is confidential (`rating` group).
export const SECTION_CODES = ['IMPROVEMENT_AREAS', 'TRAINING_NEEDS', 'ACTIVITY_PERFORMANCE', 'STRETCHED_KPIS'] as const;
export type SectionCode = (typeof SECTION_CODES)[number];
export type SectionParty = 'EMPLOYEE' | 'MANAGER';

export interface SectionDefinition {
  code: SectionCode;
  title: string;
  meaning: string;
  /** Who fills it, in process order. */
  filledBy: readonly SectionParty[];
  /** What each party is asked for. */
  prompts: Partial<Record<SectionParty, string>>;
  scored: false;
}

export const SECTIONS: readonly SectionDefinition[] = [
  {
    code: 'IMPROVEMENT_AREAS',
    title: 'Areas for improvement',
    meaning: 'Where the employee should improve during the next cycle, and the change expected.',
    filledBy: ['MANAGER'],
    prompts: { MANAGER: 'The areas the employee should improve and the change you expect.' },
    scored: false,
  },
  {
    code: 'TRAINING_NEEDS',
    title: 'Training needs',
    meaning: 'Training or development the employee needs. The manager’s recommendation is offered to training planning as a suggestion; nobody is enrolled by it.',
    filledBy: ['EMPLOYEE', 'MANAGER'],
    prompts: { EMPLOYEE: 'The training or development you think you need, and why.', MANAGER: 'The training or development you recommend for the employee.' },
    scored: false,
  },
  {
    code: 'ACTIVITY_PERFORMANCE',
    title: 'Activity performance',
    meaning: 'Key activities, assignments or projects outside the goals during the cycle, and how they went.',
    filledBy: ['EMPLOYEE', 'MANAGER'],
    prompts: { EMPLOYEE: 'The main activities, assignments or projects outside your goals, and what they delivered.', MANAGER: 'Your assessment of those activities.' },
    scored: false,
  },
  {
    code: 'STRETCHED_KPIS',
    title: 'Stretched KPIs',
    meaning: 'Stretch targets beyond the goal targets, and what was achieved against them. They add context; they never lower or raise the score.',
    filledBy: ['EMPLOYEE', 'MANAGER'],
    prompts: { EMPLOYEE: 'The stretch targets you worked towards and what you achieved.', MANAGER: 'Your assessment of the stretch achievement.' },
    scored: false,
  },
];

const BY_CODE = new Map(SECTIONS.map((s) => [s.code, s]));

export const sectionOf = (code: string): SectionDefinition | undefined => BY_CODE.get(code as SectionCode);
export const isSectionCode = (code: string): code is SectionCode => BY_CODE.has(code as SectionCode);
export const partyFills = (code: string, party: SectionParty): boolean => sectionOf(code)?.filledBy.includes(party) ?? false;

/** The cycle's sections in catalogue order (the stored order is not significant). */
export const orderedSections = (codes: readonly string[]): SectionDefinition[] => SECTIONS.filter((s) => codes.includes(s.code));
