// Confirmation policies (FR-080; BR-029; DF11). A policy is a dated company record: a duration in calendar days or
// months from the employee's joining date (the only authorised start basis so far), for the employees it applies to
// (any or one employment type, grade and location). A case takes the most specific policy that applies on its start
// date and keeps it (confirmation/service.ts), so a policy in use never changes: a change of terms is a new revision
// of the code from a later date, which closes the previous revision on that date, and a policy is retired by ending
// it. Neither may cut off a case already opened under it. Equally specific policies that could apply to the same
// employee on overlapping dates are refused (DF11; migration 0081 guards the same rule in the database). The month-end
// clamp and the non-inclusive count are the DF11 rule (31 January + 1 month = 28 February) and the extension limit is
// the DF11 maximum of two; a new code may count its start day inclusively instead (I-84 item 12), and a new revision keeps
// what the previous one recorded. Writing
// needs an unrestricted company-scope assignment, as for the other company-wide configuration.
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';

export type DurationUnit = 'CALENDAR_DAYS' | 'CALENDAR_MONTHS';
export type StartBasis = 'JOINING_DATE';

/** The terms a new revision may change; applicability stays with the code. */
export interface PolicyTerms {
  duration: number;
  durationUnit: DurationUnit;
  startBasis: StartBasis;
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
}

export interface PolicyInput extends PolicyTerms {
  code: string;
  /**
   * BRD lines 2065 and 3926 `start_day_inclusive` (I-84 item 12; I-74 item 6; decided under owner delegation, 6 Nov 2026): true counts
   * the start date as day one, so the period ends, and the review falls due, one day earlier than the DF11 count. Joining 1 January
   * on six calendar months: 1 July by DF11 (the default, false), 30 June counted inclusively; on 90 days: 1 April, or 31 March. Set
   * when a code is created and carried by every later revision, like the other date rules.
   */
  startDayInclusive?: boolean | undefined;
  /** Employment type code (EMPLOYMENT_TYPE list); absent or null applies to every type. */
  employmentType?: string | null | undefined;
  gradeId?: string | null | undefined;
  locationId?: string | null | undefined;
}

/**
 * Technical bounds (not policy limits): a century in either unit keeps every due date within what date arithmetic
 * represents, so a stored policy can always open a case. The duration itself is the company's choice.
 */
const DURATION_BOUND: Readonly<Record<DurationUnit, number>> = { CALENDAR_DAYS: 36_600, CALENDAR_MONTHS: 1_200 };

/** The advisory lock of a company's policy writes (exclusive); migration 0081's guard and case opening (shared) take the same one. */
export const POLICY_LOCK_SQL = `hashtextextended('confirmation-policy:' || $1::uuid::text, 0)`;

interface PolicyRow {
  id: string;
  code: string;
  revision: number;
  duration: number;
  duration_unit: DurationUnit;
  start_basis: StartBasis;
  month_end_rule: string;
  start_day_inclusive: boolean;
  employment_type_id: string | null;
  employment_type: string | null;
  grade_id: string | null;
  grade_code: string | null;
  grade_name: string | null;
  location_id: string | null;
  location_code: string | null;
  location_name: string | null;
  max_extensions: number;
  effective_from: string;
  effective_to: string | null;
  latest_case_start: string | null;
  is_latest: boolean;
  version: number;
}

const POLICY_SELECT = `
  select p.id, p.code, p.revision, p.duration, p.duration_unit, p.start_basis, p.month_end_rule, p.start_day_inclusive,
         p.employment_type_id, et.code as employment_type, p.grade_id, g.code as grade_code, g.name as grade_name,
         p.location_id, l.code as location_code, l.name as location_name, p.max_extensions,
         to_char(p.effective_from, 'YYYY-MM-DD') as effective_from, to_char(p.effective_to, 'YYYY-MM-DD') as effective_to,
         (select to_char(max(c.start_date), 'YYYY-MM-DD') from employee_confirmation c where c.company_id = p.company_id and c.policy_id = p.id) as latest_case_start,
         not exists (select 1 from confirmation_policy n where n.company_id = p.company_id and n.code = p.code and n.revision > p.revision) as is_latest,
         p.version
    from confirmation_policy p
    left join reference_value et on et.company_id = p.company_id and et.id = p.employment_type_id
    left join grade g on g.company_id = p.company_id and g.id = p.grade_id
    left join location l on l.company_id = p.company_id and l.id = p.location_id`;

/** What the policy says (its stored definition), as the audit records it. */
function definitionOf(r: PolicyRow) {
  return {
    code: r.code,
    revision: r.revision,
    duration: r.duration,
    durationUnit: r.duration_unit,
    startBasis: r.start_basis,
    monthEndRule: r.month_end_rule,
    startDayInclusive: r.start_day_inclusive,
    employmentType: r.employment_type,
    gradeId: r.grade_id,
    gradeCode: r.grade_code,
    gradeName: r.grade_name,
    locationId: r.location_id,
    locationCode: r.location_code,
    locationName: r.location_name,
    maxExtensions: r.max_extensions,
    effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to,
  };
}

function policyView(r: PolicyRow, businessDate: string) {
  return {
    id: r.id,
    ...definitionOf(r),
    /** Where the policy stands on the company business date. */
    status: r.effective_from > businessDate ? 'SCHEDULED' : r.effective_to !== null && r.effective_to <= businessDate ? 'ENDED' : 'IN_FORCE',
    /** The latest revision of its code: the one a new revision follows. */
    latest: r.is_latest,
    /** A case uses this policy, so its terms are fixed (0009). */
    inUse: r.latest_case_start !== null,
    /** The latest start date of a case under this policy: an end date or a new revision must come after it. */
    latestCaseStart: r.latest_case_start,
    version: r.version,
  };
}

export type PolicyView = ReturnType<typeof policyView>;

async function loadPolicy(db: Queryable, companyId: string, id: string, lock = false): Promise<PolicyRow | undefined> {
  return (await db.query<PolicyRow>(`${POLICY_SELECT} where p.company_id = $1 and p.id = $2${lock ? ' for update of p' : ''}`, [companyId, id])).rows[0];
}

/** Every revision of every policy, by code and revision, and the active values a policy can apply to. */
export async function listPolicies(db: Queryable, grant: AccessGrant) {
  const rows = (await db.query<PolicyRow>(`${POLICY_SELECT} where p.company_id = $1 order by p.code, p.revision`, [grant.companyId])).rows;
  const master = async (table: 'grade' | 'location') =>
    (await db.query<{ id: string; code: string; name: string }>(`select id, code, name from ${table} where company_id = $1 and active order by code`, [grant.companyId])).rows;
  const employmentTypes = (
    await db.query<{ code: string; label: string }>(`select code, label from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and active order by code`, [grant.companyId])
  ).rows;
  return {
    items: rows.map((r) => policyView(r, grant.businessDate)),
    applicability: { employmentTypes, grades: await master('grade'), locations: await master('location') },
  };
}

/** A real calendar date PostgreSQL can hold (no silent roll-over such as 2026-02-30, no year 0000). */
const isDate = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '0001-01-01') return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

/** Positive whole duration (BR-029) and a period whose end, when given, comes after its start (0009). */
function checkTerms(input: PolicyTerms): void {
  if (!Number.isInteger(input.duration) || input.duration < 1) {
    throw new HttpError(422, 'INVALID_DURATION', 'The duration must be a whole number of calendar days or months greater than zero');
  }
  if (input.duration > DURATION_BOUND[input.durationUnit]) {
    throw new HttpError(422, 'INVALID_DURATION', `The duration cannot exceed ${DURATION_BOUND[input.durationUnit]} ${input.durationUnit === 'CALENDAR_DAYS' ? 'days' : 'months'}`);
  }
  if (!isDate(input.effectiveFrom)) throw new HttpError(422, 'INVALID_DATE', 'The start date must be a calendar date', { field: 'effectiveFrom' });
  if (input.effectiveTo !== undefined && input.effectiveTo !== null) {
    if (!isDate(input.effectiveTo)) throw new HttpError(422, 'INVALID_DATE', 'The end date must be a calendar date', { field: 'effectiveTo' });
    if (input.effectiveTo <= input.effectiveFrom) throw new HttpError(422, 'INVALID_PERIOD', 'The end date must be after the start date');
  }
}

/**
 * Policies are company-wide configuration: changing them needs an unrestricted company-scope assignment. The company's
 * policy writes are serialised (before any row lock) and the duty is resolved again after the lock, so a narrowing
 * committed since the route guard refuses the change.
 */
async function beginPolicyWrite(tx: Queryable, grant: AccessGrant): Promise<void> {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) {
    throw new HttpError(403, 'FORBIDDEN', 'Confirmation policies are changed in an unrestricted company-scope assignment');
  }
  await tx.query(`select pg_advisory_xact_lock(${POLICY_LOCK_SQL})`, [grant.companyId]);
  await reassertAccess(tx, grant, 'confirmation_policy', 'manage', ['operational']);
}

interface Applicability {
  employmentTypeId: string | null;
  gradeId: string | null;
  locationId: string | null;
}

async function resolveApplicability(tx: Queryable, companyId: string, input: PolicyInput): Promise<Applicability> {
  const one = async (sql: string, value: string, message: string, field: string) => {
    const id = (await tx.query<{ id: string }>(sql, [companyId, value])).rows[0]?.id;
    if (!id) throw new HttpError(422, 'INVALID_REFERENCE', message, { field });
    return id;
  };
  return {
    employmentTypeId: input.employmentType
      ? await one(`select id from reference_value where company_id = $1 and category = 'EMPLOYMENT_TYPE' and code = $2 and active`, input.employmentType, 'Unknown employment type', 'employmentType')
      : null,
    gradeId: input.gradeId ? await one(`select id from grade where company_id = $1 and id = $2::uuid and active`, input.gradeId, 'The grade is not an active grade of this company', 'gradeId') : null,
    locationId: input.locationId
      ? await one(`select id from location where company_id = $1 and id = $2::uuid and active`, input.locationId, 'The location is not an active location of this company', 'locationId')
      : null,
  };
}

/** DF11: refused when an equally specific policy could apply to the same employee on an overlapping date. */
async function refuseOverlap(tx: Queryable, companyId: string, a: Applicability, from: string, to: string | null): Promise<void> {
  const other = (
    await tx.query<{ code: string; revision: number; effective_from: string; effective_to: string | null }>(
      `with x as (select hrms_confirmation_policy_conflict($1, null, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date) as id)
       select o.code, o.revision, to_char(o.effective_from, 'YYYY-MM-DD') as effective_from, to_char(o.effective_to, 'YYYY-MM-DD') as effective_to
         from x join confirmation_policy o on o.company_id = $1 and o.id = x.id`,
      [companyId, a.employmentTypeId, a.gradeId, a.locationId, from, to],
    )
  ).rows[0];
  if (other) {
    throw new HttpError(
      409,
      'POLICY_OVERLAP',
      `Policy ${other.code} revision ${other.revision} applies equally to the same employees on overlapping dates; end it first, or change this policy's applicability or dates`,
      { code: other.code, revision: other.revision, effectiveFrom: other.effective_from, effectiveTo: other.effective_to },
    );
  }
}

async function audit(tx: Queryable, grant: AccessGrant, row: PolicyRow, action: string, before?: PolicyRow) {
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'confirmation_policy',
    recordKey: row.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    priorVersion: before?.version ?? null,
    newVersion: row.version,
    before: before ? { operational: definitionOf(before) } : null,
    after: { operational: definitionOf(row) },
  });
}

/** What every policy of a code carries beyond its terms: the DF11 date rule and extension limit. */
interface CarriedRules {
  month_end_rule: string;
  start_day_inclusive: boolean;
  max_extensions: number;
}

/** DF11: joining date + N, clamped to month end, not counting the start day; a maximum of two extensions. */
const DF11_RULES: CarriedRules = { month_end_rule: 'CLAMP_TO_MONTH_END', start_day_inclusive: false, max_extensions: 2 };

async function insertPolicy(tx: Queryable, grant: AccessGrant, code: string, revision: number, terms: PolicyTerms, a: Applicability, rules: CarriedRules): Promise<PolicyRow> {
  const id = (
    await tx.query<{ id: string }>(
      `insert into confirmation_policy (company_id, code, revision, duration, duration_unit, start_basis, month_end_rule, start_day_inclusive, max_extensions,
                                        employment_type_id, grade_id, location_id, effective_from, effective_to, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $15) returning id`,
      [
        grant.companyId,
        code,
        revision,
        terms.duration,
        terms.durationUnit,
        terms.startBasis,
        rules.month_end_rule,
        rules.start_day_inclusive,
        rules.max_extensions,
        a.employmentTypeId,
        a.gradeId,
        a.locationId,
        terms.effectiveFrom,
        terms.effectiveTo ?? null,
        grant.userId,
      ],
    )
  ).rows[0]!.id;
  return (await loadPolicy(tx, grant.companyId, id))!;
}

/** Revision 1 of a new policy code. */
export async function createPolicy(tx: Queryable, grant: AccessGrant, input: PolicyInput): Promise<PolicyView> {
  await beginPolicyWrite(tx, grant);
  if (!/^[A-Z][A-Z0-9_]{0,39}$/.test(input.code)) {
    throw new HttpError(422, 'INVALID_CODE', 'The code must start with a capital letter and use only capital letters, digits and underscores (at most 40)', { field: 'code' });
  }
  checkTerms(input);
  const exists = await tx.query(`select 1 from confirmation_policy where company_id = $1 and code = $2`, [grant.companyId, input.code]);
  if ((exists.rowCount ?? 0) > 0) throw new HttpError(409, 'POLICY_EXISTS', 'A policy with this code exists; create a new revision of it instead');
  const a = await resolveApplicability(tx, grant.companyId, input);
  await refuseOverlap(tx, grant.companyId, a, input.effectiveFrom, input.effectiveTo ?? null);
  const row = await insertPolicy(tx, grant, input.code, 1, input, a, { ...DF11_RULES, start_day_inclusive: input.startDayInclusive === true });
  await audit(tx, grant, row, 'CREATE');
  return policyView(row, grant.businessDate);
}

/**
 * The next revision after the latest revision `baseId`, with the same applicability, date rule and extension limit and
 * new terms from a later date. The base closes on that date, which must come after every case opened under it.
 */
export async function createPolicyRevision(tx: Queryable, grant: AccessGrant, baseId: string, input: PolicyTerms & { expectedVersion: number }) {
  await beginPolicyWrite(tx, grant);
  const base = await loadPolicy(tx, grant.companyId, baseId, true);
  if (!base) throw notFound();
  if (!base.is_latest) throw new HttpError(409, 'NOT_LATEST_REVISION', 'A later revision of this policy exists; reload and start from it');
  if (base.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  checkTerms(input);
  if (input.effectiveFrom <= base.effective_from) {
    throw new HttpError(422, 'RULE_VIOLATION', `A new revision must take effect after revision ${base.revision}, in force from ${base.effective_from}`);
  }
  const closes = base.effective_to === null || base.effective_to > input.effectiveFrom;
  if (closes && base.latest_case_start !== null && base.latest_case_start >= input.effectiveFrom) {
    throw new HttpError(422, 'POLICY_IN_USE', `A case opened under revision ${base.revision} starts on ${base.latest_case_start}; the new revision must take effect after it`, {
      latestCaseStart: base.latest_case_start,
    });
  }
  const a: Applicability = { employmentTypeId: base.employment_type_id, gradeId: base.grade_id, locationId: base.location_id };
  let closedRevisionId: string | null = null;
  if (closes) {
    await tx.query(`update confirmation_policy set effective_to = $3::date, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, base.id, input.effectiveFrom, grant.userId]);
    await audit(tx, grant, (await loadPolicy(tx, grant.companyId, base.id))!, 'CLOSE', base);
    closedRevisionId = base.id;
  }
  await refuseOverlap(tx, grant.companyId, a, input.effectiveFrom, input.effectiveTo ?? null);
  const row = await insertPolicy(tx, grant, base.code, base.revision + 1, input, a, base);
  await audit(tx, grant, row, 'CREATE_REVISION');
  return { ...policyView(row, grant.businessDate), closedRevisionId };
}

/**
 * Ends a policy: it no longer applies to employees joining on or after `effectiveTo`. Only brings the end forward (a
 * later end is a new revision), never to or before its start, and never to or before the start of a case under it.
 */
export async function retirePolicy(tx: Queryable, grant: AccessGrant, id: string, input: { effectiveTo: string; expectedVersion: number }): Promise<PolicyView> {
  await beginPolicyWrite(tx, grant);
  const p = await loadPolicy(tx, grant.companyId, id, true);
  if (!p) throw notFound();
  if (p.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (!isDate(input.effectiveTo)) throw new HttpError(422, 'INVALID_DATE', 'The end date must be a calendar date', { field: 'effectiveTo' });
  if (input.effectiveTo <= p.effective_from) throw new HttpError(422, 'INVALID_PERIOD', 'The end date must be after the start date');
  if (p.effective_to !== null && input.effectiveTo >= p.effective_to) {
    throw new HttpError(422, 'RULE_VIOLATION', `This policy already ends on ${p.effective_to}; a retirement can only bring the end date forward`);
  }
  if (p.latest_case_start !== null && p.latest_case_start >= input.effectiveTo) {
    throw new HttpError(422, 'POLICY_IN_USE', `A case opened under this policy starts on ${p.latest_case_start}; the end date must come after it`, { latestCaseStart: p.latest_case_start });
  }
  await tx.query(`update confirmation_policy set effective_to = $3::date, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, id, input.effectiveTo, grant.userId]);
  const row = (await loadPolicy(tx, grant.companyId, id))!;
  await audit(tx, grant, row, 'RETIRE', p);
  return policyView(row, grant.businessDate);
}

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
// Whole-number and date rules are the service's, so they are refused in its plain words (422), not as a malformed request.
const termProperties = {
  duration: { type: 'number' },
  durationUnit: { type: 'string', enum: ['CALENDAR_DAYS', 'CALENDAR_MONTHS'] },
  startBasis: { type: 'string', enum: ['JOINING_DATE'] },
  effectiveFrom: { type: 'string', maxLength: 10 },
  effectiveTo: { type: ['string', 'null'], maxLength: 10 },
} as const;

export async function confirmationPolicyRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  app.get('/confirmation-policies', async (request) => {
    const grant = await requireAccess(db, request, 'confirmation_policy', 'manage', ['operational']);
    return listPolicies(db, grant);
  });

  app.post(
    '/confirmation-policies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'duration', 'durationUnit', 'startBasis', 'effectiveFrom'],
          properties: {
            code: { type: 'string', maxLength: 40 },
            ...termProperties,
            employmentType: { type: ['string', 'null'], maxLength: 40 },
            gradeId: { type: ['string', 'null'], format: 'uuid' },
            locationId: { type: ['string', 'null'], format: 'uuid' },
            startDayInclusive: { type: 'boolean' },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'confirmation_policy', 'manage', ['operational'], { requireAll: true });
      const result = await withTransaction(db, (tx) => createPolicy(tx, grant, request.body as PolicyInput));
      reply.status(201);
      return result;
    },
  );

  app.post(
    '/confirmation-policies/:id/revisions',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['duration', 'durationUnit', 'startBasis', 'effectiveFrom', 'expectedVersion'],
          properties: { ...termProperties, expectedVersion: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'confirmation_policy', 'manage', ['operational'], { requireAll: true, recordKey: id });
      const result = await withTransaction(db, (tx) => createPolicyRevision(tx, grant, id, request.body as PolicyTerms & { expectedVersion: number }));
      reply.status(201);
      return result;
    },
  );

  app.post(
    '/confirmation-policies/:id/retire',
    {
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['effectiveTo', 'expectedVersion'],
          properties: { effectiveTo: { type: 'string', maxLength: 10 }, expectedVersion: { type: 'integer', minimum: 1 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'confirmation_policy', 'manage', ['operational'], { requireAll: true, recordKey: id });
      return withTransaction(db, (tx) => retirePolicy(tx, grant, id, request.body as { effectiveTo: string; expectedVersion: number }));
    },
  );
}
