// Provisioning: a new company's first dated appraisal scoring split, as 0230 gives an existing one (I-86, decided under owner
// delegation, 6 Nov 2026: goals 70 / competencies 30, the usual Indian practice). HR changes it with a new dated revision; a
// cycle keeps its own copy. Re-running changes nothing. Kept free of other imports so provisioning can load it cheaply.
import type { Queryable } from '../../db/queryable.js';

export const SCORING_DEFAULTS = { goalWeightPercent: 70, competencyWeightPercent: 30 } as const;
export const SCORING_DEFAULTS_REASON = 'Initial split decided under owner delegation, 6 Nov 2026 (I-86)';

export async function ensureDefaultScoringSetting(db: Queryable, companyId: string, createdBy: string): Promise<void> {
  await db.query(
    `insert into appraisal_scoring_setting (company_id, effective_from, goal_weight_percent, competency_weight_percent, reason, created_by)
     select $1, '2000-01-01', $2, $3, $4, $5 where not exists (select 1 from appraisal_scoring_setting where company_id = $1)`,
    [companyId, SCORING_DEFAULTS.goalWeightPercent, SCORING_DEFAULTS.competencyWeightPercent, SCORING_DEFAULTS_REASON, createdBy],
  );
}
