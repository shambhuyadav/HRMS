// Baseline roles (BRD §5 / C2, 14 roles), their permission ceilings (role_permission ALLOW) and default
// duties. A role's ceiling is the most it can ever be granted; what an assignment may actually do is its
// DB109 allowlist, which starts empty and is seeded only with the role's default duties (DF02).
// Confidential field groups are never default duties; they need a separate, independently approved grant.
//
// Ceilings cover the modules built so far. Modules added through modules/registry.ts declare their own grants,
// field groups and reference values, which are merged into the exports below.
import { MODULE_REGISTRATIONS } from '../registry.js';
import type { ScopeKind } from './authorize.js';

export type PermissionKey = `${string}.${string}.${string}`; // resource.action.field_group

export interface BaselineRole {
  code: string;
  name: string;
  accessClass: 'ADMIN' | 'MANAGER' | 'OTHER';
  defaultScope: 'OWN' | 'TEAM' | 'ASSIGNED' | 'COMPANY';
  ceiling: PermissionKey[];
  defaultDuties: PermissionKey[];
}

const EMPLOYEE_OPERATIONAL_READ: PermissionKey[] = ['employee.list.operational', 'employee.read.operational'];

const ORG_MASTER_ALL: PermissionKey[] = ['org_master.read.operational', 'org_master.create.operational', 'org_master.update.operational'];

// C6 Integration Administrator bundle: explicit grants only; System Administrator has no implicit API authority.
const BIOMETRIC_ADMIN: PermissionKey[] = [
  'biometric.profile_manage.operational',
  'biometric.mapping_manage.operational',
  'biometric.employee_link_manage.operational',
  'biometric.sync_run.operational',
  'biometric.sync_exception_reprocess.operational',
  'biometric.read.operational',
];

const AUDIT_RETENTION_ADMIN: PermissionKey[] = ['audit.export.operational', 'retention.manage.operational', 'retention.approve.operational'];

const ACCESS_ADMIN: PermissionKey[] = [
  'access.read_users.operational',
  'access.assign_role.operational',
  'access.approve_role_grant.operational',
  'access.revoke_role.operational',
  'access.maintain_role_permissions.operational',
  // §5 "user/role administration", DB007, DB009 (0100). A link grants no permission by itself.
  'access.link_user.operational',
  'access.deactivate_user.operational',
];

// FR-003, FR-068: ask to delegate one's own decision authority, for the two reviewers DF03 names, the Reporting Manager and the
// scoped HR Administrator. I-84 item 3 (decided under owner delegation, 6 Nov 2026): a default duty of both, since it only lets
// the holder ask; every delegation is approved by an independent approve_role_grant holder (delegation.ts).
const DELEGATE_OWN_DECISIONS: PermissionKey = 'access.delegate.operational';

// C4 "owner-approved rerouting creates new task with history" (I-52 item 1). I-84 item 1: the HR Administrator, who keeps the
// approval routes (workflow.manage), reroutes a stranded task as a default duty within row scope; the rule picks the new reviewer,
// never the person rerouting, and nobody reroutes their own request (workflow/engine.ts).
const REROUTE_STRANDED_TASK: PermissionKey = 'workflow.reroute_task.operational';

// I-84 items 2 and 6: an HR Administrator assignment may be granted the access approval duty (ceiling only, never a default duty), so
// a change to the System Administrator role, whose holders may not decide it (0132), has an eligible approver, and grants proposed by
// the System Administrator can be checked by HR. It reads the queue it decides through read_users.
const ACCESS_APPROVER_FOR_HR: PermissionKey[] = ['access.read_users.operational', 'access.approve_role_grant.operational'];

// I-84 item 8 (I-73 item 1): sending files whose malware scan could not be completed back to the scan worker. Operational (ids, dates
// and the failure class only), so a default duty of the System Administrator, who runs the platform's integrations (storage/scan-failures.ts).
const SCAN_REQUEUE: PermissionKey = 'attachment.requeue_scan.operational';

// I-84 item 15 (I-74 item 10): HR cancels an employee's approved outdoor-duty or holiday-work request (work-request/service.ts).
const WORK_REQUEST_CANCEL: PermissionKey = 'work_request.cancel.operational';

// FR-004, DF04 (0105): the company's own reference lists; reference/maintenance.ts keeps the lists the code depends on protected.
const REFERENCE_VALUE_ADMIN: PermissionKey[] = ['reference_value.read.operational', 'reference_value.manage.operational'];

const EMPLOYEE_HR: PermissionKey[] = [
  ...EMPLOYEE_OPERATIONAL_READ,
  'employee.create.operational',
  'employee.update.operational',
  'employee.deactivate.operational',
  'employee.export.operational',
  'employee.read_history.operational',
  'employee.import.operational',
  'profile_change.read.operational',
];

const EMPLOYEE_PERSONAL: PermissionKey[] = ['employee.read.personal', 'employee.create.personal', 'employee.update.personal'];
// Employee documents are confidential (DF02): ceiling only, granted per assignment with a purpose.
const EMPLOYEE_DOCUMENTS: PermissionKey[] = ['document.upload.document', 'document.read.document', 'document.verify.document'];

const LEAVE_HR: PermissionKey[] = [
  'leave.read.operational',
  'work_request.read.operational',
  'leave.approve.operational',
  'leave.adjust.operational',
  'leave.accrue.operational',
  // FR-025 opening-balance upload; FR-024 / E06 mapped-policy export (0087).
  'leave.import.operational',
  'leave_policy.manage.operational',
  'leave_policy.activate.operational',
  'leave_policy.export.operational',
  'workflow.manage.operational',
];
const LEAVE_SELF: PermissionKey[] = [
  'leave.submit.operational',
  'leave.read.operational',
  'leave.withdraw.operational',
  'leave.cancel.operational',
  'work_request.submit.operational',
  'work_request.read.operational',
  'work_request.withdraw.operational',
  'attendance.read.operational',
  'confirmation.read.operational',
  // FR-059 self-service change requests (reviewed; never direct changes).
  'profile_change.submit.operational',
  'profile_change.read.operational',
  'attendance.request_correction.operational',
  // FR-023: an employee may ask for their own mobile-app link; an independent reviewer decides.
  'mobile_link.request.operational',
  'mobile_link.read.operational',
];
/**
 * BRD v8.2 H1/BR-053 Employee OWN ESS exception: confidential groups the Employee role holds for its OWN scope
 * only (catalogued by permission.own_ess, migration 0031). The employee's own private profile values and the
 * reasons the employee submitted; reviewer-authored notes stay hidden by the endpoints.
 */
const EMPLOYEE_OWN_ESS: PermissionKey[] = [
  'employee.read.personal',
  'leave.read.reason',
  'attendance.read.reason',
  // H1/BR-053, FR-106, DF06 (v8.2): own documents (upload, released content) and own released receipts.
  'document.upload.document',
  'document.read.document',
  'expense.view_receipt.receipt',
];

const LEAVE_MANAGER: PermissionKey[] = [
  'leave.read.operational',
  'work_request.read.operational',
  'leave.approve.operational',
  'attendance.read.operational',
  'attendance.approve_correction.operational',
  'confirmation.read.operational',
  'confirmation.recommend.operational',
  // C6: a manager recommends on a case's earlier decisions; an operational duty, so it is not ceiling-only.
  'confirmation.history_read.operational',
];
// Salary and increment amounts are confidential: they are in the ceilings of eligible roles only and are
// never default duties (each needs an independently approved assignment grant with a purpose, DF02).
const COMPENSATION_CONFIDENTIAL_HR: PermissionKey[] = [
  'salary.read.salary',
  'salary.manage.salary',
  // FR-029 salary and annual salary exports (migration 0062).
  'salary.export.salary',
  'increment.read.salary',
  'increment.propose.salary',
  'increment.approve.salary',
  'increment.export.salary',
  'increment.read.reason',
  // C4, C6: the financial past is its own grant (0126), so a new scope or manager does not bring it along.
  'salary.history_read.salary',
  'increment.history_read.salary',
];
// DF15/FR-091 cycle management: activation and plan decisions are separate duties, and the service refuses the
// author or proposer (and the employee concerned) for the same record (C4).
const INCREMENT_CYCLE_ADMIN: PermissionKey[] = ['increment_cycle.activate.operational', 'increment_plan.propose.operational', 'increment_plan.approve.operational'];
const INCREMENT_OPERATIONAL_HR: PermissionKey[] = [
  'increment.read.operational',
  'increment_cycle.manage.operational',
  ...INCREMENT_CYCLE_ADMIN,
  // Operational exports (BR-026); confidential increment export is a separate ceiling-only grant.
  'leave.export.operational',
  'attendance.export.operational',
  'confirmation.export.operational',
];
// The increment decision reason is its own confidential group (0032), ceiling-only like the salary values.
const COMPENSATION_CONFIDENTIAL_MANAGER: PermissionKey[] = ['increment.read.salary', 'increment.propose.salary', 'increment.read.reason', 'increment.history_read.salary'];

const TEAM_MANAGER: PermissionKey[] = ['team.list.operational', 'team.read.operational', 'dashboard.read.operational'];
// DF16: the Employment and Reporting and History tabs are operational tabs of the direct team (protected history is masked).
// Their own permission: employee.read_history also opens GET /employees/:id/history, whose full answer (grade, acting
// accounts) is HR's and is not part of these tabs.
const TEAM_HISTORY: PermissionKey = 'team.read_history.operational';
// DF16 "Counts and export": C2 and C3 name no export duty for this role (DF02 "seed only the specified role duties"), so it is a ceiling; who holds it by default is an owner question.
const TEAM_EXPORT: PermissionKey = 'team.export.operational';
const EXPENSE_SELF: PermissionKey[] = ['expense.draft.operational', 'expense.submit.operational', 'expense.withdraw.operational', 'expense.read.operational'];
const EXPENSE_MANAGER: PermissionKey[] = ['expense.read.operational', 'expense.manager_decide.operational'];
// DF02: expense amounts are visible to the claimant, assigned reviewers and payment operators only, so plain
// HR administration manages policies but does not read claims; reading is part of the finance-duty bundle.
const EXPENSE_HR_DEFAULT: PermissionKey[] = ['expense_policy.manage.operational', 'expense_policy.activate.operational'];
// DF03/DF07: financial approval, payment preparation and release run only in an independently approved
// eligible Admin assignment; they are ceilings, never default duties.
const EXPENSE_FINANCE_ADMIN: PermissionKey[] = [
  'expense.read.operational',
  // DF02, DF06: the claimant's justification and the clearance reason of a flagged line are private reasons (0096).
  'expense.read.reason',
  'expense.export.operational',
  'expense.manager_decide.operational',
  'expense.finance_decide.operational',
  'expense.high_value_decide.operational',
  'payment.read.operational',
  'payment.prepare.operational',
  'payment.release.operational',
  // C3 "confirm_outcome ... confirmation actor explicitly assigned"; "export": their own actions (0131).
  'payment.confirm_outcome.operational',
  'payment.reverse.operational',
  'payment.export.operational',
];

const CONFIRMATION_HR: PermissionKey[] = [
  'confirmation.read.operational',
  'confirmation.history_read.operational',
  'confirmation.manage.operational',
  'confirmation.decide.operational',
  'confirmation_policy.manage.operational',
  // DF11 exceptions: proposed and decided by different HR users (C4).
  'confirmation.propose_exception.operational',
  'confirmation.approve_exception.operational',
];
const ATTENDANCE_HR: PermissionKey[] = [
  'attendance.read.operational',
  'attendance.import.operational',
  'attendance.process.operational',
  'attendance.amend.operational',
  'attendance.approve_correction.operational',
  'mobile_link.request.operational',
  'mobile_link.read.operational',
  'mobile_link.approve.operational',
  'attendance_policy.manage.operational',
  'attendance_policy.activate.operational',
];

const SHIFT_AND_CALENDAR: PermissionKey[] = [
  'shift.read.operational',
  'shift.create.operational',
  'shift.update.operational',
  'shift.assign.operational',
  'shift.import.operational',
  'holiday.read.operational',
  'holiday.manage.operational',
  'employee.activate.operational',
];

function operationalReader(code: string, name: string, defaultScope: BaselineRole['defaultScope'], extra: PermissionKey[] = []): BaselineRole {
  const duties: PermissionKey[] = [...EMPLOYEE_OPERATIONAL_READ, 'dashboard.read.operational', ...extra];
  return { code, name, accessClass: 'OTHER', defaultScope, ceiling: duties, defaultDuties: duties };
}

/** The core roles; BASELINE_ROLES below adds every registered module's grants (modules/registry.ts). */
const CORE_ROLES: readonly BaselineRole[] = [
  {
    code: 'SYSTEM_ADMINISTRATOR',
    name: 'System Administrator',
    accessClass: 'ADMIN',
    defaultScope: 'COMPANY',
    ceiling: [
      ...ORG_MASTER_ALL,
      ...REFERENCE_VALUE_ADMIN,
      ...ACCESS_ADMIN,
      ...EMPLOYEE_OPERATIONAL_READ,
      'dashboard.read.operational',
      'audit.read.operational',
      'notification.read_delivery.operational',
      'notification.manage_rules.operational',
      // C6 "publication ... require business owner approval" (0133): an explicit grant, never the rule's author.
      'notification.approve_rules.operational',
      // Section 11.2 "restricted notification/support authority" and "restricted integration administrator": their exports
      // are explicit grants, never default duties (0124).
      'notification.export.operational',
      'biometric.export.operational',
      ...BIOMETRIC_ADMIN,
      // FR-058 / DF08: audit export and retention controls are explicit grants, never default duties.
      ...AUDIT_RETENTION_ADMIN,
      SCAN_REQUEUE,
    ],
    defaultDuties: [...ORG_MASTER_ALL, ...REFERENCE_VALUE_ADMIN, ...ACCESS_ADMIN, ...EMPLOYEE_OPERATIONAL_READ, 'dashboard.read.operational', 'notification.read_delivery.operational', SCAN_REQUEUE],
  },
  {
    code: 'HR_ADMINISTRATOR',
    name: 'HR Administrator',
    accessClass: 'ADMIN',
    defaultScope: 'COMPANY',
    ceiling: [
      ...EMPLOYEE_HR,
      ...EMPLOYEE_PERSONAL,
      ...EMPLOYEE_DOCUMENTS,
      ...SHIFT_AND_CALENDAR,
      ...LEAVE_HR,
      ...ATTENDANCE_HR,
      ...CONFIRMATION_HR,
      ...INCREMENT_OPERATIONAL_HR,
      ...COMPENSATION_CONFIDENTIAL_HR,
      ...EXPENSE_HR_DEFAULT,
      ...EXPENSE_FINANCE_ADMIN,
      DELEGATE_OWN_DECISIONS,
      REROUTE_STRANDED_TASK,
      ...ACCESS_APPROVER_FOR_HR,
      WORK_REQUEST_CANCEL,
      'dashboard.read.operational',
      'expense.view_receipt.receipt',
      // Section 11.2 "owner-approved scoped audience only": the upcoming celebrations report, never a default duty (0124).
      'celebration.export.operational',
      // C6 "publication ... require business owner approval" (0133): an explicit grant, never the rule's author.
      'notification.approve_rules.operational',
      'leave.read.reason',
      // Private reasons (DF02): confidential, never default duties.
      'confirmation.read.reason',
      'attendance.read.reason',
      'org_master.read.operational',
      'reference_value.read.operational',
    ],
    defaultDuties: [
      ...EMPLOYEE_HR,
      ...SHIFT_AND_CALENDAR,
      ...LEAVE_HR,
      ...ATTENDANCE_HR,
      ...CONFIRMATION_HR,
      ...INCREMENT_OPERATIONAL_HR,
      ...EXPENSE_HR_DEFAULT,
      'dashboard.read.operational',
      'org_master.read.operational',
      'reference_value.read.operational',
      // I-84 items 1, 3 and 6 (decided under owner delegation, 6 Nov 2026): operational duties, so default ones. The notification
      // rules' business owner (C6) publishes what a System Administrator authored; never the author (0133).
      DELEGATE_OWN_DECISIONS,
      REROUTE_STRANDED_TASK,
      'notification.approve_rules.operational',
      // I-84 item 15 (0202): cancelling an employee's approved outdoor-duty or holiday-work request, within row scope.
      WORK_REQUEST_CANCEL,
    ],
  },
  {
    code: 'EMPLOYEE',
    name: 'Employee',
    accessClass: 'OTHER',
    defaultScope: 'OWN',
    // DF12 "active company employees who have celebration access" (0124).
    ceiling: ['employee.read.operational', 'dashboard.read.operational', 'celebration.read.operational', ...LEAVE_SELF, ...EXPENSE_SELF, ...EMPLOYEE_OWN_ESS],
    defaultDuties: ['employee.read.operational', 'dashboard.read.operational', 'celebration.read.operational', ...LEAVE_SELF, ...EXPENSE_SELF, ...EMPLOYEE_OWN_ESS],
  },
  {
    code: 'REPORTING_MANAGER',
    name: 'Reporting Manager',
    accessClass: 'MANAGER',
    defaultScope: 'TEAM',
    ceiling: [
      ...EMPLOYEE_OPERATIONAL_READ,
      'employee.read.personal',
      ...LEAVE_MANAGER,
      'leave.read.reason',
      'confirmation.read.reason',
      'attendance.read.reason',
      'increment.read.operational',
      ...COMPENSATION_CONFIDENTIAL_MANAGER,
      ...EXPENSE_MANAGER,
      ...TEAM_MANAGER,
      TEAM_HISTORY,
      TEAM_EXPORT,
      // FR-095, DF16, DF02: salary and identity-document access are "off by default" for this role and need an
      // independently approved grant with a named purpose, so they are ceilings, never default duties.
      'salary.read.salary',
      'salary.history_read.salary',
      'document.read.document',
      DELEGATE_OWN_DECISIONS,
      'expense.view_receipt.receipt',
    ],
    defaultDuties: [...EMPLOYEE_OPERATIONAL_READ, ...LEAVE_MANAGER, 'increment.read.operational', ...EXPENSE_MANAGER, ...TEAM_MANAGER, TEAM_HISTORY, DELEGATE_OWN_DECISIONS],
  },
  operationalReader('PAYROLL_OPERATOR', 'Payroll Operator', 'COMPANY'),
  operationalReader('PAYROLL_APPROVER', 'Payroll Approver', 'ASSIGNED'),
  operationalReader('FINANCE_REVIEWER', 'Finance Reviewer', 'COMPANY'),
  // I-83 items 1 and 2 (decided under owner delegation, 6 Nov 2026): section 5's "Assigned/Organisation". Their ordinary duties
  // are operational counts and states of an organisation scope; a payment batch has no task and final expense decisions run
  // only in an eligible Admin assignment, so an ASSIGNED scope would hold nothing. ASSIGNED stays allowed (C2_RECORD_SCOPES).
  operationalReader('EXPENSE_FINANCE_APPROVER', 'Expense Finance Approver', 'COMPANY'),
  operationalReader('TREASURY_OPERATOR', 'Treasury Operator', 'COMPANY', ['payment.read.operational']),
  operationalReader('TREASURY_APPROVER', 'Treasury Approver', 'COMPANY', ['payment.read.operational']),
  operationalReader('RECRUITER', 'Recruiter', 'COMPANY'),
  operationalReader('APPRAISAL_REVIEWER', 'Appraisal Reviewer', 'ASSIGNED'),
  operationalReader('TRAINING_COORDINATOR', 'Training Coordinator', 'COMPANY'),
  {
    code: 'AUDITOR',
    name: 'Auditor',
    accessClass: 'OTHER',
    defaultScope: 'COMPANY',
    ceiling: [...EMPLOYEE_OPERATIONAL_READ, 'dashboard.read.operational', 'audit.read.operational', 'audit.export.operational'],
    defaultDuties: [...EMPLOYEE_OPERATIONAL_READ, 'dashboard.read.operational', 'audit.read.operational'],
  },
];

/**
 * C2 "Role and record scope" (BR-044; C7): the scope kinds an assignment of each baseline role may hold. An assignment
 * has one kind, so C2's combined entries allow either: Reporting Manager "TEAM and ASSIGNED", Payroll Approver "ASSIGNED
 * and COMPANY filters". "Plus filters" narrows and is not restricted. C2 is silent on any other role, which stays
 * unrestricted. The database holds the same matrix (migration 0098, hrms_role_record_scopes). 0195 (I-83 items 1 and 2) reads
 * section 5's "Assigned/Organisation" for the Expense Finance Approver and the Treasury Approver the same way.
 */
export const C2_RECORD_SCOPES: Readonly<Record<string, readonly ScopeKind[]>> = {
  SYSTEM_ADMINISTRATOR: ['COMPANY'],
  HR_ADMINISTRATOR: ['COMPANY'],
  EMPLOYEE: ['OWN'],
  REPORTING_MANAGER: ['TEAM', 'ASSIGNED'],
  PAYROLL_OPERATOR: ['COMPANY'],
  PAYROLL_APPROVER: ['ASSIGNED', 'COMPANY'],
  FINANCE_REVIEWER: ['COMPANY'],
  EXPENSE_FINANCE_APPROVER: ['ASSIGNED', 'COMPANY'],
  TREASURY_OPERATOR: ['COMPANY'],
  TREASURY_APPROVER: ['ASSIGNED', 'COMPANY'],
  RECRUITER: ['COMPANY'],
  APPRAISAL_REVIEWER: ['ASSIGNED'],
  TRAINING_COORDINATOR: ['COMPANY'],
  AUDITOR: ['COMPANY'],
};

/** Core roles with each registered module's ceiling and default-duty additions merged in (no duplicates). */
export const BASELINE_ROLES: readonly BaselineRole[] = CORE_ROLES.map((role) => {
  const ceiling = [...role.ceiling];
  const defaultDuties = [...role.defaultDuties];
  for (const m of MODULE_REGISTRATIONS) {
    const g = m.roleGrants?.[role.code];
    if (!g) continue;
    for (const k of [...(g.ceiling ?? []), ...(g.defaultDuties ?? [])]) if (!ceiling.includes(k)) ceiling.push(k);
    for (const k of g.defaultDuties ?? []) if (!defaultDuties.includes(k)) defaultDuties.push(k);
  }
  return { ...role, ceiling, defaultDuties };
});

/** DF04 controlled lists seeded per company (category -> code -> label). */
const CORE_REFERENCE_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  EMPLOYMENT_TYPE: {
    PERMANENT: 'Permanent',
    FIXED_TERM: 'Fixed term',
    INTERN: 'Intern',
    CONTRACTOR: 'Contractor',
  },
  EMPLOYEE_STATUS: {
    DRAFT: 'Draft',
    ACTIVE_PROBATION: 'Active (probation)',
    ACTIVE_CONFIRMED: 'Active (confirmed)',
    NOTICE: 'Notice',
    INACTIVE_SEPARATED: 'Separated',
    ARCHIVED: 'Archived',
  },
  // The BRD defines no holiday type catalogue; one neutral type is seeded and companies add their own.
  // The BRD names no document type catalogue; one neutral type is seeded and companies add their own.
  DOCUMENT_TYPE: {
    GENERAL: 'General document',
  },
  HOLIDAY_TYPE: {
    HOLIDAY: 'Holiday',
  },
  ATTENDANCE_STATUS: {
    PRESENT: 'Present',
    HALF_DAY: 'Half day',
    ABSENT: 'Absent',
    EXCEPTION: 'Needs review',
    LEAVE: 'On leave',
    HALF_DAY_LEAVE: 'Half day leave',
    HOLIDAY: 'Holiday',
    WEEKLY_OFF: 'Weekly off',
    // FR-027: a day covered by an approved full-day outdoor duty request.
    ON_DUTY: 'On duty (outdoor)',
  },
};

/** Core controlled lists plus every registered module's lists (a module may add categories, not rename codes). */
export const BASELINE_REFERENCE_VALUES: Readonly<Record<string, Readonly<Record<string, string>>>> = MODULE_REGISTRATIONS.reduce<Record<string, Record<string, string>>>(
  (all, m) => {
    for (const [category, values] of Object.entries(m.referenceValues ?? {})) all[category] = { ...(all[category] ?? {}), ...values };
    return all;
  },
  Object.fromEntries(Object.entries(CORE_REFERENCE_VALUES).map(([k, v]) => [k, { ...v }])),
);

/**
 * DF12 initial in-app notification catalogue. Transaction and security notices are mandatory; celebrations
 * are optional. Placeholders carry operational values only (never reasons, amounts, birth date, year or age).
 * DOCUMENT_READERS are the users who can currently read the subject employee's documents (migration 0028).
 */
export const BASELINE_NOTIFICATIONS: readonly {
  code: string;
  eventType: string;
  selector:
    | 'ASSIGNED_REVIEWER'
    | 'SUBJECT_EMPLOYEE'
    | 'SUBJECT_MANAGER'
    | 'BENEFICIARY_USER'
    | 'COMPANY_CELEBRATION_AUDIENCE'
    | 'FALLBACK_REVIEWERS'
    | 'DOCUMENT_READERS';
  optional: boolean;
  subject: string;
  body: string;
  placeholders: string[];
}[] = [
  {
    code: 'LEAVE_SUBMITTED',
    eventType: 'LEAVE_SUBMITTED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Leave request waiting for you',
    body: 'A {{leaveType}} leave request for {{startDate}} to {{endDate}} ({{units}} days) is waiting for your decision.',
    placeholders: ['leaveType', 'startDate', 'endDate', 'units'],
  },
  {
    code: 'LEAVE_DECIDED',
    eventType: 'LEAVE_DECIDED',
    selector: 'SUBJECT_EMPLOYEE',
    optional: false,
    subject: 'Leave request {{outcome}}',
    body: 'Your {{leaveType}} leave request for {{startDate}} to {{endDate}} was {{outcome}}.',
    placeholders: ['leaveType', 'startDate', 'endDate', 'outcome'],
  },
  {
    code: 'LEAVE_WITHDRAWN',
    eventType: 'LEAVE_WITHDRAWN',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Leave request withdrawn',
    body: 'A {{leaveType}} leave request for {{startDate}} to {{endDate}} was withdrawn.',
    placeholders: ['leaveType', 'startDate', 'endDate'],
  },
  {
    code: 'LEAVE_CANCELLATION_REQUESTED',
    eventType: 'LEAVE_CANCELLATION_REQUESTED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Leave cancellation waiting for you',
    body: 'Cancellation of approved {{leaveType}} leave for {{startDate}} to {{endDate}} ({{units}} days) is waiting for your decision.',
    placeholders: ['leaveType', 'startDate', 'endDate', 'units'],
  },
  {
    code: 'LEAVE_CANCELLATION_DECIDED',
    eventType: 'LEAVE_CANCELLATION_DECIDED',
    selector: 'SUBJECT_EMPLOYEE',
    optional: false,
    subject: 'Leave cancellation {{outcome}}',
    body: 'Your request to cancel {{leaveType}} leave for {{startDate}} to {{endDate}} was {{outcome}}.',
    placeholders: ['leaveType', 'startDate', 'endDate', 'outcome'],
  },
  {
    code: 'WORK_REQUEST_SUBMITTED',
    eventType: 'WORK_REQUEST_SUBMITTED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Work request waiting for you',
    body: 'A request for {{requestKind}} from {{startDate}} to {{endDate}} is waiting for your decision.',
    placeholders: ['requestKind', 'startDate', 'endDate'],
  },
  {
    code: 'WORK_REQUEST_DECIDED',
    eventType: 'WORK_REQUEST_DECIDED',
    selector: 'SUBJECT_EMPLOYEE',
    optional: false,
    subject: 'Work request {{outcome}}',
    body: 'Your request for {{requestKind}} from {{startDate}} to {{endDate}} was {{outcome}}.',
    placeholders: ['requestKind', 'startDate', 'endDate', 'outcome'],
  },
  {
    // DF12 "withdrawn/cancelled": the reviewer of the latest task; kind and dates only, never the purpose.
    code: 'WORK_REQUEST_WITHDRAWN',
    eventType: 'WORK_REQUEST_WITHDRAWN',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Work request withdrawn',
    body: 'A request for {{requestKind}} from {{startDate}} to {{endDate}} was withdrawn.',
    placeholders: ['requestKind', 'startDate', 'endDate'],
  },
  {
    code: 'PROFILE_CHANGE_SUBMITTED',
    eventType: 'PROFILE_CHANGE_SUBMITTED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Profile change waiting for you',
    body: 'A profile change ({{fields}}) for {{employeeName}} ({{employeeCode}}) is waiting for your decision.',
    placeholders: ['fields', 'employeeName', 'employeeCode'],
  },
  {
    code: 'PROFILE_CHANGE_DECIDED',
    eventType: 'PROFILE_CHANGE_DECIDED',
    selector: 'SUBJECT_EMPLOYEE',
    optional: false,
    subject: 'Profile change {{outcome}}',
    body: 'Your profile change ({{fields}}) was {{outcome}}.',
    placeholders: ['fields', 'outcome'],
  },
  {
    code: 'ATTENDANCE_CORRECTION_SUBMITTED',
    eventType: 'ATTENDANCE_CORRECTION_SUBMITTED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Attendance correction waiting for you',
    body: 'An attendance correction for {{employeeName}} on {{workDate}} (to {{requestedStatus}}) is waiting for your decision.',
    placeholders: ['employeeName', 'workDate', 'requestedStatus'],
  },
  {
    code: 'ATTENDANCE_CORRECTION_DECIDED',
    eventType: 'ATTENDANCE_CORRECTION_DECIDED',
    selector: 'SUBJECT_EMPLOYEE',
    optional: false,
    subject: 'Attendance correction {{outcome}}',
    body: 'Your attendance correction for {{workDate}} was {{outcome}}.',
    placeholders: ['workDate', 'outcome'],
  },
  {
    code: 'CONFIRMATION_REVIEW_ASSIGNED',
    eventType: 'CONFIRMATION_REVIEW_ASSIGNED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Confirmation review waiting for you',
    body: 'The confirmation review for {{employeeName}} ({{employeeCode}}) is waiting for your decision.',
    placeholders: ['employeeName', 'employeeCode'],
  },
  {
    code: 'CONFIRMATION_DECIDED',
    eventType: 'CONFIRMATION_DECIDED',
    selector: 'SUBJECT_EMPLOYEE',
    optional: false,
    subject: 'Confirmation review update',
    body: 'Your confirmation review outcome is {{outcome}}. Current due date: {{dueDate}}.',
    placeholders: ['outcome', 'dueDate'],
  },
  {
    code: 'CONFIRMATION_DECIDED_MANAGER',
    eventType: 'CONFIRMATION_DECIDED',
    selector: 'SUBJECT_MANAGER',
    optional: false,
    subject: 'Confirmation review update',
    body: 'The confirmation review for {{employeeName}} ended with {{outcome}}.',
    placeholders: ['employeeName', 'outcome'],
  },
  {
    code: 'ACCESS_GRANT_APPROVED',
    eventType: 'ACCESS_GRANT_APPROVED',
    selector: 'BENEFICIARY_USER',
    optional: false,
    subject: 'Role assignment approved',
    body: 'A {{roleCode}} role assignment was approved for you.',
    placeholders: ['roleCode'],
  },
  {
    // DF12 "role-grant/security change": request kinds and the outcome only.
    code: 'DELEGATION_CHANGED',
    eventType: 'DELEGATION_CHANGED',
    selector: 'BENEFICIARY_USER',
    optional: false,
    subject: 'Delegation {{outcome}}',
    body: 'A delegation of {{requestKinds}} decisions was {{outcome}}.',
    placeholders: ['requestKinds', 'outcome'],
  },
  {
    code: 'APPROVAL_REMINDER',
    eventType: 'APPROVAL_REMINDER',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Decision waiting',
    body: 'A {{requestKind}} request has been waiting for your decision for {{waitingDays}} business days.',
    placeholders: ['requestKind', 'waitingDays'],
  },
  {
    code: 'APPROVAL_ESCALATION',
    eventType: 'APPROVAL_ESCALATION',
    selector: 'FALLBACK_REVIEWERS',
    optional: false,
    subject: 'Decision overdue',
    body: 'A {{requestKind}} request has been waiting {{waitingDays}} business days without a decision; please review its routing.',
    placeholders: ['requestKind', 'waitingDays'],
  },
  {
    code: 'APPROVAL_REROUTED',
    eventType: 'APPROVAL_REROUTED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Decision waiting',
    body: 'A {{requestKind}} request has been routed to you for your decision.',
    placeholders: ['requestKind'],
  },
  {
    code: 'CONFIRMATION_DUE',
    eventType: 'CONFIRMATION_DUE',
    selector: 'SUBJECT_MANAGER',
    optional: false,
    subject: 'Confirmation review due',
    body: 'The confirmation review for {{employeeName}} is due on {{dueDate}}.',
    placeholders: ['employeeName', 'dueDate'],
  },
  {
    code: 'CONFIRMATION_DUE_HR',
    eventType: 'CONFIRMATION_DUE',
    selector: 'FALLBACK_REVIEWERS',
    optional: false,
    subject: 'Confirmation review due',
    body: 'The confirmation review for {{employeeName}} is due on {{dueDate}}.',
    placeholders: ['employeeName', 'dueDate'],
  },
  {
    code: 'CONFIRMATION_OVERDUE',
    eventType: 'CONFIRMATION_OVERDUE',
    selector: 'SUBJECT_MANAGER',
    optional: false,
    subject: 'Confirmation review overdue',
    body: 'The confirmation review for {{employeeName}} was due on {{dueDate}} and is {{days}} days overdue.',
    placeholders: ['employeeName', 'dueDate', 'days'],
  },
  {
    code: 'CONFIRMATION_OVERDUE_HR',
    eventType: 'CONFIRMATION_OVERDUE',
    selector: 'FALLBACK_REVIEWERS',
    optional: false,
    subject: 'Confirmation review overdue',
    body: 'The confirmation review for {{employeeName}} was due on {{dueDate}} and is {{days}} days overdue.',
    placeholders: ['employeeName', 'dueDate', 'days'],
  },
  {
    // DF12 "document expiry": who and when only; the document type, file name and content stay confidential.
    code: 'DOCUMENT_EXPIRING',
    eventType: 'DOCUMENT_EXPIRING',
    selector: 'DOCUMENT_READERS',
    optional: false,
    subject: 'Document expiring',
    body: 'A document on the record of {{employeeName}} ({{employeeCode}}) expires on {{expiresOn}}.',
    placeholders: ['employeeName', 'employeeCode', 'expiresOn'],
  },
  {
    code: 'BIRTHDAY',
    eventType: 'BIRTHDAY',
    selector: 'COMPANY_CELEBRATION_AUDIENCE',
    optional: true,
    subject: 'Birthday',
    body: 'Happy birthday, {{employeeName}} from {{department}}!',
    placeholders: ['employeeName', 'department'],
  },
  {
    code: 'WORK_ANNIVERSARY',
    eventType: 'WORK_ANNIVERSARY',
    selector: 'COMPANY_CELEBRATION_AUDIENCE',
    optional: true,
    subject: 'Work anniversary',
    body: 'Happy work anniversary, {{employeeName}} from {{department}}!',
    placeholders: ['employeeName', 'department'],
  },
];

/** DF05 default attendance policy, seeded DRAFT (company-wide mapping). */
export const BASELINE_ATTENDANCE_POLICY = { code: 'DEFAULT', revision: 1, graceMinutes: 10, presentPercent: '75', halfDayPercent: '50', overtimeEnabled: false } as const;

/**
 * DF02 operational field groups. Anything not listed here is CONFIDENTIAL by default (BR-043), e.g.
 * employee.personal (birth date, private contact).
 */
export const OPERATIONAL_FIELD_GROUPS: readonly { resource: string; fieldGroup: string }[] = [
  // Registered modules' operational groups (modules/registry.ts).
  ...MODULE_REGISTRATIONS.flatMap((m) => m.operationalFieldGroups ?? []),
  { resource: 'employee', fieldGroup: 'operational' },
  { resource: 'org_master', fieldGroup: 'operational' },
  { resource: 'reference_value', fieldGroup: 'operational' },
  { resource: 'access', fieldGroup: 'operational' },
  { resource: 'audit', fieldGroup: 'operational' },
  { resource: 'retention', fieldGroup: 'operational' },
  { resource: 'shift', fieldGroup: 'operational' },
  { resource: 'holiday', fieldGroup: 'operational' },
  // Leave type/date/day-count/status are operational (DF02); leave.reason stays confidential.
  { resource: 'leave', fieldGroup: 'operational' },
  { resource: 'leave_policy', fieldGroup: 'operational' },
  { resource: 'work_request', fieldGroup: 'operational' },
  { resource: 'profile_change', fieldGroup: 'operational' },
  { resource: 'mobile_link', fieldGroup: 'operational' },
  { resource: 'workflow', fieldGroup: 'operational' },
  // I-84 item 8: a stored file's scan state, attempts and dates, never its name, type, owner or content.
  { resource: 'attachment', fieldGroup: 'operational' },
  { resource: 'attendance', fieldGroup: 'operational' },
  { resource: 'attendance_policy', fieldGroup: 'operational' },
  { resource: 'confirmation', fieldGroup: 'operational' },
  { resource: 'confirmation_policy', fieldGroup: 'operational' },
  { resource: 'notification', fieldGroup: 'operational' },
  // DF12: a celebration shows name, work department and event type only.
  { resource: 'celebration', fieldGroup: 'operational' },
  { resource: 'increment', fieldGroup: 'operational' },
  { resource: 'increment_cycle', fieldGroup: 'operational' },
  // DF15 plan assignment and review dates (the reasons stay in the confidential increment reason group).
  { resource: 'increment_plan', fieldGroup: 'operational' },
  // DF02: expense category/date/claimed and approved amounts/state are operational; receipts stay confidential.
  { resource: 'expense', fieldGroup: 'operational' },
  { resource: 'expense_policy', fieldGroup: 'operational' },
  { resource: 'payment', fieldGroup: 'operational' },
  { resource: 'team', fieldGroup: 'operational' },
  { resource: 'biometric', fieldGroup: 'operational' },
  { resource: 'dashboard', fieldGroup: 'operational' },
];

/** DF06 initial expense categories and limits (INR). Configured review thresholds, not entitlements. */
export const BASELINE_EXPENSE_CATEGORIES: readonly { code: string; name: string; limitBasis: 'PER_DAY' | 'PER_NIGHT' | 'PER_LINE'; limit: string }[] = [
  { code: 'TRAVEL', name: 'Business travel', limitBasis: 'PER_LINE', limit: '5000' },
  { code: 'ACCOMMODATION', name: 'Accommodation', limitBasis: 'PER_NIGHT', limit: '5000' },
  { code: 'MEALS', name: 'Meals', limitBasis: 'PER_DAY', limit: '1000' },
  { code: 'OFFICE_SUPPLIES', name: 'Office supplies', limitBasis: 'PER_LINE', limit: '2000' },
  { code: 'OTHER', name: 'Other business expense', limitBasis: 'PER_LINE', limit: '1000' },
];

/**
 * DF05 initial leave catalogue. Seeded as DRAFT policies: they are selected target values, not statutory or
 * contractual facts, and must be validated and independently activated before use (F4).
 */
export const BASELINE_LEAVE_TYPES: readonly { code: string; name: string; paid: boolean }[] = [
  { code: 'ANNUAL', name: 'Annual paid leave', paid: true },
  { code: 'SICK', name: 'Sick leave', paid: true },
  { code: 'CASUAL', name: 'Casual leave', paid: true },
  { code: 'UNPAID', name: 'Unpaid time off', paid: false },
];

export const BASELINE_LEAVE_POLICIES: readonly {
  leaveType: string;
  revision: number;
  eligibility: string;
  employmentTypes: string[];
  annualEntitlement: string;
  minServiceDays: number;
}[] = [
  { leaveType: 'ANNUAL', revision: 1, eligibility: 'PERMANENT_FIXED_TERM', employmentTypes: ['PERMANENT', 'FIXED_TERM'], annualEntitlement: '24', minServiceDays: 90 },
  { leaveType: 'ANNUAL', revision: 2, eligibility: 'INTERN', employmentTypes: ['INTERN'], annualEntitlement: '12', minServiceDays: 90 },
  { leaveType: 'SICK', revision: 1, eligibility: 'PERMANENT_FIXED_TERM_INTERN', employmentTypes: ['PERMANENT', 'FIXED_TERM', 'INTERN'], annualEntitlement: '6', minServiceDays: 0 },
  { leaveType: 'CASUAL', revision: 1, eligibility: 'PERMANENT_FIXED_TERM_INTERN', employmentTypes: ['PERMANENT', 'FIXED_TERM', 'INTERN'], annualEntitlement: '6', minServiceDays: 0 },
  { leaveType: 'UNPAID', revision: 1, eligibility: 'ALL', employmentTypes: ['PERMANENT', 'FIXED_TERM', 'INTERN', 'CONTRACTOR'], annualEntitlement: '0', minServiceDays: 0 },
];

export function parsePermissionKey(key: PermissionKey): { resource: string; action: string; fieldGroup: string } {
  const [resource, action, fieldGroup] = key.split('.');
  if (!resource || !action || !fieldGroup) throw new Error(`Invalid permission key ${key}`);
  return { resource, action, fieldGroup };
}
