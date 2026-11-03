// Review openings (DF15; FR-091; BR-040; ZT25). Opening a review snapshots eligibility and opens one DRAFT case per
// eligible employee of the cycle; every other employee of the cycle is listed with a reason, and each reason carries a
// repair path ("missing eligibility evidence is excluded with reason and repair path, not treated as approval").
// A common-date review opens for a year; an anniversary review opens for a month and covers the employees whose next
// review (their service anniversary, or an approved override of it) takes effect in that month. Reruns never duplicate
// a case (one per employee and occurrence key), and after an employee's roster freeze date (the freeze date itself is
// the last day a rerun may add them) a rerun adds no case for them. A due review is not a raise: nothing here touches
// salary (BR-040/041).
// An opening loops over every employee of the company, so it never runs on a request (NFR-S09; ADR-15): the route
// checks it (checkReviewOpening) and queues a bulk job of kind INCREMENT_REVIEW_OPENING; the worker runs it in bounded
// chunks of the cycle's candidates in employee-code order (openReviewChunk), and the run record and its audit are
// written once, with the last chunk (recordReviewOpening). The job's result holds counts only (created, excluded and
// excluded per reason) and the fixed values of the opening; each chunk writes its employees' outcomes as rows of the
// job (0057): a created case names the job (increment_case.opened_by_job_id) and an exclusion is an
// increment_review_exclusion row with its reason code, once per job, employee and occurrence. The run record names
// the job, and openingCases / openingExclusions read the rows a page at a time, with each reason's repair path.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { isModuleActive } from '../registry.js';
import { type CycleRow, loadCycle, lockCycleCode, requireCompanyScope } from './cycles.js';

/** Why an employee of the cycle has no new case, and what repairs it. */
export const EXCLUSION_REPAIR: Readonly<Record<string, string>> = {
  ALREADY_IN_REVIEW: 'The employee already has a case for this occurrence; continue it in the increment review.',
  REVIEW_RESCHEDULED: 'An approved review-date override moved this review; it opens with the period of the new date.',
  ON_NOTICE: "Excluded by the cycle's notice-period rule; a separately authorised off-cycle case is the route for any change.",
  SEPARATION_BEFORE_EFFECTIVE_DATE: 'The approved last working date is before the effective date.',
  NOT_CONFIRMED: "Record the employee's confirmation, then rerun the review before the roster freezes.",
  JOINED_AFTER_CUTOFF: 'The employee joined after the cutoff; an approved review-date override can schedule the review later.',
  JOINED_AFTER_EFFECTIVE_DATE: 'The employment starts after the effective date; correct the joining or service date if it is wrong.',
  SERVICE_INTERVAL_NOT_COMPLETED: 'The cycle interval of service is not complete by the effective date; correct the service date if it is wrong.',
  APPRAISAL_NOT_COMPLETED:
    "The cycle requires the employee's appraisal in its required appraisal cycle to be approved; complete and approve it, then rerun the review before the roster freezes.",
  NO_SALARY_BASELINE: 'Record the salary arrangement in force before the effective date, then rerun the review before the roster freezes.',
  ROSTER_FROZEN: 'The roster froze before the employee became eligible; a separately authorised off-cycle case is the route for any change.',
};

type Basis = 'MONTHLY_GROSS' | 'ANNUAL_CTC';
const basisColumn = (b: Basis) => (b === 'MONTHLY_GROSS' ? 'monthly_gross' : 'annual_ctc');

interface Candidate {
  employee_id: string;
  employee_code: string;
  status: string;
  occurrence_key: string;
  scheduled_date: string;
  effective_date: string;
  scheduled_in_period: boolean;
  in_period: boolean;
  plan_id: string | null;
  member: boolean;
  has_case: boolean;
  /** This job already decided the employee (a chunk run again after its effects committed): its case or exclusion reason. */
  own_case: boolean;
  own_exclusion: string | null;
  cutoff_ok: boolean;
  joined_by_effective_date: boolean;
  appraisal_ok: boolean;
  salary_id: string | null;
  amount: string | null;
  currency: string | null;
  separated_before: boolean;
  review_opens_on: string;
  roster_freezes_on: string;
  decision_due_on: string;
  gap_from: string;
  gap_to: string | null;
}

interface CommonSchedule {
  scheduled: string;
  cutoff: string;
  open_lead: number;
  freeze_lead: number;
  due_lead: number;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The common-date occurrence of a year and its review window as days before the effective date. */
async function commonSchedule(tx: Queryable, cycle: CycleRow, year: number): Promise<CommonSchedule> {
  return (
    await tx.query<CommonSchedule>(
      `select to_char(s, 'YYYY-MM-DD') as scheduled, to_char(hrms_increment_before(s, $4, $5), 'YYYY-MM-DD') as cutoff,
              s - hrms_increment_on_or_before(s, $6, $7) as open_lead, s - hrms_increment_on_or_before(s, $8, $9) as freeze_lead,
              s - hrms_increment_on_or_before(s, $10, $11) as due_lead
         from (select hrms_increment_date($1, $2, $3) as s) q`,
      [
        year,
        cycle.recurrence_anchor_month,
        cycle.recurrence_anchor_day,
        cycle.cutoff_month,
        cycle.cutoff_day,
        cycle.review_open_month,
        cycle.review_open_day,
        cycle.roster_freeze_month,
        cycle.roster_freeze_day,
        cycle.decision_due_month,
        cycle.decision_due_day,
      ],
    )
  ).rows[0]!;
}

/** One chunk of candidates of a job: up to `limit` rows after `after` (employee code, occurrence key) in that order. */
interface CandidatePage {
  jobId: string;
  after: [string, string] | null;
  limit: number;
}

/**
 * Every employee in an active status who could have an occurrence in the opened period, with the facts eligibility
 * needs, evaluated at the employee's effective date for the occurrence: the plan in force on the scheduled date (the
 * employee's cycle), the plan's approved override (the effective date), the cutoff or service interval, the salary
 * baseline in force before the effective date and any approved separation before it. Read a page at a time in
 * (employee code, occurrence key) order, which is unique per company.
 */
function candidateSql(
  cycle: CycleRow,
  head: (p: SqlParams, company: string, code: string) => string,
  period: { first: string; last: string } | null,
  leads: [number, number, number],
  page: CandidatePage,
  p: SqlParams,
  companyId: string,
): string {
  const company = `${p.add(companyId)}::uuid`;
  const code = `${p.add(cycle.code)}::text`;
  const rule = `${p.add(cycle.assignment_rule)}::text`;
  const inPeriod = (col: string) => (period ? `${col} between ${p.add(period.first)}::date and ${p.add(period.last)}::date` : 'true');
  const cutoff =
    cycle.recurrence_basis === 'COMMON_DATE'
      ? `e.joining_date <= hrms_increment_before(x.eff, ${p.add(cycle.cutoff_month)}::int, ${p.add(cycle.cutoff_day)}::int)`
      : `(b.base + make_interval(years => ${p.add(cycle.recurrence_interval)}::int))::date <= x.eff`;
  const [openLead, freezeLead, dueLead] = leads.map((l) => `${p.add(l)}::int`);
  const job = `${p.add(page.jobId)}::uuid`;
  // DF15 "completed required appraisal where that module is enabled": an APPROVED appraisal of the employee in the
  // appraisal cycle the revision names (company configuration, no default).
  const appraisal =
    cycle.required_appraisal_cycle_id && isModuleActive('appraisal')
      ? `exists (select 1 from appraisal a where a.company_id = e.company_id and a.employee_id = e.id
                    and a.cycle_id = ${p.add(cycle.required_appraisal_cycle_id)}::uuid and a.state = 'APPROVED')`
      : 'true';
  return `
    with cand as (${head(p, company, code)})
    select c.employee_id, e.employee_code, st.code as status, c.occ as occurrence_key, to_char(c.s, 'YYYY-MM-DD') as scheduled_date,
           to_char(x.eff, 'YYYY-MM-DD') as effective_date, ${inPeriod('c.s')} as scheduled_in_period, ${inPeriod('x.eff')} as in_period,
           p.id as plan_id,
           (case when p.id is null then ${rule} = 'COMPANY_DEFAULT' else pc.code = ${code} end) as member,
           exists (select 1 from increment_case k where k.company_id = e.company_id and k.employee_id = e.id and k.cycle_occurrence_key = c.occ) as has_case,
           exists (select 1 from increment_case k where k.company_id = e.company_id and k.employee_id = e.id and k.cycle_occurrence_key = c.occ
                      and k.opened_by_job_id = ${job}) as own_case,
           (select x.reason_code from increment_review_exclusion x
             where x.company_id = e.company_id and x.bulk_job_id = ${job} and x.employee_id = e.id and x.occurrence_key = c.occ) as own_exclusion,
           ${cutoff} as cutoff_ok,
           e.joining_date <= x.eff as joined_by_effective_date,
           ${appraisal} as appraisal_ok,
           sa.id as salary_id, sa.${basisColumn(cycle.compensation_basis)}::text as amount, sa.currency_code as currency,
           coalesce(hrms_exit_last_working_date(e.company_id, e.id) < x.eff, false) as separated_before,
           to_char(x.eff - ${openLead}, 'YYYY-MM-DD') as review_opens_on,
           to_char(x.eff - ${freezeLead}, 'YYYY-MM-DD') as roster_freezes_on,
           to_char(x.eff - ${dueLead}, 'YYYY-MM-DD') as decision_due_on,
           to_char(greatest(e.joining_date, (select max(q.effective_to) from employee_increment_plan q
                                              where q.company_id = e.company_id and q.employee_id = e.id and q.superseded_at is null and q.effective_to <= c.s)),
                   'YYYY-MM-DD') as gap_from,
           to_char((select min(q.effective_from) from employee_increment_plan q
                     where q.company_id = e.company_id and q.employee_id = e.id and q.superseded_at is null and q.effective_from > c.s), 'YYYY-MM-DD') as gap_to
      from cand c
      join employee e on e.company_id = ${company} and e.id = c.employee_id
      join reference_value st on st.company_id = e.company_id and st.id = e.status_id
      cross join lateral (select coalesce(e.service_anniversary_date, e.joining_date) as base) b
      left join employee_increment_plan p on p.company_id = e.company_id and p.employee_id = e.id and p.superseded_at is null
           and p.effective_from <= c.s and (p.effective_to is null or p.effective_to > c.s)
      left join increment_cycle pc on pc.company_id = p.company_id and pc.id = p.cycle_id
      cross join lateral (select case when p.override_occurrence_key = c.occ then p.override_review_date else c.s end as eff) x
      left join salary_arrangement sa on sa.company_id = e.company_id and sa.employee_id = e.id
           and sa.effective_from < x.eff and (sa.effective_to is null or sa.effective_to >= x.eff)
     where st.code in ('ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE')
       and c.s >= ${p.add(cycle.effective_from)}::date ${cycle.effective_to ? `and c.s < ${p.add(cycle.effective_to)}::date` : ''}
       ${page.after ? `and (e.employee_code, c.occ) > (${p.add(page.after[0])}::text, ${p.add(page.after[1])}::text)` : ''}
     order by e.employee_code, c.occ
     limit ${p.add(page.limit)}::int`;
}

export interface ReviewInput {
  year: number;
  month?: number | undefined;
}

/** The bulk-job parameters of an opening (modules/bulk/kinds.ts), and the opening they stand for. */
export const reviewJobParameters = (cycleId: string, input: ReviewInput): Record<string, unknown> => ({
  cycleId,
  year: input.year,
  ...(input.month === undefined ? {} : { month: input.month }),
});
export const reviewOfJob = (p: Record<string, unknown>): { cycleId: string; input: ReviewInput } => ({
  cycleId: p.cycleId as string,
  input: { year: p.year as number, month: p.month as number | undefined },
});

/**
 * The result of an opening, built chunk by chunk: the fixed values of the opening and its counts, never a list (the
 * cases and exclusions are rows of the job; openingCases, openingExclusions). The first chunk fixes the business date
 * the roster-freeze rule is applied on (`asOf`) and whether the period was opened before this one (`rerun`: an opening
 * completed, or one ended FAILED after creating cases), so every chunk of the job applies the same rules; the last
 * chunk takes the run number (completed openings only).
 */
export interface ReviewTotals {
  cycleId: string;
  cycleCode: string | null;
  period: string;
  // Common-date openings: the occurrence and its review window.
  occurrence?: string;
  effectiveDate?: string;
  cutoffDate?: string;
  reviewOpensOn?: string;
  rosterFreezesOn?: string;
  decisionsDueOn?: string;
  asOf: string | null;
  rerun: boolean | null;
  run: number | null;
  /** Draft cases this job opened. */
  created: number;
  /** Employees of the cycle this job listed with a reason instead of a case. */
  excluded: number;
  /** `excluded` by reason code (at most the EXCLUSION_REPAIR codes). */
  excludedByReason: Record<string, number>;
}

/** 'YYYY' for a common-date occurrence, 'YYYY-MM' for an anniversary month (checkReviewOpening enforces which). */
const periodOf = (input: ReviewInput) => (input.month === undefined ? String(input.year) : `${input.year}-${pad(input.month)}`);

export const emptyReviewTotals = (cycleId: string, input: ReviewInput): ReviewTotals => ({
  cycleId,
  cycleCode: null,
  period: periodOf(input),
  asOf: null,
  rerun: null,
  run: null,
  created: 0,
  excluded: 0,
  excludedByReason: {},
});

/** A count carried over from the stored result; a job queued before 0057 carried the lists themselves (their length). */
const countOf = (v: unknown): number => (Array.isArray(v) ? v.length : typeof v === 'number' ? v : 0);

/** A checked opening: the activated revision and the common-date schedule or the anniversary month. */
interface ReviewPlan {
  cycle: CycleRow;
  common: boolean;
  schedule: CommonSchedule | null;
  month: { first: string; last: string } | null;
}

/**
 * Checks an opening of an activated cycle revision for a year (common date) or a month (service anniversary) under a
 * company-scope grant. With `lock` it takes the code lock first and reads the revision again, so the chunks of
 * concurrent openings of a code run one after another and each sees the cases the others opened.
 */
async function planReview(tx: Queryable, grant: AccessGrant, cycleId: string, input: ReviewInput, lock: boolean): Promise<ReviewPlan> {
  requireCompanyScope(grant);
  const found = await loadCycle(tx, grant.companyId, cycleId);
  if (!found || !found.active) throw new HttpError(422, 'CYCLE_NOT_CONFIGURED', 'No activated cycle revision with this id');
  if (lock) await lockCycleCode(tx, grant.companyId, found.code);
  const cycle = lock ? (await loadCycle(tx, grant.companyId, cycleId))! : found;
  const common = cycle.recurrence_basis === 'COMMON_DATE';
  if (common && input.month !== undefined) throw new HttpError(422, 'RULE_VIOLATION', 'A common-date review opens for a year; a month applies to anniversary cycles');
  if (!common && input.month === undefined) throw new HttpError(422, 'RULE_VIOLATION', 'An anniversary review opens for a month: give the year and the month');

  if (common) {
    const schedule = await commonSchedule(tx, cycle, input.year);
    if (schedule.scheduled < cycle.effective_from || (cycle.effective_to !== null && schedule.scheduled >= cycle.effective_to)) {
      throw new HttpError(422, 'CYCLE_NOT_EFFECTIVE', `This revision does not govern the review effective ${schedule.scheduled}; open it on the revision in force then`);
    }
    return { cycle, common, schedule, month: null };
  }
  const month = input.month!;
  const first = `${input.year}-${pad(month)}-01`;
  const last = (await tx.query<{ d: string }>(`select to_char(($1::date + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD') as d`, [first])).rows[0]!.d;
  if (last < cycle.effective_from || (cycle.effective_to !== null && first >= cycle.effective_to)) {
    throw new HttpError(422, 'CYCLE_NOT_EFFECTIVE', `This revision is not in force in ${input.year}-${pad(month)}; open it on the revision in force then`);
  }
  return { cycle, common, schedule: null, month: { first, last } };
}

/** The route's check before it queues an opening: a bad request gets the answer the synchronous opening gave. */
export async function checkReviewOpening(db: Queryable, grant: AccessGrant, cycleId: string, input: ReviewInput): Promise<void> {
  await planReview(db, grant, cycleId, input, false);
}

/** The candidate query of one page of an opening. */
function candidateQuery(plan: ReviewPlan, input: ReviewInput, companyId: string, page: CandidatePage): { sql: string; values: unknown[] } {
  const { cycle, schedule, month: bounds } = plan;
  const p = new SqlParams();
  let sql: string;
  if (schedule) {
    const occurrence = `${cycle.code}:${input.year}`;
    const s = schedule.scheduled;
    sql = candidateSql(
      cycle,
      (q, company) => `select e.id as employee_id, ${q.add(occurrence)}::text as occ, ${q.add(s)}::date as s from employee e where e.company_id = ${company}`,
      null,
      [schedule.open_lead, schedule.freeze_lead, schedule.due_lead],
      page,
      p,
      companyId,
    );
  } else {
    const { first, last } = bounds!;
    sql = candidateSql(
      cycle,
      (q, company, code) => {
        const y = `${q.add(input.year)}::int`;
        const m = `${q.add(input.month!)}::int`;
        const n = `${q.add(cycle.recurrence_interval)}::int`;
        // (a) the scheduled anniversary in the month, in the years that complete whole intervals of service, and in the
        //     years before the first interval completes (listed as not yet due); (b) occurrences that an approved
        //     override moved into the month.
        return `
          select e.id as employee_id, ${code} || ':' || ${y} as occ,
                 hrms_increment_date(${y}, extract(month from b.base)::int, extract(day from b.base)::int) as s
            from employee e cross join lateral (select coalesce(e.service_anniversary_date, e.joining_date) as base) b
           where e.company_id = ${company} and extract(month from b.base) = ${m}
             and ${y} >= extract(year from b.base)::int
             and (${y} - extract(year from b.base)::int < ${n} or (${y} - extract(year from b.base)::int) % ${n} = 0)
          union
          select o.employee_id, o.override_occurrence_key,
                 hrms_increment_date(split_part(o.override_occurrence_key, ':', 2)::int, extract(month from b.base)::int, extract(day from b.base)::int)
            from employee_increment_plan o
            join increment_cycle oc on oc.company_id = o.company_id and oc.id = o.cycle_id and oc.code = ${code}
            join employee e on e.company_id = o.company_id and e.id = o.employee_id
            cross join lateral (select coalesce(e.service_anniversary_date, e.joining_date) as base) b
           where o.company_id = ${company} and o.superseded_at is null and split_part(o.override_occurrence_key, ':', 1) = ${code}
             and o.override_review_date between ${q.add(first)}::date and ${q.add(last)}::date`;
      },
      { first, last },
      [cycle.review_open_offset_days!, cycle.roster_freeze_offset_days!, cycle.decision_due_offset_days!],
      page,
      p,
      companyId,
    );
  }
  return { sql, values: p.values };
}

/** Openings of the cycle code's period that have completed (each wrote its run record). */
async function completedRuns(tx: Queryable, companyId: string, code: string, period: string): Promise<number> {
  return (
    await tx.query<{ n: number }>(`select count(*)::int as n from increment_review_run where company_id = $1 and cycle_code = $2 and period_key = $3`, [
      companyId,
      code,
      period,
    ])
  ).rows[0]!.n;
}

/**
 * Whether the cycle code's period was opened before: an opening completed (its run record), or an opening job ended
 * FAILED after its committed chunks had created cases. A failed job writes no run record, but the cases its chunks
 * created stand, so the next opening of the period is a rerun and the roster-freeze rule applies to it.
 */
async function openedBefore(tx: Queryable, companyId: string, code: string, period: string): Promise<boolean> {
  return (
    await tx.query<{ opened: boolean }>(
      `select exists (select 1 from increment_review_run r where r.company_id = $1 and r.cycle_code = $2 and r.period_key = $3)
           or exists (select 1 from bulk_job j
                       where j.company_id = $1 and j.kind = 'INCREMENT_REVIEW_OPENING' and j.state = 'FAILED'
                         and j.result ->> 'cycleCode' = $2 and j.result ->> 'period' = $3
                         and exists (select 1 from increment_case k where k.company_id = j.company_id and k.opened_by_job_id = j.id)) as opened`,
      [companyId, code, period],
    )
  ).rows[0]!.opened;
}

/** The common-date occurrence and its review window, as the opening reports them. */
const scheduleView = (cycle: CycleRow, input: ReviewInput, s: CommonSchedule) => ({
  occurrence: `${cycle.code}:${input.year}`,
  effectiveDate: s.scheduled,
  cutoffDate: s.cutoff,
  reviewOpensOn: shift(s.scheduled, -s.open_lead),
  rosterFreezesOn: shift(s.scheduled, -s.freeze_lead),
  decisionsDueOn: shift(s.scheduled, -s.due_lead),
});

/**
 * One bounded chunk of opening job `jobId` (NFR-S09: the bulk-job worker runs it, never a request; modules/bulk).
 * Checks the opening again under the code lock (the revision must still be activated and govern the period), then
 * evaluates the next `size` candidates in (employee code, occurrence key) order after `after`: each eligible employee
 * gets a draft case that names the job, each excluded employee one exclusion row of the job, and `totals` counts both.
 * Idempotent per job, employee and occurrence: a chunk rolled back is undone with its rows, and a chunk run again
 * after its effects committed finds the case or exclusion this job already wrote, counts it again (the totals it
 * starts from are those before the chunk) and writes nothing twice. Another opening's case is ALREADY_IN_REVIEW.
 */
export async function openReviewChunk(
  tx: Queryable,
  grant: AccessGrant,
  jobId: string,
  cycleId: string,
  input: ReviewInput,
  totals: ReviewTotals,
  after: string | null,
  size: number,
) {
  const plan = await planReview(tx, grant, cycleId, input, true);
  const { cycle, common, schedule } = plan;
  const period = periodOf(input);
  // Fixed by the first chunk for the whole job. Openings of a period that run at the same time each count only the
  // openings that ended before their first chunk (completed, or FAILED after creating cases); their chunks still run
  // one at a time under the code lock.
  const asOf = totals.asOf ?? grant.businessDate;
  const rerun = totals.rerun ?? (await openedBefore(tx, grant.companyId, cycle.code, period));
  const next: ReviewTotals = {
    cycleId: totals.cycleId,
    cycleCode: cycle.code,
    period: totals.period,
    ...(schedule ? scheduleView(cycle, input, schedule) : {}),
    asOf,
    rerun,
    run: null,
    created: countOf(totals.created),
    excluded: countOf(totals.excluded),
    excludedByReason: { ...totals.excludedByReason },
  };
  const exclusions: { employeeId: string; occurrence: string; reason: string }[] = [];
  const count = (reason: string) => {
    next.excluded++;
    next.excludedByReason[reason] = (next.excludedByReason[reason] ?? 0) + 1;
  };
  const exclude = (c: Candidate, reason: string) => {
    exclusions.push({ employeeId: c.employee_id, occurrence: c.occurrence_key, reason });
    count(reason);
  };
  const { sql, values } = candidateQuery(plan, input, grant.companyId, { jobId, after: after === null ? null : (JSON.parse(after) as [string, string]), limit: size + 1 });
  const rows = (await tx.query<Candidate>(sql, values)).rows;
  const candidates = rows.slice(0, size);

  for (const c of candidates) {
    // Already decided by this job: counted as it was decided, nothing written again.
    if (c.own_case) {
      next.created++;
      continue;
    }
    if (c.own_exclusion) {
      count(c.own_exclusion);
      continue;
    }
    if (!c.member) continue; // another cycle's employee
    if (!c.in_period) {
      // The scheduled review was moved out of the period by an approved override (anniversary cycles).
      if (c.scheduled_in_period) exclude(c, 'REVIEW_RESCHEDULED');
      continue;
    }
    const reason =
      c.has_case ? 'ALREADY_IN_REVIEW'
      : c.status === 'NOTICE' && cycle.exclude_notice ? 'ON_NOTICE'
      : c.separated_before ? 'SEPARATION_BEFORE_EFFECTIVE_DATE'
      : c.status !== 'ACTIVE_CONFIRMED' && c.status !== 'NOTICE' ? 'NOT_CONFIRMED'
      : common && !c.cutoff_ok ? 'JOINED_AFTER_CUTOFF'
      : !c.joined_by_effective_date ? 'JOINED_AFTER_EFFECTIVE_DATE'
      : !c.cutoff_ok ? 'SERVICE_INTERVAL_NOT_COMPLETED'
      : !c.appraisal_ok ? 'APPRAISAL_NOT_COMPLETED'
      : !c.salary_id ? 'NO_SALARY_BASELINE'
      : rerun && asOf > c.roster_freezes_on ? 'ROSTER_FROZEN'
      : null;
    if (reason) {
      exclude(c, reason);
      continue;
    }
    // FR-091 company rule: an employee without a plan joins the company-default cycle with a plan covering the gap.
    const planId =
      c.plan_id ??
      (
        await tx.query<{ id: string }>(
          `insert into employee_increment_plan (company_id, employee_id, cycle_id, effective_from, effective_to, next_review_date, active, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $8) returning id`,
          [grant.companyId, c.employee_id, cycle.id, c.gap_from, c.gap_to, c.scheduled_date, c.gap_to === null, grant.userId],
        )
      ).rows[0]!.id;
    const transactionId = (
      await tx.query<{ id: string }>(
        `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by)
         values ($1, 'increment_case', $2, 'DRAFT', $3, $3) returning id`,
        [grant.companyId, c.employee_id, grant.userId],
      )
    ).rows[0]!.id;
    await tx.query(
      `insert into increment_case (company_id, employee_id, plan_id, cycle_id, transaction_id, cycle_occurrence_key, off_cycle, prepared_by,
                                   baseline_salary_id, compensation_basis, currency_code, baseline_amount, proposed_effective_date, state, reason,
                                   review_opens_on, roster_freezes_on, decision_due_on, opened_by_job_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, false, $7, $8, $9, $10, $11::numeric, $12, 'DRAFT', $13, $14, $15, $16, $17, $7, $7)`,
      [
        grant.companyId,
        c.employee_id,
        planId,
        cycle.id,
        transactionId,
        c.occurrence_key,
        grant.userId,
        c.salary_id,
        cycle.compensation_basis,
        c.currency,
        c.amount,
        c.effective_date,
        `Cycle review ${c.occurrence_key}`,
        c.review_opens_on,
        c.roster_freezes_on,
        c.decision_due_on,
        jobId,
      ],
    );
    next.created++;
  }

  if (exclusions.length > 0) {
    // One statement per chunk; the key (job, employee, occurrence) makes a second write of a row a no-op.
    await tx.query(
      `insert into increment_review_exclusion (company_id, bulk_job_id, cycle_id, employee_id, occurrence_key, reason_code, created_by, updated_by)
       select $1, $2, $3, u.employee_id, u.occurrence_key, u.reason_code, $4, $4
         from unnest($5::uuid[], $6::text[], $7::text[]) as u (employee_id, occurrence_key, reason_code)
       on conflict (company_id, bulk_job_id, employee_id, occurrence_key) do nothing`,
      [
        grant.companyId,
        jobId,
        cycle.id,
        grant.userId,
        exclusions.map((x) => x.employeeId),
        exclusions.map((x) => x.occurrence),
        exclusions.map((x) => x.reason),
      ],
    );
  }
  const done = rows.length <= size;
  // The last chunk takes the run number under the code lock; recordReviewOpening writes it in the same transaction.
  if (done) next.run = (await completedRuns(tx, grant.companyId, cycle.code, period)) + 1;
  const last = candidates.at(-1);
  return { totals: next, processed: candidates.length, cursor: last ? JSON.stringify([last.employee_code, last.occurrence_key]) : after, done };
}

/**
 * The run record and audit of a finished opening, written once, with its last chunk (still under the code lock). The
 * run names the job, which links the cases and exclusions the job's chunks wrote to the run.
 */
export async function recordReviewOpening(tx: Queryable, grant: AccessGrant, jobId: string, totals: ReviewTotals): Promise<void> {
  const { cycleId, cycleCode, period, occurrence, run, created, excluded } = totals;
  await tx.query(
    `insert into increment_review_run (company_id, cycle_id, cycle_code, period_key, run_number, created_count, excluded_count, bulk_job_id, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [grant.companyId, cycleId, cycleCode, period, run, created, excluded, jobId, grant.userId],
  );
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'increment_cycle',
    recordKey: cycleId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'OPEN_REVIEW',
    after: { operational: { period, ...(occurrence ? { occurrence } : {}), run, created, excluded } },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The rows of an opening, a page at a time: the cases it created and the employees it excluded. Company records read
// with the opening's own authority (the cycle duty in an unrestricted company-scope assignment) and operational fields
// only: employee id, code and name, the occurrence, dates, the case state and the reason with its repair path; never a
// salary figure. Rows of a job still running (or ended FAILED) are those its committed chunks wrote.
// ---------------------------------------------------------------------------------------------------------------

/** Rows per page: the default and the most one page returns (technical bounds, not business rules). */
export const OPENING_PAGE_DEFAULT = 50;
export const OPENING_PAGE_MAX = 200;

export interface OpeningPageQuery {
  /** `nextAfter` of the previous page (an employee code and occurrence key, the opening's own order). */
  after?: string | undefined;
  limit?: number | undefined;
}

/** The opening job of this company, its state and the run it recorded (when it completed). Others: not found. */
async function openingJob(db: Queryable, grant: AccessGrant, jobId: string) {
  requireCompanyScope(grant);
  const job = (
    await db.query<{ state: string; run: number | null }>(
      `select j.state, r.run_number as run
         from bulk_job j left join increment_review_run r on r.company_id = j.company_id and r.bulk_job_id = j.id
        where j.company_id = $1 and j.id = $2 and j.kind = 'INCREMENT_REVIEW_OPENING'`,
      [grant.companyId, jobId],
    )
  ).rows[0];
  if (!job) throw notFound();
  return job;
}

function keyAfter(after: string | undefined): [string, string] | null {
  if (after === undefined) return null;
  try {
    const key: unknown = JSON.parse(after);
    if (Array.isArray(key) && key.length === 2 && key.every((k) => typeof k === 'string')) return key as [string, string];
  } catch {
    // not a position this list returned
  }
  throw new HttpError(400, 'INVALID_REQUEST', 'after must be the nextAfter value of a previous page');
}

/** Reads one page (limit + 1 rows tell whether another page follows). */
async function openingPage<T extends { employeeCode: string; occurrence: string }>(
  db: Queryable,
  grant: AccessGrant,
  jobId: string,
  q: OpeningPageQuery,
  sql: string,
): Promise<{ jobId: string; state: string; run: number | null; items: T[]; nextAfter: string | null }> {
  const job = await openingJob(db, grant, jobId);
  const after = keyAfter(q.after);
  const limit = Math.min(Math.max(q.limit ?? OPENING_PAGE_DEFAULT, 1), OPENING_PAGE_MAX);
  const rows = (await db.query<T>(sql, [grant.companyId, jobId, after?.[0] ?? null, after?.[1] ?? null, limit + 1])).rows;
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { jobId, state: job.state, run: job.run, items, nextAfter: rows.length > limit && last ? JSON.stringify([last.employeeCode, last.occurrence]) : null };
}

/** The draft cases an opening created, in employee-code order. */
export function openingCases(db: Queryable, grant: AccessGrant, jobId: string, q: OpeningPageQuery) {
  return openingPage<{ caseId: string; employeeId: string; employeeCode: string; employeeName: string; occurrence: string; effectiveDate: string; decisionDueOn: string; state: string }>(
    db,
    grant,
    jobId,
    q,
    `select k.id as "caseId", k.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
            k.cycle_occurrence_key as occurrence, to_char(k.proposed_effective_date, 'YYYY-MM-DD') as "effectiveDate",
            to_char(k.decision_due_on, 'YYYY-MM-DD') as "decisionDueOn", k.state
       from increment_case k join employee e on e.company_id = k.company_id and e.id = k.employee_id
      where k.company_id = $1 and k.opened_by_job_id = $2
        and ($3::text is null or (e.employee_code, k.cycle_occurrence_key) > ($3::text, $4::text))
      order by e.employee_code, k.cycle_occurrence_key
      limit $5::int`,
  );
}

/** The employees an opening excluded, in employee-code order, each with the reason and what repairs it. */
export async function openingExclusions(db: Queryable, grant: AccessGrant, jobId: string, q: OpeningPageQuery) {
  const page = await openingPage<{ employeeId: string; employeeCode: string; employeeName: string; occurrence: string; reason: string }>(
    db,
    grant,
    jobId,
    q,
    `select x.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
            x.occurrence_key as occurrence, x.reason_code as reason
       from increment_review_exclusion x join employee e on e.company_id = x.company_id and e.id = x.employee_id
      where x.company_id = $1 and x.bulk_job_id = $2
        and ($3::text is null or (e.employee_code, x.occurrence_key) > ($3::text, $4::text))
      order by e.employee_code, x.occurrence_key
      limit $5::int`,
  );
  return { ...page, items: page.items.map((x) => ({ ...x, repairPath: EXCLUSION_REPAIR[x.reason] ?? null })) };
}

/** Calendar arithmetic on a 'YYYY-MM-DD' date (UTC, no time zone shift). */
function shift(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
