// Module registration contract. A business module declares, as plain data, what it adds to the baseline:
// role grants, operational field groups, approval workflows, notification templates and reference values.
// The access baseline, company provisioning and the app read these declarations, so a new module does not
// edit those shared files. Data-only on purpose: registration files must not import runtime modules.
import type { PermissionKey } from './access/baseline.js';

export interface ModuleRoleGrants {
  /** Added to the role ceiling (role_permission ALLOW). */
  ceiling?: PermissionKey[];
  /**
   * Added to the role's default duties (also added to its ceiling). Never confidential groups (DF02), except the
   * Employee role's own-ESS groups (permission.own_ess, H1/BR-053), which apply only to the employee's own record.
   */
  defaultDuties?: PermissionKey[];
}

export interface ModuleWorkflowStep {
  sequence: number;
  permission: PermissionKey;
  selectionRule: 'DIRECT_MANAGER' | 'HR_FALLBACK_LIST';
  conditionCode?: string;
}

export interface ModuleWorkflow {
  /** Transaction kind (registered by the module's own migration). */
  kind: string;
  steps: ModuleWorkflowStep[];
}

export interface ModuleNotification {
  code: string;
  eventType: string;
  /** POLICY_MANAGERS: the users who can currently manage the company policy the notice is about (migration 0060). */
  selector: 'ASSIGNED_REVIEWER' | 'SUBJECT_EMPLOYEE' | 'SUBJECT_MANAGER' | 'BENEFICIARY_USER' | 'FALLBACK_REVIEWERS' | 'POLICY_MANAGERS';
  optional: boolean;
  subject: string;
  body: string;
  placeholders: string[];
}

/** An H3 My ESS tab served by the module (FR-103). */
export interface ModuleEssTab {
  /** H3 tab id, e.g. TN13. */
  tab: string;
  /** Available when the Employee OWN assignment holds any of these. */
  permissions: PermissionKey[];
  /** Own-record endpoints; {employeeId} is replaced with the caller's own employee. */
  links: { rel: string; method: 'GET' | 'POST' | 'PUT'; href: string }[];
  /** Company configuration the tab needs before it serves anything; without it the tab says NOT_CONFIGURED in plain words (ess/service.ts). */
  requiresConfiguration?: 'TAX_RULE_PACK';
}

export interface ModuleRegistration {
  key: string;
  /**
   * false while the module is being built (its migration still a .draft.sql): it is then active only in runs whose
   * HRMS_DRAFT_MODULES names its key (never in production), so it cannot affect anyone else's runs. Set it to true
   * in the same change that renames the migration to .sql.
   */
  active: boolean;
  /** Grants keyed by baseline role code (e.g. RECRUITER, HR_ADMINISTRATOR). */
  roleGrants?: Record<string, ModuleRoleGrants>;
  operationalFieldGroups?: { resource: string; fieldGroup: string }[];
  workflows?: ModuleWorkflow[];
  notifications?: ModuleNotification[];
  /** DF04 controlled lists seeded per company (category -> code -> label). */
  referenceValues?: Record<string, Record<string, string>>;
  /**
   * The module's lists (of `referenceValues`) served as form choices by GET /v1/reference-values, each under the
   * permission of the form that offers it (category -> permission). A list not named here is seeded but not served
   * there; a module that is not active serves none.
   */
  referenceReaders?: Record<string, PermissionKey>;
  /**
   * Every transaction kind the module's migration adds, classified for the F2 "my pending requests" metric: an
   * employee's own request lists the non-terminal states in which it waits for someone else (DRAFT and APPROVED
   * excepted); a process about an employee or a company record (not the employee's own request) lists null.
   */
  transactionKinds?: Record<string, readonly string[] | null>;
  /** The My ESS tabs this module serves (FR-103); a tab of an inactive module shows as unavailable. */
  essTabs?: ModuleEssTab[];
}
