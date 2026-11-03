// Notification events of custody requests (DF12). The category label, the employee's identity and the outcome only:
// the employee's reason, the item description and the reviewer's note never travel in notifications.
import type { EventDescriber } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (v: unknown): string | null => (typeof v === 'string' && UUID.test(v) ? v : null);
const OUTCOME_LABELS: Record<string, string> = { APPROVED: 'approved', REJECTED: 'rejected' };

const describe =
  (eventType: string): EventDescriber =>
  async (tx, ev) => {
    const requestId = id(ev.payload.requestId);
    if (!requestId) return null;
    const r = (
      await tx.query<{ employee_id: string; transaction_id: string; revision: number; category: string; code: string; name: string }>(
        `select r.employee_id, r.transaction_id, bt.revision, c.label as category, e.employee_code as code, e.display_name as name
           from asset_request r
           join business_transaction bt on bt.company_id = r.company_id and bt.id = r.transaction_id
           join reference_value c on c.company_id = r.company_id and c.id = r.category_id
           join employee e on e.company_id = r.company_id and e.id = r.employee_id
          where r.company_id = $1 and r.id = $2`,
        [ev.companyId, requestId],
      )
    ).rows[0];
    if (!r) return null;
    const outcome = typeof ev.payload.outcome === 'string' ? OUTCOME_LABELS[ev.payload.outcome] : undefined;
    return {
      eventType,
      subjectEmployeeId: r.employee_id,
      transactionId: r.transaction_id,
      transactionRevision: r.revision,
      taskId: id(ev.payload.taskId),
      beneficiaryUserId: null,
      data: { category: r.category, employeeName: r.name, employeeCode: r.code, outcome: outcome ?? '' },
    };
  };

export const ASSETS_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'asset_request.submitted': describe('ASSET_REQUEST_SUBMITTED'),
  'asset_request.decided': describe('ASSET_REQUEST_DECIDED'),
};
