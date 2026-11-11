// Payroll inputs and reports, batch R3 (BRD coverage CL-074, CL-081, CL-084, CL-085, CL-097, CL-098, CL-100, CL-113, CL-119; FR-028 to
// FR-039; migration 0270_payroll_extras). Data only.
//
// DF02: the challan master, TDS challans and the GL mapping are company configuration (operational): the Payroll Operator reads them by
// default and may be granted their maintenance; the Payroll Approver and Finance Reviewer read them. The amounts of TDS challans are
// company payroll figures, not configuration: the challan read duty alone lists the challans with their amounts null (routes.ts), and
// only an assignment also holding payroll_report.read.amount company-wide sees them. Perquisites and past salary are an
// employee's amounts, and the EDOC archive holds whole payslips, so their groups are confidential: ceiling-only grants of the HR
// Administrator, approved per assignment, never a default duty. The salary JV and the liability provisions are payroll reports and use
// the existing report grants (payroll_report.read.amount / payroll_report.export.amount); the liability provisions are worked from
// salaries, so they need salary.read.salary as well (and salary.history_read.salary for an earlier date); the medical claims list uses the expense
// grants (expense.read.operational / expense.export.operational).
import type { ModuleRegistration } from '../registry-types.js';

export const payrollExtrasRegistration: ModuleRegistration = {
  key: 'payroll-extras',
  active: true,
  transactionKinds: {},
  roleGrants: {
    HR_ADMINISTRATOR: {
      ceiling: [
        'payroll_challan.read.operational',
        'payroll_challan.manage.operational',
        'payroll_gl_mapping.read.operational',
        'payroll_gl_mapping.manage.operational',
        'payroll_tax_input.read.amount',
        'payroll_tax_input.import.amount',
        'payroll_output.export.amount',
      ],
    },
    PAYROLL_OPERATOR: {
      defaultDuties: ['payroll_challan.read.operational', 'payroll_gl_mapping.read.operational'],
      ceiling: ['payroll_challan.manage.operational', 'payroll_gl_mapping.manage.operational'],
    },
    PAYROLL_APPROVER: { defaultDuties: ['payroll_challan.read.operational', 'payroll_gl_mapping.read.operational'] },
    FINANCE_REVIEWER: { defaultDuties: ['payroll_challan.read.operational', 'payroll_gl_mapping.read.operational'] },
  },
  operationalFieldGroups: [
    { resource: 'payroll_challan', fieldGroup: 'operational' },
    { resource: 'payroll_gl_mapping', fieldGroup: 'operational' },
  ],
};
