// Check medical claims (BRD coverage CL-113, under FR-079 expense outputs and FR-038 reimbursement). Built 11 Nov 2026 from the
// reference system's "Check Medical Claims" screen (from date, to date, search); decided under owner delegation, 6 Nov 2026.
//
// Medical reimbursement claims are expense claims: their lines in a medical expense category, a category whose code is MEDICAL or begins
// with MEDICAL_ (for example MEDICAL_OPD). No such category is seeded (DF06 seeds TRAVEL, ACCOMMODATION, MEALS, OFFICE_SUPPLIES and
// OTHER); HR creates one under the expense policies, and until then the list is empty. One row per medical line of a submitted claim
// (its current revision), whose expense (bill) date falls in the period, with the claim's state and payment state and the line's claimed
// and finally allowed amounts. Rows follow the expense outputs' rule (expense/reports.ts claimsInScope): the claimant in the caller's
// row scope, and the claim readable to them (payment read duty or a task on it, DF02). Never the description, the reason or the receipt.
import type { Queryable } from '../../db/queryable.js';
import { HttpError } from '../../http/errors.js';
import { type AccessGrant, SqlParams } from '../access/authorize.js';
import { claimsInScope } from '../expense/reports.js';
import { isIsoDate } from './common.js';

/** A technical bound on one request's period (inclusive days), not a business rule. */
export const MEDICAL_MAX_DAYS = 366;

export interface MedicalFilters {
  from: string;
  to: string;
  search?: string | undefined;
  departmentId?: string | undefined;
}

export function checkMedicalPeriod(f: { from?: string | undefined; to?: string | undefined }): void {
  if (!f.from || !f.to || !isIsoDate(f.from) || !isIsoDate(f.to)) throw new HttpError(422, 'PERIOD_REQUIRED', 'Give the period as from and to dates (YYYY-MM-DD)');
  if (f.to < f.from) throw new HttpError(422, 'INVALID_PERIOD', 'The period end is before its start');
  if ((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000 + 1 > MEDICAL_MAX_DAYS) throw new HttpError(422, 'PERIOD_TOO_LONG', `At most ${MEDICAL_MAX_DAYS} days per request`);
}

export const MEDICAL_COLUMNS = [
  { key: 'employee_code', header: 'Employee code' },
  { key: 'employee_name', header: 'Employee name' },
  { key: 'department', header: 'Department' },
  { key: 'claim_id', header: 'Claim' },
  { key: 'claim_state', header: 'Claim state' },
  { key: 'payment_state', header: 'Payment state' },
  { key: 'submitted_on', header: 'Submitted on' },
  { key: 'line', header: 'Line' },
  { key: 'expense_date', header: 'Bill date' },
  { key: 'category', header: 'Category' },
  { key: 'merchant', header: 'Merchant' },
  { key: 'invoice_reference', header: 'Invoice reference' },
  { key: 'claimed_amount', header: 'Claimed amount', numeric: true },
  { key: 'approved_amount', header: 'Approved amount', numeric: true },
  { key: 'currency', header: 'Currency' },
];

export async function medicalClaimRows(db: Queryable, grant: AccessGrant, f: MedicalFilters): Promise<Record<string, unknown>[]> {
  checkMedicalPeriod(f);
  const p = new SqlParams();
  const scope = await claimsInScope(db, grant, p);
  const conditions: string[] = [];
  if (f.search?.trim()) {
    const pattern = p.add(`%${f.search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    conditions.push(`(e.employee_code ilike ${pattern} or e.display_name ilike ${pattern} or l.merchant ilike ${pattern})`);
  }
  if (f.departmentId) conditions.push(`ea.department_id = ${p.add(f.departmentId)}::uuid`);
  return (
    await db.query(
      `select e.employee_code, e.display_name as employee_name, coalesce(d.name, '') as department, c.id as claim_id, c.state as claim_state, c.payment_state,
              to_char(hrms_business_date(c.company_id, r.submitted_at), 'YYYY-MM-DD') as submitted_on, l.sequence as line,
              to_char(l.expense_date, 'YYYY-MM-DD') as expense_date, cat.code as category, l.merchant, coalesce(l.invoice_reference, '') as invoice_reference,
              l.claimed_amount::numeric(19,2)::text as claimed_amount,
              coalesce((select dd.allowed_amount from expense_line_decision dd where dd.company_id = l.company_id and dd.line_id = l.id order by dd.created_at desc limit 1)::numeric(19,2)::text, '') as approved_amount,
              c.currency_code as currency
         from expense_claim c
         join employee e on e.company_id = c.company_id and e.id = c.employee_id
         join expense_revision r on r.company_id = c.company_id and r.claim_id = c.id and r.revision = c.current_revision
         join expense_line l on l.company_id = r.company_id and l.revision_id = r.id
         join expense_category cat on cat.company_id = l.company_id and cat.id = l.category_id
         left join lateral (select a.department_id from employment_assignment a
                             where a.company_id = e.company_id and a.employee_id = e.id and a.effective_from <= l.expense_date
                             order by a.effective_from desc limit 1) ea on true
         left join department d on d.company_id = e.company_id and d.id = ea.department_id
        where ${scope} and r.submitted_at is not null
          and (cat.code = 'MEDICAL' or cat.code like 'MEDICAL\\_%')
          and l.expense_date between ${p.add(f.from)}::date and ${p.add(f.to)}::date
          ${conditions.map((c) => `and ${c}`).join(' ')}
        order by l.expense_date, e.employee_code, c.id, l.sequence`,
      p.values,
    )
  ).rows;
}
