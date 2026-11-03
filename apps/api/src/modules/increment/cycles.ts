// Increment cycle definitions (DF15; FR-091; BR-040; DB101). A cycle is a review schedule, never an entitlement.
// A definition is an effective-dated revision of a cycle code. An authorised HR user drafts a new cycle or a new
// revision; a different user activates it (C4, as other policies are activated); activation closes the previous
// revision of the code on the new revision's first day; an activated definition is never edited in place, so a change
// is always a new revision. Every schedule value is explicit company configuration: nothing here supplies a date,
// offset or rule the company did not state, and an anniversary cycle without its day offsets cannot be activated.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';

export type RecurrenceBasis = 'COMMON_DATE' | 'SERVICE_ANNIVERSARY';
export type CompensationBasis = 'MONTHLY_GROSS' | 'ANNUAL_CTC';
export type AssignmentRule = 'COMPANY_DEFAULT' | 'ASSIGNED_ONLY';

export interface MonthDay {
  month: number;
  day: number;
}

export interface CycleDefinitionInput {
  recurrenceBasis: RecurrenceBasis;
  recurrenceUnit: 'YEAR';
  recurrenceInterval: number;
  compensationBasis: CompensationBasis;
  excludeNotice: boolean;
  assignmentRule: AssignmentRule;
  effectiveFrom: string;
  // COMMON_DATE: calendar dates of the occurrence and its review window, and the joining cutoff.
  effectiveDate?: MonthDay | undefined;
  reviewOpens?: MonthDay | undefined;
  rosterFreezes?: MonthDay | undefined;
  decisionsDue?: MonthDay | undefined;
  joiningCutoff?: MonthDay | undefined;
  // SERVICE_ANNIVERSARY: days before each employee's effective date (no defaults).
  reviewOpenOffsetDays?: number | undefined;
  rosterFreezeOffsetDays?: number | undefined;
  decisionDueOffsetDays?: number | undefined;
  // DF15 "completed required appraisal where that module is enabled": the appraisal cycle the company requires
  // (no default; null or absent requires none).
  requiredAppraisalCycleId?: string | null | undefined;
}

export interface CycleRow {
  id: string;
  code: string;
  revision: number;
  recurrence_basis: RecurrenceBasis;
  recurrence_unit: 'YEAR';
  recurrence_interval: number;
  recurrence_anchor_month: number | null;
  recurrence_anchor_day: number | null;
  review_open_month: number | null;
  review_open_day: number | null;
  roster_freeze_month: number | null;
  roster_freeze_day: number | null;
  decision_due_month: number | null;
  decision_due_day: number | null;
  cutoff_month: number | null;
  cutoff_day: number | null;
  review_open_offset_days: number | null;
  roster_freeze_offset_days: number | null;
  decision_due_offset_days: number | null;
  eligibility_rule_code: string;
  exclude_notice: boolean;
  compensation_basis: CompensationBasis;
  assignment_rule: AssignmentRule;
  effective_from: string;
  required_appraisal_cycle_id: string | null;
  effective_to: string | null;
  active: boolean;
  created_by: string | null;
  updated_by: string | null;
  activated_by: string | null;
  activated_at: Date | null;
  version: number;
}

const CYCLE_SELECT = `select id, code, revision, recurrence_basis, recurrence_unit, recurrence_interval, recurrence_anchor_month,
       recurrence_anchor_day, review_open_month, review_open_day, roster_freeze_month, roster_freeze_day, decision_due_month,
       decision_due_day, cutoff_month, cutoff_day, review_open_offset_days, roster_freeze_offset_days, decision_due_offset_days,
       eligibility_rule_code, exclude_notice, compensation_basis, assignment_rule, to_char(effective_from, 'YYYY-MM-DD') as effective_from,
       required_appraisal_cycle_id, to_char(effective_to, 'YYYY-MM-DD') as effective_to, active, created_by, updated_by, activated_by,
       activated_at, version
  from increment_cycle`;

/** Definition columns in the order definitionValues() returns them. */
const DEFINITION_COLUMNS = [
  'recurrence_basis',
  'recurrence_unit',
  'recurrence_interval',
  'recurrence_anchor_month',
  'recurrence_anchor_day',
  'review_open_month',
  'review_open_day',
  'roster_freeze_month',
  'roster_freeze_day',
  'decision_due_month',
  'decision_due_day',
  'cutoff_month',
  'cutoff_day',
  'review_open_offset_days',
  'roster_freeze_offset_days',
  'decision_due_offset_days',
  'eligibility_rule_code',
  'exclude_notice',
  'compensation_basis',
  'assignment_rule',
  'effective_from',
  'required_appraisal_cycle_id',
] as const;

const CALENDAR_FIELDS = ['effectiveDate', 'reviewOpens', 'rosterFreezes', 'decisionsDue', 'joiningCutoff'] as const;
const OFFSET_FIELDS = ['reviewOpenOffsetDays', 'rosterFreezeOffsetDays', 'decisionDueOffsetDays'] as const;
/** Last day of each month; 29 February is a valid configured day (it falls on 28 February in non-leap years). */
const LAST_DAY = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export const isDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

/**
 * Cycle definitions are company records: changing them, and opening their reviews, needs an unrestricted company-scope
 * assignment. Also the extra authority rule of the review-opening bulk job (modules/bulk/kinds.ts), re-checked for
 * every chunk and on status reads.
 */
export function cycleManagementAuthorised(grant: AccessGrant): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0;
}

export function requireCompanyScope(grant: AccessGrant): void {
  if (!cycleManagementAuthorised(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

/** Serialises definition changes and review openings of one cycle code; taken before any row lock. */
export async function lockCycleCode(tx: Queryable, companyId: string, code: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('increment-cycle:' || $1 || ':' || $2, 0))`, [companyId, code]);
}

export async function loadCycle(db: Queryable, companyId: string, id: string, lock = false): Promise<CycleRow | undefined> {
  return (await db.query<CycleRow>(`${CYCLE_SELECT} where company_id = $1 and id = $2${lock ? ' for update' : ''}`, [companyId, id])).rows[0];
}

/** Takes the code lock, then the row lock. Unknown or other-company ids are not found. */
async function lockCycle(tx: Queryable, companyId: string, id: string): Promise<CycleRow> {
  const code = (await tx.query<{ code: string }>(`select code from increment_cycle where company_id = $1 and id = $2`, [companyId, id])).rows[0]?.code;
  if (!code) throw notFound();
  await lockCycleCode(tx, companyId, code);
  return (await loadCycle(tx, companyId, id, true))!;
}

/** What an anniversary draft still needs before it can be activated (DF15 sets no default offsets). */
export function configurationNeeded(r: CycleRow): string[] {
  if (r.recurrence_basis !== 'SERVICE_ANNIVERSARY') return [];
  const needed: string[] = [];
  if (r.review_open_offset_days === null) needed.push('reviewOpenOffsetDays');
  if (r.roster_freeze_offset_days === null) needed.push('rosterFreezeOffsetDays');
  if (r.decision_due_offset_days === null) needed.push('decisionDueOffsetDays');
  return needed;
}

const monthDay = (month: number | null, day: number | null): MonthDay | null => (month === null || day === null ? null : { month, day });

function definitionOf(r: CycleRow) {
  return {
    recurrenceBasis: r.recurrence_basis,
    recurrenceUnit: r.recurrence_unit,
    recurrenceInterval: r.recurrence_interval,
    compensationBasis: r.compensation_basis,
    eligibilityRule: r.eligibility_rule_code,
    excludeNotice: r.exclude_notice,
    assignmentRule: r.assignment_rule,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
    effectiveDate: monthDay(r.recurrence_anchor_month, r.recurrence_anchor_day),
    reviewOpens: monthDay(r.review_open_month, r.review_open_day),
    rosterFreezes: monthDay(r.roster_freeze_month, r.roster_freeze_day),
    decisionsDue: monthDay(r.decision_due_month, r.decision_due_day),
    joiningCutoff: monthDay(r.cutoff_month, r.cutoff_day),
    reviewOpenOffsetDays: r.review_open_offset_days,
    rosterFreezeOffsetDays: r.roster_freeze_offset_days,
    decisionDueOffsetDays: r.decision_due_offset_days,
    requiredAppraisalCycleId: r.required_appraisal_cycle_id,
  };
}

export function cycleView(r: CycleRow) {
  return {
    id: r.id,
    code: r.code,
    revision: r.revision,
    state: r.active ? ('ACTIVE' as const) : ('DRAFT' as const),
    active: r.active,
    ...definitionOf(r),
    configurationNeeded: configurationNeeded(r),
    createdBy: r.created_by,
    activatedBy: r.activated_by,
    activatedAt: r.activated_at,
    version: r.version,
  };
}

const invalid = (problems: string[]) => new HttpError(422, 'INVALID_CYCLE', 'The cycle definition is incomplete or inconsistent', { problems });

/**
 * Validates a definition and returns its column values (DEFINITION_COLUMNS order). Common-date cycles state every
 * calendar date; anniversary cycles state day offsets instead, which a draft may still lack. The eligibility rule
 * follows the basis: confirmed and joined by the cutoff (common date), or confirmed and a completed recurrence
 * interval of service by the employee's effective date (anniversary).
 */
async function definitionValues(tx: Queryable, companyId: string, input: CycleDefinitionInput): Promise<unknown[]> {
  const problems: string[] = [];
  if (!isDate(input.effectiveFrom)) problems.push('effectiveFrom must be a calendar date');
  if (input.requiredAppraisalCycleId) {
    const found = await tx.query(`select 1 from appraisal_cycle where company_id = $1 and id = $2`, [companyId, input.requiredAppraisalCycleId]);
    if ((found.rowCount ?? 0) === 0) problems.push('requiredAppraisalCycleId is not an appraisal cycle of this company');
  }
  const common = input.recurrenceBasis === 'COMMON_DATE';
  // Which years a multi-year common-date cycle falls in needs an anchor year, which a definition does not record.
  if (common && input.recurrenceInterval !== 1) problems.push('A common-date cycle recurs every year; a longer interval needs an anchor year, which is not supported');
  for (const key of CALENDAR_FIELDS) {
    const v = input[key];
    if (common && !v) problems.push(`${key} is required for a common-date cycle`);
    if (!common && v) problems.push(`${key} applies to common-date cycles; an anniversary cycle uses day offsets`);
    if (v && v.day > LAST_DAY[v.month - 1]!) problems.push(`${key} is not a calendar day`);
  }
  for (const key of OFFSET_FIELDS) {
    if (common && input[key] !== undefined) problems.push(`${key} applies to service-anniversary cycles only`);
  }
  if (!common) {
    const { reviewOpenOffsetDays: open, rosterFreezeOffsetDays: freeze, decisionDueOffsetDays: due } = input;
    if (open !== undefined && freeze !== undefined && open < freeze) problems.push('reviewOpenOffsetDays must not be less than rosterFreezeOffsetDays: the review opens before the roster freezes');
    if (freeze !== undefined && due !== undefined && freeze < due) problems.push('rosterFreezeOffsetDays must not be less than decisionDueOffsetDays: the roster freezes no later than decisions are due');
    if (open !== undefined && due !== undefined && open <= due) problems.push('reviewOpenOffsetDays must be greater than decisionDueOffsetDays: the review window lasts at least one day');
  }
  if (problems.length === 0 && common) {
    // Each window date is the latest such calendar date on or before the effective date; checked in a common and a
    // leap year because 29 February moves.
    const [anchor, open, freeze, due] = [input.effectiveDate!, input.reviewOpens!, input.rosterFreezes!, input.decisionsDue!];
    const ok = (
      await tx.query<{ ok: boolean }>(
        `select coalesce(bool_and(o <= f and f <= d and o < d), false) as ok
           from (select hrms_increment_on_or_before(s, $3, $4) as o, hrms_increment_on_or_before(s, $5, $6) as f, hrms_increment_on_or_before(s, $7, $8) as d
                   from (select hrms_increment_date(y, $1, $2) as s from unnest(array[2027, 2028]) as y) q) z`,
        [anchor.month, anchor.day, open.month, open.day, freeze.month, freeze.day, due.month, due.day],
      )
    ).rows[0]!.ok;
    if (!ok) problems.push('reviewOpens, rosterFreezes and decisionsDue must fall in that order before the effective date, with a review window of at least one day');
  }
  if (problems.length > 0) throw invalid(problems);
  const md = (v: MonthDay | undefined) => [v?.month ?? null, v?.day ?? null];
  return [
    input.recurrenceBasis,
    input.recurrenceUnit,
    input.recurrenceInterval,
    ...md(input.effectiveDate),
    ...md(input.reviewOpens),
    ...md(input.rosterFreezes),
    ...md(input.decisionsDue),
    ...md(input.joiningCutoff),
    input.reviewOpenOffsetDays ?? null,
    input.rosterFreezeOffsetDays ?? null,
    input.decisionDueOffsetDays ?? null,
    common ? 'CONFIRMED_JOINED_BY_CUTOFF' : 'CONFIRMED_SERVICE_INTERVAL',
    input.excludeNotice,
    input.compensationBasis,
    input.assignmentRule,
    input.effectiveFrom,
    input.requiredAppraisalCycleId ?? null,
  ];
}

/** The open-ended revision in force for the code, which a new revision closes; a new revision must start after it. */
async function currentRevision(tx: Queryable, companyId: string, code: string, effectiveFrom: string) {
  const current = (
    await tx.query<{ id: string; effective_from: string }>(
      `select id, to_char(effective_from, 'YYYY-MM-DD') as effective_from from increment_cycle
        where company_id = $1 and code = $2 and active and effective_to is null for update`,
      [companyId, code],
    )
  ).rows[0];
  if (current && effectiveFrom <= current.effective_from) {
    throw new HttpError(422, 'RULE_VIOLATION', `A new revision must take effect after the revision in force from ${current.effective_from}`);
  }
  return current;
}

async function insertRevision(tx: Queryable, grant: AccessGrant, code: string, revision: number, values: unknown[]): Promise<CycleRow> {
  const placeholders = DEFINITION_COLUMNS.map((_, i) => `$${i + 4}`).join(', ');
  const actor = `$${DEFINITION_COLUMNS.length + 4}`;
  const id = (
    await tx.query<{ id: string }>(
      `insert into increment_cycle (company_id, code, revision, ${DEFINITION_COLUMNS.join(', ')}, active, created_by, updated_by)
       values ($1, $2, $3, ${placeholders}, false, ${actor}, ${actor}) returning id`,
      [grant.companyId, code, revision, ...values, grant.userId],
    )
  ).rows[0]!.id;
  return (await loadCycle(tx, grant.companyId, id))!;
}

async function audit(tx: Queryable, grant: AccessGrant, row: CycleRow, action: string, extra: { priorVersion?: number; before?: CycleRow } = {}) {
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'increment_cycle',
    recordKey: row.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    priorVersion: extra.priorVersion ?? null,
    newVersion: row.version,
    before: extra.before ? { operational: { state: extra.before.active ? 'ACTIVE' : 'DRAFT', ...definitionOf(extra.before) } } : null,
    after: { operational: { code: row.code, revision: row.revision, state: row.active ? 'ACTIVE' : 'DRAFT', ...definitionOf(row) } },
  });
}

/** Drafts revision 1 of a new cycle code. */
export async function createCycle(tx: Queryable, grant: AccessGrant, input: CycleDefinitionInput & { code: string }) {
  requireCompanyScope(grant);
  await lockCycleCode(tx, grant.companyId, input.code);
  const exists = await tx.query(`select 1 from increment_cycle where company_id = $1 and code = $2`, [grant.companyId, input.code]);
  if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, 'CYCLE_EXISTS', 'A cycle with this code exists; draft a new revision of it instead');
  const row = await insertRevision(tx, grant, input.code, 1, await definitionValues(tx, grant.companyId, input));
  await audit(tx, grant, row, 'CREATE');
  return cycleView(row);
}

/** Drafts the next revision of the cycle code that `baseId` belongs to (one draft per code at a time). */
export async function createRevision(tx: Queryable, grant: AccessGrant, baseId: string, input: CycleDefinitionInput) {
  requireCompanyScope(grant);
  const code = (await tx.query<{ code: string }>(`select code from increment_cycle where company_id = $1 and id = $2`, [grant.companyId, baseId])).rows[0]?.code;
  if (!code) throw notFound();
  await lockCycleCode(tx, grant.companyId, code);
  const draft = (await tx.query<{ id: string }>(`select id from increment_cycle where company_id = $1 and code = $2 and not active`, [grant.companyId, code])).rows[0];
  if (draft) throw new HttpError(409, 'DRAFT_EXISTS', 'This cycle already has a draft revision; update or activate it first', { draftId: draft.id });
  const values = await definitionValues(tx, grant.companyId, input);
  await currentRevision(tx, grant.companyId, code, input.effectiveFrom);
  const revision = (await tx.query<{ n: number }>(`select max(revision) + 1 as n from increment_cycle where company_id = $1 and code = $2`, [grant.companyId, code])).rows[0]!.n;
  const row = await insertRevision(tx, grant, code, revision, values);
  await audit(tx, grant, row, 'CREATE_REVISION');
  return cycleView(row);
}

/** Replaces a draft's definition (optimistic version). An activated revision is immutable. */
export async function updateDraft(tx: Queryable, grant: AccessGrant, id: string, input: CycleDefinitionInput & { expectedVersion: number }) {
  requireCompanyScope(grant);
  const before = await lockCycle(tx, grant.companyId, id);
  if (before.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (before.active) throw new HttpError(409, 'CYCLE_ACTIVE', 'An activated cycle is immutable; draft a new revision instead');
  const values = await definitionValues(tx, grant.companyId, input);
  await currentRevision(tx, grant.companyId, before.code, input.effectiveFrom);
  await tx.query(
    `update increment_cycle set ${DEFINITION_COLUMNS.map((c, i) => `${c} = $${i + 3}`).join(', ')}, updated_by = $${DEFINITION_COLUMNS.length + 3}
      where company_id = $1 and id = $2`,
    [grant.companyId, id, ...values, grant.userId],
  );
  const row = (await loadCycle(tx, grant.companyId, id))!;
  await audit(tx, grant, row, 'UPDATE', { priorVersion: before.version, before });
  return cycleView(row);
}

/**
 * Independent activation (C4): never by the author nor by the user who last edited the draft (an edit authors the
 * definition being activated); the activation duty is re-checked after the locks (I-25); an anniversary draft needs
 * its three offsets; the previous
 * revision of the code closes on this revision's first day, which must come after every review of it that takes
 * effect; at most one company-default cycle is in force on any date.
 */
export async function activateCycle(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number) {
  requireCompanyScope(grant);
  const c = await lockCycle(tx, grant.companyId, id);
  await reassertAccess(tx, grant, 'increment_cycle', 'activate', ['operational']);
  if (c.version !== expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (c.active) throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision can be activated');
  if (c.created_by === grant.userId || c.updated_by === grant.userId) {
    throw new HttpError(403, 'SELF_APPROVAL', 'A cycle revision cannot be activated by its author or the last editor of its draft');
  }
  const needed = configurationNeeded(c);
  if (needed.length > 0) {
    throw new HttpError(422, 'CONFIGURATION_INCOMPLETE', 'The cycle cannot be activated until its review schedule is configured', { configurationNeeded: needed });
  }
  const previous = await currentRevision(tx, grant.companyId, c.code, c.effective_from);
  if (previous) {
    const lastReview = (
      await tx.query<{ d: string | null }>(
        `select to_char(max(proposed_effective_date), 'YYYY-MM-DD') as d from increment_case
          where company_id = $1 and cycle_id = $2 and proposed_effective_date >= $3::date`,
        [grant.companyId, previous.id, c.effective_from],
      )
    ).rows[0]!.d;
    if (lastReview) throw new HttpError(409, 'CYCLE_IN_USE', `Reviews of the revision in force take effect up to ${lastReview}; the new revision must start after them`);
    // A review whose approved override moves it across the new start would belong to neither revision when it opens.
    const crossing = (
      await tx.query<{ d: string | null }>(
        `select to_char(min(p.override_review_date), 'YYYY-MM-DD') as d
           from employee_increment_plan p join increment_cycle y on y.company_id = p.company_id and y.id = p.cycle_id
          where p.company_id = $1 and y.code = $2 and p.superseded_at is null and p.override_review_date is not null
            and (p.next_review_date < $3::date) <> (p.override_review_date < $3::date)
            and not exists (select 1 from increment_case k
                             where k.company_id = p.company_id and k.employee_id = p.employee_id and k.cycle_occurrence_key = p.override_occurrence_key)`,
        [grant.companyId, c.code, c.effective_from],
      )
    ).rows[0]!.d;
    if (crossing) throw new HttpError(409, 'CYCLE_IN_USE', `An approved review-date override (${crossing}) moves a review across the new revision's start; choose another start date`);
  }
  if (c.assignment_rule === 'COMPANY_DEFAULT') {
    const other = (
      await tx.query<{ code: string }>(
        `select code from increment_cycle
          where company_id = $1 and active and assignment_rule = 'COMPANY_DEFAULT' and code <> $2 and (effective_to is null or effective_to > $3::date)
          order by effective_from limit 1`,
        [grant.companyId, c.code, c.effective_from],
      )
    ).rows[0];
    if (other) throw new HttpError(409, 'DEFAULT_CYCLE_EXISTS', `Cycle ${other.code} is the company default on or after this date; make this cycle assigned-only or close ${other.code} first`);
  }
  if (previous) {
    const prior = (await loadCycle(tx, grant.companyId, previous.id))!;
    await tx.query(`update increment_cycle set effective_to = $3::date, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, previous.id, c.effective_from, grant.userId]);
    await audit(tx, grant, (await loadCycle(tx, grant.companyId, previous.id))!, 'CLOSE', { priorVersion: prior.version, before: prior });
  }
  await tx.query(`update increment_cycle set active = true, activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [
    grant.companyId,
    id,
    grant.userId,
  ]);
  const row = (await loadCycle(tx, grant.companyId, id))!;
  await audit(tx, grant, row, 'ACTIVATE', { priorVersion: c.version });
  return { ...cycleView(row), closedRevisionId: previous?.id ?? null };
}

export async function getCycle(db: Queryable, grant: AccessGrant, id: string) {
  const row = await loadCycle(db, grant.companyId, id);
  if (!row) throw notFound();
  return cycleView(row);
}

/** Every revision of every cycle, drafts included, by code and revision. */
export async function listCycles(db: Queryable, grant: AccessGrant) {
  const rows = (await db.query<CycleRow>(`${CYCLE_SELECT} where company_id = $1 order by code, revision`, [grant.companyId])).rows;
  return { items: rows.map(cycleView) };
}
