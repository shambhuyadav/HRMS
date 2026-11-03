// Timesheets (FR-045 to FR-048; DB066-DB071; F1 "Timesheets"; OQ-11; DF02; DF03; DF12; BR-049; H3 TN13): role
// grants, operational field groups, approval routes, notification templates, transaction kinds and the TN13 tab.
// Data only. Migrations 0037_timesheet and 0067_timesheet_exports_xlsx (export permissions).
//
// Every timesheet field group is operational (DF02 "work attendance times/status"): projects, jobs, activities,
// allocations, dates, hours, work notes, states and review notes. Nothing here is confidential, so the Employee
// role needs no own-ESS exception; its OWN scope keeps it to its own timesheets.
import type { ModuleRegistration } from '../registry-types.js';

export const timesheetRegistration: ModuleRegistration = {
  key: 'timesheet',
  active: true,
  // F2 "own pending requests": a submitted timesheet waits for the manager; a returned or rejected one waits for the
  // employee's next revision of that week (the week's one timesheet is never closed, DF03/DB070). A reopen request
  // about the employee's approved timesheet waits for the independent HR reviewer.
  transactionKinds: { timesheet: ['SUBMITTED', 'RETURNED', 'REJECTED'], timesheet_reopen: ['SUBMITTED'] },
  roleGrants: {
    HR_ADMINISTRATOR: {
      defaultDuties: [
        'timesheet_master.read.operational',
        'timesheet_master.manage.operational',
        'timesheet_allocation.read.operational',
        'timesheet_allocation.manage.operational',
        'timesheet_allocation.import.operational',
        'timesheet.read.operational',
        // DF03: the HR fallback reviewer when the direct manager is missing or ineligible.
        'timesheet.approve.operational',
        'timesheet.request_reopen.operational',
        // F1: the independent authorised reopen of an approved timesheet.
        'timesheet.reopen.operational',
        'timesheet.import.operational',
        'timesheet.resolve_exception.operational',
        'timesheet.report.operational',
        // FR-046 / FR-048 exports (report catalogue RESOURCE_ALLOCATION and TMS_HOURS; migration 0067), as HR holds the
        // other operational report exports. The manager reads the team's reports but holds no export by default.
        'timesheet_allocation.export.operational',
        'timesheet.export.operational',
      ],
    },
    // DF03/DF16: the direct manager reviews the team's timesheets, maintains their allocations (and records an
    // over-allocation exception, F1) and reads the team's reports.
    REPORTING_MANAGER: {
      defaultDuties: [
        'timesheet_master.read.operational',
        'timesheet_allocation.read.operational',
        'timesheet_allocation.manage.operational',
        'timesheet.read.operational',
        'timesheet.approve.operational',
        'timesheet.request_reopen.operational',
        'timesheet.report.operational',
      ],
    },
    // H3 TN13: own period entry, submission, decisions and missed reminders (Employee OWN context).
    EMPLOYEE: { defaultDuties: ['timesheet.submit.operational', 'timesheet.read.operational', 'timesheet.request_reopen.operational'] },
  },
  operationalFieldGroups: [
    { resource: 'timesheet_master', fieldGroup: 'operational' },
    { resource: 'timesheet_allocation', fieldGroup: 'operational' },
    { resource: 'timesheet', fieldGroup: 'operational' },
  ],
  workflows: [
    // DF03: timesheets route to the current direct manager; the HR fallback list when the manager is ineligible.
    { kind: 'timesheet', steps: [{ sequence: 1, permission: 'timesheet.approve.operational', selectionRule: 'DIRECT_MANAGER' }] },
    // F1: an approved timesheet is corrected only after an independent authorised reopen (HR list; the requester,
    // the employee and whoever decided the timesheet are excluded).
    { kind: 'timesheet_reopen', steps: [{ sequence: 1, permission: 'timesheet.reopen.operational', selectionRule: 'HR_FALLBACK_LIST' }] },
  ],
  // DF12: submitted/assigned and decided notices, reopen requests and their outcome, and the BR-049 missed-submission
  // reminder. Identity, week, revision, hours and outcome only.
  notifications: [
    {
      code: 'TIMESHEET_SUBMITTED',
      eventType: 'TIMESHEET_SUBMITTED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Timesheet waiting for your decision',
      body: 'The timesheet of {{employeeName}} ({{employeeCode}}) for {{periodStart}} to {{periodEnd}} (revision {{revision}}, {{hours}} hours) is waiting for your decision.',
      placeholders: ['employeeName', 'employeeCode', 'periodStart', 'periodEnd', 'revision', 'hours'],
    },
    {
      code: 'TIMESHEET_DECIDED',
      eventType: 'TIMESHEET_DECIDED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Timesheet {{outcome}}',
      body: 'Your timesheet for {{periodStart}} to {{periodEnd}} (revision {{revision}}) was {{outcome}}.',
      placeholders: ['periodStart', 'periodEnd', 'revision', 'outcome'],
    },
    {
      code: 'TIMESHEET_REOPEN_SUBMITTED',
      eventType: 'TIMESHEET_REOPEN_SUBMITTED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Timesheet reopen request waiting for your decision',
      body: 'A request to reopen the approved timesheet of {{employeeName}} ({{employeeCode}}) for {{periodStart}} to {{periodEnd}} is waiting for your decision.',
      placeholders: ['employeeName', 'employeeCode', 'periodStart', 'periodEnd'],
    },
    {
      code: 'TIMESHEET_REOPEN_DECIDED',
      eventType: 'TIMESHEET_REOPEN_DECIDED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Timesheet reopen request {{outcome}}',
      body: 'The request to reopen your timesheet for {{periodStart}} to {{periodEnd}} was {{outcome}}.',
      placeholders: ['periodStart', 'periodEnd', 'outcome'],
    },
    {
      // The requester, when someone other than the employee asked for the reopen.
      code: 'TIMESHEET_REOPEN_DECIDED_REQUESTER',
      eventType: 'TIMESHEET_REOPEN_DECIDED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Timesheet reopen request {{outcome}}',
      body: 'Your request to reopen the timesheet of {{employeeName}} ({{employeeCode}}) for {{periodStart}} to {{periodEnd}} was {{outcome}}.',
      placeholders: ['employeeName', 'employeeCode', 'periodStart', 'periodEnd', 'outcome'],
    },
    {
      // BR-049: a reminder and a pending exception only; never a deduction.
      code: 'TIMESHEET_MISSING',
      eventType: 'TIMESHEET_MISSING',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Timesheet for {{periodStart}} to {{periodEnd}} not submitted',
      body: 'Your timesheet for {{periodStart}} to {{periodEnd}} was due on {{dueDate}} and has not been submitted. Please submit it; a late timesheet is still accepted.',
      placeholders: ['periodStart', 'periodEnd', 'dueDate'],
    },
  ],
  // H3 TN13: own period entry/submission/approval and missed reminders. Later-payroll adjustments arrive with the
  // payroll stage (FR-100), not from this module.
  essTabs: [
    {
      tab: 'TN13',
      permissions: ['timesheet.submit.operational', 'timesheet.read.operational'],
      links: [
        { rel: 'timesheets', method: 'GET', href: '/v1/me/timesheets' },
        { rel: 'createTimesheet', method: 'POST', href: '/v1/me/timesheets' },
        { rel: 'allocations', method: 'GET', href: '/v1/me/timesheet-allocations' },
        { rel: 'missedReminders', method: 'GET', href: '/v1/me/timesheet-exceptions' },
        { rel: 'decisionHistory', method: 'GET', href: '/v1/me/requests?kind=timesheet' },
      ],
    },
  ],
};
