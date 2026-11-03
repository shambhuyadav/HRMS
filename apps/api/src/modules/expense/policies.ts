// Expense policy revisions, their category rules and the categories (FR-078; BR-019; DF06; DB047-DB049; C4). HR maintains a
// DRAFT revision of a policy code: effective period, submission window, high-value threshold, and rules giving a category's
// limit and receipt requirement, company-wide or for a grade, a location or both. Every value comes from the person
// maintaining it: DF06's initial values live in the provisioned DEFAULT revision, nothing here defaults to them. Wave 1 is
// INR only (DF06 "foreign-currency claims are disabled"), so a revision does not choose its currency. Limits stay review
// thresholds: going over one flags a line, it never pays or refuses it.
//
// An activated revision is frozen with its rules (0116; DB048 "immutable once referenced"), so a change is a new revision.
// Activation is independent of whoever wrote the draft (C4) and ends the earlier revision of the same code on the new
// revision's first day. A revision applies to the whole company on its dates, so any other revision in force in an
// overlapping period is refused (409 POLICY_OVERLAP here, hrms_expense_policy_no_overlap in the database): a claim would
// be ambiguous on those dates. A revision's period never ends before a date a submitted claim already used it for
// (409 POLICY_IN_USE). Policies apply company-wide, so every change needs an unrestricted company-scope assignment.
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';

export const NO_RULES_WARNING = 'No category has a rule, so nobody can claim under this revision.';
export const TIED_RULES_WARNING = 'A grade rule and a location rule of one category tie for an employee with both, which blocks their claims; add a rule naming that grade and location.';
export const OVERLAP_WARNING = 'Its period overlaps another revision in force, so it cannot be activated as it stands.';

/** DF06: the initial policy's company currency; foreign-currency claims are disabled in wave 1. */
const WAVE_1_CURRENCY = 'INR';

const stale = () => new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');

function requireCompanyWide(grant: AccessGrant): void {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) {
    throw new HttpError(403, 'FORBIDDEN', 'Expense policies are maintained from an unrestricted company-scope assignment');
  }
}

/** The advisory key of a company's policy changes (the guard in 0116 takes it too); a submission holds it shared. */
export const expensePolicyLockKey = (companyId: string) => `expense:policy:${companyId}`;

/** Policy changes of one company run one after another, and after every submission in flight. Taken before any row lock. */
const lockPolicies = (tx: Queryable, companyId: string) => tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [expensePolicyLockKey(companyId)]);

export interface PolicyValues {
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
  submissionWindowDays: number;
  /** A claim total above it needs the additional high-value approver (DF06). */
  highValueThreshold: string;
}

function checkPeriod(v: Pick<PolicyValues, 'effectiveFrom' | 'effectiveTo'>): void {
  if (v.effectiveTo && v.effectiveTo <= v.effectiveFrom) throw new HttpError(422, 'INVALID_PERIOD', 'The effective end must be after the effective start');
}

interface ListRow {
  rules: unknown[];
  ties: unknown[];
  overlaps: unknown[];
  [column: string]: unknown;
}

/** Every revision with its values, rules and period; a warning in words for one nobody could claim under, or that cannot be activated. */
export async function listExpensePolicies(db: Queryable, grant: AccessGrant) {
  const rows = await db.query<ListRow>(
    `select p.id, p.code, p.revision, p.currency_code as currency, p.submission_window_days as "submissionWindowDays",
            p.high_value_threshold::text as "highValueThreshold", p.effective_from as "effectiveFrom", p.effective_to as "effectiveTo", p.state, p.version,
            p.activated_at as "activatedAt", p.activated_by as "activatedBy", p.created_by as "createdBy",
            hrms_expense_policy_last_used(p.company_id, p.id) as "lastUsedOn",
            coalesce((select json_agg(json_build_object('id', r.id, 'categoryId', r.category_id, 'category', c.code, 'limitBasis', c.limit_basis,
                                                        'gradeId', r.grade_id, 'grade', g.code, 'locationId', r.location_id, 'location', l.code,
                                                        'limitAmount', r.limit_amount::text, 'receiptRequired', r.receipt_required,
                                                        'priority', num_nonnulls(r.grade_id, r.location_id))
                                      order by c.code, num_nonnulls(r.grade_id, r.location_id) desc, g.code, l.code)
                        from expense_policy_rule r
                        join expense_category c on c.company_id = r.company_id and c.id = r.category_id
                        left join grade g on g.company_id = r.company_id and g.id = r.grade_id
                        left join location l on l.company_id = r.company_id and l.id = r.location_id
                       where r.company_id = p.company_id and r.policy_id = p.id), '[]'::json) as rules,
            coalesce((select json_agg(json_build_object('category', c.code, 'grade', g.code, 'location', l.code) order by c.code, g.code, l.code)
                        from hrms_expense_policy_tied_rules(p.company_id, p.id) t
                        join expense_category c on c.company_id = p.company_id and c.id = t.category_id
                        join grade g on g.company_id = p.company_id and g.id = t.grade_id
                        join location l on l.company_id = p.company_id and l.id = t.location_id), '[]'::json) as ties,
            coalesce((select json_agg(json_build_object('policyId', o.id, 'code', o.code, 'revision', o.revision) order by o.code, o.revision)
                        from hrms_expense_policy_conflicts(p.company_id, p.id) x join expense_policy o on o.company_id = p.company_id and o.id = x.policy_id
                       where o.code <> p.code or o.effective_from >= p.effective_from), '[]'::json) as overlaps
       from expense_policy p where p.company_id = $1 order by p.code, p.revision`,
    [grant.companyId],
  );
  return {
    items: rows.rows.map((r) => ({
      ...r,
      warnings: [
        ...(r.rules.length === 0 ? [{ code: 'NO_RULES', text: NO_RULES_WARNING }] : []),
        ...(r.ties.length > 0 ? [{ code: 'TIED_RULES', text: TIED_RULES_WARNING }] : []),
        ...(r.state === 'DRAFT' && r.overlaps.length > 0 ? [{ code: 'OVERLAPPING', text: OVERLAP_WARNING }] : []),
      ],
    })),
  };
}

/** What a rule can name: this company's active categories, grades and locations (the maintenance form's choices). */
export async function expensePolicyOptions(db: Queryable, grant: AccessGrant) {
  const list = async (sql: string) => (await db.query(sql, [grant.companyId])).rows;
  const [categories, grades, locations] = await Promise.all([
    list(`select id, code, name, limit_basis as "limitBasis" from expense_category where company_id = $1 and active order by code`),
    list(`select id, code, name from grade where company_id = $1 and active order by code`),
    list(`select id, code, name from location where company_id = $1 and active order by code`),
  ]);
  return { categories, grades, locations };
}

/** A new DRAFT: the next revision of its code, or revision 1 of a new code. Its rules are added next. */
export async function createExpensePolicy(tx: Queryable, grant: AccessGrant, input: PolicyValues & { code: string }) {
  requireCompanyWide(grant);
  checkPeriod(input);
  await lockPolicies(tx, grant.companyId);
  await reassertAccess(tx, grant, 'expense_policy', 'manage', ['operational']);
  const row = (
    await tx.query<{ id: string; revision: number; version: number }>(
      `insert into expense_policy (company_id, code, revision, currency_code, submission_window_days, high_value_threshold, effective_from, effective_to, state, created_by, updated_by)
       select $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5::numeric, $6, $7, 'DRAFT', $8, $8 from expense_policy where company_id = $1 and code = $2
       returning id, revision, version`,
      [grant.companyId, input.code, WAVE_1_CURRENCY, input.submissionWindowDays, input.highValueThreshold, input.effectiveFrom, input.effectiveTo ?? null, grant.userId],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_policy',
    recordKey: row.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: row.version,
    after: { operational: { ...input, effectiveTo: input.effectiveTo ?? null, currency: WAVE_1_CURRENCY, revision: row.revision, state: 'DRAFT' } },
  });
  return { id: row.id, code: input.code, revision: row.revision, state: 'DRAFT', version: row.version };
}

interface PolicyRow {
  code: string;
  revision: number;
  effective_from: string;
  effective_to: string | null;
  submission_window_days: number;
  high_value_threshold: string;
  state: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
}

async function lockPolicy(tx: Queryable, grant: AccessGrant, id: string): Promise<PolicyRow> {
  await lockPolicies(tx, grant.companyId);
  const p = (
    await tx.query<PolicyRow>(
      `select code, revision, effective_from, effective_to, submission_window_days, high_value_threshold::text as high_value_threshold, state, version, created_by, updated_by
         from expense_policy where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!p) throw notFound();
  return p;
}

async function lockDraft(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number): Promise<PolicyRow> {
  requireCompanyWide(grant);
  const p = await lockPolicy(tx, grant, id);
  await reassertAccess(tx, grant, 'expense_policy', 'manage', ['operational']);
  if (p.version !== expectedVersion) throw stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'POLICY_NOT_DRAFT', 'Only a draft revision can be changed; an activated revision needs a new revision');
  return p;
}

export async function updateExpensePolicy(tx: Queryable, grant: AccessGrant, id: string, input: Partial<PolicyValues> & { expectedVersion: number }) {
  const p = await lockDraft(tx, grant, id, input.expectedVersion);
  const next = {
    effectiveFrom: input.effectiveFrom ?? p.effective_from,
    effectiveTo: input.effectiveTo === undefined ? p.effective_to : input.effectiveTo,
    submissionWindowDays: input.submissionWindowDays ?? p.submission_window_days,
    highValueThreshold: input.highValueThreshold ?? p.high_value_threshold,
  };
  checkPeriod(next);
  await tx.query(
    `update expense_policy set effective_from = $3, effective_to = $4, submission_window_days = $5, high_value_threshold = $6::numeric, updated_by = $7
      where company_id = $1 and id = $2`,
    [grant.companyId, id, next.effectiveFrom, next.effectiveTo, next.submissionWindowDays, next.highValueThreshold, grant.userId],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_policy',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    priorVersion: p.version,
    before: { operational: { effectiveFrom: p.effective_from, effectiveTo: p.effective_to, submissionWindowDays: p.submission_window_days, highValueThreshold: p.high_value_threshold } },
    after: { operational: next },
  });
  return { id, version: p.version + 1 };
}

export interface RuleInput {
  expectedVersion: number;
  categoryId: string;
  gradeId?: string | undefined;
  locationId?: string | undefined;
  /** DF06 "unset never means unlimited": every rule states its limit. */
  limitAmount: string;
  receiptRequired: boolean;
}

/** A rule of a draft: its category for a grade, a location, both, or neither (company-wide, the lowest priority). The draft's version moves, so an activator reviewing the earlier rules gets a stale refusal. */
export async function addExpensePolicyRule(tx: Queryable, grant: AccessGrant, policyId: string, input: RuleInput) {
  const p = await lockDraft(tx, grant, policyId, input.expectedVersion);
  const refs = (
    await tx.query<{ category: boolean; grade: boolean; location: boolean }>(
      `select exists (select 1 from expense_category where company_id = $1 and id = $2 and active) as category,
              ($3::uuid is null or exists (select 1 from grade where company_id = $1 and id = $3 and active)) as grade,
              ($4::uuid is null or exists (select 1 from location where company_id = $1 and id = $4 and active)) as location`,
      [grant.companyId, input.categoryId, input.gradeId ?? null, input.locationId ?? null],
    )
  ).rows[0]!;
  if (!refs.category || !refs.grade || !refs.location) throw new HttpError(422, 'INVALID_REFERENCE', 'The category, grade or location is not active in this company');
  const duplicate = await tx.query(`select 1 from expense_policy_rule where company_id = $1 and policy_id = $2 and category_id = $3 and grade_id is not distinct from $4::uuid and location_id is not distinct from $5::uuid`, [
    grant.companyId,
    policyId,
    input.categoryId,
    input.gradeId ?? null,
    input.locationId ?? null,
  ]);
  if (duplicate.rowCount) throw new HttpError(409, 'RULE_EXISTS', 'This revision already has a rule for this category, grade and location');
  const ruleId = (
    await tx.query<{ id: string }>(
      `insert into expense_policy_rule (company_id, policy_id, category_id, grade_id, location_id, limit_amount, receipt_required, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $8) returning id`,
      [grant.companyId, policyId, input.categoryId, input.gradeId ?? null, input.locationId ?? null, input.limitAmount, input.receiptRequired, grant.userId],
    )
  ).rows[0]!.id;
  await tx.query(`update expense_policy set updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, policyId, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_policy',
    recordKey: policyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'ADD_RULE',
    priorVersion: p.version,
    after: { operational: { ruleId, categoryId: input.categoryId, gradeId: input.gradeId ?? null, locationId: input.locationId ?? null, limitAmount: input.limitAmount, receiptRequired: input.receiptRequired } },
  });
  return { id: ruleId, policyVersion: p.version + 1 };
}

export async function removeExpensePolicyRule(tx: Queryable, grant: AccessGrant, policyId: string, ruleId: string, expectedVersion: number) {
  const p = await lockDraft(tx, grant, policyId, expectedVersion);
  const removed = (
    await tx.query<{ category_id: string; grade_id: string | null; location_id: string | null; limit_amount: string; receipt_required: boolean }>(
      `delete from expense_policy_rule where company_id = $1 and policy_id = $2 and id = $3 returning category_id, grade_id, location_id, limit_amount::text, receipt_required`,
      [grant.companyId, policyId, ruleId],
    )
  ).rows[0];
  if (!removed) throw notFound();
  await tx.query(`update expense_policy set updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, policyId, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_policy',
    recordKey: policyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'REMOVE_RULE',
    priorVersion: p.version,
    before: { operational: { ruleId, categoryId: removed.category_id, gradeId: removed.grade_id, locationId: removed.location_id, limitAmount: removed.limit_amount, receiptRequired: removed.receipt_required } },
  });
  return { policyVersion: p.version + 1 };
}

/** POLICY_IN_USE when a submitted claim used this revision for a date at or after the end it would get (DB048). */
async function assertEndKeepsUsedDates(tx: Queryable, grant: AccessGrant, policyId: string, end: string) {
  const used = (await tx.query<{ d: string | null }>(`select hrms_expense_policy_last_used($1, $2) as d`, [grant.companyId, policyId])).rows[0]!.d;
  if (used && used >= end) throw new HttpError(409, 'POLICY_IN_USE', `A submitted claim used this revision for ${used}, so it cannot end on or before that date`, { policyId, lastUsedOn: used });
}

/**
 * C4: activation needs a different person from whoever wrote or last edited the draft. The earlier revision of the same code
 * still in force on the new revision's first day ends there, unless a submitted claim used it from that day on. Any other
 * revision in force in an overlapping period is refused, with the revisions in the way; so is a revision with no rules, or
 * with rules that tie (DB049), which could only block claims.
 */
export async function activateExpensePolicy(tx: Queryable, grant: AccessGrant, policyId: string, expectedVersion: number) {
  requireCompanyWide(grant);
  const p = await lockPolicy(tx, grant, policyId);
  await reassertAccess(tx, grant, 'expense_policy', 'activate', ['operational']);
  if (p.version !== expectedVersion) throw stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only draft policies can be activated');
  if (p.created_by === grant.userId || p.updated_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A policy cannot be activated by its author');
  const rules = (await tx.query<{ n: string }>(`select count(*) as n from expense_policy_rule where company_id = $1 and policy_id = $2`, [grant.companyId, policyId])).rows[0]!.n;
  if (rules === '0') throw new HttpError(422, 'POLICY_HAS_NO_RULES', 'A revision without rules would refuse every claim; add its category rules first');
  const ties = (
    await tx.query<{ category: string; grade: string; location: string }>(
      `select c.code as category, g.code as grade, l.code as location
         from hrms_expense_policy_tied_rules($1, $2) t
         join expense_category c on c.company_id = $1 and c.id = t.category_id
         join grade g on g.company_id = $1 and g.id = t.grade_id
         join location l on l.company_id = $1 and l.id = t.location_id
        order by c.code, g.code, l.code`,
      [grant.companyId, policyId],
    )
  ).rows;
  if (ties.length > 0) throw new HttpError(409, 'POLICY_AMBIGUOUS', 'A grade rule and a location rule of one category tie for an employee with both; add a rule naming that grade and location', { ties });
  const predecessors = (
    await tx.query<{ id: string; revision: number; effective_to: string | null; version: number }>(
      `select id, revision, effective_to, version from expense_policy
        where company_id = $1 and code = $2 and id <> $3 and state = 'ACTIVE' and effective_from < $4::date and (effective_to is null or effective_to > $4::date)
        order by revision for update`,
      [grant.companyId, p.code, policyId, p.effective_from],
    )
  ).rows;
  const blocking = (
    await tx.query<{ policy_id: string; code: string; revision: number; effective_from: string; effective_to: string | null }>(
      `select o.id as policy_id, o.code, o.revision, o.effective_from, o.effective_to
         from hrms_expense_policy_conflicts($1, $2) c join expense_policy o on o.company_id = $1 and o.id = c.policy_id
        where not (o.id = any($3::uuid[])) order by o.code, o.revision`,
      [grant.companyId, policyId, predecessors.map((c) => c.id)],
    )
  ).rows;
  if (blocking.length > 0) {
    throw new HttpError(409, 'POLICY_OVERLAP', 'Another revision is in force in an overlapping period', {
      revisions: blocking.map((c) => ({ policyId: c.policy_id, code: c.code, revision: c.revision, effectiveFrom: c.effective_from, effectiveTo: c.effective_to })),
    });
  }
  for (const c of predecessors) {
    await assertEndKeepsUsedDates(tx, grant, c.id, p.effective_from);
    await tx.query(`update expense_policy set effective_to = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, c.id, p.effective_from, grant.userId]);
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'expense_policy',
      recordKey: c.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'CLOSE',
      priorVersion: c.version,
      before: { operational: { effectiveTo: c.effective_to } },
      after: { operational: { effectiveTo: p.effective_from, supersededBy: policyId } },
    });
  }
  await tx.query(`update expense_policy set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, policyId, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_policy',
    recordKey: policyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'ACTIVATE',
    priorVersion: p.version,
    before: { operational: { state: 'DRAFT' } },
    after: { operational: { state: 'ACTIVE', closed: predecessors.map((c) => c.id) } },
  });
  return { id: policyId, state: 'ACTIVE', closed: predecessors.map((c) => c.id) };
}

/**
 * Retires an active revision from a date (exclusive end of its period, today or later: what already happened keeps its
 * policy). It still applies to expense dates before that end (DF06 "the policy effective on the expense date"); a revision
 * that would never have started simply leaves force. Under the activation duty: it changes who can claim.
 */
export async function retireExpensePolicy(tx: Queryable, grant: AccessGrant, policyId: string, input: { expectedVersion: number; effectiveTo: string; reason: string }) {
  requireCompanyWide(grant);
  const p = await lockPolicy(tx, grant, policyId);
  await reassertAccess(tx, grant, 'expense_policy', 'activate', ['operational']);
  if (p.version !== input.expectedVersion) throw stale();
  if (p.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'Only an active revision can be retired');
  if (input.effectiveTo < grant.businessDate) throw new HttpError(422, 'BACKDATED_RETIREMENT', 'A revision is retired from today or a later date');
  if (p.effective_to && input.effectiveTo > p.effective_to) throw new HttpError(422, 'INVALID_PERIOD', 'A retirement cannot extend the revision past its current end');
  const effectiveTo = input.effectiveTo <= p.effective_from ? null : input.effectiveTo;
  await assertEndKeepsUsedDates(tx, grant, policyId, effectiveTo ?? p.effective_from);
  await tx.query(`update expense_policy set state = 'RETIRED', effective_to = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, policyId, effectiveTo, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_policy',
    recordKey: policyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'RETIRE',
    priorVersion: p.version,
    before: { operational: { state: 'ACTIVE', effectiveTo: p.effective_to } },
    after: { operational: { state: 'RETIRED', effectiveTo } },
    reason: input.reason,
  });
  return { id: policyId, state: 'RETIRED', effectiveTo };
}

// ---------------------------------------------------------------------------------------------------------------
// Categories (DB047; DF06 "default operational categories"). A category's code and limit basis are fixed at creation
// (0116). Deactivating one stops new lines using it; lines and rules that already name it keep it.
// ---------------------------------------------------------------------------------------------------------------

/** The categories a claimant can choose (the claim form's list). */
export async function listActiveCategories(db: Queryable, grant: AccessGrant) {
  return { items: (await db.query(`select code, name, limit_basis as "limitBasis" from expense_category where company_id = $1 and active order by code`, [grant.companyId])).rows };
}

/** Every category, active or not, for maintenance. */
export async function listCategories(db: Queryable, grant: AccessGrant) {
  return { items: (await db.query(`select id, code, name, limit_basis as "limitBasis", active, version from expense_category where company_id = $1 order by code`, [grant.companyId])).rows };
}

export async function createExpenseCategory(tx: Queryable, grant: AccessGrant, input: { code: string; name: string; limitBasis: string }) {
  requireCompanyWide(grant);
  await lockPolicies(tx, grant.companyId);
  await reassertAccess(tx, grant, 'expense_policy', 'manage', ['operational']);
  const existing = await tx.query(`select 1 from expense_category where company_id = $1 and code = $2`, [grant.companyId, input.code]);
  if (existing.rowCount) throw new HttpError(409, 'CATEGORY_EXISTS', 'This category code is already in use');
  const row = (
    await tx.query<{ id: string; version: number }>(
      `insert into expense_category (company_id, code, name, limit_basis, active, created_by, updated_by) values ($1, $2, $3, $4, true, $5, $5) returning id, version`,
      [grant.companyId, input.code, input.name.trim(), input.limitBasis, grant.userId],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_category',
    recordKey: row.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: row.version,
    after: { operational: { ...input, name: input.name.trim(), active: true } },
  });
  return { id: row.id, code: input.code, version: row.version };
}

export async function updateExpenseCategory(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number; name?: string | undefined; active?: boolean | undefined }) {
  requireCompanyWide(grant);
  await lockPolicies(tx, grant.companyId);
  const c = (await tx.query<{ name: string; active: boolean; version: number }>(`select name, active, version from expense_category where company_id = $1 and id = $2 for update`, [grant.companyId, id])).rows[0];
  if (!c) throw notFound();
  await reassertAccess(tx, grant, 'expense_policy', 'manage', ['operational']);
  if (c.version !== input.expectedVersion) throw stale();
  const next = { name: input.name?.trim() ?? c.name, active: input.active ?? c.active };
  await tx.query(`update expense_category set name = $3, active = $4, updated_by = $5 where company_id = $1 and id = $2`, [grant.companyId, id, next.name, next.active, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'expense_category',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    priorVersion: c.version,
    before: { operational: { name: c.name, active: c.active } },
    after: { operational: next },
  });
  return { id, version: c.version + 1 };
}

// ---------------------------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------------------------

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
// Above zero, in two-decimal INR precision (DF06).
const amount = { type: 'string', pattern: '^(?!0*(\\.0*)?$)\\d{1,13}(\\.\\d{1,2})?$' } as const;
const values = {
  effectiveFrom: date,
  effectiveTo: { anyOf: [date, { type: 'null' }] },
  // A technical bound, not a business rule; DF06's 30 days is the provisioned revision's value.
  submissionWindowDays: { type: 'integer', minimum: 1, maximum: 3660 },
  highValueThreshold: amount,
} as const;

export async function expensePolicyRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  const manage = (request: Parameters<typeof requireAccess>[1], recordKey?: string) => requireAccess(db, request, 'expense_policy', 'manage', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const activate = (request: Parameters<typeof requireAccess>[1], recordKey: string) => requireAccess(db, request, 'expense_policy', 'activate', ['operational'], { requireAll: true, recordKey });

  app.get('/expense/policies', async (request) => listExpensePolicies(db, await requireAccess(db, request, 'expense_policy', 'manage', ['operational'])));
  app.get('/expense/policy-options', async (request) => expensePolicyOptions(db, await requireAccess(db, request, 'expense_policy', 'manage', ['operational'])));

  app.post(
    '/expense/policies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'effectiveFrom', 'submissionWindowDays', 'highValueThreshold'],
          // Named so that another currency is refused, not silently dropped (DF06 wave 1).
          properties: { code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' }, currency: { type: 'string', enum: [WAVE_1_CURRENCY] }, ...values },
        },
      },
    },
    async (request, reply) => {
      const grant = await manage(request);
      const created = await withTransaction(db, (tx) => createExpensePolicy(tx, grant, request.body as PolicyValues & { code: string }));
      reply.status(201);
      return created;
    },
  );

  app.patch(
    '/expense/policies/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], minProperties: 2, properties: { expectedVersion, ...values } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await manage(request, id);
      return withTransaction(db, (tx) => updateExpensePolicy(tx, grant, id, request.body as Partial<PolicyValues> & { expectedVersion: number }));
    },
  );

  app.post(
    '/expense/policies/:id/rules',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['expectedVersion', 'categoryId', 'limitAmount', 'receiptRequired'],
          properties: { expectedVersion, categoryId: uuid, gradeId: uuid, locationId: uuid, limitAmount: amount, receiptRequired: { type: 'boolean' } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await manage(request, id);
      const created = await withTransaction(db, (tx) => addExpensePolicyRule(tx, grant, id, request.body as RuleInput));
      reply.status(201);
      return created;
    },
  );

  app.post(
    '/expense/policies/:id/rules/:ruleId/remove',
    {
      schema: {
        params: { type: 'object', required: ['id', 'ruleId'], properties: { id: uuid, ruleId: uuid } },
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } },
      },
    },
    async (request) => {
      const { id, ruleId } = request.params as { id: string; ruleId: string };
      const grant = await manage(request, id);
      return withTransaction(db, (tx) => removeExpensePolicyRule(tx, grant, id, ruleId, (request.body as { expectedVersion: number }).expectedVersion));
    },
  );

  app.post(
    '/expense/policies/:id/activate',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await activate(request, id);
      return withTransaction(db, (tx) => activateExpensePolicy(tx, grant, id, (request.body as { expectedVersion: number }).expectedVersion));
    },
  );

  app.post(
    '/expense/policies/:id/retire',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'effectiveTo', 'reason'], properties: { expectedVersion, effectiveTo: date, reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await activate(request, id);
      return withTransaction(db, (tx) => retireExpensePolicy(tx, grant, id, request.body as { expectedVersion: number; effectiveTo: string; reason: string }));
    },
  );

  // The categories a claimant chooses from: the same right as drafting a claim.
  app.get('/expense/categories', async (request) => listActiveCategories(db, await requireAccess(db, request, 'expense', 'draft', ['operational'])));
  app.get('/expense/category-maintenance', async (request) => listCategories(db, await requireAccess(db, request, 'expense_policy', 'manage', ['operational'])));

  app.post(
    '/expense/categories',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'name', 'limitBasis'],
          properties: { code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' }, name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }, limitBasis: { type: 'string', enum: ['PER_DAY', 'PER_NIGHT', 'PER_LINE'] } },
        },
      },
    },
    async (request, reply) => {
      const grant = await manage(request);
      const created = await withTransaction(db, (tx) => createExpenseCategory(tx, grant, request.body as { code: string; name: string; limitBasis: string }));
      reply.status(201);
      return created;
    },
  );

  app.patch(
    '/expense/categories/:id',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], minProperties: 2, properties: { expectedVersion, name: { type: 'string', minLength: 1, maxLength: 100, pattern: '\\S' }, active: { type: 'boolean' } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await manage(request, id);
      return withTransaction(db, (tx) => updateExpenseCategory(tx, grant, id, request.body as { expectedVersion: number; name?: string; active?: boolean }));
    },
  );
}
