// Attendance policy revisions and their mappings (FR-020 "the policy screen exposes thresholds"; BR-009; DF05; E05). HR
// maintains a DRAFT revision of a policy code (effective period, grace, present and half-day percentages, the overtime
// setting, grade and location mappings); an activated revision is frozen (0008, 0115), so a change is a new revision.
// Every value comes from the person maintaining it; nothing is defaulted. Overtime (decided under owner delegation, 6 Nov
// 2026, I-78 item 5; 0181): a revision whose overtime setting is on states its basis, minimum and rounding unit (the BRD
// gives none, so all three are required and none is defaulted); evaluation then derives overtime CANDIDATES only, which
// nothing values or pays. With the setting off a revision has no rules and no candidates.
//
// Activation is independent of whoever wrote the draft (C4; DF05) and ends the earlier revisions of the same code on the
// new revision's first day, so two revisions never tie (POLICY_AMBIGUOUS). A tie with any other revision in force is
// refused (409 POLICY_OVERLAP here, hrms_attendance_policy_no_overlap in the database). Policies apply company-wide, so
// every change needs an unrestricted company-scope assignment (DF02 row scope).
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess, requireAccess } from '../../http/guard.js';
import type { AccessGrant } from '../access/authorize.js';

export const UNMAPPED_WARNING = 'No grade, location or company-wide mapping is set, so this policy applies to nobody.';
export const OVERLAP_WARNING = 'Its mappings tie with another revision in force at the same priority, so it cannot be activated as it stands.';

const stale = () => new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');

function requireCompanyWide(grant: AccessGrant): void {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) {
    throw new HttpError(403, 'FORBIDDEN', 'Attendance policies are maintained from an unrestricted company-scope assignment');
  }
}

/** The same key as the guard (0115): policy changes of one company run one after another. Taken before any row lock. */
const lockPolicies = (tx: Queryable, companyId: string) => tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`attendance:policy:${companyId}`]);

export interface PolicyThresholds {
  effectiveFrom: string;
  effectiveTo?: string | null | undefined;
  graceMinutes: number;
  /** Percent of scheduled net minutes, up to two decimals (DF05). */
  presentPercent: string;
  halfDayPercent: string;
  overtimeEnabled: boolean;
  /** I-78 item 5: required together when overtime is on, absent when it is off. */
  overtimeBasis?: 'AFTER_SHIFT_END' | 'BEYOND_SCHEDULED_NET' | null | undefined;
  overtimeMinimumMinutes?: number | null | undefined;
  overtimeRoundingMinutes?: number | null | undefined;
}

type OvertimeRules = Pick<PolicyThresholds, 'overtimeEnabled' | 'overtimeBasis' | 'overtimeMinimumMinutes' | 'overtimeRoundingMinutes'>;

function checkThresholds(v: Pick<PolicyThresholds, 'effectiveFrom' | 'effectiveTo' | 'presentPercent' | 'halfDayPercent'> & OvertimeRules): void {
  if (v.effectiveTo && v.effectiveTo <= v.effectiveFrom) throw new HttpError(422, 'INVALID_PERIOD', 'The effective end must be after the effective start');
  const [present, half] = [Number(v.presentPercent), Number(v.halfDayPercent)];
  if (!(present > 0 && present <= 100) || !(half > 0 && half < present)) {
    throw new HttpError(422, 'INVALID_THRESHOLDS', 'The present percentage is at most 100, and the half-day percentage is above 0 and below the present percentage');
  }
  const given = [v.overtimeBasis, v.overtimeMinimumMinutes, v.overtimeRoundingMinutes].filter((x) => x !== undefined && x !== null).length;
  if (v.overtimeEnabled && given !== 3) throw new HttpError(422, 'OVERTIME_RULES_REQUIRED', 'With overtime on, state its basis, its minimum and its rounding unit');
  if (!v.overtimeEnabled && given !== 0) throw new HttpError(422, 'OVERTIME_RULES_NOT_ALLOWED', 'Overtime rules apply only with the overtime setting on');
}

interface ListRow {
  mappings: unknown[];
  overlaps: unknown[];
  [column: string]: unknown;
}

/** Every revision with its thresholds, mappings and period; a warning in words for one mapped to nobody or tying with another. */
export async function listAttendancePolicies(db: Queryable, grant: AccessGrant) {
  const rows = await db.query<ListRow>(
    `select p.id, p.code, p.revision, p.effective_from as "effectiveFrom", p.effective_to as "effectiveTo", p.grace_minutes as "graceMinutes",
            p.present_percent::text as "presentPercent", p.half_day_percent::text as "halfDayPercent", p.overtime_enabled as "overtimeEnabled",
            p.overtime_basis as "overtimeBasis", p.overtime_minimum_minutes as "overtimeMinimumMinutes", p.overtime_rounding_minutes as "overtimeRoundingMinutes", p.state, p.version,
            p.activated_at as "activatedAt", p.activated_by as "activatedBy", p.created_by as "createdBy",
            coalesce((select json_agg(json_build_object('id', m.id, 'gradeId', m.grade_id, 'grade', g.code, 'locationId', m.location_id, 'location', l.code, 'priority', num_nonnulls(m.grade_id, m.location_id))
                                      order by num_nonnulls(m.grade_id, m.location_id) desc, g.code, l.code)
                        from attendance_policy_mapping m
                        left join grade g on g.company_id = m.company_id and g.id = m.grade_id
                        left join location l on l.company_id = m.company_id and l.id = m.location_id
                       where m.company_id = p.company_id and m.policy_id = p.id), '[]'::json) as mappings,
            coalesce((select json_agg(json_build_object('policyId', o.id, 'code', o.code, 'revision', o.revision) order by o.code, o.revision)
                        from hrms_attendance_policy_conflicts(p.company_id, p.id) c join attendance_policy o on o.company_id = p.company_id and o.id = c.policy_id
                       where o.code <> p.code or o.effective_from >= p.effective_from), '[]'::json) as overlaps
       from attendance_policy p where p.company_id = $1 order by p.code, p.revision`,
    [grant.companyId],
  );
  return {
    items: rows.rows.map((r) => ({
      ...r,
      warnings: [...(r.mappings.length === 0 ? [{ code: 'UNMAPPED', text: UNMAPPED_WARNING }] : []), ...(r.overlaps.length > 0 ? [{ code: 'OVERLAPPING_MAPPING', text: OVERLAP_WARNING }] : [])],
    })),
  };
}

/** What a mapping can name: this company's active grades and locations (the maintenance form's choices). */
export async function attendancePolicyOptions(db: Queryable, grant: AccessGrant) {
  const list = async (sql: string) => (await db.query(sql, [grant.companyId])).rows;
  const [grades, locations] = await Promise.all([
    list(`select id, code, name from grade where company_id = $1 and active order by code`),
    list(`select id, code, name from location where company_id = $1 and active order by code`),
  ]);
  return { grades, locations };
}

/** A new DRAFT: the next revision of its code, or revision 1 of a new code. Its mappings are added next. */
export async function createAttendancePolicy(tx: Queryable, grant: AccessGrant, input: PolicyThresholds & { code: string }) {
  requireCompanyWide(grant);
  checkThresholds(input);
  await lockPolicies(tx, grant.companyId);
  await reassertAccess(tx, grant, 'attendance_policy', 'manage', ['operational']);
  const row = (
    await tx.query<{ id: string; revision: number; version: number }>(
      `insert into attendance_policy (company_id, code, revision, effective_from, effective_to, grace_minutes, present_percent, half_day_percent, overtime_enabled,
                                      overtime_basis, overtime_minimum_minutes, overtime_rounding_minutes, state, created_by, updated_by)
       select $1, $2, coalesce(max(revision), 0) + 1, $3, $4, $5, $6::numeric, $7::numeric, $8, $10, $11, $12, 'DRAFT', $9, $9 from attendance_policy where company_id = $1 and code = $2
       returning id, revision, version`,
      [
        grant.companyId,
        input.code,
        input.effectiveFrom,
        input.effectiveTo ?? null,
        input.graceMinutes,
        input.presentPercent,
        input.halfDayPercent,
        input.overtimeEnabled,
        grant.userId,
        input.overtimeBasis ?? null,
        input.overtimeMinimumMinutes ?? null,
        input.overtimeRoundingMinutes ?? null,
      ],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_policy',
    recordKey: row.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: row.version,
    after: { operational: { ...input, effectiveTo: input.effectiveTo ?? null, revision: row.revision, state: 'DRAFT' } },
  });
  return { id: row.id, code: input.code, revision: row.revision, state: 'DRAFT', version: row.version };
}

interface PolicyRow {
  code: string;
  revision: number;
  effective_from: string;
  effective_to: string | null;
  grace_minutes: number;
  present_percent: string;
  half_day_percent: string;
  overtime_enabled: boolean;
  overtime_basis: PolicyThresholds['overtimeBasis'];
  overtime_minimum_minutes: number | null;
  overtime_rounding_minutes: number | null;
  state: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
}

async function lockPolicy(tx: Queryable, grant: AccessGrant, id: string): Promise<PolicyRow> {
  await lockPolicies(tx, grant.companyId);
  const p = (
    await tx.query<PolicyRow>(
      `select code, revision, effective_from, effective_to, grace_minutes, present_percent::text as present_percent, half_day_percent::text as half_day_percent,
              overtime_enabled, overtime_basis, overtime_minimum_minutes, overtime_rounding_minutes, state, version, created_by, updated_by
         from attendance_policy where company_id = $1 and id = $2 for update`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!p) throw notFound();
  return p;
}

async function lockDraft(tx: Queryable, grant: AccessGrant, id: string, expectedVersion: number): Promise<PolicyRow> {
  requireCompanyWide(grant);
  const p = await lockPolicy(tx, grant, id);
  await reassertAccess(tx, grant, 'attendance_policy', 'manage', ['operational']);
  if (p.version !== expectedVersion) throw stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'POLICY_NOT_DRAFT', 'Only a draft revision can be changed; an activated revision needs a new revision');
  return p;
}

export async function updateAttendancePolicy(tx: Queryable, grant: AccessGrant, id: string, input: Partial<PolicyThresholds> & { expectedVersion: number }) {
  const p = await lockDraft(tx, grant, id, input.expectedVersion);
  const overtimeEnabled = input.overtimeEnabled ?? p.overtime_enabled;
  // Turning overtime off clears its rules; otherwise a rule not given keeps its value.
  const rule = <T>(given: T | undefined, current: T) => (given !== undefined ? given : overtimeEnabled ? current : null);
  const next = {
    effectiveFrom: input.effectiveFrom ?? p.effective_from,
    effectiveTo: input.effectiveTo === undefined ? p.effective_to : input.effectiveTo,
    graceMinutes: input.graceMinutes ?? p.grace_minutes,
    presentPercent: input.presentPercent ?? p.present_percent,
    halfDayPercent: input.halfDayPercent ?? p.half_day_percent,
    overtimeEnabled,
    overtimeBasis: rule(input.overtimeBasis, p.overtime_basis) ?? null,
    overtimeMinimumMinutes: rule(input.overtimeMinimumMinutes, p.overtime_minimum_minutes) ?? null,
    overtimeRoundingMinutes: rule(input.overtimeRoundingMinutes, p.overtime_rounding_minutes) ?? null,
  };
  checkThresholds(next);
  await tx.query(
    `update attendance_policy set effective_from = $3, effective_to = $4, grace_minutes = $5, present_percent = $6::numeric, half_day_percent = $7::numeric, overtime_enabled = $8, updated_by = $9,
            overtime_basis = $10, overtime_minimum_minutes = $11, overtime_rounding_minutes = $12
      where company_id = $1 and id = $2`,
    [
      grant.companyId,
      id,
      next.effectiveFrom,
      next.effectiveTo,
      next.graceMinutes,
      next.presentPercent,
      next.halfDayPercent,
      next.overtimeEnabled,
      grant.userId,
      next.overtimeBasis,
      next.overtimeMinimumMinutes,
      next.overtimeRoundingMinutes,
    ],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_policy',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UPDATE',
    priorVersion: p.version,
    before: {
      operational: {
        effectiveFrom: p.effective_from,
        effectiveTo: p.effective_to,
        graceMinutes: p.grace_minutes,
        presentPercent: p.present_percent,
        halfDayPercent: p.half_day_percent,
        overtimeEnabled: p.overtime_enabled,
        overtimeBasis: p.overtime_basis,
        overtimeMinimumMinutes: p.overtime_minimum_minutes,
        overtimeRoundingMinutes: p.overtime_rounding_minutes,
      },
    },
    after: { operational: next },
  });
  return { id, version: p.version + 1 };
}

/** A mapping of a draft: a grade, a location, both, or neither (company-wide, the lowest priority). The draft's version moves, so an activator reviewing the earlier mappings gets a stale refusal. */
export async function addAttendancePolicyMapping(tx: Queryable, grant: AccessGrant, policyId: string, input: { expectedVersion: number; gradeId?: string | undefined; locationId?: string | undefined }) {
  const p = await lockDraft(tx, grant, policyId, input.expectedVersion);
  const refs = (
    await tx.query<{ grade: boolean; location: boolean }>(
      `select ($2::uuid is null or exists (select 1 from grade where company_id = $1 and id = $2 and active)) as grade,
              ($3::uuid is null or exists (select 1 from location where company_id = $1 and id = $3 and active)) as location`,
      [grant.companyId, input.gradeId ?? null, input.locationId ?? null],
    )
  ).rows[0]!;
  if (!refs.grade || !refs.location) throw new HttpError(422, 'INVALID_REFERENCE', 'The grade or location is not active in this company');
  const duplicate = await tx.query(`select 1 from attendance_policy_mapping where company_id = $1 and policy_id = $2 and grade_id is not distinct from $3::uuid and location_id is not distinct from $4::uuid`, [
    grant.companyId,
    policyId,
    input.gradeId ?? null,
    input.locationId ?? null,
  ]);
  if (duplicate.rowCount) throw new HttpError(409, 'MAPPING_EXISTS', 'This revision already has this mapping');
  const mappingId = (
    await tx.query<{ id: string }>(`insert into attendance_policy_mapping (company_id, policy_id, grade_id, location_id, created_by, updated_by) values ($1, $2, $3, $4, $5, $5) returning id`, [
      grant.companyId,
      policyId,
      input.gradeId ?? null,
      input.locationId ?? null,
      grant.userId,
    ])
  ).rows[0]!.id;
  await tx.query(`update attendance_policy set updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, policyId, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_policy',
    recordKey: policyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'MAP',
    priorVersion: p.version,
    after: { operational: { mappingId, gradeId: input.gradeId ?? null, locationId: input.locationId ?? null } },
  });
  return { id: mappingId, policyVersion: p.version + 1 };
}

export async function removeAttendancePolicyMapping(tx: Queryable, grant: AccessGrant, policyId: string, mappingId: string, expectedVersion: number) {
  const p = await lockDraft(tx, grant, policyId, expectedVersion);
  const removed = (
    await tx.query<{ grade_id: string | null; location_id: string | null }>(`delete from attendance_policy_mapping where company_id = $1 and policy_id = $2 and id = $3 returning grade_id, location_id`, [
      grant.companyId,
      policyId,
      mappingId,
    ])
  ).rows[0];
  if (!removed) throw notFound();
  await tx.query(`update attendance_policy set updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, policyId, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_policy',
    recordKey: policyId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'UNMAP',
    priorVersion: p.version,
    before: { operational: { mappingId, gradeId: removed.grade_id, locationId: removed.location_id } },
  });
  return { policyVersion: p.version + 1 };
}

/**
 * C4/DF05: activation needs a different person from whoever wrote or last edited the draft. The earlier revisions of the
 * same code still in force on the new revision's first day end there; what they already decided stays theirs. Any other
 * tie is refused with the revisions in the way.
 */
export async function activateAttendancePolicy(tx: Queryable, grant: AccessGrant, policyId: string, expectedVersion: number) {
  requireCompanyWide(grant);
  const p = await lockPolicy(tx, grant, policyId);
  await reassertAccess(tx, grant, 'attendance_policy', 'activate', ['operational']);
  if (p.version !== expectedVersion) throw stale();
  if (p.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only draft policies can be activated');
  if (p.created_by === grant.userId || p.updated_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'A policy cannot be activated by its author');
  // I-78 item 5 (0181 refuses it too): overtime on needs its rules before the revision applies to anyone.
  if (p.overtime_enabled && p.overtime_basis == null) throw new HttpError(409, 'OVERTIME_RULES_REQUIRED', 'With overtime on, state its basis, its minimum and its rounding unit before activation');
  const predecessors = (
    await tx.query<{ id: string; revision: number; effective_to: string | null; version: number }>(
      `select id, revision, effective_to, version from attendance_policy
        where company_id = $1 and code = $2 and id <> $3 and state = 'ACTIVE' and effective_from < $4::date and (effective_to is null or effective_to > $4::date)
        order by revision for update`,
      [grant.companyId, p.code, policyId, p.effective_from],
    )
  ).rows;
  const blocking = (
    await tx.query<{ policy_id: string; code: string; revision: number; effective_from: string; effective_to: string | null }>(
      `select o.id as policy_id, o.code, o.revision, o.effective_from, o.effective_to
         from hrms_attendance_policy_conflicts($1, $2) c join attendance_policy o on o.company_id = $1 and o.id = c.policy_id
        where not (o.id = any($3::uuid[])) order by o.code, o.revision`,
      [grant.companyId, policyId, predecessors.map((c) => c.id)],
    )
  ).rows;
  if (blocking.length > 0) {
    throw new HttpError(409, 'POLICY_OVERLAP', 'Another revision applies to the same employees at the same priority in an overlapping period', {
      revisions: blocking.map((c) => ({ policyId: c.policy_id, code: c.code, revision: c.revision, effectiveFrom: c.effective_from, effectiveTo: c.effective_to })),
    });
  }
  for (const c of predecessors) {
    await tx.query(`update attendance_policy set effective_to = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, c.id, p.effective_from, grant.userId]);
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'attendance_policy',
      recordKey: c.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'CLOSE',
      priorVersion: c.version,
      before: { operational: { effectiveTo: c.effective_to } },
      after: { operational: { effectiveTo: p.effective_from, supersededBy: policyId } },
    });
  }
  await tx.query(`update attendance_policy set state = 'ACTIVE', activated_by = $3, activated_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, policyId, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_policy',
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
 * policy). It still applies to dates before that end, so reprocessing stays deterministic; a revision that would never
 * have started simply leaves force. Under the activation duty: it changes who has a policy.
 */
export async function retireAttendancePolicy(tx: Queryable, grant: AccessGrant, policyId: string, input: { expectedVersion: number; effectiveTo: string; reason: string }) {
  requireCompanyWide(grant);
  const p = await lockPolicy(tx, grant, policyId);
  await reassertAccess(tx, grant, 'attendance_policy', 'activate', ['operational']);
  if (p.version !== input.expectedVersion) throw stale();
  if (p.state !== 'ACTIVE') throw new HttpError(409, 'INVALID_STATE', 'Only an active revision can be retired');
  if (input.effectiveTo < grant.businessDate) throw new HttpError(422, 'BACKDATED_RETIREMENT', 'A revision is retired from today or a later date');
  if (p.effective_to && input.effectiveTo > p.effective_to) throw new HttpError(422, 'INVALID_PERIOD', 'A retirement cannot extend the revision past its current end');
  const effectiveTo = input.effectiveTo <= p.effective_from ? null : input.effectiveTo;
  await tx.query(`update attendance_policy set state = 'RETIRED', effective_to = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, policyId, effectiveTo, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'attendance_policy',
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
// Routes
// ---------------------------------------------------------------------------------------------------------------

const uuid = { type: 'string', format: 'uuid' } as const;
const date = { type: 'string', format: 'date' } as const;
const expectedVersion = { type: 'integer', minimum: 1 } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const percent = { type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,2})?$' } as const;
const thresholds = {
  effectiveFrom: date,
  effectiveTo: { anyOf: [date, { type: 'null' }] },
  graceMinutes: { type: 'integer', minimum: 0, maximum: 1440 },
  presentPercent: percent,
  halfDayPercent: percent,
  overtimeEnabled: { type: 'boolean' },
  // I-78 item 5: together when overtime is on (no default: the BRD gives none).
  overtimeBasis: { anyOf: [{ type: 'string', enum: ['AFTER_SHIFT_END', 'BEYOND_SCHEDULED_NET'] }, { type: 'null' }] },
  // A type list, not anyOf: anyOf would let type coercion turn a refused 0 into null.
  overtimeMinimumMinutes: { type: ['integer', 'null'], minimum: 0, maximum: 1440 },
  overtimeRoundingMinutes: { type: ['integer', 'null'], minimum: 1, maximum: 1440 },
} as const;

export async function attendancePolicyRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;
  const manage = (request: Parameters<typeof requireAccess>[1], recordKey?: string) => requireAccess(db, request, 'attendance_policy', 'manage', ['operational'], { requireAll: true, ...(recordKey ? { recordKey } : {}) });
  const activate = (request: Parameters<typeof requireAccess>[1], recordKey: string) => requireAccess(db, request, 'attendance_policy', 'activate', ['operational'], { requireAll: true, recordKey });

  app.get('/attendance/policies', async (request) => listAttendancePolicies(db, await requireAccess(db, request, 'attendance_policy', 'manage', ['operational'])));
  app.get('/attendance/policy-options', async (request) => attendancePolicyOptions(db, await requireAccess(db, request, 'attendance_policy', 'manage', ['operational'])));

  app.post(
    '/attendance/policies',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['code', 'effectiveFrom', 'graceMinutes', 'presentPercent', 'halfDayPercent', 'overtimeEnabled'],
          properties: { code: { type: 'string', pattern: '^[A-Z][A-Z0-9_]{0,39}$' }, ...thresholds },
        },
      },
    },
    async (request, reply) => {
      const grant = await manage(request);
      const created = await withTransaction(db, (tx) => createAttendancePolicy(tx, grant, request.body as PolicyThresholds & { code: string }));
      reply.status(201);
      return created;
    },
  );

  app.patch(
    '/attendance/policies/:id',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], minProperties: 2, properties: { expectedVersion, ...thresholds } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await manage(request, id);
      return withTransaction(db, (tx) => updateAttendancePolicy(tx, grant, id, request.body as Partial<PolicyThresholds> & { expectedVersion: number }));
    },
  );

  app.post(
    '/attendance/policies/:id/mappings',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion, gradeId: uuid, locationId: uuid } } } },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const grant = await manage(request, id);
      const created = await withTransaction(db, (tx) => addAttendancePolicyMapping(tx, grant, id, request.body as { expectedVersion: number; gradeId?: string; locationId?: string }));
      reply.status(201);
      return created;
    },
  );

  app.post(
    '/attendance/policies/:id/mappings/:mappingId/remove',
    {
      schema: {
        params: { type: 'object', required: ['id', 'mappingId'], properties: { id: uuid, mappingId: uuid } },
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } },
      },
    },
    async (request) => {
      const { id, mappingId } = request.params as { id: string; mappingId: string };
      const grant = await manage(request, id);
      return withTransaction(db, (tx) => removeAttendancePolicyMapping(tx, grant, id, mappingId, (request.body as { expectedVersion: number }).expectedVersion));
    },
  );

  app.post(
    '/attendance/policies/:id/activate',
    { schema: { params: idParams, body: { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await activate(request, id);
      return withTransaction(db, (tx) => activateAttendancePolicy(tx, grant, id, (request.body as { expectedVersion: number }).expectedVersion));
    },
  );

  app.post(
    '/attendance/policies/:id/retire',
    {
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, required: ['expectedVersion', 'effectiveTo', 'reason'], properties: { expectedVersion, effectiveTo: date, reason: { type: 'string', minLength: 1, maxLength: 500, pattern: '\\S' } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await activate(request, id);
      return withTransaction(db, (tx) => retireAttendancePolicy(tx, grant, id, request.body as { expectedVersion: number; effectiveTo: string; reason: string }));
    },
  );
}
