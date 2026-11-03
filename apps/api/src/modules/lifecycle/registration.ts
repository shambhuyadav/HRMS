// Employee processes, letters and exit (FR-015 to FR-018, FR-051 to FR-055; F1 "Exit and employee processes"; DF02;
// DF03; DF12). Migrations 0038_lifecycle.sql and 0039_settlement.sql.
//
// Operational duties are default duties; every confidential group (process remarks and evidence, restricted notes,
// letters, the exit reason and settlement amounts) is a ceiling-only grant of an eligible role, approved per
// assignment. The Employee role's only confidential group is its own resignation reason (H1/BR-053 own submission).
import type { ModuleRegistration } from '../registry-types.js';

export const lifecycleRegistration: ModuleRegistration = {
  key: 'lifecycle',
  active: true,
  // F2 "own pending requests": the resignation waits for the manager, then HR; a withdrawal request waits for HR.
  // Processes, settlements and their approval stage are about the employee, not the employee's own request.
  transactionKinds: {
    exit_case: ['SUBMITTED', 'RECOMMENDED'],
    exit_withdrawal: ['SUBMITTED'],
    employee_process: null,
    settlement: null,
    settlement_approval: null,
  },
  roleGrants: {
    HR_ADMINISTRATOR: {
      defaultDuties: [
        'lifecycle_process.read.operational',
        'lifecycle_process.manage.operational',
        'employee_process.read.operational',
        'employee_process.manage.operational',
        'employee_process.complete_task.operational',
        'employee_process.reopen.operational',
        'letter_template.read.operational',
        'letter_template.manage.operational',
        'exit.read.operational',
        'exit.recommend.operational',
        'exit.approve.operational',
        'exit.manage.operational',
        'settlement.read.operational',
      ],
      ceiling: [
        'employee_process.read.note',
        'employee_process.read_evidence.evidence',
        'employee_note.read.restricted',
        'employee_note.write.restricted',
        'letter.generate.letter',
        'letter.read.letter',
        'exit.read.reason',
        'settlement.read.amount',
        // FR-002: exporting is its own right (0119): reading a settlement for review does not allow its bulk export.
        'settlement.export.amount',
        'settlement.prepare.amount',
        'settlement.review.amount',
        'settlement.approve.amount',
        'settlement.release.amount',
      ],
    },
    REPORTING_MANAGER: {
      defaultDuties: ['employee_process.read.operational', 'employee_process.complete_task.operational', 'exit.read.operational', 'exit.recommend.operational'],
      ceiling: ['exit.read.reason'],
    },
    // H1/BR-053: the employee's own processes and resignation; the own reason is the catalogued own-ESS group.
    EMPLOYEE: {
      defaultDuties: ['employee_process.read.operational', 'employee_process.complete_task.operational', 'exit.submit.operational', 'exit.read.operational', 'exit.read.reason'],
    },
    // Clearance and onboarding tasks may be owned by these roles; the duty is granted per assignment.
    SYSTEM_ADMINISTRATOR: { ceiling: ['employee_process.read.operational', 'employee_process.complete_task.operational'] },
    PAYROLL_OPERATOR: { ceiling: ['employee_process.read.operational', 'employee_process.complete_task.operational', 'settlement.read.operational'] },
    FINANCE_REVIEWER: { ceiling: ['employee_process.read.operational', 'employee_process.complete_task.operational'] },
  },
  operationalFieldGroups: [
    { resource: 'lifecycle_process', fieldGroup: 'operational' },
    { resource: 'employee_process', fieldGroup: 'operational' },
    { resource: 'letter_template', fieldGroup: 'operational' },
    { resource: 'exit', fieldGroup: 'operational' },
    { resource: 'settlement', fieldGroup: 'operational' },
  ],
  workflows: [
    // F1: the direct manager recommends the last working date (HR fallback when the manager is ineligible), then
    // an independent HR Administrator from the explicit list approves it.
    {
      kind: 'exit_case',
      steps: [
        { sequence: 1, permission: 'exit.recommend.operational', selectionRule: 'DIRECT_MANAGER' },
        { sequence: 2, permission: 'exit.approve.operational', selectionRule: 'HR_FALLBACK_LIST' },
      ],
    },
    // F1: after approval, a withdrawal needs an independent HR decision.
    { kind: 'exit_withdrawal', steps: [{ sequence: 1, permission: 'exit.approve.operational', selectionRule: 'HR_FALLBACK_LIST' }] },
    // FR-053: independent review, then independent approval (its own transaction excluding preparer and reviewer).
    { kind: 'settlement', steps: [{ sequence: 1, permission: 'settlement.review.amount', selectionRule: 'HR_FALLBACK_LIST' }] },
    { kind: 'settlement_approval', steps: [{ sequence: 1, permission: 'settlement.approve.amount', selectionRule: 'HR_FALLBACK_LIST' }] },
  ],
  // FR-015 and FR-017 name these target examples; the reference catalogue is unverified, so companies extend them.
  referenceValues: {
    LIFECYCLE_PROCESS_TYPE: {
      ONBOARDING: 'Onboarding',
      PROBATION_CONFIRMATION: 'Probation confirmation',
      TRANSFER: 'Transfer',
      PROMOTION: 'Promotion',
      EXIT: 'Exit clearance',
    },
    LETTER_TYPE: {
      OFFER: 'Offer letter',
      APPOINTMENT: 'Appointment letter',
      CONFIRMATION: 'Confirmation letter',
      TRANSFER: 'Transfer letter',
      WARNING: 'Warning letter',
      RELIEVING: 'Relieving letter',
      EXPERIENCE: 'Experience letter',
    },
  },
  // DF12: identity, dates, revision and outcome only; reasons, notes, letter content and amounts never travel.
  notifications: [
    {
      code: 'EXIT_SUBMITTED',
      eventType: 'EXIT_SUBMITTED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Resignation waiting for your recommendation',
      body: '{{employeeName}} ({{employeeCode}}) has resigned with a proposed last working date of {{lastWorkingDate}}. Please recommend the last working date.',
      placeholders: ['employeeName', 'employeeCode', 'lastWorkingDate'],
    },
    {
      code: 'EXIT_RECOMMENDED',
      eventType: 'EXIT_RECOMMENDED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Resignation waiting for your approval',
      body: 'The resignation of {{employeeName}} ({{employeeCode}}) with a recommended last working date of {{lastWorkingDate}} is waiting for your approval.',
      placeholders: ['employeeName', 'employeeCode', 'lastWorkingDate'],
    },
    {
      code: 'EXIT_DECIDED',
      eventType: 'EXIT_DECIDED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your resignation',
      body: 'Your resignation was {{outcome}}.',
      placeholders: ['outcome'],
    },
    {
      code: 'EXIT_DECIDED_MANAGER',
      eventType: 'EXIT_DECIDED',
      selector: 'SUBJECT_MANAGER',
      optional: false,
      subject: 'Resignation of {{employeeName}}',
      body: 'The resignation of {{employeeName}} ({{employeeCode}}) was {{outcome}}.',
      placeholders: ['employeeName', 'employeeCode', 'outcome'],
    },
    {
      code: 'EXIT_WITHDRAWAL_SUBMITTED',
      eventType: 'EXIT_WITHDRAWAL_SUBMITTED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Withdrawal of an approved resignation waiting for you',
      body: '{{employeeName}} ({{employeeCode}}) asks to withdraw an approved resignation with last working date {{lastWorkingDate}}.',
      placeholders: ['employeeName', 'employeeCode', 'lastWorkingDate'],
    },
    {
      code: 'EXIT_WITHDRAWAL_DECIDED',
      eventType: 'EXIT_WITHDRAWAL_DECIDED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Withdrawal of your resignation',
      body: 'Your request to withdraw your resignation was {{outcome}}.',
      placeholders: ['outcome'],
    },
    {
      code: 'PROCESS_TASK_ASSIGNED',
      eventType: 'PROCESS_TASK_ASSIGNED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Task assigned: {{taskTitle}}',
      body: 'The task "{{taskTitle}}" of {{processName}} for {{employeeName}} ({{employeeCode}}) is assigned to you, due {{dueDate}}.',
      placeholders: ['taskTitle', 'processName', 'employeeName', 'employeeCode', 'dueDate'],
    },
    {
      code: 'SETTLEMENT_ASSIGNED',
      eventType: 'SETTLEMENT_ASSIGNED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Full and final settlement waiting for your {{step}}',
      body: 'Revision {{revision}} of the full and final settlement of {{employeeName}} ({{employeeCode}}) is waiting for your {{step}}.',
      placeholders: ['step', 'revision', 'employeeName', 'employeeCode'],
    },
    {
      code: 'SETTLEMENT_DECIDED',
      eventType: 'SETTLEMENT_DECIDED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Full and final settlement {{outcome}}',
      body: 'Revision {{revision}} of the full and final settlement of {{employeeName}} ({{employeeCode}}) was {{outcome}}.',
      placeholders: ['revision', 'employeeName', 'employeeCode', 'outcome'],
    },
  ],
};
