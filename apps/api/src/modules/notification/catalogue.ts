// In-app notices for the events DF12 and H7 require that the outbox used to consume without effect (FR-079, FR-084,
// FR-088; BR-033; I-60), as plain data (no runtime imports) in the shape of BASELINE_NOTIFICATIONS so provisioning can add
// them; migration 0092 adds the same entries to companies that already exist. All are mandatory: DF12 lets only
// celebrations and the email digest be opted out of. Placeholders are identifiers, dates and states only, never amounts,
// percentages, reasons, purposes, merchants, bank values, evidence keys or file names (DF12, CR-007, H7).
export const EVENT_NOTICE_CATALOGUE: readonly {
  code: string;
  eventType: string;
  selector: 'ASSIGNED_REVIEWER' | 'SUBJECT_EMPLOYEE' | 'BENEFICIARY_USER' | 'PROPOSER_OR_MANAGER' | 'BIOMETRIC_SUPPORT' | 'GRANT_APPROVERS';
  optional: boolean;
  subject: string;
  body: string;
  placeholders: string[];
}[] = [
  {
    // BR-033 "Notify assigned reviewer for pending decision": the manager step a submission starts.
    code: 'EXPENSE_SUBMITTED',
    eventType: 'EXPENSE_SUBMITTED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Expense claim waiting for you',
    body: 'An expense claim from {{employeeName}} ({{employeeCode}}), submitted on {{submittedDate}}, is waiting for your {{step}}.',
    placeholders: ['employeeName', 'employeeCode', 'submittedDate', 'step'],
  },
  {
    // DF12 "assigned": each later reviewer step (financial review, high-value approval).
    code: 'EXPENSE_ASSIGNED',
    eventType: 'EXPENSE_ASSIGNED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Expense claim waiting for you',
    body: 'An expense claim from {{employeeName}} ({{employeeCode}}), submitted on {{submittedDate}}, is waiting for your {{step}}.',
    placeholders: ['employeeName', 'employeeCode', 'submittedDate', 'step'],
  },
  {
    // DF12 "expense final decision"; BR-033 "claimant for outcome". A return is the claimant's to act on.
    code: 'EXPENSE_DECIDED',
    eventType: 'EXPENSE_DECIDED',
    selector: 'SUBJECT_EMPLOYEE',
    optional: false,
    subject: 'Expense claim {{outcome}}',
    body: 'Your expense claim submitted on {{submittedDate}} was {{outcome}}.',
    placeholders: ['submittedDate', 'outcome'],
  },
  {
    // DF12 "withdrawn/cancelled": the reviewer of the claim's latest task, as for leave and work requests.
    code: 'EXPENSE_WITHDRAWN',
    eventType: 'EXPENSE_WITHDRAWN',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Expense claim withdrawn',
    body: 'The expense claim from {{employeeName}} ({{employeeCode}}), submitted on {{submittedDate}}, was withdrawn.',
    placeholders: ['employeeName', 'employeeCode', 'submittedDate'],
  },
  {
    // DF12 "payment operational status" (DF07): a recorded confirmation, failure or reversal and the status it leaves.
    code: 'EXPENSE_PAYMENT_STATUS',
    eventType: 'EXPENSE_PAYMENT_STATUS',
    selector: 'SUBJECT_EMPLOYEE',
    optional: false,
    subject: 'Expense payment {{paymentEvent}}',
    body: 'The payment of your expense claim submitted on {{submittedDate}} was {{paymentEvent}}. Its payment status is now {{paymentStatus}}.',
    placeholders: ['submittedDate', 'paymentEvent', 'paymentStatus'],
  },
  {
    // BR-033: a proposal waiting for the independent decision, whether from the cycle or off-cycle (DF15).
    code: 'INCREMENT_PROPOSED',
    eventType: 'INCREMENT_PROPOSED',
    selector: 'ASSIGNED_REVIEWER',
    optional: false,
    subject: 'Increment proposal waiting for you',
    body: 'An increment proposal for {{employeeName}} ({{employeeCode}}) is waiting for your decision.',
    placeholders: ['employeeName', 'employeeCode'],
  },
  {
    // DF12 "increment review ... decision"; CR-007: the outcome state only, never an amount or percentage.
    code: 'INCREMENT_DECIDED',
    eventType: 'INCREMENT_DECIDED',
    selector: 'PROPOSER_OR_MANAGER',
    optional: false,
    subject: 'Increment review {{outcome}}',
    body: 'The increment review for {{employeeName}} ({{employeeCode}}) was decided: {{outcome}}.',
    placeholders: ['employeeName', 'employeeCode', 'outcome'],
  },
  {
    // FR-084, FR-088, DF09 "show failure and retain checkpoint"; no provider detail or credential reference.
    code: 'BIOMETRIC_SYNC_FAILED',
    eventType: 'BIOMETRIC_SYNC_FAILED',
    selector: 'BIOMETRIC_SUPPORT',
    optional: false,
    subject: 'Biometric sync {{runState}}',
    body: 'The biometric sync of profile {{profileCode}} ended {{runState}} ({{failureCode}}); the checkpoint stays at the last committed page.',
    placeholders: ['profileCode', 'runState', 'failureCode'],
  },
  {
    // DF12 "role-grant/security change": a proposal waiting for an independent approver.
    code: 'ACCESS_GRANT_PROPOSED',
    eventType: 'ACCESS_GRANT_PROPOSED',
    selector: 'GRANT_APPROVERS',
    optional: false,
    subject: 'Role assignment waiting for approval',
    body: 'A {{roleCode}} role assignment is waiting for your approval.',
    placeholders: ['roleCode'],
  },
  {
    // DF12 "role-grant/security change": the outcome only, never the recorded reason.
    code: 'ACCESS_GRANT_ENDED',
    eventType: 'ACCESS_GRANT_ENDED',
    selector: 'BENEFICIARY_USER',
    optional: false,
    subject: 'Role assignment {{outcome}}',
    body: 'A {{roleCode}} role assignment for you was {{outcome}}.',
    placeholders: ['roleCode', 'outcome'],
  },
  {
    // DF12 "role-grant/security change": the role only, never the permission or the reason (access/role-permissions.ts, 0132).
    code: 'ROLE_PERMISSION_CHANGE_PROPOSED',
    eventType: 'ROLE_PERMISSION_CHANGE_PROPOSED',
    selector: 'GRANT_APPROVERS',
    optional: false,
    subject: 'Role permission change waiting for approval',
    body: 'A permission change to the {{roleCode}} role is waiting for your approval.',
    placeholders: ['roleCode'],
  },
  {
    code: 'ROLE_PERMISSION_CHANGE_DECIDED',
    eventType: 'ROLE_PERMISSION_CHANGE_DECIDED',
    selector: 'BENEFICIARY_USER',
    optional: false,
    subject: 'Role permission change {{outcome}}',
    body: 'The permission change you proposed to the {{roleCode}} role was {{outcome}}.',
    placeholders: ['roleCode', 'outcome'],
  },
  {
    // H7 "bank change cutoff"; H4 "Bank revisions after cutoff warn employee". Period and dates only, never a bank value.
    code: 'BANK_CHANGE_CUTOFF',
    eventType: 'BANK_CHANGE_CUTOFF',
    selector: 'SUBJECT_EMPLOYEE',
    optional: false,
    subject: 'Bank change after payroll cutoff',
    body: 'Your change of bank details effective {{effectiveDate}} falls after the input cutoff ({{inputCutoff}}) of payroll period {{periodCode}}.',
    placeholders: ['effectiveDate', 'inputCutoff', 'periodCode'],
  },
  {
    // H7 "scan/request conflict" (the request conflict is SENSITIVE_CHANGE_OUTCOME): a file the background scan quarantined.
    code: 'FILE_QUARANTINED',
    eventType: 'FILE_QUARANTINED',
    selector: 'BENEFICIARY_USER',
    optional: false,
    subject: 'Uploaded file failed the malware scan',
    body: 'A file you uploaded on {{uploadedDate}} failed the malware scan and cannot be used; please upload a replacement.',
    placeholders: ['uploadedDate'],
  },
  {
    // H7 "scan"; I-84 item 8: the scanner could not check a file after every attempt. Not a finding: the file waits unusable until it
    // is requeued and released, or replaced. Existing companies get it from migration 0201.
    code: 'FILE_SCAN_FAILED',
    eventType: 'FILE_SCAN_FAILED',
    selector: 'BENEFICIARY_USER',
    optional: false,
    subject: 'Uploaded file could not be checked',
    body: 'A file you uploaded on {{uploadedDate}} could not be checked for malware yet, so it cannot be used. You may upload it again; it stays blocked until the check completes.',
    placeholders: ['uploadedDate'],
  },
];

/**
 * Topics the outbox consumes with no notice on purpose, each with its reason (FR-061: an event that stays dropped says
 * why). DF12 and H7 name no notice for them, and FR-061 leaves recipients to the owner, so inventing one would be policy.
 * The topic guard in events-mapping.api.test.ts fails on any enqueued topic that has neither a describer nor an entry here.
 */
export const TOPICS_WITHOUT_NOTICE: Readonly<Record<string, string>> = {
  'employee.created': 'Master-data change: DF12 and H7 name no notice and no recipient',
  'employee.updated': 'Master-data change: DF12 and H7 name no notice and no recipient',
  'employee.activated': 'Master-data change: DF12 and H7 name no notice and no recipient',
  'employee.status_changed': 'Master-data change: DF12 and H7 name no notice and no recipient',
  'employee.manager_changed': 'Master-data change: DF12 and H7 name no notice and no recipient',
  'employee.assignment_changed': 'Master-data change: DF12 and H7 name no notice and no recipient',
  'exit.separated': 'The employee was told by exit.outcome; DF12 and H7 name no separate separation notice or recipient',
};
