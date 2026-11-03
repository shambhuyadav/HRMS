// Payroll runs (FR-030, FR-033, FR-037 as overridden by FR-099 and H2; BR-012; BR-047; CI25; ZT36; DF02; DF03; C4; CP-08).
//
// Scope (FR-030). A preview resolves the members from the period and the department/grade/location filters (the
// assignment in effect on each employee's last eligible day) within the preparer's row scope, counts who is not
// included and why, and returns a scope token (a hash of the period, the filters and every member). Creating the run
// requires that token: the members are written and hashed again in the creating transaction, and if anything changed
// the creation is refused, so a run never includes an employee outside the scope the preparer confirmed. Members
// belong to the run's lineage: later revisions keep them, and they can only be excluded (from a revision onward),
// never added. An employee is a live member of at most one run per service month (database index), so a payment
// cannot be calculated twice.
//
// Lifecycle (H2). DRAFT -> CALCULATED (one calculation per revision) -> IN_REVIEW (the preparer submits; an
// independent reviewer from the run reviewers' list) -> approval stage (its own transaction, an independent approver
// from the approvers' list) -> APPROVED -> PROCESSED_LOCKED. A return from validation (preparer), review, approval, a
// covering approval or the processor's pre-processing validation closes the revision as RETURNED and opens the next
// revision as a draft with the same confirmed members (optionally fewer). CANCELLED needs the cancel authority and a
// reason and is possible only before processing starts.
//
// Independence (C4; H2 "users never approve their own results"). The creator and the preparer never review, approve
// or process (BRD role table: no release of own prepared payroll); the reviewer never approves; nobody decides an
// exception of their own record. A reviewer or approver
// whose own payroll record is in the run cannot let their decision stand for it: when the approval stage approves,
// each such record gets a covering approval (a separate transaction owned by that employee) decided by a further
// approver who is none of the creator, preparer, reviewer and approver, and the run is APPROVED only when every
// cover is approved.
//
// Calculation and processing (CP-08). Both run in bounded chunks of employees, each chunk its own transaction under
// the run's transaction lock, recorded in payroll_run_chunk; a request does a bounded share (REQUEST_BUDGET_MS) and
// reports progress, and calling again continues where it stopped. A calculation is continued only by the preparer
// who started it (the preparer is excluded from the run's decisions; a stalled draft can still be cancelled); a
// started processing, which can no longer be returned or cancelled, is continued by any eligible processor. Every
// transaction re-resolves its permission after the run's locks (docs/09 §6.5). The revision's rules are fixed when
// the calculation starts; it becomes CALCULATED only when every member has its record. Reviewers of a run stage are
// routed only to listed users whose assignment covers every member (I-25: the run has no owner employee for the
// engine to check). Processing (FR-099, BR-047, CI25) first re-checks the approval, unresolved exceptions and that the approved
// inputs and salary stops still equal the snapshot, then marks the start (from then on the revision can only be
// completed); each chunk freezes its records with the employee's bank reference, consumes their inputs, applies their
// stops, places their automatic holds and writes its audit entry, atomically; the final step locks the run
// (PROCESSED_LOCKED, lock_version) with the processing audit only once every record is frozen. A failed chunk rolls
// back whole and a retry resumes, so there is never a partially locked run, and nothing unlocks it afterwards.
import { randomUUID } from 'node:crypto';
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { cancelActiveApproval, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import { bankChecks } from './bank.js';
import { CHUNK, calculateChunk, loanRecoveryBreaches, type PolicySnapshot, type RunContext, startCalculation, verifyMembers } from './calculate.js';
import {
  type Actor,
  actorOf,
  advisoryLock,
  assertInScope,
  assertNotSelf,
  audit,
  decisionTrail,
  emit,
  holds,
  INCLUDED,
  lockServiceMonth,
  newTransaction,
  priorDecision,
  requireRunScope,
  requireText,
  reviewersLackingScope,
  runMembersOutsideScope,
  setRootState,
  taskIsPending,
  taskTransaction,
  userIsEmployee,
} from './common.js';
import { activePeriod } from './config.js';
import { createAutomaticHolds } from './holds.js';

export const RUN_KIND = 'payroll_run';
export const APPROVAL_KIND = 'payroll_run_approval';
export const COVER_KIND = 'payroll_record_cover';
const LIVE_STATES = ['DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED'];
/** One request's share of a chunked operation (CP-08; an engineering bound, not a business rule). */
export const REQUEST_BUDGET_MS = 20_000;
/** Members released per transaction when a cancelled run lets them go (engineering bound). */
const RELEASE_CHUNK = 5000;
/** Preview and list samples (engineering bounds of one response). */
const SAMPLE = 200;
const MAX_PAGE = 1000;

export interface BatchOptions {
  chunkSize?: number | undefined;
  budgetMs?: number | undefined;
  /** At most this many chunks in this call (tests and operators exercising resumption). */
  maxChunks?: number | undefined;
}

interface RunRow {
  id: string;
  lineage_id: string;
  revision: number;
  supersedes_run_id: string | null;
  transaction_id: string;
  state: string;
  calendar_id: string;
  period_id: string;
  service_start: string;
  service_end: string;
  input_cutoff: string;
  payment_date: string;
  days_in_month: number;
  currency_code: string;
  currency_minor_unit: number;
  member_count: number;
  scope_department_ids: string[];
  scope_grade_ids: string[];
  scope_location_ids: string[];
  scope_token: string;
  created_by: string | null;
  calculation_started_at: Date | null;
  calendar_as_of: Date | null;
  calculated_by: string | null;
  paid_day_policy_id: string | null;
  attendance_basis: PolicySnapshot['basis'] | null;
  absent_unpaid_units: string | null;
  half_day_unpaid_units: string | null;
  calculated_at: Date | null;
  reviewed_by: string | null;
  approved_by: string | null;
  processing_started_at: Date | null;
  processed_by: string | null;
  version: number;
}

const RUN_COLUMNS = `r.id, r.lineage_id, r.revision, r.supersedes_run_id, r.transaction_id, r.state, r.calendar_id, r.period_id,
  to_char(r.service_start, 'YYYY-MM-DD') as service_start, to_char(r.service_end, 'YYYY-MM-DD') as service_end,
  to_char(r.input_cutoff, 'YYYY-MM-DD') as input_cutoff, to_char(r.payment_date, 'YYYY-MM-DD') as payment_date, r.days_in_month, r.currency_code,
  r.currency_minor_unit, r.member_count, r.scope_department_ids, r.scope_grade_ids, r.scope_location_ids, r.scope_token, r.created_by,
  r.calculation_started_at, r.calendar_as_of, r.calculated_by, r.paid_day_policy_id, r.attendance_basis, r.absent_unpaid_units, r.half_day_unpaid_units, r.calculated_at,
  r.reviewed_by, r.approved_by, r.processing_started_at, r.processed_by, r.version`;

function stale(): never {
  throw new HttpError(409, 'STALE_VERSION', 'The run changed; reload and retry');
}

/**
 * docs/09 §6.5 / I-25: every run action that does not go through decideTask (calculation and its chunks, submission,
 * returns, exception resolution, processing and its chunks, cancellation) re-resolves its permission inside its own
 * transaction after the run's locks, so authority narrowed since the route guard refuses the action and records nothing.
 */
const reassertRun = (tx: Queryable, grant: AccessGrant, action: 'prepare' | 'approve' | 'process' | 'cancel') => reassertAccess(tx, grant, 'payroll_run', action, ['amount']);

/** The run revision, locked behind its transaction lock (taken first, before any row lock). */
async function lockRun(tx: Queryable, companyId: string, runId: string): Promise<RunRow> {
  const t = (await tx.query<{ transaction_id: string }>(`select transaction_id from payroll_run where company_id = $1 and id = $2`, [companyId, runId])).rows[0];
  if (!t) throw notFound();
  await lockTransaction(tx, t.transaction_id);
  return (await tx.query<RunRow>(`select ${RUN_COLUMNS} from payroll_run r where r.company_id = $1 and r.id = $2 for update`, [companyId, runId])).rows[0]!;
}

async function readRun(db: Queryable, companyId: string, runId: string): Promise<RunRow | undefined> {
  return (await db.query<RunRow>(`select ${RUN_COLUMNS} from payroll_run r where r.company_id = $1 and r.id = $2`, [companyId, runId])).rows[0];
}

const contextOf = (r: RunRow, companyId: string): RunContext => ({
  id: r.id,
  company_id: companyId,
  period_id: r.period_id,
  service_start: r.service_start,
  service_end: r.service_end,
  days_in_month: r.days_in_month,
  currency_code: r.currency_code,
  currency_minor_unit: r.currency_minor_unit,
});

const policyOf = (r: RunRow): PolicySnapshot => ({ id: r.paid_day_policy_id, basis: r.attendance_basis ?? 'NOT_CONFIGURED', absent: r.absent_unpaid_units, half: r.half_day_unpaid_units });

/** I-25: listed reviewers of a run stage whose eligible assignments do not cover every included member of the revision. */
const runReviewersLackingScope = (tx: Queryable, companyId: string, kind: string, runId: string) =>
  reviewersLackingScope(tx, companyId, kind, (g) => runMembersOutsideScope(tx, g, runId));

/** Every one of the ids is an included member of the revision. */
async function areMembers(db: Queryable, companyId: string, r: RunRow, ids: readonly string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const n = (
    await db.query<{ n: number }>(
      `select count(*)::int as n from payroll_run_member m
        where m.company_id = $1 and m.lineage_id = $2 and m.employee_id = any($3::uuid[]) and (m.excluded_from_revision is null or m.excluded_from_revision > $4)`,
      [companyId, r.lineage_id, ids, r.revision],
    )
  ).rows[0]!.n;
  return n === ids.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Scope preview and creation
// ---------------------------------------------------------------------------------------------------------------

export interface ScopeInput {
  periodId: string;
  departmentIds?: string[] | undefined;
  gradeIds?: string[] | undefined;
  locationIds?: string[] | undefined;
}

const sorted = (ids: readonly string[] | undefined) => [...new Set(ids ?? [])].sort();

async function checkFilters(db: Queryable, companyId: string, table: 'department' | 'grade' | 'location', ids: string[]) {
  if (ids.length === 0) return;
  const n = (await db.query<{ n: number }>(`select count(*)::int as n from ${table} where company_id = $1 and id = any($2::uuid[])`, [companyId, ids])).rows[0]!.n;
  if (n !== ids.length) throw new HttpError(422, 'UNKNOWN_FILTER', `A ${table} filter value does not exist`, { dimension: table });
}

/**
 * The candidates of a scope, classified (reason null = member), as a CTE named `classified`. Parameters $1..$5 are
 * the service start and end and the three sorted filters; the row-scope predicate adds its own.
 */
function scopeCte(grant: AccessGrant, period: { id: string; service_start: string; service_end: string }, f: { departments: string[]; grades: string[]; locations: string[] }) {
  const params = new SqlParams([period.service_start, period.service_end, f.departments, f.grades, f.locations]);
  const scope = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const sql = `
    with cand as (
      select e.id, e.employee_code, e.display_name, st.code as status, x.leaving_date, a.assignment_id,
             (select m.lineage_id from payroll_run_member m where m.company_id = e.company_id and m.employee_id = e.id and m.service_month = $1::date
                 and m.live and m.excluded_from_revision is null limit 1) as live_lineage
        from employee e
        join reference_value st on st.company_id = e.company_id and st.id = e.status_id
        cross join lateral (select hrms_exit_last_working_date(e.company_id, e.id) as leaving_date) x
        left join lateral (select ea.id as assignment_id, ea.department_id, ea.location_id, ea.grade_id from employment_assignment ea
                            where ea.company_id = e.company_id and ea.employee_id = e.id
                              and ea.effective_from <= least($2::date, coalesce(x.leaving_date, $2::date))
                              and (ea.effective_to is null or ea.effective_to > least($2::date, coalesce(x.leaving_date, $2::date)))) a on true
       where ${scope} and e.joining_date <= $2::date and (x.leaving_date is null or x.leaving_date >= $1::date)
         and (cardinality($3::uuid[]) = 0 or a.department_id = any($3::uuid[]))
         and (cardinality($4::uuid[]) = 0 or a.grade_id = any($4::uuid[]))
         and (cardinality($5::uuid[]) = 0 or a.location_id = any($5::uuid[]))
    ), classified as (
      select c.*, case when c.status = 'DRAFT' then 'EMPLOYEE_NOT_ACTIVATED'
                       when c.status in ('INACTIVE_SEPARATED', 'ARCHIVED') and c.leaving_date is null then 'SEPARATED_WITHOUT_LAST_WORKING_DATE'
                       when c.live_lineage is not null then 'IN_ANOTHER_RUN'
                       when c.status in ('ACTIVE_PROBATION', 'ACTIVE_CONFIRMED', 'NOTICE', 'INACTIVE_SEPARATED', 'ARCHIVED') then null
                       else 'STATUS_NOT_PAYABLE' end as reason
        from cand c
    )`;
  return { sql, params };
}

/**
 * The scope token: SHA-256 over the period, the sorted filters and every member id in order. `period` is the period
 * id's placeholder, $3..$5 the filters, `ids` the SQL aggregate of the member ids.
 */
const TOKEN = (period: string, ids: string) =>
  `encode(sha256(convert_to(concat_ws('|', ${period}::text, array_to_string($3::uuid[], ','), array_to_string($4::uuid[], ','), array_to_string($5::uuid[], ','),
                                      coalesce(${ids}, '')), 'UTF8')), 'hex')`;

async function scopeOf(db: Queryable, grant: AccessGrant, input: ScopeInput) {
  const period = await activePeriod(db, grant.companyId, input.periodId);
  const filters = { departments: sorted(input.departmentIds), grades: sorted(input.gradeIds), locations: sorted(input.locationIds) };
  await checkFilters(db, grant.companyId, 'department', filters.departments);
  await checkFilters(db, grant.companyId, 'grade', filters.grades);
  await checkFilters(db, grant.companyId, 'location', filters.locations);
  return { period, filters };
}

export async function previewRun(db: Queryable, grant: AccessGrant, input: ScopeInput) {
  const { period, filters } = await scopeOf(db, grant, input);
  const { sql, params } = scopeCte(grant, period, filters);
  const company = params.add(grant.companyId);
  const periodParam = params.add(period.id);
  const row = (
    await db.query<{ member_count: number; token: string; by_reason: Record<string, number>; members: unknown[]; not_included: unknown[] }>(
      `${sql}
       select (select count(*)::int from classified where reason is null) as member_count,
              (select ${TOKEN(periodParam, `string_agg(id::text, ',' order by id)`)} from classified where reason is null) as token,
              (select coalesce(json_object_agg(reason, n), '{}'::json) from (select reason, count(*)::int as n from classified where reason is not null group by reason) g) as by_reason,
              (select coalesce(json_agg(json_build_object('employeeId', s.id, 'employeeCode', s.employee_code, 'displayName', s.display_name) order by s.employee_code), '[]'::json)
                 from (select id, employee_code, display_name from classified where reason is null order by employee_code limit ${SAMPLE}) s) as members,
              (select coalesce(json_agg(json_build_object('employeeId', s.id, 'employeeCode', s.employee_code, 'reason', s.reason, 'runId', s.run_id) order by s.employee_code), '[]'::json)
                 from (select c.id, c.employee_code, c.reason,
                              (select r.id from payroll_run r where r.company_id = ${company}::uuid and r.lineage_id = c.live_lineage
                                  and r.state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED', 'PROCESSED_LOCKED')) as run_id
                         from classified c where c.reason is not null order by c.employee_code limit ${SAMPLE}) s) as not_included`,
      params.values,
    )
  ).rows[0]!;
  const notIncludedCount = Object.values(row.by_reason).reduce((a, n) => a + n, 0);
  return {
    periodId: period.id,
    periodCode: period.period_code,
    filters: { departmentIds: filters.departments, gradeIds: filters.grades, locationIds: filters.locations },
    memberCount: row.member_count,
    members: row.members,
    membersTruncated: row.member_count > row.members.length,
    notIncludedCount,
    notIncludedByReason: row.by_reason,
    notIncluded: row.not_included,
    notIncludedTruncated: notIncludedCount > row.not_included.length,
    scopeToken: row.token,
  };
}

export async function createRun(tx: Queryable, grant: AccessGrant, input: ScopeInput & { scopeToken: string }) {
  const { period: p, filters } = await scopeOf(tx, grant, input);
  // Membership of a service month is decided one run at a time.
  await advisoryLock(tx, `payroll_month:${grant.companyId}:${p.service_start}`);
  await reassertRun(tx, grant, 'prepare');
  const id = randomUUID();
  const transactionId = await newTransaction(tx, grant.companyId, RUN_KIND, null, 'DRAFT', grant.userId);
  await tx.query(
    `insert into payroll_run (id, company_id, calendar_id, period_id, lineage_id, revision, transaction_id, state, scope_department_ids, scope_grade_ids,
                              scope_location_ids, scope_token, service_start, service_end, input_cutoff, payment_date, days_in_month, currency_code,
                              currency_minor_unit, member_count, created_by, updated_by)
     values ($1, $2, $3, $4, $1, 1, $5, 'DRAFT', $6, $7, $8, $9, $10, $11, $12, $13, $11::date - $10::date + 1, $14, $15, 0, $16, $16)`,
    [
      id,
      grant.companyId,
      p.calendar_id,
      p.id,
      transactionId,
      filters.departments,
      filters.grades,
      filters.locations,
      input.scopeToken,
      p.service_start,
      p.service_end,
      p.input_cutoff,
      p.payment_date,
      p.currency_code,
      p.currency_minor_unit,
      grant.userId,
    ],
  );
  // The members are written from the scope as it is now and hashed back: anything other than the confirmed scope
  // rolls the creation back.
  const { sql, params } = scopeCte(grant, p, filters);
  const runParam = params.add(id);
  const companyParam = params.add(grant.companyId);
  const userParam = params.add(grant.userId);
  const inserted =
    (
      await tx.query(
        `${sql}
         insert into payroll_run_member (company_id, lineage_id, employee_id, service_month, employment_assignment_id, created_by, updated_by)
         select ${companyParam}::uuid, ${runParam}::uuid, c.id, $1::date, c.assignment_id, ${userParam}::uuid, ${userParam}::uuid from classified c where c.reason is null`,
        params.values,
      )
    ).rowCount ?? 0;
  const token = (
    await tx.query<{ token: string }>(
      `select ${TOKEN('$6', `string_agg(employee_id::text, ',' order by employee_id)`)} as token from payroll_run_member where company_id = $1 and lineage_id = $2`,
      [grant.companyId, id, filters.departments, filters.grades, filters.locations, p.id],
    )
  ).rows[0]!.token;
  if (token !== input.scopeToken) {
    throw new HttpError(409, 'SCOPE_CHANGED', 'The members of this scope changed since the preview; preview and confirm the scope again');
  }
  if (inserted === 0) throw new HttpError(422, 'NO_MEMBERS', 'The run has no members to calculate');
  await tx.query(`update payroll_run set member_count = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, id, inserted, grant.userId]);
  await audit(tx, actorOf(grant), 'payroll_run', id, 'CREATE', null, {
    operational: {
      periodCode: p.period_code,
      revision: 1,
      memberCount: inserted,
      filters: { departmentIds: filters.departments, gradeIds: filters.grades, locationIds: filters.locations },
      scopeToken: input.scopeToken,
    },
  });
  return runDetail(tx, grant, id);
}

/** DRAFT, before its calculation starts: narrows the confirmed scope; an excluded employee may then be paid through another run of the month. */
export async function excludeMembers(tx: Queryable, grant: AccessGrant, runId: string, input: { employeeIds: string[]; reason: string; expectedVersion: number }) {
  const r = await lockRun(tx, grant.companyId, runId);
  await reassertRun(tx, grant, 'prepare');
  if (r.version !== input.expectedVersion) stale();
  if (r.state !== 'DRAFT' || r.calculation_started_at) {
    throw new HttpError(409, 'INVALID_STATE', 'Members are excluded from a draft before its calculation starts; return a calculated revision to a new draft first');
  }
  await requireRunScope(tx, grant, runId);
  const reason = requireText(input.reason, 'reason', 1000);
  const ids = [...new Set(input.employeeIds)];
  const updated = (
    await tx.query<{ employee_id: string }>(
      `update payroll_run_member set excluded_from_revision = $4, exclusion_reason = $5, excluded_at = now(), excluded_by = $6, updated_by = $6
        where company_id = $1 and lineage_id = $2 and employee_id = any($3::uuid[]) and excluded_from_revision is null returning employee_id`,
      [grant.companyId, r.lineage_id, ids, r.revision, reason, grant.userId],
    )
  ).rows.map((x) => x.employee_id);
  if (updated.length !== ids.length) throw new HttpError(422, 'NOT_A_MEMBER', 'Every excluded employee must be an included member of the run');
  await tx.query(`update payroll_run set member_count = member_count - $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, runId, updated.length, grant.userId]);
  await audit(tx, actorOf(grant), 'payroll_run', runId, 'EXCLUDE_MEMBERS', null, { operational: { revision: r.revision, excluded: updated.length, employeeIds: updated } }, reason);
  return runDetail(tx, grant, runId);
}

// ---------------------------------------------------------------------------------------------------------------
// Calculation (chunked), verification and revisions
// ---------------------------------------------------------------------------------------------------------------

async function chunkSums(db: Queryable, companyId: string, runId: string, phase: 'CALCULATE' | 'PROCESS') {
  return (
    await db.query<{
      chunks: number;
      records: number;
      calculated: number;
      failed: number;
      excluded: number;
      not_eligible: number;
      paid_units: string;
      bank_verified: number;
      bank_missing: number;
      bank_invalid: number;
      bank_unverified: number;
      bank_not_required: number;
      safety_blocks: number;
      stop_holds: number;
      applied_stops: number;
      consumed_inputs: number;
    }>(
      `select count(*)::int as chunks, coalesce(sum(records), 0)::int as records, coalesce(sum(calculated), 0)::int as calculated,
              coalesce(sum(failed), 0)::int as failed, coalesce(sum(excluded), 0)::int as excluded, coalesce(sum(not_eligible), 0)::int as not_eligible,
              coalesce(sum(paid_units), 0) as paid_units, coalesce(sum(bank_verified), 0)::int as bank_verified, coalesce(sum(bank_missing), 0)::int as bank_missing,
              coalesce(sum(bank_invalid), 0)::int as bank_invalid, coalesce(sum(bank_unverified), 0)::int as bank_unverified,
              coalesce(sum(bank_not_required), 0)::int as bank_not_required, coalesce(sum(safety_blocks), 0)::int as safety_blocks,
              coalesce(sum(stop_holds), 0)::int as stop_holds, coalesce(sum(applied_stops), 0)::int as applied_stops, coalesce(sum(consumed_inputs), 0)::int as consumed_inputs
         from payroll_run_chunk where company_id = $1 and run_id = $2 and phase = $3`,
      [companyId, runId, phase],
    )
  ).rows[0]!;
}

async function lastChunk(tx: Queryable, companyId: string, runId: string, phase: 'CALCULATE' | 'PROCESS') {
  return (
    await tx.query<{ sequence: number; last_employee_id: string }>(
      `select sequence, last_employee_id from payroll_run_chunk where company_id = $1 and run_id = $2 and phase = $3 order by sequence desc limit 1`,
      [companyId, runId, phase],
    )
  ).rows[0];
}

const counts = (s: Awaited<ReturnType<typeof chunkSums>>) => ({
  CALCULATED: s.calculated,
  FAILED: s.failed,
  EXCLUDED: s.excluded,
  NOT_ELIGIBLE: s.not_eligible,
});

/**
 * FR-033 / CP-08: calculates the revision in chunks. The first call fixes the rules (the version must match); later
 * calls by the same preparer continue. Returns the run with `progress`; `complete` is false when the request's share
 * ended before every member was calculated (call again to continue).
 */
export async function calculateRun(db: Database, grant: AccessGrant, runId: string, input: { expectedVersion: number }, opts: BatchOptions = {}) {
  const chunkSize = opts.chunkSize ?? CHUNK;
  const budget = opts.budgetMs ?? REQUEST_BUDGET_MS;
  const began = Date.now();
  const phase = await withTransaction(db, async (tx) => {
    const r = await lockRun(tx, grant.companyId, runId);
    if (r.state !== 'DRAFT') {
      // A replay of the same calculation returns its outcome (the revision is calculated once).
      if (r.state === 'CALCULATED' && r.calculated_by === grant.userId) return 'REPLAY' as const;
      throw new HttpError(409, 'ALREADY_CALCULATED', 'A revision is calculated once; return it to calculate a new revision');
    }
    await reassertRun(tx, grant, 'prepare');
    if (!r.calculation_started_at) {
      if (r.version !== input.expectedVersion) stale();
      if (r.member_count === 0) throw new HttpError(422, 'NO_MEMBERS', 'The run has no included members to calculate');
      await requireRunScope(tx, grant, runId);
      // Serialised with input and stop approvals of the service month (every calendar): none slips in once the snapshot starts.
      await lockServiceMonth(tx, grant.companyId, r.service_start);
      const { policy, heads } = await startCalculation(tx, contextOf(r, grant.companyId), grant.userId);
      await audit(tx, actorOf(grant), 'payroll_run', runId, 'CALCULATION_STARTED', { operational: { state: 'DRAFT' } }, {
        operational: { state: 'DRAFT', revision: r.revision, members: r.member_count, attendanceBasis: policy.basis, paidDayPolicyId: policy.id, heads },
      });
      return 'STARTED' as const;
    }
    if (r.calculated_by !== grant.userId) throw new HttpError(409, 'CALCULATION_IN_PROGRESS', 'The preparer who started this calculation continues it');
    return 'CONTINUE' as const;
  });
  if (phase === 'REPLAY') return { ...(await runDetail(db, grant, runId)), replayed: true };

  let chunks = 0;
  for (;;) {
    if (opts.maxChunks !== undefined && chunks >= opts.maxChunks) break;
    if (chunks > 0 && Date.now() - began > budget) break;
    const step = await withTransaction(db, async (tx) => {
      const r = await lockRun(tx, grant.companyId, runId);
      if (r.state !== 'DRAFT' || !r.calculation_started_at || r.calculated_by !== grant.userId) return 'STOP' as const;
      // Each chunk is its own transaction: the preparer's authority is checked again in every one.
      await reassertRun(tx, grant, 'prepare');
      const last = await lastChunk(tx, grant.companyId, runId, 'CALCULATE');
      const ids = (
        await tx.query<{ employee_id: string }>(
          `select m.employee_id from payroll_run_member m
            where m.company_id = $1 and m.lineage_id = $2 and (m.excluded_from_revision is null or m.excluded_from_revision > $3)
              and ($4::uuid is null or m.employee_id > $4::uuid)
            order by m.employee_id limit $5`,
          [grant.companyId, r.lineage_id, r.revision, last?.last_employee_id ?? null, chunkSize],
        )
      ).rows.map((x) => x.employee_id);
      if (ids.length === 0) return 'DONE' as const;
      const outcome = await calculateChunk(tx, contextOf(r, grant.companyId), policyOf(r), grant.userId, ids);
      const chunkId = (
        await tx.query<{ id: string }>(
          `insert into payroll_run_chunk (company_id, run_id, phase, sequence, first_employee_id, last_employee_id, records, calculated, failed, excluded, not_eligible,
                                          paid_units, created_by)
           values ($1, $2, 'CALCULATE', $3, $4, $5, $6, $7, $8, $9, $10, $11::numeric, $12) returning id`,
          [grant.companyId, runId, (last?.sequence ?? 0) + 1, ids[0], ids[ids.length - 1], outcome.records, outcome.calculated, outcome.failed, outcome.excluded, outcome.notEligible, outcome.paidUnits, grant.userId],
        )
      ).rows[0]!.id;
      if (outcome.totals.length > 0) {
        await tx.query(
          `insert into payroll_run_chunk_total (company_id, chunk_id, run_id, component_id, head_type, line_count, amount, created_by)
           select $1, $2, $3, t.component_id, t.head_type, t.line_count, t.amount, $4
             from unnest($5::uuid[], $6::text[], $7::int[], $8::numeric[]) t (component_id, head_type, line_count, amount)`,
          [
            grant.companyId,
            chunkId,
            runId,
            grant.userId,
            outcome.totals.map((t) => t.componentId),
            outcome.totals.map((t) => t.headType),
            outcome.totals.map((t) => t.lineCount),
            outcome.totals.map((t) => t.amount),
          ],
        );
      }
      return ids.length < chunkSize ? ('DONE' as const) : ('MORE' as const);
    });
    if (step === 'STOP') break;
    chunks++;
    if (step === 'DONE') break;
  }

  const finished = await withTransaction(db, async (tx) => {
    const r = await lockRun(tx, grant.companyId, runId);
    if (r.state !== 'DRAFT') return r.state === 'CALCULATED' && r.calculated_by === grant.userId ? ('ALREADY' as const) : ('CLOSED' as const);
    const sums = await chunkSums(tx, grant.companyId, runId, 'CALCULATE');
    if (sums.records < r.member_count) return 'INCOMPLETE' as const;
    if (r.calculated_by !== grant.userId) throw new HttpError(409, 'CALCULATION_IN_PROGRESS', 'The preparer who started this calculation continues it');
    await reassertRun(tx, grant, 'prepare');
    await setRootState(tx, 'payroll_run', grant.companyId, r, 'CALCULATED', grant.userId, ', calculated_at = now()');
    const exceptions = await exceptionCounts(tx, grant.companyId, runId);
    await audit(tx, actorOf(grant), 'payroll_run', runId, 'CALCULATE', { operational: { state: 'DRAFT' } }, {
      operational: { state: 'CALCULATED', revision: r.revision, records: counts(sums), chunks: sums.chunks, exceptions, attendanceBasis: r.attendance_basis, paidDayPolicyId: r.paid_day_policy_id },
    });
    return 'COMPLETED' as const;
  });
  if (finished === 'CLOSED') throw new HttpError(409, 'INVALID_STATE', 'The revision was closed while it was being calculated');
  return { ...(await runDetail(db, grant, runId)), replayed: finished === 'ALREADY' };
}

/** FR-033 / ZT36: a rerun on the revision's frozen snapshot gives identical results (read-only, bounded; continue with `after`). */
export async function verifyRun(db: Queryable, grant: AccessGrant, runId: string, q: { after?: string | undefined } = {}, opts: BatchOptions = {}) {
  const r = await readRun(db, grant.companyId, runId);
  if (!r) throw notFound();
  if (!r.calculated_at) throw new HttpError(409, 'NOT_CALCULATED', 'This revision has no completed calculation to verify');
  await requireRunScope(db, grant, runId);
  return {
    runId,
    revision: r.revision,
    state: r.state,
    ...(await verifyMembers(db, grant.companyId, runId, { after: q.after ?? null, budgetMs: opts.budgetMs ?? REQUEST_BUDGET_MS, chunkSize: opts.chunkSize ?? CHUNK })),
  };
}

/** Closes a revision as RETURNED and opens the next revision as a draft with the same confirmed members (H2). */
async function returnRun(tx: Queryable, actor: Actor, r: RunRow, reason: string, excludeEmployeeIds: readonly string[] = []) {
  for (const t of (await tx.query<{ id: string; transaction_id: string; table: 'payroll_run_approval' | 'payroll_record_cover' }>(
    `select id, transaction_id, 'payroll_run_approval' as table from payroll_run_approval where company_id = $1 and run_id = $2 and state = 'SUBMITTED'
     union all
     select id, transaction_id, 'payroll_record_cover' from payroll_record_cover where company_id = $1 and run_id = $2 and state = 'SUBMITTED'`,
    [actor.companyId, r.id],
  )).rows) {
    await cancelActiveApproval(tx, actor.companyId, t.transaction_id, actor.userId);
    await setRootState(tx, t.table, actor.companyId, t, 'CANCELLED', actor.userId, ', closed_at = now()');
  }
  await cancelActiveApproval(tx, actor.companyId, r.transaction_id, actor.userId);
  await setRootState(tx, 'payroll_run', actor.companyId, r, 'RETURNED', actor.userId, ', closed_at = now(), close_reason = $5', [reason]);
  const nextId = randomUUID();
  const transactionId = await newTransaction(tx, actor.companyId, RUN_KIND, null, 'DRAFT', actor.userId);
  // The lineage keeps its creator (who confirmed the scope), so the creator stays excluded from its decisions.
  await tx.query(
    `insert into payroll_run (id, company_id, calendar_id, period_id, lineage_id, revision, supersedes_run_id, transaction_id, state, scope_department_ids,
                              scope_grade_ids, scope_location_ids, scope_token, service_start, service_end, input_cutoff, payment_date, days_in_month,
                              currency_code, currency_minor_unit, member_count, created_by, updated_by)
     select $3, company_id, calendar_id, period_id, lineage_id, revision + 1, id, $4, 'DRAFT', scope_department_ids, scope_grade_ids, scope_location_ids,
            scope_token, service_start, service_end, input_cutoff, payment_date, days_in_month, currency_code, currency_minor_unit, member_count, created_by, $5
       from payroll_run where company_id = $1 and id = $2`,
    [actor.companyId, r.id, nextId, transactionId, actor.userId],
  );
  let excluded = 0;
  if (excludeEmployeeIds.length > 0) {
    excluded =
      (
        await tx.query(
          `update payroll_run_member set excluded_from_revision = $4, exclusion_reason = $5, excluded_at = now(), excluded_by = $6, updated_by = $6
            where company_id = $1 and lineage_id = $2 and employee_id = any($3::uuid[]) and excluded_from_revision is null`,
          [actor.companyId, r.lineage_id, excludeEmployeeIds, r.revision + 1, reason, actor.userId],
        )
      ).rowCount ?? 0;
    await tx.query(`update payroll_run set member_count = member_count - $3, updated_by = $4 where company_id = $1 and id = $2`, [actor.companyId, nextId, excluded, actor.userId]);
  }
  await audit(tx, actor, 'payroll_run', r.id, 'RETURN', { operational: { state: r.state, revision: r.revision } }, {
    operational: { state: 'RETURNED', revision: r.revision, nextRunId: nextId, nextRevision: r.revision + 1, excluded },
  }, reason);
  await audit(tx, actor, 'payroll_run', nextId, 'CREATE_REVISION', null, { operational: { revision: r.revision + 1, supersedes: r.id } });
  await emit(tx, actor.companyId, 'payroll_run.returned', r.id, r.id, { runId: r.id, revision: r.revision, nextRunId: nextId });
  return nextId;
}

async function returnInput(db: Queryable, companyId: string, r: RunRow, reason: string | undefined, excludeEmployeeIds: string[] | undefined) {
  const text = requireText(reason, 'reason', 1000);
  const exclude = [...new Set(excludeEmployeeIds ?? [])];
  if (!(await areMembers(db, companyId, r, exclude))) throw new HttpError(422, 'NOT_A_MEMBER', 'Every excluded employee must be an included member of the run');
  return { reason: text, exclude };
}

/** The preparer's own validation return (a calculated revision, before submission) into a new draft revision. */
export async function reviseRun(tx: Queryable, grant: AccessGrant, runId: string, input: { reason: string; excludeEmployeeIds?: string[] | undefined; expectedVersion: number }) {
  const r = await lockRun(tx, grant.companyId, runId);
  await reassertRun(tx, grant, 'prepare');
  if (r.version !== input.expectedVersion) stale();
  if (r.state !== 'CALCULATED') throw new HttpError(409, 'INVALID_STATE', 'Only a calculated revision that is not under review can be revised by its preparer');
  await requireRunScope(tx, grant, runId);
  const ret = await returnInput(tx, grant.companyId, r, input.reason, input.excludeEmployeeIds);
  const nextId = await returnRun(tx, actorOf(grant), r, ret.reason, ret.exclude);
  return runDetail(tx, grant, nextId);
}

/** The processor's validation return of an approved revision, before processing starts (H2: "return ... before processing"). */
export async function returnApprovedRun(tx: Queryable, grant: AccessGrant, runId: string, input: { reason: string; excludeEmployeeIds?: string[] | undefined; expectedVersion: number }) {
  const r = await lockRun(tx, grant.companyId, runId);
  await reassertRun(tx, grant, 'process');
  if (r.version !== input.expectedVersion) stale();
  if (r.state === 'APPROVED' && r.processing_started_at) throw new HttpError(409, 'PROCESSING_STARTED', 'Processing has started; the revision can only be completed');
  if (r.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only an approved revision that is not yet processed can be returned this way');
  await requireRunScope(tx, grant, runId);
  const ret = await returnInput(tx, grant.companyId, r, input.reason, input.excludeEmployeeIds);
  const nextId = await returnRun(tx, actorOf(grant), r, ret.reason, ret.exclude);
  return runDetail(tx, grant, nextId);
}

export async function submitRun(tx: Queryable, grant: AccessGrant, runId: string, input: { expectedVersion: number }) {
  const r = await lockRun(tx, grant.companyId, runId);
  await reassertRun(tx, grant, 'prepare');
  if (r.version !== input.expectedVersion) stale();
  if (r.state !== 'CALCULATED') throw new HttpError(409, 'INVALID_STATE', 'Only a calculated revision can be submitted for review');
  if (r.calculated_by !== grant.userId) throw new HttpError(403, 'NOT_PREPARER', 'The preparer who calculated the revision submits it');
  await requireRunScope(tx, grant, runId);
  await setRootState(tx, 'payroll_run', grant.companyId, r, 'IN_REVIEW', grant.userId, ', submitted_at = now()');
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: RUN_KIND,
    transactionId: r.transaction_id,
    ownerEmployeeId: null,
    actorUserId: grant.userId,
    excludeUserIds: [r.created_by, r.calculated_by, ...(await runReviewersLackingScope(tx, grant.companyId, RUN_KIND, runId))].filter((u): u is string => !!u),
  });
  await audit(tx, actorOf(grant), 'payroll_run', runId, 'SUBMIT', { operational: { state: 'CALCULATED' } }, { operational: { state: 'IN_REVIEW', revision: r.revision } });
  await emit(tx, grant.companyId, 'payroll_run.assigned', runId, `${runId}:review`, { runId, taskId, step: 'review', revision: r.revision });
  return runDetail(tx, grant, runId);
}

// ---------------------------------------------------------------------------------------------------------------
// Review, approval and covering approvals
// ---------------------------------------------------------------------------------------------------------------

export interface RunDecisionInput {
  decision: 'APPROVE' | 'RETURN';
  reason?: string | undefined;
  idempotencyKey: string;
  /** On RETURN: employees to leave out of the next revision (with the reason). */
  excludeEmployeeIds?: string[] | undefined;
}

function assertIndependent(grant: AccessGrant, deciders: readonly (string | null)[]): void {
  if (deciders.includes(grant.userId)) throw new HttpError(403, 'NOT_INDEPENDENT', 'The creator, preparer, reviewer and approver of a run are different people');
}

async function unresolvedBlocking(db: Queryable, companyId: string, runId: string) {
  return (
    await db.query<{ code: string; n: number }>(
      `select code, count(*)::int as n from payroll_exception where company_id = $1 and run_id = $2 and severity = 'BLOCKING' and resolved_at is null group by code order by code`,
      [companyId, runId],
    )
  ).rows;
}

export async function reviewRun(tx: Queryable, grant: AccessGrant, taskId: string, input: RunDecisionInput) {
  const t = await taskTransaction(tx, grant, taskId, [RUN_KIND]);
  await lockTransaction(tx, t.transactionId);
  const r = (await tx.query<RunRow>(`select ${RUN_COLUMNS} from payroll_run r where r.company_id = $1 and r.transaction_id = $2 for update`, [grant.companyId, t.transactionId])).rows[0];
  if (!r) throw notFound();
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { runId: r.id, state: r.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (r.state !== 'IN_REVIEW' || r.reviewed_by) throw new HttpError(409, 'INVALID_STATE', 'This run is not waiting for review');
  assertIndependent(grant, [r.created_by, r.calculated_by]);
  await requireRunScope(tx, grant, r.id);
  const ret = input.decision === 'RETURN' ? await returnInput(tx, grant.companyId, r, input.reason, input.excludeEmployeeIds) : null;
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'payroll_run', action: 'review' } });
  if (result.replayed) return { runId: r.id, state: r.state, replayed: true };
  if (ret) {
    const nextId = await returnRun(tx, actorOf(grant), r, ret.reason, ret.exclude);
    return { runId: r.id, state: 'RETURNED', nextRunId: nextId, replayed: false };
  }
  await tx.query(`update payroll_run set reviewed_at = now(), reviewed_by = $3, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, r.id, grant.userId]);
  // The approval stage is its own transaction, so that the approver is chosen independently of preparer and reviewer.
  const stageTx = await newTransaction(tx, grant.companyId, APPROVAL_KIND, null, 'SUBMITTED', grant.userId);
  await tx.query(`insert into payroll_run_approval (company_id, run_id, transaction_id, state, created_by, updated_by) values ($1, $2, $3, 'SUBMITTED', $4, $4)`, [
    grant.companyId,
    r.id,
    stageTx,
    grant.userId,
  ]);
  const { taskId: approvalTask } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: APPROVAL_KIND,
    transactionId: stageTx,
    ownerEmployeeId: null,
    actorUserId: grant.userId,
    excludeUserIds: [r.created_by, r.calculated_by, grant.userId, ...(await runReviewersLackingScope(tx, grant.companyId, APPROVAL_KIND, r.id))].filter(
      (u): u is string => !!u,
    ),
  });
  await audit(tx, actorOf(grant), 'payroll_run', r.id, 'REVIEW', { operational: { state: 'IN_REVIEW' } }, { operational: { state: 'IN_REVIEW', revision: r.revision, reviewed: true } }, input.reason ?? null);
  await emit(tx, grant.companyId, 'payroll_run.assigned', r.id, `${r.id}:approval`, { runId: r.id, taskId: approvalTask, step: 'approval', revision: r.revision });
  return { runId: r.id, state: 'IN_REVIEW', step: 'APPROVAL', replayed: false };
}

/** Runs the decision-stage lock order: the run's transaction first, then the stage's, then rows. */
async function lockStage(tx: Queryable, grant: AccessGrant, table: 'payroll_run_approval' | 'payroll_record_cover', transactionId: string) {
  const s0 = (await tx.query<{ run_id: string }>(`select run_id from ${table} where company_id = $1 and transaction_id = $2`, [grant.companyId, transactionId])).rows[0];
  if (!s0) throw notFound();
  const r = await lockRun(tx, grant.companyId, s0.run_id);
  await lockTransaction(tx, transactionId);
  const stage = (
    await tx.query<{ id: string; transaction_id: string; state: string; employee_id?: string }>(`select * from ${table} where company_id = $1 and transaction_id = $2 for update`, [
      grant.companyId,
      transactionId,
    ])
  ).rows[0]!;
  return { r, stage };
}

async function setApproved(tx: Queryable, actor: Actor, r: RunRow) {
  await setRootState(tx, 'payroll_run', actor.companyId, r, 'APPROVED', actor.userId);
  await audit(tx, actor, 'payroll_run', r.id, 'APPROVED', { operational: { state: 'IN_REVIEW' } }, { operational: { state: 'APPROVED', revision: r.revision } });
}

export async function approveRun(tx: Queryable, grant: AccessGrant, taskId: string, input: RunDecisionInput) {
  const t = await taskTransaction(tx, grant, taskId, [APPROVAL_KIND]);
  const { r, stage } = await lockStage(tx, grant, 'payroll_run_approval', t.transactionId);
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { runId: r.id, state: r.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (r.state !== 'IN_REVIEW' || stage.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This run is not waiting for approval');
  assertIndependent(grant, [r.created_by, r.calculated_by, r.reviewed_by]);
  await requireRunScope(tx, grant, r.id);
  const ret = input.decision === 'RETURN' ? await returnInput(tx, grant.companyId, r, input.reason, input.excludeEmployeeIds) : null;
  if (!ret) {
    // FR-033: unconfigured heads and calculation failures block approval for the affected scope.
    const open = await unresolvedBlocking(tx, grant.companyId, r.id);
    if (open.length > 0) {
      throw new HttpError(409, 'EXCEPTIONS_UNRESOLVED', 'Blocking exceptions must be resolved, or the employees excluded through a new revision, before approval', { exceptions: open });
    }
  }
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'payroll_run', action: 'approve' } });
  if (result.replayed) return { runId: r.id, state: r.state, replayed: true };
  if (ret) {
    await setRootState(tx, 'payroll_run_approval', grant.companyId, stage, 'RETURNED', grant.userId, ', closed_at = now()');
    const nextId = await returnRun(tx, actorOf(grant), r, ret.reason, ret.exclude);
    return { runId: r.id, state: 'RETURNED', nextRunId: nextId, replayed: false };
  }
  await setRootState(tx, 'payroll_run_approval', grant.companyId, stage, 'APPROVED', grant.userId, ', closed_at = now()');
  await tx.query(`update payroll_run set approved_at = now(), approved_by = $3, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, r.id, grant.userId]);
  const run = { ...r, approved_by: grant.userId };
  // Records of the reviewer and the approver need a covering approval by someone else.
  const own = (
    await tx.query<{ employee_id: string; role: 'REVIEWER' | 'APPROVER' }>(
      `select distinct on (rec.employee_id) rec.employee_id, case when l.user_id = $3 then 'REVIEWER' else 'APPROVER' end as role
         from user_employee_link l join payroll_record rec on rec.company_id = l.company_id and rec.run_id = $2 and rec.employee_id = l.employee_id
        where l.company_id = $1 and l.user_id = any(array[$3, $4]::uuid[])
        order by rec.employee_id, (l.user_id = $3) desc`,
      [grant.companyId, r.id, r.reviewed_by, grant.userId],
    )
  ).rows;
  if (own.length === 0) {
    await setApproved(tx, actorOf(grant), run);
    return { runId: r.id, state: 'APPROVED', replayed: false };
  }
  for (const o of own) {
    const coverTx = await newTransaction(tx, grant.companyId, COVER_KIND, o.employee_id, 'SUBMITTED', grant.userId);
    const coverId = (
      await tx.query<{ id: string }>(
        `insert into payroll_record_cover (company_id, run_id, employee_id, covered_role, transaction_id, state, created_by, updated_by)
         values ($1, $2, $3, $4, $5, 'SUBMITTED', $6, $6) returning id`,
        [grant.companyId, r.id, o.employee_id, o.role, coverTx, grant.userId],
      )
    ).rows[0]!.id;
    const { taskId: coverTask } = await startApproval(tx, {
      companyId: grant.companyId,
      kind: COVER_KIND,
      transactionId: coverTx,
      ownerEmployeeId: o.employee_id,
      actorUserId: grant.userId,
      excludeUserIds: [r.created_by, r.calculated_by, r.reviewed_by, grant.userId].filter((u): u is string => !!u),
    });
    await emit(tx, grant.companyId, 'payroll_run.assigned', r.id, `${r.id}:cover:${coverId}`, { runId: r.id, taskId: coverTask, step: 'cover', revision: r.revision });
  }
  await audit(tx, actorOf(grant), 'payroll_run', r.id, 'APPROVE', { operational: { state: 'IN_REVIEW' } }, {
    operational: { state: 'IN_REVIEW', revision: r.revision, coversRequired: own.length },
  }, input.reason ?? null);
  return { runId: r.id, state: 'IN_REVIEW', step: 'COVER', coversRequired: own.length, replayed: false };
}

export async function coverRecord(tx: Queryable, grant: AccessGrant, taskId: string, input: RunDecisionInput) {
  const t = await taskTransaction(tx, grant, taskId, [COVER_KIND]);
  const { r, stage } = await lockStage(tx, grant, 'payroll_record_cover', t.transactionId);
  const coveredEmployee = stage.employee_id!;
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { runId: r.id, state: r.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (r.state !== 'IN_REVIEW' || stage.state !== 'SUBMITTED' || !r.approved_by) throw new HttpError(409, 'INVALID_STATE', 'This record is not waiting for a covering approval');
  assertIndependent(grant, [r.created_by, r.calculated_by, r.reviewed_by, r.approved_by]);
  assertNotSelf(grant, coveredEmployee);
  if (await userIsEmployee(tx, grant.companyId, grant.userId, coveredEmployee)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
  await assertInScope(tx, grant, coveredEmployee);
  const ret = input.decision === 'RETURN' ? await returnInput(tx, grant.companyId, r, input.reason, input.excludeEmployeeIds) : null;
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'payroll_run', action: 'approve' } });
  if (result.replayed) return { runId: r.id, state: r.state, replayed: true };
  if (ret) {
    await setRootState(tx, 'payroll_record_cover', grant.companyId, stage, 'RETURNED', grant.userId, ', closed_at = now()');
    const nextId = await returnRun(tx, actorOf(grant), r, ret.reason, ret.exclude);
    return { runId: r.id, state: 'RETURNED', nextRunId: nextId, replayed: false };
  }
  await setRootState(tx, 'payroll_record_cover', grant.companyId, stage, 'APPROVED', grant.userId, ', closed_at = now()');
  await audit(tx, actorOf(grant), 'payroll_run', r.id, 'COVER', null, { operational: { revision: r.revision, coveredEmployeeId: coveredEmployee } }, input.reason ?? null);
  const pending = (await tx.query<{ n: number }>(`select count(*)::int as n from payroll_record_cover where company_id = $1 and run_id = $2 and state = 'SUBMITTED'`, [grant.companyId, r.id]))
    .rows[0]!.n;
  if (pending === 0) {
    await setApproved(tx, actorOf(grant), r);
    return { runId: r.id, state: 'APPROVED', replayed: false };
  }
  return { runId: r.id, state: 'IN_REVIEW', step: 'COVER', replayed: false };
}

/** H2: a payroll approver records the documented resolution of a resolvable blocking exception. */
export async function resolveException(tx: Queryable, grant: AccessGrant, runId: string, exceptionId: string, input: { resolution: string }) {
  const r = await lockRun(tx, grant.companyId, runId);
  const x = (
    await tx.query<{ id: string; employee_id: string; code: string; severity: string; resolvable: boolean; resolved_at: Date | null }>(
      `select id, employee_id, code, severity, resolvable, resolved_at from payroll_exception where company_id = $1 and run_id = $2 and id = $3 for update`,
      [grant.companyId, runId, exceptionId],
    )
  ).rows[0];
  if (!x) throw notFound();
  await assertInScope(tx, grant, x.employee_id);
  // A decision outside decideTask: the approver's authority is resolved again after the locks (docs/09 §6.5).
  await reassertRun(tx, grant, 'approve');
  if (r.state !== 'CALCULATED' && r.state !== 'IN_REVIEW') throw new HttpError(409, 'INVALID_STATE', 'Exceptions are resolved while the run is calculated or under review');
  if (x.severity !== 'BLOCKING' || !x.resolvable) throw new HttpError(422, 'NOT_RESOLVABLE', 'This exception needs corrected data and a new revision (or the employee excluded), not a resolution note');
  if (x.resolved_at) throw new HttpError(409, 'ALREADY_RESOLVED', 'This exception has been resolved');
  assertIndependent(grant, [r.created_by, r.calculated_by]);
  assertNotSelf(grant, x.employee_id);
  if (await userIsEmployee(tx, grant.companyId, grant.userId, x.employee_id)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
  const resolution = requireText(input.resolution, 'resolution', 1000, 'RESOLUTION_REQUIRED');
  await tx.query(
    `update payroll_exception set resolution = $3, resolved_by = $4, resolved_assignment_id = $5, resolved_at = now(), updated_by = $4 where company_id = $1 and id = $2`,
    [grant.companyId, exceptionId, resolution, grant.userId, grant.assignmentId],
  );
  await audit(tx, actorOf(grant), 'payroll_exception', exceptionId, 'RESOLVE', null, { operational: { runId, revision: r.revision, code: x.code, employeeId: x.employee_id } }, resolution);
  return { exceptionId, code: x.code, resolved: true };
}

// ---------------------------------------------------------------------------------------------------------------
// Processing (chunked freeze) and cancellation
// ---------------------------------------------------------------------------------------------------------------

interface ProcessChunkCounts {
  bank: Record<'VERIFIED' | 'MISSING' | 'INVALID' | 'UNVERIFIED' | 'NOT_REQUIRED', number>;
  safetyBlocks: number;
  stopHolds: number;
  appliedStops: number;
  consumedInputs: number;
}

/** Freezes one chunk of records with their bank reference and applies what processing applies to them. */
async function processChunk(tx: Queryable, actor: Actor, businessDate: string, runId: string, records: { id: string; employee_id: string; payable: boolean }[]): Promise<ProcessChunkCounts> {
  const payable = records.filter((r) => r.payable);
  const checks = await bankChecks(tx, actor.companyId, payable.map((p) => p.employee_id));
  const status = (r: { employee_id: string; payable: boolean }) => (r.payable ? (checks.get(r.employee_id)?.status ?? 'MISSING') : 'NOT_REQUIRED');
  const revision = (r: { employee_id: string; payable: boolean }) => (r.payable && checks.get(r.employee_id)?.status === 'VERIFIED' ? checks.get(r.employee_id)!.revisionId : null);
  const ids = records.map((r) => r.id);
  await tx.query(
    `update payroll_record rec set bank_status = m.status, bank_revision_id = m.revision_id, frozen_at = now(), updated_by = $3
       from unnest($4::uuid[], $5::text[], $6::uuid[]) m (record_id, status, revision_id)
      where rec.company_id = $1 and rec.run_id = $2 and rec.id = m.record_id`,
    [actor.companyId, runId, actor.userId, ids, records.map(status), records.map(revision)],
  );
  // Inputs included in calculated records are consumed by them.
  const consumedInputs =
    (
      await tx.query(
        `update payroll_input i set consumed_record_id = ri.record_id, updated_by = $3
           from payroll_record_input ri join payroll_record rec on rec.company_id = ri.company_id and rec.id = ri.record_id
          where rec.company_id = $1 and rec.run_id = $2 and rec.id = any($4::uuid[]) and rec.calculation_status = 'CALCULATED'
            and i.company_id = ri.company_id and i.id = ri.input_id`,
        [actor.companyId, runId, actor.userId, ids],
      )
    ).rowCount ?? 0;
  // Approved stops of the records are applied (their transactions first: the mirror is checked at commit).
  await tx.query(
    `update business_transaction bt set state = 'APPLIED', updated_by = $3
       from payroll_record rec join payroll_salary_stop ss on ss.company_id = rec.company_id and ss.id = rec.salary_stop_id
      where rec.company_id = $1 and rec.run_id = $2 and rec.id = any($4::uuid[]) and bt.company_id = ss.company_id and bt.id = ss.transaction_id`,
    [actor.companyId, runId, actor.userId, ids],
  );
  const appliedStops =
    (
      await tx.query(
        `update payroll_salary_stop ss set state = 'APPLIED', applied_record_id = rec.id, closed_at = now(), updated_by = $3
           from payroll_record rec
          where rec.company_id = $1 and rec.run_id = $2 and rec.id = any($4::uuid[]) and ss.company_id = rec.company_id and ss.id = rec.salary_stop_id`,
        [actor.companyId, runId, actor.userId, ids],
      )
    ).rowCount ?? 0;
  const created = await createAutomaticHolds(tx, actor, businessDate, runId, ids);
  const bank = { VERIFIED: 0, MISSING: 0, INVALID: 0, UNVERIFIED: 0, NOT_REQUIRED: 0 };
  for (const r of records) bank[status(r)]++;
  return { bank, safetyBlocks: created.safetyBlocks, stopHolds: created.stopHolds, appliedStops, consumedInputs };
}

/**
 * FR-099 / CP-08: processes an approved revision in chunks and then locks it. The first call checks and marks the
 * start (the version must match; its processor is recorded as processed_by); later calls continue. A started
 * processing can only be completed, so any eligible processor with the whole run in scope may continue it (each
 * chunk and the lock are audited with their own actor): a processor who loses authority or is absent never leaves a
 * run that can neither be completed nor returned. `complete` is false when the request's share ended before every
 * record was frozen.
 */
export async function processRun(db: Database, grant: AccessGrant, runId: string, input: { expectedVersion: number }, opts: BatchOptions = {}) {
  const chunkSize = opts.chunkSize ?? CHUNK;
  const budget = opts.budgetMs ?? REQUEST_BUDGET_MS;
  const began = Date.now();
  const phase = await withTransaction(db, async (tx) => {
    const r = await lockRun(tx, grant.companyId, runId);
    await requireRunScope(tx, grant, runId);
    // Idempotent: a processed revision is reported, never processed again.
    if (r.state === 'PROCESSED_LOCKED') return 'REPLAY' as const;
    if (r.state !== 'APPROVED') throw new HttpError(409, 'NOT_APPROVED', 'Only an independently approved run can be processed');
    await reassertRun(tx, grant, 'process');
    // BRD role table (Payroll Operator "cannot approve or release own prepared payroll"; C4): processing locks the run
    // for payment, so its creator and preparer never process it, neither the start nor a continuation.
    if (grant.userId === r.created_by || grant.userId === r.calculated_by) {
      throw new HttpError(403, 'NOT_INDEPENDENT', 'The creator and preparer of a payroll run do not process it');
    }
    if (r.processing_started_at) return 'CONTINUE' as const;
    if (r.version !== input.expectedVersion) stale();
    const open = await unresolvedBlocking(tx, grant.companyId, runId);
    if (open.length > 0) throw new HttpError(409, 'EXCEPTIONS_UNRESOLVED', 'Blocking exceptions are unresolved', { exceptions: open });
    // Serialised with input and stop approvals of the service month; the approved inputs and stops must still be
    // exactly the ones the snapshot holds (none silently dropped).
    await lockServiceMonth(tx, grant.companyId, r.service_start);
    const newInputs = (
      await tx.query<{ n: number }>(
        `select count(*)::int as n from payroll_input i
           join payroll_record rec on rec.company_id = i.company_id and rec.run_id = $2 and rec.employee_id = i.employee_id and rec.calculation_status = 'CALCULATED'
          where i.company_id = $1 and i.period_id = $3 and i.state = 'APPROVED' and i.consumed_record_id is null
            and not exists (select 1 from payroll_record_input ri where ri.company_id = i.company_id and ri.record_id = rec.id and ri.input_id = i.id)`,
        [grant.companyId, runId, r.period_id],
      )
    ).rows[0]!.n;
    if (newInputs > 0) throw new HttpError(409, 'INPUTS_CHANGED', 'Inputs were approved after the calculation; return the run to calculate a new revision', { inputs: newInputs });
    // Stops approved under another calendar's period of the month need no check here: the calculation flags them on
    // every paid record (SALARY_STOP_OTHER_PERIOD, not resolvable), and none can be approved once the month's
    // snapshot is taken (lockServiceMonth + snapshotTaken).
    const stops = (
      await tx.query<{ n: number }>(
        `select (select count(*)::int from payroll_salary_stop ss
                  join payroll_record rec on rec.company_id = ss.company_id and rec.run_id = $2 and rec.employee_id = ss.employee_id
                 where ss.company_id = $1 and ss.period_id = $3 and ss.state = 'APPROVED' and rec.salary_stop_id is distinct from ss.id)
              + (select count(*)::int from payroll_record rec join payroll_salary_stop ss on ss.company_id = rec.company_id and ss.id = rec.salary_stop_id
                 where rec.company_id = $1 and rec.run_id = $2 and ss.state <> 'APPROVED') as n`,
        [grant.companyId, runId, r.period_id],
      )
    ).rows[0]!.n;
    if (stops > 0) throw new HttpError(409, 'SALARY_STOPS_CHANGED', 'Salary stops changed after the calculation; return the run to calculate a new revision', { records: stops });
    // FR-034: two runs of different months can each pass the calculation against the same balance. The deduction
    // becomes final here, so the balance is read again, one processing start at a time across the company's months.
    await advisoryLock(tx, `payroll_loan_balance:${grant.companyId}`);
    const breaches = (
      await tx.query<{ n: number }>(
        `select count(distinct v.record_id)::int as n from (${loanRecoveryBreaches(`r.company_id = $1 and r.run_id = $2 and r.calculation_status = 'CALCULATED'`)}) v`,
        [grant.companyId, runId],
      )
    ).rows[0]!.n;
    if (breaches > 0) throw new HttpError(409, 'LOAN_BALANCE_CHANGED', 'A loan changed after the calculation, so a recovery line is no longer covered; return the run to calculate a new revision', { records: breaches });
    // The actual time, not the transaction's start: this transaction may have waited on the locks above, and a loan
    // disbursed meanwhile, which the check above saw as disbursed, must count this run's line (LOAN_LINE_COUNTS).
    await tx.query(
      `update payroll_run set processing_started_at = clock_timestamp(), processed_by = $3, processed_assignment_id = $4, updated_by = $3 where company_id = $1 and id = $2`,
      [grant.companyId, runId, grant.userId, grant.assignmentId],
    );
    await audit(tx, actorOf(grant), 'payroll_run', runId, 'PROCESSING_STARTED', { operational: { state: 'APPROVED' } }, { operational: { state: 'APPROVED', revision: r.revision } });
    return 'STARTED' as const;
  });
  if (phase === 'REPLAY') return { ...(await runDetail(db, grant, runId)), replayed: true };

  const actor = actorOf(grant);
  let chunks = 0;
  for (;;) {
    if (opts.maxChunks !== undefined && chunks >= opts.maxChunks) break;
    if (chunks > 0 && Date.now() - began > budget) break;
    const step = await withTransaction(db, async (tx) => {
      const r = await lockRun(tx, grant.companyId, runId);
      if (r.state !== 'APPROVED' || !r.processing_started_at) return 'STOP' as const;
      // Each chunk freezes records and places holds in its own transaction: the authority is checked in every one.
      await reassertRun(tx, grant, 'process');
      const records = (
        await tx.query<{ id: string; employee_id: string; payable: boolean }>(
          `select id, employee_id, (calculation_status = 'CALCULATED' and net > 0) as payable from payroll_record
            where company_id = $1 and run_id = $2 and frozen_at is null order by employee_id limit $3`,
          [grant.companyId, runId, chunkSize],
        )
      ).rows;
      if (records.length === 0) return 'DONE' as const;
      const done = await processChunk(tx, actor, grant.businessDate, runId, records);
      const last = await lastChunk(tx, grant.companyId, runId, 'PROCESS');
      await tx.query(
        `insert into payroll_run_chunk (company_id, run_id, phase, sequence, first_employee_id, last_employee_id, records, bank_verified, bank_missing, bank_invalid,
                                        bank_unverified, bank_not_required, safety_blocks, stop_holds, applied_stops, consumed_inputs, created_by)
         values ($1, $2, 'PROCESS', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          grant.companyId,
          runId,
          (last?.sequence ?? 0) + 1,
          records[0]!.employee_id,
          records[records.length - 1]!.employee_id,
          records.length,
          done.bank.VERIFIED,
          done.bank.MISSING,
          done.bank.INVALID,
          done.bank.UNVERIFIED,
          done.bank.NOT_REQUIRED,
          done.safetyBlocks,
          done.stopHolds,
          done.appliedStops,
          done.consumedInputs,
          grant.userId,
        ],
      );
      // CI25: each chunk's freeze commits with its audit entry.
      await audit(tx, actor, 'payroll_run', runId, 'PROCESS_CHUNK', null, {
        operational: { revision: r.revision, sequence: (last?.sequence ?? 0) + 1, records: records.length, bankStatus: done.bank, safetyBlocks: done.safetyBlocks, salaryStopHolds: done.stopHolds },
      });
      return records.length < chunkSize ? ('DONE' as const) : ('MORE' as const);
    });
    if (step === 'STOP') break;
    chunks++;
    if (step === 'DONE') break;
  }

  const finished = await withTransaction(db, async (tx) => {
    const r = await lockRun(tx, grant.companyId, runId);
    if (r.state === 'PROCESSED_LOCKED') return 'ALREADY' as const;
    if (r.state !== 'APPROVED' || !r.processing_started_at) throw new HttpError(409, 'INVALID_STATE', 'This revision is not being processed');
    const unfrozen = await tx.query(`select 1 from payroll_record where company_id = $1 and run_id = $2 and frozen_at is null limit 1`, [grant.companyId, runId]);
    if ((unfrozen.rowCount ?? 0) > 0) return 'INCOMPLETE' as const;
    await reassertRun(tx, grant, 'process');
    await setRootState(tx, 'payroll_run', grant.companyId, r, 'PROCESSED_LOCKED', grant.userId, ', processed_at = now(), lock_version = 1');
    const p = await chunkSums(tx, grant.companyId, runId, 'PROCESS');
    const totals = await runTotals(tx, grant.companyId, runId);
    await audit(tx, actor, 'payroll_run', runId, 'PROCESS', { operational: { state: 'APPROVED' } }, {
      operational: {
        state: 'PROCESSED_LOCKED',
        revision: r.revision,
        lockVersion: 1,
        startedBy: r.processed_by,
        records: p.records,
        chunks: p.chunks,
        bankStatus: { VERIFIED: p.bank_verified, MISSING: p.bank_missing, INVALID: p.bank_invalid, UNVERIFIED: p.bank_unverified, NOT_REQUIRED: p.bank_not_required },
        safetyBlocks: p.safety_blocks,
        salaryStopHolds: p.stop_holds,
        appliedSalaryStops: p.applied_stops,
        consumedInputs: p.consumed_inputs,
      },
      amount: { totals },
    });
    await emit(tx, grant.companyId, 'payroll_run.processed', runId, runId, { runId, revision: r.revision });
    return 'LOCKED' as const;
  });
  return { ...(await runDetail(db, grant, runId)), replayed: finished === 'ALREADY' };
}

/**
 * Cancels a revision before processing (authority and a reason) and releases its members in bounded chunks. Calling
 * it again on a cancelled run finishes releasing members a previous call left (idempotent).
 */
export async function cancelRun(db: Database, grant: AccessGrant, runId: string, input: { reason: string; expectedVersion: number }) {
  const lineage = await withTransaction(db, async (tx) => {
    const r = await lockRun(tx, grant.companyId, runId);
    await reassertRun(tx, grant, 'cancel');
    if (r.state === 'PROCESSED_LOCKED') throw new HttpError(409, 'RUN_LOCKED', 'A processed run cannot be cancelled; corrections are linked adjustments in a later run');
    if (r.processing_started_at) throw new HttpError(409, 'PROCESSING_STARTED', 'Processing has started; the revision can only be completed');
    await requireRunScope(tx, grant, runId);
    if (r.state === 'CANCELLED') return r.lineage_id;
    if (r.version !== input.expectedVersion) stale();
    if (!LIVE_STATES.includes(r.state)) throw new HttpError(409, 'INVALID_STATE', 'This revision is already closed');
    const reason = requireText(input.reason, 'reason', 1000);
    for (const t of (await tx.query<{ id: string; transaction_id: string; table: 'payroll_run_approval' | 'payroll_record_cover' }>(
      `select id, transaction_id, 'payroll_run_approval' as table from payroll_run_approval where company_id = $1 and run_id = $2 and state = 'SUBMITTED'
       union all
       select id, transaction_id, 'payroll_record_cover' from payroll_record_cover where company_id = $1 and run_id = $2 and state = 'SUBMITTED'`,
      [grant.companyId, runId],
    )).rows) {
      await cancelActiveApproval(tx, grant.companyId, t.transaction_id, grant.userId);
      await setRootState(tx, t.table, grant.companyId, t, 'CANCELLED', grant.userId, ', closed_at = now()');
    }
    await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
    await setRootState(tx, 'payroll_run', grant.companyId, r, 'CANCELLED', grant.userId, ', closed_at = now(), close_reason = $5', [reason]);
    await audit(tx, actorOf(grant), 'payroll_run', runId, 'CANCEL', { operational: { state: r.state } }, { operational: { state: 'CANCELLED', revision: r.revision } }, reason);
    return r.lineage_id;
  });
  for (;;) {
    const released =
      (
        await db.query(
          `update payroll_run_member set live = false, updated_by = $3
            where company_id = $1 and id in (select id from payroll_run_member where company_id = $1 and lineage_id = $2 and live limit $4)`,
          [grant.companyId, lineage, grant.userId, RELEASE_CHUNK],
        )
      ).rowCount ?? 0;
    if (released < RELEASE_CHUNK) break;
  }
  return runDetail(db, grant, runId);
}

// ---------------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------------

async function exceptionCounts(db: Queryable, companyId: string, runId: string) {
  return (
    await db.query<{ blocking: number; unresolved: number; warnings: number }>(
      `select count(*) filter (where severity = 'BLOCKING')::int as blocking, count(*) filter (where severity = 'BLOCKING' and resolved_at is null)::int as unresolved,
              count(*) filter (where severity = 'WARNING')::int as warnings
         from payroll_exception where company_id = $1 and run_id = $2`,
      [companyId, runId],
    )
  ).rows[0]!;
}

/** Whole-run money totals from the calculation chunks' component totals (sums of rounded lines). */
async function runTotals(db: Queryable, companyId: string, runId: string) {
  const r = (
    await db.query<{ currencyCode: string; records: number; paidUnits: string; earnings: string; reimbursements: string; deductions: string; employerContributions: string }>(
      `select ru.currency_code as "currencyCode",
              (select coalesce(sum(calculated), 0)::int from payroll_run_chunk c where c.company_id = ru.company_id and c.run_id = ru.id and c.phase = 'CALCULATE') as records,
              (select coalesce(sum(paid_units), 0) from payroll_run_chunk c where c.company_id = ru.company_id and c.run_id = ru.id and c.phase = 'CALCULATE') as "paidUnits",
              coalesce(sum(t.amount) filter (where t.head_type = 'EARNING'), 0) as earnings,
              coalesce(sum(t.amount) filter (where t.head_type = 'REIMBURSEMENT'), 0) as reimbursements,
              coalesce(sum(t.amount) filter (where t.head_type = 'DEDUCTION'), 0) as deductions,
              coalesce(sum(t.amount) filter (where t.head_type = 'EMPLOYER_CONTRIBUTION'), 0) as "employerContributions"
         from payroll_run ru left join payroll_run_chunk_total t on t.company_id = ru.company_id and t.run_id = ru.id
        where ru.company_id = $1 and ru.id = $2 group by ru.company_id, ru.id, ru.currency_code`,
      [companyId, runId],
    )
  ).rows[0]!;
  if (r.records === 0) return [];
  const sums = (
    await db.query<{ gross: string; net: string }>(`select $1::numeric + $2::numeric as gross, $1::numeric + $2::numeric - $3::numeric as net`, [r.earnings, r.reimbursements, r.deductions])
  ).rows[0]!;
  return [{ ...r, gross: sums.gross, net: sums.net }];
}

/** Totals of the calculated records within a partial row scope (computed from those records only). */
async function scopedTotals(db: Queryable, grant: AccessGrant, runId: string) {
  const params = new SqlParams([grant.companyId, runId]);
  const scope = employeeScopePredicate(grant, { company: 'rec.company_id', employee: 'rec.employee_id' }, params);
  return (
    await db.query(
      `select rec.currency_code as "currencyCode", count(*)::int as records, sum(rec.paid_units) as "paidUnits", sum(rec.earnings) as earnings,
              sum(rec.reimbursements) as reimbursements, sum(rec.gross) as gross, sum(rec.deductions) as deductions, sum(rec.net) as net,
              sum(rec.employer_contributions) as "employerContributions"
         from payroll_record rec where rec.company_id = $1 and rec.run_id = $2 and rec.calculation_status = 'CALCULATED' and ${scope}
        group by rec.currency_code order by 1`,
      params.values,
    )
  ).rows;
}

interface DetailRow extends RunRow {
  period_code: string;
  financial_year: string;
  calendar_code: string;
  submitted_at: Date | null;
  reviewed_at: Date | null;
  approved_at: Date | null;
  processed_at: Date | null;
  lock_version: number | null;
  closed_at: Date | null;
  close_reason: string | null;
  created_at: Date;
  successor_id: string | null;
  excluded: number;
}

export async function runDetail(db: Queryable, grant: AccessGrant, runId: string) {
  const r = (
    await db.query<DetailRow>(
      `select ${RUN_COLUMNS}, p.period_code, p.financial_year, k.code as calendar_code, r.submitted_at, r.reviewed_at, r.approved_at, r.processed_at,
              r.lock_version, r.closed_at, r.close_reason, r.created_at,
              (select n.id from payroll_run n where n.company_id = r.company_id and n.supersedes_run_id = r.id) as successor_id,
              (select count(*)::int from payroll_run_member m where m.company_id = r.company_id and m.lineage_id = r.lineage_id
                  and m.excluded_from_revision is not null and m.excluded_from_revision <= r.revision) as excluded
         from payroll_run r
         join payroll_period p on p.company_id = r.company_id and p.id = r.period_id
         join payroll_calendar k on k.company_id = r.company_id and k.id = r.calendar_id
        where r.company_id = $1 and r.id = $2`,
      [grant.companyId, runId],
    )
  ).rows[0];
  if (!r) throw notFound();
  const calc = await chunkSums(db, grant.companyId, runId, 'CALCULATE');
  const proc = await chunkSums(db, grant.companyId, runId, 'PROCESS');
  const exceptions = await exceptionCounts(db, grant.companyId, runId);
  const stage = (await db.query<{ transaction_id: string; state: string }>(`select transaction_id, state from payroll_run_approval where company_id = $1 and run_id = $2`, [grant.companyId, runId]))
    .rows[0];
  const covers = (
    await db.query<{ transaction_id: string; state: string; employee_id: string; covered_role: string }>(
      `select transaction_id, state, employee_id, covered_role from payroll_record_cover where company_id = $1 and run_id = $2 order by created_at`,
      [grant.companyId, runId],
    )
  ).rows;
  const showAmounts = holds(grant, 'amount');
  const outside = showAmounts ? await runMembersOutsideScope(db, grant, runId) : 0;
  const recordCount = calc.records;
  return {
    id: r.id,
    lineageId: r.lineage_id,
    revision: r.revision,
    supersedesRunId: r.supersedes_run_id,
    successorRunId: r.successor_id,
    state: r.state,
    calendarCode: r.calendar_code,
    period: {
      id: r.period_id,
      periodCode: r.period_code,
      financialYear: r.financial_year,
      serviceStart: r.service_start,
      serviceEnd: r.service_end,
      inputCutoff: r.input_cutoff,
      paymentDate: r.payment_date,
      daysInMonth: r.days_in_month,
    },
    currencyCode: r.currency_code,
    currencyMinorUnit: r.currency_minor_unit,
    scope: { departmentIds: r.scope_department_ids, gradeIds: r.scope_grade_ids, locationIds: r.scope_location_ids, scopeToken: r.scope_token },
    members: { included: r.member_count, excluded: r.excluded },
    snapshot: { paidDayPolicyId: r.paid_day_policy_id, attendanceBasis: r.attendance_basis, calculationStartedAt: r.calculation_started_at, calendarAsOf: r.calendar_as_of, calculatedAt: r.calculated_at },
    progress: {
      calculation: { started: r.calculation_started_at !== null, members: r.member_count, calculated: recordCount, chunks: calc.chunks, complete: r.calculated_at !== null },
      processing: { started: r.processing_started_at !== null, records: recordCount, frozen: proc.records, chunks: proc.chunks, complete: r.processed_at !== null },
    },
    records: Object.fromEntries(Object.entries(counts(calc)).filter(([, n]) => n > 0)),
    exceptions,
    createdBy: r.created_by,
    preparedBy: r.calculated_by,
    submittedAt: r.submitted_at,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    approvedBy: r.approved_by,
    approvedAt: r.approved_at,
    approvalStage: stage ? { state: stage.state } : null,
    covers: covers.map((c) => ({ employeeId: c.employee_id, coveredRole: c.covered_role, state: c.state })),
    processingStartedAt: r.processing_started_at,
    processedAt: r.processed_at,
    processedBy: r.processed_by,
    lockVersion: r.lock_version,
    closedAt: r.closed_at,
    // Payment state is not part of the calculation lock (H2): it comes from the payment ledger, never from here.
    paymentStatus: 'NOT_TRACKED_HERE',
    decisions: await decisionTrail(db, grant.companyId, [r.transaction_id, ...(stage ? [stage.transaction_id] : []), ...covers.map((c) => c.transaction_id)]),
    ...(showAmounts
      ? {
          closeReason: r.close_reason,
          scopeComplete: outside === 0,
          totals: outside === 0 ? await runTotals(db, grant.companyId, runId) : await scopedTotals(db, grant, runId),
        }
      : {}),
    createdAt: r.created_at,
    version: r.version,
  };
}

/**
 * FR-033 component totals with the prior period. With a scope covering the whole run and those prior runs: the run's
 * totals against the processed runs of the same calendar and filters for the latest earlier period. Otherwise (C4: a
 * prior total is a read too, judged on the current effective assignment, and last month's members may not be this
 * month's): the records in scope, never the caller's own, against the same employees' latest earlier processed records.
 */
export async function runComponents(db: Queryable, grant: AccessGrant, runId: string) {
  const r = await readRun(db, grant.companyId, runId);
  if (!r) throw notFound();
  if ((await runMembersOutsideScope(db, grant, runId)) === 0) {
    const prior = (
      await db.query<{ id: string; period_code: string }>(
        `select pr.id, p.period_code from payroll_run pr join payroll_period p on p.company_id = pr.company_id and p.id = pr.period_id
          where pr.company_id = $1 and pr.calendar_id = $2 and pr.state = 'PROCESSED_LOCKED'
            and pr.scope_department_ids = $3::uuid[] and pr.scope_grade_ids = $4::uuid[] and pr.scope_location_ids = $5::uuid[]
            and pr.service_start = (select max(x.service_start) from payroll_run x
                                     where x.company_id = $1 and x.calendar_id = $2 and x.state = 'PROCESSED_LOCKED' and x.service_start < $6::date
                                       and x.scope_department_ids = $3::uuid[] and x.scope_grade_ids = $4::uuid[] and x.scope_location_ids = $5::uuid[])`,
        [grant.companyId, r.calendar_id, r.scope_department_ids, r.scope_grade_ids, r.scope_location_ids, r.service_start],
      )
    ).rows;
    let priorInScope = true;
    for (const p of prior) {
      if ((await runMembersOutsideScope(db, grant, p.id)) > 0) {
        priorInScope = false;
        break;
      }
    }
    if (priorInScope) {
      const items = (
        await db.query(
          `with cur as (select component_id, head_type, sum(amount) as total from payroll_run_chunk_total where company_id = $1 and run_id = $2 group by 1, 2),
                prior as (select component_id, head_type, sum(amount) as total from payroll_run_chunk_total where company_id = $1 and run_id = any($3::uuid[]) group by 1, 2)
           select pc.code as "componentCode", coalesce(c.head_type, p.head_type) as "headType", coalesce(c.total, 0) as current, coalesce(p.total, 0) as prior,
                  coalesce(c.total, 0) - coalesce(p.total, 0) as difference
             from cur c full join prior p on p.component_id = c.component_id and p.head_type = c.head_type
             join pay_component pc on pc.company_id = $1 and pc.id = coalesce(c.component_id, p.component_id)
            order by 2, 1`,
          [grant.companyId, runId, prior.map((x) => x.id)],
        )
      ).rows;
      return { runId, basis: 'RUN', priorPeriodCode: prior[0]?.period_code ?? null, priorRunIds: prior.map((x) => x.id), items };
    }
  }
  const params = new SqlParams([grant.companyId, runId, r.service_start, grant.linkedEmployeeId]);
  const scope = employeeScopePredicate(grant, { company: 'rec.company_id', employee: 'rec.employee_id' }, params);
  const items = (
    await db.query(
      `with cur as (
         select rec.employee_id, l.component_id, l.head_type, l.amount from payroll_record rec
           join payroll_line l on l.company_id = rec.company_id and l.record_id = rec.id
          where rec.company_id = $1 and rec.run_id = $2 and rec.calculation_status = 'CALCULATED' and ${scope} and rec.employee_id is distinct from $4::uuid
       ), emps as (select distinct employee_id from cur),
       prior_rec as (
         select distinct on (pr.employee_id) pr.id, pr.employee_id from payroll_record pr
           join payroll_run pru on pru.company_id = pr.company_id and pru.id = pr.run_id and pru.state = 'PROCESSED_LOCKED' and pru.service_start < $3::date
          where pr.company_id = $1 and pr.calculation_status = 'CALCULATED' and pr.employee_id in (select employee_id from emps)
          order by pr.employee_id, pru.service_start desc
       ), prior as (
         select l.component_id, l.head_type, l.amount from prior_rec p join payroll_line l on l.company_id = $1 and l.record_id = p.id
       )
       select pc.code as "componentCode", coalesce(c.head_type, p.head_type) as "headType", coalesce(c.total, 0) as current, coalesce(p.total, 0) as prior,
              coalesce(c.total, 0) - coalesce(p.total, 0) as difference
         from (select component_id, head_type, sum(amount) as total from cur group by 1, 2) c
         full join (select component_id, head_type, sum(amount) as total from prior group by 1, 2) p on p.component_id = c.component_id and p.head_type = c.head_type
         join pay_component pc on pc.company_id = $1 and pc.id = coalesce(c.component_id, p.component_id)
        order by 2, 1`,
      params.values,
    )
  ).rows;
  return { runId, basis: 'SCOPE', priorPeriodCode: null, priorRunIds: [], items };
}

/** Runs answered without page/pageSize (the list's first answer before it could page). */
export const RUN_LIST_CAP = 200;

/** Runs, latest service period first: one page (FR-056), or the first 200 without page/pageSize; `total` counts every match. */
export async function listRuns(
  db: Queryable,
  grant: AccessGrant,
  q: { periodId?: string | undefined; state?: string | undefined; states?: string | undefined; coversDate?: string | undefined } & Paging,
) {
  // `states` (comma separated) and `coversDate` (runs of an active calendar's period that covers the date) are the
  // dashboard widgets' filters (payroll/metrics.ts): the same state sets and "current period".
  return pageOf(
    db,
    `select r.id, r.lineage_id as "lineageId", r.revision, r.state, p.period_code as "periodCode", r.period_id as "periodId", k.code as "calendarCode",
            r.member_count as "memberCount",
            (select count(*)::int from payroll_exception x where x.company_id = r.company_id and x.run_id = r.id and x.severity = 'BLOCKING' and x.resolved_at is null) as "unresolvedExceptions",
            r.created_at as "createdAt", r.processed_at as "processedAt", r.version, p.service_start as hrms_service_start
       from payroll_run r
       join payroll_period p on p.company_id = r.company_id and p.id = r.period_id
       join payroll_calendar k on k.company_id = r.company_id and k.id = r.calendar_id
      where r.company_id = $1 and ($2::uuid is null or r.period_id = $2) and ($3::text is null or r.state = $3)
        and ($4::text[] is null or r.state = any($4))
        and ($5::date is null or (k.state = 'ACTIVE' and p.service_start <= $5 and p.service_end >= $5))`,
    [grant.companyId, q.periodId ?? null, q.state ?? null, q.states ? q.states.split(',') : null, q.coversDate ?? null],
    'hrms_service_start desc, "lineageId", revision desc, id',
    q,
    RUN_LIST_CAP,
  );
}

/**
 * F2 "Open payroll periods" (payroll/metrics.ts counts the same): periods of an active calendar whose service month has
 * started and that have no processed (locked) run yet. Company records with operational fields only, as the calendar list shows.
 */
export const OPEN_PERIOD_FROM = `from payroll_period p join payroll_calendar k on k.company_id = p.company_id and k.id = p.calendar_id and k.state = 'ACTIVE'`;
export const openPeriodCondition = (company: string, day: string) =>
  `p.company_id = ${company}::uuid and p.service_start <= ${day}::date
          and not exists (select 1 from payroll_run r where r.company_id = p.company_id and r.period_id = p.id and r.state = 'PROCESSED_LOCKED')`;

export async function listOpenPeriods(db: Queryable, grant: AccessGrant, q: Paging) {
  return pageOf(
    db,
    `select p.id, p.period_code as "periodCode", k.code as "calendarCode", to_char(p.service_start, 'YYYY-MM-DD') as "serviceStart", to_char(p.service_end, 'YYYY-MM-DD') as "serviceEnd"
       ${OPEN_PERIOD_FROM} where ${openPeriodCondition('$1', '$2')}`,
    [grant.companyId, grant.businessDate],
    '"serviceStart" desc, "calendarCode", id',
    q,
    RUN_LIST_CAP,
  );
}

const EXCEPTIONS_JSON = `coalesce((select json_agg(json_build_object('id', x.id, 'code', x.code, 'severity', x.severity, 'resolvable', x.resolvable, 'detail', x.detail,
                                                 'resolvedAt', x.resolved_at, 'resolvedBy', x.resolved_by) order by x.severity, x.code)
              from payroll_exception x where x.company_id = rec.company_id and x.record_id = rec.id), '[]'::json)`;

/**
 * Records within the caller's row scope (amount grant), a page at a time in employee-code order (continue with
 * `after`); the caller's own record is never shown in this context.
 */
export async function runRecords(
  db: Queryable,
  grant: AccessGrant,
  runId: string,
  q: { status?: string | undefined; exceptions?: boolean | undefined; after?: string | undefined; limit?: number | undefined },
) {
  const run = (await db.query<{ service_start: string }>(`select service_start from payroll_run where company_id = $1 and id = $2`, [grant.companyId, runId])).rows[0];
  if (!run) throw notFound();
  const limit = Math.min(Math.max(q.limit ?? SAMPLE, 1), MAX_PAGE);
  const params = new SqlParams([grant.companyId, runId, q.status ?? null, run.service_start, grant.linkedEmployeeId, q.after ?? null, q.exceptions === true, limit]);
  const scope = employeeScopePredicate(grant, { company: 'rec.company_id', employee: 'rec.employee_id' }, params);
  const rows = await db.query<{ employeeCode: string }>(
    `select rec.id, rec.employee_id as "employeeId", rec.employee_code as "employeeCode", e.display_name as "employeeName", rec.calculation_status as "calculationStatus",
            rec.eligible_from as "eligibleFrom", rec.eligible_to as "eligibleTo", rec.eligible_days as "eligibleDays", rec.days_in_month as "daysInMonth",
            rec.paid_units as "paidUnits", rec.currency_code as "currencyCode", rec.earnings, rec.reimbursements, rec.gross, rec.deductions, rec.net,
            rec.employer_contributions as "employerContributions", rec.salary_stop_mode as "salaryStopMode", rec.bank_status as "bankStatus", rec.frozen_at as "frozenAt",
            (select pr.net from payroll_record pr join payroll_run pru on pru.company_id = pr.company_id and pru.id = pr.run_id and pru.state = 'PROCESSED_LOCKED'
                                                                     and pru.service_start < $4::date
              where pr.company_id = rec.company_id and pr.employee_id = rec.employee_id and pr.calculation_status = 'CALCULATED'
              order by pru.service_start desc limit 1) as "priorNet",
            ${EXCEPTIONS_JSON} as exceptions
       from payroll_record rec join employee e on e.company_id = rec.company_id and e.id = rec.employee_id
      where rec.company_id = $1 and rec.run_id = $2 and ($3::text is null or rec.calculation_status = $3) and ${scope}
        and rec.employee_id is distinct from $5::uuid and ($6::text is null or rec.employee_code > $6::text)
        and (not $7::boolean or exists (select 1 from payroll_exception x where x.company_id = rec.company_id and x.record_id = rec.id))
      order by rec.employee_code limit $8`,
    params.values,
  );
  const items = rows.rows;
  return { items, nextAfter: items.length === limit ? items[items.length - 1]!.employeeCode : null };
}

export async function recordDetail(db: Queryable, grant: AccessGrant, runId: string, employeeId: string) {
  const rec = (
    await db.query<{ id: string }>(`select id from payroll_record where company_id = $1 and run_id = $2 and employee_id = $3`, [grant.companyId, runId, employeeId])
  ).rows[0];
  if (!rec) throw notFound();
  await assertInScope(db, grant, employeeId);
  assertNotSelf(grant, employeeId);
  const head = (
    await db.query(
      `select rec.id, rec.run_id as "runId", rec.employee_id as "employeeId", rec.employee_code as "employeeCode", rec.joining_date as "joiningDate",
              rec.leaving_date as "leavingDate", rec.status_code as "statusCode", rec.eligible_from as "eligibleFrom", rec.eligible_to as "eligibleTo",
              rec.eligible_days as "eligibleDays", rec.days_in_month as "daysInMonth", rec.paid_units as "paidUnits", rec.calculation_status as "calculationStatus",
              rec.salary_arrangement_id as "salaryArrangementId", rec.currency_code as "currencyCode", rec.earnings, rec.reimbursements, rec.gross, rec.deductions,
              rec.net, rec.employer_contributions as "employerContributions", rec.salary_stop_id as "salaryStopId", rec.salary_stop_mode as "salaryStopMode",
              rec.bank_status as "bankStatus", rec.bank_revision_id as "bankRevisionId", rec.frozen_at as "frozenAt", ${EXCEPTIONS_JSON} as exceptions
         from payroll_record rec where rec.company_id = $1 and rec.id = $2`,
      [grant.companyId, rec.id],
    )
  ).rows[0]!;
  const segments = (
    await db.query(
      `select s.salary_arrangement_id as "salaryArrangementId", s.segment_start as "segmentStart", s.segment_end as "segmentEnd", s.calendar_days as "calendarDays",
              s.leave_lop_units as "leaveLopUnits", s.attendance_lop_units as "attendanceLopUnits", s.paid_days as "paidDays",
              coalesce((select json_agg(json_build_object('componentCode', pc.code, 'amount', c.amount, 'amountBasis', c.amount_basis, 'headType', c.head_type,
                                                          'calculationBasis', c.calculation_basis, 'headRevisionId', c.head_revision_id) order by pc.code)
                          from payroll_record_component c join pay_component pc on pc.company_id = c.company_id and pc.id = c.component_id
                         where c.company_id = s.company_id and c.segment_id = s.id), '[]'::json) as components
         from payroll_record_segment s where s.company_id = $1 and s.record_id = $2 order by s.segment_start`,
      [grant.companyId, rec.id],
    )
  ).rows;
  const lossOfPay = (
    await db.query(
      `select day, source_kind as "sourceKind", leave_request_id as "leaveRequestId", attendance_record_id as "attendanceRecordId", units
         from payroll_record_lop where company_id = $1 and record_id = $2 order by day`,
      [grant.companyId, rec.id],
    )
  ).rows;
  const inputs = (
    await db.query(
      `select i.input_id as "inputId", pc.code as "componentCode", i.amount, i.currency_code as "currencyCode", i.head_type as "headType", src.reference
         from payroll_record_input i join pay_component pc on pc.company_id = i.company_id and pc.id = i.component_id
         join payroll_input src on src.company_id = i.company_id and src.id = i.input_id
        where i.company_id = $1 and i.record_id = $2 order by pc.code, src.reference`,
      [grant.companyId, rec.id],
    )
  ).rows;
  const lines = (
    await db.query(
      `select pc.code as "componentCode", pc.name as "componentName", l.head_type as "headType", l.calculation_basis as "calculationBasis", l.amount,
              l.rule_version as "ruleVersion", h.display_sequence as "displaySequence"
         from payroll_line l join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id
         join payroll_head_revision h on h.company_id = l.company_id and h.id = l.head_revision_id
        where l.company_id = $1 and l.record_id = $2 order by h.display_sequence, pc.code`,
      [grant.companyId, rec.id],
    )
  ).rows;
  return { ...head, segments, lossOfPay, inputs, lines };
}

/** The caller's open run tasks (review, approval, covering approval) with operational run facts. */
export async function runTasks(db: Queryable, grant: AccessGrant) {
  const tasks = [
    ...((await myOpenTasks(db, grant, RUN_KIND)).items as { taskId: string; transactionId: string; kind: string }[]),
    ...((await myOpenTasks(db, grant, APPROVAL_KIND)).items as { taskId: string; transactionId: string; kind: string }[]),
    ...((await myOpenTasks(db, grant, COVER_KIND)).items as { taskId: string; transactionId: string; kind: string }[]),
  ];
  const items = [];
  for (const t of tasks) {
    const run = (
      await db.query<{ id: string; revision: number; state: string; period_code: string; covered: string | null }>(
        `select r.id, r.revision, r.state, p.period_code,
                (select c.employee_id from payroll_record_cover c where c.company_id = r.company_id and c.transaction_id = $2) as covered
           from payroll_run r join payroll_period p on p.company_id = r.company_id and p.id = r.period_id
          where r.company_id = $1 and (r.transaction_id = $2
                 or r.id = (select a.run_id from payroll_run_approval a where a.company_id = $1 and a.transaction_id = $2)
                 or r.id = (select c.run_id from payroll_record_cover c where c.company_id = $1 and c.transaction_id = $2))`,
        [grant.companyId, t.transactionId],
      )
    ).rows[0];
    const step = t.kind === RUN_KIND ? 'REVIEW' : t.kind === APPROVAL_KIND ? 'APPROVAL' : 'COVER';
    items.push({ taskId: t.taskId, step, run: run ? { id: run.id, revision: run.revision, state: run.state, periodCode: run.period_code, coveredEmployeeId: run.covered } : null });
  }
  return { items };
}
