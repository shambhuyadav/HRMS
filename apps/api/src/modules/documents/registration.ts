// Company policy documents and bulk document mapping (FR-010; DF02; DF09; FR-106). Migration 0054_company_documents.
//
// DF02: an OPERATIONAL policy is readable by every employee of its company, so every baseline role reads operational
// policies by default. A CONFIDENTIAL policy is a confidential group: readable and managed only through an
// independently approved grant of an eligible Admin/Manager assignment (ceiling only). The HR Administrator's
// documented remit includes documents ("employee records, documents, organisation data"), so publishing operational
// policies is a default HR duty. Bulk document mapping creates employee documents and therefore needs the existing
// confidential document.upload.document grant (no new permission).
//
// DF12 "document expiry" for policies: a version's expiry date raises one POLICY_EXPIRING notice (documents/expiry.ts,
// run daily with the other reminders while this module is active) to the users who can currently manage that policy
// (POLICY_MANAGERS, migration 0060): company_policy.manage for its classification from an unrestricted company scope,
// so a confidential policy's code and title only ever reach holders of the confidential group.
import type { PermissionKey } from '../access/baseline.js';
import type { ModuleRegistration } from '../registry-types.js';

const READ: PermissionKey = 'company_policy.read.operational';
const reader = { defaultDuties: [READ] };

export const documentsRegistration: ModuleRegistration = {
  key: 'documents',
  active: true,
  roleGrants: {
    HR_ADMINISTRATOR: {
      defaultDuties: [READ, 'company_policy.manage.operational'],
      ceiling: ['company_policy.read.confidential', 'company_policy.manage.confidential'],
    },
    REPORTING_MANAGER: { defaultDuties: [READ], ceiling: ['company_policy.read.confidential'] },
    SYSTEM_ADMINISTRATOR: reader,
    EMPLOYEE: reader,
    PAYROLL_OPERATOR: reader,
    PAYROLL_APPROVER: reader,
    FINANCE_REVIEWER: reader,
    EXPENSE_FINANCE_APPROVER: reader,
    TREASURY_OPERATOR: reader,
    TREASURY_APPROVER: reader,
    RECRUITER: reader,
    APPRAISAL_REVIEWER: reader,
    TRAINING_COORDINATOR: reader,
    AUDITOR: reader,
  },
  operationalFieldGroups: [{ resource: 'company_policy', fieldGroup: 'operational' }],
  notifications: [
    {
      // Which policy version expires and when; never the file name or content.
      code: 'POLICY_EXPIRING',
      eventType: 'POLICY_EXPIRING',
      selector: 'POLICY_MANAGERS',
      optional: false,
      subject: 'Company policy expiring',
      body: 'Version {{versionNumber}} of the company policy {{policyCode}} ({{policyTitle}}) expires on {{expiresOn}}.',
      placeholders: ['versionNumber', 'policyCode', 'policyTitle', 'expiresOn'],
    },
  ],
};
