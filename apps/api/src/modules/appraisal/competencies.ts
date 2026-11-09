// Appraisal Config masters for competencies and scoring (FR-041 "grade-mapped competencies"; FR-042; BR-014; E11 "Grade
// competency mapping"; CL-123 "Competency Config"; OQ-10; migration 0230). Decided under owner delegation, 6 Nov 2026 (I-86):
//
// * The scoring split: a dated company setting of whole percentages adding to 100 (goals 1..100, competencies 0..99; 70 / 30 from
//   2000-01-01 by default). A new revision starts today or later and ends the open one that day; history is never rewritten. A new
//   cycle takes the split in force on its start date (HR may set another on the cycle until its first submission).
// * The competency master: a permanent code, a name, a description, one behavioural indicator per proficiency level 1..5 (the F1
//   scale) and active dates [from, to).
// * The mapping: dated sets per grade, optionally narrowed to one designation (the narrower set applies), each with whole-number
//   competency weights totalling exactly 100, as goals do (F1), so the competency result is exact at two decimals. A new set
//   starts today or later and ends the open one of the same grade and designation that day; a set is fixed once written.
// * Enrolment copies the set in force for the employee's grade and designation on the enrolment day into the appraisal, where the
//   competencies stay fixed (code, name, description, indicators and weight as copied). No set, no grade, or a cycle that does not
//   assess competencies: none are copied and the result is the goal result alone.
// Everything here is operational configuration in the Appraisal Config duty (appraisal_cycle.read / appraisal_cycle.manage), and
// company-wide changes need an unrestricted company-scope assignment, like the cycle start month. Audited as appraisal_setting.
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { audit, isIsoDate, optionalText, requireText, requireUnrestricted } from './common.js';

const CODE = /^[A-Z0-9][A-Z0-9_-]{0,39}$/;
const LEVELS = 5;

function requireDay(value: string, field: string): string {
  if (!isIsoDate(value)) throw new HttpError(422, 'INVALID_DATE', 'The date is not a valid calendar date', { field });
  return value;
}

function requireFromToday(grant: AccessGrant, day: string, field: string): string {
  requireDay(day, field);
  if (day < grant.businessDate) throw new HttpError(422, 'EFFECTIVE_DATE_IN_PAST', 'A new revision starts today or later; earlier periods are not changed', { field });
  return day;
}

// ---------------------------------------------------------------------------------------------------------
// Dated scoring split
// ---------------------------------------------------------------------------------------------------------

export interface ScoringSplit {
  goalWeightPercent: number;
  competencyWeightPercent: number;
}

interface ScoringRow {
  id: string;
  effective_from: string;
  effective_to: string | null;
  goal_weight_percent: number;
  competency_weight_percent: number;
  reason: string;
  created_at: Date;
  version: number;
}

const SCORING_COLUMNS = `id, to_char(effective_from, 'YYYY-MM-DD') as effective_from, to_char(effective_to, 'YYYY-MM-DD') as effective_to,
  goal_weight_percent, competency_weight_percent, reason, created_at, version`;

const presentScoring = (r: ScoringRow) => ({
  id: r.id,
  effectiveFrom: r.effective_from,
  effectiveTo: r.effective_to,
  goalWeightPercent: r.goal_weight_percent,
  competencyWeightPercent: r.competency_weight_percent,
  reason: r.reason,
  createdAt: r.created_at,
  version: r.version,
});

/** Whole percentages adding to 100: goals 1..100, competencies 0..99 (0 = competencies are not assessed). */
export function checkSplit(split: ScoringSplit): ScoringSplit {
  const { goalWeightPercent: g, competencyWeightPercent: c } = split;
  if (!Number.isInteger(g) || !Number.isInteger(c) || g < 1 || g > 100 || c < 0 || c > 99 || g + c !== 100) {
    throw new HttpError(422, 'SPLIT_NOT_100', 'The goal and competency percentages are whole numbers that add up to exactly 100 (goals at least 1)', {
      goalWeightPercent: g,
      competencyWeightPercent: c,
    });
  }
  return { goalWeightPercent: g, competencyWeightPercent: c };
}

/** The split in force on a day, if any revision covers it. */
export async function scoringInForce(db: Queryable, companyId: string, day: string): Promise<ScoringSplit | undefined> {
  const r = (
    await db.query<{ g: number; c: number }>(
      `select goal_weight_percent as g, competency_weight_percent as c from appraisal_scoring_setting
        where company_id = $1 and effective_from <= $2::date and (effective_to is null or effective_to > $2::date)`,
      [companyId, day],
    )
  ).rows[0];
  return r ? { goalWeightPercent: r.g, competencyWeightPercent: r.c } : undefined;
}

export async function listScoringSettings(db: Queryable, grant: AccessGrant) {
  const items = (await db.query<ScoringRow>(`select ${SCORING_COLUMNS} from appraisal_scoring_setting where company_id = $1 order by effective_from desc`, [grant.companyId])).rows;
  return { businessDate: grant.businessDate, inForce: (await scoringInForce(db, grant.companyId, grant.businessDate)) ?? null, items: items.map(presentScoring) };
}

export async function startScoringRevision(tx: Queryable, grant: AccessGrant, body: ScoringSplit & { effectiveFrom: string; reason: string }) {
  requireUnrestricted(grant);
  const split = checkSplit(body);
  const from = requireFromToday(grant, body.effectiveFrom, 'effectiveFrom');
  const reason = requireText(body.reason, 'reason');
  const rows = (await tx.query<ScoringRow>(`select ${SCORING_COLUMNS} from appraisal_scoring_setting where company_id = $1 order by effective_from for update`, [grant.companyId])).rows;
  if (rows.some((r) => r.effective_from >= from)) throw new HttpError(409, 'REVISION_ALREADY_PLANNED', 'A revision already starts on or after that date; choose a later start date');
  const open = rows.find((r) => r.effective_to === null);
  if (open) {
    await tx.query(`update appraisal_scoring_setting set effective_to = $3::date, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, open.id, from, grant.userId]);
    await audit(tx, grant, 'appraisal_setting', open.id, 'UPDATE', { scoringSplitEffectiveTo: null }, { scoringSplitEffectiveTo: from }, reason);
  }
  const created = (
    await tx.query<ScoringRow>(
      `insert into appraisal_scoring_setting (company_id, effective_from, goal_weight_percent, competency_weight_percent, reason, created_by, updated_by)
       values ($1, $2::date, $3, $4, $5, $6, $6) returning ${SCORING_COLUMNS}`,
      [grant.companyId, from, split.goalWeightPercent, split.competencyWeightPercent, reason, grant.userId],
    )
  ).rows[0]!;
  await audit(tx, grant, 'appraisal_setting', created.id, 'CREATE', null, { scoringSplit: { effectiveFrom: from, ...split } }, reason);
  return presentScoring(created);
}

// ---------------------------------------------------------------------------------------------------------
// Competency master
// ---------------------------------------------------------------------------------------------------------

interface CompetencyRow {
  id: string;
  code: string;
  name: string;
  description: string | null;
  indicators: string[];
  active_from: string;
  active_to: string | null;
  version: number;
  set_count: number;
}

const COMPETENCY_COLUMNS = `k.id, k.code, k.name, k.description, k.indicators, to_char(k.active_from, 'YYYY-MM-DD') as active_from,
  to_char(k.active_to, 'YYYY-MM-DD') as active_to, k.version,
  (select count(distinct si.set_id)::int from appraisal_competency_set_item si where si.company_id = k.company_id and si.competency_id = k.id) as set_count`;

const presentCompetency = (k: CompetencyRow, today: string) => ({
  id: k.id,
  code: k.code,
  name: k.name,
  description: k.description,
  /** Behavioural indicators of proficiency levels 1..5 (position n describes level n). */
  indicators: k.indicators.map((text, i) => ({ level: i + 1, text })),
  activeFrom: k.active_from,
  activeTo: k.active_to,
  activeToday: k.active_from <= today && (k.active_to === null || today < k.active_to),
  usedInSets: k.set_count,
  version: k.version,
});

function cleanIndicators(indicators: readonly string[]): string[] {
  const out = indicators.map((t) => optionalText(t));
  if (out.length !== LEVELS || out.some((t) => t === null || t.length > 1000)) {
    throw new HttpError(422, 'INVALID_INDICATORS', 'Describe each proficiency level 1 to 5 with one behavioural indicator (at most 1000 characters each)', { levels: LEVELS });
  }
  return out as string[];
}

function cleanName(value: string): string {
  const name = requireText(value, 'name');
  if (name.length > 200) throw new HttpError(422, 'FIELD_TOO_LONG', 'The name has at most 200 characters', { field: 'name' });
  return name;
}

async function loadCompetency(db: Queryable, companyId: string, id: string, lock = false): Promise<CompetencyRow | undefined> {
  return (await db.query<CompetencyRow>(`select ${COMPETENCY_COLUMNS} from appraisal_competency k where k.company_id = $1 and k.id = $2 ${lock ? 'for update' : ''}`, [companyId, id])).rows[0];
}

export interface CompetencyInput {
  code: string;
  name: string;
  description?: string | null | undefined;
  indicators: string[];
  activeFrom: string;
}

export async function createCompetency(tx: Queryable, grant: AccessGrant, input: CompetencyInput): Promise<string> {
  requireUnrestricted(grant);
  const code = input.code.trim().toUpperCase();
  if (!CODE.test(code)) throw new HttpError(422, 'INVALID_CODE', 'Use 1 to 40 letters, digits, hyphens or underscores', { field: 'code' });
  const name = cleanName(input.name);
  const description = optionalText(input.description ?? null);
  const indicators = cleanIndicators(input.indicators);
  const activeFrom = requireDay(input.activeFrom, 'activeFrom');
  if ((await tx.query(`select 1 from appraisal_competency where company_id = $1 and code = $2`, [grant.companyId, code])).rowCount) {
    throw new HttpError(409, 'COMPETENCY_CODE_EXISTS', 'A competency with this code already exists');
  }
  const id = (
    await tx.query<{ id: string }>(
      `insert into appraisal_competency (company_id, code, name, description, indicators, active_from, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
      [grant.companyId, code, name, description, indicators, activeFrom, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, grant, 'appraisal_setting', id, 'CREATE', null, { competency: { code, name, description, indicators, activeFrom } });
  return id;
}

export interface CompetencyUpdate {
  name: string;
  description?: string | null | undefined;
  indicators: string[];
  activeFrom: string;
  activeTo: string | null;
  expectedVersion: number;
}

export async function updateCompetency(tx: Queryable, grant: AccessGrant, id: string, input: CompetencyUpdate): Promise<void> {
  requireUnrestricted(grant);
  const k = await loadCompetency(tx, grant.companyId, id, true);
  if (!k) throw notFound();
  if (k.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The competency changed; reload and retry');
  const name = cleanName(input.name);
  const description = optionalText(input.description ?? null);
  const indicators = cleanIndicators(input.indicators);
  const activeFrom = requireDay(input.activeFrom, 'activeFrom');
  const activeTo = input.activeTo === null ? null : requireDay(input.activeTo, 'activeTo');
  if (activeTo !== null && activeTo <= activeFrom) throw new HttpError(422, 'INVALID_DATE_RANGE', 'A competency ends after it starts', { field: 'activeTo' });
  if (activeFrom !== k.active_from && k.set_count > 0) throw new HttpError(409, 'COMPETENCY_IN_USE', 'The start of a competency used in a set is fixed');
  if (activeTo !== k.active_to) {
    if (k.active_to !== null) throw new HttpError(409, 'COMPETENCY_ENDED', 'An ended competency stays ended; add a new competency instead');
    const blocking = (
      await tx.query<{ n: number }>(
        `select count(distinct s.id)::int as n from appraisal_competency_set_item si join appraisal_competency_set s on s.company_id = si.company_id and s.id = si.set_id
          where si.company_id = $1 and si.competency_id = $2 and (s.effective_to is null or s.effective_to > $3::date)`,
        [grant.companyId, id, activeTo],
      )
    ).rows[0]!.n;
    if (blocking > 0) throw new HttpError(409, 'COMPETENCY_IN_USE', 'Replace or end every set using this competency before ending it', { sets: blocking });
  }
  await tx.query(
    `update appraisal_competency set name = $3, description = $4, indicators = $5, active_from = $6, active_to = $7, updated_by = $8 where company_id = $1 and id = $2`,
    [grant.companyId, id, name, description, indicators, activeFrom, activeTo, grant.userId],
  );
  await audit(
    tx,
    grant,
    'appraisal_setting',
    id,
    'UPDATE',
    { competency: { name: k.name, description: k.description, indicators: k.indicators, activeFrom: k.active_from, activeTo: k.active_to } },
    { competency: { name, description, indicators, activeFrom, activeTo } },
  );
}

export async function listCompetencies(db: Queryable, grant: AccessGrant) {
  const rows = (await db.query<CompetencyRow>(`select ${COMPETENCY_COLUMNS} from appraisal_competency k where k.company_id = $1 order by k.code limit 500`, [grant.companyId])).rows;
  return { items: rows.map((k) => presentCompetency(k, grant.businessDate)) };
}

export async function getCompetency(db: Queryable, grant: AccessGrant, id: string) {
  const k = await loadCompetency(db, grant.companyId, id);
  if (!k) throw notFound();
  return presentCompetency(k, grant.businessDate);
}

// ---------------------------------------------------------------------------------------------------------
// Dated grade (and designation) mapping
// ---------------------------------------------------------------------------------------------------------

interface SetRow {
  id: string;
  grade_id: string;
  grade_code: string;
  grade_name: string;
  designation_id: string | null;
  designation_code: string | null;
  designation_name: string | null;
  effective_from: string;
  effective_to: string | null;
  reason: string;
  version: number;
  items: { competencyId: string; code: string; name: string; sequence: number; weight: number }[];
}

const SET_SELECT = `select s.id, s.grade_id, g.code as grade_code, g.name as grade_name, s.designation_id, d.code as designation_code, d.name as designation_name,
         to_char(s.effective_from, 'YYYY-MM-DD') as effective_from, to_char(s.effective_to, 'YYYY-MM-DD') as effective_to, s.reason, s.version,
         coalesce((select json_agg(json_build_object('competencyId', k.id, 'code', k.code, 'name', k.name, 'sequence', si.sequence, 'weight', si.weight) order by si.sequence)
                     from appraisal_competency_set_item si join appraisal_competency k on k.company_id = si.company_id and k.id = si.competency_id
                    where si.company_id = s.company_id and si.set_id = s.id), '[]'::json) as items
    from appraisal_competency_set s
    join grade g on g.company_id = s.company_id and g.id = s.grade_id
    left join designation d on d.company_id = s.company_id and d.id = s.designation_id`;

const presentSet = (s: SetRow, today: string) => ({
  id: s.id,
  grade: { id: s.grade_id, code: s.grade_code, name: s.grade_name },
  designation: s.designation_id ? { id: s.designation_id, code: s.designation_code, name: s.designation_name } : null,
  effectiveFrom: s.effective_from,
  effectiveTo: s.effective_to,
  inForceToday: s.effective_from <= today && (s.effective_to === null || today < s.effective_to),
  reason: s.reason,
  items: s.items,
  weightTotal: s.items.reduce((t, i) => t + i.weight, 0),
  version: s.version,
});

export async function listCompetencySets(db: Queryable, grant: AccessGrant, q: { gradeId?: string | undefined }) {
  const rows = (
    await db.query<SetRow>(`${SET_SELECT} where s.company_id = $1 and ($2::uuid is null or s.grade_id = $2) order by g.code, d.code nulls first, s.effective_from desc limit 500`, [
      grant.companyId,
      q.gradeId ?? null,
    ])
  ).rows;
  return { items: rows.map((s) => presentSet(s, grant.businessDate)) };
}

export async function getCompetencySet(db: Queryable, grant: AccessGrant, id: string) {
  const s = (await db.query<SetRow>(`${SET_SELECT} where s.company_id = $1 and s.id = $2`, [grant.companyId, id])).rows[0];
  if (!s) throw notFound();
  return presentSet(s, grant.businessDate);
}

export interface SetInput {
  gradeId: string;
  designationId?: string | null | undefined;
  effectiveFrom: string;
  items: { competencyId: string; weight: number }[];
  reason: string;
}

/**
 * A new set for a grade (and optionally one designation) from `effectiveFrom` (today or later). The open set of the same grade and
 * designation ends that day; a set already starting on or after it is refused, as is one that ends later than it (sets never
 * overlap, and a written set is never shortened).
 */
export async function createCompetencySet(tx: Queryable, grant: AccessGrant, input: SetInput): Promise<string> {
  requireUnrestricted(grant);
  const from = requireFromToday(grant, input.effectiveFrom, 'effectiveFrom');
  const reason = requireText(input.reason, 'reason');
  const designationId = input.designationId ?? null;
  if (!(await tx.query(`select 1 from grade where company_id = $1 and id = $2`, [grant.companyId, input.gradeId])).rowCount) {
    throw new HttpError(422, 'UNKNOWN_GRADE', 'The grade does not exist', { field: 'gradeId' });
  }
  if (designationId && !(await tx.query(`select 1 from designation where company_id = $1 and id = $2`, [grant.companyId, designationId])).rowCount) {
    throw new HttpError(422, 'UNKNOWN_DESIGNATION', 'The designation does not exist', { field: 'designationId' });
  }
  if (input.items.length === 0 || input.items.length > 50) throw new HttpError(422, 'COMPETENCIES_REQUIRED', 'A set holds 1 to 50 competencies');
  const seen = new Set<string>();
  for (const i of input.items) {
    if (seen.has(i.competencyId)) throw new HttpError(422, 'DUPLICATE_COMPETENCY', 'Each competency appears once in a set', { competencyId: i.competencyId });
    seen.add(i.competencyId);
    if (!Number.isInteger(i.weight) || i.weight < 1 || i.weight > 100) throw new HttpError(422, 'INVALID_WEIGHT', 'Competency weights are whole numbers 1 to 100', { competencyId: i.competencyId });
  }
  const total = input.items.reduce((t, i) => t + i.weight, 0);
  if (total !== 100) throw new HttpError(422, 'WEIGHT_TOTAL_NOT_100', 'Competency weights must total exactly 100', { total });
  const competencies = (
    await tx.query<{ id: string; active_from: string; active_to: string | null }>(
      `select id, to_char(active_from, 'YYYY-MM-DD') as active_from, to_char(active_to, 'YYYY-MM-DD') as active_to from appraisal_competency where company_id = $1 and id = any($2::uuid[])`,
      [grant.companyId, [...seen]],
    )
  ).rows;
  const byId = new Map(competencies.map((k) => [k.id, k]));
  for (const i of input.items) {
    const k = byId.get(i.competencyId);
    if (!k) throw new HttpError(422, 'UNKNOWN_COMPETENCY', 'The competency does not exist', { competencyId: i.competencyId });
    // An open set holds only competencies active from its start with no end date.
    if (k.active_from > from || k.active_to !== null) throw new HttpError(422, 'COMPETENCY_NOT_ACTIVE', 'Each competency is active from the set’s start, with no end date', { competencyId: i.competencyId });
  }

  await tx.query(`select pg_advisory_xact_lock(hashtextextended('appraisal_competency_set:' || $1 || ':' || $2 || ':' || coalesce($3::text, '-'), 0))`, [grant.companyId, input.gradeId, designationId]);
  const covering = (
    await tx.query<{ id: string; effective_from: string; effective_to: string | null }>(
      `select id, to_char(effective_from, 'YYYY-MM-DD') as effective_from, to_char(effective_to, 'YYYY-MM-DD') as effective_to from appraisal_competency_set
        where company_id = $1 and grade_id = $2 and designation_id is not distinct from $3::uuid and (effective_to is null or effective_to > $4::date)
        order by effective_from for update`,
      [grant.companyId, input.gradeId, designationId, from],
    )
  ).rows;
  if (covering.some((s) => s.effective_from >= from)) throw new HttpError(409, 'SET_ALREADY_PLANNED', 'A set for this grade and designation already starts on or after that date');
  for (const s of covering) {
    if (s.effective_to !== null) throw new HttpError(409, 'SET_OVERLAP', 'A set for this grade and designation is already in force past that date', { setId: s.id, effectiveTo: s.effective_to });
    await tx.query(`update appraisal_competency_set set effective_to = $3::date, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, s.id, from, grant.userId]);
    await audit(tx, grant, 'appraisal_setting', s.id, 'UPDATE', { competencySetEffectiveTo: null }, { competencySetEffectiveTo: from }, reason);
  }
  const id = (
    await tx.query<{ id: string }>(
      `insert into appraisal_competency_set (company_id, grade_id, designation_id, effective_from, reason, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $6) returning id`,
      [grant.companyId, input.gradeId, designationId, from, reason, grant.userId],
    )
  ).rows[0]!.id;
  for (const [n, i] of input.items.entries()) {
    await tx.query(`insert into appraisal_competency_set_item (company_id, set_id, competency_id, sequence, weight, created_by) values ($1, $2, $3, $4, $5, $6)`, [
      grant.companyId,
      id,
      i.competencyId,
      n + 1,
      i.weight,
      grant.userId,
    ]);
  }
  await audit(tx, grant, 'appraisal_setting', id, 'CREATE', null, { competencySet: { gradeId: input.gradeId, designationId, effectiveFrom: from, items: input.items } }, reason);
  return id;
}

/** Ends an open set on `effectiveTo` (after its start, today or later): from then on the grade has no set unless a new one starts. */
export async function endCompetencySet(tx: Queryable, grant: AccessGrant, id: string, input: { effectiveTo: string; reason: string; expectedVersion: number }): Promise<void> {
  requireUnrestricted(grant);
  const s = (
    await tx.query<{ effective_from: string; effective_to: string | null; version: number }>(
      `select to_char(effective_from, 'YYYY-MM-DD') as effective_from, to_char(effective_to, 'YYYY-MM-DD') as effective_to, version from appraisal_competency_set
        where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!s) throw notFound();
  if (s.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The set changed; reload and retry');
  if (s.effective_to !== null) throw new HttpError(409, 'SET_ENDED', 'This set already has its end date');
  const to = requireFromToday(grant, input.effectiveTo, 'effectiveTo');
  if (to <= s.effective_from) throw new HttpError(422, 'INVALID_DATE_RANGE', 'A set ends after it starts', { field: 'effectiveTo' });
  const reason = requireText(input.reason, 'reason');
  await tx.query(`update appraisal_competency_set set effective_to = $3::date, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, id, to, grant.userId]);
  await audit(tx, grant, 'appraisal_setting', id, 'UPDATE', { competencySetEffectiveTo: null }, { competencySetEffectiveTo: to }, reason);
}

// ---------------------------------------------------------------------------------------------------------
// Enrolment: the copy into the appraisal
// ---------------------------------------------------------------------------------------------------------

/**
 * Copies the set in force for the employee's grade (and designation; the narrower set wins) on the enrolment day, or on the
 * joining day when the employee joins later, into a new appraisal (in its own transaction: the database refuses a later copy).
 */
export async function copyCompetencies(tx: Queryable, companyId: string, appraisalId: string, employeeId: string, day: string, userId: string): Promise<{ setId: string | null; count: number }> {
  const set = (
    await tx.query<{ id: string }>(
      `with on_day as (select greatest($3::date, e.joining_date) as d from employee e where e.company_id = $1 and e.id = $2),
            post as (select ea.grade_id, ea.designation_id from employment_assignment ea, on_day
                      where ea.company_id = $1 and ea.employee_id = $2 and ea.effective_from <= on_day.d and (ea.effective_to is null or ea.effective_to > on_day.d) limit 1)
       select s.id from appraisal_competency_set s, post, on_day
        where s.company_id = $1 and post.grade_id is not null and s.grade_id = post.grade_id
          and (s.designation_id = post.designation_id or s.designation_id is null)
          and s.effective_from <= on_day.d and (s.effective_to is null or s.effective_to > on_day.d)
        order by s.designation_id nulls last limit 1`,
      [companyId, employeeId, day],
    )
  ).rows[0];
  if (!set) return { setId: null, count: 0 };
  const copied = await tx.query(
    `insert into appraisal_competency_item (company_id, appraisal_id, set_id, competency_id, sequence, code, name, description, indicators, weight, created_by)
     select si.company_id, $2, si.set_id, si.competency_id, si.sequence, k.code, k.name, k.description, k.indicators, si.weight, $4
       from appraisal_competency_set_item si join appraisal_competency k on k.company_id = si.company_id and k.id = si.competency_id
      where si.company_id = $1 and si.set_id = $3 order by si.sequence`,
    [companyId, appraisalId, set.id, userId],
  );
  return { setId: set.id, count: copied.rowCount ?? 0 };
}
