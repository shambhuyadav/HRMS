// Hiring (FR-011 to FR-014; F1 hiring; DF04 wave 2 form contracts; DB060-DB062): role grants, operational field
// groups, approval routes, notification templates, reference lists and transaction kinds. Data only.
import type { ModuleRegistration } from '../registry-types.js';

export const hiringRegistration: ModuleRegistration = {
  key: 'hiring',
  active: true,
  // A requisition is the requester's own request while it waits for the two reviewers (F1); budget revisions and
  // offers are company records prepared by HR or recruiters (never an employee's own request).
  transactionKinds: { requisition: ['SUBMITTED'], manpower_budget_revision: null, hiring_offer: null },
  roleGrants: {
    HR_ADMINISTRATOR: {
      // Operational hiring administration (DF02: employment-lifecycle actions in scope).
      defaultDuties: [
        'manpower_budget.read.operational',
        'manpower_budget.manage.operational',
        'manpower_budget.approve.operational',
        'requisition.read.operational',
        'requisition.create.operational',
        'requisition.validate.operational',
        'requisition.approve.operational',
        'requisition.close.operational',
        'candidate.read.operational',
        'candidate.manage.operational',
        'application.read.operational',
        'application.manage.operational',
        'offer.read.operational',
        'offer.manage.operational',
        'hiring.handover.operational',
      ],
      // F1: candidate private contacts/documents and offer compensation are confidential; each needs an
      // independently approved grant on an eligible scoped Admin assignment (ceiling only, never a default duty).
      ceiling: [
        'candidate.read.contact',
        'candidate.manage.contact',
        'candidate.read.document',
        'candidate.upload.document',
        'offer.read.compensation',
        'offer.manage.compensation',
        'offer.approve.compensation',
        // I-82 item 1 (0190): issuing an offer letter from the approved offer (preview, final output, recorded delivery).
        'offer.issue_letter.compensation',
      ],
    },
    // F1: the Recruiter sees and works the operational pipeline (company scope); no confidential groups.
    RECRUITER: {
      defaultDuties: [
        'requisition.read.operational',
        'candidate.read.operational',
        'candidate.manage.operational',
        'application.read.operational',
        'application.manage.operational',
        'offer.read.operational',
        'offer.manage.operational',
      ],
    },
    // F1: a manager raises requisitions and validates those of their direct reports (first approval step).
    REPORTING_MANAGER: {
      defaultDuties: ['requisition.read.operational', 'requisition.create.operational', 'requisition.validate.operational'],
    },
  },
  operationalFieldGroups: [
    { resource: 'manpower_budget', fieldGroup: 'operational' },
    { resource: 'requisition', fieldGroup: 'operational' },
    { resource: 'candidate', fieldGroup: 'operational' },
    { resource: 'application', fieldGroup: 'operational' },
    { resource: 'offer', fieldGroup: 'operational' },
    { resource: 'hiring', fieldGroup: 'operational' },
  ],
  workflows: [
    // F1: requester -> direct manager validation (HR fallback list when the manager is ineligible) -> HR
    // Administrator budget/headcount approval. C4: the second step never goes to the first step's decider.
    {
      kind: 'requisition',
      steps: [
        { sequence: 1, permission: 'requisition.validate.operational', selectionRule: 'DIRECT_MANAGER' },
        { sequence: 2, permission: 'requisition.approve.operational', selectionRule: 'HR_FALLBACK_LIST' },
      ],
    },
    // FR-011: an independent HR Administrator approves each budget revision (the preparer is excluded).
    { kind: 'manpower_budget_revision', steps: [{ sequence: 1, permission: 'manpower_budget.approve.operational', selectionRule: 'HR_FALLBACK_LIST' }] },
    // F1: an independent eligible Admin approves the confidential offer compensation.
    { kind: 'hiring_offer', steps: [{ sequence: 1, permission: 'offer.approve.compensation', selectionRule: 'HR_FALLBACK_LIST' }] },
  ],
  // DF12: submitted/assigned, decided (approved, rejected, returned) and withdrawn notices (a withdrawal tells the
  // reviewer whose task was cancelled). Operational values only:
  // never compensation, private contacts, documents or decision reasons.
  notifications: [
    {
      code: 'REQUISITION_SUBMITTED',
      eventType: 'REQUISITION_SUBMITTED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Requisition {{requisitionCode}} waiting for your {{stepLabel}}',
      body: 'Requisition {{requisitionCode}} ({{title}}, {{vacancies}} vacancies) is waiting for your {{stepLabel}}.',
      placeholders: ['requisitionCode', 'title', 'vacancies', 'stepLabel'],
    },
    {
      code: 'REQUISITION_DECIDED',
      eventType: 'REQUISITION_DECIDED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Requisition {{requisitionCode}} {{outcome}}',
      body: 'Your requisition {{requisitionCode}} ({{title}}) was {{outcome}}.',
      placeholders: ['requisitionCode', 'title', 'outcome'],
    },
    {
      code: 'REQUISITION_WITHDRAWN',
      eventType: 'REQUISITION_WITHDRAWN',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Requisition {{requisitionCode}} withdrawn',
      body: 'Requisition {{requisitionCode}} ({{title}}) was withdrawn by the requester; no decision is needed.',
      placeholders: ['requisitionCode', 'title'],
    },
    // DF12 "cancelled": HR closed the requester's approved requisition (filled or no longer needed; never the reason).
    {
      code: 'REQUISITION_CLOSED',
      eventType: 'REQUISITION_CLOSED',
      selector: 'SUBJECT_EMPLOYEE',
      optional: false,
      subject: 'Requisition {{requisitionCode}} closed',
      body: 'Your approved requisition {{requisitionCode}} ({{title}}) was closed by HR.',
      placeholders: ['requisitionCode', 'title'],
    },
    {
      code: 'BUDGET_REVISION_SUBMITTED',
      eventType: 'BUDGET_REVISION_SUBMITTED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Manpower budget revision waiting for your approval',
      body: 'A manpower budget revision for {{departmentName}}, {{locationName}}, {{designationName}} ({{periodStart}} to {{periodEnd}}) is waiting for your decision.',
      placeholders: ['departmentName', 'locationName', 'designationName', 'periodStart', 'periodEnd'],
    },
    {
      code: 'BUDGET_REVISION_DECIDED',
      eventType: 'BUDGET_REVISION_DECIDED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Manpower budget revision {{outcome}}',
      body: 'Your manpower budget revision for {{departmentName}}, {{locationName}}, {{designationName}} ({{periodStart}} to {{periodEnd}}) was {{outcome}}.',
      placeholders: ['departmentName', 'locationName', 'designationName', 'periodStart', 'periodEnd', 'outcome'],
    },
    {
      code: 'BUDGET_REVISION_WITHDRAWN',
      eventType: 'BUDGET_REVISION_WITHDRAWN',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Manpower budget revision withdrawn',
      body: 'The manpower budget revision for {{departmentName}}, {{locationName}}, {{designationName}} ({{periodStart}} to {{periodEnd}}) was withdrawn by its preparer; no decision is needed.',
      placeholders: ['departmentName', 'locationName', 'designationName', 'periodStart', 'periodEnd'],
    },
    {
      code: 'OFFER_SUBMITTED',
      eventType: 'OFFER_SUBMITTED',
      selector: 'ASSIGNED_REVIEWER',
      optional: false,
      subject: 'Offer waiting for your approval',
      body: 'An offer to candidate {{candidateCode}} for requisition {{requisitionCode}} is waiting for your approval.',
      placeholders: ['candidateCode', 'requisitionCode'],
    },
    {
      code: 'OFFER_DECIDED',
      eventType: 'OFFER_DECIDED',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Offer {{outcome}}',
      body: 'The offer to candidate {{candidateCode}} for requisition {{requisitionCode}} was {{outcome}}.',
      placeholders: ['candidateCode', 'requisitionCode', 'outcome'],
    },
    {
      code: 'OFFER_WITHDRAWN',
      eventType: 'OFFER_WITHDRAWN',
      selector: 'BENEFICIARY_USER',
      optional: false,
      subject: 'Offer withdrawn',
      body: 'The offer to candidate {{candidateCode}} for requisition {{requisitionCode}} was withdrawn; no decision is needed.',
      placeholders: ['candidateCode', 'requisitionCode'],
    },
  ],
  // DF04 controlled lists. The BRD names no source or candidate document catalogue beyond "source/vendor" and
  // "CV attachments"; neutral values are seeded.
  referenceValues: {
    CANDIDATE_SOURCE: { DIRECT: 'Direct application', VENDOR: 'Recruitment vendor' },
    CANDIDATE_DOCUMENT_TYPE: { CV: 'Curriculum vitae', OTHER: 'Other candidate document' },
    // I-82 item 1: how an offer letter reached the candidate outside the system (DF09 disables confidential e-mail
    // attachments). A company list HR maintains (reference/maintenance.ts); these two are the conservative starting values.
    OFFER_LETTER_DELIVERY: { IN_PERSON: 'Handed to the candidate in person', POST: 'Sent by post or courier' },
  },
};
