// Bell curve (BRD coverage CL-132 "Performance management -> Bell Curve", under FR-040 to FR-044; FR-044 "Respect configured
// employee visibility of ratings, HR oversight, appraisal report and bell curve ... Proposed distribution charts must report
// selected population and period", acceptance "score counts reconcile to the selected population"; BR-044; DF02; migration 0262;
// built 10 Nov 2026 from the reference screen's structure: cycle, department, grade; show data / show bell curve; decided under owner
// delegation, 6 Nov 2026).
//
// Read-only. For one cycle, the completed appraisals' final ratings (the confirmed revision's result, as reports.ts counts them)
// within the selected assignment's row scope, the caller's own appraisal always left out (I-24), optionally narrowed to a department
// and a grade (the employee's assignment on the business date, as the cycle report narrows by department). The answer states its
// population, period, filters and scope, and gives:
// - the exact distribution: each distinct final rating with its count and share (always);
// - when bands are set for the cycle or the company (0262): per band, the actual count and share of the population against the
//   band's target share and the count that share would mean. The bands cover 1.00 to 5.00 without gap or overlap, so the band
//   counts add up to the population.
// F1 "no forced distribution" (docs/03 I-24) is kept: a target is a reference HR sets to compare against; nothing here or anywhere
// constrains, changes, normalises or blocks a rating because of it, and none exists until HR records one. Ratings are confidential
// (DF02), so the bell curve needs appraisal.report.rating, like the rating part of the cycle report.
//
// The bands and targets are kept by HR (appraisal_distribution.manage, operational configuration, from an unrestricted company-scope
// assignment) as append-only revisions, for one cycle or as the company default; the highest revision of the cycle's own applies,
// else the highest of the company default.
import type { FastifyInstance } from 'fastify';
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { requireAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { loadCycle, requireUnrestricted } from './common.js';

/** The F1 rating scale, in hundredths (final ratings are stored with two decimals). */
const SCALE_MIN = 100;
const SCALE_MAX = 500;
const MAX_BANDS = 20;

export interface BandInput {
  code: string;
  label: string;
  minRating: string;
  maxRating: string;
  targetPercent: string;
}

/** A decimal with at most two places as hundredths, or null (no float arithmetic: 33.33 + 33.33 + 33.34 is exactly 100). */
function hundredths(value: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}

const decimal = (h: number) => `${Math.floor(h / 100)}.${String(h % 100).padStart(2, '0')}`;

/** The bands as the database will check them at commit, with a clear refusal first. */
export function checkBands(bands: BandInput[]): { code: string; label: string; min: number; max: number; target: number }[] {
  if (bands.length === 0 || bands.length > MAX_BANDS) throw new HttpError(422, 'INVALID_BANDS', `Give 1 to ${MAX_BANDS} bands`);
  const out = bands.map((b, i) => {
    const code = b.code.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,19}$/.test(code)) throw new HttpError(422, 'INVALID_BAND_CODE', 'A band code is 1 to 20 letters, digits or underscores, starting with a letter', { band: i + 1 });
    const label = b.label.trim();
    if (!label || label.length > 100) throw new HttpError(422, 'INVALID_BAND_LABEL', 'A band needs a label of at most 100 characters', { band: i + 1 });
    const min = hundredths(b.minRating);
    const max = hundredths(b.maxRating);
    const target = hundredths(b.targetPercent);
    if (min === null || max === null || min < SCALE_MIN || max > SCALE_MAX || max < min) {
      throw new HttpError(422, 'INVALID_BAND_RANGE', 'A band covers ratings from 1.00 to 5.00, its lowest not above its highest', { band: i + 1 });
    }
    if (target === null || target > 10_000) throw new HttpError(422, 'INVALID_TARGET', 'A target share is 0 to 100 with at most two decimals', { band: i + 1 });
    return { code, label, min, max, target };
  });
  if (new Set(out.map((b) => b.code)).size !== out.length) throw new HttpError(422, 'DUPLICATE_BAND_CODE', 'Each band needs its own code');
  // In order from the lowest ratings: 1.00 first, each band starting 0.01 above the previous one's highest, 5.00 last.
  const contiguous = out.every((b, i) => (i === 0 ? b.min === SCALE_MIN : b.min === out[i - 1]!.max + 1)) && out[out.length - 1]!.max === SCALE_MAX;
  if (!contiguous) {
    throw new HttpError(422, 'BANDS_NOT_CONTIGUOUS', 'List the bands from the lowest ratings up, covering 1.00 to 5.00 without gap or overlap (each starts 0.01 above the previous one)');
  }
  const total = out.reduce((s, b) => s + b.target, 0);
  if (total !== 10_000) throw new HttpError(422, 'TARGET_TOTAL_NOT_100', 'The target shares must add up to exactly 100', { total: decimal(total) });
  return out;
}

interface SettingRow {
  id: string;
  cycleId: string | null;
  revision: number;
  reason: string;
  createdAt: string;
  createdBy: string;
  bands: { sequence: number; code: string; label: string; minRating: string; maxRating: string; targetPercent: string }[];
}

const SETTING_SELECT = `select s.id, s.cycle_id as "cycleId", s.revision, s.reason, s.created_at as "createdAt", s.created_by as "createdBy",
       (select json_agg(json_build_object('sequence', b.sequence, 'code', b.code, 'label', b.label, 'minRating', b.min_rating::text,
                                          'maxRating', b.max_rating::text, 'targetPercent', b.target_percent::text) order by b.sequence)
          from appraisal_rating_band b where b.company_id = s.company_id and b.setting_id = s.id) as bands
  from appraisal_rating_band_setting s`;

/** Every revision, newest first: the company default's (cycleId null) and each cycle's, or one cycle's and the default's. */
export async function listDistributions(db: Queryable, grant: AccessGrant, q: { cycleId?: string | undefined }) {
  const rows = (
    await db.query<SettingRow>(
      `${SETTING_SELECT} where s.company_id = $1 and ($2::uuid is null or s.cycle_id is null or s.cycle_id = $2::uuid)
        order by s.cycle_id nulls first, s.revision desc`,
      [grant.companyId, q.cycleId ?? null],
    )
  ).rows;
  return { items: rows, inForce: q.cycleId ? await inForce(db, grant.companyId, q.cycleId) : null };
}

/** The revision that applies to a cycle: its own highest, else the company default's highest; none when neither exists. */
async function inForce(db: Queryable, companyId: string, cycleId: string): Promise<(SettingRow & { source: 'CYCLE' | 'COMPANY' }) | null> {
  const row = (
    await db.query<SettingRow>(
      `${SETTING_SELECT} where s.company_id = $1 and (s.cycle_id = $2::uuid or s.cycle_id is null)
        order by (s.cycle_id is null), s.revision desc limit 1`,
      [companyId, cycleId],
    )
  ).rows[0];
  return row ? { ...row, source: row.cycleId ? 'CYCLE' : 'COMPANY' } : null;
}

export async function recordDistribution(tx: Queryable, grant: AccessGrant, input: { cycleId?: string | null; reason: string; bands: BandInput[] }) {
  requireUnrestricted(grant);
  const reason = input.reason.trim();
  if (!reason) throw new HttpError(422, 'REASON_REQUIRED', 'Say why the bands or targets are set');
  const bands = checkBands(input.bands);
  const cycleId = input.cycleId ?? null;
  if (cycleId && !(await loadCycle(tx, grant.companyId, cycleId))) throw notFound();
  // One revision number at a time per cycle (or the default).
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [`appraisal-distribution:${grant.companyId}:${cycleId ?? 'default'}`]);
  const revision = (
    await tx.query<{ n: number }>(
      `select coalesce(max(revision), 0)::int + 1 as n from appraisal_rating_band_setting where company_id = $1 and cycle_id is not distinct from $2::uuid`,
      [grant.companyId, cycleId],
    )
  ).rows[0]!.n;
  const id = (
    await tx.query<{ id: string }>(
      `insert into appraisal_rating_band_setting (company_id, cycle_id, revision, reason, created_by, acting_assignment_id) values ($1, $2, $3, $4, $5, $6) returning id`,
      [grant.companyId, cycleId, revision, reason, grant.userId, grant.assignmentId],
    )
  ).rows[0]!.id;
  for (const [i, b] of bands.entries()) {
    await tx.query(
      `insert into appraisal_rating_band (company_id, setting_id, sequence, code, label, min_rating, max_rating, target_percent) values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [grant.companyId, id, i + 1, b.code, b.label, decimal(b.min), decimal(b.max), decimal(b.target)],
    );
  }
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'appraisal_distribution',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    after: { operational: { cycleId, revision, bands: bands.map((b) => ({ code: b.code, min: decimal(b.min), max: decimal(b.max), targetPercent: decimal(b.target) })) } },
    reason,
  });
  return (await tx.query<SettingRow>(`${SETTING_SELECT} where s.company_id = $1 and s.id = $2`, [grant.companyId, id])).rows[0]!;
}

export interface BellCurveQuery {
  departmentId?: string | undefined;
  gradeId?: string | undefined;
}

/** The bell curve of one cycle (see the header): population, exact distribution, and bands against targets when set. */
export async function bellCurve(db: Queryable, grant: AccessGrant, cycleId: string, q: BellCurveQuery) {
  const cycle = await loadCycle(db, grant.companyId, cycleId);
  if (!cycle) throw notFound();
  const p = new SqlParams();
  const where = [
    employeeScopePredicate(grant, { company: 'a.company_id', employee: 'a.employee_id' }, p),
    `a.cycle_id = ${p.add(cycleId)}::uuid`,
    `a.state = 'APPROVED'`,
  ];
  if (grant.linkedEmployeeId) where.push(`a.employee_id <> ${p.add(grant.linkedEmployeeId)}::uuid`);
  if (q.departmentId || q.gradeId) {
    const day = p.add(grant.businessDate);
    where.push(
      `exists (select 1 from employment_assignment ea where ea.company_id = a.company_id and ea.employee_id = a.employee_id
                 and ea.effective_from <= ${day}::date and (ea.effective_to is null or ea.effective_to > ${day}::date)
                 ${q.departmentId ? `and ea.department_id = ${p.add(q.departmentId)}::uuid` : ''}
                 ${q.gradeId ? `and ea.grade_id = ${p.add(q.gradeId)}::uuid` : ''})`,
    );
  }
  const pop = `select a.final_rating from appraisal a where ${where.join(' and ')}`;
  const share = (n: string, total: string) => `case when ${total} = 0 then null else round(${n} * 100.0 / ${total}, 2)::text end`;
  const exact = (
    await db.query<{ rating: string; count: number; percent: string | null }>(
      `with pop as (${pop}), t as (select count(*)::int as n from pop)
       select pop.final_rating::text as rating, count(*)::int as count, ${share('count(*)', 't.n')} as percent
         from pop, t group by pop.final_rating, t.n order by pop.final_rating`,
      p.values,
    )
  ).rows;
  const completed = exact.reduce((s, r) => s + r.count, 0);
  const setting = await inForce(db, grant.companyId, cycleId);
  let bands: Record<string, unknown>[] | null = null;
  if (setting) {
    const sid = p.add(setting.id);
    const company = p.add(grant.companyId);
    bands = (
      await db.query(
        `with pop as (${pop}), t as (select count(*)::int as n from pop)
         select b.sequence, b.code, b.label, b.min_rating::text as "minRating", b.max_rating::text as "maxRating", b.target_percent::text as "targetPercent",
                c.actual as "actualCount", ${share('c.actual', 't.n')} as "actualPercent",
                round(b.target_percent * t.n / 100.0, 1)::text as "targetCount",
                case when t.n = 0 then null else (round(c.actual * 100.0 / t.n, 2) - b.target_percent)::text end as "differencePercent"
           from appraisal_rating_band b
           cross join t
           cross join lateral (select count(*)::int as actual from pop where pop.final_rating between b.min_rating and b.max_rating) c
          where b.company_id = ${company}::uuid and b.setting_id = ${sid}::uuid
          order by b.sequence`,
        p.values,
      )
    ).rows;
  }
  return {
    cycle: { id: cycle.id, code: cycle.code, name: cycle.name, startDate: cycle.start_date, endDate: cycle.end_date, state: cycle.state },
    // FR-044: the period and population the chart reports.
    period: { from: cycle.start_date, to: cycle.end_date },
    filters: { departmentId: q.departmentId ?? null, gradeId: q.gradeId ?? null },
    scope: grant.scopeKind,
    ownAppraisalExcluded: grant.linkedEmployeeId !== null,
    generatedAt: new Date().toISOString(),
    population: completed,
    distribution: exact,
    target: setting ? { source: setting.source, settingId: setting.id, revision: setting.revision, reason: setting.reason, setAt: setting.createdAt } : null,
    bands,
    // F1: a target is a reference only; nothing constrains or changes a rating because of it.
    targetEnforced: false,
  };
}

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const ratingValue = { type: 'string', pattern: '^\\d{1,3}(\\.\\d{1,2})?$' } as const;

export async function bellCurveRoutes(app: FastifyInstance, opts: { db: Database }): Promise<void> {
  const { db } = opts;

  // The bell curve: confidential ratings, so the rating group of the report right (as the cycle report's rating part).
  app.get(
    '/appraisal-cycles/:id/bell-curve',
    { schema: { params: idParams, querystring: { type: 'object', additionalProperties: false, properties: { departmentId: uuid, gradeId: uuid } } } },
    async (request) => {
      const { id } = request.params as { id: string };
      const grant = await requireAccess(db, request, 'appraisal', 'report', ['rating'], { requireAll: true, recordKey: id });
      return bellCurve(db, grant, id, request.query as BellCurveQuery);
    },
  );

  // Bands and targets: read with the cycle list's right; recorded by HR.
  app.get('/appraisal-rating-distributions', { schema: { querystring: { type: 'object', additionalProperties: false, properties: { cycleId: uuid } } } }, async (request) =>
    listDistributions(db, await requireAccess(db, request, 'appraisal_cycle', 'read', ['operational'], { requireAll: true }), request.query as { cycleId?: string }),
  );

  app.post(
    '/appraisal-rating-distributions',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['reason', 'bands'],
          properties: {
            cycleId: { anyOf: [uuid, { type: 'null' }] },
            reason: { type: 'string', minLength: 1, maxLength: 1000 },
            bands: {
              type: 'array',
              minItems: 1,
              maxItems: MAX_BANDS,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['code', 'label', 'minRating', 'maxRating', 'targetPercent'],
                properties: { code: { type: 'string', minLength: 1, maxLength: 20 }, label: { type: 'string', minLength: 1, maxLength: 100 }, minRating: ratingValue, maxRating: ratingValue, targetPercent: ratingValue },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const grant = await requireAccess(db, request, 'appraisal_distribution', 'manage', ['operational'], { requireAll: true });
      const created = await withTransaction(db, (tx) => recordDistribution(tx, grant, request.body as { cycleId?: string | null; reason: string; bands: BandInput[] }));
      reply.status(201);
      return created;
    },
  );
}
