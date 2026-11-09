// Arrears cases and the arrear register (FR-035; DF05; DF15; H2; BR-047; CI25). Migrations 0130, 0205. An authorised person raises a
// retroactive difference: an approved salary revision a processed record was not calculated from, for that record's period. Decided
// under owner delegation, 6 Nov 2026 (docs/03 I-79): the amounts are calculated (computeArrears, DF05 as a month is paid), an
// independent person decides the case under an active valuation policy, and the first later payroll of the employee pays it once, on
// the policy's arrears component (or recovers a negative total on its deduction). Closed periods are never reopened; an arrear is paid
// and taxed in the month it is paid (any relief is the employee's claim under the tax rules in force). The employee/revision/period key
// is unique while a case is live or paid, so the same revision cannot be paid twice (FR-035).
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import { valuationPolicyOn } from '../payroll/calculate.js';
import { actorOf, advisoryLock, assertInScope, audit, emit, newTransaction, optionalKey, priorDecision, requireText, taskIsPending, taskTransaction, unrestricted } from '../payroll/common.js';
import { decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import { assertNotOwn, checkSigned } from './adjustments.js';

export const ARREARS_KIND = 'payroll_arrears_case';
const LIST_CAP = 200;

/** How the register's amounts come about (I-79). */
export const ARREARS_CALCULATION = {
  status: 'CALCULATED',
  code: 'ARREARS_CALCULATED',
  message:
    'Amounts are calculated from the processed record and the salary revision, as a month is paid (paid days over the days of the month). An independently approved case is paid once by the first later payroll, under the active valuation policy; closed months are never reopened.',
} as const;

const VIEW = `select c.id, c.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName",
    c.source_arrangement_id as "sourceRevisionId", to_char(sa.effective_from, 'YYYY-MM-DD') as "sourceEffectiveFrom",
    c.origin_payroll_record_id as "originRecordId", c.origin_run_id as "originRunId", ru.revision as "originRunRevision",
    p.period_code as "periodCode", p.financial_year as "financialYear", to_char(p.service_start, 'YYYY-MM-DD') as "serviceStart", to_char(p.service_end, 'YYYY-MM-DD') as "serviceEnd",
    c.currency_code as "currencyCode", c.reason, c.state, c.follows_case_id as "followsCaseId",
    coalesce((select json_agg(json_build_object('componentCode', pc.code, 'amount', l.amount::text) order by pc.code)
                from payroll_arrears_line l join pay_component pc on pc.company_id = l.company_id and pc.id = l.component_id
               where l.company_id = c.company_id and l.case_id = c.id), '[]'::json) as lines,
    (select sum(l.amount)::text from payroll_arrears_line l where l.company_id = c.company_id and l.case_id = c.id) as "totalEntered",
    c.created_by as "createdBy", c.created_at as "createdAt", c.decided_by as "decidedBy", c.decided_at as "decidedAt", c.version,
    c.applied_record_id as "appliedRecordId",
    (select ap.period_code from payroll_record ar join payroll_run au on au.company_id = ar.company_id and au.id = ar.run_id
       join payroll_period ap on ap.company_id = au.company_id and ap.id = au.period_id
      where ar.company_id = c.company_id and ar.id = c.applied_record_id) as "appliedPeriodCode",
    -- I-88 follow-up (0214): or the final settlement that paid it.
    c.applied_settlement_id as "appliedSettlementId"
  from payroll_arrears_case c
  join employee e on e.company_id = c.company_id and e.id = c.employee_id
  join salary_arrangement sa on sa.company_id = c.company_id and sa.id = c.source_arrangement_id
  join payroll_run ru on ru.company_id = c.company_id and ru.id = c.origin_run_id
  join payroll_period p on p.company_id = c.company_id and p.id = c.origin_period_id`;

function visible(grant: AccessGrant, params: SqlParams, company: string, employee: string): string[] {
  const where: string[] = [];
  if (!unrestricted(grant)) where.push(employeeScopePredicate(grant, { company, employee }, params));
  where.push(`not exists (select 1 from user_employee_link own where own.company_id = ${company} and own.employee_id = ${employee} and own.user_id = ${params.add(grant.userId)}::uuid)`);
  return where;
}

/** FR-035 arrear register: the source revision and period of each case, with component detail, newest first. */
export async function listArrears(db: Queryable, grant: AccessGrant, q: { state?: string | undefined; employeeId?: string | undefined } & Paging) {
  const params = new SqlParams([grant.companyId]);
  const where = ['c.company_id = $1', ...visible(grant, params, 'c.company_id', 'c.employee_id')];
  if (q.state) where.push(`c.state = ${params.add(q.state)}`);
  if (q.employeeId) where.push(`c.employee_id = ${params.add(q.employeeId)}::uuid`);
  const page = await pageOf(db, `${VIEW} where ${where.join(' and ')}`, params.values, '"createdAt" desc, id', q, LIST_CAP);
  return { ...page, calculation: ARREARS_CALCULATION };
}

export async function arrearsDetail(db: Queryable, grant: AccessGrant, id: string) {
  const c = (await db.query<{ employeeId: string }>(`${VIEW} where c.company_id = $1 and c.id = $2`, [grant.companyId, id])).rows[0];
  if (!c) throw notFound();
  await assertInScope(db, grant, c.employeeId);
  await assertNotOwn(db, grant, c.employeeId);
  return { ...c, calculation: ARREARS_CALCULATION };
}

/**
 * Salary revisions in force over a processed period whose record was not calculated from them (DF15 "retroactive difference")
 * and with no live case yet. A reading of the records only: no difference is computed and nothing is opened.
 */
export async function arrearsCandidates(db: Queryable, grant: AccessGrant, q: { employeeId?: string | undefined } & Paging) {
  const params = new SqlParams([grant.companyId]);
  const where = ['rec.company_id = $1', ...visible(grant, params, 'rec.company_id', 'rec.employee_id')];
  if (q.employeeId) where.push(`rec.employee_id = ${params.add(q.employeeId)}::uuid`);
  return pageOf(
    db,
    `select rec.employee_id as "employeeId", e.employee_code as "employeeCode", e.display_name as "employeeName", sa.id as "sourceRevisionId", to_char(sa.effective_from, 'YYYY-MM-DD') as "sourceEffectiveFrom",
            rec.id as "originRecordId", ru.id as "originRunId", ru.revision as "originRunRevision", p.period_code as "periodCode", ru.service_start as "hrms_start", rec.currency_code as "currencyCode"
       from payroll_record rec
       join employee e on e.company_id = rec.company_id and e.id = rec.employee_id
       join payroll_run ru on ru.company_id = rec.company_id and ru.id = rec.run_id and ru.state = 'PROCESSED_LOCKED'
       join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
       join salary_arrangement sa on sa.company_id = rec.company_id and sa.employee_id = rec.employee_id and sa.superseded_at is null and sa.currency_code = rec.currency_code
        and sa.effective_from <= ru.service_end and (sa.effective_to is null or sa.effective_to > ru.service_start)
      where rec.calculation_status = 'CALCULATED' and ${where.join(' and ')}
        and not exists (select 1 from payroll_record_segment s where s.company_id = rec.company_id and s.record_id = rec.id and s.salary_arrangement_id = sa.id)
        and not exists (select 1 from payroll_arrears_case c where c.company_id = rec.company_id and c.employee_id = rec.employee_id and c.source_arrangement_id = sa.id
                           and c.origin_period_id = ru.period_id and c.state in ('SUBMITTED', 'APPROVED', 'APPLIED'))`,
    params.values,
    '"hrms_start" desc, "originRecordId", "sourceRevisionId"',
    q,
    LIST_CAP,
  );
}

export interface ArrearsInput {
  sourceRevisionId: string;
  originRecordId: string;
  reason: string;
  /** Optional: the amounts are calculated; sent, they must equal the calculation. */
  lines?: { componentCode: string; amount: string }[] | undefined;
  idempotencyKey: string;
}

/**
 * FR-035 formula (I-79, decided under owner delegation, 6 Nov 2026; DF05 as the calculation pays a month). For each part of the origin
 * record's segments that the source revision covers and that was valued on another arrangement: the paid days of that part (its
 * calendar days less the loss-of-pay units on them) times the monthly difference of each FIXED head's component (source revision less
 * the segment's arrangement), over the record's days in month, summed per component and rounded half-up to the currency minor unit.
 * Earnings count up and employee deductions down; employer contributions are a cost, not pay, and are left out. The heads are the
 * origin run's. Components with no difference are left out.
 */
export async function computeArrears(db: Queryable, companyId: string, originRecordId: string, sourceArrangementId: string) {
  const rows = (
    await db.query<{ component_id: string; code: string; amount: string }>(
      `with rec as (
         select r.id, r.run_id, r.days_in_month::numeric as dim, ru.currency_minor_unit::smallint as mu
           from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
          where r.company_id = $1 and r.id = $2),
       src as (select id, effective_from, effective_to from salary_arrangement where company_id = $1 and id = $3),
       part as (
         select s.salary_arrangement_id as old_id, greatest(s.segment_start, src.effective_from) as f,
                least(s.segment_end, coalesce(src.effective_to - 1, s.segment_end)) as t
           from payroll_record_segment s cross join src
          where s.company_id = $1 and s.record_id = $2 and s.salary_arrangement_id <> src.id),
       paid as (
         select p.old_id, (p.t - p.f + 1) - coalesce((select sum(lp.units) from payroll_record_lop lp
                                                     where lp.company_id = $1 and lp.record_id = $2 and lp.day between p.f and p.t), 0) as days
           from part p where p.t >= p.f),
       diff as (
         select sc.component_id, paid.days * sc.amount as signed
           from paid cross join src
           join salary_component sc on sc.company_id = $1 and sc.salary_arrangement_id = src.id and sc.basis = 'MONTHLY'
         union all
         select sc.component_id, -(paid.days * sc.amount)
           from paid join salary_component sc on sc.company_id = $1 and sc.salary_arrangement_id = paid.old_id and sc.basis = 'MONTHLY')
       select d.component_id, pc.code,
              ((case when h.head_type = 'DEDUCTION' then -1 else 1 end) * sign(sum(d.signed))
                 * hrms_payroll_round_half_up(abs(sum(d.signed)), (select dim from rec), (select mu from rec)))::numeric(19, 4)::text as amount
         from diff d
         join pay_component pc on pc.company_id = $1 and pc.id = d.component_id
         join payroll_run_head rh on rh.company_id = $1 and rh.run_id = (select run_id from rec) and rh.component_id = d.component_id
         join payroll_head_revision h on h.company_id = rh.company_id and h.id = rh.head_revision_id
              and h.in_use and h.calculation_basis = 'FIXED' and h.head_type in ('EARNING', 'DEDUCTION')
        group by d.component_id, pc.code, h.head_type
       having sum(d.signed) <> 0
        order by pc.code`,
      [companyId, originRecordId, sourceArrangementId],
    )
  ).rows;
  return rows.filter((r) => Number(r.amount) !== 0);
}

export async function proposeArrears(tx: Queryable, grant: AccessGrant, input: ArrearsInput) {
  const key = optionalKey(input.idempotencyKey);
  const origin = (
    await tx.query<{ employee_id: string; run_id: string; run_state: string; period_id: string; currency_code: string; calculation_status: string; minor: number; service_start: string; service_end: string; period_code: string }>(
      `select rec.employee_id, ru.id as run_id, ru.state as run_state, ru.period_id, rec.currency_code, rec.calculation_status, ru.currency_minor_unit as minor,
              to_char(ru.service_start, 'YYYY-MM-DD') as service_start, to_char(ru.service_end, 'YYYY-MM-DD') as service_end, p.period_code
         from payroll_record rec join payroll_run ru on ru.company_id = rec.company_id and ru.id = rec.run_id join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
        where rec.company_id = $1 and rec.id = $2`,
      [grant.companyId, input.originRecordId],
    )
  ).rows[0];
  if (!origin) throw notFound();
  await assertInScope(tx, grant, origin.employee_id);
  await assertNotOwn(tx, grant, origin.employee_id);
  await advisoryLock(tx, `payroll_arrears:${grant.companyId}:${origin.employee_id}:${input.sourceRevisionId}`);
  await reassertAccess(tx, grant, 'payroll_arrears', 'propose', ['amount']);
  const replay = (await tx.query<{ id: string; employee_id: string; created_by: string }>(`select id, employee_id, created_by from payroll_arrears_case where company_id = $1 and submit_key = $2`, [grant.companyId, key])).rows[0];
  if (replay) {
    if (replay.created_by !== grant.userId || replay.employee_id !== origin.employee_id) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another case');
    return { ...(await arrearsDetail(tx, grant, replay.id)), replayed: true };
  }
  if (origin.run_state !== 'PROCESSED_LOCKED' || origin.calculation_status !== 'CALCULATED') throw new HttpError(409, 'ORIGIN_NOT_PROCESSED', 'A case originates in a processed payroll record');
  const source = (
    await tx.query<{ superseded: boolean; covers: boolean; currency_code: string; used: boolean }>(
      `select sa.superseded_at is not null as superseded, sa.currency_code,
              sa.effective_from <= $5::date and (sa.effective_to is null or sa.effective_to > $4::date) as covers,
              exists (select 1 from payroll_record_segment s where s.company_id = sa.company_id and s.record_id = $6 and s.salary_arrangement_id = sa.id) as used
         from salary_arrangement sa where sa.company_id = $1 and sa.id = $2 and sa.employee_id = $3`,
      [grant.companyId, input.sourceRevisionId, origin.employee_id, origin.service_start, origin.service_end, input.originRecordId],
    )
  ).rows[0];
  // CI: the source revision belongs to the same employee; anything else reads as missing.
  if (!source) throw notFound();
  if (source.superseded) throw new HttpError(409, 'SOURCE_SUPERSEDED', 'This salary revision was corrected and is no longer in force');
  if (source.currency_code !== origin.currency_code) throw new HttpError(422, 'CURRENCY_MISMATCH', 'The salary revision and the payroll record are in different currencies');
  if (!source.covers) throw new HttpError(422, 'REVISION_NOT_IN_PERIOD', 'The salary revision does not cover that payroll period');
  if (source.used) throw new HttpError(409, 'REVISION_ALREADY_CALCULATED', 'That payroll record was calculated from this salary revision, so it leaves no difference');
  const prior = (
    await tx.query<{ id: string; state: string }>(
      `select id, state from payroll_arrears_case where company_id = $1 and employee_id = $2 and source_arrangement_id = $3 and origin_period_id = $4 order by created_at desc`,
      [grant.companyId, origin.employee_id, input.sourceRevisionId, origin.period_id],
    )
  ).rows;
  const live = prior.find((p) => p.state === 'SUBMITTED' || p.state === 'APPROVED' || p.state === 'APPLIED');
  // FR-035 "rerunning the same revision does not pay the same arrears twice".
  if (live) throw new HttpError(409, 'ARREARS_CASE_EXISTS', 'This salary revision already has a case for that period', { caseId: live.id });
  const reason = requireText(input.reason, 'reason', 2000);
  // I-79: the amounts are the calculation's. Amounts sent with the request are a check on it, never a replacement.
  const computed = await computeArrears(tx, grant.companyId, input.originRecordId, input.sourceRevisionId);
  if (computed.length === 0) throw new HttpError(422, 'NO_DIFFERENCE', 'This salary revision leaves no difference for that payroll record');
  if (input.lines) {
    const sent = input.lines.map((l) => ({ code: l.componentCode.trim().toUpperCase(), amount: checkSigned(l.amount, origin.minor, 'amount') }));
    const same = sent.length === computed.length && sent.every((s) => computed.some((c) => c.code === s.code && Number(c.amount) === Number(s.amount)));
    if (!same) {
      throw new HttpError(422, 'ARREARS_LINES_DIFFER', 'The amounts sent differ from the calculation; send none to take the calculation', {
        calculated: computed.map((c) => ({ componentCode: c.code, amount: c.amount })),
      });
    }
  }
  const lines = computed.map((c) => ({ code: c.code, id: c.component_id, amount: c.amount }));

  const transactionId = await newTransaction(tx, grant.companyId, ARREARS_KIND, origin.employee_id, 'SUBMITTED', grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_arrears_case (company_id, employee_id, transaction_id, source_arrangement_id, origin_payroll_record_id, origin_run_id, origin_period_id, currency_code, reason, submit_key, state, follows_case_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'SUBMITTED', $11, $12, $12) returning id`,
      [grant.companyId, origin.employee_id, transactionId, input.sourceRevisionId, input.originRecordId, origin.run_id, origin.period_id, origin.currency_code, reason, key, prior[0]?.id ?? null, grant.userId],
    )
  ).rows[0]!.id;
  for (const l of lines) {
    await tx.query(`insert into payroll_arrears_line (company_id, case_id, component_id, amount, created_by) values ($1, $2, $3, $4::numeric, $5)`, [grant.companyId, id, l.id, l.amount, grant.userId]);
  }
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: ARREARS_KIND, transactionId, ownerEmployeeId: origin.employee_id, actorUserId: grant.userId, excludeUserIds: [grant.userId] });
  await audit(
    tx,
    actorOf(grant),
    'payroll_arrears_case',
    id,
    'PROPOSE',
    null,
    {
      operational: { sourceRevisionId: input.sourceRevisionId, originRecordId: input.originRecordId, periodCode: origin.period_code, state: 'SUBMITTED', lineCount: lines.length },
      amount: { lines: lines.map((l) => ({ code: l.code, amount: l.amount })), currencyCode: origin.currency_code },
    },
    reason,
  );
  await emit(tx, grant.companyId, 'payroll_arrears.assigned', id, id, { caseId: id, taskId });
  return { ...(await arrearsDetail(tx, grant, id)), replayed: false };
}

export async function arrearsTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, ARREARS_KIND)).items as { taskId: string; transactionId: string; assignedAt: Date }[];
  const items = [];
  for (const t of tasks) {
    const c = (await db.query(`${VIEW} where c.company_id = $1 and c.transaction_id = $2`, [grant.companyId, t.transactionId])).rows[0];
    if (c) items.push({ taskId: t.taskId, assignedAt: t.assignedAt, case: c });
  }
  return { items, calculation: ARREARS_CALCULATION };
}

export async function decideArrears(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: 'APPROVE' | 'REJECT' | 'RETURN'; reason?: string | undefined; idempotencyKey: string }) {
  const t = await taskTransaction(tx, grant, taskId, [ARREARS_KIND]);
  await lockTransaction(tx, t.transactionId);
  const c = (
    await tx.query<{ id: string; employee_id: string; transaction_id: string; source_arrangement_id: string; state: string }>(
      `select id, employee_id, transaction_id, source_arrangement_id, state from payroll_arrears_case where company_id = $1 and transaction_id = $2 for update`,
      [grant.companyId, t.transactionId],
    )
  ).rows[0];
  if (!c) throw notFound();
  await assertInScope(tx, grant, c.employee_id);
  if (await priorDecision(tx, grant.companyId, input.idempotencyKey, taskId)) return { caseId: c.id, state: c.state, replayed: true };
  if (!(await taskIsPending(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (c.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This case is not waiting for a decision');
  await assertNotOwn(tx, grant, c.employee_id);
  if (input.decision === 'APPROVE') {
    const facts = (
      await tx.query<{ superseded: boolean; negative: boolean }>(
        `select sa.superseded_at is not null as superseded,
                exists (select 1 from payroll_arrears_line l where l.company_id = sa.company_id and l.case_id = $3 and l.amount < 0) as negative
           from salary_arrangement sa where sa.company_id = $1 and sa.id = $2 for share of sa`,
        [grant.companyId, c.source_arrangement_id, c.id],
      )
    ).rows[0]!;
    if (facts.superseded) throw new HttpError(409, 'SOURCE_SUPERSEDED', 'This salary revision was corrected after the case was raised; return or reject the case');
    // H2 "An unresolved policy/rate/currency question blocks adjustment approval": approval needs the active valuation policy (I-79),
    // and a negative total, a recovery, needs that policy to name its recovery deduction ("Negative recovery requires an activated
    // applicable recovery policy and authorization").
    const policy = await valuationPolicyOn(tx, grant.companyId, grant.businessDate);
    if (!policy) {
      throw new HttpError(409, 'NOT_CONFIGURED', 'Arrears are approved under an active valuation policy; none is in effect', { code: 'VALUATION_POLICY_NOT_CONFIGURED' });
    }
    if (facts.negative && !policy.recovery_component_id) {
      throw new HttpError(409, 'NOT_CONFIGURED', 'A negative arrear is a recovery, and the valuation policy in effect names no recovery deduction; return or reject the case', {
        code: 'RECOVERY_POLICY_NOT_CONFIGURED',
      });
    }
  } else {
    requireText(input.reason, 'reason', 1000);
  }
  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'payroll_arrears', action: 'decide' } });
  if (result.replayed) return { caseId: c.id, state: c.state, replayed: true };
  const state = input.decision === 'APPROVE' ? 'APPROVED' : input.decision === 'REJECT' ? 'REJECTED' : 'RETURNED';
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, c.transaction_id, state, grant.userId]);
  await tx.query(`update payroll_arrears_case set state = $3, decided_at = now(), decided_by = $4, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, c.id, state, grant.userId]);
  await audit(tx, actorOf(grant), 'payroll_arrears_case', c.id, input.decision, { operational: { state: 'SUBMITTED' } }, { operational: { state } }, input.reason ?? null);
  await emit(tx, grant.companyId, 'payroll_arrears.decided', c.id, `${c.id}:${state}`, { caseId: c.id, outcome: state });
  return { caseId: c.id, state, replayed: false };
}
