// F2 Recruiter dashboard metrics ("Approved requisitions; Operational pipeline stage counts; Interview tasks due; Offers
// awaiting eligible Admin review"), ready for the dashboard's metric catalogue. They use the same scope predicates as
// the requisition, application and offer lists, so counts reconcile with the drill-down pages (BR-045). Interview
// scheduling is not part of the hiring build, so that metric reports NOT_AVAILABLE rather than a misleading zero.
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
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
  /** Interview scheduling is not built: shown as unavailable, never as zero. */
  INTERVIEW_TASKS_DUE: async () => ({ status: 'NOT_AVAILABLE' }),
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
