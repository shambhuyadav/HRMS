// DF12 "document expiry" for company policy versions (FR-010; DF02; migration 0054 company_policy_version.expires_on),
// exactly as employee document expiry (notification/reminders.ts runDocumentExpiry): for a company business date, one
// POLICY_EXPIRING event per policy version whose expiry date is `leadDays` after `day` (by default the expiry date
// itself; the BRD sets no lead time). Only a policy's current version counts: the latest one the malware scan released
// (CLEAN), as GET /company-policies shows it (policies.ts). A version still waiting for the scan or quarantined is never
// served (FR-106), and one superseded by a later released version is no longer the policy in force, so neither raises a
// notice. The event is keyed by version, expiry date and lead, so reruns raise nothing new; a notice whose day the job
// missed is still raised once within the same catch-up window. Recipients are the users who can currently manage that policy at its classification (POLICY_MANAGERS, rechecked at delivery; notification/dispatcher.ts),
// so a confidential policy's code and title reach holders of the confidential group only. The notice names the policy,
// the version and the date; never the file name or content. Runs daily with the other reminders (jobs-registry.ts)
// while the documents module is active; the run's counts are recorded with the scheduled run (worker/scheduler.ts).
import { type Database, withTransaction } from '../../db/transaction.js';
import { fanOut } from '../notification/dispatcher.js';
import { DOCUMENT_EXPIRY_CATCH_UP_DAYS, DOCUMENT_EXPIRY_LEAD_DAYS } from '../notification/reminders.js';

export async function runPolicyExpiry(db: Database, companyId: string, day: string, leadDays: number = DOCUMENT_EXPIRY_LEAD_DAYS) {
  if (!Number.isInteger(leadDays) || leadDays < 0) throw new Error('leadDays must be a non-negative whole number of days');
  return withTransaction(db, async (tx) => {
    const due = (
      await tx.query<{ id: string; version_number: number; policy_code: string; title: string; expires_on: string }>(
        `select v.id, v.version_number, p.policy_code, p.title, to_char(v.expires_on, 'YYYY-MM-DD') as expires_on
           from company_policy_version v join company_policy p on p.company_id = v.company_id and p.id = v.policy_id
           join attachment a on a.company_id = v.company_id and a.id = v.attachment_id and a.scan_state = 'CLEAN'
          where v.company_id = $1 and v.expires_on between $2::date + $3::int - $4::int and $2::date + $3::int
            and not exists (select 1 from company_policy_version n join attachment na on na.company_id = n.company_id and na.id = n.attachment_id
                             where n.company_id = v.company_id and n.policy_id = v.policy_id and n.version_number > v.version_number and na.scan_state = 'CLEAN')
          order by v.id`,
        [companyId, day, leadDays, DOCUMENT_EXPIRY_CATCH_UP_DAYS],
      )
    ).rows;
    let events = 0;
    let notifications = 0;
    for (const v of due) {
      const result = await fanOut(tx, companyId, `POLICY_EXPIRING:${v.id}:${v.expires_on}:${leadDays}`, day, {
        eventType: 'POLICY_EXPIRING',
        subjectEmployeeId: null,
        transactionId: null,
        transactionRevision: null,
        taskId: null,
        beneficiaryUserId: null,
        policyVersionId: v.id,
        data: { versionNumber: String(v.version_number), policyCode: v.policy_code, policyTitle: v.title, expiresOn: v.expires_on },
      });
      if (result.recorded) events++;
      notifications += result.created;
    }
    return { day, events, notifications };
  });
}
