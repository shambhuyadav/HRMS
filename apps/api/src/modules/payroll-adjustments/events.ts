// Notices of adjustment and arrears cases (H7; DF12): the kind of case, the employee's identity, the period and the outcome only;
// never units, amounts, explanations or reasons.
import type { Queryable } from '../../db/queryable.js';
import type { EventDescriber } from '../events-registry.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OUTCOMES: Record<string, string> = { APPROVED: 'approved', RETURNED: 'returned', REJECTED: 'rejected' };

const uuidOf = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value : null);

type Facts = { employee_id: string; transaction_id: string; revision: number; created_by: string | null; period_code: string; code: string; name: string };

const facts = async (tx: Queryable, companyId: string, table: 'payroll_adjustment' | 'payroll_arrears_case', id: string): Promise<Facts | undefined> =>
  (
    await tx.query<Facts>(
      `select c.employee_id, c.transaction_id, bt.revision, c.created_by, p.period_code, e.employee_code as code, e.display_name as name
         from ${table} c
         join business_transaction bt on bt.company_id = c.company_id and bt.id = c.transaction_id
         join payroll_run ru on ru.company_id = c.company_id and ru.id = c.origin_run_id
         join payroll_period p on p.company_id = ru.company_id and p.id = ru.period_id
         join employee e on e.company_id = c.company_id and e.id = c.employee_id
        where c.company_id = $1 and c.id = $2`,
      [companyId, id],
    )
  ).rows[0];

const assigned =
  (table: 'payroll_adjustment' | 'payroll_arrears_case', idKey: string, caseKind: string): EventDescriber =>
  async (tx, ev) => {
    const id = uuidOf(ev.payload[idKey]);
    if (!id) return null;
    const f = await facts(tx, ev.companyId, table, id);
    if (!f) return null;
    return {
      eventType: 'PAYROLL_CASE_ASSIGNED',
      subjectEmployeeId: f.employee_id,
      transactionId: f.transaction_id,
      transactionRevision: f.revision,
      taskId: uuidOf(ev.payload.taskId),
      beneficiaryUserId: null,
      data: { caseKind, employeeName: f.name, employeeCode: f.code, periodCode: f.period_code },
    };
  };

const decided =
  (table: 'payroll_adjustment' | 'payroll_arrears_case', idKey: string, caseKind: string): EventDescriber =>
  async (tx, ev) => {
    const id = uuidOf(ev.payload[idKey]);
    const outcome = typeof ev.payload.outcome === 'string' ? OUTCOMES[ev.payload.outcome] : undefined;
    if (!id || !outcome) return null;
    const f = await facts(tx, ev.companyId, table, id);
    if (!f) return null;
    return {
      eventType: 'PAYROLL_CASE_DECIDED',
      subjectEmployeeId: f.employee_id,
      transactionId: f.transaction_id,
      transactionRevision: f.revision,
      taskId: null,
      beneficiaryUserId: f.created_by,
      data: { caseKind, employeeCode: f.code, periodCode: f.period_code, outcome },
    };
  };

export const PAYROLL_ADJUSTMENT_EVENTS: Readonly<Record<string, EventDescriber>> = {
  'payroll_adjustment.assigned': assigned('payroll_adjustment', 'adjustmentId', 'late-timesheet adjustment'),
  'payroll_adjustment.decided': decided('payroll_adjustment', 'adjustmentId', 'late-timesheet adjustment'),
  'payroll_arrears.assigned': assigned('payroll_arrears_case', 'caseId', 'arrears case'),
  'payroll_arrears.decided': decided('payroll_arrears_case', 'caseId', 'arrears case'),
};
