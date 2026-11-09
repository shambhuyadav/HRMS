// Arrears and late-timesheet adjustments paid by a final settlement (FR-035, FR-052, FR-100; I-79; migration 0214). Decided under owner
// delegation, 6 Nov 2026 (docs/03 I-88 follow-up): a case the settlement's calculation took stays APPROVED while the settlement is in
// progress (no payroll takes it: payroll/calculate.ts SETTLEMENT_TAKES); when the settlement is recorded as paid, each such case becomes
// APPLIED naming it, with its transaction, once. A settlement cancelled, returned or rejected before payment never reaches here, so its
// cases stay free for a later payroll.
import type { Queryable } from '../../db/queryable.js';

/** The cases the paid settlement `settlementId` carried, marked APPLIED by it (called inside the payment's transaction). */
export async function applyCasesPaidBySettlement(tx: Queryable, companyId: string, settlementId: string, userId: string): Promise<{ arrears: number; adjustments: number }> {
  const taken = (column: 'arrears_case_id' | 'adjustment_id') =>
    `select i.${column} as case_id from settlement s
       join settlement_calculation_item i on i.company_id = s.company_id and i.calculation_id = s.calculation_id and i.status = 'CALCULATED'
      where s.company_id = $1 and s.id = $2 and s.state = 'PAID' and i.${column} is not null`;
  // Transactions first, then the cases (the deferred mirror compares the two at commit).
  await tx.query(
    `update business_transaction bt set state = 'APPLIED', updated_by = $3
       from payroll_arrears_case c where c.company_id = $1 and c.id in (${taken('arrears_case_id')}) and c.state = 'APPROVED' and bt.company_id = c.company_id and bt.id = c.transaction_id`,
    [companyId, settlementId, userId],
  );
  const arrears =
    (
      await tx.query(`update payroll_arrears_case set state = 'APPLIED', applied_settlement_id = $2, updated_by = $3 where company_id = $1 and state = 'APPROVED' and id in (${taken('arrears_case_id')})`, [
        companyId,
        settlementId,
        userId,
      ])
    ).rowCount ?? 0;
  await tx.query(
    `update business_transaction bt set state = 'APPLIED', updated_by = $3
       from payroll_adjustment a where a.company_id = $1 and a.id in (${taken('adjustment_id')}) and a.state = 'APPROVED' and bt.company_id = a.company_id and bt.id = a.transaction_id`,
    [companyId, settlementId, userId],
  );
  const adjustments =
    (
      await tx.query(`update payroll_adjustment set state = 'APPLIED', applied_settlement_id = $2, updated_by = $3 where company_id = $1 and state = 'APPROVED' and id in (${taken('adjustment_id')})`, [
        companyId,
        settlementId,
        userId,
      ])
    ).rowCount ?? 0;
  return { arrears, adjustments };
}
