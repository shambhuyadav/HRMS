// The employee's own self-entry and submission (H3 TN18; F1; FR-042; DF03). In the Employee OWN context the employee
// scores each goal 1..5 with an optional comment while the appraisal is a draft or was returned, inside the self-entry
// window or an authorised exception (FR-040). Submission fixes the self-entry as an immutable revision, pins the
// cycle's reviewer levels and starts the DF03 route: the current direct manager rates (HR fallback list when the
// manager is ineligible); no eligible rater blocks the submission with a repairable routing error.
import { enqueueEvent } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError, notFound } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';
import { startApproval } from '../workflow/engine.js';
import {
  activeGoals,
  APPRAISAL_KIND,
  type AppraisalRow,
  audit,
  checkVersion,
  loadCycle,
  lockAppraisal,
  optionalText,
  ownEmployee,
  requireEntryWindow,
  setAppraisalState,
  touchAppraisal,
  workingRevision,
} from './common.js';

async function lockOwn(tx: Queryable, grant: AccessGrant, id: string): Promise<AppraisalRow> {
  const employeeId = ownEmployee(grant);
  const a = await lockAppraisal(tx, grant.companyId, id);
  if (!a || a.employee_id !== employeeId) throw notFound();
  return a;
}

export interface SelfEntryInput {
  entries: { goalId: string; score?: number | null | undefined; comment?: string | null | undefined }[];
  comment?: string | null | undefined;
  expectedVersion: number;
}

/** Saves part or all of the draft self-entry; a null score clears it. Goals are the appraisal's own active goals. */
export async function saveSelfEntry(tx: Queryable, grant: AccessGrant, id: string, input: SelfEntryInput): Promise<void> {
  const a = await lockOwn(tx, grant, id);
  checkVersion(a.version, input.expectedVersion);
  if (a.state !== 'DRAFT' && a.state !== 'RETURNED') throw new HttpError(409, 'INVALID_STATE', 'The self-entry can change only before it is submitted');
  const cycle = (await loadCycle(tx, grant.companyId, a.cycle_id))!;
  await requireEntryWindow(tx, grant.companyId, a.id, cycle, 'SELF_ENTRY', grant.businessDate);
  const rev = await workingRevision(tx, grant.companyId, a, true);
  if (rev.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'The self-entry can change only before it is submitted');
  const goals = new Set((await activeGoals(tx, grant.companyId, a.id)).map((g) => g.id));
  const seen = new Set<string>();
  for (const e of input.entries) {
    if (!goals.has(e.goalId)) throw new HttpError(422, 'UNKNOWN_GOAL', 'Every entry must be one of this appraisal’s goals', { goalId: e.goalId });
    if (seen.has(e.goalId)) throw new HttpError(422, 'DUPLICATE_GOAL', 'Each goal is entered once', { goalId: e.goalId });
    seen.add(e.goalId);
  }
  for (const e of input.entries) {
    const score = e.score ?? null;
    const comment = optionalText(e.comment ?? null);
    await tx.query(
      `insert into appraisal_entry (company_id, appraisal_id, revision_id, item_id, self_score, self_comment, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7)
       on conflict (company_id, revision_id, item_id) do update set self_score = excluded.self_score, self_comment = excluded.self_comment, updated_by = excluded.updated_by
        where appraisal_entry.self_score is distinct from excluded.self_score or appraisal_entry.self_comment is distinct from excluded.self_comment`,
      [grant.companyId, a.id, rev.id, e.goalId, score, comment, grant.userId],
    );
  }
  if (input.comment !== undefined) {
    const comment = optionalText(input.comment);
    if (comment !== rev.self_comment) {
      await tx.query(`update appraisal_revision set self_comment = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, rev.id, comment, grant.userId]);
    }
  }
  await touchAppraisal(tx, grant.companyId, a.id, grant.userId);
  const entered = (
    await tx.query<{ n: number }>(
      `select count(*)::int as n from appraisal_entry e join appraisal_item i on i.company_id = e.company_id and i.id = e.item_id and i.active
        where e.company_id = $1 and e.revision_id = $2 and e.self_score is not null`,
      [grant.companyId, rev.id],
    )
  ).rows[0]!.n;
  // Field names and progress only: the scores and comments never enter the audit trail.
  await audit(tx, grant, 'appraisal', a.id, 'SAVE_SELF_ENTRY', null, { revision: a.revision, goalsEntered: entered, goals: goals.size, fields: ['selfScore', 'selfComment'] });
}

/** Submits the self-entry (F1): every goal scored, weights totalling exactly 100, inside the window or an exception. */
export async function submitSelfEntry(tx: Queryable, grant: AccessGrant, id: string, input: { expectedVersion: number }): Promise<{ taskId: string }> {
  const a = await lockOwn(tx, grant, id);
  checkVersion(a.version, input.expectedVersion);
  if (a.state !== 'DRAFT' && a.state !== 'RETURNED') throw new HttpError(409, 'INVALID_STATE', 'Only a draft or returned appraisal can be submitted');
  // Share lock: a concurrent change of the cycle's reviewer levels (row lock for update) waits for this submission
  // and is then refused, or this submission waits and pins the new levels.
  const cycle = (await loadCycle(tx, grant.companyId, a.cycle_id, 'for share'))!;
  await requireEntryWindow(tx, grant.companyId, a.id, cycle, 'SELF_ENTRY', grant.businessDate);
  const rev = await workingRevision(tx, grant.companyId, a, true);
  if (rev.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'Only a draft or returned appraisal can be submitted');
  const goals = await activeGoals(tx, grant.companyId, a.id);
  if (goals.length === 0) throw new HttpError(422, 'GOALS_REQUIRED', 'The appraisal has no goals yet');
  const total = goals.reduce((s, g) => s + g.weight, 0);
  if (total !== 100) throw new HttpError(422, 'WEIGHT_TOTAL_NOT_100', 'Goal weights must total exactly 100', { total });
  const unscored = (
    await tx.query<{ sequence: number }>(
      `select i.sequence from appraisal_item i
         left join appraisal_entry e on e.company_id = i.company_id and e.item_id = i.id and e.revision_id = $3
        where i.company_id = $1 and i.appraisal_id = $2 and i.active and e.self_score is null order by i.sequence`,
      [grant.companyId, a.id, rev.id],
    )
  ).rows.map((r) => r.sequence);
  if (unscored.length > 0) throw new HttpError(422, 'SELF_ENTRY_INCOMPLETE', 'Score every goal before submitting', { goals: unscored });

  // DF03: the cycle's reviewer levels are pinned on submission; each submission is a new transaction revision.
  await tx.query(
    `update appraisal_revision set state = 'SUBMITTED', submitted_by = $3, submitted_at = now(), approval_levels = $4, updated_by = $3 where company_id = $1 and id = $2`,
    [grant.companyId, rev.id, grant.userId, cycle.approval_levels],
  );
  await tx.query(`update business_transaction set revision = $3, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, a.transaction_id, a.revision, grant.userId]);
  await setAppraisalState(tx, grant.companyId, a, 'SUBMITTED', grant.userId);
  const { taskId } = await startApproval(tx, { companyId: grant.companyId, kind: APPRAISAL_KIND, transactionId: a.transaction_id, ownerEmployeeId: a.employee_id, actorUserId: grant.userId });
  await audit(tx, grant, 'appraisal', a.id, a.revision > 1 ? 'RESUBMIT' : 'SUBMIT', { state: a.state, revision: a.revision }, { state: 'SUBMITTED', revision: a.revision, approvalLevels: cycle.approval_levels, goals: goals.length });
  await enqueueEvent(tx, {
    companyId: grant.companyId,
    topic: 'appraisal.submitted',
    aggregateId: a.id,
    dedupeKey: `appraisal.submitted:${a.id}:${a.revision}`,
    payload: { appraisalId: a.id, taskId, revision: a.revision },
  });
  return { taskId };
}
