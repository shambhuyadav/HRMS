// Sensitive private-profile changes (FR-104, FR-105): role grants, review route and notifications.
import type { ModuleRegistration } from '../registry-types.js';

export const sensitiveChangeRegistration: ModuleRegistration = {
  key: 'sensitive-change',
  active: true,
  // H2: an approved change waits for its effective date (SCHEDULED) before it applies.
  transactionKinds: { sensitive_change: ['SUBMITTED', 'IN_REVIEW', 'SCHEDULED'] },
  roleGrants: {
    // H1/BR-053 own-ESS groups: confidential, held only for the employee's own record in the Employee OWN context.
    EMPLOYEE: { defaultDuties: ['sensitive_change.submit.private', 'sensitive_change.read.private', 'employee.read.private'] },
    // Independent review and full private values are confidential Admin grants (ceiling only, approved per assignment).
    HR_ADMINISTRATOR: { ceiling: ['sensitive_change.review.private', 'sensitive_change.read.private', 'employee.read.private', 'employee.read.bank'] },
  },
  // FR-104/105: an independent eligible HR Administrator from the explicit list (the owner is never eligible).
  workflows: [{ kind: 'sensitive_change', steps: [{ sequence: 1, permission: 'sensitive_change.review.private', selectionRule: 'HR_FALLBACK_LIST' }] }],
  notifications: [
    {
      code: 'SENSITIVE_CHANGE_SUBMITTED',
      eventType: 'SENSITIVE_CHANGE_SUBMITTED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Change of {{category}} waiting for your review',
      body: 'A change of {{category}} for {{employeeName}} ({{employeeCode}}), effective {{effectiveDate}}, is waiting for your review.',
      placeholders: ['category', 'employeeName', 'employeeCode', 'effectiveDate'],
    },
    {
      code: 'SENSITIVE_CHANGE_OUTCOME',
      eventType: 'SENSITIVE_CHANGE_OUTCOME',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your change of {{category}}',
      body: 'Your change of {{category}} effective {{effectiveDate}} was {{outcome}}.',
      placeholders: ['category', 'effectiveDate', 'outcome'],
    },
  ],
};
