// Appraisal (FR-040 to FR-044; F1 "Appraisal"; BR-013/BR-014; DB063-DB065; DF02; DF03; DF12; H3 TN18). Migration
// 0035_appraisal.sql. Data only.
//
// DF02: goal names, weights, completion flags and task status are operational; self, manager and reviewer ratings,
// comments, results and reasons are confidential. Confidential groups are ceiling-only grants of eligible roles
// (HR Administrator, Reporting Manager), approved per assignment with a purpose. The Employee role's only confidential
// groups are its own self-entry (H1/BR-053 own-ESS: own record only); it never holds manager or reviewer content.
import type { ModuleRegistration } from '../registry-types.js';

export const appraisalRegistration: ModuleRegistration = {
  key: 'appraisal',
  active: true,
  // An appraisal (and its explicit second review level) is a process about the employee opened by HR or the manager,
  // not the employee's own request.
  transactionKinds: { appraisal: null, appraisal_second_review: null },
  roleGrants: {
    HR_ADMINISTRATOR: {
      defaultDuties: [
        'appraisal_cycle.read.operational',
        'appraisal_cycle.manage.operational',
        'appraisal.read.operational',
        'appraisal.manage.operational',
        'appraisal.cancel.operational',
        'appraisal.grant_exception.operational',
        'appraisal.import.operational',
        'appraisal.report.operational',
        'appraisal.export.operational',
      ],
      ceiling: ['appraisal.read.rating', 'appraisal.rate.rating', 'appraisal.confirm.rating', 'appraisal.report.rating', 'appraisal.export.rating', 'appraisal.read.reason'],
    },
    // DF02: the manager sets goals for current direct reports; appraisal ratings and narratives are off by default and
    // need an independently approved grant with a purpose.
    REPORTING_MANAGER: {
      defaultDuties: ['appraisal_cycle.read.operational', 'appraisal.read.operational', 'appraisal.manage.operational', 'appraisal.report.operational'],
      ceiling: ['appraisal.read.rating', 'appraisal.rate.rating', 'appraisal.report.rating'],
    },
    // H3 TN18: own goals and task status, own self-entry and submission (own-ESS groups, own record only).
    EMPLOYEE: { defaultDuties: ['appraisal.read.operational', 'appraisal.read.self', 'appraisal.self_assess.self'] },
    // BRD 4753: assigned task status only; confidential appraisal content is denied in this role.
    APPRAISAL_REVIEWER: { defaultDuties: ['appraisal.read.operational'] },
  },
  operationalFieldGroups: [
    { resource: 'appraisal_cycle', fieldGroup: 'operational' },
    { resource: 'appraisal', fieldGroup: 'operational' },
  ],
  workflows: [
    // F1/DF03: the current direct manager rates (HR fallback list when the manager is ineligible), then an independent
    // eligible reviewer from the explicit list confirms. C4: a later step never goes to an earlier decider; the
    // employee never decides. The reviewer step applies when the revision pinned a reviewer level (0177; I-77 item 2): a
    // cycle with 0 levels is BR-013's one-level manager review, completed at the manager's approval (FR-043).
    {
      kind: 'appraisal',
      steps: [
        { sequence: 1, permission: 'appraisal.rate.rating', selectionRule: 'DIRECT_MANAGER' },
        { sequence: 2, permission: 'appraisal.confirm.rating', selectionRule: 'HR_FALLBACK_LIST', conditionCode: 'APPRAISAL_REVIEWER_LEVEL' },
      ],
    },
    // F1: the second reviewer level, only where the cycle sets it explicitly. It uses the appraisal list (routing kind)
    // and excludes the revision's rater and first reviewer.
    { kind: 'appraisal_second_review', steps: [{ sequence: 1, permission: 'appraisal.confirm.rating', selectionRule: 'HR_FALLBACK_LIST' }] },
  ],
  // DF12: assigned, returned, completed and cancelled notices. Cycle and employee identity only: never scores, results,
  // comments or reasons.
  notifications: [
    {
      code: 'APPRAISAL_RATING_ASSIGNED',
      eventType: 'APPRAISAL_RATING_ASSIGNED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Appraisal waiting for your rating',
      body: 'The {{cycleCode}} appraisal of {{employeeName}} ({{employeeCode}}) is waiting for your rating.',
      placeholders: ['cycleCode', 'employeeName', 'employeeCode'],
    },
    {
      code: 'APPRAISAL_REVIEW_ASSIGNED',
      eventType: 'APPRAISAL_REVIEW_ASSIGNED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Appraisal waiting for your review',
      body: 'The {{cycleCode}} appraisal of {{employeeName}} ({{employeeCode}}) is waiting for your review (level {{level}}).',
      placeholders: ['cycleCode', 'employeeName', 'employeeCode', 'level'],
    },
    {
      code: 'APPRAISAL_RETURNED',
      eventType: 'APPRAISAL_RETURNED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your appraisal was returned',
      body: 'Your {{cycleCode}} appraisal was returned for revision. Open it to see what to change, then submit it again.',
      placeholders: ['cycleCode'],
    },
    {
      code: 'APPRAISAL_COMPLETED',
      eventType: 'APPRAISAL_COMPLETED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your appraisal is complete',
      body: 'Your {{cycleCode}} appraisal has been reviewed and completed.',
      placeholders: ['cycleCode'],
    },
    {
      code: 'APPRAISAL_CANCELLED',
      eventType: 'APPRAISAL_CANCELLED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your appraisal was cancelled',
      body: 'Your {{cycleCode}} appraisal was cancelled.',
      placeholders: ['cycleCode'],
    },
    {
      // The task holder at cancellation: the task is closed, so the notice goes to that user directly.
      code: 'APPRAISAL_TASK_CANCELLED',
      eventType: 'APPRAISAL_TASK_CANCELLED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Appraisal task cancelled',
      body: 'The {{cycleCode}} appraisal of {{employeeName}} ({{employeeCode}}) was cancelled; no action is needed.',
      placeholders: ['cycleCode', 'employeeName', 'employeeCode'],
    },
  ],
  // H3 TN18 in the Employee OWN context: own goals, task status, own self-entry and submission. No employee-visible
  // result is published: no setting authorises it (F1/FR-044), so ratings never appear in the own view.
  essTabs: [
    {
      tab: 'TN18',
      permissions: ['appraisal.read.operational', 'appraisal.self_assess.self'],
      links: [{ rel: 'appraisals', method: 'GET', href: '/v1/me/appraisals' }],
    },
  ],
};
