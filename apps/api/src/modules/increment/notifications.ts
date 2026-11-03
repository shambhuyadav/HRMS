// DF15 review due reminders: lead days and the in-app catalogue entries, as plain data (no runtime imports), in the
// shape of BASELINE_NOTIFICATIONS so provisioning can add them. Placeholders are operational values only: the
// employee's name and code and the dates, never amounts, percentages or reasons (DF12, CR-007).

/** DF15 "Review due reminders at 30/7/1 days before closing". */
export const INCREMENT_REVIEW_REMINDER_LEAD_DAYS: readonly number[] = [30, 7, 1];

export const INCREMENT_REVIEW_NOTIFICATIONS: readonly {
  code: string;
  eventType: string;
  selector: 'SUBJECT_MANAGER' | 'ASSIGNED_REVIEWER';
  optional: boolean;
  subject: string;
  body: string;
  placeholders: string[];
}[] = [
  {
    // A case still waiting for the direct manager's proposal (DRAFT or RETURNED).
    code: 'INCREMENT_PROPOSAL_DUE',
    eventType: 'INCREMENT_PROPOSAL_DUE',
    selector: 'SUBJECT_MANAGER',
    optional: false,
    subject: 'Increment review closing',
    body: 'The increment review for {{employeeName}} ({{employeeCode}}) closes on {{dueDate}}, in {{days}} days; your proposal is still open.',
    placeholders: ['employeeName', 'employeeCode', 'dueDate', 'days'],
  },
  {
    // A proposal waiting for the independent decision (SUBMITTED): the reviewer the open task is assigned to.
    code: 'INCREMENT_DECISION_DUE',
    eventType: 'INCREMENT_DECISION_DUE',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Increment decision due',
    body: 'The increment review for {{employeeName}} ({{employeeCode}}) waiting for your decision closes on {{dueDate}}, in {{days}} days.',
    placeholders: ['employeeName', 'employeeCode', 'dueDate', 'days'],
  },
];
