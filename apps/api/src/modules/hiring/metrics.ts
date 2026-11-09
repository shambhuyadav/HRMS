// F2 Recruiter dashboard metrics ("Approved requisitions; Operational pipeline stage counts; Interview tasks due; Offers
// awaiting eligible Admin review"), ready for the dashboard's metric catalogue. They use the same scope predicates as
// the requisition, application and offer lists, so counts reconcile with the drill-down pages (BR-045).
//
// "Interview tasks due" (decided under owner delegation, 6 Nov 2026, docs/03 I-92): interview scheduling is not built (F1 defines
// stages only, and no interview date, panel or feedback record exists), so the task is the one the tracker already names: an
// application at the INTERVIEW stage waits for its owner to complete the interview (pendingAction COMPLETE_INTERVIEW). DF17 "pending
// means current actionable task", so every such application of the viewer is due now; no interview deadline is invented (OQ28 "no
// performance target presumed"). Ownership belongs to a user who holds the application management duty, so the figure counts only
// when the selected assignment itself holds that duty (DF17 "no merging across role assignments"), within its requisition scope.
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, resolveAccess, SqlParams } from '../access/authorize.js';
import type { MetricResult } from '../dashboard/service.js';
import { OPEN_STAGES } from './application.js';
import { requisitionScope } from './scope.js';

const count = async (db: Queryable, sql: string, params: SqlParams): Promise<MetricResult> => ({
  status: 'OK',
  value: Number((await db.query<{ n: string }>(sql, params.values)).rows[0]?.n ?? 0),
});

export const HIRING_METRICS: Readonly<Record<string, (db: Queryable, grant: AccessGrant) => Promise<MetricResult>>> = {
  /** Approved requisitions (open for sourcing) in scope. */
  APPROVED_REQUISITIONS: (db, g) => {
    const p = new SqlParams();
    return count(db, `select count(*) as n from requisition r where ${requisitionScope(g, 'r', p)} and r.state = 'APPROVED'`, p);
  },
  /** Open applications (APPLIED, SCREENING, INTERVIEW, OFFER) of in-scope requisitions. */
  OPEN_PIPELINE_APPLICATIONS: (db, g) => {
    const p = new SqlParams();
    return count(
      db,
      `select count(*) as n from application a join requisition r on r.company_id = a.company_id and r.id = a.requisition_id
        where ${requisitionScope(g, 'r', p)} and a.stage = any(${p.add(OPEN_STAGES)}::text[])`,
      p,
    );
  },
  /**
   * The viewer's own applications at the INTERVIEW stage in scope (GET /hiring/applications?stage=INTERVIEW&ownerUserId=<viewer>), in an
   * assignment that holds the application management duty; another assignment's ownership is not this one's work.
   */
  INTERVIEW_TASKS_DUE: async (db, g) => {
    const manages = await resolveAccess(db, { userId: g.userId, companyId: g.companyId, assignmentId: g.assignmentId, resource: 'application', action: 'manage', fieldGroups: ['operational'] });
    if (!manages.allowed) return { status: 'NOT_CONFIGURED', message: 'Interview tasks belong to application owners: this assignment does not hold the application management duty' };
    const p = new SqlParams();
    return count(
      db,
      `select count(*) as n from application a join requisition r on r.company_id = a.company_id and r.id = a.requisition_id
        where ${requisitionScope(g, 'r', p)} and a.stage = 'INTERVIEW' and a.owner_user_id = ${p.add(g.userId)}::uuid`,
      p,
    );
  },
  /** Submitted offers waiting for the independent eligible Admin decision (state only, no compensation). */
  OFFERS_AWAITING_APPROVAL: (db, g) => {
    const p = new SqlParams();
    return count(
      db,
      `select count(*) as n from hiring_offer o join requisition r on r.company_id = o.company_id and r.id = o.requisition_id
        where ${requisitionScope(g, 'r', p)} and o.state = 'SUBMITTED'`,
      p,
    );
  },
};

/** Per-stage application counts of in-scope requisitions (F2 "operational pipeline stage counts"). */
export async function pipelineStageCounts(db: Queryable, grant: AccessGrant): Promise<Record<string, number>> {
  const p = new SqlParams();
  const rows = (
    await db.query<{ stage: string; n: number }>(
      `select a.stage, count(*)::int as n from application a join requisition r on r.company_id = a.company_id and r.id = a.requisition_id
        where ${requisitionScope(grant, 'r', p)} group by a.stage`,
      p.values,
    )
  ).rows;
  return Object.fromEntries(rows.map((r) => [r.stage, r.n]));
}
