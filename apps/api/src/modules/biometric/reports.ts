// FR-093 and section 11.2 "Biometric sync and exception report": the runs (source observation count, unique, duplicate, accepted,
// quarantined and rejected outcomes, range, mapping revision and failure) and the observations they quarantined or rejected, under
// the same conditions as GET /biometric/runs and GET /biometric/exceptions. A run belongs to no employee, so these are for an
// unrestricted company-scope assignment with their own export right. No profile configuration, no credential reference and no
// checkpoint is a column, and neither is an observation's source evidence. Columns await the owner's samples (I-40 item 12).
// OPEN for the owner: section 11.2 also gives an attendance reviewer "permitted business results", undefined here, so nothing is built for them.
import { HttpError } from '../../http/errors.js';
import { SqlParams } from '../access/authorize.js';
import type { ReportDefinition, ReportFilters } from '../report/catalogue.js';
import { RUNS_FROM, runCondition } from './run-list.js';

const RUN_STATES = ['RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED'];
const EXCEPTION_OUTCOMES = ['REJECTED', 'QUARANTINED'];

const requireOneOf = (allowed: readonly string[], value: string | undefined) => {
  if (value !== undefined && !allowed.includes(value)) throw new HttpError(422, 'INVALID_FILTER', `The status is one of ${allowed.join(', ')}`, { field: 'status' });
};

const local = (column: string) => `to_char(${column} at time zone c.business_timezone, 'YYYY-MM-DD HH24:MI:SS')`;

export const BIOMETRIC_REPORTS: Record<string, ReportDefinition> = {
  BIOMETRIC_SYNC: {
    code: 'BIOMETRIC_SYNC',
    title: 'Biometric sync runs',
    resource: 'biometric',
    fieldGroup: 'operational',
    requiresPeriod: false,
    companyScopeOnly: true,
    statusFilter: true,
    recordFilters: ['profileId'],
    checkFilters: (f: ReportFilters) => requireOneOf(RUN_STATES, f.status),
    columns: [
      { key: 'profile', header: 'Profile' },
      { key: 'mapping_revision', header: 'Mapping revision' },
      { key: 'window_start', header: 'Range start (company time)' },
      { key: 'window_end', header: 'Range end (company time)' },
      { key: 'started_at', header: 'Started at (company time)' },
      { key: 'finished_at', header: 'Finished at (company time)' },
      { key: 'state', header: 'State' },
      { key: 'observations', header: 'Source observations' },
      { key: 'unique_count', header: 'Unique' },
      { key: 'duplicates', header: 'Duplicates' },
      { key: 'accepted', header: 'Accepted' },
      { key: 'quarantined', header: 'Quarantined' },
      { key: 'rejected', header: 'Rejected' },
      { key: 'failure_code', header: 'Failure' },
      { key: 'id', header: 'Run id' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const where = runCondition(grant, p, { from: f.from, to: f.to, profileId: f.profileId, state: f.status });
      return (
        await db.query(
          `select r.id, pr.code as profile, m.revision as mapping_revision, ${local('r.window_start')} as window_start, ${local('r.window_end')} as window_end,
                  ${local('r.started_at')} as started_at, ${local('r.finished_at')} as finished_at, r.state, r.source_observation_count as observations,
                  r.source_observation_count - r.duplicate_count as unique_count, r.duplicate_count as duplicates, r.accepted_count as accepted,
                  r.quarantined_count as quarantined, r.rejected_count as rejected, r.failure_code
             ${RUNS_FROM}
             join biometric_profile pr on pr.company_id = r.company_id and pr.id = r.profile_id
             join biometric_mapping_revision m on m.company_id = r.company_id and m.id = r.mapping_revision_id
            where ${where}
            order by r.started_at desc, r.id`,
          p.values,
        )
      ).rows;
    },
  },

  // Its list takes no period, so neither does its export: one run, one profile or one outcome narrows it.
  BIOMETRIC_SYNC_EXCEPTIONS: {
    code: 'BIOMETRIC_SYNC_EXCEPTIONS',
    title: 'Biometric sync exceptions',
    resource: 'biometric',
    fieldGroup: 'operational',
    requiresPeriod: false,
    companyScopeOnly: true,
    statusFilter: true,
    recordFilters: ['profileId', 'runId'],
    checkFilters(f) {
      if (f.from !== undefined || f.to !== undefined) throw new HttpError(422, 'FILTER_NOT_SUPPORTED', 'This report takes no period: narrow it by run, profile or outcome');
      requireOneOf(EXCEPTION_OUTCOMES, f.status);
    },
    columns: [
      { key: 'observed_at', header: 'Observed at (company time)' },
      { key: 'profile', header: 'Profile' },
      { key: 'run_id', header: 'Run id' },
      { key: 'observation_index', header: 'Observation' },
      { key: 'outcome', header: 'Outcome' },
      { key: 'failure_code', header: 'Failure' },
      { key: 'source_event_key', header: 'Source event key' },
      { key: 'id', header: 'Record id' },
    ],
    async rows(db, grant, f) {
      const p = new SqlParams();
      const where = [`o.company_id = ${p.add(grant.companyId)}::uuid`, `o.outcome in ('REJECTED', 'QUARANTINED')`];
      if (f.profileId) where.push(`r.profile_id = ${p.add(f.profileId)}::uuid`);
      if (f.runId) where.push(`o.run_id = ${p.add(f.runId)}::uuid`);
      if (f.status) where.push(`o.outcome = ${p.add(f.status)}`);
      return (
        await db.query(
          `select o.id, ${local('o.created_at')} as observed_at, pr.code as profile, o.run_id, o.observation_index, o.outcome, o.failure_code, o.source_event_key
             from biometric_run_observation o
             join biometric_sync_run r on r.company_id = o.company_id and r.id = o.run_id
             join biometric_profile pr on pr.company_id = r.company_id and pr.id = r.profile_id
             join company c on c.id = o.company_id
            where ${where.join(' and ')}
            order by o.created_at desc, o.id`,
          p.values,
        )
      ).rows;
    },
  },
};
