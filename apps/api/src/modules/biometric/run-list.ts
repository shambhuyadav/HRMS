// F2 "Failed integration runs" (FR-088; FR-097; BR-045): the biometric sync runs that failed or stopped partway, shared by
// GET /biometric/runs and the System Administrator's dashboard widget. A run belongs to no employee, so both are for an
// unrestricted company-scope assignment only. Run identity, window, state and counts; never the profile's secrets.
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';

export const RUNS_FROM = `from biometric_sync_run r join company c on c.id = r.company_id`;

export interface RunFilters {
  /** Only runs that ended FAILED or PARTIAL. */
  failed?: boolean | undefined;
  /** Company-local dates the run started on, inclusive. */
  from?: string | undefined;
  to?: string | undefined;
}

/** The runs' condition over RUNS_FROM. */
export function runCondition(g: AccessGrant, p: SqlParams, f: RunFilters): string {
  const where = [`r.company_id = ${p.add(g.companyId)}::uuid`];
  if (f.failed) where.push(`r.state in ('FAILED', 'PARTIAL')`);
  if (f.from) where.push(`r.started_at >= (${p.add(f.from)}::date)::timestamp at time zone c.business_timezone`);
  if (f.to) where.push(`r.started_at < (${p.add(f.to)}::date + 1)::timestamp at time zone c.business_timezone`);
  return where.join(' and ');
}

/** Newest first, at most 200; `total` counts every match. */
export async function listRuns(db: Queryable, g: AccessGrant, f: RunFilters) {
  const p = new SqlParams();
  const rows = (
    await db.query<Record<string, unknown> & { total: string }>(
      `select r.id, pr.code as "profileCode", r.state, r.failure_code as "failureCode", r.window_start as "windowStart", r.window_end as "windowEnd",
              r.started_at as "startedAt", r.finished_at as "finishedAt", r.accepted_count as accepted, r.rejected_count as rejected, r.quarantined_count as quarantined,
              count(*) over () as total
         ${RUNS_FROM} join biometric_profile pr on pr.company_id = r.company_id and pr.id = r.profile_id
        where ${runCondition(g, p, f)}
        order by r.started_at desc, r.id limit 200`,
      p.values,
    )
  ).rows;
  return { items: rows.map(({ total: _t, ...r }) => r), total: Number(rows[0]?.total ?? 0) };
}
