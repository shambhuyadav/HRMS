// Appraisal settings and cycles (FR-040; F1 "financial-year cycle"; E11 "Appraisal Config"; DB063).
// The company sets the first month of its financial-year cycle (an explained quarter-start month: 1, 4, 7 or 10;
// no default). A cycle runs twelve months from the first day of that month and carries its inclusive goal-setting,
// self-entry and manager-rating windows, in process order, and its reviewer confirmation levels (one by default, a
// second only when set explicitly, F1). Code and period never change; levels are fixed once an appraisal of the cycle
// has been submitted; a cycle closes only when every appraisal in it is finished.
//
// Process rules decided under owner delegation, 6 Nov 2026 (owner chose process rules only; I-77), each set per cycle and
// fixed, like the levels, once an appraisal of the cycle has been submitted:
// * reviewer levels may be 0 (BR-013 one-level manager review: the manager's approval completes the appraisal, FR-043);
// * goal review (FR-041 "KRA Review"): required by default, so goals take effect only once someone other than their
//   setter has reviewed them;
// * rating mode (FR-042): FORMULA (F1 weighted manager result, the default) or MANUAL (the manager's overall rating);
// * the review due date: when the cycle has reviewer levels, the date their confirmations are due, required because the
//   BRD gives no period and practice sets it per cycle (I-40 item 6). It is not a window: a late confirmation is overdue,
//   not refused. It cannot fall before the manager-rating window closes.
//
// Competencies and sections, decided under owner delegation, 6 Nov 2026 (I-86), set per cycle and fixed, like the rules above,
// once an appraisal of the cycle has been submitted:
// * the scoring split (goals / competencies, whole percentages adding to 100): the dated company setting in force on the cycle's
//   start date unless HR gives another; competencies 0 means the cycle does not assess them. Whether it does is fixed once an
//   appraisal is enrolled (competencies are copied at enrolment);
// * the FR-042 sections the cycle includes (none by default; sections.ts).
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { audit, CYCLE_COLUMNS, type CycleRow, loadCycle, type RatingMode, requireDate, requireUnrestricted, STAGES, type Stage, windowOf, windowStatus } from './common.js';
import { checkSplit, scoringInForce, type ScoringSplit } from './competencies.js';
import { isSectionCode, orderedSections, SECTIONS } from './sections.js';

export const CYCLE_START_MONTHS = [1, 4, 7, 10] as const;

export async function getSetting(db: Queryable, grant: AccessGrant) {
  const row = (await db.query<{ cycle_start_month: number; version: number }>(`select cycle_start_month, version from appraisal_setting where company_id = $1`, [grant.companyId])).rows[0];
  return row
    ? { configured: true, cycleStartMonth: row.cycle_start_month, version: row.version }
    : { configured: false, cycleStartMonth: null, version: null, missing: ['cycleStartMonth'] };
}

export async function putSetting(tx: Queryable, grant: AccessGrant, input: { cycleStartMonth: number; expectedVersion?: number | undefined }) {
  requireUnrestricted(grant);
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('appraisal_setting:' || $1, 0))`, [grant.companyId]);
  const before = (await tx.query<{ id: string; cycle_start_month: number; version: number }>(`select id, cycle_start_month, version from appraisal_setting where company_id = $1`, [grant.companyId])).rows[0];
  if (before) {
    if (input.expectedVersion === undefined || input.expectedVersion !== before.version) throw new HttpError(409, 'STALE_VERSION', 'The setting changed; reload and retry');
    if (before.cycle_start_month !== input.cycleStartMonth) {
      await tx.query(`update appraisal_setting set cycle_start_month = $2, updated_by = $3 where company_id = $1`, [grant.companyId, input.cycleStartMonth, grant.userId]);
      await audit(tx, grant, 'appraisal_setting', before.id, 'UPDATE', { cycleStartMonth: before.cycle_start_month }, { cycleStartMonth: input.cycleStartMonth });
    }
  } else {
    if (input.expectedVersion !== undefined) throw new HttpError(409, 'STALE_VERSION', 'The setting changed; reload and retry');
    const id = (
      await tx.query<{ id: string }>(`insert into appraisal_setting (company_id, cycle_start_month, created_by, updated_by) values ($1, $2, $3, $3) returning id`, [
        grant.companyId,
        input.cycleStartMonth,
        grant.userId,
      ])
    ).rows[0]!.id;
    await audit(tx, grant, 'appraisal_setting', id, 'CREATE', null, { cycleStartMonth: input.cycleStartMonth });
  }
  return getSetting(tx, grant);
}

export interface WindowInput {
  opensOn: string;
  closesOn: string;
}

export interface WindowsInput {
  goalSetting?: WindowInput | null | undefined;
  selfEntry?: WindowInput | null | undefined;
  managerRating?: WindowInput | null | undefined;
}

const WINDOW_KEYS: Record<Stage, keyof WindowsInput> = { GOAL_SETTING: 'goalSetting', SELF_ENTRY: 'selfEntry', MANAGER_RATING: 'managerRating' };

/** Validates the windows: real dates, opens on or before closes, and process order (goals, self-entry, rating). */
function checkWindows(input: WindowsInput): Record<Stage, WindowInput | null> {
  const out = {} as Record<Stage, WindowInput | null>;
  for (const stage of STAGES) {
    const w = input[WINDOW_KEYS[stage]] ?? null;
    if (w) {
      requireDate(w.opensOn, `${WINDOW_KEYS[stage]}.opensOn`);
      requireDate(w.closesOn, `${WINDOW_KEYS[stage]}.closesOn`);
      if (w.closesOn < w.opensOn) throw new HttpError(422, 'INVALID_WINDOW', 'A window cannot close before it opens', { stage });
    }
    out[stage] = w ? { opensOn: w.opensOn, closesOn: w.closesOn } : null;
  }
  // FR-040 "align KRA and appraisal windows": a later stage neither opens nor closes before an earlier one.
  for (let i = 0; i < STAGES.length; i++) {
    for (let j = i + 1; j < STAGES.length; j++) {
      const earlier = out[STAGES[i]!];
      const later = out[STAGES[j]!];
      if (earlier && later && (later.opensOn < earlier.opensOn || later.closesOn < earlier.closesOn)) {
        throw new HttpError(422, 'WINDOW_ORDER', 'Windows follow the process order: goal setting, then self-entry, then manager rating', { earlier: STAGES[i], later: STAGES[j] });
      }
    }
  }
  return out;
}

const plusYearMinusDay = async (db: Queryable, start: string) =>
  (await db.query<{ d: string }>(`select to_char(($1::date + interval '1 year' - interval '1 day')::date, 'YYYY-MM-DD') as d`, [start])).rows[0]!.d;

export type ApprovalLevels = 0 | 1 | 2;

/**
 * The review due date (I-77 item 5): required when the cycle has reviewer levels, unused without them, and never before
 * the manager-rating window closes (reviewers confirm a submitted rating).
 */
function checkReviewDue(levels: number, value: string | null, w: Record<Stage, WindowInput | null>): string | null {
  if (levels === 0) {
    if (value !== null) throw new HttpError(422, 'REVIEW_DUE_NOT_USED', 'A cycle without reviewer levels has no reviewer confirmations to date', { field: 'reviewDueOn' });
    return null;
  }
  if (value === null) throw new HttpError(422, 'REVIEW_DUE_REQUIRED', 'Set the date reviewer confirmations are due', { field: 'reviewDueOn', missing: ['reviewDueOn'] });
  requireDate(value, 'reviewDueOn');
  const rating = w.MANAGER_RATING;
  if (rating && value < rating.closesOn) throw new HttpError(422, 'REVIEW_DUE_BEFORE_RATING', 'Reviewer confirmations cannot be due before the manager-rating window closes', { ratingClosesOn: rating.closesOn });
  return value;
}

/** FR-042: known section codes, each once, in catalogue order. */
function cleanSections(codes: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const code of codes) {
    if (!isSectionCode(code)) throw new HttpError(422, 'UNKNOWN_SECTION', 'Choose sections from the appraisal section catalogue', { section: code });
    if (seen.has(code)) throw new HttpError(422, 'DUPLICATE_SECTION', 'Each section is included once', { section: code });
    seen.add(code);
  }
  return SECTIONS.filter((s) => seen.has(s.code)).map((s) => s.code);
}

/** The cycle's split: both percentages given (checked), or neither (null). */
function splitInput(input: { goalWeightPercent?: number | undefined; competencyWeightPercent?: number | undefined }): ScoringSplit | null {
  if (input.goalWeightPercent === undefined && input.competencyWeightPercent === undefined) return null;
  if (input.goalWeightPercent === undefined || input.competencyWeightPercent === undefined) {
    throw new HttpError(422, 'SPLIT_NOT_100', 'Give both the goal and the competency percentage, adding up to exactly 100', { missing: [input.goalWeightPercent === undefined ? 'goalWeightPercent' : 'competencyWeightPercent'] });
  }
  return checkSplit({ goalWeightPercent: input.goalWeightPercent, competencyWeightPercent: input.competencyWeightPercent });
}

export interface CycleInput {
  code: string;
  name: string;
  startDate: string;
  approvalLevels?: ApprovalLevels | undefined;
  windows?: WindowsInput | undefined;
  goalReviewRequired?: boolean | undefined;
  ratingMode?: RatingMode | undefined;
  reviewDueOn?: string | null | undefined;
  /** I-86: omitted, the dated company split in force on the start date. */
  goalWeightPercent?: number | undefined;
  competencyWeightPercent?: number | undefined;
  /** FR-042 sections included (none when omitted). */
  sections?: string[] | undefined;
}

export async function createCycle(tx: Queryable, grant: AccessGrant, input: CycleInput): Promise<string> {
  requireUnrestricted(grant);
  const setting = (await tx.query<{ m: number }>(`select cycle_start_month as m from appraisal_setting where company_id = $1`, [grant.companyId])).rows[0];
  if (!setting) throw new HttpError(422, 'APPRAISAL_NOT_CONFIGURED', 'Set the appraisal cycle start month before creating a cycle', { missing: ['cycleStartMonth'] });
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code)) throw new HttpError(422, 'INVALID_CODE', 'Use 1 to 40 letters, digits, hyphens or underscores', { field: 'code' });
  const name = input.name.trim();
  if (!name) throw new HttpError(422, 'FIELD_REQUIRED', 'name is required', { field: 'name' });
  const start = requireDate(input.startDate, 'startDate');
  // F1 financial-year cycle starting on the first day of the configured month.
  if (start.slice(8) !== '01' || Number(start.slice(5, 7)) !== setting.m) {
    throw new HttpError(422, 'CYCLE_START_NOT_ALIGNED', 'A cycle starts on the first day of the configured cycle start month', { cycleStartMonth: setting.m });
  }
  const end = await plusYearMinusDay(tx, start);
  const w = checkWindows(input.windows ?? {});
  // F1 "One reviewer step is the default"; I-77: goal review required and formula rating unless the cycle says otherwise.
  const levels = input.approvalLevels ?? 1;
  const goalReviewRequired = input.goalReviewRequired ?? true;
  const ratingMode = input.ratingMode ?? 'FORMULA';
  const reviewDueOn = checkReviewDue(levels, input.reviewDueOn ?? null, w);
  // I-86: the dated company split in force on the cycle's start date, unless HR gives the cycle its own.
  const split = splitInput(input) ?? (await scoringInForce(tx, grant.companyId, start));
  if (!split) throw new HttpError(422, 'APPRAISAL_SCORING_NOT_CONFIGURED', 'No goal and competency split is in force on the cycle start date; set one first', { missing: ['scoringSplit'] });
  const sections = cleanSections(input.sections ?? []);
  const exists = await tx.query(`select 1 from appraisal_cycle where company_id = $1 and code = $2`, [grant.companyId, code]);
  if (exists.rowCount) throw new HttpError(409, 'CYCLE_CODE_EXISTS', 'A cycle with this code already exists');
  const id = (
    await tx.query<{ id: string }>(
      `insert into appraisal_cycle (company_id, code, name, start_date, end_date, approval_levels, goal_opens_on, goal_closes_on, self_opens_on, self_closes_on,
                                    rating_opens_on, rating_closes_on, goal_review_required, rating_mode, review_due_on, goal_weight_percent,
                                    competency_weight_percent, sections, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $17, $18, $19, $16, $16) returning id`,
      [
        grant.companyId,
        code,
        name,
        start,
        end,
        levels,
        w.GOAL_SETTING?.opensOn ?? null,
        w.GOAL_SETTING?.closesOn ?? null,
        w.SELF_ENTRY?.opensOn ?? null,
        w.SELF_ENTRY?.closesOn ?? null,
        w.MANAGER_RATING?.opensOn ?? null,
        w.MANAGER_RATING?.closesOn ?? null,
        goalReviewRequired,
        ratingMode,
        reviewDueOn,
        grant.userId,
        split.goalWeightPercent,
        split.competencyWeightPercent,
        sections,
      ],
    )
  ).rows[0]!.id;
  await audit(tx, grant, 'appraisal_cycle', id, 'CREATE', null, {
    code,
    name,
    startDate: start,
    endDate: end,
    approvalLevels: levels,
    windows: w,
    goalReviewRequired,
    ratingMode,
    reviewDueOn,
    scoringSplit: split,
    sections,
  });
  return id;
}

const windowsOf = (c: CycleRow) => Object.fromEntries(STAGES.map((s) => [s, windowOf(c, s).opensOn ? windowOf(c, s) : null])) as Record<Stage, { opensOn: string | null; closesOn: string | null } | null>;

export interface CycleUpdate {
  name: string;
  approvalLevels: ApprovalLevels;
  windows: WindowsInput;
  expectedVersion: number;
  /** Omitted: unchanged. */
  goalReviewRequired?: boolean | undefined;
  ratingMode?: RatingMode | undefined;
  /** Omitted: unchanged; null: not scheduled (only without reviewer levels). */
  reviewDueOn?: string | null | undefined;
  /** I-86, omitted: unchanged (both or neither). */
  goalWeightPercent?: number | undefined;
  competencyWeightPercent?: number | undefined;
  /** FR-042, omitted: unchanged. */
  sections?: string[] | undefined;
}

export async function updateCycle(tx: Queryable, grant: AccessGrant, id: string, input: CycleUpdate): Promise<void> {
  requireUnrestricted(grant);
  const c = await loadCycle(tx, grant.companyId, id, 'for update');
  if (!c) throw notFound();
  if (c.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The cycle changed; reload and retry');
  if (c.state !== 'OPEN') throw new HttpError(409, 'CYCLE_CLOSED', 'A closed cycle cannot change');
  const name = input.name.trim();
  if (!name) throw new HttpError(422, 'FIELD_REQUIRED', 'name is required', { field: 'name' });
  const w = checkWindows(input.windows);
  const goalReviewRequired = input.goalReviewRequired ?? c.goal_review_required;
  const ratingMode = input.ratingMode ?? c.rating_mode;
  const reviewDueOn = checkReviewDue(input.approvalLevels, input.reviewDueOn === undefined ? c.review_due_on : input.reviewDueOn, w);
  const split = splitInput(input) ?? { goalWeightPercent: c.goal_weight_percent, competencyWeightPercent: c.competency_weight_percent };
  const sections = input.sections === undefined ? c.sections : cleanSections(input.sections);
  const levelsChanged = input.approvalLevels !== c.approval_levels;
  const splitChanged = split.goalWeightPercent !== c.goal_weight_percent;
  const sectionsChanged = sections.length !== c.sections.length || sections.some((s) => !c.sections.includes(s));
  const rulesChanged = goalReviewRequired !== c.goal_review_required || ratingMode !== c.rating_mode || splitChanged || sectionsChanged;
  if (levelsChanged || rulesChanged) {
    const submitted = await tx.query(
      `select 1 from appraisal_revision r join appraisal a on a.company_id = r.company_id and a.id = r.appraisal_id
        where a.company_id = $1 and a.cycle_id = $2 and r.submitted_at is not null limit 1`,
      [grant.companyId, id],
    );
    if (submitted.rowCount && levelsChanged) throw new HttpError(409, 'LEVELS_FIXED', 'Reviewer levels cannot change once an appraisal of the cycle has been submitted');
    if (submitted.rowCount) throw new HttpError(409, 'RULES_FIXED', 'Goal review, the rating mode, the scoring split and the sections cannot change once an appraisal of the cycle has been submitted');
  }
  // Competencies are copied at enrolment: whether the cycle assesses them is fixed once an appraisal is enrolled.
  if (split.competencyWeightPercent > 0 !== c.competency_weight_percent > 0) {
    const enrolled = await tx.query(`select 1 from appraisal where company_id = $1 and cycle_id = $2 limit 1`, [grant.companyId, id]);
    if (enrolled.rowCount) throw new HttpError(409, 'COMPETENCY_USE_FIXED', 'Whether the cycle assesses competencies cannot change once an appraisal is enrolled in it');
  }
  await tx.query(
    `update appraisal_cycle set name = $3, approval_levels = $4, goal_opens_on = $5, goal_closes_on = $6, self_opens_on = $7, self_closes_on = $8,
            rating_opens_on = $9, rating_closes_on = $10, goal_review_required = $11, rating_mode = $12, review_due_on = $13, updated_by = $14,
            goal_weight_percent = $15, competency_weight_percent = $16, sections = $17
      where company_id = $1 and id = $2`,
    [
      grant.companyId,
      id,
      name,
      input.approvalLevels,
      w.GOAL_SETTING?.opensOn ?? null,
      w.GOAL_SETTING?.closesOn ?? null,
      w.SELF_ENTRY?.opensOn ?? null,
      w.SELF_ENTRY?.closesOn ?? null,
      w.MANAGER_RATING?.opensOn ?? null,
      w.MANAGER_RATING?.closesOn ?? null,
      goalReviewRequired,
      ratingMode,
      reviewDueOn,
      grant.userId,
      split.goalWeightPercent,
      split.competencyWeightPercent,
      sections,
    ],
  );
  await audit(
    tx,
    grant,
    'appraisal_cycle',
    id,
    'UPDATE',
    {
      name: c.name,
      approvalLevels: c.approval_levels,
      windows: windowsOf(c),
      goalReviewRequired: c.goal_review_required,
      ratingMode: c.rating_mode,
      reviewDueOn: c.review_due_on,
      scoringSplit: { goalWeightPercent: c.goal_weight_percent, competencyWeightPercent: c.competency_weight_percent },
      sections: c.sections,
    },
    { name, approvalLevels: input.approvalLevels, windows: w, goalReviewRequired, ratingMode, reviewDueOn, scoringSplit: split, sections },
  );
}

export async function closeCycle(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }): Promise<void> {
  requireUnrestricted(grant);
  // The row lock serialises closing with appraisal creation (which takes it in share mode).
  const c = await loadCycle(tx, grant.companyId, id, 'for update');
  if (!c) throw notFound();
  if (c.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The cycle changed; reload and retry');
  if (c.state !== 'OPEN') throw new HttpError(409, 'CYCLE_CLOSED', 'The cycle is already closed');
  const open = (await tx.query<{ n: number }>(`select count(*)::int as n from appraisal where company_id = $1 and cycle_id = $2 and state not in ('APPROVED', 'CANCELLED')`, [grant.companyId, id]))
    .rows[0]!.n;
  if (open > 0) throw new HttpError(409, 'OPEN_APPRAISALS', 'Complete or cancel every appraisal of the cycle before closing it', { open });
  await tx.query(`update appraisal_cycle set state = 'CLOSED', closed_by = $3, closed_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, id, grant.userId]);
  await audit(tx, grant, 'appraisal_cycle', id, 'CLOSE', { state: 'OPEN' }, { state: 'CLOSED' });
}

/** The cycle as shown (operational): period, levels, windows with today's status. */
export function presentCycle(c: CycleRow, today: string) {
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    startDate: c.start_date,
    endDate: c.end_date,
    approvalLevels: c.approval_levels,
    goalReviewRequired: c.goal_review_required,
    ratingMode: c.rating_mode,
    reviewDueOn: c.review_due_on,
    // I-86: how the weighted result combines goals and competencies (competencies 0: not assessed, the goal result alone).
    scoring: { goalWeightPercent: c.goal_weight_percent, competencyWeightPercent: c.competency_weight_percent, competenciesAssessed: c.competency_weight_percent > 0 },
    // FR-042: the sections the cycle includes, with their meaning and who fills them (none are scored).
    sections: orderedSections(c.sections),
    state: c.state,
    windows: Object.fromEntries(
      STAGES.map((s) => {
        const st = windowStatus(c, s, today, {});
        return [WINDOW_KEYS[s], st.opensOn ? { opensOn: st.opensOn, closesOn: st.closesOn, openToday: st.openToday } : null];
      }),
    ),
    version: c.version,
  };
}

export async function getCycle(db: Queryable, grant: AccessGrant, id: string) {
  const c = await loadCycle(db, grant.companyId, id);
  if (!c) throw notFound();
  return presentCycle(c, grant.businessDate);
}

export async function listCycles(db: Queryable, grant: AccessGrant, q: { state?: 'OPEN' | 'CLOSED' | undefined }) {
  const rows = (
    await db.query<CycleRow>(`select ${CYCLE_COLUMNS} from appraisal_cycle c where c.company_id = $1 and ($2::text is null or c.state = $2) order by c.start_date desc, c.code limit 200`, [
      grant.companyId,
      q.state ?? null,
    ])
  ).rows;
  return { items: rows.map((c) => presentCycle(c, grant.businessDate)) };
}

export { WINDOW_KEYS };
