// F2 Auditor dashboard metrics ("Permitted redacted audit-event count; Operational exception counts; Review evidence
// tasks; Configuration revision count"), ready for the dashboard's metric catalogue. Every count uses the audit
// viewer's own query (auditEventQuery, GET /audit/events) for the current company-local month (DF17), so it
// reconciles with the viewer for the same from/to filters (BR-045). The viewer shows who did what and when, never the
// values, so the counts carry nothing confidential. Audit access is company-wide only: a filtered assignment gets a
// visible "not configured" state, never a partial count.
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import type { MetricResult } from '../dashboard/service.js';
import { countOf, monthStart, notAvailable } from '../dashboard/tasks.js';
import { type AuditQuery, auditEventQuery, isCompanyWide } from './service.js';

export { CONFIGURATION_RESOURCES } from './service.js';

const NOT_COMPANY_WIDE: MetricResult = { status: 'NOT_CONFIGURED', message: 'Audit counts need an unrestricted company-scope assignment' };

/** Audit events of this month visible in the viewer, optionally narrowed (the viewer's own predicate). */
async function monthCount(db: Queryable, g: AccessGrant, q: AuditQuery): Promise<MetricResult> {
  if (!isCompanyWide(g)) return NOT_COMPANY_WIDE;
  const p = new SqlParams();
  const { from } = auditEventQuery(g, { ...q, from: monthStart(g.businessDate), to: g.businessDate }, p);
  return countOf(db, `select count(*) as n ${from}`, p);
}

export const AUDIT_METRICS: Readonly<Record<string, (db: Queryable, grant: AccessGrant) => Promise<MetricResult>>> = {
  /** Every audit event of the month (the viewer redacts values; the count reveals none). */
  AUDIT_EVENTS_THIS_MONTH: (db, g) => monthCount(db, g, {}),
  /** Operational exceptions recorded in the audit trail: refused access attempts (ACCESS_DENIED) of the month. */
  AUDIT_ACCESS_DENIED_THIS_MONTH: (db, g) => monthCount(db, g, { action: 'ACCESS_DENIED' }),
  /** Audited configuration revision events of the month. */
  AUDIT_CONFIGURATION_REVISIONS_THIS_MONTH: (db, g) => monthCount(db, g, { resourceGroup: 'CONFIGURATION' }),
  /**
   * F2 "Review evidence tasks" stays unavailable, never zero (decided under owner delegation, 6 Nov 2026, docs/03 I-92). No
   * evidence-review process exists: no record says which evidence an auditor asked for, from whom, by when or whether it was given,
   * and the Auditor holds no task kind. Evidence itself (documents, receipts, payment outcome references) is confidential, and the
   * Auditor is an OTHER-class role that can never hold a confidential field grant (CI24), so the role could not open such a task.
   * Counting something else under this title (refusals, configuration revisions) would repeat the role's other three figures.
   */
  AUDIT_REVIEW_EVIDENCE_TASKS: notAvailable,
};
