// Late-timesheet adjustment cases, held pending (FR-100; DB111; H2 late-timesheet journey; H4; BR-047; BR-048; CI25; CI26;
// ZT37). Migration 0129. An authorised person opens a case for an approved timesheet revision that came after the freeze of a
// processed payroll covering its dates, and an independent reviewer returns or rejects it. Approval is refused: BR-048 values
// a correction under "the current applicable adjustment valuation policy", none exists, and H2 says an unresolved policy "blocks
// adjustment approval, not a guessed deduction". So no case is approved, nothing is valued, no target run is chosen and no
// payroll line is written. Units and the signed difference are optional entries by a person on the draft, never computed.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { actorOf, advisoryLock, assertInScope, assertNotSelf, audit, emit, newTransaction, priorDecision, requireText, taskIsPending, taskTransaction, unrestricted, userIsEmployee } from '../payroll/common.js';
import { ownEmployee } from '../payroll-outputs/payslips.js';
import { decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';

export const ADJUSTMENT_KIND = 'timesheet_adjustment';
const LIST_CAP = 200;
const LIVE = ['DRAFT', 'SUBMITTED', 'APPROVED', 'APPLIED'];

/** The named state every list answers and every approval is refused with (H2, H8). */
export const VALUATION = {
  status: 'NOT_CONFIGURED',
  code: 'ADJUSTMENT_VALUATION_POLICY_NOT_CONFIGURED',
  message: 'Cases are recorded and held. Approval, valuation and application to a later payroll wait for an activated adjustment valuation policy; nothing here changes a processed payroll.',
} as const;

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
  return { ...page, valuation: VALUATION };
}

export async function adjustmentDetail(db: Queryable, grant: AccessGrant, id: string) {
  const a = (await db.query<{ employeeId: string }>(`${VIEW} where a.company_id = $1 and a.id = $2`, [grant.companyId, id])).rows[0];
  if (!a) throw notFound();
  await assertInScope(db, grant, a.employeeId);
  await assertNotOwn(db, grant, a.employeeId);
  return { ...a, valuation: VALUATION };
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
  const transactionId = await newTransaction(tx, grant.companyId, ADJUSTMENT_KIND, source.employee_id, 'DRAFT', grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_adjustment (company_id, employee_id, source_timesheet_id, source_revision, origin_payroll_record_id, origin_run_id, transaction_id, adjustment_kind,
                                       previous_recognized_units, corrected_units, delta_amount, currency_code, rule_snapshot, explanation, follows_adjustment_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::numeric, $10::numeric, $11::numeric, $12, $13, $14, $15, $16, $16) returning id`,
      [
        grant.companyId,
        source.employee_id,
        input.timesheetId,
        input.revision,
        input.originRecordId,
        origin.run_id,
        transactionId,
        kind,
        f.previous,
        f.corrected,
        f.delta,
        origin.currency_code,
        // DB111 rule_snapshot: the frozen snapshot the origin was calculated under, by reference. BR-048's valuation policy has none yet.
        {
          originRunId: origin.run_id,
          originRunRevision: origin.run_revision,
          periodId: origin.period_id,
          periodCode: origin.period_code,
          calendarId: origin.calendar_id,
          paidDayPolicyId: origin.paid_day_policy_id,
          attendanceBasis: origin.attendance_basis,
          headCount: origin.head_count,
          valuationPolicy: null,
        },
        f.explanation,
        prior[0]?.id ?? null,
        grant.userId,
      ],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_adjustment', id, 'CREATE', null, {
    operational: { timesheetId: input.timesheetId, revision: input.revision, originRecordId: input.originRecordId, adjustmentKind: kind, state: 'DRAFT' },
    amount: { previousRecognizedUnits: f.previous, correctedUnits: f.corrected, deltaAmount: f.delta },
  });
  return adjustmentDetail(tx, grant, id);
}

interface Row {
  id: string;
  employee_id: string;
  transaction_id: string;
  source_timesheet_id: string;
  source_revision: number;
  currency_code: string;
  explanation: string | null;
  state: string;
  created_by: string | null;
  version: number;
  minor: number;
}

const ROW = `select a.id, a.employee_id, a.transaction_id, a.source_timesheet_id, a.source_revision, a.currency_code, a.explanation, a.state, a.created_by, a.version,
  (select ru.currency_minor_unit from payroll_run ru where ru.company_id = a.company_id and ru.id = a.origin_run_id) as minor from payroll_adjustment a`;

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
  await tx.query(
    `update payroll_adjustment set previous_recognized_units = $3::numeric, corrected_units = $4::numeric, delta_amount = $5::numeric, explanation = $6, updated_by = $7 where company_id = $1 and id = $2`,
    [grant.companyId, id, f.previous, f.corrected, f.delta, f.explanation, grant.userId],
  );
  await audit(tx, actorOf(grant), 'payroll_adjustment', id, 'UPDATE', { operational: { state: 'DRAFT' } }, {
    operational: { state: 'DRAFT' },
    amount: { previousRecognizedUnits: f.previous, correctedUnits: f.corrected, deltaAmount: f.delta },
  });
  return adjustmentDetail(tx, grant, id);
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
  return { items, valuation: VALUATION };
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
  // H2 "An unresolved policy/rate/currency question blocks adjustment approval": the task stays open and nothing is recorded.
  if (input.decision === 'APPROVE') throw new HttpError(409, 'NOT_CONFIGURED', VALUATION.message, { code: VALUATION.code, needs: ['activated adjustment valuation policy (BR-048)'] });
  const reason = requireText(input.reason, 'reason', 1000);
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'payroll_adjustment', action: 'decide' } });
  if (result.replayed) return { adjustmentId: a.id, state: a.state, replayed: true };
  const state = input.decision === 'REJECT' ? 'REJECTED' : 'RETURNED';
  await setState(tx, grant, a, state, ', decided_at = now(), decided_by = $4');
  await audit(tx, actorOf(grant), 'payroll_adjustment', a.id, state === 'REJECTED' ? 'REJECT' : 'RETURN', { operational: { state: 'SUBMITTED' } }, { operational: { state } }, reason);
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
  return { ...page, notice: 'These corrections are recorded and held. They do not change a processed payroll, and no amount has been decided.' };
}
