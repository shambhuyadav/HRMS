// Biometric sync failure notice (FR-084, FR-088; DF09; DF13). The profile's code, the run's state and its failure class
// only: configuration and credential references, provider detail, device identities and punches never travel in
// notifications. A describer never throws on a bad payload and returns null when the event should produce nothing.
import type { EventDescriber } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const syncFailed: EventDescriber = async (tx, ev) => {
  const runId = typeof ev.payload.runId === 'string' && UUID.test(ev.payload.runId) ? ev.payload.runId : null;
  if (!runId) return null;
  const run = (
    await tx.query<{ state: string; failure_code: string | null; profile_code: string }>(
      `select r.state, r.failure_code, p.code as profile_code
         from biometric_sync_run r join biometric_profile p on p.company_id = r.company_id and p.id = r.profile_id
        where r.company_id = $1 and r.id = $2`,
      [ev.companyId, runId],
    )
  ).rows[0];
  if (!run || !run.failure_code) return null;
  return {
    eventType: 'BIOMETRIC_SYNC_FAILED',
    subjectEmployeeId: null,
    transactionId: null,
    transactionRevision: null,
    taskId: null,
    beneficiaryUserId: null,
    data: { profileCode: run.profile_code, runState: run.state, failureCode: run.failure_code },
  };
};

export const BIOMETRIC_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'biometric.sync_failed': syncFailed,
};
