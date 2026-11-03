// Training plans, participants and feedback (FR-049, FR-050; F1 "Training"; BR-015; DB072-DB074; DF02; DF04; DF12;
// H3 TN17): role grants, operational field groups, controlled lists, notification templates and the TN17 tab. Data only.
// Migration 0036_training.
//
// DF02 classification. Plans (title, dates, mode, venue, trainer, capacity, owner, state), participation states and
// dates and feedback scores are operational (DF02 lists "approved skills/training" among operational fields; F1 "the
// coordinator sees plans and operational completion"). The plan cost is company spend on a session, not compensation
// or a personal value, so it is operational too (the coordinator maintains it, FR-049); it is a separate group so the
// Employee role never receives it, as DF02 keeps even operational expense amounts to the people working with them.
// The feedback comment is confidential (F1 "comments restricted"; C3 "sensitive feedback separated"): the employee's
// own comment is an own-ESS group (H1/BR-053, own record only); otherwise only an eligible HR Administrator assignment
// with an approved grant reads it (ceiling only). The Training Coordinator never holds it.
// The free-text reasons recorded on a participation (a coordinator's cancellation or attendance correction, an
// employee's withdrawal) are the confidential `reason` group of training_participant: DF02 keeps private reasons
// confidential and I-16/BR-053 keep reviewer notes out of the employee's own view (as for confirmation and attendance
// amendment reasons, D-016). Ceiling only for HR Administrator and Reporting Manager; not own-ESS. The plan's own
// cancellation reason (FR-049) describes a company record and stays operational.
//
// No approval workflow: the BRD routes no training decision to a reviewer (DF03), so nominations are confirmed by the
// coordinator (capacity enforced at confirmation, F1) and the module adds no transaction kind.
import type { PermissionKey } from '../access/baseline.js';
import type { ModuleRegistration } from '../registry-types.js';

/** BRD 4661 "Training plans, participants and permitted feedback" (operational groups only). */
const COORDINATOR_DUTIES: PermissionKey[] = [
  'training_plan.read.operational',
  'training_plan.manage.operational',
  'training_plan.export.operational',
  'training_plan.read.cost',
  'training_plan.manage.cost',
  'training_plan.export.cost',
  'training_participant.read.operational',
  'training_participant.manage.operational',
  'training_feedback.read.operational',
  'training_feedback.export.operational',
];

export const trainingRegistration: ModuleRegistration = {
  key: 'training',
  active: true,
  roleGrants: {
    TRAINING_COORDINATOR: { defaultDuties: COORDINATOR_DUTIES },
    // C4 "HR Administrator: workforce, confirmation, lifecycle and training due"; like the other wave-2 modules, HR keeps
    // the operational administration. Feedback comments and participation reasons are confidential, ceiling-only grants.
    HR_ADMINISTRATOR: { defaultDuties: COORDINATOR_DUTIES, ceiling: ['training_feedback.read.comment', 'training_participant.read.reason'] },
    // DF16 My Team: the direct team's training participation (operational); its reasons only with an approved grant.
    REPORTING_MANAGER: { defaultDuties: ['training_participant.read.operational'], ceiling: ['training_participant.read.reason'] },
    // H3 TN17: own enrolment, assigned sessions, attendance/completion (read only) and own feedback entry.
    EMPLOYEE: {
      defaultDuties: [
        'training_participant.read.operational',
        'training_participant.enrol.operational',
        'training_feedback.read.operational',
        'training_feedback.submit.operational',
        'training_feedback.read.comment',
        'training_feedback.submit.comment',
      ],
    },
  },
  operationalFieldGroups: [
    { resource: 'training_plan', fieldGroup: 'operational' },
    { resource: 'training_plan', fieldGroup: 'cost' },
    { resource: 'training_participant', fieldGroup: 'operational' },
    { resource: 'training_feedback', fieldGroup: 'operational' },
  ],
  // DF04 controlled lists. The BRD names no delivery-mode or feedback-question catalogue: neutral values are seeded and
  // companies add their own. The one question carries the DF04 contract "feedback score 1..5 and optional comment".
  referenceValues: {
    TRAINING_MODE: { IN_PERSON: 'In person', VIRTUAL: 'Virtual' },
    TRAINING_FEEDBACK_QUESTION: { OVERALL: 'Overall rating of the training' },
  },
  // DF12 assigned / approved / cancelled notices to the participant. Plan identity and dates only: reasons, feedback,
  // cost and anyone else's details never travel.
  notifications: [
    {
      code: 'TRAINING_NOMINATED',
      eventType: 'TRAINING_NOMINATED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'You were nominated for {{planTitle}}',
      body: 'You were nominated for the training {{planTitle}} ({{planCode}}), {{startDate}} to {{endDate}}. Your place is confirmed separately.',
      placeholders: ['planTitle', 'planCode', 'startDate', 'endDate'],
    },
    {
      code: 'TRAINING_CONFIRMED',
      eventType: 'TRAINING_CONFIRMED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your place in {{planTitle}} is confirmed',
      body: 'Your place in the training {{planTitle}} ({{planCode}}), {{startDate}} to {{endDate}}, is confirmed.',
      placeholders: ['planTitle', 'planCode', 'startDate', 'endDate'],
    },
    {
      code: 'TRAINING_PARTICIPATION_CANCELLED',
      eventType: 'TRAINING_PARTICIPATION_CANCELLED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Your participation in {{planTitle}} was cancelled',
      body: 'Your participation in the training {{planTitle}} ({{planCode}}), {{startDate}} to {{endDate}}, was cancelled.',
      placeholders: ['planTitle', 'planCode', 'startDate', 'endDate'],
    },
    {
      code: 'TRAINING_PLAN_CANCELLED',
      eventType: 'TRAINING_PLAN_CANCELLED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: '{{planTitle}} was cancelled',
      body: 'The training {{planTitle}} ({{planCode}}), {{startDate}} to {{endDate}}, was cancelled.',
      placeholders: ['planTitle', 'planCode', 'startDate', 'endDate'],
    },
    {
      code: 'TRAINING_COMPLETED',
      eventType: 'TRAINING_COMPLETED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'You completed {{planTitle}}',
      body: 'Your completion of the training {{planTitle}} ({{planCode}}) is recorded. You can now give your feedback.',
      placeholders: ['planTitle', 'planCode'],
    },
  ],
  // H3 TN17 in the Employee OWN context: own participations (enrolments and assigned sessions with attendance and
  // completion as recorded by the coordinator), plans open for self-nomination, and own feedback entry.
  essTabs: [
    {
      tab: 'TN17',
      permissions: ['training_participant.read.operational', 'training_participant.enrol.operational', 'training_feedback.submit.operational'],
      links: [
        { rel: 'participations', method: 'GET', href: '/v1/employees/{employeeId}/training' },
        { rel: 'openPlans', method: 'GET', href: '/v1/me/training-plans' },
        { rel: 'enrol', method: 'POST', href: '/v1/me/training-nominations' },
        { rel: 'feedback', method: 'GET', href: '/v1/me/training-feedback' },
        { rel: 'submitFeedback', method: 'POST', href: '/v1/me/training-feedback' },
      ],
    },
  ],
};
