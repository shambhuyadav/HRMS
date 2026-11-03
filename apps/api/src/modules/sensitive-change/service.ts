// Sensitive private-profile changes (FR-104, FR-105; H2 "Sensitive change"; H4; DB115/DB116; BR-053; BR-054; BR-055).
// An employee, in their own Employee OWN context, drafts a PERSONAL, ADDRESS or BANK change with a reason and evidence
// and submits it as an immutable request. An independent HR reviewer from the explicit list starts the review,
// verifies it and approves, returns or rejects. Approval re-checks the base: a changed base ends the request in
// CONFLICT (the employee rebases through a new request that supersedes it, and approval is renewed); otherwise one
// effective-dated DB116 revision is appended now (APPLIED) or by the daily job on the effective date (SCHEDULED).
// Values are sealed (security/field-crypto.ts); audit records and events carry field names and states, never values.
import { randomUUID } from 'node:crypto';
import { enqueueEvent, writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { type Database, withTransaction } from '../../db/transaction.js';
import { HttpError, notFound } from '../../http/errors.js';
import { reassertAccess } from '../../http/guard.js';
import { openJson, sealJson } from '../../security/field-crypto.js';
import { type AccessGrant, canAccessEmployee, resolveAccess, taskDelegationLive } from '../access/authorize.js';
import { type PayrollCutoffWarning, payrollCutoffWarning } from '../payroll/cutoff.js';
import { cancelActiveApproval, type Decision, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import { buildProposal, type Category, FIELDS, maskedBank, maskTail, type Values } from './fields.js';

export const SENSITIVE_CHANGE_KIND = 'sensitive_change';
const OPEN_STATES = ['DRAFT', 'SUBMITTED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED'];

interface Sealed {
  proposed: Record<string, string | null>;
  before: Record<string, string | null>;
}

interface RequestRow {
  id: string;
  employee_id: string;
  transaction_id: string;
  category: Category;
  base_revision: number;
  effective_date: string;
  proposed_payload: string;
  changed_fields: string[];
  reason: string;
  state: string;
  version: number;
}

const REQUEST_COLUMNS = `r.id, r.employee_id, r.transaction_id, r.category, r.base_revision, to_char(r.proposed_effective_date, 'YYYY-MM-DD') as effective_date,
  r.proposed_payload, r.changed_fields, r.reason, r.state, r.version`;

const requestBinding = (companyId: string, employeeId: string, id: string) => ({ purpose: 'sensitive_change.proposed', companyId, ownerId: employeeId, recordId: id });
const revisionBinding = (companyId: string, employeeId: string, id: string) => ({ purpose: 'private_profile.revision', companyId, ownerId: employeeId, recordId: id });
const openSealed = (companyId: string, r: Pick<RequestRow, 'id' | 'employee_id' | 'proposed_payload'>) => openJson<Sealed>(r.proposed_payload, requestBinding(companyId, r.employee_id, r.id));

function ownEmployee(grant: AccessGrant): string {
  if (!grant.linkedEmployeeId) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  return grant.linkedEmployeeId;
}

/** Serialises everything that bases on or appends to one employee's category (after any transaction lock). */
async function lockCategory(tx: Queryable, companyId: string, employeeId: string, category: Category): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(hashtextextended('private_profile:' || $1 || ':' || $2 || ':' || $3, 0))`, [companyId, employeeId, category]);
}

interface CurrentProfile {
  revision: number;
  revisionId: string | null;
  effectiveFrom: string | null;
  values: Values;
}

/**
 * The approved values of one category: the latest DB116 revision (revisions are appended only once effective, so the
 * latest is the one in force). The birth date's master stays on the employee record and always wins.
 */
async function currentProfile(db: Queryable, companyId: string, employeeId: string, category: Category): Promise<CurrentProfile> {
  const row = (
    await db.query<{ id: string; revision: number; payload: string; effective_from: string }>(
      `select id, revision, payload, to_char(effective_from, 'YYYY-MM-DD') as effective_from from employee_private_profile_revision
        where company_id = $1 and employee_id = $2 and category = $3 order by revision desc limit 1`,
      [companyId, employeeId, category],
    )
  ).rows[0];
  const values: Values = row ? openJson<Values>(row.payload, revisionBinding(companyId, employeeId, row.id)) : {};
  if (category === 'PERSONAL') {
    const dob = (await db.query<{ dob: string | null }>(`select date_of_birth as dob from employee where company_id = $1 and id = $2`, [companyId, employeeId])).rows[0]?.dob;
    if (dob) values.dateOfBirth = dob;
    else delete values.dateOfBirth;
  }
  return { revision: row?.revision ?? 0, revisionId: row?.id ?? null, effectiveFrom: row?.effective_from ?? null, values };
}

/** The base still holds: same revision, and every value the request was based on is unchanged. */
function baseHolds(r: Pick<RequestRow, 'base_revision'>, sealed: Sealed, now: CurrentProfile): boolean {
  if (r.base_revision !== now.revision) return false;
  return Object.entries(sealed.before).every(([field, value]) => (now.values[field] ?? null) === value);
}

const isoDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

function checkEffectiveDate(date: string, today: string): void {
  if (!isoDate(date)) throw new HttpError(422, 'INVALID_DATE', 'The effective date is not a valid date');
  // H4: past dates need an authorised correction; an employee request starts today or later.
  if (date < today) throw new HttpError(422, 'EFFECTIVE_DATE_IN_PAST', 'The change can take effect today or later');
}

async function checkBirthDate(tx: Queryable, companyId: string, employeeId: string, dob: string, today: string): Promise<void> {
  const joining = (await tx.query<{ d: string }>(`select joining_date as d from employee where company_id = $1 and id = $2`, [companyId, employeeId])).rows[0]?.d;
  if (dob >= today || (joining && dob >= joining)) throw new HttpError(422, 'INVALID_FIELD', 'The date of birth is not valid', { field: 'dateOfBirth' });
}

/** Evidence is the employee's own documents; the link set is replaced while the request is a draft. */
async function setEvidence(tx: Queryable, grant: AccessGrant, requestId: string, employeeId: string, documentIds: readonly string[]): Promise<void> {
  if (documentIds.length > 0) {
    const owned = (
      await tx.query<{ n: number }>(`select count(*)::int as n from employee_document where company_id = $1 and employee_id = $2 and id = any($3::uuid[])`, [
        grant.companyId,
        employeeId,
        documentIds,
      ])
    ).rows[0]!.n;
    if (owned !== new Set(documentIds).size) throw new HttpError(422, 'INVALID_EVIDENCE', 'Evidence must be your own uploaded documents');
  }
  await tx.query(`delete from employee_sensitive_change_evidence where company_id = $1 and request_id = $2`, [grant.companyId, requestId]);
  for (const documentId of new Set(documentIds)) {
    await tx.query(
      `insert into employee_sensitive_change_evidence (company_id, request_id, employee_id, document_id, created_by) values ($1, $2, $3, $4, $5)`,
      [grant.companyId, requestId, employeeId, documentId, grant.userId],
    );
  }
}

interface EvidenceStatus {
  total: number;
  verified: number;
  /** Quarantined by the scan, or rejected by a verifier: never evidence (FR-106). */
  unusable: number;
}

async function evidenceStatus(tx: Queryable, companyId: string, requestId: string): Promise<EvidenceStatus> {
  return (
    await tx.query<EvidenceStatus>(
      `select count(*)::int as total,
              count(*) filter (where d.verification_state = 'VERIFIED' and a.scan_state = 'CLEAN')::int as verified,
              count(*) filter (where d.verification_state = 'REJECTED' or a.scan_state = 'QUARANTINED')::int as unusable
         from employee_sensitive_change_evidence ev
         join employee_document d on d.company_id = ev.company_id and d.id = ev.document_id
         join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
        where ev.company_id = $1 and ev.request_id = $2`,
      [companyId, requestId],
    )
  ).rows[0]!;
}

const evidenceRequired = (category: Category, changedFields: readonly string[]) => category === 'BANK' || changedFields.some((f) => FIELDS[category][f]?.identity === true);

async function setState(tx: Queryable, companyId: string, r: Pick<RequestRow, 'id' | 'transaction_id'>, state: string, actor: string, extra = '', extraValues: unknown[] = []) {
  await tx.query(`update business_transaction set state = $3, updated_by = $4 where company_id = $1 and id = $2`, [companyId, r.transaction_id, state, actor]);
  await tx.query(`update employee_sensitive_change_request set state = $3, updated_by = $4 ${extra} where company_id = $1 and id = $2`, [companyId, r.id, state, actor, ...extraValues]);
}

async function audit(tx: Queryable, grant: { companyId: string; userId: string; assignmentId: string | null }, requestId: string, action: string, before: Record<string, unknown> | null, after: Record<string, unknown>, reason?: string | null) {
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'employee_sensitive_change_request',
    recordKey: requestId,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action,
    before: before ? { operational: before } : null,
    after: { operational: after },
    reason: reason ?? null,
  });
}

/**
 * H7 "bank change cutoff"; H4 "Bank revisions after cutoff warn employee": the employee is told once per request and
 * payroll period, on submission or, if the cutoff passed while it waited, on approval. Period and dates only.
 */
async function bankCutoffEvent(tx: Queryable, companyId: string, requestId: string, warning: PayrollCutoffWarning | null) {
  if (!warning) return;
  await enqueueEvent(tx, {
    companyId,
    topic: 'sensitive_change.bank_cutoff',
    aggregateId: requestId,
    dedupeKey: `sensitive_change.bank_cutoff:${requestId}:${warning.periodCode}`,
    payload: { requestId, periodCode: warning.periodCode, inputCutoff: warning.inputCutoff },
  });
}

async function outcomeEvent(tx: Queryable, companyId: string, requestId: string, outcome: string) {
  await enqueueEvent(tx, {
    companyId,
    topic: 'sensitive_change.outcome',
    aggregateId: requestId,
    dedupeKey: `sensitive_change.outcome:${requestId}:${outcome}`,
    payload: { requestId, outcome },
  });
}

/** The caller's own request, locked behind its transaction lock. */
async function lockOwn(tx: Queryable, grant: AccessGrant, requestId: string): Promise<RequestRow> {
  const target = (
    await tx.query<{ transaction_id: string }>(`select transaction_id from employee_sensitive_change_request where company_id = $1 and id = $2 and employee_id = $3`, [
      grant.companyId,
      requestId,
      ownEmployee(grant),
    ])
  ).rows[0];
  if (!target) throw notFound();
  await lockTransaction(tx, target.transaction_id);
  return (await tx.query<RequestRow>(`select ${REQUEST_COLUMNS} from employee_sensitive_change_request r where r.company_id = $1 and r.id = $2 for update`, [grant.companyId, requestId])).rows[0]!;
}

// ---------------------------------------------------------------------------------------------------------
// Employee: drafts, submission, withdrawal and revision
// ---------------------------------------------------------------------------------------------------------

export interface DraftInput {
  category: Category;
  effectiveDate?: string | undefined;
  values: Record<string, unknown>;
  reason: string;
  evidenceDocumentIds?: string[] | undefined;
}

async function prepare(tx: Queryable, grant: AccessGrant, employeeId: string, category: Category, values: Record<string, unknown>, effectiveDate: string) {
  checkEffectiveDate(effectiveDate, grant.businessDate);
  const now = await currentProfile(tx, grant.companyId, employeeId, category);
  const proposal = buildProposal(category, now.values, values);
  if (category === 'PERSONAL' && proposal.proposed.dateOfBirth) await checkBirthDate(tx, grant.companyId, employeeId, proposal.proposed.dateOfBirth, grant.businessDate);
  return { now, proposal };
}

async function insertDraft(tx: Queryable, grant: AccessGrant, employeeId: string, input: DraftInput & { supersedes?: string }) {
  const effectiveDate = input.effectiveDate ?? grant.businessDate;
  await lockCategory(tx, grant.companyId, employeeId, input.category);
  const open = await tx.query(`select 1 from employee_sensitive_change_request where company_id = $1 and employee_id = $2 and category = $3 and state = any($4::text[])`, [
    grant.companyId,
    employeeId,
    input.category,
    OPEN_STATES,
  ]);
  if ((open.rowCount ?? 0) > 0) throw new HttpError(409, 'OPEN_REQUEST_EXISTS', 'You already have an open request for these details; finish or withdraw it first');
  const { now, proposal } = await prepare(tx, grant, employeeId, input.category, input.values, effectiveDate);

  const id = randomUUID();
  const transactionId = (
    await tx.query<{ id: string }>(
      `insert into business_transaction (company_id, kind, owner_employee_id, state, created_by, updated_by) values ($1, $2, $3, 'DRAFT', $4, $4) returning id`,
      [grant.companyId, SENSITIVE_CHANGE_KIND, employeeId, grant.userId],
    )
  ).rows[0]!.id;
  const sealed: Sealed = { proposed: proposal.proposed, before: proposal.before };
  await tx.query(
    `insert into employee_sensitive_change_request (id, company_id, employee_id, transaction_id, category, base_revision, proposed_effective_date, proposed_payload,
                                                    changed_fields, reason, supersedes_request_id, state, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'DRAFT', $12, $12)`,
    [
      id,
      grant.companyId,
      employeeId,
      transactionId,
      input.category,
      now.revision,
      effectiveDate,
      sealJson(sealed, requestBinding(grant.companyId, employeeId, id)),
      proposal.changedFields,
      input.reason.trim(),
      input.supersedes ?? null,
      grant.userId,
    ],
  );
  await setEvidence(tx, grant, id, employeeId, input.evidenceDocumentIds ?? []);
  await audit(tx, grant, id, input.supersedes ? 'REVISE' : 'CREATE', null, {
    category: input.category,
    changedFields: proposal.changedFields,
    effectiveDate,
    baseRevision: now.revision,
    supersedes: input.supersedes ?? null,
    state: 'DRAFT',
  });
  return { requestId: id, state: 'DRAFT', category: input.category, changedFields: proposal.changedFields, effectiveDate, evidenceRequired: proposal.evidenceRequired, version: 1 };
}

export async function createDraft(tx: Queryable, grant: AccessGrant, input: DraftInput) {
  return insertDraft(tx, grant, ownEmployee(grant), input);
}

export async function updateDraft(tx: Queryable, grant: AccessGrant, requestId: string, input: Omit<DraftInput, 'category'> & { expectedVersion: number }) {
  const r = await lockOwn(tx, grant, requestId);
  if (r.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft can be edited; a submitted request is kept as it was sent');
  if (r.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The request changed; reload and retry');
  await lockCategory(tx, grant.companyId, r.employee_id, r.category);
  const effectiveDate = input.effectiveDate ?? r.effective_date;
  // Saving a draft re-bases it on the current approved values.
  const { now, proposal } = await prepare(tx, grant, r.employee_id, r.category, input.values, effectiveDate);
  const sealed: Sealed = { proposed: proposal.proposed, before: proposal.before };
  const version = (
    await tx.query<{ version: number }>(
      `update employee_sensitive_change_request set base_revision = $3, proposed_effective_date = $4, proposed_payload = $5, changed_fields = $6, reason = $7, updated_by = $8
        where company_id = $1 and id = $2 returning version`,
      [grant.companyId, r.id, now.revision, effectiveDate, sealJson(sealed, requestBinding(grant.companyId, r.employee_id, r.id)), proposal.changedFields, input.reason.trim(), grant.userId],
    )
  ).rows[0]!.version;
  if (input.evidenceDocumentIds) await setEvidence(tx, grant, r.id, r.employee_id, input.evidenceDocumentIds);
  await audit(
    tx,
    grant,
    r.id,
    'UPDATE',
    { changedFields: r.changed_fields, effectiveDate: r.effective_date, baseRevision: r.base_revision },
    { changedFields: proposal.changedFields, effectiveDate, baseRevision: now.revision },
  );
  return { requestId: r.id, state: 'DRAFT', category: r.category, changedFields: proposal.changedFields, effectiveDate, evidenceRequired: proposal.evidenceRequired, version };
}

export async function submitChange(tx: Queryable, grant: AccessGrant, requestId: string, input: { expectedVersion: number }) {
  const r = await lockOwn(tx, grant, requestId);
  if (r.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft can be submitted');
  if (r.version !== input.expectedVersion) throw new HttpError(409, 'STALE_VERSION', 'The request changed; reload and retry');
  await lockCategory(tx, grant.companyId, r.employee_id, r.category);
  await reassertAccess(tx, grant, 'sensitive_change', 'submit', ['private']);
  if (r.effective_date < grant.businessDate) throw new HttpError(422, 'EFFECTIVE_DATE_IN_PAST', 'The change can take effect today or later; edit the draft');
  const now = await currentProfile(tx, grant.companyId, r.employee_id, r.category);
  if (!baseHolds(r, openSealed(grant.companyId, r), now)) {
    throw new HttpError(409, 'BASE_REVISION_CHANGED', 'Your approved details changed after this draft was saved; open the draft and save it again');
  }
  const evidence = await evidenceStatus(tx, grant.companyId, r.id);
  if (evidence.unusable > 0) throw new HttpError(422, 'EVIDENCE_UNUSABLE', 'A supporting document failed the malware scan or was rejected; replace it');
  if (evidenceRequired(r.category, r.changed_fields) && evidence.total === 0) {
    throw new HttpError(422, 'EVIDENCE_REQUIRED', 'Attach a supporting document for this change');
  }
  await setState(tx, grant.companyId, r, 'SUBMITTED', grant.userId, ', submitted_at = now()');
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: SENSITIVE_CHANGE_KIND, transactionId: r.transaction_id, ownerEmployeeId: r.employee_id, actorUserId: grant.userId });
  const warning = await bankCutoffWarning(tx, grant, r);
  await audit(tx, grant, r.id, 'SUBMIT', { state: 'DRAFT' }, { category: r.category, changedFields: r.changed_fields, effectiveDate: r.effective_date, state: 'SUBMITTED', ...cutoffAudit(warning) });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'sensitive_change.submitted',
    aggregateId: r.id,
    dedupeKey: `sensitive_change.submitted:${r.id}`,
    payload: { requestId: r.id, taskId },
  });
  await bankCutoffEvent(tx, grant.companyId, r.id, warning);
  return { requestId: r.id, state: 'SUBMITTED', ...(warning ? { payrollCutoffWarning: warning } : {}) };
}

/**
 * FR-105 / H4: a BANK change effective after the input cutoff of the employee's current open payroll period is
 * warned about (never blocked), naming the period and cutoff; nothing when no payroll calendar applies (I-18).
 */
async function bankCutoffWarning(tx: Queryable, grant: AccessGrant, r: Pick<RequestRow, 'category' | 'employee_id' | 'effective_date'>): Promise<PayrollCutoffWarning | null> {
  if (r.category !== 'BANK') return null;
  return payrollCutoffWarning(tx, grant.companyId, r.employee_id, r.effective_date, grant.businessDate);
}

/** The warning's operational facts for the audit record (period and dates only). */
const cutoffAudit = (w: PayrollCutoffWarning | null) => (w ? { payrollCutoff: { calendarCode: w.calendarCode, periodCode: w.periodCode, inputCutoff: w.inputCutoff } } : {});

export async function withdrawChange(tx: Queryable, grant: AccessGrant, requestId: string) {
  const r = await lockOwn(tx, grant, requestId);
  if (!['DRAFT', 'SUBMITTED', 'IN_REVIEW'].includes(r.state)) throw new HttpError(409, 'INVALID_STATE', 'Only a draft or a request under review can be withdrawn');
  if (r.state !== 'DRAFT') await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
  await setState(tx, grant.companyId, r, 'WITHDRAWN', grant.userId);
  await audit(tx, grant, r.id, 'WITHDRAW', { state: r.state }, { state: 'WITHDRAWN' });
  return { requestId: r.id, state: 'WITHDRAWN' };
}

/**
 * H2: a returned or conflicting request is corrected or rebased through a new draft that supersedes it; the new
 * draft re-bases on the current approved values and needs its own submission and approval.
 */
export async function reviseChange(tx: Queryable, grant: AccessGrant, requestId: string) {
  const employeeId = ownEmployee(grant);
  const r = (
    await tx.query<RequestRow>(`select ${REQUEST_COLUMNS} from employee_sensitive_change_request r where r.company_id = $1 and r.id = $2 and r.employee_id = $3`, [
      grant.companyId,
      requestId,
      employeeId,
    ])
  ).rows[0];
  if (!r) throw notFound();
  if (r.state !== 'RETURNED' && r.state !== 'CONFLICT') throw new HttpError(409, 'INVALID_STATE', 'Only a returned or conflicting request can be revised');
  const successor = await tx.query(`select 1 from employee_sensitive_change_request where company_id = $1 and supersedes_request_id = $2 and state <> 'WITHDRAWN'`, [
    grant.companyId,
    r.id,
  ]);
  if ((successor.rowCount ?? 0) > 0) throw new HttpError(409, 'ALREADY_REVISED', 'This request already has a revision');
  const sealed = openSealed(grant.companyId, r);
  const evidence = (
    await tx.query<{ document_id: string }>(`select document_id from employee_sensitive_change_evidence where company_id = $1 and request_id = $2`, [grant.companyId, r.id])
  ).rows.map((e) => e.document_id);
  return insertDraft(tx, grant, employeeId, {
    category: r.category,
    effectiveDate: r.effective_date < grant.businessDate ? grant.businessDate : r.effective_date,
    values: sealed.proposed,
    reason: r.reason,
    evidenceDocumentIds: evidence,
    supersedes: r.id,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Reviewer: queue, review start and decision
// ---------------------------------------------------------------------------------------------------------

/** The pending task's request, locked behind the transaction lock; someone else's task reads as missing. */
async function lockTaskRequest(tx: Queryable, grant: AccessGrant, taskId: string): Promise<RequestRow> {
  const t = (
    await tx.query<{ transaction_id: string; kind: string }>(
      `select i.transaction_id, i.transaction_kind as kind from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id
        where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3`,
      [grant.companyId, taskId, grant.userId],
    )
  ).rows[0];
  if (!t || t.kind !== SENSITIVE_CHANGE_KIND) throw notFound();
  await lockTransaction(tx, t.transaction_id);
  const r = (
    await tx.query<RequestRow>(`select ${REQUEST_COLUMNS} from employee_sensitive_change_request r where r.company_id = $1 and r.transaction_id = $2 for update`, [
      grant.companyId,
      t.transaction_id,
    ])
  ).rows[0];
  if (!r || !(await canAccessEmployee(tx, grant, r.employee_id))) throw notFound();
  return r;
}

async function pendingTask(tx: Queryable, grant: AccessGrant, taskId: string): Promise<boolean> {
  const t = await tx.query(`select 1 from approval_task t where t.company_id = $1 and t.id = $2 and t.assignee_user_id = $3 and t.state = 'PENDING' and ${taskDelegationLive('t')}`, [
    grant.companyId,
    taskId,
    grant.userId,
  ]);
  return (t.rowCount ?? 0) > 0;
}

export async function startReview(tx: Queryable, grant: AccessGrant, taskId: string) {
  const r = await lockTaskRequest(tx, grant, taskId);
  if (!(await pendingTask(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (r.state === 'IN_REVIEW') return { requestId: r.id, state: 'IN_REVIEW' };
  if (r.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This request is not waiting for review');
  await setState(tx, grant.companyId, r, 'IN_REVIEW', grant.userId);
  await audit(tx, grant, r.id, 'START_REVIEW', { state: 'SUBMITTED' }, { state: 'IN_REVIEW' });
  return { requestId: r.id, state: 'IN_REVIEW' };
}

export interface DecisionInput {
  decision: Decision;
  /** The reviewer's private note (required to approve, H4); never shown to the employee. */
  reason?: string | undefined;
  /** Employee-visible explanation, required to return or reject (H4). */
  employeeMessage?: string | undefined;
  idempotencyKey: string;
}

export async function decideChange(tx: Queryable, grant: AccessGrant, taskId: string, input: DecisionInput) {
  if (input.decision === 'APPROVE' && !input.reason?.trim()) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the change is approved');
  if (input.decision !== 'APPROVE' && !input.employeeMessage?.trim()) throw new HttpError(422, 'EMPLOYEE_MESSAGE_REQUIRED', 'Explain to the employee what to correct or why the change is rejected');

  const r = await lockTaskRequest(tx, grant, taskId);
  const replay = (
    await tx.query<{ task_id: string }>(`select task_id from approval_decision where company_id = $1 and idempotency_key = $2`, [grant.companyId, input.idempotencyKey])
  ).rows[0];
  if (replay) {
    if (replay.task_id !== taskId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another task');
    return { requestId: r.id, state: r.state, replayed: true };
  }
  if (!(await pendingTask(tx, grant, taskId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (input.decision === 'APPROVE' && r.state !== 'IN_REVIEW') throw new HttpError(409, 'REVIEW_NOT_STARTED', 'Start the review and verify the evidence before approving');
  if (r.state !== 'SUBMITTED' && r.state !== 'IN_REVIEW') throw new HttpError(409, 'INVALID_STATE', 'This request is not waiting for review');

  if (input.decision === 'APPROVE') {
    await lockCategory(tx, grant.companyId, r.employee_id, r.category);
    const now = await currentProfile(tx, grant.companyId, r.employee_id, r.category);
    if (!baseHolds(r, openSealed(grant.companyId, r), now)) {
      // H2: no silent overwrite. The request ends in CONFLICT; the employee rebases and approval is renewed.
      await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
      await setState(tx, grant.companyId, r, 'CONFLICT', grant.userId, ', decided_at = now()');
      await audit(tx, grant, r.id, 'CONFLICT', { state: r.state, baseRevision: r.base_revision }, { state: 'CONFLICT', currentRevision: now.revision });
      await outcomeEvent(tx, grant.companyId, r.id, 'CONFLICT');
      return { requestId: r.id, state: 'CONFLICT', replayed: false };
    }
    if (r.effective_date < grant.businessDate) {
      throw new HttpError(409, 'EFFECTIVE_DATE_PASSED', 'The requested effective date has passed; return the request so the employee can choose a new date');
    }
    // H4 / FR-106: bank and identity-sensitive changes need verified evidence; unusable evidence blocks approval.
    const evidence = await evidenceStatus(tx, grant.companyId, r.id);
    if (evidence.unusable > 0) throw new HttpError(409, 'EVIDENCE_UNUSABLE', 'A supporting document failed the malware scan or was rejected; return the request');
    if (evidenceRequired(r.category, r.changed_fields) && evidence.verified === 0) {
      throw new HttpError(409, 'EVIDENCE_NOT_VERIFIED', 'Verify the supporting document (released and checked) before approving');
    }
  }

  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'sensitive_change', action: 'review' } });
  if (result.replayed) return { requestId: r.id, state: r.state, replayed: true };
  if (result.outcome === 'NEXT_STEP') return { requestId: r.id, state: r.state, replayed: false };

  let state: string;
  let warning: PayrollCutoffWarning | null = null;
  if (result.outcome === 'APPROVED') {
    warning = await bankCutoffWarning(tx, grant, r);
    await setState(tx, grant.companyId, r, 'APPROVED', grant.userId, ', decided_at = now()');
    if (r.effective_date <= grant.businessDate) {
      await applyRevision(tx, grant.companyId, r, { userId: grant.userId, assignmentId: grant.assignmentId });
      state = 'APPLIED';
    } else {
      await setState(tx, grant.companyId, r, 'SCHEDULED', grant.userId);
      state = 'SCHEDULED';
    }
  } else {
    state = result.outcome === 'REJECTED' ? 'REJECTED' : 'RETURNED';
    await setState(tx, grant.companyId, r, state, grant.userId, ', decided_at = now(), employee_message = $5', [input.employeeMessage!.trim()]);
  }
  await audit(tx, grant, r.id, input.decision, { state: r.state }, { state, effectiveDate: r.effective_date, ...cutoffAudit(warning) }, input.reason ?? null);
  await outcomeEvent(tx, grant.companyId, r.id, state);
  await bankCutoffEvent(tx, grant.companyId, r.id, warning);
  return { requestId: r.id, state, replayed: false, ...(warning ? { payrollCutoffWarning: warning } : {}) };
}

/**
 * Appends the next DB116 revision with the approved values (closing the previous interval) and applies a birth-date
 * change to the employee master with its history. Caller holds the transaction and category locks and has checked
 * the base.
 */
async function applyRevision(tx: Queryable, companyId: string, r: RequestRow, actor: { userId: string; assignmentId: string | null }) {
  const now = await currentProfile(tx, companyId, r.employee_id, r.category);
  const sealed = openSealed(companyId, r);
  const result: Values = { ...now.values };
  for (const [field, value] of Object.entries(sealed.proposed)) {
    if (value === null) delete result[field];
    else result[field] = value;
  }
  if (now.revisionId) {
    await tx.query(`update employee_private_profile_revision set effective_to = $3, updated_by = $4 where company_id = $1 and id = $2`, [
      companyId,
      now.revisionId,
      r.effective_date,
      actor.userId,
    ]);
  }
  const revisionId = randomUUID();
  await tx.query(
    `insert into employee_private_profile_revision (id, company_id, employee_id, category, revision, effective_from, payload, source_request_id, created_by, updated_by)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
    [revisionId, companyId, r.employee_id, r.category, now.revision + 1, r.effective_date, sealJson(result, revisionBinding(companyId, r.employee_id, revisionId)), r.id, actor.userId],
  );
  if (r.category === 'PERSONAL' && 'dateOfBirth' in sealed.proposed) {
    const updated = (
      await tx.query<{ prior: number; version: number }>(
        `update employee set date_of_birth = $3, updated_by = $4 where company_id = $1 and id = $2 returning version - 1 as prior, version`,
        [companyId, r.employee_id, sealed.proposed.dateOfBirth, actor.userId],
      )
    ).rows[0]!;
    await writeAudit(tx, {
      companyId,
      resource: 'employee',
      recordKey: r.employee_id,
      actorUserId: actor.userId,
      actingAssignmentId: actor.assignmentId,
      action: 'UPDATE',
      priorVersion: updated.prior,
      newVersion: updated.version,
      before: { personal: { dateOfBirth: sealed.before.dateOfBirth ?? null } },
      after: { personal: { dateOfBirth: sealed.proposed.dateOfBirth } },
      reason: `Approved sensitive change ${r.id}`,
    });
    await enqueueEvent(tx, {
      companyId,
      topic: 'employee.updated',
      aggregateId: r.employee_id,
      dedupeKey: `employee.updated:${r.employee_id}:${updated.version}`,
      payload: { employeeId: r.employee_id, version: updated.version },
    });
  }
  await setState(tx, companyId, r, 'APPLIED', actor.userId, ', applied_at = now(), applied_revision_id = $5', [revisionId]);
  await audit(tx, { companyId, userId: actor.userId, assignmentId: actor.assignmentId }, r.id, 'APPLY', null, {
    state: 'APPLIED',
    revision: now.revision + 1,
    effectiveFrom: r.effective_date,
    changedFields: r.changed_fields,
  });
}

/**
 * BR-054 "rechecks row scope, base version, evidence and effective date"; H4 "scheduled application must still have valid
 * approval": what must still stand when the daily job applies a change approved earlier, naming what does not (the job
 * checks the base and selects by effective date). Each approver's assignment is share-locked as in reassertAccess, so a
 * concurrent revocation is ordered before or after. Evidence verdicts are final, so what can still go bad is evidence that
 * was optional at approval: rejected, or quarantined by a scan still pending then.
 */
async function deferredRecheck(tx: Queryable, companyId: string, r: RequestRow): Promise<'APPROVAL' | 'APPROVER_ACCESS' | 'EVIDENCE' | null> {
  const approvers = (
    await tx.query<{ user_id: string; assignment_id: string }>(
      `select d.actor_user_id as user_id, d.acting_assignment_id as assignment_id
         from approval_instance i
         join business_transaction bt on bt.company_id = i.company_id and bt.id = i.transaction_id and bt.revision = i.transaction_revision
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id and d.decision = 'APPROVE'
        where i.company_id = $1 and i.transaction_id = $2 and i.state = 'APPROVED'`,
      [companyId, r.transaction_id],
    )
  ).rows;
  if (approvers.length === 0) return 'APPROVAL';
  for (const a of approvers) {
    await tx.query(`select 1 from role_assignment where company_id = $1 and id = $2 for share`, [companyId, a.assignment_id]);
    const access = await resolveAccess(tx, { userId: a.user_id, companyId, assignmentId: a.assignment_id, resource: 'sensitive_change', action: 'review', fieldGroups: ['private'] });
    if (!access.allowed) return 'APPROVER_ACCESS';
    // Assigned scope lasts only while a task is pending (workflow/engine.ts): the decided task was that reach, so the
    // assignment's own filters are what is left to check.
    if (!(await canAccessEmployee(tx, access.scopeKind === 'ASSIGNED' ? { ...access, scopeKind: 'COMPANY' } : access, r.employee_id))) return 'APPROVER_ACCESS';
  }
  const evidence = await evidenceStatus(tx, companyId, r.id);
  if (evidence.unusable > 0 || (evidenceRequired(r.category, r.changed_fields) && evidence.verified === 0)) return 'EVIDENCE';
  return null;
}

/**
 * Daily: applies approved changes whose effective date has arrived (H2 SCHEDULED -> APPLIED). Each request is its
 * own transaction; the base must still hold and the approval, its approvers' authority and the evidence must still
 * stand (deferredRecheck), otherwise the request ends in CONFLICT for the employee to rebase and renew the approval.
 */
export async function applyDueChanges(db: Database, companyId: string, localDate: string, systemUserId: string) {
  const due = (
    await db.query<{ id: string; transaction_id: string }>(
      `select id, transaction_id from employee_sensitive_change_request where company_id = $1 and state = 'SCHEDULED' and proposed_effective_date <= $2::date
        order by proposed_effective_date, id limit 1000`,
      [companyId, localDate],
    )
  ).rows;
  let applied = 0;
  let conflicts = 0;
  for (const d of due) {
    const outcome = await withTransaction(db, async (tx) => {
      await lockTransaction(tx, d.transaction_id);
      const r = (await tx.query<RequestRow>(`select ${REQUEST_COLUMNS} from employee_sensitive_change_request r where r.company_id = $1 and r.id = $2 for update`, [companyId, d.id])).rows[0];
      if (!r || r.state !== 'SCHEDULED') return null;
      await lockCategory(tx, companyId, r.employee_id, r.category);
      const now = await currentProfile(tx, companyId, r.employee_id, r.category);
      const actor = { companyId, userId: systemUserId, assignmentId: null };
      const failed = baseHolds(r, openSealed(companyId, r), now) ? await deferredRecheck(tx, companyId, r) : 'BASE_CHANGED';
      if (failed) {
        await setState(tx, companyId, r, 'CONFLICT', systemUserId);
        await audit(tx, actor, r.id, 'CONFLICT', { state: 'SCHEDULED', baseRevision: r.base_revision }, { state: 'CONFLICT', currentRevision: now.revision, recheck: failed });
        await outcomeEvent(tx, companyId, r.id, failed === 'BASE_CHANGED' ? 'CONFLICT' : 'CONFLICT_RECHECK');
        return 'CONFLICT';
      }
      await applyRevision(tx, companyId, r, { userId: systemUserId, assignmentId: null });
      await outcomeEvent(tx, companyId, r.id, 'APPLIED');
      return 'APPLIED';
    });
    if (outcome === 'APPLIED') applied++;
    if (outcome === 'CONFLICT') conflicts++;
  }
  return { due: due.length, applied, conflicts };
}

// ---------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------

/** The values with a bank account identifier masked; holder, routing reference and country stay (H3 TN03 summary, I-18). */
function maskAccount(category: Category, values: Record<string, string | null>) {
  if (category !== 'BANK' || !('accountIdentifier' in values)) return values;
  return { ...values, accountIdentifier: maskTail(values.accountIdentifier ?? undefined) };
}

/** Whether the reader sees this request's BANK proposal in full; otherwise its account identifier is masked. */
type FullProposal = (r: ListedRow, proposed: Sealed['proposed']) => boolean;

interface ListedRow extends RequestRow {
  employee_message: string | null;
  supersedes_request_id: string | null;
  submitted_at: Date | null;
  decided_at: Date | null;
  applied_at: Date | null;
  created_at: Date;
  evidence: { documentId: string; documentType: string; uploadedAt: string; scanState: string | null; verificationState: string }[] | null;
  pending_with: string | null;
  decisions: { decision: string; decidedAt: string }[] | null;
}

const LIST_SQL = `select ${REQUEST_COLUMNS}, r.employee_message, r.supersedes_request_id, r.submitted_at, r.decided_at, r.applied_at, r.created_at,
    (select json_agg(json_build_object('documentId', ev.document_id, 'documentType', dt.code, 'uploadedAt', d.created_at,
                                       'scanState', a.scan_state, 'verificationState', d.verification_state) order by ev.created_at)
       from employee_sensitive_change_evidence ev
       join employee_document d on d.company_id = ev.company_id and d.id = ev.document_id
       join attachment a on a.company_id = d.company_id and a.id = d.attachment_id
       join reference_value dt on dt.company_id = d.company_id and dt.id = d.document_type_id
      where ev.company_id = r.company_id and ev.request_id = r.id) as evidence,
    (select coalesce(pe.display_name, 'HR reviewer')
       from approval_instance i join approval_task t on t.company_id = i.company_id and t.instance_id = i.id and t.state = 'PENDING'
       left join user_employee_link l on l.company_id = t.company_id and l.user_id = t.assignee_user_id
            and l.effective_from <= hrms_business_date(r.company_id, now()) and (l.effective_to is null or l.effective_to > hrms_business_date(r.company_id, now()))
       left join employee pe on pe.company_id = l.company_id and pe.id = l.employee_id
      where i.company_id = r.company_id and i.transaction_id = r.transaction_id and i.state = 'ACTIVE' limit 1) as pending_with,
    (select json_agg(json_build_object('decision', d.decision, 'decidedAt', d.occurred_at) order by d.occurred_at)
       from approval_instance i join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
       join approval_decision d on d.company_id = t.company_id and d.task_id = t.id
      where i.company_id = r.company_id and i.transaction_id = r.transaction_id) as decisions
  from employee_sensitive_change_request r`;

/**
 * Requests with their proposal; decision history shows outcomes only, never the reviewer's private note. Before-values
 * are previous values: a bank account identifier among them is masked for every reader, reviewers too (I-18).
 */
function present(companyId: string, rows: ListedRow[], fullProposal: FullProposal = () => true) {
  return rows.map((r) => {
    const sealed = openSealed(companyId, r);
    return {
      id: r.id,
      category: r.category,
      state: r.state,
      effectiveDate: r.effective_date,
      changedFields: r.changed_fields,
      proposed: fullProposal(r, sealed.proposed) ? sealed.proposed : maskAccount(r.category, sealed.proposed),
      before: maskAccount(r.category, sealed.before),
      reason: r.reason,
      employeeMessage: r.employee_message,
      supersedesRequestId: r.supersedes_request_id,
      baseRevision: r.base_revision,
      evidence: r.evidence ?? [],
      pendingWith: r.pending_with,
      decisions: r.decisions ?? [],
      submittedAt: r.submitted_at,
      decidedAt: r.decided_at,
      appliedAt: r.applied_at,
      createdAt: r.created_at,
      version: r.version,
    };
  });
}

async function listedRows(db: Queryable, grant: AccessGrant, employeeId: string): Promise<ListedRow[]> {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  return (await db.query<ListedRow>(`${LIST_SQL} where r.company_id = $1 and r.employee_id = $2 order by r.created_at desc limit 100`, [grant.companyId, employeeId])).rows;
}

/**
 * An employee's requests as an Admin reads them (FR-098/BR-044, H3 TN03, I-18). A BANK proposal shows its account
 * identifier masked, as in the masked bank summary. H3 TN03 limits submitted full fields to the owner (their own list)
 * and eligible reviewers, so it is shown in full only to the reviewer assigned to the open request, reading from a
 * context that may review (as in their queue), and, with the bank field grant, when it is the account in force, which
 * that grant reads on the private profile anyway. A draft, a pending, returned or rejected proposal and a previous
 * account stay masked, like the before-values. Each grant comes from the same selected assignment (C1/BR-046).
 */
export async function listChanges(db: Queryable, grant: AccessGrant, employeeId: string) {
  const rows = await listedRows(db, grant, employeeId);
  const bank = rows.filter((r) => r.category === 'BANK');
  if (bank.length === 0) return { items: present(grant.companyId, rows) };
  const holds = async (resource: string, action: string, fieldGroup: string) => {
    const d = await resolveAccess(db, { userId: grant.userId, companyId: grant.companyId, assignmentId: grant.assignmentId, resource, action, fieldGroups: [fieldGroup] });
    return d.allowed && d.allowedFieldGroups.includes(fieldGroup);
  };
  const reviewing = new Set<string>();
  if (await holds('sensitive_change', 'review', 'private')) {
    const pending = await db.query<{ transaction_id: string }>(
      `select i.transaction_id from approval_task t join approval_instance i on i.company_id = t.company_id and i.id = t.instance_id and i.state = 'ACTIVE'
        where t.company_id = $1 and t.assignee_user_id = $2 and t.state = 'PENDING' and i.transaction_id = any($3::uuid[]) and ${taskDelegationLive('t')}`,
      [grant.companyId, grant.userId, bank.map((r) => r.transaction_id)],
    );
    for (const p of pending.rows) reviewing.add(p.transaction_id);
  }
  // The account in force is what this grant reads on the private profile anyway.
  const inForce = (await holds('employee', 'read', 'bank')) ? ((await currentProfile(db, grant.companyId, employeeId, 'BANK')).values.accountIdentifier ?? null) : undefined;
  const full: FullProposal = (r, proposed) => r.category !== 'BANK' || reviewing.has(r.transaction_id) || (inForce !== undefined && proposed.accountIdentifier === inForce);
  return { items: present(grant.companyId, rows, full) };
}

/** Submitted and not applied yet: the states in which a bank change can still land after the payroll cutoff. */
const PENDING_STATES = ['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'SCHEDULED'];

/**
 * The employee's own requests. A pending BANK change carries the payroll cutoff warning, computed as on submission and
 * in the reviewer's queue (as of the business date; period facts only). One category has at most one open request.
 */
export async function listOwnChanges(db: Queryable, grant: AccessGrant) {
  const rows = await listedRows(db, grant, ownEmployee(grant));
  const shown = present(grant.companyId, rows);
  const items = [];
  for (const [i, r] of rows.entries()) {
    const warning = PENDING_STATES.includes(r.state) ? await bankCutoffWarning(db, grant, r) : null;
    items.push(warning ? { ...shown[i]!, payrollCutoffWarning: warning } : shown[i]!);
  }
  return { items };
}

/** The reviewer's queue: proposal, the values in force now (bank masked) and whether the base still holds. */
export async function reviewTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, SENSITIVE_CHANGE_KIND)).items as { taskId: string; transactionId: string; ownerEmployeeId: string }[];
  if (tasks.length === 0) return { items: [] };
  const rows = (
    await db.query<ListedRow & { employee_code: string; employee_name: string }>(
      `select q.*, e.employee_code, e.display_name as employee_name from (${LIST_SQL} where r.company_id = $1 and r.transaction_id = any($2::uuid[])) q
         join employee e on e.company_id = $1 and e.id = q.employee_id`,
      [grant.companyId, tasks.map((t) => t.transactionId)],
    )
  ).rows;
  const items = [];
  for (const t of tasks) {
    const row = rows.find((r) => r.transaction_id === t.transactionId);
    if (!row || !(await canAccessEmployee(db, grant, row.employee_id))) {
      items.push({ ...t, request: null });
      continue;
    }
    const [shown] = present(grant.companyId, [row]);
    const now = await currentProfile(db, grant.companyId, row.employee_id, row.category);
    const current = row.category === 'BANK' ? maskedBank(now.values) : now.values;
    const warning = await bankCutoffWarning(db, grant, row);
    items.push({
      ...t,
      request: {
        ...shown,
        employeeCode: row.employee_code,
        employeeName: row.employee_name,
        current,
        currentRevision: now.revision,
        baseHolds: baseHolds(row, openSealed(grant.companyId, row), now),
        evidenceRequired: evidenceRequired(row.category, row.changed_fields),
        ...(warning ? { payrollCutoffWarning: warning } : {}),
      },
    });
  }
  return { items };
}

/**
 * Approved private values of an employee (H3 TN01/TN03). Personal and address values need the private group; bank
 * values are masked unless the caller holds the bank group, which the Employee OWN context never does.
 */
export async function privateProfile(db: Queryable, grant: AccessGrant, employeeId: string) {
  if (!(await canAccessEmployee(db, grant, employeeId))) throw notFound();
  const showPrivate = grant.allowedFieldGroups.includes('private');
  const showBank = grant.allowedFieldGroups.includes('bank');
  const out: Record<string, unknown> = { employeeId };
  for (const category of ['PERSONAL', 'ADDRESS', 'BANK'] as const) {
    if (category !== 'BANK' && !showPrivate) continue;
    if (category === 'BANK' && !showPrivate && !showBank) continue;
    const now = await currentProfile(db, grant.companyId, employeeId, category);
    const values = category === 'BANK' && !showBank ? maskedBank(now.values) : now.values;
    out[category.toLowerCase()] = { revision: now.revision, effectiveFrom: now.effectiveFrom, values, ...(category === 'BANK' ? { masked: !showBank } : {}) };
  }
  return out;
}

export const ownPrivateProfile = (db: Queryable, grant: AccessGrant) => privateProfile(db, grant, ownEmployee(grant));
