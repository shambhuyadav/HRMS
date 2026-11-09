// Leave types, policy revisions and their mappings (FR-024; BR-010; DF05; E06; ZT09). HR maintains a DRAFT revision of a
// leave type (effective period, parameters, grade, location and employment-type mappings); an activated revision is
// frozen (0007, 0110), so a change is a new revision. Policies apply company-wide, so every change needs an unrestricted
// company-scope assignment, as activation always did (DF02 row scope).
//
// Deterministic selection (FR-024 acceptance, documented priority): for an employee, type and date, among the revisions
// in force, the mapping with the most dimensions set wins (selectPolicy). Two revisions whose mappings could match the
// same employee with the same number of dimensions in overlapping periods are rejected at activation (409 POLICY_OVERLAP
// here, hrms_leave_policy_no_overlap in the database), or the activation closes the earlier revision when asked to.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { ACTIVE_STATUSES, ENDED_STATUSES, isCompanyWide, POLICY_IN_FORCE } from './service.js';

export const UNMAPPED_WARNING = 'No grade, location or employment type is mapped, so this policy applies to nobody.';
export const OVERLAP_WARNING = 'Its mappings overlap another revision of this leave type at the same priority.';

function requireCompanyWide(grant: AccessGrant): void {
  if (!isCompanyWide(grant)) throw new HttpError(403, 'FORBIDDEN', 'Leave types and policies are maintained from an unrestricted company-scope assignment');
}

const stale = () => new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');

// ---------------------------------------------------------------------------------------------------------
// Leave types
// ---------------------------------------------------------------------------------------------------------

export async function listLeaveTypes(db: Queryable, grant: AccessGrant) {
  const rows = await db.query(`select id, code, name, unit, paid, active, version from leave_type where company_id = $1 order by code`, [grant.companyId]);
  return { items: rows.rows };
}

export async function createLeaveType(tx: Queryable, grant: AccessGrant, input: { code: string; name: string; paid: boolean }) {
  requireCompanyWide(grant);
  await reassertAccess(tx, grant, 'leave_policy', 'manage', ['operational']);
  const inserted = (
    await tx.query<{ id: string; version: number }>(
      `insert into leave_type (company_id, code, name, unit, paid, active, created_by, updated_by)
       values ($1, $2, $3, 'DAY', $4, true, $5, $5) on conflict (company_id, code) do nothing returning id, version`,
      [grant.companyId, input.code, input.name.trim(), input.paid, grant.userId],
    )
  ).rows[0];
  if (!inserted) throw new HttpError(409, 'LEAVE_TYPE_EXISTS', 'A leave type with this code already exists');
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_type',
    recordKey: inserted.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: inserted.version,
    after: { operational: { code: input.code, name: input.name.trim(), paid: input.paid, active: true } },
  });
  return inserted;
}

/** The name and the active flag; the code, unit and paid flag are fixed at creation (0110), since balances and pay rest on them. */
export async function updateLeaveType(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number; name?: string | undefined; active?: boolean | undefined }) {
  requireCompanyWide(grant);
  const t = (await tx.query<{ name: string; active: boolean; version: number }>(`select name, active, version from leave_type where company_id = $1 and id = $2 for no key update`, [grant.companyId, id])).rows[0];
  if (!t) throw notFound();
  await reassertAccess(tx, grant, 'leave_policy', 'manage', ['operational']);
  if (t.version !== input.expectedVersion) throw stale();
  const name = input.name?.trim() ?? t.name;
  const active = input.active ?? t.active;
  if (name === t.name && active === t.active) throw new HttpError(422, 'NO_CHANGE', 'Nothing differs from the current record');
  if (!active && t.active) {
    const inForce = await tx.query(`select 1 from leave_policy where company_id = $1 and leave_type_id = $2 and (state = 'ACTIVE' or (state = 'RETIRED' and effective_to > hrms_business_date(company_id, now()))) limit 1`, [grant.companyId, id]);
    if (inForce.rowCount) throw new HttpError(409, 'ACTIVE_POLICY_EXISTS', 'Retire every revision of this leave type before deactivating it');
  }
  await tx.query(`update leave_type set name = $3, active = $4, updated_by = $5 where company_id = $1 and id = $2`, [grant.companyId, id, name, active, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_type',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    priorVersion: t.version,
    before: { operational: { name: t.name, active: t.active } },
    after: { operational: { name, active } },
  });
  return { id, version: t.version + 1 };
}

// ---------------------------------------------------------------------------------------------------------
// Policy revisions
// ---------------------------------------------------------------------------------------------------------

export interface PolicyListFilters {
  leaveType?: string | undefined;
  /** The revision takes effect on or after this date (E06 effective-from filter). */
  effectiveFrom?: string | undefined;
  state?: 'DRAFT' | 'ACTIVE' | 'RETIRED' | undefined;
}

interface PolicyListRow {
  mappings: unknown[];
  overlaps: unknown[];
  [column: string]: unknown;
}

/** Every revision with its mappings; a warning in words for a revision mapped to nobody or overlapping another (FR-024). */
export async function listPolicies(db: Queryable, grant: AccessGrant, f: PolicyListFilters = {}) {
  const rows = await db.query<PolicyListRow>(
    `select p.id, t.code as "leaveType", t.name as "leaveTypeName", t.paid, p.revision, p.effective_from as "effectiveFrom", p.effective_to as "effectiveTo",
            p.eligibility_code as "eligibility", p.accrual_rule_code as "accrualRule", p.annual_entitlement::text as "annualEntitlement",
            p.min_service_days as "minServiceDays", p.carry_cap::text as "carryCap", p.leave_year_start_month as "leaveYearStartMonth", p.state, p.version,
            coalesce((select json_agg(json_build_object('id', m.id, 'employmentTypeId', m.employment_type_id, 'employmentType', et.code, 'gradeId', m.grade_id, 'grade', g.code,
                                                        'locationId', m.location_id, 'location', l.code, 'priority', num_nonnulls(m.employment_type_id, m.grade_id, m.location_id))
                                      order by num_nonnulls(m.employment_type_id, m.grade_id, m.location_id) desc, et.code, g.code, l.code)
                        from leave_policy_mapping m
                        left join reference_value et on et.company_id = m.company_id and et.id = m.employment_type_id
                        left join grade g on g.company_id = m.company_id and g.id = m.grade_id
                        left join location l on l.company_id = m.company_id and l.id = m.location_id
                       where m.company_id = p.company_id and m.policy_id = p.id), '[]'::json) as mappings,
            coalesce((select json_agg(json_build_object('policyId', c.policy_id, 'revision', c.revision) order by c.revision)
                        from hrms_leave_policy_conflicts(p.company_id, p.id) c), '[]'::json) as overlaps
       from leave_policy p join leave_type t on t.company_id = p.company_id and t.id = p.leave_type_id
      where p.company_id = $1 and ($2::text is null or t.code = $2) and ($3::date is null or p.effective_from >= $3::date) and ($4::text is null or p.state = $4)
      order by t.code, p.revision`,
    [grant.companyId, f.leaveType ?? null, f.effectiveFrom ?? null, f.state ?? null],
  );
  return {
    items: rows.rows.map((r) => ({
      ...r,
      unmapped: r.mappings.length === 0,
      warnings: [...(r.mappings.length === 0 ? [{ code: 'UNMAPPED', text: UNMAPPED_WARNING }] : []), ...(r.overlaps.length > 0 ? [{ code: 'OVERLAPPING_MAPPING', text: OVERLAP_WARNING }] : [])],
    })),
  };
}

export interface PolicyValues {
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
  eligibility: string;
  accrualRule: 'MONTHLY_PRORATED' | 'NONE';
  annualEntitlement: string;
  minServiceDays: number;
  /** DF05: carry is zero unless explicitly configured. */
  carryCap?: string | undefined;
  /**
   * I-78 item 3 (decided under owner delegation, 6 Nov 2026; 0183): the month the leave year starts, 1..12; the year ends
   * the day before. No default (companies differ and the BRD names none): without it the revision is never expired at a
   * year end, and the year-end run counts it as not configured.
   */
  leaveYearStartMonth?: number | null | undefined;
}

function checkValues(v: Pick<PolicyValues, 'effectiveFrom' | 'effectiveTo' | 'accrualRule' | 'annualEntitlement'>): void {
  if (v.effectiveTo && v.effectiveTo <= v.effectiveFrom) throw new HttpError(422, 'INVALID_PERIOD', 'The effective end must be after the effective start');
  if (v.accrualRule === 'NONE' && Number(v.annualEntitlement) !== 0) throw new HttpError(422, 'RULE_VIOLATION', 'A revision without accrual has no annual entitlement');
}

/** Numbers the next revision of the type under its lock. Every value comes from the caller: nothing is defaulted but the DF05 zero carry. */
export async function createPolicyDraft(tx: Queryable, grant: AccessGrant, input: PolicyValues & { leaveType: string }) {
  requireCompanyWide(grant);
  checkValues(input);
  const type = (await tx.query<{ id: string }>(`select id from leave_type where company_id = $1 and code = $2 for no key update`, [grant.companyId, input.leaveType])).rows[0];
  if (!type) throw new HttpError(422, 'INVALID_REFERENCE', 'Unknown leave type');
  await reassertAccess(tx, grant, 'leave_policy', 'manage', ['operational']);
  const row = (
    await tx.query<{ id: string; revision: number; version: number }>(
      `insert into leave_policy (company_id, leave_type_id, revision, effective_from, effective_to, eligibility_code, accrual_rule_code, annual_entitlement, min_service_days, carry_cap,
                                 leave_year_start_month, state, created_by, updated_by)
       select $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6, $7::numeric, $8, $9::numeric, $11, 'DRAFT', $10, $10 from leave_policy where company_id = $1 and leave_type_id = $2
       returning id, revision, version`,
      [
        grant.companyId,
        type.id,
        input.effectiveFrom,
        input.effectiveTo ?? null,
        input.eligibility,
        input.accrualRule,
        input.annualEntitlement,
        input.minServiceDays,
        input.carryCap ?? '0',
        grant.userId,
        input.leaveYearStartMonth ?? null,
      ],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_policy',
    recordKey: row.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: row.version,
    after: { operational: { ...input, carryCap: input.carryCap ?? '0', revision: row.revision, state: 'DRAFT' } },
  });
  return { id: row.id, revision: row.revision, state: 'DRAFT', version: row.version };
}

interface PolicyRow {
  leave_type_id: string;
  revision: number;
  effective_from: string;
  effective_to: string | null;
  eligibility_code: string;
  accrual_rule_code: 'MONTHLY_PRORATED' | 'NONE';
  annual_entitlement: string;
  min_service_days: number;
  carry_cap: string;
  leave_year_start_month: number | null;
  state: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
}

/** The leave type lock first, so policy changes of one type run one after another (and cannot deadlock with the overlap guard, 0110). */
async function lockPolicy(tx: Queryable, grant: AccessGrant, id: string): Promise<PolicyRow> {
  const target = (await tx.query<{ leave_type_id: string }>(`select leave_type_id from leave_policy where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!target) throw notFound();
  await tx.query(`select 1 from leave_type where company_id = $1 and id = $2 for no key update`, [grant.companyId, target.leave_type_id]);
  return (
    await tx.query<PolicyRow>(
      `select leave_type_id, revision, effective_from, effective_to, eligibility_code, accrual_rule_code, annual_entitlement::text as annual_entitlement,
              min_service_days, carry_cap::text as carry_cap, leave_year_start_month, state, version, created_by, updated_by
         from leave_policy where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0]!;
}

async function lockDraft(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number): Promise<PolicyRow> {
  requireCompanyWide(grant);
  const p = await lockPolicy(tx, grant, id);
  await reassertAccess(tx, grant, 'leave_policy', 'manage', ['operational']);
  if (p.version !== expectedVersion) throw stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'POLICY_NOT_DRAFT', 'Only a draft revision can be changed; an activated revision needs a new revision');
  return p;
}

export async function updatePolicyDraft(tx: Queryable, grant: AccessGrant, id: string, input: Partial<PolicyValues> & { expectedVersion: number }) {
  const p = await lockDraft(tx, grant, id, input.expectedVersion);
  const next = {
    effectiveFrom: input.effectiveFrom ?? p.effective_from,
    effectiveTo: input.effectiveTo === undefined ? p.effective_to : input.effectiveTo,
    eligibility: input.eligibility ?? p.eligibility_code,
    accrualRule: input.accrualRule ?? p.accrual_rule_code,
    annualEntitlement: input.annualEntitlement ?? p.annual_entitlement,
    minServiceDays: input.minServiceDays ?? p.min_service_days,
    carryCap: input.carryCap ?? p.carry_cap,
    leaveYearStartMonth: input.leaveYearStartMonth === undefined ? p.leave_year_start_month : input.leaveYearStartMonth,
  };
  checkValues(next);
  await tx.query(
    `update leave_policy set effective_from = $3, effective_to = $4, eligibility_code = $5, accrual_rule_code = $6, annual_entitlement = $7::numeric, min_service_days = $8, carry_cap = $9::numeric, updated_by = $10,
            leave_year_start_month = $11
      where company_id = $1 and id = $2`,
    [grant.companyId, id, next.effectiveFrom, next.effectiveTo, next.eligibility, next.accrualRule, next.annualEntitlement, next.minServiceDays, next.carryCap, grant.userId, next.leaveYearStartMonth],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_policy',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    priorVersion: p.version,
    before: {
      operational: {
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
        eligibility: p.eligibility_code,
        accrualRule: p.accrual_rule_code,
        annualEntitlement: p.annual_entitlement,
        minServiceDays: p.min_service_days,
        carryCap: p.carry_cap,
        leaveYearStartMonth: p.leave_year_start_month,
      },
    },
    after: { operational: next },
  });
  return { id, version: p.version + 1 };
}

export interface MappingInput {
  expectedVersion: number;
  employmentTypeId?: string | undefined;
  gradeId?: string | undefined;
  locationId?: string | undefined;
}

/** A mapping of a draft; the draft's version moves, so an activator reviewing the earlier mappings gets a stale refusal. */
export async function addPolicyMapping(tx: Queryable, grant: AccessGrant, policyId: string, input: MappingInput) {
  const p = await lockDraft(tx, grant, policyId, input.expectedVersion);
  if (!input.employmentTypeId && !input.gradeId && !input.locationId) throw new HttpError(422, 'MAPPING_EMPTY', 'A mapping names a grade, a location or an employment type');
  const refs = (
    await tx.query<{ employment_type: boolean; grade: boolean; location: boolean }>(
      `select ($2::uuid is null or exists (select 1 from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and id = $2 and active)) as employment_type,
              ($3::uuid is null or exists (select 1 from grade where company_id = $1 and id = $3 and active)) as grade,
              ($4::uuid is null or exists (select 1 from location where company_id = $1 and id = $4 and active)) as location`,
      [grant.companyId, input.employmentTypeId ?? null, input.gradeId ?? null, input.locationId ?? null],
    )
  ).rows[0]!;
  if (!refs.employment_type || !refs.grade || !refs.location) throw new HttpError(422, 'INVALID_REFERENCE', 'The employment type, grade or location is not active in this company');
  const duplicate = await tx.query(
    `select 1 from leave_policy_mapping where company_id = $1 and policy_id = $2 and employment_type_id is not distinct from $3::uuid and grade_id is not distinct from $4::uuid and location_id is not distinct from $5::uuid`,
    [grant.companyId, policyId, input.employmentTypeId ?? null, input.gradeId ?? null, input.locationId ?? null],
  );
  if (duplicate.rowCount) throw new HttpError(409, 'MAPPING_EXISTS', 'This revision already has this mapping');
  const mappingId = (
    await tx.query<{ id: string }>(
      `insert into leave_policy_mapping (company_id, policy_id, employment_type_id, grade_id, location_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $6, $6) returning id`,
      [grant.companyId, policyId, input.employmentTypeId ?? null, input.gradeId ?? null, input.locationId ?? null, grant.userId],
    )
  ).rows[0]!.id;
  await tx.query(`update leave_policy set updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, policyId, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_policy',
    recordKey: policyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'MAP',
    priorVersion: p.version,
    after: { operational: { mappingId, employmentTypeId: input.employmentTypeId ?? null, gradeId: input.gradeId ?? null, locationId: input.locationId ?? null } },
  });
  return { id: mappingId, policyVersion: p.version + 1 };
}

export async function removePolicyMapping(tx: Queryable, grant: AccessGrant, policyId: string, mappingId: string, expectedVersion: number) {
  const p = await lockDraft(tx, grant, policyId, expectedVersion);
  const removed = (
    await tx.query<{ employment_type_id: string | null; grade_id: string | null; location_id: string | null }>(
      `delete from leave_policy_mapping where company_id = $1 and policy_id = $2 and id = $3 returning employment_type_id, grade_id, location_id`,
      [grant.companyId, policyId, mappingId],
    )
  ).rows[0];
  if (!removed) throw notFound();
  await tx.query(`update leave_policy set updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, policyId, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_policy',
    recordKey: policyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UNMAP',
    priorVersion: p.version,
    before: { operational: { mappingId, employmentTypeId: removed.employment_type_id, gradeId: removed.grade_id, locationId: removed.location_id } },
  });
  return { policyVersion: p.version + 1 };
}

interface Conflict {
  policy_id: string;
  revision: number;
  effective_from: string;
  effective_to: string | null;
  version: number;
}

/**
 * DF05: seeded and maintained revisions start DRAFT; activation needs a different person from whoever wrote the draft. A
 * policy is company configuration: once active it applies to every employee its mappings match, not only those in the
 * activator's row scope, so activation needs an unrestricted company scope, as the accrual run does (DF02 row scope).
 * An overlap at equal priority with another revision in force is refused; with `closePredecessors` an earlier revision
 * (one starting before this one) instead ends when this one starts. Nothing is ever closed without being asked, since a
 * predecessor may also cover employees this revision does not.
 */
export async function activatePolicy(tx: Queryable, grant: AccessGrant, policyId: string, input: { expectedVersion: number; closePredecessors?: boolean | undefined }) {
  requireCompanyWide(grant);
  const p = await lockPolicy(tx, grant, policyId);
  await reassertAccess(tx, grant, 'leave_policy', 'activate', ['operational']);
  if (p.version !== input.expectedVersion) throw stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only draft policies can be activated');
  if (p.created_by === grant.userId || p.updated_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A policy cannot be activated by its author');
  const conflicts = (
    await tx.query<Conflict>(
      `select o.id as policy_id, o.revision, o.effective_from, o.effective_to, o.version
         from hrms_leave_policy_conflicts($1, $2) c join leave_policy o on o.company_id = $1 and o.id = c.policy_id order by o.revision`,
      [grant.companyId, policyId],
    )
  ).rows;
  const closing = input.closePredecessors ? conflicts.filter((c) => c.effective_from < p.effective_from) : [];
  const blocking = conflicts.filter((c) => !closing.includes(c));
  if (blocking.length > 0) {
    throw new HttpError(409, 'POLICY_OVERLAP', 'Another revision of this leave type applies to the same employees at the same priority in an overlapping period', {
      revisions: blocking.map((c) => ({ policyId: c.policy_id, revision: c.revision, effectiveFrom: c.effective_from, effectiveTo: c.effective_to })),
    });
  }
  for (const c of closing) {
    await tx.query(`update leave_policy set effective_to = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, c.policy_id, p.effective_from, grant.userId]);
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'leave_policy',
      recordKey: c.policy_id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'CLOSE',
      priorVersion: c.version,
      before: { operational: { effectiveTo: c.effective_to } },
      after: { operational: { effectiveTo: p.effective_from, supersededBy: policyId } },
    });
  }
  await tx.query(`update leave_policy set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, policyId, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_policy',
    recordKey: policyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'ACTIVATE',
    priorVersion: p.version,
    before: { operational: { state: 'DRAFT' } },
    after: { operational: { state: 'ACTIVE' } },
  });
  return { id: policyId, state: 'ACTIVE', closed: closing.map((c) => c.policy_id) };
}

/**
 * Retires an active revision from a date (exclusive end of its period, today or later: what already happened keeps its
 * policy). It still applies to dates before that end, so back-dated requests and accrual stay deterministic; a revision
 * that would never have started simply leaves force. Under the activation duty: it changes who has a policy.
 */
export async function retirePolicy(tx: Queryable, grant: AccessGrant, policyId: string, input: { expectedVersion: number; effectiveTo: string; reason: string }) {
  requireCompanyWide(grant);
  const p = await lockPolicy(tx, grant, policyId);
  await reassertAccess(tx, grant, 'leave_policy', 'activate', ['operational']);
  if (p.version !== input.expectedVersion) throw stale();
  if (p.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'Only an active revision can be retired');
  const today = (await tx.query<{ d: string }>(`select to_char(hrms_business_date($1, now()), 'YYYY-MM-DD') as d`, [grant.companyId])).rows[0]!.d;
  if (input.effectiveTo < today) throw new HttpError(422, 'BACKDATED_RETIREMENT', 'A revision is retired from today or a later date');
  if (p.effective_to && input.effectiveTo > p.effective_to) throw new HttpError(422, 'RULE_VIOLATION', 'A retirement cannot extend the revision past its current end');
  const effectiveTo = input.effectiveTo <= p.effective_from ? null : input.effectiveTo;
  await tx.query(`update leave_policy set state = 'RETIRED', effective_to = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, policyId, effectiveTo, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'leave_policy',
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

/** What a mapping can name: this company's active employment types, grades and locations (the maintenance form's choices). */
export async function policyOptions(db: Queryable, grant: AccessGrant) {
  const list = async (sql: string) => (await db.query(sql, [grant.companyId])).rows;
  const [employmentTypes, grades, locations] = await Promise.all([
    list(`select id, code, label as name from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and active order by code`),
    list(`select id, code, name from grade where company_id = $1 and active order by code`),
    list(`select id, code, name from location where company_id = $1 and active order by code`),
  ]);
  return { employmentTypes, grades, locations };
}

// ---------------------------------------------------------------------------------------------------------
// Employees without a policy, before accrual (FR-024 acceptance)
// ---------------------------------------------------------------------------------------------------------

/**
 * FR-024 "unmapped employees are listed before accrual": the employees a run of this month would cover, in the caller's
 * row scope, for whom an active paid leave type resolves to no policy or to a tie (POLICY_NOT_FOUND, POLICY_AMBIGUOUS) on
 * the date the run applies (the month's last service day): the accrual run's selection (leave/service.ts), as a set.
 * The first skips that type for the employee and the second fails the run. `mappedLeaveTypes` shows which types do
 * resolve: DF05 gives some groups no paid type at all (contractors), which is not a mistake in itself. Operational only.
 */
export async function employeesWithoutPolicy(db: Queryable, grant: AccessGrant, q: { month: string; page: number; pageSize: number }) {
  const params = new SqlParams([grant.companyId, q.month]);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const active = params.add(ACTIVE_STATUSES);
  const ended = params.add(ENDED_STATUSES);
  const cte = `with b as (select date_trunc('month', ($2 || '-01')::date)::date as m_start,
                                 (date_trunc('month', ($2 || '-01')::date) + interval '1 month - 1 day')::date as m_end),
     emp as (
       select e.id, e.employee_code, e.display_name, e.employment_type_id, et.code as employment_type,
              least(b.m_end, coalesce(x.last_working_date, b.m_end)) as service_end
         from b
         join employee e on e.company_id = $1 and e.joining_date <= b.m_end
         join reference_value st on st.company_id = e.company_id and st.id = e.status_id
         left join reference_value et on et.company_id = e.company_id and et.id = e.employment_type_id
         cross join lateral (select hrms_exit_last_working_date(e.company_id, e.id) as last_working_date) x
        where ${scope}
          and (st.code = any(${active}::text[]) or (st.code = any(${ended}::text[]) and x.last_working_date is not null))
          and (x.last_working_date is null or (x.last_working_date >= b.m_start and x.last_working_date >= e.joining_date))),
     matched as (
       select em.id as employee_id, t.code as leave_type, p.id as policy_id, max(num_nonnulls(m.employment_type_id, m.grade_id, m.location_id)) as priority
         from emp em
         join leave_type t on t.company_id = $1 and t.active
         join leave_policy p on p.company_id = t.company_id and p.leave_type_id = t.id and ${POLICY_IN_FORCE('p', 'em.service_end')}
         join leave_policy_mapping m on m.company_id = p.company_id and m.policy_id = p.id
         left join employment_assignment ea on ea.company_id = t.company_id and ea.employee_id = em.id
               and ea.effective_from <= em.service_end and (ea.effective_to is null or ea.effective_to > em.service_end)
        where (m.employment_type_id is null or m.employment_type_id = em.employment_type_id)
          and (m.grade_id is null or m.grade_id = ea.grade_id)
          and (m.location_id is null or m.location_id = ea.location_id)
        group by em.id, t.code, p.id),
     ranked as (
       select employee_id, leave_type, count(*) filter (where priority = top) as ties
         from (select *, max(priority) over (partition by employee_id, leave_type) as top from matched) z
        group by employee_id, leave_type),
     problems as (
       select em.id as employee_id, t.code as leave_type, case when r.employee_id is null then 'POLICY_NOT_FOUND' else 'POLICY_AMBIGUOUS' end as reason
         from emp em
         join leave_type t on t.company_id = $1 and t.active and t.paid
         left join ranked r on r.employee_id = em.id and r.leave_type = t.code
        where r.employee_id is null or r.ties > 1)`;
  const total = Number((await db.query<{ n: string }>(`${cte} select count(distinct employee_id) as n from problems`, params.values)).rows[0]?.n ?? 0);
  const rows = await db.query(
    `${cte}
     select em.id as "employeeId", em.employee_code as "employeeCode", em.display_name as "employeeName", em.employment_type as "employmentType", em.service_end as "asOf",
            json_agg(json_build_object('leaveType', p.leave_type, 'reason', p.reason) order by p.leave_type) as unresolved,
            coalesce((select json_agg(distinct m.leave_type) from matched m where m.employee_id = em.id), '[]'::json) as "mappedLeaveTypes"
       from problems p join emp em on em.id = p.employee_id
      group by em.id, em.employee_code, em.display_name, em.employment_type, em.service_end
      order by em.employee_code, em.id
      limit ${params.add(q.pageSize)}::int offset ${params.add((q.page - 1) * q.pageSize)}::int`,
    params.values,
  );
  return { month: q.month, items: rows.rows, total, page: q.page, pageSize: q.pageSize };
}
