// FR-011 manpower budget: approved staffing headcount by company, department, location, designation and inclusive
// period. Every change is a revision that an independent HR Administrator approves on its own route (the preparer
// and the submitter are excluded); the latest approved revision is in force. A requisition's budget check compares
// its vacancies with the approved headcount less what is already committed to the same budget line (see
// budgetPosition). No threshold, tolerance or cost basis is assumed: none is given by the BRD.
import { enqueueEvent } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { cancelActiveApproval, decideTask, lockTransaction, myOpenTasks, startApproval } from '../workflow/engine.js';
import {
  audit,
  checkVersion,
  isPendingTaskOf,
  lockBudget,
  newTransaction,
  type Paging,
  pageOf,
  pendingTaskOf,
  personSql,
  priorDecisionTask,
  requireActiveMaster,
  requireDate,
  requireText,
  setRootState,
  taskTransaction,
} from './common.js';
import { admitsBudget, budgetScope, canAccessBudget, reviewersOutsideScope } from './scope.js';

export const BUDGET_REVISION_KIND = 'manpower_budget_revision';

export type BudgetStatus = 'WITHIN_BUDGET' | 'EXCEEDS_BUDGET' | 'NO_BUDGET';

/** The budget line covering a department, location and designation on a date (periods never overlap). */
export async function budgetFor(tx: Queryable, companyId: string, departmentId: string, locationId: string, designationId: string, onDate: string): Promise<string | null> {
  return (
    (
      await tx.query<{ id: string }>(
        `select id from manpower_budget where company_id = $1 and department_id = $2 and location_id = $3 and designation_id = $4
            and period_start <= $5::date and period_end >= $5::date`,
        [companyId, departmentId, locationId, designationId, onDate],
      )
    ).rows[0]?.id ?? null
  );
}

/**
 * Committed headcount of a budget line: the vacancies of its APPROVED requisitions plus the accepted offers of its
 * CLOSED ones (a closed requisition releases its unfilled vacancies and keeps its placements). Pending submissions
 * do not commit headcount; each is checked again at its HR approval.
 */
const COMMITTED_SQL = (company: string, budget: string, exclude: string) => `(
  (select coalesce(sum(r.vacancies), 0)::int from requisition r
    where r.company_id = ${company} and r.budget_id = ${budget} and r.state = 'APPROVED' and r.id is distinct from ${exclude})
  + (select count(*)::int from hiring_offer o join requisition r on r.company_id = o.company_id and r.id = o.requisition_id
      where r.company_id = ${company} and r.budget_id = ${budget} and r.state = 'CLOSED' and o.state = 'ACCEPTED' and r.id is distinct from ${exclude}))`;

const APPROVED_HEADCOUNT_SQL = (company: string, budget: string) =>
  `(select a.headcount from manpower_budget_revision a where a.company_id = ${company} and a.budget_id = ${budget} and a.state = 'APPROVED' order by a.revision desc limit 1)`;

export interface BudgetPosition {
  budgetId: string | null;
  approvedHeadcount: number | null;
  committed: number;
}

export async function budgetPosition(tx: Queryable, companyId: string, budgetId: string | null, excludeRequisitionId: string | null): Promise<BudgetPosition> {
  if (!budgetId) return { budgetId: null, approvedHeadcount: null, committed: 0 };
  const row = (
    await tx.query<{ approved: number | null; committed: number }>(
      `select ${APPROVED_HEADCOUNT_SQL('$1::uuid', '$2::uuid')} as approved, ${COMMITTED_SQL('$1::uuid', '$2::uuid', '$3::uuid')} as committed`,
      [companyId, budgetId, excludeRequisitionId],
    )
  ).rows[0]!;
  return { budgetId, approvedHeadcount: row.approved, committed: row.committed };
}

export function budgetStatus(position: BudgetPosition, requested: number): BudgetStatus {
  if (position.approvedHeadcount === null) return 'NO_BUDGET';
  return position.committed + requested > position.approvedHeadcount ? 'EXCEEDS_BUDGET' : 'WITHIN_BUDGET';
}

// ---------------------------------------------------------------------------------------------------------
// Budget lines and revisions
// ---------------------------------------------------------------------------------------------------------

export interface BudgetInput {
  departmentId: string;
  locationId: string;
  designationId: string;
  periodStart: string;
  periodEnd: string;
  headcount: number;
  reason: string;
}

interface RevisionRow {
  id: string;
  budget_id: string;
  transaction_id: string;
  revision: number;
  headcount: number;
  reason: string;
  state: string;
  prepared_by: string;
  version: number;
  department_id: string;
  location_id: string;
}

const REVISION_COLUMNS = `br.id, br.budget_id, br.transaction_id, br.revision, br.headcount, br.reason, br.state, br.prepared_by, br.version, b.department_id, b.location_id`;

async function insertRevision(tx: Queryable, grant: AccessGrant, budgetId: string, revision: number, headcount: number, reason: string) {
  const transactionId = await newTransaction(tx, grant.companyId, BUDGET_REVISION_KIND, null, grant.userId);
  const id = (
    await tx.query<{ id: string }>(
      `insert into manpower_budget_revision (company_id, budget_id, transaction_id, revision, headcount, reason, state, prepared_by, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, 'DRAFT', $7, $7, $7) returning id`,
      [grant.companyId, budgetId, transactionId, revision, headcount, reason, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, grant, 'manpower_budget_revision', id, 'CREATE', null, { budgetId, revision, headcount, state: 'DRAFT' });
  return { revisionId: id, budgetId, revision, headcount, state: 'DRAFT', version: 1 };
}

export async function createBudget(tx: Queryable, grant: AccessGrant, input: BudgetInput) {
  if (!admitsBudget(grant, input)) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  requireDate(input.periodStart, 'periodStart');
  requireDate(input.periodEnd, 'periodEnd');
  if (input.periodEnd < input.periodStart) throw new HttpError(422, 'INVALID_PERIOD', 'The period ends before it starts');
  await requireActiveMaster(tx, 'department', grant.companyId, input.departmentId);
  await requireActiveMaster(tx, 'location', grant.companyId, input.locationId);
  await requireActiveMaster(tx, 'designation', grant.companyId, input.designationId);
  const reason = requireText(input.reason, 'reason');
  const budgetId = (
    await tx.query<{ id: string }>(
      `insert into manpower_budget (company_id, department_id, location_id, designation_id, period_start, period_end, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7) returning id`,
      [grant.companyId, input.departmentId, input.locationId, input.designationId, input.periodStart, input.periodEnd, grant.userId],
    )
  ).rows[0]!.id;
  await audit(tx, grant, 'manpower_budget', budgetId, 'CREATE', null, {
    departmentId: input.departmentId,
    locationId: input.locationId,
    designationId: input.designationId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
  });
  return insertRevision(tx, grant, budgetId, 1, input.headcount, reason);
}

export async function createBudgetRevision(tx: Queryable, grant: AccessGrant, budgetId: string, input: { headcount: number; reason: string }) {
  const budget = (await tx.query<{ department_id: string; location_id: string }>(`select department_id, location_id from manpower_budget where company_id = $1 and id = $2`, [grant.companyId, budgetId])).rows[0];
  if (!budget || !(await canAccessBudget(tx, grant, budgetId))) throw notFound();
  if (!admitsBudget(grant, { departmentId: budget.department_id, locationId: budget.location_id })) throw new HttpError(403, 'FORBIDDEN', 'Not permitted');
  const reason = requireText(input.reason, 'reason');
  await lockBudget(tx, grant.companyId, budgetId);
  const open = await tx.query(`select 1 from manpower_budget_revision where company_id = $1 and budget_id = $2 and state in ('DRAFT', 'SUBMITTED')`, [grant.companyId, budgetId]);
  if (open.rowCount) throw new HttpError(409, 'OPEN_REVISION_EXISTS', 'This budget already has a revision in progress; finish or withdraw it first');
  const next = (await tx.query<{ n: number }>(`select coalesce(max(revision), 0) + 1 as n from manpower_budget_revision where company_id = $1 and budget_id = $2`, [grant.companyId, budgetId])).rows[0]!.n;
  return insertRevision(tx, grant, budgetId, next, input.headcount, reason);
}

/** The caller's own revision (as preparer), locked behind its transaction lock. */
async function lockPreparedRevision(tx: Queryable, grant: AccessGrant, revisionId: string): Promise<RevisionRow> {
  const target = (await tx.query<{ transaction_id: string; budget_id: string; prepared_by: string }>(`select transaction_id, budget_id, prepared_by from manpower_budget_revision where company_id = $1 and id = $2`, [grant.companyId, revisionId])).rows[0];
  if (!target || !(await canAccessBudget(tx, grant, target.budget_id))) throw notFound();
  if (target.prepared_by !== grant.userId) throw new HttpError(403, 'NOT_PREPARER', 'Only the preparer can change, submit or withdraw this revision');
  await lockTransaction(tx, target.transaction_id);
  return (
    await tx.query<RevisionRow>(
      `select ${REVISION_COLUMNS} from manpower_budget_revision br join manpower_budget b on b.company_id = br.company_id and b.id = br.budget_id
        where br.company_id = $1 and br.id = $2 for update of br`,
      [grant.companyId, revisionId],
    )
  ).rows[0]!;
}

export async function updateBudgetRevision(tx: Queryable, grant: AccessGrant, revisionId: string, input: { headcount: number; reason: string; expectedVersion: number }) {
  const r = await lockPreparedRevision(tx, grant, revisionId);
  if (r.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision can be changed');
  checkVersion(r.version, input.expectedVersion);
  const reason = requireText(input.reason, 'reason');
  const version = (
    await tx.query<{ version: number }>(`update manpower_budget_revision set headcount = $3, reason = $4, updated_by = $5 where company_id = $1 and id = $2 returning version`, [
      grant.companyId,
      r.id,
      input.headcount,
      reason,
      grant.userId,
    ])
  ).rows[0]!.version;
  await audit(tx, grant, 'manpower_budget_revision', r.id, 'UPDATE', { headcount: r.headcount }, { headcount: input.headcount });
  return { revisionId: r.id, state: 'DRAFT', headcount: input.headcount, version };
}

export async function submitBudgetRevision(tx: Queryable, grant: AccessGrant, revisionId: string, input: { expectedVersion: number }) {
  const r = await lockPreparedRevision(tx, grant, revisionId);
  if (r.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft revision can be submitted');
  checkVersion(r.version, input.expectedVersion);
  await setRootState(tx, 'manpower_budget_revision', grant.companyId, r, 'SUBMITTED', grant.userId, ', submitted_by = $4, submitted_at = now()');
  // FR-011: an independent HR Administrator decides; whoever prepared or submitted the revision never does, and nobody
  // whose scope does not reach this budget line is routed to (a revision has no employee for the engine to check).
  const outsideScope = await reviewersOutsideScope(tx, grant.companyId, BUDGET_REVISION_KIND, (g) => canAccessBudget(tx, g, r.budget_id));
  const { taskId } = await startApproval(tx, {
    companyId: grant.companyId,
    kind: BUDGET_REVISION_KIND,
    transactionId: r.transaction_id,
    ownerEmployeeId: null,
    actorUserId: grant.userId,
    excludeUserIds: [...new Set([r.prepared_by, grant.userId, ...outsideScope])],
  });
  await audit(tx, grant, 'manpower_budget_revision', r.id, 'SUBMIT', { state: 'DRAFT' }, { state: 'SUBMITTED', revision: r.revision, headcount: r.headcount });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'hiring.budget_revision.submitted',
    aggregateId: r.id,
    dedupeKey: `hiring.budget_revision.submitted:${r.id}`,
    payload: { revisionId: r.id, taskId },
  });
  return { revisionId: r.id, state: 'SUBMITTED' };
}

export async function withdrawBudgetRevision(tx: Queryable, grant: AccessGrant, revisionId: string) {
  const r = await lockPreparedRevision(tx, grant, revisionId);
  if (r.state !== 'DRAFT' && r.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'Only a draft or submitted revision can be withdrawn');
  const pending = r.state === 'SUBMITTED' ? await pendingTaskOf(tx, grant.companyId, r.transaction_id) : undefined;
  if (r.state === 'SUBMITTED') await cancelActiveApproval(tx, grant.companyId, r.transaction_id, grant.userId);
  await setRootState(tx, 'manpower_budget_revision', grant.companyId, r, 'WITHDRAWN', grant.userId);
  await audit(tx, grant, 'manpower_budget_revision', r.id, 'WITHDRAW', { state: r.state }, { state: 'WITHDRAWN' });
  // DF12: the reviewer whose task was cancelled is told that no decision is needed.
  if (pending) {
    await enqueueEvent(tx, {
      companyId: grant.companyId,
      topic: 'hiring.budget_revision.withdrawn',
      aggregateId: r.id,
      dedupeKey: `hiring.budget_revision.withdrawn:${r.id}`,
      payload: { revisionId: r.id, userId: pending.assignee_user_id },
    });
  }
  return { revisionId: r.id, state: 'WITHDRAWN' };
}

export interface BudgetDecisionInput {
  decision: 'APPROVE' | 'REJECT';
  reason?: string | undefined;
  idempotencyKey: string;
}

export async function decideBudgetRevision(tx: Queryable, grant: AccessGrant, taskId: string, input: BudgetDecisionInput) {
  if (input.decision === 'REJECT' && !input.reason?.trim()) throw new HttpError(422, 'REASON_REQUIRED', 'Record why the revision is rejected');
  const transactionId = await taskTransaction(tx, grant.companyId, taskId, grant.userId, BUDGET_REVISION_KIND);
  if (!transactionId) throw notFound();
  await lockTransaction(tx, transactionId);
  const r = (
    await tx.query<RevisionRow & { submitted_by: string | null }>(
      `select ${REVISION_COLUMNS}, br.submitted_by from manpower_budget_revision br join manpower_budget b on b.company_id = br.company_id and b.id = br.budget_id
        where br.company_id = $1 and br.transaction_id = $2 for update of br`,
      [grant.companyId, transactionId],
    )
  ).rows[0];
  if (!r || !(await canAccessBudget(tx, grant, r.budget_id))) throw notFound();
  const prior = await priorDecisionTask(tx, grant.companyId, input.idempotencyKey);
  if (prior) {
    if (prior !== taskId) throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', 'Idempotency key was used for another task');
    return { revisionId: r.id, state: r.state, replayed: true };
  }
  if (!(await isPendingTaskOf(tx, grant.companyId, taskId, grant.userId))) throw new HttpError(409, 'TASK_CLOSED', 'This task has already been decided');
  if (r.state !== 'SUBMITTED') throw new HttpError(409, 'INVALID_STATE', 'This revision is not waiting for a decision');
  // Approving changes the headcount in force: serialise with requisition budget checks on the same line.
  if (input.decision === 'APPROVE') await lockBudget(tx, grant.companyId, r.budget_id);

  const result = await decideTask(tx, { grant, taskId, decision: input.decision, reason: input.reason, idempotencyKey: input.idempotencyKey, permission: { resource: 'manpower_budget', action: 'approve' } });
  if (result.replayed) return { revisionId: r.id, state: r.state, replayed: true };
  const state = result.outcome === 'APPROVED' ? 'APPROVED' : 'REJECTED';
  await setRootState(tx, 'manpower_budget_revision', grant.companyId, r, state, grant.userId, ', decided_by = $4, decided_at = now()');
  await audit(tx, grant, 'manpower_budget_revision', r.id, input.decision, { state: 'SUBMITTED' }, { state, revision: r.revision, headcount: r.headcount }, input.reason ?? null);
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'hiring.budget_revision.decided',
    aggregateId: r.id,
    dedupeKey: `hiring.budget_revision.decided:${r.id}`,
    payload: { revisionId: r.id, outcome: state, userId: r.submitted_by ?? r.prepared_by },
  });
  return { revisionId: r.id, state, replayed: false };
}

// ---------------------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------------------

const BUDGET_SELECT = `select b.id, b.department_id as "departmentId", d.name as "departmentName", b.location_id as "locationId", l.name as "locationName",
       b.designation_id as "designationId", g.name as "designationName", to_char(b.period_start, 'YYYY-MM-DD') as "periodStart",
       to_char(b.period_end, 'YYYY-MM-DD') as "periodEnd", ${APPROVED_HEADCOUNT_SQL('b.company_id', 'b.id')} as "approvedHeadcount",
       ${COMMITTED_SQL('b.company_id', 'b.id', 'null::uuid')} as committed,
       (select json_build_object('revisionId', o.id, 'revision', o.revision, 'state', o.state, 'headcount', o.headcount)
          from manpower_budget_revision o where o.company_id = b.company_id and o.budget_id = b.id and o.state in ('DRAFT', 'SUBMITTED')) as "openRevision"
  from manpower_budget b
  join department d on d.company_id = b.company_id and d.id = b.department_id
  join location l on l.company_id = b.company_id and l.id = b.location_id
  join designation g on g.company_id = b.company_id and g.id = b.designation_id`;

/** Without page or pageSize the list answers its first 500 lines, as before paging; `total` counts them all. */
export const BUDGET_LIST_CAP = 500;

export async function listBudgets(
  db: Queryable,
  grant: AccessGrant,
  q: { departmentId?: string | undefined; locationId?: string | undefined; designationId?: string | undefined; on?: string | undefined } & Paging,
) {
  const p = new SqlParams();
  const where = [budgetScope(grant, 'b', p)];
  if (q.departmentId) where.push(`b.department_id = ${p.add(q.departmentId)}::uuid`);
  if (q.locationId) where.push(`b.location_id = ${p.add(q.locationId)}::uuid`);
  if (q.designationId) where.push(`b.designation_id = ${p.add(q.designationId)}::uuid`);
  if (q.on) {
    const on = p.add(requireDate(q.on, 'on'));
    where.push(`b.period_start <= ${on}::date and b.period_end >= ${on}::date`);
  }
  return pageOf(db, `${BUDGET_SELECT} where ${where.join(' and ')}`, p.values, `"departmentName", "locationName", "designationName", "periodStart", id`, q, BUDGET_LIST_CAP);
}

export async function getBudget(db: Queryable, grant: AccessGrant, budgetId: string) {
  const p = new SqlParams([budgetId]);
  const row = (await db.query(`${BUDGET_SELECT} where b.id = $1 and ${budgetScope(grant, 'b', p)}`, p.values)).rows[0];
  if (!row) throw notFound();
  const revisions = (
    await db.query(
      `select br.id as "revisionId", br.revision, br.headcount, br.reason, br.state, br.prepared_by as "preparedBy",
              ${personSql('br.company_id', 'br.prepared_by', 'br.created_at')} as "preparedByPerson", br.submitted_at as "submittedAt",
              br.decided_by as "decidedBy", ${personSql('br.company_id', 'br.decided_by', 'br.decided_at')} as "decidedByPerson", br.decided_at as "decidedAt",
              br.version, br.created_at as "createdAt"
         from manpower_budget_revision br where br.company_id = $1 and br.budget_id = $2 order by br.revision desc`,
      [grant.companyId, budgetId],
    )
  ).rows;
  return { ...row, revisions };
}

/** The reviewer's queue: each pending revision with its budget line, the headcount in force and the commitments. */
export async function budgetTasks(db: Queryable, grant: AccessGrant) {
  const tasks = (await myOpenTasks(db, grant, BUDGET_REVISION_KIND)).items as { taskId: string; transactionId: string; assignedAt: Date }[];
  const items = [];
  for (const t of tasks) {
    const p = new SqlParams([t.transactionId]);
    const row = (
      await db.query(
        `select br.id as "revisionId", br.revision, br.headcount, br.reason, br.state, br.prepared_by as "preparedBy",
                ${personSql('br.company_id', 'br.prepared_by', 'br.created_at')} as "preparedByPerson", br.submitted_at as "submittedAt", q.*
           from manpower_budget_revision br join (${BUDGET_SELECT} where ${budgetScope(grant, 'b', p)}) q on q.id = br.budget_id
          where br.company_id = ${p.add(grant.companyId)}::uuid and br.transaction_id = $1`,
        p.values,
      )
    ).rows[0];
    items.push({ taskId: t.taskId, transactionId: t.transactionId, assignedAt: t.assignedAt, revision: row ?? null });
  }
  return { items };
}
