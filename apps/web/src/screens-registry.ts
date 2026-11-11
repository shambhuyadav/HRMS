import type { ComponentType } from 'react';
import { ADMIN_SCREENS } from './pages/admin';
import { APPRAISAL_ESS_PANELS, APPRAISAL_SCREENS, APPRAISAL_TASK_QUEUES } from './pages/appraisal';
import { ASSETS_ESS_PANELS, ASSETS_SCREENS, ASSETS_TASK_QUEUES } from './pages/assets';
import { ATTENDANCE_ADMIN_SCREENS } from './pages/attendance-admin';
import { ATTENDANCE_CONTROL_SCREENS } from './pages/attendance-control';
import { BIOMETRIC_SCREENS } from './pages/biometric';
import { BULK_JOBS_SCREENS } from './pages/bulk-jobs';
import { CALENDARS_SCREENS } from './pages/calendars';
import { CONFIRMATION_SCREENS } from './pages/confirmation';
import { DELEGATION_SCREENS } from './pages/delegations';
import { DOCUMENTS_ESS_PANELS, DOCUMENTS_SCREENS, DOCUMENTS_TASK_QUEUES } from './pages/documents';
import { EMPLOYEE_SCREENS } from './pages/employee';
import { MANAGER_CHANGE_SCREENS } from './pages/manager-change';
import { ANNOUNCEMENT_SCREENS } from './pages/announcements';
import { EMPLOYEE_HISTORY_SCREENS } from './pages/employee-history';
import { EXIT_FINANCE_SCREENS, EXIT_FINANCE_TASK_QUEUES } from './pages/exit-finance';
import { EXPENSE_ADMIN_SCREENS } from './pages/expense-admin';
import { HOME_SCREENS } from './pages/home';
import { HIRING_PIPELINE_ESS_PANELS, HIRING_PIPELINE_SCREENS, HIRING_PIPELINE_TASK_QUEUES } from './pages/hiring-pipeline';
import { HIRING_REQUISITIONS_ESS_PANELS, HIRING_REQUISITIONS_SCREENS, HIRING_REQUISITIONS_TASK_QUEUES } from './pages/hiring-requisitions';
import { LEAVE_ADMIN_SCREENS } from './pages/leave-admin';
import { LIFECYCLE_DOCUMENTS_ESS_PANELS, LIFECYCLE_DOCUMENTS_SCREENS, LIFECYCLE_DOCUMENTS_TASK_QUEUES } from './pages/lifecycle-documents';
import { LIFECYCLE_PROCESSES_ESS_PANELS, LIFECYCLE_PROCESSES_SCREENS, LIFECYCLE_PROCESSES_TASK_QUEUES } from './pages/lifecycle-processes';
import { NOTIFICATION_SCREENS } from './pages/notifications';
import { ORG_SCREENS } from './pages/org';
import { ORG_ADMIN_SCREENS } from './pages/org-admin';
import { PAYROLL_ESS_PANELS, PAYROLL_SCREENS, PAYROLL_TASK_QUEUES } from './pages/payroll';
import { GRADE_STRUCTURE_SCREENS } from './pages/grade-structures';
import { PAYROLL_ADJUSTMENT_SCREENS, PAYROLL_ADJUSTMENT_TASK_QUEUES } from './pages/payroll-adjustments';
import { PAYROLL_EXTRAS_SCREENS } from './pages/payroll-extras';
import { REPORTING_SCREENS } from './pages/reporting';
import { ROLE_PERMISSION_SCREENS } from './pages/role-permissions';
import { SALARY_SCREENS } from './pages/salary';
import { SEND_MAIL_SCREENS } from './pages/send-mail';
import { SETTLEMENT_SETTINGS_SCREENS } from './pages/settlement-settings';
import { STATUTORY_PACK_SCREENS } from './pages/statutory-packs';
import { STATUTORY_SETTINGS_SCREENS } from './pages/statutory-settings';
import { STATUTORY_FILE_SCREENS } from './pages/statutory-files';
import { TAX_ESS_PANELS, TAX_SCREENS, TAX_TASK_QUEUES } from './pages/tax-declarations';
import { TIMESHEET_ESS_PANELS, TIMESHEET_SCREENS, TIMESHEET_TASK_QUEUES } from './pages/timesheet';
import { TRAINING_ESS_PANELS, TRAINING_SCREENS, TRAINING_TASK_QUEUES } from './pages/training';
import type { EssPanel, ScreenRoute } from './screens';

/** A decision queue a page module offers; the component renders its own section and checks its own keys. */
export interface TaskQueue {
  permission: string;
  title: string;
  component: ComponentType;
}

/**
 * Screens of the wave-2 page modules. App.tsx routes every one of them and lists the `nav` screens in the menu,
 * grouped by module; every screen re-checks its own permissions, and the server re-checks every call.
 */
export const MODULE_SCREENS: readonly ScreenRoute[] = [
  // FR-097, DF17: the records behind a dashboard figure, reached from the figure.
  ...HOME_SCREENS,
  // FR-080: dated confirmation policies; cases and their reviews stay on the core /confirmations page.
  ...CONFIRMATION_SCREENS,
  ...HIRING_REQUISITIONS_SCREENS,
  ...HIRING_PIPELINE_SCREENS,
  ...LIFECYCLE_PROCESSES_SCREENS,
  ...LIFECYCLE_DOCUMENTS_SCREENS,
  ...SETTLEMENT_SETTINGS_SCREENS,
  // I-85: the statutory rule packs (gratuity, PF, ESIC, professional tax): read, validated, activated by another person, retired.
  ...STATUTORY_PACK_SCREENS,
  // I-85, FR-039: the dated settings the evaluator reads (work location states, PF options).
  ...STATUTORY_SETTINGS_SCREENS,
  ...APPRAISAL_SCREENS,
  ...TIMESHEET_SCREENS,
  ...ASSETS_SCREENS,
  ...TRAINING_SCREENS,
  ...PAYROLL_SCREENS,
  // FR-035, FR-100 later-period cases, calculated by the server and paid by a later payroll (I-79), and their valuation policy.
  ...PAYROLL_ADJUSTMENT_SCREENS,
  // FR-028/029 grade salary structures and CTC categories (I-80).
  ...GRADE_STRUCTURE_SCREENS,
  // CL-074 to CL-119 (batch R3): challans, perquisites and past salary, medical claims, provisions, GL mapping and JV, EDOC export.
  ...PAYROLL_EXTRAS_SCREENS,
  ...STATUTORY_FILE_SCREENS,
  ...TAX_SCREENS,
  // FR-029 salary master: no My ESS panel and no decision queue (the upload records initial salaries without a separate approval).
  ...SALARY_SCREENS,
  ...DOCUMENTS_SCREENS,
  ...ADMIN_SCREENS,
  // FR-085 delivery log: the user's own preferences are a panel on the inbox.
  ...NOTIFICATION_SCREENS,
  // CL-041 (0282): HR sends one message to chosen employees by email (send-mail.tsx).
  ...SEND_MAIL_SCREENS,
  // §5 user accounts and links; FR-004 reference values: no My ESS panel and no decision queue.
  ...ORG_ADMIN_SCREENS,
  // FR-003, FR-068 delegation: decision tasks show their "delegated" mark in the inbox and each module's queue.
  ...DELEGATION_SCREENS,
  // FR-066, FR-067: role permission changes, proposed and independently decided.
  ...ROLE_PERMISSION_SCREENS,
  ...BULK_JOBS_SCREENS,
  // FR-024, FR-025 leave administration and FR-021 attendance control: no My ESS panel and no decision queue of their own.
  ...LEAVE_ADMIN_SCREENS,
  ...ATTENDANCE_CONTROL_SCREENS,
  // FR-019 punch imports and FR-020 attendance policies: the same.
  ...ATTENDANCE_ADMIN_SCREENS,
  // FR-005 holidays, shifts and weekly-off patterns: the same.
  ...CALENDARS_SCREENS,
  // FR-086 to FR-088 biometric profiles, mapping and sync monitor: the same.
  ...BIOMETRIC_SCREENS,
  // FR-089 the employee timeline: the same.
  ...EMPLOYEE_HISTORY_SCREENS,
  // FR-004 organisation masters; FR-006, FR-008 one employee's record and changes: the same.
  ...ORG_SCREENS,
  ...EMPLOYEE_SCREENS,
  // CL-020: several people to one new manager (manager-change.tsx); the file route is the employee update import.
  ...MANAGER_CHANGE_SCREENS,
  // CL-021, CL-022: company events and ticker messages kept by HR; the dashboard shows them (announcements.tsx).
  ...ANNOUNCEMENT_SCREENS,
  // FR-078 expense policies: the same; claims and their decisions stay on the core /expenses and /tasks pages.
  ...EXPENSE_ADMIN_SCREENS,
  // FR-034 loan early settlement and the employee's documents received in-app (I-81).
  ...EXIT_FINANCE_SCREENS,
  // FR-038 salary progression chart and the dated reporting settings (I-83): no My ESS panel and no decision queue.
  ...REPORTING_SCREENS,
];

const ALL_ESS_PANELS: readonly EssPanel[] = [
  ...HIRING_REQUISITIONS_ESS_PANELS,
  ...HIRING_PIPELINE_ESS_PANELS,
  ...LIFECYCLE_PROCESSES_ESS_PANELS,
  ...LIFECYCLE_DOCUMENTS_ESS_PANELS,
  ...APPRAISAL_ESS_PANELS,
  ...TIMESHEET_ESS_PANELS,
  ...ASSETS_ESS_PANELS,
  ...TRAINING_ESS_PANELS,
  ...PAYROLL_ESS_PANELS,
  ...TAX_ESS_PANELS,
  ...DOCUMENTS_ESS_PANELS,
];

/**
 * My ESS panels by H3 tab id (TN06 payslips, TN08 tax declaration, TN09 investment proof, TN13 timesheet, TN15 loans, TN16 assets, TN17 training, TN18 appraisal), shown inside the hub when
 * the API marks the tab AVAILABLE. Panels without an H3 id (the employee's own resignation and processes) are served on
 * their own /me screens instead.
 */
export const ESS_PANELS_BY_TAB: Readonly<Record<string, ComponentType>> = Object.fromEntries(
  ALL_ESS_PANELS.filter((p) => /^TN\d{2}$/.test(p.tabId)).map((p) => [p.tabId, p.component]),
);

/** Decision queues of the page modules, shown in the decision inbox after the core queues. */
export const MODULE_TASK_QUEUES: readonly TaskQueue[] = [
  ...HIRING_REQUISITIONS_TASK_QUEUES,
  ...HIRING_PIPELINE_TASK_QUEUES,
  ...LIFECYCLE_PROCESSES_TASK_QUEUES,
  ...LIFECYCLE_DOCUMENTS_TASK_QUEUES,
  ...APPRAISAL_TASK_QUEUES,
  ...TIMESHEET_TASK_QUEUES,
  ...ASSETS_TASK_QUEUES,
  ...TRAINING_TASK_QUEUES,
  ...PAYROLL_TASK_QUEUES,
  ...PAYROLL_ADJUSTMENT_TASK_QUEUES,
  ...TAX_TASK_QUEUES,
  ...DOCUMENTS_TASK_QUEUES,
  ...EXIT_FINANCE_TASK_QUEUES,
];
