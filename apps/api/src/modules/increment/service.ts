// Salary arrangements, increment cycles, cases, history and annual growth
// (FR-029 base, FR-089-FR-093; BR-038-BR-041; DF14; DF15; CI20; CI21; ZT25; ZT26).
// All money and percentage arithmetic runs in PostgreSQL numeric. A cycle is a review schedule, never an
// entitlement: no-change, deferred and rejected outcomes create no salary revision (BR-040/041).
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, assertNotOwnRecord, canAccessEmployee, employeeScopePredicate, resolveAccess, SqlParams } from '../access/authorize.js';
import { type Decision, decideTask, lockTransaction, startApproval } from '../workflow/engine.js';

type Basis = 'MONTHLY_GROSS' | 'ANNUAL_CTC';
const basisColumn = (b: Basis) => (b === 'MONTHLY_GROSS' ? 'monthly_gross' : 'annual_ctc');

/**
 * The input rules of a salary amount and its currency (POST /employees/:id/salary and the increment routes): a
 * non-negative exact decimal of up to 15 digits and 4 decimals, and an upper-case ISO-style 3-letter code. The salary
 * master upload (salary-master.ts) checks its cells with the same patterns, so a row passes exactly when the request would.
 */
export const MONEY_PATTERN = '^\\d{1,15}(\\.\\d{1,4})?$';
export const CURRENCY_PATTERN = '^[A-Z]{3}$';

/** The initial salary arrangement the salary routes record (POST /employees/:id/salary, the salary master upload). */
export interface InitialSalary {
  effectiveFrom: string;
  annualCtc: string;
  monthlyGross: string;
  currency: string;
}

/** Serialises every salary change of an employee (the key payroll's salary component path uses too). */
const lockSalary = (tx: Queryable, employeeId: string) => tx.query(`select pg_advisory_xact_lock(hashtextextended('salary:' || $1, 0))`, [employeeId]);

/** One line of a proposal's component breakdown (DB104), in the shape of a salary_component row. */
export interface ComponentLine {
  componentCode: string;
  amount: string;
  basis: 'MONTHLY' | 'ANNUAL';
}

/**
 * FR-092 / DB104: records the component breakdown of one proposal (the transaction revision it was made in). Each line
 * is an active pay component of the company, once. The before amount is the baseline arrangement's amount of the same
 * component and basis, NULL when the baseline has none (unknown, never assumed zero). No reconciliation of the lines
 * with the declared amount is assumed: the BRD leaves the company's compensation definition open (FR-029).
 */
async function recordComponents(tx: Queryable, grant: AccessGrant, caseId: string, baselineSalaryId: string, revision: number, lines: readonly ComponentLine[]) {
  const seen = new Set<string>();
  for (const [i, l] of lines.entries()) {
    const component = (await tx.query<{ id: string }>(`select id from pay_component where company_id = $1 and code = $2 and active`, [grant.companyId, l.componentCode])).rows[0];
    if (!component) throw new HttpError(422, 'UNKNOWN_COMPONENT', 'The pay component does not exist or is not active', { line: i + 1 });
    if (seen.has(component.id)) throw new HttpError(422, 'DUPLICATE_COMPONENT', 'Each component appears once', { line: i + 1 });
    seen.add(component.id);
    await tx.query(
      `insert into increment_component (company_id, case_id, component_id, basis, proposal_revision, before_amount, proposed_amount, created_by, updated_by)
       values ($1, $2, $3, $4, $5,
               (select sc.amount from salary_component sc where sc.company_id = $1 and sc.salary_arrangement_id = $6 and sc.component_id = $3 and sc.basis = $4),
               $7::numeric, $8, $8)`,
      [grant.companyId, caseId, component.id, l.basis, revision, baselineSalaryId, l.amount, grant.userId],
    );
  }
}

function requireCompanyScope(grant: AccessGrant) {
  const { departments, locations, employees } = grant.filters;
  if (grant.scopeKind !== 'COMPANY' || departments.length + locations.length + employees.length > 0) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

export async function createInitialSalary(tx: Queryable, grant: AccessGrant, employeeId: string, input: InitialSalary) {
  if (!(await canAccessEmployee(tx, grant, employeeId))) throw notFound();
  // C4; DF02: this applies without a separate approval, so nobody records their own salary.
  await assertNotOwnRecord(tx, grant, employeeId);
  await lockSalary(tx, employeeId);
  await reassertAccess(tx, grant, 'salary', 'manage', ['salary']);
  const existing = await tx.query(`select 1 from salary_arrangement where company_id = $1 and employee_id = $2`, [grant.companyId, employeeId]);
  if (existing.rowCount) throw new HttpError(409, 'SALARY_EXISTS', 'Salary changes go through an increment case');
  const id = (
    await tx.query<{ id: string }>(
      `insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code, created_by, updated_by)
       values ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $7) returning id`,
      [grant.companyId, employeeId, input.effectiveFrom, input.annualCtc, input.monthlyGross, input.currency, grant.userId],
    )
  ).rows[0]!.id;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'salary_arrangement',
    recordKey: id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: 1,
    after: { salary: input },
  });
  return { id };
}

/**
 * C4 "Historical financial views require an explicit history grant"; C6; 0126: the selected assignment holds the history grant
 * of `resource`. The plain read grant answers for what is in force and later only.
 */
export async function holdsSalaryHistoryGrant(db: Queryable, grant: AccessGrant, resource: 'salary' | 'increment'): Promise<boolean> {
  return (await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource, action: 'history_read', fieldGroups: ['salary'], at: grant.at })).allowed;
}

/** The chain of arrangements: every one with the history grant, otherwise those not yet ended; `historyIncluded` says which. */
export async function salaryHistory(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const historyIncluded = await holdsSalaryHistoryGrant(db, grant, 'salary');
  const rows = await db.query(
    `select id, effective_from as "effectiveFrom", effective_to as "effectiveTo", annual_ctc::text as "annualCtc",
            monthly_gross::text as "monthlyGross", currency_code as currency
       from salary_arrangement where company_id = $1 and employee_id = $2 and superseded_at is null
        and ($3::boolean or effective_to is null or effective_to > $4::date) order by effective_from`,
    [grant.companyId, employeeId, historyIncluded, grant.businessDate],
  );
  return { employeeId, historyIncluded, items: rows.rows };
}

// Cycle definitions, review openings (rosters), cycle assignment and review-date overrides: cycles.ts, roster.ts,
// plans.ts and schedule.ts (migration 0050).

interface CaseRow {
  id: string;
  employee_id: string;
  transaction_id: string;
  state: string;
  off_cycle: boolean;
  prepared_by: string;
  proposed_by: string | null;
  baseline_salary_id: string;
  compensation_basis: Basis;
  currency_code: string;
  baseline_amount: string;
  proposed_outcome: 'INCREASE' | 'NO_CHANGE' | 'DEFER' | null;
  proposed_amount: string | null;
  proposed_counterpart: string | null;
  proposed_effective_date: string;
  reason: string;
  version: number;
  corrects_history_id: string | null;
}

async function lockCase(tx: Queryable, companyId: string, column: 'id' | 'transaction_id', value: string): Promise<CaseRow> {
  const row = (
    await tx.query<CaseRow>(
      `select id, employee_id, transaction_id, state, off_cycle, prepared_by, proposed_by, baseline_salary_id, compensation_basis, currency_code,
              baseline_amount::text, proposed_outcome, proposed_amount::text, proposed_counterpart::text,
              to_char(proposed_effective_date, 'YYYY-MM-DD') as proposed_effective_date, reason, version, corrects_history_id
         from increment_case where company_id = $1 and ${column} = $2 for update`,
      [companyId, value],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

export interface Proposal {
  expectedVersion: number;
  outcome: 'INCREASE' | 'NO_CHANGE' | 'DEFER';
  proposedAmount?: string | undefined;
  proposedCounterpart?: string | undefined;
  /** Optional component breakdown of an increase: the components the new arrangement will carry. */
  components?: ComponentLine[] | undefined;
  reason: string;
}

/** DF15: the employee's current direct manager proposes a cycle outcome; an independent Admin approves. */
export async function propose(tx: Queryable, grant: AccessGrant, caseId: string, input: Proposal) {
  // The transaction lock comes first, before any row lock (as in decideTask).
  const head = (await tx.query<{ transaction_id: string }>(`select transaction_id from increment_case where company_id = $1 and id = $2`, [grant.companyId, caseId])).rows[0];
  if (!head) throw notFound();
  await lockTransaction(tx, head.transaction_id);
  const c = await lockCase(tx, grant.companyId, 'id', caseId);
  if (!(await canAccessEmployee(tx, grant, c.employee_id))) throw notFound();
  await reassertAccess(tx, grant, 'increment', 'propose', ['salary']);
  const isManager = (
    await tx.query<{ ok: boolean }>(
      `select exists (select 1 from manager_assignment where company_id = $1 and employee_id = $2 and manager_employee_id = $3
                        and effective_from <= hrms_business_date($1, now()) and (effective_to is null or effective_to > hrms_business_date($1, now()))) as ok`,
      [grant.companyId, c.employee_id, grant.linkedEmployeeId],
    )
  ).rows[0]!.ok;
  if (c.off_cycle || !grant.linkedEmployeeId || !isManager) throw new HttpError(403, 'FORBIDDEN', 'Only the current direct manager can propose');
  if (c.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
  if (c.state !== 'DRAFT' && c.state !== 'RETURNED') throw new HttpError(409, 'INVALID_STATE', 'This case is not open for a proposal');
  if (input.outcome === 'INCREASE' && (!input.proposedAmount || !input.proposedCounterpart)) {
    throw new HttpError(422, 'RULE_VIOLATION', 'An increase needs the new amount on the cycle basis and the counterpart figure');
  }
  if (input.components && input.outcome !== 'INCREASE') throw new HttpError(422, 'RULE_VIOLATION', 'A component breakdown belongs to an increase only');
  const revision = (
    await tx.query<{ revision: number }>(
      `update business_transaction set revision = revision + 1, state = 'SUBMITTED', updated_by = $3 where company_id = $1 and id = $2 returning revision`,
      [grant.companyId, c.transaction_id, grant.userId],
    )
  ).rows[0]!.revision;
  await tx.query(
    `update increment_case set state = 'SUBMITTED', proposed_outcome = $3, proposed_amount = $4::numeric, proposed_counterpart = $5::numeric,
            proposed_by = $6, reason = $7, updated_by = $6 where company_id = $1 and id = $2`,
    [grant.companyId, c.id, input.outcome, input.outcome === 'INCREASE' ? input.proposedAmount : null, input.outcome === 'INCREASE' ? input.proposedCounterpart : null, grant.userId, input.reason.trim()],
  );
  if (input.components) await recordComponents(tx, grant, c.id, c.baseline_salary_id, revision, input.components);
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: 'increment_case',
    transactionId: c.transaction_id,
    ownerEmployeeId: c.employee_id,
    actorUserId: grant.userId,
    excludeUserIds: [c.prepared_by, grant.userId],
  });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'increment_case',
    recordKey: c.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'PROPOSE',
    priorVersion: c.version,
    after: {
      operational: { outcome: input.outcome, componentCount: input.components?.length ?? 0 },
      salary: { proposedAmount: input.proposedAmount ?? null, proposedCounterpart: input.proposedCounterpart ?? null, components: input.components ?? null },
    },
    reason: input.reason,
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'increment.proposed',
    aggregateId: c.id,
    dedupeKey: `increment.proposed:${c.id}:${c.version}`,
    payload: { caseId: c.id, taskId },
  });
  return { caseId: c.id, taskId, state: 'SUBMITTED' };
}

/** DF15 off-cycle change: an HR proposal approved by a different financial Admin. */
export async function proposeOffCycle(
  tx: Queryable,
  grant: AccessGrant,
  input: { employeeId: string; effectiveDate: string; proposedAmount: string; proposedCounterpart: string; basis: Basis; reason: string; components?: ComponentLine[] | undefined },
) {
  requireCompanyScope(grant);
  if (!(await canAccessEmployee(tx, grant, input.employeeId))) throw notFound();
  await lockSalary(tx, input.employeeId);
  await reassertAccess(tx, grant, 'increment', 'propose', ['salary']);
  const baseline = (
    await tx.query<{ id: string; amount: string; currency: string }>(
      `select id, ${basisColumn(input.basis)}::text as amount, currency_code as currency from salary_arrangement
        where company_id = $1 and employee_id = $2 and effective_from < $3::date and (effective_to is null or effective_to >= $3::date)`,
      [grant.companyId, input.employeeId, input.effectiveDate],
    )
  ).rows[0];
  if (!baseline) throw new HttpError(422, 'NO_SALARY_BASELINE', 'No salary arrangement applies before the effective date');
  const bt = (
    await tx.query<{ id: string; revision: number }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by)
       values ($1, 'increment_case', $2, 'SUBMITTED', $3, $3) returning id, revision`,
      [grant.companyId, input.employeeId, grant.userId],
    )
  ).rows[0]!;
  const transactionId = bt.id;
  const caseId = (
    await tx.query<{ id: string }>(
      `insert into increment_case (company_id, employee_id, transaction_id, cycle_occurrence_key, off_cycle, prepared_by, proposed_by,
                                   baseline_salary_id, compensation_basis, currency_code, baseline_amount, proposed_outcome, proposed_amount,
                                   proposed_counterpart, proposed_effective_date, state, reason, created_by, updated_by)
       values ($1, $2, $3, $13, true, $4, $4, $5, $6, $7, $8::numeric, 'INCREASE', $9::numeric, $10::numeric, $11, 'SUBMITTED', $12, $4, $4)
       returning id`,
      [
        grant.companyId,
        input.employeeId,
        transactionId,
        grant.userId,
        baseline.id,
        input.basis,
        baseline.currency,
        baseline.amount,
        input.proposedAmount,
        input.proposedCounterpart,
        input.effectiveDate,
        input.reason.trim(),
        `OFF_CYCLE:${transactionId}`,
      ],
    )
  ).rows[0]!.id;
  if (input.components) await recordComponents(tx, grant, caseId, baseline.id, bt.revision, input.components);
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: 'increment_case',
    transactionId,
    ownerEmployeeId: input.employeeId,
    actorUserId: grant.userId,
    excludeUserIds: [grant.userId],
  });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'increment_case',
    recordKey: caseId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'PROPOSE_OFF_CYCLE',
    newVersion: 1,
    after: {
      operational: { effectiveDate: input.effectiveDate, componentCount: input.components?.length ?? 0 },
      salary: { proposedAmount: input.proposedAmount, proposedCounterpart: input.proposedCounterpart, components: input.components ?? null },
    },
    reason: input.reason,
  });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'increment.proposed',
    aggregateId: caseId,
    dedupeKey: `increment.proposed:${caseId}:1`,
    payload: { caseId, taskId },
  });
  return { caseId, taskId, state: 'SUBMITTED' };
}

// ---------------------------------------------------------------------------------------------------------
// Correcting an applied increment (BR-038; DF14; FR-089; 0095)
// ---------------------------------------------------------------------------------------------------------

interface CorrectionTarget {
  id: string;
  employee_id: string;
  old_salary_id: string;
  new_salary_id: string;
  effective_date: string;
  compensation_basis: Basis;
  currency_code: string;
  before_amount: string;
  superseded: boolean;
  baseline_from: string;
  baseline_to: string | null;
  new_from: string;
  new_to: string | null;
  later: boolean;
}

async function correctionTarget(tx: Queryable, companyId: string, historyId: string): Promise<CorrectionTarget> {
  const row = (
    await tx.query<CorrectionTarget>(
      `select h.id, h.employee_id, h.old_salary_id, h.new_salary_id, to_char(h.effective_date, 'YYYY-MM-DD') as effective_date, h.compensation_basis, h.currency_code, h.before_amount::text,
              exists (select 1 from increment_history n where n.company_id = h.company_id and n.corrects_history_id = h.id) as superseded,
              to_char(o.effective_from, 'YYYY-MM-DD') as baseline_from, to_char(o.effective_to, 'YYYY-MM-DD') as baseline_to,
              to_char(s.effective_from, 'YYYY-MM-DD') as new_from, to_char(s.effective_to, 'YYYY-MM-DD') as new_to,
              exists (select 1 from salary_arrangement x where x.company_id = s.company_id and x.employee_id = s.employee_id and x.superseded_at is null and x.effective_from > s.effective_from) as later
         from increment_history h
         join salary_arrangement o on o.company_id = h.company_id and o.id = h.old_salary_id
         join salary_arrangement s on s.company_id = h.company_id and s.id = h.new_salary_id
        where h.company_id = $1 and h.id = $2`,
      [companyId, historyId],
    )
  ).rows[0];
  if (!row) throw notFound();
  return row;
}

/**
 * What must hold when a correction is proposed and again when it applies. The BRD says a correction supersedes and that
 * "Existing locked payroll is preserved; retroactive difference creates an approved arrears case" (DF15). No arrears case
 * exists yet (FR-035 waits on the owner), so a correction that reaches a processed record is refused: nothing processed changes,
 * and a change from a later date stays an ordinary off-cycle case. Two technical choices the BRD does not state (docs/03): only
 * the latest change is corrected, which keeps the chain simple; and a period a live run has calculated is refused, since
 * processing it would otherwise freeze the amount being corrected, so the correction would be lost.
 */
async function assertCorrectable(tx: Queryable, companyId: string, t: CorrectionTarget, effectiveDate: string): Promise<void> {
  if (t.superseded) throw new HttpError(409, 'ALREADY_CORRECTED', 'This change has already been corrected; correct the correction instead');
  if (t.new_to !== null || t.later) throw new HttpError(409, 'NOT_LATEST_CHANGE', 'Only the latest salary change can be corrected; a later change exists');
  if (t.baseline_to !== t.new_from) throw new HttpError(409, 'STALE_BASELINE', 'The salary baseline of this change no longer holds');
  if (effectiveDate <= t.baseline_from) throw new HttpError(422, 'INVALID_EFFECTIVE_DATE', 'The correction must take effect after the salary it replaces began', { after: t.baseline_from });
  const payroll = (
    await tx.query<{ processed_through: string | null; in_progress: boolean | null }>(
      `select to_char(max(r.eligible_to) filter (where r.frozen_at is not null), 'YYYY-MM-DD') as processed_through, bool_or(r.frozen_at is null) as in_progress
         from payroll_record r join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
        where r.company_id = $1 and r.employee_id = $2 and r.calculation_status = 'CALCULATED' and r.eligible_to >= least($3::date, $4::date)
          and (r.frozen_at is not null or ru.state in ('DRAFT', 'CALCULATED', 'IN_REVIEW', 'APPROVED'))`,
      [companyId, t.employee_id, t.effective_date, effectiveDate],
    )
  ).rows[0]!;
  if (payroll.processed_through) {
    throw new HttpError(409, 'PAYROLL_PROCESSED', 'Payroll has been processed for this period and is never changed; a change from a later date is an off-cycle case', { processedThrough: payroll.processed_through });
  }
  if (payroll.in_progress) throw new HttpError(409, 'PAYROLL_IN_PROGRESS', 'A payroll run has calculated this period; revise or cancel that run first');
}

export interface CorrectionProposal {
  effectiveDate: string;
  proposedAmount: string;
  proposedCounterpart: string;
  components?: ComponentLine[] | undefined;
  reason: string;
}

/** BR-038; DF15: proposed by HR and decided by a different financial Admin, like an off-cycle change. */
export async function proposeCorrection(tx: Queryable, grant: AccessGrant, historyId: string, input: CorrectionProposal) {
  requireCompanyScope(grant);
  const head = (await tx.query<{ employee_id: string }>(`select employee_id from increment_history where company_id = $1 and id = $2`, [grant.companyId, historyId])).rows[0];
  if (!head || !(await canAccessEmployee(tx, grant, head.employee_id))) throw notFound();
  await lockSalary(tx, head.employee_id);
  await reassertAccess(tx, grant, 'increment', 'propose', ['salary']);
  const t = await correctionTarget(tx, grant.companyId, historyId);
  await assertCorrectable(tx, grant.companyId, t, input.effectiveDate);
  const open = await tx.query(`select 1 from increment_case where company_id = $1 and corrects_history_id = $2 and state = 'SUBMITTED'`, [grant.companyId, historyId]);
  if (open.rowCount) throw new HttpError(409, 'CORRECTION_PENDING', 'A correction of this change is already waiting for a decision');
  const same = (
    await tx.query<{ same: boolean }>(
      `select s.${basisColumn(t.compensation_basis)} = $3::numeric and s.${t.compensation_basis === 'MONTHLY_GROSS' ? 'annual_ctc' : 'monthly_gross'} = $4::numeric and s.effective_from = $5::date as same
         from salary_arrangement s where s.company_id = $1 and s.id = $2`,
      [grant.companyId, t.new_salary_id, input.proposedAmount, input.proposedCounterpart, input.effectiveDate],
    )
  ).rows[0]!.same;
  if (same) throw new HttpError(422, 'NO_CHANGE', 'The correction changes nothing');
  const bt = (
    await tx.query<{ id: string; revision: number }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, 'increment_case', $2, 'SUBMITTED', $3, $3) returning id, revision`,
      [grant.companyId, t.employee_id, grant.userId],
    )
  ).rows[0]!;
  const caseId = (
    await tx.query<{ id: string }>(
      `insert into increment_case (company_id, employee_id, transaction_id, cycle_occurrence_key, off_cycle, prepared_by, proposed_by, baseline_salary_id, compensation_basis, currency_code,
                                   baseline_amount, proposed_outcome, proposed_amount, proposed_counterpart, proposed_effective_date, state, reason, corrects_history_id, created_by, updated_by)
       values ($1, $2, $3, $4, true, $5, $5, $6, $7, $8, $9::numeric, 'INCREASE', $10::numeric, $11::numeric, $12, 'SUBMITTED', $13, $14, $5, $5) returning id`,
      [
        grant.companyId,
        t.employee_id,
        bt.id,
        `CORRECTION:${bt.id}`,
        grant.userId,
        t.old_salary_id,
        t.compensation_basis,
        t.currency_code,
        t.before_amount,
        input.proposedAmount,
        input.proposedCounterpart,
        input.effectiveDate,
        input.reason.trim(),
        t.id,
      ],
    )
  ).rows[0]!.id;
  if (input.components) await recordComponents(tx, grant, caseId, t.old_salary_id, bt.revision, input.components);
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: 'increment_case', transactionId: bt.id, ownerEmployeeId: t.employee_id, actorUserId: grant.userId, excludeUserIds: [grant.userId] });
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'increment_case',
    recordKey: caseId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'PROPOSE_CORRECTION',
    newVersion: 1,
    after: {
      operational: { effectiveDate: input.effectiveDate, correctsHistoryId: t.id, componentCount: input.components?.length ?? 0 },
      salary: { proposedAmount: input.proposedAmount, proposedCounterpart: input.proposedCounterpart, components: input.components ?? null },
    },
    reason: input.reason,
  });
  await enqueueEvent(tx, { companyId: grant.companyId, topic: 'increment.proposed', aggregateId: caseId, dedupeKey: `increment.proposed:${caseId}:1`, payload: { caseId, taskId } });
  return { caseId, taskId, state: 'SUBMITTED' };
}

/** Takes the corrected arrangement out of the chain, on record with its components; the case's baseline is its predecessor again. */
async function retireCorrected(tx: Queryable, grant: AccessGrant, c: CaseRow, reason: string): Promise<{ id: string; currency_code: string }> {
  const t = await correctionTarget(tx, grant.companyId, c.corrects_history_id!);
  await assertCorrectable(tx, grant.companyId, t, c.proposed_effective_date);
  if (t.old_salary_id !== c.baseline_salary_id) throw new HttpError(409, 'STALE_BASELINE', 'The salary baseline changed while this case was pending; it must be revalidated and resubmitted');
  await tx.query(`update salary_arrangement set effective_to = effective_from, superseded_at = now(), updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, t.new_salary_id, grant.userId]);
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'salary_arrangement',
    recordKey: t.new_salary_id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'SUPERSEDE',
    after: { operational: { correctionCaseId: c.id, correctsHistoryId: t.id } },
    reason,
  });
  return { id: t.old_salary_id, currency_code: t.currency_code };
}

/**
 * Independent decision and atomic application (BR-041, CI20). Approval of an increase re-validates that the
 * baseline is still the arrangement in force just before the effective date and that no later arrangement
 * exists; otherwise the whole decision rolls back (stale baseline). One case yields one new arrangement and
 * one history record; the replay of a decision applies nothing again.
 */
export async function decideIncrement(tx: Queryable, grant: AccessGrant, taskId: string, input: { decision: Decision; reason: string; idempotencyKey: string }) {
  const result = await decideTask(tx, { grant, taskId, ...input, permission: { resource: 'increment', action: 'approve' } });
  const c = await lockCase(tx, grant.companyId, 'transaction_id', result.transactionId);
  if (result.replayed) return { caseId: c.id, state: c.state, replayed: true };
  if (c.prepared_by === grant.userId || c.proposed_by === grant.userId) throw new HttpError(403, 'SELF_APPROVAL', 'The preparer or proposer cannot approve');
  if (result.outcome === 'NEXT_STEP') return { caseId: c.id, state: c.state, replayed: false };

  let state: string;
  let history: { changePercent: string | null; naReason: string | null; componentsApplied: number } | null = null;
  if (result.outcome === 'RETURNED') state = 'RETURNED';
  else if (result.outcome === 'REJECTED') state = 'REJECTED';
  else if (c.proposed_outcome === 'NO_CHANGE') state = 'NO_CHANGE';
  else if (c.proposed_outcome === 'DEFER') state = 'DEFERRED';
  else {
    state = 'APPLIED';
    history = await apply(tx, grant, c, input.idempotencyKey, input.reason);
  }

  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, c.transaction_id, state, grant.userId]);
  if (state !== 'APPLIED') {
    await tx.query(`update increment_case set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, c.id, state, grant.userId]);
  }
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'increment_case',
    recordKey: c.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: input.decision,
    priorVersion: c.version,
    before: { operational: { state: c.state } },
    after: { operational: { state, ...(history ? { componentsApplied: history.componentsApplied } : {}) } },
    reason: input.reason,
  });
  // Notification payload carries the outcome state only, never amounts or percentages (CR-007).
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'increment.decided',
    aggregateId: c.id,
    dedupeKey: `increment.decided:${c.id}:${input.idempotencyKey}`,
    payload: { caseId: c.id, outcome: state },
  });
  return {
    caseId: c.id,
    state,
    changePercent: history?.changePercent ?? null,
    percentNaReason: history?.naReason ?? null,
    componentsApplied: history ? history.componentsApplied : null,
    replayed: false,
  };
}

async function apply(tx: Queryable, grant: AccessGrant, c: CaseRow, idempotencyKey: string, reason: string) {
  // Serialise salary changes for the employee, then re-validate the baseline.
  await lockSalary(tx, c.employee_id);
  // DF15: the roster excludes an approved last working date before the effective date; an exit approved while the case
  // was pending stops it the same way (the whole decision rolls back; rejecting or returning stays open).
  const separatedBefore = (
    await tx.query<{ before: boolean }>(`select coalesce(hrms_exit_last_working_date($1, $2) < $3::date, false) as before`, [grant.companyId, c.employee_id, c.proposed_effective_date])
  ).rows[0]!.before;
  if (separatedBefore) throw new HttpError(422, 'SEPARATION_BEFORE_EFFECTIVE_DATE', 'The approved last working date is before the effective date');
  let baseline: { id: string; currency_code: string };
  if (c.corrects_history_id) {
    baseline = await retireCorrected(tx, grant, c, reason.trim());
  } else {
    const current = (
      await tx.query<{ id: string; currency_code: string; later: boolean }>(
        `select sa.id, sa.currency_code,
                exists (select 1 from salary_arrangement x where x.company_id = sa.company_id and x.employee_id = sa.employee_id
                           and x.superseded_at is null and x.effective_from >= $3::date) as later
           from salary_arrangement sa
          where sa.company_id = $1 and sa.employee_id = $2 and sa.effective_from < $3::date and (sa.effective_to is null or sa.effective_to >= $3::date)
          for update`,
        [grant.companyId, c.employee_id, c.proposed_effective_date],
      )
    ).rows[0];
    if (!current || current.id !== c.baseline_salary_id || current.later) {
      throw new HttpError(409, 'STALE_BASELINE', 'The salary baseline changed while this case was pending; it must be revalidated and resubmitted');
    }
    baseline = current;
  }

  await tx.query(`update salary_arrangement set effective_to = $3::date, updated_by = $4 where company_id = $1 and id = $2`, [
    grant.companyId,
    baseline.id,
    c.proposed_effective_date,
    grant.userId,
  ]);
  const [monthly, annual] = c.compensation_basis === 'MONTHLY_GROSS' ? [c.proposed_amount, c.proposed_counterpart] : [c.proposed_counterpart, c.proposed_amount];
  const newSalaryId = (
    await tx.query<{ id: string }>(
      `insert into salary_arrangement (company_id, employee_id, effective_from, annual_ctc, monthly_gross, currency_code, created_by, updated_by)
       values ($1, $2, $3, $4::numeric, $5::numeric, $6, $7, $7) returning id`,
      [grant.companyId, c.employee_id, c.proposed_effective_date, annual, monthly, baseline.currency_code, grant.userId],
    )
  ).rows[0]!.id;
  // FR-092: the approved breakdown of the proposal being decided (the transaction's current revision) becomes the new
  // arrangement's salary components in this transaction, exactly as approved (payroll reads salary_component, and
  // components are immutable once set, 0043: they are inserted once, with the arrangement). A case without a breakdown
  // leaves the arrangement without components, as before; they are then set through payroll.
  const componentsApplied =
    (
      await tx.query(
        `with approved as (
           update increment_component ic set approved_amount = ic.proposed_amount, updated_by = $4
             from business_transaction bt
            where ic.company_id = $1 and ic.case_id = $2 and bt.company_id = $1 and bt.id = $5 and ic.proposal_revision = bt.revision
            returning ic.component_id, ic.approved_amount, ic.basis)
         insert into salary_component (company_id, salary_arrangement_id, component_id, amount, basis, created_by, updated_by)
         select $1, $3, component_id, approved_amount, basis, $4, $4 from approved`,
        [grant.companyId, c.id, newSalaryId, grant.userId, c.transaction_id],
      )
    ).rowCount ?? 0;

  const decisionId = (await tx.query<{ id: string }>(`select id from approval_decision where company_id = $1 and idempotency_key = $2`, [grant.companyId, idempotencyKey])).rows[0]!.id;
  // DF14: (after - before) / before x 100 for a positive comparable baseline, 2 decimals; otherwise N/A with reason.
  const h = (
    await tx.query<{ change_percent: string | null; percent_na_reason: string | null }>(
      `insert into increment_history (company_id, employee_id, case_id, approval_decision_id, old_salary_id, new_salary_id, effective_date,
                                      compensation_basis, currency_code, before_amount, after_amount, change_amount, change_percent,
                                      percent_na_reason, reason, applied_by, corrects_history_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::numeric, $11::numeric, $11::numeric - $10::numeric,
               case when $10::numeric > 0 then round(($11::numeric - $10::numeric) / $10::numeric * 100, 2) end,
               case when $10::numeric > 0 then null else 'ZERO_BASELINE' end, $12, $13, $14, $13, $13)
       returning to_char(change_percent, 'FM999999990.00') as change_percent, percent_na_reason`,
      [grant.companyId, c.employee_id, c.id, decisionId, baseline.id, newSalaryId, c.proposed_effective_date, c.compensation_basis, baseline.currency_code, c.baseline_amount, c.proposed_amount, reason.trim(), grant.userId, c.corrects_history_id],
    )
  ).rows[0]!;
  await tx.query(
    `update increment_case set state = 'APPLIED', approved_amount = proposed_amount, approved_effective_date = proposed_effective_date,
            applied_salary_id = $3, updated_by = $4 where company_id = $1 and id = $2`,
    [grant.companyId, c.id, newSalaryId, grant.userId],
  );
  return { changePercent: h.change_percent, naReason: h.percent_na_reason, componentsApplied };
}

export async function incrementHistory(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  // The approver's free-text reason is a group of its own (DF02), on top of the history grant.
  const withReason = (await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource: 'increment', action: 'read', fieldGroups: ['reason'], at: grant.at })).allowed;
  const rows = await db.query(
    `select h.id, h.effective_date as "effectiveDate", h.compensation_basis as basis, h.currency_code as currency,
            h.before_amount::text as "beforeAmount", h.after_amount::text as "afterAmount", h.change_amount::text as "changeAmount",
            to_char(h.change_percent, 'FM999999990.00') as "changePercent", h.percent_na_reason as "percentNaReason"${withReason ? ', h.reason' : ''},
            h.corrects_history_id as "correctsHistoryId", n.id as "supersededByHistoryId",
            -- Only the latest change is corrected (assertCorrectable); a screen offers it here, the route decides again.
            (n.id is null and s.effective_to is null) as correctable
       from increment_history h
       join salary_arrangement s on s.company_id = h.company_id and s.id = h.new_salary_id
       left join increment_history n on n.company_id = h.company_id and n.corrects_history_id = h.id
      where h.company_id = $1 and h.employee_id = $2 order by h.effective_date, h.applied_at`,
    [grant.companyId, employeeId],
  );
  return { employeeId, items: rows.rows };
}

/**
 * DF14 annual growth for a financial year (1 Apr - 31 Mar by default): opening = approved salary in force
 * the day before the period starts, closing = salary in force on the last day; growth = (closing - opening)
 * / opening x 100 at 2 decimals. Per-change percentages are listed separately and never summed (BR-039).
 */
export async function annualGrowth(db: Queryable, grant: AccessGrant, employeeId: string, financialYear: number, basis: Basis = 'MONTHLY_GROSS') {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const col = basisColumn(basis);
  const row = (
    await db.query<{ period_start: string; period_end: string; opening: string | null; opening_currency: string | null; closing: string | null; closing_currency: string | null }>(
      `with p as (select make_date($3, 4, 1) as s, make_date($3 + 1, 3, 31) as e),
            o as (select ${col} as amount, currency_code from salary_arrangement, p where company_id = $1 and employee_id = $2
                    and effective_from <= p.s - 1 and (effective_to is null or effective_to > p.s - 1)),
            c as (select ${col} as amount, currency_code from salary_arrangement, p where company_id = $1 and employee_id = $2
                    and effective_from <= p.e and (effective_to is null or effective_to > p.e))
       select to_char(p.s, 'YYYY-MM-DD') as period_start, to_char(p.e, 'YYYY-MM-DD') as period_end,
              (select amount::text from o) as opening, (select currency_code from o) as opening_currency,
              (select amount::text from c) as closing, (select currency_code from c) as closing_currency
         from p`,
      [grant.companyId, employeeId, financialYear],
    )
  ).rows[0]!;
  const changes = await db.query(
    `select effective_date as "effectiveDate", before_amount::text as "beforeAmount", after_amount::text as "afterAmount",
            to_char(change_percent, 'FM999999990.00') as "changePercent", percent_na_reason as "percentNaReason"
       from increment_history_in_force where company_id = $1 and employee_id = $2 and compensation_basis = $3
        and effective_date between $4::date and $5::date order by effective_date`,
    [grant.companyId, employeeId, basis, row.period_start, row.period_end],
  );
  let growth: string | null = null;
  let naReason: string | null = null;
  if (!row.opening || !row.closing) naReason = 'MISSING_OPENING_OR_CLOSING';
  else if (row.opening_currency !== row.closing_currency) naReason = 'CURRENCY_CHANGED';
  else {
    const g = (
      await db.query<{ g: string | null }>(`select case when $1::numeric > 0 then to_char(round(($2::numeric - $1::numeric) / $1::numeric * 100, 2), 'FM999999990.00') end as g`, [
        row.opening,
        row.closing,
      ])
    ).rows[0]!.g;
    if (g === null) naReason = 'ZERO_BASELINE';
    growth = g;
  }
  return {
    employeeId,
    financialYear,
    basis,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    opening: row.opening,
    closing: row.closing,
    currency: row.closing_currency ?? row.opening_currency,
    annualGrowthPercent: growth,
    percentNaReason: naReason,
    changes: changes.rows,
  };
}

/**
 * Case list: states for everyone with increment read; amounts only with the salary field grant (BR-044), and on a closed case
 * only with the history grant too (C4): what was decided earlier is the financial past, what is open is current work.
 */
export async function listCases(db: Queryable, grant: AccessGrant, q: { state?: string | undefined }) {
  const withSalary = grant.allowedFieldGroups.includes('salary');
  const withHistory = withSalary && (await holdsSalaryHistoryGrant(db, grant, 'increment'));
  const params = new SqlParams();
  const scope = employeeScopePredicate(grant, { company: 'c.company_id', employee: 'c.employee_id' }, params);
  const stateFilter = q.state ? `and c.state = ${params.add(q.state)}` : '';
  const rows = await db.query(
    `select c.id, c.employee_id as "employeeId", e.employee_code as "employeeCode", c.cycle_occurrence_key as occurrence, c.off_cycle as "offCycle",
            c.state, c.proposed_outcome as "proposedOutcome", to_char(c.proposed_effective_date, 'YYYY-MM-DD') as "effectiveDate", c.version
            , to_char(c.decision_due_on, 'YYYY-MM-DD') as "decisionDueOn", c.corrects_history_id as "correctsHistoryId"
            ${
              withSalary
                ? `, c.baseline_amount::text as "baselineAmount", c.proposed_amount::text as "proposedAmount", c.currency_code as currency,
                   (select coalesce(json_agg(json_build_object('componentCode', pc.code, 'basis', ic.basis, 'beforeAmount', ic.before_amount::text,
                                                               'proposedAmount', ic.proposed_amount::text, 'approvedAmount', ic.approved_amount::text)
                                             order by pc.code), '[]'::json)
                      from increment_component ic
                      join pay_component pc on pc.company_id = ic.company_id and pc.id = ic.component_id
                      join business_transaction bt on bt.company_id = c.company_id and bt.id = c.transaction_id
                     where ic.company_id = c.company_id and ic.case_id = c.id and ic.proposal_revision = bt.revision) as components`
                : ''
            }
       from increment_case c join employee e on e.company_id = c.company_id and e.id = c.employee_id
      where ${scope} ${stateFilter} order by e.employee_code, c.created_at`,
    params.values,
  );
  if (withHistory || !withSalary) return { items: rows.rows };
  const OPEN = ['DRAFT', 'SUBMITTED', 'RETURNED'];
  return {
    items: rows.rows.map((r: Record<string, unknown>) => {
      if (OPEN.includes(String(r.state))) return r;
      const { baselineAmount: _baseline, proposedAmount: _proposed, currency: _currency, components: _components, ...kept } = r;
      return kept;
    }),
  };
}
