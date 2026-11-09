// The employee's own self-entry and submission (H3 TN18; F1; FR-042; DF03). In the Employee OWN context the employee
// scores each goal 1..5 with an optional comment while the appraisal is a draft or was returned, inside the self-entry
// window or an authorised exception (FR-040), and, where the cycle requires a KRA review (FR-041; I-77 item 3), only once the
// goals have been reviewed and so taken effect. Submission fixes the self-entry as an immutable revision, pins the
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
  appraisalCompetencies,
  type AppraisalRow,
  audit,
  checkVersion,
  type CycleRow,
  loadCycle,
  lockAppraisal,
  optionalText,
  ownEmployee,
  requireEntryWindow,
  requireGoalsInEffect,
  setAppraisalState,
  touchAppraisal,
  workingRevision,
} from './common.js';
import { isSectionCode, orderedSections, partyFills, type SectionParty } from './sections.js';

async function lockOwn(tx: Queryable, grant: AccessGrant, id: string): Promise<AppraisalRow> {
  const employeeId = ownEmployee(grant);
  const a = await lockAppraisal(tx, grant.companyId, id);
  if (!a || a.employee_id !== employeeId) throw notFound();
  return a;
}

export interface ScoreInput {
  score?: number | null | undefined;
  comment?: string | null | undefined;
}

export interface SectionInput {
  section: string;
  /** null or blank clears it. */
  text: string | null;
}

export interface SelfEntryInput {
  entries: ({ goalId: string } & ScoreInput)[];
  /** FR-041 / I-86: the appraisal's own competencies (as copied at enrolment). */
  competencies?: ({ competencyId: string } & ScoreInput)[] | undefined;
  /** FR-042: the employee's part of the sections the cycle includes. */
  sections?: SectionInput[] | undefined;
  comment?: string | null | undefined;
  expectedVersion: number;
}

/** The appraisal's competency ids, refusing an unknown or repeated one. */
export async function checkCompetencyIds(db: Queryable, companyId: string, appraisalId: string, ids: readonly string[]): Promise<void> {
  const known = new Set((await appraisalCompetencies(db, companyId, appraisalId)).map((k) => k.id));
  const seen = new Set<string>();
  for (const id of ids) {
    if (!known.has(id)) throw new HttpError(422, 'UNKNOWN_COMPETENCY', 'Every competency entry must be one of this appraisal’s competencies', { competencyId: id });
    if (seen.has(id)) throw new HttpError(422, 'DUPLICATE_COMPETENCY', 'Each competency is entered once', { competencyId: id });
    seen.add(id);
  }
}

/** FR-042: a section the cycle includes and the party fills, each once; an excluded section takes no entry (I-86). */
export function checkSections(c: CycleRow, sections: readonly SectionInput[], party: SectionParty): void {
  const seen = new Set<string>();
  for (const s of sections) {
    if (!isSectionCode(s.section)) throw new HttpError(422, 'UNKNOWN_SECTION', 'Choose sections from the appraisal section catalogue', { section: s.section });
    if (!c.sections.includes(s.section)) throw new HttpError(422, 'SECTION_NOT_INCLUDED', 'This cycle does not include that section', { section: s.section });
    if (!partyFills(s.section, party)) throw new HttpError(422, 'SECTION_NOT_FILLED_BY_YOU', party === 'EMPLOYEE' ? 'The manager fills that section' : 'The employee fills that section', { section: s.section });
    if (seen.has(s.section)) throw new HttpError(422, 'DUPLICATE_SECTION', 'Each section is entered once', { section: s.section });
    seen.add(s.section);
  }
}

/** Writes a party's section texts on the revision (null clears), touching only those that change. */
export async function writeSections(tx: Queryable, companyId: string, appraisalId: string, revisionId: string, party: SectionParty, sections: readonly SectionInput[], userId: string): Promise<void> {
  for (const s of sections) {
    await tx.query(
      `insert into appraisal_section_entry (company_id, appraisal_id, revision_id, section, party, body, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7)
       on conflict (company_id, revision_id, section, party) do update set body = excluded.body, updated_by = excluded.updated_by
        where appraisal_section_entry.body is distinct from excluded.body`,
      [companyId, appraisalId, revisionId, s.section, party, optionalText(s.text), userId],
    );
  }
}

/** The included sections the party has not filled on the revision. */
export async function unfilledSections(db: Queryable, companyId: string, revisionId: string, c: CycleRow, party: SectionParty): Promise<string[]> {
  const required = orderedSections(c.sections).filter((s) => partyFills(s.code, party)).map((s) => s.code);
  if (required.length === 0) return [];
  const filled = new Set(
    (
      await db.query<{ section: string }>(`select section from appraisal_section_entry where company_id = $1 and revision_id = $2 and party = $3 and body is not null`, [
        companyId,
        revisionId,
        party,
      ])
    ).rows.map((r) => r.section),
  );
  return required.filter((s) => !filled.has(s));
}

/** Saves part or all of the draft self-entry; a null score clears it. Goals are the appraisal's own active goals. */
export async function saveSelfEntry(tx: Queryable, grant: AccessGrant, id: string, input: SelfEntryInput): Promise<void> {
  const a = await lockOwn(tx, grant, id);
  checkVersion(a.version, input.expectedVersion);
  if (a.state !== 'DRAFT' && a.state !== 'RETURNED') throw new HttpError(409, 'INVALID_STATE', 'The self-entry can change only before it is submitted');
  const cycle = (await loadCycle(tx, grant.companyId, a.cycle_id))!;
  await requireEntryWindow(tx, grant.companyId, a.id, cycle, 'SELF_ENTRY', grant.businessDate);
  await requireGoalsInEffect(tx, grant.companyId, a.id, cycle);
  const rev = await workingRevision(tx, grant.companyId, a, true);
  if (rev.state !== 'DRAFT') throw new HttpError(409, 'INVALID_STATE', 'The self-entry can change only before it is submitted');
  const goals = new Set((await activeGoals(tx, grant.companyId, a.id)).map((g) => g.id));
  const seen = new Set<string>();
  for (const e of input.entries) {
    if (!goals.has(e.goalId)) throw new HttpError(422, 'UNKNOWN_GOAL', 'Every entry must be one of this appraisal’s goals', { goalId: e.goalId });
    if (seen.has(e.goalId)) throw new HttpError(422, 'DUPLICATE_GOAL', 'Each goal is entered once', { goalId: e.goalId });
    seen.add(e.goalId);
  }
  const competencyInput = input.competencies ?? [];
  await checkCompetencyIds(tx, grant.companyId, a.id, competencyInput.map((k) => k.competencyId));
  checkSections(cycle, input.sections ?? [], 'EMPLOYEE');
  for (const k of competencyInput) {
    await tx.query(
      `insert into appraisal_competency_entry (company_id, appraisal_id, revision_id, item_id, self_score, self_comment, created_by, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $7)
       on conflict (company_id, revision_id, item_id) do update set self_score = excluded.self_score, self_comment = excluded.self_comment, updated_by = excluded.updated_by
        where appraisal_competency_entry.self_score is distinct from excluded.self_score or appraisal_competency_entry.self_comment is distinct from excluded.self_comment`,
      [grant.companyId, a.id, rev.id, k.competencyId, k.score ?? null, optionalText(k.comment ?? null), grant.userId],
    );
  }
  await writeSections(tx, grant.companyId, a.id, rev.id, 'EMPLOYEE', input.sections ?? [], grant.userId);
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
  // Field names and progress only: the scores, comments and section texts never enter the audit trail.
  await audit(tx, grant, 'appraisal', a.id, 'SAVE_SELF_ENTRY', null, {
    revision: a.revision,
    goalsEntered: entered,
    goals: goals.size,
    fields: [
      'selfScore',
      'selfComment',
      ...(competencyInput.length > 0 ? ['competencySelfScore', 'competencySelfComment'] : []),
      ...(input.sections && input.sections.length > 0 ? ['sectionText'] : []),
    ],
    sections: (input.sections ?? []).map((s) => s.section),
  });
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
  await requireGoalsInEffect(tx, grant.companyId, a.id, cycle);
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
  // FR-041 / FR-042 (I-86): every competency self-scored and the employee's part of every included section filled; an excluded
  // section never blocks the submission.
  const unscoredCompetencies = (
    await tx.query<{ sequence: number }>(
      `select k.sequence from appraisal_competency_item k
         left join appraisal_competency_entry e on e.company_id = k.company_id and e.item_id = k.id and e.revision_id = $3
        where k.company_id = $1 and k.appraisal_id = $2 and e.self_score is null order by k.sequence`,
      [grant.companyId, a.id, rev.id],
    )
  ).rows.map((r) => r.sequence);
  const sections = await unfilledSections(tx, grant.companyId, rev.id, cycle, 'EMPLOYEE');
  if (unscored.length + unscoredCompetencies.length + sections.length > 0) {
    throw new HttpError(422, 'SELF_ENTRY_INCOMPLETE', 'Score every goal and competency and fill every included section before submitting', {
      goals: unscored,
      competencies: unscoredCompetencies,
      sections,
    });
  }

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
