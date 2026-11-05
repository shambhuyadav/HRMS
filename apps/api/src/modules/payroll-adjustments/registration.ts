// Later-period payroll cases (FR-035 arrears; FR-100 late or amended timesheets; DB111; H2; H7; DF02). Migrations
// 0129_payroll_adjustment and 0130_payroll_arrears_case. Every duty shows payroll amounts, so each is a ceiling-only grant of
// the HR Administrator role, approved per assignment (DF02; I-28). Nothing here feeds a run or changes a processed one.
import type { ModuleRegistration } from '../registry-types.js';

export const payrollAdjustmentsRegistration: ModuleRegistration = {
  key: 'payroll-adjustments',
  active: true,
  // Processes about an employee, never the employee's own request.
  transactionKinds: { timesheet_adjustment: null, payroll_arrears_case: null },
  roleGrants: {
    HR_ADMINISTRATOR: {
      ceiling: [
        'payroll_adjustment.read.amount',
        'payroll_adjustment.propose.amount',
        'payroll_adjustment.decide.amount',
        'payroll_arrears.read.amount',
        'payroll_arrears.propose.amount',
        'payroll_arrears.decide.amount',
      ],
    },
  },
  // H2 "independent payroll reviewer"; DF03 explicit lists.
  workflows: [
    { kind: 'timesheet_adjustment', steps: [{ sequence: 1, permission: 'payroll_adjustment.decide.amount', selectionRule: 'HR_FALLBACK_LIST' }] },
    { kind: 'payroll_arrears_case', steps: [{ sequence: 1, permission: 'payroll_arrears.decide.amount', selectionRule: 'HR_FALLBACK_LIST' }] },
  ],
  // H7 "adjustment approval/application": the kind of case, identity, period and outcome; never amounts or reasons.
  notifications: [
    {
      code: 'PAYROLL_CASE_ASSIGNED',
      eventType: 'PAYROLL_CASE_ASSIGNED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'A payroll {{caseKind}} is waiting for your decision',
      body: 'A {{caseKind}} about {{employeeName}} ({{employeeCode}}) for {{periodCode}} is waiting for your decision.',
      placeholders: ['caseKind', 'employeeName', 'employeeCode', 'periodCode'],
    },
    {
      code: 'PAYROLL_CASE_DECIDED',
      eventType: 'PAYROLL_CASE_DECIDED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Your payroll {{caseKind}} was {{outcome}}',
      body: 'The {{caseKind}} you raised about {{employeeCode}} for {{periodCode}} was {{outcome}}.',
      placeholders: ['caseKind', 'employeeCode', 'periodCode', 'outcome'],
    },
  ],
};
