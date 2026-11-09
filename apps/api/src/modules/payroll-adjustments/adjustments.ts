// Late-timesheet adjustment cases (FR-100; DB111; H2 late-timesheet journey; H4; BR-047; BR-048; BR-049; CI25; CI26; ZT37).
// Migrations 0129, 0205 and 0206; decided under owner delegation, 6 Nov 2026 (docs/03 I-79). An authorised person opens a case for
// an approved timesheet revision that came after the freeze of a processed payroll covering its dates. Under the valuation policy in
// effect (BR-048 "the current applicable adjustment valuation policy") the case is valued, never typed in: the corrected eligible
// units against the units the frozen record recognised (H2), on that record's own rates (computeAdjustment). An independent reviewer
// approves the amount and explanation, returns or rejects; the first later payroll of the employee pays an approved case once, on
// the policy's adjustment component (payroll/calculate.ts step 7b; processing marks it APPLIED). Without a policy a case is recorded
// and held, unvalued, and approval is refused (H2: an unresolved policy "blocks adjustment approval, not a guessed deduction").
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { type ValuationPolicy, valuationPolicyOn } from '../payroll/calculate.js';
import { actorOf, advisoryLock, assertInScope, assertNotSelf, audit, emit, newTransaction, priorDecision, requireText, taskIsPending, taskTransaction, unrestricted, userIsEmployee } from '../payroll/common.js';
import { ownEmployee } from '../payroll-outputs/payslips.js';
import { decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';

export const ADJUSTMENT_KIND = 'timesheet_adjustment';
const LIST_CAP = 200;
const LIVE = ['DRAFT', 'SUBMITTED', 'APPROVED', 'APPLIED'];

/** The named state answered while no valuation policy is in effect, and the refusal of approval then (H2, H8). */
export const VALUATION = {
  status: 'NOT_CONFIGURED',
  code: 'ADJUSTMENT_VALUATION_POLICY_NOT_CONFIGURED',
  message: 'Cases are recorded and held. Approval, valuation and application to a later payroll wait for an activated adjustment valuation policy; nothing here changes a processed payroll.',
} as const;

/** How cases are valued today: under the valuation policy in effect on the business date, or held (I-79). */
export function valuationOf(policy: ValuationPolicy | null) {
  if (!policy) return VALUATION;
  return {
    status: 'CONFIGURED',
    code: 'ADJUSTMENT_VALUATION_POLICY_ACTIVE',
    policyId: policy.id,
    timesheetUnit: policy.timesheet_unit,
    hoursPerDay: policy.hours_per_day,
    message:
      'Corrections are calculated from the processed record: the days it left unpaid on which the approved timesheet records work, at that record\'s own rates (paid days over the days of the month). Missing time never reduces pay. An independently approved correction is paid once by the first later payroll; a processed payroll never changes.',
  } as const;
}

const valuationNow = async (db: Queryable, grant: AccessGrant) => valuationOf(await valuationPolicyOn(db, grant.companyId, grant.businessDate));

const stale = (): never => {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
};

const reassert = (tx: Queryable, grant: AccessGrant, action: 'propose') => reassertAccess(tx, grant, 'payroll_adjustment', action, ['amount']);

/** DF02/C4: never about the caller's own record, in any assignment the user has ever been linked through. */
export async function assertNotOwn(db: Queryable, grant: AccessGrant, employeeId: string): Promise<void> {
  assertNotSelf(grant, employeeId);
  if (await userIsEmployee(db, grant.companyId, grant.userId, employeeId)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
}

const UNITS = /^\d{1,5}(\.\d{1,4})?$/;
function checkUnits(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (!UNITS.test(value)) throw new HttpError(422, 'INVALID_UNITS', `The ${field} is a non-negative quantity with at most 4 decimals`, { field });
  return value;
}

/** A signed exact decimal in the currency's minor unit; returned as text for PostgreSQL numeric, never a JavaScript number. */
export function checkSigned(value: string, minorUnit: number, field: string): string {
  const text = value.trim();
  const decimals = text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
  if (!/^-?\d{1,15}(\.\d{1,4})?$/.test(text) || decimals > minorUnit) {
    throw new HttpError(422, 'INVALID_AMOUNT', `The ${field} must be a signed decimal with at most ${minorUnit} decimals`, { field });
  }
  return text;
}

const VIEW = `select a.id, a.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName", a.adjustment_kind as "adjustmentKind",
    a.source_timesheet_id as "sourceTimesheetId", a.source_revision as "sourceRevision", to_char(t.period_start, 'YYYY-MM-DD') as "serviceStart", to_char(t.period_end, 'YYYY-MM-DD') as "serviceEnd",
    (select coalesce(sum(l.minutes), 0)::int from timesheet_line l where l.company_id = a.company_id and l.timesheet_id = a.source_timesheet_id and l.revision = a.source_revision and l.removed_at is null) as "sourceMinutes",
    a.origin_payroll_record_id as "originRecordId", a.origin_run_id as "originRunId", ru.revision as "originRunRevision", p.period_code as "originPeriodCode", rec.paid_units::text as "originPaidUnits",
    a.previous_recognized_units::text as "previousRecognizedUnits", a.corrected_units::text as "correctedUnits", a.delta_amount::text as "deltaAmount", a.currency_code as "currencyCode",
    a.rule_snapshot as "ruleSnapshot", a.explanation, a.state, a.target_run_id as "targetRunId", a.applied_payroll_line_id as "appliedPayrollLineId", a.follows_adjustment_id as "followsAdjustmentId",
    a.valuation_policy_id as "valuationPolicyId",
    (select tp.period_code from payroll_run tu join payroll_period tp on tp.company_id = tu.company_id and tp.id = tu.period_id
      where tu.company_id = a.company_id and tu.id = a.target_run_id) as "targetPeriodCode",
    a.applied_settlement_id as "appliedSettlementId",
    a.created_by as "createdBy", a.created_at as "createdAt", a.submitted_at as "submittedAt", a.decided_by as "decidedBy", a.decided_at as "decidedAt", a.transaction_id as "transactionId", a.version
  from payroll_adjustment a
  join employee e on e.company_id = a.company_id and e.id = a.employee_id
  join timesheet t on t.company_id = a.company_id and t.id = a.source_timesheet_id
  join payroll_record rec on rec.company_id = a.company_id and rec.id = a.origin_payroll_record_id
  join payroll_run ru on ru.company_id = a.company_id and ru.id = a.origin_run_id
  join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id`;

/** Row scope and never the caller's own record, in SQL, so `total` counts only what the caller may see (I-43). */
function visible(grant: AccessGrant, params: SqlParams, company: string, employee: string): string[] {
  const where: string[] = [];
  if (!unrestricted(grant)) where.push(employeeScopePredicate(grant, { company, employee }, params));
  where.push(`not exists (select 1 from user_employee_link own where own.company_id = ${company} and own.employee_id = ${employee} and own.user_id = ${params.add(grant.userId)}::uuid)`);
  return where;
}

export async function listAdjustments(db: Queryable, grant: AccessGrant, q: { state?: string | undefined; employeeId?: string | undefined } & Paging) {
  const params = new SqlParams([grant.companyId]);
  const where = ['a.company_id = $1', ...visible(grant, params, 'a.company_id', 'a.employee_id')];
  if (q.state) where.push(`a.state = ${params.add(q.state)}`);
  if (q.employeeId) where.push(`a.employee_id = ${params.add(q.employeeId)}::uuid`);
  const page = await pageOf(db, `${VIEW} where ${where.join(' and ')}`, params.values, '"createdAt" desc, id', q, LIST_CAP);
  return { ...page, valuation: await valuationNow(db, grant) };
}

export async function adjustmentDetail(db: Queryable, grant: AccessGrant, id: string) {
  const a = (
    await db.query<{ employeeId: string; sourceTimesheetId: string; sourceRevision: number; originRecordId: string; valuationPolicyId: string | null }>(
      `${VIEW} where a.company_id = $1 and a.id = $2`,
      [grant.companyId, id],
    )
  ).rows[0];
  if (!a) throw notFound();
  await assertInScope(db, grant, a.employeeId);
  await assertNotOwn(db, grant, a.employeeId);
  // The days behind the figures, derived again from the frozen record and the revision under the policy the case was valued under.
  const policy = a.valuationPolicyId ? await policyById(db, grant.companyId, a.valuationPolicyId) : null;
  const days = policy ? (await computeAdjustment(db, grant.companyId, { timesheetId: a.sourceTimesheetId, revision: a.sourceRevision, originRecordId: a.originRecordId }, policy)).days : [];
  return { ...a, valuedDays: days, valuation: await valuationNow(db, grant) };
}

async function policyById(db: Queryable, companyId: string, id: string): Promise<ValuationPolicy | null> {
  return (
    (
      await db.query<ValuationPolicy>(
        `select id, arrears_component_id, adjustment_component_id, recovery_component_id, timesheet_unit, hours_per_day::text as hours_per_day
           from payroll_valuation_policy where company_id = $1 and id = $2`,
        [companyId, id],
      )
    ).rows[0] ?? null
  );
}

export interface Valued {
  previous: string;
  corrected: string;
  delta: string;
  days: { day: string; recognized: string; corrected: string }[];
}

/**
 * FR-100 valuation (BR-048; H2 "compare corrected eligible units to frozen recognized units"; decided under owner delegation, 6 Nov
 * 2026, I-79). Over each day of the timesheet week inside the origin record's segments: the record recognised 1 less its loss-of-pay
 * units (DAY), or that times the policy's hours a day (HOUR). The corrected eligible units are the same, except on a day the approved
 * revision records work: there a whole day (DAY), or the recorded hours up to a day's hours (HOUR), never fewer than recognised. A
 * missing or shorter timesheet never reduces pay (BR-049). The difference is valued at the monthly FIXED earnings of the segment's
 * arrangement (the origin run's heads) over the record's days in month, divided by the hours a day for HOUR, and rounded half-up once
 * to the currency minor unit (DF05, as a month is paid).
 */
export async function computeAdjustment(db: Queryable, companyId: string, src: { timesheetId: string; revision: number; originRecordId: string }, policy: ValuationPolicy): Promise<Valued> {
  const row = (
    await db.query<Valued>(
      `with rec as (
         select r.run_id, r.days_in_month::numeric as dim, ru.currency_minor_unit::smallint as mu
           from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
          where r.company_id = $1 and r.id = $2),
       ts as (select period_start, period_end from timesheet where company_id = $1 and id = $3),
       d as (
         select g::date as day, s.salary_arrangement_id
           from payroll_record_segment s cross join ts
           cross join lateral generate_series(greatest(s.segment_start, ts.period_start), least(s.segment_end, ts.period_end), interval '1 day') g
          where s.company_id = $1 and s.record_id = $2),
       u as (
         select d.day, d.salary_arrangement_id,
                1 - coalesce((select lp.units from payroll_record_lop lp where lp.company_id = $1 and lp.record_id = $2 and lp.day = d.day), 0) as paid,
                coalesce((select sum(l.minutes) from timesheet_line l
                           where l.company_id = $1 and l.timesheet_id = $3 and l.revision = $4 and l.work_date = d.day and l.removed_at is null), 0)::numeric as minutes
           from d),
       v as (
         select u.day, u.salary_arrangement_id,
                case when $5::text = 'HOUR' then u.paid * $6::numeric else u.paid end as recognized,
                case when $5::text = 'HOUR' then greatest(u.paid * $6::numeric, least($6::numeric, u.minutes / 60))
                     when u.minutes > 0 then 1::numeric else u.paid end as corrected
           from u),
       m as (
         select v.*, (select coalesce(sum(sc.amount), 0) from salary_component sc
                        join payroll_run_head rh on rh.company_id = sc.company_id and rh.run_id = (select run_id from rec) and rh.component_id = sc.component_id
                        join payroll_head_revision h on h.company_id = rh.company_id and h.id = rh.head_revision_id
                             and h.in_use and h.calculation_basis = 'FIXED' and h.head_type = 'EARNING'
                       where sc.company_id = $1 and sc.salary_arrangement_id = v.salary_arrangement_id and sc.basis = 'MONTHLY') as monthly
           from v)
       select coalesce(sum(m.recognized), 0)::numeric(9, 4)::text as previous,
              coalesce(sum(m.corrected), 0)::numeric(9, 4)::text as corrected,
              (sign(coalesce(sum((m.corrected - m.recognized) * m.monthly), 0))
                 * hrms_payroll_round_half_up(abs(coalesce(sum((m.corrected - m.recognized) * m.monthly), 0)),
                                              (select dim from rec) * (case when $5::text = 'HOUR' then $6::numeric else 1 end), (select mu from rec)))::numeric(19, 4)::text as delta,
              coalesce(json_agg(json_build_object('day', to_char(m.day, 'YYYY-MM-DD'), 'recognized', m.recognized::numeric(9, 4)::text, 'corrected', m.corrected::numeric(9, 4)::text)
                                order by m.day) filter (where m.corrected <> m.recognized), '[]'::json) as days
         from m`,
      [companyId, src.originRecordId, src.timesheetId, src.revision, policy.timesheet_unit, policy.hours_per_day],
    )
  ).rows[0]!;
  return row;
}

/** Exact decimal text without insignificant zeros, so "967.74" and "967.7400" compare equal; never a JavaScript number. */
const decimal = (text: string) => {
  const negative = text.startsWith('-');
  const [whole = '0', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  const w = whole.replace(/^0+(?=\d)/, '');
  const f = fraction.replace(/0+$/, '');
  const value = f ? `${w}.${f}` : w;
  return negative && value !== '0' ? `-${value}` : value;
};

/**
 * The figures a draft carries: calculated under the policy in effect (I-79), or none while no policy is. Figures a client sends are a
 * check, never an entry: they must equal the calculation.
 */
async function valueDraft(tx: Queryable, grant: AccessGrant, src: { timesheetId: string; revision: number; originRecordId: string }, sent: ReturnType<typeof figureValues>) {
  const policy = await valuationPolicyOn(tx, grant.companyId, grant.businessDate);
  const entered = sent.previous !== null || sent.corrected !== null || sent.delta !== null;
  if (!policy) {
    if (entered) throw new HttpError(409, 'NOT_CONFIGURED', 'Figures are calculated under the adjustment valuation policy, and none is in effect; the case is recorded and held without them', { code: VALUATION.code });
    return { policyId: null, previous: null, corrected: null, delta: null };
  }
  const v = await computeAdjustment(tx, grant.companyId, src, policy);
  const calculated = { previousRecognizedUnits: v.previous, correctedUnits: v.corrected, deltaAmount: v.delta };
  if (
    (sent.previous !== null && decimal(sent.previous) !== decimal(v.previous)) ||
    (sent.corrected !== null && decimal(sent.corrected) !== decimal(v.corrected)) ||
    (sent.delta !== null && decimal(sent.delta) !== decimal(v.delta))
  ) {
    throw new HttpError(422, 'FIGURES_DIFFER', 'The figures differ from the calculation under the valuation policy in effect', { calculated, days: v.days });
  }
  if (decimal(v.delta) === '0') {
    throw new HttpError(422, 'NO_DIFFERENCE', 'The approved timesheet changes nothing the processed payroll recognised: it records no work on a day that payroll left unpaid', { calculated });
  }
  return { policyId: policy.id, previous: v.previous, corrected: v.corrected, delta: v.delta };
}

/**
 * Approved timesheet revisions in force that came after the freeze of a processed payroll covering their dates and have no
 * effective case yet. It is a reading of the two records only: nothing is opened, valued or changed by it.
 */
export async function adjustmentCandidates(db: Queryable, grant: AccessGrant, q: { employeeId?: string | undefined } & Paging) {
  const params = new SqlParams([grant.companyId]);
  const where = ['t.company_id = $1', ...visible(grant, params, 't.company_id', 't.employee_id')];
  if (q.employeeId) where.push(`t.employee_id = ${params.add(q.employeeId)}::uuid`);
  return pageOf(
    db,
    `select t.id as "timesheetId", r.revision, to_char(t.period_start, 'YYYY-MM-DD') as "serviceStart", to_char(t.period_end, 'YYYY-MM-DD') as "serviceEnd", t.employee_id as "employeeId",
            e.employee_code as "employeeCode", e.display_name as "employeeName", rec.id as "originRecordId", ru.id as "originRunId", ru.revision as "originRunRevision", p.period_code as "originPeriodCode",
            case when r.origin = 'REOPENED' then 'AMENDED_TIMESHEET' else 'LATE_TIMESHEET' end as "adjustmentKind", r.decided_at as "approvedAt"
       from timesheet_revision r
       join timesheet t on t.company_id = r.company_id and t.id = r.timesheet_id
       join employee e on e.company_id = t.company_id and e.id = t.employee_id
       join payroll_record rec on rec.company_id = t.company_id and rec.employee_id = t.employee_id and rec.calculation_status = 'CALCULATED'
       join payroll_run ru on ru.company_id = rec.company_id and ru.id = rec.run_id and ru.state = 'PROCESSED_LOCKED'
        and ru.service_start <= t.period_end and ru.service_end >= t.period_start and ru.processed_at < r.decided_at
       join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
      where r.state = 'APPROVED' and r.superseded_at is null and ${where.join(' and ')}
        and not exists (select 1 from payroll_adjustment a where a.company_id = t.company_id and a.source_timesheet_id = t.id and a.source_revision = r.revision
                           and a.origin_payroll_record_id = rec.id and a.state = any(array['DRAFT', 'SUBMITTED', 'APPROVED', 'APPLIED']))`,
    params.values,
    '"approvedAt" desc, "timesheetId", "originRecordId"',
    q,
    LIST_CAP,
  );
}

export interface Figures {
  previousRecognizedUnits?: string | null | undefined;
  correctedUnits?: string | null | undefined;
  deltaAmount?: string | null | undefined;
  explanation?: string | null | undefined;
}

interface Source {
  employee_id: string;
  revision_state: string;
  superseded: boolean;
  origin: string;
  decided_at: Date | null;
  decided_by: string | null;
  period_start: string;
  period_end: string;
}

async function sourceOf(db: Queryable, companyId: string, timesheetId: string, revision: number): Promise<Source | undefined> {
  return (
    await db.query<Source>(
      `select t.employee_id, r.state as revision_state, r.superseded_at is not null as superseded, r.origin, r.decided_at, r.decided_by, to_char(t.period_start, 'YYYY-MM-DD') as period_start, to_char(t.period_end, 'YYYY-MM-DD') as period_end
         from timesheet_revision r join timesheet t on t.company_id = r.company_id and t.id = r.timesheet_id
        where r.company_id = $1 and r.timesheet_id = $2 and r.revision = $3`,
      [companyId, timesheetId, revision],
    )
  ).rows[0];
}

function requireInForce(s: Source): void {
  // BR-048 "Every source revision is uniquely linked"; a superseded revision is no longer what the timesheet says.
  if (s.revision_state !== 'APPROVED' || s.superseded) throw new HttpError(409, 'SOURCE_NOT_IN_FORCE', 'The case must come from the approved timesheet revision in force');
}

const figureValues = (input: Figures, minorUnit: number) => ({
  previous: checkUnits(input.previousRecognizedUnits, 'previousRecognizedUnits'),
  corrected: checkUnits(input.correctedUnits, 'correctedUnits'),
  delta: input.deltaAmount === undefined || input.deltaAmount === null ? null : checkSigned(input.deltaAmount, minorUnit, 'deltaAmount'),
  explanation: input.explanation === undefined || input.explanation === null ? null : requireText(input.explanation, 'explanation', 2000, 'EXPLANATION_REQUIRED'),
});

export async function openAdjustment(tx: Queryable, grant: AccessGrant, input: { timesheetId: string; revision: number; originRecordId: string } & Figures) {
  const source = await sourceOf(tx, grant.companyId, input.timesheetId, input.revision);
  if (!source) throw notFound();
  await assertInScope(tx, grant, source.employee_id);
  await assertNotOwn(tx, grant, source.employee_id);
  // ZT37: the same revision submitted twice, concurrently, makes one case.
  await advisoryLock(tx, `payroll_adjustment:${grant.companyId}:${input.timesheetId}`);
  await reassert(tx, grant, 'propose');
  requireInForce(source);
  const origin = (
    await tx.query<{
      employee_id: string;
      run_id: string;
      run_state: string;
      run_revision: number;
      processed_after_source: boolean;
      overlaps: boolean;
      calculation_status: string;
      currency_code: string;
      minor: number;
      period_id: string;
      period_code: string;
      calendar_id: string;
      paid_day_policy_id: string | null;
      attendance_basis: string | null;
      head_count: number | null;
    }>(
      `select rec.employee_id, ru.id as run_id, ru.state as run_state, ru.revision as run_revision, rec.calculation_status, rec.currency_code, ru.currency_minor_unit as minor, ru.period_id, p.period_code,
              ru.calendar_id, ru.paid_day_policy_id, ru.attendance_basis, ru.head_count,
              ru.processed_at >= $3 as processed_after_source, ru.service_start <= $5::date and ru.service_end >= $4::date as overlaps
         from payroll_record rec
         join payroll_run ru on ru.company_id = rec.company_id and ru.id = rec.run_id
         join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
        where rec.company_id = $1 and rec.id = $2`,
      [grant.companyId, input.originRecordId, source.decided_at, source.period_start, source.period_end],
    )
  ).rows[0];
  // CI26: the same employee; anything else reads as missing.
  if (!origin || origin.employee_id !== source.employee_id) throw notFound();
  if (origin.run_state !== 'PROCESSED_LOCKED' || origin.calculation_status !== 'CALCULATED') throw new HttpError(409, 'ORIGIN_NOT_PROCESSED', 'A case originates in a processed payroll record');
  if (!origin.overlaps) throw new HttpError(422, 'OUTSIDE_ORIGIN_PERIOD', 'The timesheet service dates are outside the payroll period of that record');
  if (origin.processed_after_source) throw new HttpError(409, 'TIMESHEET_NOT_LATE', 'This timesheet revision was approved before that payroll was processed, so it does not correct it');
  const kind = source.origin === 'REOPENED' ? 'AMENDED_TIMESHEET' : 'LATE_TIMESHEET';
  const prior = (
    await tx.query<{ id: string; state: string }>(
      `select id, state from payroll_adjustment where company_id = $1 and source_timesheet_id = $2 and source_revision = $3 and origin_payroll_record_id = $4 and adjustment_kind = $5 order by created_at desc`,
      [grant.companyId, input.timesheetId, input.revision, input.originRecordId, kind],
    )
  ).rows;
  const live = prior.find((p) => LIVE.includes(p.state));
  if (live) throw new HttpError(409, 'ADJUSTMENT_EXISTS', 'This timesheet revision already has a case for that payroll record', { adjustmentId: live.id });
  const f = figureValues(input, origin.minor);
  const v = await valueDraft(tx, grant, { timesheetId: input.timesheetId, revision: input.revision, originRecordId: input.originRecordId }, f);
  const transactionId = await newTransaction(tx, grant.companyId, ADJUSTMENT_KIND, source.employee_id, 'DRAFT', grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_adjustment (company_id, employee_id, source_timesheet_id, source_revision, origin_payroll_record_id, origin_run_id, transaction_id, adjustment_kind,
                                       previous_recognized_units, corrected_units, delta_amount, valuation_policy_id, currency_code, rule_snapshot, explanation, follows_adjustment_id,
                                       created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11::numeric, $12, $13, $14, $15, $16, $17, $17) returning id`,
      [
        grant.companyId,
        source.employee_id,
        input.timesheetId,
        input.revision,
        input.originRecordId,
        origin.run_id,
        transactionId,
        kind,
        v.previous,
        v.corrected,
        v.delta,
        v.policyId,
        origin.currency_code,
        // DB111 rule_snapshot: the frozen snapshot the origin was calculated under, by reference (the valuation policy is its own column).
        {
          originRunId: origin.run_id,
          originRunRevision: origin.run_revision,
          periodId: origin.period_id,
          periodCode: origin.period_code,
          calendarId: origin.calendar_id,
          paidDayPolicyId: origin.paid_day_policy_id,
          attendanceBasis: origin.attendance_basis,
          headCount: origin.head_count,
        },
        f.explanation,
        prior[0]?.id ?? null,
        grant.userId,
      ],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_adjustment', id, 'CREATE', null, {
    operational: { timesheetId: input.timesheetId, revision: input.revision, originRecordId: input.originRecordId, adjustmentKind: kind, state: 'DRAFT', valuationPolicyId: v.policyId },
    amount: { previousRecognizedUnits: v.previous, correctedUnits: v.corrected, deltaAmount: v.delta },
  });
  return adjustmentDetail(tx, grant, id);
}

interface Row {
  id: string;
  employee_id: string;
  transaction_id: string;
  source_timesheet_id: string;
  source_revision: number;
  origin_payroll_record_id: string;
  currency_code: string;
  explanation: string | null;
  state: string;
  created_by: string | null;
  version: number;
  minor: number;
  valuation_policy_id: string | null;
  delta_amount: string | null;
}

const ROW = `select a.id, a.employee_id, a.transaction_id, a.source_timesheet_id, a.source_revision, a.origin_payroll_record_id, a.currency_code, a.explanation, a.state, a.created_by,
  a.version, a.valuation_policy_id, a.delta_amount::text as delta_amount,
  (select ru.currency_minor_unit from payroll_run ru where ru.company_id = a.company_id and ru.id = a.origin_run_id) as minor from payroll_adjustment a`;

const sourceOfRow = (a: Row) => ({ timesheetId: a.source_timesheet_id, revision: a.source_revision, originRecordId: a.origin_payroll_record_id });

async function lockCase(tx: Queryable, grant: AccessGrant, id: string): Promise<Row> {
  const t = (await tx.query<{ transaction_id: string }>(`select transaction_id from payroll_adjustment where company_id = $1 and id = $2`, [grant.companyId, id])).rows[0];
  if (!t) throw notFound();
  await lockTransaction(tx, t.transaction_id);
  return (await tx.query<Row>(`${ROW} where a.company_id = $1 and a.id = $2 for update of a`, [grant.companyId, id])).rows[0]!;
}

function requireMaker(grant: AccessGrant, a: Row): void {
  if (a.created_by !== grant.userId) throw new HttpError(403, 'NOT_MAKER', 'Only the person who opened a case changes or submits it');
}

export async function updateAdjustment(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number } & Figures) {
  const a = await lockCase(tx, grant, id);
  await assertInScope(tx, grant, a.employee_id);
  await assertNotOwn(tx, grant, a.employee_id);
  await reassert(tx, grant, 'propose');
  requireMaker(grant, a);
  if (a.version !== input.expectedVersion) stale();
  if (a.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft case can be changed');
  const f = figureValues(input, a.minor);
  // Saving a draft values it again under the policy in effect now (one activated since it was opened values it from then on).
  const v = await valueDraft(tx, grant, sourceOfRow(a), f);
  await revalue(tx, grant, id, v, f.explanation);
  await audit(tx, actorOf(grant), 'payroll_adjustment', id, 'UPDATE', { operational: { state: 'DRAFT' } }, {
    operational: { state: 'DRAFT', valuationPolicyId: v.policyId },
    amount: { previousRecognizedUnits: v.previous, correctedUnits: v.corrected, deltaAmount: v.delta },
  });
  return adjustmentDetail(tx, grant, id);
}

async function revalue(tx: Queryable, grant: AccessGrant, id: string, v: Awaited<ReturnType<typeof valueDraft>>, explanation: string | null | undefined) {
  await tx.query(
    `update payroll_adjustment set previous_recognized_units = $3::numeric, corrected_units = $4::numeric, delta_amount = $5::numeric, valuation_policy_id = $6,
            explanation = case when $7::boolean then $8 else explanation end, updated_by = $9
      where company_id = $1 and id = $2`,
    [grant.companyId, id, v.previous, v.corrected, v.delta, v.policyId, explanation !== undefined, explanation ?? null, grant.userId],
  );
}

export async function submitAdjustment(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }) {
  const a = await lockCase(tx, grant, id);
  await assertInScope(tx, grant, a.employee_id);
  await assertNotOwn(tx, grant, a.employee_id);
  await reassert(tx, grant, 'propose');
  requireMaker(grant, a);
  if (a.version !== input.expectedVersion) stale();
  if (a.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft case can be submitted');
  // H2 "approves amount and explanation": the figures may wait for the policy; the reason for the case may not.
  if (!a.explanation) throw new HttpError(422, 'EXPLANATION_REQUIRED', 'Explain the case before submitting it', { field: 'explanation' });
  const source = (await sourceOf(tx, grant.companyId, a.source_timesheet_id, a.source_revision))!;
  requireInForce(source);
  // The reviewer sees the amount as valued under the policy in effect at submission; it is fixed from here on (0206).
  const v = await valueDraft(tx, grant, sourceOfRow(a), { previous: null, corrected: null, delta: null, explanation: null });
  await revalue(tx, grant, id, v, undefined);
  // H2: an independent payroll reviewer, neither the maker, nor the manager who approved the timesheet, nor the employee (the engine).
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: ADJUSTMENT_KIND,
    transactionId: a.transaction_id,
    ownerEmployeeId: a.employee_id,
    actorUserId: grant.userId,
    excludeUserIds: [grant.userId, ...(source.decided_by ? [source.decided_by] : [])],
  });
  await setState(tx, grant, a, 'SUBMITTED', ', submitted_at = now()');
  await audit(tx, actorOf(grant), 'payroll_adjustment', id, 'SUBMIT', { operational: { state: 'DRAFT' } }, { operational: { state: 'SUBMITTED' } });
  await emit(tx, grant.companyId, 'payroll_adjustment.assigned', id, id, { adjustmentId: id, taskId });
  return adjustmentDetail(tx, grant, id);
}

async function setState(tx: Queryable, grant: AccessGrant, a: Pick<Row, 'id' | 'transaction_id'>, state: string, extra = '', extraValues: unknown[] = []) {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, a.transaction_id, state, grant.userId]);
  await tx.query(`update payroll_adjustment set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2`, [grant.companyId, a.id, state, grant.userId, ...extraValues]);
}

export async function adjustmentTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, ADJUSTMENT_KIND)).items as { taskId: string; transactionId: string; assignedAt: Date }[];
  const items = [];
  for (const t of tasks) {
    const a = (await db.query(`${VIEW} where a.company_id = $1 and a.transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0];
    if (a) items.push({ taskId: t.taskId, assignedAt: t.assignedAt, adjustment: a });
  }
  return { items, valuation: await valuationNow(db, grant) };
}

export async function decideAdjustment(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason?: string | undefined; idempotencyKey: string }) {
  const t = await taskTransaction(tx, grant, taskId, [ADJUSTMENT_KIND]);
  await lockTransaction(tx, t.transactionId);
  const a = (await tx.query<Row>(`${ROW} where a.company_id = $1 and a.transaction_id = $2 for update of a`, [grant.companyId, t.transactionId])).rows[0];
  if (!a) throw notFound();
  await assertInScope(tx, grant, a.employee_id);
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { adjustmentId: a.id, state: a.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (a.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This case is not waiting for a decision');
  await assertNotOwn(tx, grant, a.employee_id);
  let reason: string | undefined;
  if (input.decision === 'APPROVE') {
    // H2 "An unresolved policy/rate/currency question blocks adjustment approval": the task stays open and nothing is recorded.
    const policy = await valuationPolicyOn(tx, grant.companyId, grant.businessDate);
    if (!policy) throw new HttpError(409, 'NOT_CONFIGURED', VALUATION.message, { code: VALUATION.code, needs: ['activated adjustment valuation policy (BR-048)'] });
    // BR-048 "the current applicable" policy: an amount valued under another one (or none) is returned to be valued again.
    if (a.valuation_policy_id !== policy.id) {
      throw new HttpError(409, 'REVALUATION_REQUIRED', 'This case was not valued under the valuation policy now in effect; return it so it is opened again and valued under that policy', {
        valuationPolicyId: a.valuation_policy_id,
        policyInEffect: policy.id,
      });
    }
    // BR-048 "Every source revision is uniquely linked": a revision reopened and corrected since is no longer what the timesheet says.
    requireInForce((await sourceOf(tx, grant.companyId, a.source_timesheet_id, a.source_revision))!);
    // H2 "Negative recovery requires an activated applicable recovery policy and authorization".
    if (a.delta_amount?.startsWith('-') && !policy.recovery_component_id) {
      throw new HttpError(409, 'NOT_CONFIGURED', 'A negative correction is a recovery, and the valuation policy in effect names no recovery deduction; return or reject the case', {
        code: 'RECOVERY_POLICY_NOT_CONFIGURED',
      });
    }
  } else {
    reason = requireText(input.reason, 'reason', 1000);
  }
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.decision === 'APPROVE' ? input.reason : reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'payroll_adjustment', action: 'decide' } });
  if (result.replayed) return { adjustmentId: a.id, state: a.state, replayed: true };
  const state = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'RETURNED';
  await setState(tx, grant, a, state, ', decided_at = now(), decided_by = $4');
  await audit(tx, actorOf(grant), 'payroll_adjustment', a.id, input.decision, { operational: { state: 'SUBMITTED' } }, { operational: { state } }, reason ?? input.reason ?? null);
  await emit(tx, grant.companyId, 'payroll_adjustment.decided', a.id, `${a.id}:${state}`, { adjustmentId: a.id, outcome: state });
  return { adjustmentId: a.id, state, replayed: false };
}

/** H3 TN13 "linked later-payroll adjustments": the source week, the origin period and the state; never units, amounts or notes. */
export async function ownAdjustments(db: Queryable, grant: AccessGrant, paging: Paging) {
  const employeeId = ownEmployee(grant);
  const page = await pageOf(
    db,
    `select a.id, a.source_timesheet_id as "timesheetId", a.source_revision as "revision", to_char(t.period_start, 'YYYY-MM-DD') as "serviceStart", to_char(t.period_end, 'YYYY-MM-DD') as "serviceEnd",
            p.period_code as "originPeriodCode", a.adjustment_kind as "adjustmentKind", a.state, a.submitted_at as "submittedAt"
       from payroll_adjustment a
       join timesheet t on t.company_id = a.company_id and t.id = a.source_timesheet_id
       join payroll_run ru on ru.company_id = a.company_id and ru.id = a.origin_run_id
       join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
      where a.company_id = $1 and a.employee_id = $2 and a.state <> 'DRAFT'`,
    [grant.companyId, employeeId],
    '"submittedAt" desc, id',
    paging,
    LIST_CAP,
  );
  return { ...page, notice: 'These corrections are recorded and reviewed by payroll. They never change a processed payroll: an approved correction is paid once in a later payroll, and your payslip for that month shows it.' };
}
