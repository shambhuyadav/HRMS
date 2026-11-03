// Payment instructions across claims (F2 Treasury Operator and Treasury Approver; FR-097; BR-045): the list behind the
// treasury widgets, with their filters and row scope (expense/metrics.ts counts by the same conditions). Who, state and
// date only: F2 keeps amounts and bank identifiers out of these roles' dashboards, and a claim's payments list has the rest.
import { type Paging, pageOf } from '../../db/paging.js';
import type { Queryable } from '../../db/queryable.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { independentOf, instructionsInScope, paidEventSince } from './metrics.js';

export interface PaymentListQuery extends Paging {
  state?: string | undefined;
  /** Only instructions the caller may release independently (C4; DF03). */
  releasableByMe?: boolean | undefined;
  /** Only instructions whose payment date is before this date. */
  paymentDateBefore?: string | undefined;
  /** Only instructions with an event of this kind recorded on or after `eventFrom` (company-local date). */
  eventKind?: 'CONFIRMED' | 'REVERSED' | undefined;
  eventFrom?: string | undefined;
}

export async function listPaymentInstructions(db: Queryable, grant: AccessGrant, q: PaymentListQuery) {
  const p = new SqlParams();
  const where = [instructionsInScope(grant, p)];
  if (q.state) where.push(`pi.state = ${p.add(q.state)}`);
  if (q.releasableByMe) where.push(independentOf(grant, p));
  if (q.paymentDateBefore) where.push(`pi.payment_date < ${p.add(q.paymentDateBefore)}::date`);
  if (q.eventKind) where.push(paidEventSince(p, q.eventKind, q.eventFrom ?? '1900-01-01'));
  return pageOf(
    db,
    `select pi.id, e.employee_code as "employeeCode", e.display_name as "employeeName", pi.state, to_char(pi.payment_date, 'YYYY-MM-DD') as "paymentDate", pi.created_at as "createdAt"
       from payment_instruction pi join employee e on e.company_id = pi.company_id and e.id = pi.employee_id
      where ${where.join(' and ')}`,
    p.values,
    '"paymentDate" desc, "employeeCode", id',
    q,
    200,
  );
}
