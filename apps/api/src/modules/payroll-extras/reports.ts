// The batch's catalogue reports (FR-056 request -> worker -> download; BR-026; ZT17), spread into report/catalogue.ts ALL_REPORTS and
// listed only while the payroll-extras module is active: medical claims (CL-113), liability provisions as on a date (CL-098) and the
// salary journal voucher of a run (CL-097). Each holds exactly the rows of its JSON screen (routes.ts), under the export grant.
import { HttpError } from '../../http/errors.js';
import { payrollRunRevision } from '../payroll-outputs/reports.js';
import type { ReportDefinition, ReportFilters } from '../report/catalogue.js';
import { MODULE_KEY } from './common.js';
import { salaryJv, salaryJvRows } from './jv.js';
import { checkAsOf, provisionReportRows, provisionSalaryGrant } from './liabilities.js';
import { MEDICAL_COLUMNS, MEDICAL_MAX_DAYS, medicalClaimRows } from './medical.js';

const MONEY = { numeric: true } as const;

/** The as-on date is the `to` filter; a `from` is refused rather than ignored (BR-026). */
function asOnDate(f: ReportFilters): void {
  if (f.from !== undefined) throw new HttpError(422, 'FILTER_NOT_SUPPORTED', 'This report stands as on one date: give it as `to` without `from`');
  checkAsOf(f.to);
}

function runOnly(f: ReportFilters): void {
  if (!f.runId) throw new HttpError(422, 'RUN_REQUIRED', 'This report is of one payroll run (runId)');
  if (f.from !== undefined || f.to !== undefined) throw new HttpError(422, 'FILTER_NOT_SUPPORTED', 'This report takes the payroll run, not a period');
}

export const PAYROLL_EXTRAS_REPORTS: Record<string, ReportDefinition> = {
  // CL-113: medical reimbursement claim lines by bill date, under the expense export grant and the expense outputs' claim rule.
  MEDICAL_CLAIMS: {
    code: 'MEDICAL_CLAIMS',
    title: 'Medical claims',
    resource: 'expense',
    fieldGroup: 'operational',
    requiresPeriod: true,
    maxPeriodDays: MEDICAL_MAX_DAYS,
    module: MODULE_KEY,
    employeeFilters: ['search', 'departmentId'],
    xlsx: true,
    columns: MEDICAL_COLUMNS,
    rows: (db, grant, f) => medicalClaimRows(db, grant, { from: f.from!, to: f.to!, search: f.search, departmentId: f.departmentId }),
  },

  // CL-098: one row per employee and item calculated, and one row naming each item that is not (NOT_CONFIGURED with its reason). Worked
  // from salaries: salary.read.salary too, and salary.history_read.salary for an earlier date (C4), as the screen needs them; re-checked
  // at generation (provisionRows) and at download (sourceGrants, historyGrant). An as-on date after today is refused.
  LIABILITY_PROVISIONS: {
    code: 'LIABILITY_PROVISIONS',
    title: 'Liability provisions',
    resource: 'payroll_report',
    fieldGroup: 'amount',
    requiresPeriod: false,
    module: MODULE_KEY,
    employeeFilters: ['departmentId'],
    xlsx: true,
    checkFilters: asOnDate,
    sourceGrants: [{ resource: 'salary', action: 'read', fieldGroup: 'salary' }],
    historyGrant: { resource: 'salary', fieldGroup: 'salary', when: (f, today) => (f.to ?? today) < today },
    async checkRequest(db, grant, f) {
      await provisionSalaryGrant(db, grant, checkAsOf(f.to, grant.businessDate));
    },
    columns: [
      { key: 'item', header: 'Item' },
      { key: 'status', header: 'Status' },
      { key: 'employee_code', header: 'Employee code' },
      { key: 'employee_name', header: 'Employee name' },
      { key: 'department_code', header: 'Department code' },
      { key: 'department', header: 'Department' },
      { key: 'amount', header: 'Amount', ...MONEY },
      { key: 'currency', header: 'Currency' },
      { key: 'vested', header: 'Vested' },
      { key: 'basis', header: 'Basis' },
    ],
    rows: (db, grant, f) => provisionReportRows(db, grant, { asOf: f.to!, departmentId: f.departmentId }),
  },

  // CL-097: the voucher lines of one approved or processed run; refused (409 NOT_CONFIGURED) until every head of the run is mapped.
  SALARY_JV: {
    code: 'SALARY_JV',
    title: 'Salary journal voucher',
    resource: 'payroll_report',
    fieldGroup: 'amount',
    requiresPeriod: false,
    module: MODULE_KEY,
    recordFilters: ['runId'],
    xlsx: true,
    checkFilters: runOnly,
    async checkRequest(db, grant, f) {
      const jv = await salaryJv(db, grant, f.runId!);
      if (jv.status !== 'READY') throw new HttpError(409, 'NOT_CONFIGURED', 'The salary JV needs a GL mapping in force with an account for every pay head of the run', { reason: jv.reason, missing: jv.missing });
    },
    sourceRevision: (db, grant, f) => payrollRunRevision(db, grant.companyId, f.runId!),
    columns: [
      { key: 'voucher_date', header: 'Voucher date' },
      { key: 'period_code', header: 'Period' },
      { key: 'account_code', header: 'Account code' },
      { key: 'account_name', header: 'Account name' },
      { key: 'cost_centre', header: 'Cost centre' },
      { key: 'pay_head', header: 'Pay head' },
      { key: 'narration', header: 'Narration' },
      { key: 'debit', header: 'Debit', ...MONEY },
      { key: 'credit', header: 'Credit', ...MONEY },
      { key: 'currency', header: 'Currency' },
    ],
    rows: (db, grant, f) => salaryJvRows(db, grant, f.runId!),
  },
};
