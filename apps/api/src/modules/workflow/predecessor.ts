// DF03 "Rejected requests are terminal; a new request links to the rejected predecessor" (FR-026; FR-027; FR-059; FR-074; 0125). The
// link is optional and is named when the request is created, by the module's own id for the request; it is kept on
// business_transaction, whose guard holds it for every kind. Self-service only: the caller's own rejected request, so anyone
// else's reads as not found.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';

export type PredecessorRoot = 'leave_request' | 'expense_claim' | 'outdoor_duty_request' | 'holiday_work_request' | 'profile_change_request' | 'attendance_correction_request' | 'asset_request' | 'requisition';

/** Whose request a root row is: a requisition is raised by its requester and owned by that employee's transaction (hiring/requisition.ts). */
const ownerColumn = (root: PredecessorRoot) => (root === 'requisition' ? 'requesting_employee_id' : 'employee_id');

/**
 * The transaction a new request follows, or null when none is named. Locks the predecessor's transaction, so two requests
 * following it at the same moment are ordered and the second sees the first (the database's unique index stands behind this).
 */
export async function rejectedPredecessor(tx: Queryable, companyId: string, root: PredecessorRoot, employeeId: string, requestId: string | undefined): Promise<string | null> {
  if (requestId === undefined) return null;
  const predecessor = (
    await tx.query<{ transaction_id: string; state: string }>(
      `select bt.id as transaction_id, bt.state
         from ${root} r join business_transaction bt on bt.company_id = r.company_id and bt.id = r.transaction_id
        where r.company_id = $1 and r.id = $2 and r.${ownerColumn(root)} = $3 for update of bt`,
      [companyId, requestId, employeeId],
    )
  ).rows[0];
  if (!predecessor) throw new HttpError(422, 'PREDECESSOR_NOT_FOUND', 'The earlier request was not found among your own requests of this kind');
  if (predecessor.state !== 'REJECTED') throw new HttpError(422, 'PREDECESSOR_NOT_REJECTED', 'A new request follows only a rejected request; a returned request is corrected and resubmitted');
  const live = await tx.query(
    `select 1 from business_transaction where company_id = $1 and predecessor_transaction_id = $2 and state not in ('REJECTED', 'WITHDRAWN', 'CANCELLED')`,
    [companyId, predecessor.transaction_id],
  );
  if (live.rowCount) throw new HttpError(409, 'PREDECESSOR_ALREADY_FOLLOWED', 'A later request already follows this rejected request');
  return predecessor.transaction_id;
}

/** SQL: the module's id of the rejected request this one follows, or null. `alias` is the root row (company_id, transaction_id). */
export const predecessorRequestSql = (root: PredecessorRoot, alias: string): string =>
  `(select pr.id from business_transaction pbt join ${root} pr on pr.company_id = pbt.company_id and pr.transaction_id = pbt.predecessor_transaction_id
     where pbt.company_id = ${alias}.company_id and pbt.id = ${alias}.transaction_id)`;
