// Dated reporting settings (I-83 items 4, 5 and 6; decided under owner delegation, 6 Nov 2026; BR-045; DF17; FR-038). Migration
// 0196. One revision is in force on each company-local date. HR changes a value by starting a new revision on today or a later
// date, with a reason; the revision in force is closed on that date, nothing is rewritten, and both writes are audited.
// I-92 (0245): the due period of an expense final decision, in business days from the claim's arrival at its financial step.
import { writeAudit } from '../../audit/audit.js';
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import type { AccessGrant } from '../access/authorize.js';

export interface ReportingSetting {
  id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  smallCountThreshold: number;
  recentActivityDays: number;
  salaryProgressionYears: number;
  expenseDecisionDueDays: number;
  reason: string;
  createdAt: string;
  version: number;
}

/**
 * The values every company starts with, from 2000-01-01, until HR starts a revision (I-83): a people-count below 5 that the viewer
 * cannot open record by record is shown as "fewer than 5"; the dashboard lists the last 14 days of the assignment's own actions;
 * the salary progression chart spans 5 financial years. 0196 gives existing companies the same revision. I-92 (0245): an expense
 * claim's final decision falls due 5 business days after it reaches its financial step, DF03's escalation point; 0245 gives the
 * existing revisions the same value.
 */
export const REPORTING_SETTING_DEFAULTS = { smallCountThreshold: 5, recentActivityDays: 14, salaryProgressionYears: 5, expenseDecisionDueDays: 5 } as const;
export const DEFAULTS_REASON = 'Initial values decided under owner delegation, 6 Nov 2026 (I-83)';

const COLUMNS = `id, to_char(effective_from, 'YYYY-MM-DD') as "effectiveFrom", to_char(effective_to, 'YYYY-MM-DD') as "effectiveTo",
  small_count_threshold as "smallCountThreshold", recent_activity_days as "recentActivityDays", salary_progression_years as "salaryProgressionYears",
  expense_decision_due_days as "expenseDecisionDueDays", reason, created_at as "createdAt", version`;

/** The revision in force on a company-local date, or null when the company has none (callers fail closed). */
export async function settingInForce(db: Queryable, companyId: string, day: string): Promise<ReportingSetting | null> {
  return (
    (
      await db.query<ReportingSetting>(
        `select ${COLUMNS} from reporting_setting where company_id = $1 and effective_from <= $2::date and (effective_to is null or effective_to > $2::date)`,
        [companyId, day],
      )
    ).rows[0] ?? null
  );
}

/** Provisioning: a new company's first revision, as 0196 gives an existing one. Re-running changes nothing. */
export async function ensureDefaultSetting(db: Queryable, companyId: string, createdBy: string): Promise<void> {
  const d = REPORTING_SETTING_DEFAULTS;
  await db.query(
    `insert into reporting_setting (company_id, effective_from, small_count_threshold, recent_activity_days, salary_progression_years, expense_decision_due_days, reason, created_by)
     select $1, '2000-01-01', $2, $3, $4, $7, $5, $6 where not exists (select 1 from reporting_setting where company_id = $1)`,
    [companyId, d.smallCountThreshold, d.recentActivityDays, d.salaryProgressionYears, DEFAULTS_REASON, createdBy, d.expenseDecisionDueDays],
  );
}

/** Every revision, latest first, and the one in force today. */
export async function listSettings(db: Queryable, grant: AccessGrant) {
  const items = (await db.query<ReportingSetting>(`select ${COLUMNS} from reporting_setting where company_id = $1 order by effective_from desc`, [grant.companyId])).rows;
  return { businessDate: grant.businessDate, inForce: await settingInForce(db, grant.companyId, grant.businessDate), items };
}

export interface NewRevision {
  effectiveFrom: string;
  smallCountThreshold: number;
  recentActivityDays: number;
  salaryProgressionYears: number;
  /** Optional (I-92): when left out, the revision carries the value of the revision it follows. */
  expenseDecisionDueDays?: number | undefined;
  reason: string;
}

/**
 * A revision from `effectiveFrom` (today or later): the open revision ends that day. A revision already starting on or after
 * that date is refused (history is not rewritten; a later start leaves the planned one in place). Runs in the caller's transaction.
 */
export async function startRevision(tx: Queryable, grant: AccessGrant, body: NewRevision): Promise<ReportingSetting> {
  if (body.effectiveFrom < grant.businessDate) throw new HttpError(422, 'EFFECTIVE_DATE_IN_PAST', 'A new revision starts today or later; earlier periods are not changed');
  const rows = (await tx.query<ReportingSetting>(`select ${COLUMNS} from reporting_setting where company_id = $1 order by effective_from for update`, [grant.companyId])).rows;
  if (rows.some((r) => r.effectiveFrom >= body.effectiveFrom)) {
    throw new HttpError(409, 'REVISION_ALREADY_PLANNED', 'A revision already starts on or after that date; choose a later start date');
  }
  const open = rows.find((r) => r.effectiveTo === null);
  // A caller that does not name the due period (an older form) keeps the one already in force; nothing falls back to a constant.
  const dueDays = body.expenseDecisionDueDays ?? open?.expenseDecisionDueDays ?? rows.at(-1)?.expenseDecisionDueDays;
  if (dueDays === undefined) throw new HttpError(422, 'EXPENSE_DECISION_DUE_DAYS_REQUIRED', 'Give the number of business days within which an expense final decision falls due');
  if (open) {
    await tx.query(`update reporting_setting set effective_to = $3::date, updated_by = $4 where company_id = $1 and id = $2`, [grant.companyId, open.id, body.effectiveFrom, grant.userId]);
    await writeAudit(tx, {
      companyId: grant.companyId,
      resource: 'reporting_setting',
      recordKey: open.id,
      actorUserId: grant.userId,
      actingAssignmentId: grant.assignmentId,
      action: 'UPDATE',
      priorVersion: open.version,
      newVersion: open.version + 1,
      before: { effectiveTo: null },
      after: { effectiveTo: body.effectiveFrom },
      reason: body.reason,
    });
  }
  const created = (
    await tx.query<ReportingSetting>(
      `insert into reporting_setting (company_id, effective_from, small_count_threshold, recent_activity_days, salary_progression_years, expense_decision_due_days, reason, created_by, updated_by)
       values ($1, $2::date, $3, $4, $5, $8, $6, $7, $7) returning ${COLUMNS}`,
      [grant.companyId, body.effectiveFrom, body.smallCountThreshold, body.recentActivityDays, body.salaryProgressionYears, body.reason, grant.userId, dueDays],
    )
  ).rows[0]!;
  await writeAudit(tx, {
    companyId: grant.companyId,
    resource: 'reporting_setting',
    recordKey: created.id,
    actorUserId: grant.userId,
    actingAssignmentId: grant.assignmentId,
    action: 'CREATE',
    newVersion: created.version,
    after: {
      effectiveFrom: created.effectiveFrom,
      smallCountThreshold: created.smallCountThreshold,
      recentActivityDays: created.recentActivityDays,
      salaryProgressionYears: created.salaryProgressionYears,
      expenseDecisionDueDays: created.expenseDecisionDueDays,
    },
    reason: body.reason,
  });
  return created;
}
