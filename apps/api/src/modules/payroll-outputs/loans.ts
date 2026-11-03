// Loans and salary advances (FR-034; H3 TN15; BR-011/BR-012; C4; DF07). Migration 0046_payroll_loans.
//
// Journey: request (the employee in the Employee OWN context, or an eligible Admin for the employee, one at a time or
// by the LOAN_REQUESTS_V1 upload, loan-import.ts, which applies exactly the same rules per row) -> independent
// decision by an eligible Admin with row scope (never the requester or the beneficiary), which fixes the terms: the
// recovery deduction head and the instalment schedule recovering exactly the principal -> disbursement recorded only
// from released, verified evidence by a further independent Admin (never the decider) -> recovery recognised only from
// frozen payroll: the PROCESSED_LOCKED payroll line of the loan's recovery head, once per loan and record, never above
// the outstanding balance (the database refuses anything else). A cancelled or returned run never reaches
// PROCESSED_LOCKED, so it never advances recovery. The instalment is entered into payroll as an approved input of the
// recovery head through the core's input approval (no automatic deduction here); the core's calculation blocks a line
// the loan does not cover and its processing checks again (payroll/calculate.ts loanRecoveryBreaches). No interest rate
// and no early-settlement rule is configured, so a request with interest is refused (INTEREST_NOT_CONFIGURED) and there
// is no loan early-settlement route; the balance shown is principal minus recognised recoveries minus what payroll has
// deducted and is not yet recognised (payroll/common.ts loanOutstandingSql, the core's own check). The full-and-final
// settlement detail shows the outstanding balances read-only (FR-034 "settlement shows remaining balance";
// outstandingLoans); it computes no recovery.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { type AccessGrant, employeeScopePredicate, SqlParams } from '../access/authorize.js';
import {
  actorOf,
  advisoryLock,
  assertInScope,
  assertNotSelf,
  audit,
  checkAmount,
  LOAN_LINE_COUNTS,
  loanAwaitingRecognitionSql,
  loanOutstandingSql,
  optionalKey,
  requireDate,
  requireRunScope,
  requireText,
  requireVerifiedEvidence,
  unrestricted,
  userIsEmployee,
} from '../payroll/common.js';
import { ownEmployee } from './payslips.js';

/** Recoveries recognised per call (CP-08 bounded work; an engineering bound). */
export const RECOVERY_CHUNK = 500;

const stale = (): never => {
  throw new HttpError(409, 'STALE_VERSION', 'The record changed; reload and retry');
};

const reassertLoan = (tx: Queryable, grant: AccessGrant, action: 'request' | 'decide' | 'disburse' | 'recover') => reassertAccess(tx, grant, 'payroll_loan', action, ['loan']);

/** The currency's minor unit from an active payroll calendar of the company (nothing is defaulted). */
async function minorUnit(db: Queryable, companyId: string, currency: string): Promise<number> {
  const r = (
    await db.query<{ m: number }>(`select currency_minor_unit as m from payroll_calendar where company_id = $1 and currency_code = $2 and state = 'ACTIVE' order by created_at limit 1`, [
      companyId,
      currency,
    ])
  ).rows[0];
  if (!r) throw new HttpError(422, 'CURRENCY_NOT_CONFIGURED', 'No active payroll calendar pays in this currency');
  return r.m;
}

export interface LoanRequestInput {
  loanKind: 'LOAN' | 'ADVANCE';
  currencyCode: string;
  principal: string;
  purpose: string;
  interestRate?: string | undefined;
  idempotencyKey?: string | undefined;
}

async function insertRequest(tx: Queryable, grant: AccessGrant, employeeId: string, origin: 'EMPLOYEE' | 'ADMIN', input: LoanRequestInput) {
  // FR-034 "define interest ... rules if required": no approved, configured rate exists, so interest is never applied.
  if (input.interestRate !== undefined) throw new HttpError(409, 'INTEREST_NOT_CONFIGURED', 'No approved interest rate is configured; loans carry no interest');
  const key = optionalKey(input.idempotencyKey);
  await advisoryLock(tx, `payroll_loan:${grant.companyId}:${employeeId}`);
  if (key) {
    const prior = (await tx.query<{ id: string; employee_id: string; requested_by: string }>(`select id, employee_id, requested_by from payroll_loan where company_id = $1 and idempotency_key = $2`, [grant.companyId, key])).rows[0];
    if (prior) {
      if (prior.employee_id !== employeeId || prior.requested_by !== grant.userId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another request');
      return { id: prior.id, replayed: true };
    }
  }
  const currency = input.currencyCode.trim().toUpperCase();
  const principal = checkAmount(input.principal, await minorUnit(tx, grant.companyId, currency), { field: 'principal' });
  const purpose = requireText(input.purpose, 'purpose', 1000, 'PURPOSE_REQUIRED');
  const id = (
    await tx.query<{ id: string }>(
      `insert into payroll_loan (company_id, employee_id, loan_kind, request_origin, currency_code, principal, purpose, idempotency_key, requested_by, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6::numeric, $7, $8, $9, $9, $9) returning id`,
      [grant.companyId, employeeId, input.loanKind, origin, currency, principal, purpose, key, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, actorOf(grant), 'payroll_loan', id, 'REQUEST', null, { operational: { loanKind: input.loanKind, origin }, loan: { principal, currencyCode: currency, purpose } });
  return { id, replayed: false };
}

/** TN15: the employee's own request (Employee OWN context). */
export async function requestOwnLoan(tx: Queryable, grant: AccessGrant, input: LoanRequestInput) {
  const employeeId = ownEmployee(grant);
  await reassertAccess(tx, grant, 'own_loan', 'request', ['loan']);
  const r = await insertRequest(tx, grant, employeeId, 'EMPLOYEE', input);
  return { ...(await ownLoanView(tx, grant.companyId, employeeId, r.id)), replayed: r.replayed };
}

/**
 * An eligible Admin enters a request for an employee in row scope (never their own): every rule of
 * POST /payroll-outputs/employees/:id/loans, and of each row of the loan upload (loan-import.ts), which calls this too.
 * The request is REQUESTED and waits for the independent decision (decideLoan); nothing here approves it.
 */
export async function enterLoanFor(tx: Queryable, grant: AccessGrant, employeeId: string, input: LoanRequestInput) {
  await assertInScope(tx, grant, employeeId);
  assertNotSelf(grant, employeeId);
  await reassertLoan(tx, grant, 'request');
  if (await userIsEmployee(tx, grant.companyId, grant.userId, employeeId)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
  return insertRequest(tx, grant, employeeId, 'ADMIN', input);
}

/** The single Admin-entered request (enterLoanFor), answered with the loan's detail. */
export async function requestLoanFor(tx: Queryable, grant: AccessGrant, employeeId: string, input: LoanRequestInput) {
  const r = await enterLoanFor(tx, grant, employeeId, input);
  return { ...(await loanDetail(tx, grant, r.id)), replayed: r.replayed };
}

interface LoanRow {
  id: string;
  employee_id: string;
  state: string;
  currency_code: string;
  principal: string;
  requested_by: string;
  decided_by: string | null;
  disbursement_evidence_key: string | null;
  recovery_component_id: string | null;
  version: number;
}

async function lockLoan(tx: Queryable, grant: AccessGrant, loanId: string): Promise<LoanRow> {
  const l = (
    await tx.query<LoanRow>(
      `select id, employee_id, state, currency_code, principal::text as principal, requested_by, decided_by, disbursement_evidence_key, recovery_component_id, version
         from payroll_loan where company_id = $1 and id = $2 for update`,
      [grant.companyId, loanId],
    )
  ).rows[0];
  if (!l) throw notFound();
  await assertInScope(tx, grant, l.employee_id);
  return l;
}

async function assertIndependent(tx: Queryable, grant: AccessGrant, l: LoanRow) {
  assertNotSelf(grant, l.employee_id);
  if (await userIsEmployee(tx, grant.companyId, grant.userId, l.employee_id)) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'The beneficiary never decides or records their own loan');
}

/** TN15: the employee withdraws their own undecided request. */
export async function withdrawOwnLoan(tx: Queryable, grant: AccessGrant, loanId: string, input: { reason: string; expectedVersion: number }) {
  const employeeId = ownEmployee(grant);
  const l = (await tx.query<LoanRow>(`select id, employee_id, state, requested_by, version from payroll_loan where company_id = $1 and id = $2 and employee_id = $3 for update`, [grant.companyId, loanId, employeeId])).rows[0];
  if (!l) throw notFound();
  await reassertAccess(tx, grant, 'own_loan', 'request', ['loan']);
  if (l.version !== input.expectedVersion) stale();
  if (l.state !== 'REQUESTED') throw new HttpError(409, 'INVALID_STATE', 'Only an undecided request is withdrawn');
  if (l.requested_by !== grant.userId) throw new HttpError(403, 'NOT_REQUESTER', 'Only the requester withdraws a request');
  const reason = requireText(input.reason, 'reason', 1000);
  await tx.query(`update payroll_loan set state = 'WITHDRAWN', closed_at = now(), closed_by = $3, close_reason = $4, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, loanId, grant.userId, reason]);
  await audit(tx, actorOf(grant), 'payroll_loan', loanId, 'WITHDRAW', { operational: { state: 'REQUESTED' } }, { operational: { state: 'WITHDRAWN' } });
  return ownLoanView(tx, grant.companyId, employeeId, loanId);
}

export interface DecisionInput {
  decision: 'APPROVE' | 'REJECT';
  reason?: string | undefined;
  recoveryComponentCode?: string | undefined;
  installments?: { dueMonth: string; amount: string }[] | undefined;
  expectedVersion: number;
}

/** Independent decision; an approval fixes the recovery head and the schedule, which never change afterwards. */
export async function decideLoan(tx: Queryable, grant: AccessGrant, loanId: string, input: DecisionInput) {
  const l = await lockLoan(tx, grant, loanId);
  await reassertLoan(tx, grant, 'decide');
  await assertIndependent(tx, grant, l);
  if (l.requested_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The requester of a loan does not decide it');
  if (l.version !== input.expectedVersion) stale();
  if (l.state !== 'REQUESTED') throw new HttpError(409, 'INVALID_STATE', 'Only an undecided request is decided');
  if (input.decision === 'REJECT') {
    const reason = requireText(input.reason, 'reason', 1000);
    await tx.query(`update payroll_loan set state = 'REJECTED', decided_by = $3, decided_assignment_id = $4, decided_at = now(), decision_reason = $5, updated_by = $3 where company_id = $1 and id = $2`, [
      grant.companyId,
      loanId,
      grant.userId,
      grant.assignmentId,
      reason,
    ]);
    await audit(tx, actorOf(grant), 'payroll_loan', loanId, 'REJECT', { operational: { state: 'REQUESTED' } }, { operational: { state: 'REJECTED' } }, reason);
    return loanDetail(tx, grant, loanId);
  }
  const code = (input.recoveryComponentCode ?? '').trim().toUpperCase();
  // The recovery head: a deduction head valued from approved inputs (the instalment enters payroll as such an input).
  const component = (
    await tx.query<{ id: string }>(
      `select c.id from pay_component c where c.company_id = $1 and c.code = $2 and c.component_kind = 'DEDUCTION'
          and exists (select 1 from payroll_head_revision h where h.company_id = c.company_id and h.component_id = c.id and h.state = 'ACTIVE' and h.in_use
                         and h.head_type = 'DEDUCTION' and h.calculation_basis = 'INPUT')`,
      [grant.companyId, code],
    )
  ).rows[0];
  if (!component) throw new HttpError(422, 'RECOVERY_HEAD_REQUIRED', 'An approval names an active deduction head valued from inputs as the recovery head');
  const inUse = await tx.query(`select 1 from payroll_loan where company_id = $1 and employee_id = $2 and recovery_component_id = $3 and state in ('APPROVED', 'DISBURSED')`, [
    grant.companyId,
    l.employee_id,
    component.id,
  ]);
  if (inUse.rowCount) throw new HttpError(409, 'RECOVERY_HEAD_IN_USE', 'Another live loan of this employee recovers through the same head');
  const minor = await minorUnit(tx, grant.companyId, l.currency_code);
  const list = input.installments ?? [];
  if (list.length === 0) throw new HttpError(422, 'SCHEDULE_REQUIRED', 'An approval fixes the recovery schedule');
  const businessMonth = `${grant.businessDate.slice(0, 7)}-01`;
  const rows = list.map((i, n) => {
    if (!/^\d{4}-\d{2}$/.test(i.dueMonth)) throw new HttpError(422, 'INVALID_DUE_MONTH', 'A due month is YYYY-MM');
    const due = requireDate(`${i.dueMonth}-01`, 'due month', 'INVALID_DUE_MONTH');
    return { sequence: n + 1, due, amount: checkAmount(i.amount, minor, { field: 'installment amount' }) };
  });
  for (let n = 0; n < rows.length; n++) {
    if (rows[n]!.due < businessMonth) throw new HttpError(422, 'INVALID_DUE_MONTH', 'Instalments fall due from the current month on');
    if (n > 0 && rows[n]!.due <= rows[n - 1]!.due) throw new HttpError(422, 'INVALID_DUE_MONTH', 'Instalments fall due in increasing months, one per month');
  }
  const exact = (await tx.query<{ ok: boolean }>(`select coalesce(sum(x), 0) = $2::numeric as ok from unnest($1::numeric[]) x`, [rows.map((r) => r.amount), l.principal])).rows[0]!.ok;
  if (!exact) throw new HttpError(422, 'SCHEDULE_NOT_BALANCED', 'The instalments recover exactly the principal');
  const reason = input.reason === undefined ? null : requireText(input.reason, 'reason', 1000);
  await tx.query(
    `update payroll_loan set state = 'APPROVED', recovery_component_id = $3, decided_by = $4, decided_assignment_id = $5, decided_at = now(), decision_reason = $6, updated_by = $4
      where company_id = $1 and id = $2`,
    [grant.companyId, loanId, component.id, grant.userId, grant.assignmentId, reason],
  );
  await tx.query(
    `insert into payroll_loan_installment (company_id, loan_id, sequence, due_month, amount, created_by)
     select $1, $2, s, d, a, $3 from unnest($4::int[], $5::date[], $6::numeric[]) as x (s, d, a)`,
    [grant.companyId, loanId, grant.userId, rows.map((r) => r.sequence), rows.map((r) => r.due), rows.map((r) => r.amount)],
  );
  await audit(tx, actorOf(grant), 'payroll_loan', loanId, 'APPROVE', { operational: { state: 'REQUESTED' } }, {
    operational: { state: 'APPROVED', recoveryHead: code, installments: rows.length },
    loan: { schedule: rows.map((r) => ({ dueMonth: r.due.slice(0, 7), amount: r.amount })) },
  });
  return loanDetail(tx, grant, loanId);
}

/** An approved loan not yet disbursed is cancelled with a reason (by someone holding the decision duty). */
export async function cancelLoan(tx: Queryable, grant: AccessGrant, loanId: string, input: { reason: string; expectedVersion: number }) {
  const l = await lockLoan(tx, grant, loanId);
  await reassertLoan(tx, grant, 'decide');
  await assertIndependent(tx, grant, l);
  if (l.version !== input.expectedVersion) stale();
  if (l.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only an approved loan that is not disbursed is cancelled');
  const reason = requireText(input.reason, 'reason', 1000);
  await tx.query(`update payroll_loan set state = 'CANCELLED', closed_at = now(), closed_by = $3, close_reason = $4, updated_by = $3 where company_id = $1 and id = $2`, [grant.companyId, loanId, grant.userId, reason]);
  await audit(tx, actorOf(grant), 'payroll_loan', loanId, 'CANCEL', { operational: { state: 'APPROVED' } }, { operational: { state: 'CANCELLED' } }, reason);
  return loanDetail(tx, grant, loanId);
}

export interface DisbursementInput {
  disbursementDate: string;
  evidenceKey: string;
  evidenceReference: string;
  evidenceDocumentIds: string[];
  expectedVersion: number;
}

/** DF07: a disbursement is a recorded outcome with its evidence, by an Admin independent of requester and decider. */
export async function disburseLoan(tx: Queryable, grant: AccessGrant, loanId: string, input: DisbursementInput) {
  const l = await lockLoan(tx, grant, loanId);
  await reassertLoan(tx, grant, 'disburse');
  await assertIndependent(tx, grant, l);
  const key = optionalKey(input.evidenceKey);
  if (!key) throw new HttpError(422, 'EVIDENCE_KEY_REQUIRED', 'A disbursement carries its evidence key');
  const prior = (await tx.query<{ id: string }>(`select id from payroll_loan where company_id = $1 and disbursement_evidence_key = $2`, [grant.companyId, key])).rows[0];
  if (prior) {
    if (prior.id !== loanId) throw new HttpError(409, 'EVIDENCE_KEY_REUSED', 'This evidence key already recorded another disbursement');
    return { ...(await loanDetail(tx, grant, loanId)), replayed: true };
  }
  if (l.requested_by === grant.userId || l.decided_by === grant.userId) throw new HttpError(403, 'NOT_INDEPENDENT', 'The requester and the decider of a loan do not record its disbursement');
  if (l.version !== input.expectedVersion) stale();
  if (l.state !== 'APPROVED') throw new HttpError(409, 'INVALID_STATE', 'Only an approved loan is disbursed');
  const date = requireDate(input.disbursementDate, 'disbursement date');
  if (date > grant.businessDate) throw new HttpError(422, 'DISBURSEMENT_IN_FUTURE', 'A disbursement is recorded once it has happened');
  const reference = requireText(input.evidenceReference, 'evidence reference', 500, 'EVIDENCE_REQUIRED');
  const docs = await requireVerifiedEvidence(tx, grant.companyId, l.employee_id, input.evidenceDocumentIds, { required: true });
  if (docs.length !== 1) throw new HttpError(422, 'ONE_EVIDENCE_DOCUMENT', 'A disbursement is evidenced by one released, verified document');
  await tx.query(
    `update payroll_loan set state = 'DISBURSED', disbursement_date = $3, disbursement_evidence_key = $4, disbursement_reference = $5, disbursement_document_id = $6,
            disbursed_by = $7, disbursed_assignment_id = $8, disbursed_at = now(), updated_by = $7
      where company_id = $1 and id = $2`,
    [grant.companyId, loanId, date, key, reference, docs[0], grant.userId, grant.assignmentId],
  );
  await audit(tx, actorOf(grant), 'payroll_loan', loanId, 'DISBURSE', { operational: { state: 'APPROVED' } }, { operational: { state: 'DISBURSED', disbursementDate: date, evidenceDocuments: 1 } });
  return { ...(await loanDetail(tx, grant, loanId)), replayed: false };
}

/**
 * Recognises the recoveries of a processed run: for each disbursed loan of an employee in the run, the frozen line of
 * its recovery head (bounded per call; `remaining` > 0 means call again). A line of a run processed before the loan was
 * disbursed was no recovery of it. A line above the outstanding balance, which only a run processed before the
 * calculation refused one can hold, is not recognised and is reported for a later-period correction (FR-034 "recovery
 * does not exceed outstanding balance").
 */
export async function recognizeRecoveries(tx: Queryable, grant: AccessGrant, runId: string) {
  const run = (await tx.query<{ state: string }>(`select state from payroll_run where company_id = $1 and id = $2`, [grant.companyId, runId])).rows[0];
  if (!run) throw notFound();
  await requireRunScope(tx, grant, runId);
  await advisoryLock(tx, `payroll_loan_recovery:${grant.companyId}:${runId}`);
  await reassertLoan(tx, grant, 'recover');
  if (run.state !== 'PROCESSED_LOCKED') throw new HttpError(409, 'RUN_NOT_PROCESSED', 'Recoveries come from PROCESSED_LOCKED payroll only');
  const pending = `from payroll_loan l
      join payroll_record r on r.company_id = l.company_id and r.employee_id = l.employee_id and r.run_id = $2 and r.calculation_status = 'CALCULATED' and r.frozen_at is not null
      join payroll_run ru on ru.company_id = r.company_id and ru.id = r.run_id
      join payroll_line pl on pl.company_id = r.company_id and pl.record_id = r.id and pl.amount > 0
     where l.company_id = $1 and l.state = 'DISBURSED' and ${LOAN_LINE_COUNTS('l', 'ru', 'pl')}
       and not exists (select 1 from payroll_loan_recovery x where x.company_id = l.company_id and x.loan_id = l.id and x.payroll_record_id = r.id)
       and not exists (select 1 from user_employee_link u where u.company_id = l.company_id and u.user_id = $3 and u.employee_id = l.employee_id)`;
  // A line above the outstanding balance (or in another currency) is never recognised; it is reported, and it never
  // occupies a chunk, so the recognisable lines always progress.
  const within = `pl.amount <= l.principal - l.recovered_amount and r.currency_code = l.currency_code`;
  const rows = (
    await tx.query<{ loan_id: string; employee_id: string; record_id: string; line_id: string; amount: string; currency_code: string }>(
      `select l.id as loan_id, l.employee_id, r.id as record_id, pl.id as line_id, pl.amount::text as amount, l.currency_code
         ${pending} and ${within} order by r.employee_code, l.id limit ${RECOVERY_CHUNK} for update of l`,
      [grant.companyId, runId, grant.userId],
    )
  ).rows;
  const exceptions = (
    await tx.query<{ loanId: string; employeeCode: string; code: string }>(
      `select l.id as "loanId", r.employee_code as "employeeCode", 'RECOVERY_EXCEEDS_OUTSTANDING' as code
         ${pending} and not (${within}) order by r.employee_code, l.id limit ${RECOVERY_CHUNK}`,
      [grant.companyId, runId, grant.userId],
    )
  ).rows;
  const recognised: string[] = [];
  for (const x of rows) {
    await tx.query(
      `insert into payroll_loan_recovery (company_id, loan_id, employee_id, payroll_record_id, run_id, payroll_line_id, amount, currency_code, recorded_by)
       values ($1, $2, $3, $4, $5, $6, $7::numeric, $8, $9)`,
      [grant.companyId, x.loan_id, x.employee_id, x.record_id, runId, x.line_id, x.amount, x.currency_code, grant.userId],
    );
    recognised.push(x.loan_id);
  }
  // A fully recovered loan is closed.
  const closed = recognised.length
    ? (
        await tx.query<{ id: string }>(
          `update payroll_loan set state = 'CLOSED', closed_at = now(), closed_by = $3, close_reason = 'Fully recovered', updated_by = $3
            where company_id = $1 and id = any($2::uuid[]) and state = 'DISBURSED' and recovered_amount = principal returning id`,
          [grant.companyId, recognised, grant.userId],
        )
      ).rows.map((r) => r.id)
    : [];
  if (recognised.length > 0 || exceptions.length > 0) {
    await audit(tx, actorOf(grant), 'payroll_run', runId, 'LOAN_RECOVERIES', null, { operational: { recognised: recognised.length, closed: closed.length, exceptions: exceptions.length } });
  }
  const remaining = rows.length < RECOVERY_CHUNK ? 0 : (await tx.query<{ n: number }>(`select count(*)::int as n ${pending} and ${within}`, [grant.companyId, runId, grant.userId])).rows[0]!.n;
  return { runId, recognised: recognised.length, closed: closed.length, exceptions, remaining, done: remaining === 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------------------------

const LOAN_VIEW = `select l.id, l.employee_id as "employeeId", e.employee_code as "employeeCode", l.loan_kind as "loanKind", l.request_origin as "requestOrigin",
    l.currency_code as "currencyCode", l.principal::text as principal, l.purpose, l.state, l.requested_at as "requestedAt", c.code as "recoveryHead",
    l.decided_at as "decidedAt", l.decision_reason as "decisionReason", to_char(l.disbursement_date, 'YYYY-MM-DD') as "disbursementDate",
    l.disbursement_reference as "disbursementReference", l.recovered_amount::text as recovered, ${loanAwaitingRecognitionSql('l')}::text as "awaitingRecognition", ${loanOutstandingSql('l')}::text as outstanding,
    l.closed_at as "closedAt", l.close_reason as "closeReason", l.version, l.requested_by as "requestedBy", l.decided_by as "decidedBy", l.disbursed_by as "disbursedBy"
  from payroll_loan l join employee e on e.company_id = l.company_id and e.id = l.employee_id
  left join pay_component c on c.company_id = l.company_id and c.id = l.recovery_component_id`;

async function schedule(db: Queryable, companyId: string, loanId: string) {
  const installments = (
    await db.query(
      `select sequence, to_char(due_month, 'YYYY-MM') as "dueMonth", amount::text as amount from payroll_loan_installment where company_id = $1 and loan_id = $2 order by sequence`,
      [companyId, loanId],
    )
  ).rows;
  const recoveries = (
    await db.query(
      `select x.id, p.period_code as "periodCode", x.run_id as "runId", x.amount::text as amount, x.created_at as "recognisedAt"
         from payroll_loan_recovery x join payroll_run ru on ru.company_id = x.company_id and ru.id = x.run_id
         join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
        where x.company_id = $1 and x.loan_id = $2 order by x.created_at, x.id`,
      [companyId, loanId],
    )
  ).rows;
  return { installments, recoveries };
}

export async function loanDetail(db: Queryable, grant: AccessGrant, loanId: string) {
  const l = (await db.query<{ employeeId: string }>(`${LOAN_VIEW} where l.company_id = $1 and l.id = $2`, [grant.companyId, loanId])).rows[0];
  if (!l) throw notFound();
  await assertInScope(db, grant, l.employeeId);
  assertNotSelf(grant, l.employeeId);
  return { ...l, ...(await schedule(db, grant.companyId, loanId)) };
}

/** Loans answered without page/pageSize (the list's first answer before it could page). */
export const LOAN_LIST_CAP = 500;

/**
 * Loans within row scope (never the caller's own), newest request first: one page (FR-056), or the first 500 without
 * page/pageSize; `total` counts every match the caller may see.
 */
export async function listLoans(db: Queryable, grant: AccessGrant, q: { state?: string | undefined; employeeId?: string | undefined } & Paging) {
  const params = new SqlParams([grant.companyId]);
  const where = ['l.company_id = $1'];
  if (!unrestricted(grant)) where.push(employeeScopePredicate(grant, { company: 'l.company_id', employee: 'l.employee_id' }, params));
  if (grant.linkedEmployeeId) where.push(`l.employee_id <> ${params.add(grant.linkedEmployeeId)}::uuid`);
  if (q.state) where.push(`l.state = ${params.add(q.state)}`);
  if (q.employeeId) where.push(`l.employee_id = ${params.add(q.employeeId)}::uuid`);
  return pageOf(db, `${LOAN_VIEW} where ${where.join(' and ')}`, params.values, '"requestedAt" desc, id', q, LOAN_LIST_CAP);
}

const OWN_VIEW = `select l.id, l.loan_kind as "loanKind", l.request_origin as "requestOrigin", l.currency_code as "currencyCode", l.principal::text as principal, l.purpose,
    l.state, l.requested_at as "requestedAt", l.decided_at as "decidedAt", l.decision_reason as "decisionReason", to_char(l.disbursement_date, 'YYYY-MM-DD') as "disbursementDate",
    l.recovered_amount::text as recovered, ${loanAwaitingRecognitionSql('l')}::text as "awaitingRecognition", ${loanOutstandingSql('l')}::text as outstanding, l.closed_at as "closedAt", l.version
  from payroll_loan l`;

async function ownLoanView(db: Queryable, companyId: string, employeeId: string, loanId: string) {
  const l = (await db.query(`${OWN_VIEW} where l.company_id = $1 and l.employee_id = $2 and l.id = $3`, [companyId, employeeId, loanId])).rows[0];
  if (!l) throw notFound();
  return { ...l, ...(await schedule(db, companyId, loanId)) };
}

/**
 * FR-034 "settlement shows remaining balance": the employee's disbursed loans and advances not yet fully recovered,
 * with the balance as the loan views and the payroll calculation compute it (loanOutstandingSql, so a settlement never
 * asks again for what a processed run has already deducted), oldest disbursement first.
 * Confidential values: the caller has checked access to the employee and holds a confidential grant that covers them.
 */
export async function outstandingLoans(db: Queryable, companyId: string, employeeId: string) {
  return (
    await db.query<{ id: string; loanKind: string; currencyCode: string; principal: string; recovered: string; awaitingRecognition: string; outstanding: string; disbursementDate: string }>(
      `select l.id, l.loan_kind as "loanKind", l.currency_code as "currencyCode", l.principal::text as principal, l.recovered_amount::text as recovered,
              ${loanAwaitingRecognitionSql('l')}::text as "awaitingRecognition", ${loanOutstandingSql('l')}::text as outstanding,
              to_char(l.disbursement_date, 'YYYY-MM-DD') as "disbursementDate"
         from payroll_loan l
        where l.company_id = $1 and l.employee_id = $2 and l.state = 'DISBURSED'
        order by l.disbursement_date, l.id`,
      [companyId, employeeId],
    )
  ).rows;
}

/** TN15: own loans with terms, decisions, disbursement date, schedule, recoveries and balance (reviewer identities are not shown). */
export async function ownLoans(db: Queryable, grant: AccessGrant) {
  const employeeId = ownEmployee(grant);
  const rows = (await db.query<{ id: string }>(`${OWN_VIEW} where l.company_id = $1 and l.employee_id = $2 order by l.requested_at desc, l.id`, [grant.companyId, employeeId])).rows;
  const items = [];
  for (const r of rows) items.push({ ...r, ...(await schedule(db, grant.companyId, r.id)) });
  return { items, interest: { status: 'NOT_CONFIGURED' }, earlySettlement: { status: 'NOT_CONFIGURED' } };
}
