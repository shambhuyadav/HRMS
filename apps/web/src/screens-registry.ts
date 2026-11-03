import type { ComponentType } from 'react';
import { ADMIN_SCREENS } from './pages/admin';
import { APPRAISAL_ESS_PANELS, APPRAISAL_SCREENS, APPRAISAL_TASK_QUEUES } from './pages/appraisal';
import { ASSETS_ESS_PANELS, ASSETS_SCREENS, ASSETS_TASK_QUEUES } from './pages/assets';
import { ATTENDANCE_ADMIN_SCREENS } from './pages/attendance-admin';
import { ATTENDANCE_CONTROL_SCREENS } from './pages/attendance-control';
import { BULK_JOBS_SCREENS } from './pages/bulk-jobs';
import { CALENDARS_SCREENS } from './pages/calendars';
import { CONFIRMATION_SCREENS } from './pages/confirmation';
import { DELEGATION_SCREENS } from './pages/delegations';
import { DOCUMENTS_ESS_PANELS, DOCUMENTS_SCREENS, DOCUMENTS_TASK_QUEUES } from './pages/documents';
import { EXPENSE_ADMIN_SCREENS } from './pages/expense-admin';
import { HOME_SCREENS } from './pages/home';
import { HIRING_PIPELINE_ESS_PANELS, HIRING_PIPELINE_SCREENS, HIRING_PIPELINE_TASK_QUEUES } from './pages/hiring-pipeline';
import { HIRING_REQUISITIONS_ESS_PANELS, HIRING_REQUISITIONS_SCREENS, HIRING_REQUISITIONS_TASK_QUEUES } from './pages/hiring-requisitions';
import { LEAVE_ADMIN_SCREENS } from './pages/leave-admin';
import { LIFECYCLE_DOCUMENTS_ESS_PANELS, LIFECYCLE_DOCUMENTS_SCREENS, LIFECYCLE_DOCUMENTS_TASK_QUEUES } from './pages/lifecycle-documents';
import { LIFECYCLE_PROCESSES_ESS_PANELS, LIFECYCLE_PROCESSES_SCREENS, LIFECYCLE_PROCESSES_TASK_QUEUES } from './pages/lifecycle-processes';
import { NOTIFICATION_SCREENS } from './pages/notifications';
import { ORG_ADMIN_SCREENS } from './pages/org-admin';
import { PAYROLL_ESS_PANELS, PAYROLL_SCREENS, PAYROLL_TASK_QUEUES } from './pages/payroll';
import { SALARY_SCREENS } from './pages/salary';
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
  ...APPRAISAL_SCREENS,
  ...TIMESHEET_SCREENS,
  ...ASSETS_SCREENS,
  ...TRAINING_SCREENS,
  ...PAYROLL_SCREENS,
  // FR-029 salary master: no My ESS panel and no decision queue (the upload records initial salaries without a separate approval).
  ...SALARY_SCREENS,
  ...DOCUMENTS_SCREENS,
  ...ADMIN_SCREENS,
  // FR-085 delivery log: the user's own preferences are a panel on the inbox.
  ...NOTIFICATION_SCREENS,
  // §5 user accounts and links; FR-004 reference values: no My ESS panel and no decision queue.
  ...ORG_ADMIN_SCREENS,
  // FR-003, FR-068 delegation: decision tasks show their "delegated" mark in the inbox and each module's queue.
  ...DELEGATION_SCREENS,
  ...BULK_JOBS_SCREENS,
  // FR-024, FR-025 leave administration and FR-021 attendance control: no My ESS panel and no decision queue of their own.
  ...LEAVE_ADMIN_SCREENS,
  ...ATTENDANCE_CONTROL_SCREENS,
  // FR-019 punch imports and FR-020 attendance policies: the same.
  ...ATTENDANCE_ADMIN_SCREENS,
  // FR-005 holidays, shifts and weekly-off patterns: the same.
  ...CALENDARS_SCREENS,
  // FR-078 expense policies: the same; claims and their decisions stay on the core /expenses and /tasks pages.
  ...EXPENSE_ADMIN_SCREENS,
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
  ...DOCUMENTS_ESS_PANELS,
];

/**
 * My ESS panels by H3 tab id (TN06 payslips, TN13 timesheet, TN15 loans, TN16 assets, TN17 training, TN18 appraisal), shown inside the hub when
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
  ...DOCUMENTS_TASK_QUEUES,
];
