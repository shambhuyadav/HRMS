// Bank instruction check (H2 hold criteria; DB037 bank_revision_id; FR-101 "bank-validation failure prevents payment
// instruction"). The employee's approved BANK revision is the latest DB116 revision of the category (revisions are
// appended only once effective). It is opened with the same envelope binding the sensitive-change module seals it
// with; the clear values stay in memory for the check and are never stored, logged or returned.
//   MISSING     no approved bank revision
//   INVALID     the envelope cannot be opened, or a required field (holder, account identifier, country) is absent or
//               malformed under the generic rules of I-18 (no bank-specific checksum is assumed)
//   UNVERIFIED  a valid revision that neither came from an independently approved, evidence-verified change request
//               nor was verified by an eligible Admin releasing a payment safety block against it (H2), e.g. an
//               audited initial migration (DB116 "source request optional only for authorized audited initial migration")
//   VERIFIED    usable: its id is the bank reference frozen with the payroll record
import type { Queryable } from '../../db/queryable.js';
import { openJson } from '../../security/field-crypto.js';

export type BankStatus = 'VERIFIED' | 'MISSING' | 'INVALID' | 'UNVERIFIED';

export interface BankCheck {
  status: BankStatus;
  /** The current revision when its values are valid (VERIFIED or UNVERIFIED); null otherwise. */
  revisionId: string | null;
  /** How a VERIFIED revision was verified. */
  verification: 'WORKFLOW_VERIFIED' | 'ADMIN_VERIFIED' | null;
}

const revisionBinding = (companyId: string, employeeId: string, id: string) => ({ purpose: 'private_profile.revision', companyId, ownerId: employeeId, recordId: id });

export async function bankChecks(db: Queryable, companyId: string, employeeIds: readonly string[]): Promise<Map<string, BankCheck>> {
  const out = new Map<string, BankCheck>();
  if (employeeIds.length === 0) return out;
  const rows = (
    await db.query<{ employee_id: string; id: string; payload: string; source_request_id: string | null; admin_verified: boolean }>(
      `select distinct on (r.employee_id) r.employee_id, r.id, r.payload, r.source_request_id,
              exists (select 1 from payroll_hold h where h.company_id = r.company_id and h.release_bank_revision_id = r.id and h.state = 'RELEASED') as admin_verified
         from employee_private_profile_revision r
        where r.company_id = $1 and r.category = 'BANK' and r.employee_id = any($2::uuid[])
        order by r.employee_id, r.revision desc`,
      [companyId, employeeIds],
    )
  ).rows;
  const latest = new Map(rows.map((r) => [r.employee_id, r]));
  for (const employeeId of employeeIds) {
    const r = latest.get(employeeId);
    if (!r) {
      out.set(employeeId, { status: 'MISSING', revisionId: null, verification: null });
      continue;
    }
    let values: Record<string, unknown>;
    try {
      values = openJson<Record<string, unknown>>(r.payload, revisionBinding(companyId, employeeId, r.id));
    } catch {
      out.set(employeeId, { status: 'INVALID', revisionId: null, verification: null });
      continue;
    }
    const holder = values.holderName;
    const account = values.accountIdentifier;
    const country = values.countryCode;
    const valid =
      typeof holder === 'string' && holder.trim() !== '' && typeof account === 'string' && /^[A-Z0-9]{4,34}$/.test(account) && typeof country === 'string' && /^[A-Z]{2}$/.test(country);
    if (!valid) out.set(employeeId, { status: 'INVALID', revisionId: null, verification: null });
    else if (r.source_request_id) out.set(employeeId, { status: 'VERIFIED', revisionId: r.id, verification: 'WORKFLOW_VERIFIED' });
    else if (r.admin_verified) out.set(employeeId, { status: 'VERIFIED', revisionId: r.id, verification: 'ADMIN_VERIFIED' });
    else out.set(employeeId, { status: 'UNVERIFIED', revisionId: r.id, verification: null });
  }
  return out;
}

/**
 * The users who approved the bank-change request a revision came from (they do not also release payment against it), with the
 * delegator of an approval a delegate took in their name (I-57 item 7).
 */
export async function bankRevisionApprovers(db: Queryable, companyId: string, revisionId: string): Promise<string[]> {
  return (
    await db.query<{ u: string }>(
      `select distinct u
         from employee_private_profile_revision r
         join employee_sensitive_change_request q on q.company_id = r.company_id and q.id = r.source_request_id
         join approval_instance i on i.company_id = q.company_id and i.transaction_id = q.transaction_id
         join approval_task t on t.company_id = i.company_id and t.instance_id = i.id
         join approval_decision d on d.company_id = t.company_id and d.task_id = t.id and d.decision = 'APPROVE'
         left join delegation dl on dl.company_id = t.company_id and dl.id = t.delegation_id
         cross join lateral (values (d.actor_user_id), (dl.delegator_user_id)) as who (u)
        where r.company_id = $1 and r.id = $2 and u is not null`,
      [companyId, revisionId],
    )
  ).rows.map((r) => r.u);
}
