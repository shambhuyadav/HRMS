// Shared helpers of the payroll module: scope and independence checks, typed-root state changes, audit, outbox,
// approval-task lookups, evidence and decimal validation. Everything runs inside the caller's transaction. Amounts are
// exact decimal strings; arithmetic on them runs in PostgreSQL numeric, never in JavaScript numbers.
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, canAccessEmployee, employeeScopePredicate, resolveAccess, SqlParams } from '../access/authorize.js';
import { linkEvidence, MAX_EVIDENCE_DOCUMENTS } from '../employee/evidence.js';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Actor {
  companyId: string;
  userId: string;
  assignmentId: string | null;
}

export const actorOf = (grant: AccessGrant): Actor => ({ companyId: grant.companyId, userId: grant.userId, assignmentId: grant.assignmentId });

/** A real calendar date in ISO form (no silent roll-over such as 2026-02-30). */
export const isIsoDate = (v: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export function requireDate(value: string, field: string, code = 'INVALID_DATE'): string {
  if (!isIsoDate(value)) throw new HttpError(422, code, `The ${field} is not a valid date`, { field });
  return value;
}

/** Calendar arithmetic on dates (UTC, so no zone shift). */
export const addDays = (d: string, n: number): string => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export const holds = (grant: AccessGrant, group: string): boolean => grant.allowedFieldGroups.includes(group);

/** Company-wide configuration needs an unrestricted company-scope assignment. */
export function requireCompanyScope(grant: AccessGrant): void {
  if (!unrestricted(grant)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
}

/** A company-scope assignment without row filters sees every employee of the company. */
export function unrestricted(grant: AccessGrant): boolean {
  const { departments, locations, employees } = grant.filters;
  return grant.scopeKind === 'COMPANY' && departments.length + locations.length + employees.length === 0;
}

/** Row scope: an employee outside the caller's scope reads as missing (never reveals existence). */
export async function assertInScope(db: Queryable, grant: AccessGrant, employeeId: string): Promise<void> {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
}

/** DF02/C4: an administrator never prepares, decides or reads payroll about their own record in this context. */
export function assertNotSelf(grant: AccessGrant, employeeId: string): void {
  if (grant.linkedEmployeeId === employeeId) throw new HttpError(403, 'SELF_ACTION_NOT_ALLOWED', 'You cannot act on your own record in this context');
}

/** Whether a user is or was linked to an employee (C4 self check, as the approval decision guard applies it). */
export async function userIsEmployee(db: Queryable, companyId: string, userId: string, employeeId: string): Promise<boolean> {
  const r = await db.query(`select 1 from user_employee_link where company_id = $1 and user_id = $2 and employee_id = $3`, [companyId, userId, employeeId]);
  return (r.rowCount ?? 0) > 0;
}

/** Every user ever linked to one of the employees (excluded from deciding about them). */
export async function usersLinkedTo(db: Queryable, companyId: string, employeeIds: readonly string[]): Promise<string[]> {
  if (employeeIds.length === 0) return [];
  return (
    await db.query<{ user_id: string }>(`select distinct user_id from user_employee_link where company_id = $1 and employee_id = any($2::uuid[])`, [companyId, employeeIds])
  ).rows.map((r) => r.user_id);
}

/** Serialises work on one key for the rest of the transaction. */
export async function advisoryLock(tx: Queryable, key: string): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended($1, 0))`, [key]);
}

/**
 * Serialises, for a company and a service month whatever the calendar, input entry and the approval of inputs and
 * salary stops with the start of a calculation or of processing. The snapshot check (snapshotTaken) and the
 * other-calendar discrepancy checks of the calculation are per service month, so the lock is too: an approval under
 * another calendar's period of the month can never slip past a calculation start unseen.
 */
export const lockServiceMonth = (tx: Queryable, companyId: string, serviceMonth: string) => advisoryLock(tx, `payroll_inputs:${companyId}:${serviceMonth}`);

export type RootTable = 'payroll_run' | 'payroll_run_approval' | 'payroll_record_cover' | 'payroll_input_batch' | 'payroll_salary_stop' | 'payroll_hold';

/** Moves a typed root and its business transaction to a new state (the deferred mirror checks they agree). */
export async function setRootState(
  tx: Queryable,
  table: RootTable,
  companyId: string,
  row: { id: string; transaction_id: string },
  state: string,
  actorUserId: string,
  extra = '',
  extraValues: unknown[] = [],
): Promise<void> {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, row.transaction_id, state, actorUserId]);
  await tx.query(`update ${table} set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2`, [companyId, row.id, state, actorUserId, ...extraValues]);
}

/** Creates the business transaction of a new typed root (the root row must follow in the same transaction). */
export async function newTransaction(tx: Queryable, companyId: string, kind: string, ownerEmployeeId: string | null, state: string, actorUserId: string): Promise<string> {
  return (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, $4, $5, $5) returning id`,
      [companyId, kind, ownerEmployeeId, state, actorUserId],
    )
  ).rows[0]!.id;
}

/**
 * Audit entry. Operational facts go under `operational`; amounts only ever under the confidential group they
 * belong to (`amount` or `hold`), never under `operational`.
 */
export async function audit(
  tx: Queryable,
  actor: Actor,
  resource: string,
  recordKey: string,
  action: string,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  reason?: string | null,
): Promise<void> {
  await writeAudit(tx, {
    companyId: actor.companyId,
    resource,
    recordKey,
    actorUserId: actor.userId,
    actingAssignmentId: actor.assignmentId,
    action,
    before,
    after,
    reason: reason ?? null,
  });
}

/** Outbox event: identifiers, revision, dates and outcome only (never amounts, reasons or bank values). */
export async function emit(tx: Queryable, companyId: string, topic: string, aggregateId: string, dedupe: string, payload: Record<string, string | number | null>): Promise<void> {
  await enqueueEvent(tx, { companyId, topic, aggregateId, dedupeKey: `${topic}:${dedupe}`, payload });
}

/** Like `emit`, reporting whether this occurrence is new (false when its key was already queued: a rerun). */
export async function emitOnce(tx: Queryable, companyId: string, topic: string, aggregateId: string, dedupe: string, payload: Record<string, string | number | null>): Promise<boolean> {
  const r = await tx.query(
    `insert into outbox_event (company_id, topic, aggregate_id, dedupe_key, payload) values ($1, $2, $3, $4, $5)
     on conflict (company_id, dedupe_key) do nothing returning id`,
    [companyId, topic, aggregateId, `${topic}:${dedupe}`, payload],
  );
  return (r.rowCount ?? 0) > 0;
}

/** The recorded idempotent decision for a key: the same task replays, another task is a conflict (ZT07). */
export async function priorDecision(tx: Queryable, companyId: string, idempotencyKey: string, taskId: string): Promise<boolean> {
  const replay = (await tx.query<{ task_id: string }>(`select task_id from approval_decision where company_id = $1 and idempotency_key = $2`, [companyId, idempotencyKey])).rows[0];
  if (!replay) return false;
  if (replay.task_id !== taskId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another task');
  return true;
}

export async function taskIsPending(tx: Queryable, grant: AccessGrant, taskId: string): Promise<boolean> {
  const t = await tx.query(`select 1 from approval_task where company_id = $1 and id = $2 and assignee_user_id = $3 and state = 'PENDING'`, [grant.companyId, taskId, grant.userId]);
  return (t.rowCount ?? 0) > 0;
}

/** The caller's task of one of the given kinds: its transaction (someone else's task reads as missing). */
export async function taskTransaction(tx: Queryable, grant: AccessGrant, taskId: string, kinds: readonly string[]): Promise<{ transactionId: string; kind: string }> {
  const t = (
    await tx.query<{ transaction_id: string; kind: string }>(
      `select i.transaction_id, i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [grant.companyId, taskId, grant.userId],
    )
  ).rows[0];
  if (!t || !kinds.includes(t.kind)) throw notFound();
  return { transactionId: t.transaction_id, kind: t.kind };
}

/** The pending task of a transaction's active approval. */
export async function pendingTaskOf(db: Queryable, companyId: string, transactionId: string): Promise<string | null> {
  const r = (
    await db.query<{ id: string }>(
      `select t.id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
        where i.company_id = $1 and i.transaction_id = $2 and t.state = 'PENDING' order by t.created_at desc limit 1`,
      [companyId, transactionId],
    )
  ).rows[0];
  return r?.id ?? null;
}

/**
 * docs/03 I-57 item 7 (decided under owner delegation; see the builder report): a decision a delegate takes under a delegation is
 * the delegator's for every payroll independence check, as the workflow engine already treats it for later steps
 * (engine.ts priorDecidersOf). The delegators of the delegated decisions taken in the given transactions.
 */
export async function decisionDelegators(db: Queryable, companyId: string, transactionIds: readonly string[], opts: { approvedOnly?: boolean } = {}): Promise<string[]> {
  if (transactionIds.length === 0) return [];
  return (
    await db.query<{ u: string }>(
      `select distinct dl.delegator_user_id as u
         from approval_instance i
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
         join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id
        where i.company_id = $1 and i.transaction_id = any($2::uuid[]) and ($3::boolean is false or d.decision = 'APPROVE')`,
      [companyId, transactionIds, opts.approvedOnly === true],
    )
  ).rows.map((r) => r.u);
}

/**
 * I-57 item 7: the person a task is decided for when it was routed under a delegation (its delegate decides in their name), or
 * null. Every independence check of a decision applies to them as it does to the delegate who acts.
 */
export async function taskDelegator(db: Queryable, companyId: string, taskId: string): Promise<string | null> {
  return (
    (
      await db.query<{ u: string }>(
        `select dl.delegator_user_id as u from approval_task t join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id where t.company_id = $1 and t.id = $2`,
        [companyId, taskId],
      )
    ).rows[0]?.u ?? null
  );
}

/** Decision history of transactions: step action, decision and time only (the decider's private reason stays out). */
export async function decisionTrail(db: Queryable, companyId: string, transactionIds: readonly string[]) {
  if (transactionIds.length === 0) return [];
  return (
    await db.query<{ transactionKind: string; action: string; decision: string; decidedAt: Date }>(
      `select i.transaction_kind as "transactionKind", p.action, d.decision, d.occurred_at as "decidedAt"
         from approval_instance i
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
         join workflow_step s on s.company_id = t.company_id and s.id = t.step_id
         join permission p on p.id = s.permission_id
        where i.company_id = $1 and i.transaction_id = any($2::uuid[])
        order by d.occurred_at`,
      [companyId, transactionIds],
    )
  ).rows;
}

const DECIMAL = /^\d{1,15}(\.\d{1,4})?$/;

/**
 * A positive (or, when `allowZero`, non-negative) exact decimal with at most `minorUnit` decimals; returned as the
 * canonical text PostgreSQL will store. Never parsed into a JavaScript number.
 */
export function checkAmount(value: unknown, minorUnit: number, opts: { allowZero?: boolean; field?: string } = {}): string {
  const text = typeof value === 'string' ? value.trim() : '';
  const decimals = text.includes('.') ? text.length - text.indexOf('.') - 1 : 0;
  const zero = /^0+(\.0+)?$/.test(text);
  if (!DECIMAL.test(text) || decimals > minorUnit || (zero && !opts.allowZero)) {
    throw new HttpError(422, 'INVALID_AMOUNT', `The ${opts.field ?? 'amount'} must be a ${opts.allowZero ? 'non-negative' : 'positive'} decimal with at most ${minorUnit} decimals`, {
      field: opts.field ?? 'amount',
    });
  }
  return text;
}

/** How many of the given employees fall outside the caller's row scope (same predicate as every list). */
export async function outsideScope(db: Queryable, grant: AccessGrant, employeeIds: readonly string[]): Promise<number> {
  if (employeeIds.length === 0 || unrestricted(grant)) return 0;
  const params = new SqlParams([employeeIds]);
  const predicate = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const row = (
    await db.query<{ n: number }>(
      `select count(*)::int as n from unnest($1::uuid[]) m (id) where not exists (select 1 from employee e where e.id = m.id and ${predicate})`,
      params.values,
    )
  ).rows[0];
  return row?.n ?? employeeIds.length;
}

/** A full decision scope: every employee of the work item is inside the caller's row scope. */
export async function requireFullScope(db: Queryable, grant: AccessGrant, employeeIds: readonly string[]): Promise<void> {
  if ((await outsideScope(db, grant, employeeIds)) > 0) throw scopeIncomplete();
}

const scopeIncomplete = () =>
  new HttpError(403, 'SCOPE_INCOMPLETE', 'This work item includes employees outside your scope; it must be handled by someone whose scope covers all of them');

/**
 * Included members of a run revision outside the caller's row scope, counted in SQL over the run (never by loading
 * the member list): an unrestricted company assignment covers everyone without a query.
 */
export async function runMembersOutsideScope(db: Queryable, grant: AccessGrant, runId: string): Promise<number> {
  if (unrestricted(grant)) return 0;
  const params = new SqlParams([grant.companyId, runId]);
  const predicate = employeeScopePredicate(grant, { company: 'e.company_id', employee: 'e.id' }, params);
  const row = (
    await db.query<{ n: number }>(
      `select count(*)::int as n from payroll_run r
         join payroll_run_member m on m.company_id = r.company_id and m.lineage_id = r.lineage_id and ${INCLUDED('m', 'r')}
        where r.company_id = $1 and r.id = $2
          and not exists (select 1 from employee e where e.id = m.employee_id and ${predicate})`,
      params.values,
    )
  ).rows[0];
  return row?.n ?? 1;
}

/** SQL: member alias `m` is included in run revision alias `r` (members belong to the lineage; exclusions are dated by revision). */
export const INCLUDED = (m: string, r: string) => `(${m}.excluded_from_revision is null or ${m}.excluded_from_revision > ${r}.revision)`;

export async function requireRunScope(db: Queryable, grant: AccessGrant, runId: string): Promise<void> {
  if ((await runMembersOutsideScope(db, grant, runId)) > 0) throw scopeIncomplete();
}

/**
 * I-25 for work items without an owner employee that are about many employees (a run revision, an input batch): the
 * approval engine checks a reviewer's row scope only against an owner employee, so the routing list's candidates
 * none of whose eligible assignments covers every employee of the work item are returned here, for the caller to
 * exclude before routing. A task then never goes to someone who could not open it, and when nobody is left the
 * engine refuses the submission with NO_ELIGIBLE_REVIEWER (a repairable routing error). Each candidate assignment is
 * resolved exactly as its decision would be (step permission, DB109 entry, confidential eligibility); `outside` counts
 * the employees outside that assignment's row scope (no query for an unrestricted company assignment).
 */
export async function reviewersLackingScope(tx: Queryable, companyId: string, kind: string, outside: (grant: AccessGrant) => Promise<number>): Promise<string[]> {
  const step = (
    await tx.query<{ resource: string; action: string; field_group: string }>(
      `select p.resource, p.action, p.field_group
         from workflow_definition w
         join workflow_step s on s.company_id = w.company_id and s.workflow_id = w.id and s.condition_code is null
         join permission p on p.id = s.permission_id
        where w.company_id = $1 and w.kind = $2 and w.active and w.effective_from <= now() and (w.effective_to is null or w.effective_to > now())
        order by s.sequence limit 1`,
      [companyId, kind],
    )
  ).rows[0];
  if (!step) return [];
  const candidates = (
    await tx.query<{ user_id: string; assignment_id: string | null }>(
      `select f.user_id, ra.id as assignment_id
         from workflow_fallback_reviewer f
         left join role_assignment ra on ra.company_id = f.company_id and ra.user_id = f.user_id and ra.state = 'ACTIVE'
                                     and ra.effective_from <= now() and (ra.effective_to is null or ra.effective_to > now())
        where f.company_id = $1 and f.active and f.kind = (select coalesce(routing_kind, kind) from transaction_kind where kind = $2)
        order by f.priority, f.user_id, ra.id`,
      [companyId, kind],
    )
  ).rows;
  const covered = new Set<string>();
  for (const c of candidates) {
    if (!c.assignment_id || covered.has(c.user_id)) continue;
    const d = await resolveAccess(tx, { userId: c.user_id, companyId, assignmentId: c.assignment_id, resource: step.resource, action: step.action, fieldGroups: [step.field_group] });
    if (d.allowed && d.allowedFieldGroups.includes(step.field_group) && (await outside(d)) === 0) covered.add(c.user_id);
  }
  return [...new Set(candidates.map((c) => c.user_id))].filter((u) => !covered.has(u));
}

/**
 * H2 / BR-050: a hold, or a stop that withholds payment, is decided only under a hold criterion that is still active
 * when the decision is taken (a retired or replaced criterion withholds nothing new; the maker proposes again under
 * the active one). Share-locked, so a concurrent retirement is ordered strictly before or after the decision.
 */
export async function requireActiveCriterion(tx: Queryable, companyId: string, criterionId: string | null): Promise<void> {
  const c = criterionId
    ? (await tx.query<{ state: string }>(`select state from payroll_hold_criterion where company_id = $1 and id = $2 for share`, [companyId, criterionId])).rows[0]
    : undefined;
  if (c?.state !== 'ACTIVE') {
    throw new HttpError(409, 'HOLD_CRITERION_NOT_ACTIVE', 'The hold criterion is no longer active; withdraw the proposal and propose again under the active criterion');
  }
}

/**
 * FR-034 balance of a loan, one definition for the payroll core and the loan module. Loans belong to payroll-outputs
 * (0046), a separate module that may be inactive, but the core's calculation and processing read this too: migrations
 * always apply, so the table exists either way, and with that module inactive there are no loans and nothing is found.
 *
 * SQL over the payroll_loan alias `l`. A line counts against the loan when it is the loan's recovery head, in the
 * loan's currency, of a run whose processing started once the loan was disbursed (a started processing can only be
 * completed; a returned or cancelled revision never counts, FR-034), and no recovery was recognised from it for any
 * loan: a closed loan's lines are not the next loan's, and earlier deductions on the head were not recoveries at all.
 */
export const LOAN_LINE_COUNTS = (l: string, run: string, line: string) =>
  `${run}.processing_started_at >= ${l}.disbursed_at and ${run}.state in ('APPROVED', 'PROCESSED_LOCKED')
   and ${line}.component_id = ${l}.recovery_component_id and ${line}.head_type = 'DEDUCTION'`;

/** Deducted by payroll but not yet recognised as a recovery (recognition is a separate call, loans.ts). */
export const loanAwaitingRecognitionSql = (l: string) => `coalesce((
    select sum(lr_line.amount)
      from payroll_record lr_rec
      join payroll_run lr_run on lr_run.company_id = lr_rec.company_id and lr_run.id = lr_rec.run_id
      join payroll_line lr_line on lr_line.company_id = lr_rec.company_id and lr_line.record_id = lr_rec.id
     where lr_rec.company_id = ${l}.company_id and lr_rec.employee_id = ${l}.employee_id and lr_rec.currency_code = ${l}.currency_code
       and ${LOAN_LINE_COUNTS(l, 'lr_run', 'lr_line')}
       and not exists (select 1 from payroll_loan_recovery lr_x where lr_x.company_id = lr_line.company_id and lr_x.payroll_line_id = lr_line.id)
  ), 0)::numeric(19, 4)`;

/**
 * What is left to recover: principal minus recognised recoveries minus what payroll has already deducted. Never below
 * zero (a run processed before the calculation refused over-deductions can have taken more than the balance).
 */
export const loanOutstandingSql = (l: string) => `greatest(${l}.principal - ${l}.recovered_amount - ${loanAwaitingRecognitionSql(l)}, 0::numeric(19, 4))`;

/** A short bounded text input (reasons, references), trimmed; empty is refused. */
export function requireText(value: unknown, field: string, max: number, code = 'REASON_REQUIRED'): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '' || text.length > max) throw new HttpError(422, code, `The ${field} is required (at most ${max} characters)`, { field });
  return text;
}

/**
 * Evidence of a stop or hold case: documents of the employee concerned that the malware scan released (CLEAN) and an
 * independent verifier VERIFIED (FR-106; I-21). Anything else is refused; the ids are returned de-duplicated.
 */
export async function requireVerifiedEvidence(tx: Queryable, companyId: string, employeeId: string, documentIds: readonly string[] | undefined, opts: { required: boolean }): Promise<string[]> {
  const ids = [...new Set(documentIds ?? [])];
  if (ids.length === 0) {
    if (opts.required) throw new HttpError(422, 'EVIDENCE_REQUIRED', 'Attach at least one released and verified document of the employee as evidence');
    return ids;
  }
  if (ids.length > MAX_EVIDENCE_DOCUMENTS) throw new HttpError(422, 'TOO_MUCH_EVIDENCE', `Attach at most ${MAX_EVIDENCE_DOCUMENTS} documents`);
  const rows = (
    await tx.query<{ id: string; scan_state: string | null; verification_state: string }>(
      `select d.id, a.scan_state, d.verification_state from employee_document d join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where d.company_id = $1 and d.employee_id = $2 and d.id = any($3::uuid[])`,
      [companyId, employeeId, ids],
    )
  ).rows;
  if (rows.length !== ids.length) throw new HttpError(422, 'INVALID_EVIDENCE', 'Evidence must be documents of the employee concerned');
  if (rows.some((r) => r.scan_state !== 'CLEAN' || r.verification_state !== 'VERIFIED')) {
    throw new HttpError(422, 'EVIDENCE_NOT_VERIFIED', 'Evidence must be released by the malware scan and verified by an independent reviewer');
  }
  return ids;
}

/** Links verified evidence to a transaction revision (CI08: the transaction's owner is the employee concerned). */
export async function attachEvidence(tx: Queryable, grant: AccessGrant, transactionId: string, revision: number, employeeId: string, documentIds: readonly string[]): Promise<void> {
  await linkEvidence(tx, grant, transactionId, revision, employeeId, documentIds);
}

/** Evidence of a transaction (all revisions) as metadata only. */
export async function evidenceOf(db: Queryable, companyId: string, transactionId: string) {
  return (
    await db.query<{ revision: number; documentId: string; documentType: string; verificationState: string }>(
      `select te.transaction_revision as revision, te.document_id as "documentId", dt.code as "documentType", d.verification_state as "verificationState"
         from transaction_evidence te
         join employee_document d on d.company_id = te.company_id and d.id = te.document_id
         join reference_value dt on dt.company_id = d.company_id and dt.id = d.document_type_id
        where te.company_id = $1 and te.transaction_id = $2 order by te.transaction_revision, te.created_at`,
      [companyId, transactionId],
    )
  ).rows;
}

/** The caller's idempotency key, validated (same shape as decision keys). */
export function optionalKey(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(value)) throw new HttpError(422, 'INVALID_IDEMPOTENCY_KEY', 'The idempotency key is 8 to 100 letters, digits or ._:-');
  return value;
}
